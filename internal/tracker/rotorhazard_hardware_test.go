package tracker

import (
	"testing"

	"slaprf/internal/domain"
)

func TestSetTimingHardwareModeSimResetsBoardsAndIsolatesSystems(t *testing.T) {
	eng := NewEngine()
	if eng.TimingHardwareMode() != domain.HardwareModeSlapRF {
		t.Fatalf("expected initial mode slaprf, got %q", eng.TimingHardwareMode())
	}
	_, initialGates, _, _, _ := eng.StateSnapshot()
	if len(initialGates) == 0 {
		t.Fatalf("expected initial SlapRF sim gates")
	}

	// Switch SlapRF -> RotorHazard in sim mode
	eng.SetTimingHardwareMode(domain.HardwareModeRotorHazard, true)
	if eng.TimingHardwareMode() != domain.HardwareModeRotorHazard {
		t.Fatalf("expected rotorhazard mode, got %q", eng.TimingHardwareMode())
	}
	_, rhGates, _, _, _ := eng.StateSnapshot()
	rhTimers := eng.DetectedTimersSnapshot()
	if len(rhGates) != 1 || rhGates[0].TimerLabel != "R1" {
		t.Fatalf("expected default R1 start gate, got %+v", rhGates)
	}
	if len(rhTimers) != 2 {
		t.Fatalf("expected R1 & R2 timers, got %d", len(rhTimers))
	}

	// Connect/add a second gate bound to R2 in RotorHazard mode
	if _, err := eng.AddGate("Split", 3); err != nil {
		t.Fatalf("AddGate(RH2) failed: %v", err)
	}

	// Switch RotorHazard -> LapRF in sim mode: verify default LapRF boards L1 & L2 only
	eng.SetTimingHardwareMode(domain.HardwareModeLapRF, true)
	if eng.TimingHardwareMode() != domain.HardwareModeLapRF {
		t.Fatalf("expected laprf mode, got %q", eng.TimingHardwareMode())
	}
	// Late RotorHazard heartbeat while in LapRF mode must be ignored and never pollute detected timers
	eng.IngestExternalRHHeartbeat(2, "R1", [domain.MaxPilotSlots]float32{40, 40, 40, 40, 40, 40, 40, 40})
	_, lrfGates, _, _, _ := eng.StateSnapshot()
	lrfTimers := eng.DetectedTimersSnapshot()
	if len(lrfGates) != 1 || lrfGates[0].TimerLabel != "L1" {
		t.Fatalf("expected default L1 gate in laprf mode, got %+v", lrfGates)
	}
	for _, tm := range lrfTimers {
		if tm.FirmwareVersion != "LapRF" {
			t.Fatalf("unexpected non-LapRF timer in LapRF mode: %+v", tm)
		}
	}

	// Switch LapRF -> RotorHazard in sim mode: verify simulated boards reset back to default (1 active gate R1, R2 disconnected)
	eng.SetTimingHardwareMode(domain.HardwareModeRotorHazard, true)
	_, rhGatesReset, _, _, _ := eng.StateSnapshot()
	rhTimersReset := eng.DetectedTimersSnapshot()
	if len(rhGatesReset) != 1 || rhGatesReset[0].TimerLabel != "R1" {
		t.Fatalf("expected RotorHazard sim boards to reset to default 1-gate R1 state, got %+v", rhGatesReset)
	}
	if len(rhTimersReset) != 2 || rhTimersReset[0].TimerLabel != "R1" || rhTimersReset[1].TimerLabel != "R2" || rhTimersReset[1].Online {
		t.Fatalf("expected default R1 (online) and R2 (offline), got %+v", rhTimersReset)
	}

	// Switch RotorHazard -> SlapRF in sim mode: verify default SlapRF course & timers and ignore late RH/LapRF heartbeats
	eng.SetTimingHardwareMode(domain.HardwareModeSlapRF, true)
	eng.IngestExternalRHHeartbeat(2, "R1", [domain.MaxPilotSlots]float32{40, 40, 40, 40, 40, 40, 40, 40})
	eng.IngestExternalLapRFStatus(2, "L1", 12200, [domain.MaxPilotSlots]float32{320, 320, 320, 320, 320, 320, 320, 320})
	_, slapGatesRestored, _, _, _ := eng.StateSnapshot()
	slapTimersRestored := eng.DetectedTimersSnapshot()
	if len(slapGatesRestored) != len(initialGates) {
		t.Fatalf("expected %d SlapRF gates restored to default, got %d", len(initialGates), len(slapGatesRestored))
	}
	for _, tm := range slapTimersRestored {
		if tm.FirmwareVersion == "RotorHazard" || tm.FirmwareVersion == "LapRF" {
			t.Fatalf("unexpected non-SlapRF timer in SlapRF mode: %+v", tm)
		}
	}
}

