package tracker

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"path"
	"sort"
	"strings"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/ml"
	"slaprf/internal/tracestore"
)

const (
	defaultPackLoopQuietSec = 25
	minPackLoopQuietSec     = 10
	maxPackLoopQuietSec     = 180
)

// MLEventSubscriber is an optional interface implemented by EventSubscribers (such as WebSocket
// streamHub, WASM bridge, and PersistenceWorker) that receive real-time ML status updates.
type MLEventSubscriber interface {
	OnMLUpdated(status domain.MLStatus)
}

type gateSignalObs struct {
	excessDb float32
	tsUs     uint64
}

func cloneMLPersistedState(st domain.MLPersistedState) domain.MLPersistedState {
	out := domain.MLPersistedState{
		Config:    st.Config,
		Models:    make([]domain.MLModelSnapshot, len(st.Models)),
		LiveTunes: append([]domain.MLLiveGateTune(nil), st.LiveTunes...),
	}
	if out.Config.DetectorMode == "" {
		out.Config = domain.DefaultMLConfig()
	}
	for i, m := range st.Models {
		cp := m
		cp.Weights = append([]float32(nil), m.Weights...)
		cp.SourceSessionIDs = append([]string(nil), m.SourceSessionIDs...)
		out.Models[i] = cp
	}
	return out
}

func (e *Engine) ensureTraceStoreLocked() tracestore.Store {
	if e.traceStore == nil {
		e.traceStore = tracestore.NewMemoryStore()
	}
	return e.traceStore
}

// SetTraceStore attaches a persistent `.rfbin` trace store (such as `tracestore.FileStore`) to `e`.
func (e *Engine) SetTraceStore(ts tracestore.Store) {
	e.mu.Lock()
	e.traceStore = ts
	e.mu.Unlock()
}

// TraceStore returns the engine's `.rfbin` trace store.
func (e *Engine) TraceStore() tracestore.Store {
	e.mu.Lock()
	ts := e.ensureTraceStoreLocked()
	e.mu.Unlock()
	return ts
}

// SetTeacherManager attaches an on-device System 1 `.gguf` teacher model manager to `e`.
func (e *Engine) SetTeacherManager(tm *ml.TeacherManager) {
	e.mu.Lock()
	e.mlTeacher = tm
	e.mu.Unlock()
}

// TeacherManager returns the attached on-device System 1 teacher model manager (or nil in pure WASM).
func (e *Engine) TeacherManager() *ml.TeacherManager {
	e.mu.RLock()
	tm := e.mlTeacher
	e.mu.RUnlock()
	return tm
}

// BroadcastMLStatus notifies all registered subscribers with a fresh `MLStatus` snapshot (used when
// background teacher model download progress ticks).
func (e *Engine) BroadcastMLStatus() {
	e.mu.Lock()
	st := e.buildMLStatusLocked()
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()
	e.notifyMLUpdated(st, subs)
}

// SessionTraceFrames returns the saved raw telemetry frames for `sessionID` (decoded from `.rfbin`)
// so past Practice sessions render interactive `Signals` curves even after app restarts.
func (e *Engine) SessionTraceFrames(sessionID string) ([]domain.TimerTelemetryFrame, error) {
	e.mu.RLock()
	ts := e.traceStore
	e.mu.RUnlock()
	if ts == nil {
		return nil, nil
	}
	samples, err := ts.ReadSession(strings.TrimSpace(sessionID))
	if err != nil || len(samples) == 0 {
		return nil, err
	}
	return tracestore.ToTelemetryFrames(samples), nil
}

func (e *Engine) ensureMLInitializedLocked() {
	if e.mlDetectors == nil {
		e.mlDetectors = make(map[detKey]*ml.StreamDetector)
	}
	if e.mlLiveTunes == nil {
		e.mlLiveTunes = make(map[detKey]domain.MLLiveGateTune)
	}
	if e.mlState.Config.DetectorMode == "" {
		e.mlState.Config = domain.DefaultMLConfig()
	}
	if e.mlState.Config.ActiveModelID == "" {
		e.mlState.Config.ActiveModelID = "ai-base-v0"
	}
	if e.mlState.Config.TeacherPackID == "" {
		e.mlState.Config.TeacherPackID = ml.DefaultTeacherPackID
	}
}

func (e *Engine) resolveActiveTCNLocked() *ml.TCN {
	e.ensureMLInitializedLocked()
	if e.mlActiveTCN != nil && e.mlActiveModelID == e.mlState.Config.ActiveModelID {
		return e.mlActiveTCN
	}
	targetID := e.mlState.Config.ActiveModelID
	for _, snap := range e.mlState.Models {
		if snap.ModelID == targetID && len(snap.Weights) == ml.TotalParams {
			m := &ml.TCN{}
			if m.ImportWeights(snap.Weights) {
				e.mlActiveTCN = m
				e.mlActiveModelID = targetID
				return m
			}
		}
	}
	baseTCN, _ := ml.PretrainedBaseModel()
	e.mlActiveTCN = baseTCN
	e.mlActiveModelID = "ai-base-v0"
	return baseTCN
}

func (e *Engine) rebuildLiveTuneMapLocked() {
	e.mlLiveTunes = make(map[detKey]domain.MLLiveGateTune, len(e.mlState.LiveTunes))
	for _, lt := range e.mlState.LiveTunes {
		e.mlLiveTunes[detKey{lt.GateID, lt.SlotIndex}] = lt
	}
}

func (e *Engine) syncLiveTuneSliceLocked() {
	list := make([]domain.MLLiveGateTune, 0, len(e.mlLiveTunes))
	for _, lt := range e.mlLiveTunes {
		list = append(list, lt)
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].GateID != list[j].GateID {
			return list[i].GateID < list[j].GateID
		}
		return list[i].SlotIndex < list[j].SlotIndex
	})
	e.mlState.LiveTunes = list
}

func (e *Engine) resetMLSessionDetectorsLocked() {
	for _, d := range e.mlDetectors {
		d.ResetSession()
	}
}

func (e *Engine) notifyMLUpdated(status domain.MLStatus, subs []EventSubscriber) {
	for _, s := range subs {
		if ms, ok := s.(MLEventSubscriber); ok {
			ms.OnMLUpdated(status)
		}
	}
}

func (e *Engine) buildMLStatusLocked() domain.MLStatus {
	e.ensureMLInitializedLocked()
	e.ensurePracticeStateInitializedLocked()
	ts := e.ensureTraceStoreLocked()

	builtinSum := ml.PretrainedBaseSummary()
	models := make([]domain.MLModelSummary, 0, 1+len(e.mlState.Models))
	hasBuiltin := false
	for i := range e.mlState.Models {
		if e.mlState.Models[i].ModelID == builtinSum.ModelID {
			hasBuiltin = true
			e.mlState.Models[i].BuiltIn = true
			e.mlState.Models[i].Ready = true
			if e.mlState.Models[i].Name == "" || strings.HasPrefix(e.mlState.Models[i].Name, "AI Base v0") {
				e.mlState.Models[i].Name = builtinSum.Name
			}
		}
		models = append(models, e.mlState.Models[i].MLModelSummary)
	}
	if !hasBuiltin {
		models = append(models, builtinSum)
	}
	// Newest version first, built-in v0 last
	sort.SliceStable(models, func(i, j int) bool {
		return models[i].Version > models[j].Version
	})

	var verifiedPacks, unverifiedPacks, totalRecorded, verifiedPasses int
	for _, s := range e.practiceState.Sessions {
		hasData := s.TraceSampleCount > 0 || len(s.Crossings) > 0 || len(s.Laps) > 0
		if !hasData {
			continue
		}
		totalRecorded++
		if s.TrainingVerified {
			verifiedPacks++
			for _, c := range s.Crossings {
				if c.InvalidReason == "" || c.Manual {
					verifiedPasses++
				}
			}
		} else {
			unverifiedPacks++
		}
	}

	e.syncLiveTuneSliceLocked()
	teacherSt := e.mlTeacher.Status(e.mlState.Config.TeacherPackID)
	return domain.MLStatus{
		Config:             e.mlState.Config,
		Training:           e.mlTraining,
		Teacher:            teacherSt,
		Models:             models,
		VerifiedPacks:      verifiedPacks,
		UnverifiedPacks:    unverifiedPacks,
		TotalRecordedPacks: totalRecorded,
		VerifiedPasses:     verifiedPasses,
		StorageBytes:       ts.TotalBytes(),
		LiveTunes:          append([]domain.MLLiveGateTune(nil), e.mlState.LiveTunes...),
	}
}

// MLStatus returns the current AI detector config, dataset statistics, saved model summaries,
// and active training progress.
func (e *Engine) MLStatus() domain.MLStatus {
	e.mu.Lock()
	st := e.buildMLStatusLocked()
	e.mu.Unlock()
	return st
}

