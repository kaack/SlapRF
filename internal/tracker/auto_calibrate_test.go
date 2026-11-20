package tracker

import (
	"math"
	"testing"

	"slaprf/internal/domain"
)

// feedSyntheticWave feeds 50 Hz RSSI frames for slot 0 on `timerID` from `startUs` for `durUs`.
func feedSyntheticWave(e *Engine, timerID uint8, startUs, durUs uint64, fn func(tsUs uint64) float32) uint64 {
	const stepUs = 20_000 // 50 Hz
	var rssi [domain.MaxPilotPoolSize]float32
	for i := range rssi {
		rssi[i] = -92
	}
	t := startUs
	end := startUs + durUs
	for ; t < end; t += stepUs {
		rssi[0] = fn(t)
		e.IngestTelemetryFrame(domain.TimerTelemetryFrame{
			TimerID:       timerID,
			TimestampUs:   t,
			RSSI:          rssi,
			BatteryMv:     4100,
			NoiseFloorDbm: -92,
		})
	}
	return t
}

// gaussianPass returns a realistic bell-curve gate pass over `floorDbm` with given centers & peak.
func gaussianPass(tsUs uint64, floorDbm, peakDbm float32, centersSec []float64, sigmaSec float64) float32 {
	tSec := float64(tsUs) / 1e6
	best := float64(floorDbm)
	amp := float64(peakDbm - floorDbm)
	for _, c := range centersSec {
		d := (tSec - c) / sigmaSec
		val := float64(floorDbm) + amp*math.Exp(-0.5*d*d)
		if val > best {
			best = val
		}
	}
	return float32(best)
}

func TestAutoCalibrateWeakVTXLocksInAndDetectsLaps(t *testing.T) {
	// Single-gate real track where Pilot 1 (default Enter = -58 dBm) flies a 25 mW VTX whose passes
	// peak at -68 dBm over a -90 dBm noise floor — previously invisible until manually calibrated!
	e := NewRealEngine()
	timerID, err := e.ProvisionGate(ProvisionRequest{Role: "spoke", Label: "T1", Fingerprint: "AABBCC01"})
	if err != nil {
		t.Fatalf("ProvisionGate: %v", err)
	}
	if _, err := e.AddGate("Start", timerID, 0); err != nil {
		t.Fatalf("AddGate: %v", err)
	}

	// Passes at t = 2s, 10s, 18s, 26s (8 s laps), peaking at -67 dBm (< default -58 dBm!).
	passes := []float64{2.0, 10.0, 18.0, 26.0}
	feedSyntheticWave(e, timerID, 1_000_000, 29_000_000, func(tsUs uint64) float32 {
		return gaussianPass(tsUs, -90, -67, passes, 0.32)
	})

	_, gates, laps, _, _ := e.StateSnapshot()
	if len(gates) != 1 {
		t.Fatalf("gates = %d, want 1", len(gates))
	}
	calEnter := gates[0].EnterThresholds[0]
	calExit := gates[0].ExitThresholds[0]
	if calEnter == 0 || calEnter >= -68 || calEnter <= -85 {
		t.Fatalf("expected auto-calibrated enter between -84 and -69 dBm, got %v (exit %v)", calEnter, calExit)
	}
	if calExit >= calEnter-4 || calExit <= -90 {
		t.Fatalf("expected auto-calibrated exit below enter with hysteresis, got enter=%v exit=%v", calEnter, calExit)
	}
	// After Pass 1 (2s) + Pass 2 (10s) trigger initial auto-calibration, Pass 3 (18s) starts a lap
	// and Pass 4 (26s) completes an ~8.0 s lap automatically without any manual UI intervention!
	if len(laps) < 1 {
		t.Fatalf("expected >= 1 completed lap after auto-calibration, got 0")
	}
}

