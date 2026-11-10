package tracker

import (
	"fmt"
	"sort"
	"sync"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/dsp"
)

// timerOfflineAfter marks a gate timer offline when no telemetry frame has arrived for this long.
const timerOfflineAfter = 2 * time.Second

const (
	maxStoredLaps      = 5000 // A full practice day for 8 pilots
	maxStoredCrossings = 300
	maxStoredFiltered  = 300
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

// pilotProgress tracks where a pilot is on the track between accepted crossings.
type pilotProgress struct {
	lastGateID     uint8  // 0 = no accepted crossing in the current run
	lastGateTimeUs uint64 // timestamp of that crossing
	prevGateID     uint8  // gate accepted before lastGateID (for echo detection)
	lapStartUs     uint64 // 0 = waiting for the first start/finish crossing
	currentSectors []domain.SectorSplit
}

// Engine is the central multi-gate timing and sector analytics coordinator.
type Engine struct {
	mu             sync.RWMutex
	bootTime       time.Time
	raceArmed      bool
	rules          domain.TimingRules
	pilots         []domain.PilotSlot
	gates          []domain.TrackGate
	detected       map[uint8]*domain.DetectedTimer // key: physical timerId (1..16)
	detectors      map[string]*dsp.ChannelDetector // key: "gateId:slotIdx"
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
	subscribers    []EventSubscriber
	// hubIsCollector: real hardware only. The Hub is a USB/Wi-Fi collector dongle that relays
	// Spoke frames to the laptop and never measures laps itself, so it gets a timer entry but no
	// gate. The simulator keeps the classic model where the simulated Hub times a gate.
	hubIsCollector bool
}

// NewEngine creates and initializes a multi-gate timing engine with default gates and pilot slots.
func NewEngine() *Engine {
	e := &Engine{
		bootTime:       time.Now(),
		raceArmed:      true,
		rules:          domain.DefaultTimingRules(),
		pilots:         domain.DefaultPilotSlots(),
		gates:          domain.DefaultTrackGates(),
		detected:       make(map[uint8]*domain.DetectedTimer),
		detectors:      make(map[string]*dsp.ChannelDetector),
		passingNumbers: make(map[uint8]uint32),
	}
	for _, g := range e.gates {
		if g.AssignedTimerID > 0 {
			c := g.Color
			if c == "" {
				c = domain.DefaultTimerColor(g.AssignedTimerID)
			}
			e.detected[g.AssignedTimerID] = &domain.DetectedTimer{
				TimerID:         g.AssignedTimerID,
				TimerLabel:      g.TimerLabel,
				Color:           c,
				IsHub:           g.AssignedTimerID == 1,
				FirmwareVersion: g.FirmwareVersion,
				BatteryMv:       g.BatteryMv,
				BatteryPct:      g.BatteryPct,
				NoiseFloorDbm:   g.NoiseFloorDbm,
				Online:          g.Online,
				LastSeenAt:      g.LastSeenAt,
			}
		}
	}
	e.resetSessionLocked()
	e.initDetectorsLocked()
	return e
}

// NewRealEngine creates a clean real-world timing engine with no simulated timers,
// no pre-populated fake gates, and clean pilot slots ready for hardware or LiveTime.
func NewRealEngine() *Engine {
	e := &Engine{
		bootTime:       time.Now(),
		raceArmed:      true,
		rules:          domain.DefaultTimingRules(),
		pilots:         domain.DefaultRealPilotSlots(),
		gates:          []domain.TrackGate{},
		detected:       make(map[uint8]*domain.DetectedTimer),
		detectors:      make(map[string]*dsp.ChannelDetector),
		passingNumbers: make(map[uint8]uint32),
		hubIsCollector: true,
	}
	e.resetSessionLocked()
	e.initDetectorsLocked()
	return e
}

func (e *Engine) initDetectorsLocked() {
	for _, gate := range e.gates {
		for _, pilot := range e.pilots {
			key := detectorKey(gate.GateID, pilot.SlotIndex)
			if _, exists := e.detectors[key]; !exists {
				e.detectors[key] = dsp.NewChannelDetector(gate.GateID, pilot.SlotIndex)
			}
		}
	}
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

// NowUs returns the monotonic microsecond clock since engine boot (used as RTC for LapRF).
func (e *Engine) NowUs() uint64 {
	return uint64(time.Since(e.bootTime).Microseconds())
}

// BackdateBootTime shifts the engine boot time earlier so pre-warmed simulator laps
// align seamlessly with real-time monotonic timestamps when live ticking starts.
func (e *Engine) BackdateBootTime(d time.Duration) {
	e.mu.Lock()
	e.bootTime = time.Now().Add(-d)
	e.mu.Unlock()
}

// SetRaceArmed enables or pauses lap/crossing detection (synced with LiveTime STATE_CTRL 0xda08).
func (e *Engine) SetRaceArmed(armed bool) {
	e.mu.Lock()
	e.raceArmed = armed
	e.mu.Unlock()
}

// IsRaceArmed returns true if the timer is actively scoring crossings.
func (e *Engine) IsRaceArmed() bool {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.raceArmed
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
	e.mu.Unlock()
	return r
}

// UpdatePilotSlot updates a pilot slot's frequency, threshold, gain, or enabled state (e.g., from LiveTime 0xda01).
// It enforces that at most 8 pilots (`domain.MaxPilotSlots`) can be enabled at once and never auto-assigns
// a channel: if two enabled pilots would share the same channel, the conflicting channel is blanked (`Channel = 0`,
// `FrequencyMHz = 0`) so the race organizer explicitly chooses the channel.
func (e *Engine) UpdatePilotSlot(updated domain.PilotSlot) {
	e.mu.Lock()
	targetIdx := -1
	for i := range e.pilots {
		if e.pilots[i].SlotIndex == updated.SlotIndex {
			targetIdx = i
			break
		}
	}
	if targetIdx >= 0 {
		if updated.Callsign == "" {
			updated.Callsign = e.pilots[targetIdx].Callsign
		}
		if updated.Color == "" {
			updated.Color = e.pilots[targetIdx].Color
		}
		if updated.Channel == 0 {
			updated.FrequencyMHz = 0
		} else if updated.Channel >= 1 && updated.Channel <= domain.MaxPilotSlots && updated.Band == domain.BandRaceband {
			updated.FrequencyMHz = domain.RacebandFrequenciesMHz[updated.Channel-1]
		}
		if updated.Enabled {
			wasEnabled := e.pilots[targetIdx].Enabled
			enabledCount := 0
			usedCh := make(map[uint8]bool)
			for i, p := range e.pilots {
				if i == targetIdx || !p.Enabled {
					continue
				}
				enabledCount++
				if p.Channel > 0 {
					usedCh[p.Channel] = true
				}
			}
			// Enforce max 8 enabled pilots at a time
			if enabledCount >= domain.MaxPilotSlots {
				updated.Enabled = false
			} else if updated.Channel > 0 && usedCh[updated.Channel] {
				if !wasEnabled {
					// Newly enabled pilot had a channel already taken by an active pilot:
					// blank out the newly enabled pilot's channel so the organizer picks one.
					updated.Channel = 0
					updated.FrequencyMHz = 0
				} else {
					// Organizer explicitly assigned `updated.Channel` to this active pilot:
					// blank out the other active pilot who was on that channel so they don't collide.
					for i := range e.pilots {
						if i != targetIdx && e.pilots[i].Enabled && e.pilots[i].Channel == updated.Channel {
							e.pilots[i].Channel = 0
							e.pilots[i].FrequencyMHz = 0
						}
					}
				}
			}
		}
		e.pilots[targetIdx] = updated
	}
	pilotsCopy := append([]domain.PilotSlot(nil), e.pilots...)
	gatesCopy := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilotsCopy, gatesCopy)
	}
}

