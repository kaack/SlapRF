package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"slaprf/internal/ingest"
	"slaprf/internal/laprf"
	"slaprf/internal/tracker"
)

func TestTypeScriptBundleAndStateAPI(t *testing.T) {
	engine := tracker.NewEngine()
	sim := ingest.NewTrackSimulator(engine)
	laprfSrv := laprf.NewServer("127.0.0.1:0", engine)
	webRoot := filepath.Join("..", "..", "web")

	srv := NewServer(engine, sim, laprfSrv, webRoot)
	handler := srv.Handler()

	// 1. Verify TypeScript compilation via pure-Go esbuild
	reqTS := httptest.NewRequest(http.MethodGet, "/dist/app.js", nil)
	recTS := httptest.NewRecorder()
	handler.ServeHTTP(recTS, reqTS)

	if recTS.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from /dist/app.js, got %d: %s", recTS.Code, recTS.Body.String())
	}
	body := recTS.Body.String()
	for _, name := range []string{"AppShell", "LiveView", "AllPilotsPanel", "PilotPanel", "LapTimesCard", "PilotView", "LapPicker", "LapComparison", "PilotRssiChart", "PilotLaps", "SetupView", "TrackEditor", "TimersList", "TimerFlasher", "Announcer", "TimingRulesEditor"} {
		if !strings.Contains(body, name) {
			t.Fatalf("compiled TypeScript bundle missing %s", name)
		}
	}

	// 2. Verify /api/state JSON snapshot in simulation mode
	reqState := httptest.NewRequest(http.MethodGet, "/api/state", nil)
	recState := httptest.NewRecorder()
	handler.ServeHTTP(recState, reqState)

	if recState.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from /api/state, got %d", recState.Code)
	}
	var simState FullStateResponse
	if err := json.NewDecoder(recState.Body).Decode(&simState); err != nil {
		t.Fatalf("failed to decode sim state: %v", err)
	}
	if !simState.SimulatorRun || len(simState.Pucks) != 4 || len(simState.DetectedPucks) != 4 {
		t.Fatalf("expected 4 simulated gates and 4 simulated timers when sim is running, got pucks=%d detected=%d", len(simState.Pucks), len(simState.DetectedPucks))
	}

	// 3. Verify arm toggle flips engine state
	before := engine.IsRaceArmed()
	reqArm := httptest.NewRequest(http.MethodPost, "/api/timing/toggle-arm", nil)
	recArm := httptest.NewRecorder()
	handler.ServeHTTP(recArm, reqArm)
	if recArm.Code != http.StatusOK || engine.IsRaceArmed() == before {
		t.Fatalf("toggle-arm did not flip race armed state (code %d)", recArm.Code)
	}

	// 4. Verify toggling simulation off switches to the isolated real-world dataset
	reqToggleSim := httptest.NewRequest(http.MethodPost, "/api/sim/toggle", nil)
	recToggleSim := httptest.NewRecorder()
	handler.ServeHTTP(recToggleSim, reqToggleSim)
	if recToggleSim.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from /api/sim/toggle, got %d", recToggleSim.Code)
	}
	var realState FullStateResponse
	if err := json.NewDecoder(recToggleSim.Body).Decode(&realState); err != nil {
		t.Fatalf("failed to decode real state: %v", err)
	}
	if realState.SimulatorRun {
		t.Fatalf("expected SimulatorRun=false after toggle")
	}
	if len(realState.Pucks) != 0 || len(realState.DetectedPucks) != 0 || len(realState.Laps) != 0 {
		t.Fatalf("expected empty real-world timers/gates/laps, got pucks=%d detected=%d laps=%d", len(realState.Pucks), len(realState.DetectedPucks), len(realState.Laps))
	}
	if len(realState.Pilots) == 0 || realState.Pilots[0].Callsign != "Pilot 1" {
		t.Fatalf("expected real-world Pilot 1 callsign, got %+v", realState.Pilots)
	}
}
