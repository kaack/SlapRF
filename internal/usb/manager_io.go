package usb

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"slaprf/internal/firmware"
	"slaprf/internal/ingest"
)

// Connect opens `portName` on `slotIndex` (0..2), disarms the ESP32-C5 USB-Serial-JTAG latch,
// starts the stream demultiplexer, and probes `STATUS?` / `SLAPRF?`.
func (m *Manager) Connect(slotIndex int, portName string) (SlotSnapshot, error) {
	if slotIndex < 0 || slotIndex >= MaxUSBConnections {
		return SlotSnapshot{}, fmt.Errorf("invalid USB slot index %d", slotIndex)
	}
	portName = strings.TrimSpace(portName)
	if portName == "" {
		return SlotSnapshot{}, errors.New("missing serial port name")
	}

	// If another slot currently holds this exact port, disconnect it first.
	for i := 0; i < MaxUSBConnections; i++ {
		if i == slotIndex {
			continue
		}
		other := m.slots[i]
		other.mu.Lock()
		same := strings.EqualFold(other.portName, portName) && other.port != nil
		other.mu.Unlock()
		if same {
			_ = m.Disconnect(i)
		}
	}

	slot := m.slots[slotIndex]
	_ = m.closeSlotInternal(slot, false)

	port, err := m.openPort(portName, 115200)
	if err != nil {
		slot.mu.Lock()
		slot.lastError = err.Error()
		slot.mu.Unlock()
		m.broadcastPoolState()
		return SlotSnapshot{}, err
	}
	_ = port.SetReadTimeout(120 * time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	doneCh := make(chan struct{})

	slot.mu.Lock()
	slot.portName = portName
	slot.port = port
	slot.cancel = cancel
	slot.doneCh = doneCh
	slot.probing = true
	slot.reconnecting = false
	slot.reconnectAttempt = 0
	slot.reconnectFailed = false
	slot.authRejected = false
	slot.suspendedForSim = false
	slot.lastError = ""
	slot.lastStatus = nil
	slot.lastStatusAtMs = 0
	slot.lastRealJsonStatusMs = 0
	slot.lastConfig = nil
	slot.sawRomBootloader = false
	slot.hubOwnFrames = 0
	slot.hubLastDbm = nil
	slot.hubHello = make(map[uint8]slotHello)
	slot.hubLive = make(map[uint8]slotLive)
	slot.mu.Unlock()

	if slotIndex == 1 {
		m.SetDebugSlot(1)
	}
	m.saveSlotTarget(slotIndex, portName)
	m.broadcastPoolState()

	go m.runSlotLoops(ctx, slot, port, portName, doneCh)

	probeTimeout := 1200 * time.Millisecond
	if IsBLEPortName(portName) {
		probeTimeout = 1800 * time.Millisecond
	}
	// Probe initial status/config without blocking forever if it's an unprogrammed board.
	_, _ = m.probeInitialStatus(slot, probeTimeout)

	slot.mu.Lock()
	authRej := slot.authRejected
	rejMsg := slot.lastError
	if slot.probing {
		slot.probing = false
	}
	stAfter := slot.lastStatus
	cfgAfter := slot.lastConfig
	slot.mu.Unlock()

	if authRej {
		if rejMsg == "" {
			rejMsg = defaultBLEAuthMismatchMsg
		}
		_ = m.closeSlotInternal(slot, true)
		slot.mu.Lock()
		slot.lastError = rejMsg
		slot.reconnectFailed = true
		slot.authRejected = true
		slot.mu.Unlock()
		m.removePersistedBLETarget(portName)
		m.broadcastPoolState()
		return m.Snapshot().Slots[slotIndex], errors.New(rejMsg)
	}

	// A Bluetooth port (`ble:<FP>`) is always a Hub whose 8-hex fingerprint is known upfront from its
	// advertisement. Ensure `lastStatus` is populated immediately even if the first full JSON status
	// line is still in transit across BLE notifications.
	if stAfter == nil {
		if bleFP, ok := ParseBLEPortName(portName); ok {
			m.mu.RLock()
			known := m.knownTimers[bleFP]
			m.mu.RUnlock()
			slot.mu.Lock()
			if slot.port != nil && slot.lastStatus == nil {
				if _, hasH1 := slot.hubHello[1]; !hasH1 {
					lbl := ""
					if slot.lastConfig != nil {
						lbl = slot.lastConfig.TimerLabel
					}
					if lbl == "" {
						lbl = known.Label
					}
					if lbl == "" {
						lbl = "H1"
					}
					slot.hubHello[1] = slotHello{fp: bleFP, label: lbl, role: 1, sweepHz: 100}
				}
				stAfter = m.synthesizeHubStatusLocked(slot, time.Now().UnixMilli())
			} else {
				stAfter = slot.lastStatus
			}
			slot.mu.Unlock()
		}
	}

	m.registerConnectedHubInEngine(stAfter, cfgAfter)
	m.broadcastPoolState()
	return m.Snapshot().Slots[slotIndex], nil
}

// Disconnect closes the serial port on `slotIndex` and clears its persisted auto-connect target.
func (m *Manager) Disconnect(slotIndex int) error {
	if slotIndex < 0 || slotIndex >= MaxUSBConnections {
		return fmt.Errorf("invalid USB slot index %d", slotIndex)
	}
	slot := m.slots[slotIndex]
	slot.mu.Lock()
	prevPort := slot.portName
	slot.mu.Unlock()
	err := m.closeSlotInternal(slot, true)
	if slotIndex == 1 {
		m.SetDebugSlot(0)
	}
	m.clearSlotTarget(slotIndex, prevPort)
	m.broadcastPoolState()
	return err
}

func (m *Manager) closeSlotInternal(slot *usbSlot, clearPortName bool) error {
	slot.mu.Lock()
	cancel := slot.cancel
	doneCh := slot.doneCh
	port := slot.port
	slot.cancel = nil
	slot.doneCh = nil
	slot.port = nil
	slot.probing = false
	if clearPortName {
		slot.portName = ""
		slot.suspendedForSim = false
		slot.reconnecting = false
		slot.reconnectAttempt = 0
		slot.reconnectFailed = false
		slot.authRejected = false
		slot.lastStatus = nil
		slot.lastConfig = nil
	}
	waiters := slot.waiters
	slot.waiters = nil
	slot.mu.Unlock()

	for _, w := range waiters {
		close(w.ch)
	}
	if cancel != nil {
		cancel()
	}
	var closeErr error
	if port != nil {
		closeErr = port.Close()
	}
	if doneCh != nil {
		select {
		case <-doneCh:
		case <-time.After(800 * time.Millisecond):
		}
	}
	return closeErr
}

func (m *Manager) saveSlotTarget(slotIndex int, portName string) {
	portName = strings.TrimSpace(portName)
	if slotIndex < 0 || slotIndex >= MaxUSBConnections || portName == "" {
		return
	}
	isBLE := IsBLEPortName(portName)
	m.mu.Lock()
	if isBLE {
		for i := 0; i < MaxUSBConnections; i++ {
			if i != slotIndex && strings.EqualFold(m.savedBLETargets[i], portName) {
				m.savedBLETargets[i] = ""
			}
		}
		m.savedBLETargets[slotIndex] = portName
	} else {
		for i := 0; i < MaxUSBConnections; i++ {
			if i != slotIndex && strings.EqualFold(m.savedUSBTargets[i], portName) {
				m.savedUSBTargets[i] = ""
			}
		}
		m.savedUSBTargets[slotIndex] = portName
	}
	m.persistTargetsLocked(isBLE)
	m.mu.Unlock()
}

func (m *Manager) clearSlotTarget(slotIndex int, prevPort string) {
	if slotIndex < 0 || slotIndex >= MaxUSBConnections {
		return
	}
	m.mu.Lock()
	if prevPort != "" {
		isBLE := IsBLEPortName(prevPort)
		if isBLE {
			m.savedBLETargets[slotIndex] = ""
		} else {
			m.savedUSBTargets[slotIndex] = ""
		}
		m.persistTargetsLocked(isBLE)
	} else {
		if m.bleOnly {
			m.savedBLETargets[slotIndex] = ""
			m.persistTargetsLocked(true)
		} else {
			m.savedUSBTargets[slotIndex] = ""
			m.persistTargetsLocked(false)
		}
	}
	m.mu.Unlock()
}

func (m *Manager) removePersistedBLETarget(portName string) {
	portName = strings.TrimSpace(portName)
	if portName == "" {
		return
	}
	m.mu.Lock()
	changed := false
	for i := 0; i < MaxUSBConnections; i++ {
		if strings.EqualFold(m.savedBLETargets[i], portName) {
			m.savedBLETargets[i] = ""
			changed = true
		}
	}
	if changed {
		m.persistTargetsLocked(true)
	}
	m.mu.Unlock()
}

func (m *Manager) persistTargetsLocked(isBLE bool) {
	if m.cfg.Store == nil {
		return
	}
	targets := make(map[string]string)
	src := m.savedUSBTargets
	key := kvUSBTargetsKey
	if isBLE {
		src = m.savedBLETargets
		key = kvBLETargetsKey
	}
	for i := 0; i < MaxUSBConnections; i++ {
		if p := strings.TrimSpace(src[i]); p != "" {
			targets[fmt.Sprintf("%d", i)] = p
		}
	}
	_ = m.cfg.Store.PutJSON(key, targets)
}

func (m *Manager) probeInitialStatus(slot *usbSlot, timeout time.Duration) (map[string]any, error) {
	deadline := time.Now().Add(timeout)
	first := true
	rebootedOnce := false
	for time.Now().Before(deadline) {
		slot.mu.Lock()
		connected := slot.port != nil
		port := slot.port
		pName := slot.portName
		st := slot.lastStatus
		rom := slot.sawRomBootloader
		authRej := slot.authRejected
		rejErr := slot.lastError
		slot.mu.Unlock()
		if authRej {
			if rejErr == "" {
				rejErr = defaultBLEAuthMismatchMsg
			}
			return nil, errors.New(rejErr)
		}
		if !connected {
			return st, nil
		}
		if st != nil {
			return st, nil
		}
		isBLE := IsBLEPortName(pName)
		if rom && !rebootedOnce && !isBLE {
			rebootedOnce = true
			slot.mu.Lock()
			slot.sawRomBootloader = false
			slot.mu.Unlock()
			firmware.RebootESP32C5IntoApp(port)
			time.Sleep(850 * time.Millisecond)
			deadline = time.Now().Add(1500 * time.Millisecond)
			first = true
			continue
		}
		cmd := "STATUS?"
		if first {
			if isBLE {
				cmd = fmt.Sprintf("AUTH %s\nLIVE 0\nSCAN STOP\nLOG 0\nSTATUS?\nSLAPRF?", m.BLEHostKey())
			} else {
				cmd = "LIVE 0\nSCAN STOP\nLOG 0\nSTATUS?\nSLAPRF?"
			}
			first = false
		}
		res, err := m.RequestReply(slot.index, cmd, "status", 450*time.Millisecond)
		if err == nil {
			if stMap, ok := res.(map[string]any); ok {
				return stMap, nil
			}
		}
		slot.mu.Lock()
		authRejNow := slot.authRejected
		rejErrNow := slot.lastError
		hasAny := slot.lastStatus != nil || slot.lastConfig != nil
		stNow := slot.lastStatus
		slot.mu.Unlock()
		if authRejNow {
			if rejErrNow == "" {
				rejErrNow = defaultBLEAuthMismatchMsg
			}
			return nil, errors.New(rejErrNow)
		}
		if hasAny {
			return stNow, nil
		}
		if !isBLE && !rebootedOnce && time.Now().Add(200*time.Millisecond).After(deadline) {
			// Board was completely silent across initial STATUS? probes (e.g., sitting idle in
			// USB-Serial-JTAG ROM download mode after a reconnect or mode switch). Pulse a clean
			// SPI flash reboot once and give it 1.5s to answer.
			rebootedOnce = true
			slot.mu.Lock()
			slot.sawRomBootloader = false
			slot.mu.Unlock()
			firmware.RebootESP32C5IntoApp(port)
			time.Sleep(850 * time.Millisecond)
			deadline = time.Now().Add(1500 * time.Millisecond)
			first = true
			continue
		}
		time.Sleep(80 * time.Millisecond)
	}
	return nil, errors.New("status probe timed out")
}

// SendCommand writes an ASCII command line to `slotIndex`'s open serial port.
func (m *Manager) SendCommand(slotIndex int, cmd string) error {
	if slotIndex < 0 || slotIndex >= MaxUSBConnections {
		return fmt.Errorf("invalid USB slot index %d", slotIndex)
	}
	slot := m.slots[slotIndex]
	slot.mu.Lock()
	port := slot.port
	slot.mu.Unlock()
	if port == nil {
		return errors.New("USB port is not connected")
	}
	clean := strings.TrimRight(cmd, "\r\n") + "\n"
	slot.writeMu.Lock()
	_, err := port.Write([]byte(clean))
	slot.writeMu.Unlock()
	return err
}

// RequestReply sends `cmd` (if non-empty) and waits up to `timeout` for a message of `expectType` ("status", "config", "ok", "scan", "bootlog").
func (m *Manager) RequestReply(slotIndex int, cmd string, expectType string, timeout time.Duration) (any, error) {
	if slotIndex < 0 || slotIndex >= MaxUSBConnections {
		return nil, fmt.Errorf("invalid USB slot index %d", slotIndex)
	}
	slot := m.slots[slotIndex]
	w := &replyWaiter{
		msgType: expectType,
		ch:      make(chan any, 1),
	}
	slot.mu.Lock()
	if slot.port == nil {
		slot.mu.Unlock()
		return nil, errors.New("USB port is not connected")
	}
	slot.waiters = append(slot.waiters, w)
	slot.mu.Unlock()

	removeWaiter := func() {
		slot.mu.Lock()
		for i, cur := range slot.waiters {
			if cur == w {
				slot.waiters = append(slot.waiters[:i], slot.waiters[i+1:]...)
				break
			}
		}
		slot.mu.Unlock()
	}

	if strings.TrimSpace(cmd) != "" {
		if err := m.SendCommand(slotIndex, cmd); err != nil {
			removeWaiter()
			return nil, err
		}
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case val, ok := <-w.ch:
		if !ok {
			return nil, errors.New("USB port disconnected")
		}
		if errVal, isErr := val.(error); isErr {
			return nil, errVal
		}
		return val, nil
	case <-timer.C:
		removeWaiter()
		return nil, fmt.Errorf("timeout waiting for %s", expectType)
	}
}

func (m *Manager) resolveWaiters(slot *usbSlot, msgType string, val any) {
	slot.mu.Lock()
	var matched []*replyWaiter
	remaining := slot.waiters[:0]
	for _, w := range slot.waiters {
		if w.msgType == msgType {
			matched = append(matched, w)
		} else {
			remaining = append(remaining, w)
		}
	}
	slot.waiters = remaining
	slot.mu.Unlock()

	for _, w := range matched {
		select {
		case w.ch <- val:
		default:
		}
	}
}

func (m *Manager) failWaiters(slot *usbSlot, err error) {
	slot.mu.Lock()
	waiters := slot.waiters
	slot.waiters = nil
	slot.mu.Unlock()
	for _, w := range waiters {
		select {
		case w.ch <- err:
		default:
		}
	}
}

func (m *Manager) sendNetChannelsFrameToHub(pkt19 []byte) {
	if len(pkt19) < ingestHubChannelsLen || pkt19[0] != 0xC5 || pkt19[1] != 0x5E {
		return
	}
	parts := make([]string, 8)
	for i := 0; i < 8; i++ {
		freq := binary.LittleEndian.Uint16(pkt19[2+i*2 : 4+i*2])
		parts[i] = fmt.Sprintf("%d", freq)
	}
	m.SendToHub("NETCHANNELS " + strings.Join(parts, ","))
}

// SendToHub sends a console command to every connected Hub (role 1), or to Slot 0 if no slot has
// reported its role yet. Returns false if no USB board is connected.
func (m *Manager) SendToHub(cmd string) bool {
	sent := false
	for i := 0; i < MaxUSBConnections; i++ {
		s := m.slots[i]
		s.mu.Lock()
		isConn := s.port != nil
		isHub := false
		if s.lastStatus != nil {
			if rNum, ok := asInt(s.lastStatus["role"]); ok && rNum == 1 {
				isHub = true
			}
		} else if s.lastConfig != nil && s.lastConfig.Role == "hub" {
			isHub = true
		}
		s.mu.Unlock()
		if isConn && isHub {
			_ = m.SendCommand(i, cmd)
			sent = true
		}
	}
	if !sent {
		s0 := m.slots[0]
		s0.mu.Lock()
		isConn0 := s0.port != nil
		s0.mu.Unlock()
		if isConn0 {
			_ = m.SendCommand(0, cmd)
			sent = true
		}
	}
	return sent
}

const ingestHubChannelsLen = 19

func (m *Manager) runSlotLoops(ctx context.Context, slot *usbSlot, port firmware.SerialPort, portName string, doneCh chan struct{}) {
	defer close(doneCh)

	// Watchdog poll loop: if the board hasn't sent a status heartbeat in 4s, gently nudge `STATUS?`.
	go func() {
		ticker := time.NewTicker(4 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				slot.mu.Lock()
				lastMs := slot.lastStatusAtMs
				hasPort := slot.port == port
				slot.mu.Unlock()
				if !hasPort {
					return
				}
				if time.Now().UnixMilli()-lastMs > 4000 {
					_ = m.SendCommand(slot.index, "STATUS?")
				}
			}
		}
	}()

	var rxBuf []byte
	tmp := make([]byte, 4096)
	unexpectedDrop := false

	for {
		if ctx.Err() != nil {
			break
		}
		n, err := port.Read(tmp)
		if n > 0 {
			rxBuf = append(rxBuf, tmp[:n]...)
			rxBuf = m.parseSlotBuffer(slot, rxBuf)
			slot.mu.Lock()
			authRej := slot.authRejected
			slot.mu.Unlock()
			if authRej {
				unexpectedDrop = true
				break
			}
		}
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			// Timeout with n == 0 is normal on serial ports with ReadTimeout configured.
			errLower := strings.ToLower(err.Error())
			if strings.Contains(errLower, "timeout") {
				continue
			}
			if errors.Is(err, io.EOF) && n == 0 {
				// On POSIX/Windows USB unplug or BLE disconnect surfaces as EOF.
				unexpectedDrop = true
				break
			}
			unexpectedDrop = true
			slot.mu.Lock()
			if !slot.authRejected {
				slot.lastError = err.Error()
			}
			authRej := slot.authRejected
			slot.mu.Unlock()
			if !authRej {
				m.emit(USBEvent{Type: "error", SlotIndex: slot.index, Error: err.Error()})
			}
			break
		}
	}

	if unexpectedDrop && ctx.Err() == nil {
		_ = port.Close()
		slot.mu.Lock()
		authRej := slot.authRejected
		rejMsg := slot.lastError
		if slot.port == port {
			slot.port = nil
			slot.probing = false
			slot.lastStatus = nil
			slot.lastConfig = nil
			if authRej {
				slot.portName = ""
				slot.reconnecting = false
				slot.reconnectFailed = true
			}
		}
		slot.mu.Unlock()
		if authRej {
			if rejMsg == "" {
				rejMsg = defaultBLEAuthMismatchMsg
			}
			m.removePersistedBLETarget(portName)
			m.failWaiters(slot, errors.New(rejMsg))
			m.broadcastPoolState()
			return
		}
		m.failWaiters(slot, errors.New("USB disconnected"))
		m.broadcastPoolState()
		go m.attemptAutoReconnect(slot, portName)
	}
}

