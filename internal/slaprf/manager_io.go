package slaprf

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

	"slaprf/internal/applog"
	"slaprf/internal/domain"
	"slaprf/internal/firmware"
	"slaprf/internal/ingest"
	"slaprf/internal/serialport"
)

// Connect opens `rawTarget` on `slotIndex` (0..2), streams live connection progress, starts the
// wire/console demultiplexer, and probes `STATUS?` / `SLAPRF?`.
func (m *Manager) Connect(slotIndex int, rawTarget string) (SlotSnapshot, error) {
	return m.connectInternal(slotIndex, rawTarget, true)
}

func (m *Manager) connectInternal(slotIndex int, rawTarget string, allowKeyRecovery bool) (SlotSnapshot, error) {
	if slotIndex < 0 || slotIndex >= MaxConnections {
		return SlotSnapshot{}, fmt.Errorf("invalid slot index %d", slotIndex)
	}
	portName, err := m.tr.ValidateTarget(rawTarget)
	if err != nil {
		return SlotSnapshot{}, err
	}

	// If another slot on this transport holds the exact same target, disconnect it first.
	for i := 0; i < MaxConnections; i++ {
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

	initialStage := m.traits.InitialConnectStatus
	if initialStage == "" {
		initialStage = "Waiting for connection…"
	}
	openCtx, openCancel := context.WithCancel(context.Background())

	slot.mu.Lock()
	slot.openSeq++
	mySeq := slot.openSeq
	slot.openCancel = openCancel
	slot.portName = portName
	slot.connecting = true
	slot.connectStatus = initialStage
	slot.lastError = ""
	slot.reconnectFailed = false
	slot.authRejected = false
	slot.mu.Unlock()
	m.broadcastPoolState()

	m.logf("[SlapRF:%s] Connecting slot %d -> %s", m.tr.Name(), slotIndex, portName)
	port, err := m.tr.Open(openCtx, portName, func(stage string) {
		if stage == "" || openCtx.Err() != nil {
			return
		}
		slot.mu.Lock()
		changed := false
		if slot.openSeq == mySeq && slot.connecting && slot.connectStatus != stage {
			slot.connectStatus = stage
			changed = true
		}
		slot.mu.Unlock()
		if changed {
			m.broadcastPoolState()
		}
	})
	if err != nil {
		cancelled := errors.Is(err, ErrConnectCancelled) || errors.Is(err, serialport.ErrOpenCancelled) || openCtx.Err() != nil
		openCancel()
		slot.mu.Lock()
		if slot.openSeq == mySeq {
			slot.openCancel = nil
			slot.connecting = false
			slot.connectStatus = ""
			if cancelled {
				if !slot.reconnecting {
					slot.portName = ""
				}
				slot.lastError = ""
			} else {
				slot.lastError = err.Error()
			}
		}
		slot.mu.Unlock()
		m.broadcastPoolState()
		if cancelled {
			return SlotSnapshot{}, ErrConnectCancelled
		}
		m.warnf("[SlapRF:%s] Open slot %d (%s) failed: %v", m.tr.Name(), slotIndex, portName, err)
		return SlotSnapshot{}, err
	}
	if openCtx.Err() != nil {
		openCancel()
		_ = port.Close()
		slot.mu.Lock()
		if slot.openSeq == mySeq {
			slot.openCancel = nil
			slot.connecting = false
			slot.connectStatus = ""
			slot.portName = ""
			slot.lastError = ""
		}
		slot.mu.Unlock()
		m.broadcastPoolState()
		return SlotSnapshot{}, ErrConnectCancelled
	}
	_ = port.SetReadTimeout(120 * time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	doneCh := make(chan struct{})

	probeStage := m.traits.ProbeStatus
	if probeStage == "" {
		probeStage = "Reading timer status…"
	}

	slot.mu.Lock()
	if slot.openSeq != mySeq {
		slot.mu.Unlock()
		openCancel()
		cancel()
		_ = port.Close()
		return SlotSnapshot{}, ErrConnectCancelled
	}
	slot.portName = portName
	slot.port = port
	slot.cancel = cancel
	slot.doneCh = doneCh
	slot.connecting = true
	slot.connectStatus = probeStage
	slot.probing = true
	slot.reconnecting = false
	slot.reconnectAttempt = 0
	slot.reconnectFailed = false
	slot.authRejected = false
	slot.lastError = ""
	slot.lastStatus = nil
	slot.lastBridge = nil
	slot.lastStatusAtMs = 0
	slot.lastRealJsonStatusMs = 0
	slot.lastConfig = nil
	slot.sawRomBootloader = false
	slot.hubOwnFrames = 0
	slot.hubLastDbm = nil
	slot.hubHello = make(map[uint8]slotHello)
	slot.hubLive = make(map[uint8]slotLive)
	slot.synthLiveMode = 0
	slot.synthSeqInit = false
	slot.synthLastSeq = 0
	slot.synthStaleCount = 0
	slot.synthSweepN = 0
	slot.synthFloorQ4 = [8]int16{}
	slot.synthFloorSet = [8]bool{}
	slot.synthPeak = [8]int{-127, -127, -127, -127, -127, -127, -127, -127}
	slot.synthHits = [8]int{}
	slot.mu.Unlock()

	if slotIndex == 1 {
		m.SetDebugSlot(1)
	}
	m.saveSlotTarget(slotIndex, portName)
	m.broadcastPoolState()

	go m.runSlotLoops(ctx, slot, port, portName, doneCh)

	_, _ = m.probeInitialStatus(slot, m.traits.ProbeTimeout)
	cancelledDuringProbe := openCtx.Err() != nil
	openCancel()

	slot.mu.Lock()
	if slot.openSeq != mySeq || cancelledDuringProbe {
		slot.mu.Unlock()
		return SlotSnapshot{}, ErrConnectCancelled
	}
	slot.openCancel = nil
	slot.connecting = false
	slot.connectStatus = ""
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
			rejMsg = m.defaultAuthMismatchMsg()
		}
		_ = m.closeSlotInternal(slot, true)
		if allowKeyRecovery {
			candidates := m.timers.HistoricalHostAuthKeys()
			if len(candidates) > 0 {
				origKey := m.timers.HostAuthKey()
				m.logf("[SlapRF] auth_mismatch on %s; trying %d historical host key(s) from slaprf.db", portName, len(candidates))
				if len(candidates) > 8 {
					candidates = candidates[:8]
				}
				for _, cand := range candidates {
					time.Sleep(400 * time.Millisecond)
					m.timers.AdoptHostAuthKey(cand)
					if snap, recErr := m.connectInternal(slotIndex, rawTarget, false); recErr == nil {
						m.logf("[SlapRF] recovered historical BLE host key for %s", portName)
						return snap, nil
					}
				}
				m.timers.AdoptHostAuthKey(origKey)
			}
		}
		slot.mu.Lock()
		slot.lastError = rejMsg
		slot.reconnectFailed = true
		slot.authRejected = true
		slot.mu.Unlock()
		m.removeRejectedTarget(portName)
		m.emit(Event{Type: "error", SlotIndex: slot.index, Error: rejMsg})
		m.broadcastPoolState()
		return m.Snapshot().Slots[slotIndex], errors.New(rejMsg)
	}

	// If the transport encodes the Hub's 8-hex fingerprint in the target (e.g. `ble:<FP>`), ensure
	// `lastStatus` is populated immediately even while the first JSON status line is in transit.
	if stAfter == nil {
		if knownFP, ok := m.tr.TargetFingerprint(portName); ok {
			known, _ := m.timers.Get(knownFP)
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
					slot.hubHello[1] = slotHello{fp: knownFP, label: lbl, role: 1, sweepHz: uint8(m.traits.DefaultSweepHz)}
				}
				stAfter = m.synthesizeHubStatusLocked(slot, time.Now().UnixMilli())
			} else {
				stAfter = slot.lastStatus
			}
			slot.mu.Unlock()
			if stAfter != nil {
				m.recordKnownStatusMap(stAfter)
			}
		}
	}

	m.registerConnectedHubInEngine(stAfter, cfgAfter)
	if m.cfg.HubRx != nil {
		m.cfg.HubRx.PushActiveChannels()
	}
	if stAfter != nil {
		fp, _ := stAfter["fp"].(string)
		lbl, _ := stAfter["label"].(string)
		fw, _ := stAfter["fw"].(string)
		roleNum, _ := asInt(stAfter["role"])
		m.logf("[SlapRF:%s] Connected slot %d -> %s (role=%d label=%q fp=%s fw=%s)", m.tr.Name(), slotIndex, portName, roleNum, lbl, fp, fw)
	} else {
		m.logf("[SlapRF:%s] Connected slot %d -> %s", m.tr.Name(), slotIndex, portName)
	}
	m.broadcastPoolState()
	return m.Snapshot().Slots[slotIndex], nil
}

