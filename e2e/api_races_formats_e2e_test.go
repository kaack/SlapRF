//go:build e2e

package e2e_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"slaprf/internal/api"
	"slaprf/internal/domain"
)

// apiPrepareRaceWithCheckedInPilots creates a fresh race, checks in exactly `pilotCount` pilots
// (marking the rest absent), navigates the live browser view to the race so `video.webm` captures
// every bracket/control mutation on screen, and returns the created race's ID and slug.
func apiPrepareRaceWithCheckedInPilots(h *Harness, name string, pilotCount int, subTab string) (string, string, []int) {
	h.T.Helper()

	var st api.FullStateResponse
	h.APIPost("/api/events/action", map[string]any{
		"action": "create_race",
		"name":   name,
		"tags":   []string{"API-E2E", "Automated"},
	}, &st)

	raceID := st.RaceState.RaceID
	slug := domain.SlugifyRaceName(st.RaceState.Config.EventName)
	if raceID == "" || slug == "" {
		h.T.Fatalf("create_race did not return raceId/slug: %+v", st.RaceState)
	}

	var checkedSlots []int
	for idx, p := range st.Pilots {
		checked := false
		att := domain.AttendanceAway
		if idx < pilotCount {
			checked = true
			att = domain.AttendanceActive
			checkedSlots = append(checkedSlots, p.SlotIndex)
		}
		h.APIPost("/api/events/action", map[string]any{
			"action":     "update_attendance",
			"raceId":     raceID,
			"slotIndex":  p.SlotIndex,
			"checkedIn":  checked,
			"attendance": att,
		}, &st)
	}

	if subTab != "" {
		targetHash := fmt.Sprintf("#/races/%s/%s", slug, subTab)
		if _, err := h.Page.Evaluate(`(hash) => { window.location.hash = hash; }`, targetHash); err != nil {
			h.T.Fatalf("navigate hash %s: %v", targetHash, err)
		}
	}
	return raceID, slug, checkedSlots
}

func apiFindHeat(st api.FullStateResponse, heatID string) *domain.RaceHeat {
	for i := range st.RaceState.Heats {
		if st.RaceState.Heats[i].ID == heatID {
			return &st.RaceState.Heats[i]
		}
	}
	return nil
}

// apiScoreAndConfirmHeat deterministically starts `heatID`, stops it immediately, injects exact
// millisecond gate crossings (`offsetsByPilotSlot`), and confirms the heat via WASM HTTP API.
func apiScoreAndConfirmHeat(h *Harness, heatID string, offsetsByPilotSlot map[int][]int64) api.FullStateResponse {
	h.T.Helper()
	var st api.FullStateResponse
	h.APIPost("/api/race/control", map[string]any{
		"action":         "start",
		"heatId":         heatID,
		"preemptOngoing": true,
	}, &st)
	h.APIPost("/api/race/control", map[string]any{
		"action": "stop",
		"heatId": heatID,
	}, &st)

	ht := apiFindHeat(st, heatID)
	if ht == nil {
		h.T.Fatalf("heat %q not found after stop", heatID)
	}
	for _, seat := range ht.Seats {
		if seat.PilotSlotIndex <= 0 {
			continue
		}
		offsets, ok := offsetsByPilotSlot[seat.PilotSlotIndex]
		if !ok {
			// Default deterministic finishing times ordered by seat index when caller doesn't specify per-slot overrides.
			baseLapMs := int64(11000 + seat.SeatIndex*1200)
			lapsNeeded := ht.TargetLaps
			if lapsNeeded <= 0 {
				lapsNeeded = 3
			}
			offsets = make([]int64, 0, lapsNeeded+1)
			cur := int64(600 + seat.SeatIndex*80)
			offsets = append(offsets, cur) // holeshot
			for l := 0; l < lapsNeeded; l++ {
				cur += baseLapMs
				offsets = append(offsets, cur)
			}
		}
		for _, off := range offsets {
			offVal := off
			h.APIPost("/api/race/marshal", map[string]any{
				"heatId":         heatID,
				"pilotSlotIndex": seat.PilotSlotIndex,
				"action":         "add_crossing",
				"offsetMs":       offVal,
			}, &st)
		}
	}

	h.APIPost("/api/race/control", map[string]any{
		"action": "confirm",
		"heatId": heatID,
	}, &st)
	return st
}

