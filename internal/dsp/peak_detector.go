package dsp

import (
	"math"
)

// CrossingCandidate is returned when a pilot completes a valid gate pass (enter -> peak -> exit nadir).
type CrossingCandidate struct {
	GateID              uint8
	SlotIndex           int
	TimestampUs         uint64
	PeakRSSIDbm         float32
	LapRFPeakHeight     float32
	BeamwidthMs         float64
	EstimatedSpeedMph   float64
	HoldMs              float64
	AboveEnterMs        float64
	AboveEnterAreaDbSec float64
	PassAreaDbSec       float64
	IsStepBurst         bool
}

type samplePoint struct {
	timestampUs uint64
	rssiDbm     float32
}

const (
	// rearmTimeoutUs re-arms a detector whose signal never dropped back below the entry
	// threshold after a crossing (quad lingering by the gate). Duplicate passes that slip
	// through are then handled by the engine's gate cool-down rule.
	rearmTimeoutUs = 2_500_000

	// medianWindowUs bounds the interquartile trimmed-mean window (7-8 samples @ 100 Hz,
	// 4 samples @ 50 Hz), stripping upward sync spikes and short multipath notches without
	// shaving fast 60 ms race passes.
	medianWindowUs  = 70_000
	maxMedianPoints = 9

	// 2-pole cascaded C1-smooth envelope time constants (three regimes):
	// - Rising pass (> +2.5 dB): fast 14 ms + 14 ms attack preserves full peak height at 90+ mph.
	// - Steady / noise floor (within ±2.5 dB): symmetric 45 ms + 35 ms gives zero rectification bias.
	// - Multipath fade / falling (< -2.5 dB): smooth 85 ms + 40 ms glides across 70-150 ms Rayleigh
	//   dropouts without downward sawteeth while still exiting cleanly after the pass.
	attackTauUs       = 14_000.0
	steadyTau1Us      = 45_000.0
	steadyTau2Us      = 35_000.0
	releaseTauUs      = 85_000.0
	releasePole2TauUs = 40_000.0
	asymmetryBandDb   = 2.5

	// zeroPhaseTauUs is the per-direction time constant of the forward-backward (filtfilt)
	// smoother applied to the completed pass window when computing the exact crossing time.
	zeroPhaseTauUs = 45_000.0

	// maxGapResetUs resets filter history after a telemetry gap (> 250 ms) so stale readings
	// never bleed across reconnects or channel changes.
	maxGapResetUs = 250_000

	// disabledCutoffDbm identifies muted / unmeasured channels (-127 dBm).
	disabledCutoffDbm = -120.0

	prePassRingCap = 8
)

// ChannelDetector tracks the real-time 5.8 GHz RSSI envelope for a single (GateID, PilotSlot) pair.
type ChannelDetector struct {
	gateID          uint8
	slotIndex       int
	stage1RSSI      float32
	smoothedRSSI    float32
	initialized     bool
	prevSampleTsUs  uint64
	medRing         [maxMedianPoints]samplePoint
	medCount        int
	prePassRing     [prePassRingCap]samplePoint
	prePassHead     int
	prePassCount    int
	inGate             bool
	peakRSSI           float32
	peakTimestampUs    uint64
	enterTimeUs        uint64
	lastCrossingUs     uint64
	prevLastCrossingUs uint64
	hasCrossed         bool
	prevHasCrossed     bool
	awaitingRearm      bool
	windowSamples      []samplePoint // Smoothed envelope samples (for -6 dB beamwidth)
	passMedSamples     []samplePoint // Delay-centered median samples (for zero-phase peak timing)
}

// NewChannelDetector initializes a stateful RSSI peak detector for one gate timer and one pilot slot.
func NewChannelDetector(gateID uint8, slotIndex int) *ChannelDetector {
	return &ChannelDetector{
		gateID:         gateID,
		slotIndex:      slotIndex,
		stage1RSSI:     -92.0,
		smoothedRSSI:   -92.0,
		windowSamples:  make([]samplePoint, 0, 96),
		passMedSamples: make([]samplePoint, 0, 96),
	}
}

// SmoothedRSSI returns the current spike-rejected, low-pass filtered RSSI in dBm.
func (d *ChannelDetector) SmoothedRSSI() float32 {
	return d.smoothedRSSI
}

