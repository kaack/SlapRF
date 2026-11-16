package tracker

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"slaprf/internal/domain"
	"slaprf/internal/dsp"
)

// PracticeEventSubscriber is an optional interface implemented by EventSubscribers (such as the
// WASM bridge) that want real-time PracticeManagerState updates.
type PracticeEventSubscriber interface {
	OnPracticeUpdated(state domain.PracticeManagerState)
}

// PracticeActionPayload represents a Practice Session CRUD, RF activation, or session pilot action.
type PracticeActionPayload struct {
	Action         string      `json:"action"` // "create_session" | "select_session" | "rename_session" | "set_session_tags" | "delete_session" | "start_session" | "resume_session" | "pause_session" | "stop_session" | "add_session_pilot" | "remove_session_pilot" | "set_session_pilot_channel" | "clear_session_laps"
	SessionID      string      `json:"sessionId,omitempty"`
	Name           string      `json:"name,omitempty"`
	Tags           []string    `json:"tags,omitempty"`
	DontSelect     bool        `json:"dontSelect,omitempty"`
	PreemptOngoing bool        `json:"preemptOngoing,omitempty"`
	SlotIndex      int         `json:"slotIndex,omitempty"`
	Callsign       string      `json:"callsign,omitempty"`
	PhoneticName   string      `json:"phoneticName,omitempty"`
	Band           domain.Band `json:"band,omitempty"`
	Channel        uint8       `json:"channel,omitempty"`
}

func clonePracticeSession(s domain.PracticeSession) domain.PracticeSession {
	out := s
	out.Tags = append([]string(nil), s.Tags...)
	out.Pilots = append([]domain.PracticeSessionPilot(nil), s.Pilots...)
	out.TrackSnapshot = append([]domain.TrackGate(nil), s.TrackSnapshot...)
	out.Laps = cloneLaps(s.Laps)
	out.Crossings = append([]domain.GateCrossingEvent(nil), s.Crossings...)
	out.Filtered = append([]domain.FilteredDetection(nil), s.Filtered...)
	out.Summaries = make([]domain.PilotTrackSummary, len(s.Summaries))
	for i, sum := range s.Summaries {
		cp := sum
		cp.SectorStats = append([]domain.SectorBottleneckStat(nil), sum.SectorStats...)
		out.Summaries[i] = cp
	}
	return out
}

func clonePracticeManagerState(st domain.PracticeManagerState) domain.PracticeManagerState {
	out := domain.PracticeManagerState{
		Initialized:       st.Initialized,
		ActiveSessionID:   st.ActiveSessionID,
		SelectedSessionID: st.SelectedSessionID,
		Sessions:          make([]domain.PracticeSession, len(st.Sessions)),
	}
	for i, s := range st.Sessions {
		out.Sessions[i] = clonePracticeSession(s)
	}
	return out
}

func (e *Engine) findAnyOngoingRaceLocked() *domain.RaceTournamentState {
	if e.raceState.RaceID != "" && isRaceOngoing(&e.raceState) {
		return &e.raceState
	}
	for i := range e.eventState.Races {
		if isRaceOngoing(&e.eventState.Races[i]) {
			return &e.eventState.Races[i]
		}
	}
	return nil
}

func (e *Engine) findOtherOngoingRaceLocked(excludeRaceID string) *domain.RaceTournamentState {
	for i := range e.eventState.Races {
		r := &e.eventState.Races[i]
		if r.RaceID != "" && r.RaceID != excludeRaceID && isRaceOngoing(r) {
			return r
		}
	}
	return nil
}

func raceDisplayName(r *domain.RaceTournamentState) string {
	if r == nil {
		return "Race"
	}
	if n := strings.TrimSpace(r.Config.EventName); n != "" {
		return n
	}
	if r.RaceID != "" {
		return r.RaceID
	}
	return "Race"
}

