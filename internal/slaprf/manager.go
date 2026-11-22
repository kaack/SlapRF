package slaprf

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"slaprf/internal/firmware"
	"slaprf/internal/ingest"
	"slaprf/internal/storage"
	"slaprf/internal/tracker"
)

const (
	pktRecordSep       byte = 0x1E
	configBlockLen          = 160
	latestFirmwareText      = "0.4.0"
)

var configMagic = []byte("SLAPRF02")

// SlotSnapshot describes the live state of one SlapRF connection slot (0..2).
type SlotSnapshot struct {
	SlotIndex       int                    `json:"slotIndex"`
	Connected       bool                   `json:"connected"`
	Connecting      bool                   `json:"connecting,omitempty"`
	ConnectStatus   string                 `json:"connectStatus,omitempty"`
	PortName        string                 `json:"portName,omitempty"`
	Probing         bool                   `json:"probing"`
	Reconnecting    bool                   `json:"reconnecting"`
	ReconnectTry    int                    `json:"reconnectAttempt"`
	ReconnectFailed bool                   `json:"reconnectFailed"`
	LastError       string                 `json:"lastError,omitempty"`
	LastStatus      map[string]any         `json:"lastStatus,omitempty"`
	LastConfig      *firmware.TimerReadout `json:"lastConfig,omitempty"`
}

// PoolSnapshot is returned by `/v1/<transport>/connections` and broadcast on `pool_state` events.
type PoolSnapshot struct {
	DebugSlotIndex int                  `json:"debugSlotIndex"`
	Slots          []SlotSnapshot       `json:"slots"`
	KnownTimers    []KnownHardwareTimer `json:"knownTimers"`
}

