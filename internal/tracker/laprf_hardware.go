package tracker

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"slaprf/internal/domain"
)

// LapRFSlotHardwareSpec describes one of the 8 hardware RF receiver slots for a LapRF 8-Way timer.
type LapRFSlotHardwareSpec struct {
	Enabled      bool        `json:"enabled"`
	Band         domain.Band `json:"band"`
	Channel      uint8       `json:"channel"`
	FrequencyMHz uint16      `json:"frequencyMhz"`
	Threshold    float32     `json:"threshold"`
	Gain         uint16      `json:"gain"`
}

// TimingHardwareMode returns the engine's active timing hardware backend ("slaprf" or "laprf").
func (e *Engine) TimingHardwareMode() domain.TimingHardwareMode {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return domain.NormalizeTimingHardwareMode(e.timingHardwareMode)
}

func cloneTimersMapToSlice(m map[uint8]*domain.DetectedTimer) []domain.DetectedTimer {
	out := make([]domain.DetectedTimer, 0, len(m))
	for _, d := range m {
		if d != nil {
			out = append(out, *d)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].TimerID < out[j].TimerID })
	return out
}

func restoreTimersSliceToMap(list []domain.DetectedTimer) map[uint8]*domain.DetectedTimer {
	m := make(map[uint8]*domain.DetectedTimer, len(list))
	for _, d := range list {
		cp := d
		m[cp.TimerID] = &cp
	}
	return m
}

func normalizeLapRFTimerLabel(label string, timerID uint8) string {
	unitNum := int(timerID) - 1
	if unitNum < 1 {
		unitNum = 1
	}
	clean := strings.TrimSpace(label)
	if clean == "" || strings.HasPrefix(strings.ToLower(clean), "laprf #") {
		return fmt.Sprintf("L%d", unitNum)
	}
	return clean
}

func defaultSimSlapRFBLELayoutLocked(now time.Time) ([]domain.TrackGate, map[uint8]*domain.DetectedTimer) {
	var rssi [domain.MaxPilotPoolSize]float32
	for i := range rssi {
		rssi[i] = -92
	}
	hub := &domain.DetectedTimer{
		TimerID:         domain.SimHubTimerID,
		TimerLabel:      domain.DefaultSimHubLabel,
		Color:           domain.DefaultGateColors[0],
		IsHub:           true,
		FirmwareVersion: domain.LatestFirmwareVersion,
		Fingerprint:     newFingerprintHex(),
		BatteryMv:       4200,
		BatteryPct:      100,
		NoiseFloorDbm:   -92.0,
		LastRSSI:        rssi,
		Online:          true,
		LastSeenAt:      now,
	}
	gates := []domain.TrackGate{
		{
			GateID:          1,
			AssignedTimerID: domain.SimHubTimerID,
			TimerLabel:      domain.DefaultSimHubLabel,
			FirmwareVersion: domain.LatestFirmwareVersion,
			Color:           domain.DefaultGateColors[0],
			Role:            domain.GateRoleStartFinish,
			TrackOrder:      0,
			MapX:            0.50,
			MapY:            0.50,
			BatteryMv:       4200,
			BatteryPct:      100,
			NoiseFloorDbm:   -92.0,
			LastRSSI:        rssi,
			Online:          true,
			LastSeenAt:      now,
		},
	}
	return gates, map[uint8]*domain.DetectedTimer{
		domain.SimHubTimerID: hub,
	}
}

