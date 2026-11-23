package api

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"slaprf/internal/domain"
	"slaprf/internal/multigp"
	"slaprf/internal/tracker"
)

// --- Pilots Collection, Items & Custom Operations (`/v1/pilots`, `/v1/pilots:reset`, `/v1/pilots:import`) ---

func (s *Server) handleGetPilots(w http.ResponseWriter, r *http.Request) {
	if strings.EqualFold(r.URL.Query().Get("format"), "csv") || strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/csv") {
		s.handleExportPilotsCSV(w, r)
		return
	}
	pilots, _, _, _, _ := s.activeEngine().StateSnapshot()
	if pilots == nil {
		pilots = []domain.PilotSlot{}
	}
	writeJSON(w, http.StatusOK, pilots)
}

func (s *Server) handleGetPilot(w http.ResponseWriter, r *http.Request) {
	slotIndex, ok := parsePositiveIntPathValue(w, r, "slotIndex")
	if !ok {
		return
	}
	pilots, _, _, _, _ := s.activeEngine().StateSnapshot()
	for _, p := range pilots {
		if p.SlotIndex == slotIndex {
			writeJSON(w, http.StatusOK, p)
			return
		}
	}
	writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("pilot slot %d not found", slotIndex))
}

func (s *Server) handleCreatePilot(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Callsign     string `json:"callsign"`
		PhoneticName string `json:"phoneticName"`
	}
	if err := decodeOptionalJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	eng := s.activeEngine()
	if err := eng.AddPilot(body.Callsign, body.PhoneticName); err != nil {
		writeEngineError(w, err)
		return
	}
	state := s.buildFullStateResponse()
	createdSlot := 0
	for _, p := range state.Pilots {
		if p.SlotIndex > createdSlot {
			createdSlot = p.SlotIndex
		}
	}
	if createdSlot > 0 {
		w.Header().Set("Location", fmt.Sprintf("/v1/pilots/%d", createdSlot))
	}
	writeJSON(w, http.StatusCreated, state)
}

