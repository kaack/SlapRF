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
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"slaprf/internal/api"
	"slaprf/internal/applog"
	"slaprf/internal/domain"
	"slaprf/internal/firmware"
	"slaprf/internal/ingest"
	"slaprf/internal/laprf"
	"slaprf/internal/ml"
	"slaprf/internal/rotorhazard"
	"slaprf/internal/serialport"
	"slaprf/internal/slaprf"
	slaprfble "slaprf/internal/slaprf/bluetooth"
	slaprfnet "slaprf/internal/slaprf/network"
	slaprfusb "slaprf/internal/slaprf/usb"
	"slaprf/internal/storage"
	"slaprf/internal/tracestore"
	"slaprf/internal/tracker"
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

// CapabilitiesResponse is returned by GET /v1/capabilities on a native SlapRF Go backend.
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
	TeacherDir      string // Optional directory for on-device `.gguf` teacher models (defaults to `<dir(DBPath)>/teacher_models`)
	DisableTeacher  bool   // When true (e.g. mobile Android host), disables heavy `.gguf` LLM teacher download/auto-labeling
	AllowedOrigins  []string
	AllowLANOrigins bool
	MultiGPBaseURL  string // Defaults to DefaultMultiGPBaseURL
	HTTPClient      *http.Client
	Log             *log.Logger
	AppLog          *applog.Logger
	LogPath         string // Optional rolling log file path; defaults to slaprf.log next to DBPath
	LogLevel        string // Optional initial log level: trace, debug, info, warn, error
	USBOpenPort     firmware.SerialOpener
	USBListPorts    serialport.Lister
	BLEOpenPort     firmware.SerialOpener
	BLEListPorts    serialport.Lister
	DisableAuth     bool // When true (-no-auth), clears persisted Basic Auth on startup
}

