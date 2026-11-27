package tracker

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/race"
)

// StagePositionUpdate records a canvas (PosX, PosY) position for a single Stage node in Format mode.
type StagePositionUpdate struct {
	StageID string  `json:"stageId"`
	PosX    float64 `json:"posX"`
	PosY    float64 `json:"posY"`
}

func (e *Engine) findStageLocked(stageID string, stageIdx int) *domain.RaceStage {
	race.EnsureStagesMetadata(&e.raceState)
	id := strings.TrimSpace(stageID)
	if id != "" {
		for i := range e.raceState.Stages {
			if e.raceState.Stages[i].ID == id {
				return &e.raceState.Stages[i]
			}
		}
	}
	if stageIdx >= 1 {
		for i := range e.raceState.Stages {
			if e.raceState.Stages[i].Index == stageIdx {
				return &e.raceState.Stages[i]
			}
		}
	}
	return nil
}

func (e *Engine) stageSettingsLocked(stageIdx int) domain.StageSettings {
	cfg := e.raceState.Config.Normalized()
	if stg := e.findStageByIndexLocked(stageIdx); stg != nil {
		return stg.Settings.Normalized(cfg, stg.Format)
	}
	return domain.DefaultStageSettingsFromConfig(cfg, cfg.MainFormat)
}

func (e *Engine) markStageCustomizedLocked(stageIdx int) {
	if stg := e.findStageByIndexLocked(stageIdx); stg != nil {
		stg.Customized = true
	}
}

func (e *Engine) hasAnyCustomizedStageLocked() bool {
	if e.raceState.TemplateID == "custom" {
		return true
	}
	for _, s := range e.raceState.Stages {
		if s.Customized {
			return true
		}
	}
	return false
}

func (e *Engine) effectiveStageSeedCountLocked(stageIdx int) int {
	pilots := e.activeEventPilotsForGenerationLocked()
	n := len(pilots)
	if n < 2 {
		n = len(e.raceState.Roster)
	}
	if n < 2 {
		n = 4
	}
	if len(e.raceState.Stages) > 0 {
		return race.StageExpectedIncomingSeeds(&e.raceState, stageIdx, n)
	}
	if e.raceState.Config.Stage2MaxSeeds > 0 && e.raceState.Config.Stage2MaxSeeds < n {
		n = e.raceState.Config.Stage2MaxSeeds
	}
	if n < 2 {
		n = 2
	}
	return n
}

func (e *Engine) anyDownstreamStageStartedLocked(stageIdx int) bool {
	race.EnsureStagesMetadata(&e.raceState)
	adj := make(map[int][]int)
	for _, sc := range e.raceState.StageConnections {
		if !sc.Invalid && sc.FromStageIndex > 0 && sc.ToStageIndex > 0 {
			adj[sc.FromStageIndex] = append(adj[sc.FromStageIndex], sc.ToStageIndex)
		}
	}
	visited := make(map[int]bool)
	queue := append([]int(nil), adj[stageIdx]...)
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if visited[cur] {
			continue
		}
		visited[cur] = true
		if race.AnyRealHeatStartedInStage(&e.raceState, cur) {
			return true
		}
		queue = append(queue, adj[cur]...)
	}
	return false
}

func normalizeStagePort(port string, fallback string) string {
	switch strings.TrimSpace(port) {
	case "left", "top", "right", "bottom":
		return strings.TrimSpace(port)
	default:
		return fallback
	}
}

// handleStageControlLocked executes stage-level Control actions ("activate_stage", "pause_stage",
// "resume_stage", "complete_stage_early", "reopen_stage_early").
func (e *Engine) handleStageControlLocked(req EventActionPayload) (cfgChanged bool, err error) {
	if !e.raceState.Generated {
		return false, fmt.Errorf("no tournament generated yet")
	}
	race.EnsureStagesMetadata(&e.raceState)
	targetIdx := req.StageIndex
	if targetIdx < 1 && strings.TrimSpace(req.StageID) == "" {
		targetIdx = e.raceState.ActiveStageIndex
	}
	stg := e.findStageLocked(req.StageID, targetIdx)
	if stg == nil {
		return false, fmt.Errorf("stage not found")
	}

	switch strings.TrimSpace(req.StageAction) {
	case "pause_stage":
		if ah := e.findHeatLocked(e.raceState.ActiveHeatID); ah != nil && ah.StageIndex == stg.Index {
			e.pauseLiveHeatIfRunningLocked()
			if e.raceState.Mode == domain.ModeRace {
				e.disarmAllPilotSlotsForRaceLocked()
				cfgChanged = true
			} else if e.practiceSnap.Saved && e.exitLiveRaceHeatLocked() {
				cfgChanged = true
			}
		}
		stg.PausedByUser = true
		e.resolveActiveTournamentLocked()
		return cfgChanged, nil

	case "activate_stage", "resume_stage":
		e.resolveActiveTournamentLocked()
		stg = e.findStageByIndexLocked(stg.Index)
		if stg == nil {
			return false, fmt.Errorf("stage not found")
		}
		if stg.Dangling {
			if stg.DanglingReason != "" {
				return false, fmt.Errorf("%s", stg.DanglingReason)
			}
			return false, fmt.Errorf("%s is disconnected — connect it in Format first", stg.Title)
		}
		if !stg.PrerequisitesMet {
			if len(stg.WaitingOnStageNames) > 0 {
				return false, fmt.Errorf("cannot activate %s yet — complete %s first", stg.Title, strings.Join(stg.WaitingOnStageNames, ", "))
			}
			return false, fmt.Errorf("cannot activate %s yet — upstream stages must finish first", stg.Title)
		}
		if ah := e.findHeatLocked(e.raceState.ActiveHeatID); ah != nil && ah.StageIndex != stg.Index {
			if ah.State == domain.HeatCountdown || ah.State == domain.HeatRunning {
				return false, fmt.Errorf("pause or finish %s before switching to %s", ah.ShortLabel, stg.Title)
			}
		}
		if e.raceState.ActiveStageIndex != stg.Index {
			if prev := e.findStageByIndexLocked(e.raceState.ActiveStageIndex); prev != nil {
				if prev.Status != domain.StageStatusCompleted && race.AnyRealHeatStartedInStage(&e.raceState, prev.Index) {
					prev.PausedByUser = true
				}
			}
		}
		stg.PausedByUser = false
		e.raceState.ActiveStageIndex = stg.Index
		e.resolveActiveTournamentLocked()

		// Select/stage the first paused, staged, or ready heat in this newly activated stage
		targetHeatID := ""
		if curH := e.findHeatLocked(e.raceState.ActiveHeatID); curH != nil && curH.StageIndex == stg.Index &&
			(curH.State == domain.HeatPaused || curH.State == domain.HeatStaged || curH.State == domain.HeatReady || curH.State == domain.HeatFinished) {
			targetHeatID = curH.ID
		}
		if targetHeatID == "" {
			for _, h := range e.raceState.Heats {
				if h.StageIndex == stg.Index && h.State == domain.HeatPaused {
					targetHeatID = h.ID
					break
				}
			}
		}
		if targetHeatID == "" && e.raceState.NextReadyHeatID != "" {
			if nh := e.findHeatLocked(e.raceState.NextReadyHeatID); nh != nil && nh.StageIndex == stg.Index {
				targetHeatID = nh.ID
			}
		}
		if targetHeatID != "" {
			if th := e.findHeatLocked(targetHeatID); th != nil && (th.State == domain.HeatReady || th.State == domain.HeatStaged) {
				e.stageHeatLocked(targetHeatID, false)
				cfgChanged = true
			} else {
				e.raceState.ActiveHeatID = targetHeatID
			}
		} else if e.raceState.Mode == domain.ModeRace {
			e.stageOrDisarmActiveRaceLocked()
			cfgChanged = true
		}
		return cfgChanged, nil

	case "complete_stage_early":
		hasConfirmed := false
		for _, h := range e.raceState.Heats {
			if h.StageIndex == stg.Index {
				if h.State == domain.HeatCountdown || h.State == domain.HeatRunning {
					return false, fmt.Errorf("finish or stop %s before closing %s", h.ShortLabel, stg.Title)
				}
				if h.State == domain.HeatConfirmed {
					hasConfirmed = true
				}
			}
		}
		if !hasConfirmed {
			return false, fmt.Errorf("confirm at least one heat in %s before closing the stage", stg.Title)
		}
		// If closing an Open Qualifier stage, discard any unstarted queued packs in this stage so
		// unflown ad-hoc queue slots do not linger after standings lock.
		if stg.Format == domain.FormatOpenQualifier {
			kept := e.raceState.Heats[:0]
			for _, h := range e.raceState.Heats {
				if h.StageIndex == stg.Index && isUnstartedHeatState(h.State) {
					if e.raceState.ActiveHeatID == h.ID {
						e.raceState.ActiveHeatID = ""
					}
					continue
				}
				kept = append(kept, h)
			}
			e.raceState.Heats = kept
			for i := range e.raceState.Heats {
				e.raceState.Heats[i].Order = i + 1
			}
		}
		stg.CompletedEarly = true
		stg.PausedByUser = false
		if stg.Index == 1 {
			e.raceState.Stage2SeededEarly = true
		}
		prevStageIdx := stg.Index
		e.resolveActiveTournamentLocked()
		if e.raceState.IsComplete {
			e.ensureRaceTrackInitializedLocked(&e.raceState)
			e.raceState.Lifecycle = domain.LifecycleCompleted
		} else if e.raceState.ActiveStageIndex != prevStageIdx && e.raceState.NextReadyHeatID != "" {
			e.raceState.ActiveHeatID = e.raceState.NextReadyHeatID
		}
		if e.raceState.Mode == domain.ModeRace {
			e.stageOrDisarmActiveRaceLocked()
			cfgChanged = true
		} else if e.raceState.IsComplete && e.practiceSnap.Saved && e.exitLiveRaceHeatLocked() {
			cfgChanged = true
		}
		return cfgChanged, nil

	case "reopen_stage_early":
		if e.anyDownstreamStageStartedLocked(stg.Index) {
			return false, fmt.Errorf("cannot unlock %s seeding after a downstream stage heat has started", stg.Title)
		}
		stg.CompletedEarly = false
		if stg.Index == 1 {
			e.raceState.Stage2SeededEarly = false
		}
		e.resolveActiveTournamentLocked()
		return false, nil

	default:
		return false, fmt.Errorf("unknown stage_control action %q", req.StageAction)
	}
}

