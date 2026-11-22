package tracker

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/dsp"
)

// timerOfflineAfter marks a gate timer offline when no telemetry frame has arrived for this long.
const timerOfflineAfter = 2 * time.Second

const (
	maxStoredLaps      = 5000 // A full practice day for 8 pilots
	maxStoredCrossings = 2000 // Covers full 15-minute (900 s) multi-gate Signals chart buffer
	maxStoredFiltered  = 2000
	// Detector-level debounce only; the user-facing gate cool-down is a TimingRule.
	detectorDebounceUs = 300_000
)

// EventSubscriber receives real-time callbacks for telemetry frames, gate crossings, and lap completions.
type EventSubscriber interface {
	OnTelemetryFrame(frame domain.TimerTelemetryFrame)
	OnGateCrossing(event domain.GateCrossingEvent)
	OnDetectionFiltered(f domain.FilteredDetection)
	OnLapCompleted(lap domain.LapRecord, summaries []domain.PilotTrackSummary)
	OnConfigUpdated(pilots []domain.PilotSlot, gates []domain.TrackGate)
}

// PassthroughSubscriber is an optional interface implemented by external hardware protocol bridges
// (such as the LapRF emulator) that should continue receiving Start/Finish gate crossings even when
// SlapRF's local practice session timing is paused ("Timing off" pure passthrough mode).
type PassthroughSubscriber interface {
	OnPassthroughCrossing(event domain.GateCrossingEvent)
}

// ArmStateSubscriber is an optional interface implemented by external hardware clients (such as
// RotorHazard) that need immediate notification when SetRaceArmed toggles pass recording.
type ArmStateSubscriber interface {
	OnArmChanged(armed bool)
}

// pilotProgress tracks where a pilot is on the track between accepted crossings.
type pilotProgress struct {
	lastGateID     uint8  // 0 = no accepted crossing in the current run
	lastGateTimeUs uint64 // timestamp of that crossing
	lapStartUs     uint64 // 0 = waiting for the first start/finish crossing
	currentSectors []domain.SectorSplit
}

// Engine is the central multi-gate timing and sector analytics coordinator.
type Engine struct {
	mu              sync.RWMutex
	isSimEngine     bool
	bootTime        time.Time
	virtualOffsetUs atomic.Uint64
	raceArmed       bool
	rules          domain.TimingRules
	pilots         []domain.PilotSlot
	gates          []domain.TrackGate
	detected       map[uint8]*domain.DetectedTimer // key: physical timerId (1..16)
	detectors      map[detKey]*dsp.ChannelDetector // key: (gateId, slotIdx)
	autoCalib      map[detKey]*autoCalibState      // key: (gateId, slotIdx) rolling pass-waveform calibration
	passProfiles   map[detKey]*pilotPassProfile    // key: (gateId, slotIdx) learned pass width & area profile
	progress       map[int]*pilotProgress          // key: 1-based slotIdx
	lastAcceptedUs map[string]uint64               // key: "gateId:slotIdx" -> last accepted crossing
	laps           []domain.LapRecord
	crossings      []domain.GateCrossingEvent
	filtered       []domain.FilteredDetection
	overallBestSec map[string]float64              // key: gate pair "from>to" -> fastest split across all pilots
	pilotBestSec   map[string]float64              // key: "slotIdx:from>to" -> pilot's personal best split
	sectorHistory  map[string][]domain.SectorSplit // key: "slotIdx:from>to"
	nextEventID    uint64
	nextLapID      uint64
	passingNumbers map[uint8]uint32 // per-gate passing counter
	usbLabels      map[string]string
	deletedSpokeFp map[string]bool
	raceState      domain.RaceTournamentState
	editingRaceID  string
	eventState     domain.EventManagerState
	practiceState  domain.PracticeManagerState
	nextRaceSeq        uint64
	practiceSnap       domain.PracticeSnapshot
	timingHardwareMode     domain.TimingHardwareMode
	savedSlapRFGates       []domain.TrackGate
	savedSlapRFTimers      []domain.DetectedTimer
	savedSlapRFBLEGates    []domain.TrackGate
	savedSlapRFBLETimers   []domain.DetectedTimer
	hasSavedSlapRFBLEState bool
	savedLapRFGates       []domain.TrackGate
	savedLapRFTimers      []domain.DetectedTimer
	hasSavedLapRFState    bool
	savedLapRFUSBGates    []domain.TrackGate
	savedLapRFUSBTimers   []domain.DetectedTimer
	hasSavedLapRFUSBState bool
	savedRHGates          []domain.TrackGate
	savedRHTimers       []domain.DetectedTimer
	hasSavedRHState     bool
	savedRHUSBGates     []domain.TrackGate
	savedRHUSBTimers    []domain.DetectedTimer
	hasSavedRHUSBState  bool
	rhDebugStreamTimers    map[uint8]bool
	subscribers            []EventSubscriber
}

// NewEngine creates the simulation engine with the default course and pilot slots. It follows
// the same Hub/Spoke model as real hardware: the simulated Hub is a collector dongle registered
// as a timer with no gate, and simulated Spokes time every gate (the first one is start/finish).
func NewEngine() *Engine {
	e := &Engine{
		isSimEngine:    true,
		bootTime:       time.Now(),
		raceArmed:      true,
		rules:          domain.DefaultTimingRules(),
		pilots:         domain.DefaultPilotSlots(),
		gates:          domain.DefaultTrackGates(),
		detected:       make(map[uint8]*domain.DetectedTimer),
		detectors:      make(map[detKey]*dsp.ChannelDetector),
		passingNumbers: make(map[uint8]uint32),
		raceState:      newDefaultRaceState(),
	}
	e.seedSimTimersLocked()
	e.resetSessionLocked()
	e.initDetectorsLocked()
	e.ensureEventStateInitializedLocked()
	e.ensurePracticeStateInitializedLocked()
	return e
}

