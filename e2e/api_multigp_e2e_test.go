//go:build e2e

package e2e_test

import (
	"fmt"
	"testing"

	"slaprf/internal/api"
	"slaprf/internal/domain"
	"slaprf/internal/multigp"
	"slaprf/internal/tracker"
)

// 1. Simulated MultiGP Admin CRUD + MultiGP v1.0.4 WebService Protocol & Auth Guards
func TestAPI_MultiGPSimAdminAndWebServiceProtocol(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/sim")

	// 1. GET /v1/sim/mgp-admin returns default Bay Area FPV chapter & 3 sample races (#501, #502, #503).
	var admin multigp.SimPersistedState
	h.APIGet("/v1/sim/mgp-admin", &admin)
	if admin.ChapterName != "Bay Area FPV" || admin.APIKey != multigp.DefaultSimAPIKey || len(admin.Races) != 3 {
		t.Fatalf("unexpected default /v1/sim/mgp-admin state: %+v", admin)
	}

	// 2. Test HTTP 401 Unauthorized on wrong API key & HTTP 404 Not Found on missing race/endpoint.
	h.APIExpectStatus("POST", "/v1/sim/mgp/chapter/findChapterFromApiKey", map[string]any{
		"apiKey": "WRONG-KEY",
	}, 401)
	h.APIExpectStatus("POST", "/v1/sim/mgp/race/view?id=999999", map[string]any{
		"apiKey": admin.APIKey,
	}, 404)
	h.APIExpectStatus("POST", "/v1/sim/mgp/unknown/endpoint", map[string]any{
		"apiKey": admin.APIKey,
	}, 404)

	// 3. Verify `findChapterFromApiKey`, `race/listForChapter`, and `race/view?id=501`.
	var chap multigp.FindChapterResponse
	h.APIPost("/v1/sim/mgp/chapter/findChapterFromApiKey", map[string]any{
		"apiKey": admin.APIKey,
	}, &chap)
	if !chap.Status || chap.ChapterID != 1042 || chap.ChapterName != "Bay Area FPV" {
		t.Fatalf("unexpected findChapterFromApiKey response: %+v", chap)
	}

	var list multigp.ListForChapterResponse
	h.APIPost("/v1/sim/mgp/race/listForChapter", map[string]any{
		"apiKey": admin.APIKey,
	}, &list)
	if !list.Status || len(list.Data) != 3 {
		t.Fatalf("expected 3 MultiGP chapter races, got %+v", list)
	}

	// 4. Exercise POST /v1/sim/mgp-admin:action mutations: rename chapter, add race, add pool pilot, add heat, regen key, reset.
	h.APIPost("/v1/sim/mgp-admin:action", map[string]any{
		"action":      "set-chapter",
		"chapterName": "Silicon Valley FPV",
	}, &admin)
	if admin.ChapterName != "Silicon Valley FPV" {
		t.Fatalf("expected chapter renamed to Silicon Valley FPV, got %q", admin.ChapterName)
	}

	h.APIPost("/v1/sim/mgp-admin:action", map[string]any{
		"action":        "add-race",
		"name":          "API Created Spec Shootout",
		"isZippyQ":      false,
		"roundCount":    2,
		"scoringFormat": multigp.ScoringFastest2Consecutive,
	}, &admin)
	if len(admin.Races) != 4 {
		t.Fatalf("expected 4 MultiGP races after add-race, got %d", len(admin.Races))
	}
	newRaceID := admin.Races[len(admin.Races)-1].ID

	h.APIPost("/v1/sim/mgp-admin:action", map[string]any{
		"action": "add-pool-pilot",
		"raceId": newRaceID,
		"name":   "AeroBlade",
	}, &admin)
	h.APIPost("/v1/sim/mgp-admin:action", map[string]any{
		"action":      "add-heat",
		"raceId":      newRaceID,
		"roundNumber": 1,
	}, &admin)
	h.APIPost("/v1/sim/mgp-admin:action", map[string]any{
		"action": "regen-key",
	}, &admin)
	if admin.APIKey == multigp.DefaultSimAPIKey || admin.APIKey == "" {
		t.Fatalf("expected regenerated MultiGP API key, got %q", admin.APIKey)
	}

	// Verify old default key now returns 401 while new regenerated key succeeds!
	h.APIExpectStatus("POST", "/v1/sim/mgp/chapter/findChapterFromApiKey", map[string]any{
		"apiKey": multigp.DefaultSimAPIKey,
	}, 401)
	h.APIPost("/v1/sim/mgp/chapter/findChapterFromApiKey", map[string]any{
		"apiKey": admin.APIKey,
	}, &chap)
	if chap.ChapterName != "Silicon Valley FPV" {
		t.Fatalf("expected Silicon Valley FPV on regenerated key, got %+v", chap)
	}

	// Reset MultiGP sim backend to clean defaults.
	h.APIPost("/v1/sim/mgp-admin:action", map[string]any{"action": "reset"}, &admin)
	if admin.APIKey != multigp.DefaultSimAPIKey || len(admin.Races) != 3 {
		t.Fatalf("expected /v1/sim/mgp-admin:action reset to restore defaults, got %+v", admin)
	}

	h.MilestoneScreenshot("api-multigp-admin-and-webservice")
}

