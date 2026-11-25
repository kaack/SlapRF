package tracestore

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"slaprf/internal/domain"
)

const (
	magicHeader = "SLRFTR01"

	recSlotMap  uint8 = 0x01
	recFullTs   uint8 = 0x02
	recDeltaTs  uint8 = 0x03

	maxActiveSlotsPerRecord = 16
	defaultMaxTotalBytes    = 256 << 20 // 256 MB (~28 hours of 4-timer telemetry)
)

// Sample is a compact multi-slot raw RSSI observation for one gate timer inside a session trace.
type Sample struct {
	GateID        uint8     `json:"gateId"`
	SeqNum        uint32    `json:"seqNum"`
	TimestampUs   uint64    `json:"timestampUs"`
	NoiseFloorDbm float32   `json:"noiseFloorDbm"`
	SlotIndices   []uint8   `json:"slotIndices"` // 1-based PilotSlot.SlotIndex values
	RSSIDbm       []float32 `json:"rssiDbm"`     // raw RSSI corresponding to SlotIndices
}

// Summary describes the stored size and duration of a session's `.rfbin` trace.
type Summary struct {
	SessionID   string  `json:"sessionId"`
	SampleCount int     `json:"sampleCount"`
	DurationSec float64 `json:"durationSec"`
	SizeBytes   int64   `json:"sizeBytes"`
}

// Store abstracts append-only `.rfbin` session trace persistence across native disk (`FileStore`)
// and pure-browser WASM / unit tests (`MemoryStore`).
type Store interface {
	Append(sessionID string, sample Sample)
	FlushSession(sessionID string)
	SealSession(sessionID string) Summary
	ReadSession(sessionID string) ([]Sample, error)
	ReadRawBytes(sessionID string) ([]byte, error)
	WriteRawBytes(sessionID string, raw []byte) (Summary, error)
	DeleteSession(sessionID string) error
	TotalBytes() int64
	ListSessionIDs() []string
	Close() error
}

func sanitizeSessionID(sessionID string) string {
	clean := strings.TrimSpace(sessionID)
	if clean == "" {
		return ""
	}
	var b strings.Builder
	b.Grow(len(clean))
	for i := 0; i < len(clean); i++ {
		c := clean[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' {
			b.WriteByte(c)
		} else {
			b.WriteByte('_')
		}
	}
	return b.String()
}

func quantizeRssiQ20(dbm float32) int16 {
	if math.IsNaN(float64(dbm)) || math.IsInf(float64(dbm), 0) {
		return -2540 // -127.0 dBm
	}
	v := math.Round(float64(dbm) * 20.0)
	if v < -32000 {
		v = -32000
	} else if v > 32000 {
		v = 32000
	}
	return int16(v)
}

func dequantizeRssiQ20(q int16) float32 {
	return float32(q) / 20.0
}

func slotsEqual(a, b []uint8) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// streamEncoder maintains stateful slot-map and delta-timestamp compression for one `.rfbin` stream.
type streamEncoder struct {
	wroteHeader bool
	curSlots    []uint8
	hasPrevTs   bool
	prevTsUs    uint64
	sampleCount int
	firstTsUs   uint64
	lastTsUs    uint64
	scratch     [64]byte
}

