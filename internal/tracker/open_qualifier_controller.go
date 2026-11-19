package tracker

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"slaprf/internal/domain"
	"slaprf/internal/race"
)

func parsePilotsPortalStageIndex(id string) (int, bool) {
	trimmed := strings.TrimSpace(id)
	if !domain.IsStagePilotsInID(trimmed) {
		return 0, false
	}
	if trimmed == domain.Stage1PilotsInID {
		return 1, true
	}
	numStr := strings.TrimSuffix(strings.TrimPrefix(trimmed, "stage"), "-pilots-in")
	n, err := strconv.Atoi(numStr)
	if err != nil || n < 1 {
		return 1, true
	}
	return n, true
}

func extractPilotsConnTargetID(connID string) (int, string, bool) {
	trimmed := strings.TrimSpace(connID)
	if !strings.HasPrefix(trimmed, "conn-stage") {
		return 0, "", false
	}
	marker := "-pilots-in-"
	idx := strings.Index(trimmed, marker)
	if idx < 0 {
		return 0, "", false
	}
	prefix := strings.TrimPrefix(trimmed[:idx+len("-pilots-in")], "conn-")
	stgIdx, ok := parsePilotsPortalStageIndex(prefix)
	if !ok {
		return 0, "", false
	}
	targetID := trimmed[idx+len(marker):]
	if targetID == "" {
		return 0, "", false
	}
	return stgIdx, targetID, true
}

func (e *Engine) findOpenQualStageLocked(stageIdx int) (*domain.RaceStage, error) {
	race.EnsureStagesMetadata(&e.raceState)
	if stageIdx < 1 {
		stageIdx = e.raceState.ActiveStageIndex
	}
	if stageIdx < 1 {
		stageIdx = 1
	}
	stg := e.findStageByIndexLocked(stageIdx)
	if stg == nil {
		return nil, fmt.Errorf("stage %d not found", stageIdx)
	}
	if stg.Format != domain.FormatOpenQualifier {
		hasOQRound := false
		for _, r := range e.raceState.Rounds {
			if r.StageIndex == stg.Index && (r.StageFormat == domain.FormatOpenQualifier || domain.IsOpenQualRoundID(r.ID)) {
				hasOQRound = true
				break
			}
		}
		if !hasOQRound {
			return nil, fmt.Errorf("%s is not an Open Qualifier stage", stg.Title)
		}
	}
	return stg, nil
}

func isInFlightHeatState(state domain.HeatState) bool {
	return state == domain.HeatCountdown || state == domain.HeatRunning || state == domain.HeatPaused
}

func findPilotInFlightHeat(heats []domain.RaceHeat, slotIndex int) *domain.RaceHeat {
	for i := range heats {
		h := &heats[i]
		if !isInFlightHeatState(h.State) {
			continue
		}
		for _, s := range h.Seats {
			if s.PilotSlotIndex == slotIndex && s.Status != domain.PilotHeatDNS && s.Status != domain.PilotHeatDQ {
				return h
			}
		}
	}
	return nil
}

func countPilotPacksInStage(heats []domain.RaceHeat, stageIdx int, slotIndex int) (flownOrLive int, queuedUnstarted int) {
	for _, h := range heats {
		if h.StageIndex != stageIdx || h.State == domain.HeatAborted || h.StageFormat != domain.FormatOpenQualifier {
			continue
		}
		for _, s := range h.Seats {
			if s.PilotSlotIndex != slotIndex || s.Status == domain.PilotHeatDNS || s.Status == domain.PilotHeatDQ {
				continue
			}
			if isUnstartedHeatState(h.State) {
				queuedUnstarted++
			} else {
				flownOrLive++
			}
		}
	}
	return flownOrLive, queuedUnstarted
}

func packContainsPilot(h *domain.RaceHeat, slotIndex int) bool {
	if h == nil {
		return false
	}
	for _, s := range h.Seats {
		if s.PilotSlotIndex == slotIndex && s.Status != domain.PilotHeatDNS {
			return true
		}
	}
	return false
}

