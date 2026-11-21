package portable

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"slaprf/internal/laprf"
	"slaprf/internal/storage"
)

const kvLapRFEmulatorConfigKey = "hw.laprf_emulator_config"

// LapRFEmulatorConfig persists the native Go TCP :5403 LapRF server emulator settings in `BoltStore`.
type LapRFEmulatorConfig struct {
	Enabled bool   `json:"enabled"`
	Port    int    `json:"port"`
	Bind    string `json:"bind,omitempty"` // "" (all interfaces) | "loopback"
}

// LapRFEmulatorSnapshot matches `LapRFEmulatorSnapshot` in `web/src/services/laprf_emulator_relay.ts`.
type LapRFEmulatorSnapshot struct {
	Enabled      bool   `json:"enabled"`
	Suppressed   bool   `json:"suppressed"`
	RelayState   string `json:"relayState"`   // "off" | "connected" | "unreachable"
	ClientState  string `json:"clientState"`  // "waiting" | "connected"
	Peer         string `json:"peer"`
	ListenAddr   string `json:"listenAddr"`
	RelayVersion string `json:"relayVersion"`
	BytesIn      uint64 `json:"bytesIn"`
	BytesOut     uint64 `json:"bytesOut"`
	LastError    string `json:"lastError"`
}

type meteredConn struct {
	net.Conn
	in  *atomic.Uint64
	out *atomic.Uint64
}

func (c *meteredConn) Read(b []byte) (int, error) {
	n, err := c.Conn.Read(b)
	if n > 0 {
		c.in.Add(uint64(n))
	}
	return n, err
}

func (c *meteredConn) Write(b []byte) (int, error) {
	n, err := c.Conn.Write(b)
	if n > 0 {
		c.out.Add(uint64(n))
	}
	return n, err
}

type laprfEmulatorManager struct {
	version      string
	laprfSrv     *laprf.Server
	store        *storage.BoltStore
	isSuppressed func() bool
	logf         func(string, ...any)

	mu         sync.Mutex
	cfg        LapRFEmulatorConfig
	ln         net.Listener
	listenPort int
	listenAddr string
	cancel     context.CancelFunc
	activeConn net.Conn
	peer       string
	lastErr    string
	bytesIn    atomic.Uint64
	bytesOut   atomic.Uint64
}

func newLapRFEmulatorManager(version string, laprfSrv *laprf.Server, store *storage.BoltStore, isSuppressed func() bool, logf func(string, ...any)) *laprfEmulatorManager {
	m := &laprfEmulatorManager{
		version:      version,
		laprfSrv:     laprfSrv,
		store:        store,
		isSuppressed: isSuppressed,
		logf:         logf,
		cfg: LapRFEmulatorConfig{
			Enabled: false,
			Port:    DefaultLapRFPort,
		},
	}
	if store != nil {
		var saved LapRFEmulatorConfig
		if ok, err := store.GetJSON(kvLapRFEmulatorConfigKey, &saved); err == nil && ok {
			if saved.Port <= 0 {
				saved.Port = DefaultLapRFPort
			}
			m.cfg = saved
		}
	}
	return m
}

func (m *laprfEmulatorManager) Reconcile() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.reconcileLocked()
}

func (m *laprfEmulatorManager) SetConfig(cfg LapRFEmulatorConfig) LapRFEmulatorSnapshot {
	if cfg.Port < 0 || cfg.Port > 65535 {
		cfg.Port = DefaultLapRFPort
	}
	m.mu.Lock()
	portChanged := m.cfg.Port != cfg.Port || m.cfg.Bind != cfg.Bind
	m.cfg = cfg
	if m.store != nil {
		_ = m.store.PutJSON(kvLapRFEmulatorConfigKey, cfg)
	}
	if portChanged && m.ln != nil {
		m.stopListenerLocked()
	}
	m.reconcileLocked()
	snap := m.snapshotLocked()
	m.mu.Unlock()
	return snap
}

func (m *laprfEmulatorManager) listeningPort() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.ln != nil {
		return m.listenPort
	}
	return 0
}

func (m *laprfEmulatorManager) close() {
	m.mu.Lock()
	m.stopListenerLocked()
	m.mu.Unlock()
}

