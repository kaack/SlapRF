package tracker

import (
	"sort"
	"strconv"
	"strings"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/dsp"
	"slaprf/internal/race"
)

// PersistedEngineState captures the complete configuration and recorded session state of an Engine
// so it can be persisted to SQLite (native Go server) or browser WebStorage (WASM simulator) and
// rehydrated on restart.
type PersistedEngineState struct {
	ElapsedUs          uint64                      `json:"elapsedUs"`
	SavedAtUnixUs      int64                       `json:"savedAtUnixUs,omitempty"`
	TimingHardwareMode domain.TimingHardwareMode   `json:"timingHardwareMode,omitempty"`
	RaceArmed          bool                        `json:"raceArmed"`
	Rules              domain.TimingRules          `json:"rules"`
	Pilots             []domain.PilotSlot          `json:"pilots"`
	Gates              []domain.TrackGate          `json:"gates"`
	Timers             []domain.DetectedTimer      `json:"timers"`
	SavedSlapRFGates       []domain.TrackGate          `json:"savedSlapRFGates,omitempty"`
	SavedSlapRFTimers      []domain.DetectedTimer      `json:"savedSlapRFTimers,omitempty"`
	SavedSlapRFBLEGates    []domain.TrackGate          `json:"savedSlapRFBLEGates,omitempty"`
	SavedSlapRFBLETimers   []domain.DetectedTimer      `json:"savedSlapRFBLETimers,omitempty"`
	HasSavedSlapRFBLEState bool                        `json:"hasSavedSlapRFBLEState,omitempty"`
	SavedLapRFGates       []domain.TrackGate          `json:"savedLapRFGates,omitempty"`
	SavedLapRFTimers      []domain.DetectedTimer      `json:"savedLapRFTimers,omitempty"`
	HasSavedLapRFState    bool                        `json:"hasSavedLapRFState,omitempty"`
	SavedLapRFUSBGates    []domain.TrackGate          `json:"savedLapRFUSBGates,omitempty"`
	SavedLapRFUSBTimers   []domain.DetectedTimer      `json:"savedLapRFUSBTimers,omitempty"`
	HasSavedLapRFUSBState bool                        `json:"hasSavedLapRFUSBState,omitempty"`
	SavedRHGates       []domain.TrackGate          `json:"savedRHGates,omitempty"`
	SavedRHTimers      []domain.DetectedTimer      `json:"savedRHTimers,omitempty"`
	HasSavedRHState    bool                        `json:"hasSavedRHState,omitempty"`
	SavedRHUSBGates    []domain.TrackGate          `json:"savedRHUSBGates,omitempty"`
	SavedRHUSBTimers   []domain.DetectedTimer      `json:"savedRHUSBTimers,omitempty"`
	HasSavedRHUSBState bool                        `json:"hasSavedRHUSBState,omitempty"`
	DeletedSpokeFp     []string                    `json:"deletedSpokeFp,omitempty"`
	Laps               []domain.LapRecord          `json:"laps"`
	Crossings          []domain.GateCrossingEvent  `json:"crossings"`
	Filtered           []domain.FilteredDetection  `json:"filtered"`
	RaceState          *domain.RaceTournamentState `json:"raceState,omitempty"`
	EventState         *domain.EventManagerState   `json:"eventState,omitempty"`
	PracticeState      *domain.PracticeManagerState `json:"practiceState,omitempty"`
	PracticeSnap       *domain.PracticeSnapshot     `json:"practiceSnap,omitempty"`
	MLState            *domain.MLPersistedState     `json:"mlState,omitempty"`
}

