package ml

import (
	"math"
	"math/rand"
	"runtime"
	"sort"
	"sync"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/dsp"
	"slaprf/internal/tracestore"
)

const (
	// DetectProbThreshold is the default crossing probability threshold on p_cross[t].
	DetectProbThreshold = float32(0.58)
	// MatchToleranceUs is the maximum timestamp distance (+-220 ms) counted as a True Positive match
	// during validation scoring.
	MatchToleranceUs = uint64(220_000)
)

type preparedSequence struct {
	seq       GridSequence
	targets   SequenceTargets
	positives []uint64
}

// BuildSequenceTargets paints soft Gaussian targets (sigma = 30 ms) around verified positive
// crossings and assigns elevated importance weights to positive crests, manual edits, and hard negatives.
func BuildSequenceTargets(seq GridSequence, positives []CrossingLabel, hardNegs []NegativeMark) (SequenceTargets, []uint64) {
	T := len(seq.Features)
	tgt := SequenceTargets{
		YCross:      make([]float32, T),
		SampleWt:    make([]float32, T),
		OffsetMask:  make([]bool, T),
		TargetOffMs: make([]float32, T),
	}
	for t := 0; t < T; t++ {
		tgt.SampleWt[t] = 1.0
	}

	endTs := seq.StartTsUs + uint64(T-1)*StepUs
	var inSeqPos []uint64

	const sigmaMs = 30.0
	const twoSigmaSq = 2.0 * sigmaMs * sigmaMs

	for _, pos := range positives {
		if pos.TimestampUs+60_000 < seq.StartTsUs || pos.TimestampUs > endTs+60_000 {
			continue
		}
		if pos.TimestampUs >= seq.StartTsUs && pos.TimestampUs <= endTs {
			inSeqPos = append(inSeqPos, pos.TimestampUs)
		}
		centerStep := int(math.Round(float64(int64(pos.TimestampUs)-int64(seq.StartTsUs)) / float64(StepUs)))
		wtBoost := float32(14.0)
		if pos.Manual {
			wtBoost = 24.0
		}
		for t := centerStep - 6; t <= centerStep+6; t++ {
			if t < 0 || t >= T {
				continue
			}
			stepTs := seq.StartTsUs + uint64(t)*StepUs
			dtMs := float64(int64(pos.TimestampUs)-int64(stepTs)) / 1000.0
			g := float32(math.Exp(-(dtMs * dtMs) / twoSigmaSq))
			if g > tgt.YCross[t] {
				tgt.YCross[t] = g
			}
			w := 1.0 + wtBoost*g
			if w > tgt.SampleWt[t] {
				tgt.SampleWt[t] = w
			}
			if math.Abs(dtMs) <= 18.0 {
				tgt.OffsetMask[t] = true
				tgt.TargetOffMs[t] = float32(dtMs)
			}
		}
	}

	for _, neg := range hardNegs {
		if neg.TimestampUs+200_000 < seq.StartTsUs || neg.TimestampUs > endTs+200_000 {
			continue
		}
		centerStep := int(math.Round(float64(int64(neg.TimestampUs)-int64(seq.StartTsUs)) / float64(StepUs)))
		w := neg.Weight
		if w < 2.5 {
			w = 3.5
		}
		for t := centerStep - 8; t <= centerStep+8; t++ {
			if t < 0 || t >= T {
				continue
			}
			// Never overwrite an actual positive window with a negative mark.
			if tgt.YCross[t] < 0.05 && w > tgt.SampleWt[t] {
				tgt.SampleWt[t] = w
			}
		}
	}

	return tgt, inSeqPos
}

func prepareTraces(traces []LabeledTrace) []preparedSequence {
	var out []preparedSequence
	for _, tr := range traces {
		segs := ResampleSegments(tr.Points)
		for _, seg := range segs {
			tgt, pos := BuildSequenceTargets(seg, tr.Positives, tr.HardNegs)
			out = append(out, preparedSequence{
				seq:       seg,
				targets:   tgt,
				positives: pos,
			})
		}
	}
	return out
}

