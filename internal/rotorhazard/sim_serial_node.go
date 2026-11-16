package rotorhazard

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"sync"
	"time"
)

// RotorHazard binary serial protocol command IDs (`RHInterface.py` / `serial_node.py` / `FPVGateC5MK`).
const (
	CmdReadAddress        byte = 0x00
	CmdReadFrequency      byte = 0x03
	CmdTestRxRegister     byte = 0x04
	CmdReadLapStats       byte = 0x05 // 16B for 21 <= api_level < 32
	CmdReadLapPassStats   byte = 0x0D // 8B for api_level >= 32
	CmdReadLapExtremums   byte = 0x0E // 8B for api_level >= 32
	CmdReadRHFeatFlags    byte = 0x11
	CmdReadRevisionCode   byte = 0x22 // 2B: [0x25, api_level]
	CmdReadNodeRssiPeak   byte = 0x23
	CmdReadNodeRssiNadir  byte = 0x24
	CmdReadEnterAtLevel   byte = 0x31
	CmdReadExitAtLevel    byte = 0x32
	CmdReadTimeMillis     byte = 0x33
	CmdReadMultinodeCount byte = 0x39
	CmdReadCurNodeIndex   byte = 0x3A
	CmdReadNodeSlotIdx    byte = 0x3C
	CmdReadFwVersion      byte = 0x3D // 16B ASCII (API >= 34)
	CmdReadFwBuildDate    byte = 0x3E // 16B ASCII (API >= 34)
	CmdReadFwBuildTime    byte = 0x3F // 16B ASCII (API >= 34)
	CmdReadFwProcType     byte = 0x40 // 16B ASCII (API >= 35)

	CmdWriteAddress      byte = 0x50
	CmdWriteFrequency    byte = 0x51 // 2B BE MHz (1111 = seat powered down on API >= 24)
	CmdWriteEnterAtLevel byte = 0x71 // 1B
	CmdWriteExitAtLevel  byte = 0x72 // 1B
	CmdSendStatusMessage byte = 0x75 // 2B BE
	CmdForceEndCrossing  byte = 0x78 // 1B
	CmdWriteCurNodeIndex byte = 0x7A // 1B (0..N-1)

	RHRevisionHeaderByte byte   = 0x25
	DefaultRHSerialAPI   uint8  = 36
	SeatDisabledFreqMHz  uint16 = 1111
	LegacyDisabledFreq   uint16 = 5800
	RHNodeIdleTimeoutUs  uint64 = 5_000_000 // 5s idle timeout matching FPVGateC5MK `kIdleTimeoutMs`
)

// ErrSerialTimeout is returned by in-memory serial ports when a read deadline expires with 0 bytes.
var ErrSerialTimeout = errors.New("serial read timeout")

func serialChecksum(payload []byte) byte {
	var sum byte
	for _, b := range payload {
		sum += b
	}
	return sum
}

func fixedASCII16(s string) [16]byte {
	var out [16]byte
	copy(out[:], []byte(s))
	return out
}

// MemSerialPort is a pure-Go, thread-safe endpoint of a full-duplex byte pipe that implements
// `SerialPort` (usable in async unit tests and multi-goroutine serial simulations).
type MemSerialPort struct {
	rxMu        sync.Mutex
	rxCond      *sync.Cond
	rxBuf       bytes.Buffer
	readTimeout time.Duration
	closed      bool

	peer *MemSerialPort

	ctrlMu sync.Mutex
	dtr    bool
	rts    bool
}

// NewInMemorySerialPair creates two cross-wired serial endpoints (`hostPort` <-> `devicePort`).
func NewInMemorySerialPair() (hostPort *MemSerialPort, devicePort *MemSerialPort) {
	a := &MemSerialPort{readTimeout: 100 * time.Millisecond}
	b := &MemSerialPort{readTimeout: 100 * time.Millisecond}
	a.rxCond = sync.NewCond(&a.rxMu)
	b.rxCond = sync.NewCond(&b.rxMu)
	a.peer = b
	b.peer = a
	return a, b
}

