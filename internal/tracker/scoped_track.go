package tracker

import (
	"errors"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"slaprf/internal/domain"
	"slaprf/internal/dsp"
)

var (
	ErrPracticeNotFound  = errors.New("practice session not found")
	ErrRaceNotFound      = errors.New("race not found")
	ErrRaceTrackReadOnly = errors.New("completed or scrapped race track is read-only")
)

func cloneTrackGate(g domain.TrackGate) domain.TrackGate {
	cp := g
	if len(g.PilotRuleOverrides) > 0 {
		cp.PilotRuleOverrides = make(map[int]domain.GateRuleOverrides, len(g.PilotRuleOverrides))
		for k, v := range g.PilotRuleOverrides {
			cp.PilotRuleOverrides[k] = v
		}
	} else {
		cp.PilotRuleOverrides = nil
	}
	return cp
}

func cloneTrackGates(gates []domain.TrackGate) []domain.TrackGate {
	if gates == nil {
		return nil
	}
	out := make([]domain.TrackGate, len(gates))
	for i, g := range gates {
		out[i] = cloneTrackGate(g)
	}
	return out
}

func cloneTimingRulesPtr(r *domain.TimingRules, fallback domain.TimingRules) *domain.TimingRules {
	if r != nil {
		cp := r.Normalized()
		return &cp
	}
	cp := fallback.Normalized()
	return &cp
}

func resolveTimingRules(r *domain.TimingRules, fallback domain.TimingRules) domain.TimingRules {
	if r != nil {
		return r.Normalized()
	}
	return fallback.Normalized()
}

func orderAndNormalizeGatesSlice(gates []domain.TrackGate) []domain.TrackGate {
	if len(gates) == 0 {
		return []domain.TrackGate{}
	}
	out := cloneTrackGates(gates)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].TrackOrder != out[j].TrackOrder {
			return out[i].TrackOrder < out[j].TrackOrder
		}
		return out[i].GateID < out[j].GateID
	})
	foundStart := false
	for i := range out {
		out[i].TrackOrder = i
		if out[i].Role == domain.GateRoleStartFinish {
			if !foundStart {
				foundStart = true
			} else {
				out[i].Role = domain.GateRoleSectorGate
			}
		} else {
			out[i].Role = domain.GateRoleSectorGate
		}
	}
	if !foundStart {
		out[0].Role = domain.GateRoleStartFinish
	}
	return out
}

// enrichTrackGatesLocked refreshes live hardware status (TimerLabel, FirmwareVersion, Color,
// BatteryMv, BatteryPct, NoiseFloorDbm, Online, LastSeenAt) from `e.detected` onto `gates`
// without altering gate count, order, names, roles, or rule overrides.
func (e *Engine) enrichTrackGatesLocked(gates []domain.TrackGate) []domain.TrackGate {
	ordered := orderAndNormalizeGatesSlice(gates)
	for i := range ordered {
		tid := ordered[i].AssignedTimerID
		if tid == 0 {
			ordered[i].Online = false
			continue
		}
		if d, ok := e.detected[tid]; ok && d != nil {
			if strings.TrimSpace(d.TimerLabel) != "" {
				ordered[i].TimerLabel = strings.TrimSpace(d.TimerLabel)
			}
			if d.FirmwareVersion != "" {
				ordered[i].FirmwareVersion = d.FirmwareVersion
			}
			if strings.TrimSpace(d.Color) != "" {
				ordered[i].Color = strings.TrimSpace(d.Color)
			}
			ordered[i].BatteryMv = d.BatteryMv
			ordered[i].BatteryPct = d.BatteryPct
			ordered[i].NoiseFloorDbm = d.NoiseFloorDbm
			ordered[i].LastRSSI = d.LastRSSI
			ordered[i].LastSeenAt = d.LastSeenAt
			ordered[i].Online = d.Online || (!d.LastSeenAt.IsZero() && time.Since(d.LastSeenAt) < timerOfflineAfter)
		} else {
			ordered[i].Online = false
		}
		if strings.TrimSpace(ordered[i].Color) == "" {
			ordered[i].Color = domain.DefaultTimerColor(tid)
		}
		if strings.TrimSpace(ordered[i].TimerLabel) == "" {
			ordered[i].TimerLabel = domain.DefaultTimerLabel(tid, tid == domain.SimHubTimerID)
		}
	}
	return ordered
}

// defaultNewTrackGatesLocked builds the initial track layout for a newly created Practice Session
// or Race. In Simulator Mode it clones the simulated course; in Real Hardware Mode it creates a
// 1-gate Start/Finish layout bound to the primary connected timer (or empty if no timer is online).
func (e *Engine) defaultNewTrackGatesLocked() []domain.TrackGate {
	if e.isSimEngine {
		if len(e.gates) > 0 {
			return e.snapshotOrderedGatesLocked()
		}
		return e.defaultTrackSliceForModeLocked(true)
	}
	// Real hardware mode: auto-bind at most 1 online primary timer as Start/Finish (or empty if disconnected).
	isBle := domain.NormalizeTimingHardwareMode(e.timingHardwareMode) == domain.HardwareModeSlapRFBLE
	ids := make([]int, 0, len(e.detected))
	for id, d := range e.detected {
		if d == nil || !d.Online {
			continue
		}
		if d.IsHub && !isBle {
			continue
		}
		ids = append(ids, int(id))
	}
	if len(ids) == 0 {
		// If only a USB Hub is connected with zero Spokes, leave empty so user can drag H1 if desired.
		return []domain.TrackGate{}
	}
	sort.Ints(ids)
	tid := uint8(ids[0])
	d := e.detected[tid]
	col := d.Color
	if col == "" {
		col = domain.DefaultTimerColor(tid)
	}
	return []domain.TrackGate{
		{
			GateID:          1,
			AssignedTimerID: tid,
			TimerLabel:      d.TimerLabel,
			FirmwareVersion: d.FirmwareVersion,
			Color:           col,
			Role:            domain.GateRoleStartFinish,
			TrackOrder:      0,
			MapX:            0.5,
			MapY:            0.5,
			Online:          d.Online,
			BatteryMv:       d.BatteryMv,
			BatteryPct:      d.BatteryPct,
			NoiseFloorDbm:   d.NoiseFloorDbm,
			LastRSSI:        d.LastRSSI,
			LastSeenAt:      d.LastSeenAt,
		},
	}
}

