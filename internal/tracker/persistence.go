package tracker

import (
	"sort"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/dsp"
)

// PersistedEngineState captures the complete configuration and recorded session state of an Engine
// so it can be persisted to SQLite (native Go server) or browser WebStorage (WASM simulator) and
// rehydrated on restart.
type PersistedEngineState struct {
	ElapsedUs uint64                     `json:"elapsedUs"`
	RaceArmed bool                       `json:"raceArmed"`
	Rules     domain.TimingRules         `json:"rules"`
	Pilots    []domain.PilotSlot         `json:"pilots"`
	Gates     []domain.TrackGate         `json:"gates"`
	Timers    []domain.DetectedTimer     `json:"timers"`
	Laps      []domain.LapRecord         `json:"laps"`
	Crossings []domain.GateCrossingEvent `json:"crossings"`
	Filtered  []domain.FilteredDetection `json:"filtered"`
}

// ExportState returns a deep copy of the engine's persistable configuration and session records.
func (e *Engine) ExportState() PersistedEngineState {
	e.mu.RLock()
	defer e.mu.RUnlock()

	elapsedUs := uint64(time.Since(e.bootTime).Microseconds())
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
		cp.Sectors = append([]domain.SectorSplit(nil), l.Sectors...)
		laps[i] = cp
	}
	crossings := append([]domain.GateCrossingEvent(nil), e.crossings...)
	filtered := append([]domain.FilteredDetection(nil), e.filtered...)

	return PersistedEngineState{
		ElapsedUs: elapsedUs,
		RaceArmed: e.raceArmed,
		Rules:     e.rules,
		Pilots:    pilots,
		Gates:     gates,
		Timers:    timers,
		Laps:      laps,
		Crossings: crossings,
		Filtered:  filtered,
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
	e.bootTime = time.Now().Add(-time.Duration(maxUs) * time.Microsecond)
	e.raceArmed = s.RaceArmed
	if s.Rules.MinLapSec > 0 || s.Rules.MaxLapSec > 0 {
		e.rules = s.Rules.Normalized()
	}

	if len(s.Pilots) > 0 {
		e.pilots = append([]domain.PilotSlot(nil), s.Pilots...)
	}
	if s.Gates != nil {
		e.gates = make([]domain.TrackGate, len(s.Gates))
		now := time.Now()
		for i, g := range s.Gates {
			cp := g
			if markTimersOnline && cp.AssignedTimerID > 0 {
				cp.Online = true
				cp.LastSeenAt = now
			} else {
				cp.Online = false
				cp.LastSeenAt = time.Time{}
			}
			e.gates[i] = cp
		}
	}

	e.detected = make(map[uint8]*domain.DetectedTimer, len(s.Timers))
	now := time.Now()
	for _, d := range s.Timers {
		if d.TimerID == 0 {
			continue
		}
		cp := d
		if cp.Color == "" {
			cp.Color = domain.DefaultTimerColor(cp.TimerID)
		}
		if cp.FirmwareVersion == "" {
			cp.FirmwareVersion = domain.LatestFirmwareVersion
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

	e.detectors = make(map[string]*dsp.ChannelDetector)
	e.initDetectorsLocked()
	e.resetSessionLocked()
	e.passingNumbers = make(map[uint8]uint32)
	e.nextEventID = 0
	e.nextLapID = 0

	for _, l := range s.Laps {
		cp := l
		cp.Sectors = append([]domain.SectorSplit(nil), l.Sectors...)
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
	if len(e.crossings) > maxStoredCrossings {
		e.crossings = e.crossings[len(e.crossings)-maxStoredCrossings:]
	}

	for _, f := range s.Filtered {
		e.filtered = append(e.filtered, f)
	}
	if len(e.filtered) > maxStoredFiltered {
		e.filtered = e.filtered[len(e.filtered)-maxStoredFiltered:]
	}
}

// ResetToFactoryDefaults restores the engine's pilots, track gates, detected timers, rules,
// and session records back to a clean factory state.
func (e *Engine) ResetToFactoryDefaults(isSim bool) {
	e.mu.Lock()
	e.bootTime = time.Now()
	e.raceArmed = true
	e.rules = domain.DefaultTimingRules()
	e.detected = make(map[uint8]*domain.DetectedTimer)
	e.detectors = make(map[string]*dsp.ChannelDetector)
	e.passingNumbers = make(map[uint8]uint32)
	e.nextEventID = 0
	e.nextLapID = 0

	if isSim {
		e.pilots = domain.DefaultPilotSlots()
		e.gates = domain.DefaultTrackGates()
		for _, g := range e.gates {
			if g.AssignedTimerID > 0 {
				c := g.Color
				if c == "" {
					c = domain.DefaultTimerColor(g.AssignedTimerID)
				}
				e.detected[g.AssignedTimerID] = &domain.DetectedTimer{
					TimerID:         g.AssignedTimerID,
					TimerLabel:      g.TimerLabel,
					Color:           c,
					IsHub:           g.AssignedTimerID == 1,
					FirmwareVersion: g.FirmwareVersion,
					BatteryMv:       g.BatteryMv,
					BatteryPct:      g.BatteryPct,
					NoiseFloorDbm:   g.NoiseFloorDbm,
					Online:          g.Online,
					LastSeenAt:      g.LastSeenAt,
				}
			}
		}
	} else {
		e.pilots = domain.DefaultRealPilotSlots()
		e.gates = []domain.TrackGate{}
	}

	e.resetSessionLocked()
	e.initDetectorsLocked()
	pilotsCopy := append([]domain.PilotSlot(nil), e.pilots...)
	gatesCopy := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilotsCopy, gatesCopy)
	}
}

// ResetPilotsToDefault restores the pilot slots to system defaults (`DefaultPilotSlots` in
// simulation mode, `DefaultRealPilotSlots` in real hardware mode) without wiping laps or track setup.
func (e *Engine) ResetPilotsToDefault(isSim bool) {
	e.mu.Lock()
	if isSim {
		e.pilots = domain.DefaultPilotSlots()
	} else {
		e.pilots = domain.DefaultRealPilotSlots()
	}
	e.initDetectorsLocked()
	pilotsCopy := append([]domain.PilotSlot(nil), e.pilots...)
	gatesCopy := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilotsCopy, gatesCopy)
	}
}

// ResetTrackToDefault restores the track layout and timer colors to system defaults without
// wiping pilot configurations or recorded laps.
func (e *Engine) ResetTrackToDefault(isSim bool) {
	e.mu.Lock()
	if isSim {
		e.gates = domain.DefaultTrackGates()
		e.detected = make(map[uint8]*domain.DetectedTimer)
		for _, g := range e.gates {
			if g.AssignedTimerID > 0 {
				c := g.Color
				if c == "" {
					c = domain.DefaultTimerColor(g.AssignedTimerID)
				}
				e.detected[g.AssignedTimerID] = &domain.DetectedTimer{
					TimerID:         g.AssignedTimerID,
					TimerLabel:      g.TimerLabel,
					Color:           c,
					IsHub:           g.AssignedTimerID == 1,
					FirmwareVersion: g.FirmwareVersion,
					BatteryMv:       g.BatteryMv,
					BatteryPct:      g.BatteryPct,
					NoiseFloorDbm:   g.NoiseFloorDbm,
					Online:          g.Online,
					LastSeenAt:      g.LastSeenAt,
				}
			}
		}
	} else {
		ids := make([]int, 0, len(e.detected))
		for id := range e.detected {
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
	pilotsCopy := append([]domain.PilotSlot(nil), e.pilots...)
	gatesCopy := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilotsCopy, gatesCopy)
	}
}