// ExportState returns a deep copy of the engine's persistable configuration and session records.
func (e *Engine) ExportState() PersistedEngineState {
	e.mu.RLock()
	defer e.mu.RUnlock()

	elapsedUs := e.NowUs()
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := make([]domain.TrackGate, len(e.gates))
	for i, g := range e.gates {
		cp := g
		if d, ok := e.detected[cp.AssignedTimerID]; ok && cp.AssignedTimerID > 0 {
			cp.TimerLabel = d.TimerLabel
			if d.FirmwareVersion != "" {
				cp.FirmwareVersion = d.FirmwareVersion
			}
			if d.Color != "" {
				cp.Color = d.Color
			}
			cp.BatteryMv = d.BatteryMv
			cp.BatteryPct = d.BatteryPct
			cp.NoiseFloorDbm = d.NoiseFloorDbm
		}
		gates[i] = cp
	}

	timers := make([]domain.DetectedTimer, 0, len(e.detected))
	for _, d := range e.detected {
		cp := *d
		timers = append(timers, cp)
	}
	sort.Slice(timers, func(i, j int) bool { return timers[i].TimerID < timers[j].TimerID })

	laps := make([]domain.LapRecord, len(e.laps))
	for i, l := range e.laps {
		cp := l
		cp.Sectors = append([]domain.SectorSplit{}, l.Sectors...)
		laps[i] = cp
	}
	crossings := append([]domain.GateCrossingEvent(nil), e.crossings...)
	filtered := append([]domain.FilteredDetection(nil), e.filtered...)

	var deletedFp []string
	for fp, deleted := range e.deletedSpokeFp {
		if deleted && fp != "" {
			deletedFp = append(deletedFp, fp)
		}
	}
	sort.Strings(deletedFp)

	raceCopy := cloneRaceState(e.raceState)
	eventCopy := cloneEventManagerState(e.eventState)
	if raceCopy.RaceID != "" || eventCopy.ActiveRaceID != "" {
		matched := false
		for ri := range eventCopy.Races {
			if eventCopy.Races[ri].RaceID == raceCopy.RaceID || (raceCopy.RaceID == "" && eventCopy.Races[ri].RaceID == eventCopy.ActiveRaceID) {
				cp := cloneRaceState(raceCopy)
				if cp.RaceID == "" {
					cp.RaceID = eventCopy.Races[ri].RaceID
				}
				eventCopy.Races[ri] = cp
				matched = true
				break
			}
		}
		if !matched && raceCopy.RaceID != "" {
			eventCopy.Races = append(eventCopy.Races, cloneRaceState(raceCopy))
			eventCopy.ActiveRaceID = raceCopy.RaceID
		}
	}
	var practiceCopy *domain.PracticeSnapshot
	if e.practiceSnap.Saved {
		ps := domain.PracticeSnapshot{
			Saved:     true,
			RaceArmed: e.practiceSnap.RaceArmed,
			Pilots:    append([]domain.PilotSlot(nil), e.practiceSnap.Pilots...),
			Laps:      cloneLaps(e.practiceSnap.Laps),
			Crossings: append([]domain.GateCrossingEvent(nil), e.practiceSnap.Crossings...),
			Filtered:  append([]domain.FilteredDetection(nil), e.practiceSnap.Filtered...),
		}
		practiceCopy = &ps
	}

	practiceStateCopy := clonePracticeManagerState(e.practiceState)
	if !e.isLiveRaceHeatActiveLocked() && practiceStateCopy.ActiveSessionID != "" {
		for si := range practiceStateCopy.Sessions {
			if practiceStateCopy.Sessions[si].SessionID == practiceStateCopy.ActiveSessionID {
				practiceStateCopy.Sessions[si].Laps = cloneLaps(laps)
				practiceStateCopy.Sessions[si].Crossings = append([]domain.GateCrossingEvent(nil), crossings...)
				practiceStateCopy.Sessions[si].Filtered = append([]domain.FilteredDetection(nil), filtered...)
				break
			}
		}
	}

	mlCopy := cloneMLPersistedState(e.mlState)

	return PersistedEngineState{
		ElapsedUs:          elapsedUs,
		SavedAtUnixUs:      time.Now().UnixMicro(),
		TimingHardwareMode: domain.NormalizeTimingHardwareMode(e.timingHardwareMode),
		RaceArmed:          e.raceArmed,
		Rules:              e.rules,
		Pilots:             pilots,
		Gates:              gates,
		Timers:             timers,
		SavedSlapRFGates:       append([]domain.TrackGate(nil), e.savedSlapRFGates...),
		SavedSlapRFTimers:      append([]domain.DetectedTimer(nil), e.savedSlapRFTimers...),
		SavedSlapRFBLEGates:    append([]domain.TrackGate(nil), e.savedSlapRFBLEGates...),
		SavedSlapRFBLETimers:   append([]domain.DetectedTimer(nil), e.savedSlapRFBLETimers...),
		HasSavedSlapRFBLEState: e.hasSavedSlapRFBLEState,
		SavedLapRFGates:        append([]domain.TrackGate(nil), e.savedLapRFGates...),
		SavedLapRFTimers:       append([]domain.DetectedTimer(nil), e.savedLapRFTimers...),
		HasSavedLapRFState:     e.hasSavedLapRFState,
		SavedLapRFUSBGates:     append([]domain.TrackGate(nil), e.savedLapRFUSBGates...),
		SavedLapRFUSBTimers:    append([]domain.DetectedTimer(nil), e.savedLapRFUSBTimers...),
		HasSavedLapRFUSBState:  e.hasSavedLapRFUSBState,
		SavedRHGates:       append([]domain.TrackGate(nil), e.savedRHGates...),
		SavedRHTimers:      append([]domain.DetectedTimer(nil), e.savedRHTimers...),
		HasSavedRHState:    e.hasSavedRHState,
		SavedRHUSBGates:    append([]domain.TrackGate(nil), e.savedRHUSBGates...),
		SavedRHUSBTimers:   append([]domain.DetectedTimer(nil), e.savedRHUSBTimers...),
		HasSavedRHUSBState: e.hasSavedRHUSBState,
		DeletedSpokeFp:     deletedFp,
		Laps:               laps,
		Crossings:          crossings,
		Filtered:           filtered,
		RaceState:          &raceCopy,
		EventState:         &eventCopy,
		PracticeState:      &practiceStateCopy,
		PracticeSnap:       practiceCopy,
		MLState:            &mlCopy,
	}
}