// rebuildSingleStageLocked regenerates heats & rounds for an unstarted non-customized stage `stageIdx`
// while leaving all other stages untouched.
func (e *Engine) rebuildSingleStageLocked(stageIdx int) {
	race.EnsureStagesMetadata(&e.raceState)
	stg := e.findStageByIndexLocked(stageIdx)
	if stg == nil || race.AnyRealHeatStartedInStage(&e.raceState, stageIdx) {
		return
	}

	// Preserve existing round positions by (BracketLane, Round) inside this stage
	type savedPos struct {
		x, y float64
	}
	posByLaneRound := make(map[string]savedPos)
	var preservedPortals []domain.RaceRound
	keptRounds := make([]domain.RaceRound, 0, len(e.raceState.Rounds))
	for _, r := range e.raceState.Rounds {
		if r.StageIndex != stageIdx {
			keptRounds = append(keptRounds, r)
			continue
		}
		if domain.IsStagePortalRoundID(r.ID) {
			preservedPortals = append(preservedPortals, r)
			continue
		}
		if r.HasPos {
			posByLaneRound[fmt.Sprintf("%s:%d", r.BracketLane, r.Round)] = savedPos{r.PosX, r.PosY}
		}
	}

	keptHeats := make([]domain.RaceHeat, 0, len(e.raceState.Heats))
	existingHeatIDs := make(map[string]bool, len(e.raceState.Heats))
	for _, h := range e.raceState.Heats {
		if h.StageIndex != stageIdx {
			keptHeats = append(keptHeats, h)
			existingHeatIDs[h.ID] = true
		} else if h.ID == e.raceState.ActiveHeatID {
			e.raceState.ActiveHeatID = ""
		}
	}

	keptConns := make([]domain.RoundConnection, 0, len(e.raceState.Connections))
	for _, c := range e.raceState.Connections {
		if c.StageIndex != stageIdx {
			keptConns = append(keptConns, c)
		}
	}

	pilots := e.activeEventPilotsForGenerationLocked()
	rosterCount := len(pilots)
	if rosterCount < 2 {
		rosterCount = len(e.raceState.Roster)
	}
	if rosterCount < 2 {
		rosterCount = 4
	}
	inConns := race.IncomingStageConnections(&e.raceState, stageIdx)
	expectedSeeds := race.StageExpectedIncomingSeeds(&e.raceState, stageIdx, rosterCount)

	newHeats, _ := race.GenerateStageHeats(
		*stg,
		e.raceState.Config,
		pilots,
		len(inConns) > 0,
		expectedSeeds,
		len(keptHeats),
		existingHeatIDs,
		time.Now().UnixNano(),
	)

	// Insert `newHeats` sorted by stage index order and re-sequence `Order`
	combinedHeats := append(keptHeats, newHeats...)
	sort.SliceStable(combinedHeats, func(i, j int) bool {
		return combinedHeats[i].StageIndex < combinedHeats[j].StageIndex
	})
	for i := range combinedHeats {
		combinedHeats[i].Order = i + 1
	}

	e.raceState.Heats = combinedHeats
	e.raceState.Rounds = append(keptRounds, preservedPortals...)
	e.raceState.Connections = keptConns

	race.RebuildEdgesFromFeeders(&e.raceState)
	race.SyncRoundsMetadata(&e.raceState)

	if len(posByLaneRound) > 0 {
		for i := range e.raceState.Rounds {
			r := &e.raceState.Rounds[i]
			if r.StageIndex == stageIdx && !domain.IsStagePortalRoundID(r.ID) {
				if sp, ok := posByLaneRound[fmt.Sprintf("%s:%d", r.BracketLane, r.Round)]; ok {
					r.HasPos = true
					r.PosX = sp.x
					r.PosY = sp.y
				}
			}
		}
	}
}

// onStageIncomingChangedLocked updates an unstarted stage `stageIdx` (and any unstarted transitive
// downstream stages) whenever its incoming StageConnections or seed slice change.
func (e *Engine) onStageIncomingChangedLocked(stageIdx int) {
	race.EnsureStagesMetadata(&e.raceState)
	topo := race.TopologicalStageIndices(&e.raceState)
	affected := make(map[int]bool)
	affected[stageIdx] = true
	for _, sc := range e.raceState.StageConnections {
		if !sc.Invalid && affected[sc.FromStageIndex] {
			affected[sc.ToStageIndex] = true
		}
	}
	for _, idx := range topo {
		if !affected[idx] || race.AnyRealHeatStartedInStage(&e.raceState, idx) {
			continue
		}
		stg := e.findStageByIndexLocked(idx)
		if stg == nil {
			continue
		}
		if !stg.Customized && stg.Format != domain.FormatCustom {
			e.rebuildSingleStageLocked(idx)
		} else {
			race.SyncRoundsMetadata(&e.raceState)
			inConns := race.IncomingStageConnections(&e.raceState, idx)
			// If a custom stage just gained an upstream connection, convert any unstarted root `all_active_pilots` round to `stage_seeds`!
			if len(inConns) > 0 {
				inPortalID := domain.StageHandoffInID(idx)
				for i := range e.raceState.Rounds {
					r := &e.raceState.Rounds[i]
					if r.StageIndex == idx && !domain.IsStagePortalRoundID(r.ID) && r.SeedSource == "all_active_pilots" && e.ensureRoundUnstartedLocked(r.ID) == nil {
						r.SeedSource = ""
						_ = e.connectRoundsLocked(inPortalID, r.ID, "stage_seeds", 0, 1, 0, defaultStageSeedDistribution(r))
					}
				}
				e.recomputeGraphAndRebuildLocked(idx, inPortalID)
			} else {
				e.recomputeGraphAndRebuildLocked(idx, "")
			}
		}
	}
	race.SyncRoundsMetadata(&e.raceState)
}

func (e *Engine) rebuildAllUnstartedNonCustomStagesLocked() {
	race.EnsureStagesMetadata(&e.raceState)
	for _, idx := range race.TopologicalStageIndices(&e.raceState) {
		if race.AnyRealHeatStartedInStage(&e.raceState, idx) {
			continue
		}
		stg := e.findStageByIndexLocked(idx)
		if stg == nil {
			continue
		}
		if !stg.Customized && stg.Format != domain.FormatCustom {
			e.rebuildSingleStageLocked(idx)
		} else {
			e.recomputeGraphAndRebuildLocked(idx, "")
		}
	}
}

