package tracker

import (
	"fmt"
	"math"
	"math/rand/v2"
	"sort"
	"strings"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/race"
)

// RaceEventSubscriber is an optional interface implemented by stream subscribers that want
// real-time Race Mode tournament/heat updates, Event manager state, and voice-announcer cues.
type RaceEventSubscriber interface {
	OnRaceUpdated(state domain.RaceTournamentState, eventState domain.EventManagerState, announcement *domain.RaceAnnouncement)
}

func newDefaultRaceState() domain.RaceTournamentState {
	cfg := domain.DefaultRaceSetupConfig()
	cfg.EventName = "Race 1 · Open Class"
	return domain.RaceTournamentState{
		RaceID:           "race-1",
		Lifecycle:        domain.LifecycleDraft,
		Mode:             domain.ModePractice,
		Config:           cfg,
		Generated:        false,
		ActiveStageIndex: 1,
		TotalStages:      1,
		Heats:            []domain.RaceHeat{},
		Edges:            []domain.BracketEdge{},
		Standings:        []domain.TournamentStanding{},
	}
}

func (e *Engine) notifyRaceUpdated(state domain.RaceTournamentState, ann *domain.RaceAnnouncement, subs []EventSubscriber) {
	if len(subs) == 0 {
		return
	}
	e.mu.RLock()
	eventSnap := cloneEventManagerState(e.eventState)
	e.mu.RUnlock()
	for _, s := range subs {
		if rs, ok := s.(RaceEventSubscriber); ok {
			rs.OnRaceUpdated(state, eventSnap, ann)
		}
	}
}

// OperatingMode returns the active mode ("practice" or "race").
func (e *Engine) OperatingMode() domain.OperatingMode {
	e.mu.RLock()
	defer e.mu.RUnlock()
	if e.raceState.Mode == domain.ModeRace {
		return domain.ModeRace
	}
	return domain.ModePractice
}

// RaceSnapshot advances any live countdown / heat timer to `NowUs()` and returns a deep copy of
// the Race Mode tournament state.
func (e *Engine) RaceSnapshot() domain.RaceTournamentState {
	nowUs := e.NowUs()
	e.mu.Lock()
	changed, ann, cfgChanged, pilotsCopy, gatesCopy, subs := e.tickRaceClockLocked(nowUs)
	snap := cloneRaceState(e.raceState)
	e.mu.Unlock()

	if cfgChanged {
		for _, s := range subs {
			s.OnConfigUpdated(pilotsCopy, gatesCopy)
		}
	}
	if changed {
		e.notifyRaceUpdated(snap, ann, subs)
	}
	return snap
}

// TickRaceClock advances live heat countdowns and race timers, firing real-time stream updates
// when a countdown reaches 0 (start horn!) or when a timed heat expires.
func (e *Engine) TickRaceClock() {
	nowUs := e.NowUs()
	e.mu.Lock()
	if !e.raceState.Generated {
		e.mu.Unlock()
		return
	}
	changed, ann, cfgChanged, pilotsCopy, gatesCopy, subs := e.tickRaceClockLocked(nowUs)
	var snap domain.RaceTournamentState
	if changed {
		snap = cloneRaceState(e.raceState)
	}
	e.mu.Unlock()

	if cfgChanged {
		for _, s := range subs {
			s.OnConfigUpdated(pilotsCopy, gatesCopy)
		}
	}
	if changed {
		e.notifyRaceUpdated(snap, ann, subs)
	}
}

func (e *Engine) tickRaceClockLocked(nowUs uint64) (
	changed bool,
	ann *domain.RaceAnnouncement,
	cfgChanged bool,
	pilotsCopy []domain.PilotSlot,
	gatesCopy []domain.TrackGate,
	subs []EventSubscriber,
) {
	if !e.raceState.Generated {
		return false, nil, false, nil, nil, nil
	}
	h := e.findLiveRunningHeatLocked()
	if h == nil {
		return false, nil, false, nil, nil, nil
	}
	if e.raceState.ActiveHeatID != h.ID {
		e.raceState.ActiveHeatID = h.ID
	}

	switch h.State {
	case domain.HeatCountdown:
		nomSec := h.CountdownDurationSec
		if nomSec <= 0 {
			nomSec = e.raceState.Config.CountdownSec
		}
		if nomSec <= 0 {
			nomSec = 5
		}
		nominalEndUs := h.CountdownStartUs + uint64(nomSec)*1_000_000
		if nowUs >= h.CountdownEndUs {
			h.State = domain.HeatRunning
			h.StartToneUs = h.CountdownEndUs
			if h.StartToneUs == 0 {
				h.StartToneUs = nowUs
			}
			var beepAtSec float64
			if h.CountdownStartUs > 0 && nominalEndUs > h.StartToneUs {
				beepAtSec = math.Round(float64(nominalEndUs-h.StartToneUs)/1e4) / 100
			}
			h.CountdownBeeped = true
			h.CountdownBeepAtSec = beepAtSec
			h.CountdownArmRemainingSec = 0
			h.CountdownPrompted = true
			// Re-anchor any pre-horn countdown RSSI samples so OffsetMs == 0 is the exact Start Horn!
			if h.CountdownStartUs > 0 && h.StartToneUs >= h.CountdownStartUs {
				shiftMs := int32((h.StartToneUs - h.CountdownStartUs) / 1000)
				for i := range h.Seats {
					if len(h.Seats[i].RssiTrace) == 0 {
						continue
					}
					kept := h.Seats[i].RssiTrace[:0]
					for _, pt := range h.Seats[i].RssiTrace {
						pt.OffsetMs -= shiftMs
						if pt.OffsetMs >= -3000 {
							kept = append(kept, pt)
						}
					}
					h.Seats[i].RssiTrace = kept
				}
			}
			h.CountdownRemainingSec = 0
			h.ElapsedSec = float64(nowUs-h.StartToneUs) / 1e6
			for i := range h.Seats {
				if h.Seats[i].PilotSlotIndex > 0 &&
					h.Seats[i].Status != domain.PilotHeatDQ &&
					h.Seats[i].Status != domain.PilotHeatDNF &&
					h.Seats[i].Status != domain.PilotHeatDNS {
					h.Seats[i].Status = domain.PilotHeatRacing
				}
			}
			e.resetSessionLocked()
			e.raceArmed = true
			changed = true
			ann = &domain.RaceAnnouncement{Kind: "start_horn", HeatID: h.ID}
		} else {
			if !h.CountdownPrompted && h.CountdownPromptUs > 0 && nowUs >= h.CountdownPromptUs {
				h.CountdownPrompted = true
				changed = true
				ann = &domain.RaceAnnouncement{
					Kind:         "countdown_prompt",
					HeatID:       h.ID,
					CountdownSec: nomSec,
				}
			}
			if h.CountdownStartUs > 0 && nowUs < h.CountdownStartUs {
				h.CountdownArmRemainingSec = float64(h.CountdownStartUs-nowUs) / 1e6
				h.CountdownRemainingSec = float64(nomSec)
			} else {
				if h.CountdownArmRemainingSec > 0 {
					h.CountdownArmRemainingSec = 0
					changed = true
				}
				if nominalEndUs > nowUs {
					h.CountdownRemainingSec = float64(nominalEndUs-nowUs) / 1e6
				} else {
					h.CountdownRemainingSec = 0
				}
			}
		}

	case domain.HeatRunning:
		if h.StartToneUs > 0 && nowUs >= h.StartToneUs {
			h.ElapsedSec = float64(nowUs-h.StartToneUs) / 1e6
		}
		if h.TimeLimitSec > 0 && h.ElapsedSec >= float64(h.TimeLimitSec) {
			graceSec := float64(e.raceState.Config.OvertimeGraceSec)
			if !h.InOvertime && graceSec > 0 && e.hasPilotMidLapLocked(h) {
				h.InOvertime = true
				h.OvertimeStartedAtUs = nowUs
				changed = true
				ann = &domain.RaceAnnouncement{
					Kind:        "overtime",
					HeatID:      h.ID,
					Text:        "Time expired, finish your lap",
					Competitive: isCompetitiveHeat(h),
					TimedOut:    true,
				}
			} else if !h.InOvertime || !e.hasPilotMidLapLocked(h) ||
				(h.OvertimeStartedAtUs > 0 && float64(nowUs-h.OvertimeStartedAtUs)/1e6 >= graceSec) {
				wasInOvertime := h.InOvertime
				ann = e.finishHeatLocked(h)
				if ann != nil && !wasInOvertime {
					ann.TimedOut = true
				}
				if e.exitLiveRaceHeatLocked() {
					cfgChanged = true
				}
				changed = true
			}
		}
	}

	if changed {
		e.syncActiveRaceToEventLocked()
		subs = append([]EventSubscriber(nil), e.subscribers...)
		pilotsCopy = append([]domain.PilotSlot(nil), e.pilots...)
		gatesCopy = append([]domain.TrackGate(nil), e.gates...)
	}
	return
}

func (e *Engine) hasPilotMidLapLocked(h *domain.RaceHeat) bool {
	for _, s := range h.Seats {
		if s.PilotSlotIndex <= 0 || s.Status != domain.PilotHeatRacing {
			continue
		}
		// Pilot has started at least their holeshot and is still actively flying a lap
		if len(s.Crossings) > 0 && !allInvalidCrossings(s.Crossings) {
			return true
		}
	}
	return false
}

func allInvalidCrossings(cs []domain.HeatCrossing) bool {
	for _, c := range cs {
		if !c.Invalidated {
			return false
		}
	}
	return true
}

func (e *Engine) finishHeatLocked(h *domain.RaceHeat) *domain.RaceAnnouncement {
	wasInOvertime := h.InOvertime
	h.State = domain.HeatFinished
	h.ExecutedAtMs = time.Now().UnixMilli()
	h.InOvertime = false
	h.CountdownRemainingSec = 0
	e.raceArmed = false
	for i := range h.Seats {
		s := &h.Seats[i]
		if s.PilotSlotIndex <= 0 {
			continue
		}
		if s.Status == domain.PilotHeatRacing {
			if h.StageFormat == domain.FormatQualifying || h.TargetLaps == 0 {
				if s.LapsCompleted > 0 {
					s.Status = domain.PilotHeatFinished
				} else {
					s.Status = domain.PilotHeatDNF
				}
			} else if s.LapsCompleted >= h.TargetLaps {
				s.Status = domain.PilotHeatFinished
			} else {
				s.Status = domain.PilotHeatDNF
			}
		}
	}
	race.RecomputeHeat(h, e.raceState.Config.QualifyingMetric)
	e.markHeatUnsyncedMGPLocked(h.ID)
	winnerCallsign := ""
	winnerSlot := 0
	for _, s := range h.Seats {
		if s.PilotSlotIndex > 0 && s.Position == 1 && s.Status != domain.PilotHeatDQ && s.Status != domain.PilotHeatDNS {
			winnerCallsign = s.Callsign
			winnerSlot = s.PilotSlotIndex
			break
		}
	}
	return &domain.RaceAnnouncement{
		Kind:               "heat_finished",
		HeatID:             h.ID,
		SlotIndex:          winnerSlot,
		Callsign:           winnerCallsign,
		Position:           1,
		Competitive:        isCompetitiveHeat(h),
		HornAlreadySounded: wasInOvertime,
	}
}

func (e *Engine) markHeatUnsyncedMGPLocked(heatID string) {
	if heatID == "" || e.raceState.MGPLink == nil {
		return
	}
	if e.raceState.MGPLink.UnsyncedHeats == nil {
		e.raceState.MGPLink.UnsyncedHeats = make(map[string]bool)
	}
	e.raceState.MGPLink.UnsyncedHeats[heatID] = true
}

func isCompetitiveHeat(h *domain.RaceHeat) bool {
	if h == nil {
		return false
	}
	if h.StartMode != domain.StartModeHeadsUp {
		return false
	}
	return h.StageFormat != domain.FormatQualifying && h.StageFormat != domain.FormatOpenQualifier
}

func heatHasAnyValidCrossing(h *domain.RaceHeat) bool {
	if h == nil {
		return false
	}
	for _, s := range h.Seats {
		if s.PilotSlotIndex <= 0 {
			continue
		}
		if len(s.Crossings) > 0 && !allInvalidCrossings(s.Crossings) {
			return true
		}
	}
	return false
}

