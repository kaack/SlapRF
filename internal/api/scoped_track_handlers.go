package api

import (
	"fmt"
	"net/http"
	"strings"

	"slaprf/internal/domain"
)

type trackScopeKind string

const (
	trackScopePractice trackScopeKind = "practice"
	trackScopeRace     trackScopeKind = "race"
)

func (s *Server) resolveScopedTrackTargetID(w http.ResponseWriter, r *http.Request, kind trackScopeKind) (string, bool) {
	rawID := strings.TrimSpace(r.PathValue("sessionId"))
	if !rejectColonInPathValue(w, rawID) {
		return "", false
	}
	eng := s.activeEngine()
	if kind == trackScopePractice {
		sess, targetID := resolvePracticeSession(eng, rawID)
		if sess == nil {
			writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("practice session %q not found", rawID))
			return "", false
		}
		return targetID, true
	}
	rs, targetID := findRaceSessionSnapshot(eng, rawID)
	if rs == nil {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("race %q not found", rawID))
		return "", false
	}
	return targetID, true
}

func (s *Server) scopedTrackSnapshot(kind trackScopeKind, targetID string) ([]domain.TrackGate, []domain.DetectedTimer, domain.TimingRules, error) {
	eng := s.activeEngine()
	if kind == trackScopePractice {
		return eng.PracticeTrackSnapshot(targetID)
	}
	return eng.RaceTrackSnapshot(targetID)
}

func (s *Server) handleScopedGetTrack(kind trackScopeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		targetID, ok := s.resolveScopedTrackTargetID(w, r, kind)
		if !ok {
			return
		}
		gates, timers, rules, err := s.scopedTrackSnapshot(kind, targetID)
		if err != nil {
			writeEngineError(w, err)
			return
		}
		if gates == nil {
			gates = []domain.TrackGate{}
		}
		if timers == nil {
			timers = []domain.DetectedTimer{}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"gates":  gates,
			"timers": timers,
			"rules":  rules,
		})
	}
}

func (s *Server) handleScopedResetTrack(kind trackScopeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		targetID, ok := s.resolveScopedTrackTargetID(w, r, kind)
		if !ok {
			return
		}
		if err := decodeOptionalJSONBody(r, &struct{}{}); err != nil {
			writeErrorJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		eng := s.activeEngine()
		var err error
		if kind == trackScopePractice {
			_, err = eng.ResetPracticeTrack(targetID)
		} else {
			_, err = eng.ResetRaceTrack(targetID)
		}
		if err != nil {
			writeEngineError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, s.buildFullStateResponse())
	}
}

func (s *Server) handleScopedPutThresholds(kind trackScopeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		targetID, ok := s.resolveScopedTrackTargetID(w, r, kind)
		if !ok {
			return
		}
		var updates []domain.GateThresholdUpdate
		if err := decodeJSONBody(r, &updates); err != nil {
			writeErrorJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		eng := s.activeEngine()
		var err error
		if kind == trackScopePractice {
			err = eng.SetPracticeGateThresholds(targetID, updates)
		} else {
			err = eng.SetRaceGateThresholds(targetID, updates)
		}
		if err != nil {
			writeEngineError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, s.buildFullStateResponse())
	}
}

func (s *Server) handleScopedGetRules(kind trackScopeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		targetID, ok := s.resolveScopedTrackTargetID(w, r, kind)
		if !ok {
			return
		}
		_, _, rules, err := s.scopedTrackSnapshot(kind, targetID)
		if err != nil {
			writeEngineError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, rules)
	}
}

func (s *Server) handleScopedPutRules(kind trackScopeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		targetID, ok := s.resolveScopedTrackTargetID(w, r, kind)
		if !ok {
			return
		}
		var rules domain.TimingRules
		if err := decodeJSONBody(r, &rules); err != nil {
			writeErrorJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		eng := s.activeEngine()
		var err error
		if kind == trackScopePractice {
			_, err = eng.SetPracticeRules(targetID, rules)
		} else {
			_, err = eng.SetRaceRules(targetID, rules)
		}
		if err != nil {
			writeEngineError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, s.buildFullStateResponse())
	}
}

func (s *Server) handleScopedGetGates(kind trackScopeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		targetID, ok := s.resolveScopedTrackTargetID(w, r, kind)
		if !ok {
			return
		}
		gates, _, _, err := s.scopedTrackSnapshot(kind, targetID)
		if err != nil {
			writeEngineError(w, err)
			return
		}
		if gates == nil {
			gates = []domain.TrackGate{}
		}
		writeJSON(w, http.StatusOK, gates)
	}
}

func (s *Server) handleScopedGetGate(kind trackScopeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		targetID, ok := s.resolveScopedTrackTargetID(w, r, kind)
		if !ok {
			return
		}
		gateID, ok := parseUint8PathValue(w, r, "gateId")
		if !ok {
			return
		}
		gates, _, _, err := s.scopedTrackSnapshot(kind, targetID)
		if err != nil {
			writeEngineError(w, err)
			return
		}
		for _, g := range gates {
			if g.GateID == gateID {
				writeJSON(w, http.StatusOK, g)
				return
			}
		}
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("gate %d not found", gateID))
	}
}

