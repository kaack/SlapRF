package usb

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"

	"slaprf/internal/firmware"
	"slaprf/internal/ingest"
	"slaprf/internal/storage"
	"slaprf/internal/tracker"
)

const (
	MaxUSBConnections       = 3
	pktRecordSep       byte = 0x1E
	configBlockLen          = 160
	latestFirmwareText      = "0.4.0"

	kvUSBTargetsKey  = "hw.usb_targets"
	kvKnownTimersKey = "hw.known_timers"
)

var configMagic = []byte("SLAPRF02")

// KnownHardwareTimer mirrors `KnownHardwareTimer` in the frontend (`#/network` inventory).
type KnownHardwareTimer struct {
	FP          string `json:"fp"`
	Role        string `json:"role"` // "hub" | "spoke"
	Label       string `json:"label"`
	FW          string `json:"fw,omitempty"`
	MAC         string `json:"mac,omitempty"`
	Slot        int    `json:"slot,omitempty"`
	Channel     int    `json:"channel,omitempty"`
	ParentHubFP string `json:"parentHubFp,omitempty"`
	LastSeenMs  int64  `json:"lastSeenMs"`
}

// SlotSnapshot describes the live state of one physical USB slot (0..2).
type SlotSnapshot struct {
	SlotIndex       int                    `json:"slotIndex"`
	Connected       bool                   `json:"connected"`
	PortName        string                 `json:"portName,omitempty"`
	Probing         bool                   `json:"probing"`
	Reconnecting    bool                   `json:"reconnecting"`
	ReconnectTry    int                    `json:"reconnectAttempt"`
	ReconnectFailed bool                   `json:"reconnectFailed"`
	LastError       string                 `json:"lastError,omitempty"`
	LastStatus      map[string]any         `json:"lastStatus,omitempty"`
	LastConfig      *firmware.TimerReadout `json:"lastConfig,omitempty"`
}

// PoolSnapshot is returned by `GET /api/usb/status` and broadcast on `pool_state` events.
type PoolSnapshot struct {
	DebugSlotIndex int                  `json:"debugSlotIndex"`
	Slots          []SlotSnapshot       `json:"slots"`
	KnownTimers    []KnownHardwareTimer `json:"knownTimers"`
}

// USBEvent is pushed over `/api/ws/usb` to keep all connected UI tabs synchronized.
type USBEvent struct {
	Type      string                 `json:"type"` // pool_state | status | config | live | hub_live | scan | bootlog | log | raw_reply | error
	SlotIndex int                    `json:"slotIndex"`
	Pool      *PoolSnapshot          `json:"pool,omitempty"`
	Status    map[string]any         `json:"status,omitempty"`
	Config    *firmware.TimerReadout `json:"config,omitempty"`
	Payload   map[string]any         `json:"payload,omitempty"`
	Line      string                 `json:"line,omitempty"`
	MsgType   string                 `json:"msgType,omitempty"`
	Error     string                 `json:"error,omitempty"`
}

// ManagerConfig configures the native Go USB serial manager.
type ManagerConfig struct {
	Engine    *tracker.Engine
	HubRx     *ingest.HubFrameDecoder
	Store     *storage.BoltStore
	OpenPort  firmware.SerialOpener
	ListPorts PortLister
	Logf      func(string, ...any)
}

type slotHello struct {
	fp      string
	label   string
	role    uint8
	sweepHz uint8
}

type slotLive struct {
	frames        int
	lastFrameAtMs int64
	seq           uint8
	dbm           []int
	floor         int
}

type replyWaiter struct {
	msgType string
	ch      chan any
}

type usbSlot struct {
	index int

	mu                   sync.Mutex
	portName             string
	port                 firmware.SerialPort
	writeMu              sync.Mutex
	cancel               context.CancelFunc
	doneCh               chan struct{}
	probing              bool
	reconnecting         bool
	reconnectAttempt     int
	reconnectFailed      bool
	suspendedForSim      bool
	lastError            string
	lastStatus           map[string]any
	lastStatusAtMs       int64
	lastRealJsonStatusMs int64
	lastConfig           *firmware.TimerReadout
	sawRomBootloader     bool

	hubOwnFrames int
	hubLastDbm   []int
	// Last time a throttled "hub_live" event (per-slot RSSI) was sent to browsers.
	hubLiveEmitMs int64
	hubHello      map[uint8]slotHello
	hubLive       map[uint8]slotLive
	waiters       []*replyWaiter
}

