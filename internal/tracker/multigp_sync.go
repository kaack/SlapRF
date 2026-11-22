package tracker

import (
	"fmt"
	"strconv"
	"strings"

	"slaprf/internal/domain"
	"slaprf/internal/multigp"
	"slaprf/internal/race"
)

// MultiGPSlotSyncOperation describes one outbound `POST /race/assignSlot` call for a seat in a completed heat.
type MultiGPSlotSyncOperation struct {
	HeatID    string                 `json:"heatId"`
	HeatTitle string                 `json:"heatTitle"`
	Cycle     int                    `json:"cycle"`
	Heat      int                    `json:"heat"`
	Slot      int                    `json:"slot"`
	Callsign  string                 `json:"callsign"`
	Data      multigp.AssignSlotData `json:"data"`
}

// MultiGPSyncPlan summarizes all `assignSlot` operations and `captureOverallRaceResult` podium
// entries ready to push from a SlapRF race to MultiGP.
type MultiGPSyncPlan struct {
	RaceID         string                      `json:"raceId"`
	MGPRaceID      int                         `json:"mgpRaceId"`
	MGPRaceName    string                      `json:"mgpRaceName"`
	ImportMode     string                      `json:"importMode"`
	Operations     []MultiGPSlotSyncOperation  `json:"operations"`
	OverallResults []multigp.OverallResultEntry `json:"overallResults,omitempty"`
}

func mapMultiGPScoringMetric(scoringFormat int) domain.QualifyingMetric {
	switch scoringFormat {
	case multigp.ScoringFastestLap:
		return domain.QualMetricBestLap
	case multigp.ScoringFastest2Consecutive:
		return domain.QualMetricConsecutive2
	case multigp.ScoringFastest3Consecutive:
		return domain.QualMetricConsecutive3
	case multigp.ScoringAggregateLaps:
		return domain.QualMetricLapsInTime
	default:
		return domain.QualMetricConsecutive3
	}
}

func parseMultiGPBandChannel(bandStr, chStr string, freqMHz int, fallbackSlot int) (domain.Band, uint8, uint16) {
	if freqMHz >= 5000 && freqMHz <= 6000 {
		if b, ch, ok := domain.LookupBandChannelByFreqMHz(uint16(freqMHz)); ok {
			return b, ch, uint16(freqMHz)
		}
	}
	band := domain.BandRaceband
	switch strings.ToUpper(strings.TrimSpace(bandStr)) {
	case "F", "FATSHARK", "IRC":
		band = domain.BandFatshark
	case "E", "BOSCAME", "BOSCAM E", "BOSCAM_E":
		band = domain.BandBoscamE
	case "A", "BOSCAMA", "BOSCAM A", "BOSCAM_A":
		band = domain.BandBoscamA
	case "B", "BOSCAMB", "BOSCAM B", "BOSCAM_B":
		band = domain.BandBoscamB
	case "I", "IMD6", "IMD6C":
		band = domain.BandIMD6
	}
	chNum, _ := strconv.Atoi(strings.TrimLeft(strings.TrimSpace(chStr), "RFEABIrfeabi"))
	if chNum < 1 || chNum > domain.MaxPilotSlots {
		if fallbackSlot >= 1 && fallbackSlot <= domain.MaxPilotSlots {
			chNum = fallbackSlot
		} else {
			chNum = 1
		}
	}
	freq := domain.FrequencyForBandChannel(band, uint8(chNum))
	if freq == 0 && freqMHz >= 5000 && freqMHz <= 6000 {
		freq = uint16(freqMHz)
	}
	if freq == 0 {
		freq = domain.RacebandFrequenciesMHz[(chNum-1)%domain.MaxPilotSlots]
	}
	return band, uint8(chNum), freq
}

func (e *Engine) matchOrCreateMultiGPPilotLocked(entry multigp.RaceEntry) (domain.PilotSlot, error) {
	cleanUser := strings.TrimSpace(entry.UserName)
	if cleanUser == "" {
		cleanUser = strings.TrimSpace(entry.DisplayName)
	}
	if cleanUser == "" {
		cleanUser = fmt.Sprintf("MGP-%d", entry.PilotID)
	}

	// 1. Exact MultiGP PilotID match
	if entry.PilotID > 0 {
		for i := range e.pilots {
			if e.pilots[i].MultiGPPilotID == entry.PilotID {
				if e.pilots[i].MultiGPUserName == "" {
					e.pilots[i].MultiGPUserName = cleanUser
				}
				return e.pilots[i], nil
			}
		}
	}

	// 2. Case-insensitive callsign match
	for i := range e.pilots {
		if strings.EqualFold(strings.TrimSpace(e.pilots[i].Callsign), cleanUser) {
			if entry.PilotID > 0 {
				e.pilots[i].MultiGPPilotID = entry.PilotID
			}
			e.pilots[i].MultiGPUserName = cleanUser
			if entry.Phonetic != "" && e.pilots[i].PhoneticName == "" {
				e.pilots[i].PhoneticName = strings.TrimSpace(entry.Phonetic)
			}
			return e.pilots[i], nil
		}
	}

	// 3. Append new pilot to global directory
	maxSlot := 0
	for _, p := range e.pilots {
		if p.SlotIndex > maxSlot {
			maxSlot = p.SlotIndex
		}
	}
	newSlot := maxSlot + 1
	p := domain.PilotSlot{
		SlotIndex:       newSlot,
		Callsign:        cleanUser,
		PhoneticName:    strings.TrimSpace(entry.Phonetic),
		Enabled:         false,
		Band:            domain.BandRaceband,
		Channel:         0,
		FrequencyMHz:    0,
		EnterThreshold:  -58.0,
		ExitThreshold:   -68.0,
		LapRFThreshold:  domain.DefaultLapRFThreshold,
		AttenuationGain: domain.DefaultLapRFGain,
		Color:           domain.DefaultPilotColors[(newSlot-1)%len(domain.DefaultPilotColors)],
		MultiGPPilotID:  entry.PilotID,
		MultiGPUserName: cleanUser,
	}
	e.pilots = append(e.pilots, p)
	if e.practiceSnap.Saved {
		e.practiceSnap.Pilots = append(e.practiceSnap.Pilots, p)
	}
	return p, nil
}