func (e *Engine) defaultTrackSliceForModeLocked(isSim bool) []domain.TrackGate {
	if isSim {
		switch domain.NormalizeTimingHardwareMode(e.timingHardwareMode) {
		case domain.HardwareModeSlapRFBLE:
			gates, _ := defaultSimSlapRFBLELayoutLocked(time.Now())
			return e.enrichTrackGatesLocked(gates)
		case domain.HardwareModeLapRF, domain.HardwareModeLapRFUSB:
			gates, _ := defaultSimLapRFLayoutLocked(time.Now())
			return e.enrichTrackGatesLocked(gates)
		case domain.HardwareModeRotorHazard, domain.HardwareModeRotorHazardUSB:
			gates, _ := defaultSimRHLayoutLocked(time.Now())
			return e.enrichTrackGatesLocked(gates)
		default:
			return e.enrichTrackGatesLocked(domain.DefaultTrackGates())
		}
	}
	isBle := domain.NormalizeTimingHardwareMode(e.timingHardwareMode) == domain.HardwareModeSlapRFBLE
	ids := make([]int, 0, len(e.detected))
	for id, d := range e.detected {
		if d == nil {
			continue
		}
		if d.IsHub && !isBle {
			continue
		}
		ids = append(ids, int(id))
	}
	sort.Ints(ids)
	newGates := make([]domain.TrackGate, 0, len(ids))
	for idx, rawID := range ids {
		tid := uint8(rawID)
		d := e.detected[tid]
		col := d.Color
		if col == "" {
			col = domain.DefaultTimerColor(tid)
		}
		role := domain.GateRoleSectorGate
		if idx == 0 {
			role = domain.GateRoleStartFinish
		}
		newGates = append(newGates, domain.TrackGate{
			GateID:          uint8(idx + 1),
			AssignedTimerID: tid,
			TimerLabel:      d.TimerLabel,
			FirmwareVersion: d.FirmwareVersion,
			Color:           col,
			Role:            role,
			TrackOrder:      idx,
			MapX:            0.5,
			MapY:            0.5,
			Online:          d.Online,
			BatteryMv:       d.BatteryMv,
			BatteryPct:      d.BatteryPct,
			NoiseFloorDbm:   d.NoiseFloorDbm,
			LastSeenAt:      d.LastSeenAt,
		})
	}
	return newGates
}

func (e *Engine) ensurePracticeTrackInitializedLocked(s *domain.PracticeSession) {
	if s == nil {
		return
	}
	if !s.TrackInitialized {
		if len(s.TrackSnapshot) == 0 {
			s.TrackSnapshot = e.snapshotOrderedGatesLocked()
		} else {
			s.TrackSnapshot = e.enrichTrackGatesLocked(s.TrackSnapshot)
		}
		s.TrackInitialized = true
	} else if s.Active {
		s.TrackSnapshot = e.enrichTrackGatesLocked(s.TrackSnapshot)
	} else {
		s.TrackSnapshot = orderAndNormalizeGatesSlice(s.TrackSnapshot)
	}
	if s.Rules == nil {
		s.Rules = cloneTimingRulesPtr(nil, e.rules)
	} else {
		norm := s.Rules.Normalized()
		s.Rules = &norm
	}
}

func (e *Engine) ensureRaceTrackInitializedLocked(r *domain.RaceTournamentState) {
	if r == nil || r.RaceID == "" {
		return
	}
	if !r.TrackInitialized {
		if len(r.TrackSnapshot) == 0 {
			r.TrackSnapshot = e.snapshotOrderedGatesLocked()
		} else if isRaceTrackEditable(r) {
			r.TrackSnapshot = e.enrichTrackGatesLocked(r.TrackSnapshot)
		} else {
			r.TrackSnapshot = orderAndNormalizeGatesSlice(r.TrackSnapshot)
		}
		r.TrackInitialized = true
	} else if isRaceTrackEditable(r) {
		r.TrackSnapshot = e.enrichTrackGatesLocked(r.TrackSnapshot)
	} else {
		r.TrackSnapshot = orderAndNormalizeGatesSlice(r.TrackSnapshot)
	}
	if r.Rules == nil {
		r.Rules = cloneTimingRulesPtr(nil, e.rules)
	} else {
		norm := r.Rules.Normalized()
		r.Rules = &norm
	}
}

// loadTrackAndRulesIntoLiveEngineLocked loads `gates` and `rules` into `e.gates` and `e.rules`
// so live RF crossing detectors and the 3D flight simulator run against the active course.
func (e *Engine) loadTrackAndRulesIntoLiveEngineLocked(gates []domain.TrackGate, rules *domain.TimingRules) {
	nextGates := e.enrichTrackGatesLocked(gates)
	sameLayout := len(nextGates) == len(e.gates)
	if sameLayout {
		for i := range nextGates {
			if nextGates[i].GateID != e.gates[i].GateID ||
				nextGates[i].AssignedTimerID != e.gates[i].AssignedTimerID ||
				nextGates[i].Role != e.gates[i].Role ||
				nextGates[i].TrackOrder != e.gates[i].TrackOrder {
				sameLayout = false
				break
			}
		}
	}
	e.gates = nextGates
	e.rules = resolveTimingRules(rules, e.rules)
	if !sameLayout {
		e.detectors = make(map[detKey]*dsp.ChannelDetector)
		e.autoCalib = make(map[detKey]*autoCalibState)
		e.progress = make(map[int]*pilotProgress)
	}
	e.initDetectorsLocked()
}

func (e *Engine) applyAddGateToSliceLocked(
	gates []domain.TrackGate,
	name string,
	assignedTimerID uint8,
	trackOrder ...int,
) ([]domain.TrackGate, domain.TrackGate, error) {
	name = strings.TrimSpace(name)
	if utf8.RuneCountInString(name) > domain.MaxGateNameLen {
		return gates, domain.TrackGate{}, ErrGateNameTooLong
	}
	if assignedTimerID > maxTimers {
		return gates, domain.TrackGate{}, ErrInvalidTimerID
	}

	cur := orderAndNormalizeGatesSlice(gates)
	var maxID uint8
	for _, g := range cur {
		if g.GateID > maxID {
			maxID = g.GateID
		}
	}
	nextID := maxID + 1
	if nextID < 1 {
		nextID = 1
	}
	if nextID > maxTimers {
		used := make(map[uint8]bool, len(cur))
		for _, g := range cur {
			used[g.GateID] = true
		}
		nextID = 0
		for id := uint8(1); id <= maxTimers; id++ {
			if !used[id] {
				nextID = id
				break
			}
		}
		if nextID == 0 {
			return gates, domain.TrackGate{}, ErrInvalidTimerID
		}
	}

	if assignedTimerID > 0 {
		for i := range cur {
			if cur[i].AssignedTimerID == assignedTimerID {
				cur[i].AssignedTimerID = 0
				cur[i].TimerLabel = ""
				cur[i].Color = ""
				cur[i].Online = false
				cur[i].BatteryMv = 0
				cur[i].BatteryPct = 0
			}
		}
	}

	newGate := domain.TrackGate{
		GateID:          nextID,
		AssignedTimerID: assignedTimerID,
		Name:            name,
		Role:            domain.GateRoleSectorGate,
		TrackOrder:      len(cur),
		MapX:            0.5,
		MapY:            0.5,
		NoiseFloorDbm:   -92.0,
	}
	if assignedTimerID > 0 {
		if d, ok := e.detected[assignedTimerID]; ok && d != nil {
			newGate.TimerLabel = d.TimerLabel
			newGate.FirmwareVersion = d.FirmwareVersion
			newGate.Color = d.Color
			newGate.BatteryMv = d.BatteryMv
			newGate.BatteryPct = d.BatteryPct
			newGate.NoiseFloorDbm = d.NoiseFloorDbm
			newGate.LastSeenAt = d.LastSeenAt
			newGate.Online = d.Online || (!d.LastSeenAt.IsZero() && time.Since(d.LastSeenAt) < timerOfflineAfter)
		}
		if newGate.Color == "" {
			newGate.Color = domain.DefaultTimerColor(assignedTimerID)
		}
		if strings.TrimSpace(newGate.TimerLabel) == "" {
			newGate.TimerLabel = domain.DefaultTimerLabel(assignedTimerID, assignedTimerID == domain.SimHubTimerID)
		}
	}

	if len(trackOrder) > 0 {
		pos := trackOrder[0]
		if pos < 0 {
			pos = 0
		}
		if pos > len(cur) {
			pos = len(cur)
		}
		cur = append(cur[:pos], append([]domain.TrackGate{newGate}, cur[pos:]...)...)
	} else {
		cur = append(cur, newGate)
	}
	cur = e.enrichTrackGatesLocked(cur)
	createdIdx := indexOfGate(cur, nextID)
	var created domain.TrackGate
	if createdIdx >= 0 {
		created = cur[createdIdx]
	}
	return cur, created, nil
}