// MLConfigPayload updates the active detector mode, model ID, live 2-lap tuning toggle, or Teacher settings.
type MLConfigPayload struct {
	DetectorMode     *string `json:"detectorMode,omitempty"`
	ActiveModelID    *string `json:"activeModelId,omitempty"`
	LiveTuneEnabled  *bool   `json:"liveTuneEnabled,omitempty"`
	TeacherPackID    *string `json:"teacherPackId,omitempty"`
	AutoLabelOnTrain *bool   `json:"autoLabelOnTrain,omitempty"`
	ResetLiveTunes   bool    `json:"resetLiveTunes,omitempty"`
}

// UpdateMLConfig applies changes to `MLConfig` and hot-swaps the active TCN weights if needed.
func (e *Engine) UpdateMLConfig(req MLConfigPayload) (domain.MLStatus, error) {
	// Warm built-in model outside Engine.mu so switching to AI mode never holds the lock during init.
	if req.DetectorMode != nil && strings.EqualFold(strings.TrimSpace(*req.DetectorMode), string(domain.DetectorModeAI)) {
		_, _ = ml.PretrainedBaseModel()
	}
	e.mu.Lock()
	e.ensureMLInitializedLocked()

	if req.DetectorMode != nil {
		mode := strings.ToLower(strings.TrimSpace(*req.DetectorMode))
		switch domain.DetectorMode(mode) {
		case domain.DetectorModeClassic, domain.DetectorModeAI:
			e.mlState.Config.DetectorMode = domain.DetectorMode(mode)
		default:
			st := e.buildMLStatusLocked()
			e.mu.Unlock()
			return st, fmt.Errorf("invalid detectorMode %q (expected \"classic\" or \"ai\")", *req.DetectorMode)
		}
	}

	if req.ActiveModelID != nil {
		id := strings.TrimSpace(*req.ActiveModelID)
		found := id == "ai-base-v0"
		for _, m := range e.mlState.Models {
			if m.ModelID == id {
				if len(m.Weights) != ml.TotalParams {
					st := e.buildMLStatusLocked()
					e.mu.Unlock()
					return st, fmt.Errorf("model %q has not been trained yet", m.Name)
				}
				found = true
				break
			}
		}
		if !found {
			st := e.buildMLStatusLocked()
			e.mu.Unlock()
			return st, fmt.Errorf("unknown modelId %q", id)
		}
		if e.mlState.Config.ActiveModelID != id {
			e.mlState.Config.ActiveModelID = id
			e.mlActiveTCN = nil
			tcn := e.resolveActiveTCNLocked()
			for _, det := range e.mlDetectors {
				det.SetModel(tcn)
			}
			// Reset live tunes when switching base models since embedding coordinates changed
			e.mlLiveTunes = make(map[detKey]domain.MLLiveGateTune)
			e.syncLiveTuneSliceLocked()
		}
	}

	if req.LiveTuneEnabled != nil {
		e.mlState.Config.LiveTuneEnabled = *req.LiveTuneEnabled
	}
	if req.TeacherPackID != nil {
		tp := strings.TrimSpace(*req.TeacherPackID)
		if _, ok := ml.FindTeacherPack(tp); !ok {
			st := e.buildMLStatusLocked()
			e.mu.Unlock()
			return st, fmt.Errorf("unknown teacherPackId %q", tp)
		}
		e.mlState.Config.TeacherPackID = tp
	}
	if req.AutoLabelOnTrain != nil {
		e.mlState.Config.AutoLabelOnTrain = *req.AutoLabelOnTrain
	}
	if req.ResetLiveTunes {
		e.mlLiveTunes = make(map[detKey]domain.MLLiveGateTune)
		e.syncLiveTuneSliceLocked()
	}

	st := e.buildMLStatusLocked()
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	e.notifyMLUpdated(st, subs)
	return st, nil
}

// recomputeLiveGateTunesLocked fits 24-weight per-(gate, pilot) logistic heads in `< 5 ms` from
// the current session's L3 embeddings, accepted crossings, cross-gate bleed timestamps, and
// human-deleted (`x`) negative marks.
func (e *Engine) recomputeLiveGateTunesLocked(slotIndex int, manualDeleted []domain.ManualDeletedCrossing) bool {
	e.ensureMLInitializedLocked()
	if e.mlState.Config.DetectorMode != domain.DetectorModeAI || !e.mlState.Config.LiveTuneEnabled {
		return false
	}
	tcn := e.resolveActiveTCNLocked()
	baseW, baseB := tcn.BaseHead()

	lapsCount := 0
	for _, l := range e.laps {
		if l.SlotIndex == slotIndex && !l.Invalidated {
			lapsCount++
		}
	}

	var allPilotCrossings []domain.GateCrossingEvent
	posByGate := make(map[uint8][]ml.CrossingLabel)
	hasManualEdit := len(manualDeleted) > 0
	for _, c := range e.crossings {
		if c.SlotIndex != slotIndex {
			continue
		}
		if c.Manual {
			hasManualEdit = true
		}
		if c.InvalidReason != "" && !c.Manual {
			continue
		}
		posByGate[c.GateID] = append(posByGate[c.GateID], ml.CrossingLabel{
			TimestampUs: c.TimestampUs,
			Manual:      c.Manual,
		})
		allPilotCrossings = append(allPilotCrossings, c)
	}

	// Only auto-tune once at least 2 laps are completed OR the pilot made an explicit +/x edit!
	if lapsCount < 2 && !hasManualEdit {
		return false
	}

	updatedAny := false
	for _, g := range e.gates {
		key := detKey{g.GateID, slotIndex}
		det := e.mlDetectors[key]
		if det == nil || len(det.Embeddings()) < 50 {
			continue
		}
		pos := posByGate[g.GateID]
		if len(pos) == 0 {
			continue
		}
		var negs []ml.NegativeMark
		for _, other := range allPilotCrossings {
			if other.GateID != g.GateID {
				negs = append(negs, ml.NegativeMark{
					TimestampUs: other.TimestampUs,
					Weight:      3.5,
				})
			}
		}
		for _, del := range manualDeleted {
			if del.GateID == g.GateID && del.SlotIndex == slotIndex {
				negs = append(negs, ml.NegativeMark{
					TimestampUs: del.TimestampUs,
					Weight:      6.0,
				})
			}
		}
		for _, f := range e.filtered {
			if f.GateID == g.GateID && f.SlotIndex == slotIndex {
				negs = append(negs, ml.NegativeMark{
					TimestampUs: f.TimestampUs,
					Weight:      3.5,
				})
			}
		}
		if tune, ok := ml.FitLiveGateHead(g.GateID, slotIndex, lapsCount, det.Embeddings(), pos, negs, baseW, baseB); ok {
			e.mlLiveTunes[key] = tune
			updatedAny = true
		}
	}
	if updatedAny {
		e.syncLiveTuneSliceLocked()
	}
	return updatedAny
}

// ---------------------------------------------------------------------------
// Raw `.rfbin` Session Recording & Hands-Free Pack Loop
// ---------------------------------------------------------------------------

