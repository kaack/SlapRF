package api_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"slaprf/internal/api"
	"slaprf/internal/domain"
	"slaprf/internal/ingest"
	"slaprf/internal/laprf"
	"slaprf/internal/tracker"
)

func reqJSON(t *testing.T, h http.Handler, method string, path string, body interface{}) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal %s %s: %v", method, path, err)
		}
		buf.Write(raw)
	}
	req := httptest.NewRequest(method, path, &buf)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeStateStatus(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int) api.FullStateResponse {
	t.Helper()
	if rec.Code != wantStatus {
		t.Fatalf("expected %d, got %d: %s", wantStatus, rec.Code, rec.Body.String())
	}
	var st api.FullStateResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatalf("unmarshal state: %v", err)
	}
	return st
}

func decodeState(t *testing.T, rec *httptest.ResponseRecorder) api.FullStateResponse {
	t.Helper()
	return decodeStateStatus(t, rec, http.StatusOK)
}

func decodeCreatedState(t *testing.T, rec *httptest.ResponseRecorder) api.FullStateResponse {
	t.Helper()
	return decodeStateStatus(t, rec, http.StatusCreated)
}

func TestRaceModeIsolationAndLifecycle(t *testing.T) {
	simEng := tracker.NewEngine()
	realEng := tracker.NewRealEngine()
	sim := ingest.NewTrackSimulator(simEng)
	sim.SetRunning(false)
	lrf := laprf.NewServer(simEng)
	srv := api.NewServer(simEng, sim, lrf, realEng)
	h := srv.Handler()

	// Real engine is active because simulator is not running.
	// 1. Customize Practice pilot #1 channel to R7 and add a 9th pilot.
	pilots, _, _, _, _ := realEng.StateSnapshot()
	p1 := pilots[0]
	p1.Enabled = true
	p1.Channel = 7
	p1.FrequencyMHz = domain.RacebandFrequenciesMHz[6]
	st := decodeState(t, reqJSON(t, h, http.MethodPut, fmt.Sprintf("/v1/pilots/%d", p1.SlotIndex), p1))
	if st.Pilots[0].Channel != 7 {
		t.Fatalf("expected Practice pilot 1 on R7, got R%d", st.Pilots[0].Channel)
	}

	st = decodeCreatedState(t, reqJSON(t, h, http.MethodPost, "/v1/pilots", map[string]string{
		"callsign":     "Mondo",
		"phoneticName": "Mahn-doh",
	}))
	if len(st.Pilots) != 9 {
		t.Fatalf("expected 9 pilots after add, got %d", len(st.Pilots))
	}

	// 2. Switch to Race Mode: pilots should all be unarmed until a heat stages, and Practice snapshot saved.
	st = decodeState(t, reqJSON(t, h, http.MethodPut, "/v1/timing/mode", map[string]string{"mode": "race"}))
	if st.RaceState.Mode != domain.ModeRace {
		t.Fatalf("expected mode=race, got %s", st.RaceState.Mode)
	}

	// 3. Configure & generate an 8-pilot Double Elimination + Chase the Ace tournament (remove 9th pilot first).
	st = decodeState(t, reqJSON(t, h, http.MethodDelete, "/v1/pilots/9", nil))
	if len(st.Pilots) != 8 {
		t.Fatalf("expected 8 pilots after remove, got %d", len(st.Pilots))
	}

	cfg := domain.DefaultRaceSetupConfig()
	cfg.EventName = "Baylands Shootout"
	cfg.Structure = domain.StructureSingleStage
	cfg.MainFormat = domain.FormatDoubleElimination
	cfg.FinalsFormat = domain.FinalsChaseTheAce
	cfg.PilotsPerHeat = 4
	cfg.TargetLaps = 2
	cfg.CountdownSec = 0
	st = decodeState(t, reqJSON(t, h, http.MethodPut, "/v1/race/sessions/current/config", map[string]interface{}{
		"config":   cfg,
		"generate": true,
	}))
	if !st.RaceState.Generated || len(st.RaceState.Heats) < 4 {
		t.Fatalf("expected generated Double Elim heats, got generated=%v count=%d", st.RaceState.Generated, len(st.RaceState.Heats))
	}
	if st.RaceState.ActiveHeatID != "W1-1" {
		t.Fatalf("expected active heat W1-1, got %q", st.RaceState.ActiveHeatID)
	}
	raceID := st.RaceState.RaceID

	// 4. Start W1-1, score manual laps, toggle DNF on one pilot, finish, confirm, unlock, re-confirm.
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/W1-1:control", raceID), map[string]string{"action": "start"}))
	w1 := st.RaceState.Heats[0]
	if w1.State != domain.HeatRunning {
		t.Fatalf("expected W1-1 running, got %s", w1.State)
	}
	seat1Pilot := w1.Seats[0].PilotSlotIndex
	seat2Pilot := w1.Seats[1].PilotSlotIndex
	seat3Pilot := w1.Seats[2].PilotSlotIndex

	for pass := 0; pass < 3; pass++ {
		st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/W1-1/pilots/%d:marshal", raceID, seat1Pilot), tracker.RaceMarshalPayload{
			Action: "add_lap",
		}))
	}
	for pass := 0; pass < 3; pass++ {
		st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/W1-1/pilots/%d:marshal", raceID, seat2Pilot), tracker.RaceMarshalPayload{
			Action: "add_lap",
		}))
	}
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/W1-1/pilots/%d:marshal", raceID, seat3Pilot), tracker.RaceMarshalPayload{
		Action: "toggle_dnf",
	}))

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/W1-1:control", raceID), map[string]string{"action": "pause"}))
	if st.RaceState.Heats[0].State != domain.HeatPaused {
		t.Fatalf("expected paused, got %s", st.RaceState.Heats[0].State)
	}
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/W1-1:control", raceID), map[string]string{"action": "resume"}))
	if st.RaceState.Heats[0].State != domain.HeatRunning {
		t.Fatalf("expected running after resume, got %s", st.RaceState.Heats[0].State)
	}
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/W1-1:control", raceID), map[string]string{"action": "stop"}))
	if st.RaceState.Heats[0].State != domain.HeatFinished {
		t.Fatalf("expected finished (awaiting confirmation), got %s", st.RaceState.Heats[0].State)
	}

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/W1-1/pilots/%d:marshal", raceID, seat2Pilot), tracker.RaceMarshalPayload{
		Action: "move_up",
	}))
	for _, s := range st.RaceState.Heats[0].Seats {
		if s.PilotSlotIndex == seat2Pilot && s.Position != 1 {
			t.Fatalf("expected seat2Pilot moved up to 1st, got pos %d", s.Position)
		}
	}

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/W1-1:control", raceID), map[string]string{"action": "confirm"}))
	if st.RaceState.Heats[0].State != domain.HeatConfirmed {
		t.Fatalf("expected W1-1 confirmed, got %s", st.RaceState.Heats[0].State)
	}
	if !st.RaceState.Heats[0].CanUnlock {
		t.Fatalf("expected W1-1 CanUnlock=true before downstream heats start")
	}
	if st.RaceState.ActiveHeatID != "W1-2" {
		t.Fatalf("expected auto-staged next heat W1-2, got %q", st.RaceState.ActiveHeatID)
	}

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/W1-1:control", raceID), map[string]string{"action": "unlock"}))
	if st.RaceState.Heats[0].State != domain.HeatFinished {
		t.Fatalf("expected W1-1 unlocked back to finished, got %s", st.RaceState.Heats[0].State)
	}

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/W1-1/pilots/%d:marshal", raceID, seat3Pilot), tracker.RaceMarshalPayload{
		Action:             "reorder_seats",
		OrderedSlotIndices: []int{seat3Pilot, seat1Pilot, seat2Pilot},
	}))
	for _, s := range st.RaceState.Heats[0].Seats {
		switch s.PilotSlotIndex {
		case seat3Pilot:
			if s.Position != 1 {
				t.Fatalf("expected seat3Pilot reordered to 1st, got pos %d", s.Position)
			}
		case seat1Pilot:
			if s.Position != 2 {
				t.Fatalf("expected seat1Pilot reordered to 2nd, got pos %d", s.Position)
			}
		case seat2Pilot:
			if s.Position != 3 {
				t.Fatalf("expected seat2Pilot reordered to 3rd, got pos %d", s.Position)
			}
		}
	}

	// 5. Switch back to Practice Mode -> pilot 1's Practice channel R7 must be 100% preserved!
	st = decodeState(t, reqJSON(t, h, http.MethodPut, "/v1/timing/mode", map[string]string{"mode": "practice"}))
	if st.RaceState.Mode != domain.ModePractice {
		t.Fatalf("expected mode=practice, got %s", st.RaceState.Mode)
	}
	if st.Pilots[0].Channel != 7 || !st.Pilots[0].Enabled {
		t.Fatalf("expected Practice pilot 1 restored to enabled on R7, got enabled=%v ch=R%d", st.Pilots[0].Enabled, st.Pilots[0].Channel)
	}
}