func TestAutoCalibrateAdaptsEvery30SecondsAndRespectsManualPin(t *testing.T) {
	e := NewRealEngine()
	timerID, err := e.ProvisionGate(ProvisionRequest{Role: "spoke", Label: "T1", Fingerprint: "AABBCC01"})
	if err != nil {
		t.Fatalf("ProvisionGate: %v", err)
	}
	if _, err := e.AddGate("Start", timerID, 0); err != nil {
		t.Fatalf("AddGate: %v", err)
	}

	// 1. Initial flight (0..15 s) with weak -68 dBm peaks -> locks in around -77 dBm.
	curUs := feedSyntheticWave(e, timerID, 1_000_000, 14_000_000, func(tsUs uint64) float32 {
		return gaussianPass(tsUs, -90, -68, []float64{3.0, 10.0}, 0.30)
	})
	_, gates1, _, _, _ := e.StateSnapshot()
	initialEnter := gates1[0].EnterThresholds[0]
	if initialEnter == 0 {
		t.Fatalf("expected initial auto-calibration to lock in")
	}

	// 2. Pilot switches VTX up to 200 mW (-36 dBm peaks) and flies for > 95 s so old weak peaks age
	// out of the 90 s window and periodic 30 s re-calibration adapts upward.
	var strongCenters []float64
	for s := 20.0; s <= 115.0; s += 8.0 {
		strongCenters = append(strongCenters, s)
	}
	curUs = feedSyntheticWave(e, timerID, curUs, 105_000_000, func(tsUs uint64) float32 {
		return gaussianPass(tsUs, -90, -36, strongCenters, 0.30)
	})
	_, gates2, _, _, _ := e.StateSnapshot()
	adaptedEnter := gates2[0].EnterThresholds[0]
	if adaptedEnter < initialEnter+8 {
		t.Fatalf("expected 30s periodic auto-calibration to raise enter well above %v, got %v", initialEnter, adaptedEnter)
	}

	// 3. Manual drag (`Auto: false`) pins the user's threshold so 30 s auto-calibration won't overwrite it.
	gateID := gates2[0].GateID
	if err := e.SetGateThresholds([]domain.GateThresholdUpdate{{
		GateID:    gateID,
		SlotIndex: 1,
		EnterDbm:  -48,
		ExitDbm:   -58,
		Auto:      false,
	}}); err != nil {
		t.Fatalf("SetGateThresholds manual: %v", err)
	}
	var moreCenters []float64
	for s := 125.0; s <= 165.0; s += 8.0 {
		moreCenters = append(moreCenters, s)
	}
	curUs = feedSyntheticWave(e, timerID, curUs, 45_000_000, func(tsUs uint64) float32 {
		return gaussianPass(tsUs, -90, -68, moreCenters, 0.30)
	})
	_, gates3, _, _, _ := e.StateSnapshot()
	if gates3[0].EnterThresholds[0] != -48 {
		t.Fatalf("manual pin should preserve -48 dBm, got %v", gates3[0].EnterThresholds[0])
	}

	// 4. Resetting (`EnterDbm: 0`) clears the manual pin so auto-calibration resumes.
	if err := e.SetGateThresholds([]domain.GateThresholdUpdate{{
		GateID:    gateID,
		SlotIndex: 1,
		EnterDbm:  0,
	}}); err != nil {
		t.Fatalf("SetGateThresholds reset: %v", err)
	}
	_ = feedSyntheticWave(e, timerID, curUs, 20_000_000, func(tsUs uint64) float32 {
		return gaussianPass(tsUs, -90, -68, []float64{170.0, 178.0}, 0.30)
	})
	_, gates4, _, _, _ := e.StateSnapshot()
	if gates4[0].EnterThresholds[0] == 0 {
		t.Fatalf("expected auto-calibration to resume after Reset")
	}
}

func TestAutoCalibrateRejectsNonLapSignals(t *testing.T) {
	// 1. Parked bench VTX: two 12-second plateaus (FWHM > 6.5 s) should NOT count as lap fly-bys.
	var bench []autoCalibSample
	for ms := uint64(0); ms <= 45_000; ms += 50 {
		sec := float64(ms) / 1000.0
		dbm := float32(-90)
		if (sec >= 3 && sec <= 15) || (sec >= 25 && sec <= 37) {
			dbm = -45
		}
		bench = append(bench, autoCalibSample{tsUs: ms * 1000, dbm: dbm})
	}
	if _, _, _, ok := suggestAutoThresholdDbm(bench, 45_000_000); ok {
		t.Fatalf("expected long bench VTX plateaus to be rejected")
	}

	// 2. Single-bucket (< 80 ms) impulse glitches should NOT count as lap fly-bys.
	var spikes []autoCalibSample
	for ms := uint64(0); ms <= 20_000; ms += 50 {
		dbm := float32(-90)
		if ms == 4000 || ms == 12000 {
			dbm = -50
		}
		spikes = append(spikes, autoCalibSample{tsUs: ms * 1000, dbm: dbm})
	}
	if _, _, _, ok := suggestAutoThresholdDbm(spikes, 20_000_000); ok {
		t.Fatalf("expected single-sample glitches to be rejected")
	}
}

