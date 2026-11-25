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

func gateFromOrdered(ordered []domain.TrackGate, gateID uint8) domain.TrackGate {
	for _, g := range ordered {
		if g.GateID == gateID {
			return g
		}
	}
	return domain.TrackGate{GateID: gateID, Role: domain.GateRoleSectorGate}
}

func gateLabelFromOrdered(ordered []domain.TrackGate, detected map[uint8]*domain.DetectedTimer, gateID uint8) string {
	for i, g := range ordered {
		if g.GateID == gateID {
			if n := strings.TrimSpace(g.Name); n != "" {
				return n
			}
			if g.AssignedTimerID > 0 && detected != nil {
				if d, ok := detected[g.AssignedTimerID]; ok && strings.TrimSpace(d.TimerLabel) != "" {
					return strings.TrimSpace(d.TimerLabel)
				}
			}
			if n := strings.TrimSpace(g.TimerLabel); n != "" {
				return n
			}
			return fmt.Sprintf("Gate %d", i+1)
		}
	}
	return fmt.Sprintf("Gate %d", gateID)
}

func sortCrossingsChronological(list []domain.GateCrossingEvent) {
	sort.SliceStable(list, func(a, b int) bool {
		if list[a].TimestampUs != list[b].TimestampUs {
			return list[a].TimestampUs < list[b].TimestampUs
		}
		return list[a].EventID < list[b].EventID
	})
}

// replayPilotCrossingsLocked evaluates all crossings for `slotIndex` in chronological order
// against `orderedGates` and `globalRules` (including per-gate and per-pilot overrides),
// marking rule-violating crossings (`MIN_LAP`, `OUT_OF_ORDER`) via `InvalidReason`/`InvalidDetail`
// while rebuilding that pilot's counted laps and section splits from valid crossings.
func (e *Engine) replayPilotCrossingsLocked(
	allCrossings []domain.GateCrossingEvent,
	prevAllLaps []domain.LapRecord,
	orderedGates []domain.TrackGate,
	detected map[uint8]*domain.DetectedTimer,
	globalRules domain.TimingRules,
	slotIndex int,
	defaultCallsign string,
) ([]domain.GateCrossingEvent, []domain.LapRecord) {
	return e.replayPilotCrossingsWithBreaksLocked(
		allCrossings,
		prevAllLaps,
		orderedGates,
		detected,
		globalRules,
		slotIndex,
		defaultCallsign,
		nil,
	)
}

