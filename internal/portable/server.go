package portable

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"slaprf/internal/api"
	"slaprf/internal/domain"
	"slaprf/internal/firmware"
	"slaprf/internal/ingest"
	"slaprf/internal/laprf"
	"slaprf/internal/rotorhazard"
	"slaprf/internal/storage"
	"slaprf/internal/tracker"
	"slaprf/internal/usb"
)

const (
	DefaultMultiGPBaseURL  = "https://www.multigp.com/mgp/multigpwebservice"
	DefaultLapRFPort       = 5403
	DefaultRotorHazardPort = 5000

	wsWriteTimeout  = 5 * time.Second
	tcpWriteTimeout = 5 * time.Second
	wsPingInterval  = 20 * time.Second
	wsReadLimit     = 1 << 20
)

// CapabilitiesResponse is returned by GET /api/capabilities on a native SlapRF Go backend.
type CapabilitiesResponse struct {
	Portable            bool     `json:"portable"`
	Version             string   `json:"version"`
	Hostname            string   `json:"hostname"`
	StorageBackend      string   `json:"storageBackend"` // "bbolt"
	NativeEngine        bool     `json:"nativeEngine"`
	NativeUSB           bool     `json:"nativeUsb"`
	LanIPs              []string `json:"lanIPs"`
	LaprfEmulator       bool     `json:"laprfEmulator"`
	LaprfClient         bool     `json:"laprfClient"`
	RotorHazardDiscover bool     `json:"rotorhazardDiscover"`
	MultigpProxy        bool     `json:"multigpProxy"`
	AuthRequired        bool     `json:"authRequired"`
	Authenticated       bool     `json:"authenticated"`
}

// DiscoveredLapRFDevice describes a LAN host listening on the LapRF TCP port.
type DiscoveredLapRFDevice struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Verified bool   `json:"verified"`
}

// DiscoveredRotorHazardDevice describes a LAN host responding with an Engine.IO handshake on the RotorHazard port.
type DiscoveredRotorHazardDevice struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Verified bool   `json:"verified"`
}

// Config configures a native SlapRF Go backend HTTP + WebSocket server instance.
type Config struct {
	Version         string
	StaticFS        fs.FS  // Optional embedded WASM-free SPA filesystem
	DBPath          string // Path to single-file bbolt DB; if empty, an isolated temp DB is used (cleaned on Close)
	BaseFirmware    []byte // Embedded ESP32-C5 firmware binary for native Go USB flashing
	AllowedOrigins  []string
	AllowLANOrigins bool
	MultiGPBaseURL  string // Defaults to DefaultMultiGPBaseURL
	HTTPClient      *http.Client
	Log             *log.Logger
	USBOpenPort     firmware.SerialOpener
	USBListPorts    usb.PortLister
	DisableAuth     bool // When true (-no-auth), clears persisted Basic Auth on startup
}

// Server owns the complete native Go timing engines (`realEngine` + `simEngine`), `TrackSimulator`,
// single-file `bbolt` storage (`slaprf.db`), native USB serial + ESP32-C5 flasher, native LapRF 8-Way
// & RotorHazard hardware links, LiveTime :5403 TCP server, MultiGP proxy, and WebSocket event stream.
type Server struct {
	cfg          Config
	httpClient   *http.Client
	hostname     string
	tempDBPath   string
	store        *storage.BoltStore
	persistWorker *storage.PersistenceWorker

	simEngine  *tracker.Engine
	realEngine *tracker.Engine
	sim        *ingest.TrackSimulator
	realHubRx  *ingest.HubFrameDecoder
	simHubRx   *ingest.HubFrameDecoder
	laprfSrv   *laprf.Server
	apiSrv     *api.Server
	stream     *streamHub

	usbMgr      *usb.Manager
	laprfMgr    *laprfManager
	rhMgr       *rhManager
	liveTimeMgr *liveTimeManager

	simHubUSBConnected atomic.Bool
	simHubSubMu        sync.RWMutex
	simHubSubNextID    int
	simHubSubs         map[int]func([]byte)

	authMu  sync.RWMutex
	authCfg AuthConfig

	stopCh   chan struct{}
	stopOnce sync.Once
}