func (e *streamEncoder) encodeSample(w io.Writer, s Sample) error {
	if len(s.SlotIndices) == 0 || len(s.SlotIndices) != len(s.RSSIDbm) {
		return nil
	}
	count := len(s.SlotIndices)
	if count > maxActiveSlotsPerRecord {
		count = maxActiveSlotsPerRecord
	}
	slots := s.SlotIndices[:count]
	rssis := s.RSSIDbm[:count]

	if !e.wroteHeader {
		if _, err := w.Write([]byte(magicHeader)); err != nil {
			return err
		}
		e.wroteHeader = true
	}

	if !slotsEqual(e.curSlots, slots) {
		e.scratch[0] = recSlotMap
		e.scratch[1] = uint8(count)
		copy(e.scratch[2:2+count], slots)
		if _, err := w.Write(e.scratch[:2+count]); err != nil {
			return err
		}
		e.curSlots = append(e.curSlots[:0], slots...)
	}

	useDelta := false
	var dt100 uint16
	if e.hasPrevTs && s.TimestampUs >= e.prevTsUs {
		diffUs := s.TimestampUs - e.prevTsUs
		if diffUs <= 650_000_000 { // <= 6.5s fits in uint16 units of 100 us? Wait: 65535 * 100 us = 6_553_500 us (~6.55s)
			if diffUs <= 6_553_500 {
				useDelta = true
				dt100 = uint16((diffUs + 50) / 100)
			}
		}
	}

	if useDelta {
		e.scratch[0] = recDeltaTs
		e.scratch[1] = s.GateID
		e.scratch[2] = uint8(s.SeqNum)
		binary.LittleEndian.PutUint16(e.scratch[3:5], dt100)
		nfInt := int(math.Round(float64(s.NoiseFloorDbm)))
		if nfInt < -128 {
			nfInt = -128
		} else if nfInt > 127 {
			nfInt = 127
		}
		e.scratch[5] = byte(int8(nfInt))
		off := 6
		for i := 0; i < count; i++ {
			binary.LittleEndian.PutUint16(e.scratch[off:off+2], uint16(quantizeRssiQ20(rssis[i])))
			off += 2
		}
		if _, err := w.Write(e.scratch[:off]); err != nil {
			return err
		}
		// Advance prevTsUs by quantized delta so cumulative drift stays zero.
		e.prevTsUs += uint64(dt100) * 100
	} else {
		e.scratch[0] = recFullTs
		e.scratch[1] = s.GateID
		e.scratch[2] = uint8(s.SeqNum)
		binary.LittleEndian.PutUint64(e.scratch[3:11], s.TimestampUs)
		binary.LittleEndian.PutUint16(e.scratch[11:13], uint16(quantizeRssiQ20(s.NoiseFloorDbm)))
		off := 13
		for i := 0; i < count; i++ {
			binary.LittleEndian.PutUint16(e.scratch[off:off+2], uint16(quantizeRssiQ20(rssis[i])))
			off += 2
		}
		if _, err := w.Write(e.scratch[:off]); err != nil {
			return err
		}
		e.prevTsUs = s.TimestampUs
		e.hasPrevTs = true
	}

	if e.sampleCount == 0 || s.TimestampUs < e.firstTsUs {
		e.firstTsUs = s.TimestampUs
	}
	if s.TimestampUs > e.lastTsUs {
		e.lastTsUs = s.TimestampUs
	}
	e.sampleCount++
	return nil
}

// EncodeSamples serializes a slice of `Sample` records into `.rfbin` format.
func EncodeSamples(samples []Sample) ([]byte, error) {
	var buf bytes.Buffer
	var enc streamEncoder
	for _, s := range samples {
		if err := enc.encodeSample(&buf, s); err != nil {
			return nil, err
		}
	}
	return buf.Bytes(), nil
}

