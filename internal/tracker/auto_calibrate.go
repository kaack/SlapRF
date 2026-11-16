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
	autoCalibInitialEveryUs uint64 = 1_200_000  // Uncalibrated / provisional gate: check every 1.2 s for fast initial lock
	autoCalibSteadyEveryUs  uint64 = 30_000_000 // Calibrated gate: re-evaluate every 30 s per flying pilot
	autoCalibFreshPassUs    uint64 = 35_000_000 // Require >= 1 valid pass in the last 35 s to re-calibrate

	autoCalibMinBuckets    int     = 70        // ~3.5 s of 20 Hz history
	autoCalibMinSpanUs     uint64  = 3_200_000 // >= 3.2 s wall-clock span
	autoCalibMinPeakRiseDb float32 = 12.0      // Pass peak must rise >= 12 dB above noise floor
	autoCalibLocalMaxSepUs uint64  = 400_000   // Multipath crests < 400 ms apart belong to the same pass
	autoCalibMinPassSepUs  uint64  = 1_800_000 // Distinct lap fly-bys must be >= 1.8 s apart
	autoCalibMinPassFwhmUs uint64  = 150_000   // Reject < 150 ms impulse glitches (< 3 buckets above half-prominence)
	autoCalibMaxPassFwhmUs uint64  = 6_500_000 // Reject > 6.5 s parked/bench VTX plateaus
	autoCalibDeadbandDb    float32 = 2.0       // Skip periodic 30 s updates smaller than 2 dB
)

type autoCalibSample struct {
	tsUs uint64
	dbm  float32
}

type autoCalibState struct {
	samples         []autoCalibSample
	lastEvalUs      uint64
	freqMHz         uint16
	assignedTimerID uint8
	manualPinned    bool
	provisional     bool
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
	if resetHistory {
		st.samples = st.samples[:0]
		st.lastEvalUs = 0
	}
}

// recordAutoCalibSampleLocked records a smoothed SlapRF dBm sample for `(gate, pilot)` and runs
// automatic threshold calibration when lap-like pass waveforms are present (every 2.5 s until
// initially calibrated, then every 30 s while the pilot continues flying).
// Returns `(changedConfig, changedStartFinish)`. Caller holds `e.mu` write lock.
func (e *Engine) recordAutoCalibSampleLocked(
	gate *domain.TrackGate,
	slotPos int,
	pilot domain.PilotSlot,
	det *dsp.ChannelDetector,
	smoothedDbm float32,
	tsUs uint64,
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
		st.provisional = false
		st.freqMHz = pilot.FrequencyMHz
		st.assignedTimerID = gate.AssignedTimerID
		if !st.manualPinned {
			gate.EnterThresholds[slotPos] = 0
			gate.ExitThresholds[slotPos] = 0
		}
	}

	// Handle non-monotonic timestamps (e.g. simulator reset).
	if n := len(st.samples); n > 0 && tsUs < st.samples[n-1].tsUs {
		st.samples = st.samples[:0]
		st.lastEvalUs = 0
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
	intervalUs := autoCalibSteadyEveryUs
	if uncalibrated || st.provisional {
		intervalUs = autoCalibInitialEveryUs
	}
	if st.lastEvalUs != 0 && tsUs >= st.lastEvalUs && tsUs-st.lastEvalUs < intervalUs {
		return false, false
	}
	st.lastEvalUs = tsUs

	enterDbm, exitDbm, pendingExit, ok := suggestAutoThresholdDbm(st.samples, tsUs)
	fromSinglePass := false
	// Single-pass provisional lock is only used on single-gate setups when the pilot's first pass
	// was too weak to cross the default threshold (!det.HasCrossed()); multi-gate courses wait for
	// >= 2 passes so neighbour-gate bleed-over bumps can never trigger a premature threshold shift.
	if !ok && uncalibrated && len(e.gates) == 1 && (det == nil || !det.HasCrossed()) {
		enterDbm, exitDbm, ok = suggestSinglePassProvisionalDbm(st.samples, tsUs, pilot.EnterThreshold)
		fromSinglePass = ok
	}
	if !ok {
		if pendingExit && (uncalibrated || st.provisional) && tsUs > intervalUs {
			// A pass crest is currently exiting the gate; re-check in ~0.6 s once it returns to baseline.
			st.lastEvalUs = tsUs - intervalUs + 600_000
		}
		return false, false
	}

	wasProvisional := st.provisional
	st.provisional = fromSinglePass

	curEnter := gate.EnterThresholds[slotPos]
	curExit := gate.ExitThresholds[slotPos]
	if !uncalibrated && !wasProvisional &&
		float32(math.Abs(float64(enterDbm-curEnter))) < autoCalibDeadbandDb &&
		float32(math.Abs(float64(exitDbm-curExit))) < autoCalibDeadbandDb {
		return false, false
	}

	gate.EnterThresholds[slotPos] = enterDbm
	gate.ExitThresholds[slotPos] = exitDbm
	if det != nil {
		det.RearmIfBelow(exitDbm)
	}
	return true, gate.Role == domain.GateRoleStartFinish
}