// seedSimTimersLocked registers the default simulated timers: one Spoke per default gate plus
// the gate-less simulated Hub. Replaces `e.detected`.
func (e *Engine) seedSimTimersLocked() {
	var defaultRSSI [domain.MaxPilotPoolSize]float32
	for i := range defaultRSSI {
		defaultRSSI[i] = -92.0
	}
	for i := range e.gates {
		hasNeg := false
		for _, v := range e.gates[i].LastRSSI {
			if v < 0 {
				hasNeg = true
				break
			}
		}
		if !hasNeg {
			e.gates[i].LastRSSI = defaultRSSI
		}
	}
	e.detected = make(map[uint8]*domain.DetectedTimer)
	for _, g := range e.gates {
		if g.AssignedTimerID == 0 {
			continue
		}
		c := g.Color
		if c == "" {
			c = domain.DefaultTimerColor(g.AssignedTimerID)
		}
		e.detected[g.AssignedTimerID] = &domain.DetectedTimer{
			TimerID:         g.AssignedTimerID,
			TimerLabel:      g.TimerLabel,
			Color:           c,
			FirmwareVersion: g.FirmwareVersion,
			Fingerprint:     newFingerprintHex(),
			BatteryMv:       g.BatteryMv,
			BatteryPct:      g.BatteryPct,
			NoiseFloorDbm:   g.NoiseFloorDbm,
			LastRSSI:        g.LastRSSI,
			Online:          g.Online,
			LastSeenAt:      g.LastSeenAt,
		}
	}
	e.detected[domain.SimHubTimerID] = &domain.DetectedTimer{
		TimerID:         domain.SimHubTimerID,
		TimerLabel:      domain.DefaultSimHubLabel,
		Color:           domain.DefaultGateColors[4%len(domain.DefaultGateColors)],
		IsHub:           true,
		FirmwareVersion: domain.LatestFirmwareVersion,
		Fingerprint:     newFingerprintHex(),
		BatteryMv:       4200, // USB powered
		BatteryPct:      100,
		NoiseFloorDbm:   -92.0,
		LastRSSI:        defaultRSSI,
		Online:          true,
		LastSeenAt:      time.Now(),
	}
}

// NewRealEngine creates a clean real-world timing engine with no simulated timers,
// no pre-populated fake gates, and clean pilot slots ready for hardware or external LapRF clients.
func NewRealEngine() *Engine {
	e := &Engine{
		bootTime:       time.Now(),
		raceArmed:      true,
		rules:          domain.DefaultTimingRules(),
		pilots:         domain.DefaultRealPilotSlots(),
		gates:          []domain.TrackGate{},
		detected:       make(map[uint8]*domain.DetectedTimer),
		detectors:      make(map[detKey]*dsp.ChannelDetector),
		passingNumbers: make(map[uint8]uint32),
		raceState:      newDefaultRaceState(),
	}
	e.resetSessionLocked()
	e.initDetectorsLocked()
	e.ensureEventStateInitializedLocked()
	e.ensurePracticeStateInitializedLocked()
	return e
}

func (e *Engine) initDetectorsLocked() {
	for _, gate := range e.gates {
		for _, pilot := range e.pilots {
			key := detKey{gate.GateID, pilot.SlotIndex}
			if _, exists := e.detectors[key]; !exists {
				e.detectors[key] = dsp.NewChannelDetector(gate.GateID, pilot.SlotIndex)
			}
		}
	}
}

// detKey identifies one (gate, pilot slot) RSSI detector. A struct key keeps the per-sample
// detector lookup allocation-free (it runs for every pilot of every sample: ~11k/s at 100 Hz).
type detKey struct {
	gateID    uint8
	slotIndex int
}

func detectorKey(gateID uint8, slotIndex int) string {
	return fmt.Sprintf("%d:%d", gateID, slotIndex)
}

// Subscribe registers an EventSubscriber for real-time telemetry and crossing notifications.
func (e *Engine) Subscribe(sub EventSubscriber) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.subscribers = append(e.subscribers, sub)
}

// NowUs returns the monotonic microsecond clock since engine boot (used as RTC for LapRF),
// including any fast-simulation virtual clock offset applied via AdvanceVirtualClockUs.
func (e *Engine) NowUs() uint64 {
	return uint64(time.Since(e.bootTime).Microseconds()) + e.virtualOffsetUs.Load()
}

// AdvanceVirtualClockUs advances the monotonic engine clock by `deltaUs` microseconds
// so accelerated simulation steps produce realistic lap times, sector splits, and heat clocks.
func (e *Engine) AdvanceVirtualClockUs(deltaUs uint64) {
	if deltaUs > 0 {
		e.virtualOffsetUs.Add(deltaUs)
	}
}

// BackdateBootTime shifts the engine boot time earlier so pre-warmed simulator laps
// align seamlessly with real-time monotonic timestamps when live ticking starts.
func (e *Engine) BackdateBootTime(d time.Duration) {
	e.mu.Lock()
	e.bootTime = time.Now().Add(-d)
	e.virtualOffsetUs.Store(0)
	e.mu.Unlock()
}

// SyncBootTimes aligns the monotonic bootTime of all provided engines to the earliest effective
// bootTime among them so NowUs() stays monotonic across simulated and real-world engines.
func SyncBootTimes(engines ...*Engine) {
	var earliest time.Time
	for _, e := range engines {
		if e == nil {
			continue
		}
		e.mu.RLock()
		bt := e.bootTime
		offUs := e.virtualOffsetUs.Load()
		e.mu.RUnlock()
		if !bt.IsZero() {
			eff := bt.Add(-time.Duration(offUs) * time.Microsecond)
			if earliest.IsZero() || eff.Before(earliest) {
				earliest = eff
			}
		}
	}
	if earliest.IsZero() {
		return
	}
	for _, e := range engines {
		if e == nil {
			continue
		}
		e.mu.Lock()
		e.bootTime = earliest
		e.virtualOffsetUs.Store(0)
		e.mu.Unlock()
	}
}

// SetRaceArmed enables or pauses lap/crossing detection (synced with LapRF STATE_CTRL 0xda08).
func (e *Engine) SetRaceArmed(armed bool) {
	e.mu.Lock()
	changed := e.raceArmed != armed
	e.raceArmed = armed
	var subs []EventSubscriber
	if changed {
		subs = append([]EventSubscriber(nil), e.subscribers...)
	}
	e.mu.Unlock()
	for _, s := range subs {
		if as, ok := s.(ArmStateSubscriber); ok {
			as.OnArmChanged(armed)
		}
	}
}

