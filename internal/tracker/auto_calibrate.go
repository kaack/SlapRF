package tracker

import (
	"math"
	"sort"

	"slaprf/internal/domain"
	"slaprf/internal/dsp"
)

const (
	// autoCalibBucketUs downsamples incoming smoothed RSSI into 50 ms (~20 Hz) peak-preserving
	// buckets so 90 seconds of history per (gate, pilot) uses <= 1800 samples (~14 KB).
	autoCalibBucketUs       uint64 = 50_000
	autoCalibWindowUs       uint64 = 90_000_000 // Rolling 90 s signal window
	autoCalibMaxBuckets     int    = 1850
	autoCalibInitialEveryUs uint64 = 1_200_000  // Uncalibrated / provisional / pack-recovery: check every 1.2 s
	autoCalibMissedEveryUs  uint64 = 2_000_000  // No crossing in >= 10 s: check every 2.0 s for missed passes
	autoCalibSteadyEveryUs  uint64 = 5_000_000  // Calibrated gate: re-evaluate every 5 s while flying
	autoCalibFreshPassUs    uint64 = 35_000_000 // Require >= 1 valid pass in the last 35 s to re-calibrate
	autoCalibMissedCrossUs  uint64 = 10_000_000 // Treat >= 10 s without a gate crossing as potentially missed passes

	// Pack-swap / VTX power-cycle & stream-pause recovery thresholds.
	autoCalibStreamGapUs   uint64  = 12_000_000 // >= 12 s timestamp jump (practice pause/resume or hub reconnect)
	autoCalibVtxOffGapUs   uint64  = 15_000_000 // >= 15 s continuous bench noise floor without crossings = pack swap
	autoCalibPreWakeKeepUs uint64  = 2_000_000  // Keep 2 s of pre-wakeup quiet baseline for immediate takeoff passes
	autoCalibVtxOffDbm     float32 = -85.5      // Unplugged / pit-mode receiver floor threshold
	autoCalibVtxWakeDbm    float32 = -81.5      // Powered VTX / approach threshold (4 dB hysteresis above VtxOff)

	autoCalibMinBuckets     int     = 70        // ~3.5 s of 20 Hz history
	autoCalibMinSpanUs      uint64  = 3_200_000 // >= 3.2 s wall-clock span
	autoCalibMinPeakRiseDb  float32 = 9.5       // Pass peak must rise >= 9.5 dB above local valley baseline (supports indoor 10-12 dB swings)
	autoCalibMinAbsPeakDbm  float32 = -70.0     // Reject < -70 dBm 5 GHz Wi-Fi / ambient RF bursts on unused channels
	autoCalibMinEnterDbm    float32 = -78.0     // Never auto-calibrate enterThreshold into receiver thermal / Wi-Fi noise
	autoCalibLocalMaxSepUs  uint64  = 400_000   // Multipath crests < 400 ms apart belong to the same pass
	autoCalibLocalValleyUs  uint64  = 8_000_000 // Measure adjacent approach/departure valleys within +-8 s of each peak
	autoCalibMinPassSepUs   uint64  = 1_800_000 // Distinct lap fly-bys must be >= 1.8 s apart
	autoCalibMinPassFwhmUs  uint64  = 280_000   // Reject < 280 ms sharp Wi-Fi / RF packet bursts smeared by EMA release
	autoCalibMinPassSkirtUs uint64  = 440_000   // Genuine inverse-square approach + departure spans >= 440 ms above localBase + 3.5 dB
	autoCalibMinFlankUs     uint64  = 180_000   // Both rising approach and falling departure must span >= 180 ms (rejects step-on Wi-Fi packets)
	autoCalibMinPassAreaDbS float64 = 4.5       // Genuine gate pass integrates >= 4.5 dB*s above localBase
	autoCalibMaxPassFwhmUs  uint64  = 6_500_000 // Reject > 6.5 s parked/bench VTX plateaus
	autoCalibDeadbandDb     float32 = 1.5       // Skip minor updates smaller than 1.5 dB during steady flying
)

type autoCalibSample struct {
	tsUs uint64
	dbm  float32
}

type autoCalibState struct {
	samples         []autoCalibSample
	lastEvalUs      uint64
	lastCrossingUs  uint64
	vtxOffSinceUs   uint64
	vtxWakeUs       uint64
	freqMHz         uint16
	assignedTimerID uint8
	manualPinned    bool
	provisional     bool
	packRecovery    bool
}

type autoCalibPeak struct {
	tsUs uint64
	dbm  float32
}

func (e *Engine) ensureAutoCalibMapLocked() map[detKey]*autoCalibState {
	if e.autoCalib == nil {
		e.autoCalib = make(map[detKey]*autoCalibState)
	}
	return e.autoCalib
}

// setAutoCalibManualPinLocked records whether a user manually dragged/set a gate's threshold
// (`pinned = true`) or cleared / auto-calibrated it (`pinned = false`). When `resetHistory` is
// true (user clicked Reset), prior waveform history is cleared so new passes lock in cleanly.
func (e *Engine) setAutoCalibManualPinLocked(gateID uint8, slotIndex int, pinned bool, resetHistory bool) {
	m := e.ensureAutoCalibMapLocked()
	key := detKey{gateID, slotIndex}
	st := m[key]
	if st == nil {
		st = &autoCalibState{}
		m[key] = st
	}
	st.manualPinned = pinned
	st.provisional = false
	st.packRecovery = false
	if resetHistory {
		st.samples = st.samples[:0]
		st.lastEvalUs = 0
		st.lastCrossingUs = 0
		st.vtxOffSinceUs = 0
		st.vtxWakeUs = 0
	}
}

