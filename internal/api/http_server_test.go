package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"slaprf/internal/ingest"
	"slaprf/internal/laprf"
	"slaprf/internal/tracker"
)

func TestStateAPI(t *testing.T) {
	engine := tracker.NewEngine()
	sim := ingest.NewTrackSimulator(engine)
	laprfSrv := laprf.NewServer(engine)

	srv := NewServer(engine, sim, laprfSrv)
	handler := srv.Handler()

	// 1. Verify GET /v1/state JSON snapshot in simulation mode
	reqState := httptest.NewRequest(http.MethodGet, "/v1/state", nil)
	recState := httptest.NewRecorder()
	handler.ServeHTTP(recState, reqState)

	if recState.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from /v1/state, got %d", recState.Code)
	}
	var simState FullStateResponse
	if err := json.NewDecoder(recState.Body).Decode(&simState); err != nil {
		t.Fatalf("failed to decode sim state: %v", err)
	}
	if !simState.SimulatorRun || len(simState.Gates) != 4 || len(simState.Timers) != 5 {
		t.Fatalf("expected 4 simulated gates and 5 simulated timers (gate-less hub + 4 spokes) when sim is running, got gates=%d timers=%d", len(simState.Gates), len(simState.Timers))
	}

	// 2. Verify PUT /v1/timing/arm updates engine armed state idempotently
	before := engine.IsRaceArmed()
	armBody, _ := json.Marshal(map[string]bool{"armed": !before})
	reqArm := httptest.NewRequest(http.MethodPut, "/v1/timing/arm", bytes.NewReader(armBody))
	recArm := httptest.NewRecorder()
	handler.ServeHTTP(recArm, reqArm)
	if recArm.Code != http.StatusOK || engine.IsRaceArmed() == before {
		t.Fatalf("PUT /v1/timing/arm did not update race armed state (code %d)", recArm.Code)
	}

	// 3. Verify PATCH /v1/sim {"running": false} switches to the isolated real-world dataset
	reqSimOff := httptest.NewRequest(http.MethodPatch, "/v1/sim", bytes.NewBufferString(`{"running":false}`))
	recSimOff := httptest.NewRecorder()
	handler.ServeHTTP(recSimOff, reqSimOff)
	if recSimOff.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from PATCH /v1/sim, got %d", recSimOff.Code)
	}
	var realState FullStateResponse
	if err := json.NewDecoder(recSimOff.Body).Decode(&realState); err != nil {
		t.Fatalf("failed to decode real state: %v", err)
	}
	if realState.SimulatorRun {
		t.Fatalf("expected SimulatorRun=false after PATCH /v1/sim")
	}
	if len(realState.Gates) != 0 || len(realState.Timers) != 0 || len(realState.Laps) != 0 {
		t.Fatalf("expected empty real-world timers/gates/laps, got gates=%d timers=%d laps=%d", len(realState.Gates), len(realState.Timers), len(realState.Laps))
	}
	if len(realState.Pilots) == 0 || realState.Pilots[0].Callsign != "Pilot 1" {
		t.Fatalf("expected real-world Pilot 1 callsign, got %+v", realState.Pilots)
	}
}