// AddPilot appends a new pilot to the global pilot directory (unlimited roster size).
func (e *Engine) AddPilot(callsign string, phoneticName string) error {
	e.mu.Lock()
	maxSlot := 0
	for _, p := range e.pilots {
		if p.SlotIndex > maxSlot {
			maxSlot = p.SlotIndex
		}
	}
	newSlot := maxSlot + 1
	name := strings.TrimSpace(callsign)
	if name == "" {
		name = e.nextDefaultPilotNameLocked(newSlot)
	} else if e.hasPilotCallsignLocked(name, 0) {
		e.mu.Unlock()
		return fmt.Errorf("pilot callsign %q already exists", name)
	}
	p := domain.PilotSlot{
		SlotIndex:       newSlot,
		Callsign:        name,
		PhoneticName:    strings.TrimSpace(phoneticName),
		Enabled:         false,
		Band:            domain.BandRaceband,
		Channel:         0,
		FrequencyMHz:    0,
		EnterThreshold:  -58.0,
		ExitThreshold:   -68.0,
		LapRFThreshold:  domain.DefaultLapRFThreshold,
		AttenuationGain: domain.DefaultLapRFGain,
		Color:           domain.DefaultPilotColors[(newSlot-1)%len(domain.DefaultPilotColors)],
	}
	e.pilots = append(e.pilots, p)
	if e.practiceSnap.Saved {
		e.practiceSnap.Pilots = append(e.practiceSnap.Pilots, p)
	}
	e.initDetectorsLocked()
	e.syncGlobalPilotsToOpenEventsLocked(&p, 0)
	e.syncGlobalPilotsToPracticeSessionsLocked(0)

	if e.raceState.Generated && e.raceState.Lifecycle == domain.LifecycleDraft &&
		!e.hasAnyStartedRaceHeatLocked() && !hasAnyManualLocksInState(&e.raceState) {
		// Draft tournament with no manual bracket edits yet: regenerate cleanly so the new pilot is included!
		if e.raceState.TemplateID != "custom" && len(e.raceState.Stages) <= 2 && !e.hasAnyCustomizedStageLocked() {
			e.regenerateTournamentLocked()
		} else {
			e.rebuildAllUnstartedNonCustomStagesLocked()
			e.resolveActiveTournamentLocked()
		}
	} else if e.raceState.Generated {
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

// RemovePilot removes a pilot from the roster (at least 2 pilots must remain).
func (e *Engine) RemovePilot(slotIndex int) error {
	e.mu.Lock()
	if len(e.pilots) <= 2 {
		e.mu.Unlock()
		return fmt.Errorf("at least 2 pilots are required in the roster")
	}
	idx := -1
	for i, p := range e.pilots {
		if p.SlotIndex == slotIndex {
			idx = i
			break
		}
	}
	if idx < 0 {
		e.mu.Unlock()
		return fmt.Errorf("pilot slot %d not found", slotIndex)
	}
	e.pilots = append(e.pilots[:idx], e.pilots[idx+1:]...)
	if e.practiceSnap.Saved {
		filtered := make([]domain.PilotSlot, 0, len(e.practiceSnap.Pilots))
		for _, sp := range e.practiceSnap.Pilots {
			if sp.SlotIndex != slotIndex {
				filtered = append(filtered, sp)
			}
		}
		e.practiceSnap.Pilots = filtered
	}
	e.syncGlobalPilotsToOpenEventsLocked(nil, slotIndex)
	e.syncGlobalPilotsToPracticeSessionsLocked(slotIndex)

	if e.raceState.Generated && e.raceState.Lifecycle == domain.LifecycleDraft &&
		!e.hasAnyStartedRaceHeatLocked() && !hasAnyManualLocksInState(&e.raceState) {
		if e.raceState.TemplateID != "custom" && len(e.raceState.Stages) <= 2 && !e.hasAnyCustomizedStageLocked() {
			e.regenerateTournamentLocked()
		} else {
			e.rebuildAllUnstartedNonCustomStagesLocked()
			e.resolveActiveTournamentLocked()
		}
	} else if e.raceState.Generated {
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

func (e *Engine) hasAnyStartedRaceHeatLocked() bool {
	for _, h := range e.raceState.Heats {
		if h.State == domain.HeatCountdown || h.State == domain.HeatRunning ||
			h.State == domain.HeatPaused || h.State == domain.HeatFinished ||
			(h.State == domain.HeatConfirmed && h.Note != "Auto-advance (bye)") {
			return true
		}
	}
	return false
}

// SetOperatingMode switches between open Practice Mode and organized Race Mode, cleanly
// snapshotting and restoring Practice channels & session laps so neither mode clobbers the other.
func (e *Engine) SetOperatingMode(mode domain.OperatingMode) domain.RaceTournamentState {
	if mode != domain.ModeRace {
		mode = domain.ModePractice
	}

	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	prevMode := e.raceState.Mode
	if prevMode == "" {
		prevMode = domain.ModePractice
	}
	if prevMode == mode {
		snap := cloneRaceState(e.raceState)
		e.mu.Unlock()
		return snap
	}

	if mode == domain.ModeRace {
		// Save Practice snapshot
		e.practiceSnap = domain.PracticeSnapshot{
			Saved:     true,
			RaceArmed: e.raceArmed,
			Pilots:    append([]domain.PilotSlot(nil), e.pilots...),
			Laps:      cloneLaps(e.laps),
			Crossings: append([]domain.GateCrossingEvent(nil), e.crossings...),
			Filtered:  append([]domain.FilteredDetection(nil), e.filtered...),
		}
		e.raceState.Mode = domain.ModeRace
		if e.raceState.Generated {
			e.resolveActiveTournamentLocked()
		} else if e.raceState.RaceID != "" {
			e.syncActiveRaceToEventLocked()
		}
		e.stageOrDisarmActiveRaceLocked()
	} else {
		// Pause any active countdown/running race heat before leaving Race Mode
		e.pauseLiveHeatIfRunningLocked()
		e.raceState.Mode = domain.ModePractice
		e.syncActiveRaceToEventLocked()
		e.restorePracticeSnapshotLocked()
	}

	snap := cloneRaceState(e.raceState)
	pilotsCopy := append([]domain.PilotSlot(nil), e.pilots...)
	gatesCopy := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilotsCopy, gatesCopy)
	}
	e.notifyRaceUpdated(snap, nil, subs)
	return snap
}

func (e *Engine) restorePracticeSnapshotLocked() {
	if !e.practiceSnap.Saved {
		e.raceArmed = true
		return
	}
	bySlot := make(map[int]domain.PilotSlot, len(e.practiceSnap.Pilots))
	for _, sp := range e.practiceSnap.Pilots {
		bySlot[sp.SlotIndex] = sp
	}
	enabledCount := 0
	usedCh := make(map[uint16]bool)
	for i := range e.pilots {
		if sp, ok := bySlot[e.pilots[i].SlotIndex]; ok {
			e.pilots[i].Enabled = sp.Enabled
			e.pilots[i].Band = sp.Band
			e.pilots[i].Channel = sp.Channel
			e.pilots[i].FrequencyMHz = sp.FrequencyMHz
		} else {
			e.pilots[i].Enabled = false
			e.pilots[i].Channel = 0
			e.pilots[i].FrequencyMHz = 0
		}
		if e.pilots[i].Enabled {
			chKey := (uint16(e.pilots[i].Band) << 8) | uint16(e.pilots[i].Channel)
			if enabledCount >= domain.MaxPilotSlots || (e.pilots[i].Channel > 0 && usedCh[chKey]) {
				e.pilots[i].Enabled = false
			} else {
				enabledCount++
				if e.pilots[i].Channel > 0 {
					usedCh[chKey] = true
				}
			}
		}
	}

	e.resetSessionLocked()
	e.raceArmed = e.practiceSnap.RaceArmed
	e.laps = cloneLaps(e.practiceSnap.Laps)
	e.crossings = append([]domain.GateCrossingEvent(nil), e.practiceSnap.Crossings...)
	e.filtered = append([]domain.FilteredDetection(nil), e.practiceSnap.Filtered...)
	for _, lap := range e.laps {
		for _, split := range lap.Sectors {
			pKey := pairKey(split.FromGateID, split.ToGateID)
			sKey := sectorKey(lap.SlotIndex, pKey)
			e.sectorHistory[sKey] = append(e.sectorHistory[sKey], split)
			if split.SplitSeconds > 0 {
				if e.overallBestSec[pKey] == 0 || split.SplitSeconds < e.overallBestSec[pKey] {
					e.overallBestSec[pKey] = split.SplitSeconds
				}
				if e.pilotBestSec[sKey] == 0 || split.SplitSeconds < e.pilotBestSec[sKey] {
					e.pilotBestSec[sKey] = split.SplitSeconds
				}
			}
		}
	}
}

func inferTemplateIDFromConfig(cfg domain.RaceSetupConfig) string {
	twoStage := cfg.Structure == domain.StructureTwoStage
	switch cfg.MainFormat {
	case domain.FormatSingleElimination:
		if twoStage {
			return "qual_single_elim"
		}
		return "single_elimination"
	case domain.FormatChaseTheAce:
		if twoStage {
			return "qual_chase_the_ace"
		}
		return "chase_the_ace"
	case domain.FormatPointsMains:
		if twoStage {
			return "qual_mains"
		}
		return "points_mains"
	case domain.FormatQualifying:
		return "round_robin"
	default:
		if twoStage {
			return "qual_double_elim"
		}
		return "double_elimination"
	}
}

func equalSeatChannels(a, b []uint8) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func (e *Engine) applyConfigToUnstartedLocked(prevCfg, nextCfg domain.RaceSetupConfig) {
	if !e.raceState.Generated || (len(e.raceState.Heats) == 0 && len(e.raceState.Rounds) == 0) {
		return
	}
	pphChanged := prevCfg.PilotsPerHeat != nextCfg.PilotsPerHeat
	channelsChanged := !equalSeatChannels(prevCfg.SeatChannels, nextCfg.SeatChannels)
	lapsChanged := prevCfg.TargetLaps != nextCfg.TargetLaps
	timeChanged := prevCfg.TimeLimitSec != nextCfg.TimeLimitSec
	if !pphChanged && !channelsChanged && !lapsChanged && !timeChanged {
		return
	}

	// Clean unstarted template tournament with zero manual locks (1 or 2 default stages) -> regenerate cleanly
	if !e.hasAnyStartedRaceHeatLocked() && !hasAnyManualLocksInState(&e.raceState) &&
		e.raceState.TemplateID != "" && e.raceState.TemplateID != "custom" && len(e.raceState.Stages) <= 2 && !e.hasAnyCustomizedStageLocked() {
		type savedPos struct {
			x, y float64
		}
		posMap := make(map[string]savedPos)
		for _, r := range e.raceState.Rounds {
			if r.HasPos {
				posMap[fmt.Sprintf("%d:%s:%d", r.StageIndex, r.BracketLane, r.Round)] = savedPos{r.PosX, r.PosY}
			}
		}
		if timeChanged && prevCfg.QualifyingTimeLimitSec == prevCfg.TimeLimitSec {
			e.raceState.Config.QualifyingTimeLimitSec = nextCfg.TimeLimitSec
		}
		e.regenerateTournamentLocked()
		if !pphChanged && len(posMap) > 0 {
			for i := range e.raceState.Rounds {
				r := &e.raceState.Rounds[i]
				if sp, ok := posMap[fmt.Sprintf("%d:%s:%d", r.StageIndex, r.BracketLane, r.Round)]; ok {
					r.HasPos = true
					r.PosX = sp.x
					r.PosY = sp.y
				}
			}
		}
		return
	}

	race.SyncRoundsMetadata(&e.raceState)

	roundStartedCount := make(map[string]int)
	roundUnstartedCount := make(map[string]int)
	for _, h := range e.raceState.Heats {
		if isUnstartedHeatState(h.State) {
			roundUnstartedCount[h.RoundID]++
		} else {
			roundStartedCount[h.RoundID]++
		}
	}

	// 1. Update TargetLaps & TimeLimitSec on unstarted rounds, heats, and stage settings
	for i := range e.raceState.Stages {
		st := &e.raceState.Stages[i]
		if pphChanged {
			st.Settings.PilotsPerHeat = nextCfg.PilotsPerHeat
		}
		if channelsChanged {
			st.Settings.SeatChannels = append([]uint8(nil), nextCfg.SeatChannels...)
		}
		if st.Format != domain.FormatQualifying && st.Format != domain.FormatOpenQualifier {
			if lapsChanged {
				st.Settings.TargetLaps = nextCfg.TargetLaps
			}
			if timeChanged {
				st.Settings.TimeLimitSec = nextCfg.TimeLimitSec
			}
		} else if timeChanged {
			st.Settings.TimeLimitSec = nextCfg.TimeLimitSec
		}
	}
	for i := range e.raceState.Rounds {
		r := &e.raceState.Rounds[i]
		if domain.IsStagePortalRoundID(r.ID) {
			continue
		}
		if roundStartedCount[r.ID] > 0 {
			continue
		}
		if r.StageFormat != domain.FormatQualifying && r.StageFormat != domain.FormatOpenQualifier {
			if lapsChanged {
				r.TargetLaps = nextCfg.TargetLaps
			}
			if timeChanged {
				r.TimeLimitSec = nextCfg.TimeLimitSec
			}
		} else if timeChanged {
			r.TimeLimitSec = nextCfg.TimeLimitSec
			e.raceState.Config.QualifyingTimeLimitSec = nextCfg.TimeLimitSec
		}
	}

	for i := range e.raceState.Heats {
		h := &e.raceState.Heats[i]
		if !isUnstartedHeatState(h.State) {
			continue
		}
		if h.StageFormat != domain.FormatQualifying && h.StageFormat != domain.FormatOpenQualifier {
			if lapsChanged {
				h.TargetLaps = nextCfg.TargetLaps
			}
			if timeChanged {
				h.TimeLimitSec = nextCfg.TimeLimitSec
			}
		} else if timeChanged {
			h.TimeLimitSec = nextCfg.TimeLimitSec
		}
	}

	if !pphChanged && !channelsChanged {
		return
	}

	pilotBySlot := make(map[int]domain.PilotSlot, len(e.pilots))
	for _, p := range e.pilots {
		pilotBySlot[p.SlotIndex] = p
	}
	inConnCount := make(map[string]int)
	for _, c := range e.raceState.Connections {
		if !c.Invalid {
			inConnCount[c.ToRoundID]++
		}
	}

	// 2. Handle partially-started rounds (started heats stay untouched; unstarted heats resize seats/channels safely)
	for _, r := range e.raceState.Rounds {
		if domain.IsStagePortalRoundID(r.ID) {
			continue
		}
		if roundStartedCount[r.ID] > 0 && roundUnstartedCount[r.ID] > 0 {
			var displaced []int
			for hi := range e.raceState.Heats {
				h := &e.raceState.Heats[hi]
				if h.RoundID != r.ID || !isUnstartedHeatState(h.State) {
					continue
				}
				if nextCfg.PilotsPerHeat < len(h.Seats) {
					for si := nextCfg.PilotsPerHeat; si < len(h.Seats); si++ {
						if h.Seats[si].PilotSlotIndex > 0 {
							displaced = append(displaced, h.Seats[si].PilotSlotIndex)
						}
					}
				}
				syncUnstartedHeatSeatsToConfig(h, nextCfg.PilotsPerHeat, nextCfg.SeatChannels)
				finalizeEditedHeatState(h, nextCfg.QualifyingMetric)
			}
			for _, slotIdx := range displaced {
				p, ok := pilotBySlot[slotIdx]
				if !ok {
					continue
				}
				placed := false
				for hi := range e.raceState.Heats {
					h := &e.raceState.Heats[hi]
					if h.RoundID != r.ID || !isUnstartedHeatState(h.State) {
						continue
					}
					for si := range h.Seats {
						if h.Seats[si].PilotSlotIndex == 0 && h.Seats[si].Feeder == nil {
							populateDirectSeat(&h.Seats[si], p, si+1)
							h.Seats[si].SourceLabel = "Manual"
							finalizeEditedHeatState(h, nextCfg.QualifyingMetric)
							placed = true
							break
						}
					}
					if placed {
						break
					}
				}
				if !placed {
					newHID := e.appendHeatToRoundOrColumnLocked(r.ID, r.BracketLane, r.Round, r.Column)
					for hi := range e.raceState.Heats {
						if e.raceState.Heats[hi].ID == newHID && len(e.raceState.Heats[hi].Seats) > 0 {
							populateDirectSeat(&e.raceState.Heats[hi].Seats[0], p, 1)
							e.raceState.Heats[hi].Seats[0].SourceLabel = "Manual"
							finalizeEditedHeatState(&e.raceState.Heats[hi], nextCfg.QualifyingMetric)
							break
						}
					}
				}
			}
		}
	}

	// 3. Handle completely unstarted manual/"empty" rounds so manually placed pilots are preserved
	savedManualByRound := make(map[string][]domain.PilotSlot)
	for _, r := range e.raceState.Rounds {
		if domain.IsStagePortalRoundID(r.ID) {
			continue
		}
		if roundStartedCount[r.ID] == 0 && inConnCount[r.ID] == 0 && r.SeedSource != "all_active_pilots" && r.SeedSource != "stage_seeds" {
			var manualPilots []domain.PilotSlot
			seen := make(map[int]bool)
			for _, h := range e.raceState.Heats {
				if h.RoundID != r.ID {
					continue
				}
				for _, s := range h.Seats {
					if s.PilotSlotIndex > 0 && !seen[s.PilotSlotIndex] {
						if p, ok := pilotBySlot[s.PilotSlotIndex]; ok {
							seen[s.PilotSlotIndex] = true
							manualPilots = append(manualPilots, p)
						}
					}
				}
			}
			if len(manualPilots) > 0 {
				savedManualByRound[r.ID] = manualPilots
			}
		}
	}

	// 4. Rebalance auto connection counts into unstarted rounds and rebuild unstarted graph rounds per stage
	if pphChanged {
		for _, r := range e.raceState.Rounds {
			if roundStartedCount[r.ID] == 0 && inConnCount[r.ID] > 0 {
				e.rebalanceAutoConnectionsIntoLocked(r.ID)
			}
		}
	}
	seenStage := make(map[int]bool)
	for _, stg := range e.raceState.Stages {
		if stg.Index >= 1 && !seenStage[stg.Index] {
			seenStage[stg.Index] = true
			e.recomputeGraphAndRebuildLocked(stg.Index, "")
		}
	}
	totalStages := e.raceState.TotalStages
	if totalStages < 1 {
		totalStages = 1
	}
	for st := 1; st <= totalStages; st++ {
		if !seenStage[st] {
			e.recomputeGraphAndRebuildLocked(st, "")
		}
	}

	// Re-seat any manually placed pilots in unstarted "empty" rounds
	for rid, manualPilots := range savedManualByRound {
		r := e.findRoundByIDLocked(rid)
		if r == nil {
			continue
		}
		needed := (len(manualPilots) + nextCfg.PilotsPerHeat - 1) / nextCfg.PilotsPerHeat
		if r.TargetHeats > needed {
			needed = r.TargetHeats
		}
		targetHeats := e.ensureRoundHeatCountLocked(rid, needed)
		lastCh := race.LastChannelByPilotConfirmed(e.raceState.Heats)
		for hi, th := range targetHeats {
			start := hi * nextCfg.PilotsPerHeat
			end := start + nextCfg.PilotsPerHeat
			var slice []domain.PilotSlot
			if start < len(manualPilots) {
				if end > len(manualPilots) {
					end = len(manualPilots)
				}
				slice = manualPilots[start:end]
			}
			assignPilotsWithChannelContinuity(th, slice, nextCfg.SeatChannels, lastCh)
			finalizeEditedHeatState(th, nextCfg.QualifyingMetric)
		}
	}
}

func (e *Engine) regenerateTournamentLocked() {
	e.ensureEventStateInitializedLocked()
	prevID := e.raceState.RaceID
	prevMGPLink := cloneRaceState(e.raceState).MGPLink
	prevTags := append([]string(nil), e.raceState.Tags...)
	prevTemplateID := e.raceState.TemplateID
	prevCreated := e.raceState.CreatedAt
	prevTrack := append([]domain.TrackGate(nil), e.raceState.TrackSnapshot...)
	prevRoster := append([]domain.EventPilot(nil), e.raceState.Roster...)
	cfg := e.raceState.Config.Normalized()
	genPilots := e.activeEventPilotsForGenerationLocked()
	st := race.GenerateTournament(cfg, genPilots, time.Now().UnixNano())
	st.RaceID = prevID
	st.MGPLink = prevMGPLink
	st.Tags = prevTags
	if prevTemplateID != "" && prevTemplateID != "custom" {
		st.TemplateID = prevTemplateID
	} else {
		st.TemplateID = inferTemplateIDFromConfig(cfg)
	}
	st.Stages = nil
	st.StageConnections = nil
	st.CreatedAt = prevCreated
	st.TrackSnapshot = prevTrack
	st.Roster = prevRoster
	normalizeRaceRosterLocked(&st, e.pilots)
	race.SyncRoundsMetadata(&st)
	st.Lifecycle = domain.LifecycleDraft
	st.StatusReason = ""
	st.Mode = e.raceState.Mode
	if st.Mode == "" {
		st.Mode = domain.ModePractice
	}
	e.raceState = st
	e.resolveActiveTournamentLocked()
	if e.raceState.Mode == domain.ModeRace {
		e.stageOrDisarmActiveRaceLocked()
	}
}

// ConfigureAndGenerateRace updates the RaceSetupConfig and optionally generates a fresh tournament schedule.
func (e *Engine) ConfigureAndGenerateRace(cfg domain.RaceSetupConfig, generate bool) domain.RaceTournamentState {
	return e.ConfigureAndGenerateRaceWithOptions(cfg, generate, false)
}

// ConfigureAndGenerateRaceWithOptions updates the RaceSetupConfig, optionally generates a fresh
// tournament schedule, or propagates updated settings (seats/heat, seat channels, laps, time limit)
// strictly to existing unstarted rounds and heats while leaving started/confirmed heats untouched.
func (e *Engine) ConfigureAndGenerateRaceWithOptions(
	cfg domain.RaceSetupConfig,
	generate bool,
	applyToExisting bool,
) domain.RaceTournamentState {
	return e.ConfigureAndGenerateRaceForID("", cfg, generate, applyToExisting)
}

// ConfigureAndGenerateRaceForID updates `RaceSetupConfig` on `raceID` (or the active race when `raceID == ""`)
// without disturbing any other ongoing race currently live on track.
func (e *Engine) ConfigureAndGenerateRaceForID(
	raceID string,
	cfg domain.RaceSetupConfig,
	generate bool,
	applyToExisting bool,
) domain.RaceTournamentState {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	swap, swapErr := e.enterTargetRaceLocked(raceID)
	if swapErr != nil {
		snap := cloneRaceState(e.raceState)
		e.mu.Unlock()
		return snap
	}
	prevCfg := e.raceState.Config.Normalized()
	nextCfg := cfg.Normalized()
	if strings.TrimSpace(nextCfg.EventName) == "" {
		if strings.TrimSpace(prevCfg.EventName) != "" {
			nextCfg.EventName = prevCfg.EventName
		} else {
			nextCfg.EventName = e.nextDefaultRaceNameLocked()
		}
	}
	if dup := e.findDuplicateRaceBySlugLocked(nextCfg.EventName, e.raceState.RaceID); dup != nil {
		if strings.TrimSpace(prevCfg.EventName) != "" && e.findDuplicateRaceBySlugLocked(prevCfg.EventName, e.raceState.RaceID) == nil {
			nextCfg.EventName = prevCfg.EventName
		} else {
			base := strings.TrimSpace(nextCfg.EventName)
			for suffix := 2; ; suffix++ {
				cand := fmt.Sprintf("%s (%d)", base, suffix)
				if e.findDuplicateRaceBySlugLocked(cand, e.raceState.RaceID) == nil {
					nextCfg.EventName = cand
					break
				}
			}
		}
	}
	e.raceState.Config = nextCfg
	if generate {
		if e.raceState.RaceID == "" {
			e.raceState.RaceID = e.nextUniqueIDLocked("race")
			e.raceState.CreatedAt = nowISO()
			normalizeRaceRosterLocked(&e.raceState, e.pilots)
			e.syncActiveRaceToEventLocked()
		}
		e.raceState.TemplateID = inferTemplateIDFromConfig(e.raceState.Config)
		e.regenerateTournamentLocked()
	} else if e.raceState.Generated {
		if applyToExisting {
			e.applyConfigToUnstartedLocked(prevCfg, nextCfg)
		}
		e.resolveActiveTournamentLocked()
	} else if e.raceState.RaceID != "" {
		e.syncActiveRaceToEventLocked()
	}

	var targetSnap domain.RaceTournamentState
	if swap.swapped {
		targetSnap = e.exitTargetRaceLocked(&swap, true)
	} else {
		targetSnap = cloneRaceState(e.raceState)
	}
	activeSnap := cloneRaceState(e.raceState)
	pilotsCopy := append([]domain.PilotSlot(nil), e.pilots...)
	gatesCopy := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilotsCopy, gatesCopy)
	}
	e.notifyRaceUpdated(activeSnap, nil, subs)
	return targetSnap
}