func (e *Engine) addStageLocked(req BracketEditPayload) error {
	if e.raceState.Generated {
		race.EnsureStagesMetadata(&e.raceState)
	}
	if len(req.StagePositions) > 0 {
		for _, sp := range req.StagePositions {
			if stg := e.findStageLocked(sp.StageID, 0); stg != nil {
				stg.HasPos = true
				stg.PosX = sp.PosX
				stg.PosY = sp.PosY
			}
		}
	}
	if len(e.raceState.Stages) >= domain.MaxRaceStages {
		return fmt.Errorf("maximum of %d stages reached per race", domain.MaxRaceStages)
	}

	fmtType := req.StageFormat
	switch fmtType {
	case domain.FormatQualifying,
		domain.FormatOpenQualifier,
		domain.FormatSingleElimination,
		domain.FormatDoubleElimination,
		domain.FormatPointsMains,
		domain.FormatChaseTheAce,
		domain.FormatCustom:
	default:
		fmtType = domain.FormatDoubleElimination
	}

	newIdx := len(e.raceState.Stages) + 1
	cfg := e.raceState.Config.Normalized()
	settings := domain.DefaultStageSettingsFromConfig(cfg, fmtType)
	if req.PilotsPerHeat >= 2 && req.PilotsPerHeat <= domain.MaxPilotSlots {
		settings.PilotsPerHeat = req.PilotsPerHeat
		settings.SeatChannels = domain.DefaultSeatChannels(req.PilotsPerHeat)
	}
	if len(req.SeatChannels) >= 2 {
		settings.SeatChannels = append([]uint8(nil), req.SeatChannels...)
	}
	if req.TargetLaps >= 1 {
		settings.TargetLaps = req.TargetLaps
	}
	if req.TimeLimitSec >= 15 {
		settings.TimeLimitSec = req.TimeLimitSec
	}
	if req.QualifyingRounds >= 1 {
		settings.QualifyingRounds = req.QualifyingRounds
	}
	if req.QualifyingMetric != "" {
		settings.QualifyingMetric = req.QualifyingMetric
	}
	if req.MaxPacksPerPilot != nil {
		settings.MaxPacksPerPilot = *req.MaxPacksPerPilot
	}
	if req.PointsRounds >= 1 {
		settings.PointsRounds = req.PointsRounds
	}
	if req.FinalsFormat == domain.FinalsSingle || req.FinalsFormat == domain.FinalsChaseTheAce || req.FinalsFormat == domain.FinalsPoints {
		settings.FinalsFormat = req.FinalsFormat
	}
	if req.AceWinsRequired >= 2 && req.AceWinsRequired <= 5 {
		settings.AceWinsRequired = req.AceWinsRequired
	}
	if req.WinnersAdvantageAce != nil {
		settings.WinnersAdvantageAce = *req.WinnersAdvantageAce
	}
	settings = settings.Normalized(cfg, fmtType)

	title := strings.TrimSpace(req.Title)
	if title == "" {
		base := race.DefaultStageTitle(fmtType, newIdx)
		title = base
		if fmtType != domain.FormatCustom {
			sameCount := 0
			for _, s := range e.raceState.Stages {
				if s.Format == fmtType || s.Title == base {
					sameCount++
				}
			}
			if sameCount > 0 {
				title = fmt.Sprintf("%s %d", base, sameCount+1)
			}
		}
	} else {
		base := title
		sameCount := 0
		for _, s := range e.raceState.Stages {
			if strings.EqualFold(s.Title, base) || strings.HasPrefix(strings.ToLower(s.Title), strings.ToLower(base)+" ") {
				sameCount++
			}
		}
		if sameCount > 0 {
			title = fmt.Sprintf("%s %d", base, sameCount+1)
		}
	}

	posX := float64(120 + (newIdx-1)*420)
	posY := 180.0
	if len(e.raceState.Stages) > 0 {
		maxX := e.raceState.Stages[0].PosX
		sumY := 0.0
		for _, s := range e.raceState.Stages {
			if s.PosX > maxX {
				maxX = s.PosX
			}
			sumY += s.PosY
		}
		posX = maxX + 420
		posY = sumY / float64(len(e.raceState.Stages))
	}
	if req.HasPos {
		posX = req.PosX
		posY = req.PosY
	}

	stageID := e.nextUniqueIDLocked("stage")
	if newIdx == 1 {
		stageID = "stage-1"
	}

	newStage := domain.RaceStage{
		ID:         stageID,
		Index:      newIdx,
		Title:      title,
		Format:     fmtType,
		Customized: fmtType == domain.FormatCustom,
		Status:     domain.StageStatusPending,
		Settings:   settings,
		HasPos:     true,
		PosX:       posX,
		PosY:       posY,
	}

	e.raceState.Stages = append(e.raceState.Stages, newStage)
	e.raceState.Generated = true
	e.raceState.IsComplete = false
	if newIdx == 1 {
		e.raceState.ActiveStageIndex = 1
		e.raceState.Config.MainFormat = fmtType
		if fmtType == domain.FormatCustom {
			e.raceState.TemplateID = "custom"
		}
	}
	if len(e.raceState.Stages) >= 2 {
		e.raceState.Config.Structure = domain.StructureTwoStage
	} else {
		e.raceState.Config.Structure = domain.StructureSingleStage
	}

	// Optional immediate stage connection if `FromStageID` or `FromStageIndex` was passed
	if strings.TrimSpace(req.FromStageID) != "" || req.FromStageIndex >= 1 {
		if fromStg := e.findStageLocked(req.FromStageID, req.FromStageIndex); fromStg != nil && fromStg.ID != stageID {
			_ = e.connectStagesLocked(fromStg.ID, stageID, req.LinkMode, req.AdvanceCount, req.SeedStart, req.SeedEnd, req.QualifyingMetric, req.FromPort, req.ToPort)
			return nil
		}
	}

	race.EnsureStagesMetadata(&e.raceState)
	e.rebuildSingleStageLocked(newIdx)
	race.SyncRoundsMetadata(&e.raceState)
	return nil
}

func (e *Engine) removeStageLocked(stageID string, stageIdx int) error {
	stg := e.findStageLocked(stageID, stageIdx)
	if stg == nil {
		return fmt.Errorf("stage not found")
	}
	rmIdx := stg.Index
	rmID := stg.ID
	if race.AnyCompletedOrRunningHeatInStage(&e.raceState, rmIdx) {
		return fmt.Errorf("cannot delete %s because heats in this stage are completed or running", stg.Title)
	}

	affectedDownstreamIDs := make(map[string]bool)
	for _, sc := range e.raceState.StageConnections {
		if sc.FromStageID == rmID {
			affectedDownstreamIDs[sc.ToStageID] = true
		}
	}

	// Build oldIndex -> newIndex map and portal ID remap map
	idxRemap := make(map[int]int)
	portalRemap := make(map[string]string)
	keptStages := make([]domain.RaceStage, 0, len(e.raceState.Stages)-1)
	for _, s := range e.raceState.Stages {
		if s.ID == rmID {
			continue
		}
		newIndex := len(keptStages) + 1
		idxRemap[s.Index] = newIndex
		if s.Index != newIndex {
			portalRemap[domain.StageHandoffOutID(s.Index)] = domain.StageHandoffOutID(newIndex)
			portalRemap[domain.StageHandoffInID(s.Index)] = domain.StageHandoffInID(newIndex)
			portalRemap[domain.StagePilotsInID(s.Index)] = domain.StagePilotsInID(newIndex)
			portalRemap[domain.OpenQualRoundID(s.Index)] = domain.OpenQualRoundID(newIndex)
		}
		s.Index = newIndex
		keptStages = append(keptStages, s)
	}

	if len(keptStages) == 0 {
		e.raceState.Stages = []domain.RaceStage{}
		e.raceState.StageConnections = []domain.StageConnection{}
		e.raceState.Heats = []domain.RaceHeat{}
		e.raceState.Rounds = []domain.RaceRound{}
		e.raceState.Connections = []domain.RoundConnection{}
		e.raceState.Edges = []domain.BracketEdge{}
		e.raceState.Standings = []domain.TournamentStanding{}
		e.raceState.TemplateID = ""
		e.raceState.Generated = false
		e.raceState.TotalStages = 1
		e.raceState.ActiveStageIndex = 1
		e.raceState.ActiveHeatID = ""
		e.raceState.NextReadyHeatID = ""
		e.raceState.FormatInvalidReason = ""
		if e.raceState.Lifecycle != domain.LifecycleCompleted && e.raceState.Lifecycle != domain.LifecycleScrapped {
			e.raceState.Lifecycle = domain.LifecycleDraft
			e.raceState.StatusReason = ""
		}
		return nil
	}

	e.raceState.Stages = keptStages

	keptStageConns := make([]domain.StageConnection, 0, len(e.raceState.StageConnections))
	for _, sc := range e.raceState.StageConnections {
		if sc.FromStageID == rmID || sc.ToStageID == rmID {
			continue
		}
		sc.FromStageIndex = idxRemap[sc.FromStageIndex]
		sc.ToStageIndex = idxRemap[sc.ToStageIndex]
		keptStageConns = append(keptStageConns, sc)
	}
	e.raceState.StageConnections = keptStageConns

	keptHeats := make([]domain.RaceHeat, 0, len(e.raceState.Heats))
	for _, h := range e.raceState.Heats {
		if h.StageIndex == rmIdx {
			if h.ID == e.raceState.ActiveHeatID {
				e.raceState.ActiveHeatID = ""
			}
			continue
		}
		h.StageIndex = idxRemap[h.StageIndex]
		if mappedRID, ok := portalRemap[h.RoundID]; ok {
			h.RoundID = mappedRID
		}
		keptHeats = append(keptHeats, h)
	}
	for i := range keptHeats {
		keptHeats[i].Order = i + 1
	}
	e.raceState.Heats = keptHeats

	keptRounds := make([]domain.RaceRound, 0, len(e.raceState.Rounds))
	for _, r := range e.raceState.Rounds {
		if r.StageIndex == rmIdx {
			continue
		}
		r.StageIndex = idxRemap[r.StageIndex]
		if mappedID, ok := portalRemap[r.ID]; ok {
			r.ID = mappedID
		}
		keptRounds = append(keptRounds, r)
	}
	e.raceState.Rounds = keptRounds

	keptConns := make([]domain.RoundConnection, 0, len(e.raceState.Connections))
	for _, c := range e.raceState.Connections {
		if c.StageIndex == rmIdx {
			continue
		}
		c.StageIndex = idxRemap[c.StageIndex]
		if mappedFrom, ok := portalRemap[c.FromRoundID]; ok {
			c.FromRoundID = mappedFrom
		}
		if mappedTo, ok := portalRemap[c.ToRoundID]; ok {
			c.ToRoundID = mappedTo
		}
		keptConns = append(keptConns, c)
	}
	e.raceState.Connections = keptConns

	if e.raceState.ActiveStageIndex == rmIdx {
		e.raceState.ActiveStageIndex = 1
	} else if mappedActive, ok := idxRemap[e.raceState.ActiveStageIndex]; ok {
		e.raceState.ActiveStageIndex = mappedActive
	}
	if len(e.raceState.Stages) == 1 {
		e.raceState.Config.Structure = domain.StructureSingleStage
		e.raceState.Config.Stage2MaxSeeds = 0
		e.raceState.Stage2SeededEarly = false
	}

	race.EnsureStagesMetadata(&e.raceState)
	race.RebuildEdgesFromFeeders(&e.raceState)
	race.SyncRoundsMetadata(&e.raceState)

	for _, s := range e.raceState.Stages {
		if affectedDownstreamIDs[s.ID] {
			e.onStageIncomingChangedLocked(s.Index)
		}
	}
	return nil
}