// recordAutoCalibSampleLocked records a smoothed SlapRF dBm sample for `(gate, pilot)` and runs
// continuous threshold calibration when lap-like pass waveforms are present, adapting across
// battery swaps, VTX power changes, and indoor/outdoor noise floors without manual intervention.
// When a pilot powers on near Start/Finish after a lull and completes a clean first pass that
// peaked just below the prior unpinned threshold while waiting to start a lap, `recoveredStart`
// returns that pass so Lap 1 begins immediately instead of waiting an entire lap.
// Returns `(changedConfig, changedStartFinish, recoveredStart)`. Caller holds `e.mu` write lock.
func (e *Engine) recordAutoCalibSampleLocked(
	gate *domain.TrackGate,
	slotPos int,
	pilot domain.PilotSlot,
	det *dsp.ChannelDetector,
	smoothedDbm float32,
	tsUs uint64,
	crossedNow bool,
) (changed bool, sfChanged bool, recoveredStart *dsp.CrossingCandidate) {
	if gate == nil || slotPos < 0 || slotPos >= len(gate.EnterThresholds) {
		return false, false, nil
	}
	if !pilot.Enabled || pilot.Channel == 0 || pilot.FrequencyMHz < 5180 {
		return false, false, nil
	}
	// Ignore invalid / survey-silenced / non-dBm readings.
	if smoothedDbm <= -120 || smoothedDbm >= -5 {
		return false, false, nil
	}

	m := e.ensureAutoCalibMapLocked()
	key := detKey{gate.GateID, pilot.SlotIndex}
	st := m[key]
	if st == nil {
		st = &autoCalibState{
			samples:         make([]autoCalibSample, 0, 256),
			freqMHz:         pilot.FrequencyMHz,
			assignedTimerID: gate.AssignedTimerID,
		}
		m[key] = st
	}

	// If the pilot changed VTX channel or a different physical timer was assigned to this gate,
	// discard stale waveform history from the previous channel/timer.
	if st.freqMHz != pilot.FrequencyMHz || st.assignedTimerID != gate.AssignedTimerID {
		st.samples = st.samples[:0]
		st.lastEvalUs = 0
		st.lastCrossingUs = 0
		st.vtxOffSinceUs = 0
		st.vtxWakeUs = 0
		st.provisional = false
		st.packRecovery = false
		st.freqMHz = pilot.FrequencyMHz
		st.assignedTimerID = gate.AssignedTimerID
		if !st.manualPinned {
			gate.EnterThresholds[slotPos] = 0
			gate.ExitThresholds[slotPos] = 0
		}
	}

	// Handle non-monotonic timestamps (e.g. simulator reset) or long stream gaps (e.g. practice
	// paused during a battery swap or BLE hub reconnected).
	if n := len(st.samples); n > 0 {
		prevTs := st.samples[n-1].tsUs
		if tsUs < prevTs {
			st.samples = st.samples[:0]
			st.lastEvalUs = 0
			st.lastCrossingUs = 0
			st.vtxOffSinceUs = 0
			st.vtxWakeUs = 0
			st.provisional = false
			st.packRecovery = false
		} else if tsUs-prevTs >= autoCalibStreamGapUs {
			st.samples = st.samples[:0]
			st.lastEvalUs = 0
			st.vtxOffSinceUs = 0
			st.vtxWakeUs = tsUs
			if !st.manualPinned && gate.EnterThresholds[slotPos] != 0 {
				st.packRecovery = true
			}
		}
	}

	// Record crossings before 50 ms bucket downsampling returns early so no crossing is missed.
	if crossedNow {
		st.lastCrossingUs = tsUs
	}

	// Detect VTX power-off bench periods (>= 15 s at <= -85.5 dBm with no crossings) followed by
	// VTX power-on (>= -81.5 dBm). Trimming pre-pack history keeps Pack 1's stronger peaks and
	// long -92 dBm bench dead air from blinding Pack 2 recalibration.
	if smoothedDbm <= autoCalibVtxOffDbm {
		if st.vtxOffSinceUs == 0 {
			st.vtxOffSinceUs = tsUs
		}
	} else if smoothedDbm >= autoCalibVtxWakeDbm {
		if st.vtxOffSinceUs != 0 &&
			tsUs >= st.vtxOffSinceUs+autoCalibVtxOffGapUs &&
			(st.lastCrossingUs == 0 || tsUs >= st.lastCrossingUs+autoCalibVtxOffGapUs) {
			var keepCutoff uint64
			if tsUs > autoCalibPreWakeKeepUs {
				keepCutoff = tsUs - autoCalibPreWakeKeepUs
			}
			drop := 0
			for drop < len(st.samples) && st.samples[drop].tsUs < keepCutoff {
				drop++
			}
			if drop > 0 {
				copy(st.samples, st.samples[drop:])
				st.samples = st.samples[:len(st.samples)-drop]
			}
			st.vtxWakeUs = tsUs
			st.lastEvalUs = 0
			if !st.manualPinned && gate.EnterThresholds[slotPos] != 0 {
				st.packRecovery = true
			}
		}
		st.vtxOffSinceUs = 0
	}

	// Heal any stale noise-floor threshold (< -79 dBm, e.g. from 5 GHz Wi-Fi bursts on an empty
	// channel) immediately before bucket downsampling returns early.
	healedStale := false
	if !st.manualPinned && gate.EnterThresholds[slotPos] != 0 && gate.EnterThresholds[slotPos] < autoCalibMinEnterDbm {
		gate.EnterThresholds[slotPos] = 0
		gate.ExitThresholds[slotPos] = 0
		st.provisional = false
		st.packRecovery = false
		if det != nil {
			det.RearmIfBelow(pilot.ExitThreshold)
		}
		healedStale = true
	}

	// Peak-preserving 50 ms (~20 Hz) bucket downsampling.
	if n := len(st.samples); n > 0 && tsUs-st.samples[n-1].tsUs < autoCalibBucketUs {
		if smoothedDbm > st.samples[n-1].dbm {
			st.samples[n-1].dbm = smoothedDbm
		}
		if healedStale {
			return true, gate.Role == domain.GateRoleStartFinish, nil
		}
		return false, false, nil
	}
	st.samples = append(st.samples, autoCalibSample{tsUs: tsUs, dbm: smoothedDbm})

	// Trim rolling 90 s window efficiently.
	if tsUs > autoCalibWindowUs {
		cutoff := tsUs - autoCalibWindowUs
		if len(st.samples) > autoCalibMaxBuckets || (len(st.samples) > 0 && st.samples[0].tsUs+10_000_000 < cutoff) {
			drop := 0
			for drop < len(st.samples) && st.samples[drop].tsUs < cutoff {
				drop++
			}
			if drop > 0 {
				copy(st.samples, st.samples[drop:])
				st.samples = st.samples[:len(st.samples)-drop]
			}
		}
	}

	if st.manualPinned {
		return false, false, nil
	}

	uncalibrated := gate.EnterThresholds[slotPos] == 0
	missedRecently := !uncalibrated && (st.lastCrossingUs == 0 || (tsUs > st.lastCrossingUs && tsUs-st.lastCrossingUs >= autoCalibMissedCrossUs))
	isSF := gate.Role == domain.GateRoleStartFinish
	waitingLapStart := false
	if isSF {
		prog := e.progress[pilot.SlotIndex]
		r := gate.RulesForPilot(e.rules, pilot.SlotIndex)
		waitingLapStart = prog == nil || prog.lapStartUs == 0 ||
			(prog.lastGateID != 0 && seconds(prog.lastGateTimeUs, tsUs) > r.MaxLapSec)
	}

	intervalUs := autoCalibSteadyEveryUs
	if uncalibrated || st.provisional || st.packRecovery || (isSF && waitingLapStart) {
		intervalUs = autoCalibInitialEveryUs
	} else if missedRecently {
		intervalUs = autoCalibMissedEveryUs
	}
	if st.lastEvalUs != 0 && tsUs >= st.lastEvalUs && tsUs-st.lastEvalUs < intervalUs {
		if healedStale {
			return true, isSF, nil
		}
		return false, false, nil
	}
	st.lastEvalUs = tsUs

	singleGate := len(e.gates) == 1
	curEnter := gate.EnterThresholds[slotPos]
	curExit := gate.ExitThresholds[slotPos]

	enterDbm, exitDbm, pendingExit, ok := suggestAutoThresholdForGate(
		st.samples,
		tsUs,
		singleGate,
		missedRecently || st.packRecovery,
	)
	fromSinglePass := false
	var singlePassCand *dsp.CrossingCandidate

	// Single-pass provisional lock is used on single-gate setups (no neighbour-gate bleed) and on
	// Start/Finish (`isSF`, requiring >= -64.5 dBm on multi-gate tracks) when:
	// 1. The gate is uncalibrated and Pass #1 peaked below the default threshold, OR
	// 2. The pilot returned from a battery swap (`st.packRecovery`) or post-lull start (`waitingLapStart`)
	//    and Pass #1 peaked below the prior threshold without triggering a crossing.
	if !ok && (singleGate || isSF) {
		minPeakDbm := float32(-68.0)
		if !singleGate {
			minPeakDbm = -64.5
		}
		if uncalibrated && (det == nil || !det.HasCrossed() || waitingLapStart) {
			var spPend bool
			enterDbm, exitDbm, singlePassCand, spPend, ok = suggestSinglePassProvisionalWithCandidate(
				st.samples, tsUs, pilot.EnterThreshold, minPeakDbm, false, gate.GateID, pilot.SlotIndex,
			)
			if spPend {
				pendingExit = true
			}
			fromSinglePass = ok
		} else if (st.packRecovery && (st.lastCrossingUs == 0 || st.lastCrossingUs < st.vtxWakeUs)) ||
			(isSF && waitingLapStart && (st.lastCrossingUs == 0 || (tsUs > st.lastCrossingUs && tsUs-st.lastCrossingUs >= 12_000_000))) {
			candEnter, candExit, candPeak, spPend, candOk := suggestSinglePassProvisionalWithCandidate(
				st.samples, tsUs, curEnter, minPeakDbm, true, gate.GateID, pilot.SlotIndex,
			)
			if spPend {
				pendingExit = true
			}
			if candOk && candEnter < curEnter {
				enterDbm, exitDbm, singlePassCand, ok = candEnter, candExit, candPeak, true
				fromSinglePass = true
			}
		}
	}
	if !ok {
		if pendingExit && tsUs > intervalUs {
			// A pass crest is currently exiting the gate; re-check in ~0.35 s once it settles to baseline.
			st.lastEvalUs = tsUs - intervalUs + 350_000
		}
		if healedStale {
			return true, isSF, nil
		}
		return false, false, nil
	}

	wasFastTrack := st.provisional || st.packRecovery || (fromSinglePass && isSF && waitingLapStart)
	st.provisional = fromSinglePass
	if !fromSinglePass {
		st.packRecovery = false
	}

	deadband := autoCalibDeadbandDb
	if missedRecently && enterDbm < curEnter {
		deadband = 1.0
	}
	if !uncalibrated && !wasFastTrack &&
		float32(math.Abs(float64(enterDbm-curEnter))) < deadband &&
		float32(math.Abs(float64(exitDbm-curExit))) < deadband {
		return false, false, nil
	}

	effPrevEnter := curEnter
	if effPrevEnter == 0 {
		effPrevEnter = pilot.EnterThreshold
	}

	gate.EnterThresholds[slotPos] = enterDbm
	gate.ExitThresholds[slotPos] = exitDbm
	if det != nil {
		det.RearmIfBelow(exitDbm)
	}

	// If Start/Finish just locked onto Pass #1 while waiting for a lap start (and Pass #1 peaked
	// below the prior threshold or never fired `ChannelDetector`), emit Pass #1 at its exact peak
	// timestamp so Lap 1 begins immediately instead of missing an entire lap.
	if fromSinglePass && isSF && waitingLapStart && !crossedNow && singlePassCand != nil &&
		singlePassCand.PeakRSSIDbm < effPrevEnter+1.0 &&
		tsUs >= singlePassCand.TimestampUs && tsUs-singlePassCand.TimestampUs <= 3_500_000 &&
		(st.lastCrossingUs == 0 || singlePassCand.TimestampUs > st.lastCrossingUs+3_000_000) {
		st.lastCrossingUs = singlePassCand.TimestampUs
		if det != nil {
			det.MarkRecoveredCrossing(singlePassCand.TimestampUs)
		}
		recoveredStart = singlePassCand
	}

	return true, isSF, recoveredStart
}

