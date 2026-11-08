package tracker

import (
	"fmt"
	"sort"
	"sync"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/dsp"
)

// puckOfflineAfter marks a gate puck offline when no telemetry frame has arrived for this long.
const puckOfflineAfter = 2 * time.Second

const (
	maxStoredLaps      = 5000 // A full practice day for 8 pilots
	maxStoredCrossings = 300
	maxStoredFiltered  = 300
	// Detector-level debounce only; the user-facing gate cool-down is a TimingRule.
	detectorDebounceUs = 300_000
)

// EventSubscriber receives real-time callbacks for telemetry frames, gate crossings, and lap completions.
type EventSubscriber interface {
	OnTelemetryFrame(frame domain.PuckTelemetryFrame)
	OnGateCrossing(event domain.GateCrossingEvent)
	OnDetectionFiltered(f domain.FilteredDetection)
	OnLapCompleted(lap domain.LapRecord, summaries []domain.PilotTrackSummary)
	OnConfigUpdated(pilots []domain.PilotSlot, pucks []domain.GatePuck)
}

// pilotProgress tracks where a pilot is on the track between accepted crossings.
type pilotProgress struct {
	lastPuckID     uint8  // 0 = no accepted crossing in the current run
	lastGateTimeUs uint64 // timestamp of that crossing
	prevPuckID     uint8  // gate accepted before lastPuckID (for echo detection)
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
	pucks          []domain.GatePuck
	detected       map[uint8]*domain.DetectedPuck  // key: physical puckId (1..16)
	detectors      map[string]*dsp.ChannelDetector // key: "puckId:slotIdx"
	progress       map[int]*pilotProgress          // key: 1-based slotIdx
	lastAcceptedUs map[string]uint64               // key: "puckId:slotIdx" -> last accepted crossing
	laps           []domain.LapRecord
	crossings      []domain.GateCrossingEvent
	filtered       []domain.FilteredDetection
	overallBestSec map[string]float64              // key: gate pair "from>to" -> fastest split across all pilots
	pilotBestSec   map[string]float64              // key: "slotIdx:from>to" -> pilot's personal best split
	sectorHistory  map[string][]domain.SectorSplit // key: "slotIdx:from>to"
	nextEventID    uint64
	nextLapID      uint64
	passingNumbers map[uint8]uint32 // per-puck passing counter
	subscribers    []EventSubscriber
}

