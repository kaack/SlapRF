package tracker

import (
	"fmt"
	"math"
	"math/rand"
	"sort"
	"strings"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/race"
)

// EventActionPayload describes a Multi-Race, Race Tags, Per-Race Attendance, or Race Lifecycle mutation.
type EventActionPayload struct {
	Action          string                 `json:"action"`
	Name            string                 `json:"name,omitempty"`
	Tags            []string               `json:"tags,omitempty"`
	SlotIndex       int                    `json:"slotIndex,omitempty"`
	CheckedIn       *bool                  `json:"checkedIn,omitempty"`
	Attendance      domain.PilotAttendance `json:"attendance,omitempty"`
	PilotNote       string                 `json:"pilotNote,omitempty"`
	Callsign        string                 `json:"callsign,omitempty"`
	PhoneticName    string                 `json:"phoneticName,omitempty"`
	RaceID          string                 `json:"raceId,omitempty"`
	CopyConfig      bool                   `json:"copyConfig,omitempty"`
	DontSelect      bool                   `json:"dontSelect,omitempty"`
	LifecycleAction string                 `json:"lifecycleAction,omitempty"` // "start_race" | "pause_race" | "resume_race" | "emergency_stop" | "complete_race" | "scrap_race" | "reopen_race"
	Reason          string                 `json:"reason,omitempty"`
	StageIndex      int                    `json:"stageIndex,omitempty"`
	StageID         string                 `json:"stageId,omitempty"`
	StageAction     string                 `json:"stageAction,omitempty"` // "activate_stage" | "pause_stage" | "resume_stage" | "complete_stage_early" | "reopen_stage_early"
	PreemptOngoing  bool                   `json:"preemptOngoing,omitempty"`
}

// RoundPositionUpdate records a canvas (PosX, PosY) position for a single Round node.
type RoundPositionUpdate struct {
	RoundID string  `json:"roundId"`
	PosX    float64 `json:"posX"`
	PosY    float64 `json:"posY"`
}

// BracketEditPayload describes a template application, custom round/link mutation, regeneration,
// or manual drag-and-drop / click edit on unstarted heats in the active Race.
type BracketEditPayload struct {
	Action              string                  `json:"action"`
	RaceID              string                  `json:"raceId,omitempty"`
	TemplateID          string                  `json:"templateId,omitempty"`
	RoundID             string                  `json:"roundId,omitempty"`
	RoundIDs            []string                `json:"roundIds,omitempty"`
	Title               string                  `json:"title,omitempty"`
	StageFormat         domain.StageFormat      `json:"stageFormat,omitempty"`
	StartMode           domain.StartMode        `json:"startMode,omitempty"`
	HeatCount           int                     `json:"heatCount,omitempty"`
	TargetLaps          int                     `json:"targetLaps,omitempty"`
	TimeLimitSec        int                     `json:"timeLimitSec,omitempty"`
	QualifyingRounds     int                         `json:"qualifyingRounds,omitempty"`
	QualifyingMetric     domain.QualifyingMetric     `json:"qualifyingMetric,omitempty"`
	QualifyingLineupMode domain.QualifyingLineupMode `json:"qualifyingLineupMode,omitempty"`
	MaxPacksPerPilot    *int                    `json:"maxPacksPerPilot,omitempty"`
	ForceImmediate      bool                    `json:"forceImmediate,omitempty"`
	Stage2MaxSeeds      *int                    `json:"stage2MaxSeeds,omitempty"`
	StageIndex          int                     `json:"stageIndex,omitempty"`
	StageID             string                  `json:"stageId,omitempty"`
	FromStageID         string                  `json:"fromStageId,omitempty"`
	ToStageID           string                  `json:"toStageId,omitempty"`
	FromStageIndex      int                     `json:"fromStageIndex,omitempty"`
	ToStageIndex        int                     `json:"toStageIndex,omitempty"`
	SeatChannels        []uint8                 `json:"seatChannels,omitempty"`
	ApplyToExisting     bool                    `json:"applyToExisting,omitempty"`
	StagePositions      []StagePositionUpdate   `json:"stagePositions,omitempty"`
	SeedStart           int                     `json:"seedStart,omitempty"`
	SeedEnd             int                     `json:"seedEnd,omitempty"`
	Distribution        string                  `json:"distribution,omitempty"`
	FromStageSeed       int                     `json:"fromStageSeed,omitempty"`
	PointsRounds        int                     `json:"pointsRounds,omitempty"`
	PilotsPerHeat       int                     `json:"pilotsPerHeat,omitempty"`
	AceWinsRequired     int                     `json:"aceWinsRequired,omitempty"`
	WinnersAdvantageAce *bool                   `json:"winnersAdvantageAce,omitempty"`
	FinalsHeats         int                     `json:"finalsHeats,omitempty"`
	FinalsFormat        domain.FinalsFormat     `json:"finalsFormat,omitempty"`
	LinkMode          string                `json:"linkMode,omitempty"` // "all_active_pilots" | "top_per_heat" | "bottom_per_heat" | "standings_top" | "none" | "clear_links" | "empty"
	SourceColumn      int                   `json:"sourceColumn,omitempty"`
	SourceLane        string                `json:"sourceLane,omitempty"`
	AdvanceCount      int                   `json:"advanceCount,omitempty"`
	Column            int                   `json:"column,omitempty"`
	HeatID            string                `json:"heatId,omitempty"`
	SeatIndex         int                   `json:"seatIndex,omitempty"`
	FromHeatID        string                `json:"fromHeatId,omitempty"`
	FromSeatIndex     int                   `json:"fromSeatIndex,omitempty"`
	FromRank          int                   `json:"fromRank,omitempty"`
	FromRoundColumn   int                   `json:"fromRoundColumn,omitempty"`
	FromStandingsRank int                   `json:"fromStandingsRank,omitempty"`
	ToHeatID          string                `json:"toHeatId,omitempty"`
	ToSeatIndex       int                   `json:"toSeatIndex,omitempty"`
	PilotSlotIndex    int                   `json:"pilotSlotIndex,omitempty"`
	Band              domain.Band           `json:"band,omitempty"`
	Channel           uint8                 `json:"channel,omitempty"`
	BracketLane       string                `json:"bracketLane,omitempty"`
	Round             int                   `json:"round,omitempty"`
	FromRoundID       string                `json:"fromRoundId,omitempty"`
	ToRoundID         string                `json:"toRoundId,omitempty"`
	FromPort          string                `json:"fromPort,omitempty"`
	ToPort            string                `json:"toPort,omitempty"`
	ConnectionID      string                `json:"connectionId,omitempty"`
	HasPos            bool                  `json:"hasPos,omitempty"`
	PosX              float64               `json:"posX,omitempty"`
	PosY              float64               `json:"posY,omitempty"`
	Positions         []RoundPositionUpdate `json:"positions,omitempty"`
}

func nowISO() string {
	return time.Now().UTC().Format(time.RFC3339)
}

// EventSnapshot returns a deep copy of the EventManagerState (with the live active race synced).
func (e *Engine) EventSnapshot() domain.EventManagerState {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.syncActiveRaceToEventLocked()
	snap := cloneEventManagerState(e.eventState)
	e.mu.Unlock()
	return snap
}

func (e *Engine) nextUniqueIDLocked(prefix string) string {
	e.nextRaceSeq++
	return fmt.Sprintf("%s-%d-%d", prefix, time.Now().UnixMilli()%1_000_000, e.nextRaceSeq)
}

func buildEventRosterFromPilots(pilots []domain.PilotSlot) []domain.EventPilot {
	out := make([]domain.EventPilot, len(pilots))
	for i, p := range pilots {
		out[i] = domain.EventPilot{
			SlotIndex:      p.SlotIndex,
			Callsign:       p.Callsign,
			PhoneticName:   p.PhoneticName,
			Color:          p.Color,
			CheckedIn:      true,
			Attendance:     domain.AttendanceActive,
			MultiGPPilotID: p.MultiGPPilotID,
		}
	}
	return out
}

func newEmptyNoRaceState(mode domain.OperatingMode) domain.RaceTournamentState {
	if mode != domain.ModeRace {
		mode = domain.ModePractice
	}
	cfg := domain.DefaultRaceSetupConfig()
	cfg.EventName = ""
	return domain.RaceTournamentState{
		RaceID:           "",
		Tags:             nil,
		TemplateID:       "",
		Lifecycle:        domain.LifecycleDraft,
		Mode:             mode,
		Config:           cfg,
		Roster:           []domain.EventPilot{},
		Rounds:           []domain.RaceRound{},
		Generated:        false,
		ActiveStageIndex: 1,
		TotalStages:      1,
		Heats:            []domain.RaceHeat{},
		Edges:            []domain.BracketEdge{},
		Standings:        []domain.TournamentStanding{},
	}
}

func isRaceOngoing(r *domain.RaceTournamentState) bool {
	if r == nil || !r.Generated {
		return false
	}
	if r.Lifecycle == domain.LifecycleActive {
		return true
	}
	for _, h := range r.Heats {
		if h.State == domain.HeatCountdown || h.State == domain.HeatRunning {
			return true
		}
	}
	return false
}

func normalizeRaceRosterLocked(st *domain.RaceTournamentState, fallbackPilots []domain.PilotSlot) {
	if st == nil {
		return
	}
	if len(st.Roster) == 0 && len(fallbackPilots) > 0 && st.RaceID != "" &&
		st.Lifecycle != domain.LifecycleCompleted && st.Lifecycle != domain.LifecycleScrapped {
		st.Roster = buildEventRosterFromPilots(fallbackPilots)
	}
	for i := range st.Roster {
		st.Roster[i].Attendance = domain.NormalizeAttendance(st.Roster[i].Attendance)
	}
}

func (e *Engine) ensureEventStateInitializedLocked() {
	now := nowISO()
	if !e.eventState.Initialized {
		if e.eventState.Races == nil {
			e.eventState.Races = []domain.RaceTournamentState{}
		}
		// If legacy engine had a generated raceState before EventManagerState existed, preserve it
		if len(e.eventState.Races) == 0 && (e.raceState.Generated || len(e.raceState.Heats) > 0) {
			rs := cloneRaceState(e.raceState)
			if rs.RaceID == "" {
				rs.RaceID = e.nextUniqueIDLocked("race")
			}
			if rs.CreatedAt == "" {
				rs.CreatedAt = now
			}
			rs.UpdatedAt = now
			rs.Tags = domain.NormalizeRaceTags(rs.Tags)
			normalizeRaceRosterLocked(&rs, e.pilots)
			race.SyncRoundsMetadata(&rs)
			e.raceState = rs
			e.eventState.Races = []domain.RaceTournamentState{cloneRaceState(rs)}
			e.eventState.ActiveRaceID = rs.RaceID
		} else if len(e.eventState.Races) == 0 {
			e.raceState = newEmptyNoRaceState(e.raceState.Mode)
			e.eventState.ActiveRaceID = ""
		}
		e.eventState.Initialized = true
	}

	if e.eventState.Races == nil {
		e.eventState.Races = []domain.RaceTournamentState{}
	}

	for ri := range e.eventState.Races {
		r := &e.eventState.Races[ri]
		r.Tags = domain.NormalizeRaceTags(r.Tags)
		e.ensureRaceTrackInitializedLocked(r)
		normalizeRaceRosterLocked(r, e.pilots)
		race.SyncRoundsMetadata(r)
	}
	e.disambiguateDuplicateRaceNamesLocked()

	if len(e.eventState.Races) == 0 {
		e.eventState.ActiveRaceID = ""
		return
	}

	// Validate ActiveRaceID
	rIdx := -1
	if e.eventState.ActiveRaceID != "" {
		for i := range e.eventState.Races {
			if e.eventState.Races[i].RaceID == e.eventState.ActiveRaceID {
				rIdx = i
				break
			}
		}
	}
	if rIdx < 0 && e.raceState.RaceID != "" {
		for i := range e.eventState.Races {
			if e.eventState.Races[i].RaceID == e.raceState.RaceID {
				rIdx = i
				e.eventState.ActiveRaceID = e.raceState.RaceID
				break
			}
		}
	}
	if rIdx < 0 {
		rIdx = 0
		e.eventState.ActiveRaceID = e.eventState.Races[0].RaceID
	}
	if e.raceState.RaceID != e.eventState.ActiveRaceID {
		curMode := e.raceState.Mode
		if curMode != domain.ModeRace {
			curMode = domain.ModePractice
		}
		next := cloneRaceState(e.eventState.Races[rIdx])
		next.Mode = curMode
		e.raceState = next
	}
	normalizeRaceRosterLocked(&e.raceState, e.pilots)
}

func (e *Engine) findDuplicateRaceBySlugLocked(name string, excludeRaceID string) *domain.RaceTournamentState {
	want := domain.SlugifyRaceName(name)
	for i := range e.eventState.Races {
		r := &e.eventState.Races[i]
		if excludeRaceID != "" && r.RaceID == excludeRaceID {
			continue
		}
		if domain.SlugifyRaceName(r.Config.EventName) == want {
			return r
		}
	}
	if e.raceState.RaceID != "" && e.raceState.RaceID != excludeRaceID {
		if domain.SlugifyRaceName(e.raceState.Config.EventName) == want {
			return &e.raceState
		}
	}
	return nil
}

func (e *Engine) nextDefaultRaceNameLocked() string {
	n := len(e.eventState.Races) + 1
	if n < 1 {
		n = 1
	}
	for {
		cand := fmt.Sprintf("Race %d", n)
		if e.findDuplicateRaceBySlugLocked(cand, "") == nil {
			return cand
		}
		n++
	}
}

// stripTrailingCopyNumbers strips one or more trailing ` (<digits>)` copy suffixes from `name`,
// returning both the bare base string and how many trailing copy groups were stripped.
func stripTrailingCopyNumbers(name string) (string, int) {
	cur := strings.TrimSpace(name)
	count := 0
	for strings.HasSuffix(cur, ")") {
		openIdx := strings.LastIndex(cur, " (")
		if openIdx <= 0 {
			break
		}
		numPart := cur[openIdx+2 : len(cur)-1]
		if len(numPart) == 0 {
			break
		}
		allDigits := true
		for i := 0; i < len(numPart); i++ {
			if numPart[i] < '0' || numPart[i] > '9' {
				allDigits = false
				break
			}
		}
		if !allDigits {
			break
		}
		cur = strings.TrimSpace(cur[:openIdx])
		count++
	}
	return cur, count
}

func (e *Engine) disambiguateDuplicateRaceNamesLocked() {
	if len(e.eventState.Races) > 1 {
		seenIDs := make(map[string]int, len(e.eventState.Races))
		deduped := make([]domain.RaceTournamentState, 0, len(e.eventState.Races))
		for _, rc := range e.eventState.Races {
			if rc.RaceID != "" {
				if prevIdx, exists := seenIDs[rc.RaceID]; exists {
					deduped[prevIdx] = rc
					continue
				}
				seenIDs[rc.RaceID] = len(deduped)
			}
			deduped = append(deduped, rc)
		}
		e.eventState.Races = deduped
	}
	seen := make(map[string]bool, len(e.eventState.Races))
	for i := range e.eventState.Races {
		r := &e.eventState.Races[i]
		base := strings.TrimSpace(r.Config.EventName)
		if stripped, n := stripTrailingCopyNumbers(base); n >= 2 && stripped != "" {
			base = stripped
		}
		if base == "" {
			base = fmt.Sprintf("Race %d", i+1)
		}
		slug := domain.SlugifyRaceName(base)
		if !seen[slug] {
			seen[slug] = true
			if r.Config.EventName != base {
				r.Config.EventName = base
				if e.raceState.RaceID != "" && e.raceState.RaceID == r.RaceID {
					e.raceState.Config.EventName = base
				}
			}
			continue
		}
		cleanBase, _ := stripTrailingCopyNumbers(base)
		if cleanBase == "" {
			cleanBase = base
		}
		for suffix := 2; ; suffix++ {
			cand := fmt.Sprintf("%s (%d)", cleanBase, suffix)
			candSlug := domain.SlugifyRaceName(cand)
			if !seen[candSlug] {
				seen[candSlug] = true
				r.Config.EventName = cand
				if e.raceState.RaceID != "" && e.raceState.RaceID == r.RaceID {
					e.raceState.Config.EventName = cand
				}
				break
			}
		}
	}
}

// syncActiveRaceToEventLocked writes `e.raceState` back into `e.eventState.Races`.
func (e *Engine) syncActiveRaceToEventLocked() {
	e.ensureEventStateInitializedLocked()
	if e.raceState.RaceID == "" {
		return
	}
	now := nowISO()
	if e.raceState.CreatedAt == "" {
		e.raceState.CreatedAt = now
	}
	e.raceState.UpdatedAt = now
	e.ensureRaceTrackInitializedLocked(&e.raceState)
	normalizeRaceRosterLocked(&e.raceState, e.pilots)
	race.SyncRoundsMetadata(&e.raceState)
	cp := cloneRaceState(e.raceState)

	for i := range e.eventState.Races {
		if e.eventState.Races[i].RaceID == cp.RaceID {
			e.eventState.Races[i] = cp
			e.eventState.ActiveRaceID = cp.RaceID
			return
		}
	}
	e.eventState.Races = append(e.eventState.Races, cp)
	e.eventState.ActiveRaceID = cp.RaceID
}

// loadRaceByIDLocked pauses any running heat, saves the current race, and loads `raceID` into `e.raceState`.
func (e *Engine) loadRaceByIDLocked(raceID string) bool {
	e.editingRaceID = ""
	curMode := e.raceState.Mode
	if curMode != domain.ModeRace {
		curMode = domain.ModePractice
	}
	e.pauseLiveHeatIfRunningLocked()
	e.syncActiveRaceToEventLocked()

	if raceID == "" || len(e.eventState.Races) == 0 {
		e.eventState.ActiveRaceID = ""
		e.raceState = newEmptyNoRaceState(curMode)
		if curMode == domain.ModeRace {
			e.disarmAllPilotSlotsForRaceLocked()
		}
		return true
	}

	targetIdx := -1
	for i := range e.eventState.Races {
		if e.eventState.Races[i].RaceID == raceID {
			targetIdx = i
			break
		}
	}
	if targetIdx < 0 {
		return false
	}

	e.eventState.ActiveRaceID = raceID
	next := cloneRaceState(e.eventState.Races[targetIdx])
	next.Mode = curMode
	normalizeRaceRosterLocked(&next, e.pilots)
	e.raceState = next
	if e.raceState.Generated {
		e.resolveActiveTournamentLocked()
	} else {
		e.syncActiveRaceToEventLocked()
	}
	if curMode == domain.ModeRace {
		e.stageOrDisarmActiveRaceLocked()
	}
	return true
}

type targetRaceSwap struct {
	swapped       bool
	targetIdx     int
	origRaceMode  domain.OperatingMode
	savedRace     domain.RaceTournamentState
	savedActiveID string
	savedArmed    bool
}

// enterTargetRaceLocked targets `raceID` for setup, format, bracket, or roster mutations.
// When `e.raceState` is NOT ongoing, it switches `e.raceState` normally via `loadRaceByIDLocked`.
// When `e.raceState` IS ongoing (`Race A` live on track) and `raceID` refers to another race (`Race B`),
// it preserves `Race A` and `e.raceArmed` untouched and loads a `ModePractice` working copy of `Race B`
// into `e.raceState` for the duration of the synchronous locked mutation.
func (e *Engine) enterTargetRaceLocked(raceID string) (targetRaceSwap, error) {
	tid := strings.TrimSpace(raceID)
	if tid == "" && e.editingRaceID != "" {
		tid = e.editingRaceID
	}
	if tid == "" || tid == e.raceState.RaceID {
		return targetRaceSwap{}, nil
	}
	if !isRaceOngoing(&e.raceState) {
		if !e.loadRaceByIDLocked(tid) {
			return targetRaceSwap{}, fmt.Errorf("race %q not found", tid)
		}
		return targetRaceSwap{}, nil
	}

	e.syncActiveRaceToEventLocked()
	targetIdx := -1
	for i := range e.eventState.Races {
		if e.eventState.Races[i].RaceID == tid {
			targetIdx = i
			break
		}
	}
	if targetIdx < 0 {
		if tid == e.editingRaceID {
			e.editingRaceID = ""
			return targetRaceSwap{}, nil
		}
		return targetRaceSwap{}, fmt.Errorf("race %q not found", tid)
	}

	swap := targetRaceSwap{
		swapped:       true,
		targetIdx:     targetIdx,
		origRaceMode:  e.eventState.Races[targetIdx].Mode,
		savedRace:     cloneRaceState(e.raceState),
		savedActiveID: e.eventState.ActiveRaceID,
		savedArmed:    e.raceArmed,
	}

	working := cloneRaceState(e.eventState.Races[targetIdx])
	working.Mode = domain.ModePractice
	normalizeRaceRosterLocked(&working, e.pilots)
	e.raceState = working
	e.eventState.ActiveRaceID = working.RaceID
	return swap, nil
}

func (e *Engine) exitTargetRaceLocked(swap *targetRaceSwap, commit bool) domain.RaceTournamentState {
	if swap == nil || !swap.swapped {
		return cloneRaceState(e.raceState)
	}
	var targetSnap domain.RaceTournamentState
	if commit {
		e.raceState.Mode = swap.origRaceMode
		if e.raceState.Mode == "" {
			e.raceState.Mode = domain.ModePractice
		}
		now := nowISO()
		if e.raceState.CreatedAt == "" {
			e.raceState.CreatedAt = now
		}
		e.raceState.UpdatedAt = now
		e.ensureRaceTrackInitializedLocked(&e.raceState)
		normalizeRaceRosterLocked(&e.raceState, e.pilots)
		race.SyncRoundsMetadata(&e.raceState)
		targetSnap = cloneRaceState(e.raceState)
		replaced := false
		for i := range e.eventState.Races {
			if e.eventState.Races[i].RaceID == targetSnap.RaceID {
				e.eventState.Races[i] = targetSnap
				replaced = true
				break
			}
		}
		if !replaced {
			e.eventState.Races = append(e.eventState.Races, targetSnap)
		}
	} else if swap.targetIdx >= 0 && swap.targetIdx < len(e.eventState.Races) {
		targetSnap = cloneRaceState(e.eventState.Races[swap.targetIdx])
	}

	// Preserve any global walk-up pilots added during the mutation on the restored ongoing race's roster.
	for i := range e.eventState.Races {
		if e.eventState.Races[i].RaceID == swap.savedRace.RaceID {
			if len(e.eventState.Races[i].Roster) > len(swap.savedRace.Roster) {
				swap.savedRace.Roster = append([]domain.EventPilot(nil), e.eventState.Races[i].Roster...)
			}
			break
		}
	}

	e.raceState = swap.savedRace
	e.eventState.ActiveRaceID = swap.savedActiveID
	e.raceArmed = swap.savedArmed
	e.syncActiveRaceToEventLocked()
	return targetSnap
}

func (e *Engine) pauseLiveHeatIfRunningLocked() {
	if ah := e.findHeatLocked(e.raceState.ActiveHeatID); ah != nil {
		nowUs := e.NowUs()
		if ah.State == domain.HeatCountdown {
			ah.State = domain.HeatStaged
			ah.CountdownRemainingSec = 0
			ah.CountdownEndUs = 0
			e.raceArmed = false
		} else if ah.State == domain.HeatRunning {
			ah.State = domain.HeatPaused
			ah.PausedAtUs = nowUs
			if ah.StartToneUs > 0 && nowUs >= ah.StartToneUs {
				ah.ElapsedSec = float64(nowUs-ah.StartToneUs) / 1e6
			}
			e.raceArmed = false
		}
	}
}

func (e *Engine) stageOrDisarmActiveRaceLocked() {
	if !e.raceState.Generated ||
		len(e.raceState.Heats) == 0 ||
		e.raceState.Lifecycle == domain.LifecyclePaused ||
		e.raceState.Lifecycle == domain.LifecycleScrapped ||
		e.raceState.Lifecycle == domain.LifecycleCompleted {
		e.disarmAllPilotSlotsForRaceLocked()
		return
	}
	if ah := e.findHeatLocked(e.raceState.ActiveHeatID); ah != nil && ah.State != domain.HeatConfirmed {
		e.stageHeatLocked(e.raceState.ActiveHeatID, false)
	} else if e.raceState.NextReadyHeatID != "" {
		e.stageHeatLocked(e.raceState.NextReadyHeatID, true)
	} else {
		e.disarmAllPilotSlotsForRaceLocked()
	}
}

// syncGlobalPilotsToOpenEventsLocked keeps open/draft Races' rosters aligned when pilots are edited,
// added, or removed in the Global Pilot Directory (`#/pilots`), while never touching `completed`
// or `scrapped` historical races.
func (e *Engine) syncGlobalPilotsToOpenEventsLocked(added *domain.PilotSlot, removedSlot int) {
	e.ensureEventStateInitializedLocked()
	globalBySlot := make(map[int]domain.PilotSlot, len(e.pilots))
	for _, p := range e.pilots {
		globalBySlot[p.SlotIndex] = p
	}

	syncOne := func(r *domain.RaceTournamentState) {
		if r == nil || r.RaceID == "" || r.Lifecycle == domain.LifecycleCompleted || r.Lifecycle == domain.LifecycleScrapped {
			return
		}
		isUntouchedDraft := r.Lifecycle == domain.LifecycleDraft && !hasAnyStartedHeatInState(r)
		if removedSlot > 0 {
			if isUntouchedDraft {
				filtered := make([]domain.EventPilot, 0, len(r.Roster))
				for _, ep := range r.Roster {
					if ep.SlotIndex != removedSlot {
						filtered = append(filtered, ep)
					}
				}
				r.Roster = filtered
			} else {
				for i := range r.Roster {
					if r.Roster[i].SlotIndex == removedSlot {
						r.Roster[i].Attendance = domain.AttendanceForfeit
					}
				}
				applyAttendanceToRaceLocked(r, removedSlot, false)
			}
		}
		for ri := range r.Roster {
			if gp, ok := globalBySlot[r.Roster[ri].SlotIndex]; ok {
				r.Roster[ri].Callsign = gp.Callsign
				r.Roster[ri].PhoneticName = gp.PhoneticName
				if gp.Color != "" {
					r.Roster[ri].Color = gp.Color
				}
			}
		}
		if added != nil {
			exists := false
			for _, ep := range r.Roster {
				if ep.SlotIndex == added.SlotIndex {
					exists = true
					break
				}
			}
			if !exists {
				r.Roster = append(r.Roster, domain.EventPilot{
					SlotIndex:    added.SlotIndex,
					Callsign:     added.Callsign,
					PhoneticName: added.PhoneticName,
					Color:        added.Color,
					CheckedIn:    isUntouchedDraft,
					Attendance:   domain.AttendanceActive,
				})
			}
		}
	}

	syncOne(&e.raceState)
	for i := range e.eventState.Races {
		if e.eventState.Races[i].RaceID == e.raceState.RaceID {
			continue
		}
		syncOne(&e.eventState.Races[i])
	}
}

// activeEventPilotsForGenerationLocked returns the `PilotSlot` slice of checked-in `Active` pilots
// in the active Race (`e.raceState.Roster`), falling back to `e.pilots` if the race roster is empty.
func (e *Engine) activeEventPilotsForGenerationLocked() []domain.PilotSlot {
	if len(e.raceState.Roster) == 0 {
		return append([]domain.PilotSlot(nil), e.pilots...)
	}
	globalBySlot := make(map[int]domain.PilotSlot, len(e.pilots))
	for _, p := range e.pilots {
		globalBySlot[p.SlotIndex] = p
	}
	out := make([]domain.PilotSlot, 0, len(e.raceState.Roster))
	for _, ep := range e.raceState.Roster {
		if !ep.IsAvailableToRace() {
			continue
		}
		if gp, ok := globalBySlot[ep.SlotIndex]; ok {
			gp.Callsign = ep.Callsign
			gp.PhoneticName = ep.PhoneticName
			if ep.Color != "" {
				gp.Color = ep.Color
			}
			out = append(out, gp)
		} else {
			out = append(out, domain.PilotSlot{
				SlotIndex:    ep.SlotIndex,
				Callsign:     ep.Callsign,
				PhoneticName: ep.PhoneticName,
				Color:        ep.Color,
				Band:         domain.BandRaceband,
			})
		}
	}
	return out
}

// activeEventRosterAndAttendanceLocked builds the per-race roster + attendance map for `ResolveTournamentWithAttendance`.
func (e *Engine) activeEventRosterAndAttendanceLocked() ([]domain.PilotSlot, map[int]domain.PilotAttendance) {
	if len(e.raceState.Roster) == 0 {
		roster := append([]domain.PilotSlot(nil), e.pilots...)
		att := make(map[int]domain.PilotAttendance, len(roster))
		for _, p := range roster {
			att[p.SlotIndex] = domain.AttendanceActive
		}
		return roster, att
	}
	globalBySlot := make(map[int]domain.PilotSlot, len(e.pilots))
	for _, p := range e.pilots {
		globalBySlot[p.SlotIndex] = p
	}
	roster := make([]domain.PilotSlot, 0, len(e.raceState.Roster))
	att := make(map[int]domain.PilotAttendance, len(e.raceState.Roster))
	for _, ep := range e.raceState.Roster {
		a := domain.NormalizeAttendance(ep.Attendance)
		if !ep.CheckedIn {
			a = domain.AttendanceForfeit
		}
		att[ep.SlotIndex] = a
		if !ep.CheckedIn {
			continue
		}
		if gp, ok := globalBySlot[ep.SlotIndex]; ok {
			gp.Callsign = ep.Callsign
			gp.PhoneticName = ep.PhoneticName
			if ep.Color != "" {
				gp.Color = ep.Color
			}
			roster = append(roster, gp)
		} else {
			roster = append(roster, domain.PilotSlot{
				SlotIndex:    ep.SlotIndex,
				Callsign:     ep.Callsign,
				PhoneticName: ep.PhoneticName,
				Color:        ep.Color,
			})
		}
	}
	return roster, att
}

func (e *Engine) resolveActiveTournamentLocked() {
	if e.raceState.RaceID == "" && !e.raceState.Generated {
		return
	}
	roster, att := e.activeEventRosterAndAttendanceLocked()
	race.ResolveTournamentWithAttendance(&e.raceState, roster, att)
	e.syncActiveRaceToEventLocked()
}

func hasAnyStartedHeatInState(st *domain.RaceTournamentState) bool {
	for _, h := range st.Heats {
		if h.State == domain.HeatCountdown || h.State == domain.HeatRunning ||
			h.State == domain.HeatPaused || h.State == domain.HeatFinished ||
			(h.State == domain.HeatConfirmed && h.Note != "Auto-advance (bye)") {
			return true
		}
	}
	return false
}

// unlockTerminalConfirmedHeatsForReopenLocked transitions the deciding confirmed heat in each
// completed terminal stage back to `HeatFinished` (Review) when reopening a naturally completed race,
// returning the primary unlocked heat ID to focus in Race Control.
func (e *Engine) unlockTerminalConfirmedHeatsForReopenLocked() string {
	isFinalsOrCTA := func(h *domain.RaceHeat) bool {
		return h.BracketLane == "finals" ||
			h.ID == "GF-1" ||
			strings.HasSuffix(h.ID, "-GF-1") ||
			strings.HasPrefix(h.ID, "CTA-") ||
			strings.Contains(h.ID, "-CTA-")
	}

	pickCandidate := func(stageIdx int) *domain.RaceHeat {
		var allConfirmed []*domain.RaceHeat
		var finalsConfirmed []*domain.RaceHeat
		for i := range e.raceState.Heats {
			h := &e.raceState.Heats[i]
			if stageIdx > 0 && h.StageIndex != stageIdx {
				continue
			}
			if h.State != domain.HeatConfirmed || h.Note == "Auto-advance (bye)" {
				continue
			}
			allConfirmed = append(allConfirmed, h)
			if isFinalsOrCTA(h) {
				finalsConfirmed = append(finalsConfirmed, h)
			}
		}
		pool := allConfirmed
		if len(finalsConfirmed) > 0 {
			pool = finalsConfirmed
		}
		if len(pool) == 0 {
			return nil
		}
		// In Chase the Ace, always unlock the latest CTA heat (so earlier CTA heats keep their Aces).
		hasCTA := false
		for _, cand := range pool {
			if strings.HasPrefix(cand.ID, "CTA-") || strings.Contains(cand.ID, "-CTA-") {
				hasCTA = true
				break
			}
		}
		if !hasCTA && e.raceState.ActiveHeatID != "" {
			for _, cand := range pool {
				if cand.ID == e.raceState.ActiveHeatID {
					return cand
				}
			}
		}
		best := pool[len(pool)-1]
		for _, cand := range pool {
			if cand.ExecutedAtMs > best.ExecutedAtMs ||
				(cand.ExecutedAtMs == best.ExecutedAtMs && cand.Order >= best.Order) {
				best = cand
			}
		}
		return best
	}

	focusID := ""
	if len(e.raceState.Stages) > 0 {
		for i := range e.raceState.Stages {
			stg := &e.raceState.Stages[i]
			if stg.Status != domain.StageStatusCompleted || len(race.OutgoingStageConnections(&e.raceState, stg.Index)) > 0 {
				continue
			}
			if chosen := pickCandidate(stg.Index); chosen != nil {
				chosen.State = domain.HeatFinished
				chosen.CanUnlock = false
				if focusID == "" || stg.Index == e.raceState.ActiveStageIndex {
					focusID = chosen.ID
				}
			}
		}
	}
	if focusID == "" {
		if chosen := pickCandidate(0); chosen != nil {
			chosen.State = domain.HeatFinished
			chosen.CanUnlock = false
			focusID = chosen.ID
		}
	}
	return focusID
}

func hasAnyManualLocksInState(st *domain.RaceTournamentState) bool {
	if st.TemplateID == "custom" {
		return true
	}
	for _, h := range st.Heats {
		for _, s := range h.Seats {
			if s.ManualLock {
				return true
			}
		}
	}
	return false
}

func isUnstartedHeatState(st domain.HeatState) bool {
	return st == domain.HeatWaiting || st == domain.HeatReady || st == domain.HeatStaged
}

// pilotHasCountedHeatInRace returns true when `slotIndex` has already started or completed
// at least one non-DNS, non-aborted heat in `st` (preventing unchecking from the roster).
func pilotHasCountedHeatInRace(st *domain.RaceTournamentState, slotIndex int) bool {
	if st == nil || slotIndex <= 0 {
		return false
	}
	for _, h := range st.Heats {
		if isUnstartedHeatState(h.State) || h.State == domain.HeatAborted {
			continue
		}
		for _, s := range h.Seats {
			if s.PilotSlotIndex == slotIndex && s.Status != domain.PilotHeatDNS {
				return true
			}
		}
	}
	return false
}

// applyRosterAttendanceStateLocked applies full roster check-in and `Away | DQ | DNC` semantics:
//   - Open Qualifier unstarted packs dequeue pilots who are unchecked, `away`, `dq`, or `dnc`.
//   - Race-level `dq` marks started/completed seats `PilotHeatDQ` (`RosterDQ = true`) while
//     preserving all recorded `Laps`, `Crossings`, and `RssiTrace`, and marks unstarted non-OQ seats `DNS`.
//   - Toggling `dq` off restores `RosterDQ` seats by recomputing from preserved `Laps`/`Crossings`.
//   - Unstarted non-OQ seats scratch as `DNS` when unavailable and restore to `Staged` when available.
func applyRosterAttendanceStateLocked(st *domain.RaceTournamentState, slotIndex int, checkedIn bool, att domain.PilotAttendance) {
	if st == nil || !st.Generated || st.Lifecycle == domain.LifecycleCompleted || st.Lifecycle == domain.LifecycleScrapped {
		return
	}
	normAtt := domain.NormalizeAttendance(att)
	available := checkedIn && normAtt == domain.AttendanceActive
	isRosterDQ := checkedIn && normAtt == domain.AttendanceDQ

	if !available {
		openQualDequeueAllUnstartedForPilotLocked(st, slotIndex)
	}

	metric := st.Config.QualifyingMetric
	for hi := range st.Heats {
		h := &st.Heats[hi]
		if isUnstartedHeatState(h.State) {
			if h.StageFormat == domain.FormatOpenQualifier {
				continue
			}
			touched := false
			for si := range h.Seats {
				s := &h.Seats[si]
				if s.PilotSlotIndex != slotIndex {
					continue
				}
				if !available && s.Status == domain.PilotHeatStaged {
					s.Status = domain.PilotHeatDNS
					touched = true
				} else if available && s.Status == domain.PilotHeatDNS {
					s.Status = domain.PilotHeatStaged
					touched = true
				}
			}
			if touched {
				race.RecomputeHeat(h, metric)
			}
			continue
		}

		// Started or completed heat: apply or revert race-level RosterDQ while preserving all laps & crossings
		touched := false
		for si := range h.Seats {
			s := &h.Seats[si]
			if s.PilotSlotIndex != slotIndex {
				continue
			}
			if isRosterDQ {
				if s.Status != domain.PilotHeatDQ {
					if !s.StatusOverridden {
						s.PreOverrideStatus = s.Status
						s.StatusOverridden = true
					}
					s.Status = domain.PilotHeatDQ
					s.ManualPosition = 0
					s.RosterDQ = true
					touched = true
				}
			} else if s.RosterDQ && s.Status == domain.PilotHeatDQ {
				restoreSeatFromOverride(h, s, domain.PilotHeatDQ, metric)
				touched = true
			}
		}
		if touched {
			race.RecomputeHeat(h, metric)
		}
	}
}

// applyAttendanceToRaceLocked scratches (`PilotHeatDNS`) or restores (`PilotHeatStaged`) unstarted
// heat seats for `slotIndex` inside `st`.
func applyAttendanceToRaceLocked(st *domain.RaceTournamentState, slotIndex int, available bool) {
	att := domain.AttendanceActive
	if !available {
		att = domain.AttendanceDNC
	}
	applyRosterAttendanceStateLocked(st, slotIndex, true, att)
}

// pauseAllOtherOngoingRacesLocked pauses every ongoing race except `excludeRaceID` (or all ongoing
// races when `excludeRaceID == ""`), returning true if any race was paused.
func (e *Engine) pauseAllOtherOngoingRacesLocked(excludeRaceID string) bool {
	pausedAny := false
	now := nowISO()
	nowUs := e.NowUs()
	if e.raceState.RaceID != "" && (excludeRaceID == "" || e.raceState.RaceID != excludeRaceID) && isRaceOngoing(&e.raceState) {
		e.pauseLiveHeatIfRunningLocked()
		e.raceState.Lifecycle = domain.LifecyclePaused
		if e.raceState.StatusReason == "" {
			e.raceState.StatusReason = "Paused"
		}
		e.syncActiveRaceToEventLocked()
		pausedAny = true
	}
	for i := range e.eventState.Races {
		r := &e.eventState.Races[i]
		if r.RaceID == "" || (excludeRaceID != "" && r.RaceID == excludeRaceID) || !isRaceOngoing(r) {
			continue
		}
		for hi := range r.Heats {
			h := &r.Heats[hi]
			if h.State == domain.HeatCountdown {
				h.State = domain.HeatStaged
				h.CountdownRemainingSec = 0
				h.CountdownEndUs = 0
			} else if h.State == domain.HeatRunning {
				h.State = domain.HeatPaused
				h.PausedAtUs = nowUs
				if h.StartToneUs > 0 && nowUs >= h.StartToneUs {
					h.ElapsedSec = float64(nowUs-h.StartToneUs) / 1e6
				}
			}
		}
		r.Lifecycle = domain.LifecyclePaused
		if r.StatusReason == "" {
			r.StatusReason = "Paused"
		}
		r.UpdatedAt = now
		pausedAny = true
	}
	return pausedAny
}

// EventAction executes a Race CRUD, Race Tags, Per-Race Attendance, or Race Lifecycle action.
func (e *Engine) EventAction(req EventActionPayload) (domain.RaceTournamentState, error) {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()
	e.ensurePracticeStateInitializedLocked()

	var cfgChanged bool
	var practiceChanged bool

	// When preempting an ongoing race to start/resume another race, pause the ongoing race BEFORE
	// `enterTargetRaceLocked` so the target race becomes the active live `e.raceState`.
	if req.PreemptOngoing && req.Action == "race_lifecycle" &&
		(req.LifecycleAction == "start_race" || req.LifecycleAction == "resume_race") {
		targetID := strings.TrimSpace(req.RaceID)
		if targetID == "" {
			targetID = e.editingRaceID
		}
		if targetID == "" {
			targetID = e.raceState.RaceID
		}
		if e.pauseAllOtherOngoingRacesLocked(targetID) {
			cfgChanged = true
		}
	}

	needsTargetSwap := (req.RaceID != "" || e.editingRaceID != "") &&
		(req.Action == "update_attendance" ||
			req.Action == "check_in_all" ||
			req.Action == "add_event_pilot" ||
			req.Action == "add_race_pilot" ||
			req.Action == "race_lifecycle" ||
			req.Action == "stage_control")

	var swap targetRaceSwap
	if needsTargetSwap {
		var swapErr error
		swap, swapErr = e.enterTargetRaceLocked(req.RaceID)
		if swapErr != nil {
			snap := cloneRaceState(e.raceState)
			e.mu.Unlock()
			return snap, swapErr
		}
	}

	var bodyCfgChanged bool
	var bodyPracticeChanged bool
	var ann *domain.RaceAnnouncement
	bodySnap, err := e.eventActionBodyLocked(req, &bodyCfgChanged, &bodyPracticeChanged, &ann)
	if bodyCfgChanged {
		cfgChanged = true
	}
	if bodyPracticeChanged {
		practiceChanged = true
	}
	if err != nil {
		if swap.swapped {
			bodySnap = e.exitTargetRaceLocked(&swap, false)
		}
		e.mu.Unlock()
		return bodySnap, err
	}

	var targetSnap domain.RaceTournamentState
	if swap.swapped {
		targetSnap = e.exitTargetRaceLocked(&swap, true)
	} else {
		e.syncActiveRaceToEventLocked()
		targetSnap = bodySnap
		if targetSnap.RaceID == "" {
			targetSnap = cloneRaceState(e.raceState)
		}
	}

	activeSnap := cloneRaceState(e.raceState)
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
	e.notifyRaceUpdated(activeSnap, ann, subs)
	return targetSnap, nil
}

func (e *Engine) eventActionBodyLocked(
	req EventActionPayload,
	cfgChangedOut *bool,
	practiceChangedOut *bool,
	annOut **domain.RaceAnnouncement,
) (domain.RaceTournamentState, error) {
	now := nowISO()
	cfgChanged := false
	practiceChanged := false
	var ann *domain.RaceAnnouncement

	switch req.Action {
	case "create_race":
		keepExistingActive := (req.DontSelect || isRaceOngoing(&e.raceState)) && e.eventState.ActiveRaceID != "" && e.raceState.RaceID != ""
		if !keepExistingActive {
			e.pauseLiveHeatIfRunningLocked()
		}
		e.syncActiveRaceToEventLocked()

		cfg := domain.DefaultRaceSetupConfig()
		if req.CopyConfig && e.raceState.RaceID != "" {
			cfg = e.raceState.Config.Normalized()
		}
		rName := strings.TrimSpace(req.Name)
		if rName == "" {
			rName = e.nextDefaultRaceNameLocked()
		} else if dup := e.findDuplicateRaceBySlugLocked(rName, ""); dup != nil {
			return cloneRaceState(e.raceState), fmt.Errorf("a race named %q already exists (names must have unique URL slugs)", dup.Config.EventName)
		}
		cfg.EventName = rName

		curMode := e.raceState.Mode
		if curMode != domain.ModeRace {
			curMode = domain.ModePractice
		}

		// A new race starts empty (Generated: false) so the Race Director can pick a Template or build Custom rounds!
		newRace := domain.RaceTournamentState{
			RaceID:           e.nextUniqueIDLocked("race"),
			Tags:             domain.NormalizeRaceTags(req.Tags),
			TemplateID:       "",
			Lifecycle:        domain.LifecycleDraft,
			CreatedAt:        now,
			UpdatedAt:        now,
			Mode:             curMode,
			Config:           cfg,
			TrackInitialized: true,
			TrackSnapshot:    e.defaultNewTrackGatesLocked(),
			Rules:            cloneTimingRulesPtr(nil, domain.DefaultTimingRules()),
			Roster:           buildEventRosterFromPilots(e.pilots),
			Rounds:           []domain.RaceRound{},
			Generated:        false,
			ActiveStageIndex: 1,
			TotalStages:      1,
			Heats:            []domain.RaceHeat{},
			Edges:            []domain.BracketEdge{},
			Standings:        []domain.TournamentStanding{},
		}

		e.eventState.Races = append(e.eventState.Races, cloneRaceState(newRace))
		if !keepExistingActive {
			e.editingRaceID = ""
			e.eventState.ActiveRaceID = newRace.RaceID
			e.raceState = newRace
			if curMode == domain.ModeRace {
				e.disarmAllPilotSlotsForRaceLocked()
				cfgChanged = true
			}
		} else if !req.DontSelect {
			e.editingRaceID = newRace.RaceID
			*cfgChangedOut = cfgChanged
			*practiceChangedOut = practiceChanged
			*annOut = ann
			e.syncActiveRaceToEventLocked()
			return cloneRaceState(newRace), nil
		}

	case "select_race":
		targetID := strings.TrimSpace(req.RaceID)
		if targetID != "" && targetID != e.raceState.RaceID && isRaceOngoing(&e.raceState) {
			e.syncActiveRaceToEventLocked()
			foundIdx := -1
			for i := range e.eventState.Races {
				if e.eventState.Races[i].RaceID == targetID {
					foundIdx = i
					break
				}
			}
			if foundIdx < 0 {
				return cloneRaceState(e.raceState), fmt.Errorf("race %q not found", targetID)
			}
			e.editingRaceID = targetID
			normalizeRaceRosterLocked(&e.eventState.Races[foundIdx], e.pilots)
			race.SyncRoundsMetadata(&e.eventState.Races[foundIdx])
			return cloneRaceState(e.eventState.Races[foundIdx]), nil
		}
		e.editingRaceID = ""
		if !e.loadRaceByIDLocked(targetID) {
			return cloneRaceState(e.raceState), fmt.Errorf("race %q not found", targetID)
		}
		cfgChanged = true

	case "set_race_tags":
		e.syncActiveRaceToEventLocked()
		targetRaceID := strings.TrimSpace(req.RaceID)
		if targetRaceID == "" {
			targetRaceID = e.raceState.RaceID
		}
		normTags := domain.NormalizeRaceTags(req.Tags)
		foundRace := false
		for i := range e.eventState.Races {
			if e.eventState.Races[i].RaceID == targetRaceID {
				e.eventState.Races[i].Tags = append([]string(nil), normTags...)
				e.eventState.Races[i].UpdatedAt = now
				foundRace = true
				break
			}
		}
		if e.raceState.RaceID == targetRaceID {
			e.raceState.Tags = append([]string(nil), normTags...)
			e.raceState.UpdatedAt = now
			foundRace = true
		}
		if !foundRace {
			return cloneRaceState(e.raceState), fmt.Errorf("race not found")
		}

	case "rename_race":
		e.syncActiveRaceToEventLocked()
		targetRaceID := strings.TrimSpace(req.RaceID)
		if targetRaceID == "" {
			targetRaceID = e.raceState.RaceID
		}
		newName := strings.TrimSpace(req.Name)
		if newName == "" {
			return cloneRaceState(e.raceState), fmt.Errorf("race name cannot be empty")
		}
		if dup := e.findDuplicateRaceBySlugLocked(newName, targetRaceID); dup != nil {
			return cloneRaceState(e.raceState), fmt.Errorf("a race named %q already exists (names must have unique URL slugs)", dup.Config.EventName)
		}
		foundRace := false
		for i := range e.eventState.Races {
			if e.eventState.Races[i].RaceID == targetRaceID {
				e.eventState.Races[i].Config.EventName = newName
				e.eventState.Races[i].UpdatedAt = now
				foundRace = true
			}
		}
		if e.raceState.RaceID == targetRaceID {
			e.raceState.Config.EventName = newName
			e.raceState.UpdatedAt = now
			foundRace = true
		}
		if !foundRace {
			return cloneRaceState(e.raceState), fmt.Errorf("race not found")
		}

	case "delete_race":
		e.syncActiveRaceToEventLocked()
		targetID := strings.TrimSpace(req.RaceID)
		idx := -1
		for i := range e.eventState.Races {
			if e.eventState.Races[i].RaceID == targetID {
				idx = i
				break
			}
		}
		if idx < 0 {
			return cloneRaceState(e.raceState), fmt.Errorf("race not found")
		}
		if isRaceOngoing(&e.eventState.Races[idx]) {
			rName := e.eventState.Races[idx].Config.EventName
			if rName == "" {
				rName = e.eventState.Races[idx].RaceID
			}
			return cloneRaceState(e.raceState), fmt.Errorf("cannot delete ongoing race %q — pause or complete it first", rName)
		}
		deletingActive := e.eventState.ActiveRaceID == targetID || e.raceState.RaceID == targetID
		if deletingActive {
			e.pauseLiveHeatIfRunningLocked()
		}
		curMode := e.raceState.Mode
		if curMode != domain.ModeRace {
			curMode = domain.ModePractice
		}
		e.eventState.Races = append(e.eventState.Races[:idx], e.eventState.Races[idx+1:]...)
		if len(e.eventState.Races) == 0 {
			e.eventState.ActiveRaceID = ""
			e.raceState = newEmptyNoRaceState(curMode)
			if curMode == domain.ModeRace {
				e.disarmAllPilotSlotsForRaceLocked()
				cfgChanged = true
			}
		} else if deletingActive {
			e.eventState.ActiveRaceID = e.eventState.Races[0].RaceID
			next := cloneRaceState(e.eventState.Races[0])
			next.Mode = curMode
			e.raceState = next
			if e.raceState.Generated {
				e.resolveActiveTournamentLocked()
			}
			if curMode == domain.ModeRace {
				e.stageOrDisarmActiveRaceLocked()
				cfgChanged = true
			}
		}

	case "update_attendance":
		if e.raceState.RaceID == "" {
			return cloneRaceState(e.raceState), fmt.Errorf("no race selected")
		}
		if req.RaceID != "" && req.RaceID != e.raceState.RaceID {
			if !e.loadRaceByIDLocked(req.RaceID) {
				return cloneRaceState(e.raceState), fmt.Errorf("race %q not found", req.RaceID)
			}
		}
		normalizeRaceRosterLocked(&e.raceState, e.pilots)
		pIdx := -1
		for i := range e.raceState.Roster {
			if e.raceState.Roster[i].SlotIndex == req.SlotIndex {
				pIdx = i
				break
			}
		}
		if pIdx < 0 {
			for _, gp := range e.pilots {
				if gp.SlotIndex == req.SlotIndex {
					e.raceState.Roster = append(e.raceState.Roster, domain.EventPilot{
						SlotIndex:    gp.SlotIndex,
						Callsign:     gp.Callsign,
						PhoneticName: gp.PhoneticName,
						Color:        gp.Color,
						CheckedIn:    true,
						Attendance:   domain.AttendanceActive,
					})
					pIdx = len(e.raceState.Roster) - 1
					break
				}
			}
		}
		if pIdx < 0 {
			return cloneRaceState(e.raceState), fmt.Errorf("pilot %d not found", req.SlotIndex)
		}
		ep := &e.raceState.Roster[pIdx]
		checkedChanged := false
		if req.CheckedIn != nil && *req.CheckedIn != ep.CheckedIn {
			if !*req.CheckedIn && pilotHasCountedHeatInRace(&e.raceState, ep.SlotIndex) {
				return cloneRaceState(e.raceState), fmt.Errorf("%s already has counted heats in this race — mark Away, DQ, or DNC instead of unchecking", ep.Callsign)
			}
			ep.CheckedIn = *req.CheckedIn
			if !ep.CheckedIn {
				ep.Attendance = domain.AttendanceActive
			}
			checkedChanged = true
		}
		if req.Attendance != "" {
			ep.Attendance = domain.NormalizeAttendance(req.Attendance)
		}
		if req.PilotNote != "" || req.CheckedIn == nil {
			ep.Note = strings.TrimSpace(req.PilotNote)
		}

		if checkedChanged && e.raceState.Generated &&
			e.raceState.TemplateID != "custom" &&
			len(e.raceState.Stages) <= 2 &&
			!e.hasAnyCustomizedStageLocked() &&
			e.raceState.Lifecycle == domain.LifecycleDraft &&
			!hasAnyStartedHeatInState(&e.raceState) &&
			!hasAnyManualLocksInState(&e.raceState) {
			e.regenerateTournamentLocked()
			cfgChanged = true
		} else if checkedChanged && e.raceState.Generated && len(e.raceState.Stages) > 2 &&
			e.raceState.Lifecycle == domain.LifecycleDraft && !hasAnyStartedHeatInState(&e.raceState) {
			e.rebuildAllUnstartedNonCustomStagesLocked()
			e.resolveActiveTournamentLocked()
			if e.raceState.Mode == domain.ModeRace {
				e.stageOrDisarmActiveRaceLocked()
				cfgChanged = true
			}
		} else if e.raceState.Generated {
			applyRosterAttendanceStateLocked(&e.raceState, ep.SlotIndex, ep.CheckedIn, ep.Attendance)
			if checkedChanged {
				e.refreshUnstartedPilotsInRoundsLocked()
			}
			e.resolveActiveTournamentLocked()
			e.autoStageOpenQualIfIdleLocked(e.raceState.ActiveStageIndex)
			if e.isLiveRaceHeatActiveLocked() || e.raceState.Mode == domain.ModeRace {
				if ah := e.findHeatLocked(e.raceState.ActiveHeatID); ah != nil && (ah.State == domain.HeatCountdown || ah.State == domain.HeatRunning || ah.State == domain.HeatPaused) {
					e.syncHeatRFSlotsLocked(ah)
				} else {
					e.stageOrDisarmActiveRaceLocked()
				}
				cfgChanged = true
			}
		}

	case "check_in_all":
		if e.raceState.RaceID == "" {
			return cloneRaceState(e.raceState), fmt.Errorf("no race selected")
		}
		normalizeRaceRosterLocked(&e.raceState, e.pilots)
		seen := make(map[int]bool, len(e.raceState.Roster))
		for i := range e.raceState.Roster {
			e.raceState.Roster[i].CheckedIn = true
			e.raceState.Roster[i].Attendance = domain.AttendanceActive
			seen[e.raceState.Roster[i].SlotIndex] = true
			applyAttendanceToRaceLocked(&e.raceState, e.raceState.Roster[i].SlotIndex, true)
		}
		for _, gp := range e.pilots {
			if !seen[gp.SlotIndex] {
				e.raceState.Roster = append(e.raceState.Roster, domain.EventPilot{
					SlotIndex:    gp.SlotIndex,
					Callsign:     gp.Callsign,
					PhoneticName: gp.PhoneticName,
					Color:        gp.Color,
					CheckedIn:    true,
					Attendance:   domain.AttendanceActive,
				})
			}
		}
		if e.raceState.Generated &&
			e.raceState.TemplateID != "custom" &&
			len(e.raceState.Stages) <= 2 &&
			!e.hasAnyCustomizedStageLocked() &&
			e.raceState.Lifecycle == domain.LifecycleDraft &&
			!hasAnyStartedHeatInState(&e.raceState) &&
			!hasAnyManualLocksInState(&e.raceState) {
			e.regenerateTournamentLocked()
		} else if e.raceState.Generated && len(e.raceState.Stages) > 2 &&
			e.raceState.Lifecycle == domain.LifecycleDraft && !hasAnyStartedHeatInState(&e.raceState) {
			e.rebuildAllUnstartedNonCustomStagesLocked()
			e.resolveActiveTournamentLocked()
		} else if e.raceState.Generated {
			e.refreshUnstartedPilotsInRoundsLocked()
			e.resolveActiveTournamentLocked()
		}
		if e.raceState.Mode == domain.ModeRace {
			e.stageOrDisarmActiveRaceLocked()
		}
		cfgChanged = true

	case "add_event_pilot", "add_race_pilot":
		maxSlot := 0
		for _, p := range e.pilots {
			if p.SlotIndex > maxSlot {
				maxSlot = p.SlotIndex
			}
		}
		newSlot := maxSlot + 1
		name := strings.TrimSpace(req.Callsign)
		if name == "" {
			name = e.nextDefaultPilotNameLocked(newSlot)
		} else {
			if e.hasPilotCallsignLocked(name, 0) {
				return cloneRaceState(e.raceState), fmt.Errorf("pilot callsign %q already exists", name)
			}
			for _, rp := range e.raceState.Roster {
				if strings.EqualFold(strings.TrimSpace(rp.Callsign), name) {
					return cloneRaceState(e.raceState), fmt.Errorf("pilot callsign %q already exists", name)
				}
			}
		}
		p := domain.PilotSlot{
			SlotIndex:       newSlot,
			Callsign:        name,
			PhoneticName:    strings.TrimSpace(req.PhoneticName),
			Enabled:         false,
			Band:            domain.BandRaceband,
			EnterThreshold:  -58.0,
			ExitThreshold:   -68.0,
			AttenuationGain: 52,
			Color:           domain.DefaultPilotColors[(newSlot-1)%len(domain.DefaultPilotColors)],
		}
		e.pilots = append(e.pilots, p)
		if e.practiceSnap.Saved {
			e.practiceSnap.Pilots = append(e.practiceSnap.Pilots, p)
		}
		e.initDetectorsLocked()
		e.syncGlobalPilotsToOpenEventsLocked(&p, 0)

		if e.raceState.RaceID != "" {
			foundInRace := false
			for i := range e.raceState.Roster {
				if e.raceState.Roster[i].SlotIndex == p.SlotIndex {
					e.raceState.Roster[i].CheckedIn = true
					e.raceState.Roster[i].Attendance = domain.AttendanceActive
					foundInRace = true
					break
				}
			}
			if !foundInRace {
				e.raceState.Roster = append(e.raceState.Roster, domain.EventPilot{
					SlotIndex:    p.SlotIndex,
					Callsign:     p.Callsign,
					PhoneticName: p.PhoneticName,
					Color:        p.Color,
					CheckedIn:    true,
					Attendance:   domain.AttendanceActive,
				})
			}
			if e.raceState.Generated &&
				e.raceState.TemplateID != "custom" &&
				len(e.raceState.Stages) <= 2 &&
				!e.hasAnyCustomizedStageLocked() &&
				e.raceState.Lifecycle == domain.LifecycleDraft &&
				!hasAnyStartedHeatInState(&e.raceState) &&
				!hasAnyManualLocksInState(&e.raceState) {
				e.regenerateTournamentLocked()
			} else if e.raceState.Generated && len(e.raceState.Stages) > 2 &&
				e.raceState.Lifecycle == domain.LifecycleDraft && !hasAnyStartedHeatInState(&e.raceState) {
				e.rebuildAllUnstartedNonCustomStagesLocked()
				e.resolveActiveTournamentLocked()
			} else if e.raceState.Generated {
				e.refreshUnstartedPilotsInRoundsLocked()
				e.resolveActiveTournamentLocked()
			}
		}
		cfgChanged = true

	case "race_lifecycle":
		targetRaceID := strings.TrimSpace(req.RaceID)
		if targetRaceID != "" && targetRaceID != e.raceState.RaceID {
			if !e.loadRaceByIDLocked(targetRaceID) {
				return cloneRaceState(e.raceState), fmt.Errorf("race %q not found", targetRaceID)
			}
		}
		if e.raceState.RaceID == "" {
			return cloneRaceState(e.raceState), fmt.Errorf("no race selected")
		}
		switch req.LifecycleAction {
		case "emergency_stop":
			e.raceArmed = false
			for hi := range e.raceState.Heats {
				h := &e.raceState.Heats[hi]
				if h.State == domain.HeatCountdown || h.State == domain.HeatRunning || h.State == domain.HeatPaused {
					h.State = domain.HeatAborted
					h.ExecutedAtMs = time.Now().UnixMilli()
					h.InOvertime = false
					h.CountdownRemainingSec = 0
					h.CountdownEndUs = 0
				}
			}
			e.raceState.Lifecycle = domain.LifecyclePaused
			e.raceState.EmergencyStopped = true
			e.raceState.StatusReason = strings.TrimSpace(req.Reason)
			if e.raceState.StatusReason == "" {
				e.raceState.StatusReason = "Emergency stop"
			}
			if e.raceState.Mode == domain.ModeRace {
				e.raceState.Mode = domain.ModePractice
				e.disarmAllPilotSlotsForRaceLocked()
				cfgChanged = true
			} else if e.practiceSnap.Saved && e.exitLiveRaceHeatLocked() {
				cfgChanged = true
			}

		case "pause_race":
			e.pauseLiveHeatIfRunningLocked()
			hadAborted := e.resetAbortedHeatsToStagedLocked()
			for hi := range e.raceState.Heats {
				h := &e.raceState.Heats[hi]
				if h.State == domain.HeatCountdown {
					h.State = domain.HeatStaged
					h.CountdownRemainingSec = 0
					h.CountdownEndUs = 0
				} else if h.State == domain.HeatRunning {
					h.State = domain.HeatPaused
					h.PausedAtUs = e.NowUs()
				}
			}
			e.raceState.EmergencyStopped = false
			e.raceState.Lifecycle = domain.LifecyclePaused
			e.raceState.StatusReason = strings.TrimSpace(req.Reason)
			if e.raceState.StatusReason == "" {
				e.raceState.StatusReason = "Race paused"
			}
			if hadAborted && e.raceState.Generated {
				e.resolveActiveTournamentLocked()
			}
			if e.raceState.Mode == domain.ModeRace {
				e.raceState.Mode = domain.ModePractice
				e.disarmAllPilotSlotsForRaceLocked()
				cfgChanged = true
			} else if e.practiceSnap.Saved && e.exitLiveRaceHeatLocked() {
				cfgChanged = true
			}

		case "start_race", "resume_race":
			isConfigured := e.raceState.Generated || len(e.raceState.Stages) > 0 || len(e.raceState.Rounds) > 0 || len(e.raceState.Heats) > 0
			if !isConfigured {
				return cloneRaceState(e.raceState), fmt.Errorf("configure the race format before starting")
			}
			if other := e.findOtherOngoingRaceLocked(e.raceState.RaceID); other != nil {
				if req.PreemptOngoing {
					if e.pauseAllOtherOngoingRacesLocked(e.raceState.RaceID) {
						cfgChanged = true
					}
				} else {
					verb := "resume"
					if req.LifecycleAction == "start_race" {
						verb = "start"
					}
					return cloneRaceState(e.raceState), fmt.Errorf("cannot %s race %q while race %q is ongoing — pause or complete it first", verb, raceDisplayName(&e.raceState), raceDisplayName(other))
				}
			}
			if e.pauseActivePracticeSessionLocked() {
				practiceChanged = true
				cfgChanged = true
			}
			e.resetAbortedHeatsToStagedLocked()
			e.raceState.EmergencyStopped = false
			e.raceState.Lifecycle = domain.LifecycleActive
			e.raceState.StatusReason = ""
			e.raceState.IsComplete = false
			e.ensureRaceTrackInitializedLocked(&e.raceState)
			e.loadTrackAndRulesIntoLiveEngineLocked(e.raceState.TrackSnapshot, e.raceState.Rules)
			cfgChanged = true
			if e.raceState.Generated {
				e.resolveActiveTournamentLocked()
			}
			if e.raceState.Mode == domain.ModeRace {
				e.stageOrDisarmActiveRaceLocked()
				cfgChanged = true
			}

		case "complete_race":
			e.pauseLiveHeatIfRunningLocked()
			e.ensureRaceTrackInitializedLocked(&e.raceState)
			e.raceState.Lifecycle = domain.LifecycleCompleted
			e.raceState.IsComplete = true
			if strings.TrimSpace(req.Reason) != "" {
				e.raceState.StatusReason = strings.TrimSpace(req.Reason)
			}
			if e.raceState.ChampionSlotIndex == 0 && len(e.raceState.Standings) > 0 {
				e.raceState.ChampionSlotIndex = e.raceState.Standings[0].PilotSlotIndex
				e.raceState.ChampionCallsign = e.raceState.Standings[0].Callsign
			}
			if e.raceState.Mode == domain.ModeRace {
				e.disarmAllPilotSlotsForRaceLocked()
				cfgChanged = true
			} else if e.practiceSnap.Saved && e.exitLiveRaceHeatLocked() {
				cfgChanged = true
			}

		case "scrap_race":
			e.ensureRaceTrackInitializedLocked(&e.raceState)
			if ah := e.findHeatLocked(e.raceState.ActiveHeatID); ah != nil {
				if ah.State == domain.HeatCountdown || ah.State == domain.HeatRunning || ah.State == domain.HeatPaused {
					ah.State = domain.HeatAborted
					ah.InOvertime = false
					ah.CountdownRemainingSec = 0
				}
			}
			e.raceState.Lifecycle = domain.LifecycleScrapped
			e.raceState.StatusReason = strings.TrimSpace(req.Reason)
			if e.raceState.StatusReason == "" {
				e.raceState.StatusReason = "Race scrapped"
			}
			if e.raceState.Mode == domain.ModeRace {
				e.disarmAllPilotSlotsForRaceLocked()
				cfgChanged = true
			} else if e.practiceSnap.Saved && e.exitLiveRaceHeatLocked() {
				cfgChanged = true
			}

		case "reopen_race":
			willBeActive := hasAnyStartedHeatInState(&e.raceState)
			if willBeActive {
				if other := e.findOtherOngoingRaceLocked(e.raceState.RaceID); other != nil {
					if req.PreemptOngoing {
						if e.pauseAllOtherOngoingRacesLocked(e.raceState.RaceID) {
							cfgChanged = true
						}
					} else {
						return cloneRaceState(e.raceState), fmt.Errorf("cannot reopen race %q while race %q is ongoing — pause or complete it first", raceDisplayName(&e.raceState), raceDisplayName(other))
					}
				}
				if e.stopActivePracticeSessionLocked() {
					practiceChanged = true
					cfgChanged = true
				}
			}
			e.resetAbortedHeatsToStagedLocked()
			e.raceState.EmergencyStopped = false
			// Reopen any terminal stages that were paused or closed early.
			for i := range e.raceState.Stages {
				stg := &e.raceState.Stages[i]
				if len(race.OutgoingStageConnections(&e.raceState, stg.Index)) == 0 {
					stg.PausedByUser = false
					if stg.CompletedEarly {
						stg.CompletedEarly = false
						if stg.Index == 1 {
							e.raceState.Stage2SeededEarly = false
						}
					}
				}
			}
			if willBeActive {
				e.raceState.Lifecycle = domain.LifecycleActive
			} else {
				e.raceState.Lifecycle = domain.LifecycleDraft
			}
			e.raceState.StatusReason = ""
			e.raceState.IsComplete = false
			e.raceState.ChampionSlotIndex = 0
			e.raceState.ChampionCallsign = ""
			e.ensureRaceTrackInitializedLocked(&e.raceState)
			if willBeActive {
				e.loadTrackAndRulesIntoLiveEngineLocked(e.raceState.TrackSnapshot, e.raceState.Rules)
				cfgChanged = true
			}
			if e.raceState.Generated {
				e.resolveActiveTournamentLocked()
				// When a tournament finished normally because all deciding heats in its terminal stage(s)
				// were confirmed, ResolveTournament marks the stage and race completed again immediately.
				// Unlock the deciding confirmed heat in each completed terminal stage back to Review
				// (`HeatFinished`) so both the stage and the race reopen for editing, re-running, or re-confirming.
				if e.raceState.IsComplete || e.raceState.Lifecycle == domain.LifecycleCompleted {
					unlockedHeatID := e.unlockTerminalConfirmedHeatsForReopenLocked()
					if unlockedHeatID != "" {
						e.raceState.IsComplete = false
						e.raceState.ChampionSlotIndex = 0
						e.raceState.ChampionCallsign = ""
						e.raceState.Lifecycle = domain.LifecycleActive
						e.resolveActiveTournamentLocked()
						e.raceState.ActiveHeatID = unlockedHeatID
						if uh := e.findHeatLocked(unlockedHeatID); uh != nil && uh.StageIndex >= 1 {
							e.raceState.ActiveStageIndex = uh.StageIndex
						}
					}
				}
			}
			if e.raceState.Mode == domain.ModeRace {
				e.stageOrDisarmActiveRaceLocked()
				cfgChanged = true
			}

		default:
			return cloneRaceState(e.raceState), fmt.Errorf("unknown lifecycle action %q", req.LifecycleAction)
		}

	case "stage_control":
		targetRaceID := strings.TrimSpace(req.RaceID)
		if targetRaceID != "" && targetRaceID != e.raceState.RaceID {
			if !e.loadRaceByIDLocked(targetRaceID) {
				return cloneRaceState(e.raceState), fmt.Errorf("race %q not found", targetRaceID)
			}
		}
		scCfgChanged, err := e.handleStageControlLocked(req)
		if err != nil {
			return cloneRaceState(e.raceState), err
		}
		if scCfgChanged {
			cfgChanged = true
		}

	default:
		return cloneRaceState(e.raceState), fmt.Errorf("unknown event action %q", req.Action)
	}

	*cfgChangedOut = cfgChanged
	*practiceChangedOut = practiceChanged
	*annOut = ann
	e.syncActiveRaceToEventLocked()
	return cloneRaceState(e.raceState), nil
}

// BracketEditAction applies templates, custom round/link operations, regeneration, or seat edits
// on the active Race (or on `req.RaceID` without disturbing an ongoing Race on track).
func (e *Engine) BracketEditAction(req BracketEditPayload) (domain.RaceTournamentState, error) {
	e.mu.Lock()
	e.ensureEventStateInitializedLocked()

	swap, swapErr := e.enterTargetRaceLocked(req.RaceID)
	if swapErr != nil {
		snap := cloneRaceState(e.raceState)
		e.mu.Unlock()
		return snap, swapErr
	}

	var cfgChanged bool
	bodySnap, err := e.bracketEditBodyLocked(req, &cfgChanged)
	if err != nil {
		if swap.swapped {
			bodySnap = e.exitTargetRaceLocked(&swap, false)
		}
		e.mu.Unlock()
		return bodySnap, err
	}

	var targetSnap domain.RaceTournamentState
	if swap.swapped {
		targetSnap = e.exitTargetRaceLocked(&swap, true)
	} else {
		targetSnap = bodySnap
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
	e.notifyRaceUpdated(activeSnap, nil, subs)
	return targetSnap, nil
}

func (e *Engine) bracketEditBodyLocked(req BracketEditPayload, cfgChangedOut *bool) (domain.RaceTournamentState, error) {
	// Ensure a race exists if user applies a template or starts custom directly
	if e.raceState.RaceID == "" {
		e.raceState.RaceID = e.nextUniqueIDLocked("race")
		e.raceState.CreatedAt = nowISO()
		if e.raceState.Config.EventName == "" {
			e.raceState.Config.EventName = "Race 1"
		}
		normalizeRaceRosterLocked(&e.raceState, e.pilots)
		e.syncActiveRaceToEventLocked()
	}

	isLayoutOnlyAction := req.Action == "move_rounds" ||
		req.Action == "move_round" ||
		req.Action == "move_stages" ||
		req.Action == "reset_round_layout" ||
		req.Action == "reset_stage_layout"
	if (e.raceState.Lifecycle == domain.LifecycleCompleted || e.raceState.Lifecycle == domain.LifecycleScrapped) && !isLayoutOnlyAction {
		return cloneRaceState(e.raceState), fmt.Errorf("reopen this race before editing its setup or bracket")
	}

	// Actions that initialize an empty race (`apply_template`, `start_custom`, `add_stage`, `add_round`, `enable_stage2`) work even when `!Generated`
	if !e.raceState.Generated && !isLayoutOnlyAction && req.Action != "apply_template" && req.Action != "start_custom" && req.Action != "add_stage" && req.Action != "add_round" && req.Action != "enable_stage2" {
		return cloneRaceState(e.raceState), fmt.Errorf("choose a template, add a stage, or start a custom race first")
	}

	cfgChanged := false

	switch req.Action {
	case "apply_template":
		if isRaceOngoing(&e.raceState) {
			for _, h := range e.raceState.Heats {
				if h.State == domain.HeatCountdown || h.State == domain.HeatRunning {
					return cloneRaceState(e.raceState), fmt.Errorf("stop or pause the running heat before applying a new template")
				}
			}
		}
		cfg := e.raceState.Config.Normalized()
		if req.PilotsPerHeat >= 2 && req.PilotsPerHeat <= domain.MaxPilotSlots && req.PilotsPerHeat != cfg.PilotsPerHeat {
			cfg.PilotsPerHeat = req.PilotsPerHeat
			cfg.SeatChannels = domain.DefaultSeatChannels(req.PilotsPerHeat)
		}
		if req.TargetLaps >= 1 {
			cfg.TargetLaps = req.TargetLaps
		}
		if req.TimeLimitSec >= 15 {
			cfg.TimeLimitSec = req.TimeLimitSec
			cfg.QualifyingTimeLimitSec = req.TimeLimitSec
		}
		if req.QualifyingRounds >= 1 {
			cfg.QualifyingRounds = req.QualifyingRounds
		}
		if req.QualifyingMetric != "" {
			cfg.QualifyingMetric = req.QualifyingMetric
		}
		if req.QualifyingLineupMode == domain.QualLineupFixed || req.QualifyingLineupMode == domain.QualLineupBalanced {
			cfg.QualifyingLineupMode = req.QualifyingLineupMode
		}
		if req.MaxPacksPerPilot != nil {
			cfg.MaxPacksPerPilot = *req.MaxPacksPerPilot
		} else {
			cfg.MaxPacksPerPilot = 0
		}
		if req.Stage2MaxSeeds != nil {
			cfg.Stage2MaxSeeds = *req.Stage2MaxSeeds
		} else {
			cfg.Stage2MaxSeeds = 0
		}
		if req.PointsRounds >= 1 {
			cfg.PointsRounds = req.PointsRounds
		}
		if req.AceWinsRequired >= 2 {
			cfg.AceWinsRequired = req.AceWinsRequired
		}
		if req.FinalsFormat == domain.FinalsChaseTheAce || req.FinalsFormat == domain.FinalsSingle {
			cfg.FinalsFormat = req.FinalsFormat
		}

		tpl := strings.TrimSpace(req.TemplateID)
		switch tpl {
		case "double_elimination":
			cfg.Structure = domain.StructureSingleStage
			cfg.MainFormat = domain.FormatDoubleElimination
			cfg.Stage2MaxSeeds = 0
		case "qual_double_elim", "qualifying_double_elim":
			tpl = "qual_double_elim"
			cfg.Structure = domain.StructureTwoStage
			cfg.MainFormat = domain.FormatDoubleElimination
		case "single_elimination":
			cfg.Structure = domain.StructureSingleStage
			cfg.MainFormat = domain.FormatSingleElimination
			cfg.Stage2MaxSeeds = 0
		case "qual_single_elim", "qualifying_single_elim", "cpq_single_elim":
			tpl = "qual_single_elim"
			cfg.Structure = domain.StructureTwoStage
			cfg.MainFormat = domain.FormatSingleElimination
			cfg.QualifyingMetric = domain.QualMetricConsecutive3
			cfg.QualifyingTargetLaps = 0
			if req.QualifyingRounds < 1 && cfg.QualifyingRounds < 3 {
				cfg.QualifyingRounds = 3
			}
		case "qual_mains", "qualifying_mains":
			tpl = "qual_mains"
			cfg.Structure = domain.StructureTwoStage
			cfg.MainFormat = domain.FormatPointsMains
		case "cpq_mains":
			tpl = "cpq_mains"
			cfg.Structure = domain.StructureTwoStage
			cfg.MainFormat = domain.FormatPointsMains
			cfg.QualifyingMetric = domain.QualMetricConsecutive3
			cfg.QualifyingTargetLaps = 0
			if req.QualifyingRounds < 1 && cfg.QualifyingRounds < 3 {
				cfg.QualifyingRounds = 3
			}
		case "points_mains":
			cfg.Structure = domain.StructureSingleStage
			cfg.MainFormat = domain.FormatPointsMains
			cfg.Stage2MaxSeeds = 0
		case "chase_the_ace":
			cfg.Structure = domain.StructureSingleStage
			cfg.MainFormat = domain.FormatChaseTheAce
			cfg.Stage2MaxSeeds = 0
		case "qual_chase_the_ace", "qualifying_chase_the_ace":
			tpl = "qual_chase_the_ace"
			cfg.Structure = domain.StructureTwoStage
			cfg.MainFormat = domain.FormatChaseTheAce
			cfg.QualifyingMetric = domain.QualMetricConsecutive3
			cfg.QualifyingTargetLaps = 0
			if req.Stage2MaxSeeds == nil && cfg.Stage2MaxSeeds <= 0 {
				cfg.Stage2MaxSeeds = cfg.PilotsPerHeat
			}
		case "round_robin", "qualifying":
			tpl = "round_robin"
			cfg.Structure = domain.StructureSingleStage
			cfg.MainFormat = domain.FormatQualifying
			cfg.QualifyingTargetLaps = 0
			cfg.Stage2MaxSeeds = 0
		case "cpq_qualifier":
			tpl = "cpq_qualifier"
			cfg.Structure = domain.StructureSingleStage
			cfg.MainFormat = domain.FormatQualifying
			cfg.QualifyingMetric = domain.QualMetricConsecutive3
			cfg.QualifyingTargetLaps = 0
			if req.QualifyingRounds < 1 && cfg.QualifyingRounds < 3 {
				cfg.QualifyingRounds = 3
			}
			cfg.Stage2MaxSeeds = 0
		case "open_qualifier":
			cfg.Structure = domain.StructureSingleStage
			cfg.MainFormat = domain.FormatOpenQualifier
			cfg.QualifyingTargetLaps = 0
			cfg.Stage2MaxSeeds = 0
		case "qual_ladder_mains", "qualifying_ladder_mains":
			tpl = "qual_ladder_mains"
			cfg.Structure = domain.StructureSingleStage
			cfg.MainFormat = domain.FormatSingleElimination
		case "ladder_mains":
			tpl = "ladder_mains"
			cfg.Structure = domain.StructureSingleStage
			cfg.MainFormat = domain.FormatSingleElimination
			cfg.Stage2MaxSeeds = 0
		case "custom":
			cfg.Structure = domain.StructureSingleStage
			cfg.Stage2MaxSeeds = 0
			e.raceState.Config = cfg.Normalized()
			e.raceState.TemplateID = "custom"
			e.raceState.Generated = true
			e.raceState.Lifecycle = domain.LifecycleDraft
			e.raceState.StatusReason = ""
			e.raceState.IsComplete = false
			e.raceState.Stage2SeededEarly = false
			e.raceState.ChampionSlotIndex = 0
			e.raceState.ChampionCallsign = ""
			e.raceState.ActiveStageIndex = 1
			e.raceState.TotalStages = 1
			e.raceState.Stages = []domain.RaceStage{
				{
					ID:         "stage-1",
					Index:      1,
					Title:      "Custom Race",
					Format:     domain.FormatCustom,
					Customized: true,
					Status:     domain.StageStatusActive,
					Settings:   domain.DefaultStageSettingsFromConfig(e.raceState.Config, domain.FormatCustom),
					HasPos:     true,
					PosX:       120,
					PosY:       180,
				},
			}
			e.raceState.StageConnections = nil
			e.raceState.FormatInvalidReason = ""
			e.raceState.Heats = []domain.RaceHeat{}
			e.raceState.Edges = []domain.BracketEdge{}
			e.raceState.Rounds = []domain.RaceRound{}
			e.raceState.Connections = []domain.RoundConnection{}
			e.raceState.ActiveHeatID = ""
			e.raceState.NextReadyHeatID = ""
			if lm := strings.TrimSpace(req.LinkMode); lm != "" && lm != "none" {
				_ = e.appendCustomRoundLocked(1, "Round 1", "winners", domain.FormatSingleElimination, req.HeatCount, e.raceState.Config.TargetLaps, e.raceState.Config.TimeLimitSec, lm, "", 0, "", 2)
			} else {
				race.SyncRoundsMetadata(&e.raceState)
			}
			cfgChanged = true
			e.resolveActiveTournamentLocked()
			if e.raceState.Mode == domain.ModeRace {
				e.stageOrDisarmActiveRaceLocked()
			}
			*cfgChangedOut = cfgChanged
			return cloneRaceState(e.raceState), nil
		default:
			return cloneRaceState(e.raceState), fmt.Errorf("unknown template %q", tpl)
		}
		e.raceState.Config = cfg.Normalized()
		e.raceState.TemplateID = tpl
		isMultiPhaseQualTpl := tpl == "qual_double_elim" || tpl == "qual_single_elim" || tpl == "qual_mains" ||
			tpl == "cpq_mains" || tpl == "qual_chase_the_ace" || tpl == "qual_ladder_mains"
		hasStartedQual := false
		hasStartedNonQual := false
		for _, h := range e.raceState.Heats {
			if !isUnstartedHeatState(h.State) {
				if h.StageFormat == domain.FormatQualifying {
					hasStartedQual = true
				} else {
					hasStartedNonQual = true
				}
			}
		}
		if isMultiPhaseQualTpl && hasStartedQual && !hasStartedNonQual {
			e.retemplatePostQualifyingOnUnifiedGraphLocked(tpl)
		} else {
			e.raceState.Stage2SeededEarly = false
			e.raceState.Stages = nil
			e.raceState.StageConnections = nil
			e.regenerateTournamentLocked()
		}
		cfgChanged = true

	case "start_custom":
		for _, h := range e.raceState.Heats {
			if h.State == domain.HeatCountdown || h.State == domain.HeatRunning {
				return cloneRaceState(e.raceState), fmt.Errorf("stop the running heat before resetting to custom")
			}
		}
		cfg := e.raceState.Config.Normalized()
		if req.PilotsPerHeat >= 2 && req.PilotsPerHeat <= domain.MaxPilotSlots && req.PilotsPerHeat != cfg.PilotsPerHeat {
			cfg.PilotsPerHeat = req.PilotsPerHeat
			cfg.SeatChannels = domain.DefaultSeatChannels(req.PilotsPerHeat)
		}
		if req.TargetLaps >= 1 {
			cfg.TargetLaps = req.TargetLaps
		}
		if req.TimeLimitSec >= 15 {
			cfg.TimeLimitSec = req.TimeLimitSec
		}
		cfg.Structure = domain.StructureSingleStage
		cfg.Stage2MaxSeeds = 0
		e.raceState.Config = cfg.Normalized()
		e.raceState.TemplateID = "custom"
		e.raceState.Generated = true
		e.raceState.Lifecycle = domain.LifecycleDraft
		e.raceState.StatusReason = ""
		e.raceState.IsComplete = false
		e.raceState.Stage2SeededEarly = false
		e.raceState.ChampionSlotIndex = 0
		e.raceState.ChampionCallsign = ""
		e.raceState.ActiveStageIndex = 1
		e.raceState.TotalStages = 1
		e.raceState.Stages = []domain.RaceStage{
			{
				ID:         "stage-1",
				Index:      1,
				Title:      "Custom Stage 1",
				Format:     domain.FormatCustom,
				Customized: true,
				Status:     domain.StageStatusActive,
				Settings:   domain.DefaultStageSettingsFromConfig(e.raceState.Config, domain.FormatCustom),
				HasPos:     true,
				PosX:       120,
				PosY:       180,
			},
		}
		e.raceState.StageConnections = nil
		e.raceState.FormatInvalidReason = ""
		e.raceState.Heats = []domain.RaceHeat{}
		e.raceState.Edges = []domain.BracketEdge{}
		e.raceState.Rounds = []domain.RaceRound{}
		e.raceState.Connections = []domain.RoundConnection{}
		e.raceState.ActiveHeatID = ""
		e.raceState.NextReadyHeatID = ""

		linkMode := strings.TrimSpace(req.LinkMode)
		if linkMode == "" {
			linkMode = "all_active_pilots"
		}
		if linkMode != "none" {
			_ = e.appendCustomRoundLocked(1, "Round 1", "winners", domain.FormatSingleElimination, req.HeatCount, cfg.TargetLaps, cfg.TimeLimitSec, linkMode, "", 0, "", 2)
		} else {
			race.SyncRoundsMetadata(&e.raceState)
		}
		cfgChanged = true

	case "add_stage":
		if err := e.addStageLocked(req); err != nil {
			return cloneRaceState(e.raceState), err
		}
		cfgChanged = true

	case "remove_stage":
		if err := e.removeStageLocked(req.StageID, req.StageIndex); err != nil {
			return cloneRaceState(e.raceState), err
		}
		cfgChanged = true

	case "rename_stage":
		if err := e.renameStageLocked(req.StageID, req.StageIndex, req.Title); err != nil {
			return cloneRaceState(e.raceState), err
		}
		cfgChanged = true

	case "update_stage_settings":
		if err := e.updateStageSettingsLocked(req); err != nil {
			return cloneRaceState(e.raceState), err
		}
		cfgChanged = true

	case "add_qualifying_round":
		race.EnsureStagesMetadata(&e.raceState)
		race.SyncRoundsMetadata(&e.raceState)
		if len(req.Positions) > 0 {
			e.applyRoundPositionsLocked(req.Positions)
		}
		stageIdx := req.StageIndex
		if stageIdx <= 0 {
			stageIdx = 1
			for _, r := range e.raceState.Rounds {
				if r.StageFormat == domain.FormatQualifying && !domain.IsStagePortalRoundID(r.ID) && !domain.IsOpenQualRoundID(r.ID) {
					stageIdx = r.StageIndex
					break
				}
			}
		}
		stg := e.findStageByIndexLocked(stageIdx)
		if stg == nil {
			return cloneRaceState(e.raceState), fmt.Errorf("qualifying stage not found")
		}
		for _, h := range e.raceState.Heats {
			if !isUnstartedHeatState(h.State) && h.Note != "Auto-advance (bye)" {
				if h.StageIndex > stageIdx || (h.StageIndex == stageIdx && h.StageFormat != domain.FormatQualifying && h.StageFormat != domain.FormatOpenQualifier) {
					return cloneRaceState(e.raceState), fmt.Errorf("cannot add another qualifying round because %s has already started", h.ShortLabel)
				}
			}
		}
		curQualCount := 0
		for _, r := range e.raceState.Rounds {
			if r.StageIndex == stageIdx && r.StageFormat == domain.FormatQualifying && !domain.IsStagePortalRoundID(r.ID) && !domain.IsOpenQualRoundID(r.ID) {
				curQualCount++
			}
		}
		if curQualCount >= 20 {
			return cloneRaceState(e.raceState), fmt.Errorf("maximum of 20 qualifying rounds reached")
		}
		nextRounds := curQualCount + 1
		if nextRounds < 1 {
			nextRounds = 1
		}
		stg.Settings.QualifyingRounds = nextRounds
		if req.QualifyingLineupMode == domain.QualLineupFixed || req.QualifyingLineupMode == domain.QualLineupBalanced {
			stg.Settings.QualifyingLineupMode = req.QualifyingLineupMode
		}
		if len(e.raceState.Stages) == 1 && stageIdx == 1 {
			e.raceState.Config.QualifyingRounds = nextRounds
			if req.QualifyingLineupMode == domain.QualLineupFixed || req.QualifyingLineupMode == domain.QualLineupBalanced {
				e.raceState.Config.QualifyingLineupMode = req.QualifyingLineupMode
			}
		}
		e.raceState.Stage2SeededEarly = false
		stg.CompletedEarly = false
		if stg.Status == domain.StageStatusCompleted {
			stg.Status = domain.StageStatusActive
		}
		for ci := range e.raceState.Connections {
			if e.raceState.Connections[ci].StageIndex == stageIdx {
				e.raceState.Connections[ci].SeededEarly = false
			}
		}
		if e.raceState.IsComplete || e.raceState.Lifecycle == domain.LifecycleCompleted {
			e.raceState.IsComplete = false
			e.raceState.Lifecycle = domain.LifecycleActive
			e.raceState.ChampionSlotIndex = 0
			e.raceState.ChampionCallsign = ""
		}
		e.reconcileQualifyingStageLocked(stageIdx)
		e.resolveActiveTournamentLocked()
		if e.raceState.ActiveHeatID == "" && e.raceState.NextReadyHeatID != "" {
			e.raceState.ActiveHeatID = e.raceState.NextReadyHeatID
		} else if cur := e.findHeatLocked(e.raceState.ActiveHeatID); cur != nil && cur.State == domain.HeatConfirmed && e.raceState.NextReadyHeatID != "" {
			e.raceState.ActiveHeatID = e.raceState.NextReadyHeatID
		}
		cfgChanged = true

	case "set_finals_structure":
		race.EnsureStagesMetadata(&e.raceState)
		race.SyncRoundsMetadata(&e.raceState)
		for _, h := range e.raceState.Heats {
			if h.State == domain.HeatCountdown || h.State == domain.HeatRunning {
				return cloneRaceState(e.raceState), fmt.Errorf("stop or pause the running heat before changing Finals structure")
			}
			if !isUnstartedHeatState(h.State) && h.Note != "Auto-advance (bye)" && h.StageFormat != domain.FormatQualifying && h.StageFormat != domain.FormatOpenQualifier {
				return cloneRaceState(e.raceState), fmt.Errorf("cannot change Finals structure after %s has already started", h.ShortLabel)
			}
		}
		tpl := strings.TrimSpace(req.TemplateID)
		cfg := e.raceState.Config.Normalized()
		if req.FinalsFormat == domain.FinalsChaseTheAce || req.FinalsFormat == domain.FinalsSingle {
			cfg.FinalsFormat = req.FinalsFormat
		}
		if req.AceWinsRequired >= 2 && req.AceWinsRequired <= 5 {
			cfg.AceWinsRequired = req.AceWinsRequired
		}
		switch tpl {
		case "qual_ladder_mains":
			cfg.Structure = domain.StructureSingleStage
			cfg.MainFormat = domain.FormatSingleElimination
			cfg.Stage2MaxSeeds = 0
		case "qual_mains":
			cfg.Structure = domain.StructureTwoStage
			cfg.MainFormat = domain.FormatPointsMains
			cfg.Stage2MaxSeeds = 0
			if req.PointsRounds >= 1 {
				cfg.PointsRounds = req.PointsRounds
			} else if cfg.PointsRounds < 1 {
				cfg.PointsRounds = 1
			}
		case "qual_chase_the_ace":
			cfg.Structure = domain.StructureTwoStage
			cfg.MainFormat = domain.FormatChaseTheAce
			cfg.FinalsFormat = domain.FinalsChaseTheAce
			if req.Stage2MaxSeeds != nil && *req.Stage2MaxSeeds >= 2 {
				cfg.Stage2MaxSeeds = *req.Stage2MaxSeeds
			} else {
				cfg.Stage2MaxSeeds = cfg.PilotsPerHeat
			}
		default:
			return cloneRaceState(e.raceState), fmt.Errorf("unsupported finals structure %q", tpl)
		}
		e.raceState.Config = cfg.Normalized()
		e.raceState.TemplateID = tpl
		hasQualRound := false
		for _, r := range e.raceState.Rounds {
			if r.StageFormat == domain.FormatQualifying && !domain.IsStagePortalRoundID(r.ID) {
				hasQualRound = true
				break
			}
		}
		if hasQualRound {
			e.retemplatePostQualifyingOnUnifiedGraphLocked(tpl)
		} else {
			e.raceState.Stage2SeededEarly = false
			e.raceState.Stages = nil
			e.raceState.StageConnections = nil
			e.regenerateTournamentLocked()
		}
		cfgChanged = true

	case "move_stages":
		e.moveStagesLocked(req)

	case "reset_stage_layout":
		e.autoLayoutStagesLocked()

	case "connect_stages":
		e.moveStagesLocked(req)
		fromID := strings.TrimSpace(req.FromStageID)
		if fromID == "" && req.FromStageIndex >= 1 {
			if fs := e.findStageByIndexLocked(req.FromStageIndex); fs != nil {
				fromID = fs.ID
			}
		}
		toID := strings.TrimSpace(req.ToStageID)
		if toID == "" && req.ToStageIndex >= 1 {
			if ts := e.findStageByIndexLocked(req.ToStageIndex); ts != nil {
				toID = ts.ID
			}
		}
		if err := e.connectStagesLocked(
			fromID,
			toID,
			strings.TrimSpace(req.LinkMode),
			req.AdvanceCount,
			req.SeedStart,
			req.SeedEnd,
			req.QualifyingMetric,
			req.FromPort,
			req.ToPort,
		); err != nil {
			return cloneRaceState(e.raceState), err
		}
		cfgChanged = true

	case "update_stage_connection":
		if err := e.updateStageConnectionLocked(req); err != nil {
			return cloneRaceState(e.raceState), err
		}
		cfgChanged = true

	case "reconnect_stage_connection":
		e.moveStagesLocked(req)
		if err := e.reconnectStageConnectionLocked(req); err != nil {
			return cloneRaceState(e.raceState), err
		}
		cfgChanged = true

	case "disconnect_stages":
		e.moveStagesLocked(req)
		if err := e.disconnectStagesLocked(
			strings.TrimSpace(req.ConnectionID),
			strings.TrimSpace(req.FromStageID),
			strings.TrimSpace(req.ToStageID),
		); err != nil {
			return cloneRaceState(e.raceState), err
		}
		cfgChanged = true

	case "enable_stage2":
		if e.raceState.TotalStages < 2 {
			e.raceState.Generated = true
			e.raceState.TemplateID = "custom"
			e.raceState.IsComplete = false
			e.raceState.Stage2SeededEarly = false
			e.raceState.Config.Structure = domain.StructureTwoStage
			e.raceState.TotalStages = 2
			e.raceState.Stages = nil
			e.raceState.StageConnections = nil
			if e.raceState.ActiveStageIndex < 1 {
				e.raceState.ActiveStageIndex = 1
			}
			race.SyncRoundsMetadata(&e.raceState)
			hasStage1RealRound := false
			for _, r := range e.raceState.Rounds {
				if r.StageIndex == 1 && r.ID != domain.Stage1HandoffOutID {
					hasStage1RealRound = true
					break
				}
			}
			if !hasStage1RealRound {
				cfg := e.raceState.Config.Normalized()
				_ = e.appendCustomRoundLocked(1, "Qualifying R1", "qualifying", domain.FormatQualifying, 0, cfg.QualifyingTargetLaps, cfg.QualifyingTimeLimitSec, "all_active_pilots", "", 0, "", 0)
			}
			race.SyncRoundsMetadata(&e.raceState)
			// Connect existing Stage 1 rounds into Stage 2 Seeding if not already connected
			alreadyFed := make(map[string]bool)
			for _, c := range e.raceState.Connections {
				if c.ToRoundID == domain.Stage1HandoffOutID {
					alreadyFed[c.FromRoundID] = true
				}
			}
			for _, r := range e.raceState.Rounds {
				if r.StageIndex == 1 && r.ID != domain.Stage1HandoffOutID && !alreadyFed[r.ID] {
					_ = e.connectRoundsLocked(r.ID, domain.Stage1HandoffOutID, "qual_feed", 0, 0, 0, "")
				}
			}
			// Create initial Stage 2 round fed by Qualifying Seeds if Stage 2 has no real rounds yet
			hasStage2RealRound := false
			for _, r := range e.raceState.Rounds {
				if r.StageIndex == 2 && r.ID != domain.Stage2HandoffInID {
					hasStage2RealRound = true
					break
				}
			}
			if !hasStage2RealRound {
				cfg := e.raceState.Config.Normalized()
				s2Rnd := e.appendCustomRoundLocked(2, "Winners R1", "winners", domain.FormatSingleElimination, 1, cfg.TargetLaps, cfg.TimeLimitSec, "empty", "", 0, "", 2)
				_ = e.connectRoundsLocked(domain.Stage2HandoffInID, s2Rnd, "stage_seeds", 0, 1, e.raceState.Config.Stage2MaxSeeds, "snake")
			}
			cfgChanged = true
		}

	case "remove_stage2":
		if e.raceState.TotalStages >= 2 {
			if race.AnyRealHeatStartedInStage(&e.raceState, 2) {
				return cloneRaceState(e.raceState), fmt.Errorf("cannot remove Stage 2 after Stage 2 heats have started")
			}
			keptHeats := make([]domain.RaceHeat, 0, len(e.raceState.Heats))
			for _, h := range e.raceState.Heats {
				if h.StageIndex != 2 {
					keptHeats = append(keptHeats, h)
				} else if h.ID == e.raceState.ActiveHeatID {
					e.raceState.ActiveHeatID = ""
				}
			}
			e.raceState.Heats = keptHeats

			keptRounds := make([]domain.RaceRound, 0, len(e.raceState.Rounds))
			for _, r := range e.raceState.Rounds {
				if r.StageIndex != 2 && r.ID != domain.Stage1HandoffOutID && r.ID != domain.Stage2HandoffInID {
					keptRounds = append(keptRounds, r)
				}
			}
			e.raceState.Rounds = keptRounds

			keptConns := make([]domain.RoundConnection, 0, len(e.raceState.Connections))
			for _, c := range e.raceState.Connections {
				if c.StageIndex != 2 && c.ToRoundID != domain.Stage1HandoffOutID && c.FromRoundID != domain.Stage2HandoffInID {
					keptConns = append(keptConns, c)
				}
			}
			e.raceState.Connections = keptConns
			e.raceState.Stages = nil
			e.raceState.StageConnections = nil
			e.raceState.TotalStages = 1
			e.raceState.ActiveStageIndex = 1
			e.raceState.Stage2SeededEarly = false
			e.raceState.Config.Structure = domain.StructureSingleStage
			e.raceState.Config.Stage2MaxSeeds = 0
			e.raceState.TemplateID = "custom"
			race.RebuildEdgesFromFeeders(&e.raceState)
			race.SyncRoundsMetadata(&e.raceState)
			cfgChanged = true
		}

	case "update_stage_handoff":
		prevMaxSeeds := e.raceState.Config.Stage2MaxSeeds
		metricChanged := false
		if req.QualifyingMetric != "" && req.QualifyingMetric != e.raceState.Config.QualifyingMetric {
			e.raceState.Config.QualifyingMetric = req.QualifyingMetric
			metricChanged = true
		}
		if req.Stage2MaxSeeds != nil {
			e.raceState.Config.Stage2MaxSeeds = *req.Stage2MaxSeeds
		}
		e.raceState.Config = e.raceState.Config.Normalized()
		if len(e.raceState.Stages) == 2 && len(e.raceState.StageConnections) == 1 {
			sc := &e.raceState.StageConnections[0]
			sc.RankingMetric = e.raceState.Config.QualifyingMetric
			if e.raceState.Config.Stage2MaxSeeds > 0 {
				sc.Mode = "top_n"
				sc.Count = e.raceState.Config.Stage2MaxSeeds
			} else {
				sc.Mode = "all"
				sc.Count = 0
			}
		}
		if metricChanged {
			if stg1 := e.findStageByIndexLocked(1); stg1 != nil {
				stg1.Settings.QualifyingMetric = e.raceState.Config.QualifyingMetric
			}
			for i := range e.raceState.Heats {
				if e.raceState.Heats[i].StageIndex == 1 {
					race.RecomputeHeat(&e.raceState.Heats[i], e.raceState.Config.QualifyingMetric)
				}
			}
		}
		if e.raceState.TotalStages == 2 && !race.AnyRealHeatStartedInStage(&e.raceState, 2) {
			if e.raceState.TemplateID != "" && e.raceState.TemplateID != "custom" {
				var s1Heats []domain.RaceHeat
				for _, h := range e.raceState.Heats {
					if h.StageIndex == 1 {
						s1Heats = append(s1Heats, h)
					} else if h.ID == e.raceState.ActiveHeatID {
						e.raceState.ActiveHeatID = ""
					}
				}
				var keptRounds []domain.RaceRound
				for _, r := range e.raceState.Rounds {
					if r.StageIndex == 1 || r.ID == domain.Stage2HandoffInID {
						keptRounds = append(keptRounds, r)
					}
				}
				var keptConns []domain.RoundConnection
				for _, c := range e.raceState.Connections {
					if c.StageIndex == 1 {
						keptConns = append(keptConns, c)
					}
				}
				pilots := e.activeEventPilotsForGenerationLocked()
				seedCount := len(pilots)
				if seedCount < 2 {
					seedCount = len(e.raceState.Roster)
				}
				s2Heats, _ := race.GenerateStage2PlaceholderMainStage(e.raceState.Config, seedCount, len(s1Heats))
				e.raceState.Heats = append(s1Heats, s2Heats...)
				e.raceState.Rounds = keptRounds
				e.raceState.Connections = keptConns
				race.RebuildEdgesFromFeeders(&e.raceState)
				race.SyncRoundsMetadata(&e.raceState)
			} else {
				// Custom Stage 2 graph: update non-sliced stage_seeds connections and rebuild Stage 2 rounds
				seedWireCount := 0
				for _, c := range e.raceState.Connections {
					if c.FromRoundID == domain.Stage2HandoffInID && c.Mode == "stage_seeds" {
						seedWireCount++
					}
				}
				if req.Stage2MaxSeeds != nil {
					for i := range e.raceState.Connections {
						c := &e.raceState.Connections[i]
						if c.FromRoundID == domain.Stage2HandoffInID && c.Mode == "stage_seeds" {
							if c.SeedStart <= 1 && (seedWireCount == 1 || c.SeedEnd == 0 || c.SeedEnd == prevMaxSeeds) {
								c.SeedEnd = e.raceState.Config.Stage2MaxSeeds
							}
						}
					}
				}
				e.recomputeGraphAndRebuildLocked(2, domain.Stage2HandoffInID)
			}
		}
		cfgChanged = true

	case "seed_connection_now":
		if err := e.seedConnectionNowLocked(strings.TrimSpace(req.ConnectionID), strings.TrimSpace(req.FromRoundID), strings.TrimSpace(req.RoundID)); err != nil {
			return cloneRaceState(e.raceState), err
		}
		cfgChanged = true

	case "reopen_connection_seed":
		if err := e.reopenConnectionSeedLocked(strings.TrimSpace(req.ConnectionID), strings.TrimSpace(req.FromRoundID), strings.TrimSpace(req.RoundID)); err != nil {
			return cloneRaceState(e.raceState), err
		}
		cfgChanged = true

	case "reshuffle_round":
		if err := e.reshuffleRoundLocked(strings.TrimSpace(req.RoundID), strings.TrimSpace(req.Distribution)); err != nil {
			return cloneRaceState(e.raceState), err
		}
		cfgChanged = true

	case "seed_stage2_early":
		if e.raceState.TotalStages < 2 {
			if err := e.seedConnectionNowLocked(strings.TrimSpace(req.ConnectionID), strings.TrimSpace(req.FromRoundID), strings.TrimSpace(req.RoundID)); err != nil {
				return cloneRaceState(e.raceState), err
			}
			cfgChanged = true
			break
		}
		hasConfirmedS1 := false
		for _, h := range e.raceState.Heats {
			if h.StageIndex == 1 && h.State == domain.HeatConfirmed {
				hasConfirmedS1 = true
				break
			}
		}
		if !hasConfirmedS1 {
			return cloneRaceState(e.raceState), fmt.Errorf("confirm at least one Qualifying heat before seeding early")
		}
		e.raceState.Stage2SeededEarly = true
		if stg1 := e.findStageByIndexLocked(1); stg1 != nil {
			stg1.CompletedEarly = true
		}
		cfgChanged = true

	case "unlock_stage2_seeding":
		if e.raceState.TotalStages < 2 {
			if err := e.reopenConnectionSeedLocked(strings.TrimSpace(req.ConnectionID), strings.TrimSpace(req.FromRoundID), strings.TrimSpace(req.RoundID)); err != nil {
				return cloneRaceState(e.raceState), err
			}
			cfgChanged = true
			break
		}
		if race.AnyRealHeatStartedInStage(&e.raceState, 2) {
			return cloneRaceState(e.raceState), fmt.Errorf("cannot unlock seeding after a downstream heat has started")
		}
		e.raceState.Stage2SeededEarly = false
		if stg1 := e.findStageByIndexLocked(1); stg1 != nil {
			stg1.CompletedEarly = false
		}
		cfgChanged = true

	case "assign_seat_stage_seed":
		if req.FromStageSeed < 1 || req.FromStageSeed > 64 {
			return cloneRaceState(e.raceState), fmt.Errorf("invalid Qualifying seed #%d", req.FromStageSeed)
		}
		h := e.findHeatLocked(req.HeatID)
		if h == nil || !isUnstartedHeatState(h.State) {
			return cloneRaceState(e.raceState), fmt.Errorf("only unstarted heats can have seed placeholders assigned")
		}
		sIdx := findSeatIndex(h, req.SeatIndex)
		if sIdx < 0 {
			return cloneRaceState(e.raceState), fmt.Errorf("seat not found")
		}
		s := &h.Seats[sIdx]
		s.ManualLock = false
		clearSeatOccupant(s, false)
		s.Feeder = &domain.SeatFeeder{FromStageSeed: req.FromStageSeed}
		s.SourceLabel = fmt.Sprintf("Seed #%d", req.FromStageSeed)
		h.State = domain.HeatWaiting
		race.RebuildEdgesFromFeeders(&e.raceState)
		finalizeEditedHeatState(h, e.raceState.Config.QualifyingMetric)
		e.cascadeBalancedRoundsFromLocked(h.StageIndex, h.RoundID)
		cfgChanged = true

	case "add_round":
		race.SyncRoundsMetadata(&e.raceState)
		if len(req.Positions) > 0 {
			e.applyRoundPositionsLocked(req.Positions)
		}
		e.raceState.TemplateID = "custom"
		e.raceState.Generated = true
		e.raceState.IsComplete = false
		if e.raceState.TotalStages < 1 {
			e.raceState.TotalStages = 1
			e.raceState.ActiveStageIndex = 1
		}
		targetStage := req.StageIndex
		if targetStage < 1 || targetStage > domain.MaxRaceStages {
			targetStage = e.raceState.ActiveStageIndex
		}
		if targetStage < 1 {
			targetStage = 1
		}
		if targetStage == 2 && e.raceState.TotalStages < 2 && len(e.raceState.Stages) < 2 {
			e.raceState.TotalStages = 2
			e.raceState.Config.Structure = domain.StructureTwoStage
			e.raceState.Stages = nil
			race.SyncRoundsMetadata(&e.raceState)
		}
		e.markStageCustomizedLocked(targetStage)
		stgSettings := e.stageSettingsLocked(targetStage)
		stgPtr := e.findStageByIndexLocked(targetStage)
		lane := strings.TrimSpace(req.BracketLane)
		if lane == "" {
			if (stgPtr != nil && stgPtr.Format == domain.FormatQualifying) || (stgPtr == nil && targetStage == 1 && e.raceState.TotalStages == 2) {
				lane = "qualifying"
			} else {
				lane = "winners"
			}
		}
		fmtType := req.StageFormat
		if fmtType == "" || fmtType == domain.FormatCustom {
			if lane == "qualifying" {
				fmtType = domain.FormatQualifying
			} else if lane == "finals" && req.FinalsFormat == domain.FinalsChaseTheAce {
				fmtType = domain.FormatChaseTheAce
			} else {
				fmtType = domain.FormatSingleElimination
			}
		}
		laps := req.TargetLaps
		if laps <= 0 && fmtType != domain.FormatQualifying {
			laps = stgSettings.TargetLaps
			if laps <= 0 {
				laps = e.raceState.Config.TargetLaps
			}
		}
		tLimit := req.TimeLimitSec
		if tLimit < 15 {
			tLimit = stgSettings.TimeLimitSec
			if tLimit < 15 {
				tLimit = e.raceState.Config.TimeLimitSec
			}
		}
		explicitLinkMode := strings.TrimSpace(req.LinkMode)
		explicitFromRndID := strings.TrimSpace(req.FromRoundID)
		linkMode := explicitLinkMode
		fromRndID := explicitFromRndID
		stageRoundCount := 0
		for _, r := range e.raceState.Rounds {
			if r.StageIndex == targetStage && !domain.IsStagePortalRoundID(r.ID) {
				stageRoundCount++
			}
		}
		reqTitle := strings.TrimSpace(req.Title)
		isZippyReq := strings.Contains(strings.ToLower(reqTitle), "zippyq")
		if fmtType == domain.FormatOpenQualifier && stgPtr != nil && (stageRoundCount == 0 || (!isZippyReq && stageRoundCount == 1 && stgPtr.Format == domain.FormatOpenQualifier)) {
			stgPtr.Format = domain.FormatOpenQualifier
			stgPtr.Customized = false
			if isZippyReq {
				stgPtr.Title = "ZippyQ Qualifier"
			} else if reqTitle != "" {
				stgPtr.Title = reqTitle
			} else if strings.TrimSpace(stgPtr.Title) == "" || strings.HasPrefix(stgPtr.Title, "Custom") || strings.HasPrefix(stgPtr.Title, "Stage ") {
				stgPtr.Title = race.DefaultStageTitle(domain.FormatOpenQualifier, targetStage)
			}
			cfg := e.raceState.Config.Normalized()
			stgPtr.Settings = domain.DefaultStageSettingsFromConfig(cfg, domain.FormatOpenQualifier)
			oqID := domain.OpenQualRoundID(targetStage)
			rndTitle := "Open Qualifier"
			if isZippyReq {
				rndTitle = "ZippyQ Round 1"
			}
			if r := e.findRoundByIDLocked(oqID); r != nil {
				r.Title = rndTitle
			}
			e.rebuildSingleStageLocked(targetStage)
			if r := e.findRoundByIDLocked(oqID); r != nil {
				r.Title = rndTitle
				if req.HasPos {
					r.HasPos = true
					r.PosX = req.PosX
					r.PosY = req.PosY
				}
			}
			cfgChanged = true
			break
		}
		if fmtType == domain.FormatOpenQualifier && isZippyReq {
			zqCount := 0
			for _, r := range e.raceState.Rounds {
				if r.StageIndex == targetStage && !domain.IsStagePortalRoundID(r.ID) &&
					(r.StageFormat == domain.FormatOpenQualifier || strings.Contains(strings.ToLower(r.Title), "zippyq")) {
					zqCount++
				}
			}
			req.Title = fmt.Sprintf("ZippyQ Round %d", zqCount+1)
			lane = "qualifying"
		}
		inPortalID := domain.StageHandoffInID(targetStage)
		if explicitFromRndID != "" {
			// Wire-drop spawn: create the round cleanly first, then wire via `connectRoundsLockedWithPorts`
			// so port sides (`FromPort`, `ToPort`), `Checked-In Pilots`, `Incoming Stage Seeds`, and smart
			// link-mode inference all run identically to connecting onto an existing round.
			linkMode = "empty"
			fromRndID = ""
		} else if linkMode == "" {
			if stageRoundCount == 0 && lane != "finals" {
				if e.findRoundByIDLocked(inPortalID) != nil {
					linkMode = "stage_seeds"
					fromRndID = inPortalID
				} else {
					linkMode = "all_active_pilots"
				}
			} else {
				linkMode = "empty"
			}
		}
		hcReq := req.HeatCount
		if lane == "finals" {
			fFmt := req.FinalsFormat
			if fFmt == "" {
				if fmtType == domain.FormatChaseTheAce {
					fFmt = domain.FinalsChaseTheAce
				} else {
					fFmt = domain.FinalsSingle
				}
			}
			if fFmt == domain.FinalsPoints {
				hcReq = req.FinalsHeats
				if hcReq < 2 {
					hcReq = 3
				}
			} else {
				hcReq = 1
			}
		}
		newRndID := e.appendCustomRoundLocked(
			targetStage,
			strings.TrimSpace(req.Title),
			lane,
			fmtType,
			hcReq,
			laps,
			tLimit,
			linkMode,
			fromRndID,
			req.SourceColumn,
			strings.TrimSpace(req.SourceLane),
			req.AdvanceCount,
		)
		if r := e.findRoundByIDLocked(newRndID); r != nil {
			if req.QualifyingMetric != "" {
				r.QualifyingMetric = req.QualifyingMetric
			}
			if req.MaxPacksPerPilot != nil && *req.MaxPacksPerPilot >= 0 {
				r.MaxPacksPerPilot = *req.MaxPacksPerPilot
			}
			if dist := strings.TrimSpace(req.Distribution); dist == "random" || dist == "snake" || dist == "sequential" || dist == "roster" {
				r.SeedDistribution = dist
			}
			if lane == "finals" {
				fFmt := req.FinalsFormat
				if fFmt == "" {
					if fmtType == domain.FormatChaseTheAce {
						fFmt = domain.FinalsChaseTheAce
					} else {
						fFmt = domain.FinalsSingle
					}
				}
				r.FinalsFormat = fFmt
				if req.AceWinsRequired >= 2 && req.AceWinsRequired <= 5 {
					r.AceWinsRequired = req.AceWinsRequired
				} else {
					r.AceWinsRequired = 2
				}
				if req.WinnersAdvantageAce != nil {
					r.WinnersAdvantageAce = *req.WinnersAdvantageAce
				}
				if req.FinalsHeats >= 2 && req.FinalsHeats <= 7 {
					r.FinalsHeats = req.FinalsHeats
				} else {
					r.FinalsHeats = 3
				}
				e.rebuildSingleRoundLocked(newRndID)
			} else {
				if req.HeatCount > 0 {
					r.TargetHeats = req.HeatCount
				}
				if r.SeedSource == "all_active_pilots" && r.SeedDistribution != "" {
					e.rebuildSingleRoundLocked(newRndID)
				}
			}
			if req.HasPos {
				r.HasPos = true
				r.PosX = req.PosX
				r.PosY = req.PosY
			}
		}
		if explicitFromRndID != "" {
			wireMode := explicitLinkMode
			if wireMode == "empty" {
				wireMode = ""
			}
			_ = e.connectRoundsLockedFull(
				explicitFromRndID,
				newRndID,
				wireMode,
				req.AdvanceCount,
				req.SeedStart,
				req.SeedEnd,
				strings.TrimSpace(req.Distribution),
				req.QualifyingMetric,
				strings.TrimSpace(req.FromPort),
				strings.TrimSpace(req.ToPort),
			)
		}
		race.SyncRoundsMetadata(&e.raceState)
		outPortalID := domain.StageHandoffOutID(targetStage)
		if fmtType == domain.FormatQualifying && e.findRoundByIDLocked(outPortalID) != nil {
			_ = e.connectRoundsLocked(newRndID, outPortalID, "qual_feed", 0, 0, 0, "")
		}
		if req.HasPos {
			if r := e.findRoundByIDLocked(newRndID); r != nil {
				r.HasPos = true
				r.PosX = req.PosX
				r.PosY = req.PosY
			}
		}
		cfgChanged = true

	case "move_rounds", "move_round":
		race.SyncRoundsMetadata(&e.raceState)
		if len(req.Positions) > 0 {
			e.applyRoundPositionsLocked(req.Positions)
		} else if strings.TrimSpace(req.RoundID) != "" {
			e.applyRoundPositionsLocked([]RoundPositionUpdate{{
				RoundID: strings.TrimSpace(req.RoundID),
				PosX:    req.PosX,
				PosY:    req.PosY,
			}})
		}

	case "reset_round_layout":
		race.SyncRoundsMetadata(&e.raceState)
		stageIdx := req.StageIndex
		if stageIdx < 1 || stageIdx > domain.MaxRaceStages {
			stageIdx = e.raceState.ActiveStageIndex
		}
		if stg := e.findStageByIndexLocked(stageIdx); stg != nil {
			stg.PilotsNodeHasPos = false
			stg.PilotsNodePosX = 0
			stg.PilotsNodePosY = 0
		}
		for i := range e.raceState.Rounds {
			if e.raceState.Rounds[i].StageIndex == stageIdx {
				e.raceState.Rounds[i].HasPos = false
				e.raceState.Rounds[i].PosX = 0
				e.raceState.Rounds[i].PosY = 0
			}
		}
		e.recomputeGraphColumnsOnlyLocked(stageIdx)

	case "duplicate_round":
		race.SyncRoundsMetadata(&e.raceState)
		src := e.findRoundByIDLocked(strings.TrimSpace(req.RoundID))
		if src == nil {
			return cloneRaceState(e.raceState), fmt.Errorf("round not found")
		}
		if domain.IsStagePortalRoundID(src.ID) {
			return cloneRaceState(e.raceState), fmt.Errorf("stage seeding handoff node cannot be duplicated")
		}
		e.raceState.TemplateID = "custom"
		e.markStageCustomizedLocked(src.StageIndex)
		srcCopy := *src
		hc := 0
		for _, h := range e.raceState.Heats {
			if h.RoundID == srcCopy.ID {
				hc++
			}
		}
		if hc < 1 {
			hc = 1
		}
		dupLane := srcCopy.BracketLane
		dupTitle := srcCopy.Title + " Copy"
		if dupLane == "finals" {
			dupLane = "winners"
			dupTitle = "Consolation"
		}
		newRndID := e.appendCustomRoundLocked(
			srcCopy.StageIndex,
			dupTitle,
			dupLane,
			srcCopy.StageFormat,
			hc,
			srcCopy.TargetLaps,
			srcCopy.TimeLimitSec,
			"empty",
			"",
			0,
			"",
			2,
		)
		outPortalID := domain.StageHandoffOutID(srcCopy.StageIndex)
		if srcCopy.StageFormat == domain.FormatQualifying && e.findRoundByIDLocked(outPortalID) != nil {
			_ = e.connectRoundsLocked(newRndID, outPortalID, "qual_feed", 0, 0, 0, "")
		}
		if r := e.findRoundByIDLocked(newRndID); r != nil {
			if srcCopy.StartMode != "" {
				r.StartMode = srcCopy.StartMode
				for hi := range e.raceState.Heats {
					if e.raceState.Heats[hi].RoundID == newRndID {
						e.raceState.Heats[hi].StartMode = srcCopy.StartMode
					}
				}
			}
			if req.HasPos {
				r.HasPos = true
				r.PosX = req.PosX
				r.PosY = req.PosY
			} else if srcCopy.HasPos {
				r.HasPos = true
				r.PosX = srcCopy.PosX + 64
				r.PosY = srcCopy.PosY + 64
			}
		}
		cfgChanged = true

	case "delete_rounds":
		race.SyncRoundsMetadata(&e.raceState)
		e.applyRoundPositionsLocked(req.Positions)
		for _, rawID := range req.RoundIDs {
			rid := strings.TrimSpace(rawID)
			if rid == "" || domain.IsStagePortalRoundID(rid) {
				continue
			}
			for _, h := range e.raceState.Heats {
				if h.RoundID == rid && !isUnstartedHeatState(h.State) {
					return cloneRaceState(e.raceState), fmt.Errorf("cannot delete round %q because heat %s has already started", h.StageName, h.ShortLabel)
				}
			}
		}
		for _, rawID := range req.RoundIDs {
			rid := strings.TrimSpace(rawID)
			if rid != "" && !domain.IsStagePortalRoundID(rid) {
				if r := e.findRoundByIDLocked(rid); r != nil {
					e.markStageCustomizedLocked(r.StageIndex)
				}
				_ = e.deleteRoundLocked(rid, 0, "")
			}
		}
		cfgChanged = true

	case "connect_rounds":
		race.SyncRoundsMetadata(&e.raceState)
		e.applyRoundPositionsLocked(req.Positions)
		if err := e.connectRoundsLockedFull(
			strings.TrimSpace(req.FromRoundID),
			strings.TrimSpace(req.ToRoundID),
			strings.TrimSpace(req.LinkMode),
			req.AdvanceCount,
			req.SeedStart,
			req.SeedEnd,
			strings.TrimSpace(req.Distribution),
			req.QualifyingMetric,
			strings.TrimSpace(req.FromPort),
			strings.TrimSpace(req.ToPort),
		); err != nil {
			return cloneRaceState(e.raceState), err
		}
		cfgChanged = true

	case "update_connection":
		if err := e.updateRoundConnectionFullLocked(
			strings.TrimSpace(req.ConnectionID),
			strings.TrimSpace(req.FromRoundID),
			strings.TrimSpace(req.ToRoundID),
			strings.TrimSpace(req.LinkMode),
			req.AdvanceCount,
			req.SeedStart,
			req.SeedEnd,
			strings.TrimSpace(req.Distribution),
			req.QualifyingMetric,
		); err != nil {
			return cloneRaceState(e.raceState), err
		}
		cfgChanged = true

	case "reconnect_connection":
		race.SyncRoundsMetadata(&e.raceState)
		e.applyRoundPositionsLocked(req.Positions)
		if err := e.reconnectRoundConnectionLocked(
			strings.TrimSpace(req.ConnectionID),
			strings.TrimSpace(req.FromRoundID),
			strings.TrimSpace(req.ToRoundID),
			strings.TrimSpace(req.LinkMode),
			strings.TrimSpace(req.FromPort),
			strings.TrimSpace(req.ToPort),
		); err != nil {
			return cloneRaceState(e.raceState), err
		}
		cfgChanged = true

	case "disconnect_rounds":
		race.SyncRoundsMetadata(&e.raceState)
		e.applyRoundPositionsLocked(req.Positions)
		if err := e.disconnectRoundsLocked(
			strings.TrimSpace(req.ConnectionID),
			strings.TrimSpace(req.FromRoundID),
			strings.TrimSpace(req.ToRoundID),
		); err != nil {
			return cloneRaceState(e.raceState), err
		}
		cfgChanged = true

	case "set_round_seed":
		if err := e.setRoundSeedSourceWithDistLocked(
			strings.TrimSpace(req.RoundID),
			strings.TrimSpace(req.LinkMode),
			strings.TrimSpace(req.Distribution),
		); err != nil {
			return cloneRaceState(e.raceState), err
		}
		cfgChanged = true

	case "update_round":
		race.SyncRoundsMetadata(&e.raceState)
		targetID := strings.TrimSpace(req.RoundID)
		if targetID == "" {
			for _, r := range e.raceState.Rounds {
				if r.StageIndex == e.raceState.ActiveStageIndex && r.Column == req.Column && (req.BracketLane == "" || r.BracketLane == req.BracketLane) {
					targetID = r.ID
					break
				}
			}
		}
		var newStartMode domain.StartMode
		if req.StartMode == domain.StartModeStaggered || req.StartMode == domain.StartModeHeadsUp {
			newStartMode = req.StartMode
		} else if req.StageFormat == domain.FormatQualifying {
			newStartMode = domain.StartModeStaggered
		} else if req.StageFormat != "" {
			newStartMode = domain.StartModeHeadsUp
		}
		newLane := strings.TrimSpace(req.BracketLane)
		becomingFinals := false
		if targetR := e.findRoundByIDLocked(targetID); targetR != nil {
			e.markStageCustomizedLocked(targetR.StageIndex)
			if newLane == "finals" && targetR.BracketLane != "finals" {
				becomingFinals = true
			}
		}
		allRoundUnstarted := true
		curRoundHeats := 0
		startedRoundHeats := 0
		for _, h := range e.raceState.Heats {
			if h.RoundID == targetID {
				curRoundHeats++
				if !isUnstartedHeatState(h.State) {
					allRoundUnstarted = false
					startedRoundHeats++
				}
			}
		}
		finalsRebuildNeeded := becomingFinals
		heatCountChanged := false
		for i := range e.raceState.Rounds {
			r := &e.raceState.Rounds[i]
			if r.ID == targetID {
				if strings.TrimSpace(req.Title) != "" {
					r.Title = strings.TrimSpace(req.Title)
				}
				if newLane != "" {
					r.BracketLane = newLane
				}
				if req.TargetLaps >= 0 {
					r.TargetLaps = req.TargetLaps
				}
				if req.TimeLimitSec >= 15 {
					r.TimeLimitSec = req.TimeLimitSec
				}
				if req.QualifyingMetric != "" {
					r.QualifyingMetric = req.QualifyingMetric
				}
				if req.MaxPacksPerPilot != nil && *req.MaxPacksPerPilot >= 0 {
					r.MaxPacksPerPilot = *req.MaxPacksPerPilot
				}
				if dist := strings.TrimSpace(req.Distribution); dist == "random" || dist == "snake" || dist == "sequential" || dist == "roster" {
					if r.SeedDistribution != dist {
						r.SeedDistribution = dist
						finalsRebuildNeeded = true
					}
				}
				if req.StageFormat != "" {
					r.StageFormat = req.StageFormat
					if req.StageFormat == domain.FormatQualifying && req.TargetLaps == 0 {
						r.TargetLaps = 0
					} else if req.StageFormat != domain.FormatQualifying && r.TargetLaps <= 0 {
						r.TargetLaps = e.raceState.Config.TargetLaps
					}
				}
				if newStartMode != "" {
					r.StartMode = newStartMode
				}
				if r.BracketLane == "finals" {
					if req.FinalsFormat == domain.FinalsSingle || req.FinalsFormat == domain.FinalsChaseTheAce || req.FinalsFormat == domain.FinalsPoints {
						if r.FinalsFormat != req.FinalsFormat {
							r.FinalsFormat = req.FinalsFormat
							finalsRebuildNeeded = true
						}
						if req.FinalsFormat == domain.FinalsChaseTheAce {
							r.StageFormat = domain.FormatChaseTheAce
						} else if r.StageFormat == domain.FormatChaseTheAce {
							r.StageFormat = domain.FormatSingleElimination
						}
					} else if r.FinalsFormat == "" {
						r.FinalsFormat = domain.FinalsSingle
					}
					if req.AceWinsRequired >= 2 && req.AceWinsRequired <= 5 {
						r.AceWinsRequired = req.AceWinsRequired
						finalsRebuildNeeded = true
					} else if r.AceWinsRequired < 2 {
						r.AceWinsRequired = 2
					}
					if req.WinnersAdvantageAce != nil {
						r.WinnersAdvantageAce = *req.WinnersAdvantageAce
						finalsRebuildNeeded = true
					}
					if req.FinalsHeats >= 2 && req.FinalsHeats <= 7 {
						if r.FinalsHeats != req.FinalsHeats {
							r.FinalsHeats = req.FinalsHeats
							finalsRebuildNeeded = true
						}
					} else if r.FinalsHeats < 2 {
						r.FinalsHeats = 3
					}
				} else if req.HeatCount > 0 {
					effectiveHeatCount := req.HeatCount
					if effectiveHeatCount < startedRoundHeats {
						effectiveHeatCount = startedRoundHeats
					}
					if effectiveHeatCount < 1 {
						effectiveHeatCount = 1
					}
					r.TargetHeats = effectiveHeatCount
					if effectiveHeatCount != curRoundHeats {
						heatCountChanged = true
					}
				}
			}
		}
		if heatCountChanged {
			targetHeatCount := req.HeatCount
			if targetHeatCount < startedRoundHeats {
				targetHeatCount = startedRoundHeats
			}
			if targetHeatCount < 1 {
				targetHeatCount = 1
			}
			e.ensureRoundHeatCountLocked(targetID, targetHeatCount)
			if allRoundUnstarted {
				e.rebalanceAutoConnectionsIntoLocked(targetID)
				if r := e.findRoundByIDLocked(targetID); r != nil {
					e.recomputeGraphAndRebuildLocked(r.StageIndex, targetID)
				}
			} else if r := e.findRoundByIDLocked(targetID); r != nil {
				e.markStageCustomizedLocked(r.StageIndex)
				for _, c := range e.raceState.Connections {
					if !c.Invalid && c.FromRoundID == targetID && !domain.IsStagePortalRoundID(c.ToRoundID) {
						e.recomputeGraphAndRebuildLocked(r.StageIndex, c.ToRoundID)
					}
				}
			}
		}
		if allRoundUnstarted && finalsRebuildNeeded {
			e.rebalanceAutoConnectionsIntoLocked(targetID)
			if r := e.findRoundByIDLocked(targetID); r != nil {
				e.recomputeGraphAndRebuildLocked(r.StageIndex, targetID)
			}
		} else if !heatCountChanged {
			// Propagate title, format, lane, or metric updates down the entire DAG to Finals
			if r := e.findRoundByIDLocked(targetID); r != nil {
				e.cascadeBalancedRoundsFromLocked(r.StageIndex, targetID)
			}
		}
		heatSeq := 0
		for i := range e.raceState.Heats {
			h := &e.raceState.Heats[i]
			if h.RoundID == targetID {
				heatSeq++
				if isUnstartedHeatState(h.State) {
					if strings.TrimSpace(req.Title) != "" {
						newTitle := strings.TrimSpace(req.Title)
						h.StageName = newTitle
						h.Title = fmt.Sprintf("%s · Heat %d", newTitle, heatSeq)
					}
					if newLane != "" {
						h.BracketLane = newLane
					}
					if req.TargetLaps >= 0 {
						h.TargetLaps = req.TargetLaps
					}
					if req.TimeLimitSec >= 15 {
						h.TimeLimitSec = req.TimeLimitSec
					}
					if req.StageFormat != "" {
						h.StageFormat = req.StageFormat
						if req.StageFormat == domain.FormatQualifying {
							h.ExpectedWinners = 0
							if req.TargetLaps == 0 {
								h.TargetLaps = 0
							}
						} else if h.TargetLaps <= 0 {
							h.TargetLaps = e.raceState.Config.TargetLaps
						}
					}
					if newStartMode != "" {
						h.StartMode = newStartMode
					}
				}
			}
		}
		if strings.TrimSpace(req.LinkMode) == "all_active_pilots" || strings.TrimSpace(req.LinkMode) == "empty" {
			_ = e.setRoundSeedSourceWithDistLocked(targetID, strings.TrimSpace(req.LinkMode), strings.TrimSpace(req.Distribution))
		}
		cfgChanged = true

	case "delete_round":
		race.SyncRoundsMetadata(&e.raceState)
		e.applyRoundPositionsLocked(req.Positions)
		if err := e.deleteRoundLocked(req.RoundID, req.Column, strings.TrimSpace(req.BracketLane)); err != nil {
			return cloneRaceState(e.raceState), err
		}
		cfgChanged = true

	case "link_round":
		if err := e.linkExistingRoundLocked(
			req.RoundID,
			req.Column,
			strings.TrimSpace(req.BracketLane),
			strings.TrimSpace(req.LinkMode),
			req.SourceColumn,
			strings.TrimSpace(req.SourceLane),
			req.AdvanceCount,
		); err != nil {
			return cloneRaceState(e.raceState), err
		}
		cfgChanged = true

	case "set_seat_feeder":
		h := e.findHeatLocked(req.HeatID)
		if h == nil || !isUnstartedHeatState(h.State) {
			return cloneRaceState(e.raceState), fmt.Errorf("only unstarted heats can have progression links edited")
		}
		sIdx := findSeatIndex(h, req.SeatIndex)
		if sIdx < 0 {
			return cloneRaceState(e.raceState), fmt.Errorf("seat not found")
		}
		s := &h.Seats[sIdx]
		s.ManualLock = false
		clearSeatOccupant(s, false)
		if req.FromHeatID != "" && req.FromRank > 0 {
			if req.FromHeatID == h.ID {
				return cloneRaceState(e.raceState), fmt.Errorf("cannot link a heat to itself")
			}
			srcH := e.findHeatLocked(req.FromHeatID)
			if srcH == nil {
				return cloneRaceState(e.raceState), fmt.Errorf("source heat %q not found", req.FromHeatID)
			}
			s.Feeder = &domain.SeatFeeder{
				FromHeatID: req.FromHeatID,
				FromRank:   req.FromRank,
			}
			s.SourceLabel = fmt.Sprintf("%s · %s", race.Ordinal(req.FromRank), srcH.ShortLabel)
			h.State = domain.HeatWaiting
		} else if req.FromRoundColumn > 0 && req.FromStandingsRank > 0 {
			s.Feeder = &domain.SeatFeeder{
				FromRoundColumn:   req.FromRoundColumn,
				FromStandingsRank: req.FromStandingsRank,
			}
			s.SourceLabel = fmt.Sprintf("Rank #%d · R%d", req.FromStandingsRank, req.FromRoundColumn)
			h.State = domain.HeatWaiting
		} else if req.FromStageSeed > 0 {
			s.Feeder = &domain.SeatFeeder{
				FromStageSeed: req.FromStageSeed,
			}
			s.SourceLabel = fmt.Sprintf("Seed #%d", req.FromStageSeed)
			h.State = domain.HeatWaiting
		} else {
			s.Feeder = nil
			s.SourceLabel = "Open / BYE"
		}
		race.RebuildEdgesFromFeeders(&e.raceState)
		finalizeEditedHeatState(h, e.raceState.Config.QualifyingMetric)
		e.cascadeBalancedRoundsFromLocked(h.StageIndex, h.RoundID)
		cfgChanged = true

	case "regenerate_upcoming":
		e.regenerateUpcomingRoundsLocked()
		cfgChanged = true

	case "move_or_swap_seat":
		fromHeat := e.findHeatLocked(req.FromHeatID)
		toHeat := e.findHeatLocked(req.ToHeatID)
		if fromHeat == nil || toHeat == nil {
			return cloneRaceState(e.raceState), fmt.Errorf("source or target heat not found")
		}
		if !isUnstartedHeatState(fromHeat.State) || !isUnstartedHeatState(toHeat.State) {
			return cloneRaceState(e.raceState), fmt.Errorf("only unstarted heats (Waiting, Ready, or Staged) can have their pilot lineup edited")
		}
		fromIdx := findSeatIndex(fromHeat, req.FromSeatIndex)
		toIdx := findSeatIndex(toHeat, req.ToSeatIndex)
		if fromIdx < 0 || toIdx < 0 {
			return cloneRaceState(e.raceState), fmt.Errorf("seat not found")
		}
		if req.FromHeatID == req.ToHeatID && fromIdx == toIdx {
			break
		}
		fromSeat := &fromHeat.Seats[fromIdx]
		toSeat := &toHeat.Seats[toIdx]
		if req.FromHeatID != req.ToHeatID {
			if fromSeat.PilotSlotIndex > 0 && heatContainsPilotExcept(toHeat, fromSeat.PilotSlotIndex, toIdx) {
				return cloneRaceState(e.raceState), fmt.Errorf("%s is already seated in %s", fromSeat.Callsign, toHeat.ShortLabel)
			}
			if toSeat.PilotSlotIndex > 0 && heatContainsPilotExcept(fromHeat, toSeat.PilotSlotIndex, fromIdx) {
				return cloneRaceState(e.raceState), fmt.Errorf("%s is already seated in %s", toSeat.Callsign, fromHeat.ShortLabel)
			}
		}

		swapSeatOccupants(fromSeat, toSeat)
		if toSeat.PilotSlotIndex > 0 {
			toSeat.ManualLock = true
		}
		if fromSeat.PilotSlotIndex > 0 {
			fromSeat.ManualLock = true
		}
		finalizeEditedHeatState(fromHeat, e.raceState.Config.QualifyingMetric)
		if fromHeat.ID != toHeat.ID {
			finalizeEditedHeatState(toHeat, e.raceState.Config.QualifyingMetric)
		}
		e.cascadeBalancedRoundsFromLocked(fromHeat.StageIndex, fromHeat.RoundID)
		if toHeat.RoundID != fromHeat.RoundID {
			e.cascadeBalancedRoundsFromLocked(toHeat.StageIndex, toHeat.RoundID)
		}
		cfgChanged = true

	case "assign_pilot_seat":
		h := e.findHeatLocked(req.HeatID)
		if h == nil {
			return cloneRaceState(e.raceState), fmt.Errorf("heat not found")
		}
		if !isUnstartedHeatState(h.State) {
			return cloneRaceState(e.raceState), fmt.Errorf("only unstarted heats can be edited")
		}
		sIdx := findSeatIndex(h, req.SeatIndex)
		if sIdx < 0 {
			return cloneRaceState(e.raceState), fmt.Errorf("seat not found")
		}
		ep, ok := e.ensurePilotActiveInRaceLocked(req.PilotSlotIndex)
		if !ok {
			return cloneRaceState(e.raceState), fmt.Errorf("pilot %d not found", req.PilotSlotIndex)
		}
		existingIdx := -1
		for i := range h.Seats {
			if i != sIdx && h.Seats[i].PilotSlotIndex == req.PilotSlotIndex {
				existingIdx = i
				break
			}
		}
		if existingIdx >= 0 {
			swapSeatOccupants(&h.Seats[existingIdx], &h.Seats[sIdx])
			h.Seats[sIdx].ManualLock = true
			if h.Seats[existingIdx].PilotSlotIndex > 0 {
				h.Seats[existingIdx].ManualLock = true
			}
		} else {
			dst := &h.Seats[sIdx]
			dst.PilotSlotIndex = ep.SlotIndex
			dst.Callsign = ep.Callsign
			dst.PhoneticName = ep.PhoneticName
			dst.Color = ep.Color
			if dst.Seed == 0 {
				dst.Seed = ep.SlotIndex
			}
			dst.Status = domain.PilotHeatStaged
			dst.Crossings = nil
			dst.Laps = []domain.HeatLap{}
			dst.ManualPosition = 0
			dst.PenaltySec = 0
			dst.ManualLock = true
			if dst.Feeder == nil && (dst.SourceLabel == "" || dst.SourceLabel == "Open / BYE") {
				dst.SourceLabel = "Manual"
			}
		}
		finalizeEditedHeatState(h, e.raceState.Config.QualifyingMetric)
		e.cascadeBalancedRoundsFromLocked(h.StageIndex, h.RoundID)
		cfgChanged = true

	case "clear_seat":
		h := e.findHeatLocked(req.HeatID)
		if h == nil || !isUnstartedHeatState(h.State) {
			return cloneRaceState(e.raceState), fmt.Errorf("cannot clear seat on a started heat")
		}
		sIdx := findSeatIndex(h, req.SeatIndex)
		if sIdx < 0 {
			return cloneRaceState(e.raceState), fmt.Errorf("seat not found")
		}
		s := &h.Seats[sIdx]
		roundAutoSeeded := false
		if h.RoundID != "" {
			if rnd := e.findRoundByIDLocked(h.RoundID); rnd != nil {
				if rnd.SeedSource == "all_active_pilots" {
					roundAutoSeeded = true
				} else {
					for _, c := range e.raceState.Connections {
						if !c.Invalid && c.ToRoundID == rnd.ID && c.Mode == "all_pilots" {
							roundAutoSeeded = true
							break
						}
					}
				}
			}
		}
		if s.ManualLock {
			s.ManualLock = false
			if s.Feeder != nil {
				s.SourceLabel = e.feederSourceLabelLocked(s.Feeder)
				clearSeatOccupant(s, false)
			} else if roundAutoSeeded && e.ensureRoundUnstartedLocked(h.RoundID) == nil {
				clearSeatOccupant(s, false)
				e.rebuildSingleRoundLocked(h.RoundID)
			} else {
				clearSeatOccupant(s, false)
			}
		} else {
			clearSeatOccupant(s, true)
			if s.Feeder == nil && roundAutoSeeded {
				s.ManualLock = true
			}
		}
		if hAfter := e.findHeatLocked(req.HeatID); hAfter != nil {
			finalizeEditedHeatState(hAfter, e.raceState.Config.QualifyingMetric)
			e.cascadeBalancedRoundsFromLocked(hAfter.StageIndex, hAfter.RoundID)
		}
		cfgChanged = true

	case "unlock_seat":
		h := e.findHeatLocked(req.HeatID)
		if h == nil || !isUnstartedHeatState(h.State) {
			return cloneRaceState(e.raceState), fmt.Errorf("cannot unlock seat on a started heat")
		}
		sIdx := findSeatIndex(h, req.SeatIndex)
		if sIdx < 0 {
			return cloneRaceState(e.raceState), fmt.Errorf("seat not found")
		}
		s := &h.Seats[sIdx]
		s.ManualLock = false
		if s.Feeder != nil {
			s.SourceLabel = e.feederSourceLabelLocked(s.Feeder)
			clearSeatOccupant(s, false)
		}
		finalizeEditedHeatState(h, e.raceState.Config.QualifyingMetric)
		e.cascadeBalancedRoundsFromLocked(h.StageIndex, h.RoundID)
		cfgChanged = true

	case "set_seat_channel":
		var newBand domain.Band
		var newCh uint8
		var newFreq uint16
		var validCh bool
		if req.Band > 0 && req.Channel >= 1 && req.Channel <= domain.MaxPilotSlots {
			newBand = req.Band
			newCh = req.Channel
			newFreq = domain.FrequencyForBandChannel(newBand, newCh)
			validCh = newFreq > 0
		} else {
			newBand, newCh, newFreq, validCh = domain.DecodeBandChannel(req.Channel)
		}
		if !validCh || newFreq == 0 {
			return cloneRaceState(e.raceState), fmt.Errorf("invalid VTX channel %d", req.Channel)
		}
		h := e.findHeatLocked(req.HeatID)
		if h == nil || !isUnstartedHeatState(h.State) {
			return cloneRaceState(e.raceState), fmt.Errorf("channels can only be changed on unstarted heats")
		}
		sIdx := findSeatIndex(h, req.SeatIndex)
		if sIdx < 0 {
			return cloneRaceState(e.raceState), fmt.Errorf("seat not found")
		}
		oldBand := h.Seats[sIdx].Band
		if oldBand == 0 {
			oldBand = domain.BandRaceband
		}
		oldCh := h.Seats[sIdx].Channel
		oldFreq := h.Seats[sIdx].FrequencyMHz
		if oldFreq == 0 {
			oldFreq = domain.FrequencyForBandChannel(oldBand, oldCh)
		}
		for i := range h.Seats {
			if i == sIdx {
				continue
			}
			iFreq := h.Seats[i].FrequencyMHz
			if iFreq == 0 {
				iFreq = domain.FrequencyForBandChannel(h.Seats[i].Band, h.Seats[i].Channel)
			}
			if (h.Seats[i].Band == newBand && h.Seats[i].Channel == newCh) || (iFreq > 0 && iFreq == newFreq) {
				h.Seats[i].Band = oldBand
				h.Seats[i].Channel = oldCh
				h.Seats[i].FrequencyMHz = oldFreq
				break
			}
		}
		h.Seats[sIdx].Band = newBand
		h.Seats[sIdx].Channel = newCh
		h.Seats[sIdx].FrequencyMHz = newFreq
		if h.Seats[sIdx].Feeder != nil && h.Seats[sIdx].PilotSlotIndex > 0 {
			h.Seats[sIdx].ManualLock = true
		}
		cfgChanged = true

	case "auto_seat_pilot":
		ep, ok := e.ensurePilotActiveInRaceLocked(req.PilotSlotIndex)
		if !ok {
			return cloneRaceState(e.raceState), fmt.Errorf("pilot %d not found", req.PilotSlotIndex)
		}
		if err := e.autoSeatLatePilotLocked(ep); err != nil {
			return cloneRaceState(e.raceState), err
		}
		cfgChanged = true

	case "add_heat":
		newHeatID := e.appendHeatToRoundOrColumnLocked(strings.TrimSpace(req.RoundID), req.BracketLane, req.Round, req.Column)
		if added := e.findHeatLocked(newHeatID); added != nil && added.RoundID != "" {
			e.markStageCustomizedLocked(added.StageIndex)
			if r := e.findRoundByIDLocked(added.RoundID); r != nil {
				cnt := 0
				for _, h := range e.raceState.Heats {
					if h.RoundID == r.ID {
						cnt++
					}
				}
				r.TargetHeats = cnt
				for _, c := range e.raceState.Connections {
					if !c.Invalid && c.FromRoundID == r.ID && !domain.IsStagePortalRoundID(c.ToRoundID) {
						e.recomputeGraphAndRebuildLocked(r.StageIndex, c.ToRoundID)
					}
				}
			}
		}
		cfgChanged = true

	case "delete_heat":
		if err := e.deleteUnstartedHeatLocked(req.HeatID); err != nil {
			return cloneRaceState(e.raceState), err
		}
		cfgChanged = true

	case "open_qual_enqueue":
		if _, err := e.openQualEnqueuePilotLocked(req.PilotSlotIndex, req.StageIndex, req.ForceImmediate); err != nil {
			return cloneRaceState(e.raceState), err
		}
		cfgChanged = true

	case "open_qual_dequeue":
		if err := e.openQualDequeuePilotLocked(req.HeatID, req.PilotSlotIndex, req.SeatIndex); err != nil {
			return cloneRaceState(e.raceState), err
		}
		cfgChanged = true

	case "open_qual_enqueue_all":
		if _, err := e.openQualEnqueueAllReadyLocked(req.StageIndex); err != nil {
			return cloneRaceState(e.raceState), err
		}
		cfgChanged = true

	default:
		return cloneRaceState(e.raceState), fmt.Errorf("unknown bracket edit action %q", req.Action)
	}

	e.resolveActiveTournamentLocked()
	if cfgChanged && e.raceState.Mode == domain.ModeRace {
		e.stageOrDisarmActiveRaceLocked()
	}

	*cfgChangedOut = cfgChanged
	return cloneRaceState(e.raceState), nil
}

func (e *Engine) applyRoundPositionsLocked(positions []RoundPositionUpdate) {
	race.EnsureStagesMetadata(&e.raceState)
	for _, p := range positions {
		rid := strings.TrimSpace(p.RoundID)
		if stgIdx, ok := parsePilotsPortalStageIndex(rid); ok {
			if stg := e.findStageByIndexLocked(stgIdx); stg != nil {
				stg.PilotsNodeHasPos = true
				stg.PilotsNodePosX = p.PosX
				stg.PilotsNodePosY = p.PosY
			}
			continue
		}
		if r := e.findRoundByIDLocked(rid); r != nil {
			r.HasPos = true
			r.PosX = p.PosX
			r.PosY = p.PosY
		}
	}
}

func (e *Engine) findRoundByIDLocked(roundID string) *domain.RaceRound {
	if roundID == "" {
		return nil
	}
	for i := range e.raceState.Rounds {
		if e.raceState.Rounds[i].ID == roundID {
			return &e.raceState.Rounds[i]
		}
	}
	return nil
}

func canReachRoundInAdj(adj map[string][]string, startID, targetID string) bool {
	if startID == "" || targetID == "" {
		return false
	}
	if startID == targetID {
		return true
	}
	visited := make(map[string]bool)
	queue := []string{startID}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if cur == targetID {
			return true
		}
		if visited[cur] {
			continue
		}
		visited[cur] = true
		queue = append(queue, adj[cur]...)
	}
	return false
}

func wouldCreateRoundCycle(conns []domain.RoundConnection, fromID, toID string) bool {
	if fromID == "" || toID == "" || fromID == toID {
		return true
	}
	adj := make(map[string][]string)
	for _, c := range conns {
		if c.Invalid {
			continue
		}
		adj[c.FromRoundID] = append(adj[c.FromRoundID], c.ToRoundID)
	}
	return canReachRoundInAdj(adj, toID, fromID)
}

const startedTargetConnPrefix = "Started round:"

// validateConnectionsLocked evaluates every RoundConnection in order, populating `Invalid` and
// `InvalidReason` without deleting user-drawn wires. Returns target round IDs of any wires that
// transitioned from Invalid -> Valid so downstream heats can rebuild immediately.
func (e *Engine) validateConnectionsLocked() []string {
	cfg := e.raceState.Config.Normalized()
	roundByID := make(map[string]*domain.RaceRound, len(e.raceState.Rounds))
	for i := range e.raceState.Rounds {
		roundByID[e.raceState.Rounds[i].ID] = &e.raceState.Rounds[i]
	}

	validAdj := make(map[string][]string)
	seenPair := make(map[[2]string]bool)
	maxTopFrom := make(map[string]int)
	maxBottomFrom := make(map[string]int)
	finalsSeatsUsed := make(map[string]int)
	var newlyValidTargets []string

	for i := range e.raceState.Connections {
		c := &e.raceState.Connections[i]
		wasInvalid := c.Invalid
		prevStartedBlock := c.Invalid && strings.HasPrefix(c.InvalidReason, startedTargetConnPrefix)

		c.Invalid = false
		c.InvalidReason = ""

		fromR := roundByID[c.FromRoundID]
		toR := roundByID[c.ToRoundID]
		if fromR == nil || toR == nil {
			c.Invalid = true
			c.InvalidReason = "Connected round no longer exists."
			continue
		}

		stgSettings := e.stageSettingsLocked(toR.StageIndex)
		pph := stgSettings.PilotsPerHeat
		if pph < 2 {
			pph = 4
		}

		fromTitle := fromR.Title
		if fromTitle == "" {
			fromTitle = fromR.ID
		}
		toTitle := toR.Title
		if toTitle == "" {
			toTitle = toR.ID
		}

		if c.FromRoundID == c.ToRoundID {
			c.Invalid = true
			c.InvalidReason = fmt.Sprintf("Cannot connect %s to itself. Drag either endpoint to another round.", fromTitle)
			continue
		}
		if domain.IsStageHandoffOutID(fromR.ID) {
			c.Invalid = true
			c.InvalidReason = fmt.Sprintf("%s is an output portal — switch to the downstream stage and connect from Incoming Seeds.", fromTitle)
			continue
		}
		if domain.IsStageHandoffInID(toR.ID) {
			c.Invalid = true
			c.InvalidReason = fmt.Sprintf("%s receives pilots from an upstream stage and cannot accept incoming connections.", toTitle)
			continue
		}
		if fromR.StageIndex != toR.StageIndex {
			c.Invalid = true
			c.InvalidReason = "Cannot connect rounds across different stages directly — connect stages in Format mode."
			continue
		}
		if prevStartedBlock {
			if domain.IsStageHandoffOutID(toR.ID) && e.anyDownstreamStageStartedLocked(fromR.StageIndex) {
				c.Invalid = true
				c.InvalidReason = fmt.Sprintf("%s Downstream stage heats have already started, so stage seeding wires are locked.", startedTargetConnPrefix)
				continue
			}
			if !domain.IsStageHandoffOutID(toR.ID) && e.ensureRoundUnstartedLocked(toR.ID) != nil {
				c.Invalid = true
				c.InvalidReason = fmt.Sprintf("%s %s already has started or confirmed heats and cannot accept new incoming connections.", startedTargetConnPrefix, toTitle)
				continue
			}
		}

		pairKey := [2]string{c.FromRoundID, c.ToRoundID}
		if seenPair[pairKey] {
			c.Invalid = true
			c.InvalidReason = fmt.Sprintf("Duplicate connection: %s is already connected to %s. Drag an endpoint to another round or remove this wire.", fromTitle, toTitle)
			continue
		}

		if canReachRoundInAdj(validAdj, c.ToRoundID, c.FromRoundID) {
			c.Invalid = true
			c.InvalidReason = fmt.Sprintf("Creates a loop: %s already feeds into %s. Drag an endpoint to another round or remove one of the loop wires.", toTitle, fromTitle)
			continue
		}

		if c.Mode == "stage_seeds" {
			if c.SeedEnd > 0 && c.SeedStart > c.SeedEnd {
				c.Invalid = true
				c.InvalidReason = fmt.Sprintf("Invalid seed range: start seed (#%d) is greater than end seed (#%d).", c.SeedStart, c.SeedEnd)
				continue
			}
			stageCap := 0
			if len(e.raceState.Stages) <= 2 && toR.StageIndex == 2 && cfg.Stage2MaxSeeds > 0 {
				stageCap = cfg.Stage2MaxSeeds
			}
			if len(e.raceState.Stages) > 0 {
				inStageConns := race.IncomingStageConnections(&e.raceState, toR.StageIndex)
				allCapped := len(inStageConns) > 0
				cappedTotal := 0
				for _, sc := range inStageConns {
					if sc.Mode == "top_n" && sc.Count > 0 {
						cappedTotal += sc.Count
					} else if sc.Mode == "seed_range" && sc.SeedEnd > 0 {
						sStart := sc.SeedStart
						if sStart < 1 {
							sStart = 1
						}
						if sc.SeedEnd >= sStart {
							cappedTotal += sc.SeedEnd - sStart + 1
						}
					} else {
						allCapped = false
					}
				}
				if allCapped && cappedTotal > 0 {
					stageCap = cappedTotal
				}
			}
			if stageCap > 0 && c.SeedStart > stageCap {
				c.Invalid = true
				c.InvalidReason = fmt.Sprintf("Seeds #%d+ exceed this stage's incoming cutoff (Top %d seeds). Increase the stage wire cutoff in Format or adjust this wire's seed range.", c.SeedStart, stageCap)
				continue
			}
		} else if c.Mode == "standings_top" {
			if c.SeedEnd > 0 && c.SeedStart > c.SeedEnd {
				c.Invalid = true
				c.InvalidReason = fmt.Sprintf("Invalid rank range: start rank (#%d) is greater than end rank (#%d).", c.SeedStart, c.SeedEnd)
				continue
			}
		} else if c.Mode == "top_per_heat" || c.Mode == "bottom_per_heat" {
			cnt := c.Count
			if cnt < 1 {
				cnt = 1
			}
			if cnt > pph {
				c.Invalid = true
				c.InvalidReason = fmt.Sprintf("Cannot advance %d pilots per heat from %s when heats have %d seats.", cnt, fromTitle, pph)
				continue
			}
			if c.Mode == "top_per_heat" && maxBottomFrom[c.FromRoundID] > 0 && cnt+maxBottomFrom[c.FromRoundID] > pph {
				c.Invalid = true
				c.InvalidReason = fmt.Sprintf("Overlapping advancement from %s: Top %d + Bottom %d exceeds %d seats per heat.", fromTitle, cnt, maxBottomFrom[c.FromRoundID], pph)
				continue
			}
			if c.Mode == "bottom_per_heat" && maxTopFrom[c.FromRoundID] > 0 && maxTopFrom[c.FromRoundID]+cnt > pph {
				c.Invalid = true
				c.InvalidReason = fmt.Sprintf("Overlapping advancement from %s: Top %d + Bottom %d exceeds %d seats per heat.", fromTitle, maxTopFrom[c.FromRoundID], cnt, pph)
				continue
			}
		}

		if toR.BracketLane == "finals" {
			wireFeeders := e.connectionFeederCountLocked(*c, pph)
			if finalsSeatsUsed[toR.ID]+wireFeeders > pph {
				c.Invalid = true
				c.InvalidReason = fmt.Sprintf("Finals is a single-group championship matchup (%d seats max), so adding %d pilots from %s would exceed %d finalists. Add an intermediate round first or reduce picks.", pph, wireFeeders, fromTitle, pph)
				continue
			}
			finalsSeatsUsed[toR.ID] += wireFeeders
		}

		// Connection is valid!
		seenPair[pairKey] = true
		validAdj[c.FromRoundID] = append(validAdj[c.FromRoundID], c.ToRoundID)
		if c.Mode == "top_per_heat" && c.Count > maxTopFrom[c.FromRoundID] {
			maxTopFrom[c.FromRoundID] = c.Count
		}
		if c.Mode == "bottom_per_heat" && c.Count > maxBottomFrom[c.FromRoundID] {
			maxBottomFrom[c.FromRoundID] = c.Count
		}
		if wasInvalid {
			newlyValidTargets = append(newlyValidTargets, c.ToRoundID)
		}
	}
	return newlyValidTargets
}

// appendCustomRoundLocked appends a new Round node to `stageIdx` and optionally seeds or connects it.
func (e *Engine) appendCustomRoundLocked(
	stageIdx int,
	title string,
	lane string,
	stageFmt domain.StageFormat,
	heatCount int,
	targetLaps int,
	timeLimitSec int,
	linkMode string,
	fromRoundID string,
	sourceCol int,
	sourceLane string,
	advanceCount int,
) string {
	race.SyncRoundsMetadata(&e.raceState)
	if stageIdx < 1 || stageIdx > domain.MaxRaceStages {
		stageIdx = e.raceState.ActiveStageIndex
	}
	if stageIdx < 1 {
		stageIdx = 1
		e.raceState.ActiveStageIndex = 1
	}

	maxCol := 0
	maxRoundSeq := 0
	for _, r := range e.raceState.Rounds {
		if r.StageIndex == stageIdx && !domain.IsStagePortalRoundID(r.ID) {
			if r.Column > maxCol {
				maxCol = r.Column
			}
			if r.Round > maxRoundSeq {
				maxRoundSeq = r.Round
			}
		}
	}

	newCol := maxCol + 1
	newRoundNum := maxRoundSeq + 1
	if title == "" {
		title = fmt.Sprintf("Round %d", newRoundNum)
	}
	if lane == "" {
		lane = "winners"
	}

	rndID := e.nextUniqueIDLocked("rnd")
	seedSource := "empty"
	if linkMode == "all_active_pilots" {
		seedSource = "all_active_pilots"
		if maxCol == 0 {
			newCol = 1
		}
	}

	startMode := domain.StartModeHeadsUp
	if stageFmt == domain.FormatQualifying || stageFmt == domain.FormatOpenQualifier {
		startMode = domain.StartModeStaggered
	}
	e.raceState.Rounds = append(e.raceState.Rounds, domain.RaceRound{
		ID:           rndID,
		StageIndex:   stageIdx,
		Round:        newRoundNum,
		Column:       newCol,
		BracketLane:  lane,
		Title:        title,
		StageFormat:  stageFmt,
		StartMode:    startMode,
		TargetLaps:   targetLaps,
		TimeLimitSec: timeLimitSec,
		SeedSource:   seedSource,
	})

	if stageFmt == domain.FormatOpenQualifier {
		return rndID
	}

	switch linkMode {
	case "none":
		// Leave 0 heats only when explicitly requested (`start_custom` blank)
	case "all_active_pilots":
		e.rebuildSingleRoundLocked(rndID)
	case "empty", "":
		hc := heatCount
		if hc < 1 {
			hc = 1
		}
		e.ensureRoundHeatCountLocked(rndID, hc)
	default:
		// Ensure 1 initial heat, then connect from source round
		e.ensureRoundHeatCountLocked(rndID, 1)
		srcID := fromRoundID
		if srcID == "" {
			if sourceCol <= 0 {
				sourceCol = maxCol
			}
			for _, r := range e.raceState.Rounds {
				if r.ID == rndID || r.StageIndex != stageIdx || domain.IsStageHandoffOutID(r.ID) {
					continue
				}
				if r.Column == sourceCol && (sourceLane == "" || r.BracketLane == sourceLane) {
					srcID = r.ID
					break
				}
			}
			if srcID == "" {
				for i := len(e.raceState.Rounds) - 1; i >= 0; i-- {
					r := e.raceState.Rounds[i]
					if r.ID != rndID && r.StageIndex == stageIdx && !domain.IsStageHandoffOutID(r.ID) {
						srcID = r.ID
						break
					}
				}
			}
		}
		if srcID != "" {
			seedCap := 0
			if len(e.raceState.Stages) <= 2 && stageIdx == 2 {
				seedCap = e.raceState.Config.Stage2MaxSeeds
			}
			_ = e.connectRoundsLocked(srcID, rndID, linkMode, advanceCount, 1, seedCap, "")
			return rndID
		}
	}

	e.sortCustomHeatsAndOrderLocked(stageIdx)
	race.RebuildEdgesFromFeeders(&e.raceState)
	race.SyncRoundsMetadata(&e.raceState)
	return rndID
}

func (e *Engine) ensureRoundUnstartedLocked(roundID string) error {
	for _, h := range e.raceState.Heats {
		if h.RoundID == roundID && !isUnstartedHeatState(h.State) {
			return fmt.Errorf("cannot modify connections into %s because heat %s has already started", h.StageName, h.ShortLabel)
		}
	}
	return nil
}

func (e *Engine) effectiveStage2SeedCountLocked() int {
	return e.effectiveStageSeedCountLocked(2)
}

func defaultStageSeedDistribution(toR *domain.RaceRound) string {
	if toR != nil && (toR.BracketLane == "mains" || toR.StageFormat == domain.FormatPointsMains || toR.StageFormat == domain.FormatChaseTheAce) {
		return "sequential"
	}
	return "snake"
}

func (e *Engine) findFinalsRoundInStageLocked(stageIdx int, excludeRoundID string) *domain.RaceRound {
	for i := range e.raceState.Rounds {
		r := &e.raceState.Rounds[i]
		if r.StageIndex == stageIdx && r.BracketLane == "finals" && r.ID != excludeRoundID {
			return r
		}
	}
	return nil
}

func (e *Engine) countRoundHeatsLocked(roundID string) int {
	n := 0
	for _, h := range e.raceState.Heats {
		if h.RoundID == roundID {
			n++
		}
	}
	if n < 1 {
		if r := e.findRoundByIDLocked(roundID); r != nil && r.TargetHeats > 0 {
			return r.TargetHeats
		}
		return 1
	}
	return n
}

func (e *Engine) connectionFeederCountLocked(c domain.RoundConnection, pph int) int {
	switch c.Mode {
	case "stage_seeds":
		sStart := c.SeedStart
		if sStart < 1 {
			sStart = 1
		}
		sEnd := c.SeedEnd
		if sEnd <= 0 {
			stgIdx := c.StageIndex
			if stgIdx < 1 {
				stgIdx = 2
			}
			sEnd = e.effectiveStageSeedCountLocked(stgIdx)
		}
		if sEnd < sStart {
			return 1
		}
		return sEnd - sStart + 1
	case "standings_top":
		if c.SeedStart >= 1 && c.SeedEnd >= c.SeedStart {
			return c.SeedEnd - c.SeedStart + 1
		}
		if c.Count < 1 {
			activeCnt := len(e.activeEventPilotsForGenerationLocked())
			if activeCnt >= 2 {
				return activeCnt
			}
			return pph
		}
		return c.Count
	case "all_pilots", "all_pilots_ranked":
		return e.countRoundHeatsLocked(c.FromRoundID) * pph
	case "top_per_heat", "bottom_per_heat":
		cnt := c.Count
		if cnt < 1 {
			cnt = 1
		}
		return e.countRoundHeatsLocked(c.FromRoundID) * cnt
	default:
		return 0
	}
}

// inferConnectionModeAndCountLocked inspects the source and target rounds to infer whether the
// user is connecting a Winners round into Redemption (`bottom_per_heat`), advancing Qualifying
// standings (`standings_top`), or progressing to the next bracket round (`top_per_heat` with
// `1..3` picks per heat sized to fill the target round's heats).
func (e *Engine) inferConnectionModeAndCountLocked(
	fromR, toR *domain.RaceRound,
	explicitMode string,
	explicitCount int,
	excludeConnID string,
) (mode string, count int, customCount bool) {
	stgSettings := e.stageSettingsLocked(toR.StageIndex)
	pph := stgSettings.PilotsPerHeat
	if pph < 2 {
		pph = 4
	}
	maxPick := 3
	if pph < maxPick {
		maxPick = pph
	}
	half := pph / 2
	if half < 1 {
		half = 1
	}
	if half > maxPick {
		half = maxPick
	}

	mode = explicitMode
	if mode != "" && explicitCount > 0 {
		return mode, explicitCount, true
	}

	maxTopLeaving := 0
	maxBotLeaving := 0
	for _, c := range e.raceState.Connections {
		if c.ID == excludeConnID || c.Invalid || c.FromRoundID != fromR.ID {
			continue
		}
		if c.Mode == "top_per_heat" && c.Count > maxTopLeaving {
			maxTopLeaving = c.Count
		}
		if c.Mode == "bottom_per_heat" && c.Count > maxBotLeaving {
			maxBotLeaving = c.Count
		}
	}

	if mode == "" {
		if toR.StageFormat == domain.FormatQualifying || toR.BracketLane == "qualifying" {
			mode = "all_pilots"
		} else if fromR.StageFormat == domain.FormatQualifying || fromR.StageFormat == domain.FormatOpenQualifier {
			mode = "standings_top"
		} else {
			isDropToRedemption := (toR.BracketLane == "losers" && fromR.BracketLane != "losers") ||
				maxTopLeaving > 0 ||
				(fromR.HasPos && toR.HasPos && fromR.BracketLane == "winners" && toR.BracketLane != "finals" &&
					(toR.PosY-fromR.PosY) > 180 && math.Abs(toR.PosX-fromR.PosX) < 180)
			if isDropToRedemption {
				mode = "bottom_per_heat"
			} else {
				mode = "top_per_heat"
			}
		}
	}

	if mode == "all_pilots" || mode == "all_pilots_ranked" {
		return mode, 0, false
	}

	if explicitCount > 0 {
		return mode, explicitCount, true
	}

	if mode == "standings_top" {
		if toR.BracketLane == "finals" {
			return mode, pph, false
		}
		if toR.TargetHeats > 0 {
			return mode, toR.TargetHeats * pph, false
		}
		return mode, 0, false
	}

	srcH := e.countRoundHeatsLocked(fromR.ID)
	otherFeeders := 0
	for _, c := range e.raceState.Connections {
		if c.ID == excludeConnID || c.Invalid || c.ToRoundID != toR.ID {
			continue
		}
		otherFeeders += e.connectionFeederCountLocked(c, pph)
	}

	capPerHeat := maxPick
	if mode == "top_per_heat" && maxBotLeaving > 0 && pph-maxBotLeaving >= 1 && pph-maxBotLeaving < capPerHeat {
		capPerHeat = pph - maxBotLeaving
	}
	if mode == "bottom_per_heat" && maxTopLeaving > 0 && pph-maxTopLeaving >= 1 && pph-maxTopLeaving < capPerHeat {
		capPerHeat = pph - maxTopLeaving
	}
	if capPerHeat < 1 {
		capPerHeat = 1
	}

	if toR.BracketLane == "finals" {
		avail := pph - otherFeeders
		if avail < 1 {
			avail = 1
		}
		cnt := avail / srcH
		if cnt < 1 {
			cnt = 1
		}
		if cnt > capPerHeat {
			cnt = capPerHeat
		}
		return mode, cnt, false
	}

	if toR.TargetHeats > 0 {
		avail := toR.TargetHeats*pph - otherFeeders
		cnt := 1
		if avail > srcH {
			cnt = avail / srcH
		}
		if cnt < 1 {
			cnt = 1
		}
		if cnt > capPerHeat {
			cnt = capPerHeat
		}
		return mode, cnt, false
	}

	if mode == "bottom_per_heat" && maxTopLeaving > 0 {
		rem := pph - maxTopLeaving
		if rem < 1 {
			rem = 1
		}
		if rem > capPerHeat {
			rem = capPerHeat
		}
		return mode, rem, false
	}

	return mode, half, false
}

// rebalanceAutoConnectionsIntoLocked adjusts auto-inferred (`!CustomCount`) incoming connections
// into `toRoundID` so multi-round merges into Finals (e.g. Winners Final + Redemption Final -> Finals)
// or into rounds with an explicit `TargetHeats` cleanly divide seats across `1..3` picks per heat.
func (e *Engine) rebalanceAutoConnectionsIntoLocked(toRoundID string) {
	toR := e.findRoundByIDLocked(toRoundID)
	if toR == nil {
		return
	}
	if toR.BracketLane != "finals" && toR.TargetHeats <= 0 {
		return
	}
	stgSettings := e.stageSettingsLocked(toR.StageIndex)
	pph := stgSettings.PilotsPerHeat
	if pph < 2 {
		pph = 4
	}
	maxPick := 3
	if pph < maxPick {
		maxPick = pph
	}

	targetSeats := toR.TargetHeats * pph
	if toR.BracketLane == "finals" {
		targetSeats = pph
	}
	if targetSeats < pph {
		targetSeats = pph
	}

	fixedSeats := 0
	var autoIdx []int
	totalAutoSrcHeats := 0
	for i := range e.raceState.Connections {
		c := &e.raceState.Connections[i]
		if c.Invalid || c.ToRoundID != toRoundID {
			continue
		}
		if !c.CustomCount && (c.Mode == "top_per_heat" || c.Mode == "bottom_per_heat") {
			autoIdx = append(autoIdx, i)
			totalAutoSrcHeats += e.countRoundHeatsLocked(c.FromRoundID)
		} else {
			fixedSeats += e.connectionFeederCountLocked(*c, pph)
		}
	}
	if len(autoIdx) == 0 || totalAutoSrcHeats <= 0 {
		return
	}

	avail := targetSeats - fixedSeats
	perHeat := 1
	if avail >= totalAutoSrcHeats {
		perHeat = avail / totalAutoSrcHeats
	}
	if perHeat < 1 {
		perHeat = 1
	}
	if perHeat > maxPick {
		perHeat = maxPick
	}

	for _, ci := range autoIdx {
		c := &e.raceState.Connections[ci]
		otherModeCap := maxPick
		for _, oc := range e.raceState.Connections {
			if oc.ID == c.ID || oc.Invalid || oc.FromRoundID != c.FromRoundID {
				continue
			}
			if c.Mode == "top_per_heat" && oc.Mode == "bottom_per_heat" && pph-oc.Count >= 1 && pph-oc.Count < otherModeCap {
				otherModeCap = pph - oc.Count
			}
			if c.Mode == "bottom_per_heat" && oc.Mode == "top_per_heat" && pph-oc.Count >= 1 && pph-oc.Count < otherModeCap {
				otherModeCap = pph - oc.Count
			}
		}
		cnt := perHeat
		if cnt > otherModeCap {
			cnt = otherModeCap
		}
		if cnt < 1 {
			cnt = 1
		}
		c.Count = cnt
	}
}

// connectRoundsLocked creates a directed wire from `fromRoundID` to `toRoundID`
// with smart default advancement rules. Even if the wire is invalid (e.g. creates a loop,
// duplicates an existing connection, or targets an already-started round), it is persisted
// with `Invalid: true` + `InvalidReason` so the canvas can highlight it in subtle red and let
// the user drag its endpoint to fix it without blocking their workflow.
func normalizeConnFromPort(port string, fromR *domain.RaceRound) string {
	p := strings.TrimSpace(port)
	if p == "" {
		return ""
	}
	if fromR != nil && (domain.IsStageHandoffInID(fromR.ID) || fromR.BracketLane == "handoff_in" || fromR.BracketLane == "finals") {
		return "right"
	}
	if p == "right" || p == "bottom" {
		return p
	}
	return ""
}

func normalizeConnToPort(port string, toR *domain.RaceRound) string {
	p := strings.TrimSpace(port)
	if p == "" {
		return ""
	}
	if toR != nil && (domain.IsStageHandoffOutID(toR.ID) || toR.BracketLane == "handoff_out") {
		return "left"
	}
	if p == "left" || p == "top" || p == "bottom" {
		return p
	}
	return ""
}

func (e *Engine) connectRoundsLocked(
	fromRoundID, toRoundID, linkMode string,
	advanceCount, seedStart, seedEnd int,
	distribution string,
) error {
	return e.connectRoundsLockedFull(fromRoundID, toRoundID, linkMode, advanceCount, seedStart, seedEnd, distribution, "", "", "")
}

func (e *Engine) connectRoundsLockedWithPorts(
	fromRoundID, toRoundID, linkMode string,
	advanceCount, seedStart, seedEnd int,
	distribution, fromPort, toPort string,
) error {
	return e.connectRoundsLockedFull(fromRoundID, toRoundID, linkMode, advanceCount, seedStart, seedEnd, distribution, "", fromPort, toPort)
}

func isAutoDefaultRaceRoundTitle(title string) bool {
	t := strings.TrimSpace(title)
	if !strings.HasPrefix(t, "Round ") {
		return false
	}
	rest := strings.TrimSpace(strings.TrimPrefix(t, "Round "))
	if len(rest) == 0 {
		return false
	}
	for _, ch := range rest {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return true
}

func isAutoRedemptionRoundTitle(title string) bool {
	t := strings.TrimSpace(title)
	for _, p := range []string{"Redemption R", "Redemption "} {
		if strings.HasPrefix(t, p) {
			rest := strings.TrimSpace(strings.TrimPrefix(t, p))
			if len(rest) > 0 {
				ok := true
				for _, ch := range rest {
					if ch < '0' || ch > '9' {
						ok = false
						break
					}
				}
				if ok {
					return true
				}
			}
		}
	}
	return false
}

func (e *Engine) feederSourceLabelLocked(f *domain.SeatFeeder) string {
	if f == nil {
		return ""
	}
	if f.FromHeatID != "" {
		return fmt.Sprintf("%s · %s", race.Ordinal(f.FromRank), f.FromHeatID)
	}
	if f.FromRoundID != "" {
		if srcR := e.findRoundByIDLocked(f.FromRoundID); srcR != nil {
			if srcR.StageFormat == domain.FormatQualifying || srcR.StageFormat == domain.FormatOpenQualifier || srcR.BracketLane == "qualifying" {
				return fmt.Sprintf("Seed #%d", f.FromStandingsRank)
			}
			return fmt.Sprintf("Seed #%d · %s", f.FromStandingsRank, srcR.Title)
		}
		return fmt.Sprintf("Seed #%d", f.FromStandingsRank)
	}
	if f.FromRoundColumn > 0 {
		return fmt.Sprintf("Seed #%d · R%d", f.FromStandingsRank, f.FromRoundColumn)
	}
	if f.FromStageSeed > 0 {
		return fmt.Sprintf("Seed #%d", f.FromStageSeed)
	}
	return ""
}

// reconcileRedemptionLaneLocked automatically promotes a Race Round (`winners`) to `losers`
// ("Redemption N") when it receives a `bottom_per_heat` drop wire (or only `losers` survivor wires),
// and reverts `losers` back to `winners` ("Round N") if all incoming drop/redemption wires are removed.
func (e *Engine) reconcileRedemptionLaneLocked(roundID string) {
	r := e.findRoundByIDLocked(roundID)
	if r == nil || domain.IsStagePortalRoundID(r.ID) {
		return
	}
	if r.BracketLane != "winners" && r.BracketLane != "losers" {
		return
	}
	if r.StageFormat == domain.FormatQualifying || r.StageFormat == domain.FormatOpenQualifier || r.StageFormat == domain.FormatPointsMains {
		return
	}
	hasBottom := false
	hasNonLosersTop := false
	inCount := 0
	for _, c := range e.raceState.Connections {
		if c.Invalid || c.ToRoundID != roundID {
			continue
		}
		inCount++
		if c.Mode == "bottom_per_heat" {
			hasBottom = true
			continue
		}
		src := e.findRoundByIDLocked(c.FromRoundID)
		if src == nil || src.BracketLane != "losers" {
			hasNonLosersTop = true
		}
	}
	shouldBeLosers := inCount > 0 && (hasBottom || !hasNonLosersTop)
	if shouldBeLosers && r.BracketLane == "winners" {
		r.BracketLane = "losers"
		if isAutoDefaultRaceRoundTitle(r.Title) {
			redCount := 0
			for _, or := range e.raceState.Rounds {
				if or.StageIndex == r.StageIndex && or.ID != r.ID && or.BracketLane == "losers" {
					redCount++
				}
			}
			r.Title = fmt.Sprintf("Redemption R%d", redCount+1)
		}
	} else if !shouldBeLosers && r.BracketLane == "losers" && isAutoRedemptionRoundTitle(r.Title) {
		r.BracketLane = "winners"
		r.Title = fmt.Sprintf("Round %d", r.Round)
	}
}

func (e *Engine) retemplatePostQualifyingOnUnifiedGraphLocked(tpl string) {
	race.MigrateLegacyStagesToUnifiedGraph(&e.raceState)
	race.SyncRoundsMetadata(&e.raceState)

	qualRoundSet := make(map[string]bool)
	var keptRounds []domain.RaceRound
	lastQualID := ""
	maxQualCol := 0
	for _, r := range e.raceState.Rounds {
		if domain.IsStagePortalRoundID(r.ID) {
			continue
		}
		if r.StageFormat == domain.FormatQualifying {
			qualRoundSet[r.ID] = true
			keptRounds = append(keptRounds, r)
			if r.Column >= maxQualCol {
				maxQualCol = r.Column
				lastQualID = r.ID
			}
		}
	}
	var keptHeats []domain.RaceHeat
	for _, h := range e.raceState.Heats {
		if qualRoundSet[h.RoundID] || h.StageFormat == domain.FormatQualifying {
			keptHeats = append(keptHeats, h)
		} else if h.ID == e.raceState.ActiveHeatID {
			e.raceState.ActiveHeatID = ""
		}
	}
	var keptConns []domain.RoundConnection
	for _, c := range e.raceState.Connections {
		if qualRoundSet[c.FromRoundID] && qualRoundSet[c.ToRoundID] {
			keptConns = append(keptConns, c)
		}
	}

	genPilots := e.activeEventPilotsForGenerationLocked()
	if len(genPilots) < 2 {
		for _, ep := range e.raceState.Roster {
			genPilots = append(genPilots, domain.PilotSlot{SlotIndex: ep.SlotIndex, Callsign: ep.Callsign, Color: ep.Color})
		}
	}
	fresh := race.GenerateUnifiedTournament(e.raceState.Config, genPilots, tpl, time.Now().UnixNano())
	freshQualSet := make(map[string]bool)
	freshMaxQualCol := 0
	for _, r := range fresh.Rounds {
		if r.StageFormat == domain.FormatQualifying {
			freshQualSet[r.ID] = true
			if r.Column > freshMaxQualCol {
				freshMaxQualCol = r.Column
			}
		}
	}
	colShift := maxQualCol - freshMaxQualCol
	for _, r := range fresh.Rounds {
		if freshQualSet[r.ID] || domain.IsStagePortalRoundID(r.ID) {
			continue
		}
		r.Column += colShift
		if r.Column <= maxQualCol {
			r.Column = maxQualCol + 1
		}
		keptRounds = append(keptRounds, r)
	}
	for _, c := range fresh.Connections {
		if freshQualSet[c.FromRoundID] && freshQualSet[c.ToRoundID] {
			continue
		}
		if freshQualSet[c.FromRoundID] {
			c.FromRoundID = lastQualID
			c.ID = fmt.Sprintf("conn-%s-%s-%s", lastQualID, c.ToRoundID, c.Mode)
			c.SeededEarly = e.raceState.Stage2SeededEarly
		}
		keptConns = append(keptConns, c)
	}
	for _, h := range fresh.Heats {
		if freshQualSet[h.RoundID] || h.StageFormat == domain.FormatQualifying {
			continue
		}
		h.Column += colShift
		if h.Column <= maxQualCol {
			h.Column = maxQualCol + 1
		}
		for si := range h.Seats {
			if h.Seats[si].Feeder != nil && freshQualSet[h.Seats[si].Feeder.FromRoundID] {
				h.Seats[si].Feeder.FromRoundID = lastQualID
				h.Seats[si].Feeder.FromRoundColumn = maxQualCol
			}
		}
		keptHeats = append(keptHeats, h)
	}
	for i := range keptHeats {
		keptHeats[i].Order = i + 1
	}

	e.raceState.Rounds = keptRounds
	e.raceState.Connections = keptConns
	e.raceState.Heats = keptHeats
	e.raceState.TotalStages = 1
	e.raceState.ActiveStageIndex = 1
	e.raceState.StageConnections = nil
	e.raceState.IsComplete = false
	e.raceState.ChampionSlotIndex = 0
	e.raceState.ChampionCallsign = ""
	if len(fresh.Stages) > 0 {
		e.raceState.Stages = fresh.Stages
	}
	race.RebuildEdgesFromFeeders(&e.raceState)
	race.SyncRoundsMetadata(&e.raceState)
	e.resolveActiveTournamentLocked()
}

func (e *Engine) seedConnectionNowLocked(connID, fromRoundID, roundID string) error {
	race.SyncRoundsMetadata(&e.raceState)
	srcRoundID := fromRoundID
	if srcRoundID == "" {
		srcRoundID = roundID
	}

	var matched []int
	for i := range e.raceState.Connections {
		c := &e.raceState.Connections[i]
		if c.Invalid || (c.Mode != "standings_top" && c.Mode != "all_pilots_ranked") {
			continue
		}
		if connID != "" {
			if c.ID == connID {
				matched = append(matched, i)
			}
		} else if srcRoundID != "" {
			if c.FromRoundID == srcRoundID {
				matched = append(matched, i)
			}
		} else {
			srcR := e.findRoundByIDLocked(c.FromRoundID)
			if srcR != nil && (srcR.StageFormat == domain.FormatQualifying || srcR.StageFormat == domain.FormatOpenQualifier || domain.IsOpenQualRoundID(srcR.ID)) {
				matched = append(matched, i)
			}
		}
	}
	if len(matched) == 0 {
		return fmt.Errorf("no qualifying progression connection found to seed early")
	}

	chainSet := make(map[string]bool)
	for _, idx := range matched {
		for _, cid := range race.QualifierChainRoundIDs(&e.raceState, e.raceState.Connections[idx].FromRoundID) {
			chainSet[cid] = true
		}
	}

	hasConfirmed := false
	for _, h := range e.raceState.Heats {
		if chainSet[h.RoundID] && h.State == domain.HeatConfirmed {
			hasConfirmed = true
			break
		}
	}
	if !hasConfirmed {
		return fmt.Errorf("confirm at least one qualifying heat before seeding downstream rounds")
	}

	// For Open Qualifier / ZippyQ rounds in the chain, discard unstarted queued walk-up packs
	keptHeats := make([]domain.RaceHeat, 0, len(e.raceState.Heats))
	for _, h := range e.raceState.Heats {
		if chainSet[h.RoundID] && h.StageFormat == domain.FormatOpenQualifier && isUnstartedHeatState(h.State) {
			if e.raceState.ActiveHeatID == h.ID {
				e.raceState.ActiveHeatID = ""
			}
			continue
		}
		keptHeats = append(keptHeats, h)
	}
	e.raceState.Heats = keptHeats
	for i := range e.raceState.Heats {
		e.raceState.Heats[i].Order = i + 1
	}

	for _, idx := range matched {
		e.raceState.Connections[idx].SeededEarly = true
	}
	// Resolve concrete standings into direct target rounds, then cascade down the entire DAG
	// (sizing Open Qualifier "All" brackets to actual contenders and rotating concrete pilots across all_pilots chains).
	for _, idx := range matched {
		srcID := e.raceState.Connections[idx].FromRoundID
		stgIdx := e.raceState.Connections[idx].StageIndex
		if stgIdx < 1 {
			stgIdx = 1
		}
		e.cascadeBalancedRoundsFromLocked(stgIdx, srcID)
	}
	e.resolveActiveTournamentLocked()
	for _, idx := range matched {
		dstID := e.raceState.Connections[idx].ToRoundID
		stgIdx := e.raceState.Connections[idx].StageIndex
		if stgIdx < 1 {
			stgIdx = 1
		}
		e.cascadeBalancedRoundsFromLocked(stgIdx, dstID)
	}
	return nil
}

func (e *Engine) reopenConnectionSeedLocked(connID, fromRoundID, roundID string) error {
	race.SyncRoundsMetadata(&e.raceState)
	srcRoundID := fromRoundID
	if srcRoundID == "" {
		srcRoundID = roundID
	}

	var matched []int
	for i := range e.raceState.Connections {
		c := &e.raceState.Connections[i]
		if !c.SeededEarly {
			continue
		}
		if connID != "" && c.ID != connID {
			continue
		}
		if connID == "" && srcRoundID != "" && c.FromRoundID != srcRoundID {
			continue
		}
		matched = append(matched, i)
	}
	if len(matched) == 0 && !e.raceState.Stage2SeededEarly {
		return nil
	}

	// Ensure no downstream round reachable from `matched` already has started/confirmed heats
	adj := make(map[string][]string)
	for _, c := range e.raceState.Connections {
		if !c.Invalid {
			adj[c.FromRoundID] = append(adj[c.FromRoundID], c.ToRoundID)
		}
	}
	downstream := make(map[string]bool)
	var queue []string
	for _, idx := range matched {
		queue = append(queue, e.raceState.Connections[idx].ToRoundID)
	}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if downstream[cur] {
			continue
		}
		downstream[cur] = true
		queue = append(queue, adj[cur]...)
	}
	for _, h := range e.raceState.Heats {
		if downstream[h.RoundID] && !isUnstartedHeatState(h.State) && !(h.State == domain.HeatConfirmed && h.Note == "Auto-advance (bye)") {
			return fmt.Errorf("cannot reopen qualifying seeding after %s has already started", h.ShortLabel)
		}
	}

	for _, idx := range matched {
		e.raceState.Connections[idx].SeededEarly = false
	}
	e.raceState.Stage2SeededEarly = false
	for _, idx := range matched {
		srcID := e.raceState.Connections[idx].FromRoundID
		stgIdx := e.raceState.Connections[idx].StageIndex
		if stgIdx < 1 {
			stgIdx = 1
		}
		e.cascadeBalancedRoundsFromLocked(stgIdx, srcID)
	}
	return nil
}

func (e *Engine) reshuffleRoundLocked(roundID, distribution string) error {
	race.SyncRoundsMetadata(&e.raceState)
	targetID := roundID
	if targetID == "" {
		for _, r := range e.raceState.Rounds {
			if !domain.IsStagePortalRoundID(r.ID) && r.SeedSource == "all_active_pilots" {
				targetID = r.ID
				break
			}
		}
	}
	r := e.findRoundByIDLocked(targetID)
	if r == nil {
		return fmt.Errorf("round not found")
	}
	if err := e.ensureRoundUnstartedLocked(r.ID); err != nil {
		return err
	}
	e.raceState.TemplateID = "custom"
	e.markStageCustomizedLocked(r.StageIndex)
	r.SeedSource = "all_active_pilots"
	if distribution == "snake" || distribution == "sequential" || distribution == "roster" || distribution == "random" {
		r.SeedDistribution = distribution
	} else {
		r.SeedDistribution = "random"
	}
	e.nextRaceSeq++
	r.RandomSeed = time.Now().UnixNano() + int64(e.nextRaceSeq)*7919
	for hi := range e.raceState.Heats {
		if e.raceState.Heats[hi].RoundID == r.ID && isUnstartedHeatState(e.raceState.Heats[hi].State) {
			for si := range e.raceState.Heats[hi].Seats {
				e.raceState.Heats[hi].Seats[si].ManualLock = false
			}
		}
	}
	e.rebuildSingleRoundLocked(r.ID)
	e.cascadeBalancedRoundsFromLocked(r.StageIndex, r.ID)
	e.sortCustomHeatsAndOrderLocked(r.StageIndex)
	race.RebuildEdgesFromFeeders(&e.raceState)
	race.SyncRoundsMetadata(&e.raceState)
	return nil
}

func (e *Engine) connectRoundsLockedFull(
	fromRoundID, toRoundID, linkMode string,
	advanceCount, seedStart, seedEnd int,
	distribution string,
	rankingMetric domain.QualifyingMetric,
	fromPort, toPort string,
) error {
	race.SyncRoundsMetadata(&e.raceState)

	// Checked-In Pilots canvas source node (`stageN-pilots-in`) -> starting round wire
	if pilotsStageIdx, ok := parsePilotsPortalStageIndex(fromRoundID); ok {
		toR := e.findRoundByIDLocked(toRoundID)
		if toR == nil {
			return fmt.Errorf("target round not found")
		}
		if domain.IsStagePortalRoundID(toR.ID) {
			return fmt.Errorf("cannot connect Checked-In Pilots directly to a stage portal")
		}
		if toR.StageIndex != pilotsStageIdx {
			return fmt.Errorf("cannot connect Checked-In Pilots across different stages")
		}
		if len(race.IncomingStageConnections(&e.raceState, pilotsStageIdx)) > 0 {
			return fmt.Errorf("this stage receives pilots from an upstream stage - connect from Incoming Seeds instead")
		}
		if err := e.ensureRoundUnstartedLocked(toR.ID); err != nil {
			return err
		}
		e.raceState.TemplateID = "custom"
		e.markStageCustomizedLocked(toR.StageIndex)
		kept := make([]domain.RoundConnection, 0, len(e.raceState.Connections))
		for _, c := range e.raceState.Connections {
			if c.ToRoundID != toR.ID {
				kept = append(kept, c)
			}
		}
		e.raceState.Connections = kept
		toR.SeedSource = "all_active_pilots"
		toR.SeedToPort = normalizeConnToPort(toPort, toR)
		if distribution == "roster" || distribution == "snake" || distribution == "sequential" || distribution == "random" {
			toR.SeedDistribution = distribution
		}
		e.recomputeGraphAndRebuildLocked(toR.StageIndex, toR.ID)
		return nil
	}

	fromR := e.findRoundByIDLocked(fromRoundID)
	toR := e.findRoundByIDLocked(toRoundID)
	if fromR == nil || toR == nil {
		return fmt.Errorf("source or target round not found")
	}
	normFromPort := normalizeConnFromPort(fromPort, fromR)
	normToPort := normalizeConnToPort(toPort, toR)

	// Stage output seeding portal wire
	if domain.IsStageHandoffOutID(toR.ID) && !domain.IsStageHandoffOutID(fromR.ID) && fromR.StageIndex == toR.StageIndex {
		newConn := domain.RoundConnection{
			ID:          e.nextUniqueIDLocked("conn"),
			StageIndex:  fromR.StageIndex,
			FromRoundID: fromR.ID,
			ToRoundID:   toR.ID,
			FromPort:    normFromPort,
			ToPort:      "left",
			Mode:        "qual_feed",
			Count:       e.raceState.Config.Stage2MaxSeeds,
		}
		if e.anyDownstreamStageStartedLocked(fromR.StageIndex) {
			newConn.Invalid = true
			newConn.InvalidReason = fmt.Sprintf("%s Downstream stage heats have already started, so stage seeding wires are locked.", startedTargetConnPrefix)
		}
		e.raceState.TemplateID = "custom"
		e.markStageCustomizedLocked(fromR.StageIndex)
		e.raceState.Connections = append(e.raceState.Connections, newConn)
		e.validateConnectionsLocked()
		e.recomputeGraphColumnsOnlyLocked(fromR.StageIndex)
		return nil
	}

	customCount := false
	// Incoming Seeds portal -> Stage round wire
	if domain.IsStageHandoffInID(fromR.ID) {
		linkMode = "stage_seeds"
		if seedStart < 1 {
			seedStart = 1
		}
		if seedEnd <= 0 && toR.BracketLane == "finals" {
			seedEnd = e.stageSettingsLocked(toR.StageIndex).PilotsPerHeat
		} else if seedEnd < 0 {
			seedEnd = 0
		}
		if distribution != "snake" && distribution != "sequential" {
			distribution = defaultStageSeedDistribution(toR)
		}
	} else if linkMode != "stage_seeds" {
		linkMode, advanceCount, customCount = e.inferConnectionModeAndCountLocked(fromR, toR, linkMode, advanceCount, "")
	}

	stgIdx := toR.StageIndex
	if stgIdx < 1 {
		stgIdx = fromR.StageIndex
	}
	newConn := domain.RoundConnection{
		ID:          e.nextUniqueIDLocked("conn"),
		StageIndex:  stgIdx,
		FromRoundID: fromR.ID,
		ToRoundID:   toR.ID,
		FromPort:    normFromPort,
		ToPort:      normToPort,
		Mode:        linkMode,
		Count:       advanceCount,
		CustomCount: customCount,
	}
	if linkMode == "stage_seeds" || linkMode == "standings_top" || linkMode == "all_pilots_ranked" {
		if seedStart >= 1 {
			newConn.SeedStart = seedStart
		}
		if seedEnd >= 1 {
			newConn.SeedEnd = seedEnd
			if newConn.SeedStart < 1 {
				newConn.SeedStart = 1
			}
			if newConn.SeedEnd >= newConn.SeedStart {
				newConn.Count = newConn.SeedEnd - newConn.SeedStart + 1
				newConn.CustomCount = true
			}
		} else if linkMode == "stage_seeds" {
			newConn.SeedStart = seedStart
			newConn.SeedEnd = seedEnd
		}
		if distribution == "snake" || distribution == "sequential" {
			newConn.Distribution = distribution
		} else if linkMode == "stage_seeds" || linkMode == "standings_top" {
			newConn.Distribution = defaultStageSeedDistribution(toR)
		}
		if rankingMetric != "" {
			newConn.RankingMetric = rankingMetric
		}
	}
	if !domain.IsStagePortalRoundID(toR.ID) && e.ensureRoundUnstartedLocked(toR.ID) != nil {
		newConn.Invalid = true
		newConn.InvalidReason = fmt.Sprintf("%s %s already has started or confirmed heats and cannot accept new incoming connections.", startedTargetConnPrefix, toR.Title)
	}

	e.raceState.TemplateID = "custom"
	e.markStageCustomizedLocked(stgIdx)
	e.raceState.Connections = append(e.raceState.Connections, newConn)
	if !newConn.Invalid {
		e.rebalanceAutoConnectionsIntoLocked(toR.ID)
	}
	e.validateConnectionsLocked()

	addedConn := e.raceState.Connections[len(e.raceState.Connections)-1]
	if !addedConn.Invalid {
		toR.SeedSource = ""
		e.reconcileRedemptionLaneLocked(toR.ID)
		e.recomputeGraphAndRebuildLocked(toR.StageIndex, toR.ID)
	} else {
		race.SyncRoundsMetadata(&e.raceState)
	}
	return nil
}

// reconnectRoundConnectionLocked moves either endpoint (`newFromRoundID` and/or `newToRoundID`)
// of an existing connection in-place without requiring the user to delete and recreate the wire.
func (e *Engine) reconnectRoundConnectionLocked(
	connID, newFromRoundID, newToRoundID, linkMode, fromPort, toPort string,
) error {
	race.SyncRoundsMetadata(&e.raceState)

	// Reconnecting an existing Checked-In Pilots wire (`conn-stageN-pilots-in-<oldToID>`)
	if pStageIdx, oldTargetID, isPilotsConn := extractPilotsConnTargetID(connID); isPilotsConn {
		targetFrom := newFromRoundID
		if targetFrom == "" {
			targetFrom = domain.StagePilotsInID(pStageIdx)
		}
		targetTo := newToRoundID
		if targetTo == "" {
			targetTo = oldTargetID
		}
		if targetTo == oldTargetID && domain.IsStagePilotsInID(targetFrom) {
			if oldR := e.findRoundByIDLocked(oldTargetID); oldR != nil && toPort != "" {
				nextPort := normalizeConnToPort(toPort, oldR)
				if oldR.SeedToPort != nextPort {
					e.raceState.TemplateID = "custom"
					e.markStageCustomizedLocked(oldR.StageIndex)
					oldR.SeedToPort = nextPort
					race.SyncRoundsMetadata(&e.raceState)
				}
			}
			return nil
		}
		if err := e.ensureRoundUnstartedLocked(oldTargetID); err != nil {
			return err
		}
		oldR := e.findRoundByIDLocked(oldTargetID)
		savedDist := ""
		if oldR != nil {
			savedDist = oldR.SeedDistribution
		}
		if !domain.IsStagePilotsInID(targetFrom) {
			if oldR != nil {
				e.raceState.TemplateID = "custom"
				e.markStageCustomizedLocked(oldR.StageIndex)
				oldR.SeedSource = "empty"
				e.recomputeGraphAndRebuildLocked(oldR.StageIndex, oldTargetID)
			}
			return e.connectRoundsLockedWithPorts(targetFrom, targetTo, linkMode, 0, 1, 0, savedDist, fromPort, toPort)
		}
		if err := e.connectRoundsLockedWithPorts(targetFrom, targetTo, "pilots_in", 0, 0, 0, savedDist, fromPort, toPort); err != nil {
			return err
		}
		if oldR := e.findRoundByIDLocked(oldTargetID); oldR != nil && oldTargetID != targetTo {
			oldR.SeedSource = "empty"
			e.recomputeGraphAndRebuildLocked(oldR.StageIndex, oldTargetID)
		}
		return nil
	}

	idx := -1
	for i := range e.raceState.Connections {
		if connID != "" && e.raceState.Connections[i].ID == connID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return fmt.Errorf("connection not found")
	}

	orig := e.raceState.Connections[idx]
	targetFromID := orig.FromRoundID
	if newFromRoundID != "" {
		targetFromID = newFromRoundID
	}
	targetToID := orig.ToRoundID
	if newToRoundID != "" {
		targetToID = newToRoundID
	}

	// Moving a regular round wire's source port onto the Checked-In Pilots node
	if domain.IsStagePilotsInID(targetFromID) {
		if !orig.Invalid && orig.ToRoundID != targetToID && !domain.IsStageHandoffOutID(orig.ToRoundID) {
			if err := e.ensureRoundUnstartedLocked(orig.ToRoundID); err != nil {
				return err
			}
		}
		e.raceState.Connections = append(e.raceState.Connections[:idx], e.raceState.Connections[idx+1:]...)
		if orig.ToRoundID != targetToID && !domain.IsStagePortalRoundID(orig.ToRoundID) {
			if oldToR := e.findRoundByIDLocked(orig.ToRoundID); oldToR != nil && e.ensureRoundUnstartedLocked(orig.ToRoundID) == nil {
				oldToR.SeedSource = "empty"
				e.recomputeGraphAndRebuildLocked(oldToR.StageIndex, orig.ToRoundID)
			}
		}
		return e.connectRoundsLockedWithPorts(targetFromID, targetToID, "pilots_in", 0, 0, 0, "", fromPort, toPort)
	}

	fromR := e.findRoundByIDLocked(targetFromID)
	toR := e.findRoundByIDLocked(targetToID)
	if fromR == nil || toR == nil {
		return fmt.Errorf("source or target round not found")
	}

	nextFromPort := normalizeConnFromPort(orig.FromPort, fromR)
	if normFP := normalizeConnFromPort(fromPort, fromR); normFP != "" {
		nextFromPort = normFP
	}
	nextToPort := normalizeConnToPort(orig.ToPort, toR)
	if normTP := normalizeConnToPort(toPort, toR); normTP != "" {
		nextToPort = normTP
	}

	// No-op or port-only update if dropped back onto exact same endpoints with no mode change
	if targetFromID == orig.FromRoundID && targetToID == orig.ToRoundID && (linkMode == "" || linkMode == orig.Mode) {
		if nextFromPort != orig.FromPort || nextToPort != orig.ToPort {
			e.raceState.TemplateID = "custom"
			e.markStageCustomizedLocked(toR.StageIndex)
			e.raceState.Connections[idx].FromPort = nextFromPort
			e.raceState.Connections[idx].ToPort = nextToPort
			e.validateConnectionsLocked()
			race.SyncRoundsMetadata(&e.raceState)
		}
		return nil
	}

	// Guard against detaching an active valid wire from an already-started round
	if !orig.Invalid && orig.ToRoundID != targetToID {
		if domain.IsStageHandoffOutID(orig.ToRoundID) && e.anyDownstreamStageStartedLocked(orig.StageIndex) {
			return fmt.Errorf("cannot detach stage seeding wire after downstream stage heats have started")
		}
		if !domain.IsStageHandoffOutID(orig.ToRoundID) {
			if err := e.ensureRoundUnstartedLocked(orig.ToRoundID); err != nil {
				return err
			}
		}
	}

	cfg := e.raceState.Config.Normalized()

	moved := orig
	moved.FromRoundID = fromR.ID
	moved.ToRoundID = toR.ID
	moved.FromPort = nextFromPort
	moved.ToPort = nextToPort
	moved.StageIndex = toR.StageIndex
	moved.Invalid = false
	moved.InvalidReason = ""

	if domain.IsStageHandoffOutID(toR.ID) {
		moved.Mode = "qual_feed"
		moved.Count = cfg.Stage2MaxSeeds
		moved.CustomCount = false
		if orig.ToRoundID != targetToID && e.anyDownstreamStageStartedLocked(fromR.StageIndex) {
			moved.Invalid = true
			moved.InvalidReason = fmt.Sprintf("%s Downstream stage heats have already started, so stage seeding wires are locked.", startedTargetConnPrefix)
		}
	} else if domain.IsStageHandoffInID(fromR.ID) {
		moved.Mode = "stage_seeds"
		if moved.SeedStart < 1 {
			moved.SeedStart = 1
		}
		if toR.BracketLane == "finals" && moved.SeedEnd <= 0 {
			moved.SeedEnd = e.stageSettingsLocked(toR.StageIndex).PilotsPerHeat
		}
		if moved.Distribution != "snake" && moved.Distribution != "sequential" {
			moved.Distribution = defaultStageSeedDistribution(toR)
		}
	} else {
		expCount := 0
		if orig.CustomCount && orig.FromRoundID == fromR.ID && orig.ToRoundID == toR.ID {
			expCount = orig.Count
		}
		inferredMode, inferredCnt, isCustom := e.inferConnectionModeAndCountLocked(fromR, toR, linkMode, expCount, orig.ID)
		moved.Mode = inferredMode
		moved.Count = inferredCnt
		moved.CustomCount = isCustom
	}

	if orig.ToRoundID != targetToID && !domain.IsStagePortalRoundID(toR.ID) {
		if e.ensureRoundUnstartedLocked(toR.ID) != nil {
			moved.Invalid = true
			moved.InvalidReason = fmt.Sprintf("%s %s already has started or confirmed heats and cannot accept new incoming connections.", startedTargetConnPrefix, toR.Title)
		}
	}

	e.raceState.TemplateID = "custom"
	e.markStageCustomizedLocked(toR.StageIndex)
	// Place moved wire at the end of Connections so pre-existing untouched wires keep priority during validation
	withoutIdx := make([]domain.RoundConnection, 0, len(e.raceState.Connections))
	for i, c := range e.raceState.Connections {
		if i != idx {
			withoutIdx = append(withoutIdx, c)
		}
	}
	withoutIdx = append(withoutIdx, moved)
	e.raceState.Connections = withoutIdx

	if !moved.Invalid {
		e.rebalanceAutoConnectionsIntoLocked(toR.ID)
	}
	if orig.ToRoundID != targetToID && !orig.Invalid {
		e.rebalanceAutoConnectionsIntoLocked(orig.ToRoundID)
	}

	newlyValid := e.validateConnectionsLocked()
	movedAfter := e.raceState.Connections[len(e.raceState.Connections)-1]

	// Clean up old target round if a valid incoming wire was detached
	if orig.ToRoundID != targetToID && !domain.IsStagePortalRoundID(orig.ToRoundID) {
		if !orig.Invalid {
			remainingValidIn := 0
			for _, c := range e.raceState.Connections {
				if !c.Invalid && c.ToRoundID == orig.ToRoundID {
					remainingValidIn++
				}
			}
			if oldToR := e.findRoundByIDLocked(orig.ToRoundID); oldToR != nil {
				if remainingValidIn == 0 && oldToR.SeedSource != "all_active_pilots" && e.ensureRoundUnstartedLocked(orig.ToRoundID) == nil {
					oldToR.SeedSource = "empty"
				}
				e.reconcileRedemptionLaneLocked(orig.ToRoundID)
				e.recomputeGraphAndRebuildLocked(oldToR.StageIndex, orig.ToRoundID, orig.FromRoundID)
			}
		} else if len(newlyValid) > 0 {
			if oldToR := e.findRoundByIDLocked(orig.ToRoundID); oldToR != nil {
				e.reconcileRedemptionLaneLocked(orig.ToRoundID)
				e.recomputeGraphAndRebuildLocked(oldToR.StageIndex, "")
			}
		}
	}

	if !movedAfter.Invalid {
		if domain.IsStageHandoffOutID(toR.ID) {
			e.recomputeGraphColumnsOnlyLocked(toR.StageIndex)
		} else if targetR := e.findRoundByIDLocked(targetToID); targetR != nil {
			targetR.SeedSource = ""
			e.reconcileRedemptionLaneLocked(targetToID)
			e.recomputeGraphAndRebuildLocked(targetR.StageIndex, targetToID, orig.FromRoundID)
		}
	} else {
		if domain.IsStageHandoffOutID(orig.ToRoundID) {
			e.recomputeGraphColumnsOnlyLocked(orig.StageIndex)
		} else {
			race.SyncRoundsMetadata(&e.raceState)
		}
	}
	return nil
}

func (e *Engine) updateRoundConnectionLocked(
	connID, fromRoundID, toRoundID, linkMode string,
	advanceCount, seedStart, seedEnd int,
	distribution string,
) error {
	return e.updateRoundConnectionFullLocked(connID, fromRoundID, toRoundID, linkMode, advanceCount, seedStart, seedEnd, distribution, "")
}

func (e *Engine) updateRoundConnectionFullLocked(
	connID, fromRoundID, toRoundID, linkMode string,
	advanceCount, seedStart, seedEnd int,
	distribution string,
	rankingMetric domain.QualifyingMetric,
) error {
	race.SyncRoundsMetadata(&e.raceState)
	if _, pToID, isPilotsConn := extractPilotsConnTargetID(connID); isPilotsConn || domain.IsStagePilotsInID(fromRoundID) {
		targetID := toRoundID
		if targetID == "" {
			targetID = pToID
		}
		toR := e.findRoundByIDLocked(targetID)
		if toR == nil {
			return fmt.Errorf("target round not found")
		}
		if err := e.ensureRoundUnstartedLocked(toR.ID); err != nil {
			return err
		}
		e.raceState.TemplateID = "custom"
		e.markStageCustomizedLocked(toR.StageIndex)
		toR.SeedSource = "all_active_pilots"
		if distribution == "roster" || distribution == "snake" || distribution == "sequential" || distribution == "random" {
			toR.SeedDistribution = distribution
		}
		// Clear ManualLock on this round when organizer explicitly re-applies a Pilots wire seeding order
		for hi := range e.raceState.Heats {
			if e.raceState.Heats[hi].RoundID == toR.ID && isUnstartedHeatState(e.raceState.Heats[hi].State) {
				for si := range e.raceState.Heats[hi].Seats {
					e.raceState.Heats[hi].Seats[si].ManualLock = false
				}
			}
		}
		e.recomputeGraphAndRebuildLocked(toR.StageIndex, toR.ID)
		return nil
	}
	idx := -1
	for i := range e.raceState.Connections {
		c := e.raceState.Connections[i]
		if (connID != "" && c.ID == connID) || (connID == "" && c.FromRoundID == fromRoundID && c.ToRoundID == toRoundID) {
			idx = i
			break
		}
	}
	if idx < 0 {
		return fmt.Errorf("connection not found")
	}
	toID := e.raceState.Connections[idx].ToRoundID
	fromID := e.raceState.Connections[idx].FromRoundID
	if domain.IsStageHandoffOutID(toID) {
		return nil
	}
	if !e.raceState.Connections[idx].Invalid {
		if err := e.ensureRoundUnstartedLocked(toID); err != nil {
			return err
		}
	}
	e.raceState.TemplateID = "custom"
	e.markStageCustomizedLocked(e.raceState.Connections[idx].StageIndex)
	if domain.IsStageHandoffInID(fromID) {
		e.raceState.Connections[idx].Mode = "stage_seeds"
		if seedStart >= 1 {
			e.raceState.Connections[idx].SeedStart = seedStart
		} else if e.raceState.Connections[idx].SeedStart < 1 {
			e.raceState.Connections[idx].SeedStart = 1
		}
		if seedEnd >= 0 {
			e.raceState.Connections[idx].SeedEnd = seedEnd
		}
		if distribution == "snake" || distribution == "sequential" {
			e.raceState.Connections[idx].Distribution = distribution
		} else if e.raceState.Connections[idx].Distribution == "" {
			e.raceState.Connections[idx].Distribution = defaultStageSeedDistribution(e.findRoundByIDLocked(toID))
		}
	} else {
		if linkMode != "" {
			e.raceState.Connections[idx].Mode = linkMode
		}
		curMode := e.raceState.Connections[idx].Mode
		if curMode == "standings_top" || curMode == "all_pilots_ranked" {
			if seedStart >= 1 && seedEnd >= seedStart {
				e.raceState.Connections[idx].SeedStart = seedStart
				e.raceState.Connections[idx].SeedEnd = seedEnd
				e.raceState.Connections[idx].Count = seedEnd - seedStart + 1
				e.raceState.Connections[idx].CustomCount = true
			} else if advanceCount > 0 {
				e.raceState.Connections[idx].SeedStart = 0
				e.raceState.Connections[idx].SeedEnd = 0
				e.raceState.Connections[idx].Count = advanceCount
				e.raceState.Connections[idx].CustomCount = true
			} else if seedStart == 0 && seedEnd == 0 && advanceCount == 0 && linkMode == "standings_top" {
				// All qualified pilots
				e.raceState.Connections[idx].SeedStart = 0
				e.raceState.Connections[idx].SeedEnd = 0
				e.raceState.Connections[idx].Count = 0
			}
			if distribution == "snake" || distribution == "sequential" {
				e.raceState.Connections[idx].Distribution = distribution
			}
			if rankingMetric != "" {
				e.raceState.Connections[idx].RankingMetric = rankingMetric
			}
		} else if advanceCount > 0 {
			e.raceState.Connections[idx].Count = advanceCount
			e.raceState.Connections[idx].CustomCount = true
		}
		// Keep any non-custom companion drop/advance wire on the same source round complementary
		// so changing Top N on a Winners round automatically adjusts its auto Redemption drop count.
		updated := e.raceState.Connections[idx]
		if updated.Count > 0 && (updated.Mode == "top_per_heat" || updated.Mode == "bottom_per_heat") {
			pph := e.stageSettingsLocked(updated.StageIndex).PilotsPerHeat
			if pph < 2 {
				pph = 4
			}
			rem := pph - updated.Count
			if rem < 1 {
				rem = 1
			}
			if rem > pph-1 && pph > 1 {
				rem = pph - 1
			}
			wantCompanion := "bottom_per_heat"
			if updated.Mode == "bottom_per_heat" {
				wantCompanion = "top_per_heat"
			}
			for oi := range e.raceState.Connections {
				if oi == idx {
					continue
				}
				oc := &e.raceState.Connections[oi]
				if !oc.Invalid && oc.FromRoundID == fromID && oc.Mode == wantCompanion && !oc.CustomCount {
					if e.ensureRoundUnstartedLocked(oc.ToRoundID) == nil {
						oc.Count = rem
					}
				}
			}
		}
	}
	e.validateConnectionsLocked()
	if toR := e.findRoundByIDLocked(toID); toR != nil {
		e.reconcileRedemptionLaneLocked(toID)
		e.recomputeGraphAndRebuildLocked(toR.StageIndex, toID, fromID)
	}
	return nil
}

func (e *Engine) disconnectRoundsLocked(connID, fromRoundID, toRoundID string) error {
	race.SyncRoundsMetadata(&e.raceState)
	if _, pToID, isPilotsConn := extractPilotsConnTargetID(connID); isPilotsConn || domain.IsStagePilotsInID(fromRoundID) {
		targetID := toRoundID
		if targetID == "" {
			targetID = pToID
		}
		toR := e.findRoundByIDLocked(targetID)
		if toR == nil {
			return fmt.Errorf("target round not found")
		}
		if err := e.ensureRoundUnstartedLocked(toR.ID); err != nil {
			return err
		}
		e.raceState.TemplateID = "custom"
		e.markStageCustomizedLocked(toR.StageIndex)
		toR.SeedSource = "empty"
		for hi := range e.raceState.Heats {
			if e.raceState.Heats[hi].RoundID == toR.ID && isUnstartedHeatState(e.raceState.Heats[hi].State) {
				for si := range e.raceState.Heats[hi].Seats {
					e.raceState.Heats[hi].Seats[si].ManualLock = false
				}
			}
		}
		e.recomputeGraphAndRebuildLocked(toR.StageIndex, toR.ID)
		return nil
	}
	idx := -1
	for i := range e.raceState.Connections {
		c := e.raceState.Connections[i]
		if (connID != "" && c.ID == connID) || (connID == "" && c.FromRoundID == fromRoundID && c.ToRoundID == toRoundID) {
			idx = i
			break
		}
	}
	if idx < 0 {
		return fmt.Errorf("connection not found")
	}
	wasInvalid := e.raceState.Connections[idx].Invalid
	toID := e.raceState.Connections[idx].ToRoundID
	stgIdx := e.raceState.Connections[idx].StageIndex
	if domain.IsStageHandoffOutID(toID) {
		if !wasInvalid && e.anyDownstreamStageStartedLocked(stgIdx) {
			return fmt.Errorf("cannot change stage seeding rounds after downstream stage heats have started")
		}
		e.raceState.TemplateID = "custom"
		e.markStageCustomizedLocked(stgIdx)
		e.raceState.Connections = append(e.raceState.Connections[:idx], e.raceState.Connections[idx+1:]...)
		e.validateConnectionsLocked()
		e.recomputeGraphColumnsOnlyLocked(stgIdx)
		return nil
	}
	if !wasInvalid {
		if err := e.ensureRoundUnstartedLocked(toID); err != nil {
			return err
		}
	}
	e.raceState.TemplateID = "custom"
	e.markStageCustomizedLocked(stgIdx)
	e.raceState.Connections = append(e.raceState.Connections[:idx], e.raceState.Connections[idx+1:]...)
	if !wasInvalid {
		e.rebalanceAutoConnectionsIntoLocked(toID)
	}
	newlyValid := e.validateConnectionsLocked()

	remainingIn := 0
	for _, c := range e.raceState.Connections {
		if !c.Invalid && c.ToRoundID == toID {
			remainingIn++
		}
	}
	if toR := e.findRoundByIDLocked(toID); toR != nil {
		if !wasInvalid && remainingIn == 0 && e.ensureRoundUnstartedLocked(toID) == nil {
			toR.SeedSource = "empty"
		}
		e.reconcileRedemptionLaneLocked(toID)
		if !wasInvalid || len(newlyValid) > 0 {
			e.recomputeGraphAndRebuildLocked(toR.StageIndex, "")
		} else {
			race.SyncRoundsMetadata(&e.raceState)
		}
	}
	return nil
}

func (e *Engine) setRoundSeedSourceLocked(roundID, linkMode string) error {
	return e.setRoundSeedSourceWithDistLocked(roundID, linkMode, "")
}

func (e *Engine) setRoundSeedSourceWithDistLocked(roundID, linkMode, distribution string) error {
	race.SyncRoundsMetadata(&e.raceState)
	r := e.findRoundByIDLocked(roundID)
	if r == nil {
		return fmt.Errorf("round not found")
	}
	if err := e.ensureRoundUnstartedLocked(r.ID); err != nil {
		return err
	}
	e.raceState.TemplateID = "custom"
	e.markStageCustomizedLocked(r.StageIndex)
	kept := make([]domain.RoundConnection, 0, len(e.raceState.Connections))
	for _, c := range e.raceState.Connections {
		if c.ToRoundID != r.ID {
			kept = append(kept, c)
		}
	}
	e.raceState.Connections = kept
	if linkMode == "all_active_pilots" {
		r.SeedSource = "all_active_pilots"
		if distribution == "random" || distribution == "snake" || distribution == "sequential" || distribution == "roster" {
			r.SeedDistribution = distribution
		}
	} else {
		r.SeedSource = "empty"
	}
	e.reconcileRedemptionLaneLocked(r.ID)
	e.recomputeGraphAndRebuildLocked(r.StageIndex, r.ID)
	return nil
}

func (e *Engine) linkExistingRoundLocked(
	roundID string,
	col int,
	lane string,
	linkMode string,
	sourceCol int,
	sourceLane string,
	advanceCount int,
) error {
	race.SyncRoundsMetadata(&e.raceState)
	stageIdx := e.raceState.ActiveStageIndex
	targetID := roundID
	if targetID == "" {
		for _, r := range e.raceState.Rounds {
			if r.StageIndex == stageIdx && r.Column == col && (lane == "" || r.BracketLane == lane) {
				targetID = r.ID
				break
			}
		}
	}
	if targetID == "" {
		return fmt.Errorf("target round not found")
	}
	if linkMode == "all_active_pilots" || linkMode == "clear_links" || linkMode == "none" || linkMode == "empty" {
		mode := "empty"
		if linkMode == "all_active_pilots" {
			mode = "all_active_pilots"
		}
		return e.setRoundSeedSourceLocked(targetID, mode)
	}
	// Clear existing incoming wires to targetID and connect from sourceCol
	if err := e.ensureRoundUnstartedLocked(targetID); err != nil {
		return err
	}
	if sourceCol <= 0 {
		if tr := e.findRoundByIDLocked(targetID); tr != nil {
			sourceCol = tr.Column - 1
		}
	}
	srcID := ""
	for _, r := range e.raceState.Rounds {
		if r.ID != targetID && r.StageIndex == stageIdx && r.Column == sourceCol && (sourceLane == "" || r.BracketLane == sourceLane) {
			srcID = r.ID
			break
		}
	}
	if srcID == "" {
		return fmt.Errorf("source round not found")
	}
	kept := make([]domain.RoundConnection, 0, len(e.raceState.Connections))
	for _, c := range e.raceState.Connections {
		if c.ToRoundID != targetID {
			kept = append(kept, c)
		}
	}
	e.raceState.Connections = kept
	return e.connectRoundsLocked(srcID, targetID, linkMode, advanceCount, 1, e.raceState.Config.Stage2MaxSeeds, "")
}

func isVerticalDropConnection(ic domain.RoundConnection, fromR, toR *domain.RaceRound) bool {
	if ic.Mode != "bottom_per_heat" || toR == nil || toR.BracketLane != "losers" {
		return false
	}
	return fromR == nil || fromR.BracketLane != "losers"
}

func (e *Engine) recomputeGraphColumnsOnlyLocked(stageIdx int) {
	e.validateConnectionsLocked()
	roundByID := make(map[string]*domain.RaceRound)
	inConns := make(map[string][]domain.RoundConnection)
	outConns := make(map[string][]string)
	for i := range e.raceState.Rounds {
		r := &e.raceState.Rounds[i]
		if r.StageIndex == stageIdx {
			roundByID[r.ID] = r
		}
	}
	for _, c := range e.raceState.Connections {
		if c.Invalid {
			continue
		}
		if _, ok := roundByID[c.ToRoundID]; ok {
			if _, okFrom := roundByID[c.FromRoundID]; okFrom {
				inConns[c.ToRoundID] = append(inConns[c.ToRoundID], c)
				outConns[c.FromRoundID] = append(outConns[c.FromRoundID], c.ToRoundID)
			}
		}
	}
	memo := make(map[string]int)
	visiting := make(map[string]bool)
	var depthOf func(id string) int
	depthOf = func(id string) int {
		if domain.IsStageHandoffInID(id) {
			return 0
		}
		if d, ok := memo[id]; ok {
			return d
		}
		r := roundByID[id]
		if r == nil || visiting[id] {
			return 1
		}
		visiting[id] = true
		ins := inConns[id]
		var d int
		if len(ins) == 0 {
			if r.SeedSource == "all_active_pilots" || len(outConns[id]) > 0 || r.Column <= 1 {
				d = 1
			} else {
				d = r.Column
			}
		} else {
			maxCol := 1
			for _, ic := range ins {
				pd := depthOf(ic.FromRoundID)
				reqCol := pd + 1
				if isVerticalDropConnection(ic, roundByID[ic.FromRoundID], r) {
					reqCol = pd
					if reqCol < 1 {
						reqCol = 1
					}
				}
				if reqCol > maxCol {
					maxCol = reqCol
				}
			}
			d = maxCol
		}
		delete(visiting, id)
		memo[id] = d
		return d
	}
	maxRegularCol := 1
	for id, r := range roundByID {
		if domain.IsStagePortalRoundID(id) {
			continue
		}
		r.Column = depthOf(id)
		if r.Column > maxRegularCol {
			maxRegularCol = r.Column
		}
		for hi := range e.raceState.Heats {
			if e.raceState.Heats[hi].RoundID == id {
				e.raceState.Heats[hi].Column = r.Column
				e.raceState.Heats[hi].BracketLane = r.BracketLane
			}
		}
	}
	if rOut := roundByID[domain.StageHandoffOutID(stageIdx)]; rOut != nil {
		rOut.Column = maxRegularCol + 1
	}
	if rIn := roundByID[domain.StageHandoffInID(stageIdx)]; rIn != nil {
		rIn.Column = 0
	}
	e.sortCustomHeatsAndOrderLocked(stageIdx)
	race.SyncRoundsMetadata(&e.raceState)
}

func (e *Engine) recomputeGraphAndRebuildLocked(stageIdx int, startRoundID string, extraSourceIDs ...string) {
	newlyValid := e.validateConnectionsLocked()
	roundByID := make(map[string]*domain.RaceRound)
	inConns := make(map[string][]domain.RoundConnection)
	outConns := make(map[string][]string)
	for i := range e.raceState.Rounds {
		r := &e.raceState.Rounds[i]
		if r.StageIndex == stageIdx {
			roundByID[r.ID] = r
		}
	}
	for _, c := range e.raceState.Connections {
		if c.Invalid {
			continue
		}
		if _, ok := roundByID[c.ToRoundID]; ok {
			if _, okFrom := roundByID[c.FromRoundID]; okFrom {
				inConns[c.ToRoundID] = append(inConns[c.ToRoundID], c)
				outConns[c.FromRoundID] = append(outConns[c.FromRoundID], c.ToRoundID)
			}
		}
	}

	stg := e.findStageByIndexLocked(stageIdx)
	isCustomGraph := e.raceState.TemplateID == "custom" || (stg != nil && (stg.Customized || stg.Format == domain.FormatCustom))

	// Recompute topological column depths for custom graphs
	if isCustomGraph {
		memo := make(map[string]int)
		visiting := make(map[string]bool)
		var depthOf func(id string) int
		depthOf = func(id string) int {
			if domain.IsStageHandoffInID(id) {
				return 0
			}
			if d, ok := memo[id]; ok {
				return d
			}
			r := roundByID[id]
			if r == nil || visiting[id] {
				return 1
			}
			visiting[id] = true
			ins := inConns[id]
			var d int
			if len(ins) == 0 {
				if r.SeedSource == "all_active_pilots" || r.Column <= 1 {
					d = 1
				} else {
					d = r.Column
				}
			} else {
				maxCol := 1
				for _, ic := range ins {
					pd := depthOf(ic.FromRoundID)
					reqCol := pd + 1
					if isVerticalDropConnection(ic, roundByID[ic.FromRoundID], r) {
						reqCol = pd
						if reqCol < 1 {
							reqCol = 1
						}
					}
					if reqCol > maxCol {
						maxCol = reqCol
					}
				}
				d = maxCol
			}
			delete(visiting, id)
			memo[id] = d
			return d
		}

		maxRegularCol := 1
		for id, r := range roundByID {
			if domain.IsStagePortalRoundID(id) {
				continue
			}
			r.Column = depthOf(id)
			if r.Column > maxRegularCol {
				maxRegularCol = r.Column
			}
			for hi := range e.raceState.Heats {
				if e.raceState.Heats[hi].RoundID == id {
					e.raceState.Heats[hi].Column = r.Column
					e.raceState.Heats[hi].BracketLane = r.BracketLane
				}
			}
		}
		if rOut := roundByID[domain.StageHandoffOutID(stageIdx)]; rOut != nil {
			rOut.Column = maxRegularCol + 1
		}
		if rIn := roundByID[domain.StageHandoffInID(stageIdx)]; rIn != nil {
			rIn.Column = 0
		}
	}

	// Collect affected rounds reachable from startRoundID (plus any newly valid targets)
	var toRebuild []string
	if startRoundID == "" {
		for id := range roundByID {
			if !domain.IsStagePortalRoundID(id) {
				toRebuild = append(toRebuild, id)
			}
		}
	} else {
		seen := make(map[string]bool)
		queue := append([]string{startRoundID}, newlyValid...)

		// Changing a wire also changes how many pilots the SOURCE round must hold per heat
		// (a heat has to keep at least one pilot who does not advance), so the direct feeders of the
		// rewired round, plus any source that just lost a wire, are re-planned before it.
		sourceSeen := make(map[string]bool)
		addSource := func(id string) {
			if id == "" || sourceSeen[id] || domain.IsStagePortalRoundID(id) {
				return
			}
			srcR, ok := roundByID[id]
			if !ok {
				return
			}
			sourceSeen[id] = true
			if len(inConns[id]) == 0 && srcR.SeedSource != "all_active_pilots" {
				// Manually seated root round: preserve manual seats and per-seat VTX channels while
				// refreshing ExpectedWinners and cascading to connected downstream rounds.
				stgSet := e.stageSettingsLocked(srcR.StageIndex)
				defAdv := stgSet.PilotsPerHeat / 2
				if defAdv < 1 {
					defAdv = 1
				}
				outAdv := race.OutgoingTopAdvance(e.raceState.Connections, id, defAdv)
				if outAdv < 1 {
					outAdv = defAdv
				}
				if srcR.StageFormat != domain.FormatQualifying && srcR.BracketLane != "finals" {
					for hi := range e.raceState.Heats {
						if e.raceState.Heats[hi].RoundID != id {
							continue
						}
						ent := race.HeatEntrants(&e.raceState.Heats[hi])
						if ent == 0 {
							ent = len(e.raceState.Heats[hi].Seats)
						}
						e.raceState.Heats[hi].ExpectedWinners = race.EffectiveAdvance(outAdv, ent)
						race.RecomputeHeat(&e.raceState.Heats[hi], stgSet.QualifyingMetric)
					}
				}
				queue = append(queue, outConns[id]...)
				return
			}
			queue = append(queue, id)
		}
		for _, rid := range append([]string{startRoundID}, newlyValid...) {
			for _, ic := range inConns[rid] {
				addSource(ic.FromRoundID)
			}
		}
		for _, id := range extraSourceIDs {
			addSource(id)
		}

		for len(queue) > 0 {
			cur := queue[0]
			queue = queue[1:]
			if seen[cur] {
				continue
			}
			seen[cur] = true
			if _, ok := roundByID[cur]; ok && !domain.IsStagePortalRoundID(cur) {
				toRebuild = append(toRebuild, cur)
			}
			queue = append(queue, outConns[cur]...)
		}
	}

	// Topological sort over `toRebuild` so any source round (such as Winners R1 feeding Redemption R1
	// vertically in the same column) always rebuilds BEFORE the rounds it feeds.
	inRebuild := make(map[string]bool, len(toRebuild))
	for _, id := range toRebuild {
		inRebuild[id] = true
	}
	laneRank := func(lane string) int {
		switch lane {
		case "qualifying":
			return 0
		case "winners":
			return 1
		case "losers":
			return 2
		case "mains":
			return 3
		case "finals":
			return 4
		default:
			return 5
		}
	}
	lessRound := func(a, b string) bool {
		ra, rb := roundByID[a], roundByID[b]
		if ra == nil || rb == nil {
			return a < b
		}
		if ra.Column != rb.Column {
			return ra.Column < rb.Column
		}
		la, lb := laneRank(ra.BracketLane), laneRank(rb.BracketLane)
		if la != lb {
			return la < lb
		}
		if ra.Round != rb.Round {
			return ra.Round < rb.Round
		}
		return a < b
	}
	inDeg := make(map[string]int, len(toRebuild))
	adjRebuild := make(map[string][]string, len(toRebuild))
	for _, id := range toRebuild {
		for _, ic := range inConns[id] {
			if inRebuild[ic.FromRoundID] && ic.FromRoundID != id {
				adjRebuild[ic.FromRoundID] = append(adjRebuild[ic.FromRoundID], id)
				inDeg[id]++
			}
		}
	}
	var ready []string
	for _, id := range toRebuild {
		if inDeg[id] == 0 {
			ready = append(ready, id)
		}
	}
	sort.SliceStable(ready, func(i, j int) bool { return lessRound(ready[i], ready[j]) })
	ordered := make([]string, 0, len(toRebuild))
	placed := make(map[string]bool, len(toRebuild))
	for len(ready) > 0 {
		cur := ready[0]
		ready = ready[1:]
		if placed[cur] {
			continue
		}
		placed[cur] = true
		ordered = append(ordered, cur)
		for _, nxt := range adjRebuild[cur] {
			inDeg[nxt]--
			if inDeg[nxt] == 0 && !placed[nxt] {
				ready = append(ready, nxt)
			}
		}
		sort.SliceStable(ready, func(i, j int) bool { return lessRound(ready[i], ready[j]) })
	}
	if len(ordered) < len(toRebuild) {
		var rem []string
		for _, id := range toRebuild {
			if !placed[id] {
				rem = append(rem, id)
			}
		}
		sort.SliceStable(rem, func(i, j int) bool { return lessRound(rem[i], rem[j]) })
		ordered = append(ordered, rem...)
	}

	for _, rid := range ordered {
		if e.ensureRoundUnstartedLocked(rid) == nil {
			e.rebalanceAutoConnectionsIntoLocked(rid)
		}
		e.rebuildSingleRoundLocked(rid)
	}

	if isCustomGraph {
		e.sortCustomHeatsAndOrderLocked(stageIdx)
	}
	race.RebuildEdgesFromFeeders(&e.raceState)
	race.SyncRoundsMetadata(&e.raceState)
}

func syncUnstartedHeatSeatsToConfig(h *domain.RaceHeat, maxPerHeat int, seatChannels []uint8) {
	if h == nil || !isUnstartedHeatState(h.State) {
		return
	}
	if maxPerHeat < 2 {
		maxPerHeat = 4
	}
	if len(seatChannels) < maxPerHeat {
		seatChannels = domain.DefaultSeatChannels(maxPerHeat)
	}
	for i := 0; i < len(h.Seats) && i < maxPerHeat; i++ {
		band, ch, freq, ok := domain.DecodeBandChannel(seatChannels[i])
		if !ok {
			band = domain.BandRaceband
			ch = uint8((i % domain.MaxPilotSlots) + 1)
			freq = domain.RacebandFrequenciesMHz[ch-1]
		}
		h.Seats[i].SeatIndex = i + 1
		h.Seats[i].Band = band
		h.Seats[i].Channel = ch
		h.Seats[i].FrequencyMHz = freq
	}
	if len(h.Seats) < maxPerHeat {
		for i := len(h.Seats); i < maxPerHeat; i++ {
			band, ch, freq, ok := domain.DecodeBandChannel(seatChannels[i])
			if !ok {
				band = domain.BandRaceband
				ch = uint8((i % domain.MaxPilotSlots) + 1)
				freq = domain.RacebandFrequenciesMHz[ch-1]
			}
			h.Seats = append(h.Seats, domain.HeatSeat{
				SeatIndex:    i + 1,
				Band:         band,
				Channel:      ch,
				FrequencyMHz: freq,
				Status:       domain.PilotHeatStaged,
				SourceLabel:  "Open / BYE",
				Laps:         []domain.HeatLap{},
			})
		}
	} else if len(h.Seats) > maxPerHeat {
		h.Seats = h.Seats[:maxPerHeat]
	}
}

func (e *Engine) ensureRoundHeatCountLocked(roundID string, desired int) []*domain.RaceHeat {
	if desired < 1 {
		desired = 1
	}
	r := e.findRoundByIDLocked(roundID)
	if r == nil {
		return nil
	}

	curCount := 0
	for _, h := range e.raceState.Heats {
		if h.RoundID == roundID {
			curCount++
		}
	}

	for curCount < desired {
		e.appendHeatToRoundOrColumnLocked(roundID, r.BracketLane, r.Round, r.Column)
		curCount++
	}

	if curCount > desired {
		excess := curCount - desired
		kept := make([]domain.RaceHeat, 0, len(e.raceState.Heats))
		// Trim excess unstarted heats from the end of this round
		var roundHeatIdxs []int
		for i, h := range e.raceState.Heats {
			if h.RoundID == roundID && isUnstartedHeatState(h.State) {
				roundHeatIdxs = append(roundHeatIdxs, i)
			}
		}
		dropIdx := make(map[int]bool)
		for k := len(roundHeatIdxs) - 1; k >= 0 && excess > 0; k-- {
			dropIdx[roundHeatIdxs[k]] = true
			excess--
		}
		for i, h := range e.raceState.Heats {
			if !dropIdx[i] {
				kept = append(kept, h)
			}
		}
		e.raceState.Heats = kept
	}

	stgSettings := e.stageSettingsLocked(r.StageIndex)
	var out []*domain.RaceHeat
	for i := range e.raceState.Heats {
		if e.raceState.Heats[i].RoundID == roundID {
			syncUnstartedHeatSeatsToConfig(&e.raceState.Heats[i], stgSettings.PilotsPerHeat, stgSettings.SeatChannels)
			if isUnstartedHeatState(e.raceState.Heats[i].State) {
				if r.TargetLaps >= 0 {
					e.raceState.Heats[i].TargetLaps = r.TargetLaps
				}
				if r.TimeLimitSec >= 15 {
					e.raceState.Heats[i].TimeLimitSec = r.TimeLimitSec
				}
			}
			out = append(out, &e.raceState.Heats[i])
		}
	}
	// Refresh heat titles ("Round 1 · Heat 1" vs "Round 2")
	for idx, h := range out {
		if len(out) == 1 {
			h.Title = r.Title
		} else {
			h.Title = fmt.Sprintf("%s · Heat %d", r.Title, idx+1)
		}
		h.StageName = r.Title
	}
	return out
}

func (e *Engine) rebuildSingleRoundLocked(roundID string) {
	if domain.IsStagePortalRoundID(roundID) {
		return
	}
	r := e.findRoundByIDLocked(roundID)
	if r == nil {
		return
	}

	stgSettings := e.stageSettingsLocked(r.StageIndex)
	maxPerHeat := stgSettings.PilotsPerHeat
	if maxPerHeat < 2 {
		maxPerHeat = 4
	}

	// Elimination-aware sizing: the Top-N leaving this round decides how many pilots every heat
	// needs so that at least one pilot is always eliminated or dropped.
	defAdv := maxPerHeat / 2
	if defAdv < 1 {
		defAdv = 1
	}
	outAdv := 0
	if r.BracketLane != "finals" {
		outAdv = race.OutgoingTopAdvance(e.raceState.Connections, roundID, defAdv)
	}
	effectiveOutAdv := outAdv
	if effectiveOutAdv < 1 {
		effectiveOutAdv = defAdv
	}
	syncRoundExpectedWinners := func() {
		if r.StageFormat == domain.FormatQualifying || r.BracketLane == "finals" {
			return
		}
		for i := range e.raceState.Heats {
			if e.raceState.Heats[i].RoundID != roundID {
				continue
			}
			ent := race.HeatEntrants(&e.raceState.Heats[i])
			if ent == 0 {
				ent = len(e.raceState.Heats[i].Seats)
			}
			e.raceState.Heats[i].ExpectedWinners = race.EffectiveAdvance(effectiveOutAdv, ent)
			race.RecomputeHeat(&e.raceState.Heats[i], stgSettings.QualifyingMetric)
		}
	}

	startedCount := 0
	unstartedCount := 0
	for _, h := range e.raceState.Heats {
		if h.RoundID == roundID {
			if isUnstartedHeatState(h.State) {
				unstartedCount++
			} else {
				startedCount++
			}
		}
	}
	if startedCount > 0 {
		// Never touch started/confirmed heats, but dynamically re-adjust any remaining uncompleted
		// heats in this source round so every uncompleted heat still eliminates >= 1 pilot.
		e.readjustUncompletedHeatsInPartialRoundLocked(roundID, r, outAdv, effectiveOutAdv, stgSettings)
		syncRoundExpectedWinners()
		return
	}

	var inConns []domain.RoundConnection
	for _, c := range e.raceState.Connections {
		if !c.Invalid && c.ToRoundID == roundID {
			inConns = append(inConns, c)
		}
	}

	// Case 1: Root / Unconnected round
	if len(inConns) == 0 {
		if domain.IsOpenQualRoundID(roundID) || r.StageFormat == domain.FormatOpenQualifier {
			return // Open Qualifier packs are spawned dynamically from the Flight-Line Queue
		}
		if r.SeedSource == "all_active_pilots" {
			pilots := e.activeEventPilotsForGenerationLocked()
			if r.BracketLane == "finals" && len(pilots) > maxPerHeat {
				pilots = pilots[:maxPerHeat]
			}
			if r.SeedDistribution == "random" && len(pilots) > 1 {
				shuffled := append([]domain.PilotSlot(nil), pilots...)
				seedVal := r.RandomSeed
				if seedVal == 0 {
					seedVal = int64(r.StageIndex*1009 + r.Round*97 + len(shuffled))
				}
				rng := rand.New(rand.NewSource(seedVal))
				rng.Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })
				pilots = shuffled
			}
			needed := (len(pilots) + maxPerHeat - 1) / maxPerHeat
			if r.BracketLane == "finals" {
				needed = 1
				if r.FinalsFormat == domain.FinalsPoints {
					needed = r.FinalsHeats
					if needed < 2 {
						needed = 3
					}
				}
			} else {
				needed = race.PlanHeatCount(len(pilots), maxPerHeat, outAdv, r.TargetHeats)
			}
			if needed < 1 {
				needed = 1
			}
			e.populateBalancedPilotRoundPreservingLocksLocked(roundID, r, nil, pilots, needed, stgSettings, nil)
			syncRoundExpectedWinners()
			return
		}

		// Empty / disconnected round -> clean heats preserving manually seated pilots & TargetHeats
		activeBySlot := make(map[int]domain.PilotSlot)
		for _, ap := range e.activeEventPilotsForGenerationLocked() {
			activeBySlot[ap.SlotIndex] = ap
		}
		emptyHeats := r.TargetHeats
		if r.BracketLane == "finals" {
			if r.FinalsFormat == domain.FinalsPoints {
				emptyHeats = r.FinalsHeats
				if emptyHeats < 2 {
					emptyHeats = 3
				}
			} else {
				emptyHeats = 1
			}
		}
		if emptyHeats < 1 {
			emptyHeats = 1
		}
		targetHeats := e.ensureRoundHeatCountLocked(roundID, emptyHeats)
		for _, th := range targetHeats {
			for si := range th.Seats {
				s := &th.Seats[si]
				if s.PilotSlotIndex > 0 && s.ManualLock {
					s.Feeder = nil
					if ap, ok := activeBySlot[s.PilotSlotIndex]; ok {
						s.Callsign = ap.Callsign
						s.PhoneticName = ap.PhoneticName
						s.Color = ap.Color
					} else {
						s.ManualLock = false
						clearSeatOccupant(s, false)
					}
				} else {
					s.Feeder = nil
					s.ManualLock = false
					clearSeatOccupant(s, false)
				}
			}
			th.State = domain.HeatReady
			finalizeEditedHeatState(th, stgSettings.QualifyingMetric)
		}
		syncRoundExpectedWinners()
		return
	}

	// Case 2: Round fed by 1 or more incoming RoundConnections!
	// Special fast-path: Balanced All-Pilots Rotation (`mode == "all_pilots"`) when source heats already hold concrete pilots!
	if len(inConns) == 1 && inConns[0].Mode == "all_pilots" && r.BracketLane != "finals" {
		if srcR := e.findRoundByIDLocked(inConns[0].FromRoundID); srcR != nil {
			activeBySlot := make(map[int]domain.PilotSlot)
			for _, ap := range e.activeEventPilotsForGenerationLocked() {
				activeBySlot[ap.SlotIndex] = ap
			}
			seenSlot := make(map[int]bool)
			var srcPilots []domain.PilotSlot
			for _, h := range e.raceState.Heats {
				if h.RoundID != srcR.ID {
					continue
				}
				for _, s := range h.Seats {
					if s.PilotSlotIndex <= 0 || seenSlot[s.PilotSlotIndex] {
						continue
					}
					if ap, ok := activeBySlot[s.PilotSlotIndex]; ok {
						seenSlot[s.PilotSlotIndex] = true
						srcPilots = append(srcPilots, ap)
					}
				}
			}
			// If source is a Qualifying round and new walk-up/checked-in pilots exist, include them too
			if srcR.StageFormat == domain.FormatQualifying || r.StageFormat == domain.FormatQualifying {
				for _, ap := range e.activeEventPilotsForGenerationLocked() {
					if !seenSlot[ap.SlotIndex] && len(srcPilots) > 0 {
						seenSlot[ap.SlotIndex] = true
						srcPilots = append(srcPilots, ap)
					}
				}
			}
			if len(srcPilots) > 0 {
				var otherPrior []domain.RaceHeat
				var srcHeatPtrs []*domain.RaceHeat
				for i := range e.raceState.Heats {
					h := &e.raceState.Heats[i]
					if h.StageIndex != r.StageIndex || h.RoundID == roundID {
						continue
					}
					if h.RoundID == srcR.ID {
						srcHeatPtrs = append(srcHeatPtrs, h)
					} else if h.Column < r.Column {
						otherPrior = append(otherPrior, *h)
					}
				}
				needed := race.PlanHeatCount(len(srcPilots), maxPerHeat, outAdv, r.TargetHeats)
				if needed < 1 {
					needed = 1
				}
				e.populateBalancedPilotRoundPreservingLocksLocked(roundID, r, srcHeatPtrs, srcPilots, needed, stgSettings, otherPrior)
				return
			}
		}
	}

	type incomingFeeder struct {
		feeder     domain.SeatFeeder
		label      string
		sequential bool
	}
	var feeders []incomingFeeder
	allStageSeeds := true
	allSequential := true

	for _, conn := range inConns {
		if conn.Mode == "stage_seeds" {
			sStart := conn.SeedStart
			if sStart < 1 {
				sStart = 1
			}
			sEnd := conn.SeedEnd
			if sEnd <= 0 {
				sEnd = e.effectiveStageSeedCountLocked(r.StageIndex)
			}
			if sEnd > 64 {
				sEnd = 64
			}
			if sEnd < sStart {
				sEnd = sStart
			}
			seq := conn.Distribution == "sequential"
			if !seq {
				allSequential = false
			}
			for seedNum := sStart; seedNum <= sEnd; seedNum++ {
				feeders = append(feeders, incomingFeeder{
					feeder:     domain.SeatFeeder{FromStageSeed: seedNum},
					label:      fmt.Sprintf("Seed #%d", seedNum),
					sequential: seq,
				})
			}
			continue
		}
		allStageSeeds = false
		allSequential = false

		srcR := e.findRoundByIDLocked(conn.FromRoundID)
		if srcR == nil {
			continue
		}
		var srcHeats []*domain.RaceHeat
		for i := range e.raceState.Heats {
			if e.raceState.Heats[i].RoundID == srcR.ID {
				srcHeats = append(srcHeats, &e.raceState.Heats[i])
			}
		}
		if len(srcHeats) == 0 && conn.Mode != "standings_top" && conn.Mode != "all_pilots_ranked" {
			continue
		}

		cnt := conn.Count
		if cnt < 1 {
			cnt = maxPerHeat / 2
			if cnt < 1 {
				cnt = 1
			}
		}

		// Entrants per source heat (falls back to the seat count for still-empty placeholder heats)
		// so an undersized heat can never advance everyone it holds.
		entrantsOf := func(sh *domain.RaceHeat) int {
			n := race.HeatEntrants(sh)
			if n == 0 {
				n = len(sh.Seats)
			}
			return n
		}

		switch conn.Mode {
		case "top_per_heat":
			for _, sh := range srcHeats {
				if sh.StageFormat != domain.FormatQualifying {
					sh.ExpectedWinners = race.EffectiveAdvance(cnt, entrantsOf(sh))
					race.RecomputeHeat(sh, stgSettings.QualifyingMetric)
				}
			}
			for rnk := 1; rnk <= cnt; rnk++ {
				for _, sh := range srcHeats {
					if rnk <= len(sh.Seats) && (sh.StageFormat == domain.FormatQualifying || rnk <= race.EffectiveAdvance(cnt, entrantsOf(sh))) {
						feeders = append(feeders, incomingFeeder{
							feeder: domain.SeatFeeder{FromHeatID: sh.ID, FromRank: rnk},
							label:  fmt.Sprintf("%s · %s", race.Ordinal(rnk), sh.ShortLabel),
						})
					}
				}
			}

		case "bottom_per_heat":
			// Start right after any `top_per_heat` spots leaving `srcR` so Winners & Redemption never overlap!
			topAdv := 0
			for _, oc := range e.raceState.Connections {
				if oc.FromRoundID == srcR.ID && oc.Mode == "top_per_heat" && oc.Count > topAdv {
					topAdv = oc.Count
				}
			}
			for offset := 0; offset < cnt; offset++ {
				for _, sh := range srcHeats {
					entrants := entrantsOf(sh)
					startRank := race.EffectiveAdvance(topAdv, entrants) + 1
					if topAdv == 0 {
						startRank = entrants - cnt + 1
						if startRank < 1 {
							startRank = 1
						}
					}
					rnk := startRank + offset
					if rnk <= entrants && rnk <= len(sh.Seats) {
						feeders = append(feeders, incomingFeeder{
							feeder: domain.SeatFeeder{FromHeatID: sh.ID, FromRank: rnk},
							label:  fmt.Sprintf("%s · %s", race.Ordinal(rnk), sh.ShortLabel),
						})
					}
				}
			}

		case "standings_top":
			upCap := e.upstreamStandingsCapacityLocked(srcR, conn, maxPerHeat)
			sStart := conn.SeedStart
			if sStart < 1 {
				sStart = 1
			}
			sEnd := conn.SeedEnd
			if sEnd <= 0 {
				if conn.Count >= 1 && sStart == 1 {
					sEnd = conn.Count
					if !conn.CustomCount && upCap > 0 && sEnd > upCap {
						sEnd = upCap
					}
				} else {
					sEnd = upCap
				}
			}
			if sEnd > 64 {
				sEnd = 64
			}
			if sEnd < sStart {
				sEnd = sStart
			}
			seq := conn.Distribution == "sequential"
			if len(inConns) == 1 {
				allStageSeeds = true
				allSequential = seq
			}
			isQualSrc := srcR.StageFormat == domain.FormatQualifying || srcR.StageFormat == domain.FormatOpenQualifier || domain.IsOpenQualRoundID(srcR.ID)
			srcLblTitle := srcR.Title
			if srcLblTitle == "" {
				srcLblTitle = fmt.Sprintf("R%d", srcR.Column)
			}
			for rnk := sStart; rnk <= sEnd; rnk++ {
				lbl := fmt.Sprintf("Seed #%d · %s", rnk, srcLblTitle)
				if isQualSrc && len(inConns) == 1 {
					lbl = fmt.Sprintf("Seed #%d", rnk)
				}
				feeders = append(feeders, incomingFeeder{
					feeder: domain.SeatFeeder{
						FromRoundID:       srcR.ID,
						FromRoundColumn:   srcR.Column,
						FromStandingsRank: rnk,
						RankingMetric:     conn.RankingMetric,
					},
					label:      lbl,
					sequential: seq,
				})
			}

		case "all_pilots":
			// When `srcR` holds standings-seed placeholders (`Seed #1..#N`) and 0 concrete pilots yet
			// (e.g. `Qualifying -> Mains R1 -> Mains R2 (all_pilots)`), rotate those exact `Seed #` feeders
			// across `r` so `Mains R2..Rn` show `Seed #` placeholders immediately and resolve simultaneously!
			var upstreamSeedFeeders []incomingFeeder
			totalSrcNonByeFeeders := 0
			hasConcreteInSrc := false
			for _, sh := range srcHeats {
				for _, s := range sh.Seats {
					if s.PilotSlotIndex > 0 {
						hasConcreteInSrc = true
						break
					}
					if s.Feeder != nil && !s.Feeder.IsBye {
						totalSrcNonByeFeeders++
						if s.Feeder.FromStandingsRank > 0 || s.Feeder.FromStageSeed > 0 {
							fCopy := *s.Feeder
							lbl := s.SourceLabel
							if lbl == "" {
								lbl = e.feederSourceLabelLocked(&fCopy)
							}
							upstreamSeedFeeders = append(upstreamSeedFeeders, incomingFeeder{
								feeder: fCopy,
								label:  lbl,
							})
						}
					}
				}
			}
			if !hasConcreteInSrc && len(upstreamSeedFeeders) > 0 && len(upstreamSeedFeeders) == totalSrcNonByeFeeders {
				sort.SliceStable(upstreamSeedFeeders, func(i, j int) bool {
					ai := upstreamSeedFeeders[i].feeder.FromStandingsRank
					if ai == 0 {
						ai = upstreamSeedFeeders[i].feeder.FromStageSeed
					}
					aj := upstreamSeedFeeders[j].feeder.FromStandingsRank
					if aj == 0 {
						aj = upstreamSeedFeeders[j].feeder.FromStageSeed
					}
					return ai < aj
				})
				shift := r.Round - srcR.Round
				if shift < 1 {
					shift = r.Column - srcR.Column
				}
				if shift < 1 {
					shift = 1
				}
				nSeeds := len(upstreamSeedFeeders)
				for k := 0; k < nSeeds; k++ {
					feeders = append(feeders, upstreamSeedFeeders[(k+shift)%nSeeds])
				}
				if len(inConns) == 1 {
					allStageSeeds = true
					allSequential = false
				}
			} else {
				for rnk := 1; rnk <= maxPerHeat; rnk++ {
					for _, sh := range srcHeats {
						if rnk <= entrantsOf(sh) && rnk <= len(sh.Seats) {
							feeders = append(feeders, incomingFeeder{
								feeder: domain.SeatFeeder{FromHeatID: sh.ID, FromRank: rnk},
								label:  fmt.Sprintf("%s · %s", race.Ordinal(rnk), sh.ShortLabel),
							})
						}
					}
				}
			}

		case "all_pilots_ranked":
			totalRanked := e.upstreamStandingsCapacityLocked(srcR, conn, maxPerHeat)
			seq := conn.Distribution != "snake"
			if len(inConns) == 1 {
				allStageSeeds = true
				allSequential = seq
			}
			isQualSrc := srcR.StageFormat == domain.FormatQualifying || srcR.StageFormat == domain.FormatOpenQualifier || domain.IsOpenQualRoundID(srcR.ID)
			srcLblTitle := srcR.Title
			if srcLblTitle == "" {
				srcLblTitle = fmt.Sprintf("R%d", srcR.Column)
			}
			for rnk := 1; rnk <= totalRanked; rnk++ {
				lbl := fmt.Sprintf("Seed #%d · %s", rnk, srcLblTitle)
				if isQualSrc && len(inConns) == 1 {
					lbl = fmt.Sprintf("Seed #%d", rnk)
				}
				feeders = append(feeders, incomingFeeder{
					feeder: domain.SeatFeeder{
						FromRoundID:       srcR.ID,
						FromRoundColumn:   srcR.Column,
						FromStandingsRank: rnk,
						RankingMetric:     conn.RankingMetric,
					},
					label:      lbl,
					sequential: seq,
				})
			}
		}
	}

	if r.BracketLane == "finals" {
		numFinalsHeats := 1
		if r.FinalsFormat == domain.FinalsPoints {
			numFinalsHeats = r.FinalsHeats
			if numFinalsHeats < 2 {
				numFinalsHeats = 3
			}
		}
		if len(feeders) > maxPerHeat {
			feeders = feeders[:maxPerHeat]
		}
		// Ensure Finals heat IDs match FinalsFormat ("CTA-*" for Chase the Ace, "GF-*" for Single / Points)
		wantCTA := r.FinalsFormat == domain.FinalsChaseTheAce || r.StageFormat == domain.FormatChaseTheAce
		hasMismatch := false
		for _, h := range e.raceState.Heats {
			if h.RoundID == roundID {
				isCTA := strings.HasPrefix(h.ID, "CTA-") || strings.Contains(h.ID, "-CTA-")
				if isCTA != wantCTA {
					hasMismatch = true
					break
				}
			}
		}
		if hasMismatch {
			keep := make([]domain.RaceHeat, 0, len(e.raceState.Heats))
			for _, h := range e.raceState.Heats {
				if h.RoundID != roundID {
					keep = append(keep, h)
				}
			}
			e.raceState.Heats = keep
		}
		targetHeats := e.ensureRoundHeatCountLocked(roundID, numFinalsHeats)
		for hi, th := range targetHeats {
			for si := range th.Seats {
				th.Seats[si].ManualLock = false
				th.Seats[si].Feeder = nil
				clearSeatOccupant(&th.Seats[si], false)
			}
			th.ExpectedWinners = 1
			th.StartMode = domain.StartModeHeadsUp
			if wantCTA {
				reqW := r.AceWinsRequired
				if reqW < 2 {
					reqW = 2
				}
				th.StageFormat = domain.FormatChaseTheAce
				th.Title = fmt.Sprintf("Chase the Ace · Heat %d (First to %d Wins)", hi+1, reqW)
			} else if r.FinalsFormat == domain.FinalsPoints {
				th.Title = fmt.Sprintf("%s · Heat %d of %d", r.Title, hi+1, numFinalsHeats)
			} else {
				th.Title = r.Title
			}
			for fi, fd := range feeders {
				if fi >= len(th.Seats) {
					break
				}
				fCopy := fd.feeder
				th.Seats[fi].Feeder = &fCopy
				th.Seats[fi].SourceLabel = fd.label
			}
			th.State = domain.HeatWaiting
		}
		return
	}

	neededHeats := race.PlanHeatCount(len(feeders), maxPerHeat, outAdv, r.TargetHeats)
	if neededHeats < 1 {
		neededHeats = 1
	}
	targetHeats := e.ensureRoundHeatCountLocked(roundID, neededHeats)
	for _, th := range targetHeats {
		for si := range th.Seats {
			th.Seats[si].ManualLock = false
			th.Seats[si].Feeder = nil
			clearSeatOccupant(&th.Seats[si], false)
		}
		th.State = domain.HeatWaiting
	}

	numDst := len(targetHeats)
	seatCursor := make([]int, numDst)
	bracketOrder := snakeBracketHeatOrder(numDst)
	seqChunk := maxPerHeat
	if outAdv > 0 && numDst > 0 {
		// Fill sequentially but evenly so the last heat is never left with too few pilots to eliminate anyone.
		seqChunk = (len(feeders) + numDst - 1) / numDst
		if seqChunk < 1 {
			seqChunk = 1
		}
		if seqChunk > maxPerHeat {
			seqChunk = maxPerHeat
		}
	}
	minBalanced := len(feeders) / numDst
	extra := len(feeders) % numDst
	fullExtra := 0
	canAcceptBalanced := func(hi int) bool {
		if seatCursor[hi] >= len(targetHeats[hi].Seats) {
			return false
		}
		if seatCursor[hi] < minBalanced {
			return true
		}
		return seatCursor[hi] == minBalanced && fullExtra < extra
	}
	heatHasSrc := func(hi int, srcHeatID string) bool {
		if srcHeatID == "" {
			return false
		}
		for s := 0; s < seatCursor[hi] && s < len(targetHeats[hi].Seats); s++ {
			if targetHeats[hi].Seats[s].Feeder != nil && targetHeats[hi].Seats[s].Feeder.FromHeatID == srcHeatID {
				return true
			}
		}
		return false
	}
	for idx, fd := range feeders {
		var dstIdx int
		if allStageSeeds && allSequential {
			dstIdx = idx / seqChunk
			if dstIdx >= numDst {
				dstIdx = numDst - 1
			}
		} else if allStageSeeds && len(bracketOrder) == numDst {
			pass := idx / numDst
			rem := idx % numDst
			if pass%2 == 0 {
				dstIdx = bracketOrder[rem]
			} else {
				dstIdx = bracketOrder[numDst-1-rem]
			}
		} else {
			pass := idx / numDst
			rem := idx % numDst
			pref := rem
			if pass%2 == 1 {
				pref = numDst - 1 - rem
			}
			dstIdx = pref
			if !canAcceptBalanced(pref) || (fd.feeder.FromHeatID != "" && heatHasSrc(pref, fd.feeder.FromHeatID)) {
				best := -1
				if fd.feeder.FromHeatID != "" {
					for step := 0; step < numDst; step++ {
						cand := (pref + step) % numDst
						if canAcceptBalanced(cand) && !heatHasSrc(cand, fd.feeder.FromHeatID) {
							if best < 0 || seatCursor[cand] < seatCursor[best] {
								best = cand
							}
						}
					}
				}
				if best < 0 {
					for step := 0; step < numDst; step++ {
						cand := (pref + step) % numDst
						if canAcceptBalanced(cand) {
							if best < 0 || seatCursor[cand] < seatCursor[best] {
								best = cand
							}
						}
					}
				}
				if best >= 0 {
					dstIdx = best
				}
			}
		}
		th := targetHeats[dstIdx]
		si := seatCursor[dstIdx]
		if si >= len(th.Seats) {
			placed := false
			for altIdx, altH := range targetHeats {
				if seatCursor[altIdx] < len(altH.Seats) {
					th = altH
					si = seatCursor[altIdx]
					dstIdx = altIdx
					placed = true
					break
				}
			}
			if !placed {
				break
			}
		}
		seatCursor[dstIdx]++
		if seatCursor[dstIdx] == minBalanced+1 {
			fullExtra++
		}
		fCopy := fd.feeder
		th.Seats[si].Feeder = &fCopy
		th.Seats[si].SourceLabel = fd.label
		th.State = domain.HeatWaiting
	}
	syncRoundExpectedWinners()
}

// readjustUncompletedHeatsInPartialRoundLocked re-balances ONLY the still-unstarted heats of a round
// that already has one or more started/confirmed heats when an outgoing advancement wire changes.
func (e *Engine) readjustUncompletedHeatsInPartialRoundLocked(
	roundID string,
	r *domain.RaceRound,
	outAdv int,
	effectiveOutAdv int,
	stgSettings domain.StageSettings,
) {
	if r == nil || r.BracketLane == "finals" || domain.IsOpenQualRoundID(roundID) || r.StageFormat == domain.FormatOpenQualifier {
		return
	}
	maxPerHeat := stgSettings.PilotsPerHeat
	if maxPerHeat < 2 {
		maxPerHeat = 4
	}

	activeBySlot := make(map[int]domain.PilotSlot)
	for _, ap := range e.activeEventPilotsForGenerationLocked() {
		activeBySlot[ap.SlotIndex] = ap
	}

	startedCount := 0
	alreadyRaced := make(map[int]bool)
	var unstartedIndices []int
	for i := range e.raceState.Heats {
		h := &e.raceState.Heats[i]
		if h.RoundID != roundID {
			continue
		}
		if !isUnstartedHeatState(h.State) {
			startedCount++
			for _, s := range h.Seats {
				if s.PilotSlotIndex > 0 {
					alreadyRaced[s.PilotSlotIndex] = true
				}
			}
		} else {
			unstartedIndices = append(unstartedIndices, i)
		}
	}
	if len(unstartedIndices) == 0 {
		return
	}

	// Collect remaining unstarted pilots (in seed/seat order) or remaining feeders across unstarted heats.
	var remPilots []domain.PilotSlot
	var remSeeds []int
	seenPilot := make(map[int]bool)
	type savedFeeder struct {
		feeder domain.SeatFeeder
		label  string
	}
	var remFeeders []savedFeeder

	for _, hi := range unstartedIndices {
		h := &e.raceState.Heats[hi]
		for _, s := range h.Seats {
			if s.PilotSlotIndex > 0 && s.Feeder == nil {
				if alreadyRaced[s.PilotSlotIndex] || seenPilot[s.PilotSlotIndex] {
					continue
				}
				seenPilot[s.PilotSlotIndex] = true
				p, ok := activeBySlot[s.PilotSlotIndex]
				if !ok {
					p = domain.PilotSlot{
						SlotIndex:    s.PilotSlotIndex,
						Callsign:     s.Callsign,
						PhoneticName: s.PhoneticName,
						Color:        s.Color,
						Band:         s.Band,
						Channel:      s.Channel,
					}
				}
				remPilots = append(remPilots, p)
				remSeeds = append(remSeeds, s.Seed)
			} else if s.Feeder != nil && !s.Feeder.IsBye {
				remFeeders = append(remFeeders, savedFeeder{feeder: *s.Feeder, label: s.SourceLabel})
			}
		}
	}

	remPref := 0
	if r.TargetHeats > startedCount {
		remPref = r.TargetHeats - startedCount
	}

	if len(remPilots) > 0 && len(remFeeders) == 0 {
		desiredUnstarted := race.PlanHeatCount(len(remPilots), maxPerHeat, outAdv, remPref)
		for len(unstartedIndices) < desiredUnstarted {
			e.appendHeatToRoundOrColumnLocked(roundID, r.BracketLane, r.Round, r.Column)
			unstartedIndices = append(unstartedIndices, len(e.raceState.Heats)-1)
		}
		if len(unstartedIndices) > desiredUnstarted {
			excess := len(unstartedIndices) - desiredUnstarted
			dropIdx := make(map[int]bool, excess)
			for k := len(unstartedIndices) - 1; k >= 0 && excess > 0; k-- {
				dropIdx[unstartedIndices[k]] = true
				excess--
			}
			kept := make([]domain.RaceHeat, 0, len(e.raceState.Heats)-len(dropIdx))
			for i, h := range e.raceState.Heats {
				if !dropIdx[i] {
					kept = append(kept, h)
				}
			}
			e.raceState.Heats = kept
		}

		var unstartedPtrs []*domain.RaceHeat
		totalRoundHeats := 0
		for i := range e.raceState.Heats {
			if e.raceState.Heats[i].RoundID == roundID {
				totalRoundHeats++
				if isUnstartedHeatState(e.raceState.Heats[i].State) {
					syncUnstartedHeatSeatsToConfig(&e.raceState.Heats[i], maxPerHeat, stgSettings.SeatChannels)
					unstartedPtrs = append(unstartedPtrs, &e.raceState.Heats[i])
				}
			}
		}
		if len(unstartedPtrs) == 0 {
			return
		}

		numU := len(unstartedPtrs)
		buckets := make([][]domain.PilotSlot, numU)
		seedMap := make(map[int]int, len(remPilots))
		for idx, p := range remPilots {
			if remSeeds[idx] > 0 {
				seedMap[p.SlotIndex] = remSeeds[idx]
			} else {
				seedMap[p.SlotIndex] = idx + 1
			}
			pass := idx / numU
			rem := idx % numU
			dst := rem
			if pass%2 == 1 {
				dst = numU - 1 - rem
			}
			buckets[dst] = append(buckets[dst], p)
		}
		lastCh := race.LastChannelByPilotConfirmed(e.raceState.Heats)
		for bi, uh := range unstartedPtrs {
			assignPilotsWithChannelContinuity(uh, buckets[bi], stgSettings.SeatChannels, lastCh)
			for si := range uh.Seats {
				slot := uh.Seats[si].PilotSlotIndex
				if slot > 0 && seedMap[slot] > 0 {
					uh.Seats[si].Seed = seedMap[slot]
					uh.Seats[si].SourceLabel = fmt.Sprintf("Seed #%d", seedMap[slot])
				}
			}
			if r.StageFormat != domain.FormatQualifying {
				uh.ExpectedWinners = race.EffectiveAdvance(effectiveOutAdv, race.HeatEntrants(uh))
			}
			uh.State = domain.HeatReady
			finalizeEditedHeatState(uh, stgSettings.QualifyingMetric)
		}

		idxInRound := 0
		for i := range e.raceState.Heats {
			if e.raceState.Heats[i].RoundID == roundID {
				idxInRound++
				if totalRoundHeats == 1 {
					e.raceState.Heats[i].Title = r.Title
				} else {
					e.raceState.Heats[i].Title = fmt.Sprintf("%s · Heat %d", r.Title, idxInRound)
				}
			}
		}
		return
	}

	if len(remFeeders) > 0 && len(remPilots) == 0 {
		desiredUnstarted := race.PlanHeatCount(len(remFeeders), maxPerHeat, outAdv, remPref)
		for len(unstartedIndices) < desiredUnstarted {
			e.appendHeatToRoundOrColumnLocked(roundID, r.BracketLane, r.Round, r.Column)
			unstartedIndices = append(unstartedIndices, len(e.raceState.Heats)-1)
		}
		if len(unstartedIndices) > desiredUnstarted {
			excess := len(unstartedIndices) - desiredUnstarted
			dropIdx := make(map[int]bool, excess)
			for k := len(unstartedIndices) - 1; k >= 0 && excess > 0; k-- {
				dropIdx[unstartedIndices[k]] = true
				excess--
			}
			kept := make([]domain.RaceHeat, 0, len(e.raceState.Heats)-len(dropIdx))
			for i, h := range e.raceState.Heats {
				if !dropIdx[i] {
					kept = append(kept, h)
				}
			}
			e.raceState.Heats = kept
		}

		var unstartedPtrs []*domain.RaceHeat
		totalRoundHeats := 0
		for i := range e.raceState.Heats {
			if e.raceState.Heats[i].RoundID == roundID {
				totalRoundHeats++
				if isUnstartedHeatState(e.raceState.Heats[i].State) {
					syncUnstartedHeatSeatsToConfig(&e.raceState.Heats[i], maxPerHeat, stgSettings.SeatChannels)
					for si := range e.raceState.Heats[i].Seats {
						e.raceState.Heats[i].Seats[si].ManualLock = false
						e.raceState.Heats[i].Seats[si].Feeder = nil
						clearSeatOccupant(&e.raceState.Heats[i].Seats[si], false)
					}
					unstartedPtrs = append(unstartedPtrs, &e.raceState.Heats[i])
				}
			}
		}
		if len(unstartedPtrs) == 0 {
			return
		}
		numU := len(unstartedPtrs)
		cursors := make([]int, numU)
		for idx, sf := range remFeeders {
			pass := idx / numU
			rem := idx % numU
			dst := rem
			if pass%2 == 1 {
				dst = numU - 1 - rem
			}
			if cursors[dst] >= len(unstartedPtrs[dst].Seats) {
				for alt := 0; alt < numU; alt++ {
					if cursors[alt] < len(unstartedPtrs[alt].Seats) {
						dst = alt
						break
					}
				}
			}
			if cursors[dst] < len(unstartedPtrs[dst].Seats) {
				si := cursors[dst]
				cursors[dst]++
				fc := sf.feeder
				unstartedPtrs[dst].Seats[si].Feeder = &fc
				unstartedPtrs[dst].Seats[si].SourceLabel = sf.label
				unstartedPtrs[dst].State = domain.HeatWaiting
			}
		}
		idxInRound := 0
		for i := range e.raceState.Heats {
			if e.raceState.Heats[i].RoundID == roundID {
				idxInRound++
				if totalRoundHeats == 1 {
					e.raceState.Heats[i].Title = r.Title
				} else {
					e.raceState.Heats[i].Title = fmt.Sprintf("%s · Heat %d", r.Title, idxInRound)
				}
			}
		}
	}
}

func snakeBracketHeatOrder(m int) []int {
	if m <= 1 {
		return []int{0}
	}
	if (m & (m - 1)) != 0 {
		out := make([]int, m)
		for i := range out {
			out[i] = i
		}
		return out
	}
	seeds := []int{1, 2}
	for len(seeds) < m {
		next := make([]int, 0, len(seeds)*2)
		sum := len(seeds)*2 + 1
		for _, s := range seeds {
			next = append(next, s, sum-s)
		}
		seeds = next
	}
	posToHeat := make([]int, m)
	for heatIdx, seedNum := range seeds {
		posToHeat[seedNum-1] = heatIdx
	}
	return posToHeat
}

func (e *Engine) sortCustomHeatsAndOrderLocked(stageIdx int) {
	roundOrder := make(map[string]int, len(e.raceState.Rounds))
	for idx, r := range e.raceState.Rounds {
		roundOrder[r.ID] = idx
	}
	sort.SliceStable(e.raceState.Heats, func(i, j int) bool {
		hi := e.raceState.Heats[i]
		hj := e.raceState.Heats[j]
		if hi.StageIndex != hj.StageIndex {
			return hi.StageIndex < hj.StageIndex
		}
		if hi.StageIndex != stageIdx {
			return false
		}
		if hi.Column != hj.Column {
			return hi.Column < hj.Column
		}
		if hi.RoundID != hj.RoundID {
			return roundOrder[hi.RoundID] < roundOrder[hj.RoundID]
		}
		return false
	})
	for i := range e.raceState.Heats {
		e.raceState.Heats[i].Order = i + 1
	}
}

func assignPilotsWithChannelContinuity(
	h *domain.RaceHeat,
	pilots []domain.PilotSlot,
	seatChannels []uint8,
	lastCh map[int]uint8,
) {
	for si := range h.Seats {
		clearSeatOccupant(&h.Seats[si], false)
		h.Seats[si].Feeder = nil
		h.Seats[si].ManualLock = false
		if si < len(seatChannels) {
			if band, ch, freq, ok := domain.DecodeBandChannel(seatChannels[si]); ok {
				h.Seats[si].Band = band
				h.Seats[si].Channel = ch
				h.Seats[si].FrequencyMHz = freq
			}
		}
	}
	usedSeat := make(map[int]bool)
	remaining := make([]domain.PilotSlot, 0, len(pilots))

	// First pass: keep pilots on their previous VTX channel if that seat exists and is free!
	for _, p := range pilots {
		prev := lastCh[p.SlotIndex]
		matched := -1
		if prev > 0 {
			for si := range h.Seats {
				if !usedSeat[si] && domain.EncodeBandChannel(h.Seats[si].Band, h.Seats[si].Channel) == prev {
					matched = si
					break
				}
			}
		}
		if matched >= 0 {
			usedSeat[matched] = true
			populateDirectSeat(&h.Seats[matched], p, matched+1)
			lastCh[p.SlotIndex] = domain.EncodeBandChannel(h.Seats[matched].Band, h.Seats[matched].Channel)
		} else {
			remaining = append(remaining, p)
		}
	}
	// Second pass: place remaining pilots into remaining open seats
	for _, p := range remaining {
		for si := range h.Seats {
			if !usedSeat[si] {
				usedSeat[si] = true
				populateDirectSeat(&h.Seats[si], p, si+1)
				lastCh[p.SlotIndex] = domain.EncodeBandChannel(h.Seats[si].Band, h.Seats[si].Channel)
				break
			}
		}
	}
}

func populateDirectSeat(s *domain.HeatSeat, p domain.PilotSlot, seed int) {
	s.PilotSlotIndex = p.SlotIndex
	s.Callsign = p.Callsign
	s.PhoneticName = p.PhoneticName
	s.Color = p.Color
	s.Seed = seed
	s.SourceLabel = fmt.Sprintf("Seed #%d", seed)
	s.Status = domain.PilotHeatStaged
	s.Crossings = nil
	s.Laps = []domain.HeatLap{}
}

func (e *Engine) deleteRoundLocked(roundID string, col int, lane string) error {
	race.SyncRoundsMetadata(&e.raceState)
	stageIdx := e.raceState.ActiveStageIndex
	targetID := strings.TrimSpace(roundID)
	targetCol := col
	if targetID != "" {
		if r := e.findRoundByIDLocked(targetID); r != nil {
			targetCol = r.Column
			stageIdx = r.StageIndex
		} else {
			return fmt.Errorf("round not found")
		}
	} else {
		for _, r := range e.raceState.Rounds {
			if r.StageIndex == stageIdx && r.Column == col && (lane == "" || r.BracketLane == lane) {
				targetID = r.ID
				targetCol = r.Column
				break
			}
		}
	}
	if targetID == "" {
		return fmt.Errorf("round not found")
	}
	if domain.IsStagePortalRoundID(targetID) {
		return fmt.Errorf("use Format mode to disconnect or remove stage seeding connections")
	}
	e.markStageCustomizedLocked(stageIdx)

	deletedHeatIDs := make(map[string]bool)
	for _, h := range e.raceState.Heats {
		if h.RoundID == targetID {
			if !isUnstartedHeatState(h.State) {
				return fmt.Errorf("cannot delete round because heat %s has already started or finished", h.ShortLabel)
			}
			deletedHeatIDs[h.ID] = true
		}
	}

	keptHeats := make([]domain.RaceHeat, 0, len(e.raceState.Heats))
	for _, h := range e.raceState.Heats {
		if !deletedHeatIDs[h.ID] {
			keptHeats = append(keptHeats, h)
		}
	}
	e.raceState.Heats = keptHeats

	keptRounds := make([]domain.RaceRound, 0, len(e.raceState.Rounds))
	for _, r := range e.raceState.Rounds {
		if r.ID != targetID {
			keptRounds = append(keptRounds, r)
		}
	}
	e.raceState.Rounds = keptRounds

	var downstreamAffected []string
	keptConns := make([]domain.RoundConnection, 0, len(e.raceState.Connections))
	for _, c := range e.raceState.Connections {
		if c.FromRoundID == targetID {
			downstreamAffected = append(downstreamAffected, c.ToRoundID)
			continue
		}
		if c.ToRoundID == targetID {
			continue
		}
		keptConns = append(keptConns, c)
	}
	e.raceState.Connections = keptConns

	// Check if another round still shares targetCol before clearing FromRoundColumn feeders
	colStillExists := false
	for _, r := range e.raceState.Rounds {
		if r.StageIndex == stageIdx && r.Column == targetCol {
			colStillExists = true
			break
		}
	}

	for hi := range e.raceState.Heats {
		e.raceState.Heats[hi].Order = hi + 1
		for si := range e.raceState.Heats[hi].Seats {
			s := &e.raceState.Heats[hi].Seats[si]
			if s.Feeder != nil && (deletedHeatIDs[s.Feeder.FromHeatID] || (!colStillExists && s.Feeder.FromRoundColumn == targetCol)) {
				s.Feeder = nil
				s.ManualLock = false
				if s.PilotSlotIndex == 0 {
					s.SourceLabel = "Open / BYE"
				}
			}
		}
		finalizeEditedHeatState(&e.raceState.Heats[hi], e.raceState.Config.QualifyingMetric)
	}
	if deletedHeatIDs[e.raceState.ActiveHeatID] {
		e.raceState.ActiveHeatID = ""
	}
	for _, dstID := range downstreamAffected {
		if dstR := e.findRoundByIDLocked(dstID); dstR != nil {
			hasIn := false
			for _, c := range e.raceState.Connections {
				if c.ToRoundID == dstID {
					hasIn = true
					break
				}
			}
			if !hasIn {
				dstR.SeedSource = "empty"
			}
		}
		e.recomputeGraphAndRebuildLocked(stageIdx, dstID)
	}
	race.RebuildEdgesFromFeeders(&e.raceState)
	race.SyncRoundsMetadata(&e.raceState)
	return nil
}

// regenerateUpcomingRoundsLocked re-balances all unstarted standalone pilot rounds from the
// current `Active` checked-in roster without modifying any started, finished, or confirmed heats,
// and cascades resizing to any unstarted connected downstream rounds.
func (e *Engine) regenerateUpcomingRoundsLocked() {
	if !e.raceState.Generated {
		return
	}
	// If zero heats have started yet and race uses a standard template, regenerate cleanly!
	if !hasAnyStartedHeatInState(&e.raceState) && e.raceState.TemplateID != "" && e.raceState.TemplateID != "custom" && len(e.raceState.Stages) <= 1 {
		e.regenerateTournamentLocked()
		return
	}
	if !hasAnyStartedHeatInState(&e.raceState) && e.raceState.TemplateID != "" && e.raceState.TemplateID != "custom" && len(e.raceState.Stages) <= 2 && !e.hasAnyCustomizedStageLocked() {
		e.regenerateTournamentLocked()
		return
	}
	if !hasAnyStartedHeatInState(&e.raceState) && (len(e.raceState.Stages) > 2 || e.hasAnyCustomizedStageLocked()) {
		e.rebuildAllUnstartedNonCustomStagesLocked()
		return
	}

	race.SyncRoundsMetadata(&e.raceState)
	activePilots := e.activeEventPilotsForGenerationLocked()
	cfg := e.raceState.Config.Normalized()
	stageIdx := e.raceState.ActiveStageIndex
	stgSettings := e.stageSettingsLocked(stageIdx)
	maxPerHeat := stgSettings.PilotsPerHeat
	if maxPerHeat < 2 {
		maxPerHeat = 4
	}
	lastCh := race.LastChannelByPilotConfirmed(e.raceState.Heats)

	inCount := make(map[string]int)
	for _, c := range e.raceState.Connections {
		inCount[c.ToRoundID]++
	}

	var roundIDs []string
	for _, r := range e.raceState.Rounds {
		if r.StageIndex == stageIdx {
			roundIDs = append(roundIDs, r.ID)
		}
	}

	for _, rid := range roundIDs {
		r := e.findRoundByIDLocked(rid)
		if r == nil || inCount[rid] > 0 {
			continue
		}
		var grpIdx []int
		allUnstarted := true
		hasFeeder := false
		for i := range e.raceState.Heats {
			h := &e.raceState.Heats[i]
			if h.RoundID != rid {
				continue
			}
			grpIdx = append(grpIdx, i)
			if !isUnstartedHeatState(h.State) {
				allUnstarted = false
			}
			for _, s := range h.Seats {
				if s.Feeder != nil {
					hasFeeder = true
				}
			}
		}
		if len(grpIdx) == 0 || hasFeeder || r.SeedSource == "empty" {
			continue
		}

		// Case A: Entire standalone pilot round is unstarted -> resize/re-balance heats for current Active pilots!
		if allUnstarted && len(activePilots) > 0 {
			neededHeats := (len(activePilots) + maxPerHeat - 1) / maxPerHeat
			if neededHeats < 1 {
				neededHeats = 1
			}
			targetHeats := e.ensureRoundHeatCountLocked(rid, neededHeats)
			buckets := make([][]domain.PilotSlot, len(targetHeats))
			shift := 0
			if r.Column > 1 {
				shift = r.Column - 1
			}
			for pi, p := range activePilots {
				bIdx := (pi + shift) % len(targetHeats)
				buckets[bIdx] = append(buckets[bIdx], p)
			}
			for bi, th := range targetHeats {
				assignPilotsWithChannelContinuity(th, buckets[bi], stgSettings.SeatChannels, lastCh)
				finalizeEditedHeatState(th, stgSettings.QualifyingMetric)
			}
			continue
		}

		// Case B: Partially started round -> seat any unseated Active late arrivals into open seats or overflow heat
		seatedInGroup := make(map[int]bool)
		for _, hi := range grpIdx {
			for _, s := range e.raceState.Heats[hi].Seats {
				if s.PilotSlotIndex > 0 {
					seatedInGroup[s.PilotSlotIndex] = true
				}
			}
		}
		for _, p := range activePilots {
			if seatedInGroup[p.SlotIndex] {
				continue
			}
			placed := false
			for _, hi := range grpIdx {
				h := &e.raceState.Heats[hi]
				if !isUnstartedHeatState(h.State) {
					continue
				}
				for si := range h.Seats {
					if h.Seats[si].PilotSlotIndex == 0 {
						populateDirectSeat(&h.Seats[si], p, p.SlotIndex)
						h.Seats[si].SourceLabel = "Late Entry"
						finalizeEditedHeatState(h, cfg.QualifyingMetric)
						placed = true
						break
					}
				}
				if placed {
					break
				}
			}
			if !placed {
				newID := e.appendHeatToRoundOrColumnLocked(rid, r.BracketLane, r.Round, r.Column)
				for i := range e.raceState.Heats {
					if e.raceState.Heats[i].ID == newID {
						grpIdx = append(grpIdx, i)
						h := &e.raceState.Heats[i]
						if len(h.Seats) > 0 {
							populateDirectSeat(&h.Seats[0], p, p.SlotIndex)
							h.Seats[0].SourceLabel = "Late Entry"
							finalizeEditedHeatState(h, cfg.QualifyingMetric)
						}
						break
					}
				}
			}
		}
	}

	// Rebuild any unstarted downstream connected rounds in topological order so heat counts stay balanced!
	for _, r := range e.raceState.Rounds {
		if r.StageIndex == stageIdx && inCount[r.ID] > 0 {
			e.rebuildSingleRoundLocked(r.ID)
		}
	}

	// If upstream stage roster grew (e.g. late arrivals checked in), resize unstarted downstream stages too!
	if len(e.raceState.Stages) > 2 || e.hasAnyCustomizedStageLocked() {
		for _, sc := range race.OutgoingStageConnections(&e.raceState, stageIdx) {
			e.onStageIncomingChangedLocked(sc.ToStageIndex)
		}
	} else if e.raceState.TotalStages == 2 && stageIdx == 1 && !race.AnyRealHeatStartedInStage(&e.raceState, 2) {
		if e.raceState.TemplateID != "" && e.raceState.TemplateID != "custom" {
			var s1Heats []domain.RaceHeat
			for _, h := range e.raceState.Heats {
				if h.StageIndex == 1 {
					s1Heats = append(s1Heats, h)
				}
			}
			var keptRounds []domain.RaceRound
			for _, r := range e.raceState.Rounds {
				if r.StageIndex == 1 || r.ID == domain.Stage2HandoffInID {
					keptRounds = append(keptRounds, r)
				}
			}
			var keptConns []domain.RoundConnection
			for _, c := range e.raceState.Connections {
				if c.StageIndex == 1 {
					keptConns = append(keptConns, c)
				}
			}
			s2Heats, _ := race.GenerateStage2PlaceholderMainStage(cfg, len(activePilots), len(s1Heats))
			e.raceState.Heats = append(s1Heats, s2Heats...)
			e.raceState.Rounds = keptRounds
			e.raceState.Connections = keptConns
		} else {
			e.recomputeGraphAndRebuildLocked(2, domain.Stage2HandoffInID)
		}
	}

	if e.raceState.TemplateID == "custom" {
		e.sortCustomHeatsAndOrderLocked(stageIdx)
	} else {
		for i := range e.raceState.Heats {
			e.raceState.Heats[i].Order = i + 1
		}
	}
	for _, ep := range e.raceState.Roster {
		applyAttendanceToRaceLocked(&e.raceState, ep.SlotIndex, ep.IsAvailableToRace())
	}
	race.RebuildEdgesFromFeeders(&e.raceState)
	race.SyncRoundsMetadata(&e.raceState)
}

func findSeatIndex(h *domain.RaceHeat, seatIndex int) int {
	for i := range h.Seats {
		if h.Seats[i].SeatIndex == seatIndex {
			return i
		}
	}
	return -1
}

func heatContainsPilotExcept(h *domain.RaceHeat, slotIndex int, ignoreArrayIdx int) bool {
	for i := range h.Seats {
		if i != ignoreArrayIdx && h.Seats[i].PilotSlotIndex == slotIndex {
			return true
		}
	}
	return false
}

func swapSeatOccupants(a, b *domain.HeatSeat) {
	aSlot, aName, aPhon, aCol, aSeed, aStat := a.PilotSlotIndex, a.Callsign, a.PhoneticName, a.Color, a.Seed, a.Status
	bSlot, bName, bPhon, bCol, bSeed, bStat := b.PilotSlotIndex, b.Callsign, b.PhoneticName, b.Color, b.Seed, b.Status

	a.PilotSlotIndex, a.Callsign, a.PhoneticName, a.Color, a.Seed, a.Status = bSlot, bName, bPhon, bCol, bSeed, bStat
	b.PilotSlotIndex, b.Callsign, b.PhoneticName, b.Color, b.Seed, b.Status = aSlot, aName, aPhon, aCol, aSeed, aStat

	a.Crossings, a.Laps, a.ManualPosition, a.PenaltySec = nil, []domain.HeatLap{}, 0, 0
	b.Crossings, b.Laps, b.ManualPosition, b.PenaltySec = nil, []domain.HeatLap{}, 0, 0

	for _, s := range []*domain.HeatSeat{a, b} {
		if s.Feeder != nil {
			s.ManualLock = true
		} else if s.PilotSlotIndex > 0 {
			s.ManualLock = true
			if s.SourceLabel == "" || s.SourceLabel == "Open / BYE" {
				s.SourceLabel = "Manual"
			}
		} else {
			s.ManualLock = false
			s.SourceLabel = "Open / BYE"
		}
	}
}

type lockedSeatOverride struct {
	heatOrd int
	seatIdx int
	slot    int
	ch      uint8
}

func (e *Engine) populateBalancedPilotRoundPreservingLocksLocked(
	roundID string,
	r *domain.RaceRound,
	srcHeats []*domain.RaceHeat,
	pilots []domain.PilotSlot,
	neededHeats int,
	stgSettings domain.StageSettings,
	priorHeats []domain.RaceHeat,
) {
	activeBySlot := make(map[int]domain.PilotSlot, len(pilots))
	seedBySlot := make(map[int]int, len(pilots))
	for i, p := range pilots {
		activeBySlot[p.SlotIndex] = p
		seedBySlot[p.SlotIndex] = i + 1
	}

	// Capture any existing ManualLock pilot placements in this unstarted round
	var locks []lockedSeatOverride
	seenLocked := make(map[int]bool)
	hOrd := 0
	for _, h := range e.raceState.Heats {
		if h.RoundID != roundID {
			continue
		}
		for si, s := range h.Seats {
			if s.ManualLock && s.PilotSlotIndex > 0 && !seenLocked[s.PilotSlotIndex] {
				if _, stillActive := activeBySlot[s.PilotSlotIndex]; stillActive {
					seenLocked[s.PilotSlotIndex] = true
					locks = append(locks, lockedSeatOverride{
						heatOrd: hOrd,
						seatIdx: si,
						slot:    s.PilotSlotIndex,
						ch:      s.Channel,
					})
				}
			}
		}
		hOrd++
	}

	targetHeats := e.ensureRoundHeatCountLocked(roundID, neededHeats)
	if len(targetHeats) == 0 {
		return
	}

	if (r.SeedDistribution == "snake" || r.SeedDistribution == "sequential") && len(priorHeats) == 0 && len(locks) == 0 {
		lastCh := race.LastChannelByPilot(e.raceState.Heats)
		numDst := len(targetHeats)
		buckets := make([][]domain.PilotSlot, numDst)
		if r.SeedDistribution == "sequential" {
			chunk := (len(pilots) + numDst - 1) / numDst
			if chunk < 1 {
				chunk = 1
			}
			for idx, p := range pilots {
				dstIdx := idx / chunk
				if dstIdx >= numDst {
					dstIdx = numDst - 1
				}
				buckets[dstIdx] = append(buckets[dstIdx], p)
			}
		} else {
			bOrder := snakeBracketHeatOrder(numDst)
			for idx, p := range pilots {
				pass := idx / numDst
				rem := idx % numDst
				var dstIdx int
				if pass%2 == 0 {
					dstIdx = bOrder[rem]
				} else {
					dstIdx = bOrder[numDst-1-rem]
				}
				buckets[dstIdx] = append(buckets[dstIdx], p)
			}
		}
		for bi, th := range targetHeats {
			assignPilotsWithChannelContinuity(th, buckets[bi], stgSettings.SeatChannels, lastCh)
			finalizeEditedHeatState(th, stgSettings.QualifyingMetric)
		}
		return
	}

	scheduled := race.ScheduleBalancedQualifyingRound(
		srcHeats,
		len(targetHeats),
		stgSettings.SeatChannels,
		priorHeats,
		pilots,
		r.Round,
	)

	for hi, th := range targetHeats {
		if hi < len(scheduled) && len(scheduled[hi]) == len(th.Seats) {
			for si := range th.Seats {
				asgn := scheduled[hi][si]
				band, ch, freq, ok := domain.DecodeBandChannel(asgn.Channel)
				if !ok {
					band = th.Seats[si].Band
					if band == 0 {
						band = domain.BandRaceband
					}
					ch = th.Seats[si].Channel
					freq = domain.FrequencyForBandChannel(band, ch)
				}
				th.Seats[si].Band = band
				th.Seats[si].Channel = ch
				th.Seats[si].FrequencyMHz = freq
				th.Seats[si].ManualLock = false
				th.Seats[si].Feeder = nil
				if asgn.PilotSlotIndex > 0 {
					th.Seats[si].PilotSlotIndex = asgn.PilotSlotIndex
					th.Seats[si].Callsign = asgn.Callsign
					th.Seats[si].PhoneticName = asgn.PhoneticName
					th.Seats[si].Color = asgn.Color
					th.Seats[si].Seed = asgn.Seed
					th.Seats[si].SourceLabel = fmt.Sprintf("Seed #%d", asgn.Seed)
					th.Seats[si].Status = domain.PilotHeatStaged
					th.Seats[si].Crossings = nil
					th.Seats[si].Laps = []domain.HeatLap{}
					th.Seats[si].ManualPosition = 0
					th.Seats[si].PenaltySec = 0
				} else {
					clearSeatOccupant(&th.Seats[si], false)
				}
			}
		} else {
			for si := range th.Seats {
				th.Seats[si].ManualLock = false
				th.Seats[si].Feeder = nil
				clearSeatOccupant(&th.Seats[si], false)
			}
		}
	}

	// Re-apply manual lock overrides by swapping the locked pilot from wherever the scheduler placed them
	for _, lk := range locks {
		if lk.heatOrd < 0 || lk.heatOrd >= len(targetHeats) {
			continue
		}
		dstH := targetHeats[lk.heatOrd]
		if lk.seatIdx < 0 || lk.seatIdx >= len(dstH.Seats) {
			continue
		}
		curHIdx, curSIdx := -1, -1
		for hi, th := range targetHeats {
			for si, s := range th.Seats {
				if s.PilotSlotIndex == lk.slot {
					curHIdx, curSIdx = hi, si
					break
				}
			}
			if curHIdx >= 0 {
				break
			}
		}
		if curHIdx == lk.heatOrd && curSIdx == lk.seatIdx {
			dstH.Seats[lk.seatIdx].ManualLock = true
			continue
		}
		// Prevent duplicate pilot in dstH if swapping from another heat
		if curHIdx >= 0 {
			otherSlot := dstH.Seats[lk.seatIdx].PilotSlotIndex
			if curHIdx != lk.heatOrd && otherSlot > 0 && heatContainsPilotExcept(targetHeats[curHIdx], otherSlot, curSIdx) {
				continue
			}
			swapSeatOccupants(&targetHeats[curHIdx].Seats[curSIdx], &dstH.Seats[lk.seatIdx])
			targetHeats[curHIdx].Seats[curSIdx].ManualLock = false
			dstH.Seats[lk.seatIdx].ManualLock = true
		} else if p, ok := activeBySlot[lk.slot]; ok && !heatContainsPilotExcept(dstH, lk.slot, lk.seatIdx) {
			populateDirectSeat(&dstH.Seats[lk.seatIdx], p, seedBySlot[lk.slot])
			dstH.Seats[lk.seatIdx].ManualLock = true
			dstH.Seats[lk.seatIdx].SourceLabel = "Manual"
		}
	}

	for _, th := range targetHeats {
		th.State = domain.HeatReady
		finalizeEditedHeatState(th, stgSettings.QualifyingMetric)
	}
}

// upstreamStandingsCapacityLocked determines how many ranked entrants `srcR` can feed downstream
// via `standings_top` or `all_pilots_ranked`, accounting for Open Qualifier early-seed contenders,
// concrete seated pilots, or upstream `Feeder` placeholders (falling back to `maxPerHeat` on empty drafts).
func (e *Engine) upstreamStandingsCapacityLocked(srcR *domain.RaceRound, conn domain.RoundConnection, maxPerHeat int) int {
	if maxPerHeat < 2 {
		maxPerHeat = 4
	}
	activeCnt := len(e.activeEventPilotsForGenerationLocked())
	if srcR == nil {
		if activeCnt >= 2 {
			return activeCnt
		}
		return maxPerHeat
	}

	if srcR.StageFormat == domain.FormatOpenQualifier || domain.IsOpenQualRoundID(srcR.ID) {
		if conn.SeededEarly || e.raceState.Stage2SeededEarly {
			chainIDs := race.QualifierChainRoundIDs(&e.raceState, srcR.ID)
			chainSet := make(map[string]bool, len(chainIDs))
			for _, cid := range chainIDs {
				chainSet[cid] = true
			}
			flew := make(map[int]bool)
			for _, h := range e.raceState.Heats {
				if chainSet[h.RoundID] && h.State == domain.HeatConfirmed {
					for _, s := range h.Seats {
						if s.PilotSlotIndex > 0 && s.Status != domain.PilotHeatDQ && s.Status != domain.PilotHeatDNS {
							flew[s.PilotSlotIndex] = true
						}
					}
				}
			}
			if len(flew) >= 2 {
				return len(flew)
			}
		}
		seen := make(map[int]bool)
		for _, ap := range e.activeEventPilotsForGenerationLocked() {
			seen[ap.SlotIndex] = true
		}
		for _, h := range e.raceState.Heats {
			if h.RoundID == srcR.ID {
				for _, s := range h.Seats {
					if s.PilotSlotIndex > 0 && s.Status != domain.PilotHeatDQ && s.Status != domain.PilotHeatDNS {
						seen[s.PilotSlotIndex] = true
					}
				}
			}
		}
		if len(seen) >= 2 {
			return len(seen)
		}
		return maxPerHeat
	}

	seenConcrete := make(map[int]bool)
	feederCnt := 0
	srcHeatCount := 0
	for _, h := range e.raceState.Heats {
		if h.RoundID != srcR.ID {
			continue
		}
		srcHeatCount++
		for _, s := range h.Seats {
			if s.PilotSlotIndex > 0 {
				if s.Status != domain.PilotHeatDQ && s.Status != domain.PilotHeatDNS {
					seenConcrete[s.PilotSlotIndex] = true
				}
			} else if s.Feeder != nil && !s.Feeder.IsBye {
				feederCnt++
			}
		}
	}
	total := len(seenConcrete) + feederCnt
	if total >= 1 {
		return total
	}
	if srcR.SeedSource == "all_active_pilots" && activeCnt >= 2 {
		return activeCnt
	}
	if srcHeatCount > 0 {
		return srcHeatCount * maxPerHeat
	}
	if activeCnt >= 2 {
		return activeCnt
	}
	return maxPerHeat
}

// refreshUnstartedPilotsInRoundsLocked refreshes unstarted root rounds (`all_active_pilots` and `open_qualifier`)
// and walks the ENTIRE downstream DAG all the way to Finals so every unstarted round dynamically resizes and updates placeholders.
func (e *Engine) refreshUnstartedPilotsInRoundsLocked() {
	if !e.raceState.Generated {
		return
	}
	race.EnsureStagesMetadata(&e.raceState)
	race.SyncRoundsMetadata(&e.raceState)
	qualReconciled := make(map[int]bool)
	for _, stg := range e.raceState.Stages {
		if stg.Format == domain.FormatQualifying && !stg.Customized {
			e.reconcileQualifyingStageLocked(stg.Index)
			qualReconciled[stg.Index] = true
		}
	}
	stagesSeen := make(map[int]bool)
	for _, r := range e.raceState.Rounds {
		if qualReconciled[r.StageIndex] || domain.IsStagePortalRoundID(r.ID) {
			continue
		}
		if domain.IsOpenQualRoundID(r.ID) || r.StageFormat == domain.FormatOpenQualifier {
			e.cascadeBalancedRoundsFromLocked(r.StageIndex, r.ID)
			stagesSeen[r.StageIndex] = true
			continue
		}
		if r.SeedSource != "all_active_pilots" {
			continue
		}
		if e.ensureRoundUnstartedLocked(r.ID) != nil {
			continue
		}
		e.rebuildSingleRoundLocked(r.ID)
		e.cascadeBalancedRoundsFromLocked(r.StageIndex, r.ID)
		stagesSeen[r.StageIndex] = true
	}
	for sIdx := range stagesSeen {
		e.sortCustomHeatsAndOrderLocked(sIdx)
	}
	if len(stagesSeen) > 0 {
		race.RebuildEdgesFromFeeders(&e.raceState)
		race.SyncRoundsMetadata(&e.raceState)
	}
}

// cascadeBalancedRoundsFromLocked walks ALL valid outgoing connections down the DAG from `fromRoundID`
// all the way to Finals in topological order, re-planning and populating placeholders/pilots on every
// unstarted downstream round (preserving any manual seat locks on those rounds).
func (e *Engine) cascadeBalancedRoundsFromLocked(stageIdx int, fromRoundID string) {
	if fromRoundID == "" {
		return
	}
	roundByID := make(map[string]*domain.RaceRound, len(e.raceState.Rounds))
	for i := range e.raceState.Rounds {
		r := &e.raceState.Rounds[i]
		if (stageIdx <= 0 || r.StageIndex == stageIdx) && !domain.IsStagePortalRoundID(r.ID) {
			roundByID[r.ID] = r
		}
	}

	// Also refresh ExpectedWinners on `fromRoundID` itself if it is unstarted
	if srcR := roundByID[fromRoundID]; srcR != nil && srcR.StageFormat != domain.FormatQualifying && srcR.BracketLane != "finals" {
		stgSet := e.stageSettingsLocked(srcR.StageIndex)
		defAdv := stgSet.PilotsPerHeat / 2
		if defAdv < 1 {
			defAdv = 1
		}
		outAdv := race.OutgoingTopAdvance(e.raceState.Connections, fromRoundID, defAdv)
		if outAdv < 1 {
			outAdv = defAdv
		}
		for hi := range e.raceState.Heats {
			if e.raceState.Heats[hi].RoundID == fromRoundID && isUnstartedHeatState(e.raceState.Heats[hi].State) {
				ent := race.HeatEntrants(&e.raceState.Heats[hi])
				if ent == 0 {
					ent = len(e.raceState.Heats[hi].Seats)
				}
				e.raceState.Heats[hi].ExpectedWinners = race.EffectiveAdvance(outAdv, ent)
				race.RecomputeHeat(&e.raceState.Heats[hi], stgSet.QualifyingMetric)
			}
		}
	}

	adj := make(map[string][]string)
	inConns := make(map[string][]domain.RoundConnection)
	for _, c := range e.raceState.Connections {
		if c.Invalid || domain.IsStagePortalRoundID(c.FromRoundID) || domain.IsStagePortalRoundID(c.ToRoundID) {
			continue
		}
		if stageIdx > 0 && c.StageIndex != stageIdx {
			continue
		}
		adj[c.FromRoundID] = append(adj[c.FromRoundID], c.ToRoundID)
		inConns[c.ToRoundID] = append(inConns[c.ToRoundID], c)
	}
	if len(adj[fromRoundID]) == 0 {
		return
	}

	reachable := make(map[string]bool)
	queue := append([]string(nil), adj[fromRoundID]...)
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if reachable[cur] || cur == fromRoundID {
			continue
		}
		if _, ok := roundByID[cur]; !ok {
			continue
		}
		reachable[cur] = true
		queue = append(queue, adj[cur]...)
	}
	if len(reachable) == 0 {
		return
	}

	inDeg := make(map[string]int, len(reachable))
	subAdj := make(map[string][]string, len(reachable))
	for id := range reachable {
		for _, ic := range inConns[id] {
			if reachable[ic.FromRoundID] && ic.FromRoundID != id {
				subAdj[ic.FromRoundID] = append(subAdj[ic.FromRoundID], id)
				inDeg[id]++
			}
		}
	}
	lessID := func(a, b string) bool {
		ra, rb := roundByID[a], roundByID[b]
		if ra == nil || rb == nil {
			return a < b
		}
		if ra.Column != rb.Column {
			return ra.Column < rb.Column
		}
		if ra.Round != rb.Round {
			return ra.Round < rb.Round
		}
		return a < b
	}
	var ready []string
	for id := range reachable {
		if inDeg[id] == 0 {
			ready = append(ready, id)
		}
	}
	sort.SliceStable(ready, func(i, j int) bool { return lessID(ready[i], ready[j]) })

	var ordered []string
	placed := make(map[string]bool, len(reachable))
	for len(ready) > 0 {
		cur := ready[0]
		ready = queuePop(ready)
		if placed[cur] {
			continue
		}
		placed[cur] = true
		ordered = append(ordered, cur)
		for _, nxt := range subAdj[cur] {
			inDeg[nxt]--
			if inDeg[nxt] == 0 && !placed[nxt] {
				ready = append(ready, nxt)
			}
		}
		sort.SliceStable(ready, func(i, j int) bool { return lessID(ready[i], ready[j]) })
	}
	for id := range reachable {
		if !placed[id] {
			ordered = append(ordered, id)
		}
	}

	for _, rid := range ordered {
		if e.ensureRoundUnstartedLocked(rid) != nil {
			continue
		}
		// Preserve any explicit ManualLock seats on downstream rounds during automatic cascades
		type lockedSeatSnap struct {
			heatIdx int
			seatIdx int
			seat    domain.HeatSeat
		}
		var savedLocks []lockedSeatSnap
		hIdx := 0
		for _, h := range e.raceState.Heats {
			if h.RoundID != rid {
				continue
			}
			for si, s := range h.Seats {
				if s.ManualLock && s.PilotSlotIndex > 0 {
					savedLocks = append(savedLocks, lockedSeatSnap{heatIdx: hIdx, seatIdx: si, seat: s})
				}
			}
			hIdx++
		}

		e.rebalanceAutoConnectionsIntoLocked(rid)
		e.rebuildSingleRoundLocked(rid)

		if len(savedLocks) > 0 {
			var rebuiltHeats []*domain.RaceHeat
			for i := range e.raceState.Heats {
				if e.raceState.Heats[i].RoundID == rid {
					rebuiltHeats = append(rebuiltHeats, &e.raceState.Heats[i])
				}
			}
			lockedSlots := make(map[int]bool, len(savedLocks))
			for _, lk := range savedLocks {
				if lk.heatIdx < len(rebuiltHeats) && lk.seatIdx < len(rebuiltHeats[lk.heatIdx].Seats) {
					lockedSlots[lk.seat.PilotSlotIndex] = true
				}
			}
			if len(lockedSlots) > 0 {
				for _, rh := range rebuiltHeats {
					for si := range rh.Seats {
						if !rh.Seats[si].ManualLock && lockedSlots[rh.Seats[si].PilotSlotIndex] {
							clearSeatOccupant(&rh.Seats[si], false)
						}
					}
				}
				for _, lk := range savedLocks {
					if lk.heatIdx < len(rebuiltHeats) && lk.seatIdx < len(rebuiltHeats[lk.heatIdx].Seats) {
						dst := &rebuiltHeats[lk.heatIdx].Seats[lk.seatIdx]
						keepFeeder := dst.Feeder
						*dst = lk.seat
						dst.Feeder = keepFeeder
						dst.ManualLock = true
					}
				}
			}
		}
	}

	effStage := stageIdx
	if effStage <= 0 {
		effStage = 1
	}
	e.sortCustomHeatsAndOrderLocked(effStage)
	race.RebuildEdgesFromFeeders(&e.raceState)
	race.SyncRoundsMetadata(&e.raceState)
}

func queuePop(s []string) []string {
	if len(s) <= 1 {
		return nil
	}
	return s[1:]
}

func clearSeatOccupant(s *domain.HeatSeat, lockFeeder bool) {
	s.PilotSlotIndex = 0
	s.Callsign = ""
	s.PhoneticName = ""
	s.Color = ""
	s.Seed = 0
	s.Status = domain.PilotHeatStaged
	s.PreOverrideStatus = ""
	s.StatusOverridden = false
	s.RosterDQ = false
	s.Crossings = nil
	s.Laps = []domain.HeatLap{}
	s.ManualPosition = 0
	s.PenaltySec = 0
	if s.Feeder != nil {
		if lockFeeder {
			s.ManualLock = true
		}
	} else {
		s.SourceLabel = "Open / BYE"
	}
}

func finalizeEditedHeatState(h *domain.RaceHeat, qualMetric domain.QualifyingMetric) {
	allUnlockedFeedersKnown := true
	activePilots := 0
	for _, s := range h.Seats {
		if s.PilotSlotIndex > 0 && s.Status != domain.PilotHeatDNS && s.Status != domain.PilotHeatDQ {
			activePilots++
		}
		if s.Feeder != nil && !s.ManualLock && s.PilotSlotIndex == 0 {
			allUnlockedFeedersKnown = false
		}
	}
	if activePilots > 0 && allUnlockedFeedersKnown && h.State == domain.HeatWaiting {
		h.State = domain.HeatReady
	}
	race.RecomputeHeat(h, qualMetric)
}

func (e *Engine) ensurePilotActiveInRaceLocked(slotIndex int) (domain.EventPilot, bool) {
	normalizeRaceRosterLocked(&e.raceState, e.pilots)
	for i := range e.raceState.Roster {
		if e.raceState.Roster[i].SlotIndex == slotIndex {
			e.raceState.Roster[i].CheckedIn = true
			e.raceState.Roster[i].Attendance = domain.AttendanceActive
			applyAttendanceToRaceLocked(&e.raceState, slotIndex, true)
			return e.raceState.Roster[i], true
		}
	}
	for _, gp := range e.pilots {
		if gp.SlotIndex == slotIndex {
			ep := domain.EventPilot{
				SlotIndex:    gp.SlotIndex,
				Callsign:     gp.Callsign,
				PhoneticName: gp.PhoneticName,
				Color:        gp.Color,
				CheckedIn:    true,
				Attendance:   domain.AttendanceActive,
			}
			e.raceState.Roster = append(e.raceState.Roster, ep)
			return ep, true
		}
	}
	return domain.EventPilot{}, false
}

// autoSeatLatePilotLocked places a late-arriving pilot into upcoming unstarted round(s) or open/bye bracket slots.
func (e *Engine) autoSeatLatePilotLocked(ep domain.EventPilot) error {
	stageIdx := e.raceState.ActiveStageIndex
	var stageFmt domain.StageFormat
	for _, h := range e.raceState.Heats {
		if h.StageIndex == stageIdx {
			stageFmt = h.StageFormat
			break
		}
	}

	assignInto := func(h *domain.RaceHeat, si int) {
		s := &h.Seats[si]
		s.PilotSlotIndex = ep.SlotIndex
		s.Callsign = ep.Callsign
		s.PhoneticName = ep.PhoneticName
		s.Color = ep.Color
		s.Seed = ep.SlotIndex
		s.Status = domain.PilotHeatStaged
		s.Crossings = nil
		s.Laps = []domain.HeatLap{}
		if s.Feeder != nil {
			s.ManualLock = true
		} else {
			s.SourceLabel = "Late Entry"
		}
		finalizeEditedHeatState(h, e.raceState.Config.QualifyingMetric)
	}

	if stageFmt == domain.FormatQualifying || stageFmt == domain.FormatPointsMains {
		maxRound := 1
		roundsWithHeats := make(map[int]bool)
		for _, h := range e.raceState.Heats {
			if h.StageIndex == stageIdx {
				roundsWithHeats[h.Round] = true
				if h.Round > maxRound {
					maxRound = h.Round
				}
			}
		}
		placedAny := false
		for rnd := 1; rnd <= maxRound; rnd++ {
			if !roundsWithHeats[rnd] {
				continue
			}
			alreadyInRound := false
			anyUnstartedInRound := false
			colForRound := rnd
			for _, h := range e.raceState.Heats {
				if h.StageIndex == stageIdx && h.Round == rnd {
					colForRound = h.Column
					if isUnstartedHeatState(h.State) {
						anyUnstartedInRound = true
					}
					for _, s := range h.Seats {
						if s.PilotSlotIndex == ep.SlotIndex {
							alreadyInRound = true
						}
					}
				}
			}
			if alreadyInRound || !anyUnstartedInRound {
				continue
			}
			placedInRound := false
			for hi := range e.raceState.Heats {
				h := &e.raceState.Heats[hi]
				if h.StageIndex != stageIdx || h.Round != rnd || !isUnstartedHeatState(h.State) {
					continue
				}
				for si := range h.Seats {
					if h.Seats[si].PilotSlotIndex == 0 {
						assignInto(h, si)
						placedInRound = true
						placedAny = true
						break
					}
				}
				if placedInRound {
					break
				}
			}
			if !placedInRound {
				lane := "qualifying"
				if stageFmt == domain.FormatPointsMains {
					lane = "mains"
				}
				newID := e.appendCustomHeatInColumnLocked(lane, rnd, colForRound)
				if nh := e.findHeatLocked(newID); nh != nil && len(nh.Seats) > 0 {
					assignInto(nh, 0)
					placedAny = true
				}
			}
		}
		if !placedAny {
			return fmt.Errorf("%s is already seated in all remaining unstarted rounds", ep.Callsign)
		}
		return nil
	}

	for _, h := range e.raceState.Heats {
		if h.StageIndex == stageIdx {
			for _, s := range h.Seats {
				if s.PilotSlotIndex == ep.SlotIndex && s.Status != domain.PilotHeatDNS {
					return fmt.Errorf("%s is already seated in %s", ep.Callsign, h.ShortLabel)
				}
			}
		}
	}

	for hi := range e.raceState.Heats {
		h := &e.raceState.Heats[hi]
		if h.StageIndex == stageIdx && h.BracketLane == "winners" && h.Round == 1 && isUnstartedHeatState(h.State) {
			for si := range h.Seats {
				if h.Seats[si].PilotSlotIndex == 0 {
					assignInto(h, si)
					return nil
				}
			}
		}
	}
	for hi := range e.raceState.Heats {
		h := &e.raceState.Heats[hi]
		if h.StageIndex == stageIdx && h.BracketLane == "losers" && h.Round == 1 && isUnstartedHeatState(h.State) {
			for si := range h.Seats {
				if h.Seats[si].PilotSlotIndex == 0 && (h.Seats[si].Feeder == nil || h.Seats[si].Feeder.IsBye) {
					assignInto(h, si)
					return nil
				}
			}
			for si := range h.Seats {
				if h.Seats[si].PilotSlotIndex == 0 {
					assignInto(h, si)
					return nil
				}
			}
		}
	}
	for hi := range e.raceState.Heats {
		h := &e.raceState.Heats[hi]
		if h.StageIndex == stageIdx && isUnstartedHeatState(h.State) {
			for si := range h.Seats {
				if h.Seats[si].PilotSlotIndex == 0 {
					assignInto(h, si)
					return nil
				}
			}
		}
	}
	newID := e.appendCustomHeatInColumnLocked("winners", 1, 1)
	if nh := e.findHeatLocked(newID); nh != nil && len(nh.Seats) > 0 {
		assignInto(nh, 0)
		return nil
	}
	return fmt.Errorf("no open bracket seat available")
}

func (e *Engine) appendCustomHeatInColumnLocked(lane string, round int, col int) string {
	return e.appendHeatToRoundOrColumnLocked("", lane, round, col)
}

func (e *Engine) appendHeatToRoundOrColumnLocked(roundID string, lane string, round int, col int) string {
	cfg := e.raceState.Config.Normalized()
	stageIdx := e.raceState.ActiveStageIndex
	if stageIdx < 1 {
		stageIdx = 1
	}
	if round < 1 {
		round = 1
	}
	var stageFmt domain.StageFormat = cfg.MainFormat
	stageName := "Main Stage"
	startMode := domain.StartModeHeadsUp
	targetLaps := cfg.TargetLaps
	timeLimit := cfg.TimeLimitSec
	expWin := cfg.PilotsPerHeat / 2
	if expWin < 1 {
		expWin = 1
	}

	if roundID != "" {
		if r := e.findRoundByIDLocked(roundID); r != nil {
			stageIdx = r.StageIndex
			stageFmt = r.StageFormat
			stageName = r.Title
			targetLaps = r.TargetLaps
			timeLimit = r.TimeLimitSec
			lane = r.BracketLane
			col = r.Column
			round = r.Round
			if r.StartMode != "" {
				startMode = r.StartMode
			} else if stageFmt == domain.FormatQualifying {
				startMode = domain.StartModeStaggered
				expWin = 0
			}
			if stageFmt == domain.FormatQualifying {
				expWin = 0
			}
		}
		for _, h := range e.raceState.Heats {
			if h.RoundID == roundID {
				startMode = h.StartMode
				expWin = h.ExpectedWinners
				break
			}
		}
	} else {
		for _, h := range e.raceState.Heats {
			if h.StageIndex == stageIdx && ((col > 0 && h.Column == col) || (col <= 0 && h.Round == round)) && (lane == "" || h.BracketLane == lane) {
				roundID = h.RoundID
				stageFmt = h.StageFormat
				stageName = h.StageName
				startMode = h.StartMode
				targetLaps = h.TargetLaps
				timeLimit = h.TimeLimitSec
				expWin = h.ExpectedWinners
				if lane == "" {
					lane = h.BracketLane
				}
				if col <= 0 {
					col = h.Column
				}
				round = h.Round
				break
			}
		}
		for _, r := range e.raceState.Rounds {
			if r.StageIndex == stageIdx && col > 0 && r.Column == col && (lane == "" || r.BracketLane == lane) {
				if roundID == "" {
					roundID = r.ID
				}
				stageFmt = r.StageFormat
				stageName = r.Title
				targetLaps = r.TargetLaps
				timeLimit = r.TimeLimitSec
				if lane == "" {
					lane = r.BracketLane
				}
				round = r.Round
				break
			}
		}
	}
	if lane == "" {
		lane = "winners"
	}
	if col <= 0 {
		col = round
	}

	var finalsFmt domain.FinalsFormat
	if rnd := e.findRoundByIDLocked(roundID); rnd != nil {
		finalsFmt = rnd.FinalsFormat
	}

	prefix := fmt.Sprintf("R%d", round)
	if lane == "finals" {
		expWin = 1
		otherFinalsOwnsBase := false
		baseCode := "GF-1"
		if finalsFmt == domain.FinalsChaseTheAce || stageFmt == domain.FormatChaseTheAce {
			baseCode = "CTA-1"
		}
		for _, eh := range e.raceState.Heats {
			if eh.ID == baseCode && eh.RoundID != roundID {
				otherFinalsOwnsBase = true
				break
			}
		}
		if finalsFmt == domain.FinalsChaseTheAce || stageFmt == domain.FormatChaseTheAce {
			if stageIdx >= 3 {
				prefix = fmt.Sprintf("S%d-CTA", stageIdx)
			} else if otherFinalsOwnsBase {
				prefix = fmt.Sprintf("F%d-CTA", round)
			} else {
				prefix = "CTA"
			}
		} else {
			if stageIdx >= 3 {
				prefix = fmt.Sprintf("S%d-GF", stageIdx)
			} else if otherFinalsOwnsBase {
				prefix = fmt.Sprintf("F%d-GF", round)
			} else {
				prefix = "GF"
			}
		}
	} else if e.raceState.TemplateID != "custom" {
		switch lane {
		case "qualifying":
			prefix = fmt.Sprintf("Q%d", round)
			expWin = 0
			startMode = domain.StartModeStaggered
		case "winners":
			prefix = fmt.Sprintf("W%d", round)
		case "losers":
			prefix = fmt.Sprintf("L%d", round)
		case "mains":
			prefix = fmt.Sprintf("M%d", round)
			expWin = 1
		}
		if stageIdx >= 3 {
			prefix = fmt.Sprintf("S%d-%s", stageIdx, prefix)
		}
	} else if stageFmt == domain.FormatQualifying {
		expWin = 0
		startMode = domain.StartModeStaggered
		if stageIdx >= 3 {
			prefix = fmt.Sprintf("S%d-%s", stageIdx, prefix)
		}
	} else if stageIdx >= 3 {
		prefix = fmt.Sprintf("S%d-%s", stageIdx, prefix)
	}

	seq := 1
	var hid string
	for {
		hid = fmt.Sprintf("%s-%d", prefix, seq)
		if e.findHeatLocked(hid) == nil {
			break
		}
		seq++
	}

	stgSettings := e.stageSettingsLocked(stageIdx)
	seats := make([]domain.HeatSeat, len(stgSettings.SeatChannels))
	for i, seatCode := range stgSettings.SeatChannels {
		band, ch, freq, ok := domain.DecodeBandChannel(seatCode)
		if !ok {
			band = domain.BandRaceband
			ch = uint8((i % domain.MaxPilotSlots) + 1)
			freq = domain.RacebandFrequenciesMHz[ch-1]
		}
		seats[i] = domain.HeatSeat{
			SeatIndex:    i + 1,
			SourceLabel:  "Open / BYE",
			Band:         band,
			Channel:      ch,
			FrequencyMHz: freq,
			Status:       domain.PilotHeatStaged,
			Laps:         []domain.HeatLap{},
		}
	}

	nh := domain.RaceHeat{
		ID:              hid,
		RoundID:         roundID,
		StageIndex:      stageIdx,
		StageName:       stageName,
		StageFormat:     stageFmt,
		Round:           round,
		Column:          col,
		Order:           len(e.raceState.Heats) + 1,
		BracketLane:     lane,
		Title:           fmt.Sprintf("%s · Heat %d", stageName, seq),
		ShortLabel:      race.FormatHeatShortLabel(hid),
		StartMode:       startMode,
		TargetLaps:      targetLaps,
		TimeLimitSec:    timeLimit,
		ExpectedWinners: expWin,
		State:           domain.HeatReady,
		Seats:           seats,
	}
	insertAt := len(e.raceState.Heats)
	if roundID != "" {
		lastInRound := -1
		for i := range e.raceState.Heats {
			if e.raceState.Heats[i].RoundID == roundID {
				lastInRound = i
			}
		}
		if lastInRound >= 0 {
			insertAt = lastInRound + 1
		} else {
			lastInStageCol := -1
			for i := range e.raceState.Heats {
				if e.raceState.Heats[i].StageIndex == stageIdx && e.raceState.Heats[i].Column <= col {
					lastInStageCol = i
				}
			}
			if lastInStageCol >= 0 {
				insertAt = lastInStageCol + 1
			} else {
				lastInStage := -1
				for i := range e.raceState.Heats {
					if e.raceState.Heats[i].StageIndex <= stageIdx {
						lastInStage = i
					}
				}
				if lastInStage >= 0 {
					insertAt = lastInStage + 1
				}
			}
		}
	}
	e.raceState.Heats = append(e.raceState.Heats, domain.RaceHeat{})
	copy(e.raceState.Heats[insertAt+1:], e.raceState.Heats[insertAt:])
	e.raceState.Heats[insertAt] = nh
	for i := range e.raceState.Heats {
		e.raceState.Heats[i].Order = i + 1
	}
	race.SyncRoundsMetadata(&e.raceState)
	return hid
}

func (e *Engine) deleteUnstartedHeatLocked(heatID string) error {
	idx := -1
	for i := range e.raceState.Heats {
		if e.raceState.Heats[i].ID == heatID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return fmt.Errorf("heat %q not found", heatID)
	}
	if !isUnstartedHeatState(e.raceState.Heats[idx].State) {
		return fmt.Errorf("cannot delete a heat that has already started or finished")
	}
	if len(e.raceState.Heats) <= 1 && e.raceState.TemplateID != "custom" {
		return fmt.Errorf("at least one heat must remain (or switch to Custom to delete all heats)")
	}
	wasActive := e.raceState.ActiveHeatID == heatID
	delRoundID := e.raceState.Heats[idx].RoundID
	delStageIdx := e.raceState.Heats[idx].StageIndex
	e.raceState.Heats = append(e.raceState.Heats[:idx], e.raceState.Heats[idx+1:]...)

	if delRoundID != "" {
		if r := e.findRoundByIDLocked(delRoundID); r != nil && r.BracketLane != "finals" && r.StageFormat != domain.FormatOpenQualifier {
			remCnt := 0
			for _, h := range e.raceState.Heats {
				if h.RoundID == delRoundID {
					remCnt++
				}
			}
			if remCnt >= 1 {
				r.TargetHeats = remCnt
			}
		}
	}

	for hi := range e.raceState.Heats {
		e.raceState.Heats[hi].Order = hi + 1
		for si := range e.raceState.Heats[hi].Seats {
			s := &e.raceState.Heats[hi].Seats[si]
			if s.Feeder != nil && s.Feeder.FromHeatID == heatID {
				s.Feeder = nil
				s.ManualLock = false
				if s.PilotSlotIndex == 0 {
					s.SourceLabel = "Open / BYE"
				}
			}
		}
	}
	if wasActive {
		e.raceState.ActiveHeatID = ""
	}
	if delRoundID != "" {
		e.markStageCustomizedLocked(delStageIdx)
		e.cascadeBalancedRoundsFromLocked(delStageIdx, delRoundID)
	}
	race.RebuildEdgesFromFeeders(&e.raceState)
	race.SyncRoundsMetadata(&e.raceState)
	return nil
}

func cloneEventManagerState(st domain.EventManagerState) domain.EventManagerState {
	out := domain.EventManagerState{
		Initialized:  st.Initialized,
		ActiveRaceID: st.ActiveRaceID,
		Races:        make([]domain.RaceTournamentState, len(st.Races)),
	}
	for i, r := range st.Races {
		out.Races[i] = cloneRaceState(r)
	}
	return out
}
