package gguf

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
)

// GGMLType enumerates tensor element storage formats in GGUF v2/v3 files.
type GGMLType uint32

const (
	TypeF32  GGMLType = 0
	TypeF16  GGMLType = 1
	TypeQ4_0 GGMLType = 2
	TypeQ8_0 GGMLType = 8
	TypeQ4_K GGMLType = 12
	TypeQ5_K GGMLType = 13
	TypeQ6_K GGMLType = 14
)

// RowByteSize returns the exact byte length of a single contiguous row of `nCols` elements.
func RowByteSize(t GGMLType, nCols int) (int, error) {
	switch t {
	case TypeF32:
		return nCols * 4, nil
	case TypeF16:
		return nCols * 2, nil
	case TypeQ8_0:
		if nCols%32 != 0 {
			return 0, fmt.Errorf("Q8_0 row length %d must be divisible by 32", nCols)
		}
		return (nCols / 32) * 34, nil
	case TypeQ4_K:
		if nCols%256 != 0 {
			return 0, fmt.Errorf("Q4_K row length %d must be divisible by 256", nCols)
		}
		return (nCols / 256) * 144, nil
	case TypeQ6_K:
		if nCols%256 != 0 {
			return 0, fmt.Errorf("Q6_K row length %d must be divisible by 256", nCols)
		}
		return (nCols / 256) * 210, nil
	default:
		return 0, fmt.Errorf("unsupported ggml tensor type %d", t)
	}
}

// Tensor holds metadata and a direct zero-copy slice into the mapped GGUF data section.
type Tensor struct {
	Name   string
	Dims   []uint64 // dims[0] = inner contiguous dimension (columns), dims[1] = outer rows
	Type   GGMLType
	Offset uint64
	Data   []byte
}

// Rows returns the outer row count (`dims[1]`, or `1` for 1D norm vectors).
func (t Tensor) Rows() int {
	if len(t.Dims) < 2 {
		return 1
	}
	r := 1
	for i := 1; i < len(t.Dims); i++ {
		r *= int(t.Dims[i])
	}
	return r
}

// Cols returns the contiguous inner element count (`dims[0]`).
func (t Tensor) Cols() int {
	if len(t.Dims) == 0 {
		return 0
	}
	return int(t.Dims[0])
}

// File represents an opened GGUF model file (either memory-mapped from disk or backed by an in-memory buffer).
type File struct {
	mapped   *mappedFile
	raw      []byte
	Metadata map[string]any
	Tensors  map[string]Tensor
}

// Open opens and parses a GGUF v2/v3 file from disk using zero-copy `mmap` where supported.
func Open(path string) (*File, error) {
	mf, err := openMappedFile(path)
	if err != nil {
		return nil, err
	}
	f, err := ParseBytes(mf.Bytes())
	if err != nil {
		_ = mf.Close()
		return nil, err
	}
	f.mapped = mf
	return f, nil
}

// Close unmaps and closes the underlying GGUF file, immediately freeing OS page mappings.
func (f *File) Close() error {
	if f == nil {
		return nil
	}
	f.raw = nil
	f.Tensors = nil
	if f.mapped != nil {
		err := f.mapped.Close()
		f.mapped = nil
		return err
	}
	return nil
}