func (e *Engine) applyRemoveGateFromSliceLocked(gates []domain.TrackGate, gateID uint8) ([]domain.TrackGate, error) {
	cur := orderAndNormalizeGatesSlice(gates)
	idx := indexOfGate(cur, gateID)
	if idx < 0 {
		return gates, ErrUnknownGate
	}
	cur = append(cur[:idx], cur[idx+1:]...)
	cur = e.enrichTrackGatesLocked(cur)
	return cur, nil
}

func (e *Engine) applyUpdateGateInSliceLocked(gates []domain.TrackGate, u domain.GateUpdate) ([]domain.TrackGate, error) {
	name := strings.TrimSpace(u.Name)
	if utf8.RuneCountInString(name) > domain.MaxGateNameLen {
		return gates, ErrGateNameTooLong
	}
	if u.Role != domain.GateRoleStartFinish && u.Role != domain.GateRoleSectorGate {
		return gates, ErrInvalidGateRole
	}
	if u.AssignedTimerID != nil && *u.AssignedTimerID > maxTimers {
		return gates, ErrInvalidTimerID
	}

	cur := orderAndNormalizeGatesSlice(gates)
	idx := indexOfGate(cur, u.GateID)
	if idx < 0 {
		return gates, ErrUnknownGate
	}

	cur[idx].Name = name
	if c := strings.TrimSpace(u.Color); c != "" {
		cur[idx].Color = c
		if tid := cur[idx].AssignedTimerID; tid > 0 {
			if d, ok := e.detected[tid]; ok && d != nil {
				d.Color = c
			}
		}
	}

	if u.AssignedTimerID != nil {
		wantTimer := *u.AssignedTimerID
		cur[idx].AssignedTimerID = wantTimer
		if wantTimer == 0 {
			cur[idx].TimerLabel = ""
			cur[idx].Color = ""
			cur[idx].Online = false
			cur[idx].BatteryMv = 0
			cur[idx].BatteryPct = 0
		} else {
			for j := range cur {
				if j != idx && cur[j].AssignedTimerID == wantTimer {
					cur[j].AssignedTimerID = 0
					cur[j].TimerLabel = ""
					cur[j].Color = ""
					cur[j].Online = false
					cur[j].BatteryMv = 0
					cur[j].BatteryPct = 0
				}
			}
		}
	}

	if u.Role == domain.GateRoleStartFinish && cur[idx].Role != domain.GateRoleStartFinish {
		for j := range cur {
			if j == idx {
				cur[j].Role = domain.GateRoleStartFinish
			} else {
				cur[j].Role = domain.GateRoleSectorGate
			}
		}
	}

	if u.TrackOrder != nil {
		pos := *u.TrackOrder
		if pos < 0 {
			pos = 0
		}
		if pos > len(cur)-1 {
			pos = len(cur) - 1
		}
		moved := cur[idx]
		cur = append(cur[:idx], cur[idx+1:]...)
		cur = append(cur[:pos], append([]domain.TrackGate{moved}, cur[pos:]...)...)
	}

	for i := range cur {
		cur[i].TrackOrder = i
	}
	cur = e.enrichTrackGatesLocked(cur)
	return cur, nil
}

func (e *Engine) detectedTimersSnapshotLocked() []domain.DetectedTimer {
	ids := make([]int, 0, len(e.detected))
	for id := range e.detected {
		ids = append(ids, int(id))
	}
	sort.Ints(ids)
	now := time.Now()
	out := make([]domain.DetectedTimer, 0, len(ids))
	for _, rawID := range ids {
		d := e.detected[uint8(rawID)]
		if d == nil {
			continue
		}
		cp := *d
		cp.Online = d.Online || (!d.LastSeenAt.IsZero() && now.Sub(d.LastSeenAt) < timerOfflineAfter)
		out = append(out, cp)
	}
	return out
}

// ---------------------------------------------------------------------------
// Scoped Practice Session Track & Rules API
// ---------------------------------------------------------------------------

func (e *Engine) PracticeTrackSnapshot(sessionID string) ([]domain.TrackGate, []domain.DetectedTimer, domain.TimingRules, error) {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.ensurePracticeStateInitializedLocked()
	sess := e.findPracticeSessionLocked(strings.TrimSpace(sessionID))
	if sess == nil {
		e.mu.Unlock()
		return nil, nil, domain.TimingRules{}, ErrPracticeNotFound
	}
	e.ensurePracticeTrackInitializedLocked(sess)
	gates := e.enrichTrackGatesLocked(sess.TrackSnapshot)
	timers := e.detectedTimersSnapshotLocked()
	rules := resolveTimingRules(sess.Rules, e.rules)
	e.mu.Unlock()
	return gates, timers, rules, nil
}

func (e *Engine) commitScopedPracticeTrackMutationLocked(sess *domain.PracticeSession) (
	pSnap domain.PracticeManagerState,
	cfgChanged bool,
	pilots []domain.PilotSlot,
	gates []domain.TrackGate,
	subs []EventSubscriber,
) {
	sess.TrackInitialized = true
	sess.UpdatedAt = nowISO()
	sess.Summaries = e.computePracticeSessionSummariesLocked(sess)
	shouldSyncLive := sess.Active || (e.findAnyOngoingRaceLocked() == nil && e.practiceState.ActiveSessionID == "" && e.practiceState.SelectedSessionID == sess.SessionID)
	if shouldSyncLive {
		e.loadTrackAndRulesIntoLiveEngineLocked(sess.TrackSnapshot, sess.Rules)
		cfgChanged = true
		pilots = append([]domain.PilotSlot(nil), e.pilots...)
		gates = append([]domain.TrackGate(nil), e.gates...)
	}
	pSnap = clonePracticeManagerState(e.practiceState)
	subs = append([]EventSubscriber(nil), e.subscribers...)
	return
}

