package tracker

import (
	"testing"

	"slaprf/internal/domain"
)

func TestPracticeSessionTrackSnapshotFreezesOnStop(t *testing.T) {
	eng := NewEngine()

	// Rename Gate 2 on the active 4-gate course to "Split-S"
	_, gates, _, _, _ := eng.StateSnapshot()
	if len(gates) != 4 {
		t.Fatalf("expected 4 default gates, got %d", len(gates))
	}
	if err := eng.UpdateGate(domain.GateUpdate{
		GateID: gates[1].GateID,
		Name:   "Split-S",
		Role:   domain.GateRoleSectorGate,
	}); err != nil {
		t.Fatalf("UpdateGate failed: %v", err)
	}

	ps := eng.PracticeSnapshot()
	if len(ps.Sessions) != 1 || !ps.Sessions[0].Active {
		t.Fatalf("expected 1 active Open Practice session, got %+v", ps.Sessions)
	}
	openID := ps.Sessions[0].SessionID
	if len(ps.Sessions[0].TrackSnapshot) != 4 {
		t.Fatalf("expected active session TrackSnapshot len 4, got %d", len(ps.Sessions[0].TrackSnapshot))
	}
	if ps.Sessions[0].TrackSnapshot[1].Name != "Split-S" {
		t.Fatalf("expected active session TrackSnapshot[1].Name = 'Split-S', got %q", ps.Sessions[0].TrackSnapshot[1].Name)
	}

	// Stop Session 1 — freezing its 4-gate TrackSnapshot ("Split-S")
	ps, err := eng.PracticeAction(PracticeActionPayload{
		Action:    "stop_session",
		SessionID: openID,
	})
	if err != nil {
		t.Fatalf("stop_session failed: %v", err)
	}

	// Create Session 2 and start it
	ps, err = eng.PracticeAction(PracticeActionPayload{
		Action: "create_session",
		Name:   "Afternoon Warmup",
	})
	if err != nil {
		t.Fatalf("create_session failed: %v", err)
	}
	sess2ID := ps.SelectedSessionID
	if _, err := eng.PracticeAction(PracticeActionPayload{
		Action:    "start_session",
		SessionID: sess2ID,
	}); err != nil {
		t.Fatalf("start_session failed: %v", err)
	}

	// Now modify the live track for Afternoon Warmup: rename Gate 2 to "Dive Gate" and remove Gate 4 (3 gates total)
	if err := eng.UpdateGate(domain.GateUpdate{
		GateID: gates[1].GateID,
		Name:   "Dive Gate",
		Role:   domain.GateRoleSectorGate,
	}); err != nil {
		t.Fatalf("UpdateGate Dive Gate failed: %v", err)
	}
	if err := eng.RemoveGate(gates[3].GateID); err != nil {
		t.Fatalf("RemoveGate failed: %v", err)
	}

	ps = eng.PracticeSnapshot()
	var s1, s2 *domain.PracticeSession
	for i := range ps.Sessions {
		if ps.Sessions[i].SessionID == openID {
			s1 = &ps.Sessions[i]
		} else if ps.Sessions[i].SessionID == sess2ID {
			s2 = &ps.Sessions[i]
		}
	}
	if s1 == nil || s2 == nil {
		t.Fatalf("expected both sessions present")
	}

	// Stopped Session 1 MUST preserve its 4-gate snapshot with "Split-S" and 4 sector stats!
	if len(s1.TrackSnapshot) != 4 {
		t.Fatalf("stopped Session 1 TrackSnapshot should remain 4 gates, got %d", len(s1.TrackSnapshot))
	}
	if s1.TrackSnapshot[1].Name != "Split-S" {
		t.Fatalf("stopped Session 1 TrackSnapshot[1].Name should remain 'Split-S', got %q", s1.TrackSnapshot[1].Name)
	}
	if len(s1.Summaries) > 0 && len(s1.Summaries[0].SectorStats) != 4 {
		t.Fatalf("stopped Session 1 summaries should preserve 4 sectors, got %d", len(s1.Summaries[0].SectorStats))
	}
	if len(s1.Summaries) > 0 && s1.Summaries[0].SectorStats[1].Label != "Split-S → T3" {
		t.Fatalf("stopped Session 1 sector 2 label should use frozen snapshot ('Split-S → T3'), got %q", s1.Summaries[0].SectorStats[1].Label)
	}

	// Active Session 2 MUST follow the live 3-gate track with "Dive Gate"!
	if len(s2.TrackSnapshot) != 3 {
		t.Fatalf("active Session 2 TrackSnapshot should follow 3-gate live track, got %d", len(s2.TrackSnapshot))
	}
	if s2.TrackSnapshot[1].Name != "Dive Gate" {
		t.Fatalf("active Session 2 TrackSnapshot[1].Name should be 'Dive Gate', got %q", s2.TrackSnapshot[1].Name)
	}

	// Verify persistence round-trip preserves frozen TrackSnapshot
	exported := eng.ExportState()
	restored := NewEngine()
	restored.RestoreState(exported, true)
	psRestored := restored.PracticeSnapshot()
	for _, rs := range psRestored.Sessions {
		if rs.SessionID == openID {
			if len(rs.TrackSnapshot) != 4 || rs.TrackSnapshot[1].Name != "Split-S" {
				t.Fatalf("restored stopped session lost frozen TrackSnapshot: %+v", rs.TrackSnapshot)
			}
		}
	}
}

