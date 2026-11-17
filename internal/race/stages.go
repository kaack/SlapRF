package race

import (
	"fmt"
	"sort"
	"strings"

	"slaprf/internal/domain"
)

// DefaultStageTitle returns a clean human-readable stage title for `format`.
func DefaultStageTitle(format domain.StageFormat, stageIdx int) string {
	switch format {
	case domain.FormatQualifying:
		return "Qualifying"
	case domain.FormatOpenQualifier:
		return "Open Qualifier"
	case domain.FormatSingleElimination:
		return "Single Elimination"
	case domain.FormatDoubleElimination:
		return "Double Elimination"
	case domain.FormatPointsMains:
		return "Points Mains"
	case domain.FormatChaseTheAce:
		return "Chase the Ace"
	case domain.FormatCustom:
		return fmt.Sprintf("Custom Stage %d", stageIdx)
	default:
		return fmt.Sprintf("Stage %d", stageIdx)
	}
}

// FormatStageConnectionBadge returns a concise label for a StageConnection wire on the Format canvas.
func FormatStageConnectionBadge(c domain.StageConnection) string {
	switch c.Mode {
	case "top_n":
		n := c.Count
		if n < 1 {
			n = 8
		}
		return fmt.Sprintf("Top %d", n)
	case "seed_range":
		start := c.SeedStart
		if start < 1 {
			start = 1
		}
		if c.SeedEnd > 0 && c.SeedEnd >= start {
			if start == 1 {
				return fmt.Sprintf("Top %d (#1–#%d)", c.SeedEnd, c.SeedEnd)
			}
			return fmt.Sprintf("Seeds #%d–#%d", start, c.SeedEnd)
		}
		return fmt.Sprintf("Seeds #%d+", start)
	default:
		return "All Pilots"
	}
}

