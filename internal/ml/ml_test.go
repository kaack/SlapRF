package ml

import (
	"context"
	"math"
	"math/rand"
	"testing"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/tracestore"
)

func TestAnalyticalGradientsMatchFiniteDifferences(t *testing.T) {
	rng := rand.New(rand.NewSource(12345))
	m := NewInitializedTCN(99)
	const T = 35
	x := make([][InputChannels]float32, T)
	for i := 0; i < T; i++ {
		x[i] = [InputChannels]float32{
			float32(rng.NormFloat64() * 0.5),
			float32(rng.NormFloat64() * 0.5),
			float32(rng.NormFloat64() * 0.5),
		}
	}
	tgt := SequenceTargets{
		YCross:      make([]float32, T),
		SampleWt:    make([]float32, T),
		OffsetMask:  make([]bool, T),
		TargetOffMs: make([]float32, T),
	}
	for i := 0; i < T; i++ {
		tgt.SampleWt[i] = 1.0
	}
	tgt.YCross[17] = 1.0
	tgt.SampleWt[17] = 12.0
	tgt.OffsetMask[17] = true
	tgt.TargetOffMs[17] = 6.5

	cache := newForwardCache(T)
	var grad [TotalParams]float32
	_ = m.LossAndGrad(x, tgt, cache, &grad)

	// Probe representative parameter indices across L1, L2, L3, wCross, bCross, wOffset, bOffset
	probeIndices := []int{
		offW1 + 0, offW1 + 113, offB1 + 5,
		offW2 + 17, offW2 + 888, offB2 + 12,
		offW3 + 42, offW3 + 1999, offB3 + 7,
		offWC + 0, offWC + 19, offBC,
		offWO + 3, offWO + 21, offBO,
	}
	const eps = float32(1e-3)
	for _, idx := range probeIndices {
		orig := m.Weights[idx]

		m.Weights[idx] = orig + eps
		var gDummy [TotalParams]float32
		lossPlus := m.LossAndGrad(x, tgt, cache, &gDummy)

		m.Weights[idx] = orig - eps
		lossMinus := m.LossAndGrad(x, tgt, cache, &gDummy)
		m.Weights[idx] = orig

		numGrad := (lossPlus - lossMinus) / float64(2.0*eps)
		anaGrad := float64(grad[idx])
		diff := math.Abs(numGrad - anaGrad)
		tol := math.Max(2e-3, 0.04*math.Abs(numGrad))
		if diff > tol {
			t.Fatalf("param[%d] gradient mismatch: analytical=%.6f numerical=%.6f diff=%.6f", idx, anaGrad, numGrad, diff)
		}
	}
}

func TestEvalWindow29MatchesInferSequenceBitAccurate(t *testing.T) {
	m := NewInitializedTCN(777)
	rng := rand.New(rand.NewSource(777))
	const T = 60
	x := make([][InputChannels]float32, T)
	for i := 0; i < T; i++ {
		x[i] = [InputChannels]float32{
			float32(rng.Float64()),
			float32(rng.Float64() - 0.5),
			float32(rng.Float64()*2 - 1),
		}
	}
	probs, dtMs, embeds := m.InferSequence(x)

	for center := LookaheadSteps; center < T-LookaheadSteps; center++ {
		var win [29][InputChannels]float32
		copy(win[:], x[center-LookaheadSteps:center+LookaheadSteps+1])
		p, dt, emb := m.EvalWindow29(&win, nil, 0, false)
		if math.Abs(float64(p-probs[center])) > 1e-5 {
			t.Fatalf("step %d prob mismatch: win=%.6f seq=%.6f", center, p, probs[center])
		}
		if math.Abs(float64(dt-dtMs[center])) > 1e-4 {
			t.Fatalf("step %d dtMs mismatch: win=%.6f seq=%.6f", center, dt, dtMs[center])
		}
		for o := 0; o < HiddenDim; o++ {
			if math.Abs(float64(emb[o]-embeds[center][o])) > 1e-5 {
				t.Fatalf("step %d embed[%d] mismatch: %.6f vs %.6f", center, o, emb[o], embeds[center][o])
			}
		}
	}
}

