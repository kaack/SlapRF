package rotorhazard

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"strings"
	"sync"
	"time"

	"slaprf/internal/domain"
)

// SerialPort abstracts an OS serial port (`usb.DefaultSerialOpener`) or an in-memory byte pipe
// (`NewInMemorySerialPair` / `NewSyncLoopbackPort`) without pulling OS/cgo dependencies into WASM builds.
type SerialPort interface {
	io.ReadWriteCloser
	SetDTR(dtr bool) error
	SetRTS(rts bool) error
	SetReadTimeout(t time.Duration) error
}

// SerialPortOpener opens a named serial port at `baud` (e.g. `115200` or `921600`).
type SerialPortOpener func(portName string, baud int) (SerialPort, error)

// DefaultRHSerialBauds lists RotorHazard USB baud rates in probe order:
// 115200 (ESP32-C5 `FPVGateC5MK`, Arduino Nano, RP2040, USB-CDC) then 921600 (STM32 `S32_BPill`).
var DefaultRHSerialBauds = []int{115200, 921600}

// SerialClientConfig configures a RotorHazard binary serial master (`SerialClient`).
type SerialClientConfig struct {
	PortName        string
	BaudRate        int // 0 = auto-negotiate (115200 -> 921600)
	OpenPort        SerialPortOpener
	Hooks           ClientHooks
	PollInterval    time.Duration // Default: 80ms (~12.5 Hz, well inside 5s idle timeout)
	BootTimeout     time.Duration // Default: 2200ms (absorbs USB DTR/RTS bootloader chill + banner)
	ReadTimeout     time.Duration // Default: 150ms
	RxSettleDelay   time.Duration // Default: 30ms before TEST_RX_REGISTER (0x04) on API >= 36
	NoRxSettleDelay bool          // True for deterministic synchronous simulator loopback
}

// SerialSession represents an active handshaken RotorHazard serial connection that can be driven
// either asynchronously (`SerialClient.RunOnce`) or synchronously tick-by-tick (`TrackSimulator`).
type SerialSession struct {
	client    *SerialClient
	port      SerialPort
	nodeCount int
	apiLvl    int
	curSeat   int
}

// SerialClient implements the upstream RotorHazard `RHInterface.py` binary serial master protocol
// (API 21..36+, up to 8 seats per port, checksummed reads/writes, readback validation, and
// RTT-compensated `passAgeMs` crossing timestamps).
type SerialClient struct {
	cfg SerialClientConfig

	mu             sync.Mutex
	connected      bool
	apiLevel       int
	baudRate       int
	nodeCount      int
	fwVersion      string
	procType       string
	serverVersion  string
	serverHostname string

	desiredNodes  [domain.MaxPilotSlots]NodeConfig
	desiredArmed  bool
	hasDesired    bool
	appliedFreqs  [domain.MaxPilotSlots]int
	appliedEnter  [domain.MaxPilotSlots]int
	appliedExit   [domain.MaxPilotSlots]int
	appliedArmed  int // -1 = unknown, 0 = disarmed, 1 = armed
	reportedEnter [domain.MaxPilotSlots]uint8
	reportedExit  [domain.MaxPilotSlots]uint8
	reportedFreqs [domain.MaxPilotSlots]uint16
	lastLapID     [domain.MaxPilotSlots]int // -1 = unlatched

	slotRSSI       [domain.MaxPilotSlots]float32
	crossingFlags  [domain.MaxPilotSlots]bool
	heartbeatsRx   uint64
	passesRx       uint64
	passingCounter uint32
	minRttUs       uint64

	wakeCh chan struct{}
}

// NewSerialClient constructs a RotorHazard binary serial master client.
func NewSerialClient(cfg SerialClientConfig) *SerialClient {
	if cfg.PollInterval <= 0 {
		cfg.PollInterval = 80 * time.Millisecond
	}
	if cfg.BootTimeout <= 0 {
		cfg.BootTimeout = 2200 * time.Millisecond
	}
	if cfg.ReadTimeout <= 0 {
		cfg.ReadTimeout = 150 * time.Millisecond
	}
	if cfg.RxSettleDelay <= 0 && !cfg.NoRxSettleDelay {
		cfg.RxSettleDelay = 30 * time.Millisecond
	}
	c := &SerialClient{
		cfg:          cfg,
		nodeCount:    1,
		desiredArmed: true,
		wakeCh:       make(chan struct{}, 1),
	}
	c.resetTrackingLocked()
	return c
}

