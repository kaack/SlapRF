package tracker

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"slaprf/internal/domain"
)

func seedEngineWithPilots(t *testing.T, total int) *Engine {
	t.Helper()
	e := NewEngine()

	// Ensure at least `total` pilots exist on the engine
	e.mu.Lock()
	cur := len(e.pilots)
	e.mu.Unlock()
	for i := cur; i < total; i++ {
		if _, err := e.EventAction(EventActionPayload{
			Action:   "add_event_pilot",
			Callsign: fmt.Sprintf("FLYER-%02d", i+1),
		}); err != nil {
			t.Fatalf("add_event_pilot %d failed: %v", i+1, err)
		}
	}
	if cur > total {
		e.mu.Lock()
		e.pilots = append([]domain.PilotSlot(nil), e.pilots[:total]...)
		if len(e.raceState.Roster) > total {
			e.raceState.Roster = append([]domain.EventPilot(nil), e.raceState.Roster[:total]...)
		}
		e.mu.Unlock()
	}
	return e
}

func TestCanvasPilotsNodeAndDefaultBalancedQualifierConnections(t *testing.T) {
	e := seedEngineWithPilots(t, 12)

	// Start a blank custom race (Round 1 starts empty, NOT connected to Pilots In yet)
	st, err := e.BracketEditAction(BracketEditPayload{
		Action:   "start_custom",
		LinkMode: "empty",
	})
	if err != nil {
		t.Fatalf("start_custom failed: %v", err)
	}
	if len(st.Rounds) != 1 {
		t.Fatalf("expected 1 round, got %d", len(st.Rounds))
	}
	q1 := st.Rounds[0].ID

	// Update Q1 to be a Qualifying round and add Q2 as an empty Qualifying round
	if _, err := e.BracketEditAction(BracketEditPayload{
		Action:      "update_round",
		RoundID:     q1,
		Title:       "Qualifying R1",
		BracketLane: "qualifying",
		StageFormat: domain.FormatQualifying,
	}); err != nil {
		t.Fatalf("update_round Q1 failed: %v", err)
	}
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_round",
		Title:       "Qualifying R2",
		BracketLane: "qualifying",
		StageFormat: domain.FormatQualifying,
		LinkMode:    "empty",
	})
	if err != nil {
		t.Fatalf("add_round Q2 failed: %v", err)
	}
	q2 := st.Rounds[len(st.Rounds)-1].ID

	// Move Canvas Pilots Node (`stage1-pilots-in`) and verify coordinates persist on Stage 1
	st, err = e.BracketEditAction(BracketEditPayload{
		Action: "move_rounds",
		Positions: []RoundPositionUpdate{
			{RoundID: domain.Stage1PilotsInID, PosX: 48, PosY: 96},
		},
	})
	if err != nil {
		t.Fatalf("move_rounds stage1-pilots-in failed: %v", err)
	}
	if len(st.Stages) == 0 || !st.Stages[0].PilotsNodeHasPos || st.Stages[0].PilotsNodePosX != 48 || st.Stages[0].PilotsNodePosY != 96 {
		t.Fatalf("expected Stage 1 PilotsNode pos (48, 96), got %+v", st.Stages)
	}

	// Drag connection from `stage1-pilots-in` -> `q1`: auto-sizes 12 pilots into 3 heats of 4
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: domain.Stage1PilotsInID,
		ToRoundID:   q1,
	})
	if err != nil {
		t.Fatalf("connect stage1-pilots-in -> q1 failed: %v", err)
	}
	var q1Heats []domain.RaceHeat
	for _, h := range st.Heats {
		if h.RoundID == q1 {
			q1Heats = append(q1Heats, h)
		}
	}
	if len(q1Heats) != 3 {
		t.Fatalf("expected 3 heats in Q1 for 12 pilots, got %d", len(q1Heats))
	}

	// Drag connection from `q1` -> `q2` WITHOUT specifying LinkMode:
	// MUST default to `all_pilots` (Balanced Rotation) and populate Q2 immediately with 0 channel switches & 0 back-to-back!
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: q1,
		ToRoundID:   q2,
	})
	if err != nil {
		t.Fatalf("connect q1 -> q2 failed: %v", err)
	}
	if len(st.Connections) != 1 || st.Connections[0].Mode != "all_pilots" {
		t.Fatalf("expected Q1->Q2 connection mode 'all_pilots', got %+v", st.Connections)
	}
	connID := st.Connections[0].ID

	q1Ch := make(map[int]uint8)
	lastQ1Pilots := make(map[int]bool)
	q1Idx := 0
	for _, h := range st.Heats {
		if h.RoundID != q1 {
			continue
		}
		for _, s := range h.Seats {
			if s.PilotSlotIndex > 0 {
				q1Ch[s.PilotSlotIndex] = s.Channel
				if q1Idx == 2 {
					lastQ1Pilots[s.PilotSlotIndex] = true
				}
			}
		}
		q1Idx++
	}

	var q2Heats []domain.RaceHeat
	for _, h := range st.Heats {
		if h.RoundID == q2 {
			q2Heats = append(q2Heats, h)
		}
	}
	if len(q2Heats) != 3 {
		t.Fatalf("expected 3 heats in Q2, got %d", len(q2Heats))
	}
	seatedQ2 := 0
	for hi, h := range q2Heats {
		for _, s := range h.Seats {
			if s.PilotSlotIndex <= 0 {
				continue
			}
			seatedQ2++
			if q1Ch[s.PilotSlotIndex] != s.Channel {
				t.Fatalf("expected sticky channel %d for pilot %d in Q2, got %d", q1Ch[s.PilotSlotIndex], s.PilotSlotIndex, s.Channel)
			}
			if hi == 0 && lastQ1Pilots[s.PilotSlotIndex] {
				t.Fatalf("pilot %d scheduled back-to-back between Q1 heat 3 and Q2 heat 1", s.PilotSlotIndex)
			}
		}
	}
	if seatedQ2 != 12 {
		t.Fatalf("expected all 12 pilots populated upfront in Q2, got %d", seatedQ2)
	}

	// Manually swap two pilots in Q1 (same channel across Heat 1 and Heat 2) and verify ManualLock + cascade to Q2
	h1 := q1Heats[0]
	h2 := q1Heats[1]
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:        "move_or_swap_seat",
		FromHeatID:    h1.ID,
		FromSeatIndex: h1.Seats[0].SeatIndex,
		ToHeatID:      h2.ID,
		ToSeatIndex:   h2.Seats[0].SeatIndex,
	})
	if err != nil {
		t.Fatalf("move_or_swap_seat failed: %v", err)
	}

	// Mark pilot 12 Out (`CheckedIn = false`): Q1 & Q2 re-balance for 11 pilots while keeping the manual swap locked!
	f := false
	st, err = e.EventAction(EventActionPayload{
		Action:    "update_attendance",
		SlotIndex: 12,
		CheckedIn: &f,
	})
	if err != nil {
		t.Fatalf("update_attendance Out failed: %v", err)
	}
	q2AfterOut := 0
	for _, h := range st.Heats {
		if h.RoundID == q2 {
			for _, s := range h.Seats {
				if s.PilotSlotIndex > 0 {
					if s.PilotSlotIndex == 12 {
						t.Fatalf("pilot 12 was checked Out and should have been removed from unstarted Q2")
					}
					q2AfterOut++
				}
			}
		}
	}
	if q2AfterOut != 11 {
		t.Fatalf("expected 11 pilots in Q2 after checking out pilot 12, got %d", q2AfterOut)
	}

	// Optional switch to `all_pilots_ranked` clears upfront pilots on Q2 in favor of standings feeders
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:       "update_connection",
		ConnectionID: connID,
		LinkMode:     "all_pilots_ranked",
	})
	if err != nil {
		t.Fatalf("update_connection all_pilots_ranked failed: %v", err)
	}
	feedersInQ2 := 0
	for _, h := range st.Heats {
		if h.RoundID == q2 {
			for _, s := range h.Seats {
				if s.Feeder != nil && s.Feeder.FromStandingsRank > 0 && s.PilotSlotIndex == 0 {
					feedersInQ2++
				}
			}
		}
	}
	if feedersInQ2 != 11 {
		t.Fatalf("expected 11 ranked standings feeders in Q2 (for 11 active pilots) after switching to all_pilots_ranked, got %d", feedersInQ2)
	}

	// Disconnect `conn-stage1-pilots-in-<q1>` removes non-locked pilots from Q1
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:       "disconnect_rounds",
		ConnectionID: "conn-" + domain.Stage1PilotsInID + "-" + q1,
	})
	if err != nil {
		t.Fatalf("disconnect pilots-in failed: %v", err)
	}
	for _, r := range st.Rounds {
		if r.ID == q1 && r.SeedSource == "all_active_pilots" {
			t.Fatalf("expected Q1 SeedSource cleared after disconnecting pilots-in, got %q", r.SeedSource)
		}
	}
}