func (e *Engine) ResetPracticeTrack(sessionID string) ([]domain.TrackGate, error) {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.ensurePracticeStateInitializedLocked()
	sess := e.findPracticeSessionLocked(strings.TrimSpace(sessionID))
	if sess == nil {
		e.mu.Unlock()
		return nil, ErrPracticeNotFound
	}
	e.ensurePracticeTrackInitializedLocked(sess)
	sess.TrackSnapshot = e.defaultTrackSliceForModeLocked(e.isSimEngine)
	outGates := cloneTrackGates(sess.TrackSnapshot)
	pSnap, cfgChanged, pilots, liveGates, subs := e.commitScopedPracticeTrackMutationLocked(sess)
	e.mu.Unlock()

	if cfgChanged {
		for _, s := range subs {
			s.OnConfigUpdated(pilots, liveGates)
		}
	}
	e.notifyPracticeUpdated(pSnap, subs)
	return outGates, nil
}

func (e *Engine) AddPracticeGate(sessionID string, name string, assignedTimerID uint8, trackOrder ...int) (domain.TrackGate, error) {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.ensurePracticeStateInitializedLocked()
	sess := e.findPracticeSessionLocked(strings.TrimSpace(sessionID))
	if sess == nil {
		e.mu.Unlock()
		return domain.TrackGate{}, ErrPracticeNotFound
	}
	e.ensurePracticeTrackInitializedLocked(sess)
	nextSlice, created, err := e.applyAddGateToSliceLocked(sess.TrackSnapshot, name, assignedTimerID, trackOrder...)
	if err != nil {
		e.mu.Unlock()
		return domain.TrackGate{}, err
	}
	sess.TrackSnapshot = nextSlice
	pSnap, cfgChanged, pilots, liveGates, subs := e.commitScopedPracticeTrackMutationLocked(sess)
	e.mu.Unlock()

	if cfgChanged {
		for _, s := range subs {
			s.OnConfigUpdated(pilots, liveGates)
		}
	}
	e.notifyPracticeUpdated(pSnap, subs)
	return created, nil
}

func (e *Engine) UpdatePracticeGate(sessionID string, u domain.GateUpdate) error {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.ensurePracticeStateInitializedLocked()
	sess := e.findPracticeSessionLocked(strings.TrimSpace(sessionID))
	if sess == nil {
		e.mu.Unlock()
		return ErrPracticeNotFound
	}
	e.ensurePracticeTrackInitializedLocked(sess)
	nextSlice, err := e.applyUpdateGateInSliceLocked(sess.TrackSnapshot, u)
	if err != nil {
		e.mu.Unlock()
		return err
	}
	sess.TrackSnapshot = nextSlice
	pSnap, cfgChanged, pilots, liveGates, subs := e.commitScopedPracticeTrackMutationLocked(sess)
	e.mu.Unlock()

	if cfgChanged {
		for _, s := range subs {
			s.OnConfigUpdated(pilots, liveGates)
		}
	}
	e.notifyPracticeUpdated(pSnap, subs)
	return nil
}

func (e *Engine) RemovePracticeGate(sessionID string, gateID uint8) error {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.ensurePracticeStateInitializedLocked()
	sess := e.findPracticeSessionLocked(strings.TrimSpace(sessionID))
	if sess == nil {
		e.mu.Unlock()
		return ErrPracticeNotFound
	}
	e.ensurePracticeTrackInitializedLocked(sess)
	nextSlice, err := e.applyRemoveGateFromSliceLocked(sess.TrackSnapshot, gateID)
	if err != nil {
		e.mu.Unlock()
		return err
	}
	sess.TrackSnapshot = nextSlice
	pSnap, cfgChanged, pilots, liveGates, subs := e.commitScopedPracticeTrackMutationLocked(sess)
	e.mu.Unlock()

	if cfgChanged {
		for _, s := range subs {
			s.OnConfigUpdated(pilots, liveGates)
		}
	}
	e.notifyPracticeUpdated(pSnap, subs)
	return nil
}

func (e *Engine) SetPracticeRules(sessionID string, r domain.TimingRules) (domain.TimingRules, error) {
	norm := r.Normalized()
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.ensurePracticeStateInitializedLocked()
	sess := e.findPracticeSessionLocked(strings.TrimSpace(sessionID))
	if sess == nil {
		e.mu.Unlock()
		return domain.TimingRules{}, ErrPracticeNotFound
	}
	e.ensurePracticeTrackInitializedLocked(sess)
	cp := norm
	sess.Rules = &cp
	pSnap, cfgChanged, pilots, liveGates, subs := e.commitScopedPracticeTrackMutationLocked(sess)
	e.mu.Unlock()

	if cfgChanged {
		for _, s := range subs {
			s.OnConfigUpdated(pilots, liveGates)
		}
	}
	e.notifyPracticeUpdated(pSnap, subs)
	return norm, nil
}

func (e *Engine) PracticeGateRules(sessionID string, gateID uint8) (domain.GateRuleOverrides, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.ensurePracticeStateInitializedLocked()
	sess := e.findPracticeSessionLocked(strings.TrimSpace(sessionID))
	if sess == nil {
		return domain.GateRuleOverrides{}, ErrPracticeNotFound
	}
	e.ensurePracticeTrackInitializedLocked(sess)
	idx := indexOfGate(sess.TrackSnapshot, gateID)
	if idx < 0 {
		return domain.GateRuleOverrides{}, ErrUnknownGate
	}
	return sess.TrackSnapshot[idx].RuleOverrides, nil
}

func (e *Engine) SetPracticeGateRules(sessionID string, gateID uint8, overrides domain.GateRuleOverrides) (domain.GateRuleOverrides, error) {
	overrides = overrides.Normalized()
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.ensurePracticeStateInitializedLocked()
	sess := e.findPracticeSessionLocked(strings.TrimSpace(sessionID))
	if sess == nil {
		e.mu.Unlock()
		return domain.GateRuleOverrides{}, ErrPracticeNotFound
	}
	e.ensurePracticeTrackInitializedLocked(sess)
	idx := indexOfGate(sess.TrackSnapshot, gateID)
	if idx < 0 {
		e.mu.Unlock()
		return domain.GateRuleOverrides{}, ErrUnknownGate
	}
	sess.TrackSnapshot[idx].RuleOverrides = overrides
	pSnap, cfgChanged, pilots, liveGates, subs := e.commitScopedPracticeTrackMutationLocked(sess)
	e.mu.Unlock()

	if cfgChanged {
		for _, s := range subs {
			s.OnConfigUpdated(pilots, liveGates)
		}
	}
	e.notifyPracticeUpdated(pSnap, subs)
	return overrides, nil
}

func (e *Engine) PracticePilotGateRules(sessionID string, gateID uint8, slotIndex int) (domain.GateRuleOverrides, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.ensurePracticeStateInitializedLocked()
	sess := e.findPracticeSessionLocked(strings.TrimSpace(sessionID))
	if sess == nil {
		return domain.GateRuleOverrides{}, ErrPracticeNotFound
	}
	e.ensurePracticeTrackInitializedLocked(sess)
	idx := indexOfGate(sess.TrackSnapshot, gateID)
	if idx < 0 {
		return domain.GateRuleOverrides{}, ErrUnknownGate
	}
	if e.slotPositionLocked(slotIndex) < 0 {
		return domain.GateRuleOverrides{}, ErrUnknownPilot
	}
	return sess.TrackSnapshot[idx].PilotRuleOverrides[slotIndex], nil
}