func (c *SerialClient) resetTrackingLocked() {
	c.appliedArmed = -1
	for i := 0; i < domain.MaxPilotSlots; i++ {
		c.appliedFreqs[i] = -1
		c.appliedEnter[i] = -1
		c.appliedExit[i] = -1
		c.lastLapID[i] = -1
	}
}

func (c *SerialClient) nowUs() uint64 {
	if c.cfg.Hooks.NowUs != nil {
		return c.cfg.Hooks.NowUs()
	}
	return uint64(time.Now().UnixMicro())
}

// SyncNodesAndArm updates the desired 8-seat RF frequencies, dual hysteresis thresholds, and gate
// arming state, waking the serial loop immediately to apply any changed registers.
func (c *SerialClient) SyncNodesAndArm(nodes [domain.MaxPilotSlots]NodeConfig, armed bool) {
	c.mu.Lock()
	c.desiredNodes = nodes
	c.desiredArmed = armed
	c.hasDesired = true
	c.mu.Unlock()

	select {
	case c.wakeCh <- struct{}{}:
	default:
	}
}

// Snapshot returns a thread-safe status & telemetry snapshot matching `ClientStatusSnapshot`.
func (c *SerialClient) Snapshot() ClientStatusSnapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.snapshotLocked()
}

func (c *SerialClient) snapshotLocked() ClientStatusSnapshot {
	var rttMs float64
	if c.minRttUs > 0 {
		rttMs = math.Round(float64(c.minRttUs)/100.0) / 10.0
	}
	raceStatus := RHRaceStatusReady
	if c.desiredArmed {
		raceStatus = RHRaceStatusRacing
	}
	return ClientStatusSnapshot{
		Connected:       c.connected,
		AuthOK:          c.connected,
		AuthKnown:       c.connected,
		ServerVersion:   c.serverVersion,
		ServerHostname:  c.serverHostname,
		APILevel:        c.apiLevel,
		BaudRate:        c.baudRate,
		NodeCount:       c.nodeCount,
		RaceStatus:      raceStatus,
		GateArmed:       c.desiredArmed,
		ClockSynced:     c.connected,
		ClockOffsetMs:   rttMs,
		HeartbeatsRx:    c.heartbeatsRx,
		PassesRx:        c.passesRx,
		SlotRSSI:        c.slotRSSI,
		CrossingFlag:    c.crossingFlags,
		NodeEnterLevels: c.reportedEnter,
		NodeExitLevels:  c.reportedExit,
		NodeFreqsMHz:    c.reportedFreqs,
		EnvSummary:      c.envSummaryLocked(),
	}
}

func (c *SerialClient) envSummaryLocked() string {
	if c.baudRate <= 0 && c.apiLevel <= 0 {
		return ""
	}
	var parts []string
	if c.procType != "" {
		parts = append(parts, c.procType)
	}
	if c.apiLevel > 0 {
		parts = append(parts, fmt.Sprintf("API %d", c.apiLevel))
	}
	if c.baudRate > 0 {
		parts = append(parts, fmt.Sprintf("%d baud", c.baudRate))
	}
	return strings.Join(parts, " · ")
}

func (c *SerialClient) markDisconnected() {
	c.mu.Lock()
	wasConn := c.connected
	c.connected = false
	c.resetTrackingLocked()
	snap := c.snapshotLocked()
	metaCb := c.cfg.Hooks.OnMeta
	c.mu.Unlock()
	if wasConn && metaCb != nil {
		metaCb(snap)
	}
}