// NewServer constructs and boots a complete native SlapRF Go backend server.
func NewServer(cfg Config) *Server {
	if cfg.Version == "" {
		cfg.Version = "dev"
	}
	if cfg.MultiGPBaseURL == "" {
		cfg.MultiGPBaseURL = DefaultMultiGPBaseURL
	}
	cfg.MultiGPBaseURL = strings.TrimRight(cfg.MultiGPBaseURL, "/")
	hc := cfg.HTTPClient
	if hc == nil {
		hc = &http.Client{Timeout: 15 * time.Second}
	}
	hostName, _ := os.Hostname()
	if hostName == "" {
		hostName = "slaprf-server"
	}

	var tempDB string
	dbPath := strings.TrimSpace(cfg.DBPath)
	if dbPath == "" {
		if f, err := os.CreateTemp("", "slaprf-portable-*.db"); err == nil {
			tempDB = f.Name()
			_ = f.Close()
			dbPath = tempDB
		} else {
			dbPath = storage.ResolveDefaultDBPath()
		}
	}

	store, err := storage.OpenBoltStore(dbPath)
	if err != nil && cfg.Log != nil {
		cfg.Log.Printf("[Storage] Warning: failed to open %s: %v", dbPath, err)
	}

	simEngine := tracker.NewEngine()
	realEngine := tracker.NewRealEngine()
	sim := ingest.NewTrackSimulator(simEngine)
	realHubRx := ingest.NewHubFrameDecoder(realEngine)
	simHubRx := ingest.NewHubFrameDecoder(simEngine)

	s := &Server{
		cfg:        cfg,
		httpClient: hc,
		hostname:   hostName,
		tempDBPath: tempDB,
		store:      store,
		simEngine:  simEngine,
		realEngine: realEngine,
		sim:        sim,
		realHubRx:  realHubRx,
		simHubRx:   simHubRx,
		simHubSubs: make(map[int]func([]byte)),
		stopCh:     make(chan struct{}),
	}
	var initialSimHubUSB bool
	if store != nil {
		_, _ = store.GetJSON("sim.hub_usb_connected", &initialSimHubUSB)
	}
	s.simHubUSBConnected.Store(initialSimHubUSB)
	s.loadPersistedAuthConfig()
	if cfg.DisableAuth {
		s.resetAuthConfig()
	}

	// Wire simulated Hub H1 virtual USB frame sink directly to native Go `simHubRx` (plus any open UI console tabs)
	sim.SetHubFrameSink(func(raw []byte) {
		if len(raw) == 0 {
			return
		}
		if s.simHubUSBConnected.Load() {
			s.ingestRawHubStream(simHubRx, simEngine, raw)
		}
		s.simHubSubMu.RLock()
		subs := make([]func([]byte), 0, len(s.simHubSubs))
		for _, fn := range s.simHubSubs {
			subs = append(subs, fn)
		}
		s.simHubSubMu.RUnlock()
		for _, fn := range subs {
			fn(raw)
		}
	})

	sim.SetSlapRFModeSyncHook(func() {
		simHubRx.Reset()
		if s.simHubUSBConnected.Load() && sim.IsRunning() {
			s.ingestRawHubStream(simHubRx, simEngine, sim.BuildHubHelloStream())
		} else {
			simEngine.SetAllTimersOffline()
		}
	})

	var initialSimMode bool
	if store != nil {
		s.persistWorker = storage.NewPersistenceWorker(store, simEngine, realEngine, sim, cfg.Log)
		initialSimMode = s.persistWorker.Hydrate()
		s.persistWorker.Start()
	}
	if simEngine.TimingHardwareMode() == domain.HardwareModeSlapRF {
		simEngine.SetAllTimersOffline()
	} else {
		sim.SyncHardwareMode()
	}
	tracker.SyncBootTimes(simEngine, realEngine)
	sim.SetRunning(initialSimMode)
	sim.Start()
	if initialSimMode && simEngine.TimingHardwareMode() == domain.HardwareModeSlapRF && s.simHubUSBConnected.Load() {
		simHubRx.Reset()
		s.ingestRawHubStream(simHubRx, simEngine, sim.BuildHubHelloStream())
	}

	laprfSrv := laprf.NewServer(simEngine)
	apiSrv := api.NewServer(simEngine, sim, laprfSrv, realEngine)
	s.laprfSrv = laprfSrv
	s.apiSrv = apiSrv

	s.stream = newStreamHub(simEngine, realEngine, sim.IsRunning)

	baseFW := cfg.BaseFirmware
	if len(baseFW) == 0 {
		baseFW = firmware.SyntheticBase()
	}
	s.usbMgr = usb.NewManager(usb.ManagerConfig{
		Engine:       realEngine,
		HubRx:        realHubRx,
		Store:        store,
		BaseFirmware: baseFW,
		OpenPort:     cfg.USBOpenPort,
		ListPorts:    cfg.USBListPorts,
		Logf:         s.logf,
	})
	markDirty := func() {
		if s.persistWorker != nil {
			s.persistWorker.MarkDirty()
		}
	}
	s.laprfMgr = newLapRFManager(realEngine, store, s.logf, markDirty)
	s.rhMgr = newRHManager(realEngine, store, cfg.USBOpenPort, s.logf, markDirty)
	s.liveTimeMgr = newLiveTimeManager(cfg.Version, laprfSrv, store, func() bool {
		return !sim.IsRunning() && realEngine.TimingHardwareMode() == domain.HardwareModeLapRF
	}, s.logf)

	reconcileRealHardwareLinks := func(simRunning bool) {
		realMode := realEngine.TimingHardwareMode()
		s.usbMgr.SetSimMode(simRunning || realMode != domain.HardwareModeSlapRF)
		s.laprfMgr.SetSimMode(simRunning || realMode != domain.HardwareModeLapRF)
		s.rhMgr.Reconcile(simRunning)
		s.liveTimeMgr.Reconcile()
	}

	apiSrv.SetHooks(api.ServerHooks{
		OnMutation: func() {
			if s.persistWorker != nil {
				s.persistWorker.MarkDirty()
			}
			reconcileRealHardwareLinks(sim.IsRunning())
		},
		OnModeChanged: func(simRunning bool) {
			if s.persistWorker != nil {
				s.persistWorker.SaveMode(simRunning)
			}
			if simRunning && s.simHubUSBConnected.Load() {
				s.ingestRawHubStream(simHubRx, simEngine, sim.BuildHubHelloStream())
			}
			reconcileRealHardwareLinks(simRunning)
		},
		OnStorageReset: func() {
			s.resetAuthConfig()
			if s.persistWorker != nil {
				s.persistWorker.WipeAndReconcile()
			}
			reconcileRealHardwareLinks(sim.IsRunning())
		},
		OnStorageImport: func() {
			if s.persistWorker != nil {
				s.persistWorker.ReconcileAllNow()
			}
			reconcileRealHardwareLinks(sim.IsRunning())
		},
	})

	// Restore persisted hardware links & LiveTime listener
	s.usbMgr.RestorePersistedConnections(initialSimMode || realEngine.TimingHardwareMode() != domain.HardwareModeSlapRF)
	s.laprfMgr.RestorePersistedTargets(initialSimMode || realEngine.TimingHardwareMode() != domain.HardwareModeLapRF)
	s.rhMgr.RestorePersistedTargets(initialSimMode)
	s.liveTimeMgr.Reconcile()

	// Background 100 ms race/heat clock ticker so countdowns, timed heats, and Open Qualifier clocks
	// advance continuously on the Go server even when all browser tabs are closed.
	go func() {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-s.stopCh:
				return
			case <-ticker.C:
				if sim.IsRunning() {
					simEngine.TickRaceClock()
				} else {
					realEngine.TickRaceClock()
				}
			}
		}
	}()

	return s
}

