package tracker

import (
	"fmt"
	"math"
	"sort"
	"time"

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

	// 0. Waveform hold-time, area-under-curve, and learned pass-curve spike rejection.
	slotPos := e.pilotPosLocked(pilot.SlotIndex)
	if spikeDetail := e.checkSpikeRejectionLocked(pilot, gate, slotPos, ev, r); spikeDetail != "" {
		return reject(domain.FilterSpike, "%s", spikeDetail)
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
	e.recordPassProfileLocked(pilot, gate, ev)
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
				if len(prog.currentSectors) == 0 && prog.lastGateID == gate.GateID {
					prog.currentSectors = append(prog.currentSectors, e.recordSplitLocked(pilot, prog, gate, ev))
				}
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

const passProfileRingCap = 8

type passCurveEntry struct {
	beamwidthMs float64
	areaDbSec   float64
	peakDbm     float32
}

type pilotPassProfile struct {
	freqMHz         uint16
	assignedTimerID uint8
	entries         [passProfileRingCap]passCurveEntry
	head            int
	count           int
}

func (e *Engine) pilotPosLocked(slotIndex int) int {
	for i := range e.pilots {
		if e.pilots[i].SlotIndex == slotIndex {
			return i
		}
	}
	return -1
}

// checkSpikeRejectionLocked validates live SlapRF dBm waveform candidates against:
//  1. Minimum gate hold time (`r.MinPassHoldSec`),
//  2. Minimum time above `enterThreshold` on weak grazing excursions,
//  3. Minimum area-under-curve (`dB*s`) above `exitThreshold`, and
//  4. The pilot's learned pass curve profile once >= 3 genuine passes have been observed.
//
// Synthetic test crossings and external hardware bridges (`HoldMs == 0 && PassAreaDbSec == 0`)
// bypass waveform checks cleanly.
func (e *Engine) checkSpikeRejectionLocked(
	pilot domain.PilotSlot,
	gate domain.TrackGate,
	slotPos int,
	ev domain.GateCrossingEvent,
	r domain.TimingRules,
) string {
	if domain.IsRotorHazardMode(e.timingHardwareMode) || ev.PeakRSSIDbm >= 0 {
		return ""
	}
	if ev.IsStepBurst {
		return fmt.Sprintf("Wi-Fi / RF packet burst at %s (%.1f dBm)", e.gateLabelLocked(gate.GateID), ev.PeakRSSIDbm)
	}
	if ev.HoldMs <= 0 && ev.PassAreaDbSec <= 0 {
		return ""
	}

	minHoldSec := r.MinPassHoldSec
	if minHoldSec <= 0 {
		minHoldSec = 0.12
	}
	minHoldMs := minHoldSec * 1000.0
	if ev.HoldMs < minHoldMs {
		return fmt.Sprintf("Sharp %.0f ms spike at %s (min hold %.0f ms)", ev.HoldMs, e.gateLabelLocked(gate.GateID), minHoldMs)
	}

	if slotPos >= 0 {
		enterDbm, _ := thresholdsFor(&gate, slotPos, pilot)
		if ev.PeakRSSIDbm < enterDbm+6.0 {
			minAboveMs := math.Max(55.0, minHoldMs*0.45)
			if ev.AboveEnterMs > 0 && ev.AboveEnterMs < minAboveMs {
				return fmt.Sprintf("Brief %.0f ms blip near threshold at %s (%.1f dBm)", ev.AboveEnterMs, e.gateLabelLocked(gate.GateID), ev.PeakRSSIDbm)
			}
		}
	}

	minAreaDbSec := math.Max(1.0, minHoldSec*12.0)
	if ev.PassAreaDbSec < minAreaDbSec {
		return fmt.Sprintf("Weak %.1f dB*s spike area at %s (%.0f ms, min %.1f dB*s)", ev.PassAreaDbSec, e.gateLabelLocked(gate.GateID), ev.HoldMs, minAreaDbSec)
	}

	if e.passProfiles != nil {
		prof := e.passProfiles[detKey{gate.GateID, pilot.SlotIndex}]
		if prof != nil && prof.freqMHz == pilot.FrequencyMHz && prof.assignedTimerID == gate.AssignedTimerID && prof.count >= 3 {
			medArea, medBw, medPeak := prof.medians()
			if ev.PassAreaDbSec < 0.22*medArea &&
				ev.BeamwidthMs < 0.35*medBw &&
				ev.BeamwidthMs < 200.0 &&
				ev.PeakRSSIDbm < medPeak-7.0 {
				return fmt.Sprintf(
					"Spike (%.1f dB*s, %.0f ms) does not match %s pass curve (%.1f dB*s, %.0f ms)",
					ev.PassAreaDbSec,
					ev.BeamwidthMs,
					pilot.Callsign,
					medArea,
					medBw,
				)
			}
		}
	}
	return ""
}

func (e *Engine) recordPassProfileLocked(pilot domain.PilotSlot, gate domain.TrackGate, ev domain.GateCrossingEvent) {
	if domain.IsRotorHazardMode(e.timingHardwareMode) || ev.PeakRSSIDbm >= 0 || ev.PassAreaDbSec <= 0 {
		return
	}
	if e.passProfiles == nil {
		e.passProfiles = make(map[detKey]*pilotPassProfile)
	}
	key := detKey{gate.GateID, pilot.SlotIndex}
	prof := e.passProfiles[key]
	if prof == nil || prof.freqMHz != pilot.FrequencyMHz || prof.assignedTimerID != gate.AssignedTimerID {
		prof = &pilotPassProfile{
			freqMHz:         pilot.FrequencyMHz,
			assignedTimerID: gate.AssignedTimerID,
		}
		e.passProfiles[key] = prof
	}
	entry := passCurveEntry{
		beamwidthMs: ev.BeamwidthMs,
		areaDbSec:   ev.PassAreaDbSec,
		peakDbm:     ev.PeakRSSIDbm,
	}
	if prof.count < passProfileRingCap {
		prof.entries[(prof.head+prof.count)%passProfileRingCap] = entry
		prof.count++
	} else {
		prof.entries[prof.head] = entry
		prof.head = (prof.head + 1) % passProfileRingCap
	}
}

func (p *pilotPassProfile) medians() (areaDbSec, beamwidthMs float64, peakDbm float32) {
	n := p.count
	if n == 0 {
		return 0, 0, 0
	}
	areas := make([]float64, n)
	bws := make([]float64, n)
	peaks := make([]float32, n)
	for i := 0; i < n; i++ {
		ent := p.entries[(p.head+i)%passProfileRingCap]
		areas[i] = ent.areaDbSec
		bws[i] = ent.beamwidthMs
		peaks[i] = ent.peakDbm
	}
	sort.Float64s(areas)
	sort.Float64s(bws)
	sort.Slice(peaks, func(i, j int) bool { return peaks[i] < peaks[j] })
	if n%2 == 1 {
		mid := n / 2
		return areas[mid], bws[mid], peaks[mid]
	}
	mid := n / 2
	return 0.5 * (areas[mid-1] + areas[mid]), 0.5 * (bws[mid-1] + bws[mid]), 0.5 * (peaks[mid-1] + peaks[mid])
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

func (e *Engine) wallClockMsForTimestampLocked(tsUs uint64) int64 {
	nowUs := e.NowUs()
	return time.Now().Add(-time.Duration(int64(nowUs)-int64(tsUs)) * time.Microsecond).UnixMilli()
}

func (e *Engine) buildLapLocked(pilot domain.PilotSlot, prog *pilotProgress, lapSec float64, completedAtUs uint64) *domain.LapRecord {
	lapNum := 1
	bestLap := 0.0
	for _, l := range e.laps {
		if l.SlotIndex == pilot.SlotIndex {
			lapNum++
			if !l.Invalidated && (bestLap == 0 || l.LapTimeSec < bestLap) {
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
		Sectors:       append([]domain.SectorSplit{}, prog.currentSectors...),
		CompletedAtUs: completedAtUs,
		CompletedAtMs: e.wallClockMsForTimestampLocked(completedAtUs),
		IsBestLap:     bestLap == 0 || lapSec < bestLap,
	}
}