func (e *Engine) recordPracticeTraceAndPackLoopLocked(
	gate domain.TrackGate,
	frame domain.TimerTelemetryFrame,
	rawRSSI [domain.MaxPilotPoolSize]float32,
) (packSplit bool, quietTick bool) {
	if e.isLiveRaceHeatActiveLocked() || e.practiceState.ActiveSessionID == "" {
		return false, false
	}
	sess := e.findPracticeSessionLocked(e.practiceState.ActiveSessionID)
	if sess == nil || !sess.Active || sess.Paused || !e.raceArmed {
		return false, false
	}

	ts := e.ensureTraceStoreLocked()

	// Collect active session pilot slots (1..MaxPilotPoolSize)
	var slots []uint8
	var rssis []float32
	maxFrameExcess := float32(-999.0)
	floor := frame.NoiseFloorDbm
	if floor > -65.0 || floor < -115.0 {
		floor = -91.0
	}

	for _, sp := range sess.Pilots {
		if sp.SlotIndex < 1 || sp.SlotIndex > domain.MaxPilotPoolSize || sp.Channel == 0 {
			continue
		}
		r := rawRSSI[sp.SlotIndex-1]
		slots = append(slots, uint8(sp.SlotIndex))
		rssis = append(rssis, r)
		if r > -120.0 {
			ex := r - floor
			if ex > maxFrameExcess {
				maxFrameExcess = ex
			}
		}
	}
	if len(slots) == 0 {
		for i := 0; i < len(e.pilots) && i < domain.MaxPilotPoolSize; i++ {
			p := e.pilots[i]
			if p.Enabled && p.Channel > 0 && p.SlotIndex >= 1 && p.SlotIndex <= domain.MaxPilotPoolSize {
				r := rawRSSI[i]
				slots = append(slots, uint8(p.SlotIndex))
				rssis = append(rssis, r)
				if r > -120.0 {
					ex := r - floor
					if ex > maxFrameExcess {
						maxFrameExcess = ex
					}
				}
			}
		}
	}

	if len(slots) > 0 {
		ts.Append(sess.SessionID, tracestore.Sample{
			GateID:        gate.GateID,
			SeqNum:        frame.SeqNum,
			TimestampUs:   frame.TimestampUs,
			NoiseFloorDbm: floor,
			SlotIndices:   slots,
			RSSIDbm:       rssis,
		})
		sess.TraceSampleCount++
		if e.activeTraceFirstTsUs == 0 || frame.TimestampUs < e.activeTraceFirstTsUs {
			e.activeTraceFirstTsUs = frame.TimestampUs
		}
		if frame.TimestampUs > e.activeTraceFirstTsUs {
			sess.TraceDurationSec = math.Round(float64(frame.TimestampUs-e.activeTraceFirstTsUs)/1e4) / 100.0
		}
	}

	// Hands-Free Pack Loop state machine
	if !e.practiceState.PackLoopEnabled || len(slots) == 0 {
		return false, false
	}
	if e.packLoopGateObs == nil {
		e.packLoopGateObs = make(map[uint8]gateSignalObs)
	}
	if maxFrameExcess > -500.0 {
		e.packLoopGateObs[gate.GateID] = gateSignalObs{
			excessDb: maxFrameExcess,
			tsUs:     frame.TimestampUs,
		}
	}

	// Compute max excess across all gates seen within the last 2.0 seconds
	trackMaxExcess := float32(0.0)
	hasRecentGate := false
	for gid, obs := range e.packLoopGateObs {
		if frame.TimestampUs > obs.tsUs && frame.TimestampUs-obs.tsUs > 2_000_000 {
			delete(e.packLoopGateObs, gid)
			continue
		}
		if !hasRecentGate || obs.excessDb > trackMaxExcess {
			trackMaxExcess = obs.excessDb
			hasRecentGate = true
		}
	}
	if !hasRecentGate {
		return false, false
	}

	quietLimitSec := e.practiceState.PackLoopQuietSec
	if quietLimitSec < minPackLoopQuietSec {
		quietLimitSec = defaultPackLoopQuietSec
		e.practiceState.PackLoopQuietSec = quietLimitSec
	}

	validLapCount := 0
	for _, l := range e.laps {
		if !l.Invalidated {
			validLapCount++
		}
	}

	prevState := e.practiceState.PackLoopState
	if validLapCount == 0 {
		e.packLoopQuietSinceUs = 0
		e.practiceState.PackLoopQuietElapsed = 0
		if trackMaxExcess >= 7.5 {
			e.practiceState.PackLoopState = "flying"
		} else {
			e.practiceState.PackLoopState = "waiting_vtx"
		}
		return false, e.practiceState.PackLoopState != prevState
	}

	// At least 1 valid lap completed in this pack: watch for 25s VTX power-off lull (`<= 4.5 dB` excess)
	if trackMaxExcess >= 6.0 {
		wasSealing := e.packLoopQuietSinceUs != 0
		e.packLoopQuietSinceUs = 0
		e.packLoopLastTickSec = 0
		e.practiceState.PackLoopQuietElapsed = 0
		e.practiceState.PackLoopState = "flying"
		return false, wasSealing || prevState != "flying"
	}

	if trackMaxExcess <= 4.5 {
		if e.packLoopQuietSinceUs == 0 || frame.TimestampUs < e.packLoopQuietSinceUs {
			e.packLoopQuietSinceUs = frame.TimestampUs
			e.packLoopLastTickSec = 0
			e.practiceState.PackLoopState = "quiet_sealing"
			e.practiceState.PackLoopQuietElapsed = 0
			return false, true
		}
		elapsedSec := float64(frame.TimestampUs-e.packLoopQuietSinceUs) / 1e6
		e.practiceState.PackLoopState = "quiet_sealing"
		e.practiceState.PackLoopQuietElapsed = math.Round(elapsedSec*10) / 10
		if elapsedSec >= float64(quietLimitSec) {
			_ = e.sealAndAdvancePackLocked()
			return true, false
		}
		wholeSec := int(elapsedSec)
		if wholeSec > e.packLoopLastTickSec {
			e.packLoopLastTickSec = wholeSec
			return false, true
		}
	}
	return false, false
}

func ensureTagPresent(tags []string, tag string) []string {
	for _, t := range tags {
		if strings.EqualFold(t, tag) {
			return domain.NormalizeRaceTags(tags)
		}
	}
	return domain.NormalizeRaceTags(append(append([]string(nil), tags...), tag))
}

func (e *Engine) nextPackSessionNameLocked() string {
	for n := 1; n < 10000; n++ {
		cand := fmt.Sprintf("Pack %d", n)
		if e.findDuplicatePracticeBySlugLocked(cand, "") == nil {
			return cand
		}
	}
	return e.nextDefaultPracticeNameLocked()
}

// sealAndAdvancePackLocked seals the currently active PracticeSession (if any) and immediately
// creates & arms the next back-to-back Pack session inheriting its pilots, track, and timing rules.
func (e *Engine) sealAndAdvancePackLocked() string {
	now := nowISO()
	ts := e.ensureTraceStoreLocked()

	var templatePilots []domain.PracticeSessionPilot
	var templateGates []domain.TrackGate
	var templateRules *domain.TimingRules
	var templateTags []string

	if e.practiceState.ActiveSessionID != "" {
		e.syncActivePracticeRecordsLocked()
		if cur := e.findPracticeSessionLocked(e.practiceState.ActiveSessionID); cur != nil {
			e.ensurePracticeTrackInitializedLocked(cur)
			sum := ts.SealSession(cur.SessionID)
			if sum.SampleCount > cur.TraceSampleCount {
				cur.TraceSampleCount = sum.SampleCount
			}
			if sum.DurationSec > cur.TraceDurationSec {
				cur.TraceDurationSec = math.Round(sum.DurationSec*100) / 100
			}
			cur.Tags = ensureTagPresent(cur.Tags, "ai-pack")
			cur.Active = false
			cur.Paused = false
			cur.UpdatedAt = now
			cur.Summaries = e.computePracticeSessionSummariesLocked(cur)

			validLaps := 0
			for _, l := range cur.Laps {
				if !l.Invalidated {
					validLaps++
				}
			}
			e.practiceState.LastSealedSessionID = cur.SessionID
			e.practiceState.LastSealedLapCount = validLaps

			templatePilots = append([]domain.PracticeSessionPilot(nil), cur.Pilots...)
			templateGates = cloneTrackGates(cur.TrackSnapshot)
			templateRules = cloneTimingRulesPtr(cur.Rules, e.rules)
			templateTags = append([]string(nil), cur.Tags...)
		}
	}

	if len(templateGates) == 0 && e.practiceState.SelectedSessionID != "" {
		if sel := e.findPracticeSessionLocked(e.practiceState.SelectedSessionID); sel != nil && (len(sel.Pilots) > 0 || len(sel.Laps) > 0) {
			if len(sel.TrackSnapshot) > 0 {
				templateGates = cloneTrackGates(sel.TrackSnapshot)
			}
			if len(templatePilots) == 0 && len(sel.Pilots) > 0 {
				templatePilots = append([]domain.PracticeSessionPilot(nil), sel.Pilots...)
			}
			if templateRules == nil && sel.Rules != nil {
				templateRules = cloneTimingRulesPtr(sel.Rules, e.rules)
			}
		}
	}
	if len(templateGates) == 0 {
		for i := len(e.practiceState.Sessions) - 1; i >= 0; i-- {
			s := &e.practiceState.Sessions[i]
			if len(s.TrackSnapshot) > 0 && (len(s.Pilots) > 0 || len(s.Laps) > 0) {
				templateGates = cloneTrackGates(s.TrackSnapshot)
				if len(templatePilots) == 0 && len(s.Pilots) > 0 {
					templatePilots = append([]domain.PracticeSessionPilot(nil), s.Pilots...)
				}
				if templateRules == nil && s.Rules != nil {
					templateRules = cloneTimingRulesPtr(s.Rules, e.rules)
				}
				break
			}
		}
	}
	if len(templateGates) == 0 && len(e.gates) > 0 {
		templateGates = e.snapshotOrderedGatesLocked()
	}
	if len(templateGates) == 0 {
		templateGates = e.defaultNewTrackGatesLocked()
	}
	if templateRules == nil {
		templateRules = cloneTimingRulesPtr(nil, e.rules)
	}
	if len(templatePilots) == 0 {
		// Default to first enabled pilot or Slot 1 if available so Pack 1 starts ready to fly
		for _, p := range e.pilots {
			if p.Enabled && p.Channel > 0 {
				templatePilots = append(templatePilots, domain.PracticeSessionPilot{
					SlotIndex:    p.SlotIndex,
					Callsign:     p.Callsign,
					PhoneticName: p.PhoneticName,
					Color:        p.Color,
					Band:         p.Band,
					Channel:      p.Channel,
					FrequencyMHz: p.FrequencyMHz,
				})
			}
		}
		if len(templatePilots) == 0 && len(e.pilots) > 0 {
			p := e.pilots[0]
			ch := p.Channel
			freq := p.FrequencyMHz
			band := p.Band
			if ch == 0 {
				band = domain.BandRaceband
				ch = 1
				freq = domain.FrequencyForBandChannel(band, ch)
			}
			templatePilots = append(templatePilots, domain.PracticeSessionPilot{
				SlotIndex:    p.SlotIndex,
				Callsign:     p.Callsign,
				PhoneticName: p.PhoneticName,
				Color:        p.Color,
				Band:         band,
				Channel:      ch,
				FrequencyMHz: freq,
			})
		}
	}
	templateTags = ensureTagPresent(templateTags, "ai-pack")

	newID := e.nextUniqueIDLocked("session")
	newName := e.nextPackSessionNameLocked()
	newSess := domain.PracticeSession{
		SessionID:        newID,
		Name:             newName,
		Tags:             templateTags,
		Active:           true,
		Paused:           false,
		CreatedAt:        now,
		UpdatedAt:        now,
		Pilots:           templatePilots,
		TrackInitialized: true,
		TrackSnapshot:    templateGates,
		Rules:            templateRules,
		Laps:             []domain.LapRecord{},
		Crossings:        []domain.GateCrossingEvent{},
		Filtered:         []domain.FilteredDetection{},
		Summaries:        []domain.PilotTrackSummary{},
	}
	for i := range e.practiceState.Sessions {
		e.practiceState.Sessions[i].Active = false
	}
	e.practiceState.Sessions = append(e.practiceState.Sessions, newSess)
	e.practiceState.ActiveSessionID = newID
	e.practiceState.SelectedSessionID = newID
	e.practiceState.PackLoopState = "waiting_vtx"
	e.practiceState.PackLoopQuietElapsed = 0
	e.packLoopQuietSinceUs = 0
	e.packLoopLastTickSec = 0
	e.activeTraceFirstTsUs = 0
	e.resetMLSessionDetectorsLocked()

	created := e.findPracticeSessionLocked(newID)
	if created != nil {
		e.applyPracticeSessionToEngineLocked(created)
	}
	return newID
}