func TestDeleteTimerRejectsActiveAndRestoresOnReconnect(t *testing.T) {
	engine := tracker.NewEngine()
	sim := ingest.NewTrackSimulator(engine)
	laprfSrv := laprf.NewServer(engine)
	srv := NewServer(engine, sim, laprfSrv)
	handler := srv.Handler()

	// 1. Active/connected timer cannot be deleted via DELETE /v1/timers/2 -> 409 Conflict
	reqDelOnline := httptest.NewRequest(http.MethodDelete, "/v1/timers/2", nil)
	recDelOnline := httptest.NewRecorder()
	handler.ServeHTTP(recDelOnline, reqDelOnline)
	if recDelOnline.Code != http.StatusConflict {
		t.Fatalf("expected 409 Conflict deleting active timer, got %d: %s", recDelOnline.Code, recDelOnline.Body.String())
	}

	// 2. Disconnect all timers (simulating unplugged Hub) -> DELETE /v1/timers/2 succeeds (garbage collection)
	engine.SetAllTimersOffline()
	reqDelOffline := httptest.NewRequest(http.MethodDelete, "/v1/timers/2", nil)
	recDelOffline := httptest.NewRecorder()
	handler.ServeHTTP(recDelOffline, reqDelOffline)
	if recDelOffline.Code != http.StatusOK {
		t.Fatalf("expected 200 OK dismissing offline timer, got %d: %s", recDelOffline.Code, recDelOffline.Body.String())
	}
	for _, tm := range engine.DetectedTimersSnapshot() {
		if tm.TimerID == 2 {
			t.Fatalf("expected timer 2 removed from detected timers while offline")
		}
	}

	// 3. Reconnecting the Hub (BuildHubHelloStream) re-detects timer 2 as an available unassigned timer!
	_ = sim.BuildHubHelloStream()
	foundRestored := false
	for _, tm := range engine.DetectedTimersSnapshot() {
		if tm.TimerID == 2 {
			foundRestored = true
			break
		}
	}
	if !foundRestored {
		t.Fatalf("expected timer 2 to reappear in detected timers once Hub reconnects")
	}
}

func TestPatchPracticeSessionCrossingEndpoint(t *testing.T) {
	engine := tracker.NewEngine()
	sim := ingest.NewTrackSimulator(engine)
	laprfSrv := laprf.NewServer(engine)
	srv := NewServer(engine, sim, laprfSrv)
	handler := srv.Handler()

	reqSeed := httptest.NewRequest(http.MethodPost, "/v1/storage:restoreDemo", bytes.NewReader([]byte(`{}`)))
	recSeed := httptest.NewRecorder()
	handler.ServeHTTP(recSeed, reqSeed)
	if recSeed.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from /v1/storage:restoreDemo, got %d: %s", recSeed.Code, recSeed.Body.String())
	}

	ps := engine.PracticeSnapshot()
	if len(ps.Sessions) == 0 {
		t.Fatalf("expected seeded practice sessions")
	}
	sess := ps.Sessions[len(ps.Sessions)-1]
	if len(sess.Crossings) == 0 {
		t.Fatalf("expected seeded crossings in practice session %q", sess.SessionID)
	}
	target := sess.Crossings[len(sess.Crossings)/2]
	nextTs := target.TimestampUs + 120_000

	body, _ := json.Marshal(map[string]any{
		"timestampUs": nextTs,
		"peakRssiDbm": -54.5,
	})
	req := httptest.NewRequest(
		http.MethodPatch,
		"/v1/practice/sessions/"+sess.SessionID+"/crossings/"+jsonNumber(target.EventID),
		bytes.NewReader(body),
	)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from PATCH crossing, got %d: %s", rec.Code, rec.Body.String())
	}
	var out FullStateResponse
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode FullStateResponse: %v", err)
	}
	var updatedSess *struct {
		Crossings []struct {
			EventID     uint64  `json:"eventId"`
			TimestampUs uint64  `json:"timestampUs"`
			PeakRSSIDbm float32 `json:"peakRssiDbm"`
		} `json:"crossings"`
	}
	rawSess, _ := json.Marshal(out.PracticeState.Sessions[len(out.PracticeState.Sessions)-1])
	_ = json.Unmarshal(rawSess, &updatedSess)
	var matched bool
	for _, c := range updatedSess.Crossings {
		if c.EventID == target.EventID {
			matched = true
			if c.TimestampUs != nextTs || c.PeakRSSIDbm != -54.5 {
				t.Fatalf("expected crossing %d updated to ts=%d peak=-54.5, got %+v", target.EventID, nextTs, c)
			}
		}
	}
	if !matched {
		t.Fatalf("crossing %d missing after PATCH", target.EventID)
	}
}

func jsonNumber(v uint64) string {
	b, _ := json.Marshal(v)
	return string(b)
}