func (e *Engine) uniqueImportedRaceNameLocked(base string) string {
	trimmed := strings.TrimSpace(base)
	if stripped, n := stripTrailingCopyNumbers(trimmed); n > 0 && stripped != "" {
		trimmed = stripped
	}
	if trimmed == "" {
		trimmed = "MultiGP Race"
	}
	if e.findDuplicateRaceBySlugLocked(trimmed, "") == nil {
		return trimmed
	}
	for n := 2; n < 100; n++ {
		cand := fmt.Sprintf("%s (%d)", trimmed, n)
		if e.findDuplicateRaceBySlugLocked(cand, "") == nil {
			return cand
		}
	}
	return fmt.Sprintf("%s %d", trimmed, len(e.eventState.Races)+1)
}

func buildSeatsFromMultiGPHeatLocked(
	ht multigp.ScheduleHeat,
	pilotByMGPID map[int]domain.PilotSlot,
	pilotByName map[string]domain.PilotSlot,
	defaultSeatChannels []uint8,
) []domain.HeatSeat {
	seats := make([]domain.HeatSeat, 0, maxInt(len(ht.Entries), len(defaultSeatChannels)))
	seenSeat := make(map[int]bool)

	for idx, ent := range ht.Entries {
		var p domain.PilotSlot
		var ok bool
		if ent.PilotID > 0 {
			p, ok = pilotByMGPID[ent.PilotID]
		}
		if !ok && ent.UserName != "" {
			p, ok = pilotByName[strings.ToLower(strings.TrimSpace(ent.UserName))]
		}
		slotNum := ent.Slot
		if slotNum < 1 || slotNum > domain.MaxPilotSlots {
			slotNum = idx + 1
		}
		band, ch, freq := parseMultiGPBandChannel(ent.Band, ent.Channel, ent.Frequency, slotNum)
		seatIdx := len(seats) + 1
		seenSeat[seatIdx] = true
		if ok {
			seats = append(seats, domain.HeatSeat{
				SeatIndex:      seatIdx,
				PilotSlotIndex: p.SlotIndex,
				Callsign:       p.Callsign,
				PhoneticName:   p.PhoneticName,
				Color:          p.Color,
				SourceLabel:    "MultiGP",
				ManualLock:     true,
				Band:           band,
				Channel:        ch,
				FrequencyMHz:   freq,
				Status:         domain.PilotHeatStaged,
			})
		} else {
			seats = append(seats, domain.HeatSeat{
				SeatIndex:    seatIdx,
				Band:         band,
				Channel:      ch,
				FrequencyMHz: freq,
				Status:       domain.PilotHeatStaged,
			})
		}
	}

	if len(seats) == 0 {
		for idx, code := range defaultSeatChannels {
			b, ch, freq, ok := domain.DecodeBandChannel(code)
			if !ok {
				b = domain.BandRaceband
				ch = uint8((idx % domain.MaxPilotSlots) + 1)
				freq = domain.RacebandFrequenciesMHz[ch-1]
			}
			seats = append(seats, domain.HeatSeat{
				SeatIndex:    idx + 1,
				Band:         b,
				Channel:      ch,
				FrequencyMHz: freq,
				Status:       domain.PilotHeatStaged,
			})
		}
	}
	return seats
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// ImportMultiGPPilots merges a list of MultiGP chapter pilots into the global SlapRF pilot
// directory without deleting any existing pilots. Existing pilots matched by MultiGPPilotID or
// case-insensitive Callsign are linked in place; new pilots are appended.
func (e *Engine) ImportMultiGPPilots(entries []multigp.RaceEntry) (domain.PilotCSVImportSummary, error) {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.ensurePracticeStateInitializedLocked()

	added := 0
	updated := 0
	seenID := make(map[int]bool)
	seenName := make(map[string]bool)

	for _, ent := range entries {
		cleanUser := strings.TrimSpace(ent.UserName)
		if cleanUser == "" {
			cleanUser = strings.TrimSpace(ent.DisplayName)
		}
		if ent.PilotID == 0 && cleanUser == "" {
			continue
		}
		if ent.PilotID > 0 && seenID[ent.PilotID] {
			continue
		}
		nameKey := strings.ToLower(cleanUser)
		if nameKey != "" && seenName[nameKey] {
			continue
		}
		if ent.PilotID > 0 {
			seenID[ent.PilotID] = true
		}
		if nameKey != "" {
			seenName[nameKey] = true
		}

		matchedExisting := false
		changedExisting := false
		if ent.PilotID > 0 {
			for i := range e.pilots {
				if e.pilots[i].MultiGPPilotID == ent.PilotID {
					matchedExisting = true
					if cleanUser != "" && e.pilots[i].MultiGPUserName != cleanUser {
						e.pilots[i].MultiGPUserName = cleanUser
						changedExisting = true
					}
					if ent.Phonetic != "" && e.pilots[i].PhoneticName == "" {
						e.pilots[i].PhoneticName = strings.TrimSpace(ent.Phonetic)
						changedExisting = true
					}
					break
				}
			}
		}
		if !matchedExisting && cleanUser != "" {
			for i := range e.pilots {
				if strings.EqualFold(strings.TrimSpace(e.pilots[i].Callsign), cleanUser) {
					matchedExisting = true
					if ent.PilotID > 0 && e.pilots[i].MultiGPPilotID != ent.PilotID {
						e.pilots[i].MultiGPPilotID = ent.PilotID
						changedExisting = true
					}
					if e.pilots[i].MultiGPUserName != cleanUser {
						e.pilots[i].MultiGPUserName = cleanUser
						changedExisting = true
					}
					if ent.Phonetic != "" && e.pilots[i].PhoneticName == "" {
						e.pilots[i].PhoneticName = strings.TrimSpace(ent.Phonetic)
						changedExisting = true
					}
					break
				}
			}
		}

		if matchedExisting {
			if changedExisting {
				updated++
			}
			continue
		}

		if _, err := e.matchOrCreateMultiGPPilotLocked(ent); err == nil {
			added++
		}
	}

	e.initDetectorsLocked()
	e.syncGlobalPilotsToOpenEventsLocked(nil, 0)
	e.syncGlobalPilotsToPracticeSessionsLocked(0)

	summary := domain.PilotCSVImportSummary{
		Added:   added,
		Updated: updated,
		Total:   len(e.pilots),
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
	return summary, nil
}

// ImportMultiGPRace creates a new SlapRF Race linked to `view`, matching or adding all registered
// MultiGP pilots and building either the imported MultiGP schedule ("schedule"), a ZippyQ open
// qualifier ("zippyq"), or a custom SlapRF tournament bracket ("bracket").
func (e *Engine) ImportMultiGPRace(view multigp.RaceViewData, importMode string, templateID string) (domain.RaceTournamentState, error) {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.ensurePracticeStateInitializedLocked()

	keepExistingActive := isRaceOngoing(&e.raceState) && e.eventState.ActiveRaceID != "" && e.raceState.RaceID != ""
	e.syncActiveRaceToEventLocked()

	pilotByMGPID := make(map[int]domain.PilotSlot)
	pilotByName := make(map[string]domain.PilotSlot)
	checkedInSlots := make(map[int]bool)

	for _, ent := range view.Entries {
		p, err := e.matchOrCreateMultiGPPilotLocked(ent)
		if err != nil {
			snap := cloneRaceState(e.raceState)
			e.mu.Unlock()
			return snap, err
		}
		if ent.PilotID > 0 {
			pilotByMGPID[ent.PilotID] = p
		}
		pilotByName[strings.ToLower(strings.TrimSpace(p.Callsign))] = p
		checkedInSlots[p.SlotIndex] = true
	}
	// Also ensure any pilots referenced only inside schedule heats are matched/created
	for _, rnd := range view.Schedule.Rounds {
		for _, ht := range rnd.Heats {
			for _, ent := range ht.Entries {
				if ent.PilotID == 0 && strings.TrimSpace(ent.UserName) == "" {
					continue
				}
				if _, ok := pilotByMGPID[ent.PilotID]; ok && ent.PilotID > 0 {
					continue
				}
				p, err := e.matchOrCreateMultiGPPilotLocked(multigp.RaceEntry{
					PilotID:  ent.PilotID,
					UserName: ent.UserName,
					Band:     ent.Band,
					Channel:  ent.Channel,
					Frequency: ent.Frequency,
				})
				if err == nil {
					if ent.PilotID > 0 {
						pilotByMGPID[ent.PilotID] = p
					}
					pilotByName[strings.ToLower(strings.TrimSpace(p.Callsign))] = p
					checkedInSlots[p.SlotIndex] = true
				}
			}
		}
	}

	e.initDetectorsLocked()
	e.syncGlobalPilotsToOpenEventsLocked(nil, 0)
	e.syncGlobalPilotsToPracticeSessionsLocked(0)

	hasZippyQRound := false
	allZippyQRounds := len(view.Schedule.Rounds) > 0
	for _, rnd := range view.Schedule.Rounds {
		isZq := rnd.IsZippyQ || strings.Contains(strings.ToLower(rnd.Name), "zippyq")
		if isZq {
			hasZippyQRound = true
		} else {
			allZippyQRounds = false
		}
	}

	mode := strings.ToLower(strings.TrimSpace(importMode))
	if mode == "" {
		if view.DisableSlotAutoPopulation == 1 || allZippyQRounds {
			mode = "zippyq"
		} else {
			mode = "schedule"
		}
	}

	raceName := e.uniqueImportedRaceNameLocked(view.Name)
	cfg := domain.DefaultRaceSetupConfig()
	cfg.EventName = raceName
	cfg.QualifyingMetric = mapMultiGPScoringMetric(view.ScoringFormat)
	if view.RaceTimeSec >= 15 {
		cfg.TimeLimitSec = view.RaceTimeSec
		cfg.QualifyingTimeLimitSec = view.RaceTimeSec
	}
	if view.MaxLaps >= 0 && view.MaxLaps <= 50 {
		if view.MaxLaps > 0 {
			cfg.TargetLaps = view.MaxLaps
		}
		cfg.QualifyingTargetLaps = view.MaxLaps
	}

	roster := make([]domain.EventPilot, len(e.pilots))
	for i, p := range e.pilots {
		isChecked := checkedInSlots[p.SlotIndex]
		if len(checkedInSlots) == 0 && i < 8 {
			isChecked = true
		}
		roster[i] = domain.EventPilot{
			SlotIndex:      p.SlotIndex,
			Callsign:       p.Callsign,
			PhoneticName:   p.PhoneticName,
			Color:          p.Color,
			CheckedIn:      isChecked,
			Attendance:     domain.AttendanceActive,
			MultiGPPilotID: p.MultiGPPilotID,
		}
	}

	now := nowISO()
	mgpLink := &domain.MultiGPRaceLink{
		RaceID:          view.ID,
		RaceName:        view.Name,
		ChapterID:       view.ChapterID,
		ChapterName:     view.ChapterName,
		ScoringFormat:   view.ScoringFormat,
		ScoringDisabled: view.ScoringDisabled != 0,
		IsZippyQ:        view.DisableSlotAutoPopulation == 1 || mode == "zippyq" || hasZippyQRound,
		ImportMode:      mode,
		SyncedHeatAt:    make(map[string]string),
		UnsyncedHeats:   make(map[string]bool),
	}

	newRace := domain.RaceTournamentState{
		RaceID:           e.nextUniqueIDLocked("race"),
		MGPLink:          mgpLink,
		Tags:             domain.NormalizeRaceTags([]string{"MultiGP"}),
		Lifecycle:        domain.LifecycleDraft,
		CreatedAt:        now,
		UpdatedAt:        now,
		Mode:             domain.ModeRace,
		Config:           cfg.Normalized(),
		TrackInitialized: true,
		TrackSnapshot:    e.defaultNewTrackGatesLocked(),
		Rules:            cloneTimingRulesPtr(nil, domain.DefaultTimingRules()),
		Roster:           roster,
		ActiveStageIndex: 1,
		TotalStages:      1,
	}

	// Build stages & heats according to import mode
	var prevActive domain.RaceTournamentState
	hadPrev := false
	if keepExistingActive {
		prevActive = cloneRaceState(e.raceState)
		hadPrev = true
	}

	e.eventState.Races = append(e.eventState.Races, cloneRaceState(newRace))
	e.eventState.ActiveRaceID = newRace.RaceID
	e.raceState = newRace
	switch mode {
	case "bracket":
		tpl := strings.TrimSpace(templateID)
		if tpl == "" {
			tpl = "double_elimination"
		}
		switch tpl {
		case "single_elimination":
			e.raceState.Config.Structure = domain.StructureSingleStage
			e.raceState.Config.MainFormat = domain.FormatSingleElimination
		case "chase_the_ace":
			e.raceState.Config.Structure = domain.StructureSingleStage
			e.raceState.Config.MainFormat = domain.FormatChaseTheAce
		case "qual_double_elim":
			e.raceState.Config.Structure = domain.StructureTwoStage
			e.raceState.Config.MainFormat = domain.FormatDoubleElimination
		case "qual_single_elim", "cpq_single_elim":
			tpl = "qual_single_elim"
			e.raceState.Config.Structure = domain.StructureTwoStage
			e.raceState.Config.MainFormat = domain.FormatSingleElimination
			e.raceState.Config.QualifyingMetric = domain.QualMetricConsecutive3
		case "qual_mains":
			e.raceState.Config.Structure = domain.StructureTwoStage
			e.raceState.Config.MainFormat = domain.FormatPointsMains
		case "cpq_mains":
			e.raceState.Config.Structure = domain.StructureTwoStage
			e.raceState.Config.MainFormat = domain.FormatPointsMains
			e.raceState.Config.QualifyingMetric = domain.QualMetricConsecutive3
		case "qual_chase_the_ace":
			e.raceState.Config.Structure = domain.StructureTwoStage
			e.raceState.Config.MainFormat = domain.FormatChaseTheAce
		case "cpq_qualifier":
			e.raceState.Config.Structure = domain.StructureSingleStage
			e.raceState.Config.MainFormat = domain.FormatQualifying
			e.raceState.Config.QualifyingMetric = domain.QualMetricConsecutive3
		default:
			tpl = "double_elimination"
			e.raceState.Config.Structure = domain.StructureSingleStage
			e.raceState.Config.MainFormat = domain.FormatDoubleElimination
		}
		e.raceState.TemplateID = tpl
		e.regenerateTournamentLocked()

	case "zippyq":
		e.raceState.Config.Structure = domain.StructureSingleStage
		e.raceState.Config.MainFormat = domain.FormatOpenQualifier
		e.raceState.TemplateID = "open_qualifier"
		e.regenerateTournamentLocked()
		if len(e.raceState.Stages) > 0 {
			e.raceState.Stages[0].Title = "ZippyQ Qualifier"
		}
		// Replace auto-seeded initial heat with the exact queued MultiGP ZippyQ rounds (if any)
		if len(view.Schedule.Rounds) > 0 {
			e.populateImportedScheduleHeatsLocked(view.Schedule.Rounds, pilotByMGPID, pilotByName, domain.FormatOpenQualifier, true)
			e.raceState.MGPLink.SyncedCycleCount = len(view.Schedule.Rounds)
		}

	default: // "schedule"
		rc := len(view.Schedule.Rounds)
		if rc < 1 {
			rc = 1
		}
		e.raceState.Config.Structure = domain.StructureSingleStage
		e.raceState.Config.MainFormat = domain.FormatQualifying
		e.raceState.Config.QualifyingRounds = minInt(rc, 8)
		e.raceState.TemplateID = "round_robin"
		e.regenerateTournamentLocked()
		if len(view.Schedule.Rounds) > 0 {
			e.populateImportedScheduleHeatsLocked(view.Schedule.Rounds, pilotByMGPID, pilotByName, domain.FormatQualifying, false)
			e.raceState.MGPLink.SyncedCycleCount = len(view.Schedule.Rounds)
		}
	}

	e.resolveActiveTournamentLocked()
	createdCopy := cloneRaceState(e.raceState)
	foundInList := false
	for i := range e.eventState.Races {
		if e.eventState.Races[i].RaceID == createdCopy.RaceID {
			e.eventState.Races[i] = cloneRaceState(createdCopy)
			foundInList = true
			break
		}
	}
	if !foundInList {
		e.eventState.Races = append(e.eventState.Races, cloneRaceState(createdCopy))
	}

	if hadPrev {
		e.raceState = prevActive
		e.eventState.ActiveRaceID = prevActive.RaceID
		e.editingRaceID = createdCopy.RaceID
		e.syncActiveRaceToEventLocked()
	} else {
		e.editingRaceID = ""
		e.eventState.ActiveRaceID = createdCopy.RaceID
		e.raceState.Mode = domain.ModeRace
		e.stageOrDisarmActiveRaceLocked()
		e.syncActiveRaceToEventLocked()
		createdCopy = cloneRaceState(e.raceState)
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
	return createdCopy, nil
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func (e *Engine) populateImportedScheduleHeatsLocked(
	rounds []multigp.ScheduleRound,
	pilotByMGPID map[int]domain.PilotSlot,
	pilotByName map[string]domain.PilotSlot,
	stageFmt domain.StageFormat,
	isZippyQ bool,
) {
	var heats []domain.RaceHeat
	var raceRounds []domain.RaceRound
	order := 1
	defSeats := e.raceState.Config.SeatChannels
	if len(defSeats) == 0 {
		defSeats = domain.DefaultSeatChannels(4)
	}

	for rIdx, rnd := range rounds {
		rNum := rnd.RoundNumber
		if rNum < 1 {
			rNum = rIdx + 1
		}
		rndIsZippy := isZippyQ || rnd.IsZippyQ || strings.Contains(strings.ToLower(rnd.Name), "zippyq")
		rndFmt := stageFmt
		if rndIsZippy {
			rndFmt = domain.FormatOpenQualifier
		} else if stageFmt == domain.FormatOpenQualifier {
			rndFmt = domain.FormatQualifying
		}
		roundID := fmt.Sprintf("mgp-r%d", rNum)
		rTitle := strings.TrimSpace(rnd.Name)
		if rTitle == "" {
			if rndIsZippy {
				rTitle = fmt.Sprintf("ZippyQ Round %d", rNum)
			} else {
				rTitle = fmt.Sprintf("Round %d", rNum)
			}
		}
		seedSrc := ""
		if rIdx == 0 {
			seedSrc = "all_active_pilots"
		}
		raceRounds = append(raceRounds, domain.RaceRound{
			ID:           roundID,
			StageIndex:   1,
			Round:        rNum,
			Column:       rNum,
			BracketLane:  "qualifying",
			Title:        rTitle,
			StageFormat:  rndFmt,
			StartMode:    domain.StartModeStaggered,
			TargetLaps:   e.raceState.Config.QualifyingTargetLaps,
			TimeLimitSec: e.raceState.Config.QualifyingTimeLimitSec,
			TargetHeats:  maxInt(1, len(rnd.Heats)),
			SeedSource:   seedSrc,
		})

		for hIdx, ht := range rnd.Heats {
			hNum := ht.HeatNumber
			if hNum < 1 {
				hNum = hIdx + 1
			}
			heatID := fmt.Sprintf("Q%d-%d", rNum, hNum)
			shortLbl := heatID
			hTitle := fmt.Sprintf("Round %d · Heat %d", rNum, hNum)
			if rndIsZippy {
				heatID = fmt.Sprintf("ZQ-%d", rNum)
				if hNum > 1 {
					heatID = fmt.Sprintf("ZQ-%d-%d", rNum, hNum)
				}
				shortLbl = heatID
				hTitle = fmt.Sprintf("ZippyQ Round %d", rNum)
			}
			seats := buildSeatsFromMultiGPHeatLocked(ht, pilotByMGPID, pilotByName, defSeats)
			st := domain.HeatReady
			if order == 1 {
				st = domain.HeatStaged
			}
			heats = append(heats, domain.RaceHeat{
				ID:           heatID,
				RoundID:      roundID,
				StageIndex:   1,
				StageName:    "Qualifying",
				StageFormat:  rndFmt,
				Round:        rNum,
				Column:       rNum,
				Order:        order,
				BracketLane:  "qualifying",
				Title:        hTitle,
				ShortLabel:   shortLbl,
				StartMode:    domain.StartModeStaggered,
				TargetLaps:   e.raceState.Config.QualifyingTargetLaps,
				TimeLimitSec: e.raceState.Config.QualifyingTimeLimitSec,
				State:        st,
				Seats:        seats,
			})
			order++
		}
	}

	if len(raceRounds) > 0 {
		e.raceState.Heats = heats
		e.raceState.Rounds = raceRounds
		e.raceState.Connections = nil
		e.raceState.Edges = nil
		if len(heats) > 0 {
			e.raceState.ActiveHeatID = heats[0].ID
			e.raceState.NextReadyHeatID = heats[0].ID
		} else {
			e.raceState.ActiveHeatID = ""
			e.raceState.NextReadyHeatID = ""
		}
		race.SyncRoundsMetadata(&e.raceState)
	}
}

// AppendMultiGPZippyQRounds appends newly pulled MultiGP `getAdditionalRounds` heats onto a linked SlapRF race.
func (e *Engine) AppendMultiGPZippyQRounds(raceID string, rounds []multigp.ScheduleRound) (domain.RaceTournamentState, int, error) {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()

	var swap targetRaceSwap
	if raceID != "" || e.editingRaceID != "" {
		var swapErr error
		swap, swapErr = e.enterTargetRaceLocked(raceID)
		if swapErr != nil {
			snap := cloneRaceState(e.raceState)
			e.mu.Unlock()
			return snap, 0, swapErr
		}
	}

	if e.raceState.MGPLink == nil {
		snap := e.exitTargetRaceLocked(&swap, false)
		e.mu.Unlock()
		return snap, 0, fmt.Errorf("race is not linked to MultiGP")
	}

	pilotByMGPID := make(map[int]domain.PilotSlot)
	pilotByName := make(map[string]domain.PilotSlot)
	for _, p := range e.pilots {
		if p.MultiGPPilotID > 0 {
			pilotByMGPID[p.MultiGPPilotID] = p
		}
		pilotByName[strings.ToLower(strings.TrimSpace(p.Callsign))] = p
	}

	existingRounds := make(map[int]bool)
	maxOrder := 0
	for _, h := range e.raceState.Heats {
		existingRounds[h.Round] = true
		if h.Order > maxOrder {
			maxOrder = h.Order
		}
	}

	defSeats := e.raceState.Config.SeatChannels
	if len(defSeats) == 0 {
		defSeats = domain.DefaultSeatChannels(4)
	}

	ensureRosterPilotCheckedIn := func(p domain.PilotSlot) {
		for ri := range e.raceState.Roster {
			if e.raceState.Roster[ri].SlotIndex == p.SlotIndex {
				e.raceState.Roster[ri].CheckedIn = true
				if e.raceState.Roster[ri].Attendance == "" {
					e.raceState.Roster[ri].Attendance = domain.AttendanceActive
				}
				if p.MultiGPPilotID > 0 && e.raceState.Roster[ri].MultiGPPilotID == 0 {
					e.raceState.Roster[ri].MultiGPPilotID = p.MultiGPPilotID
				}
				return
			}
		}
		e.raceState.Roster = append(e.raceState.Roster, domain.EventPilot{
			SlotIndex:      p.SlotIndex,
			Callsign:       p.Callsign,
			PhoneticName:   p.PhoneticName,
			Color:          p.Color,
			CheckedIn:      true,
			Attendance:     domain.AttendanceActive,
			MultiGPPilotID: p.MultiGPPilotID,
		})
	}

	added := 0
	for _, rnd := range rounds {
		for _, ht := range rnd.Heats {
			for _, ent := range ht.Entries {
				if ent.PilotID > 0 {
					p, ok := pilotByMGPID[ent.PilotID]
					if !ok {
						if created, err := e.matchOrCreateMultiGPPilotLocked(multigp.RaceEntry{
							PilotID:   ent.PilotID,
							UserName:  ent.UserName,
							Band:      ent.Band,
							Channel:   ent.Channel,
							Frequency: ent.Frequency,
						}); err == nil {
							p = created
							ok = true
							pilotByMGPID[ent.PilotID] = p
							pilotByName[strings.ToLower(strings.TrimSpace(p.Callsign))] = p
						}
					}
					if ok {
						ensureRosterPilotCheckedIn(p)
					}
				}
			}
		}

		rNum := rnd.RoundNumber
		if rNum <= 0 {
			continue
		}
		if existingRounds[rNum] {
			// Refresh seats on any unstarted ZippyQ heat in this round if new pilots lined up into open slots
			for hIdx, ht := range rnd.Heats {
				heatID := fmt.Sprintf("ZQ-%d", rNum)
				if hIdx > 0 {
					heatID = fmt.Sprintf("ZQ-%d-%d", rNum, hIdx+1)
				}
				for hi := range e.raceState.Heats {
					curH := &e.raceState.Heats[hi]
					if curH.ID != heatID {
						continue
					}
					if curH.State != domain.HeatReady && curH.State != domain.HeatStaged {
						break
					}
					freshSeats := buildSeatsFromMultiGPHeatLocked(ht, pilotByMGPID, pilotByName, defSeats)
					changedSeats := len(freshSeats) != len(curH.Seats)
					if !changedSeats {
						for si := range freshSeats {
							if freshSeats[si].PilotSlotIndex != curH.Seats[si].PilotSlotIndex ||
								freshSeats[si].Channel != curH.Seats[si].Channel {
								changedSeats = true
								break
							}
						}
					}
					if changedSeats {
						curH.Seats = freshSeats
						added++
					}
					break
				}
			}
			continue
		}
		existingRounds[rNum] = true
		roundID := fmt.Sprintf("mgp-r%d", rNum)
		e.raceState.Rounds = append(e.raceState.Rounds, domain.RaceRound{
			ID:           roundID,
			StageIndex:   1,
			Round:        rNum,
			Column:       rNum,
			BracketLane:  "qualifying",
			Title:        fmt.Sprintf("ZippyQ Round %d", rNum),
			StageFormat:  domain.FormatOpenQualifier,
			StartMode:    domain.StartModeStaggered,
			TargetLaps:   e.raceState.Config.QualifyingTargetLaps,
			TimeLimitSec: e.raceState.Config.QualifyingTimeLimitSec,
			TargetHeats:  maxInt(1, len(rnd.Heats)),
		})
		for hIdx, ht := range rnd.Heats {
			maxOrder++
			heatID := fmt.Sprintf("ZQ-%d", rNum)
			if hIdx > 0 {
				heatID = fmt.Sprintf("ZQ-%d-%d", rNum, hIdx+1)
			}
			seats := buildSeatsFromMultiGPHeatLocked(ht, pilotByMGPID, pilotByName, defSeats)
			e.raceState.Heats = append(e.raceState.Heats, domain.RaceHeat{
				ID:           heatID,
				RoundID:      roundID,
				StageIndex:   1,
				StageName:    "Open Qualifier",
				StageFormat:  domain.FormatOpenQualifier,
				Round:        rNum,
				Column:       rNum,
				Order:        maxOrder,
				BracketLane:  "qualifying",
				Title:        fmt.Sprintf("ZippyQ Round %d", rNum),
				ShortLabel:   heatID,
				StartMode:    domain.StartModeStaggered,
				TargetLaps:   e.raceState.Config.QualifyingTargetLaps,
				TimeLimitSec: e.raceState.Config.QualifyingTimeLimitSec,
				State:        domain.HeatReady,
				Seats:        seats,
			})
			added++
		}
		if rNum > e.raceState.MGPLink.SyncedCycleCount {
			e.raceState.MGPLink.SyncedCycleCount = rNum
		}
	}

	e.initDetectorsLocked()
	e.resolveActiveTournamentLocked()
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

	if added > 0 {
		for _, s := range subs {
			s.OnConfigUpdated(pilotsCopy, gatesCopy)
		}
		e.notifyRaceUpdated(activeSnap, nil, subs)
	}
	return targetSnap, added, nil
}

// BuildMultiGPSyncPlan computes all `assignSlot` operations and `captureOverallRaceResult` entries
// for a MultiGP-linked SlapRF race.
func (e *Engine) BuildMultiGPSyncPlan(raceID string, forceAll bool) (MultiGPSyncPlan, error) {
	e.mu.RLock()
	defer e.mu.RUnlock()

	var target *domain.RaceTournamentState
	if raceID == "" || e.raceState.RaceID == raceID {
		cp := cloneRaceState(e.raceState)
		target = &cp
	} else {
		for i := range e.eventState.Races {
			if e.eventState.Races[i].RaceID == raceID {
				cp := cloneRaceState(e.eventState.Races[i])
				target = &cp
				break
			}
		}
	}
	if target == nil {
		return MultiGPSyncPlan{}, fmt.Errorf("race not found")
	}

	mgpIDBySlot := make(map[int]int, len(e.pilots)+len(target.Roster)+8)
	for _, p := range e.pilots {
		if p.MultiGPPilotID > 0 {
			mgpIDBySlot[p.SlotIndex] = p.MultiGPPilotID
		}
	}
	for _, rp := range target.Roster {
		if rp.MultiGPPilotID > 0 {
			mgpIDBySlot[rp.SlotIndex] = rp.MultiGPPilotID
		} else if rp.SlotIndex > 0 && mgpIDBySlot[rp.SlotIndex] <= 0 {
			mgpIDBySlot[rp.SlotIndex] = 1000 + rp.SlotIndex
		}
	}
	for slotIdx := 1; slotIdx <= domain.MaxPilotSlots; slotIdx++ {
		if mgpIDBySlot[slotIdx] <= 0 {
			mgpIDBySlot[slotIdx] = 1000 + slotIdx
		}
	}

	var mgpRaceID int
	mgpRaceName := target.Config.EventName
	importMode := "local"
	isZippyQ := false
	var scoringDisabled bool
	var syncedHeatAt map[string]string
	var unsyncedHeats map[string]bool
	if target.MGPLink != nil {
		mgpRaceID = target.MGPLink.RaceID
		if target.MGPLink.RaceName != "" {
			mgpRaceName = target.MGPLink.RaceName
		}
		if target.MGPLink.ImportMode != "" {
			importMode = target.MGPLink.ImportMode
		}
		isZippyQ = target.MGPLink.IsZippyQ
		scoringDisabled = target.MGPLink.ScoringDisabled
		syncedHeatAt = target.MGPLink.SyncedHeatAt
		unsyncedHeats = target.MGPLink.UnsyncedHeats
	}

	plan := MultiGPSyncPlan{
		RaceID:      target.RaceID,
		MGPRaceID:   mgpRaceID,
		MGPRaceName: mgpRaceName,
		ImportMode:  importMode,
		Operations:  []MultiGPSlotSyncOperation{},
	}

	// Count heat index within each round for Controlled ("schedule") mode
	heatIndexInRound := make(map[int]int)
	seqCycle := 0

	for _, h := range target.Heats {
		heatIndexInRound[h.Round]++
		hInRound := heatIndexInRound[h.Round]

		completed := h.State == domain.HeatFinished || h.State == domain.HeatConfirmed
		if !completed {
			continue
		}
		seqCycle++

		alreadySynced := syncedHeatAt != nil && syncedHeatAt[h.ID] != ""
		dirty := unsyncedHeats != nil && unsyncedHeats[h.ID]
		if !forceAll && alreadySynced && !dirty {
			continue
		}

		cycle := h.Round
		heatNum := hInRound
		if isZippyQ || importMode == "zippyq" {
			cycle = h.Round
			if cycle < 1 {
				cycle = seqCycle
			}
			heatNum = 1
		} else if importMode == "bracket" {
			cycle = seqCycle
			heatNum = 1
		}
		if cycle < 1 {
			cycle = 1
		}
		if heatNum < 1 {
			heatNum = 1
		}

		for _, seat := range h.Seats {
			if seat.PilotSlotIndex <= 0 {
				continue
			}
			mgpPilotID := mgpIDBySlot[seat.PilotSlotIndex]
			if mgpPilotID <= 0 {
				mgpPilotID = 1000 + seat.PilotSlotIndex
			}
			slotNum := int(seat.Channel)
			if slotNum < 1 || slotNum > domain.MaxPilotSlots {
				slotNum = seat.SeatIndex
			}
			if slotNum < 1 || slotNum > domain.MaxPilotSlots {
				slotNum = 1
			}
			metrics := multigp.ComputeSeatMetrics(seat, scoringDisabled)
			metrics.PilotID = mgpPilotID
			metrics.PilotCallsign = seat.Callsign

			plan.Operations = append(plan.Operations, MultiGPSlotSyncOperation{
				HeatID:    h.ID,
				HeatTitle: h.Title,
				Cycle:     cycle,
				Heat:      heatNum,
				Slot:      slotNum,
				Callsign:  seat.Callsign,
				Data:      metrics,
			})
		}
	}

	// Build overall standings podium for captureOverallRaceResult
	standings := target.Standings
	if len(standings) == 0 && len(target.QualStandings) > 0 {
		standings = target.QualStandings
	}
	orderNum := 1
	for _, st := range standings {
		mgpPilotID := mgpIDBySlot[st.PilotSlotIndex]
		if mgpPilotID <= 0 && st.PilotSlotIndex > 0 {
			mgpPilotID = 1000 + st.PilotSlotIndex
		}
		if mgpPilotID <= 0 {
			continue
		}
		plan.OverallResults = append(plan.OverallResults, multigp.OverallResultEntry{
			OrderNumber: orderNum,
			PilotID:     mgpPilotID,
			UserName:    st.Callsign,
		})
		orderNum++
	}

	return plan, nil
}

// MultiGPMarkSyncedParams carries optional link initialization metadata when uploading a local race to MultiGP.
type MultiGPMarkSyncedParams struct {
	RaceID        string   `json:"raceId"`
	MGPRaceID     int      `json:"mgpRaceId,omitempty"`
	MGPRaceName   string   `json:"mgpRaceName,omitempty"`
	ChapterID     int      `json:"chapterId,omitempty"`
	ChapterName   string   `json:"chapterName,omitempty"`
	SyncedHeatIDs []string `json:"syncedHeatIds"`
	OverallSynced bool     `json:"overallSynced"`
}

// MarkMultiGPSynced records that `syncedHeatIDs` (and optionally `overallSynced`) were pushed to MultiGP.
func (e *Engine) MarkMultiGPSynced(raceID string, syncedHeatIDs []string, overallSynced bool, linkMeta ...MultiGPMarkSyncedParams) (domain.RaceTournamentState, error) {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()

	var swap targetRaceSwap
	if raceID != "" || e.editingRaceID != "" {
		var swapErr error
		swap, swapErr = e.enterTargetRaceLocked(raceID)
		if swapErr != nil {
			snap := cloneRaceState(e.raceState)
			e.mu.Unlock()
			return snap, swapErr
		}
	}

	if e.raceState.MGPLink == nil {
		var meta MultiGPMarkSyncedParams
		if len(linkMeta) > 0 {
			meta = linkMeta[0]
		}
		if meta.MGPRaceID <= 0 {
			snap := e.exitTargetRaceLocked(&swap, false)
			e.mu.Unlock()
			return snap, fmt.Errorf("race is not linked to MultiGP")
		}
		rName := meta.MGPRaceName
		if rName == "" {
			rName = e.raceState.Config.EventName
		}
		e.raceState.MGPLink = &domain.MultiGPRaceLink{
			RaceID:        meta.MGPRaceID,
			RaceName:      rName,
			ChapterID:     meta.ChapterID,
			ChapterName:   meta.ChapterName,
			ImportMode:    "local",
			SyncedHeatAt:  make(map[string]string),
			UnsyncedHeats: make(map[string]bool),
		}
	} else if len(linkMeta) > 0 {
		meta := linkMeta[0]
		if meta.MGPRaceID > 0 && e.raceState.MGPLink.RaceID <= 0 {
			e.raceState.MGPLink.RaceID = meta.MGPRaceID
		}
		if meta.MGPRaceName != "" && e.raceState.MGPLink.RaceName == "" {
			e.raceState.MGPLink.RaceName = meta.MGPRaceName
		}
		if meta.ChapterID > 0 && e.raceState.MGPLink.ChapterID <= 0 {
			e.raceState.MGPLink.ChapterID = meta.ChapterID
		}
		if meta.ChapterName != "" && e.raceState.MGPLink.ChapterName == "" {
			e.raceState.MGPLink.ChapterName = meta.ChapterName
		}
	}

	now := nowISO()
	if e.raceState.MGPLink.SyncedHeatAt == nil {
		e.raceState.MGPLink.SyncedHeatAt = make(map[string]string)
	}
	for _, hid := range syncedHeatIDs {
		if hid == "" {
			continue
		}
		e.raceState.MGPLink.SyncedHeatAt[hid] = now
		if e.raceState.MGPLink.UnsyncedHeats != nil {
			delete(e.raceState.MGPLink.UnsyncedHeats, hid)
		}
	}
	if overallSynced {
		e.raceState.MGPLink.OverallSyncedAt = now
	}
	e.raceState.MGPLink.LastSyncedAt = now

	var targetSnap domain.RaceTournamentState
	if swap.swapped {
		targetSnap = e.exitTargetRaceLocked(&swap, true)
	} else {
		e.syncActiveRaceToEventLocked()
		targetSnap = cloneRaceState(e.raceState)
	}
	activeSnap := cloneRaceState(e.raceState)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	e.notifyRaceUpdated(activeSnap, nil, subs)
	return targetSnap, nil
}
