package gguf

import (
	"bytes"
	"encoding/binary"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
)

func encodeTestQ4KBlock(d, dmin float32, sc [8]uint8, mn [8]uint8, nibs [256]uint8) [144]byte {
	var out [144]byte
	binary.LittleEndian.PutUint16(out[0:2], Float32ToFP16(d))
	binary.LittleEndian.PutUint16(out[2:4], Float32ToFP16(dmin))
	scales := out[4:16]
	for j := 0; j < 4; j++ {
		scales[j] = (sc[j] & 63) | ((sc[j+4] & 0x30) << 2)
		scales[j+4] = (mn[j] & 63) | ((mn[j+4] & 0x30) << 2)
		scales[j+8] = (sc[j+4] & 0x0F) | ((mn[j+4] & 0x0F) << 4)
	}
	qs := out[16:144]
	qOff := 0
	yOff := 0
	for is := 0; is < 8; is += 2 {
		for l := 0; l < 32; l++ {
			lo := nibs[yOff+l] & 0x0F
			hi := nibs[yOff+32+l] & 0x0F
			qs[qOff+l] = lo | (hi << 4)
		}
		qOff += 32
		yOff += 64
	}
	return out
}

func encodeTestQ6KBlock(d float32, sc [16]int8, vals [256]uint8) [210]byte {
	var out [210]byte
	ql := out[0:128]
	qh := out[128:192]
	for i := 0; i < 16; i++ {
		out[192+i] = byte(sc[i])
	}
	binary.LittleEndian.PutUint16(out[208:210], Float32ToFP16(d))
	for half := 0; half < 2; half++ {
		yOff := half * 128
		qlOff := half * 64
		qhOff := half * 32
		for l := 0; l < 32; l++ {
			v1 := vals[yOff+l] & 63
			v2 := vals[yOff+l+32] & 63
			v3 := vals[yOff+l+64] & 63
			v4 := vals[yOff+l+96] & 63
			ql[qlOff+l] = (v1 & 0x0F) | ((v3 & 0x0F) << 4)
			ql[qlOff+l+32] = (v2 & 0x0F) | ((v4 & 0x0F) << 4)
			qh[qhOff+l] = ((v1 >> 4) & 3) | (((v2 >> 4) & 3) << 2) | (((v3 >> 4) & 3) << 4) | (((v4 >> 4) & 3) << 6)
		}
	}
	return out
}

func TestQuantDotParityQ4KAndQ6K(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	x := make([]float32, 512)
	for i := range x {
		x[i] = float32(rng.NormFloat64() * 0.8)
	}
	xQ8 := make([]Q8KBlock, 2)
	QuantizeQ8K(xQ8, x)

	// 1. Q4_K row of 512 cols (2 blocks)
	var rawQ4 [288]byte
	for b := 0; b < 2; b++ {
		var sc, mn [8]uint8
		var nibs [256]uint8
		for i := 0; i < 8; i++ {
			sc[i] = uint8(rng.Intn(40) + 1)
			mn[i] = uint8(rng.Intn(30))
		}
		for i := 0; i < 256; i++ {
			nibs[i] = uint8(rng.Intn(16))
		}
		blk := encodeTestQ4KBlock(0.025, 0.015, sc, mn, nibs)
		copy(rawQ4[b*144:(b+1)*144], blk[:])
	}
	tQ4 := Tensor{Name: "w_q4", Dims: []uint64{512, 1}, Type: TypeQ4_K, Data: rawQ4[:]}
	deqQ4 := make([]float32, 512)
	DequantizeRow(deqQ4, tQ4, 0)
	var refQ4 float32
	for i := range deqQ4 {
		refQ4 += deqQ4[i] * x[i]
	}
	gotCGoOrDefault := dotSingleRow(rawQ4[:], TypeQ4_K, 512, x, xQ8)
	gotPureGo := dotRowGo(rawQ4[:], TypeQ4_K, 512, x, xQ8)
	if math.Abs(float64(gotCGoOrDefault-gotPureGo)) > 1e-4 {
		t.Fatalf("Q4_K CGo vs PureGo mismatch: %f vs %f", gotCGoOrDefault, gotPureGo)
	}
	if math.Abs(float64(gotCGoOrDefault-refQ4)) > 0.15*math.Max(1.0, math.Abs(float64(refQ4))) {
		t.Fatalf("Q4_K dot mismatch vs float32 dequant: got=%f ref=%f", gotCGoOrDefault, refQ4)
	}

	// 2. Q6_K row of 512 cols (2 blocks)
	var rawQ6 [420]byte
	for b := 0; b < 2; b++ {
		var sc [16]int8
		var vals [256]uint8
		for i := 0; i < 16; i++ {
			sc[i] = int8(rng.Intn(50) - 25)
		}
		for i := 0; i < 256; i++ {
			vals[i] = uint8(rng.Intn(64))
		}
		blk := encodeTestQ6KBlock(0.012, sc, vals)
		copy(rawQ6[b*210:(b+1)*210], blk[:])
	}
	tQ6 := Tensor{Name: "w_q6", Dims: []uint64{512, 1}, Type: TypeQ6_K, Data: rawQ6[:]}
	deqQ6 := make([]float32, 512)
	DequantizeRow(deqQ6, tQ6, 0)
	var refQ6 float32
	for i := range deqQ6 {
		refQ6 += deqQ6[i] * x[i]
	}
	gotQ6 := dotSingleRow(rawQ6[:], TypeQ6_K, 512, x, xQ8)
	gotQ6Go := dotRowGo(rawQ6[:], TypeQ6_K, 512, x, xQ8)
	if math.Abs(float64(gotQ6-gotQ6Go)) > 1e-4 {
		t.Fatalf("Q6_K CGo vs PureGo mismatch: %f vs %f", gotQ6, gotQ6Go)
	}
	if math.Abs(float64(gotQ6-refQ6)) > 0.12*math.Max(1.0, math.Abs(float64(refQ6))) {
		t.Fatalf("Q6_K dot mismatch vs float32 dequant: got=%f ref=%f", gotQ6, refQ6)
	}
}

