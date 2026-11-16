package multigp

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"slaprf/internal/domain"
)

const DefaultSimAPIKey = "MGP-SIM-BAYAREA-2026"

var defaultSeatChannels = [4]int{1, 3, 5, 8}

// SimPersistedState stores the simulated MultiGP chapter, API key, pilot pool, and races.
type SimPersistedState struct {
	ChapterID   int            `json:"chapterId"`
	ChapterName string         `json:"chapterName"`
	APIKey      string         `json:"apiKey"`
	NextRaceID  int            `json:"nextRaceId"`
	PilotPool   []RaceEntry    `json:"pilotPool"`
	Races       []RaceViewData `json:"races"`
}

// SimAdminAction mutates the simulated MultiGP chapter or races from `#/sim`.
type SimAdminAction struct {
	Action        string `json:"action"`
	ChapterName   string `json:"chapterName,omitempty"`
	RaceID        int    `json:"raceId,omitempty"`
	Name          string `json:"name,omitempty"`
	IsZippyQ      bool   `json:"isZippyQ,omitempty"`
	Enabled       bool   `json:"enabled,omitempty"`
	ScoringFormat int    `json:"scoringFormat,omitempty"`
	RoundCount    int    `json:"roundCount,omitempty"`
	PilotID       int    `json:"pilotId,omitempty"`
	RoundNumber   int    `json:"roundNumber,omitempty"`
	HeatNumber    int    `json:"heatNumber,omitempty"`
	SeatIndex     int    `json:"seatIndex,omitempty"`
	Slot          int    `json:"slot,omitempty"`
	FromRound     int    `json:"fromRound,omitempty"`
	FromHeat      int    `json:"fromHeat,omitempty"`
	FromSeatIndex int    `json:"fromSeatIndex,omitempty"`
}

// SimBackend implements a faithful in-memory MultiGP WebService (`v1.0.4`) server for Simulation Mode.
type SimBackend struct {
	mu           sync.RWMutex
	state        SimPersistedState
	lastStepTime time.Time
	stepCounter  uint64
}

// NewSimBackend creates a pre-seeded simulated MultiGP backend.
func NewSimBackend() *SimBackend {
	b := &SimBackend{}
	b.ResetDefaults()
	return b
}

// ResetDefaults populates the default Bay Area FPV chapter, API key, 12 pilots, and 3 sample races.
func (b *SimBackend) ResetDefaults() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.state = defaultSimState()
	b.lastStepTime = time.Time{}
	b.stepCounter = 0
}

// ExportState returns a deep copy of the simulated MultiGP state for persistence.
func (b *SimBackend) ExportState() SimPersistedState {
	b.mu.RLock()
	defer b.mu.RUnlock()
	raw, _ := json.Marshal(b.state)
	var cp SimPersistedState
	_ = json.Unmarshal(raw, &cp)
	return cp
}

// RestoreState restores persisted simulated MultiGP state (falling back to defaults if empty).
func (b *SimBackend) RestoreState(st *SimPersistedState) {
	if st == nil || st.APIKey == "" || len(st.PilotPool) == 0 {
		b.ResetDefaults()
		return
	}
	raw, err := json.Marshal(st)
	if err != nil {
		b.ResetDefaults()
		return
	}
	var cp SimPersistedState
	if err := json.Unmarshal(raw, &cp); err != nil {
		b.ResetDefaults()
		return
	}
	b.mu.Lock()
	b.state = cp
	b.mu.Unlock()
}

func makeSeatEntry(slotCh int, pilot *RaceEntry) HeatEntry {
	band, ch, freq, ok := domain.DecodeBandChannel(uint8(slotCh))
	if !ok {
		band = domain.BandRaceband
		ch = 1
		freq = domain.RacebandFrequenciesMHz[0]
		slotCh = 1
	} else {
		slotCh = int(domain.EncodeBandChannel(band, ch))
	}
	ent := HeatEntry{
		Slot:      slotCh,
		Band:      domain.BandPrefix(band),
		Channel:   strconv.Itoa(int(ch)),
		Frequency: int(freq),
	}
	if pilot != nil && pilot.PilotID > 0 {
		ent.PilotID = pilot.PilotID
		ent.UserName = pilot.UserName
	}
	return ent
}

func buildEmptyFourSeatEntries() []HeatEntry {
	out := make([]HeatEntry, 0, 4)
	for _, ch := range defaultSeatChannels {
		out = append(out, makeSeatEntry(ch, nil))
	}
	return out
}

func defaultSimState() SimPersistedState {
	callsigns := []string{
		"FAERRY", "MeWo", "Din", "BigRamon",
		"Red5", "SwampDog", "Morbid", "Kyosanym",
		"OneEye", "FreeLove", "Vortex", "Nova",
	}
	pool := make([]RaceEntry, len(callsigns))
	for i, cs := range callsigns {
		ch := defaultSeatChannels[i%4]
		freq := int(domain.RacebandFrequenciesMHz[ch-1])
		pool[i] = RaceEntry{
			PilotID:     1001 + i,
			UserName:    cs,
			DisplayName: cs,
			Band:        "R",
			Channel:     strconv.Itoa(ch),
			Frequency:   freq,
		}
	}

	today := time.Now().Format("2006-01-02")

	// 1. Friday Night Spec Race: 8 pilots, 3 controlled qualifying rounds (2 heats of 4 per round)
	race1Entries := append([]RaceEntry(nil), pool[:8]...)
	race1Rounds := buildControlledRounds(race1Entries, 3)

	// 2. Saturday Open ZippyQ: 6 pilots initially checked in (walk-ups check in & line up dynamically)
	race2Entries := append([]RaceEntry(nil), pool[:6]...)
	race2Rounds := []ScheduleRound{
		buildZippyQRound(1, race2Entries[:4]),
		buildZippyQRound(2, race2Entries[4:6]),
	}

	// 3. Bay Area Championship: 10 pilots signed up, ready for Multi-Stage / Double-Elimination bracket import
	race3Entries := append([]RaceEntry(nil), pool[:10]...)
	race3Rounds := buildControlledRounds(race3Entries, 2)

	return SimPersistedState{
		ChapterID:   1042,
		ChapterName: "Bay Area FPV",
		APIKey:      DefaultSimAPIKey,
		NextRaceID:  504,
		PilotPool:   pool,
		Races: []RaceViewData{
			{
				ID:                        501,
				Name:                      "Friday Night Spec Race",
				StartDate:                 today + " 18:30:00",
				ChapterID:                 1042,
				ChapterName:               "Bay Area FPV",
				RaceType:                  1,
				ScoringFormat:             ScoringFastest3Consecutive,
				ScoringDisabled:           0,
				DisableSlotAutoPopulation: 0,
				CycleCount:                len(race1Rounds),
				MaxLaps:                   3,
				RaceTimeSec:               120,
				Entries:                   race1Entries,
				Schedule:                  RaceSchedule{Rounds: race1Rounds},
			},
			{
				ID:                        502,
				Name:                      "Saturday Open ZippyQ",
				StartDate:                 today + " 11:00:00",
				ChapterID:                 1042,
				ChapterName:               "Bay Area FPV",
				RaceType:                  1,
				ScoringFormat:             ScoringFastestLap,
				ScoringDisabled:           0,
				DisableSlotAutoPopulation: 1,
				AutoQueueZippyQ:           true,
				CycleCount:                len(race2Rounds),
				MaxLaps:                   0,
				RaceTimeSec:               120,
				Entries:                   race2Entries,
				Schedule:                  RaceSchedule{Rounds: race2Rounds},
			},
			{
				ID:                        503,
				Name:                      "Bay Area Championship",
				StartDate:                 today + " 14:00:00",
				ChapterID:                 1042,
				ChapterName:               "Bay Area FPV",
				RaceType:                  2,
				ScoringFormat:             ScoringAggregateLaps,
				ScoringDisabled:           0,
				DisableSlotAutoPopulation: 0,
				CycleCount:                len(race3Rounds),
				MaxLaps:                   3,
				RaceTimeSec:               120,
				Entries:                   race3Entries,
				Schedule:                  RaceSchedule{Rounds: race3Rounds},
			},
		},
	}
}