func TestAutoCalibrateIndoorHighValleyWithPowerOffTail(t *testing.T) {
	// Reproduces indoor / small-course flying where VTX-off dead air (-91 dBm) occupies >25% of the
	// 90 s window, while active lap valleys sit at -75 dBm and peaks sit at -53..-57 dBm.
	// Auto-calibration must anchor exitDbm above the -75 dBm inter-pass valleys (never dragging
	// exitDbm down to -77 dBm where the detector can never exit the gate).
	var samples []autoCalibSample
	passCenters := []float64{25, 32, 39, 46, 53, 60, 67}
	for ms := uint64(0); ms <= 87_000; ms += 50 {
		sec := float64(ms) / 1000.0
		var dbm float32
		if sec < 20.0 || sec > 72.0 {
			dbm = -91.0 // VTX powered off before/after pack (~40% of window!)
		} else {
			dbm = gaussianPass(ms*1000, -75.5, -54.5, passCenters, 0.95)
		}
		samples = append(samples, autoCalibSample{tsUs: ms * 1000, dbm: dbm})
	}

	enter, exit, _, ok := suggestAutoThresholdDbm(samples, 75_000_000)
	if !ok {
		t.Fatalf("expected suggestAutoThresholdDbm to succeed on 7 indoor passes")
	}
	if exit < -73 {
		t.Fatalf("expected exitDbm >= -73 dBm (above -75.5 dBm inter-pass valleys despite -91 dBm power-off tail), got enter=%v exit=%v", enter, exit)
	}
	if enter > -58 || enter <= exit+4 {
		t.Fatalf("expected enterDbm <= -58 dBm with >= 5 dB hysteresis above exitDbm, got enter=%v exit=%v", enter, exit)
	}
}

