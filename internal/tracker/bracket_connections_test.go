package tracker

import (
	"testing"

	"slaprf/internal/domain"
)

func TestBracketSubpixelMoveAndRedemptionMultiInputLane(t *testing.T) {
	e := NewEngine()

	// Start a custom race with Round 1 ("winners")
	st, err := e.BracketEditAction(BracketEditPayload{
		Action:   "start_custom",
		LinkMode: "all_active_pilots",
	})
	if err != nil {
		t.Fatalf("start_custom failed: %v", err)
	}
	if len(st.Rounds) != 1 {
		t.Fatalf("expected 1 initial round, got %d", len(st.Rounds))
	}
	upperR1 := st.Rounds[0].ID

	// Add Upper Round 2 ("winners"), Redemption 1 ("losers"), and Redemption 2 ("losers")
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		Title:       "Winners R2",
		BracketLane: "winners",
		StageFormat: domain.FormatSingleElimination,
		LinkMode:    "empty",
	})
	if err != nil {
		t.Fatalf("add Winners R2 failed: %v", err)
	}
	upperR2 := st.Rounds[len(st.Rounds)-1].ID

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		Title:       "Redemption 1",
		BracketLane: "losers",
		StageFormat: domain.FormatSingleElimination,
		LinkMode:    "empty",
	})
	if err != nil {
		t.Fatalf("add Redemption 1 failed: %v", err)
	}
	redemption1 := st.Rounds[len(st.Rounds)-1].ID

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		Title:       "Redemption 2",
		BracketLane: "losers",
		StageFormat: domain.FormatSingleElimination,
		LinkMode:    "empty",
	})
	if err != nil {
		t.Fatalf("add Redemption 2 failed: %v", err)
	}
	redemption2 := st.Rounds[len(st.Rounds)-1].ID

	// Connect Upper R1 -> Upper R2 (top_per_heat) and Upper R1 -> Redemption 1 (bottom_per_heat)
	if _, err := e.BracketEditAction(BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: upperR1,
		ToRoundID:   upperR2,
		LinkMode:    "top_per_heat",
	}); err != nil {
		t.Fatalf("connect upperR1->upperR2 failed: %v", err)
	}
	if _, err := e.BracketEditAction(BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: upperR1,
		ToRoundID:   redemption1,
		LinkMode:    "bottom_per_heat",
	}); err != nil {
		t.Fatalf("connect upperR1->redemption1 failed: %v", err)
	}

	// Connect Redemption 1 -> Redemption 2 (top_per_heat) AND Upper R2 -> Redemption 2 (bottom_per_heat)
	if _, err := e.BracketEditAction(BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: redemption1,
		ToRoundID:   redemption2,
		LinkMode:    "top_per_heat",
	}); err != nil {
		t.Fatalf("connect redemption1->redemption2 failed: %v", err)
	}
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: upperR2,
		ToRoundID:   redemption2,
		LinkMode:    "bottom_per_heat",
	})
	if err != nil {
		t.Fatalf("connect upperR2->redemption2 failed: %v", err)
	}

	// Redemption 2 must keep BracketLane == "losers" even with a mixed top_per_heat + bottom_per_heat input!
	var foundRedemption2 *domain.RaceRound
	for i := range st.Rounds {
		if st.Rounds[i].ID == redemption2 {
			foundRedemption2 = &st.Rounds[i]
			break
		}
	}
	if foundRedemption2 == nil {
		t.Fatalf("Redemption 2 round missing")
	}
	if foundRedemption2.BracketLane != "losers" {
		t.Fatalf("expected Redemption 2 BracketLane == 'losers', got %q", foundRedemption2.BracketLane)
	}

	// Sub-pixel move_rounds should persist exact continuous coordinates without grid snapping
	st, err = e.BracketEditAction(BracketEditPayload{
		Action: "move_rounds",
		Positions: []RoundPositionUpdate{
			{RoundID: upperR1, PosX: 137.4, PosY: 223.8},
		},
	})
	if err != nil {
		t.Fatalf("move_rounds failed: %v", err)
	}
	for _, r := range st.Rounds {
		if r.ID == upperR1 {
			if !r.HasPos || r.PosX != 137.4 || r.PosY != 223.8 {
				t.Fatalf("expected sub-pixel pos (137.4, 223.8), got hasPos=%v (%v, %v)", r.HasPos, r.PosX, r.PosY)
			}
		}
	}

	// reset_round_layout clears HasPos
	st, err = e.BracketEditAction(BracketEditPayload{Action: "reset_round_layout"})
	if err != nil {
		t.Fatalf("reset_round_layout failed: %v", err)
	}
	for _, r := range st.Rounds {
		if r.HasPos {
			t.Fatalf("expected HasPos=false after reset_round_layout on %s", r.ID)
		}
	}
}

