package api

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"strings"

	"slaprf/internal/domain"
	"slaprf/internal/tracker"
)

// SessionTraceResponse returns compact base64-encoded binary telemetry batches (`EncodeTelemetryBatch`)
// for a PracticeSession's saved `.rfbin` trace.
type SessionTraceResponse struct {
	SessionID   string   `json:"sessionId"`
	SampleCount int      `json:"sampleCount"`
	RssiCount   int      `json:"rssiCount"`
	BatchesB64  []string `json:"batchesB64"`
}

func (s *Server) handleGetPracticeSessionTrace(w http.ResponseWriter, r *http.Request) {
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

	frames, err := eng.SessionTraceFrames(targetID)
	if err != nil {
		writeEngineError(w, err)
		return
	}

	rssiCount := domain.MaxPilotSlots
	for _, sp := range sess.Pilots {
		if sp.SlotIndex > rssiCount {
			rssiCount = sp.SlotIndex
		}
	}
	if pc := eng.PilotCount(); pc > rssiCount {
		rssiCount = pc
	}
	if rssiCount > domain.MaxPilotPoolSize {
		rssiCount = domain.MaxPilotPoolSize
	}

	const maxFramesPerBatch = 16384
	batches := make([]string, 0, 1+len(frames)/maxFramesPerBatch)
	var encBuf []byte
	for start := 0; start < len(frames); start += maxFramesPerBatch {
		end := start + maxFramesPerBatch
		if end > len(frames) {
			end = len(frames)
		}
		encBuf = EncodeTelemetryBatch(encBuf[:0], frames[start:end], rssiCount)
		batches = append(batches, base64.StdEncoding.EncodeToString(encBuf))
	}

	writeJSON(w, http.StatusOK, SessionTraceResponse{
		SessionID:   targetID,
		SampleCount: len(frames),
		RssiCount:   rssiCount,
		BatchesB64:  batches,
	})
}