func buildControlledRounds(entries []RaceEntry, numRounds int) []ScheduleRound {
	if numRounds < 1 {
		numRounds = 1
	}
	rounds := make([]ScheduleRound, 0, numRounds)
	for r := 1; r <= numRounds; r++ {
		var heats []ScheduleHeat
		if len(entries) == 0 {
			heats = append(heats, ScheduleHeat{
				HeatNumber: 1,
				Name:       "Heat 1",
				Entries:    buildEmptyFourSeatEntries(),
			})
		} else {
			heatNum := 1
			shifted := make([]RaceEntry, len(entries))
			for i := range entries {
				shifted[i] = entries[(i+(r-1)*2)%len(entries)]
			}
			for start := 0; start < len(shifted); start += 4 {
				end := start + 4
				if end > len(shifted) {
					end = len(shifted)
				}
				chunk := shifted[start:end]
				hEntries := buildEmptyFourSeatEntries()
				for idx := range chunk {
					if idx < len(hEntries) {
						p := chunk[idx]
						hEntries[idx] = makeSeatEntry(defaultSeatChannels[idx], &p)
					}
				}
				heats = append(heats, ScheduleHeat{
					HeatNumber: heatNum,
					Name:       fmt.Sprintf("Heat %d", heatNum),
					Entries:    hEntries,
				})
				heatNum++
			}
		}
		rounds = append(rounds, ScheduleRound{
			RoundNumber: r,
			Name:        fmt.Sprintf("Round %d", r),
			Heats:       heats,
		})
	}
	return rounds
}

func buildZippyQRound(roundNum int, pilots []RaceEntry) ScheduleRound {
	hEntries := buildEmptyFourSeatEntries()
	for idx := range pilots {
		if idx >= len(hEntries) {
			break
		}
		p := pilots[idx]
		hEntries[idx] = makeSeatEntry(defaultSeatChannels[idx], &p)
	}
	return ScheduleRound{
		RoundNumber: roundNum,
		Name:        fmt.Sprintf("ZippyQ Round %d", roundNum),
		IsZippyQ:    true,
		Heats: []ScheduleHeat{
			{
				HeatNumber: 1,
				Name:       "Heat 1",
				Entries:    hEntries,
			},
		},
	}
}

func heatHasSyncedResults(ht *ScheduleHeat) bool {
	if ht == nil {
		return false
	}
	for _, e := range ht.Entries {
		if e.SyncedAt != "" {
			return true
		}
	}
	return false
}

func renumberRoundsAndHeats(r *RaceViewData) {
	allZippy := len(r.Schedule.Rounds) > 0
	anyZippy := false
	for ri := range r.Schedule.Rounds {
		rNum := ri + 1
		rnd := &r.Schedule.Rounds[ri]
		rnd.RoundNumber = rNum
		if rnd.IsZippyQ || strings.Contains(strings.ToLower(rnd.Name), "zippyq") {
			rnd.IsZippyQ = true
			rnd.Name = fmt.Sprintf("ZippyQ Round %d", rNum)
			anyZippy = true
		} else {
			rnd.IsZippyQ = false
			rnd.Name = fmt.Sprintf("Round %d", rNum)
			allZippy = false
		}
		for hi := range rnd.Heats {
			hNum := hi + 1
			rnd.Heats[hi].HeatNumber = hNum
			rnd.Heats[hi].Name = fmt.Sprintf("Heat %d", hNum)
		}
	}
	if len(r.Schedule.Rounds) > 0 {
		if allZippy {
			r.DisableSlotAutoPopulation = 1
		} else if !anyZippy {
			r.DisableSlotAutoPopulation = 0
			r.AutoQueueZippyQ = false
		}
	}
	r.CycleCount = len(r.Schedule.Rounds)
}

func ensurePilotCheckedInLocked(b *SimBackend, r *RaceViewData, pilotID int) *RaceEntry {
	for i := range r.Entries {
		if r.Entries[i].PilotID == pilotID {
			return &r.Entries[i]
		}
	}
	for _, p := range b.state.PilotPool {
		if p.PilotID == pilotID {
			r.Entries = append(r.Entries, p)
			return &r.Entries[len(r.Entries)-1]
		}
	}
	return nil
}

func findHeatMut(r *RaceViewData, roundNum, heatNum int) *ScheduleHeat {
	for ri := range r.Schedule.Rounds {
		if r.Schedule.Rounds[ri].RoundNumber != roundNum {
			continue
		}
		for hi := range r.Schedule.Rounds[ri].Heats {
			if r.Schedule.Rounds[ri].Heats[hi].HeatNumber == heatNum {
				return &r.Schedule.Rounds[ri].Heats[hi]
			}
		}
	}
	return nil
}