// IsRaceArmed returns true if the timer is actively scoring crossings.
func (e *Engine) IsRaceArmed() bool {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.raceArmed
}

// PilotCount returns the current number of pilot rows in the engine roster.
func (e *Engine) PilotCount() int {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return len(e.pilots)
}

// Rules returns the active timing guardrails.
func (e *Engine) Rules() domain.TimingRules {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.rules
}

// SetRules replaces the timing guardrails (values are clamped) and returns what was applied.
func (e *Engine) SetRules(r domain.TimingRules) domain.TimingRules {
	r = r.Normalized()
	e.mu.Lock()
	e.rules = r
	hasActivePractice := false
	if !e.isLiveRaceHeatActiveLocked() && e.practiceState.ActiveSessionID != "" {
		if sess := e.findPracticeSessionLocked(e.practiceState.ActiveSessionID); sess != nil {
			cp := r
			sess.Rules = &cp
			hasActivePractice = true
		}
	}
	if isRaceOngoing(&e.raceState) || (!hasActivePractice && isRaceTrackEditable(&e.raceState)) {
		cp := r
		e.raceState.Rules = &cp
		for i := range e.eventState.Races {
			if e.eventState.Races[i].RaceID == e.raceState.RaceID && isRaceTrackEditable(&e.eventState.Races[i]) {
				cp2 := r
				e.eventState.Races[i].Rules = &cp2
			}
		}
	}
	e.mu.Unlock()
	return r
}

// hasPilotCallsignLocked reports whether any pilot in e.pilots (other than excludeSlot) already uses callsign (case-insensitive, trimmed).
func (e *Engine) hasPilotCallsignLocked(callsign string, excludeSlot int) bool {
	trimmed := strings.TrimSpace(callsign)
	if trimmed == "" {
		return false
	}
	for _, p := range e.pilots {
		if excludeSlot > 0 && p.SlotIndex == excludeSlot {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(p.Callsign), trimmed) {
			return true
		}
	}
	return false
}

// nextDefaultPilotNameLocked generates "Pilot N" starting at startNum without colliding with any existing callsign.
func (e *Engine) nextDefaultPilotNameLocked(startNum int) string {
	n := startNum
	if n < 1 {
		n = 1
	}
	for {
		candidate := fmt.Sprintf("Pilot %d", n)
		if !e.hasPilotCallsignLocked(candidate, 0) {
			return candidate
		}
		n++
	}
}