func (m *Manager) attemptAutoReconnect(slot *usbSlot, portName string) {
	slot.mu.Lock()
	if slot.reconnecting || slot.authRejected {
		slot.mu.Unlock()
		return
	}
	slot.reconnecting = true
	slot.reconnectFailed = false
	slot.reconnectAttempt = 0
	slot.mu.Unlock()
	m.broadcastPoolState()

	for attempt := 1; attempt <= 5; attempt++ {
		m.mu.RLock()
		closed := m.closed
		sim := m.simMode
		m.mu.RUnlock()
		if closed || sim {
			slot.mu.Lock()
			slot.reconnecting = false
			slot.mu.Unlock()
			m.broadcastPoolState()
			return
		}
		slot.mu.Lock()
		if slot.port != nil || slot.portName == "" || slot.authRejected {
			slot.reconnecting = false
			slot.mu.Unlock()
			m.broadcastPoolState()
			return
		}
		slot.reconnectAttempt = attempt
		slot.mu.Unlock()
		m.broadcastPoolState()

		time.Sleep(1200 * time.Millisecond)

		slot.mu.Lock()
		slotBusy := slot.port != nil || slot.portName == "" || slot.authRejected
		slot.mu.Unlock()
		if slotBusy {
			slot.mu.Lock()
			slot.reconnecting = false
			slot.mu.Unlock()
			m.broadcastPoolState()
			return
		}

		if _, err := m.Connect(slot.index, portName); err == nil {
			return
		}
		slot.mu.Lock()
		authRej := slot.authRejected
		slot.mu.Unlock()
		if authRej {
			return
		}
	}

	slot.mu.Lock()
	slot.reconnecting = false
	slot.reconnectFailed = true
	if IsBLEPortName(portName) {
		slot.lastError = "Lost Bluetooth Hub connection after 5 reconnect attempts."
	} else {
		slot.lastError = "Lost USB connection after 5 reconnect attempts."
	}
	slot.mu.Unlock()
	m.broadcastPoolState()

	// Continue watching quietly for the USB cable to be plugged back in unless the user disconnects
	// or selects another port.
	for {
		time.Sleep(1500 * time.Millisecond)
		m.mu.RLock()
		closed := m.closed
		sim := m.simMode
		m.mu.RUnlock()
		if closed || sim {
			return
		}
		slot.mu.Lock()
		stillWaiting := slot.port == nil && strings.EqualFold(slot.portName, portName) && portName != ""
		slot.mu.Unlock()
		if !stillWaiting {
			return
		}
		if ports, err := m.listFn(); err == nil {
			present := false
			for _, p := range ports {
				if strings.EqualFold(p.Name, portName) {
					present = true
					break
				}
			}
			if !present {
				continue
			}
		}
		if _, err := m.Connect(slot.index, portName); err == nil {
			return
		}
	}
}

