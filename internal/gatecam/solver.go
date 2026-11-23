package gatecam

import (
	"fmt"
	"math"
	"sort"
)

// DefaultGateLine returns a centered vertical Gate Plane Line with Left -> Right flight direction.
func DefaultGateLine() GateLine {
	return GateLine{
		P1X:               0.50,
		P1Y:               0.14,
		P2X:               0.50,
		P2Y:               0.86,
		DirSign:           1,
		BandHalfWidthNorm: 0.18,
		Locked:            false,
	}
}

// DefaultCameraConfig returns outdoor-friendly high-FPS capture defaults.
func DefaultCameraConfig() CameraConfig {
	return CameraConfig{
		TargetFPS:          120,
		ShutterUs:          500, // 1/2000 s freezes 70 mph quads to ~1.5 cm blur
		FocusLocked:        false,
		MotionModel:        "mog2",
		Sensitivity:        16.0,
		LookbackHalfMs:     450,
		RollingShutterComp: true,
	}
}

// GateNormalPx returns `(p1x, p1y, txUnit, tyUnit, segLenPx, nxUnit, nyUnit)` in pixel coordinates.
// When P1 is top `(x, y1)` and P2 is bottom `(x, y2)` with `DirSign = +1`, `(nx, ny) = (+1, 0)` (Left -> Right).
func GateNormalPx(g GateLine, width, height float64) (p1x, p1y, tx, ty, segLen, nx, ny float64) {
	if width <= 0 {
		width = 640
	}
	if height <= 0 {
		height = 360
	}
	dir := 1.0
	if g.DirSign < 0 {
		dir = -1.0
	}
	p1x = g.P1X * width
	p1y = g.P1Y * height
	dx := g.P2X*width - p1x
	dy := g.P2Y*height - p1y
	segLen = math.Hypot(dx, dy)
	if segLen < 1e-3 {
		return p1x, p1y, 0, 1, 1, dir, 0
	}
	tx = dx / segLen
	ty = dy / segLen
	nx = dir * ty
	ny = -dir * tx
	return p1x, p1y, tx, ty, segLen, nx, ny
}

// FrameTimestampUs converts a frame's hardware sensor readout start + rolling-shutter row skew +
// half exposure duration into SlapRF's `serverTimestampUs` clock domain.
func FrameTimestampUs(obs FrameObservation, rowNorm float64, clockOffsetUs int64, rollingShutterComp bool) uint64 {
	if rowNorm < 0 {
		rowNorm = 0
	} else if rowNorm > 1 {
		rowNorm = 1
	}
	var skewNs int64
	if rollingShutterComp && obs.RollingShutterSkewNs > 0 {
		skewNs = int64(math.Round(rowNorm * float64(obs.RollingShutterSkewNs)))
	}
	midSensorNs := obs.SensorTimestampNs + skewNs + obs.ExposureTimeNs/2
	us := midSensorNs/1000 + clockOffsetUs
	if us < 0 {
		return 0
	}
	return uint64(us)
}