// UpdatePilotSlot updates a pilot slot's frequency, threshold, gain, or enabled state (e.g., from LapRF RF_SETUP 0xda01).
// It enforces case-insensitive callsign uniqueness, enforces that at most 8 pilots (`domain.MaxPilotSlots`) can be enabled
// at once, and never auto-assigns a channel: if two enabled pilots would share the same channel, the conflicting channel is
// blanked (`Channel = 0`, `FrequencyMHz = 0`) so the race organizer explicitly chooses the channel.
func (e *Engine) UpdatePilotSlot(updated domain.PilotSlot) error {
	e.mu.Lock()
	targetIdx := -1
	for i := range e.pilots {
		if e.pilots[i].SlotIndex == updated.SlotIndex {
			targetIdx = i
			break
		}
	}
	if targetIdx >= 0 {
		updated.Callsign = strings.TrimSpace(updated.Callsign)
		if updated.Callsign == "" {
			updated.Callsign = e.pilots[targetIdx].Callsign
		}
		if e.hasPilotCallsignLocked(updated.Callsign, updated.SlotIndex) {
			e.mu.Unlock()
			return fmt.Errorf("pilot callsign %q already exists", updated.Callsign)
		}
		updated.PhoneticName = strings.TrimSpace(updated.PhoneticName)
		if updated.Color == "" {
			updated.Color = e.pilots[targetIdx].Color
		}
		if updated.EnterThreshold == 0 {
			updated.EnterThreshold = e.pilots[targetIdx].EnterThreshold
		} else {
			updated.EnterThreshold = clampDbm(updated.EnterThreshold)
		}
		if updated.ExitThreshold == 0 {
			updated.ExitThreshold = updated.EnterThreshold - defaultExitGapDb
		}
		updated.ExitThreshold = clampExitDbm(updated.ExitThreshold, updated.EnterThreshold)
		if updated.LapRFThreshold == 0 {
			updated.LapRFThreshold = e.pilots[targetIdx].LapRFThreshold
			if updated.LapRFThreshold == 0 {
				updated.LapRFThreshold = domain.DefaultLapRFThreshold
			}
		} else {
			updated.LapRFThreshold = clampLapRFThreshold(updated.LapRFThreshold)
		}
		if updated.RHEnterThreshold == 0 {
			updated.RHEnterThreshold = e.pilots[targetIdx].RHEnterThreshold
			if updated.RHEnterThreshold == 0 {
				updated.RHEnterThreshold = dbmToRHEnter(updated.EnterThreshold)
			}
		} else {
			updated.RHEnterThreshold = clampRHEnterThreshold(updated.RHEnterThreshold)
		}
		if updated.RHExitThreshold == 0 {
			if e.pilots[targetIdx].RHExitThreshold > 0 {
				updated.RHExitThreshold = e.pilots[targetIdx].RHExitThreshold
			} else if updated.ExitThreshold != 0 {
				updated.RHExitThreshold = dbmToRHExit(updated.ExitThreshold, updated.RHEnterThreshold)
			} else {
				updated.RHExitThreshold = updated.RHEnterThreshold - defaultRHExitGap
			}
		}
		updated.RHExitThreshold = clampRHExitThreshold(updated.RHExitThreshold, updated.RHEnterThreshold)
		if updated.AttenuationGain == 0 {
			updated.AttenuationGain = e.pilots[targetIdx].AttenuationGain
			if updated.AttenuationGain == 0 {
				updated.AttenuationGain = domain.DefaultLapRFGain
			}
		} else if updated.AttenuationGain > 63 {
			updated.AttenuationGain = 63
		}
		if updated.MultiGPPilotID == 0 {
			updated.MultiGPPilotID = e.pilots[targetIdx].MultiGPPilotID
		}
		if updated.MultiGPUserName == "" {
			updated.MultiGPUserName = e.pilots[targetIdx].MultiGPUserName
		}
		if updated.Channel == 0 {
			updated.FrequencyMHz = 0
		} else {
			if updated.Band == 0 {
				updated.Band = domain.BandRaceband
			}
			if freq := domain.FrequencyForBandChannel(updated.Band, updated.Channel); freq > 0 {
				updated.FrequencyMHz = freq
			}
		}
		if e.isLiveRaceHeatActiveLocked() || e.raceState.Mode == domain.ModeRace {
			// While a race heat is actively armed/running, RF channel & enabled flags are controlled
			// by Race Control per heat; preserve active heat slot activation while updating callsign,
			// phoneticName, color, and thresholds.
			updated.Enabled = e.pilots[targetIdx].Enabled
			updated.Band = e.pilots[targetIdx].Band
			updated.Channel = e.pilots[targetIdx].Channel
			updated.FrequencyMHz = e.pilots[targetIdx].FrequencyMHz
			for i := range e.practiceSnap.Pilots {
				if e.practiceSnap.Pilots[i].SlotIndex == updated.SlotIndex {
					e.practiceSnap.Pilots[i].Callsign = updated.Callsign
					e.practiceSnap.Pilots[i].PhoneticName = updated.PhoneticName
					e.practiceSnap.Pilots[i].Color = updated.Color
					e.practiceSnap.Pilots[i].EnterThreshold = updated.EnterThreshold
					e.practiceSnap.Pilots[i].ExitThreshold = updated.ExitThreshold
					e.practiceSnap.Pilots[i].LapRFThreshold = updated.LapRFThreshold
					e.practiceSnap.Pilots[i].RHEnterThreshold = updated.RHEnterThreshold
					e.practiceSnap.Pilots[i].RHExitThreshold = updated.RHExitThreshold
					e.practiceSnap.Pilots[i].AttenuationGain = updated.AttenuationGain
				}
			}
		} else if updated.Enabled {
			wasEnabled := e.pilots[targetIdx].Enabled
			enabledCount := 0
			usedFreq := make(map[uint16]bool)
			for i, p := range e.pilots {
				if i == targetIdx || !p.Enabled {
					continue
				}
				enabledCount++
				if p.Channel > 0 {
					fk := p.FrequencyMHz
					if fk == 0 {
						fk = domain.FrequencyForBandChannel(p.Band, p.Channel)
					}
					if fk > 0 {
						usedFreq[fk] = true
					}
				}
			}
			// Enforce max 8 enabled pilots at a time and prevent duplicate active RF frequencies
			updFreq := updated.FrequencyMHz
			if updFreq == 0 && updated.Channel > 0 {
				updFreq = domain.FrequencyForBandChannel(updated.Band, updated.Channel)
			}
			if enabledCount >= domain.MaxPilotSlots {
				updated.Enabled = false
			} else if updated.Channel > 0 && updFreq > 0 && usedFreq[updFreq] {
				if !wasEnabled {
					// Newly enabled pilot had a frequency already taken by an active pilot:
					// blank out the newly enabled pilot's channel so the organizer picks one.
					updated.Channel = 0
					updated.FrequencyMHz = 0
				} else {
					// Organizer explicitly assigned `updated.Channel` to this active pilot:
					// blank out the other active pilot who was on that frequency so they don't collide.
					for i := range e.pilots {
						if i == targetIdx || !e.pilots[i].Enabled || e.pilots[i].Channel == 0 {
							continue
						}
						otherFreq := e.pilots[i].FrequencyMHz
						if otherFreq == 0 {
							otherFreq = domain.FrequencyForBandChannel(e.pilots[i].Band, e.pilots[i].Channel)
						}
						if otherFreq == updFreq {
							e.pilots[i].Channel = 0
							e.pilots[i].FrequencyMHz = 0
						}
					}
				}
			}
		}
		e.pilots[targetIdx] = updated
	}
	e.syncGlobalPilotsToOpenEventsLocked(nil, 0)
	e.syncGlobalPilotsToPracticeSessionsLocked(0)
	if !e.isLiveRaceHeatActiveLocked() && e.raceState.Mode != domain.ModeRace {
		e.syncActivePracticePilotsFromEngineLocked()
	}
	if e.raceState.Generated {
		e.resolveActiveTournamentLocked()
	} else {
		e.syncActiveRaceToEventLocked()
	}
	raceSnap := cloneRaceState(e.raceState)
	practiceSnap := clonePracticeManagerState(e.practiceState)
	pilotsCopy := append([]domain.PilotSlot(nil), e.pilots...)
	gatesCopy := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilotsCopy, gatesCopy)
	}
	e.notifyRaceUpdated(raceSnap, nil, subs)
	e.notifyPracticeUpdated(practiceSnap, subs)
	return nil
}

// ApplyLapRFSetup atomically applies an 8-slot RF configuration pushed by an external LapRF client
// without intermediate slot-to-slot channel collisions, and notifies all subscribers once.
func (e *Engine) ApplyLapRFSetup(slotMap map[int]domain.PilotSlot) {
	e.mu.Lock()
	enabledCount := 0
	for i := range e.pilots {
		slotIdx := e.pilots[i].SlotIndex
		if updated, ok := slotMap[slotIdx]; ok && slotIdx >= 1 && slotIdx <= domain.MaxPilotSlots {
			if updated.Callsign == "" {
				updated.Callsign = e.pilots[i].Callsign
			}
			if updated.PhoneticName == "" {
				updated.PhoneticName = e.pilots[i].PhoneticName
			}
			if updated.Color == "" {
				updated.Color = e.pilots[i].Color
			}
			if updated.Channel == 0 || updated.FrequencyMHz == 0 {
				if updated.FrequencyMHz == 0 && updated.Channel > 0 {
					updated.FrequencyMHz = domain.FrequencyForBandChannel(updated.Band, updated.Channel)
				}
				if updated.FrequencyMHz == 0 {
					updated.Channel = 0
					updated.Enabled = false
				}
			}
			if updated.Enabled {
				enabledCount++
			}
			e.pilots[i] = updated
		} else if slotIdx > domain.MaxPilotSlots && e.pilots[i].Enabled {
			if enabledCount >= domain.MaxPilotSlots {
				e.pilots[i].Enabled = false
			} else {
				enabledCount++
			}
		}
	}
	if !e.isLiveRaceHeatActiveLocked() && e.raceState.Mode != domain.ModeRace {
		e.syncActivePracticePilotsFromEngineLocked()
	}
	practiceSnap := clonePracticeManagerState(e.practiceState)
	pilotsCopy := append([]domain.PilotSlot(nil), e.pilots...)
	gatesCopy := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilotsCopy, gatesCopy)
	}
	e.notifyPracticeUpdated(practiceSnap, subs)
}

