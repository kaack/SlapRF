package ingest

import (
	"sort"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/multigp"
)

// SimPilotPersistedState captures a simulated pilot's position, status, and 6S LiPo pack state
// so the simulation resumes smoothly after a page refresh without resetting pilots or batteries.
type SimPilotPersistedState struct {
	SlotIndex       int                   `json:"slotIndex"`
	TrackPosMeters  float64               `json:"trackPosMeters"`
	CurrentSpeedMps float64               `json:"currentSpeedMps"`
	AltitudeMeters  float64               `json:"altitudeMeters"`
	Status          domain.SimPilotStatus `json:"status"`
	LandingTarget   domain.SimPilotStatus `json:"landingTarget,omitempty"`
	BatteryPct      float64               `json:"batteryPct"`
	PackPct         [3]float64            `json:"packPct"`
	ActivePackIdx   int                   `json:"activePackIdx"`
	StateTimerSec   float64               `json:"stateTimerSec"`
	WantPitAtFinish bool                  `json:"wantPitAtFinish,omitempty"`
	CrashesCount    int                   `json:"crashesCount,omitempty"`
	PacksFlown      int                   `json:"packsFlown,omitempty"`
}

// SimModelVersion identifies the simulated Hub/Spoke model stored in persisted sim state.
// Version 3: simulated timers record 4-sample sliding windows (0xC5 0x59) and require Hub H1
// to be connected over USB before telemetry or laps enter the timing engine.
// Saved state from another version is discarded (see SimStateCompatible).
const SimModelVersion = 3

// SimPersistedOptions captures the user-configurable simulator controls so they survive restarts.
type SimPersistedOptions struct {
	Model               int                        `json:"model,omitempty"`
	Running             bool                       `json:"running"`
	SpeedMultiplier     int                        `json:"speedMultiplier,omitempty"`
	TrackWalkerActive   bool                       `json:"trackWalkerActive"`
	TrackWalkerTimerSec float64                  `json:"trackWalkerTimerSec,omitempty"`
	PoweredOffTimers    []uint8                  `json:"poweredOffTimers,omitempty"`
	UnflashedBoards     []SimBoardBlankState     `json:"unflashedBoards,omitempty"`
	PausedSlots         []int                      `json:"pausedSlots,omitempty"`
	PilotStates         []SimPilotPersistedState   `json:"pilotStates,omitempty"`
	LapRFUnits          []domain.SimLapRFUnit      `json:"laprfUnits,omitempty"`
	RotorHazardUnits    []domain.SimRotorHazardUnit `json:"rotorhazardUnits,omitempty"`
	MultiGP             *multigp.SimPersistedState `json:"multiGP,omitempty"`
}

// ExportOptions returns a snapshot of the simulator's user-configurable toggles and pilot states.
func (s *TrackSimulator) ExportOptions() SimPersistedOptions {
	s.mu.Lock()
	defer s.mu.Unlock()

	var offTimers []uint8
	for id, off := range s.poweredOffTimers {
		if off {
			offTimers = append(offTimers, id)
		}
	}
	sort.Slice(offTimers, func(i, j int) bool { return offTimers[i] < offTimers[j] })

	var blanks []SimBoardBlankState
	for _, b := range s.unflashedBoards {
		blanks = append(blanks, b)
	}
	sort.Slice(blanks, func(i, j int) bool { return blanks[i].TimerID < blanks[j].TimerID })

	var paused []int
	pStates := make([]SimPilotPersistedState, 0, len(s.pilotStates))
	for _, ps := range s.pilotStates {
		if ps.status == domain.SimStatusPaused {
			paused = append(paused, ps.slotIndex)
		}
		pStates = append(pStates, SimPilotPersistedState{
			SlotIndex:       ps.slotIndex,
			TrackPosMeters:  ps.trackPosMeters,
			CurrentSpeedMps: ps.currentSpeedMps,
			AltitudeMeters:  ps.altitudeMeters,
			Status:          ps.status,
			LandingTarget:   ps.landingTargetStatus,
			BatteryPct:      ps.batteryPct,
			PackPct:         ps.packPct,
			ActivePackIdx:   ps.activePackIdx,
			StateTimerSec:   ps.stateTimerSec,
			WantPitAtFinish: ps.wantPitAtFinish,
			CrashesCount:    ps.crashesCount,
			PacksFlown:      ps.packsFlown,
		})
	}
	sort.Ints(paused)

	s.ensureLapRFAndMultiGPLocked()
	laprfUnits := make([]domain.SimLapRFUnit, len(s.laprfUnits))
	for i := range s.laprfUnits {
		laprfUnits[i] = s.laprfUnits[i].SimLapRFUnit
	}
	rhUnits := make([]domain.SimRotorHazardUnit, len(s.rhUnits))
	for i := range s.rhUnits {
		rhUnits[i] = s.rhUnits[i].SimRotorHazardUnit
	}
	mgpSnap := s.mgpBackend.ExportState()

	return SimPersistedOptions{
		Model:               SimModelVersion,
		Running:             s.running,
		SpeedMultiplier:     NormalizeSimSpeedMultiplier(s.speedMultiplier),
		TrackWalkerActive:   s.trackWalkerActive,
		TrackWalkerTimerSec: s.trackWalkerTimerSec,
		PoweredOffTimers:    offTimers,
		UnflashedBoards:     blanks,
		PausedSlots:         paused,
		PilotStates:         pStates,
		LapRFUnits:          laprfUnits,
		RotorHazardUnits:    rhUnits,
		MultiGP:             &mgpSnap,
	}
}