// ConnectPort runs the RotorHazard revision/seat/firmware handshake on an already-opened `SerialPort`.
func (c *SerialClient) ConnectPort(ctx context.Context, port SerialPort, activeBaud int) (*SerialSession, error) {
	_ = port.SetDTR(false)
	_ = port.SetRTS(false)
	_ = port.SetReadTimeout(c.cfg.ReadTimeout)

	apiLvl, err := c.probeRevision(ctx, port)
	if err != nil {
		return nil, err
	}

	sess := &SerialSession{
		client:  c,
		port:    port,
		apiLvl:  apiLvl,
		curSeat: -1,
	}

	// Read multi-node count (`0x39`)
	nodeCount := 1
	if mc, err := c.readCommand(port, CmdReadMultinodeCount, 1); err == nil && len(mc) == 1 {
		if mc[0] >= 1 && mc[0] <= byte(domain.MaxPilotSlots) {
			nodeCount = int(mc[0])
		} else if mc[0] > byte(domain.MaxPilotSlots) {
			nodeCount = domain.MaxPilotSlots
		}
	}
	sess.nodeCount = nodeCount

	// Read firmware metadata on API >= 34/35
	var fwVer, procType string
	if apiLvl >= 34 {
		if b, err := c.readCommand(port, CmdReadFwVersion, 16); err == nil {
			fwVer = cleanASCII(b)
		}
	}
	if apiLvl >= 35 {
		if b, err := c.readCommand(port, CmdReadFwProcType, 16); err == nil {
			procType = cleanASCII(b)
		}
	}

	// Read initial per-seat frequencies & thresholds
	var initFreqs [domain.MaxPilotSlots]uint16
	var initEnter [domain.MaxPilotSlots]uint8
	var initExit [domain.MaxPilotSlots]uint8
	for seat := 0; seat < nodeCount; seat++ {
		if err := sess.selectSeat(seat); err != nil {
			return nil, err
		}
		if fb, err := c.readCommand(port, CmdReadFrequency, 2); err == nil && len(fb) == 2 {
			f := binary.BigEndian.Uint16(fb)
			if f != SeatDisabledFreqMHz {
				initFreqs[seat] = f
			}
		}
		if eb, err := c.readCommand(port, CmdReadEnterAtLevel, 1); err == nil && len(eb) == 1 {
			initEnter[seat] = eb[0]
		}
		if xb, err := c.readCommand(port, CmdReadExitAtLevel, 1); err == nil && len(xb) == 1 {
			initExit[seat] = xb[0]
		}
	}

	versionLabel := fmt.Sprintf("API %d", apiLvl)
	if fwVer != "" {
		versionLabel = fmt.Sprintf("%s (API %d)", fwVer, apiLvl)
	}
	if activeBaud <= 0 {
		activeBaud = 115200
	}

	c.mu.Lock()
	c.connected = true
	c.apiLevel = apiLvl
	c.baudRate = activeBaud
	c.nodeCount = nodeCount
	c.fwVersion = fwVer
	c.procType = procType
	c.serverVersion = versionLabel
	c.serverHostname = c.cfg.PortName
	c.reportedFreqs = initFreqs
	c.reportedEnter = initEnter
	c.reportedExit = initExit
	c.resetTrackingLocked()
	initSnap := c.snapshotLocked()
	metaCb := c.cfg.Hooks.OnMeta
	c.mu.Unlock()

	if metaCb != nil {
		metaCb(initSnap)
	}
	return sess, nil
}

func (s *SerialSession) selectSeat(seat int) error {
	if s.nodeCount <= 1 {
		s.curSeat = 0
		return nil
	}
	if s.curSeat == seat {
		return nil
	}
	for attempt := 0; attempt < 4; attempt++ {
		if err := s.client.writeCommand(s.port, CmdWriteCurNodeIndex, []byte{byte(seat)}); err != nil {
			return err
		}
		rb, err := s.client.readCommand(s.port, CmdReadCurNodeIndex, 1)
		if err == nil && len(rb) == 1 && int(rb[0]) == seat {
			s.curSeat = seat
			return nil
		}
	}
	return fmt.Errorf("failed to select RotorHazard USB seat %d", seat)
}