func TestRaceTagsLifecycleAttendanceAndBracketSurgery(t *testing.T) {
	simEng := tracker.NewEngine()
	realEng := tracker.NewRealEngine()
	sim := ingest.NewTrackSimulator(simEng)
	sim.SetRunning(false)
	lrf := laprf.NewServer(simEng)
	srv := api.NewServer(simEng, sim, lrf, realEng)
	h := srv.Handler()

	st := decodeState(t, reqJSON(t, h, http.MethodPut, "/v1/timing/mode", map[string]string{"mode": "race"}))
	if len(st.EventState.Races) != 0 {
		t.Fatalf("expected clean initial state with 0 races, got races=%d", len(st.EventState.Races))
	}

	// 1. Create Race 1 with tags via POST /v1/race/sessions (201 Created)
	st = decodeCreatedState(t, reqJSON(t, h, http.MethodPost, "/v1/race/sessions", map[string]any{
		"name": "Race 1 Open Class",
		"tags": []string{"#Summer Nationals", "  Open  Class ", "summer nationals"},
	}))
	race1ID := st.RaceState.RaceID
	if race1ID == "" || st.RaceState.Generated || len(st.RaceState.Heats) != 0 {
		t.Fatalf("expected empty Race 1, got id=%q generated=%v heats=%d",
			race1ID, st.RaceState.Generated, len(st.RaceState.Heats))
	}
	if len(st.RaceState.Tags) != 2 || st.RaceState.Tags[0] != "Summer Nationals" || st.RaceState.Tags[1] != "Open Class" {
		t.Fatalf("expected normalized deduplicated tags [Summer Nationals, Open Class], got %+v", st.RaceState.Tags)
	}
	if len(st.RaceState.Roster) != 8 {
		t.Fatalf("expected per-race roster initialized with 8 pilots, got %d", len(st.RaceState.Roster))
	}

	cfg := st.RaceState.Config
	cfg.CountdownSec = 0
	st = decodeState(t, reqJSON(t, h, http.MethodPut, fmt.Sprintf("/v1/race/sessions/%s/config", race1ID), map[string]interface{}{
		"config":   cfg,
		"generate": true,
	}))
	if !st.RaceState.Generated || len(st.RaceState.Heats) == 0 {
		t.Fatalf("expected generated heats for Race 1")
	}

	// Create Race 2
	st = decodeCreatedState(t, reqJSON(t, h, http.MethodPost, "/v1/race/sessions", map[string]any{
		"name":       "Race 2 Spec Class",
		"tags":       []string{"Summer Nationals", "Spec"},
		"copyConfig": true,
	}))
	race2ID := st.RaceState.RaceID
	if race2ID == race1ID || st.RaceState.Config.EventName != "Race 2 Spec Class" || st.RaceState.Generated {
		t.Fatalf("expected empty distinct Race 2 selected, got id=%q name=%q generated=%v", race2ID, st.RaceState.Config.EventName, st.RaceState.Generated)
	}

	// Update tags on non-active Race 1 via PATCH /v1/race/sessions/{race1ID} while Race 2 is active
	st = decodeState(t, reqJSON(t, h, http.MethodPatch, fmt.Sprintf("/v1/race/sessions/%s", race1ID), map[string]any{
		"tags": []string{"Summer Nationals", "5-inch", "#Finals"},
	}))

	// 2. Switch back to Race 1, verify updated tags, and uncheck Pilot 8 in Race 1's per-race roster
	st = decodeState(t, reqJSON(t, h, http.MethodPatch, fmt.Sprintf("/v1/race/sessions/%s", race1ID), map[string]any{
		"selected": true,
	}))
	if len(st.RaceState.Tags) != 3 || st.RaceState.Tags[2] != "Finals" {
		t.Fatalf("expected updated tags on Race 1, got %+v", st.RaceState.Tags)
	}
	fVal := false
	st = decodeState(t, reqJSON(t, h, http.MethodPatch, fmt.Sprintf("/v1/race/sessions/%s/pilots/8", race1ID), map[string]any{
		"checkedIn": fVal,
	}))
	for _, r := range st.EventState.Races {
		if r.RaceID == race2ID {
			for _, ep := range r.Roster {
				if ep.SlotIndex == 8 && !ep.CheckedIn {
					t.Fatalf("expected per-race attendance isolated: Pilot 8 should remain checked in on Race 2")
				}
			}
		}
	}

	// 3. Test drag-and-drop swap (`move_or_swap_seat`) between W1-1 Seat 1 and W1-2 Seat 1 before starting!
	pA := st.RaceState.Heats[0].Seats[0].PilotSlotIndex
	pB := st.RaceState.Heats[1].Seats[0].PilotSlotIndex
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", race1ID), tracker.BracketEditPayload{
		Action:        "move_or_swap_seat",
		FromHeatID:    "W1-1",
		FromSeatIndex: 1,
		ToHeatID:      "W1-2",
		ToSeatIndex:   1,
	}))
	if st.RaceState.Heats[0].Seats[0].PilotSlotIndex != pB || st.RaceState.Heats[1].Seats[0].PilotSlotIndex != pA {
		t.Fatalf("expected swapped pilots in W1-1/W1-2 seat 1, got %d and %d", st.RaceState.Heats[0].Seats[0].PilotSlotIndex, st.RaceState.Heats[1].Seats[0].PilotSlotIndex)
	}

	// 4. Start W1-1 -> Lifecycle transitions `draft` -> `active`. Then Pause whole Race ("Rain delay")!
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/W1-1:control", race1ID), map[string]string{"action": "start"}))
	if st.RaceState.Lifecycle != domain.LifecycleActive {
		t.Fatalf("expected active lifecycle after heat start, got %s", st.RaceState.Lifecycle)
	}
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s:pause", race1ID), map[string]any{
		"reason": "Rain delay",
	}))
	if st.RaceState.Lifecycle != domain.LifecyclePaused || st.RaceState.StatusReason != "Rain delay" {
		t.Fatalf("expected paused race with Rain delay, got %s (%q)", st.RaceState.Lifecycle, st.RaceState.StatusReason)
	}
	if st.RaceState.Heats[0].State != domain.HeatPaused {
		t.Fatalf("expected running W1-1 paused when race suspended, got %s", st.RaceState.Heats[0].State)
	}

	// Start an active Practice session while the Race is paused:
	// attempting to resume W1-1 without preemptOngoing must return 409 Conflict!
	st = decodeCreatedState(t, reqJSON(t, h, http.MethodPost, "/v1/practice/sessions", map[string]any{
		"name": "Rain Break Practice",
	}))
	sessID := st.PracticeState.SelectedSessionID
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/practice/sessions/%s:start", sessID), map[string]any{}))
	if st.PracticeState.ActiveSessionID == "" {
		t.Fatalf("expected active practice session while race is paused")
	}
	badRec := reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/W1-1:control", race1ID), map[string]string{"action": "resume"})
	if badRec.Code != http.StatusConflict {
		t.Fatalf("expected 409 Conflict when resuming heat while race is paused and practice is active without preemptOngoing, got %d", badRec.Code)
	}

	// Resuming with preemptOngoing: true automatically pauses Practice and switches the Race back to Active!
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/W1-1:control", race1ID), map[string]any{
		"action":         "resume",
		"preemptOngoing": true,
	}))
	if st.RaceState.Lifecycle != domain.LifecycleActive {
		t.Fatalf("expected active lifecycle after resume with preemptOngoing, got %s", st.RaceState.Lifecycle)
	}
	if st.PracticeState.ActiveSessionID != "" {
		t.Fatalf("expected practice session paused after race preemption, got active=%s", st.PracticeState.ActiveSessionID)
	}
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/W1-1:control", race1ID), map[string]string{"action": "stop"}))
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/W1-1:control", race1ID), map[string]string{"action": "confirm"}))

	// 5. Mark a pilot in unstarted W1-2 as `away` -> seat becomes `dns`!
	awayPilot := st.RaceState.Heats[1].Seats[0].PilotSlotIndex
	st = decodeState(t, reqJSON(t, h, http.MethodPatch, fmt.Sprintf("/v1/race/sessions/%s/pilots/%d", race1ID, awayPilot), map[string]any{
		"attendance": domain.AttendanceAway,
	}))
	if st.RaceState.Heats[1].Seats[0].Status != domain.PilotHeatDNS {
		t.Fatalf("expected away pilot in W1-2 marked DNS, got %s", st.RaceState.Heats[1].Seats[0].Status)
	}

	// 6. Add walk-up late pilot mid-race (`POST /v1/race/sessions/{id}/pilots`) and `auto_seat_pilot`!
	st = decodeCreatedState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/pilots", race1ID), map[string]any{
		"callsign":     "LateRipper",
		"phoneticName": "Layt Ripper",
	}))
	lateSlot := st.Pilots[len(st.Pilots)-1].SlotIndex
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", race1ID), tracker.BracketEditPayload{
		Action:         "auto_seat_pilot",
		PilotSlotIndex: lateSlot,
	}))
	foundLate := false
	for _, ht := range st.RaceState.Heats {
		for _, s := range ht.Seats {
			if s.PilotSlotIndex == lateSlot {
				foundLate = true
			}
		}
	}
	if !foundLate {
		t.Fatalf("expected LateRipper auto-seated into an unstarted heat")
	}

	// 7. Persistence round-trip (`ExportState` -> `RestoreState`) preserves all top-level Races, Tags, and Per-Race Attendance!
	exported := realEng.ExportState()
	freshEng := tracker.NewRealEngine()
	freshEng.RestoreState(exported, false)
	evSnap := freshEng.EventSnapshot()
	if len(evSnap.Races) != 2 {
		t.Fatalf("expected 2 top-level Races restored, got races=%d", len(evSnap.Races))
	}
	if len(evSnap.Races[0].Tags) != 3 || evSnap.Races[0].Tags[1] != "5-inch" {
		t.Fatalf("expected Race 1 tags preserved across RestoreState, got %+v", evSnap.Races[0].Tags)
	}
}