func TestOpenQualifierFlightLineLifecycleAndCSVExport(t *testing.T) {
	e := seedEngineWithPilots(t, 8)
	maxPacks := 2

	st, err := e.BracketEditAction(BracketEditPayload{
		Action:           "apply_template",
		TemplateID:       "open_qualifier",
		PilotsPerHeat:    4,
		TimeLimitSec:     120,
		QualifyingMetric: domain.QualMetricConsecutive3,
		MaxPacksPerPilot: &maxPacks,
	})
	if err != nil {
		t.Fatalf("apply_template open_qualifier failed: %v", err)
	}
	if !st.Generated || st.Config.MainFormat != domain.FormatOpenQualifier {
		t.Fatalf("expected generated Open Qualifier tournament, got %+v", st.Config)
	}
	if len(st.Heats) != 0 {
		t.Fatalf("expected 0 pre-baked heats on fresh Open Qualifier, got %d", len(st.Heats))
	}

	// Queue All Ready (8 pilots -> OQ-1 and OQ-2 of 4 pilots each)
	st, err = e.BracketEditAction(BracketEditPayload{
		Action: "open_qual_enqueue_all",
	})
	if err != nil {
		t.Fatalf("open_qual_enqueue_all failed: %v", err)
	}
	if len(st.Heats) != 2 || st.Heats[0].ID != "OQ-1" || st.Heats[1].ID != "OQ-2" {
		t.Fatalf("expected OQ-1 and OQ-2 spawned, got %d heats (%+v)", len(st.Heats), st.Heats)
	}
	oq1ChByPilot := make(map[int]uint8)
	for _, s := range st.Heats[0].Seats {
		if s.PilotSlotIndex > 0 {
			oq1ChByPilot[s.PilotSlotIndex] = s.Channel
		}
	}

	// Run and confirm OQ-1 (zero countdown so start transitions straight to running, or advance countdown)
	cfg := st.Config
	cfg.CountdownSec = 0
	e.mu.Lock()
	e.raceState.Config.CountdownSec = 0
	e.mu.Unlock()

	st, err = e.RaceControlAction("start", "OQ-1")
	if err != nil {
		t.Fatalf("start OQ-1 failed: %v", err)
	}
	p1Slot := st.Heats[0].Seats[0].PilotSlotIndex

	// While OQ-1 is actively flying (`running`), pilots in OQ-1 MUST NOT be queueable again!
	if _, qErr := e.BracketEditAction(BracketEditPayload{
		Action:         "open_qual_enqueue",
		PilotSlotIndex: p1Slot,
	}); qErr == nil {
		t.Fatalf("expected open_qual_enqueue to reject pilot %d while actively flying in OQ-1", p1Slot)
	}
	if _, qAllErr := e.BracketEditAction(BracketEditPayload{
		Action: "open_qual_enqueue_all",
	}); qAllErr != nil {
		t.Fatalf("open_qual_enqueue_all returned unexpected error: %v", qAllErr)
	}
	if len(e.raceState.Heats) != 2 {
		t.Fatalf("expected open_qual_enqueue_all to skip all in-flight OQ-1 pilots so heat count remains 2, got %d", len(e.raceState.Heats))
	}

	// Record 4 laps (holeshot + 3 flying laps) via MarshalPilotAction
	for lap := 0; lap < 4; lap++ {
		e.mu.Lock()
		e.bootTime = e.bootTime.Add(-15 * time.Second)
		e.mu.Unlock()
		if _, err := e.MarshalPilotAction(RaceMarshalPayload{
			HeatID:         "OQ-1",
			PilotSlotIndex: p1Slot,
			Action:         "add_lap",
		}); err != nil {
			t.Fatalf("add_lap %d failed: %v", lap, err)
		}
	}
	if _, err := e.RaceControlAction("stop", "OQ-1"); err != nil {
		t.Fatalf("stop OQ-1 failed: %v", err)
	}
	st, err = e.RaceControlAction("confirm", "OQ-1")
	if err != nil {
		t.Fatalf("confirm OQ-1 failed: %v", err)
	}

	// CRITICAL: Confirming OQ-1 MUST NOT auto-complete the Open Qualifier stage or race!
	if st.IsComplete || st.Lifecycle == domain.LifecycleCompleted {
		t.Fatalf("Open Qualifier prematurely completed after confirming OQ-1: IsComplete=%v Lifecycle=%s", st.IsComplete, st.Lifecycle)
	}
	if len(st.Stages) > 0 && st.Stages[0].Status == domain.StageStatusCompleted {
		t.Fatalf("Open Qualifier Stage 1 prematurely marked Status=completed")
	}

	// Re-queue Pilot `p1Slot` while OQ-2 is waiting -> spawns OQ-3 (no back-to-back into OQ-2, and sticky channel preserved!)
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:         "open_qual_enqueue",
		PilotSlotIndex: p1Slot,
	})
	if err != nil {
		t.Fatalf("open_qual_enqueue second pack failed: %v", err)
	}
	if len(st.Heats) != 3 || st.Heats[2].ID != "OQ-3" {
		t.Fatalf("expected OQ-3 spawned for second pack, got %d heats", len(st.Heats))
	}
	foundSticky := false
	for _, s := range st.Heats[2].Seats {
		if s.PilotSlotIndex == p1Slot {
			foundSticky = true
			if s.Channel != oq1ChByPilot[p1Slot] {
				t.Fatalf("expected sticky channel %d for pilot %d in OQ-3, got %d", oq1ChByPilot[p1Slot], p1Slot, s.Channel)
			}
		}
	}
	if !foundSticky {
		t.Fatalf("pilot %d not found in OQ-3", p1Slot)
	}

	// Enforcing MaxPacksPerPilot == 2: queuing a 3rd pack for `p1Slot` must fail!
	if _, err := e.BracketEditAction(BracketEditPayload{
		Action:         "open_qual_enqueue",
		PilotSlotIndex: p1Slot,
	}); err == nil {
		t.Fatalf("expected MaxPacksPerPilot (2) cap error when queuing 3rd pack for pilot %d", p1Slot)
	}

	// Dequeue `p1Slot` from OQ-3 -> cleans up empty trailing OQ-3 pack
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:         "open_qual_dequeue",
		HeatID:         "OQ-3",
		PilotSlotIndex: p1Slot,
	})
	if err != nil {
		t.Fatalf("open_qual_dequeue failed: %v", err)
	}
	if len(st.Heats) != 2 {
		t.Fatalf("expected empty OQ-3 cleaned up after dequeue, got %d heats", len(st.Heats))
	}

	// Export CSV and verify headers + pilot row
	filename, csvText, err := e.ExportRaceResultsCSV(st.RaceID, 1)
	if err != nil {
		t.Fatalf("ExportRaceResultsCSV failed: %v", err)
	}
	if !strings.HasSuffix(filename, ".csv") {
		t.Fatalf("expected .csv filename, got %q", filename)
	}
	if !strings.Contains(csvText, "Rank,Callsign,PhoneticName,Seed,Status,Best3ConsecutiveSec,BestLapSec") {
		t.Fatalf("missing CSV header in:\n%s", csvText)
	}
	if !strings.Contains(csvText, "FAERRY") {
		t.Fatalf("expected FAERRY in CSV export:\n%s", csvText)
	}

	// Complete the Open Qualifier race explicitly
	st, err = e.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		LifecycleAction: "complete_race",
	})
	if err != nil {
		t.Fatalf("complete_race failed: %v", err)
	}
	if !st.IsComplete || st.Lifecycle != domain.LifecycleCompleted {
		t.Fatalf("expected completed race after complete_race, got IsComplete=%v Lifecycle=%s", st.IsComplete, st.Lifecycle)
	}

	// Moving "Flight Line Packs" (`stage-1-open-qual`) persists sub-pixel coordinates even in Control / completed view
	oqRoundID := domain.OpenQualRoundID(1)
	st, err = e.BracketEditAction(BracketEditPayload{
		Action: "move_rounds",
		Positions: []RoundPositionUpdate{
			{RoundID: oqRoundID, PosX: 712.5, PosY: 164.5},
		},
	})
	if err != nil {
		t.Fatalf("move_rounds Flight Line Packs failed: %v", err)
	}
	var movedOQ *domain.RaceRound
	for i := range st.Rounds {
		if st.Rounds[i].ID == oqRoundID {
			movedOQ = &st.Rounds[i]
			break
		}
	}
	if movedOQ == nil || !movedOQ.HasPos || movedOQ.PosX != 712.5 || movedOQ.PosY != 164.5 {
		t.Fatalf("expected Flight Line Packs (%s) at (712.5, 164.5), got %+v", oqRoundID, movedOQ)
	}

	// Clamping against Control's top boundary sets canonical PosY == 0; verify JSON round-trip preserves HasPos && (837.1, 0)
	st, err = e.BracketEditAction(BracketEditPayload{
		Action: "move_rounds",
		Positions: []RoundPositionUpdate{
			{RoundID: oqRoundID, PosX: 837.1, PosY: 0},
		},
	})
	if err != nil {
		t.Fatalf("move_rounds Flight Line Packs to (837.1, 0) failed: %v", err)
	}
	rawJSON, err := json.Marshal(st)
	if err != nil {
		t.Fatalf("json.Marshal(st) failed: %v", err)
	}
	var decoded domain.RaceTournamentState
	if err := json.Unmarshal(rawJSON, &decoded); err != nil {
		t.Fatalf("json.Unmarshal(st) failed: %v", err)
	}
	var decodedOQ *domain.RaceRound
	for i := range decoded.Rounds {
		if decoded.Rounds[i].ID == oqRoundID {
			decodedOQ = &decoded.Rounds[i]
			break
		}
	}
	if decodedOQ == nil || !decodedOQ.HasPos || decodedOQ.PosX != 837.1 || decodedOQ.PosY != 0 {
		t.Fatalf("expected JSON-decoded Flight Line Packs (%s) at HasPos=true (837.1, 0), got %+v", oqRoundID, decodedOQ)
	}
}