func (e *Engine) renameStageLocked(stageID string, stageIdx int, newTitle string) error {
	stg := e.findStageLocked(stageID, stageIdx)
	if stg == nil {
		return fmt.Errorf("stage not found")
	}
	trimmed := strings.TrimSpace(newTitle)
	if trimmed == "" {
		return fmt.Errorf("stage title cannot be empty")
	}
	stg.Title = trimmed
	race.SyncRoundsMetadata(&e.raceState)
	return nil
}

func (e *Engine) updateStageSettingsLocked(req BracketEditPayload) error {
	if len(req.Positions) > 0 {
		race.SyncRoundsMetadata(&e.raceState)
		e.applyRoundPositionsLocked(req.Positions)
	}
	stg := e.findStageLocked(req.StageID, req.StageIndex)
	if stg == nil {
		return fmt.Errorf("stage not found")
	}
	cfg := e.raceState.Config.Normalized()
	prev := stg.Settings.Normalized(cfg, stg.Format)
	next := prev

	if strings.TrimSpace(req.Title) != "" {
		stg.Title = strings.TrimSpace(req.Title)
	}
	if req.PilotsPerHeat >= 2 && req.PilotsPerHeat <= domain.MaxPilotSlots {
		next.PilotsPerHeat = req.PilotsPerHeat
		if len(req.SeatChannels) == 0 && req.PilotsPerHeat != prev.PilotsPerHeat {
			next.SeatChannels = domain.DefaultSeatChannels(req.PilotsPerHeat)
		}
	}
	if len(req.SeatChannels) >= 2 {
		next.SeatChannels = append([]uint8(nil), req.SeatChannels...)
	}
	if req.TargetLaps >= 0 {
		next.TargetLaps = req.TargetLaps
	}
	if req.TimeLimitSec >= 15 {
		next.TimeLimitSec = req.TimeLimitSec
	}
	if req.QualifyingRounds >= 1 {
		next.QualifyingRounds = req.QualifyingRounds
	}
	if req.QualifyingMetric != "" {
		next.QualifyingMetric = req.QualifyingMetric
	}
	if req.MaxPacksPerPilot != nil {
		next.MaxPacksPerPilot = *req.MaxPacksPerPilot
	}
	if req.PointsRounds >= 1 {
		next.PointsRounds = req.PointsRounds
	}
	if req.FinalsFormat == domain.FinalsSingle || req.FinalsFormat == domain.FinalsChaseTheAce || req.FinalsFormat == domain.FinalsPoints {
		next.FinalsFormat = req.FinalsFormat
	}
	if req.AceWinsRequired >= 2 && req.AceWinsRequired <= 5 {
		next.AceWinsRequired = req.AceWinsRequired
	}
	if req.WinnersAdvantageAce != nil {
		next.WinnersAdvantageAce = *req.WinnersAdvantageAce
	}
	next = next.Normalized(cfg, stg.Format)
	stg.Settings = next

	// Keep legacy top-level Config fields aligned when editing Stage 1 of a 1-stage race
	if len(e.raceState.Stages) == 1 && stg.Index == 1 {
		e.raceState.Config.PilotsPerHeat = next.PilotsPerHeat
		e.raceState.Config.SeatChannels = append([]uint8(nil), next.SeatChannels...)
		e.raceState.Config.TargetLaps = next.TargetLaps
		e.raceState.Config.TimeLimitSec = next.TimeLimitSec
		e.raceState.Config.QualifyingRounds = next.QualifyingRounds
		e.raceState.Config.QualifyingMetric = next.QualifyingMetric
		e.raceState.Config.MaxPacksPerPilot = next.MaxPacksPerPilot
		e.raceState.Config.PointsRounds = next.PointsRounds
		e.raceState.Config.FinalsFormat = next.FinalsFormat
		e.raceState.Config.AceWinsRequired = next.AceWinsRequired
		e.raceState.Config.WinnersAdvantageAce = next.WinnersAdvantageAce
	}

	if next.QualifyingMetric != prev.QualifyingMetric {
		for i := range e.raceState.Heats {
			if e.raceState.Heats[i].StageIndex == stg.Index {
				race.RecomputeHeat(&e.raceState.Heats[i], next.QualifyingMetric)
			}
		}
	}

	hasOpenQualRound := stg.Format == domain.FormatOpenQualifier
	if !hasOpenQualRound {
		for _, r := range e.raceState.Rounds {
			if r.StageIndex == stg.Index && (r.StageFormat == domain.FormatOpenQualifier || domain.IsOpenQualRoundID(r.ID)) {
				hasOpenQualRound = true
				break
			}
		}
	}
	if hasOpenQualRound && next.MaxPacksPerPilot > 0 && next.MaxPacksPerPilot != prev.MaxPacksPerPilot {
		e.reconcileOpenQualifierMaxPacksLocked(stg.Index, next.MaxPacksPerPilot, next.QualifyingMetric)
	}

	pphChanged := prev.PilotsPerHeat != next.PilotsPerHeat
	chChanged := !equalSeatChannels(prev.SeatChannels, next.SeatChannels)
	lapsChanged := prev.TargetLaps != next.TargetLaps
	timeChanged := prev.TimeLimitSec != next.TimeLimitSec

	startedInStage := race.AnyRealHeatStartedInStage(&e.raceState, stg.Index)
	hasQualRoundsInStage := stg.Format == domain.FormatQualifying
	if !hasQualRoundsInStage {
		for _, r := range e.raceState.Rounds {
			if r.StageIndex == stg.Index && r.StageFormat == domain.FormatQualifying && !domain.IsStagePortalRoundID(r.ID) {
				hasQualRoundsInStage = true
				break
			}
		}
	}
	qualRoundsChanged := hasQualRoundsInStage && req.QualifyingRounds > 0 && prev.QualifyingRounds != next.QualifyingRounds

	if !startedInStage && !stg.Customized && stg.Format != domain.FormatCustom && stg.Format != domain.FormatOpenQualifier {
		e.rebuildSingleStageLocked(stg.Index)
		return nil
	}

	if stg.Format == domain.FormatQualifying && (qualRoundsChanged || pphChanged || chChanged || lapsChanged || timeChanged) {
		e.reconcileQualifyingStageLocked(stg.Index)
		return nil
	}
	if qualRoundsChanged {
		e.reconcileQualifyingStageLocked(stg.Index)
		if !pphChanged && !chChanged && !lapsChanged && !timeChanged {
			return nil
		}
	}

	if !req.ApplyToExisting && startedInStage {
		race.SyncRoundsMetadata(&e.raceState)
		return nil
	}

	// Propagate updated settings strictly to unstarted rounds & heats in `stg.Index` ONLY

	roundStartedCount := make(map[string]int)
	for _, h := range e.raceState.Heats {
		if h.StageIndex == stg.Index && !isUnstartedHeatState(h.State) {
			roundStartedCount[h.RoundID]++
		}
	}

	for i := range e.raceState.Rounds {
		r := &e.raceState.Rounds[i]
		if r.StageIndex != stg.Index || domain.IsStagePortalRoundID(r.ID) || roundStartedCount[r.ID] > 0 {
			continue
		}
		if lapsChanged && r.StageFormat != domain.FormatQualifying && r.StageFormat != domain.FormatOpenQualifier {
			r.TargetLaps = next.TargetLaps
		}
		if timeChanged {
			r.TimeLimitSec = next.TimeLimitSec
		}
	}
	for i := range e.raceState.Heats {
		h := &e.raceState.Heats[i]
		if h.StageIndex != stg.Index || !isUnstartedHeatState(h.State) {
			continue
		}
		if lapsChanged && h.StageFormat != domain.FormatQualifying && h.StageFormat != domain.FormatOpenQualifier {
			h.TargetLaps = next.TargetLaps
		}
		if timeChanged {
			h.TimeLimitSec = next.TimeLimitSec
		}
		if pphChanged || chChanged {
			syncUnstartedHeatSeatsToConfig(h, next.PilotsPerHeat, next.SeatChannels)
			finalizeEditedHeatState(h, next.QualifyingMetric)
		}
	}
	if pphChanged || chChanged {
		for _, r := range e.raceState.Rounds {
			if r.StageIndex == stg.Index && roundStartedCount[r.ID] == 0 {
				e.rebalanceAutoConnectionsIntoLocked(r.ID)
			}
		}
		e.recomputeGraphAndRebuildLocked(stg.Index, "")
	} else {
		race.SyncRoundsMetadata(&e.raceState)
	}
	return nil
}