// HasCrossed reports whether this detector has confirmed at least one gate crossing.
func (d *ChannelDetector) HasCrossed() bool {
	return d.hasCrossed
}

// RearmIfBelow clears any stale in-gate or awaiting-rearm state when thresholds change while the
// smoothed signal is already at or below the new exit threshold.
func (d *ChannelDetector) RearmIfBelow(exitThresholdDbm float32) {
	if d.initialized && d.smoothedRSSI <= exitThresholdDbm {
		d.inGate = false
		d.awaitingRearm = false
	}
}

// RollbackRejectedSpike restores the prior crossing lockout state and clears awaitingRearm when the
// timing engine rejects the latest candidate as a non-pass RF/Wi-Fi spike, ensuring a rejected blip
// never disarms or debounces a real gate pass immediately following it.
func (d *ChannelDetector) RollbackRejectedSpike() {
	d.lastCrossingUs = d.prevLastCrossingUs
	d.hasCrossed = d.prevHasCrossed
	d.awaitingRearm = false
}

func (d *ChannelDetector) resetFilterState(rssi float32, tsUs uint64) {
	d.stage1RSSI = rssi
	d.smoothedRSSI = rssi
	d.prevSampleTsUs = tsUs
	d.medCount = 0
	d.prePassCount = 0
	d.prePassHead = 0
	if rssi > disabledCutoffDbm {
		d.medRing[0] = samplePoint{timestampUs: tsUs, rssiDbm: rssi}
		d.medCount = 1
	}
}

func (d *ChannelDetector) pushMedianSample(rawRSSI float32, tsUs uint64) (float32, uint64) {
	// Evict samples older than medianWindowUs so the window spans <= 105 ms at any sweep rate.
	keepFrom := 0
	for keepFrom < d.medCount && tsUs > d.medRing[keepFrom].timestampUs &&
		tsUs-d.medRing[keepFrom].timestampUs > medianWindowUs {
		keepFrom++
	}
	if keepFrom > 0 {
		copy(d.medRing[:], d.medRing[keepFrom:d.medCount])
		d.medCount -= keepFrom
	}
	if d.medCount == maxMedianPoints {
		copy(d.medRing[:], d.medRing[1:maxMedianPoints])
		d.medCount = maxMedianPoints - 1
	}
	d.medRing[d.medCount] = samplePoint{timestampUs: tsUs, rssiDbm: rawRSSI}
	d.medCount++

	// Insertion sort a tiny stack copy (1..11 elements) and compute the interquartile trimmed mean
	// (averaging the middle ~50% of sorted samples). This completely rejects multi-sweep spikes and
	// short multipath notches while eliminating discrete step jumps between order statistics.
	var vals [maxMedianPoints]float32
	for i := 0; i < d.medCount; i++ {
		v := d.medRing[i].rssiDbm
		j := i
		for j > 0 && vals[j-1] > v {
			vals[j] = vals[j-1]
			j--
		}
		vals[j] = v
	}
	var med float32
	if d.medCount >= 5 {
		trim := d.medCount / 4
		lo := trim
		hi := d.medCount - trim
		var sum float32
		for i := lo; i < hi; i++ {
			sum += vals[i]
		}
		med = sum / float32(hi-lo)
	} else {
		mid := d.medCount / 2
		if d.medCount%2 == 1 {
			med = vals[mid]
		} else {
			med = 0.5 * (vals[mid-1] + vals[mid])
		}
	}
	// Tag the filtered value with the midpoint of the active window so symmetric window delay is removed.
	oldestTs := d.medRing[0].timestampUs
	centerTs := oldestTs + (tsUs-oldestTs)/2
	return med, centerTs
}

func (d *ChannelDetector) pushPrePassSample(pt samplePoint) {
	if d.prePassCount < prePassRingCap {
		idx := (d.prePassHead + d.prePassCount) % prePassRingCap
		d.prePassRing[idx] = pt
		d.prePassCount++
		return
	}
	d.prePassRing[d.prePassHead] = pt
	d.prePassHead = (d.prePassHead + 1) % prePassRingCap
}

