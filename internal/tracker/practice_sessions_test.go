package tracker

import (
	"testing"

	"slaprf/internal/domain"
)

func feedSimulatedLap(t *testing.T, e *Engine, slotIndex int, startSec float64) {
	t.Helper()
	// Feed RSSI peaks through IngestTelemetryFrame across default 4-gate course (AssignedTimerID 2, 3, 4, 5)
	var pilotIdx = -1
	for i, p := range e.pilots {
		if p.SlotIndex == slotIndex {
			pilotIdx = i
			break
		}
	}
	if pilotIdx < 0 {
		t.Fatalf("slotIndex %d not found", slotIndex)
	}
	gateTimers := []uint8{
		e.gates[0].AssignedTimerID,
		e.gates[1].AssignedTimerID,
		e.gates[2].AssignedTimerID,
		e.gates[3].AssignedTimerID,
		e.gates[0].AssignedTimerID,
	}
	offsets := []float64{0, 3.0, 6.0, 9.0, 12.5}
	for step, timerID := range gateTimers {
		baseUs := uint64((startSec + offsets[step]) * 1e6)
		// Baseline low RSSI -> peak above -58 dBm -> exit below -68 dBm
		samples := []struct {
			dtUs uint64
			rssi float32
		}{
			{0, -85},
			{20_000, -85},
			{40_000, -72},
			{60_000, -56},
			{80_000, -46},
			{100_000, -41},
			{120_000, -40},
			{140_000, -41},
			{160_000, -46},
			{180_000, -56},
			{200_000, -72},
			{220_000, -85},
			{240_000, -85},
			{260_000, -85},
			{280_000, -85},
			{300_000, -85},
			{320_000, -85},
			{340_000, -85},
		}
		for _, s := range samples {
			var frame domain.TimerTelemetryFrame
			frame.TimerID = timerID
			frame.TimestampUs = baseUs + s.dtUs
			for k := range frame.RSSI {
				frame.RSSI[k] = -90
			}
			frame.RSSI[pilotIdx] = s.rssi
			e.IngestTelemetryFrame(frame)
		}
	}
}