// Step executes one full RotorHazard USB register-sync + multi-seat poll cycle.
func (s *SerialSession) Step(ctx context.Context, emitHeartbeat bool) error {
	return s.client.stepOnce(ctx, s.port, s.nodeCount, s.apiLvl, s.selectSeat, emitHeartbeat)
}

// Close closes the underlying serial port and marks the client disconnected.
func (s *SerialSession) Close() error {
	err := s.port.Close()
	s.client.markDisconnected()
	return err
}

// RunOnce opens the serial port (auto-negotiating baud rate if `BaudRate == 0`), performs the
// RotorHazard revision/seat/firmware handshake, and runs the continuous ~10–12 Hz poll + config
// sync loop until `ctx` is cancelled or an unrecoverable I/O error occurs.
func (c *SerialClient) RunOnce(ctx context.Context, onReady func(error)) error {
	if c.cfg.OpenPort == nil {
		err := fmt.Errorf("missing RotorHazard USB serial opener")
		if onReady != nil {
			onReady(err)
		}
		return err
	}

	var bauds []int
	if c.cfg.BaudRate > 0 {
		bauds = []int{c.cfg.BaudRate}
		for _, fb := range DefaultRHSerialBauds {
			if fb != c.cfg.BaudRate {
				bauds = append(bauds, fb)
			}
		}
	} else {
		bauds = append([]int(nil), DefaultRHSerialBauds...)
	}

	var sess *SerialSession
	var lastErr error
	for _, baud := range bauds {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		p, oErr := c.cfg.OpenPort(c.cfg.PortName, baud)
		if oErr != nil {
			lastErr = oErr
			continue
		}
		s, hErr := c.ConnectPort(ctx, p, baud)
		if hErr == nil {
			sess = s
			break
		}
		lastErr = hErr
		_ = p.Close()
	}

	if sess == nil {
		if lastErr == nil {
			lastErr = fmt.Errorf("failed to handshake with RotorHazard USB node on %s", c.cfg.PortName)
		}
		if onReady != nil {
			onReady(lastErr)
		}
		return lastErr
	}
	defer func() {
		_ = sess.Close()
	}()

	if onReady != nil {
		onReady(nil)
	}

	ticker := time.NewTicker(c.cfg.PollInterval)
	defer ticker.Stop()

	consecutiveErrs := 0
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := sess.Step(ctx, true); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			consecutiveErrs++
			if consecutiveErrs >= 4 {
				return err
			}
			c.flushInput(sess.port)
			sess.curSeat = -1
		} else {
			consecutiveErrs = 0
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-c.wakeCh:
		case <-ticker.C:
		}
	}
}

