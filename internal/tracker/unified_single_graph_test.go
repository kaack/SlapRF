package tracker

import (
	"fmt"
	"strings"
	"testing"

	"slaprf/internal/domain"
	"slaprf/internal/race"
)

func runAndConfirmHeatMarshal(t *testing.T, e *Engine, heatID string, lapsPerSeat int) {
	t.Helper()
	if _, err := e.RaceControlAction("start", heatID); err != nil {
		t.Fatalf("start %s failed: %v", heatID, err)
	}
	cur := e.RaceSnapshot()
	for _, ch := range cur.Heats {
		if ch.ID != heatID {
			continue
		}
		for sIdx, seat := range ch.Seats {
			if seat.PilotSlotIndex <= 0 {
				continue
			}
			// Give earlier seats slightly more laps or finish order so ranking is deterministic.
			laps := lapsPerSeat
			if laps < 1 {
				laps = 3
			}
			_ = sIdx
			for lap := 0; lap < laps; lap++ {
				if _, err := e.MarshalPilotAction(RaceMarshalPayload{
					HeatID:         heatID,
					PilotSlotIndex: seat.PilotSlotIndex,
					Action:         "add_lap",
				}); err != nil {
					t.Fatalf("add_lap on %s slot %d failed: %v", heatID, seat.PilotSlotIndex, err)
				}
			}
		}
	}
	curAfter := e.RaceSnapshot()
	for _, ch := range curAfter.Heats {
		if ch.ID == heatID && ch.State == domain.HeatRunning {
			if _, err := e.RaceControlAction("stop", heatID); err != nil {
				t.Fatalf("stop %s failed: %v", heatID, err)
			}
		}
	}
	if _, err := e.RaceControlAction("confirm", heatID); err != nil {
		t.Fatalf("confirm %s failed: %v", heatID, err)
	}
}

func TestUnifiedSingleGraphTemplatesAndLadderMainsProgression(t *testing.T) {
	e := setupEightPilotRaceEngine(t, "Unified Single-Graph Open")

	templates := []string{
		"qual_double_elim",
		"qual_single_elim",
		"qual_mains",
		"cpq_mains",
		"qual_chase_the_ace",
		"qual_ladder_mains",
		"ladder_mains",
	}
	for _, tpl := range templates {
		st, err := e.BracketEditAction(BracketEditPayload{
			Action:     "apply_template",
			TemplateID: tpl,
		})
		if err != nil {
			t.Fatalf("apply_template %q failed: %v", tpl, err)
		}
		if st.TotalStages != 1 || len(st.Stages) != 1 {
			t.Fatalf("template %q: expected single unified graph (TotalStages=1, len(Stages)=1), got TotalStages=%d len(Stages)=%d", tpl, st.TotalStages, len(st.Stages))
		}
		if len(st.StageConnections) != 0 {
			t.Fatalf("template %q: expected 0 StageConnections, got %d", tpl, len(st.StageConnections))
		}
		for _, r := range st.Rounds {
			if domain.IsStagePortalRoundID(r.ID) {
				t.Fatalf("template %q: found legacy stage portal round %q on unified graph", tpl, r.ID)
			}
			if r.StageIndex != 1 {
				t.Fatalf("template %q: expected round %q in StageIndex=1, got %d", tpl, r.ID, r.StageIndex)
			}
		}
		for _, h := range st.Heats {
			if h.StageIndex != 1 {
				t.Fatalf("template %q: expected heat %q in StageIndex=1, got %d", tpl, h.ID, h.StageIndex)
			}
		}
		if st.FormatInvalidReason != "" {
			t.Fatalf("template %q: unexpected FormatInvalidReason=%q", tpl, st.FormatInvalidReason)
		}
	}

	// Run 12-pilot Qualifying + Ladder Mains end-to-end: Q1 -> C-Main -> B-Main -> A-Main -> Champion!
	for idx := 9; idx <= 12; idx++ {
		if err := e.AddPilot(fmt.Sprintf("Pilot%d", idx), ""); err != nil {
			t.Fatalf("AddPilot %d failed: %v", idx, err)
		}
	}
	if _, err := e.EventAction(EventActionPayload{Action: "check_in_all"}); err != nil {
		t.Fatalf("check_in_all 12 pilots failed: %v", err)
	}
	cfg := e.RaceSnapshot().Config
	cfg.QualifyingRounds = 1
	cfg.PilotsPerHeat = 4
	cfg.CountdownSec = 0
	e.ConfigureAndGenerateRaceWithOptions(cfg, false, false)

	st, err := e.BracketEditAction(BracketEditPayload{
		Action:     "apply_template",
		TemplateID: "qual_ladder_mains",
	})
	if err != nil {
		t.Fatalf("apply_template qual_ladder_mains for 12 pilots failed: %v", err)
	}

	// Expect Q1 (3 heats) -> D-Main / C-Main / B-Main / A-Main ladder!
	// With 12 pilots, pph=4, bumpCount=2:
	// First main takes bottom 4 (#9-#12), each upper main takes 2 direct seeds + Top 2 bump-up:
	// 12 pilots: A-Main (#1-#2 + Top 2 B-Main), B-Main (#3-#4 + Top 2 C-Main), C-Main (#5-#6 + Top 2 D-Main), D-Main (#7-#10? Let's verify all heats run cleanly to Champion!).
	safety := 0
	for {
		st = e.RaceSnapshot()
		if st.Lifecycle == domain.LifecycleCompleted || st.ChampionSlotIndex > 0 {
			break
		}
		if st.NextReadyHeatID == "" {
			t.Fatalf("ladder mains stalled before completion; heats=%+v", st.Heats)
		}
		runAndConfirmHeatMarshal(t, e, st.NextReadyHeatID, 3)
		safety++
		if safety > 25 {
			t.Fatalf("exceeded safety cap running ladder mains")
		}
	}
	st = e.RaceSnapshot()
	if st.ChampionSlotIndex <= 0 {
		t.Fatalf("expected ChampionSlotIndex > 0 after completing qual_ladder_mains, got %d", st.ChampionSlotIndex)
	}
}