func TestAutoCalibratePackSwapWeakerSecondPackRecoversAutomatically(t *testing.T) {
	// Reproduces real Bluetooth Hub flight telemetry:
	// 1. Pack 1 (0..50 s): 7 laps peaking at -45 dBm over -72 dBm valleys -> calibrates Enter ~ -54 dBm.
	// 2. Landing & battery swap (50..195 s = 145 s unplugged): receiver reads -92 dBm noise floor.
	// 3. Pack 2 (195..258 s): takeoff pass at 196.5 s barely clears Pack 1's threshold (-53.5 dBm),
	//    and subsequent 9 laps every 6.0 s peak at -59..-63 dBm over -74 dBm indoor valleys (2.0 s FWHM).
	// Without manual Auto-calibrate, the engine must automatically re-lock thresholds and score Pack 2 laps!
	e := NewRealEngine()
	timerID, err := e.ProvisionGate(ProvisionRequest{Role: "spoke", Label: "H1", Fingerprint: "BE7C0001"})
	if err != nil {
		t.Fatalf("ProvisionGate: %v", err)
	}
	if _, err := e.AddGate("Start", timerID, 0); err != nil {
		t.Fatalf("AddGate: %v", err)
	}

	var pack1Centers []float64
	for s := 4.0; s <= 46.0; s += 6.5 {
		pack1Centers = append(pack1Centers, s)
	}
	curUs := feedSyntheticWave(e, timerID, 1_000_000, 49_000_000, func(tsUs uint64) float32 {
		return gaussianPass(tsUs, -72.0, -45.0, pack1Centers, 0.70)
	})
	_, gatesPack1, lapsPack1, _, _ := e.StateSnapshot()
	pack1Enter := gatesPack1[0].EnterThresholds[0]
	if pack1Enter == 0 || pack1Enter < -58 {
		t.Fatalf("expected Pack 1 enter calibrated >= -58 dBm, got %v", pack1Enter)
	}
	if len(lapsPack1) < 5 {
		t.Fatalf("expected >= 5 laps in Pack 1, got %d", len(lapsPack1))
	}

	// 145 seconds unplugged on the ground (-92 dBm).
	curUs = feedSyntheticWave(e, timerID, curUs, 145_000_000, func(_ uint64) float32 {
		return -92.0
	})

	// Pack 2: Pass #1 at 197.0 s hits -53.2 dBm (triggers startedLap against Pack 1 threshold),
	// then 9 passes at 203, 209, 215, 221, 227, 233, 239, 245, 251 s peak at -60.5 dBm over -74 dBm!
	var pack2WeakCenters []float64
	for s := 203.0; s <= 251.0; s += 6.0 {
		pack2WeakCenters = append(pack2WeakCenters, s)
	}
	_ = feedSyntheticWave(e, timerID, curUs, 62_000_000, func(tsUs uint64) float32 {
		vTakeoff := gaussianPass(tsUs, -74.0, -53.2, []float64{197.0}, 0.85)
		vLaps := gaussianPass(tsUs, -74.0, -60.5, pack2WeakCenters, 0.85)
		if vTakeoff > vLaps {
			return vTakeoff
		}
		return vLaps
	})

	_, gatesPack2, lapsAll, _, _ := e.StateSnapshot()
	pack2Enter := gatesPack2[0].EnterThresholds[0]
	pack2Exit := gatesPack2[0].ExitThresholds[0]
	if pack2Enter >= -62 || pack2Enter <= -72 {
		t.Fatalf("expected Pack 2 enter auto-lowered into [-71, -63] dBm, got enter=%v exit=%v (Pack 1 was %v)", pack2Enter, pack2Exit, pack1Enter)
	}
	if pack2Exit < -73 {
		t.Fatalf("expected Pack 2 exit above -74 dBm indoor valleys (>= -73 dBm), got %v", pack2Exit)
	}
	pack2Laps := len(lapsAll) - len(lapsPack1)
	if pack2Laps < 7 {
		t.Fatalf("expected >= 7 automatically scored laps in Pack 2, got %d (total=%d, pack1=%d)", pack2Laps, len(lapsAll), len(lapsPack1))
	}
}

func TestAutoCalibrateMidFlightSignalDropAdaptsWithoutPowerOff(t *testing.T) {
	// Pilot flies strong passes (-44 dBm) for 40 s, then VTX thermal-throttles / wider line drops
	// peaks to -60 dBm over -74 dBm indoor valleys without ever powering off.
	e := NewRealEngine()
	timerID, err := e.ProvisionGate(ProvisionRequest{Role: "spoke", Label: "H1", Fingerprint: "BE7C0002"})
	if err != nil {
		t.Fatalf("ProvisionGate: %v", err)
	}
	if _, err := e.AddGate("Start", timerID, 0); err != nil {
		t.Fatalf("AddGate: %v", err)
	}

	var strongCenters []float64
	for s := 4.0; s <= 40.0; s += 6.0 {
		strongCenters = append(strongCenters, s)
	}
	curUs := feedSyntheticWave(e, timerID, 1_000_000, 43_000_000, func(tsUs uint64) float32 {
		return gaussianPass(tsUs, -74.0, -44.0, strongCenters, 0.75)
	})
	_, _, lapsBefore, _, _ := e.StateSnapshot()

	var weakCenters []float64
	for s := 47.0; s <= 95.0; s += 6.0 {
		weakCenters = append(weakCenters, s)
	}
	_ = feedSyntheticWave(e, timerID, curUs, 54_000_000, func(tsUs uint64) float32 {
		return gaussianPass(tsUs, -74.0, -60.0, weakCenters, 0.85)
	})
	_, gatesAfter, lapsAfter, _, _ := e.StateSnapshot()
	if gatesAfter[0].EnterThresholds[0] >= -61 {
		t.Fatalf("expected mid-flight auto-calibration to lower enter below -61 dBm, got %v", gatesAfter[0].EnterThresholds[0])
	}
	if len(lapsAfter)-len(lapsBefore) < 5 {
		t.Fatalf("expected >= 5 laps scored after mid-flight signal drop, got %d", len(lapsAfter)-len(lapsBefore))
	}
}