// ProcessSample ingests a single RSSI sample (in dBm) at timestampUs and returns a CrossingCandidate
// if a gate crossing peak was just confirmed by an exit nadir.
func (d *ChannelDetector) ProcessSample(
	rawRSSIDbm float32,
	timestampUs uint64,
	enterThresholdDbm float32,
	exitThresholdDbm float32,
	minLockoutUs uint64,
) *CrossingCandidate {
	// Handle disabled / survey-muted channels (-127 dBm) immediately without filter lag.
	if rawRSSIDbm <= disabledCutoffDbm {
		d.resetFilterState(rawRSSIDbm, timestampUs)
		d.initialized = true
		return nil
	}

	// 1. Spike-rejecting 45 ms time-window median + dt-weighted EMA low-pass filter.
	var medVal float32
	var medCenterTs uint64
	if !d.initialized || d.smoothedRSSI <= disabledCutoffDbm ||
		timestampUs < d.prevSampleTsUs || timestampUs-d.prevSampleTsUs > maxGapResetUs {
		d.initialized = true
		d.resetFilterState(rawRSSIDbm, timestampUs)
		medVal = rawRSSIDbm
		medCenterTs = timestampUs
	} else {
		dtUs := timestampUs - d.prevSampleTsUs
		d.prevSampleTsUs = timestampUs
		medVal, medCenterTs = d.pushMedianSample(rawRSSIDbm, timestampUs)
		if dtUs < 1_000 {
			dtUs = 1_000
		}
		diff1 := medVal - d.stage1RSSI
		tau1 := steadyTau1Us
		tau2 := steadyTau2Us
		if diff1 > asymmetryBandDb {
			tau1 = attackTauUs
			tau2 = attackTauUs
		} else if diff1 < -asymmetryBandDb {
			tau1 = releaseTauUs
			tau2 = releasePole2TauUs
		}
		alpha1 := float32(1.0 - math.Exp(-float64(dtUs)/tau1))
		d.stage1RSSI += alpha1 * (medVal - d.stage1RSSI)

		if d.stage1RSSI > d.smoothedRSSI+asymmetryBandDb {
			tau2 = attackTauUs
		}
		alpha2 := float32(1.0 - math.Exp(-float64(dtUs)/tau2))
		d.smoothedRSSI += alpha2 * (d.stage1RSSI - d.smoothedRSSI)
	}

	s := d.smoothedRSSI
	medPt := samplePoint{timestampUs: medCenterTs, rssiDbm: medVal}

	effectiveExit := exitThresholdDbm
	if effectiveExit == 0 || effectiveExit > enterThresholdDbm-2.0 {
		effectiveExit = enterThresholdDbm - 2.0
	}

	// 2. Check gate entry.
	if !d.inGate {
		// Dual-threshold hysteresis: after a crossing, stay disarmed until the signal drops to or
		// below the exit threshold (or stays clearly below the entry threshold past a close-gate /
		// lingering timeout), so the tail of one pass cannot re-trigger as a second pass.
		if d.awaitingRearm {
			rearmed := s <= effectiveExit ||
				(s <= enterThresholdDbm-3.0 && timestampUs >= d.lastCrossingUs+600_000) ||
				(s < enterThresholdDbm && timestampUs >= d.lastCrossingUs+rearmTimeoutUs)
			if !rearmed {
				d.pushPrePassSample(medPt)
				return nil
			}
			d.awaitingRearm = false
		}
		lockedOut := d.hasCrossed && timestampUs <= d.lastCrossingUs+minLockoutUs
		if s >= enterThresholdDbm && !lockedOut {
			d.inGate = true
			d.peakRSSI = s
			d.peakTimestampUs = medCenterTs
			d.enterTimeUs = timestampUs
			d.windowSamples = d.windowSamples[:0]
			d.windowSamples = append(d.windowSamples, samplePoint{timestampUs: timestampUs, rssiDbm: s})

			// Seed passMedSamples with recent pre-entry median samples so zero-phase forward-backward
			// smoothing sees the full rising edge of fast passes.
			d.passMedSamples = d.passMedSamples[:0]
			for i := 0; i < d.prePassCount; i++ {
				pt := d.prePassRing[(d.prePassHead+i)%prePassRingCap]
				if medCenterTs >= pt.timestampUs && medCenterTs-pt.timestampUs <= maxGapResetUs {
					d.passMedSamples = append(d.passMedSamples, pt)
				}
			}
			d.passMedSamples = append(d.passMedSamples, medPt)
			d.prePassCount = 0
			d.prePassHead = 0
		} else {
			d.pushPrePassSample(medPt)
		}
		return nil
	}

	// 3. Inside gate proximity window: record sample & update peak.
	d.windowSamples = append(d.windowSamples, samplePoint{timestampUs: timestampUs, rssiDbm: s})
	if len(d.passMedSamples) == 0 || medPt.timestampUs >= d.passMedSamples[len(d.passMedSamples)-1].timestampUs {
		d.passMedSamples = append(d.passMedSamples, medPt)
	}
	if s > d.peakRSSI {
		d.peakRSSI = s
		d.peakTimestampUs = medCenterTs
	}

	// 4. Check gate exit (dual-threshold Schmitt hysteresis):
	// Confirm the crossing when the signal drops to or below the configured exit threshold.
	// If indoor reflections or close adjacent gates keep the inter-pass valley slightly above
	// exitThreshold, confirm once the drone has clearly exited the entry zone (>= 10 dB below
	// pass peak, >= 3 dB below enterThreshold, and >= 500 ms past closest approach).
	exitedBelowThreshold := s <= effectiveExit
	exited := exitedBelowThreshold
	if !exited && s <= enterThresholdDbm-3.0 && (d.peakRSSI-s) >= 10.0 && medCenterTs >= d.peakTimestampUs+500_000 {
		exited = true
	}
	if !exited && timestampUs-d.enterTimeUs > 8_000_000 {
		if d.peakRSSI >= enterThresholdDbm+3.0 && s <= enterThresholdDbm-2.0 && (d.peakRSSI-s) >= 6.0 {
			exited = true
		} else {
			d.inGate = false
			return nil
		}
	}

	if exited {
		d.inGate = false
		holdMs, aboveEnterMs, aboveEnterAreaDbSec, areaDbSec := d.measurePassHoldAndArea(enterThresholdDbm, effectiveExit)
		// Discard sub-45 ms micro-grazes (< 4 dB above enter in dBm mode) immediately without arming
		// lockout so an ambient Wi-Fi/RF impulse never blocks an approaching drone right behind it.
		if enterThresholdDbm < 0 && aboveEnterMs < 45.0 && d.peakRSSI < enterThresholdDbm+4.0 {
			return nil
		}

		refinedTimeUs, zeroPhasePeak := d.refineCrossingPeak()
		if zeroPhasePeak > d.peakRSSI {
			d.peakRSSI = zeroPhasePeak
		}
		d.prevLastCrossingUs = d.lastCrossingUs
		d.prevHasCrossed = d.hasCrossed
		d.lastCrossingUs = refinedTimeUs
		d.hasCrossed = true
		// Only wait for a subsequent re-arm drop when exiting early above effectiveExit (high-valley
		// fallback); when s <= effectiveExit already, Schmitt hysteresis is already satisfied.
		d.awaitingRearm = !exitedBelowThreshold

		beamwidthMs, speedMph := d.estimateBeamwidthAndSpeed()
		isStepBurst := enterThresholdDbm < 0 && d.isRectangularStepBurst()

		// Convert dBm (-85..-20 dBm) to ImmersionRC LapRF peak height scale (approx 600..3600)
		laprfHeight := float32(math.Max(400, math.Min(3900, float64(d.peakRSSI+95.0)*46.0)))

		return &CrossingCandidate{
			GateID:              d.gateID,
			SlotIndex:           d.slotIndex,
			TimestampUs:         refinedTimeUs,
			PeakRSSIDbm:         d.peakRSSI,
			LapRFPeakHeight:     laprfHeight,
			BeamwidthMs:         beamwidthMs,
			EstimatedSpeedMph:   speedMph,
			HoldMs:              holdMs,
			AboveEnterMs:        aboveEnterMs,
			AboveEnterAreaDbSec: aboveEnterAreaDbSec,
			PassAreaDbSec:       areaDbSec,
			IsStepBurst:         isStepBurst,
		}
	}

	return nil
}