// CreateMLModel registers a new untrained custom model (`epochsTrained=0`, `ready=false`) with a
// globally unique immutable `mdl-*` identifier so the user can add named models and train them on-demand.
func (e *Engine) CreateMLModel(name string) (domain.MLStatus, error) {
	trimmed := strings.TrimSpace(name)
	e.mu.Lock()
	e.ensureMLInitializedLocked()
	if trimmed == "" {
		st := e.buildMLStatusLocked()
		e.mu.Unlock()
		return st, errors.New("model name is required")
	}
	baseSum := ml.PretrainedBaseSummary()
	if strings.EqualFold(trimmed, baseSum.Name) {
		st := e.buildMLStatusLocked()
		e.mu.Unlock()
		return st, fmt.Errorf("a model named %q already exists", trimmed)
	}
	for _, m := range e.mlState.Models {
		if strings.EqualFold(strings.TrimSpace(m.Name), trimmed) {
			st := e.buildMLStatusLocked()
			e.mu.Unlock()
			return st, fmt.Errorf("a model named %q already exists", trimmed)
		}
	}

	nextVer := 1
	for _, m := range e.mlState.Models {
		if m.Version >= nextVer {
			nextVer = m.Version + 1
		}
	}
	snap := domain.MLModelSnapshot{
		MLModelSummary: domain.MLModelSummary{
			ModelID:       newModelID(),
			Name:          trimmed,
			Version:       nextVer,
			CreatedAt:     nowISO(),
			BuiltIn:       false,
			Ready:         false,
			EpochsTrained: 0,
		},
	}
	e.mlState.Models = append(e.mlState.Models, snap)
	st := e.buildMLStatusLocked()
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	e.notifyMLUpdated(st, subs)
	return st, nil
}

// MLModelUpdatePayload updates a saved custom model's display name or Ready state.
type MLModelUpdatePayload struct {
	Name  *string `json:"name,omitempty"`
	Ready *bool   `json:"ready,omitempty"`
}

// UpdateMLModel renames a saved model or marks/unmarks it Ready for Race & Practice selection.
func (e *Engine) UpdateMLModel(modelID string, req MLModelUpdatePayload) (domain.MLStatus, error) {
	id := strings.TrimSpace(modelID)
	e.mu.Lock()
	e.ensureMLInitializedLocked()

	idx := -1
	for i := range e.mlState.Models {
		if e.mlState.Models[i].ModelID == id {
			idx = i
			break
		}
	}
	if id == "ai-base-v0" {
		st := e.buildMLStatusLocked()
		e.mu.Unlock()
		return st, fmt.Errorf("1P built-in model %q cannot be renamed", id)
	}
	if idx < 0 {
		st := e.buildMLStatusLocked()
		e.mu.Unlock()
		return st, fmt.Errorf("unknown modelId %q", id)
	}
	if e.mlState.Models[idx].BuiltIn && req.Name != nil {
		st := e.buildMLStatusLocked()
		e.mu.Unlock()
		return st, fmt.Errorf("1P built-in model %q cannot be renamed", id)
	}

	if req.Name != nil {
		trimmed := strings.TrimSpace(*req.Name)
		if trimmed != "" {
			e.mlState.Models[idx].Name = trimmed
		}
	}
	if req.Ready != nil {
		e.mlState.Models[idx].Ready = *req.Ready
		if !*req.Ready && e.mlState.Config.ActiveModelID == id {
			e.fallbackActiveReadyModelLocked()
		}
	}

	st := e.buildMLStatusLocked()
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	e.notifyMLUpdated(st, subs)
	return st, nil
}

// DeleteMLModel removes a custom model snapshot and falls back cleanly if it was active.
func (e *Engine) DeleteMLModel(modelID string) (domain.MLStatus, error) {
	id := strings.TrimSpace(modelID)
	e.mu.Lock()
	e.ensureMLInitializedLocked()

	if id == "ai-base-v0" {
		st := e.buildMLStatusLocked()
		e.mu.Unlock()
		return st, fmt.Errorf("1P built-in model %q cannot be deleted", id)
	}

	idx := -1
	for i := range e.mlState.Models {
		if e.mlState.Models[i].ModelID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		st := e.buildMLStatusLocked()
		e.mu.Unlock()
		return st, fmt.Errorf("unknown modelId %q", id)
	}
	if e.mlState.Models[idx].BuiltIn {
		st := e.buildMLStatusLocked()
		e.mu.Unlock()
		return st, fmt.Errorf("1P built-in model %q cannot be deleted", id)
	}

	e.mlState.Models = append(e.mlState.Models[:idx], e.mlState.Models[idx+1:]...)
	if e.mlState.Config.ActiveModelID == id {
		e.fallbackActiveReadyModelLocked()
	}

	st := e.buildMLStatusLocked()
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	e.notifyMLUpdated(st, subs)
	return st, nil
}

func (e *Engine) fallbackActiveReadyModelLocked() {
	for i := len(e.mlState.Models) - 1; i >= 0; i-- {
		if !e.mlState.Models[i].BuiltIn {
			e.mlState.Config.ActiveModelID = e.mlState.Models[i].ModelID
			e.mlActiveTCN = nil
			tcn := e.resolveActiveTCNLocked()
			for _, det := range e.mlDetectors {
				det.SetModel(tcn)
			}
			e.mlLiveTunes = make(map[detKey]domain.MLLiveGateTune)
			e.syncLiveTuneSliceLocked()
			return
		}
	}
	e.mlState.Config.ActiveModelID = "ai-base-v0"
	e.mlActiveTCN = nil
	tcn := e.resolveActiveTCNLocked()
	for _, det := range e.mlDetectors {
		det.SetModel(tcn)
	}
	e.mlLiveTunes = make(map[detKey]domain.MLLiveGateTune)
	e.syncLiveTuneSliceLocked()
}

// ---------------------------------------------------------------------------
// On-Device System 1 Teacher Management & RSSI Auto-Labeling
// ---------------------------------------------------------------------------

// StartTeacherDownload starts or resumes downloading an on-device `.gguf` teacher pack.
func (e *Engine) StartTeacherDownload(packID string) (domain.MLStatus, error) {
	e.mu.Lock()
	e.ensureMLInitializedLocked()
	tm := e.mlTeacher
	trimmed := strings.TrimSpace(packID)
	if trimmed == "" {
		trimmed = e.mlState.Config.TeacherPackID
	}
	if _, ok := ml.FindTeacherPack(trimmed); ok {
		e.mlState.Config.TeacherPackID = trimmed
	}
	e.mu.Unlock()

	if tm == nil {
		return e.MLStatus(), errors.New("on-device AI labeler download requires SlapRF Android or SlapRF Portable")
	}
	if err := tm.StartDownload(trimmed); err != nil {
		return e.MLStatus(), err
	}
	st := e.MLStatus()
	return st, nil
}