// ParseBytes parses a GGUF v2/v3 header and binds zero-copy slices to all tensors.
func ParseBytes(data []byte) (*File, error) {
	if len(data) < 24 {
		return nil, errors.New("gguf buffer too short")
	}
	if string(data[:4]) != "GGUF" {
		return nil, fmt.Errorf("invalid GGUF magic %q", string(data[:4]))
	}
	ver := binary.LittleEndian.Uint32(data[4:8])
	if ver < 2 || ver > 3 {
		return nil, fmt.Errorf("unsupported GGUF version %d", ver)
	}
	nTensors := binary.LittleEndian.Uint64(data[8:16])
	nKV := binary.LittleEndian.Uint64(data[16:24])
	if nTensors > 100_000 || nKV > 100_000 {
		return nil, fmt.Errorf("unreasonable GGUF counts (tensors=%d, kv=%d)", nTensors, nKV)
	}

	r := &byteReader{b: data, pos: 24}
	meta := make(map[string]any, int(nKV))
	for i := uint64(0); i < nKV; i++ {
		key, err := r.readString()
		if err != nil {
			return nil, fmt.Errorf("kv[%d] key: %w", i, err)
		}
		vtype, err := r.readU32()
		if err != nil {
			return nil, fmt.Errorf("kv[%q] type: %w", key, err)
		}
		val, err := r.readValue(vtype)
		if err != nil {
			return nil, fmt.Errorf("kv[%q] val: %w", key, err)
		}
		meta[key] = val
	}

	tensors := make(map[string]Tensor, int(nTensors))
	rawList := make([]Tensor, 0, int(nTensors))
	for i := uint64(0); i < nTensors; i++ {
		name, err := r.readString()
		if err != nil {
			return nil, fmt.Errorf("tensor[%d] name: %w", i, err)
		}
		nDims, err := r.readU32()
		if err != nil || nDims == 0 || nDims > 8 {
			return nil, fmt.Errorf("tensor %q invalid ndims=%d", name, nDims)
		}
		dims := make([]uint64, nDims)
		for d := uint32(0); d < nDims; d++ {
			dim, dErr := r.readU64()
			if dErr != nil {
				return nil, dErr
			}
			dims[d] = dim
		}
		ttypeU32, err := r.readU32()
		if err != nil {
			return nil, err
		}
		off, err := r.readU64()
		if err != nil {
			return nil, err
		}
		rawList = append(rawList, Tensor{
			Name:   name,
			Dims:   dims,
			Type:   GGMLType(ttypeU32),
			Offset: off,
		})
	}

	align := uint64(32)
	if a, ok := metaUint64(meta, "general.alignment"); ok && a > 0 {
		align = a
	}
	dataStart := alignUp(uint64(r.pos), align)
	if dataStart > uint64(len(data)) {
		return nil, errors.New("gguf data section offset exceeds file size")
	}

	for _, t := range rawList {
		rowBytes, err := RowByteSize(t.Type, t.Cols())
		if err != nil {
			return nil, fmt.Errorf("tensor %q: %w", t.Name, err)
		}
		totalBytes := uint64(rowBytes) * uint64(t.Rows())
		start := dataStart + t.Offset
		end := start + totalBytes
		if end > uint64(len(data)) || end < start {
			return nil, fmt.Errorf("tensor %q range [%d:%d] out of bounds (%d)", t.Name, start, end, len(data))
		}
		t.Data = data[start:end]
		tensors[t.Name] = t
	}

	return &File{
		raw:      data,
		Metadata: meta,
		Tensors:  tensors,
	}, nil
}

func alignUp(v, align uint64) uint64 {
	if align <= 1 {
		return v
	}
	rem := v % align
	if rem == 0 {
		return v
	}
	return v + (align - rem)
}

func metaUint64(m map[string]any, key string) (uint64, bool) {
	v, ok := m[key]
	if !ok {
		return 0, false
	}
	switch x := v.(type) {
	case uint64:
		return x, true
	case uint32:
		return uint64(x), true
	case int32:
		if x >= 0 {
			return uint64(x), true
		}
	case int64:
		if x >= 0 {
			return uint64(x), true
		}
	case uint16:
		return uint64(x), true
	case uint8:
		return uint64(x), true
	}
	return 0, false
}

func metaFloat32(m map[string]any, key string, def float32) float32 {
	v, ok := m[key]
	if !ok {
		return def
	}
	switch x := v.(type) {
	case float32:
		return x
	case float64:
		return float32(x)
	}
	return def
}

func metaStringSlice(m map[string]any, key string) []string {
	v, ok := m[key]
	if !ok {
		return nil
	}
	if s, ok := v.([]string); ok {
		return s
	}
	return nil
}

type byteReader struct {
	b   []byte
	pos int
}

