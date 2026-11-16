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
	firmware.DisarmUSBJtagLatch(port)
	_ = port.SetReadTimeout(120 * time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	doneCh := make(chan struct{})

	slot.mu.Lock()
	slot.portName = portName
	slot.port = port
	slot.cancel = cancel
	slot.doneCh = doneCh
	slot.probing = true
	slot.writing = false
	slot.busyLabel = ""
	slot.reconnecting = false
	slot.reconnectAttempt = 0
	slot.reconnectFailed = false
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
	m.persistUSBTargets()
	m.broadcastPoolState()

	go m.runSlotLoops(ctx, slot, port, portName, doneCh)

	// Probe initial status/config (up to ~1.2s) without blocking forever if it's an unprogrammed board.
	_, _ = m.probeInitialStatus(slot, 1200*time.Millisecond)

	slot.mu.Lock()
	if slot.probing {
		slot.probing = false
	}
	slot.mu.Unlock()
	m.broadcastPoolState()
	return m.Snapshot().Slots[slotIndex], nil
}

// Disconnect closes the serial port on `slotIndex` and clears its persisted auto-connect target.
func (m *Manager) Disconnect(slotIndex int) error {
	if slotIndex < 0 || slotIndex >= MaxUSBConnections {
		return fmt.Errorf("invalid USB slot index %d", slotIndex)
	}
	slot := m.slots[slotIndex]
	err := m.closeSlotInternal(slot, true)
	if slotIndex == 1 {
		m.SetDebugSlot(0)
	}
	m.persistUSBTargets()
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

func (m *Manager) persistUSBTargets() {
	if m.cfg.Store == nil {
		return
	}
	targets := make(map[string]string)
	for i := 0; i < MaxUSBConnections; i++ {
		s := m.slots[i]
		s.mu.Lock()
		if (s.port != nil || s.suspendedForSim) && s.portName != "" {
			targets[fmt.Sprintf("%d", i)] = s.portName
		}
		s.mu.Unlock()
	}
	_ = m.cfg.Store.PutJSON(kvUSBTargetsKey, targets)
}

func (m *Manager) probeInitialStatus(slot *usbSlot, timeout time.Duration) (map[string]any, error) {
	deadline := time.Now().Add(timeout)
	first := true
	for time.Now().Before(deadline) {
		slot.mu.Lock()
		connected := slot.port != nil
		st := slot.lastStatus
		rom := slot.sawRomBootloader
		slot.mu.Unlock()
		if !connected || rom {
			return st, nil
		}
		if st != nil {
			return st, nil
		}
		cmd := "STATUS?"
		if first {
			cmd = "LIVE 0\nSCAN STOP\nLOG 0\nSTATUS?\nSLAPRF?"
			first = false
		}
		res, err := m.RequestReply(slot.index, cmd, "status", 450*time.Millisecond)
		if err == nil {
			if stMap, ok := res.(map[string]any); ok {
				return stMap, nil
			}
		}
		slot.mu.Lock()
		hasAny := slot.lastStatus != nil || slot.lastConfig != nil
		stNow := slot.lastStatus
		slot.mu.Unlock()
		if hasAny {
			return stNow, nil
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
	cmd := "NETCHANNELS " + strings.Join(parts, ",")

	// Send to any connected Hub slot (role == 1), defaulting to Slot 0 if role not yet reported.
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
		}
	}
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
				// On POSIX/Windows USB unplug often surfaces as EOF or device error.
				unexpectedDrop = true
				break
			}
			unexpectedDrop = true
			slot.mu.Lock()
			slot.lastError = err.Error()
			slot.mu.Unlock()
			m.emit(USBEvent{Type: "error", SlotIndex: slot.index, Error: err.Error()})
			break
		}
	}

	if unexpectedDrop && ctx.Err() == nil {
		_ = port.Close()
		slot.mu.Lock()
		if slot.port == port {
			slot.port = nil
			slot.probing = false
			slot.lastStatus = nil
			slot.lastConfig = nil
		}
		slot.mu.Unlock()
		m.failWaiters(slot, errors.New("USB disconnected"))
		m.broadcastPoolState()
		go m.attemptAutoReconnect(slot, portName)
	}
}