// 2. Full Controlled Schedule MultiGP E2E via API: Fetch -> Import -> Score Heats -> Sync Plan -> Upload -> Mark Synced
func TestAPI_MultiGPE2E_ControlledScheduleImportScoreSyncPlanCaptureAndMarkSynced(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/races")

	// Trim race #501 down to 1 round in /v1/sim/mgp-admin:action so our E2E confirms every heat in the race cleanly!
	var admin multigp.SimPersistedState
	h.APIPost("/v1/sim/mgp-admin:action", map[string]any{"action": "delete-round", "raceId": 501, "roundNumber": 3}, &admin)
	h.APIPost("/v1/sim/mgp-admin:action", map[string]any{"action": "delete-round", "raceId": 501, "roundNumber": 2}, &admin)

	// 1. Fetch `race/view?id=501` via MultiGP WebService API.
	var view multigp.RaceViewResponse
	h.APIPost("/v1/sim/mgp/race/view?id=501", map[string]any{
		"apiKey": multigp.DefaultSimAPIKey,
	}, &view)
	if !view.Status || view.Data.ID != 501 || len(view.Data.Schedule.Rounds) != 1 {
		t.Fatalf("expected race #501 with 1 round, got %+v", view)
	}

	// 2. Import race #501 into SlapRF via `POST /v1/race/sessions:importMultiGP` (`importMode: "schedule"` -> 201 Created).
	var importResp struct {
		CreatedRace domain.RaceTournamentState `json:"createdRace"`
		State       api.FullStateResponse      `json:"state"`
	}
	impRes := h.APIPost("/v1/race/sessions:importMultiGP", map[string]any{
		"race":       view.Data,
		"importMode": "schedule",
	}, &importResp)
	if impRes.Status != 201 {
		t.Fatalf("expected 201 Created from POST /v1/race/sessions:importMultiGP, got %d", impRes.Status)
	}

	raceID := importResp.CreatedRace.RaceID
	slug := domain.SlugifyRaceName(importResp.CreatedRace.Config.EventName)
	if raceID == "" || importResp.CreatedRace.MGPLink == nil || importResp.CreatedRace.MGPLink.RaceID != 501 {
		t.Fatalf("expected imported race linked to MultiGP #501, got %+v", importResp.CreatedRace)
	}

	_, _ = h.Page.Evaluate(`(hash) => { window.location.hash = hash; }`, fmt.Sprintf("#/races/%s/stage-1", slug))

	// 3. Score & confirm both Round 1 heats via API!
	st := importResp.State
	for _, ht := range importResp.CreatedRace.Heats {
		st = apiScoreAndConfirmHeat(h, ht.ID, nil)
	}

	// 4. Build outbound MultiGP sync plan (`GET /v1/race/sessions/{raceId}/multigp/sync-plan`).
	var plan tracker.MultiGPSyncPlan
	h.APIGet(fmt.Sprintf("/v1/race/sessions/%s/multigp/sync-plan", raceID), &plan)
	if plan.MGPRaceID != 501 || len(plan.Operations) != 8 || len(plan.OverallResults) == 0 {
		t.Fatalf("expected 8 slot sync ops (2 heats x 4 pilots) and podium overallResults, got ops=%d overall=%d",
			len(plan.Operations), len(plan.OverallResults))
	}

	// 5. Push each `assignSlot` op and `captureOverallRaceResult` to `/v1/sim/mgp/*` via `window.slaprfCurl`!
	syncedHeatSet := make(map[string]bool)
	for _, op := range plan.Operations {
		url := fmt.Sprintf("/v1/sim/mgp/race/assignSlot?id=%d&cycle=%d&heat=%d&slot=%d",
			plan.MGPRaceID, op.Cycle, op.Heat, op.Slot)
		var slotRes multigp.GenericStatusResponse
		h.APIPost(url, map[string]any{
			"apiKey": multigp.DefaultSimAPIKey,
			"data":   op.Data,
		}, &slotRes)
		if !slotRes.Status {
			t.Fatalf("assignSlot failed for %+v: %+v", op, slotRes)
		}
		syncedHeatSet[op.HeatID] = true
	}

	var capRes multigp.GenericStatusResponse
	h.APIPost(fmt.Sprintf("/v1/sim/mgp/race/captureOverallRaceResult?id=%d", plan.MGPRaceID), map[string]any{
		"apiKey": multigp.DefaultSimAPIKey,
		"data": map[string]any{
			"raceId":         plan.MGPRaceID,
			"bracketResults": plan.OverallResults,
		},
	}, &capRes)
	if !capRes.Status {
		t.Fatalf("captureOverallRaceResult failed: %+v", capRes)
	}

	// 6. Mark race synced in SlapRF (`PUT /v1/race/sessions/{raceId}/multigp/sync-state`) and verify incremental plan now has 0 pending ops!
	var syncedHeatIDs []string
	for hid := range syncedHeatSet {
		syncedHeatIDs = append(syncedHeatIDs, hid)
	}
	h.APIPut(fmt.Sprintf("/v1/race/sessions/%s/multigp/sync-state", raceID), map[string]any{
		"syncedHeatIds": syncedHeatIDs,
		"overallSynced": true,
	}, &st)

	var afterPlan tracker.MultiGPSyncPlan
	h.APIGet(fmt.Sprintf("/v1/race/sessions/%s/multigp/sync-plan", raceID), &afterPlan)
	if len(afterPlan.Operations) != 0 {
		t.Fatalf("expected 0 pending MultiGP sync operations after sync-state update, got %d", len(afterPlan.Operations))
	}

	// Verify simulated MultiGP backend recorded the uploaded lap times & overall podium!
	h.APIPost("/v1/sim/mgp/race/view?id=501", map[string]any{
		"apiKey": multigp.DefaultSimAPIKey,
	}, &view)
	if view.Data.OverallSyncedAt == "" || len(view.Data.OverallResults) != len(plan.OverallResults) {
		t.Fatalf("expected MultiGP #501 to store OverallResults, got %+v", view.Data)
	}
	if view.Data.Schedule.Rounds[0].Heats[0].Entries[0].TotalLaps == 0 {
		t.Fatalf("expected MultiGP #501 Round 1 Heat 1 Slot 1 to record uploaded TotalLaps > 0, got %+v",
			view.Data.Schedule.Rounds[0].Heats[0].Entries[0])
	}

	h.MilestoneScreenshot("api-multigp-controlled-roundtrip-synced")
}

