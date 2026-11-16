package portable

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/laprf"
	"slaprf/internal/storage"
	"slaprf/internal/tracker"
	"slaprf/internal/usb"
)

const kvLapRFTargetsKey = "hw.laprf_targets"

// SavedLapRFTarget persists a configured physical LapRF 8-Way link in `BoltStore`.
type SavedLapRFTarget struct {
	TimerID   uint8  `json:"timerId"`
	Label     string `json:"label"`
	Transport string `json:"transport"` // "ethernet" | "usb"
	Host      string `json:"host,omitempty"`
	Port      int    `json:"port,omitempty"`
	PortName  string `json:"portName,omitempty"`
}

// LapRFDiagSnapshot matches `LapRFClientDiagSnapshot` in `web/src/services/laprf_hardware_link.ts`.
type LapRFDiagSnapshot struct {
	TimerID     uint8                         `json:"timerId"`
	Label       string                        `json:"label"`
	Transport   string                        `json:"transport"` // "ethernet" | "usb"
	Endpoint    string                        `json:"endpoint"`
	Connected   bool                          `json:"connected"`
	VoltageMv   uint16                        `json:"voltageMv"`
	GateArmed   bool                          `json:"gateArmed"`
	RTCSynced   bool                          `json:"rtcSynced"`
	RTCOffsetMs float64                       `json:"rtcOffsetMs"`
	FramesRx       uint64                        `json:"framesRx"`
	PassingsRx     uint64                        `json:"passingsRx"`
	SlotRSSI       [domain.MaxPilotSlots]float32 `json:"slotRssi"`
	SlotFreqsMHz   [domain.MaxPilotSlots]uint16  `json:"slotFreqsMhz,omitempty"`
	SlotThresholds [domain.MaxPilotSlots]float32 `json:"slotThresholds,omitempty"`
	LastError      string                        `json:"lastError,omitempty"`
}

type laprfManagedSession struct {
	target    SavedLapRFTarget
	endpoint  string
	client    *laprf.Client
	cancel    context.CancelFunc
	mu        sync.Mutex
	connected bool
	lastErr   string
}

type laprfEngineSub struct {
	onSync func()
}

func (s *laprfEngineSub) OnTelemetryFrame(domain.TimerTelemetryFrame)                     {}
func (s *laprfEngineSub) OnGateCrossing(domain.GateCrossingEvent)                         {}
func (s *laprfEngineSub) OnDetectionFiltered(domain.FilteredDetection)                    {}
func (s *laprfEngineSub) OnLapCompleted(domain.LapRecord, []domain.PilotTrackSummary)     {}
func (s *laprfEngineSub) OnPracticeUpdated(domain.PracticeManagerState)                   {}
func (s *laprfEngineSub) OnRaceUpdated(domain.RaceTournamentState, domain.EventManagerState, *domain.RaceAnnouncement) {
}
func (s *laprfEngineSub) OnConfigUpdated([]domain.PilotSlot, []domain.TrackGate) {
	if s.onSync != nil {
		s.onSync()
	}
}

type laprfManager struct {
	engine  *tracker.Engine
	store   *storage.BoltStore
	logf    func(string, ...any)
	onDirty func()

	mu       sync.RWMutex
	sessions map[uint8]*laprfManagedSession
	simMode  bool
	stopCh   chan struct{}
	stopOnce sync.Once
}

func newLapRFManager(engine *tracker.Engine, store *storage.BoltStore, logf func(string, ...any), onDirty func()) *laprfManager {
	m := &laprfManager{
		engine:   engine,
		store:    store,
		logf:     logf,
		onDirty:  onDirty,
		sessions: make(map[uint8]*laprfManagedSession),
		stopCh:   make(chan struct{}),
	}
	engine.Subscribe(&laprfEngineSub{onSync: m.SyncAll})

	go func() {
		ticker := time.NewTicker(2 * time.Second)
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
				list := make([]*laprfManagedSession, 0, len(m.sessions))
				for _, sess := range m.sessions {
					list = append(list, sess)
				}
				m.mu.RUnlock()

				for _, sess := range list {
					sess.mu.Lock()
					conn := sess.connected
					sess.mu.Unlock()
					if !conn {
						continue
					}
					st, _, _ := sess.client.Snapshot()
					if !st.RTCSynced || ticks%5 == 0 {
						sess.client.RequestTimeSync()
					}
				}
			}
		}
	}()

	return m
}