// EnsureStagesMetadata migrates legacy 1-stage / 2-stage races that lack `st.Stages`, normalizes
// stage indices (1..N) and settings, keeps `st.TotalStages` synchronized, and validates the
// Stage DAG & dangling status.
func EnsureStagesMetadata(st *domain.RaceTournamentState) {
	if st == nil {
		return
	}
	cfg := st.Config.Normalized()

	// Do not synthesize stages on a completely blank ungenerated race
	if len(st.Stages) == 0 && !st.Generated && len(st.Heats) == 0 && len(st.Rounds) == 0 {
		if st.TotalStages < 1 {
			st.TotalStages = 1
		}
		if st.ActiveStageIndex < 1 {
			st.ActiveStageIndex = 1
		}
		st.FormatInvalidReason = ""
		return
	}

	if len(st.Stages) == 0 {
		maxStageSeen := st.TotalStages
		for _, h := range st.Heats {
			if h.StageIndex > maxStageSeen {
				maxStageSeen = h.StageIndex
			}
		}
		for _, r := range st.Rounds {
			if r.StageIndex > maxStageSeen {
				maxStageSeen = r.StageIndex
			}
		}
		if cfg.Structure == domain.StructureTwoStage && maxStageSeen < 2 {
			maxStageSeen = 2
		}
		if maxStageSeen < 1 {
			maxStageSeen = 1
		}
		if maxStageSeen > domain.MaxRaceStages {
			maxStageSeen = domain.MaxRaceStages
		}

		isCustomTpl := st.TemplateID == "custom"
		if maxStageSeen == 1 {
			fmt1 := cfg.MainFormat
			if isCustomTpl {
				for _, r := range st.Rounds {
					if r.StageIndex == 1 && !domain.IsStagePortalRoundID(r.ID) && r.StageFormat != "" {
						fmt1 = r.StageFormat
						break
					}
				}
			}
			stage1Title := DefaultStageTitle(fmt1, 1)
			if st.TemplateID == "cpq_qualifier" {
				stage1Title = "Qualifier"
			} else if fmt1 == domain.FormatOpenQualifier && st.MGPLink != nil && st.MGPLink.IsZippyQ {
				stage1Title = "ZippyQ Qualifier"
			}
			st.Stages = []domain.RaceStage{
				{
					ID:         "stage-1",
					Index:      1,
					Title:      stage1Title,
					Format:     fmt1,
					Customized: isCustomTpl,
					Status:     domain.StageStatusActive,
					Settings:   domain.DefaultStageSettingsFromConfig(cfg, fmt1),
					HasPos:     true,
					PosX:       120,
					PosY:       180,
				},
			}
			st.StageConnections = nil
		} else {
			// Synthesize Stage 1 (Qualifying) -> Stage 2..N
			s1Title := "Qualifying"
			if st.TemplateID == "qual_single_elim" || st.TemplateID == "cpq_mains" {
				s1Title = "Qualifier"
			}
			s1 := domain.RaceStage{
				ID:             "stage-1",
				Index:          1,
				Title:          s1Title,
				Format:         domain.FormatQualifying,
				Customized:     isCustomTpl,
				CompletedEarly: st.Stage2SeededEarly,
				Status:         domain.StageStatusActive,
				Settings:       domain.DefaultStageSettingsFromConfig(cfg, domain.FormatQualifying),
				HasPos:         true,
				PosX:           120,
				PosY:           180,
			}
			st.Stages = []domain.RaceStage{s1}
			st.StageConnections = nil
			for idx := 2; idx <= maxStageSeen; idx++ {
				sFmt := cfg.MainFormat
				if sFmt == domain.FormatQualifying {
					sFmt = domain.FormatDoubleElimination
				}
				st.Stages = append(st.Stages, domain.RaceStage{
					ID:         fmt.Sprintf("stage-%d", idx),
					Index:      idx,
					Title:      DefaultStageTitle(sFmt, idx),
					Format:     sFmt,
					Customized: isCustomTpl,
					Status:     domain.StageStatusPending,
					Settings:   domain.DefaultStageSettingsFromConfig(cfg, sFmt),
					HasPos:     true,
					PosX:       float64(120 + (idx-1)*420),
					PosY:       180,
				})
				mode := "all_pilots"
				cnt := 0
				if idx == 2 && cfg.Stage2MaxSeeds > 0 {
					mode = "top_n"
					cnt = cfg.Stage2MaxSeeds
				}
				st.StageConnections = append(st.StageConnections, domain.StageConnection{
					ID:             fmt.Sprintf("sconn-1-%d", idx),
					FromStageID:    "stage-1",
					ToStageID:      fmt.Sprintf("stage-%d", idx),
					FromStageIndex: 1,
					ToStageIndex:   idx,
					FromPort:       "right",
					ToPort:         "left",
					Mode:           mode,
					Count:          cnt,
					RankingMetric:  cfg.QualifyingMetric,
				})
			}
		}
	}

	// Normalize stage IDs, indices, titles, and settings
	stageByID := make(map[string]*domain.RaceStage, len(st.Stages))
	stageByIdx := make(map[int]*domain.RaceStage, len(st.Stages))
	for i := range st.Stages {
		s := &st.Stages[i]
		s.Index = i + 1
		if s.ID == "" {
			s.ID = fmt.Sprintf("stage-%d", s.Index)
		}
		if s.Format == "" {
			s.Format = cfg.MainFormat
		}
		if strings.TrimSpace(s.Title) == "" {
			s.Title = DefaultStageTitle(s.Format, s.Index)
		}
		s.Settings = s.Settings.Normalized(cfg, s.Format)
		if !s.HasPos {
			s.HasPos = true
			s.PosX = float64(120 + i*420)
			s.PosY = 180
		}
		stageByID[s.ID] = s
		stageByIdx[s.Index] = s
	}

	st.TotalStages = len(st.Stages)
	if st.TotalStages < 1 {
		st.TotalStages = 1
	}
	if st.ActiveStageIndex < 1 || st.ActiveStageIndex > len(st.Stages) {
		st.ActiveStageIndex = 1
	}

	// Keep legacy Stage2MaxSeeds -> sconn synced when legacy update_stage_handoff mutated Stage2MaxSeeds
	if len(st.Stages) == 2 && len(st.StageConnections) == 1 {
		sc := &st.StageConnections[0]
		if sc.FromStageIndex == 1 && sc.ToStageIndex == 2 {
			if cfg.Stage2MaxSeeds > 0 && sc.Mode == "all_pilots" {
				sc.Mode = "top_n"
				sc.Count = cfg.Stage2MaxSeeds
			}
		}
	}

	// Normalize StageConnection IDs and indices
	for i := range st.StageConnections {
		sc := &st.StageConnections[i]
		if sc.ID == "" {
			sc.ID = fmt.Sprintf("sconn-%d", i+1)
		}
		if fs := stageByID[sc.FromStageID]; fs != nil {
			sc.FromStageIndex = fs.Index
		} else if fs := stageByIdx[sc.FromStageIndex]; fs != nil {
			sc.FromStageID = fs.ID
		}
		if ts := stageByID[sc.ToStageID]; ts != nil {
			sc.ToStageIndex = ts.Index
		} else if ts := stageByIdx[sc.ToStageIndex]; ts != nil {
			sc.ToStageID = ts.ID
		}
		if sc.Mode == "" {
			if sc.SeedStart > 1 || (sc.SeedEnd > 0 && sc.SeedStart >= 1) {
				sc.Mode = "seed_range"
			} else if sc.Count > 0 {
				sc.Mode = "top_n"
			} else {
				sc.Mode = "all_pilots"
			}
		}
		if sc.FromPort != "bottom" {
			sc.FromPort = "right"
		}
		if sc.ToPort != "top" && sc.ToPort != "bottom" {
			sc.ToPort = "left"
		}
	}

	ValidateStageDAG(st)
	if NormalizeStagesTopologicalOrder(st) {
		ValidateStageDAG(st)
	}
}