// RestoreState rehydrates the engine from a previously exported state snapshot, reconstructing
// monotonic boot time, sector history, personal/overall best splits, and passing counters.
// When `markTimersOnline` is true (simulation engine), restored timers start online; when false
// (real hardware engine), restored timers start offline until live telemetry arrives.
func (e *Engine) RestoreState(s PersistedEngineState, markTimersOnline bool) {
	e.mu.Lock()
	defer e.mu.Unlock()

	maxUs := s.ElapsedUs
	for _, l := range s.Laps {
		if l.CompletedAtUs > maxUs {
			maxUs = l.CompletedAtUs
		}
	}
	for _, ev := range s.Crossings {
		if ev.TimestampUs > maxUs {
			maxUs = ev.TimestampUs
		}
	}
	for _, f := range s.Filtered {
		if f.TimestampUs > maxUs {
			maxUs = f.TimestampUs
		}
	}
	now := time.Now()
	if s.SavedAtUnixUs > 0 {
		if wallGapUs := now.UnixMicro() - s.SavedAtUnixUs; wallGapUs > 0 {
			maxUs += uint64(wallGapUs)
		}
	}
	e.bootTime = now.Add(-time.Duration(maxUs) * time.Microsecond)
	e.virtualOffsetUs.Store(0)
	e.timingHardwareMode = domain.NormalizeTimingHardwareMode(s.TimingHardwareMode)
	e.savedSlapRFGates = append([]domain.TrackGate(nil), s.SavedSlapRFGates...)
	e.savedSlapRFTimers = append([]domain.DetectedTimer(nil), s.SavedSlapRFTimers...)
	e.savedSlapRFBLEGates = append([]domain.TrackGate(nil), s.SavedSlapRFBLEGates...)
	e.savedSlapRFBLETimers = append([]domain.DetectedTimer(nil), s.SavedSlapRFBLETimers...)
	e.hasSavedSlapRFBLEState = s.HasSavedSlapRFBLEState
	e.savedLapRFGates = append([]domain.TrackGate(nil), s.SavedLapRFGates...)
	e.savedLapRFTimers = append([]domain.DetectedTimer(nil), s.SavedLapRFTimers...)
	e.hasSavedLapRFState = s.HasSavedLapRFState
	e.savedLapRFUSBGates = append([]domain.TrackGate(nil), s.SavedLapRFUSBGates...)
	e.savedLapRFUSBTimers = append([]domain.DetectedTimer(nil), s.SavedLapRFUSBTimers...)
	e.hasSavedLapRFUSBState = s.HasSavedLapRFUSBState
	e.savedRHGates = append([]domain.TrackGate(nil), s.SavedRHGates...)
	e.savedRHTimers = append([]domain.DetectedTimer(nil), s.SavedRHTimers...)
	e.hasSavedRHState = s.HasSavedRHState
	e.savedRHUSBGates = append([]domain.TrackGate(nil), s.SavedRHUSBGates...)
	e.savedRHUSBTimers = append([]domain.DetectedTimer(nil), s.SavedRHUSBTimers...)
	e.hasSavedRHUSBState = s.HasSavedRHUSBState
	e.raceArmed = true
	if s.Rules.MinLapSec > 0 || s.Rules.MaxLapSec > 0 {
		e.rules = s.Rules.Normalized()
	}

	if len(s.Pilots) > 0 {
		e.pilots = append([]domain.PilotSlot(nil), s.Pilots...)
	}
	e.deletedSpokeFp = make(map[string]bool, len(s.DeletedSpokeFp))
	for _, fp := range s.DeletedSpokeFp {
		if fp != "" {
			e.deletedSpokeFp[fp] = true
		}
	}
	e.detected = make(map[uint8]*domain.DetectedTimer, len(s.Timers))
	remapTimerID := make(map[uint8]uint8)
	for _, d := range s.Timers {
		if d.TimerID == 0 || d.TimerID > maxTimers {
			continue
		}
		fpUpper := strings.ToUpper(strings.TrimSpace(d.Fingerprint))
		switch e.timingHardwareMode {
		case domain.HardwareModeLapRF, domain.HardwareModeLapRFUSB:
			if d.FirmwareVersion != "LapRF" && !strings.HasPrefix(fpUpper, "LAPRF") {
				continue
			}
		case domain.HardwareModeRotorHazard, domain.HardwareModeRotorHazardUSB:
			if d.FirmwareVersion != "RotorHazard" && !strings.HasPrefix(fpUpper, "RH") {
				continue
			}
		default:
			if d.FirmwareVersion == "LapRF" || d.FirmwareVersion == "RotorHazard" ||
				strings.HasPrefix(fpUpper, "LAPRF") || strings.HasPrefix(fpUpper, "RH") {
				continue
			}
		}
		cp := d
		if cp.Color == "" {
			cp.Color = domain.DefaultTimerColor(cp.TimerID)
		}
		if cp.FirmwareVersion == "" {
			cp.FirmwareVersion = domain.LatestFirmwareVersion
		}
		if cp.FirmwareVersion == "LapRF" || domain.IsLapRFMode(e.timingHardwareMode) {
			cp.TimerLabel = normalizeLapRFTimerLabel(cp.TimerLabel, cp.TimerID)
		} else if cp.FirmwareVersion == "RotorHazard" || domain.IsRotorHazardMode(e.timingHardwareMode) {
			cp.TimerLabel = normalizeRHTimerLabel(cp.TimerLabel, cp.TimerID)
		}
		if markTimersOnline {
			cp.Online = true
			cp.LastSeenAt = now
		} else {
			cp.Online = false
			cp.LastSeenAt = time.Time{}
		}
		e.detected[cp.TimerID] = &cp
	}

	if markTimersOnline && len(e.detected) == 0 {
		switch e.timingHardwareMode {
		case domain.HardwareModeSlapRFBLE:
			e.gates, e.detected = defaultSimSlapRFBLELayoutLocked(now)
			s.Gates = nil
		case domain.HardwareModeLapRF, domain.HardwareModeLapRFUSB:
			e.gates, e.detected = defaultSimLapRFLayoutLocked(now)
			s.Gates = nil
		case domain.HardwareModeRotorHazard, domain.HardwareModeRotorHazardUSB:
			e.gates, e.detected = defaultSimRHLayoutLocked(now)
			s.Gates = nil
		default:
			e.gates = domain.DefaultTrackGates()
			e.seedSimTimersLocked()
			s.Gates = nil
		}
	}

	// In real SlapRF hardware mode, ensure the Hub occupies slot 1 (and any non-Hub in slot 1 is moved to a free 2..7 slot).
	if !markTimersOnline && domain.IsSlapRFMode(e.timingHardwareMode) {
		assignedTimers := make(map[uint8]bool, len(s.Gates))
		for _, g := range s.Gates {
			if g.AssignedTimerID > 0 {
				assignedTimers[g.AssignedTimerID] = true
			}
		}
		for id, d := range e.detected {
			if !assignedTimers[id] && d.Fingerprint != "" && !domain.IsValidSlapRFFingerprint(d.Fingerprint) {
				delete(e.detected, id)
			}
		}
		var hubEntry *domain.DetectedTimer
		var hubOldID uint8
		for id := uint8(maxTimers); id >= 1; id-- {
			if d, ok := e.detected[id]; ok && d.IsHub {
				if hubEntry == nil {
					hubEntry = d
					hubOldID = id
				} else {
					remapTimerID[id] = domain.SimHubTimerID
					delete(e.detected, id)
				}
			}
		}
		if d1, ok := e.detected[domain.SimHubTimerID]; ok && !d1.IsHub {
			delete(e.detected, domain.SimHubTimerID)
			for freeID := uint8(2); freeID <= maxTimers; freeID++ {
				if _, taken := e.detected[freeID]; !taken {
					d1.TimerID = freeID
					e.detected[freeID] = d1
					remapTimerID[domain.SimHubTimerID] = freeID
					break
				}
			}
		}
		if hubEntry != nil && hubOldID != domain.SimHubTimerID {
			delete(e.detected, hubOldID)
			hubEntry.TimerID = domain.SimHubTimerID
			e.detected[domain.SimHubTimerID] = hubEntry
			remapTimerID[hubOldID] = domain.SimHubTimerID
		}
	}

	if s.Gates != nil {
		e.gates = make([]domain.TrackGate, 0, len(s.Gates))
		for _, g := range s.Gates {
			cp := g
			if newID, mapped := remapTimerID[cp.AssignedTimerID]; mapped {
				cp.AssignedTimerID = newID
			}
			if cp.AssignedTimerID > 0 {
				if d, ok := e.detected[cp.AssignedTimerID]; ok && d.TimerLabel != "" &&
					(cp.FirmwareVersion == "LapRF" || cp.FirmwareVersion == "RotorHazard" ||
						domain.IsLapRFMode(e.timingHardwareMode) || domain.IsRotorHazardMode(e.timingHardwareMode)) {
					cp.TimerLabel = d.TimerLabel
				}
			}
			// In real hardware mode, drop gates whose assigned timer no longer exists in e.detected.
			if !markTimersOnline && cp.AssignedTimerID > 0 {
				if d, ok := e.detected[cp.AssignedTimerID]; !ok {
					continue
				} else if d.TimerLabel != "" {
					cp.TimerLabel = d.TimerLabel
				}
			}
			if markTimersOnline && cp.AssignedTimerID > 0 {
				cp.Online = true
				cp.LastSeenAt = now
			} else {
				cp.Online = false
				cp.LastSeenAt = time.Time{}
			}
			e.gates = append(e.gates, cp)
		}
		ordered := e.orderedGatesLocked()
		e.applyOrderLocked(ordered)
		e.ensureStartGateLocked()
	}

	e.detectors = make(map[detKey]*dsp.ChannelDetector)
	e.initDetectorsLocked()
	e.resetSessionLocked()
	e.passingNumbers = make(map[uint8]uint32)
	e.nextEventID = 0
	e.nextLapID = 0
	e.raceState = newDefaultRaceState()
	e.practiceSnap = domain.PracticeSnapshot{}

	for _, l := range s.Laps {
		cp := l
		cp.Sectors = race.SanitizeLapSectors(append([]domain.SectorSplit{}, l.Sectors...), cp.LapTimeSec)
		if len(cp.Sectors) == 0 && len(e.gates) == 1 && cp.LapTimeSec > 0 {
			gID := e.gates[0].GateID
			badge := domain.BadgeNormal
			if cp.IsBestLap {
				badge = domain.BadgePersonalBest
			}
			cp.Sectors = []domain.SectorSplit{{
				SectorIndex:    1,
				FromGateID:     gID,
				ToGateID:       gID,
				Label:          e.sectionLabelLocked(gID, gID),
				SplitSeconds:   cp.LapTimeSec,
				DeltaToBestSec: cp.DeltaToBest,
				Badge:          badge,
			}}
		}
		e.laps = append(e.laps, cp)
		if cp.LapID > e.nextLapID {
			e.nextLapID = cp.LapID
		}
		for _, split := range cp.Sectors {
			pKey := pairKey(split.FromGateID, split.ToGateID)
			sKey := sectorKey(cp.SlotIndex, pKey)
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
	sort.SliceStable(e.laps, func(a, b int) bool {
		if e.laps[a].CompletedAtUs != e.laps[b].CompletedAtUs {
			return e.laps[a].CompletedAtUs < e.laps[b].CompletedAtUs
		}
		if e.laps[a].LapNumber != e.laps[b].LapNumber {
			return e.laps[a].LapNumber < e.laps[b].LapNumber
		}
		return e.laps[a].LapID < e.laps[b].LapID
	})
	if len(e.laps) > maxStoredLaps {
		e.laps = e.laps[len(e.laps)-maxStoredLaps:]
	}

	for _, ev := range s.Crossings {
		e.crossings = append(e.crossings, ev)
		if ev.EventID > e.nextEventID {
			e.nextEventID = ev.EventID
		}
		if ev.PassingNumber > e.passingNumbers[ev.GateID] {
			e.passingNumbers[ev.GateID] = ev.PassingNumber
		}
		ckey := detectorKey(ev.GateID, ev.SlotIndex)
		if ev.TimestampUs > e.lastAcceptedUs[ckey] {
			e.lastAcceptedUs[ckey] = ev.TimestampUs
		}
	}
	sortCrossingsChronological(e.crossings)
	if len(e.crossings) > maxStoredCrossings {
		e.crossings = e.crossings[len(e.crossings)-maxStoredCrossings:]
	}

	for _, f := range s.Filtered {
		if f.Reason.IsValid() {
			e.filtered = append(e.filtered, f)
		}
	}
	if len(e.filtered) > maxStoredFiltered {
		e.filtered = e.filtered[len(e.filtered)-maxStoredFiltered:]
	}

	if s.PracticeSnap != nil {
		e.practiceSnap = *s.PracticeSnap
	} else {
		e.practiceSnap = domain.PracticeSnapshot{}
	}
	if s.RaceState != nil {
		rs := cloneRaceState(*s.RaceState)
		rs.Config = rs.Config.Normalized()
		rs.Tags = domain.NormalizeRaceTags(rs.Tags)
		if rs.Mode != domain.ModeRace {
			rs.Mode = domain.ModePractice
		}
		race.MigrateLegacyStagesToUnifiedGraph(&rs)
		// If reloaded mid-countdown or mid-heat, pause cleanly so a race doesn't run unattended across a browser restart.
		for i := range rs.Heats {
			if rs.Heats[i].State == domain.HeatCountdown {
				rs.Heats[i].State = domain.HeatStaged
				rs.Heats[i].CountdownRemainingSec = 0
			} else if rs.Heats[i].State == domain.HeatRunning {
				rs.Heats[i].State = domain.HeatPaused
				rs.Heats[i].PausedAtUs = e.NowUs()
			}
		}
		e.raceState = rs
		if e.raceState.Mode == domain.ModeRace {
			e.raceArmed = false
		}
	} else {
		e.raceState = newDefaultRaceState()
	}

	if s.EventState != nil && (s.EventState.Initialized || len(s.EventState.Races) > 0) {
		evState := cloneEventManagerState(*s.EventState)
		nowUs := e.NowUs()
		normalizeHeatsOnRestore := func(r *domain.RaceTournamentState) {
			r.Config = r.Config.Normalized()
			r.Tags = domain.NormalizeRaceTags(r.Tags)
			race.MigrateLegacyStagesToUnifiedGraph(r)
			for hi := range r.Heats {
				if r.Heats[hi].State == domain.HeatCountdown {
					r.Heats[hi].State = domain.HeatStaged
					r.Heats[hi].CountdownRemainingSec = 0
				} else if r.Heats[hi].State == domain.HeatRunning {
					r.Heats[hi].State = domain.HeatPaused
					r.Heats[hi].PausedAtUs = nowUs
				}
				for si := range r.Heats[hi].Seats {
					seat := &r.Heats[hi].Seats[si]
					for li := range seat.Laps {
						if seat.Laps[li].LapNumber < 1 || !(seat.Laps[li].SplitTimeSec > 0) {
							continue
						}
						seat.Laps[li].Sectors = race.SanitizeLapSectors(seat.Laps[li].Sectors, seat.Laps[li].SplitTimeSec)
						if seat.Laps[li].CrossingID > 0 {
							for ci := range seat.Crossings {
								if seat.Crossings[ci].CrossingID == seat.Laps[li].CrossingID {
									seat.Crossings[ci].Sectors = seat.Laps[li].Sectors
								}
							}
						}
					}
				}
			}
			if r.Generated {
				globalBySlot := make(map[int]domain.PilotSlot, len(e.pilots))
				for _, p := range e.pilots {
					globalBySlot[p.SlotIndex] = p
				}
				roster := make([]domain.PilotSlot, 0, len(r.Roster))
				att := make(map[int]domain.PilotAttendance, len(r.Roster))
				for _, ep := range r.Roster {
					a := domain.NormalizeAttendance(ep.Attendance)
					if !ep.CheckedIn {
						a = domain.AttendanceForfeit
					}
					att[ep.SlotIndex] = a
					if !ep.CheckedIn {
						continue
					}
					if gp, ok := globalBySlot[ep.SlotIndex]; ok {
						gp.Callsign = ep.Callsign
						gp.PhoneticName = ep.PhoneticName
						if ep.Color != "" {
							gp.Color = ep.Color
						}
						roster = append(roster, gp)
					} else {
						roster = append(roster, domain.PilotSlot{
							SlotIndex:    ep.SlotIndex,
							Callsign:     ep.Callsign,
							PhoneticName: ep.PhoneticName,
							Color:        ep.Color,
						})
					}
				}
				race.ResolveTournamentWithAttendance(r, roster, att)
			}
		}
		for ri := range evState.Races {
			normalizeHeatsOnRestore(&evState.Races[ri])
			e.bumpSeqFromRestoredIDLocked(evState.Races[ri].RaceID)
		}
		if e.raceState.RaceID != "" {
			normalizeHeatsOnRestore(&e.raceState)
			e.bumpSeqFromRestoredIDLocked(e.raceState.RaceID)
		}
		evState.Initialized = true
		e.eventState = evState
		e.ensureEventStateInitializedLocked()
		if len(e.eventState.Races) == 0 {
			e.raceState = newEmptyNoRaceState(e.raceState.Mode)
		} else {
			e.syncActiveRaceToEventLocked()
		}
	} else {
		e.eventState = domain.EventManagerState{}
		e.ensureEventStateInitializedLocked()
	}

	if s.PracticeState != nil && (s.PracticeState.Initialized || len(s.PracticeState.Sessions) > 0) {
		ps := clonePracticeManagerState(*s.PracticeState)
		e.syncPracticeIDHighWaterLocked(ps.Sessions)
		for si := range ps.Sessions {
			e.bumpSeqFromRestoredIDLocked(ps.Sessions[si].SessionID)
			for li := range ps.Sessions[si].Laps {
				ps.Sessions[si].Laps[li].Sectors = race.SanitizeLapSectors(
					ps.Sessions[si].Laps[li].Sectors,
					ps.Sessions[si].Laps[li].LapTimeSec,
				)
			}
			e.recomputePracticeSessionLapsLocked(&ps.Sessions[si])
		}
		ps.Initialized = true
		e.practiceState = ps
		e.ensurePracticeStateInitializedLocked()
		if !e.isLiveRaceHeatActiveLocked() && e.raceState.Mode != domain.ModeRace {
			if e.practiceState.ActiveSessionID != "" {
				if activeSess := e.findPracticeSessionLocked(e.practiceState.ActiveSessionID); activeSess != nil {
					e.applyPracticeSessionToEngineLocked(activeSess)
					activeSess.Summaries = e.computePracticeSessionSummariesLocked(activeSess)
				}
			} else {
				for i := range e.pilots {
					e.pilots[i].Enabled = false
				}
				e.raceArmed = false
			}
		}
	} else {
		e.practiceState = domain.PracticeManagerState{}
		e.raceArmed = s.RaceArmed
		e.ensurePracticeStateInitializedLocked()
	}

	if s.MLState != nil {
		e.mlState = cloneMLPersistedState(*s.MLState)
		e.mlActiveTCN = nil
		e.mlActiveModelID = ""
		e.rebuildLiveTuneMapLocked()
	} else {
		e.mlState = domain.MLPersistedState{Config: domain.DefaultMLConfig()}
		e.mlActiveTCN = nil
		e.mlActiveModelID = ""
		e.mlLiveTunes = nil
	}

	domain.PruneTrackGateRuleOverrides(e.gates, e.rules)
	for si := range e.practiceState.Sessions {
		base := e.rules
		if e.practiceState.Sessions[si].Rules != nil {
			base = *e.practiceState.Sessions[si].Rules
		}
		domain.PruneTrackGateRuleOverrides(e.practiceState.Sessions[si].TrackSnapshot, base)
	}
	raceBase := e.rules
	if e.raceState.Rules != nil {
		raceBase = *e.raceState.Rules
	}
	domain.PruneTrackGateRuleOverrides(e.raceState.TrackSnapshot, raceBase)
	for ri := range e.eventState.Races {
		rBase := e.rules
		if e.eventState.Races[ri].Rules != nil {
			rBase = *e.eventState.Races[ri].Rules
		}
		domain.PruneTrackGateRuleOverrides(e.eventState.Races[ri].TrackSnapshot, rBase)
	}
}

// ResetToFactoryDefaults wipes all user data (pilots, track gates, detected timers, races,
// practice sessions, and recorded laps) while restoring clean settings and timing rule defaults.
func (e *Engine) ResetToFactoryDefaults(_ bool) {
	e.mu.Lock()
	if e.bootTime.IsZero() {
		e.bootTime = time.Now()
	}
	e.virtualOffsetUs.Store(0)
	e.raceArmed = true
	e.rules = domain.DefaultTimingRules()
	e.pilots = []domain.PilotSlot{}
	e.gates = []domain.TrackGate{}
	e.detected = make(map[uint8]*domain.DetectedTimer)
	e.deletedSpokeFp = nil
	e.detectors = make(map[detKey]*dsp.ChannelDetector)
	e.passingNumbers = make(map[uint8]uint32)
	e.nextEventID = 0
	e.nextLapID = 0
	e.raceState = newEmptyNoRaceState(domain.ModePractice)
	e.eventState = domain.EventManagerState{
		Initialized: true,
		Races:       []domain.RaceTournamentState{},
	}
	e.practiceState = domain.PracticeManagerState{
		Initialized: true,
		Sessions:    []domain.PracticeSession{},
	}
	e.practiceSnap = domain.PracticeSnapshot{}

	e.resetSessionLocked()
	e.initDetectorsLocked()
	raceSnap := cloneRaceState(e.raceState)
	practiceSnap := clonePracticeManagerState(e.practiceState)
	pilotsCopy := append([]domain.PilotSlot(nil), e.pilots...)
	gatesCopy := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilotsCopy, gatesCopy)
	}
	e.notifyRaceUpdated(raceSnap, nil, subs)
	e.notifyPracticeUpdated(practiceSnap, subs)
}

