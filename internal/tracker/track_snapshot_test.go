package tracker

import (
	"errors"
	"testing"

	"slaprf/internal/domain"
)

func TestScopedPracticeSessionsOwnIndependentTracksAndRules(t *testing.T) {
	eng := NewEngine()

	ps := eng.PracticeSnapshot()
	if len(ps.Sessions) != 1 || !ps.Sessions[0].Active {
		t.Fatalf("expected 1 active Open Practice session, got %+v", ps.Sessions)
	}
	openID := ps.Sessions[0].SessionID
	if len(ps.Sessions[0].TrackSnapshot) != 4 {
		t.Fatalf("expected initial session TrackSnapshot len 4, got %d", len(ps.Sessions[0].TrackSnapshot))
	}

	// Rename Gate 2 on Session 1 to "Split-S" and set Session 1 MinLapSec = 6.5s
	if err := eng.UpdatePracticeGate(openID, domain.GateUpdate{
		GateID: ps.Sessions[0].TrackSnapshot[1].GateID,
		Name:   "Split-S",
		Role:   domain.GateRoleSectorGate,
	}); err != nil {
		t.Fatalf("UpdatePracticeGate failed: %v", err)
	}
	r1 := domain.DefaultTimingRules()
	r1.MinLapSec = 6.5
	if _, err := eng.SetPracticeRules(openID, r1); err != nil {
		t.Fatalf("SetPracticeRules failed: %v", err)
	}

	// Create Session 2 while Session 1 is STILL active, and customize Session 2 to a 2-gate track ("Dive Gate") with MinLapSec = 4.2s
	ps, err := eng.PracticeAction(PracticeActionPayload{
		Action: "create_session",
		Name:   "Afternoon Warmup",
	})
	if err != nil {
		t.Fatalf("create_session failed: %v", err)
	}
	sess2ID := ps.SelectedSessionID

	s2Gates, _, _, err := eng.PracticeTrackSnapshot(sess2ID)
	if err != nil {
		t.Fatalf("PracticeTrackSnapshot s2 failed: %v", err)
	}
	if err := eng.RemovePracticeGate(sess2ID, s2Gates[3].GateID); err != nil {
		t.Fatalf("RemovePracticeGate 4 failed: %v", err)
	}
	if err := eng.RemovePracticeGate(sess2ID, s2Gates[2].GateID); err != nil {
		t.Fatalf("RemovePracticeGate 3 failed: %v", err)
	}
	if err := eng.UpdatePracticeGate(sess2ID, domain.GateUpdate{
		GateID: s2Gates[1].GateID,
		Name:   "Dive Gate",
		Role:   domain.GateRoleSectorGate,
	}); err != nil {
		t.Fatalf("UpdatePracticeGate s2 failed: %v", err)
	}
	r2 := domain.DefaultTimingRules()
	r2.MinLapSec = 4.2
	if _, err := eng.SetPracticeRules(sess2ID, r2); err != nil {
		t.Fatalf("SetPracticeRules s2 failed: %v", err)
	}

	// Verify live engine is STILL running Session 1's 4-gate "Split-S" course & 6.5s rule!
	_, liveGates, _, _, _ := eng.StateSnapshot()
	if len(liveGates) != 4 || liveGates[1].Name != "Split-S" {
		t.Fatalf("editing inactive Session 2 mutated active Session 1 live gates: %+v", liveGates)
	}
	if eng.Rules().MinLapSec != 6.5 {
		t.Fatalf("editing inactive Session 2 mutated active Session 1 live rules: %+v", eng.Rules())
	}

	// Now start Session 2 -> live engine switches to Session 2's 2-gate "Dive Gate" course & 4.2s rule,
	// while Session 1 preserves its 4-gate "Split-S" course & 6.5s rule!
	if _, err := eng.PracticeAction(PracticeActionPayload{
		Action:    "start_session",
		SessionID: sess2ID,
	}); err != nil {
		t.Fatalf("start_session s2 failed: %v", err)
	}

	_, liveGates, _, _, _ = eng.StateSnapshot()
	if len(liveGates) != 2 || liveGates[1].Name != "Dive Gate" {
		t.Fatalf("starting Session 2 did not load its 2-gate 'Dive Gate' track into live engine: %+v", liveGates)
	}
	if eng.Rules().MinLapSec != 4.2 {
		t.Fatalf("starting Session 2 did not load its 4.2s rule into live engine: %+v", eng.Rules())
	}

	s1Gates, _, s1Rules, err := eng.PracticeTrackSnapshot(openID)
	if err != nil {
		t.Fatalf("PracticeTrackSnapshot s1 failed: %v", err)
	}
	if len(s1Gates) != 4 || s1Gates[1].Name != "Split-S" || s1Rules.MinLapSec != 6.5 {
		t.Fatalf("Session 1 lost its independent 4-gate 'Split-S' track or 6.5s rule: gates=%d rules=%+v", len(s1Gates), s1Rules)
	}

	// Verify empty (0-gate) track persists across ExportState / RestoreState via TrackInitialized
	for _, g := range liveGates {
		if err := eng.RemovePracticeGate(sess2ID, g.GateID); err != nil {
			t.Fatalf("RemovePracticeGate to empty failed: %v", err)
		}
	}
	exported := eng.ExportState()
	restored := NewEngine()
	restored.RestoreState(exported, true)

	rS1Gates, _, rS1Rules, _ := restored.PracticeTrackSnapshot(openID)
	if len(rS1Gates) != 4 || rS1Gates[1].Name != "Split-S" || rS1Rules.MinLapSec != 6.5 {
		t.Fatalf("restored Session 1 lost 4-gate 'Split-S' track or 6.5s rule: gates=%d rules=%+v", len(rS1Gates), rS1Rules)
	}
	rS2Gates, _, rS2Rules, _ := restored.PracticeTrackSnapshot(sess2ID)
	if len(rS2Gates) != 0 || rS2Rules.MinLapSec != 4.2 {
		t.Fatalf("restored Session 2 should keep 0-gate track and 4.2s rule, got gates=%d rules=%+v", len(rS2Gates), rS2Rules)
	}
}