func packHasOtherActivePilots(h *domain.RaceHeat, excludeSlot int) bool {
	if h == nil {
		return false
	}
	for _, s := range h.Seats {
		if s.PilotSlotIndex > 0 && s.PilotSlotIndex != excludeSlot && s.Status != domain.PilotHeatDNS {
			return true
		}
	}
	return false
}

func nextOpenQualPackSeq(heats []domain.RaceHeat, stageIdx int) (string, string, int) {
	prefix := "OQ"
	if stageIdx >= 2 {
		prefix = fmt.Sprintf("S%d-OQ", stageIdx)
	}
	usedIDs := make(map[string]bool, len(heats))
	maxNum := 0
	for _, h := range heats {
		usedIDs[h.ID] = true
		if h.StageIndex == stageIdx {
			if strings.HasPrefix(h.ID, prefix+"-") {
				if n, err := strconv.Atoi(strings.TrimPrefix(h.ID, prefix+"-")); err == nil && n > maxNum {
					maxNum = n
				}
			}
		}
	}
	seq := maxNum + 1
	id := fmt.Sprintf("%s-%d", prefix, seq)
	for usedIDs[id] {
		seq++
		id = fmt.Sprintf("%s-%d", prefix, seq)
	}
	return id, fmt.Sprintf("Heat %d", seq), seq
}

func (e *Engine) spawnOpenQualPackLocked(stg *domain.RaceStage, stgSettings domain.StageSettings) *domain.RaceHeat {
	race.SyncRoundsMetadata(&e.raceState)
	roundID := domain.OpenQualRoundID(stg.Index)
	var oqRound *domain.RaceRound
	for i := range e.raceState.Rounds {
		r := &e.raceState.Rounds[i]
		if r.StageIndex == stg.Index && (domain.IsOpenQualRoundID(r.ID) || r.StageFormat == domain.FormatOpenQualifier) {
			roundID = r.ID
			oqRound = r
			break
		}
	}
	packID, packTitle, seq := nextOpenQualPackSeq(e.raceState.Heats, stg.Index)

	seats := make([]domain.HeatSeat, stgSettings.PilotsPerHeat)
	for si := 0; si < stgSettings.PilotsPerHeat; si++ {
		band, ch, freq, ok := domain.DecodeBandChannel(stgSettings.SeatChannels[si])
		if !ok {
			band = domain.BandRaceband
			ch = uint8((si % domain.MaxPilotSlots) + 1)
			freq = domain.RacebandFrequenciesMHz[ch-1]
		}
		seats[si] = domain.HeatSeat{
			SeatIndex:    si + 1,
			Band:         band,
			Channel:      ch,
			FrequencyMHz: freq,
			Status:       domain.PilotHeatStaged,
			SourceLabel:  "Open / BYE",
			Laps:         []domain.HeatLap{},
		}
	}

	roundTitle := stg.Title
	roundCol := 1
	roundNum := 1
	tLaps := stgSettings.TargetLaps
	tLimit := stgSettings.TimeLimitSec
	if oqRound != nil {
		if strings.TrimSpace(oqRound.Title) != "" {
			roundTitle = oqRound.Title
		}
		if oqRound.Column > 0 {
			roundCol = oqRound.Column
		}
		if oqRound.Round > 0 {
			roundNum = oqRound.Round
		}
		if oqRound.TargetLaps >= 0 {
			tLaps = oqRound.TargetLaps
		}
		if oqRound.TimeLimitSec >= 15 {
			tLimit = oqRound.TimeLimitSec
		}
	}

	shortPrefix := "OQ"
	if strings.Contains(strings.ToLower(roundTitle), "zippyq") ||
		strings.Contains(strings.ToLower(stg.Title), "zippyq") ||
		(e.raceState.MGPLink != nil && e.raceState.MGPLink.IsZippyQ) {
		shortPrefix = "ZQ"
	}

	newPack := domain.RaceHeat{
		ID:              packID,
		RoundID:         roundID,
		StageIndex:      stg.Index,
		StageName:       roundTitle,
		StageFormat:     domain.FormatOpenQualifier,
		Round:           roundNum,
		Column:          roundCol,
		Order:           len(e.raceState.Heats) + 1,
		BracketLane:     "open_qual",
		Title:           fmt.Sprintf("%s · %s", roundTitle, packTitle),
		ShortLabel:      fmt.Sprintf("%s-%d", shortPrefix, seq),
		StartMode:       domain.StartModeStaggered,
		TargetLaps:      tLaps,
		TimeLimitSec:    tLimit,
		ExpectedWinners: 0,
		State:           domain.HeatReady,
		Seats:           seats,
	}

	// Insert right after existing packs of `roundID` (and BEFORE any downstream non-OQ heats on the unified graph!)
	insertAt := -1
	for i := len(e.raceState.Heats) - 1; i >= 0; i-- {
		if e.raceState.Heats[i].RoundID == roundID || (e.raceState.Heats[i].StageIndex == stg.Index && e.raceState.Heats[i].StageFormat == domain.FormatOpenQualifier) {
			insertAt = i + 1
			break
		}
	}
	if insertAt < 0 {
		insertAt = len(e.raceState.Heats)
		for i := 0; i < len(e.raceState.Heats); i++ {
			if e.raceState.Heats[i].StageIndex > stg.Index || (e.raceState.Heats[i].StageIndex == stg.Index && e.raceState.Heats[i].Column > roundCol) {
				insertAt = i
				break
			}
		}
	}
	if insertAt == len(e.raceState.Heats) {
		e.raceState.Heats = append(e.raceState.Heats, newPack)
	} else {
		e.raceState.Heats = append(e.raceState.Heats, domain.RaceHeat{})
		copy(e.raceState.Heats[insertAt+1:], e.raceState.Heats[insertAt:])
		e.raceState.Heats[insertAt] = newPack
	}
	for i := range e.raceState.Heats {
		e.raceState.Heats[i].Order = i + 1
	}
	return &e.raceState.Heats[insertAt]
}