// suggestAutoThresholdForGate combines full-window stability with rapid regime-shift adaptation:
//   - On single-gate tracks (no neighbour-gate bleed possible), if no crossing fired in >= 10 s or
//     after a pack swap, a clean 18 s recent window (>= 2 missed passes) immediately re-locks; during
//     steady flying, a 30 s recent window adapts whenever pass strength shifts by >= 3.5 dB.
//   - On multi-gate tracks, upward shifts adapt within 30 s while downward shifts without a VTX
//     power-off wait for the 90 s window so a pilot skipping a split gate cannot lower onto bleed.
func suggestAutoThresholdForGate(
	samples []autoCalibSample,
	nowUs uint64,
	singleGate bool,
	fastRecovery bool,
) (enterDbm, exitDbm float32, pendingExit bool, ok bool) {
	var recentPending bool
	if singleGate && fastRecovery {
		if recent18 := tailAutoCalibSamples(samples, nowUs, 18_000_000); len(recent18) >= autoCalibMinBuckets {
			if en, ex, pend, ok18 := suggestAutoThresholdDbm(recent18, nowUs); ok18 {
				return en, ex, false, true
			} else if pend {
				recentPending = true
			}
		}
	}

	enFull, exFull, pendFull, okFull := suggestAutoThresholdDbm(samples, nowUs)

	if recent30 := tailAutoCalibSamples(samples, nowUs, 30_000_000); len(recent30) >= autoCalibMinBuckets && len(recent30) < len(samples) {
		if en30, ex30, pend30, ok30 := suggestAutoThresholdDbm(recent30, nowUs); ok30 {
			if singleGate {
				if !okFull || float32(math.Abs(float64(en30-enFull))) >= 3.5 {
					return en30, ex30, false, true
				}
			} else if okFull && en30 >= enFull+3.5 {
				return en30, ex30, false, true
			}
		} else if pend30 {
			recentPending = true
		}
	}

	return enFull, exFull, pendFull || recentPending, okFull
}

