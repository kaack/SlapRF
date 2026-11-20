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

const (
	// RHMinScanFreqMHz and RHMaxScanFreqMHz bound RotorHazard USB spectrum sweeps to 5180..5917 MHz
	// so every swept bin is accepted by both FPVGateC5MK (ESP32-C5) and standard RX5808 RH USB nodes.
	RHMinScanFreqMHz = 5180
	RHMaxScanFreqMHz = 5917
)

type serialScanOnceReq struct {
	startMHz int
	stopMHz  int
	stepMHz  int
	resCh    chan serialScanOnceResp
}

type serialScanOnceResp struct {
	pass domain.RHScanPass
	err  error
}

// NormalizeRHScanGrid clamps a requested sweep grid into 5180..5917 MHz with uniform step spacing.
func NormalizeRHScanGrid(startMHz, stopMHz, stepMHz int) (normStart, normStop, normStep int) {
	if stepMHz < 1 {
		stepMHz = 5
	} else if stepMHz > 50 {
		stepMHz = 50
	}
	if startMHz < RHMinScanFreqMHz {
		startMHz = RHMinScanFreqMHz
	}
	if startMHz > RHMaxScanFreqMHz-stepMHz {
		startMHz = RHMaxScanFreqMHz - stepMHz
	}
	if stopMHz <= startMHz {
		stopMHz = RHMaxScanFreqMHz
	}
	if stopMHz > RHMaxScanFreqMHz {
		stopMHz = RHMaxScanFreqMHz
	}
	if stopMHz < startMHz+stepMHz {
		stopMHz = startMHz + stepMHz
		if stopMHz > RHMaxScanFreqMHz {
			stopMHz = RHMaxScanFreqMHz
			startMHz = stopMHz - stepMHz
		}
	}
	return startMHz, stopMHz, stepMHz
}

// SerialClientConfig configures a RotorHazard binary serial master (`SerialClient`).
type SerialClientConfig struct {
	PortName         string
	BaudRate         int // 0 = auto-negotiate (115200 -> 921600)
	OpenPort         SerialPortOpener
	Hooks            ClientHooks
	PollInterval     time.Duration // Default: 80ms (~12.5 Hz, well inside 5s idle timeout)
	BootTimeout      time.Duration // Default: 2200ms (absorbs USB DTR/RTS bootloader chill + banner)
	ReadTimeout      time.Duration // Default: 150ms
	RxSettleDelay    time.Duration // Default: 30ms before TEST_RX_REGISTER (0x04) on API >= 36
	SweepSettleDelay time.Duration // Default: 35ms per multi-node frequency batch during spectrum scan
	NoRxSettleDelay  bool          // True for deterministic synchronous simulator loopback
	SweepFeed        func(freqs []uint16)
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

	scanLive          bool
	scanStartMHz      int
	scanStopMHz       int
	scanStepMHz       int
	scanSeq           uint64
	latestScan        *domain.RHScanPass
	scanOncePending   *serialScanOnceReq
	savedInitFreqs    [domain.MaxPilotSlots]uint16
	needsInitFreqSync bool

	wakeCh chan struct{}
}

