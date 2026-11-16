package tracker

import (
	"testing"

	"slaprf/internal/domain"
	"slaprf/internal/race"
)

func TestMarshalOverridePreservesStateAndCrossesOutLaps(t *testing.T) {
	eng := NewEngine()
	cfg := domain.DefaultRaceSetupConfig()
	cfg.EventName = "Marshal Override Test"
	cfg.TargetLaps = 3
	cfg.CountdownSec = 0
	st := eng.ConfigureAndGenerateRace(cfg, true)

	heatID := st.Heats[0].ID
	pilot1 := st.Heats[0].Seats[0].PilotSlotIndex
	pilot2 := st.Heats[0].Seats[1].PilotSlotIndex

	if _, err := eng.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          st.RaceID,
		LifecycleAction: "start_race",
	}); err != nil {
		t.Fatalf("start_race: %v", err)
	}
	if _, err := eng.RaceControlAction("start", heatID); err != nil {
		t.Fatalf("start heat: %v", err)
	}

	// Give pilot1 3 completed laps (Finished) and pilot2 1 completed lap (will become natural DNF on stop).
	for lap := 0; lap < 3; lap++ {
		if _, err := eng.MarshalPilotAction(RaceMarshalPayload{
			HeatID:         heatID,
			PilotSlotIndex: pilot1,
			Action:         "add_lap",
		}); err != nil {
			t.Fatalf("pilot1 add_lap %d: %v", lap+1, err)
		}
	}
	if _, err := eng.MarshalPilotAction(RaceMarshalPayload{
		HeatID:         heatID,
		PilotSlotIndex: pilot2,
		Action:         "add_lap",
	}); err != nil {
		t.Fatalf("pilot2 add_lap: %v", err)
	}

	// Stop and Confirm heat (simulating Heat Review on a committed heat!).
	if _, err := eng.RaceControlAction("stop", heatID); err != nil {
		t.Fatalf("stop heat: %v", err)
	}
	st, err := eng.RaceControlAction("confirm", heatID)
	if err != nil {
		t.Fatalf("confirm heat: %v", err)
	}

	findSeat := func(state domain.RaceTournamentState, slot int) domain.HeatSeat {
		for _, h := range state.Heats {
			if h.ID == heatID {
				for _, s := range h.Seats {
					if s.PilotSlotIndex == slot {
						return s
					}
				}
			}
		}
		t.Fatalf("seat for slot %d not found", slot)
		return domain.HeatSeat{}
	}

	s1 := findSeat(st, pilot1)
	if s1.Status != domain.PilotHeatFinished || s1.LapsCompleted != 3 || len(s1.Laps) != 4 {
		t.Fatalf("expected pilot1 Finished with 3 laps (4 passes incl HS), got status=%s completed=%d laps=%d", s1.Status, s1.LapsCompleted, len(s1.Laps))
	}

	// Confirmed heats are locked until switched to Review ("unlock").
	droppedCrossingID := s1.Laps[2].CrossingID
	if _, err := eng.MarshalPilotAction(RaceMarshalPayload{
		HeatID:         heatID,
		PilotSlotIndex: pilot1,
		Action:         "toggle_lap",
		CrossingID:     droppedCrossingID,
	}); err == nil {
		t.Fatalf("expected MarshalPilotAction on confirmed heat to be rejected until unlocked")
	}
	if _, err := eng.RaceControlAction("unlock", heatID); err != nil {
		t.Fatalf("unlock confirmed heat: %v", err)
	}

	// 1. Individually drop Lap 3 first, then add another lap so pilot1 still has 3 valid laps + 1 individually dropped pass.
	if _, err := eng.MarshalPilotAction(RaceMarshalPayload{
		HeatID:         heatID,
		PilotSlotIndex: pilot1,
		Action:         "toggle_lap",
		CrossingID:     droppedCrossingID,
	}); err != nil {
		t.Fatalf("toggle_lap: %v", err)
	}
	st, err = eng.MarshalPilotAction(RaceMarshalPayload{
		HeatID:         heatID,
		PilotSlotIndex: pilot1,
		Action:         "add_lap",
	})
	if err != nil {
		t.Fatalf("add replacement lap: %v", err)
	}
	s1 = findSeat(st, pilot1)
	if s1.Status != domain.PilotHeatFinished || s1.LapsCompleted != 3 || len(s1.Laps) != 5 {
		t.Fatalf("expected pilot1 Finished with 3 valid laps and 5 total pass chips, got status=%s completed=%d chips=%d", s1.Status, s1.LapsCompleted, len(s1.Laps))
	}

	// 2. Crash Out pilot1 -> switch directly to DQ -> verify mutually-exclusive override, laps preserved & all crossed out!
	st, err = eng.MarshalPilotAction(RaceMarshalPayload{
		HeatID:         heatID,
		PilotSlotIndex: pilot1,
		Action:         "toggle_dnf",
	})
	if err != nil {
		t.Fatalf("toggle_dnf on: %v", err)
	}
	s1 = findSeat(st, pilot1)
	if s1.Status != domain.PilotHeatDNF {
		t.Fatalf("expected DNF, got %s", s1.Status)
	}
	if len(s1.Laps) != 5 {
		t.Fatalf("expected all 5 lap chips preserved on Crash Out, got %d", len(s1.Laps))
	}
	for idx, l := range s1.Laps {
		if !l.Invalidated {
			t.Fatalf("expected lap chip %d to be crossed out during Crash Out", idx)
		}
	}

	// Switch directly from Crash Out to DQ (0-or-1 toggle group): PreOverrideStatus must stay PilotHeatFinished!
	st, err = eng.MarshalPilotAction(RaceMarshalPayload{
		HeatID:         heatID,
		PilotSlotIndex: pilot1,
		Action:         "toggle_dq",
	})
	if err != nil {
		t.Fatalf("toggle_dq on: %v", err)
	}
	s1 = findSeat(st, pilot1)
	if s1.Status != domain.PilotHeatDQ || s1.LapsCompleted != 0 {
		t.Fatalf("expected DQ with 0 counted laps, got status=%s completed=%d", s1.Status, s1.LapsCompleted)
	}
	if len(s1.Laps) != 5 {
		t.Fatalf("expected all 5 lap chips preserved on DQ, got %d", len(s1.Laps))
	}
	for idx, l := range s1.Laps {
		if !l.Invalidated {
			t.Fatalf("expected lap chip %d to be crossed out during DQ", idx)
		}
		if idx > 0 && l.SplitTimeSec <= 0 {
			t.Fatalf("expected positive splitTimeSec preserved on crossed-out chip %d, got %.3f", idx, l.SplitTimeSec)
		}
	}

	// 3. Un-DQ pilot1 on the Confirmed heat -> must restore PilotHeatFinished (NOT Staged!) and valid laps,
	// while keeping the individually dropped crossing invalidated!
	st, err = eng.MarshalPilotAction(RaceMarshalPayload{
		HeatID:         heatID,
		PilotSlotIndex: pilot1,
		Action:         "toggle_dq",
	})
	if err != nil {
		t.Fatalf("toggle_dq off: %v", err)
	}
	s1 = findSeat(st, pilot1)
	if s1.Status != domain.PilotHeatFinished {
		t.Fatalf("expected restored status Finished (not Staged!), got %s", s1.Status)
	}
	if s1.LapsCompleted != 3 || len(s1.Laps) != 5 {
		t.Fatalf("expected 3 valid laps and 5 chips restored, got completed=%d chips=%d", s1.LapsCompleted, len(s1.Laps))
	}
	validCount := 0
	indivDropped := 0
	for _, l := range s1.Laps {
		if l.CrossingID == droppedCrossingID {
			if !l.Invalidated {
				t.Fatalf("expected individually dropped crossing to remain invalidated after un-DQ")
			}
			indivDropped++
		} else if !l.Invalidated {
			validCount++
		}
	}
	if validCount != 4 || indivDropped != 1 {
		t.Fatalf("expected 4 valid chips (HS+3 laps) and 1 individually dropped chip, got valid=%d dropped=%d", validCount, indivDropped)
	}

	// 4. Pilot2 had natural DNF (1/3 laps when heat stopped). DQ pilot2 then un-DQ pilot2 -> must restore natural DNF (not Staged!).
	s2 := findSeat(st, pilot2)
	if s2.Status != domain.PilotHeatDNF {
		t.Fatalf("expected pilot2 natural DNF before DQ, got %s", s2.Status)
	}
	if _, err := eng.MarshalPilotAction(RaceMarshalPayload{
		HeatID:         heatID,
		PilotSlotIndex: pilot2,
		Action:         "toggle_dq",
	}); err != nil {
		t.Fatalf("pilot2 toggle_dq on: %v", err)
	}
	st, err = eng.MarshalPilotAction(RaceMarshalPayload{
		HeatID:         heatID,
		PilotSlotIndex: pilot2,
		Action:         "toggle_dq",
	})
	if err != nil {
		t.Fatalf("pilot2 toggle_dq off: %v", err)
	}
	s2 = findSeat(st, pilot2)
	if s2.Status != domain.PilotHeatDNF {
		t.Fatalf("expected pilot2 restored to original committed state DNF (not Staged!), got %s", s2.Status)
	}
	if len(s2.Laps) != 2 {
		t.Fatalf("expected pilot2 2 pass chips preserved, got %d", len(s2.Laps))
	}
}

