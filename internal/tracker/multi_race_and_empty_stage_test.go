package tracker

import (
	"testing"

	"slaprf/internal/domain"
)

func TestDeleteLastStageToEmptyBoardAndCompletedHeatsGuard(t *testing.T) {
	e := NewEngine()

	// 1. Create a fresh race and add a Single Elimination stage
	created, err := e.EventAction(EventActionPayload{
		Action: "create_race",
		Name:   "Empty Board Test Race",
	})
	if err != nil {
		t.Fatalf("create_race failed: %v", err)
	}
	raceID := created.RaceID

	withStage, err := e.BracketEditAction(BracketEditPayload{
		Action:      "add_stage",
		RaceID:      raceID,
		StageFormat: domain.FormatQualifying,
	})
	if err != nil {
		t.Fatalf("add_stage failed: %v", err)
	}
	if len(withStage.Stages) != 1 || !withStage.Generated {
		t.Fatalf("expected 1 generated stage, got stages=%d generated=%v", len(withStage.Stages), withStage.Generated)
	}

	// 2. Stage a heat (uncompleted!) — deleting the stage MUST still succeed!
	if len(withStage.Heats) == 0 {
		t.Fatalf("expected heats in qualifying stage")
	}
	if _, err := e.RaceControlAction("select", withStage.Heats[0].ID); err != nil {
		t.Fatalf("select heat failed: %v", err)
	}

	afterDeleteSole, err := e.BracketEditAction(BracketEditPayload{
		Action:     "remove_stage",
		RaceID:     raceID,
		StageIndex: 1,
	})
	if err != nil {
		t.Fatalf("expected deleting sole stage with staged heat to succeed, got: %v", err)
	}
	if len(afterDeleteSole.Stages) != 0 || afterDeleteSole.Generated || len(afterDeleteSole.Heats) != 0 {
		t.Fatalf("expected empty board after deleting sole stage, got stages=%d generated=%v heats=%d",
			len(afterDeleteSole.Stages), afterDeleteSole.Generated, len(afterDeleteSole.Heats))
	}
	if afterDeleteSole.Lifecycle != domain.LifecycleDraft {
		t.Fatalf("expected lifecycle draft after clearing board, got %q", afterDeleteSole.Lifecycle)
	}

	// 3. Re-add a stage on the empty board, start + stop + confirm 1 heat -> deleting stage MUST now be blocked!
	readded, err := e.BracketEditAction(BracketEditPayload{
		Action:      "add_stage",
		RaceID:      raceID,
		StageFormat: domain.FormatQualifying,
	})
	if err != nil {
		t.Fatalf("re-adding stage failed: %v", err)
	}
	var customZero int
	cfg := readded.Config
	cfg.CountdownSec = customZero
	e.ConfigureAndGenerateRaceForID(raceID, cfg, false, false)

	hID := readded.Heats[0].ID
	if _, err := e.RaceControlAction("start", hID); err != nil {
		t.Fatalf("start heat failed: %v", err)
	}
	// While running, deletion must be blocked
	if _, err := e.BracketEditAction(BracketEditPayload{
		Action:     "remove_stage",
		RaceID:     raceID,
		StageIndex: 1,
	}); err == nil {
		t.Fatalf("expected remove_stage to fail while heat is running")
	}
	if _, err := e.RaceControlAction("stop", hID); err != nil {
		t.Fatalf("stop heat failed: %v", err)
	}
	if _, err := e.RaceControlAction("confirm", hID); err != nil {
		t.Fatalf("confirm heat failed: %v", err)
	}
	// After heat is confirmed (completed), deletion must be blocked
	if _, err := e.BracketEditAction(BracketEditPayload{
		Action:     "remove_stage",
		RaceID:     raceID,
		StageIndex: 1,
	}); err == nil {
		t.Fatalf("expected remove_stage to fail when stage has a confirmed heat")
	}
}