func (e *Engine) SetPracticePilotGateRules(sessionID string, gateID uint8, slotIndex int, overrides domain.GateRuleOverrides) (domain.GateRuleOverrides, error) {
	overrides = overrides.Normalized()
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.ensurePracticeStateInitializedLocked()
	sess := e.findPracticeSessionLocked(strings.TrimSpace(sessionID))
	if sess == nil {
		e.mu.Unlock()
		return domain.GateRuleOverrides{}, ErrPracticeNotFound
	}
	e.ensurePracticeTrackInitializedLocked(sess)
	idx := indexOfGate(sess.TrackSnapshot, gateID)
	if idx < 0 {
		e.mu.Unlock()
		return domain.GateRuleOverrides{}, ErrUnknownGate
	}
	if e.slotPositionLocked(slotIndex) < 0 {
		e.mu.Unlock()
		return domain.GateRuleOverrides{}, ErrUnknownPilot
	}
	prev := sess.TrackSnapshot[idx].PilotRuleOverrides
	next := make(map[int]domain.GateRuleOverrides, len(prev)+1)
	for k, v := range prev {
		if k != slotIndex {
			next[k] = v
		}
	}
	if !overrides.IsEmpty() {
		next[slotIndex] = overrides
	}
	if len(next) == 0 {
		sess.TrackSnapshot[idx].PilotRuleOverrides = nil
	} else {
		sess.TrackSnapshot[idx].PilotRuleOverrides = next
	}
	pSnap, cfgChanged, pilots, liveGates, subs := e.commitScopedPracticeTrackMutationLocked(sess)
	e.mu.Unlock()

	if cfgChanged {
		for _, s := range subs {
			s.OnConfigUpdated(pilots, liveGates)
		}
	}
	e.notifyPracticeUpdated(pSnap, subs)
	return overrides, nil
}

// ---------------------------------------------------------------------------
// Scoped Race Track & Rules API
// ---------------------------------------------------------------------------

func (e *Engine) findRaceByIDLocked(raceID string) *domain.RaceTournamentState {
	rid := strings.TrimSpace(raceID)
	if rid == "" {
		return nil
	}
	for i := range e.eventState.Races {
		if e.eventState.Races[i].RaceID == rid {
			return &e.eventState.Races[i]
		}
	}
	if e.raceState.RaceID == rid {
		return &e.raceState
	}
	return nil
}

func (e *Engine) RaceTrackSnapshot(raceID string) ([]domain.TrackGate, []domain.DetectedTimer, domain.TimingRules, error) {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.syncActiveRaceToEventLocked()
	r := e.findRaceByIDLocked(raceID)
	if r == nil {
		e.mu.Unlock()
		return nil, nil, domain.TimingRules{}, ErrRaceNotFound
	}
	e.ensureRaceTrackInitializedLocked(r)
	var gates []domain.TrackGate
	if isRaceTrackEditable(r) {
		gates = e.enrichTrackGatesLocked(r.TrackSnapshot)
	} else {
		gates = orderAndNormalizeGatesSlice(r.TrackSnapshot)
	}
	timers := e.detectedTimersSnapshotLocked()
	rules := resolveTimingRules(r.Rules, e.rules)
	e.mu.Unlock()
	return gates, timers, rules, nil
}

func (e *Engine) commitScopedRaceTrackMutationLocked(r *domain.RaceTournamentState) (
	rSnap domain.RaceTournamentState,
	cfgChanged bool,
	pilots []domain.PilotSlot,
	gates []domain.TrackGate,
	subs []EventSubscriber,
) {
	r.TrackInitialized = true
	r.UpdatedAt = nowISO()
	if e.raceState.RaceID == r.RaceID {
		e.raceState.TrackInitialized = true
		e.raceState.TrackSnapshot = cloneTrackGates(r.TrackSnapshot)
		e.raceState.Rules = cloneTimingRulesPtr(r.Rules, e.rules)
		e.raceState.UpdatedAt = r.UpdatedAt
	}
	shouldSyncLive := isRaceOngoing(r) ||
		(e.findAnyOngoingRaceLocked() == nil && e.practiceState.ActiveSessionID == "" && e.raceState.RaceID == r.RaceID)
	if shouldSyncLive {
		e.loadTrackAndRulesIntoLiveEngineLocked(r.TrackSnapshot, r.Rules)
		cfgChanged = true
		pilots = append([]domain.PilotSlot(nil), e.pilots...)
		gates = append([]domain.TrackGate(nil), e.gates...)
	}
	if e.raceState.RaceID != "" {
		rSnap = cloneRaceState(e.raceState)
	} else {
		rSnap = cloneRaceState(*r)
	}
	subs = append([]EventSubscriber(nil), e.subscribers...)
	return
}

func (e *Engine) ResetRaceTrack(raceID string) ([]domain.TrackGate, error) {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.syncActiveRaceToEventLocked()
	r := e.findRaceByIDLocked(raceID)
	if r == nil {
		e.mu.Unlock()
		return nil, ErrRaceNotFound
	}
	if !isRaceTrackEditable(r) {
		e.mu.Unlock()
		return nil, ErrRaceTrackReadOnly
	}
	e.ensureRaceTrackInitializedLocked(r)
	r.TrackSnapshot = e.defaultTrackSliceForModeLocked(e.isSimEngine)
	outGates := cloneTrackGates(r.TrackSnapshot)
	rSnap, cfgChanged, pilots, liveGates, subs := e.commitScopedRaceTrackMutationLocked(r)
	e.mu.Unlock()

	if cfgChanged {
		for _, s := range subs {
			s.OnConfigUpdated(pilots, liveGates)
		}
	}
	e.notifyRaceUpdated(rSnap, nil, subs)
	return outGates, nil
}

func (e *Engine) AddRaceGate(raceID string, name string, assignedTimerID uint8, trackOrder ...int) (domain.TrackGate, error) {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.syncActiveRaceToEventLocked()
	r := e.findRaceByIDLocked(raceID)
	if r == nil {
		e.mu.Unlock()
		return domain.TrackGate{}, ErrRaceNotFound
	}
	if !isRaceTrackEditable(r) {
		e.mu.Unlock()
		return domain.TrackGate{}, ErrRaceTrackReadOnly
	}
	e.ensureRaceTrackInitializedLocked(r)
	nextSlice, created, err := e.applyAddGateToSliceLocked(r.TrackSnapshot, name, assignedTimerID, trackOrder...)
	if err != nil {
		e.mu.Unlock()
		return domain.TrackGate{}, err
	}
	r.TrackSnapshot = nextSlice
	rSnap, cfgChanged, pilots, liveGates, subs := e.commitScopedRaceTrackMutationLocked(r)
	e.mu.Unlock()

	if cfgChanged {
		for _, s := range subs {
			s.OnConfigUpdated(pilots, liveGates)
		}
	}
	e.notifyRaceUpdated(rSnap, nil, subs)
	return created, nil
}