// NewSerialClient constructs a RotorHazard binary serial master client.
func NewSerialClient(cfg SerialClientConfig) *SerialClient {
	if cfg.PollInterval <= 0 {
		cfg.PollInterval = 40 * time.Millisecond
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
	if cfg.SweepSettleDelay <= 0 && !cfg.NoRxSettleDelay {
		cfg.SweepSettleDelay = 25 * time.Millisecond
	}
	c := &SerialClient{
		cfg:          cfg,
		nodeCount:    1,
		desiredArmed: true,
		scanStartMHz: RHMinScanFreqMHz,
		scanStopMHz:  RHMaxScanFreqMHz,
		scanStepMHz:  5,
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

func (c *SerialClient) invalidateAppliedFreqsLocked() {
	for i := 0; i < domain.MaxPilotSlots; i++ {
		c.appliedFreqs[i] = -1
		c.lastLapID[i] = -1
	}
	if !c.hasDesired {
		c.needsInitFreqSync = true
	}
}

func (c *SerialClient) wake() {
	select {
	case c.wakeCh <- struct{}{}:
	default:
	}
}

// SetScanLive starts or stops continuous 0..255 RSSI spectrum sweeping across all receiver nodes.
// When stopped, configured timing frequencies are restored on the next serial cycle.
func (c *SerialClient) SetScanLive(active bool, startMHz, stopMHz, stepMHz int) {
	c.mu.Lock()
	if active {
		s, e, st := NormalizeRHScanGrid(startMHz, stopMHz, stepMHz)
		if !c.scanLive {
			c.savedInitFreqs = c.reportedFreqs
		}
		c.scanStartMHz = s
		c.scanStopMHz = e
		c.scanStepMHz = st
		c.scanLive = true
	} else {
		wasLive := c.scanLive
		c.scanLive = false
		c.latestScan = nil
		if wasLive {
			c.invalidateAppliedFreqsLocked()
		}
	}
	c.mu.Unlock()
	c.wake()
}

// IsScanLive reports whether continuous spectrum scan mode is active on this USB client.
func (c *SerialClient) IsScanLive() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.scanLive
}

// RunScanOnce queues a single full-band spectrum sweep on an asynchronous `RunOnce` session,
// waits for completion, and restores configured node frequencies before returning.
func (c *SerialClient) RunScanOnce(ctx context.Context, startMHz, stopMHz, stepMHz int) (domain.RHScanPass, error) {
	s, e, st := NormalizeRHScanGrid(startMHz, stopMHz, stepMHz)
	req := &serialScanOnceReq{
		startMHz: s,
		stopMHz:  e,
		stepMHz:  st,
		resCh:    make(chan serialScanOnceResp, 1),
	}

	c.mu.Lock()
	if !c.connected {
		c.mu.Unlock()
		return domain.RHScanPass{}, fmt.Errorf("RotorHazard USB device is not connected")
	}
	if !c.scanLive {
		c.savedInitFreqs = c.reportedFreqs
	}
	c.scanLive = false
	c.latestScan = nil
	if prev := c.scanOncePending; prev != nil {
		prev.resCh <- serialScanOnceResp{err: fmt.Errorf("superseded by newer spectrum scan")}
	}
	c.scanOncePending = req
	c.mu.Unlock()
	c.wake()

	select {
	case <-ctx.Done():
		return domain.RHScanPass{}, ctx.Err()
	case resp := <-req.resCh:
		return resp.pass, resp.err
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
	c.needsInitFreqSync = false
	isScanning := c.scanLive || c.scanOncePending != nil
	c.mu.Unlock()
	if !isScanning {
		c.wake()
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
	var scanCopy *domain.RHScanPass
	if c.latestScan != nil {
		vals := make([]float32, len(c.latestScan.Values))
		copy(vals, c.latestScan.Values)
		cp := *c.latestScan
		cp.Values = vals
		scanCopy = &cp
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
		ScanLive:        c.scanLive,
		LastScan:        scanCopy,
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
	c.scanLive = false
	c.latestScan = nil
	if pending := c.scanOncePending; pending != nil {
		c.scanOncePending = nil
		pending.resCh <- serialScanOnceResp{err: fmt.Errorf("RotorHazard USB device disconnected")}
	}
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
	if seat < 0 {
		s.curSeat = -1
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

// SweepOnce runs a single synchronous 0..255 RSSI spectrum sweep across `startMHz..stopMHz` on `s`
// and restores configured node frequencies immediately afterwards.
func (s *SerialSession) SweepOnce(ctx context.Context, startMHz, stopMHz, stepMHz int) (domain.RHScanPass, error) {
	normStart, normStop, normStep := NormalizeRHScanGrid(startMHz, stopMHz, stepMHz)
	s.client.mu.Lock()
	if !s.client.scanLive {
		s.client.savedInitFreqs = s.client.reportedFreqs
	}
	s.client.scanLive = false
	s.client.latestScan = nil
	s.client.mu.Unlock()

	pass, err := s.client.executeSweepPass(ctx, s.port, s.nodeCount, s.apiLvl, s.selectSeat, normStart, normStop, normStep, false)
	s.client.mu.Lock()
	s.client.invalidateAppliedFreqsLocked()
	s.client.mu.Unlock()
	if rErr := s.client.restoreFrequenciesAfterScan(ctx, s.port, s.nodeCount, s.apiLvl, s.selectSeat); rErr != nil && err == nil {
		err = rErr
	}
	return pass, err
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

		if c.IsScanLive() {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-c.wakeCh:
			case <-time.After(4 * time.Millisecond):
			}
			continue
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-c.wakeCh:
		case <-ticker.C:
		}
	}
}

func (c *SerialClient) executeSweepPass(
	ctx context.Context,
	port SerialPort,
	nodeCount int,
	apiLvl int,
	selectSeat func(seat int) error,
	startMHz int,
	stopMHz int,
	stepMHz int,
	isLive bool,
) (domain.RHScanPass, error) {
	if nodeCount < 1 {
		nodeCount = 1
	} else if nodeCount > domain.MaxPilotSlots {
		nodeCount = domain.MaxPilotSlots
	}
	startMHz, stopMHz, stepMHz = NormalizeRHScanGrid(startMHz, stopMHz, stepMHz)
	numBins := (stopMHz-startMHz)/stepMHz + 1
	freqs := make([]uint16, numBins)
	for i := 0; i < numBins; i++ {
		freqs[i] = uint16(startMHz + i*stepMHz)
	}

	disabledFreq := SeatDisabledFreqMHz
	if apiLvl < 24 {
		disabledFreq = LegacyDisabledFreq
	}

	tStartUs := c.nowUs()
	actualStop := startMHz + (numBins-1)*stepMHz
	values := make([]float32, numBins)
	c.mu.Lock()
	if c.latestScan != nil && c.latestScan.Start == startMHz && c.latestScan.Stop == actualStop && c.latestScan.Step == stepMHz && len(c.latestScan.Values) == numBins {
		copy(values, c.latestScan.Values)
	}
	c.mu.Unlock()

	var batchFreqs [domain.MaxPilotSlots]uint16
	for base := 0; base < numBins; base += nodeCount {
		if ctx.Err() != nil {
			return domain.RHScanPass{}, ctx.Err()
		}
		// If a live scan was cancelled mid-pass, abort early so timing nodes restore right away.
		if isLive && !c.IsScanLive() {
			return domain.RHScanPass{}, nil
		}

		batchLen := numBins - base
		if batchLen > nodeCount {
			batchLen = nodeCount
		}

		// Program all `nodeCount` seats by sending `CmdWriteCurNodeIndex` + `CmdWriteFrequency` per seat,
		// then verify the final seat's frequency once so all 8 frequency writes complete in ~12 ms.
		for seat := 0; seat < nodeCount; seat++ {
			if ctx.Err() != nil {
				return domain.RHScanPass{}, ctx.Err()
			}
			targetFreq := disabledFreq
			if seat < batchLen {
				targetFreq = avoidNewlineInFreqWrite(freqs[base+seat])
			}
			batchFreqs[seat] = targetFreq
			if err := c.writeCommand(port, CmdWriteCurNodeIndex, []byte{byte(seat)}); err != nil {
				return domain.RHScanPass{}, err
			}
			var payload [2]byte
			binary.BigEndian.PutUint16(payload[:], targetFreq)
			if err := c.writeCommand(port, CmdWriteFrequency, payload[:]); err != nil {
				return domain.RHScanPass{}, err
			}
		}
		_ = selectSeat(-1)
		if _, err := c.readCommand(port, CmdReadFrequency, 2); err != nil {
			return domain.RHScanPass{}, err
		}

		// Wait for the multi-node radio scan cycle to complete across all 8 seats.
		// After all 8 seats are programmed, `seat 0` is sampled first and `seat (batchLen-1)` is
		// sampled last in the scan cycle (`Core::scanCycle`). Polling `seat 0` until its reported
		// RSSI exceeds 1 confirms the retuned scan cycle has begun delivering settled samples.
		var r0Ready byte
		if !c.cfg.NoRxSettleDelay {
			if c.cfg.SweepSettleDelay > 0 {
				select {
				case <-ctx.Done():
					return domain.RHScanPass{}, ctx.Err()
				case <-time.After(c.cfg.SweepSettleDelay):
				}
			}
			for pollTry := 0; pollTry < 6; pollTry++ {
				if err := c.writeCommand(port, CmdWriteCurNodeIndex, []byte{0}); err != nil {
					return domain.RHScanPass{}, err
				}
				var r0 byte
				if apiLvl >= 32 {
					ps, err := c.readCommand(port, CmdReadLapPassStats, 8)
					if err != nil {
						return domain.RHScanPass{}, err
					}
					r0 = ps[3]
				} else {
					ls, err := c.readCommand(port, CmdReadLapStats, 16)
					if err != nil {
						return domain.RHScanPass{}, err
					}
					r0 = ls[3]
				}
				if r0 > 1 {
					r0Ready = r0
					values[base] = float32(r0)
					break
				}
				select {
				case <-ctx.Done():
					return domain.RHScanPass{}, ctx.Err()
				case <-time.After(10 * time.Millisecond):
				}
			}
		}
		if c.cfg.SweepFeed != nil {
			c.cfg.SweepFeed(batchFreqs[:nodeCount])
		}

		// Read seats `0..batchLen-1` (skipping seat 0 if already populated above).
		for seat := 0; seat < batchLen; seat++ {
			if seat == 0 && !c.cfg.NoRxSettleDelay && r0Ready > 1 {
				continue
			}
			if ctx.Err() != nil {
				return domain.RHScanPass{}, ctx.Err()
			}
			if err := c.writeCommand(port, CmdWriteCurNodeIndex, []byte{byte(seat)}); err != nil {
				return domain.RHScanPass{}, err
			}
			if apiLvl >= 32 {
				ps, err := c.readCommand(port, CmdReadLapPassStats, 8)
				if err != nil {
					return domain.RHScanPass{}, err
				}
				values[base+seat] = float32(ps[3])
				if !c.cfg.NoRxSettleDelay && values[base+seat] <= 1 {
					select {
					case <-ctx.Done():
						return domain.RHScanPass{}, ctx.Err()
					case <-time.After(12 * time.Millisecond):
					}
					if ps2, err2 := c.readCommand(port, CmdReadLapPassStats, 8); err2 == nil {
						values[base+seat] = float32(ps2[3])
					}
				}
			} else {
				ls, err := c.readCommand(port, CmdReadLapStats, 16)
				if err != nil {
					return domain.RHScanPass{}, err
				}
				values[base+seat] = float32(ls[3])
			}
		}
		_ = selectSeat(-1)

		// During a live continuous scan, publish an in-progress partial snapshot after every
		// 8-seat batch so the Spectrum chart sweeps progressively across the band at ~15-20 Hz.
		if isLive && base+nodeCount < numBins {
			tCurUs := c.nowUs()
			curMs := 1
			if tCurUs > tStartUs {
				curMs = int((tCurUs - tStartUs) / 1000)
				if curMs < 1 {
					curMs = 1
				}
			}
			c.mu.Lock()
			if c.scanLive {
				c.scanSeq++
				partVals := make([]float32, numBins)
				copy(partVals, values)
				c.latestScan = &domain.RHScanPass{
					Seq:     c.scanSeq,
					Start:   startMHz,
					Stop:    actualStop,
					Step:    stepMHz,
					PassMs:  curMs,
					Live:    true,
					Partial: true,
					Values:  partVals,
				}
			}
			c.mu.Unlock()
		}
	}

	tEndUs := c.nowUs()
	_ = selectSeat(-1)
	passMs := 1
	if tEndUs > tStartUs {
		passMs = int((tEndUs - tStartUs) / 1000)
		if passMs < 1 {
			passMs = 1
		}
	}

	c.mu.Lock()
	c.scanSeq++
	seq := c.scanSeq
	c.heartbeatsRx++
	c.mu.Unlock()

	return domain.RHScanPass{
		Seq:     seq,
		Start:   startMHz,
		Stop:    actualStop,
		Step:    stepMHz,
		PassMs:  passMs,
		Live:    isLive,
		Partial: false,
		Values:  values,
	}, nil
}

func (c *SerialClient) writeSweepSeatFreq(
	port SerialPort,
	selectSeat func(seat int) error,
	seat int,
	targetFreq uint16,
) error {
	var payload [2]byte
	binary.BigEndian.PutUint16(payload[:], targetFreq)
	for attempt := 0; attempt < 3; attempt++ {
		if err := selectSeat(seat); err != nil {
			return err
		}
		if err := c.writeCommand(port, CmdWriteFrequency, payload[:]); err != nil {
			return err
		}
		rb, err := c.readCommand(port, CmdReadFrequency, 2)
		if err != nil {
			return err
		}
		if len(rb) == 2 && binary.BigEndian.Uint16(rb) == targetFreq {
			return nil
		}
		_ = selectSeat(-1)
	}
	return nil
}

// avoidNewlineInFreqWrite nudges a sweep bin frequency by +1 MHz when its 2-byte big-endian
// representation `[hi, lo]` or its RotorHazard checksum `byte(hi+lo)` equals `0x0A` (`\n`).
// On FPVGateC5MK, the ~10 MHz band-power meter has a flat passband over +-1 MHz, and avoiding
// `0x0A` prevents `usbByte()` from ever seeing a newline byte inside binary frequency sweeps.
func avoidNewlineInFreqWrite(f uint16) uint16 {
	for tries := 0; tries < 3; tries++ {
		hi := byte(f >> 8)
		lo := byte(f)
		sum := hi + lo
		if hi != 0x0A && lo != 0x0A && sum != 0x0A {
			return f
		}
		if f < RHMaxScanFreqMHz {
			f++
		} else {
			f--
		}
	}
	return f
}

func (c *SerialClient) restoreFrequenciesAfterScan(
	ctx context.Context,
	port SerialPort,
	nodeCount int,
	apiLvl int,
	selectSeat func(seat int) error,
) error {
	c.mu.Lock()
	hasDesired := c.hasDesired
	desiredNodes := c.desiredNodes
	savedInit := c.savedInitFreqs
	needsInit := c.needsInitFreqSync
	c.needsInitFreqSync = false
	c.mu.Unlock()

	disabledFreq := SeatDisabledFreqMHz
	if apiLvl < 24 {
		disabledFreq = LegacyDisabledFreq
	}

	if hasDesired {
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
		return nil
	}

	if needsInit {
		for seat := 0; seat < nodeCount; seat++ {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			orig := savedInit[seat]
			targetFreq := disabledFreq
			isActiveChan := orig > 0 && orig != SeatDisabledFreqMHz
			if isActiveChan {
				targetFreq = orig
			}
			if err := c.writeAndVerifyFreq(ctx, port, seat, apiLvl, targetFreq, isActiveChan, selectSeat); err != nil {
				return err
			}
			c.mu.Lock()
			c.reportedFreqs[seat] = orig
			c.lastLapID[seat] = -1
			c.mu.Unlock()
		}
	}
	return nil
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
	onceReq := c.scanOncePending
	c.scanOncePending = nil
	scanLive := c.scanLive
	scanStart := c.scanStartMHz
	scanStop := c.scanStopMHz
	scanStep := c.scanStepMHz
	needsInitRestore := !scanLive && onceReq == nil && c.needsInitFreqSync
	c.mu.Unlock()

	if onceReq != nil {
		pass, err := c.executeSweepPass(ctx, port, nodeCount, apiLvl, selectSeat, onceReq.startMHz, onceReq.stopMHz, onceReq.stepMHz, false)
		c.mu.Lock()
		c.invalidateAppliedFreqsLocked()
		c.mu.Unlock()
		if rErr := c.restoreFrequenciesAfterScan(ctx, port, nodeCount, apiLvl, selectSeat); rErr != nil && err == nil {
			err = rErr
		}
		onceReq.resCh <- serialScanOnceResp{pass: pass, err: err}
		return err
	}

	if scanLive {
		c.mu.Lock()
		c.invalidateAppliedFreqsLocked()
		c.mu.Unlock()
		pass, err := c.executeSweepPass(ctx, port, nodeCount, apiLvl, selectSeat, scanStart, scanStop, scanStep, true)
		if err != nil {
			return err
		}
		if len(pass.Values) > 0 {
			c.mu.Lock()
			if c.scanLive {
				c.latestScan = &pass
			}
			c.mu.Unlock()
		}
		return nil
	}

	if needsInitRestore {
		if err := c.restoreFrequenciesAfterScan(ctx, port, nodeCount, apiLvl, selectSeat); err != nil {
			return err
		}
	}

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
		if nodeCount > 1 {
			if err := c.writeCommand(port, CmdWriteCurNodeIndex, []byte{byte(seat)}); err != nil {
				return err
			}
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
	_ = selectSeat(-1)

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

func (c *SerialClient) readExactBytes(port SerialPort, total int) error {
	_, err := c.readExactSlice(port, total)
	return err
}

func (c *SerialClient) readExactSlice(port SerialPort, total int) ([]byte, error) {
	buf := make([]byte, total)
	off := 0
	deadline := time.Now().Add(c.cfg.ReadTimeout * 4)
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
	return buf, nil
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
