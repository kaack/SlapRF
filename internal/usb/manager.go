package usb

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"

	"slaprf/internal/domain"
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
	kvBLETargetsKey  = "hw.ble_targets"
	kvBLEHostKey     = "hw.ble_host_key"
	kvKnownTimersKey = "hw.known_timers"

	defaultBLEAuthMismatchMsg = "Hub is paired to another device. Hold BOOT for 3 s on the Hub to pair with this device."
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
	PairedBLE   bool   `json:"pairedBle,omitempty"`
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

// PoolSnapshot is returned by `GET /v1/usb/connections` and broadcast on `pool_state` events.
type PoolSnapshot struct {
	DebugSlotIndex int                  `json:"debugSlotIndex"`
	Slots          []SlotSnapshot       `json:"slots"`
	KnownTimers    []KnownHardwareTimer `json:"knownTimers"`
}

// USBEvent is pushed over `/v1/ws/usb` to keep all connected UI tabs synchronized.
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
	dbm           []float64
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
	authRejected         bool
	suspendedForSim      bool
	lastError            string
	lastStatus           map[string]any
	lastStatusAtMs       int64
	lastRealJsonStatusMs int64
	lastConfig           *firmware.TimerReadout
	sawRomBootloader     bool

	hubOwnFrames int
	hubLastDbm   []float64
	// Last time a throttled "hub_live" event (per-slot RSSI) was sent to browsers.
	hubLiveEmitMs int64
	hubHello      map[uint8]slotHello
	hubLive       map[uint8]slotLive
	waiters       []*replyWaiter

	// BLE zero-overhead Debug LIVE synthesizer (unwraps 100 Hz sweeps from 0xC5 0x60 windows).
	bleLiveMode   int
	bleSeqInit    bool
	bleLastSeq    uint8
	bleStaleCount int
	bleSweepN     uint64
	bleFloorQ4    [8]int16
	bleFloorSet   [8]bool
	blePeak       [8]int
	bleHits       [8]int
}

// Manager owns physical USB-C serial and Bluetooth LE Hub connections to SlapRF XIAO ESP32-C5 boards.
type Manager struct {
	cfg        ManagerConfig
	openPort   firmware.SerialOpener
	listFn     PortLister
	bleHostKey string

	mu              sync.RWMutex
	slots           [MaxUSBConnections]*usbSlot
	debugSlotIndex  int
	knownTimers     map[string]KnownHardwareTimer
	savedUSBTargets [MaxUSBConnections]string
	savedBLETargets [MaxUSBConnections]string
	bleOnly         bool
	activeMode      domain.TimingHardwareMode
	simMode         bool
	closed          bool

	subMu  sync.RWMutex
	nextID int
	subs   map[int]func(USBEvent)
}

func isValidBLEHostKey(s string) bool {
	if len(s) != 32 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func generateBLEHostKey() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "534C41505246424C45484F53544B4559"
	}
	return fmt.Sprintf("%032X", buf[:])
}

// NewManager creates a native Go USB/BLE manager wired to `realEngine` and `realHubRx`.
func NewManager(cfg ManagerConfig) *Manager {
	opener := cfg.OpenPort
	if opener == nil {
		opener = DefaultSerialOpener
	}
	lister := cfg.ListPorts
	if lister == nil {
		lister = DefaultListPorts
	}
	var hostKey string
	if cfg.Store != nil {
		var rawKey string
		if ok, err := cfg.Store.GetJSON(kvBLEHostKey, &rawKey); err == nil && ok {
			hostKey = strings.ToUpper(strings.TrimSpace(rawKey))
		}
	}
	if !isValidBLEHostKey(hostKey) {
		hostKey = generateBLEHostKey()
		if cfg.Store != nil {
			_ = cfg.Store.PutJSON(kvBLEHostKey, hostKey)
		}
	}

	m := &Manager{
		cfg:         cfg,
		openPort:    opener,
		listFn:      lister,
		bleHostKey:  hostKey,
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
		m.loadSavedTargetsFromStore(kvUSBTargetsKey, &m.savedUSBTargets, false)
		m.loadSavedTargetsFromStore(kvBLETargetsKey, &m.savedBLETargets, true)
	}
	if cfg.HubRx != nil {
		cfg.HubRx.SetOutboundSender(m.sendNetChannelsFrameToHub)
	}
	return m
}