func (s *Server) handleScopedCreateGate(kind trackScopeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		targetID, ok := s.resolveScopedTrackTargetID(w, r, kind)
		if !ok {
			return
		}
		var body struct {
			Name            string `json:"name"`
			AssignedTimerID uint8  `json:"assignedTimerId"`
			TrackOrder      *int   `json:"trackOrder,omitempty"`
		}
		if err := decodeOptionalJSONBody(r, &body); err != nil {
			writeErrorJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		eng := s.activeEngine()
		var (
			created domain.TrackGate
			err     error
		)
		if kind == trackScopePractice {
			if body.TrackOrder != nil {
				created, err = eng.AddPracticeGate(targetID, body.Name, body.AssignedTimerID, *body.TrackOrder)
			} else {
				created, err = eng.AddPracticeGate(targetID, body.Name, body.AssignedTimerID)
			}
		} else {
			if body.TrackOrder != nil {
				created, err = eng.AddRaceGate(targetID, body.Name, body.AssignedTimerID, *body.TrackOrder)
			} else {
				created, err = eng.AddRaceGate(targetID, body.Name, body.AssignedTimerID)
			}
		}
		if err != nil {
			writeEngineError(w, err)
			return
		}
		w.Header().Set("Location", fmt.Sprintf("/v1/%s/sessions/%s/track/gates/%d", kind, targetID, created.GateID))
		writeJSON(w, http.StatusCreated, s.buildFullStateResponse())
	}
}

func (s *Server) handleScopedUpdateGate(kind trackScopeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		targetID, ok := s.resolveScopedTrackTargetID(w, r, kind)
		if !ok {
			return
		}
		gateID, ok := parseUint8PathValue(w, r, "gateId")
		if !ok {
			return
		}
		var upd domain.GateUpdate
		if err := decodeJSONBody(r, &upd); err != nil {
			writeErrorJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		upd.GateID = gateID
		eng := s.activeEngine()
		var err error
		if kind == trackScopePractice {
			err = eng.UpdatePracticeGate(targetID, upd)
		} else {
			err = eng.UpdateRaceGate(targetID, upd)
		}
		if err != nil {
			writeEngineError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, s.buildFullStateResponse())
	}
}

func (s *Server) handleScopedDeleteGate(kind trackScopeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		targetID, ok := s.resolveScopedTrackTargetID(w, r, kind)
		if !ok {
			return
		}
		gateID, ok := parseUint8PathValue(w, r, "gateId")
		if !ok {
			return
		}
		eng := s.activeEngine()
		var err error
		if kind == trackScopePractice {
			err = eng.RemovePracticeGate(targetID, gateID)
		} else {
			err = eng.RemoveRaceGate(targetID, gateID)
		}
		if err != nil {
			writeEngineError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, s.buildFullStateResponse())
	}
}

func (s *Server) handleScopedGetGateRules(kind trackScopeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		targetID, ok := s.resolveScopedTrackTargetID(w, r, kind)
		if !ok {
			return
		}
		gateID, ok := parseUint8PathValue(w, r, "gateId")
		if !ok {
			return
		}
		eng := s.activeEngine()
		var (
			overrides domain.GateRuleOverrides
			err       error
		)
		if kind == trackScopePractice {
			overrides, err = eng.PracticeGateRules(targetID, gateID)
		} else {
			overrides, err = eng.RaceGateRules(targetID, gateID)
		}
		if err != nil {
			writeEngineError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, overrides)
	}
}

func (s *Server) handleScopedPutGateRules(kind trackScopeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		targetID, ok := s.resolveScopedTrackTargetID(w, r, kind)
		if !ok {
			return
		}
		gateID, ok := parseUint8PathValue(w, r, "gateId")
		if !ok {
			return
		}
		overrides, err := decodeGateRuleOverrides(r)
		if err != nil {
			writeErrorJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		eng := s.activeEngine()
		if kind == trackScopePractice {
			_, err = eng.SetPracticeGateRules(targetID, gateID, overrides)
		} else {
			_, err = eng.SetRaceGateRules(targetID, gateID, overrides)
		}
		if err != nil {
			writeEngineError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, s.buildFullStateResponse())
	}
}

func (s *Server) handleScopedResetGateRules(kind trackScopeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		targetID, ok := s.resolveScopedTrackTargetID(w, r, kind)
		if !ok {
			return
		}
		gateID, ok := parseUint8PathValue(w, r, "gateId")
		if !ok {
			return
		}
		if err := decodeOptionalJSONBody(r, &struct{}{}); err != nil {
			writeErrorJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		eng := s.activeEngine()
		var err error
		if kind == trackScopePractice {
			_, err = eng.SetPracticeGateRules(targetID, gateID, domain.GateRuleOverrides{})
		} else {
			_, err = eng.SetRaceGateRules(targetID, gateID, domain.GateRuleOverrides{})
		}
		if err != nil {
			writeEngineError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, s.buildFullStateResponse())
	}
}