func isValidHubFrame(frame []byte) bool {
	if len(frame) < 4 || frame[0] != 0xC5 {
		return false
	}
	var crc byte
	for i := 0; i < len(frame)-1; i++ {
		crc ^= frame[i]
	}
	return crc == frame[len(frame)-1]
}

func (m *Manager) parseSlotBuffer(slot *usbSlot, buf []byte) []byte {
	pos := 0
	end := len(buf)

	for pos < end {
		recAt := bytes.IndexByte(buf[pos:end], pktRecordSep)
		if recAt >= 0 {
			recAt += pos
		}
		nl := bytes.IndexByte(buf[pos:end], '\n')
		if nl >= 0 {
			nl += pos
		}
		limit := end
		if recAt >= 0 {
			limit = recAt
		}
		if nl >= 0 && nl < limit {
			limit = nl
		}
		magicAt := -1
		if searchEnd := minInt(end, limit+len(configMagic)-1); searchEnd > pos {
			if idx := bytes.Index(buf[pos:searchEnd], configMagic); idx >= 0 && pos+idx < limit {
				magicAt = pos + idx
			}
		}

		// 1. Binary Hub packet record: [0x1E][len][0xC5 ... crc8]
		if recAt >= 0 && (nl < 0 || recAt < nl) && (magicAt < 0 || recAt < magicAt) {
			if end < recAt+2 {
				break
			}
			pktLen := int(buf[recAt+1])
			if end < recAt+2+pktLen {
				break
			}
			if recAt > pos {
				m.emitTextLine(slot, buf[pos:recAt])
			}
			frame := buf[recAt+2 : recAt+2+pktLen]
			if isValidHubFrame(frame) {
				m.handleHubBinaryFrame(slot, frame)
				pos = recAt + 2 + pktLen
			} else {
				pos = recAt + 1
			}
			continue
		}

		// 2. 160-byte SLAPRF02 binary configuration readout
		if magicAt >= 0 && (nl < 0 || magicAt < nl) {
			if end < magicAt+configBlockLen {
				break
			}
			if magicAt > pos {
				m.emitTextLine(slot, buf[pos:magicAt])
			}
			if cfg, ok := firmware.ParseConfigReadout(buf[magicAt : magicAt+configBlockLen]); ok && cfg != nil {
				slot.mu.Lock()
				slot.probing = false
				slot.lastConfig = cfg
				slot.mu.Unlock()
				m.recordKnownConfig(cfg)
				m.resolveWaiters(slot, "config", cfg)
				m.emit(USBEvent{Type: "config", SlotIndex: slot.index, Config: cfg})
				m.broadcastPoolState()
			}
			pos = magicAt + configBlockLen
			continue
		}

		// 3. Newline-delimited @JSON or plain console log line
		if nl < 0 {
			if end-pos > 16384 {
				m.emitTextLine(slot, buf[pos:end])
				pos = end
			}
			break
		}
		m.emitTextLine(slot, buf[pos:nl])
		pos = nl + 1
	}

	if pos >= end {
		return buf[:0]
	}
	remaining := make([]byte, end-pos)
	copy(remaining, buf[pos:end])
	return remaining
}