func TestDeleteRacesOngoingGuard(t *testing.T) {
	simEng := tracker.NewEngine()
	realEng := tracker.NewRealEngine()
	sim := ingest.NewTrackSimulator(simEng)
	sim.SetRunning(false)
	lrf := laprf.NewServer(simEng)
	srv := api.NewServer(simEng, sim, lrf, realEng)
	h := srv.Handler()

	st := decodeState(t, reqJSON(t, h, http.MethodPut, "/v1/timing/mode", map[string]string{"mode": "race"}))

	st = decodeCreatedState(t, reqJSON(t, h, http.MethodPost, "/v1/race/sessions", map[string]any{
		"name": "Ad-Hoc Pickup Race",
	}))
	adHocID := st.RaceState.RaceID
	if len(st.RaceState.Tags) != 0 {
		t.Fatalf("expected untagged pickup race, got %+v", st.RaceState.Tags)
	}

	st = decodeCreatedState(t, reqJSON(t, h, http.MethodPost, "/v1/race/sessions", map[string]any{
		"name": "Friday Night Main",
		"tags": []string{"Friday Night", "Whoops"},
	}))
	raceID := st.RaceState.RaceID

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{
		Action:     "apply_template",
		TemplateID: "double_elimination",
	}))
	cfg := st.RaceState.Config
	cfg.CountdownSec = 0
	st = decodeState(t, reqJSON(t, h, http.MethodPut, fmt.Sprintf("/v1/race/sessions/%s/config", raceID), map[string]interface{}{
		"config":   cfg,
		"generate": false,
	}))
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/W1-1:control", raceID), map[string]string{"action": "start"}))
	if st.RaceState.Lifecycle != domain.LifecycleActive {
		t.Fatalf("expected active race, got %s", st.RaceState.Lifecycle)
	}

	// 1. Deleting an active / ongoing race MUST fail with 409 Conflict.
	rec := reqJSON(t, h, http.MethodDelete, fmt.Sprintf("/v1/race/sessions/%s", raceID), nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 Conflict when deleting active race, got %d: %s", rec.Code, rec.Body.String())
	}

	// 2. Pause the race -> deleting the race MUST succeed!
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s:pause", raceID), map[string]any{
		"reason": "Done testing",
	}))
	st = decodeState(t, reqJSON(t, h, http.MethodDelete, fmt.Sprintf("/v1/race/sessions/%s", raceID), nil))
	if len(st.EventState.Races) != 1 || st.EventState.Races[0].RaceID != adHocID {
		t.Fatalf("expected only ad-hoc race remaining, got %+v", st.EventState.Races)
	}

	// 3. Delete the remaining race -> 0 races, and survives RestoreState without resurrecting!
	st = decodeState(t, reqJSON(t, h, http.MethodDelete, fmt.Sprintf("/v1/race/sessions/%s", adHocID), nil))
	if len(st.EventState.Races) != 0 || st.RaceState.RaceID != "" {
		t.Fatalf("expected 0 races after deleting last race")
	}
	expEmpty := realEng.ExportState()
	reloadedEmpty := tracker.NewRealEngine()
	reloadedEmpty.RestoreState(expEmpty, false)
	evSnapEmpty := reloadedEmpty.EventSnapshot()
	if len(evSnapEmpty.Races) != 0 {
		t.Fatalf("expected 0 races preserved across RestoreState, got races=%d", len(evSnapEmpty.Races))
	}
}

