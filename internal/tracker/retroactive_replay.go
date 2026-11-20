package tracker

import (
	"slaprf/internal/domain"
	"slaprf/internal/dsp"
)

const (
	// replayHistoryWindowUs matches the frontend Signals chart HISTORY_SECONDS (15 minutes = 900 s).
	replayHistoryWindowUs uint64 = 900_000_000
	maxReplayFrames       int    = 180_000
	maxReplayExtCrossings int    = 4_000
)

type bufferedPilotRSSI struct {
	slotIndex uint16
	rssi      float32
}

type bufferedTelemetryFrame struct {
	timestampUs uint64
	gateID      uint8
	recorded    bool
	sessionID   string
	count       uint8
	pilots      [domain.MaxPilotSlots]bufferedPilotRSSI
}

type bufferedExternalCrossing struct {
	ev        domain.GateCrossingEvent
	recorded  bool
	sessionID string
}

// recordReplayTelemetryLocked appends raw (pre-smoothing) telemetry for active pilot slots into the
// rolling 15-minute replay buffer so Practice detections/laps can be retroactively recalculated when
// thresholds or detection rules are fine-tuned. Caller holds `e.mu` write lock.
func (e *Engine) recordReplayTelemetryLocked(gateID uint8, timestampUs uint64, frame domain.TimerTelemetryFrame) {
	recorded := e.raceArmed && !e.isLiveRaceHeatActiveLocked() && e.raceState.Mode != domain.ModeRace
	sessID := ""
	if recorded {
		sessID = e.practiceState.ActiveSessionID
	}

	var bf bufferedTelemetryFrame
	bf.timestampUs = timestampUs
	bf.gateID = gateID
	bf.recorded = recorded
	bf.sessionID = sessID

	for i := 0; i < len(e.pilots) && i < domain.MaxPilotPoolSize; i++ {
		p := e.pilots[i]
		if !p.Enabled || p.Channel == 0 {
			continue
		}
		if int(bf.count) >= len(bf.pilots) {
			break
		}
		bf.pilots[bf.count] = bufferedPilotRSSI{
			slotIndex: uint16(p.SlotIndex),
			rssi:      frame.RSSI[i],
		}
		bf.count++
	}

	n := len(e.replayRing)
	if n == 0 || bf.timestampUs >= e.replayRing[n-1].timestampUs {
		e.replayRing = append(e.replayRing, bf)
	} else {
		// Multi-gate frames (e.g. Hub Slot 1 + Spoke Slot 2) can arrive a few milliseconds out of
		// chronological order; insert in timestamp order so multi-gate splits replay accurately.
		ins := n
		for ins > 0 && e.replayRing[ins-1].timestampUs > bf.timestampUs {
			ins--
		}
		e.replayRing = append(e.replayRing, bufferedTelemetryFrame{})
		copy(e.replayRing[ins+1:], e.replayRing[ins:n])
		e.replayRing[ins] = bf
	}

	e.trimReplayRingLocked()
}

func (e *Engine) trimReplayRingLocked() {
	n := len(e.replayRing)
	if n == 0 {
		return
	}
	latestUs := e.replayRing[n-1].timestampUs
	drop := 0
	if n > maxReplayFrames {
		drop = n - maxReplayFrames
	}
	if latestUs > replayHistoryWindowUs {
		cutoff := latestUs - replayHistoryWindowUs
		for drop < n && e.replayRing[drop].timestampUs < cutoff {
			drop++
		}
	}
	if drop > 0 {
		// Shift in place once drop exceeds 4096 frames to avoid per-frame memmove overhead.
		if drop >= 4096 || n-drop == 0 {
			copy(e.replayRing, e.replayRing[drop:])
			e.replayRing = e.replayRing[:n-drop]
		}
	}
}

func (e *Engine) recordReplayExternalCrossingLocked(ev domain.GateCrossingEvent) {
	recorded := e.raceArmed && !e.isLiveRaceHeatActiveLocked() && e.raceState.Mode != domain.ModeRace
	sessID := ""
	if recorded {
		sessID = e.practiceState.ActiveSessionID
	}
	e.extCrossingRing = append(e.extCrossingRing, bufferedExternalCrossing{
		ev:        ev,
		recorded:  recorded,
		sessionID: sessID,
	})
	if n := len(e.extCrossingRing); n > maxReplayExtCrossings {
		copy(e.extCrossingRing, e.extCrossingRing[n-maxReplayExtCrossings:])
		e.extCrossingRing = e.extCrossingRing[:maxReplayExtCrossings]
	}
}

