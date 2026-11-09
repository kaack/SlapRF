package tracker

import (
	"errors"

	"slaprf/internal/domain"
)

var ErrUnknownPilot = errors.New("unknown pilot slot")

// defaultExitGapDb is how far below the enter threshold the exit threshold sits when the
// pilot's own pair doesn't say otherwise.
const defaultExitGapDb float32 = 10

// SetGateThresholds applies per-gate, per-pilot enter thresholds (from dragging the
// threshold lines or auto-calibration). All updates are validated before any is applied.
func (e *Engine) SetGateThresholds(updates []domain.GateThresholdUpdate) error {
	e.mu.Lock()
	type target struct {
		gate, slot int
		enter      float32
	}
	targets := make([]target, 0, len(updates))
	for _, u := range updates {
		gi := -1
		for i := range e.gates {
			if e.gates[i].GateID == u.GateID {
				gi = i
				break
			}
		}
		if gi < 0 {
			e.mu.Unlock()
			return ErrUnknownGate
		}
		si := e.slotPositionLocked(u.SlotIndex)
		if si < 0 {
			e.mu.Unlock()
			return ErrUnknownPilot
		}
		enter := u.EnterDbm
		if enter != 0 {
			enter = clampDbm(enter)
		}
		targets = append(targets, target{gi, si, enter})
	}
	for _, t := range targets {
		e.gates[t.gate].EnterThresholds[t.slot] = t.enter
	}

	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, gates)
	}
	return nil
}

// thresholdsFor returns the enter / exit thresholds a gate uses for the pilot at position
// slotPos: the gate's calibrated value if set, otherwise the pilot's own. The exit
// threshold keeps the pilot's enter→exit gap.
func thresholdsFor(gate *domain.TrackGate, slotPos int, pilot domain.PilotSlot) (enter, exit float32) {
	gap := pilot.EnterThreshold - pilot.ExitThreshold
	if gap <= 0 {
		gap = defaultExitGapDb
	}
	enter = pilot.EnterThreshold
	if v := gate.EnterThresholds[slotPos]; v != 0 {
		enter = v
	}
	return enter, enter - gap
}

func (e *Engine) slotPositionLocked(slotIndex int) int {
	for i := range e.pilots {
		if e.pilots[i].SlotIndex == slotIndex {
			return i
		}
	}
	return -1
}

func clampDbm(v float32) float32 {
	if v < domain.MinThresholdDbm {
		return domain.MinThresholdDbm
	}
	if v > domain.MaxThresholdDbm {
		return domain.MaxThresholdDbm
	}
	return v
}