// 1. Full Single-Elimination tournament run via live 20x RF Simulator + CSV Results Export API
func TestAPI_RaceE2E_SingleEliminationFullBracketAndCSVExport(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/races")
	h.ConnectSimHubH1()

	// Set 20x simulator speed via WASM API so real RF crossings complete 2-lap heats in ~3.5s.
	var st api.FullStateResponse
	h.APIPost("/api/sim/speed", map[string]any{
		"speedMultiplier": 20,
	}, &st)
	if st.SimState == nil || st.SimState.SpeedMultiplier != 20 {
		t.Fatalf("expected speedMultiplier=20, got %+v", st.SimState)
	}

	// Create 4-pilot Single Elimination race (1 Finals heat with 4 pilots or 2x2 Semi -> Final).
	raceID, slug, _ := apiPrepareRaceWithCheckedInPilots(h, "API Single Elim Live RF", 4, "stage-1")

	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":     raceID,
		"action":     "apply_template",
		"templateId": "single_elimination",
	}, &st)
	cfg := st.RaceState.Config
	cfg.PilotsPerHeat = 2
	cfg.TargetLaps = 2
	cfg.CountdownSec = 1
	cfg.FinalsFormat = domain.FinalsSingle
	h.APIPost("/api/race/setup", map[string]any{
		"raceId":          raceID,
		"config":          cfg,
		"generate":        true,
		"applyToExisting": true,
	}, &st)

	if len(st.RaceState.Heats) < 3 {
		t.Fatalf("expected 2 Semi-Finals + 1 Finals heat (3 heats) for 4 pilots @ 2/heat, got %d", len(st.RaceState.Heats))
	}

	_, _ = h.Page.Evaluate(`(hash) => { window.location.hash = hash; }`, fmt.Sprintf("#/races/%s/control", slug))

	// Run every heat end-to-end with genuine simulated 5.8 GHz RF gate crossings!
	for step := 0; step < 6 && !st.RaceState.IsComplete; step++ {
		heatID := st.RaceState.ActiveHeatID
		if heatID == "" {
			heatID = st.RaceState.NextReadyHeatID
		}
		if heatID == "" {
			t.Fatalf("no active/ready heat at step %d while race incomplete", step)
		}

		h.APIPost("/api/race/control", map[string]any{
			"action":         "start",
			"heatId":         heatID,
			"preemptOngoing": true,
		}, &st)

		h.WaitUntil("RF simulator completes 2-lap heat "+heatID, 20*time.Second, func() (bool, error) {
			var tick domain.RaceTournamentState
			h.APIGet("/api/race/tick", &tick)
			for _, ht := range tick.Heats {
				if ht.ID == heatID && ht.State == domain.HeatFinished {
					return true, nil
				}
			}
			return false, nil
		})

		h.APIPost("/api/race/control", map[string]any{
			"action": "confirm",
			"heatId": heatID,
		}, &st)
	}

	if !st.RaceState.IsComplete || st.RaceState.ChampionCallsign == "" {
		t.Fatalf("expected tournament complete with ChampionCallsign, got complete=%v champion=%q", st.RaceState.IsComplete, st.RaceState.ChampionCallsign)
	}

	// Verify GET /api/race/export.csv returns valid text/csv headers + champion & lap metrics!
	csvRes := h.CurlSpec(fmt.Sprintf("GET /api/race/export.csv?raceId=%s", raceID), nil)
	if !csvRes.OK || csvRes.Status != 200 {
		t.Fatalf("GET /api/race/export.csv failed: %+v", csvRes)
	}
	if !strings.Contains(csvRes.Headers["content-type"], "text/csv") {
		t.Fatalf("expected text/csv content-type, got %q", csvRes.Headers["content-type"])
	}
	if !strings.Contains(csvRes.Headers["content-disposition"], ".csv") || !strings.Contains(csvRes.Headers["content-disposition"], "api-single-elim-live-rf") {
		t.Fatalf("expected race slug .csv attachment filename in content-disposition, got %q", csvRes.Headers["content-disposition"])
	}
	if !strings.Contains(csvRes.Body, "Rank,Callsign") || !strings.Contains(csvRes.Body, st.RaceState.ChampionCallsign) || !strings.Contains(csvRes.Body, "Champion") {
		t.Fatalf("CSV export missing header or champion %q:\n%s", st.RaceState.ChampionCallsign, csvRes.Body)
	}

	h.MilestoneScreenshot("api-e2e-single-elim-rf-and-csv")
}

// 2. Double Elimination + Chase-the-Ace Finals where Challenger wins Heat 1 to force Finals Heat 2
func TestAPI_RaceE2E_DoubleEliminationWinnersRedemptionAndChaseTheAceFinals(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/races")

	raceID, slug, _ := apiPrepareRaceWithCheckedInPilots(h, "API Double Elim Chase The Ace", 4, "stage-1")

	var st api.FullStateResponse
	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":     raceID,
		"action":     "apply_template",
		"templateId": "double_elimination",
	}, &st)

	cfg := st.RaceState.Config
	cfg.PilotsPerHeat = 4
	cfg.TargetLaps = 2
	cfg.FinalsFormat = domain.FinalsChaseTheAce
	cfg.AceWinsRequired = 2
	cfg.WinnersAdvantageAce = false
	h.APIPost("/api/race/setup", map[string]any{
		"raceId":          raceID,
		"config":          cfg,
		"generate":        true,
		"applyToExisting": true,
	}, &st)

	initialHeatCount := len(st.RaceState.Heats)
	if initialHeatCount < 1 {
		t.Fatalf("expected generated heats in Double Elimination, got 0")
	}

	_, _ = h.Page.Evaluate(`(hash) => { window.location.hash = hash; }`, fmt.Sprintf("#/races/%s/control", slug))

	// Score preliminary heats if any exist before Finals, then in Chase-the-Ace Finals:
	// have Pilot A win Finals Heat 1, Pilot B win Finals Heat 2 (spawning Finals Heat 3!), and Pilot B win Finals Heat 3 to claim the Ace!
	var aceWinnerSlot int
	for guard := 0; guard < 12 && !st.RaceState.IsComplete; guard++ {
		heatID := st.RaceState.ActiveHeatID
		if heatID == "" {
			heatID = st.RaceState.NextReadyHeatID
		}
		if heatID == "" {
			t.Fatalf("missing ready heat at guard=%d", guard)
		}
		ht := apiFindHeat(st, heatID)
		if ht == nil {
			t.Fatalf("heat %s not found", heatID)
		}

		// Collect active pilot slots in this heat.
		var slots []int
		for _, s := range ht.Seats {
			if s.PilotSlotIndex > 0 {
				slots = append(slots, s.PilotSlotIndex)
			}
		}
		offsets := make(map[int][]int64, len(slots))
		isFinals := ht.BracketLane == "finals" || strings.Contains(strings.ToLower(ht.Title), "final")
		if isFinals && len(slots) >= 2 {
			// Alternate winner between Finals Heat 1 (slots[0]) and subsequent Finals heats (slots[1])
			// so Chase-the-Ace (2 wins required) MUST dynamically spawn an extra Finals heat!
			winnerIdx := 1
			if aceWinnerSlot == 0 {
				winnerIdx = 0
				aceWinnerSlot = slots[1] // slots[1] will win the next two Finals heats!
			}
			for i, sl := range slots {
				rank := i + 2
				if i == winnerIdx {
					rank = 1
				}
				offsets[sl] = []int64{500, int64(10000 + rank*1000), int64(20000 + rank*2000)}
			}
		}
		st = apiScoreAndConfirmHeat(h, heatID, offsets)
	}

	if !st.RaceState.IsComplete || st.RaceState.ChampionSlotIndex != aceWinnerSlot {
		t.Fatalf("expected Chase-the-Ace champion slot=%d, got complete=%v slot=%d (%s)",
			aceWinnerSlot, st.RaceState.IsComplete, st.RaceState.ChampionSlotIndex, st.RaceState.ChampionCallsign)
	}
	if len(st.RaceState.Heats) <= initialHeatCount {
		t.Fatalf("expected Chase-the-Ace to dynamically spawn additional Finals heats (> %d), got %d", initialHeatCount, len(st.RaceState.Heats))
	}
	h.MilestoneScreenshot("api-e2e-double-elim-chase-the-ace")
}