// clearReplayRecordingLocked marks buffered frames for `sessionID` (or all frames when `sessionID == ""`)
// as unrecorded so explicitly cleared laps stay cleared while keeping continuous DSP signal warm-up.
func (e *Engine) clearReplayRecordingLocked(sessionID string) {
	for i := range e.replayRing {
		if sessionID == "" || e.replayRing[i].sessionID == sessionID {
			e.replayRing[i].recorded = false
			e.replayRing[i].sessionID = ""
		}
	}
	for i := range e.extCrossingRing {
		if sessionID == "" || e.extCrossingRing[i].sessionID == sessionID {
			e.extCrossingRing[i].recorded = false
			e.extCrossingRing[i].sessionID = ""
		}
	}
}

func (e *Engine) gatePtrByIDLocked(gateID uint8) *domain.TrackGate {
	for i := range e.gates {
		if e.gates[i].GateID == gateID {
			return &e.gates[i]
		}
	}
	return nil
}

// replayBufferedPracticeLocked retroactively re-evaluates the rolling 15-minute telemetry (or
// external hardware crossing) buffer against the current thresholds and 3-tier timing rules for
// the active Practice session. Never runs during or mutates Race heats. Caller holds `e.mu` write lock.
func (e *Engine) replayBufferedPracticeLocked() bool {
	if e.isLiveRaceHeatActiveLocked() || e.raceState.Mode == domain.ModeRace {
		return false
	}

	hasTelemetry := len(e.replayRing) > 0
	hasExt := !hasTelemetry && len(e.extCrossingRing) > 0
	if !hasTelemetry && !hasExt {
		return false
	}

	var windowStartUs uint64
	if hasTelemetry {
		windowStartUs = e.replayRing[0].timestampUs
		if n := len(e.replayRing); n > 0 && e.replayRing[n-1].timestampUs > replayHistoryWindowUs {
			cutoff := e.replayRing[n-1].timestampUs - replayHistoryWindowUs
			if cutoff > windowStartUs {
				windowStartUs = cutoff
			}
		}
	} else {
		windowStartUs = e.extCrossingRing[0].ev.TimestampUs
	}

	type invKey struct {
		slotIndex int
		endUs     uint64
	}
	var manualInvalidated []invKey
	preLaps := make([]domain.LapRecord, 0, len(e.laps))
	for _, l := range e.laps {
		if l.CompletedAtUs < windowStartUs {
			cp := l
			cp.Sectors = append([]domain.SectorSplit(nil), l.Sectors...)
			preLaps = append(preLaps, cp)
		} else if l.Invalidated {
			manualInvalidated = append(manualInvalidated, invKey{slotIndex: l.SlotIndex, endUs: l.CompletedAtUs})
		}
	}

	preCrossings := make([]domain.GateCrossingEvent, 0, len(e.crossings))
	for _, c := range e.crossings {
		if c.TimestampUs < windowStartUs {
			preCrossings = append(preCrossings, c)
		}
	}

	preFiltered := make([]domain.FilteredDetection, 0, len(e.filtered))
	for _, f := range e.filtered {
		if f.TimestampUs < windowStartUs {
			preFiltered = append(preFiltered, f)
		}
	}

	// Rebuild baseline engine state from pre-window history.
	e.laps = preLaps
	e.crossings = preCrossings
	e.filtered = preFiltered
	e.progress = make(map[int]*pilotProgress)
	e.passProfiles = make(map[detKey]*pilotPassProfile)
	e.lastAcceptedUs = make(map[string]uint64)
	e.overallBestSec = make(map[string]float64)
	e.pilotBestSec = make(map[string]float64)
	e.sectorHistory = make(map[string][]domain.SectorSplit)
	e.passingNumbers = make(map[uint8]uint32)
	e.nextEventID = 0
	e.nextLapID = 0

	for _, l := range e.laps {
		if l.LapID > e.nextLapID {
			e.nextLapID = l.LapID
		}
		if l.Invalidated {
			continue
		}
		for _, split := range l.Sectors {
			pKey := pairKey(split.FromGateID, split.ToGateID)
			sKey := sectorKey(l.SlotIndex, pKey)
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
		prog := e.progress[l.SlotIndex]
		if prog == nil {
			prog = &pilotProgress{}
			e.progress[l.SlotIndex] = prog
		}
		prog.lapStartUs = l.CompletedAtUs
	}

	for _, c := range e.crossings {
		if c.EventID > e.nextEventID {
			e.nextEventID = c.EventID
		}
		if c.PassingNumber > e.passingNumbers[c.GateID] {
			e.passingNumbers[c.GateID] = c.PassingNumber
		}
		e.lastAcceptedUs[detectorKey(c.GateID, c.SlotIndex)] = c.TimestampUs
		prog := e.progress[c.SlotIndex]
		if prog == nil {
			prog = &pilotProgress{}
			e.progress[c.SlotIndex] = prog
		}
		if prog.lastGateID != c.GateID {
			prog.prevGateID = prog.lastGateID
		}
		prog.lastGateID = c.GateID
		prog.lastGateTimeUs = c.TimestampUs
		if c.IsStartFinish {
			prog.lapStartUs = c.TimestampUs
			prog.currentSectors = nil
		}
	}

	activeSessionID := e.practiceState.ActiveSessionID
	isRH := domain.IsRotorHazardMode(e.timingHardwareMode)

	wasManuallyInvalidated := func(slotIndex int, endUs uint64) bool {
		for _, k := range manualInvalidated {
			if k.slotIndex != slotIndex {
				continue
			}
			var diff uint64
			if endUs >= k.endUs {
				diff = endUs - k.endUs
			} else {
				diff = k.endUs - endUs
			}
			if diff <= 500_000 {
				return true
			}
		}
		return false
	}
	restoredInvalidation := false

	if hasTelemetry {
		e.detectors = make(map[detKey]*dsp.ChannelDetector)
		startIdx := 0
		for startIdx < len(e.replayRing) && e.replayRing[startIdx].timestampUs < windowStartUs {
			startIdx++
		}
		for idx := startIdx; idx < len(e.replayRing); idx++ {
			bf := &e.replayRing[idx]
			gate := e.gatePtrByIDLocked(bf.gateID)
			if gate == nil {
				continue
			}
			gateName := e.gateLabelLocked(gate.GateID)
			isSF := gate.Role == domain.GateRoleStartFinish

			for k := uint8(0); k < bf.count; k++ {
				slotIdx := int(bf.pilots[k].slotIndex)
				pilotPos := e.slotPositionLocked(slotIdx)
				if pilotPos < 0 {
					continue
				}
				pilot := e.pilots[pilotPos]
				dKey := detKey{gate.GateID, slotIdx}
				det := e.detectors[dKey]
				if det == nil {
					det = dsp.NewChannelDetector(gate.GateID, slotIdx)
					e.detectors[dKey] = det
				}
				var enter, exit float32
				if isRH {
					enter, exit = rhThresholdsFor(gate, pilotPos, pilot)
				} else {
					enter, exit = thresholdsFor(gate, pilotPos, pilot)
				}
				candidate := det.ProcessSample(bf.pilots[k].rssi, bf.timestampUs, enter, exit, detectorDebounceUs)
				if pilotPos < len(gate.LastRSSI) {
					gate.LastRSSI[pilotPos] = det.SmoothedRSSI()
				}
				if candidate == nil || !pilot.Enabled || pilot.Channel == 0 {
					continue
				}

				ev := domain.GateCrossingEvent{
					GateID:            gate.GateID,
					GateName:          gateName,
					IsStartFinish:     isSF,
					SlotIndex:         slotIdx,
					Callsign:          pilot.Callsign,
					FrequencyMHz:      pilot.FrequencyMHz,
					TimestampUs:       candidate.TimestampUs,
					PeakRSSIDbm:       candidate.PeakRSSIDbm,
					LapRFPeakHeight:   candidate.LapRFPeakHeight,
					BeamwidthMs:       candidate.BeamwidthMs,
					EstimatedSpeedMph: candidate.EstimatedSpeedMph,
					HoldMs:            candidate.HoldMs,
					AboveEnterMs:      candidate.AboveEnterMs,
					PassAreaDbSec:     candidate.PassAreaDbSec,
					IsStepBurst:       candidate.IsStepBurst,
				}

				inScope := bf.recorded && (activeSessionID == "" || bf.sessionID == activeSessionID)
				if !inScope {
					r := gate.RulesForPilot(e.rules, slotIdx)
					if e.checkSpikeRejectionLocked(pilot, *gate, pilotPos, ev, r) != "" {
						det.RollbackRejectedSpike()
					}
					continue
				}

				out := e.applyCrossingLocked(pilot, *gate, ev)
				if out.rejected != nil {
					if out.rejected.Reason == domain.FilterSpike {
						det.RollbackRejectedSpike()
					}
					e.storeFilteredLocked(*out.rejected)
					continue
				}

				e.nextEventID++
				e.passingNumbers[gate.GateID]++
				ev.EventID = e.nextEventID
				ev.PassingNumber = e.passingNumbers[gate.GateID]
				ev.StartedLap = ev.IsStartFinish && out.lap == nil
				e.crossings = append(e.crossings, ev)
				if len(e.crossings) > maxStoredCrossings {
					e.crossings = e.crossings[len(e.crossings)-maxStoredCrossings:]
				}
				if out.note != nil {
					e.storeFilteredLocked(*out.note)
				}
				if out.lap != nil {
					lap := *out.lap
					if wasManuallyInvalidated(lap.SlotIndex, lap.CompletedAtUs) {
						lap.Invalidated = true
						restoredInvalidation = true
					}
					e.laps = append(e.laps, lap)
					if len(e.laps) > maxStoredLaps {
						e.laps = e.laps[len(e.laps)-maxStoredLaps:]
					}
				}
			}
		}
	} else if hasExt {
		for idx := range e.extCrossingRing {
			rec := &e.extCrossingRing[idx]
			if rec.ev.TimestampUs < windowStartUs {
				continue
			}
			inScope := rec.recorded && (activeSessionID == "" || rec.sessionID == activeSessionID)
			if !inScope {
				continue
			}
			gate := e.gatePtrByIDLocked(rec.ev.GateID)
			pilotPos := e.slotPositionLocked(rec.ev.SlotIndex)
			if gate == nil || pilotPos < 0 {
				continue
			}
			pilot := e.pilots[pilotPos]
			if !pilot.Enabled || pilot.Channel == 0 {
				continue
			}
			ev := rec.ev
			ev.GateName = e.gateLabelLocked(gate.GateID)
			ev.IsStartFinish = gate.Role == domain.GateRoleStartFinish
			ev.Callsign = pilot.Callsign

			out := e.applyCrossingLocked(pilot, *gate, ev)
			if out.rejected != nil {
				e.storeFilteredLocked(*out.rejected)
				continue
			}
			e.nextEventID++
			e.passingNumbers[gate.GateID]++
			ev.EventID = e.nextEventID
			ev.PassingNumber = e.passingNumbers[gate.GateID]
			ev.StartedLap = ev.IsStartFinish && out.lap == nil
			e.crossings = append(e.crossings, ev)
			if len(e.crossings) > maxStoredCrossings {
				e.crossings = e.crossings[len(e.crossings)-maxStoredCrossings:]
			}
			if out.note != nil {
				e.storeFilteredLocked(*out.note)
			}
			if out.lap != nil {
				lap := *out.lap
				if wasManuallyInvalidated(lap.SlotIndex, lap.CompletedAtUs) {
					lap.Invalidated = true
					restoredInvalidation = true
				}
				e.laps = append(e.laps, lap)
				if len(e.laps) > maxStoredLaps {
					e.laps = e.laps[len(e.laps)-maxStoredLaps:]
				}
			}
		}
	}

	if activeSessionID != "" {
		e.syncActivePracticeRecordsLocked()
		if restoredInvalidation {
			if sess := e.findPracticeSessionLocked(activeSessionID); sess != nil {
				e.recomputePracticeSessionLapsLocked(sess)
				sess.Summaries = e.computePracticeSessionSummariesLocked(sess)
				e.laps = cloneLaps(sess.Laps)
			}
		}
	}
	return true
}
