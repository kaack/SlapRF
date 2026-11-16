package tracker

import (
	"fmt"
	"strings"
	"testing"

	"slaprf/internal/domain"
)

func setupEightPilotRaceEngine(t *testing.T, raceName string) *Engine {
	t.Helper()
	e := NewEngine()
	for {
		pilots, _, _, _, _ := e.StateSnapshot()
		if len(pilots) >= 8 {
			break
		}
		idx := len(pilots) + 1
		if err := e.AddPilot(fmt.Sprintf("Pilot%d", idx), ""); err != nil {
			t.Fatalf("AddPilot %d failed: %v", idx, err)
		}
	}
	if _, err := e.EventAction(EventActionPayload{
		Action: "create_race",
		Name:   raceName,
	}); err != nil {
		t.Fatalf("create_race failed: %v", err)
	}
	if _, err := e.EventAction(EventActionPayload{Action: "check_in_all"}); err != nil {
		t.Fatalf("check_in_all failed: %v", err)
	}
	cfg := e.RaceSnapshot().Config
	cfg.CountdownSec = 0
	cfg.PilotsPerHeat = 4
	cfg.QualifyingRounds = 1
	e.ConfigureAndGenerateRaceWithOptions(cfg, false, false)
	return e
}

func TestMultiStageMigrationAndFiveStageCapAndDAGValidation(t *testing.T) {
	e := setupEightPilotRaceEngine(t, "DAG Validation Open")

	// 1. Apply 2-stage preset -> verify automatic Stages (2) + StageConnections (1) metadata
	st, err := e.BracketEditAction(BracketEditPayload{
		Action:     "apply_template",
		TemplateID: "qual_double_elim",
	})
	if err != nil {
		t.Fatalf("apply_template qual_double_elim failed: %v", err)
	}
	if len(st.Stages) != 2 || len(st.StageConnections) != 1 {
		t.Fatalf("expected 2 stages and 1 stage connection, got stages=%d conns=%d", len(st.Stages), len(st.StageConnections))
	}
	if st.FormatInvalidReason != "" {
		t.Fatalf("expected valid 2-stage DAG, got FormatInvalidReason=%q", st.FormatInvalidReason)
	}

	// 2. Add Stage 3 disconnected -> verify Dangling=true and starting a heat in Stage 3 is blocked
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_stage",
		Title:       "Redemption Finals",
		StageFormat: domain.FormatSingleElimination,
	})
	if err != nil {
		t.Fatalf("add_stage 3 failed: %v", err)
	}
	if len(st.Stages) != 3 {
		t.Fatalf("expected 3 stages, got %d", len(st.Stages))
	}
	if !st.Stages[2].Dangling || st.FormatInvalidReason == "" {
		t.Fatalf("expected Stage 3 to be flagged Dangling with FormatInvalidReason, got dangling=%v reason=%q", st.Stages[2].Dangling, st.FormatInvalidReason)
	}
	var stage3HeatID string
	for _, h := range st.Heats {
		if h.StageIndex == 3 {
			stage3HeatID = h.ID
			break
		}
	}
	if stage3HeatID == "" {
		t.Fatalf("expected generated heats in Stage 3")
	}
	if _, err := e.RaceControlAction("start", stage3HeatID); err == nil {
		t.Fatalf("expected starting a heat in disconnected Dangling Stage 3 to be rejected")
	}

	// 3. Connect Stage 1 -> Stage 3 -> Dangling clears!
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "connect_stages",
		FromStageID: st.Stages[0].ID,
		ToStageID:   st.Stages[2].ID,
	})
	if err != nil {
		t.Fatalf("connect_stages 1->3 failed: %v", err)
	}
	if st.Stages[2].Dangling || st.FormatInvalidReason != "" {
		t.Fatalf("expected Stage 3 Dangling=false after connecting 1->3, got dangling=%v reason=%q", st.Stages[2].Dangling, st.FormatInvalidReason)
	}

	// 4. Connect Stage 2 -> Stage 1 (cycle!) -> persisted as Invalid=true with loop reason
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "connect_stages",
		FromStageID: st.Stages[1].ID,
		ToStageID:   st.Stages[0].ID,
	})
	if err != nil {
		t.Fatalf("connect_stages cycle call should persist invalid wire without error, got: %v", err)
	}
	lastWire := st.StageConnections[len(st.StageConnections)-1]
	if !lastWire.Invalid || !strings.Contains(strings.ToLower(lastWire.InvalidReason), "loop") {
		t.Fatalf("expected cycle wire to be Invalid with loop reason, got invalid=%v reason=%q", lastWire.Invalid, lastWire.InvalidReason)
	}
	// Clean up invalid wire
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:       "disconnect_stages",
		ConnectionID: lastWire.ID,
	})
	if err != nil {
		t.Fatalf("disconnect invalid wire failed: %v", err)
	}

	// 5. Add Stages 4 and 5 (connected), then verify 6th stage is rejected (5-stage cap)
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:         "add_stage",
		Title:          "Super Semis",
		StageFormat:    domain.FormatPointsMains,
		FromStageIndex: 2,
		LinkMode:       "top_n",
		AdvanceCount:   2,
	})
	if err != nil {
		t.Fatalf("add_stage 4 failed: %v", err)
	}
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:         "add_stage",
		Title:          "Grand Showdown",
		StageFormat:    domain.FormatChaseTheAce,
		FromStageIndex: 4,
		LinkMode:       "top_n",
		AdvanceCount:   4,
	})
	if err != nil {
		t.Fatalf("add_stage 5 failed: %v", err)
	}
	if len(st.Stages) != 5 {
		t.Fatalf("expected 5 stages, got %d", len(st.Stages))
	}
	if _, err := e.BracketEditAction(BracketEditPayload{
		Action:      "add_stage",
		Title:       "Too Many Stages",
		StageFormat: domain.FormatSingleElimination,
	}); err == nil {
		t.Fatalf("expected 6th stage to be rejected by 5-stage cap")
	}

	// 6. Remove Stage 3 and verify remaining stages compact cleanly to indices 1..4
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "remove_stage",
		StageIndex:  3,
	})
	if err != nil {
		t.Fatalf("remove_stage 3 failed: %v", err)
	}
	if len(st.Stages) != 4 {
		t.Fatalf("expected 4 stages after removal, got %d", len(st.Stages))
	}
	for i, s := range st.Stages {
		if s.Index != i+1 {
			t.Fatalf("expected compacted stage index %d, got %d", i+1, s.Index)
		}
	}
}