func tailAutoCalibSamples(samples []autoCalibSample, nowUs, spanUs uint64) []autoCalibSample {
	if len(samples) == 0 || nowUs <= spanUs {
		return samples
	}
	cutoff := nowUs - spanUs
	idx := sort.Search(len(samples), func(i int) bool {
		return samples[i].tsUs >= cutoff
	})
	return samples[idx:]
}

// trimLeadingVtxSilence slices off an early VTX-off silence stretch (>= 15 s continuously <= -85.5 dBm)
// when followed by >= 3.2 s of active VTX telemetry reaching >= -81.5 dBm, keeping 2 s of pre-wakeup
// floor so an immediate takeoff pass retains its left flank.
func trimLeadingVtxSilence(samples []autoCalibSample) []autoCalibSample {
	n := len(samples)
	if n < autoCalibMinBuckets {
		return samples
	}
	bestWakeIdx := -1
	quietStartIdx := -1
	for i := 0; i < n; i++ {
		if samples[i].dbm <= autoCalibVtxOffDbm {
			if quietStartIdx < 0 {
				quietStartIdx = i
			}
		} else if samples[i].dbm >= autoCalibVtxWakeDbm {
			if quietStartIdx >= 0 && samples[i].tsUs >= samples[quietStartIdx].tsUs+autoCalibVtxOffGapUs {
				bestWakeIdx = i
			}
			quietStartIdx = -1
		}
	}
	if bestWakeIdx <= 0 {
		return samples
	}
	// Only trim if the post-wakeup tail has enough duration and active signal to evaluate.
	var keepCutoff uint64
	if samples[bestWakeIdx].tsUs > autoCalibPreWakeKeepUs {
		keepCutoff = samples[bestWakeIdx].tsUs - autoCalibPreWakeKeepUs
	}
	startIdx := sort.Search(n, func(i int) bool {
		return samples[i].tsUs >= keepCutoff
	})
	rem := samples[startIdx:]
	if len(rem) < autoCalibMinBuckets || rem[len(rem)-1].tsUs < rem[0].tsUs+autoCalibMinSpanUs {
		return samples
	}
	return rem
}

// hasPrePassLull reports whether `samples` contains a quiet VTX-off / distant lull (at least 4
// buckets <= -84.0 dBm) within the 30 s preceding `peakTsUs`. Pilots commonly power on near the
// Start/Finish gate after a lull ("no signal -> a little bit of signal -> pass spike -> fly away").
func hasPrePassLull(samples []autoCalibSample, peakTsUs uint64) bool {
	var minTs uint64
	if peakTsUs > 30_000_000 {
		minTs = peakTsUs - 30_000_000
	}
	quietCount := 0
	for i := 0; i < len(samples) && samples[i].tsUs < peakTsUs; i++ {
		if samples[i].tsUs < minTs {
			continue
		}
		if samples[i].dbm <= -84.0 {
			quietCount++
			if quietCount >= 4 {
				return true
			}
		}
	}
	return false
}

// measureNearPreValley returns the minimum sample strictly inside `[peakTsUs - 2.5s, peakTsUs)`.
func measureNearPreValley(samples []autoCalibSample, peakIdx int) (float32, bool) {
	if peakIdx <= 0 {
		return 0, false
	}
	peakTs := samples[peakIdx].tsUs
	var minVal float32
	found := false
	for j := peakIdx - 1; j >= 0 && peakTs-samples[j].tsUs <= 2_500_000; j-- {
		if !found || samples[j].dbm < minVal {
			minVal = samples[j].dbm
			found = true
		}
	}
	return minVal, found
}

// suggestSinglePassProvisionalDbm locks in a provisional threshold right after a single clean
// bell-curve gate pass completes (used by tests and single-gate callers).
func suggestSinglePassProvisionalDbm(
	samples []autoCalibSample,
	nowUs uint64,
	refEnter float32,
	allowLowerBelowRef bool,
) (enterDbm, exitDbm float32, ok bool) {
	en, ex, _, _, ok := suggestSinglePassProvisionalWithCandidate(samples, nowUs, refEnter, -68.0, allowLowerBelowRef, 1, 1)
	return en, ex, ok
}