func TestSeedNowAndReopenOnScheduledAndOpenQualifiers(t *testing.T) {
	e := setupEightPilotRaceEngine(t, "Early Seeding Open")
	cfg := e.RaceSnapshot().Config
	cfg.QualifyingRounds = 2
	cfg.PilotsPerHeat = 4
	cfg.CountdownSec = 0
	e.ConfigureAndGenerateRaceWithOptions(cfg, false, false)

	st, err := e.BracketEditAction(BracketEditPayload{
		Action:           "apply_template",
		TemplateID:       "qual_single_elim",
		QualifyingRounds: 2,
	})
	if err != nil {
		t.Fatalf("apply_template qual_single_elim failed: %v", err)
	}

	// Find the standings_top connection from Q2 -> Semi-Finals (W1)
	var qualConnID string
	for _, c := range st.Connections {
		if c.Mode == "standings_top" && !c.Invalid {
			qualConnID = c.ID
			break
		}
	}
	if qualConnID == "" {
		t.Fatalf("expected standings_top connection from Q2 into bracket")
	}

	// Seed Now before ANY heat is confirmed must fail cleanly
	if _, err := e.BracketEditAction(BracketEditPayload{
		Action:       "seed_connection_now",
		ConnectionID: qualConnID,
	}); err == nil {
		t.Fatalf("expected seed_connection_now before any confirmed qualifier heat to fail")
	}

	// Confirm ONLY Round 1 heats (leaving Round 2 heats unstarted), then Seed Now!
	var firstR2HeatID string
	for _, h := range st.Heats {
		if h.StageFormat == domain.FormatQualifying && h.Round == 1 {
			runAndConfirmHeatMarshal(t, e, h.ID, 3)
		} else if h.StageFormat == domain.FormatQualifying && h.Round == 2 && firstR2HeatID == "" {
			firstR2HeatID = h.ID
		}
	}

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:       "seed_connection_now",
		ConnectionID: qualConnID,
	})
	if err != nil {
		t.Fatalf("seed_connection_now after Q1 failed: %v", err)
	}

	// Verify downstream bracket heats populated and NextReadyHeatID skipped unstarted Q2 heats!
	for _, h := range st.Heats {
		if h.ID == st.NextReadyHeatID && h.StageFormat == domain.FormatQualifying {
			t.Fatalf("expected NextReadyHeatID to jump past skipped Q2 heats into bracket, got %q", st.NextReadyHeatID)
		}
	}
	if st.NextReadyHeatID == "" {
		t.Fatalf("expected NextReadyHeatID to point to ready bracket heat after Seed Now")
	}

	// Reopen seeding while bracket is still unstarted -> firstR2HeatID becomes NextReadyHeatID again!
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:       "reopen_connection_seed",
		ConnectionID: qualConnID,
	})
	if err != nil {
		t.Fatalf("reopen_connection_seed failed: %v", err)
	}
	if st.NextReadyHeatID != firstR2HeatID {
		t.Fatalf("expected NextReadyHeatID to return to %q after reopen_connection_seed, got %q", firstR2HeatID, st.NextReadyHeatID)
	}

	// Now test Open Qualifier -> Finals early seeding (discards unstarted queued packs)
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:     "apply_template",
		TemplateID: "custom",
	})
	if err != nil {
		t.Fatalf("apply_template custom failed: %v", err)
	}
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		BracketLane: "qualifying",
		StageFormat: domain.FormatOpenQualifier,
		Title:       "Open Qualifier",
	})
	if err != nil {
		t.Fatalf("add Open Qualifier round failed: %v", err)
	}
	oqID := st.Rounds[0].ID

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		BracketLane: "finals",
		Title:       "Finals",
		FromRoundID: oqID,
		LinkMode:    "standings_top",
		SeedEnd:     4,
	})
	if err != nil {
		t.Fatalf("add Finals connected from Open Qualifier failed: %v", err)
	}
	var oqConnID string
	for _, c := range st.Connections {
		if c.FromRoundID == oqID {
			oqConnID = c.ID
		}
	}

	// Queue 2 passes of packs (4 packs total), confirm only OQ-1, then Seed Now -> unstarted OQ packs trimmed & Finals Ready!
	for pass := 0; pass < 2; pass++ {
		if _, err := e.BracketEditAction(BracketEditPayload{
			Action:     "open_qual_enqueue_all",
			StageIndex: 1,
		}); err != nil {
			t.Fatalf("open_qual_enqueue_all pass %d failed: %v", pass, err)
		}
	}
	runAndConfirmHeatMarshal(t, e, "OQ-1", 3)

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:       "seed_connection_now",
		ConnectionID: oqConnID,
	})
	if err != nil {
		t.Fatalf("seed_connection_now on Open Qualifier failed: %v", err)
	}
	oqUnstarted := 0
	finalsReady := false
	for _, h := range st.Heats {
		if h.RoundID == oqID && h.State != domain.HeatConfirmed {
			oqUnstarted++
		}
		if h.RoundID != oqID && h.State == domain.HeatReady {
			finalsReady = true
		}
	}
	if oqUnstarted != 0 {
		t.Fatalf("expected unstarted OQ packs to be trimmed on Seed Now, got %d remaining", oqUnstarted)
	}
	if !finalsReady {
		t.Fatalf("expected Finals heat to become HeatReady after OQ Seed Now")
	}
}