func TestTwoStageHandoffPlaceholdersSlicesAndEarlySeeding(t *testing.T) {
	e := NewEngine()

	// 1. Start a 1-stage custom race, then enable Stage 2 dynamically
	st, err := e.BracketEditAction(BracketEditPayload{
		Action:   "start_custom",
		LinkMode: "all_active_pilots",
	})
	if err != nil {
		t.Fatalf("start_custom failed: %v", err)
	}
	if st.TotalStages != 1 {
		t.Fatalf("expected TotalStages == 1, got %d", st.TotalStages)
	}

	st, err = e.BracketEditAction(BracketEditPayload{Action: "enable_stage2"})
	if err != nil {
		t.Fatalf("enable_stage2 failed: %v", err)
	}
	if st.TotalStages != 2 || st.ActiveStageIndex != 1 {
		t.Fatalf("expected TotalStages=2 ActiveStageIndex=1, got %d/%d", st.ActiveStageIndex, st.TotalStages)
	}

	// Verify both handoff portal nodes exist
	hasOut, hasIn := false, false
	var s2InitialRnd string
	for _, r := range st.Rounds {
		if r.ID == domain.Stage1HandoffOutID && r.StageIndex == 1 {
			hasOut = true
		}
		if r.ID == domain.Stage2HandoffInID && r.StageIndex == 2 {
			hasIn = true
		}
		if r.StageIndex == 2 && r.ID != domain.Stage2HandoffInID {
			s2InitialRnd = r.ID
		}
	}
	if !hasOut || !hasIn || s2InitialRnd == "" {
		t.Fatalf("expected Stage1HandoffOut, Stage2HandoffIn, and initial Stage 2 round; got out=%v in=%v s2=%q", hasOut, hasIn, s2InitialRnd)
	}

	// 2. Configure Top 8 cutoff on Stage 2 Seeding + slice Stage 2 into A Main (Seeds #1-#4) and B Main (Seeds #5-#8)
	max8 := 8
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:           "update_stage_handoff",
		QualifyingMetric: domain.QualMetricBestLap,
		Stage2MaxSeeds:   &max8,
	})
	if err != nil {
		t.Fatalf("update_stage_handoff failed: %v", err)
	}
	if st.Config.Stage2MaxSeeds != 8 || st.Config.QualifyingMetric != domain.QualMetricBestLap {
		t.Fatalf("unexpected handoff config: maxSeeds=%d metric=%s", st.Config.Stage2MaxSeeds, st.Config.QualifyingMetric)
	}

	// Slice initial Stage 2 round to Seeds #1-#4 (A Main) and add B Main for Seeds #5-#8
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:       "update_connection",
		FromRoundID:  domain.Stage2HandoffInID,
		ToRoundID:    s2InitialRnd,
		LinkMode:     "stage_seeds",
		SeedStart:    1,
		SeedEnd:      4,
		Distribution: "sequential",
	})
	if err != nil {
		t.Fatalf("slice A Main failed: %v", err)
	}

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		StageIndex:  2,
		Title:       "B Main",
		BracketLane: "mains",
		StageFormat: domain.FormatPointsMains,
		LinkMode:    "empty",
	})
	if err != nil {
		t.Fatalf("add B Main failed: %v", err)
	}
	bMainID := st.Rounds[len(st.Rounds)-1].ID

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:       "connect_rounds",
		FromRoundID:  domain.Stage2HandoffInID,
		ToRoundID:    bMainID,
		LinkMode:     "stage_seeds",
		SeedStart:    5,
		SeedEnd:      8,
		Distribution: "sequential",
	})
	if err != nil {
		t.Fatalf("connect B Main failed: %v", err)
	}

	// Verify A Main has Seeds #1..#4 and B Main has Seeds #5..#8 placeholders
	var aSeeds, bSeeds []int
	for _, h := range st.Heats {
		if h.RoundID == s2InitialRnd {
			for _, s := range h.Seats {
				if s.Feeder != nil && s.Feeder.FromStageSeed > 0 {
					aSeeds = append(aSeeds, s.Feeder.FromStageSeed)
				}
			}
		}
		if h.RoundID == bMainID {
			for _, s := range h.Seats {
				if s.Feeder != nil && s.Feeder.FromStageSeed > 0 {
					bSeeds = append(bSeeds, s.Feeder.FromStageSeed)
				}
			}
		}
	}
	if len(aSeeds) != 4 || aSeeds[0] != 1 || aSeeds[3] != 4 {
		t.Fatalf("expected A Main seeds [1..4], got %v", aSeeds)
	}
	if len(bSeeds) != 4 || bSeeds[0] != 5 || bSeeds[3] != 8 {
		t.Fatalf("expected B Main seeds [5..8], got %v", bSeeds)
	}

	// 3. Remove Stage 2 cleanly while unstarted
	st, err = e.BracketEditAction(BracketEditPayload{Action: "remove_stage2"})
	if err != nil {
		t.Fatalf("remove_stage2 failed: %v", err)
	}
	if st.TotalStages != 1 {
		t.Fatalf("expected TotalStages == 1 after remove_stage2, got %d", st.TotalStages)
	}
}