func (e *Engine) UpdateRaceGate(raceID string, u domain.GateUpdate) error {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.syncActiveRaceToEventLocked()
	r := e.findRaceByIDLocked(raceID)
	if r == nil {
		e.mu.Unlock()
		return ErrRaceNotFound
	}
	if !isRaceTrackEditable(r) {
		e.mu.Unlock()
		return ErrRaceTrackReadOnly
	}
	e.ensureRaceTrackInitializedLocked(r)
	nextSlice, err := e.applyUpdateGateInSliceLocked(r.TrackSnapshot, u)
	if err != nil {
		e.mu.Unlock()
		return err
	}
	r.TrackSnapshot = nextSlice
	rSnap, cfgChanged, pilots, liveGates, subs := e.commitScopedRaceTrackMutationLocked(r)
	e.mu.Unlock()

	if cfgChanged {
		for _, s := range subs {
			s.OnConfigUpdated(pilots, liveGates)
		}
	}
	e.notifyRaceUpdated(rSnap, nil, subs)
	return nil
}

func (e *Engine) RemoveRaceGate(raceID string, gateID uint8) error {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.syncActiveRaceToEventLocked()
	r := e.findRaceByIDLocked(raceID)
	if r == nil {
		e.mu.Unlock()
		return ErrRaceNotFound
	}
	if !isRaceTrackEditable(r) {
		e.mu.Unlock()
		return ErrRaceTrackReadOnly
	}
	e.ensureRaceTrackInitializedLocked(r)
	nextSlice, err := e.applyRemoveGateFromSliceLocked(r.TrackSnapshot, gateID)
	if err != nil {
		e.mu.Unlock()
		return err
	}
	r.TrackSnapshot = nextSlice
	rSnap, cfgChanged, pilots, liveGates, subs := e.commitScopedRaceTrackMutationLocked(r)
	e.mu.Unlock()

	if cfgChanged {
		for _, s := range subs {
			s.OnConfigUpdated(pilots, liveGates)
		}
	}
	e.notifyRaceUpdated(rSnap, nil, subs)
	return nil
}

func (e *Engine) SetRaceRules(raceID string, rules domain.TimingRules) (domain.TimingRules, error) {
	norm := rules.Normalized()
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.syncActiveRaceToEventLocked()
	r := e.findRaceByIDLocked(raceID)
	if r == nil {
		e.mu.Unlock()
		return domain.TimingRules{}, ErrRaceNotFound
	}
	if !isRaceTrackEditable(r) {
		e.mu.Unlock()
		return domain.TimingRules{}, ErrRaceTrackReadOnly
	}
	e.ensureRaceTrackInitializedLocked(r)
	cp := norm
	r.Rules = &cp
	rSnap, cfgChanged, pilots, liveGates, subs := e.commitScopedRaceTrackMutationLocked(r)
	e.mu.Unlock()

	if cfgChanged {
		for _, s := range subs {
			s.OnConfigUpdated(pilots, liveGates)
		}
	}
	e.notifyRaceUpdated(rSnap, nil, subs)
	return norm, nil
}

func (e *Engine) RaceGateRules(raceID string, gateID uint8) (domain.GateRuleOverrides, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.ensureEventStateInitializedLocked()
	r := e.findRaceByIDLocked(raceID)
	if r == nil {
		return domain.GateRuleOverrides{}, ErrRaceNotFound
	}
	e.ensureRaceTrackInitializedLocked(r)
	idx := indexOfGate(r.TrackSnapshot, gateID)
	if idx < 0 {
		return domain.GateRuleOverrides{}, ErrUnknownGate
	}
	return r.TrackSnapshot[idx].RuleOverrides, nil
}

func (e *Engine) SetRaceGateRules(raceID string, gateID uint8, overrides domain.GateRuleOverrides) (domain.GateRuleOverrides, error) {
	overrides = overrides.Normalized()
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.syncActiveRaceToEventLocked()
	r := e.findRaceByIDLocked(raceID)
	if r == nil {
		e.mu.Unlock()
		return domain.GateRuleOverrides{}, ErrRaceNotFound
	}
	if !isRaceTrackEditable(r) {
		e.mu.Unlock()
		return domain.GateRuleOverrides{}, ErrRaceTrackReadOnly
	}
	e.ensureRaceTrackInitializedLocked(r)
	idx := indexOfGate(r.TrackSnapshot, gateID)
	if idx < 0 {
		e.mu.Unlock()
		return domain.GateRuleOverrides{}, ErrUnknownGate
	}
	r.TrackSnapshot[idx].RuleOverrides = overrides
	rSnap, cfgChanged, pilots, liveGates, subs := e.commitScopedRaceTrackMutationLocked(r)
	e.mu.Unlock()

	if cfgChanged {
		for _, s := range subs {
			s.OnConfigUpdated(pilots, liveGates)
		}
	}
	e.notifyRaceUpdated(rSnap, nil, subs)
	return overrides, nil
}

func (e *Engine) RacePilotGateRules(raceID string, gateID uint8, slotIndex int) (domain.GateRuleOverrides, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.ensureEventStateInitializedLocked()
	r := e.findRaceByIDLocked(raceID)
	if r == nil {
		return domain.GateRuleOverrides{}, ErrRaceNotFound
	}
	e.ensureRaceTrackInitializedLocked(r)
	idx := indexOfGate(r.TrackSnapshot, gateID)
	if idx < 0 {
		return domain.GateRuleOverrides{}, ErrUnknownGate
	}
	if e.slotPositionLocked(slotIndex) < 0 {
		return domain.GateRuleOverrides{}, ErrUnknownPilot
	}
	return r.TrackSnapshot[idx].PilotRuleOverrides[slotIndex], nil
}

func (e *Engine) SetRacePilotGateRules(raceID string, gateID uint8, slotIndex int, overrides domain.GateRuleOverrides) (domain.GateRuleOverrides, error) {
	overrides = overrides.Normalized()
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.syncActiveRaceToEventLocked()
	r := e.findRaceByIDLocked(raceID)
	if r == nil {
		e.mu.Unlock()
		return domain.GateRuleOverrides{}, ErrRaceNotFound
	}
	if !isRaceTrackEditable(r) {
		e.mu.Unlock()
		return domain.GateRuleOverrides{}, ErrRaceTrackReadOnly
	}
	e.ensureRaceTrackInitializedLocked(r)
	idx := indexOfGate(r.TrackSnapshot, gateID)
	if idx < 0 {
		e.mu.Unlock()
		return domain.GateRuleOverrides{}, ErrUnknownGate
	}
	if e.slotPositionLocked(slotIndex) < 0 {
		e.mu.Unlock()
		return domain.GateRuleOverrides{}, ErrUnknownPilot
	}
	prev := r.TrackSnapshot[idx].PilotRuleOverrides
	next := make(map[int]domain.GateRuleOverrides, len(prev)+1)
	for k, v := range prev {
		if k != slotIndex {
			next[k] = v
		}
	}
	if !overrides.IsEmpty() {
		next[slotIndex] = overrides
	}
	if len(next) == 0 {
		r.TrackSnapshot[idx].PilotRuleOverrides = nil
	} else {
		r.TrackSnapshot[idx].PilotRuleOverrides = next
	}
	rSnap, cfgChanged, pilots, liveGates, subs := e.commitScopedRaceTrackMutationLocked(r)
	e.mu.Unlock()

	if cfgChanged {
		for _, s := range subs {
			s.OnConfigUpdated(pilots, liveGates)
		}
	}
	e.notifyRaceUpdated(rSnap, nil, subs)
	return overrides, nil
}

