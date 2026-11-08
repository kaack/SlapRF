package api

import (
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

	// 2. Verify /api/state JSON snapshot
	reqState := httptest.NewRequest(http.MethodGet, "/api/state", nil)
	recState := httptest.NewRecorder()
	handler.ServeHTTP(recState, reqState)

	if recState.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from /api/state, got %d", recState.Code)
	}

	// 3. Verify arm toggle flips engine state
	before := engine.IsRaceArmed()
	reqArm := httptest.NewRequest(http.MethodPost, "/api/timing/toggle-arm", nil)
	recArm := httptest.NewRecorder()
	handler.ServeHTTP(recArm, reqArm)
	if recArm.Code != http.StatusOK || engine.IsRaceArmed() == before {
		t.Fatalf("toggle-arm did not flip race armed state (code %d)", recArm.Code)
	}
}