func TestReconnectConnectionEndpointAndDoubleElimAlignment(t *testing.T) {
	e := NewEngine()
	if _, err := e.EventAction(EventActionPayload{Action: "create_race", Name: "Double Elim Test"}); err != nil {
		t.Fatalf("create_race failed: %v", err)
	}
	// Default engine has 8 active pilots; add 4 more -> 12 active pilots (16-bracket: W1..W3, L1..L4, Finals)
	for i := 1; i <= 4; i++ {
		_, err := e.EventAction(EventActionPayload{
			Action:   "add_race_pilot",
			Callsign: "Pilot" + string(rune('A'+i-1)),
		})
		if err != nil {
			t.Fatalf("add_race_pilot %d failed: %v", i, err)
		}
	}
	st, err := e.BracketEditAction(BracketEditPayload{
		Action:     "apply_template",
		TemplateID: "double_elimination",
	})
	if err != nil {
		t.Fatalf("apply double_elimination failed: %v", err)
	}

	colByTitle := make(map[string]int)
	idByTitle := make(map[string]string)
	for _, r := range st.Rounds {
		colByTitle[r.Title] = r.Column
		idByTitle[r.Title] = r.ID
	}
	// Verify W1 & L1 align at Col 1, W2 & L2 align at Col 2, W3 & L3 align at Col 3, L4 at Col 4, Finals at Col 5!
	if colByTitle["Winners R1"] != 1 || colByTitle["Redemption R1"] != 1 {
		t.Fatalf("expected W1 & L1 aligned at col 1, got %v", colByTitle)
	}
	if colByTitle["Winners R2"] != 2 || colByTitle["Redemption R2"] != 2 {
		t.Fatalf("expected W2 & L2 aligned at col 2, got %v", colByTitle)
	}
	if colByTitle["Winners R3"] != 3 || colByTitle["Redemption R3"] != 3 {
		t.Fatalf("expected W3 & L3 aligned at col 3, got %v", colByTitle)
	}
	if colByTitle["Redemption R4"] != 4 || colByTitle["Finals"] != 5 {
		t.Fatalf("expected L4 at col 4 and Finals at col 5, got %v", colByTitle)
	}

	// Create an invalid loop wire: Finals -> Winners R1
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: idByTitle["Finals"],
		ToRoundID:   idByTitle["Winners R1"],
	})
	if err != nil {
		t.Fatalf("connect_rounds loop returned unexpected error: %v", err)
	}
	badConn := st.Connections[len(st.Connections)-1]
	if !badConn.Invalid || badConn.InvalidReason == "" {
		t.Fatalf("expected Finals -> Winners R1 to be marked Invalid, got %+v", badConn)
	}

	// Add an unconnected Consolation round and drag the bad wire's target endpoint onto it via reconnect_connection!
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		Title:       "Consolation",
		BracketLane: "losers",
		StageFormat: domain.FormatSingleElimination,
		LinkMode:    "empty",
	})
	if err != nil {
		t.Fatalf("add Consolation round failed: %v", err)
	}
	consolationID := st.Rounds[len(st.Rounds)-1].ID

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:       "reconnect_connection",
		ConnectionID: badConn.ID,
		FromRoundID:  idByTitle["Finals"],
		ToRoundID:    consolationID,
		LinkMode:     "bottom_per_heat",
	})
	if err != nil {
		t.Fatalf("reconnect_connection failed: %v", err)
	}
	var fixed *domain.RoundConnection
	for i := range st.Connections {
		if st.Connections[i].ID == badConn.ID {
			fixed = &st.Connections[i]
			break
		}
	}
	if fixed == nil || fixed.Invalid || fixed.ToRoundID != consolationID {
		t.Fatalf("expected reconnected wire to be valid and pointing to Consolation, got %+v", fixed)
	}

	// Verify Winners R1 preserved SeedSource == "all_active_pilots" and all 4 seeded heats after detaching the invalid loop wire!
	w1Heats := 0
	w1SeededPilots := 0
	for _, r := range st.Rounds {
		if r.ID == idByTitle["Winners R1"] && r.SeedSource != "all_active_pilots" {
			t.Fatalf("expected Winners R1 SeedSource == 'all_active_pilots', got %q", r.SeedSource)
		}
	}
	for _, h := range st.Heats {
		if h.RoundID == idByTitle["Winners R1"] {
			w1Heats++
			for _, s := range h.Seats {
				if s.Callsign != "" {
					w1SeededPilots++
				}
			}
		}
	}
	if w1Heats != 4 || w1SeededPilots != 14 {
		t.Fatalf("expected Winners R1 to retain 4 heats and 14 seeded pilots, got %d heats / %d pilots", w1Heats, w1SeededPilots)
	}
}

func TestSmartConnectionInferenceAndAutoHeatExpansion(t *testing.T) {
	e := NewEngine()
	// Add 14 more pilots so we have 24 total pilots -> 6 heats of 4 in Round 1
	for i := 1; i <= 14; i++ {
		if _, err := e.EventAction(EventActionPayload{
			Action:   "add_race_pilot",
			Callsign: "ExtraPilot" + string(rune('A'+i-1)),
		}); err != nil {
			t.Fatalf("add_race_pilot %d failed: %v", i, err)
		}
	}
	st, err := e.BracketEditAction(BracketEditPayload{
		Action:   "start_custom",
		LinkMode: "all_active_pilots",
	})
	if err != nil {
		t.Fatalf("start_custom failed: %v", err)
	}
	r1 := st.Rounds[0].ID

	// Add Winners R2 with only 1 initial heat; connecting 6 heats -> 1 heat must infer Count=1 ("at least 1 pick/heat")
	// and automatically expand Winners R2 to 2 heats (6 feeders / 4 seats = ceil(1.5) = 2 heats)!
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		Title:       "Winners R2",
		BracketLane: "winners",
		HeatCount:   1,
		LinkMode:    "empty",
	})
	if err != nil {
		t.Fatalf("add Winners R2 failed: %v", err)
	}
	r2 := st.Rounds[len(st.Rounds)-1].ID

	// Connect with empty LinkMode and AdvanceCount=0 so smart inference picks mode + count!
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: r1,
		ToRoundID:   r2,
	})
	if err != nil {
		t.Fatalf("connect r1->r2 failed: %v", err)
	}
	conn := st.Connections[len(st.Connections)-1]
	if conn.Mode != "top_per_heat" || conn.Count != 1 {
		t.Fatalf("expected inferred top_per_heat Count=1 for 6->1 heats, got mode=%s count=%d", conn.Mode, conn.Count)
	}
	r2Heats := 0
	for _, h := range st.Heats {
		if h.RoundID == r2 {
			r2Heats++
		}
	}
	if r2Heats != 2 {
		t.Fatalf("expected Winners R2 to auto-expand to 2 heats for 6 feeders, got %d", r2Heats)
	}

	// Connecting Winners R1 -> Redemption R1 with empty LinkMode must infer bottom_per_heat!
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		Title:       "Redemption R1",
		BracketLane: "losers",
		HeatCount:   3,
		LinkMode:    "empty",
	})
	if err != nil {
		t.Fatalf("add Redemption R1 failed: %v", err)
	}
	red1 := st.Rounds[len(st.Rounds)-1].ID

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: r1,
		ToRoundID:   red1,
	})
	if err != nil {
		t.Fatalf("connect r1->red1 failed: %v", err)
	}
	dropConn := st.Connections[len(st.Connections)-1]
	if dropConn.Mode != "bottom_per_heat" || dropConn.Count != 2 {
		t.Fatalf("expected inferred bottom_per_heat Count=2 (6 heats -> 12 seats), got mode=%s count=%d", dropConn.Mode, dropConn.Count)
	}
}