func (e *Engine) applyGateThresholdsToSliceLocked(
	gates []domain.TrackGate,
	updates []domain.GateThresholdUpdate,
	isLiveContext bool,
) ([]domain.TrackGate, bool, error) {
	type target struct {
		gate, slot              int
		slotIndex               int
		gateID                  uint8
		auto                    bool
		enter, exit, laprfT     float32
		rhEnter, rhExit         float32
		hasDbm, hasLaprf, hasRH bool
	}
	cur := cloneTrackGates(gates)
	targets := make([]target, 0, len(updates))
	hwMode := domain.NormalizeTimingHardwareMode(e.timingHardwareMode)
	isLapRFMode := domain.IsLapRFMode(hwMode)
	isRHMode := domain.IsRotorHazardMode(hwMode)

	for _, u := range updates {
		gi := indexOfGate(cur, u.GateID)
		if gi < 0 {
			return gates, false, ErrUnknownGate
		}
		si := e.slotPositionLocked(u.SlotIndex)
		if si < 0 {
			return gates, false, ErrUnknownPilot
		}
		var t target
		t.gate = gi
		t.slot = si
		t.slotIndex = u.SlotIndex
		t.gateID = u.GateID
		t.auto = u.Auto

		if u.RHEnterThreshold != 0 || u.RHExitThreshold != 0 || (isRHMode && u.EnterDbm >= 0) {
			rawEn := u.RHEnterThreshold
			if rawEn == 0 {
				rawEn = u.EnterDbm
			}
			rawEx := u.RHExitThreshold
			if rawEx == 0 {
				rawEx = u.ExitDbm
			}
			t.hasRH = true
			if rawEn <= 0 && rawEx <= 0 {
				t.rhEnter = 0
				t.rhExit = 0
			} else {
				effEn := rawEn
				if effEn <= 0 {
					effEn, _ = rhThresholdsFor(&cur[gi], si, e.pilots[si])
				} else {
					effEn = clampRHEnterThreshold(effEn)
				}
				t.rhEnter = effEn
				if rawEx > 0 {
					t.rhExit = clampRHExitThreshold(rawEx, effEn)
				} else if si >= 0 && si < len(cur[gi].RHExitThresholds) && cur[gi].RHExitThresholds[si] > 0 {
					t.rhExit = clampRHExitThreshold(cur[gi].RHExitThresholds[si], effEn)
				} else {
					t.rhExit = 0
				}
			}
		} else if isRHMode && u.EnterDbm < 0 {
			t.hasRH = true
			effEn := dbmToRHEnter(u.EnterDbm)
			t.rhEnter = effEn
			if u.ExitDbm < 0 {
				t.rhExit = dbmToRHExit(u.ExitDbm, effEn)
			} else {
				t.rhExit = clampRHExitThreshold(effEn-defaultRHExitGap, effEn)
			}
		} else if u.LapRFThreshold != 0 || (isLapRFMode && u.EnterDbm > 0) {
			rawT := u.LapRFThreshold
			if rawT == 0 {
				rawT = u.EnterDbm
			}
			t.hasLaprf = true
			if rawT < 0 {
				t.laprfT = 0
			} else {
				t.laprfT = clampLapRFThreshold(rawT)
			}
		}

		if (!isLapRFMode && !isRHMode) || u.EnterDbm < 0 || (u.EnterDbm == 0 && u.LapRFThreshold == 0 && u.RHEnterThreshold == 0 && !isLapRFMode && !isRHMode) {
			t.hasDbm = true
			enter := u.EnterDbm
			if enter != 0 {
				enter = clampDbm(enter)
			}
			exit := u.ExitDbm
			if exit != 0 {
				effEnter := enter
				if effEnter == 0 {
					effEnter = e.pilots[si].EnterThreshold
				}
				exit = clampExitDbm(exit, effEnter)
			}
			t.enter = enter
			t.exit = exit
		} else if isLapRFMode && u.EnterDbm == 0 && u.LapRFThreshold == 0 {
			t.hasLaprf = true
			t.laprfT = 0
		}
		targets = append(targets, t)
	}

	sfUpdated := false
	for _, t := range targets {
		if t.slot >= 0 && t.slot < len(cur[t.gate].EnterThresholds) {
			if t.hasDbm {
				cur[t.gate].EnterThresholds[t.slot] = t.enter
				cur[t.gate].ExitThresholds[t.slot] = t.exit
				if isLiveContext {
					e.setAutoCalibManualPinLocked(t.gateID, t.slotIndex, t.enter != 0 && !t.auto, t.enter == 0)
					if det := e.detectors[detKey{t.gateID, t.slotIndex}]; det != nil {
						_, effEx := thresholdsFor(&cur[t.gate], t.slot, e.pilots[t.slot])
						det.RearmIfBelow(effEx)
					}
				}
			}
			if t.hasLaprf {
				cur[t.gate].LapRFThresholds[t.slot] = t.laprfT
			}
			if t.hasRH {
				cur[t.gate].RHEnterThresholds[t.slot] = t.rhEnter
				cur[t.gate].RHExitThresholds[t.slot] = t.rhExit
			}
		}
		if cur[t.gate].Role == domain.GateRoleStartFinish {
			sfUpdated = true
		}
	}
	return cur, sfUpdated, nil
}

func (e *Engine) syncRaceStartFinishSeatThresholdsForRaceLocked(r *domain.RaceTournamentState) {
	if r == nil || !r.Generated {
		return
	}
	var sfGate *domain.TrackGate
	for gi := range r.TrackSnapshot {
		if r.TrackSnapshot[gi].Role == domain.GateRoleStartFinish {
			sfGate = &r.TrackSnapshot[gi]
			break
		}
	}
	if sfGate == nil {
		return
	}
	hwMode := domain.NormalizeTimingHardwareMode(e.timingHardwareMode)
	for hi := range r.Heats {
		h := &r.Heats[hi]
		if h.State == domain.HeatConfirmed {
			continue
		}
		for si := range h.Seats {
			slotIdx := h.Seats[si].PilotSlotIndex
			if slotIdx <= 0 {
				continue
			}
			pPos := e.slotPositionLocked(slotIdx)
			if pPos < 0 {
				continue
			}
			var en, ex float32
			switch hwMode {
			case domain.HardwareModeLapRF, domain.HardwareModeLapRFUSB:
				en = laprfThresholdFor(sfGate, pPos, e.pilots[pPos])
				ex = en
			case domain.HardwareModeRotorHazard, domain.HardwareModeRotorHazardUSB:
				en, ex = rhThresholdsFor(sfGate, pPos, e.pilots[pPos])
			default:
				en, ex = thresholdsFor(sfGate, pPos, e.pilots[pPos])
			}
			h.Seats[si].EnterRssiDbm = en
			h.Seats[si].ExitRssiDbm = ex
		}
	}
}