// Event is pushed over `/v1/ws/<transport>` to keep all connected UI tabs synchronized.
type Event struct {
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

// Config configures a transport-specific SlapRF timing device session manager.
type Config struct {
	Transport        Transport
	Timers           *KnownTimerRegistry
	Engine           *tracker.Engine
	HubRx            *ingest.HubFrameDecoder
	SkipHubOutbound  bool
	Store            *storage.BoltStore
	Logf             func(string, ...any)
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

type connSlot struct {
	index int

	mu                   sync.Mutex
	portName             string
	port                 firmware.SerialPort
	writeMu              sync.Mutex
	openSeq              uint64
	openCancel           context.CancelFunc
	cancel               context.CancelFunc
	doneCh               chan struct{}
	connecting           bool
	connectStatus        string
	probing              bool
	reconnecting         bool
	reconnectAttempt     int
	reconnectFailed      bool
	authRejected         bool
	lastError            string
	lastStatus           map[string]any
	lastStatusAtMs       int64
	lastRealJsonStatusMs int64
	lastConfig           *firmware.TimerReadout
	sawRomBootloader     bool

	hubOwnFrames  int
	hubLastDbm    []float64
	hubLiveEmitMs int64
	hubHello      map[uint8]slotHello
	hubLive       map[uint8]slotLive
	waiters       []*replyWaiter

	// Zero-overhead Debug LIVE synthesizer (unwraps 100 Hz sweeps from 0xC5 0x60 binary windows).
	synthLiveMode   int
	synthSeqInit    bool
	synthLastSeq    uint8
	synthStaleCount int
	synthSweepN     uint64
	synthFloorQ4    [8]int16
	synthFloorSet   [8]bool
	synthPeak       [8]int
	synthHits       [8]int
}

// Manager manages SlapRF timing device connections over a single `Transport` (e.g. USB serial,
// Bluetooth LE, or future TCP/UDP network), speaking the unified SlapRF wire and console protocol.
type Manager struct {
	cfg    Config
	tr     Transport
	traits Traits
	timers *KnownTimerRegistry

	mu             sync.RWMutex
	slots          [MaxConnections]*connSlot
	debugSlotIndex int
	savedTargets   [MaxConnections]string
	active         bool
	activeSet      bool
	simMode        bool
	closed         bool

	subMu  sync.RWMutex
	nextID int
	subs   map[int]func(Event)
}

// NewManager constructs a SlapRF session manager bound to `cfg.Transport`.
func NewManager(cfg Config) *Manager {
	if cfg.Transport == nil {
		panic("slaprf.NewManager requires a non-nil Transport")
	}
	timers := cfg.Timers
	if timers == nil {
		timers = NewKnownTimerRegistry(cfg.Store)
	}
	traits := cfg.Transport.Traits()
	if traits.ProbeTimeout <= 0 {
		traits.ProbeTimeout = 1200_000_000 // 1200ms
	}
	if traits.ProbeReplyTimeout <= 0 {
		traits.ProbeReplyTimeout = 450_000_000 // 450ms
	}
	if traits.DefaultSweepHz <= 0 {
		traits.DefaultSweepHz = 100
	}
	if traits.DefaultSweepUs <= 0 {
		traits.DefaultSweepUs = 6100
	}
	if traits.DefaultSweepUsMax <= 0 {
		traits.DefaultSweepUsMax = 6650
	}
	if traits.DefaultSweepBudgetUs <= 0 {
		traits.DefaultSweepBudgetUs = 7000
	}

	m := &Manager{
		cfg:    cfg,
		tr:     cfg.Transport,
		traits: traits,
		timers: timers,
		subs:   make(map[int]func(Event)),
	}
	for i := 0; i < MaxConnections; i++ {
		m.slots[i] = &connSlot{
			index:    i,
			hubHello: make(map[uint8]slotHello),
			hubLive:  make(map[uint8]slotLive),
		}
	}
	m.loadSavedTargets()

	timers.OnForget(func(fp string) {
		canon := m.tr.CanonicalTarget(fp)
		if canon != "" {
			m.removeSavedTargetOnly(canon)
		}
	})
	timers.OnChange(func() {
		m.broadcastPoolState()
	})

	if cfg.HubRx != nil && !cfg.SkipHubOutbound {
		cfg.HubRx.SetOutboundSender(m.SendNetChannelsFrame)
	}
	return m
}

// Transport returns the underlying physical transport implementation.
func (m *Manager) Transport() Transport {
	return m.tr
}

// Timers returns the shared `KnownTimerRegistry`.
func (m *Manager) Timers() *KnownTimerRegistry {
	return m.timers
}

// HostAuthKey returns this host's persistent 32-hex-character authentication key.
func (m *Manager) HostAuthKey() string {
	return m.timers.HostAuthKey()
}

func (m *Manager) logf(format string, args ...any) {
	if m.cfg.Logf != nil {
		m.cfg.Logf(format, args...)
	}
}

func (m *Manager) loadSavedTargets() {
	if m.cfg.Store == nil || m.traits.PersistTargetsKey == "" {
		return
	}
	var saved map[string]string
	if ok, err := m.cfg.Store.GetJSON(m.traits.PersistTargetsKey, &saved); err != nil || !ok {
		return
	}
	for k, rawTarget := range saved {
		norm, err := m.tr.ValidateTarget(rawTarget)
		if err != nil || norm == "" {
			continue
		}
		var idx int
		if _, sErr := fmt.Sscanf(k, "%d", &idx); sErr == nil && idx >= 0 && idx < MaxConnections {
			m.savedTargets[idx] = norm
		}
	}
}

// SetActive activates or suspends this transport manager. When transitioning to `active == true`
// (`!simRunning` and matching hardware mode), persisted targets for this transport are restored;
// when transitioning to `active == false`, open slots are closed cleanly without wiping saved targets.
func (m *Manager) SetActive(active bool, simMode bool) {
	m.SetActiveWithRestore(active, simMode, true)
}

// SetActiveWithRestore activates or suspends this transport manager, optionally restoring persisted
// targets when `restoreSaved` is true (e.g., on server boot or simulation toggle, but false when
// the user switches timing hardware modes in the dropdown).
func (m *Manager) SetActiveWithRestore(active bool, simMode bool, restoreSaved bool) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	wasInit := m.activeSet
	prevActive := m.active
	m.activeSet = true
	m.active = active
	m.simMode = simMode
	targets := m.savedTargets
	m.mu.Unlock()

	if !active {
		if prevActive || !wasInit {
			m.closeAllSlotsWithoutPersist()
			m.broadcastPoolState()
		}
		return
	}
	if wasInit && prevActive {
		return
	}

	m.closeAllSlotsWithoutPersist()
	m.broadcastPoolState()

	if !restoreSaved {
		return
	}
	for idx, target := range targets {
		target = strings.TrimSpace(target)
		if target == "" {
			continue
		}
		go func(slotIdx int, t string) {
			if _, err := m.Connect(slotIdx, t); err != nil {
				m.logf("[SlapRF:%s] Auto-restore %s on slot %d skipped: %v", m.tr.Name(), t, slotIdx, err)
			}
		}(idx, target)
	}
}

// SetSimMode toggles simulation suspension while keeping this transport selected.
func (m *Manager) SetSimMode(simMode bool) {
	m.SetActive(!simMode, simMode)
}

func (m *Manager) closeAllSlotsWithoutPersist() {
	for i := 0; i < MaxConnections; i++ {
		_ = m.closeSlotInternal(m.slots[i], true)
	}
}

// ReleasePort closes any slot currently holding or reconnecting to `portNames` without clearing
// persisted targets (used before opening a raw ROM bootloader connection on the same USB port).
func (m *Manager) ReleasePort(portNames ...string) bool {
	released := false
	for _, slot := range m.slots {
		slot.mu.Lock()
		held := false
		if slot.port != nil || slot.connecting || slot.reconnecting {
			for _, name := range portNames {
				if name != "" && strings.EqualFold(slot.portName, name) {
					held = true
					break
				}
			}
		}
		slot.mu.Unlock()
		if held {
			_ = m.closeSlotInternal(slot, false)
			released = true
		}
	}
	if released {
		m.broadcastPoolState()
	}
	return released
}

// Close disconnects all open slots cleanly.
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	m.active = false
	m.mu.Unlock()
	for i := 0; i < MaxConnections; i++ {
		_ = m.closeSlotInternal(m.slots[i], false)
	}
}