// checkInNextPoolPilotLocked checks in one unchecked chapter pool pilot into `r.Entries`.
func (b *SimBackend) checkInNextPoolPilotLocked(r *RaceViewData) bool {
	checked := make(map[int]bool, len(r.Entries))
	for _, e := range r.Entries {
		checked[e.PilotID] = true
	}
	for _, p := range b.state.PilotPool {
		if !checked[p.PilotID] {
			r.Entries = append(r.Entries, p)
			return true
		}
	}
	return false
}

// lineUpZippyQPilotLocked places one eligible checked-in pilot (or `requestedPilotID` if > 0)
// into the next open unsynced ZippyQ heat seat, or opens a new ZippyQ round when needed.
func (b *SimBackend) lineUpZippyQPilotLocked(r *RaceViewData, requestedPilotID int) bool {
	if len(r.Entries) == 0 {
		if !b.checkInNextPoolPilotLocked(r) {
			return false
		}
	}

	// Track which pilots are already waiting in an unsynced heat, their total appearances, and sticky channel
	waitingInUnsynced := make(map[int]bool)
	appearances := make(map[int]int)
	stickySlot := make(map[int]int)

	for _, rnd := range r.Schedule.Rounds {
		for i := range rnd.Heats {
			ht := &rnd.Heats[i]
			synced := heatHasSyncedResults(ht)
			for _, ent := range ht.Entries {
				if ent.PilotID <= 0 {
					continue
				}
				appearances[ent.PilotID]++
				if ent.Slot >= 1 && ent.Slot <= 8 {
					stickySlot[ent.PilotID] = ent.Slot
				}
				if !synced {
					waitingInUnsynced[ent.PilotID] = true
				}
			}
		}
	}

	var chosen *RaceEntry
	if requestedPilotID > 0 {
		chosen = ensurePilotCheckedInLocked(b, r, requestedPilotID)
	} else {
		bestCount := int(1e9)
		for i := range r.Entries {
			p := &r.Entries[i]
			if waitingInUnsynced[p.PilotID] {
				continue
			}
			if appearances[p.PilotID] < bestCount {
				bestCount = appearances[p.PilotID]
				chosen = p
			}
		}
		// Fallback if every checked-in pilot is already waiting in an unsynced heat: allow next rotation pilot
		// as long as they aren't already in the target open heat.
		if chosen == nil {
			var lastOpenHeatPilots map[int]bool
			if n := len(r.Schedule.Rounds); n > 0 {
				lastRnd := &r.Schedule.Rounds[n-1]
				if len(lastRnd.Heats) > 0 && !heatHasSyncedResults(&lastRnd.Heats[len(lastRnd.Heats)-1]) {
					lastOpenHeatPilots = make(map[int]bool)
					for _, e := range lastRnd.Heats[len(lastRnd.Heats)-1].Entries {
						if e.PilotID > 0 {
							lastOpenHeatPilots[e.PilotID] = true
						}
					}
				}
			}
			for i := range r.Entries {
				p := &r.Entries[i]
				if lastOpenHeatPilots != nil && lastOpenHeatPilots[p.PilotID] {
					continue
				}
				if appearances[p.PilotID] < bestCount {
					bestCount = appearances[p.PilotID]
					chosen = p
				}
			}
		}
	}
	if chosen == nil {
		return false
	}

	prefSlot := stickySlot[chosen.PilotID]
	if prefSlot == 0 {
		if ch, err := strconv.Atoi(chosen.Channel); err == nil && ch >= 1 && ch <= 8 {
			prefSlot = ch
		}
	}

	// Try to place into the first unsynced heat that has an empty seat and does not already contain `chosen`
	for ri := range r.Schedule.Rounds {
		rnd := &r.Schedule.Rounds[ri]
		for hi := range rnd.Heats {
			ht := &rnd.Heats[hi]
			if heatHasSyncedResults(ht) {
				continue
			}
			alreadyInHeat := false
			for _, e := range ht.Entries {
				if e.PilotID == chosen.PilotID {
					alreadyInHeat = true
					break
				}
			}
			if alreadyInHeat {
				continue
			}
			// Prefer matching sticky slot if empty
			targetIdx := -1
			for si, e := range ht.Entries {
				if e.PilotID == 0 && prefSlot > 0 && e.Slot == prefSlot {
					targetIdx = si
					break
				}
			}
			if targetIdx < 0 {
				for si, e := range ht.Entries {
					if e.PilotID == 0 {
						targetIdx = si
						break
					}
				}
			}
			if targetIdx >= 0 {
				slotCh := ht.Entries[targetIdx].Slot
				ht.Entries[targetIdx] = makeSeatEntry(slotCh, chosen)
				return true
			}
		}
	}

	// Otherwise open a new ZippyQ round and place `chosen` into their sticky seat (if in default 4) or seat 0
	nextRound := len(r.Schedule.Rounds) + 1
	newRnd := buildZippyQRound(nextRound, nil)
	seatIdx := 0
	for si, e := range newRnd.Heats[0].Entries {
		if prefSlot > 0 && e.Slot == prefSlot {
			seatIdx = si
			break
		}
	}
	slotCh := newRnd.Heats[0].Entries[seatIdx].Slot
	newRnd.Heats[0].Entries[seatIdx] = makeSeatEntry(slotCh, chosen)
	r.Schedule.Rounds = append(r.Schedule.Rounds, newRnd)
	r.CycleCount = len(r.Schedule.Rounds)
	return true
}

// StepSimulation advances autonomous ZippyQ pilot check-ins and line-ups when Simulation Mode is running.
func (b *SimBackend) StepSimulation(now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	if !b.lastStepTime.IsZero() && now.Sub(b.lastStepTime) < 6*time.Second {
		return false
	}
	b.lastStepTime = now
	b.stepCounter++

	changed := false
	for i := range b.state.Races {
		r := &b.state.Races[i]
		if r.DisableSlotAutoPopulation != 1 || !r.AutoQueueZippyQ {
			continue
		}

		// Periodically check in walk-up pilots from the chapter pool (up to 10 active pilots automatically)
		if b.stepCounter%3 == 1 && len(r.Entries) < 10 && len(r.Entries) < len(b.state.PilotPool) {
			if b.checkInNextPoolPilotLocked(r) {
				changed = true
			}
		}

		// Count unsynced heats currently queued so we maintain a realistic 2-3 heat flight-line buffer
		unsyncedHeats := 0
		lastHeatHasOpenSeat := false
		for _, rnd := range r.Schedule.Rounds {
			for hi := range rnd.Heats {
				ht := &rnd.Heats[hi]
				if !heatHasSyncedResults(ht) {
					unsyncedHeats++
					for _, e := range ht.Entries {
						if e.PilotID == 0 {
							lastHeatHasOpenSeat = true
							break
						}
					}
				}
			}
		}

		if unsyncedHeats < 3 || (unsyncedHeats == 3 && lastHeatHasOpenSeat) {
			if b.lineUpZippyQPilotLocked(r, 0) {
				changed = true
			}
		}
	}
	return changed
}