// DecodeSamples parses `.rfbin` bytes into `Sample` records, tolerating a truncated trailing
// record if power was lost mid-write.
func DecodeSamples(raw []byte) ([]Sample, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	if len(raw) < len(magicHeader) || string(raw[:len(magicHeader)]) != magicHeader {
		return nil, errors.New("invalid .rfbin magic header")
	}

	r := bytes.NewReader(raw[len(magicHeader):])
	var curSlots []uint8
	var prevTsUs uint64
	var seqEpoch map[uint8]uint32
	prevSeqLo := make(map[uint8]uint8)
	seenGate := make(map[uint8]bool)
	seqEpoch = make(map[uint8]uint32)

	out := make([]Sample, 0, len(raw)/10)
	rssiArena := make([]float32, 0, len(raw)/8+16)
	var hdr [32]byte

	for {
		recType, err := r.ReadByte()
		if err == io.EOF {
			break
		}
		if err != nil {
			return out, nil
		}

		switch recType {
		case recSlotMap:
			cntByte, err := r.ReadByte()
			if err != nil {
				return out, nil
			}
			cnt := int(cntByte)
			if cnt == 0 || cnt > maxActiveSlotsPerRecord {
				return out, fmt.Errorf("invalid slot count %d in .rfbin", cnt)
			}
			slots := make([]uint8, cnt)
			if _, err := io.ReadFull(r, slots); err != nil {
				return out, nil
			}
			curSlots = slots

		case recFullTs:
			if len(curSlots) == 0 {
				return out, errors.New(".rfbin sample before slot map")
			}
			need := 12 + 2*len(curSlots)
			var buf []byte
			if need <= len(hdr) {
				buf = hdr[:need]
			} else {
				buf = make([]byte, need)
			}
			if _, err := io.ReadFull(r, buf); err != nil {
				return out, nil
			}
			gateID := buf[0]
			seqLo := buf[1]
			tsUs := binary.LittleEndian.Uint64(buf[2:10])
			nf := dequantizeRssiQ20(int16(binary.LittleEndian.Uint16(buf[10:12])))
			aStart := len(rssiArena)
			off := 12
			for range curSlots {
				rssiArena = append(rssiArena, dequantizeRssiQ20(int16(binary.LittleEndian.Uint16(buf[off:off+2]))))
				off += 2
			}
			rssis := rssiArena[aStart:len(rssiArena):len(rssiArena)]
			prevTsUs = tsUs
			if seenGate[gateID] && seqLo < prevSeqLo[gateID] {
				seqEpoch[gateID] += 256
			}
			seenGate[gateID] = true
			prevSeqLo[gateID] = seqLo
			slotsView := curSlots[:len(curSlots):len(curSlots)]
			out = append(out, Sample{
				GateID:        gateID,
				SeqNum:        seqEpoch[gateID] + uint32(seqLo),
				TimestampUs:   tsUs,
				NoiseFloorDbm: nf,
				SlotIndices:   slotsView,
				RSSIDbm:       rssis,
			})

		case recDeltaTs:
			if len(curSlots) == 0 {
				return out, errors.New(".rfbin delta sample before slot map")
			}
			need := 5 + 2*len(curSlots)
			var buf []byte
			if need <= len(hdr) {
				buf = hdr[:need]
			} else {
				buf = make([]byte, need)
			}
			if _, err := io.ReadFull(r, buf); err != nil {
				return out, nil
			}
			gateID := buf[0]
			seqLo := buf[1]
			dt100 := binary.LittleEndian.Uint16(buf[2:4])
			nf := float32(int8(buf[4]))
			aStart := len(rssiArena)
			off := 5
			for range curSlots {
				rssiArena = append(rssiArena, dequantizeRssiQ20(int16(binary.LittleEndian.Uint16(buf[off:off+2]))))
				off += 2
			}
			rssis := rssiArena[aStart:len(rssiArena):len(rssiArena)]
			tsUs := prevTsUs + uint64(dt100)*100
			prevTsUs = tsUs
			if seenGate[gateID] && seqLo < prevSeqLo[gateID] {
				seqEpoch[gateID] += 256
			}
			seenGate[gateID] = true
			prevSeqLo[gateID] = seqLo
			slotsView := curSlots[:len(curSlots):len(curSlots)]
			out = append(out, Sample{
				GateID:        gateID,
				SeqNum:        seqEpoch[gateID] + uint32(seqLo),
				TimestampUs:   tsUs,
				NoiseFloorDbm: nf,
				SlotIndices:   slotsView,
				RSSIDbm:       rssis,
			})

		default:
			return out, fmt.Errorf("unknown .rfbin record type 0x%02x", recType)
		}
	}
	return out, nil
}

// ToTelemetryFrames expands compact `Sample` records back into full `domain.TimerTelemetryFrame`
// items suitable for replaying historical sessions in `AppStore` / `PilotRssiChart`.
func ToTelemetryFrames(samples []Sample) []domain.TimerTelemetryFrame {
	out := make([]domain.TimerTelemetryFrame, len(samples))
	for i, s := range samples {
		var rssi [domain.MaxPilotPoolSize]float32
		for j := range rssi {
			rssi[j] = -127.0
		}
		for k, slotIdx := range s.SlotIndices {
			if slotIdx >= 1 && int(slotIdx) <= domain.MaxPilotPoolSize && k < len(s.RSSIDbm) {
				rssi[slotIdx-1] = s.RSSIDbm[k]
			}
		}
		out[i] = domain.TimerTelemetryFrame{
			TimerID:       s.GateID,
			SeqNum:        s.SeqNum,
			TimestampUs:   s.TimestampUs,
			RSSI:          rssi,
			BatteryMv:     4100,
			NoiseFloorDbm: s.NoiseFloorDbm,
		}
	}
	return out
}