func TestRecomputeBackfillsCrossingsFromLegacyLaps(t *testing.T) {
	h := domain.RaceHeat{
		ID:          "W1-1",
		StartMode:   domain.StartModeHeadsUp,
		TargetLaps:  2,
		StartToneUs: 1_000_000,
		State:       domain.HeatConfirmed,
		Seats: []domain.HeatSeat{
			{
				SeatIndex:      1,
				PilotSlotIndex: 1,
				Callsign:       "ALPHA",
				Status:         domain.PilotHeatDQ,
				Crossings:      nil, // Simulate legacy seat without raw Crossings
				Laps: []domain.HeatLap{
					{CrossingID: 10, LapNumber: 0, SplitTimeSec: 0.75},
					{CrossingID: 11, LapNumber: 1, SplitTimeSec: 11.25},
					{CrossingID: 12, LapNumber: 2, SplitTimeSec: 11.50},
				},
			},
		},
	}
	race.RecomputeHeat(&h, domain.QualMetricConsecutive3)
	if len(h.Seats[0].Laps) != 3 {
		t.Fatalf("expected 3 laps preserved via backfill on DQ, got %d", len(h.Seats[0].Laps))
	}
	for i, l := range h.Seats[0].Laps {
		if !l.Invalidated {
			t.Fatalf("expected lap %d crossed out on DQ", i)
		}
	}
	h.Seats[0].Status = domain.PilotHeatFinished
	race.RecomputeHeat(&h, domain.QualMetricConsecutive3)
	if h.Seats[0].LapsCompleted != 2 || h.Seats[0].Laps[1].Invalidated || h.Seats[0].Laps[2].Invalidated {
		t.Fatalf("expected 2 valid laps restored after un-DQ, got completed=%d laps=%+v", h.Seats[0].LapsCompleted, h.Seats[0].Laps)
	}
}

