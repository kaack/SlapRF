package tracker

import (
	"testing"

	"slaprf/internal/domain"
)

func TestTopologicalStageReindexingAndNoFalseCompletion(t *testing.T) {
	eng := seedEngineWithPilots(t, 6)

	// 1. Add Single Elimination FIRST (becomes Stage 1 initially).
	cfg := domain.DefaultRaceSetupConfig()
	cfg.EventName = "Reverse Order Stages"
	cfg.Structure = domain.StructureSingleStage
	cfg.MainFormat = domain.FormatSingleElimination
	cfg.PilotsPerHeat = 4
	cfg.TargetLaps = 2
	cfg.TimeLimitSec = 90
	cfg.CountdownSec = 0
	st := eng.ConfigureAndGenerateRace(cfg, true)
	if len(st.Stages) != 1 || st.Stages[0].Format != domain.FormatSingleElimination {
		t.Fatalf("expected initial Single Elimination stage, got %+v", st.Stages)
	}
	elimStageID := st.Stages[0].ID

	// 2. Add Qualifying SECOND (without FromStageID so it is added after Single Elim initially).
	st, err := eng.BracketEditAction(BracketEditPayload{
		Action:           "add_stage",
		StageFormat:      domain.FormatQualifying,
		PilotsPerHeat:    4,
		QualifyingRounds: 1,
		TimeLimitSec:     60,
	})
	if err != nil {
		t.Fatalf("add_stage qualifying: %v", err)
	}
	var qualStageID string
	for _, s := range st.Stages {
		if s.Format == domain.FormatQualifying {
			qualStageID = s.ID
		}
	}
	if qualStageID == "" {
		t.Fatalf("qualifying stage ID not found")
	}

	// 3. Connect Qualifying -> Single Elimination.
	// Qualifying MUST become Stage 1 and Single Elimination MUST become Stage 2!
	st, err = eng.BracketEditAction(BracketEditPayload{
		Action:       "connect_stages",
		FromStageID:  qualStageID,
		ToStageID:    elimStageID,
		LinkMode:     "top_n",
		AdvanceCount: 4,
	})
	if err != nil {
		t.Fatalf("connect_stages: %v", err)
	}
	if len(st.Stages) != 2 {
		t.Fatalf("expected 2 stages, got %d", len(st.Stages))
	}
	if st.Stages[0].ID != qualStageID || st.Stages[0].Index != 1 || st.Stages[0].Format != domain.FormatQualifying {
		t.Fatalf("expected Qualifying to be Stage 1, got %+v", st.Stages[0])
	}
	if st.Stages[1].ID != elimStageID || st.Stages[1].Index != 2 || st.Stages[1].Format != domain.FormatSingleElimination {
		t.Fatalf("expected Single Elimination to be Stage 2, got %+v", st.Stages[1])
	}
	if st.ActiveStageIndex != 1 {
		t.Fatalf("expected ActiveStageIndex=1 (Qualifying), got %d", st.ActiveStageIndex)
	}
	if st.Stages[1].Status != domain.StageStatusPending {
		t.Fatalf("expected Stage 2 (Single Elim) to be Pending before Qualifying finishes, got %s", st.Stages[1].Status)
	}

	// 4. Start race and run + confirm all Stage 1 Qualifying heats.
	if _, err := eng.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          st.RaceID,
		LifecycleAction: "start_race",
	}); err != nil {
		t.Fatalf("start_race: %v", err)
	}

	for {
		var nextQualHeatID string
		for _, h := range st.Heats {
			if h.StageIndex == 1 && (h.State == domain.HeatReady || h.State == domain.HeatStaged) {
				nextQualHeatID = h.ID
				break
			}
		}
		if nextQualHeatID == "" {
			break
		}
		if _, err := eng.RaceControlAction("start", nextQualHeatID); err != nil {
			t.Fatalf("start qual heat %s: %v", nextQualHeatID, err)
		}
		// Give each seated pilot 2 laps so standings are populated.
		for _, h := range st.Heats {
			if h.ID == nextQualHeatID {
				for _, seat := range h.Seats {
					if seat.PilotSlotIndex > 0 {
						_, _ = eng.MarshalPilotAction(RaceMarshalPayload{HeatID: h.ID, PilotSlotIndex: seat.PilotSlotIndex, Action: "add_lap"})
						_, _ = eng.MarshalPilotAction(RaceMarshalPayload{HeatID: h.ID, PilotSlotIndex: seat.PilotSlotIndex, Action: "add_lap"})
					}
				}
			}
		}
		if _, err := eng.RaceControlAction("stop", nextQualHeatID); err != nil {
			t.Fatalf("stop qual heat %s: %v", nextQualHeatID, err)
		}
		st, err = eng.RaceControlAction("confirm", nextQualHeatID)
		if err != nil {
			t.Fatalf("confirm qual heat %s: %v", nextQualHeatID, err)
		}
	}

	// 5. Verify Stage 1 is Completed, Stage 2 is Active (NOT Completed!), and tournament IsComplete is false!
	if st.Stages[0].Status != domain.StageStatusCompleted {
		t.Fatalf("expected Stage 1 Qualifying Completed, got %s", st.Stages[0].Status)
	}
	if st.Stages[1].Status != domain.StageStatusActive {
		t.Fatalf("expected Stage 2 Single Elim Active after Qualifying completes, got %s", st.Stages[1].Status)
	}
	if st.IsComplete {
		t.Fatalf("expected tournament IsComplete=false while Stage 2 Single Elim has not been run yet")
	}
	seededStage2Seats := 0
	for _, h := range st.Heats {
		if h.StageIndex == 2 {
			for _, s := range h.Seats {
				if s.PilotSlotIndex > 0 {
					seededStage2Seats++
				}
			}
		}
	}
	if seededStage2Seats != 4 {
		t.Fatalf("expected 4 seeded pilots in Stage 2 Single Elimination, got %d", seededStage2Seats)
	}
}