func (p *MemSerialPort) Read(b []byte) (int, error) {
	if len(b) == 0 {
		return 0, nil
	}
	p.rxMu.Lock()
	defer p.rxMu.Unlock()

	if p.rxBuf.Len() > 0 {
		return p.rxBuf.Read(b)
	}
	if p.closed {
		return 0, io.EOF
	}

	timeout := p.readTimeout
	if timeout > 0 {
		timedOut := false
		timer := time.AfterFunc(timeout, func() {
			p.rxMu.Lock()
			timedOut = true
			p.rxCond.Broadcast()
			p.rxMu.Unlock()
		})
		defer timer.Stop()
		for p.rxBuf.Len() == 0 && !p.closed && !timedOut {
			p.rxCond.Wait()
		}
		if p.rxBuf.Len() > 0 {
			return p.rxBuf.Read(b)
		}
		if p.closed {
			return 0, io.EOF
		}
		return 0, ErrSerialTimeout
	}

	for p.rxBuf.Len() == 0 && !p.closed {
		p.rxCond.Wait()
	}
	if p.rxBuf.Len() > 0 {
		return p.rxBuf.Read(b)
	}
	return 0, io.EOF
}

func (p *MemSerialPort) Write(b []byte) (int, error) {
	p.rxMu.Lock()
	closed := p.closed
	p.rxMu.Unlock()
	if closed {
		return 0, io.ErrClosedPipe
	}
	peer := p.peer
	if peer == nil {
		return 0, io.ErrClosedPipe
	}
	peer.rxMu.Lock()
	defer peer.rxMu.Unlock()
	if peer.closed {
		return 0, io.ErrClosedPipe
	}
	n, _ := peer.rxBuf.Write(b)
	peer.rxCond.Broadcast()
	return n, nil
}

func (p *MemSerialPort) Close() error {
	p.rxMu.Lock()
	if !p.closed {
		p.closed = true
		p.rxCond.Broadcast()
	}
	p.rxMu.Unlock()

	if p.peer != nil {
		p.peer.rxMu.Lock()
		if !p.peer.closed {
			p.peer.closed = true
			p.peer.rxCond.Broadcast()
		}
		p.peer.rxMu.Unlock()
	}
	return nil
}

func (p *MemSerialPort) SetDTR(v bool) error {
	p.ctrlMu.Lock()
	p.dtr = v
	p.ctrlMu.Unlock()
	return nil
}

func (p *MemSerialPort) SetRTS(v bool) error {
	p.ctrlMu.Lock()
	p.rts = v
	p.ctrlMu.Unlock()
	return nil
}

func (p *MemSerialPort) DTRRTS() (dtr bool, rts bool) {
	p.ctrlMu.Lock()
	defer p.ctrlMu.Unlock()
	return p.dtr, p.rts
}

func (p *MemSerialPort) SetReadTimeout(t time.Duration) error {
	p.rxMu.Lock()
	p.readTimeout = t
	p.rxCond.Broadcast()
	p.rxMu.Unlock()
	return nil
}

func (p *MemSerialPort) ResetInputBuffer() error {
	p.rxMu.Lock()
	p.rxBuf.Reset()
	p.rxMu.Unlock()
	return nil
}

func (p *MemSerialPort) ResetOutputBuffer() error {
	return nil
}

// SyncLoopbackPort connects `SerialClient` directly to `SimSerialNode.ProcessWireBytes` synchronously
// in-memory (used by `TrackSimulator` so 50 Hz ticks and 45-second fast-forward prewarms run the
// full RotorHazard binary wire protocol deterministically with zero background goroutines).
type SyncLoopbackPort struct {
	mu     sync.Mutex
	node   *SimSerialNode
	rxBuf  bytes.Buffer
	closed bool
	dtr    bool
	rts    bool
}

// NewSyncLoopbackPort wraps `node` in a synchronous `SerialPort`.
func NewSyncLoopbackPort(node *SimSerialNode) *SyncLoopbackPort {
	p := &SyncLoopbackPort{node: node}
	if node != nil && len(node.bootBytes) > 0 {
		p.rxBuf.Write(node.bootBytes)
	}
	return p
}

func (p *SyncLoopbackPort) Read(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return 0, io.EOF
	}
	if p.rxBuf.Len() == 0 {
		return 0, ErrSerialTimeout
	}
	return p.rxBuf.Read(b)
}