func (s *Server) handlePutPracticePackLoop(w http.ResponseWriter, r *http.Request) {
	var body struct {
		PackLoopEnabled  *bool `json:"packLoopEnabled,omitempty"`
		PackLoopQuietSec *int  `json:"packLoopQuietSec,omitempty"`
		PreemptOngoing   bool  `json:"preemptOngoing,omitempty"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	eng := s.activeEngine()
	wasArmed := eng.IsRaceArmed()
	if _, err := eng.PracticeAction(tracker.PracticeActionPayload{
		Action:           "set_pack_loop",
		PackLoopEnabled:  body.PackLoopEnabled,
		PackLoopQuietSec: body.PackLoopQuietSec,
		PreemptOngoing:   body.PreemptOngoing,
	}); err != nil {
		writeEngineError(w, err)
		return
	}
	if !wasArmed && eng.IsRaceArmed() && s.hooks.OnTimingStarted != nil {
		s.hooks.OnTimingStarted()
	}
	s.logUserAction("Practice", "Updated Hands-Free Pack Loop (enabled=%v)", body.PackLoopEnabled != nil && *body.PackLoopEnabled)
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleSplitPracticePackLoop(w http.ResponseWriter, r *http.Request) {
	if err := decodeOptionalJSONBody(r, &struct{}{}); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	eng := s.activeEngine()
	if _, err := eng.PracticeAction(tracker.PracticeActionPayload{
		Action: "seal_and_split_pack",
	}); err != nil {
		writeEngineError(w, err)
		return
	}
	if eng.IsRaceArmed() && s.hooks.OnTimingStarted != nil {
		s.hooks.OnTimingStarted()
	}
	s.logUserAction("Practice", "Sealed current pack and armed next pack")
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

// --- On-Device AI Detector & Model Training (`/v1/ml`, `/v1/ml:train`, `/v1/ml/dataset.tar.gz`, `/v1/ml/dataset:import`) ---

func (s *Server) handleGetMLStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.activeEngine().MLStatus())
}

func (s *Server) handlePatchMLConfig(w http.ResponseWriter, r *http.Request) {
	var body tracker.MLConfigPayload
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	st, err := s.activeEngine().UpdateMLConfig(body)
	if err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	s.logUserAction("ML", "Updated detector config (mode=%s, model=%s, liveTune=%v)", st.Config.DetectorMode, st.Config.ActiveModelID, st.Config.LiveTuneEnabled)
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleStartMLTraining(w http.ResponseWriter, r *http.Request) {
	var body tracker.MLTrainRequest
	if err := decodeOptionalJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	st, err := s.activeEngine().StartMLTraining(body)
	if err != nil {
		writeErrorJSON(w, http.StatusConflict, err.Error())
		return
	}
	s.logUserAction("ML", "Started on-device model training (epochs=%d, target=%s, base=%s, continue=%s)", st.Training.TotalEpochs, body.TargetModelID, body.BaseModelID, body.ContinueModelID)
	writeJSON(w, http.StatusAccepted, st)
}

func (s *Server) handleCancelMLTraining(w http.ResponseWriter, r *http.Request) {
	if err := decodeOptionalJSONBody(r, &struct{}{}); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	st := s.activeEngine().CancelMLTraining()
	s.logUserAction("ML", "Canceled on-device model training")
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleGetMLTeacher(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.activeEngine().MLStatus().Teacher)
}

func (s *Server) handleDownloadMLTeacher(w http.ResponseWriter, r *http.Request) {
	var body struct {
		PackID string `json:"packId,omitempty"`
	}
	if err := decodeOptionalJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	st, err := s.activeEngine().StartTeacherDownload(body.PackID)
	if err != nil {
		writeErrorJSON(w, http.StatusConflict, err.Error())
		return
	}
	s.logUserAction("ML", "Started on-device AI labeler model download (pack=%s)", st.Config.TeacherPackID)
	writeJSON(w, http.StatusAccepted, st)
}

func (s *Server) handleCancelMLTeacher(w http.ResponseWriter, r *http.Request) {
	if err := decodeOptionalJSONBody(r, &struct{}{}); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	st := s.activeEngine().CancelTeacherDownload()
	s.logUserAction("ML", "Canceled on-device AI labeler model download")
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleDeleteMLTeacherPack(w http.ResponseWriter, r *http.Request) {
	packID := strings.TrimSpace(r.PathValue("packId"))
	if !rejectColonInPathValue(w, packID) {
		return
	}
	st, err := s.activeEngine().DeleteTeacherPack(packID)
	if err != nil {
		writeErrorJSON(w, http.StatusNotFound, err.Error())
		return
	}
	s.logUserAction("ML", "Deleted cached AI labeler pack %s", packID)
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleMLSessionCustomAction(w http.ResponseWriter, r *http.Request) {
	rawID, customVerb, ok := cutCustomActionPathValue(w, r, "sessionId", "POST")
	if !ok {
		return
	}
	if customVerb != "label" {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("unknown ML session action %q (expected \":label\")", customVerb))
		return
	}
	var body tracker.MLSessionLabelRequest
	if err := decodeOptionalJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	res, err := s.activeEngine().LabelPracticeSession(r.Context(), rawID, body)
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "not found") {
			writeErrorJSON(w, http.StatusNotFound, msg)
		} else {
			writeErrorJSON(w, http.StatusConflict, msg)
		}
		return
	}
	s.logUserAction("ML", "Labeled practice session %s with on-device AI (%s, dryRun=%v, crossings=%d, hardNegs=%d)",
		res.SessionID, res.PackID, res.DryRun, res.CrossingsCount, res.HardNegsCount)
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleCreateMLModel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	st, err := s.activeEngine().CreateMLModel(body.Name)
	if err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	s.logUserAction("ML", "Created untrained AI model %q", strings.TrimSpace(body.Name))
	writeJSON(w, http.StatusCreated, st)
}

func (s *Server) handlePatchMLModel(w http.ResponseWriter, r *http.Request) {
	modelID := strings.TrimSpace(r.PathValue("modelId"))
	if !rejectColonInPathValue(w, modelID) {
		return
	}
	var body tracker.MLModelUpdatePayload
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	st, err := s.activeEngine().UpdateMLModel(modelID, body)
	if err != nil {
		writeErrorJSON(w, http.StatusNotFound, err.Error())
		return
	}
	s.logUserAction("ML", "Updated trained model %s (ready=%v)", modelID, body.Ready != nil && *body.Ready)
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleDeleteMLModel(w http.ResponseWriter, r *http.Request) {
	modelID := strings.TrimSpace(r.PathValue("modelId"))
	if !rejectColonInPathValue(w, modelID) {
		return
	}
	st, err := s.activeEngine().DeleteMLModel(modelID)
	if err != nil {
		writeErrorJSON(w, http.StatusNotFound, err.Error())
		return
	}
	s.logUserAction("ML", "Deleted trained model %s", modelID)
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleExportMLDataset(w http.ResponseWriter, r *http.Request) {
	var buf bytes.Buffer
	if err := s.activeEngine().ExportMLDatasetTarGz(&buf); err != nil {
		writeErrorJSON(w, http.StatusInternalServerError, err.Error())
		return
	}
	if strings.EqualFold(r.URL.Query().Get("format"), "base64") {
		writeJSON(w, http.StatusOK, map[string]any{
			"filename":   "slaprf-ai-dataset.tar.gz",
			"sizeBytes":  buf.Len(),
			"archiveB64": base64.StdEncoding.EncodeToString(buf.Bytes()),
		})
		return
	}
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", `attachment; filename="slaprf-ai-dataset.tar.gz"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf.Bytes())
}

func (s *Server) handleImportMLDataset(w http.ResponseWriter, r *http.Request) {
	ct := strings.ToLower(r.Header.Get("Content-Type"))
	var archiveReader io.Reader
	if strings.Contains(ct, "application/json") {
		var body struct {
			ArchiveB64 string `json:"archiveB64"`
		}
		if err := decodeJSONBody(r, &body); err != nil {
			writeErrorJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(body.ArchiveB64))
		if err != nil || len(raw) == 0 {
			writeErrorJSON(w, http.StatusBadRequest, "invalid base64 archiveB64 payload")
			return
		}
		archiveReader = bytes.NewReader(raw)
	} else {
		raw, err := io.ReadAll(io.LimitReader(r.Body, 128<<20))
		if err != nil || len(raw) == 0 {
			writeErrorJSON(w, http.StatusBadRequest, "empty dataset archive body")
			return
		}
		archiveReader = bytes.NewReader(raw)
	}

	impSess, impMod, err := s.activeEngine().ImportMLDatasetTarGz(archiveReader)
	if err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	s.logUserAction("ML", "Imported AI dataset archive (%d sessions, %d models)", impSess, impMod)
	writeJSON(w, http.StatusOK, map[string]any{
		"importedSessions": impSess,
		"importedModels":   impMod,
		"state":            s.buildFullStateResponse(),
	})
}