// 3. Two-Stage Qualifying (Fastest 3 Consecutive) -> Top 4 Seeding Handoff -> Stage 2 Mains
func TestAPI_RaceE2E_TwoStageQualifyingToMainsSeedingAndAdvance(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/races")

	raceID, slug, slots := apiPrepareRaceWithCheckedInPilots(h, "API Two Stage Qual To Mains", 6, "stage-1")

	var st api.FullStateResponse
	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":     raceID,
		"action":     "apply_template",
		"templateId": "qual_single_elim",
	}, &st)

	cfg := st.RaceState.Config
	cfg.QualifyingRounds = 1
	cfg.QualifyingMetric = domain.QualMetricConsecutive3
	cfg.Stage2MaxSeeds = 4
	cfg.PilotsPerHeat = 4
	cfg.TargetLaps = 2
	cfg.FinalsFormat = domain.FinalsSingle
	h.APIPost("/api/race/setup", map[string]any{
		"raceId":          raceID,
		"config":          cfg,
		"generate":        true,
		"applyToExisting": true,
	}, &st)

	if st.RaceState.TotalStages != 1 {
		t.Fatalf("expected unified single-graph (TotalStages=1) for qual_single_elim, got %d", st.RaceState.TotalStages)
	}

	_, _ = h.Page.Evaluate(`(hash) => { window.location.hash = hash; }`, fmt.Sprintf("#/races/%s/control", slug))

	// Score all Qualifying heats so `slots` in reverse order get fastest 3-consecutive lap times:
	// slots[5] fastest (3x 9.0s = 27.0s), slots[4] 2nd (3x 10.0s = 30.0s), slots[3] 3rd, slots[2] 4th,
	// while slots[1] and slots[0] are 5th & 6th (eliminated by Stage2MaxSeeds=4!).
	rankBySlot := make(map[int]int, len(slots))
	for i, sl := range slots {
		rankBySlot[sl] = len(slots) - i // slots[5]->1, slots[4]->2, slots[3]->3, slots[2]->4, slots[1]->5, slots[0]->6
	}

	for {
		var nextQualHeat string
		for _, ht := range st.RaceState.Heats {
			if ht.StageFormat == domain.FormatQualifying && ht.State != domain.HeatConfirmed {
				nextQualHeat = ht.ID
				break
			}
		}
		if nextQualHeat == "" {
			break
		}
		ht := apiFindHeat(st, nextQualHeat)
		offsets := make(map[int][]int64)
		for _, s := range ht.Seats {
			if s.PilotSlotIndex <= 0 {
				continue
			}
			rk := rankBySlot[s.PilotSlotIndex]
			lapMs := int64(8000 + rk*1000)
			offsets[s.PilotSlotIndex] = []int64{500, 500 + lapMs, 500 + 2*lapMs, 500 + 3*lapMs}
		}
		st = apiScoreAndConfirmHeat(h, nextQualHeat, offsets)
	}

	// Verify Qualifying standings rank slots[5], slots[4], slots[3], slots[2] as Top 4!
	if len(st.RaceState.QualStandings) < 6 {
		t.Fatalf("expected 6 pilots in QualStandings, got %d", len(st.RaceState.QualStandings))
	}
	if st.RaceState.QualStandings[0].PilotSlotIndex != slots[5] || st.RaceState.QualStandings[3].PilotSlotIndex != slots[2] {
		t.Fatalf("unexpected QualStandings order: #1=%d (want %d), #4=%d (want %d)",
			st.RaceState.QualStandings[0].PilotSlotIndex, slots[5],
			st.RaceState.QualStandings[3].PilotSlotIndex, slots[2])
	}

	// Verify only Top 4 qualifiers entered the downstream elimination heats on the unified graph!
	bracketSeated := make(map[int]bool)
	for _, ht := range st.RaceState.Heats {
		if ht.StageFormat != domain.FormatQualifying {
			for _, s := range ht.Seats {
				if s.PilotSlotIndex > 0 {
					bracketSeated[s.PilotSlotIndex] = true
				}
			}
		}
	}
	if len(bracketSeated) != 4 || bracketSeated[slots[0]] || bracketSeated[slots[1]] {
		t.Fatalf("expected exactly Top 4 qualifiers in bracket (excluding slots %d, %d), got %v", slots[0], slots[1], bracketSeated)
	}

	// Score Stage 2 so top qualifier slots[5] wins the Championship!
	_, _ = h.Page.Evaluate(`(hash) => { window.location.hash = hash; }`, fmt.Sprintf("#/races/%s/control", slug))
	for !st.RaceState.IsComplete {
		heatID := st.RaceState.ActiveHeatID
		if heatID == "" {
			heatID = st.RaceState.NextReadyHeatID
		}
		ht := apiFindHeat(st, heatID)
		offsets := make(map[int][]int64)
		for _, s := range ht.Seats {
			if s.PilotSlotIndex <= 0 {
				continue
			}
			rk := rankBySlot[s.PilotSlotIndex]
			offsets[s.PilotSlotIndex] = []int64{500, int64(9000 + rk*800), int64(18000 + rk*1600)}
		}
		st = apiScoreAndConfirmHeat(h, heatID, offsets)
	}

	if st.RaceState.ChampionSlotIndex != slots[5] {
		t.Fatalf("expected top seed slot %d to win Stage 2 Championship, got %d (%s)", slots[5], st.RaceState.ChampionSlotIndex, st.RaceState.ChampionCallsign)
	}
	h.MilestoneScreenshot("api-e2e-two-stage-qual-to-mains")
}