func (m *Manager) handleHubBinaryFrame(slot *usbSlot, frame []byte) {
	// Feed directly into the native Go realEngine HubFrameDecoder!
	m.mu.RLock()
	simRunning := m.simMode
	m.mu.RUnlock()
	if !simRunning && m.cfg.HubRx != nil && m.cfg.Engine != nil {
		m.cfg.HubRx.IngestPacket(frame, m.cfg.Engine.NowUs())
	}

	if len(frame) < 16 || frame[0] != 0xC5 || frame[2] < 1 || frame[2] > 7 {
		return
	}
	tdmaSlot := frame[2]
	kind := frame[1]
	nowMs := time.Now().UnixMilli()

	slot.mu.Lock()
	switch {
	case kind == 0x5A && len(frame) >= 36:
		role := frame[3]
		fpNum := binary.LittleEndian.Uint32(frame[4:8])
		fp := fmt.Sprintf("%08X", fpNum)
		sweepHz := frame[9]
		if sweepHz == 0 {
			sweepHz = 50
		}
		labelBytes := frame[10:34]
		if nul := bytes.IndexByte(labelBytes, 0); nul >= 0 {
			labelBytes = labelBytes[:nul]
		}
		label := strings.TrimSpace(string(labelBytes))
		if label == "" {
			if tdmaSlot == 1 {
				label = "H1"
			} else {
				label = fmt.Sprintf("T%d", tdmaSlot-1)
			}
		}
		slot.hubHello[tdmaSlot] = slotHello{fp: fp, label: label, role: role, sweepHz: sweepHz}

	case kind == ingest.FrameMagicWindow:
		sampleCount := int(frame[3])
		if sampleCount >= 1 && len(frame) >= 7+sampleCount*9+1 {
			floor := int(int8(frame[6]))
			newestOff := 7 + (sampleCount-1)*9
			seq := frame[newestOff]
			dbm := make([]float64, 8)
			for ch := 0; ch < 8; ch++ {
				best := float64(ingest.DecodeHalfDbm(frame[newestOff+1+ch]))
				for s := 0; s < sampleCount; s++ {
					v := float64(ingest.DecodeHalfDbm(frame[7+s*9+1+ch]))
					if v > best {
						best = v
					}
				}
				dbm[ch] = best
			}
			prev := slot.hubLive[tdmaSlot]
			slot.hubLive[tdmaSlot] = slotLive{
				frames:        prev.frames + 1,
				lastFrameAtMs: nowMs,
				seq:           seq,
				dbm:           dbm,
				floor:         floor,
			}
			if tdmaSlot == 1 {
				slot.hubOwnFrames++
				slot.hubLastDbm = dbm
			}
		}

	case kind == ingest.FrameMagicSingle && len(frame) >= 16:
		seq := frame[3]
		floor := int(int8(frame[6]))
		dbm := make([]float64, 8)
		for ch := 0; ch < 8; ch++ {
			dbm[ch] = float64(ingest.DecodeHalfDbm(frame[7+ch]))
		}
		prev := slot.hubLive[tdmaSlot]
		slot.hubLive[tdmaSlot] = slotLive{
			frames:        prev.frames + 1,
			lastFrameAtMs: nowMs,
			seq:           seq,
			dbm:           dbm,
			floor:         floor,
		}
		if tdmaSlot == 1 {
			slot.hubOwnFrames++
			slot.hubLastDbm = dbm
		}
	}
	synth := m.synthesizeHubStatusLocked(slot, nowMs)
	var hubLive map[string]any
	if (kind == ingest.FrameMagicWindow || kind == ingest.FrameMagicSingle) && nowMs-slot.hubLiveEmitMs >= hubLiveEmitIntervalMs {
		slot.hubLiveEmitMs = nowMs
		hubLive = hubLivePayloadLocked(slot, nowMs)
	}
	slot.mu.Unlock()

	if hubLive != nil {
		m.emit(USBEvent{Type: "hub_live", SlotIndex: slot.index, Payload: hubLive})
	}
	if synth != nil {
		m.recordKnownStatusMap(synth)
		m.resolveWaiters(slot, "status", synth)
		m.emit(USBEvent{Type: "status", SlotIndex: slot.index, Status: synth})
		m.broadcastPoolState()
	}
}