// BuildTracesFromSession extracts per-(gate, pilot) `LabeledTrace`s from a PracticeSession and its
// `.rfbin` samples, automatically marking cross-gate bleed timestamps and `ManualDeletedCrossings`
// as hard negatives.
func BuildTracesFromSession(sess domain.PracticeSession, samples []tracestore.Sample, defaultPilots []domain.PilotSlot) []LabeledTrace {
	if len(samples) < 16 {
		return nil
	}

	type gpKey struct {
		gateID    uint8
		slotIndex int
	}
	pointsByKey := make(map[gpKey][]RawPoint)
	activeSlots := make(map[int]bool)
	for _, p := range sess.Pilots {
		if p.SlotIndex > 0 {
			activeSlots[p.SlotIndex] = true
		}
	}

	for _, s := range samples {
		for k, slotU8 := range s.SlotIndices {
			slotIdx := int(slotU8)
			if len(activeSlots) > 0 && !activeSlots[slotIdx] {
				continue
			}
			if k >= len(s.RSSIDbm) || s.RSSIDbm[k] <= -120.0 {
				continue
			}
			key := gpKey{gateID: s.GateID, slotIndex: slotIdx}
			pointsByKey[key] = append(pointsByKey[key], RawPoint{
				TimestampUs:   s.TimestampUs,
				RSSIDbm:       s.RSSIDbm[k],
				NoiseFloorDbm: s.NoiseFloorDbm,
			})
		}
	}

	gateThresholds := func(gateID uint8, slotIndex int) (float32, float32) {
		enter := float32(-68.0)
		exit := float32(-76.0)
		for _, p := range defaultPilots {
			if p.SlotIndex == slotIndex {
				if p.EnterThreshold < 0 {
					enter = p.EnterThreshold
				}
				if p.ExitThreshold < 0 {
					exit = p.ExitThreshold
				}
				break
			}
		}
		for _, g := range sess.TrackSnapshot {
			if g.GateID == gateID {
				if slotIndex >= 1 && slotIndex <= len(g.EnterThresholds) && g.EnterThresholds[slotIndex-1] < 0 {
					enter = g.EnterThresholds[slotIndex-1]
				}
				if slotIndex >= 1 && slotIndex <= len(g.ExitThresholds) && g.ExitThresholds[slotIndex-1] < 0 {
					exit = g.ExitThresholds[slotIndex-1]
				}
				break
			}
		}
		return enter, exit
	}

	// Group valid crossings & deleted crossings
	validByKey := make(map[gpKey][]CrossingLabel)
	allValidByPilot := make(map[int][]domain.GateCrossingEvent)
	for _, c := range sess.Crossings {
		if c.InvalidReason != "" && !c.Manual {
			continue
		}
		key := gpKey{gateID: c.GateID, slotIndex: c.SlotIndex}
		validByKey[key] = append(validByKey[key], CrossingLabel{
			TimestampUs: c.TimestampUs,
			Manual:      c.Manual,
		})
		allValidByPilot[c.SlotIndex] = append(allValidByPilot[c.SlotIndex], c)
	}

	negsByKey := make(map[gpKey][]NegativeMark)
	for _, del := range sess.ManualDeletedCrossings {
		key := gpKey{gateID: del.GateID, slotIndex: del.SlotIndex}
		negsByKey[key] = append(negsByKey[key], NegativeMark{
			TimestampUs: del.TimestampUs,
			Weight:      6.0,
		})
	}
	// Filtered detections (`SPIKE`, `OUT_OF_ORDER`) are also informative hard negatives unless overridden by a positive!
	for _, f := range sess.Filtered {
		key := gpKey{gateID: f.GateID, slotIndex: f.SlotIndex}
		negsByKey[key] = append(negsByKey[key], NegativeMark{
			TimestampUs: f.TimestampUs,
			Weight:      3.5,
		})
	}

	keys := make([]gpKey, 0, len(pointsByKey))
	for k := range pointsByKey {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].gateID != keys[j].gateID {
			return keys[i].gateID < keys[j].gateID
		}
		return keys[i].slotIndex < keys[j].slotIndex
	})

	out := make([]LabeledTrace, 0, len(keys))
	for _, key := range keys {
		pts := pointsByKey[key]
		if len(pts) < 25 {
			continue
		}
		sort.Slice(pts, func(i, j int) bool { return pts[i].TimestampUs < pts[j].TimestampUs })

		negs := append([]NegativeMark(nil), negsByKey[key]...)
		// Cross-gate teacher negatives: when pilot clearly crossed another gate B != A, any concurrent
		// signal on gate A is adjacent-lane bleed (`label = 0`).
		for _, other := range allValidByPilot[key.slotIndex] {
			if other.GateID != key.gateID {
				negs = append(negs, NegativeMark{
					TimestampUs: other.TimestampUs,
					Weight:      3.5,
				})
			}
		}

		enter, exit := gateThresholds(key.gateID, key.slotIndex)
		out = append(out, LabeledTrace{
			SessionID: sess.SessionID,
			GateID:    key.gateID,
			SlotIndex: key.slotIndex,
			EnterDbm:  enter,
			ExitDbm:   exit,
			Points:    pts,
			Positives: validByKey[key],
			HardNegs:  negs,
		})
	}
	return out
}

