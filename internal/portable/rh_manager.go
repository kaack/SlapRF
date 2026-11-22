package portable

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"slaprf/internal/domain"
	"slaprf/internal/firmware"
	"slaprf/internal/rotorhazard"
	rhusb "slaprf/internal/rotorhazard/usb"
	"slaprf/internal/storage"
	"slaprf/internal/tracker"
)

const (
	kvRHTargetsKey    = "hw.rh_targets"
	kvRHUSBTargetsKey = "hw.rh_usb_targets"
)

// SavedRHTarget persists a RotorHazard timer connection target (Network Socket.IO or USB Serial) in `BoltStore`.
type SavedRHTarget struct {
	TimerID   uint8  `json:"timerId"`
	Label     string `json:"label"`
	Transport string `json:"transport,omitempty"` // "websocket" | "usb"
	PortName  string `json:"portName,omitempty"`  // For "usb"
	BaudRate  int    `json:"baudRate,omitempty"`  // For "usb" (0 = auto 115200/921600)
	Host      string `json:"host,omitempty"`      // For "websocket"
	Port      int    `json:"port,omitempty"`      // For "websocket"
	AdminUser string `json:"adminUser,omitempty"`
	AdminPass string `json:"adminPass,omitempty"`
}

// RHDiagSnapshot matches `RHClientDiagSnapshot` in `web/src/services/rh_hardware_link.ts`.
type RHDiagSnapshot struct {
	TimerID         uint8                         `json:"timerId"`
	Label           string                        `json:"label"`
	Transport       string                        `json:"transport"` // "websocket" | "usb"
	Endpoint        string                        `json:"endpoint"`
	PortName        string                        `json:"portName,omitempty"`
	BaudRate        int                           `json:"baudRate,omitempty"`
	APILevel        int                           `json:"apiLevel,omitempty"`
	Connected       bool                          `json:"connected"`
	AuthOK          bool                          `json:"authOk"`
	AuthKnown       bool                          `json:"authKnown"`
	ServerVersion   string                        `json:"serverVersion"`
	ServerHostname  string                        `json:"serverHostname,omitempty"`
	NodeCount       int                           `json:"nodeCount"`
	GateArmed       bool                          `json:"gateArmed"`
	ClockSynced     bool                          `json:"clockSynced"`
	ClockOffsetMs   float64                       `json:"clockOffsetMs"`
	HeartbeatsRx    uint64                        `json:"heartbeatsRx"`
	PassesRx        uint64                        `json:"passesRx"`
	SlotRSSI        [domain.MaxPilotSlots]float32 `json:"slotRssi"`
	CrossingFlag    [domain.MaxPilotSlots]bool    `json:"crossingFlag"`
	NodeEnterLevels [domain.MaxPilotSlots]uint8   `json:"nodeEnterLevels"`
	NodeExitLevels  [domain.MaxPilotSlots]uint8   `json:"nodeExitLevels"`
	NodeFreqsMHz    [domain.MaxPilotSlots]uint16  `json:"nodeFreqsMhz"`
	CpuTempC        float32                       `json:"cpuTempC,omitempty"`
	EnvSummary      string                        `json:"envSummary,omitempty"`
	LastError       string                        `json:"lastError,omitempty"`
	ScanLive        bool                          `json:"scanLive,omitempty"`
	LastScan        *domain.RHScanPass            `json:"lastScan,omitempty"`
}

type rhManagedSession struct {
	target    SavedRHTarget
	endpoint  string
	client    *rotorhazard.Client
	usbClient *rotorhazard.SerialClient
	cancel    context.CancelFunc
	mu        sync.Mutex
	sendFn    func(string)
	connected bool
	lastErr   string
}

func (s *rhManagedSession) isUSB() bool {
	return strings.EqualFold(s.target.Transport, "usb")
}

type rhEngineSub struct {
	onSync func()
}

func (s *rhEngineSub) OnTelemetryFrame(domain.TimerTelemetryFrame)                     {}
func (s *rhEngineSub) OnGateCrossing(domain.GateCrossingEvent)                         {}
func (s *rhEngineSub) OnDetectionFiltered(domain.FilteredDetection)                    {}
func (s *rhEngineSub) OnLapCompleted(domain.LapRecord, []domain.PilotTrackSummary)     {}
func (s *rhEngineSub) OnPracticeUpdated(domain.PracticeManagerState)                   { s.trigger() }
func (s *rhEngineSub) OnRaceUpdated(domain.RaceTournamentState, domain.EventManagerState, *domain.RaceAnnouncement) {
	s.trigger()
}
func (s *rhEngineSub) OnConfigUpdated([]domain.PilotSlot, []domain.TrackGate) { s.trigger() }
func (s *rhEngineSub) OnArmChanged(bool)                                      { s.trigger() }
func (s *rhEngineSub) trigger() {
	if s.onSync != nil {
		s.onSync()
	}
}