func (e *Engine) ensurePracticeStateInitializedLocked() {
	now := nowISO()
	if !e.practiceState.Initialized {
		initPilots := make([]domain.PracticeSessionPilot, 0, domain.MaxPilotSlots)
		for _, p := range e.pilots {
			if !p.Enabled || len(initPilots) >= domain.MaxPilotSlots {
				continue
			}
			band := p.Band
			if band == 0 {
				band = domain.BandRaceband
			}
			freq := p.FrequencyMHz
			if freq == 0 && p.Channel > 0 {
				freq = domain.FrequencyForBandChannel(band, p.Channel)
			}
			initPilots = append(initPilots, domain.PracticeSessionPilot{
				SlotIndex:    p.SlotIndex,
				Callsign:     p.Callsign,
				PhoneticName: p.PhoneticName,
				Color:        p.Color,
				Band:         band,
				Channel:      p.Channel,
				FrequencyMHz: freq,
			})
		}

		isActive := e.findAnyOngoingRaceLocked() == nil && !e.isLiveRaceHeatActiveLocked() && e.raceArmed
		sessID := e.nextUniqueIDLocked("session")
		sess := domain.PracticeSession{
			SessionID:     sessID,
			Name:          "Open Practice",
			Tags:          []string{},
			Active:        isActive,
			CreatedAt:     now,
			UpdatedAt:     now,
			Pilots:        initPilots,
			TrackSnapshot: e.snapshotOrderedGatesLocked(),
			Laps:          cloneLaps(e.laps),
			Crossings:     append([]domain.GateCrossingEvent(nil), e.crossings...),
			Filtered:      append([]domain.FilteredDetection(nil), e.filtered...),
		}
		sess.Summaries = e.computePracticeSessionSummariesLocked(&sess)

		activeID := ""
		if isActive {
			activeID = sessID
		}
		e.practiceState = domain.PracticeManagerState{
			Initialized:       true,
			ActiveSessionID:   activeID,
			SelectedSessionID: sessID,
			Sessions:          []domain.PracticeSession{sess},
		}
		return
	}

	if e.practiceState.Sessions == nil {
		e.practiceState.Sessions = []domain.PracticeSession{}
	}

	globalBySlot := make(map[int]domain.PilotSlot, len(e.pilots))
	for _, p := range e.pilots {
		globalBySlot[p.SlotIndex] = p
	}

	ongoingRace := e.findAnyOngoingRaceLocked() != nil || e.isLiveRaceHeatActiveLocked()
	foundActiveID := ""
	foundSelected := false

	for i := range e.practiceState.Sessions {
		s := &e.practiceState.Sessions[i]
		s.Tags = domain.NormalizeRaceTags(s.Tags)
		if s.Pilots == nil {
			s.Pilots = []domain.PracticeSessionPilot{}
		}
		if s.Laps == nil {
			s.Laps = []domain.LapRecord{}
		}
		if s.Crossings == nil {
			s.Crossings = []domain.GateCrossingEvent{}
		}
		if s.Filtered == nil {
			s.Filtered = []domain.FilteredDetection{}
		}
		for pi := range s.Pilots {
			if gp, ok := globalBySlot[s.Pilots[pi].SlotIndex]; ok {
				s.Pilots[pi].Callsign = gp.Callsign
				s.Pilots[pi].PhoneticName = gp.PhoneticName
				if gp.Color != "" {
					s.Pilots[pi].Color = gp.Color
				}
			}
			if s.Pilots[pi].Band == 0 {
				s.Pilots[pi].Band = domain.BandRaceband
			}
			if s.Pilots[pi].Channel == 0 {
				s.Pilots[pi].FrequencyMHz = 0
			} else if s.Pilots[pi].FrequencyMHz == 0 {
				s.Pilots[pi].FrequencyMHz = domain.FrequencyForBandChannel(s.Pilots[pi].Band, s.Pilots[pi].Channel)
			}
		}

		if ongoingRace {
			s.Active = false
		} else if s.Active || (e.practiceState.ActiveSessionID != "" && s.SessionID == e.practiceState.ActiveSessionID) {
			if foundActiveID == "" {
				s.Active = true
				s.Paused = false
				foundActiveID = s.SessionID
			} else {
				s.Active = false
			}
		} else {
			s.Active = false
		}

		if s.SessionID == e.practiceState.SelectedSessionID {
			foundSelected = true
		}
		if s.Active {
			s.TrackSnapshot = e.snapshotOrderedGatesLocked()
		} else if len(s.TrackSnapshot) == 0 {
			s.TrackSnapshot = e.snapshotOrderedGatesLocked()
		}
		s.Summaries = e.computePracticeSessionSummariesLocked(s)
	}
	e.disambiguateDuplicatePracticeNamesLocked()

	e.practiceState.ActiveSessionID = foundActiveID
	if !foundSelected {
		if foundActiveID != "" {
			e.practiceState.SelectedSessionID = foundActiveID
		} else if len(e.practiceState.Sessions) > 0 {
			e.practiceState.SelectedSessionID = e.practiceState.Sessions[0].SessionID
		} else {
			e.practiceState.SelectedSessionID = ""
		}
	}
}

func (e *Engine) findPracticeSessionLocked(sessionID string) *domain.PracticeSession {
	if sessionID == "" {
		return nil
	}
	for i := range e.practiceState.Sessions {
		if e.practiceState.Sessions[i].SessionID == sessionID {
			return &e.practiceState.Sessions[i]
		}
	}
	return nil
}

func (e *Engine) findDuplicatePracticeBySlugLocked(name string, excludeSessionID string) *domain.PracticeSession {
	want := domain.SlugifyPracticeName(name)
	for i := range e.practiceState.Sessions {
		s := &e.practiceState.Sessions[i]
		if excludeSessionID != "" && s.SessionID == excludeSessionID {
			continue
		}
		if domain.SlugifyPracticeName(s.Name) == want {
			return s
		}
	}
	return nil
}

func (e *Engine) nextDefaultPracticeNameLocked() string {
	n := len(e.practiceState.Sessions) + 1
	if n < 1 {
		n = 1
	}
	for {
		cand := fmt.Sprintf("Session %d", n)
		if e.findDuplicatePracticeBySlugLocked(cand, "") == nil {
			return cand
		}
		n++
	}
}

func (e *Engine) disambiguateDuplicatePracticeNamesLocked() {
	seen := make(map[string]bool, len(e.practiceState.Sessions))
	for i := range e.practiceState.Sessions {
		s := &e.practiceState.Sessions[i]
		base := strings.TrimSpace(s.Name)
		if base == "" {
			base = fmt.Sprintf("Session %d", i+1)
		}
		slug := domain.SlugifyPracticeName(base)
		if !seen[slug] {
			seen[slug] = true
			if s.Name != base {
				s.Name = base
			}
			continue
		}
		for suffix := 2; ; suffix++ {
			cand := fmt.Sprintf("%s (%d)", base, suffix)
			candSlug := domain.SlugifyPracticeName(cand)
			if !seen[candSlug] {
				seen[candSlug] = true
				s.Name = cand
				break
			}
		}
	}
}