func (m *Manager) loadSavedTargetsFromStore(key string, dst *[MaxUSBConnections]string, wantBLE bool) {
	if m.cfg.Store == nil {
		return
	}
	var saved map[string]string
	if ok, err := m.cfg.Store.GetJSON(key, &saved); err != nil || !ok {
		return
	}
	for k, portName := range saved {
		portName = strings.TrimSpace(portName)
		if portName == "" || IsBLEPortName(portName) != wantBLE {
			continue
		}
		var idx int
		if _, err := fmt.Sscanf(k, "%d", &idx); err == nil && idx >= 0 && idx < MaxUSBConnections {
			dst[idx] = portName
		}
	}
}

// BLEHostKey returns this host's persistent 32-hex-character Bluetooth Hub authentication key.
func (m *Manager) BLEHostKey() string {
	return m.bleHostKey
}

func (m *Manager) logf(format string, args ...any) {
	if m.cfg.Logf != nil {
		m.cfg.Logf(format, args...)
	}
}

// SetTransportMode switches port filtering between SlapRF (USB) (`bleOnly == false`) and
// SlapRF (Bluetooth) (`bleOnly == true`).
func (m *Manager) SetTransportMode(bleOnly bool) {
	m.mu.Lock()
	m.bleOnly = bleOnly
	sim := m.simMode
	m.mu.Unlock()
	SetBLEScanEnabled(!sim && bleOnly)
}

func (m *Manager) currentTargetModeLocked() domain.TimingHardwareMode {
	if m.cfg.Engine != nil {
		return domain.NormalizeTimingHardwareMode(m.cfg.Engine.TimingHardwareMode())
	}
	if m.bleOnly {
		return domain.HardwareModeSlapRFBLE
	}
	return domain.HardwareModeSlapRF
}

// Reconcile synchronizes active physical USB (`hw.usb_targets`) or Bluetooth (`hw.ble_targets`)
// connections whenever `simRunning` or `hwMode` changes, closing incompatible transport slots cleanly
// and restoring persisted targets for the newly active SlapRF transport mode.
func (m *Manager) Reconcile(simRunning bool, hwMode domain.TimingHardwareMode) {
	hwMode = domain.NormalizeTimingHardwareMode(hwMode)
	bleOnly := hwMode == domain.HardwareModeSlapRFBLE
	wantActive := !simRunning && domain.IsSlapRFMode(hwMode)
	SetBLEScanEnabled(!simRunning && bleOnly)

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	prevSim := m.simMode
	prevMode := m.activeMode
	m.simMode = simRunning
	m.bleOnly = bleOnly
	if !wantActive {
		m.activeMode = ""
		m.mu.Unlock()
		if prevMode != "" || (!prevSim && simRunning) {
			m.closeAllSlotsWithoutPersist()
			m.broadcastPoolState()
		}
		return
	}
	if prevMode == hwMode && !prevSim {
		m.mu.Unlock()
		return
	}
	m.activeMode = hwMode
	var targets [MaxUSBConnections]string
	if bleOnly {
		targets = m.savedBLETargets
	} else {
		targets = m.savedUSBTargets
	}
	m.mu.Unlock()

	m.closeAllSlotsWithoutPersist()
	if m.cfg.HubRx != nil {
		m.cfg.HubRx.Reset()
	}
	m.broadcastPoolState()

	for idx, portName := range targets {
		portName = strings.TrimSpace(portName)
		if portName == "" {
			continue
		}
		go func(slotIdx int, pName string) {
			if _, err := m.Connect(slotIdx, pName); err != nil {
				m.logf("[USB] Auto-restore %s on slot %d skipped: %v", pName, slotIdx, err)
			}
		}(idx, portName)
	}
}

func (m *Manager) closeAllSlotsWithoutPersist() {
	for i := 0; i < MaxUSBConnections; i++ {
		_ = m.closeSlotInternal(m.slots[i], true)
	}
}

// RestorePersistedConnections attempts to reopen previously connected physical USB or BLE ports when starting in Real mode.
func (m *Manager) RestorePersistedConnections(simMode bool) {
	m.mu.RLock()
	hwMode := m.currentTargetModeLocked()
	m.mu.RUnlock()
	m.Reconcile(simMode, hwMode)
}

// Close disconnects all open USB/BLE ports cleanly.
func (m *Manager) Close() {
	SetBLEScanEnabled(false)
	m.mu.Lock()
	m.closed = true
	m.mu.Unlock()
	for i := 0; i < MaxUSBConnections; i++ {
		_ = m.closeSlotInternal(m.slots[i], false)
	}
}