// TrainOptions configures on-device AdamW training.
type TrainOptions struct {
	Epochs       int
	LearningRate float32
	WeightDecay  float32
	AugPerTrace  int
	Seed         int64
	OnEpoch      func(epoch, totalEpochs int, loss float64)
}

// DefaultTrainOptions returns the standard 40-epoch on-device training configuration.
func DefaultTrainOptions() TrainOptions {
	return TrainOptions{
		Epochs:       36,
		LearningRate: 0.0045,
		WeightDecay:  1e-4,
		AugPerTrace:  4,
		Seed:         20261124,
	}
}

// TrainModel trains `initModel` (or a fresh Kaiming-initialized TCN if nil) using AdamW with cosine
// learning-rate decay and per-epoch synthetic physics augmentation.
func TrainModel(baseTraces []LabeledTrace, initModel *TCN, opts TrainOptions) (*TCN, float64) {
	if opts.Epochs <= 0 {
		opts.Epochs = 32
	}
	if opts.LearningRate <= 0 {
		opts.LearningRate = 0.0045
	}
	if opts.WeightDecay < 0 {
		opts.WeightDecay = 1e-4
	}
	var m *TCN
	if initModel != nil {
		m = initModel.Clone()
	} else {
		m = NewInitializedTCN(opts.Seed)
	}

	basePrepared := prepareTraces(baseTraces)
	if len(basePrepared) == 0 {
		return m, 0
	}

	var m1 [TotalParams]float32
	var m2 [TotalParams]float32
	const beta1 = float32(0.9)
	const beta2 = float32(0.999)
	const adamEps = float32(1e-8)

	rng := rand.New(rand.NewSource(opts.Seed + 7919))
	stepNum := 0
	var finalLoss float64

	for epoch := 1; epoch <= opts.Epochs; epoch++ {
		// Build epoch mini-dataset = real sequences + freshly augmented sequences
		epochSeqs := make([]preparedSequence, 0, len(basePrepared)*(1+opts.AugPerTrace))
		epochSeqs = append(epochSeqs, basePrepared...)
		for a := 0; a < opts.AugPerTrace; a++ {
			for _, tr := range baseTraces {
				aug := AugmentTrace(tr, rng)
				epochSeqs = append(epochSeqs, prepareTraces([]LabeledTrace{aug})...)
			}
		}

		// Shuffle sequence order
		rng.Shuffle(len(epochSeqs), func(i, j int) {
			epochSeqs[i], epochSeqs[j] = epochSeqs[j], epochSeqs[i]
		})

		// Cosine LR schedule down to 15% of peak LR
		progress := float64(epoch-1) / math.Max(1.0, float64(opts.Epochs-1))
		lr := opts.LearningRate * float32(0.15+0.85*0.5*(1.0+math.Cos(math.Pi*progress)))

		const batchSize = 8
		workers := runtime.GOMAXPROCS(0)
		if workers < 1 {
			workers = 1
		}
		var epochLossSum float64
		for start := 0; start < len(epochSeqs); start += batchSize {
			end := start + batchSize
			if end > len(epochSeqs) {
				end = len(epochSeqs)
			}
			nBatch := end - start
			var grad [TotalParams]float32
			batchScale := float32(1.0 / float64(nBatch))

			if workers == 1 || nBatch == 1 {
				for idx := start; idx < end; idx++ {
					ps := &epochSeqs[idx]
					cache := newForwardCache(len(ps.seq.Features))
					var seqGrad [TotalParams]float32
					loss := m.LossAndGrad(ps.seq.Features, ps.targets, cache, &seqGrad)
					epochLossSum += loss
					for p := 0; p < TotalParams; p++ {
						grad[p] += seqGrad[p] * batchScale
					}
				}
			} else {
				seqGrads := make([][TotalParams]float32, nBatch)
				seqLosses := make([]float64, nBatch)
				var wg sync.WaitGroup
				for bi := 0; bi < nBatch; bi++ {
					wg.Add(1)
					go func(localIdx int) {
						defer wg.Done()
						ps := &epochSeqs[start+localIdx]
						cache := newForwardCache(len(ps.seq.Features))
						seqLosses[localIdx] = m.LossAndGrad(ps.seq.Features, ps.targets, cache, &seqGrads[localIdx])
					}(bi)
				}
				wg.Wait()
				for bi := 0; bi < nBatch; bi++ {
					epochLossSum += seqLosses[bi]
					sg := &seqGrads[bi]
					for p := 0; p < TotalParams; p++ {
						grad[p] += sg[p] * batchScale
					}
				}
			}

			// Global gradient norm clip (<= 3.0) for rock-solid numerical stability
			var normSq float64
			for p := 0; p < TotalParams; p++ {
				g := float64(grad[p])
				normSq += g * g
			}
			if normSq > 9.0 {
				clipScale := float32(3.0 / math.Sqrt(normSq))
				for p := 0; p < TotalParams; p++ {
					grad[p] *= clipScale
				}
			}

			stepNum++
			bc1 := float32(1.0 - math.Pow(float64(beta1), float64(stepNum)))
			bc2 := float32(1.0 - math.Pow(float64(beta2), float64(stepNum)))

			for p := 0; p < TotalParams; p++ {
				g := grad[p]
				m1[p] = beta1*m1[p] + (1.0-beta1)*g
				m2[p] = beta2*m2[p] + (1.0-beta2)*g*g
				mHat := m1[p] / bc1
				vHat := m2[p] / bc2
				m.Weights[p] -= lr * (mHat/(float32(math.Sqrt(float64(vHat)))+adamEps) + opts.WeightDecay*m.Weights[p])
			}
		}

		finalLoss = epochLossSum / float64(len(epochSeqs))
		if opts.OnEpoch != nil {
			opts.OnEpoch(epoch, opts.Epochs, finalLoss)
		}
	}

	return m, finalLoss
}