// openQualEnqueuePilotLocked queues a checked-in pilot into an Open Qualifier pack, enforcing:
// 1) Optional per-pilot `MaxPacksPerPilot` limit,
// 2) Anti-back-to-back pack spacing whenever another pilot is already queued ahead, and
// 3) Sticky non-colliding VTX channel assignment.
func (e *Engine) openQualEnqueuePilotLocked(slotIndex int, stageIdx int, forceImmediate bool) (string, error) {
	stg, err := e.findOpenQualStageLocked(stageIdx)
	if err != nil {
		return "", err
	}
	var oqRound *domain.RaceRound
	for i := range e.raceState.Rounds {
		r := &e.raceState.Rounds[i]
		if r.StageIndex == stg.Index && (domain.IsOpenQualRoundID(r.ID) || r.StageFormat == domain.FormatOpenQualifier) {
			oqRound = r
			break
		}
	}
	if stg.Status == domain.StageStatusCompleted || stg.CompletedEarly || (oqRound != nil && race.IsRoundSkippedByEarlySeed(&e.raceState, oqRound.ID)) {
		lbl := stg.Title
		if oqRound != nil && oqRound.Title != "" {
			lbl = oqRound.Title
		}
		return "", fmt.Errorf("%s is already locked for seeding - reopen seeding to queue more heats", lbl)
	}
	normalizeRaceRosterLocked(&e.raceState, e.pilots)
	for _, existing := range e.raceState.Roster {
		if existing.SlotIndex == slotIndex && existing.CheckedIn {
			att := domain.NormalizeAttendance(existing.Attendance)
			if att == domain.AttendanceDQ || att == domain.AttendanceDNC || att == domain.AttendanceAway {
				return "", fmt.Errorf("%s is marked %s - clear their status in Pilots Roster before queueing", existing.Callsign, strings.ToUpper(string(att)))
			}
			break
		}
	}
	ep, ok := e.ensurePilotActiveInRaceLocked(slotIndex)
	if !ok {
		return "", fmt.Errorf("pilot %d not found", slotIndex)
	}
	if liveHeat := findPilotInFlightHeat(e.raceState.Heats, slotIndex); liveHeat != nil {
		return "", fmt.Errorf("%s is currently flying in %s - wait until the heat finishes before queueing again", ep.Callsign, liveHeat.ShortLabel)
	}

	stgSettings := stg.Settings.Normalized(e.raceState.Config, stg.Format)
	maxPacks := stgSettings.MaxPacksPerPilot
	if oqRound != nil && oqRound.MaxPacksPerPilot > 0 {
		maxPacks = oqRound.MaxPacksPerPilot
	} else if maxPacks == 0 && e.raceState.Config.MaxPacksPerPilot > 0 {
		maxPacks = e.raceState.Config.MaxPacksPerPilot
	}
	flownOrLive, queued := countPilotPacksInStage(e.raceState.Heats, stg.Index, slotIndex)
	totalCount := flownOrLive + queued
	if maxPacks > 0 && totalCount >= maxPacks {
		return "", fmt.Errorf("%s has reached the %d-heat limit (%d flown, %d queued)", ep.Callsign, maxPacks, flownOrLive, queued)
	}

	// Collect Open Qualifier heats in running order: identify latest started/confirmed pack & unstarted queue
	var lastStartedPack *domain.RaceHeat
	var unstartedIdxs []int
	lastQueuedQueuePos := -1
	for i := range e.raceState.Heats {
		h := &e.raceState.Heats[i]
		if h.StageIndex != stg.Index || h.State == domain.HeatAborted || h.StageFormat != domain.FormatOpenQualifier {
			continue
		}
		if isUnstartedHeatState(h.State) {
			qPos := len(unstartedIdxs)
			unstartedIdxs = append(unstartedIdxs, i)
			if packContainsPilot(h, slotIndex) {
				lastQueuedQueuePos = qPos
			}
		} else {
			lastStartedPack = h
		}
	}

	// Determine earliest queue position (`minQPos`) so pilot does not fly back-to-back packs when others are waiting
	minQPos := 0
	if lastQueuedQueuePos >= 0 {
		if forceImmediate {
			minQPos = lastQueuedQueuePos + 1
		} else {
			minQPos = lastQueuedQueuePos + 2
		}
	} else if !forceImmediate && lastStartedPack != nil && packContainsPilot(lastStartedPack, slotIndex) {
		if len(unstartedIdxs) > 0 && packHasOtherActivePilots(&e.raceState.Heats[unstartedIdxs[0]], slotIndex) {
			minQPos = 1
		}
	}

	// Determine pilot's sticky VTX channel preference:
	// 1) Last channel used in this race, 2) Pilot's global profile channel if valid
	lastCh := race.LastChannelByPilot(e.raceState.Heats)
	prefCode := lastCh[slotIndex]
	hasFlownOnSticky := prefCode > 0
	if prefCode == 0 {
		for _, gp := range e.pilots {
			if gp.SlotIndex == slotIndex {
				prefCode = domain.EncodeBandChannel(gp.Band, gp.Channel)
				break
			}
		}
	}

	seatPilotInto := func(h *domain.RaceHeat, sIdx int) string {
		s := &h.Seats[sIdx]
		s.PilotSlotIndex = ep.SlotIndex
		s.Callsign = ep.Callsign
		s.PhoneticName = ep.PhoneticName
		s.Color = ep.Color
		s.Seed = ep.SlotIndex
		s.SourceLabel = fmt.Sprintf("Heat #%d", totalCount+1)
		s.Status = domain.PilotHeatStaged
		s.PreOverrideStatus = ""
		s.StatusOverridden = false
		s.RosterDQ = false
		s.ManualLock = false
		s.Feeder = nil
		s.Crossings = nil
		s.RssiTrace = nil
		s.Laps = []domain.HeatLap{}
		finalizeEditedHeatState(h, stgSettings.QualifyingMetric)
		return h.ID
	}

	var chosenHeatID string

	// Pass 1: Look for an unstarted pack at `qPos >= minQPos` that has the pilot's sticky channel open!
	if prefCode > 0 {
		for qPos := minQPos; qPos < len(unstartedIdxs); qPos++ {
			h := &e.raceState.Heats[unstartedIdxs[qPos]]
			if packContainsPilot(h, slotIndex) {
				continue
			}
			for si := range h.Seats {
				if h.Seats[si].PilotSlotIndex == 0 && domain.EncodeBandChannel(h.Seats[si].Band, h.Seats[si].Channel) == prefCode {
					chosenHeatID = seatPilotInto(h, si)
					break
				}
			}
			if chosenHeatID != "" {
				break
			}
		}
	}

	// Pass 2: If pilot hasn't locked onto a race channel yet (or ForceImmediate), take any open seat at `qPos >= minQPos`.
	// If pilot HAS already flown on `prefCode`, only take a different channel if `ForceImmediate` — otherwise spawn a fresh pack
	// so the pilot never has to retune VTX mid-qualifier!
	if chosenHeatID == "" && (!hasFlownOnSticky || forceImmediate) {
		for qPos := minQPos; qPos < len(unstartedIdxs); qPos++ {
			h := &e.raceState.Heats[unstartedIdxs[qPos]]
			if packContainsPilot(h, slotIndex) {
				continue
			}
			for si := range h.Seats {
				if h.Seats[si].PilotSlotIndex == 0 {
					chosenHeatID = seatPilotInto(h, si)
					break
				}
			}
			if chosenHeatID != "" {
				break
			}
		}
	}

	// Pass 3: Spawn new pack(s) if needed (note: if `minQPos > len(unstartedIdxs)` because pilot is already in the last pack,
	// cap to creating 1 new pack right after the current queue unless another pilot fills the gap).
	if chosenHeatID == "" {
		newPack := e.spawnOpenQualPackLocked(stg, stgSettings)
		targetSeat := 0
		if prefCode > 0 {
			matched := -1
			for si := range newPack.Seats {
				if domain.EncodeBandChannel(newPack.Seats[si].Band, newPack.Seats[si].Channel) == prefCode {
					matched = si
					break
				}
			}
			if matched >= 0 {
				targetSeat = matched
			} else if hasFlownOnSticky && len(newPack.Seats) > 0 {
				// Keep pilot on their exact sticky channel even if outside default SeatChannels
				if pBand, pCh, pFreq, ok := domain.DecodeBandChannel(prefCode); ok {
					newPack.Seats[0].Band = pBand
					newPack.Seats[0].Channel = pCh
					newPack.Seats[0].FrequencyMHz = pFreq
					targetSeat = 0
				}
			}
		}
		chosenHeatID = seatPilotInto(newPack, targetSeat)
	}

	if chosenHeat := e.findHeatLocked(chosenHeatID); chosenHeat != nil && chosenHeat.RoundID != "" {
		e.cascadeBalancedRoundsFromLocked(stg.Index, chosenHeat.RoundID)
	}
	e.resolveActiveTournamentLocked()
	e.autoStageOpenQualIfIdleLocked(stg.Index)
	return chosenHeatID, nil
}