// SummarizeSamples computes sample count and duration in seconds from decoded samples.
func SummarizeSamples(sessionID string, samples []Sample, sizeBytes int64) Summary {
	sum := Summary{
		SessionID:   sessionID,
		SampleCount: len(samples),
		SizeBytes:   sizeBytes,
	}
	if len(samples) >= 2 {
		minTs := samples[0].TimestampUs
		maxTs := samples[0].TimestampUs
		for _, s := range samples[1:] {
			if s.TimestampUs < minTs {
				minTs = s.TimestampUs
			}
			if s.TimestampUs > maxTs {
				maxTs = s.TimestampUs
			}
		}
		if maxTs > minTs {
			sum.DurationSec = float64(maxTs-minTs) / 1e6
		}
	}
	return sum
}

// ---------------------------------------------------------------------------
// FileStore: Non-blocking buffered background `.rfbin` writer on native OSes
// ---------------------------------------------------------------------------

type writeCmdKind uint8

const (
	cmdAppend writeCmdKind = iota + 1
	cmdFlush
	cmdSeal
)

type writeCmd struct {
	kind      writeCmdKind
	sessionID string
	sample    Sample
	reply     chan Summary
}

type openTraceFile struct {
	path string
	file *os.File
	buf  *bufio.Writer
	enc  streamEncoder
}

// FileStore persists `.rfbin` files under `dir` using a dedicated background writer goroutine so
// high-rate BLE/USB telemetry ingestion never touches the filesystem synchronously.
type FileStore struct {
	dir      string
	cmdCh    chan writeCmd
	stopCh   chan struct{}
	doneCh   chan struct{}
	stopOnce sync.Once
	ioMu     sync.Mutex // coordinates Read/Delete with background writer flushes
}

// NewFileStore opens or creates `dir` and launches the background buffered writer goroutine.
func NewFileStore(dir string) (*FileStore, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	fs := &FileStore{
		dir:    dir,
		cmdCh:  make(chan writeCmd, 16384),
		stopCh: make(chan struct{}),
		doneCh: make(chan struct{}),
	}
	go fs.loop()
	return fs, nil
}

func (f *FileStore) pathFor(sessionID string) string {
	id := sanitizeSessionID(sessionID)
	if id == "" {
		return ""
	}
	return filepath.Join(f.dir, id+".rfbin")
}

func (f *FileStore) Append(sessionID string, sample Sample) {
	if sessionID == "" || len(sample.SlotIndices) == 0 {
		return
	}
	select {
	case f.cmdCh <- writeCmd{kind: cmdAppend, sessionID: sessionID, sample: sample}:
	default:
		// Never stall live timing if disk is wedged.
	}
}

func (f *FileStore) FlushSession(sessionID string) {
	if sessionID == "" {
		return
	}
	reply := make(chan Summary, 1)
	select {
	case f.cmdCh <- writeCmd{kind: cmdFlush, sessionID: sessionID, reply: reply}:
		select {
		case <-reply:
		case <-f.doneCh:
		}
	case <-f.doneCh:
	}
}

func (f *FileStore) SealSession(sessionID string) Summary {
	if sessionID == "" {
		return Summary{}
	}
	reply := make(chan Summary, 1)
	select {
	case f.cmdCh <- writeCmd{kind: cmdSeal, sessionID: sessionID, reply: reply}:
		select {
		case sum := <-reply:
			return sum
		case <-f.doneCh:
			return Summary{SessionID: sessionID}
		}
	case <-f.doneCh:
		return Summary{SessionID: sessionID}
	}
}

func (f *FileStore) ReadRawBytes(sessionID string) ([]byte, error) {
	f.FlushSession(sessionID)
	p := f.pathFor(sessionID)
	if p == "" {
		return nil, os.ErrNotExist
	}
	f.ioMu.Lock()
	defer f.ioMu.Unlock()
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return b, err
}

func (f *FileStore) ReadSession(sessionID string) ([]Sample, error) {
	raw, err := f.ReadRawBytes(sessionID)
	if err != nil || len(raw) == 0 {
		return nil, err
	}
	return DecodeSamples(raw)
}

func (f *FileStore) WriteRawBytes(sessionID string, raw []byte) (Summary, error) {
	_ = f.SealSession(sessionID)
	p := f.pathFor(sessionID)
	if p == "" {
		return Summary{}, errors.New("empty sessionId")
	}
	samples, err := DecodeSamples(raw)
	if err != nil {
		return Summary{}, err
	}
	f.ioMu.Lock()
	err = os.WriteFile(p, raw, 0o644)
	f.ioMu.Unlock()
	if err != nil {
		return Summary{}, err
	}
	return SummarizeSamples(sessionID, samples, int64(len(raw))), nil
}

