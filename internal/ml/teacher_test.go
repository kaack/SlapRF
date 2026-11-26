package ml

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"runtime"
	"testing"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/ml/gguf"
	"slaprf/internal/tracestore"
)

func buildTinyTeacherGGUF(t *testing.T) []byte {
	t.Helper()
	// Vocab covers every character used in `buildSystem1BatchPrompt` + required class/align tokens.
	tokens := []string{
		"!", "\"", "#", "$", "%", "&", "'", "(", ")", "*", "+", ",", "-", ".", "/",
		"0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ":", ";", "<", "=", ">", "?", "@",
		"A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
		"[", "\\", "]", "^", "_", "`",
		"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
		"{", "|", "}", "~", "\u010a", "\u0120",
		"\u0120crossing", "\u0120bleed", "\u0120echo", "\u0120noise", "\u0120center", "\u0120peak",
		"<|im_start|>", "<|im_end|>", "<think>", "</think>",
	}
	tokTypes := make([]int32, len(tokens))
	for i := range tokTypes {
		tokTypes[i] = 1
	}
	for i := len(tokens) - 4; i < len(tokens); i++ {
		tokTypes[i] = 3
	}

	var buf bytes.Buffer
	wStr := func(s string) {
		_ = binary.Write(&buf, binary.LittleEndian, uint64(len(s)))
		buf.WriteString(s)
	}
	wU32 := func(k string, v uint32) {
		wStr(k)
		_ = binary.Write(&buf, binary.LittleEndian, uint32(4))
		_ = binary.Write(&buf, binary.LittleEndian, v)
	}
	wF32 := func(k string, v float32) {
		wStr(k)
		_ = binary.Write(&buf, binary.LittleEndian, uint32(6))
		_ = binary.Write(&buf, binary.LittleEndian, math.Float32bits(v))
	}
	makeOnesF32 := func(n int) []byte {
		b := make([]byte, n*4)
		for i := 0; i < n; i++ {
			binary.LittleEndian.PutUint32(b[i*4:], math.Float32bits(1.0))
		}
		return b
	}
	makeTokEmbd := func(cols, rows int) []byte {
		// Bias `\u0120crossing` strongly positive in dim 0..31 so synthetic test picks `crossing` deterministically
		b := make([]byte, rows*cols*4)
		for r := 0; r < rows; r++ {
			val := float32(0.05)
			if tokens[r] == "\u0120crossing" || tokens[r] == "\u0120center" {
				val = 0.85
			}
			for c := 0; c < cols; c++ {
				binary.LittleEndian.PutUint32(b[(r*cols+c)*4:], math.Float32bits(val))
			}
		}
		return b
	}
	makeZeroQ4 := func(cols, rows int) []byte {
		nb := cols / 256
		return make([]byte, rows*nb*144)
	}

	type rawT struct {
		name string
		dims []uint64
		tt   gguf.GGMLType
		data []byte
	}
	tList := []rawT{
		{"token_embd.weight", []uint64{256, uint64(len(tokens))}, gguf.TypeF32, makeTokEmbd(256, len(tokens))},
		{"output_norm.weight", []uint64{256}, gguf.TypeF32, makeOnesF32(256)},
		{"blk.0.attn_norm.weight", []uint64{256}, gguf.TypeF32, makeOnesF32(256)},
		{"blk.0.attn_q.weight", []uint64{256, 256}, gguf.TypeQ4_K, makeZeroQ4(256, 256)},
		{"blk.0.attn_k.weight", []uint64{256, 128}, gguf.TypeQ4_K, makeZeroQ4(256, 128)},
		{"blk.0.attn_v.weight", []uint64{256, 128}, gguf.TypeQ4_K, makeZeroQ4(256, 128)},
		{"blk.0.attn_q_norm.weight", []uint64{64}, gguf.TypeF32, makeOnesF32(64)},
		{"blk.0.attn_k_norm.weight", []uint64{64}, gguf.TypeF32, makeOnesF32(64)},
		{"blk.0.attn_output.weight", []uint64{256, 256}, gguf.TypeQ4_K, makeZeroQ4(256, 256)},
		{"blk.0.ffn_norm.weight", []uint64{256}, gguf.TypeF32, makeOnesF32(256)},
		{"blk.0.ffn_gate.weight", []uint64{256, 512}, gguf.TypeQ4_K, makeZeroQ4(256, 512)},
		{"blk.0.ffn_up.weight", []uint64{256, 512}, gguf.TypeQ4_K, makeZeroQ4(256, 512)},
		{"blk.0.ffn_down.weight", []uint64{512, 256}, gguf.TypeQ4_K, makeZeroQ4(512, 256)},
	}

	buf.WriteString("GGUF")
	_ = binary.Write(&buf, binary.LittleEndian, uint32(3))
	_ = binary.Write(&buf, binary.LittleEndian, uint64(len(tList)))
	_ = binary.Write(&buf, binary.LittleEndian, uint64(12))

	wStr("general.architecture")
	_ = binary.Write(&buf, binary.LittleEndian, uint32(8))
	wStr("qwen3")
	wU32("qwen3.block_count", 1)
	wU32("qwen3.embedding_length", 256)
	wU32("qwen3.feed_forward_length", 512)
	wU32("qwen3.attention.head_count", 4)
	wU32("qwen3.attention.head_count_kv", 2)
	wU32("qwen3.attention.key_length", 64)
	wF32("qwen3.rope.freq_base", 1_000_000.0)
	wF32("qwen3.attention.layer_norm_rms_epsilon", 1e-6)
	wU32("tokenizer.ggml.eos_token_id", uint32(len(tokens)-3))

	wStr("tokenizer.ggml.tokens")
	_ = binary.Write(&buf, binary.LittleEndian, uint32(9))
	_ = binary.Write(&buf, binary.LittleEndian, uint32(8))
	_ = binary.Write(&buf, binary.LittleEndian, uint64(len(tokens)))
	for _, tk := range tokens {
		wStr(tk)
	}
	wStr("tokenizer.ggml.token_type")
	_ = binary.Write(&buf, binary.LittleEndian, uint32(9))
	_ = binary.Write(&buf, binary.LittleEndian, uint32(5))
	_ = binary.Write(&buf, binary.LittleEndian, uint64(len(tokTypes)))
	for _, tt := range tokTypes {
		_ = binary.Write(&buf, binary.LittleEndian, tt)
	}

	align := func(v uint64) uint64 {
		if v%32 == 0 {
			return v
		}
		return v + (32 - v%32)
	}
	var off uint64
	for _, tr := range tList {
		wStr(tr.name)
		_ = binary.Write(&buf, binary.LittleEndian, uint32(len(tr.dims)))
		for _, d := range tr.dims {
			_ = binary.Write(&buf, binary.LittleEndian, d)
		}
		_ = binary.Write(&buf, binary.LittleEndian, uint32(tr.tt))
		_ = binary.Write(&buf, binary.LittleEndian, off)
		off = align(off + uint64(len(tr.data)))
	}
	for buf.Len()%32 != 0 {
		buf.WriteByte(0)
	}
	base := buf.Len()
	var cur uint64
	for _, tr := range tList {
		for uint64(buf.Len()-base) < cur {
			buf.WriteByte(0)
		}
		buf.Write(tr.data)
		cur = align(cur + uint64(len(tr.data)))
	}
	return buf.Bytes()
}