func TestSingleFinalsRuleAndAllThreeFinalsWinnerFormats(t *testing.T) {
	e := NewEngine()
	st, err := e.BracketEditAction(BracketEditPayload{
		Action:   "start_custom",
		LinkMode: "all_active_pilots",
	})
	if err != nil {
		t.Fatalf("start_custom failed: %v", err)
	}
	// Default engine has 10 active pilots -> 3 heats in Round 1.
	// Add Semis Winners (1 heat) and Semis Redemption (1 heat), plus Finals!
	r1 := st.Rounds[0].ID

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		Title:       "Winners Final",
		BracketLane: "winners",
		HeatCount:   1,
		LinkMode:    "empty",
	})
	if err != nil {
		t.Fatalf("add Winners Final failed: %v", err)
	}
	wFinal := st.Rounds[len(st.Rounds)-1].ID

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		Title:       "Redemption Final",
		BracketLane: "losers",
		HeatCount:   1,
		LinkMode:    "empty",
	})
	if err != nil {
		t.Fatalf("add Redemption Final failed: %v", err)
	}
	lFinal := st.Rounds[len(st.Rounds)-1].ID

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:       "add_round",
		Title:        "Finals",
		BracketLane:  "finals",
		FinalsFormat: domain.FinalsChaseTheAce,
	})
	if err != nil {
		t.Fatalf("add Finals failed: %v", err)
	}
	finalsID := st.Rounds[len(st.Rounds)-1].ID

	// Adding a SECOND Finals round on the same unified graph is now supported (e.g. A-Main Finals + B-Main Finals)!
	st2, err := e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		Title:       "Second Finals",
		BracketLane: "finals",
	})
	if err != nil {
		t.Fatalf("expected adding a second Finals round to succeed, got: %v", err)
	}
	secondFinalsID := st2.Rounds[len(st2.Rounds)-1].ID
	if _, err := e.BracketEditAction(BracketEditPayload{
		Action:  "delete_round",
		RoundID: secondFinalsID,
	}); err != nil {
		t.Fatalf("delete Second Finals failed: %v", err)
	}

	// Connecting WFinal (1 heat) -> Finals (4 seats) first infers Top 3, then adding LFinal (1 heat) -> Finals
	// automatically rebalances both auto wires to Top 2 + Top 2 = 4 finalists!
	if _, err := e.BracketEditAction(BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: r1,
		ToRoundID:   wFinal,
	}); err != nil {
		t.Fatalf("connect r1->wFinal failed: %v", err)
	}
	if _, err := e.BracketEditAction(BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: r1,
		ToRoundID:   lFinal,
	}); err != nil {
		t.Fatalf("connect r1->lFinal failed: %v", err)
	}
	if _, err := e.BracketEditAction(BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: wFinal,
		ToRoundID:   finalsID,
	}); err != nil {
		t.Fatalf("connect wFinal->finals failed: %v", err)
	}
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: lFinal,
		ToRoundID:   finalsID,
	})
	if err != nil {
		t.Fatalf("connect lFinal->finals failed: %v", err)
	}

	for _, c := range st.Connections {
		if c.ToRoundID == finalsID {
			if c.Mode != "top_per_heat" || c.Count != 2 || c.Invalid {
				t.Fatalf("expected balanced Top 2 into Finals, got %+v", c)
			}
		}
	}

	// Switch Finals to Points Series (3 heats) -> verify GF-1, GF-2, GF-3 exist inside finalsID!
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:       "update_round",
		RoundID:      finalsID,
		BracketLane:  "finals",
		FinalsFormat: domain.FinalsPoints,
		FinalsHeats:  3,
	})
	if err != nil {
		t.Fatalf("update Finals to points_final failed: %v", err)
	}
	gfCount := 0
	for _, h := range st.Heats {
		if h.RoundID == finalsID {
			gfCount++
		}
	}
	if gfCount != 3 {
		t.Fatalf("expected 3 heats in Points Series Finals, got %d", gfCount)
	}
}