// AdvanceRaceStage2 seeds and generates Stage 2 (Bracket / Mains) from Stage 1 Qualifying results.
func (e *Engine) AdvanceRaceStage2() (domain.RaceTournamentState, error) {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	roster, _ := e.activeEventRosterAndAttendanceLocked()
	if !race.GenerateStage2Mains(&e.raceState, roster) {
		snap := cloneRaceState(e.raceState)
		e.mu.Unlock()
		return snap, fmt.Errorf("cannot advance to Stage 2 mains yet")
	}
	for _, ep := range e.raceState.Roster {
		applyAttendanceToRaceLocked(&e.raceState, ep.SlotIndex, ep.IsAvailableToRace())
	}
	e.resolveActiveTournamentLocked()
	if e.raceState.Mode == domain.ModeRace {
		e.stageOrDisarmActiveRaceLocked()
	}
	snap := cloneRaceState(e.raceState)
	pilotsCopy := append([]domain.PilotSlot(nil), e.pilots...)
	gatesCopy := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilotsCopy, gatesCopy)
	}
	e.notifyRaceUpdated(snap, nil, subs)
	return snap, nil
}

// RaceControlActionForRace executes a Race Director command on `raceID`, switching `e.raceState`
// when no other race is ongoing, or allowing non-hardware heat selection on `raceID` while another
// race owns the live track.
func (e *Engine) RaceControlActionForRace(raceID string, action string, heatID string) (domain.RaceTournamentState, error) {
	return e.RaceControlActionWithOptions(raceID, action, heatID, false)
}