func (s *Server) ingestRawHubStream(rx *ingest.HubFrameDecoder, eng *tracker.Engine, raw []byte) {
	nowUs := eng.NowUs()
	pos := 0
	for pos+2 <= len(raw) {
		if raw[pos] != 0x1E {
			pos++
			continue
		}
		pktLen := int(raw[pos+1])
		if pos+2+pktLen > len(raw) {
			break
		}
		rx.IngestPacket(raw[pos+2:pos+2+pktLen], nowUs)
		pos += 2 + pktLen
	}
}

func (s *Server) setSimHubUSBConnected(connected bool) {
	s.simHubUSBConnected.Store(connected)
	if s.store != nil {
		_ = s.store.PutJSON("sim.hub_usb_connected", connected)
	}
	if !connected {
		if s.simEngine.TimingHardwareMode() == domain.HardwareModeSlapRF {
			s.simEngine.SetAllTimersOffline()
		}
		return
	}
	if s.sim.IsRunning() && s.simEngine.TimingHardwareMode() == domain.HardwareModeSlapRF {
		s.simHubRx.Reset()
		s.ingestRawHubStream(s.simHubRx, s.simEngine, s.sim.BuildHubHelloStream())
	}
}

func (s *Server) subscribeSimHubBytes(fn func([]byte)) func() {
	s.simHubSubMu.Lock()
	s.simHubSubNextID++
	id := s.simHubSubNextID
	s.simHubSubs[id] = fn
	s.simHubSubMu.Unlock()
	return func() {
		s.simHubSubMu.Lock()
		delete(s.simHubSubs, id)
		s.simHubSubMu.Unlock()
	}
}