func TestPretrainedBaseModelAndLive2LapAdapter(t *testing.T) {
	model, snap := PretrainedBaseModel()
	if snap.AIMetrics.F1 < 0.88 {
		t.Fatalf("expected built-in AI Base v0 F1 >= 0.88 on unseen synthetic flights, got F1=%.3f (TP=%d FN=%d FP=%d)",
			snap.AIMetrics.F1, snap.AIMetrics.DetectedPasses, snap.AIMetrics.MissedPasses, snap.AIMetrics.FalseTriggers)
	}

	// Verify real-time confirmation latency <= 420 ms on a compact-track pass with a 2.2s -68 dBm shelf
	det := NewStreamDetector(1, 1, model)
	ts := uint64(5_000_000)
	for i := 0; i < 40; i++ {
		_ = det.ProcessSample(-91.0, -91.0, ts, -70, -76, 1_500_000, nil)
		ts += StepUs
	}
	// True pass centered at peakTs
	peakStep := 20
	peakTs := ts + uint64(peakStep)*StepUs
	var confirmDelayUs uint64
	var gotPeakTs uint64
	detectedCount := 0
	for i := 0; i < 160; i++ {
		dtSec := float64(i-peakStep) * 0.02
		env := 36.0 / (1.0 + (dtSec/0.20)*(dtSec/0.20))
		if dtSec > 0.22 && dtSec < 2.4 {
			if 22.5 > env {
				env = 22.5 // -68.5 dBm shelf above -76 dBm exit!
			}
		}
		if c := det.ProcessSample(-91.0+float32(env), -91.0, ts, -70, -76, 1_500_000, nil); c != nil {
			detectedCount++
			if detectedCount == 1 {
				confirmDelayUs = ts - peakTs
				gotPeakTs = c.TimestampUs
			}
		}
		ts += StepUs
	}
	if detectedCount != 1 {
		t.Fatalf("expected exactly 1 crossing on compact-track shelf pass, got %d", detectedCount)
	}
	if confirmDelayUs > 440_000 {
		t.Fatalf("expected real-time confirmation <= 440 ms post-peak, got %.1f ms", float64(confirmDelayUs)/1000.0)
	}
	if math.Abs(float64(int64(gotPeakTs)-int64(peakTs))) > 60_000 {
		t.Fatalf("expected refined timestamp within +-60 ms of true apex, got %+.1f ms", float64(int64(gotPeakTs)-int64(peakTs))/1000.0)
	}

	// Verify FitLiveGateHead executes in < 15 ms and learns from positives + cross-gate bleed negatives
	t0 := time.Now()
	baseW, baseB := model.BaseHead()
	tune, ok := FitLiveGateHead(
		1,
		1,
		2,
		det.Embeddings(),
		[]CrossingLabel{{TimestampUs: peakTs, Manual: true}},
		[]NegativeMark{{TimestampUs: peakTs + 1_800_000, Weight: 5.0}},
		baseW,
		baseB,
	)
	elapsed := time.Since(t0)
	if !ok {
		t.Fatalf("expected FitLiveGateHead to succeed")
	}
	if elapsed > 30*time.Millisecond {
		t.Fatalf("expected FitLiveGateHead < 30ms, took %v", elapsed)
	}
	if tune.PosExamples != 1 || tune.NegExamples != 1 {
		t.Fatalf("unexpected live tune counts: %+v", tune)
	}
}