func TestScratchingSingleLapPreservesRemainingLapsWithoutCrashOut(t *testing.T) {
	eng := NewEngine()
	cfg := domain.DefaultRaceSetupConfig()
	cfg.EventName = "Single Elim Scratch Lap Test"
	cfg.MainFormat = domain.FormatSingleElimination
	cfg.TargetLaps = 3
	cfg.CountdownSec = 0
	st := eng.ConfigureAndGenerateRace(cfg, true)

	heatID := st.Heats[0].ID
	pilot1 := st.Heats[0].Seats[0].PilotSlotIndex

	if _, err := eng.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          st.RaceID,
		LifecycleAction: "start_race",
	}); err != nil {
		t.Fatalf("start_race: %v", err)
	}
	if _, err := eng.RaceControlAction("start", heatID); err != nil {
		t.Fatalf("start heat: %v", err)
	}
	for lap := 0; lap < 3; lap++ {
		if _, err := eng.MarshalPilotAction(RaceMarshalPayload{
			HeatID:         heatID,
			PilotSlotIndex: pilot1,
			Action:         "add_lap",
		}); err != nil {
			t.Fatalf("add_lap %d: %v", lap+1, err)
		}
	}
	if _, err := eng.RaceControlAction("stop", heatID); err != nil {
		t.Fatalf("stop heat: %v", err)
	}
	st, err := eng.RaceControlAction("confirm", heatID)
	if err != nil {
		t.Fatalf("confirm heat: %v", err)
	}

	findSeat := func(state domain.RaceTournamentState) domain.HeatSeat {
		for _, h := range state.Heats {
			if h.ID == heatID {
				for _, s := range h.Seats {
					if s.PilotSlotIndex == pilot1 {
						return s
					}
				}
			}
		}
		t.Fatalf("seat not found")
		return domain.HeatSeat{}
	}

	s := findSeat(st)
	if s.Status != domain.PilotHeatFinished || s.LapsCompleted != 3 || len(s.Laps) != 4 {
		t.Fatalf("expected Finished with 3 laps (4 passes), got status=%s completed=%d passes=%d", s.Status, s.LapsCompleted, len(s.Laps))
	}

	// Scratch a single lap (L2) in Heat Review -> first unlock to Review, then toggle_lap ->
	// drops below TargetLaps=3 so status becomes natural DNF,
	// StatusOverridden MUST stay false, and all OTHER passes MUST remain valid (not crossed out)!
	if _, err := eng.RaceControlAction("unlock", heatID); err != nil {
		t.Fatalf("unlock heat for review: %v", err)
	}
	scratchedID := s.Laps[2].CrossingID
	st, err = eng.MarshalPilotAction(RaceMarshalPayload{
		HeatID:         heatID,
		PilotSlotIndex: pilot1,
		Action:         "toggle_lap",
		CrossingID:     scratchedID,
	})
	if err != nil {
		t.Fatalf("scratch single lap: %v", err)
	}
	s = findSeat(st)
	if s.Status != domain.PilotHeatDNF || s.StatusOverridden {
		t.Fatalf("expected natural DNF with StatusOverridden=false, got status=%s overridden=%v", s.Status, s.StatusOverridden)
	}
	if s.LapsCompleted != 2 {
		t.Fatalf("expected 2 valid laps preserved after scratching 1 lap, got %d", s.LapsCompleted)
	}
	for _, l := range s.Laps {
		if l.CrossingID == scratchedID {
			if !l.Invalidated {
				t.Fatalf("expected scratched crossing %d to be invalidated", scratchedID)
			}
		} else if l.Invalidated {
			t.Fatalf("expected non-scratched crossing %d to remain valid, got invalidated", l.CrossingID)
		}
	}

	// Now explicitly toggle Crash Out (DNF) ON -> StatusOverridden becomes true and ALL passes cross out!
	st, err = eng.MarshalPilotAction(RaceMarshalPayload{
		HeatID:         heatID,
		PilotSlotIndex: pilot1,
		Action:         "toggle_dnf",
	})
	if err != nil {
		t.Fatalf("toggle_dnf ON: %v", err)
	}
	s = findSeat(st)
	if s.Status != domain.PilotHeatDNF || !s.StatusOverridden || s.LapsCompleted != 2 {
		t.Fatalf("expected explicit DNF override preserving 2 counted laps for DNF tie-breaking, got status=%s overridden=%v laps=%d", s.Status, s.StatusOverridden, s.LapsCompleted)
	}
	for _, l := range s.Laps {
		if !l.Invalidated {
			t.Fatalf("expected all passes crossed out during explicit Crash Out, crossing %d was valid", l.CrossingID)
		}
	}

	// Toggle Crash Out OFF -> restores natural incomplete (2/3 valid laps, only scratchedID invalidated)!
	st, err = eng.MarshalPilotAction(RaceMarshalPayload{
		HeatID:         heatID,
		PilotSlotIndex: pilot1,
		Action:         "toggle_dnf",
	})
	if err != nil {
		t.Fatalf("toggle_dnf OFF: %v", err)
	}
	s = findSeat(st)
	if s.Status != domain.PilotHeatDNF || s.StatusOverridden || s.LapsCompleted != 2 {
		t.Fatalf("expected natural incomplete (2 laps, StatusOverridden=false) after un-crashing, got status=%s overridden=%v laps=%d", s.Status, s.StatusOverridden, s.LapsCompleted)
	}

	// Un-scratch the single lap -> back to Finished with 3/3 laps!
	st, err = eng.MarshalPilotAction(RaceMarshalPayload{
		HeatID:         heatID,
		PilotSlotIndex: pilot1,
		Action:         "toggle_lap",
		CrossingID:     scratchedID,
	})
	if err != nil {
		t.Fatalf("restore single lap: %v", err)
	}
	s = findSeat(st)
	if s.Status != domain.PilotHeatFinished || s.StatusOverridden || s.LapsCompleted != 3 {
		t.Fatalf("expected Finished with 3/3 laps after restoring single lap, got status=%s overridden=%v laps=%d", s.Status, s.StatusOverridden, s.LapsCompleted)
	}
}