func TestPracticeSessionCRUDNonDestructivePilotRemovalAndMutualExclusion(t *testing.T) {
	e := NewEngine()
	ps := e.PracticeSnapshot()
	if len(ps.Sessions) != 1 || !ps.Sessions[0].Active || ps.ActiveSessionID != ps.Sessions[0].SessionID {
		t.Fatalf("expected 1 default active practice session, got %+v", ps)
	}
	s1ID := ps.Sessions[0].SessionID

	// Record a real lap for Pilot 1 (FAERRY) in Session 1
	feedSimulatedLap(t, e, 1, 10.0)
	ps = e.PracticeSnapshot()
	if len(ps.Sessions[0].Laps) != 1 {
		t.Fatalf("expected 1 lap recorded in Session 1, got %d", len(ps.Sessions[0].Laps))
	}
	foundPilot1Summary := false
	for _, sum := range ps.Sessions[0].Summaries {
		if sum.SlotIndex == 1 && sum.LapsCompleted == 1 {
			foundPilot1Summary = true
		}
	}
	if !foundPilot1Summary {
		t.Fatalf("expected Pilot 1 summary with 1 lap in Session 1, got %+v", ps.Sessions[0].Summaries)
	}

	// Remove Pilot 1 from Session 1 -> Pilot 1 leaves active session lineup/summaries, but Laps remain intact!
	ps, err := e.PracticeAction(PracticeActionPayload{
		Action:    "remove_session_pilot",
		SessionID: s1ID,
		SlotIndex: 1,
	})
	if err != nil {
		t.Fatalf("remove_session_pilot failed: %v", err)
	}
	if len(ps.Sessions[0].Laps) != 1 {
		t.Fatalf("expected Session 1 laps preserved on pilot removal, got %d", len(ps.Sessions[0].Laps))
	}
	for _, sum := range ps.Sessions[0].Summaries {
		if sum.SlotIndex == 1 {
			t.Fatalf("expected removed Pilot 1 hidden from Session 1 active summaries")
		}
	}

	// Re-add Pilot 1 to Session 1 -> Pilot 1's prior lap and summary stats immediately restore!
	ps, err = e.PracticeAction(PracticeActionPayload{
		Action:    "add_session_pilot",
		SessionID: s1ID,
		SlotIndex: 1,
	})
	if err != nil {
		t.Fatalf("add_session_pilot failed: %v", err)
	}
	restoredSummary := false
	for _, sum := range ps.Sessions[0].Summaries {
		if sum.SlotIndex == 1 && sum.LapsCompleted == 1 && sum.BestLapSec > 10 {
			restoredSummary = true
		}
	}
	if !restoredSummary {
		t.Fatalf("expected Pilot 1 lap summary immediately restored on re-add, got %+v", ps.Sessions[0].Summaries)
	}

	// Deleting an active session must be rejected until stopped
	if _, err := e.PracticeAction(PracticeActionPayload{Action: "delete_session", SessionID: s1ID}); err == nil {
		t.Fatalf("expected delete_session on live session to fail")
	}

	// Inline create Session 2 (DontSelect: true) -> Session 1 stays active and selected!
	ps, err = e.PracticeAction(PracticeActionPayload{
		Action:     "create_session",
		Name:       "Warmup Pack 2",
		Tags:       []string{"Morning", "5-inch"},
		DontSelect: true,
	})
	if err != nil {
		t.Fatalf("create_session failed: %v", err)
	}
	if len(ps.Sessions) != 2 || ps.ActiveSessionID != s1ID || ps.SelectedSessionID != s1ID {
		t.Fatalf("expected inline create_session to preserve active & selected Session 1, got %+v", ps)
	}
	s2ID := ps.Sessions[1].SessionID

	// Add Pilot 5 (Red5) to Session 2 and start Session 2 -> Session 1 auto-stops (preserving its 1 lap), Session 2 goes active!
	if _, err := e.PracticeAction(PracticeActionPayload{Action: "add_session_pilot", SessionID: s2ID, SlotIndex: 5, Channel: 4}); err != nil {
		t.Fatalf("add_session_pilot Red5 to Session 2 failed: %v", err)
	}
	ps, err = e.PracticeAction(PracticeActionPayload{Action: "start_session", SessionID: s2ID})
	if err != nil {
		t.Fatalf("start_session Session 2 failed: %v", err)
	}
	if ps.ActiveSessionID != s2ID || ps.Sessions[0].Active || !ps.Sessions[1].Active {
		t.Fatalf("expected only Session 2 active, got %+v", ps)
	}
	if len(ps.Sessions[0].Laps) != 1 || len(ps.Sessions[1].Laps) != 0 {
		t.Fatalf("expected Session 1 to keep 1 lap and Session 2 to start with 0 laps")
	}

	// While Session 2 is actively live, Race Editor operations (create_race, apply_template) MUST NOT stop Session 2!
	if _, err := e.EventAction(EventActionPayload{Action: "create_race", Name: "Race Alpha"}); err != nil {
		t.Fatalf("create_race Race Alpha failed: %v", err)
	}
	raceAlphaID := e.raceState.RaceID
	if _, err := e.BracketEditAction(BracketEditPayload{Action: "apply_template", TemplateID: "double_elimination"}); err != nil {
		t.Fatalf("apply_template on Race Alpha failed: %v", err)
	}
	if _, err := e.EventAction(EventActionPayload{Action: "create_race", Name: "Race Beta", DontSelect: true}); err != nil {
		t.Fatalf("inline create_race Race Beta failed: %v", err)
	}
	evSnap := e.EventSnapshot()
	raceBetaID := evSnap.Races[1].RaceID
	ps = e.PracticeSnapshot()
	if ps.ActiveSessionID != s2ID {
		t.Fatalf("expected Session 2 to remain live while editing races, got ActiveSessionID=%q", ps.ActiveSessionID)
	}

	// Starting Race Alpha's first heat transitions Race Alpha to ongoing AND automatically stops Session 2!
	cfg := e.raceState.Config
	cfg.CountdownSec = 0
	st := e.ConfigureAndGenerateRaceWithOptions(cfg, false, false)
	if _, err := e.RaceControlAction("start", st.NextReadyHeatID); err != nil {
		t.Fatalf("start Race Alpha heat failed: %v", err)
	}
	ps = e.PracticeSnapshot()
	if ps.ActiveSessionID != "" {
		t.Fatalf("expected all practice sessions stopped while Race Alpha is ongoing, got ActiveSessionID=%q", ps.ActiveSessionID)
	}

	// Attempting to start Practice Session 2 while Race Alpha is ongoing MUST fail!
	if _, err := e.PracticeAction(PracticeActionPayload{Action: "start_session", SessionID: s2ID}); err == nil {
		t.Fatalf("expected start_session to fail while Race Alpha is ongoing")
	}

	// Selecting Race Beta and editing its template works, but attempting to start Race Beta while Race Alpha is ongoing MUST fail!
	if _, err := e.EventAction(EventActionPayload{Action: "select_race", RaceID: raceBetaID}); err != nil {
		t.Fatalf("select_race Race Beta failed: %v", err)
	}
	stBeta, err := e.BracketEditAction(BracketEditPayload{Action: "apply_template", TemplateID: "single_elimination"})
	if err != nil {
		t.Fatalf("apply_template on Race Beta failed: %v", err)
	}
	if _, err := e.RaceControlAction("start", stBeta.NextReadyHeatID); err == nil {
		t.Fatalf("expected starting Race Beta to fail while Race Alpha is ongoing")
	}

	// Pause Race Alpha -> now Practice Session 1 or Race Beta can be started, and Export/Restore preserves PracticeState!
	if _, err := e.EventAction(EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          raceAlphaID,
		LifecycleAction: "pause_race",
	}); err != nil {
		t.Fatalf("pause Race Alpha failed: %v", err)
	}
	if _, err := e.PracticeAction(PracticeActionPayload{Action: "start_session", SessionID: s1ID}); err != nil {
		t.Fatalf("start_session Session 1 after pausing Race Alpha failed: %v", err)
	}

	exported := e.ExportState()
	e2 := NewEngine()
	e2.RestoreState(exported, true)
	ps2 := e2.PracticeSnapshot()
	if len(ps2.Sessions) != 2 || ps2.ActiveSessionID != s1ID || len(ps2.Sessions[0].Laps) != 1 {
		t.Fatalf("expected ExportState/RestoreState to preserve 2 sessions and Session 1's lap, got %+v", ps2)
	}
}