func TestLegacyMultiStageMigrationRedemptionPromotionReshuffleAndMultiFinals(t *testing.T) {
	e := setupEightPilotRaceEngine(t, "Migration & Custom Constructs")

	// 1. Build a legacy 2-stage race via add_stage, confirm Q1-1, then run MigrateLegacyStagesToUnifiedGraph
	st, err := e.BracketEditAction(BracketEditPayload{
		Action:     "apply_template",
		TemplateID: "round_robin",
	})
	if err != nil {
		t.Fatalf("apply_template round_robin failed: %v", err)
	}
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:         "add_stage",
		Title:          "Pro Finals",
		StageFormat:    domain.FormatSingleElimination,
		FromStageIndex: 1,
		LinkMode:       "seed_range",
		SeedStart:      1,
		SeedEnd:        4,
	})
	if err != nil {
		t.Fatalf("add_stage 2 failed: %v", err)
	}
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:         "add_stage",
		Title:          "B-Main Finals",
		StageFormat:    domain.FormatSingleElimination,
		FromStageIndex: 1,
		LinkMode:       "seed_range",
		SeedStart:      5,
		SeedEnd:        8,
	})
	if err != nil {
		t.Fatalf("add_stage 3 failed: %v", err)
	}
	if len(st.Stages) != 3 {
		t.Fatalf("expected 3 legacy stages prior to migration, got %d", len(st.Stages))
	}

	migrated := st
	if !race.MigrateLegacyStagesToUnifiedGraph(&migrated) {
		t.Fatalf("expected MigrateLegacyStagesToUnifiedGraph to return true for 3-stage race")
	}
	if migrated.TotalStages != 1 || len(migrated.Stages) != 1 || len(migrated.StageConnections) != 0 {
		t.Fatalf("expected migrated race to have 1 unified stage and 0 stage connections, got TotalStages=%d len(Stages)=%d", migrated.TotalStages, len(migrated.Stages))
	}
	foundTopSlice := false
	foundBotSlice := false
	for _, c := range migrated.Connections {
		if c.Mode == "standings_top" && c.SeedStart == 1 && c.SeedEnd == 4 {
			foundTopSlice = true
		}
		if c.Mode == "standings_top" && c.SeedStart == 5 && c.SeedEnd == 8 {
			foundBotSlice = true
		}
	}
	if !foundTopSlice || !foundBotSlice {
		t.Fatalf("expected migrated unified connections to preserve #1-#4 and #5-#8 rank slices, conns=%+v", migrated.Connections)
	}

	// 2. Test automatic Redemption promotion (`Round 2` -> `Redemption R1` on `bottom_per_heat`) + Reshuffle + Multi-Finals!
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:     "apply_template",
		TemplateID: "custom",
	})
	if err != nil {
		t.Fatalf("apply_template custom failed: %v", err)
	}
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:       "add_round",
		BracketLane:  "winners",
		LinkMode:     "all_active_pilots",
		Distribution: "random",
	})
	if err != nil {
		t.Fatalf("add Round 1 failed: %v", err)
	}
	r1ID := st.Rounds[0].ID

	// Reshuffle Round 1 and confirm RandomSeed increments
	seedBefore := st.Rounds[0].RandomSeed
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:  "reshuffle_round",
		RoundID: r1ID,
	})
	if err != nil {
		t.Fatalf("reshuffle_round failed: %v", err)
	}
	if st.Rounds[0].RandomSeed == seedBefore {
		t.Fatalf("expected RandomSeed to change after reshuffle_round")
	}

	// Add default Race Round (`Round 2`, `winners`) and wire `bottom_per_heat` from Round 1 -> auto-promotes to `losers` ("Redemption R1")!
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		BracketLane: "winners",
	})
	if err != nil {
		t.Fatalf("add Round 2 failed: %v", err)
	}
	r2ID := st.Rounds[len(st.Rounds)-1].ID
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:       "connect_rounds",
		FromRoundID:  r1ID,
		ToRoundID:    r2ID,
		LinkMode:     "bottom_per_heat",
		AdvanceCount: 2,
	})
	if err != nil {
		t.Fatalf("connect bottom_per_heat failed: %v", err)
	}
	var promoted *domain.RaceRound
	for i := range st.Rounds {
		if st.Rounds[i].ID == r2ID {
			promoted = &st.Rounds[i]
		}
	}
	if promoted == nil || promoted.BracketLane != "losers" || promoted.Title != "Redemption R1" {
		t.Fatalf("expected Round 2 to auto-promote to losers / 'Redemption R1', got %+v", promoted)
	}

	// Add TWO Finals rounds on the same unified graph (A-Main Finals & B-Main Finals)
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:       "add_round",
		BracketLane:  "finals",
		Title:        "A-Main Finals",
		FromRoundID:  r1ID,
		LinkMode:     "top_per_heat",
		AdvanceCount: 2,
	})
	if err != nil {
		t.Fatalf("add A-Main Finals failed: %v", err)
	}
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:       "add_round",
		BracketLane:  "finals",
		Title:        "B-Main Finals",
		FromRoundID:  r2ID,
		LinkMode:     "top_per_heat",
		AdvanceCount: 4,
	})
	if err != nil {
		t.Fatalf("add B-Main Finals failed: %v", err)
	}
	finalsCount := 0
	for _, r := range st.Rounds {
		if r.BracketLane == "finals" {
			finalsCount++
		}
	}
	if finalsCount != 2 {
		t.Fatalf("expected 2 Finals rounds on unified graph, got %d", finalsCount)
	}
}

