package api

import (
	"encoding/json"
	"net/http"

	"slaprf/internal/domain"
	"slaprf/internal/tracker"
)

func (s *Server) handleAddPilot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Callsign     string `json:"callsign"`
		PhoneticName string `json:"phoneticName"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}
	if err := s.activeEngine().AddPilot(body.Callsign, body.PhoneticName); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.handleGetState(w, r)
}

func (s *Server) handleRemovePilot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		SlotIndex int `json:"slotIndex"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.activeEngine().RemovePilot(body.SlotIndex); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.handleGetState(w, r)
}

func (s *Server) handleExportPilotsCSV(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	csvBody := s.activeEngine().ExportPilotsCSV()
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="slaprf-pilots.csv"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(csvBody))
}

func (s *Server) handleImportPilotsCSV(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		CSV string `json:"csv"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	summary, err := s.activeEngine().ImportPilotsCSV(body.CSV)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	resp := s.buildFullStateResponse()
	resp.ImportSummary = &summary
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleRaceMode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Mode domain.OperatingMode `json:"mode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.activeEngine().SetOperatingMode(body.Mode)
	s.handleGetState(w, r)
}

func (s *Server) handleRaceSetup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		RaceID          string                 `json:"raceId"`
		Config          domain.RaceSetupConfig `json:"config"`
		Generate        bool                   `json:"generate"`
		ApplyToExisting bool                   `json:"applyToExisting"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.activeEngine().ConfigureAndGenerateRaceForID(body.RaceID, body.Config, body.Generate, body.ApplyToExisting)
	s.handleGetState(w, r)
}

func (s *Server) handleRaceAdvanceStage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if _, err := s.activeEngine().AdvanceRaceStage2(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.handleGetState(w, r)
}

func (s *Server) handleRaceControl(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		RaceID         string `json:"raceId"`
		Action         string `json:"action"`
		HeatID         string `json:"heatId"`
		PreemptOngoing bool   `json:"preemptOngoing"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if _, err := s.activeEngine().RaceControlActionWithOptions(body.RaceID, body.Action, body.HeatID, body.PreemptOngoing); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.handleGetState(w, r)
}

func (s *Server) handleRaceMarshal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body tracker.RaceMarshalPayload
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if _, err := s.activeEngine().MarshalPilotAction(body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.handleGetState(w, r)
}

func (s *Server) handleRaceTick(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, s.activeEngine().RaceSnapshot())
}

func (s *Server) handleEventAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body tracker.EventActionPayload
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if _, err := s.activeEngine().EventAction(body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.handleGetState(w, r)
}

func (s *Server) handlePracticeAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body tracker.PracticeActionPayload
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if _, err := s.activeEngine().PracticeAction(body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.handleGetState(w, r)
}

func (s *Server) handleRaceBracketEdit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body tracker.BracketEditPayload
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if _, err := s.activeEngine().BracketEditAction(body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.handleGetState(w, r)
}