func (e *Engine) autoStageOpenQualIfIdleLocked(stageIdx int) {
	if e.raceState.ActiveStageIndex != stageIdx {
		return
	}
	if cur := e.findHeatLocked(e.raceState.ActiveHeatID); cur != nil && cur.StageIndex == stageIdx {
		if cur.State == domain.HeatCountdown || cur.State == domain.HeatRunning ||
			cur.State == domain.HeatPaused || cur.State == domain.HeatFinished || cur.State == domain.HeatStaged {
			if cur.State == domain.HeatStaged && e.raceState.Mode == domain.ModeRace {
				e.stageHeatLocked(cur.ID, true)
			}
			return
		}
	}
	if e.raceState.NextReadyHeatID != "" {
		if nh := e.findHeatLocked(e.raceState.NextReadyHeatID); nh != nil && nh.StageIndex == stageIdx {
			e.stageHeatLocked(nh.ID, e.raceState.Mode == domain.ModeRace)
		}
	}
}

func (e *Engine) openQualDequeuePilotLocked(heatID string, slotIndex int, seatIndex int) error {
	targetIdx := -1
	sIdx := -1

	if strings.TrimSpace(heatID) != "" {
		for i := range e.raceState.Heats {
			if e.raceState.Heats[i].ID == strings.TrimSpace(heatID) {
				targetIdx = i
				break
			}
		}
		if targetIdx < 0 {
			return fmt.Errorf("heat %q not found", heatID)
		}
		h := &e.raceState.Heats[targetIdx]
		if !isUnstartedHeatState(h.State) {
			return fmt.Errorf("cannot remove pilot from %s because it has already started", h.ShortLabel)
		}
		if seatIndex > 0 {
			sIdx = findSeatIndex(h, seatIndex)
		} else if slotIndex > 0 {
			for i := range h.Seats {
				if h.Seats[i].PilotSlotIndex == slotIndex {
					sIdx = i
					break
				}
			}
		}
	} else if slotIndex > 0 {
		// Remove from the latest unstarted Open Qualifier pack containing this pilot
		for i := len(e.raceState.Heats) - 1; i >= 0; i-- {
			h := &e.raceState.Heats[i]
			if h.StageFormat == domain.FormatOpenQualifier && isUnstartedHeatState(h.State) {
				for si := range h.Seats {
					if h.Seats[si].PilotSlotIndex == slotIndex {
						targetIdx = i
						sIdx = si
						break
					}
				}
				if targetIdx >= 0 {
					break
				}
			}
		}
	}

	if targetIdx < 0 || sIdx < 0 {
		return fmt.Errorf("queued pilot seat not found")
	}

	h := &e.raceState.Heats[targetIdx]
	stgIdx := h.StageIndex
	clearSeatOccupant(&h.Seats[sIdx], false)
	h.Seats[sIdx].ManualLock = false

	remainingPilots := 0
	for _, s := range h.Seats {
		if s.PilotSlotIndex > 0 {
			remainingPilots++
		}
	}
	if remainingPilots == 0 {
		removedID := h.ID
		e.raceState.Heats = append(e.raceState.Heats[:targetIdx], e.raceState.Heats[targetIdx+1:]...)
		for i := range e.raceState.Heats {
			e.raceState.Heats[i].Order = i + 1
		}
		if e.raceState.ActiveHeatID == removedID {
			e.raceState.ActiveHeatID = ""
		}
	} else {
		stgSettings := e.stageSettingsLocked(stgIdx)
		finalizeEditedHeatState(h, stgSettings.QualifyingMetric)
	}

	e.resolveActiveTournamentLocked()
	e.autoStageOpenQualIfIdleLocked(stgIdx)
	return nil
}

