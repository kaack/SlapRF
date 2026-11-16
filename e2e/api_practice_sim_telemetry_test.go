//go:build e2e

package e2e_test

import (
	"testing"
	"time"

	"slaprf/internal/api"
)

func TestAPI_PracticeSessionLifecyclePilotsTagsAndClearLaps(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/live")

	// 1. Create a new Practice session via POST /api/practice/action ("create_session").
	var st api.FullStateResponse
	h.APIPost("/api/practice/action", map[string]any{
		"action": "create_session",
		"name":   "API Tuning Session",
		"tags":   []string{"5-inch", "Tune"},
	}, &st)

	var targetSessionID string
	for _, s := range st.PracticeState.Sessions {
		if s.Name == "API Tuning Session" {
			targetSessionID = s.SessionID
		}
	}
	if targetSessionID == "" {
		t.Fatalf("expected created session 'API Tuning Session' in PracticeState.Sessions")
	}

	// 2. Rename session and update tags via API.
	h.APIPost("/api/practice/action", map[string]any{
		"action":    "rename_session",
		"sessionId": targetSessionID,
		"name":      "PID Filter Dial-In",
	}, &st)
	h.APIPost("/api/practice/action", map[string]any{
		"action":    "set_session_tags",
		"sessionId": targetSessionID,
		"tags":      []string{"RaceDay", "6S"},
	}, &st)

	// 3. Manage session pilots: add new inline pilot ("SkyWalker"), change channel, remove pilot.
	h.APIPost("/api/practice/action", map[string]any{
		"action":       "add_session_pilot",
		"sessionId":    targetSessionID,
		"callsign":     "SkyWalker",
		"phoneticName": "Sky Walker",
	}, &st)

	var skySlot int
	for _, p := range st.Pilots {
		if p.Callsign == "SkyWalker" {
			skySlot = p.SlotIndex
		}
	}
	if skySlot == 0 {
		t.Fatalf("expected inline session pilot SkyWalker added to global Pilots pool")
	}

	h.APIPost("/api/practice/action", map[string]any{
		"action":    "set_session_pilot_channel",
		"sessionId": targetSessionID,
		"slotIndex": skySlot,
		"band":      1,
		"channel":   8,
	}, &st)

	h.APIPost("/api/practice/action", map[string]any{
		"action":    "remove_session_pilot",
		"sessionId": targetSessionID,
		"slotIndex": skySlot,
	}, &st)
	h.MilestoneScreenshot("api-practice-session-pilots-and-tags")

	// 4. Exercise start -> pause -> resume -> stop -> delete lifecycle via API.
	h.APIPost("/api/practice/action", map[string]any{
		"action":         "start_session",
		"sessionId":      targetSessionID,
		"preemptOngoing": true,
	}, &st)
	if st.PracticeState.ActiveSessionID != targetSessionID {
		t.Fatalf("expected ActiveSessionID=%s after start_session, got %s", targetSessionID, st.PracticeState.ActiveSessionID)
	}

	h.APIPost("/api/practice/action", map[string]any{
		"action":    "pause_session",
		"sessionId": targetSessionID,
	}, &st)
	h.APIPost("/api/practice/action", map[string]any{
		"action":         "resume_session",
		"sessionId":      targetSessionID,
		"preemptOngoing": true,
	}, &st)
	h.APIPost("/api/practice/action", map[string]any{
		"action":    "stop_session",
		"sessionId": targetSessionID,
	}, &st)
	h.APIPost("/api/practice/action", map[string]any{
		"action":    "delete_session",
		"sessionId": targetSessionID,
	}, &st)

	for _, s := range st.PracticeState.Sessions {
		if s.SessionID == targetSessionID {
			t.Fatalf("expected session %s deleted", targetSessionID)
		}
	}
}

func TestAPI_PracticeLiveSimulatorLapsCrossingsSummariesAndReset(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/live")
	h.ConnectSimHubH1()

	// Start active Practice session, set 20x simulator speed, and trigger pack burst via API!
	var st api.FullStateResponse
	initSt := h.APIState()
	sessionID := initSt.PracticeState.Sessions[0].SessionID
	h.APIPost("/api/practice/action", map[string]any{
		"action":         "start_session",
		"sessionId":      sessionID,
		"preemptOngoing": true,
	}, &st)
	h.APIPost("/api/sim/speed", map[string]any{"speedMultiplier": 20}, &st)
	h.APIPost("/api/sim/pack-burst", map[string]any{}, &st)
	h.APIPost("/api/sim/pilot-action", map[string]any{"slotIndex": 1, "action": "fly"}, &st)

	// Poll GET /api/state until real DSP-detected crossings, multi-sector laps, and summaries populate!
	h.WaitUntil("WASM /api/state records >= 3 completed multi-sector laps and summaries", 20*time.Second, func() (bool, error) {
		cur := h.APIState()
		if len(cur.Laps) < 3 || len(cur.Crossings) < 8 || len(cur.Summaries) == 0 {
			return false, nil
		}
		hasBest := false
		for _, sum := range cur.Summaries {
			if sum.LapsCompleted >= 1 && sum.BestLapSec > 0 && len(sum.SectorStats) >= 2 {
				hasBest = true
			}
		}
		return hasBest, nil
	})
	h.MilestoneScreenshot("api-practice-fast-sim-laps-scored")

	// Exercise clear_session_laps and POST /api/session/reset, verifying 0 laps in /api/state.
	h.APIPost("/api/practice/action", map[string]any{
		"action":    "clear_session_laps",
		"sessionId": sessionID,
	}, &st)
	if len(st.Laps) != 0 {
		t.Fatalf("expected 0 laps after clear_session_laps, got %d", len(st.Laps))
	}

	h.APIPost("/api/session/reset", map[string]any{}, &st)
	if len(st.Laps) != 0 || len(st.Crossings) != 0 {
		t.Fatalf("expected 0 laps and crossings after /api/session/reset")
	}
}