func TestCandidateExtractionDipoleMergeAndCoincidence(t *testing.T) {
	sess := domain.PracticeSession{
		SessionID: "sess-1",
		Pilots: []domain.PracticeSessionPilot{
			{SlotIndex: 1, Callsign: "OneEye"},
		},
		TrackSnapshot: []domain.TrackGate{
			{GateID: 1, Name: "H1", Role: domain.GateRole("START_FINISH"), TrackOrder: 0},
			{GateID: 2, Name: "T1", Role: domain.GateRole("SECTOR_GATE"), TrackOrder: 1},
		},
	}

	var samples []tracestore.Sample
	// 12 seconds at 50 Hz (600 steps)
	for i := 0; i < 600; i++ {
		tsUs := uint64(1_000_000 + i*20_000)
		tSec := float64(i) * 0.02

		// Gate 1: dipole M-null crossing centered at t = 4.00 s (shoulders around 3.92s and 4.08s)
		r1 := float32(-90.0)
		dt1 := tSec - 4.00
		if math.Abs(dt1) < 1.0 {
			env := 42.0 / (1.0 + (dt1/0.18)*(dt1/0.18))
			notch := 12.0 * math.Exp(-(dt1*dt1)/(2*0.045*0.045))
			r1 = -90.0 + float32(math.Max(0, env-notch))
		}

		// Gate 2: simultaneous 15 dB cross-gate bleed at t = 4.02 s
		r2 := float32(-90.0)
		dt2 := tSec - 4.02
		if math.Abs(dt2) < 0.8 {
			env2 := 15.0 / (1.0 + (dt2/0.22)*(dt2/0.22))
			r2 = -90.0 + float32(env2)
		}

		samples = append(samples,
			tracestore.Sample{
				GateID:        1,
				SeqNum:        uint32(i + 1),
				TimestampUs:   tsUs,
				NoiseFloorDbm: -90.0,
				SlotIndices:   []uint8{1},
				RSSIDbm:       []float32{r1},
			},
			tracestore.Sample{
				GateID:        2,
				SeqNum:        uint32(i + 1),
				TimestampUs:   tsUs,
				NoiseFloorDbm: -90.0,
				SlotIndices:   []uint8{1},
				RSSIDbm:       []float32{r2},
			},
		)
	}

	cands := ExtractSessionCandidates(sess, samples)
	if len(cands) != 2 {
		t.Fatalf("expected M-null merged into 1 H1 candidate + 1 T1 bleed candidate = 2 total, got %d: %+v", len(cands), cands)
	}
	var h1, t1 *CandidatePeak
	for i := range cands {
		if cands[i].GateID == 1 {
			h1 = &cands[i]
		} else if cands[i].GateID == 2 {
			t1 = &cands[i]
		}
	}
	if h1 == nil || t1 == nil {
		t.Fatalf("missing H1 or T1 candidate: %+v", cands)
	}
	if h1.MDipDb < 1.5 {
		t.Fatalf("expected H1 M-dip detected (>= 1.5 dB), got %.2f", h1.MDipDb)
	}
	if len(t1.Coincident) != 1 || t1.Coincident[0].GateID != 1 {
		t.Fatalf("expected T1 bleed candidate to record coincident H1 peak, got %+v", t1.Coincident)
	}

	// Verify TeacherManager download + SHA-256 verify + Qwen3GGUFLabeler end-to-end execution
	ggufBytes := buildTinyTeacherGGUF(t)
	sum := sha256.Sum256(ggufBytes)
	sumHex := hex.EncodeToString(sum[:])

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(ggufBytes)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(ggufBytes)
	}))
	defer srv.Close()

	mgr := NewTeacherManager(t.TempDir(), srv.Client())
	mgr.OverrideCatalogForTest([]TeacherPackSpec{
		{
			PackID:      DefaultTeacherPackID,
			Name:        "Test Qwen3",
			Filename:    "test-qwen3.gguf",
			DownloadURL: srv.URL + "/test-qwen3.gguf",
			SizeBytes:   int64(len(ggufBytes)),
			SHA256:      sumHex,
			Recommended: true,
		},
	})

	if err := mgr.StartDownload(DefaultTeacherPackID); err != nil {
		t.Fatalf("StartDownload: %v", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		st := mgr.Status(DefaultTeacherPackID)
		if st.Ready && !st.Download.Running {
			break
		}
		if st.Download.Error != "" {
			t.Fatalf("download error: %s", st.Download.Error)
		}
		time.Sleep(15 * time.Millisecond)
	}
	if !mgr.Status(DefaultTeacherPackID).Ready {
		t.Fatalf("expected teacher pack to be installed & ready")
	}

	lbl, packID, err := mgr.ResolveLabeler(DefaultTeacherPackID)
	if err != nil || packID != DefaultTeacherPackID {
		t.Fatalf("ResolveLabeler: err=%v packID=%s", err, packID)
	}
	decs, err := lbl.LabelCandidates(context.Background(), sess, cands, nil)
	if err != nil {
		t.Fatalf("LabelCandidates: %v", err)
	}
	if len(decs) != 2 || decs[0].Label != "crossing" {
		t.Fatalf("unexpected decisions: %+v", decs)
	}
}

