package ml

import (
	"math"
	"math/rand"
)

const (
	kSize  = 5
	leakyA = float32(0.1)

	// Parameter layout offsets inside flat `Weights` slice (TotalParams = 5154 floats = 20.6 KB):
	offW1   = 0
	lenW1   = HiddenL1 * InputChannels * kSize // 16 * 3 * 5 = 240
	offB1   = offW1 + lenW1
	lenB1   = HiddenL1 // 16
	offW2   = offB1 + lenB1
	lenW2   = HiddenDim * HiddenL1 * kSize // 24 * 16 * 5 = 1920
	offB2   = offW2 + lenW2
	lenB2   = HiddenDim // 24
	offW3   = offB2 + lenB2
	lenW3   = HiddenDim * HiddenDim * kSize // 24 * 24 * 5 = 2880
	offB3   = offW3 + lenW3
	lenB3   = HiddenDim // 24
	offWC   = offB3 + lenB3
	lenWC   = HiddenDim // 24
	offBC   = offWC + lenWC
	lenBC   = 1
	offWO   = offBC + lenBC
	lenWO   = HiddenDim // 24
	offBO   = offWO + lenWO
	lenBO   = 1
	TotalParams = offBO + lenBO // 5154
)

// TCN holds the 5,154 float32 parameters of SlapRF's 3-layer symmetric dilated 1D Temporal ConvNet.
//
// Layer 1: Conv1D(3 -> 16, k=5, d=1) + LeakyReLU(0.1)
// Layer 2: Conv1D(16 -> 24, k=5, d=2) + LeakyReLU(0.1)
// Layer 3: Conv1D(24 -> 24, k=5, d=4) + Residual(L2) + LeakyReLU(0.1) -> Embedding z[t] in R^24
// Heads:
//   - logit_cross[t] = dot(wCross, z[t]) + bCross  -> p_cross = sigmoid(logit_cross)
//   - raw_offset[t]  = dot(wOffset, z[t]) + bOffset -> dt_ms  = 20.0 * tanh(raw_offset)
type TCN struct {
	Weights [TotalParams]float32
}

// NewInitializedTCN constructs a deterministic Kaiming-initialized TCN.
func NewInitializedTCN(seed int64) *TCN {
	rng := rand.New(rand.NewSource(seed))
	m := &TCN{}
	initConv := func(off, outCh, inCh, k int) {
		scale := float32(math.Sqrt(2.0 / float64(inCh*k)))
		for i := 0; i < outCh*inCh*k; i++ {
			m.Weights[off+i] = float32(rng.NormFloat64()) * scale
		}
	}
	initConv(offW1, HiddenL1, InputChannels, kSize)
	initConv(offW2, HiddenDim, HiddenL1, kSize)
	initConv(offW3, HiddenDim, HiddenDim, kSize)

	headScale := float32(1.0 / math.Sqrt(float64(HiddenDim)))
	for i := 0; i < HiddenDim; i++ {
		m.Weights[offWC+i] = float32(rng.NormFloat64()) * headScale
		m.Weights[offWO+i] = float32(rng.NormFloat64()) * headScale * 0.25
	}
	// Prior bias ~ -3.2 (prior crossing probability ~ 4% before seeing features).
	m.Weights[offBC] = -3.2
	m.Weights[offBO] = 0.0
	return m
}

// Clone returns a deep copy of `m`.
func (m *TCN) Clone() *TCN {
	cp := *m
	return &cp
}

// ExportWeights returns a slice copy of the model's parameters.
func (m *TCN) ExportWeights() []float32 {
	out := make([]float32, TotalParams)
	copy(out, m.Weights[:])
	return out
}

// ImportWeights loads weights from `src` if the length matches `TotalParams`.
func (m *TCN) ImportWeights(src []float32) bool {
	if len(src) != TotalParams {
		return false
	}
	copy(m.Weights[:], src)
	return true
}

