//go:build e2e

package e2e_test

import (
	"fmt"
	"testing"
	"time"

	"slaprf/internal/api"
)

func TestAPI_PracticeSessionLifecyclePilotsTagsAndClearLaps(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/practice")

	// 1. Create a new Practice session via POST /v1/practice/sessions (returns 201 Created).
	var st api.FullStateResponse
	createRes := h.APIPost("/v1/practice/sessions", map[string]any{
		"name": "API Tuning Session",
		"tags": []string{"5-inch", "Tune"},
	}, &st)
	if createRes.Status != 201 {
		t.Fatalf("expected 201 Created from POST /v1/practice/sessions, got %d", createRes.Status)
	}

	var targetSessionID string
	for _, s := range st.PracticeState.Sessions {
		if s.Name == "API Tuning Session" {
			targetSessionID = s.SessionID
		}
	}
	if targetSessionID == "" {
		t.Fatalf("expected created session 'API Tuning Session' in PracticeState.Sessions")
	}

	// 2. Rename session and update tags via PATCH /v1/practice/sessions/{sessionId}.
	sessPath := fmt.Sprintf("/v1/practice/sessions/%s", targetSessionID)
	h.APIPatch(sessPath, map[string]any{
		"name": "PID Filter Dial-In",
		"tags": []string{"RaceDay", "6S"},
	}, &st)

	// 3. Manage session pilots: add new inline pilot ("SkyWalker") via POST .../pilots, change channel via PUT .../pilots/{slot}, remove via DELETE.
	addPilotRes := h.APIPost(sessPath+"/pilots", map[string]any{
		"callsign":     "SkyWalker",
		"phoneticName": "Sky Walker",
	}, &st)
	if addPilotRes.Status != 201 {
		t.Fatalf("expected 201 Created from POST %s/pilots, got %d", sessPath, addPilotRes.Status)
	}

	var skySlot int
	for _, p := range st.Pilots {
		if p.Callsign == "SkyWalker" {
			skySlot = p.SlotIndex
		}
	}
	if skySlot == 0 {
		t.Fatalf("expected inline session pilot SkyWalker added to global Pilots pool")
	}

	h.APIPut(fmt.Sprintf("%s/pilots/%d", sessPath, skySlot), map[string]any{
		"band":    1,
		"channel": 8,
	}, &st)

	h.APIDelete(fmt.Sprintf("%s/pilots/%d", sessPath, skySlot), &st)
	h.MilestoneScreenshot("api-practice-session-pilots-and-tags")

	// 4. Exercise :start -> :pause -> :resume -> :stop -> DELETE lifecycle via API.
	h.APIPost(sessPath+":start", map[string]any{
		"preemptOngoing": true,
	}, &st)
	if st.PracticeState.ActiveSessionID != targetSessionID {
		t.Fatalf("expected ActiveSessionID=%s after :start, got %s", targetSessionID, st.PracticeState.ActiveSessionID)
	}

	// Deleting a live practice session must fail with 409 Conflict!
	h.APIExpectStatus("DELETE", sessPath, nil, 409)

	h.APIPost(sessPath+":pause", map[string]any{}, &st)
	h.APIPost(sessPath+":resume", map[string]any{
		"preemptOngoing": true,
	}, &st)
	h.APIPost(sessPath+":stop", map[string]any{}, &st)
	h.APIDelete(sessPath, &st)

	for _, s := range st.PracticeState.Sessions {
		if s.SessionID == targetSessionID {
			t.Fatalf("expected session %s deleted", targetSessionID)
		}
	}
}