func (m *Manager) defaultAuthMismatchMsg() string {
	if m.traits.DefaultAuthMismatchMessage != "" {
		return m.traits.DefaultAuthMismatchMessage
	}
	return "Hub is paired to another device. Hold BOOT for 3 s on the Hub to pair with this device."
}

// Disconnect closes `slotIndex` (or cancels an in-flight connection attempt) and clears its saved target.
func (m *Manager) Disconnect(slotIndex int) error {
	if slotIndex < 0 || slotIndex >= MaxConnections {
		return fmt.Errorf("invalid slot index %d", slotIndex)
	}
	slot := m.slots[slotIndex]
	slot.mu.Lock()
	prevPort := slot.portName
	slot.mu.Unlock()
	err := m.closeSlotInternal(slot, true)
	if prevPort != "" {
		m.logf("[SlapRF:%s] Disconnected slot %d (%s)", m.tr.Name(), slotIndex, prevPort)
	}
	if slotIndex == 1 {
		m.SetDebugSlot(0)
	}
	m.clearSlotTarget(slotIndex)
	m.broadcastPoolState()
	return err
}

// ForgetSlot atomically clears auto-reconnect targets first, sends `Traits.UnpairCommand` (such as
// `BLEPAIR CLEAR`) over an active link so the Hub returns to Pairing Mode, closes `slotIndex`, and
// removes `fp` from `KnownTimerRegistry`.
func (m *Manager) ForgetSlot(slotIndex int, hintFP string) error {
	if slotIndex < 0 || slotIndex >= MaxConnections {
		return fmt.Errorf("invalid slot index %d", slotIndex)
	}
	slot := m.slots[slotIndex]
	slot.mu.Lock()
	prevPort := slot.portName
	hasPort := slot.port != nil
	fp := strings.ToUpper(strings.TrimSpace(hintFP))
	if fp == "" && slot.lastStatus != nil {
		if sFP, ok := slot.lastStatus["fp"].(string); ok {
			fp = strings.ToUpper(strings.TrimSpace(sFP))
		}
	}
	if fp == "" && slot.lastConfig != nil {
		fp = strings.ToUpper(strings.TrimSpace(slot.lastConfig.Fingerprint))
	}
	slot.mu.Unlock()
	if fp == "" {
		if pFP, ok := m.tr.TargetFingerprint(prevPort); ok {
			fp = pFP
		}
	}

	// Clear persisted auto-reconnect targets BEFORE sending UnpairCommand so runSlotLoops cannot
	// race and re-claim the Hub when firmware drops the link ~50 ms later.
	m.clearSlotTarget(slotIndex)
	if fp != "" {
		if canon := m.tr.CanonicalTarget(fp); canon != "" {
			m.removeSavedTargetOnly(canon)
		}
	}
	if hasPort && m.traits.UnpairCommand != "" {
		_ = m.SendCommand(slotIndex, m.traits.UnpairCommand)
		time.Sleep(160 * time.Millisecond)
	}
	err := m.closeSlotInternal(slot, true)
	if slotIndex == 1 {
		m.SetDebugSlot(0)
	}
	if fp != "" {
		m.timers.Forget(fp)
	} else {
		m.broadcastPoolState()
	}
	return err
}

// ForgetKnownTimer removes `fp` from the shared timer registry and clears any saved target for `fp`.
func (m *Manager) ForgetKnownTimer(fp string) {
	m.timers.Forget(fp)
}