func TestLong58MinuteMultiPackTrainingSpeed(t *testing.T) {
	// Reproduce the exact Pixel 7 Pro 2-pack workload: ~960,000 raw 100 Hz samples (~58 minutes with
	// bench idle stretches) across 8 gate traces and ~144 crossings, trained for 28 epochs (AugPerTrace=3).
	const nTraces = 8
	const ptsPerTrace = 120_000 // 20 min @ 100 Hz per trace -> 960,000 raw points total
	traces := make([]LabeledTrace, nTraces)
	for ti := 0; ti < nTraces; ti++ {
		pts := make([]RawPoint, ptsPerTrace)
		for i := range pts {
			pts[i] = RawPoint{
				TimestampUs:   uint64(1_000_000 + i*10_000),
				RSSIDbm:       -91.0,
				NoiseFloorDbm: -91.0,
			}
		}
		var pos []CrossingLabel
		// 18 passes clustered during a 3-minute active flight window inside the 20-minute recording
		for p := 0; p < 18; p++ {
			centerIdx := 20_000 + p*950
			pos = append(pos, CrossingLabel{TimestampUs: pts[centerIdx].TimestampUs})
			for k := -35; k <= 35; k++ {
				idx := centerIdx + k
				if idx >= 0 && idx < ptsPerTrace {
					u := float32(k) / 14.0
					pts[idx].RSSIDbm = -91.0 + 38.0/(1.0+u*u)
				}
			}
		}
		traces[ti] = LabeledTrace{
			SessionID: fmt.Sprintf("pack-%d", ti/4+1),
			GateID:    uint8(ti%4 + 1),
			SlotIndex: 1,
			EnterDbm:  -68,
			ExitDbm:   -76,
			Points:    pts,
			Positives: pos,
		}
	}

	t0 := time.Now()
	m, loss := TrainModel(traces, nil, TrainOptions{
		Epochs:       28,
		LearningRate: 0.004,
		WeightDecay:  1e-4,
		AugPerTrace:  3,
		Seed:         77,
	})
	trainDur := time.Since(t0)
	aiM, _ := BenchmarkTraces(m, traces[:2], 1_500_000)
	totalDur := time.Since(t0)

	procs := runtime.GOMAXPROCS(0)
	if procs < 1 {
		procs = 1
	} else if procs > 18 {
		procs = 18
	}
	maxDur := 240 * time.Second / time.Duration(procs)
	t.Logf("960k-sample 28-epoch TrainModel=%v, total+benchmark=%v (procs=%d, budget=%v, loss=%.4f, F1=%.3f)", trainDur, totalDur, runtime.GOMAXPROCS(0), maxDur, loss, aiM.F1)
	if totalDur > maxDur {
		t.Fatalf("expected 960k-sample 28-epoch training to finish in <%v (procs=%d), took %v", maxDur, runtime.GOMAXPROCS(0), totalDur)
	}
	if aiM.F1 < 0.90 {
		t.Fatalf("expected trained model F1 >= 0.90, got %.3f (%+v)", aiM.F1, aiM)
	}
}