// reconcileOpenQualifierMaxPacksLocked trims any unstarted queued seats in an Open Qualifier stage
// that exceed a newly lowered `maxPacks` per-pilot limit and removes any unstarted heats left empty.
func (e *Engine) reconcileOpenQualifierMaxPacksLocked(
	stageIdx int,
	maxPacks int,
	qualMetric domain.QualifyingMetric,
) {
	if maxPacks < 1 {
		return
	}
	seenPerPilot := make(map[int]int)
	for i := range e.raceState.Heats {
		h := &e.raceState.Heats[i]
		isOpenQualHeat := h.StageFormat == domain.FormatOpenQualifier || domain.IsOpenQualRoundID(h.RoundID)
		if h.StageIndex != stageIdx || !isOpenQualHeat || h.State == domain.HeatAborted || isUnstartedHeatState(h.State) {
			continue
		}
		for _, s := range h.Seats {
			if s.PilotSlotIndex > 0 && s.Status != domain.PilotHeatDNS && s.Status != domain.PilotHeatDQ {
				seenPerPilot[s.PilotSlotIndex]++
			}
		}
	}

	kept := make([]domain.RaceHeat, 0, len(e.raceState.Heats))
	for i := range e.raceState.Heats {
		h := e.raceState.Heats[i]
		isOpenQualHeat := h.StageFormat == domain.FormatOpenQualifier || domain.IsOpenQualRoundID(h.RoundID)
		if h.StageIndex != stageIdx || !isOpenQualHeat || h.State == domain.HeatAborted || !isUnstartedHeatState(h.State) {
			kept = append(kept, h)
			continue
		}
		remaining := 0
		for si := range h.Seats {
			slot := h.Seats[si].PilotSlotIndex
			if slot <= 0 || h.Seats[si].Status == domain.PilotHeatDNS || h.Seats[si].Status == domain.PilotHeatDQ {
				continue
			}
			if seenPerPilot[slot] >= maxPacks {
				clearSeatOccupant(&h.Seats[si], false)
				h.Seats[si].Feeder = nil
				h.Seats[si].ManualLock = false
			} else {
				seenPerPilot[slot]++
				remaining++
			}
		}
		if remaining > 0 {
			finalizeEditedHeatState(&h, qualMetric)
			kept = append(kept, h)
		} else if h.ID == e.raceState.ActiveHeatID {
			e.raceState.ActiveHeatID = ""
		}
	}
	for i := range kept {
		kept[i].Order = i + 1
	}
	e.raceState.Heats = kept
	race.SyncRoundsMetadata(&e.raceState)
}

