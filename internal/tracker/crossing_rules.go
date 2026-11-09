package tracker

import (
	"fmt"
	"math"

	"slaprf/internal/domain"
)

// crossingOutcome is the verdict of the timing rules on one detection.
type crossingOutcome struct {
	rejected *domain.FilteredDetection // set: the detection is discarded
	note     *domain.FilteredDetection // set: accepted, but something worth logging happened
	lap      *domain.LapRecord         // set: this crossing completed a counted lap
}

func sectorKey(slotIndex int, pair string) string {
	return fmt.Sprintf("%d:%s", slotIndex, pair)
}

// pairKey identifies a stretch of track by its entry and exit gates.
func pairKey(fromGateID, toGateID uint8) string {
	return fmt.Sprintf("%d>%d", fromGateID, toGateID)
}

func seconds(fromUs, toUs uint64) float64 {
	if toUs <= fromUs {
		return 0
	}
	return float64(toUs-fromUs) / 1e6
}

func round3(v float64) float64 {
	return math.Round(v*1000) / 1000
}

// applyCrossingLocked runs a detection through the timing rules of the gate it came from
// (global rules plus that gate's overrides), in order:
//
//  1. Gate cool-down    — same pilot, same gate, too soon: signal bounce / lingering quad.
//  2. Stale progress    — nothing for longer than MaxLapSec: the pilot stopped; start fresh.
//  3. Minimum section   — a different gate faster than physically possible: stray pickup.
//  4. Previous-gate echo — the gate the pilot just left fires again: neighbouring-gate
//     pickup on exit, or the pilot turning back through it.
//  5. Minimum lap time  — same pilot, same gate, sooner than anyone can lap. Every gate is
//     treated as if it were the start gate; at start/finish this is the lap itself.
//
// Accepted crossings advance the pilot's progress, record a section split and, at the
// start/finish gate, complete the lap (unless it exceeded MaxLapSec).
func (e *Engine) applyCrossingLocked(pilot domain.PilotSlot, gate domain.TrackGate, ev domain.GateCrossingEvent) crossingOutcome {
	r := e.rules.ForGate(gate.RuleOverrides)
	isSF := gate.Role == domain.GateRoleStartFinish
	reject := func(reason domain.FilterReason, format string, args ...any) crossingOutcome {
		return crossingOutcome{rejected: &domain.FilteredDetection{
			TimestampUs: ev.TimestampUs,
			GateID:      gate.GateID,
			SlotIndex:   pilot.SlotIndex,
			Callsign:    pilot.Callsign,
			Reason:      reason,
			Detail:      fmt.Sprintf(format, args...),
			PeakRSSIDbm: ev.PeakRSSIDbm,
		}}
	}

	// 1. Gate cool-down
	ckey := detectorKey(gate.GateID, pilot.SlotIndex)
	sinceSameGate := -1.0
	if last, ok := e.lastAcceptedUs[ckey]; ok {
		sinceSameGate = seconds(last, ev.TimestampUs)
		if sinceSameGate < r.GateCooldownSec {
			return reject(domain.FilterCooldown, "%s again after %.2fs (cool-down %.1fs)", e.gateLabelLocked(gate.GateID), sinceSameGate, r.GateCooldownSec)
		}
	}

	prog := e.progress[pilot.SlotIndex]
	if prog == nil {
		prog = &pilotProgress{}
		e.progress[pilot.SlotIndex] = prog
	}

	if prog.lastGateID != 0 {
		since := seconds(prog.lastGateTimeUs, ev.TimestampUs)

		// 2. Stale progress: the pilot stopped flying (crash, landed, swapped packs).
		if since > r.MaxLapSec {
			*prog = pilotProgress{}
		} else {
			// 3. Minimum section time
			if gate.GateID != prog.lastGateID && since < r.MinSectionSec {
				return reject(domain.FilterTooSoon, "Only %.2fs after %s (min section %.1fs)", since, e.gateLabelLocked(prog.lastGateID), r.MinSectionSec)
			}
			// 4. Previous-gate echo
			if r.EchoWindowSec > 0 && since < r.EchoWindowSec && e.isPreviousGateLocked(prog.lastGateID, gate.GateID) {
				return reject(domain.FilterEcho, "%s fired %.2fs after %s — previous gate re-detected or flying backwards", e.gateLabelLocked(gate.GateID), since, e.gateLabelLocked(prog.lastGateID))
			}
		}
	}

	// 5. Minimum lap time. At start/finish it's measured from the lap start; every other gate
	// is treated as a start gate too, so it can't time the same pilot again sooner.
	if isSF && prog.lapStartUs != 0 {
		if lapSec := seconds(prog.lapStartUs, ev.TimestampUs); lapSec < r.MinLapSec {
			return reject(domain.FilterMinLap, "Lap would be %.2fs (min lap %.1fs)", lapSec, r.MinLapSec)
		}
	}
	if sinceSameGate >= 0 && sinceSameGate < r.MinLapSec {
		if isSF {
			return reject(domain.FilterMinLap, "Lap would be %.2fs (min lap %.1fs)", sinceSameGate, r.MinLapSec)
		}
		return reject(domain.FilterMinLap, "%s again after %.2fs — quicker than a lap (min lap %.1fs)", e.gateLabelLocked(gate.GateID), sinceSameGate, r.MinLapSec)
	}

	// ---- accepted ----
	e.lastAcceptedUs[ckey] = ev.TimestampUs
	out := crossingOutcome{}

	if prog.lapStartUs != 0 && prog.lastGateID != 0 && prog.lastGateID != gate.GateID {
		prog.currentSectors = append(prog.currentSectors, e.recordSplitLocked(pilot, prog, gate, ev))
	}

	if isSF {
		if prog.lapStartUs != 0 {
			lapSec := seconds(prog.lapStartUs, ev.TimestampUs)
			if lapSec > r.MaxLapSec {
				out.note = &domain.FilteredDetection{
					TimestampUs: ev.TimestampUs,
					GateID:      gate.GateID,
					SlotIndex:   pilot.SlotIndex,
					Callsign:    pilot.Callsign,
					Reason:      domain.FilterLapTooLong,
					Detail:      fmt.Sprintf("Lap took %.1fs (max %.0fs) — not counted, new lap started", lapSec, r.MaxLapSec),
					PeakRSSIDbm: ev.PeakRSSIDbm,
				}
			} else {
				out.lap = e.buildLapLocked(pilot, prog, lapSec, ev.TimestampUs)
			}
		}
		prog.lapStartUs = ev.TimestampUs
		prog.currentSectors = nil
	}

	if prog.lastGateID != gate.GateID {
		prog.prevGateID = prog.lastGateID
	}
	prog.lastGateID = gate.GateID
	prog.lastGateTimeUs = ev.TimestampUs
	return out
}