// computePracticeSessionSummariesLocked computes PilotTrackSummary rows strictly for the pilots
// currently assigned in `sess.Pilots`, derived from `sess.Laps`.
func (e *Engine) computePracticeSessionSummariesLocked(sess *domain.PracticeSession) []domain.PilotTrackSummary {
	if sess == nil || len(sess.Pilots) == 0 {
		return []domain.PilotTrackSummary{}
	}
	isActive := sess.Active && sess.SessionID == e.practiceState.ActiveSessionID && !e.isLiveRaceHeatActiveLocked()
	var ordered []domain.TrackGate
	var detected map[uint8]*domain.DetectedTimer
	if !sess.Active && len(sess.TrackSnapshot) > 0 {
		ordered = append([]domain.TrackGate(nil), sess.TrackSnapshot...)
		sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].TrackOrder < ordered[j].TrackOrder })
		detected = nil
	} else {
		ordered = e.orderedGatesLocked()
		detected = e.detected
	}
	numSectors := len(ordered)

	// Index sector splits per (slotIndex, "from>to") from sess.Laps
	secHist := make(map[string][]domain.SectorSplit)
	for _, l := range sess.Laps {
		for _, split := range l.Sectors {
			sKey := sectorKey(l.SlotIndex, pairKey(split.FromGateID, split.ToGateID))
			secHist[sKey] = append(secHist[sKey], split)
		}
	}

	summaries := make([]domain.PilotTrackSummary, 0, len(sess.Pilots))
	for _, sp := range sess.Pilots {
		var lapsCompleted int
		var lastLapSec, bestLapSec float64
		for _, l := range sess.Laps {
			if l.SlotIndex == sp.SlotIndex {
				lapsCompleted++
				lastLapSec = l.LapTimeSec
				if bestLapSec == 0 || l.LapTimeSec < bestLapSec {
					bestLapSec = l.LapTimeSec
				}
			}
		}

		sectorStats := make([]domain.SectorBottleneckStat, 0, numSectors)
		var theoreticalBest float64
		allSectorsHaveBest := numSectors >= 1

		for sIdx := 1; sIdx <= numSectors; sIdx++ {
			fromGate := ordered[(sIdx-1)%numSectors].GateID
			toGate := ordered[sIdx%numSectors].GateID
			hist := secHist[sectorKey(sp.SlotIndex, pairKey(fromGate, toGate))]
			stat := domain.SectorBottleneckStat{
				SectorIndex: sIdx,
				Label:       sectionLabelFromGates(ordered, detected, fromGate, toGate),
				FromGateID:  fromGate,
				ToGateID:    toGate,
			}
			if len(hist) == 0 {
				allSectorsHaveBest = false
				sectorStats = append(sectorStats, stat)
				continue
			}

			best := hist[0].SplitSeconds
			var sum, speedSum float64
			for _, h := range hist {
				best = math.Min(best, h.SplitSeconds)
				sum += h.SplitSeconds
				speedSum += h.ExitSpeedMph
			}
			avg := sum / float64(len(hist))
			var varianceSum float64
			for _, h := range hist {
				varianceSum += (h.SplitSeconds - avg) * (h.SplitSeconds - avg)
			}
			theoreticalBest += best

			stat.BestSplitSec = round3(best)
			stat.AverageSplitSec = round3(avg)
			stat.StdDevSec = round3(math.Sqrt(varianceSum / float64(len(hist))))
			stat.AvgTimeLostSec = round3(avg - best)
			stat.AverageExitSpeedMph = math.Round(speedSum/float64(len(hist))*10) / 10
			sectorStats = append(sectorStats, stat)
		}

		if !allSectorsHaveBest {
			theoreticalBest = 0
		}
		var potentialGain float64
		if bestLapSec > 0 && theoreticalBest > 0 && bestLapSec > theoreticalBest {
			potentialGain = round3(bestLapSec - theoreticalBest)
		}

		curSector := 1
		var lastGate uint8 = 1
		if isActive {
			if prog, ok := e.progress[sp.SlotIndex]; ok && prog.lastGateID > 0 {
				curSector = len(prog.currentSectors) + 1
				lastGate = prog.lastGateID
			}
		} else if len(sess.Crossings) > 0 {
			for ci := len(sess.Crossings) - 1; ci >= 0; ci-- {
				if sess.Crossings[ci].SlotIndex == sp.SlotIndex {
					lastGate = sess.Crossings[ci].GateID
					break
				}
			}
		}

		summaries = append(summaries, domain.PilotTrackSummary{
			SlotIndex:          sp.SlotIndex,
			Callsign:           sp.Callsign,
			Color:              sp.Color,
			ChannelLabel:       sp.ChannelLabel(),
			LapsCompleted:      lapsCompleted,
			LastLapSec:         lastLapSec,
			BestLapSec:         bestLapSec,
			TheoreticalBestSec: round3(theoreticalBest),
			PotentialGainSec:   potentialGain,
			CurrentSectorIndex: curSector,
			LastGateID:         lastGate,
			SectorStats:        sectorStats,
		})
	}

	sort.Slice(summaries, func(i, j int) bool {
		a, b := summaries[i], summaries[j]
		if a.BestLapSec > 0 && b.BestLapSec > 0 {
			return a.BestLapSec < b.BestLapSec
		}
		if a.BestLapSec > 0 != (b.BestLapSec > 0) {
			return a.BestLapSec > 0
		}
		return a.SlotIndex < b.SlotIndex
	})
	return summaries
}

// syncActivePracticeRecordsLocked flushes the engine's live practice buffers (`e.laps`,
// `e.crossings`, `e.filtered`) into whichever PracticeSession is currently `Active`.
func (e *Engine) syncActivePracticeRecordsLocked() {
	e.ensurePracticeStateInitializedLocked()
	if e.isLiveRaceHeatActiveLocked() || e.practiceState.ActiveSessionID == "" {
		return
	}
	sess := e.findPracticeSessionLocked(e.practiceState.ActiveSessionID)
	if sess == nil {
		return
	}
	sess.TrackSnapshot = e.snapshotOrderedGatesLocked()
	sess.Laps = cloneLaps(e.laps)
	sess.Crossings = append([]domain.GateCrossingEvent(nil), e.crossings...)
	sess.Filtered = append([]domain.FilteredDetection(nil), e.filtered...)
	sess.UpdatedAt = nowISO()
	sess.Summaries = e.computePracticeSessionSummariesLocked(sess)
}

