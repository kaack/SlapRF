package tracker

import (
	"fmt"
	"math"
	"strings"
	"time"

	"slaprf/internal/domain"
)

// RHNodeHardwareSpec describes one of the RX5808 receiver nodes (0..7) inside a RotorHazard timing device.
type RHNodeHardwareSpec struct {
	Enabled      bool        `json:"enabled"`
	Band         domain.Band `json:"band"`
	Channel      uint8       `json:"channel"`
	FrequencyMHz uint16      `json:"frequencyMhz"`
	EnterAtLevel uint8       `json:"enterAtLevel"`
	ExitAtLevel  uint8       `json:"exitAtLevel"`
}

func normalizeRHTimerLabel(label string, timerID uint8) string {
	unitNum := int(timerID) - 1
	if unitNum < 1 {
		unitNum = 1
	}
	clean := strings.TrimSpace(label)
	lower := strings.ToLower(clean)
	if clean == "" || strings.HasPrefix(lower, "rotorhazard #") || strings.HasPrefix(lower, "rh (") {
		return fmt.Sprintf("R%d", unitNum)
	}
	if len(lower) >= 3 && strings.HasPrefix(lower, "rh") {
		allDigits := true
		for i := 2; i < len(lower); i++ {
			if lower[i] < '0' || lower[i] > '9' {
				allDigits = false
				break
			}
		}
		if allDigits {
			return "R" + clean[2:]
		}
	}
	return clean
}