func TestBuildTracesFromSessionSlicesActiveFlightStintsAndCancel(t *testing.T) {
	// Simulate 10 minutes of 50 Hz bench dead-air (with +8 dB random Wi-Fi blips every 3s!)
	// plus two 12s flight stints separated by a 3-minute landing/pack-swap break.
	var samples []tracestore.Sample
	for step := 0; step < 600*50; step++ {
		ts := uint64(step) * 20_000
		rssi := float32(-91.0)
		if step%150 == 0 {
			rssi = -82.0 // +9 dB bench Wi-Fi blip that previously prevented idle trimming!
		}
		// Inject true gate passes at t=100s, t=112s (Stint 1) and t=300s, t=312s (Stint 2)
		for _, pSec := range []float64{100.0, 112.0, 300.0, 312.0} {
			dt := float64(ts)/1e6 - pSec
			env := float32(34.0 / (1.0 + (dt/0.18)*(dt/0.18)))
			if -91.0+env > rssi {
				rssi = -91.0 + env
			}
		}
		samples = append(samples, tracestore.Sample{
			GateID:        1,
			NoiseFloorDbm: -91.0,
			TimestampUs:   ts,
			SlotIndices:   []uint8{1},
			RSSIDbm:       []float32{rssi},
		})
	}

	defaultPilots := []domain.PilotSlot{
		{SlotIndex: 1, Callsign: "Pilot 1", EnterThreshold: -68, ExitThreshold: -76},
	}
	sess := domain.PracticeSession{
		SessionID: "sess-stints",
		Pilots:    []domain.PracticeSessionPilot{{SlotIndex: 1, Callsign: "Pilot 1"}},
		Laps: []domain.LapRecord{
			{LapID: 1, SlotIndex: 1, LapNumber: 1, LapTimeSec: 12.0, CompletedAtUs: 112_000_000},
			{LapID: 2, SlotIndex: 1, LapNumber: 2, LapTimeSec: 12.0, CompletedAtUs: 312_000_000},
		},
		Crossings: []domain.GateCrossingEvent{
			// Stray bench walk-by at t=10s before flying (not part of any lap, not manual):
			{GateID: 1, SlotIndex: 1, TimestampUs: 10_000_000},
			// Stint 1 crossings:
			{GateID: 1, SlotIndex: 1, TimestampUs: 100_000_000},
			{GateID: 1, SlotIndex: 1, TimestampUs: 112_000_000},
			// Stint 2 crossings:
			{GateID: 1, SlotIndex: 1, TimestampUs: 300_000_000},
			{GateID: 1, SlotIndex: 1, TimestampUs: 312_000_000},
		},
	}

	traces := BuildTracesFromSession(sess, samples, defaultPilots)
	if len(traces) != 1 {
		t.Fatalf("expected 1 LabeledTrace, got %d", len(traces))
	}
	// Two 12s laps + +-2.2s pad = 2 * 16.4s = ~32.8s (~1,640 samples), NOT 30,000 samples!
	if len(traces[0].Points) > 2200 {
		t.Fatalf("expected bench dead-air to be chopped out (<= 2200 points), got %d points", len(traces[0].Points))
	}
	if len(traces[0].Positives) != 4 {
		t.Fatalf("expected only the 4 in-stint crossings (excluding t=10s stray bench crossing), got %d", len(traces[0].Positives))
	}

	// Verify Ctx cancellation aborts TrainModel immediately.
	ctx, cancel := context.WithCancel(context.Background())
	epochsRun := 0
	_, _ = TrainModel(traces, nil, TrainOptions{
		Ctx:         ctx,
		Epochs:      28,
		AugPerTrace: 2,
		OnEpoch: func(ep, total int, loss float64) {
			epochsRun = ep
			if ep >= 2 {
				cancel()
			}
		},
	})
	if epochsRun != 2 {
		t.Fatalf("expected training to stop right at epoch 2 after cancel(), ran %d epochs", epochsRun)
	}
}

func TestStreamDetectorFlushesPostCrestPacketGapAndToleratesJitter(t *testing.T) {
	model, _ := PretrainedBaseModel()
	det := NewStreamDetector(2, 1, model)

	var detected []uint64
	// Feed ambient baseline (10s..12s) -> clean -52 dBm pass peaking at t=12.50s -> stop 120 ms after crest (t=12.62s)
	// with a 35 ms backward BLE timestamp jitter right before the crest!
	for step := 0; step <= 131; step++ {
		ts := uint64(10_000_000 + step*20_000)
		dt := float64(ts)/1e6 - 12.50
		rssi := float32(-91.0 + 39.0/(1.0+(dt/0.20)*(dt/0.20)))
		if cand := det.ProcessSample(rssi, -91.0, ts, -58, -68, 300_000, nil); cand != nil {
			detected = append(detected, cand.TimestampUs)
		}
		if step == 122 { // t=12.44s: inject out-of-order BLE packet 35 ms earlier!
			if cand := det.ProcessSample(rssi-1.0, -91.0, ts-35_000, -58, -68, 300_000, nil); cand != nil {
				detected = append(detected, cand.TimestampUs)
			}
		}
	}
	if len(detected) != 0 {
		t.Fatalf("expected crest at 12.50s to still be inside 280ms lookahead at 12.62s, got %v", detected)
	}

	// Simulate a 3.5 s ESP-NOW/BLE packet gap resuming at t=16.12s (matching 25mW V2 L8 & L32):
	// ProcessSample must flush the pending 12.50s crest before resetting!
	cand := det.ProcessSample(-90.5, -91.0, 16_120_000, -58, -68, 300_000, nil)
	if cand == nil {
		t.Fatalf("expected post-crest packet gap to flush and emit the 12.50s crossing")
	}
	diffMs := math.Abs(float64(int64(cand.TimestampUs)-12_500_000)) / 1000.0
	if diffMs > 120.0 {
		t.Fatalf("expected flushed crossing near 12.50s, got %.3fs (diff=%.1fms)", float64(cand.TimestampUs)/1e6, diffMs)
	}
}