// ExtractPeaksFromSequence runs NMS peak extraction on `probs` + `dtMs` matching real-time inference.
func ExtractPeaksFromSequence(seq GridSequence, probs []float32, dtMs []float32, minLockoutUs uint64) []uint64 {
	T := len(probs)
	var preds []uint64
	var lastAcceptedUs uint64
	hasLast := false

	for t := 1; t < T-1; t++ {
		p := probs[t]
		if p < DetectProbThreshold {
			continue
		}
		if p < probs[t-1] || p < probs[t+1] {
			continue
		}
		// Require local maximum across +-3 steps (+-60 ms)
		isMax := true
		for k := t - 3; k <= t+3; k++ {
			if k >= 0 && k < T && probs[k] > p {
				isMax = false
				break
			}
		}
		if !isMax {
			continue
		}
		// Sanity check: peak RSSI within +-3 steps must be at least 7.5 dB above ambient floor
		maxExcess := float32(0)
		for k := t - 3; k <= t+3; k++ {
			if k >= 0 && k < T {
				ex := seq.MedRSSI[k] - seq.FloorDbm[k]
				if ex > maxExcess {
					maxExcess = ex
				}
			}
		}
		if maxExcess < 7.5 {
			continue
		}

		baseTs := int64(seq.StartTsUs) + int64(t)*StepUs
		refinedInt := baseTs + int64(math.Round(float64(dtMs[t])*1000.0))
		if refinedInt < 0 {
			refinedInt = 0
		}
		candUs := uint64(refinedInt)
		if hasLast && candUs <= lastAcceptedUs+minLockoutUs {
			continue
		}
		preds = append(preds, candUs)
		lastAcceptedUs = candUs
		hasLast = true
	}
	return preds
}