// ResetSession clears recorded laps, crossings, and sector statistics while preserving gate & pilot config.
func (e *Engine) ResetSession() {
	e.mu.Lock()
	e.resetSessionLocked()
	var practiceSnap domain.PracticeManagerState
	var subs []EventSubscriber
	if !e.isLiveRaceHeatActiveLocked() && e.practiceState.ActiveSessionID != "" {
		e.syncActivePracticeRecordsLocked()
		practiceSnap = clonePracticeManagerState(e.practiceState)
		subs = append([]EventSubscriber(nil), e.subscribers...)
	}
	e.mu.Unlock()
	if len(subs) > 0 {
		e.notifyPracticeUpdated(practiceSnap, subs)
	}
}

// ActivePilotChannels returns the 8-slot hardware frequency table (MHz, or 0 for disabled slots)
// and the mapping from each hardware slot (0..7) to the pilot index in `e.pilots` (0..15).
// Pilots at indices 0..7 keep their natural hardware slot 0..7 when enabled; any enabled pilot at
// index >= 8 is placed into the first unused hardware slot 0..7 (since at most 8 pilots can be
// enabled at once).
func (e *Engine) ActivePilotChannels() ([domain.MaxPilotSlots]uint16, [domain.MaxPilotSlots]int) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return ComputeActivePilotChannels(e.pilots)
}

// ComputeActivePilotChannels builds the 8-slot hardware frequency table and slot->pilot index map.
func ComputeActivePilotChannels(pilots []domain.PilotSlot) ([domain.MaxPilotSlots]uint16, [domain.MaxPilotSlots]int) {
	var freqs [domain.MaxPilotSlots]uint16
	var slotToPilot [domain.MaxPilotSlots]int
	for ch := 0; ch < domain.MaxPilotSlots; ch++ {
		slotToPilot[ch] = ch
		if ch < len(pilots) && pilots[ch].Enabled && pilots[ch].FrequencyMHz >= 5180 {
			freqs[ch] = pilots[ch].FrequencyMHz
		}
	}
	for i := domain.MaxPilotSlots; i < len(pilots); i++ {
		if !pilots[i].Enabled || pilots[i].FrequencyMHz < 5180 {
			continue
		}
		for ch := 0; ch < domain.MaxPilotSlots; ch++ {
			if freqs[ch] == 0 {
				freqs[ch] = pilots[i].FrequencyMHz
				slotToPilot[ch] = i
				break
			}
		}
	}
	return freqs, slotToPilot
}

func (e *Engine) resetSessionLocked() {
	e.progress = make(map[int]*pilotProgress)
	e.passProfiles = make(map[detKey]*pilotPassProfile)
	e.lastAcceptedUs = make(map[string]uint64)
	e.laps = make([]domain.LapRecord, 0, 256)
	e.crossings = make([]domain.GateCrossingEvent, 0, maxStoredCrossings)
	e.filtered = make([]domain.FilteredDetection, 0, maxStoredFiltered)
	e.overallBestSec = make(map[string]float64)
	e.pilotBestSec = make(map[string]float64)
	e.sectorHistory = make(map[string][]domain.SectorSplit)
}