// Subscribe registers an event callback for `/v1/ws/<transport>` streaming.
func (m *Manager) Subscribe(fn func(Event)) func() {
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

func (m *Manager) emit(ev Event) {
	m.subMu.RLock()
	list := make([]func(Event), 0, len(m.subs))
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
	m.emit(Event{
		Type:      "pool_state",
		SlotIndex: snap.DebugSlotIndex,
		Pool:      &snap,
	})
}

// ListPorts discovers available endpoints on this manager's `Transport`.
func (m *Manager) ListPorts(ctx context.Context, showAll bool) ([]PortInfo, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	return m.tr.Discover(ctx, showAll)
}

// SetDebugSlot selects whether `#/debug` inspects Slot 0 (main Hub) or Slot 1 (secondary standalone timer).
func (m *Manager) SetDebugSlot(slotIndex int) {
	if slotIndex != 1 {
		slotIndex = 0
	}
	m.mu.Lock()
	m.debugSlotIndex = slotIndex
	m.mu.Unlock()
	m.broadcastPoolState()
}

// Snapshot returns the current `PoolSnapshot` for this transport.
func (m *Manager) Snapshot() PoolSnapshot {
	m.mu.RLock()
	dbg := m.debugSlotIndex
	m.mu.RUnlock()

	slots := make([]SlotSnapshot, MaxConnections)
	for i := 0; i < MaxConnections; i++ {
		s := m.slots[i]
		s.mu.Lock()
		var stCopy map[string]any
		if s.lastStatus != nil {
			stCopy = make(map[string]any, len(s.lastStatus))
			for k, v := range s.lastStatus {
				stCopy[k] = v
			}
		}
		var cfgCopy *firmware.TimerReadout
		if s.lastConfig != nil {
			c := *s.lastConfig
			cfgCopy = &c
		}
		slots[i] = SlotSnapshot{
			SlotIndex:       i,
			Connected:       s.port != nil,
			Connecting:      s.connecting,
			ConnectStatus:   s.connectStatus,
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
		KnownTimers:    m.timers.SnapshotFor(m.traits.MarksBLEPaired),
	}
}