// Manager owns physical USB-C serial connections to SlapRF XIAO ESP32-C5 Hub & Spoke boards.
type Manager struct {
	cfg      ManagerConfig
	openPort firmware.SerialOpener
	listFn   PortLister

	mu             sync.RWMutex
	slots          [MaxUSBConnections]*usbSlot
	debugSlotIndex int
	knownTimers    map[string]KnownHardwareTimer
	simMode        bool
	closed         bool

	subMu  sync.RWMutex
	nextID int
	subs   map[int]func(USBEvent)
}

// NewManager creates a native Go USB serial manager wired to `realEngine` and `realHubRx`.
func NewManager(cfg ManagerConfig) *Manager {
	opener := cfg.OpenPort
	if opener == nil {
		opener = DefaultSerialOpener
	}
	lister := cfg.ListPorts
	if lister == nil {
		lister = DefaultListPorts
	}
	m := &Manager{
		cfg:         cfg,
		openPort:    opener,
		listFn:      lister,
		knownTimers: make(map[string]KnownHardwareTimer),
		subs:        make(map[int]func(USBEvent)),
	}
	for i := 0; i < MaxUSBConnections; i++ {
		m.slots[i] = &usbSlot{
			index:    i,
			hubHello: make(map[uint8]slotHello),
			hubLive:  make(map[uint8]slotLive),
		}
	}
	if cfg.Store != nil {
		var list []KnownHardwareTimer
		if ok, err := cfg.Store.GetJSON(kvKnownTimersKey, &list); err == nil && ok {
			for _, kt := range list {
				fp := strings.ToUpper(strings.TrimSpace(kt.FP))
				if fp != "" {
					kt.FP = fp
					m.knownTimers[fp] = kt
				}
			}
		}
	}
	if cfg.HubRx != nil {
		cfg.HubRx.SetOutboundSender(m.sendNetChannelsFrameToHub)
	}
	return m
}

func (m *Manager) logf(format string, args ...any) {
	if m.cfg.Logf != nil {
		m.cfg.Logf(format, args...)
	}
}

// RestorePersistedConnections attempts to reopen previously connected physical USB ports when starting in Real mode.
func (m *Manager) RestorePersistedConnections(simMode bool) {
	m.mu.Lock()
	m.simMode = simMode
	m.mu.Unlock()

	if m.cfg.Store == nil {
		return
	}
	var saved map[string]string
	if ok, err := m.cfg.Store.GetJSON(kvUSBTargetsKey, &saved); err != nil || !ok || len(saved) == 0 {
		return
	}
	for k, portName := range saved {
		portName = strings.TrimSpace(portName)
		if portName == "" {
			continue
		}
		var idx int
		if _, err := fmt.Sscanf(k, "%d", &idx); err != nil || idx < 0 || idx >= MaxUSBConnections {
			continue
		}
		if simMode {
			slot := m.slots[idx]
			slot.mu.Lock()
			slot.portName = portName
			slot.suspendedForSim = true
			slot.mu.Unlock()
			continue
		}
		go func(slotIdx int, pName string) {
			if _, err := m.Connect(slotIdx, pName); err != nil {
				m.logf("[USB] Auto-restore %s on slot %d skipped: %v", pName, slotIdx, err)
			}
		}(idx, portName)
	}
}

// Close disconnects all open USB ports cleanly.
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	m.mu.Unlock()
	for i := 0; i < MaxUSBConnections; i++ {
		_ = m.closeSlotInternal(m.slots[i], false)
	}
}

// Subscribe registers an event callback for `/api/ws/usb` streaming.
func (m *Manager) Subscribe(fn func(USBEvent)) func() {
	m.subMu.Lock()
	m.nextID++
	id := m.nextID
	m.subs[id] = fn
	m.subMu.Unlock()
	return func() {
		m.subMu.Lock()
		delete(m.subs, id)
		m.subMu.Unlock()
	}
}

func (m *Manager) emit(ev USBEvent) {
	m.subMu.RLock()
	list := make([]func(USBEvent), 0, len(m.subs))
	for _, fn := range m.subs {
		list = append(list, fn)
	}
	m.subMu.RUnlock()
	for _, fn := range list {
		fn(ev)
	}
}