// IngestTelemetryFrame processes a single 8-channel 5.8 GHz RSSI frame from a Gate Timer.
func (e *Engine) IngestTelemetryFrame(frame domain.TimerTelemetryFrame) {
	if frame.TimestampUs == 0 {
		frame.TimestampUs = e.NowUs()
	}

	var accepted []domain.GateCrossingEvent
	var passthrough []domain.GateCrossingEvent
	var filtered []domain.FilteredDetection
	var completedLaps []domain.LapRecord
	var summariesSnapshot []domain.PilotTrackSummary
	var raceChanged bool
	var raceCfgRestored bool
	var raceAnn *domain.RaceAnnouncement
	var raceSnap domain.RaceTournamentState

	e.mu.Lock()
	if tickChanged, tickAnn, tickCfg, _, _, _ := e.tickRaceClockLocked(frame.TimestampUs); tickChanged {
		raceChanged = true
		raceAnn = tickAnn
		if tickCfg {
			raceCfgRestored = true
		}
	}
	e.touchDetectedTimerLocked(frame)
	gate := e.touchGateLocked(frame)
	if gate == nil {
		var subs []EventSubscriber
		var pilotsCopy []domain.PilotSlot
		var gatesCopy []domain.TrackGate
		if raceChanged {
			raceSnap = cloneRaceState(e.raceState)
			subs = append([]EventSubscriber(nil), e.subscribers...)
			if raceCfgRestored {
				pilotsCopy = append([]domain.PilotSlot(nil), e.pilots...)
				gatesCopy = append([]domain.TrackGate(nil), e.gates...)
			}
		}
		e.mu.Unlock()
		if raceCfgRestored {
			for _, s := range subs {
				s.OnConfigUpdated(pilotsCopy, gatesCopy)
			}
		}
		if raceChanged {
			e.notifyRaceUpdated(raceSnap, raceAnn, subs)
		}
		return
	}
	frame.TimerID = gate.GateID
	hwMode := domain.NormalizeTimingHardwareMode(e.timingHardwareMode)
	isSlapRFMode := domain.IsSlapRFMode(hwMode)
	var autoCalibChanged bool
	var autoCalibSFChanged bool

	for i := 0; i < len(e.pilots) && i < domain.MaxPilotPoolSize; i++ {
		pilot := e.pilots[i]
		det := e.detectors[detKey{gate.GateID, pilot.SlotIndex}]
		if det == nil {
			det = dsp.NewChannelDetector(gate.GateID, pilot.SlotIndex)
			e.detectors[detKey{gate.GateID, pilot.SlotIndex}] = det
		}
		var enter, exit float32
		if domain.IsRotorHazardMode(e.timingHardwareMode) {
			enter, exit = rhThresholdsFor(gate, i, pilot)
		} else {
			enter, exit = thresholdsFor(gate, i, pilot)
		}
		candidate := det.ProcessSample(frame.RSSI[i], frame.TimestampUs, enter, exit, detectorDebounceUs)
		gate.LastRSSI[i] = det.SmoothedRSSI()
		frame.RSSI[i] = det.SmoothedRSSI()

		if isSlapRFMode && e.raceArmed && pilot.Enabled && pilot.Channel > 0 {
			if chg, sfChg := e.recordAutoCalibSampleLocked(gate, i, pilot, det, frame.RSSI[i], frame.TimestampUs, candidate != nil); chg {
				autoCalibChanged = true
				if sfChg {
					autoCalibSFChanged = true
				}
				enter, exit = thresholdsFor(gate, i, pilot)
			}
		}

		if gate.Role == domain.GateRoleStartFinish && pilot.Enabled && pilot.Channel > 0 {
			e.recordHeatRssiSampleLocked(pilot.SlotIndex, frame.TimestampUs, frame.RSSI[i], enter, exit)
		}

		if candidate == nil || !pilot.Enabled || pilot.Channel == 0 {
			continue
		}

		ev := domain.GateCrossingEvent{
			GateID:            gate.GateID,
			GateName:          e.gateLabelLocked(gate.GateID),
			IsStartFinish:     gate.Role == domain.GateRoleStartFinish,
			SlotIndex:         pilot.SlotIndex,
			Callsign:          pilot.Callsign,
			FrequencyMHz:      pilot.FrequencyMHz,
			TimestampUs:       candidate.TimestampUs,
			PeakRSSIDbm:       candidate.PeakRSSIDbm,
			LapRFPeakHeight:   candidate.LapRFPeakHeight,
			BeamwidthMs:       candidate.BeamwidthMs,
			EstimatedSpeedMph: candidate.EstimatedSpeedMph,
			HoldMs:            candidate.HoldMs,
			AboveEnterMs:      candidate.AboveEnterMs,
			PassAreaDbSec:     candidate.PassAreaDbSec,
			IsStepBurst:       candidate.IsStepBurst,
		}

		if !e.raceArmed {
			// Pure passthrough mode ("Timing off" in SlapRF): do not record local practice laps or
			// crossings in SlapRF, but still forward debounced Start/Finish gate crossings to external
			// hardware bridges (such as the LapRF 8-Way emulator).
			if ev.IsStartFinish {
				r := gate.RulesForPilot(e.rules, pilot.SlotIndex)
				if reason := e.checkSpikeRejectionLocked(pilot, *gate, i, ev, r); reason != "" {
					det.RollbackRejectedSpike()
					continue
				}
				ckey := detectorKey(gate.GateID, pilot.SlotIndex)
				if last, ok := e.lastAcceptedUs[ckey]; ok && seconds(last, ev.TimestampUs) < r.MinLapSec {
					continue
				}
				e.lastAcceptedUs[ckey] = ev.TimestampUs
				e.passingNumbers[gate.GateID]++
				ev.PassingNumber = e.passingNumbers[gate.GateID]
				passthrough = append(passthrough, ev)
			}
			continue
		}

		out := e.applyCrossingLocked(pilot, *gate, ev)
		if out.rejected != nil {
			if out.rejected.Reason == domain.FilterSpike {
				det.RollbackRejectedSpike()
			}
			filtered = append(filtered, e.storeFilteredLocked(*out.rejected))
			continue
		}

		e.nextEventID++
		e.passingNumbers[gate.GateID]++
		ev.EventID = e.nextEventID
		ev.PassingNumber = e.passingNumbers[gate.GateID]
		ev.StartedLap = ev.IsStartFinish && out.lap == nil
		e.crossings = append(e.crossings, ev)
		if len(e.crossings) > maxStoredCrossings {
			e.crossings = e.crossings[len(e.crossings)-maxStoredCrossings:]
		}
		accepted = append(accepted, ev)

		if out.note != nil {
			filtered = append(filtered, e.storeFilteredLocked(*out.note))
		}
		if out.lap != nil {
			e.laps = append(e.laps, *out.lap)
			if len(e.laps) > maxStoredLaps {
				e.laps = e.laps[len(e.laps)-maxStoredLaps:]
			}
			completedLaps = append(completedLaps, *out.lap)
		}
		if rc, restored, ann := e.recordRaceCrossingLocked(ev, out.lap); rc {
			raceChanged = true
			if restored {
				raceCfgRestored = true
			}
			if ann != nil {
				raceAnn = ann
			}
		}
	}

	if len(completedLaps) > 0 {
		summariesSnapshot = e.computeSummariesLocked()
	}
	var practiceChanged bool
	var practiceSnap domain.PracticeManagerState
	if !e.isLiveRaceHeatActiveLocked() && e.practiceState.ActiveSessionID != "" &&
		(len(accepted) > 0 || len(completedLaps) > 0 || len(filtered) > 0) {
		e.syncActivePracticeRecordsLocked()
		// Emit full PracticeManagerState on completed laps so session directory / workspace summaries stay live
		if len(completedLaps) > 0 {
			practiceChanged = true
			practiceSnap = clonePracticeManagerState(e.practiceState)
		}
	}
	if autoCalibChanged {
		if !e.isLiveRaceHeatActiveLocked() && e.practiceState.ActiveSessionID != "" {
			if sess := e.findPracticeSessionLocked(e.practiceState.ActiveSessionID); sess != nil {
				sess.TrackInitialized = true
				sess.TrackSnapshot = e.snapshotOrderedGatesLocked()
				practiceChanged = true
				practiceSnap = clonePracticeManagerState(e.practiceState)
			}
		} else if isRaceOngoing(&e.raceState) && isRaceTrackEditable(&e.raceState) {
			e.raceState.TrackInitialized = true
			e.raceState.TrackSnapshot = e.snapshotOrderedGatesLocked()
			raceChanged = true
		}
	}
	if autoCalibSFChanged {
		if e.syncStartFinishThresholdsToRaceLocked(hwMode) != nil {
			raceChanged = true
		}
	}
	cfgChanged := raceCfgRestored || autoCalibChanged
	var pilotsCopy []domain.PilotSlot
	var gatesCopy []domain.TrackGate
	if raceChanged {
		e.resolveActiveTournamentLocked()
		e.syncActiveRaceToEventLocked()
		raceSnap = cloneRaceState(e.raceState)
	}
	if cfgChanged {
		pilotsCopy = append([]domain.PilotSlot(nil), e.pilots...)
		gatesCopy = append([]domain.TrackGate(nil), e.gates...)
	}
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	// Dispatch outside the lock.
	for _, s := range subs {
		if cfgChanged {
			s.OnConfigUpdated(pilotsCopy, gatesCopy)
		}
		s.OnTelemetryFrame(frame)
		for _, f := range filtered {
			s.OnDetectionFiltered(f)
		}
		for _, ev := range accepted {
			s.OnGateCrossing(ev)
		}
		if ps, ok := s.(PassthroughSubscriber); ok {
			for _, ev := range passthrough {
				ps.OnPassthroughCrossing(ev)
			}
		}
		for _, lap := range completedLaps {
			s.OnLapCompleted(lap, summariesSnapshot)
		}
	}
	if practiceChanged {
		e.notifyPracticeUpdated(practiceSnap, subs)
	}
	if raceChanged {
		e.notifyRaceUpdated(raceSnap, raceAnn, subs)
	}
}

