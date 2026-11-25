package gguf

import (
	"context"
	"fmt"
	"math"
	"runtime"
	"sync"
)

type qwen3Layer struct {
	attnNorm   []float32
	attnQ      Tensor
	attnK      Tensor
	attnV      Tensor
	attnQNorm  []float32
	attnKNorm  []float32
	attnOutput Tensor
	ffnNorm    []float32
	ffnGate    Tensor
	ffnUp      Tensor
	ffnDown    Tensor
}

// Qwen3Model holds a zero-copy `mmap`-backed Qwen3 transformer (`0.6B` / `1.7B` / `4B`).
type Qwen3Model struct {
	file       *File
	Tokenizer  *Tokenizer
	NLayer     int
	NEmbd      int
	NFF        int
	NHead      int
	NHeadKV    int
	HeadDim    int
	QDim       int
	KVDim      int
	VocabSize  int
	RMSNormEps float32
	RoPEBase   float64
	tokEmbd    Tensor
	outputNorm []float32
	output     Tensor
	layers     []qwen3Layer
	invFreq    []float64
}

// LoadQwen3 opens and validates a `qwen3` `.gguf` model from disk.
func LoadQwen3(path string) (*Qwen3Model, error) {
	f, err := Open(path)
	if err != nil {
		return nil, err
	}
	m, err := LoadQwen3FromFile(f)
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	return m, nil
}

// LoadQwen3FromFile initializes a `Qwen3Model` over an already-parsed `*File`.
func LoadQwen3FromFile(f *File) (*Qwen3Model, error) {
	arch, _ := f.Metadata["general.architecture"].(string)
	if arch != "" && arch != "qwen3" {
		return nil, fmt.Errorf("expected general.architecture=\"qwen3\", got %q", arch)
	}
	tok, err := NewTokenizer(f.Metadata)
	if err != nil {
		return nil, err
	}

	nLayer, ok1 := metaUint64(f.Metadata, "qwen3.block_count")
	nEmbd, ok2 := metaUint64(f.Metadata, "qwen3.embedding_length")
	nFF, ok3 := metaUint64(f.Metadata, "qwen3.feed_forward_length")
	nHead, ok4 := metaUint64(f.Metadata, "qwen3.attention.head_count")
	nHeadKV, ok5 := metaUint64(f.Metadata, "qwen3.attention.head_count_kv")
	if !ok1 || !ok2 || !ok3 || !ok4 || !ok5 || nLayer == 0 || nHead == 0 || nHeadKV == 0 {
		return nil, fmt.Errorf("missing required qwen3 hyperparameters in GGUF header")
	}
	headDim, okHD := metaUint64(f.Metadata, "qwen3.attention.key_length")
	if !okHD || headDim == 0 {
		headDim = nEmbd / nHead
	}
	eps := metaFloat32(f.Metadata, "qwen3.attention.layer_norm_rms_epsilon", 1e-6)
	ropeBase := float64(metaFloat32(f.Metadata, "qwen3.rope.freq_base", 1_000_000.0))

	tokEmbd, ok := f.Tensors["token_embd.weight"]
	if !ok {
		return nil, fmt.Errorf("missing token_embd.weight tensor")
	}
	outNormT, ok := f.Tensors["output_norm.weight"]
	if !ok {
		return nil, fmt.Errorf("missing output_norm.weight tensor")
	}
	output, hasOut := f.Tensors["output.weight"]
	if !hasOut {
		output = tokEmbd
	}

	loadVec := func(name string, want int) ([]float32, error) {
		t, exists := f.Tensors[name]
		if !exists {
			return nil, fmt.Errorf("missing tensor %q", name)
		}
		if t.Cols() != want {
			return nil, fmt.Errorf("tensor %q cols=%d, want %d", name, t.Cols(), want)
		}
		v := make([]float32, want)
		DequantizeRow(v, t, 0)
		return v, nil
	}

	outNorm, err := loadVec(outNormT.Name, int(nEmbd))
	if err != nil {
		return nil, err
	}

	layers := make([]qwen3Layer, int(nLayer))
	for i := 0; i < int(nLayer); i++ {
		prefix := fmt.Sprintf("blk.%d.", i)
		an, err := loadVec(prefix+"attn_norm.weight", int(nEmbd))
		if err != nil {
			return nil, err
		}
		qn, err := loadVec(prefix+"attn_q_norm.weight", int(headDim))
		if err != nil {
			return nil, err
		}
		kn, err := loadVec(prefix+"attn_k_norm.weight", int(headDim))
		if err != nil {
			return nil, err
		}
		fn, err := loadVec(prefix+"ffn_norm.weight", int(nEmbd))
		if err != nil {
			return nil, err
		}
		reqTensor := func(suffix string) (Tensor, error) {
			t, exists := f.Tensors[prefix+suffix]
			if !exists {
				return Tensor{}, fmt.Errorf("missing tensor %q", prefix+suffix)
			}
			return t, nil
		}
		aq, err := reqTensor("attn_q.weight")
		if err != nil {
			return nil, err
		}
		ak, err := reqTensor("attn_k.weight")
		if err != nil {
			return nil, err
		}
		av, err := reqTensor("attn_v.weight")
		if err != nil {
			return nil, err
		}
		ao, err := reqTensor("attn_output.weight")
		if err != nil {
			return nil, err
		}
		fg, err := reqTensor("ffn_gate.weight")
		if err != nil {
			return nil, err
		}
		fu, err := reqTensor("ffn_up.weight")
		if err != nil {
			return nil, err
		}
		fd, err := reqTensor("ffn_down.weight")
		if err != nil {
			return nil, err
		}
		layers[i] = qwen3Layer{
			attnNorm:   an,
			attnQ:      aq,
			attnK:      ak,
			attnV:      av,
			attnQNorm:  qn,
			attnKNorm:  kn,
			attnOutput: ao,
			ffnNorm:    fn,
			ffnGate:    fg,
			ffnUp:      fu,
			ffnDown:    fd,
		}
	}

	half := int(headDim) / 2
	invFreq := make([]float64, half)
	for d := 0; d < half; d++ {
		invFreq[d] = 1.0 / math.Pow(ropeBase, float64(2*d)/float64(headDim))
	}

	return &Qwen3Model{
		file:       f,
		Tokenizer:  tok,
		NLayer:     int(nLayer),
		NEmbd:      int(nEmbd),
		NFF:        int(nFF),
		NHead:      int(nHead),
		NHeadKV:    int(nHeadKV),
		HeadDim:    int(headDim),
		QDim:       int(nHead * headDim),
		KVDim:      int(nHeadKV * headDim),
		VocabSize:  tokEmbd.Rows(),
		RMSNormEps: eps,
		RoPEBase:   ropeBase,
		tokEmbd:    tokEmbd,
		outputNorm: outNorm,
		output:     output,
		layers:     layers,
		invFreq:    invFreq,
	}, nil
}