// 4. Points Mains cumulative multi-round points standings & tie-break verification
func TestAPI_RaceE2E_PointsMainsCumulativeStandings(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/races")

	raceID, slug, slots := apiPrepareRaceWithCheckedInPilots(h, "API Points Mains 3 Rounds", 4, "stage-1")

	var st api.FullStateResponse
	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":     raceID,
		"action":     "apply_template",
		"templateId": "points_mains",
	}, &st)

	cfg := st.RaceState.Config
	cfg.PointsRounds = 3
	cfg.PilotsPerHeat = 4
	cfg.TargetLaps = 2
	h.APIPost("/api/race/setup", map[string]any{
		"raceId":          raceID,
		"config":          cfg,
		"generate":        true,
		"applyToExisting": true,
	}, &st)

	if len(st.RaceState.Heats) != 3 {
		t.Fatalf("expected 3 Points Mains heats (3 rounds x 1 heat of 4), got %d", len(st.RaceState.Heats))
	}

	_, _ = h.Page.Evaluate(`(hash) => { window.location.hash = hash; }`, fmt.Sprintf("#/races/%s/control", slug))

	// Round 1: slots[0] 1st, slots[1] 2nd, slots[2] 3rd, slots[3] 4th
	// Round 2: slots[1] 1st, slots[0] 2nd, slots[2] 3rd, slots[3] 4th
	// Round 3: slots[1] 1st, slots[2] 2nd, slots[0] 3rd, slots[3] 4th
	// -> slots[1] wins overall cumulative points!
	orders := [][]int{
		{slots[0], slots[1], slots[2], slots[3]},
		{slots[1], slots[0], slots[2], slots[3]},
		{slots[1], slots[2], slots[0], slots[3]},
	}
	for rIdx, order := range orders {
		heatID := st.RaceState.Heats[rIdx].ID
		offsets := make(map[int][]int64, 4)
		for posIdx, sl := range order {
			rk := posIdx + 1
			offsets[sl] = []int64{500, int64(10000 + rk*1000), int64(20000 + rk*2000)}
		}
		st = apiScoreAndConfirmHeat(h, heatID, offsets)
	}

	if !st.RaceState.IsComplete || st.RaceState.ChampionSlotIndex != slots[1] {
		t.Fatalf("expected slots[1] (%d) to win Points Mains overall, got complete=%v championSlot=%d (%s)",
			slots[1], st.RaceState.IsComplete, st.RaceState.ChampionSlotIndex, st.RaceState.ChampionCallsign)
	}
	if len(st.RaceState.Standings) != 4 || st.RaceState.Standings[0].Points <= st.RaceState.Standings[1].Points {
		t.Fatalf("expected descending cumulative points in Standings, got %+v", st.RaceState.Standings)
	}
	h.MilestoneScreenshot("api-e2e-points-mains")
}