type rhManager struct {
	engine   *tracker.Engine
	store    *storage.BoltStore
	openPort firmware.SerialOpener
	logf     func(string, ...any)
	onDirty  func()

	mu         sync.RWMutex
	sessions   map[uint8]*rhManagedSession
	simMode    bool
	activeMode domain.TimingHardwareMode
	stopCh     chan struct{}
	stopOnce   sync.Once
}

func newRHManager(
	engine *tracker.Engine,
	store *storage.BoltStore,
	openPort firmware.SerialOpener,
	logf func(string, ...any),
	onDirty func(),
) *rhManager {
	if openPort == nil {
		openPort = rhusb.DefaultOpener()
	}
	m := &rhManager{
		engine:   engine,
		store:    store,
		openPort: openPort,
		logf:     logf,
		onDirty:  onDirty,
		sessions: make(map[uint8]*rhManagedSession),
		stopCh:   make(chan struct{}),
	}
	engine.Subscribe(&rhEngineSub{onSync: m.SyncAll})

	go func() {
		ticker := time.NewTicker(2500 * time.Millisecond)
		defer ticker.Stop()
		ticks := 0
		for {
			select {
			case <-m.stopCh:
				return
			case <-ticker.C:
				ticks++
				m.mu.RLock()
				if m.simMode {
					m.mu.RUnlock()
					continue
				}
				list := make([]*rhManagedSession, 0, len(m.sessions))
				for _, sess := range m.sessions {
					list = append(list, sess)
				}
				m.mu.RUnlock()

				for _, sess := range list {
					if sess.isUSB() || sess.client == nil {
						continue
					}
					st := sess.client.Snapshot()
					if st.Connected && (!st.ClockSynced || ticks%2 == 0) {
						sess.client.RequestClockSync()
					}
				}
			}
		}
	}()

	return m
}

func (m *rhManager) closeAllSessionsWithoutPersist() {
	m.mu.Lock()
	list := make([]*rhManagedSession, 0, len(m.sessions))
	for _, s := range m.sessions {
		list = append(list, s)
	}
	m.sessions = make(map[uint8]*rhManagedSession)
	m.mu.Unlock()

	for _, s := range list {
		s.cancel()
		if s.client != nil {
			s.client.OnDisconnected()
		}
		m.engine.SetDetectedTimerOnline(s.target.TimerID, false)
	}
}

func (m *rhManager) close() {
	m.stopOnce.Do(func() {
		close(m.stopCh)
	})
	m.closeAllSessionsWithoutPersist()
}

func (m *rhManager) RestorePersistedTargets(simMode bool) {
	m.reconcile(simMode, true)
}

func (m *rhManager) SetSimMode(simRunning bool) {
	m.reconcile(simRunning, true)
}

// Reconcile suspends inactive RotorHazard Network (`hw.rh_targets`) or RotorHazard USB
// (`hw.rh_usb_targets`) sessions whenever `simRunning` or `engine.TimingHardwareMode()` changes.
func (m *rhManager) Reconcile(simRunning bool) {
	m.reconcile(simRunning, false)
}

func (m *rhManager) reconcile(simRunning bool, restoreSaved bool) {
	hwMode := domain.NormalizeTimingHardwareMode(m.engine.TimingHardwareMode())
	wantActive := !simRunning && domain.IsRotorHazardMode(hwMode)

	m.mu.Lock()
	prevSim := m.simMode
	prevMode := m.activeMode
	m.simMode = simRunning
	if !wantActive {
		m.activeMode = ""
		m.mu.Unlock()
		if prevMode != "" || (!prevSim && simRunning) {
			m.closeAllSessionsWithoutPersist()
		}
		return
	}
	if prevMode == hwMode && !prevSim {
		m.mu.Unlock()
		return
	}
	m.activeMode = hwMode
	m.mu.Unlock()

	m.closeAllSessionsWithoutPersist()
	if !restoreSaved || m.store == nil {
		return
	}
	kvKey := kvRHTargetsKey
	if hwMode == domain.HardwareModeRotorHazardUSB {
		kvKey = kvRHUSBTargetsKey
	}
	var saved []SavedRHTarget
	if ok, err := m.store.GetJSON(kvKey, &saved); err == nil && ok {
		for _, tgt := range saved {
			t := tgt
			if hwMode == domain.HardwareModeRotorHazardUSB {
				t.Transport = "usb"
			} else {
				t.Transport = "websocket"
			}
			go func() {
				_, _ = m.Connect(t)
			}()
		}
	}
}

