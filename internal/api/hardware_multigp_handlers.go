package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"slaprf/internal/domain"
	"slaprf/internal/ingest"
	"slaprf/internal/multigp"
	"slaprf/internal/tracker"
)

func (s *Server) handleHardwareMode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Mode domain.TimingHardwareMode `json:"mode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	isSim := s.simulator.IsRunning()
	s.activeEngine().SetRHDebugStream(0, false)
	s.activeEngine().SetTimingHardwareMode(body.Mode, isSim)
	if isSim {
		s.simulator.SyncHardwareMode()
	}
	s.handleGetState(w, r)
}

func (s *Server) handleRHDebugStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		TimerID uint8 `json:"timerId"`
		Active  bool  `json:"active"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.activeEngine().SetRHDebugStream(body.TimerID, body.Active)
	if s.simulator.IsRunning() {
		s.simulator.SyncRHNodesNow()
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleSimLapRFAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req ingest.SimLapRFActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if _, err := s.simulator.ApplyLapRFAction(req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.handleGetState(w, r)
}

func (s *Server) handleSimLapRFDiscover(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	type discoveredItem struct {
		Host      string `json:"host"`
		Port      int    `json:"port"`
		Label     string `json:"label"`
		TimerID   uint8  `json:"timerId"`
		Connected bool   `json:"connected"`
		VoltageMv uint16 `json:"voltageMv"`
	}
	units := s.simulator.DiscoverSimLapRFUnits()
	devices := make([]discoveredItem, 0, len(units))
	for _, u := range units {
		devices = append(devices, discoveredItem{
			Host:      u.Host,
			Port:      u.Port,
			Label:     u.Label,
			TimerID:   u.TimerID,
			Connected: u.Connected,
			VoltageMv: u.VoltageMv,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"subnet":  "192.168.1.0/24 (Simulated LAN)",
		"devices": devices,
	})
}

func (s *Server) handleSimRHAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req ingest.SimRotorHazardActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if _, err := s.simulator.ApplyRotorHazardAction(req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.handleGetState(w, r)
}

func (s *Server) handleSimRHDiscover(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	type discoveredRHItem struct {
		Transport     string `json:"transport,omitempty"`
		PortName      string `json:"portName,omitempty"`
		BaudRate      int    `json:"baudRate,omitempty"`
		APILevel      int    `json:"apiLevel,omitempty"`
		Host          string `json:"host"`
		Port          int    `json:"port"`
		Label         string `json:"label"`
		TimerID       uint8  `json:"timerId"`
		Connected     bool   `json:"connected"`
		NodeCount     int    `json:"nodeCount"`
		ServerVersion string `json:"serverVersion"`
		Verified      bool   `json:"verified"`
	}
	units := s.simulator.DiscoverSimRotorHazardUnits()
	devices := make([]discoveredRHItem, 0, len(units))
	for _, u := range units {
		devices = append(devices, discoveredRHItem{
			Transport:     u.Transport,
			PortName:      u.PortName,
			BaudRate:      u.BaudRate,
			APILevel:      u.APILevel,
			Host:          u.Host,
			Port:          u.Port,
			Label:         u.Label,
			TimerID:       u.TimerID,
			Connected:     u.Connected,
			NodeCount:     u.NodeCount,
			ServerVersion: u.ServerVersion,
			Verified:      true,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"subnet":  "192.168.1.0/24 (Simulated LAN)",
		"devices": devices,
	})
}

func (s *Server) handleSimMultiGPWebService(w http.ResponseWriter, r *http.Request) {
	s.simulator.SyncMultiGPPilotPool()
	subPath := strings.TrimPrefix(r.URL.Path, "/api/sim/mgp/")
	s.simulator.MultiGPBackend().ServeWebServiceHTTP(w, r, subPath)
}

func (s *Server) handleSimMultiGPAdmin(w http.ResponseWriter, r *http.Request) {
	s.simulator.SyncMultiGPPilotPool()
	backend := s.simulator.MultiGPBackend()
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, backend.ExportState())
	case http.MethodPost:
		var req multigp.SimAdminAction
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		updated, err := backend.ApplyAdminAction(req)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, http.StatusOK, updated)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleMultiGPImportRace(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Race       multigp.RaceViewData `json:"race"`
		ImportMode string               `json:"importMode"` // "schedule" | "zippyq" | "bracket"
		TemplateID string               `json:"templateId,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	created, err := s.activeEngine().ImportMultiGPRace(body.Race, body.ImportMode, body.TemplateID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if s.simulator.IsRunning() {
		s.simulator.SyncMultiGPPilotPool()
	}
	eng := s.activeEngine()
	pilots, gates, laps, crossings, summaries := eng.StateSnapshot()
	var simState *domain.SimState
	var simMGP *multigp.SimPersistedState
	if s.simulator.IsRunning() {
		snap := s.simulator.Snapshot()
		simState = &snap
		mgpExp := s.simulator.MultiGPBackend().ExportState()
		simMGP = &mgpExp
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"createdRace": created,
		"state": FullStateResponse{
			ServerTimestampUs:  eng.NowUs(),
			TimingHardwareMode: eng.TimingHardwareMode(),
			Pilots:             pilots,
			Gates:              gates,
			Timers:             eng.DetectedTimersSnapshot(),
			Laps:               laps,
			Crossings:          crossings,
			Filtered:           eng.FilteredSnapshot(),
			Summaries:          summaries,
			Rules:              eng.Rules(),
			SimulatorRun:       s.simulator.IsRunning(),
			SimState:           simState,
			SimMultiGP:         simMGP,
			RaceArmed:          eng.IsRaceArmed(),
			LiveTimeStatus:     s.laprfServer.Status(),
			RaceState:          eng.RaceSnapshot(),
			EventState:         eng.EventSnapshot(),
			PracticeState:      eng.PracticeSnapshot(),
		},
	})
}

func (s *Server) handleMultiGPAppendZippyQ(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		RaceID string                  `json:"raceId"`
		Rounds []multigp.ScheduleRound `json:"rounds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	updatedRace, added, err := s.activeEngine().AppendMultiGPZippyQRounds(body.RaceID, body.Rounds)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"addedHeats": added,
		"raceState":  updatedRace,
		"eventState": s.activeEngine().EventSnapshot(),
	})
}

func (s *Server) handleMultiGPSyncPlan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		RaceID   string `json:"raceId"`
		ForceAll bool   `json:"forceAll"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	plan, err := s.activeEngine().BuildMultiGPSyncPlan(body.RaceID, body.ForceAll)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, plan)
}

func (s *Server) handleMultiGPMarkSynced(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body tracker.MultiGPMarkSyncedParams
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if _, err := s.activeEngine().MarkMultiGPSynced(body.RaceID, body.SyncedHeatIDs, body.OverallSynced, body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.handleGetState(w, r)
}

func (s *Server) handleMultiGPImportPilots(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Pilots []multigp.RaceEntry `json:"pilots"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	summary, err := s.activeEngine().ImportMultiGPPilots(body.Pilots)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if s.simulator.IsRunning() {
		s.simulator.SyncMultiGPPilotPool()
	}
	resp := s.buildFullStateResponse()
	resp.ImportSummary = &summary
	writeJSON(w, http.StatusOK, resp)
}