// reconcileQualifyingStageLocked dynamically reconciles the Round nodes, sequential connections, and
// per-round heat counts of a Regular Qualifying stage (`FormatQualifying`) whenever `QualifyingRounds`,
// `MaxPacksPerPilot`, `PilotsPerHeat`, or the active pilot roster changes, while leaving any already
// started or confirmed heats untouched.
func (e *Engine) reconcileQualifyingStageLocked(stageIdx int) {
	race.EnsureStagesMetadata(&e.raceState)
	savedWantRounds := 0
	if stgPre := e.findStageByIndexLocked(stageIdx); stgPre != nil {
		savedWantRounds = stgPre.Settings.Normalized(e.raceState.Config, domain.FormatQualifying).QualifyingRounds
	}
	race.SyncRoundsMetadata(&e.raceState)

	stg := e.findStageByIndexLocked(stageIdx)
	if stg == nil {
		return
	}
	if stg.Format != domain.FormatQualifying {
		hasQual := false
		for _, r := range e.raceState.Rounds {
			if r.StageIndex == stageIdx && r.StageFormat == domain.FormatQualifying && !domain.IsStagePortalRoundID(r.ID) {
				hasQual = true
				break
			}
		}
		if !hasQual {
			return
		}
	}
	if savedWantRounds > 0 {
		stg.Settings.QualifyingRounds = savedWantRounds
	}
	settings := stg.Settings.Normalized(e.raceState.Config, domain.FormatQualifying)
	maxPerHeat := settings.PilotsPerHeat
	if maxPerHeat < 2 {
		maxPerHeat = 4
	}
	seatChannels := settings.SeatChannels
	if len(seatChannels) < maxPerHeat {
		seatChannels = domain.DefaultSeatChannels(maxPerHeat)
	}

	var qualRounds []domain.RaceRound
	for _, r := range e.raceState.Rounds {
		if r.StageIndex == stageIdx && r.StageFormat == domain.FormatQualifying && !domain.IsStagePortalRoundID(r.ID) && !domain.IsOpenQualRoundID(r.ID) {
			qualRounds = append(qualRounds, r)
		}
	}
	sort.SliceStable(qualRounds, func(i, j int) bool {
		if qualRounds[i].Column != qualRounds[j].Column {
			return qualRounds[i].Column < qualRounds[j].Column
		}
		if qualRounds[i].Round != qualRounds[j].Round {
			return qualRounds[i].Round < qualRounds[j].Round
		}
		return qualRounds[i].ID < qualRounds[j].ID
	})

	roundStartedHeats := make(map[string]int)
	for _, h := range e.raceState.Heats {
		if h.StageIndex == stageIdx && !isUnstartedHeatState(h.State) {
			roundStartedHeats[h.RoundID]++
		}
	}
	minRounds := 0
	for idx, r := range qualRounds {
		if roundStartedHeats[r.ID] > 0 {
			minRounds = idx + 1
		}
	}

	wantRounds := settings.QualifyingRounds
	if wantRounds < minRounds {
		wantRounds = minRounds
	}
	if wantRounds < 1 {
		wantRounds = 1
	}
	stg.Settings.QualifyingRounds = wantRounds
	if len(e.raceState.Stages) == 1 && stageIdx == 1 {
		e.raceState.Config.QualifyingRounds = wantRounds
	}

	outPortalID := domain.StageHandoffOutID(stageIdx)
	inPortalID := domain.StageHandoffInID(stageIdx)
	hasOutPortal := e.findRoundByIDLocked(outPortalID) != nil
	hasInPortal := len(race.IncomingStageConnections(&e.raceState, stageIdx)) > 0 && e.findRoundByIDLocked(inPortalID) != nil

	origQualSet := make(map[string]bool, len(qualRounds))
	for _, qr := range qualRounds {
		origQualSet[qr.ID] = true
	}
	var savedCutConns []domain.RoundConnection
	for _, c := range e.raceState.Connections {
		if c.StageIndex == stageIdx && origQualSet[c.FromRoundID] && !origQualSet[c.ToRoundID] && !domain.IsStagePortalRoundID(c.ToRoundID) {
			savedCutConns = append(savedCutConns, c)
		}
	}

	// 1. Trim excess unstarted rounds from the end if `wantRounds < len(qualRounds)`
	if len(qualRounds) > wantRounds {
		excess := len(qualRounds) - wantRounds
		dropRoundID := make(map[string]bool, excess)
		for k := len(qualRounds) - 1; k >= 0 && excess > 0; k-- {
			rid := qualRounds[k].ID
			if roundStartedHeats[rid] == 0 {
				dropRoundID[rid] = true
				excess--
			}
		}
		if len(dropRoundID) > 0 {
			keptRounds := make([]domain.RaceRound, 0, len(e.raceState.Rounds))
			for _, r := range e.raceState.Rounds {
				if !dropRoundID[r.ID] {
					keptRounds = append(keptRounds, r)
				}
			}
			e.raceState.Rounds = keptRounds

			keptHeats := make([]domain.RaceHeat, 0, len(e.raceState.Heats))
			for _, h := range e.raceState.Heats {
				if !dropRoundID[h.RoundID] {
					keptHeats = append(keptHeats, h)
				} else if h.ID == e.raceState.ActiveHeatID {
					e.raceState.ActiveHeatID = ""
				}
			}
			e.raceState.Heats = keptHeats

			keptConns := make([]domain.RoundConnection, 0, len(e.raceState.Connections))
			for _, c := range e.raceState.Connections {
				if !dropRoundID[c.FromRoundID] && !dropRoundID[c.ToRoundID] {
					keptConns = append(keptConns, c)
				}
			}
			e.raceState.Connections = keptConns

			filtered := make([]domain.RaceRound, 0, len(qualRounds))
			for _, r := range qualRounds {
				if !dropRoundID[r.ID] {
					filtered = append(filtered, r)
				}
			}
			qualRounds = filtered
		}
	}

	// 2. Append new Qualifying rounds if `len(qualRounds) < wantRounds`
	usedRoundIDs := make(map[string]bool, len(e.raceState.Rounds))
	for _, r := range e.raceState.Rounds {
		usedRoundIDs[r.ID] = true
	}
	for len(qualRounds) < wantRounds {
		rndNum := len(qualRounds) + 1
		candID := fmt.Sprintf("s%d-c%d-qualifying", stageIdx, rndNum)
		suffix := 2
		for usedRoundIDs[candID] {
			candID = fmt.Sprintf("s%d-c%d-qualifying-%d", stageIdx, rndNum, suffix)
			suffix++
		}
		usedRoundIDs[candID] = true
		seedSrc := ""
		if rndNum == 1 && !hasInPortal {
			seedSrc = "all_active_pilots"
		}
		nr := domain.RaceRound{
			ID:           candID,
			StageIndex:   stageIdx,
			Round:        rndNum,
			Column:       rndNum,
			BracketLane:  "qualifying",
			Title:        fmt.Sprintf("Qualifying R%d", rndNum),
			StageFormat:  domain.FormatQualifying,
			StartMode:    domain.StartModeStaggered,
			TargetLaps:   settings.TargetLaps,
			TimeLimitSec: settings.TimeLimitSec,
			SeedSource:   seedSrc,
		}
		e.raceState.Rounds = append(e.raceState.Rounds, nr)
		qualRounds = append(qualRounds, nr)
	}

	// 3. Normalize Round & Column numbering + round metadata on `qualRounds`
	qualIDSet := make(map[string]int, len(qualRounds))
	for idx := range qualRounds {
		rid := qualRounds[idx].ID
		qualIDSet[rid] = idx
		rPtr := e.findRoundByIDLocked(rid)
		if rPtr == nil {
			continue
		}
		rPtr.Round = idx + 1
		rPtr.Column = idx + 1
		rPtr.BracketLane = "qualifying"
		rPtr.StageFormat = domain.FormatQualifying
		if roundStartedHeats[rid] == 0 {
			rPtr.TargetLaps = settings.TargetLaps
			rPtr.TimeLimitSec = settings.TimeLimitSec
		}
		if idx == 0 {
			if !hasInPortal && rPtr.SeedSource != "empty" {
				rPtr.SeedSource = "all_active_pilots"
			}
		} else {
			rPtr.SeedSource = ""
		}
		qualRounds[idx] = *rPtr
	}
	if hasOutPortal {
		if outPtr := e.findRoundByIDLocked(outPortalID); outPtr != nil {
			outPtr.Column = len(qualRounds) + 1
		}
	}

	// 4. Rebuild clean sequential connections across `qualRounds` (plus portals), preserving any custom non-qualifying round connections
	keptConns := make([]domain.RoundConnection, 0, len(e.raceState.Connections)+len(qualRounds)+2)
	for _, c := range e.raceState.Connections {
		if c.StageIndex != stageIdx {
			keptConns = append(keptConns, c)
			continue
		}
		_, fromQual := qualIDSet[c.FromRoundID]
		_, toQual := qualIDSet[c.ToRoundID]
		if !fromQual && !toQual {
			keptConns = append(keptConns, c)
		}
	}
	if hasInPortal && len(qualRounds) > 0 {
		keptConns = append(keptConns, domain.RoundConnection{
			ID:           fmt.Sprintf("conn-%s-%s-stage_seeds", inPortalID, qualRounds[0].ID),
			StageIndex:   stageIdx,
			FromRoundID:  inPortalID,
			ToRoundID:    qualRounds[0].ID,
			FromPort:     "right",
			ToPort:       "left",
			Mode:         "stage_seeds",
			SeedStart:    1,
			SeedEnd:      0,
			Distribution: "sequential",
		})
	}
	for idx := 0; idx+1 < len(qualRounds); idx++ {
		fromID := qualRounds[idx].ID
		toID := qualRounds[idx+1].ID
		keptConns = append(keptConns, domain.RoundConnection{
			ID:          fmt.Sprintf("conn-%s-%s-all_pilots", fromID, toID),
			StageIndex:  stageIdx,
			FromRoundID: fromID,
			ToRoundID:   toID,
			FromPort:    "right",
			ToPort:      "left",
			Mode:        "all_pilots",
		})
	}
	if hasOutPortal && len(qualRounds) > 0 {
		lastID := qualRounds[len(qualRounds)-1].ID
		keptConns = append(keptConns, domain.RoundConnection{
			ID:          fmt.Sprintf("conn-%s-%s-qual_feed", lastID, outPortalID),
			StageIndex:  stageIdx,
			FromRoundID: lastID,
			ToRoundID:   outPortalID,
			FromPort:    "right",
			ToPort:      "left",
			Mode:        "qual_feed",
			Count:       e.raceState.Config.Stage2MaxSeeds,
		})
	}
	if len(savedCutConns) > 0 && len(qualRounds) > 0 {
		lastID := qualRounds[len(qualRounds)-1].ID
		lastCol := qualRounds[len(qualRounds)-1].Column
		for _, cc := range savedCutConns {
			cc.FromRoundID = lastID
			cc.ID = fmt.Sprintf("conn-%s-%s-%s", lastID, cc.ToRoundID, cc.Mode)
			keptConns = append(keptConns, cc)
		}
		for hi := range e.raceState.Heats {
			if e.raceState.Heats[hi].StageIndex != stageIdx || qualIDSet[e.raceState.Heats[hi].RoundID] > 0 || (len(qualRounds) > 0 && e.raceState.Heats[hi].RoundID == qualRounds[0].ID) {
				continue
			}
			for si := range e.raceState.Heats[hi].Seats {
				fd := e.raceState.Heats[hi].Seats[si].Feeder
				if fd != nil && origQualSet[fd.FromRoundID] {
					fd.FromRoundID = lastID
					fd.FromRoundColumn = lastCol
				}
			}
		}
	}
	e.raceState.Connections = keptConns

	// 5. Schedule 1 heat per active pilot per round across all unstarted heats/rounds
	pilots := e.activeEventPilotsForGenerationLocked()
	seedBySlot := make(map[int]int, len(pilots))
	for i, p := range pilots {
		seedBySlot[p.SlotIndex] = i + 1
	}

	for i := range e.raceState.Heats {
		h := &e.raceState.Heats[i]
		if h.StageIndex == stageIdx && !isUnstartedHeatState(h.State) {
			if rIdx, ok := qualIDSet[h.RoundID]; ok {
				h.Round = rIdx + 1
				h.Column = rIdx + 1
			}
		}
	}

	var unstartedRoundIdxs []int
	for idx, r := range qualRounds {
		if roundStartedHeats[r.ID] == 0 {
			unstartedRoundIdxs = append(unstartedRoundIdxs, idx)
			continue
		}
		// Partially-started round: ensure remaining active pilots who have not raced in this round yet get 1 heat
		racedInThisRound := make(map[int]bool)
		var unstartedHeatIdxs []int
		for hi := range e.raceState.Heats {
			h := &e.raceState.Heats[hi]
			if h.RoundID != r.ID {
				continue
			}
			if !isUnstartedHeatState(h.State) {
				for _, s := range h.Seats {
					if s.PilotSlotIndex > 0 {
						racedInThisRound[s.PilotSlotIndex] = true
					}
				}
			} else {
				unstartedHeatIdxs = append(unstartedHeatIdxs, hi)
			}
		}
		if len(unstartedHeatIdxs) == 0 {
			continue
		}
		var partialPilots []domain.PilotSlot
		for _, p := range pilots {
			if !racedInThisRound[p.SlotIndex] {
				partialPilots = append(partialPilots, p)
			}
		}
		dropHeat := make(map[int]bool)
		if len(partialPilots) == 0 {
			for _, hi := range unstartedHeatIdxs {
				dropHeat[hi] = true
			}
		} else {
			wantU := (len(partialPilots) + maxPerHeat - 1) / maxPerHeat
			if wantU < 1 {
				wantU = 1
			}
			for len(unstartedHeatIdxs) < wantU {
				e.appendHeatToRoundOrColumnLocked(r.ID, "qualifying", r.Round, r.Column)
				unstartedHeatIdxs = append(unstartedHeatIdxs, len(e.raceState.Heats)-1)
			}
			for k := len(unstartedHeatIdxs) - 1; k >= wantU; k-- {
				dropHeat[unstartedHeatIdxs[k]] = true
			}
		}
		if len(dropHeat) > 0 {
			kept := make([]domain.RaceHeat, 0, len(e.raceState.Heats)-len(dropHeat))
			for hi, h := range e.raceState.Heats {
				if !dropHeat[hi] {
					kept = append(kept, h)
				}
			}
			e.raceState.Heats = kept
		}
		if len(partialPilots) > 0 {
			var priorHeats []domain.RaceHeat
			var targetPtrs []*domain.RaceHeat
			for hi := range e.raceState.Heats {
				h := &e.raceState.Heats[hi]
				if h.StageIndex != stageIdx {
					continue
				}
				if h.RoundID == r.ID && isUnstartedHeatState(h.State) {
					syncUnstartedHeatSeatsToConfig(h, maxPerHeat, seatChannels)
					h.TargetLaps = settings.TargetLaps
					h.TimeLimitSec = settings.TimeLimitSec
					targetPtrs = append(targetPtrs, h)
				} else if !isUnstartedHeatState(h.State) || h.Column < r.Column {
					priorHeats = append(priorHeats, *h)
				}
			}
			grid := race.ScheduleBalancedQualifyingRound(nil, len(targetPtrs), seatChannels, priorHeats, partialPilots, r.Round)
			populateQualifyingRoundHeatsFromGrid(targetPtrs, grid, seatChannels, seedBySlot, r.Round, hasInPortal, settings.QualifyingMetric)
		}
	}

	// 6. Schedule all completely unstarted rounds (strictly 1 heat per active pilot per round)
	if len(unstartedRoundIdxs) > 0 {
		if hasInPortal && len(pilots) == 0 {
			expectedSeeds := race.StageExpectedIncomingSeeds(&e.raceState, stageIdx, 4)
			wantH := (expectedSeeds + maxPerHeat - 1) / maxPerHeat
			if wantH < 1 {
				wantH = 1
			}
			for _, rIdx := range unstartedRoundIdxs {
				r := qualRounds[rIdx]
				hCount := wantH
				if r.TargetHeats > hCount {
					hCount = r.TargetHeats
				}
				targetHeats := e.ensureRoundHeatCountLocked(r.ID, hCount)
				for _, th := range targetHeats {
					th.Round = r.Round
					th.Column = r.Column
					th.TargetLaps = settings.TargetLaps
					th.TimeLimitSec = settings.TimeLimitSec
					th.StartMode = domain.StartModeStaggered
					th.State = domain.HeatWaiting
				}
			}
		} else {
			baseHeats := (len(pilots) + maxPerHeat - 1) / maxPerHeat
			if baseHeats < 1 {
				baseHeats = 1
			}
			for _, rIdx := range unstartedRoundIdxs {
				r := qualRounds[rIdx]
				wantH := baseHeats
				if r.TargetHeats > wantH {
					wantH = r.TargetHeats
				}
				targetHeats := e.ensureRoundHeatCountLocked(r.ID, wantH)

				var srcPtrs []*domain.RaceHeat
				var priorHeats []domain.RaceHeat
				prevRoundID := ""
				if rIdx > 0 {
					prevRoundID = qualRounds[rIdx-1].ID
				}
				for hi := range e.raceState.Heats {
					h := &e.raceState.Heats[hi]
					if h.StageIndex != stageIdx || h.RoundID == r.ID {
						continue
					}
					if prevRoundID != "" && h.RoundID == prevRoundID {
						srcPtrs = append(srcPtrs, h)
					}
					if h.Column < r.Column {
						priorHeats = append(priorHeats, *h)
					}
				}

				grid := race.ScheduleBalancedQualifyingRound(
					srcPtrs,
					len(targetHeats),
					seatChannels,
					priorHeats,
					pilots,
					r.Round,
				)
				for hi, th := range targetHeats {
					th.Round = r.Round
					th.Column = r.Column
					th.BracketLane = "qualifying"
					th.StageFormat = domain.FormatQualifying
					th.StartMode = domain.StartModeStaggered
					th.TargetLaps = settings.TargetLaps
					th.TimeLimitSec = settings.TimeLimitSec
					th.ShortLabel = fmt.Sprintf("Q%d-H%d", r.Round, hi+1)
					if len(targetHeats) == 1 {
						th.Title = r.Title
					} else {
						th.Title = fmt.Sprintf("%s · Heat %d", r.Title, hi+1)
					}
				}
				populateQualifyingRoundHeatsFromGrid(targetHeats, grid, seatChannels, seedBySlot, r.Round, hasInPortal, settings.QualifyingMetric)
			}
		}
	}

	if len(savedCutConns) > 0 {
		e.recomputeGraphColumnsOnlyLocked(stageIdx)
	} else {
		e.sortCustomHeatsAndOrderLocked(stageIdx)
		race.RebuildEdgesFromFeeders(&e.raceState)
		race.SyncRoundsMetadata(&e.raceState)
	}
}

