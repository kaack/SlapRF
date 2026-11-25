package gguf

import (
	"encoding/binary"
	"math"
	"runtime"
	"sync"
)

const qkK = 256

var fp16Table [65536]float32

func init() {
	for i := 0; i < 65536; i++ {
		fp16Table[i] = decodeFP16Slow(uint16(i))
	}
}

func decodeFP16Slow(h uint16) float32 {
	sign := uint32(h>>15) & 0x1
	exp := uint32(h>>10) & 0x1F
	mant := uint32(h) & 0x3FF

	switch exp {
	case 0:
		if mant == 0 {
			return math.Float32frombits(sign << 31)
		}
		// Subnormal FP16 -> normalized FP32
		e := int32(-14)
		m := mant
		for (m & 0x400) == 0 {
			m <<= 1
			e--
		}
		m &= 0x3FF
		bits := (sign << 31) | (uint32(e+127) << 23) | (m << 13)
		return math.Float32frombits(bits)
	case 31:
		bits := (sign << 31) | (0xFF << 23) | (mant << 13)
		return math.Float32frombits(bits)
	default:
		bits := (sign << 31) | ((exp + 112) << 23) | (mant << 13)
		return math.Float32frombits(bits)
	}
}

// Float32ToFP16 encodes `f` as IEEE-754 binary16 (used when constructing test GGUF tensors).
func Float32ToFP16(f float32) uint16 {
	b := math.Float32bits(f)
	sign := uint16((b >> 16) & 0x8000)
	exp := int32((b>>23)&0xFF) - 127 + 15
	mant := b & 0x7FFFFF
	if exp <= 0 {
		if exp < -10 {
			return sign
		}
		mant = (mant | 0x800000) >> uint32(1-exp)
		return sign | uint16((mant+0x1000)>>13)
	}
	if exp >= 31 {
		return sign | 0x7C00
	}
	return sign | uint16(exp<<10) | uint16((mant+0x1000)>>13)
}

func fp16At(b []byte) float32 {
	return fp16Table[binary.LittleEndian.Uint16(b)]
}

// Q8KBlock holds a 256-element 8-bit quantized activation super-block for fast K-quant dot products.
type Q8KBlock struct {
	D     float32
	QS    [qkK]int8
	BSums [qkK / 16]int16
}

// QuantizeQ8K quantizes `src` (length divisible by 256) into `dst` (`len(src)/256` blocks).
func QuantizeQ8K(dst []Q8KBlock, src []float32) {
	nb := len(src) / qkK
	for b := 0; b < nb; b++ {
		sub := src[b*qkK : (b+1)*qkK]
		maxAbs := float32(0)
		for i := 0; i < qkK; i++ {
			v := sub[i]
			if v < 0 {
				v = -v
			}
			if v > maxAbs {
				maxAbs = v
			}
		}
		blk := &dst[b]
		if maxAbs == 0 {
			*blk = Q8KBlock{}
			continue
		}
		invScale := 127.0 / maxAbs
		blk.D = maxAbs / 127.0
		for g := 0; g < 16; g++ {
			var sum int16
			base := g * 16
			for l := 0; l < 16; l++ {
				q := int32(math.RoundToEven(float64(sub[base+l] * invScale)))
				if q > 127 {
					q = 127
				} else if q < -127 {
					q = -127
				}
				qi := int8(q)
				blk.QS[base+l] = qi
				sum += int16(qi)
			}
			blk.BSums[g] = sum
		}
	}
}

func getScaleMinK4(j int, q []byte) (uint8, uint8) {
	if j < 4 {
		return q[j] & 63, q[j+4] & 63
	}
	d := (q[j+4] & 0x0F) | ((q[j-4] & 0xC0) >> 2)
	m := (q[j+4] >> 4) | ((q[j] & 0xC0) >> 2)
	return d, m
}