// hubLiveEmitIntervalMs throttles "hub_live" events to 20 Hz. The firmware's JSON STATUS line only
// arrives about once per second, which made the Network page's RSSI bars look sluggish.
const hubLiveEmitIntervalMs = 50

// hubLivePayloadLocked returns the newest RSSI window of every TDMA slot the Hub forwarded.
// Callers hold slot.mu.
func hubLivePayloadLocked(slot *usbSlot, nowMs int64) map[string]any {
	slots := make([]map[string]any, 0, len(slot.hubLive))
	for tdma, l := range slot.hubLive {
		slots = append(slots, map[string]any{
			"slot":   tdma,
			"dbm":    l.dbm,
			"seq":    l.seq,
			"frames": l.frames,
			"floor":  l.floor,
			"ageMs":  nowMs - l.lastFrameAtMs,
		})
	}
	return map[string]any{"slots": slots, "hubOwnFrames": slot.hubOwnFrames}
}

func (m *Manager) synthesizeHubStatusLocked(slot *usbSlot, nowMs int64) map[string]any {
	if slot.lastRealJsonStatusMs > 0 && nowMs-slot.lastRealJsonStatusMs < 2500 {
		return nil
	}
	h1, hasH1 := slot.hubHello[1]
	if slot.hubOwnFrames == 0 && !hasH1 {
		return nil
	}
	if slot.lastStatus != nil && nowMs-slot.lastStatusAtMs < 500 && !slot.probing && len(slot.waiters) == 0 {
		return nil
	}
	fp := h1.fp
	if fp == "" && slot.lastConfig != nil {
		fp = slot.lastConfig.Fingerprint
	}
	if fp == "" && slot.lastStatus != nil {
		fp, _ = slot.lastStatus["fp"].(string)
	}
	if fp == "" {
		if bleFP, ok := ParseBLEPortName(slot.portName); ok {
			fp = bleFP
		}
	}
	if fp == "" {
		return nil
	}
	label := h1.label
	if label == "" && slot.lastConfig != nil {
		label = slot.lastConfig.TimerLabel
	}
	if label == "" {
		label = "H1"
	}
	sweepHz := int(h1.sweepHz)
	if sweepHz <= 0 {
		sweepHz = 100
	}
	live1 := slot.hubLive[1]
	floorDb := -90
	if live1.frames > 0 {
		floorDb = live1.floor
	}
	spokes := make([]map[string]any, 0)
	for sIdx := uint8(2); sIdx <= 7; sIdx++ {
		sh, ok := slot.hubHello[sIdx]
		if !ok || sh.fp == "" || strings.HasPrefix(sh.fp, "53504B") {
			continue
		}
		sl := slot.hubLive[sIdx]
		sp := map[string]any{
			"slot":   int(sIdx),
			"fp":     sh.fp,
			"label":  sh.label,
			"fw":     latestFirmwareText,
			"online": true,
			"msAgo":  maxInt64(0, nowMs-sl.lastFrameAtMs),
			"frames": sl.frames,
			"seq":    int(sl.seq),
		}
		if len(sl.dbm) > 0 {
			sp["dbm"] = sl.dbm
		}
		spokes = append(spokes, sp)
	}
	freqs := []int{5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917}
	if slot.lastConfig != nil && len(slot.lastConfig.FrequenciesMHz) > 0 {
		freqs = make([]int, len(slot.lastConfig.FrequenciesMHz))
		for i, v := range slot.lastConfig.FrequenciesMHz {
			freqs[i] = int(v)
		}
	}
	st := map[string]any{
		"t":              "status",
		"fw":             latestFirmwareText,
		"role":           1,
		"fp":             fp,
		"label":          label,
		"uptimeMs":       1000,
		"reset":          "usb",
		"boots":          1,
		"heapFree":       56800,
		"heapMin":        56200,
		"sweepHz":        sweepHz,
		"sweeps":         slot.hubOwnFrames * 4,
		"sweepUs":        6100,
		"sweepUsMax":     6650,
		"sweepBudgetUs":  7000,
		"rf":             map[string]any{"ok": true, "enabled": true, "gain": 30, "gainMax": 80, "floorDb": floorDb},
		"chip":           map[string]any{"model": "ESP32-C5", "rev": "v1.0", "mac": "", "flashMB": 8},
		"net":            map[string]any{"mode": "espnow-lr", "stations": len(spokes)},
		"channel":        1,
		"slot":           1,
		"freqsTemporary": false,
		"chanMask":       255,
		"freqs":          freqs,
		"dbm":            slot.hubLastDbm,
		"spokes":         spokes,
	}
	slot.probing = false
	slot.lastStatus = st
	slot.lastStatusAtMs = nowMs
	return st
}