func (f *FileStore) DeleteSession(sessionID string) error {
	_ = f.SealSession(sessionID)
	p := f.pathFor(sessionID)
	if p == "" {
		return nil
	}
	f.ioMu.Lock()
	defer f.ioMu.Unlock()
	err := os.Remove(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (f *FileStore) TotalBytes() int64 {
	f.ioMu.Lock()
	defer f.ioMu.Unlock()
	entries, err := os.ReadDir(f.dir)
	if err != nil {
		return 0
	}
	var total int64
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".rfbin") {
			continue
		}
		if info, err := e.Info(); err == nil {
			total += info.Size()
		}
	}
	return total
}

func (f *FileStore) ListSessionIDs() []string {
	f.ioMu.Lock()
	defer f.ioMu.Unlock()
	entries, err := os.ReadDir(f.dir)
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".rfbin") {
			continue
		}
		out = append(out, strings.TrimSuffix(e.Name(), ".rfbin"))
	}
	sort.Strings(out)
	return out
}

func (f *FileStore) Close() error {
	f.stopOnce.Do(func() {
		close(f.stopCh)
		<-f.doneCh
	})
	return nil
}

func (f *FileStore) loop() {
	defer close(f.doneCh)
	openFiles := make(map[string]*openTraceFile)
	ticker := time.NewTicker(2500 * time.Millisecond)
	defer ticker.Stop()

	summaryFor := func(sessionID string, of *openTraceFile) Summary {
		var size int64
		p := f.pathFor(sessionID)
		if p != "" {
			if st, err := os.Stat(p); err == nil {
				size = st.Size()
			}
		}
		if of != nil {
			var dur float64
			if of.enc.lastTsUs > of.enc.firstTsUs {
				dur = float64(of.enc.lastTsUs-of.enc.firstTsUs) / 1e6
			}
			return Summary{
				SessionID:   sessionID,
				SampleCount: of.enc.sampleCount,
				DurationSec: dur,
				SizeBytes:   size,
			}
		}
		if p != "" && size > 0 {
			if raw, err := os.ReadFile(p); err == nil {
				if samples, err := DecodeSamples(raw); err == nil {
					return SummarizeSamples(sessionID, samples, size)
				}
			}
		}
		return Summary{SessionID: sessionID, SizeBytes: size}
	}

	closeOne := func(sessionID string) Summary {
		clean := sanitizeSessionID(sessionID)
		of := openFiles[clean]
		f.ioMu.Lock()
		if of != nil {
			_ = of.buf.Flush()
			_ = of.file.Close()
			delete(openFiles, clean)
		}
		sum := summaryFor(sessionID, of)
		f.ioMu.Unlock()
		return sum
	}

	handleCmd := func(cmd writeCmd) {
		switch cmd.kind {
		case cmdAppend:
			clean := sanitizeSessionID(cmd.sessionID)
			if clean == "" {
				return
			}
			f.ioMu.Lock()
			of := openFiles[clean]
			if of == nil {
				p := f.pathFor(cmd.sessionID)
				var existing []Sample
				if raw, err := os.ReadFile(p); err == nil && len(raw) > 0 {
					existing, _ = DecodeSamples(raw)
				}
				fl, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
				if err != nil {
					f.ioMu.Unlock()
					return
				}
				bw := bufio.NewWriterSize(fl, 64*1024)
				of = &openTraceFile{path: p, file: fl, buf: bw}
				for _, prev := range existing {
					_ = of.enc.encodeSample(of.buf, prev)
				}
				openFiles[clean] = of
			}
			_ = of.enc.encodeSample(of.buf, cmd.sample)
			f.ioMu.Unlock()

		case cmdFlush:
			clean := sanitizeSessionID(cmd.sessionID)
			f.ioMu.Lock()
			of := openFiles[clean]
			if of != nil {
				_ = of.buf.Flush()
			}
			sum := summaryFor(cmd.sessionID, of)
			f.ioMu.Unlock()
			if cmd.reply != nil {
				cmd.reply <- sum
			}

		case cmdSeal:
			sum := closeOne(cmd.sessionID)
			if cmd.reply != nil {
				cmd.reply <- sum
			}
		}
	}

	for {
		select {
		case <-f.stopCh:
			for {
				select {
				case cmd := <-f.cmdCh:
					handleCmd(cmd)
				default:
					f.ioMu.Lock()
					for k, of := range openFiles {
						_ = of.buf.Flush()
						_ = of.file.Close()
						delete(openFiles, k)
					}
					f.ioMu.Unlock()
					return
				}
			}
		case cmd := <-f.cmdCh:
			handleCmd(cmd)
		case <-ticker.C:
			f.ioMu.Lock()
			for _, of := range openFiles {
				_ = of.buf.Flush()
			}
			f.ioMu.Unlock()
		}
	}
}