func TestCustomRoundBuilderLinkingAndRegenerateUpcoming(t *testing.T) {
	simEng := tracker.NewEngine()
	realEng := tracker.NewRealEngine()
	sim := ingest.NewTrackSimulator(simEng)
	sim.SetRunning(false)
	lrf := laprf.NewServer(simEng)
	srv := api.NewServer(simEng, sim, lrf, realEng)
	h := srv.Handler()

	st := decodeState(t, reqJSON(t, h, http.MethodPut, "/v1/timing/mode", map[string]string{"mode": "race"}))

	st = decodeCreatedState(t, reqJSON(t, h, http.MethodPost, "/v1/race/sessions", map[string]any{
		"name": "Saturday Shootout (Custom)",
	}))
	raceID := st.RaceState.RaceID
	if st.RaceState.Generated || len(st.RaceState.Heats) != 0 {
		t.Fatalf("expected brand-new race to start empty, got generated=%v heats=%d", st.RaceState.Generated, len(st.RaceState.Heats))
	}

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{
		Action:   "start_custom",
		LinkMode: "none",
	}))
	if !st.RaceState.Generated || st.RaceState.TemplateID != "custom" || len(st.RaceState.Heats) != 0 {
		t.Fatalf("expected custom empty builder, got generated=%v template=%q heats=%d", st.RaceState.Generated, st.RaceState.TemplateID, len(st.RaceState.Heats))
	}

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{
		Action:       "add_round",
		Title:        "Opening Round",
		BracketLane:  "winners",
		LinkMode:     "all_active_pilots",
		TargetLaps:   3,
		TimeLimitSec: 120,
	}))
	if len(st.RaceState.Rounds) != 1 || len(st.RaceState.Heats) != 2 {
		t.Fatalf("expected 1 round and 2 heats of 4 pilots, got rounds=%d heats=%d", len(st.RaceState.Rounds), len(st.RaceState.Heats))
	}
	r1Heat1 := st.RaceState.Heats[0].ID
	r1Heat2 := st.RaceState.Heats[1].ID

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{
		Action:       "add_round",
		Title:        "Top 4 Final",
		BracketLane:  "finals",
		LinkMode:     "top_per_heat",
		SourceColumn: 1,
		AdvanceCount: 2,
	}))
	if len(st.RaceState.Rounds) != 2 || len(st.RaceState.Heats) != 3 {
		t.Fatalf("expected 2 rounds and 3 total heats, got rounds=%d heats=%d", len(st.RaceState.Rounds), len(st.RaceState.Heats))
	}
	finalHeat := st.RaceState.Heats[2]
	if finalHeat.Seats[0].Feeder == nil || finalHeat.Seats[0].Feeder.FromHeatID != r1Heat1 || finalHeat.Seats[0].Feeder.FromRank != 1 {
		t.Fatalf("expected Final Seat 1 fed by 1st of %s, got %+v", r1Heat1, finalHeat.Seats[0].Feeder)
	}

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{
		Action:       "add_round",
		Title:        "Redemption Final",
		BracketLane:  "losers",
		LinkMode:     "bottom_per_heat",
		SourceColumn: 1,
		AdvanceCount: 2,
	}))
	if len(st.RaceState.Rounds) != 3 || len(st.RaceState.Heats) != 4 {
		t.Fatalf("expected 3 rounds and 4 total heats, got rounds=%d heats=%d", len(st.RaceState.Rounds), len(st.RaceState.Heats))
	}
	var redempRoundID string
	for _, rd := range st.RaceState.Rounds {
		if rd.Title == "Redemption Final" {
			redempRoundID = rd.ID
			break
		}
	}
	if redempRoundID == "" {
		t.Fatalf("expected Redemption Final round to exist, got %+v", st.RaceState.Rounds)
	}

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{
		Action:  "delete_round",
		RoundID: redempRoundID,
	}))
	if len(st.RaceState.Rounds) != 2 || len(st.RaceState.Heats) != 3 {
		t.Fatalf("expected 2 rounds and 3 heats after delete_round, got rounds=%d heats=%d", len(st.RaceState.Rounds), len(st.RaceState.Heats))
	}

	cfg := st.RaceState.Config
	cfg.CountdownSec = 0
	st = decodeState(t, reqJSON(t, h, http.MethodPut, fmt.Sprintf("/v1/race/sessions/%s/config", raceID), map[string]interface{}{
		"config":   cfg,
		"generate": false,
	}))
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/%s:control", raceID, r1Heat1), map[string]string{"action": "start"}))
	w1Winner := st.RaceState.Heats[0].Seats[0].PilotSlotIndex
	for pass := 0; pass < 2; pass++ {
		st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/%s/pilots/%d:marshal", raceID, r1Heat1, w1Winner), tracker.RaceMarshalPayload{
			Action: "add_lap",
		}))
	}
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/%s:control", raceID, r1Heat1), map[string]string{"action": "stop"}))
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/%s:control", raceID, r1Heat1), map[string]string{"action": "confirm"}))

	if st.RaceState.Heats[2].Seats[0].PilotSlotIndex != w1Winner {
		t.Fatalf("expected R1-1 winner (slot %d) propagated into Final Seat 1, got slot %d", w1Winner, st.RaceState.Heats[2].Seats[0].PilotSlotIndex)
	}

	// Deleting Round 1 after r1Heat1 is confirmed MUST fail with 409 Conflict!
	badDel := reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{
		Action:  "delete_round",
		Column:  1,
		RoundID: st.RaceState.Rounds[0].ID,
	})
	if badDel.Code != http.StatusConflict {
		t.Fatalf("expected 409 Conflict when deleting started round, got %d: %s", badDel.Code, badDel.Body.String())
	}

	st = decodeCreatedState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/pilots", raceID), map[string]any{
		"callsign": "WalkUpAce",
	}))
	walkUpSlot := st.Pilots[len(st.Pilots)-1].SlotIndex
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{
		Action: "regenerate_upcoming",
	}))
	if st.RaceState.Heats[0].State != domain.HeatConfirmed {
		t.Fatalf("expected confirmed %s untouched by regenerate_upcoming, got %s", r1Heat1, st.RaceState.Heats[0].State)
	}
	_ = r1Heat2
	seatedWalkUp := false
	for _, ht := range st.RaceState.Heats {
		for _, s := range ht.Seats {
			if s.PilotSlotIndex == walkUpSlot {
				seatedWalkUp = true
			}
		}
	}
	if !seatedWalkUp {
		t.Fatalf("expected WalkUpAce seated into upcoming unstarted Round 1 heat by regenerate_upcoming")
	}
}