func (m *Manager) emitTextLine(slot *usbSlot, raw []byte) {
	lineStr := strings.TrimRight(string(raw), "\r")
	if lineStr == "" {
		return
	}
	if strings.Contains(lineStr, "invalid header:") || strings.Contains(lineStr, "waiting for download") {
		slot.mu.Lock()
		slot.sawRomBootloader = true
		slot.mu.Unlock()
		m.failWaiters(slot, errors.New("ROM bootloader detected"))
	}
	if atIdx := strings.LastIndex(lineStr, "@{"); atIdx >= 0 {
		jsonLine := lineStr[atIdx:]
		var msg map[string]any
		if err := json.Unmarshal([]byte(jsonLine[1:]), &msg); err == nil {
			tStr, _ := msg["t"].(string)
			m.emit(USBEvent{Type: "raw_reply", SlotIndex: slot.index, Line: jsonLine, MsgType: tStr})
			if tStr == "err" {
				codeStr, _ := msg["code"].(string)
				errMsg, _ := msg["msg"].(string)
				if codeStr == "auth_mismatch" || codeStr == "unpaired" {
					if strings.TrimSpace(errMsg) == "" {
						errMsg = defaultBLEAuthMismatchMsg
					}
					slot.mu.Lock()
					pName := slot.portName
					slot.authRejected = true
					slot.probing = false
					slot.reconnecting = false
					slot.reconnectFailed = true
					slot.lastError = errMsg
					slot.mu.Unlock()
					m.removePersistedBLETarget(pName)
					m.emit(USBEvent{Type: "error", SlotIndex: slot.index, Error: errMsg})
					m.failWaiters(slot, errors.New(errMsg))
					m.broadcastPoolState()
					return
				}
				if errMsg == "" {
					errMsg = "command refused"
				}
				m.failWaiters(slot, errors.New(errMsg))
				return
			}
			m.resolveWaiters(slot, tStr, msg)
			switch tStr {
			case "status":
				nowMs := time.Now().UnixMilli()
				slot.mu.Lock()
				slot.probing = false
				slot.lastStatus = msg
				slot.lastStatusAtMs = nowMs
				slot.lastRealJsonStatusMs = nowMs
				slot.mu.Unlock()
				m.recordKnownStatusMap(msg)
				m.emit(USBEvent{Type: "status", SlotIndex: slot.index, Status: msg})
				m.broadcastPoolState()
				return
			case "live":
				m.emit(USBEvent{Type: "live", SlotIndex: slot.index, Payload: msg})
				return
			case "scan":
				m.emit(USBEvent{Type: "scan", SlotIndex: slot.index, Payload: msg})
				return
			case "bootlog":
				m.emit(USBEvent{Type: "bootlog", SlotIndex: slot.index, Payload: msg})
				return
			default:
				return
			}
		}
	}
	m.emit(USBEvent{Type: "log", SlotIndex: slot.index, Line: lineStr})
}