func (s *Server) logf(format string, args ...any) {
	if s.cfg.Log != nil {
		s.cfg.Log.Printf(format, args...)
	}
}

// DBPath returns the active `bbolt` database file path.
func (s *Server) DBPath() string {
	if s.store != nil {
		return s.store.Path()
	}
	return s.cfg.DBPath
}

// Close flushes pending `bbolt` writes and shuts down all background goroutines and hardware links.
func (s *Server) Close() {
	s.stopOnce.Do(func() {
		close(s.stopCh)
	})
	// Flush persisted state (including active simulatorRunning mode) BEFORE stopping simulator/engines.
	if s.persistWorker != nil {
		s.persistWorker.Stop()
	}
	if s.sim != nil {
		s.sim.SetRunning(false)
	}
	if s.liveTimeMgr != nil {
		s.liveTimeMgr.close()
	}
	if s.laprfMgr != nil {
		s.laprfMgr.close()
	}
	if s.rhMgr != nil {
		s.rhMgr.close()
	}
	if s.usbMgr != nil {
		s.usbMgr.Close()
	}
	if s.stream != nil {
		s.stream.close()
	}
	if s.store != nil {
		_ = s.store.Close()
	}
	if s.tempDBPath != "" {
		_ = os.Remove(s.tempDBPath)
	}
}

// RegisterAPIRoutes attaches all native Go `/api/*` endpoints onto mux.
func (s *Server) RegisterAPIRoutes(mux *http.ServeMux) {
	// Core engine, simulator, race, practice, pilot, gate, and backup routes
	s.apiSrv.RegisterRoutes(mux)

	// Server capabilities, authentication & bbolt storage status
	mux.HandleFunc("/api/capabilities", s.handleCapabilities)
	mux.HandleFunc("/api/auth/login", s.handleAuthLogin)
	mux.HandleFunc("/api/auth/config", s.handleAuthConfig)
	mux.HandleFunc("/api/storage/status", s.handleStorageStatus)
	mux.HandleFunc("/api/storage/backup-recorded", s.handleStorageBackupRecorded)

	// Real-time event + binary telemetry WebSocket stream
	mux.HandleFunc("/api/ws/stream", s.handleStreamWS)

	// Native Go USB serial & ESP32-C5 ROM bootloader flasher
	mux.HandleFunc("/api/usb/ports", s.handleUSBPorts)
	mux.HandleFunc("/api/usb/status", s.handleUSBStatus)
	mux.HandleFunc("/api/usb/connect", s.handleUSBConnect)
	mux.HandleFunc("/api/usb/disconnect", s.handleUSBDisconnect)
	mux.HandleFunc("/api/usb/debug-slot", s.handleUSBDebugSlot)
	mux.HandleFunc("/api/usb/command", s.handleUSBCommand)
	mux.HandleFunc("/api/usb/flash", s.handleUSBFlash)
	mux.HandleFunc("/api/usb/erase", s.handleUSBErase)
	mux.HandleFunc("/api/usb/known-forget", s.handleUSBKnownForget)
	mux.HandleFunc("/api/sim/hub-usb", s.handleSimHubUSB)
	mux.HandleFunc("/api/ws/usb", s.handleUSBWS)

	// Native Go LapRF 8-Way hardware client & LAN discovery
	mux.HandleFunc("/api/laprf/status", s.handleLapRFStatus)
	mux.HandleFunc("/api/laprf/connect", s.handleLapRFConnect)
	mux.HandleFunc("/api/laprf/disconnect", s.handleLapRFDisconnect)
	mux.HandleFunc("/api/laprf/sync", s.handleLapRFSync)
	mux.HandleFunc("/api/laprf-discover", s.handleLapRFDiscover)

	// Native Go RotorHazard hardware client & LAN discovery
	mux.HandleFunc("/api/rh/status", s.handleRHStatus)
	mux.HandleFunc("/api/rh/connect", s.handleRHConnect)
	mux.HandleFunc("/api/rh/disconnect", s.handleRHDisconnect)
	mux.HandleFunc("/api/rh/sync", s.handleRHSync)
	mux.HandleFunc("/api/rh-discover", s.handleRotorHazardDiscover)

	// Native Go LiveTime :5403 TCP emulator
	mux.HandleFunc("/api/livetime/status", s.handleLiveTimeStatus)
	mux.HandleFunc("/api/livetime/config", s.handleLiveTimeConfig)

	// Official MultiGP WebService proxy
	mux.HandleFunc("/api/mgp/", s.handleMultiGPProxy)
}