// DequantizeRow unpacks a single row (`nCols` elements) of `t` at `rowIdx` into `dst` (for embedding lookup & tests).
func DequantizeRow(dst []float32, t Tensor, rowIdx int) {
	nCols := t.Cols()
	rowBytes, _ := RowByteSize(t.Type, nCols)
	raw := t.Data[rowIdx*rowBytes : (rowIdx+1)*rowBytes]

	switch t.Type {
	case TypeF32:
		for i := 0; i < nCols; i++ {
			dst[i] = math.Float32frombits(binary.LittleEndian.Uint32(raw[i*4 : i*4+4]))
		}
	case TypeF16:
		for i := 0; i < nCols; i++ {
			dst[i] = fp16At(raw[i*2 : i*2+2])
		}
	case TypeQ8_0:
		nb := nCols / 32
		for b := 0; b < nb; b++ {
			blk := raw[b*34 : (b+1)*34]
			d := fp16At(blk[0:2])
			qs := blk[2:34]
			out := dst[b*32 : (b+1)*32]
			for l := 0; l < 32; l++ {
				out[l] = d * float32(int8(qs[l]))
			}
		}
	case TypeQ4_K:
		nb := nCols / qkK
		for b := 0; b < nb; b++ {
			blk := raw[b*144 : (b+1)*144]
			d := fp16At(blk[0:2])
			dmin := fp16At(blk[2:4])
			scales := blk[4:16]
			qs := blk[16:144]
			out := dst[b*qkK : (b+1)*qkK]
			qOff := 0
			yOff := 0
			for is := 0; is < 8; is += 2 {
				sc1, m1 := getScaleMinK4(is, scales)
				sc2, m2 := getScaleMinK4(is+1, scales)
				d1 := d * float32(sc1)
				min1 := dmin * float32(m1)
				d2 := d * float32(sc2)
				min2 := dmin * float32(m2)
				for l := 0; l < 32; l++ {
					out[yOff+l] = d1*float32(qs[qOff+l]&0x0F) - min1
				}
				for l := 0; l < 32; l++ {
					out[yOff+32+l] = d2*float32(qs[qOff+l]>>4) - min2
				}
				qOff += 32
				yOff += 64
			}
		}
	case TypeQ6_K:
		nb := nCols / qkK
		for b := 0; b < nb; b++ {
			blk := raw[b*210 : (b+1)*210]
			ql := blk[0:128]
			qh := blk[128:192]
			sc := blk[192:208]
			d := fp16At(blk[208:210])
			out := dst[b*qkK : (b+1)*qkK]
			qlOff := 0
			qhOff := 0
			scOff := 0
			yOff := 0
			for half := 0; half < 2; half++ {
				for l := 0; l < 32; l++ {
					is := l / 16
					q1 := int8((ql[qlOff+l]&0x0F)|(((qh[qhOff+l]>>0)&3)<<4)) - 32
					q2 := int8((ql[qlOff+l+32]&0x0F)|(((qh[qhOff+l]>>2)&3)<<4)) - 32
					q3 := int8((ql[qlOff+l]>>4)|(((qh[qhOff+l]>>4)&3)<<4)) - 32
					q4 := int8((ql[qlOff+l+32]>>4)|(((qh[qhOff+l]>>6)&3)<<4)) - 32
					out[yOff+l] = d * float32(int8(sc[scOff+is+0])) * float32(q1)
					out[yOff+l+32] = d * float32(int8(sc[scOff+is+2])) * float32(q2)
					out[yOff+l+64] = d * float32(int8(sc[scOff+is+4])) * float32(q3)
					out[yOff+l+96] = d * float32(int8(sc[scOff+is+6])) * float32(q4)
				}
				yOff += 128
				qlOff += 64
				qhOff += 32
				scOff += 8
			}
		}
	}
}

