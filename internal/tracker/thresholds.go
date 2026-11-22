package tracker

import (
	"errors"

	"slaprf/internal/domain"
)

var ErrUnknownPilot = errors.New("unknown pilot slot")

// defaultExitGapDb is how far below the enter threshold the exit threshold sits when the
// pilot's own pair doesn't say otherwise.
const (
	defaultExitGapDb float32 = 10
	defaultRHExitGap float32 = 25
)

// SetGateThresholds applies per-gate, per-pilot enter and exit thresholds (from dragging the
// threshold lines or auto-calibration). All updates are validated before any is applied.
func (e *Engine) SetGateThresholds(updates []domain.GateThresholdUpdate) error {
	e.mu.Lock()
	type target struct {
		gate, slot                  int
		slotIndex                   int
		gateID                      uint8
		auto                        bool
		enter, exit, laprfT         float32
		rhEnter, rhExit             float32
		hasDbm, hasLaprf, hasRH     bool
	}
	targets := make([]target, 0, len(updates))
	hwMode := domain.NormalizeTimingHardwareMode(e.timingHardwareMode)
	isLapRFMode := domain.IsLapRFMode(hwMode)
	isRHMode := domain.IsRotorHazardMode(hwMode)

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
					effEn, _ = rhThresholdsFor(&e.gates[gi], si, e.pilots[si])
				} else {
					effEn = clampRHEnterThreshold(effEn)
				}
				t.rhEnter = effEn
				if rawEx > 0 {
					t.rhExit = clampRHExitThreshold(rawEx, effEn)
				} else if si >= 0 && si < len(e.gates[gi].RHExitThresholds) && e.gates[gi].RHExitThresholds[si] > 0 {
					t.rhExit = clampRHExitThreshold(e.gates[gi].RHExitThresholds[si], effEn)
				} else {
					t.rhExit = 0
				}
			}
		} else if isRHMode && u.EnterDbm < 0 {
			// Transform incoming dBm thresholds onto RotorHazard's 0..255 RX5808 RSSI scale.
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
	sfGateUpdated := false
	for _, t := range targets {
		if t.slot >= 0 && t.slot < len(e.gates[t.gate].EnterThresholds) {
			if t.hasDbm {
				e.gates[t.gate].EnterThresholds[t.slot] = t.enter
				e.gates[t.gate].ExitThresholds[t.slot] = t.exit
				e.setAutoCalibManualPinLocked(t.gateID, t.slotIndex, t.enter != 0 && !t.auto, t.enter == 0)
				if det := e.detectors[detKey{t.gateID, t.slotIndex}]; det != nil {
					_, effEx := thresholdsFor(&e.gates[t.gate], t.slot, e.pilots[t.slot])
					det.RearmIfBelow(effEx)
				}
			}
			if t.hasLaprf {
				e.gates[t.gate].LapRFThresholds[t.slot] = t.laprfT
			}
			if t.hasRH {
				e.gates[t.gate].RHEnterThresholds[t.slot] = t.rhEnter
				e.gates[t.gate].RHExitThresholds[t.slot] = t.rhExit
			}
		}
		if e.gates[t.gate].Role == domain.GateRoleStartFinish {
			sfGateUpdated = true
		}
	}

	// Keep Start/Finish seat threshold snapshots and editable race/practice track snapshots in sync
	var raceSnap *domain.RaceTournamentState
	if sfGateUpdated {
		raceSnap = e.syncStartFinishThresholdsToRaceLocked(hwMode)
	}

	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, gates)
	}
	if raceSnap != nil {
		e.notifyRaceUpdated(*raceSnap, nil, subs)
	}
	return nil
}

func (e *Engine) syncStartFinishThresholdsToRaceLocked(hwMode domain.TimingHardwareMode) *domain.RaceTournamentState {
	if !e.raceState.Generated {
		return nil
	}
	var sfGate *domain.TrackGate
	for gi := range e.gates {
		if e.gates[gi].Role == domain.GateRoleStartFinish {
			sfGate = &e.gates[gi]
			break
		}
	}
	if sfGate == nil {
		return nil
	}
	changedRace := false
	for hi := range e.raceState.Heats {
		h := &e.raceState.Heats[hi]
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
			if h.Seats[si].EnterRssiDbm != en || h.Seats[si].ExitRssiDbm != ex {
				h.Seats[si].EnterRssiDbm = en
				h.Seats[si].ExitRssiDbm = ex
				changedRace = true
			}
		}
	}
	if isRaceTrackEditable(&e.raceState) {
		e.raceState.TrackSnapshot = e.snapshotOrderedGatesLocked()
		changedRace = true
	}
	if !changedRace {
		return nil
	}
	e.syncActiveRaceToEventLocked()
	cp := cloneRaceState(e.raceState)
	return &cp
}