func (m *laprfManager) close() {
	m.stopOnce.Do(func() {
		close(m.stopCh)
	})
	m.mu.Lock()
	list := make([]*laprfManagedSession, 0, len(m.sessions))
	for _, s := range m.sessions {
		list = append(list, s)
	}
	m.sessions = make(map[uint8]*laprfManagedSession)
	m.mu.Unlock()
	for _, s := range list {
		s.cancel()
	}
}

func (m *laprfManager) RestorePersistedTargets(simMode bool) {
	m.mu.Lock()
	m.simMode = simMode
	m.mu.Unlock()
	if m.store == nil || simMode {
		return
	}
	if m.engine.TimingHardwareMode() != domain.HardwareModeLapRF {
		return
	}
	var saved []SavedLapRFTarget
	if ok, err := m.store.GetJSON(kvLapRFTargetsKey, &saved); err == nil && ok {
		for _, tgt := range saved {
			t := tgt
			go func() {
				_, _ = m.Connect(t)
			}()
		}
	}
}

func (m *laprfManager) SetSimMode(simRunning bool) {
	m.mu.Lock()
	prev := m.simMode
	m.simMode = simRunning
	m.mu.Unlock()
	if prev == simRunning {
		return
	}
	if simRunning {
		m.stopActiveSessionsWithoutForgetting()
		return
	}
	m.RestorePersistedTargets(false)
}

func (m *laprfManager) stopActiveSessionsWithoutForgetting() {
	m.mu.Lock()
	list := make([]*laprfManagedSession, 0, len(m.sessions))
	for _, s := range m.sessions {
		list = append(list, s)
	}
	m.sessions = make(map[uint8]*laprfManagedSession)
	m.mu.Unlock()
	for _, s := range list {
		s.cancel()
		m.engine.SetDetectedTimerOnline(s.target.TimerID, false)
	}
}

func (m *laprfManager) persistTargets() {
	if m.store == nil {
		return
	}
	m.mu.RLock()
	out := make([]SavedLapRFTarget, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, s.target)
	}
	m.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].TimerID < out[j].TimerID })
	_ = m.store.PutJSON(kvLapRFTargetsKey, out)
}

func (m *laprfManager) syncOne(sess *laprfManagedSession) {
	sess.mu.Lock()
	isConn := sess.connected
	sess.mu.Unlock()
	if !isConn {
		return
	}
	specs := m.engine.ActiveLapRFSlotSpecs(sess.target.TimerID)
	var slots [domain.MaxPilotSlots]laprf.SlotRFConfig
	for i := 0; i < domain.MaxPilotSlots; i++ {
		slots[i] = laprf.SlotRFConfig{
			Enabled:      specs[i].Enabled,
			Band:         specs[i].Band,
			Channel:      specs[i].Channel,
			FrequencyMHz: specs[i].FrequencyMHz,
			Threshold:    specs[i].Threshold,
			Gain:         specs[i].Gain,
		}
	}
	rules := m.engine.Rules()
	minLapMs := uint32(math.Round(rules.MinLapSec * 1000.0))
	if minLapMs < 1000 {
		minLapMs = 1000
	}
	sess.client.SyncRFSetup(slots)
	sess.client.SyncSettings(minLapMs, 200)
	sess.client.SetArmed(true)
}

func (m *laprfManager) SyncAll() {
	m.mu.RLock()
	list := make([]*laprfManagedSession, 0, len(m.sessions))
	for _, s := range m.sessions {
		list = append(list, s)
	}
	m.mu.RUnlock()
	for _, s := range list {
		m.syncOne(s)
	}
}