func TestMultiStageBranchingDAGDependencyGatingAndPauseSwitchResume(t *testing.T) {
	e := setupEightPilotRaceEngine(t, "Pro/Am Split Championship")

	// Start fresh from Stage 1 Qualifying (1 round of 2 heats for 8 pilots)
	if _, err := e.BracketEditAction(BracketEditPayload{
		Action:     "apply_template",
		TemplateID: "round_robin",
	}); err != nil {
		t.Fatalf("apply_template round_robin failed: %v", err)
	}
	cfg := e.RaceSnapshot().Config
	cfg.CountdownSec = 0
	cfg.QualifyingRounds = 1
	e.ConfigureAndGenerateRaceWithOptions(cfg, true, false)

	// Update Stage 1 to 1 Qualifying round
	st, err := e.BracketEditAction(BracketEditPayload{
		Action:           "update_stage_settings",
		StageIndex:       1,
		Title:            "Qualifier",
		QualifyingRounds: 1,
		PilotsPerHeat:    4,
		TimeLimitSec:     90,
	})
	if err != nil {
		t.Fatalf("update_stage_settings Stage 1 failed: %v", err)
	}

	// Add Stage 2: Championship Double Elim fed by Top 4 of Stage 1
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:         "add_stage",
		Title:          "Pro Bracket",
		StageFormat:    domain.FormatSingleElimination,
		FinalsFormat:   domain.FinalsSingle,
		TargetLaps:     3,
		FromStageIndex: 1,
		LinkMode:       "top_n",
		AdvanceCount:   4,
	})
	if err != nil {
		t.Fatalf("add_stage 2 failed: %v", err)
	}

	// Add Stage 3: Redemption Single Elim connected from Stage 1 with smart 2nd-branch inference -> Seeds #5-#8!
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:         "add_stage",
		Title:          "Redemption Bracket",
		StageFormat:    domain.FormatSingleElimination,
		FinalsFormat:   domain.FinalsSingle,
		TargetLaps:     5,
		FromStageIndex: 1,
	})
	if err != nil {
		t.Fatalf("add_stage 3 failed: %v", err)
	}
	if len(st.StageConnections) != 2 {
		t.Fatalf("expected 2 stage connections from Stage 1, got %d", len(st.StageConnections))
	}
	secondBranch := st.StageConnections[1]
	if secondBranch.Mode != "seed_range" || secondBranch.SeedStart != 5 || secondBranch.SeedEnd != 8 {
		t.Fatalf("expected smart 2nd branch to infer Seeds #5-#8, got mode=%q #%d-#%d", secondBranch.Mode, secondBranch.SeedStart, secondBranch.SeedEnd)
	}

	// Verify per-stage settings isolation: Stage 2 heats have 3 laps, Stage 3 heats have 5 laps
	for _, h := range st.Heats {
		if h.StageIndex == 2 && h.TargetLaps != 3 {
			t.Fatalf("expected Stage 2 heat %s to have 3 target laps, got %d", h.ID, h.TargetLaps)
		}
		if h.StageIndex == 3 && h.TargetLaps != 5 {
			t.Fatalf("expected Stage 3 heat %s to have 5 target laps, got %d", h.ID, h.TargetLaps)
		}
	}

	// Before Stage 1 completes, Stages 2 & 3 have PrerequisitesMet=false and cannot be activated or started
	if st.Stages[1].PrerequisitesMet || st.Stages[2].PrerequisitesMet {
		t.Fatalf("expected Stages 2 & 3 PrerequisitesMet=false while Stage 1 is incomplete")
	}
	if _, err := e.EventAction(EventActionPayload{
		Action:      "stage_control",
		StageAction: "activate_stage",
		StageIndex:  2,
	}); err == nil {
		t.Fatalf("expected activate_stage 2 to fail before Stage 1 completes")
	}

	// Complete all Stage 1 Qualifying heats with distinct manual laps so ranking 1..8 is deterministic
	for _, h := range st.Heats {
		if h.StageIndex != 1 {
			continue
		}
		if _, err := e.RaceControlAction("start", h.ID); err != nil {
			t.Fatalf("start %s failed: %v", h.ID, err)
		}
		cur := e.RaceSnapshot()
		for _, ch := range cur.Heats {
			if ch.ID != h.ID {
				continue
			}
			for _, seat := range ch.Seats {
				if seat.PilotSlotIndex <= 0 {
					continue
				}
				// Add 3 laps via marshal so consecutive_3 ranks pilots cleanly
				for lap := 0; lap < 3; lap++ {
					if _, err := e.MarshalPilotAction(RaceMarshalPayload{
						HeatID:         h.ID,
						PilotSlotIndex: seat.PilotSlotIndex,
						Action:         "add_lap",
					}); err != nil {
						t.Fatalf("add_lap failed: %v", err)
					}
				}
			}
		}
		if _, err := e.RaceControlAction("stop", h.ID); err != nil {
			t.Fatalf("stop %s failed: %v", h.ID, err)
		}
		if _, err := e.RaceControlAction("confirm", h.ID); err != nil {
			t.Fatalf("confirm %s failed: %v", h.ID, err)
		}
	}

	st = e.RaceSnapshot()
	if st.Stages[0].Status != domain.StageStatusCompleted {
		t.Fatalf("expected Stage 1 Completed, got %s", st.Stages[0].Status)
	}
	if !st.Stages[1].PrerequisitesMet || !st.Stages[2].PrerequisitesMet {
		t.Fatalf("expected both Stage 2 and Stage 3 PrerequisitesMet=true after Stage 1 completed")
	}

	// Verify Stage 2 & Stage 3 received disjoint pilot sets (4 pilots each, 0 overlap)
	s2Pilots := make(map[int]bool)
	s3Pilots := make(map[int]bool)
	var s2HeatID, s3HeatID string
	for _, h := range st.Heats {
		if h.StageIndex == 2 {
			if s2HeatID == "" {
				s2HeatID = h.ID
			}
			for _, s := range h.Seats {
				if s.PilotSlotIndex > 0 {
					s2Pilots[s.PilotSlotIndex] = true
				}
			}
		}
		if h.StageIndex == 3 {
			if s3HeatID == "" {
				s3HeatID = h.ID
			}
			for _, s := range h.Seats {
				if s.PilotSlotIndex > 0 {
					s3Pilots[s.PilotSlotIndex] = true
				}
			}
		}
	}
	if len(s2Pilots) != 4 || len(s3Pilots) != 4 {
		t.Fatalf("expected 4 seeded pilots in Stage 2 and 4 in Stage 3, got %d and %d", len(s2Pilots), len(s3Pilots))
	}
	for slot := range s2Pilots {
		if s3Pilots[slot] {
			t.Fatalf("pilot slot %d appeared in both Top 4 Pro Bracket and Seeds #5-#8 Redemption Bracket", slot)
		}
	}

	// Activate Stage 2, start its heat, then pause Stage 2 so we can switch to Stage 3!
	if _, err := e.EventAction(EventActionPayload{
		Action:      "stage_control",
		StageAction: "activate_stage",
		StageIndex:  2,
	}); err != nil {
		t.Fatalf("activate_stage 2 failed: %v", err)
	}
	if _, err := e.RaceControlAction("start", s2HeatID); err != nil {
		t.Fatalf("start Stage 2 heat %s failed: %v", s2HeatID, err)
	}
	// While Stage 2 heat is live (running), switching to Stage 3 must be blocked until paused!
	if _, err := e.EventAction(EventActionPayload{
		Action:      "stage_control",
		StageAction: "activate_stage",
		StageIndex:  3,
	}); err == nil {
		t.Fatalf("expected switching to Stage 3 while Stage 2 heat is live to be blocked until paused")
	}

	// Pause Stage 2 via stage_control -> pauses live heat & marks Stage 2 paused
	if _, err := e.EventAction(EventActionPayload{
		Action:      "stage_control",
		StageAction: "pause_stage",
		StageIndex:  2,
	}); err != nil {
		t.Fatalf("pause_stage 2 failed: %v", err)
	}
	st = e.RaceSnapshot()
	if st.Stages[1].Status != domain.StageStatusPaused {
		t.Fatalf("expected Stage 2 status=paused, got %s", st.Stages[1].Status)
	}

	// Switch to Stage 3, run & confirm Stage 3's heat -> Stage 3 completes while Stage 2 stays paused!
	if _, err := e.EventAction(EventActionPayload{
		Action:      "stage_control",
		StageAction: "activate_stage",
		StageIndex:  3,
	}); err != nil {
		t.Fatalf("activate_stage 3 failed: %v", err)
	}
	if _, err := e.RaceControlAction("start", s3HeatID); err != nil {
		t.Fatalf("start Stage 3 heat %s failed: %v", s3HeatID, err)
	}
	if _, err := e.RaceControlAction("stop", s3HeatID); err != nil {
		t.Fatalf("stop Stage 3 heat %s failed: %v", s3HeatID, err)
	}
	if _, err := e.RaceControlAction("confirm", s3HeatID); err != nil {
		t.Fatalf("confirm Stage 3 heat %s failed: %v", s3HeatID, err)
	}
	st = e.RaceSnapshot()
	if st.Stages[2].Status != domain.StageStatusCompleted {
		t.Fatalf("expected Stage 3 Completed, got %s", st.Stages[2].Status)
	}
	if st.Stages[1].Status != domain.StageStatusPaused {
		t.Fatalf("expected Stage 2 to remain Paused while Stage 3 ran, got %s", st.Stages[1].Status)
	}
	if st.IsComplete {
		t.Fatalf("expected overall tournament IsComplete=false while Stage 2 is still unfinished")
	}

	// Resume Stage 2, finish & confirm its paused heat -> entire multi-stage tournament completes!
	if _, err := e.EventAction(EventActionPayload{
		Action:      "stage_control",
		StageAction: "resume_stage",
		StageIndex:  2,
	}); err != nil {
		t.Fatalf("resume_stage 2 failed: %v", err)
	}
	if _, err := e.RaceControlAction("resume", s2HeatID); err != nil {
		t.Fatalf("resume Stage 2 heat %s failed: %v", s2HeatID, err)
	}
	if _, err := e.RaceControlAction("stop", s2HeatID); err != nil {
		t.Fatalf("stop Stage 2 heat %s failed: %v", s2HeatID, err)
	}
	st, err = e.RaceControlAction("confirm", s2HeatID)
	if err != nil {
		t.Fatalf("confirm Stage 2 heat %s failed: %v", s2HeatID, err)
	}
	if !st.IsComplete || st.Stages[1].Status != domain.StageStatusCompleted {
		t.Fatalf("expected tournament IsComplete=true and Stage 2 Completed, got isComplete=%v s2Status=%s", st.IsComplete, st.Stages[1].Status)
	}
}