// RaceControlActionWithOptions executes a live Race Director command for `raceID`, optionally
// preempting (pausing) any other ongoing race or active practice session when `preemptOngoing` is true.
func (e *Engine) RaceControlActionWithOptions(raceID string, action string, heatID string, preemptOngoing bool) (domain.RaceTournamentState, error) {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	tid := strings.TrimSpace(raceID)
	if tid == "" && e.editingRaceID != "" {
		tid = e.editingRaceID
	}
	if preemptOngoing && (action == "start" || action == "resume") {
		targetCheck := tid
		if targetCheck == "" {
			targetCheck = e.raceState.RaceID
		}
		e.pauseAllOtherOngoingRacesLocked(targetCheck)
	}
	if tid == "" || tid == e.raceState.RaceID {
		e.mu.Unlock()
		return e.raceControlActionActiveWithOptions(action, heatID, preemptOngoing)
	}
	if isRaceOngoing(&e.raceState) {
		if action == "select" {
			targetIdx := -1
			for i := range e.eventState.Races {
				if e.eventState.Races[i].RaceID == tid {
					targetIdx = i
					break
				}
			}
			if targetIdx < 0 {
				snap := cloneRaceState(e.raceState)
				e.mu.Unlock()
				return snap, fmt.Errorf("race %q not found", tid)
			}
			hid := strings.TrimSpace(heatID)
			foundHeat := false
			for _, h := range e.eventState.Races[targetIdx].Heats {
				if h.ID == hid {
					foundHeat = true
					break
				}
			}
			if !foundHeat {
				snap := cloneRaceState(e.eventState.Races[targetIdx])
				e.mu.Unlock()
				return snap, fmt.Errorf("heat %q not found", hid)
			}
			e.eventState.Races[targetIdx].ActiveHeatID = hid
			e.eventState.Races[targetIdx].UpdatedAt = nowISO()
			targetSnap := cloneRaceState(e.eventState.Races[targetIdx])
			activeSnap := cloneRaceState(e.raceState)
			subs := append([]EventSubscriber(nil), e.subscribers...)
			e.mu.Unlock()
			e.notifyRaceUpdated(activeSnap, nil, subs)
			return targetSnap, nil
		}
		ongoingName := raceDisplayName(&e.raceState)
		snap := cloneRaceState(e.raceState)
		e.mu.Unlock()
		return snap, fmt.Errorf("cannot control this race while %q is ongoing — pause or complete %q first", ongoingName, ongoingName)
	}
	if !e.loadRaceByIDLocked(tid) {
		snap := cloneRaceState(e.raceState)
		e.mu.Unlock()
		return snap, fmt.Errorf("race %q not found", tid)
	}
	e.mu.Unlock()
	return e.raceControlActionActiveWithOptions(action, heatID, preemptOngoing)
}

// RaceControlAction executes a live Race Director command ("select", "start", "cancel", "pause",
// "resume", "stop", "emergency_stop", "reset", "confirm", "unlock").
func (e *Engine) RaceControlAction(action string, heatID string) (domain.RaceTournamentState, error) {
	return e.RaceControlActionWithOptions("", action, heatID, false)
}

func (e *Engine) raceControlActionActive(action string, heatID string) (domain.RaceTournamentState, error) {
	return e.raceControlActionActiveWithOptions(action, heatID, false)
}

func (e *Engine) raceControlActionActiveWithOptions(action string, heatID string, preemptOngoing bool) (domain.RaceTournamentState, error) {
	nowUs := e.NowUs()
	if nowUs == 0 {
		nowUs = 1
	}
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	if !e.raceState.Generated {
		e.mu.Unlock()
		return cloneRaceState(e.raceState), fmt.Errorf("no tournament generated yet")
	}

	targetID := strings.TrimSpace(heatID)
	if targetID == "" {
		targetID = e.raceState.ActiveHeatID
	}

	var ann *domain.RaceAnnouncement
	cfgChanged := false
	practiceChanged := false

	switch action {
	case "select":
		if e.hasLiveRunningHeatLocked() && targetID != e.raceState.ActiveHeatID {
			e.mu.Unlock()
			return cloneRaceState(e.raceState), fmt.Errorf("pause or stop the active heat before switching heats")
		}
		if e.findHeatLocked(targetID) == nil {
			e.mu.Unlock()
			return cloneRaceState(e.raceState), fmt.Errorf("heat %q not found", targetID)
		}
		e.stageHeatLocked(targetID, true)
		cfgChanged = true

	case "start":
		if e.raceState.Lifecycle == domain.LifecyclePaused {
			hasConflict := e.findOtherOngoingRaceLocked(e.raceState.RaceID) != nil || e.practiceState.ActiveSessionID != ""
			if preemptOngoing || !hasConflict {
				e.raceState.Lifecycle = domain.LifecycleActive
				e.raceState.StatusReason = ""
			} else {
				e.mu.Unlock()
				return cloneRaceState(e.raceState), fmt.Errorf("cannot start heat while another race or practice session is active — confirm preemption first")
			}
		}
		if e.raceState.Lifecycle == domain.LifecycleScrapped || e.raceState.Lifecycle == domain.LifecycleCompleted {
			e.mu.Unlock()
			return cloneRaceState(e.raceState), fmt.Errorf("race is %s — reopen the race before starting heats", e.raceState.Lifecycle)
		}
		if other := e.findOtherOngoingRaceLocked(e.raceState.RaceID); other != nil {
			if preemptOngoing {
				if e.pauseAllOtherOngoingRacesLocked(e.raceState.RaceID) {
					cfgChanged = true
				}
			} else {
				e.mu.Unlock()
				return cloneRaceState(e.raceState), fmt.Errorf("cannot start race %q while race %q is ongoing — pause or complete it first", raceDisplayName(&e.raceState), raceDisplayName(other))
			}
		}
		if targetID == "" && e.raceState.NextReadyHeatID != "" {
			targetID = e.raceState.NextReadyHeatID
		}
		h := e.findHeatLocked(targetID)
		if h == nil {
			e.mu.Unlock()
			return cloneRaceState(e.raceState), fmt.Errorf("no heat selected")
		}
		if err := e.validateStageCanRunHeatLocked(h); err != nil {
			e.mu.Unlock()
			return cloneRaceState(e.raceState), err
		}
		if h.State != domain.HeatReady && h.State != domain.HeatStaged {
			e.mu.Unlock()
			return cloneRaceState(e.raceState), fmt.Errorf("heat %s cannot be started in state %s", h.ID, h.State)
		}
		activeFlyers := 0
		for _, s := range h.Seats {
			if s.PilotSlotIndex > 0 && s.Status != domain.PilotHeatDQ && s.Status != domain.PilotHeatDNS {
				activeFlyers++
			}
		}
		if activeFlyers == 0 {
			e.mu.Unlock()
			return cloneRaceState(e.raceState), fmt.Errorf("cannot start %s with no active non-scratched pilots", h.ShortLabel)
		}
		if e.pauseActivePracticeSessionLocked() {
			practiceChanged = true
		}
		if e.raceState.Lifecycle == "" || e.raceState.Lifecycle == domain.LifecycleDraft {
			e.raceState.Lifecycle = domain.LifecycleActive
		}
		e.raceState.EmergencyStopped = false
		e.enterLiveRaceHeatLocked(h)
		cfgChanged = true
		h = e.findHeatLocked(h.ID)
		// Clear previous run metrics cleanly
		h.InOvertime = false
		h.OvertimeStartedAtUs = 0
		h.AccumulatedPauseUs = 0
		h.PausedAtUs = 0
		h.CountdownArmRemainingSec = 0
		h.CountdownPromptUs = 0
		h.CountdownPrompted = false
		h.CountdownStartUs = 0
		h.ElapsedSec = 0
		for i := range h.Seats {
			if h.Seats[i].PilotSlotIndex <= 0 {
				continue
			}
			h.Seats[i].Crossings = nil
			h.Seats[i].RssiTrace = nil
			h.Seats[i].Laps = []domain.HeatLap{}
			h.Seats[i].PenaltySec = 0
			h.Seats[i].ManualPosition = 0
			if h.Seats[i].Status != domain.PilotHeatDQ && h.Seats[i].Status != domain.PilotHeatDNS {
				h.Seats[i].Status = domain.PilotHeatStaged
				h.Seats[i].PreOverrideStatus = ""
				h.Seats[i].StatusOverridden = false
			}
		}
		race.RecomputeHeat(h, e.raceState.Config.QualifyingMetric)
	e.markHeatUnsyncedMGPLocked(h.ID)
		e.resetSessionLocked()

		cdSec := e.raceState.Config.CountdownSec
		if cdSec > 0 {
			const countdownArmPauseUs uint64 = 3_700_000   // "Pilots, arm your quads" (~1.3s) + ~2.4s quiet pause
			const countdownPromptLeadUs uint64 = 1_100_000 // "In less than 5" (~1.1s) right before clock starts
			durUs := randomCountdownDurationUs(cdSec)
			h.State = domain.HeatCountdown
			h.CountdownDurationSec = cdSec
			h.CountdownBeeped = false
			h.CountdownBeepAtSec = 0
			h.CountdownPromptUs = nowUs + countdownArmPauseUs
			h.CountdownPrompted = false
			h.CountdownStartUs = nowUs + countdownArmPauseUs + countdownPromptLeadUs
			h.CountdownEndUs = h.CountdownStartUs + durUs
			h.CountdownArmRemainingSec = float64(countdownArmPauseUs+countdownPromptLeadUs) / 1e6
			h.CountdownRemainingSec = float64(cdSec)
			e.raceArmed = false
			ann = &domain.RaceAnnouncement{Kind: "countdown_start", HeatID: h.ID, CountdownSec: cdSec}
		} else {
			h.State = domain.HeatRunning
			h.StartToneUs = nowUs
			h.CountdownDurationSec = 0
			h.CountdownBeeped = false
			h.CountdownBeepAtSec = 0
			h.CountdownArmRemainingSec = 0
			h.CountdownPromptUs = 0
			h.CountdownPrompted = false
			h.CountdownStartUs = 0
			h.CountdownRemainingSec = 0
			for i := range h.Seats {
				if h.Seats[i].PilotSlotIndex > 0 && h.Seats[i].Status != domain.PilotHeatDQ && h.Seats[i].Status != domain.PilotHeatDNS {
					h.Seats[i].Status = domain.PilotHeatRacing
				}
			}
			e.raceArmed = true
			ann = &domain.RaceAnnouncement{Kind: "start_horn", HeatID: h.ID}
		}

	case "cancel":
		h := e.findHeatLocked(targetID)
		if h != nil && h.State == domain.HeatCountdown {
			h.State = domain.HeatStaged
			h.CountdownRemainingSec = 0
			h.CountdownArmRemainingSec = 0
			h.CountdownDurationSec = 0
			h.CountdownBeeped = false
			h.CountdownBeepAtSec = 0
			h.CountdownPromptUs = 0
			h.CountdownPrompted = false
			h.CountdownStartUs = 0
			h.CountdownEndUs = 0
			for i := range h.Seats {
				h.Seats[i].RssiTrace = nil
			}
			e.raceArmed = false
			if e.exitLiveRaceHeatLocked() {
				cfgChanged = true
			}
			ann = &domain.RaceAnnouncement{Kind: "countdown_cancel", HeatID: h.ID}
		}

	case "pause":
		h := e.findHeatLocked(targetID)
		if h != nil && h.State == domain.HeatRunning {
			h.State = domain.HeatPaused
			h.ExecutedAtMs = time.Now().UnixMilli()
			h.PausedAtUs = nowUs
			if h.StartToneUs > 0 && nowUs >= h.StartToneUs {
				h.ElapsedSec = float64(nowUs-h.StartToneUs) / 1e6
			}
			e.raceArmed = false
		}

	case "resume":
		if e.raceState.Lifecycle == domain.LifecyclePaused {
			hasConflict := e.findOtherOngoingRaceLocked(e.raceState.RaceID) != nil || e.practiceState.ActiveSessionID != ""
			if preemptOngoing || !hasConflict {
				e.raceState.Lifecycle = domain.LifecycleActive
				e.raceState.StatusReason = ""
			} else {
				e.mu.Unlock()
				return cloneRaceState(e.raceState), fmt.Errorf("cannot resume heat while another race or practice session is active — confirm preemption first")
			}
		}
		if e.raceState.Lifecycle == domain.LifecycleScrapped || e.raceState.Lifecycle == domain.LifecycleCompleted {
			e.mu.Unlock()
			return cloneRaceState(e.raceState), fmt.Errorf("race is %s — reopen the race first", e.raceState.Lifecycle)
		}
		if other := e.findOtherOngoingRaceLocked(e.raceState.RaceID); other != nil {
			if preemptOngoing {
				if e.pauseAllOtherOngoingRacesLocked(e.raceState.RaceID) {
					cfgChanged = true
				}
			} else {
				e.mu.Unlock()
				return cloneRaceState(e.raceState), fmt.Errorf("cannot resume race %q while race %q is ongoing — pause or complete it first", raceDisplayName(&e.raceState), raceDisplayName(other))
			}
		}
		h := e.findHeatLocked(targetID)
		if h != nil && (h.State == domain.HeatPaused || h.State == domain.HeatFinished) {
			if err := e.validateStageCanRunHeatLocked(h); err != nil {
				e.mu.Unlock()
				return cloneRaceState(e.raceState), err
			}
			if e.pauseActivePracticeSessionLocked() {
				practiceChanged = true
			}
			if e.raceState.Lifecycle == "" || e.raceState.Lifecycle == domain.LifecycleDraft {
				e.raceState.Lifecycle = domain.LifecycleActive
			}
			e.enterLiveRaceHeatLocked(h)
			cfgChanged = true
			if h.PausedAtUs > 0 && nowUs > h.PausedAtUs {
				pauseDelta := nowUs - h.PausedAtUs
				h.AccumulatedPauseUs += pauseDelta
				h.StartToneUs += pauseDelta
				for i := range h.Seats {
					for k := range h.Seats[i].Crossings {
						h.Seats[i].Crossings[k].TimestampUs += pauseDelta
					}
				}
				if h.OvertimeStartedAtUs > 0 {
					h.OvertimeStartedAtUs += pauseDelta
				}
			} else if h.State == domain.HeatFinished {
				// Resuming a finished heat shifts StartToneUs (and recorded crossings) so ElapsedSec picks up cleanly
				prevElapsedUs := uint64(h.ElapsedSec * 1e6)
				if nowUs > prevElapsedUs {
					newStartToneUs := nowUs - prevElapsedUs
					if h.StartToneUs > 0 && newStartToneUs >= h.StartToneUs {
						delta := newStartToneUs - h.StartToneUs
						for i := range h.Seats {
							for k := range h.Seats[i].Crossings {
								h.Seats[i].Crossings[k].TimestampUs += delta
							}
						}
					}
					h.StartToneUs = newStartToneUs
				}
			}
			h.PausedAtUs = 0
			h.State = domain.HeatRunning
			for i := range h.Seats {
				s := &h.Seats[i]
				if s.PilotSlotIndex <= 0 || s.Status == domain.PilotHeatDQ || s.Status == domain.PilotHeatDNS {
					continue
				}
				if h.TargetLaps > 0 && h.StartMode == domain.StartModeHeadsUp && s.LapsCompleted >= h.TargetLaps {
					s.Status = domain.PilotHeatFinished
				} else if s.Status != domain.PilotHeatDNF {
					s.Status = domain.PilotHeatRacing
				}
			}
			e.raceArmed = true
		}

	case "stop":
		h := e.findHeatLocked(targetID)
		if h != nil && (h.State == domain.HeatRunning || h.State == domain.HeatPaused || h.State == domain.HeatCountdown) {
			if h.State == domain.HeatPaused && h.PausedAtUs > 0 && h.StartToneUs > 0 && h.PausedAtUs >= h.StartToneUs {
				h.ElapsedSec = float64(h.PausedAtUs-h.StartToneUs) / 1e6
			} else if h.State == domain.HeatRunning && h.StartToneUs > 0 && nowUs >= h.StartToneUs {
				h.ElapsedSec = float64(nowUs-h.StartToneUs) / 1e6
			}
			ann = e.finishHeatLocked(h)
			if e.exitLiveRaceHeatLocked() {
				cfgChanged = true
			}
		}

	case "emergency_stop":
		e.raceState.EmergencyStopped = true
		h := e.findHeatLocked(targetID)
		if h != nil && (h.State == domain.HeatRunning || h.State == domain.HeatCountdown || h.State == domain.HeatPaused) {
			h.State = domain.HeatAborted
			h.ExecutedAtMs = time.Now().UnixMilli()
			h.InOvertime = false
			h.CountdownRemainingSec = 0
			e.raceArmed = false
			if e.exitLiveRaceHeatLocked() {
				cfgChanged = true
			}
			ann = &domain.RaceAnnouncement{
				Kind:   "emergency_stop",
				HeatID: h.ID,
				Text:   "Emergency stop, land immediately!",
			}
		}

	case "reset":
		h := e.findHeatLocked(targetID)
		if h == nil {
			e.mu.Unlock()
			return cloneRaceState(e.raceState), fmt.Errorf("heat not found")
		}
		if h.State == domain.HeatConfirmed {
			e.mu.Unlock()
			return cloneRaceState(e.raceState), fmt.Errorf("unlock confirmed heat before resetting")
		}
		e.raceState.EmergencyStopped = false
		e.resetSingleHeatToStagedLocked(h)
		e.markHeatUnsyncedMGPLocked(h.ID)
		e.resolveActiveTournamentLocked()
		if e.exitLiveRaceHeatLocked() {
			cfgChanged = true
		} else if e.raceState.Mode == domain.ModeRace {
			e.stageOrDisarmActiveRaceLocked()
			cfgChanged = true
		}

	case "confirm":
		h := e.findHeatLocked(targetID)
		if h == nil || h.State != domain.HeatFinished {
			e.mu.Unlock()
			return cloneRaceState(e.raceState), fmt.Errorf("heat must be finished before confirming")
		}
		if isRaceTrackEditable(&e.raceState) {
			e.raceState.TrackSnapshot = e.snapshotOrderedGatesLocked()
		}
		race.RecomputeHeat(h, e.raceState.Config.QualifyingMetric)
	e.markHeatUnsyncedMGPLocked(h.ID)
		h.State = domain.HeatConfirmed
		if h.ExecutedAtMs == 0 {
			h.ExecutedAtMs = time.Now().UnixMilli()
		}
		e.resolveActiveTournamentLocked()
		if e.raceState.IsComplete && e.raceState.ChampionCallsign != "" {
			ann = &domain.RaceAnnouncement{
				Kind:      "champion",
				HeatID:    h.ID,
				SlotIndex: e.raceState.ChampionSlotIndex,
				Callsign:  e.raceState.ChampionCallsign,
			}
		}
		// Automatically stage the next ready heat so the Race Director is ready for the next race!
		if e.raceState.NextReadyHeatID != "" &&
			e.raceState.Lifecycle != domain.LifecyclePaused &&
			e.raceState.Lifecycle != domain.LifecycleCompleted &&
			e.raceState.Lifecycle != domain.LifecycleScrapped {
			e.stageHeatLocked(e.raceState.NextReadyHeatID, true)
			cfgChanged = true
		} else if e.raceState.Mode == domain.ModeRace {
			e.stageOrDisarmActiveRaceLocked()
			cfgChanged = true
		}

	case "unlock":
		h := e.findHeatLocked(targetID)
		if h == nil || h.State != domain.HeatConfirmed || !h.CanUnlock {
			e.mu.Unlock()
			return cloneRaceState(e.raceState), fmt.Errorf("heat cannot be unlocked")
		}
		wasCompleted := e.raceState.Lifecycle == domain.LifecycleCompleted
		if wasCompleted {
			if other := e.findOtherOngoingRaceLocked(e.raceState.RaceID); other != nil {
				e.mu.Unlock()
				return cloneRaceState(e.raceState), fmt.Errorf("cannot reopen race %q while race %q is ongoing — pause or complete it first", raceDisplayName(&e.raceState), raceDisplayName(other))
			}
			if e.stopActivePracticeSessionLocked() {
				practiceChanged = true
			}
			e.raceState.Lifecycle = domain.LifecycleActive
		}
		prevActiveHeat := e.findHeatLocked(e.raceState.ActiveHeatID)
		preserveActiveHeat := prevActiveHeat != nil &&
			prevActiveHeat.ID != h.ID &&
			(prevActiveHeat.State == domain.HeatCountdown ||
				prevActiveHeat.State == domain.HeatRunning ||
				prevActiveHeat.State == domain.HeatPaused ||
				prevActiveHeat.State == domain.HeatStaged ||
				prevActiveHeat.State == domain.HeatReady)
		h.State = domain.HeatFinished
		for si := range e.raceState.Stages {
			stg := &e.raceState.Stages[si]
			if stg.Index == h.StageIndex && stg.CompletedEarly && len(race.OutgoingStageConnections(&e.raceState, stg.Index)) == 0 {
				stg.CompletedEarly = false
			}
		}
		if h.StageIndex == 1 && !race.AnyRealHeatStartedInStage(&e.raceState, 2) {
			e.raceState.Stage2SeededEarly = false
		}
		e.resolveActiveTournamentLocked()
		if !preserveActiveHeat && !e.hasLiveRunningHeatLocked() {
			if e.raceState.ActiveHeatID == "" || wasCompleted || (prevActiveHeat != nil && prevActiveHeat.State == domain.HeatConfirmed) {
				e.raceState.ActiveHeatID = h.ID
			}
			if e.raceState.Mode == domain.ModeRace {
				e.stageOrDisarmActiveRaceLocked()
				cfgChanged = true
			}
		}

	default:
		e.mu.Unlock()
		return cloneRaceState(e.raceState), fmt.Errorf("unknown race control action %q", action)
	}

	e.syncActiveRaceToEventLocked()
	snap := cloneRaceState(e.raceState)
	var practiceSnap domain.PracticeManagerState
	if practiceChanged {
		practiceSnap = clonePracticeManagerState(e.practiceState)
	}
	pilotsCopy := append([]domain.PilotSlot(nil), e.pilots...)
	gatesCopy := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	if cfgChanged {
		for _, s := range subs {
			s.OnConfigUpdated(pilotsCopy, gatesCopy)
		}
	}
	if practiceChanged {
		e.notifyPracticeUpdated(practiceSnap, subs)
	}
	e.notifyRaceUpdated(snap, ann, subs)
	return snap, nil
}

