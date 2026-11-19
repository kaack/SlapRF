package tracker

import (
	"testing"

	"slaprf/internal/domain"
)

func heatSeatCountsForRound(st domain.RaceTournamentState, roundID string) []int {
	var out []int
	for _, h := range st.Heats {
		if h.RoundID != roundID {
			continue
		}
		n := 0
		for _, s := range h.Seats {
			if s.PilotSlotIndex > 0 {
				n++
			}
		}
		out = append(out, n)
	}
	return out
}

func TestSourceRoundHeatsAlwaysEliminateSomeoneAndReadjustOnWireChange(t *testing.T) {
	e := NewEngine()
	// Default engine has 10 active pilots (4-up heats).
	st, err := e.BracketEditAction(BracketEditPayload{Action: "start_custom", LinkMode: "all_active_pilots"})
	if err != nil {
		t.Fatalf("start_custom failed: %v", err)
	}
	r1 := st.Rounds[0].ID

	st, err = e.BracketEditAction(BracketEditPayload{
		Action: "add_round", Title: "Winners R2", BracketLane: "winners", HeatCount: 1, LinkMode: "empty",
	})
	if err != nil {
		t.Fatalf("add Winners R2 failed: %v", err)
	}
	r2 := st.Rounds[len(st.Rounds)-1].ID

	st, err = e.BracketEditAction(BracketEditPayload{
		Action: "connect_rounds", FromRoundID: r1, ToRoundID: r2, LinkMode: "top_per_heat", AdvanceCount: 2,
	})
	if err != nil {
		t.Fatalf("connect r1->r2 failed: %v", err)
	}
	conn := st.Connections[len(st.Connections)-1]

	checkEliminates := func(label string) {
		t.Helper()
		for _, h := range st.Heats {
			if h.RoundID != r1 {
				continue
			}
			n := 0
			for _, s := range h.Seats {
				if s.PilotSlotIndex > 0 {
					n++
				}
			}
			if n >= 2 && h.ExpectedWinners >= n {
				t.Fatalf("%s: heat %s holds %d pilots but advances %d (nobody eliminated)", label, h.ID, n, h.ExpectedWinners)
			}
		}
	}
	t.Logf("top2: R1 sizes=%v", heatSeatCountsForRound(st, r1))
	checkEliminates("top 2")

	// Asking for Top 3 out of 3-4 pilot heats must never advance a whole heat.
	st, err = e.BracketEditAction(BracketEditPayload{
		Action: "update_connection", ConnectionID: conn.ID, AdvanceCount: 3,
	})
	if err != nil {
		t.Fatalf("update_connection top 3 failed: %v", err)
	}
	t.Logf("top3: R1 sizes=%v", heatSeatCountsForRound(st, r1))
	checkEliminates("top 3")

	// R2 only receives (size-1) per short heat: 3-pilot heats feed at most 2 pilots each.
	for _, h := range st.Heats {
		if h.RoundID != r2 {
			continue
		}
		perSource := map[string]int{}
		for _, s := range h.Seats {
			if s.Feeder != nil && !s.Feeder.IsBye && s.Feeder.FromHeatID != "" {
				perSource[s.Feeder.FromHeatID]++
			}
		}
		for src, cnt := range perSource {
			for _, sh := range st.Heats {
				if sh.ID != src {
					continue
				}
				n := 0
				for _, s := range sh.Seats {
					if s.PilotSlotIndex > 0 {
						n++
					}
				}
				if cnt >= n {
					t.Fatalf("heat %s feeds %d pilots into %s but only holds %d", src, cnt, h.ID, n)
				}
			}
		}
	}

	// Dynamic re-adjustment: ask for 5 heats of the 10 pilots while Top 2 advance. 5 heats would be
	// 2 pilots each (both advance, nobody eliminated), so the source round must stay at <= 3 heats.
	st, err = e.BracketEditAction(BracketEditPayload{
		Action: "update_connection", ConnectionID: conn.ID, AdvanceCount: 2,
	})
	if err != nil {
		t.Fatalf("update_connection top 2 failed: %v", err)
	}
	st, err = e.BracketEditAction(BracketEditPayload{Action: "update_round", RoundID: r1, HeatCount: 5})
	if err != nil {
		t.Fatalf("update_round heat count failed: %v", err)
	}
	sizes := heatSeatCountsForRound(st, r1)
	t.Logf("top2 + 5 heats requested: R1 sizes=%v", sizes)
	for _, n := range sizes {
		if n < 3 {
			t.Fatalf("Top 2 advancing needs at least 3 pilots per heat, got sizes %v", sizes)
		}
	}
	checkEliminates("top 2 with 5 heats requested")

	// Loosening the wire to Top 1 makes 5 heats of 2 valid again and the unstarted source round re-expands.
	st, err = e.BracketEditAction(BracketEditPayload{
		Action: "update_connection", ConnectionID: conn.ID, AdvanceCount: 1,
	})
	if err != nil {
		t.Fatalf("update_connection top 1 failed: %v", err)
	}
	sizes = heatSeatCountsForRound(st, r1)
	t.Logf("top1: R1 sizes=%v", sizes)
	if len(sizes) != 5 {
		t.Fatalf("expected the source round to re-expand to the requested 5 heats once Top 1 advances, got %v", sizes)
	}
	checkEliminates("top 1")

	// Partial source round re-adjustment: confirm Heat 1 of R1 (leaving 4 unstarted heats of 2 pilots = 8 remaining pilots),
	// then change wire back to Top 2 -> Heat 1 stays confirmed while the 4 uncompleted 2-pilot heats collapse into 2 heats of 4!
	firstHeatID := ""
	for i := range e.raceState.Heats {
		if e.raceState.Heats[i].RoundID == r1 {
			firstHeatID = e.raceState.Heats[i].ID
			e.raceState.Heats[i].State = domain.HeatConfirmed
			for si := range e.raceState.Heats[i].Seats {
				if e.raceState.Heats[i].Seats[si].PilotSlotIndex > 0 {
					e.raceState.Heats[i].Seats[si].Status = domain.PilotHeatFinished
					e.raceState.Heats[i].Seats[si].Position = si + 1
				}
			}
			break
		}
	}
	st, err = e.BracketEditAction(BracketEditPayload{
		Action: "update_connection", ConnectionID: conn.ID, AdvanceCount: 2,
	})
	if err != nil {
		t.Fatalf("update_connection top 2 on partial source round failed: %v", err)
	}
	confirmedSeen := 0
	var unstartedSizes []int
	for _, h := range st.Heats {
		if h.RoundID != r1 {
			continue
		}
		cnt := 0
		for _, s := range h.Seats {
			if s.PilotSlotIndex > 0 {
				cnt++
			}
		}
		if h.State == domain.HeatConfirmed {
			if h.ID != firstHeatID {
				t.Fatalf("unexpected confirmed heat %s (wanted %s)", h.ID, firstHeatID)
			}
			confirmedSeen++
		} else {
			unstartedSizes = append(unstartedSizes, cnt)
			if cnt < 3 {
				t.Fatalf("uncompleted heat %s in partial source round has only %d pilots under Top 2", h.ID, cnt)
			}
		}
	}
	if confirmedSeen != 1 || len(unstartedSizes) != 2 {
		t.Fatalf("expected 1 preserved confirmed heat + 2 re-balanced uncompleted heats [4, 4], got confirmed=%d unstarted=%v", confirmedSeen, unstartedSizes)
	}
}