// NormalizeStagesTopologicalOrder ensures `st.Stages` and their 1-based `Index` values follow
// topological execution order across valid `StageConnections` (rather than node creation order),
// remapping all stage-indexed references across stages, connections, portals, rounds, and heats.
func NormalizeStagesTopologicalOrder(st *domain.RaceTournamentState) bool {
	if st == nil || len(st.Stages) <= 1 || len(st.StageConnections) == 0 {
		return false
	}

	n := len(st.Stages)
	origPosByID := make(map[string]int, n)
	adj := make(map[string][]string, n)
	inDeg := make(map[string]int, n)
	for i := range st.Stages {
		id := st.Stages[i].ID
		origPosByID[id] = i
		inDeg[id] = 0
	}

	seenEdge := make(map[[2]string]bool, len(st.StageConnections))
	for _, sc := range st.StageConnections {
		if sc.Invalid || sc.FromStageID == "" || sc.ToStageID == "" || sc.FromStageID == sc.ToStageID {
			continue
		}
		if _, okFrom := origPosByID[sc.FromStageID]; !okFrom {
			continue
		}
		if _, okTo := origPosByID[sc.ToStageID]; !okTo {
			continue
		}
		key := [2]string{sc.FromStageID, sc.ToStageID}
		if seenEdge[key] {
			continue
		}
		seenEdge[key] = true
		adj[sc.FromStageID] = append(adj[sc.FromStageID], sc.ToStageID)
		inDeg[sc.ToStageID]++
	}

	var ready []int
	for i := range st.Stages {
		if inDeg[st.Stages[i].ID] == 0 {
			ready = append(ready, i)
		}
	}

	sortedOrigIndices := make([]int, 0, n)
	placed := make([]bool, n)
	for len(ready) > 0 {
		sort.Ints(ready)
		pickOrig := ready[0]
		ready = ready[1:]
		if placed[pickOrig] {
			continue
		}
		placed[pickOrig] = true
		sortedOrigIndices = append(sortedOrigIndices, pickOrig)
		fromID := st.Stages[pickOrig].ID
		for _, nxtID := range adj[fromID] {
			inDeg[nxtID]--
			if inDeg[nxtID] == 0 {
				ready = append(ready, origPosByID[nxtID])
			}
		}
	}
	for i := 0; i < n; i++ {
		if !placed[i] {
			sortedOrigIndices = append(sortedOrigIndices, i)
		}
	}

	changed := false
	for newPos, origPos := range sortedOrigIndices {
		if newPos != origPos {
			changed = true
			break
		}
	}
	if !changed {
		return false
	}

	reordered := make([]domain.RaceStage, n)
	idxRemap := make(map[int]int, n)
	idToNewIdx := make(map[string]int, n)
	portalRemap := make(map[string]string, n*4)
	pilotsConnPrefixRemap := make(map[string]string, n)

	for newPos, origPos := range sortedOrigIndices {
		stg := st.Stages[origPos]
		oldIdx := stg.Index
		if oldIdx <= 0 {
			oldIdx = origPos + 1
		}
		newIdx := newPos + 1
		idxRemap[oldIdx] = newIdx
		idToNewIdx[stg.ID] = newIdx
		if oldIdx != newIdx {
			portalRemap[domain.StageHandoffOutID(oldIdx)] = domain.StageHandoffOutID(newIdx)
			portalRemap[domain.StageHandoffInID(oldIdx)] = domain.StageHandoffInID(newIdx)
			portalRemap[domain.StagePilotsInID(oldIdx)] = domain.StagePilotsInID(newIdx)
			portalRemap[domain.OpenQualRoundID(oldIdx)] = domain.OpenQualRoundID(newIdx)
			pilotsConnPrefixRemap["conn-"+domain.StagePilotsInID(oldIdx)+"-"] = "conn-" + domain.StagePilotsInID(newIdx) + "-"
			if stg.Title == fmt.Sprintf("Custom Stage %d", oldIdx) {
				stg.Title = fmt.Sprintf("Custom Stage %d", newIdx)
			} else if stg.Title == fmt.Sprintf("Stage %d", oldIdx) {
				stg.Title = fmt.Sprintf("Stage %d", newIdx)
			}
		}
		stg.Index = newIdx
		reordered[newPos] = stg
	}
	st.Stages = reordered

	for i := range st.StageConnections {
		sc := &st.StageConnections[i]
		if newFrom, ok := idToNewIdx[sc.FromStageID]; ok {
			sc.FromStageIndex = newFrom
		} else if newFrom, ok := idxRemap[sc.FromStageIndex]; ok {
			sc.FromStageIndex = newFrom
		}
		if newTo, ok := idToNewIdx[sc.ToStageID]; ok {
			sc.ToStageIndex = newTo
		} else if newTo, ok := idxRemap[sc.ToStageIndex]; ok {
			sc.ToStageIndex = newTo
		}
	}

	for i := range st.Rounds {
		r := &st.Rounds[i]
		if newIdx, ok := idxRemap[r.StageIndex]; ok {
			r.StageIndex = newIdx
		}
		if mappedID, ok := portalRemap[r.ID]; ok {
			r.ID = mappedID
		}
	}

	for i := range st.Connections {
		c := &st.Connections[i]
		if newIdx, ok := idxRemap[c.StageIndex]; ok {
			c.StageIndex = newIdx
		}
		if mappedFrom, ok := portalRemap[c.FromRoundID]; ok {
			c.FromRoundID = mappedFrom
		}
		if mappedTo, ok := portalRemap[c.ToRoundID]; ok {
			c.ToRoundID = mappedTo
		}
		for oldPref, newPref := range pilotsConnPrefixRemap {
			if strings.HasPrefix(c.ID, oldPref) {
				c.ID = newPref + strings.TrimPrefix(c.ID, oldPref)
				break
			}
		}
	}

	for i := range st.Heats {
		h := &st.Heats[i]
		if newIdx, ok := idxRemap[h.StageIndex]; ok {
			h.StageIndex = newIdx
		}
		if mappedRID, ok := portalRemap[h.RoundID]; ok {
			h.RoundID = mappedRID
		}
	}
	sort.SliceStable(st.Heats, func(i, j int) bool {
		return st.Heats[i].StageIndex < st.Heats[j].StageIndex
	})
	for i := range st.Heats {
		st.Heats[i].Order = i + 1
	}

	if mappedActive, ok := idxRemap[st.ActiveStageIndex]; ok {
		st.ActiveStageIndex = mappedActive
	}
	return true
}