// SolveLookback analyzes per-frame OpenCV observations in a lookback burst around `rfTimestampUs`,
// populates per-frame timestamps and signed distances `d_k` from the Gate Plane Line, identifies
// the forward-moving drone trajectory crossing `d = 0`, and computes sub-frame `CamTimestampUs` + `GateBiasMs`.
func SolveLookback(rec *PassRecord, frames []FrameObservation, gate GateLine, clockOffsetUs int64, rollingShutterComp bool) {
	rec.GateSnapshot = gate
	rec.FrameCount = len(frames)
	if len(frames) == 0 {
		rec.Status = PassStatusNeedsManual
		rec.AutoStatus = PassStatusNeedsManual
		rec.Frames = []FrameObservation{}
		return
	}

	w := float64(frames[0].FrameWidth)
	h := float64(frames[0].FrameHeight)
	if w <= 0 {
		w = 640
	}
	if h <= 0 {
		h = 360
	}
	p1x, p1y, tx, ty, segLen, nx, ny := GateNormalPx(gate, w, h)
	bandHalfPx := gate.BandHalfWidthNorm * w
	if bandHalfPx < 40 {
		bandHalfPx = 115
	}

	// 1. Stamp every frame's timestamp & signed Gate-Line distance, and locate frame nearest t_RF.
	nearestRFIdx := 0
	nearestRFAbsUs := uint64(math.MaxUint64)
	var candidateIdxs []int

	for i := range frames {
		f := &frames[i]
		f.Index = i
		row := 0.5
		if f.HasBlob {
			// In portrait (360x640, rotated 90 deg CW from landscape sensor), sensor readout rows run right-to-left (1 - cx)
			if h > w {
				row = 1.0 - f.BlobCX
			} else {
				row = f.BlobCY
			}
		}
		tsUs := FrameTimestampUs(*f, row, clockOffsetUs, rollingShutterComp)
		f.FrameTimestampUs = tsUs
		f.RelToRFMs = round3(float64(int64(tsUs)-int64(rec.RFTimestampUs)) / 1000.0)

		var absDiff uint64
		if tsUs >= rec.RFTimestampUs {
			absDiff = tsUs - rec.RFTimestampUs
		} else {
			absDiff = rec.RFTimestampUs - tsUs
		}
		if absDiff < nearestRFAbsUs {
			nearestRFAbsUs = absDiff
			nearestRFIdx = i
		}

		if f.HasBlob {
			cx := f.BlobCX * w
			cy := f.BlobCY * h
			rx := cx - p1x
			ry := cy - p1y
			along := rx*tx + ry*ty
			signedD := rx*nx + ry*ny
			f.SignedDistPx = round2(signedD)

			// Accept blobs within longitudinal margin [-0.20*L, +1.20*L] and lateral band
			if along >= -0.20*segLen && along <= 1.20*segLen && math.Abs(signedD) <= bandHalfPx*1.35 {
				candidateIdxs = append(candidateIdxs, i)
			}
		}
	}
	rec.RFNearestFrameIdx = nearestRFIdx

	// Estimate nominal frame period (ms) for frame-unit bias reporting.
	framePeriodMs := estimateFramePeriodMs(frames)

	// 2. Group candidate detections into contiguous forward tracks (allowing up to 2 missed frames).
	type trackSeg struct {
		idxs []int
	}
	var tracks []trackSeg
	for _, idx := range candidateIdxs {
		placed := false
		if len(tracks) > 0 {
			cur := &tracks[len(tracks)-1]
			prevIdx := cur.idxs[len(cur.idxs)-1]
			gap := idx - prevIdx
			if gap <= 3 {
				dStep := frames[idx].SignedDistPx - frames[prevIdx].SignedDistPx
				// Forward progression (allow tiny -3 px jitter on slow hovering passes)
				if dStep >= -3.5 {
					cur.idxs = append(cur.idxs, idx)
					placed = true
				}
			}
		}
		if !placed {
			tracks = append(tracks, trackSeg{idxs: []int{idx}})
		}
	}

	// 3. Score tracks: must advance forward across or right onto d = 0 near t_RF.
	bestTrackIdx := -1
	bestScore := -1e9
	for ti, tr := range tracks {
		if len(tr.idxs) < 2 {
			continue
		}
		first := frames[tr.idxs[0]]
		last := frames[tr.idxs[len(tr.idxs)-1]]
		advance := last.SignedDistPx - first.SignedDistPx
		if advance < 6.0 {
			continue
		}
		minD := first.SignedDistPx
		maxD := first.SignedDistPx
		minAbsD := math.Abs(first.SignedDistPx)
		closestFrame := tr.idxs[0]
		flowForwardSum := 0.0
		for _, k := range tr.idxs {
			d := frames[k].SignedDistPx
			if d < minD {
				minD = d
			}
			if d > maxD {
				maxD = d
			}
			if math.Abs(d) < minAbsD {
				minAbsD = math.Abs(d)
				closestFrame = k
			}
			flowForwardSum += frames[k].FlowVX*nx + frames[k].FlowVY*ny
		}
		// Must either straddle d = 0 or pass within 5 px of the line
		straddles := minD <= 2.0 && maxD >= -2.0 && (minD <= 0 && maxD >= 0 || minAbsD <= 5.0)
		if !straddles {
			continue
		}
		// Reject tracks whose optical flow strongly opposes the Gate normal
		if flowForwardSum < -4.0 {
			continue
		}
		timeDistMs := math.Abs(frames[closestFrame].RelToRFMs)
		score := 200.0 - timeDistMs + math.Min(40.0, float64(len(tr.idxs))*6.0) + math.Min(30.0, advance*0.5)
		if score > bestScore {
			bestScore = score
			bestTrackIdx = ti
		}
	}

	if bestTrackIdx < 0 {
		rec.Status = PassStatusNeedsManual
		rec.AutoStatus = PassStatusNeedsManual
		rec.CrossingFrameIdx = nearestRFIdx
		rec.Confidence = 0
		rec.Frames = frames
		if len(frames[nearestRFIdx].JPEG) > 0 {
			rec.ThumbJPEG = frames[nearestRFIdx].JPEG
		}
		return
	}

	chosen := tracks[bestTrackIdx].idxs
	for _, k := range chosen {
		frames[k].OnTrack = true
	}

	// 4. Find crossing frame k* (minimal |d_k|) and sub-frame zero-crossing interpolation.
	crossIdx := chosen[0]
	minAbs := math.Abs(frames[crossIdx].SignedDistPx)
	var totalFlow float64
	var maxArea int
	for i, k := range chosen {
		d := math.Abs(frames[k].SignedDistPx)
		if d < minAbs {
			minAbs = d
			crossIdx = k
		}
		if frames[k].BlobAreaPx > maxArea {
			maxArea = frames[k].BlobAreaPx
		}
		if i > 0 {
			prev := frames[chosen[i-1]]
			cur := frames[k]
			span := float64(k - chosen[i-1])
			stepPx := math.Hypot((cur.BlobCX-prev.BlobCX)*w, (cur.BlobCY-prev.BlobCY)*h) / span
			totalFlow += stepPx
		}
	}
	avgSpeedPx := 0.0
	if len(chosen) > 1 {
		avgSpeedPx = round1(totalFlow / float64(len(chosen)-1))
	}

	// Bracket [a, b] where d_a <= 0 and d_b >= 0
	bracketA, bracketB := -1, -1
	for i := 0; i < len(chosen)-1; i++ {
		ka, kb := chosen[i], chosen[i+1]
		if frames[ka].SignedDistPx <= 0 && frames[kb].SignedDistPx >= 0 {
			bracketA, bracketB = ka, kb
			break
		}
	}

	var camTsUs uint64
	fracFrame := float64(crossIdx)
	if bracketA >= 0 && bracketB >= 0 {
		fa := frames[bracketA]
		fb := frames[bracketB]
		denom := fb.SignedDistPx - fa.SignedDistPx
		alpha := 0.5
		if denom > 1e-6 {
			alpha = (-fa.SignedDistPx) / denom
		}
		if alpha < 0 {
			alpha = 0
		} else if alpha > 1 {
			alpha = 1
		}
		ta := float64(fa.FrameTimestampUs)
		tb := float64(fb.FrameTimestampUs)
		// Refine with local weighted linear regression across up to 6 track samples around 0,
		// clamped strictly within the bracketing interval [ta, tb].
		regTs, ok := fitZeroCrossingUs(frames, chosen, crossIdx)
		interpTs := ta + alpha*(tb-ta)
		if ok && regTs >= ta && regTs <= tb {
			camTsUs = uint64(math.Round(0.5*interpTs + 0.5*regTs))
		} else {
			camTsUs = uint64(math.Round(interpTs))
		}
		if tb > ta {
			fracFrame = float64(bracketA) + ((float64(camTsUs)-ta)/(tb-ta))*float64(bracketB-bracketA)
		}
	} else {
		// Closest frame was within 5 px of 0 without straddling
		if regTs, ok := fitZeroCrossingUs(frames, chosen, crossIdx); ok {
			camTsUs = uint64(math.Round(regTs))
		} else {
			camTsUs = frames[crossIdx].FrameTimestampUs
		}
	}

	// Confidence score (0.55 .. 0.99)
	conf := 0.65
	if bracketA >= 0 {
		conf += 0.18
	}
	if len(chosen) >= 4 {
		conf += 0.10
	}
	if avgSpeedPx >= 4.0 {
		conf += 0.05
	}
	if conf > 0.99 {
		conf = 0.99
	}

	rec.Status = PassStatusAuto
	rec.AutoStatus = PassStatusAuto
	rec.Confidence = round2(conf)
	rec.AutoCamTimestampUs = camTsUs
	rec.AutoCrossingFrameIdx = crossIdx
	rec.AutoFractionalFrame = round2(fracFrame)
	rec.CamTimestampUs = camTsUs
	rec.CrossingFrameIdx = crossIdx
	rec.FlowSpeedPxPerFr = avgSpeedPx
	rec.BlobAreaPx = maxArea
	rec.Frames = frames
	if len(frames[crossIdx].JPEG) > 0 {
		rec.ThumbJPEG = frames[crossIdx].JPEG
	}
	populatePassBias(rec, framePeriodMs)
}

