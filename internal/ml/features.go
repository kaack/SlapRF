package ml

import "math"

const (
	// StepUs is the uniform 50 Hz (20 ms) temporal grid shared by Hub (50 Hz) and Spoke (100 Hz) streams.
	StepUs        = 20_000
	InputChannels = 3
	HiddenL1      = 16
	HiddenDim     = 24

	// LookaheadSteps is the symmetric right-side receptive field (14 steps * 20 ms = 280 ms).
	// L1 (k=5,d=1 -> +-2) + L2 (k=5,d=2 -> +-4) + L3 (k=5,d=4 -> +-8) = +-14 steps (+-280 ms).
	LookaheadSteps = 14
)

// FeatureNormalizer computes causal 3-channel normalized features at each 20 ms step so offline
// full-trace training and live real-time streaming produce identical inputs with zero on-the-fly
// peak-ceiling auto-calibration (loud passes on earlier laps never suppress softer/slower passes,
// and multi-second straight-in line-of-sight approach ramps or launch-pad hover shelves never drag
// the reference baseline up with the approaching quad):
//   - ch0: Excess above ambient noise floor: clamp((rssi - floor) / 35.0, -0.25, 1.6)
//   - ch1: Contrast above clamped ambient/far-field shelf: clamp((rssi - slowEma) / 22.0, -1.2, 1.5)
//   - ch2: Multi-scale 120 ms + 320 ms slope: clamp(0.55*(rssi[t]-rssi[t-6])/14 + 0.45*(rssi[t]-rssi[t-16])/18, -1.5, 1.5)
type FeatureNormalizer struct {
	initialized bool
	floorDbm    float32
	slowEmaDbm  float32
	medBuf      [3]float32
	medCount    int
	histRssi    [16]float32
	histCount   int
}

func clamp32(v, lo, hi float32) float32 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func median3(a, b, c float32) float32 {
	if a > b {
		a, b = b, a
	}
	if b > c {
		b, c = c, b
	}
	if a > b {
		a, b = b, a
	}
	return b
}

// Reset clears the normalizer state (e.g. after a multi-second gap).
func (n *FeatureNormalizer) Reset() {
	*n = FeatureNormalizer{}
}

// Step ingests one 20 ms resampled RSSI observation and returns the 3-channel feature vector
// along with the spike-rejected 3-point median RSSI and current ambient floor estimate.
func (n *FeatureNormalizer) Step(rawRssiDbm float32, reportedFloorDbm float32) ([InputChannels]float32, float32, float32) {
	if reportedFloorDbm >= -115 && reportedFloorDbm <= -65 {
		if !n.initialized {
			n.floorDbm = reportedFloorDbm
		} else {
			n.floorDbm = 0.98*n.floorDbm + 0.02*reportedFloorDbm
		}
	} else if !n.initialized {
		n.floorDbm = -91.0
	}

	wasUninit := !n.initialized
	if !n.initialized {
		n.initialized = true
	}

	// 3-step (60 ms) median rejects single-sweep RF glitches before computing slope.
	var med float32
	switch n.medCount {
	case 0:
		n.medBuf[0] = rawRssiDbm
		n.medCount = 1
		med = rawRssiDbm
	case 1:
		n.medBuf[1] = rawRssiDbm
		n.medCount = 2
		med = 0.5 * (n.medBuf[0] + n.medBuf[1])
	default:
		if n.medCount == 2 {
			n.medBuf[2] = rawRssiDbm
			n.medCount = 3
		} else {
			n.medBuf[0] = n.medBuf[1]
			n.medBuf[1] = n.medBuf[2]
			n.medBuf[2] = rawRssiDbm
		}
		med = median3(n.medBuf[0], n.medBuf[1], n.medBuf[2])
	}

	// Gently track ambient baseline if raw signal sits near or below reported floor.
	if med < n.floorDbm {
		n.floorDbm = 0.95*n.floorDbm + 0.05*med
	} else if med < n.floorDbm+4.0 {
		n.floorDbm = 0.998*n.floorDbm + 0.002*med
	}

	if wasUninit {
		n.slowEmaDbm = n.floorDbm
	}
	prevSlow := n.slowEmaDbm
	if med < n.slowEmaDbm {
		// Recover promptly after a pass or launch-pad takeoff (~1.3 s tau)
		n.slowEmaDbm = 0.985*n.slowEmaDbm + 0.015*med
	} else {
		// Track ambient/far-field shelf with a ~5.0 s time constant and cap at floor + 13 dB so
		// compact-track chatter is suppressed without letting 2-3 s straight-in approach ramps or
		// launch-pad hover shelves climb up to the pass crest.
		n.slowEmaDbm = 0.996*n.slowEmaDbm + 0.004*med
		maxSlow := n.floorDbm + 13.0
		if n.slowEmaDbm > maxSlow {
			n.slowEmaDbm = maxSlow
		}
	}

	var prev6, prev16 float32
	if n.histCount == 0 {
		prev6 = med
		prev16 = med
	} else {
		prev16 = n.histRssi[0]
		idx6 := n.histCount - 6
		if idx6 < 0 {
			idx6 = 0
		}
		prev6 = n.histRssi[idx6]
	}
	if n.histCount < len(n.histRssi) {
		n.histRssi[n.histCount] = med
		n.histCount++
	} else {
		copy(n.histRssi[:], n.histRssi[1:])
		n.histRssi[len(n.histRssi)-1] = med
	}

	slopeFast := (med - prev6) / 14.0
	slopeMed := (med - prev16) / 18.0
	ch0 := clamp32((med-n.floorDbm)/35.0, -0.25, 1.6)
	ch1 := clamp32((med-prevSlow)/22.0, -1.2, 1.5)
	ch2 := clamp32(0.55*slopeFast+0.45*slopeMed, -1.5, 1.5)
	return [InputChannels]float32{ch0, ch1, ch2}, med, n.floorDbm
}