func TestEditSecondRaceWhileFirstRaceIsActivelyRunning(t *testing.T) {
	e := NewEngine()
	e.SetOperatingMode(domain.ModeRace)

	// 1. Setup Race A and start a live running heat (0s countdown -> immediate HeatRunning + armed)
	raceA, err := e.EventAction(EventActionPayload{
		Action: "create_race",
		Name:   "Friday Pro Main",
	})
	if err != nil {
		t.Fatalf("create Race A failed: %v", err)
	}
	cfgA := raceA.Config
	cfgA.CountdownSec = 0
	e.ConfigureAndGenerateRaceForID(raceA.RaceID, cfgA, false, false)

	raceA, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_stage",
		RaceID:      raceA.RaceID,
		StageFormat: domain.FormatQualifying,
	})
	if err != nil {
		t.Fatalf("add_stage on Race A failed: %v", err)
	}
	runningHeatID := raceA.Heats[0].ID
	if _, err := e.RaceControlActionForRace(raceA.RaceID, "start", runningHeatID); err != nil {
		t.Fatalf("start Race A heat failed: %v", err)
	}
	if !e.IsRaceArmed() {
		t.Fatalf("expected Race A to be armed while heat is running")
	}

	// 2. Create Race B and edit its format, stages, settings, and roster while Race A keeps running!
	if _, err := e.EventAction(EventActionPayload{
		Action:     "create_race",
		Name:       "Saturday Spec Class",
		DontSelect: true,
	}); err != nil {
		t.Fatalf("create Race B failed: %v", err)
	}
	ev := e.EventSnapshot()
	var raceBID string
	for _, r := range ev.Races {
		if r.Config.EventName == "Saturday Spec Class" {
			raceBID = r.RaceID
		}
	}
	if raceBID == "" {
		t.Fatalf("could not find created Race B")
	}

	// Selecting Race B while Race A is running must NOT pause or disarm Race A!
	selectedSnap, err := e.EventAction(EventActionPayload{
		Action: "select_race",
		RaceID: raceBID,
	})
	if err != nil {
		t.Fatalf("select_race Race B failed: %v", err)
	}
	if selectedSnap.RaceID != raceBID {
		t.Fatalf("expected select_race return snapshot for Race B, got %q", selectedSnap.RaceID)
	}

	// Add Qualifier + Double Elim stages on Race B, connect them, and delete & re-add a stage!
	bSnap, err := e.BracketEditAction(BracketEditPayload{
		Action:      "add_stage",
		RaceID:      raceBID,
		StageFormat: domain.FormatQualifying,
	})
	if err != nil {
		t.Fatalf("add_stage 1 on Race B failed: %v", err)
	}
	if len(bSnap.Stages) != 1 {
		t.Fatalf("expected 1 stage on Race B, got %d", len(bSnap.Stages))
	}

	// Delete sole stage on Race B while Race A is running -> empty board on Race B!
	bSnap, err = e.BracketEditAction(BracketEditPayload{
		Action:     "remove_stage",
		RaceID:     raceBID,
		StageIndex: 1,
	})
	if err != nil {
		t.Fatalf("remove sole stage on Race B while Race A running failed: %v", err)
	}
	if len(bSnap.Stages) != 0 || bSnap.Generated {
		t.Fatalf("expected Race B empty after deleting sole stage, got stages=%d generated=%v", len(bSnap.Stages), bSnap.Generated)
	}

	// Apply 2-stage template on Race B while Race A is running!
	bSnap, err = e.BracketEditAction(BracketEditPayload{
		Action:     "apply_template",
		RaceID:     raceBID,
		TemplateID: "qual_double_elim",
	})
	if err != nil {
		t.Fatalf("apply_template on Race B while Race A running failed: %v", err)
	}
	if len(bSnap.Stages) != 1 || bSnap.TotalStages != 1 || !bSnap.Generated || len(bSnap.Rounds) < 4 {
		t.Fatalf("expected unified single-graph tournament on Race B after apply_template, got stages=%d rounds=%d", len(bSnap.Stages), len(bSnap.Rounds))
	}

	// Verify Race A is STILL the active engine race, STILL running, and STILL armed!
	liveA := e.RaceSnapshot()
	if liveA.RaceID != raceA.RaceID {
		t.Fatalf("expected active RaceSnapshot to remain Race A (%q), got %q", raceA.RaceID, liveA.RaceID)
	}
	if liveA.Lifecycle != domain.LifecycleActive {
		t.Fatalf("expected Race A lifecycle active, got %q", liveA.Lifecycle)
	}
	if !e.IsRaceArmed() {
		t.Fatalf("expected Race A to remain armed after editing Race B")
	}
	foundRunning := false
	for _, h := range liveA.Heats {
		if h.ID == runningHeatID && h.State == domain.HeatRunning {
			foundRunning = true
		}
	}
	if !foundRunning {
		t.Fatalf("expected Race A heat %q to still be in HeatRunning state", runningHeatID)
	}

	// Verify EventSnapshot holds BOTH Race A (running) and Race B (unified single-graph tournament)!
	evAfter := e.EventSnapshot()
	if evAfter.ActiveRaceID != raceA.RaceID {
		t.Fatalf("expected EventSnapshot.ActiveRaceID == %q, got %q", raceA.RaceID, evAfter.ActiveRaceID)
	}
	var savedB *domain.RaceTournamentState
	for i := range evAfter.Races {
		if evAfter.Races[i].RaceID == raceBID {
			savedB = &evAfter.Races[i]
		}
	}
	if savedB == nil || len(savedB.Stages) != 1 || len(savedB.Rounds) < 4 {
		t.Fatalf("expected saved Race B in EventSnapshot with unified single-graph rounds, got %+v", savedB)
	}
}