// NewEngine creates and initializes a multi-gate timing engine with default pucks and pilot slots.
func NewEngine() *Engine {
	e := &Engine{
		bootTime:       time.Now(),
		raceArmed:      true,
		rules:          domain.DefaultTimingRules(),
		pilots:         domain.DefaultPilotSlots(),
		pucks:          domain.DefaultTrackPucks(),
		detected:       make(map[uint8]*domain.DetectedPuck),
		detectors:      make(map[string]*dsp.ChannelDetector),
		passingNumbers: make(map[uint8]uint32),
	}
	for _, p := range e.pucks {
		if p.AssignedPuckID > 0 {
			c := p.Color
			if c == "" {
				c = domain.DefaultPuckColor(p.AssignedPuckID)
			}
			e.detected[p.AssignedPuckID] = &domain.DetectedPuck{
				PuckID:        p.AssignedPuckID,
				PuckLabel:     p.PuckLabel,
				Color:         c,
				IsHub:         p.AssignedPuckID == 1,
				BatteryMv:     p.BatteryMv,
				BatteryPct:    p.BatteryPct,
				NoiseFloorDbm: p.NoiseFloorDbm,
				Online:        p.Online,
				LastSeenAt:    p.LastSeenAt,
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
		pucks:          []domain.GatePuck{},
		detected:       make(map[uint8]*domain.DetectedPuck),
		detectors:      make(map[string]*dsp.ChannelDetector),
		passingNumbers: make(map[uint8]uint32),
	}
	e.resetSessionLocked()
	e.initDetectorsLocked()
	return e
}

func (e *Engine) initDetectorsLocked() {
	for _, puck := range e.pucks {
		for _, pilot := range e.pilots {
			key := detectorKey(puck.PuckID, pilot.SlotIndex)
			if _, exists := e.detectors[key]; !exists {
				e.detectors[key] = dsp.NewChannelDetector(puck.PuckID, pilot.SlotIndex)
			}
		}
	}
}

func detectorKey(puckID uint8, slotIndex int) string {
	return fmt.Sprintf("%d:%d", puckID, slotIndex)
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
	pucksCopy := append([]domain.GatePuck(nil), e.pucks...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilotsCopy, pucksCopy)
	}
}

// ResetSession clears recorded laps, crossings, and sector statistics while preserving gate & pilot config.
func (e *Engine) ResetSession() {
	e.mu.Lock()
	e.resetSessionLocked()
	e.mu.Unlock()
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

// IngestTelemetryFrame processes a single 8-channel 5.8 GHz RSSI frame from a Gate Puck.
func (e *Engine) IngestTelemetryFrame(frame domain.PuckTelemetryFrame) {
	if frame.TimestampUs == 0 {
		frame.TimestampUs = e.NowUs()
	}

	var accepted []domain.GateCrossingEvent
	var filtered []domain.FilteredDetection
	var completedLaps []domain.LapRecord
	var summariesSnapshot []domain.PilotTrackSummary

	e.mu.Lock()
	e.touchDetectedPuckLocked(frame)
	puck := e.touchPuckLocked(frame)
	if puck == nil {
		e.mu.Unlock()
		return
	}
	frame.PuckID = puck.PuckID

	for i := 0; i < len(e.pilots) && i < domain.MaxPilotPoolSize; i++ {
		pilot := e.pilots[i]
		det := e.detectors[detectorKey(puck.PuckID, pilot.SlotIndex)]
		if det == nil {
			det = dsp.NewChannelDetector(puck.PuckID, pilot.SlotIndex)
			e.detectors[detectorKey(puck.PuckID, pilot.SlotIndex)] = det
		}
		enter, exit := thresholdsFor(puck, i, pilot)
		candidate := det.ProcessSample(frame.RSSI[i], frame.TimestampUs, enter, exit, detectorDebounceUs)
		puck.LastRSSI[i] = det.SmoothedRSSI()
		frame.RSSI[i] = det.SmoothedRSSI()

		if candidate == nil || !pilot.Enabled || pilot.Channel == 0 || !e.raceArmed {
			continue
		}

		ev := domain.GateCrossingEvent{
			PuckID:            puck.PuckID,
			PuckName:          e.gateLabelLocked(puck.PuckID),
			IsStartFinish:     puck.Role == domain.PuckRoleStartFinish,
			SlotIndex:         pilot.SlotIndex,
			Callsign:          pilot.Callsign,
			FrequencyMHz:      pilot.FrequencyMHz,
			TimestampUs:       candidate.TimestampUs,
			PeakRSSIDbm:       candidate.PeakRSSIDbm,
			LapRFPeakHeight:   candidate.LapRFPeakHeight,
			BeamwidthMs:       candidate.BeamwidthMs,
			EstimatedSpeedMph: candidate.EstimatedSpeedMph,
		}

		out := e.applyCrossingLocked(pilot, *puck, ev)
		if out.rejected != nil {
			filtered = append(filtered, e.storeFilteredLocked(*out.rejected))
			continue
		}

		e.nextEventID++
		e.passingNumbers[puck.PuckID]++
		ev.EventID = e.nextEventID
		ev.PassingNumber = e.passingNumbers[puck.PuckID]
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

// touchDetectedPuckLocked records or updates the physical XIAO puck in `e.detected`.
func (e *Engine) touchDetectedPuckLocked(frame domain.PuckTelemetryFrame) {
	if frame.PuckID == 0 {
		return
	}
	now := time.Now()
	d, ok := e.detected[frame.PuckID]
	if !ok {
		d = &domain.DetectedPuck{
			PuckID:        frame.PuckID,
			Color:         domain.DefaultPuckColor(frame.PuckID),
			IsHub:         frame.PuckID == 1,
			BatteryMv:     4080,
			BatteryPct:    domain.ComputeBatteryPct(4080),
			NoiseFloorDbm: -92.0,
		}
		e.detected[frame.PuckID] = d
	} else if d.Color == "" {
		d.Color = domain.DefaultPuckColor(frame.PuckID)
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

// touchPuckLocked finds the track gate bound to `frame.PuckID` (via `AssignedPuckID`) and refreshes its health.
// Returns nil if no gate currently has `AssignedPuckID == frame.PuckID`.
func (e *Engine) touchPuckLocked(frame domain.PuckTelemetryFrame) *domain.GatePuck {
	idx := -1
	for i := range e.pucks {
		if e.pucks[i].AssignedPuckID == frame.PuckID {
			idx = i
			break
		}
	}
	if idx == -1 {
		return nil
	}

	puck := &e.pucks[idx]
	puck.Online = true
	puck.LastSeenAt = time.Now()
	puck.FramesRxCount++
	if frame.BatteryMv > 0 {
		puck.BatteryMv = frame.BatteryMv
		puck.BatteryPct = domain.ComputeBatteryPct(frame.BatteryMv)
	}
	if frame.NoiseFloorDbm != 0 {
		puck.NoiseFloorDbm = frame.NoiseFloorDbm
	}
	if d, ok := e.detected[frame.PuckID]; ok && d.PuckLabel != "" {
		puck.PuckLabel = d.PuckLabel
	}
	return puck
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
	pucks []domain.GatePuck,
	laps []domain.LapRecord,
	crossings []domain.GateCrossingEvent,
	summaries []domain.PilotTrackSummary,
) {
	e.mu.RLock()
	defer e.mu.RUnlock()

	pilots = append([]domain.PilotSlot(nil), e.pilots...)
	pucks = append([]domain.GatePuck(nil), e.pucks...)
	for i := range pucks {
		if pucks[i].AssignedPuckID == 0 {
			pucks[i].Online = false
			pucks[i].PuckLabel = ""
			pucks[i].Color = ""
			pucks[i].BatteryMv = 0
			pucks[i].BatteryPct = 0
			continue
		}
		if d, ok := e.detected[pucks[i].AssignedPuckID]; ok {
			pucks[i].PuckLabel = d.PuckLabel
			if d.Color != "" {
				pucks[i].Color = d.Color
			}
			pucks[i].BatteryMv = d.BatteryMv
			pucks[i].BatteryPct = d.BatteryPct
			pucks[i].NoiseFloorDbm = d.NoiseFloorDbm
			pucks[i].LastSeenAt = d.LastSeenAt
		}
		pucks[i].Online = !pucks[i].LastSeenAt.IsZero() && time.Since(pucks[i].LastSeenAt) < puckOfflineAfter
	}
	laps = append([]domain.LapRecord(nil), e.laps...)
	crossings = append([]domain.GateCrossingEvent(nil), e.crossings...)
	summaries = e.computeSummariesLocked()
	return
}

// DetectedPucksSnapshot returns all physical XIAO ESP32-C5 pucks discovered or provisioned,
// sorted by their hardware PuckID.
func (e *Engine) DetectedPucksSnapshot() []domain.DetectedPuck {
	e.mu.RLock()
	defer e.mu.RUnlock()

	out := make([]domain.DetectedPuck, 0, len(e.detected))
	for _, d := range e.detected {
		cp := *d
		cp.Online = !cp.LastSeenAt.IsZero() && time.Since(cp.LastSeenAt) < puckOfflineAfter
		out = append(out, cp)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PuckID < out[j].PuckID })
	return out
}

// FilteredSnapshot returns recent detections set aside by the timing rules.
func (e *Engine) FilteredSnapshot() []domain.FilteredDetection {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return append([]domain.FilteredDetection(nil), e.filtered...)
}