func TestPracticeAndRaceCoexistenceRestoresPracticeChannelsAfterHeat(t *testing.T) {
	e := NewEngine()
	// Set Practice pilot slot #0 to Fatshark 2 (BandFatshark, 2) so it differs distinctly from Raceband seat channels
	p0 := e.pilots[0]
	p0.Band = domain.BandFatshark
	p0.Channel = 2
	p0.Enabled = true
	e.UpdatePilotSlot(p0)

	// Create and generate a race WITHOUT calling SetOperatingMode(ModeRace)
	if _, err := e.EventAction(EventActionPayload{Action: "create_race", Name: "Coexistence Cup"}); err != nil {
		t.Fatalf("create_race failed: %v", err)
	}
	cfg := domain.DefaultRaceSetupConfig()
	cfg.CountdownSec = 0
	cfg.SeatChannels = []uint8{1, 3, 5, 8}
	st := e.ConfigureAndGenerateRace(cfg, true)
	if len(st.Heats) == 0 {
		t.Fatalf("expected generated heats")
	}

	// While race is merely generated/drafted (no heat running), Practice channels MUST remain untouched!
	if e.pilots[0].Band != domain.BandFatshark || e.pilots[0].Channel != 2 || !e.pilots[0].Enabled {
		t.Fatalf("expected Practice pilot slot 0 (F2) untouched while drafting race, got %+v", e.pilots[0])
	}

	// Start Heat 1 -> receiver channels lock to Heat 1's Raceband seat channels (R1, R3, R5, R8)
	heat1ID := st.NextReadyHeatID
	st, err := e.RaceControlAction("start", heat1ID)
	if err != nil {
		t.Fatalf("start heat 1 failed: %v", err)
	}
	seenF2DuringHeat := false
	seenR1DuringHeat := false
	for _, p := range e.pilots {
		if p.Enabled && p.Band == domain.BandFatshark && p.Channel == 2 {
			seenF2DuringHeat = true
		}
		if p.Enabled && p.Band == domain.BandRaceband && p.Channel == 1 {
			seenR1DuringHeat = true
		}
	}
	if seenF2DuringHeat || !seenR1DuringHeat {
		t.Fatalf("expected active heat seat channels (R1) tuned and Practice F2 disabled during heat, got seenF2=%v seenR1=%v", seenF2DuringHeat, seenR1DuringHeat)
	}

	// Stop Heat 1 -> Race is still ongoing (LifecycleActive), so Practice stays stopped and cannot start until race is paused/completed!
	if _, err := e.RaceControlAction("stop", heat1ID); err != nil {
		t.Fatalf("stop heat 1 failed: %v", err)
	}
	if e.practiceState.ActiveSessionID != "" {
		t.Fatalf("expected ActiveSessionID to remain empty while race is ongoing, got %q", e.practiceState.ActiveSessionID)
	}
	sessID := e.practiceState.Sessions[0].SessionID
	if _, err := e.PracticeAction(PracticeActionPayload{Action: "start_session", SessionID: sessID}); err == nil {
		t.Fatalf("expected start_session to be rejected while Coexistence Cup is ongoing")
	}

	// Pause Coexistence Cup -> Practice session can now start and restores F2!
	if _, err := e.EventAction(EventActionPayload{Action: "race_lifecycle", LifecycleAction: "pause_race"}); err != nil {
		t.Fatalf("pause_race failed: %v", err)
	}
	if _, err := e.PracticeAction(PracticeActionPayload{Action: "start_session", SessionID: sessID}); err != nil {
		t.Fatalf("start_session after pause_race failed: %v", err)
	}
	if e.pilots[0].Band != domain.BandFatshark || e.pilots[0].Channel != 2 || !e.pilots[0].Enabled {
		t.Fatalf("expected Practice pilot slot 0 (F2) restored when session restarted, got %+v", e.pilots[0])
	}
}

func TestPortPersistenceOnConnectAndReconnect(t *testing.T) {
	e := NewEngine()
	st, err := e.BracketEditAction(BracketEditPayload{
		Action:   "start_custom",
		LinkMode: "all_active_pilots",
	})
	if err != nil {
		t.Fatalf("start_custom failed: %v", err)
	}
	rA := st.Rounds[0].ID

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		Title:       "Finals",
		BracketLane: "grand_final",
		StageFormat: domain.FormatSingleElimination,
		LinkMode:    "empty",
	})
	if err != nil {
		t.Fatalf("add Finals failed: %v", err)
	}
	rF := st.Rounds[len(st.Rounds)-1].ID

	// Connect from Round A's bottom output port into Finals' top input port
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: rA,
		ToRoundID:   rF,
		FromPort:    "bottom",
		ToPort:      "top",
		LinkMode:    "top_per_heat",
	})
	if err != nil {
		t.Fatalf("connect_rounds with ports failed: %v", err)
	}
	if len(st.Connections) != 1 {
		t.Fatalf("expected 1 connection, got %d", len(st.Connections))
	}
	conn := st.Connections[0]
	if conn.FromPort != "bottom" || conn.ToPort != "top" {
		t.Fatalf("expected FromPort=bottom ToPort=top, got FromPort=%q ToPort=%q", conn.FromPort, conn.ToPort)
	}

	// Reconnect endpoint on the SAME round from "top" input port to "bottom" input port
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:       "reconnect_connection",
		ConnectionID: conn.ID,
		ToRoundID:    rF,
		ToPort:       "bottom",
	})
	if err != nil {
		t.Fatalf("reconnect_connection port switch failed: %v", err)
	}
	conn = st.Connections[0]
	if conn.FromPort != "bottom" || conn.ToPort != "bottom" {
		t.Fatalf("expected FromPort=bottom ToPort=bottom after port move, got FromPort=%q ToPort=%q", conn.FromPort, conn.ToPort)
	}
}