func TestAddHeatToStartedRoundPreservesFlownHeats(t *testing.T) {
	eng := seedEngineWithPilots(t, 6)

	cfg := domain.DefaultRaceSetupConfig()
	cfg.EventName = "Walkup Pilots Race"
	cfg.MainFormat = domain.FormatQualifying
	cfg.QualifyingRounds = 1
	cfg.PilotsPerHeat = 4
	cfg.CountdownSec = 0
	st := eng.ConfigureAndGenerateRace(cfg, true)

	if len(st.Heats) != 2 {
		t.Fatalf("expected 2 initial heats in Q1, got %d", len(st.Heats))
	}
	roundID := st.Heats[0].RoundID
	firstHeatID := st.Heats[0].ID
	pilot1 := st.Heats[0].Seats[0].PilotSlotIndex

	if _, err := eng.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          st.RaceID,
		LifecycleAction: "start_race",
	}); err != nil {
		t.Fatalf("start_race: %v", err)
	}
	if _, err := eng.RaceControlAction("start", firstHeatID); err != nil {
		t.Fatalf("start heat 1: %v", err)
	}
	if _, err := eng.MarshalPilotAction(RaceMarshalPayload{
		HeatID:         firstHeatID,
		PilotSlotIndex: pilot1,
		Action:         "add_lap",
	}); err != nil {
		t.Fatalf("add_lap: %v", err)
	}
	if _, err := eng.RaceControlAction("stop", firstHeatID); err != nil {
		t.Fatalf("stop heat 1: %v", err)
	}
	st, err := eng.RaceControlAction("confirm", firstHeatID)
	if err != nil {
		t.Fatalf("confirm heat 1: %v", err)
	}

	// Add a 3rd heat to the ALREADY STARTED Round 1 via add_heat!
	st, err = eng.BracketEditAction(BracketEditPayload{
		Action:  "add_heat",
		RoundID: roundID,
	})
	if err != nil {
		t.Fatalf("add_heat on started round failed: %v", err)
	}
	if len(st.Heats) != 3 {
		t.Fatalf("expected 3 heats after add_heat, got %d", len(st.Heats))
	}
	if st.Heats[0].ID != firstHeatID || st.Heats[0].State != domain.HeatConfirmed {
		t.Fatalf("expected first heat to stay Confirmed, got %+v", st.Heats[0])
	}

	// Also add a 4th heat via update_round HeatCount=4 on the started round!
	st, err = eng.BracketEditAction(BracketEditPayload{
		Action:    "update_round",
		RoundID:   roundID,
		Title:     "Qualifying Round 1 (Expanded)",
		HeatCount: 4,
	})
	if err != nil {
		t.Fatalf("update_round HeatCount=4 on started round failed: %v", err)
	}
	if len(st.Heats) != 4 {
		t.Fatalf("expected 4 heats after update_round, got %d", len(st.Heats))
	}

	// Assign a pilot into the newly added 4th heat!
	newHeatID := st.Heats[3].ID
	st, err = eng.BracketEditAction(BracketEditPayload{
		Action:         "assign_pilot_seat",
		HeatID:         newHeatID,
		SeatIndex:      1,
		PilotSlotIndex: pilot1,
	})
	if err != nil {
		t.Fatalf("assign_seat into newly added heat failed: %v", err)
	}
	if st.Heats[3].Seats[0].PilotSlotIndex != pilot1 {
		t.Fatalf("expected pilot %d seated in new heat %s, got %d", pilot1, newHeatID, st.Heats[3].Seats[0].PilotSlotIndex)
	}
}