func defaultSimLapRFLayoutLocked(now time.Time) ([]domain.TrackGate, map[uint8]*domain.DetectedTimer) {
	var rssi [domain.MaxPilotPoolSize]float32
	for i := range rssi {
		rssi[i] = 320
	}
	t1 := &domain.DetectedTimer{
		TimerID:         2,
		TimerLabel:      "L1",
		Color:           domain.DefaultGateColors[0],
		IsHub:           false,
		FirmwareVersion: "LapRF",
		Fingerprint:     "LAPRF001",
		BatteryMv:       12200,
		BatteryPct:      0,
		LastRSSI:        rssi,
		Online:          true,
		LastSeenAt:      now,
	}
	t2 := &domain.DetectedTimer{
		TimerID:         3,
		TimerLabel:      "L2",
		Color:           domain.DefaultGateColors[1],
		IsHub:           false,
		FirmwareVersion: "LapRF",
		Fingerprint:     "LAPRF002",
		BatteryMv:       12100,
		BatteryPct:      0,
		LastRSSI:        rssi,
		Online:          false,
		LastSeenAt:      time.Time{},
	}
	gates := []domain.TrackGate{
		{
			GateID:          1,
			AssignedTimerID: 2,
			TimerLabel:      "L1",
			FirmwareVersion: "LapRF",
			Color:           domain.DefaultGateColors[0],
			Role:            domain.GateRoleStartFinish,
			TrackOrder:      0,
			MapX:            0.25,
			MapY:            0.75,
			BatteryMv:       12200,
			BatteryPct:      0,
			LastRSSI:        rssi,
			Online:          true,
			LastSeenAt:      now,
		},
	}
	return gates, map[uint8]*domain.DetectedTimer{
		2: t1,
		3: t2,
	}
}