// thresholdsFor returns the enter / exit thresholds a gate uses for the pilot at position
// slotPos: the gate's calibrated values if set, otherwise the pilot's own. When only enter
// is overridden on the gate, exit preserves the pilot's enter→exit gap.
func thresholdsFor(gate *domain.TrackGate, slotPos int, pilot domain.PilotSlot) (enter, exit float32) {
	gap := pilot.EnterThreshold - pilot.ExitThreshold
	if gap < domain.MinHysteresisGapDb {
		gap = defaultExitGapDb
	}
	enter = pilot.EnterThreshold
	if gate != nil && slotPos >= 0 && slotPos < len(gate.EnterThresholds) {
		if v := gate.EnterThresholds[slotPos]; v != 0 {
			enter = v
		}
		if vx := gate.ExitThresholds[slotPos]; vx != 0 {
			exit = clampExitDbm(vx, enter)
			return enter, exit
		}
	}
	return enter, clampExitDbm(enter-gap, enter)
}

func clampExitDbm(v float32, enter float32) float32 {
	maxExit := enter - domain.MinHysteresisGapDb
	minExit := domain.MinThresholdDbm - domain.MinHysteresisGapDb
	if v < minExit {
		return minExit
	}
	if v > maxExit {
		return maxExit
	}
	return v
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

func clampLapRFThreshold(v float32) float32 {
	if v < domain.MinLapRFThreshold {
		return domain.MinLapRFThreshold
	}
	if v > domain.MaxLapRFThreshold {
		return domain.MaxLapRFThreshold
	}
	return v
}

func laprfThresholdFor(gate *domain.TrackGate, slotPos int, pilot domain.PilotSlot) float32 {
	if gate != nil && slotPos >= 0 && slotPos < len(gate.LapRFThresholds) {
		if v := gate.LapRFThresholds[slotPos]; v > 0 {
			return clampLapRFThreshold(v)
		}
	}
	if pilot.LapRFThreshold > 0 {
		return clampLapRFThreshold(pilot.LapRFThreshold)
	}
	return domain.DefaultLapRFThreshold
}

func clampRHEnterThreshold(v float32) float32 {
	if v < domain.MinRHThreshold {
		return domain.MinRHThreshold
	}
	if v > domain.MaxRHThreshold {
		return domain.MaxRHThreshold
	}
	return v
}

func clampRHExitThreshold(v float32, enter float32) float32 {
	maxExit := enter - domain.MinRHHysteresisGap
	if maxExit < 5 {
		maxExit = 5
	}
	if v < 5 {
		return 5
	}
	if v > maxExit {
		return maxExit
	}
	return v
}

// dbmToRHEnter scales a SlapRF dBm enter threshold (-95..-20, default -58)
// onto RotorHazard's 0..255 RX5808 RSSI scale (default 95, 2.5 units per dB).
func dbmToRHEnter(dbm float32) float32 {
	if dbm == 0 {
		return domain.DefaultRHEnterThreshold
	}
	return clampRHEnterThreshold(domain.DefaultRHEnterThreshold + (dbm+58)*2.5)
}

// dbmToRHExit scales a SlapRF dBm exit threshold onto RotorHazard's 0..255 RSSI scale.
func dbmToRHExit(dbm float32, rhEnter float32) float32 {
	if dbm == 0 {
		return clampRHExitThreshold(rhEnter-defaultRHExitGap, rhEnter)
	}
	return clampRHExitThreshold(domain.DefaultRHEnterThreshold+(dbm+58)*2.5, rhEnter)
}

func rhThresholdsFor(gate *domain.TrackGate, slotPos int, pilot domain.PilotSlot) (enter, exit float32) {
	pEn := pilot.RHEnterThreshold
	if pEn <= 0 {
		pEn = dbmToRHEnter(pilot.EnterThreshold)
	} else {
		pEn = clampRHEnterThreshold(pEn)
	}
	pEx := pilot.RHExitThreshold
	if pEx <= 0 {
		if pilot.ExitThreshold != 0 {
			pEx = dbmToRHExit(pilot.ExitThreshold, pEn)
		} else {
			pEx = pEn - defaultRHExitGap
		}
	}
	pEx = clampRHExitThreshold(pEx, pEn)
	gap := pEn - pEx
	if gap < domain.MinRHHysteresisGap {
		gap = defaultRHExitGap
	}

	enter = pEn
	if gate != nil && slotPos >= 0 && slotPos < len(gate.RHEnterThresholds) {
		if v := gate.RHEnterThresholds[slotPos]; v > 0 {
			enter = clampRHEnterThreshold(v)
		} else if slotPos < len(gate.EnterThresholds) && gate.EnterThresholds[slotPos] != 0 {
			enter = dbmToRHEnter(gate.EnterThresholds[slotPos])
		}
		if vx := gate.RHExitThresholds[slotPos]; vx > 0 {
			return enter, clampRHExitThreshold(vx, enter)
		} else if slotPos < len(gate.ExitThresholds) && gate.ExitThresholds[slotPos] != 0 {
			return enter, dbmToRHExit(gate.ExitThresholds[slotPos], enter)
		}
	}
	return enter, clampRHExitThreshold(enter-gap, enter)
}