func (m *Manager) recordKnownConfig(cfg *firmware.TimerReadout) {
	if cfg == nil {
		return
	}
	slot := 0
	if cfg.Role == "hub" {
		slot = 1
	}
	m.upsertKnownTimer(KnownHardwareTimer{
		FP:         cfg.Fingerprint,
		Role:       cfg.Role,
		Label:      cfg.TimerLabel,
		FW:         cfg.FirmwareVersion,
		Slot:       slot,
		Channel:    1,
		LastSeenMs: time.Now().UnixMilli(),
	})
	m.registerConnectedHubInEngine(nil, cfg)
}

func (m *Manager) registerConnectedHubInEngine(st map[string]any, cfg *firmware.TimerReadout) {
	m.mu.RLock()
	simRunning := m.simMode
	m.mu.RUnlock()
	if simRunning || m.cfg.Engine == nil {
		return
	}
	if st != nil {
		if roleNum, _ := asInt(st["role"]); roleNum == 1 {
			fp, _ := st["fp"].(string)
			label, _ := st["label"].(string)
			if fp != "" {
				if tid, err := m.cfg.Engine.RegisterTimerHello(fp, true, label); err == nil && tid != 0 {
					m.cfg.Engine.MarkTimerSeen(tid)
				}
			}
			if rawSpokes, ok := st["spokes"].([]any); ok {
				for _, item := range rawSpokes {
					if sp, ok := item.(map[string]any); ok {
						spFp, _ := sp["fp"].(string)
						spLabel, _ := sp["label"].(string)
						if spFp != "" && !strings.HasPrefix(spFp, "53504B") && !m.cfg.Engine.IsDeletedSpokeFingerprint(spFp) {
							if tid, err := m.cfg.Engine.RegisterTimerHello(spFp, false, spLabel); err == nil && tid != 0 {
								m.cfg.Engine.MarkTimerSeen(tid)
							}
						}
					}
				}
			}
		}
	}
	if cfg != nil && cfg.Role == "hub" && cfg.Fingerprint != "" {
		if tid, err := m.cfg.Engine.RegisterTimerHello(cfg.Fingerprint, true, cfg.TimerLabel); err == nil && tid != 0 {
			m.cfg.Engine.MarkTimerSeen(tid)
		}
	}
}