// Handler returns a complete http.Handler with CORS/Private-Network-Access support, `/api/*`, and embedded SPA.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	s.RegisterAPIRoutes(mux)

	if s.cfg.StaticFS != nil {
		fileServer := http.FileServer(http.FS(s.cfg.StaticFS))
		mux.HandleFunc("/sw.js", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = io.WriteString(w, "// SlapRF Portable: service worker disabled (assets served locally from binary)\nself.addEventListener('install', () => self.skipWaiting());\nself.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));\n")
		})
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-cache")
			cleanPath := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
			if cleanPath == "" {
				cleanPath = "index.html"
			}
			// Native Go Server Mode never serves WASM to the browser.
			if cleanPath == "wasm" || strings.HasPrefix(cleanPath, "wasm/") {
				http.NotFound(w, r)
				return
			}
			if _, err := fs.Stat(s.cfg.StaticFS, cleanPath); err != nil {
				if !strings.Contains(path.Base(cleanPath), ".") {
					if indexBytes, readErr := fs.ReadFile(s.cfg.StaticFS, "index.html"); readErr == nil {
						w.Header().Set("Content-Type", "text/html; charset=utf-8")
						_, _ = w.Write(indexBytes)
						return
					}
				}
			}
			fileServer.ServeHTTP(w, r)
		})
	}
	return s.withCORSAndPNA(mux)
}

// NewStaticBrowserHandler returns a pure static HTTP handler that mimics https://slaprf.app
// (Standalone Browser Demo Mode: serves index.html, dist/app.js, wasm/slaprf.wasm, wasm/wasm_exec.js,
// styles, icons, and sounds with zero Go `/api/*` backend routes and zero `slaprf.db`).
func NewStaticBrowserHandler(siteFS fs.FS) http.Handler {
	mux := http.NewServeMux()
	if siteFS == nil {
		return mux
	}
	fileServer := http.FileServer(http.FS(siteFS))
	mux.HandleFunc("/api", http.NotFound)
	mux.HandleFunc("/api/", http.NotFound)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		cleanPath := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if cleanPath == "" {
			cleanPath = "index.html"
		}
		if strings.HasSuffix(strings.ToLower(cleanPath), ".wasm") {
			w.Header().Set("Content-Type", "application/wasm")
		}
		if _, err := fs.Stat(siteFS, cleanPath); err != nil {
			if !strings.Contains(path.Base(cleanPath), ".") {
				if indexBytes, readErr := fs.ReadFile(siteFS, "index.html"); readErr == nil {
					w.Header().Set("Content-Type", "text/html; charset=utf-8")
					_, _ = w.Write(indexBytes)
					return
				}
			}
		}
		fileServer.ServeHTTP(w, r)
	})
	return mux
}

func isLoopbackHost(h string) bool {
	h = strings.ToLower(strings.Trim(h, "[]"))
	return h == "127.0.0.1" || h == "localhost" || h == "::1"
}

func (s *Server) handleCapabilities(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	resp := CapabilitiesResponse{
		Portable:            true,
		Version:             s.cfg.Version,
		Hostname:            s.hostname,
		StorageBackend:      "bbolt",
		NativeEngine:        true,
		NativeUSB:           true,
		LanIPs:              LanIPs(),
		LaprfEmulator:       true,
		LaprfClient:         true,
		RotorHazardDiscover: true,
		MultigpProxy:        true,
		AuthRequired:        s.isAuthEnabled(),
		Authenticated:       s.isRequestAuthenticated(r),
	}
	writeJSONNoStore(w, http.StatusOK, resp)
}