func TestMarshalDeterministicSetStatusActions(t *testing.T) {
	eng := NewEngine()
	cfg := domain.DefaultRaceSetupConfig()
	cfg.EventName = "Deterministic Status Dropdown Test"
	cfg.TargetLaps = 2
	cfg.CountdownSec = 0
	st := eng.ConfigureAndGenerateRace(cfg, true)

	heatID := st.Heats[0].ID
	pilot1 := st.Heats[0].Seats[0].PilotSlotIndex

	if _, err := eng.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          st.RaceID,
		LifecycleAction: "start_race",
	}); err != nil {
		t.Fatalf("start_race: %v", err)
	}
	if _, err := eng.RaceControlAction("start", heatID); err != nil {
		t.Fatalf("start heat: %v", err)
	}
	for lap := 0; lap < 2; lap++ {
		if _, err := eng.MarshalPilotAction(RaceMarshalPayload{
			HeatID:         heatID,
			PilotSlotIndex: pilot1,
			Action:         "add_lap",
		}); err != nil {
			t.Fatalf("add_lap %d: %v", lap+1, err)
		}
	}
	if _, err := eng.RaceControlAction("stop", heatID); err != nil {
		t.Fatalf("stop heat: %v", err)
	}

	getSeat := func(state domain.RaceTournamentState) domain.HeatSeat {
		for _, h := range state.Heats {
			if h.ID == heatID {
				for _, s := range h.Seats {
					if s.PilotSlotIndex == pilot1 {
						return s
					}
				}
			}
		}
		t.Fatalf("seat not found")
		return domain.HeatSeat{}
	}

	// set_dns twice is idempotent (stays DNS, unlike toggle_dns)
	for i := 0; i < 2; i++ {
		var err error
		st, err = eng.MarshalPilotAction(RaceMarshalPayload{
			HeatID:         heatID,
			PilotSlotIndex: pilot1,
			Action:         "set_dns",
		})
		if err != nil {
			t.Fatalf("set_dns #%d: %v", i+1, err)
		}
		if s := getSeat(st); s.Status != domain.PilotHeatDNS || !s.StatusOverridden {
			t.Fatalf("expected DNS overridden after set_dns #%d, got status=%s overridden=%v", i+1, s.Status, s.StatusOverridden)
		}
	}

	// set_dnf switches cleanly to explicit Crashed Out
	st, err := eng.MarshalPilotAction(RaceMarshalPayload{
		HeatID:         heatID,
		PilotSlotIndex: pilot1,
		Action:         "set_dnf",
	})
	if err != nil {
		t.Fatalf("set_dnf: %v", err)
	}
	if s := getSeat(st); s.Status != domain.PilotHeatDNF || !s.StatusOverridden {
		t.Fatalf("expected DNF overridden, got status=%s overridden=%v", s.Status, s.StatusOverridden)
	}

	// set_dq switches cleanly to Disqualified
	st, err = eng.MarshalPilotAction(RaceMarshalPayload{
		HeatID:         heatID,
		PilotSlotIndex: pilot1,
		Action:         "set_dq",
	})
	if err != nil {
		t.Fatalf("set_dq: %v", err)
	}
	if s := getSeat(st); s.Status != domain.PilotHeatDQ || !s.StatusOverridden {
		t.Fatalf("expected DQ overridden, got status=%s overridden=%v", s.Status, s.StatusOverridden)
	}

	// set_finished restores pilot to Finished with 2 valid laps and StatusOverridden=false
	st, err = eng.MarshalPilotAction(RaceMarshalPayload{
		HeatID:         heatID,
		PilotSlotIndex: pilot1,
		Action:         "set_finished",
	})
	if err != nil {
		t.Fatalf("set_finished: %v", err)
	}
	if s := getSeat(st); s.Status != domain.PilotHeatFinished || s.StatusOverridden || s.LapsCompleted != 2 {
		t.Fatalf("expected Finished (2 laps, overridden=false), got status=%s overridden=%v laps=%d", s.Status, s.StatusOverridden, s.LapsCompleted)
	}
}