func TestVisualRoundGraphConnectMultiInputAndDisconnect(t *testing.T) {
	simEng := tracker.NewEngine()
	realEng := tracker.NewRealEngine()
	sim := ingest.NewTrackSimulator(simEng)
	sim.SetRunning(false)
	lrf := laprf.NewServer(simEng)
	srv := api.NewServer(simEng, sim, lrf, realEng)
	h := srv.Handler()

	decodeState(t, reqJSON(t, h, http.MethodPut, "/v1/timing/mode", map[string]string{"mode": "race"}))
	st := decodeCreatedState(t, reqJSON(t, h, http.MethodPost, "/v1/race/sessions", map[string]any{
		"name": "Node Graph Race",
	}))
	raceID := st.RaceState.RaceID

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{
		Action: "start_custom",
	}))
	if len(st.RaceState.Rounds) != 1 || len(st.RaceState.Heats) != 2 {
		t.Fatalf("expected Round 1 with 2 heats, got rounds=%d heats=%d", len(st.RaceState.Rounds), len(st.RaceState.Heats))
	}
	r1ID := st.RaceState.Rounds[0].ID

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{Action: "add_round"}))
	r2ID := st.RaceState.Rounds[1].ID
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{Action: "add_round"}))
	r3ID := st.RaceState.Rounds[2].ID
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{Action: "add_round"}))
	r4ID := st.RaceState.Rounds[3].ID

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: r1ID,
		ToRoundID:   r2ID,
	}))
	if len(st.RaceState.Connections) != 1 || st.RaceState.Connections[0].Mode != "top_per_heat" || st.RaceState.Connections[0].Count != 2 {
		t.Fatalf("expected 1st wire to auto-pick top_per_heat(2), got %+v", st.RaceState.Connections)
	}

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: r1ID,
		ToRoundID:   r3ID,
	}))
	if len(st.RaceState.Connections) != 2 || st.RaceState.Connections[1].Mode != "bottom_per_heat" {
		t.Fatalf("expected 2nd wire from Round 1 to auto-pick bottom_per_heat, got %+v", st.RaceState.Connections)
	}
	var r2Col, r3Col int
	for _, rd := range st.RaceState.Rounds {
		if rd.ID == r2ID {
			r2Col = rd.Column
		}
		if rd.ID == r3ID {
			r3Col = rd.Column
		}
	}
	if r2Col != 2 || r3Col != 1 {
		t.Fatalf("expected Round 2 at Column 2 and Redemption Round 3 aligned under Round 1 at Column 1, got r2Col=%d r3Col=%d", r2Col, r3Col)
	}

	decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: r2ID,
		ToRoundID:   r4ID,
	}))
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: r3ID,
		ToRoundID:   r4ID,
	}))
	if len(st.RaceState.Connections) != 4 {
		t.Fatalf("expected 4 total connections, got %d", len(st.RaceState.Connections))
	}

	var r4Heats []domain.RaceHeat
	for _, ht := range st.RaceState.Heats {
		if ht.RoundID == r4ID {
			r4Heats = append(r4Heats, ht)
		}
	}
	if len(r4Heats) != 1 || r4Heats[0].Column != 3 {
		t.Fatalf("expected Round 4 to have 1 merged Grand Final heat at Column 3, got %+v", r4Heats)
	}
	for si, s := range r4Heats[0].Seats {
		if s.Feeder == nil {
			t.Fatalf("expected Round 4 seat %d to have a feeder from R2 or R3", si+1)
		}
	}

	badLoop := reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: r4ID,
		ToRoundID:   r1ID,
	})
	if badLoop.Code != http.StatusOK {
		t.Fatalf("expected 200 OK with Invalid=true when creating loop Round 4 -> Round 1, got %d", badLoop.Code)
	}
	st = decodeState(t, badLoop)
	if len(st.RaceState.Connections) != 5 {
		t.Fatalf("expected 5 connections including invalid loop wire, got %d", len(st.RaceState.Connections))
	}
	loopConn := st.RaceState.Connections[4]
	if !loopConn.Invalid || loopConn.InvalidReason == "" {
		t.Fatalf("expected loop connection to be marked Invalid with InvalidReason, got %+v", loopConn)
	}

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{
		Action:       "disconnect_rounds",
		ConnectionID: loopConn.ID,
	}))
	connToRemove := st.RaceState.Connections[3].ID
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{
		Action:       "disconnect_rounds",
		ConnectionID: connToRemove,
	}))
	if len(st.RaceState.Connections) != 3 {
		t.Fatalf("expected 3 connections after disconnect, got %d", len(st.RaceState.Connections))
	}
}