func (r *byteReader) need(n int) error {
	if n < 0 || r.pos+n > len(r.b) {
		return errors.New("unexpected EOF in GGUF header")
	}
	return nil
}

func (r *byteReader) readU8() (uint8, error) {
	if err := r.need(1); err != nil {
		return 0, err
	}
	v := r.b[r.pos]
	r.pos++
	return v, nil
}

func (r *byteReader) readU16() (uint16, error) {
	if err := r.need(2); err != nil {
		return 0, err
	}
	v := binary.LittleEndian.Uint16(r.b[r.pos : r.pos+2])
	r.pos += 2
	return v, nil
}

func (r *byteReader) readU32() (uint32, error) {
	if err := r.need(4); err != nil {
		return 0, err
	}
	v := binary.LittleEndian.Uint32(r.b[r.pos : r.pos+4])
	r.pos += 4
	return v, nil
}

func (r *byteReader) readU64() (uint64, error) {
	if err := r.need(8); err != nil {
		return 0, err
	}
	v := binary.LittleEndian.Uint64(r.b[r.pos : r.pos+8])
	r.pos += 8
	return v, nil
}

func (r *byteReader) readString() (string, error) {
	ln, err := r.readU64()
	if err != nil {
		return "", err
	}
	if ln > 64<<20 {
		return "", fmt.Errorf("gguf string too large (%d)", ln)
	}
	if err := r.need(int(ln)); err != nil {
		return "", err
	}
	s := string(r.b[r.pos : r.pos+int(ln)])
	r.pos += int(ln)
	return s, nil
}

func (r *byteReader) readValue(vtype uint32) (any, error) {
	switch vtype {
	case 0: // UINT8
		return r.readU8()
	case 1: // INT8
		v, err := r.readU8()
		return int8(v), err
	case 2: // UINT16
		return r.readU16()
	case 3: // INT16
		v, err := r.readU16()
		return int16(v), err
	case 4: // UINT32
		return r.readU32()
	case 5: // INT32
		v, err := r.readU32()
		return int32(v), err
	case 6: // FLOAT32
		v, err := r.readU32()
		return math.Float32frombits(v), err
	case 7: // BOOL
		v, err := r.readU8()
		return v != 0, err
	case 8: // STRING
		return r.readString()
	case 9: // ARRAY
		elemType, err := r.readU32()
		if err != nil {
			return nil, err
		}
		length, err := r.readU64()
		if err != nil {
			return nil, err
		}
		if length > 2_000_000 {
			return nil, fmt.Errorf("gguf array length %d too large", length)
		}
		if elemType == 8 {
			out := make([]string, length)
			for i := uint64(0); i < length; i++ {
				s, sErr := r.readString()
				if sErr != nil {
					return nil, sErr
				}
				out[i] = s
			}
			return out, nil
		}
		if elemType == 5 {
			out := make([]int32, length)
			if err := r.need(int(length) * 4); err != nil {
				return nil, err
			}
			for i := uint64(0); i < length; i++ {
				out[i] = int32(binary.LittleEndian.Uint32(r.b[r.pos : r.pos+4]))
				r.pos += 4
			}
			return out, nil
		}
		if elemType == 6 {
			out := make([]float32, length)
			if err := r.need(int(length) * 4); err != nil {
				return nil, err
			}
			for i := uint64(0); i < length; i++ {
				out[i] = math.Float32frombits(binary.LittleEndian.Uint32(r.b[r.pos : r.pos+4]))
				r.pos += 4
			}
			return out, nil
		}
		out := make([]any, length)
		for i := uint64(0); i < length; i++ {
			el, elErr := r.readValue(elemType)
			if elErr != nil {
				return nil, elErr
			}
			out[i] = el
		}
		return out, nil
	case 10: // UINT64
		return r.readU64()
	case 11: // INT64
		v, err := r.readU64()
		return int64(v), err
	case 12: // FLOAT64
		v, err := r.readU64()
		return math.Float64frombits(v), err
	default:
		return nil, fmt.Errorf("unknown GGUF metadata value type %d", vtype)
	}
}
