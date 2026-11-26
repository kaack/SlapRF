package portable

import (
	"encoding/json"
	"errors"
	"net/http"

	"slaprf/internal/domain"
	"slaprf/internal/ingest"
	"slaprf/internal/slaprf"
)

func (s *Server) handleUSBSurvey(w http.ResponseWriter, r *http.Request) {
	s.serveHubSurvey(w, r, domain.HardwareModeSlapRF, s.usbMgr)
}

func (s *Server) handleBluetoothSurvey(w http.ResponseWriter, r *http.Request) {
	s.serveHubSurvey(w, r, domain.HardwareModeSlapRFBLE, s.bleMgr)
}

func (s *Server) serveHubSurvey(w http.ResponseWriter, r *http.Request, wantMode domain.TimingHardwareMode, mgr *slaprf.Manager) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	switch r.Method {
	case http.MethodGet:
	case http.MethodPut:
		var req struct {
			On bool `json:"on"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON body"})
			return
		}
		if req.On && (s.sim.IsRunning() || s.realEngine.TimingHardwareMode() != wantMode) {
			msg := "the USB band survey requires SlapRF (USB) mode"
			if wantMode == domain.HardwareModeSlapRFBLE {
				msg = "the Bluetooth band survey requires SlapRF (Bluetooth) mode"
			} else if wantMode == domain.HardwareModeSlapRFNet {
				msg = "the PoE network band survey requires SlapRF (Network) mode"
			}
			writeJSONNoStore(w, http.StatusConflict, map[string]any{"error": msg})
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
			mgr.SendToHub("CHANNELS RESET")
			s.appLog.Infof("[%s] 5.8 GHz Raceband survey active=%v", mgr.Transport().Name(), req.On)
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