// touchDetectedTimerLocked records or updates the physical XIAO timer in `e.detected`.
func (e *Engine) touchDetectedTimerLocked(frame domain.TimerTelemetryFrame) {
	if frame.TimerID == 0 {
		return
	}
	now := time.Now()
	d, ok := e.detected[frame.TimerID]
	if !ok {
		d = &domain.DetectedTimer{
			TimerID:         frame.TimerID,
			Color:           domain.DefaultTimerColor(frame.TimerID),
			FirmwareVersion: domain.LatestFirmwareVersion,
			BatteryMv:       4080,
			BatteryPct:      domain.ComputeBatteryPct(4080),
			NoiseFloorDbm:   -92.0,
		}
		e.detected[frame.TimerID] = d
	} else {
		if d.Color == "" {
			d.Color = domain.DefaultTimerColor(frame.TimerID)
		}
		if d.FirmwareVersion == "" {
			d.FirmwareVersion = domain.LatestFirmwareVersion
		}
	}
	d.Online = true
	d.LastSeenAt = now
	d.FramesRxCount++
	d.LastRSSI = frame.RSSI
	if frame.BatteryMv > 0 {
		d.BatteryMv = frame.BatteryMv
		d.BatteryPct = domain.ComputeBatteryPct(frame.BatteryMv)
	}
	if frame.NoiseFloorDbm != 0 {
		d.NoiseFloorDbm = frame.NoiseFloorDbm
	}
}

// touchGateLocked finds the track gate bound to `frame.TimerID` (via `AssignedTimerID`) and refreshes its health.
// Returns nil if no gate currently has `AssignedTimerID == frame.TimerID`.
func (e *Engine) touchGateLocked(frame domain.TimerTelemetryFrame) *domain.TrackGate {
	idx := -1
	for i := range e.gates {
		if e.gates[i].AssignedTimerID == frame.TimerID {
			idx = i
			break
		}
	}
	if idx == -1 {
		return nil
	}

	gate := &e.gates[idx]
	gate.Online = true
	gate.LastSeenAt = time.Now()
	gate.FramesRxCount++
	if frame.BatteryMv > 0 {
		gate.BatteryMv = frame.BatteryMv
		gate.BatteryPct = domain.ComputeBatteryPct(frame.BatteryMv)
	}
	if frame.NoiseFloorDbm != 0 {
		gate.NoiseFloorDbm = frame.NoiseFloorDbm
	}
	if d, ok := e.detected[frame.TimerID]; ok {
		if d.TimerLabel != "" {
			gate.TimerLabel = d.TimerLabel
		}
		if d.FirmwareVersion != "" {
			gate.FirmwareVersion = d.FirmwareVersion
		}
	}
	return gate
}

func (e *Engine) storeFilteredLocked(f domain.FilteredDetection) domain.FilteredDetection {
	e.filtered = append(e.filtered, f)
	if len(e.filtered) > maxStoredFiltered {
		e.filtered = e.filtered[len(e.filtered)-maxStoredFiltered:]
	}
	return f
}

// StateSnapshot returns the current configuration, recent laps, crossings, and pilot track summaries.
func (e *Engine) StateSnapshot() (
	pilots []domain.PilotSlot,
	gates []domain.TrackGate,
	laps []domain.LapRecord,
	crossings []domain.GateCrossingEvent,
	summaries []domain.PilotTrackSummary,
) {
	e.mu.RLock()
	defer e.mu.RUnlock()

	pilots = append([]domain.PilotSlot(nil), e.pilots...)
	gates = append([]domain.TrackGate(nil), e.gates...)
	for i := range gates {
		if gates[i].AssignedTimerID == 0 {
			gates[i].Online = false
			gates[i].TimerLabel = ""
			gates[i].FirmwareVersion = ""
			gates[i].Color = ""
			gates[i].BatteryMv = 0
			gates[i].BatteryPct = 0
			continue
		}
		if d, ok := e.detected[gates[i].AssignedTimerID]; ok {
			gates[i].TimerLabel = d.TimerLabel
			if d.FirmwareVersion != "" {
				gates[i].FirmwareVersion = d.FirmwareVersion
			}
			if d.Color != "" {
				gates[i].Color = d.Color
			}
			gates[i].BatteryMv = d.BatteryMv
			gates[i].BatteryPct = d.BatteryPct
			gates[i].NoiseFloorDbm = d.NoiseFloorDbm
			gates[i].LastSeenAt = d.LastSeenAt
		}
		gates[i].Online = !gates[i].LastSeenAt.IsZero() && time.Since(gates[i].LastSeenAt) < timerOfflineAfter
	}
	laps = append([]domain.LapRecord(nil), e.laps...)
	crossings = append([]domain.GateCrossingEvent(nil), e.crossings...)
	summaries = e.computeSummariesLocked()
	return
}