func (m *rhManager) persistTargetsForMode(isUSB bool) {
	if m.store == nil {
		return
	}
	m.mu.RLock()
	out := make([]SavedRHTarget, 0, len(m.sessions))
	for _, s := range m.sessions {
		if s.isUSB() == isUSB {
			out = append(out, s.target)
		}
	}
	m.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].TimerID < out[j].TimerID })
	if isUSB {
		_ = m.store.PutJSON(kvRHUSBTargetsKey, out)
	} else {
		_ = m.store.PutJSON(kvRHTargetsKey, out)
	}
}

func (m *rhManager) syncOne(sess *rhManagedSession) {
	specs := m.engine.ActiveRHNodeSpecs(sess.target.TimerID)
	var nodes [domain.MaxPilotSlots]rotorhazard.NodeConfig
	for i := 0; i < domain.MaxPilotSlots; i++ {
		nodes[i] = rotorhazard.NodeConfig{
			Enabled:      specs[i].Enabled,
			Band:         specs[i].Band,
			Channel:      specs[i].Channel,
			FrequencyMHz: specs[i].FrequencyMHz,
			EnterAtLevel: specs[i].EnterAtLevel,
			ExitAtLevel:  specs[i].ExitAtLevel,
		}
	}
	armed := m.engine.IsRaceArmed()
	if sess.isUSB() && sess.usbClient != nil {
		sess.usbClient.SyncNodesAndArm(nodes, armed)
	} else if sess.client != nil {
		sess.client.SyncNodesAndArm(nodes, armed)
	}
}

func (m *rhManager) SyncAll() {
	m.mu.RLock()
	list := make([]*rhManagedSession, 0, len(m.sessions))
	for _, s := range m.sessions {
		list = append(list, s)
	}
	m.mu.RUnlock()
	for _, s := range list {
		m.syncOne(s)
	}
}

func (m *rhManager) Connect(req SavedRHTarget) (RHDiagSnapshot, error) {
	hwMode := domain.NormalizeTimingHardwareMode(m.engine.TimingHardwareMode())
	isUSB := strings.EqualFold(req.Transport, "usb") ||
		(req.Transport == "" && strings.TrimSpace(req.PortName) != "") ||
		(req.Transport == "" && hwMode == domain.HardwareModeRotorHazardUSB)

	if isUSB {
		return m.connectUSB(req)
	}
	return m.connectWebSocket(req)
}

func (m *rhManager) connectUSB(req SavedRHTarget) (RHDiagSnapshot, error) {
	req.Transport = "usb"
	req.PortName = strings.TrimSpace(req.PortName)
	if req.PortName == "" {
		return RHDiagSnapshot{}, errors.New("missing RotorHazard USB serial port name")
	}

	// Avoid duplicate sessions on the same COM/tty port: reuse existing TimerID if already assigned to this port
	m.mu.RLock()
	for tid, existing := range m.sessions {
		if existing.isUSB() && strings.EqualFold(existing.target.PortName, req.PortName) && req.TimerID == 0 {
			req.TimerID = tid
			break
		}
	}
	m.mu.RUnlock()

	label := strings.TrimSpace(req.Label)
	assignedID := m.engine.EnsureRHTimerRegistered(req.TimerID, label, true)
	req.TimerID = assignedID
	if label == "" || strings.HasPrefix(strings.ToLower(label), "rh (") {
		unitNum := int(assignedID) - 1
		if unitNum < 1 {
			unitNum = 1
		}
		label = fmt.Sprintf("R%d", unitNum)
	}
	req.Label = label

	m.mu.Lock()
	if prev := m.sessions[assignedID]; prev != nil {
		prev.cancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	sess := &rhManagedSession{
		target:   req,
		endpoint: req.PortName,
		cancel:   cancel,
	}
	sess.usbClient = rotorhazard.NewSerialClient(rotorhazard.SerialClientConfig{
		PortName: req.PortName,
		BaudRate: req.BaudRate,
		OpenPort: func(portName string, baud int) (rotorhazard.SerialPort, error) {
			return m.openPort(portName, baud)
		},
		Hooks: rotorhazard.ClientHooks{
			NowUs: m.engine.NowUs,
			OnHeartbeat: func(ev rotorhazard.ClientHeartbeatEvent) {
				m.engine.IngestExternalRHHeartbeat(assignedID, label, ev.SlotRSSI)
			},
			OnPass: func(ev rotorhazard.ClientPassEvent) {
				m.engine.InjectExternalRHCrossing(
					assignedID,
					ev.SlotIndex,
					ev.HostTimeUs,
					ev.PeakRSSI,
					ev.PassingNumber,
				)
			},
		},
	})
	m.sessions[assignedID] = sess
	m.activeMode = domain.HardwareModeRotorHazardUSB
	m.mu.Unlock()

	m.syncOne(sess)
	m.persistTargetsForMode(true)
	if m.onDirty != nil {
		m.onDirty()
	}

	firstDone := make(chan error, 1)
	go m.runUSBSessionLoop(ctx, sess, firstDone)

	select {
	case cErr := <-firstDone:
		if cErr != nil {
			return m.snapshotOne(sess), cErr
		}
	case <-time.After(4500 * time.Millisecond):
	}
	return m.snapshotOne(sess), nil
}

func (m *rhManager) runUSBSessionLoop(ctx context.Context, sess *rhManagedSession, firstDone chan<- error) {
	first := true
	reportFirst := func(err error) {
		if first {
			first = false
			select {
			case firstDone <- err:
			default:
			}
		}
	}

	backoff := 1500 * time.Millisecond
	for {
		if ctx.Err() != nil {
			return
		}
		err := sess.usbClient.RunOnce(ctx, func(readyErr error) {
			if readyErr == nil {
				sess.mu.Lock()
				sess.connected = true
				sess.lastErr = ""
				sess.mu.Unlock()
				m.engine.SetDetectedTimerOnline(sess.target.TimerID, true)
				st := sess.usbClient.Snapshot()
				m.logf("[RotorHazard USB] Connected to %s (%s · API %d · %d seats · %d baud)",
					sess.target.PortName, sess.target.Label, st.APILevel, st.NodeCount, st.BaudRate)
				m.syncOne(sess)
			}
			reportFirst(readyErr)
		})
		m.engine.SetDetectedTimerOnline(sess.target.TimerID, false)
		sess.mu.Lock()
		sess.connected = false
		if err != nil && ctx.Err() == nil {
			sess.lastErr = err.Error()
		}
		sess.mu.Unlock()
		reportFirst(err)

		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
			if backoff < 6*time.Second {
				backoff += 1500 * time.Millisecond
			}
		}
	}
}