func TestCustomStageEmptyAndWiredIntoMultiStageDAG(t *testing.T) {
	e := setupEightPilotRaceEngine(t, "Custom Stage Showcase")

	if _, err := e.BracketEditAction(BracketEditPayload{
		Action:     "apply_template",
		TemplateID: "round_robin",
	}); err != nil {
		t.Fatalf("apply_template failed: %v", err)
	}

	// Add an empty Custom Stage 2 connected from Stage 1 (Top 4)
	st, err := e.BracketEditAction(BracketEditPayload{
		Action:         "add_stage",
		Title:          "Bespoke Finals Stage",
		StageFormat:    domain.FormatCustom,
		FromStageIndex: 1,
		LinkMode:       "top_n",
		AdvanceCount:   4,
	})
	if err != nil {
		t.Fatalf("add_stage Custom failed: %v", err)
	}
	s2Heats := 0
	hasInPortal := false
	for _, h := range st.Heats {
		if h.StageIndex == 2 {
			s2Heats++
		}
	}
	for _, r := range st.Rounds {
		if r.StageIndex == 2 && r.ID == domain.StageHandoffInID(2) {
			hasInPortal = true
		}
	}
	if s2Heats != 0 || !hasInPortal {
		t.Fatalf("expected empty Custom Stage 2 to have 0 heats and Incoming Seeds portal, got heats=%d hasInPortal=%v", s2Heats, hasInPortal)
	}

	// Add first custom round inside Stage 2 -> auto-wires from Stage 2 Incoming Seeds!
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		StageIndex:  2,
		Title:       "Custom Semis",
		BracketLane: "winners",
	})
	if err != nil {
		t.Fatalf("add_round in Custom Stage 2 failed: %v", err)
	}
	if st.Stages[0].Customized {
		t.Fatalf("editing Stage 2 must NOT mark Stage 1 Customized")
	}
	if !st.Stages[1].Customized {
		t.Fatalf("expected Stage 2 Customized=true")
	}
	s2WiredFromPortal := false
	for _, c := range st.Connections {
		if c.StageIndex == 2 && c.FromRoundID == domain.StageHandoffInID(2) && c.Mode == "stage_seeds" && !c.Invalid {
			s2WiredFromPortal = true
		}
	}
	if !s2WiredFromPortal {
		t.Fatalf("expected first custom round in Stage 2 to auto-wire from Stage 2 Incoming Seeds portal")
	}
}