// openQualDequeueAllUnstartedForPilotLocked removes `slotIndex` from every unstarted Open Qualifier
// pack in `st`, deleting any pack whose lineup becomes completely empty.
func openQualDequeueAllUnstartedForPilotLocked(st *domain.RaceTournamentState, slotIndex int) bool {
	if st == nil || slotIndex <= 0 {
		return false
	}
	changed := false
	for i := len(st.Heats) - 1; i >= 0; i-- {
		h := &st.Heats[i]
		if h.StageFormat != domain.FormatOpenQualifier || !isUnstartedHeatState(h.State) {
			continue
		}
		removedInHeat := false
		remaining := 0
		for si := range h.Seats {
			if h.Seats[si].PilotSlotIndex == slotIndex {
				clearSeatOccupant(&h.Seats[si], false)
				h.Seats[si].ManualLock = false
				removedInHeat = true
			} else if h.Seats[si].PilotSlotIndex > 0 {
				remaining++
			}
		}
		if !removedInHeat {
			continue
		}
		changed = true
		if remaining == 0 {
			removedID := h.ID
			st.Heats = append(st.Heats[:i], st.Heats[i+1:]...)
			if st.ActiveHeatID == removedID {
				st.ActiveHeatID = ""
			}
		} else {
			finalizeEditedHeatState(h, st.Config.QualifyingMetric)
		}
	}
	if changed {
		for i := range st.Heats {
			st.Heats[i].Order = i + 1
		}
	}
	return changed
}