func (m *laprfManager) Connect(req SavedLapRFTarget) (LapRFDiagSnapshot, error) {
	transport := strings.ToLower(strings.TrimSpace(req.Transport))
	if transport == "" {
		if req.PortName != "" {
			transport = "usb"
		} else {
			transport = "ethernet"
		}
	}
	req.Transport = transport

	var endpoint string
	if transport == "usb" {
		req.PortName = strings.TrimSpace(req.PortName)
		if req.PortName == "" {
			return LapRFDiagSnapshot{}, errors.New("missing USB portName for LapRF 8-Way")
		}
		endpoint = req.PortName
	} else {
		req.Host = strings.TrimSpace(req.Host)
		if req.Port <= 0 {
			req.Port = DefaultLapRFPort
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		addr, err := resolveAllowedLapRFAddr(ctx, req.Host, req.Port, true)
		cancel()
		if err != nil {
			return LapRFDiagSnapshot{}, err
		}
		endpoint = addr
	}

	label := strings.TrimSpace(req.Label)
	if label == "" {
		if transport == "usb" {
			label = fmt.Sprintf("LapRF (%s)", req.PortName)
		} else {
			label = fmt.Sprintf("LapRF (%s)", req.Host)
		}
	}
	assignedID := m.engine.EnsureLapRFTimerRegistered(req.TimerID, label, 0, false)
	req.TimerID = assignedID
	req.Label = label

	// Replace any existing session on this timerId
	m.mu.Lock()
	if prev := m.sessions[assignedID]; prev != nil {
		prev.cancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	sess := &laprfManagedSession{
		target:   req,
		endpoint: endpoint,
		cancel:   cancel,
	}
	sess.client = laprf.NewClient(laprf.ClientHooks{
		NowUs: m.engine.NowUs,
		OnStatus: func(ev laprf.ClientStatusEvent) {
			m.engine.IngestExternalLapRFStatus(assignedID, label, ev.VoltageMv, ev.SlotRSSI)
		},
		OnPassing: func(ev laprf.ClientPassingEvent) {
			m.engine.InjectExternalLapRFCrossing(
				assignedID,
				ev.SlotIndex,
				ev.HostTimeUs,
				ev.PeakHeight,
				ev.PassingNumber,
			)
		},
	})
	m.sessions[assignedID] = sess
	m.mu.Unlock()

	m.persistTargets()
	if m.onDirty != nil {
		m.onDirty()
	}

	firstAttemptDone := make(chan error, 1)
	go m.runSessionLoop(ctx, sess, firstAttemptDone)

	select {
	case err := <-firstAttemptDone:
		if err != nil {
			return m.snapshotOne(sess), err
		}
	case <-time.After(3500 * time.Millisecond):
	}
	return m.snapshotOne(sess), nil
}

func (m *laprfManager) runSessionLoop(ctx context.Context, sess *laprfManagedSession, firstDone chan<- error) {
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
		var runErr error
		if sess.target.Transport == "usb" {
			runErr = m.runUSBConnOnce(ctx, sess, reportFirst)
		} else {
			runErr = m.runTCPConnOnce(ctx, sess, reportFirst)
		}
		m.engine.SetDetectedTimerOnline(sess.target.TimerID, false)
		sess.mu.Lock()
		sess.connected = false
		if runErr != nil && ctx.Err() == nil {
			sess.lastErr = runErr.Error()
		}
		sess.mu.Unlock()
		reportFirst(runErr)

		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
			if backoff < 5*time.Second {
				backoff += 1 * time.Second
			}
		}
	}
}

func (m *laprfManager) runTCPConnOnce(ctx context.Context, sess *laprfManagedSession, reportFirst func(error)) error {
	dialCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	var d net.Dialer
	conn, err := d.DialContext(dialCtx, "tcp", sess.endpoint)
	cancel()
	if err != nil {
		return err
	}
	defer conn.Close()
	if tc, ok := conn.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
		_ = tc.SetKeepAlive(true)
		_ = tc.SetKeepAlivePeriod(15 * time.Second)
	}

	go func() {
		<-ctx.Done()
		_ = conn.Close()
	}()

	var writeMu sync.Mutex
	sess.client.SetSend(func(wire []byte) {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(tcpWriteTimeout))
		_, _ = conn.Write(wire)
	})

	sess.mu.Lock()
	sess.connected = true
	sess.lastErr = ""
	sess.mu.Unlock()
	m.engine.SetDetectedTimerOnline(sess.target.TimerID, true)
	m.logf("[LapRF 8-Way] Connected to %s (%s)", sess.endpoint, sess.target.Label)
	reportFirst(nil)

	sess.client.RequestTimeSync()
	m.syncOne(sess)

	buf := make([]byte, 4096)
	for {
		n, rErr := conn.Read(buf)
		if n > 0 {
			sess.client.Feed(buf[:n])
		}
		if rErr != nil {
			return rErr
		}
	}
}