func TestDynamicQualifyingRoundsAndOpenQualifierMaxHeatsPerPilot(t *testing.T) {
	e := NewEngine()
	// 1. Start a 2-stage Qualifying -> Double Elimination race (10 active pilots, 2 initial qualifying rounds)
	st, err := e.BracketEditAction(BracketEditPayload{
		Action:           "apply_template",
		TemplateID:       "qual_double_elim",
		QualifyingRounds: 2,
	})
	if err != nil {
		t.Fatalf("apply_template qual_double_elim failed: %v", err)
	}

	countQualRounds := func(s domain.RaceTournamentState) int {
		n := 0
		for _, r := range s.Rounds {
			if r.StageIndex == 1 && r.StageFormat == domain.FormatQualifying && !domain.IsStagePortalRoundID(r.ID) {
				n++
			}
		}
		return n
	}
	assertOneHeatPerPilotPerRound := func(s domain.RaceTournamentState, wantRounds int) {
		t.Helper()
		if got := countQualRounds(s); got != wantRounds {
			t.Fatalf("expected %d qualifying rounds, got %d", wantRounds, got)
		}
		for _, r := range s.Rounds {
			if r.StageIndex != 1 || r.StageFormat != domain.FormatQualifying || domain.IsStagePortalRoundID(r.ID) {
				continue
			}
			perPilot := map[int]int{}
			for _, h := range s.Heats {
				if h.RoundID != r.ID {
					continue
				}
				for _, seat := range h.Seats {
					if seat.PilotSlotIndex > 0 {
						perPilot[seat.PilotSlotIndex]++
					}
				}
			}
			if len(perPilot) != 10 {
				t.Fatalf("round %s: expected all 10 active pilots seated once, got %d distinct pilots", r.ID, len(perPilot))
			}
			for slot, cnt := range perPilot {
				if cnt != 1 {
					t.Fatalf("round %s: pilot %d seated %d times (expected 1)", r.ID, slot, cnt)
				}
			}
		}
	}

	assertOneHeatPerPilotPerRound(st, 2)

	// Mark Stage 1 customized AND confirm Q1-1 (so Round 1 is partially started), then expand QualifyingRounds 2 -> 4!
	e.mu.Lock()
	for i := range e.raceState.Stages {
		if e.raceState.Stages[i].Index == 1 {
			e.raceState.Stages[i].Customized = true
		}
	}
	for i := range e.raceState.Heats {
		if e.raceState.Heats[i].StageIndex == 1 && e.raceState.Heats[i].Round == 1 {
			e.raceState.Heats[i].State = domain.HeatConfirmed
			break
		}
	}
	e.mu.Unlock()

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:           "update_stage_settings",
		StageIndex:       1,
		QualifyingRounds: 4,
		ApplyToExisting:  true,
	})
	if err != nil {
		t.Fatalf("expand qualifying rounds 2->4 failed: %v", err)
	}
	assertOneHeatPerPilotPerRound(st, 4)

	// Shrink QualifyingRounds 4 -> 3 while Round 1 is started: Round 4 trims cleanly and Stage 1 handoff stays wired!
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:           "update_stage_settings",
		StageIndex:       1,
		QualifyingRounds: 3,
		ApplyToExisting:  true,
	})
	if err != nil {
		t.Fatalf("shrink qualifying rounds 4->3 failed: %v", err)
	}
	assertOneHeatPerPilotPerRound(st, 3)

	hasQualFeed := false
	for _, c := range st.Connections {
		if c.StageIndex == 1 && c.Mode == "standings_top" && c.FromRoundID != "" && !c.Invalid {
			hasQualFeed = true
		}
	}
	if !hasQualFeed {
		t.Fatalf("expected valid standings_top wire from final qualifying round into bracket after resizing rounds")
	}

	// 2. Open Qualifier: queue 3 rounds of packs with unlimited, then cap MaxPacksPerPilot = 2 -> trims excess queued seats!
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:     "apply_template",
		TemplateID: "open_qualifier",
	})
	if err != nil {
		t.Fatalf("apply_template open_qualifier failed: %v", err)
	}
	for pass := 0; pass < 3; pass++ {
		if _, err := e.BracketEditAction(BracketEditPayload{
			Action:     "open_qual_enqueue_all",
			StageIndex: 1,
		}); err != nil {
			t.Fatalf("open_qual_enqueue_all pass %d failed: %v", pass, err)
		}
	}
	capTwo := 2
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:           "update_stage_settings",
		StageIndex:       1,
		MaxPacksPerPilot: &capTwo,
		ApplyToExisting:  true,
	})
	if err != nil {
		t.Fatalf("set Open Qualifier maxPacksPerPilot=2 failed: %v", err)
	}
	perPilotOQ := map[int]int{}
	for _, h := range st.Heats {
		if h.StageIndex == 1 && h.State != domain.HeatAborted {
			for _, s := range h.Seats {
				if s.PilotSlotIndex > 0 {
					perPilotOQ[s.PilotSlotIndex]++
				}
			}
		}
	}
	for slot, cnt := range perPilotOQ {
		if cnt > 2 {
			t.Fatalf("Open Qualifier pilot %d still queued in %d heats after setting maxPacksPerPilot=2", slot, cnt)
		}
	}
}