func TestAutoCalibratePracticePauseResumePackSwap(t *testing.T) {
	// Pilot pauses practice (`SetRaceArmed(false)`), swaps battery (+90 s timestamp jump), resumes,
	// and immediately flies weaker passes (-62 dBm over -74 dBm valleys).
	e := NewRealEngine()
	timerID, err := e.ProvisionGate(ProvisionRequest{Role: "spoke", Label: "H1", Fingerprint: "BE7C0003"})
	if err != nil {
		t.Fatalf("ProvisionGate: %v", err)
	}
	if _, err := e.AddGate("Start", timerID, 0); err != nil {
		t.Fatalf("AddGate: %v", err)
	}

	curUs := feedSyntheticWave(e, timerID, 1_000_000, 28_000_000, func(tsUs uint64) float32 {
		return gaussianPass(tsUs, -74.0, -43.0, []float64{4.0, 10.5, 17.0, 23.5}, 0.75)
	})
	_, _, lapsBefore, _, _ := e.StateSnapshot()

	e.SetRaceArmed(false)
	curUs += 90_000_000 // 90 s paused battery swap
	e.SetRaceArmed(true)

	var resumedCenters []float64
	for s := 122.0; s <= 158.0; s += 6.0 {
		resumedCenters = append(resumedCenters, s)
	}
	_ = feedSyntheticWave(e, timerID, curUs, 42_000_000, func(tsUs uint64) float32 {
		return gaussianPass(tsUs, -74.0, -62.0, resumedCenters, 0.85)
	})
	_, gatesAfter, lapsAfter, _, _ := e.StateSnapshot()
	if gatesAfter[0].EnterThresholds[0] >= -63 {
		t.Fatalf("expected post-resume single-pass/fast recovery below -63 dBm, got %v", gatesAfter[0].EnterThresholds[0])
	}
	if len(lapsAfter)-len(lapsBefore) < 4 {
		t.Fatalf("expected >= 4 laps scored after resuming practice with weaker pack, got %d", len(lapsAfter)-len(lapsBefore))
	}
}