func fitZeroCrossingUs(frames []FrameObservation, trackIdxs []int, centerFrame int) (float64, bool) {
	// Fit d(t) = a + b*(t - t0) over track points within ±3 positions of centerFrame
	var xs, ys []float64
	t0 := float64(frames[centerFrame].FrameTimestampUs)
	for _, k := range trackIdxs {
		if math.Abs(float64(k-centerFrame)) <= 3 {
			xs = append(xs, float64(frames[k].FrameTimestampUs)-t0)
			ys = append(ys, frames[k].SignedDistPx)
		}
	}
	if len(xs) < 2 {
		return 0, false
	}
	var mx, my float64
	for i := range xs {
		mx += xs[i]
		my += ys[i]
	}
	mx /= float64(len(xs))
	my /= float64(len(ys))
	var num, den float64
	for i := range xs {
		dx := xs[i] - mx
		num += dx * (ys[i] - my)
		den += dx * dx
	}
	if math.Abs(den) < 1e-6 {
		return 0, false
	}
	slope := num / den // px per microsecond
	if slope <= 1e-9 {
		return 0, false
	}
	intercept := my - slope*mx
	tZero := t0 - intercept/slope
	return tZero, true
}

func estimateFramePeriodMs(frames []FrameObservation) float64 {
	if len(frames) < 2 {
		return 1000.0 / 60.0
	}
	spanUs := float64(frames[len(frames)-1].FrameTimestampUs) - float64(frames[0].FrameTimestampUs)
	if spanUs <= 0 {
		return 1000.0 / 60.0
	}
	p := (spanUs / 1000.0) / float64(len(frames)-1)
	if p < 1.0 {
		return 8.333
	}
	return p
}