func populateQualifyingRoundHeatsFromGrid(
	targetHeats []*domain.RaceHeat,
	grid [][]race.BalancedSlotAssignment,
	seatChannels []uint8,
	seedBySlot map[int]int,
	roundNum int,
	hasInPortal bool,
	qualMetric domain.QualifyingMetric,
) {
	for hi, th := range targetHeats {
		for si := range th.Seats {
			var seatCode uint8
			if si < len(seatChannels) {
				seatCode = seatChannels[si]
			}
			band, ch, freq, ok := domain.DecodeBandChannel(seatCode)
			if !ok {
				band = th.Seats[si].Band
				if band == 0 {
					band = domain.BandRaceband
				}
				ch = th.Seats[si].Channel
				freq = domain.FrequencyForBandChannel(band, ch)
			}
			th.Seats[si].SeatIndex = si + 1
			th.Seats[si].Band = band
			th.Seats[si].Channel = ch
			th.Seats[si].FrequencyMHz = freq
			th.Seats[si].ManualLock = false
			th.Seats[si].Feeder = nil

			var cell race.BalancedSlotAssignment
			if hi < len(grid) && si < len(grid[hi]) {
				cell = grid[hi][si]
			}
			if cell.PilotSlotIndex > 0 {
				seedNum := cell.Seed
				if seedNum <= 0 {
					seedNum = seedBySlot[cell.PilotSlotIndex]
				}
				srcLbl := fmt.Sprintf("Seed #%d", seedNum)
				if roundNum > 1 {
					srcLbl = fmt.Sprintf("Q%d Rotation", roundNum-1)
				}
				th.Seats[si].PilotSlotIndex = cell.PilotSlotIndex
				th.Seats[si].Callsign = cell.Callsign
				th.Seats[si].PhoneticName = cell.PhoneticName
				th.Seats[si].Color = cell.Color
				th.Seats[si].Seed = seedNum
				th.Seats[si].SourceLabel = srcLbl
				th.Seats[si].Status = domain.PilotHeatStaged
				th.Seats[si].Crossings = nil
				th.Seats[si].Laps = []domain.HeatLap{}
				th.Seats[si].ManualPosition = 0
				th.Seats[si].PenaltySec = 0
			} else {
				clearSeatOccupant(&th.Seats[si], false)
				th.Seats[si].SourceLabel = "Open / BYE"
			}
		}
		if hasInPortal {
			th.State = domain.HeatWaiting
		} else {
			th.State = domain.HeatReady
		}
		finalizeEditedHeatState(th, qualMetric)
	}
}

func (e *Engine) moveStagesLocked(req BracketEditPayload) {
	race.EnsureStagesMetadata(&e.raceState)
	if len(req.StagePositions) > 0 {
		for _, sp := range req.StagePositions {
			if stg := e.findStageLocked(sp.StageID, 0); stg != nil {
				stg.HasPos = true
				stg.PosX = sp.PosX
				stg.PosY = sp.PosY
			}
		}
	} else if stg := e.findStageLocked(req.StageID, req.StageIndex); stg != nil {
		stg.HasPos = true
		stg.PosX = req.PosX
		stg.PosY = req.PosY
	}
}

func (e *Engine) autoLayoutStagesLocked() {
	race.EnsureStagesMetadata(&e.raceState)
	if len(e.raceState.Stages) == 0 {
		return
	}
	inAdj := make(map[int][]int)
	for _, sc := range e.raceState.StageConnections {
		if !sc.Invalid && sc.FromStageIndex > 0 && sc.ToStageIndex > 0 {
			inAdj[sc.ToStageIndex] = append(inAdj[sc.ToStageIndex], sc.FromStageIndex)
		}
	}
	depth := make(map[int]int, len(e.raceState.Stages))
	topo := race.TopologicalStageIndices(&e.raceState)
	for _, idx := range topo {
		d := 0
		for _, up := range inAdj[idx] {
			if depth[up]+1 > d {
				d = depth[up] + 1
			}
		}
		depth[idx] = d
	}
	byDepth := make(map[int][]int)
	maxD := 0
	for _, idx := range topo {
		d := depth[idx]
		if d > maxD {
			maxD = d
		}
		byDepth[d] = append(byDepth[d], idx)
	}

	const (
		startX   = 120.0
		colGapX  = 430.0
		centerY  = 240.0
		rowGapY  = 250.0
	)
	for d := 0; d <= maxD; d++ {
		group := byDepth[d]
		sort.Ints(group)
		totalH := float64(len(group)-1) * rowGapY
		topY := centerY - totalH/2.0
		for gi, sIdx := range group {
			if stg := e.findStageByIndexLocked(sIdx); stg != nil {
				stg.HasPos = true
				stg.PosX = startX + float64(d)*colGapX
				stg.PosY = topY + float64(gi)*rowGapY
			}
		}
	}
}

func (e *Engine) inferStageConnectionRuleLocked(
	fromStg, toStg *domain.RaceStage,
	explicitMode string,
	explicitCount, explicitSeedStart, explicitSeedEnd int,
	excludeID string,
) (mode string, count, seedStart, seedEnd int) {
	m := strings.TrimSpace(explicitMode)
	if m == "all_pilots" || m == "top_n" || m == "seed_range" {
		cnt := explicitCount
		sStart := explicitSeedStart
		sEnd := explicitSeedEnd
		if m == "top_n" && cnt < 1 {
			cnt = 8
		}
		if m == "seed_range" && sStart < 1 {
			sStart = 1
		}
		return m, cnt, sStart, sEnd
	}

	// Smart inference when wiring stages without an explicit rule:
	// If `fromStg` already has an outgoing wire slicing Top K (or Seeds #1..#K), default this 2nd branch
	// wire to the next contiguous seed slice (#K+1 .. #2K) for effortless A-Main / B-Main / Redemption splits!
	maxUsedEnd := 0
	existingOutCount := 0
	for _, sc := range e.raceState.StageConnections {
		if sc.Invalid || sc.ID == excludeID || sc.FromStageID != fromStg.ID {
			continue
		}
		existingOutCount++
		if sc.Mode == "top_n" && sc.Count > maxUsedEnd {
			maxUsedEnd = sc.Count
		} else if sc.Mode == "seed_range" && sc.SeedEnd > maxUsedEnd {
			maxUsedEnd = sc.SeedEnd
		}
	}
	if existingOutCount > 0 && maxUsedEnd > 0 {
		return "seed_range", maxUsedEnd, maxUsedEnd + 1, maxUsedEnd * 2
	}
	if explicitSeedStart > 1 || (explicitSeedStart >= 1 && explicitSeedEnd > 0) {
		return "seed_range", 0, explicitSeedStart, explicitSeedEnd
	}
	if explicitCount > 0 {
		return "top_n", explicitCount, 0, 0
	}
	return "all_pilots", 0, 0, 0
}