// Server owns the complete native Go timing engines (`realEngine` + `simEngine`), `TrackSimulator`,
// single-file `bbolt` storage (`slaprf.db`), isolated SlapRF USB & Bluetooth managers, native LapRF 8-Way
// & RotorHazard hardware links, LapRF 8-Way :5403 TCP emulator, MultiGP proxy, and WebSocket event stream.
type Server struct {
	cfg           Config
	appLog        *applog.Logger
	ownsAppLog    bool
	httpClient    *http.Client
	hostname      string
	tempDBPath    string
	store          *storage.BoltStore
	realTraceStore tracestore.Store
	persistWorker  *storage.PersistenceWorker

	simEngine  *tracker.Engine
	realEngine *tracker.Engine
	sim        *ingest.TrackSimulator
	realHubRx  *ingest.HubFrameDecoder
	simHubRx   *ingest.HubFrameDecoder
	laprfSrv   *laprf.Server
	apiSrv     *api.Server
	stream     *streamHub

	usbTransport     *slaprfusb.Transport
	usbMgr           *slaprf.Manager
	bleTransport     *slaprfble.Transport
	bleMgr           *slaprf.Manager
	netTransport     *slaprfnet.Transport
	netMgr           *slaprf.Manager
	laprfMgr         *laprfManager
	rhMgr            *rhManager
	laprfEmulatorMgr *laprfEmulatorManager

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
	appLogger := cfg.AppLog
	ownsAppLog := false
	initLevel := applog.LevelInfo
	hasExplicitLevel := false
	if parsed, ok := applog.ParseLevel(cfg.LogLevel); ok && strings.TrimSpace(cfg.LogLevel) != "" {
		initLevel = parsed
		hasExplicitLevel = true
	} else if envLvl, ok := applog.EnvLevel(); ok {
		initLevel = envLvl
		hasExplicitLevel = true
	} else if store != nil {
		var savedLvl string
		if ok, gErr := store.GetJSON(storage.KeyLogLevel, &savedLvl); gErr == nil && ok {
			if parsed, pOk := applog.ParseLevel(savedLvl); pOk {
				initLevel = parsed
				hasExplicitLevel = true
			}
		}
	}
	if appLogger == nil {
		ownsAppLog = true
		appLogger = applog.New(applog.Options{
			FilePath: applog.ResolveDefaultLogPath(dbPath, cfg.LogPath),
			Level:    initLevel,
			HasLevel: true,
		})
	} else if hasExplicitLevel {
		appLogger.SetLevel(initLevel)
	}
	if cfg.Log == nil {
		cfg.Log = appLogger.StdLogger()
	}
	if err != nil {
		appLogger.Warnf("[Storage] Failed to open %s: %v", dbPath, err)
	}

	simEngine := tracker.NewEngine()
	realEngine := tracker.NewRealEngine()
	var realTraces tracestore.Store
	if tempDB == "" && dbPath != "" {
		if fs, fErr := tracestore.NewFileStore(filepath.Join(filepath.Dir(dbPath), "traces")); fErr == nil {
			realTraces = fs
			realEngine.SetTraceStore(fs)
		} else {
			appLogger.Warnf("[TraceStore] Failed to open traces directory: %v", fErr)
		}
	}
	if !cfg.DisableTeacher {
		teacherDir := strings.TrimSpace(cfg.TeacherDir)
		if teacherDir == "" && dbPath != "" {
			teacherDir = filepath.Join(filepath.Dir(dbPath), "teacher_models")
		}
		teacherMgr := ml.NewTeacherManager(teacherDir, hc)
		teacherMgr.SetUpdateHook(func() {
			realEngine.BroadcastMLStatus()
			simEngine.BroadcastMLStatus()
		})
		realEngine.SetTeacherManager(teacherMgr)
		simEngine.SetTeacherManager(teacherMgr)
	}
	sim := ingest.NewTrackSimulator(simEngine)
	realHubRx := ingest.NewHubFrameDecoder(realEngine)
	realHubRx.SetLogger(appLogger)
	simHubRx := ingest.NewHubFrameDecoder(simEngine)
	simHubRx.SetSimContext(true)
	simHubRx.SetLogger(appLogger)

	s := &Server{
		cfg:        cfg,
		appLog:     appLogger,
		ownsAppLog: ownsAppLog,
		httpClient: hc,
		hostname:   hostName,
		tempDBPath:     tempDB,
		store:          store,
		realTraceStore: realTraces,
		simEngine:      simEngine,
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
		s.setSimHubUSBConnected(false)
		simHubRx.Reset()
		simEngine.SetAllTimersOffline()
	})

	var initialSimMode bool
	if store != nil {
		s.persistWorker = storage.NewPersistenceWorker(store, simEngine, realEngine, sim, cfg.Log)
		initialSimMode = s.persistWorker.Hydrate()
		s.persistWorker.Start()
	}
	if domain.IsSlapRFMode(simEngine.TimingHardwareMode()) {
		simEngine.SetAllTimersOffline()
	} else {
		sim.SyncHardwareMode()
	}
	tracker.SyncBootTimes(simEngine, realEngine)
	sim.SetRunning(initialSimMode)
	sim.Start()
	if initialSimMode && domain.IsSlapRFMode(simEngine.TimingHardwareMode()) && s.simHubUSBConnected.Load() {
		simHubRx.Reset()
		s.ingestRawHubStream(simHubRx, simEngine, sim.BuildHubHelloStream())
	}

	laprfSrv := laprf.NewServer(simEngine)
	apiSrv := api.NewServer(simEngine, sim, laprfSrv, realEngine)
	apiSrv.SetLogger(appLogger)
	s.laprfSrv = laprfSrv
	s.apiSrv = apiSrv

	s.stream = newStreamHub(simEngine, realEngine, sim.IsRunning, appLogger)

	sharedTimers := slaprf.NewKnownTimerRegistry(store)
	s.usbTransport = slaprfusb.NewTransport(slaprfusb.Config{
		OpenPort:  cfg.USBOpenPort,
		ListPorts: cfg.USBListPorts,
	})
	s.usbMgr = slaprf.NewManager(slaprf.Config{
		Transport:       s.usbTransport,
		Timers:          sharedTimers,
		Engine:          realEngine,
		HubRx:           realHubRx,
		SkipHubOutbound: true,
		Store:           store,
		AppLog:          appLogger,
		Logf:            s.logf,
	})
	s.bleTransport = slaprfble.NewTransport(slaprfble.Config{
		OpenPort:  cfg.BLEOpenPort,
		ListPorts: cfg.BLEListPorts,
	})
	s.bleMgr = slaprf.NewManager(slaprf.Config{
		Transport:       s.bleTransport,
		Timers:          sharedTimers,
		Engine:          realEngine,
		HubRx:           realHubRx,
		SkipHubOutbound: true,
		Store:           store,
		AppLog:          appLogger,
		Logf:            s.logf,
	})
	s.netTransport = slaprfnet.NewTransport(slaprfnet.Config{})
	s.netMgr = slaprf.NewManager(slaprf.Config{
		Transport:       s.netTransport,
		Timers:          sharedTimers,
		Engine:          realEngine,
		HubRx:           realHubRx,
		SkipHubOutbound: true,
		Store:           store,
		AppLog:          appLogger,
		Logf:            s.logf,
	})
	realHubRx.SetOutboundSender(func(pkt []byte) {
		s.activeSlapRFManager().SendNetChannelsFrame(pkt)
	})

	markDirty := func() {
		if s.persistWorker != nil {
			s.persistWorker.MarkDirty()
		}
	}
	s.laprfMgr = newLapRFManager(realEngine, store, cfg.USBOpenPort, s.logf, markDirty)
	s.rhMgr = newRHManager(realEngine, store, cfg.USBOpenPort, s.logf, markDirty)
	s.laprfEmulatorMgr = newLapRFEmulatorManager(cfg.Version, laprfSrv, store, func() bool {
		return !sim.IsRunning() && domain.IsLapRFMode(realEngine.TimingHardwareMode())
	}, s.logf)

	var reconcileMu sync.Mutex
	var lastActiveSlapRF domain.TimingHardwareMode
	reconcileSlapRFLinks := func(simRunning bool, realMode domain.TimingHardwareMode, restoreSaved bool) {
		reconcileMu.Lock()
		wantMode := domain.TimingHardwareMode("")
		if !simRunning && domain.IsSlapRFMode(realMode) {
			wantMode = domain.NormalizeTimingHardwareMode(realMode)
		}
		modeChanged := wantMode != lastActiveSlapRF
		lastActiveSlapRF = wantMode
		reconcileMu.Unlock()

		wantUSB := wantMode == domain.HardwareModeSlapRF
		wantBLE := wantMode == domain.HardwareModeSlapRFBLE
		wantNet := wantMode == domain.HardwareModeSlapRFNet
		if !wantUSB {
			s.usbMgr.SetActiveWithRestore(false, simRunning, false)
		}
		if !wantBLE {
			s.bleMgr.SetActiveWithRestore(false, simRunning, false)
		}
		if !wantNet {
			s.netMgr.SetActiveWithRestore(false, simRunning, false)
		}
		if modeChanged && wantMode != "" {
			realHubRx.Reset()
		}
		if wantUSB {
			s.usbMgr.SetActiveWithRestore(true, simRunning, restoreSaved)
		}
		if wantBLE {
			s.bleMgr.SetActiveWithRestore(true, simRunning, restoreSaved)
		}
		if wantNet {
			s.netMgr.SetActiveWithRestore(true, simRunning, restoreSaved)
		}
	}

	reconcileRealHardwareLinks := func(simRunning bool, restoreSaved bool) {
		realMode := realEngine.TimingHardwareMode()
		reconcileSlapRFLinks(simRunning, realMode, restoreSaved)
		if restoreSaved {
			s.laprfMgr.RestorePersistedTargets(simRunning)
			s.rhMgr.RestorePersistedTargets(simRunning)
		} else {
			s.laprfMgr.Reconcile(simRunning)
			s.rhMgr.Reconcile(simRunning)
		}
		s.laprfEmulatorMgr.Reconcile()
	}

	apiSrv.SetHooks(api.ServerHooks{
		OnMutation: func() {
			if s.persistWorker != nil {
				s.persistWorker.MarkDirty()
			}
			reconcileRealHardwareLinks(sim.IsRunning(), false)
		},
		OnModeChanged: func(simRunning bool) {
			if s.persistWorker != nil {
				s.persistWorker.SaveMode(simRunning)
			}
			if simRunning && s.simHubUSBConnected.Load() {
				s.ingestRawHubStream(simHubRx, simEngine, sim.BuildHubHelloStream())
			}
			reconcileRealHardwareLinks(simRunning, true)
		},
		OnTimingStarted: func() {
			if !sim.IsRunning() && domain.IsSlapRFMode(realEngine.TimingHardwareMode()) {
				wasSurvey := s.realHubRx.SurveyActive()
				_ = s.realHubRx.SetSurvey(false)
				s.activeSlapRFManager().SendToHub("SCAN STOP\nCHANNELS RESET\nRF 1")
				if !wasSurvey {
					s.realHubRx.PushActiveChannels()
				}
			}
		},
		OnStorageReset: func() {
			s.resetAuthConfig()
			if s.persistWorker != nil {
				s.persistWorker.WipeAndReconcile()
			}
			s.realHubRx.ClearSlotBindings()
			s.simHubRx.ClearSlotBindings()
			reconcileRealHardwareLinks(sim.IsRunning(), false)
			if !sim.IsRunning() && domain.IsSlapRFMode(realEngine.TimingHardwareMode()) {
				s.activeSlapRFManager().RebindConnectedTimers()
			}
		},
		OnStorageImport: func() {
			if s.persistWorker != nil {
				s.persistWorker.ReconcileAllNow()
			}
			s.realHubRx.ClearSlotBindings()
			s.simHubRx.ClearSlotBindings()
			reconcileRealHardwareLinks(sim.IsRunning(), true)
			if !sim.IsRunning() && domain.IsSlapRFMode(realEngine.TimingHardwareMode()) {
				s.activeSlapRFManager().RebindConnectedTimers()
			}
		},
		OnLogLevelChanged: func(level string) {
			if s.store != nil {
				_ = s.store.PutJSON(storage.KeyLogLevel, level)
			}
		},
	})

	// Restore persisted hardware links & LapRF emulator listener
	reconcileSlapRFLinks(initialSimMode, realEngine.TimingHardwareMode(), true)
	s.laprfMgr.RestorePersistedTargets(initialSimMode)
	s.rhMgr.RestorePersistedTargets(initialSimMode)
	s.laprfEmulatorMgr.Reconcile()

	appLogger.Infof("[Server] SlapRF %s (%s/%s) ready: db=%s log=%s level=%s simRunning=%v hwMode=%s timers=%d",
		cfg.Version, runtime.GOOS, runtime.GOARCH, s.DBPath(), s.LogPath(), appLogger.Level().String(),
		initialSimMode, realEngine.TimingHardwareMode(), len(realEngine.DetectedTimersSnapshot()))

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
		if domain.IsSlapRFMode(s.simEngine.TimingHardwareMode()) {
			s.simEngine.SetAllTimersOffline()
		}
		return
	}
	if s.sim.IsRunning() && domain.IsSlapRFMode(s.simEngine.TimingHardwareMode()) {
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
	if s.appLog != nil {
		msg := strings.TrimSpace(fmt.Sprintf(format, args...))
		s.appLog.Infof("%s", msg)
		return
	}
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

// LogPath returns the active rolling `slaprf.log` file path (or `""` if memory-only).
func (s *Server) LogPath() string {
	return s.appLog.Path()
}

// AppLog returns the server's structured diagnostic logger.
func (s *Server) AppLog() *applog.Logger {
	return s.appLog
}

func (s *Server) activeSlapRFManager() *slaprf.Manager {
	if s.realEngine != nil {
		switch s.realEngine.TimingHardwareMode() {
		case domain.HardwareModeSlapRFBLE:
			return s.bleMgr
		case domain.HardwareModeSlapRFNet:
			return s.netMgr
		}
	}
	return s.usbMgr
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
	if s.laprfEmulatorMgr != nil {
		s.laprfEmulatorMgr.close()
	}
	if s.laprfMgr != nil {
		s.laprfMgr.close()
	}
	if s.rhMgr != nil {
		s.rhMgr.close()
	}
	if s.netMgr != nil {
		s.netMgr.Close()
	}
	if s.bleMgr != nil {
		s.bleMgr.Close()
	}
	if s.usbMgr != nil {
		s.usbMgr.Close()
	}
	if s.stream != nil {
		s.stream.close()
	}
	if s.realTraceStore != nil {
		_ = s.realTraceStore.Close()
	}
	if s.store != nil {
		_ = s.store.Close()
	}
	if s.tempDBPath != "" {
		_ = os.Remove(s.tempDBPath)
	}
	if s.ownsAppLog {
		_ = s.appLog.Close()
	}
}

// RegisterAPIRoutes attaches all native Go `/v1/*` endpoints onto mux.
func (s *Server) RegisterAPIRoutes(mux *http.ServeMux) {
	// Core engine, simulator, race sessions, practice sessions, pilots, gates, and storage routes
	s.apiSrv.RegisterRoutes(mux)

	// Server capabilities, authentication & bbolt storage status
	mux.HandleFunc("GET /v1/capabilities", s.handleCapabilities)
	mux.HandleFunc("POST /v1/auth/sessions", s.handleAuthLogin)
	mux.HandleFunc("GET /v1/auth/config", s.handleAuthConfig)
	mux.HandleFunc("PUT /v1/auth/config", s.handleAuthConfig)
	mux.HandleFunc("GET /v1/storage/status", s.handleStorageStatus)
	mux.HandleFunc("POST /v1/storage:recordBackup", s.handleStorageBackupRecorded)

	// Real-time event + binary telemetry WebSocket stream
	mux.HandleFunc("GET /v1/ws/stream", s.handleStreamWS)

	// SlapRF USB-C serial & ESP32-C5 ROM bootloader flasher
	mux.HandleFunc("GET /v1/slaprf/usb/ports", s.handleUSBPorts)
	mux.HandleFunc("GET /v1/slaprf/usb/connections", s.handleUSBStatus)
	mux.HandleFunc("POST /v1/slaprf/usb/connections", s.handleUSBConnect)
	mux.HandleFunc("POST /v1/slaprf/usb/connections:disconnectAll", s.handleUSBDisconnectAll)
	mux.HandleFunc("PUT /v1/slaprf/usb/connections/{slotIndex}", s.handleUSBConnect)
	mux.HandleFunc("DELETE /v1/slaprf/usb/connections/{slotIndex}", s.handleUSBDisconnectSlot)
	mux.HandleFunc("GET /v1/slaprf/usb/debug-slot", s.handleUSBDebugSlot)
	mux.HandleFunc("PUT /v1/slaprf/usb/debug-slot", s.handleUSBDebugSlot)
	mux.HandleFunc("POST /v1/slaprf/usb:command", s.handleUSBCommand)
	mux.HandleFunc("GET /v1/slaprf/usb/survey", s.handleUSBSurvey)
	mux.HandleFunc("PUT /v1/slaprf/usb/survey", s.handleUSBSurvey)
	mux.HandleFunc("GET /v1/sim/slaprf/hub-usb", s.handleSimHubUSB)
	mux.HandleFunc("PUT /v1/sim/slaprf/hub-usb", s.handleSimHubUSB)
	mux.HandleFunc("GET /v1/ws/slaprf/usb", s.handleUSBWS)
	mux.HandleFunc("GET /v1/ws/slaprf/usb-raw", s.handleUSBRawWS)

	// SlapRF Bluetooth LE Hub
	mux.HandleFunc("GET /v1/slaprf/bluetooth/ports", s.handleBluetoothPorts)
	mux.HandleFunc("GET /v1/slaprf/bluetooth/connections", s.handleBluetoothStatus)
	mux.HandleFunc("POST /v1/slaprf/bluetooth/connections", s.handleBluetoothConnect)
	mux.HandleFunc("POST /v1/slaprf/bluetooth/connections:disconnectAll", s.handleBluetoothDisconnectAll)
	mux.HandleFunc("PUT /v1/slaprf/bluetooth/connections/{slotIndex}", s.handleBluetoothConnect)
	mux.HandleFunc("DELETE /v1/slaprf/bluetooth/connections/{slotIndex}", s.handleBluetoothDisconnectSlot)
	mux.HandleFunc("POST /v1/slaprf/bluetooth:command", s.handleBluetoothCommand)
	mux.HandleFunc("GET /v1/slaprf/bluetooth/survey", s.handleBluetoothSurvey)
	mux.HandleFunc("PUT /v1/slaprf/bluetooth/survey", s.handleBluetoothSurvey)
	mux.HandleFunc("GET /v1/ws/slaprf/bluetooth", s.handleBluetoothWS)

	// SlapRF PoE Ethernet / TCP Serial Bridge
	mux.HandleFunc("GET /v1/slaprf/network/ports", s.handleNetworkPorts)
	mux.HandleFunc("GET /v1/slaprf/network/devices", s.handleNetworkDevices)
	mux.HandleFunc("GET /v1/slaprf/network/bridge", s.handleNetworkBridgeStatus)
	mux.HandleFunc("POST /v1/slaprf/network/bridge:action", s.handleNetworkBridgeAction)
	mux.HandleFunc("GET /v1/slaprf/network/connections", s.handleNetworkStatus)
	mux.HandleFunc("POST /v1/slaprf/network/connections", s.handleNetworkConnect)
	mux.HandleFunc("POST /v1/slaprf/network/connections:disconnectAll", s.handleNetworkDisconnectAll)
	mux.HandleFunc("PUT /v1/slaprf/network/connections/{slotIndex}", s.handleNetworkConnect)
	mux.HandleFunc("DELETE /v1/slaprf/network/connections/{slotIndex}", s.handleNetworkDisconnectSlot)
	mux.HandleFunc("POST /v1/slaprf/network:command", s.handleNetworkCommand)
	mux.HandleFunc("GET /v1/slaprf/network/survey", s.handleNetworkSurvey)
	mux.HandleFunc("PUT /v1/slaprf/network/survey", s.handleNetworkSurvey)
	mux.HandleFunc("GET /v1/ws/slaprf/network", s.handleNetworkWS)

	// Shared SlapRF timer inventory
	mux.HandleFunc("DELETE /v1/slaprf/known-timers/{fp}", s.handleSlapRFKnownForget)

	// ImmersionRC LapRF 8-Way hardware links
	mux.HandleFunc("GET /v1/laprf/network/devices", s.handleLapRFDiscover)
	mux.HandleFunc("GET /v1/laprf/usb/ports", s.handleLapRFUSBPorts)
	mux.HandleFunc("GET /v1/laprf/connections", s.handleLapRFStatus)
	mux.HandleFunc("POST /v1/laprf/connections", s.handleLapRFConnect)
	mux.HandleFunc("DELETE /v1/laprf/connections/{timerId}", s.handleLapRFDisconnect)
	mux.HandleFunc("POST /v1/laprf:sync", s.handleLapRFSync)

	// RotorHazard hardware links
	mux.HandleFunc("GET /v1/rotorhazard/network/devices", s.handleRotorHazardDiscover)
	mux.HandleFunc("GET /v1/rotorhazard/usb/ports", s.handleRHUSBPorts)
	mux.HandleFunc("GET /v1/rotorhazard/connections", s.handleRHStatus)
	mux.HandleFunc("POST /v1/rotorhazard/connections", s.handleRHConnect)
	mux.HandleFunc("POST /v1/rotorhazard/connections/{timerId}", s.handleRHSessionAction)
	mux.HandleFunc("DELETE /v1/rotorhazard/connections/{timerId}", s.handleRHDisconnect)
	mux.HandleFunc("POST /v1/rotorhazard:sync", s.handleRHSync)

	// Native Go LapRF :5403 TCP emulator
	mux.HandleFunc("GET /v1/laprf-emulator", s.handleLapRFEmulatorStatus)
	mux.HandleFunc("PUT /v1/laprf-emulator", s.handleLapRFEmulatorConfig)
	mux.HandleFunc("PATCH /v1/laprf-emulator", s.handleLapRFEmulatorConfig)

	// Official MultiGP WebService proxy
	mux.HandleFunc("POST /v1/race/multigp/proxy/{subPath...}", s.handleMultiGPProxy)
	mux.HandleFunc("PUT /v1/race/multigp/proxy/{subPath...}", s.handleMultiGPProxy)
}

// Handler returns a complete http.Handler with CORS/Private-Network-Access support, `/v1/*`, and embedded SPA.
func (s *Server) Handler() http.Handler {
	apiMux := http.NewServeMux()
	s.RegisterAPIRoutes(apiMux)

	if s.cfg.StaticFS == nil {
		return s.withCORSAndPNA(apiMux)
	}

	staticMux := http.NewServeMux()
	fileServer := http.FileServer(http.FS(s.cfg.StaticFS))
	staticMux.HandleFunc("/sw.js", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = io.WriteString(w, "// SlapRF Portable: service worker disabled (assets served locally from binary)\nself.addEventListener('install', () => self.skipWaiting());\nself.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));\n")
	})
	staticMux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/docs" {
			http.Redirect(w, r, "/docs/", http.StatusMovedPermanently)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		cleanPath := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if cleanPath == "" {
			cleanPath = "index.html"
		}
		// Native Go Server Mode never serves WASM or legacy unversioned /api paths to the browser.
		if cleanPath == "wasm" || strings.HasPrefix(cleanPath, "wasm/") || cleanPath == "api" || strings.HasPrefix(cleanPath, "api/") {
			http.NotFound(w, r)
			return
		}
		if _, err := fs.Stat(s.cfg.StaticFS, cleanPath); err != nil {
			if cleanPath != "docs" && !strings.HasPrefix(cleanPath, "docs/") && !strings.Contains(path.Base(cleanPath), ".") {
				if indexBytes, readErr := fs.ReadFile(s.cfg.StaticFS, "index.html"); readErr == nil {
					w.Header().Set("Content-Type", "text/html; charset=utf-8")
					_, _ = w.Write(indexBytes)
					return
				}
			}
		}
		fileServer.ServeHTTP(w, r)
	})

	combined := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isVersionedAPIPath(r.URL.Path) {
			apiMux.ServeHTTP(w, r)
			return
		}
		staticMux.ServeHTTP(w, r)
	})
	return s.withCORSAndPNA(combined)
}