func (m *rhManager) connectWebSocket(req SavedRHTarget) (RHDiagSnapshot, error) {
	req.Transport = "websocket"
	req.Host = strings.TrimSpace(req.Host)
	if req.Port <= 0 {
		req.Port = DefaultRotorHazardPort
	}
	req.AdminUser = strings.TrimSpace(req.AdminUser)

	ctxCheck, cancelCheck := context.WithTimeout(context.Background(), 3*time.Second)
	targetAddr, err := resolveAllowedLapRFAddr(ctxCheck, req.Host, req.Port, true)
	cancelCheck()
	if err != nil {
		return RHDiagSnapshot{}, err
	}

	label := strings.TrimSpace(req.Label)
	assignedID := m.engine.EnsureRHTimerRegistered(req.TimerID, label, false)
	req.TimerID = assignedID
	if label == "" || strings.HasPrefix(strings.ToLower(label), "rh (") {
		unitNum := int(assignedID) - 1
		if unitNum < 1 {
			unitNum = 1
		}
		label = fmt.Sprintf("R%d", unitNum)
	}
	req.Label = label

	m.mu.Lock()
	if prev := m.sessions[assignedID]; prev != nil {
		prev.cancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	sess := &rhManagedSession{
		target:   req,
		endpoint: targetAddr,
		cancel:   cancel,
	}
	sess.client = rotorhazard.NewClient(rotorhazard.ClientHooks{
		NowUs: m.engine.NowUs,
		SendSIO: func(sioFrame string) {
			sess.mu.Lock()
			send := sess.sendFn
			sess.mu.Unlock()
			if send != nil {
				send(sioFrame)
			}
		},
		OnHeartbeat: func(ev rotorhazard.ClientHeartbeatEvent) {
			m.engine.IngestExternalRHHeartbeat(assignedID, label, ev.SlotRSSI)
		},
		OnPass: func(ev rotorhazard.ClientPassEvent) {
			m.engine.InjectExternalRHCrossing(
				assignedID,
				ev.SlotIndex,
				ev.HostTimeUs,
				ev.PeakRSSI,
				ev.PassingNumber,
			)
		},
	})
	m.sessions[assignedID] = sess
	m.activeMode = domain.HardwareModeRotorHazard
	m.mu.Unlock()

	firstDone := make(chan error, 1)
	go m.runSessionLoop(ctx, sess, firstDone)

	select {
	case cErr := <-firstDone:
		if cErr != nil {
			cancel()
			m.mu.Lock()
			if m.sessions[assignedID] == sess {
				delete(m.sessions, assignedID)
			}
			m.mu.Unlock()
			m.engine.SetDetectedTimerOnline(assignedID, false)
			m.persistTargetsForMode(false)
			return RHDiagSnapshot{}, cErr
		}
	case <-time.After(4 * time.Second):
	}
	m.persistTargetsForMode(false)
	if m.onDirty != nil {
		m.onDirty()
	}
	return m.snapshotOne(sess), nil
}

func (m *rhManager) runSessionLoop(ctx context.Context, sess *rhManagedSession, firstDone chan<- error) {
	first := true
	reportFirst := func(err error) {
		if first {
			first = false
			select {
			case firstDone <- err:
			default:
			}
		}
	}

	backoff := 1500 * time.Millisecond
	for {
		if ctx.Err() != nil {
			return
		}
		err := m.runEIOv4SessionOnce(ctx, sess, reportFirst)
		sess.client.OnDisconnected()
		m.engine.SetDetectedTimerOnline(sess.target.TimerID, false)
		sess.mu.Lock()
		sess.connected = false
		sess.sendFn = nil
		if err != nil && ctx.Err() == nil {
			sess.lastErr = err.Error()
		}
		sess.mu.Unlock()
		reportFirst(err)

		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
			if backoff < 6*time.Second {
				backoff += 1500 * time.Millisecond
			}
		}
	}
}