func TestOpenQualifierFairRotationAwayDequeueAndCloseStage(t *testing.T) {
	// Part 1: 2-Stage Open Qualifier -> Single Elimination
	e := seedEngineWithPilots(t, 6)
	st, err := e.BracketEditAction(BracketEditPayload{
		Action:        "apply_template",
		TemplateID:    "open_qualifier",
		PilotsPerHeat: 2,
		TimeLimitSec:  120,
	})
	if err != nil {
		t.Fatalf("apply_template open_qualifier: %v", err)
	}
	// Add downstream Stage 2 (Single Elimination) and connect Stage 1 -> Stage 2
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:      "add_stage",
		StageFormat: domain.FormatSingleElimination,
	})
	if err != nil {
		t.Fatalf("add_stage single_elimination: %v", err)
	}
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:         "connect_stages",
		FromStageIndex: 1,
		ToStageIndex:   2,
		LinkMode:       "top_n",
		AdvanceCount:   4,
	})
	if err != nil {
		t.Fatalf("connect_stages 1->2: %v", err)
	}

	e.mu.Lock()
	e.raceState.Config.CountdownSec = 0
	e.mu.Unlock()

	// Enqueue pilots 1 and 2 into OQ-1, run & confirm OQ-1
	for _, slot := range []int{1, 2} {
		if _, err := e.BracketEditAction(BracketEditPayload{
			Action:         "open_qual_enqueue",
			PilotSlotIndex: slot,
		}); err != nil {
			t.Fatalf("enqueue slot %d: %v", slot, err)
		}
	}
	if _, err := e.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		LifecycleAction: "start_race",
	}); err != nil {
		t.Fatalf("start_race: %v", err)
	}
	if _, err := e.RaceControlAction("start", "OQ-1"); err != nil {
		t.Fatalf("start OQ-1: %v", err)
	}
	for _, slot := range []int{1, 2} {
		for lap := 0; lap < 4; lap++ {
			e.mu.Lock()
			e.bootTime = e.bootTime.Add(-12 * time.Second)
			e.mu.Unlock()
			if _, err := e.MarshalPilotAction(RaceMarshalPayload{
				HeatID:         "OQ-1",
				PilotSlotIndex: slot,
				Action:         "add_lap",
			}); err != nil {
				t.Fatalf("add_lap slot %d: %v", slot, err)
			}
		}
	}
	if _, err := e.RaceControlAction("stop", "OQ-1"); err != nil {
		t.Fatalf("stop OQ-1: %v", err)
	}
	st, err = e.RaceControlAction("confirm", "OQ-1")
	if err != nil {
		t.Fatalf("confirm OQ-1: %v", err)
	}

	// Queue All Ready: never-flown pilots (3, 4, 5, 6) MUST be queued ahead of recently-flown pilots (1, 2)!
	st, err = e.BracketEditAction(BracketEditPayload{
		Action: "open_qual_enqueue_all",
	})
	if err != nil {
		t.Fatalf("open_qual_enqueue_all: %v", err)
	}
	// Expect OQ-1 (confirmed), OQ-2 (pilots 3 & 4), OQ-3 (pilots 5 & 6), OQ-4 (pilots 1 & 2)
	var s1Heats []domain.RaceHeat
	for _, h := range st.Heats {
		if h.StageIndex == 1 {
			s1Heats = append(s1Heats, h)
		}
	}
	if len(s1Heats) != 4 {
		t.Fatalf("expected 4 Stage 1 heats (OQ-1..OQ-4), got %d", len(s1Heats))
	}
	for _, s := range s1Heats[3].Seats {
		if s.PilotSlotIndex != 1 && s.PilotSlotIndex != 2 {
			t.Fatalf("expected recently-flown pilots 1 & 2 rotated to final pack OQ-4, found slot %d in OQ-4", s.PilotSlotIndex)
		}
	}
	if st.ActiveHeatID != "OQ-2" {
		t.Fatalf("expected ActiveHeatID=OQ-2, got %s", st.ActiveHeatID)
	}

	// Mark pilots 3 and 4 (currently staged in OQ-2) as Away -> must auto-dequeue both, clean up OQ-2, and promote OQ-3 to ActiveHeatID!
	tr := true
	for _, slot := range []int{3, 4} {
		st, err = e.EventAction(EventActionPayload{
			Action:     "update_attendance",
			SlotIndex:  slot,
			CheckedIn:  &tr,
			Attendance: domain.AttendanceAway,
		})
		if err != nil {
			t.Fatalf("mark slot %d away: %v", slot, err)
		}
	}
	if st.ActiveHeatID != "OQ-3" {
		t.Fatalf("expected OQ-3 promoted to ActiveHeatID after marking OQ-2 pilots away, got %s", st.ActiveHeatID)
	}

	// Close Stage 1 via complete_stage_early -> discards unstarted OQ-3/OQ-4, seeds Stage 2, advances ActiveStageIndex to 2!
	st, err = e.EventAction(EventActionPayload{
		Action:      "stage_control",
		StageAction: "complete_stage_early",
		StageIndex:  1,
	})
	if err != nil {
		t.Fatalf("complete_stage_early on Stage 1: %v", err)
	}
	for _, h := range st.Heats {
		if h.StageIndex == 1 && h.State != domain.HeatConfirmed {
			t.Fatalf("expected unstarted Stage 1 pack %s (%s) discarded when closing Open Qualifier stage", h.ID, h.State)
		}
	}
	if st.ActiveStageIndex != 2 {
		t.Fatalf("expected ActiveStageIndex=2 after closing Stage 1, got %d", st.ActiveStageIndex)
	}
	if st.Stages[0].Status != domain.StageStatusCompleted {
		t.Fatalf("expected Stage 1 status=completed, got %s", st.Stages[0].Status)
	}
	activeHeat := domain.RaceHeat{}
	for _, h := range st.Heats {
		if h.ID == st.ActiveHeatID {
			activeHeat = h
		}
	}
	if activeHeat.StageIndex != 2 {
		t.Fatalf("expected ActiveHeatID (%s) in Stage 2, got stage %d", st.ActiveHeatID, activeHeat.StageIndex)
	}

	// Part 2: Single-Stage Open Qualifier Close Stage -> marks race completed, and reopen_race reopens cleanly!
	e2 := seedEngineWithPilots(t, 4)
	if _, err := e2.BracketEditAction(BracketEditPayload{
		Action:        "apply_template",
		TemplateID:    "open_qualifier",
		PilotsPerHeat: 2,
		TimeLimitSec:  120,
	}); err != nil {
		t.Fatalf("e2 apply_template: %v", err)
	}
	e2.mu.Lock()
	e2.raceState.Config.CountdownSec = 0
	e2.mu.Unlock()
	if _, err := e2.BracketEditAction(BracketEditPayload{Action: "open_qual_enqueue_all"}); err != nil {
		t.Fatalf("e2 enqueue_all: %v", err)
	}
	if _, err := e2.RaceControlAction("start", "OQ-1"); err != nil {
		t.Fatalf("e2 start OQ-1: %v", err)
	}
	if _, err := e2.MarshalPilotAction(RaceMarshalPayload{HeatID: "OQ-1", PilotSlotIndex: 1, Action: "add_lap"}); err != nil {
		t.Fatalf("e2 add_lap: %v", err)
	}
	if _, err := e2.RaceControlAction("stop", "OQ-1"); err != nil {
		t.Fatalf("e2 stop OQ-1: %v", err)
	}
	if _, err := e2.RaceControlAction("confirm", "OQ-1"); err != nil {
		t.Fatalf("e2 confirm OQ-1: %v", err)
	}
	st2, err := e2.EventAction(EventActionPayload{
		Action:      "stage_control",
		StageAction: "complete_stage_early",
		StageIndex:  1,
	})
	if err != nil {
		t.Fatalf("e2 complete_stage_early: %v", err)
	}
	if !st2.IsComplete || st2.Lifecycle != domain.LifecycleCompleted {
		t.Fatalf("expected single-stage OQ to complete race on close stage, got IsComplete=%v Lifecycle=%s", st2.IsComplete, st2.Lifecycle)
	}
	st2, err = e2.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		LifecycleAction: "reopen_race",
	})
	if err != nil {
		t.Fatalf("e2 reopen_race: %v", err)
	}
	if st2.IsComplete || st2.Lifecycle == domain.LifecycleCompleted || st2.Stages[0].CompletedEarly {
		t.Fatalf("expected single-stage OQ reopened cleanly, got IsComplete=%v Lifecycle=%s CompletedEarly=%v", st2.IsComplete, st2.Lifecycle, st2.Stages[0].CompletedEarly)
	}
}