func TestEmptyChannelsReject5GHzWiFiSpikesAndHealStaleNoiseThresholds(t *testing.T) {
	// Reproduces indoor 8-channel Bluetooth Hub setup:
	// - Slot 1 (Pilot 1, 5769 MHz UNII-3 Wi-Fi) and Slot 3 (Pilot 3, 5806 MHz UNII-3 Wi-Fi) are
	//   unoccupied on -92 dBm floor, pre-corrupted with stale -86 / -84 dBm thresholds, and hit by
	//   repeated sharp 2-sample (40 ms) Wi-Fi bursts up to -65 .. -73 dBm (plus an explicit -50 dBm
	//   sharp 40 ms burst that exceeds -58 dBm default).
	// - Slot 6 (OneEye, 5917 MHz) flies genuine indoor passes (-55 dBm over -74 dBm, sigma = 0.80 s).
	// Pilot 1 and Pilot 3 must heal to default thresholds, never auto-calibrate onto Wi-Fi blips,
	// and produce ZERO accepted crossings or laps, while OneEye scores laps cleanly!
	e := NewRealEngine()
	timerID, err := e.ProvisionGate(ProvisionRequest{Role: "spoke", Label: "H1", Fingerprint: "BE7C0009"})
	if err != nil {
		t.Fatalf("ProvisionGate: %v", err)
	}
	gate, err := e.AddGate("Start", timerID, 0)
	if err != nil {
		t.Fatalf("AddGate: %v", err)
	}

	// Enable 6 pilots including Pilot 1 (idx 0), Pilot 3 (idx 2), and Pilot 6 (idx 5, 5917 MHz).
	pilotsSnap, _, _, _, _ := e.StateSnapshot()
	for i := 0; i < 6 && i < len(pilotsSnap); i++ {
		p := pilotsSnap[i]
		p.Enabled = true
		p.Channel = uint8(i + 1)
		freqs := []uint16{5769, 5732, 5806, 5695, 5658, 5917}
		p.FrequencyMHz = freqs[i]
		if i == 5 {
			p.Callsign = "OneEye"
		}
		if err := e.UpdatePilotSlot(p); err != nil {
			t.Fatalf("UpdatePilotSlot(%d): %v", i, err)
		}
	}

	// Seed stale corrupted auto-calibrated thresholds (-86 / -84 dBm) on Pilot 1 and Pilot 3.
	e.mu.Lock()
	e.gates[0].EnterThresholds[0] = -86
	e.gates[0].ExitThresholds[0] = -91
	e.gates[0].EnterThresholds[2] = -84
	e.gates[0].ExitThresholds[2] = -89
	e.mu.Unlock()
	_ = gate

	const stepUs = 20_000
	var realCenters []float64
	for s := 5.0; s <= 47.0; s += 7.0 {
		realCenters = append(realCenters, s)
	}
	wifiSpikeTimesSec := []float64{3.0, 9.5, 16.2, 23.8, 31.0, 39.4, 46.0}

	for ts := uint64(1_000_000); ts <= 52_000_000; ts += stepUs {
		sec := float64(ts) / 1e6
		var rssi [domain.MaxPilotPoolSize]float32
		for k := range rssi {
			rssi[k] = -92.5
		}
		// Sharp 40 ms (2-sample) 5 GHz Wi-Fi bursts on Pilot 1 (-72 dBm, plus one -50 dBm spike at 23.8s)
		// and Pilot 3 (-66 dBm).
		for _, sp := range wifiSpikeTimesSec {
			if sp == 23.8 && sec >= sp && sec < sp+0.060 {
				rssi[0] = -48.0
			} else if sec >= sp && sec < sp+0.040 {
				rssi[0] = -72.0
				rssi[2] = -66.0
			}
		}
		// Genuine drone passes on OneEye (idx 5).
		rssi[5] = gaussianPass(ts, -74.0, -55.0, realCenters, 0.80)

		e.IngestTelemetryFrame(domain.TimerTelemetryFrame{
			TimerID:       timerID,
			TimestampUs:   ts,
			RSSI:          rssi,
			BatteryMv:     4100,
			NoiseFloorDbm: -92.5,
		})
	}

	pilotsOut, gatesOut, lapsOut, crossingsOut, _ := e.StateSnapshot()
	filteredOut := e.FilteredSnapshot()
	if gatesOut[0].EnterThresholds[0] != 0 || gatesOut[0].EnterThresholds[2] != 0 {
		t.Fatalf("expected stale noise thresholds healed to 0 and Wi-Fi spikes ignored, got p1=%v p3=%v",
			gatesOut[0].EnterThresholds[0], gatesOut[0].EnterThresholds[2])
	}
	p1Slot := pilotsOut[0].SlotIndex
	p3Slot := pilotsOut[2].SlotIndex
	oneEyeSlot := pilotsOut[5].SlotIndex

	for _, c := range crossingsOut {
		if c.SlotIndex == p1Slot || c.SlotIndex == p3Slot {
			t.Fatalf("expected ZERO false crossings on empty Wi-Fi channels, got %+v", c)
		}
	}
	var oneEyeLaps int
	for _, l := range lapsOut {
		if l.SlotIndex == oneEyeSlot {
			oneEyeLaps++
		} else {
			t.Fatalf("expected ZERO false laps on empty Wi-Fi channels, got %+v", l)
		}
	}
	if oneEyeLaps < 5 {
		t.Fatalf("expected >= 5 real laps on OneEye, got %d", oneEyeLaps)
	}
	var spikeFiltered int
	for _, f := range filteredOut {
		if f.Reason == domain.FilterSpike {
			spikeFiltered++
		}
	}
	if spikeFiltered == 0 {
		t.Fatalf("expected the -50 dBm 40 ms sharp burst on Pilot 1 to be caught as FilterSpike")
	}
}