func defaultSimRHLayoutLocked(now time.Time) ([]domain.TrackGate, map[uint8]*domain.DetectedTimer) {
	var rssi [domain.MaxPilotPoolSize]float32
	for i := range rssi {
		rssi[i] = 24
	}
	t1 := &domain.DetectedTimer{
		TimerID:         2,
		TimerLabel:      "R1",
		Color:           domain.DefaultGateColors[0],
		IsHub:           false,
		FirmwareVersion: "RotorHazard",
		Fingerprint:     "RH000001",
		BatteryMv:       0,
		BatteryPct:      0,
		NoiseFloorDbm:   24,
		LastRSSI:        rssi,
		Online:          true,
		LastSeenAt:      now,
	}
	t2 := &domain.DetectedTimer{
		TimerID:         3,
		TimerLabel:      "R2",
		Color:           domain.DefaultGateColors[1],
		IsHub:           false,
		FirmwareVersion: "RotorHazard",
		Fingerprint:     "RH000002",
		BatteryMv:       0,
		BatteryPct:      0,
		NoiseFloorDbm:   24,
		LastRSSI:        rssi,
		Online:          false,
		LastSeenAt:      time.Time{},
	}
	gates := []domain.TrackGate{
		{
			GateID:          1,
			AssignedTimerID: 2,
			TimerLabel:      "R1",
			FirmwareVersion: "RotorHazard",
			Color:           domain.DefaultGateColors[0],
			Role:            domain.GateRoleStartFinish,
			TrackOrder:      0,
			MapX:            0.25,
			MapY:            0.75,
			BatteryMv:       0,
			BatteryPct:      0,
			NoiseFloorDbm:   24,
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

// SetRHDebugStream enables or disables idle RF debug streaming on a RotorHazard timer (`#/debug`)
// when no active race heat or practice session is currently occupying the receiver nodes.
func (e *Engine) SetRHDebugStream(timerID uint8, active bool) {
	e.mu.Lock()
	if e.rhDebugStreamTimers == nil {
		e.rhDebugStreamTimers = make(map[uint8]bool)
	}
	changed := false
	if timerID == 0 {
		if !active && len(e.rhDebugStreamTimers) > 0 {
			clear(e.rhDebugStreamTimers)
			changed = true
		}
	} else {
		prev := e.rhDebugStreamTimers[timerID]
		if active && !prev {
			e.rhDebugStreamTimers[timerID] = true
			changed = true
		} else if !active && prev {
			delete(e.rhDebugStreamTimers, timerID)
			changed = true
		}
	}
	var pilotsCopy []domain.PilotSlot
	var gatesCopy []domain.TrackGate
	var subs []EventSubscriber
	if changed {
		pilotsCopy = append([]domain.PilotSlot(nil), e.pilots...)
		gatesCopy = append([]domain.TrackGate(nil), e.gates...)
		subs = append([]EventSubscriber(nil), e.subscribers...)
	}
	e.mu.Unlock()

	if changed {
		for _, s := range subs {
			s.OnConfigUpdated(pilotsCopy, gatesCopy)
		}
	}
}

// ActiveRHNodeSpecs computes the 8-node RX5808 RF & dual-threshold configuration for a given
// RotorHazard device ID (using per-gate `rhEnterThresholds` / `rhExitThresholds` if bound to a gate).
func (e *Engine) ActiveRHNodeSpecs(timerID uint8) [domain.MaxPilotSlots]RHNodeHardwareSpec {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.activeRHNodeSpecsLocked(timerID)
}

func (e *Engine) activeRHNodeSpecsLocked(timerID uint8) [domain.MaxPilotSlots]RHNodeHardwareSpec {
	var out [domain.MaxPilotSlots]RHNodeHardwareSpec
	freqs, slotToPilot := ComputeActivePilotChannels(e.pilots)

	var boundGate *domain.TrackGate
	for i := range e.gates {
		if e.gates[i].AssignedTimerID == timerID {
			boundGate = &e.gates[i]
			break
		}
	}

	hasActiveSessionChannels := false
	for ch := 0; ch < domain.MaxPilotSlots; ch++ {
		if freqs[ch] > 0 {
			hasActiveSessionChannels = true
			break
		}
	}

	// When no race heat or practice session is active, allow `#/debug` Stream to tune nodes
	// across standard Raceband R1..R8 so the operator can monitor live node RSSI & channel noise.
	if !hasActiveSessionChannels && e.rhDebugStreamTimers != nil && e.rhDebugStreamTimers[timerID] {
		for ch := 0; ch < domain.MaxPilotSlots; ch++ {
			rbCh := uint8(ch + 1)
			en := float32(domain.DefaultRHEnterThreshold)
			ex := float32(domain.DefaultRHExitThreshold)
			for pIdx, p := range e.pilots {
				if p.Band == domain.BandRaceband && p.Channel == rbCh {
					en, ex = rhThresholdsFor(boundGate, pIdx, p)
					break
				}
			}
			out[ch] = RHNodeHardwareSpec{
				Enabled:      true,
				Band:         domain.BandRaceband,
				Channel:      rbCh,
				FrequencyMHz: domain.RacebandFrequenciesMHz[ch],
				EnterAtLevel: uint8(math.Round(float64(en))),
				ExitAtLevel:  uint8(math.Round(float64(ex))),
			}
		}
		return out
	}

	for ch := 0; ch < domain.MaxPilotSlots; ch++ {
		pIdx := slotToPilot[ch]
		if freqs[ch] == 0 || pIdx < 0 || pIdx >= len(e.pilots) {
			out[ch] = RHNodeHardwareSpec{
				Enabled:      false,
				Band:         domain.BandRaceband,
				Channel:      uint8(ch + 1),
				FrequencyMHz: 0,
				EnterAtLevel: uint8(domain.DefaultRHEnterThreshold),
				ExitAtLevel:  uint8(domain.DefaultRHExitThreshold),
			}
			continue
		}
		p := e.pilots[pIdx]
		en, ex := rhThresholdsFor(boundGate, pIdx, p)
		out[ch] = RHNodeHardwareSpec{
			Enabled:      true,
			Band:         p.Band,
			Channel:      p.Channel,
			FrequencyMHz: freqs[ch],
			EnterAtLevel: uint8(math.Round(float64(en))),
			ExitAtLevel:  uint8(math.Round(float64(ex))),
		}
	}
	return out
}

// EnsureRHTimerRegistered registers or updates an external/simulated RotorHazard device in `e.detected`
// and optionally binds it to Gate 1 (START_FINISH) if the course currently has no gates.
func (e *Engine) EnsureRHTimerRegistered(timerID uint8, label string, autoBindFirstGate bool) uint8 {
	e.mu.Lock()
	if !domain.IsRotorHazardMode(e.timingHardwareMode) {
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
	cleanLabel := normalizeRHTimerLabel(label, timerID)

	d, exists := e.detected[timerID]
	cfgChanged := false
	if !exists {
		var defaultRssi [domain.MaxPilotPoolSize]float32
		for i := range defaultRssi {
			defaultRssi[i] = 24
		}
		d = &domain.DetectedTimer{
			TimerID:         timerID,
			TimerLabel:      cleanLabel,
			Color:           domain.DefaultGateColors[int(timerID-2)%len(domain.DefaultGateColors)],
			IsHub:           false,
			FirmwareVersion: "RotorHazard",
			Fingerprint:     fmt.Sprintf("RH%06d", timerID),
			BatteryMv:       0,
			BatteryPct:      0,
			NoiseFloorDbm:   24,
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
		d.BatteryMv = 0
		d.BatteryPct = 0
		d.FirmwareVersion = "RotorHazard"
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
				FirmwareVersion: "RotorHazard",
				Color:           d.Color,
				Role:            domain.GateRoleStartFinish,
				TrackOrder:      0,
				MapX:            0.25,
				MapY:            0.75,
				BatteryMv:       0,
				BatteryPct:      0,
				NoiseFloorDbm:   24,
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

// IngestExternalRHHeartbeat updates RotorHazard device health, live 0..255 node RSSI telemetry,
// and active heat RSSI traces from a RotorHazard `heartbeat` event.
func (e *Engine) IngestExternalRHHeartbeat(
	timerID uint8,
	label string,
	slotRSSI [domain.MaxPilotSlots]float32,
) {
	now := time.Now()
	tsUs := e.NowUs()

	var raceChanged bool
	var raceCfgRestored bool
	var raceAnn *domain.RaceAnnouncement
	var raceSnap domain.RaceTournamentState

	e.mu.Lock()
	if !domain.IsRotorHazardMode(e.timingHardwareMode) {
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
		mappedRSSI[i] = 20
	}
	for ch := 0; ch < domain.MaxPilotSlots; ch++ {
		val := slotRSSI[ch]
		if val < 0 {
			val = 0
		} else if val > 255 {
			val = 255
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
			TimerLabel:      normalizeRHTimerLabel(label, timerID),
			Color:           domain.DefaultGateColors[int(timerID)%len(domain.DefaultGateColors)],
			FirmwareVersion: "RotorHazard",
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
	d.BatteryMv = 0
	d.BatteryPct = 0
	d.NoiseFloorDbm = 24

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
		boundGate.BatteryMv = 0
		boundGate.BatteryPct = 0
		boundGate.NoiseFloorDbm = 24
		if d.TimerLabel != "" {
			boundGate.TimerLabel = d.TimerLabel
		}
		boundGate.FirmwareVersion = "RotorHazard"
		frameTimerID = boundGate.GateID

		if boundGate.Role == domain.GateRoleStartFinish {
			for i := 0; i < len(e.pilots) && i < domain.MaxPilotPoolSize; i++ {
				p := e.pilots[i]
				if p.Enabled && p.Channel > 0 {
					en, ex := rhThresholdsFor(boundGate, i, p)
					e.recordHeatRssiSampleLocked(p.SlotIndex, tsUs, mappedRSSI[i], en, ex)
				}
			}
		}
	}

	frame := domain.TimerTelemetryFrame{
		TimerID:       frameTimerID,
		SeqNum:        uint32(d.FramesRxCount),
		TimestampUs:   tsUs,
		RSSI:          mappedRSSI,
		BatteryMv:     0,
		NoiseFloorDbm: 24,
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

// InjectExternalRHCrossing scores a RotorHazard `pass_record` from a physical or simulated
// RotorHazard device through the exact same multi-gate lap/sector/race rules as SlapRF and LapRF.
func (e *Engine) InjectExternalRHCrossing(
	timerID uint8,
	hwSlotIdx int,
	timestampUs uint64,
	peakRSSI float32,
	passingNum uint32,
) {
	if hwSlotIdx < 1 || hwSlotIdx > domain.MaxPilotSlots {
		return
	}
	if timestampUs == 0 {
		timestampUs = e.NowUs()
	}
	if peakRSSI <= 0 {
		peakRSSI = 180
	} else if peakRSSI > 255 {
		peakRSSI = 255
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
	if !domain.IsRotorHazardMode(e.timingHardwareMode) {
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
		en, ex := rhThresholdsFor(gate, pPos, pilot)
		e.recordHeatRssiSampleLocked(pilot.SlotIndex, timestampUs, peakRSSI, en, ex)
	}

	if !e.raceArmed {
		e.mu.Unlock()
		return
	}

	// Store native 0..255 peak RSSI on HeatCrossing/GateCrossingEvent while mapping LapRFPeakHeight for LapRF emulator bridges
	laprfEq := float32(math.Min(3200.0, math.Max(400.0, 320.0+float64(peakRSSI)*10.5)))
	ev := domain.GateCrossingEvent{
		GateID:            gate.GateID,
		GateName:          e.gateLabelLocked(gate.GateID),
		IsStartFinish:     gate.Role == domain.GateRoleStartFinish,
		SlotIndex:         pilot.SlotIndex,
		Callsign:          pilot.Callsign,
		FrequencyMHz:      pilot.FrequencyMHz,
		TimestampUs:       timestampUs,
		PeakRSSIDbm:       peakRSSI,
		LapRFPeakHeight:   laprfEq,
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
