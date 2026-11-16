package tracker

import (
	"testing"

	"slaprf/internal/domain"
)

func TestRosterDQPreservesLapsAndIsReversible(t *testing.T) {
	eng := NewEngine()
	cfg := domain.DefaultRaceSetupConfig()
	cfg.CountdownSec = 0
	cfg.TargetLaps = 2
	st := eng.ConfigureAndGenerateRace(cfg, true)
	if len(st.Heats) == 0 {
		t.Fatalf("expected generated heats")
	}
	heatID := st.Heats[0].ID
	pilotSlot := st.Heats[0].Seats[0].PilotSlotIndex

	if _, err := eng.RaceControlAction("start", heatID); err != nil {
		t.Fatalf("start heat: %v", err)
	}
	if _, err := eng.MarshalPilotAction(RaceMarshalPayload{Action: "add_lap", HeatID: heatID, PilotSlotIndex: pilotSlot}); err != nil {
		t.Fatalf("add_lap holeshot: %v", err)
	}
	if _, err := eng.MarshalPilotAction(RaceMarshalPayload{Action: "add_lap", HeatID: heatID, PilotSlotIndex: pilotSlot}); err != nil {
		t.Fatalf("add_lap 1: %v", err)
	}
	if _, err := eng.MarshalPilotAction(RaceMarshalPayload{Action: "add_lap", HeatID: heatID, PilotSlotIndex: pilotSlot}); err != nil {
		t.Fatalf("add_lap 2: %v", err)
	}
	if _, err := eng.RaceControlAction("stop", heatID); err != nil {
		t.Fatalf("stop heat: %v", err)
	}
	st, err := eng.RaceControlAction("confirm", heatID)
	if err != nil {
		t.Fatalf("confirm heat: %v", err)
	}

	// Pilot now has counted heats -> unchecking CheckedIn must fail.
	f := false
	if _, err := eng.EventAction(EventActionPayload{
		Action:    "update_attendance",
		SlotIndex: pilotSlot,
		CheckedIn: &f,
	}); err == nil {
		t.Fatalf("expected unchecking pilot with counted heats to fail")
	}

	// Mark pilot DQ at roster level -> completed heat seat becomes DQ while preserving laps.
	st, err = eng.EventAction(EventActionPayload{
		Action:     "update_attendance",
		SlotIndex:  pilotSlot,
		Attendance: domain.AttendanceDQ,
	})
	if err != nil {
		t.Fatalf("mark DQ: %v", err)
	}
	var seatAfterDQ domain.HeatSeat
	for _, h := range st.Heats {
		if h.ID == heatID {
			seatAfterDQ = h.Seats[0]
		}
	}
	if seatAfterDQ.Status != domain.PilotHeatDQ {
		t.Fatalf("expected seat status DQ, got %s", seatAfterDQ.Status)
	}
	if len(seatAfterDQ.Laps) < 2 {
		t.Fatalf("expected preserved laps during DQ, got %d", len(seatAfterDQ.Laps))
	}

	// Appeal succeeds -> toggle DQ off (back to Active) restores Finished status & laps!
	st, err = eng.EventAction(EventActionPayload{
		Action:     "update_attendance",
		SlotIndex:  pilotSlot,
		Attendance: domain.AttendanceActive,
	})
	if err != nil {
		t.Fatalf("clear DQ: %v", err)
	}
	var seatRestored domain.HeatSeat
	for _, h := range st.Heats {
		if h.ID == heatID {
			seatRestored = h.Seats[0]
		}
	}
	if seatRestored.Status != domain.PilotHeatFinished || seatRestored.LapsCompleted != 2 {
		t.Fatalf("expected restored Finished seat with 2 laps, got status=%s laps=%d", seatRestored.Status, seatRestored.LapsCompleted)
	}
}