func TestReopenRaceOnCompletedBracketAndChaseTheAce(t *testing.T) {
	// Part 1: Qualifying / Round Robin tournament completes when final heat is confirmed -> reopen_race unlocks it and reopens stage & race!
	e := seedEngineWithPilots(t, 4)
	st, err := e.BracketEditAction(BracketEditPayload{
		Action:           "apply_template",
		TemplateID:       "round_robin",
		PilotsPerHeat:    4,
		QualifyingRounds: 1,
		TargetLaps:       3,
		TimeLimitSec:     120,
	})
	if err != nil {
		t.Fatalf("apply_template round_robin: %v", err)
	}
	e.mu.Lock()
	e.raceState.Config.CountdownSec = 0
	e.mu.Unlock()

	finalHID := st.ActiveHeatID
	if finalHID == "" && len(st.Heats) > 0 {
		finalHID = st.Heats[0].ID
	}
	if _, err := e.RaceControlAction("start", finalHID); err != nil {
		t.Fatalf("start %s: %v", finalHID, err)
	}
	if _, err := e.MarshalPilotAction(RaceMarshalPayload{HeatID: finalHID, PilotSlotIndex: 1, Action: "add_lap"}); err != nil {
		t.Fatalf("add_lap %s: %v", finalHID, err)
	}
	if _, err := e.RaceControlAction("stop", finalHID); err != nil {
		t.Fatalf("stop %s: %v", finalHID, err)
	}
	st, err = e.RaceControlAction("confirm", finalHID)
	if err != nil {
		t.Fatalf("confirm %s: %v", finalHID, err)
	}
	if !st.IsComplete || st.Lifecycle != domain.LifecycleCompleted || st.Stages[0].Status != domain.StageStatusCompleted {
		t.Fatalf("expected completed tournament after %s confirm, got IsComplete=%v Lifecycle=%s StageStatus=%s", finalHID, st.IsComplete, st.Lifecycle, st.Stages[0].Status)
	}

	// Reopen the completed race
	st, err = e.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          st.RaceID,
		LifecycleAction: "reopen_race",
	})
	if err != nil {
		t.Fatalf("reopen_race single_elimination: %v", err)
	}
	if st.IsComplete || st.Lifecycle != domain.LifecycleActive {
		t.Fatalf("expected race reopened to active, got IsComplete=%v Lifecycle=%s", st.IsComplete, st.Lifecycle)
	}
	if len(st.Stages) == 0 || st.Stages[0].Status != domain.StageStatusActive {
		t.Fatalf("expected Stage 1 reopened to active, got %+v", st.Stages)
	}
	if st.ActiveHeatID != finalHID {
		t.Fatalf("expected ActiveHeatID=%s after reopen, got %q", finalHID, st.ActiveHeatID)
	}
	var gf *domain.RaceHeat
	for i := range st.Heats {
		if st.Heats[i].ID == finalHID {
			gf = &st.Heats[i]
			break
		}
	}
	if gf == nil || gf.State != domain.HeatFinished {
		t.Fatalf("expected %s unlocked to HeatFinished (Review), got %+v", finalHID, gf)
	}

	// Controller can edit laps or re-confirm finalHID cleanly
	if _, err := e.MarshalPilotAction(RaceMarshalPayload{HeatID: finalHID, PilotSlotIndex: 2, Action: "add_lap"}); err != nil {
		t.Fatalf("marshal edit after reopen: %v", err)
	}
	st, err = e.RaceControlAction("confirm", finalHID)
	if err != nil {
		t.Fatalf("re-confirm %s: %v", finalHID, err)
	}
	if !st.IsComplete || st.Lifecycle != domain.LifecycleCompleted {
		t.Fatalf("expected re-confirming %s to complete race again, got IsComplete=%v Lifecycle=%s", finalHID, st.IsComplete, st.Lifecycle)
	}

	// Part 2: Chase the Ace tournament completes on CTA-2 -> reopen_race unlocks CTA-2 while keeping CTA-1 confirmed!
	e2 := seedEngineWithPilots(t, 4)
	if _, err := e2.BracketEditAction(BracketEditPayload{
		Action:        "apply_template",
		TemplateID:    "chase_the_ace",
		PilotsPerHeat: 4,
		TargetLaps:    2,
		TimeLimitSec:  120,
	}); err != nil {
		t.Fatalf("apply_template chase_the_ace: %v", err)
	}
	e2.mu.Lock()
	e2.raceState.Config.CountdownSec = 0
	e2.mu.Unlock()

	for _, hid := range []string{"CTA-1", "CTA-2"} {
		if _, err := e2.RaceControlAction("start", hid); err != nil {
			t.Fatalf("start %s: %v", hid, err)
		}
		if _, err := e2.MarshalPilotAction(RaceMarshalPayload{HeatID: hid, PilotSlotIndex: 1, Action: "add_lap"}); err != nil {
			t.Fatalf("add_lap %s: %v", hid, err)
		}
		if _, err := e2.RaceControlAction("stop", hid); err != nil {
			t.Fatalf("stop %s: %v", hid, err)
		}
		st, err = e2.RaceControlAction("confirm", hid)
		if err != nil {
			t.Fatalf("confirm %s: %v", hid, err)
		}
	}
	if !st.IsComplete || st.Lifecycle != domain.LifecycleCompleted {
		t.Fatalf("expected CTA completed after 2 wins, got IsComplete=%v Lifecycle=%s", st.IsComplete, st.Lifecycle)
	}

	st, err = e2.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          st.RaceID,
		LifecycleAction: "reopen_race",
	})
	if err != nil {
		t.Fatalf("reopen_race chase_the_ace: %v", err)
	}
	if st.IsComplete || st.Lifecycle != domain.LifecycleActive || st.Stages[0].Status != domain.StageStatusActive {
		t.Fatalf("expected CTA reopened cleanly, got IsComplete=%v Lifecycle=%s StageStatus=%s", st.IsComplete, st.Lifecycle, st.Stages[0].Status)
	}
	if st.ActiveHeatID != "CTA-2" {
		t.Fatalf("expected ActiveHeatID=CTA-2 on CTA reopen, got %q", st.ActiveHeatID)
	}
	for _, h := range st.Heats {
		if h.ID == "CTA-1" && h.State != domain.HeatConfirmed {
			t.Fatalf("expected CTA-1 to remain confirmed, got %s", h.State)
		}
		if h.ID == "CTA-2" && h.State != domain.HeatFinished {
			t.Fatalf("expected CTA-2 unlocked to finished, got %s", h.State)
		}
	}
}