// suggestSinglePassProvisionalWithCandidate locks in a provisional threshold right after a single
// clean gate pass completes (including the typical "no signal -> power-on hover near start gate ->
// pass spike -> fly away" takeoff pattern) and returns a synthesized `CrossingCandidate` at the
// measured peak timestamp so Start/Finish can retroactively start Lap 1 if the prior threshold missed it.
func suggestSinglePassProvisionalWithCandidate(
	rawSamples []autoCalibSample,
	nowUs uint64,
	refEnter float32,
	minPeakDbm float32,
	allowLowerBelowRef bool,
	gateID uint8,
	slotIndex int,
) (enterDbm, exitDbm float32, cand *dsp.CrossingCandidate, pendingExit bool, ok bool) {
	samples := trimLeadingVtxSilence(rawSamples)
	n := len(samples)
	if n < 40 {
		return 0, 0, nil, false, false
	}
	if samples[n-1].tsUs < samples[0].tsUs || samples[n-1].tsUs-samples[0].tsUs < 2_000_000 {
		return 0, 0, nil, false, false
	}
	sorted := make([]float32, n)
	for i, s := range samples {
		sorted[i] = s.dbm
	}
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	floor := percentileF32(sorted, 0.20)
	lowFloor := percentileF32(sorted, 0.10)
	if lowFloor > -55.0 {
		return 0, 0, nil, false, false
	}

	bestIdx := -1
	var bestVal float32
	for i := 2; i < n-2; i++ {
		if samples[i].dbm >= minPeakDbm && samples[i].dbm >= lowFloor+5.5 && (bestIdx < 0 || samples[i].dbm > bestVal) {
			bestIdx = i
			bestVal = samples[i].dbm
		}
	}
	if bestIdx < 0 || (nowUs > samples[bestIdx].tsUs && nowUs-samples[bestIdx].tsUs > autoCalibFreshPassUs) {
		return 0, 0, nil, false, false
	}

	// If the latest samples are still actively descending right after the pass crest, wait ~0.35 s
	// for the departure valley to finish settling so `postMin` reflects the true track baseline.
	if nowUs >= samples[bestIdx].tsUs && nowUs-samples[bestIdx].tsUs <= 2_000_000 &&
		n >= 4 && samples[n-3].dbm-samples[n-1].dbm > 1.0 {
		return 0, 0, nil, true, false
	}

	// Measure local pre-pass and post-pass valleys inside +-8 s around bestIdx.
	var preMin float32
	hasPre := false
	for j := bestIdx - 1; j >= 0 && samples[bestIdx].tsUs-samples[j].tsUs <= autoCalibLocalValleyUs; j-- {
		if !hasPre || samples[j].dbm < preMin {
			preMin = samples[j].dbm
			hasPre = true
		}
	}
	if !hasPre {
		return 0, 0, nil, false, false
	}
	postMin := samples[bestIdx+1].dbm
	for j := bestIdx + 1; j < n && samples[j].tsUs-samples[bestIdx].tsUs <= autoCalibLocalValleyUs; j++ {
		if samples[j].dbm < postMin {
			postMin = samples[j].dbm
		}
	}

	nearPreMin, hasNearPre := measureNearPreValley(samples, bestIdx)
	if !hasNearPre {
		nearPreMin = preMin
	}
	preLull := hasPrePassLull(rawSamples, samples[bestIdx].tsUs)

	localBase := preMin
	if postMin > localBase {
		localBase = postMin
	}
	leftBase := localBase
	rightBase := postMin
	if preMin > rightBase && !preLull {
		rightBase = preMin
	}

	symmetricOk := bestVal-localBase >= autoCalibMinPeakRiseDb && nearPreMin <= rightBase+3.5
	// Post-lull takeoff near gate: channel was quiet (`preLull`), pilot powered on near the gate
	// ("a little bit of signal" at `nearPreMin`), spiked >= 5.5 dB higher through the gate (`bestVal`),
	// and departed >= 11.0 dB lower (`postMin`) around the course.
	lullTakeoffOk := preLull && bestVal-nearPreMin >= 5.5 && bestVal-postMin >= 11.0
	if !symmetricOk && !lullTakeoffOk {
		if nowUs >= samples[bestIdx].tsUs && nowUs-samples[bestIdx].tsUs <= 2_500_000 {
			return 0, 0, nil, true, false
		}
		return 0, 0, nil, false, false
	}
	if lullTakeoffOk && nearPreMin > postMin+3.0 {
		leftBase = nearPreMin
		rightBase = postMin
	} else {
		leftBase = localBase
		rightBase = localBase
	}

	leftHalf := leftBase + 0.5*(bestVal-leftBase)
	rightHalf := rightBase + 0.5*(bestVal-rightBase)
	leftIdx := -1
	for j := bestIdx - 1; j >= 0; j-- {
		if samples[j].dbm <= leftHalf {
			leftIdx = j
			break
		}
	}
	rightIdx := -1
	for j := bestIdx + 1; j < n; j++ {
		if samples[j].dbm <= rightHalf {
			rightIdx = j
			break
		}
	}
	if leftIdx < 0 || rightIdx < 0 {
		if rightIdx < 0 && nowUs >= samples[bestIdx].tsUs && nowUs-samples[bestIdx].tsUs <= 2_500_000 {
			return 0, 0, nil, true, false
		}
		return 0, 0, nil, false, false
	}
	fwhmUs := samples[rightIdx].tsUs - samples[leftIdx].tsUs
	if rightIdx-leftIdx < 4 || fwhmUs < autoCalibMinPassFwhmUs || fwhmUs > 5_000_000 {
		return 0, 0, nil, false, false
	}
	areaDbSec, skirtOk := evalPassSkirtAndAreaWithBases(samples, bestIdx, bestVal, leftBase, rightBase)
	if !skirtOk {
		return 0, 0, nil, false, false
	}

	// Require the post-pass tail after `rightIdx` to have settled near `rightBase`.
	tailMin := samples[rightIdx].dbm
	for j := rightIdx; j < n; j++ {
		if samples[j].dbm < tailMin {
			tailMin = samples[j].dbm
		}
	}
	if tailMin > rightBase+0.35*(bestVal-rightBase) {
		return 0, 0, nil, true, false
	}
	activeFloor := postMin
	if activeFloor <= -85.0 {
		activeFloor = floor
	}
	enter := float32(math.Round(float64(activeFloor + 0.50*(bestVal-activeFloor))))
	if bestVal-5.0 < enter {
		enter = bestVal - 5.0
	}
	// On initial uncalibrated lock, never tighten above the pilot's default enter threshold from a
	// single pass before line-to-line peak variance is observed across >= 2 passes.
	if !allowLowerBelowRef && refEnter < 0 && refEnter < enter && refEnter >= activeFloor+6.0 {
		enter = refEnter
	}
	if activeFloor+6.0 > enter {
		enter = activeFloor + 6.0
	}
	if enter < autoCalibMinEnterDbm {
		enter = autoCalibMinEnterDbm
	}
	enterDbm = clampDbm(enter)
	exitCand := enterDbm - 6.0
	if activeFloor > -85.0 && float32(math.Ceil(float64(activeFloor)))+2.0 > exitCand {
		exitCand = float32(math.Ceil(float64(activeFloor))) + 2.0
	}
	if enterDbm-4.0 < exitCand {
		exitCand = enterDbm - 4.0
	}
	exitDbm = clampExitDbm(exitCand, enterDbm)

	bwMs := math.Max(40.0, math.Round(float64(fwhmUs)/1000.0*10)/10)
	speedMph := math.Max(18.0, math.Min(98.0, math.Round((3.60/(bwMs/1000.0))*2.23694*10)/10))
	var aboveEnterMs, aboveEnterArea float64
	for k := leftIdx; k < rightIdx && k+1 < n; k++ {
		if samples[k+1].tsUs <= samples[k].tsUs {
			continue
		}
		dtSec := math.Min(0.25, float64(samples[k+1].tsUs-samples[k].tsUs)/1e6)
		h0 := math.Max(0, float64(samples[k].dbm-enterDbm))
		h1 := math.Max(0, float64(samples[k+1].dbm-enterDbm))
		if h0 > 0 || h1 > 0 {
			aboveEnterMs += dtSec * 1000.0
			aboveEnterArea += 0.5 * (h0 + h1) * dtSec
		}
	}
	if aboveEnterMs < bwMs*0.6 {
		aboveEnterMs = bwMs * 0.6
	}
	if aboveEnterArea < 0.5*float64(bestVal-enterDbm)*(aboveEnterMs/1000.0) {
		aboveEnterArea = 0.5 * float64(bestVal-enterDbm) * (aboveEnterMs / 1000.0)
	}
	cand = &dsp.CrossingCandidate{
		GateID:              gateID,
		SlotIndex:           slotIndex,
		TimestampUs:         samples[bestIdx].tsUs,
		PeakRSSIDbm:         bestVal,
		LapRFPeakHeight:     float32(math.Max(400, math.Min(3900, float64(bestVal+95.0)*46.0))),
		BeamwidthMs:         bwMs,
		EstimatedSpeedMph:   speedMph,
		HoldMs:              math.Round(math.Max(aboveEnterMs*1.3, bwMs*1.4)*10) / 10,
		AboveEnterMs:        math.Round(aboveEnterMs*10) / 10,
		AboveEnterAreaDbSec: math.Round(aboveEnterArea*100) / 100,
		PassAreaDbSec:       math.Round(areaDbSec*100) / 100,
	}
	return enterDbm, exitDbm, cand, false, true
}