// 5. Round-Robin Qualifying dynamic metric recomputation across all 5 QualifyingMetric modes
func TestAPI_RaceE2E_RoundRobinQualifyingMetricsRecompute(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/races")

	raceID, slug, slots := apiPrepareRaceWithCheckedInPilots(h, "API Qualifying Metrics Matrix", 3, "stage-1")

	var st api.FullStateResponse
	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":     raceID,
		"action":     "apply_template",
		"templateId": "round_robin",
	}, &st)

	cfg := st.RaceState.Config
	cfg.QualifyingRounds = 2
	cfg.PilotsPerHeat = 4
	cfg.QualifyingMetric = domain.QualMetricBestLap
	h.APIPost("/api/race/setup", map[string]any{
		"raceId":          raceID,
		"config":          cfg,
		"generate":        true,
		"applyToExisting": true,
	}, &st)

	_, _ = h.Page.Evaluate(`(hash) => { window.location.hash = hash; }`, fmt.Sprintf("#/races/%s/control", slug))

	heatID := st.RaceState.Heats[0].ID
	// Craft asymmetric lap profiles across 3 pilots so DIFFERENT metrics crown DIFFERENT #1 leaders!
	// Pilot A (slots[0]): 1 blazing single lap (7.0s), then slow laps (20.0s, 20.0s) -> BestLap=7.0s (#1 in best_lap!), Consec2=27.0s, Consec3=47.0s (3 laps in 47.5s)
	// Pilot B (slots[1]): 2 fast consecutive laps (9.0s, 9.0s), then 18.0s -> BestLap=9.0s, Consec2=18.0s (#1 in consecutive_2!), Consec3=36.0s (3 laps in 36.5s)
	// Pilot C (slots[2]): 4 steady 10.0s laps -> BestLap=10.0s, Consec2=20.0s, Consec3=30.0s (#1 in consecutive_3 AND #1 in laps_in_time with 4 laps!)
	offsets := map[int][]int64{
		slots[0]: {500, 7500, 27500, 47500},
		slots[1]: {500, 9500, 18500, 36500},
		slots[2]: {500, 10500, 20500, 30500, 40500},
	}
	st = apiScoreAndConfirmHeat(h, heatID, offsets)

	checkLeader := func(metric domain.QualifyingMetric, expectedSlot int) {
		h.APIPost("/api/race/bracket-edit", map[string]any{
			"raceId":           raceID,
			"action":           "update_stage_settings",
			"stageIndex":       1,
			"qualifyingMetric": metric,
		}, &st)
		if len(st.RaceState.Standings) < 3 {
			t.Fatalf("metric %s: expected 3 standings entries, got %d", metric, len(st.RaceState.Standings))
		}
		got := st.RaceState.Standings[0].PilotSlotIndex
		if got != expectedSlot {
			t.Fatalf("metric %s: expected leader slot %d, got slot %d (standings=%+v)", metric, expectedSlot, got, st.RaceState.Standings)
		}
	}

	checkLeader(domain.QualMetricBestLap, slots[0])
	checkLeader(domain.QualMetricConsecutive2, slots[1])
	checkLeader(domain.QualMetricConsecutive3, slots[2])
	checkLeader(domain.QualMetricLapsInTime, slots[2])
	checkLeader(domain.QualMetricPoints, slots[2])

	h.MilestoneScreenshot("api-e2e-qualifying-metrics-matrix")
}

// 6. Open Qualifier Flight-Line Queue (`enqueue`, `dequeue`, `enqueue_all`) & MaxPacksPerPilot Enforcement
func TestAPI_RaceE2E_OpenQualifierFlightLineAndPackLimit(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/races")

	raceID, slug, slots := apiPrepareRaceWithCheckedInPilots(h, "API Open Qualifier Pack Cap", 4, "control")
	_, _ = h.Page.Evaluate(`(hash) => { window.location.hash = hash; }`, fmt.Sprintf("#/races/%s/control", slug))

	var st api.FullStateResponse
	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":     raceID,
		"action":     "apply_template",
		"templateId": "open_qualifier",
	}, &st)

	maxPacks := 2
	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":           raceID,
		"action":           "update_stage_settings",
		"stageIndex":       1,
		"maxPacksPerPilot": maxPacks,
		"pilotsPerHeat":    2,
	}, &st)

	// 1. Enqueue slots[0] and slots[1], then dequeue slots[1] and verify seat cleared.
	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":         raceID,
		"action":         "open_qual_enqueue",
		"stageIndex":     1,
		"pilotSlotIndex": slots[0],
	}, &st)
	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":         raceID,
		"action":         "open_qual_enqueue",
		"stageIndex":     1,
		"pilotSlotIndex": slots[1],
	}, &st)
	if len(st.RaceState.Heats) != 1 {
		t.Fatalf("expected 1 spawned Open Qualifier pack for 2 pilots @ 2/heat, got %d", len(st.RaceState.Heats))
	}

	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":         raceID,
		"action":         "open_qual_dequeue",
		"stageIndex":     1,
		"heatId":         st.RaceState.Heats[0].ID,
		"pilotSlotIndex": slots[1],
	}, &st)

	// 2. Enqueue all eligible pilots (`open_qual_enqueue_all`) -> fills OQ-1 and spawns OQ-2 for 4 pilots @ 2/heat!
	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":     raceID,
		"action":     "open_qual_enqueue_all",
		"stageIndex": 1,
	}, &st)
	if len(st.RaceState.Heats) < 2 {
		t.Fatalf("expected >= 2 Open Qualifier heats after open_qual_enqueue_all for 4 pilots @ 2/heat, got %d", len(st.RaceState.Heats))
	}

	// Score Pack 1 (slots[0] gets pack #1) and enqueue + score Pack 2 for slots[0] (hits MaxPacksPerPilot=2!).
	st = apiScoreAndConfirmHeat(h, st.RaceState.Heats[0].ID, nil)
	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":         raceID,
		"action":         "open_qual_enqueue",
		"stageIndex":     1,
		"pilotSlotIndex": slots[0],
	}, &st)
	// Find the unstarted heat containing slots[0] and score it.
	var secondPackID string
	for _, ht := range st.RaceState.Heats {
		if ht.State != domain.HeatConfirmed {
			for _, s := range ht.Seats {
				if s.PilotSlotIndex == slots[0] {
					secondPackID = ht.ID
				}
			}
		}
	}
	if secondPackID == "" {
		t.Fatalf("expected slots[0] queued into 2nd pack")
	}
	st = apiScoreAndConfirmHeat(h, secondPackID, nil)

	// 3. Attempting a 3rd pack for slots[0] MUST return 400 Bad Request due to MaxPacksPerPilot=2!
	capRes := h.APIExpectStatus("POST", "/api/race/bracket-edit", map[string]any{
		"raceId":         raceID,
		"action":         "open_qual_enqueue",
		"stageIndex":     1,
		"pilotSlotIndex": slots[0],
	}, 400)
	if !strings.Contains(strings.ToLower(capRes.Body), "pack") && !strings.Contains(strings.ToLower(capRes.Body), "limit") && !strings.Contains(strings.ToLower(capRes.Body), "max") {
		t.Fatalf("expected pack limit error message on 3rd enqueue, got %q", capRes.Body)
	}

	h.MilestoneScreenshot("api-e2e-open-qualifier-pack-cap")
}

