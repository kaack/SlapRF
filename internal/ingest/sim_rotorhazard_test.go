package ingest

import (
	"testing"

	"slaprf/internal/domain"
	"slaprf/internal/tracker"
)

func TestSimRotorHazardMultiDeviceLifecycleAndLapScoring(t *testing.T) {
	eng := tracker.NewEngine()
	sim := NewTrackSimulator(eng)
	eng.SetTimingHardwareMode(domain.HardwareModeRotorHazard, true)
	sim.SyncHardwareMode()

	snap := sim.Snapshot()
	if len(snap.RotorHazardUnits) != 2 {
		t.Fatalf("expected 2 default RotorHazard units (R1, R2), got %d", len(snap.RotorHazardUnits))
	}
	if snap.RotorHazardUnits[0].Label != "R1" || snap.RotorHazardUnits[0].Connected {
		t.Fatalf("expected R1 disconnected by default until explicitly connected, got %+v", snap.RotorHazardUnits[0])
	}
	if snap.RotorHazardUnits[1].Label != "R2" || snap.RotorHazardUnits[1].Connected {
		t.Fatalf("expected R2 disconnected by default, got %+v", snap.RotorHazardUnits[1])
	}

	// Verify DiscoverSimRotorHazardUnits finds both powered-on RH1 and RH2
	found := sim.DiscoverSimRotorHazardUnits()
	if len(found) != 2 {
		t.Fatalf("expected 2 discovered RH units, got %d", len(found))
	}

	// Connect RH1 with valid credentials on Gate 1
	_, err := sim.ApplyRotorHazardAction(SimRotorHazardActionRequest{
		Action:    "connect-host",
		Host:      "192.168.1.101",
		Port:      5000,
		AdminUser: "admin",
		AdminPass: "rotorhazard",
	})
	if err != nil {
		t.Fatalf("connect-host RH1 failed: %v", err)
	}

	// Verify connect-host rejects invalid admin password
	_, err = sim.ApplyRotorHazardAction(SimRotorHazardActionRequest{
		Action:    "connect-host",
		Host:      "192.168.1.102",
		Port:      5000,
		AdminUser: "admin",
		AdminPass: "wrong-password",
	})
	if err == nil {
		t.Fatalf("expected auth error with wrong password on RH2")
	}

	// Connect RH2 with valid credentials and bind it to Gate 2 (Split)
	_, err = sim.ApplyRotorHazardAction(SimRotorHazardActionRequest{
		Action:    "connect-host",
		Host:      "192.168.1.102",
		Port:      5000,
		AdminUser: "admin",
		AdminPass: "rotorhazard",
	})
	if err != nil {
		t.Fatalf("connect-host RH2 failed: %v", err)
	}
	if _, err := eng.AddGate("Back Split", 3); err != nil {
		t.Fatalf("AddGate(RH2) failed: %v", err)
	}

	// Step simulator for ~25 simulated seconds (1250 ticks of 20ms) so pilots complete a full 360m 2-gate lap
	eng.SetRaceArmed(true)
	for i := 0; i < 1250; i++ {
		eng.AdvanceVirtualClockUs(20_000)
		sim.step(0.020)
	}

	_, gates, laps, _, _ := eng.StateSnapshot()
	if len(gates) != 2 || gates[0].LastRSSI[0] < 14 || gates[0].LastRSSI[0] > 255 {
		t.Fatalf("expected 0..255 RSSI on RH1 Gate 1, got %+v", gates)
	}
	if len(laps) == 0 {
		t.Fatalf("expected simulated drones to score multi-gate laps through RH1+RH2")
	}
	if len(laps[0].Sectors) != 2 {
		t.Fatalf("expected 2 sector splits across RH1 + RH2, got %+v", laps[0].Sectors)
	}

	// Regression test: ExportOptions -> RestoreOptions must keep heap-pinned RH protocol hooks intact
	// so toggle-connect authenticates RH2 (`AuthOK == true`) and continues scoring laps!
	savedOpts := sim.ExportOptions()
	eng2 := tracker.NewEngine()
	eng2.SetTimingHardwareMode(domain.HardwareModeRotorHazard, true)
	sim2 := NewTrackSimulator(eng2)
	sim2.RestoreOptions(savedOpts)

	// Disconnect then toggle-connect RH2 on restored simulator -> AuthOK must be true!
	_, _ = sim2.ApplyRotorHazardAction(SimRotorHazardActionRequest{Action: "disconnect", TimerID: 3})
	units2, err := sim2.ApplyRotorHazardAction(SimRotorHazardActionRequest{Action: "toggle-connect", TimerID: 3})
	if err != nil {
		t.Fatalf("restored toggle-connect RH2 failed: %v", err)
	}
	if len(units2) < 2 || !units2[1].AuthOK || !units2[1].Connected {
		t.Fatalf("expected restored RH2 AuthOK=true & Connected=true after toggle-connect, got %+v", units2)
	}

	eng2.SetRaceArmed(true)
	for i := 0; i < 1250; i++ {
		eng2.AdvanceVirtualClockUs(20_000)
		sim2.step(0.020)
	}
	_, _, laps2, _, _ := eng2.StateSnapshot()
	if len(laps2) == 0 {
		t.Fatalf("expected restored RotorHazard simulator to score laps cleanly")
	}
}