// CancelTeacherDownload cancels an active `.gguf` download while retaining `.part` bytes for resume.
func (e *Engine) CancelTeacherDownload() domain.MLStatus {
	e.mu.RLock()
	tm := e.mlTeacher
	e.mu.RUnlock()
	if tm != nil {
		tm.CancelDownload()
	}
	return e.MLStatus()
}

// DeleteTeacherPack removes a cached `.gguf` teacher model pack from local storage.
func (e *Engine) DeleteTeacherPack(packID string) (domain.MLStatus, error) {
	e.mu.RLock()
	tm := e.mlTeacher
	e.mu.RUnlock()
	if tm == nil {
		return e.MLStatus(), nil
	}
	err := tm.DeletePack(packID)
	return e.MLStatus(), err
}

// MLSessionLabelRequest configures `POST /v1/ml/sessions/{sessionId}:label`.
type MLSessionLabelRequest struct {
	DryRun    bool   `json:"dryRun"`
	SlotIndex int    `json:"slotIndex,omitempty"`
	PackID    string `json:"packId,omitempty"`
}

// MLSessionLabelResponse returns the System 1 Teacher's decisions and (when `!DryRun`) the updated state.
type MLSessionLabelResponse struct {
	SessionID      string                        `json:"sessionId"`
	PackID         string                        `json:"packId"`
	DryRun         bool                          `json:"dryRun"`
	CandidateCount int                           `json:"candidateCount"`
	CrossingsCount int                           `json:"crossingsCount"`
	HardNegsCount  int                           `json:"hardNegsCount"`
	Decisions      []ml.CandidateDecision        `json:"decisions"`
	Practice       *domain.PracticeManagerState  `json:"practice,omitempty"`
	MLStatus       domain.MLStatus               `json:"mlStatus"`
}

// LabelPracticeSession runs the on-device System 1 Qwen3 Teacher on `sessionID`'s `.rfbin` trace.
// When `req.DryRun == true`, decisions are returned without mutating stored crossings so the RSSI
// Editor can stage them interactively; when `false`, unedited crossings and `TeacherHardNegs` are
// updated while preserving any human manual pins (`+`/drag) and deletions (`x`).
func (e *Engine) LabelPracticeSession(ctx context.Context, sessionID string, req MLSessionLabelRequest) (MLSessionLabelResponse, error) {
	e.mu.Lock()
	e.ensureMLInitializedLocked()
	e.ensurePracticeStateInitializedLocked()

	targetID := strings.TrimSpace(sessionID)
	if targetID == "" || strings.EqualFold(targetID, "current") {
		targetID = e.practiceState.SelectedSessionID
		if targetID == "" {
			targetID = e.practiceState.ActiveSessionID
		}
	}
	target := e.findPracticeSessionLocked(targetID)
	if target == nil {
		st := e.buildMLStatusLocked()
		e.mu.Unlock()
		return MLSessionLabelResponse{MLStatus: st}, fmt.Errorf("practice session %q not found", sessionID)
	}
	if target.Active && e.practiceState.ActiveSessionID == target.SessionID && !e.isLiveRaceHeatActiveLocked() && len(e.crossings) > len(target.Crossings) {
		e.syncActivePracticeRecordsLocked()
	}

	sessSnap := clonePracticeSession(*target)
	ts := e.ensureTraceStoreLocked()
	tm := e.mlTeacher
	prefPack := strings.TrimSpace(req.PackID)
	if prefPack == "" {
		prefPack = e.mlState.Config.TeacherPackID
	}
	e.mu.Unlock()

	samples, err := ts.ReadSession(sessSnap.SessionID)
	if err != nil || len(samples) < 16 {
		return MLSessionLabelResponse{MLStatus: e.MLStatus()}, errors.New("no recorded RSSI waveform (.rfbin) available for this practice session")
	}

	labeler, resolvedPackID, err := tm.ResolveLabeler(prefPack)
	if err != nil {
		return MLSessionLabelResponse{MLStatus: e.MLStatus()}, err
	}

	cands := ml.ExtractSessionCandidates(sessSnap, samples)
	if req.SlotIndex > 0 {
		filtered := cands[:0]
		for _, c := range cands {
			if c.SlotIndex == req.SlotIndex {
				filtered = append(filtered, c)
			}
		}
		cands = filtered
	}
	if len(cands) == 0 {
		st := e.MLStatus()
		return MLSessionLabelResponse{
			SessionID: sessSnap.SessionID,
			PackID:    resolvedPackID,
			DryRun:    req.DryRun,
			Decisions: []ml.CandidateDecision{},
			MLStatus:  st,
		}, nil
	}

	decisions, err := labeler.LabelCandidates(ctx, sessSnap, cands, nil)
	if err != nil {
		return MLSessionLabelResponse{MLStatus: e.MLStatus()}, err
	}

	var crossCount, negCount int
	for _, d := range decisions {
		if d.Label == "crossing" {
			crossCount++
		} else {
			negCount++
		}
	}

	if req.DryRun {
		return MLSessionLabelResponse{
			SessionID:      sessSnap.SessionID,
			PackID:         resolvedPackID,
			DryRun:         true,
			CandidateCount: len(cands),
			CrossingsCount: crossCount,
			HardNegsCount:  negCount,
			Decisions:      decisions,
			MLStatus:       e.MLStatus(),
		}, nil
	}

	e.mu.Lock()
	liveTarget := e.findPracticeSessionLocked(sessSnap.SessionID)
	if liveTarget == nil {
		st := e.buildMLStatusLocked()
		e.mu.Unlock()
		return MLSessionLabelResponse{MLStatus: st}, fmt.Errorf("practice session %q not found", sessSnap.SessionID)
	}
	e.applyTeacherDecisionsLocked(liveTarget, resolvedPackID, req.SlotIndex, decisions)
	practiceSnap := clonePracticeManagerState(e.practiceState)
	mlSnap := e.buildMLStatusLocked()
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	e.notifyPracticeUpdated(practiceSnap, subs)
	e.notifyMLUpdated(mlSnap, subs)

	return MLSessionLabelResponse{
		SessionID:      sessSnap.SessionID,
		PackID:         resolvedPackID,
		DryRun:         false,
		CandidateCount: len(cands),
		CrossingsCount: crossCount,
		HardNegsCount:  negCount,
		Decisions:      decisions,
		Practice:       &practiceSnap,
		MLStatus:       mlSnap,
	}, nil
}