func buildSyntheticQwen3GGUF(t *testing.T) []byte {
	t.Helper()
	// Tiny Qwen3 model: n_layer=1, n_embd=256, n_head=4, n_head_kv=2, head_dim=64, n_ff=512, vocab=16
	tokens := []string{
		"!", ":", "\u010a", "C", "1", "0", "-", "2",
		"\u0120crossing", "\u0120bleed", "\u0120echo", "\u0120noise",
		"<|im_start|>", "<|im_end|>", "<think>", "</think>",
	}
	tokTypes := []int32{1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 3, 4, 4}

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

	type rawTensor struct {
		name string
		dims []uint64
		tt   GGMLType
		data []byte
	}
	rng := rand.New(rand.NewSource(99))
	makeOnesF32 := func(n int) []byte {
		b := make([]byte, n*4)
		for i := 0; i < n; i++ {
			binary.LittleEndian.PutUint32(b[i*4:], math.Float32bits(1.0))
		}
		return b
	}
	makeQ4Mat := func(cols, rows int) []byte {
		nb := cols / 256
		b := make([]byte, rows*nb*144)
		for r := 0; r < rows; r++ {
			for bi := 0; bi < nb; bi++ {
				var sc, mn [8]uint8
				var nibs [256]uint8
				for i := 0; i < 8; i++ {
					sc[i] = 4
					mn[i] = 2
				}
				for i := 0; i < 256; i++ {
					nibs[i] = uint8(rng.Intn(16))
				}
				blk := encodeTestQ4KBlock(0.01, 0.015, sc, mn, nibs)
				off := (r*nb + bi) * 144
				copy(b[off:off+144], blk[:])
			}
		}
		return b
	}
	makeQ6Mat := func(cols, rows int) []byte {
		nb := cols / 256
		b := make([]byte, rows*nb*210)
		for r := 0; r < rows; r++ {
			for bi := 0; bi < nb; bi++ {
				var sc [16]int8
				var vals [256]uint8
				for i := 0; i < 16; i++ {
					sc[i] = 3
				}
				for i := 0; i < 256; i++ {
					vals[i] = uint8(rng.Intn(64))
				}
				blk := encodeTestQ6KBlock(0.008, sc, vals)
				off := (r*nb + bi) * 210
				copy(b[off:off+210], blk[:])
			}
		}
		return b
	}

	tList := []rawTensor{
		{"token_embd.weight", []uint64{256, uint64(len(tokens))}, TypeQ6_K, makeQ6Mat(256, len(tokens))},
		{"output_norm.weight", []uint64{256}, TypeF32, makeOnesF32(256)},
		{"blk.0.attn_norm.weight", []uint64{256}, TypeF32, makeOnesF32(256)},
		{"blk.0.attn_q.weight", []uint64{256, 256}, TypeQ4_K, makeQ4Mat(256, 256)},
		{"blk.0.attn_k.weight", []uint64{256, 128}, TypeQ4_K, makeQ4Mat(256, 128)},
		{"blk.0.attn_v.weight", []uint64{256, 128}, TypeQ6_K, makeQ6Mat(256, 128)},
		{"blk.0.attn_q_norm.weight", []uint64{64}, TypeF32, makeOnesF32(64)},
		{"blk.0.attn_k_norm.weight", []uint64{64}, TypeF32, makeOnesF32(64)},
		{"blk.0.attn_output.weight", []uint64{256, 256}, TypeQ4_K, makeQ4Mat(256, 256)},
		{"blk.0.ffn_norm.weight", []uint64{256}, TypeF32, makeOnesF32(256)},
		{"blk.0.ffn_gate.weight", []uint64{256, 512}, TypeQ4_K, makeQ4Mat(256, 512)},
		{"blk.0.ffn_up.weight", []uint64{256, 512}, TypeQ4_K, makeQ4Mat(256, 512)},
		{"blk.0.ffn_down.weight", []uint64{512, 256}, TypeQ6_K, makeQ6Mat(512, 256)},
	}

	buf.WriteString("GGUF")
	_ = binary.Write(&buf, binary.LittleEndian, uint32(3))
	_ = binary.Write(&buf, binary.LittleEndian, uint64(len(tList)))
	_ = binary.Write(&buf, binary.LittleEndian, uint64(12)) // n_kv

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
	wU32("tokenizer.ggml.eos_token_id", 13)

	// tokens array
	wStr("tokenizer.ggml.tokens")
	_ = binary.Write(&buf, binary.LittleEndian, uint32(9))
	_ = binary.Write(&buf, binary.LittleEndian, uint32(8))
	_ = binary.Write(&buf, binary.LittleEndian, uint64(len(tokens)))
	for _, tk := range tokens {
		wStr(tk)
	}
	// token_type array
	wStr("tokenizer.ggml.token_type")
	_ = binary.Write(&buf, binary.LittleEndian, uint32(9))
	_ = binary.Write(&buf, binary.LittleEndian, uint32(5))
	_ = binary.Write(&buf, binary.LittleEndian, uint64(len(tokTypes)))
	for _, tt := range tokTypes {
		_ = binary.Write(&buf, binary.LittleEndian, tt)
	}

	var dataOff uint64
	for _, tr := range tList {
		wStr(tr.name)
		_ = binary.Write(&buf, binary.LittleEndian, uint32(len(tr.dims)))
		for _, d := range tr.dims {
			_ = binary.Write(&buf, binary.LittleEndian, d)
		}
		_ = binary.Write(&buf, binary.LittleEndian, uint32(tr.tt))
		_ = binary.Write(&buf, binary.LittleEndian, dataOff)
		dataOff = alignUp(dataOff+uint64(len(tr.data)), 32)
	}
	for buf.Len()%32 != 0 {
		buf.WriteByte(0)
	}
	startLen := buf.Len()
	var curOff uint64
	for _, tr := range tList {
		for uint64(buf.Len()-startLen) < curOff {
			buf.WriteByte(0)
		}
		buf.Write(tr.data)
		curOff = alignUp(curOff+uint64(len(tr.data)), 32)
	}
	return buf.Bytes()
}