func (e *Engine) replayPilotCrossingsWithBreaksLocked(
	allCrossings []domain.GateCrossingEvent,
	prevAllLaps []domain.LapRecord,
	orderedGates []domain.TrackGate,
	detected map[uint8]*domain.DetectedTimer,
	globalRules domain.TimingRules,
	slotIndex int,
	defaultCallsign string,
	breaks []domain.PracticeBreakMark,
) ([]domain.GateCrossingEvent, []domain.LapRecord) {
	var pilotBreaks []domain.PracticeBreakMark
	for _, b := range breaks {
		if b.SlotIndex == slotIndex && b.TimestampUs > 0 {
			pilotBreaks = append(pilotBreaks, b)
		}
	}
	sort.Slice(pilotBreaks, func(a, b int) bool {
		return pilotBreaks[a].TimestampUs < pilotBreaks[b].TimestampUs
	})
	breakIdx := 0
	otherCrossings := make([]domain.GateCrossingEvent, 0, len(allCrossings))
	pilotCrossings := make([]domain.GateCrossingEvent, 0, len(allCrossings))
	for _, c := range allCrossings {
		if c.SlotIndex == slotIndex {
			if c.Callsign != "" && defaultCallsign == "" {
				defaultCallsign = c.Callsign
			}
			pilotCrossings = append(pilotCrossings, c)
		} else {
			otherCrossings = append(otherCrossings, c)
		}
	}
	sortCrossingsChronological(pilotCrossings)

	e.syncPracticeIDHighWaterLocked(e.practiceState.Sessions)
	otherLaps := make([]domain.LapRecord, 0, len(prevAllLaps))
	prevPilotLaps := make([]domain.LapRecord, 0, len(prevAllLaps))
	usedLapIDs := make(map[uint64]bool, len(prevAllLaps)+4)
	for _, l := range prevAllLaps {
		if l.LapID > e.nextLapID {
			e.nextLapID = l.LapID
		}
		if l.SlotIndex == slotIndex {
			if l.Callsign != "" && defaultCallsign == "" {
				defaultCallsign = l.Callsign
			}
			prevPilotLaps = append(prevPilotLaps, l)
		} else {
			if l.LapID > 0 {
				usedLapIDs[l.LapID] = true
			}
			otherLaps = append(otherLaps, l)
		}
	}
	if defaultCallsign == "" {
		for _, p := range e.pilots {
			if p.SlotIndex == slotIndex && p.Callsign != "" {
				defaultCallsign = p.Callsign
				break
			}
		}
	}
	if defaultCallsign == "" {
		defaultCallsign = fmt.Sprintf("P%d", slotIndex)
	}

	usedPrevLap := make([]bool, len(prevPilotLaps))
	matchPrevLap := func(completedAtUs uint64) *domain.LapRecord {
		bestIdx := -1
		var bestDiff uint64 = math.MaxUint64
		for i := range prevPilotLaps {
			if usedPrevLap[i] {
				continue
			}
			d := absDiffUs(prevPilotLaps[i].CompletedAtUs, completedAtUs)
			if d <= 50_000 && d < bestDiff {
				bestDiff = d
				bestIdx = i
			}
		}
		if bestIdx >= 0 {
			usedPrevLap[bestIdx] = true
			return &prevPilotLaps[bestIdx]
		}
		return nil
	}

	sfGateID := startFinishGateIDFrom(orderedGates)
	hasSFGate := len(orderedGates) > 0 && orderedGates[0].Role == domain.GateRoleStartFinish
	lastAcceptedGateUs := make(map[uint8]uint64, len(orderedGates))
	var prog pilotProgress
	rebuiltPilotLaps := make([]domain.LapRecord, 0, len(prevPilotLaps)+1)
	lastAssignedLapNum := 0

	for i := range pilotCrossings {
		c := &pilotCrossings[i]
		gate := gateFromOrdered(orderedGates, c.GateID)
		r := gate.RulesForPilot(globalRules, slotIndex)
		isSF := gate.Role == domain.GateRoleStartFinish || c.GateID == sfGateID
		c.IsStartFinish = isSF
		c.StartedLap = false
		c.InvalidReason = ""
		c.InvalidDetail = ""
		if c.Callsign == "" {
			c.Callsign = defaultCallsign
		}
		gateLbl := gateLabelFromOrdered(orderedGates, detected, c.GateID)
		if c.GateName == "" {
			c.GateName = gateLbl
		}

		// 0. Manual pilot break marker: resets lap progress & per-gate lockout across the break boundary.
		advancedBreak := false
		for breakIdx < len(pilotBreaks) && pilotBreaks[breakIdx].TimestampUs <= c.TimestampUs {
			breakIdx++
			advancedBreak = true
		}
		if advancedBreak {
			prog = pilotProgress{}
			clear(lastAcceptedGateUs)
		}

		// 1. Stale progress: pilot landed/stopped for longer than MaxLapSec.
		if prog.lastGateID != 0 && seconds(prog.lastGateTimeUs, c.TimestampUs) > r.MaxLapSec {
			prog = pilotProgress{}
		}

		// 2. Sector gate before Start/Finish begins the first lap.
		if !isSF && prog.lapStartUs == 0 && hasSFGate {
			sfLbl := gateLabelFromOrdered(orderedGates, detected, orderedGates[0].GateID)
			c.InvalidReason = domain.FilterOutOfOrder
			c.InvalidDetail = fmt.Sprintf("%s before %s (Start/Finish) - waiting for lap start", gateLbl, sfLbl)
			continue
		}

		// 3. Minimum lap time on Start/Finish and per-timer independent MinLapSec.
		if isSF && prog.lapStartUs != 0 {
			if lapSec := seconds(prog.lapStartUs, c.TimestampUs); lapSec < r.MinLapSec {
				c.InvalidReason = domain.FilterMinLap
				c.InvalidDetail = fmt.Sprintf("Lap would be %.2fs (min lap %.1fs)", lapSec, r.MinLapSec)
				continue
			}
		}
		if prevUs, ok := lastAcceptedGateUs[c.GateID]; ok {
			if sinceSame := seconds(prevUs, c.TimestampUs); sinceSame < r.MinLapSec {
				c.InvalidReason = domain.FilterMinLap
				if isSF {
					c.InvalidDetail = fmt.Sprintf("Lap would be %.2fs (min lap %.1fs)", sinceSame, r.MinLapSec)
				} else {
					c.InvalidDetail = fmt.Sprintf("%s again after %.2fs - quicker than min lap (%.1fs)", gateLbl, sinceSame, r.MinLapSec)
				}
				continue
			}
		}

		// 4. Sequential track order around the loop.
		if !isSF && prog.lapStartUs != 0 && prog.lastGateID != 0 && len(orderedGates) >= 2 {
			lastIdx := indexOfGate(orderedGates, prog.lastGateID)
			candIdx := indexOfGate(orderedGates, c.GateID)
			if lastIdx >= 0 && candIdx >= 0 && candIdx <= lastIdx {
				nextIdx := (lastIdx + 1) % len(orderedGates)
				lastLbl := gateLabelFromOrdered(orderedGates, detected, prog.lastGateID)
				nextLbl := gateLabelFromOrdered(orderedGates, detected, orderedGates[nextIdx].GateID)
				c.InvalidReason = domain.FilterOutOfOrder
				c.InvalidDetail = fmt.Sprintf("%s out of track order after %s (expecting %s)", gateLbl, lastLbl, nextLbl)
				continue
			}
		}

		// ---- Valid crossing ----
		lastAcceptedGateUs[c.GateID] = c.TimestampUs
		if prog.lapStartUs != 0 && prog.lastGateID != 0 && prog.lastGateID != c.GateID {
			prog.currentSectors = append(prog.currentSectors, domain.SectorSplit{
				SectorIndex:  len(prog.currentSectors) + 1,
				FromGateID:   prog.lastGateID,
				ToGateID:     c.GateID,
				Label:        sectionLabelFromGates(orderedGates, detected, prog.lastGateID, c.GateID),
				SplitSeconds: round3(seconds(prog.lastGateTimeUs, c.TimestampUs)),
				ExitSpeedMph: c.EstimatedSpeedMph,
				Badge:        domain.BadgeNormal,
			})
		}

		if isSF {
			if prog.lapStartUs != 0 {
				lapSec := seconds(prog.lapStartUs, c.TimestampUs)
				if lapSec > r.MaxLapSec {
					c.StartedLap = true
				} else {
					if len(prog.currentSectors) == 0 && prog.lastGateID == c.GateID {
						prog.currentSectors = append(prog.currentSectors, domain.SectorSplit{
							SectorIndex:  1,
							FromGateID:   c.GateID,
							ToGateID:     c.GateID,
							Label:        sectionLabelFromGates(orderedGates, detected, c.GateID, c.GateID),
							SplitSeconds: round3(lapSec),
							ExitSpeedMph: c.EstimatedSpeedMph,
							Badge:        domain.BadgeNormal,
						})
					}
					prevMatch := matchPrevLap(c.TimestampUs)
					var lapID uint64
					var completedMs int64
					var invalidated bool
					lapNum := lastAssignedLapNum + 1
					if prevMatch != nil {
						lapID = prevMatch.LapID
						completedMs = prevMatch.CompletedAtMs
						invalidated = prevMatch.Invalidated
						if prevMatch.LapNumber > lastAssignedLapNum {
							lapNum = prevMatch.LapNumber
						}
					} else {
						completedMs = e.wallClockMsForTimestampLocked(c.TimestampUs)
					}
					if lapID == 0 || usedLapIDs[lapID] {
						e.nextLapID++
						lapID = e.nextLapID
					}
					usedLapIDs[lapID] = true
					lastAssignedLapNum = lapNum
					rebuiltPilotLaps = append(rebuiltPilotLaps, domain.LapRecord{
						LapID:         lapID,
						SlotIndex:     slotIndex,
						Callsign:      defaultCallsign,
						LapNumber:     lapNum,
						LapTimeSec:    round3(lapSec),
						Sectors:       append([]domain.SectorSplit(nil), prog.currentSectors...),
						CompletedAtUs: c.TimestampUs,
						CompletedAtMs: completedMs,
						Invalidated:   invalidated,
					})
				}
			} else {
				c.StartedLap = true
			}
			prog.lapStartUs = c.TimestampUs
			prog.currentSectors = nil
			prog.prevGateID = 0
			prog.prevGateTimeUs = 0
		} else if prog.lastGateID != c.GateID {
			prog.prevGateID = prog.lastGateID
			prog.prevGateTimeUs = prog.lastGateTimeUs
		}

		prog.lastGateID = c.GateID
		prog.lastGateTimeUs = c.TimestampUs
	}

	mergedCrossings := make([]domain.GateCrossingEvent, 0, len(otherCrossings)+len(pilotCrossings))
	mergedCrossings = append(mergedCrossings, otherCrossings...)
	mergedCrossings = append(mergedCrossings, pilotCrossings...)
	sortCrossingsChronological(mergedCrossings)

	mergedLaps := make([]domain.LapRecord, 0, len(otherLaps)+len(rebuiltPilotLaps))
	mergedLaps = append(mergedLaps, otherLaps...)
	mergedLaps = append(mergedLaps, rebuiltPilotLaps...)
	sort.SliceStable(mergedLaps, func(a, b int) bool {
		if mergedLaps[a].CompletedAtUs != mergedLaps[b].CompletedAtUs {
			return mergedLaps[a].CompletedAtUs < mergedLaps[b].CompletedAtUs
		}
		return mergedLaps[a].LapID < mergedLaps[b].LapID
	})

	return mergedCrossings, mergedLaps
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
		if c.SlotIndex != slotIndex || c.InvalidReason != "" {
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
	if !e.isLiveRaceHeatActiveLocked() && e.practiceState.ActiveSessionID != "" {
		if activeSess := e.findPracticeSessionLocked(e.practiceState.ActiveSessionID); activeSess != nil {
			for _, b := range activeSess.Breaks {
				if b.SlotIndex == slotIndex && b.TimestampUs > lastSf.TimestampUs {
					delete(e.progress, slotIndex)
					return
				}
			}
		}
	}

	prog := &pilotProgress{
		lapStartUs:     lastSf.TimestampUs,
		lastGateID:     lastSf.GateID,
		lastGateTimeUs: lastSf.TimestampUs,
	}
	lastIdx := indexOfGate(orderedGates, lastSf.GateID)
	for i := range e.crossings {
		c := e.crossings[i]
		if c.SlotIndex != slotIndex || c.InvalidReason != "" || c.TimestampUs <= lastSf.TimestampUs {
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

func (e *Engine) orderedGatesForPracticeSessionLocked(target *domain.PracticeSession) []domain.TrackGate {
	if target.TrackInitialized || len(target.TrackSnapshot) > 0 {
		orderedGates := append([]domain.TrackGate(nil), target.TrackSnapshot...)
		sort.SliceStable(orderedGates, func(a, b int) bool {
			return orderedGates[a].TrackOrder < orderedGates[b].TrackOrder
		})
		return orderedGates
	}
	return e.orderedGatesLocked()
}

func (e *Engine) rebuildRootSectorBestsLocked() {
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
}

func (e *Engine) newManualCrossingEventLocked(
	orderedGates []domain.TrackGate,
	gateID uint8,
	slotIndex int,
	timestampUs uint64,
	peakRSSIDbm *float32,
	callsignOverride string,
) (domain.GateCrossingEvent, error) {
	if gateID == 0 || slotIndex <= 0 || timestampUs == 0 {
		return domain.GateCrossingEvent{}, fmt.Errorf("gateId, slotIndex, and timestampUs must be positive")
	}
	foundGate := false
	var gate domain.TrackGate
	for _, g := range orderedGates {
		if g.GateID == gateID {
			gate = g
			foundGate = true
			break
		}
	}
	if !foundGate {
		return domain.GateCrossingEvent{}, ErrUnknownGate
	}
	callsign := strings.TrimSpace(callsignOverride)
	var freq uint16
	for _, p := range e.pilots {
		if p.SlotIndex == slotIndex {
			if callsign == "" {
				callsign = p.Callsign
			}
			freq = p.FrequencyMHz
			break
		}
	}
	if callsign == "" {
		callsign = fmt.Sprintf("P%d", slotIndex)
	}
	var peak float32 = -55.0
	if peakRSSIDbm != nil && !math.IsNaN(float64(*peakRSSIDbm)) && !math.IsInf(float64(*peakRSSIDbm), 0) {
		peak = *peakRSSIDbm
	}
	e.nextEventID++
	if e.passingNumbers == nil {
		e.passingNumbers = make(map[uint8]uint32)
	}
	e.passingNumbers[gateID]++
	sfGateID := startFinishGateIDFrom(orderedGates)
	return domain.GateCrossingEvent{
		EventID:       e.nextEventID,
		GateID:        gateID,
		GateName:      gateLabelFromOrdered(orderedGates, e.detected, gateID),
		IsStartFinish: gate.Role == domain.GateRoleStartFinish || gateID == sfGateID,
		SlotIndex:     slotIndex,
		Callsign:      callsign,
		FrequencyMHz:  freq,
		TimestampUs:   timestampUs,
		PeakRSSIDbm:   peak,
		PassingNumber: e.passingNumbers[gateID],
		Manual:        true,
	}, nil
}

// AddPracticeSessionCrossing inserts a manual crossing on `gateID` for `slotIndex` at `timestampUs`
// and replays the pilot's session crossings against timing and sequential track-order rules.
func (e *Engine) AddPracticeSessionCrossing(
	sessionID string,
	gateID uint8,
	slotIndex int,
	timestampUs uint64,
	peakRSSIDbm *float32,
) (domain.PracticeManagerState, uint64, error) {
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
		return snap, 0, fmt.Errorf("practice session %q not found", sessionID)
	}

	isActive := target.Active && e.practiceState.ActiveSessionID == target.SessionID && !e.isLiveRaceHeatActiveLocked()
	if isActive && len(e.crossings) > len(target.Crossings) {
		e.syncActivePracticeRecordsLocked()
	}

	orderedGates := e.orderedGatesForPracticeSessionLocked(target)
	var callsign string
	for _, sp := range target.Pilots {
		if sp.SlotIndex == slotIndex && sp.Callsign != "" {
			callsign = sp.Callsign
			break
		}
	}
	ev, err := e.newManualCrossingEventLocked(orderedGates, gateID, slotIndex, timestampUs, peakRSSIDbm, callsign)
	if err != nil {
		snap := clonePracticeManagerState(e.practiceState)
		e.mu.Unlock()
		return snap, 0, err
	}
	for _, c := range target.Crossings {
		if c.EventID >= ev.EventID {
			ev.EventID = c.EventID + 1
			e.nextEventID = ev.EventID
		}
	}

	target.Crossings = append(target.Crossings, ev)
	// Remove any matching negative mark within +-150 ms if user re-added a crossing here
	if len(target.ManualDeletedCrossings) > 0 {
		keptNeg := target.ManualDeletedCrossings[:0]
		for _, m := range target.ManualDeletedCrossings {
			if m.GateID == gateID && m.SlotIndex == slotIndex && absDiffUs(m.TimestampUs, timestampUs) <= 150_000 {
				continue
			}
			keptNeg = append(keptNeg, m)
		}
		target.ManualDeletedCrossings = keptNeg
	}
	// Prune any stale live-DSP filtered hint (e.g. TOO_SHORT / SPIKE) on this gate within +-1.5s
	if len(target.Filtered) > 0 {
		keptFilt := target.Filtered[:0]
		for _, f := range target.Filtered {
			if f.GateID == gateID && f.SlotIndex == slotIndex && absDiffUs(f.TimestampUs, timestampUs) <= 1_500_000 {
				continue
			}
			keptFilt = append(keptFilt, f)
		}
		target.Filtered = keptFilt
	}
	if isActive && len(e.filtered) > 0 {
		keptRootFilt := e.filtered[:0]
		for _, f := range e.filtered {
			if f.GateID == gateID && f.SlotIndex == slotIndex && absDiffUs(f.TimestampUs, timestampUs) <= 1_500_000 {
				continue
			}
			keptRootFilt = append(keptRootFilt, f)
		}
		e.filtered = keptRootFilt
	}
	target.Crossings, target.Laps = e.replayPilotCrossingsWithBreaksLocked(
		target.Crossings,
		target.Laps,
		orderedGates,
		e.detected,
		e.rules,
		slotIndex,
		ev.Callsign,
		target.Breaks,
	)
	e.recomputePracticeSessionLapsLocked(target)
	target.UpdatedAt = time.Now().UTC().Format(time.RFC3339)

	var mlChanged bool
	var mlSnap domain.MLStatus
	if isActive {
		e.crossings = append([]domain.GateCrossingEvent(nil), target.Crossings...)
		e.syncActivePracticeLapsLocked(target)
		e.rebuildPilotLiveProgressFromCrossingsLocked(slotIndex, orderedGates)
		if e.recomputeLiveGateTunesLocked(slotIndex, target.ManualDeletedCrossings) {
			mlChanged = true
			mlSnap = e.buildMLStatusLocked()
		}
	}
	target.Summaries = e.computePracticeSessionSummariesLocked(target)

	practiceSnap := clonePracticeManagerState(e.practiceState)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	e.notifyPracticeUpdated(practiceSnap, subs)
	if mlChanged {
		e.notifyMLUpdated(mlSnap, subs)
	}
	return practiceSnap, ev.EventID, nil
}

// AdjustPracticeSessionCrossing moves a recorded gate crossing in a Practice session to
// `newTimestampUs` and replays all crossings for that pilot against timing and track-order rules.
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

	orderedGates := e.orderedGatesForPracticeSessionLocked(target)
	slotIndex := target.Crossings[movedIdx].SlotIndex
	callsign := target.Crossings[movedIdx].Callsign
	target.Crossings[movedIdx].TimestampUs = newTimestampUs
	target.Crossings[movedIdx].Manual = true
	if peakRSSIDbm != nil && !math.IsNaN(float64(*peakRSSIDbm)) && !math.IsInf(float64(*peakRSSIDbm), 0) {
		target.Crossings[movedIdx].PeakRSSIDbm = *peakRSSIDbm
	}

	target.Crossings, target.Laps = e.replayPilotCrossingsWithBreaksLocked(
		target.Crossings,
		target.Laps,
		orderedGates,
		e.detected,
		e.rules,
		slotIndex,
		callsign,
		target.Breaks,
	)
	e.recomputePracticeSessionLapsLocked(target)
	target.UpdatedAt = time.Now().UTC().Format(time.RFC3339)

	if isActive {
		e.crossings = append([]domain.GateCrossingEvent(nil), target.Crossings...)
		e.syncActivePracticeLapsLocked(target)
		e.rebuildPilotLiveProgressFromCrossingsLocked(slotIndex, orderedGates)
	}
	target.Summaries = e.computePracticeSessionSummariesLocked(target)

	practiceSnap := clonePracticeManagerState(e.practiceState)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	e.notifyPracticeUpdated(practiceSnap, subs)
	return practiceSnap, nil
}

// DeletePracticeSessionCrossing removes crossing `eventID` from a Practice session and replays
// the pilot's remaining crossings to recompute valid/invalid crossings, laps, and splits.
func (e *Engine) DeletePracticeSessionCrossing(
	sessionID string,
	eventID uint64,
) (domain.PracticeManagerState, error) {
	if eventID == 0 {
		return e.PracticeSnapshot(), fmt.Errorf("eventId must be positive")
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

	delIdx := -1
	for i := range target.Crossings {
		if target.Crossings[i].EventID == eventID {
			delIdx = i
			break
		}
	}
	if delIdx < 0 {
		snap := clonePracticeManagerState(e.practiceState)
		e.mu.Unlock()
		return snap, fmt.Errorf("crossing %d not found in practice session %q", eventID, target.SessionID)
	}

	removed := target.Crossings[delIdx]
	target.Crossings = append(target.Crossings[:delIdx], target.Crossings[delIdx+1:]...)
	// Record non-manual false crossing deletions as verified hard-negative windows for ML training
	if !removed.Manual {
		dup := false
		for _, m := range target.ManualDeletedCrossings {
			if m.GateID == removed.GateID && m.SlotIndex == removed.SlotIndex && absDiffUs(m.TimestampUs, removed.TimestampUs) <= 150_000 {
				dup = true
				break
			}
		}
		if !dup {
			target.ManualDeletedCrossings = append(target.ManualDeletedCrossings, domain.ManualDeletedCrossing{
				GateID:      removed.GateID,
				SlotIndex:   removed.SlotIndex,
				TimestampUs: removed.TimestampUs,
				PeakRSSIDbm: removed.PeakRSSIDbm,
			})
		}
	}
	orderedGates := e.orderedGatesForPracticeSessionLocked(target)
	target.Crossings, target.Laps = e.replayPilotCrossingsWithBreaksLocked(
		target.Crossings,
		target.Laps,
		orderedGates,
		e.detected,
		e.rules,
		removed.SlotIndex,
		removed.Callsign,
		target.Breaks,
	)
	e.recomputePracticeSessionLapsLocked(target)
	target.UpdatedAt = time.Now().UTC().Format(time.RFC3339)

	var mlChanged bool
	var mlSnap domain.MLStatus
	if isActive {
		e.crossings = append([]domain.GateCrossingEvent(nil), target.Crossings...)
		e.syncActivePracticeLapsLocked(target)
		e.rebuildPilotLiveProgressFromCrossingsLocked(removed.SlotIndex, orderedGates)
		if e.recomputeLiveGateTunesLocked(removed.SlotIndex, target.ManualDeletedCrossings) {
			mlChanged = true
			mlSnap = e.buildMLStatusLocked()
		}
	}
	target.Summaries = e.computePracticeSessionSummariesLocked(target)

	practiceSnap := clonePracticeManagerState(e.practiceState)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	e.notifyPracticeUpdated(practiceSnap, subs)
	if mlChanged {
		e.notifyMLUpdated(mlSnap, subs)
	}
	return practiceSnap, nil
}

// AddPracticeSessionBreak inserts a manual pilot break (`PracticeBreakMark`) at `timestampUs` in a
// Practice session and replays that pilot's crossings so dead-air across the break never forms a phantom lap.
func (e *Engine) AddPracticeSessionBreak(
	sessionID string,
	slotIndex int,
	timestampUs uint64,
) (domain.PracticeManagerState, uint64, error) {
	if slotIndex <= 0 || timestampUs == 0 {
		return e.PracticeSnapshot(), 0, fmt.Errorf("slotIndex and timestampUs must be positive")
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
		return snap, 0, fmt.Errorf("practice session %q not found", sessionID)
	}

	isActive := target.Active && e.practiceState.ActiveSessionID == target.SessionID && !e.isLiveRaceHeatActiveLocked()
	if isActive && len(e.crossings) > len(target.Crossings) {
		e.syncActivePracticeRecordsLocked()
	}

	for i := range target.Breaks {
		if target.Breaks[i].SlotIndex == slotIndex && absDiffUs(target.Breaks[i].TimestampUs, timestampUs) <= 200_000 {
			target.Breaks[i].TimestampUs = timestampUs
			snap := clonePracticeManagerState(e.practiceState)
			bid := target.Breaks[i].BreakID
			e.mu.Unlock()
			return snap, bid, nil
		}
	}

	e.nextEventID++
	breakID := e.nextEventID
	for _, b := range target.Breaks {
		if b.BreakID >= breakID {
			breakID = b.BreakID + 1
			e.nextEventID = breakID
		}
	}
	for _, c := range target.Crossings {
		if c.EventID >= breakID {
			breakID = c.EventID + 1
			e.nextEventID = breakID
		}
	}

	target.Breaks = append(target.Breaks, domain.PracticeBreakMark{
		BreakID:     breakID,
		SlotIndex:   slotIndex,
		TimestampUs: timestampUs,
	})
	sort.Slice(target.Breaks, func(a, b int) bool {
		return target.Breaks[a].TimestampUs < target.Breaks[b].TimestampUs
	})

	callsign := ""
	for _, p := range target.Pilots {
		if p.SlotIndex == slotIndex && p.Callsign != "" {
			callsign = p.Callsign
			break
		}
	}
	orderedGates := e.orderedGatesForPracticeSessionLocked(target)
	sessionRules := e.rules
	if target.Rules != nil {
		sessionRules = target.Rules.Normalized()
	}
	target.Crossings, target.Laps = e.replayPilotCrossingsWithBreaksLocked(
		target.Crossings,
		target.Laps,
		orderedGates,
		e.detected,
		sessionRules,
		slotIndex,
		callsign,
		target.Breaks,
	)
	e.recomputePracticeSessionLapsLocked(target)
	target.UpdatedAt = time.Now().UTC().Format(time.RFC3339)

	if isActive {
		e.crossings = append([]domain.GateCrossingEvent(nil), target.Crossings...)
		e.syncActivePracticeLapsLocked(target)
		e.rebuildPilotLiveProgressFromCrossingsLocked(slotIndex, orderedGates)
	}
	target.Summaries = e.computePracticeSessionSummariesLocked(target)

	practiceSnap := clonePracticeManagerState(e.practiceState)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	e.notifyPracticeUpdated(practiceSnap, subs)
	return practiceSnap, breakID, nil
}

// AdjustPracticeSessionBreak moves an existing `PracticeBreakMark` to `newTimestampUs` and replays
// that pilot's crossings.
func (e *Engine) AdjustPracticeSessionBreak(
	sessionID string,
	breakID uint64,
	newTimestampUs uint64,
) (domain.PracticeManagerState, error) {
	if breakID == 0 || newTimestampUs == 0 {
		return e.PracticeSnapshot(), fmt.Errorf("breakId and timestampUs must be positive")
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

	idx := -1
	for i := range target.Breaks {
		if target.Breaks[i].BreakID == breakID {
			idx = i
			break
		}
	}
	if idx < 0 {
		snap := clonePracticeManagerState(e.practiceState)
		e.mu.Unlock()
		return snap, fmt.Errorf("break %d not found in practice session %q", breakID, target.SessionID)
	}

	slotIndex := target.Breaks[idx].SlotIndex
	target.Breaks[idx].TimestampUs = newTimestampUs
	sort.Slice(target.Breaks, func(a, b int) bool {
		return target.Breaks[a].TimestampUs < target.Breaks[b].TimestampUs
	})

	callsign := ""
	for _, p := range target.Pilots {
		if p.SlotIndex == slotIndex && p.Callsign != "" {
			callsign = p.Callsign
			break
		}
	}
	orderedGates := e.orderedGatesForPracticeSessionLocked(target)
	sessionRules := e.rules
	if target.Rules != nil {
		sessionRules = target.Rules.Normalized()
	}
	target.Crossings, target.Laps = e.replayPilotCrossingsWithBreaksLocked(
		target.Crossings,
		target.Laps,
		orderedGates,
		e.detected,
		sessionRules,
		slotIndex,
		callsign,
		target.Breaks,
	)
	e.recomputePracticeSessionLapsLocked(target)
	target.UpdatedAt = time.Now().UTC().Format(time.RFC3339)

	if isActive {
		e.crossings = append([]domain.GateCrossingEvent(nil), target.Crossings...)
		e.syncActivePracticeLapsLocked(target)
		e.rebuildPilotLiveProgressFromCrossingsLocked(slotIndex, orderedGates)
	}
	target.Summaries = e.computePracticeSessionSummariesLocked(target)

	practiceSnap := clonePracticeManagerState(e.practiceState)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	e.notifyPracticeUpdated(practiceSnap, subs)
	return practiceSnap, nil
}

// DeletePracticeSessionBreak removes a `PracticeBreakMark` from a Practice session and replays
// that pilot's crossings.
func (e *Engine) DeletePracticeSessionBreak(
	sessionID string,
	breakID uint64,
) (domain.PracticeManagerState, error) {
	if breakID == 0 {
		return e.PracticeSnapshot(), fmt.Errorf("breakId must be positive")
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

	delIdx := -1
	for i := range target.Breaks {
		if target.Breaks[i].BreakID == breakID {
			delIdx = i
			break
		}
	}
	if delIdx < 0 {
		snap := clonePracticeManagerState(e.practiceState)
		e.mu.Unlock()
		return snap, fmt.Errorf("break %d not found in practice session %q", breakID, target.SessionID)
	}

	removed := target.Breaks[delIdx]
	target.Breaks = append(target.Breaks[:delIdx], target.Breaks[delIdx+1:]...)

	callsign := ""
	for _, p := range target.Pilots {
		if p.SlotIndex == removed.SlotIndex && p.Callsign != "" {
			callsign = p.Callsign
			break
		}
	}
	orderedGates := e.orderedGatesForPracticeSessionLocked(target)
	sessionRules := e.rules
	if target.Rules != nil {
		sessionRules = target.Rules.Normalized()
	}
	target.Crossings, target.Laps = e.replayPilotCrossingsWithBreaksLocked(
		target.Crossings,
		target.Laps,
		orderedGates,
		e.detected,
		sessionRules,
		removed.SlotIndex,
		callsign,
		target.Breaks,
	)
	e.recomputePracticeSessionLapsLocked(target)
	target.UpdatedAt = time.Now().UTC().Format(time.RFC3339)

	if isActive {
		e.crossings = append([]domain.GateCrossingEvent(nil), target.Crossings...)
		e.syncActivePracticeLapsLocked(target)
		e.rebuildPilotLiveProgressFromCrossingsLocked(removed.SlotIndex, orderedGates)
	}
	target.Summaries = e.computePracticeSessionSummariesLocked(target)

	practiceSnap := clonePracticeManagerState(e.practiceState)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	e.notifyPracticeUpdated(practiceSnap, subs)
	return practiceSnap, nil
}

// DeletePracticeSessionFiltered removes a rejected `FilteredDetection` hint (`TOO_SHORT`, `SPIKE`,
// `MIN_LAP`, `OUT_OF_ORDER`) from a Practice session.
func (e *Engine) DeletePracticeSessionFiltered(
	sessionID string,
	gateID uint8,
	slotIndex int,
	timestampUs uint64,
) (domain.PracticeManagerState, error) {
	if gateID == 0 || slotIndex <= 0 || timestampUs == 0 {
		return e.PracticeSnapshot(), fmt.Errorf("gateId, slotIndex, and timestampUs must be positive")
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
	if isActive && len(e.filtered) > len(target.Filtered) {
		e.syncActivePracticeRecordsLocked()
	}

	delIdx := -1
	var bestDiff uint64 = 10_001
	for i, f := range target.Filtered {
		if f.GateID == gateID && f.SlotIndex == slotIndex {
			d := absDiffUs(f.TimestampUs, timestampUs)
			if d <= 10_000 && d < bestDiff {
				bestDiff = d
				delIdx = i
				if d == 0 {
					break
				}
			}
		}
	}
	if delIdx < 0 {
		snap := clonePracticeManagerState(e.practiceState)
		e.mu.Unlock()
		return snap, fmt.Errorf("filtered detection not found in practice session %q", target.SessionID)
	}

	removedTs := target.Filtered[delIdx].TimestampUs
	target.Filtered = append(target.Filtered[:delIdx], target.Filtered[delIdx+1:]...)
	target.UpdatedAt = time.Now().UTC().Format(time.RFC3339)

	if isActive && len(e.filtered) > 0 {
		keptRoot := e.filtered[:0]
		for _, f := range e.filtered {
			if f.GateID == gateID && f.SlotIndex == slotIndex && f.TimestampUs == removedTs {
				continue
			}
			keptRoot = append(keptRoot, f)
		}
		e.filtered = keptRoot
	}

	practiceSnap := clonePracticeManagerState(e.practiceState)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	e.notifyPracticeUpdated(practiceSnap, subs)
	return practiceSnap, nil
}

// DeleteEngineFiltered removes a `FilteredDetection` directly from the root engine buffers.
func (e *Engine) DeleteEngineFiltered(gateID uint8, slotIndex int, timestampUs uint64) error {
	if gateID == 0 || slotIndex <= 0 || timestampUs == 0 {
		return fmt.Errorf("gateId, slotIndex, and timestampUs must be positive")
	}
	e.mu.Lock()
	delIdx := -1
	var bestDiff uint64 = 10_001
	for i, f := range e.filtered {
		if f.GateID == gateID && f.SlotIndex == slotIndex {
			d := absDiffUs(f.TimestampUs, timestampUs)
			if d <= 10_000 && d < bestDiff {
				bestDiff = d
				delIdx = i
				if d == 0 {
					break
				}
			}
		}
	}
	if delIdx < 0 {
		e.mu.Unlock()
		return fmt.Errorf("filtered detection not found")
	}
	e.filtered = append(e.filtered[:delIdx], e.filtered[delIdx+1:]...)
	e.mu.Unlock()
	return nil
}

// AddEngineCrossing inserts a manual crossing directly on the root engine buffers.
func (e *Engine) AddEngineCrossing(gateID uint8, slotIndex int, timestampUs uint64, peakRSSIDbm *float32) (uint64, error) {
	e.mu.Lock()
	orderedGates := e.orderedGatesLocked()
	ev, err := e.newManualCrossingEventLocked(orderedGates, gateID, slotIndex, timestampUs, peakRSSIDbm, "")
	if err != nil {
		e.mu.Unlock()
		return 0, err
	}
	e.crossings = append(e.crossings, ev)
	if len(e.filtered) > 0 {
		keptFilt := e.filtered[:0]
		for _, f := range e.filtered {
			if f.GateID == gateID && f.SlotIndex == slotIndex && absDiffUs(f.TimestampUs, timestampUs) <= 1_500_000 {
				continue
			}
			keptFilt = append(keptFilt, f)
		}
		e.filtered = keptFilt
	}
	e.crossings, e.laps = e.replayPilotCrossingsLocked(
		e.crossings,
		e.laps,
		orderedGates,
		e.detected,
		e.rules,
		slotIndex,
		ev.Callsign,
	)
	tmpSess := domain.PracticeSession{Laps: e.laps}
	e.recomputePracticeSessionLapsLocked(&tmpSess)
	e.laps = tmpSess.Laps
	e.rebuildRootSectorBestsLocked()
	e.rebuildPilotLiveProgressFromCrossingsLocked(slotIndex, orderedGates)
	e.mu.Unlock()
	return ev.EventID, nil
}

// AdjustEngineCrossing moves a crossing directly on the root engine buffers.
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
	slotIndex := e.crossings[movedIdx].SlotIndex
	callsign := e.crossings[movedIdx].Callsign
	e.crossings[movedIdx].TimestampUs = newTimestampUs
	e.crossings[movedIdx].Manual = true
	if peakRSSIDbm != nil && !math.IsNaN(float64(*peakRSSIDbm)) && !math.IsInf(float64(*peakRSSIDbm), 0) {
		e.crossings[movedIdx].PeakRSSIDbm = *peakRSSIDbm
	}

	e.crossings, e.laps = e.replayPilotCrossingsLocked(
		e.crossings,
		e.laps,
		orderedGates,
		e.detected,
		e.rules,
		slotIndex,
		callsign,
	)
	tmpSess := domain.PracticeSession{Laps: e.laps}
	e.recomputePracticeSessionLapsLocked(&tmpSess)
	e.laps = tmpSess.Laps
	e.rebuildRootSectorBestsLocked()
	e.rebuildPilotLiveProgressFromCrossingsLocked(slotIndex, orderedGates)
	e.mu.Unlock()
	return nil
}

// DeleteEngineCrossing deletes a crossing directly from the root engine buffers.
func (e *Engine) DeleteEngineCrossing(eventID uint64) error {
	if eventID == 0 {
		return fmt.Errorf("eventId must be positive")
	}

	e.mu.Lock()
	delIdx := -1
	for i := range e.crossings {
		if e.crossings[i].EventID == eventID {
			delIdx = i
			break
		}
	}
	if delIdx < 0 {
		e.mu.Unlock()
		return fmt.Errorf("crossing %d not found", eventID)
	}

	removed := e.crossings[delIdx]
	e.crossings = append(e.crossings[:delIdx], e.crossings[delIdx+1:]...)
	orderedGates := e.orderedGatesLocked()
	e.crossings, e.laps = e.replayPilotCrossingsLocked(
		e.crossings,
		e.laps,
		orderedGates,
		e.detected,
		e.rules,
		removed.SlotIndex,
		removed.Callsign,
	)
	tmpSess := domain.PracticeSession{Laps: e.laps}
	e.recomputePracticeSessionLapsLocked(&tmpSess)
	e.laps = tmpSess.Laps
	e.rebuildRootSectorBestsLocked()
	e.rebuildPilotLiveProgressFromCrossingsLocked(removed.SlotIndex, orderedGates)
	e.mu.Unlock()
	return nil
}

func findCompletedLapSectorsByEnd(laps []domain.LapRecord, slotIndex int, completedAtUs uint64) []domain.SectorSplit {
	for i := range laps {
		if laps[i].SlotIndex == slotIndex && absDiffUs(laps[i].CompletedAtUs, completedAtUs) <= 5_000 {
			return append([]domain.SectorSplit(nil), laps[i].Sectors...)
		}
	}
	return nil
}

// AddRaceCrossing inserts a manual crossing on the Race Signals chart and updates official heat
// standings if it is a valid Start/Finish crossing for an active or completed heat seat.
func (e *Engine) AddRaceCrossing(raceID string, gateID uint8, slotIndex int, timestampUs uint64, peakRSSIDbm *float32) (uint64, error) {
	e.mu.Lock()
	swap, err := e.enterTargetRaceLocked(raceID)
	if err != nil {
		e.mu.Unlock()
		return 0, err
	}

	orderedGates := e.orderedGatesLocked()
	ev, err := e.newManualCrossingEventLocked(orderedGates, gateID, slotIndex, timestampUs, peakRSSIDbm, "")
	if err != nil {
		_ = e.exitTargetRaceLocked(&swap, false)
		e.mu.Unlock()
		return 0, err
	}
	e.crossings = append(e.crossings, ev)
	if len(e.filtered) > 0 {
		keptFilt := e.filtered[:0]
		for _, f := range e.filtered {
			if f.GateID == gateID && f.SlotIndex == slotIndex && absDiffUs(f.TimestampUs, timestampUs) <= 1_500_000 {
				continue
			}
			keptFilt = append(keptFilt, f)
		}
		e.filtered = keptFilt
	}
	e.crossings, e.laps = e.replayPilotCrossingsLocked(
		e.crossings,
		e.laps,
		orderedGates,
		e.detected,
		e.rules,
		slotIndex,
		ev.Callsign,
	)
	tmpSess := domain.PracticeSession{Laps: e.laps}
	e.recomputePracticeSessionLapsLocked(&tmpSess)
	e.laps = tmpSess.Laps
	e.rebuildPilotLiveProgressFromCrossingsLocked(slotIndex, orderedGates)

	var replayedEv *domain.GateCrossingEvent
	for i := range e.crossings {
		if e.crossings[i].EventID == ev.EventID {
			replayedEv = &e.crossings[i]
			break
		}
	}

	heatChanged := false
	if replayedEv != nil && replayedEv.IsStartFinish && replayedEv.InvalidReason == "" {
		for hi := len(e.raceState.Heats) - 1; hi >= 0; hi-- {
			h := &e.raceState.Heats[hi]
			if h.State != domain.HeatRunning && h.State != domain.HeatFinished && h.State != domain.HeatConfirmed {
				continue
			}
			for si := range h.Seats {
				seat := &h.Seats[si]
				if seat.PilotSlotIndex != slotIndex {
					continue
				}
				seat.Crossings = append(seat.Crossings, domain.HeatCrossing{
					CrossingID:  replayedEv.EventID,
					TimestampUs: replayedEv.TimestampUs,
					Manual:      true,
					PeakRSSIDbm: replayedEv.PeakRSSIDbm,
					Sectors:     findCompletedLapSectorsByEnd(e.laps, slotIndex, replayedEv.TimestampUs),
				})
				sort.SliceStable(seat.Crossings, func(a, b int) bool {
					return seat.Crossings[a].TimestampUs < seat.Crossings[b].TimestampUs
				})
				race.RecomputeHeat(h, e.raceState.Config.QualifyingMetric)
				heatChanged = true
				break
			}
			if heatChanged {
				break
			}
		}
	}

	if heatChanged {
		e.resolveActiveTournamentLocked()
	}
	if swap.swapped {
		_ = e.exitTargetRaceLocked(&swap, true)
	} else if e.raceState.RaceID != "" {
		e.syncActiveRaceToEventLocked()
	}
	raceSnap := cloneRaceState(e.raceState)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	if heatChanged {
		e.notifyRaceUpdated(raceSnap, nil, subs)
	}
	return ev.EventID, nil
}

// AdjustRaceCrossing adjusts a gate crossing on the Race Signals chart and updates official
// heat standings when Start/Finish crossings or sector splits change.
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
	orderedGates := e.orderedGatesLocked()

	if movedIdx >= 0 {
		movedCopy = e.crossings[movedIdx]
		oldTsUs = movedCopy.TimestampUs
		e.crossings[movedIdx].TimestampUs = newTimestampUs
		e.crossings[movedIdx].Manual = true
		if peakRSSIDbm != nil && !math.IsNaN(float64(*peakRSSIDbm)) && !math.IsInf(float64(*peakRSSIDbm), 0) {
			e.crossings[movedIdx].PeakRSSIDbm = *peakRSSIDbm
		}
		e.crossings, e.laps = e.replayPilotCrossingsLocked(
			e.crossings,
			e.laps,
			orderedGates,
			e.detected,
			e.rules,
			movedCopy.SlotIndex,
			movedCopy.Callsign,
		)
		tmpSess := domain.PracticeSession{Laps: e.laps}
		e.recomputePracticeSessionLapsLocked(&tmpSess)
		e.laps = tmpSess.Laps
		e.rebuildPilotLiveProgressFromCrossingsLocked(movedCopy.SlotIndex, orderedGates)
	}

	sfGateID := startFinishGateIDFrom(orderedGates)
	invalidByID := make(map[uint64]bool, len(e.crossings))
	for i := range e.crossings {
		if e.crossings[i].InvalidReason != "" {
			invalidByID[e.crossings[i].EventID] = true
		}
	}

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
						hc.TimestampUs = newTimestampUs
						if peakRSSIDbm != nil {
							hc.PeakRSSIDbm = *peakRSSIDbm
						}
						hc.Manual = true
						hc.Invalidated = invalidByID[hc.CrossingID]
						hc.Sectors = findCompletedLapSectorsByEnd(e.laps, seat.PilotSlotIndex, hc.TimestampUs)
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
		_ = e.exitTargetRaceLocked(&swap, true)
	} else if e.raceState.RaceID != "" {
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

// DeleteRaceCrossing removes crossing `eventID` from the Race Signals chart and recomputes
// official heat standings if it belonged to a heat seat.
func (e *Engine) DeleteRaceCrossing(raceID string, eventID uint64) error {
	if eventID == 0 {
		return fmt.Errorf("eventId must be positive")
	}

	e.mu.Lock()
	swap, err := e.enterTargetRaceLocked(raceID)
	if err != nil {
		e.mu.Unlock()
		return err
	}

	delIdx := -1
	for i := range e.crossings {
		if e.crossings[i].EventID == eventID {
			delIdx = i
			break
		}
	}
	var removed domain.GateCrossingEvent
	orderedGates := e.orderedGatesLocked()
	if delIdx >= 0 {
		removed = e.crossings[delIdx]
		e.crossings = append(e.crossings[:delIdx], e.crossings[delIdx+1:]...)
		e.crossings, e.laps = e.replayPilotCrossingsLocked(
			e.crossings,
			e.laps,
			orderedGates,
			e.detected,
			e.rules,
			removed.SlotIndex,
			removed.Callsign,
		)
		tmpSess := domain.PracticeSession{Laps: e.laps}
		e.recomputePracticeSessionLapsLocked(&tmpSess)
		e.laps = tmpSess.Laps
		e.rebuildPilotLiveProgressFromCrossingsLocked(removed.SlotIndex, orderedGates)
	}

	heatChanged := false
	for hi := len(e.raceState.Heats) - 1; hi >= 0; hi-- {
		h := &e.raceState.Heats[hi]
		for si := range h.Seats {
			seat := &h.Seats[si]
			if delIdx >= 0 && seat.PilotSlotIndex != removed.SlotIndex {
				continue
			}
			for ci := range seat.Crossings {
				hc := seat.Crossings[ci]
				if hc.CrossingID == eventID || (delIdx >= 0 && removed.IsStartFinish && absDiffUs(hc.TimestampUs, removed.TimestampUs) <= 50_000) {
					seat.Crossings = append(seat.Crossings[:ci], seat.Crossings[ci+1:]...)
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

	if delIdx < 0 && !heatChanged {
		_ = e.exitTargetRaceLocked(&swap, false)
		e.mu.Unlock()
		return fmt.Errorf("crossing %d not found in race %q", eventID, raceID)
	}

	if heatChanged {
		e.resolveActiveTournamentLocked()
	}
	if swap.swapped {
		_ = e.exitTargetRaceLocked(&swap, true)
	} else if e.raceState.RaceID != "" {
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