func TestMarshalSetRacingRecoversPilotDuringActiveHeat(t *testing.T) {
	eng := NewEngine()
	cfg := domain.DefaultRaceSetupConfig()
	cfg.EventName = "Active Heat Racing Recovery Test"
	cfg.TargetLaps = 3
	cfg.CountdownSec = 0
	st := eng.ConfigureAndGenerateRace(cfg, true)

	heatID := st.Heats[0].ID
	pilot1 := st.Heats[0].Seats[0].PilotSlotIndex

	if _, err := eng.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          st.RaceID,
		LifecycleAction: "start_race",
	}); err != nil {
		t.Fatalf("start_race: %v", err)
	}
	if _, err := eng.RaceControlAction("start", heatID); err != nil {
		t.Fatalf("start heat: %v", err)
	}
	if _, err := eng.MarshalPilotAction(RaceMarshalPayload{
		HeatID:         heatID,
		PilotSlotIndex: pilot1,
		Action:         "add_lap",
	}); err != nil {
		t.Fatalf("add_lap: %v", err)
	}

	getSeat := func(state domain.RaceTournamentState) domain.HeatSeat {
		for _, h := range state.Heats {
			if h.ID == heatID {
				for _, s := range h.Seats {
					if s.PilotSlotIndex == pilot1 {
						return s
					}
				}
			}
		}
		t.Fatalf("seat not found")
		return domain.HeatSeat{}
	}

	// Mark pilot Crashed Out mid-heat
	st, err := eng.MarshalPilotAction(RaceMarshalPayload{
		HeatID:         heatID,
		PilotSlotIndex: pilot1,
		Action:         "set_dnf",
	})
	if err != nil {
		t.Fatalf("set_dnf mid-heat: %v", err)
	}
	if s := getSeat(st); s.Status != domain.PilotHeatDNF || !s.StatusOverridden {
		t.Fatalf("expected DNF overridden mid-heat, got status=%s overridden=%v", s.Status, s.StatusOverridden)
	}

	// Recover pilot back to Racing via set_racing while heat is still running
	st, err = eng.MarshalPilotAction(RaceMarshalPayload{
		HeatID:         heatID,
		PilotSlotIndex: pilot1,
		Action:         "set_racing",
	})
	if err != nil {
		t.Fatalf("set_racing mid-heat: %v", err)
	}
	if s := getSeat(st); s.Status != domain.PilotHeatRacing || s.StatusOverridden || s.LapsCompleted != 1 {
		t.Fatalf("expected Racing (1 lap, overridden=false) after set_racing mid-heat, got status=%s overridden=%v laps=%d", s.Status, s.StatusOverridden, s.LapsCompleted)
	}
}