func TestRaceTrackSnapshotFreezesOnCompleteAndScrap(t *testing.T) {
	eng := NewEngine()

	// Create Race 1 on 4-gate course
	r1, err := eng.EventAction(EventActionPayload{
		Action: "create_race",
		Name:   "Morning Qualifier",
	})
	if err != nil {
		t.Fatalf("create_race failed: %v", err)
	}
	if len(r1.TrackSnapshot) != 4 {
		t.Fatalf("expected 4 gates in Race 1 TrackSnapshot, got %d", len(r1.TrackSnapshot))
	}

	// While Race 1 is still draft/open, rename Gate 1 to "Main Arch" -> Race 1 TrackSnapshot updates live
	_, gates, _, _, _ := eng.StateSnapshot()
	if err := eng.UpdateGate(domain.GateUpdate{
		GateID: gates[0].GateID,
		Name:   "Main Arch",
		Role:   domain.GateRoleStartFinish,
	}); err != nil {
		t.Fatalf("UpdateGate failed: %v", err)
	}

	r1 = eng.RaceSnapshot()
	if len(r1.TrackSnapshot) != 4 || r1.TrackSnapshot[0].Name != "Main Arch" {
		t.Fatalf("open Race 1 should follow live track edit, got %+v", r1.TrackSnapshot)
	}

	// Complete Race 1 -> freezes its 4-gate TrackSnapshot
	r1, err = eng.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          r1.RaceID,
		LifecycleAction: "complete_race",
	})
	if err != nil {
		t.Fatalf("complete_race failed: %v", err)
	}
	r1ID := r1.RaceID

	// Create Race 2 (open) and then remove 2 gates from the live track (leaving 2 gates) and rename Gate 1
	r2, err := eng.EventAction(EventActionPayload{
		Action: "create_race",
		Name:   "Evening Finals",
	})
	if err != nil {
		t.Fatalf("create_race 2 failed: %v", err)
	}
	r2ID := r2.RaceID

	if err := eng.UpdateGate(domain.GateUpdate{
		GateID: gates[0].GateID,
		Name:   "LED Finish",
		Role:   domain.GateRoleStartFinish,
	}); err != nil {
		t.Fatalf("UpdateGate 2 failed: %v", err)
	}
	if err := eng.RemoveGate(gates[3].GateID); err != nil {
		t.Fatalf("RemoveGate 4 failed: %v", err)
	}
	if err := eng.RemoveGate(gates[2].GateID); err != nil {
		t.Fatalf("RemoveGate 3 failed: %v", err)
	}

	ev := eng.EventSnapshot()
	var gotR1, gotR2 *domain.RaceTournamentState
	for i := range ev.Races {
		if ev.Races[i].RaceID == r1ID {
			gotR1 = &ev.Races[i]
		} else if ev.Races[i].RaceID == r2ID {
			gotR2 = &ev.Races[i]
		}
	}
	if gotR1 == nil || gotR2 == nil {
		t.Fatalf("expected both races in EventSnapshot")
	}

	if len(gotR1.TrackSnapshot) != 4 || gotR1.TrackSnapshot[0].Name != "Main Arch" {
		t.Fatalf("completed Race 1 should preserve 4-gate 'Main Arch' snapshot, got len=%d first=%+v", len(gotR1.TrackSnapshot), gotR1.TrackSnapshot)
	}
	if len(gotR2.TrackSnapshot) != 2 || gotR2.TrackSnapshot[0].Name != "LED Finish" {
		t.Fatalf("open Race 2 should follow 2-gate 'LED Finish' live track, got len=%d first=%+v", len(gotR2.TrackSnapshot), gotR2.TrackSnapshot)
	}
}