func TestRaceSettingsPropagateOnlyToUnstartedHeatsAndPreserveStage1(t *testing.T) {
	e := NewEngine()
	if _, err := e.EventAction(EventActionPayload{Action: "create_race", Name: "Mid-Race Edit Cup"}); err != nil {
		t.Fatalf("create_race failed: %v", err)
	}
	st, err := e.BracketEditAction(BracketEditPayload{
		Action:        "start_custom",
		LinkMode:      "all_active_pilots",
		PilotsPerHeat: 4,
		TargetLaps:    3,
		TimeLimitSec:  120,
	})
	if err != nil {
		t.Fatalf("start_custom failed: %v", err)
	}
	r1ID := st.Rounds[0].ID
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		Title:       "Finals",
		BracketLane: "finals",
		LinkMode:    "top_per_heat",
		FromRoundID: r1ID,
	})
	if err != nil {
		t.Fatalf("add Finals failed: %v", err)
	}

	// Start, stop, and confirm Heat 1 of Round 1 (3 laps, 4 seats)
	heat1ID := st.Heats[0].ID
	cfg := st.Config
	cfg.CountdownSec = 0
	st = e.ConfigureAndGenerateRaceWithOptions(cfg, false, false)
	if _, err := e.RaceControlAction("start", heat1ID); err != nil {
		t.Fatalf("start heat 1 failed: %v", err)
	}
	if _, err := e.RaceControlAction("stop", heat1ID); err != nil {
		t.Fatalf("stop heat 1 failed: %v", err)
	}
	st, err = e.RaceControlAction("confirm", heat1ID)
	if err != nil {
		t.Fatalf("confirm heat 1 failed: %v", err)
	}

	// 1) Save Race Settings with applyToExisting = FALSE -> existing unstarted heats stay at 4 seats / 3 laps
	cfgNoApply := st.Config
	cfgNoApply.PilotsPerHeat = 6
	cfgNoApply.SeatChannels = []uint8{1, 2, 4, 5, 7, 8}
	cfgNoApply.TargetLaps = 5
	cfgNoApply.TimeLimitSec = 180
	st = e.ConfigureAndGenerateRaceWithOptions(cfgNoApply, false, false)
	for _, h := range st.Heats {
		if len(h.Seats) != 4 || h.TargetLaps != 3 {
			t.Fatalf("expected existing heat %s untouched when applyToExisting=false, got seats=%d laps=%d", h.ID, len(h.Seats), h.TargetLaps)
		}
	}

	// Reset config to 4 seats / 3 laps first, then apply 6 seats / 5 laps with applyToExisting = TRUE
	cfgReset := st.Config
	cfgReset.PilotsPerHeat = 4
	cfgReset.SeatChannels = []uint8{1, 3, 5, 8}
	cfgReset.TargetLaps = 3
	cfgReset.TimeLimitSec = 120
	e.ConfigureAndGenerateRaceWithOptions(cfgReset, false, false)

	st = e.ConfigureAndGenerateRaceWithOptions(cfgNoApply, false, true)
	for _, h := range st.Heats {
		if h.ID == heat1ID {
			if h.State != domain.HeatConfirmed || len(h.Seats) != 4 || h.TargetLaps != 3 {
				t.Fatalf("confirmed heat %s must remain 4 seats / 3 laps, got state=%s seats=%d laps=%d", h.ID, h.State, len(h.Seats), h.TargetLaps)
			}
		} else {
			if len(h.Seats) != 6 {
				t.Fatalf("unstarted heat %s expected 6 seats after applyToExisting=true, got %d", h.ID, len(h.Seats))
			}
			if h.RoundID != r1ID && h.TargetLaps != 5 {
				t.Fatalf("unstarted round heat %s expected 5 target laps, got %d", h.ID, h.TargetLaps)
			}
		}
	}

	// 2) Pause ongoing Mid-Race Edit Cup first (at most 1 ongoing race at a time), then verify Two-Stage template re-application preserves confirmed Stage 1 Qualifying heats
	if _, err := e.EventAction(EventActionPayload{Action: "race_lifecycle", LifecycleAction: "pause_race"}); err != nil {
		t.Fatalf("pause Mid-Race Edit Cup failed: %v", err)
	}
	if _, err := e.EventAction(EventActionPayload{Action: "create_race", Name: "Two Stage Cup"}); err != nil {
		t.Fatalf("create_race 2 failed: %v", err)
	}
	st, err = e.BracketEditAction(BracketEditPayload{Action: "apply_template", TemplateID: "qual_double_elim"})
	if err != nil {
		t.Fatalf("apply qual_double_elim failed: %v", err)
	}
	qCfg := st.Config
	qCfg.CountdownSec = 0
	st = e.ConfigureAndGenerateRaceWithOptions(qCfg, false, false)
	qHeatID := st.NextReadyHeatID
	if _, err := e.RaceControlAction("start", qHeatID); err != nil {
		t.Fatalf("start qual heat failed: %v", err)
	}
	if _, err := e.RaceControlAction("stop", qHeatID); err != nil {
		t.Fatalf("stop qual heat failed: %v", err)
	}
	if _, err := e.RaceControlAction("confirm", qHeatID); err != nil {
		t.Fatalf("confirm qual heat failed: %v", err)
	}
	st, err = e.BracketEditAction(BracketEditPayload{Action: "apply_template", TemplateID: "qual_mains"})
	if err != nil {
		t.Fatalf("switch Stage 2 to qual_mains failed: %v", err)
	}
	foundConfirmedQ := false
	for _, h := range st.Heats {
		if h.ID == qHeatID && h.State == domain.HeatConfirmed {
			foundConfirmedQ = true
		}
	}
	if !foundConfirmedQ {
		t.Fatalf("expected confirmed Stage 1 heat %s preserved when re-templating Stage 2 to qual_mains", qHeatID)
	}
}