func (m *laprfEmulatorManager) stopListenerLocked() {
	if m.cancel != nil {
		m.cancel()
		m.cancel = nil
	}
	if m.ln != nil {
		_ = m.ln.Close()
		m.ln = nil
	}
	if m.activeConn != nil {
		_ = m.activeConn.Close()
		m.activeConn = nil
	}
	m.peer = ""
	m.listenPort = 0
	m.listenAddr = ""
}

func (m *laprfEmulatorManager) reconcileLocked() {
	suppressed := m.isSuppressed != nil && m.isSuppressed()
	shouldListen := m.cfg.Enabled && !suppressed
	if !shouldListen {
		m.stopListenerLocked()
		if !m.cfg.Enabled {
			m.lastErr = ""
		}
		return
	}
	if m.ln != nil {
		return
	}

	host := ""
	if m.cfg.Bind == "loopback" {
		host = "127.0.0.1"
	}
	port := m.cfg.Port
	if port < 0 {
		port = DefaultLapRFPort
	}
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		m.lastErr = fmt.Sprintf("Cannot listen on TCP %s: %v", addr, err)
		return
	}
	actualPort := port
	if ta, ok := ln.Addr().(*net.TCPAddr); ok {
		actualPort = ta.Port
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.ln = ln
	m.listenPort = actualPort
	m.listenAddr = ln.Addr().String()
	m.cancel = cancel
	m.lastErr = ""
	m.logf("[LapRF Emulator] Native Go TCP listener bound on %s", m.listenAddr)

	go m.acceptLoop(ctx, ln)
}

func (m *laprfEmulatorManager) acceptLoop(ctx context.Context, ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		if tc, ok := conn.(*net.TCPConn); ok {
			_ = tc.SetNoDelay(true)
			_ = tc.SetKeepAlive(true)
			_ = tc.SetKeepAlivePeriod(30 * time.Second)
		}
		peer := conn.RemoteAddr().String()
		m.mu.Lock()
		if m.activeConn != nil {
			_ = m.activeConn.Close()
		}
		m.activeConn = conn
		m.peer = peer
		m.mu.Unlock()

		mc := &meteredConn{
			Conn: conn,
			in:   &m.bytesIn,
			out:  &m.bytesOut,
		}
		go func(c net.Conn, p string) {
			m.laprfSrv.ServeConn(c)
			m.mu.Lock()
			if m.activeConn == conn {
				m.activeConn = nil
				m.peer = ""
			}
			m.mu.Unlock()
		}(mc, peer)
	}
}

func (m *laprfEmulatorManager) Snapshot() LapRFEmulatorSnapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.snapshotLocked()
}

func (m *laprfEmulatorManager) snapshotLocked() LapRFEmulatorSnapshot {
	suppressed := m.isSuppressed != nil && m.isSuppressed()
	relayState := "off"
	if m.cfg.Enabled && !suppressed {
		if m.ln != nil {
			relayState = "connected"
		} else {
			relayState = "unreachable"
		}
	}
	clientState := "waiting"
	if m.activeConn != nil && m.peer != "" {
		clientState = "connected"
	}
	return LapRFEmulatorSnapshot{
		Enabled:      m.cfg.Enabled,
		Suppressed:   suppressed,
		RelayState:   relayState,
		ClientState:  clientState,
		Peer:         m.peer,
		ListenAddr:   m.listenAddr,
		RelayVersion: m.version,
		BytesIn:      m.bytesIn.Load(),
		BytesOut:     m.bytesOut.Load(),
		LastError:    m.lastErr,
	}
}

// --- HTTP Handlers ---

func (s *Server) handleLapRFEmulatorStatus(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.laprfEmulatorMgr.Reconcile()
	writeJSONNoStore(w, http.StatusOK, s.laprfEmulatorMgr.Snapshot())
}

func (s *Server) handleLapRFEmulatorConfig(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPut && r.Method != http.MethodPatch {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Enabled *bool   `json:"enabled"`
		Port    *int    `json:"port"`
		Bind    *string `json:"bind"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON body"})
		return
	}
	s.laprfEmulatorMgr.mu.Lock()
	next := s.laprfEmulatorMgr.cfg
	s.laprfEmulatorMgr.mu.Unlock()
	if req.Enabled != nil {
		next.Enabled = *req.Enabled
	}
	if req.Port != nil {
		next.Port = *req.Port
	}
	if req.Bind != nil {
		next.Bind = *req.Bind
	}
	snap := s.laprfEmulatorMgr.SetConfig(next)
	writeJSONNoStore(w, http.StatusOK, snap)
}