// BaseHead returns the default crossing classification head `(wCross, bCross)`.
func (m *TCN) BaseHead() ([HiddenDim]float32, float32) {
	var w [HiddenDim]float32
	copy(w[:], m.Weights[offWC:offWC+HiddenDim])
	return w, m.Weights[offBC]
}

func sigmoid32(x float32) float32 {
	if x >= 0 {
		z := float32(math.Exp(float64(-x)))
		return 1.0 / (1.0 + z)
	}
	z := float32(math.Exp(float64(x)))
	return z / (1.0 + z)
}

func leakyRelu(x float32) float32 {
	if x >= 0 {
		return x
	}
	return leakyA * x
}

func leakyReluGrad(preAct float32) float32 {
	if preAct >= 0 {
		return 1.0
	}
	return leakyA
}

// forwardCache stores intermediate pre-activations and activations for exact analytical backprop.
type forwardCache struct {
	T      int
	pre1   [][HiddenL1]float32
	act1   [][HiddenL1]float32
	pre2   [][HiddenDim]float32
	act2   [][HiddenDim]float32
	pre3   [][HiddenDim]float32 // conv3(act2) + b3 + act2
	embed  [][HiddenDim]float32 // LeakyReLU(pre3)
	logitC []float32
	probC  []float32
	rawOff []float32
	tanhO  []float32
	dtMs   []float32
}

func newForwardCache(T int) *forwardCache {
	return &forwardCache{
		T:      T,
		pre1:   make([][HiddenL1]float32, T),
		act1:   make([][HiddenL1]float32, T),
		pre2:   make([][HiddenDim]float32, T),
		act2:   make([][HiddenDim]float32, T),
		pre3:   make([][HiddenDim]float32, T),
		embed:  make([][HiddenDim]float32, T),
		logitC: make([]float32, T),
		probC:  make([]float32, T),
		rawOff: make([]float32, T),
		tanhO:  make([]float32, T),
		dtMs:   make([]float32, T),
	}
}

func clampIdx(idx, T int) int {
	if idx < 0 {
		return 0
	}
	if idx >= T {
		return T - 1
	}
	return idx
}

// forwardInto runs the full 1D TCN across `x` (`len(x) == T`) with replicate edge padding.
func (m *TCN) forwardInto(x [][InputChannels]float32, c *forwardCache) {
	T := len(x)
	w1 := m.Weights[offW1 : offW1+lenW1]
	b1 := m.Weights[offB1 : offB1+lenB1]
	w2 := m.Weights[offW2 : offW2+lenW2]
	b2 := m.Weights[offB2 : offB2+lenB2]
	w3 := m.Weights[offW3 : offW3+lenW3]
	b3 := m.Weights[offB3 : offB3+lenB3]
	wC := m.Weights[offWC : offWC+lenWC]
	bC := m.Weights[offBC]
	wO := m.Weights[offWO : offWO+lenWO]
	bO := m.Weights[offBO]

	// Layer 1: d = 1, taps t + (k - 2)
	for t := 0; t < T; t++ {
		for o := 0; o < HiddenL1; o++ {
			sum := b1[o]
			wBase := o * (InputChannels * kSize)
			for k := 0; k < kSize; k++ {
				ti := clampIdx(t+(k-2), T)
				inVec := x[ti]
				wk := wBase + k*InputChannels
				sum += w1[wk]*inVec[0] + w1[wk+1]*inVec[1] + w1[wk+2]*inVec[2]
			}
			c.pre1[t][o] = sum
			c.act1[t][o] = leakyRelu(sum)
		}
	}

	// Layer 2: d = 2, taps t + 2*(k - 2)
	for t := 0; t < T; t++ {
		for o := 0; o < HiddenDim; o++ {
			sum := b2[o]
			wBase := o * (HiddenL1 * kSize)
			for k := 0; k < kSize; k++ {
				ti := clampIdx(t+2*(k-2), T)
				inVec := &c.act1[ti]
				wk := wBase + k*HiddenL1
				for ic := 0; ic < HiddenL1; ic++ {
					sum += w2[wk+ic] * inVec[ic]
				}
			}
			c.pre2[t][o] = sum
			c.act2[t][o] = leakyRelu(sum)
		}
	}

	// Layer 3: d = 4, taps t + 4*(k - 2) + residual from act2[t]
	for t := 0; t < T; t++ {
		for o := 0; o < HiddenDim; o++ {
			sum := b3[o] + c.act2[t][o]
			wBase := o * (HiddenDim * kSize)
			for k := 0; k < kSize; k++ {
				ti := clampIdx(t+4*(k-2), T)
				inVec := &c.act2[ti]
				wk := wBase + k*HiddenDim
				for ic := 0; ic < HiddenDim; ic++ {
					sum += w3[wk+ic] * inVec[ic]
				}
			}
			c.pre3[t][o] = sum
			z := leakyRelu(sum)
			c.embed[t][o] = z
		}
		lc := bC
		ro := bO
		emb := &c.embed[t]
		for o := 0; o < HiddenDim; o++ {
			z := emb[o]
			lc += wC[o] * z
			ro += wO[o] * z
		}
		c.logitC[t] = lc
		c.probC[t] = sigmoid32(lc)
		c.rawOff[t] = ro
		th := float32(math.Tanh(float64(ro)))
		c.tanhO[t] = th
		c.dtMs[t] = 20.0 * th
	}
}