// RawPoint represents a single-gate, single-pilot raw RSSI sample prior to 50 Hz resampling.
type RawPoint struct {
	TimestampUs   uint64
	RSSIDbm       float32
	NoiseFloorDbm float32
}

// GridSequence holds a uniform 50 Hz (20 ms) resampled trace segment ready for 1D TCN training/eval.
type GridSequence struct {
	StartTsUs uint64
	Features  [][InputChannels]float32
	MedRSSI   []float32
	FloorDbm  []float32
}

// ResampleSegments converts irregular 50/100 Hz raw points into contiguous 20 ms `GridSequence`
// segments, splitting cleanly across telemetry gaps > 1.5 seconds.
func ResampleSegments(points []RawPoint) []GridSequence {
	if len(points) < 8 {
		return nil
	}
	const maxGapUs = 1_500_000
	var out []GridSequence

	segStart := 0
	for i := 1; i <= len(points); i++ {
		split := i == len(points)
		if !split {
			if points[i].TimestampUs < points[i-1].TimestampUs ||
				points[i].TimestampUs-points[i-1].TimestampUs > maxGapUs {
				split = true
			}
		}
		if split {
			sub := points[segStart:i]
			if seq, ok := resampleContiguous(sub); ok {
				out = append(out, seq)
			}
			segStart = i
		}
	}
	return out
}

func resampleContiguous(pts []RawPoint) (GridSequence, bool) {
	if len(pts) < 3 {
		return GridSequence{}, false
	}
	startTs := pts[0].TimestampUs
	endTs := pts[len(pts)-1].TimestampUs
	if endTs <= startTs+uint64(3*StepUs) {
		return GridSequence{}, false
	}
	nSteps := int((endTs-startTs)/StepUs) + 1
	if nSteps < 4 {
		return GridSequence{}, false
	}

	feats := make([][InputChannels]float32, nSteps)
	meds := make([]float32, nSteps)
	floors := make([]float32, nSteps)

	var norm FeatureNormalizer
	srcIdx := 0
	for step := 0; step < nSteps; step++ {
		gridTs := startTs + uint64(step)*StepUs
		// Aggregate max RSSI inside [gridTs - StepUs/2, gridTs + StepUs/2] if multiple 100 Hz samples fall in bin,
		// otherwise linearly interpolate between straddling samples.
		winLo := gridTs
		if gridTs >= StepUs/2 {
			winLo = gridTs - StepUs/2
		}
		winHi := gridTs + StepUs/2

		for srcIdx+1 < len(pts) && pts[srcIdx+1].TimestampUs < winLo {
			srcIdx++
		}

		var rssi, floor float32
		hasInBin := false
		bestRssi := float32(-200.0)
		for j := srcIdx; j < len(pts) && pts[j].TimestampUs <= winHi; j++ {
			if pts[j].TimestampUs >= winLo {
				if !hasInBin || pts[j].RSSIDbm > bestRssi {
					bestRssi = pts[j].RSSIDbm
					floor = pts[j].NoiseFloorDbm
					hasInBin = true
				}
			}
		}
		if hasInBin {
			rssi = bestRssi
		} else {
			// Interpolate between pts[srcIdx] and pts[srcIdx+1]
			for srcIdx+1 < len(pts) && pts[srcIdx+1].TimestampUs < gridTs {
				srcIdx++
			}
			p0 := pts[srcIdx]
			if srcIdx+1 < len(pts) && pts[srcIdx+1].TimestampUs > p0.TimestampUs && gridTs > p0.TimestampUs {
				p1 := pts[srcIdx+1]
				alpha := float32(math.Min(1.0, float64(gridTs-p0.TimestampUs)/float64(p1.TimestampUs-p0.TimestampUs)))
				rssi = p0.RSSIDbm + alpha*(p1.RSSIDbm-p0.RSSIDbm)
				floor = p0.NoiseFloorDbm + alpha*(p1.NoiseFloorDbm-p0.NoiseFloorDbm)
			} else {
				rssi = p0.RSSIDbm
				floor = p0.NoiseFloorDbm
			}
		}

		f, m, fl := norm.Step(rssi, floor)
		feats[step] = f
		meds[step] = m
		floors[step] = fl
	}

	return GridSequence{
		StartTsUs: startTs,
		Features:  feats,
		MedRSSI:   meds,
		FloorDbm:  floors,
	}, true
}