func (m *rhManager) runEIOv4SessionOnce(ctx context.Context, sess *rhManagedSession, reportFirst func(error)) error {
	jar, _ := cookiejar.New(nil)
	hc := &http.Client{
		Timeout: 4 * time.Second,
		Jar:     jar,
	}
	hasAuthCreds := sess.target.AdminUser != "" || sess.target.AdminPass != ""
	authHeader := ""
	if hasAuthCreds {
		authHeader = "Basic " + base64.StdEncoding.EncodeToString([]byte(sess.target.AdminUser+":"+sess.target.AdminPass))
	}
	baseHTTP := fmt.Sprintf("http://%s/socket.io/?EIO=4&transport=polling", sess.endpoint)

	openReq, err := http.NewRequestWithContext(ctx, http.MethodGet, baseHTTP, nil)
	if err != nil {
		return err
	}
	if authHeader != "" {
		openReq.Header.Set("Authorization", authHeader)
	}
	openResp, err := hc.Do(openReq)
	if err != nil {
		return err
	}
	openBody, _ := io.ReadAll(io.LimitReader(openResp.Body, 16384))
	_ = openResp.Body.Close()
	if openResp.StatusCode == http.StatusUnauthorized || openResp.StatusCode == http.StatusForbidden {
		return fmt.Errorf("RotorHazard authentication failed (HTTP %d)", openResp.StatusCode)
	}
	if openResp.StatusCode < 200 || openResp.StatusCode >= 300 {
		return fmt.Errorf("RotorHazard handshake HTTP %d", openResp.StatusCode)
	}

	var sid string
	var initialSIOFrames []string
	for _, pkt := range rotorhazard.SplitEIOPayload(string(openBody)) {
		if strings.HasPrefix(pkt, "0") {
			if op, decErr := rotorhazard.DecodeEIOOpen(pkt); decErr == nil && op.SID != "" {
				sid = op.SID
			}
		} else if strings.HasPrefix(pkt, "4") {
			initialSIOFrames = append(initialSIOFrames, pkt)
		}
	}
	if sid == "" {
		return errors.New("RotorHazard did not return an Engine.IO v4 session ID")
	}

	sioConnected := false
	for _, f := range initialSIOFrames {
		if strings.HasPrefix(f, "40") {
			sioConnected = true
		}
	}
	pollURL := fmt.Sprintf("%s&sid=%s", baseHTTP, url.QueryEscape(sid))
	if !sioConnected {
		postReq, pErr := http.NewRequestWithContext(ctx, http.MethodPost, pollURL, bytes.NewBufferString("40"))
		if pErr != nil {
			return pErr
		}
		if authHeader != "" {
			postReq.Header.Set("Authorization", authHeader)
		}
		postReq.Header.Set("Content-Type", "text/plain;charset=UTF-8")
		postResp, pErr := hc.Do(postReq)
		if pErr != nil {
			return pErr
		}
		_, _ = io.Copy(io.Discard, postResp.Body)
		_ = postResp.Body.Close()
	}

	wsURL := fmt.Sprintf("ws://%s/socket.io/?EIO=4&transport=websocket&sid=%s", sess.endpoint, url.QueryEscape(sid))
	hdr := http.Header{}
	if authHeader != "" {
		hdr.Set("Authorization", authHeader)
	}
	if uParsed, uErr := url.Parse("http://" + sess.endpoint); uErr == nil && jar != nil {
		var cookieParts []string
		for _, c := range jar.Cookies(uParsed) {
			cookieParts = append(cookieParts, c.Name+"="+c.Value)
		}
		if len(cookieParts) > 0 {
			hdr.Set("Cookie", strings.Join(cookieParts, "; "))
		}
	}

	dialCtx, dialCancel := context.WithTimeout(ctx, 4*time.Second)
	ws, _, err := websocket.Dial(dialCtx, wsURL, &websocket.DialOptions{
		HTTPHeader: hdr,
	})
	dialCancel()
	if err != nil {
		return err
	}
	ws.SetReadLimit(1 << 20)
	defer func() { _ = ws.CloseNow() }()

	var writeMu sync.Mutex
	writeWS := func(frame string) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		wCtx, wCancel := context.WithTimeout(ctx, wsWriteTimeout)
		defer wCancel()
		return ws.Write(wCtx, websocket.MessageText, []byte(frame))
	}

	if err := writeWS("2probe"); err != nil {
		return err
	}
	upgraded := false
	upgradeDeadline := time.Now().Add(3 * time.Second)
	var bufferedFrames []string
	for !upgraded && time.Now().Before(upgradeDeadline) {
		rCtx, rCancel := context.WithTimeout(ctx, 2*time.Second)
		_, raw, rErr := ws.Read(rCtx)
		rCancel()
		if rErr != nil {
			return rErr
		}
		txt := string(raw)
		if txt == "3probe" {
			if err := writeWS("5"); err != nil {
				return err
			}
			upgraded = true
			break
		}
		if strings.HasPrefix(txt, "4") {
			bufferedFrames = append(bufferedFrames, txt)
		}
	}
	if !upgraded {
		return errors.New("RotorHazard Engine.IO WebSocket upgrade did not complete")
	}

	sess.mu.Lock()
	sess.sendFn = func(sioFrame string) {
		_ = writeWS(sioFrame)
	}
	sess.mu.Unlock()

	sess.client.OnConnected()
	for _, f := range initialSIOFrames {
		sess.client.FeedSIOFrame(f)
	}
	for _, f := range bufferedFrames {
		sess.client.FeedSIOFrame(f)
	}

	authDeadline := time.Now().Add(1200 * time.Millisecond)
	for !sess.client.Snapshot().AuthKnown && time.Now().Before(authDeadline) {
		rCtx, rCancel := context.WithTimeout(ctx, 300*time.Millisecond)
		_, raw, rErr := ws.Read(rCtx)
		rCancel()
		if rErr != nil {
			break
		}
		msg := string(raw)
		switch {
		case msg == "2":
			_ = writeWS("3")
		case msg == "1":
			return errors.New("RotorHazard closed Engine.IO session")
		case strings.HasPrefix(msg, "4"):
			sess.client.FeedSIOFrame(msg)
		}
	}
	if st := sess.client.Snapshot(); st.AuthKnown && !st.AuthOK {
		return fmt.Errorf("RotorHazard authentication rejected on %s (check Admin Username & Password)", sess.endpoint)
	}

	sess.mu.Lock()
	sess.connected = true
	sess.lastErr = ""
	sess.mu.Unlock()
	m.engine.SetDetectedTimerOnline(sess.target.TimerID, true)
	m.logf("[RotorHazard] Connected to %s (%s)", sess.endpoint, sess.target.Label)

	m.syncOne(sess)
	reportFirst(nil)

	for {
		_, raw, rErr := ws.Read(ctx)
		if rErr != nil {
			return rErr
		}
		msg := string(raw)
		switch {
		case msg == "2":
			_ = writeWS("3")
		case msg == "1":
			return errors.New("RotorHazard closed Engine.IO session")
		case strings.HasPrefix(msg, "4"):
			sess.client.FeedSIOFrame(msg)
		}
	}
}