func populatePassBias(rec *PassRecord, framePeriodMs float64) {
	if rec.CamTimestampUs == 0 || (rec.Status != PassStatusAuto && rec.Status != PassStatusManual) {
		rec.GateBiasMs = nil
		rec.GateBiasFrames = nil
		rec.SpatialBiasCm = nil
		return
	}
	biasMs := round2(float64(int64(rec.RFTimestampUs)-int64(rec.CamTimestampUs)) / 1000.0)
	rec.GateBiasMs = &biasMs
	if framePeriodMs > 0 {
		bf := round2(biasMs / framePeriodMs)
		rec.GateBiasFrames = &bf
	}
	if rec.EstimatedSpeedMph > 0.5 {
		mps := rec.EstimatedSpeedMph * 0.44704
		cm := round1((biasMs / 1000.0) * mps * 100.0)
		rec.SpatialBiasCm = &cm
	}
}

// RecomputeLapsAndStats updates consecutive lap durations (`LapRFSec`, `LapCamSec`, `LapDeltaMs`)
// across `passes` (ordered oldest -> newest) and computes aggregate `SessionStats`.
func RecomputeLapsAndStats(passes []*PassRecord) SessionStats {
	type lastSeen struct {
		rfUs  uint64
		camUs uint64
		lapN  int
	}
	prevByKey := make(map[string]lastSeen)

	var biases []float64
	var biasCms []float64
	var lapDeltas []float64
	var slowBiases, medBiases, fastBiases []float64

	st := SessionStats{
		TotalPasses: len(passes),
	}

	for _, p := range passes {
		p.LapNumber = 0
		p.LapRFSec = nil
		p.LapCamSec = nil
		p.LapDeltaMs = nil

		switch p.Status {
		case PassStatusExcluded:
			st.ExcludedCount++
			continue
		case PassStatusNeedsManual:
			st.NeedsManualCount++
			continue
		case PassStatusManual:
			st.ManualPasses++
			st.ValidPasses++
		case PassStatusAuto:
			st.ValidPasses++
		default:
			continue
		}

		if p.GateBiasMs != nil {
			b := *p.GateBiasMs
			biases = append(biases, b)
			if p.SpatialBiasCm != nil {
				biasCms = append(biasCms, *p.SpatialBiasCm)
			}
			switch {
			case p.HoldMs > 250:
				slowBiases = append(slowBiases, b)
			case p.HoldMs > 0 && p.HoldMs < 130:
				fastBiases = append(fastBiases, b)
			default:
				medBiases = append(medBiases, b)
			}
		}

		if p.RFTimestampUs > 0 && p.CamTimestampUs > 0 {
			key := fmt.Sprintf("%d:%d", p.GateID, p.SlotIndex)
			if prev, ok := prevByKey[key]; ok && p.RFTimestampUs > prev.rfUs && p.CamTimestampUs > prev.camUs {
				dtRFSec := float64(p.RFTimestampUs-prev.rfUs) / 1e6
				dtCamSec := float64(p.CamTimestampUs-prev.camUs) / 1e6
				// Pair consecutive passes between 1.5 s and 180 s as a valid lap
				if dtRFSec >= 1.5 && dtRFSec <= 180.0 && dtCamSec >= 1.5 && dtCamSec <= 180.0 {
					nextLap := prev.lapN + 1
					rfRound := round4(dtRFSec)
					camRound := round4(dtCamSec)
					deltaMs := round2((dtRFSec - dtCamSec) * 1000.0)
					p.LapNumber = nextLap
					p.LapRFSec = &rfRound
					p.LapCamSec = &camRound
					p.LapDeltaMs = &deltaMs
					lapDeltas = append(lapDeltas, deltaMs)
					prevByKey[key] = lastSeen{rfUs: p.RFTimestampUs, camUs: p.CamTimestampUs, lapN: nextLap}
					continue
				}
			}
			prevByKey[key] = lastSeen{rfUs: p.RFTimestampUs, camUs: p.CamTimestampUs, lapN: 0}
		}
	}

	st.MeanBiasMs, st.StdBiasMs, st.P95AbsBiasMs, st.MaxAbsBiasMs = summarizeSeries(biases)
	if len(biasCms) > 0 {
		mCm, _, _, _ := summarizeSeries(biasCms)
		st.MeanBiasCm = mCm
	}
	st.LapCount = len(lapDeltas)
	st.MeanLapDeltaMs, st.StdLapDeltaMs, st.P95AbsLapDeltaMs, st.MaxAbsLapDeltaMs = summarizeSeries(lapDeltas)
	st.Histogram = buildBiasHistogram(biases)
	st.SpeedBuckets = []SpeedBucketStats{
		buildSpeedBucket("Slow (>250 ms hold)", slowBiases),
		buildSpeedBucket("Medium (130-250 ms)", medBiases),
		buildSpeedBucket("Fast (<130 ms hold)", fastBiases),
	}
	return st
}