func TestConnectorSharedPortFidelityAndPositionFreezeOnDisconnect(t *testing.T) {
	e := NewEngine()

	// Create 3 rounds: R1, R2, and R3 (Redemption lane)
	st, err := e.BracketEditAction(BracketEditPayload{
		Action:   "start_custom",
		LinkMode: "all_active_pilots",
	})
	if err != nil {
		t.Fatalf("start_custom failed: %v", err)
	}
	r1 := st.Rounds[0].ID

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		Title:       "Upper B",
		BracketLane: "winners",
		StageFormat: domain.FormatSingleElimination,
		LinkMode:    "empty",
	})
	if err != nil {
		t.Fatalf("add Upper B failed: %v", err)
	}
	r2 := st.Rounds[len(st.Rounds)-1].ID

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		Title:       "Redemption Target",
		BracketLane: "losers",
		StageFormat: domain.FormatSingleElimination,
		LinkMode:    "empty",
	})
	if err != nil {
		t.Fatalf("add Redemption Target failed: %v", err)
	}
	r3 := st.Rounds[len(st.Rounds)-1].ID

	// Connect R1(bottom) -> R3(top) AND R2(right) -> R3(left), then reconnect R2's target onto R3(top) (already occupied!)
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: r1,
		ToRoundID:   r3,
		FromPort:    "bottom",
		ToPort:      "top",
		LinkMode:    "bottom_per_heat",
	})
	if err != nil {
		t.Fatalf("connect r1->r3 failed: %v", err)
	}
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: r2,
		ToRoundID:   r3,
		FromPort:    "right",
		ToPort:      "left",
		LinkMode:    "top_per_heat",
	})
	if err != nil {
		t.Fatalf("connect r2->r3 failed: %v", err)
	}

	var conn2ID string
	for _, c := range st.Connections {
		if c.FromRoundID == r2 && c.ToRoundID == r3 {
			conn2ID = c.ID
		}
	}
	if conn2ID == "" {
		t.Fatalf("missing r2->r3 connection")
	}

	// Reconnect conn2 onto the exact same ToPort ("top") already occupied by r1->r3!
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:       "reconnect_connection",
		ConnectionID: conn2ID,
		FromRoundID:  r2,
		ToRoundID:    r3,
		FromPort:     "right",
		ToPort:       "top",
		LinkMode:     "top_per_heat",
	})
	if err != nil {
		t.Fatalf("reconnect onto shared top port failed: %v", err)
	}
	sharedTopCount := 0
	for _, c := range st.Connections {
		if c.ToRoundID == r3 && c.ToPort == "top" {
			sharedTopCount++
		}
	}
	if sharedTopCount != 2 {
		t.Fatalf("expected both incoming wires on r3 to preserve ToPort=='top', got %d (%+v)", sharedTopCount, st.Connections)
	}

	// Freeze positions of all 3 rounds during disconnect_rounds and verify zero coordinate drift & BracketLane == "losers" preserved
	frozen := []RoundPositionUpdate{
		{RoundID: r1, PosX: 120.5, PosY: 88.0},
		{RoundID: r2, PosX: 120.5, PosY: 420.0},
		{RoundID: r3, PosX: 540.25, PosY: 660.75},
	}
	for _, c := range append([]domain.RoundConnection(nil), st.Connections...) {
		st, err = e.BracketEditAction(BracketEditPayload{
			Action:      "disconnect_rounds",
			FromRoundID: c.FromRoundID,
			ToRoundID:   c.ToRoundID,
			Positions:   frozen,
		})
		if err != nil {
			t.Fatalf("disconnect %s->%s failed: %v", c.FromRoundID, c.ToRoundID, err)
		}
	}

	posMap := map[string]domain.RaceRound{}
	for _, r := range st.Rounds {
		posMap[r.ID] = r
	}
	for _, exp := range frozen {
		got := posMap[exp.RoundID]
		if !got.HasPos || got.PosX != exp.PosX || got.PosY != exp.PosY {
			t.Fatalf("round %s drifted after disconnect: expected HasPos=true (%v,%v), got HasPos=%v (%v,%v)",
				exp.RoundID, exp.PosX, exp.PosY, got.HasPos, got.PosX, got.PosY)
		}
	}
	if posMap[r3].BracketLane != "losers" {
		t.Fatalf("expected Redemption Target to preserve BracketLane=='losers' after disconnecting all wires, got %q", posMap[r3].BracketLane)
	}
}

