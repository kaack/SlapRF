//go:build !cgo || (!arm64 && !amd64)

package gguf

func dotSingleRow(rawRow []byte, ttype GGMLType, nCols int, xFloat []float32, xQ8 []Q8KBlock) float32 {
	return dotRowGo(rawRow, ttype, nCols, xFloat, xQ8)
}

func matVecRange(dst []float32, wData []byte, ttype GGMLType, nCols, rowBytes, startRow, endRow int, xFloat []float32, xQ8 []Q8KBlock) {
	for r := startRow; r < endRow; r++ {
		raw := wData[r*rowBytes : (r+1)*rowBytes]
		dst[r] = dotRowGo(raw, ttype, nCols, xFloat, xQ8)
	}
}

func matBatchRange(dst []float32, wData []byte, ttype GGMLType, nCols, nRows, rowBytes, startRow, endRow, nTokens int, xFloats []float32, xQ8Batch []Q8KBlock) {
	nb := nCols / qkK
	for r := startRow; r < endRow; r++ {
		raw := wData[r*rowBytes : (r+1)*rowBytes]
		for t := 0; t < nTokens; t++ {
			var xF []float32
			if len(xFloats) >= (t+1)*nCols {
				xF = xFloats[t*nCols : (t+1)*nCols]
			}
			var xQ []Q8KBlock
			if nb > 0 && len(xQ8Batch) >= (t+1)*nb {
				xQ = xQ8Batch[t*nb : (t+1)*nb]
			}
			dst[t*nRows+r] = dotRowGo(raw, ttype, nCols, xF, xQ)
		}
	}
}