// SimStateCompatible reports whether persisted simulator options were saved by the current sim
// model. Older saves (where the simulated Hub timed the start/finish gate) are not migrated:
// callers drop them and start from the default course.
func SimStateCompatible(opts SimPersistedOptions) bool {
	return opts.Model == SimModelVersion
}

// RestoreOptions restores the simulator's user-configurable toggles, powered-off timers, and pilot states.
func (s *TrackSimulator) RestoreOptions(opts SimPersistedOptions) {
	s.mu.Lock()
	s.running = opts.Running
	s.speedMultiplier = NormalizeSimSpeedMultiplier(opts.SpeedMultiplier)
	s.trackWalkerActive = opts.TrackWalkerActive
	s.trackWalkerTimerSec = opts.TrackWalkerTimerSec
	if s.trackWalkerActive && s.trackWalkerTimerSec <= 0 {
		s.trackWalkerTimerSec = 35.0
	}
	s.poweredOffTimers = make(map[uint8]bool, len(opts.PoweredOffTimers))
	for _, id := range opts.PoweredOffTimers {
		s.poweredOffTimers[id] = true
	}
	s.unflashedBoards = make(map[uint8]SimBoardBlankState, len(opts.UnflashedBoards))
	for _, b := range opts.UnflashedBoards {
		if b.TimerID >= 1 && b.TimerID <= 7 {
			if b.Color == "" {
				b.Color = domain.DefaultTimerColor(b.TimerID)
			}
			s.unflashedBoards[b.TimerID] = b
		}
	}
	s.timerRuntimes = make(map[uint8]*simTimerRuntime)
	s.ensureLapRFAndMultiGPLocked()
	if len(opts.LapRFUnits) > 0 {
		restored := make([]simLapRFUnitState, 0, len(opts.LapRFUnits))
		for _, u := range opts.LapRFUnits {
			if u.TimerID >= 2 && u.TimerID <= 7 {
				u.Label = normalizeSimLapRFLabel(u.Label, u.TimerID)
				restored = append(restored, simLapRFUnitState{SimLapRFUnit: u})
			}
		}
		if len(restored) > 0 {
			s.laprfUnits = restored
		}
	}
	if len(opts.RotorHazardUnits) > 0 {
		restoredRH := make([]*simRHUnitState, 0, len(opts.RotorHazardUnits))
		for _, u := range opts.RotorHazardUnits {
			if u.TimerID >= 2 && u.TimerID <= 7 {
				u.Label = normalizeSimRHLabel(u.Label, u.TimerID)
				u.NodeCount = normalizeSimRHNodeCount(u.NodeCount)
				st := &simRHUnitState{SimRotorHazardUnit: u}
				st.syncLinkStateLocked(1_000_000, "", "", false)
				st.pendingHeartbeats = nil
				st.pendingCrossings = nil
				restoredRH = append(restoredRH, st)
			}
		}
		if len(restoredRH) > 0 {
			s.rhUnits = restoredRH
		}
	}
	if opts.MultiGP != nil {
		s.mgpBackend.RestoreState(opts.MultiGP)
	}
	s.hellosSent = false
	hasUsbSink := s.hubFrameSink != nil
	if len(opts.PilotStates) > 0 {
		bySlot := make(map[int]SimPilotPersistedState, len(opts.PilotStates))
		for _, pst := range opts.PilotStates {
			bySlot[pst.SlotIndex] = pst
		}
		for i := range s.pilotStates {
			ps := &s.pilotStates[i]
			if saved, ok := bySlot[ps.slotIndex]; ok {
				ps.trackPosMeters = saved.TrackPosMeters
				ps.currentSpeedMps = saved.CurrentSpeedMps
				ps.altitudeMeters = saved.AltitudeMeters
				if saved.Status != "" {
					ps.status = saved.Status
				}
				ps.landingTargetStatus = saved.LandingTarget
				ps.batteryPct = saved.BatteryPct
				ps.packPct = saved.PackPct
				ps.activePackIdx = saved.ActivePackIdx
				ps.stateTimerSec = saved.StateTimerSec
				ps.wantPitAtFinish = saved.WantPitAtFinish
				ps.crashesCount = saved.CrashesCount
				if saved.PacksFlown > 0 {
					ps.packsFlown = saved.PacksFlown
				}
			}
		}
	} else {
		pausedSet := make(map[int]bool, len(opts.PausedSlots))
		for _, slot := range opts.PausedSlots {
			pausedSet[slot] = true
		}
		for i := range s.pilotStates {
			ps := &s.pilotStates[i]
			if pausedSet[ps.slotIndex] {
				ps.status = domain.SimStatusPaused
				ps.currentSpeedMps = 0
				ps.altitudeMeters = 0
				ps.stateTimerSec = 0
			}
		}
	}
	s.mu.Unlock()

	hwMode := s.engine.TimingHardwareMode()
	if hwMode == domain.HardwareModeLapRF || domain.IsRotorHazardMode(hwMode) {
		s.SyncHardwareMode()
	} else if hasUsbSink {
		s.engine.SetAllTimersOffline()
	} else {
		for _, id := range opts.PoweredOffTimers {
			s.engine.SetDetectedTimerOnline(id, false)
		}
	}
}