func TestScopedRacesOwnIndependentTracksAndFreezeOnCompleteAndScrap(t *testing.T) {
	eng := NewEngine()

	// Create Race 1 and Race 2 (both open / draft at the same time)
	r1, err := eng.EventAction(EventActionPayload{
		Action: "create_race",
		Name:   "Morning Qualifier",
	})
	if err != nil {
		t.Fatalf("create_race 1 failed: %v", err)
	}
	r1ID := r1.RaceID

	r2, err := eng.EventAction(EventActionPayload{
		Action: "create_race",
		Name:   "Evening Finals",
	})
	if err != nil {
		t.Fatalf("create_race 2 failed: %v", err)
	}
	r2ID := r2.RaceID

	// Configure Race 1: 4 gates with Gate 1 = "Main Arch" and per-gate rule override on Gate 1
	r1Gates, _, _, err := eng.RaceTrackSnapshot(r1ID)
	if err != nil {
		t.Fatalf("RaceTrackSnapshot r1 failed: %v", err)
	}
	if err := eng.UpdateRaceGate(r1ID, domain.GateUpdate{
		GateID: r1Gates[0].GateID,
		Name:   "Main Arch",
		Role:   domain.GateRoleStartFinish,
	}); err != nil {
		t.Fatalf("UpdateRaceGate r1 failed: %v", err)
	}
	ovrMin := 7.0
	if _, err := eng.SetRaceGateRules(r1ID, r1Gates[0].GateID, domain.GateRuleOverrides{MinLapSec: &ovrMin}); err != nil {
		t.Fatalf("SetRaceGateRules r1 failed: %v", err)
	}

	// Configure Race 2 (while Race 1 is ALSO open!): 2 gates with Gate 1 = "LED Finish" and MinLapSec = 8.0s
	r2Gates, _, _, err := eng.RaceTrackSnapshot(r2ID)
	if err != nil {
		t.Fatalf("RaceTrackSnapshot r2 failed: %v", err)
	}
	if err := eng.UpdateRaceGate(r2ID, domain.GateUpdate{
		GateID: r2Gates[0].GateID,
		Name:   "LED Finish",
		Role:   domain.GateRoleStartFinish,
	}); err != nil {
		t.Fatalf("UpdateRaceGate r2 failed: %v", err)
	}
	if err := eng.RemoveRaceGate(r2ID, r2Gates[3].GateID); err != nil {
		t.Fatalf("RemoveRaceGate 4 failed: %v", err)
	}
	if err := eng.RemoveRaceGate(r2ID, r2Gates[2].GateID); err != nil {
		t.Fatalf("RemoveRaceGate 3 failed: %v", err)
	}
	rules2 := domain.DefaultTimingRules()
	rules2.MinLapSec = 8.0
	if _, err := eng.SetRaceRules(r2ID, rules2); err != nil {
		t.Fatalf("SetRaceRules r2 failed: %v", err)
	}

	// Verify open Race 1 and open Race 2 never overwrote each other!
	gotR1Gates, _, _, _ := eng.RaceTrackSnapshot(r1ID)
	gotR2Gates, _, gotR2Rules, _ := eng.RaceTrackSnapshot(r2ID)
	if len(gotR1Gates) != 4 || gotR1Gates[0].Name != "Main Arch" || gotR1Gates[0].RuleOverrides.MinLapSec == nil || *gotR1Gates[0].RuleOverrides.MinLapSec != 7.0 {
		t.Fatalf("open Race 1 track/overrides corrupted by editing open Race 2: %+v", gotR1Gates)
	}
	if len(gotR2Gates) != 2 || gotR2Gates[0].Name != "LED Finish" || gotR2Rules.MinLapSec != 8.0 {
		t.Fatalf("open Race 2 track/rules unexpected: gates=%+v rules=%+v", gotR2Gates, gotR2Rules)
	}

	// Complete Race 1 -> track & rules become strictly read-only (`ErrRaceTrackReadOnly`)
	if _, err := eng.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          r1ID,
		LifecycleAction: "complete_race",
	}); err != nil {
		t.Fatalf("complete_race failed: %v", err)
	}
	if err := eng.RemoveRaceGate(r1ID, gotR1Gates[1].GateID); !errors.Is(err, ErrRaceTrackReadOnly) {
		t.Fatalf("expected ErrRaceTrackReadOnly on completed race, got %v", err)
	}
	if _, err := eng.SetRaceRules(r1ID, rules2); !errors.Is(err, ErrRaceTrackReadOnly) {
		t.Fatalf("expected ErrRaceTrackReadOnly on SetRaceRules for completed race, got %v", err)
	}

	// Apply a race format template to Race 2 -> must preserve Race 2's custom 2-gate track & 8.0s rule!
	if _, err := eng.BracketEditAction(BracketEditPayload{
		Action:        "apply_template",
		RaceID:        r2ID,
		TemplateID:    "single_elimination",
		PilotsPerHeat: 4,
		TargetLaps:    3,
	}); err != nil {
		t.Fatalf("apply_template r2 failed: %v", err)
	}

	// Start Race 2 -> loads Race 2's 2-gate "LED Finish" track and 8.0s rule into live engine!
	if _, err := eng.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          r2ID,
		LifecycleAction: "start_race",
		PreemptOngoing:  true,
	}); err != nil {
		t.Fatalf("start_race r2 failed: %v", err)
	}
	_, liveGates, _, _, _ := eng.StateSnapshot()
	if len(liveGates) != 2 || liveGates[0].Name != "LED Finish" || eng.Rules().MinLapSec != 8.0 {
		t.Fatalf("starting Race 2 should load 2-gate 'LED Finish' track & 8.0s rule into live engine, got gates=%+v rules=%+v", liveGates, eng.Rules())
	}
}

