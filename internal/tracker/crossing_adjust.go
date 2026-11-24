package tracker

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/race"
)

func absDiffUs(a, b uint64) uint64 {
	if a >= b {
		return a - b
	}
	return b - a
}

func startFinishGateIDFrom(ordered []domain.TrackGate) uint8 {
	for _, g := range ordered {
		if g.Role == domain.GateRoleStartFinish {
			return g.GateID
		}
	}
	if len(ordered) > 0 {
		return ordered[0].GateID
	}
	return 1
}

func clampCrossingTargetTimestamp(
	crossings []domain.GateCrossingEvent,
	laps []domain.LapRecord,
	orderedGates []domain.TrackGate,
	movedIdx int,
	requestedTsUs uint64,
) uint64 {
	moved := crossings[movedIdx]
	oldTsUs := moved.TimestampUs
	slotIndex := moved.SlotIndex
	sfGateID := startFinishGateIDFrom(orderedGates)
	movedIsSF := moved.IsStartFinish || moved.GateID == sfGateID

	var minUs uint64 = 1
	var maxUs uint64 = math.MaxUint64 - 1_000_000

	for i, c := range crossings {
		if i == movedIdx || c.SlotIndex != slotIndex {
			continue
		}
		cIsSF := c.IsStartFinish || c.GateID == sfGateID
		if c.GateID == moved.GateID || (movedIsSF && cIsSF) {
			if c.TimestampUs <= oldTsUs && c.TimestampUs+50_000 > minUs {
				minUs = c.TimestampUs + 50_000
			}
			if c.TimestampUs >= oldTsUs && c.TimestampUs > 50_000 && c.TimestampUs-50_000 < maxUs {
				maxUs = c.TimestampUs - 50_000
			}
		}
	}

	for _, l := range laps {
		if l.SlotIndex != slotIndex || l.CompletedAtUs == 0 {
			continue
		}
		origEnd := l.CompletedAtUs
		origStart := uint64(0)
		if l.LapTimeSec > 0 && float64(origEnd) > l.LapTimeSec*1e6 {
			origStart = uint64(math.Round(float64(origEnd) - l.LapTimeSec*1e6))
		}
		if movedIsSF {
			if absDiffUs(origEnd, oldTsUs) <= 50_000 {
				if origStart+100_000 > minUs {
					minUs = origStart + 100_000
				}
			}
			if absDiffUs(origStart, oldTsUs) <= 50_000 {
				if origEnd > 100_000 && origEnd-100_000 < maxUs {
					maxUs = origEnd - 100_000
				}
			}
		} else if oldTsUs+50_000 >= origStart && oldTsUs <= origEnd+10_000 {
			if origStart+20_000 > minUs {
				minUs = origStart + 20_000
			}
			if origEnd > 20_000 && origEnd-20_000 < maxUs {
				maxUs = origEnd - 20_000
			}
			break
		}
	}

	if !movedIsSF {
		// If on an in-progress lap after the latest Start/Finish pass, keep after that Start/Finish pass.
		var lastSfBefore uint64
		hasLaterSf := false
		for i, c := range crossings {
			if i == movedIdx || c.SlotIndex != slotIndex {
				continue
			}
			if c.IsStartFinish || c.GateID == sfGateID {
				if c.TimestampUs <= oldTsUs && c.TimestampUs > lastSfBefore {
					lastSfBefore = c.TimestampUs
				} else if c.TimestampUs > oldTsUs {
					hasLaterSf = true
				}
			}
		}
		if lastSfBefore > 0 && !hasLaterSf && lastSfBefore+20_000 > minUs {
			minUs = lastSfBefore + 20_000
		}
	}

	if minUs > maxUs {
		return requestedTsUs
	}
	if requestedTsUs < minUs {
		return minUs
	}
	if requestedTsUs > maxUs {
		return maxUs
	}
	return requestedTsUs
}