func (c *SerialClient) stepOnce(
	ctx context.Context,
	port SerialPort,
	nodeCount int,
	apiLvl int,
	selectSeat func(seat int) error,
	emitHeartbeat bool,
) error {
	c.mu.Lock()
	hasDesired := c.hasDesired
	desiredNodes := c.desiredNodes
	desiredArmed := c.desiredArmed
	appliedFreqs := c.appliedFreqs
	appliedEnter := c.appliedEnter
	appliedExit := c.appliedExit
	appliedArmed := c.appliedArmed
	c.mu.Unlock()

	// 1. Apply any pending seat configuration or arming changes with readback verification
	if hasDesired {
		disabledFreq := SeatDisabledFreqMHz
		if apiLvl < 24 {
			disabledFreq = LegacyDisabledFreq
		}
		for seat := 0; seat < nodeCount; seat++ {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			want := desiredNodes[seat]
			targetFreq := disabledFreq
			isActiveChan := want.Enabled && want.FrequencyMHz > 0
			if isActiveChan {
				targetFreq = want.FrequencyMHz
			}
			if appliedFreqs[seat] != int(targetFreq) {
				if err := c.writeAndVerifyFreq(ctx, port, seat, apiLvl, targetFreq, isActiveChan, selectSeat); err != nil {
					return err
				}
				c.mu.Lock()
				c.appliedFreqs[seat] = int(targetFreq)
				if isActiveChan {
					c.reportedFreqs[seat] = targetFreq
				} else {
					c.reportedFreqs[seat] = 0
				}
				c.lastLapID[seat] = -1
				c.mu.Unlock()
			}

			if want.EnterAtLevel > 0 && appliedEnter[seat] != int(want.EnterAtLevel) {
				if err := c.writeAndVerifyByte(port, seat, CmdWriteEnterAtLevel, CmdReadEnterAtLevel, want.EnterAtLevel, selectSeat); err != nil {
					return err
				}
				c.mu.Lock()
				c.appliedEnter[seat] = int(want.EnterAtLevel)
				c.reportedEnter[seat] = want.EnterAtLevel
				c.mu.Unlock()
			}

			if want.ExitAtLevel > 0 && appliedExit[seat] != int(want.ExitAtLevel) {
				if err := c.writeAndVerifyByte(port, seat, CmdWriteExitAtLevel, CmdReadExitAtLevel, want.ExitAtLevel, selectSeat); err != nil {
					return err
				}
				c.mu.Lock()
				c.appliedExit[seat] = int(want.ExitAtLevel)
				c.reportedExit[seat] = want.ExitAtLevel
				c.mu.Unlock()
			}
		}

		wantArmInt := 0
		if desiredArmed {
			wantArmInt = 1
		}
		if appliedArmed != wantArmInt {
			if appliedArmed == 1 && wantArmInt == 0 {
				for seat := 0; seat < nodeCount; seat++ {
					if selectSeat(seat) == nil {
						_ = c.writeCommand(port, CmdForceEndCrossing, []byte{0})
					}
				}
			}
			var statusPayload [2]byte
			if desiredArmed {
				binary.BigEndian.PutUint16(statusPayload[:], 0x0001)
			}
			_ = c.writeCommand(port, CmdSendStatusMessage, statusPayload[:])
			c.mu.Lock()
			c.appliedArmed = wantArmInt
			c.mu.Unlock()
		}
	}

	// 2. Poll every seat (`0x0D`+`0x0E` on API >= 32, `0x05` on API 21..31)
	var passes []ClientPassEvent
	var hbRSSI [domain.MaxPilotSlots]float32
	var hbFlags [domain.MaxPilotSlots]bool
	var hbFreqs [domain.MaxPilotSlots]uint16
	var cycleMinRttUs uint64

	for seat := 0; seat < nodeCount; seat++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := selectSeat(seat); err != nil {
			return err
		}

		var combined [16]byte
		tReqUs := c.nowUs()
		if apiLvl >= 32 {
			ps, err := c.readCommand(port, CmdReadLapPassStats, 8)
			tRespUs := c.nowUs()
			if err != nil {
				return err
			}
			ex, err := c.readCommand(port, CmdReadLapExtremums, 8)
			if err != nil {
				return err
			}
			copy(combined[:8], ps)
			copy(combined[8:], ex)
			if tRespUs >= tReqUs {
				rtt := tRespUs - tReqUs
				if cycleMinRttUs == 0 || rtt < cycleMinRttUs {
					cycleMinRttUs = rtt
				}
			}
			passes = c.processSeatStats(seat, combined, tReqUs, tRespUs, passes, &hbRSSI, &hbFlags, &hbFreqs)
		} else {
			ls, err := c.readCommand(port, CmdReadLapStats, 16)
			tRespUs := c.nowUs()
			if err != nil {
				return err
			}
			copy(combined[:], ls)
			if tRespUs >= tReqUs {
				rtt := tRespUs - tReqUs
				if cycleMinRttUs == 0 || rtt < cycleMinRttUs {
					cycleMinRttUs = rtt
				}
			}
			passes = c.processSeatStats(seat, combined, tReqUs, tRespUs, passes, &hbRSSI, &hbFlags, &hbFreqs)
		}
	}

	c.mu.Lock()
	c.slotRSSI = hbRSSI
	c.crossingFlags = hbFlags
	if emitHeartbeat {
		c.heartbeatsRx++
	}
	if cycleMinRttUs > 0 && (c.minRttUs == 0 || cycleMinRttUs < c.minRttUs) {
		c.minRttUs = cycleMinRttUs
	}
	hbCb := c.cfg.Hooks.OnHeartbeat
	passCb := c.cfg.Hooks.OnPass
	c.mu.Unlock()

	if emitHeartbeat && hbCb != nil {
		hbCb(ClientHeartbeatEvent{
			NodeCount:    nodeCount,
			SlotRSSI:     hbRSSI,
			CrossingFlag: hbFlags,
			FrequencyMHz: hbFreqs,
		})
	}
	if passCb != nil {
		for _, p := range passes {
			passCb(p)
		}
	}
	return nil
}

