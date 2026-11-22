package multigp_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"slaprf/internal/domain"
	"slaprf/internal/multigp"
)

func TestComputeSeatMetricsHonorsInvalidatedLapsAndDQ(t *testing.T) {
	seat := domain.HeatSeat{
		PilotSlotIndex: 1,
		Status:         domain.PilotHeatFinished,
		Position:       1,
		Points:         10,
		Laps: []domain.HeatLap{
			{LapNumber: 0, SplitTimeSec: 1.420},
			{LapNumber: 1, SplitTimeSec: 13.500},
			{LapNumber: 2, SplitTimeSec: 12.100},
			{LapNumber: 3, SplitTimeSec: 11.800, Invalidated: true}, // invalidated in RSSI editor!
			{LapNumber: 4, SplitTimeSec: 12.400},
		},
	}
	m := multigp.ComputeSeatMetrics(seat, false)
	if m.TotalLaps != 3 {
		t.Fatalf("expected 3 valid laps, got %d", m.TotalLaps)
	}
	if m.FastestLapTime != 12.1 {
		t.Fatalf("expected fastest valid lap 12.100, got %.3f", m.FastestLapTime)
	}
	if m.Fastest2ConsecutiveLapsTime != 24.5 {
		t.Fatalf("expected fastest 2 consecutive valid laps 24.500 (12.1+12.4), got %.3f", m.Fastest2ConsecutiveLapsTime)
	}
	if m.Fastest3ConsecutiveLapsTime != 38.0 {
		t.Fatalf("expected fastest 3 consecutive valid laps 38.000, got %.3f", m.Fastest3ConsecutiveLapsTime)
	}
	if m.Score != 10 {
		t.Fatalf("expected score 10, got %.1f", m.Score)
	}

	seat.Status = domain.PilotHeatDQ
	dqM := multigp.ComputeSeatMetrics(seat, false)
	if dqM.TotalLaps != 0 || dqM.Score != 0 {
		t.Fatalf("expected zeroed metrics for DQ pilot, got %+v", dqM)
	}
}

func TestSimBackendWebServiceLifecycle(t *testing.T) {
	sim := multigp.NewSimBackend()

	call := func(subPath, query string, body any) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(body)
		url := "/v1/sim/multigp/" + subPath
		if query != "" {
			url += "?" + query
		}
		req := httptest.NewRequest(http.MethodPost, url, bytes.NewReader(raw))
		rec := httptest.NewRecorder()
		sim.ServeWebServiceHTTP(rec, req, subPath)
		return rec
	}

	// 1. Verify API key
	r1 := call("chapter/findChapterFromApiKey", "", map[string]any{"apiKey": multigp.DefaultSimAPIKey})
	if r1.Code != http.StatusOK {
		t.Fatalf("findChapter failed: %d %s", r1.Code, r1.Body.String())
	}
	var chResp multigp.FindChapterResponse
	_ = json.Unmarshal(r1.Body.Bytes(), &chResp)
	if !chResp.Status || chResp.ChapterName != "Bay Area FPV" {
		t.Fatalf("unexpected chapter response: %+v", chResp)
	}

	// 2. Push assignSlot result & captureOverallRaceResult
	r2 := call("race/assignSlot", "id=501&cycle=1&heat=1&slot=1", multigp.AssignSlotRequest{
		APIKey: multigp.DefaultSimAPIKey,
		Data: multigp.AssignSlotData{
			PilotID:                     1001,
			Score:                       6,
			TotalLaps:                   3,
			TotalTime:                   37.42,
			FastestLapTime:              12.11,
			Fastest2ConsecutiveLapsTime: 24.55,
			Fastest3ConsecutiveLapsTime: 37.42,
		},
	})
	if r2.Code != http.StatusOK {
		t.Fatalf("assignSlot failed: %d %s", r2.Code, r2.Body.String())
	}

	r3 := call("race/captureOverallRaceResult", "id=501", multigp.CaptureOverallRequest{
		APIKey: multigp.DefaultSimAPIKey,
		Data: multigp.CaptureOverallData{
			RaceID: 501,
			BracketResults: []multigp.OverallResultEntry{
				{OrderNumber: 1, PilotID: 1001},
				{OrderNumber: 2, PilotID: 1002},
			},
		},
	})
	if r3.Code != http.StatusOK {
		t.Fatalf("captureOverallRaceResult failed: %d %s", r3.Code, r3.Body.String())
	}

	// 3. Queue ZippyQ round on race 502 and pull getAdditionalRounds
	_, err := sim.ApplyAdminAction(multigp.SimAdminAction{Action: "queue-zippyq", RaceID: 502})
	if err != nil {
		t.Fatalf("queue-zippyq failed: %v", err)
	}
	r4 := call("race/getAdditionalRounds", "id=502&startFromRound=3", map[string]any{"apiKey": multigp.DefaultSimAPIKey})
	var addResp multigp.AdditionalRoundsResponse
	_ = json.Unmarshal(r4.Body.Bytes(), &addResp)
	if !addResp.Status || len(addResp.Data.Rounds) != 1 || addResp.Data.Rounds[0].RoundNumber != 3 {
		t.Fatalf("unexpected getAdditionalRounds: %+v", addResp)
	}

	// 4. Verify ZippyQ check-in & line-up + schedule editing actions
	st, err := sim.ApplyAdminAction(multigp.SimAdminAction{Action: "sim-zippyq-checkin", RaceID: 502})
	if err != nil {
		t.Fatalf("sim-zippyq-checkin failed: %v", err)
	}
	if len(st.Races[1].Entries) != 7 {
		t.Fatalf("expected 7 checked-in pilots after checkin, got %d", len(st.Races[1].Entries))
	}
	st, err = sim.ApplyAdminAction(multigp.SimAdminAction{Action: "sim-zippyq-lineup", RaceID: 502})
	if err != nil {
		t.Fatalf("sim-zippyq-lineup failed: %v", err)
	}
	// Round 2 originally had 2 occupied seats (FAERRY..BigRamon in R1, Red5 & SwampDog in R2); lining up fills seat 3 of Round 2!
	if st.Races[1].Schedule.Rounds[1].Heats[0].Entries[2].PilotID == 0 {
		t.Fatalf("expected Round 2 open seat 3 to be populated by line-up, got %+v", st.Races[1].Schedule.Rounds[1].Heats[0].Entries)
	}

	// Verify seat move/swap in race 501
	pA := st.Races[0].Schedule.Rounds[0].Heats[0].Entries[0].PilotID
	pB := st.Races[0].Schedule.Rounds[0].Heats[0].Entries[1].PilotID
	st, err = sim.ApplyAdminAction(multigp.SimAdminAction{
		Action:        "move-seat",
		RaceID:        501,
		FromRound:     1,
		FromHeat:      1,
		FromSeatIndex: 0,
		RoundNumber:   1,
		HeatNumber:    1,
		SeatIndex:     1,
	})
	if err != nil {
		t.Fatalf("move-seat failed: %v", err)
	}
	if st.Races[0].Schedule.Rounds[0].Heats[0].Entries[0].PilotID != pB ||
		st.Races[0].Schedule.Rounds[0].Heats[0].Entries[1].PilotID != pA {
		t.Fatalf("expected seats 0 and 1 to swap pilots")
	}
}