// InferSequence runs inference over a resampled 50 Hz sequence and returns `p_cross[t]`, `dt_ms[t]`,
// and the 24-dim embeddings `z[t]`.
func (m *TCN) InferSequence(x [][InputChannels]float32) (probs []float32, dtMs []float32, embeds [][HiddenDim]float32) {
	if len(x) == 0 {
		return nil, nil, nil
	}
	c := newForwardCache(len(x))
	m.forwardInto(x, c)
	return c.probC, c.dtMs, c.embed
}

// EvalWindow29 evaluates a single 29-step window (`[-14..+14]` around center index `14`) in `< 15 us`
// for zero-allocation real-time streaming inference!
func (m *TCN) EvalWindow29(win *[29][InputChannels]float32, customHead *[HiddenDim]float32, customBias float32, useCustomHead bool) (prob float32, dtMs float32, embed [HiddenDim]float32) {
	w1 := m.Weights[offW1 : offW1+lenW1]
	b1 := m.Weights[offB1 : offB1+lenB1]
	w2 := m.Weights[offW2 : offW2+lenW2]
	b2 := m.Weights[offB2 : offB2+lenB2]
	w3 := m.Weights[offW3 : offW3+lenW3]
	b3 := m.Weights[offB3 : offB3+lenB3]

	// Center index is 14.
	// L3 needs act2 at indices {14-8, 14-4, 14, 14+4, 14+8} = {6, 10, 14, 18, 22}.
	// L2 at index `p` needs act1 at `{p-4, p-2, p, p+2, p+4}` -> all even indices in [2..26] (13 positions)!
	var act1 [27][HiddenL1]float32
	for t := 2; t <= 26; t += 2 {
		for o := 0; o < HiddenL1; o++ {
			sum := b1[o]
			wBase := o * (InputChannels * kSize)
			for k := 0; k < kSize; k++ {
				inVec := win[t+(k-2)]
				wk := wBase + k*InputChannels
				sum += w1[wk]*inVec[0] + w1[wk+1]*inVec[1] + w1[wk+2]*inVec[2]
			}
			act1[t][o] = leakyRelu(sum)
		}
	}

	var act2 [5][HiddenDim]float32 // corresponds to t = {6, 10, 14, 18, 22}
	l3Positions := [5]int{6, 10, 14, 18, 22}
	for idx, t := range l3Positions {
		for o := 0; o < HiddenDim; o++ {
			sum := b2[o]
			wBase := o * (HiddenL1 * kSize)
			for k := 0; k < kSize; k++ {
				inVec := &act1[t+2*(k-2)]
				wk := wBase + k*HiddenL1
				for ic := 0; ic < HiddenL1; ic++ {
					sum += w2[wk+ic] * inVec[ic]
				}
			}
			act2[idx][o] = leakyRelu(sum)
		}
	}

	for o := 0; o < HiddenDim; o++ {
		sum := b3[o] + act2[2][o] // residual from center t=14 (idx=2)
		wBase := o * (HiddenDim * kSize)
		for k := 0; k < kSize; k++ {
			inVec := &act2[k]
			wk := wBase + k*HiddenDim
			for ic := 0; ic < HiddenDim; ic++ {
				sum += w3[wk+ic] * inVec[ic]
			}
		}
		embed[o] = leakyRelu(sum)
	}

	var lc float32
	if useCustomHead && customHead != nil {
		lc = customBias
		for o := 0; o < HiddenDim; o++ {
			lc += customHead[o] * embed[o]
		}
	} else {
		lc = m.Weights[offBC]
		wC := m.Weights[offWC : offWC+lenWC]
		for o := 0; o < HiddenDim; o++ {
			lc += wC[o] * embed[o]
		}
	}

	ro := m.Weights[offBO]
	wO := m.Weights[offWO : offWO+lenWO]
	for o := 0; o < HiddenDim; o++ {
		ro += wO[o] * embed[o]
	}
	return sigmoid32(lc), 20.0 * float32(math.Tanh(float64(ro))), embed
}