func (p *SyncLoopbackPort) Write(b []byte) (int, error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return 0, io.ErrClosedPipe
	}
	node := p.node
	p.mu.Unlock()

	var resp []byte
	if node != nil {
		resp = node.ProcessWireBytes(b)
	}

	p.mu.Lock()
	if len(resp) > 0 && !p.closed {
		p.rxBuf.Write(resp)
	}
	p.mu.Unlock()
	return len(b), nil
}

func (p *SyncLoopbackPort) Close() error {
	p.mu.Lock()
	p.closed = true
	p.rxBuf.Reset()
	p.mu.Unlock()
	return nil
}

func (p *SyncLoopbackPort) SetDTR(v bool) error {
	p.mu.Lock()
	p.dtr = v
	p.mu.Unlock()
	return nil
}

func (p *SyncLoopbackPort) SetRTS(v bool) error {
	p.mu.Lock()
	p.rts = v
	p.mu.Unlock()
	return nil
}

func (p *SyncLoopbackPort) SetReadTimeout(_ time.Duration) error { return nil }

func (p *SyncLoopbackPort) ResetInputBuffer() error {
	p.mu.Lock()
	p.rxBuf.Reset()
	p.mu.Unlock()
	return nil
}

// SimSerialNodeConfig configures a byte-accurate RotorHazard binary serial multi-node emulator.
type SimSerialNodeConfig struct {
	SeatCount  int
	APILevel   uint8
	FwVersion  string
	BuildDate  string
	BuildTime  string
	ProcType   string
	BootBanner []byte // Optional boot/scanner chatter emitted before binary protocol loop starts
	NowUs      func() uint64
}

type simSerialSeat struct {
	freqMHz     uint16
	rxValid     bool
	enterAt     uint8
	exitAt      uint8
	currentRssi uint8
	nodePeak    uint8
	nodeNadir   uint8

	inCrossing      bool
	curPeak         uint8
	curNadir        uint8
	curPeakTimeUs   uint64
	crossingStartUs uint64

	lapID          uint8
	lastPassTimeUs uint64
	lastPassPeak   uint8
	lastPassNadir  uint8
}

// SimSerialNode emulates a physical RotorHazard USB timing board (`serial_node.py` / `FPVGateC5MK`
// API 36 multi-seat node) over any `io.ReadWriteCloser` or `SyncLoopbackPort`.
type SimSerialNode struct {
	mu        sync.Mutex
	seatCount int
	apiLevel  uint8
	fwVersion [16]byte
	buildDate [16]byte
	buildTime [16]byte
	procType  [16]byte
	bootBytes []byte
	nowUsFn   func() uint64
	bootUs    uint64

	rxPending   []byte
	addr        uint8
	curSeat     uint8
	statusFlags uint16
	lastCmdUs   uint64
	hasCmd      bool
	seats       [8]simSerialSeat
}

// NewSimSerialNode creates a RotorHazard binary serial node emulator.
func NewSimSerialNode(cfg SimSerialNodeConfig) *SimSerialNode {
	seats := cfg.SeatCount
	if seats <= 0 || seats > 8 {
		seats = 8
	}
	apiLvl := cfg.APILevel
	if apiLvl < 21 {
		apiLvl = DefaultRHSerialAPI
	}
	fwVer := cfg.FwVersion
	if fwVer == "" {
		fwVer = "RH 4.2.0 USB"
	}
	bDate := cfg.BuildDate
	if bDate == "" {
		bDate = "Nov 15 2026"
	}
	bTime := cfg.BuildTime
	if bTime == "" {
		bTime = "12:00:00"
	}
	proc := cfg.ProcType
	if proc == "" {
		proc = "ESP32-C5"
	}
	nowFn := cfg.NowUs
	if nowFn == nil {
		t0 := time.Now()
		nowFn = func() uint64 { return uint64(time.Since(t0).Microseconds()) }
	}
	n := &SimSerialNode{
		seatCount: seats,
		apiLevel:  apiLvl,
		fwVersion: fixedASCII16(fwVer),
		buildDate: fixedASCII16(bDate),
		buildTime: fixedASCII16(bTime),
		procType:  fixedASCII16(proc),
		bootBytes: append([]byte(nil), cfg.BootBanner...),
		nowUsFn:   nowFn,
		bootUs:    nowFn(),
	}
	defaultFreq := SeatDisabledFreqMHz
	if apiLvl < 24 {
		defaultFreq = LegacyDisabledFreq
	}
	for i := 0; i < 8; i++ {
		n.seats[i] = simSerialSeat{
			freqMHz:     defaultFreq,
			rxValid:     true,
			enterAt:     95,
			exitAt:      70,
			currentRssi: 24,
			nodePeak:    24,
			nodeNadir:   24,
		}
	}
	return n
}