func TestCrossRaceAndPracticePreemption(t *testing.T) {
	eng := NewEngine()
	cfg1 := domain.DefaultRaceSetupConfig()
	cfg1.EventName = "Race Alpha"
	cfg1.CountdownSec = 0
	r1 := eng.ConfigureAndGenerateRace(cfg1, true)

	if _, err := eng.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          r1.RaceID,
		LifecycleAction: "start_race",
	}); err != nil {
		t.Fatalf("start Race Alpha: %v", err)
	}

	// Create Race Beta and configure it
	r2, err := eng.EventAction(EventActionPayload{
		Action: "create_race",
		Name:   "Race Beta",
	})
	if err != nil {
		t.Fatalf("create Race Beta: %v", err)
	}
	cfg2 := domain.DefaultRaceSetupConfig()
	cfg2.EventName = "Race Beta"
	eng.ConfigureAndGenerateRaceForID(r2.RaceID, cfg2, true, false)

	// Starting Race Beta without PreemptOngoing fails
	if _, err := eng.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          r2.RaceID,
		LifecycleAction: "start_race",
	}); err == nil {
		t.Fatalf("expected error without PreemptOngoing")
	}

	// Starting Race Beta WITH PreemptOngoing pauses Race Alpha and activates Race Beta
	r2Started, err := eng.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          r2.RaceID,
		LifecycleAction: "start_race",
		PreemptOngoing:  true,
	})
	if err != nil {
		t.Fatalf("start Race Beta with PreemptOngoing: %v", err)
	}
	if r2Started.Lifecycle != domain.LifecycleActive {
		t.Fatalf("expected Race Beta active, got %s", r2Started.Lifecycle)
	}

	// Starting a Practice session WITH PreemptOngoing pauses Race Beta and activates Practice
	ps := eng.PracticeSnapshot()
	if len(ps.Sessions) == 0 {
		t.Fatalf("expected default practice session")
	}
	psAfter, err := eng.PracticeAction(PracticeActionPayload{
		Action:         "start_session",
		SessionID:      ps.Sessions[0].SessionID,
		PreemptOngoing: true,
	})
	if err != nil {
		t.Fatalf("start practice with PreemptOngoing: %v", err)
	}
	if psAfter.ActiveSessionID != ps.Sessions[0].SessionID {
		t.Fatalf("expected practice session active, got %q", psAfter.ActiveSessionID)
	}
	ev := eng.EventSnapshot()
	for _, r := range ev.Races {
		if r.Lifecycle == domain.LifecycleActive {
			t.Fatalf("expected all races paused after practice preempted, found %q active", r.Config.EventName)
		}
	}
}

func TestEmergencyStopLifecycleClearsOnPauseAndResume(t *testing.T) {
	eng := NewEngine()
	cfg := domain.DefaultRaceSetupConfig()
	cfg.CountdownSec = 0
	cfg.TargetLaps = 2
	st := eng.ConfigureAndGenerateRace(cfg, true)
	if len(st.Heats) == 0 {
		t.Fatalf("expected generated heats")
	}
	heatID := st.Heats[0].ID

	// 1. Start heat -> trigger race_lifecycle emergency_stop -> EmergencyStopped=true & heat=HeatAborted.
	if _, err := eng.RaceControlAction("start", heatID); err != nil {
		t.Fatalf("start heat: %v", err)
	}
	stEmerg, err := eng.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          st.RaceID,
		LifecycleAction: "emergency_stop",
	})
	if err != nil {
		t.Fatalf("emergency_stop lifecycle: %v", err)
	}
	if !stEmerg.EmergencyStopped {
		t.Fatalf("expected EmergencyStopped=true after emergency_stop")
	}
	if stEmerg.Heats[0].State != domain.HeatAborted {
		t.Fatalf("expected HeatAborted after emergency_stop, got %s", stEmerg.Heats[0].State)
	}

	// 2. Transitioning from Emergency -> Paused clears EmergencyStopped and resets HeatAborted -> HeatStaged.
	stPaused, err := eng.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          st.RaceID,
		LifecycleAction: "pause_race",
	})
	if err != nil {
		t.Fatalf("pause_race after emergency_stop: %v", err)
	}
	if stPaused.EmergencyStopped {
		t.Fatalf("expected EmergencyStopped=false after pause_race")
	}
	if stPaused.Lifecycle != domain.LifecyclePaused {
		t.Fatalf("expected LifecyclePaused, got %s", stPaused.Lifecycle)
	}
	if stPaused.Heats[0].State != domain.HeatStaged {
		t.Fatalf("expected aborted heat reset to HeatStaged on pause_race, got %s", stPaused.Heats[0].State)
	}

	// 3. Re-enter Emergency directly from Paused, then transition directly to Active (resume_race).
	stEmerg2, err := eng.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          st.RaceID,
		LifecycleAction: "emergency_stop",
	})
	if err != nil || !stEmerg2.EmergencyStopped {
		t.Fatalf("expected EmergencyStopped=true on second emergency_stop, err=%v", err)
	}
	stActive, err := eng.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          st.RaceID,
		LifecycleAction: "resume_race",
	})
	if err != nil {
		t.Fatalf("resume_race from emergency_stop: %v", err)
	}
	if stActive.EmergencyStopped {
		t.Fatalf("expected EmergencyStopped=false after resume_race")
	}
	if stActive.Lifecycle != domain.LifecycleActive {
		t.Fatalf("expected LifecycleActive after resume_race, got %s", stActive.Lifecycle)
	}
}
