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
// full-trace training and live real-time streaming produce identical inputs:
//   - ch0: Excess above rolling ambient noise floor: clamp((rssi - floor) / 35.0, -0.2, 1.5)
//   - ch1: Prominence vs pilot rolling peak envelope: clamp((rssi - peakEnv) / 20.0, -1.5, 0.5)
//   - ch2: Local 60 ms slope: clamp((rssi[t] - rssi[t-3]) / 15.0, -1.5, 1.5)
type FeatureNormalizer struct {
	initialized bool
	floorDbm    float32
	peakEnvDbm  float32
	medBuf      [3]float32
	medCount    int
	histRssi    [4]float32
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

	if !n.initialized {
		n.initialized = true
		n.peakEnvDbm = n.floorDbm + 20.0
		if rawRssiDbm > n.peakEnvDbm {
			n.peakEnvDbm = rawRssiDbm
		}
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

	// Gently track ambient baseline if raw signal sits below reported floor, and gently decay
	// peakEnvDbm (tau ~ 40 s = 2000 steps) toward floor + 20 dB during lulls.
	if med < n.floorDbm {
		n.floorDbm = 0.95*n.floorDbm + 0.05*med
	} else if med < n.floorDbm+4.0 {
		n.floorDbm = 0.998*n.floorDbm + 0.002*med
	}

	minPeakTarget := n.floorDbm + 20.0
	if med > n.peakEnvDbm {
		n.peakEnvDbm = 0.40*n.peakEnvDbm + 0.60*med
	} else {
		n.peakEnvDbm = 0.9992*n.peakEnvDbm + 0.0008*minPeakTarget
		if n.peakEnvDbm < minPeakTarget {
			n.peakEnvDbm = minPeakTarget
		}
	}

	var prev3 float32
	if n.histCount == 0 {
		prev3 = med
	} else if n.histCount < 3 {
		prev3 = n.histRssi[0]
	} else {
		prev3 = n.histRssi[0]
	}
	if n.histCount < 3 {
		n.histRssi[n.histCount] = med
		n.histCount++
	} else {
		n.histRssi[0] = n.histRssi[1]
		n.histRssi[1] = n.histRssi[2]
		n.histRssi[2] = med
	}

	ch0 := clamp32((med-n.floorDbm)/35.0, -0.25, 1.6)
	ch1 := clamp32((med-n.peakEnvDbm)/20.0, -1.6, 0.6)
	ch2 := clamp32((med-prev3)/15.0, -1.5, 1.5)
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
	if len(pts) < 8 {
		return GridSequence{}, false
	}
	startTs := pts[0].TimestampUs
	endTs := pts[len(pts)-1].TimestampUs
	if endTs <= startTs+uint64(6*StepUs) {
		return GridSequence{}, false
	}
	nSteps := int((endTs-startTs)/StepUs) + 1
	if nSteps < 16 {
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