func TestActiveRHNodeSpecsAndPerGateThresholds(t *testing.T) {
	eng := NewRealEngine()
	eng.SetTimingHardwareMode(domain.HardwareModeRotorHazard, false)
	rh1 := eng.EnsureRHTimerRegistered(2, "RH1", true)
	if rh1 != 2 {
		t.Fatalf("expected RH1 timerID 2, got %d", rh1)
	}

	specs := eng.ActiveRHNodeSpecs(2)
	if !specs[0].Enabled || specs[0].EnterAtLevel != 95 || specs[0].ExitAtLevel != 70 {
		t.Fatalf("expected default RH thresholds 95/70 on slot 0, got %+v", specs[0])
	}

	// Apply per-gate override on Gate 1 for Pilot Slot 1
	err := eng.SetGateThresholds([]domain.GateThresholdUpdate{
		{
			GateID:           1,
			SlotIndex:        1,
			RHEnterThreshold: 120,
			RHExitThreshold:  88,
		},
	})
	if err != nil {
		t.Fatalf("SetGateThresholds failed: %v", err)
	}

	specsAfter := eng.ActiveRHNodeSpecs(2)
	if specsAfter[0].EnterAtLevel != 120 || specsAfter[0].ExitAtLevel != 88 {
		t.Fatalf("expected overridden RH thresholds 120/88, got %+v", specsAfter[0])
	}
}