func TestModeSwitchingRotorHazardToSlapRFAndLapRFContinuesScoringLaps(t *testing.T) {
	eng := tracker.NewEngine()
	sim := NewTrackSimulator(eng)

	// 1. Start in RotorHazard mode, connect R1, and verify hardware telemetry + lap scoring
	eng.SetTimingHardwareMode(domain.HardwareModeRotorHazard, true)
	sim.SyncHardwareMode()
	if _, err := sim.ApplyRotorHazardAction(SimRotorHazardActionRequest{Action: "connect", TimerID: 2}); err != nil {
		t.Fatalf("connect R1 failed: %v", err)
	}
	eng.SetRaceArmed(true)
	for i := 0; i < 1250; i++ {
		eng.AdvanceVirtualClockUs(20_000)
		sim.step(0.020)
	}
	rhSnap := sim.Snapshot()
	if len(rhSnap.RotorHazardUnits) == 0 {
		t.Fatalf("expected RotorHazard units in snapshot")
	}
	r1 := rhSnap.RotorHazardUnits[0]
	if r1.HeartbeatsRx == 0 || r1.NodeFreqsMHz[0] == 0 || r1.NodeEnterLevels[0] == 0 || r1.CpuTempC <= 0 || r1.EnvSummary == "" {
		t.Fatalf("expected rich RotorHazard hardware telemetry on R1, got %+v", r1)
	}
	_, _, rhLaps, _, _ := eng.StateSnapshot()
	if len(rhLaps) == 0 {
		t.Fatalf("expected RotorHazard mode to score laps")
	}

	// 2. Switch RotorHazard -> SlapRF + ExportState/RestoreState + HubFrameDecoder (simulating USB connect)
	_, err := sim.ApplyRotorHazardAction(SimRotorHazardActionRequest{Action: "toggle-connect", TimerID: 3})
	if err != nil {
		t.Fatalf("toggle-connect R2 failed: %v", err)
	}
	eng.SetTimingHardwareMode(domain.HardwareModeSlapRF, true)
	sim.SyncHardwareMode()
	// Late SyncRHNodesNow (e.g. from leaving #/debug) must not pollute SlapRF timers with R1/R2
	sim.SyncRHNodesNow()
	slapSnap := sim.Snapshot()
	for _, tm := range slapSnap.Timers {
		if tm.FirmwareVersion == "RotorHazard" || tm.FirmwareVersion == "LapRF" || tm.TimerLabel == "R1" || tm.TimerLabel == "R2" {
			t.Fatalf("unexpected non-SlapRF timer in SlapRF snapshot: %+v", tm)
		}
	}
	if len(slapSnap.RotorHazardUnits) != 2 || slapSnap.RotorHazardUnits[0].Connected || slapSnap.RotorHazardUnits[1].Connected {
		t.Fatalf("expected simulated RotorHazard boards reset to default (R1 and R2 disconnected) upon switching timing systems, got %+v", slapSnap.RotorHazardUnits)
	}
	exported := eng.ExportState()
	savedOpts := sim.ExportOptions()

	engSlap := tracker.NewEngine()
	engSlap.RestoreState(exported, true)
	_, slapGates, lapsBeforeSlap, _, _ := engSlap.StateSnapshot()
	if len(slapGates) == 0 || slapGates[0].AssignedTimerID != 2 {
		t.Fatalf("expected Start/Finish gate rebound to SlapRF T1 (timerID=2) after restore, got %+v", slapGates)
	}
	simSlap := NewTrackSimulator(engSlap)
	simSlap.RestoreOptions(savedOpts)
	dec := NewHubFrameDecoder(engSlap)
	simSlap.SetHubFrameSink(func(raw []byte) {
		nowUs := engSlap.NowUs()
		pos := 0
		for pos+2 <= len(raw) {
			if raw[pos] != 0x1E {
				pos++
				continue
			}
			pktLen := int(raw[pos+1])
			if pos+2+pktLen > len(raw) {
				break
			}
			dec.IngestPacket(raw[pos+2:pos+2+pktLen], nowUs)
			pos += 2 + pktLen
		}
	})
	engSlap.SetRaceArmed(true)
	simSlap.TriggerPackBurst()

	for i := 0; i < 3500; i++ {
		engSlap.AdvanceVirtualClockUs(20_000)
		simSlap.step(0.020)
		if i%50 == 49 {
			_, _, curLaps, _, _ := engSlap.StateSnapshot()
			if len(curLaps) > len(lapsBeforeSlap) {
				break
			}
		}
	}
	_, _, slapLaps, _, _ := engSlap.StateSnapshot()
	if len(slapLaps) <= len(lapsBeforeSlap) {
		t.Fatalf("expected SlapRF mode with USB HubFrameDecoder to score new laps after switching from RotorHazard (before=%d, after=%d)", len(lapsBeforeSlap), len(slapLaps))
	}

	// 3. Switch SlapRF -> LapRF 8-Way, connect L1, and verify laps continue scoring cleanly
	engSlap.SetTimingHardwareMode(domain.HardwareModeLapRF, true)
	simSlap.SyncHardwareMode()
	if _, err := simSlap.ApplyLapRFAction(SimLapRFActionRequest{Action: "connect", TimerID: 2}); err != nil {
		t.Fatalf("connect L1 failed: %v", err)
	}
	_, _, lapsBeforeLapRF, _, _ := engSlap.StateSnapshot()
	engSlap.SetRaceArmed(true)
	simSlap.TriggerPackBurst()

	for i := 0; i < 3500; i++ {
		engSlap.AdvanceVirtualClockUs(20_000)
		simSlap.step(0.020)
		if i%50 == 49 {
			_, _, curLaps, _, _ := engSlap.StateSnapshot()
			if len(curLaps) > len(lapsBeforeLapRF) {
				break
			}
		}
	}
	_, _, laprfLaps, _, _ := engSlap.StateSnapshot()
	if len(laprfLaps) <= len(lapsBeforeLapRF) {
		t.Fatalf("expected LapRF 8-Way mode to score new laps after switching modes (before=%d, after=%d)", len(lapsBeforeLapRF), len(laprfLaps))
	}
}