// refineCrossingPeak runs a zero-phase forward-backward (filtfilt) pass over the buffered
// median samples of the crossing and computes the squared-excess centroid across the top
// 2.0 dB peak plateau. This eliminates both causal EMA lag (across all drone speeds and
// race-start holeshots) and single-sample argmax shoulder jitter on broad or dipole-null passes.
func (d *ChannelDetector) refineCrossingPeak() (uint64, float32) {
	pts := d.passMedSamples
	n := len(pts)
	if n < 3 {
		return d.peakTimestampUs, d.peakRSSI
	}

	fwd := make([]float64, n)
	fwd[0] = float64(pts[0].rssiDbm)
	for i := 1; i < n; i++ {
		dt := float64(pts[i].timestampUs - pts[i-1].timestampUs)
		if dt < 1_000 {
			dt = 1_000
		} else if dt > 100_000 {
			dt = 100_000
		}
		a := 1.0 - math.Exp(-dt/zeroPhaseTauUs)
		fwd[i] = fwd[i-1] + a*(float64(pts[i].rssiDbm)-fwd[i-1])
	}

	zp := make([]float64, n)
	zp[n-1] = fwd[n-1]
	maxIdx := n - 1
	maxVal := zp[n-1]
	for i := n - 2; i >= 0; i-- {
		dt := float64(pts[i+1].timestampUs - pts[i].timestampUs)
		if dt < 1_000 {
			dt = 1_000
		} else if dt > 100_000 {
			dt = 100_000
		}
		a := 1.0 - math.Exp(-dt/zeroPhaseTauUs)
		zp[i] = zp[i+1] + a*(fwd[i]-zp[i+1])
		if zp[i] > maxVal {
			maxVal = zp[i]
			maxIdx = i
		}
	}

	// Compute the squared-excess centroid across the top 2.0 dB plateau around maxIdx
	// (bounded to ±600 ms around maxIdx so lingering near a gate cannot skew the peak).
	const plateauCapDb = 2.0
	const weightBaseDb = 2.2
	const maxSpanFromPeakUs = 600_000

	peakTs := pts[maxIdx].timestampUs
	cutoff := maxVal - plateauCapDb
	base := maxVal - weightBaseDb

	tRef := float64(peakTs)
	var sumW, sumWT float64
	count := 0
	for i := 0; i < n; i++ {
		if zp[i] < cutoff {
			continue
		}
		var dist uint64
		if pts[i].timestampUs > peakTs {
			dist = pts[i].timestampUs - peakTs
		} else {
			dist = peakTs - pts[i].timestampUs
		}
		if dist > maxSpanFromPeakUs {
			continue
		}
		excess := zp[i] - base
		w := excess * excess
		sumW += w
		sumWT += w * (float64(pts[i].timestampUs) - tRef)
		count++
	}

	// If only 1 discrete sample cleared the 2.0 dB cap (ultra-fast spike pass), fall back to
	// 3-point parabolic interpolation around maxIdx on the zero-phase curve.
	if count <= 1 && maxIdx > 0 && maxIdx < n-1 {
		y0, y1, y2 := zp[maxIdx-1], zp[maxIdx], zp[maxIdx+1]
		denom := 2.0 * (2.0*y1 - y0 - y2)
		if math.Abs(denom) > 1e-5 {
			delta := (y2 - y0) / denom
			if delta < -0.5 {
				delta = -0.5
			} else if delta > 0.5 {
				delta = 0.5
			}
			if delta >= 0 {
				dt := float64(pts[maxIdx+1].timestampUs - pts[maxIdx].timestampUs)
				return uint64(tRef + delta*dt), float32(maxVal)
			}
			dt := float64(pts[maxIdx].timestampUs - pts[maxIdx-1].timestampUs)
			return uint64(tRef + delta*dt), float32(maxVal)
		}
	}

	if sumW > 0 {
		refined := tRef + sumWT/sumW
		if refined > 0 {
			return uint64(math.Round(refined)), float32(maxVal)
		}
	}
	return peakTs, float32(maxVal)
}