// SetTimingHardwareMode switches this engine between "slaprf" (XIAO ESP32-C5 Hub + Spokes),
// "laprf" (LapRF 8-Way timers), and "rotorhazard" (RotorHazard timing devices).
// In simulation mode (`isSim == true`), switching timing systems resets simulated boards and gates
// back to the clean default layout for that timing system so boards from different timing systems
// are never mixed or carried over.
func (e *Engine) SetTimingHardwareMode(mode domain.TimingHardwareMode, isSim bool) domain.TimingHardwareMode {
	next := domain.NormalizeTimingHardwareMode(mode)

	e.mu.Lock()
	cur := domain.NormalizeTimingHardwareMode(e.timingHardwareMode)
	if cur == next {
		e.mu.Unlock()
		return next
	}

	if isSim {
		e.savedSlapRFGates = nil
		e.savedSlapRFTimers = nil
		e.savedSlapRFBLEGates = nil
		e.savedSlapRFBLETimers = nil
		e.hasSavedSlapRFBLEState = false
		e.savedLapRFGates = nil
		e.savedLapRFTimers = nil
		e.hasSavedLapRFState = false
		e.savedRHGates = nil
		e.savedRHTimers = nil
		e.hasSavedRHState = false
		e.savedRHUSBGates = nil
		e.savedRHUSBTimers = nil
		e.hasSavedRHUSBState = false
		e.deletedSpokeFp = make(map[string]bool)
	} else {
		switch cur {
		case domain.HardwareModeSlapRFBLE:
			e.savedSlapRFBLEGates = append([]domain.TrackGate(nil), e.gates...)
			e.savedSlapRFBLETimers = cloneTimersMapToSlice(e.detected)
			e.hasSavedSlapRFBLEState = true
		case domain.HardwareModeLapRF:
			e.savedLapRFGates = append([]domain.TrackGate(nil), e.gates...)
			e.savedLapRFTimers = cloneTimersMapToSlice(e.detected)
			e.hasSavedLapRFState = true
		case domain.HardwareModeRotorHazard:
			e.savedRHGates = append([]domain.TrackGate(nil), e.gates...)
			e.savedRHTimers = cloneTimersMapToSlice(e.detected)
			e.hasSavedRHState = true
		case domain.HardwareModeRotorHazardUSB:
			e.savedRHUSBGates = append([]domain.TrackGate(nil), e.gates...)
			e.savedRHUSBTimers = cloneTimersMapToSlice(e.detected)
			e.hasSavedRHUSBState = true
		default:
			e.savedSlapRFGates = append([]domain.TrackGate(nil), e.gates...)
			e.savedSlapRFTimers = cloneTimersMapToSlice(e.detected)
		}
	}

	e.timingHardwareMode = next
	now := time.Now()
	if isSim {
		switch next {
		case domain.HardwareModeSlapRFBLE:
			e.gates, e.detected = defaultSimSlapRFBLELayoutLocked(now)
		case domain.HardwareModeLapRF:
			e.gates, e.detected = defaultSimLapRFLayoutLocked(now)
		case domain.HardwareModeRotorHazard, domain.HardwareModeRotorHazardUSB:
			e.gates, e.detected = defaultSimRHLayoutLocked(now)
		default:
			e.gates = domain.DefaultTrackGates()
			e.seedSimTimersLocked()
		}
	} else {
		switch next {
		case domain.HardwareModeSlapRFBLE:
			if e.hasSavedSlapRFBLEState {
				e.gates = append([]domain.TrackGate(nil), e.savedSlapRFBLEGates...)
				e.detected = restoreTimersSliceToMap(e.savedSlapRFBLETimers)
			} else {
				e.gates = []domain.TrackGate{}
				e.detected = make(map[uint8]*domain.DetectedTimer)
			}
		case domain.HardwareModeLapRF:
			if e.hasSavedLapRFState {
				e.gates = append([]domain.TrackGate(nil), e.savedLapRFGates...)
				e.detected = restoreTimersSliceToMap(e.savedLapRFTimers)
			} else {
				e.gates = []domain.TrackGate{}
				e.detected = make(map[uint8]*domain.DetectedTimer)
			}
		case domain.HardwareModeRotorHazard:
			if e.hasSavedRHState {
				e.gates = append([]domain.TrackGate(nil), e.savedRHGates...)
				e.detected = restoreTimersSliceToMap(e.savedRHTimers)
			} else {
				e.gates = []domain.TrackGate{}
				e.detected = make(map[uint8]*domain.DetectedTimer)
			}
		case domain.HardwareModeRotorHazardUSB:
			if e.hasSavedRHUSBState {
				e.gates = append([]domain.TrackGate(nil), e.savedRHUSBGates...)
				e.detected = restoreTimersSliceToMap(e.savedRHUSBTimers)
			} else {
				e.gates = []domain.TrackGate{}
				e.detected = make(map[uint8]*domain.DetectedTimer)
			}
		default:
			if len(e.savedSlapRFGates) > 0 || len(e.savedSlapRFTimers) > 0 {
				e.gates = append([]domain.TrackGate(nil), e.savedSlapRFGates...)
				e.detected = restoreTimersSliceToMap(e.savedSlapRFTimers)
			} else {
				e.gates = []domain.TrackGate{}
				e.detected = make(map[uint8]*domain.DetectedTimer)
			}
		}
	}

	e.progress = make(map[int]*pilotProgress)
	e.lastAcceptedUs = make(map[string]uint64)
	e.initDetectorsLocked()
	pSnap, rSnap := e.syncTrackToOpenSessionsAndRacesLocked()
	pilotsCopy := append([]domain.PilotSlot(nil), e.pilots...)
	gatesCopy := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilotsCopy, gatesCopy)
	}
	e.dispatchTrackSnapshotUpdates(pSnap, rSnap, subs)
	return next
}