func TestUnlockAndEditConfirmedHeatWhileLiveHeatRuns(t *testing.T) {
	eng := seedEngineWithPilots(t, 8)

	cfg := domain.DefaultRaceSetupConfig()
	cfg.EventName = "Live Review Concurrency"
	cfg.MainFormat = domain.FormatQualifying
	cfg.QualifyingRounds = 1
	cfg.PilotsPerHeat = 4
	cfg.TimeLimitSec = 20
	cfg.QualifyingTimeLimitSec = 20
	cfg.OvertimeGraceSec = 0
	cfg.CountdownSec = 0
	st := eng.ConfigureAndGenerateRace(cfg, true)

	heat1ID := st.Heats[0].ID
	heat2ID := st.Heats[1].ID
	h1Pilot := st.Heats[0].Seats[0].PilotSlotIndex

	if _, err := eng.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          st.RaceID,
		LifecycleAction: "start_race",
	}); err != nil {
		t.Fatalf("start_race: %v", err)
	}

	// Run & confirm Heat 1.
	if _, err := eng.RaceControlAction("start", heat1ID); err != nil {
		t.Fatalf("start heat 1: %v", err)
	}
	_, _ = eng.MarshalPilotAction(RaceMarshalPayload{HeatID: heat1ID, PilotSlotIndex: h1Pilot, Action: "add_lap"})
	if _, err := eng.RaceControlAction("stop", heat1ID); err != nil {
		t.Fatalf("stop heat 1: %v", err)
	}
	if _, err := eng.RaceControlAction("confirm", heat1ID); err != nil {
		t.Fatalf("confirm heat 1: %v", err)
	}

	// Start Heat 2 (now live in HeatRunning!).
	st, err := eng.RaceControlAction("start", heat2ID)
	if err != nil {
		t.Fatalf("start heat 2: %v", err)
	}
	if st.ActiveHeatID != heat2ID {
		t.Fatalf("expected ActiveHeatID=%s, got %s", heat2ID, st.ActiveHeatID)
	}

	// While Heat 2 is LIVE, unlock Heat 1 to Review and edit its laps!
	st, err = eng.RaceControlAction("unlock", heat1ID)
	if err != nil {
		t.Fatalf("unlock heat 1 while heat 2 running: %v", err)
	}
	if st.ActiveHeatID != heat2ID {
		t.Fatalf("unlocking heat 1 must NOT hijack ActiveHeatID while heat 2 is running (got %s)", st.ActiveHeatID)
	}

	st, err = eng.MarshalPilotAction(RaceMarshalPayload{
		HeatID:         heat1ID,
		PilotSlotIndex: h1Pilot,
		Action:         "add_lap",
	})
	if err != nil {
		t.Fatalf("edit unlocked heat 1 while heat 2 running: %v", err)
	}
	if st.ActiveHeatID != heat2ID {
		t.Fatalf("editing heat 1 must keep ActiveHeatID=%s, got %s", heat2ID, st.ActiveHeatID)
	}

	eng.mu.Lock()
	if !eng.raceArmed {
		eng.mu.Unlock()
		t.Fatalf("editing unlocked heat 1 disarmed raceArmed while heat 2 was live!")
	}
	h2 := eng.findHeatLocked(heat2ID)
	if h2 == nil || h2.State != domain.HeatRunning {
		eng.mu.Unlock()
		t.Fatalf("expected heat 2 still HeatRunning, got %+v", h2)
	}
	// Simulate Heat 2 reaching its time limit via tickRaceClockLocked.
	changed, _, _, _, _, _ := eng.tickRaceClockLocked(h2.StartToneUs + 25_000_000)
	h2After := eng.findHeatLocked(heat2ID).State
	eng.mu.Unlock()

	if !changed || h2After != domain.HeatFinished {
		t.Fatalf("expected tickRaceClockLocked to finish live heat 2 on timeout, got changed=%v state=%s", changed, h2After)
	}
}