func (n *SimSerialNode) nowUsLocked() uint64 {
	return n.nowUsFn()
}

// SetSeatCount updates the node's reported seat count (4 or 8).
func (n *SimSerialNode) SetSeatCount(count int) {
	n.mu.Lock()
	if count >= 1 && count <= 8 {
		n.seatCount = count
		if int(n.curSeat) >= count {
			n.curSeat = 0
		}
	}
	n.mu.Unlock()
}

// SeatSnapshot returns all 8 seats' programmed frequencies and thresholds.
func (n *SimSerialNode) SeatSnapshot() (freqs [8]uint16, enter [8]uint8, exit [8]uint8) {
	n.mu.Lock()
	defer n.mu.Unlock()
	for i := 0; i < 8; i++ {
		if n.seats[i].freqMHz != SeatDisabledFreqMHz {
			freqs[i] = n.seats[i].freqMHz
		}
		enter[i] = n.seats[i].enterAt
		exit[i] = n.seats[i].exitAt
	}
	return freqs, enter, exit
}

// IsRHModeActive reports whether the host has polled the node within the 5-second idle window.
func (n *SimSerialNode) IsRHModeActive() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	if !n.hasCmd {
		return false
	}
	now := n.nowUsLocked()
	if now < n.lastCmdUs {
		return true
	}
	return now-n.lastCmdUs <= RHNodeIdleTimeoutUs
}

// SeatConfig returns the currently programmed frequency and dual hysteresis thresholds for `seat` (0..7).
func (n *SimSerialNode) SeatConfig(seat int) (freqMHz uint16, enterAt uint8, exitAt uint8) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if seat < 0 || seat >= 8 {
		return 0, 0, 0
	}
	s := n.seats[seat]
	return s.freqMHz, s.enterAt, s.exitAt
}

// SeatRSSI returns the current 0..255 RSSI across all 8 seats.
func (n *SimSerialNode) SeatRSSI() [8]float32 {
	n.mu.Lock()
	defer n.mu.Unlock()
	var out [8]float32
	for i := 0; i < 8; i++ {
		out[i] = float32(n.seats[i].currentRssi)
	}
	return out
}

// SetSeatLapState pre-seeds a seat's `lap_id` and last pass metrics (used for wraparound & latch tests).
func (n *SimSerialNode) SetSeatLapState(seat int, lapID uint8, passPeak uint8, passTimeUs uint64) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if seat < 0 || seat >= 8 {
		return
	}
	s := &n.seats[seat]
	s.lapID = lapID
	s.lastPassPeak = passPeak
	s.lastPassTimeUs = passTimeUs
}

// FeedSeatRSSI injects a simulated 0..255 RX5808 RSSI sample into `seat` (0..7), running the
// RotorHazard node's dual-threshold (`enter_at_level` / `exit_at_level`) peak-finding state machine.
func (n *SimSerialNode) FeedSeatRSSI(seat int, rssi float32, nowUs uint64) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if seat < 0 || seat >= n.seatCount {
		return
	}
	if nowUs == 0 {
		nowUs = n.nowUsLocked()
	}
	s := &n.seats[seat]
	disabled := s.freqMHz == 0 || s.freqMHz == SeatDisabledFreqMHz
	if disabled {
		s.currentRssi = 22
		s.inCrossing = false
		return
	}

	clamped := int(math.Round(float64(rssi)))
	if clamped < 1 {
		clamped = 1
	} else if clamped > 254 {
		clamped = 254
	}
	u := uint8(clamped)
	s.currentRssi = u
	if u > s.nodePeak {
		s.nodePeak = u
	}
	if s.nodeNadir == 0 || u < s.nodeNadir {
		s.nodeNadir = u
	}

	if !s.inCrossing {
		if s.enterAt > 0 && u >= s.enterAt {
			s.inCrossing = true
			s.curPeak = u
			s.curNadir = u
			s.curPeakTimeUs = nowUs
			s.crossingStartUs = nowUs
		}
		return
	}

	if u > s.curPeak {
		s.curPeak = u
		s.curPeakTimeUs = nowUs
	}
	if u < s.curNadir {
		s.curNadir = u
	}

	if u <= s.exitAt {
		s.inCrossing = false
		s.curNadir = u
		// Enforce a minimal 250ms hardware pass separation to avoid noise double-triggers
		if s.lastPassTimeUs == 0 || s.curPeakTimeUs >= s.lastPassTimeUs+250_000 {
			s.lapID++ // uint8 naturally wraps 255 -> 0
			s.lastPassTimeUs = s.curPeakTimeUs
			s.lastPassPeak = s.curPeak
			s.lastPassNadir = u
		}
	}
}