func (m *Manager) closeSlotInternal(slot *connSlot, clearPortName bool) error {
	slot.mu.Lock()
	slot.openSeq++
	openCancel := slot.openCancel
	cancel := slot.cancel
	doneCh := slot.doneCh
	port := slot.port
	slot.openCancel = nil
	slot.cancel = nil
	slot.doneCh = nil
	slot.port = nil
	slot.connecting = false
	slot.connectStatus = ""
	slot.probing = false
	if clearPortName {
		slot.portName = ""
		slot.reconnecting = false
		slot.reconnectAttempt = 0
		slot.reconnectFailed = false
		slot.authRejected = false
		slot.lastError = ""
		slot.lastStatus = nil
		slot.lastConfig = nil
	}
	waiters := slot.waiters
	slot.waiters = nil
	slot.mu.Unlock()

	for _, w := range waiters {
		close(w.ch)
	}
	if openCancel != nil {
		openCancel()
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
	if slot == m.slots[0] && m.cfg.Engine != nil {
		m.cfg.Engine.SetAllTimersOffline()
	}
	return closeErr
}

func (m *Manager) saveSlotTarget(slotIndex int, portName string) {
	portName = strings.TrimSpace(portName)
	if slotIndex < 0 || slotIndex >= MaxConnections || portName == "" {
		return
	}
	m.mu.Lock()
	for i := 0; i < MaxConnections; i++ {
		if i != slotIndex && strings.EqualFold(m.savedTargets[i], portName) {
			m.savedTargets[i] = ""
		}
	}
	m.savedTargets[slotIndex] = portName
	m.persistTargetsLocked()
	m.mu.Unlock()
}

func (m *Manager) clearSlotTarget(slotIndex int) {
	if slotIndex < 0 || slotIndex >= MaxConnections {
		return
	}
	m.mu.Lock()
	m.savedTargets[slotIndex] = ""
	m.persistTargetsLocked()
	m.mu.Unlock()
}

func (m *Manager) removeSavedTargetOnly(portName string) {
	portName = strings.TrimSpace(portName)
	if portName == "" {
		return
	}
	m.mu.Lock()
	changed := false
	for i := 0; i < MaxConnections; i++ {
		if strings.EqualFold(m.savedTargets[i], portName) {
			m.savedTargets[i] = ""
			changed = true
		}
	}
	if changed {
		m.persistTargetsLocked()
	}
	m.mu.Unlock()
}

func (m *Manager) removeRejectedTarget(portName string) {
	m.removeSavedTargetOnly(portName)
	if m.traits.MarksBLEPaired {
		if fp, ok := m.tr.TargetFingerprint(portName); ok {
			m.timers.ClearBLEPairing(fp)
		}
	}
}

func (m *Manager) persistTargetsLocked() {
	if m.cfg.Store == nil || m.traits.PersistTargetsKey == "" {
		return
	}
	targets := make(map[string]string)
	for i := 0; i < MaxConnections; i++ {
		if p := strings.TrimSpace(m.savedTargets[i]); p != "" {
			targets[fmt.Sprintf("%d", i)] = p
		}
	}
	_ = m.cfg.Store.PutJSON(m.traits.PersistTargetsKey, targets)
}

func (m *Manager) probeInitialStatus(slot *connSlot, timeout time.Duration) (map[string]any, error) {
	deadline := time.Now().Add(timeout)
	first := true
	rebootedOnce := false
	for time.Now().Before(deadline) {
		slot.mu.Lock()
		connected := slot.port != nil
		port := slot.port
		st := slot.lastStatus
		rom := slot.sawRomBootloader
		authRej := slot.authRejected
		rejErr := slot.lastError
		slot.mu.Unlock()
		if slot == m.slots[0] && m.cfg.Engine != nil {
			m.cfg.Engine.SetAllTimersOffline()
		}
		if authRej {
			if rejErr == "" {
				rejErr = m.defaultAuthMismatchMsg()
			}
			return nil, errors.New(rejErr)
		}
		if !connected {
			return st, nil
		}
		if st != nil {
			return st, nil
		}
		if rom && !rebootedOnce && m.traits.SupportsROMBootloaderReset {
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
			prefix := ""
			if m.traits.HandshakePrefix != nil {
				prefix = m.traits.HandshakePrefix(m.HostAuthKey())
			}
			cmd = prefix + "LIVE 0\nSCAN STOP\nLOG 0\nSTATUS?\nSLAPRF?"
			first = false
		}
		res, err := m.RequestReply(slot.index, cmd, "status", m.traits.ProbeReplyTimeout)
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
				rejErrNow = m.defaultAuthMismatchMsg()
			}
			return nil, errors.New(rejErrNow)
		}
		if hasAny {
			return stNow, nil
		}
		if m.traits.SupportsROMBootloaderReset && !rebootedOnce && time.Now().Add(200*time.Millisecond).After(deadline) {
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

// SendCommand writes an ASCII command line to `slotIndex`'s open transport stream.
func (m *Manager) SendCommand(slotIndex int, cmd string) error {
	if slotIndex < 0 || slotIndex >= MaxConnections {
		return fmt.Errorf("invalid slot index %d", slotIndex)
	}
	slot := m.slots[slotIndex]
	slot.mu.Lock()
	port := slot.port
	slot.mu.Unlock()
	if port == nil {
		return errors.New("device is not connected")
	}

	if m.traits.SynthesizeLiveFromBinary {
		rawLines := strings.Split(strings.ReplaceAll(cmd, "\r\n", "\n"), "\n")
		outLines := make([]string, 0, len(rawLines))
		liveAckMode := -1
		for _, ln := range rawLines {
			trimmed := strings.TrimSpace(ln)
			if trimmed == "" {
				continue
			}
			upper := strings.ToUpper(trimmed)
			if upper == "LIVE 0" || upper == "LIVE 1" || upper == "LIVE 2" {
				mode := int(upper[len(upper)-1] - '0')
				slot.mu.Lock()
				slot.synthLiveMode = mode
				slot.synthPeak = [8]int{-127, -127, -127, -127, -127, -127, -127, -127}
				slot.synthHits = [8]int{}
				slot.mu.Unlock()
				liveAckMode = mode
				outLines = append(outLines, "LIVE 0")
				continue
			}
			if strings.HasPrefix(upper, "SCAN ") && !strings.HasPrefix(upper, "SCAN STOP") {
				slot.mu.Lock()
				slot.synthLiveMode = 0
				slot.mu.Unlock()
			}
			outLines = append(outLines, trimmed)
		}
		if liveAckMode >= 0 {
			ack := map[string]any{"t": "ok", "cmd": "live", "on": liveAckMode > 0}
			ackLine := fmt.Sprintf("@{\"t\":\"ok\",\"cmd\":\"live\",\"on\":%v}", liveAckMode > 0)
			m.emit(Event{Type: "raw_reply", SlotIndex: slot.index, Line: ackLine, MsgType: "ok"})
			m.resolveWaiters(slot, "ok", ack)
		}
		if len(outLines) == 0 {
			return nil
		}
		clean := strings.Join(outLines, "\n") + "\n"
		m.debugf("[SlapRF:%s] TX slot %d: %s", m.tr.Name(), slotIndex, redactSensitiveCommand(clean))
		slot.writeMu.Lock()
		_, err := port.Write([]byte(clean))
		slot.writeMu.Unlock()
		return err
	}

	clean := strings.TrimRight(cmd, "\r\n") + "\n"
	m.debugf("[SlapRF:%s] TX slot %d: %s", m.tr.Name(), slotIndex, redactSensitiveCommand(clean))
	slot.writeMu.Lock()
	_, err := port.Write([]byte(clean))
	slot.writeMu.Unlock()
	return err
}

// RequestReply sends `cmd` (if non-empty) and waits up to `timeout` for a message of `expectType`.
func (m *Manager) RequestReply(slotIndex int, cmd string, expectType string, timeout time.Duration) (any, error) {
	if slotIndex < 0 || slotIndex >= MaxConnections {
		return nil, fmt.Errorf("invalid slot index %d", slotIndex)
	}
	slot := m.slots[slotIndex]
	w := &replyWaiter{
		msgType: expectType,
		ch:      make(chan any, 1),
	}
	slot.mu.Lock()
	if slot.port == nil {
		slot.mu.Unlock()
		return nil, errors.New("device is not connected")
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
			return nil, errors.New("device disconnected")
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

func (m *Manager) resolveWaiters(slot *connSlot, msgType string, val any) {
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

func (m *Manager) failWaiters(slot *connSlot, err error) {
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

const ingestHubChannelsLen = 19

// SendNetChannelsFrame translates a 19-byte `0xC5 0x5E` channel table packet into `NETCHANNELS ...` on connected Hubs.
func (m *Manager) SendNetChannelsFrame(pkt19 []byte) {
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
// reported its role yet. Returns false if no device is connected on this transport.
func (m *Manager) SendToHub(cmd string) bool {
	sent := false
	for i := 0; i < MaxConnections; i++ {
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

func (m *Manager) runSlotLoops(ctx context.Context, slot *connSlot, port firmware.SerialPort, portName string, doneCh chan struct{}) {
	defer close(doneCh)

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
			errLower := strings.ToLower(err.Error())
			if strings.Contains(errLower, "timeout") {
				continue
			}
			if errors.Is(err, io.EOF) && n == 0 {
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
				m.emit(Event{Type: "error", SlotIndex: slot.index, Error: err.Error()})
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
			slot.lastBridge = nil
			slot.lastConfig = nil
			if authRej {
				slot.portName = ""
				slot.reconnecting = false
				slot.reconnectFailed = true
			}
		}
		slot.mu.Unlock()
		if slot == m.slots[0] && m.cfg.Engine != nil {
			m.cfg.Engine.SetAllTimersOffline()
		}
		if authRej {
			if rejMsg == "" {
				rejMsg = m.defaultAuthMismatchMsg()
			}
			m.removeRejectedTarget(portName)
			m.failWaiters(slot, errors.New(rejMsg))
			m.broadcastPoolState()
			return
		}
		discErr := m.traits.DisconnectedError
		if discErr == "" {
			discErr = "device disconnected"
		}
		m.failWaiters(slot, errors.New(discErr))
		m.broadcastPoolState()
		go m.attemptAutoReconnect(slot, portName)
	}
}

func (m *Manager) attemptAutoReconnect(slot *connSlot, portName string) {
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

	disp := m.traits.DisplayName
	if disp == "" {
		disp = "device"
	}

	for attempt := 1; attempt <= 5; attempt++ {
		m.mu.RLock()
		closed := m.closed
		sim := m.simMode
		active := !m.activeSet || m.active
		m.mu.RUnlock()
		if closed || sim || !active {
			slot.mu.Lock()
			slot.reconnecting = false
			slot.connectStatus = ""
			slot.mu.Unlock()
			m.broadcastPoolState()
			return
		}
		slot.mu.Lock()
		if slot.port != nil || slot.portName == "" || slot.authRejected {
			slot.reconnecting = false
			slot.connectStatus = ""
			slot.mu.Unlock()
			m.broadcastPoolState()
			return
		}
		slot.reconnectAttempt = attempt
		slot.connectStatus = fmt.Sprintf("Reconnecting to %s (attempt %d of 5)…", disp, attempt)
		slot.mu.Unlock()
		m.broadcastPoolState()

		time.Sleep(1200 * time.Millisecond)

		slot.mu.Lock()
		slotBusy := slot.port != nil || slot.portName == "" || slot.authRejected
		slot.mu.Unlock()
		if slotBusy {
			slot.mu.Lock()
			slot.reconnecting = false
			slot.connectStatus = ""
			slot.mu.Unlock()
			m.broadcastPoolState()
			return
		}

		if _, err := m.Connect(slot.index, portName); err == nil {
			return
		} else if errors.Is(err, ErrConnectCancelled) {
			slot.mu.Lock()
			slot.reconnecting = false
			slot.connectStatus = ""
			slot.mu.Unlock()
			m.broadcastPoolState()
			return
		}
		slot.mu.Lock()
		authRej := slot.authRejected
		slot.mu.Unlock()
		if slot == m.slots[0] && m.cfg.Engine != nil {
			m.cfg.Engine.SetAllTimersOffline()
		}
		if authRej {
			return
		}
	}

	lostMsg := m.traits.LostAfterRetriesError
	if lostMsg == "" {
		lostMsg = fmt.Sprintf("Lost %s connection after 5 reconnect attempts.", disp)
	}
	slot.mu.Lock()
	slot.reconnecting = false
	slot.connectStatus = ""
	slot.reconnectFailed = true
	slot.lastError = lostMsg
	slot.mu.Unlock()
	m.broadcastPoolState()

	for {
		time.Sleep(1500 * time.Millisecond)
		m.mu.RLock()
		closed := m.closed
		sim := m.simMode
		active := !m.activeSet || m.active
		m.mu.RUnlock()
		if closed || sim || !active {
			return
		}
		slot.mu.Lock()
		stillWaiting := slot.port == nil && strings.EqualFold(slot.portName, portName) && portName != ""
		slot.mu.Unlock()
		if !stillWaiting {
			return
		}
		discCtx, discCancel := context.WithTimeout(context.Background(), 2*time.Second)
		ports, err := m.tr.Discover(discCtx, true)
		discCancel()
		if err == nil {
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

func (m *Manager) parseSlotBuffer(slot *connSlot, buf []byte) []byte {
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
				nowMs := time.Now().UnixMilli()
				slot.mu.Lock()
				slot.crcResyncs++
				drops := slot.crcResyncs
				shouldWarn := nowMs-slot.lastCrcWarnMs >= 5000
				if shouldWarn {
					slot.lastCrcWarnMs = nowMs
				}
				slot.mu.Unlock()
				if shouldWarn {
					m.warnf("[SlapRF:%s] slot %d resynced past invalid binary Hub record (len=%d totalResyncs=%d)", m.tr.Name(), slot.index, pktLen, drops)
				}
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
				m.emit(Event{Type: "config", SlotIndex: slot.index, Config: cfg})
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

func (m *Manager) handleHubBinaryFrame(slot *connSlot, frame []byte) {
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

	var synthLiveEvents []map[string]any
	newSlotSeen := false

	slot.mu.Lock()
	switch {
	case kind == 0x5A && len(frame) >= 36:
		role := frame[3]
		fpNum := binary.LittleEndian.Uint32(frame[4:8])
		fp := fmt.Sprintf("%08X", fpNum)
		sweepHz := frame[9]
		if sweepHz == 0 {
			sweepHz = uint8(m.traits.DefaultSweepHz)
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
		prevHello, hadHello := slot.hubHello[tdmaSlot]
		slot.hubHello[tdmaSlot] = slotHello{fp: fp, label: label, role: role, sweepHz: sweepHz}
		if !hadHello || prevHello.fp != fp || prevHello.label != label {
			m.logf("[SlapRF] slot %d HELLO rx: tdma=%d fp=%s role=%d sweepHz=%d label=%q", slot.index, tdmaSlot, fp, role, sweepHz, label)
		}

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
			prev, hadPrev := slot.hubLive[tdmaSlot]
			if !hadPrev {
				newSlotSeen = true
			}
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
				if m.traits.SynthesizeLiveFromBinary {
					synthLiveEvents = unwrapWindowSamplesLocked(slot, frame, sampleCount)
				}
			}
		}

	case kind == ingest.FrameMagicSingle && len(frame) >= 16:
		seq := frame[3]
		floor := int(int8(frame[6]))
		dbm := make([]float64, 8)
		for ch := 0; ch < 8; ch++ {
			dbm[ch] = float64(ingest.DecodeHalfDbm(frame[7+ch]))
		}
		prev, hadPrev := slot.hubLive[tdmaSlot]
		if !hadPrev {
			newSlotSeen = true
		}
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
	if (kind == ingest.FrameMagicWindow || kind == ingest.FrameMagicSingle) && (newSlotSeen || nowMs-slot.hubLiveEmitMs >= hubLiveEmitIntervalMs) {
		slot.hubLiveEmitMs = nowMs
		hubLive = hubLivePayloadLocked(slot, nowMs)
	}
	var debugSummary string
	if m.cfg.AppLog.Enabled(applog.LevelDebug) && nowMs-slot.lastSummaryMs >= 5000 && len(slot.hubLive) > 0 {
		slot.lastSummaryMs = nowMs
		parts := make([]string, 0, len(slot.hubLive))
		for tdma := uint8(1); tdma <= 7; tdma++ {
			if l, ok := slot.hubLive[tdma]; ok {
				parts = append(parts, fmt.Sprintf("tdma=%d:frames=%d,seq=%d,age=%dms", tdma, l.frames, l.seq, nowMs-l.lastFrameAtMs))
			}
		}
		debugSummary = strings.Join(parts, " ")
	}
	slot.mu.Unlock()

	if debugSummary != "" {
		m.debugf("[SlapRF:%s] slot %d telemetry summary: %s", m.tr.Name(), slot.index, debugSummary)
	}

	if hubLive != nil {
		m.emit(Event{Type: "hub_live", SlotIndex: slot.index, Payload: hubLive})
	}
	for _, ev := range synthLiveEvents {
		m.emit(Event{Type: "live", SlotIndex: slot.index, Payload: ev})
	}
	if synth != nil {
		m.recordKnownStatusMap(synth)
		m.resolveWaiters(slot, "status", synth)
		m.emit(Event{Type: "status", SlotIndex: slot.index, Status: synth})
		m.broadcastPoolState()
	}
}

const hubLiveEmitIntervalMs = 50

func hubLivePayloadLocked(slot *connSlot, nowMs int64) map[string]any {
	slots := make([]map[string]any, 0, len(slot.hubLive))
	for tdma, l := range slot.hubLive {
		slots = append(slots, map[string]any{
			"slot":   int(tdma),
			"dbm":    l.dbm,
			"seq":    l.seq,
			"frames": l.frames,
			"floor":  l.floor,
			"ageMs":  nowMs - l.lastFrameAtMs,
		})
	}
	return map[string]any{"slots": slots, "hubOwnFrames": slot.hubOwnFrames}
}

func halfCodeToIntDbm(code byte) int {
	if code == 0 {
		return -127
	}
	v := -128 + (int(code)+1)/2
	if v < -127 {
		v = -127
	}
	if v > 0 {
		v = 0
	}
	return v
}

func unwrapWindowSamplesLocked(slot *connSlot, frame []byte, sampleCount int) []map[string]any {
	const hitMarginDb = 10
	sweepUs := 5500
	sweepHz := 50
	if h1, ok := slot.hubHello[1]; ok && h1.sweepHz > 0 {
		sweepHz = int(h1.sweepHz)
	}
	if slot.lastStatus != nil {
		if u, ok := asInt(slot.lastStatus["sweepUs"]); ok && u > 0 {
			sweepUs = u
		}
		if hz, ok := asInt(slot.lastStatus["sweepHz"]); ok && hz > 0 {
			sweepHz = hz
		}
	}
	live1Every := uint64(sweepHz / 10)
	if live1Every < 1 {
		live1Every = 1
	}

	var out []map[string]any
	anyNew := false
	for s := 0; s < sampleCount; s++ {
		off := 7 + s*9
		seq := frame[off]
		if !slot.synthSeqInit {
			slot.synthSeqInit = true
			slot.synthLastSeq = seq - 1
		}
		delta := uint8(seq - slot.synthLastSeq)
		if delta == 0 || delta > 64 {
			continue
		}
		anyNew = true
		slot.synthLastSeq = seq
		slot.synthSweepN += uint64(delta)

		var curDbm [8]int
		allBlank := true
		for ch := 0; ch < 8; ch++ {
			v := halfCodeToIntDbm(frame[off+1+ch])
			curDbm[ch] = v
			if v > -127 {
				allBlank = false
			}
		}
		rfEnabled := true
		chanMask := 255
		if slot.lastStatus != nil {
			if rfMap, ok := slot.lastStatus["rf"].(map[string]any); ok {
				if en, ok := rfMap["enabled"].(bool); ok {
					rfEnabled = en
				}
			}
			if cm, ok := asInt(slot.lastStatus["chanMask"]); ok {
				chanMask = cm
			}
		}
		if allBlank && rfEnabled && chanMask != 0 {
			continue
		}

		for ch := 0; ch < 8; ch++ {
			d := curDbm[ch]
			if d <= -127 {
				continue
			}
			if d > slot.synthPeak[ch] {
				slot.synthPeak[ch] = d
			}
			vq4 := int16(d * 16)
			if !slot.synthFloorSet[ch] {
				slot.synthFloorQ4[ch] = vq4
				slot.synthFloorSet[ch] = true
			} else if vq4 < slot.synthFloorQ4[ch]+hitMarginDb*8 {
				slot.synthFloorQ4[ch] += (vq4 - slot.synthFloorQ4[ch]) / 32
			} else {
				slot.synthFloorQ4[ch] += (vq4 - slot.synthFloorQ4[ch]) / 2048
			}
			if vq4 > slot.synthFloorQ4[ch]+hitMarginDb*16 && slot.synthHits[ch] < 255 {
				slot.synthHits[ch]++
			}
		}

		if slot.synthLiveMode == 0 {
			continue
		}
		if slot.synthLiveMode == 1 && slot.synthSweepN%live1Every != 0 {
			continue
		}
		dbmArr := make([]int, 8)
		pkArr := make([]int, 8)
		hitsArr := make([]int, 8)
		flArr := make([]int, 8)
		for ch := 0; ch < 8; ch++ {
			dbmArr[ch] = curDbm[ch]
			pkArr[ch] = slot.synthPeak[ch]
			hitsArr[ch] = slot.synthHits[ch]
			if slot.synthFloorSet[ch] {
				flArr[ch] = int(slot.synthFloorQ4[ch] / 16)
			} else {
				flArr[ch] = -127
			}
			slot.synthPeak[ch] = -127
			slot.synthHits[ch] = 0
		}
		out = append(out, map[string]any{
			"t":     "live",
			"n":     slot.synthSweepN,
			"us":    sweepUs,
			"dbm":   dbmArr,
			"pk":    pkArr,
			"hits":  hitsArr,
			"floor": flArr,
		})
	}
	if !anyNew {
		slot.synthStaleCount++
		if slot.synthStaleCount >= 4 {
			slot.synthSeqInit = false
			slot.synthStaleCount = 0
		}
	} else {
		slot.synthStaleCount = 0
	}
	return out
}

func (m *Manager) synthesizeHubStatusLocked(slot *connSlot, nowMs int64) map[string]any {
	if slot.lastRealJsonStatusMs > 0 && nowMs-slot.lastRealJsonStatusMs < 2500 {
		return nil
	}
	h1, hasH1 := slot.hubHello[1]
	if slot.hubOwnFrames == 0 && !hasH1 {
		return nil
	}
	if slot.lastStatus != nil && nowMs-slot.lastStatusAtMs < 2000 && !slot.probing && len(slot.waiters) == 0 {
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
		if tFP, ok := m.tr.TargetFingerprint(slot.portName); ok {
			fp = tFP
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
		sweepHz = m.traits.DefaultSweepHz
	}
	live1 := slot.hubLive[1]
	floorDb := -90.0
	if slot.lastStatus != nil {
		if rfMap, ok := slot.lastStatus["rf"].(map[string]any); ok {
			if f, ok := rfMap["floorDb"].(float64); ok {
				floorDb = f
			}
		}
	} else if live1.frames > 0 {
		floorDb = float64(live1.floor)
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
		"sweepUs":        m.traits.DefaultSweepUs,
		"sweepUsMax":     m.traits.DefaultSweepUsMax,
		"sweepBudgetUs":  m.traits.DefaultSweepBudgetUs,
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
	if m.traits.SynthesizedStatusExtras != nil {
		for k, v := range m.traits.SynthesizedStatusExtras(slot.lastStatus) {
			st[k] = v
		}
	}
	if slot.lastBridge != nil {
		st["transport"] = "eth"
		if ethMap, ok := slot.lastBridge["eth"]; ok {
			st["eth"] = ethMap
		}
	}
	slot.probing = false
	slot.lastStatus = st
	slot.lastStatusAtMs = nowMs
	return st
}

func (m *Manager) emitTextLine(slot *connSlot, raw []byte) {
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
			m.tracef("[SlapRF:%s] RX slot %d (%s): %s", m.tr.Name(), slot.index, tStr, jsonLine)
			m.emit(Event{Type: "raw_reply", SlotIndex: slot.index, Line: jsonLine, MsgType: tStr})
			if tStr == "err" {
				codeStr, _ := msg["code"].(string)
				errMsg, _ := msg["msg"].(string)
				if codeStr == "auth_mismatch" || codeStr == "unpaired" {
					if strings.TrimSpace(errMsg) == "" {
						errMsg = m.defaultAuthMismatchMsg()
					}
					slot.mu.Lock()
					pName := slot.portName
					wasProbing := slot.probing
					slot.authRejected = true
					slot.probing = false
					slot.reconnecting = false
					slot.reconnectFailed = true
					slot.lastError = errMsg
					slot.mu.Unlock()
					if !wasProbing {
						m.removeRejectedTarget(pName)
						m.emit(Event{Type: "error", SlotIndex: slot.index, Error: errMsg})
					}
					m.failWaiters(slot, errors.New(errMsg))
					if !wasProbing {
						m.broadcastPoolState()
					}
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
			case "bridge":
				const noUsbMsg = "PoE Bridge online · Plug a XIAO ESP32-C5 Hub into the USB-A port"
				usbConn, hasUsbField := msg["usbConnected"].(bool)
				var emitSt map[string]any
				slot.mu.Lock()
				slot.lastBridge = msg
				if hasUsbField && !usbConn {
					slot.probing = false
					slot.lastStatus = nil
					slot.lastError = noUsbMsg
				} else if slot.lastError == noUsbMsg {
					slot.lastError = ""
				}
				if slot.lastStatus != nil {
					slot.lastStatus["transport"] = "eth"
					if ethMap, ok := msg["eth"]; ok {
						slot.lastStatus["eth"] = ethMap
					}
					emitSt = make(map[string]any, len(slot.lastStatus))
					for k, v := range slot.lastStatus {
						emitSt[k] = v
					}
				}
				slot.mu.Unlock()
				m.emit(Event{Type: "bridge", SlotIndex: slot.index, Payload: msg})
				if emitSt != nil {
					m.emit(Event{Type: "status", SlotIndex: slot.index, Status: emitSt})
				}
				m.broadcastPoolState()
				return
			case "status":
				nowMs := time.Now().UnixMilli()
				fpStr, _ := msg["fp"].(string)
				canonTarget := m.tr.CanonicalTarget(fpStr)
				if canonFP, ok := m.tr.TargetFingerprint(canonTarget); ok {
					fpStr = canonFP
				}
				slot.mu.Lock()
				slot.probing = false
				if strings.HasPrefix(slot.lastError, "PoE Bridge online") {
					slot.lastError = ""
				}
				if slot.lastBridge != nil {
					msg["transport"] = "eth"
					if ethMap, ok := slot.lastBridge["eth"]; ok {
						msg["eth"] = ethMap
					}
				} else if m.traits.SynthesizedStatusExtras != nil {
					for k, v := range m.traits.SynthesizedStatusExtras(slot.lastStatus) {
						if _, exists := msg[k]; !exists {
							msg[k] = v
						}
					}
				}
				slot.lastStatus = msg
				slot.lastStatusAtMs = nowMs
				slot.lastRealJsonStatusMs = nowMs
				m.mirrorStatusHellosLocked(slot, msg)
				curPort := slot.port
				prevPortName := slot.portName
				retarget := canonTarget != "" && prevPortName != "" && !strings.EqualFold(prevPortName, canonTarget)
				if retarget {
					slot.portName = canonTarget
				}
				slot.mu.Unlock()
				if canonTarget != "" {
					if obs, ok := curPort.(FingerprintObserver); ok {
						obs.NoteConnectedFingerprint(fpStr)
					}
				}
				if retarget {
					m.saveSlotTarget(slot.index, canonTarget)
				}
				m.recordKnownStatusMap(msg)
				m.emit(Event{Type: "status", SlotIndex: slot.index, Status: msg})
				m.broadcastPoolState()
				return
			case "live":
				m.emit(Event{Type: "live", SlotIndex: slot.index, Payload: msg})
				return
			case "scan":
				m.emit(Event{Type: "scan", SlotIndex: slot.index, Payload: msg})
				return
			case "bootlog":
				m.emit(Event{Type: "bootlog", SlotIndex: slot.index, Payload: msg})
				return
			default:
				return
			}
		}
	}
	m.emit(Event{Type: "log", SlotIndex: slot.index, Line: lineStr})
}

func (m *Manager) recordKnownConfig(cfg *firmware.TimerReadout) {
	if cfg == nil {
		return
	}
	slot := 0
	if cfg.Role == "hub" {
		slot = 1
	}
	m.timers.Upsert(KnownHardwareTimer{
		FP:         cfg.Fingerprint,
		Role:       cfg.Role,
		Label:      cfg.TimerLabel,
		FW:         cfg.FirmwareVersion,
		Slot:       slot,
		Channel:    1,
		PairedBLE:  cfg.Role == "hub" && m.traits.MarksBLEPaired,
		LastSeenMs: time.Now().UnixMilli(),
	})
	m.registerConnectedHubInEngine(nil, cfg)
}

func (m *Manager) mirrorStatusHellosLocked(slot *connSlot, st map[string]any) {
	if slot == nil || st == nil {
		return
	}
	roleNum, _ := asInt(st["role"])
	if roleNum != 1 {
		return
	}
	hubSweepHz, _ := asInt(st["sweepHz"])
	if hubSweepHz <= 0 {
		hubSweepHz = m.traits.DefaultSweepHz
	}
	if hubSweepHz <= 0 {
		hubSweepHz = firmware.SweepHz
	}
	if fp, _ := st["fp"].(string); fp != "" && !strings.HasPrefix(strings.ToUpper(fp), "53504B") {
		label, _ := st["label"].(string)
		label = strings.TrimSpace(label)
		if label == "" {
			label = "H1"
		}
		if cur, ok := slot.hubHello[1]; !ok || cur.fp == "" || strings.HasPrefix(cur.fp, "53504B") {
			slot.hubHello[1] = slotHello{
				fp:      strings.ToUpper(strings.TrimSpace(fp)),
				label:   label,
				role:    firmware.RoleHubTimer,
				sweepHz: uint8(hubSweepHz),
			}
		}
	}
	rawSpokes, ok := st["spokes"].([]any)
	if !ok {
		return
	}
	for _, item := range rawSpokes {
		sp, ok := item.(map[string]any)
		if !ok {
			continue
		}
		spSlot, _ := asInt(sp["slot"])
		if spSlot < 2 || spSlot > 7 {
			continue
		}
		spFp, _ := sp["fp"].(string)
		spFp = strings.ToUpper(strings.TrimSpace(spFp))
		if spFp == "" || strings.HasPrefix(spFp, "53504B") {
			continue
		}
		frames, hasFrames := asInt(sp["frames"])
		msAgo, hasMsAgo := asInt(sp["msAgo"])
		if hasMsAgo && msAgo >= 0x80000000 {
			msAgo = 0
		}
		if (hasFrames && frames <= 0) || (hasMsAgo && msAgo >= 5000) {
			continue
		}
		spLabel, _ := sp["label"].(string)
		spLabel = strings.TrimSpace(spLabel)
		if spLabel == "" {
			spLabel = fmt.Sprintf("T%d", spSlot-1)
		}
		spHz, _ := asInt(sp["sweepHz"])
		if spHz <= 0 {
			spHz = firmware.SweepHz
		}
		if cur, ok := slot.hubHello[uint8(spSlot)]; !ok || cur.fp != spFp {
			slot.hubHello[uint8(spSlot)] = slotHello{
				fp:      spFp,
				label:   spLabel,
				role:    firmware.RoleSpokeTimer,
				sweepHz: uint8(spHz),
			}
		}
	}
}

// RebindConnectedTimers re-registers any currently open Hub and active Spokes in `Engine` + `HubRx`
// from cached `lastStatus` / `lastConfig` (for example right after `POST /v1/storage:reset` or
// `POST /v1/storage:import` wipes and rebuilds `Engine.detected` while a live Hub link stays open).
func (m *Manager) RebindConnectedTimers() {
	rebound := false
	for i := 0; i < MaxConnections; i++ {
		s := m.slots[i]
		s.mu.Lock()
		isConn := s.port != nil
		st := s.lastStatus
		cfg := s.lastConfig
		s.mu.Unlock()
		if !isConn {
			continue
		}
		if st != nil || cfg != nil {
			m.registerConnectedHubInEngine(st, cfg)
			rebound = true
		}
	}
	if rebound && m.cfg.HubRx != nil {
		m.cfg.HubRx.PushActiveChannels()
	}
}

func (m *Manager) registerConnectedHubInEngine(st map[string]any, cfg *firmware.TimerReadout) {
	m.mu.RLock()
	simRunning := m.simMode
	m.mu.RUnlock()
	if simRunning || m.cfg.Engine == nil {
		return
	}
	defaultHubHz := m.traits.DefaultSweepHz
	if defaultHubHz <= 0 {
		defaultHubHz = firmware.SweepHz
	}
	if st != nil {
		if roleNum, _ := asInt(st["role"]); roleNum == 1 {
			fp, _ := st["fp"].(string)
			label, _ := st["label"].(string)
			hubHz, _ := asInt(st["sweepHz"])
			if hubHz <= 0 {
				hubHz = defaultHubHz
			}
			if domain.IsValidSlapRFFingerprint(fp) {
				if tid, err := m.cfg.Engine.RegisterTimerHello(fp, true, label); err == nil && tid != 0 {
					m.cfg.Engine.MarkTimerSeen(tid)
				}
				if m.cfg.HubRx != nil {
					if m.cfg.HubRx.BindSlotHello(1, fp, true, uint8(hubHz), label) {
						m.logf("[SlapRF] bound tdma=1 fp=%s label=%q sweepHz=%d from STATUS?", fp, label, hubHz)
					}
				}
			}
			if rawSpokes, ok := st["spokes"].([]any); ok {
				for _, item := range rawSpokes {
					if sp, ok := item.(map[string]any); ok {
						spSlot, _ := asInt(sp["slot"])
						spFp, _ := sp["fp"].(string)
						spLabel, _ := sp["label"].(string)
						spHz, _ := asInt(sp["sweepHz"])
						if spHz <= 0 {
							spHz = firmware.SweepHz
						}
						frames, hasFrames := asInt(sp["frames"])
						msAgo, hasMsAgo := asInt(sp["msAgo"])
						if hasMsAgo && msAgo >= 0x80000000 {
							msAgo = 0
						}
						spokeActive := (!hasFrames || frames > 0) && (!hasMsAgo || msAgo < 5000)
						if domain.IsValidSlapRFFingerprint(spFp) && !strings.HasPrefix(strings.ToUpper(spFp), "53504B") {
							if spokeActive {
								m.cfg.Engine.ClearDeletedSpokeFingerprint(spFp)
							}
							if !m.cfg.Engine.IsDeletedSpokeFingerprint(spFp) {
								if tid, err := m.cfg.Engine.RegisterTimerHello(spFp, false, spLabel); err == nil && tid != 0 {
									if spokeActive {
										m.cfg.Engine.MarkTimerSeen(tid)
										if m.cfg.HubRx != nil && spSlot >= 2 && spSlot <= 7 {
											if m.cfg.HubRx.BindSlotHello(uint8(spSlot), spFp, false, uint8(spHz), spLabel) {
												m.logf("[SlapRF] bound tdma=%d fp=%s label=%q sweepHz=%d from STATUS?", spSlot, spFp, spLabel, spHz)
											}
										}
									} else {
										m.cfg.Engine.SetDetectedTimerOnline(tid, false)
									}
								}
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
		if m.cfg.HubRx != nil {
			if m.cfg.HubRx.BindSlotHello(1, cfg.Fingerprint, true, uint8(defaultHubHz), cfg.TimerLabel) {
				m.logf("[SlapRF] bound tdma=1 fp=%s label=%q sweepHz=%d from SLAPRF02", cfg.Fingerprint, cfg.TimerLabel, defaultHubHz)
			}
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
	transport, _ := st["transport"].(string)
	pairedBLE := role == "hub" && (m.traits.MarksBLEPaired || strings.EqualFold(strings.TrimSpace(transport), "ble"))
	nowMs := time.Now().UnixMilli()
	m.timers.Upsert(KnownHardwareTimer{
		FP:          fp,
		Role:        role,
		Label:       label,
		FW:          fw,
		MAC:         mac,
		Slot:        slotNum,
		Channel:     chNum,
		ParentHubFP: parentHubFp,
		PairedBLE:   pairedBLE,
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
					m.timers.Upsert(KnownHardwareTimer{
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
				m.timers.Upsert(KnownHardwareTimer{
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

func asInt(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case uint8:
		return int(n), true
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