func (m *Manager) attemptAutoReconnect(slot *usbSlot, portName string) {
	slot.mu.Lock()
	if slot.reconnecting || slot.writing {
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
		if slot.port != nil || slot.portName == "" || slot.writing {
			slot.reconnecting = false
			slot.mu.Unlock()
			m.broadcastPoolState()
			return
		}
		slot.reconnectAttempt = attempt
		slot.mu.Unlock()
		m.broadcastPoolState()

		time.Sleep(1200 * time.Millisecond)

		if _, err := m.Connect(slot.index, portName); err == nil {
			return
		}
	}

	slot.mu.Lock()
	slot.reconnecting = false
	slot.reconnectFailed = true
	slot.lastError = "Lost USB connection after 5 reconnect attempts."
	slot.mu.Unlock()
	m.broadcastPoolState()
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

	case kind == 0x59:
		sampleCount := int(frame[3])
		if sampleCount >= 1 && len(frame) >= 7+sampleCount*9+1 {
			floor := int(int8(frame[6]))
			newestOff := 7 + (sampleCount-1)*9
			seq := frame[newestOff]
			dbm := make([]int, 8)
			for ch := 0; ch < 8; ch++ {
				best := int(int8(frame[newestOff+1+ch]))
				for s := 0; s < sampleCount; s++ {
					v := int(int8(frame[7+s*9+1+ch]))
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

	case kind == 0x58 && len(frame) >= 16:
		seq := frame[3]
		floor := int(int8(frame[6]))
		dbm := make([]int, 8)
		for ch := 0; ch < 8; ch++ {
			dbm[ch] = int(int8(frame[7+ch]))
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
	slot.mu.Unlock()

	if synth != nil {
		m.recordKnownStatusMap(synth)
		m.resolveWaiters(slot, "status", synth)
		m.emit(USBEvent{Type: "status", SlotIndex: slot.index, Status: synth})
		m.broadcastPoolState()
	}
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
				errMsg, _ := msg["msg"].(string)
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
}

func (m *Manager) recordKnownStatusMap(st map[string]any) {
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

// FlashBoardRequest describes a native Go ESP32-C5 firmware flash request (`POST /api/usb/flash`).
type FlashBoardRequest struct {
	PortName        string    `json:"portName"`
	SlotIndex       int       `json:"slotIndex"` // Optional slot currently holding PortName
	Role            string    `json:"role"`      // "hub" | "spoke"
	TimerLabel      string    `json:"timerLabel"`
	Fingerprint     string    `json:"fingerprint,omitempty"`
	KeepFingerprint bool      `json:"keepFingerprint"`
	Frequencies     [8]uint16 `json:"frequencies,omitempty"`
	WiFiSSID        string    `json:"wifiSsid,omitempty"`
	WiFiPassword    string    `json:"wifiPassword,omitempty"`
	CustomImage     []byte    `json:"-"`
}

// FlashBoard patches the embedded firmware image with the requested board identity and flashes it
// over USB-Serial-JTAG SLIP ROM bootloader in Go, streaming progress over `/api/ws/usb`.
func (m *Manager) FlashBoard(ctx context.Context, req FlashBoardRequest) (*firmware.TimerReadout, error) {
	_ = ctx
	portName := strings.TrimSpace(req.PortName)
	ownerSlot := m.findOwnerSlotByPort(portName, req.SlotIndex)
	if portName == "" && ownerSlot != nil {
		ownerSlot.mu.Lock()
		portName = ownerSlot.portName
		ownerSlot.mu.Unlock()
	}
	if portName == "" {
		return nil, errors.New("missing serial port name for flashing")
	}

	base := req.CustomImage
	if len(base) == 0 {
		base = m.cfg.BaseFirmware
	}
	if len(base) == 0 {
		base = firmware.SyntheticBase()
	}

	roleByte := firmware.RoleHubTimer
	if strings.EqualFold(req.Role, "spoke") {
		roleByte = firmware.RoleSpokeTimer
	}
	fpVal := firmware.ParseFingerprint(req.Fingerprint)
	tCfg := firmware.TimerConfig{
		Role:         roleByte,
		TimerLabel:   req.TimerLabel,
		Fingerprint:  fpVal,
		SlotFreqsMHz: req.Frequencies,
		WifiSSID:     req.WiFiSSID,
		WifiPass:     req.WiFiPassword,
	}

	if err := m.beginExclusiveFlash(ownerSlot, "Flashing"); err != nil {
		return nil, err
	}
	defer m.endExclusiveFlash(ownerSlot, portName, true)

	slotIdx := 0
	if ownerSlot != nil {
		slotIdx = ownerSlot.index
	}

	readout, flashErr := firmware.FlashXiaoC5(
		portName,
		m.openPort,
		base,
		tCfg,
		req.KeepFingerprint,
		func(p firmware.FlashProgress) {
			pCopy := p
			m.emit(USBEvent{
				Type:          "flash_progress",
				SlotIndex:     slotIdx,
				FlashProgress: &pCopy,
			})
		},
	)
	if flashErr != nil {
		return nil, flashErr
	}
	if readout != nil {
		m.recordKnownConfig(readout)
	}
	return readout, nil
}

// EraseBoard erases the entire flash of an ESP32-C5 board via its USB-Serial-JTAG SLIP ROM bootloader.
func (m *Manager) EraseBoard(ctx context.Context, portName string, slotIndex int) error {
	_ = ctx
	portName = strings.TrimSpace(portName)
	ownerSlot := m.findOwnerSlotByPort(portName, slotIndex)
	if portName == "" && ownerSlot != nil {
		ownerSlot.mu.Lock()
		portName = ownerSlot.portName
		ownerSlot.mu.Unlock()
	}
	if portName == "" {
		return errors.New("missing serial port name for erase")
	}

	if err := m.beginExclusiveFlash(ownerSlot, "Erasing"); err != nil {
		return err
	}
	defer m.endExclusiveFlash(ownerSlot, portName, false)

	slotIdx := 0
	if ownerSlot != nil {
		slotIdx = ownerSlot.index
	}

	return firmware.EraseXiaoC5(portName, m.openPort, func(p firmware.FlashProgress) {
		pCopy := p
		m.emit(USBEvent{
			Type:          "flash_progress",
			SlotIndex:     slotIdx,
			FlashProgress: &pCopy,
		})
	})
}

func (m *Manager) findOwnerSlotByPort(portName string, fallbackSlot int) *usbSlot {
	if portName != "" {
		for i := 0; i < MaxUSBConnections; i++ {
			s := m.slots[i]
			s.mu.Lock()
			match := strings.EqualFold(s.portName, portName) && s.port != nil
			s.mu.Unlock()
			if match {
				return s
			}
		}
	}
	if fallbackSlot >= 0 && fallbackSlot < MaxUSBConnections {
		s := m.slots[fallbackSlot]
		s.mu.Lock()
		hasPort := s.port != nil
		s.mu.Unlock()
		if hasPort {
			return s
		}
	}
	return nil
}

func (m *Manager) beginExclusiveFlash(ownerSlot *usbSlot, busy string) error {
	m.mu.Lock()
	if m.flashActive {
		m.mu.Unlock()
		return errors.New("another firmware operation is already in progress")
	}
	m.flashActive = true
	m.mu.Unlock()

	if ownerSlot != nil {
		ownerSlot.mu.Lock()
		ownerSlot.writing = true
		ownerSlot.busyLabel = busy
		ownerSlot.mu.Unlock()
		_ = m.closeSlotInternal(ownerSlot, false)
	}
	m.broadcastPoolState()
	return nil
}

func (m *Manager) endExclusiveFlash(ownerSlot *usbSlot, portName string, reopenAfter bool) {
	m.mu.Lock()
	m.flashActive = false
	m.mu.Unlock()

	if ownerSlot != nil {
		ownerSlot.mu.Lock()
		ownerSlot.writing = false
		ownerSlot.busyLabel = ""
		ownerSlot.mu.Unlock()
		if reopenAfter && portName != "" {
			// Wait briefly for the reset board to re-enumerate USB CDC, then reconnect.
			for attempt := 0; attempt < 8; attempt++ {
				time.Sleep(300 * time.Millisecond)
				if _, err := m.Connect(ownerSlot.index, portName); err == nil {
					return
				}
			}
		} else if !reopenAfter {
			ownerSlot.mu.Lock()
			ownerSlot.portName = ""
			ownerSlot.lastStatus = nil
			ownerSlot.lastConfig = nil
			ownerSlot.mu.Unlock()
			m.persistUSBTargets()
		}
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