func canReachStage(adj map[string][]string, startID, targetID string) bool {
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

// ValidateStageDAG validates all StageConnections for self-loops, duplicates, invalid seed ranges,
// and cycles (DAG enforcement), and flags any dangling/disconnected stages when `len(Stages) > 1`.
func ValidateStageDAG(st *domain.RaceTournamentState) {
	if st == nil {
		return
	}
	st.FormatInvalidReason = ""
	if len(st.Stages) == 0 {
		return
	}

	stageByID := make(map[string]*domain.RaceStage, len(st.Stages))
	for i := range st.Stages {
		st.Stages[i].Dangling = false
		st.Stages[i].DanglingReason = ""
		stageByID[st.Stages[i].ID] = &st.Stages[i]
	}

	validAdj := make(map[string][]string)
	undirected := make(map[string][]string)
	inDeg := make(map[string]int)
	outDeg := make(map[string]int)
	seenPair := make(map[[2]string]bool)

	for i := range st.StageConnections {
		c := &st.StageConnections[i]
		c.Invalid = false
		c.InvalidReason = ""

		fromS := stageByID[c.FromStageID]
		toS := stageByID[c.ToStageID]
		if fromS == nil || toS == nil {
			c.Invalid = true
			c.InvalidReason = "Connected stage no longer exists."
			if st.FormatInvalidReason == "" {
				st.FormatInvalidReason = c.InvalidReason
			}
			continue
		}

		if c.FromStageID == c.ToStageID {
			c.Invalid = true
			c.InvalidReason = fmt.Sprintf("Cannot connect %s to itself.", fromS.Title)
			if st.FormatInvalidReason == "" {
				st.FormatInvalidReason = c.InvalidReason
			}
			continue
		}

		pk := [2]string{c.FromStageID, c.ToStageID}
		if seenPair[pk] {
			c.Invalid = true
			c.InvalidReason = fmt.Sprintf("Duplicate stage connection: %s already feeds into %s.", fromS.Title, toS.Title)
			if st.FormatInvalidReason == "" {
				st.FormatInvalidReason = c.InvalidReason
			}
			continue
		}

		if canReachStage(validAdj, c.ToStageID, c.FromStageID) {
			c.Invalid = true
			c.InvalidReason = fmt.Sprintf("Creates a stage loop: %s already feeds into %s. Stages must form a forward DAG.", toS.Title, fromS.Title)
			if st.FormatInvalidReason == "" {
				st.FormatInvalidReason = c.InvalidReason
			}
			continue
		}

		if toS.Format == domain.FormatQualifying || toS.Format == domain.FormatOpenQualifier {
			c.Invalid = true
			c.InvalidReason = fmt.Sprintf("%s is a starting qualifier stage and does not accept upstream stage inputs.", toS.Title)
			if st.FormatInvalidReason == "" {
				st.FormatInvalidReason = c.InvalidReason
			}
			continue
		}

		if c.Mode == "seed_range" && c.SeedEnd > 0 && c.SeedStart > c.SeedEnd {
			c.Invalid = true
			c.InvalidReason = fmt.Sprintf("Invalid seed range: start seed (#%d) is greater than end seed (#%d).", c.SeedStart, c.SeedEnd)
			if st.FormatInvalidReason == "" {
				st.FormatInvalidReason = c.InvalidReason
			}
			continue
		}

		if c.Mode == "top_n" && c.Count < 1 {
			c.Count = 8
		}

		seenPair[pk] = true
		validAdj[c.FromStageID] = append(validAdj[c.FromStageID], c.ToStageID)
		undirected[c.FromStageID] = append(undirected[c.FromStageID], c.ToStageID)
		undirected[c.ToStageID] = append(undirected[c.ToStageID], c.FromStageID)
		outDeg[c.FromStageID]++
		inDeg[c.ToStageID]++
	}

	if len(st.Stages) <= 1 {
		return
	}

	// Check connected component anchored at Stage 1 (or the first stage with connections)
	anchorID := st.Stages[0].ID
	for _, s := range st.Stages {
		if inDeg[s.ID]+outDeg[s.ID] > 0 {
			anchorID = s.ID
			break
		}
	}
	reachableUndir := make(map[string]bool)
	uQueue := []string{anchorID}
	for len(uQueue) > 0 {
		cur := uQueue[0]
		uQueue = uQueue[1:]
		if reachableUndir[cur] {
			continue
		}
		reachableUndir[cur] = true
		uQueue = append(uQueue, undirected[cur]...)
	}

	for i := range st.Stages {
		s := &st.Stages[i]
		if inDeg[s.ID] == 0 && outDeg[s.ID] == 0 {
			s.Dangling = true
			s.DanglingReason = fmt.Sprintf("%s is disconnected — connect it into the stage DAG or remove it.", s.Title)
		} else if !reachableUndir[s.ID] {
			s.Dangling = true
			s.DanglingReason = fmt.Sprintf("%s is disconnected from the main stage flow — connect all stages into one DAG.", s.Title)
		}
		if s.Dangling && st.FormatInvalidReason == "" {
			st.FormatInvalidReason = s.DanglingReason
		}
	}
}

// IncomingStageConnections returns all valid incoming StageConnections into `stageIdx`, sorted by `FromStageIndex`.
func IncomingStageConnections(st *domain.RaceTournamentState, stageIdx int) []domain.StageConnection {
	if st == nil {
		return nil
	}
	var out []domain.StageConnection
	for _, c := range st.StageConnections {
		if !c.Invalid && c.ToStageIndex == stageIdx {
			out = append(out, c)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].FromStageIndex < out[j].FromStageIndex
	})
	return out
}