// syncActivePracticePilotsFromEngineLocked mirrors direct `e.pilots` RF slot changes (e.g. from
// UpdatePilotSlot or ApplyLapRFSetup when no race heat is running) into the active PracticeSession.
func (e *Engine) syncActivePracticePilotsFromEngineLocked() {
	e.ensurePracticeStateInitializedLocked()
	if e.isLiveRaceHeatActiveLocked() || e.practiceState.ActiveSessionID == "" {
		return
	}
	sess := e.findPracticeSessionLocked(e.practiceState.ActiveSessionID)
	if sess == nil {
		return
	}
	nextPilots := make([]domain.PracticeSessionPilot, 0, domain.MaxPilotSlots)
	for _, p := range e.pilots {
		if !p.Enabled || len(nextPilots) >= domain.MaxPilotSlots {
			continue
		}
		band := p.Band
		if band == 0 {
			band = domain.BandRaceband
		}
		freq := p.FrequencyMHz
		if freq == 0 && p.Channel > 0 {
			freq = domain.FrequencyForBandChannel(band, p.Channel)
		}
		nextPilots = append(nextPilots, domain.PracticeSessionPilot{
			SlotIndex:    p.SlotIndex,
			Callsign:     p.Callsign,
			PhoneticName: p.PhoneticName,
			Color:        p.Color,
			Band:         band,
			Channel:      p.Channel,
			FrequencyMHz: freq,
		})
	}
	sess.Pilots = nextPilots
	sess.UpdatedAt = nowISO()
	sess.Summaries = e.computePracticeSessionSummariesLocked(sess)
}

// syncGlobalPilotsToPracticeSessionsLocked refreshes pilot metadata across all sessions and removes
// `removedSlot` (if > 0) from session pilot lineups while retaining recorded laps.
func (e *Engine) syncGlobalPilotsToPracticeSessionsLocked(removedSlot int) {
	e.ensurePracticeStateInitializedLocked()
	globalBySlot := make(map[int]domain.PilotSlot, len(e.pilots))
	for _, p := range e.pilots {
		globalBySlot[p.SlotIndex] = p
	}
	for i := range e.practiceState.Sessions {
		s := &e.practiceState.Sessions[i]
		filtered := make([]domain.PracticeSessionPilot, 0, len(s.Pilots))
		for _, sp := range s.Pilots {
			if removedSlot > 0 && sp.SlotIndex == removedSlot {
				continue
			}
			if gp, ok := globalBySlot[sp.SlotIndex]; ok {
				sp.Callsign = gp.Callsign
				sp.PhoneticName = gp.PhoneticName
				if gp.Color != "" {
					sp.Color = gp.Color
				}
			}
			filtered = append(filtered, sp)
		}
		s.Pilots = filtered
		s.Summaries = e.computePracticeSessionSummariesLocked(s)
	}
}

// syncPracticeSessionRFSlotsLocked tunes `e.pilots` RF slots to `sess.Pilots` (disabling non-session
// pilots while keeping their global default channels untouched on `#/pilots`).
func (e *Engine) syncPracticeSessionRFSlotsLocked(sess *domain.PracticeSession) {
	if sess == nil {
		for i := range e.pilots {
			e.pilots[i].Enabled = false
		}
		return
	}
	bySlot := make(map[int]domain.PracticeSessionPilot, len(sess.Pilots))
	for _, sp := range sess.Pilots {
		bySlot[sp.SlotIndex] = sp
	}
	enabledCount := 0
	usedCh := make(map[uint16]bool)
	for i := range e.pilots {
		if sp, ok := bySlot[e.pilots[i].SlotIndex]; ok && enabledCount < domain.MaxPilotSlots {
			band := sp.Band
			if band == 0 {
				band = domain.BandRaceband
			}
			ch := sp.Channel
			freq := sp.FrequencyMHz
			if ch == 0 {
				freq = 0
			} else if freq == 0 {
				freq = domain.FrequencyForBandChannel(band, ch)
			}
			chKey := freq
			if chKey == 0 && ch > 0 {
				chKey = (uint16(band) << 8) | uint16(ch)
			}
			if ch > 0 && usedCh[chKey] {
				ch = 0
				freq = 0
			} else if ch > 0 {
				usedCh[chKey] = true
			}
			e.pilots[i].Enabled = true
			e.pilots[i].Band = band
			e.pilots[i].Channel = ch
			e.pilots[i].FrequencyMHz = freq
			enabledCount++
		} else {
			e.pilots[i].Enabled = false
		}
	}
}

// applyPracticeSessionToEngineLocked loads `sess`'s pilots and recorded laps/crossings into the
// live engine buffers and arms practice timing.
func (e *Engine) applyPracticeSessionToEngineLocked(sess *domain.PracticeSession) {
	e.syncPracticeSessionRFSlotsLocked(sess)
	e.resetSessionLocked()
	if sess == nil {
		e.raceArmed = false
		return
	}
	e.raceArmed = true
	e.laps = cloneLaps(sess.Laps)
	e.crossings = append([]domain.GateCrossingEvent(nil), sess.Crossings...)
	e.filtered = append([]domain.FilteredDetection(nil), sess.Filtered...)
	for _, lap := range e.laps {
		if lap.LapID > e.nextLapID {
			e.nextLapID = lap.LapID
		}
		for _, split := range lap.Sectors {
			pKey := pairKey(split.FromGateID, split.ToGateID)
			sKey := sectorKey(lap.SlotIndex, pKey)
			e.sectorHistory[sKey] = append(e.sectorHistory[sKey], split)
			if split.SplitSeconds > 0 {
				if e.overallBestSec[pKey] == 0 || split.SplitSeconds < e.overallBestSec[pKey] {
					e.overallBestSec[pKey] = split.SplitSeconds
				}
				if e.pilotBestSec[sKey] == 0 || split.SplitSeconds < e.pilotBestSec[sKey] {
					e.pilotBestSec[sKey] = split.SplitSeconds
				}
			}
		}
	}
	for _, ev := range e.crossings {
		if ev.EventID > e.nextEventID {
			e.nextEventID = ev.EventID
		}
		ckey := detectorKey(ev.GateID, ev.SlotIndex)
		if ev.TimestampUs > e.lastAcceptedUs[ckey] {
			e.lastAcceptedUs[ckey] = ev.TimestampUs
		}
	}
}

