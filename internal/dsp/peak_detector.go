package dsp

import (
	"math"
)

// CrossingCandidate is returned when a pilot completes a valid gate pass (enter -> peak -> exit nadir).
type CrossingCandidate struct {
	PuckID            uint8
	SlotIndex         int
	TimestampUs       uint64
	PeakRSSIDbm       float32
	LapRFPeakHeight   float32
	BeamwidthMs       float64
	EstimatedSpeedMph float64
}

type samplePoint struct {
	timestampUs uint64
	rssiDbm     float32
}

// ChannelDetector tracks the real-time 5.8 GHz RSSI envelope for a single (PuckID, PilotSlot) pair.
type ChannelDetector struct {
	puckID          uint8
	slotIndex       int
	smoothedRSSI    float32
	initialized     bool
	inGate          bool
	peakRSSI        float32
	peakTimestampUs uint64
	enterTimeUs     uint64
	lastCrossingUs  uint64
	hasCrossed      bool
	awaitingRearm   bool
	windowSamples   []samplePoint
}

// rearmTimeoutUs re-arms a detector whose signal never dropped back below the entry
// threshold after a crossing (quad lingering by the gate). Duplicate passes that slip
// through are then handled by the engine's gate cool-down rule.
const rearmTimeoutUs = 2_500_000

// NewChannelDetector initializes a stateful RSSI peak detector for one gate puck and one pilot slot.
func NewChannelDetector(puckID uint8, slotIndex int) *ChannelDetector {
	return &ChannelDetector{
		puckID:        puckID,
		slotIndex:     slotIndex,
		smoothedRSSI:  -92.0,
		windowSamples: make([]samplePoint, 0, 64),
	}
}

// SmoothedRSSI returns the current low-pass filtered RSSI in dBm.
func (d *ChannelDetector) SmoothedRSSI() float32 {
	return d.smoothedRSSI
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
	// 1. Exponential moving average low-pass filter (alpha = 0.38 balances multipath rejection & sharp peak response)
	const alpha = 0.38
	if !d.initialized {
		d.smoothedRSSI = rawRSSIDbm
		d.initialized = true
	} else {
		d.smoothedRSSI = alpha*rawRSSIDbm + (1.0-alpha)*d.smoothedRSSI
	}

	s := d.smoothedRSSI

	// 2. Check gate entry.
	if !d.inGate {
		// Hysteresis: after a crossing, stay disarmed until the signal has fallen back below the
		// entry threshold, so the tail of one pass can't look like a second pass. The timeout
		// covers a quad that lingers near the gate (or a neighbouring gate keeping it loud).
		if d.awaitingRearm {
			if s >= enterThresholdDbm-4.0 && timestampUs-d.lastCrossingUs < rearmTimeoutUs {
				return nil
			}
			d.awaitingRearm = false
		}
		lockedOut := d.hasCrossed && timestampUs-d.lastCrossingUs <= minLockoutUs
		if s >= enterThresholdDbm && !lockedOut {
			d.inGate = true
			d.peakRSSI = s
			d.peakTimestampUs = timestampUs
			d.enterTimeUs = timestampUs
			d.windowSamples = d.windowSamples[:0]
			d.windowSamples = append(d.windowSamples, samplePoint{timestampUs: timestampUs, rssiDbm: s})
		}
		return nil
	}

	// 3. Inside gate proximity window: record sample & update peak
	d.windowSamples = append(d.windowSamples, samplePoint{timestampUs: timestampUs, rssiDbm: s})
	if s > d.peakRSSI {
		d.peakRSSI = s
		d.peakTimestampUs = timestampUs
	}

	// 4. Check gate exit (hysteresis nadir):
	// Confirm the crossing as soon as the signal has fallen exitDropDb below its peak, or below the
	// absolute exit threshold, whichever comes first. A purely absolute threshold fails when gates are
	// close together (the drone never gets "quiet" between them) and delays LiveTime lap callouts.
	const exitDropDb = 15.0
	effectiveExit := d.peakRSSI - exitDropDb
	if exitThresholdDbm > effectiveExit {
		effectiveExit = exitThresholdDbm
	}

	if s <= effectiveExit {
		d.inGate = false
		d.lastCrossingUs = d.peakTimestampUs
		d.hasCrossed = true
		d.awaitingRearm = true

		refinedTimeUs := d.interpolatePeakTimeUs()
		beamwidthMs, speedMph := d.estimateBeamwidthAndSpeed()

		// Convert dBm (-85..-20 dBm) to ImmersionRC LapRF peak height scale (approx 600..3600)
		laprfHeight := float32(math.Max(400, math.Min(3900, float64(d.peakRSSI+95.0)*46.0)))

		return &CrossingCandidate{
			PuckID:            d.puckID,
			SlotIndex:         d.slotIndex,
			TimestampUs:       refinedTimeUs,
			PeakRSSIDbm:       d.peakRSSI,
			LapRFPeakHeight:   laprfHeight,
			BeamwidthMs:       beamwidthMs,
			EstimatedSpeedMph: speedMph,
		}
	}

	// Safety timeout if a pilot lands/disarms right inside a gate (>8 seconds in gate)
	if timestampUs-d.enterTimeUs > 8_000_000 {
		d.inGate = false
	}

	return nil
}

// interpolatePeakTimeUs performs 3-point parabolic interpolation around the discrete maximum sample
// for sub-millisecond crossing precision.
func (d *ChannelDetector) interpolatePeakTimeUs() uint64 {
	n := len(d.windowSamples)
	if n < 3 {
		return d.peakTimestampUs
	}
	maxIdx := -1
	var maxVal float32 = -999
	for i, pt := range d.windowSamples {
		if pt.rssiDbm > maxVal {
			maxVal = pt.rssiDbm
			maxIdx = i
		}
	}
	if maxIdx <= 0 || maxIdx >= n-1 {
		return d.peakTimestampUs
	}

	y0 := float64(d.windowSamples[maxIdx-1].rssiDbm)
	y1 := float64(d.windowSamples[maxIdx].rssiDbm)
	y2 := float64(d.windowSamples[maxIdx+1].rssiDbm)

	denom := 2.0 * (2.0*y1 - y0 - y2)
	if math.Abs(denom) < 1e-5 {
		return d.peakTimestampUs
	}
	delta := (y2 - y0) / denom // Fractional sample offset in [-0.5, +0.5]
	if delta < -0.5 {
		delta = -0.5
	} else if delta > 0.5 {
		delta = 0.5
	}

	t1 := float64(d.windowSamples[maxIdx].timestampUs)
	if delta >= 0 {
		dt := float64(d.windowSamples[maxIdx+1].timestampUs - d.windowSamples[maxIdx].timestampUs)
		return uint64(t1 + delta*dt)
	}
	dt := float64(d.windowSamples[maxIdx].timestampUs - d.windowSamples[maxIdx-1].timestampUs)
	return uint64(t1 + delta*dt)
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