func rebuildLapSectorsFromCrossings(
	crossings []domain.GateCrossingEvent,
	orderedGates []domain.TrackGate,
	detected map[uint8]*domain.DetectedTimer,
	slotIndex int,
	sfGateID uint8,
	startUs uint64,
	endUs uint64,
) []domain.SectorSplit {
	var sectorEvents []domain.GateCrossingEvent
	lastGate := sfGateID
	lastIdx := indexOfGate(orderedGates, sfGateID)
	for _, c := range crossings {
		if c.SlotIndex != slotIndex {
			continue
		}
		if c.TimestampUs <= startUs || c.TimestampUs >= endUs {
			continue
		}
		if c.IsStartFinish || c.GateID == sfGateID {
			continue
		}
		if c.GateID == lastGate {
			continue
		}
		candIdx := indexOfGate(orderedGates, c.GateID)
		if lastIdx >= 0 && candIdx >= 0 && candIdx <= lastIdx {
			continue
		}
		sectorEvents = append(sectorEvents, c)
		lastGate = c.GateID
		if candIdx >= 0 {
			lastIdx = candIdx
		}
	}

	rebuilt := make([]domain.SectorSplit, 0, len(sectorEvents)+1)
	prevGate := sfGateID
	prevTs := startUs
	for _, sc := range sectorEvents {
		rebuilt = append(rebuilt, domain.SectorSplit{
			SectorIndex:  len(rebuilt) + 1,
			FromGateID:   prevGate,
			ToGateID:     sc.GateID,
			Label:        sectionLabelFromGates(orderedGates, detected, prevGate, sc.GateID),
			SplitSeconds: round3(seconds(prevTs, sc.TimestampUs)),
			ExitSpeedMph: sc.EstimatedSpeedMph,
			Badge:        domain.BadgeNormal,
		})
		prevGate = sc.GateID
		prevTs = sc.TimestampUs
	}
	if len(rebuilt) > 0 || len(orderedGates) <= 1 {
		rebuilt = append(rebuilt, domain.SectorSplit{
			SectorIndex:  len(rebuilt) + 1,
			FromGateID:   prevGate,
			ToGateID:     sfGateID,
			Label:        sectionLabelFromGates(orderedGates, detected, prevGate, sfGateID),
			SplitSeconds: round3(seconds(prevTs, endUs)),
			Badge:        domain.BadgeNormal,
		})
	}
	return rebuilt
}

func recalculatePilotLapsOnCrossingMove(
	laps []domain.LapRecord,
	crossings []domain.GateCrossingEvent,
	orderedGates []domain.TrackGate,
	detected map[uint8]*domain.DetectedTimer,
	slotIndex int,
	moved domain.GateCrossingEvent,
	oldTsUs uint64,
	newTsUs uint64,
) {
	sfGateID := startFinishGateIDFrom(orderedGates)
	if moved.IsStartFinish {
		sfGateID = moved.GateID
	}
	movedIsSF := moved.IsStartFinish || moved.GateID == sfGateID
	deltaMs := (int64(newTsUs) - int64(oldTsUs)) / 1000

	for i := range laps {
		l := &laps[i]
		if l.SlotIndex != slotIndex || l.CompletedAtUs == 0 {
			continue
		}
		origEnd := l.CompletedAtUs
		origStart := uint64(0)
		if l.LapTimeSec > 0 && float64(origEnd) > l.LapTimeSec*1e6 {
			origStart = uint64(math.Round(float64(origEnd) - l.LapTimeSec*1e6))
		} else if i > 0 && laps[i-1].SlotIndex == slotIndex {
			origStart = laps[i-1].CompletedAtUs
		}

		newStart := origStart
		newEnd := origEnd
		touched := false

		if movedIsSF {
			if absDiffUs(origEnd, oldTsUs) <= 50_000 {
				newEnd = newTsUs
				if l.CompletedAtMs > 0 {
					l.CompletedAtMs += deltaMs
				}
				touched = true
			}
			if absDiffUs(origStart, oldTsUs) <= 50_000 {
				newStart = newTsUs
				touched = true
			}
		} else if (oldTsUs+50_000 >= origStart && oldTsUs <= origEnd+10_000) ||
			(newTsUs+50_000 >= origStart && newTsUs <= origEnd+10_000) {
			touched = true
		}

		if !touched {
			continue
		}
		l.CompletedAtUs = newEnd
		if newEnd > newStart {
			l.LapTimeSec = round3(seconds(newStart, newEnd))
		}
		l.Sectors = rebuildLapSectorsFromCrossings(
			crossings,
			orderedGates,
			detected,
			slotIndex,
			sfGateID,
			newStart,
			newEnd,
		)
	}
}