func TestQualifierInputBlockAndManualSeatClearRestoreAndSeedToPort(t *testing.T) {
	e := setupEightPilotRaceEngine(t, "Port & Seat Restore Test")

	st, err := e.BracketEditAction(BracketEditPayload{
		Action:     "apply_template",
		TemplateID: "qual_double_elim",
	})
	if err != nil {
		t.Fatalf("apply_template failed: %v", err)
	}

	// 1. Add a standalone Qualifying Stage 3 and verify Stage 1 -> Stage 3 (Qualifying) is flagged invalid (Qualifiers cannot accept incoming stages)
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_stage",
		Title:       "Extra Qualifier",
		StageFormat: domain.FormatQualifying,
	})
	if err != nil {
		t.Fatalf("add_stage Extra Qualifier failed: %v", err)
	}
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "connect_stages",
		FromStageID: st.Stages[0].ID,
		ToStageID:   st.Stages[2].ID,
	})
	if err != nil {
		t.Fatalf("connect_stages 1->3 failed: %v", err)
	}
	lastStgWire := st.StageConnections[len(st.StageConnections)-1]
	if !lastStgWire.Invalid || !strings.Contains(strings.ToLower(lastStgWire.InvalidReason), "qualifier") {
		t.Fatalf("expected wire into Qualifying stage to be Invalid, got invalid=%v reason=%q", lastStgWire.Invalid, lastStgWire.InvalidReason)
	}
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:       "disconnect_stages",
		ConnectionID: lastStgWire.ID,
	})
	if err != nil {
		t.Fatalf("disconnect invalid stage wire failed: %v", err)
	}

	// 2. Reconnect Checked-In Pilots wire on Stage 1 Round 1 to top port -> SeedToPort = "top"
	var s1R1ID string
	for _, r := range st.Rounds {
		if r.StageIndex == 1 && !domain.IsStageHandoffOutID(r.ID) && !domain.IsStageHandoffInID(r.ID) && r.ID != domain.StagePilotsInID(1) {
			s1R1ID = r.ID
			break
		}
	}
	if s1R1ID == "" {
		t.Fatalf("expected Stage 1 Round 1")
	}
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:       "reconnect_connection",
		ConnectionID: fmt.Sprintf("conn-%s-%s", domain.StagePilotsInID(1), s1R1ID),
		FromRoundID:  domain.StagePilotsInID(1),
		ToRoundID:    s1R1ID,
		FromPort:     "right",
		ToPort:       "top",
		LinkMode:     "pilots_in",
	})
	if err != nil {
		t.Fatalf("reconnect Checked-In Pilots to top port failed: %v", err)
	}
	for _, r := range st.Rounds {
		if r.ID == s1R1ID && r.SeedToPort != "top" {
			t.Fatalf("expected SeedToPort='top', got %q", r.SeedToPort)
		}
	}

	// 3. Manual seat override in Stage 2 feeder heat -> clear_seat restores incoming Seed #1 feeder!
	var s2HeatID string
	for _, h := range st.Heats {
		if h.StageIndex == 2 && len(h.Seats) > 0 && h.Seats[0].Feeder != nil && h.Seats[0].Feeder.FromStageSeed > 0 {
			s2HeatID = h.ID
			break
		}
	}
	if s2HeatID == "" {
		t.Fatalf("expected Stage 2 feeder heat")
	}
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:         "assign_pilot_seat",
		HeatID:         s2HeatID,
		SeatIndex:      1,
		PilotSlotIndex: st.Roster[0].SlotIndex,
	})
	if err != nil {
		t.Fatalf("assign_seat on Stage 2 feeder seat failed: %v", err)
	}
	for _, h := range st.Heats {
		if h.ID == s2HeatID {
			if !h.Seats[0].ManualLock || h.Seats[0].PilotSlotIndex == 0 {
				t.Fatalf("expected ManualLock=true and occupied seat after assign_seat")
			}
		}
	}
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:    "clear_seat",
		HeatID:    s2HeatID,
		SeatIndex: 1,
	})
	if err != nil {
		t.Fatalf("clear_seat on Stage 2 feeder seat failed: %v", err)
	}
	for _, h := range st.Heats {
		if h.ID == s2HeatID {
			if h.Seats[0].ManualLock || h.Seats[0].PilotSlotIndex != 0 || h.Seats[0].Feeder == nil || h.Seats[0].Feeder.FromStageSeed == 0 {
				t.Fatalf("expected clear_seat to undo ManualLock and restore Stage Seed feeder, got %+v", h.Seats[0])
			}
		}
	}
}