func TestRotorHazardMultiGateLapAndHeatScoring(t *testing.T) {
	eng := NewRealEngine()
	eng.SetTimingHardwareMode(domain.HardwareModeRotorHazard, false)
	eng.EnsureRHTimerRegistered(2, "RH1", true)
	eng.EnsureRHTimerRegistered(3, "RH2", false)
	if _, err := eng.AddGate("Back Split", 3); err != nil {
		t.Fatalf("AddGate(RH2) failed: %v", err)
	}

	// Stream a heartbeat on RH1 & RH2
	var rssi [domain.MaxPilotSlots]float32
	for i := range rssi {
		rssi[i] = 26
	}
	rssi[0] = 64
	eng.IngestExternalRHHeartbeat(2, "RH1", rssi)
	eng.IngestExternalRHHeartbeat(3, "RH2", rssi)

	_, gates, _, _, _ := eng.StateSnapshot()
	if len(gates) != 2 || gates[0].LastRSSI[0] != 64 {
		t.Fatalf("expected Gate 1 LastRSSI[0]==64, got %+v", gates)
	}

	// Start a quick Qualifying race so we also verify RaceHeat.HardwareMode + 0..255 RssiTrace
	cfg := domain.DefaultRaceSetupConfig()
	cfg.EventName = "RH Qualifier"
	cfg.Structure = domain.StructureSingleStage
	cfg.MainFormat = domain.FormatQualifying
	cfg.QualifyingRounds = 1
	eng.SetOperatingMode(domain.ModeRace)
	eng.ConfigureAndGenerateRaceForID("", cfg, true, false)

	rsBefore := eng.RaceSnapshot()
	if len(rsBefore.Heats) == 0 {
		t.Fatalf("expected generated heat")
	}
	heatID := rsBefore.Heats[0].ID
	if _, err := eng.RaceControlActionWithOptions("", "start", heatID, false); err != nil {
		t.Fatalf("start heat failed: %v", err)
	}
	// Advance virtual clock past countdown so heat is ACTIVE and armed
	eng.AdvanceVirtualClockUs(10_000_000)
	eng.TickRaceClock()

	rsActive := eng.RaceSnapshot()
	slotIdx := rsActive.Heats[0].Seats[0].PilotSlotIndex
	hwSlot := int(rsActive.Heats[0].Seats[0].Channel)
	if hwSlot < 1 {
		hwSlot = 1
	}

	baseUs := eng.NowUs()
	eng.IngestExternalRHHeartbeat(2, "RH1", [domain.MaxPilotSlots]float32{32, 32, 32, 32, 32, 32, 32, 32})
	// Start holeshot on RH1 (Gate 1), split on RH2 (Gate 2), finish Lap 1 on RH1 (Gate 1)
	eng.InjectExternalRHCrossing(2, hwSlot, baseUs+1_000_000, 198, 1)
	eng.InjectExternalRHCrossing(3, hwSlot, baseUs+6_500_000, 185, 1)
	eng.InjectExternalRHCrossing(2, hwSlot, baseUs+12_500_000, 204, 2)

	_, _, laps, _, _ := eng.StateSnapshot()
	if len(laps) != 1 || laps[0].SlotIndex != slotIdx {
		t.Fatalf("expected 1 completed multi-gate RH lap for slot %d, got %+v", slotIdx, laps)
	}
	if len(laps[0].Sectors) != 2 {
		t.Fatalf("expected 2 sector splits (RH1->RH2->RH1), got %+v", laps[0].Sectors)
	}

	rs := eng.RaceSnapshot()
	heat := rs.Heats[0]
	if heat.HardwareMode != domain.HardwareModeRotorHazard {
		t.Fatalf("expected heat.HardwareMode == rotorhazard, got %q", heat.HardwareMode)
	}
	seat := heat.Seats[0]
	if seat.EnterRssiDbm != 95 || seat.ExitRssiDbm != 70 {
		t.Fatalf("expected seat Enter/Exit 95/70, got %.1f/%.1f", seat.EnterRssiDbm, seat.ExitRssiDbm)
	}
	if len(seat.RssiTrace) == 0 {
		t.Fatalf("expected 0..255 RssiTrace samples recorded on RH heat seat")
	}
	sample := seat.RssiTrace[len(seat.RssiTrace)-1]
	if sample.Dbm != 204 {
		t.Fatalf("unexpected RH RssiTrace sample: %+v", sample)
	}
}

func TestRotorHazardUSBModeScoringAndStateIsolation(t *testing.T) {
	eng := NewEngine()
	if got := eng.SetTimingHardwareMode(domain.HardwareModeRotorHazardUSB, true); got != domain.HardwareModeRotorHazardUSB {
		t.Fatalf("expected HardwareModeRotorHazardUSB, got %q", got)
	}
	if !domain.IsRotorHazardMode(eng.TimingHardwareMode()) {
		t.Fatalf("expected IsRotorHazardMode true for %q", eng.TimingHardwareMode())
	}

	// Verify 0..255 thresholds work in rotorhazard_usb mode
	if err := eng.SetGateThresholds([]domain.GateThresholdUpdate{{
		GateID:           1,
		SlotIndex:        1,
		RHEnterThreshold: 112,
		RHExitThreshold:  88,
	}}); err != nil {
		t.Fatalf("SetGateThresholds in rotorhazard_usb failed: %v", err)
	}
	specs := eng.ActiveRHNodeSpecs(2)
	if specs[0].EnterAtLevel != 112 || specs[0].ExitAtLevel != 88 {
		t.Fatalf("expected ActiveRHNodeSpecs[0] 112/88, got %+v", specs[0])
	}

	// Verify crossings score in rotorhazard_usb mode
	baseUs := eng.NowUs()
	eng.IngestExternalRHHeartbeat(2, "R1", [domain.MaxPilotSlots]float32{30, 30, 30, 30, 30, 30, 30, 30})
	eng.InjectExternalRHCrossing(2, 1, baseUs+1_000_000, 195, 1)
	eng.InjectExternalRHCrossing(2, 1, baseUs+9_000_000, 210, 2)
	_, _, laps, _, _ := eng.StateSnapshot()
	if len(laps) != 1 {
		t.Fatalf("expected 1 lap in rotorhazard_usb mode, got %d", len(laps))
	}

	// Verify real-mode saved state isolation between rotorhazard (network) and rotorhazard_usb
	realEng := NewRealEngine()
	realEng.SetTimingHardwareMode(domain.HardwareModeRotorHazard, false)
	realEng.EnsureRHTimerRegistered(2, "R1-NET", true)
	realEng.SetTimingHardwareMode(domain.HardwareModeRotorHazardUSB, false)
	if len(realEng.DetectedTimersSnapshot()) != 0 {
		t.Fatalf("expected clean timer list on first switch to real rotorhazard_usb, got %+v", realEng.DetectedTimersSnapshot())
	}
	realEng.EnsureRHTimerRegistered(3, "R1-USB", true)
	realEng.SetTimingHardwareMode(domain.HardwareModeRotorHazard, false)
	netTimers := realEng.DetectedTimersSnapshot()
	if len(netTimers) != 1 || netTimers[0].TimerID != 2 {
		t.Fatalf("expected network R1 timer 2 restored, got %+v", netTimers)
	}
	realEng.SetTimingHardwareMode(domain.HardwareModeRotorHazardUSB, false)
	usbTimers := realEng.DetectedTimersSnapshot()
	if len(usbTimers) != 1 || usbTimers[0].TimerID != 3 {
		t.Fatalf("expected USB R1 timer 3 restored, got %+v", usbTimers)
	}
}