// RaceMarshalPayload describes a marshal adjustment on a pilot in a heat.
type RaceMarshalPayload struct {
	RaceID             string  `json:"raceId,omitempty"`
	HeatID             string  `json:"heatId"`
	PilotSlotIndex     int     `json:"pilotSlotIndex"`
	Action             string  `json:"action"` // "toggle_dnf" | "toggle_dq" | "toggle_dns" | "add_lap" | "toggle_lap" | "add_crossing" | "move_crossing" | "delete_crossing" | "move_up" | "move_down" | "reorder_seats" | "set_penalty" | "clear_override"
	CrossingID         uint64  `json:"crossingId,omitempty"`
	OffsetMs           *int64  `json:"offsetMs,omitempty"`
	PenaltySec         float64 `json:"penaltySec,omitempty"`
	OrderedSlotIndices []int   `json:"orderedSlotIndices,omitempty"`
}

// MarshalPilotAction applies live or post-heat adjustments (DNF/crashed out, DQ, manual lap,
// lap invalidation, placement reorder, or time penalty).
func (e *Engine) MarshalPilotAction(req RaceMarshalPayload) (domain.RaceTournamentState, error) {
	nowUs := e.NowUs()
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()

	var swap targetRaceSwap
	if req.RaceID != "" || e.editingRaceID != "" {
		var swapErr error
		swap, swapErr = e.enterTargetRaceLocked(req.RaceID)
		if swapErr != nil {
			snap := cloneRaceState(e.raceState)
			e.mu.Unlock()
			return snap, swapErr
		}
	}

	targetID := strings.TrimSpace(req.HeatID)
	if targetID == "" {
		targetID = e.raceState.ActiveHeatID
	}
	h := e.findHeatLocked(targetID)
	if h == nil {
		snap := e.exitTargetRaceLocked(&swap, false)
		e.mu.Unlock()
		return snap, fmt.Errorf("heat not found")
	}
	if h.State == domain.HeatConfirmed {
		snap := e.exitTargetRaceLocked(&swap, false)
		e.mu.Unlock()
		return snap, fmt.Errorf("unlock confirmed heat to Review before editing")
	}

	seatIdx := -1
	for i := range h.Seats {
		if h.Seats[i].PilotSlotIndex == req.PilotSlotIndex {
			seatIdx = i
			break
		}
	}
	if seatIdx < 0 {
		snap := e.exitTargetRaceLocked(&swap, false)
		e.mu.Unlock()
		return snap, fmt.Errorf("pilot slot %d is not in heat %s", req.PilotSlotIndex, h.ID)
	}
	seat := &h.Seats[seatIdx]
	var ann *domain.RaceAnnouncement

	wasHeatRunning := h.State == domain.HeatRunning
	prevStatus := seat.Status
	prevLaps := seat.LapsCompleted
	prevValidPasses := countSeatValidCrossings(seat)
	switch req.Action {
	case "toggle_dnf":
		toggleSeatMarshalOverride(h, seat, domain.PilotHeatDNF, e.raceState.Config.QualifyingMetric)
		if seat.Status == domain.PilotHeatDNF && h.State == domain.HeatRunning {
			ann = &domain.RaceAnnouncement{
				Kind:      "pilot_dnf",
				HeatID:    h.ID,
				SlotIndex: seat.PilotSlotIndex,
				Callsign:  seat.Callsign,
			}
		}

	case "toggle_dq":
		toggleSeatMarshalOverride(h, seat, domain.PilotHeatDQ, e.raceState.Config.QualifyingMetric)

	case "toggle_dns":
		toggleSeatMarshalOverride(h, seat, domain.PilotHeatDNS, e.raceState.Config.QualifyingMetric)

	case "set_dns":
		if seat.Status != domain.PilotHeatDNS {
			toggleSeatMarshalOverride(h, seat, domain.PilotHeatDNS, e.raceState.Config.QualifyingMetric)
		}

	case "set_dnf":
		wasExplicitDNF := seat.Status == domain.PilotHeatDNF && seat.StatusOverridden
		if !wasExplicitDNF {
			toggleSeatMarshalOverride(h, seat, domain.PilotHeatDNF, e.raceState.Config.QualifyingMetric)
			if seat.Status == domain.PilotHeatDNF && h.State == domain.HeatRunning {
				ann = &domain.RaceAnnouncement{
					Kind:      "pilot_dnf",
					HeatID:    h.ID,
					SlotIndex: seat.PilotSlotIndex,
					Callsign:  seat.Callsign,
				}
			}
		}

	case "set_dq":
		if seat.Status != domain.PilotHeatDQ {
			toggleSeatMarshalOverride(h, seat, domain.PilotHeatDQ, e.raceState.Config.QualifyingMetric)
		}

	case "set_racing":
		restoreSeatFromOverride(h, seat, seat.Status, e.raceState.Config.QualifyingMetric)
		if (h.State == domain.HeatRunning || h.State == domain.HeatPaused) && seat.Status != domain.PilotHeatFinished {
			seat.Status = domain.PilotHeatRacing
			race.RecomputeHeat(h, e.raceState.Config.QualifyingMetric)
		}

	case "set_finished":
		restoreSeatFromOverride(h, seat, seat.Status, e.raceState.Config.QualifyingMetric)
		if h.State == domain.HeatRunning || h.State == domain.HeatPaused {
			if seat.Status != domain.PilotHeatFinished {
				seat.Status = domain.PilotHeatRacing
				race.RecomputeHeat(h, e.raceState.Config.QualifyingMetric)
			}
		} else if !isUnstartedHeatState(h.State) && h.State != domain.HeatCountdown && seat.Status != domain.PilotHeatFinished {
			seat.PreOverrideStatus = seat.Status
			seat.StatusOverridden = true
			seat.Status = domain.PilotHeatFinished
			race.RecomputeHeat(h, e.raceState.Config.QualifyingMetric)
		}

	case "add_lap":
		e.nextEventID++
		cid := e.nextEventID
		baseUs := nowUs
		if h.StartToneUs == 0 {
			h.StartToneUs = nowUs
		}
		if len(seat.Crossings) == 0 {
			// If pilot had no holeshot yet, insert both holeshot (at +0.8s) and Lap 1 (+12.0s or nowUs)!
			hsUs := h.StartToneUs + 800_000
			e.nextEventID++
			seat.Crossings = append(seat.Crossings,
				domain.HeatCrossing{CrossingID: cid, TimestampUs: hsUs, Manual: true},
				domain.HeatCrossing{CrossingID: e.nextEventID, TimestampUs: maxUint64(baseUs, hsUs+10_000_000), Manual: true},
			)
		} else {
			lastUs := seat.Crossings[len(seat.Crossings)-1].TimestampUs
			nextUs := baseUs
			if h.State != domain.HeatRunning || nextUs <= lastUs+1_000_000 {
				nextUs = lastUs + 12_000_000 // +12.0s synthetic lap when added post-race
			}
			seat.Crossings = append(seat.Crossings, domain.HeatCrossing{
				CrossingID:  cid,
				TimestampUs: nextUs,
				Manual:      true,
			})
		}

	case "toggle_lap":
		for i := range seat.Crossings {
			if seat.Crossings[i].CrossingID == req.CrossingID {
				seat.Crossings[i].Invalidated = !seat.Crossings[i].Invalidated
				break
			}
		}

	case "add_crossing":
		if req.OffsetMs == nil {
			snap := e.exitTargetRaceLocked(&swap, false)
			e.mu.Unlock()
			return snap, fmt.Errorf("offsetMs is required for add_crossing")
		}
		if h.StartToneUs == 0 {
			h.StartToneUs = nowUs
		}
		targetUs := crossingTimestampFromOffset(h.StartToneUs, *req.OffsetMs)
		e.nextEventID++
		peak := lookupRssiNearOffset(seat.RssiTrace, int32(*req.OffsetMs))
		seat.Crossings = append(seat.Crossings, domain.HeatCrossing{
			CrossingID:  e.nextEventID,
			TimestampUs: targetUs,
			PeakRSSIDbm: peak,
			Manual:      true,
		})
		sort.SliceStable(seat.Crossings, func(a, b int) bool {
			return seat.Crossings[a].TimestampUs < seat.Crossings[b].TimestampUs
		})

	case "move_crossing":
		if req.OffsetMs == nil || req.CrossingID == 0 {
			snap := e.exitTargetRaceLocked(&swap, false)
			e.mu.Unlock()
			return snap, fmt.Errorf("crossingId and offsetMs are required for move_crossing")
		}
		if h.StartToneUs == 0 {
			h.StartToneUs = nowUs
		}
		targetUs := crossingTimestampFromOffset(h.StartToneUs, *req.OffsetMs)
		found := false
		for i := range seat.Crossings {
			if seat.Crossings[i].CrossingID == req.CrossingID {
				seat.Crossings[i].TimestampUs = targetUs
				if peak := lookupRssiNearOffset(seat.RssiTrace, int32(*req.OffsetMs)); peak != 0 {
					seat.Crossings[i].PeakRSSIDbm = peak
				}
				seat.Crossings[i].Manual = true
				found = true
				break
			}
		}
		if !found {
			snap := e.exitTargetRaceLocked(&swap, false)
			e.mu.Unlock()
			return snap, fmt.Errorf("crossing %d not found", req.CrossingID)
		}
		sort.SliceStable(seat.Crossings, func(a, b int) bool {
			return seat.Crossings[a].TimestampUs < seat.Crossings[b].TimestampUs
		})

	case "delete_crossing":
		if req.CrossingID == 0 {
			snap := e.exitTargetRaceLocked(&swap, false)
			e.mu.Unlock()
			return snap, fmt.Errorf("crossingId is required for delete_crossing")
		}
		kept := seat.Crossings[:0]
		for _, c := range seat.Crossings {
			if c.CrossingID != req.CrossingID {
				kept = append(kept, c)
			}
		}
		seat.Crossings = kept
		if len(seat.Crossings) == 0 {
			seat.Laps = []domain.HeatLap{}
		}

	case "move_up", "move_down":
		// Materialize explicit positions on all non-DQ seats and swap with neighbor
		race.RecomputeHeat(h, e.raceState.Config.QualifyingMetric)
		e.markHeatUnsyncedMGPLocked(h.ID)
		curPos := seat.Position
		targetPos := curPos - 1
		if req.Action == "move_down" {
			targetPos = curPos + 1
		}
		if curPos > 0 && targetPos >= 1 {
			for i := range h.Seats {
				if h.Seats[i].PilotSlotIndex > 0 && h.Seats[i].Status != domain.PilotHeatDQ && h.Seats[i].Status != domain.PilotHeatDNS {
					if h.Seats[i].Position == targetPos {
						h.Seats[i].ManualPosition = curPos
						seat.ManualPosition = targetPos
					} else if h.Seats[i].PilotSlotIndex != seat.PilotSlotIndex {
						h.Seats[i].ManualPosition = h.Seats[i].Position
					}
				}
			}
		}

	case "reorder_seats":
		race.RecomputeHeat(h, e.raceState.Config.QualifyingMetric)
		e.markHeatUnsyncedMGPLocked(h.ID)
		assigned := make(map[int]bool, len(req.OrderedSlotIndices))
		nextRank := 1
		for _, slotIdx := range req.OrderedSlotIndices {
			if slotIdx <= 0 || assigned[slotIdx] {
				continue
			}
			for i := range h.Seats {
				s := &h.Seats[i]
				if s.PilotSlotIndex == slotIdx && s.Status != domain.PilotHeatDQ && s.Status != domain.PilotHeatDNS {
					s.ManualPosition = nextRank
					assigned[slotIdx] = true
					nextRank++
					break
				}
			}
		}
		for i := range h.Seats {
			s := &h.Seats[i]
			if s.PilotSlotIndex > 0 && s.Status != domain.PilotHeatDQ && s.Status != domain.PilotHeatDNS && !assigned[s.PilotSlotIndex] {
				s.ManualPosition = nextRank
				assigned[s.PilotSlotIndex] = true
				nextRank++
			}
		}

	case "set_penalty":
		if req.PenaltySec < 0 {
			req.PenaltySec = 0
		}
		seat.PenaltySec = req.PenaltySec

	case "clear_override":
		seat.ManualPosition = 0
		seat.PenaltySec = 0

	default:
		snap := e.exitTargetRaceLocked(&swap, false)
		e.mu.Unlock()
		return snap, fmt.Errorf("unknown marshal action %q", req.Action)
	}

	race.RecomputeHeat(h, e.raceState.Config.QualifyingMetric)
	e.markHeatUnsyncedMGPLocked(h.ID)
	if (h.State == domain.HeatFinished || h.State == domain.HeatConfirmed) &&
		!seat.StatusOverridden &&
		(req.Action == "toggle_lap" || req.Action == "add_lap" || req.Action == "add_crossing" || req.Action == "move_crossing" || req.Action == "delete_crossing") &&
		(seat.Status == domain.PilotHeatFinished || seat.Status == domain.PilotHeatDNF || seat.Status == domain.PilotHeatRacing) {
		if h.StageFormat == domain.FormatQualifying || h.StageFormat == domain.FormatOpenQualifier || h.TargetLaps == 0 {
			if seat.LapsCompleted > 0 {
				seat.Status = domain.PilotHeatFinished
			} else {
				seat.Status = domain.PilotHeatDNF
			}
		} else if seat.LapsCompleted >= h.TargetLaps {
			seat.Status = domain.PilotHeatFinished
		} else {
			seat.Status = domain.PilotHeatDNF
		}
		race.RecomputeHeat(h, e.raceState.Config.QualifyingMetric)
		e.markHeatUnsyncedMGPLocked(h.ID)
	}

	if (req.Action == "add_lap" || req.Action == "add_crossing") && h.State == domain.HeatRunning &&
		prevStatus == domain.PilotHeatRacing && seat.Status == domain.PilotHeatFinished {
		ann = &domain.RaceAnnouncement{
			Kind:        "pilot_finished",
			HeatID:      h.ID,
			SlotIndex:   seat.PilotSlotIndex,
			Callsign:    seat.Callsign,
			Position:    seat.Position,
			Competitive: isCompetitiveHeat(h),
		}
	} else if (req.Action == "add_lap" || req.Action == "add_crossing") && h.State == domain.HeatRunning &&
		seatEnteredLastLap(h, seat, prevStatus, prevLaps, prevValidPasses) {
		ann = &domain.RaceAnnouncement{
			Kind:        "pilot_last_lap",
			HeatID:      h.ID,
			SlotIndex:   seat.PilotSlotIndex,
			Callsign:    seat.Callsign,
			Competitive: isCompetitiveHeat(h),
		}
	}

	// If heat is running and every active pilot is now Finished, DNF, DNS, or DQ -> auto-finish the heat!
	if h.State == domain.HeatRunning && e.allActiveSeatsDoneLocked(h) {
		finishAnn := e.finishHeatLocked(h)
		if ann == nil {
			ann = finishAnn
		}
	}

	cfgChanged := false
	if !swap.swapped && h.ID == e.raceState.ActiveHeatID && (e.isLiveRaceHeatActiveLocked() || e.raceState.Mode == domain.ModeRace) &&
		(req.Action == "toggle_dq" || req.Action == "toggle_dns" || req.Action == "set_dq" || req.Action == "set_dns" || req.Action == "set_dnf" || req.Action == "set_finished" || req.Action == "set_racing") {
		e.syncHeatRFSlotsLocked(h)
		cfgChanged = true
	}
	if !swap.swapped && wasHeatRunning && h.State == domain.HeatFinished && e.exitLiveRaceHeatLocked() {
		cfgChanged = true
	}

	e.resolveActiveTournamentLocked()
	if h.State == domain.HeatFinished || h.State == domain.HeatConfirmed {
		e.markHeatUnsyncedMGPLocked(h.ID)
	}
	var targetSnap domain.RaceTournamentState
	if swap.swapped {
		targetSnap = e.exitTargetRaceLocked(&swap, true)
	} else {
		e.syncActiveRaceToEventLocked()
		targetSnap = cloneRaceState(e.raceState)
	}
	activeSnap := cloneRaceState(e.raceState)
	pilotsCopy := append([]domain.PilotSlot(nil), e.pilots...)
	gatesCopy := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	if cfgChanged {
		for _, s := range subs {
			s.OnConfigUpdated(pilotsCopy, gatesCopy)
		}
	}
	e.notifyRaceUpdated(activeSnap, ann, subs)
	return targetSnap, nil
}