func summarizeSeries(vals []float64) (mean, std, p95Abs, maxAbs float64) {
	n := len(vals)
	if n == 0 {
		return 0, 0, 0, 0
	}
	var sum float64
	absVals := make([]float64, n)
	for i, v := range vals {
		sum += v
		av := math.Abs(v)
		absVals[i] = av
		if av > maxAbs {
			maxAbs = av
		}
	}
	mean = sum / float64(n)
	if n > 1 {
		var sq float64
		for _, v := range vals {
			d := v - mean
			sq += d * d
		}
		std = math.Sqrt(sq / float64(n-1))
	}
	sort.Float64s(absVals)
	idx95 := int(math.Ceil(0.95*float64(n))) - 1
	if idx95 < 0 {
		idx95 = 0
	}
	if idx95 >= n {
		idx95 = n - 1
	}
	p95Abs = absVals[idx95]
	return round2(mean), round2(std), round2(p95Abs), round2(maxAbs)
}

func buildBiasHistogram(biases []float64) []HistogramBin {
	edges := []struct {
		label string
		min   float64
		max   float64
	}{
		{"< -12 ms", -1e9, -12},
		{"-12..-8 ms", -12, -8},
		{"-8..-4 ms", -8, -4},
		{"-4..0 ms", -4, 0},
		{"0..+4 ms", 0, 4},
		{"+4..+8 ms", 4, 8},
		{"+8..+12 ms", 8, 12},
		{"> +12 ms", 12, 1e9},
	}
	bins := make([]HistogramBin, len(edges))
	for i, e := range edges {
		bins[i] = HistogramBin{Label: e.label, MinMs: e.min, MaxMs: e.max}
	}
	for _, b := range biases {
		for i, e := range edges {
			if b >= e.min && (b < e.max || i == len(edges)-1) {
				bins[i].Count++
				break
			}
		}
	}
	return bins
}