func TestDeleteZippyQAndOpenQualifierRoundsWithoutRespawning(t *testing.T) {
	e := NewEngine()

	st, err := e.BracketEditAction(BracketEditPayload{
		Action:     "apply_template",
		TemplateID: "open_qualifier",
	})
	if err != nil {
		t.Fatalf("apply_template open_qualifier failed: %v", err)
	}

	// Add ZippyQ Round 2 onto the same stage (creates custom rnd-* open_qualifier round alongside stage1-open-qual)
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		StageIndex:  1,
		Title:       "ZippyQ Qualifier",
		StageFormat: domain.FormatOpenQualifier,
		BracketLane: "qualifying",
	})
	if err != nil {
		t.Fatalf("add ZippyQ Round 2 failed: %v", err)
	}

	var nonPortalIDs []string
	for _, r := range st.Rounds {
		if r.StageIndex == 1 && !domain.IsStagePortalRoundID(r.ID) {
			nonPortalIDs = append(nonPortalIDs, r.ID)
		}
	}
	if len(nonPortalIDs) != 2 {
		t.Fatalf("expected 2 ZippyQ rounds on Stage 1, got %v", nonPortalIDs)
	}

	// Delete both ZippyQ rounds one by one; neither should respawn
	for _, rid := range nonPortalIDs {
		st, err = e.BracketEditAction(BracketEditPayload{
			Action:  "delete_round",
			RoundID: rid,
		})
		if err != nil {
			t.Fatalf("delete_round(%s) failed: %v", rid, err)
		}
	}

	for _, r := range st.Rounds {
		if r.StageIndex == 1 && !domain.IsStagePortalRoundID(r.ID) {
			t.Fatalf("expected 0 non-portal rounds on Stage 1 after deleting all ZippyQ rounds, still found %s (%s)", r.ID, r.Title)
		}
	}

	// Adding an Open Qualifier round onto a Regular Qualifying stage and clicking maxPacksPerPilot pills (0, 2, 3)
	// must NEVER delete or trim the added Open Qualifier round!
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:     "apply_template",
		TemplateID: "qual_double_elim",
	})
	if err != nil {
		t.Fatalf("apply_template qual_double_elim failed: %v", err)
	}
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		StageIndex:  1,
		Title:       "Open Qualifier",
		StageFormat: domain.FormatOpenQualifier,
		BracketLane: "open_qual",
	})
	if err != nil {
		t.Fatalf("add Open Qualifier onto Qualifying stage failed: %v", err)
	}
	var addedOQID string
	for _, r := range st.Rounds {
		if r.StageIndex == 1 && r.StageFormat == domain.FormatOpenQualifier {
			addedOQID = r.ID
		}
	}
	if addedOQID == "" {
		t.Fatalf("expected added Open Qualifier round on Stage 1")
	}
	for _, mp := range []int{2, 3, 0} {
		val := mp
		st, err = e.BracketEditAction(BracketEditPayload{
			Action:           "update_stage_settings",
			StageIndex:       1,
			MaxPacksPerPilot: &val,
			ApplyToExisting:  true,
		})
		if err != nil {
			t.Fatalf("update_stage_settings maxPacksPerPilot=%d failed: %v", mp, err)
		}
		stillPresent := false
		for _, r := range st.Rounds {
			if r.ID == addedOQID {
				stillPresent = true
				break
			}
		}
		if !stillPresent {
			t.Fatalf("Open Qualifier round %s disappeared after setting maxPacksPerPilot=%d!", addedOQID, mp)
		}
	}
}