func (m *Manager) recordKnownStatusMap(st map[string]any) {
	m.registerConnectedHubInEngine(st, nil)
	fp, _ := st["fp"].(string)
	roleNum, _ := asInt(st["role"])
	role := "spoke"
	if roleNum == 1 {
		role = "hub"
	}
	label, _ := st["label"].(string)
	fw, _ := st["fw"].(string)
	slotNum, _ := asInt(st["slot"])
	chNum, _ := asInt(st["channel"])
	if chNum <= 0 {
		chNum = 1
	}
	var mac string
	if chip, ok := st["chip"].(map[string]any); ok {
		mac, _ = chip["mac"].(string)
	}
	var parentHubFp string
	if hub, ok := st["hub"].(map[string]any); ok {
		parentHubFp, _ = hub["fp"].(string)
	}
	nowMs := time.Now().UnixMilli()
	m.upsertKnownTimer(KnownHardwareTimer{
		FP:          fp,
		Role:        role,
		Label:       label,
		FW:          fw,
		MAC:         mac,
		Slot:        slotNum,
		Channel:     chNum,
		ParentHubFP: parentHubFp,
		LastSeenMs:  nowMs,
	})

	if role == "hub" {
		if rawSpokes, ok := st["spokes"].([]any); ok {
			for _, item := range rawSpokes {
				if sp, ok := item.(map[string]any); ok {
					spFp, _ := sp["fp"].(string)
					spLabel, _ := sp["label"].(string)
					spFw, _ := sp["fw"].(string)
					spMac, _ := sp["mac"].(string)
					spSlot, _ := asInt(sp["slot"])
					m.upsertKnownTimer(KnownHardwareTimer{
						FP:          spFp,
						Role:        "spoke",
						Label:       spLabel,
						FW:          spFw,
						MAC:         spMac,
						Slot:        spSlot,
						Channel:     chNum,
						ParentHubFP: fp,
						LastSeenMs:  nowMs,
					})
				}
			}
		} else if typedSpokes, ok := st["spokes"].([]map[string]any); ok {
			for _, sp := range typedSpokes {
				spFp, _ := sp["fp"].(string)
				spLabel, _ := sp["label"].(string)
				spFw, _ := sp["fw"].(string)
				spMac, _ := sp["mac"].(string)
				spSlot, _ := asInt(sp["slot"])
				m.upsertKnownTimer(KnownHardwareTimer{
					FP:          spFp,
					Role:        "spoke",
					Label:       spLabel,
					FW:          spFw,
					MAC:         spMac,
					Slot:        spSlot,
					Channel:     chNum,
					ParentHubFP: fp,
					LastSeenMs:  nowMs,
				})
			}
		}
	}
}

func (m *Manager) upsertKnownTimer(entry KnownHardwareTimer) {
	fp := strings.ToUpper(strings.TrimSpace(entry.FP))
	if fp == "" || fp == "00000001" || strings.HasPrefix(fp, "SIM000") || strings.HasPrefix(fp, "53504B") {
		return
	}
	m.mu.Lock()
	prev, hadPrev := m.knownTimers[fp]
	role := entry.Role
	if role == "" {
		if hadPrev && prev.Role != "" {
			role = prev.Role
		} else {
			role = "hub"
		}
	}
	label := entry.Label
	if label == "" {
		if hadPrev && prev.Label != "" {
			label = prev.Label
		} else if role == "hub" {
			label = "H1"
		} else {
			label = "T1"
		}
	}
	fw := entry.FW
	if fw == "" && hadPrev {
		fw = prev.FW
	}
	mac := entry.MAC
	if mac == "" && hadPrev {
		mac = prev.MAC
	}
	slot := entry.Slot
	if slot == 0 && hadPrev {
		slot = prev.Slot
	}
	if slot == 0 && role == "hub" {
		slot = 1
	}
	channel := entry.Channel
	if channel <= 0 {
		if hadPrev && prev.Channel > 0 {
			channel = prev.Channel
		} else {
			channel = 1
		}
	}
	parentHub := strings.ToUpper(strings.TrimSpace(entry.ParentHubFP))
	if parentHub == "" && hadPrev {
		parentHub = prev.ParentHubFP
	}
	if role == "spoke" && slot >= 2 && parentHub == "" {
		var newestHub KnownHardwareTimer
		for _, kt := range m.knownTimers {
			if kt.Role == "hub" && kt.LastSeenMs >= newestHub.LastSeenMs {
				newestHub = kt
			}
		}
		parentHub = newestHub.FP
	}
	if role == "spoke" && slot >= 2 {
		for k, other := range m.knownTimers {
			if k != fp && other.Role == "spoke" && other.Slot == slot && (parentHub == "" || other.ParentHubFP == parentHub) {
				other.Slot = 0
				m.knownTimers[k] = other
			}
		}
	}
	if role == "hub" {
		parentHub = ""
	}
	merged := KnownHardwareTimer{
		FP:          fp,
		Role:        role,
		Label:       label,
		FW:          fw,
		MAC:         mac,
		Slot:        slot,
		Channel:     channel,
		ParentHubFP: parentHub,
		LastSeenMs:  entry.LastSeenMs,
	}
	m.knownTimers[fp] = merged

	list := make([]KnownHardwareTimer, 0, len(m.knownTimers))
	for _, kt := range m.knownTimers {
		list = append(list, kt)
	}
	m.mu.Unlock()

	if m.cfg.Store != nil {
		_ = m.cfg.Store.PutJSON(kvKnownTimersKey, list)
	}
}

// ForgetKnownTimer removes a persisted hardware timer fingerprint from `BoltStore`.
func (m *Manager) ForgetKnownTimer(fp string) {
	clean := strings.ToUpper(strings.TrimSpace(fp))
	if clean == "" {
		return
	}
	m.mu.Lock()
	delete(m.knownTimers, clean)
	list := make([]KnownHardwareTimer, 0, len(m.knownTimers))
	for _, kt := range m.knownTimers {
		list = append(list, kt)
	}
	m.mu.Unlock()
	if m.cfg.Store != nil {
		_ = m.cfg.Store.PutJSON(kvKnownTimersKey, list)
	}
	m.broadcastPoolState()
}

func asInt(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case float64:
		return int(n), true
	case int64:
		return int(n), true
	default:
		return 0, false
	}
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