func TestCanvasMoveDuplicateDeleteAndResetLayout(t *testing.T) {
	simEng := tracker.NewEngine()
	realEng := tracker.NewRealEngine()
	sim := ingest.NewTrackSimulator(simEng)
	sim.SetRunning(false)
	lrf := laprf.NewServer(simEng)
	srv := api.NewServer(simEng, sim, lrf, realEng)
	h := srv.Handler()

	st := decodeCreatedState(t, reqJSON(t, h, http.MethodPost, "/v1/race/sessions", map[string]any{
		"name": "Canvas Race",
	}))
	raceID := st.RaceState.RaceID

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{
		Action: "add_round",
		Title:  "Qualifying 1",
		HasPos: true,
		PosX:   120,
		PosY:   160,
	}))
	if !st.RaceState.Generated || len(st.RaceState.Rounds) != 1 {
		t.Fatalf("expected add_round to generate race with 1 round, got generated=%v rounds=%d", st.RaceState.Generated, len(st.RaceState.Rounds))
	}
	r1 := st.RaceState.Rounds[0]
	if !r1.HasPos || r1.PosX != 120 || r1.PosY != 160 {
		t.Fatalf("expected round 1 pos (120, 160), got hasPos=%v (%v, %v)", r1.HasPos, r1.PosX, r1.PosY)
	}

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{
		Action:  "duplicate_round",
		RoundID: r1.ID,
	}))
	if len(st.RaceState.Rounds) != 2 {
		t.Fatalf("expected 2 rounds after duplicate_round, got %d", len(st.RaceState.Rounds))
	}
	r2 := st.RaceState.Rounds[1]
	if !r2.HasPos || r2.PosX != 184 || r2.PosY != 224 {
		t.Fatalf("expected duplicated round offset to (184, 224), got hasPos=%v (%v, %v)", r2.HasPos, r2.PosX, r2.PosY)
	}

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{
		Action:       "update_round",
		RoundID:      r2.ID,
		Title:        "Semi Finals",
		BracketLane:  "winners",
		StageFormat:  domain.FormatSingleElimination,
		StartMode:    domain.StartModeStaggered,
		TargetLaps:   5,
		TimeLimitSec: 180,
		HeatCount:    3,
	}))
	r2Heats := 0
	for _, ht := range st.RaceState.Heats {
		if ht.RoundID == r2.ID {
			r2Heats++
			if ht.StartMode != domain.StartModeStaggered || ht.TargetLaps != 5 {
				t.Fatalf("expected updated startMode=staggered and laps=5, got startMode=%s laps=%d", ht.StartMode, ht.TargetLaps)
			}
		}
	}
	if r2Heats != 3 {
		t.Fatalf("expected 3 heats after update_round HeatCount=3, got %d", r2Heats)
	}

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{
		Action: "move_rounds",
		Positions: []tracker.RoundPositionUpdate{
			{RoundID: r1.ID, PosX: 300, PosY: 100},
			{RoundID: r2.ID, PosX: 740, PosY: 280},
		},
	}))
	for _, rd := range st.RaceState.Rounds {
		if rd.ID == r1.ID && (!rd.HasPos || rd.PosX != 300 || rd.PosY != 100) {
			t.Fatalf("expected r1 moved to (300,100), got %+v", rd)
		}
		if rd.ID == r2.ID && (!rd.HasPos || rd.PosX != 740 || rd.PosY != 280) {
			t.Fatalf("expected r2 moved to (740,280), got %+v", rd)
		}
	}

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{
		Action: "reset_round_layout",
	}))
	for _, rd := range st.RaceState.Rounds {
		if rd.HasPos {
			t.Fatalf("expected reset_round_layout to clear HasPos on %s", rd.ID)
		}
	}

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", raceID), tracker.BracketEditPayload{
		Action:   "delete_rounds",
		RoundIDs: []string{r1.ID, r2.ID},
	}))
	if len(st.RaceState.Rounds) != 0 || len(st.RaceState.Heats) != 0 {
		t.Fatalf("expected 0 rounds and 0 heats after delete_rounds, got rounds=%d heats=%d", len(st.RaceState.Rounds), len(st.RaceState.Heats))
	}
}

