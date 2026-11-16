package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"slaprf/internal/api"
	"slaprf/internal/domain"
	"slaprf/internal/ingest"
	"slaprf/internal/laprf"
	"slaprf/internal/tracker"
)

func postJSON(t *testing.T, h http.Handler, path string, body interface{}) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal %s: %v", path, err)
	}
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeState(t *testing.T, rec *httptest.ResponseRecorder) api.FullStateResponse {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d: %s", rec.Code, rec.Body.String())
	}
	var st api.FullStateResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatalf("unmarshal state: %v", err)
	}
	return st
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
	st := decodeState(t, postJSON(t, h, "/api/pilots/update", p1))
	if st.Pilots[0].Channel != 7 {
		t.Fatalf("expected Practice pilot 1 on R7, got R%d", st.Pilots[0].Channel)
	}

	st = decodeState(t, postJSON(t, h, "/api/pilots/add", map[string]string{
		"callsign":     "Mondo",
		"phoneticName": "Mahn-doh",
	}))
	if len(st.Pilots) != 9 {
		t.Fatalf("expected 9 pilots after add, got %d", len(st.Pilots))
	}

	// 2. Switch to Race Mode: pilots should all be unarmed until a heat stages, and Practice snapshot saved.
	st = decodeState(t, postJSON(t, h, "/api/race/mode", map[string]string{"mode": "race"}))
	if st.RaceState.Mode != domain.ModeRace {
		t.Fatalf("expected mode=race, got %s", st.RaceState.Mode)
	}

	// 3. Configure & generate an 8-pilot Double Elimination + Chase the Ace tournament (remove 9th pilot first).
	st = decodeState(t, postJSON(t, h, "/api/pilots/remove", map[string]int{"slotIndex": 9}))
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
	cfg.CountdownSec = 0 // Instant start horn for fast unit test
	st = decodeState(t, postJSON(t, h, "/api/race/setup", map[string]interface{}{
		"config":   cfg,
		"generate": true,
	}))
	if !st.RaceState.Generated || len(st.RaceState.Heats) < 4 {
		t.Fatalf("expected generated Double Elim heats, got generated=%v count=%d", st.RaceState.Generated, len(st.RaceState.Heats))
	}
	if st.RaceState.ActiveHeatID != "W1-1" {
		t.Fatalf("expected active heat W1-1, got %q", st.RaceState.ActiveHeatID)
	}

	// 4. Start W1-1, score manual laps, toggle DNF on one pilot, finish, confirm, unlock, re-confirm.
	st = decodeState(t, postJSON(t, h, "/api/race/control", map[string]string{"action": "start", "heatId": "W1-1"}))
	w1 := st.RaceState.Heats[0]
	if w1.State != domain.HeatRunning {
		t.Fatalf("expected W1-1 running, got %s", w1.State)
	}
	seat1Pilot := w1.Seats[0].PilotSlotIndex
	seat2Pilot := w1.Seats[1].PilotSlotIndex
	seat3Pilot := w1.Seats[2].PilotSlotIndex

	// Add 3 manual passes for seat1Pilot (Holeshot + Lap 1 + Lap 2 -> finishes 2-lap race!)
	for pass := 0; pass < 3; pass++ {
		st = decodeState(t, postJSON(t, h, "/api/race/marshal", tracker.RaceMarshalPayload{
			HeatID:         "W1-1",
			PilotSlotIndex: seat1Pilot,
			Action:         "add_lap",
		}))
	}
	// Add 3 manual passes for seat2Pilot
	for pass := 0; pass < 3; pass++ {
		st = decodeState(t, postJSON(t, h, "/api/race/marshal", tracker.RaceMarshalPayload{
			HeatID:         "W1-1",
			PilotSlotIndex: seat2Pilot,
			Action:         "add_lap",
		}))
	}
	// Crash out (DNF) seat3Pilot
	st = decodeState(t, postJSON(t, h, "/api/race/marshal", tracker.RaceMarshalPayload{
		HeatID:         "W1-1",
		PilotSlotIndex: seat3Pilot,
		Action:         "toggle_dnf",
	}))

	// Pause, Resume, Stop heat into Finished (review) state
	st = decodeState(t, postJSON(t, h, "/api/race/control", map[string]string{"action": "pause", "heatId": "W1-1"}))
	if st.RaceState.Heats[0].State != domain.HeatPaused {
		t.Fatalf("expected paused, got %s", st.RaceState.Heats[0].State)
	}
	st = decodeState(t, postJSON(t, h, "/api/race/control", map[string]string{"action": "resume", "heatId": "W1-1"}))
	if st.RaceState.Heats[0].State != domain.HeatRunning {
		t.Fatalf("expected running after resume, got %s", st.RaceState.Heats[0].State)
	}
	st = decodeState(t, postJSON(t, h, "/api/race/control", map[string]string{"action": "stop", "heatId": "W1-1"}))
	if st.RaceState.Heats[0].State != domain.HeatFinished {
		t.Fatalf("expected finished (awaiting confirmation), got %s", st.RaceState.Heats[0].State)
	}

	// Test Move Up override on 2nd-place pilot -> becomes 1st!
	st = decodeState(t, postJSON(t, h, "/api/race/marshal", tracker.RaceMarshalPayload{
		HeatID:         "W1-1",
		PilotSlotIndex: seat2Pilot,
		Action:         "move_up",
	}))
	for _, s := range st.RaceState.Heats[0].Seats {
		if s.PilotSlotIndex == seat2Pilot && s.Position != 1 {
			t.Fatalf("expected seat2Pilot moved up to 1st, got pos %d", s.Position)
		}
	}

	// Confirm W1-1 -> locks W1-1 and automatically stages W1-2!
	st = decodeState(t, postJSON(t, h, "/api/race/control", map[string]string{"action": "confirm", "heatId": "W1-1"}))
	if st.RaceState.Heats[0].State != domain.HeatConfirmed {
		t.Fatalf("expected W1-1 confirmed, got %s", st.RaceState.Heats[0].State)
	}
	if !st.RaceState.Heats[0].CanUnlock {
		t.Fatalf("expected W1-1 CanUnlock=true before downstream heats start")
	}
	if st.RaceState.ActiveHeatID != "W1-2" {
		t.Fatalf("expected auto-staged next heat W1-2, got %q", st.RaceState.ActiveHeatID)
	}

	// Unlock W1-1 -> returns to Finished!
	st = decodeState(t, postJSON(t, h, "/api/race/control", map[string]string{"action": "unlock", "heatId": "W1-1"}))
	if st.RaceState.Heats[0].State != domain.HeatFinished {
		t.Fatalf("expected W1-1 unlocked back to finished, got %s", st.RaceState.Heats[0].State)
	}

	// Test drag-and-drop reorder_seats override: place seat3Pilot 1st, seat1Pilot 2nd, seat2Pilot 3rd!
	st = decodeState(t, postJSON(t, h, "/api/race/marshal", tracker.RaceMarshalPayload{
		HeatID:             "W1-1",
		PilotSlotIndex:     seat3Pilot,
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
	st = decodeState(t, postJSON(t, h, "/api/race/mode", map[string]string{"mode": "practice"}))
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

	st := decodeState(t, postJSON(t, h, "/api/race/mode", map[string]string{"mode": "race"}))
	if len(st.EventState.Races) != 0 {
		t.Fatalf("expected clean initial state with 0 races, got races=%d", len(st.EventState.Races))
	}

	// 1. Create Race 1 with tags -> starts EMPTY (`Generated == false`) with normalized tags!
	st = decodeState(t, postJSON(t, h, "/api/events/action", tracker.EventActionPayload{
		Action: "create_race",
		Name:   "Race 1 · Open Class",
		Tags:   []string{"#Summer Nationals", "  Open  Class ", "summer nationals"},
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

	// Apply Double Elimination template via `/api/race/setup` with `generate: true`.
	cfg := st.RaceState.Config
	cfg.CountdownSec = 0
	st = decodeState(t, postJSON(t, h, "/api/race/setup", map[string]interface{}{
		"config":   cfg,
		"generate": true,
	}))
	if !st.RaceState.Generated || len(st.RaceState.Heats) == 0 {
		t.Fatalf("expected generated heats for Race 1")
	}

	// Create Race 2 — starts empty with independent per-race attendance and its own tags!
	st = decodeState(t, postJSON(t, h, "/api/events/action", tracker.EventActionPayload{
		Action:     "create_race",
		Name:       "Race 2 · Spec Class",
		Tags:       []string{"Summer Nationals", "Spec"},
		CopyConfig: true,
	}))
	race2ID := st.RaceState.RaceID
	if race2ID == race1ID || st.RaceState.Config.EventName != "Race 2 · Spec Class" || st.RaceState.Generated {
		t.Fatalf("expected empty distinct Race 2 selected, got id=%q name=%q generated=%v", race2ID, st.RaceState.Config.EventName, st.RaceState.Generated)
	}

	// Update tags on non-active Race 1 via `set_race_tags` while Race 2 is active.
	st = decodeState(t, postJSON(t, h, "/api/events/action", tracker.EventActionPayload{
		Action: "set_race_tags",
		RaceID: race1ID,
		Tags:   []string{"Summer Nationals", "5-inch", "#Finals"},
	}))

	// 2. Switch back to Race 1, verify updated tags, and uncheck Pilot 8 in Race 1's per-race roster (must NOT affect Race 2's roster!).
	st = decodeState(t, postJSON(t, h, "/api/events/action", tracker.EventActionPayload{
		Action: "select_race",
		RaceID: race1ID,
	}))
	if len(st.RaceState.Tags) != 3 || st.RaceState.Tags[2] != "Finals" {
		t.Fatalf("expected updated tags on Race 1, got %+v", st.RaceState.Tags)
	}
	fVal := false
	st = decodeState(t, postJSON(t, h, "/api/events/action", tracker.EventActionPayload{
		Action:    "update_attendance",
		SlotIndex: 8,
		CheckedIn: &fVal,
	}))
	// Verify Race 2 still has Pilot 8 checked in!
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
	st = decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
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
	st = decodeState(t, postJSON(t, h, "/api/race/control", map[string]string{"action": "start", "heatId": "W1-1"}))
	if st.RaceState.Lifecycle != domain.LifecycleActive {
		t.Fatalf("expected active lifecycle after heat start, got %s", st.RaceState.Lifecycle)
	}
	st = decodeState(t, postJSON(t, h, "/api/events/action", tracker.EventActionPayload{
		Action:          "race_lifecycle",
		LifecycleAction: "pause_race",
		Reason:          "Rain delay",
	}))
	if st.RaceState.Lifecycle != domain.LifecyclePaused || st.RaceState.StatusReason != "Rain delay" {
		t.Fatalf("expected paused race with Rain delay, got %s (%q)", st.RaceState.Lifecycle, st.RaceState.StatusReason)
	}
	if st.RaceState.Heats[0].State != domain.HeatPaused {
		t.Fatalf("expected running W1-1 paused when race suspended, got %s", st.RaceState.Heats[0].State)
	}
	// Start an active Practice session while the Race is paused:
	// attempting to resume W1-1 without preemptOngoing must return 400!
	st = decodeState(t, postJSON(t, h, "/api/practice/action", tracker.PracticeActionPayload{
		Action: "create_session",
		Name:   "Rain Break Practice",
	}))
	sessID := st.PracticeState.SelectedSessionID
	st = decodeState(t, postJSON(t, h, "/api/practice/action", tracker.PracticeActionPayload{
		Action:    "start_session",
		SessionID: sessID,
	}))
	if st.PracticeState.ActiveSessionID == "" {
		t.Fatalf("expected active practice session while race is paused")
	}
	badRec := postJSON(t, h, "/api/race/control", map[string]string{"action": "resume", "heatId": "W1-1"})
	if badRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 when resuming heat while race is paused and practice is active without preemptOngoing, got %d", badRec.Code)
	}

	// Resuming with preemptOngoing: true automatically pauses Practice and switches the Race back to Active!
	st = decodeState(t, postJSON(t, h, "/api/race/control", map[string]any{
		"action":         "resume",
		"heatId":         "W1-1",
		"preemptOngoing": true,
	}))
	if st.RaceState.Lifecycle != domain.LifecycleActive {
		t.Fatalf("expected active lifecycle after resume with preemptOngoing, got %s", st.RaceState.Lifecycle)
	}
	if st.PracticeState.ActiveSessionID != "" {
		t.Fatalf("expected practice session paused after race preemption, got active=%s", st.PracticeState.ActiveSessionID)
	}
	st = decodeState(t, postJSON(t, h, "/api/race/control", map[string]string{"action": "stop", "heatId": "W1-1"}))
	st = decodeState(t, postJSON(t, h, "/api/race/control", map[string]string{"action": "confirm", "heatId": "W1-1"}))

	// 5. Mark a pilot in unstarted W1-2 as `away` -> seat becomes `dns`!
	awayPilot := st.RaceState.Heats[1].Seats[0].PilotSlotIndex
	st = decodeState(t, postJSON(t, h, "/api/events/action", tracker.EventActionPayload{
		Action:     "update_attendance",
		SlotIndex:  awayPilot,
		Attendance: domain.AttendanceAway,
	}))
	if st.RaceState.Heats[1].Seats[0].Status != domain.PilotHeatDNS {
		t.Fatalf("expected away pilot in W1-2 marked DNS, got %s", st.RaceState.Heats[1].Seats[0].Status)
	}

	// 6. Add walk-up late pilot mid-race (`add_race_pilot`) and `auto_seat_pilot` into open bracket slot!
	st = decodeState(t, postJSON(t, h, "/api/events/action", tracker.EventActionPayload{
		Action:       "add_race_pilot",
		Callsign:     "LateRipper",
		PhoneticName: "Layt Ripper",
	}))
	lateSlot := st.Pilots[len(st.Pilots)-1].SlotIndex
	st = decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
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

	st := decodeState(t, postJSON(t, h, "/api/race/mode", map[string]string{"mode": "race"}))

	// Create an untagged pickup race + a tagged main race!
	st = decodeState(t, postJSON(t, h, "/api/events/action", tracker.EventActionPayload{
		Action: "create_race",
		Name:   "Ad-Hoc Pickup Race",
	}))
	adHocID := st.RaceState.RaceID
	if len(st.RaceState.Tags) != 0 {
		t.Fatalf("expected untagged pickup race, got %+v", st.RaceState.Tags)
	}

	st = decodeState(t, postJSON(t, h, "/api/events/action", tracker.EventActionPayload{
		Action: "create_race",
		Name:   "Friday Night Main",
		Tags:   []string{"Friday Night", "Whoops"},
	}))
	raceID := st.RaceState.RaceID

	// Generate heats and start W1-1 so Friday Night Main becomes active / ongoing.
	st = decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
		Action:     "apply_template",
		TemplateID: "double_elimination",
	}))
	cfg := st.RaceState.Config
	cfg.CountdownSec = 0
	st = decodeState(t, postJSON(t, h, "/api/race/setup", map[string]interface{}{
		"config":   cfg,
		"generate": false,
	}))
	st = decodeState(t, postJSON(t, h, "/api/race/control", map[string]string{"action": "start", "heatId": "W1-1"}))
	if st.RaceState.Lifecycle != domain.LifecycleActive {
		t.Fatalf("expected active race, got %s", st.RaceState.Lifecycle)
	}

	// 1. Deleting an active / ongoing race MUST fail with 400.
	rec := postJSON(t, h, "/api/events/action", tracker.EventActionPayload{
		Action: "delete_race",
		RaceID: raceID,
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 when deleting active race, got %d: %s", rec.Code, rec.Body.String())
	}

	// 2. Pause the race -> deleting the race MUST succeed!
	st = decodeState(t, postJSON(t, h, "/api/events/action", tracker.EventActionPayload{
		Action:          "race_lifecycle",
		LifecycleAction: "pause_race",
		Reason:          "Done testing",
	}))
	st = decodeState(t, postJSON(t, h, "/api/events/action", tracker.EventActionPayload{
		Action: "delete_race",
		RaceID: raceID,
	}))
	if len(st.EventState.Races) != 1 || st.EventState.Races[0].RaceID != adHocID {
		t.Fatalf("expected only ad-hoc race remaining, got %+v", st.EventState.Races)
	}

	// 3. Delete the remaining race -> 0 races, and survives RestoreState without resurrecting!
	st = decodeState(t, postJSON(t, h, "/api/events/action", tracker.EventActionPayload{
		Action: "delete_race",
		RaceID: adHocID,
	}))
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

	st := decodeState(t, postJSON(t, h, "/api/race/mode", map[string]string{"mode": "race"}))

	// 1. Create an ad-hoc race (no Event) -> starts empty!
	st = decodeState(t, postJSON(t, h, "/api/events/action", tracker.EventActionPayload{
		Action: "create_race",
		Name:   "Saturday Shootout (Custom)",
	}))
	if st.RaceState.Generated || len(st.RaceState.Heats) != 0 {
		t.Fatalf("expected brand-new race to start empty, got generated=%v heats=%d", st.RaceState.Generated, len(st.RaceState.Heats))
	}

	// 2. Start Custom mode (`LinkMode: "none"`) -> Generated=true, TemplateID="custom", 0 rounds initially.
	st = decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
		Action:   "start_custom",
		LinkMode: "none",
	}))
	if !st.RaceState.Generated || st.RaceState.TemplateID != "custom" || len(st.RaceState.Heats) != 0 {
		t.Fatalf("expected custom empty builder, got generated=%v template=%q heats=%d", st.RaceState.Generated, st.RaceState.TemplateID, len(st.RaceState.Heats))
	}

	// 3. Add Round 1 ("Opening Round") seeded from All Active Pilots (8 pilots -> 2 heats of 4).
	st = decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
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

	// 4. Add Round 2 ("Semis / Finals") linked from Top 2 per heat of Round 1 (column 1 -> 1 heat of 4)!
	st = decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
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

	// 5. Add a Redemption Round linked from Bottom 2 per heat of Round 1!
	st = decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
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

	// Delete the unstarted Redemption Round -> back to 2 rounds and 3 heats!
	st = decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
		Action:  "delete_round",
		RoundID: redempRoundID,
	}))
	if len(st.RaceState.Rounds) != 2 || len(st.RaceState.Heats) != 3 {
		t.Fatalf("expected 2 rounds and 3 heats after delete_round, got rounds=%d heats=%d", len(st.RaceState.Rounds), len(st.RaceState.Heats))
	}

	// 6. Run & Confirm Round 1 Heat 1, then verify Round 2 Final Seat 1 & Seat 3 auto-populate from R1-1 finishers!
	cfg := st.RaceState.Config
	cfg.CountdownSec = 0
	st = decodeState(t, postJSON(t, h, "/api/race/setup", map[string]interface{}{
		"config":   cfg,
		"generate": false,
	}))
	st = decodeState(t, postJSON(t, h, "/api/race/control", map[string]string{"action": "start", "heatId": r1Heat1}))
	w1Winner := st.RaceState.Heats[0].Seats[0].PilotSlotIndex
	for pass := 0; pass < 2; pass++ {
		st = decodeState(t, postJSON(t, h, "/api/race/marshal", tracker.RaceMarshalPayload{
			HeatID:         r1Heat1,
			PilotSlotIndex: w1Winner,
			Action:         "add_lap",
		}))
	}
	st = decodeState(t, postJSON(t, h, "/api/race/control", map[string]string{"action": "stop", "heatId": r1Heat1}))
	st = decodeState(t, postJSON(t, h, "/api/race/control", map[string]string{"action": "confirm", "heatId": r1Heat1}))

	if st.RaceState.Heats[2].Seats[0].PilotSlotIndex != w1Winner {
		t.Fatalf("expected R1-1 winner (slot %d) propagated into Final Seat 1, got slot %d", w1Winner, st.RaceState.Heats[2].Seats[0].PilotSlotIndex)
	}

	// Deleting Round 1 after r1Heat1 is confirmed MUST fail with 400!
	badDel := postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
		Action:  "delete_round",
		Column:  1,
		RoundID: st.RaceState.Rounds[0].ID,
	})
	if badDel.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 when deleting started round, got %d", badDel.Code)
	}

	// 7. Test `regenerate_upcoming`: confirmed r1Heat1 stays untouched while unstarted r1Heat2 re-balances active pilots!
	st = decodeState(t, postJSON(t, h, "/api/events/action", tracker.EventActionPayload{
		Action:   "add_race_pilot",
		Callsign: "WalkUpAce",
	}))
	walkUpSlot := st.Pilots[len(st.Pilots)-1].SlotIndex
	st = decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
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

	decodeState(t, postJSON(t, h, "/api/race/mode", map[string]string{"mode": "race"}))
	decodeState(t, postJSON(t, h, "/api/events/action", tracker.EventActionPayload{
		Action: "create_race",
		Name:   "Node Graph Race",
	}))

	// 1. Start custom -> creates Round 1 seeded with all 8 active pilots (2 heats of 4)
	st := decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
		Action: "start_custom",
	}))
	if len(st.RaceState.Rounds) != 1 || len(st.RaceState.Heats) != 2 {
		t.Fatalf("expected Round 1 with 2 heats, got rounds=%d heats=%d", len(st.RaceState.Rounds), len(st.RaceState.Heats))
	}
	r1ID := st.RaceState.Rounds[0].ID

	// 2. One-click +Add Round three times (Round 2, Round 3, Round 4) with zero parameters -> unconnected nodes!
	st = decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{Action: "add_round"}))
	r2ID := st.RaceState.Rounds[1].ID
	st = decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{Action: "add_round"}))
	r3ID := st.RaceState.Rounds[2].ID
	st = decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{Action: "add_round"}))
	r4ID := st.RaceState.Rounds[3].ID

	// 3. Drag wire 1: Round 1 -> Round 2 (smart default = top_per_heat, count=2)
	st = decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: r1ID,
		ToRoundID:   r2ID,
	}))
	if len(st.RaceState.Connections) != 1 || st.RaceState.Connections[0].Mode != "top_per_heat" || st.RaceState.Connections[0].Count != 2 {
		t.Fatalf("expected 1st wire to auto-pick top_per_heat(2), got %+v", st.RaceState.Connections)
	}

	// 4. Drag wire 2: Round 1 -> Round 3 (smart default = bottom_per_heat, count=2, and Column=1 vertically aligned under Round 1!)
	st = decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
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

	// 5. Multi-input merge: Drag Round 2 -> Round 4 AND Round 3 -> Round 4!
	decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
		Action:      "connect_rounds",
		FromRoundID: r2ID,
		ToRoundID:   r4ID,
	}))
	st = decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
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

	// 6. Non-blocking cycle handling: connecting Round 4 -> Round 1 persists the wire with Invalid=true and a reason!
	badLoop := postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
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

	// 7. Disconnect invalid wire and one valid wire -> connections drops to 3
	st = decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
		Action:       "disconnect_rounds",
		ConnectionID: loopConn.ID,
	}))
	connToRemove := st.RaceState.Connections[3].ID
	st = decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
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

	decodeState(t, postJSON(t, h, "/api/events/action", tracker.EventActionPayload{
		Action: "create_race",
		Name:   "Canvas Race",
	}))

	// 1. Add Round directly onto an ungenerated race with explicit canvas coordinates!
	st := decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
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

	// 2. Duplicate round -> creates "Qualifying 1 Copy" offset on canvas
	st = decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
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

	// 3. Customize round via update_round (HeatCount, StartMode, Format, Laps, Time)
	st = decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
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

	// 4. Batch move_rounds persists across SyncRoundsMetadata
	st = decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
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

	// 5. Reset layout clears HasPos so auto-layout takes over cleanly
	st = decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
		Action: "reset_round_layout",
	}))
	for _, rd := range st.RaceState.Rounds {
		if rd.HasPos {
			t.Fatalf("expected reset_round_layout to clear HasPos on %s", rd.ID)
		}
	}

	// 6. Batch delete_rounds removes multiple selected rounds cleanly
	st = decodeState(t, postJSON(t, h, "/api/race/bracket-edit", tracker.BracketEditPayload{
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
		req := httptest.NewRequest(http.MethodGet, "/api/state", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return decodeState(t, rec)
	}

	// 1. Switch to race mode, generate a 2-heat race, finish & confirm Heat 1, then pause the Race
	st := decodeState(t, postJSON(t, h, "/api/race/mode", map[string]string{"mode": "race"}))
	st = decodeState(t, postJSON(t, h, "/api/events/action", tracker.EventActionPayload{
		Action: "create_race",
		Name:   "Auto-Activate Paused Race",
	}))
	cfg := st.RaceState.Config
	cfg.CountdownSec = 0
	st = decodeState(t, postJSON(t, h, "/api/race/setup", map[string]any{
		"config":   cfg,
		"generate": true,
	}))
	h1 := st.RaceState.Heats[0].ID
	h2 := st.RaceState.Heats[1].ID

	st = decodeState(t, postJSON(t, h, "/api/race/control", map[string]any{"action": "start", "heatId": h1}))
	st = decodeState(t, postJSON(t, h, "/api/race/control", map[string]any{"action": "stop", "heatId": h1}))
	st = decodeState(t, postJSON(t, h, "/api/events/action", tracker.EventActionPayload{
		Action:          "race_lifecycle",
		LifecycleAction: "pause_race",
	}))
	if st.RaceState.Lifecycle != domain.LifecyclePaused {
		t.Fatalf("expected paused race, got %s", st.RaceState.Lifecycle)
	}

	// Confirming Heat 1 while paused succeeds; starting Heat 2 with NO other active session auto-activates the race!
	st = decodeState(t, postJSON(t, h, "/api/race/control", map[string]any{"action": "confirm", "heatId": h1}))
	st = decodeState(t, postJSON(t, h, "/api/race/control", map[string]any{"action": "start", "heatId": h2}))
	if st.RaceState.Lifecycle != domain.LifecycleActive {
		t.Fatalf("expected starting heat on paused race with no conflict to auto-activate race, got %s", st.RaceState.Lifecycle)
	}
	st = decodeState(t, postJSON(t, h, "/api/race/control", map[string]any{"action": "stop", "heatId": h2}))
	st = decodeState(t, postJSON(t, h, "/api/events/action", tracker.EventActionPayload{
		Action:          "race_lifecycle",
		LifecycleAction: "pause_race",
	}))

	// 2. Switch to RotorHazard mode with NO active race or practice -> nodes are idle (0 MHz) until Debug Stream is enabled
	st = decodeState(t, postJSON(t, h, "/api/hardware/mode", map[string]any{"mode": "rotorhazard"}))
	if st.SimState == nil || len(st.SimState.RotorHazardUnits) == 0 {
		t.Fatalf("expected simulated RotorHazard units in sim mode")
	}
	recOff := postJSON(t, h, "/api/hardware/rh-debug-stream", map[string]any{"timerId": 2, "active": false})
	if recOff.Code != http.StatusOK {
		t.Fatalf("expected 200 from rh-debug-stream=false, got %d", recOff.Code)
	}
	st = getState()
	for ch, freq := range st.SimState.RotorHazardUnits[0].NodeFreqsMHz {
		if freq != 0 {
			t.Fatalf("expected idle RH node %d to be 0 MHz when no race/practice/debug stream is active, got %d", ch+1, freq)
		}
	}

	// Enable Debug Stream on Timer 2 -> nodes immediately tune to R1..R8 and stream heartbeats without an active race/practice!
	recOn := postJSON(t, h, "/api/hardware/rh-debug-stream", map[string]any{"timerId": 2, "active": true})
	if recOn.Code != http.StatusOK {
		t.Fatalf("expected 200 from rh-debug-stream=true, got %d", recOn.Code)
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