// 7. Custom Multi-Stage DAG & Round/Heat/Seat/Channel Graph Editing API
func TestAPI_RaceE2E_CustomMultiStageDAGAndBracketGraphEditing(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/races")

	raceID, slug, slots := apiPrepareRaceWithCheckedInPilots(h, "API Custom DAG Builder", 4, "format")

	// 1. Start blank Custom stage (`start_custom`), add a 2nd stage (`add_stage`), rename & wire stages (`connect_stages`).
	var st api.FullStateResponse
	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":   raceID,
		"action":   "start_custom",
		"linkMode": "none",
	}, &st)
	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":      raceID,
		"action":      "add_stage",
		"stageFormat": domain.FormatSingleElimination,
		"title":       "Grand Finals Stage",
	}, &st)
	if len(st.RaceState.Stages) != 2 {
		t.Fatalf("expected 2 stages after add_stage, got %d", len(st.RaceState.Stages))
	}

	stg1ID := st.RaceState.Stages[0].ID
	stg2ID := st.RaceState.Stages[1].ID
	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":  raceID,
		"action":  "rename_stage",
		"stageId": stg1ID,
		"title":   "Custom Seeding Stage",
	}, &st)
	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":      raceID,
		"action":      "connect_stages",
		"fromStageId": stg1ID,
		"toStageId":   stg2ID,
		"seedStart":   1,
		"seedEnd":     2,
	}, &st)
	if len(st.RaceState.StageConnections) != 1 {
		t.Fatalf("expected 1 StageConnection between Stage 1 and Stage 2, got %d", len(st.RaceState.StageConnections))
	}

	// 2. Switch to Stage 1 round graph, add custom rounds, wire portals (`stage1-pilots-in` -> R1 -> `stage1-seeding-out`),
	// add/delete a heat, assign manual seat pilot & custom Raceband channel!
	_, _ = h.Page.Evaluate(`(hash) => { window.location.hash = hash; }`, fmt.Sprintf("#/races/%s/stage-1", slug))

	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":     raceID,
		"action":     "add_round",
		"stageIndex": 1,
		"title":      "Custom Opening Round",
		"heatCount":  1,
		"linkMode":   "empty",
	}, &st)

	var customRoundID string
	for _, r := range st.RaceState.Rounds {
		if r.StageIndex == 1 && !domain.IsStagePortalRoundID(r.ID) {
			customRoundID = r.ID
			break
		}
	}
	if customRoundID == "" {
		t.Fatalf("expected custom round created in Stage 1")
	}

	// Add a second heat to the round, then delete it to verify `add_heat` + `delete_heat`.
	beforeHeats := len(st.RaceState.Heats)
	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":  raceID,
		"action":  "add_heat",
		"roundId": customRoundID,
	}, &st)
	if len(st.RaceState.Heats) != beforeHeats+1 {
		t.Fatalf("expected heat count %d after add_heat, got %d", beforeHeats+1, len(st.RaceState.Heats))
	}
	var addedHeatID, keptHeatID string
	for _, ht := range st.RaceState.Heats {
		if ht.RoundID == customRoundID {
			if keptHeatID == "" {
				keptHeatID = ht.ID
			} else {
				addedHeatID = ht.ID
			}
		}
	}
	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId": raceID,
		"action": "delete_heat",
		"heatId": addedHeatID,
	}, &st)

	// Assign 2 pilots manually into `keptHeatID`, set Seat 1 channel to R7 (5880 MHz),
	// add a Stage 1 Finals round, and wire `customRoundID` -> `customFinalsID` via `connect_rounds`!
	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":         raceID,
		"action":         "assign_pilot_seat",
		"heatId":         keptHeatID,
		"seatIndex":      1,
		"pilotSlotIndex": slots[0],
	}, &st)
	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":         raceID,
		"action":         "assign_pilot_seat",
		"heatId":         keptHeatID,
		"seatIndex":      2,
		"pilotSlotIndex": slots[1],
	}, &st)
	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":    raceID,
		"action":    "set_seat_channel",
		"heatId":    keptHeatID,
		"seatIndex": 1,
		"channel":   7,
	}, &st)
	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":       raceID,
		"action":       "add_round",
		"stageIndex":   1,
		"title":        "Stage 1 Final",
		"bracketLane":  "finals",
		"finalsFormat": domain.FinalsSingle,
		"heatCount":    1,
		"linkMode":     "empty",
	}, &st)
	var customFinalsID string
	for _, r := range st.RaceState.Rounds {
		if r.StageIndex == 1 && r.ID != customRoundID && !domain.IsStagePortalRoundID(r.ID) {
			customFinalsID = r.ID
			break
		}
	}
	if customFinalsID == "" {
		t.Fatalf("expected Stage 1 Final round created in Stage 1")
	}
	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":       raceID,
		"action":       "connect_rounds",
		"stageIndex":   1,
		"fromRoundId":  customRoundID,
		"toRoundId":    customFinalsID,
		"linkMode":     "top_per_heat",
		"advanceCount": 2,
	}, &st)

	ht := apiFindHeat(st, keptHeatID)
	if ht == nil || ht.Seats[0].Channel != 7 || ht.Seats[0].PilotSlotIndex != slots[0] {
		t.Fatalf("expected custom heat Seat 1 on R7 with slot %d, got %+v", slots[0], ht)
	}

	// Score custom Stage 1 rounds -> advance to Stage 2 -> crown overall tournament champion!
	_, _ = h.Page.Evaluate(`(hash) => { window.location.hash = hash; }`, fmt.Sprintf("#/races/%s/control", slug))
	st = apiScoreAndConfirmHeat(h, keptHeatID, nil)
	for {
		var s1Next string
		for _, h1 := range st.RaceState.Heats {
			if h1.StageIndex == 1 && h1.State != domain.HeatConfirmed {
				s1Next = h1.ID
				break
			}
		}
		if s1Next == "" {
			break
		}
		st = apiScoreAndConfirmHeat(h, s1Next, nil)
	}
	h.APIPost("/api/events/action", map[string]any{
		"action":      "stage_control",
		"raceId":      raceID,
		"stageIndex":  2,
		"stageAction": "activate_stage",
	}, &st)
	_, _ = h.Page.Evaluate(`(hash) => { window.location.hash = hash; }`, fmt.Sprintf("#/races/%s/control", slug))
	for !st.RaceState.IsComplete {
		hid := st.RaceState.ActiveHeatID
		if hid == "" {
			hid = st.RaceState.NextReadyHeatID
		}
		st = apiScoreAndConfirmHeat(h, hid, nil)
	}
	if !st.RaceState.IsComplete || st.RaceState.ChampionCallsign == "" {
		t.Fatalf("expected custom 2-stage DAG tournament to crown a champion, got %+v", st.RaceState)
	}

	h.MilestoneScreenshot("api-e2e-custom-dag-complete")
}