func (e *Engine) rebuildPilotLiveProgressFromCrossingsLocked(slotIndex int, orderedGates []domain.TrackGate) {
	suffix := fmt.Sprintf(":%d", slotIndex)
	for k := range e.lastAcceptedUs {
		if strings.HasSuffix(k, suffix) {
			delete(e.lastAcceptedUs, k)
		}
	}
	sfGateID := startFinishGateIDFrom(orderedGates)
	var lastSf *domain.GateCrossingEvent
	for i := range e.crossings {
		c := &e.crossings[i]
		if c.SlotIndex != slotIndex {
			continue
		}
		e.lastAcceptedUs[detectorKey(c.GateID, slotIndex)] = c.TimestampUs
		if c.IsStartFinish || c.GateID == sfGateID {
			lastSf = c
		}
	}
	if lastSf == nil {
		delete(e.progress, slotIndex)
		return
	}

	prog := &pilotProgress{
		lapStartUs:     lastSf.TimestampUs,
		lastGateID:     lastSf.GateID,
		lastGateTimeUs: lastSf.TimestampUs,
	}
	lastIdx := indexOfGate(orderedGates, lastSf.GateID)
	for i := range e.crossings {
		c := e.crossings[i]
		if c.SlotIndex != slotIndex || c.TimestampUs <= lastSf.TimestampUs {
			continue
		}
		if c.IsStartFinish || c.GateID == sfGateID || c.GateID == prog.lastGateID {
			continue
		}
		candIdx := indexOfGate(orderedGates, c.GateID)
		if lastIdx >= 0 && candIdx >= 0 && candIdx <= lastIdx {
			continue
		}
		splitSec := round3(seconds(prog.lastGateTimeUs, c.TimestampUs))
		pKey := pairKey(prog.lastGateID, c.GateID)
		sKey := sectorKey(slotIndex, pKey)
		pBest := e.pilotBestSec[sKey]
		oBest := e.overallBestSec[pKey]
		badge := domain.BadgeNormal
		var delta float64
		if pBest > 0 {
			delta = round3(splitSec - pBest)
		}
		switch {
		case oBest == 0 || splitSec <= oBest+0.0005:
			badge = domain.BadgeOverallBest
		case pBest == 0 || splitSec <= pBest+0.0005:
			badge = domain.BadgePersonalBest
		case pBest > 0 && splitSec > pBest*1.10:
			badge = domain.BadgeOffPace
		}
		prog.currentSectors = append(prog.currentSectors, domain.SectorSplit{
			SectorIndex:    len(prog.currentSectors) + 1,
			FromGateID:     prog.lastGateID,
			ToGateID:       c.GateID,
			Label:          sectionLabelFromGates(orderedGates, e.detected, prog.lastGateID, c.GateID),
			SplitSeconds:   splitSec,
			DeltaToBestSec: delta,
			ExitSpeedMph:   c.EstimatedSpeedMph,
			Badge:          badge,
		})
		prog.prevGateID = prog.lastGateID
		prog.prevGateTimeUs = prog.lastGateTimeUs
		prog.lastGateID = c.GateID
		prog.lastGateTimeUs = c.TimestampUs
		if candIdx >= 0 {
			lastIdx = candIdx
		}
	}
	e.progress[slotIndex] = prog
}