// NewStaticBrowserHandler returns a pure static HTTP handler that mimics https://slaprf.app
// (Standalone Browser Demo Mode: serves index.html, dist/app.js, wasm/slaprf.wasm, wasm/wasm_exec.js,
// styles, icons, and sounds with zero Go `/v1/*` backend routes and zero `slaprf.db`).
func NewStaticBrowserHandler(siteFS fs.FS) http.Handler {
	mux := http.NewServeMux()
	if siteFS == nil {
		return mux
	}
	fileServer := http.FileServer(http.FS(siteFS))
	mux.HandleFunc("/v1", http.NotFound)
	mux.HandleFunc("/v1/", http.NotFound)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/docs" {
			http.Redirect(w, r, "/docs/", http.StatusMovedPermanently)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		cleanPath := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if cleanPath == "" {
			cleanPath = "index.html"
		}
		if strings.HasSuffix(strings.ToLower(cleanPath), ".wasm") {
			w.Header().Set("Content-Type", "application/wasm")
		}
		if _, err := fs.Stat(siteFS, cleanPath); err != nil {
			if cleanPath != "docs" && !strings.HasPrefix(cleanPath, "docs/") && !strings.Contains(path.Base(cleanPath), ".") {
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
	s.appLog.Infof("[Storage] Exported application data backup")
	writeJSONNoStore(w, http.StatusOK, s.store.Status())
}

// --- MultiGP Reverse Proxy (/v1/race/multigp/proxy/*) ---

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
	sub := r.PathValue("subPath")
	if sub == "" {
		sub = strings.TrimPrefix(r.URL.Path, "/v1/race/multigp/proxy/")
	}
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

// --- LAN Target Validation & Discovery (/v1/laprf/network/devices & /v1/rotorhazard/network/devices) ---

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
		emulPort := s.laprfEmulatorMgr.listeningPort()
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
	if r.Method != http.MethodGet {
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
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok && !ipn.IP.IsLoopback() && !ipn.IP.IsLinkLocalUnicast() {
				if v4 := ipn.IP.To4(); v4 != nil {
					out = append(out, v4.String())
				}
			}
		}
	}
	// Fallback for Android 11+ where SELinux restricts netlink InterfaceAddrs():
	// a connectionless UDP dial queries the kernel routing table without sending any packet.
	if len(out) == 0 {
		if c, err := net.Dial("udp4", "192.0.2.1:80"); err == nil {
			if ua, ok := c.LocalAddr().(*net.UDPAddr); ok && ua.IP != nil && !ua.IP.IsLoopback() {
				if v4 := ua.IP.To4(); v4 != nil {
					out = append(out, v4.String())
				}
			}
			_ = c.Close()
		}
	}
	if out == nil {
		return []string{}
	}
	return out
}

// Ensure websocket package is referenced cleanly
var _ = websocket.StatusNormalClosure