// 8. Comprehensive Heat Control, Marshal Overrides (Crossings, Penalties, DNF/DQ/DNS, Reorder, Unlock) & Race Lifecycle
func TestAPI_RaceMarshalLiveAndPostHeatCrossingsPenaltiesAndLifecycle(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/races")

	raceID, slug, slots := apiPrepareRaceWithCheckedInPilots(h, "API Marshal & Lifecycle Suite", 4, "control")
	_, _ = h.Page.Evaluate(`(hash) => { window.location.hash = hash; }`, fmt.Sprintf("#/races/%s/control", slug))

	var st api.FullStateResponse
	h.APIPost("/api/race/bracket-edit", map[string]any{
		"raceId":     raceID,
		"action":     "apply_template",
		"templateId": "single_elimination",
	}, &st)
	cfg := st.RaceState.Config
	cfg.PilotsPerHeat = 4
	cfg.TargetLaps = 2
	cfg.CountdownSec = 5
	h.APIPost("/api/race/setup", map[string]any{
		"raceId":          raceID,
		"config":          cfg,
		"generate":        true,
		"applyToExisting": true,
	}, &st)

	heatID := st.RaceState.Heats[0].ID

	// 1. Test `start` (countdown) -> `cancel` -> `start` -> `emergency_stop` (aborted) -> `reset` (staged).
	h.APIPost("/api/race/control", map[string]any{"action": "start", "heatId": heatID, "preemptOngoing": true}, &st)
	if apiFindHeat(st, heatID).State != domain.HeatCountdown {
		t.Fatalf("expected HeatCountdown after start with CountdownSec=5, got %s", apiFindHeat(st, heatID).State)
	}
	h.APIPost("/api/race/control", map[string]any{"action": "cancel", "heatId": heatID}, &st)
	if apiFindHeat(st, heatID).State != domain.HeatStaged {
		t.Fatalf("expected HeatStaged after cancel, got %s", apiFindHeat(st, heatID).State)
	}

	h.APIPost("/api/race/control", map[string]any{"action": "start", "heatId": heatID, "preemptOngoing": true}, &st)
	h.APIPost("/api/race/control", map[string]any{"action": "emergency_stop", "heatId": heatID}, &st)
	if apiFindHeat(st, heatID).State != domain.HeatAborted {
		t.Fatalf("expected HeatAborted after emergency_stop, got %s", apiFindHeat(st, heatID).State)
	}
	h.APIPost("/api/race/control", map[string]any{"action": "reset", "heatId": heatID}, &st)
	if apiFindHeat(st, heatID).State != domain.HeatStaged {
		t.Fatalf("expected HeatStaged after reset, got %s", apiFindHeat(st, heatID).State)
	}

	// 2. Finish heat and test marshal crossing edits: `add_lap`, `add_crossing`, `move_crossing`, `toggle_lap`, `delete_crossing`.
	h.APIPost("/api/race/control", map[string]any{"action": "start", "heatId": heatID, "preemptOngoing": true}, &st)
	h.APIPost("/api/race/control", map[string]any{"action": "stop", "heatId": heatID}, &st)

	// Pilot 0: add 2 manual laps via `add_lap` (creates holeshot + Lap 1, then Lap 2).
	h.APIPost("/api/race/marshal", map[string]any{"heatId": heatID, "pilotSlotIndex": slots[0], "action": "add_lap"}, &st)
	h.APIPost("/api/race/marshal", map[string]any{"heatId": heatID, "pilotSlotIndex": slots[0], "action": "add_lap"}, &st)

	// Pilot 1: add 3 crossings via `add_crossing` + 1 extra crossing that we move, invalidate, and delete.
	for _, off := range []int64{500, 11500, 22500, 35000} {
		h.APIPost("/api/race/marshal", map[string]any{
			"heatId":         heatID,
			"pilotSlotIndex": slots[1],
			"action":         "add_crossing",
			"offsetMs":       off,
		}, &st)
	}
	ht := apiFindHeat(st, heatID)
	var extraCid uint64
	for _, s := range ht.Seats {
		if s.PilotSlotIndex == slots[1] && len(s.Crossings) == 4 {
			extraCid = s.Crossings[3].CrossingID
		}
	}
	if extraCid == 0 {
		t.Fatalf("expected 4th crossing ID for Pilot 1")
	}
	h.APIPost("/api/race/marshal", map[string]any{
		"heatId":         heatID,
		"pilotSlotIndex": slots[1],
		"action":         "move_crossing",
		"crossingId":     extraCid,
		"offsetMs":       int64(33000),
	}, &st)
	h.APIPost("/api/race/marshal", map[string]any{
		"heatId":         heatID,
		"pilotSlotIndex": slots[1],
		"action":         "toggle_lap",
		"crossingId":     extraCid,
	}, &st)
	h.APIPost("/api/race/marshal", map[string]any{
		"heatId":         heatID,
		"pilotSlotIndex": slots[1],
		"action":         "delete_crossing",
		"crossingId":     extraCid,
	}, &st)

	// 3. Test `set_penalty`, `move_down` / `move_up`, `clear_override`, and mutually-exclusive `toggle_dnf` / `toggle_dq` / `toggle_dns`.
	h.APIPost("/api/race/marshal", map[string]any{
		"heatId":         heatID,
		"pilotSlotIndex": slots[0],
		"action":         "set_penalty",
		"penaltySec":     2.5,
	}, &st)
	h.APIPost("/api/race/marshal", map[string]any{
		"heatId":         heatID,
		"pilotSlotIndex": slots[1],
		"action":         "move_down",
	}, &st)
	h.APIPost("/api/race/marshal", map[string]any{
		"heatId":         heatID,
		"pilotSlotIndex": slots[0],
		"action":         "clear_override",
	}, &st)

	h.APIPost("/api/race/marshal", map[string]any{"heatId": heatID, "pilotSlotIndex": slots[2], "action": "toggle_dnf"}, &st)
	h.APIPost("/api/race/marshal", map[string]any{"heatId": heatID, "pilotSlotIndex": slots[3], "action": "toggle_dq"}, &st)
	h.APIPost("/api/race/marshal", map[string]any{"heatId": heatID, "pilotSlotIndex": slots[3], "action": "toggle_dns"}, &st)

	// 4. Confirm -> verify `reset` is rejected while confirmed (400) -> `unlock` -> re-`confirm`!
	h.APIPost("/api/race/control", map[string]any{"action": "confirm", "heatId": heatID}, &st)
	h.APIExpectStatus("POST", "/api/race/control", map[string]any{"action": "reset", "heatId": heatID}, 400)

	h.APIPost("/api/race/control", map[string]any{"action": "unlock", "heatId": heatID}, &st)
	if apiFindHeat(st, heatID).State != domain.HeatFinished {
		t.Fatalf("expected HeatFinished after unlock, got %s", apiFindHeat(st, heatID).State)
	}
	h.APIPost("/api/race/control", map[string]any{"action": "confirm", "heatId": heatID}, &st)

	// 5. Exercise full `race_lifecycle` state machine (`reopen_race` -> `pause_race` -> `resume_race` -> `scrap_race` -> `reopen_race` -> `complete_race`).
	for _, lc := range []struct {
		action string
		want   domain.RaceLifecycle
	}{
		{"reopen_race", domain.LifecycleActive},
		{"pause_race", domain.LifecyclePaused},
		{"resume_race", domain.LifecycleActive},
		{"scrap_race", domain.LifecycleScrapped},
		{"reopen_race", domain.LifecycleActive},
		{"complete_race", domain.LifecycleCompleted},
	} {
		var raw json.RawMessage
		res := h.APIPost("/api/events/action", map[string]any{
			"action":          "race_lifecycle",
			"raceId":          raceID,
			"lifecycleAction": lc.action,
			"reason":          "API E2E test transition: " + lc.action,
			"preemptOngoing":  true,
		}, &raw)
		if !res.OK {
			t.Fatalf("lifecycleAction %s failed: %s", lc.action, res.Body)
		}
		_ = json.Unmarshal(raw, &st)
		if st.RaceState.Lifecycle != lc.want {
			t.Fatalf("after %s: expected lifecycle %s, got %s", lc.action, lc.want, st.RaceState.Lifecycle)
		}
	}

	h.MilestoneScreenshot("api-e2e-marshal-and-lifecycle")
}