func TestUnlockAnyConfirmedHeatPropagatesStandingsAndUnstartedDownstream(t *testing.T) {
	eng := seedEngineWithPilots(t, 4)

	cfg := domain.DefaultRaceSetupConfig()
	cfg.EventName = "Unlock Propagation Bracket"
	cfg.MainFormat = domain.FormatSingleElimination
	cfg.PilotsPerHeat = 2
	cfg.TargetLaps = 2
	cfg.CountdownSec = 0
	st := eng.ConfigureAndGenerateRace(cfg, true)
	if len(st.Heats) != 3 {
		t.Fatalf("expected 3 heats (2 semis + 1 final), got %d", len(st.Heats))
	}

	semi1 := st.Heats[0].ID
	semi2 := st.Heats[1].ID
	finalID := st.Heats[2].ID
	s1PilotA := st.Heats[0].Seats[0].PilotSlotIndex
	s1PilotB := st.Heats[0].Seats[1].PilotSlotIndex
	s2PilotA := st.Heats[1].Seats[0].PilotSlotIndex

	if _, err := eng.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          st.RaceID,
		LifecycleAction: "start_race",
	}); err != nil {
		t.Fatalf("start_race: %v", err)
	}

	// Run & confirm Semi 1 (Pilot A wins) and Semi 2 (Pilot A wins).
	_, _ = eng.RaceControlAction("start", semi1)
	_, _ = eng.MarshalPilotAction(RaceMarshalPayload{HeatID: semi1, PilotSlotIndex: s1PilotA, Action: "add_lap"})
	_, _ = eng.MarshalPilotAction(RaceMarshalPayload{HeatID: semi1, PilotSlotIndex: s1PilotA, Action: "add_lap"})
	_, _ = eng.MarshalPilotAction(RaceMarshalPayload{HeatID: semi1, PilotSlotIndex: s1PilotB, Action: "add_lap"})
	_, _ = eng.MarshalPilotAction(RaceMarshalPayload{HeatID: semi1, PilotSlotIndex: s1PilotB, Action: "add_lap"})
	_, _ = eng.RaceControlAction("stop", semi1)
	_, _ = eng.RaceControlAction("confirm", semi1)

	_, _ = eng.RaceControlAction("start", semi2)
	_, _ = eng.MarshalPilotAction(RaceMarshalPayload{HeatID: semi2, PilotSlotIndex: s2PilotA, Action: "add_lap"})
	_, _ = eng.MarshalPilotAction(RaceMarshalPayload{HeatID: semi2, PilotSlotIndex: s2PilotA, Action: "add_lap"})
	_, _ = eng.RaceControlAction("stop", semi2)
	st, _ = eng.RaceControlAction("confirm", semi2)

	// Final is unstarted and seeded with s1PilotA. Now unlock Semi 1, DQ s1PilotA, and re-confirm -> Final updates to s1PilotB!
	if _, err := eng.RaceControlAction("unlock", semi1); err != nil {
		t.Fatalf("unlock semi1 before final: %v", err)
	}
	_, _ = eng.MarshalPilotAction(RaceMarshalPayload{HeatID: semi1, PilotSlotIndex: s1PilotA, Action: "toggle_dq"})
	st, err := eng.RaceControlAction("confirm", semi1)
	if err != nil {
		t.Fatalf("re-confirm semi1: %v", err)
	}
	foundPilotBInFinal := false
	for _, h := range st.Heats {
		if h.ID == finalID {
			for _, s := range h.Seats {
				if s.PilotSlotIndex == s1PilotB {
					foundPilotBInFinal = true
				}
			}
		}
	}
	if !foundPilotBInFinal {
		t.Fatalf("expected s1PilotB (%d) propagated into unstarted Final after Semi 1 review edit", s1PilotB)
	}

	// Now start & confirm Final, then verify Semi 1 STILL has CanUnlock=true and can be unlocked & re-confirmed safely!
	_, _ = eng.RaceControlAction("start", finalID)
	_, _ = eng.MarshalPilotAction(RaceMarshalPayload{HeatID: finalID, PilotSlotIndex: s1PilotB, Action: "add_lap"})
	_, _ = eng.MarshalPilotAction(RaceMarshalPayload{HeatID: finalID, PilotSlotIndex: s1PilotB, Action: "add_lap"})
	_, _ = eng.RaceControlAction("stop", finalID)
	st, _ = eng.RaceControlAction("confirm", finalID)

	for _, h := range st.Heats {
		if h.ID == semi1 && !h.CanUnlock {
			t.Fatalf("expected Semi 1 CanUnlock=true even after downstream Final is confirmed")
		}
	}
	if _, err := eng.RaceControlAction("unlock", semi1); err != nil {
		t.Fatalf("expected unlocking Semi 1 after Final confirmed to succeed, got: %v", err)
	}
	st, err = eng.RaceControlAction("confirm", semi1)
	if err != nil {
		t.Fatalf("re-confirming Semi 1 failed: %v", err)
	}
	for _, h := range st.Heats {
		if h.ID == finalID && h.State != domain.HeatConfirmed {
			t.Fatalf("expected confirmed Final to remain Confirmed, got %s", h.State)
		}
	}
}