// isPreviousGateLocked reports whether `candidate` is the gate immediately before `current`
// in track order — i.e. the pilot would be going backwards.
func (e *Engine) isPreviousGateLocked(current, candidate uint8) bool {
	ordered := e.orderedGatesLocked()
	n := len(ordered)
	if n < 3 {
		return false // with two gates, "previous" and "next" are the same gate
	}
	for i, g := range ordered {
		if g.GateID == current {
			return ordered[(i-1+n)%n].GateID == candidate
		}
	}
	return false
}

func (e *Engine) recordSplitLocked(pilot domain.PilotSlot, prog *pilotProgress, gate domain.TrackGate, ev domain.GateCrossingEvent) domain.SectorSplit {
	splitSec := seconds(prog.lastGateTimeUs, ev.TimestampUs)
	pKey := pairKey(prog.lastGateID, gate.GateID)
	sKey := sectorKey(pilot.SlotIndex, pKey)
	prevPilotBest := e.pilotBestSec[sKey]
	prevOverallBest := e.overallBestSec[pKey]

	badge := domain.BadgeNormal
	var deltaToBest float64
	if prevPilotBest > 0 {
		deltaToBest = round3(splitSec - prevPilotBest)
	}
	switch {
	case prevOverallBest == 0 || splitSec < prevOverallBest:
		e.overallBestSec[pKey] = splitSec
		badge = domain.BadgeOverallBest
	case prevPilotBest == 0 || splitSec < prevPilotBest:
		badge = domain.BadgePersonalBest
	case splitSec > prevPilotBest*1.10:
		badge = domain.BadgeOffPace
	}
	if prevPilotBest == 0 || splitSec < prevPilotBest {
		e.pilotBestSec[sKey] = splitSec
	}

	split := domain.SectorSplit{
		SectorIndex:    len(prog.currentSectors) + 1,
		FromGateID:     prog.lastGateID,
		ToGateID:       gate.GateID,
		Label:          e.sectionLabelLocked(prog.lastGateID, gate.GateID),
		SplitSeconds:   round3(splitSec),
		DeltaToBestSec: deltaToBest,
		ExitSpeedMph:   ev.EstimatedSpeedMph,
		Badge:          badge,
	}
	e.sectorHistory[sKey] = append(e.sectorHistory[sKey], split)
	return split
}

func (e *Engine) buildLapLocked(pilot domain.PilotSlot, prog *pilotProgress, lapSec float64, completedAtUs uint64) *domain.LapRecord {
	lapNum := 1
	bestLap := 0.0
	for _, l := range e.laps {
		if l.SlotIndex == pilot.SlotIndex {
			lapNum++
			if bestLap == 0 || l.LapTimeSec < bestLap {
				bestLap = l.LapTimeSec
			}
		}
	}
	var delta float64
	if bestLap > 0 {
		delta = round3(lapSec - bestLap)
	}
	e.nextLapID++
	return &domain.LapRecord{
		LapID:         e.nextLapID,
		SlotIndex:     pilot.SlotIndex,
		Callsign:      pilot.Callsign,
		LapNumber:     lapNum,
		LapTimeSec:    round3(lapSec),
		DeltaToBest:   delta,
		Sectors:       append([]domain.SectorSplit(nil), prog.currentSectors...),
		CompletedAtUs: completedAtUs,
		IsBestLap:     bestLap == 0 || lapSec < bestLap,
	}
}