// estimateBeamwidthAndSpeed computes the -6 dB width of the RF pass curve and estimates airspeed in mph.
// By inverse-square path loss, -6 dB corresponds to 2x distance from the closest approach h (~1.25m for a race gate),
// meaning the drone travels Δx = 2 * sqrt(3) * h ≈ 4.33 meters during the -6 dB window.
func (d *ChannelDetector) estimateBeamwidthAndSpeed() (float64, float64) {
	if len(d.windowSamples) < 2 {
		return 150.0, 55.0
	}
	cutoffDbm := d.peakRSSI - 6.0
	var firstUs, lastUs uint64
	for _, pt := range d.windowSamples {
		if pt.rssiDbm >= cutoffDbm {
			if firstUs == 0 {
				firstUs = pt.timestampUs
			}
			lastUs = pt.timestampUs
		}
	}
	if lastUs <= firstUs {
		return 140.0, 58.0
	}
	beamwidthMs := float64(lastUs-firstUs) / 1000.0
	if beamwidthMs < 40.0 {
		beamwidthMs = 40.0
	}
	// Effective -6dB chord distance across a standard 5ft race gate is ~3.6 meters
	const effectiveChordMeters = 3.60
	speedMetersPerSec := effectiveChordMeters / (beamwidthMs / 1000.0)
	speedMph := speedMetersPerSec * 2.23694
	if speedMph > 98.0 {
		speedMph = 98.0
	} else if speedMph < 18.0 {
		speedMph = 18.0
	}
	return math.Round(beamwidthMs*10) / 10, math.Round(speedMph*10) / 10
}