// OutgoingStageConnections returns all valid outgoing StageConnections from `stageIdx`, sorted by `ToStageIndex`.
func OutgoingStageConnections(st *domain.RaceTournamentState, stageIdx int) []domain.StageConnection {
	if st == nil {
		return nil
	}
	var out []domain.StageConnection
	for _, c := range st.StageConnections {
		if !c.Invalid && c.FromStageIndex == stageIdx {
			out = append(out, c)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].ToStageIndex < out[j].ToStageIndex
	})
	return out
}

// TopologicalStageIndices returns 1-based stage indices in valid DAG topological order.
func TopologicalStageIndices(st *domain.RaceTournamentState) []int {
	if st == nil || len(st.Stages) == 0 {
		return nil
	}
	inDeg := make(map[int]int, len(st.Stages))
	adj := make(map[int][]int, len(st.Stages))
	for _, s := range st.Stages {
		inDeg[s.Index] = 0
	}
	for _, c := range st.StageConnections {
		if c.Invalid || c.FromStageIndex <= 0 || c.ToStageIndex <= 0 {
			continue
		}
		adj[c.FromStageIndex] = append(adj[c.FromStageIndex], c.ToStageIndex)
		inDeg[c.ToStageIndex]++
	}
	var ready []int
	for _, s := range st.Stages {
		if inDeg[s.Index] == 0 {
			ready = append(ready, s.Index)
		}
	}
	sort.Ints(ready)

	var order []int
	seen := make(map[int]bool, len(st.Stages))
	for len(ready) > 0 {
		cur := ready[0]
		ready = ready[1:]
		if seen[cur] {
			continue
		}
		seen[cur] = true
		order = append(order, cur)
		for _, nxt := range adj[cur] {
			inDeg[nxt]--
			if inDeg[nxt] == 0 {
				ready = append(ready, nxt)
			}
		}
		sort.Ints(ready)
	}
	for _, s := range st.Stages {
		if !seen[s.Index] {
			order = append(order, s.Index)
		}
	}
	return order
}