// stopActivePracticeSessionLocked saves any recorded buffers into the currently active PracticeSession
// and marks all PracticeSessions inactive (`ActiveSessionID = ""`). Returns true if an active
// PracticeSession was stopped.
func (e *Engine) stopActivePracticeSessionLocked() bool {
	return e.deactivateActivePracticeSessionLocked(false)
}

func (e *Engine) pauseActivePracticeSessionLocked() bool {
	return e.deactivateActivePracticeSessionLocked(true)
}

func (e *Engine) deactivateActivePracticeSessionLocked(markPaused bool) bool {
	e.ensurePracticeStateInitializedLocked()
	if e.practiceState.ActiveSessionID == "" {
		return false
	}
	e.syncActivePracticeRecordsLocked()
	frozenTrack := e.snapshotOrderedGatesLocked()
	now := nowISO()
	for i := range e.practiceState.Sessions {
		if e.practiceState.Sessions[i].Active || e.practiceState.Sessions[i].SessionID == e.practiceState.ActiveSessionID {
			e.practiceState.Sessions[i].TrackSnapshot = append([]domain.TrackGate(nil), frozenTrack...)
			e.practiceState.Sessions[i].Paused = markPaused
			e.practiceState.Sessions[i].UpdatedAt = now
		}
		e.practiceState.Sessions[i].Active = false
	}
	e.practiceState.ActiveSessionID = ""
	for i := range e.practiceState.Sessions {
		e.practiceState.Sessions[i].Summaries = e.computePracticeSessionSummariesLocked(&e.practiceState.Sessions[i])
	}
	if e.raceState.Mode != domain.ModeRace {
		e.practiceSnap = domain.PracticeSnapshot{}
	}
	if !e.isLiveRaceHeatActiveLocked() {
		for i := range e.pilots {
			e.pilots[i].Enabled = false
		}
		e.raceArmed = false
	}
	return true
}

func (e *Engine) notifyPracticeUpdated(snap domain.PracticeManagerState, subs []EventSubscriber) {
	for _, s := range subs {
		if ps, ok := s.(PracticeEventSubscriber); ok {
			ps.OnPracticeUpdated(snap)
		}
	}
}

// PracticeSnapshot returns a deep copy of the PracticeManagerState with up-to-date active session records.
func (e *Engine) PracticeSnapshot() domain.PracticeManagerState {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.ensurePracticeStateInitializedLocked()
	if !e.isLiveRaceHeatActiveLocked() && e.practiceState.ActiveSessionID != "" {
		e.syncActivePracticeRecordsLocked()
	}
	snap := clonePracticeManagerState(e.practiceState)
	e.mu.Unlock()
	return snap
}