// measurePassHoldAndArea computes the pass hold duration (in ms), linearly interpolated time spent
// at or above enterThresholdDbm (in ms), and integrated area above effectiveExit (dB*s).
//
// It evaluates `d.passMedSamples` (the symmetric interquartile-trimmed median curve) when >= 3
// samples are available rather than `d.windowSamples` (`smoothedRSSI`), because `smoothedRSSI`
// uses an asymmetric 85 ms + 40 ms slow release to bridge indoor multipath fades. Measuring hold
// and area on `smoothedRSSI` artificially stretches a 40 ms 5 GHz Wi-Fi packet burst into a
// ~260 ms decay tail; `passMedSamples` preserves true physical duration for both indoor and
// high-speed outdoor passes while exposing short RF packet bursts at their true 40-80 ms width.
func (d *ChannelDetector) measurePassHoldAndArea(enterThresholdDbm, effectiveExit float32) (holdMs, aboveEnterMs, aboveEnterAreaDbSec, areaDbSec float64) {
	pts := d.passMedSamples
	if len(pts) < 3 {
		pts = d.windowSamples
	}
	n := len(pts)
	if n < 2 {
		return 0, 0, 0, 0
	}

	var firstExitUs, lastExitUs uint64
	hasExitSpan := false

	for i := 1; i < n; i++ {
		p0 := pts[i-1]
		p1 := pts[i]
		if p1.timestampUs <= p0.timestampUs {
			continue
		}
		dtUs := float64(p1.timestampUs - p0.timestampUs)
		if dtUs > 120_000 {
			dtUs = 120_000
		}
		dtMs := dtUs / 1000.0
		dtSec := dtUs / 1e6

		// Track first rising crossing and last falling crossing of effectiveExit.
		if p0.rssiDbm >= effectiveExit || p1.rssiDbm >= effectiveExit {
			segStartUs := p0.timestampUs
			if p0.rssiDbm < effectiveExit && p1.rssiDbm >= effectiveExit {
				span := float64(p1.rssiDbm - p0.rssiDbm)
				if span > 1e-4 {
					frac := float64(effectiveExit-p0.rssiDbm) / span
					segStartUs = p0.timestampUs + uint64(dtUs*frac)
				}
			}
			segEndUs := p1.timestampUs
			if p0.rssiDbm >= effectiveExit && p1.rssiDbm < effectiveExit {
				span := float64(p0.rssiDbm - p1.rssiDbm)
				if span > 1e-4 {
					frac := float64(p0.rssiDbm-effectiveExit) / span
					segEndUs = p0.timestampUs + uint64(dtUs*frac)
				}
			}
			if !hasExitSpan {
				firstExitUs = segStartUs
				lastExitUs = segEndUs
				hasExitSpan = true
			} else {
				if segStartUs < firstExitUs {
					firstExitUs = segStartUs
				}
				if segEndUs > lastExitUs {
					lastExitUs = segEndUs
				}
			}
		}

		// Linearly interpolated time above enterThresholdDbm.
		if p0.rssiDbm >= enterThresholdDbm && p1.rssiDbm >= enterThresholdDbm {
			aboveEnterMs += dtMs
		} else if p0.rssiDbm >= enterThresholdDbm && p1.rssiDbm < enterThresholdDbm {
			span := float64(p0.rssiDbm - p1.rssiDbm)
			if span > 1e-4 {
				aboveEnterMs += dtMs * float64(p0.rssiDbm-enterThresholdDbm) / span
			}
		} else if p1.rssiDbm >= enterThresholdDbm && p0.rssiDbm < enterThresholdDbm {
			span := float64(p1.rssiDbm - p0.rssiDbm)
			if span > 1e-4 {
				aboveEnterMs += dtMs * float64(p1.rssiDbm-enterThresholdDbm) / span
			}
		}

		// Trapezoidal area above enterThresholdDbm and effectiveExit (dB*s).
		he0 := math.Max(0, float64(p0.rssiDbm-enterThresholdDbm))
		he1 := math.Max(0, float64(p1.rssiDbm-enterThresholdDbm))
		aboveEnterAreaDbSec += 0.5 * (he0 + he1) * dtSec

		h0 := math.Max(0, float64(p0.rssiDbm-effectiveExit))
		h1 := math.Max(0, float64(p1.rssiDbm-effectiveExit))
		areaDbSec += 0.5 * (h0 + h1) * dtSec
	}

	if hasExitSpan && lastExitUs > firstExitUs {
		holdMs = float64(lastExitUs-firstExitUs) / 1000.0
	}
	if holdMs < aboveEnterMs {
		holdMs = aboveEnterMs
	}
	return math.Round(holdMs*10) / 10,
		math.Round(aboveEnterMs*10) / 10,
		math.Round(aboveEnterAreaDbSec*100) / 100,
		math.Round(areaDbSec*100) / 100
}