// suggestAutoThresholdDbm analyzes recent 20 Hz smoothed RSSI buckets for one (gate, pilot) and
// returns `(enterDbm, exitDbm, passStillExiting, ok)` when the history contains genuine lap-like
// gate pass waveforms (>= 2 distinct bell-curve excursions rising >= 9.5 dB above local valleys,
// including post-lull takeoff passes after powering on near a gate).
func suggestAutoThresholdDbm(rawSamples []autoCalibSample, nowUs uint64) (enterDbm, exitDbm float32, pendingExit bool, ok bool) {
	samples := trimLeadingVtxSilence(rawSamples)
	n := len(samples)
	if n < autoCalibMinBuckets {
		return 0, 0, false, false
	}
	if samples[n-1].tsUs < samples[0].tsUs || samples[n-1].tsUs-samples[0].tsUs < autoCalibMinSpanUs {
		return 0, 0, false, false
	}

	sorted := make([]float32, n)
	for i, s := range samples {
		sorted[i] = s.dbm
	}
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })

	floor := percentileF32(sorted, 0.20)
	// A baseline above -55 dBm means a VTX is sitting powered right next to the gate continuously,
	// not flying laps around a course.
	if floor > -55.0 {
		return 0, 0, false, false
	}
	noiseCeiling := percentileF32(sorted, 0.65)

	// 1. Find local maxima rising above their adjacent +-8 s approach/departure valleys that form
	// bounded bell-curve excursions (supporting both symmetric lap passes and post-lull power-on
	// takeoff passes where the pilot hovers near the start gate before spiking through it).
	var peaks []autoCalibPeak
	for i := 0; i < n; i++ {
		v := samples[i].dbm
		if v < autoCalibMinAbsPeakDbm || v < floor+5.5 {
			continue
		}
		ts := samples[i].tsUs
		isMax := true
		for j := i - 1; j >= 0 && ts-samples[j].tsUs <= autoCalibLocalMaxSepUs; j-- {
			if samples[j].dbm > v || (samples[j].dbm == v && j < i) {
				isMax = false
				break
			}
		}
		for j := i + 1; isMax && j < n && samples[j].tsUs-ts <= autoCalibLocalMaxSepUs; j++ {
			if samples[j].dbm > v {
				isMax = false
			}
		}
		if !isMax {
			continue
		}

		// Measure local valleys within +-8 s around this peak candidate.
		leftMin := v
		for j := i - 1; j >= 0 && ts-samples[j].tsUs <= autoCalibLocalValleyUs; j-- {
			if samples[j].dbm < leftMin {
				leftMin = samples[j].dbm
			}
		}
		rightMin := v
		for j := i + 1; j < n && samples[j].tsUs-ts <= autoCalibLocalValleyUs; j++ {
			if samples[j].dbm < rightMin {
				rightMin = samples[j].dbm
			}
		}
		if v-rightMin < autoCalibMinPeakRiseDb {
			if nowUs >= ts && nowUs-ts <= 3_000_000 && samples[n-1].tsUs-ts <= 3_000_000 {
				pendingExit = true
			}
			continue
		}
		nearLeftMin, hasNearLeft := measureNearPreValley(samples, i)
		if !hasNearLeft {
			nearLeftMin = leftMin
		}
		localBase := leftMin
		if rightMin > localBase {
			localBase = rightMin
		}
		symmetricOk := v >= floor+autoCalibMinPeakRiseDb && v-localBase >= autoCalibMinPeakRiseDb && nearLeftMin <= rightMin+3.5
		lullTakeoffOk := len(peaks) == 0 && hasPrePassLull(rawSamples, ts) && v-nearLeftMin >= 5.5 && v-rightMin >= 11.0
		if !symmetricOk && !lullTakeoffOk {
			continue
		}
		leftBase := localBase
		rightBase := localBase
		if lullTakeoffOk && nearLeftMin > rightMin+3.0 {
			leftBase = nearLeftMin
			rightBase = rightMin
		}

		// Verify bell-curve waveform shape: both sides must fall back to/below local half-prominence
		// within a realistic gate-pass FWHM (280 ms .. 6.5 s).
		leftHalf := leftBase + 0.5*(v-leftBase)
		rightHalf := rightBase + 0.5*(v-rightBase)
		leftIdx := -1
		for j := i - 1; j >= 0; j-- {
			if samples[j].dbm <= leftHalf {
				leftIdx = j
				break
			}
		}
		if leftIdx < 0 {
			continue
		}
		rightIdx := -1
		for j := i + 1; j < n; j++ {
			if samples[j].dbm <= rightHalf {
				rightIdx = j
				break
			}
		}
		if rightIdx < 0 {
			if nowUs >= ts && nowUs-ts <= 3_000_000 {
				pendingExit = true
			}
			continue
		}
		fwhmUs := samples[rightIdx].tsUs - samples[leftIdx].tsUs
		if rightIdx-leftIdx < 4 || fwhmUs < autoCalibMinPassFwhmUs || fwhmUs > autoCalibMaxPassFwhmUs {
			continue
		}
		if _, skirtOk := evalPassSkirtAndAreaWithBases(samples, i, v, leftBase, rightBase); !skirtOk {
			continue
		}

		// Merge multipass wobble closer than autoCalibMinPassSepUs (1.8 s), keeping the stronger peak.
		if m := len(peaks); m > 0 && ts-peaks[m-1].tsUs < autoCalibMinPassSepUs {
			if v > peaks[m-1].dbm {
				peaks[m-1] = autoCalibPeak{tsUs: ts, dbm: v}
			}
			continue
		}
		peaks = append(peaks, autoCalibPeak{tsUs: ts, dbm: v})
	}

	if len(peaks) < 2 {
		return 0, 0, pendingExit, false
	}

	peakVals := make([]float32, len(peaks))
	for i, p := range peaks {
		peakVals[i] = p.dbm
	}
	sort.Slice(peakVals, func(i, j int) bool { return peakVals[i] < peakVals[j] })
	strong := percentileF32(peakVals, 0.90)

	// Estimate active VTX-on valley baseline between candidate peaks so prominence filtering isn't
	// skewed downward by -92 dBm VTX-off tails.
	prelimValleys := measureInterPeakValleys(samples, peaks)
	prelimFloor := floor
	if len(prelimValleys) > 0 {
		prelimFloor = medianSortedF32(prelimValleys)
	}

	// Keep genuine passes (at least 45% of strong prominence above active baseline) and ignore weak
	// neighbour-gate bleed bumps.
	minPassDbm := prelimFloor + 0.45*(strong-prelimFloor)
	passPeaks := make([]autoCalibPeak, 0, len(peaks))
	passVals := make([]float32, 0, len(peaks))
	var latestPassUs uint64
	for _, p := range peaks {
		if p.dbm >= minPassDbm {
			passPeaks = append(passPeaks, p)
			passVals = append(passVals, p.dbm)
			if p.tsUs > latestPassUs {
				latestPassUs = p.tsUs
			}
		}
	}
	if len(passVals) < 2 {
		return 0, 0, pendingExit, false
	}
	// Only re-calibrate while the pilot is actively flying (at least one pass in the last 35 s).
	if nowUs > latestPassUs && nowUs-latestPassUs > autoCalibFreshPassUs {
		return 0, 0, false, false
	}

	// Measure actual inter-pass valleys between consecutive passes (while the VTX is powered on).
	// Without this, a VTX-off segment (-91 dBm) in the 90 s buffer drags global p20 `floor` down
	// to -91 dBm even when indoor/small-track inter-pass valleys sit around -74 dBm, placing
	// `exitDbm` below the valleys so the detector never exits the gate.
	interPassValleys := measureInterPeakValleys(samples, passPeaks)
	activeFloor := floor
	valleyHigh := floor
	hasMeasuredValleys := len(interPassValleys) > 0
	if hasMeasuredValleys {
		activeFloor = medianSortedF32(interPassValleys)
		valleyHigh = percentileF32(interPassValleys, 0.75)
	}

	// Duty-cycle check over the active flying span `[firstPass..lastPass]`: the median sample across
	// active laps must sit closer to the valley than to the pass crest (allows fast 5-6 s laps with
	// 2.0 s indoor beamwidths while still rejecting high-duty-cycle bench plateaus).
	firstUs := passPeaks[0].tsUs
	lastUs := passPeaks[len(passPeaks)-1].tsUs
	if lastUs > firstUs {
		var activeSpanVals []float32
		for i := 0; i < n; i++ {
			if samples[i].tsUs >= firstUs && samples[i].tsUs <= lastUs {
				activeSpanVals = append(activeSpanVals, samples[i].dbm)
			}
		}
		if len(activeSpanVals) >= 10 {
			sort.Slice(activeSpanVals, func(i, j int) bool { return activeSpanVals[i] < activeSpanVals[j] })
			activeMedian := medianSortedF32(activeSpanVals)
			if (activeMedian - activeFloor) > 0.65*(strong-activeFloor) {
				return 0, 0, false, false
			}
		}
	}

	sort.Slice(passVals, func(i, j int) bool { return passVals[i] < passVals[j] })
	peak := medianSortedF32(passVals)
	weak := percentileF32(passVals, 0.25)

	enter := activeFloor + 0.52*(peak-activeFloor)
	if weak-3.5 < enter {
		enter = weak - 3.5
	}
	if valleyHigh+4.5 > enter {
		enter = valleyHigh + 4.5
	}
	if activeFloor+6.0 > enter {
		enter = activeFloor + 6.0
	}
	if !hasMeasuredValleys && noiseCeiling+3.0 > enter {
		enter = noiseCeiling + 3.0
	}
	if enter < autoCalibMinEnterDbm {
		enter = autoCalibMinEnterDbm
	}
	enterDbm = clampDbm(float32(math.Round(float64(enter))))

	rawExit := float32(math.Round(float64(activeFloor + 0.25*(peak-activeFloor))))
	valleyClear := float32(math.Ceil(float64(valleyHigh))) + 2.0
	minHyst := float32(5.0)
	if hasMeasuredValleys {
		minHyst = 4.0
	} else {
		valleyClear = float32(math.Round(float64(activeFloor))) + 4.0
	}
	exitCand := rawExit
	if valleyClear > exitCand {
		exitCand = valleyClear
	}
	if enterDbm-minHyst < exitCand {
		exitCand = enterDbm - minHyst
	}
	exitDbm = clampExitDbm(exitCand, enterDbm)
	return enterDbm, exitDbm, false, true
}

