package api_test

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"slaprf/internal/api"
	"slaprf/internal/domain"
	"slaprf/internal/ingest"
	"slaprf/internal/laprf"
	"slaprf/internal/tracker"
)

func TestRESTv1CRUDSemanticsSingletonsCustomActionsAndSymmetry(t *testing.T) {
	simEng := tracker.NewEngine()
	realEng := tracker.NewRealEngine()
	sim := ingest.NewTrackSimulator(simEng)
	sim.SetRunning(true)
	defer sim.SetRunning(false)
	lrf := laprf.NewServer(simEng)
	srv := api.NewServer(simEng, sim, lrf, realEng)
	h := srv.Handler()

	// 1. Singletons must NEVER allow DELETE; improper HTTP methods return 405 Method Not Allowed + Allow header
	for _, singletonPath := range []string{
		"/v1/version",
		"/v1/state",
		"/v1/status",
		"/v1/timing/rules",
		"/v1/timing/arm",
		"/v1/timing/mode",
		"/v1/track",
		"/v1/hardware/mode",
		"/v1/sim",
		"/v1/storage",
		"/v1/storage/sim",
	} {
		rec := reqJSON(t, h, http.MethodDelete, singletonPath, nil)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("expected 405 Method Not Allowed on DELETE singleton %s, got %d", singletonPath, rec.Code)
		}
		if rec.Header().Get("Allow") == "" {
			t.Fatalf("expected Allow header on 405 for DELETE %s", singletonPath)
		}
	}
	if rec := reqJSON(t, h, http.MethodPost, "/v1/version", map[string]any{}); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 on POST /v1/version, got %d", rec.Code)
	}
	if rec := reqJSON(t, h, http.MethodPost, "/v1/pilots/1", map[string]any{}); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 on POST /v1/pilots/1 without :action, got %d", rec.Code)
	}

	// 2. Singleton custom actions use POST ...:<action> (e.g. /v1/storage:reset, /v1/track:reset, /v1/pilots:reset)
	if resetStore := reqJSON(t, h, http.MethodPost, "/v1/storage:reset", map[string]any{}); resetStore.Code != http.StatusOK {
		t.Fatalf("expected 200 on POST /v1/storage:reset, got %d", resetStore.Code)
	}
	decodeState(t, reqJSON(t, h, http.MethodPatch, "/v1/sim", map[string]any{"running": true}))
	decodeState(t, reqJSON(t, h, http.MethodPost, "/v1/track:reset", map[string]any{"preset": " figure8 "}))
	decodeState(t, reqJSON(t, h, http.MethodPost, "/v1/pilots:reset", map[string]any{}))

	// 3. Legacy /api/* paths are gone -> 404 Not Found
	if rec := reqJSON(t, h, http.MethodGet, "/api/state", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 on legacy /api/state, got %d", rec.Code)
	}

	// 4. Pilots CRUD: POST (201 + Location), GET item (200 / 404), PUT (200 / 409), DELETE (200 / 404)
	createPilotRec := reqJSON(t, h, http.MethodPost, "/v1/pilots", map[string]string{
		"callsign":     "RestPilot",
		"phoneticName": "Rest Pilot",
	})
	st := decodeCreatedState(t, createPilotRec)
	pilotLoc := createPilotRec.Header().Get("Location")
	if !strings.HasPrefix(pilotLoc, "/v1/pilots/") {
		t.Fatalf("expected Location /v1/pilots/{slotIndex}, got %q", pilotLoc)
	}
	createdSlot := st.Pilots[len(st.Pilots)-1].SlotIndex

	if dupRec := reqJSON(t, h, http.MethodPost, "/v1/pilots", map[string]string{"callsign": "RestPilot"}); dupRec.Code != http.StatusConflict {
		t.Fatalf("expected 409 Conflict on duplicate pilot callsign, got %d", dupRec.Code)
	}
	if getRec := reqJSON(t, h, http.MethodGet, pilotLoc, nil); getRec.Code != http.StatusOK {
		t.Fatalf("expected 200 on GET %s, got %d", pilotLoc, getRec.Code)
	}
	if missRec := reqJSON(t, h, http.MethodGet, "/v1/pilots/999", nil); missRec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 on GET /v1/pilots/999, got %d", missRec.Code)
	}
	if missPut := reqJSON(t, h, http.MethodPut, "/v1/pilots/999", domain.PilotSlot{Callsign: "Ghost"}); missPut.Code != http.StatusNotFound {
		t.Fatalf("expected 404 on PUT /v1/pilots/999, got %d", missPut.Code)
	}
	delPilotRec := reqJSON(t, h, http.MethodDelete, fmt.Sprintf("/v1/pilots/%d", createdSlot), nil)
	decodeState(t, delPilotRec)
	if delAgain := reqJSON(t, h, http.MethodDelete, fmt.Sprintf("/v1/pilots/%d", createdSlot), nil); delAgain.Code != http.StatusNotFound {
		t.Fatalf("expected 404 on second DELETE /v1/pilots/%d, got %d", createdSlot, delAgain.Code)
	}

	// 5. Track Gates CRUD + singleton sub-resource rules:reset
	createGateRec := reqJSON(t, h, http.MethodPost, "/v1/track/gates", map[string]any{
		"name":       "Corkscrew",
		"trackOrder": 2,
	})
	decodeCreatedState(t, createGateRec)
	gateLoc := createGateRec.Header().Get("Location")
	if !strings.HasPrefix(gateLoc, "/v1/track/gates/") {
		t.Fatalf("expected Location /v1/track/gates/{gateId}, got %q", gateLoc)
	}
	if delRules := reqJSON(t, h, http.MethodDelete, gateLoc+"/rules", nil); delRules.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 on DELETE %s/rules (rules sub-resource is a singleton), got %d", gateLoc, delRules.Code)
	}
	minCross := 0.22
	decodeState(t, reqJSON(t, h, http.MethodPut, gateLoc+"/rules", domain.GateRuleOverrides{MinCrossingSec: &minCross}))
	decodeState(t, reqJSON(t, h, http.MethodPost, gateLoc+"/rules:reset", map[string]any{}))
	decodeState(t, reqJSON(t, h, http.MethodDelete, gateLoc, nil))
	if delGateAgain := reqJSON(t, h, http.MethodDelete, gateLoc, nil); delGateAgain.Code != http.StatusNotFound {
		t.Fatalf("expected 404 on second DELETE %s, got %d", gateLoc, delGateAgain.Code)
	}

	// 6. Symmetric Practice Sessions (/v1/practice/sessions) & Race Sessions (/v1/race/sessions) CRUD + :lifecycle custom methods
	pCreateRec := reqJSON(t, h, http.MethodPost, "/v1/practice/sessions", map[string]any{
		"name": "Morning Warmup",
		"tags": []string{"Warmup"},
	})
	pState := decodeCreatedState(t, pCreateRec)
	pLoc := pCreateRec.Header().Get("Location")
	if !strings.HasPrefix(pLoc, "/v1/practice/sessions/") {
		t.Fatalf("expected practice session Location header, got %q", pLoc)
	}
	pID := pState.PracticeState.SelectedSessionID

	if dupPrac := reqJSON(t, h, http.MethodPost, "/v1/practice/sessions", map[string]any{"name": "Morning Warmup"}); dupPrac.Code != http.StatusConflict {
		t.Fatalf("expected 409 Conflict on duplicate practice session name, got %d", dupPrac.Code)
	}
	if getPrac := reqJSON(t, h, http.MethodGet, pLoc, nil); getPrac.Code != http.StatusOK {
		t.Fatalf("expected 200 on GET %s, got %d", pLoc, getPrac.Code)
	}
	// Calling GET on :start custom action must return 405 Method Not Allowed with Allow: POST
	if badMethodAction := reqJSON(t, h, http.MethodGet, pLoc+":start", nil); badMethodAction.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 on GET %s:start, got %d", pLoc, badMethodAction.Code)
	}
	addPracPilot := reqJSON(t, h, http.MethodPost, pLoc+"/pilots", map[string]any{"slotIndex": 1, "channel": 4})
	decodeCreatedState(t, addPracPilot)
	decodeState(t, reqJSON(t, h, http.MethodPut, pLoc+"/pilots/1", map[string]any{"channel": 5}))
	decodeState(t, reqJSON(t, h, http.MethodDelete, pLoc+"/pilots/1", nil))
	if delMissingPilot := reqJSON(t, h, http.MethodDelete, pLoc+"/pilots/1", nil); delMissingPilot.Code != http.StatusNotFound {
		t.Fatalf("expected 404 deleting absent pilot from practice session, got %d", delMissingPilot.Code)
	}

	// Activate practice session via :start -> deleting while active returns 409 Conflict; :pause then DELETE returns 200 OK
	decodeState(t, reqJSON(t, h, http.MethodPost, pLoc+":start", map[string]any{}))
	if delLivePrac := reqJSON(t, h, http.MethodDelete, pLoc, nil); delLivePrac.Code != http.StatusConflict {
		t.Fatalf("expected 409 Conflict deleting live practice session %s, got %d", pID, delLivePrac.Code)
	}
	decodeState(t, reqJSON(t, h, http.MethodPost, pLoc+":pause", map[string]any{}))
	decodeState(t, reqJSON(t, h, http.MethodDelete, pLoc, nil))
	if getDeletedPrac := reqJSON(t, h, http.MethodGet, pLoc, nil); getDeletedPrac.Code != http.StatusNotFound {
		t.Fatalf("expected 404 after DELETE %s, got %d", pLoc, getDeletedPrac.Code)
	}

	// Symmetric Race Session CRUD + :lifecycle custom methods
	rCreateRec := reqJSON(t, h, http.MethodPost, "/v1/race/sessions", map[string]any{
		"name": "Finals Shootout",
		"tags": []string{"Mains"},
	})
	decodeCreatedState(t, rCreateRec)
	rLoc := rCreateRec.Header().Get("Location")
	if !strings.HasPrefix(rLoc, "/v1/race/sessions/") {
		t.Fatalf("expected race session Location header, got %q", rLoc)
	}
	if dupRace := reqJSON(t, h, http.MethodPost, "/v1/race/sessions", map[string]any{"name": "Finals Shootout"}); dupRace.Code != http.StatusConflict {
		t.Fatalf("expected 409 Conflict on duplicate race session name, got %d", dupRace.Code)
	}
	if getRace := reqJSON(t, h, http.MethodGet, rLoc, nil); getRace.Code != http.StatusOK {
		t.Fatalf("expected 200 on GET %s, got %d", rLoc, getRace.Code)
	}
	decodeState(t, reqJSON(t, h, http.MethodPatch, rLoc, map[string]any{"name": "Finals Shootout Renamed"}))
	if unconfiguredStart := reqJSON(t, h, http.MethodPost, rLoc+":start", map[string]any{}); unconfiguredStart.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 starting unconfigured race session, got %d", unconfiguredStart.Code)
	}
	rCfg := domain.DefaultRaceSetupConfig()
	rCfg.EventName = "Finals Shootout Renamed"
	decodeState(t, reqJSON(t, h, http.MethodPut, rLoc+"/config", map[string]any{"config": rCfg, "generate": true}))
	decodeState(t, reqJSON(t, h, http.MethodPost, rLoc+":start", map[string]any{}))
	if delActiveRace := reqJSON(t, h, http.MethodDelete, rLoc, nil); delActiveRace.Code != http.StatusConflict {
		t.Fatalf("expected 409 Conflict deleting active race session, got %d", delActiveRace.Code)
	}
	decodeState(t, reqJSON(t, h, http.MethodPost, rLoc+":pause", map[string]any{"reason": "Break"}))
	decodeState(t, reqJSON(t, h, http.MethodDelete, rLoc, nil))
	if getDeletedRace := reqJSON(t, h, http.MethodGet, rLoc, nil); getDeletedRace.Code != http.StatusNotFound {
		t.Fatalf("expected 404 after DELETE %s, got %d", rLoc, getDeletedRace.Code)
	}
}