// StageExpectedIncomingSeeds estimates how many seeds will enter `stageIdx` based on its incoming
// `StageConnections` (or `rosterSize` when `stageIdx` is a root stage).
func StageExpectedIncomingSeeds(st *domain.RaceTournamentState, stageIdx int, rosterSize int) int {
	if rosterSize < 2 {
		rosterSize = 4
	}
	inConns := IncomingStageConnections(st, stageIdx)
	if len(inConns) == 0 {
		return rosterSize
	}
	total := 0
	for _, c := range inConns {
		upstreamCap := StageExpectedIncomingSeeds(st, c.FromStageIndex, rosterSize)
		switch c.Mode {
		case "top_n":
			cnt := c.Count
			if cnt < 1 {
				cnt = upstreamCap
			}
			if cnt > upstreamCap {
				cnt = upstreamCap
			}
			total += cnt
		case "seed_range":
			start := c.SeedStart
			if start < 1 {
				start = 1
			}
			end := c.SeedEnd
			if end <= 0 || end > upstreamCap {
				end = upstreamCap
			}
			if end >= start {
				total += end - start + 1
			}
		default: // "all_pilots"
			cnt := upstreamCap
			if len(st.Stages) == 2 && stageIdx == 2 && st.Config.Stage2MaxSeeds > 0 && st.Config.Stage2MaxSeeds < cnt {
				cnt = st.Config.Stage2MaxSeeds
			}
			total += cnt
		}
	}
	if total < 2 {
		total = 2
	}
	if total > 64 {
		total = 64
	}
	return total
}

// GenerateStageHeats builds the initial heats & bracket edges for a single `RaceStage`.
// For `FormatCustom`, it returns empty slices so the stage starts with only its incoming Pilots/Seeds node.
func GenerateStageHeats(
	stage domain.RaceStage,
	baseCfg domain.RaceSetupConfig,
	rootPilots []domain.PilotSlot,
	hasUpstreamStages bool,
	placeholderSeedCount int,
	orderOffset int,
	existingHeatIDs map[string]bool,
	rngSeed int64,
) ([]domain.RaceHeat, []domain.BracketEdge) {
	if stage.Format == domain.FormatCustom || stage.Format == domain.FormatOpenQualifier {
		return nil, nil
	}
	stageCfg := stage.Settings.ToRaceSetupConfig(baseCfg, stage.Format)

	var seeded []seededPilot
	if hasUpstreamStages {
		if placeholderSeedCount < 2 {
			placeholderSeedCount = 4
		}
		seeded = make([]seededPilot, placeholderSeedCount)
		for i := 0; i < placeholderSeedCount; i++ {
			seeded[i] = seededPilot{seed: i + 1}
		}
	} else {
		if len(rootPilots) >= 2 {
			seeded = buildInitialSeeding(rootPilots, stageCfg.Seeding, rngSeed)
		} else {
			cnt := placeholderSeedCount
			if cnt < 2 {
				cnt = 4
			}
			seeded = make([]seededPilot, cnt)
			for i := 0; i < cnt; i++ {
				seeded[i] = seededPilot{seed: i + 1}
			}
		}
	}

	heats, edges := generateMainStage(stageCfg, seeded, stage.Index, orderOffset, nil)
	for i := range heats {
		if stage.Title != "" {
			heats[i].StageName = stage.Title
		}
		for _, s := range heats[i].Seats {
			if s.Feeder != nil && s.Feeder.FromStageSeed > 0 {
				heats[i].State = domain.HeatWaiting
				break
			}
		}
	}

	needsPrefix := stage.Index >= 3
	if !needsPrefix && existingHeatIDs != nil {
		for _, h := range heats {
			if existingHeatIDs[h.ID] {
				needsPrefix = true
				break
			}
		}
	}
	if needsPrefix {
		heats, edges = PrefixStageHeats(heats, edges, fmt.Sprintf("S%d-", stage.Index))
	}
	return heats, edges
}