func (e *Engine) openQualEnqueueAllReadyLocked(stageIdx int) (int, error) {
	stg, err := e.findOpenQualStageLocked(stageIdx)
	if err != nil {
		return 0, err
	}
	stgSettings := stg.Settings.Normalized(e.raceState.Config, stg.Format)
	pilots := e.activeEventPilotsForGenerationLocked()
	if len(pilots) == 0 {
		return 0, fmt.Errorf("no checked-in active pilots available to queue")
	}

	// Fair queue order: earliest last-flown heat first (never-flown = 0 first, recently finished rotated to bottom), then fewest packs flown, then roster order
	lastFlownOrder := make(map[int]int, len(pilots))
	for _, h := range e.raceState.Heats {
		if h.StageIndex != stg.Index || h.State == domain.HeatAborted || isUnstartedHeatState(h.State) {
			continue
		}
		for _, s := range h.Seats {
			if s.PilotSlotIndex > 0 && s.Status != domain.PilotHeatDNS && s.Status != domain.PilotHeatDQ {
				if h.Order > lastFlownOrder[s.PilotSlotIndex] {
					lastFlownOrder[s.PilotSlotIndex] = h.Order
				}
			}
		}
	}
	type cand struct {
		slot      int
		flown     int
		lastOrder int
	}
	var ready []cand
	for _, p := range pilots {
		if findPilotInFlightHeat(e.raceState.Heats, p.SlotIndex) != nil {
			continue // Currently flying in an active heat
		}
		flown, queued := countPilotPacksInStage(e.raceState.Heats, stg.Index, p.SlotIndex)
		if queued > 0 {
			continue // Already waiting in an unstarted pack
		}
		if stgSettings.MaxPacksPerPilot > 0 && flown >= stgSettings.MaxPacksPerPilot {
			continue
		}
		ready = append(ready, cand{slot: p.SlotIndex, flown: flown, lastOrder: lastFlownOrder[p.SlotIndex]})
	}

	sort.SliceStable(ready, func(i, j int) bool {
		if ready[i].lastOrder != ready[j].lastOrder {
			return ready[i].lastOrder < ready[j].lastOrder
		}
		return ready[i].flown < ready[j].flown
	})

	queuedCount := 0
	for _, c := range ready {
		if _, err := e.openQualEnqueuePilotLocked(c.slot, stg.Index, false); err == nil {
			queuedCount++
		}
	}
	return queuedCount, nil
}