func TestPilotLastLapAnnouncementOnFixedLapHeatsOnly(t *testing.T) {
	eng := seedEngineWithPilots(t, 4)

	eng.ConfigureAndGenerateRace(domain.RaceSetupConfig{
		EventName:     "Fixed Lap Last Lap Callout",
		MainFormat:    domain.FormatSingleElimination,
		PilotsPerHeat: 4,
		TargetLaps:    3,
		TimeLimitSec:  120,
		CountdownSec:  0,
	}, true)

	if _, err := eng.RaceControlAction("start", ""); err != nil {
		t.Fatalf("start heat: %v", err)
	}

	eng.mu.Lock()
	h := eng.findHeatLocked(eng.raceState.ActiveHeatID)
	p1 := h.Seats[0].PilotSlotIndex
	p2 := h.Seats[1].PilotSlotIndex

	// p1 L0 -> holeshot (since first pilot across start gate)
	_, _, ann0 := eng.recordRaceCrossingLocked(domain.GateCrossingEvent{
		EventID: 1, SlotIndex: p1, TimestampUs: h.StartToneUs + 500_000, PeakRSSIDbm: -50, IsStartFinish: true,
	}, nil)
	if ann0 == nil || ann0.Kind != "holeshot" {
		eng.mu.Unlock()
		t.Fatalf("expected holeshot on L0, got %+v", ann0)
	}

	// p1 L1 (1/3 laps completed) -> no race announcement
	_, _, ann1 := eng.recordRaceCrossingLocked(domain.GateCrossingEvent{
		EventID: 2, SlotIndex: p1, TimestampUs: h.StartToneUs + 12_500_000, PeakRSSIDbm: -50, IsStartFinish: true,
	}, nil)
	if ann1 != nil {
		eng.mu.Unlock()
		t.Fatalf("expected nil announcement on L1 of 3, got %+v", ann1)
	}

	// p1 L2 (2/3 laps completed -> entering 3rd & final lap!) -> MUST emit pilot_last_lap!
	_, _, ann2 := eng.recordRaceCrossingLocked(domain.GateCrossingEvent{
		EventID: 3, SlotIndex: p1, TimestampUs: h.StartToneUs + 24_500_000, PeakRSSIDbm: -50, IsStartFinish: true,
	}, nil)
	if ann2 == nil || ann2.Kind != "pilot_last_lap" || ann2.SlotIndex != p1 {
		eng.mu.Unlock()
		t.Fatalf("expected pilot_last_lap on L2 of 3, got %+v", ann2)
	}

	// p2 also gets pilot_last_lap independently when p2 reaches 2/3 laps!
	_, _, _ = eng.recordRaceCrossingLocked(domain.GateCrossingEvent{
		EventID: 4, SlotIndex: p2, TimestampUs: h.StartToneUs + 1_000_000, PeakRSSIDbm: -52, IsStartFinish: true,
	}, nil)
	_, _, _ = eng.recordRaceCrossingLocked(domain.GateCrossingEvent{
		EventID: 5, SlotIndex: p2, TimestampUs: h.StartToneUs + 14_000_000, PeakRSSIDbm: -52, IsStartFinish: true,
	}, nil)
	_, _, annP2Last := eng.recordRaceCrossingLocked(domain.GateCrossingEvent{
		EventID: 6, SlotIndex: p2, TimestampUs: h.StartToneUs + 27_000_000, PeakRSSIDbm: -52, IsStartFinish: true,
	}, nil)
	eng.mu.Unlock()

	if annP2Last == nil || annP2Last.Kind != "pilot_last_lap" || annP2Last.SlotIndex != p2 {
		t.Fatalf("expected pilot_last_lap for p2 on L2 of 3, got %+v", annP2Last)
	}
}