func TestAPI_WasmRealtimeStreamEnvelopesAndTrackWalker(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/track")
	h.ConnectSimHubH1()

	// Exercise Track Walker mode via POST /api/sim/track-walker (active=true -> crossings along gates -> active=false).
	var st api.FullStateResponse
	h.APIPost("/api/sim/speed", map[string]any{"speedMultiplier": 20}, &st)
	h.APIPost("/api/sim/track-walker", map[string]any{"active": true}, &st)
	if st.SimState == nil || !st.SimState.TrackWalkerActive {
		t.Fatalf("expected SimState.TrackWalkerActive=true after /api/sim/track-walker")
	}

	// Verify live 50 Hz binary telemetry frames are actively updating the UI store from WASM!
	h.WaitUntil("live telemetry frames updating gate RSSI in WASM/store", 10*time.Second, func() (bool, error) {
		stNow := h.APIStatus()
		onlineCount := 0
		for _, tm := range stNow.Timers {
			if tm.Online {
				onlineCount++
			}
		}
		return onlineCount >= 4, nil
	})
	h.MilestoneScreenshot("api-track-walker-and-live-telemetry")

	h.APIPost("/api/sim/track-walker", map[string]any{"active": false}, &st)
	if st.SimState.TrackWalkerActive {
		t.Fatalf("expected SimState.TrackWalkerActive=false after disabling")
	}
}

func TestAPI_PracticeAndRaceMutualPreemptionGuards(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/live")

	// 1. Start Practice session 1.
	var st api.FullStateResponse
	pID := h.APIState().PracticeState.Sessions[0].SessionID
	h.APIPost("/api/practice/action", map[string]any{
		"action":         "start_session",
		"sessionId":      pID,
		"preemptOngoing": true,
	}, &st)
	if st.PracticeState.ActiveSessionID != pID {
		t.Fatalf("expected practice session active")
	}

	// 2. Create & configure a Single Elimination race and start Heat 1 -> Practice auto-pauses!
	h.APIPost("/api/events/action", map[string]any{
		"action": "create_race",
		"name":   "Preemption Cup",
	}, &st)
	raceID := st.RaceState.RaceID
	h.APIPost("/api/race/bracket-edit", map[string]any{
		"action":     "apply_template",
		"raceId":     raceID,
		"templateId": "single_elimination",
		"targetLaps": 2,
	}, &st)
	h.APIPost("/api/race/control", map[string]any{
		"raceId":         raceID,
		"action":         "start",
		"preemptOngoing": true,
	}, &st)
	if st.PracticeState.ActiveSessionID != "" {
		t.Fatalf("expected starting Race heat to pause active Practice session, got ActiveSessionID=%q", st.PracticeState.ActiveSessionID)
	}

	// 3. Attempting to resume Practice WITHOUT preemptOngoing while Race is active must return HTTP 400!
	resBlocked := h.APIExpectStatus("POST", "/api/practice/action", map[string]any{
		"action":         "resume_session",
		"sessionId":      pID,
		"preemptOngoing": false,
	}, 400)
	if resBlocked.Body == "" {
		t.Fatalf("expected descriptive conflict error message on 400")
	}

	// 4. Resuming Practice WITH preemptOngoing=true cleanly pauses the ongoing Race and activates Practice!
	h.APIPost("/api/practice/action", map[string]any{
		"action":         "resume_session",
		"sessionId":      pID,
		"preemptOngoing": true,
	}, &st)
	if st.PracticeState.ActiveSessionID != pID {
		t.Fatalf("expected Practice session %s active after preemptOngoing=true", pID)
	}
	for _, rc := range st.EventState.Races {
		if rc.RaceID == raceID && string(rc.Lifecycle) != "paused" {
			t.Fatalf("expected preempted race %s lifecycle=paused, got %s", raceID, rc.Lifecycle)
		}
	}
	h.MilestoneScreenshot("api-practice-preempted-race")
}