// ExportRaceResultsCSV returns `(filename, csvBody, error)` for the requested race & stage (`0` = active stage).
func (e *Engine) ExportRaceResultsCSV(raceID string, stageIdx int) (string, string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.ensureEventStateInitializedLocked()
	e.syncActiveRaceToEventLocked()

	var target *domain.RaceTournamentState
	trimmedID := strings.TrimSpace(raceID)
	if trimmedID == "" || trimmedID == e.raceState.RaceID {
		if e.raceState.RaceID != "" {
			cp := cloneRaceState(e.raceState)
			target = &cp
		}
	} else {
		for i := range e.eventState.Races {
			if e.eventState.Races[i].RaceID == trimmedID {
				cp := cloneRaceState(e.eventState.Races[i])
				target = &cp
				break
			}
		}
	}
	if target == nil || target.RaceID == "" {
		return "", "", fmt.Errorf("race not found")
	}

	if stageIdx < 1 {
		stageIdx = target.ActiveStageIndex
	}
	if stageIdx < 1 {
		stageIdx = 1
	}

	csvBody := race.BuildRaceResultsCSV(target, e.pilots, stageIdx)
	slug := strings.ToLower(strings.TrimSpace(target.Config.EventName))
	if slug == "" {
		slug = target.RaceID
	}
	var clean strings.Builder
	for _, r := range slug {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			clean.WriteRune(r)
		} else if clean.Len() > 0 && !strings.HasSuffix(clean.String(), "-") {
			clean.WriteByte('-')
		}
	}
	baseName := strings.Trim(clean.String(), "-")
	if baseName == "" {
		baseName = "race"
	}
	filename := fmt.Sprintf("%s-stage%d-results.csv", baseName, stageIdx)
	return filename, csvBody, nil
}
