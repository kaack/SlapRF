package api

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"slaprf/internal/domain"
	"slaprf/internal/ingest"
	"slaprf/internal/multigp"
	"slaprf/internal/tracker"
)

// --- Hardware Mode Singleton & RotorHazard Debug Stream Singleton ---

func (s *Server) handleGetHardwareMode(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]domain.TimingHardwareMode{
		"mode": s.activeEngine().TimingHardwareMode(),
	})
}

func (s *Server) handlePutHardwareMode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode domain.TimingHardwareMode `json:"mode"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	isSim := s.simulator.IsRunning()
	s.activeEngine().SetRHDebugStream(0, false)
	if isSim {
		_ = s.simulator.SetRHUSBScanLive(0, false, 0, 0, 0)
	}
	s.activeEngine().SetTimingHardwareMode(body.Mode, isSim)
	if isSim {
		s.simulator.SyncHardwareMode()
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handlePutRHDebugStream(w http.ResponseWriter, r *http.Request) {
	rawTimerID := strings.TrimSpace(r.PathValue("timerId"))
	if !rejectColonInPathValue(w, rawTimerID) {
		return
	}
	tidInt, err := strconv.Atoi(rawTimerID)
	if err != nil || tidInt < 0 || tidInt > 255 {
		writeErrorJSON(w, http.StatusBadRequest, fmt.Sprintf("invalid timerId %q", rawTimerID))
		return
	}
	timerID := uint8(tidInt)

	var body struct {
		Active bool `json:"active"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.Active && s.simulator.IsRunning() {
		_ = s.simulator.SetRHUSBScanLive(timerID, false, 0, 0, 0)
	}
	s.activeEngine().SetRHDebugStream(timerID, body.Active)
	if s.simulator.IsRunning() {
		s.simulator.SyncRHNodesNow()
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- MultiGP Race Sync (`/v1/race/sessions:importMultiGP`, `/v1/race/sessions/{sessionId}/multigp...`) ---

func (s *Server) handleMultiGPImportRace(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Race       multigp.RaceViewData `json:"race"`
		ImportMode string               `json:"importMode"` // "schedule" | "zippyq" | "bracket"
		TemplateID string               `json:"templateId,omitempty"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	created, err := s.activeEngine().ImportMultiGPRace(body.Race, body.ImportMode, body.TemplateID)
	if err != nil {
		writeEngineError(w, err)
		return
	}
	if s.simulator.IsRunning() {
		s.simulator.SyncMultiGPPilotPool()
	}
	if created.RaceID != "" {
		w.Header().Set("Location", "/v1/race/sessions/"+created.RaceID)
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"createdRace": created,
		"state":       s.buildFullStateResponse(),
	})
}

func (s *Server) handleMultiGPAppendZippyQ(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("sessionId")
	eng := s.activeEngine()
	targetRaceID, ok := resolveRaceTargetID(w, eng, rawID)
	if !ok {
		return
	}
	var body struct {
		Rounds []multigp.ScheduleRound `json:"rounds"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	updatedRace, added, err := eng.AppendMultiGPZippyQRounds(targetRaceID, body.Rounds)
	if err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"addedHeats": added,
		"raceState":  updatedRace,
		"eventState": eng.EventSnapshot(),
	})
}

func (s *Server) handleMultiGPSyncPlan(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("sessionId")
	eng := s.activeEngine()
	targetRaceID, ok := resolveRaceTargetID(w, eng, rawID)
	if !ok {
		return
	}
	forceAll := r.URL.Query().Get("forceAll") == "1" || strings.EqualFold(r.URL.Query().Get("forceAll"), "true")
	plan, err := eng.BuildMultiGPSyncPlan(targetRaceID, forceAll)
	if err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, plan)
}