// ActiveLapRFSlotSpecs computes the 8-slot RF setup for a given LapRF timer ID (using per-gate
// threshold overrides if that timer is assigned to a gate).
func (e *Engine) ActiveLapRFSlotSpecs(timerID uint8) [domain.MaxPilotSlots]LapRFSlotHardwareSpec {
	e.mu.RLock()
	defer e.mu.RUnlock()

	var out [domain.MaxPilotSlots]LapRFSlotHardwareSpec
	freqs, slotToPilot := ComputeActivePilotChannels(e.pilots)

	var boundGate *domain.TrackGate
	for i := range e.gates {
		if e.gates[i].AssignedTimerID == timerID {
			boundGate = &e.gates[i]
			break
		}
	}

	for ch := 0; ch < domain.MaxPilotSlots; ch++ {
		pIdx := slotToPilot[ch]
		if freqs[ch] == 0 || pIdx < 0 || pIdx >= len(e.pilots) {
			out[ch] = LapRFSlotHardwareSpec{
				Enabled:   false,
				Band:      domain.BandRaceband,
				Channel:   uint8(ch + 1),
				Threshold: domain.DefaultLapRFThreshold,
				Gain:      domain.DefaultLapRFGain,
			}
			continue
		}
		p := e.pilots[pIdx]
		thr := laprfThresholdFor(boundGate, pIdx, p)
		gain := p.AttenuationGain
		if gain == 0 {
			gain = domain.DefaultLapRFGain
		} else if gain > 63 {
			gain = 63
		}
		out[ch] = LapRFSlotHardwareSpec{
			Enabled:      true,
			Band:         p.Band,
			Channel:      p.Channel,
			FrequencyMHz: freqs[ch],
			Threshold:    thr,
			Gain:         gain,
		}
	}
	return out
}

// EnsureLapRFTimerRegistered registers or updates an external/simulated LapRF timer in `e.detected`
// and optionally binds it to Gate 1 (START_FINISH) if the course currently has no gates.
func (e *Engine) EnsureLapRFTimerRegistered(timerID uint8, label string, voltageMv uint16, autoBindFirstGate bool) uint8 {
	e.mu.Lock()
	if domain.NormalizeTimingHardwareMode(e.timingHardwareMode) != domain.HardwareModeLapRF {
		e.mu.Unlock()
		return timerID
	}
	if timerID < 2 || timerID > maxTimers {
		for candidate := uint8(2); candidate <= maxTimers; candidate++ {
			if _, taken := e.detected[candidate]; !taken {
				timerID = candidate
				break
			}
		}
		if timerID < 2 || timerID > maxTimers {
			timerID = 2
		}
	}

	now := time.Now()
	cleanLabel := normalizeLapRFTimerLabel(label, timerID)

	d, exists := e.detected[timerID]
	cfgChanged := false
	if !exists {
		var defaultRssi [domain.MaxPilotPoolSize]float32
		for i := range defaultRssi {
			defaultRssi[i] = 320
		}
		d = &domain.DetectedTimer{
			TimerID:         timerID,
			TimerLabel:      cleanLabel,
			Color:           domain.DefaultGateColors[int(timerID-2)%len(domain.DefaultGateColors)],
			IsHub:           false,
			FirmwareVersion: "LapRF",
			Fingerprint:     fmt.Sprintf("LAPRF%03d", timerID),
			BatteryMv:       voltageMv,
			BatteryPct:      0, // Neutral voltage only — never interpret LapRF input voltage as 1S %
			LastRSSI:        defaultRssi,
			Online:          true,
			LastSeenAt:      now,
		}
		e.detected[timerID] = d
		cfgChanged = true
	} else {
		if cleanLabel != "" && d.TimerLabel != cleanLabel {
			d.TimerLabel = cleanLabel
			for gi := range e.gates {
				if e.gates[gi].AssignedTimerID == timerID {
					e.gates[gi].TimerLabel = cleanLabel
				}
			}
			cfgChanged = true
		}
		if voltageMv > 0 {
			d.BatteryMv = voltageMv
		}
		d.BatteryPct = 0
		d.FirmwareVersion = "LapRF"
		d.Online = true
		d.LastSeenAt = now
	}

	var pSnap *domain.PracticeManagerState
	var rSnap *domain.RaceTournamentState
	if autoBindFirstGate && len(e.gates) == 0 {
		e.gates = []domain.TrackGate{
			{
				GateID:          1,
				AssignedTimerID: timerID,
				TimerLabel:      d.TimerLabel,
				FirmwareVersion: "LapRF",
				Color:           d.Color,
				Role:            domain.GateRoleStartFinish,
				TrackOrder:      0,
				MapX:            0.25,
				MapY:            0.75,
				BatteryMv:       d.BatteryMv,
				BatteryPct:      0,
				LastRSSI:        d.LastRSSI,
				Online:          true,
				LastSeenAt:      now,
			},
		}
		pSnap, rSnap = e.syncTrackToOpenSessionsAndRacesLocked()
		cfgChanged = true
	}

	var pilotsCopy []domain.PilotSlot
	var gatesCopy []domain.TrackGate
	var subs []EventSubscriber
	if cfgChanged {
		e.initDetectorsLocked()
		pilotsCopy = append([]domain.PilotSlot(nil), e.pilots...)
		gatesCopy = append([]domain.TrackGate(nil), e.gates...)
		subs = append([]EventSubscriber(nil), e.subscribers...)
	}
	e.mu.Unlock()

	if cfgChanged {
		for _, s := range subs {
			s.OnConfigUpdated(pilotsCopy, gatesCopy)
		}
		e.dispatchTrackSnapshotUpdates(pSnap, rSnap, subs)
	}
	return timerID
}