// ---------------------------------------------------------------------------
// MemoryStore: In-memory `.rfbin` store for Browser WASM & unit tests
// ---------------------------------------------------------------------------

type memEntry struct {
	buf bytes.Buffer
	enc streamEncoder
}

// MemoryStore stores `.rfbin`-encoded traces in RAM using the exact same binary wire format.
type MemoryStore struct {
	mu      sync.RWMutex
	entries map[string]*memEntry
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		entries: make(map[string]*memEntry),
	}
}

func (m *MemoryStore) Append(sessionID string, sample Sample) {
	clean := sanitizeSessionID(sessionID)
	if clean == "" || len(sample.SlotIndices) == 0 {
		return
	}
	m.mu.Lock()
	e := m.entries[clean]
	if e == nil {
		e = &memEntry{}
		m.entries[clean] = e
	}
	_ = e.enc.encodeSample(&e.buf, sample)
	m.mu.Unlock()
}

func (m *MemoryStore) FlushSession(string) {}

func (m *MemoryStore) SealSession(sessionID string) Summary {
	clean := sanitizeSessionID(sessionID)
	m.mu.RLock()
	e := m.entries[clean]
	if e == nil {
		m.mu.RUnlock()
		return Summary{SessionID: sessionID}
	}
	var dur float64
	if e.enc.lastTsUs > e.enc.firstTsUs {
		dur = float64(e.enc.lastTsUs-e.enc.firstTsUs) / 1e6
	}
	sum := Summary{
		SessionID:   sessionID,
		SampleCount: e.enc.sampleCount,
		DurationSec: dur,
		SizeBytes:   int64(e.buf.Len()),
	}
	m.mu.RUnlock()
	return sum
}

func (m *MemoryStore) ReadRawBytes(sessionID string) ([]byte, error) {
	clean := sanitizeSessionID(sessionID)
	m.mu.RLock()
	e := m.entries[clean]
	if e == nil {
		m.mu.RUnlock()
		return nil, nil
	}
	cp := append([]byte(nil), e.buf.Bytes()...)
	m.mu.RUnlock()
	return cp, nil
}

func (m *MemoryStore) ReadSession(sessionID string) ([]Sample, error) {
	raw, err := m.ReadRawBytes(sessionID)
	if err != nil || len(raw) == 0 {
		return nil, err
	}
	return DecodeSamples(raw)
}

func (m *MemoryStore) WriteRawBytes(sessionID string, raw []byte) (Summary, error) {
	clean := sanitizeSessionID(sessionID)
	if clean == "" {
		return Summary{}, errors.New("empty sessionId")
	}
	samples, err := DecodeSamples(raw)
	if err != nil {
		return Summary{}, err
	}
	m.mu.Lock()
	e := &memEntry{}
	for _, s := range samples {
		_ = e.enc.encodeSample(&e.buf, s)
	}
	m.entries[clean] = e
	m.mu.Unlock()
	return SummarizeSamples(sessionID, samples, int64(len(raw))), nil
}

func (m *MemoryStore) DeleteSession(sessionID string) error {
	clean := sanitizeSessionID(sessionID)
	m.mu.Lock()
	delete(m.entries, clean)
	m.mu.Unlock()
	return nil
}

func (m *MemoryStore) TotalBytes() int64 {
	m.mu.RLock()
	var total int64
	for _, e := range m.entries {
		total += int64(e.buf.Len())
	}
	m.mu.RUnlock()
	return total
}

func (m *MemoryStore) ListSessionIDs() []string {
	m.mu.RLock()
	out := make([]string, 0, len(m.entries))
	for k := range m.entries {
		out = append(out, k)
	}
	m.mu.RUnlock()
	sort.Strings(out)
	return out
}

func (m *MemoryStore) Close() error {
	return nil
}