// PracticeAction executes a PracticeSession CRUD, RF start/stop, or pilot assignment operation.
func (e *Engine) PracticeAction(req PracticeActionPayload) (domain.PracticeManagerState, error) {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.syncActiveRaceToEventLocked()
	e.ensurePracticeStateInitializedLocked()
	if !e.isLiveRaceHeatActiveLocked() && e.practiceState.ActiveSessionID != "" {
		e.syncActivePracticeRecordsLocked()
	}

	now := nowISO()
	cfgChanged := false
	raceChanged := false

	resolveTargetID := func() string {
		id := strings.TrimSpace(req.SessionID)
		if id == "" {
			id = e.practiceState.SelectedSessionID
		}
		if id == "" {
			id = e.practiceState.ActiveSessionID
		}
		return id
	}

	switch req.Action {
	case "create_session":
		sessionID := e.nextUniqueIDLocked("session")
		name := strings.TrimSpace(req.Name)
		if name == "" {
			name = e.nextDefaultPracticeNameLocked()
		} else if dup := e.findDuplicatePracticeBySlugLocked(name, ""); dup != nil {
			snap := clonePracticeManagerState(e.practiceState)
			e.mu.Unlock()
			return snap, fmt.Errorf("a practice session named %q already exists (names must have unique URL slugs)", dup.Name)
		}
		newSess := domain.PracticeSession{
			SessionID:     sessionID,
			Name:          name,
			Tags:          domain.NormalizeRaceTags(req.Tags),
			Active:        false,
			CreatedAt:     now,
			UpdatedAt:     now,
			Pilots:        []domain.PracticeSessionPilot{},
			TrackSnapshot: e.snapshotOrderedGatesLocked(),
			Laps:          []domain.LapRecord{},
			Crossings:     []domain.GateCrossingEvent{},
			Filtered:      []domain.FilteredDetection{},
			Summaries:     []domain.PilotTrackSummary{},
		}
		e.practiceState.Sessions = append(e.practiceState.Sessions, newSess)
		if !req.DontSelect || e.practiceState.SelectedSessionID == "" {
			e.practiceState.SelectedSessionID = sessionID
		}

	case "select_session":
		targetID := strings.TrimSpace(req.SessionID)
		if e.findPracticeSessionLocked(targetID) == nil {
			snap := clonePracticeManagerState(e.practiceState)
			e.mu.Unlock()
			return snap, fmt.Errorf("practice session %q not found", targetID)
		}
		e.practiceState.SelectedSessionID = targetID

	case "rename_session":
		target := e.findPracticeSessionLocked(resolveTargetID())
		if target == nil {
			snap := clonePracticeManagerState(e.practiceState)
			e.mu.Unlock()
			return snap, fmt.Errorf("practice session not found")
		}
		name := strings.TrimSpace(req.Name)
		if name == "" {
			snap := clonePracticeManagerState(e.practiceState)
			e.mu.Unlock()
			return snap, fmt.Errorf("practice session name cannot be empty")
		}
		if dup := e.findDuplicatePracticeBySlugLocked(name, target.SessionID); dup != nil {
			snap := clonePracticeManagerState(e.practiceState)
			e.mu.Unlock()
			return snap, fmt.Errorf("a practice session named %q already exists (names must have unique URL slugs)", dup.Name)
		}
		target.Name = name
		target.UpdatedAt = now

	case "set_session_tags":
		target := e.findPracticeSessionLocked(resolveTargetID())
		if target == nil {
			snap := clonePracticeManagerState(e.practiceState)
			e.mu.Unlock()
			return snap, fmt.Errorf("practice session not found")
		}
		target.Tags = domain.NormalizeRaceTags(req.Tags)
		target.UpdatedAt = now

	case "delete_session":
		targetID := strings.TrimSpace(req.SessionID)
		idx := -1
		for i := range e.practiceState.Sessions {
			if e.practiceState.Sessions[i].SessionID == targetID {
				idx = i
				break
			}
		}
		if idx < 0 {
			snap := clonePracticeManagerState(e.practiceState)
			e.mu.Unlock()
			return snap, fmt.Errorf("practice session not found")
		}
		if e.practiceState.Sessions[idx].Active || e.practiceState.ActiveSessionID == targetID {
			sName := e.practiceState.Sessions[idx].Name
			snap := clonePracticeManagerState(e.practiceState)
			e.mu.Unlock()
			return snap, fmt.Errorf("cannot delete live practice session %q — pause it first", sName)
		}
		e.practiceState.Sessions = append(e.practiceState.Sessions[:idx], e.practiceState.Sessions[idx+1:]...)
		if e.practiceState.SelectedSessionID == targetID {
			if e.practiceState.ActiveSessionID != "" {
				e.practiceState.SelectedSessionID = e.practiceState.ActiveSessionID
			} else if len(e.practiceState.Sessions) > 0 {
				e.practiceState.SelectedSessionID = e.practiceState.Sessions[0].SessionID
			} else {
				e.practiceState.SelectedSessionID = ""
			}
		}

	case "start_session", "resume_session":
		if ongoing := e.findAnyOngoingRaceLocked(); ongoing != nil {
			if req.PreemptOngoing {
				if e.pauseAllOtherOngoingRacesLocked("") {
					e.raceState.Mode = domain.ModePractice
					e.practiceSnap = domain.PracticeSnapshot{}
					e.syncActiveRaceToEventLocked()
					raceChanged = true
					cfgChanged = true
				}
			} else {
				snap := clonePracticeManagerState(e.practiceState)
				e.mu.Unlock()
				return snap, fmt.Errorf("cannot start practice session while race %q is ongoing — pause or complete the race first", raceDisplayName(ongoing))
			}
		}
		if e.raceState.Mode == domain.ModeRace || e.practiceSnap.Saved {
			e.raceState.Mode = domain.ModePractice
			e.practiceSnap = domain.PracticeSnapshot{}
			if e.raceState.Generated {
				e.syncActiveRaceToEventLocked()
			}
			raceChanged = true
		}
		targetID := resolveTargetID()
		target := e.findPracticeSessionLocked(targetID)
		if target == nil {
			snap := clonePracticeManagerState(e.practiceState)
			e.mu.Unlock()
			return snap, fmt.Errorf("practice session not found")
		}
		if e.practiceState.ActiveSessionID != "" && e.practiceState.ActiveSessionID != targetID {
			e.syncActivePracticeRecordsLocked()
			for i := range e.practiceState.Sessions {
				if e.practiceState.Sessions[i].Active || e.practiceState.Sessions[i].SessionID == e.practiceState.ActiveSessionID {
					e.practiceState.Sessions[i].Paused = true
					e.practiceState.Sessions[i].UpdatedAt = now
				}
				e.practiceState.Sessions[i].Active = false
			}
		}
		// Refresh pointer in case slice mutated
		frozenTrack := e.snapshotOrderedGatesLocked()
		for i := range e.practiceState.Sessions {
			wasActive := e.practiceState.Sessions[i].Active
			nowActive := (e.practiceState.Sessions[i].SessionID == targetID)
			if wasActive && !nowActive {
				e.practiceState.Sessions[i].TrackSnapshot = append([]domain.TrackGate(nil), frozenTrack...)
				e.practiceState.Sessions[i].Paused = true
			}
			e.practiceState.Sessions[i].Active = nowActive
			if nowActive {
				e.practiceState.Sessions[i].Paused = false
			}
			if wasActive && !nowActive {
				e.practiceState.Sessions[i].Summaries = e.computePracticeSessionSummariesLocked(&e.practiceState.Sessions[i])
			}
		}
		target = e.findPracticeSessionLocked(targetID)
		e.practiceState.ActiveSessionID = targetID
		e.practiceState.SelectedSessionID = targetID
		target.Paused = false
		target.TrackSnapshot = append([]domain.TrackGate(nil), frozenTrack...)
		target.UpdatedAt = now
		e.applyPracticeSessionToEngineLocked(target)
		target.Summaries = e.computePracticeSessionSummariesLocked(target)
		cfgChanged = true

	case "pause_session":
		targetID := resolveTargetID()
		target := e.findPracticeSessionLocked(targetID)
		if target == nil {
			snap := clonePracticeManagerState(e.practiceState)
			e.mu.Unlock()
			return snap, fmt.Errorf("practice session not found")
		}
		if target.Active || e.practiceState.ActiveSessionID == targetID {
			e.stopActivePracticeSessionLocked()
			target = e.findPracticeSessionLocked(targetID)
			if target != nil {
				target.Paused = true
				target.UpdatedAt = now
				target.Summaries = e.computePracticeSessionSummariesLocked(target)
			}
			cfgChanged = true
		}

	case "stop_session":
		targetID := resolveTargetID()
		target := e.findPracticeSessionLocked(targetID)
		if target == nil {
			snap := clonePracticeManagerState(e.practiceState)
			e.mu.Unlock()
			return snap, fmt.Errorf("practice session not found")
		}
		if target.Active || e.practiceState.ActiveSessionID == targetID {
			e.stopActivePracticeSessionLocked()
			target = e.findPracticeSessionLocked(targetID)
			if target != nil {
				target.Paused = false
				target.UpdatedAt = now
				target.Summaries = e.computePracticeSessionSummariesLocked(target)
			}
			cfgChanged = true
		} else if target.Paused {
			target.Paused = false
			target.UpdatedAt = now
		}

	case "add_session_pilot":
		target := e.findPracticeSessionLocked(resolveTargetID())
		if target == nil {
			snap := clonePracticeManagerState(e.practiceState)
			e.mu.Unlock()
			return snap, fmt.Errorf("practice session not found")
		}
		slotIdx := req.SlotIndex
		// Support creating a brand-new global pilot on the fly when slotIndex <= 0 and callsign is given
		if slotIdx <= 0 && strings.TrimSpace(req.Callsign) != "" {
			trimmedCallsign := strings.TrimSpace(req.Callsign)
			if e.hasPilotCallsignLocked(trimmedCallsign, 0) {
				snap := clonePracticeManagerState(e.practiceState)
				e.mu.Unlock()
				return snap, fmt.Errorf("pilot callsign %q already exists", trimmedCallsign)
			}
			maxSlot := 0
			for _, p := range e.pilots {
				if p.SlotIndex > maxSlot {
					maxSlot = p.SlotIndex
				}
			}
			slotIdx = maxSlot + 1
			newPilot := domain.PilotSlot{
				SlotIndex:       slotIdx,
				Callsign:        strings.TrimSpace(req.Callsign),
				PhoneticName:    strings.TrimSpace(req.PhoneticName),
				Enabled:         false,
				Band:            domain.BandRaceband,
				Channel:         0,
				FrequencyMHz:    0,
				EnterThreshold:  -58.0,
				ExitThreshold:   -68.0,
				AttenuationGain: 52,
				Color:           domain.DefaultPilotColors[(slotIdx-1)%len(domain.DefaultPilotColors)],
			}
			e.pilots = append(e.pilots, newPilot)
			e.initDetectorsLocked()
			e.syncGlobalPilotsToOpenEventsLocked(&newPilot, 0)
			if e.raceState.Generated {
				e.resolveActiveTournamentLocked()
			} else {
				e.syncActiveRaceToEventLocked()
			}
			cfgChanged = true
			raceChanged = true
		}

		var gp *domain.PilotSlot
		for i := range e.pilots {
			if e.pilots[i].SlotIndex == slotIdx {
				gp = &e.pilots[i]
				break
			}
		}
		if gp == nil {
			snap := clonePracticeManagerState(e.practiceState)
			e.mu.Unlock()
			return snap, fmt.Errorf("pilot slot %d not found in global directory", slotIdx)
		}

		existingIdx := -1
		usedFreq := make(map[uint16]bool)
		for i, sp := range target.Pilots {
			if sp.SlotIndex == slotIdx {
				existingIdx = i
			} else if sp.Channel >= 1 && sp.Channel <= 8 {
				fk := sp.FrequencyMHz
				if fk == 0 {
					fk = domain.FrequencyForBandChannel(sp.Band, sp.Channel)
				}
				if fk > 0 {
					usedFreq[fk] = true
				}
			}
		}

		if existingIdx < 0 && len(target.Pilots) >= domain.MaxPilotSlots {
			snap := clonePracticeManagerState(e.practiceState)
			e.mu.Unlock()
			return snap, fmt.Errorf("at most %d pilots can be active in a practice session", domain.MaxPilotSlots)
		}

		var band domain.Band
		var chosenCh uint8
		var freq uint16

		if req.Channel > 0 {
			if req.Band > 0 {
				band = req.Band
				chosenCh = req.Channel
				freq = domain.FrequencyForBandChannel(band, chosenCh)
			} else if b, ch, f, ok := domain.DecodeBandChannel(req.Channel); ok {
				band, chosenCh, freq = b, ch, f
			}
		}

		if chosenCh == 0 {
			gpBand := gp.Band
			if gpBand == 0 {
				gpBand = domain.BandRaceband
			}
			gpFreq := domain.FrequencyForBandChannel(gpBand, gp.Channel)
			if gp.Channel >= 1 && gpFreq > 0 && !usedFreq[gpFreq] {
				band = gpBand
				chosenCh = gp.Channel
				freq = gpFreq
			} else {
				band = domain.BandRaceband
				for ch := uint8(1); ch <= 8; ch++ {
					rf := domain.RacebandFrequenciesMHz[ch-1]
					if !usedFreq[rf] {
						chosenCh = ch
						freq = rf
						break
					}
				}
			}
		} else if freq > 0 && usedFreq[freq] {
			// Explicit channel chosen: blank out the other session pilot holding this RF frequency
			for i := range target.Pilots {
				if target.Pilots[i].SlotIndex == slotIdx || target.Pilots[i].Channel == 0 {
					continue
				}
				otherFreq := target.Pilots[i].FrequencyMHz
				if otherFreq == 0 {
					otherFreq = domain.FrequencyForBandChannel(target.Pilots[i].Band, target.Pilots[i].Channel)
				}
				if otherFreq == freq {
					target.Pilots[i].Channel = 0
					target.Pilots[i].FrequencyMHz = 0
				}
			}
		}
		if band == 0 {
			band = domain.BandRaceband
		}
		entry := domain.PracticeSessionPilot{
			SlotIndex:    gp.SlotIndex,
			Callsign:     gp.Callsign,
			PhoneticName: gp.PhoneticName,
			Color:        gp.Color,
			Band:         band,
			Channel:      chosenCh,
			FrequencyMHz: freq,
		}
		if existingIdx >= 0 {
			target.Pilots[existingIdx] = entry
		} else {
			target.Pilots = append(target.Pilots, entry)
		}
		target.UpdatedAt = now
		if target.Active && e.practiceState.ActiveSessionID == target.SessionID && !e.isLiveRaceHeatActiveLocked() {
			e.syncPracticeSessionRFSlotsLocked(target)
			cfgChanged = true
		}
		target.Summaries = e.computePracticeSessionSummariesLocked(target)

	case "remove_session_pilot":
		target := e.findPracticeSessionLocked(resolveTargetID())
		if target == nil {
			snap := clonePracticeManagerState(e.practiceState)
			e.mu.Unlock()
			return snap, fmt.Errorf("practice session not found")
		}
		filtered := make([]domain.PracticeSessionPilot, 0, len(target.Pilots))
		for _, sp := range target.Pilots {
			if sp.SlotIndex != req.SlotIndex {
				filtered = append(filtered, sp)
			}
		}
		target.Pilots = filtered
		target.UpdatedAt = now
		// NOTE: target.Laps & target.Crossings are intentionally retained so re-adding this pilot
		// restores their session lap history and sector splits immediately!
		if target.Active && e.practiceState.ActiveSessionID == target.SessionID && !e.isLiveRaceHeatActiveLocked() {
			e.syncPracticeSessionRFSlotsLocked(target)
			cfgChanged = true
		}
		target.Summaries = e.computePracticeSessionSummariesLocked(target)

	case "set_session_pilot_channel":
		target := e.findPracticeSessionLocked(resolveTargetID())
		if target == nil {
			snap := clonePracticeManagerState(e.practiceState)
			e.mu.Unlock()
			return snap, fmt.Errorf("practice session not found")
		}
		pIdx := -1
		for i := range target.Pilots {
			if target.Pilots[i].SlotIndex == req.SlotIndex {
				pIdx = i
				break
			}
		}
		if pIdx < 0 {
			snap := clonePracticeManagerState(e.practiceState)
			e.mu.Unlock()
			return snap, fmt.Errorf("pilot slot %d is not in this session", req.SlotIndex)
		}
		var band domain.Band
		var ch uint8
		var freq uint16
		if req.Channel > 0 {
			if req.Band > 0 {
				band = req.Band
				ch = req.Channel
				freq = domain.FrequencyForBandChannel(band, ch)
			} else if b, decodedCh, decodedFreq, ok := domain.DecodeBandChannel(req.Channel); ok {
				band, ch, freq = b, decodedCh, decodedFreq
			}
		}
		if band == 0 {
			band = target.Pilots[pIdx].Band
			if band == 0 {
				band = domain.BandRaceband
			}
		}
		if ch >= 1 && freq > 0 {
			for i := range target.Pilots {
				if i == pIdx || target.Pilots[i].Channel == 0 {
					continue
				}
				otherFreq := target.Pilots[i].FrequencyMHz
				if otherFreq == 0 {
					otherFreq = domain.FrequencyForBandChannel(target.Pilots[i].Band, target.Pilots[i].Channel)
				}
				if otherFreq == freq || (target.Pilots[i].Band == band && target.Pilots[i].Channel == ch) {
					target.Pilots[i].Channel = 0
					target.Pilots[i].FrequencyMHz = 0
				}
			}
		} else {
			ch = 0
			freq = 0
		}
		target.Pilots[pIdx].Band = band
		target.Pilots[pIdx].Channel = ch
		target.Pilots[pIdx].FrequencyMHz = freq
		target.UpdatedAt = now
		if target.Active && e.practiceState.ActiveSessionID == target.SessionID && !e.isLiveRaceHeatActiveLocked() {
			e.syncPracticeSessionRFSlotsLocked(target)
			cfgChanged = true
		}
		target.Summaries = e.computePracticeSessionSummariesLocked(target)

	case "clear_session_laps":
		target := e.findPracticeSessionLocked(resolveTargetID())
		if target == nil {
			snap := clonePracticeManagerState(e.practiceState)
			e.mu.Unlock()
			return snap, fmt.Errorf("practice session not found")
		}
		target.Laps = []domain.LapRecord{}
		target.Crossings = []domain.GateCrossingEvent{}
		target.Filtered = []domain.FilteredDetection{}
		target.UpdatedAt = now
		if target.Active && e.practiceState.ActiveSessionID == target.SessionID && !e.isLiveRaceHeatActiveLocked() {
			e.resetSessionLocked()
		}
		target.Summaries = e.computePracticeSessionSummariesLocked(target)

	default:
		snap := clonePracticeManagerState(e.practiceState)
		e.mu.Unlock()
		return snap, fmt.Errorf("unknown practice action %q", req.Action)
	}

	// Ensure dsp detectors exist if new pilot added
	_ = dsp.NewChannelDetector

	practiceSnap := clonePracticeManagerState(e.practiceState)
	var pilotsCopy []domain.PilotSlot
	var gatesCopy []domain.TrackGate
	var raceSnap domain.RaceTournamentState
	if cfgChanged {
		pilotsCopy = append([]domain.PilotSlot(nil), e.pilots...)
		gatesCopy = append([]domain.TrackGate(nil), e.gates...)
	}
	if raceChanged {
		raceSnap = cloneRaceState(e.raceState)
	}
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	if cfgChanged {
		for _, s := range subs {
			s.OnConfigUpdated(pilotsCopy, gatesCopy)
		}
	}
	if raceChanged {
		e.notifyRaceUpdated(raceSnap, nil, subs)
	}
	e.notifyPracticeUpdated(practiceSnap, subs)
	return practiceSnap, nil
}