// ResetSession clears recorded laps, crossings, and sector statistics while preserving gate & pilot config.
func (e *Engine) ResetSession() {
	e.mu.Lock()
	e.resetSessionLocked()
	e.mu.Unlock()
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
	for i := domain.MaxPilotSlots; i < len(pilots) && i < domain.MaxPilotPoolSize; i++ {
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
	var filtered []domain.FilteredDetection
	var completedLaps []domain.LapRecord
	var summariesSnapshot []domain.PilotTrackSummary

	e.mu.Lock()
	e.touchDetectedTimerLocked(frame)
	gate := e.touchGateLocked(frame)
	if gate == nil {
		e.mu.Unlock()
		return
	}
	frame.TimerID = gate.GateID

	for i := 0; i < len(e.pilots) && i < domain.MaxPilotPoolSize; i++ {
		pilot := e.pilots[i]
		det := e.detectors[detectorKey(gate.GateID, pilot.SlotIndex)]
		if det == nil {
			det = dsp.NewChannelDetector(gate.GateID, pilot.SlotIndex)
			e.detectors[detectorKey(gate.GateID, pilot.SlotIndex)] = det
		}
		enter, exit := thresholdsFor(gate, i, pilot)
		candidate := det.ProcessSample(frame.RSSI[i], frame.TimestampUs, enter, exit, detectorDebounceUs)
		gate.LastRSSI[i] = det.SmoothedRSSI()
		frame.RSSI[i] = det.SmoothedRSSI()

		if candidate == nil || !pilot.Enabled || pilot.Channel == 0 || !e.raceArmed {
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
		}

		out := e.applyCrossingLocked(pilot, *gate, ev)
		if out.rejected != nil {
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
	}

	if len(completedLaps) > 0 {
		summariesSnapshot = e.computeSummariesLocked()
	}
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	// Dispatch outside the lock.
	for _, s := range subs {
		s.OnTelemetryFrame(frame)
		for _, f := range filtered {
			s.OnDetectionFiltered(f)
		}
		for _, ev := range accepted {
			s.OnGateCrossing(ev)
		}
		for _, lap := range completedLaps {
			s.OnLapCompleted(lap, summariesSnapshot)
		}
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
			IsHub:           frame.TimerID == 1,
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