func TestRestoreDemoShowcaseSeedsIndependentTracksAndRules(t *testing.T) {
	eng := NewEngine()
	eng.RestoreDemoData()

	pm := eng.PracticeSnapshot()
	if len(pm.Sessions) != 3 {
		t.Fatalf("expected 3 demo practice sessions, got %d", len(pm.Sessions))
	}
	var openSess, specSess, tuneSess *domain.PracticeSession
	for i := range pm.Sessions {
		switch pm.Sessions[i].Name {
		case "Open Track Practice":
			openSess = &pm.Sessions[i]
		case "Spec Class Pace":
			specSess = &pm.Sessions[i]
		case "Morning Track Tune":
			tuneSess = &pm.Sessions[i]
		}
	}
	if openSess == nil || specSess == nil || tuneSess == nil {
		t.Fatalf("missing expected demo practice sessions")
	}
	if !openSess.TrackInitialized || len(openSess.TrackSnapshot) != 3 || openSess.Rules == nil || openSess.Rules.MinLapSec != 5.0 {
		t.Fatalf("unexpected Open Track Practice track/rules: len=%d rules=%+v", len(openSess.TrackSnapshot), openSess.Rules)
	}
	if !specSess.TrackInitialized || len(specSess.TrackSnapshot) != 3 || specSess.Rules == nil || specSess.Rules.MinLapSec != 5.5 {
		t.Fatalf("unexpected Spec Class Pace track/rules: len=%d rules=%+v", len(specSess.TrackSnapshot), specSess.Rules)
	}
	if !tuneSess.TrackInitialized || len(tuneSess.TrackSnapshot) != 1 || tuneSess.Rules == nil || tuneSess.Rules.MinLapSec != 4.5 {
		t.Fatalf("unexpected Morning Track Tune 1-gate warmup track/rules: len=%d rules=%+v", len(tuneSess.TrackSnapshot), tuneSess.Rules)
	}

	ev := eng.EventSnapshot()
	var draftSpec, champ *domain.RaceTournamentState
	for i := range ev.Races {
		switch ev.Races[i].Config.EventName {
		case "Sunday Spec Shootout":
			draftSpec = &ev.Races[i]
		case "Bay Area Championship":
			champ = &ev.Races[i]
		}
	}
	if draftSpec == nil || champ == nil {
		t.Fatalf("missing expected demo races")
	}
	if !draftSpec.TrackInitialized || len(draftSpec.TrackSnapshot) != 2 || draftSpec.Rules == nil || draftSpec.Rules.MinLapSec != 6.0 {
		t.Fatalf("expected Sunday Spec Shootout to have 2-gate spec track & 6.0s rule, got len=%d rules=%+v", len(draftSpec.TrackSnapshot), draftSpec.Rules)
	}
	if !champ.TrackInitialized || len(champ.TrackSnapshot) != 3 || champ.Rules == nil || champ.Rules.MinLapSec != 5.0 {
		t.Fatalf("expected Bay Area Championship to have 3-gate track & 5.0s rule, got len=%d rules=%+v", len(champ.TrackSnapshot), champ.Rules)
	}
}
