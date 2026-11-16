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