func (c *SerialClient) processSeatStats(
	seat int,
	data [16]byte,
	tReqUs uint64,
	tRespUs uint64,
	passes []ClientPassEvent,
	hbRSSI *[domain.MaxPilotSlots]float32,
	hbFlags *[domain.MaxPilotSlots]bool,
	hbFreqs *[domain.MaxPilotSlots]uint16,
) []ClientPassEvent {
	lapID := int(data[0])
	passAgeMs := binary.BigEndian.Uint16(data[1:3])
	curRssi := float32(data[3])
	passPeak := float32(data[5])
	flags := data[8]
	passNadir := float32(data[9])

	hbRSSI[seat] = curRssi
	hbFlags[seat] = (flags & 0x01) != 0

	c.mu.Lock()
	defer c.mu.Unlock()

	hbFreqs[seat] = c.reportedFreqs[seat]
	prevLapID := c.lastLapID[seat]
	if prevLapID < 0 {
		c.lastLapID[seat] = lapID
		return passes
	}
	if lapID == prevLapID {
		return passes
	}
	c.lastLapID[seat] = lapID

	want := c.desiredNodes[seat]
	seatActive := !c.hasDesired || (want.Enabled && want.FrequencyMHz > 0)
	if !c.desiredArmed || !seatActive {
		return passes
	}

	readTimeUs := tRespUs
	if tRespUs >= tReqUs {
		readTimeUs = tRespUs - (tRespUs-tReqUs)/2
	}
	ageUs := uint64(passAgeMs) * 1000
	crossingUs := readTimeUs
	if crossingUs > ageUs {
		crossingUs -= ageUs
	}

	peak := passPeak
	if peak <= 0 {
		peak = curRssi
	}
	enterAt := c.reportedEnter[seat]
	if want.EnterAtLevel > 0 {
		enterAt = want.EnterAtLevel
	}
	if peak < float32(enterAt) {
		peak = float32(enterAt) + 12
	}

	freqMHz := c.reportedFreqs[seat]
	if want.FrequencyMHz > 0 {
		freqMHz = want.FrequencyMHz
	}

	c.passesRx++
	c.passingCounter++
	passes = append(passes, ClientPassEvent{
		SlotIndex:     seat + 1,
		FrequencyMHz:  freqMHz,
		HostTimeUs:    crossingUs,
		PeakRSSI:      peak,
		NadirRSSI:     passNadir,
		PassingNumber: c.passingCounter,
	})
	return passes
}

func (c *SerialClient) writeAndVerifyFreq(
	ctx context.Context,
	port SerialPort,
	seat int,
	apiLvl int,
	targetFreq uint16,
	isActiveChan bool,
	selectSeat func(seat int) error,
) error {
	var payload [2]byte
	binary.BigEndian.PutUint16(payload[:], targetFreq)

	for attempt := 0; attempt < 4; attempt++ {
		if err := selectSeat(seat); err != nil {
			return err
		}
		if err := c.writeCommand(port, CmdWriteFrequency, payload[:]); err != nil {
			return err
		}
		rb, err := c.readCommand(port, CmdReadFrequency, 2)
		if err != nil || len(rb) != 2 || binary.BigEndian.Uint16(rb) != targetFreq {
			continue
		}
		if apiLvl >= 36 && isActiveChan {
			if c.cfg.RxSettleDelay > 0 {
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(c.cfg.RxSettleDelay):
				}
			}
			rxReg, rxErr := c.readCommand(port, CmdTestRxRegister, 1)
			if rxErr == nil && len(rxReg) == 1 && rxReg[0] == 0 && attempt == 0 {
				continue
			}
		}
		return nil
	}
	return fmt.Errorf("failed to verify RotorHazard USB frequency %d MHz on seat %d", targetFreq, seat)
}