func (m *rhManager) Disconnect(timerID uint8) {
	m.mu.Lock()
	sess := m.sessions[timerID]
	delete(m.sessions, timerID)
	m.mu.Unlock()
	isUSB := m.engine.TimingHardwareMode() == domain.HardwareModeRotorHazardUSB
	if sess != nil {
		isUSB = sess.isUSB()
		sess.cancel()
		if sess.client != nil {
			sess.client.OnDisconnected()
		}
	}
	m.engine.SetDetectedTimerOnline(timerID, false)
	m.persistTargetsForMode(isUSB)
	if m.onDirty != nil {
		m.onDirty()
	}
}

func (m *rhManager) snapshotOne(sess *rhManagedSession) RHDiagSnapshot {
	var st rotorhazard.ClientStatusSnapshot
	transport := "websocket"
	if sess.isUSB() {
		transport = "usb"
		if sess.usbClient != nil {
			st = sess.usbClient.Snapshot()
		}
	} else if sess.client != nil {
		st = sess.client.Snapshot()
	}
	sess.mu.Lock()
	conn := sess.connected
	lastErr := sess.lastErr
	sess.mu.Unlock()

	baud := st.BaudRate
	if baud <= 0 {
		baud = sess.target.BaudRate
	}
	return RHDiagSnapshot{
		TimerID:         sess.target.TimerID,
		Label:           sess.target.Label,
		Transport:       transport,
		Endpoint:        sess.endpoint,
		PortName:        sess.target.PortName,
		BaudRate:        baud,
		APILevel:        st.APILevel,
		Connected:       conn && st.Connected,
		AuthOK:          st.AuthOK,
		AuthKnown:       st.AuthKnown,
		ServerVersion:   st.ServerVersion,
		ServerHostname:  st.ServerHostname,
		NodeCount:       st.NodeCount,
		GateArmed:       st.GateArmed,
		ClockSynced:     st.ClockSynced,
		ClockOffsetMs:   st.ClockOffsetMs,
		HeartbeatsRx:    st.HeartbeatsRx,
		PassesRx:        st.PassesRx,
		SlotRSSI:        st.SlotRSSI,
		CrossingFlag:    st.CrossingFlag,
		NodeEnterLevels: st.NodeEnterLevels,
		NodeExitLevels:  st.NodeExitLevels,
		NodeFreqsMHz:    st.NodeFreqsMHz,
		CpuTempC:        st.CpuTempC,
		EnvSummary:      st.EnvSummary,
		LastError:       lastErr,
		ScanLive:        st.ScanLive,
		LastScan:        st.LastScan,
	}
}

