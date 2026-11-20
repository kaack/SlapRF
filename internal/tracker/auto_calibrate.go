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

	autoCalibMinBuckets    int     = 70        // ~3.5 s of 20 Hz history
	autoCalibMinSpanUs     uint64  = 3_200_000 // >= 3.2 s wall-clock span
	autoCalibMinPeakRiseDb float32 = 9.5       // Pass peak must rise >= 9.5 dB above local valley baseline (supports indoor 10-12 dB swings)
	autoCalibLocalMaxSepUs uint64  = 400_000   // Multipath crests < 400 ms apart belong to the same pass
	autoCalibLocalValleyUs uint64  = 8_000_000 // Measure adjacent approach/departure valleys within +-8 s of each peak
	autoCalibMinPassSepUs  uint64  = 1_800_000 // Distinct lap fly-bys must be >= 1.8 s apart
	autoCalibMinPassFwhmUs uint64  = 150_000   // Reject < 150 ms impulse glitches (< 3 buckets above half-prominence)
	autoCalibMaxPassFwhmUs uint64  = 6_500_000 // Reject > 6.5 s parked/bench VTX plateaus
	autoCalibDeadbandDb    float32 = 1.5       // Skip minor updates smaller than 1.5 dB during steady flying
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
// Returns `(changedConfig, changedStartFinish)`. Caller holds `e.mu` write lock.
func (e *Engine) recordAutoCalibSampleLocked(
	gate *domain.TrackGate,
	slotPos int,
	pilot domain.PilotSlot,
	det *dsp.ChannelDetector,
	smoothedDbm float32,
	tsUs uint64,
	crossedNow bool,
) (changed bool, sfChanged bool) {
	if gate == nil || slotPos < 0 || slotPos >= len(gate.EnterThresholds) {
		return false, false
	}
	if !pilot.Enabled || pilot.Channel == 0 || pilot.FrequencyMHz < 5180 {
		return false, false
	}
	// Ignore invalid / survey-silenced / non-dBm readings.
	if smoothedDbm <= -120 || smoothedDbm >= -5 {
		return false, false
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

	// Peak-preserving 50 ms (~20 Hz) bucket downsampling.
	if n := len(st.samples); n > 0 && tsUs-st.samples[n-1].tsUs < autoCalibBucketUs {
		if smoothedDbm > st.samples[n-1].dbm {
			st.samples[n-1].dbm = smoothedDbm
		}
		return false, false
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
		return false, false
	}

	uncalibrated := gate.EnterThresholds[slotPos] == 0
	missedRecently := !uncalibrated && (st.lastCrossingUs == 0 || (tsUs > st.lastCrossingUs && tsUs-st.lastCrossingUs >= autoCalibMissedCrossUs))

	intervalUs := autoCalibSteadyEveryUs
	if uncalibrated || st.provisional || st.packRecovery {
		intervalUs = autoCalibInitialEveryUs
	} else if missedRecently {
		intervalUs = autoCalibMissedEveryUs
	}
	if st.lastEvalUs != 0 && tsUs >= st.lastEvalUs && tsUs-st.lastEvalUs < intervalUs {
		return false, false
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

	// Single-pass provisional lock is only used on single-gate setups (where neighbour-gate bleed
	// cannot exist) when either:
	// 1. The gate is uncalibrated and Pass #1 was too weak to cross the default threshold, OR
	// 2. The pilot just returned from a battery swap (`st.packRecovery`) and Pass #1 peaked below
	//    the previous pack's threshold without triggering a crossing.
	if !ok && singleGate {
		if uncalibrated && (det == nil || !det.HasCrossed()) {
			enterDbm, exitDbm, ok = suggestSinglePassProvisionalDbm(st.samples, tsUs, pilot.EnterThreshold, false)
			fromSinglePass = ok
		} else if st.packRecovery && (st.lastCrossingUs == 0 || st.lastCrossingUs < st.vtxWakeUs) {
			candEnter, candExit, candOk := suggestSinglePassProvisionalDbm(st.samples, tsUs, curEnter, true)
			if candOk && candEnter < curEnter {
				enterDbm, exitDbm, ok = candEnter, candExit, true
				fromSinglePass = true
			}
		}
	}
	if !ok {
		if pendingExit && tsUs > intervalUs {
			// A pass crest is currently exiting the gate; re-check in ~0.6 s once it returns to baseline.
			st.lastEvalUs = tsUs - intervalUs + 600_000
		}
		return false, false
	}

	wasFastTrack := st.provisional || st.packRecovery
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
		return false, false
	}

	gate.EnterThresholds[slotPos] = enterDbm
	gate.ExitThresholds[slotPos] = exitDbm
	if det != nil {
		det.RearmIfBelow(exitDbm)
	}
	return true, gate.Role == domain.GateRoleStartFinish
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

// suggestSinglePassProvisionalDbm locks in a provisional threshold right after a single clean
// bell-curve gate pass completes on a single-gate setup (so the very next pass already counts
// instead of missing 2 laps), and is refined automatically as soon as Pass #2 completes.
func suggestSinglePassProvisionalDbm(
	samples []autoCalibSample,
	nowUs uint64,
	refEnter float32,
	allowLowerBelowRef bool,
) (enterDbm, exitDbm float32, ok bool) {
	samples = trimLeadingVtxSilence(samples)
	n := len(samples)
	if n < autoCalibMinBuckets {
		return 0, 0, false
	}
	if samples[n-1].tsUs < samples[0].tsUs || samples[n-1].tsUs-samples[0].tsUs < autoCalibMinSpanUs {
		return 0, 0, false
	}
	sorted := make([]float32, n)
	for i, s := range samples {
		sorted[i] = s.dbm
	}
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	floor := percentileF32(sorted, 0.20)
	if floor > -55.0 {
		return 0, 0, false
	}

	bestIdx := -1
	var bestVal float32
	for i := 2; i < n-2; i++ {
		if samples[i].dbm >= -68.0 && samples[i].dbm >= floor+autoCalibMinPeakRiseDb && (bestIdx < 0 || samples[i].dbm > bestVal) {
			bestIdx = i
			bestVal = samples[i].dbm
		}
	}
	if bestIdx < 0 || (nowUs > samples[bestIdx].tsUs && nowUs-samples[bestIdx].tsUs > autoCalibFreshPassUs) {
		return 0, 0, false
	}

	// Measure local pre-pass and post-pass valleys so indoor VTX-on room baselines (-74 dBm) work
	// identically even if pre-power-on samples sat at -92 dBm.
	preMin := samples[0].dbm
	for j := 0; j < bestIdx; j++ {
		if samples[j].tsUs+autoCalibLocalValleyUs >= samples[bestIdx].tsUs && samples[j].dbm < preMin {
			preMin = samples[j].dbm
		} else if j == 0 {
			preMin = samples[j].dbm
		}
	}
	// Recompute preMin strictly inside [bestTs - 8s, bestTs).
	hasPre := false
	for j := bestIdx - 1; j >= 0 && samples[bestIdx].tsUs-samples[j].tsUs <= autoCalibLocalValleyUs; j-- {
		if !hasPre || samples[j].dbm < preMin {
			preMin = samples[j].dbm
			hasPre = true
		}
	}
	if !hasPre {
		return 0, 0, false
	}
	postMin := samples[bestIdx+1].dbm
	for j := bestIdx + 1; j < n && samples[j].tsUs-samples[bestIdx].tsUs <= autoCalibLocalValleyUs; j++ {
		if samples[j].dbm < postMin {
			postMin = samples[j].dbm
		}
	}
	localBase := preMin
	if postMin > localBase {
		localBase = postMin
	}
	if bestVal-localBase < autoCalibMinPeakRiseDb {
		return 0, 0, false
	}

	halfLvl := localBase + 0.5*(bestVal-localBase)
	leftIdx := -1
	for j := bestIdx - 1; j >= 0; j-- {
		if samples[j].dbm <= halfLvl {
			leftIdx = j
			break
		}
	}
	rightIdx := -1
	for j := bestIdx + 1; j < n; j++ {
		if samples[j].dbm <= halfLvl {
			rightIdx = j
			break
		}
	}
	if leftIdx < 0 || rightIdx < 0 {
		return 0, 0, false
	}
	fwhmUs := samples[rightIdx].tsUs - samples[leftIdx].tsUs
	if rightIdx-leftIdx < 4 || fwhmUs < autoCalibMinPassFwhmUs || fwhmUs > 5_000_000 {
		return 0, 0, false
	}

	// Require the post-pass tail after `rightIdx` to have settled near `localBase`.
	tailMin := samples[rightIdx].dbm
	for j := rightIdx; j < n; j++ {
		if samples[j].dbm < tailMin {
			tailMin = samples[j].dbm
		}
	}
	if tailMin > localBase+0.35*(bestVal-localBase) {
		return 0, 0, false
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
	enterDbm = clampDbm(enter)
	exitCand := enterDbm - 6.0
	if activeFloor > -85.0 && float32(math.Ceil(float64(activeFloor)))+2.0 > exitCand {
		exitCand = float32(math.Ceil(float64(activeFloor))) + 2.0
	}
	if enterDbm-4.0 < exitCand {
		exitCand = enterDbm - 4.0
	}
	exitDbm = clampExitDbm(exitCand, enterDbm)
	return enterDbm, exitDbm, true
}

// suggestAutoThresholdDbm analyzes recent 20 Hz smoothed RSSI buckets for one (gate, pilot) and
// returns `(enterDbm, exitDbm, passStillExiting, ok)` when the history contains genuine lap-like
// gate pass waveforms (>= 2 distinct bell-curve excursions rising >= 12 dB above local valleys).
func suggestAutoThresholdDbm(samples []autoCalibSample, nowUs uint64) (enterDbm, exitDbm float32, pendingExit bool, ok bool) {
	samples = trimLeadingVtxSilence(samples)
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

	// 1. Find local maxima rising >= 12 dB above their adjacent +-8 s approach/departure valleys
	// that form bounded bell-curve excursions. Using local valleys rather than global p20 `floor`
	// ensures indoor/tight-track passes (-59 dBm peaks over -74 dBm VTX-on room valleys) are still
	// recognized cleanly even when part of the 90 s buffer contains -92 dBm VTX-off silence.
	var peaks []autoCalibPeak
	for i := 0; i < n; i++ {
		v := samples[i].dbm
		if v < floor+autoCalibMinPeakRiseDb {
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
		if v-leftMin < autoCalibMinPeakRiseDb {
			continue
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
		localBase := leftMin
		if rightMin > localBase {
			localBase = rightMin
		}

		// Verify bell-curve waveform shape: both sides must fall back to/below local half-prominence
		// within a realistic gate-pass FWHM (150 ms .. 6.5 s).
		halfLvl := localBase + 0.5*(v-localBase)
		leftIdx := -1
		for j := i - 1; j >= 0; j-- {
			if samples[j].dbm <= halfLvl {
				leftIdx = j
				break
			}
		}
		if leftIdx < 0 {
			continue
		}
		rightIdx := -1
		for j := i + 1; j < n; j++ {
			if samples[j].dbm <= halfLvl {
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