func (c *SerialClient) writeAndVerifyByte(
	port SerialPort,
	seat int,
	writeCmd byte,
	readCmd byte,
	val uint8,
	selectSeat func(seat int) error,
) error {
	for attempt := 0; attempt < 4; attempt++ {
		if err := selectSeat(seat); err != nil {
			return err
		}
		if err := c.writeCommand(port, writeCmd, []byte{val}); err != nil {
			return err
		}
		rb, err := c.readCommand(port, readCmd, 1)
		if err == nil && len(rb) == 1 && rb[0] == val {
			return nil
		}
	}
	return fmt.Errorf("failed to verify RotorHazard USB cmd 0x%02X=%d on seat %d", writeCmd, val, seat)
}

func (c *SerialClient) probeRevision(ctx context.Context, port SerialPort) (int, error) {
	deadline := time.Now().Add(c.cfg.BootTimeout)
	var lastErr error
	for {
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		c.flushInput(port)
		_ = port.SetReadTimeout(c.cfg.ReadTimeout)
		payload, err := c.readCommand(port, CmdReadRevisionCode, 2)
		if err == nil && len(payload) == 2 && payload[0] == RHRevisionHeaderByte && payload[1] >= 21 {
			return int(payload[1]), nil
		}
		if err != nil {
			lastErr = err
		} else {
			lastErr = fmt.Errorf("unexpected RotorHazard revision header: % x", payload)
		}
		if time.Now().After(deadline) {
			return 0, lastErr
		}
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-time.After(35 * time.Millisecond):
		}
	}
}

func (c *SerialClient) flushInput(port SerialPort) {
	if resetter, ok := port.(interface{ ResetInputBuffer() error }); ok {
		_ = resetter.ResetInputBuffer()
		return
	}
	_ = port.SetReadTimeout(10 * time.Millisecond)
	var scratch [256]byte
	for i := 0; i < 8; i++ {
		n, err := port.Read(scratch[:])
		if n == 0 || err != nil {
			break
		}
	}
	_ = port.SetReadTimeout(c.cfg.ReadTimeout)
}

func (c *SerialClient) writeCommand(port SerialPort, cmd byte, payload []byte) error {
	frame := make([]byte, 1+len(payload)+1)
	frame[0] = cmd
	copy(frame[1:], payload)
	frame[1+len(payload)] = serialChecksum(payload)
	off := 0
	for off < len(frame) {
		nw, err := port.Write(frame[off:])
		if nw > 0 {
			off += nw
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func (c *SerialClient) readCommand(port SerialPort, cmd byte, payloadLen int) ([]byte, error) {
	if _, err := port.Write([]byte{cmd}); err != nil {
		return nil, err
	}
	total := payloadLen + 1
	buf := make([]byte, total)
	off := 0
	deadline := time.Now().Add(c.cfg.ReadTimeout * 2)
	for off < total {
		nr, err := port.Read(buf[off:])
		if nr > 0 {
			off += nr
			continue
		}
		if err != nil {
			if strings.Contains(strings.ToLower(err.Error()), "timeout") && time.Now().Before(deadline) {
				continue
			}
			return nil, err
		}
		if time.Now().After(deadline) {
			return nil, ErrSerialTimeout
		}
	}
	payload := buf[:payloadLen]
	wantSum := serialChecksum(payload)
	if buf[payloadLen] != wantSum {
		return nil, fmt.Errorf("RotorHazard USB checksum mismatch on cmd 0x%02X: got 0x%02X want 0x%02X", cmd, buf[payloadLen], wantSum)
	}
	return payload, nil
}

func cleanASCII(b []byte) string {
	b = bytes.TrimRight(b, "\x00 \r\n\t")
	if idx := bytes.IndexByte(b, 0); idx >= 0 {
		b = b[:idx]
	}
	return strings.TrimSpace(string(b))
}