func TestSimRotorHazardUSBMultiDeviceAndLapScoring(t *testing.T) {
	eng := tracker.NewEngine()
	sim := NewTrackSimulator(eng)
	eng.SetTimingHardwareMode(domain.HardwareModeRotorHazardUSB, true)
	sim.SyncHardwareMode()

	snap := sim.Snapshot()
	if len(snap.RotorHazardUnits) != 2 {
		t.Fatalf("expected 2 simulated RotorHazard USB units, got %d", len(snap.RotorHazardUnits))
	}
	u1 := snap.RotorHazardUnits[0]
	u2 := snap.RotorHazardUnits[1]
	if u1.Transport != "usb" || u1.PortName != "SIM-RH-USB1" || u1.Connected || u1.APILevel != 36 {
		t.Fatalf("expected SIM-RH-USB1 disconnected by default with API 36, got %+v", u1)
	}
	if u2.Transport != "usb" || u2.PortName != "SIM-RH-USB2" || u2.Connected {
		t.Fatalf("expected SIM-RH-USB2 disconnected by default, got %+v", u2)
	}

	// Connect SIM-RH-USB1 and SIM-RH-USB2 via connect-port and bind to Gate 1 & Gate 2
	if _, err := sim.ApplyRotorHazardAction(SimRotorHazardActionRequest{
		Action:   "connect-port",
		PortName: "SIM-RH-USB1",
	}); err != nil {
		t.Fatalf("connect-port SIM-RH-USB1 failed: %v", err)
	}
	_, err := sim.ApplyRotorHazardAction(SimRotorHazardActionRequest{
		Action:   "connect-port",
		PortName: "SIM-RH-USB2",
	})
	if err != nil {
		t.Fatalf("connect-port SIM-RH-USB2 failed: %v", err)
	}
	if _, err := eng.AddGate("USB Split", 3); err != nil {
		t.Fatalf("AddGate(R2 USB) failed: %v", err)
	}

	eng.SetRaceArmed(true)
	for i := 0; i < 1250; i++ {
		eng.AdvanceVirtualClockUs(20_000)
		sim.step(0.020)
	}

	_, gates, laps, _, _ := eng.StateSnapshot()
	if len(gates) != 2 || gates[0].LastRSSI[0] < 14 || gates[0].LastRSSI[0] > 255 {
		t.Fatalf("expected 0..255 RSSI on SIM-RH-USB1 Gate 1, got %+v", gates)
	}
	if len(laps) == 0 {
		t.Fatalf("expected simulated drones to score multi-gate laps over RotorHazard USB binary wire protocol")
	}
	if len(laps[0].Sectors) != 2 {
		t.Fatalf("expected 2 sector splits across SIM-RH-USB1 + SIM-RH-USB2, got %+v", laps[0].Sectors)
	}
}
