package portable

import (
	"encoding/json"
	"errors"
	"net/http"

	"slaprf/internal/domain"
	"slaprf/internal/ingest"
)

// handleHubSurvey reports or changes the band survey (Network page "Measure all Raceband").
//
//	GET  /api/hub/survey               -> current state and the channel table timers sweep
//	POST /api/hub/survey {"on": bool}  -> start (or renew the 15 s lease) / stop
//
// While a survey runs, every SlapRF timer sweeps Raceband R1..R8 and lap detection gets no signal.
// It is refused during a live race heat and ends on its own when a heat starts or the lease runs out.
func (s *Server) handleHubSurvey(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	switch r.Method {
	case http.MethodGet:
	case http.MethodPost:
		var req struct {
			On bool `json:"on"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON body"})
			return
		}
		if req.On && (s.sim.IsRunning() || s.realEngine.TimingHardwareMode() != domain.HardwareModeSlapRF) {
			writeJSONNoStore(w, http.StatusConflict, map[string]any{"error": "the band survey needs SlapRF hardware (not the simulator)"})
			return
		}
		wasActive := s.realHubRx.SurveyActive()
		if err := s.realHubRx.SetSurvey(req.On); err != nil {
			status := http.StatusInternalServerError
			if errors.Is(err, ingest.ErrSurveyRaceActive) {
				status = http.StatusConflict
			}
			writeJSONNoStore(w, status, map[string]any{"error": err.Error()})
			return
		}
		if wasActive != req.On {
			// Drop any temporary Debug-page channel override on the Hub so it sweeps the new table too.
			s.usbMgr.SendToHub("CHANNELS RESET")
		}
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSONNoStore(w, http.StatusOK, s.hubSurveyState())
}

func (s *Server) hubSurveyState() map[string]any {
	freqs, slotToPilot := s.realEngine.ActivePilotChannels()
	pilots, _, _, _, _ := s.realEngine.StateSnapshot()
	course := make([]map[string]any, domain.MaxPilotSlots)
	for ch := 0; ch < domain.MaxPilotSlots; ch++ {
		entry := map[string]any{"mhz": freqs[ch]}
		if freqs[ch] > 0 {
			if p := slotToPilot[ch]; p >= 0 && p < len(pilots) {
				entry["pilot"] = pilots[p].Callsign
			}
		}
		course[ch] = entry
	}
	return map[string]any{
		"active":     s.realHubRx.SurveyActive(),
		"raceActive": s.realEngine.IsLiveRaceHeatActive(),
		"leaseMs":    ingest.SurveyLease.Milliseconds(),
		"course":     course,
		"surveyMhz":  ingest.RacebandMHz,
	}
}