// suggestSinglePassProvisionalDbm locks in a provisional threshold right after the VERY FIRST
// clean bell-curve gate pass completes on an uncalibrated gate (so Pass #2 already starts Lap 1
// instead of missing the first 2 laps), and is refined automatically as soon as Pass #2 completes.
func suggestSinglePassProvisionalDbm(samples []autoCalibSample, nowUs uint64, pilotDefaultEnter float32) (enterDbm, exitDbm float32, ok bool) {
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
	// Require bestVal >= -64 dBm for single-pass provisional lock so distant neighbour-gate bleed
	// (-70..-75 dBm when a pilot crosses another gate 25+ m away) never triggers a false provisional
	// threshold; ultra-weak (< -64 dBm) setups still lock in cleanly on Pass #2 via suggestAutoThresholdDbm.
	for i := 2; i < n-2; i++ {
		if samples[i].dbm >= -64.0 && samples[i].dbm >= floor+14.0 && (bestIdx < 0 || samples[i].dbm > bestVal) {
			bestIdx = i
			bestVal = samples[i].dbm
		}
	}
	if bestIdx < 0 || nowUs > samples[bestIdx].tsUs && nowUs-samples[bestIdx].tsUs > autoCalibFreshPassUs {
		return 0, 0, false
	}
	halfLvl := floor + 0.5*(bestVal-floor)
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
	// Require the post-pass tail to have settled back near the active baseline.
	postMin := samples[rightIdx].dbm
	for j := rightIdx; j < n; j++ {
		if samples[j].dbm < postMin {
			postMin = samples[j].dbm
		}
	}
	if postMin > floor+0.35*(bestVal-floor) {
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
	// Never tighten above the pilot's default enter threshold from a single pass before line-to-line
	// peak variance is observed across >= 2 passes.
	if pilotDefaultEnter < 0 && pilotDefaultEnter < enter && pilotDefaultEnter >= activeFloor+7.0 {
		enter = pilotDefaultEnter
	}
	if activeFloor+7.0 > enter {
		enter = activeFloor + 7.0
	}
	enterDbm = clampDbm(enter)
	// Before >= 2 passes measure the true inter-pass valley, keep a crisp 6 dB hysteresis gap below
	// enterDbm so the detector always exits promptly for Pass #2.
	exitDbm = clampExitDbm(enterDbm-6.0, enterDbm)
	return enterDbm, exitDbm, true
}

// suggestAutoThresholdDbm analyzes recent 20 Hz smoothed RSSI buckets for one (gate, pilot) and
// returns `(enterDbm, exitDbm, passStillExiting, ok)` when the history contains genuine lap-like
// gate pass waveforms (>= 2 distinct bell-curve excursions rising >= 12 dB above a quiet baseline).
func suggestAutoThresholdDbm(samples []autoCalibSample, nowUs uint64) (enterDbm, exitDbm float32, pendingExit bool, ok bool) {
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
	p75 := percentileF32(sorted, 0.75)
	// Use p65 (rather than p90) for the baseline noise ceiling so frequent 5-7 s passes
	// (where the top 25-35% of samples sit inside gate fly-bys) never push enterThreshold
	// up into the tips of the pass peaks.
	noiseCeiling := percentileF32(sorted, 0.65)

	// 1. Find local maxima >= 12 dB above floor that form bounded bell-curve excursions.
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

		// Verify bell-curve waveform shape: both sides must fall back to/below half-prominence
		// within a realistic gate-pass FWHM (80 ms .. 6.5 s).
		halfLvl := floor + 0.5*(v-floor)
		leftIdx := -1
		for j := i - 1; j >= 0; j-- {
			if samples[j].dbm <= halfLvl {
				leftIdx = j
				break
			}
		}
		if leftIdx < 0 {
			continue // Signal started high at window edge (e.g. bench power-on), not a pass
		}
		rightIdx := -1
		for j := i + 1; j < n; j++ {
			if samples[j].dbm <= halfLvl {
				rightIdx = j
				break
			}
		}
		if rightIdx < 0 {
			// Latest crest at the right edge of the window hasn't dropped back down yet.
			if nowUs-ts <= 3_000_000 {
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

	// Duty-cycle check: real lap data stays near the floor for the majority of the lap.
	if (p75 - floor) > 0.60*(strong-floor) {
		return 0, 0, false, false
	}

	// Keep genuine passes (at least 50% of strong prominence) and ignore weak neighbour-gate bumps.
	minPassDbm := floor + 0.50*(strong-floor)
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
	// Without this, a 20-35 s VTX-off segment (-91 dBm) in the 90 s buffer drags the global p20
	// `floor` down to -91 dBm even when indoor/small-track inter-pass valleys sit around -75 dBm,
	// placing `exitDbm` below the valleys so the detector never exits the gate!
	var interPassValleys []float32
	sampleIdx := 0
	for k := 0; k < len(passPeaks)-1; k++ {
		t0 := passPeaks[k].tsUs
		t1 := passPeaks[k+1].tsUs
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
			interPassValleys = append(interPassValleys, vMin)
		}
	}

	activeFloor := floor
	valleyHigh := floor
	hasMeasuredValleys := len(interPassValleys) > 0
	if hasMeasuredValleys {
		sort.Slice(interPassValleys, func(i, j int) bool { return interPassValleys[i] < interPassValleys[j] })
		activeFloor = medianSortedF32(interPassValleys)
		valleyHigh = percentileF32(interPassValleys, 0.75)
	}

	sort.Slice(passVals, func(i, j int) bool { return passVals[i] < passVals[j] })
	peak := medianSortedF32(passVals)
	weak := percentileF32(passVals, 0.25)

	enter := activeFloor + 0.52*(peak-activeFloor)
	if weak-3.5 < enter {
		enter = weak - 3.5
	}
	if valleyHigh+5.0 > enter {
		enter = valleyHigh + 5.0
	}
	if activeFloor+7.0 > enter {
		enter = activeFloor + 7.0
	}
	if !hasMeasuredValleys && noiseCeiling+3.0 > enter {
		enter = noiseCeiling + 3.0
	}
	enterDbm = clampDbm(float32(math.Round(float64(enter))))

	rawExit := float32(math.Round(float64(activeFloor + 0.25*(peak-activeFloor))))
	valleyClear := float32(math.Ceil(float64(valleyHigh))) + 2.0
	if !hasMeasuredValleys {
		valleyClear = float32(math.Round(float64(activeFloor))) + 4.0
	}
	exitCand := rawExit
	if valleyClear > exitCand {
		exitCand = valleyClear
	}
	if enterDbm-5.0 < exitCand {
		exitCand = enterDbm - 5.0
	}
	exitDbm = clampExitDbm(exitCand, enterDbm)
	return enterDbm, exitDbm, false, true
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