// applyTeacherDecisionsLocked merges System 1 Teacher decisions into `target` while strictly
// preserving all pilot manual crossings (`Manual == true`) and manual deletions (`ManualDeletedCrossings`).
func (e *Engine) applyTeacherDecisionsLocked(
	target *domain.PracticeSession,
	packID string,
	slotFilter int,
	decisions []ml.CandidateDecision,
) {
	orderedGates := e.orderedGatesForPracticeSessionLocked(target)
	callsignBySlot := make(map[int]string, len(target.Pilots))
	for _, sp := range target.Pilots {
		if sp.SlotIndex > 0 && sp.Callsign != "" {
			callsignBySlot[sp.SlotIndex] = sp.Callsign
		}
	}

	var keptCrossings []domain.GateCrossingEvent
	var manualCrossings []domain.GateCrossingEvent
	affectedSlots := make(map[int]bool)

	for _, c := range target.Crossings {
		if slotFilter > 0 && c.SlotIndex != slotFilter {
			keptCrossings = append(keptCrossings, c)
			continue
		}
		affectedSlots[c.SlotIndex] = true
		if c.Manual {
			keptCrossings = append(keptCrossings, c)
			manualCrossings = append(manualCrossings, c)
		}
	}

	var keptHardNegs []domain.TeacherNegativeMark
	for _, hn := range target.TeacherHardNegs {
		if slotFilter > 0 && hn.SlotIndex != slotFilter {
			keptHardNegs = append(keptHardNegs, hn)
		}
	}

	for _, dec := range decisions {
		if slotFilter > 0 && dec.SlotIndex != slotFilter {
			continue
		}
		affectedSlots[dec.SlotIndex] = true
		if dec.Label == "crossing" {
			if dec.Confidence < 0.50 {
				continue
			}
			// Respect explicit human `x` deletions and manual `+` pins!
			blocked := false
			for _, del := range target.ManualDeletedCrossings {
				if del.GateID == dec.GateID && del.SlotIndex == dec.SlotIndex && absDiffUs(del.TimestampUs, dec.FinalTsUs) <= 180_000 {
					blocked = true
					break
				}
			}
			if !blocked {
				for _, mc := range manualCrossings {
					if mc.GateID == dec.GateID && mc.SlotIndex == dec.SlotIndex && absDiffUs(mc.TimestampUs, dec.FinalTsUs) <= 220_000 {
						blocked = true
						break
					}
				}
			}
			if blocked {
				continue
			}
			pk := dec.PeakDbm
			ev, err := e.newManualCrossingEventLocked(orderedGates, dec.GateID, dec.SlotIndex, dec.FinalTsUs, &pk, callsignBySlot[dec.SlotIndex])
			if err != nil {
				continue
			}
			ev.Manual = false // AI-labeled rather than human manual override
			for _, c := range keptCrossings {
				if c.EventID >= ev.EventID {
					ev.EventID = c.EventID + 1
					e.nextEventID = ev.EventID
				}
			}
			keptCrossings = append(keptCrossings, ev)
		} else {
			keptHardNegs = append(keptHardNegs, domain.TeacherNegativeMark{
				GateID:      dec.GateID,
				SlotIndex:   dec.SlotIndex,
				TimestampUs: dec.FinalTsUs,
				Label:       dec.Label,
				Confidence:  dec.Confidence,
				PeakRSSIDbm: dec.PeakDbm,
			})
		}
	}

	sort.Slice(keptCrossings, func(i, j int) bool {
		return keptCrossings[i].TimestampUs < keptCrossings[j].TimestampUs
	})
	target.Crossings = keptCrossings
	target.TeacherHardNegs = keptHardNegs
	target.TeacherLabeledAt = nowISO()
	target.TeacherPackID = packID

	sessionRules := e.rules
	if target.Rules != nil {
		sessionRules = target.Rules.Normalized()
	}

	slotsList := make([]int, 0, len(affectedSlots))
	for sl := range affectedSlots {
		if sl > 0 {
			slotsList = append(slotsList, sl)
		}
	}
	sort.Ints(slotsList)
	for _, sl := range slotsList {
		target.Crossings, target.Laps = e.replayPilotCrossingsLocked(
			target.Crossings,
			target.Laps,
			orderedGates,
			e.detected,
			sessionRules,
			sl,
			callsignBySlot[sl],
		)
	}
	e.recomputePracticeSessionLapsLocked(target)
	target.UpdatedAt = nowISO()
	target.Summaries = e.computePracticeSessionSummariesLocked(target)

	isActive := target.Active && e.practiceState.ActiveSessionID == target.SessionID && !e.isLiveRaceHeatActiveLocked()
	if isActive {
		e.crossings = append([]domain.GateCrossingEvent(nil), target.Crossings...)
		e.syncActivePracticeLapsLocked(target)
		for _, sl := range slotsList {
			e.rebuildPilotLiveProgressFromCrossingsLocked(sl, orderedGates)
		}
	}
}

// ---------------------------------------------------------------------------
// Background Pure-Go Base Model Trainer (`POST /v1/ml:train`)
// ---------------------------------------------------------------------------

// MLTrainRequest customizes epochs, source Practice sessions, model name, continued fine-tuning, or pre-training AI labeling.
type MLTrainRequest struct {
	Epochs            int      `json:"epochs,omitempty"`
	IncludeUnverified bool     `json:"includeUnverified,omitempty"`
	AutoLabel         *bool    `json:"autoLabel,omitempty"`
	SessionIDs        []string `json:"sessionIds,omitempty"`
	ContinueModelID   string   `json:"continueModelId,omitempty"`
	ModelName         string   `json:"modelName,omitempty"`
}

// StartMLTraining launches an asynchronous multi-core Go training run across selected Practice
// `.rfbin` traces (plus synthetic RF physics stabilization traces).
func (e *Engine) StartMLTraining(req MLTrainRequest) (domain.MLStatus, error) {
	basePretrained, _ := ml.PretrainedBaseModel()

	e.mu.Lock()
	e.ensureMLInitializedLocked()

	if e.mlTraining.Running {
		st := e.buildMLStatusLocked()
		e.mu.Unlock()
		return st, errors.New("an on-device model training job is already running")
	}
	if e.isLiveRaceHeatActiveLocked() {
		st := e.buildMLStatusLocked()
		e.mu.Unlock()
		return st, errors.New("finish or abort the active race heat before training a model")
	}
	if e.practiceState.ActiveSessionID != "" {
		e.syncActivePracticeRecordsLocked()
	}

	epochs := req.Epochs
	if epochs <= 0 {
		epochs = 28
	} else if epochs > 80 {
		epochs = 80
	}

	initTCN := basePretrained
	lr := float32(0.0035)
	updateInPlaceID := ""
	preserveBuiltIn := false
	prevEpochs := 0
	prevDurMs := int64(0)
	baseName := strings.TrimSpace(req.ModelName)

	if cid := strings.TrimSpace(req.ContinueModelID); cid != "" {
		foundExisting := false
		for _, m := range e.mlState.Models {
			if m.ModelID == cid {
				if len(m.Weights) == ml.TotalParams {
					cloned := &ml.TCN{}
					if cloned.ImportWeights(m.Weights) {
						initTCN = cloned
						lr = 0.0018
						updateInPlaceID = m.ModelID
						preserveBuiltIn = m.BuiltIn
						prevEpochs = m.EpochsTrained
						prevDurMs = m.TrainDurationMs
						if m.BuiltIn || baseName == "" {
							baseName = m.Name
						}
						foundExisting = true
					}
				} else {
					// Untrained model created via `+ Add`: train from scratch into this immutable ModelID!
					initTCN = basePretrained
					lr = 0.0035
					updateInPlaceID = m.ModelID
					preserveBuiltIn = false
					prevEpochs = 0
					prevDurMs = 0
					if baseName == "" {
						baseName = m.Name
					}
					foundExisting = true
				}
				break
			}
		}
		if !foundExisting && cid == "ai-base-v0" {
			baseSum := ml.PretrainedBaseSummary()
			initTCN = basePretrained
			lr = 0.0018
			updateInPlaceID = "ai-base-v0"
			preserveBuiltIn = true
			prevEpochs = baseSum.EpochsTrained
			baseName = baseSum.Name
		}
	}

	// Snapshot candidate sessions & pilot defaults so training runs outside Engine.mu!
	sessionsCopy := make([]domain.PracticeSession, len(e.practiceState.Sessions))
	for i, s := range e.practiceState.Sessions {
		sessionsCopy[i] = clonePracticeSession(s)
	}
	pilotsCopy := append([]domain.PilotSlot(nil), e.pilots...)
	ts := e.ensureTraceStoreLocked()
	tm := e.mlTeacher
	prefTeacherPack := e.mlState.Config.TeacherPackID
	wantAutoLabel := e.mlState.Config.AutoLabelOnTrain
	if req.AutoLabel != nil {
		wantAutoLabel = *req.AutoLabel
	}

	nextVer := 1
	for _, m := range e.mlState.Models {
		if m.Version >= nextVer {
			nextVer = m.Version + 1
		}
	}

	e.mlTraining = domain.MLTrainingProgress{
		Running:     true,
		Epoch:       0,
		TotalEpochs: epochs,
		Loss:        0,
		Message:     "Preparing practice signal traces...",
		StartedAt:   nowISO(),
	}
	st := e.buildMLStatusLocked()
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	e.notifyMLUpdated(st, subs)

	go e.runMLTrainingWorker(
		sessionsCopy,
		pilotsCopy,
		ts,
		tm,
		prefTeacherPack,
		wantAutoLabel,
		initTCN,
		nextVer,
		epochs,
		lr,
		req.IncludeUnverified,
		append([]string(nil), req.SessionIDs...),
		updateInPlaceID,
		preserveBuiltIn,
		prevEpochs,
		prevDurMs,
		baseName,
	)
	return st, nil
}