func (m *rhManager) findUSBSession(timerID uint8) (*rhManagedSession, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if timerID > 0 {
		if s := m.sessions[timerID]; s != nil && s.isUSB() && s.usbClient != nil {
			return s, nil
		}
	}
	for _, s := range m.sessions {
		if s.isUSB() && s.usbClient != nil && s.connected {
			return s, nil
		}
	}
	for _, s := range m.sessions {
		if s.isUSB() && s.usbClient != nil {
			return s, nil
		}
	}
	return nil, errors.New("no RotorHazard USB device connected")
}

func (m *rhManager) RunScanOnce(ctx context.Context, timerID uint8, startMHz, stopMHz, stepMHz int) (domain.RHScanPass, error) {
	sess, err := m.findUSBSession(timerID)
	if err != nil {
		return domain.RHScanPass{}, err
	}
	return sess.usbClient.RunScanOnce(ctx, startMHz, stopMHz, stepMHz)
}

func (m *rhManager) SetScanLive(timerID uint8, active bool, startMHz, stopMHz, stepMHz int) error {
	if !active && timerID == 0 {
		m.mu.RLock()
		list := make([]*rhManagedSession, 0, len(m.sessions))
		for _, s := range m.sessions {
			if s.isUSB() && s.usbClient != nil {
				list = append(list, s)
			}
		}
		m.mu.RUnlock()
		for _, s := range list {
			s.usbClient.SetScanLive(false, startMHz, stopMHz, stepMHz)
			m.syncOne(s)
		}
		return nil
	}
	sess, err := m.findUSBSession(timerID)
	if err != nil {
		if !active {
			return nil
		}
		return err
	}
	sess.usbClient.SetScanLive(active, startMHz, stopMHz, stepMHz)
	if !active {
		m.syncOne(sess)
	}
	return nil
}

func (m *rhManager) Snapshots() []RHDiagSnapshot {
	m.mu.RLock()
	out := make([]RHDiagSnapshot, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, m.snapshotOne(s))
	}
	m.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].TimerID < out[j].TimerID })
	return out
}

// --- HTTP Handlers ---

func (s *Server) handleRHStatus(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	isUSBMode := s.realEngine.TimingHardwareMode() == domain.HardwareModeRotorHazardUSB
	var savedNet []SavedRHTarget
	var savedUSB []SavedRHTarget
	if s.store != nil {
		_, _ = s.store.GetJSON(kvRHTargetsKey, &savedNet)
		_, _ = s.store.GetJSON(kvRHUSBTargetsKey, &savedUSB)
	}
	sanitizedNet := make([]SavedRHTarget, 0, len(savedNet))
	for _, item := range savedNet {
		item.AdminPass = ""
		if item.Transport == "" {
			item.Transport = "websocket"
		}
		sanitizedNet = append(sanitizedNet, item)
	}
	for i := range savedUSB {
		savedUSB[i].Transport = "usb"
	}
	activeSaved := sanitizedNet
	if isUSBMode {
		activeSaved = savedUSB
	}
	writeJSONNoStore(w, http.StatusOK, map[string]any{
		"connections":     s.rhMgr.Snapshots(),
		"savedTargets":    activeSaved,
		"savedUSBTargets": savedUSB,
		"savedNetTargets": sanitizedNet,
	})
}