func TestQwen3MmapForwardBatchParityAndSlotScoring(t *testing.T) {
	raw := buildSyntheticQwen3GGUF(t)
	tmpPath := filepath.Join(t.TempDir(), "tiny-qwen3.gguf")
	if err := os.WriteFile(tmpPath, raw, 0o644); err != nil {
		t.Fatalf("write gguf: %v", err)
	}

	model, err := LoadQwen3(tmpPath)
	if err != nil {
		t.Fatalf("LoadQwen3: %v", err)
	}
	defer model.Close()

	toks := model.Tokenizer.Encode("<|im_start|>C1:<|im_end|><think>\n</think>\nC1:")
	if len(toks) < 6 {
		t.Fatalf("unexpected encoded tokens: %v", toks)
	}

	// Compare batched prefill vs step-by-step single-token KV forwarding
	sBatch := model.NewSession(128)
	if err := sBatch.ForwardTokens(toks); err != nil {
		t.Fatalf("batch ForwardTokens: %v", err)
	}

	sStep := model.NewSession(128)
	for _, tk := range toks {
		if err := sStep.ForwardTokens([]int{tk}); err != nil {
			t.Fatalf("step ForwardTokens: %v", err)
		}
	}

	for i := range sBatch.lastOut {
		if math.Abs(float64(sBatch.lastOut[i]-sStep.lastOut[i])) > 1e-4 {
			t.Fatalf("batched vs single-token hidden mismatch at %d: %f vs %f", i, sBatch.lastOut[i], sStep.lastOut[i])
		}
	}

	idCross, ok1 := model.Tokenizer.TokenID("\u0120crossing")
	idBleed, ok2 := model.Tokenizer.TokenID("\u0120bleed")
	idEcho, ok3 := model.Tokenizer.TokenID("\u0120echo")
	idNoise, ok4 := model.Tokenizer.TokenID("\u0120noise")
	if !ok1 || !ok2 || !ok3 || !ok4 {
		t.Fatalf("missing class token IDs")
	}
	probs, best := sBatch.ScoreSingleTokens([]int{idCross, idBleed, idEcho, idNoise})
	if len(probs) != 4 || best < 0 || best >= 4 {
		t.Fatalf("unexpected probs=%v best=%d", probs, best)
	}
	var sum float32
	for _, p := range probs {
		sum += p
	}
	if math.Abs(float64(sum-1.0)) > 1e-4 {
		t.Fatalf("probabilities do not sum to 1: %v (sum=%f)", probs, sum)
	}
}