// RestoreDemoData populates the engine with the showcase demo dataset: Bay Area pilots,
// a 3-gate SlapRF track (Hub H1 + 3 Spoke timers T1..T3), 3 practice sessions, and 4 races.
func (e *Engine) RestoreDemoData() {
	e.RestoreState(showcaseDemoEngineState(), true)
}

// ResetPilotsToDefault restores the pilot slots to system defaults (`DefaultPilotSlots` in
// simulation mode, `DefaultRealPilotSlots` in real hardware mode) without wiping laps or track setup.
func (e *Engine) ResetPilotsToDefault(isSim bool) {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	wasRace := e.raceState.Mode == domain.ModeRace
	if isSim {
		e.pilots = domain.DefaultPilotSlots()
	} else {
		e.pilots = domain.DefaultRealPilotSlots()
	}
	if e.practiceSnap.Saved {
		e.practiceSnap.Pilots = append([]domain.PilotSlot(nil), e.pilots...)
	}
	for ri := range e.eventState.Races {
		r := &e.eventState.Races[ri]
		if r.Lifecycle == domain.LifecycleDraft && !hasAnyStartedHeatInState(r) {
			r.Roster = buildEventRosterFromPilots(e.pilots)
		}
	}
	if e.raceState.RaceID != "" && e.raceState.Lifecycle == domain.LifecycleDraft && !e.hasAnyStartedRaceHeatLocked() {
		e.raceState.Roster = buildEventRosterFromPilots(e.pilots)
	}
	if e.raceState.Generated && e.raceState.Lifecycle == domain.LifecycleDraft &&
		!e.hasAnyStartedRaceHeatLocked() && !hasAnyManualLocksInState(&e.raceState) {
		e.regenerateTournamentLocked()
	} else if wasRace {
		if e.raceState.Generated {
			e.resolveActiveTournamentLocked()
			e.stageOrDisarmActiveRaceLocked()
		} else {
			e.disarmAllPilotSlotsForRaceLocked()
			e.syncActiveRaceToEventLocked()
		}
	} else {
		if e.raceState.Generated {
			e.resolveActiveTournamentLocked()
		} else {
			e.syncActiveRaceToEventLocked()
		}
	}
	e.syncGlobalPilotsToPracticeSessionsLocked(0)
	if !e.isLiveRaceHeatActiveLocked() && e.practiceState.ActiveSessionID != "" {
		if activeSess := e.findPracticeSessionLocked(e.practiceState.ActiveSessionID); activeSess != nil {
			e.syncPracticeSessionRFSlotsLocked(activeSess)
		}
	} else if !e.isLiveRaceHeatActiveLocked() && e.raceState.Mode != domain.ModeRace {
		for i := range e.pilots {
			e.pilots[i].Enabled = false
		}
	}
	raceSnap := cloneRaceState(e.raceState)
	practiceSnap := clonePracticeManagerState(e.practiceState)
	e.initDetectorsLocked()
	pilotsCopy := append([]domain.PilotSlot(nil), e.pilots...)
	gatesCopy := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilotsCopy, gatesCopy)
	}
	e.notifyRaceUpdated(raceSnap, nil, subs)
	e.notifyPracticeUpdated(practiceSnap, subs)
}