func dotRowGo(rawRow []byte, ttype GGMLType, nCols int, xFloat []float32, xQ8 []Q8KBlock) float32 {
	switch ttype {
	case TypeQ4_K:
		return dotRowQ4KGo(rawRow, nCols/qkK, xQ8)
	case TypeQ6_K:
		return dotRowQ6KGo(rawRow, nCols/qkK, xQ8)
	case TypeF32:
		var sum float32
		for i := 0; i < nCols; i++ {
			w := math.Float32frombits(binary.LittleEndian.Uint32(rawRow[i*4 : i*4+4]))
			sum += w * xFloat[i]
		}
		return sum
	case TypeF16:
		var sum float32
		for i := 0; i < nCols; i++ {
			sum += fp16At(rawRow[i*2:i*2+2]) * xFloat[i]
		}
		return sum
	case TypeQ8_0:
		nb := nCols / 32
		var sum float32
		for b := 0; b < nb; b++ {
			blk := rawRow[b*34 : (b+1)*34]
			d := fp16At(blk[0:2])
			qs := blk[2:34]
			xb := xFloat[b*32 : (b+1)*32]
			var s float32
			for l := 0; l < 32; l++ {
				s += float32(int8(qs[l])) * xb[l]
			}
			sum += d * s
		}
		return sum
	default:
		return 0
	}
}

func dotRowQ4KGo(rawRow []byte, nb int, xQ8 []Q8KBlock) float32 {
	var total float32
	for b := 0; b < nb; b++ {
		blk := rawRow[b*144 : (b+1)*144]
		d := fp16At(blk[0:2])
		dmin := fp16At(blk[2:4])
		scales := blk[4:16]
		qs := blk[16:144]
		xb := &xQ8[b]

		var sumQ float32
		var sumM int32
		qOff := 0
		xOff := 0
		for is := 0; is < 8; is += 2 {
			sc1, m1 := getScaleMinK4(is, scales)
			sc2, m2 := getScaleMinK4(is+1, scales)

			var s1, s2 int32
			qSub := qs[qOff : qOff+32]
			x1 := xb.QS[xOff : xOff+32]
			x2 := xb.QS[xOff+32 : xOff+64]
			for l := 0; l < 32; l++ {
				qb := qSub[l]
				s1 += int32(qb&0x0F) * int32(x1[l])
				s2 += int32(qb>>4) * int32(x2[l])
			}
			sumQ += float32(int32(sc1)*s1 + int32(sc2)*s2)
			bs1 := int32(xb.BSums[is*2]) + int32(xb.BSums[is*2+1])
			bs2 := int32(xb.BSums[(is+1)*2]) + int32(xb.BSums[(is+1)*2+1])
			sumM += int32(m1)*bs1 + int32(m2)*bs2

			qOff += 32
			xOff += 64
		}
		total += xb.D * (d*sumQ - dmin*float32(sumM))
	}
	return total
}

func dotRowQ6KGo(rawRow []byte, nb int, xQ8 []Q8KBlock) float32 {
	var total float32
	for b := 0; b < nb; b++ {
		blk := rawRow[b*210 : (b+1)*210]
		ql := blk[0:128]
		qh := blk[128:192]
		sc := blk[192:208]
		d := fp16At(blk[208:210])
		xb := &xQ8[b]

		var blockSum int32
		for half := 0; half < 2; half++ {
			qlSub := ql[half*64 : (half+1)*64]
			qhSub := qh[half*32 : (half+1)*32]
			scBase := half * 8
			xBase := half * 128
			bsBase := half * 8

			for half16 := 0; half16 < 2; half16++ {
				lStart := half16 * 16
				var s1, s2, s3, s4 int32
				for l := lStart; l < lStart+16; l++ {
					ql0 := qlSub[l]
					ql1 := qlSub[l+32]
					qhb := qhSub[l]
					u1 := int32((ql0 & 0x0F) | (((qhb >> 0) & 3) << 4))
					u2 := int32((ql1 & 0x0F) | (((qhb >> 2) & 3) << 4))
					u3 := int32((ql0 >> 4) | (((qhb >> 4) & 3) << 4))
					u4 := int32((ql1 >> 4) | (((qhb >> 6) & 3) << 4))
					s1 += u1 * int32(xb.QS[xBase+l])
					s2 += u2 * int32(xb.QS[xBase+32+l])
					s3 += u3 * int32(xb.QS[xBase+64+l])
					s4 += u4 * int32(xb.QS[xBase+96+l])
				}
				g1 := bsBase + half16
				g2 := bsBase + 2 + half16
				g3 := bsBase + 4 + half16
				g4 := bsBase + 6 + half16
				s1 -= 32 * int32(xb.BSums[g1])
				s2 -= 32 * int32(xb.BSums[g2])
				s3 -= 32 * int32(xb.BSums[g3])
				s4 -= 32 * int32(xb.BSums[g4])

				blockSum += int32(int8(sc[scBase+half16+0]))*s1 +
					int32(int8(sc[scBase+half16+2]))*s2 +
					int32(int8(sc[scBase+half16+4]))*s3 +
					int32(int8(sc[scBase+half16+6]))*s4
			}
		}
		total += d * xb.D * float32(blockSum)
	}
	return total
}