func TestPausedRaceStartHeatAutoActivatesAndRHDebugStream(t *testing.T) {
	simEng := tracker.NewEngine()
	realEng := tracker.NewRealEngine()
	sim := ingest.NewTrackSimulator(simEng)
	sim.SetRunning(true)
	defer sim.SetRunning(false)
	lrf := laprf.NewServer(simEng)
	srv := api.NewServer(simEng, sim, lrf, realEng)
	h := srv.Handler()

	getState := func() api.FullStateResponse {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/v1/state", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return decodeState(t, rec)
	}

	st := decodeState(t, reqJSON(t, h, http.MethodPut, "/v1/timing/mode", map[string]string{"mode": "race"}))
	st = decodeCreatedState(t, reqJSON(t, h, http.MethodPost, "/v1/race/sessions", map[string]any{
		"name": "Auto-Activate Paused Race",
	}))
	raceID := st.RaceState.RaceID
	cfg := st.RaceState.Config
	cfg.CountdownSec = 0
	st = decodeState(t, reqJSON(t, h, http.MethodPut, fmt.Sprintf("/v1/race/sessions/%s/config", raceID), map[string]any{
		"config":   cfg,
		"generate": true,
	}))
	h1 := st.RaceState.Heats[0].ID
	h2 := st.RaceState.Heats[1].ID

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/%s:control", raceID, h1), map[string]any{"action": "start"}))
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/%s:control", raceID, h1), map[string]any{"action": "stop"}))
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s:pause", raceID), map[string]any{}))
	if st.RaceState.Lifecycle != domain.LifecyclePaused {
		t.Fatalf("expected paused race, got %s", st.RaceState.Lifecycle)
	}

	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/%s:control", raceID, h1), map[string]any{"action": "confirm"}))
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/%s:control", raceID, h2), map[string]any{"action": "start"}))
	if st.RaceState.Lifecycle != domain.LifecycleActive {
		t.Fatalf("expected starting heat on paused race with no conflict to auto-activate race, got %s", st.RaceState.Lifecycle)
	}
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s/heats/%s:control", raceID, h2), map[string]any{"action": "stop"}))
	st = decodeState(t, reqJSON(t, h, http.MethodPost, fmt.Sprintf("/v1/race/sessions/%s:pause", raceID), map[string]any{}))

	// 2. Switch to RotorHazard mode with NO active race or practice -> nodes are idle (0 MHz) until Debug Stream is enabled
	st = decodeState(t, reqJSON(t, h, http.MethodPut, "/v1/hardware/mode", map[string]any{"mode": "rotorhazard"}))
	if st.SimState == nil || len(st.SimState.RotorHazardUnits) == 0 {
		t.Fatalf("expected simulated RotorHazard units in sim mode")
	}
	recOff := reqJSON(t, h, http.MethodPut, "/v1/rotorhazard/connections/2/debug-stream", map[string]any{"active": false})
	if recOff.Code != http.StatusOK {
		t.Fatalf("expected 200 from PUT /v1/rotorhazard/connections/2/debug-stream=false, got %d", recOff.Code)
	}
	st = getState()
	for ch, freq := range st.SimState.RotorHazardUnits[0].NodeFreqsMHz {
		if freq != 0 {
			t.Fatalf("expected idle RH node %d to be 0 MHz when no race/practice/debug stream is active, got %d", ch+1, freq)
		}
	}

	recOn := reqJSON(t, h, http.MethodPut, "/v1/rotorhazard/connections/2/debug-stream", map[string]any{"active": true})
	if recOn.Code != http.StatusOK {
		t.Fatalf("expected 200 from PUT /v1/rotorhazard/connections/2/debug-stream=true, got %d", recOn.Code)
	}
	st = getState()
	for ch, freq := range st.SimState.RotorHazardUnits[0].NodeFreqsMHz {
		want := domain.RacebandFrequenciesMHz[ch]
		if freq != want {
			t.Fatalf("expected RH node %d tuned to %d MHz during idle debug stream, got %d", ch+1, want, freq)
		}
	}
	if st.SimState.RotorHazardUnits[0].HeartbeatsRx == 0 {
		t.Fatalf("expected HeartbeatsRx > 0 after enabling RH debug stream")
	}
}
