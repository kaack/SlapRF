package ingest

import (
	"sort"
	"time"

	"slaprf/internal/domain"
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
// Version 2: the simulated Hub is a gate-less collector dongle (same model as real hardware).
// Saved state from another version is discarded (see SimStateCompatible).
const SimModelVersion = 2

// SimPersistedOptions captures the user-configurable simulator controls so they survive restarts.
type SimPersistedOptions struct {
	Model               int                      `json:"model,omitempty"`
	Running             bool                     `json:"running"`
	TrackWalkerActive   bool                     `json:"trackWalkerActive"`
	TrackWalkerTimerSec float64                  `json:"trackWalkerTimerSec,omitempty"`
	PoweredOffTimers    []uint8                  `json:"poweredOffTimers,omitempty"`
	PausedSlots         []int                    `json:"pausedSlots,omitempty"`
	PilotStates         []SimPilotPersistedState `json:"pilotStates,omitempty"`
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

	return SimPersistedOptions{
		Model:               SimModelVersion,
		Running:             s.running,
		TrackWalkerActive:   s.trackWalkerActive,
		TrackWalkerTimerSec: s.trackWalkerTimerSec,
		PoweredOffTimers:    offTimers,
		PausedSlots:         paused,
		PilotStates:         pStates,
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
	s.trackWalkerActive = opts.TrackWalkerActive
	s.trackWalkerTimerSec = opts.TrackWalkerTimerSec
	if s.trackWalkerActive && s.trackWalkerTimerSec <= 0 {
		s.trackWalkerTimerSec = 35.0
	}
	s.poweredOffTimers = make(map[uint8]bool, len(opts.PoweredOffTimers))
	for _, id := range opts.PoweredOffTimers {
		s.poweredOffTimers[id] = true
	}
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

	for _, id := range opts.PoweredOffTimers {
		s.engine.SetDetectedTimerOnline(id, false)
	}
}

// ResetToFactoryDefaults resets the simulation engine and simulator state back to a fresh
// pre-warmed default session.
func (s *TrackSimulator) ResetToFactoryDefaults() {
	s.engine.ResetToFactoryDefaults(true)
	s.mu.Lock()
	s.trackWalkerActive = false
	s.trackWalkerTimerSec = 0
	s.poweredOffTimers = make(map[uint8]bool)
	s.resetPilotsLocked()
	s.mu.Unlock()
	s.Prewarm(45 * time.Second)
}

// ResetTimersAndTrackToDefault restores the default simulated timers (gate-less Hub H1 plus
// Spokes S1..S4) and the 4-gate loop without wiping pilot configurations or completed laps.
func (s *TrackSimulator) ResetTimersAndTrackToDefault() {
	s.mu.Lock()
	s.poweredOffTimers = make(map[uint8]bool)
	s.mu.Unlock()
	s.engine.ResetTrackToDefault(true)
}