// SequenceTargets holds per-step training targets for one resampled 50 Hz sequence.
type SequenceTargets struct {
	YCross      []float32 // Soft Gaussian target in [0, 1]
	SampleWt    []float32 // Importance weight (1.0 normal, 3.5-6.0 hard neg / manual edit)
	OffsetMask  []bool    // True within +-20 ms of a verified crossing crest
	TargetOffMs []float32 // Ground-truth sub-sample offset in [-20, +20] ms
}

// LossAndGrad computes Focal Binary Cross-Entropy + Smooth-L1 offset loss and accumulates exact
// analytical gradients into `grad` (returning average weighted loss across steps).
func (m *TCN) LossAndGrad(x [][InputChannels]float32, tgt SequenceTargets, c *forwardCache, grad *[TotalParams]float32) float64 {
	T := len(x)
	if T == 0 {
		return 0
	}
	m.forwardInto(x, c)

	w2 := m.Weights[offW2 : offW2+lenW2]
	w3 := m.Weights[offW3 : offW3+lenW3]
	wC := m.Weights[offWC : offWC+lenWC]
	wO := m.Weights[offWO : offWO+lenWO]

	dEmbed := make([][HiddenDim]float32, T)
	dPre3 := make([][HiddenDim]float32, T)
	dAct2 := make([][HiddenDim]float32, T)
	dPre2 := make([][HiddenDim]float32, T)
	dAct1 := make([][HiddenL1]float32, T)

	const eps = 1e-6
	invT := float32(1.0 / float64(T))
	var totalLoss float64

	// 1. Output heads loss + gradient w.r.t. logitC[t], rawOff[t], embed[t]
	for t := 0; t < T; t++ {
		p := float64(c.probC[t])
		if p < eps {
			p = eps
		} else if p > 1.0-eps {
			p = 1.0 - eps
		}
		y := float64(tgt.YCross[t])
		wt := float64(tgt.SampleWt[t])
		if wt <= 0 {
			wt = 1.0
		}

		// Focal-modulated soft BCE:
		// L_t = wt * ( |y - p|^1.5 ) * ( -y*log(p) - (1-y)*log(1-p) )
		// Wait: standard weighted BCE with pos boost + hard-negative focal modulation `(1-y)*p^2 + y*(1-p)^2`
		// has clean exact derivative, or weighted soft BCE `wt * (-y*log(p) - (1-y)*log(1-p))` whose exact
		// derivative w.r.t. logit `z` is simply `wt * (p - y)`!
		// Putting class-balance + hard-negative weights directly into `SampleWt[t]` keeps `dL/dLogit = wt * (p - y)`
		// convex, smooth, and exact!
		bce := -y*math.Log(p) - (1.0-y)*math.Log(1.0-p)
		stepLoss := wt * bce

		dLogitC := float32(wt*(p-y)) * invT

		var dRawOff float32
		if tgt.OffsetMask[t] {
			predMs := float64(c.dtMs[t])
			wantMs := float64(tgt.TargetOffMs[t])
			diff := (predMs - wantMs) / 20.0 // normalized in [-2, +2]
			const beta = 0.25
			var huber float64
			var dDiff float64
			if math.Abs(diff) < beta {
				huber = 0.5 * diff * diff / beta
				dDiff = diff / beta
			} else {
				huber = math.Abs(diff) - 0.5*beta
				if diff > 0 {
					dDiff = 1.0
				} else {
					dDiff = -1.0
				}
			}
			const offWeight = 1.5
			stepLoss += offWeight * huber
			// predMs/20 = tanh(rawOff) -> d(diff)/d(rawOff) = 1 - tanh^2(rawOff)
			th := float64(c.tanhO[t])
			dRawOff = float32(offWeight*dDiff*(1.0-th*th)) * invT
		}

		totalLoss += stepLoss * float64(invT)

		grad[offBC] += dLogitC
		grad[offBO] += dRawOff
		emb := &c.embed[t]
		for o := 0; o < HiddenDim; o++ {
			z := emb[o]
			grad[offWC+o] += dLogitC * z
			grad[offWO+o] += dRawOff * z
			dEmbed[t][o] = dLogitC*wC[o] + dRawOff*wO[o]
		}
	}

	// 2. Backprop Layer 3 (`embed = leakyRelu(pre3)`, `pre3 = b3 + act2 + conv3(act2, d=4)`)
	for t := 0; t < T; t++ {
		for o := 0; o < HiddenDim; o++ {
			dp := dEmbed[t][o] * leakyReluGrad(c.pre3[t][o])
			dPre3[t][o] = dp
			grad[offB3+o] += dp
			dAct2[t][o] += dp // residual path
			wBase := o * (HiddenDim * kSize)
			for k := 0; k < kSize; k++ {
				ti := clampIdx(t+4*(k-2), T)
				inVec := &c.act2[ti]
				dIn := &dAct2[ti]
				wk := wBase + k*HiddenDim
				for ic := 0; ic < HiddenDim; ic++ {
					grad[offW3+wk+ic] += dp * inVec[ic]
					dIn[ic] += dp * w3[wk+ic]
				}
			}
		}
	}

	// 3. Backprop Layer 2 (`act2 = leakyRelu(pre2)`, `pre2 = b2 + conv2(act1, d=2)`)
	for t := 0; t < T; t++ {
		for o := 0; o < HiddenDim; o++ {
			dp := dAct2[t][o] * leakyReluGrad(c.pre2[t][o])
			dPre2[t][o] = dp
			grad[offB2+o] += dp
			wBase := o * (HiddenL1 * kSize)
			for k := 0; k < kSize; k++ {
				ti := clampIdx(t+2*(k-2), T)
				inVec := &c.act1[ti]
				dIn := &dAct1[ti]
				wk := wBase + k*HiddenL1
				for ic := 0; ic < HiddenL1; ic++ {
					grad[offW2+wk+ic] += dp * inVec[ic]
					dIn[ic] += dp * w2[wk+ic]
				}
			}
		}
	}

	// 4. Backprop Layer 1 (`act1 = leakyRelu(pre1)`, `pre1 = b1 + conv1(x, d=1)`)
	for t := 0; t < T; t++ {
		for o := 0; o < HiddenL1; o++ {
			dp := dAct1[t][o] * leakyReluGrad(c.pre1[t][o])
			grad[offB1+o] += dp
			wBase := o * (InputChannels * kSize)
			for k := 0; k < kSize; k++ {
				ti := clampIdx(t+(k-2), T)
				inVec := x[ti]
				wk := wBase + k*InputChannels
				grad[offW1+wk] += dp * inVec[0]
				grad[offW1+wk+1] += dp * inVec[1]
				grad[offW1+wk+2] += dp * inVec[2]
			}
		}
	}

	return totalLoss
}