func TestDynamicStageClassificationFromRoundContents(t *testing.T) {
	e := NewEngine()

	st, err := e.BracketEditAction(BracketEditPayload{
		Action:     "apply_template",
		TemplateID: "round_robin",
	})
	if err != nil {
		t.Fatalf("apply_template qual_double_elim failed: %v", err)
	}
	if st.Stages[0].Format != domain.FormatQualifying {
		t.Fatalf("expected initial Stage 1 FormatQualifying, got %s", st.Stages[0].Format)
	}

	// 1. Delete all rounds in Stage 1 -> Stage 1 becomes Custom Stage 1
	var s1Rounds []string
	for _, r := range st.Rounds {
		if r.StageIndex == 1 && !domain.IsStagePortalRoundID(r.ID) {
			s1Rounds = append(s1Rounds, r.ID)
		}
	}
	for _, rid := range s1Rounds {
		st, err = e.BracketEditAction(BracketEditPayload{Action: "delete_round", RoundID: rid})
		if err != nil {
			t.Fatalf("delete_round %s failed: %v", rid, err)
		}
	}
	if st.Stages[0].Format != domain.FormatCustom || st.Stages[0].Title != "Custom Stage 1" {
		t.Fatalf("expected empty Stage 1 to become Custom Stage 1, got format=%s title=%q", st.Stages[0].Format, st.Stages[0].Title)
	}

	// 2. Add back 1 Regular Qualifier round -> Stage 1 becomes Qualifying again!
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		StageIndex:  1,
		Title:       "Qualifying 1",
		StageFormat: domain.FormatQualifying,
		BracketLane: "qualifying",
	})
	if err != nil {
		t.Fatalf("add Qualifying 1 failed: %v", err)
	}
	if st.Stages[0].Format != domain.FormatQualifying || st.Stages[0].Title != "Qualifying" || st.Stages[0].Settings.QualifyingRounds != 1 {
		t.Fatalf("expected Stage 1 to become Qualifying (1 round), got format=%s title=%q rounds=%d",
			st.Stages[0].Format, st.Stages[0].Title, st.Stages[0].Settings.QualifyingRounds)
	}

	// 3. Mix in a Winners race round -> Stage 1 becomes Custom Stage 1
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		StageIndex:  1,
		Title:       "Winners R1",
		StageFormat: domain.FormatSingleElimination,
		BracketLane: "winners",
	})
	if err != nil {
		t.Fatalf("add Winners R1 failed: %v", err)
	}
	if st.Stages[0].Format != domain.FormatCustom || st.Stages[0].Title != "Custom Stage 1" {
		t.Fatalf("expected mixed Stage 1 to become Custom Stage 1, got format=%s title=%q", st.Stages[0].Format, st.Stages[0].Title)
	}

	// 4. Clear Stage 1, then add 1 Open Qualifier -> Stage 1 becomes Open Qualifier
	s1Rounds = nil
	for _, r := range st.Rounds {
		if r.StageIndex == 1 && !domain.IsStagePortalRoundID(r.ID) {
			s1Rounds = append(s1Rounds, r.ID)
		}
	}
	for _, rid := range s1Rounds {
		st, _ = e.BracketEditAction(BracketEditPayload{Action: "delete_round", RoundID: rid})
	}
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		StageIndex:  1,
		Title:       "Open Qualifier",
		StageFormat: domain.FormatOpenQualifier,
		BracketLane: "open_qual",
	})
	if err != nil {
		t.Fatalf("add Open Qualifier failed: %v", err)
	}
	if st.Stages[0].Format != domain.FormatOpenQualifier || st.Stages[0].Title != "Open Qualifier" {
		t.Fatalf("expected Stage 1 to become Open Qualifier, got format=%s title=%q", st.Stages[0].Format, st.Stages[0].Title)
	}

	// 5. Delete Open Qualifier, then add 1 ZippyQ Qualifier -> Stage 1 becomes ZippyQ Qualifier
	for _, r := range st.Rounds {
		if r.StageIndex == 1 && !domain.IsStagePortalRoundID(r.ID) {
			st, _ = e.BracketEditAction(BracketEditPayload{Action: "delete_round", RoundID: r.ID})
		}
	}
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		StageIndex:  1,
		Title:       "ZippyQ Qualifier",
		StageFormat: domain.FormatOpenQualifier,
		BracketLane: "open_qual",
	})
	if err != nil {
		t.Fatalf("add ZippyQ Qualifier failed: %v", err)
	}
	if st.Stages[0].Format != domain.FormatOpenQualifier || st.Stages[0].Title != "ZippyQ Qualifier" {
		t.Fatalf("expected Stage 1 to become ZippyQ Qualifier, got format=%s title=%q", st.Stages[0].Format, st.Stages[0].Title)
	}
}