func (e *Engine) runMLTrainingWorker(
	sessions []domain.PracticeSession,
	pilots []domain.PilotSlot,
	ts tracestore.Store,
	tm *ml.TeacherManager,
	prefTeacherPack string,
	wantAutoLabel bool,
	initTCN *ml.TCN,
	nextVer int,
	epochs int,
	lr float32,
	includeUnverified bool,
	requestedSessionIDs []string,
	updateInPlaceID string,
	preserveBuiltIn bool,
	prevEpochs int,
	prevDurMs int64,
	customName string,
) {
	t0 := time.Now()
	type packGroup struct {
		sessionID string
		traces    []ml.LabeledTrace
		passes    int
	}
	var packs []packGroup
	var usedSessionIDs []string

	selectedSet := make(map[string]bool, len(requestedSessionIDs))
	for _, id := range requestedSessionIDs {
		trimmed := strings.TrimSpace(id)
		if trimmed != "" {
			selectedSet[trimmed] = true
		}
	}

	// Stage 0 (Optional On-Device System 1 Distillation): Auto-label unlabeled `.rfbin` packs before TCN training!
	if wantAutoLabel && tm != nil {
		if labeler, resolvedPackID, lErr := tm.ResolveLabeler(prefTeacherPack); lErr == nil && labeler != nil {
			var toLabelIdx []int
			for idx, s := range sessions {
				if len(selectedSet) > 0 && !selectedSet[s.SessionID] {
					continue
				}
				if s.TrainingVerified || s.TeacherLabeledAt != "" {
					continue
				}
				if samples, rErr := ts.ReadSession(s.SessionID); rErr == nil && len(samples) >= 25 {
					toLabelIdx = append(toLabelIdx, idx)
				}
			}

			var anyUpdated bool
			for stepIdx, idx := range toLabelIdx {
				s := sessions[idx]
				e.mu.Lock()
				e.mlTraining.Message = fmt.Sprintf("Auto-labeling %s (%d / %d) on device...", s.Name, stepIdx+1, len(toLabelIdx))
				progSt := e.buildMLStatusLocked()
				progSubs := append([]EventSubscriber(nil), e.subscribers...)
				e.mu.Unlock()
				e.notifyMLUpdated(progSt, progSubs)

				samples, rErr := ts.ReadSession(s.SessionID)
				if rErr != nil || len(samples) < 25 {
					continue
				}
				cands := ml.ExtractSessionCandidates(s, samples)
				if len(cands) == 0 {
					continue
				}
				decs, dErr := labeler.LabelCandidates(context.Background(), s, cands, nil)
				if dErr != nil || len(decs) == 0 {
					continue
				}

				e.mu.Lock()
				if live := e.findPracticeSessionLocked(s.SessionID); live != nil {
					e.applyTeacherDecisionsLocked(live, resolvedPackID, 0, decs)
					sessions[idx] = clonePracticeSession(*live)
					anyUpdated = true
				}
				e.mu.Unlock()
			}

			if anyUpdated {
				e.mu.Lock()
				pSnap := clonePracticeManagerState(e.practiceState)
				subs := append([]EventSubscriber(nil), e.subscribers...)
				e.mu.Unlock()
				e.notifyPracticeUpdated(pSnap, subs)
			}
		}
	}

	for _, s := range sessions {
		if len(selectedSet) > 0 {
			if !selectedSet[s.SessionID] {
				continue
			}
		} else if !s.TrainingVerified && s.TeacherLabeledAt == "" && !includeUnverified {
			continue
		}
		samples, err := ts.ReadSession(s.SessionID)
		if err != nil || len(samples) < 25 {
			continue
		}
		ltr := ml.BuildTracesFromSession(s, samples, pilots)
		if len(ltr) == 0 {
			continue
		}
		passSum := 0
		for _, tr := range ltr {
			passSum += len(tr.Positives)
		}
		if passSum == 0 && len(selectedSet) == 0 && !s.TrainingVerified {
			continue
		}
		packs = append(packs, packGroup{
			sessionID: s.SessionID,
			traces:    ltr,
			passes:    passSum,
		})
		usedSessionIDs = append(usedSessionIDs, s.SessionID)
	}

	// If no explicit/verified packs had `.rfbin` traces yet, fall back to any recorded session with >= 1 crossing
	if len(packs) == 0 {
		for _, s := range sessions {
			if len(s.Crossings) == 0 {
				continue
			}
			samples, err := ts.ReadSession(s.SessionID)
			if err != nil || len(samples) < 25 {
				continue
			}
			ltr := ml.BuildTracesFromSession(s, samples, pilots)
			if len(ltr) > 0 {
				passSum := 0
				for _, tr := range ltr {
					passSum += len(tr.Positives)
				}
				packs = append(packs, packGroup{
					sessionID: s.SessionID,
					traces:    ltr,
					passes:    passSum,
				})
				usedSessionIDs = append(usedSessionIDs, s.SessionID)
			}
		}
	}

	var trainTraces, valTraces []ml.LabeledTrace
	var trainPackCount, valPackCount, realPassCount int

	if len(packs) == 0 {
		// Pure synthetic calibration run when zero `.rfbin` packs exist yet (e.g. demo / quick test)
		synthAll := ml.GenerateSyntheticTraces(12, time.Now().UnixNano())
		trainTraces = synthAll[:9]
		valTraces = synthAll[9:]
		trainPackCount = 9
		valPackCount = 3
		for _, tr := range trainTraces {
			realPassCount += len(tr.Positives)
		}
	} else if len(packs) >= 3 {
		valPackCount = len(packs) / 5
		if valPackCount < 1 {
			valPackCount = 1
		}
		trainPackCount = len(packs) - valPackCount
		for i := 0; i < trainPackCount; i++ {
			trainTraces = append(trainTraces, packs[i].traces...)
			realPassCount += packs[i].passes
		}
		for i := trainPackCount; i < len(packs); i++ {
			valTraces = append(valTraces, packs[i].traces...)
			realPassCount += packs[i].passes
		}
		trainTraces = append(trainTraces, ml.GenerateSyntheticTraces(4, 20261124+int64(nextVer))...)
	} else {
		// 1-2 sessions: train on real + synthetic, validate on real + unseen synthetic
		trainPackCount = len(packs)
		valPackCount = len(packs)
		for _, p := range packs {
			trainTraces = append(trainTraces, p.traces...)
			valTraces = append(valTraces, p.traces...)
			realPassCount += p.passes
		}
		trainTraces = append(trainTraces, ml.GenerateSyntheticTraces(6, 20261124+int64(nextVer))...)
		valTraces = append(valTraces, ml.GenerateSyntheticTraces(2, 88888+int64(nextVer))...)
	}

	trained, finalLoss := ml.TrainModel(trainTraces, initTCN, ml.TrainOptions{
		Epochs:       epochs,
		LearningRate: lr,
		WeightDecay:  1e-4,
		AugPerTrace:  3,
		Seed:         time.Now().UnixNano(),
		OnEpoch: func(ep, total int, loss float64) {
			e.mu.Lock()
			e.mlTraining.Epoch = ep
			e.mlTraining.TotalEpochs = total
			e.mlTraining.Loss = math.Round(loss*10000) / 10000
			e.mlTraining.Message = fmt.Sprintf("Training epoch %d / %d (loss %.4f)...", ep, total, loss)
			st := e.buildMLStatusLocked()
			subs := append([]EventSubscriber(nil), e.subscribers...)
			e.mu.Unlock()
			e.notifyMLUpdated(st, subs)
		},
	})

	aiM, clM := ml.BenchmarkTraces(trained, valTraces, 1_500_000)
	durMs := time.Since(t0).Milliseconds()
	modelID := updateInPlaceID
	if modelID == "" {
		modelID = newModelID()
	}
	modelName := strings.TrimSpace(customName)
	if modelName == "" {
		modelName = fmt.Sprintf("AI Model v%d", nextVer)
	}
	totalEpochsTrained := prevEpochs + epochs
	totalDurMs := prevDurMs + durMs

	e.mu.Lock()
	updatedExisting := false
	if updateInPlaceID != "" {
		for i := range e.mlState.Models {
			if e.mlState.Models[i].ModelID == updateInPlaceID {
				mergedIDs := append([]string(nil), e.mlState.Models[i].SourceSessionIDs...)
				for _, sid := range usedSessionIDs {
					found := false
					for _, ex := range mergedIDs {
						if ex == sid {
							found = true
							break
						}
					}
					if !found {
						mergedIDs = append(mergedIDs, sid)
					}
				}
				e.mlState.Models[i].Name = modelName
				e.mlState.Models[i].Ready = true
				e.mlState.Models[i].EpochsTrained = totalEpochsTrained
				e.mlState.Models[i].SourceSessionIDs = mergedIDs
				e.mlState.Models[i].TrainPacks = len(mergedIDs)
				if e.mlState.Models[i].TrainPacks < trainPackCount {
					e.mlState.Models[i].TrainPacks = trainPackCount
				}
				e.mlState.Models[i].ValPacks = valPackCount
				if realPassCount > e.mlState.Models[i].TrainPasses {
					e.mlState.Models[i].TrainPasses = realPassCount
				}
				e.mlState.Models[i].TrainDurationMs = totalDurMs
				e.mlState.Models[i].FinalLoss = math.Round(finalLoss*10000) / 10000
				e.mlState.Models[i].AIMetrics = aiM
				e.mlState.Models[i].ClassicMetrics = clM
				e.mlState.Models[i].Weights = trained.ExportWeights()
				modelID = e.mlState.Models[i].ModelID
				modelName = e.mlState.Models[i].Name
				if e.mlState.Config.ActiveModelID == modelID {
					e.mlActiveTCN = trained
					e.mlActiveModelID = modelID
					e.resetMLSessionDetectorsLocked()
				}
				updatedExisting = true
				break
			}
		}
	}
	if !updatedExisting {
		ver := nextVer
		if preserveBuiltIn && modelID == "ai-base-v0" {
			ver = 0
		}
		snap := domain.MLModelSnapshot{
			MLModelSummary: domain.MLModelSummary{
				ModelID:          modelID,
				Name:             modelName,
				Version:          ver,
				CreatedAt:        nowISO(),
				BuiltIn:          preserveBuiltIn,
				Ready:            true,
				EpochsTrained:    totalEpochsTrained,
				SourceSessionIDs: usedSessionIDs,
				TrainPacks:       trainPackCount,
				ValPacks:         valPackCount,
				TrainPasses:      realPassCount,
				TrainDurationMs:  totalDurMs,
				FinalLoss:        math.Round(finalLoss*10000) / 10000,
				AIMetrics:        aiM,
				ClassicMetrics:   clM,
			},
			Weights: trained.ExportWeights(),
		}
		e.mlState.Models = append(e.mlState.Models, snap)
		if e.mlState.Config.ActiveModelID == modelID {
			e.mlActiveTCN = trained
			e.mlActiveModelID = modelID
			e.resetMLSessionDetectorsLocked()
		}
		for len(e.mlState.Models) > 9 {
			evictIdx := -1
			for i := range e.mlState.Models {
				if !e.mlState.Models[i].BuiltIn {
					evictIdx = i
					break
				}
			}
			if evictIdx < 0 {
				break
			}
			e.mlState.Models = append(e.mlState.Models[:evictIdx], e.mlState.Models[evictIdx+1:]...)
		}
	}
	e.mlTraining = domain.MLTrainingProgress{
		Running:          false,
		Epoch:            epochs,
		TotalEpochs:      epochs,
		Loss:             math.Round(finalLoss*10000) / 10000,
		Message:          fmt.Sprintf("Trained %s (%d epochs · F1 %.1f%%)", modelName, totalEpochsTrained, aiM.F1*100.0),
		CompletedModelID: modelID,
	}
	st := e.buildMLStatusLocked()
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	e.notifyMLUpdated(st, subs)
}