// ApplyAdminAction applies a simulated MultiGP control change from `#/sim` and returns the updated state.
func (b *SimBackend) ApplyAdminAction(act SimAdminAction) (SimPersistedState, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	switch act.Action {
	case "reset":
		b.state = defaultSimState()

	case "set-chapter":
		name := strings.TrimSpace(act.ChapterName)
		if name != "" {
			b.state.ChapterName = name
			for i := range b.state.Races {
				b.state.Races[i].ChapterName = name
			}
		}

	case "regen-key":
		var rnd [4]byte
		_, _ = rand.Read(rnd[:])
		b.state.APIKey = "MGP-SIM-" + strings.ToUpper(hex.EncodeToString(rnd[:]))

	case "add-race":
		name := strings.TrimSpace(act.Name)
		if name == "" {
			name = fmt.Sprintf("Simulated Race %d", b.state.NextRaceID)
		}
		id := b.state.NextRaceID
		b.state.NextRaceID++
		poolSlice := b.state.PilotPool
		if len(poolSlice) > 8 {
			poolSlice = poolSlice[:8]
		}
		entries := append([]RaceEntry(nil), poolSlice...)
		disableAuto := 0
		autoZippy := false
		var rounds []ScheduleRound
		if act.IsZippyQ {
			disableAuto = 1
			autoZippy = true
			seedPilots := entries
			if len(seedPilots) > 4 {
				seedPilots = seedPilots[:4]
			}
			rounds = []ScheduleRound{buildZippyQRound(1, seedPilots)}
		} else {
			rc := act.RoundCount
			if rc < 1 {
				rc = 3
			} else if rc > 8 {
				rc = 8
			}
			rounds = buildControlledRounds(entries, rc)
		}
		sf := act.ScoringFormat
		if sf != ScoringAggregateLaps && sf != ScoringFastestLap && sf != ScoringFastest2Consecutive && sf != ScoringFastest3Consecutive {
			sf = ScoringFastest3Consecutive
		}
		b.state.Races = append(b.state.Races, RaceViewData{
			ID:                        id,
			Name:                      name,
			StartDate:                 time.Now().Format("2006-01-02 15:04:05"),
			ChapterID:                 b.state.ChapterID,
			ChapterName:               b.state.ChapterName,
			RaceType:                  1,
			ScoringFormat:             sf,
			DisableSlotAutoPopulation: disableAuto,
			AutoQueueZippyQ:           autoZippy,
			CycleCount:                len(rounds),
			MaxLaps:                   3,
			RaceTimeSec:               120,
			Entries:                   entries,
			Schedule:                  RaceSchedule{Rounds: rounds},
		})

	case "delete-race":
		filtered := make([]RaceViewData, 0, len(b.state.Races))
		for _, r := range b.state.Races {
			if r.ID != act.RaceID {
				filtered = append(filtered, r)
			}
		}
		b.state.Races = filtered

	case "set-scoring":
		if r := b.findRaceLocked(act.RaceID); r != nil {
			r.ScoringFormat = act.ScoringFormat
		}

	case "set-mode":
		if r := b.findRaceLocked(act.RaceID); r != nil {
			if act.IsZippyQ {
				r.DisableSlotAutoPopulation = 1
			} else {
				r.DisableSlotAutoPopulation = 0
				r.AutoQueueZippyQ = false
			}
			for ri := range r.Schedule.Rounds {
				r.Schedule.Rounds[ri].IsZippyQ = act.IsZippyQ
				if act.IsZippyQ {
					r.Schedule.Rounds[ri].Name = fmt.Sprintf("ZippyQ Round %d", ri+1)
				} else {
					r.Schedule.Rounds[ri].Name = fmt.Sprintf("Round %d", ri+1)
				}
			}
			renumberRoundsAndHeats(r)
		}

	case "set-auto-zippyq":
		if r := b.findRaceLocked(act.RaceID); r != nil {
			r.AutoQueueZippyQ = act.Enabled
		}

	case "sim-zippyq-checkin":
		if r := b.findRaceLocked(act.RaceID); r != nil {
			b.checkInNextPoolPilotLocked(r)
		}

	case "sim-zippyq-lineup":
		if r := b.findRaceLocked(act.RaceID); r != nil {
			b.lineUpZippyQPilotLocked(r, act.PilotID)
		}

	case "queue-zippyq":
		if r := b.findRaceLocked(act.RaceID); r != nil {
			if len(r.Entries) == 0 {
				return b.state, fmt.Errorf("no pilots checked in for %q", r.Name)
			}
			nextRound := len(r.Schedule.Rounds) + 1
			picks := make([]RaceEntry, 0, 4)
			offset := ((nextRound - 1) * 3) % len(r.Entries)
			for k := 0; k < 4 && k < len(r.Entries); k++ {
				picks = append(picks, r.Entries[(offset+k)%len(r.Entries)])
			}
			r.Schedule.Rounds = append(r.Schedule.Rounds, buildZippyQRound(nextRound, picks))
			r.CycleCount = len(r.Schedule.Rounds)
		}

	case "toggle-pilot":
		if r := b.findRaceLocked(act.RaceID); r != nil {
			foundIdx := -1
			for ei, e := range r.Entries {
				if e.PilotID == act.PilotID {
					foundIdx = ei
					break
				}
			}
			if foundIdx >= 0 {
				r.Entries = append(r.Entries[:foundIdx], r.Entries[foundIdx+1:]...)
				// Clear pilot from unsynced seats without overwriting custom rounds/heats
				for ri := range r.Schedule.Rounds {
					for hi := range r.Schedule.Rounds[ri].Heats {
						ht := &r.Schedule.Rounds[ri].Heats[hi]
						if heatHasSyncedResults(ht) {
							continue
						}
						for si := range ht.Entries {
							if ht.Entries[si].PilotID == act.PilotID {
								ht.Entries[si] = makeSeatEntry(ht.Entries[si].Slot, nil)
							}
						}
					}
				}
			} else {
				ensurePilotCheckedInLocked(b, r, act.PilotID)
			}
		}

	case "set-all-pilots":
		if r := b.findRaceLocked(act.RaceID); r != nil {
			if act.Enabled {
				r.Entries = append([]RaceEntry(nil), b.state.PilotPool...)
			} else {
				r.Entries = nil
				for ri := range r.Schedule.Rounds {
					for hi := range r.Schedule.Rounds[ri].Heats {
						ht := &r.Schedule.Rounds[ri].Heats[hi]
						if heatHasSyncedResults(ht) {
							continue
						}
						for si := range ht.Entries {
							ht.Entries[si] = makeSeatEntry(ht.Entries[si].Slot, nil)
						}
					}
				}
			}
		}

	case "add-pool-pilot":
		cs := strings.TrimSpace(act.Name)
		if cs == "" {
			return b.state, fmt.Errorf("pilot callsign is required")
		}
		var targetPilot RaceEntry
		found := false
		for _, p := range b.state.PilotPool {
			if strings.EqualFold(strings.TrimSpace(p.UserName), cs) {
				targetPilot = p
				found = true
				break
			}
		}
		if !found {
			maxID := 1000
			for _, p := range b.state.PilotPool {
				if p.PilotID > maxID {
					maxID = p.PilotID
				}
			}
			ch := defaultSeatChannels[len(b.state.PilotPool)%4]
			targetPilot = RaceEntry{
				PilotID:     maxID + 1,
				UserName:    cs,
				DisplayName: cs,
				Band:        "R",
				Channel:     strconv.Itoa(ch),
				Frequency:   int(domain.RacebandFrequenciesMHz[ch-1]),
			}
			b.state.PilotPool = append(b.state.PilotPool, targetPilot)
		}
		if r := b.findRaceLocked(act.RaceID); r != nil {
			ensurePilotCheckedInLocked(b, r, targetPilot.PilotID)
		}

	case "rebuild-schedule":
		if r := b.findRaceLocked(act.RaceID); r != nil {
			rc := len(r.Schedule.Rounds)
			if rc < 1 {
				rc = 2
			}
			if r.DisableSlotAutoPopulation == 1 {
				seed := r.Entries
				if len(seed) > 4 {
					seed = seed[:4]
				}
				r.Schedule.Rounds = []ScheduleRound{buildZippyQRound(1, seed)}
			} else {
				r.Schedule.Rounds = buildControlledRounds(r.Entries, rc)
			}
			r.CycleCount = len(r.Schedule.Rounds)
		}

	case "add-round":
		if r := b.findRaceLocked(act.RaceID); r != nil {
			nextR := len(r.Schedule.Rounds) + 1
			rTitle := fmt.Sprintf("Round %d", nextR)
			if act.IsZippyQ {
				rTitle = fmt.Sprintf("ZippyQ Round %d", nextR)
			}
			r.Schedule.Rounds = append(r.Schedule.Rounds, ScheduleRound{
				RoundNumber: nextR,
				Name:        rTitle,
				IsZippyQ:    act.IsZippyQ,
				Heats: []ScheduleHeat{
					{
						HeatNumber: 1,
						Name:       "Heat 1",
						Entries:    buildEmptyFourSeatEntries(),
					},
				},
			})
			renumberRoundsAndHeats(r)
		}

	case "delete-round":
		if r := b.findRaceLocked(act.RaceID); r != nil {
			filtered := make([]ScheduleRound, 0, len(r.Schedule.Rounds))
			for _, rnd := range r.Schedule.Rounds {
				if rnd.RoundNumber != act.RoundNumber {
					filtered = append(filtered, rnd)
				}
			}
			r.Schedule.Rounds = filtered
			renumberRoundsAndHeats(r)
		}

	case "add-heat":
		if r := b.findRaceLocked(act.RaceID); r != nil {
			for ri := range r.Schedule.Rounds {
				if r.Schedule.Rounds[ri].RoundNumber == act.RoundNumber {
					nextH := len(r.Schedule.Rounds[ri].Heats) + 1
					r.Schedule.Rounds[ri].Heats = append(r.Schedule.Rounds[ri].Heats, ScheduleHeat{
						HeatNumber: nextH,
						Name:       fmt.Sprintf("Heat %d", nextH),
						Entries:    buildEmptyFourSeatEntries(),
					})
					break
				}
			}
			renumberRoundsAndHeats(r)
		}

	case "delete-heat":
		if r := b.findRaceLocked(act.RaceID); r != nil {
			for ri := range r.Schedule.Rounds {
				if r.Schedule.Rounds[ri].RoundNumber != act.RoundNumber {
					continue
				}
				filtered := make([]ScheduleHeat, 0, len(r.Schedule.Rounds[ri].Heats))
				for _, ht := range r.Schedule.Rounds[ri].Heats {
					if ht.HeatNumber != act.HeatNumber {
						filtered = append(filtered, ht)
					}
				}
				if len(filtered) == 0 {
					r.Schedule.Rounds = append(r.Schedule.Rounds[:ri], r.Schedule.Rounds[ri+1:]...)
				} else {
					r.Schedule.Rounds[ri].Heats = filtered
				}
				break
			}
			renumberRoundsAndHeats(r)
		}

	case "add-seat":
		if r := b.findRaceLocked(act.RaceID); r != nil {
			if ht := findHeatMut(r, act.RoundNumber, act.HeatNumber); ht != nil && len(ht.Entries) < 8 {
				used := make(map[int]bool, len(ht.Entries))
				for _, e := range ht.Entries {
					used[e.Slot] = true
				}
				nextSlot := 0
				for _, ch := range [8]int{1, 3, 5, 8, 2, 4, 6, 7} {
					if !used[ch] {
						nextSlot = ch
						break
					}
				}
				if nextSlot > 0 {
					ht.Entries = append(ht.Entries, makeSeatEntry(nextSlot, nil))
				}
			}
		}

	case "delete-seat":
		if r := b.findRaceLocked(act.RaceID); r != nil {
			if ht := findHeatMut(r, act.RoundNumber, act.HeatNumber); ht != nil {
				if act.SeatIndex >= 0 && act.SeatIndex < len(ht.Entries) && len(ht.Entries) > 1 {
					ht.Entries = append(ht.Entries[:act.SeatIndex], ht.Entries[act.SeatIndex+1:]...)
				}
			}
		}

	case "set-seat-channel":
		if r := b.findRaceLocked(act.RaceID); r != nil && act.Slot >= 1 && act.Slot <= 255 {
			if newBand, newCh, newFreq, ok := domain.DecodeBandChannel(uint8(act.Slot)); ok {
				newSlotCode := int(domain.EncodeBandChannel(newBand, newCh))
				if ht := findHeatMut(r, act.RoundNumber, act.HeatNumber); ht != nil {
					if act.SeatIndex >= 0 && act.SeatIndex < len(ht.Entries) {
						oldEntry := ht.Entries[act.SeatIndex]
						for si := range ht.Entries {
							if si != act.SeatIndex && (ht.Entries[si].Slot == newSlotCode || ht.Entries[si].Frequency == int(newFreq)) {
								ht.Entries[si].Slot = oldEntry.Slot
								ht.Entries[si].Band = oldEntry.Band
								ht.Entries[si].Channel = oldEntry.Channel
								ht.Entries[si].Frequency = oldEntry.Frequency
							}
						}
						ht.Entries[act.SeatIndex].Slot = newSlotCode
						ht.Entries[act.SeatIndex].Band = domain.BandPrefix(newBand)
						ht.Entries[act.SeatIndex].Channel = strconv.Itoa(int(newCh))
						ht.Entries[act.SeatIndex].Frequency = int(newFreq)
					}
				}
			}
		}

	case "assign-seat":
		if r := b.findRaceLocked(act.RaceID); r != nil {
			if ht := findHeatMut(r, act.RoundNumber, act.HeatNumber); ht != nil {
				if act.SeatIndex >= 0 && act.SeatIndex < len(ht.Entries) {
					slotCh := ht.Entries[act.SeatIndex].Slot
					if act.PilotID <= 0 {
						ht.Entries[act.SeatIndex] = makeSeatEntry(slotCh, nil)
					} else if p := ensurePilotCheckedInLocked(b, r, act.PilotID); p != nil {
						for si := range ht.Entries {
							if si != act.SeatIndex && ht.Entries[si].PilotID == p.PilotID {
								ht.Entries[si] = makeSeatEntry(ht.Entries[si].Slot, nil)
							}
						}
						ht.Entries[act.SeatIndex] = makeSeatEntry(slotCh, p)
					}
				}
			}
		}

	case "move-seat":
		if r := b.findRaceLocked(act.RaceID); r != nil {
			srcHt := findHeatMut(r, act.FromRound, act.FromHeat)
			dstHt := findHeatMut(r, act.RoundNumber, act.HeatNumber)
			if srcHt != nil && dstHt != nil &&
				act.FromSeatIndex >= 0 && act.FromSeatIndex < len(srcHt.Entries) &&
				act.SeatIndex >= 0 && act.SeatIndex < len(dstHt.Entries) {
				if srcHt == dstHt && act.FromSeatIndex == act.SeatIndex {
					break
				}
				srcEntry := srcHt.Entries[act.FromSeatIndex]
				dstEntry := dstHt.Entries[act.SeatIndex]

				var srcPilot, dstPilot *RaceEntry
				if srcEntry.PilotID > 0 {
					srcPilot = ensurePilotCheckedInLocked(b, r, srcEntry.PilotID)
				}
				if dstEntry.PilotID > 0 {
					dstPilot = ensurePilotCheckedInLocked(b, r, dstEntry.PilotID)
				}

				// If cross-heat move would duplicate `srcPilot` in `dstHt` (or `dstPilot` in `srcHt`), clear duplicate seat
				if srcHt != dstHt {
					if srcPilot != nil {
						for si := range dstHt.Entries {
							if si != act.SeatIndex && dstHt.Entries[si].PilotID == srcPilot.PilotID {
								dstHt.Entries[si] = makeSeatEntry(dstHt.Entries[si].Slot, nil)
							}
						}
					}
					if dstPilot != nil {
						for si := range srcHt.Entries {
							if si != act.FromSeatIndex && srcHt.Entries[si].PilotID == dstPilot.PilotID {
								srcHt.Entries[si] = makeSeatEntry(srcHt.Entries[si].Slot, nil)
							}
						}
					}
				}

				srcHt.Entries[act.FromSeatIndex] = makeSeatEntry(srcEntry.Slot, dstPilot)
				dstHt.Entries[act.SeatIndex] = makeSeatEntry(dstEntry.Slot, srcPilot)
			}
		}

	case "clear-uploads":
		if r := b.findRaceLocked(act.RaceID); r != nil {
			r.OverallResults = nil
			r.OverallSyncedAt = ""
			for ri := range r.Schedule.Rounds {
				for hi := range r.Schedule.Rounds[ri].Heats {
					ht := &r.Schedule.Rounds[ri].Heats[hi]
					for si := range ht.Entries {
						e := &ht.Entries[si]
						e.Score = 0
						e.TotalLaps = 0
						e.TotalTime = 0
						e.FastestLapTime = 0
						e.Fastest2ConsecutiveLapsTime = 0
						e.Fastest3ConsecutiveLapsTime = 0
						e.SyncedAt = ""
					}
				}
			}
		}
	}

	raw, _ := json.Marshal(b.state)
	var cp SimPersistedState
	_ = json.Unmarshal(raw, &cp)
	return cp, nil
}