func TestSustainedWifiStepBurstAndRepeatedHubHelloProduceZeroFalseLapsOrBroadcastSpam(t *testing.T) {
	e := NewRealEngine()
	e.SetTimingHardwareMode(domain.HardwareModeSlapRFBLE, false)
	hubID, err := e.RegisterTimerHello("BE7C0001", true, "H1")
	if err != nil || hubID != 1 {
		t.Fatalf("RegisterTimerHello: id=%d err=%v", hubID, err)
	}
	if err := e.UpdatePilotSlot(domain.PilotSlot{SlotIndex: 1, Callsign: "Pilot 1", Band: domain.BandRaceband, Channel: 4, Enabled: true}); err != nil {
		t.Fatalf("UpdatePilotSlot: %v", err)
	}
	// Seed a stale Wi-Fi threshold (-81/-86 dBm) on Pilot 1 to verify immediate auto-healing to 0.
	e.mu.Lock()
	e.gates[0].EnterThresholds[0] = -81
	e.gates[0].ExitThresholds[0] = -86
	e.mu.Unlock()

	configUpdates := 0
	practiceUpdates := 0
	e.Subscribe(&countingSubscriber{
		onConfig:   func() { configUpdates++ },
		onPractice: func() { practiceUpdates++ },
	})

	// Simulate 30 seconds of 50 Hz telemetry on Pilot 1 (5769 MHz UNII-3 Ch 153) with NO VTX on (-92.8 dBm),
	// punctuated by both 60 ms -57 dBm Wi-Fi bursts AND a 1.0 s rectangular -60.8 dBm Wi-Fi download TXOP,
	// plus 1 Hz RegisterTimerHello("BE7C0001", true, "H1") status heartbeats.
	const stepUs = 20_000
	for ts := uint64(1_000_000); ts <= 31_000_000; ts += stepUs {
		if ts%1_000_000 == 0 {
			_, _ = e.RegisterTimerHello("BE7C0001", true, "H1")
		}
		sec := float64(ts) / 1e6
		v := float32(-92.8)
		// 60 ms sharp Wi-Fi packet bursts every 5.2 s
		for _, bt := range []float64{5.0, 10.3, 21.5, 27.0} {
			if sec >= bt && sec <= bt+0.06 {
				v = -57.0
			}
		}
		// 1.0 s rectangular Wi-Fi download TXOP at t = 15.0..16.0 s (-92.8 -> -60.8 -> -92.8 dBm)
		if sec >= 15.0 && sec <= 16.0 {
			v = -60.8
		}
		var rssi [domain.MaxPilotPoolSize]float32
		for k := range rssi {
			rssi[k] = -93.0
		}
		rssi[0] = v
		e.IngestTelemetryFrame(domain.TimerTelemetryFrame{
			TimerID:       hubID,
			TimestampUs:   ts,
			RSSI:          rssi,
			BatteryMv:     4100,
			NoiseFloorDbm: -92.5,
		})
	}

	_, gatesOut, lapsOut, crossingsOut, _ := e.StateSnapshot()
	if gatesOut[0].EnterThresholds[0] != 0 {
		t.Fatalf("expected stale -71 dBm Pilot 1 threshold healed to 0 and Wi-Fi TXOP ignored, got %v", gatesOut[0].EnterThresholds[0])
	}
	if len(crossingsOut) != 0 || len(lapsOut) != 0 {
		t.Fatalf("expected 0 false crossings/laps from 60 ms + 1.0 s Wi-Fi bursts, got crossings=%d laps=%d", len(crossingsOut), len(lapsOut))
	}
	// Only the 1 initial stale-threshold heal should emit config/practice updates; the 30 1-Hz RegisterTimerHello calls must emit 0!
	if configUpdates > 1 || practiceUpdates > 1 {
		t.Fatalf("expected <= 1 config/practice broadcast across 30 1-Hz Hub status heartbeats, got config=%d practice=%d", configUpdates, practiceUpdates)
	}
}

type countingSubscriber struct {
	onConfig   func()
	onPractice func()
}

func (c *countingSubscriber) OnTelemetryFrame(domain.TimerTelemetryFrame)              {}
func (c *countingSubscriber) OnGateCrossing(domain.GateCrossingEvent)                  {}
func (c *countingSubscriber) OnDetectionFiltered(domain.FilteredDetection)             {}
func (c *countingSubscriber) OnLapCompleted(domain.LapRecord, []domain.PilotTrackSummary) {}
func (c *countingSubscriber) OnConfigUpdated([]domain.PilotSlot, []domain.TrackGate) {
	if c.onConfig != nil {
		c.onConfig()
	}
}
func (c *countingSubscriber) OnPracticeUpdated(domain.PracticeManagerState) {
	if c.onPractice != nil {
		c.onPractice()
	}
}