// MatVec computes `dst = W * x` across CPU worker goroutines, where `W` has shape `[nCols, nRows]` in GGUF.
func MatVec(dst []float32, w Tensor, xFloat []float32, xQ8 []Q8KBlock, workers int) {
	nRows := w.Rows()
	nCols := w.Cols()
	rowBytes, _ := RowByteSize(w.Type, nCols)
	if workers <= 1 || nRows < 64 {
		matVecRange(dst, w.Data, w.Type, nCols, rowBytes, 0, nRows, xFloat, xQ8)
		return
	}
	if workers > nRows/32 {
		workers = nRows / 32
	}
	var wg sync.WaitGroup
	chunk := (nRows + workers - 1) / workers
	for wi := 0; wi < workers; wi++ {
		r0 := wi * chunk
		if r0 >= nRows {
			break
		}
		r1 := r0 + chunk
		if r1 > nRows {
			r1 = nRows
		}
		wg.Add(1)
		go func(start, end int) {
			defer wg.Done()
			matVecRange(dst, w.Data, w.Type, nCols, rowBytes, start, end, xFloat, xQ8)
		}(r0, r1)
	}
	wg.Wait()
}

// MatBatch computes `dst[t * nRows + r] = dot(W[r], xBatch[t])` for `nTokens` vectors simultaneously,
// amortizing weight cache lines across all prompt tokens in L1/L2 cache during prefill!
func MatBatch(dst []float32, w Tensor, nTokens int, xFloats []float32, xQ8Batch []Q8KBlock, workers int) {
	if nTokens == 1 {
		MatVec(dst, w, xFloats, xQ8Batch, workers)
		return
	}
	nRows := w.Rows()
	nCols := w.Cols()
	rowBytes, _ := RowByteSize(w.Type, nCols)
	if workers <= 0 {
		workers = runtime.GOMAXPROCS(0)
	}
	if workers <= 1 || nRows < 32 {
		matBatchRange(dst, w.Data, w.Type, nCols, nRows, rowBytes, 0, nRows, nTokens, xFloats, xQ8Batch)
		return
	}
	if workers > nRows/16 {
		workers = nRows / 16
	}
	var wg sync.WaitGroup
	chunk := (nRows + workers - 1) / workers
	for wi := 0; wi < workers; wi++ {
		r0 := wi * chunk
		if r0 >= nRows {
			break
		}
		r1 := r0 + chunk
		if r1 > nRows {
			r1 = nRows
		}
		wg.Add(1)
		go func(start, end int) {
			defer wg.Done()
			matBatchRange(dst, w.Data, w.Type, nCols, nRows, rowBytes, start, end, nTokens, xFloats, xQ8Batch)
		}(r0, r1)
	}
	wg.Wait()
}

// DotSelectedRows computes dot products ONLY against the requested `rowIndices` of `w` (used at
// grammar-constrained LM head slots to skip >99.9% of `151,936`-row vocabulary evaluations!).
func DotSelectedRows(dst []float32, w Tensor, rowIndices []int, xFloat []float32, xQ8 []Q8KBlock) {
	nCols := w.Cols()
	rowBytes, _ := RowByteSize(w.Type, nCols)
	for i, r := range rowIndices {
		raw := w.Data[r*rowBytes : (r+1)*rowBytes]
		dst[i] = dotSingleRow(raw, w.Type, nCols, xFloat, xQ8)
	}
}