// SyncPoolWithEnginePilots ensures any custom pilots added in SlapRF's roster also exist in the simulated MultiGP pool.
func (b *SimBackend) SyncPoolWithEnginePilots(pilots []domain.PilotSlot) {
	b.mu.Lock()
	defer b.mu.Unlock()
	byName := make(map[string]bool, len(b.state.PilotPool))
	maxID := 1000
	for _, p := range b.state.PilotPool {
		byName[strings.ToLower(strings.TrimSpace(p.UserName))] = true
		if p.PilotID > maxID {
			maxID = p.PilotID
		}
	}
	for _, sp := range pilots {
		cs := strings.TrimSpace(sp.Callsign)
		if cs == "" || byName[strings.ToLower(cs)] {
			continue
		}
		maxID++
		byName[strings.ToLower(cs)] = true
		ch := int(sp.Channel)
		if ch < 1 || ch > 8 {
			ch = 1
		}
		b.state.PilotPool = append(b.state.PilotPool, RaceEntry{
			PilotID:     maxID,
			UserName:    cs,
			DisplayName: cs,
			Phonetic:    sp.PhoneticName,
			Band:        "R",
			Channel:     strconv.Itoa(ch),
			Frequency:   int(domain.RacebandFrequenciesMHz[ch-1]),
		})
	}
}