// measureInterPeakValleys returns sorted active VTX-on valley minima (> -85 dBm) between consecutive
// peaks separated by <= 25 s.
func measureInterPeakValleys(samples []autoCalibSample, peaks []autoCalibPeak) []float32 {
	n := len(samples)
	var valleys []float32
	sampleIdx := 0
	for k := 0; k < len(peaks)-1; k++ {
		t0 := peaks[k].tsUs
		t1 := peaks[k+1].tsUs
		if t1 <= t0 || t1-t0 > 25_000_000 {
			continue
		}
		for sampleIdx < n && samples[sampleIdx].tsUs <= t0 {
			sampleIdx++
		}
		vMin := float32(0.0)
		hasMin := false
		for j := sampleIdx; j < n && samples[j].tsUs < t1; j++ {
			if !hasMin || samples[j].dbm < vMin {
				vMin = samples[j].dbm
				hasMin = true
			}
		}
		if hasMin && vMin > -85.0 {
			valleys = append(valleys, vMin)
		}
	}
	if len(valleys) > 1 {
		sort.Slice(valleys, func(i, j int) bool { return valleys[i] < valleys[j] })
	}
	return valleys
}

// hasValidPassSkirtAndArea distinguishes genuine inverse-square drone approach/departure curves
// from abrupt 5 GHz Wi-Fi / RF packet bursts by requiring >= 440 ms skirt span and >= 4.5 dB*s area.
func hasValidPassSkirtAndArea(samples []autoCalibSample, peakIdx int, localBase float32) bool {
	_, ok := evalPassSkirtAndAreaWithBases(samples, peakIdx, samples[peakIdx].dbm, localBase, localBase)
	return ok
}