func (s *Server) handleMultiGPMarkSynced(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("sessionId")
	eng := s.activeEngine()
	targetRaceID, ok := resolveRaceTargetID(w, eng, rawID)
	if !ok {
		return
	}
	var body tracker.MultiGPMarkSyncedParams
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if targetRaceID != "" {
		body.RaceID = targetRaceID
	}
	if _, err := eng.MarkMultiGPSynced(body.RaceID, body.SyncedHeatIDs, body.OverallSynced, body); err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

// --- Simulator Singleton & Sub-resources (`/v1/sim`) ---

func (s *Server) handleGetSim(w http.ResponseWriter, _ *http.Request) {
	snap := s.simulator.Snapshot()
	writeJSON(w, http.StatusOK, map[string]any{
		"running":  s.simulator.IsRunning(),
		"simState": snap,
	})
}

func (s *Server) handlePatchSim(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Running         *bool `json:"running,omitempty"`
		SpeedMultiplier *int  `json:"speedMultiplier,omitempty"`
		TrackWalker     *bool `json:"trackWalker,omitempty"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.Running != nil && s.simulator.IsRunning() != *body.Running {
		s.simulator.SetRunning(*body.Running)
		if s.hooks.OnModeChanged != nil {
			s.hooks.OnModeChanged(*body.Running)
		}
	}
	if body.SpeedMultiplier != nil {
		s.simulator.SetSpeedMultiplier(*body.SpeedMultiplier)
	}
	if body.TrackWalker != nil {
		s.simulator.SetTrackWalker(*body.TrackWalker)
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleSimPackBurst(w http.ResponseWriter, r *http.Request) {
	if err := decodeOptionalJSONBody(r, &struct{}{}); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	s.simulator.TriggerPackBurst()
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

// handleSimPilotCustomAction serves `POST /v1/sim/pilots/{slotIndex}:action`.
func (s *Server) handleSimPilotCustomAction(w http.ResponseWriter, r *http.Request) {
	rawSlot, customVerb, ok := cutCustomActionPathValue(w, r, "slotIndex", "")
	if !ok {
		return
	}
	if customVerb != "action" {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("unknown simulated pilot custom method %q", customVerb))
		return
	}
	slotIndex, ok := parsePositiveIntString(w, "slotIndex", rawSlot)
	if !ok {
		return
	}
	var body struct {
		Action string `json:"action"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	s.simulator.TriggerPilotAction(slotIndex, body.Action)
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleCreateSimTimer(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Role  string `json:"role,omitempty"`
		Label string `json:"label,omitempty"`
	}
	if err := decodeOptionalJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	createdID, err := s.simulator.AddTimer(body.Role, body.Label)
	if err != nil {
		writeEngineError(w, err)
		return
	}
	w.Header().Set("Location", fmt.Sprintf("/v1/sim/slaprf/timers/%d", createdID))
	writeJSON(w, http.StatusCreated, s.buildFullStateResponse())
}

func (s *Server) handleResetSimTimers(w http.ResponseWriter, r *http.Request) {
	if err := decodeOptionalJSONBody(r, &struct{}{}); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	s.simulator.ResetTimersAndTrackToDefault()
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

// handlePatchSimTimer updates stored diagnostic state on a simulated timer (`PATCH /v1/sim/slaprf/timers/{timerId}`).
func (s *Server) handlePatchSimTimer(w http.ResponseWriter, r *http.Request) {
	timerID, ok := parseUint8PathValue(w, r, "timerId")
	if !ok {
		return
	}
	var body struct {
		Diag *struct {
			RFEnabled     bool  `json:"rfEnabled"`
			EmergencyMode bool  `json:"emergencyMode"`
			ScanLive      bool  `json:"scanLive"`
			ChanMask      uint8 `json:"chanMask"`
		} `json:"diag,omitempty"`
		RFEnabled     *bool  `json:"rfEnabled,omitempty"`
		EmergencyMode *bool  `json:"emergencyMode,omitempty"`
		ScanLive      *bool  `json:"scanLive,omitempty"`
		ChanMask      *uint8 `json:"chanMask,omitempty"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.Diag != nil {
		s.simulator.SetTimerDiagState(timerID, body.Diag.RFEnabled, body.Diag.EmergencyMode, body.Diag.ScanLive, body.Diag.ChanMask)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	if body.RFEnabled != nil && body.EmergencyMode != nil && body.ScanLive != nil && body.ChanMask != nil {
		s.simulator.SetTimerDiagState(timerID, *body.RFEnabled, *body.EmergencyMode, *body.ScanLive, *body.ChanMask)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	writeErrorJSON(w, http.StatusBadRequest, "PATCH /v1/sim/slaprf/timers/{timerId} expects diagnostic fields; use POST /v1/sim/slaprf/timers/{timerId}:action for imperative board actions")
}

// handleSimTimerCustomAction serves `POST /v1/sim/slaprf/timers/{timerId}:action` (or `:togglePower`, `:erase`, `:flash`).
func (s *Server) handleSimTimerCustomAction(w http.ResponseWriter, r *http.Request) {
	rawTimerID, customVerb, ok := cutCustomActionPathValue(w, r, "timerId", "PATCH, DELETE")
	if !ok {
		return
	}
	timerID, ok := parseUint8String(w, "timerId", rawTimerID)
	if !ok {
		return
	}
	var body struct {
		Action          string `json:"action,omitempty"`
		Role            string `json:"role,omitempty"`
		Label           string `json:"label,omitempty"`
		Fingerprint     string `json:"fingerprint,omitempty"`
		FirmwareVersion string `json:"firmwareVersion,omitempty"`
	}
	if err := decodeOptionalJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	op := strings.TrimSpace(body.Action)
	switch customVerb {
	case "togglePower":
		op = "toggle-power"
	case "erase":
		op = "erase"
	case "flash":
		op = "flash"
	case "action":
	default:
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("unknown simulated timer custom method %q", customVerb))
		return
	}
	switch op {
	case "toggle-power":
		s.simulator.ToggleTimerPower(timerID)
	case "erase":
		if err := s.simulator.EraseBoard(timerID); err != nil {
			writeEngineError(w, err)
			return
		}
	case "flash":
		if err := s.simulator.FlashBoard(timerID, body.Role, body.Label, body.Fingerprint, body.FirmwareVersion); err != nil {
			writeEngineError(w, err)
			return
		}
	default:
		writeErrorJSON(w, http.StatusBadRequest, fmt.Sprintf("unknown simulated timer action %q", op))
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleDeleteSimTimer(w http.ResponseWriter, r *http.Request) {
	timerID, ok := parseUint8PathValue(w, r, "timerId")
	if !ok {
		return
	}
	if err := s.simulator.DeleteTimer(timerID); err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleGetSimTimerRSSI(w http.ResponseWriter, r *http.Request) {
	timerID, ok := parseUint8PathValue(w, r, "timerId")
	if !ok {
		return
	}
	rssi, found := s.simulator.TimerRSSI(timerID)
	if !found {
		writeJSON(w, http.StatusOK, map[string]any{"rssi": nil})
		return
	}
	out := make([]float32, len(rssi))
	copy(out, rssi[:])
	writeJSON(w, http.StatusOK, map[string]any{"rssi": out})
}

func (s *Server) handleSimUSBHellos(w http.ResponseWriter, _ *http.Request) {
	raw := s.simulator.BuildHubHelloStream()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.WriteHeader(http.StatusOK)
	if len(raw) > 0 {
		_, _ = w.Write(raw)
	}
}

func (s *Server) handleSimLapRFDiscover(w http.ResponseWriter, _ *http.Request) {
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

func (s *Server) handleCreateSimLapRFUnit(w http.ResponseWriter, r *http.Request) {
	var req ingest.SimLapRFActionRequest
	if err := decodeOptionalJSONBody(r, &req); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Action == "" {
		if strings.TrimSpace(req.Host) != "" {
			req.Action = "connect-host"
		} else {
			req.Action = "add"
		}
	}
	if _, err := s.simulator.ApplyLapRFAction(req); err != nil {
		writeEngineError(w, err)
		return
	}
	w.Header().Set("Location", "/v1/sim/laprf/timers")
	writeJSON(w, http.StatusCreated, s.buildFullStateResponse())
}

func (s *Server) handleResetSimLapRFUnits(w http.ResponseWriter, r *http.Request) {
	if err := decodeOptionalJSONBody(r, &struct{}{}); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := s.simulator.ApplyLapRFAction(ingest.SimLapRFActionRequest{Action: "reset"}); err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handlePatchSimLapRFUnit(w http.ResponseWriter, r *http.Request) {
	timerID, ok := parseUint8PathValue(w, r, "timerId")
	if !ok {
		return
	}
	var req ingest.SimLapRFActionRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	req.TimerID = timerID
	req.Action = "update"
	if _, err := s.simulator.ApplyLapRFAction(req); err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleSimLapRFUnitCustomAction(w http.ResponseWriter, r *http.Request) {
	rawTimerID, customVerb, ok := cutCustomActionPathValue(w, r, "timerId", "PATCH, DELETE")
	if !ok {
		return
	}
	if customVerb != "action" {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("unknown simulated LapRF custom method %q", customVerb))
		return
	}
	timerID, ok := parseUint8String(w, "timerId", rawTimerID)
	if !ok {
		return
	}
	var req ingest.SimLapRFActionRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	req.TimerID = timerID
	if _, err := s.simulator.ApplyLapRFAction(req); err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleDeleteSimLapRFUnit(w http.ResponseWriter, r *http.Request) {
	timerID, ok := parseUint8PathValue(w, r, "timerId")
	if !ok {
		return
	}
	if _, err := s.simulator.ApplyLapRFAction(ingest.SimLapRFActionRequest{
		Action:  "delete",
		TimerID: timerID,
	}); err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleSimRHDiscover(w http.ResponseWriter, _ *http.Request) {
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

func (s *Server) handleCreateSimRHUnit(w http.ResponseWriter, r *http.Request) {
	var req ingest.SimRotorHazardActionRequest
	if err := decodeOptionalJSONBody(r, &req); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Action == "" {
		if strings.TrimSpace(req.PortName) != "" {
			req.Action = "connect-port"
		} else if strings.TrimSpace(req.Host) != "" {
			req.Action = "connect-host"
		} else {
			req.Action = "add"
		}
	}
	if _, err := s.simulator.ApplyRotorHazardAction(req); err != nil {
		writeEngineError(w, err)
		return
	}
	w.Header().Set("Location", "/v1/sim/rotorhazard/timers")
	writeJSON(w, http.StatusCreated, s.buildFullStateResponse())
}

func (s *Server) handleResetSimRHUnits(w http.ResponseWriter, r *http.Request) {
	if err := decodeOptionalJSONBody(r, &struct{}{}); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := s.simulator.ApplyRotorHazardAction(ingest.SimRotorHazardActionRequest{Action: "reset"}); err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handlePatchSimRHUnit(w http.ResponseWriter, r *http.Request) {
	timerID, ok := parseUint8PathValue(w, r, "timerId")
	if !ok {
		return
	}
	var req ingest.SimRotorHazardActionRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	req.TimerID = timerID
	req.Action = "update"
	if _, err := s.simulator.ApplyRotorHazardAction(req); err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

// handleSimRHUnitCustomAction serves `POST /v1/sim/rotorhazard/timers/{timerId}:{action|scan}`.
func (s *Server) handleSimRHUnitCustomAction(w http.ResponseWriter, r *http.Request) {
	rawTimerID, customVerb, ok := cutCustomActionPathValue(w, r, "timerId", "PATCH, DELETE")
	if !ok {
		return
	}
	timerID, ok := parseUint8String(w, "timerId", rawTimerID)
	if !ok {
		return
	}

	switch customVerb {
	case "action":
		var req ingest.SimRotorHazardActionRequest
		if err := decodeJSONBody(r, &req); err != nil {
			writeErrorJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		req.TimerID = timerID
		if _, err := s.simulator.ApplyRotorHazardAction(req); err != nil {
			writeEngineError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, s.buildFullStateResponse())

	case "scan":
		var body struct {
			Mode  string `json:"mode"` // "once" | "live" | "stop"
			Start int    `json:"start"`
			Stop  int    `json:"stop"`
			Step  int    `json:"step"`
		}
		if err := decodeJSONBody(r, &body); err != nil {
			writeErrorJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		if !s.simulator.IsRunning() {
			writeErrorJSON(w, http.StatusConflict, "simulator is not running (use POST /v1/rotorhazard/connections/{timerId}:scan for physical RotorHazard USB devices)")
			return
		}
		mode := strings.ToLower(strings.TrimSpace(body.Mode))
		switch mode {
		case "once":
			pass, err := s.simulator.RunRHUSBScanOnce(timerID, body.Start, body.Stop, body.Step)
			if err != nil {
				writeEngineError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "scan": pass})
		case "live":
			if err := s.simulator.SetRHUSBScanLive(timerID, true, body.Start, body.Stop, body.Step); err != nil {
				writeEngineError(w, err)
				return
			}
			s.activeEngine().SetRHDebugStream(timerID, false)
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "scanLive": true})
		case "stop":
			if err := s.simulator.SetRHUSBScanLive(timerID, false, body.Start, body.Stop, body.Step); err != nil {
				writeEngineError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "scanLive": false})
		default:
			writeErrorJSON(w, http.StatusBadRequest, "invalid scan mode (expected once, live, or stop)")
		}

	default:
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("unknown simulated RotorHazard custom method %q", customVerb))
	}
}

func (s *Server) handleDeleteSimRHUnit(w http.ResponseWriter, r *http.Request) {
	timerID, ok := parseUint8PathValue(w, r, "timerId")
	if !ok {
		return
	}
	if _, err := s.simulator.ApplyRotorHazardAction(ingest.SimRotorHazardActionRequest{
		Action:  "delete",
		TimerID: timerID,
	}); err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleSimMultiGPWebService(w http.ResponseWriter, r *http.Request) {
	s.simulator.SyncMultiGPPilotPool()
	subPath := r.PathValue("subPath")
	if subPath == "" {
		subPath = strings.TrimPrefix(r.URL.Path, "/v1/sim/multigp/")
	}
	s.simulator.MultiGPBackend().ServeWebServiceHTTP(w, r, subPath)
}

func (s *Server) handleGetSimMultiGPAdmin(w http.ResponseWriter, _ *http.Request) {
	s.simulator.SyncMultiGPPilotPool()
	writeJSON(w, http.StatusOK, s.simulator.MultiGPBackend().ExportState())
}

func (s *Server) handleSimMultiGPAdminAction(w http.ResponseWriter, r *http.Request) {
	s.simulator.SyncMultiGPPilotPool()
	var req multigp.SimAdminAction
	if err := decodeJSONBody(r, &req); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	updated, err := s.simulator.MultiGPBackend().ApplyAdminAction(req)
	if err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}