func (m *laprfManager) runUSBConnOnce(ctx context.Context, sess *laprfManagedSession, reportFirst func(error)) error {
	port, err := usb.DefaultSerialOpener(sess.target.PortName, 115200)
	if err != nil {
		return err
	}
	defer port.Close()
	_ = port.SetDTR(true)
	_ = port.SetRTS(true)
	_ = port.SetReadTimeout(200 * time.Millisecond)

	var writeMu sync.Mutex
	sess.client.SetSend(func(wire []byte) {
		writeMu.Lock()
		defer writeMu.Unlock()
		_, _ = port.Write(wire)
	})

	sess.mu.Lock()
	sess.connected = true
	sess.lastErr = ""
	sess.mu.Unlock()
	m.engine.SetDetectedTimerOnline(sess.target.TimerID, true)
	m.logf("[LapRF 8-Way USB] Connected to %s (%s)", sess.target.PortName, sess.target.Label)
	reportFirst(nil)

	sess.client.RequestTimeSync()
	m.syncOne(sess)

	buf := make([]byte, 4096)
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		n, rErr := port.Read(buf)
		if n > 0 {
			sess.client.Feed(buf[:n])
		}
		if rErr != nil {
			if strings.Contains(strings.ToLower(rErr.Error()), "timeout") {
				continue
			}
			return rErr
		}
	}
}

func (m *laprfManager) Disconnect(timerID uint8) {
	m.mu.Lock()
	sess := m.sessions[timerID]
	delete(m.sessions, timerID)
	m.mu.Unlock()
	if sess != nil {
		sess.cancel()
	}
	m.engine.SetDetectedTimerOnline(timerID, false)
	m.persistTargets()
	if m.onDirty != nil {
		m.onDirty()
	}
}

func (m *laprfManager) snapshotOne(sess *laprfManagedSession) LapRFDiagSnapshot {
	st, frx, prx := sess.client.Snapshot()
	specs := m.engine.ActiveLapRFSlotSpecs(sess.target.TimerID)
	var freqs [domain.MaxPilotSlots]uint16
	var thresholds [domain.MaxPilotSlots]float32
	for i := 0; i < domain.MaxPilotSlots; i++ {
		if specs[i].Enabled {
			freqs[i] = specs[i].FrequencyMHz
			thresholds[i] = specs[i].Threshold
		}
	}
	sess.mu.Lock()
	conn := sess.connected
	lastErr := sess.lastErr
	sess.mu.Unlock()
	return LapRFDiagSnapshot{
		TimerID:        sess.target.TimerID,
		Label:          sess.target.Label,
		Transport:      sess.target.Transport,
		Endpoint:       sess.endpoint,
		Connected:      conn,
		VoltageMv:      st.VoltageMv,
		GateArmed:      st.GateArmed,
		RTCSynced:      st.RTCSynced,
		RTCOffsetMs:    math.Round(float64(st.RTCOffsetUs)/100.0) / 10.0,
		FramesRx:       frx,
		PassingsRx:     prx,
		SlotRSSI:       st.SlotRSSI,
		SlotFreqsMHz:   freqs,
		SlotThresholds: thresholds,
		LastError:      lastErr,
	}
}

func (m *laprfManager) Snapshots() []LapRFDiagSnapshot {
	m.mu.RLock()
	out := make([]LapRFDiagSnapshot, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, m.snapshotOne(s))
	}
	m.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].TimerID < out[j].TimerID })
	return out
}

// --- HTTP Handlers ---

func (s *Server) handleLapRFStatus(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var saved []SavedLapRFTarget
	if s.store != nil {
		_, _ = s.store.GetJSON(kvLapRFTargetsKey, &saved)
	}
	if saved == nil {
		saved = []SavedLapRFTarget{}
	}
	writeJSONNoStore(w, http.StatusOK, map[string]any{
		"sessions":     s.laprfMgr.Snapshots(),
		"savedTargets": saved,
	})
}

func (s *Server) handleLapRFConnect(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req SavedLapRFTarget
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON body"})
		return
	}
	snap, err := s.laprfMgr.Connect(req)
	if err != nil {
		writeJSONNoStore(w, http.StatusBadGateway, map[string]any{
			"error":   err.Error(),
			"session": snap,
		})
		return
	}
	writeJSONNoStore(w, http.StatusOK, map[string]any{"session": snap})
}

func (s *Server) handleLapRFDisconnect(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		TimerID uint8 `json:"timerId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.TimerID == 0 {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "missing timerId"})
		return
	}
	s.laprfMgr.Disconnect(req.TimerID)
	writeJSONNoStore(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleLapRFSync(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.laprfMgr.SyncAll()
	writeJSONNoStore(w, http.StatusOK, map[string]any{"ok": true})
}