// AdjustPracticeSessionCrossing moves a recorded gate crossing in a Practice session to
// `newTimestampUs` (clamped within neighboring pass boundaries) and recalculates all affected
// lap durations, sector splits, personal/overall best badges, and session summaries.
func (e *Engine) AdjustPracticeSessionCrossing(
	sessionID string,
	eventID uint64,
	newTimestampUs uint64,
	peakRSSIDbm *float32,
) (domain.PracticeManagerState, error) {
	if eventID == 0 || newTimestampUs == 0 {
		return e.PracticeSnapshot(), fmt.Errorf("eventId and timestampUs must be positive")
	}

	e.mu.Lock()
	targetID := strings.TrimSpace(sessionID)
	if targetID == "" || strings.EqualFold(targetID, "current") {
		targetID = e.practiceState.SelectedSessionID
		if targetID == "" {
			targetID = e.practiceState.ActiveSessionID
		}
	}
	target := e.findPracticeSessionLocked(targetID)
	if target == nil {
		snap := clonePracticeManagerState(e.practiceState)
		e.mu.Unlock()
		return snap, fmt.Errorf("practice session %q not found", sessionID)
	}

	isActive := target.Active && e.practiceState.ActiveSessionID == target.SessionID && !e.isLiveRaceHeatActiveLocked()
	if isActive && len(e.crossings) > len(target.Crossings) {
		e.syncActivePracticeRecordsLocked()
	}

	movedIdx := -1
	for i := range target.Crossings {
		if target.Crossings[i].EventID == eventID {
			movedIdx = i
			break
		}
	}
	if movedIdx < 0 {
		snap := clonePracticeManagerState(e.practiceState)
		e.mu.Unlock()
		return snap, fmt.Errorf("crossing %d not found in practice session %q", eventID, target.SessionID)
	}

	var orderedGates []domain.TrackGate
	if target.TrackInitialized || len(target.TrackSnapshot) > 0 {
		orderedGates = append([]domain.TrackGate(nil), target.TrackSnapshot...)
		sort.SliceStable(orderedGates, func(a, b int) bool {
			return orderedGates[a].TrackOrder < orderedGates[b].TrackOrder
		})
	} else {
		orderedGates = e.orderedGatesLocked()
	}

	movedCopy := target.Crossings[movedIdx]
	oldTsUs := movedCopy.TimestampUs
	clampedTsUs := clampCrossingTargetTimestamp(target.Crossings, target.Laps, orderedGates, movedIdx, newTimestampUs)

	target.Crossings[movedIdx].TimestampUs = clampedTsUs
	if peakRSSIDbm != nil && !math.IsNaN(float64(*peakRSSIDbm)) && !math.IsInf(float64(*peakRSSIDbm), 0) {
		target.Crossings[movedIdx].PeakRSSIDbm = *peakRSSIDbm
	}
	sort.SliceStable(target.Crossings, func(a, b int) bool {
		return target.Crossings[a].TimestampUs < target.Crossings[b].TimestampUs
	})

	recalculatePilotLapsOnCrossingMove(
		target.Laps,
		target.Crossings,
		orderedGates,
		e.detected,
		movedCopy.SlotIndex,
		movedCopy,
		oldTsUs,
		clampedTsUs,
	)
	e.recomputePracticeSessionLapsLocked(target)
	target.UpdatedAt = time.Now().UTC().Format(time.RFC3339)

	if isActive {
		e.crossings = append([]domain.GateCrossingEvent(nil), target.Crossings...)
		e.syncActivePracticeLapsLocked(target)
		e.rebuildPilotLiveProgressFromCrossingsLocked(movedCopy.SlotIndex, orderedGates)
	}
	target.Summaries = e.computePracticeSessionSummariesLocked(target)

	practiceSnap := clonePracticeManagerState(e.practiceState)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	e.notifyPracticeUpdated(practiceSnap, subs)
	return practiceSnap, nil
}