// 3. ZippyQ Dynamic Walk-Up Rounds E2E via API: Import #502 -> Queue New Round -> getAdditionalRounds -> appendZippyQ -> Score
func TestAPI_MultiGPE2E_ZippyQDynamicRoundsAppendAndSync(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/races")

	// Pause background auto-ZippyQ on #502 so round counts are 100% deterministic during our test assertions.
	var admin multigp.SimPersistedState
	h.APIPost("/v1/sim/mgp-admin:action", map[string]any{
		"action":  "set-auto-zippyq",
		"raceId":  502,
		"enabled": false,
	}, &admin)

	var view multigp.RaceViewResponse
	h.APIPost("/v1/sim/mgp/race/view?id=502", map[string]any{
		"apiKey": multigp.DefaultSimAPIKey,
	}, &view)
	initialRounds := len(view.Data.Schedule.Rounds)
	if initialRounds < 2 {
		t.Fatalf("expected ZippyQ race #502 to start with >= 2 rounds, got %d", initialRounds)
	}

	// 1. Import ZippyQ race #502 via `POST /v1/race/sessions:importMultiGP` (`importMode: "zippyq"`).
	var importResp struct {
		CreatedRace domain.RaceTournamentState `json:"createdRace"`
		State       api.FullStateResponse      `json:"state"`
	}
	h.APIPost("/v1/race/sessions:importMultiGP", map[string]any{
		"race":       view.Data,
		"importMode": "zippyq",
	}, &importResp)

	raceID := importResp.CreatedRace.RaceID
	slug := domain.SlugifyRaceName(importResp.CreatedRace.Config.EventName)
	initialHeats := len(importResp.CreatedRace.Heats)
	_, _ = h.Page.Evaluate(`(hash) => { window.location.hash = hash; }`, fmt.Sprintf("#/races/%s/control", slug))

	// 2. Simulate a new walk-up ZippyQ round queued in MultiGP (`queue-zippyq`) and fetch via `race/getAdditionalRounds`!
	h.APIPost("/v1/sim/mgp-admin:action", map[string]any{
		"action": "queue-zippyq",
		"raceId": 502,
	}, &admin)

	var addRounds multigp.AdditionalRoundsResponse
	h.APIPost(fmt.Sprintf("/v1/sim/mgp/race/getAdditionalRounds?id=502&cycle=%d", initialRounds+1), map[string]any{
		"apiKey": multigp.DefaultSimAPIKey,
	}, &addRounds)
	if !addRounds.Status || len(addRounds.Data.Rounds) != 1 {
		t.Fatalf("expected 1 additional ZippyQ round from cycle=%d, got %+v", initialRounds+1, addRounds)
	}

	// 3. Append dynamic ZippyQ round into SlapRF (`POST /v1/race/sessions/{raceId}/multigp:appendZippyQ`) and verify idempotency!
	var appendResp struct {
		AddedHeats int                        `json:"addedHeats"`
		RaceState  domain.RaceTournamentState `json:"raceState"`
	}
	h.APIPost(fmt.Sprintf("/v1/race/sessions/%s/multigp:appendZippyQ", raceID), map[string]any{
		"rounds": addRounds.Data.Rounds,
	}, &appendResp)
	if appendResp.AddedHeats != 1 || len(appendResp.RaceState.Heats) != initialHeats+1 {
		t.Fatalf("expected +1 appended ZippyQ heat (total %d), got added=%d total=%d",
			initialHeats+1, appendResp.AddedHeats, len(appendResp.RaceState.Heats))
	}

	// Re-appending the exact same round must be a clean no-op (`addedHeats: 0`).
	var dupResp struct {
		AddedHeats int `json:"addedHeats"`
	}
	h.APIPost(fmt.Sprintf("/v1/race/sessions/%s/multigp:appendZippyQ", raceID), map[string]any{
		"rounds": addRounds.Data.Rounds,
	}, &dupResp)
	if dupResp.AddedHeats != 0 {
		t.Fatalf("expected duplicate appendZippyQ to add 0 heats, got %d", dupResp.AddedHeats)
	}

	// 4. Score the newly appended ZippyQ heat and verify `/multigp/sync-plan` generates outbound `assignSlot` operations!
	newHeatID := appendResp.RaceState.Heats[len(appendResp.RaceState.Heats)-1].ID
	_ = apiScoreAndConfirmHeat(h, newHeatID, nil)

	var plan tracker.MultiGPSyncPlan
	h.APIGet(fmt.Sprintf("/v1/race/sessions/%s/multigp/sync-plan", raceID), &plan)
	if len(plan.Operations) == 0 {
		t.Fatalf("expected outbound assignSlot operations for newly scored ZippyQ heat %s", newHeatID)
	}

	h.MilestoneScreenshot("api-multigp-zippyq-dynamic-append")
}