func (s *Server) handleResetPilots(w http.ResponseWriter, r *http.Request) {
	if err := decodeOptionalJSONBody(r, &struct{}{}); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	s.activeEngine().ResetPilotsToDefault(s.simulator.IsRunning())
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleUpdatePilot(w http.ResponseWriter, r *http.Request) {
	slotIndex, ok := parsePositiveIntPathValue(w, r, "slotIndex")
	if !ok {
		return
	}
	var slot domain.PilotSlot
	if err := decodeJSONBody(r, &slot); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	slot.SlotIndex = slotIndex

	eng := s.activeEngine()
	pilots, _, _, _, _ := eng.StateSnapshot()
	exists := false
	for _, p := range pilots {
		if p.SlotIndex == slotIndex {
			exists = true
			break
		}
	}
	if !exists {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("pilot slot %d not found", slotIndex))
		return
	}

	if slot.Channel == 0 {
		slot.FrequencyMHz = 0
	} else {
		if slot.Band == 0 {
			slot.Band = domain.BandRaceband
		}
		if freq := domain.FrequencyForBandChannel(slot.Band, slot.Channel); freq > 0 {
			slot.FrequencyMHz = freq
		}
	}
	if slot.ExitThreshold == 0 {
		slot.ExitThreshold = slot.EnterThreshold - 10.0
	} else if slot.ExitThreshold > slot.EnterThreshold-domain.MinHysteresisGapDb {
		slot.ExitThreshold = slot.EnterThreshold - domain.MinHysteresisGapDb
	}
	if err := eng.UpdatePilotSlot(slot); err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleDeletePilot(w http.ResponseWriter, r *http.Request) {
	slotIndex, ok := parsePositiveIntPathValue(w, r, "slotIndex")
	if !ok {
		return
	}
	if err := s.activeEngine().RemovePilot(slotIndex); err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleExportPilotsCSV(w http.ResponseWriter, _ *http.Request) {
	csvBody := s.activeEngine().ExportPilotsCSV()
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="slaprf-pilots.csv"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(csvBody))
}

func (s *Server) handleImportPilots(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CSV    *string             `json:"csv,omitempty"`
		Pilots []multigp.RaceEntry `json:"pilots,omitempty"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	var (
		summary domain.PilotCSVImportSummary
		err     error
	)
	if body.CSV != nil {
		summary, err = s.activeEngine().ImportPilotsCSV(*body.CSV)
	} else if body.Pilots != nil {
		summary, err = s.activeEngine().ImportMultiGPPilots(body.Pilots)
		if err == nil && s.simulator.IsRunning() {
			s.simulator.SyncMultiGPPilotPool()
		}
	} else {
		writeErrorJSON(w, http.StatusBadRequest, "request body must specify 'csv' or 'pilots'")
		return
	}
	if err != nil {
		writeEngineError(w, err)
		return
	}
	resp := s.buildFullStateResponse()
	resp.ImportSummary = &summary
	writeJSON(w, http.StatusOK, resp)
}

// --- Practice Sessions Resource Hierarchy (`/v1/practice/sessions`) ---

func resolvePracticeSession(eng *tracker.Engine, rawID string) (*domain.PracticeSession, string) {
	snap := eng.PracticeSnapshot()
	id := strings.TrimSpace(rawID)
	if id == "" || strings.EqualFold(id, "current") {
		id = snap.SelectedSessionID
		if id == "" {
			id = snap.ActiveSessionID
		}
	}
	if id == "" {
		return nil, ""
	}
	for i := range snap.Sessions {
		if snap.Sessions[i].SessionID == id {
			cp := snap.Sessions[i]
			return &cp, id
		}
	}
	return nil, ""
}

func (s *Server) handleGetPracticeSessions(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.activeEngine().PracticeSnapshot())
}

func (s *Server) handleGetPracticeSession(w http.ResponseWriter, r *http.Request) {
	rawID := strings.TrimSpace(r.PathValue("sessionId"))
	if !rejectColonInPathValue(w, rawID) {
		return
	}
	sess, _ := resolvePracticeSession(s.activeEngine(), rawID)
	if sess == nil {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("practice session %q not found", rawID))
		return
	}
	writeJSON(w, http.StatusOK, sess)
}

func (s *Server) handleCreatePracticeSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name       string   `json:"name,omitempty"`
		Tags       []string `json:"tags,omitempty"`
		DontSelect bool     `json:"dontSelect,omitempty"`
	}
	if err := decodeOptionalJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	ps, err := s.activeEngine().PracticeAction(tracker.PracticeActionPayload{
		Action:     "create_session",
		Name:       body.Name,
		Tags:       body.Tags,
		DontSelect: body.DontSelect,
	})
	if err != nil {
		writeEngineError(w, err)
		return
	}
	if n := len(ps.Sessions); n > 0 {
		createdID := ps.Sessions[n-1].SessionID
		w.Header().Set("Location", "/v1/practice/sessions/"+createdID)
	}
	writeJSON(w, http.StatusCreated, s.buildFullStateResponse())
}

// handlePatchPracticeSession updates stored practice session attributes (`name`, `tags`, `selected`).
// Imperative lifecycle operations use `POST /v1/practice/sessions/{sessionId}:{start|resume|pause|stop|clearLaps}`.
func (s *Server) handlePatchPracticeSession(w http.ResponseWriter, r *http.Request) {
	rawID := strings.TrimSpace(r.PathValue("sessionId"))
	if !rejectColonInPathValue(w, rawID) {
		return
	}
	eng := s.activeEngine()
	sess, targetID := resolvePracticeSession(eng, rawID)
	if sess == nil {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("practice session %q not found", rawID))
		return
	}

	var body struct {
		Name     *string   `json:"name,omitempty"`
		Tags     *[]string `json:"tags,omitempty"`
		Selected *bool     `json:"selected,omitempty"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}

	if body.Name != nil {
		if _, err := eng.PracticeAction(tracker.PracticeActionPayload{
			Action:    "rename_session",
			SessionID: targetID,
			Name:      *body.Name,
		}); err != nil {
			writeEngineError(w, err)
			return
		}
	}
	if body.Tags != nil {
		if _, err := eng.PracticeAction(tracker.PracticeActionPayload{
			Action:    "set_session_tags",
			SessionID: targetID,
			Tags:      *body.Tags,
		}); err != nil {
			writeEngineError(w, err)
			return
		}
	}
	if body.Selected != nil && *body.Selected {
		if _, err := eng.PracticeAction(tracker.PracticeActionPayload{
			Action:    "select_session",
			SessionID: targetID,
		}); err != nil {
			writeEngineError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

// handlePracticeSessionCustomAction serves `POST /v1/practice/sessions/{sessionId}:{start|resume|pause|stop|clearLaps}`.
func (s *Server) handlePracticeSessionCustomAction(w http.ResponseWriter, r *http.Request) {
	rawID, customVerb, ok := cutCustomActionPathValue(w, r, "sessionId", "GET, HEAD, PATCH, DELETE")
	if !ok {
		return
	}
	eng := s.activeEngine()
	sess, targetID := resolvePracticeSession(eng, rawID)
	if sess == nil {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("practice session %q not found", rawID))
		return
	}

	var body struct {
		PreemptOngoing bool `json:"preemptOngoing,omitempty"`
	}
	if err := decodeOptionalJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}

	var engineAction string
	switch customVerb {
	case "start":
		engineAction = "start_session"
	case "resume":
		engineAction = "resume_session"
	case "pause":
		engineAction = "pause_session"
	case "stop":
		engineAction = "stop_session"
	case "clearLaps":
		engineAction = "clear_session_laps"
	default:
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("unknown practice session custom method %q", customVerb))
		return
	}

	if _, err := eng.PracticeAction(tracker.PracticeActionPayload{
		Action:         engineAction,
		SessionID:      targetID,
		PreemptOngoing: body.PreemptOngoing,
	}); err != nil {
		writeEngineError(w, err)
		return
	}
	if (engineAction == "start_session" || engineAction == "resume_session" || (engineAction == "clear_session_laps" && eng.IsRaceArmed())) && s.hooks.OnTimingStarted != nil {
		s.hooks.OnTimingStarted()
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleDeletePracticeSession(w http.ResponseWriter, r *http.Request) {
	rawID := strings.TrimSpace(r.PathValue("sessionId"))
	if !rejectColonInPathValue(w, rawID) {
		return
	}
	if _, err := s.activeEngine().PracticeAction(tracker.PracticeActionPayload{
		Action:    "delete_session",
		SessionID: rawID,
	}); err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleGetPracticeSessionPilots(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("sessionId")
	sess, _ := resolvePracticeSession(s.activeEngine(), rawID)
	if sess == nil {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("practice session %q not found", rawID))
		return
	}
	writeJSON(w, http.StatusOK, sess.Pilots)
}

func (s *Server) handleAddPracticeSessionPilot(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("sessionId")
	eng := s.activeEngine()
	sess, targetID := resolvePracticeSession(eng, rawID)
	if sess == nil {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("practice session %q not found", rawID))
		return
	}
	var body struct {
		SlotIndex    int         `json:"slotIndex,omitempty"`
		Callsign     string      `json:"callsign,omitempty"`
		PhoneticName string      `json:"phoneticName,omitempty"`
		Band         domain.Band `json:"band,omitempty"`
		Channel      uint8       `json:"channel,omitempty"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	ps, err := eng.PracticeAction(tracker.PracticeActionPayload{
		Action:       "add_session_pilot",
		SessionID:    targetID,
		SlotIndex:    body.SlotIndex,
		Callsign:     body.Callsign,
		PhoneticName: body.PhoneticName,
		Band:         body.Band,
		Channel:      body.Channel,
	})
	if err != nil {
		writeEngineError(w, err)
		return
	}
	assignedSlot := body.SlotIndex
	if assignedSlot <= 0 {
		for _, item := range ps.Sessions {
			if item.SessionID == targetID && len(item.Pilots) > 0 {
				assignedSlot = item.Pilots[len(item.Pilots)-1].SlotIndex
				break
			}
		}
	}
	if assignedSlot > 0 {
		w.Header().Set("Location", fmt.Sprintf("/v1/practice/sessions/%s/pilots/%d", targetID, assignedSlot))
	}
	writeJSON(w, http.StatusCreated, s.buildFullStateResponse())
}

func (s *Server) handleUpdatePracticeSessionPilot(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("sessionId")
	slotIndex, ok := parsePositiveIntPathValue(w, r, "slotIndex")
	if !ok {
		return
	}
	eng := s.activeEngine()
	sess, targetID := resolvePracticeSession(eng, rawID)
	if sess == nil {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("practice session %q not found", rawID))
		return
	}
	var body struct {
		Band    domain.Band `json:"band,omitempty"`
		Channel uint8       `json:"channel"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := eng.PracticeAction(tracker.PracticeActionPayload{
		Action:    "set_session_pilot_channel",
		SessionID: targetID,
		SlotIndex: slotIndex,
		Band:      body.Band,
		Channel:   body.Channel,
	}); err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleDeletePracticeSessionPilot(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("sessionId")
	slotIndex, ok := parsePositiveIntPathValue(w, r, "slotIndex")
	if !ok {
		return
	}
	eng := s.activeEngine()
	sess, targetID := resolvePracticeSession(eng, rawID)
	if sess == nil {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("practice session %q not found", rawID))
		return
	}
	inSession := false
	for _, p := range sess.Pilots {
		if p.SlotIndex == slotIndex {
			inSession = true
			break
		}
	}
	if !inSession {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("pilot slot %d is not in practice session %q", slotIndex, targetID))
		return
	}
	if _, err := eng.PracticeAction(tracker.PracticeActionPayload{
		Action:    "remove_session_pilot",
		SessionID: targetID,
		SlotIndex: slotIndex,
	}); err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleGetPracticeSessionLaps(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("sessionId")
	sess, _ := resolvePracticeSession(s.activeEngine(), rawID)
	if sess == nil {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("practice session %q not found", rawID))
		return
	}
	writeJSON(w, http.StatusOK, sess.Laps)
}

func (s *Server) handleResetActivePracticeLaps(w http.ResponseWriter, r *http.Request) {
	if err := decodeOptionalJSONBody(r, &struct{}{}); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	eng := s.activeEngine()
	eng.ResetSession()
	if eng.IsRaceArmed() && s.hooks.OnTimingStarted != nil {
		s.hooks.OnTimingStarted()
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handlePatchPracticeSessionLap(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("sessionId")
	lapID, ok := parseUint64PathValue(w, r, "lapId")
	if !ok {
		return
	}
	eng := s.activeEngine()
	sess, targetID := resolvePracticeSession(eng, rawID)
	if sess == nil {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("practice session %q not found", rawID))
		return
	}
	var body struct {
		Invalidated *bool `json:"invalidated"`
	}
	if err := decodeJSONBody(r, &body); err != nil || body.Invalidated == nil {
		writeErrorJSON(w, http.StatusBadRequest, "request body must specify boolean field 'invalidated'")
		return
	}

	var curLap *domain.LapRecord
	for i := range sess.Laps {
		if sess.Laps[i].LapID == lapID {
			curLap = &sess.Laps[i]
			break
		}
	}
	if curLap == nil {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("lap %d not found in practice session %q", lapID, targetID))
		return
	}

	if curLap.Invalidated != *body.Invalidated {
		if _, err := eng.PracticeAction(tracker.PracticeActionPayload{
			Action:    "toggle_session_lap",
			SessionID: targetID,
			LapID:     lapID,
		}); err != nil {
			writeEngineError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

// handlePracticeSessionLapCustomAction serves `POST /v1/practice/sessions/{sessionId}/laps/{lapId}:toggle`.
func (s *Server) handlePracticeSessionLapCustomAction(w http.ResponseWriter, r *http.Request) {
	rawSessionID := r.PathValue("sessionId")
	rawLapID, customVerb, ok := cutCustomActionPathValue(w, r, "lapId", "PATCH")
	if !ok {
		return
	}
	if customVerb != "toggle" {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("unknown lap custom method %q", customVerb))
		return
	}
	lapID, err := strconv.ParseUint(rawLapID, 10, 64)
	if err != nil || lapID == 0 {
		writeErrorJSON(w, http.StatusBadRequest, fmt.Sprintf("invalid lapId %q", rawLapID))
		return
	}
	if err := decodeOptionalJSONBody(r, &struct{}{}); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	eng := s.activeEngine()
	sess, targetID := resolvePracticeSession(eng, rawSessionID)
	if sess == nil {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("practice session %q not found", rawSessionID))
		return
	}
	if _, err := eng.PracticeAction(tracker.PracticeActionPayload{
		Action:    "toggle_session_lap",
		SessionID: targetID,
		LapID:     lapID,
	}); err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

// handleDeletePracticeSessionLap serves `DELETE /v1/practice/sessions/{sessionId}/laps/{lapId}`.
func (s *Server) handleDeletePracticeSessionLap(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("sessionId")
	lapID, ok := parseUint64PathValue(w, r, "lapId")
	if !ok {
		return
	}
	eng := s.activeEngine()
	sess, targetID := resolvePracticeSession(eng, rawID)
	if sess == nil {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("practice session %q not found", rawID))
		return
	}
	found := false
	for i := range sess.Laps {
		if sess.Laps[i].LapID == lapID {
			found = true
			break
		}
	}
	if !found {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("lap %d not found in practice session %q", lapID, targetID))
		return
	}
	if _, err := eng.PracticeAction(tracker.PracticeActionPayload{
		Action:    "delete_session_lap",
		SessionID: targetID,
		LapID:     lapID,
	}); err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

// handlePatchPracticeSessionCrossing serves `PATCH /v1/practice/sessions/{sessionId}/crossings/{eventId}`.
func (s *Server) handlePatchPracticeSessionCrossing(w http.ResponseWriter, r *http.Request) {
	rawID := strings.TrimSpace(r.PathValue("sessionId"))
	if !rejectColonInPathValue(w, rawID) {
		return
	}
	eventID, ok := parseUint64PathValue(w, r, "eventId")
	if !ok {
		return
	}
	var body struct {
		TimestampUs *uint64  `json:"timestampUs"`
		PeakRSSIDbm *float32 `json:"peakRssiDbm,omitempty"`
	}
	if err := decodeJSONBody(r, &body); err != nil || body.TimestampUs == nil || *body.TimestampUs == 0 {
		writeErrorJSON(w, http.StatusBadRequest, "request body must specify positive integer field 'timestampUs'")
		return
	}
	eng := s.activeEngine()
	sess, targetID := resolvePracticeSession(eng, rawID)
	if sess == nil {
		if rawID == "" || strings.EqualFold(rawID, "current") {
			if err := eng.AdjustEngineCrossing(eventID, *body.TimestampUs, body.PeakRSSIDbm); err != nil {
				writeEngineError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, s.buildFullStateResponse())
			return
		}
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("practice session %q not found", rawID))
		return
	}
	if _, err := eng.AdjustPracticeSessionCrossing(targetID, eventID, *body.TimestampUs, body.PeakRSSIDbm); err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

// handlePatchRaceSessionCrossing serves `PATCH /v1/race/sessions/{sessionId}/crossings/{eventId}`.
func (s *Server) handlePatchRaceSessionCrossing(w http.ResponseWriter, r *http.Request) {
	rawID := strings.TrimSpace(r.PathValue("sessionId"))
	if !rejectColonInPathValue(w, rawID) {
		return
	}
	eventID, ok := parseUint64PathValue(w, r, "eventId")
	if !ok {
		return
	}
	var body struct {
		TimestampUs *uint64  `json:"timestampUs"`
		PeakRSSIDbm *float32 `json:"peakRssiDbm,omitempty"`
	}
	if err := decodeJSONBody(r, &body); err != nil || body.TimestampUs == nil || *body.TimestampUs == 0 {
		writeErrorJSON(w, http.StatusBadRequest, "request body must specify positive integer field 'timestampUs'")
		return
	}
	eng := s.activeEngine()
	rs, targetID := findRaceSessionSnapshot(eng, rawID)
	if rs == nil {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("race %q not found", rawID))
		return
	}
	if err := eng.AdjustRaceCrossing(targetID, eventID, *body.TimestampUs, body.PeakRSSIDbm); err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

// handleDeletePracticeSessionLaps serves `DELETE /v1/practice/sessions/{sessionId}/laps`
// (clearing either a single pilot's laps when `?slotIndex=N` is provided, or all session laps).
func (s *Server) handleDeletePracticeSessionLaps(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("sessionId")
	eng := s.activeEngine()
	sess, targetID := resolvePracticeSession(eng, rawID)
	if sess == nil {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("practice session %q not found", rawID))
		return
	}
	rawSlot := strings.TrimSpace(r.URL.Query().Get("slotIndex"))
	if rawSlot != "" {
		slotIndex, err := strconv.Atoi(rawSlot)
		if err != nil || slotIndex < 1 || slotIndex > domain.MaxPilotPoolSize {
			writeErrorJSON(w, http.StatusBadRequest, fmt.Sprintf("invalid slotIndex %q (must be 1..%d)", rawSlot, domain.MaxPilotPoolSize))
			return
		}
		if _, err := eng.PracticeAction(tracker.PracticeActionPayload{
			Action:    "clear_pilot_laps",
			SessionID: targetID,
			SlotIndex: slotIndex,
		}); err != nil {
			writeEngineError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, s.buildFullStateResponse())
		return
	}
	if _, err := eng.PracticeAction(tracker.PracticeActionPayload{
		Action:    "clear_session_laps",
		SessionID: targetID,
	}); err != nil {
		writeEngineError(w, err)
		return
	}
	if eng.IsRaceArmed() && s.hooks.OnTimingStarted != nil {
		s.hooks.OnTimingStarted()
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

// --- Race Sessions Resource Hierarchy (`/v1/race/sessions` - symmetric with `/v1/practice/sessions`) ---

func findRaceSessionSnapshot(eng *tracker.Engine, rawID string) (*domain.RaceTournamentState, string) {
	id := strings.TrimSpace(rawID)
	if id == "" || strings.EqualFold(id, "current") {
		rs := eng.RaceSnapshot()
		if rs.RaceID == "" {
			ev := eng.EventSnapshot()
			if ev.ActiveRaceID != "" {
				for i := range ev.Races {
					if ev.Races[i].RaceID == ev.ActiveRaceID {
						cp := ev.Races[i]
						return &cp, cp.RaceID
					}
				}
			}
			return nil, ""
		}
		return &rs, rs.RaceID
	}
	rs := eng.RaceSnapshot()
	if rs.RaceID == id {
		return &rs, id
	}
	ev := eng.EventSnapshot()
	for i := range ev.Races {
		if ev.Races[i].RaceID == id {
			cp := ev.Races[i]
			return &cp, id
		}
	}
	return nil, ""
}

func resolveRaceTargetID(w http.ResponseWriter, eng *tracker.Engine, rawID string) (string, bool) {
	id := strings.TrimSpace(rawID)
	if id == "" || strings.EqualFold(id, "current") {
		return "", true
	}
	if found, _ := findRaceSessionSnapshot(eng, id); found == nil {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("race session %q not found", id))
		return "", false
	}
	return id, true
}

func (s *Server) handleGetRaceSessions(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.activeEngine().EventSnapshot())
}

func (s *Server) handleGetRaceSession(w http.ResponseWriter, r *http.Request) {
	rawID := strings.TrimSpace(r.PathValue("sessionId"))
	if !rejectColonInPathValue(w, rawID) {
		return
	}
	found, _ := findRaceSessionSnapshot(s.activeEngine(), rawID)
	if found == nil {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("race session %q not found", rawID))
		return
	}
	writeJSON(w, http.StatusOK, found)
}