func TestPracticeSessionPauseResumeAndStopLifecycle(t *testing.T) {
	e := NewEngine()
	ps := e.PracticeSnapshot()
	if len(ps.Sessions) != 1 || !ps.Sessions[0].Active || ps.Sessions[0].Paused {
		t.Fatalf("expected active unpaused initial practice session, got %+v", ps.Sessions)
	}
	sid := ps.Sessions[0].SessionID

	// Pause session -> Active becomes false, Paused becomes true, raceArmed becomes false
	ps, err := e.PracticeAction(PracticeActionPayload{Action: "pause_session", SessionID: sid})
	if err != nil {
		t.Fatalf("pause_session failed: %v", err)
	}
	if ps.Sessions[0].Active || !ps.Sessions[0].Paused || ps.ActiveSessionID != "" {
		t.Fatalf("expected paused session after pause_session, got %+v", ps)
	}
	if e.raceArmed {
		t.Fatalf("expected raceArmed=false when practice session is paused")
	}

	// Resume session -> Active becomes true, Paused becomes false, raceArmed becomes true
	ps, err = e.PracticeAction(PracticeActionPayload{Action: "resume_session", SessionID: sid})
	if err != nil {
		t.Fatalf("resume_session failed: %v", err)
	}
	if !ps.Sessions[0].Active || ps.Sessions[0].Paused || ps.ActiveSessionID != sid {
		t.Fatalf("expected active unpaused session after resume_session, got %+v", ps)
	}
	if !e.raceArmed {
		t.Fatalf("expected raceArmed=true when practice session is resumed")
	}

	// Pause again, then stop_session -> transitions cleanly from PAUSED to INACTIVE (Active=false, Paused=false)
	if _, err := e.PracticeAction(PracticeActionPayload{Action: "pause_session", SessionID: sid}); err != nil {
		t.Fatalf("second pause_session failed: %v", err)
	}
	ps, err = e.PracticeAction(PracticeActionPayload{Action: "stop_session", SessionID: sid})
	if err != nil {
		t.Fatalf("stop_session from paused failed: %v", err)
	}
	if ps.Sessions[0].Active || ps.Sessions[0].Paused || ps.ActiveSessionID != "" {
		t.Fatalf("expected inactive unpaused session after stop_session, got %+v", ps)
	}
}