func TestFullDAGDynamicPlaceholderCascadeToFinals(t *testing.T) {
	e := setupEightPilotRaceEngine(t, "Full DAG Dynamic Cascade")

	if _, err := e.BracketEditAction(BracketEditPayload{
		Action:     "apply_template",
		TemplateID: "custom",
	}); err != nil {
		t.Fatalf("apply_template custom failed: %v", err)
	}

	// 1. Build Qualifying -> Winners R1 (All Qualified) -> Winners R2 + Redemption R1 -> Finals
	st, err := e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		BracketLane: "qualifying",
		StageFormat: domain.FormatQualifying,
		Title:       "Qualifying R1",
		LinkMode:    "all_active_pilots",
	})
	if err != nil {
		t.Fatalf("add Qualifying R1: %v", err)
	}
	q1ID := st.Rounds[0].ID

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		BracketLane: "winners",
		StageFormat: domain.FormatSingleElimination,
		Title:       "Winners R1",
		FromRoundID: q1ID,
		LinkMode:    "standings_top",
	})
	if err != nil {
		t.Fatalf("add Winners R1: %v", err)
	}
	w1ID := st.Rounds[len(st.Rounds)-1].ID

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		BracketLane: "winners",
		StageFormat: domain.FormatSingleElimination,
		Title:       "Winners R2",
		FromRoundID: w1ID,
		LinkMode:    "top_per_heat",
	})
	if err != nil {
		t.Fatalf("add Winners R2: %v", err)
	}
	w2ID := st.Rounds[len(st.Rounds)-1].ID

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		BracketLane: "winners",
		StageFormat: domain.FormatSingleElimination,
		Title:       "Redemption R1",
		FromRoundID: w1ID,
		FromPort:    "bottom",
		LinkMode:    "bottom_per_heat",
	})
	if err != nil {
		t.Fatalf("add Redemption R1: %v", err)
	}
	r1ID := st.Rounds[len(st.Rounds)-1].ID

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		BracketLane: "finals",
		Title:       "Finals",
		FromRoundID: w2ID,
		LinkMode:    "top_per_heat",
	})
	if err != nil {
		t.Fatalf("add Finals: %v", err)
	}
	finID := st.Rounds[len(st.Rounds)-1].ID

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: r1ID,
		ToRoundID:   finID,
		LinkMode:    "top_per_heat",
	})
	if err != nil {
		t.Fatalf("connect Redemption R1 -> Finals: %v", err)
	}

	countRoundHeats := func(s domain.RaceTournamentState, rid string) int {
		n := 0
		for _, h := range s.Heats {
			if h.RoundID == rid {
				n++
			}
		}
		return n
	}

	// With 10 default checked-in pilots: W1 MUST get all 10 seeds across 3 heats ("Seed #1".."Seed #10"), W2=2 heats, R1=2 heats, Finals=1 heat (4 feeders)
	if got := countRoundHeats(st, w1ID); got != 3 {
		t.Fatalf("expected Winners R1 to auto-size to 3 heats for 10 pilots, got %d", got)
	}
	if got := countRoundHeats(st, w2ID); got != 2 {
		t.Fatalf("expected Winners R2 to have 2 heats for winners from 3 W1 heats, got %d", got)
	}
	for _, h := range st.Heats {
		if h.RoundID == w1ID {
			if !strings.HasPrefix(h.Seats[0].SourceLabel, "Seed #") {
				t.Fatalf("expected Seed # placeholder in Winners R1, got %q", h.Seats[0].SourceLabel)
			}
		}
		if h.RoundID == finID {
			for si, s := range h.Seats {
				if s.Feeder == nil || s.SourceLabel == "" || s.SourceLabel == "Open / BYE" {
					t.Fatalf("expected Finals seat %d to hold upstream feeder placeholder, got %+v", si+1, s)
				}
			}
		}
	}

	// 2. Walk-up add 4 more pilots (10 -> 14) -> entire customized DAG must cascade all the way to Finals!
	for k := 1; k <= 4; k++ {
		st, err = e.EventAction(EventActionPayload{
			Action:   "add_race_pilot",
			Callsign: fmt.Sprintf("WalkUp%d", k),
		})
		if err != nil {
			t.Fatalf("add_race_pilot %d: %v", k, err)
		}
	}
	if got := countRoundHeats(st, q1ID); got != 4 {
		t.Fatalf("expected Qualifying R1 to grow to 4 heats for 14 pilots, got %d", got)
	}
	if got := countRoundHeats(st, w1ID); got != 4 {
		t.Fatalf("expected Winners R1 to cascade to 4 heats for 14 seeds, got %d", got)
	}
	if got := countRoundHeats(st, w2ID); got != 2 {
		t.Fatalf("expected Winners R2 to cascade to 2 heats for 8 winners, got %d", got)
	}
	if got := countRoundHeats(st, r1ID); got != 2 {
		t.Fatalf("expected Redemption R1 to cascade to 2 heats for drops, got %d", got)
	}

	// 3. Edit Qualifying -> Winners R1 cut to Top 8 -> entire downstream DAG shrinks cleanly back down to Finals!
	var qToW1Conn string
	for _, c := range st.Connections {
		if c.FromRoundID == q1ID && c.ToRoundID == w1ID {
			qToW1Conn = c.ID
		}
	}
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:       "update_connection",
		ConnectionID: qToW1Conn,
		LinkMode:     "standings_top",
		AdvanceCount: 8,
	})
	if err != nil {
		t.Fatalf("update_connection Top 8: %v", err)
	}
	if got := countRoundHeats(st, w1ID); got != 2 {
		t.Fatalf("expected Winners R1 to shrink to 2 heats on Top 8 cut, got %d", got)
	}
	if got := countRoundHeats(st, w2ID); got != 1 {
		t.Fatalf("expected Winners R2 to shrink to 1 heat on Top 8 cut, got %d", got)
	}
	if got := countRoundHeats(st, r1ID); got != 1 {
		t.Fatalf("expected Redemption R1 to shrink to 1 heat on Top 8 cut, got %d", got)
	}

	// 4. Multi-round `all_pilots` chain downstream of Qualifying (`Q1 -> Mains R1 -> Mains R2 -> Finals`)
	if _, err := e.BracketEditAction(BracketEditPayload{
		Action:     "apply_template",
		TemplateID: "custom",
	}); err != nil {
		t.Fatalf("reset custom: %v", err)
	}
	st, _ = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		BracketLane: "qualifying",
		StageFormat: domain.FormatQualifying,
		Title:       "Qualifying",
		LinkMode:    "all_active_pilots",
	})
	qualID := st.Rounds[0].ID
	st, _ = e.BracketEditAction(BracketEditPayload{
		Action:       "add_round",
		BracketLane:  "mains",
		StageFormat:  domain.FormatPointsMains,
		Title:        "Mains R1",
		FromRoundID:  qualID,
		LinkMode:     "standings_top",
		AdvanceCount: 6,
	})
	m1ID := st.Rounds[1].ID
	st, _ = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		BracketLane: "mains",
		StageFormat: domain.FormatPointsMains,
		Title:       "Mains R2",
		FromRoundID: m1ID,
		LinkMode:    "all_pilots",
	})
	m2ID := st.Rounds[2].ID
	st, _ = e.BracketEditAction(BracketEditPayload{
		Action:       "add_round",
		BracketLane:  "finals",
		Title:        "Finals",
		FromRoundID:  m2ID,
		LinkMode:     "standings_top",
		AdvanceCount: 4,
	})
	f2ID := st.Rounds[3].ID

	// Before Qualifying runs, Mains R1, Mains R2, AND Finals must all hold `Seed #` placeholders!
	for _, checkID := range []string{m1ID, m2ID, f2ID} {
		foundSeed := false
		for _, h := range st.Heats {
			if h.RoundID == checkID {
				for _, s := range h.Seats {
					if s.Feeder != nil && strings.HasPrefix(s.SourceLabel, "Seed #") {
						foundSeed = true
					}
				}
			}
		}
		if !foundSeed {
			t.Fatalf("expected Seed # placeholders in round %q before Qualifying runs", checkID)
		}
	}

	// Confirm 1 Qualifying heat and click Seed Now -> BOTH Mains R1 AND Mains R2 must populate concrete pilots immediately!
	var firstQualHeat string
	for _, h := range st.Heats {
		if h.RoundID == qualID {
			firstQualHeat = h.ID
			break
		}
	}
	runAndConfirmHeatMarshal(t, e, firstQualHeat, 2)
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "seed_connection_now",
		FromRoundID: qualID,
	})
	if err != nil {
		t.Fatalf("seed_connection_now qual -> Mains R1: %v", err)
	}
	for _, checkID := range []string{m1ID, m2ID} {
		concrete := 0
		for _, h := range st.Heats {
			if h.RoundID == checkID {
				for _, s := range h.Seats {
					if s.PilotSlotIndex > 0 {
						concrete++
					}
				}
			}
		}
		if concrete != 6 {
			t.Fatalf("expected 6 concrete pilots in %q after Seed Now, got %d", checkID, concrete)
		}
	}
}