// DetectedTimersSnapshot returns all physical XIAO ESP32-C5 timers discovered or provisioned,
// sorted by their hardware TimerID.
func (e *Engine) DetectedTimersSnapshot() []domain.DetectedTimer {
	e.mu.RLock()
	defer e.mu.RUnlock()

	out := make([]domain.DetectedTimer, 0, len(e.detected))
	for _, d := range e.detected {
		cp := *d
		cp.Online = !cp.LastSeenAt.IsZero() && time.Since(cp.LastSeenAt) < timerOfflineAfter
		out = append(out, cp)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].TimerID < out[j].TimerID })
	return out
}

// FilteredSnapshot returns recent detections set aside by the timing rules.
func (e *Engine) FilteredSnapshot() []domain.FilteredDetection {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return append([]domain.FilteredDetection(nil), e.filtered...)
}

// SimSeatSummary captures the minimal seat metadata needed by TrackSimulator at 50 Hz without
// cloning heat crossings, lap records, or multi-thousand-sample RSSI traces.
type SimSeatSummary struct {
	SeatIndex      int
	PilotSlotIndex int
	Status         domain.PilotHeatStatus
}

// SimActiveHeatSummary captures the minimal active-heat state needed by TrackSimulator at 50 Hz.
type SimActiveHeatSummary struct {
	ID    string
	State domain.HeatState
	Seats []SimSeatSummary
}

// SimStepInputs bundles the lightweight configuration and active-heat state read by TrackSimulator
// on each 20 ms step under a single lock, avoiding full lap/crossing/summary/tournament clones.
type SimStepInputs struct {
	Pilots         []domain.PilotSlot
	Gates          []domain.TrackGate
	Detected       []domain.DetectedTimer
	HWMode         domain.TimingHardwareMode
	IsArmed        bool
	Mode           domain.OperatingMode
	ActiveHeat     *SimActiveHeatSummary
	RHSpecsByTimer map[uint8][domain.MaxPilotSlots]RHNodeHardwareSpec
}

// SimStepInputs advances any live heat clock, snapshots pilots/gates/timers, and extracts minimal
// active-heat state in one lock pass without cloning lap history, crossings, or RSSI traces.
func (e *Engine) SimStepInputs() SimStepInputs {
	nowUs := e.NowUs()
	now := time.Now()

	e.mu.Lock()
	changed, ann, cfgChanged, pilotsCopy, gatesCopy, subs := e.tickRaceClockLocked(nowUs)
	var raceSnapNotify domain.RaceTournamentState
	if changed {
		raceSnapNotify = cloneRaceState(e.raceState)
	}

	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	for i := range gates {
		if gates[i].AssignedTimerID == 0 {
			gates[i].Online = false
			gates[i].TimerLabel = ""
			gates[i].FirmwareVersion = ""
			gates[i].Color = ""
			gates[i].BatteryMv = 0
			gates[i].BatteryPct = 0
			continue
		}
		if d, ok := e.detected[gates[i].AssignedTimerID]; ok {
			gates[i].TimerLabel = d.TimerLabel
			if d.FirmwareVersion != "" {
				gates[i].FirmwareVersion = d.FirmwareVersion
			}
			if d.Color != "" {
				gates[i].Color = d.Color
			}
			gates[i].BatteryMv = d.BatteryMv
			gates[i].BatteryPct = d.BatteryPct
			gates[i].NoiseFloorDbm = d.NoiseFloorDbm
			gates[i].LastSeenAt = d.LastSeenAt
		}
		gates[i].Online = !gates[i].LastSeenAt.IsZero() && now.Sub(gates[i].LastSeenAt) < timerOfflineAfter
	}

	detected := make([]domain.DetectedTimer, 0, len(e.detected))
	for _, d := range e.detected {
		cp := *d
		cp.Online = !cp.LastSeenAt.IsZero() && now.Sub(cp.LastSeenAt) < timerOfflineAfter
		detected = append(detected, cp)
	}
	sort.Slice(detected, func(i, j int) bool { return detected[i].TimerID < detected[j].TimerID })

	hwMode := domain.NormalizeTimingHardwareMode(e.timingHardwareMode)
	isArmed := e.raceArmed

	var rhSpecs map[uint8][domain.MaxPilotSlots]RHNodeHardwareSpec
	if domain.IsRotorHazardMode(hwMode) {
		rhSpecs = make(map[uint8][domain.MaxPilotSlots]RHNodeHardwareSpec, 6)
		for tid := uint8(2); tid <= 7; tid++ {
			rhSpecs[tid] = e.activeRHNodeSpecsLocked(tid)
		}
	}

	mode := e.raceState.Mode
	var activeHeat *SimActiveHeatSummary
	raceIsLiveOnTrack := e.practiceState.ActiveSessionID == "" &&
		e.raceState.Lifecycle != domain.LifecyclePaused &&
		e.raceState.Lifecycle != domain.LifecycleCompleted &&
		e.raceState.Lifecycle != domain.LifecycleScrapped &&
		!e.raceState.EmergencyStopped
	if !raceIsLiveOnTrack {
		mode = domain.ModePractice
	} else if e.raceState.ActiveHeatID != "" {
		for i := range e.raceState.Heats {
			if e.raceState.Heats[i].ID == e.raceState.ActiveHeatID {
				h := &e.raceState.Heats[i]
				seats := make([]SimSeatSummary, len(h.Seats))
				for si, s := range h.Seats {
					seats[si] = SimSeatSummary{
						SeatIndex:      s.SeatIndex,
						PilotSlotIndex: s.PilotSlotIndex,
						Status:         s.Status,
					}
				}
				activeHeat = &SimActiveHeatSummary{
					ID:    h.ID,
					State: h.State,
					Seats: seats,
				}
				break
			}
		}
	}
	e.mu.Unlock()

	if cfgChanged {
		for _, s := range subs {
			s.OnConfigUpdated(pilotsCopy, gatesCopy)
		}
	}
	if changed {
		e.notifyRaceUpdated(raceSnapNotify, ann, subs)
	}

	return SimStepInputs{
		Pilots:         pilots,
		Gates:          gates,
		Detected:       detected,
		HWMode:         hwMode,
		IsArmed:        isArmed,
		Mode:           mode,
		ActiveHeat:     activeHeat,
		RHSpecsByTimer: rhSpecs,
	}
}