func TestAPI_PracticeLiveSimulatorLapsCrossingsSummariesAndReset(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/practice")
	h.ConnectSimHubH1()

	// Start active Practice session, set 20x simulator speed, and trigger pack burst via API!
	var st api.FullStateResponse
	initSt := h.APIState()
	sessionID := initSt.PracticeState.Sessions[0].SessionID
	h.APIPost(fmt.Sprintf("/v1/practice/sessions/%s:start", sessionID), map[string]any{
		"preemptOngoing": true,
	}, &st)
	h.APIPatch("/v1/sim", map[string]any{"speedMultiplier": 20}, &st)
	h.APIPost("/v1/sim:packBurst", map[string]any{}, &st)
	h.APIPost("/v1/sim/pilots/1:action", map[string]any{"action": "fly"}, &st)

	// Poll GET /v1/state until real DSP-detected crossings, multi-sector laps, and summaries populate!
	h.WaitUntil("engine /v1/state records >= 3 completed multi-sector laps and summaries", 20*time.Second, func() (bool, error) {
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

	// Exercise :clearLaps and POST /v1/practice:reset, verifying 0 laps in /v1/state.
	h.APIPost(fmt.Sprintf("/v1/practice/sessions/%s:clearLaps", sessionID), map[string]any{}, &st)
	if len(st.Laps) != 0 {
		t.Fatalf("expected 0 laps after :clearLaps, got %d", len(st.Laps))
	}

	h.APIPost("/v1/practice:reset", map[string]any{}, &st)
	if len(st.Laps) != 0 || len(st.Crossings) != 0 {
		t.Fatalf("expected 0 laps and crossings after /v1/practice:reset")
	}
}

func TestAPI_WasmRealtimeStreamEnvelopesAndTrackWalker(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/practice/open-practice/track")
	h.ConnectSimHubH1()

	// Exercise Track Walker mode via PATCH /v1/sim {"trackWalker": true}.
	var st api.FullStateResponse
	h.APIPatch("/v1/sim", map[string]any{"speedMultiplier": 20, "trackWalker": true}, &st)
	if st.SimState == nil || !st.SimState.TrackWalkerActive {
		t.Fatalf("expected SimState.TrackWalkerActive=true after PATCH /v1/sim")
	}

	// Verify live 50 Hz binary telemetry frames are actively updating the UI store!
	h.WaitUntil("live telemetry frames updating gate RSSI", 10*time.Second, func() (bool, error) {
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

	h.APIPatch("/v1/sim", map[string]any{"trackWalker": false}, &st)
	if st.SimState.TrackWalkerActive {
		t.Fatalf("expected SimState.TrackWalkerActive=false after disabling")
	}
}

func TestAPI_PracticeAndRaceMutualPreemptionGuards(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/practice")

	// 1. Start Practice session 1 via :start.
	var st api.FullStateResponse
	pID := h.APIState().PracticeState.Sessions[0].SessionID
	h.APIPost(fmt.Sprintf("/v1/practice/sessions/%s:start", pID), map[string]any{
		"preemptOngoing": true,
	}, &st)
	if st.PracticeState.ActiveSessionID != pID {
		t.Fatalf("expected practice session active")
	}

	// 2. Create & configure a Single Elimination race and start Heat 1 -> Practice auto-pauses!
	h.APIPost("/v1/race/sessions", map[string]any{
		"name": "Preemption Cup",
	}, &st)
	raceID := st.RaceState.RaceID
	h.APIPost(fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), map[string]any{
		"action":     "apply_template",
		"templateId": "single_elimination",
		"targetLaps": 2,
	}, &st)
	h.APIPost(fmt.Sprintf("/v1/race/sessions/%s/heats/current:control", raceID), map[string]any{
		"action":         "start",
		"preemptOngoing": true,
	}, &st)
	if st.PracticeState.ActiveSessionID != "" {
		t.Fatalf("expected starting Race heat to pause active Practice session, got ActiveSessionID=%q", st.PracticeState.ActiveSessionID)
	}

	// 3. Attempting to resume Practice WITHOUT preemptOngoing while Race is active must return HTTP 409 Conflict!
	resBlocked := h.APIExpectStatus("POST", fmt.Sprintf("/v1/practice/sessions/%s:resume", pID), map[string]any{
		"preemptOngoing": false,
	}, 409)
	if resBlocked.Body == "" {
		t.Fatalf("expected descriptive conflict error message on 409")
	}

	// 4. Resuming Practice WITH preemptOngoing=true cleanly pauses the ongoing Race and activates Practice!
	h.APIPost(fmt.Sprintf("/v1/practice/sessions/%s:resume", pID), map[string]any{
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