func evalPassSkirtAndAreaWithBases(
	samples []autoCalibSample,
	peakIdx int,
	peakVal float32,
	leftBase float32,
	rightBase float32,
) (float64, bool) {
	n := len(samples)
	leftMargin := float32(3.5)
	if m := 0.35 * (peakVal - leftBase); m < leftMargin {
		leftMargin = m
	}
	if leftMargin < 2.0 {
		leftMargin = 2.0
	}
	leftSkirt := leftBase + leftMargin
	rightSkirt := rightBase + 3.5

	sLeft := peakIdx
	for sLeft > 0 && samples[sLeft-1].dbm >= leftSkirt && samples[peakIdx].tsUs-samples[sLeft-1].tsUs <= 4_500_000 {
		sLeft--
	}
	sRight := peakIdx
	for sRight+1 < n && samples[sRight+1].dbm >= rightSkirt && samples[sRight+1].tsUs-samples[peakIdx].tsUs <= 4_500_000 {
		sRight++
	}
	if samples[sRight].tsUs <= samples[sLeft].tsUs || samples[sRight].tsUs-samples[sLeft].tsUs < autoCalibMinPassSkirtUs {
		return 0, false
	}
	riseUs := samples[peakIdx].tsUs - samples[sLeft].tsUs
	fallUs := samples[sRight].tsUs - samples[peakIdx].tsUs
	if riseUs < autoCalibMinFlankUs || fallUs < autoCalibMinFlankUs {
		return 0, false
	}
	var areaDbSec float64
	for k := sLeft + 1; k <= sRight; k++ {
		if samples[k].tsUs <= samples[k-1].tsUs {
			continue
		}
		dtSec := float64(samples[k].tsUs-samples[k-1].tsUs) / 1e6
		if dtSec > 0.25 {
			dtSec = 0.25
		}
		h0 := math.Max(0, float64(samples[k-1].dbm-rightBase))
		h1 := math.Max(0, float64(samples[k].dbm-rightBase))
		areaDbSec += 0.5 * (h0 + h1) * dtSec
	}
	return areaDbSec, areaDbSec >= autoCalibMinPassAreaDbS
}

func percentileF32(sorted []float32, p float64) float32 {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(math.Floor(p * float64(len(sorted)-1)))
	if idx < 0 {
		idx = 0
	} else if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

func medianSortedF32(sorted []float32) float32 {
	n := len(sorted)
	if n == 0 {
		return 0
	}
	if n%2 == 1 {
		return sorted[n/2]
	}
	return 0.5 * (sorted[n/2-1] + sorted[n/2])
}