// PrefixStageHeats prefixes all heat IDs, short labels, internal feeder heat references, and bracket edges
// in `heats`/`edges` so multiple stages of the same format never collide on Heat.ID.
func PrefixStageHeats(heats []domain.RaceHeat, edges []domain.BracketEdge, prefix string) ([]domain.RaceHeat, []domain.BracketEdge) {
	if prefix == "" || len(heats) == 0 {
		return heats, edges
	}
	remap := make(map[string]string, len(heats))
	for i := range heats {
		oldID := heats[i].ID
		if !strings.HasPrefix(oldID, prefix) {
			newID := prefix + oldID
			remap[oldID] = newID
			heats[i].ID = newID
			if heats[i].ShortLabel == oldID || heats[i].ShortLabel == "" {
				heats[i].ShortLabel = newID
			}
		}
	}
	for i := range heats {
		for si := range heats[i].Seats {
			s := &heats[i].Seats[si]
			if s.Feeder != nil && s.Feeder.FromHeatID != "" {
				if mapped, ok := remap[s.Feeder.FromHeatID]; ok {
					oldRef := s.Feeder.FromHeatID
					s.Feeder.FromHeatID = mapped
					if s.SourceLabel != "" && strings.Contains(s.SourceLabel, oldRef) {
						s.SourceLabel = strings.ReplaceAll(s.SourceLabel, oldRef, mapped)
					}
				}
			}
		}
	}
	for i := range edges {
		if mapped, ok := remap[edges[i].FromHeatID]; ok {
			edges[i].FromHeatID = mapped
		}
		if mapped, ok := remap[edges[i].ToHeatID]; ok {
			edges[i].ToHeatID = mapped
		}
	}
	return heats, edges
}

// IsAutoStageTitle reports whether `title` is a system-generated default stage title
// (including numbered duplicates such as `"Qualifying 2"` or `"Open Qualifier 2"`)
// that should automatically track dynamic stage-format classification.
func IsAutoStageTitle(title string, stageIdx int) bool {
	t := strings.TrimSpace(title)
	if t == "" {
		return true
	}
	autoBases := []string{
		"Qualifying", "Qualifier", "Open Qualifier", "ZippyQ", "ZippyQ Qualifier",
		"Single Elimination", "Double Elimination", "Points Mains", "Chase the Ace",
		"Custom", "Custom Stage", "Stage",
	}
	for _, base := range autoBases {
		if strings.EqualFold(t, base) {
			return true
		}
		prefix := strings.ToLower(base) + " "
		if strings.HasPrefix(strings.ToLower(t), prefix) {
			rest := strings.TrimSpace(t[len(prefix):])
			allDigits := len(rest) > 0
			for _, ch := range rest {
				if ch < '0' || ch > '9' {
					allDigits = false
					break
				}
			}
			if allDigits {
				return true
			}
		}
	}
	return false
}

func uniqueAutoStageTitle(stages []domain.RaceStage, selfIdx int, baseTitle string) string {
	if strings.HasPrefix(baseTitle, "Custom Stage ") || strings.HasPrefix(baseTitle, "Stage ") {
		return baseTitle
	}
	sameCount := 0
	for _, other := range stages {
		if other.Index >= selfIdx {
			continue
		}
		if strings.EqualFold(other.Title, baseTitle) || strings.HasPrefix(strings.ToLower(other.Title), strings.ToLower(baseTitle)+" ") {
			sameCount++
		}
	}
	if sameCount > 0 {
		return fmt.Sprintf("%s %d", baseTitle, sameCount+1)
	}
	return baseTitle
}

