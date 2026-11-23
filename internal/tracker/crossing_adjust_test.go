package tracker

import (
	"math"
	"testing"

	"slaprf/internal/domain"
)

func TestAdjustPracticeSessionCrossingRecalculatesLapsAndSplits(t *testing.T) {
	// Configure 3-gate track BEFORE creating the session so TrackSnapshot inherits H1, T1, T2:
	e := NewEngine()
	e.mu.Lock()
	e.gates = []domain.TrackGate{
		{GateID: 1, Name: "H1", Role: domain.GateRoleStartFinish, TrackOrder: 0, AssignedTimerID: 1},
		{GateID: 2, Name: "T1", Role: domain.GateRoleSectorGate, TrackOrder: 1, AssignedTimerID: 2},
		{GateID: 3, Name: "T2", Role: domain.GateRoleSectorGate, TrackOrder: 2, AssignedTimerID: 3},
	}
	e.mu.Unlock()
	if err := e.UpdatePilotSlot(domain.PilotSlot{
		SlotIndex:    1,
		Callsign:     "Maverick",
		Band:         domain.BandRaceband,
		Channel:      1,
		FrequencyMHz: 5658,
		Enabled:      true,
	}); err != nil {
		t.Fatalf("UpdatePilotSlot: %v", err)
	}

	ps, err := e.PracticeAction(PracticeActionPayload{Action: "create_session", Name: "Morning Pack"})
	if err != nil {
		t.Fatalf("create_session: %v", err)
	}
	sid := ps.Sessions[len(ps.Sessions)-1].SessionID
	if _, err := e.PracticeAction(PracticeActionPayload{
		Action:    "add_session_pilot",
		SessionID: sid,
		SlotIndex: 1,
		Band:      domain.BandRaceband,
		Channel:   1,
	}); err != nil {
		t.Fatalf("add_session_pilot: %v", err)
	}
	if _, err := e.PracticeAction(PracticeActionPayload{Action: "start_session", SessionID: sid}); err != nil {
		t.Fatalf("start_session: %v", err)
	}

	feedPass := func(gateID uint8, sec float64) uint64 {
		t.Helper()
		e.mu.Lock()
		defer e.mu.Unlock()
		var gate domain.TrackGate
		for _, g := range e.gates {
			if g.GateID == gateID {
				gate = g
			}
		}
		ev := domain.GateCrossingEvent{
			GateID:        gateID,
			GateName:      gate.Name,
			IsStartFinish: gate.Role == domain.GateRoleStartFinish,
			SlotIndex:     1,
			Callsign:      "OneEye",
			FrequencyMHz:  5880,
			TimestampUs:   uint64(sec * 1e6),
			PeakRSSIDbm:   -55,
		}
		out := e.applyCrossingLocked(e.pilots[0], gate, ev)
		if out.rejected != nil {
			t.Fatalf("unexpected rejection at gate %d @ %.2fs: %+v", gateID, sec, out.rejected)
		}
		e.nextEventID++
		ev.EventID = e.nextEventID
		ev.StartedLap = ev.IsStartFinish && out.lap == nil
		e.crossings = append(e.crossings, ev)
		if out.lap != nil {
			e.laps = append(e.laps, *out.lap)
		}
		e.syncActivePracticeRecordsLocked()
		return ev.EventID
	}

	// Lap 1: H1(10.0s) -> T1(12.2s, premature!) -> T2(17.0s) -> H1(21.0s) => 11.0s
	_ = feedPass(1, 10.0)
	evT1Lap1 := feedPass(2, 12.2)
	_ = feedPass(3, 17.0)
	evH1Lap1 := feedPass(1, 21.0)

	// Lap 2: T1(24.5s) -> T2(28.0s) -> H1(32.0s) => 11.0s
	_ = feedPass(2, 24.5)
	_ = feedPass(3, 28.0)
	_ = feedPass(1, 32.0)

	// 1. Drag T1 on Lap 1 from 12.2s to 13.5s (+1.3s):
	//    Lap 1 duration stays 11.0s, S1 becomes 3.5s (13.5 - 10.0), S2 becomes 3.5s (17.0 - 13.5)!
	newPeak := float32(-52.4)
	psAfterSector, err := e.AdjustPracticeSessionCrossing(sid, evT1Lap1, 13_500_000, &newPeak)
	if err != nil {
		t.Fatalf("AdjustPracticeSessionCrossing(sector): %v", err)
	}
	sess := psAfterSector.Sessions[len(psAfterSector.Sessions)-1]
	if len(sess.Laps) != 2 {
		t.Fatalf("expected 2 laps, got %d", len(sess.Laps))
	}
	lap1 := sess.Laps[0]
	if lap1.LapTimeSec != 11.0 {
		t.Fatalf("expected Lap 1 duration unchanged at 11.0s, got %.3fs", lap1.LapTimeSec)
	}
	if len(lap1.Sectors) != 3 || math.Abs(lap1.Sectors[0].SplitSeconds-3.5) > 0.001 || math.Abs(lap1.Sectors[1].SplitSeconds-3.5) > 0.001 {
		t.Fatalf("expected Lap 1 splits [3.5, 3.5, 4.0], got %+v", lap1.Sectors)
	}

	// 2. Drag H1 · Lap 1 from 21.0s to 21.6s (+0.6s):
	//    Lap 1 becomes 11.6s (S3 becomes 4.6s), AND Lap 2 becomes 10.4s (S1 becomes 24.5 - 21.6 = 2.9s, new Best Lap)!
	psAfterSF, err := e.AdjustPracticeSessionCrossing(sid, evH1Lap1, 21_600_000, nil)
	if err != nil {
		t.Fatalf("AdjustPracticeSessionCrossing(start/finish): %v", err)
	}
	sess = psAfterSF.Sessions[len(psAfterSF.Sessions)-1]
	lap1 = sess.Laps[0]
	lap2 := sess.Laps[1]
	if math.Abs(lap1.LapTimeSec-11.6) > 0.001 || math.Abs(lap1.Sectors[2].SplitSeconds-4.6) > 0.001 {
		t.Fatalf("expected Lap 1 updated to 11.6s with S3=4.6s, got lap=%.3fs sectors=%+v", lap1.LapTimeSec, lap1.Sectors)
	}
	if math.Abs(lap2.LapTimeSec-10.4) > 0.001 || math.Abs(lap2.Sectors[0].SplitSeconds-2.9) > 0.001 {
		t.Fatalf("expected Lap 2 updated to 10.4s with S1=2.9s, got lap=%.3fs sectors=%+v", lap2.LapTimeSec, lap2.Sectors)
	}
	if !lap2.IsBestLap || lap1.IsBestLap {
		t.Fatalf("expected Lap 2 (10.4s) to become Best Lap and Lap 1 (11.6s) non-best: lap1=%+v lap2=%+v", lap1, lap2)
	}
}