// AdjustEngineCrossing moves a crossing directly on the root engine buffers (used when no
// Practice sessions are initialized or during live heat telemetry).
func (e *Engine) AdjustEngineCrossing(eventID uint64, newTimestampUs uint64, peakRSSIDbm *float32) error {
	if eventID == 0 || newTimestampUs == 0 {
		return fmt.Errorf("eventId and timestampUs must be positive")
	}

	e.mu.Lock()
	movedIdx := -1
	for i := range e.crossings {
		if e.crossings[i].EventID == eventID {
			movedIdx = i
			break
		}
	}
	if movedIdx < 0 {
		e.mu.Unlock()
		return fmt.Errorf("crossing %d not found", eventID)
	}

	orderedGates := e.orderedGatesLocked()
	movedCopy := e.crossings[movedIdx]
	oldTsUs := movedCopy.TimestampUs
	clampedTsUs := clampCrossingTargetTimestamp(e.crossings, e.laps, orderedGates, movedIdx, newTimestampUs)

	e.crossings[movedIdx].TimestampUs = clampedTsUs
	if peakRSSIDbm != nil && !math.IsNaN(float64(*peakRSSIDbm)) && !math.IsInf(float64(*peakRSSIDbm), 0) {
		e.crossings[movedIdx].PeakRSSIDbm = *peakRSSIDbm
	}
	sort.SliceStable(e.crossings, func(a, b int) bool {
		return e.crossings[a].TimestampUs < e.crossings[b].TimestampUs
	})

	recalculatePilotLapsOnCrossingMove(
		e.laps,
		e.crossings,
		orderedGates,
		e.detected,
		movedCopy.SlotIndex,
		movedCopy,
		oldTsUs,
		clampedTsUs,
	)

	tmpSess := domain.PracticeSession{Laps: e.laps}
	e.recomputePracticeSessionLapsLocked(&tmpSess)
	e.laps = tmpSess.Laps

	e.overallBestSec = make(map[string]float64)
	e.pilotBestSec = make(map[string]float64)
	e.sectorHistory = make(map[string][]domain.SectorSplit)
	for _, lap := range e.laps {
		if lap.Invalidated {
			continue
		}
		for _, split := range lap.Sectors {
			pKey := pairKey(split.FromGateID, split.ToGateID)
			sKey := sectorKey(lap.SlotIndex, pKey)
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
	e.rebuildPilotLiveProgressFromCrossingsLocked(movedCopy.SlotIndex, orderedGates)
	e.mu.Unlock()
	return nil
}

// AdjustRaceCrossing adjusts a gate crossing on the Race Signals chart and, if it corresponds to
// a Start/Finish crossing in an active or completed heat of `raceID`, updates the seat's heat
// crossings and recomputes official heat standings.
func (e *Engine) AdjustRaceCrossing(raceID string, eventID uint64, newTimestampUs uint64, peakRSSIDbm *float32) error {
	if eventID == 0 || newTimestampUs == 0 {
		return fmt.Errorf("eventId and timestampUs must be positive")
	}

	e.mu.Lock()
	swap, err := e.enterTargetRaceLocked(raceID)
	if err != nil {
		e.mu.Unlock()
		return err
	}

	movedIdx := -1
	for i := range e.crossings {
		if e.crossings[i].EventID == eventID {
			movedIdx = i
			break
		}
	}
	var movedCopy domain.GateCrossingEvent
	var oldTsUs uint64
	clampedTsUs := newTimestampUs
	orderedGates := e.orderedGatesLocked()

	if movedIdx >= 0 {
		movedCopy = e.crossings[movedIdx]
		oldTsUs = movedCopy.TimestampUs
		clampedTsUs = clampCrossingTargetTimestamp(e.crossings, e.laps, orderedGates, movedIdx, newTimestampUs)
		e.crossings[movedIdx].TimestampUs = clampedTsUs
		if peakRSSIDbm != nil && !math.IsNaN(float64(*peakRSSIDbm)) && !math.IsInf(float64(*peakRSSIDbm), 0) {
			e.crossings[movedIdx].PeakRSSIDbm = *peakRSSIDbm
		}
		sort.SliceStable(e.crossings, func(a, b int) bool {
			return e.crossings[a].TimestampUs < e.crossings[b].TimestampUs
		})
		recalculatePilotLapsOnCrossingMove(
			e.laps,
			e.crossings,
			orderedGates,
			e.detected,
			movedCopy.SlotIndex,
			movedCopy,
			oldTsUs,
			clampedTsUs,
		)
		tmpSess := domain.PracticeSession{Laps: e.laps}
		e.recomputePracticeSessionLapsLocked(&tmpSess)
		e.laps = tmpSess.Laps
		e.rebuildPilotLiveProgressFromCrossingsLocked(movedCopy.SlotIndex, orderedGates)
	}

	sfGateID := startFinishGateIDFrom(orderedGates)
	heatChanged := false
	if movedIdx < 0 || movedCopy.IsStartFinish || movedCopy.GateID == sfGateID {
		for hi := len(e.raceState.Heats) - 1; hi >= 0; hi-- {
			h := &e.raceState.Heats[hi]
			for si := range h.Seats {
				seat := &h.Seats[si]
				if movedIdx >= 0 && seat.PilotSlotIndex != movedCopy.SlotIndex {
					continue
				}
				for ci := range seat.Crossings {
					hc := &seat.Crossings[ci]
					if hc.CrossingID == eventID || (oldTsUs > 0 && absDiffUs(hc.TimestampUs, oldTsUs) <= 50_000) {
						hc.TimestampUs = clampedTsUs
						if peakRSSIDbm != nil {
							hc.PeakRSSIDbm = *peakRSSIDbm
						}
						hc.Manual = true
						sort.SliceStable(seat.Crossings, func(a, b int) bool {
							return seat.Crossings[a].TimestampUs < seat.Crossings[b].TimestampUs
						})
						race.RecomputeHeat(h, e.raceState.Config.QualifyingMetric)
						heatChanged = true
						break
					}
				}
				if heatChanged {
					break
				}
			}
			if heatChanged {
				break
			}
		}
	}

	if movedIdx < 0 && !heatChanged {
		_ = e.exitTargetRaceLocked(&swap, false)
		e.mu.Unlock()
		return fmt.Errorf("crossing %d not found in race %q", eventID, raceID)
	}

	if heatChanged {
		e.resolveActiveTournamentLocked()
	}
	if swap.swapped {
		_ = e.exitTargetRaceLocked(&swap, heatChanged)
	} else if heatChanged && e.raceState.RaceID != "" {
		e.syncActiveRaceToEventLocked()
	}
	raceSnap := cloneRaceState(e.raceState)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	if heatChanged {
		e.notifyRaceUpdated(raceSnap, nil, subs)
	}
	return nil
}
