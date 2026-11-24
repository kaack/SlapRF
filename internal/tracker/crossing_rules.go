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
	rejected          *domain.FilteredDetection // set: the detection is discarded
	note              *domain.FilteredDetection // set: accepted, but something worth logging happened
	lap               *domain.LapRecord         // set: this crossing completed a counted lap
	supersededEventID uint64                    // non-zero: prior weak bump replaced by this stronger pass
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
// (global rules -> gate overrides -> pilot-at-gate overrides), evaluating each timer
// independently:
//
//  1. Minimum crossing time (RF spike check) - hold duration, area-under-curve, and learned pass profile.
//  2. Stale progress - nothing for longer than MaxLapSec: the pilot stopped; start fresh.
//  3. Minimum lap time - same pilot, same gate, sooner than MinLapSec. Every gate is treated
//     independently like a start gate; at Start/Finish this also guards the lap duration.
//
// Accepted crossings advance the pilot's progress, record a section split and, at the
// Start/Finish gate, complete the lap (unless it exceeded MaxLapSec).
func (e *Engine) applyCrossingLocked(pilot domain.PilotSlot, gate domain.TrackGate, ev domain.GateCrossingEvent) crossingOutcome {
	r := gate.RulesForPilot(e.rules, pilot.SlotIndex)
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

	// 1. Minimum crossing time, area-under-curve, and learned pass-curve spike rejection.
	slotPos := e.pilotPosLocked(pilot.SlotIndex)
	if spikeDetail := e.checkSpikeRejectionLocked(pilot, gate, slotPos, ev, r); spikeDetail != "" {
		return reject(domain.FilterSpike, "%s", spikeDetail)
	}

	ckey := detectorKey(gate.GateID, pilot.SlotIndex)
	sinceSameGate := -1.0
	if last, ok := e.lastAcceptedUs[ckey]; ok {
		sinceSameGate = seconds(last, ev.TimestampUs)
	}

	prog := e.progress[pilot.SlotIndex]
	if prog == nil {
		prog = &pilotProgress{}
		e.progress[pilot.SlotIndex] = prog
	}

	// 2. Stale progress: the pilot stopped flying (crash, landed, swapped packs).
	if prog.lastGateID != 0 {
		if since := seconds(prog.lastGateTimeUs, ev.TimestampUs); since > r.MaxLapSec {
			*prog = pilotProgress{}
		}
	}

	ordered := e.orderedGatesLocked()
	if !isSF && prog.lapStartUs == 0 && len(ordered) > 0 && ordered[0].Role == domain.GateRoleStartFinish {
		return reject(
			domain.FilterOutOfOrder,
			"%s before %s (Start/Finish) - waiting for lap start",
			e.gateLabelLocked(gate.GateID),
			e.gateLabelLocked(ordered[0].GateID),
		)
	}

	// 3. Minimum lap time. At Start/Finish it is measured from the lap start; every timer also
	// enforces MinLapSec independently against its own previous accepted crossing for that pilot.
	// Safety net:
	//   - At Start/Finish on an uncompleted initial takeoff (`StartedLap` with no sector gates crossed
	//     yet), if powering on / hovering near the start gate triggered a weak bump and the pilot loops
	//     through Start/Finish `< MinLapSec` later with a clearly stronger pass spike, supersede the
	//     pre-start hover bump and re-anchor `lapStartUs` to the real pass.
	//   - On sector gates, if a weak approach ripple barely slipped through earlier and the real
	//     much-stronger gate pass arrives `< MinLapSec` later, supersede the premature bump.
	var supersededNote *domain.FilteredDetection
	var supersededID uint64
	if isSF && prog.lapStartUs != 0 {
		if lapSec := seconds(prog.lapStartUs, ev.TimestampUs); lapSec < r.MinLapSec {
			if prog.lastGateID == gate.GateID && len(prog.currentSectors) == 0 {
				if prevEv := e.findAcceptedCrossingLocked(gate.GateID, pilot.SlotIndex, prog.lapStartUs); prevEv != nil &&
					prevEv.StartedLap &&
					ev.PeakRSSIDbm < 0 && prevEv.PeakRSSIDbm < 0 &&
					ev.PeakRSSIDbm >= prevEv.PeakRSSIDbm+5.0 &&
					(ev.PassAreaDbSec >= 1.5*math.Max(0.5, prevEv.PassAreaDbSec) ||
						ev.AboveEnterAreaDbSec >= 2.0*math.Max(0.2, prevEv.AboveEnterAreaDbSec)) {
					supersededID = prevEv.EventID
					supersededNote = &domain.FilteredDetection{
						TimestampUs: prevEv.TimestampUs,
						GateID:      gate.GateID,
						SlotIndex:   pilot.SlotIndex,
						Callsign:    pilot.Callsign,
						Reason:      domain.FilterSpike,
						Detail:      fmt.Sprintf("Superseded pre-start takeoff bump %.1f dBm at %s by %.1f dBm pass", prevEv.PeakRSSIDbm, e.gateLabelLocked(gate.GateID), ev.PeakRSSIDbm),
						PeakRSSIDbm: prevEv.PeakRSSIDbm,
					}
					prog.lapStartUs = 0
					prog.lastGateID = 0
					prog.lastGateTimeUs = 0
				}
			}
			if supersededNote == nil {
				return reject(domain.FilterMinLap, "Lap would be %.2fs (min lap %.1fs)", lapSec, r.MinLapSec)
			}
		}
	}
	if supersededNote == nil && sinceSameGate >= 0 && sinceSameGate < r.MinLapSec {
		if isSF {
			return reject(domain.FilterMinLap, "Lap would be %.2fs (min lap %.1fs)", sinceSameGate, r.MinLapSec)
		}
		if prevEv := e.findAcceptedCrossingLocked(gate.GateID, pilot.SlotIndex, e.lastAcceptedUs[ckey]); prevEv != nil &&
			ev.PeakRSSIDbm < 0 && prevEv.PeakRSSIDbm < 0 &&
			ev.PeakRSSIDbm >= prevEv.PeakRSSIDbm+5.5 &&
			ev.PassAreaDbSec >= 1.5*math.Max(0.5, prevEv.PassAreaDbSec) {
			if prog.lapStartUs != 0 && prevEv.TimestampUs < prog.lapStartUs {
				supersededID = prevEv.EventID
				supersededNote = &domain.FilteredDetection{
					TimestampUs: prevEv.TimestampUs,
					GateID:      gate.GateID,
					SlotIndex:   pilot.SlotIndex,
					Callsign:    pilot.Callsign,
					Reason:      domain.FilterSpike,
					Detail:      fmt.Sprintf("Superseded premature %.1f dBm bump at %s by %.1f dBm pass", prevEv.PeakRSSIDbm, e.gateLabelLocked(gate.GateID), ev.PeakRSSIDbm),
					PeakRSSIDbm: prevEv.PeakRSSIDbm,
				}
			} else if prog.lastGateID == gate.GateID && prog.lastGateTimeUs == prevEv.TimestampUs {
				if prog.lapStartUs != 0 && prog.prevGateID != 0 && prog.prevGateID != gate.GateID && len(prog.currentSectors) > 0 {
					lastSplit := prog.currentSectors[len(prog.currentSectors)-1]
					if lastSplit.FromGateID == prog.prevGateID && lastSplit.ToGateID == gate.GateID {
						prog.currentSectors = prog.currentSectors[:len(prog.currentSectors)-1]
						sKey := sectorKey(pilot.SlotIndex, pairKey(lastSplit.FromGateID, lastSplit.ToGateID))
						if hist := e.sectorHistory[sKey]; len(hist) > 0 {
							e.sectorHistory[sKey] = hist[:len(hist)-1]
						}
					}
				}
				prog.lastGateID = prog.prevGateID
				prog.lastGateTimeUs = prog.prevGateTimeUs
				supersededID = prevEv.EventID
				supersededNote = &domain.FilteredDetection{
					TimestampUs: prevEv.TimestampUs,
					GateID:      gate.GateID,
					SlotIndex:   pilot.SlotIndex,
					Callsign:    pilot.Callsign,
					Reason:      domain.FilterSpike,
					Detail:      fmt.Sprintf("Superseded premature %.1f dBm bump at %s by %.1f dBm pass", prevEv.PeakRSSIDbm, e.gateLabelLocked(gate.GateID), ev.PeakRSSIDbm),
					PeakRSSIDbm: prevEv.PeakRSSIDbm,
				}
			}
		}
		if supersededNote == nil {
			return reject(domain.FilterMinLap, "%s again after %.2fs - quicker than min lap (%.1fs)", e.gateLabelLocked(gate.GateID), sinceSameGate, r.MinLapSec)
		}
	}

	// 4. Sequential track order: missing intermediate gates is allowed, but sector gates
	// must advance strictly forward around the loop before returning to Start/Finish.
	if !isSF && prog.lapStartUs != 0 && prog.lastGateID != 0 && len(ordered) >= 2 {
		lastIdx := indexOfGate(ordered, prog.lastGateID)
		candIdx := indexOfGate(ordered, gate.GateID)
		if lastIdx >= 0 && candIdx >= 0 && candIdx <= lastIdx {
			nextIdx := (lastIdx + 1) % len(ordered)
			return reject(
				domain.FilterOutOfOrder,
				"%s out of track order after %s (expecting %s)",
				e.gateLabelLocked(gate.GateID),
				e.gateLabelLocked(prog.lastGateID),
				e.gateLabelLocked(ordered[nextIdx].GateID),
			)
		}
	}

	// ---- accepted ----
	e.lastAcceptedUs[ckey] = ev.TimestampUs
	e.recordPassProfileLocked(pilot, gate, ev)
	out := crossingOutcome{
		note:              supersededNote,
		supersededEventID: supersededID,
	}

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
					Detail:      fmt.Sprintf("Lap took %.1fs (max %.0fs) - not counted, new lap started", lapSec, r.MaxLapSec),
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
		prog.prevGateID = 0
		prog.prevGateTimeUs = 0
	} else if prog.lastGateID != gate.GateID {
		prog.prevGateID = prog.lastGateID
		prog.prevGateTimeUs = prog.lastGateTimeUs
	}

	prog.lastGateID = gate.GateID
	prog.lastGateTimeUs = ev.TimestampUs
	return out
}