func (s *Server) handleCreateRaceSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name       string   `json:"name,omitempty"`
		Tags       []string `json:"tags,omitempty"`
		CopyConfig bool     `json:"copyConfig,omitempty"`
		DontSelect bool     `json:"dontSelect,omitempty"`
	}
	if err := decodeOptionalJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	created, err := s.activeEngine().EventAction(tracker.EventActionPayload{
		Action:     "create_race",
		Name:       body.Name,
		Tags:       body.Tags,
		CopyConfig: body.CopyConfig,
		DontSelect: body.DontSelect,
	})
	if err != nil {
		writeEngineError(w, err)
		return
	}
	state := s.buildFullStateResponse()
	createdID := created.RaceID
	if (createdID == "" || body.DontSelect) && len(state.EventState.Races) > 0 {
		createdID = state.EventState.Races[len(state.EventState.Races)-1].RaceID
	}
	if createdID != "" {
		w.Header().Set("Location", "/v1/race/sessions/"+createdID)
	}
	writeJSON(w, http.StatusCreated, state)
}

// handlePatchRaceSession updates stored race session attributes (`name`, `tags`, `selected`).
// Imperative lifecycle operations use `POST /v1/race/sessions/{sessionId}:{start|pause|resume|stop|complete|scrap|reopen}`.
func (s *Server) handlePatchRaceSession(w http.ResponseWriter, r *http.Request) {
	rawID := strings.TrimSpace(r.PathValue("sessionId"))
	if !rejectColonInPathValue(w, rawID) {
		return
	}
	eng := s.activeEngine()
	targetRaceID, ok := resolveRaceTargetID(w, eng, rawID)
	if !ok {
		return
	}

	var body struct {
		Name     *string   `json:"name,omitempty"`
		Tags     *[]string `json:"tags,omitempty"`
		Selected *bool     `json:"selected,omitempty"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}

	if body.Name != nil {
		if _, err := eng.EventAction(tracker.EventActionPayload{
			Action: "rename_race",
			RaceID: targetRaceID,
			Name:   *body.Name,
		}); err != nil {
			writeEngineError(w, err)
			return
		}
	}
	if body.Tags != nil {
		if _, err := eng.EventAction(tracker.EventActionPayload{
			Action: "set_race_tags",
			RaceID: targetRaceID,
			Tags:   *body.Tags,
		}); err != nil {
			writeEngineError(w, err)
			return
		}
	}
	if body.Selected != nil && *body.Selected {
		selID := targetRaceID
		if selID == "" {
			if found, resolved := findRaceSessionSnapshot(eng, rawID); found != nil {
				selID = resolved
			}
		}
		if _, err := eng.EventAction(tracker.EventActionPayload{
			Action: "select_race",
			RaceID: selID,
		}); err != nil {
			writeEngineError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

// handleRaceSessionCustomAction serves `POST /v1/race/sessions/{sessionId}:{start|pause|resume|stop|complete|scrap|reopen}`.
func (s *Server) handleRaceSessionCustomAction(w http.ResponseWriter, r *http.Request) {
	rawID, customVerb, ok := cutCustomActionPathValue(w, r, "sessionId", "GET, HEAD, PATCH, DELETE")
	if !ok {
		return
	}
	eng := s.activeEngine()
	targetRaceID, ok := resolveRaceTargetID(w, eng, rawID)
	if !ok {
		return
	}

	var body struct {
		Reason         string `json:"reason,omitempty"`
		PreemptOngoing bool   `json:"preemptOngoing,omitempty"`
	}
	if err := decodeOptionalJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}

	var lifecycleAction string
	switch customVerb {
	case "start":
		lifecycleAction = "start_race"
	case "pause":
		lifecycleAction = "pause_race"
	case "resume":
		lifecycleAction = "resume_race"
	case "stop":
		lifecycleAction = "emergency_stop"
	case "complete":
		lifecycleAction = "complete_race"
	case "scrap":
		lifecycleAction = "scrap_race"
	case "reopen":
		lifecycleAction = "reopen_race"
	default:
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("unknown race session custom method %q", customVerb))
		return
	}

	if _, err := eng.EventAction(tracker.EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          targetRaceID,
		LifecycleAction: lifecycleAction,
		Reason:          body.Reason,
		PreemptOngoing:  body.PreemptOngoing,
	}); err != nil {
		writeEngineError(w, err)
		return
	}
	if (lifecycleAction == "start_race" || lifecycleAction == "resume_race") && s.hooks.OnTimingStarted != nil {
		s.hooks.OnTimingStarted()
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleDeleteRaceSession(w http.ResponseWriter, r *http.Request) {
	rawID := strings.TrimSpace(r.PathValue("sessionId"))
	if !rejectColonInPathValue(w, rawID) {
		return
	}
	if _, err := s.activeEngine().EventAction(tracker.EventActionPayload{
		Action: "delete_race",
		RaceID: rawID,
	}); err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleGetRaceSessionConfig(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("sessionId")
	found, _ := findRaceSessionSnapshot(s.activeEngine(), rawID)
	if found == nil {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("race session %q not found", rawID))
		return
	}
	writeJSON(w, http.StatusOK, found.Config)
}

func (s *Server) handlePutRaceSessionConfig(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("sessionId")
	eng := s.activeEngine()
	targetRaceID, ok := resolveRaceTargetID(w, eng, rawID)
	if !ok {
		return
	}
	var body struct {
		Config          domain.RaceSetupConfig `json:"config"`
		Generate        bool                   `json:"generate"`
		ApplyToExisting bool                   `json:"applyToExisting"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	eng.ConfigureAndGenerateRaceForID(targetRaceID, body.Config, body.Generate, body.ApplyToExisting)
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleGetRaceSessionPilots(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("sessionId")
	found, _ := findRaceSessionSnapshot(s.activeEngine(), rawID)
	if found == nil {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("race session %q not found", rawID))
		return
	}
	writeJSON(w, http.StatusOK, found.Roster)
}

func (s *Server) handleAddRaceSessionPilot(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("sessionId")
	eng := s.activeEngine()
	targetRaceID, ok := resolveRaceTargetID(w, eng, rawID)
	if !ok {
		return
	}
	var body struct {
		SlotIndex    int    `json:"slotIndex,omitempty"`
		Callsign     string `json:"callsign,omitempty"`
		PhoneticName string `json:"phoneticName,omitempty"`
	}
	if err := decodeOptionalJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}

	var (
		updated domain.RaceTournamentState
		err     error
	)
	if body.SlotIndex > 0 {
		checkedIn := true
		updated, err = eng.EventAction(tracker.EventActionPayload{
			Action:     "update_attendance",
			RaceID:     targetRaceID,
			SlotIndex:  body.SlotIndex,
			CheckedIn:  &checkedIn,
			Attendance: domain.AttendanceActive,
		})
	} else {
		updated, err = eng.EventAction(tracker.EventActionPayload{
			Action:       "add_race_pilot",
			RaceID:       targetRaceID,
			Callsign:     body.Callsign,
			PhoneticName: body.PhoneticName,
		})
	}
	if err != nil {
		writeEngineError(w, err)
		return
	}

	state := s.buildFullStateResponse()
	locRaceID := updated.RaceID
	if locRaceID == "" {
		locRaceID = "current"
	}
	assignedSlot := body.SlotIndex
	if assignedSlot <= 0 && len(state.Pilots) > 0 {
		assignedSlot = state.Pilots[len(state.Pilots)-1].SlotIndex
	}
	if assignedSlot > 0 {
		w.Header().Set("Location", fmt.Sprintf("/v1/race/sessions/%s/pilots/%d", locRaceID, assignedSlot))
	}
	writeJSON(w, http.StatusCreated, state)
}