func (s *Server) handleScopedGetPilotGateRules(kind trackScopeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		targetID, ok := s.resolveScopedTrackTargetID(w, r, kind)
		if !ok {
			return
		}
		gateID, ok := parseUint8PathValue(w, r, "gateId")
		if !ok {
			return
		}
		slotIndex, ok := parsePositiveIntPathValue(w, r, "slotIndex")
		if !ok {
			return
		}
		eng := s.activeEngine()
		var (
			overrides domain.GateRuleOverrides
			err       error
		)
		if kind == trackScopePractice {
			overrides, err = eng.PracticePilotGateRules(targetID, gateID, slotIndex)
		} else {
			overrides, err = eng.RacePilotGateRules(targetID, gateID, slotIndex)
		}
		if err != nil {
			writeEngineError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, overrides)
	}
}

func (s *Server) handleScopedPutPilotGateRules(kind trackScopeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		targetID, ok := s.resolveScopedTrackTargetID(w, r, kind)
		if !ok {
			return
		}
		gateID, ok := parseUint8PathValue(w, r, "gateId")
		if !ok {
			return
		}
		slotIndex, ok := parsePositiveIntPathValue(w, r, "slotIndex")
		if !ok {
			return
		}
		overrides, err := decodeGateRuleOverrides(r)
		if err != nil {
			writeErrorJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		eng := s.activeEngine()
		if kind == trackScopePractice {
			_, err = eng.SetPracticePilotGateRules(targetID, gateID, slotIndex, overrides)
		} else {
			_, err = eng.SetRacePilotGateRules(targetID, gateID, slotIndex, overrides)
		}
		if err != nil {
			writeEngineError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, s.buildFullStateResponse())
	}
}

func (s *Server) handleScopedResetPilotGateRules(kind trackScopeKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		targetID, ok := s.resolveScopedTrackTargetID(w, r, kind)
		if !ok {
			return
		}
		gateID, ok := parseUint8PathValue(w, r, "gateId")
		if !ok {
			return
		}
		slotIndex, ok := parsePositiveIntPathValue(w, r, "slotIndex")
		if !ok {
			return
		}
		if err := decodeOptionalJSONBody(r, &struct{}{}); err != nil {
			writeErrorJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		eng := s.activeEngine()
		var err error
		if kind == trackScopePractice {
			_, err = eng.SetPracticePilotGateRules(targetID, gateID, slotIndex, domain.GateRuleOverrides{})
		} else {
			_, err = eng.SetRacePilotGateRules(targetID, gateID, slotIndex, domain.GateRuleOverrides{})
		}
		if err != nil {
			writeEngineError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, s.buildFullStateResponse())
	}
}

func (s *Server) registerScopedTrackRoutes(mux *http.ServeMux, wrap func(http.HandlerFunc) http.HandlerFunc, kind trackScopeKind) {
	base := fmt.Sprintf("/v1/%s/sessions/{sessionId}/track", kind)
	mux.HandleFunc("GET "+base, s.handleScopedGetTrack(kind))
	mux.HandleFunc("POST "+base+":reset", wrap(s.handleScopedResetTrack(kind)))
	mux.HandleFunc("PUT "+base+"/thresholds", wrap(s.handleScopedPutThresholds(kind)))
	mux.HandleFunc("GET "+base+"/rules", s.handleScopedGetRules(kind))
	mux.HandleFunc("PUT "+base+"/rules", wrap(s.handleScopedPutRules(kind)))
	mux.HandleFunc("GET "+base+"/gates", s.handleScopedGetGates(kind))
	mux.HandleFunc("POST "+base+"/gates", wrap(s.handleScopedCreateGate(kind)))
	mux.HandleFunc("GET "+base+"/gates/{gateId}", s.handleScopedGetGate(kind))
	mux.HandleFunc("PUT "+base+"/gates/{gateId}", wrap(s.handleScopedUpdateGate(kind)))
	mux.HandleFunc("PATCH "+base+"/gates/{gateId}", wrap(s.handleScopedUpdateGate(kind)))
	mux.HandleFunc("DELETE "+base+"/gates/{gateId}", wrap(s.handleScopedDeleteGate(kind)))
	mux.HandleFunc("GET "+base+"/gates/{gateId}/rules", s.handleScopedGetGateRules(kind))
	mux.HandleFunc("PUT "+base+"/gates/{gateId}/rules", wrap(s.handleScopedPutGateRules(kind)))
	mux.HandleFunc("POST "+base+"/gates/{gateId}/rules:reset", wrap(s.handleScopedResetGateRules(kind)))
	mux.HandleFunc("GET "+base+"/gates/{gateId}/pilots/{slotIndex}/rules", s.handleScopedGetPilotGateRules(kind))
	mux.HandleFunc("PUT "+base+"/gates/{gateId}/pilots/{slotIndex}/rules", wrap(s.handleScopedPutPilotGateRules(kind)))
	mux.HandleFunc("POST "+base+"/gates/{gateId}/pilots/{slotIndex}/rules:reset", wrap(s.handleScopedResetPilotGateRules(kind)))
}