const passProfileRingCap = 8

type passCurveEntry struct {
	beamwidthMs       float64
	areaDbSec         float64
	aboveEnterAreaSec float64
	peakDbm           float32
}

type pilotPassProfile struct {
	freqMHz         uint16
	assignedTimerID uint8
	entries         [passProfileRingCap]passCurveEntry
	head            int
	count           int
}

func (e *Engine) findAcceptedCrossingLocked(gateID uint8, slotIndex int, tsUs uint64) *domain.GateCrossingEvent {
	for i := len(e.crossings) - 1; i >= 0; i-- {
		c := &e.crossings[i]
		if c.GateID == gateID && c.SlotIndex == slotIndex && c.TimestampUs == tsUs {
			return c
		}
	}
	return nil
}

func (e *Engine) removeCrossingByIDLocked(eventID uint64) {
	if eventID == 0 {
		return
	}
	for i := len(e.crossings) - 1; i >= 0; i-- {
		if e.crossings[i].EventID == eventID {
			e.crossings = append(e.crossings[:i], e.crossings[i+1:]...)
			return
		}
	}
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
//  1. Minimum crossing time (`r.MinCrossingSec`),
//  2. Minimum duration and integrated area (`dB*s`) above `enterThreshold` on weak grazing excursions,
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

	minCrossingSec := r.MinCrossingSec
	if minCrossingSec <= 0 {
		minCrossingSec = 0.12
	}
	minHoldMs := minCrossingSec * 1000.0
	if ev.HoldMs < minHoldMs {
		return fmt.Sprintf("Sharp %.0f ms spike at %s (min crossing %.0f ms)", ev.HoldMs, e.gateLabelLocked(gate.GateID), minHoldMs)
	}

	aboveEnterArea := ev.AboveEnterAreaDbSec
	if slotPos >= 0 {
		enterDbm, _ := thresholdsFor(&gate, slotPos, pilot)
		if aboveEnterArea <= 0 && ev.AboveEnterMs > 0 && ev.PeakRSSIDbm > enterDbm {
			aboveEnterArea = 0.5 * float64(ev.PeakRSSIDbm-enterDbm) * (ev.AboveEnterMs / 1000.0)
		}
		if ev.PeakRSSIDbm < enterDbm+4.5 {
			minAboveMs := math.Max(120.0, minHoldMs)
			if ev.AboveEnterMs < minAboveMs {
				return fmt.Sprintf(
					"Brief %.0f ms jitter near threshold at %s (%.1f dBm, min %.0f ms above enter)",
					ev.AboveEnterMs,
					e.gateLabelLocked(gate.GateID),
					ev.PeakRSSIDbm,
					minAboveMs,
				)
			}
			minEnterAreaDbSec := math.Max(0.18, minCrossingSec*1.5)
			if aboveEnterArea < minEnterAreaDbSec {
				return fmt.Sprintf(
					"Shallow %.2f dB*s jitter near threshold at %s (%.1f dBm, min %.2f dB*s above enter)",
					aboveEnterArea,
					e.gateLabelLocked(gate.GateID),
					ev.PeakRSSIDbm,
					minEnterAreaDbSec,
				)
			}
		}
	}

	minAreaDbSec := math.Max(1.0, minCrossingSec*12.0)
	if ev.PassAreaDbSec < minAreaDbSec {
		return fmt.Sprintf("Weak %.1f dB*s spike area at %s (%.0f ms, min %.1f dB*s)", ev.PassAreaDbSec, e.gateLabelLocked(gate.GateID), ev.HoldMs, minAreaDbSec)
	}

	if e.passProfiles != nil {
		prof := e.passProfiles[detKey{gate.GateID, pilot.SlotIndex}]
		if prof != nil && prof.freqMHz == pilot.FrequencyMHz && prof.assignedTimerID == gate.AssignedTimerID && prof.count >= 3 {
			medArea, medEnterArea, medBw, medPeak := prof.medians()
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
			if ev.PeakRSSIDbm < medPeak-9.0 &&
				(ev.PassAreaDbSec < 0.25*medArea || (medEnterArea > 0 && aboveEnterArea < 0.16*medEnterArea)) {
				return fmt.Sprintf(
					"Weak %.1f dBm jitter (%.2f dB*s above enter) does not match %s pass curve (%.1f dBm)",
					ev.PeakRSSIDbm,
					aboveEnterArea,
					pilot.Callsign,
					medPeak,
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
	aboveEnterArea := ev.AboveEnterAreaDbSec
	if aboveEnterArea <= 0 && ev.AboveEnterMs > 0 {
		if slotPos := e.pilotPosLocked(pilot.SlotIndex); slotPos >= 0 {
			enterDbm, _ := thresholdsFor(&gate, slotPos, pilot)
			if ev.PeakRSSIDbm > enterDbm {
				aboveEnterArea = 0.5 * float64(ev.PeakRSSIDbm-enterDbm) * (ev.AboveEnterMs / 1000.0)
			}
		}
	}
	entry := passCurveEntry{
		beamwidthMs:       ev.BeamwidthMs,
		areaDbSec:         ev.PassAreaDbSec,
		aboveEnterAreaSec: aboveEnterArea,
		peakDbm:           ev.PeakRSSIDbm,
	}
	if prof.count < passProfileRingCap {
		prof.entries[(prof.head+prof.count)%passProfileRingCap] = entry
		prof.count++
	} else {
		prof.entries[prof.head] = entry
		prof.head = (prof.head + 1) % passProfileRingCap
	}
}

func (p *pilotPassProfile) medians() (areaDbSec, aboveEnterAreaSec, beamwidthMs float64, peakDbm float32) {
	n := p.count
	if n == 0 {
		return 0, 0, 0, 0
	}
	areas := make([]float64, n)
	enterAreas := make([]float64, n)
	bws := make([]float64, n)
	peaks := make([]float32, n)
	for i := 0; i < n; i++ {
		ent := p.entries[(p.head+i)%passProfileRingCap]
		areas[i] = ent.areaDbSec
		enterAreas[i] = ent.aboveEnterAreaSec
		bws[i] = ent.beamwidthMs
		peaks[i] = ent.peakDbm
	}
	sort.Float64s(areas)
	sort.Float64s(enterAreas)
	sort.Float64s(bws)
	sort.Slice(peaks, func(i, j int) bool { return peaks[i] < peaks[j] })
	if n%2 == 1 {
		mid := n / 2
		return areas[mid], enterAreas[mid], bws[mid], peaks[mid]
	}
	mid := n / 2
	return 0.5 * (areas[mid-1] + areas[mid]),
		0.5 * (enterAreas[mid-1] + enterAreas[mid]),
		0.5 * (bws[mid-1] + bws[mid]),
		0.5 * (peaks[mid-1] + peaks[mid])
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