// IngestExternalLapRFStatus updates timer health, neutral voltage, live LapRF RSSI bars (300..3500),
// and active heat RSSI traces from a LapRF 0xDA0A STATUS heartbeat.
func (e *Engine) IngestExternalLapRFStatus(
	timerID uint8,
	label string,
	voltageMv uint16,
	slotRSSI [domain.MaxPilotSlots]float32,
) {
	now := time.Now()
	tsUs := e.NowUs()

	var raceChanged bool
	var raceCfgRestored bool
	var raceAnn *domain.RaceAnnouncement
	var raceSnap domain.RaceTournamentState

	e.mu.Lock()
	if domain.NormalizeTimingHardwareMode(e.timingHardwareMode) != domain.HardwareModeLapRF {
		e.mu.Unlock()
		return
	}
	if tickChanged, tickAnn, tickCfg, _, _, _ := e.tickRaceClockLocked(tsUs); tickChanged {
		raceChanged = true
		raceAnn = tickAnn
		raceCfgRestored = tickCfg
	}

	freqs, slotToPilot := ComputeActivePilotChannels(e.pilots)
	var mappedRSSI [domain.MaxPilotPoolSize]float32
	for i := range mappedRSSI {
		mappedRSSI[i] = 300
	}
	// Preserve direct 0..7 slot RSSI for inactive slots so NetworkView 8-slot bar monitor works even when slots are unassigned
	for ch := 0; ch < domain.MaxPilotSlots; ch++ {
		val := slotRSSI[ch]
		if val < 100 {
			val = 300
		}
		if freqs[ch] > 0 {
			pIdx := slotToPilot[ch]
			if pIdx >= 0 && pIdx < domain.MaxPilotPoolSize {
				mappedRSSI[pIdx] = val
			}
		} else if ch < domain.MaxPilotPoolSize {
			mappedRSSI[ch] = val
		}
	}

	d, ok := e.detected[timerID]
	if !ok {
		d = &domain.DetectedTimer{
			TimerID:         timerID,
			TimerLabel:      label,
			Color:           domain.DefaultGateColors[int(timerID)%len(domain.DefaultGateColors)],
			FirmwareVersion: "LapRF",
		}
		e.detected[timerID] = d
	}
	if label != "" {
		d.TimerLabel = label
	}
	d.Online = true
	d.LastSeenAt = now
	d.FramesRxCount++
	d.LastRSSI = mappedRSSI
	if voltageMv > 0 {
		d.BatteryMv = voltageMv
	}
	d.BatteryPct = 0

	var boundGate *domain.TrackGate
	for i := range e.gates {
		if e.gates[i].AssignedTimerID == timerID {
			boundGate = &e.gates[i]
			break
		}
	}

	frameTimerID := timerID
	if boundGate != nil {
		boundGate.Online = true
		boundGate.LastSeenAt = now
		boundGate.FramesRxCount++
		boundGate.LastRSSI = mappedRSSI
		if voltageMv > 0 {
			boundGate.BatteryMv = voltageMv
		}
		boundGate.BatteryPct = 0
		if d.TimerLabel != "" {
			boundGate.TimerLabel = d.TimerLabel
		}
		boundGate.FirmwareVersion = "LapRF"
		frameTimerID = boundGate.GateID

		if boundGate.Role == domain.GateRoleStartFinish {
			for i := 0; i < len(e.pilots) && i < domain.MaxPilotPoolSize; i++ {
				p := e.pilots[i]
				if p.Enabled && p.Channel > 0 {
					thr := laprfThresholdFor(boundGate, i, p)
					e.recordHeatRssiSampleLocked(p.SlotIndex, tsUs, mappedRSSI[i], thr, thr)
				}
			}
		}
	}

	frame := domain.TimerTelemetryFrame{
		TimerID:       frameTimerID,
		SeqNum:        uint32(d.FramesRxCount),
		TimestampUs:   tsUs,
		RSSI:          mappedRSSI,
		BatteryMv:     d.BatteryMv,
		NoiseFloorDbm: 300,
	}

	var pilotsCopy []domain.PilotSlot
	var gatesCopy []domain.TrackGate
	if raceChanged {
		e.resolveActiveTournamentLocked()
		e.syncActiveRaceToEventLocked()
		raceSnap = cloneRaceState(e.raceState)
		if raceCfgRestored {
			pilotsCopy = append([]domain.PilotSlot(nil), e.pilots...)
			gatesCopy = append([]domain.TrackGate(nil), e.gates...)
		}
	}
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		if raceCfgRestored {
			s.OnConfigUpdated(pilotsCopy, gatesCopy)
		}
		s.OnTelemetryFrame(frame)
	}
	if raceChanged {
		e.notifyRaceUpdated(raceSnap, raceAnn, subs)
	}
}