// ServeWebServiceHTTP serves simulated MultiGP WebService v1.0.4 endpoints under `/api/sim/mgp/*`.
func (b *SimBackend) ServeWebServiceHTTP(w http.ResponseWriter, r *http.Request, subPath string) {
	if r.Method != http.MethodPost && r.Method != http.MethodPut {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var bodyMap map[string]json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&bodyMap); err != nil {
		writeMGPJSON(w, http.StatusBadRequest, GenericStatusResponse{
			Status:            false,
			StatusDescription: "Invalid JSON request body",
		})
		return
	}

	var apiKey string
	if rawKey, ok := bodyMap["apiKey"]; ok {
		_ = json.Unmarshal(rawKey, &apiKey)
	}
	apiKey = strings.TrimSpace(apiKey)

	b.mu.Lock()
	defer b.mu.Unlock()

	if apiKey == "" || apiKey != b.state.APIKey {
		writeMGPJSON(w, http.StatusUnauthorized, GenericStatusResponse{
			Status:            false,
			StatusDescription: "Invalid MultiGP Chapter API key (check Simulated MultiGP in the Simulation tab)",
		})
		return
	}

	cleanSub := strings.Trim(subPath, "/")
	q := r.URL.Query()

	switch cleanSub {
	case "chapter/findChapterFromApiKey":
		writeMGPJSON(w, http.StatusOK, FindChapterResponse{
			Status:      true,
			ChapterID:   b.state.ChapterID,
			ChapterName: b.state.ChapterName,
		})

	case "race/listForChapter":
		out := make([]RaceSummary, 0, len(b.state.Races))
		for _, rc := range b.state.Races {
			out = append(out, RaceSummary{
				ID:                        strconv.Itoa(rc.ID),
				Name:                      rc.Name,
				StartDate:                 rc.StartDate,
				ChapterID:                 strconv.Itoa(rc.ChapterID),
				ChapterName:               rc.ChapterName,
				ScoringFormat:             rc.ScoringFormat,
				DisableSlotAutoPopulation: rc.DisableSlotAutoPopulation,
				PilotCount:                len(rc.Entries),
				CycleCount:                len(rc.Schedule.Rounds),
			})
		}
		writeMGPJSON(w, http.StatusOK, ListForChapterResponse{
			Status: true,
			Data:   out,
		})

	case "pilot/listForChapter", "chapter/listPilots":
		seenID := make(map[int]bool)
		seenName := make(map[string]bool)
		entries := make([]RaceEntry, 0, len(b.state.PilotPool)+16)
		addEntry := func(ent RaceEntry) {
			nameKey := strings.ToLower(strings.TrimSpace(ent.UserName))
			if ent.PilotID > 0 && seenID[ent.PilotID] {
				return
			}
			if nameKey != "" && seenName[nameKey] {
				return
			}
			if ent.PilotID == 0 && nameKey == "" {
				return
			}
			if ent.PilotID > 0 {
				seenID[ent.PilotID] = true
			}
			if nameKey != "" {
				seenName[nameKey] = true
			}
			entries = append(entries, ent)
		}
		for _, p := range b.state.PilotPool {
			addEntry(p)
		}
		for _, rc := range b.state.Races {
			for _, ent := range rc.Entries {
				addEntry(ent)
			}
			for _, rnd := range rc.Schedule.Rounds {
				for _, ht := range rnd.Heats {
					for _, ent := range ht.Entries {
						addEntry(RaceEntry{
							PilotID:   ent.PilotID,
							UserName:  ent.UserName,
							Band:      ent.Band,
							Channel:   ent.Channel,
							Frequency: ent.Frequency,
						})
					}
				}
			}
		}
		writeMGPJSON(w, http.StatusOK, map[string]any{
			"status":      true,
			"chapterName": b.state.ChapterName,
			"data":        entries,
		})

	case "race/view":
		raceID, _ := strconv.Atoi(q.Get("id"))
		rc := b.findRaceLocked(raceID)
		if rc == nil {
			writeMGPJSON(w, http.StatusNotFound, GenericStatusResponse{
				Status:            false,
				StatusDescription: fmt.Sprintf("Race %d not found", raceID),
			})
			return
		}
		rc.CycleCount = len(rc.Schedule.Rounds)
		writeMGPJSON(w, http.StatusOK, RaceViewResponse{
			Status: true,
			Data:   *rc,
		})

	case "race/getAdditionalRounds":
		raceID, _ := strconv.Atoi(q.Get("id"))
		startFrom, _ := strconv.Atoi(q.Get("cycle"))
		if startFrom <= 0 {
			startFrom, _ = strconv.Atoi(q.Get("startFromRound"))
		}
		if startFrom <= 0 {
			startFrom = 1
		}
		rc := b.findRaceLocked(raceID)
		if rc == nil {
			writeMGPJSON(w, http.StatusNotFound, GenericStatusResponse{
				Status:            false,
				StatusDescription: fmt.Sprintf("Race %d not found", raceID),
			})
			return
		}
		var extra []ScheduleRound
		for _, rnd := range rc.Schedule.Rounds {
			if rnd.RoundNumber >= startFrom {
				extra = append(extra, rnd)
			}
		}
		writeMGPJSON(w, http.StatusOK, AdditionalRoundsResponse{
			Status:     true,
			CycleCount: len(rc.Schedule.Rounds),
			Data:       RaceSchedule{Rounds: extra},
		})

	case "race/create":
		var createData struct {
			Name          string `json:"name"`
			ScoringFormat int    `json:"scoringFormat"`
			MaxLaps       int    `json:"maxLaps"`
			RaceTimeSec   int    `json:"raceTimeSec"`
		}
		if rawData, ok := bodyMap["data"]; ok {
			_ = json.Unmarshal(rawData, &createData)
		}
		newID := 9001
		for _, existing := range b.state.Races {
			if existing.ID >= newID {
				newID = existing.ID + 1
			}
		}
		name := strings.TrimSpace(createData.Name)
		if name == "" {
			name = fmt.Sprintf("Uploaded Race #%d", newID)
		}
		maxLaps := createData.MaxLaps
		if maxLaps <= 0 {
			maxLaps = 3
		}
		raceTimeSec := createData.RaceTimeSec
		if raceTimeSec <= 0 {
			raceTimeSec = 120
		}
		newRace := RaceViewData{
			ID:                        newID,
			Name:                      name,
			StartDate:                 time.Now().UTC().Format("2006-01-02 15:04:05"),
			ChapterID:                 b.state.ChapterID,
			ChapterName:               b.state.ChapterName,
			RaceType:                  0,
			ScoringFormat:             createData.ScoringFormat,
			ScoringDisabled:           0,
			DisableSlotAutoPopulation: 0,
			CycleCount:                0,
			MaxLaps:                   maxLaps,
			RaceTimeSec:               raceTimeSec,
			Entries:                   []RaceEntry{},
			Schedule:                  RaceSchedule{Rounds: []ScheduleRound{}},
		}
		b.state.Races = append(b.state.Races, newRace)
		writeMGPJSON(w, http.StatusOK, map[string]any{
			"status": true,
			"raceId": newID,
			"data":   newRace,
		})

	case "race/assignSlot":
		raceID, _ := strconv.Atoi(q.Get("id"))
		cycle, _ := strconv.Atoi(q.Get("cycle"))
		heatNum, _ := strconv.Atoi(q.Get("heat"))
		slotNum, _ := strconv.Atoi(q.Get("slot"))
		rc := b.findRaceLocked(raceID)
		if rc == nil {
			writeMGPJSON(w, http.StatusNotFound, GenericStatusResponse{
				Status:            false,
				StatusDescription: fmt.Sprintf("Race %d not found", raceID),
			})
			return
		}
		var data AssignSlotData
		if rawData, ok := bodyMap["data"]; ok {
			_ = json.Unmarshal(rawData, &data)
		}
		if cycle < 1 {
			cycle = 1
		}
		if heatNum < 1 {
			heatNum = 1
		}
		if slotNum < 1 || slotNum > 8 {
			slotNum = 1
		}
		b.upsertSlotResultLocked(rc, cycle, heatNum, slotNum, data)
		writeMGPJSON(w, http.StatusOK, GenericStatusResponse{Status: true})

	case "race/captureOverallRaceResult":
		raceID, _ := strconv.Atoi(q.Get("id"))
		var data CaptureOverallData
		if rawData, ok := bodyMap["data"]; ok {
			_ = json.Unmarshal(rawData, &data)
		}
		if raceID == 0 {
			raceID = data.RaceID
		}
		rc := b.findRaceLocked(raceID)
		if rc == nil {
			writeMGPJSON(w, http.StatusNotFound, GenericStatusResponse{
				Status:            false,
				StatusDescription: fmt.Sprintf("Race %d not found", raceID),
			})
			return
		}
		resolved := make([]OverallResultEntry, 0, len(data.BracketResults))
		for _, br := range data.BracketResults {
			un := br.UserName
			if un == "" {
				un = b.pilotNameByIDLocked(rc, br.PilotID)
			}
			resolved = append(resolved, OverallResultEntry{
				OrderNumber: br.OrderNumber,
				PilotID:     br.PilotID,
				UserName:    un,
			})
		}
		rc.OverallResults = resolved
		rc.OverallSyncedAt = time.Now().UTC().Format(time.RFC3339)
		writeMGPJSON(w, http.StatusOK, GenericStatusResponse{Status: true})

	default:
		writeMGPJSON(w, http.StatusNotFound, GenericStatusResponse{
			Status:            false,
			StatusDescription: "Unsupported MultiGP endpoint: " + cleanSub,
		})
	}
}