// ResetToFactoryDefaults wipes the simulation engine and simulator state back to an empty
// clean slate with default settings.
func (s *TrackSimulator) ResetToFactoryDefaults() {
	s.engine.ResetToFactoryDefaults(true)
	hwMode := s.engine.TimingHardwareMode()
	s.mu.Lock()
	s.speedMultiplier = 1
	s.trackWalkerActive = false
	s.trackWalkerTimerSec = 0
	s.poweredOffTimers = make(map[uint8]bool)
	s.unflashedBoards = make(map[uint8]SimBoardBlankState)
	s.timerRuntimes = make(map[uint8]*simTimerRuntime)
	s.laprfUnits = defaultSimLapRFUnits()
	s.rhUnits = defaultSimRHUnitsForMode(hwMode)
	s.mgpBackend = multigp.NewSimBackend()
	s.hellosSent = false
	s.resetPilotsLocked()
	s.mu.Unlock()
}

// RestoreDemoData populates the simulation engine and simulator runtime with the Bay Area demo
// pilots, 4-gate track, simulated timers, and prewarmed practice laps.
func (s *TrackSimulator) RestoreDemoData() {
	s.engine.RestoreDemoData()
	hwMode := s.engine.TimingHardwareMode()
	s.mu.Lock()
	s.speedMultiplier = 1
	s.trackWalkerActive = false
	s.trackWalkerTimerSec = 0
	s.poweredOffTimers = make(map[uint8]bool)
	s.unflashedBoards = make(map[uint8]SimBoardBlankState)
	s.timerRuntimes = make(map[uint8]*simTimerRuntime)
	s.laprfUnits = defaultSimLapRFUnits()
	s.rhUnits = defaultSimRHUnitsForMode(hwMode)
	s.mgpBackend = multigp.NewSimBackend()
	s.hellosSent = false
	hasUsbSink := s.hubFrameSink != nil
	s.resetPilotsLocked()
	s.mu.Unlock()
	if hasUsbSink {
		s.engine.SetAllTimersOffline()
	} else {
		s.Prewarm(45 * time.Second)
	}
}

// ResetTimersAndTrackToDefault restores the default simulated timers (gate-less Hub H1 plus
// Spokes S1..S4) and the 4-gate loop without wiping pilot configurations or completed laps.
func (s *TrackSimulator) ResetTimersAndTrackToDefault() {
	hwMode := s.engine.TimingHardwareMode()
	s.mu.Lock()
	s.poweredOffTimers = make(map[uint8]bool)
	s.unflashedBoards = make(map[uint8]SimBoardBlankState)
	s.timerRuntimes = make(map[uint8]*simTimerRuntime)
	s.laprfUnits = defaultSimLapRFUnits()
	s.rhUnits = defaultSimRHUnitsForMode(hwMode)
	s.hellosSent = false
	hasUsbSink := s.hubFrameSink != nil
	s.mu.Unlock()
	s.engine.ResetTrackToDefault(true)
	if hwMode == domain.HardwareModeLapRF || domain.IsRotorHazardMode(hwMode) {
		s.SyncHardwareMode()
	} else if hasUsbSink {
		s.engine.SetAllTimersOffline()
	}
}