func (n *SimSerialNode) buildPassStatsLocked(s *simSerialSeat, nowUs uint64) [8]byte {
	var ageMs uint16
	if s.lastPassTimeUs > 0 && nowUs > s.lastPassTimeUs {
		diffMs := (nowUs - s.lastPassTimeUs) / 1000
		if diffMs > 0xFFFF {
			ageMs = 0xFFFF
		} else {
			ageMs = uint16(diffMs)
		}
	}
	var out [8]byte
	out[0] = s.lapID
	binary.BigEndian.PutUint16(out[1:3], ageMs)
	out[3] = s.currentRssi
	out[4] = s.nodePeak
	out[5] = s.lastPassPeak
	binary.BigEndian.PutUint16(out[6:8], 125) // ~125 us node ADC loop time
	s.nodePeak = s.currentRssi
	return out
}

func (n *SimSerialNode) buildExtremumsLocked(s *simSerialSeat, nowUs uint64) [8]byte {
	var flags byte
	if s.inCrossing {
		flags |= 0x01
	}
	if s.curPeak > 0 {
		flags |= 0x02
	}
	var durMs uint16
	if s.inCrossing && nowUs > s.crossingStartUs {
		d := (nowUs - s.crossingStartUs) / 1000
		if d > 0xFFFF {
			durMs = 0xFFFF
		} else {
			durMs = uint16(d)
		}
	}
	var out [8]byte
	out[0] = flags
	out[1] = s.lastPassNadir
	out[2] = s.nodeNadir
	out[3] = s.curPeak
	binary.BigEndian.PutUint16(out[4:6], 0)
	binary.BigEndian.PutUint16(out[6:8], durMs)
	s.nodeNadir = s.currentRssi
	return out
}