func countSeatValidCrossings(seat *domain.HeatSeat) int {
	if seat == nil {
		return 0
	}
	cnt := 0
	for _, c := range seat.Crossings {
		if !c.Invalidated {
			cnt++
		}
	}
	return cnt
}

func seatEnteredLastLap(
	h *domain.RaceHeat,
	seat *domain.HeatSeat,
	prevStatus domain.PilotHeatStatus,
	prevLaps int,
	prevValidPasses int,
) bool {
	if h == nil || seat == nil || h.TargetLaps <= 0 {
		return false
	}
	if prevStatus != domain.PilotHeatRacing || seat.Status != domain.PilotHeatRacing {
		return false
	}
	if h.TargetLaps == 1 {
		return prevValidPasses == 0 && countSeatValidCrossings(seat) == 1 && seat.LapsCompleted == 0
	}
	return prevLaps < h.TargetLaps-1 && seat.LapsCompleted == h.TargetLaps-1
}

// recordRaceCrossingLocked is called from IngestTelemetryFrame when an accepted Start/Finish gate
// crossing occurs during a `HeatRunning` heat.
func (e *Engine) recordRaceCrossingLocked(
	ev domain.GateCrossingEvent,
	completedLap *domain.LapRecord,
) (changed bool, cfgRestored bool, ann *domain.RaceAnnouncement) {
	if !e.raceState.Generated || !ev.IsStartFinish {
		return false, false, nil
	}
	h := e.findLiveRunningHeatLocked()
	if h == nil || h.State != domain.HeatRunning {
		return false, false, nil
	}
	var seat *domain.HeatSeat
	for i := range h.Seats {
		if h.Seats[i].PilotSlotIndex == ev.SlotIndex {
			seat = &h.Seats[i]
			break
		}
	}
	if seat == nil || seat.Status != domain.PilotHeatRacing {
		return false, false, nil
	}

	hadAnyValidBefore := heatHasAnyValidCrossing(h)
	prevLaps := seat.LapsCompleted
	prevValidPasses := countSeatValidCrossings(seat)

	var sectors []domain.SectorSplit
	if completedLap != nil && len(completedLap.Sectors) > 0 {
		sectors = append([]domain.SectorSplit(nil), completedLap.Sectors...)
	}
	seat.Crossings = append(seat.Crossings, domain.HeatCrossing{
		CrossingID:  ev.EventID,
		TimestampUs: ev.TimestampUs,
		PeakRSSIDbm: ev.PeakRSSIDbm,
		Sectors:     sectors,
	})

	prevStatus := seat.Status
	race.RecomputeHeat(h, e.raceState.Config.QualifyingMetric)
	e.markHeatUnsyncedMGPLocked(h.ID)
	comp := isCompetitiveHeat(h)

	if prevStatus == domain.PilotHeatRacing && seat.Status == domain.PilotHeatFinished {
		ann = &domain.RaceAnnouncement{
			Kind:        "pilot_finished",
			HeatID:      h.ID,
			SlotIndex:   seat.PilotSlotIndex,
			Callsign:    seat.Callsign,
			Position:    seat.Position,
			Competitive: comp,
		}
	} else if !hadAnyValidBefore && comp && seat.HoleshotWinner {
		ann = &domain.RaceAnnouncement{
			Kind:        "holeshot",
			HeatID:      h.ID,
			SlotIndex:   seat.PilotSlotIndex,
			Callsign:    seat.Callsign,
			Position:    1,
			Competitive: true,
		}
	} else if seatEnteredLastLap(h, seat, prevStatus, prevLaps, prevValidPasses) {
		ann = &domain.RaceAnnouncement{
			Kind:        "pilot_last_lap",
			HeatID:      h.ID,
			SlotIndex:   seat.PilotSlotIndex,
			Callsign:    seat.Callsign,
			Competitive: comp,
		}
	}

	if e.allActiveSeatsDoneLocked(h) {
		finishAnn := e.finishHeatLocked(h)
		if e.exitLiveRaceHeatLocked() {
			cfgRestored = true
		}
		if ann == nil {
			ann = finishAnn
		}
	}
	return true, cfgRestored, ann
}

