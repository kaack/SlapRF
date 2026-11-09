package ingest

import (
	"sort"
	"time"

	"slaprf/internal/domain"
)

// SimPersistedOptions captures the user-configurable simulator controls so they survive restarts.
type SimPersistedOptions struct {
	Running           bool    `json:"running"`
	TrackWalkerActive bool    `json:"trackWalkerActive"`
	PoweredOffTimers  []uint8 `json:"poweredOffTimers,omitempty"`
	PausedSlots       []int   `json:"pausedSlots,omitempty"`
}

// ExportOptions returns a snapshot of the simulator's user-configurable toggles.
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
	for _, ps := range s.pilotStates {
		if ps.status == domain.SimStatusPaused {
			paused = append(paused, ps.slotIndex)
		}
	}
	sort.Ints(paused)

	return SimPersistedOptions{
		Running:           s.running,
		TrackWalkerActive: s.trackWalkerActive,
		PoweredOffTimers:  offTimers,
		PausedSlots:       paused,
	}
}

// RestoreOptions restores the simulator's user-configurable toggles and powered-off timers.
func (s *TrackSimulator) RestoreOptions(opts SimPersistedOptions) {
	s.mu.Lock()
	s.running = opts.Running
	s.poweredOffTimers = make(map[uint8]bool, len(opts.PoweredOffTimers))
	for _, id := range opts.PoweredOffTimers {
		s.poweredOffTimers[id] = true
	}
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
	s.mu.Unlock()

	for _, id := range opts.PoweredOffTimers {
		s.engine.SetDetectedTimerOnline(id, false)
	}
	if opts.TrackWalkerActive {
		s.SetTrackWalker(true)
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