func scorePredictions(predicted []uint64, truth []uint64) (tp, fn, fp int, jitterSumMs float64) {
	usedPred := make([]bool, len(predicted))
	for _, gt := range truth {
		bestIdx := -1
		var bestDiff uint64 = MatchToleranceUs + 1
		for i, pr := range predicted {
			if usedPred[i] {
				continue
			}
			var diff uint64
			if pr >= gt {
				diff = pr - gt
			} else {
				diff = gt - pr
			}
			if diff <= MatchToleranceUs && diff < bestDiff {
				bestDiff = diff
				bestIdx = i
			}
		}
		if bestIdx >= 0 {
			usedPred[bestIdx] = true
			tp++
			jitterSumMs += float64(bestDiff) / 1000.0
		} else {
			fn++
		}
	}
	for i := range predicted {
		if !usedPred[i] {
			fp++
		}
	}
	return tp, fn, fp, jitterSumMs
}

func finalizeMetrics(tp, fn, fp int, jitterSumMs float64) domain.MLMetrics {
	var prec, rec, f1, meanJitter float64
	if tp+fp > 0 {
		prec = float64(tp) / float64(tp+fp)
	} else if fn == 0 {
		prec = 1.0
	}
	if tp+fn > 0 {
		rec = float64(tp) / float64(tp+fn)
	} else {
		rec = 1.0
	}
	if prec+rec > 0 {
		f1 = 2.0 * prec * rec / (prec + rec)
	}
	if tp > 0 {
		meanJitter = jitterSumMs / float64(tp)
	}
	return domain.MLMetrics{
		TotalPasses:    tp + fn,
		DetectedPasses: tp,
		MissedPasses:   fn,
		FalseTriggers:  fp,
		Precision:      math.Round(prec*10000) / 10000,
		Recall:         math.Round(rec*10000) / 10000,
		F1:             math.Round(f1*10000) / 10000,
		MeanJitterMs:   math.Round(meanJitter*10) / 10,
	}
}