func buildSpeedBucket(label string, vals []float64) SpeedBucketStats {
	m, s, _, _ := summarizeSeries(vals)
	return SpeedBucketStats{
		Label:      label,
		Count:      len(vals),
		MeanBiasMs: m,
		StdBiasMs:  s,
	}
}

func SummaryOf(p *PassRecord) PassSummary {
	return PassSummary{
		PassID:            p.PassID,
		CreatedAt:         p.CreatedAt,
		GateID:            p.GateID,
		GateName:          p.GateName,
		SlotIndex:         p.SlotIndex,
		Callsign:          p.Callsign,
		FrequencyMHz:      p.FrequencyMHz,
		PeakRSSIDbm:       p.PeakRSSIDbm,
		HoldMs:            p.HoldMs,
		EstimatedSpeedMph: p.EstimatedSpeedMph,
		Status:            p.Status,
		Confidence:        p.Confidence,
		RFTimestampUs:     p.RFTimestampUs,
		CamTimestampUs:    p.CamTimestampUs,
		CrossingFrameIdx:  p.CrossingFrameIdx,
		FrameCount:        p.FrameCount,
		GateBiasMs:        p.GateBiasMs,
		GateBiasFrames:    p.GateBiasFrames,
		SpatialBiasCm:     p.SpatialBiasCm,
		LapNumber:         p.LapNumber,
		LapRFSec:          p.LapRFSec,
		LapCamSec:         p.LapCamSec,
		LapDeltaMs:        p.LapDeltaMs,
	}
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }
func round2(v float64) float64 { return math.Round(v*100) / 100 }
func round3(v float64) float64 { return math.Round(v*1000) / 1000 }
func round4(v float64) float64 { return math.Round(v*10000) / 10000 }