// ReconcileStagesFromRoundContents dynamically classifies each customized/custom stage's `Format`,
// auto-generated `Title`, and round-count settings from the actual non-portal rounds currently inside it.
func ReconcileStagesFromRoundContents(st *domain.RaceTournamentState, rounds []domain.RaceRound) {
	if st == nil || len(st.Stages) == 0 {
		return
	}
	changed := false
	for si := range st.Stages {
		s := &st.Stages[si]
		if !s.Customized && s.Format != domain.FormatCustom {
			continue
		}

		var stageRounds []domain.RaceRound
		for _, r := range rounds {
			if r.StageIndex == s.Index && !domain.IsStagePortalRoundID(r.ID) {
				stageRounds = append(stageRounds, r)
			}
		}

		hasIncomingStage := false
		for _, sc := range st.StageConnections {
			if !sc.Invalid && sc.ToStageIndex == s.Index {
				hasIncomingStage = true
				break
			}
		}

		total := len(stageRounds)
		inferredFmt := domain.FormatCustom
		inferredTitle := DefaultStageTitle(domain.FormatCustom, s.Index)

		if total > 0 {
			zippyCount := 0
			openQualCount := 0
			qualCount := 0
			pointsCount := 0
			ctaCount := 0
			winnersCount := 0
			losersCount := 0
			finalsCount := 0

			for _, r := range stageRounds {
				isOQ := r.StageFormat == domain.FormatOpenQualifier || domain.IsOpenQualRoundID(r.ID)
				isZippy := isOQ && (strings.Contains(strings.ToLower(r.Title), "zippyq") ||
					(st.MGPLink != nil && st.MGPLink.IsZippyQ && s.Index == 1))
				if isZippy {
					zippyCount++
					continue
				}
				if isOQ {
					openQualCount++
					continue
				}
				if r.StageFormat == domain.FormatQualifying {
					qualCount++
					continue
				}
				if r.StageFormat == domain.FormatPointsMains {
					pointsCount++
					continue
				}
				if r.StageFormat == domain.FormatChaseTheAce || (r.BracketLane == "finals" && r.FinalsFormat == domain.FinalsChaseTheAce) {
					ctaCount++
				}
				switch r.BracketLane {
				case "losers":
					losersCount++
				case "finals":
					finalsCount++
				default:
					winnersCount++
				}
			}
			bracketCount := winnersCount + losersCount + finalsCount

			switch {
			case !hasIncomingStage && zippyCount == total && (total == 1 || (st.MGPLink != nil && st.MGPLink.IsZippyQ && s.Index == 1)):
				inferredFmt = domain.FormatOpenQualifier
				inferredTitle = "ZippyQ Qualifier"
			case !hasIncomingStage && openQualCount == 1 && total == 1:
				inferredFmt = domain.FormatOpenQualifier
				inferredTitle = "Open Qualifier"
			case !hasIncomingStage && qualCount == total:
				inferredFmt = domain.FormatQualifying
				if strings.EqualFold(strings.TrimSpace(s.Title), "Qualifier") {
					inferredTitle = "Qualifier"
				} else {
					inferredTitle = "Qualifying"
				}
				s.Settings.QualifyingRounds = total
			case total == 1 && ctaCount == 1:
				inferredFmt = domain.FormatChaseTheAce
				inferredTitle = "Chase the Ace"
			case pointsCount == total || (total == 1 && finalsCount == 1 && stageRounds[0].FinalsFormat == domain.FinalsPoints):
				inferredFmt = domain.FormatPointsMains
				inferredTitle = "Points Mains"
				if pointsCount > 0 {
					s.Settings.PointsRounds = pointsCount
				}
			case bracketCount == total && winnersCount >= 1 && losersCount >= 1:
				inferredFmt = domain.FormatDoubleElimination
				inferredTitle = "Double Elimination"
			case bracketCount == total && losersCount == 0 && (winnersCount >= 1 || (total == 1 && finalsCount == 1)):
				inferredFmt = domain.FormatSingleElimination
				inferredTitle = "Single Elimination"
			default:
				inferredFmt = domain.FormatCustom
				inferredTitle = DefaultStageTitle(domain.FormatCustom, s.Index)
			}
		}

		if s.Format != inferredFmt {
			s.Format = inferredFmt
			changed = true
		}
		if IsAutoStageTitle(s.Title, s.Index) {
			targetTitle := uniqueAutoStageTitle(st.Stages, s.Index, inferredTitle)
			if s.Title != targetTitle {
				s.Title = targetTitle
				changed = true
			}
		}
		if len(st.Stages) == 1 && s.Index == 1 {
			if inferredFmt != domain.FormatCustom {
				st.Config.MainFormat = inferredFmt
			}
			if inferredFmt == domain.FormatQualifying && s.Settings.QualifyingRounds > 0 {
				st.Config.QualifyingRounds = s.Settings.QualifyingRounds
			}
		}
	}
	if changed {
		EnsureStagesMetadata(st)
	}
}