func (e *Engine) allActiveSeatsDoneLocked(h *domain.RaceHeat) bool {
	hasPilots := false
	for _, s := range h.Seats {
		if s.PilotSlotIndex <= 0 {
			continue
		}
		hasPilots = true
		if s.Status == domain.PilotHeatRacing || s.Status == domain.PilotHeatStaged {
			return false
		}
	}
	return hasPilots
}

func (e *Engine) findLiveRunningHeatLocked() *domain.RaceHeat {
	if h := e.findHeatLocked(e.raceState.ActiveHeatID); h != nil && (h.State == domain.HeatCountdown || h.State == domain.HeatRunning) {
		return h
	}
	for i := range e.raceState.Heats {
		if e.raceState.Heats[i].State == domain.HeatCountdown || e.raceState.Heats[i].State == domain.HeatRunning {
			return &e.raceState.Heats[i]
		}
	}
	return nil
}

func (e *Engine) hasLiveRunningHeatLocked() bool {
	return e.findLiveRunningHeatLocked() != nil
}

func (e *Engine) isLiveRaceHeatActiveLocked() bool {
	if !e.raceState.Generated ||
		e.raceState.Lifecycle == domain.LifecyclePaused ||
		e.raceState.Lifecycle == domain.LifecycleCompleted ||
		e.raceState.Lifecycle == domain.LifecycleScrapped {
		return false
	}
	if e.findLiveRunningHeatLocked() != nil {
		return true
	}
	h := e.findHeatLocked(e.raceState.ActiveHeatID)
	return h != nil && h.State == domain.HeatPaused
}

func (e *Engine) enterLiveRaceHeatLocked(h *domain.RaceHeat) {
	if h == nil {
		return
	}
	if !e.practiceSnap.Saved {
		e.practiceSnap = domain.PracticeSnapshot{
			Saved:     true,
			RaceArmed: e.raceArmed,
			Pilots:    append([]domain.PilotSlot(nil), e.pilots...),
			Laps:      cloneLaps(e.laps),
			Crossings: append([]domain.GateCrossingEvent(nil), e.crossings...),
			Filtered:  append([]domain.FilteredDetection(nil), e.filtered...),
		}
	}
	for i := range e.raceState.Heats {
		if e.raceState.Heats[i].ID != h.ID && e.raceState.Heats[i].State == domain.HeatStaged {
			e.raceState.Heats[i].State = domain.HeatReady
		}
	}
	e.raceState.ActiveHeatID = h.ID
	e.syncHeatRFSlotsLocked(h)
}

func (e *Engine) exitLiveRaceHeatLocked() bool {
	if e.raceState.Mode == domain.ModeRace {
		return false
	}
	// If any race is still ongoing (e.g. between heats of an active tournament), keep Practice
	// stopped and disarm RF slots while restoring global default channels on `#/pilots`.
	if isRaceOngoing(&e.raceState) || e.findAnyOngoingRaceLocked() != nil || e.practiceState.ActiveSessionID == "" {
		if e.practiceSnap.Saved {
			bySlot := make(map[int]domain.PilotSlot, len(e.practiceSnap.Pilots))
			for _, sp := range e.practiceSnap.Pilots {
				bySlot[sp.SlotIndex] = sp
			}
			for i := range e.pilots {
				e.pilots[i].Enabled = false
				if sp, ok := bySlot[e.pilots[i].SlotIndex]; ok {
					e.pilots[i].Band = sp.Band
					e.pilots[i].Channel = sp.Channel
					e.pilots[i].FrequencyMHz = sp.FrequencyMHz
				}
			}
			e.practiceSnap.Saved = false
		} else {
			for i := range e.pilots {
				e.pilots[i].Enabled = false
			}
		}
		e.raceArmed = false
		return true
	}
	if !e.practiceSnap.Saved {
		return false
	}
	e.restorePracticeSnapshotLocked()
	e.practiceSnap.Saved = false
	return true
}

func (e *Engine) findHeatLocked(heatID string) *domain.RaceHeat {
	if heatID == "" {
		return nil
	}
	for i := range e.raceState.Heats {
		if e.raceState.Heats[i].ID == heatID {
			return &e.raceState.Heats[i]
		}
	}
	return nil
}

func (e *Engine) disarmAllPilotSlotsForRaceLocked() {
	for i := range e.pilots {
		e.pilots[i].Enabled = false
		e.pilots[i].Channel = 0
		e.pilots[i].FrequencyMHz = 0
	}
	e.raceArmed = false
}

func (e *Engine) syncHeatRFSlotsLocked(target *domain.RaceHeat) {
	if target == nil ||
		e.raceState.Lifecycle == domain.LifecyclePaused ||
		e.raceState.Lifecycle == domain.LifecycleScrapped ||
		e.raceState.Lifecycle == domain.LifecycleCompleted {
		e.disarmAllPilotSlotsForRaceLocked()
		return
	}
	seatByPilot := make(map[int]domain.HeatSeat, len(target.Seats))
	for _, s := range target.Seats {
		if s.PilotSlotIndex > 0 && s.Channel >= 1 && s.Channel <= 8 &&
			s.Status != domain.PilotHeatDNS && s.Status != domain.PilotHeatDQ {
			seatByPilot[s.PilotSlotIndex] = s
		}
	}
	var sfGate *domain.TrackGate
	for gi := range e.gates {
		if e.gates[gi].Role == domain.GateRoleStartFinish {
			sfGate = &e.gates[gi]
			break
		}
	}
	for i := range e.pilots {
		if s, ok := seatByPilot[e.pilots[i].SlotIndex]; ok {
			b := s.Band
			if b == 0 {
				b = domain.BandRaceband
			}
			freq := s.FrequencyMHz
			if freq == 0 {
				freq = domain.FrequencyForBandChannel(b, s.Channel)
			}
			e.pilots[i].Enabled = true
			e.pilots[i].Band = b
			e.pilots[i].Channel = s.Channel
			e.pilots[i].FrequencyMHz = freq
			if sfGate != nil {
				var enter, exit float32
				hwMode := domain.NormalizeTimingHardwareMode(e.timingHardwareMode)
				target.HardwareMode = hwMode
				switch hwMode {
				case domain.HardwareModeLapRF:
					enter = laprfThresholdFor(sfGate, i, e.pilots[i])
					exit = enter
				case domain.HardwareModeRotorHazard, domain.HardwareModeRotorHazardUSB:
					enter, exit = rhThresholdsFor(sfGate, i, e.pilots[i])
				default:
					enter, exit = thresholdsFor(sfGate, i, e.pilots[i])
				}
				for si := range target.Seats {
					if target.Seats[si].PilotSlotIndex == e.pilots[i].SlotIndex {
						target.Seats[si].EnterRssiDbm = enter
						target.Seats[si].ExitRssiDbm = exit
					}
				}
			}
		} else {
			e.pilots[i].Enabled = false
			e.pilots[i].Channel = 0
			e.pilots[i].FrequencyMHz = 0
		}
	}
}

func (e *Engine) stageHeatLocked(heatID string, promoteReadyToStaged bool) {
	target := e.findHeatLocked(heatID)
	if target == nil {
		return
	}
	for i := range e.raceState.Heats {
		if e.raceState.Heats[i].ID != heatID && e.raceState.Heats[i].State == domain.HeatStaged {
			e.raceState.Heats[i].State = domain.HeatReady
		}
	}
	if promoteReadyToStaged && target.State == domain.HeatReady {
		target.State = domain.HeatStaged
	}
	e.raceState.ActiveHeatID = target.ID

	// Only take over Practice hardware RF slots when explicitly in legacy Race Mode or during a live heat;
	// otherwise keep open Practice channels & timing active until the Race Director starts the heat!
	if e.raceState.Mode == domain.ModeRace ||
		target.State == domain.HeatCountdown ||
		target.State == domain.HeatRunning ||
		target.State == domain.HeatPaused {
		e.syncHeatRFSlotsLocked(target)
		if target.State != domain.HeatRunning {
			e.raceArmed = false
		}
		e.resetSessionLocked()
	}
}

func cloneLaps(src []domain.LapRecord) []domain.LapRecord {
	out := make([]domain.LapRecord, len(src))
	for i, l := range src {
		cp := l
		cp.Sectors = append([]domain.SectorSplit(nil), l.Sectors...)
		out[i] = cp
	}
	return out
}

func (e *Engine) findStageByIndexLocked(stageIdx int) *domain.RaceStage {
	for i := range e.raceState.Stages {
		if e.raceState.Stages[i].Index == stageIdx {
			return &e.raceState.Stages[i]
		}
	}
	return nil
}

func (e *Engine) validateStageCanRunHeatLocked(h *domain.RaceHeat) error {
	if h == nil {
		return nil
	}
	race.EnsureStagesMetadata(&e.raceState)
	stg := e.findStageByIndexLocked(h.StageIndex)
	stgTitle := fmt.Sprintf("Stage %d", h.StageIndex)
	if stg != nil && stg.Title != "" {
		stgTitle = stg.Title
	}
	if e.hasLiveRunningHeatLocked() && e.raceState.ActiveHeatID != h.ID {
		return fmt.Errorf("pause or finish the active heat before starting heats in %s", stgTitle)
	}
	if stg != nil {
		if stg.Dangling {
			if stg.DanglingReason != "" {
				return fmt.Errorf("%s", stg.DanglingReason)
			}
			return fmt.Errorf("%s is disconnected in Format — connect it into the stage DAG first", stgTitle)
		}
		if !stg.PrerequisitesMet {
			if len(stg.WaitingOnStageNames) > 0 {
				return fmt.Errorf("cannot start %s yet — complete %s first", stgTitle, strings.Join(stg.WaitingOnStageNames, ", "))
			}
			return fmt.Errorf("cannot start %s yet — upstream stages must finish first", stgTitle)
		}
		if stg.PausedByUser {
			return fmt.Errorf("%s is paused — resume this stage before starting heats", stgTitle)
		}
	}
	if e.raceState.ActiveStageIndex != h.StageIndex && h.StageIndex >= 1 {
		if prev := e.findStageByIndexLocked(e.raceState.ActiveStageIndex); prev != nil {
			if prev.Status != domain.StageStatusCompleted && race.AnyRealHeatStartedInStage(&e.raceState, prev.Index) {
				prev.PausedByUser = true
			}
		}
		e.raceState.ActiveStageIndex = h.StageIndex
	}
	return nil
}