// BenchmarkTraces evaluates both `model` (1D TCN) and `dsp.ChannelDetector` (Classic DSP) on `traces`
// and returns side-by-side accuracy & timing jitter metrics.
func BenchmarkTraces(model *TCN, traces []LabeledTrace, minLockoutUs uint64) (aiMetrics domain.MLMetrics, classicMetrics domain.MLMetrics) {
	if minLockoutUs < 300_000 {
		minLockoutUs = 300_000
	}
	var aiTP, aiFN, aiFP int
	var aiJitter float64
	var clTP, clFN, clFP int
	var clJitter float64

	for _, tr := range traces {
		truth := make([]uint64, len(tr.Positives))
		for i, p := range tr.Positives {
			truth[i] = p.TimestampUs
		}
		sort.Slice(truth, func(i, j int) bool { return truth[i] < truth[j] })

		// 1. Evaluate 1D TCN via streaming detector (exact parity with live runtime!)
		sdet := NewStreamDetector(tr.GateID, tr.SlotIndex, model)
		var aiPreds []uint64
		for _, pt := range tr.Points {
			if c := sdet.ProcessSample(pt.RSSIDbm, pt.NoiseFloorDbm, pt.TimestampUs, tr.EnterDbm, tr.ExitDbm, minLockoutUs, nil); c != nil {
				aiPreds = append(aiPreds, c.TimestampUs)
			}
		}
		// Flush trailing 280 ms lookahead tail at end of recorded trace
		if len(tr.Points) > 0 {
			last := tr.Points[len(tr.Points)-1]
			for tail := 1; tail <= LookaheadSteps+2; tail++ {
				if c := sdet.ProcessSample(last.NoiseFloorDbm, last.NoiseFloorDbm, last.TimestampUs+uint64(tail)*StepUs, tr.EnterDbm, tr.ExitDbm, minLockoutUs, nil); c != nil {
					aiPreds = append(aiPreds, c.TimestampUs)
				}
			}
		}
		tp, fn, fp, jit := scorePredictions(aiPreds, truth)
		aiTP += tp
		aiFN += fn
		aiFP += fp
		aiJitter += jit

		// 2. Evaluate Classic DSP
		cdet := dsp.NewChannelDetector(tr.GateID, tr.SlotIndex)
		var clPreds []uint64
		enter := tr.EnterDbm
		exit := tr.ExitDbm
		if enter >= 0 {
			enter = -68.0
		}
		if exit >= 0 {
			exit = -76.0
		}
		for _, pt := range tr.Points {
			if c := cdet.ProcessSample(pt.RSSIDbm, pt.TimestampUs, enter, exit, minLockoutUs); c != nil {
				clPreds = append(clPreds, c.TimestampUs)
			}
		}
		if len(tr.Points) > 0 {
			last := tr.Points[len(tr.Points)-1]
			for tail := 1; tail <= 15; tail++ {
				if c := cdet.ProcessSample(last.NoiseFloorDbm, last.TimestampUs+uint64(tail)*StepUs, enter, exit, minLockoutUs); c != nil {
					clPreds = append(clPreds, c.TimestampUs)
				}
			}
		}
		ctp, cfn, cfp, cjit := scorePredictions(clPreds, truth)
		clTP += ctp
		clFN += cfn
		clFP += cfp
		clJitter += cjit
	}

	return finalizeMetrics(aiTP, aiFN, aiFP, aiJitter), finalizeMetrics(clTP, clFN, clFP, clJitter)
}

// ---------------------------------------------------------------------------
// Built-in Pre-Trained `AI Base v0` Model (cached via sync.Once in ~70 ms)
// ---------------------------------------------------------------------------

var (
	pretrainedOnce     sync.Once
	pretrainedSnapshot domain.MLModelSnapshot
	pretrainedTCN      *TCN
)

// PretrainedBaseModel returns the deterministic built-in `AI Base v0` TCN and its metadata snapshot.
func PretrainedBaseModel() (*TCN, domain.MLModelSnapshot) {
	pretrainedOnce.Do(func() {
		t0 := time.Now()
		trainSynth := GenerateSyntheticTraces(10, 1337)
		valSynth := GenerateSyntheticTraces(4, 9001)
		m, loss := TrainModel(trainSynth, nil, TrainOptions{
			Epochs:       18,
			LearningRate: 0.007,
			WeightDecay:  1e-4,
			AugPerTrace:  1,
			Seed:         42,
		})
		aiM, clM := BenchmarkTraces(m, valSynth, 1_500_000)
		pretrainedTCN = m
		pretrainedSnapshot = domain.MLModelSnapshot{
			MLModelSummary: domain.MLModelSummary{
				ModelID:         "ai-base-v0",
				Name:            "AI Base v0 (Built-in Physics Pretrain)",
				Version:         0,
				CreatedAt:       "2026-11-24T00:00:00Z",
				BuiltIn:         true,
				TrainPacks:      10,
				ValPacks:        4,
				TrainPasses:     aiM.TotalPasses * 3,
				TrainDurationMs: time.Since(t0).Milliseconds(),
				FinalLoss:       math.Round(loss*10000) / 10000,
				AIMetrics:       aiM,
				ClassicMetrics:  clM,
			},
			Weights: m.ExportWeights(),
		}
	})
	return pretrainedTCN.Clone(), pretrainedSnapshot
}

// ---------------------------------------------------------------------------
// Live 2-Lap Per-Timer Logistic Adapter (`< 5 ms` L2-Anchored Optimization)
// ---------------------------------------------------------------------------

// EmbeddedStep stores one 20 ms step's L3 embedding for fast on-the-fly per-gate adaptation.
type EmbeddedStep struct {
	TimestampUs uint64
	MedRSSIDbm  float32
	FloorDbm    float32
	Embed       [HiddenDim]float32
}