// ---------------------------------------------------------------------------
// Portable Dataset & Model Bundle Export / Import (`.tar.gz`)
// ---------------------------------------------------------------------------

type datasetBundleManifest struct {
	Version    int                        `json:"version"`
	ExportedAt string                     `json:"exportedAt"`
	Sessions   []domain.PracticeSession   `json:"sessions"`
	Models     []domain.MLModelSnapshot   `json:"models,omitempty"`
}

// ExportMLDatasetTarGz packages recorded PracticeSessions, their `.rfbin` traces, and custom trained
// `MLModelSnapshot`s into a single `.tar.gz` archive streamable over HTTP.
func (e *Engine) ExportMLDatasetTarGz(w io.Writer) error {
	e.mu.RLock()
	sessions := make([]domain.PracticeSession, 0, len(e.practiceState.Sessions))
	for _, s := range e.practiceState.Sessions {
		if s.TraceSampleCount > 0 || len(s.Crossings) > 0 || s.TrainingVerified {
			sessions = append(sessions, clonePracticeSession(s))
		}
	}
	models := make([]domain.MLModelSnapshot, len(e.mlState.Models))
	for i, m := range e.mlState.Models {
		cp := m
		cp.Weights = append([]float32(nil), m.Weights...)
		models[i] = cp
	}
	ts := e.traceStore
	e.mu.RUnlock()

	gz := gzip.NewWriter(w)
	defer gz.Close()
	tw := tar.NewWriter(gz)
	defer tw.Close()

	manifest := datasetBundleManifest{
		Version:    1,
		ExportedAt: nowISO(),
		Sessions:   sessions,
		Models:     models,
	}
	mBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	if err := tw.WriteHeader(&tar.Header{
		Name:    "manifest.json",
		Mode:    0o644,
		Size:    int64(len(mBytes)),
		ModTime: time.Now(),
	}); err != nil {
		return err
	}
	if _, err := tw.Write(mBytes); err != nil {
		return err
	}

	if ts != nil {
		for _, s := range sessions {
			raw, err := ts.ReadRawBytes(s.SessionID)
			if err != nil || len(raw) == 0 {
				continue
			}
			name := "traces/" + s.SessionID + ".rfbin"
			if err := tw.WriteHeader(&tar.Header{
				Name:    name,
				Mode:    0o644,
				Size:    int64(len(raw)),
				ModTime: time.Now(),
			}); err != nil {
				return err
			}
			if _, err := tw.Write(raw); err != nil {
				return err
			}
		}
	}
	return nil
}

// ImportMLDatasetTarGz imports PracticeSessions, `.rfbin` traces, and trained `MLModelSnapshot`s
// from a `.tar.gz` bundle exported from another SlapRF device (e.g. phone -> laptop or vice versa).
func (e *Engine) ImportMLDatasetTarGz(r io.Reader) (importedSessions int, importedModels int, err error) {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return 0, 0, fmt.Errorf("invalid gzip archive: %w", err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	var manifest datasetBundleManifest
	var hasManifest bool
	rawTraces := make(map[string][]byte)

	for {
		hdr, rErr := tr.Next()
		if errors.Is(rErr, io.EOF) {
			break
		}
		if rErr != nil {
			return 0, 0, fmt.Errorf("corrupt tar archive: %w", rErr)
		}
		cleanName := strings.TrimPrefix(path.Clean(hdr.Name), "./")
		data, rErr := io.ReadAll(io.LimitReader(tr, 64<<20))
		if rErr != nil {
			return 0, 0, rErr
		}
		if cleanName == "manifest.json" {
			if jErr := json.Unmarshal(data, &manifest); jErr != nil {
				return 0, 0, fmt.Errorf("invalid manifest.json: %w", jErr)
			}
			hasManifest = true
		} else if strings.HasPrefix(cleanName, "traces/") && strings.HasSuffix(cleanName, ".rfbin") {
			sid := strings.TrimSuffix(strings.TrimPrefix(cleanName, "traces/"), ".rfbin")
			if sid != "" {
				rawTraces[sid] = data
			}
		}
	}
	if !hasManifest {
		return 0, 0, errors.New("dataset bundle missing manifest.json")
	}

	e.mu.Lock()
	e.ensurePracticeStateInitializedLocked()
	e.ensureMLInitializedLocked()
	ts := e.ensureTraceStoreLocked()

	existingSess := make(map[string]int, len(e.practiceState.Sessions))
	for i, s := range e.practiceState.Sessions {
		existingSess[s.SessionID] = i
	}

	for _, incoming := range manifest.Sessions {
		if incoming.SessionID == "" {
			continue
		}
		incoming.Active = false
		if raw, ok := rawTraces[incoming.SessionID]; ok && len(raw) > 0 {
			if sum, wErr := ts.WriteRawBytes(incoming.SessionID, raw); wErr == nil {
				incoming.TraceSampleCount = sum.SampleCount
				incoming.TraceDurationSec = math.Round(sum.DurationSec*100) / 100
			}
		}
		if idx, exists := existingSess[incoming.SessionID]; exists {
			if !e.practiceState.Sessions[idx].Active {
				e.practiceState.Sessions[idx] = clonePracticeSession(incoming)
				importedSessions++
			}
		} else {
			if dup := e.findDuplicatePracticeBySlugLocked(incoming.Name, ""); dup != nil {
				incoming.Name = fmt.Sprintf("%s (%s)", incoming.Name, incoming.SessionID[maxInt(0, len(incoming.SessionID)-4):])
			}
			e.bumpSeqFromRestoredIDLocked(incoming.SessionID)
			e.practiceState.Sessions = append(e.practiceState.Sessions, clonePracticeSession(incoming))
			existingSess[incoming.SessionID] = len(e.practiceState.Sessions) - 1
			importedSessions++
		}
	}

	existingMod := make(map[string]domain.MLModelSnapshot, len(e.mlState.Models))
	for _, m := range e.mlState.Models {
		existingMod[m.ModelID] = m
	}
	for _, m := range manifest.Models {
		if len(m.Weights) != ml.TotalParams {
			continue
		}
		if m.ModelID == "" {
			m.ModelID = newModelID()
		} else if prev, exists := existingMod[m.ModelID]; exists {
			// Legacy sequential IDs (`ai-base-v1`, ...) from different devices get a unique internal ID on import
			if !m.BuiltIn && m.ModelID != "ai-base-v0" && strings.HasPrefix(m.ModelID, "ai-base-v") && prev.CreatedAt != m.CreatedAt {
				m.ModelID = newModelID()
			} else {
				continue
			}
		}
		e.mlState.Models = append(e.mlState.Models, m)
		existingMod[m.ModelID] = m
		importedModels++
	}

	practiceSnap := clonePracticeManagerState(e.practiceState)
	mlSnap := e.buildMLStatusLocked()
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	e.notifyPracticeUpdated(practiceSnap, subs)
	e.notifyMLUpdated(mlSnap, subs)
	return importedSessions, importedModels, nil
}