func (m *Manager) broadcastPoolState() {
	snap := m.Snapshot()
	m.emit(USBEvent{
		Type:      "pool_state",
		SlotIndex: snap.DebugSlotIndex,
		Pool:      &snap,
	})
}

// ListPorts returns OS serial ports annotated with active slot usage.
// By default (`showAll == false`), only Espressif USB boards (`VID=303A`, e.g. XIAO ESP32-C5)
// are returned, excluding legacy motherboard UARTs (`COM1`) and non-Espressif serial devices.
// When `showAll == true`, all USB serial adapters are returned while still excluding legacy
// non-USB motherboard COM ports (`!IsUSB` with a non-USB product descriptor).
func (m *Manager) ListPorts(showAll bool) ([]PortInfo, error) {
	ports, err := m.listFn()
	if err != nil {
		return nil, err
	}
	filtered := make([]PortInfo, 0, len(ports))
	if showAll {
		for _, p := range ports {
			if p.IsEspressif || p.IsUSB {
				filtered = append(filtered, p)
			}
		}
		return filtered, nil
	}
	for _, p := range ports {
		if p.IsEspressif {
			filtered = append(filtered, p)
		}
	}
	return filtered, nil
}

// SetDebugSlot switches which USB slot (0 or 1) the Debug view inspects.
func (m *Manager) SetDebugSlot(slotIndex int) {
	if slotIndex != 1 {
		slotIndex = 0
	}
	m.mu.Lock()
	changed := m.debugSlotIndex != slotIndex
	m.debugSlotIndex = slotIndex
	m.mu.Unlock()
	if changed {
		m.broadcastPoolState()
	}
}

// SetSimMode suspends open physical USB ports while Simulation is ON and restores them when Simulation turns OFF.
func (m *Manager) SetSimMode(simRunning bool) {
	m.mu.Lock()
	prev := m.simMode
	m.simMode = simRunning
	m.mu.Unlock()
	if prev == simRunning {
		return
	}
	if simRunning {
		for _, slot := range m.slots {
			slot.mu.Lock()
			wasOpen := slot.port != nil && slot.portName != ""
			pName := slot.portName
			slot.mu.Unlock()
			if wasOpen {
				_ = m.closeSlotInternal(slot, false)
				slot.mu.Lock()
				slot.portName = pName
				slot.suspendedForSim = true
				slot.mu.Unlock()
			}
		}
		m.broadcastPoolState()
		return
	}

	for _, slot := range m.slots {
		slot.mu.Lock()
		shouldRestore := slot.suspendedForSim && slot.portName != ""
		pName := slot.portName
		slot.suspendedForSim = false
		slot.mu.Unlock()
		if shouldRestore {
			go func(idx int, portName string) {
				_, _ = m.Connect(idx, portName)
			}(slot.index, pName)
		}
	}
}

// Snapshot returns the current state of all 3 USB slots and persisted known timers.
func (m *Manager) Snapshot() PoolSnapshot {
	m.mu.RLock()
	dbg := m.debugSlotIndex
	known := make([]KnownHardwareTimer, 0, len(m.knownTimers))
	for _, kt := range m.knownTimers {
		known = append(known, kt)
	}
	m.mu.RUnlock()

	sort.Slice(known, func(i, j int) bool {
		return known[i].LastSeenMs > known[j].LastSeenMs
	})

	slots := make([]SlotSnapshot, MaxUSBConnections)
	for i := 0; i < MaxUSBConnections; i++ {
		s := m.slots[i]
		s.mu.Lock()
		var stCopy map[string]any
		if s.lastStatus != nil {
			b, _ := json.Marshal(s.lastStatus)
			_ = json.Unmarshal(b, &stCopy)
		}
		var cfgCopy *firmware.TimerReadout
		if s.lastConfig != nil {
			c := *s.lastConfig
			cfgCopy = &c
		}
		slots[i] = SlotSnapshot{
			SlotIndex:       i,
			Connected:       s.port != nil,
			PortName:        s.portName,
			Probing:         s.probing,
			Reconnecting:    s.reconnecting,
			ReconnectTry:    s.reconnectAttempt,
			ReconnectFailed: s.reconnectFailed,
			LastError:       s.lastError,
			LastStatus:      stCopy,
			LastConfig:      cfgCopy,
		}
		s.mu.Unlock()
	}

	return PoolSnapshot{
		DebugSlotIndex: dbg,
		Slots:          slots,
		KnownTimers:    known,
	}
}