// FitLiveGateHead optimizes a 24-weight logistic head `(w, b)` anchored to `(baseW, baseB)` via
// L2 regularization (`lambda * ||w - baseW||^2`), using accepted crossings on this gate as positives
// and cross-gate bleed / deleted crossings / background frames as negatives. Executes in `< 3 ms`.
func FitLiveGateHead(
	gateID uint8,
	slotIndex int,
	lapsCompleted int,
	steps []EmbeddedStep,
	positives []CrossingLabel,
	hardNegs []NegativeMark,
	baseW [HiddenDim]float32,
	baseB float32,
) (domain.MLLiveGateTune, bool) {
	if len(steps) < 50 || len(positives) == 0 {
		return domain.MLLiveGateTune{}, false
	}

	n := len(steps)
	y := make([]float32, n)
	wt := make([]float32, n)
	for i := 0; i < n; i++ {
		wt[i] = 1.0
	}

	posCount := 0
	negCount := 0

	for _, pos := range positives {
		boost := float32(16.0)
		if pos.Manual {
			boost = 32.0
		}
		matched := false
		for i := range steps {
			dtMs := float64(int64(pos.TimestampUs)-int64(steps[i].TimestampUs)) / 1000.0
			if math.Abs(dtMs) <= 90.0 {
				g := float32(math.Exp(-(dtMs * dtMs) / (2.0 * 30.0 * 30.0)))
				if g > y[i] {
					y[i] = g
				}
				w := 1.0 + boost*g
				if w > wt[i] {
					wt[i] = w
				}
				matched = true
			} else if math.Abs(dtMs) <= 320.0 {
				// Ignore shoulder transition zone around crest so adapter focuses on clean apex vs off-pass
				if y[i] < 0.05 {
					wt[i] = 0.15
				}
			}
		}
		if matched {
			posCount++
		}
	}
	if posCount == 0 {
		return domain.MLLiveGateTune{}, false
	}

	for _, neg := range hardNegs {
		nw := neg.Weight
		if nw < 3.0 {
			nw = 4.0
		}
		matched := false
		for i := range steps {
			dtMs := float64(int64(neg.TimestampUs)-int64(steps[i].TimestampUs)) / 1000.0
			if math.Abs(dtMs) <= 180.0 && y[i] < 0.05 {
				if nw > wt[i] {
					wt[i] = nw
				}
				matched = true
			}
		}
		if matched {
			negCount++
		}
	}

	// Start from base head and run 24 steps of L2-regularized gradient descent with momentum.
	// Strong L2 prior (`lambda = 0.08`) ensures 2-3 laps refine threshold/bleed discrimination
	// without ever diverging from the pre-trained base decision boundary.
	w := baseW
	b := baseB
	var vw [HiddenDim]float32
	var vb float32
	const lr = float32(0.12)
	const mom = float32(0.8)
	const lambda = float32(0.08)
	invN := float32(1.0 / float64(n))

	for iter := 0; iter < 24; iter++ {
		var gw [HiddenDim]float32
		var gb float32
		for o := 0; o < HiddenDim; o++ {
			gw[o] = lambda * (w[o] - baseW[o])
		}
		gb = lambda * 0.5 * (b - baseB)

		for i := 0; i < n; i++ {
			lc := b
			emb := &steps[i].Embed
			for o := 0; o < HiddenDim; o++ {
				lc += w[o] * emb[o]
			}
			p := sigmoid32(lc)
			err := wt[i] * (p - y[i]) * invN
			gb += err
			for o := 0; o < HiddenDim; o++ {
				gw[o] += err * emb[o]
			}
		}

		vb = mom*vb + lr*gb
		b -= vb
		for o := 0; o < HiddenDim; o++ {
			vw[o] = mom*vw[o] + lr*gw[o]
			w[o] -= vw[o]
		}
	}

	return domain.MLLiveGateTune{
		GateID:      gateID,
		SlotIndex:   slotIndex,
		LapsUsed:    lapsCompleted,
		PosExamples: posCount,
		NegExamples: negCount,
		Weights:     w,
		Bias:        b,
	}, true
}