func TestLapRFUSBModeSimAndStateIsolation(t *testing.T) {
	eng := NewEngine()
	eng.SetTimingHardwareMode(domain.HardwareModeLapRFUSB, true)
	if eng.TimingHardwareMode() != domain.HardwareModeLapRFUSB {
		t.Fatalf("expected laprf_usb mode, got %q", eng.TimingHardwareMode())
	}
	_, gates, _, _, _ := eng.StateSnapshot()
	if len(gates) != 1 || gates[0].TimerLabel != "L1" {
		t.Fatalf("expected default L1 gate in laprf_usb sim mode, got %+v", gates)
	}

	// Verify crossings score in laprf_usb mode
	baseUs := eng.NowUs()
	eng.IngestExternalLapRFStatus(2, "L1", 12100, [domain.MaxPilotSlots]float32{340, 340, 340, 340, 340, 340, 340, 340})
	eng.InjectExternalLapRFCrossing(2, 1, baseUs+1_000_000, 1950, 1)
	eng.InjectExternalLapRFCrossing(2, 1, baseUs+9_000_000, 2100, 2)
	_, _, laps, _, _ := eng.StateSnapshot()
	if len(laps) != 1 {
		t.Fatalf("expected 1 lap in laprf_usb mode, got %d", len(laps))
	}

	// Verify real-mode saved state + persistence isolation between laprf (network) and laprf_usb
	realEng := NewRealEngine()
	realEng.SetTimingHardwareMode(domain.HardwareModeLapRF, false)
	realEng.EnsureLapRFTimerRegistered(2, "L1-NET", 12200, true)
	realEng.SetTimingHardwareMode(domain.HardwareModeLapRFUSB, false)
	if len(realEng.DetectedTimersSnapshot()) != 0 {
		t.Fatalf("expected clean timer list on first switch to real laprf_usb, got %+v", realEng.DetectedTimersSnapshot())
	}
	realEng.EnsureLapRFTimerRegistered(3, "L1-USB", 12100, true)

	snap := realEng.ExportState()
	restored := NewRealEngine()
	restored.RestoreState(snap, false)
	if restored.TimingHardwareMode() != domain.HardwareModeLapRFUSB {
		t.Fatalf("expected restored mode laprf_usb, got %q", restored.TimingHardwareMode())
	}
	usbTimers := restored.DetectedTimersSnapshot()
	if len(usbTimers) != 1 || usbTimers[0].TimerID != 3 {
		t.Fatalf("expected USB L1 timer 3 restored, got %+v", usbTimers)
	}
	restored.SetTimingHardwareMode(domain.HardwareModeLapRF, false)
	netTimers := restored.DetectedTimersSnapshot()
	if len(netTimers) != 1 || netTimers[0].TimerID != 2 {
		t.Fatalf("expected network L1 timer 2 restored, got %+v", netTimers)
	}
}