func (s *Server) handleCheckInAllRaceSessionPilots(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("sessionId")
	eng := s.activeEngine()
	targetRaceID, ok := resolveRaceTargetID(w, eng, rawID)
	if !ok {
		return
	}
	if err := decodeOptionalJSONBody(r, &struct{}{}); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := eng.EventAction(tracker.EventActionPayload{
		Action: "check_in_all",
		RaceID: targetRaceID,
	}); err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handlePatchRaceSessionPilot(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("sessionId")
	slotIndex, ok := parsePositiveIntPathValue(w, r, "slotIndex")
	if !ok {
		return
	}
	eng := s.activeEngine()
	targetRaceID, ok := resolveRaceTargetID(w, eng, rawID)
	if !ok {
		return
	}
	var body struct {
		CheckedIn  *bool                  `json:"checkedIn,omitempty"`
		Attendance domain.PilotAttendance `json:"attendance,omitempty"`
		PilotNote  string                 `json:"pilotNote,omitempty"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := eng.EventAction(tracker.EventActionPayload{
		Action:     "update_attendance",
		RaceID:     targetRaceID,
		SlotIndex:  slotIndex,
		CheckedIn:  body.CheckedIn,
		Attendance: body.Attendance,
		PilotNote:  body.PilotNote,
	}); err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

// handleRaceSessionStageCustomAction serves `POST /v1/race/sessions/{sessionId}/stages/{stageRef}:{control|advance}`.
func (s *Server) handleRaceSessionStageCustomAction(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("sessionId")
	stageRef, customVerb, ok := cutCustomActionPathValue(w, r, "stageRef", "")
	if !ok {
		return
	}
	eng := s.activeEngine()
	targetRaceID, ok := resolveRaceTargetID(w, eng, rawID)
	if !ok {
		return
	}

	switch customVerb {
	case "advance":
		if err := decodeOptionalJSONBody(r, &struct{}{}); err != nil {
			writeErrorJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		if _, err := eng.AdvanceRaceStage2(); err != nil {
			writeEngineError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, s.buildFullStateResponse())

	case "control":
		var body struct {
			StageAction string `json:"stageAction"`
			StageID     string `json:"stageId,omitempty"`
		}
		if err := decodeJSONBody(r, &body); err != nil {
			writeErrorJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		var stageIndex int
		stageID := strings.TrimSpace(body.StageID)
		if stageRef != "" && !strings.EqualFold(stageRef, "current") {
			if parsed, err := strconv.Atoi(stageRef); err == nil && parsed > 0 {
				stageIndex = parsed
			} else if stageID == "" {
				stageID = stageRef
			}
		}
		if _, err := eng.EventAction(tracker.EventActionPayload{
			Action:      "stage_control",
			RaceID:      targetRaceID,
			StageIndex:  stageIndex,
			StageID:     stageID,
			StageAction: body.StageAction,
		}); err != nil {
			writeEngineError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, s.buildFullStateResponse())

	default:
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("unknown stage custom method %q", customVerb))
	}
}

func (s *Server) handleEditRaceSessionBracket(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("sessionId")
	eng := s.activeEngine()
	targetRaceID, ok := resolveRaceTargetID(w, eng, rawID)
	if !ok {
		return
	}
	var body tracker.BracketEditPayload
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if targetRaceID != "" {
		body.RaceID = targetRaceID
	}
	if _, err := eng.BracketEditAction(body); err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

// handleRaceSessionHeatCustomAction serves `POST /v1/race/sessions/{sessionId}/heats/{heatId}:control`.
func (s *Server) handleRaceSessionHeatCustomAction(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("sessionId")
	rawHeatID, customVerb, ok := cutCustomActionPathValue(w, r, "heatId", "")
	if !ok {
		return
	}
	if customVerb != "control" {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("unknown heat custom method %q", customVerb))
		return
	}
	eng := s.activeEngine()
	targetRaceID, ok := resolveRaceTargetID(w, eng, rawID)
	if !ok {
		return
	}
	var body struct {
		Action         string `json:"action"`
		HeatID         string `json:"heatId,omitempty"`
		PreemptOngoing bool   `json:"preemptOngoing,omitempty"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	effectiveHeatID := rawHeatID
	if strings.EqualFold(effectiveHeatID, "current") {
		effectiveHeatID = strings.TrimSpace(body.HeatID)
	}
	if _, err := eng.RaceControlActionWithOptions(targetRaceID, body.Action, effectiveHeatID, body.PreemptOngoing); err != nil {
		writeEngineError(w, err)
		return
	}
	if (body.Action == "start" || body.Action == "resume" || body.Action == "restart" || body.Action == "open_qual_start_pack") && s.hooks.OnTimingStarted != nil {
		s.hooks.OnTimingStarted()
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

// handleRaceSessionHeatPilotCustomAction serves `POST /v1/race/sessions/{sessionId}/heats/{heatId}/pilots/{slotIndex}:marshal`.
func (s *Server) handleRaceSessionHeatPilotCustomAction(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("sessionId")
	rawHeatID := strings.TrimSpace(r.PathValue("heatId"))
	if !rejectColonInPathValue(w, rawHeatID) {
		return
	}
	rawSlot, customVerb, ok := cutCustomActionPathValue(w, r, "slotIndex", "")
	if !ok {
		return
	}
	if customVerb != "marshal" {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("unknown heat pilot custom method %q", customVerb))
		return
	}
	slotIndex, ok := parsePositiveIntString(w, "slotIndex", rawSlot)
	if !ok {
		return
	}
	eng := s.activeEngine()
	targetRaceID, ok := resolveRaceTargetID(w, eng, rawID)
	if !ok {
		return
	}
	var body tracker.RaceMarshalPayload
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if targetRaceID != "" {
		body.RaceID = targetRaceID
	}
	if !strings.EqualFold(rawHeatID, "current") {
		body.HeatID = rawHeatID
	}
	body.PilotSlotIndex = slotIndex
	if _, err := eng.MarshalPilotAction(body); err != nil {
		writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleExportRaceSessionStandingsCSV(w http.ResponseWriter, r *http.Request) {
	rawID := strings.TrimSpace(r.PathValue("sessionId"))
	raceID := rawID
	if strings.EqualFold(raceID, "current") {
		raceID = ""
	}
	s.serveRaceResultsCSV(w, r, raceID)
}

func (s *Server) handleExportRaceResultsCSV(w http.ResponseWriter, r *http.Request) {
	s.serveRaceResultsCSV(w, r, r.URL.Query().Get("raceId"))
}

func (s *Server) serveRaceResultsCSV(w http.ResponseWriter, r *http.Request, raceID string) {
	stageIdx := 0
	if rawStage := r.URL.Query().Get("stageIndex"); rawStage != "" {
		if parsed, err := strconv.Atoi(rawStage); err == nil && parsed >= 1 {
			stageIdx = parsed
		}
	}
	filename, csvBody, err := s.activeEngine().ExportRaceResultsCSV(raceID, stageIdx)
	if err != nil {
		writeEngineError(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(csvBody))
}

func (s *Server) handleGetRaceClock(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.activeEngine().RaceSnapshot())
}