// Close releases the underlying `mmap` pages immediately.
func (m *Qwen3Model) Close() error {
	if m == nil || m.file == nil {
		return nil
	}
	err := m.file.Close()
	m.file = nil
	return err
}

// Session holds a reusable KV-cache context for batched prompt prefill and grammar-constrained slot scoring.
type Session struct {
	model   *Qwen3Model
	maxSeq  int
	pos     int
	workers int
	kCache  []float32 // [NLayer * maxSeq * KVDim]
	vCache  []float32 // [NLayer * maxSeq * KVDim]
	lastOut []float32 // [NEmbd] normalized final hidden state after output_norm
	lastQ8  []Q8KBlock
}

// NewSession allocates a KV-cache session up to `maxSeq` tokens (e.g. `1024` or `2048`).
// Worker count is capped (`<= 4`, leaving >= 2 cores free on mobile big.LITTLE SoCs) so background
// System 1 labeling stays on fast performance cores and never starves 60 FPS UI or live BLE telemetry.
func (m *Qwen3Model) NewSession(maxSeq int) *Session {
	if maxSeq < 64 {
		maxSeq = 64
	}
	procs := runtime.GOMAXPROCS(0)
	workers := procs
	if procs >= 6 {
		workers = 4
	} else if procs >= 3 {
		workers = procs - 1
	}
	if workers < 1 {
		workers = 1
	}
	kvTotal := m.NLayer * maxSeq * m.KVDim
	var lastQ8 []Q8KBlock
	if m.NEmbd%qkK == 0 {
		lastQ8 = make([]Q8KBlock, m.NEmbd/qkK)
	}
	return &Session{
		model:   m,
		maxSeq:  maxSeq,
		workers: workers,
		kCache:  make([]float32, kvTotal),
		vCache:  make([]float32, kvTotal),
		lastOut: make([]float32, m.NEmbd),
		lastQ8:  lastQ8,
	}
}