// InjectExternalLapRFCrossing scores a hardware-detected 0xDA09 PASSING record from an external
// or simulated ImmersionRC LapRF 8-Way timer through the exact same lap/sector/race rules as SlapRF.
func (e *Engine) InjectExternalLapRFCrossing(
	timerID uint8,
	hwSlotIdx int,
	timestampUs uint64,
	peakHeight float32,
	passingNum uint32,
) {
	if hwSlotIdx < 1 || hwSlotIdx > domain.MaxPilotSlots {
		return
	}
	if timestampUs == 0 {
		timestampUs = e.NowUs()
	}
	if peakHeight <= 0 {
		peakHeight = 1200
	}

	var accepted *domain.GateCrossingEvent
	var filtered []domain.FilteredDetection
	var completedLap *domain.LapRecord
	var summariesSnapshot []domain.PilotTrackSummary
	var raceChanged bool
	var raceCfgRestored bool
	var raceAnn *domain.RaceAnnouncement
	var raceSnap domain.RaceTournamentState
	var practiceChanged bool
	var practiceSnap domain.PracticeManagerState

	e.mu.Lock()
	if domain.NormalizeTimingHardwareMode(e.timingHardwareMode) != domain.HardwareModeLapRF {
		e.mu.Unlock()
		return
	}
	freqs, slotToPilot := ComputeActivePilotChannels(e.pilots)
	if freqs[hwSlotIdx-1] == 0 {
		e.mu.Unlock()
		return
	}
	pPos := slotToPilot[hwSlotIdx-1]
	if pPos < 0 || pPos >= len(e.pilots) {
		e.mu.Unlock()
		return
	}
	pilot := e.pilots[pPos]
	if !pilot.Enabled || pilot.Channel == 0 {
		e.mu.Unlock()
		return
	}

	var gate *domain.TrackGate
	for i := range e.gates {
		if e.gates[i].AssignedTimerID == timerID {
			gate = &e.gates[i]
			break
		}
	}
	if gate == nil {
		e.mu.Unlock()
		return
	}

	if gate.Role == domain.GateRoleStartFinish {
		thr := laprfThresholdFor(gate, pPos, pilot)
		e.recordHeatRssiSampleLocked(pilot.SlotIndex, timestampUs, peakHeight, thr, thr)
	}

	if !e.raceArmed {
		e.mu.Unlock()
		return
	}

	// Approximate equivalent dBm for legacy displays while preserving exact LapRFPeakHeight
	approxDbm := float32(math.Min(-22.0, math.Max(-85.0, -58.0+float64(peakHeight-800.0)/40.0)))
	ev := domain.GateCrossingEvent{
		GateID:            gate.GateID,
		GateName:          e.gateLabelLocked(gate.GateID),
		IsStartFinish:     gate.Role == domain.GateRoleStartFinish,
		SlotIndex:         pilot.SlotIndex,
		Callsign:          pilot.Callsign,
		FrequencyMHz:      pilot.FrequencyMHz,
		TimestampUs:       timestampUs,
		PeakRSSIDbm:       approxDbm,
		LapRFPeakHeight:   peakHeight,
		BeamwidthMs:       110.0,
		EstimatedSpeedMph: 58.0,
	}

	out := e.applyCrossingLocked(pilot, *gate, ev)
	if out.rejected != nil {
		filtered = append(filtered, e.storeFilteredLocked(*out.rejected))
	} else {
		e.nextEventID++
		e.passingNumbers[gate.GateID]++
		ev.EventID = e.nextEventID
		if passingNum > e.passingNumbers[gate.GateID] {
			e.passingNumbers[gate.GateID] = passingNum
		}
		ev.PassingNumber = e.passingNumbers[gate.GateID]
		ev.StartedLap = ev.IsStartFinish && out.lap == nil
		e.crossings = append(e.crossings, ev)
		if len(e.crossings) > maxStoredCrossings {
			e.crossings = e.crossings[len(e.crossings)-maxStoredCrossings:]
		}
		evCopy := ev
		accepted = &evCopy

		if out.note != nil {
			filtered = append(filtered, e.storeFilteredLocked(*out.note))
		}
		if out.lap != nil {
			e.laps = append(e.laps, *out.lap)
			if len(e.laps) > maxStoredLaps {
				e.laps = e.laps[len(e.laps)-maxStoredLaps:]
			}
			lapCopy := *out.lap
			completedLap = &lapCopy
			summariesSnapshot = e.computeSummariesLocked()
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

	if !e.isLiveRaceHeatActiveLocked() && e.practiceState.ActiveSessionID != "" &&
		(accepted != nil || completedLap != nil || len(filtered) > 0) {
		e.syncActivePracticeRecordsLocked()
		if completedLap != nil {
			practiceChanged = true
			practiceSnap = clonePracticeManagerState(e.practiceState)
		}
	}

	var pilotsCopy []domain.PilotSlot
	var gatesCopy []domain.TrackGate
	if raceChanged {
		e.resolveActiveTournamentLocked()
		e.syncActiveRaceToEventLocked()
		raceSnap = cloneRaceState(e.raceState)
		if raceCfgRestored {
			pilotsCopy = append([]domain.PilotSlot(nil), e.pilots...)
			gatesCopy = append([]domain.TrackGate(nil), e.gates...)
		}
	}
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		if raceCfgRestored {
			s.OnConfigUpdated(pilotsCopy, gatesCopy)
		}
		for _, f := range filtered {
			s.OnDetectionFiltered(f)
		}
		if accepted != nil {
			s.OnGateCrossing(*accepted)
		}
		if completedLap != nil {
			s.OnLapCompleted(*completedLap, summariesSnapshot)
		}
	}
	if practiceChanged {
		e.notifyPracticeUpdated(practiceSnap, subs)
	}
	if raceChanged {
		e.notifyRaceUpdated(raceSnap, raceAnn, subs)
	}
}