func (s *Server) handleRHConnect(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req SavedRHTarget
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON body"})
		return
	}
	isUSB := strings.EqualFold(req.Transport, "usb") ||
		(req.Transport == "" && strings.TrimSpace(req.PortName) != "") ||
		(req.Transport == "" && s.realEngine.TimingHardwareMode() == domain.HardwareModeRotorHazardUSB)

	// If password omitted on network reconnect, reuse stored password for same host/port if available
	if !isUSB && req.AdminPass == "" && s.store != nil {
		var saved []SavedRHTarget
		if ok, err := s.store.GetJSON(kvRHTargetsKey, &saved); err == nil && ok {
			for _, st := range saved {
				if strings.EqualFold(st.Host, req.Host) && (req.Port == 0 || st.Port == req.Port) && st.AdminPass != "" {
					req.AdminPass = st.AdminPass
					break
				}
			}
		}
	}
	snap, err := s.rhMgr.Connect(req)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "authentication") {
			writeJSONNoStore(w, http.StatusOK, map[string]any{
				"authRequired": true,
				"error":        err.Error(),
				"connection":   snap,
			})
			return
		}
		writeJSONNoStore(w, http.StatusBadGateway, map[string]any{
			"error":      err.Error(),
			"connection": snap,
		})
		return
	}
	w.Header().Set("Location", fmt.Sprintf("/v1/rotorhazard/connections/%d", snap.TimerID))
	writeJSONNoStore(w, http.StatusCreated, map[string]any{"connection": snap})
}

func (s *Server) handleRHDisconnect(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	rawID := strings.TrimSpace(r.PathValue("timerId"))
	if strings.Contains(rawID, ":") {
		w.Header().Set("Allow", "POST")
		writeJSONNoStore(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	tid, err := strconv.Atoi(rawID)
	if err != nil || tid <= 0 || tid > 255 {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "invalid timerId"})
		return
	}
	s.rhMgr.Disconnect(uint8(tid))
	writeJSONNoStore(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleRHSync(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.rhMgr.SyncAll()
	writeJSONNoStore(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleRHSessionAction(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	rawVal := strings.TrimSpace(r.PathValue("timerId"))
	idStr, action, hasColon := strings.Cut(rawVal, ":")
	if !hasColon {
		w.Header().Set("Allow", "DELETE")
		writeJSONNoStore(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	if action != "scan" {
		writeJSONNoStore(w, http.StatusNotFound, map[string]any{"error": "unknown custom action"})
		return
	}
	tid, err := strconv.Atoi(strings.TrimSpace(idStr))
	if err != nil || tid <= 0 || tid > 255 {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "invalid timerId"})
		return
	}
	var req struct {
		Mode  string `json:"mode"` // "once" | "live" | "stop"
		Start int    `json:"start"`
		Stop  int    `json:"stop"`
		Step  int    `json:"step"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON body"})
		return
	}
	timerID := uint8(tid)
	mode := strings.ToLower(strings.TrimSpace(req.Mode))
	switch mode {
	case "once":
		ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
		defer cancel()
		pass, err := s.rhMgr.RunScanOnce(ctx, timerID, req.Start, req.Stop, req.Step)
		if err != nil {
			writeJSONNoStore(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
			return
		}
		writeJSONNoStore(w, http.StatusOK, map[string]any{"ok": true, "scan": pass})
	case "live":
		if err := s.rhMgr.SetScanLive(timerID, true, req.Start, req.Stop, req.Step); err != nil {
			writeJSONNoStore(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
			return
		}
		s.realEngine.SetRHDebugStream(timerID, false)
		writeJSONNoStore(w, http.StatusOK, map[string]any{"ok": true, "scanLive": true})
	case "stop":
		if err := s.rhMgr.SetScanLive(timerID, false, req.Start, req.Stop, req.Step); err != nil {
			writeJSONNoStore(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
			return
		}
		writeJSONNoStore(w, http.StatusOK, map[string]any{"ok": true, "scanLive": false})
	default:
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "invalid scan mode (expected once, live, or stop)"})
	}
}

// Ensure net package referenced cleanly
var _ = net.JoinHostPort

func (s *Server) handleRHUSBPorts(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	showAll := r.URL.Query().Get("all") == "1" || strings.EqualFold(r.URL.Query().Get("all"), "true")
	ports, err := rhusb.ListPorts(s.cfg.USBListPorts, showAll)
	if err != nil {
		writeJSONNoStore(w, http.StatusOK, map[string]any{"ports": []rhusb.PortInfo{}, "error": err.Error()})
		return
	}
	if ports == nil {
		ports = []rhusb.PortInfo{}
	}
	writeJSONNoStore(w, http.StatusOK, map[string]any{"ports": ports})
}