// ResetTrackToDefault restores the track layout and timer colors to system defaults without
// wiping pilot configurations or recorded laps.
func (e *Engine) ResetTrackToDefault(isSim bool) {
	e.mu.Lock()
	if isSim {
		switch domain.NormalizeTimingHardwareMode(e.timingHardwareMode) {
		case domain.HardwareModeSlapRFBLE:
			e.gates, e.detected = defaultSimSlapRFBLELayoutLocked(time.Now())
		case domain.HardwareModeLapRF, domain.HardwareModeLapRFUSB:
			e.gates, e.detected = defaultSimLapRFLayoutLocked(time.Now())
		case domain.HardwareModeRotorHazard, domain.HardwareModeRotorHazardUSB:
			e.gates, e.detected = defaultSimRHLayoutLocked(time.Now())
		default:
			e.gates = domain.DefaultTrackGates()
			e.seedSimTimersLocked()
		}
	} else {
		// Real hardware: one gate per Spoke in timer-ID order (the first is start/finish). In USB
		// mode the Hub is a collector dongle and gets no gate by default; in Bluetooth Hub mode
		// (`slaprf_ble`) the Hub itself is the single-gate timer.
		ids := make([]int, 0, len(e.detected))
		for id, d := range e.detected {
			if d.IsHub && domain.NormalizeTimingHardwareMode(e.timingHardwareMode) != domain.HardwareModeSlapRFBLE {
				continue
			}
			ids = append(ids, int(id))
		}
		sort.Ints(ids)
		newGates := make([]domain.TrackGate, 0, len(ids))
		for idx, rawID := range ids {
			tid := uint8(rawID)
			d := e.detected[tid]
			d.Color = domain.DefaultTimerColor(tid)
			role := domain.GateRoleSectorGate
			if idx == 0 {
				role = domain.GateRoleStartFinish
			}
			newGates = append(newGates, domain.TrackGate{
				GateID:          uint8(idx + 1),
				AssignedTimerID: tid,
				TimerLabel:      d.TimerLabel,
				Name:            "",
				Color:           d.Color,
				Role:            role,
				TrackOrder:      idx,
				MapX:            0.5,
				MapY:            0.5,
				Online:          d.Online,
				BatteryMv:       d.BatteryMv,
				BatteryPct:      d.BatteryPct,
				NoiseFloorDbm:   d.NoiseFloorDbm,
				FirmwareVersion: d.FirmwareVersion,
				LastSeenAt:      d.LastSeenAt,
			})
		}
		e.gates = newGates
	}
	e.progress = make(map[int]*pilotProgress)
	e.initDetectorsLocked()
	pSnap, rSnap := e.syncTrackToOpenSessionsAndRacesLocked()
	pilotsCopy := append([]domain.PilotSlot(nil), e.pilots...)
	gatesCopy := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilotsCopy, gatesCopy)
	}
	e.dispatchTrackSnapshotUpdates(pSnap, rSnap, subs)
}

func (e *Engine) bumpSeqFromRestoredIDLocked(id string) {
	idx := strings.LastIndexByte(id, '-')
	if idx < 0 || idx+1 >= len(id) {
		return
	}
	if seq, err := strconv.ParseUint(id[idx+1:], 10, 64); err == nil && seq > e.nextRaceSeq {
		e.nextRaceSeq = seq
	}
}