// Subscribe registers an event callback for `/v1/ws/usb` streaming.
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

// ListPorts returns ports matching the active SlapRF transport mode:
// - When `bleOnly == true` (`SlapRF (Bluetooth)`), only discovered `ble:<FP>` Hub ports are returned.
// - When `bleOnly == false` (`SlapRF (USB)`), only non-BLE serial ports are returned (Espressif USB
//   boards by default, or all USB serial adapters when `showAll == true`).
func (m *Manager) ListPorts(showAll bool) ([]PortInfo, error) {
	m.mu.RLock()
	bleOnly := m.bleOnly
	m.mu.RUnlock()
	if bleOnly {
		return m.ListBLEPorts()
	}
	return m.ListUSBPorts(showAll)
}

// ListUSBPorts enumerates non-BLE OS/Android USB serial ports without triggering a BLE scan,
// used by `SlapRF (USB)`, RotorHazard USB, and the Flasher (`?transport=usb`).
func (m *Manager) ListUSBPorts(showAll bool) ([]PortInfo, error) {
	bleSuppressDepth.Add(1)
	ports, err := m.listFn()
	bleSuppressDepth.Add(-1)
	if err != nil {
		return nil, err
	}
	filtered := make([]PortInfo, 0, len(ports))
	if showAll {
		for _, p := range ports {
			if !IsBLEPortName(p.Name) && (p.IsEspressif || p.IsUSB) {
				filtered = append(filtered, p)
			}
		}
		return filtered, nil
	}
	for _, p := range ports {
		if !IsBLEPortName(p.Name) && p.IsEspressif {
			filtered = append(filtered, p)
		}
	}
	return filtered, nil
}

// ListBLEPorts enumerates discovered SlapRF Bluetooth Hub ports (`ble:<FP>`).
func (m *Manager) ListBLEPorts() ([]PortInfo, error) {
	ports, err := m.listFn()
	if err != nil {
		return nil, err
	}
	filtered := make([]PortInfo, 0, len(ports))
	for _, p := range ports {
		if IsBLEPortName(p.Name) {
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

// SetSimMode suspends open physical USB/BLE ports while Simulation is ON and restores them when Simulation turns OFF.
func (m *Manager) SetSimMode(simRunning bool) {
	m.mu.RLock()
	hwMode := m.currentTargetModeLocked()
	m.mu.RUnlock()
	m.Reconcile(simRunning, hwMode)
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

// OpenRawPort opens an exclusive raw byte-stream handle to `portName` for the Flasher
// (`/v1/ws/usb-raw`), releasing any live `Manager` slot holding that port first.
func (m *Manager) OpenRawPort(portName string, baud int) (firmware.SerialPort, PortInfo, error) {
	portName = strings.TrimSpace(portName)
	if portName == "" {
		return nil, PortInfo{}, fmt.Errorf("missing USB port name")
	}
	if baud <= 0 {
		baud = 115200
	}

	var resolvedInfo PortInfo
	resolvedName := portName
	if ports, err := m.ListUSBPorts(true); err == nil {
		var espPorts []PortInfo
		foundExact := false
		for _, pi := range ports {
			if pi.IsEspressif {
				espPorts = append(espPorts, pi)
			}
			if strings.EqualFold(pi.Name, portName) {
				resolvedInfo = pi
				resolvedName = pi.Name
				foundExact = true
			}
		}
		if !foundExact && (strings.EqualFold(portName, "auto:espressif") || strings.HasPrefix(portName, "/dev/bus/usb/")) && len(espPorts) == 1 {
			resolvedInfo = espPorts[0]
			resolvedName = espPorts[0].Name
		}
	}
	if resolvedInfo.Name == "" {
		resolvedInfo.Name = resolvedName
	}

	releasedAny := false
	for _, slot := range m.slots {
		slot.mu.Lock()
		held := (slot.port != nil || slot.reconnecting) &&
			(strings.EqualFold(slot.portName, portName) || strings.EqualFold(slot.portName, resolvedName))
		slot.mu.Unlock()
		if held {
			_ = m.closeSlotInternal(slot, false)
			releasedAny = true
		}
	}
	if releasedAny {
		m.broadcastPoolState()
	}

	p, err := m.openPort(resolvedName, baud)
	if err != nil {
		return nil, resolvedInfo, err
	}
	return p, resolvedInfo, nil
}
