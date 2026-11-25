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

func feedSimulatedRun(t *testing.T, e *Engine, slotIndex int, startSec float64, lapSecs []float64) {
	t.Helper()
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
	samples := []struct {
		dtUs uint64
		rssi float32
	}{
		{0, -85}, {20_000, -85}, {40_000, -72}, {60_000, -56},
		{80_000, -46}, {100_000, -41}, {120_000, -40}, {140_000, -41},
		{160_000, -46}, {180_000, -56}, {200_000, -72}, {220_000, -85},
		{240_000, -85}, {260_000, -85}, {280_000, -85}, {300_000, -85},
		{320_000, -85}, {340_000, -85}, {360_000, -85},
	}
	emitPass := func(timerID uint8, atSec float64) {
		baseUs := uint64(atSec * 1e6)
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
	curSec := startSec
	emitPass(e.gates[0].AssignedTimerID, curSec)
	for _, lapSec := range lapSecs {
		q := lapSec / 4.0
		emitPass(e.gates[1].AssignedTimerID, curSec+q)
		emitPass(e.gates[2].AssignedTimerID, curSec+2*q)
		emitPass(e.gates[3].AssignedTimerID, curSec+3*q)
		emitPass(e.gates[0].AssignedTimerID, curSec+lapSec)
		curSec += lapSec
	}
}

func TestPracticeSessionDeleteLapAndClearPilotLaps(t *testing.T) {
	e := NewEngine()
	ps := e.PracticeSnapshot()
	sid := ps.Sessions[0].SessionID

	// Pilot 1 records 3 laps (16.0s, 11.2s PB, 13.6s); Pilot 2 records 2 laps (12.0s, 14.0s).
	feedSimulatedRun(t, e, 1, 10.0, []float64{16.0, 11.2, 13.6})
	feedSimulatedRun(t, e, 2, 60.0, []float64{12.0, 14.0})

	ps = e.PracticeSnapshot()
	if len(ps.Sessions[0].Laps) != 5 {
		t.Fatalf("expected 5 total laps, got %d", len(ps.Sessions[0].Laps))
	}
	pilot1FastestLapID := ps.Sessions[0].Laps[1].LapID

	// Delete Pilot 1's 11.2s PB lap (L2) -> surviving laps preserve their original lap numbers (L1, L3)
	// with a Break inserted across L2's span so adjacent shared H1 crossings stay intact!
	ps, err := e.PracticeAction(PracticeActionPayload{
		Action:    "delete_session_lap",
		SessionID: sid,
		LapID:     pilot1FastestLapID,
	})
	if err != nil {
		t.Fatalf("delete_session_lap failed: %v", err)
	}
	if len(ps.Sessions[0].Laps) != 4 {
		t.Fatalf("expected 4 laps after deleting 1 lap, got %d", len(ps.Sessions[0].Laps))
	}
	if len(ps.Sessions[0].Breaks) != 1 {
		t.Fatalf("expected 1 manual break inserted across deleted lap L2, got %d", len(ps.Sessions[0].Breaks))
	}
	var p1Laps []domain.LapRecord
	var p2Laps []domain.LapRecord
	for _, l := range ps.Sessions[0].Laps {
		if l.SlotIndex == 1 {
			p1Laps = append(p1Laps, l)
		} else if l.SlotIndex == 2 {
			p2Laps = append(p2Laps, l)
		}
	}
	if len(p1Laps) != 2 || p1Laps[0].LapNumber != 1 || p1Laps[1].LapNumber != 3 {
		t.Fatalf("expected Pilot 1 surviving laps to preserve LapNumber 1 and 3, got %+v", p1Laps)
	}
	if len(p1Laps[0].Sectors) != 4 || len(p1Laps[1].Sectors) != 4 {
		t.Fatalf("expected adjacent L1 and L3 sectors preserved intact, got L1=%+v L3=%+v", p1Laps[0].Sectors, p1Laps[1].Sectors)
	}
	if !p1Laps[1].IsBestLap || p1Laps[0].IsBestLap {
		t.Fatalf("expected Pilot 1's second remaining lap (13.6s, L3) to become PB, got %+v", p1Laps)
	}
	if len(p2Laps) != 2 || len(p2Laps[0].Sectors) == 0 || p2Laps[0].Sectors[0].Badge != domain.BadgeOverallBest {
		t.Fatalf("expected Pilot 2's 12.0s lap sectors promoted to OVERALL_BEST, got %+v", p2Laps)
	}

	// Deleting an already-deleted lap returns an error.
	if _, err := e.PracticeAction(PracticeActionPayload{
		Action:    "delete_session_lap",
		SessionID: sid,
		LapID:     pilot1FastestLapID,
	}); err == nil {
		t.Fatalf("expected error deleting non-existent lapId %d", pilot1FastestLapID)
	}

	// Start a half-finished lap for Pilot 1 so e.progress[1] is populated, then clear_pilot_laps for SlotIndex 1.
	for step, timerID := range []uint8{e.gates[0].AssignedTimerID, e.gates[1].AssignedTimerID} {
		baseUs := uint64((130.0 + float64(step)*3.5) * 1e6)
		for _, dt := range []struct {
			dtUs uint64
			rssi float32
		}{
			{0, -85}, {40_000, -70}, {80_000, -45}, {120_000, -40}, {160_000, -45},
			{200_000, -70}, {240_000, -85}, {280_000, -85}, {320_000, -85},
		} {
			var frame domain.TimerTelemetryFrame
			frame.TimerID = timerID
			frame.TimestampUs = baseUs + dt.dtUs
			for k := range frame.RSSI {
				frame.RSSI[k] = -90
			}
			frame.RSSI[0] = dt.rssi
			e.IngestTelemetryFrame(frame)
		}
	}
	if _, hasProg := e.progress[1]; !hasProg {
		t.Fatalf("expected active in-progress lap state for Pilot 1 before clear_pilot_laps")
	}

	ps, err = e.PracticeAction(PracticeActionPayload{
		Action:    "clear_pilot_laps",
		SessionID: sid,
		SlotIndex: 1,
	})
	if err != nil {
		t.Fatalf("clear_pilot_laps failed: %v", err)
	}
	if _, hasProg := e.progress[1]; hasProg {
		t.Fatalf("expected Pilot 1 in-progress lap state cleared on clear_pilot_laps")
	}
	for _, l := range ps.Sessions[0].Laps {
		if l.SlotIndex == 1 {
			t.Fatalf("expected 0 laps remaining for Pilot 1, got %+v", l)
		}
	}
	if len(ps.Sessions[0].Laps) != 2 {
		t.Fatalf("expected Pilot 2's 2 laps preserved after clearing Pilot 1, got %d", len(ps.Sessions[0].Laps))
	}
	_, _, activeLaps, _, _ := e.StateSnapshot()
	if len(activeLaps) != 2 {
		t.Fatalf("expected active engine laps synced to 2 remaining laps, got %d", len(activeLaps))
	}
}

func TestPracticeSessionUniqueLapIDsAcrossRestoreAndSplit(t *testing.T) {
	e := NewEngine()
	persisted := PersistedEngineState{
		Gates: []domain.TrackGate{
			{GateID: 1, Name: "H1", Role: domain.GateRoleStartFinish, AssignedTimerID: 1},
			{GateID: 2, Name: "T1", Role: domain.GateRoleSectorGate, AssignedTimerID: 2},
		},
		Pilots: []domain.PilotSlot{
			{SlotIndex: 1, Callsign: "OneEye", Band: domain.BandRaceband, Channel: 7, FrequencyMHz: 5880, Enabled: true},
		},
		Rules: domain.DefaultTimingRules(),
		PracticeState: &domain.PracticeManagerState{
			Initialized:       true,
			SelectedSessionID: "sess-verify",
			ActiveSessionID:   "", // Inactive session so root e.laps is empty on restore!
			Sessions: []domain.PracticeSession{
				{
					SessionID: "sess-verify",
					Name:      "25mW Verification",
					Pilots: []domain.PracticeSessionPilot{
						{SlotIndex: 1, Callsign: "OneEye", Band: domain.BandRaceband, Channel: 7, FrequencyMHz: 5880},
					},
					TrackSnapshot: []domain.TrackGate{
						{GateID: 1, Name: "H1", Role: domain.GateRoleStartFinish, AssignedTimerID: 1},
						{GateID: 2, Name: "T1", Role: domain.GateRoleSectorGate, AssignedTimerID: 2},
					},
					Laps: []domain.LapRecord{
						// Simulate legacy duplicate LapID=124 on L1 & L2 + L3 with LapID=125 ( merged 26s lap )
						{LapID: 124, SlotIndex: 1, Callsign: "OneEye", LapNumber: 1, LapTimeSec: 12.0, CompletedAtUs: 22_000_000},
						{LapID: 124, SlotIndex: 1, Callsign: "OneEye", LapNumber: 2, LapTimeSec: 13.0, CompletedAtUs: 35_000_000},
						{LapID: 125, SlotIndex: 1, Callsign: "OneEye", LapNumber: 3, LapTimeSec: 26.0, CompletedAtUs: 61_000_000},
					},
					Crossings: []domain.GateCrossingEvent{
						{EventID: 10, GateID: 1, SlotIndex: 1, TimestampUs: 10_000_000, IsStartFinish: true, StartedLap: true, PeakRSSIDbm: -55},
						{EventID: 11, GateID: 2, SlotIndex: 1, TimestampUs: 16_000_000, PeakRSSIDbm: -58},
						{EventID: 12, GateID: 1, SlotIndex: 1, TimestampUs: 22_000_000, IsStartFinish: true, PeakRSSIDbm: -54},
						{EventID: 13, GateID: 2, SlotIndex: 1, TimestampUs: 28_000_000, PeakRSSIDbm: -57},
						{EventID: 14, GateID: 1, SlotIndex: 1, TimestampUs: 35_000_000, IsStartFinish: true, PeakRSSIDbm: -55},
						{EventID: 15, GateID: 2, SlotIndex: 1, TimestampUs: 41_000_000, PeakRSSIDbm: -58},
						// Missed H1 at 48s!
						{EventID: 16, GateID: 2, SlotIndex: 1, TimestampUs: 54_000_000, PeakRSSIDbm: -57},
						{EventID: 17, GateID: 1, SlotIndex: 1, TimestampUs: 61_000_000, IsStartFinish: true, PeakRSSIDbm: -55},
					},
				},
			},
		},
	}
	e.RestoreState(persisted, false)

	// 1. Duplicate LapID=124 on restore must be auto-healed immediately above max LapID (125 -> 126).
	ps := e.PracticeSnapshot()
	seen := make(map[uint64]bool)
	for _, l := range ps.Sessions[0].Laps {
		if l.LapID == 0 || seen[l.LapID] {
			t.Fatalf("duplicate or zero LapID after restore: %+v", ps.Sessions[0].Laps)
		}
		seen[l.LapID] = true
	}

	// 2. Add the missed H1 crossing at 48s to split L3 into L3 + L4; all 4 laps must have distinct LapIDs!
	peak := float32(-56)
	afterSplit, _, err := e.AddPracticeSessionCrossing("sess-verify", 1, 1, 48_000_000, &peak)
	if err != nil {
		t.Fatalf("AddPracticeSessionCrossing failed: %v", err)
	}
	if len(afterSplit.Sessions[0].Laps) != 4 {
		t.Fatalf("expected 4 laps after splitting merged lap, got %d", len(afterSplit.Sessions[0].Laps))
	}
	seenAfter := make(map[uint64]bool)
	for _, l := range afterSplit.Sessions[0].Laps {
		if l.LapID == 0 || seenAfter[l.LapID] {
			t.Fatalf("duplicate or zero LapID after adding missed H1 crossing: %+v", afterSplit.Sessions[0].Laps)
		}
		seenAfter[l.LapID] = true
	}
}