func (b *SimBackend) findRaceLocked(id int) *RaceViewData {
	for i := range b.state.Races {
		if b.state.Races[i].ID == id {
			return &b.state.Races[i]
		}
	}
	return nil
}

func (b *SimBackend) pilotNameByIDLocked(rc *RaceViewData, pilotID int) string {
	for _, e := range rc.Entries {
		if e.PilotID == pilotID {
			return e.UserName
		}
	}
	for _, p := range b.state.PilotPool {
		if p.PilotID == pilotID {
			return p.UserName
		}
	}
	return fmt.Sprintf("Pilot #%d", pilotID)
}

func (b *SimBackend) upsertSlotResultLocked(rc *RaceViewData, cycle, heatNum, slotNum int, data AssignSlotData) {
	for len(rc.Schedule.Rounds) < cycle {
		nextR := len(rc.Schedule.Rounds) + 1
		rc.Schedule.Rounds = append(rc.Schedule.Rounds, ScheduleRound{
			RoundNumber: nextR,
			Name:        fmt.Sprintf("Round %d", nextR),
		})
	}
	rnd := &rc.Schedule.Rounds[cycle-1]
	for len(rnd.Heats) < heatNum {
		nextH := len(rnd.Heats) + 1
		rnd.Heats = append(rnd.Heats, ScheduleHeat{
			HeatNumber: nextH,
			Name:       fmt.Sprintf("Heat %d", nextH),
		})
	}
	ht := &rnd.Heats[heatNum-1]
	nowISO := time.Now().UTC().Format(time.RFC3339)
	userName := strings.TrimSpace(data.PilotCallsign)
	if userName == "" && data.PilotID > 0 {
		userName = b.pilotNameByIDLocked(rc, data.PilotID)
	}
	if data.PilotID > 0 && userName != "" {
		foundInEntries := false
		for i := range rc.Entries {
			if rc.Entries[i].PilotID == data.PilotID {
				foundInEntries = true
				break
			}
		}
		if !foundInEntries {
			rc.Entries = append(rc.Entries, RaceEntry{
				PilotID:   data.PilotID,
				UserName:  userName,
				FirstName: userName,
				Band:      "R",
				Channel:   strconv.Itoa(slotNum),
				Frequency: int(domain.RacebandFrequenciesMHz[(slotNum-1)%8]),
			})
		}
	}

	entry := HeatEntry{
		Slot:                        slotNum,
		PilotID:                     data.PilotID,
		UserName:                    userName,
		Band:                        "R",
		Channel:                     strconv.Itoa(slotNum),
		Frequency:                   int(domain.RacebandFrequenciesMHz[(slotNum-1)%8]),
		Score:                       data.Score,
		TotalLaps:                   data.TotalLaps,
		TotalTime:                   data.TotalTime,
		FastestLapTime:              data.FastestLapTime,
		Fastest2ConsecutiveLapsTime: data.Fastest2ConsecutiveLapsTime,
		Fastest3ConsecutiveLapsTime: data.Fastest3ConsecutiveLapsTime,
		SyncedAt:                    nowISO,
	}

	for i := range ht.Entries {
		if ht.Entries[i].Slot == slotNum {
			if ht.Entries[i].Band != "" {
				entry.Band = ht.Entries[i].Band
			}
			if ht.Entries[i].Channel != "" {
				entry.Channel = ht.Entries[i].Channel
			}
			if ht.Entries[i].Frequency > 0 {
				entry.Frequency = ht.Entries[i].Frequency
			}
			ht.Entries[i] = entry
			rc.CycleCount = len(rc.Schedule.Rounds)
			return
		}
	}
	ht.Entries = append(ht.Entries, entry)
	rc.CycleCount = len(rc.Schedule.Rounds)
}

func writeMGPJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