// ProcessWireBytes feeds raw host serial bytes into the simulated RotorHazard node and returns
// any binary response frames (`[payload...][checksum]`) produced.
func (n *SimSerialNode) ProcessWireBytes(in []byte) []byte {
	if len(in) == 0 {
		return nil
	}
	n.mu.Lock()
	defer n.mu.Unlock()

	n.rxPending = append(n.rxPending, in...)
	var out []byte

	appendResp := func(payload []byte) {
		out = append(out, payload...)
		out = append(out, serialChecksum(payload))
	}

	for len(n.rxPending) > 0 {
		cmd := n.rxPending[0]

		switch cmd {
		case CmdWriteFrequency, CmdSendStatusMessage:
			if len(n.rxPending) < 4 {
				return out
			}
			body := n.rxPending[1:4]
			n.rxPending = n.rxPending[4:]
			if serialChecksum(body[:2]) != body[2] {
				continue
			}
			val := binary.BigEndian.Uint16(body[:2])
			n.lastCmdUs = n.nowUsLocked()
			n.hasCmd = true
			if cmd == CmdWriteFrequency {
				s := &n.seats[n.curSeat]
				if s.freqMHz != val {
					s.freqMHz = val
					s.inCrossing = false
					s.rxValid = val == SeatDisabledFreqMHz || (val >= 5000 && val <= 6000)
				}
			} else {
				n.statusFlags = val
			}
			continue

		case CmdWriteAddress, CmdWriteEnterAtLevel, CmdWriteExitAtLevel, CmdForceEndCrossing, CmdWriteCurNodeIndex:
			if len(n.rxPending) < 3 {
				return out
			}
			body := n.rxPending[1:3]
			n.rxPending = n.rxPending[3:]
			if serialChecksum(body[:1]) != body[1] {
				continue
			}
			val := body[0]
			now := n.nowUsLocked()
			n.lastCmdUs = now
			n.hasCmd = true
			switch cmd {
			case CmdWriteAddress:
				n.addr = val
			case CmdWriteCurNodeIndex:
				if int(val) < n.seatCount {
					n.curSeat = val
				}
			case CmdWriteEnterAtLevel:
				n.seats[n.curSeat].enterAt = val
			case CmdWriteExitAtLevel:
				n.seats[n.curSeat].exitAt = val
			case CmdForceEndCrossing:
				s := &n.seats[n.curSeat]
				if s.inCrossing {
					s.inCrossing = false
					s.lapID++
					s.lastPassTimeUs = s.curPeakTimeUs
					s.lastPassPeak = s.curPeak
					s.lastPassNadir = s.currentRssi
				}
			}
			continue
		}

		// Read command (1 byte)
		n.rxPending = n.rxPending[1:]
		now := n.nowUsLocked()
		n.lastCmdUs = now
		n.hasCmd = true
		s := &n.seats[n.curSeat]

		switch cmd {
		case CmdReadAddress:
			appendResp([]byte{n.addr})
		case CmdReadRevisionCode:
			appendResp([]byte{RHRevisionHeaderByte, n.apiLevel})
		case CmdReadMultinodeCount:
			appendResp([]byte{byte(n.seatCount)})
		case CmdReadCurNodeIndex, CmdReadNodeSlotIdx:
			appendResp([]byte{n.curSeat})
		case CmdReadFrequency:
			var b [2]byte
			binary.BigEndian.PutUint16(b[:], s.freqMHz)
			appendResp(b[:])
		case CmdTestRxRegister:
			if s.rxValid {
				appendResp([]byte{1})
			} else {
				appendResp([]byte{0})
			}
		case CmdReadEnterAtLevel:
			appendResp([]byte{s.enterAt})
		case CmdReadExitAtLevel:
			appendResp([]byte{s.exitAt})
		case CmdReadNodeRssiPeak:
			appendResp([]byte{s.nodePeak})
		case CmdReadNodeRssiNadir:
			appendResp([]byte{s.nodeNadir})
		case CmdReadRHFeatFlags:
			appendResp([]byte{0x00, 0x00})
		case CmdReadTimeMillis:
			var b [4]byte
			ms := uint32((now - n.bootUs) / 1000)
			binary.BigEndian.PutUint32(b[:], ms)
			appendResp(b[:])
		case CmdReadLapPassStats:
			ps := n.buildPassStatsLocked(s, now)
			appendResp(ps[:])
		case CmdReadLapExtremums:
			ex := n.buildExtremumsLocked(s, now)
			appendResp(ex[:])
		case CmdReadLapStats:
			ps := n.buildPassStatsLocked(s, now)
			ex := n.buildExtremumsLocked(s, now)
			var combined [16]byte
			copy(combined[:8], ps[:])
			copy(combined[8:], ex[:])
			appendResp(combined[:])
		case CmdReadFwVersion:
			appendResp(n.fwVersion[:])
		case CmdReadFwBuildDate:
			appendResp(n.buildDate[:])
		case CmdReadFwBuildTime:
			appendResp(n.buildTime[:])
		case CmdReadFwProcType:
			appendResp(n.procType[:])
		}
	}

	return out
}

// Serve runs the RotorHazard binary serial slave loop on `port` until `port` is closed.
func (n *SimSerialNode) Serve(port io.ReadWriteCloser) error {
	if tp, ok := port.(interface{ SetReadTimeout(time.Duration) error }); ok {
		_ = tp.SetReadTimeout(0)
	}
	if len(n.bootBytes) > 0 {
		_, _ = port.Write(n.bootBytes)
	}

	var buf [256]byte
	for {
		nr, err := port.Read(buf[:])
		if nr > 0 {
			resp := n.ProcessWireBytes(buf[:nr])
			if len(resp) > 0 {
				if _, wErr := port.Write(resp); wErr != nil {
					return wErr
				}
			}
		}
		if err != nil {
			if errors.Is(err, ErrSerialTimeout) {
				continue
			}
			return err
		}
	}
}