func (e *Engine) connectStagesLocked(
	fromStageID, toStageID, linkMode string,
	advanceCount, seedStart, seedEnd int,
	rankingMetric domain.QualifyingMetric,
	fromPort, toPort string,
) error {
	fromStg := e.findStageLocked(fromStageID, 0)
	toStg := e.findStageLocked(toStageID, 0)
	if fromStg == nil || toStg == nil {
		return fmt.Errorf("source or target stage not found")
	}

	mode, cnt, sStart, sEnd := e.inferStageConnectionRuleLocked(fromStg, toStg, linkMode, advanceCount, seedStart, seedEnd, "")
	sc := domain.StageConnection{
		ID:             e.nextUniqueIDLocked("sconn"),
		FromStageID:    fromStg.ID,
		ToStageID:      toStg.ID,
		FromStageIndex: fromStg.Index,
		ToStageIndex:   toStg.Index,
		FromPort:       normalizeStagePort(fromPort, "right"),
		ToPort:         normalizeStagePort(toPort, "left"),
		Mode:           mode,
		Count:          cnt,
		SeedStart:      sStart,
		SeedEnd:        sEnd,
		RankingMetric:  rankingMetric,
	}

	startedBlock := false
	if race.AnyRealHeatStartedInStage(&e.raceState, toStg.Index) {
		startedBlock = true
	}

	fromID := fromStg.ID
	toID := toStg.ID
	toTitle := toStg.Title

	e.raceState.StageConnections = append(e.raceState.StageConnections, sc)
	race.EnsureStagesMetadata(&e.raceState)
	fromStg = e.findStageLocked(fromID, 0)
	toStg = e.findStageLocked(toID, 0)
	var added *domain.StageConnection
	for i := range e.raceState.StageConnections {
		if e.raceState.StageConnections[i].ID == sc.ID {
			added = &e.raceState.StageConnections[i]
			break
		}
	}
	if added == nil {
		added = &e.raceState.StageConnections[len(e.raceState.StageConnections)-1]
	}
	if startedBlock && !added.Invalid {
		added.Invalid = true
		added.InvalidReason = fmt.Sprintf("%s already has started heats and cannot accept new upstream stage connections.", toTitle)
		if e.raceState.FormatInvalidReason == "" {
			e.raceState.FormatInvalidReason = added.InvalidReason
		}
	}

	if !added.Invalid && fromStg != nil && toStg != nil {
		if len(e.raceState.Stages) == 2 && fromStg.Index == 1 && toStg.Index == 2 {
			if added.Mode == "top_n" {
				e.raceState.Config.Stage2MaxSeeds = added.Count
			} else if added.Mode == "all_pilots" {
				e.raceState.Config.Stage2MaxSeeds = 0
			}
		}
		// Ensure Qualifying source stage has `qual_feed` round connections into its outgoing portal
		race.SyncRoundsMetadata(&e.raceState)
		if fromStg.Format == domain.FormatQualifying || fromStg.Format == domain.FormatOpenQualifier {
			outPortalID := domain.StageHandoffOutID(fromStg.Index)
			hasPortalFeed := false
			for _, rc := range e.raceState.Connections {
				if !rc.Invalid && rc.ToRoundID == outPortalID {
					hasPortalFeed = true
					break
				}
			}
			if !hasPortalFeed {
				for _, r := range e.raceState.Rounds {
					if r.StageIndex == fromStg.Index && !domain.IsStagePortalRoundID(r.ID) {
						_ = e.connectRoundsLocked(r.ID, outPortalID, "qual_feed", 0, 0, 0, "")
					}
				}
			}
		}
		e.onStageIncomingChangedLocked(toStg.Index)
	}
	return nil
}

func (e *Engine) updateStageConnectionLocked(req BracketEditPayload) error {
	race.EnsureStagesMetadata(&e.raceState)
	idx := -1
	connID := strings.TrimSpace(req.ConnectionID)
	fromID := strings.TrimSpace(req.FromStageID)
	toID := strings.TrimSpace(req.ToStageID)
	for i, sc := range e.raceState.StageConnections {
		if (connID != "" && sc.ID == connID) || (connID == "" && sc.FromStageID == fromID && sc.ToStageID == toID) {
			idx = i
			break
		}
	}
	if idx < 0 {
		return fmt.Errorf("stage connection not found")
	}
	sc := &e.raceState.StageConnections[idx]
	if !sc.Invalid && race.AnyRealHeatStartedInStage(&e.raceState, sc.ToStageIndex) {
		return fmt.Errorf("cannot modify stage connection into Stage %d after its heats have started", sc.ToStageIndex)
	}
	if req.LinkMode == "all_pilots" || req.LinkMode == "top_n" || req.LinkMode == "seed_range" {
		sc.Mode = req.LinkMode
	}
	if req.AdvanceCount >= 0 {
		sc.Count = req.AdvanceCount
	}
	if req.SeedStart >= 1 {
		sc.SeedStart = req.SeedStart
	}
	if req.SeedEnd >= 0 {
		sc.SeedEnd = req.SeedEnd
	}
	if req.QualifyingMetric != "" {
		sc.RankingMetric = req.QualifyingMetric
	}

	toIdx := sc.ToStageIndex
	if len(e.raceState.Stages) == 2 && sc.FromStageIndex == 1 && sc.ToStageIndex == 2 {
		if sc.Mode == "top_n" {
			e.raceState.Config.Stage2MaxSeeds = sc.Count
		} else if sc.Mode == "all_pilots" {
			e.raceState.Config.Stage2MaxSeeds = 0
		}
	}
	race.EnsureStagesMetadata(&e.raceState)
	e.onStageIncomingChangedLocked(toIdx)
	return nil
}

func (e *Engine) reconnectStageConnectionLocked(req BracketEditPayload) error {
	race.EnsureStagesMetadata(&e.raceState)
	idx := -1
	connID := strings.TrimSpace(req.ConnectionID)
	for i, sc := range e.raceState.StageConnections {
		if connID != "" && sc.ID == connID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return fmt.Errorf("stage connection not found")
	}
	orig := e.raceState.StageConnections[idx]
	newFromID := orig.FromStageID
	if strings.TrimSpace(req.FromStageID) != "" {
		newFromID = strings.TrimSpace(req.FromStageID)
	}
	newToID := orig.ToStageID
	if strings.TrimSpace(req.ToStageID) != "" {
		newToID = strings.TrimSpace(req.ToStageID)
	}
	fromStg := e.findStageLocked(newFromID, req.FromStageIndex)
	toStg := e.findStageLocked(newToID, req.ToStageIndex)
	if fromStg == nil || toStg == nil {
		return fmt.Errorf("source or target stage not found")
	}

	if !orig.Invalid && orig.ToStageID != toStg.ID && race.AnyRealHeatStartedInStage(&e.raceState, orig.ToStageIndex) {
		return fmt.Errorf("cannot detach stage connection after target stage heats have started")
	}

	nextFromPort := orig.FromPort
	if strings.TrimSpace(req.FromPort) != "" {
		nextFromPort = normalizeStagePort(req.FromPort, "right")
	}
	nextToPort := orig.ToPort
	if strings.TrimSpace(req.ToPort) != "" {
		nextToPort = normalizeStagePort(req.ToPort, "left")
	}

	if orig.FromStageID == fromStg.ID && orig.ToStageID == toStg.ID {
		e.raceState.StageConnections[idx].FromPort = nextFromPort
		e.raceState.StageConnections[idx].ToPort = nextToPort
		race.EnsureStagesMetadata(&e.raceState)
		return nil
	}

	moved := orig
	moved.FromStageID = fromStg.ID
	moved.ToStageID = toStg.ID
	moved.FromStageIndex = fromStg.Index
	moved.ToStageIndex = toStg.Index
	moved.FromPort = nextFromPort
	moved.ToPort = nextToPort
	moved.Invalid = false
	moved.InvalidReason = ""

	without := make([]domain.StageConnection, 0, len(e.raceState.StageConnections))
	for i, c := range e.raceState.StageConnections {
		if i != idx {
			without = append(without, c)
		}
	}
	without = append(without, moved)
	e.raceState.StageConnections = without
	race.EnsureStagesMetadata(&e.raceState)

	origToStg := e.findStageLocked(orig.ToStageID, 0)
	movedToStg := e.findStageLocked(moved.ToStageID, 0)
	if orig.ToStageID != moved.ToStageID && !orig.Invalid && origToStg != nil {
		e.onStageIncomingChangedLocked(origToStg.Index)
	}
	if movedToStg != nil && !e.raceState.StageConnections[len(e.raceState.StageConnections)-1].Invalid {
		e.onStageIncomingChangedLocked(movedToStg.Index)
	}
	return nil
}

func (e *Engine) disconnectStagesLocked(connID, fromStageID, toStageID string) error {
	race.EnsureStagesMetadata(&e.raceState)
	idx := -1
	for i, sc := range e.raceState.StageConnections {
		if (connID != "" && sc.ID == connID) || (connID == "" && sc.FromStageID == fromStageID && sc.ToStageID == toStageID) {
			idx = i
			break
		}
	}
	if idx < 0 {
		return fmt.Errorf("stage connection not found")
	}
	orig := e.raceState.StageConnections[idx]
	if !orig.Invalid && race.AnyRealHeatStartedInStage(&e.raceState, orig.ToStageIndex) {
		return fmt.Errorf("cannot disconnect stage wire into Stage %d after its heats have started", orig.ToStageIndex)
	}
	e.raceState.StageConnections = append(e.raceState.StageConnections[:idx], e.raceState.StageConnections[idx+1:]...)
	race.EnsureStagesMetadata(&e.raceState)
	if !orig.Invalid {
		if origToStg := e.findStageLocked(orig.ToStageID, 0); origToStg != nil {
			e.onStageIncomingChangedLocked(origToStg.Index)
		}
	}
	race.SyncRoundsMetadata(&e.raceState)
	return nil
}
