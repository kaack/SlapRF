package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"slaprf/internal/ingest"
	"slaprf/internal/laprf"
	"slaprf/internal/multigp"
	"slaprf/internal/tracker"
)

func TestMultiGPImportAndLapRFSimE2E(t *testing.T) {
	engine := tracker.NewEngine()
	sim := ingest.NewTrackSimulator(engine)
	sim.Start()
	defer sim.Stop()
	laprfSrv := laprf.NewServer(engine)
	srv := NewServer(engine, sim, laprfSrv)
	handler := srv.Handler()

	// 1. Switch to LapRF mode in simulation
	recMode := httptest.NewRecorder()
	handler.ServeHTTP(recMode, httptest.NewRequest(http.MethodPost, "/api/hardware/mode", bytes.NewBufferString(`{"mode":"laprf"}`)))
	if recMode.Code != http.StatusOK {
		t.Fatalf("hardware mode failed: %d %s", recMode.Code, recMode.Body.String())
	}

	// 2. Fetch race #501 from simulated MultiGP WebService
	recView := httptest.NewRecorder()
	handler.ServeHTTP(recView, httptest.NewRequest(http.MethodPost, "/api/sim/mgp/race/view?id=501", bytes.NewBufferString(`{"apiKey":"MGP-SIM-BAYAREA-2026"}`)))
	if recView.Code != http.StatusOK {
		t.Fatalf("sim mgp race/view failed: %d %s", recView.Code, recView.Body.String())
	}
	var viewEnv struct {
		Status bool                 `json:"status"`
		Data   multigp.RaceViewData `json:"data"`
	}
	if err := json.Unmarshal(recView.Body.Bytes(), &viewEnv); err != nil || !viewEnv.Status {
		t.Fatalf("failed to decode race/view: %v", err)
	}

	// 3. Import race #501 in zippyq, bracket, and finally schedule mode
	var lastCreatedRaceID string
	var lastHeatID string
	for _, mode := range []string{"zippyq", "bracket", "schedule"} {
		payload, _ := json.Marshal(map[string]any{
			"race":       viewEnv.Data,
			"importMode": mode,
			"templateId": "double_elimination",
		})
		recImp := httptest.NewRecorder()
		handler.ServeHTTP(recImp, httptest.NewRequest(http.MethodPost, "/api/mgp-sync/import", bytes.NewReader(payload)))
		if recImp.Code != http.StatusOK {
			t.Fatalf("import-race (%s) failed: %d %s", mode, recImp.Code, recImp.Body.String())
		}
		var impResp struct {
			CreatedRace struct {
				RaceID  string `json:"raceId"`
				MGPLink *struct {
					RaceID int `json:"raceId"`
				} `json:"mgpLink"`
				Heats []struct {
					ID string `json:"id"`
				} `json:"heats"`
			} `json:"createdRace"`
		}
		if err := json.Unmarshal(recImp.Body.Bytes(), &impResp); err != nil {
			t.Fatalf("failed to decode import response: %v", err)
		}
		if impResp.CreatedRace.MGPLink == nil || impResp.CreatedRace.MGPLink.RaceID != 501 {
			t.Fatalf("expected mgpLink.raceId=501 for mode=%s, got %+v", mode, impResp.CreatedRace.MGPLink)
		}
		lastCreatedRaceID = impResp.CreatedRace.RaceID
		if len(impResp.CreatedRace.Heats) > 0 {
			lastHeatID = impResp.CreatedRace.Heats[0].ID
		}
	}

	// 4. Start heat, stop & confirm heat, then build sync plan & push to simulated MultiGP
	for _, act := range []string{"start", "stop", "confirm"} {
		ctrlPayload, _ := json.Marshal(map[string]any{
			"action": act,
			"heatId": lastHeatID,
			"raceId": lastCreatedRaceID,
		})
		recCtrl := httptest.NewRecorder()
		handler.ServeHTTP(recCtrl, httptest.NewRequest(http.MethodPost, "/api/race/control", bytes.NewReader(ctrlPayload)))
		if recCtrl.Code != http.StatusOK {
			t.Fatalf("race control %s failed: %d %s", act, recCtrl.Code, recCtrl.Body.String())
		}
		if act == "start" {
			time.Sleep(80 * time.Millisecond)
		}
	}

	planPayload, _ := json.Marshal(map[string]any{
		"raceId":   lastCreatedRaceID,
		"forceAll": true,
	})
	recPlan := httptest.NewRecorder()
	handler.ServeHTTP(recPlan, httptest.NewRequest(http.MethodPost, "/api/mgp-sync/plan", bytes.NewReader(planPayload)))
	if recPlan.Code != http.StatusOK {
		t.Fatalf("mgp-sync/plan failed: %d %s", recPlan.Code, recPlan.Body.String())
	}
	var plan tracker.MultiGPSyncPlan
	if err := json.Unmarshal(recPlan.Body.Bytes(), &plan); err != nil {
		t.Fatalf("failed to decode sync plan: %v", err)
	}
	if len(plan.Operations) == 0 {
		t.Fatalf("expected non-empty sync plan operations after confirming heat %s", lastHeatID)
	}

	for _, op := range plan.Operations {
		assignBody, _ := json.Marshal(map[string]any{
			"apiKey": "MGP-SIM-BAYAREA-2026",
			"data":   op.Data,
		})
		recAssign := httptest.NewRecorder()
		url := fmt.Sprintf("/api/sim/mgp/race/assignSlot?id=%d&cycle=%d&heat=%d&slot=%d", plan.MGPRaceID, op.Cycle, op.Heat, op.Slot)
		handler.ServeHTTP(recAssign, httptest.NewRequest(http.MethodPost, url, bytes.NewReader(assignBody)))
		if recAssign.Code != http.StatusOK {
			t.Fatalf("assignSlot failed: %d %s", recAssign.Code, recAssign.Body.String())
		}
	}

	markBody, _ := json.Marshal(map[string]any{
		"raceId":        lastCreatedRaceID,
		"syncedHeatIds": []string{lastHeatID},
		"overallSynced": false,
	})
	recMark := httptest.NewRecorder()
	handler.ServeHTTP(recMark, httptest.NewRequest(http.MethodPost, "/api/mgp-sync/mark-synced", bytes.NewReader(markBody)))
	if recMark.Code != http.StatusOK {
		t.Fatalf("mark-synced failed: %d %s", recMark.Code, recMark.Body.String())
	}
}