// Reset rewinds the KV cache cursor to `0` without reallocating buffers.
func (s *Session) Reset() {
	s.pos = 0
}

// Pos returns the current KV cache token position.
func (s *Session) Pos() int {
	return s.pos
}

// SetPos rewinds the KV cache cursor to an earlier checkpoint `p <= s.pos` for zero-copy branch evaluation.
func (s *Session) SetPos(p int) {
	if p >= 0 && p <= s.pos {
		s.pos = p
	}
}

func rmsNorm(dst, src, weight []float32, eps float32) {
	var ss float32
	n := len(src)
	for i := 0; i < n; i++ {
		v := src[i]
		ss += v * v
	}
	scale := 1.0 / float32(math.Sqrt(float64(ss/float32(n)+eps)))
	for i := 0; i < n; i++ {
		dst[i] = src[i] * scale * weight[i]
	}
}

func applyHeadRMSNormAndNeoXRoPE(vec []float32, nHeads, headDim int, normWeight []float32, eps float32, pos int, invFreq []float64) {
	half := headDim / 2
	var cosBuf [128]float32
	var sinBuf [128]float32
	pFloat := float64(pos)
	for d := 0; d < half; d++ {
		ang := pFloat * invFreq[d]
		sn, cs := math.Sincos(ang)
		cosBuf[d] = float32(cs)
		sinBuf[d] = float32(sn)
	}

	for h := 0; h < nHeads; h++ {
		hv := vec[h*headDim : (h+1)*headDim]
		rmsNorm(hv, hv, normWeight, eps)
		for d := 0; d < half; d++ {
			x0 := hv[d]
			x1 := hv[d+half]
			cs := cosBuf[d]
			sn := sinBuf[d]
			hv[d] = x0*cs - x1*sn
			hv[d+half] = x0*sn + x1*cs
		}
	}
}

// ForwardTokens ingests `tokens` (`len >= 1`) starting at `s.pos`, updating the KV cache and `s.lastOut`.
func (s *Session) ForwardTokens(tokens []int) error {
	return s.ForwardTokensCtx(context.Background(), tokens)
}