// isRectangularStepBurst detects a 5 GHz Wi-Fi TXOP / digital packet burst on an unused FPV
// channel: the channel sits at dead thermal receiver noise (<= -87.5 dBm, no VTX carrier) right up
// to the burst, steps up >= 20 dB in <= 80 ms (> 250 mph impossible inverse-square approach), and
// steps back down >= 18 dB to thermal noise on exit without a physical departure skirt.
func (d *ChannelDetector) isRectangularStepBurst() bool {
	pts := d.passMedSamples
	n := len(pts)
	if n < 6 {
		return false
	}
	// Require fine hardware sample cadence (<= 30 ms spacing = 50/100 Hz) in the pre-entry samples
	// and >= 3 consecutive thermal-noise samples <= -87.5 dBm before the rising step.
	quietCount := 0
	lastQuietIdx := -1
	for i := 0; i < n && i < 8; i++ {
		if i > 0 && pts[i].timestampUs-pts[i-1].timestampUs > 35_000 {
			return false
		}
		if pts[i].rssiDbm <= -87.5 {
			quietCount++
			lastQuietIdx = i
		} else {
			break
		}
	}
	if quietCount < 2 || lastQuietIdx < 1 {
		return false
	}
	baseDbm := pts[lastQuietIdx].rssiDbm
	// Find first sample reaching >= baseDbm + 20 dB (step-on transmitter key-up).
	stepUpIdx := -1
	for i := lastQuietIdx + 1; i < n; i++ {
		if pts[i].rssiDbm >= baseDbm+20.0 {
			stepUpIdx = i
			break
		}
	}
	if stepUpIdx < 0 || pts[stepUpIdx].timestampUs-pts[lastQuietIdx].timestampUs > 85_000 {
		return false
	}
	// Check abrupt step-off at the end of the burst (back down <= -85.0 dBm within <= 100 ms of a high sample).
	endDbm := pts[n-1].rssiDbm
	if endDbm > -85.0 {
		return false
	}
	for i := n - 2; i >= stepUpIdx; i-- {
		if pts[n-1].timestampUs-pts[i].timestampUs > 105_000 {
			break
		}
		if pts[i].rssiDbm >= endDbm+18.0 {
			return true
		}
	}
	return false
}