func (e *Engine) SetPracticeGateThresholds(sessionID string, updates []domain.GateThresholdUpdate) error {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.ensurePracticeStateInitializedLocked()
	sess := e.findPracticeSessionLocked(strings.TrimSpace(sessionID))
	if sess == nil {
		e.mu.Unlock()
		return ErrPracticeNotFound
	}
	e.ensurePracticeTrackInitializedLocked(sess)
	isLive := sess.Active || (e.findAnyOngoingRaceLocked() == nil && e.practiceState.ActiveSessionID == "" && e.practiceState.SelectedSessionID == sess.SessionID)
	nextSlice, _, err := e.applyGateThresholdsToSliceLocked(sess.TrackSnapshot, updates, isLive)
	if err != nil {
		e.mu.Unlock()
		return err
	}
	sess.TrackSnapshot = nextSlice
	pSnap, cfgChanged, pilots, liveGates, subs := e.commitScopedPracticeTrackMutationLocked(sess)
	e.mu.Unlock()

	if cfgChanged {
		for _, s := range subs {
			s.OnConfigUpdated(pilots, liveGates)
		}
	}
	e.notifyPracticeUpdated(pSnap, subs)
	return nil
}

func (e *Engine) SetRaceGateThresholds(raceID string, updates []domain.GateThresholdUpdate) error {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.syncActiveRaceToEventLocked()
	r := e.findRaceByIDLocked(raceID)
	if r == nil {
		e.mu.Unlock()
		return ErrRaceNotFound
	}
	if !isRaceTrackEditable(r) {
		e.mu.Unlock()
		return ErrRaceTrackReadOnly
	}
	e.ensureRaceTrackInitializedLocked(r)
	isLive := isRaceOngoing(r) || (e.findAnyOngoingRaceLocked() == nil && e.practiceState.ActiveSessionID == "" && e.raceState.RaceID == r.RaceID)
	nextSlice, sfUpdated, err := e.applyGateThresholdsToSliceLocked(r.TrackSnapshot, updates, isLive)
	if err != nil {
		e.mu.Unlock()
		return err
	}
	r.TrackSnapshot = nextSlice
	if sfUpdated {
		e.syncRaceStartFinishSeatThresholdsForRaceLocked(r)
		if e.raceState.RaceID == r.RaceID {
			e.syncRaceStartFinishSeatThresholdsForRaceLocked(&e.raceState)
		}
	}
	rSnap, cfgChanged, pilots, liveGates, subs := e.commitScopedRaceTrackMutationLocked(r)
	e.mu.Unlock()

	if cfgChanged {
		for _, s := range subs {
			s.OnConfigUpdated(pilots, liveGates)
		}
	}
	e.notifyRaceUpdated(rSnap, nil, subs)
	return nil
}

// propagateTimerColorToTracksLocked updates the cached Color on gates bound to `timerID` across
// all Practice sessions and editable Races without modifying gate count, order, or rules.
func (e *Engine) propagateTimerColorToTracksLocked(timerID uint8, color string) (*domain.PracticeManagerState, *domain.RaceTournamentState) {
	practiceTouched := false
	for i := range e.practiceState.Sessions {
		s := &e.practiceState.Sessions[i]
		for gi := range s.TrackSnapshot {
			if s.TrackSnapshot[gi].AssignedTimerID == timerID {
				s.TrackSnapshot[gi].Color = color
				practiceTouched = true
			}
		}
	}
	raceTouched := false
	if isRaceTrackEditable(&e.raceState) {
		for gi := range e.raceState.TrackSnapshot {
			if e.raceState.TrackSnapshot[gi].AssignedTimerID == timerID {
				e.raceState.TrackSnapshot[gi].Color = color
				raceTouched = true
			}
		}
	}
	for i := range e.eventState.Races {
		r := &e.eventState.Races[i]
		if !isRaceTrackEditable(r) {
			continue
		}
		for gi := range r.TrackSnapshot {
			if r.TrackSnapshot[gi].AssignedTimerID == timerID {
				r.TrackSnapshot[gi].Color = color
				raceTouched = true
			}
		}
	}
	var pOut *domain.PracticeManagerState
	if practiceTouched {
		cp := clonePracticeManagerState(e.practiceState)
		pOut = &cp
	}
	var rOut *domain.RaceTournamentState
	if raceTouched {
		cp := cloneRaceState(e.raceState)
		rOut = &cp
	}
	return pOut, rOut
}

// propagateTimerRemovalToTracksLocked removes or unbinds gates bound to `timerID` across editable
// Practice sessions and editable Races without replacing unrelated gates.
func (e *Engine) propagateTimerRemovalToTracksLocked(timerID uint8, deleteGates bool) (*domain.PracticeManagerState, *domain.RaceTournamentState) {
	cleanSlice := func(in []domain.TrackGate) ([]domain.TrackGate, bool) {
		changed := false
		if deleteGates {
			kept := make([]domain.TrackGate, 0, len(in))
			for _, g := range in {
				if g.AssignedTimerID == timerID {
					changed = true
					continue
				}
				kept = append(kept, cloneTrackGate(g))
			}
			if !changed {
				return in, false
			}
			return e.enrichTrackGatesLocked(kept), true
		}
		out := cloneTrackGates(in)
		for i := range out {
			if out[i].AssignedTimerID == timerID {
				out[i].AssignedTimerID = 0
				out[i].TimerLabel = ""
				out[i].Online = false
				out[i].LastSeenAt = time.Time{}
				changed = true
			}
		}
		if !changed {
			return in, false
		}
		return e.enrichTrackGatesLocked(out), true
	}

	practiceTouched := false
	for i := range e.practiceState.Sessions {
		s := &e.practiceState.Sessions[i]
		if next, ok := cleanSlice(s.TrackSnapshot); ok {
			s.TrackSnapshot = next
			s.Summaries = e.computePracticeSessionSummariesLocked(s)
			practiceTouched = true
		}
	}
	raceTouched := false
	if isRaceTrackEditable(&e.raceState) {
		if next, ok := cleanSlice(e.raceState.TrackSnapshot); ok {
			e.raceState.TrackSnapshot = next
			raceTouched = true
		}
	}
	for i := range e.eventState.Races {
		r := &e.eventState.Races[i]
		if !isRaceTrackEditable(r) {
			continue
		}
		if next, ok := cleanSlice(r.TrackSnapshot); ok {
			r.TrackSnapshot = next
			raceTouched = true
		}
	}
	var pOut *domain.PracticeManagerState
	if practiceTouched {
		cp := clonePracticeManagerState(e.practiceState)
		pOut = &cp
	}
	var rOut *domain.RaceTournamentState
	if raceTouched {
		cp := cloneRaceState(e.raceState)
		rOut = &cp
	}
	return pOut, rOut
}