func (s *Server) handleStorageStatus(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.store == nil {
		writeJSONNoStore(w, http.StatusOK, storage.Status{Backend: "memory"})
		return
	}
	writeJSONNoStore(w, http.StatusOK, s.store.Status())
}

func (s *Server) handleStorageBackupRecorded(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.store == nil {
		writeJSONNoStore(w, http.StatusOK, storage.Status{Backend: "memory"})
		return
	}
	_ = s.store.RecordBackupTimestamp(time.Now().UnixMilli())
	writeJSONNoStore(w, http.StatusOK, s.store.Status())
}

// --- MultiGP Reverse Proxy (/api/mgp/*) ---

func isSafeMultiGPPath(sub string) bool {
	if sub == "" || strings.Contains(sub, "..") || strings.HasPrefix(sub, "/") {
		return false
	}
	for i := 0; i < len(sub); i++ {
		c := sub[i]
		valid := (c >= 'a' && c <= 'z') ||
			(c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') ||
			c == '/' || c == '_' || c == '-'
		if !valid {
			return false
		}
	}
	return true
}

func (s *Server) handleMultiGPProxy(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost && r.Method != http.MethodPut {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	sub := strings.TrimPrefix(r.URL.Path, "/api/mgp/")
	sub = strings.Trim(sub, "/")
	if !isSafeMultiGPPath(sub) {
		http.Error(w, "invalid MultiGP endpoint path", http.StatusBadRequest)
		return
	}

	targetURL := s.cfg.MultiGPBaseURL + "/" + sub
	if r.URL.RawQuery != "" {
		targetURL += "?" + r.URL.RawQuery
	}

	bodyBytes, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	if err != nil {
		http.Error(w, "failed to read request body", http.StatusBadRequest)
		return
	}

	upReq, err := http.NewRequestWithContext(r.Context(), r.Method, targetURL, bytes.NewReader(bodyBytes))
	if err != nil {
		http.Error(w, "failed to build upstream request", http.StatusInternalServerError)
		return
	}
	upReq.Header.Set("Content-Type", "application/json")
	upReq.Header.Set("Accept", "application/json")
	upReq.Header.Set("User-Agent", "SlapRF/"+s.cfg.Version)

	resp, err := s.httpClient.Do(upReq)
	if err != nil {
		writeJSONNoStore(w, http.StatusBadGateway, map[string]any{
			"status":            false,
			"statusDescription": fmt.Sprintf("MultiGP upstream request failed: %v", err),
		})
		return
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/json; charset=utf-8"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(respBytes)
}

// --- LAN Target Validation & Discovery (/api/laprf-discover & /api/rh-discover) ---

func isAllowedLapRFTargetIP(ip net.IP, allowLoopback bool) bool {
	if ip == nil || ip.IsUnspecified() || ip.IsMulticast() {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		if v4[0] == 169 && v4[1] == 254 && v4[2] == 169 && v4[3] == 254 {
			return false
		}
	}
	if ip.IsLoopback() {
		return allowLoopback
	}
	return ip.IsPrivate() || ip.IsLinkLocalUnicast()
}

func resolveAllowedLapRFAddr(ctx context.Context, host string, port int, allowLoopback bool) (string, error) {
	host = strings.TrimSpace(host)
	if host == "" {
		return "", errors.New("missing target host")
	}
	if port < 1 || port > 65535 {
		return "", fmt.Errorf("invalid TCP port %d", port)
	}
	if ip := net.ParseIP(host); ip != nil {
		if !isAllowedLapRFTargetIP(ip, allowLoopback) {
			return "", fmt.Errorf("target IP %s is not a private LAN or link-local address", ip)
		}
		return net.JoinHostPort(ip.String(), strconv.Itoa(port)), nil
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(ips) == 0 {
		return "", fmt.Errorf("cannot resolve host %q", host)
	}
	for _, ipa := range ips {
		if isAllowedLapRFTargetIP(ipa.IP, allowLoopback) {
			return net.JoinHostPort(ipa.IP.String(), strconv.Itoa(port)), nil
		}
	}
	return "", fmt.Errorf("host %q did not resolve to a local LAN address", host)
}

func (s *Server) handleLapRFDiscover(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	port := DefaultLapRFPort
	if pStr := r.URL.Query().Get("port"); pStr != "" {
		if p, err := strconv.Atoi(pStr); err == nil && p >= 1 && p <= 65535 {
			port = p
		}
	}

	var candidates []string
	if explicitHosts := strings.TrimSpace(r.URL.Query().Get("hosts")); explicitHosts != "" {
		for _, raw := range strings.Split(explicitHosts, ",") {
			raw = strings.TrimSpace(raw)
			if ip := net.ParseIP(raw); ip != nil && isAllowedLapRFTargetIP(ip, true) {
				candidates = append(candidates, ip.String())
			}
		}
	} else if subnet := strings.TrimSpace(r.URL.Query().Get("subnet")); subnet != "" {
		parts := strings.Split(subnet, ".")
		if len(parts) == 3 {
			for hostOctet := 1; hostOctet <= 254; hostOctet++ {
				ipStr := fmt.Sprintf("%s.%d", subnet, hostOctet)
				if ip := net.ParseIP(ipStr); ip != nil && isAllowedLapRFTargetIP(ip, false) {
					candidates = append(candidates, ipStr)
				}
			}
		}
	} else {
		selfIPs := make(map[string]bool)
		emulPort := s.liveTimeMgr.listeningPort()
		for _, ipStr := range LanIPs() {
			if emulPort == port {
				selfIPs[ipStr] = true
			}
		}
		seenPrefix := make(map[string]bool)
		for _, ipStr := range LanIPs() {
			ip := net.ParseIP(ipStr).To4()
			if ip == nil || !ip.IsPrivate() {
				continue
			}
			prefix := fmt.Sprintf("%d.%d.%d", ip[0], ip[1], ip[2])
			if seenPrefix[prefix] || len(seenPrefix) >= 2 {
				continue
			}
			seenPrefix[prefix] = true
			for hostOctet := 1; hostOctet <= 254; hostOctet++ {
				cand := fmt.Sprintf("%s.%d", prefix, hostOctet)
				if !selfIPs[cand] {
					candidates = append(candidates, cand)
				}
			}
		}
	}

	found := ProbeLapRFHosts(r.Context(), candidates, port, 180*time.Millisecond)
	writeJSONNoStore(w, http.StatusOK, map[string]any{
		"devices": found,
	})
}

// ProbeLapRFHosts probes candidate hosts in parallel on port and verifies whether they emit a valid
// 0x5A...0x5B LapRF frame when queried with a RecordTime (0xDA0C) request.
func ProbeLapRFHosts(ctx context.Context, hosts []string, port int, dialTimeout time.Duration) []DiscoveredLapRFDevice {
	if len(hosts) == 0 {
		return []DiscoveredLapRFDevice{}
	}
	sem := make(chan struct{}, 64)
	var mu sync.Mutex
	out := make([]DiscoveredLapRFDevice, 0)
	var wg sync.WaitGroup

	probePkt := (&laprf.Packet{Type: laprf.RecordTime}).Encode()

	for _, h := range hosts {
		host := h
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				return
			}
			d := net.Dialer{Timeout: dialTimeout}
			conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
			if err != nil {
				return
			}
			defer conn.Close()

			verified := false
			_ = conn.SetDeadline(time.Now().Add(260 * time.Millisecond))
			_, _ = conn.Write(probePkt)
			buf := make([]byte, 512)
			n, _ := conn.Read(buf)
			for i := 0; i < n; i++ {
				if buf[i] == laprf.ByteSOR {
					for j := i + 1; j < n; j++ {
						if buf[j] == laprf.ByteEOR {
							if _, decErr := laprf.DecodeFrame(buf[i : j+1]); decErr == nil {
								verified = true
								break
							}
						}
					}
				}
				if verified {
					break
				}
			}

			mu.Lock()
			out = append(out, DiscoveredLapRFDevice{
				Host:     host,
				Port:     port,
				Verified: verified,
			})
			mu.Unlock()
		}()
	}
	wg.Wait()
	sort.Slice(out, func(i, j int) bool {
		if out[i].Verified != out[j].Verified {
			return out[i].Verified
		}
		return out[i].Host < out[j].Host
	})
	return out
}

func (s *Server) handleRotorHazardDiscover(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	port := DefaultRotorHazardPort
	if pStr := strings.TrimSpace(r.URL.Query().Get("port")); pStr != "" {
		if p, err := strconv.Atoi(pStr); err == nil && p >= 1 && p <= 65535 {
			port = p
		}
	}

	var candidates []string
	if explicitHosts := strings.TrimSpace(r.URL.Query().Get("hosts")); explicitHosts != "" {
		for _, raw := range strings.Split(explicitHosts, ",") {
			raw = strings.TrimSpace(raw)
			if ip := net.ParseIP(raw); ip != nil && isAllowedLapRFTargetIP(ip, true) {
				candidates = append(candidates, ip.String())
			}
		}
	} else if subnet := strings.TrimSpace(r.URL.Query().Get("subnet")); subnet != "" {
		parts := strings.Split(subnet, ".")
		if len(parts) == 3 {
			for hostOctet := 1; hostOctet <= 254; hostOctet++ {
				ipStr := fmt.Sprintf("%s.%d", subnet, hostOctet)
				if ip := net.ParseIP(ipStr); ip != nil && isAllowedLapRFTargetIP(ip, false) {
					candidates = append(candidates, ipStr)
				}
			}
		}
	} else {
		seenPrefix := make(map[string]bool)
		for _, ipStr := range LanIPs() {
			ip := net.ParseIP(ipStr).To4()
			if ip == nil || !ip.IsPrivate() {
				continue
			}
			prefix := fmt.Sprintf("%d.%d.%d", ip[0], ip[1], ip[2])
			if seenPrefix[prefix] || len(seenPrefix) >= 2 {
				continue
			}
			seenPrefix[prefix] = true
			for hostOctet := 1; hostOctet <= 254; hostOctet++ {
				candidates = append(candidates, fmt.Sprintf("%s.%d", prefix, hostOctet))
			}
		}
	}

	found := ProbeRotorHazardHosts(r.Context(), candidates, port, 300*time.Millisecond)
	writeJSONNoStore(w, http.StatusOK, map[string]any{
		"devices": found,
	})
}

// ProbeRotorHazardHosts probes candidate LAN hosts in parallel on port (default 5000) via an
// Engine.IO v4 HTTP polling handshake (`/socket.io/?EIO=4&transport=polling`) and verifies `0{...}`.
func ProbeRotorHazardHosts(ctx context.Context, hosts []string, port int, timeout time.Duration) []DiscoveredRotorHazardDevice {
	if len(hosts) == 0 {
		return []DiscoveredRotorHazardDevice{}
	}
	sem := make(chan struct{}, 64)
	var mu sync.Mutex
	out := make([]DiscoveredRotorHazardDevice, 0)
	var wg sync.WaitGroup

	hc := &http.Client{Timeout: timeout}
	for _, h := range hosts {
		host := h
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				return
			}
			target := fmt.Sprintf("http://%s/socket.io/?EIO=4&transport=polling", net.JoinHostPort(host, strconv.Itoa(port)))
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
			if err != nil {
				return
			}
			resp, err := hc.Do(req)
			if err != nil {
				return
			}
			bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			_ = resp.Body.Close()

			verified := false
			for _, pkt := range rotorhazard.SplitEIOPayload(string(bodyBytes)) {
				if openPkt, decErr := rotorhazard.DecodeEIOOpen(pkt); decErr == nil && openPkt.SID != "" {
					verified = true
					break
				}
			}
			if !verified {
				return
			}
			mu.Lock()
			out = append(out, DiscoveredRotorHazardDevice{
				Host:     host,
				Port:     port,
				Verified: true,
			})
			mu.Unlock()
		}()
	}
	wg.Wait()
	sort.Slice(out, func(i, j int) bool {
		return out[i].Host < out[j].Host
	})
	return out
}

// LanIPs returns this machine's non-loopback IPv4 addresses.
func LanIPs() []string {
	var out []string
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return []string{}
	}
	for _, a := range addrs {
		if ipn, ok := a.(*net.IPNet); ok && !ipn.IP.IsLoopback() && !ipn.IP.IsLinkLocalUnicast() {
			if v4 := ipn.IP.To4(); v4 != nil {
				out = append(out, v4.String())
			}
		}
	}
	if out == nil {
		return []string{}
	}
	return out
}

// Ensure websocket package is referenced cleanly
var _ = websocket.StatusNormalClosure