func cloneRaceState(st domain.RaceTournamentState) domain.RaceTournamentState {
	out := st
	if st.MGPLink != nil {
		mc := *st.MGPLink
		if len(st.MGPLink.SyncedHeatAt) > 0 {
			mc.SyncedHeatAt = make(map[string]string, len(st.MGPLink.SyncedHeatAt))
			for k, v := range st.MGPLink.SyncedHeatAt {
				mc.SyncedHeatAt[k] = v
			}
		}
		if len(st.MGPLink.UnsyncedHeats) > 0 {
			mc.UnsyncedHeats = make(map[string]bool, len(st.MGPLink.UnsyncedHeats))
			for k, v := range st.MGPLink.UnsyncedHeats {
				mc.UnsyncedHeats[k] = v
			}
		}
		out.MGPLink = &mc
	}
	out.Tags = append([]string(nil), st.Tags...)
	out.Config.SeatChannels = append([]uint8(nil), st.Config.SeatChannels...)
	out.TrackSnapshot = append([]domain.TrackGate(nil), st.TrackSnapshot...)
	out.Roster = append([]domain.EventPilot(nil), st.Roster...)
	if len(st.Stages) > 0 {
		out.Stages = make([]domain.RaceStage, len(st.Stages))
		for i, s := range st.Stages {
			sc := s
			sc.Settings.SeatChannels = append([]uint8(nil), s.Settings.SeatChannels...)
			sc.WaitingOnStageNames = append([]string(nil), s.WaitingOnStageNames...)
			sc.Standings = append([]domain.TournamentStanding(nil), s.Standings...)
			out.Stages[i] = sc
		}
	} else {
		out.Stages = nil
	}
	out.StageConnections = append([]domain.StageConnection(nil), st.StageConnections...)
	out.Rounds = append([]domain.RaceRound(nil), st.Rounds...)
	out.Connections = append([]domain.RoundConnection(nil), st.Connections...)
	out.Heats = make([]domain.RaceHeat, len(st.Heats))
	for i, h := range st.Heats {
		hc := h
		hc.Seats = make([]domain.HeatSeat, len(h.Seats))
		for j, s := range h.Seats {
			sc := s
			if s.Feeder != nil {
				fc := *s.Feeder
				sc.Feeder = &fc
			}
			sc.RssiTrace = append([]domain.HeatRssiSample(nil), s.RssiTrace...)
			sc.Crossings = make([]domain.HeatCrossing, len(s.Crossings))
			for k, c := range s.Crossings {
				cc := c
				cc.Sectors = append([]domain.SectorSplit(nil), c.Sectors...)
				sc.Crossings[k] = cc
			}
			sc.Laps = make([]domain.HeatLap, len(s.Laps))
			for k, l := range s.Laps {
				lc := l
				lc.Sectors = append([]domain.SectorSplit(nil), l.Sectors...)
				sc.Laps[k] = lc
			}
			hc.Seats[j] = sc
		}
		out.Heats[i] = hc
	}
	out.Edges = make([]domain.BracketEdge, len(st.Edges))
	for i, e := range st.Edges {
		ec := e
		ec.Ranks = append([]int(nil), e.Ranks...)
		out.Edges[i] = ec
	}
	out.Standings = append([]domain.TournamentStanding(nil), st.Standings...)
	out.QualStandings = append([]domain.TournamentStanding(nil), st.QualStandings...)
	return out
}

func maxUint64(a, b uint64) uint64 {
	if a > b {
		return a
	}
	return b
}

func naturalSeatStatusForHeat(h *domain.RaceHeat, seat *domain.HeatSeat) domain.PilotHeatStatus {
	if isUnstartedHeatState(h.State) || h.State == domain.HeatCountdown {
		return domain.PilotHeatStaged
	}
	if h.State == domain.HeatRunning || h.State == domain.HeatPaused {
		if h.TargetLaps > 0 && h.StartMode == domain.StartModeHeadsUp && seat.LapsCompleted >= h.TargetLaps {
			return domain.PilotHeatFinished
		}
		return domain.PilotHeatRacing
	}
	if h.StageFormat == domain.FormatQualifying || h.StageFormat == domain.FormatOpenQualifier || h.TargetLaps == 0 {
		if seat.LapsCompleted > 0 {
			return domain.PilotHeatFinished
		}
		return domain.PilotHeatDNF
	}
	if seat.LapsCompleted >= h.TargetLaps {
		return domain.PilotHeatFinished
	}
	return domain.PilotHeatDNF
}

// restoreSeatFromOverride clears `StatusOverridden` / `PreOverrideStatus` / `RosterDQ` and restores
// the pilot's original pre-override state (adapted cleanly to the heat's current lifecycle state)
// while recomputing valid laps from preserved `Crossings`.
func restoreSeatFromOverride(h *domain.RaceHeat, seat *domain.HeatSeat, clearedTarget domain.PilotHeatStatus, qualMetric domain.QualifyingMetric) {
	savedPre := seat.PreOverrideStatus
	wasOverridden := seat.StatusOverridden

	seat.StatusOverridden = false
	seat.PreOverrideStatus = ""
	seat.RosterDQ = false

	// Temporarily set status to Racing so RecomputeHeat evaluates valid crossings without DQ/DNS/DNF suppression.
	seat.Status = domain.PilotHeatRacing
	race.RecomputeHeat(h, qualMetric)

	if isUnstartedHeatState(h.State) || h.State == domain.HeatCountdown {
		seat.Status = domain.PilotHeatStaged
	} else if h.State == domain.HeatRunning || h.State == domain.HeatPaused {
		if wasOverridden && savedPre == domain.PilotHeatFinished && (h.TargetLaps <= 0 || seat.LapsCompleted >= h.TargetLaps) {
			seat.Status = domain.PilotHeatFinished
		} else {
			seat.Status = naturalSeatStatusForHeat(h, seat)
		}
	} else {
		// Finished, Confirmed, or Aborted heat
		if wasOverridden && savedPre != "" &&
			savedPre != clearedTarget &&
			savedPre != domain.PilotHeatStaged &&
			savedPre != domain.PilotHeatRacing &&
			savedPre != domain.PilotHeatDNS &&
			savedPre != domain.PilotHeatDQ {
			seat.Status = savedPre
		} else {
			seat.Status = naturalSeatStatusForHeat(h, seat)
		}
	}
	race.RecomputeHeat(h, qualMetric)
}

// toggleSeatMarshalOverride enforces a mutually-exclusive 0-or-1 toggle across DNS, Crash Out (DNF),
// and Disqualify (DQ), preserving the seat's original pre-override status so toggling the active
// override OFF restores it faithfully.
func toggleSeatMarshalOverride(h *domain.RaceHeat, seat *domain.HeatSeat, target domain.PilotHeatStatus, qualMetric domain.QualifyingMetric) {
	if seat.Status == target && (target != domain.PilotHeatDNF || seat.StatusOverridden) {
		restoreSeatFromOverride(h, seat, target, qualMetric)
		return
	}
	if !seat.StatusOverridden {
		seat.PreOverrideStatus = seat.Status
		seat.StatusOverridden = true
	}
	seat.Status = target
	if target != domain.PilotHeatDQ {
		seat.RosterDQ = false
	}
	if target == domain.PilotHeatDQ || target == domain.PilotHeatDNS {
		seat.ManualPosition = 0
	}
	race.RecomputeHeat(h, qualMetric)
}

// randomCountdownDurationUs generates an unpredictable start horn delay within the nominal
// `cdSec -> 0` countdown window so the Race Controller sees a normal countdown (e.g. 5.0s -> 0.0s)
// while the actual horn fires randomly before or at 0.0s without pilots knowing when it will beep.
func randomCountdownDurationUs(cdSec int) uint64 {
	if cdSec <= 0 {
		return 0
	}
	nominalUs := uint64(cdSec) * 1_000_000
	var minUs uint64
	switch cdSec {
	case 1:
		minUs = 200_000
	case 2:
		minUs = 600_000
	default:
		minUs = nominalUs * 35 / 100
		if minUs > 1_800_000 {
			minUs = 1_800_000
		}
	}
	if nominalUs <= minUs {
		return nominalUs
	}
	spanUs := int64(nominalUs - minUs + 1)
	return minUs + uint64(rand.Int64N(spanUs))
}

func crossingTimestampFromOffset(startToneUs uint64, offsetMs int64) uint64 {
	offUs := offsetMs * 1000
	res := int64(startToneUs) + offUs
	if res < 1000 {
		return 1000
	}
	return uint64(res)
}

func lookupRssiNearOffset(trace []domain.HeatRssiSample, offsetMs int32) float32 {
	if len(trace) == 0 {
		return 0
	}
	found := false
	var best int16 = -300
	for _, pt := range trace {
		diff := pt.OffsetMs - offsetMs
		if diff < 0 {
			diff = -diff
		}
		if diff <= 260 {
			if !found || pt.Dbm > best {
				best = pt.Dbm
				found = true
			}
		}
	}
	if !found {
		return 0
	}
	return float32(best)
}

const (
	heatRssiBucketMs   = 95
	maxHeatRssiSamples = 3600
)

func (e *Engine) recordHeatRssiSampleLocked(slotIdx int, tsUs uint64, smoothedDbm, enterDbm, exitDbm float32) {
	if !e.raceState.Generated {
		return
	}
	h := e.findLiveRunningHeatLocked()
	if h == nil {
		return
	}
	var seat *domain.HeatSeat
	for i := range h.Seats {
		if h.Seats[i].PilotSlotIndex == slotIdx &&
			h.Seats[i].Status != domain.PilotHeatDNS &&
			h.Seats[i].Status != domain.PilotHeatDQ {
			seat = &h.Seats[i]
			break
		}
	}
	if seat == nil {
		return
	}
	h.HardwareMode = domain.NormalizeTimingHardwareMode(e.timingHardwareMode)
	seat.EnterRssiDbm = enterDbm
	seat.ExitRssiDbm = exitDbm

	var anchorUs uint64
	if h.State == domain.HeatRunning {
		anchorUs = h.StartToneUs
		if anchorUs == 0 {
			anchorUs = tsUs
		}
	} else {
		if h.CountdownStartUs == 0 {
			h.CountdownStartUs = tsUs
		}
		anchorUs = h.CountdownStartUs
	}

	offsetMs := int32((int64(tsUs) - int64(anchorUs)) / 1000)
	dbmInt := int16(math.Round(float64(smoothedDbm)))

	n := len(seat.RssiTrace)
	if n > 0 {
		last := &seat.RssiTrace[n-1]
		if offsetMs >= last.OffsetMs && offsetMs-last.OffsetMs < heatRssiBucketMs {
			// Peak-preserving downsampling: keep highest RSSI within each ~95ms bucket so gate peaks never flatten!
			if dbmInt > last.Dbm {
				last.Dbm = dbmInt
			}
			return
		}
		if offsetMs < last.OffsetMs {
			return
		}
	}
	if n >= maxHeatRssiSamples {
		return
	}
	seat.RssiTrace = append(seat.RssiTrace, domain.HeatRssiSample{
		OffsetMs: offsetMs,
		Dbm:      dbmInt,
	})
}

func (e *Engine) resetSingleHeatToStagedLocked(h *domain.RaceHeat) {
	if h == nil {
		return
	}
	_, att := e.activeEventRosterAndAttendanceLocked()
	h.State = domain.HeatStaged
	h.InOvertime = false
	h.ElapsedSec = 0
	h.CountdownRemainingSec = 0
	h.CountdownArmRemainingSec = 0
	h.CountdownDurationSec = 0
	h.CountdownBeeped = false
	h.CountdownBeepAtSec = 0
	h.StartToneUs = 0
	h.CountdownPromptUs = 0
	h.CountdownPrompted = false
	h.CountdownStartUs = 0
	h.CountdownEndUs = 0
	h.PausedAtUs = 0
	h.AccumulatedPauseUs = 0
	h.OvertimeStartedAtUs = 0
	for i := range h.Seats {
		s := &h.Seats[i]
		s.Crossings = nil
		s.RssiTrace = nil
		s.Laps = []domain.HeatLap{}
		s.PenaltySec = 0
		s.ManualPosition = 0
		s.PreOverrideStatus = ""
		s.StatusOverridden = false
		s.RosterDQ = false
		if s.PilotSlotIndex > 0 && att[s.PilotSlotIndex].IsAbsent() {
			s.Status = domain.PilotHeatDNS
		} else {
			s.Status = domain.PilotHeatStaged
		}
	}
	race.RecomputeHeat(h, e.raceState.Config.QualifyingMetric)
}

func (e *Engine) resetAbortedHeatsToStagedLocked() bool {
	resetAny := false
	for hi := range e.raceState.Heats {
		h := &e.raceState.Heats[hi]
		if h.State == domain.HeatAborted {
			e.resetSingleHeatToStagedLocked(h)
			e.markHeatUnsyncedMGPLocked(h.ID)
			resetAny = true
		}
	}
	return resetAny
}