func TestWireDropAtomicSpawnAndConnectStagesAndRounds(t *testing.T) {
	e := NewEngine()
	for i := 0; i < 8; i++ {
		if i >= len(e.pilots) {
			_ = e.AddPilot("", "")
		}
		p := e.pilots[i]
		p.Enabled = true
		e.UpdatePilotSlot(p)
	}
	if _, err := e.EventAction(EventActionPayload{Action: "create_race", Name: "Wire Drop Cup"}); err != nil {
		t.Fatalf("create_race failed: %v", err)
	}

	// 1. Add Qualifier Stage 1, then wire-drop spawn Double Elimination Stage 2 connected from Stage 1
	st, err := e.BracketEditAction(BracketEditPayload{
		Action:      "add_stage",
		StageFormat: domain.FormatQualifying,
		HasPos:      true,
		PosX:        120,
		PosY:        180,
	})
	if err != nil || len(st.Stages) != 1 {
		t.Fatalf("add_stage 1 failed: %v", err)
	}
	stg1ID := st.Stages[0].ID

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_stage",
		StageFormat: domain.FormatDoubleElimination,
		FromStageID: stg1ID,
		FromPort:    "right",
		ToPort:      "left",
		HasPos:      true,
		PosX:        560,
		PosY:        195,
		StagePositions: []StagePositionUpdate{
			{StageID: stg1ID, PosX: 120, PosY: 180},
		},
	})
	if err != nil {
		t.Fatalf("wire-drop add_stage 2 failed: %v", err)
	}
	if len(st.Stages) != 2 || len(st.StageConnections) != 1 {
		t.Fatalf("expected 2 stages and 1 stage connection, got %d stages and %d connections", len(st.Stages), len(st.StageConnections))
	}
	if st.Stages[1].PosX != 560 || st.Stages[1].PosY != 195 {
		t.Fatalf("expected Stage 2 at (560, 195), got (%v, %v)", st.Stages[1].PosX, st.Stages[1].PosY)
	}
	if st.StageConnections[0].FromStageID != stg1ID || st.StageConnections[0].ToStageID != st.Stages[1].ID {
		t.Fatalf("unexpected stage connection: %+v", st.StageConnections[0])
	}

	// 2. Inside a blank Custom race, wire-drop from Checked-In Pilots (`stage1-pilots-in`) -> Qualifying Round,
	//    then wire-drop from Qualifying Round -> Race Round, then wire-drop from Race Round bottom port -> Redemption Round!
	if _, err := e.EventAction(EventActionPayload{Action: "create_race", Name: "Custom Wire Drop"}); err != nil {
		t.Fatalf("create_race 2 failed: %v", err)
	}
	st, err = e.BracketEditAction(BracketEditPayload{
		Action: "start_custom",
	})
	if err != nil {
		t.Fatalf("start_custom failed: %v", err)
	}

	pilotsPortalID := domain.StagePilotsInID(1)
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		StageIndex:  1,
		Title:       "Qualifying 1",
		BracketLane: "qualifying",
		StageFormat: domain.FormatQualifying,
		FromRoundID: pilotsPortalID,
		FromPort:    "right",
		ToPort:      "left",
		HasPos:      true,
		PosX:        440,
		PosY:        140,
	})
	if err != nil {
		t.Fatalf("wire-drop add_round from pilots_in failed: %v", err)
	}
	var qualRnd domain.RaceRound
	for _, r := range st.Rounds {
		if r.StageIndex == 1 && !domain.IsStagePortalRoundID(r.ID) {
			qualRnd = r
		}
	}
	if qualRnd.ID == "" || qualRnd.SeedSource != "all_active_pilots" || qualRnd.PosX != 440 || qualRnd.PosY != 140 {
		t.Fatalf("expected Qualifying 1 seeded by all_active_pilots at (440,140), got %+v", qualRnd)
	}

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		StageIndex:  1,
		Title:       "Round 2",
		BracketLane: "winners",
		StageFormat: domain.FormatSingleElimination,
		FromRoundID: qualRnd.ID,
		FromPort:    "right",
		ToPort:      "left",
		HasPos:      true,
		PosX:        840,
		PosY:        140,
	})
	if err != nil {
		t.Fatalf("wire-drop add_round from Qualifying 1 failed: %v", err)
	}
	var raceRnd domain.RaceRound
	for _, r := range st.Rounds {
		if r.StageIndex == 1 && !domain.IsStagePortalRoundID(r.ID) && r.ID != qualRnd.ID {
			raceRnd = r
		}
	}
	if raceRnd.ID == "" {
		t.Fatalf("expected Race Round to be created")
	}

	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		StageIndex:  1,
		Title:       "Redemption 1",
		BracketLane: "losers",
		StageFormat: domain.FormatSingleElimination,
		FromRoundID: raceRnd.ID,
		FromPort:    "bottom",
		ToPort:      "top",
		HasPos:      true,
		PosX:        840,
		PosY:        460,
	})
	if err != nil {
		t.Fatalf("wire-drop add_round from bottom port failed: %v", err)
	}
	foundBottomConn := false
	for _, c := range st.Connections {
		if c.FromRoundID == raceRnd.ID && c.FromPort == "bottom" && c.ToPort == "top" && c.Mode == "bottom_per_heat" && !c.Invalid {
			foundBottomConn = true
		}
	}
	if !foundBottomConn {
		t.Fatalf("expected valid bottom_per_heat connection from raceRnd bottom->top, got %+v", st.Connections)
	}
}