// ForwardTokensCtx ingests `tokens` (`len >= 1`) starting at `s.pos`, checking `ctx.Err()` before each
// transformer block so canceling an on-device Auto-Label job aborts in `< 50 ms` and frees RAM immediately.
func (s *Session) ForwardTokensCtx(ctx context.Context, tokens []int) error {
	T := len(tokens)
	if T == 0 {
		return nil
	}
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	m := s.model
	if s.pos+T > s.maxSeq {
		return fmt.Errorf("sequence length %d + %d exceeds session maxSeq %d", s.pos, T, s.maxSeq)
	}
	startPos := s.pos
	nEmbd := m.NEmbd
	qDim := m.QDim
	kvDim := m.KVDim
	nFF := m.NFF

	x := make([]float32, T*nEmbd)
	for t, tok := range tokens {
		if tok < 0 || tok >= m.VocabSize {
			tok = 0
		}
		DequantizeRow(x[t*nEmbd:(t+1)*nEmbd], m.tokEmbd, tok)
	}

	normed := make([]float32, T*nEmbd)
	var xQ8 []Q8KBlock
	if nEmbd%qkK == 0 {
		xQ8 = make([]Q8KBlock, T*(nEmbd/qkK))
	}
	qBatch := make([]float32, T*qDim)
	kBatch := make([]float32, T*kvDim)
	vBatch := make([]float32, T*kvDim)
	attnConcat := make([]float32, T*qDim)
	var attnQ8 []Q8KBlock
	if qDim%qkK == 0 {
		attnQ8 = make([]Q8KBlock, T*(qDim/qkK))
	}
	attnProj := make([]float32, T*nEmbd)

	gateBuf := make([]float32, T*nFF)
	upBuf := make([]float32, T*nFF)
	var ffnQ8 []Q8KBlock
	if nFF%qkK == 0 {
		ffnQ8 = make([]Q8KBlock, T*(nFF/qkK))
	}
	downBuf := make([]float32, T*nEmbd)

	attnScale := float32(1.0 / math.Sqrt(float64(m.HeadDim)))
	gqaRatio := m.NHead / m.NHeadKV
	layerKVStride := s.maxSeq * kvDim

	for il := 0; il < m.NLayer; il++ {
		if ctx != nil {
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		ly := &m.layers[il]
		for t := 0; t < T; t++ {
			rmsNorm(normed[t*nEmbd:(t+1)*nEmbd], x[t*nEmbd:(t+1)*nEmbd], ly.attnNorm, m.RMSNormEps)
		}
		if len(xQ8) > 0 {
			QuantizeQ8K(xQ8, normed)
		}

		MatBatch(qBatch, ly.attnQ, T, normed, xQ8, s.workers)
		MatBatch(kBatch, ly.attnK, T, normed, xQ8, s.workers)
		MatBatch(vBatch, ly.attnV, T, normed, xQ8, s.workers)

		kLayer := s.kCache[il*layerKVStride : (il+1)*layerKVStride]
		vLayer := s.vCache[il*layerKVStride : (il+1)*layerKVStride]

		for t := 0; t < T; t++ {
			curPos := startPos + t
			qt := qBatch[t*qDim : (t+1)*qDim]
			kt := kBatch[t*kvDim : (t+1)*kvDim]
			vt := vBatch[t*kvDim : (t+1)*kvDim]
			applyHeadRMSNormAndNeoXRoPE(qt, m.NHead, m.HeadDim, ly.attnQNorm, m.RMSNormEps, curPos, m.invFreq)
			applyHeadRMSNormAndNeoXRoPE(kt, m.NHeadKV, m.HeadDim, ly.attnKNorm, m.RMSNormEps, curPos, m.invFreq)
			copy(kLayer[curPos*kvDim:(curPos+1)*kvDim], kt)
			copy(vLayer[curPos*kvDim:(curPos+1)*kvDim], vt)
		}

		// On the final transformer block (`il == m.NLayer-1`), only the last token (`t = T-1`) feeds `lastOut`!
		tStart := 0
		if il == m.NLayer-1 && T > 1 {
			tStart = T - 1
		}
		activeT := T - tStart

		// Causal Grouped-Query Attention
		computeTokenAttn := func(t int) {
			curPos := startPos + t
			seqLen := curPos + 1
			scores := make([]float32, seqLen)
			qt := qBatch[t*qDim : (t+1)*qDim]
			outT := attnConcat[t*qDim : (t+1)*qDim]
			for h := 0; h < m.NHead; h++ {
				kvH := h / gqaRatio
				qh := qt[h*m.HeadDim : (h+1)*m.HeadDim]
				maxSc := float32(-1e30)
				for p := 0; p < seqLen; p++ {
					kh := kLayer[p*kvDim+kvH*m.HeadDim : p*kvDim+(kvH+1)*m.HeadDim]
					var dot float32
					for d := 0; d < m.HeadDim; d++ {
						dot += qh[d] * kh[d]
					}
					sc := dot * attnScale
					scores[p] = sc
					if sc > maxSc {
						maxSc = sc
					}
				}
				var sumExp float32
				for p := 0; p < seqLen; p++ {
					e := float32(math.Exp(float64(scores[p] - maxSc)))
					scores[p] = e
					sumExp += e
				}
				invSum := 1.0 / sumExp
				oh := outT[h*m.HeadDim : (h+1)*m.HeadDim]
				for d := 0; d < m.HeadDim; d++ {
					oh[d] = 0
				}
				for p := 0; p < seqLen; p++ {
					w := scores[p] * invSum
					vh := vLayer[p*kvDim+kvH*m.HeadDim : p*kvDim+(kvH+1)*m.HeadDim]
					for d := 0; d < m.HeadDim; d++ {
						oh[d] += w * vh[d]
					}
				}
			}
		}

		if activeT <= 2 || s.workers <= 1 {
			for t := tStart; t < T; t++ {
				computeTokenAttn(t)
			}
		} else {
			var wg sync.WaitGroup
			chunk := (activeT + s.workers - 1) / s.workers
			for wi := 0; wi < s.workers; wi++ {
				c0 := tStart + wi*chunk
				if c0 >= T {
					break
				}
				c1 := c0 + chunk
				if c1 > T {
					c1 = T
				}
				wg.Add(1)
				go func(lo, hi int) {
					defer wg.Done()
					for t := lo; t < hi; t++ {
						computeTokenAttn(t)
					}
				}(c0, c1)
			}
			wg.Wait()
		}

		acSlice := attnConcat[tStart*qDim : T*qDim]
		var aqSlice []Q8KBlock
		if len(attnQ8) > 0 {
			nbQ := qDim / qkK
			aqSlice = attnQ8[tStart*nbQ : T*nbQ]
			QuantizeQ8K(aqSlice, acSlice)
		}
		apSlice := attnProj[tStart*nEmbd : T*nEmbd]
		MatBatch(apSlice, ly.attnOutput, activeT, acSlice, aqSlice, s.workers)

		xActive := x[tStart*nEmbd : T*nEmbd]
		for i := range xActive {
			xActive[i] += apSlice[i]
		}

		normActive := normed[tStart*nEmbd : T*nEmbd]
		for i := 0; i < activeT; i++ {
			rmsNorm(normActive[i*nEmbd:(i+1)*nEmbd], xActive[i*nEmbd:(i+1)*nEmbd], ly.ffnNorm, m.RMSNormEps)
		}
		var xQ8Active []Q8KBlock
		if len(xQ8) > 0 {
			nbE := nEmbd / qkK
			xQ8Active = xQ8[tStart*nbE : T*nbE]
			QuantizeQ8K(xQ8Active, normActive)
		}

		gActive := gateBuf[:activeT*nFF]
		uActive := upBuf[:activeT*nFF]
		MatBatch(gActive, ly.ffnGate, activeT, normActive, xQ8Active, s.workers)
		MatBatch(uActive, ly.ffnUp, activeT, normActive, xQ8Active, s.workers)

		// SiLU(gate) * up in place into gActive
		for i, gv := range gActive {
			sig := float32(1.0 / (1.0 + math.Exp(float64(-gv))))
			gActive[i] = (gv * sig) * uActive[i]
		}

		var fqActive []Q8KBlock
		if len(ffnQ8) > 0 {
			nbF := nFF / qkK
			fqActive = ffnQ8[:activeT*nbF]
			QuantizeQ8K(fqActive, gActive)
		}
		dActive := downBuf[:activeT*nEmbd]
		MatBatch(dActive, ly.ffnDown, activeT, gActive, fqActive, s.workers)
		for i := range xActive {
			xActive[i] += dActive[i]
		}
	}

	s.pos = startPos + T
	rmsNorm(s.lastOut, x[(T-1)*nEmbd:T*nEmbd], m.outputNorm, m.RMSNormEps)
	if len(s.lastQ8) > 0 {
		QuantizeQ8K(s.lastQ8, s.lastOut)
	}
	return nil
}

// ScoreSingleTokens evaluates the exact softmax probability distribution over `tokenIDs` at the
// current KV position by computing ONLY `len(tokenIDs)` dot products against the output LM head!
func (s *Session) ScoreSingleTokens(tokenIDs []int) ([]float32, int) {
	logits := make([]float32, len(tokenIDs))
	DotSelectedRows(logits, s.model.output, tokenIDs, s.lastOut, s.lastQ8)

	bestIdx := 0
	maxL := logits[0]
	for i := 1; i < len(logits); i++ {
		if logits[i] > maxL {
			maxL = logits[i]
			bestIdx = i
		}
	}
	probs := make([]float32, len(logits))
	var sum float32
	for i, l := range logits {
		e := float32(math.Exp(float64(l - maxL)))
		probs[i] = e
		sum += e
	}
	if sum > 0 {
		inv := 1.0 / sum
		for i := range probs {
			probs[i] *= inv
		}
	}
	return probs, bestIdx
}
