package race

import (
	"fmt"
	"math"
	"math/rand"
	"sort"
	"strings"

	"slaprf/internal/domain"
)

type seededPilot struct {
	slot domain.PilotSlot
	seed int
}

// GenerateTournament builds a fresh tournament from `cfg` and the event `roster`.
func GenerateTournament(cfg domain.RaceSetupConfig, roster []domain.PilotSlot, rngSeed int64) domain.RaceTournamentState {
	cfg = cfg.Normalized()
	totalStages := 1
	if cfg.Structure == domain.StructureTwoStage {
		totalStages = 2
	}

	st := domain.RaceTournamentState{
		Lifecycle:        domain.LifecycleDraft,
		Mode:             domain.ModeRace,
		Config:           cfg,
		Generated:        len(roster) >= 2,
		ActiveStageIndex: 1,
		TotalStages:      totalStages,
		Heats:            []domain.RaceHeat{},
		Edges:            []domain.BracketEdge{},
		Standings:        []domain.TournamentStanding{},
	}
	if len(roster) < 2 {
		return st
	}

	seeded := buildInitialSeeding(roster, cfg.Seeding, rngSeed)
	if cfg.Structure == domain.StructureTwoStage {
		qualHeats := generateQualifyingHeats(cfg, seeded, 1, 0)
		s2Heats, s2Edges := GenerateStage2PlaceholderMainStage(cfg, len(seeded), len(qualHeats))
		st.Heats = append(qualHeats, s2Heats...)
		st.Edges = s2Edges
	} else {
		heats, edges := generateMainStage(cfg, seeded, 1, 0, nil)
		st.Heats = heats
		st.Edges = edges
	}

	ResolveTournament(&st, roster)
	if st.ActiveHeatID == "" && st.NextReadyHeatID != "" {
		st.ActiveHeatID = st.NextReadyHeatID
	}
	return st
}

// GenerateUnifiedTournament builds a single-graph tournament (`StageIndex = 1`, `TotalStages = 1`)
// for any SlapRF template, wiring multi-phase templates (`qual_double_elim`, `qual_single_elim`,
// `qual_mains`, `cpq_mains`, `qual_chase_the_ace`, and RotorHazard-style `qual_ladder_mains` / `ladder_mains`)
// onto one unified round graph with direct `RoundConnection` wires and zero cross-stage portals.
func GenerateUnifiedTournament(
	cfg domain.RaceSetupConfig,
	roster []domain.PilotSlot,
	templateID string,
	rngSeed int64,
) domain.RaceTournamentState {
	cfg = cfg.Normalized()
	tpl := templateID

	// Even when < 2 pilots are checked in yet, synthesize placeholder roster slots for non-OQ templates
	// so the full round graph and downstream placeholders (Q1 -> W1 -> R1 -> Finals) populate immediately!
	genRoster := roster
	synthesizedPlaceholders := false
	if len(genRoster) < 2 && cfg.MainFormat != domain.FormatOpenQualifier && tpl != "open_qualifier" {
		synthesizedPlaceholders = true
		targetPlaceholderCnt := cfg.PilotsPerHeat * 2
		if cfg.MainFormat == domain.FormatQualifying || cfg.MainFormat == domain.FormatChaseTheAce || tpl == "round_robin" || tpl == "chase_the_ace" {
			targetPlaceholderCnt = cfg.PilotsPerHeat
		}
		if targetPlaceholderCnt < 4 {
			targetPlaceholderCnt = 4
		}
		genRoster = make([]domain.PilotSlot, targetPlaceholderCnt)
		copy(genRoster, roster)
	}

	stripSynthesizedRootSeats := func(st *domain.RaceTournamentState) {
		if !synthesizedPlaceholders {
			return
		}
		realSlots := make(map[int]bool, len(roster))
		for _, rp := range roster {
			if rp.SlotIndex > 0 {
				realSlots[rp.SlotIndex] = true
			}
		}
		for hi := range st.Heats {
			h := &st.Heats[hi]
			hasReal := false
			hasDownstreamFeeder := false
			for si := range h.Seats {
				s := &h.Seats[si]
				if s.Feeder != nil && s.Feeder.FromStageSeed > 0 && s.Feeder.FromRoundID == "" && s.Feeder.FromHeatID == "" && s.Feeder.FromRoundColumn == 0 {
					// Root placeholder seat: show Seed #k without stage-seed BYE collapse
					seedNum := s.Feeder.FromStageSeed
					s.Feeder = nil
					s.SourceLabel = fmt.Sprintf("Seed #%d", seedNum)
				} else if s.Feeder != nil {
					hasDownstreamFeeder = true
				}
				if s.PilotSlotIndex > 0 && !realSlots[s.PilotSlotIndex] {
					s.PilotSlotIndex = 0
					s.Callsign = ""
					s.PhoneticName = ""
					s.Color = ""
					if s.Seed > 0 {
						s.SourceLabel = fmt.Sprintf("Seed #%d", s.Seed)
					}
				}
				if s.PilotSlotIndex > 0 {
					hasReal = true
				}
			}
			if !hasReal && !hasDownstreamFeeder {
				h.State = domain.HeatWaiting
			}
		}
	}

	if tpl == "qual_ladder_mains" || tpl == "ladder_mains" {
		st := generateLadderMainsTournament(cfg, genRoster, tpl == "qual_ladder_mains", tpl, rngSeed)
		stripSynthesizedRootSeats(&st)
		ResolveTournament(&st, roster)
		return st
	}

	isTwoPhase := cfg.Structure == domain.StructureTwoStage ||
		tpl == "qual_double_elim" ||
		tpl == "qual_single_elim" ||
		tpl == "qual_mains" ||
		tpl == "cpq_mains" ||
		tpl == "qual_chase_the_ace"

	if isTwoPhase {
		twoCfg := cfg
		twoCfg.Structure = domain.StructureTwoStage
		st := GenerateTournament(twoCfg, genRoster, rngSeed)
		st.TemplateID = tpl
		MigrateLegacyStagesToUnifiedGraph(&st)
		st.TemplateID = tpl
		stripSynthesizedRootSeats(&st)
		ResolveTournament(&st, roster)
		if st.ActiveHeatID == "" && st.NextReadyHeatID != "" {
			st.ActiveHeatID = st.NextReadyHeatID
		}
		return st
	}

	cfg.Structure = domain.StructureSingleStage
	st := GenerateTournament(cfg, genRoster, rngSeed)
	st.TemplateID = tpl
	stripSynthesizedRootSeats(&st)
	if cfg.MainFormat == domain.FormatOpenQualifier && len(roster) < 2 {
		st.Generated = true
		EnsureStagesMetadata(&st)
		SyncRoundsMetadata(&st)
	} else if synthesizedPlaceholders {
		EnsureStagesMetadata(&st)
		SyncRoundsMetadata(&st)
		ResolveTournament(&st, roster)
	}
	return st
}

func generateLadderMainsTournament(
	cfg domain.RaceSetupConfig,
	roster []domain.PilotSlot,
	withQualifying bool,
	templateID string,
	rngSeed int64,
) domain.RaceTournamentState {
	cfg = cfg.Normalized()
	cfg.Structure = domain.StructureSingleStage
	st := domain.RaceTournamentState{
		TemplateID:       templateID,
		Lifecycle:        domain.LifecycleDraft,
		Mode:             domain.ModeRace,
		Config:           cfg,
		Generated:        len(roster) >= 2,
		ActiveStageIndex: 1,
		TotalStages:      1,
		Heats:            []domain.RaceHeat{},
		Edges:            []domain.BracketEdge{},
		Rounds:           []domain.RaceRound{},
		Connections:      []domain.RoundConnection{},
		Standings:        []domain.TournamentStanding{},
	}
	if len(roster) < 2 {
		return st
	}

	seeded := buildInitialSeeding(roster, cfg.Seeding, rngSeed)
	k := cfg.PilotsPerHeat
	if k < 2 {
		k = 4
	}
	seatChannels := cfg.SeatChannels
	if len(seatChannels) < k {
		seatChannels = domain.DefaultSeatChannels(k)
	}

	qRounds := 0
	lastQualRoundID := ""
	if withQualifying {
		qRounds = cfg.QualifyingRounds
		if qRounds < 1 {
			qRounds = 2
		}
		qualHeats := generateQualifyingHeats(cfg, seeded, 1, 0)
		for rNum := 1; rNum <= qRounds; rNum++ {
			rid := fmt.Sprintf("s1-c%d-qualifying", rNum)
			st.Rounds = append(st.Rounds, domain.RaceRound{
				ID:               rid,
				StageIndex:       1,
				Round:            rNum,
				Column:           rNum,
				BracketLane:      "qualifying",
				Title:            fmt.Sprintf("Qualifying R%d", rNum),
				StageFormat:      domain.FormatQualifying,
				StartMode:        domain.StartModeStaggered,
				TargetLaps:       cfg.QualifyingTargetLaps,
				TimeLimitSec:     cfg.QualifyingTimeLimitSec,
				QualifyingMetric: cfg.QualifyingMetric,
				SeedSource:       map[bool]string{true: "all_active_pilots"}[rNum == 1],
			})
			if rNum > 1 {
				prevID := fmt.Sprintf("s1-c%d-qualifying", rNum-1)
				st.Connections = append(st.Connections, domain.RoundConnection{
					ID:          fmt.Sprintf("conn-%s-%s-all_pilots", prevID, rid),
					StageIndex:  1,
					FromRoundID: prevID,
					ToRoundID:   rid,
					FromPort:    "right",
					ToPort:      "left",
					Mode:        "all_pilots",
				})
			}
			lastQualRoundID = rid
		}
		for i := range qualHeats {
			qualHeats[i].RoundID = fmt.Sprintf("s1-c%d-qualifying", qualHeats[i].Round)
		}
		st.Heats = append(st.Heats, qualHeats...)
	}

	effN := len(seeded)
	if cfg.Stage2MaxSeeds > 0 && cfg.Stage2MaxSeeds < effN {
		effN = cfg.Stage2MaxSeeds
	}
	if effN < 2 {
		effN = 2
	}

	adv := k / 2
	if adv < 1 {
		adv = 1
	}
	step := k - adv
	if step < 1 {
		step = 1
	}

	type ladderSlice struct {
		sStart int
		sEnd   int
	}
	numMains := 1
	if effN > k {
		numMains = 1 + (effN-k+step-1)/step
		if numMains > 8 {
			numMains = 8
		}
	}
	slices := make([]ladderSlice, numMains)
	if numMains == 1 {
		slices[0] = ladderSlice{sStart: 1, sEnd: effN}
	} else {
		curRank := 1
		for mIdx := 0; mIdx < numMains-1; mIdx++ {
			sEnd := curRank + step - 1
			if sEnd > effN {
				sEnd = effN
			}
			slices[mIdx] = ladderSlice{sStart: curRank, sEnd: sEnd}
			curRank = sEnd + 1
		}
		if curRank > effN {
			curRank = effN
		}
		slices[numMains-1] = ladderSlice{sStart: curRank, sEnd: effN}
	}

	lastCh := make(map[int]uint8)
	for _, sp := range seeded {
		if code := domain.EncodeBandChannel(sp.slot.Band, sp.slot.Channel); code > 0 {
			lastCh[sp.slot.SlotIndex] = code
		}
	}

	order := len(st.Heats)
	prevMainHeatID := ""
	prevMainRoundID := ""
	prevMainTitle := ""
	prevMainAdv := 0

	// Generate from lowest main (e.g. C-Main) up to A-Main so execution order & columns flow left-to-right!
	for execIdx := 0; execIdx < numMains; execIdx++ {
		mIdx := numMains - 1 - execIdx
		letter := string(rune('A' + mIdx))
		roundTitle := fmt.Sprintf("%s-Main", letter)
		col := qRounds + 1 + execIdx
		roundNum := qRounds + 1 + execIdx
		lane := "winners"
		if mIdx == 0 {
			lane = "finals"
		}
		roundID := fmt.Sprintf("s1-c%d-%s-main", col, strings.ToLower(letter))
		heatID := fmt.Sprintf("%s1-1", letter)
		if mIdx == 0 && cfg.FinalsFormat == domain.FinalsChaseTheAce {
			heatID = "CTA-1"
		}

		sl := slices[mIdx]
		seedSliceCount := 0
		if sl.sEnd >= sl.sStart {
			seedSliceCount = sl.sEnd - sl.sStart + 1
		}
		bumpCount := 0
		if execIdx > 0 {
			bumpCount = prevMainAdv
		}
		totalEntrants := seedSliceCount + bumpCount
		expWin := EffectiveAdvance(adv, totalEntrants)
		if mIdx == 0 {
			expWin = 1
		}

		var seats []domain.HeatSeat
		if withQualifying {
			var feeders []domain.SeatFeeder
			var labels []string
			for rnk := sl.sStart; rnk <= sl.sEnd; rnk++ {
				feeders = append(feeders, domain.SeatFeeder{
					FromRoundID:       lastQualRoundID,
					FromRoundColumn:   qRounds,
					FromStandingsRank: rnk,
					RankingMetric:     cfg.QualifyingMetric,
				})
				labels = append(labels, fmt.Sprintf("Seed #%d", rnk))
			}
			for b := 1; b <= bumpCount; b++ {
				feeders = append(feeders, domain.SeatFeeder{
					FromHeatID: prevMainHeatID,
					FromRank:   b,
				})
				labels = append(labels, fmt.Sprintf("%s · %s", Ordinal(b), prevMainTitle))
			}
			seats = buildFeederSeats(feeders, seatChannels)
			for si := range labels {
				if si < len(seats) {
					seats[si].SourceLabel = labels[si]
				}
			}
		} else {
			var knownGroup []seededPilot
			for rnk := sl.sStart; rnk <= sl.sEnd && rnk <= len(seeded); rnk++ {
				knownGroup = append(knownGroup, seeded[rnk-1])
			}
			seats = buildKnownSeats(knownGroup, seatChannels, lastCh, func(sp seededPilot) string {
				return fmt.Sprintf("Seed #%d", sp.seed)
			})
			for b := 1; b <= bumpCount; b++ {
				si := len(knownGroup) + b - 1
				if si < len(seats) {
					fc := domain.SeatFeeder{FromHeatID: prevMainHeatID, FromRank: b}
					seats[si].Feeder = &fc
					seats[si].SourceLabel = fmt.Sprintf("%s · %s", Ordinal(b), prevMainTitle)
				}
			}
		}

		heatState := domain.HeatWaiting
		if !withQualifying && execIdx == 0 {
			heatState = domain.HeatReady
		}
		hTitle := roundTitle
		stageFmt := domain.FormatSingleElimination
		if mIdx == 0 && cfg.FinalsFormat == domain.FinalsChaseTheAce {
			stageFmt = domain.FormatChaseTheAce
			hTitle = fmt.Sprintf("%s · Heat 1 (First to %d Wins)", roundTitle, cfg.AceWinsRequired)
		}

		order++
		h := domain.RaceHeat{
			ID:              heatID,
			RoundID:         roundID,
			StageIndex:      1,
			StageName:       roundTitle,
			StageFormat:     stageFmt,
			Round:           roundNum,
			Column:          col,
			Order:           order,
			BracketLane:     lane,
			Division:        letter,
			Title:           hTitle,
			ShortLabel:      heatID,
			StartMode:       domain.StartModeHeadsUp,
			TargetLaps:      cfg.TargetLaps,
			TimeLimitSec:    cfg.TimeLimitSec,
			ExpectedWinners: expWin,
			State:           heatState,
			Seats:           seats,
		}
		RecomputeHeat(&h, cfg.QualifyingMetric)
		st.Heats = append(st.Heats, h)

		rnd := domain.RaceRound{
			ID:           roundID,
			StageIndex:   1,
			Round:        roundNum,
			Column:       col,
			BracketLane:  lane,
			Title:        roundTitle,
			StageFormat:  stageFmt,
			StartMode:    domain.StartModeHeadsUp,
			TargetLaps:   cfg.TargetLaps,
			TimeLimitSec: cfg.TimeLimitSec,
			TargetHeats:  1,
		}
		if !withQualifying {
			rnd.SeedSource = "all_active_pilots"
			rnd.SeedDistribution = "sequential"
		}
		if mIdx == 0 {
			fFmt := cfg.FinalsFormat
			if fFmt == "" {
				fFmt = domain.FinalsSingle
			}
			rnd.FinalsFormat = fFmt
			rnd.AceWinsRequired = cfg.AceWinsRequired
			if rnd.AceWinsRequired < 2 {
				rnd.AceWinsRequired = 2
			}
			rnd.WinnersAdvantageAce = cfg.WinnersAdvantageAce
		}
		st.Rounds = append(st.Rounds, rnd)

		if withQualifying && lastQualRoundID != "" && seedSliceCount > 0 {
			st.Connections = append(st.Connections, domain.RoundConnection{
				ID:            fmt.Sprintf("conn-%s-%s-standings_top", lastQualRoundID, roundID),
				StageIndex:    1,
				FromRoundID:   lastQualRoundID,
				ToRoundID:     roundID,
				FromPort:      "right",
				ToPort:        "left",
				Mode:          "standings_top",
				Count:         seedSliceCount,
				CustomCount:   true,
				SeedStart:     sl.sStart,
				SeedEnd:       sl.sEnd,
				Distribution:  "sequential",
				RankingMetric: cfg.QualifyingMetric,
			})
		}
		if execIdx > 0 && prevMainRoundID != "" && bumpCount > 0 {
			st.Connections = append(st.Connections, domain.RoundConnection{
				ID:          fmt.Sprintf("conn-%s-%s-top_per_heat", prevMainRoundID, roundID),
				StageIndex:  1,
				FromRoundID: prevMainRoundID,
				ToRoundID:   roundID,
				FromPort:    "right",
				ToPort:      "left",
				Mode:        "top_per_heat",
				Count:       bumpCount,
				CustomCount: true,
			})
		}

		prevMainHeatID = heatID
		prevMainRoundID = roundID
		prevMainTitle = roundTitle
		prevMainAdv = expWin
	}

	st.Stages = []domain.RaceStage{
		{
			ID:         "stage-1",
			Index:      1,
			Title:      "Ladder Mains",
			Format:     domain.FormatCustom,
			Customized: false,
			Status:     domain.StageStatusActive,
			Settings:   domain.DefaultStageSettingsFromConfig(cfg, domain.FormatSingleElimination),
			HasPos:     true,
			PosX:       120,
			PosY:       180,
		},
	}

	RebuildEdgesFromFeeders(&st)
	ResolveTournament(&st, roster)
	if st.ActiveHeatID == "" && st.NextReadyHeatID != "" {
		st.ActiveHeatID = st.NextReadyHeatID
	}
	return st
}

// GenerateStage2PlaceholderMainStage pre-builds Stage 2 heats and bracket edges with
// `FromStageSeed` placeholders ("Seed #1", "Seed #2", ...) so Stage 2 can be viewed,
// wired, and customized before Stage 1 Qualifying completes.
func GenerateStage2PlaceholderMainStage(
	cfg domain.RaceSetupConfig,
	seedCount int,
	orderOffset int,
) ([]domain.RaceHeat, []domain.BracketEdge) {
	cfg = cfg.Normalized()
	if cfg.Stage2MaxSeeds > 0 && cfg.Stage2MaxSeeds < seedCount {
		seedCount = cfg.Stage2MaxSeeds
	}
	if seedCount < 2 {
		return nil, nil
	}
	placeholders := make([]seededPilot, seedCount)
	for i := 0; i < seedCount; i++ {
		placeholders[i] = seededPilot{seed: i + 1}
	}
	heats, edges := generateMainStage(cfg, placeholders, 2, orderOffset, nil)
	for i := range heats {
		for _, s := range heats[i].Seats {
			if s.Feeder != nil && s.Feeder.FromStageSeed > 0 {
				heats[i].State = domain.HeatWaiting
				break
			}
		}
	}
	return heats, edges
}

// GenerateStage2Mains populates Stage 2 (Bracket / Mains) seeded by Stage 1 Qualifying results
// (including early seeding when Stage 1 ends early after at least 1 confirmed Qualifying heat).
func GenerateStage2Mains(st *domain.RaceTournamentState, roster []domain.PilotSlot) bool {
	if st == nil || st.TotalStages < 2 {
		return false
	}
	hasConfirmedStage1 := false
	hasStage2Heats := false
	for _, h := range st.Heats {
		if h.StageIndex == 1 && h.State == domain.HeatConfirmed {
			hasConfirmedStage1 = true
		}
		if h.StageIndex == 2 {
			hasStage2Heats = true
		}
	}
	if !hasConfirmedStage1 {
		return false
	}
	if !hasStage2Heats {
		seedCount := len(roster)
		if seedCount < 2 {
			qualStandings := ComputeQualifyingStandings(st, roster)
			seedCount = len(qualStandings)
		}
		if seedCount < 2 {
			return false
		}
		s2Heats, s2Edges := GenerateStage2PlaceholderMainStage(st.Config, seedCount, len(st.Heats))
		st.Heats = append(st.Heats, s2Heats...)
		st.Edges = append(st.Edges, s2Edges...)
	}
	st.Stage2SeededEarly = true
	ResolveTournament(st, roster)
	if st.NextReadyHeatID != "" {
		st.ActiveHeatID = st.NextReadyHeatID
	}
	return st.ActiveStageIndex == 2
}

func buildInitialSeeding(roster []domain.PilotSlot, method domain.SeedingMethod, rngSeed int64) []seededPilot {
	pool := append([]domain.PilotSlot(nil), roster...)
	if method == domain.SeedRandom && len(pool) > 1 {
		r := rand.New(rand.NewSource(rngSeed))
		r.Shuffle(len(pool), func(i, j int) { pool[i], pool[j] = pool[j], pool[i] })
	}
	out := make([]seededPilot, len(pool))
	for i, p := range pool {
		out[i] = seededPilot{slot: p, seed: i + 1}
	}
	return out
}

func generateQualifyingHeats(
	cfg domain.RaceSetupConfig,
	seeded []seededPilot,
	stageIdx int,
	orderOffset int,
) []domain.RaceHeat {
	n := len(seeded)
	maxPerHeat := cfg.PilotsPerHeat
	if maxPerHeat < 2 {
		maxPerHeat = 4
	}
	seatChannels := cfg.SeatChannels
	if len(seatChannels) < maxPerHeat {
		seatChannels = domain.DefaultSeatChannels(maxPerHeat)
	}
	numRounds := cfg.QualifyingRounds
	if numRounds < 1 {
		numRounds = 1
	}
	heatsPerRound := (n + maxPerHeat - 1) / maxPerHeat
	if heatsPerRound < 1 {
		heatsPerRound = 1
	}

	// Placeholder-only qualifying stage (e.g. Stage 2+ fed by upstream StageSeeds before upstream finishes)
	allPlaceholders := n > 0
	for _, sp := range seeded {
		if sp.slot.SlotIndex > 0 {
			allPlaceholders = false
			break
		}
	}
	if allPlaceholders {
		lastCh := make(map[int]uint8)
		var heats []domain.RaceHeat
		order := orderOffset
		for round := 1; round <= numRounds; round++ {
			buckets := make([][]seededPilot, heatsPerRound)
			for i, sp := range seeded {
				bIdx := (i + (round - 1)) % heatsPerRound
				buckets[bIdx] = append(buckets[bIdx], sp)
			}
			for hIdx, group := range buckets {
				if len(group) == 0 {
					continue
				}
				order++
				heatID := fmt.Sprintf("Q%d-%d", round, hIdx+1)
				seats := buildKnownSeats(group, seatChannels, lastCh, func(sp seededPilot) string {
					return fmt.Sprintf("Seed #%d", sp.seed)
				})
				h := domain.RaceHeat{
					ID:              heatID,
					StageIndex:      stageIdx,
					StageName:       "Qualifying",
					StageFormat:     domain.FormatQualifying,
					Round:           round,
					Column:          round,
					Order:           order,
					BracketLane:     "qualifying",
					Title:           fmt.Sprintf("Qualifying Round %d · Heat %d", round, hIdx+1),
					ShortLabel:      heatID,
					StartMode:       domain.StartModeStaggered,
					TargetLaps:      cfg.QualifyingTargetLaps,
					TimeLimitSec:    cfg.QualifyingTimeLimitSec,
					ExpectedWinners: 0,
					State:           domain.HeatWaiting,
					Seats:           seats,
				}
				RecomputeHeat(&h, cfg.QualifyingMetric)
				heats = append(heats, h)
			}
		}
		return heats
	}

	fallbackPilots := make([]domain.PilotSlot, 0, len(seeded))
	seedBySlot := make(map[int]int, len(seeded))
	for _, sp := range seeded {
		if sp.slot.SlotIndex > 0 {
			fallbackPilots = append(fallbackPilots, sp.slot)
			seedBySlot[sp.slot.SlotIndex] = sp.seed
		}
	}

	lastCh := make(map[int]uint8)
	for _, sp := range seeded {
		if sp.slot.SlotIndex > 0 {
			if code := domain.EncodeBandChannel(sp.slot.Band, sp.slot.Channel); code > 0 {
				lastCh[sp.slot.SlotIndex] = code
			}
		}
	}

	var heats []domain.RaceHeat
	order := orderOffset
	prevRoundStart := -1
	prevRoundCount := 0

	for round := 1; round <= numRounds; round++ {
		var srcPtrs []*domain.RaceHeat
		if prevRoundStart >= 0 && prevRoundCount > 0 {
			for k := 0; k < prevRoundCount; k++ {
				srcPtrs = append(srcPtrs, &heats[prevRoundStart+k])
			}
		}

		grid := ScheduleBalancedQualifyingRound(
			srcPtrs,
			heatsPerRound,
			seatChannels,
			heats,
			fallbackPilots,
			round,
		)

		curRoundStart := len(heats)
		curRoundCount := 0

		for hIdx, row := range grid {
			hasPilot := false
			for _, cell := range row {
				if cell.PilotSlotIndex > 0 {
					hasPilot = true
					break
				}
			}
			if !hasPilot && len(fallbackPilots) > 0 && hIdx > 0 {
				continue
			}

			order++
			heatID := fmt.Sprintf("Q%d-%d", round, hIdx+1)
			seats := make([]domain.HeatSeat, len(seatChannels))
			for sIdx, seatCode := range seatChannels {
				band, ch, freq, ok := domain.DecodeBandChannel(seatCode)
				if !ok {
					band = domain.BandRaceband
					ch = uint8((sIdx % domain.MaxPilotSlots) + 1)
					freq = domain.RacebandFrequenciesMHz[ch-1]
					seatCode = ch
				}
				var cell BalancedSlotAssignment
				if sIdx < len(row) {
					cell = row[sIdx]
				}
				if cell.PilotSlotIndex > 0 {
					prev := lastCh[cell.PilotSlotIndex]
					seedNum := cell.Seed
					if seedNum <= 0 {
						seedNum = seedBySlot[cell.PilotSlotIndex]
					}
					srcLbl := fmt.Sprintf("Seed #%d", seedNum)
					if round > 1 {
						srcLbl = fmt.Sprintf("Q%d Rotation", round-1)
					}
					seats[sIdx] = domain.HeatSeat{
						SeatIndex:      sIdx + 1,
						PilotSlotIndex: cell.PilotSlotIndex,
						Callsign:       cell.Callsign,
						PhoneticName:   cell.PhoneticName,
						Color:          cell.Color,
						Seed:           seedNum,
						SourceLabel:    srcLbl,
						Band:           band,
						Channel:        ch,
						FrequencyMHz:   freq,
						ChannelChanged: prev > 0 && seatCode > 0 && prev != seatCode,
						PrevChannel:    prev,
						Status:         domain.PilotHeatStaged,
						Laps:           []domain.HeatLap{},
					}
					lastCh[cell.PilotSlotIndex] = seatCode
				} else {
					seats[sIdx] = domain.HeatSeat{
						SeatIndex:    sIdx + 1,
						SourceLabel:  "Open / BYE",
						Band:         band,
						Channel:      ch,
						FrequencyMHz: freq,
						Status:       domain.PilotHeatStaged,
						Laps:         []domain.HeatLap{},
					}
				}
			}

			h := domain.RaceHeat{
				ID:              heatID,
				StageIndex:      stageIdx,
				StageName:       "Qualifying",
				StageFormat:     domain.FormatQualifying,
				Round:           round,
				Column:          round,
				Order:           order,
				BracketLane:     "qualifying",
				Title:           fmt.Sprintf("Qualifying Round %d · Heat %d", round, hIdx+1),
				ShortLabel:      heatID,
				StartMode:       domain.StartModeStaggered,
				TargetLaps:      cfg.QualifyingTargetLaps,
				TimeLimitSec:    cfg.QualifyingTimeLimitSec,
				ExpectedWinners: 0,
				State:           domain.HeatReady,
				Seats:           seats,
			}
			RecomputeHeat(&h, cfg.QualifyingMetric)
			heats = append(heats, h)
			curRoundCount++
		}

		prevRoundStart = curRoundStart
		prevRoundCount = curRoundCount
	}
	return heats
}

func generateMainStage(
	cfg domain.RaceSetupConfig,
	seeded []seededPilot,
	stageIdx int,
	orderOffset int,
	priorChannels map[int]uint8,
) ([]domain.RaceHeat, []domain.BracketEdge) {
	lastCh := make(map[int]uint8)
	for _, sp := range seeded {
		if code := domain.EncodeBandChannel(sp.slot.Band, sp.slot.Channel); code > 0 {
			lastCh[sp.slot.SlotIndex] = code
		}
	}
	for slotIdx, ch := range priorChannels {
		if _, _, _, ok := domain.DecodeBandChannel(ch); ok {
			lastCh[slotIdx] = ch
		}
	}

	switch cfg.MainFormat {
	case domain.FormatOpenQualifier:
		return nil, nil
	case domain.FormatQualifying:
		return generateQualifyingHeats(cfg, seeded, stageIdx, orderOffset), nil
	case domain.FormatChaseTheAce:
		return generateChaseTheAceStandalone(cfg, seeded, stageIdx, orderOffset, lastCh), nil
	case domain.FormatPointsMains:
		return generatePointsMains(cfg, seeded, stageIdx, orderOffset, lastCh), nil
	case domain.FormatSingleElimination:
		return generateSingleElimination(cfg, seeded, stageIdx, orderOffset, lastCh)
	default:
		return generateDoubleElimination(cfg, seeded, stageIdx, orderOffset, lastCh)
	}
}

func generateChaseTheAceStandalone(
	cfg domain.RaceSetupConfig,
	seeded []seededPilot,
	stageIdx int,
	orderOffset int,
	lastCh map[int]uint8,
) []domain.RaceHeat {
	limit := cfg.PilotsPerHeat
	if len(seeded) < limit {
		limit = len(seeded)
	}
	group := seeded[:limit]
	seats := buildKnownSeats(group, cfg.SeatChannels, lastCh, func(sp seededPilot) string {
		return fmt.Sprintf("Seed #%d", sp.seed)
	})
	h := domain.RaceHeat{
		ID:              "CTA-1",
		StageIndex:      stageIdx,
		StageName:       "Chase the Ace",
		StageFormat:     domain.FormatChaseTheAce,
		Round:           1,
		Column:          1,
		Order:           orderOffset + 1,
		BracketLane:     "finals",
		Title:           fmt.Sprintf("Chase the Ace · Heat 1 (First to %d Wins)", cfg.AceWinsRequired),
		ShortLabel:      "CTA-1",
		StartMode:       domain.StartModeHeadsUp,
		TargetLaps:      cfg.TargetLaps,
		TimeLimitSec:    cfg.TimeLimitSec,
		ExpectedWinners: 1,
		State:           domain.HeatReady,
		Seats:           seats,
	}
	RecomputeHeat(&h, cfg.QualifyingMetric)
	return []domain.RaceHeat{h}
}

func generatePointsMains(
	cfg domain.RaceSetupConfig,
	seeded []seededPilot,
	stageIdx int,
	orderOffset int,
	lastCh map[int]uint8,
) []domain.RaceHeat {
	divNames := []string{"A", "B", "C", "D", "E", "F", "G", "H"}
	maxPerHeat := cfg.PilotsPerHeat
	var divs [][]seededPilot
	for i := 0; i < len(seeded); i += maxPerHeat {
		end := i + maxPerHeat
		if end > len(seeded) {
			end = len(seeded)
		}
		divs = append(divs, seeded[i:end])
	}

	var heats []domain.RaceHeat
	order := orderOffset
	for round := 1; round <= cfg.PointsRounds; round++ {
		// Run lowest division first (e.g. C Main -> B Main -> A Main) so A Main closes every round.
		for dIdx := len(divs) - 1; dIdx >= 0; dIdx-- {
			divLabel := fmt.Sprintf("%d", dIdx+1)
			if dIdx < len(divNames) {
				divLabel = divNames[dIdx]
			}
			order++
			heatID := fmt.Sprintf("%s%d", divLabel, round)
			seats := buildKnownSeats(divs[dIdx], cfg.SeatChannels, lastCh, func(sp seededPilot) string {
				return fmt.Sprintf("%s Main · #%d", divLabel, sp.seed)
			})
			for _, s := range seats {
				if s.PilotSlotIndex > 0 && s.Channel > 0 {
					lastCh[s.PilotSlotIndex] = domain.EncodeBandChannel(s.Band, s.Channel)
				}
			}
			h := domain.RaceHeat{
				ID:              heatID,
				StageIndex:      stageIdx,
				StageName:       "Points Mains",
				StageFormat:     domain.FormatPointsMains,
				Round:           round,
				Column:          round,
				Order:           order,
				BracketLane:     "mains",
				Division:        divLabel,
				Title:           fmt.Sprintf("%s Main · Round %d", divLabel, round),
				ShortLabel:      heatID,
				StartMode:       domain.StartModeHeadsUp,
				TargetLaps:      cfg.TargetLaps,
				TimeLimitSec:    cfg.TimeLimitSec,
				ExpectedWinners: 1,
				State:           domain.HeatReady,
				Seats:           seats,
			}
			RecomputeHeat(&h, cfg.QualifyingMetric)
			heats = append(heats, h)
		}
	}
	return heats
}

func generateSingleElimination(
	cfg domain.RaceSetupConfig,
	seeded []seededPilot,
	stageIdx int,
	orderOffset int,
	lastCh map[int]uint8,
) ([]domain.RaceHeat, []domain.BracketEdge) {
	k := cfg.PilotsPerHeat
	adv := k / 2
	if adv < 1 {
		adv = 1
	}

	if len(seeded) <= k {
		if cfg.FinalsFormat == domain.FinalsChaseTheAce {
			return generateChaseTheAceStandalone(cfg, seeded, stageIdx, orderOffset, lastCh), nil
		}
		seats := buildKnownSeats(seeded, cfg.SeatChannels, lastCh, func(sp seededPilot) string {
			return fmt.Sprintf("Seed #%d", sp.seed)
		})
		gf := domain.RaceHeat{
			ID:              "GF-1",
			StageIndex:      stageIdx,
			StageName:       "Single Elimination",
			StageFormat:     domain.FormatSingleElimination,
			Round:           1,
			Column:          1,
			Order:           orderOffset + 1,
			BracketLane:     "finals",
			Title:           "Grand Final",
			ShortLabel:      "GF-1",
			StartMode:       domain.StartModeHeadsUp,
			TargetLaps:      cfg.TargetLaps,
			TimeLimitSec:    cfg.TimeLimitSec,
			ExpectedWinners: 1,
			State:           domain.HeatReady,
			Seats:           seats,
		}
		RecomputeHeat(&gf, cfg.QualifyingMetric)
		return []domain.RaceHeat{gf}, nil
	}

	// Elimination-aware Round 1 sizing: pick heat count so every heat holds at least `adv + 1`
	// pilots (eliminating at least 1 pilot per heat) whenever feasible.
	m := PlanHeatCount(len(seeded), k, adv, 0)
	buckets := snakeDistribute(seeded, m)

	var heats []domain.RaceHeat
	var edges []domain.BracketEdge
	order := orderOffset

	type seHeatInfo struct {
		id       string
		entrants int
		advCount int
	}
	prevHeats := make([]seHeatInfo, m)

	// Round 1
	for hIdx := 0; hIdx < m; hIdx++ {
		order++
		hid := fmt.Sprintf("W1-%d", hIdx+1)
		sz := len(buckets[hIdx])
		expWin := EffectiveAdvance(adv, sz)
		prevHeats[hIdx] = seHeatInfo{id: hid, entrants: sz, advCount: expWin}
		seats := buildKnownSeats(buckets[hIdx], cfg.SeatChannels, lastCh, func(sp seededPilot) string {
			return fmt.Sprintf("Seed #%d", sp.seed)
		})
		for _, s := range seats {
			if s.PilotSlotIndex > 0 && s.Channel > 0 {
				lastCh[s.PilotSlotIndex] = domain.EncodeBandChannel(s.Band, s.Channel)
			}
		}
		h := domain.RaceHeat{
			ID:              hid,
			StageIndex:      stageIdx,
			StageName:       "Single Elimination",
			StageFormat:     domain.FormatSingleElimination,
			Round:           1,
			Column:          1,
			Order:           order,
			BracketLane:     "winners",
			Title:           fmt.Sprintf("Round 1 · Heat %d", hIdx+1),
			ShortLabel:      hid,
			StartMode:       domain.StartModeHeadsUp,
			TargetLaps:      cfg.TargetLaps,
			TimeLimitSec:    cfg.TimeLimitSec,
			ExpectedWinners: expWin,
			State:           domain.HeatReady,
			Seats:           seats,
		}
		RecomputeHeat(&h, cfg.QualifyingMetric)
		heats = append(heats, h)
	}

	roundNum := 1
	for len(prevHeats) > 0 {
		totalAdv := 0
		maxAdv := 0
		for _, ph := range prevHeats {
			totalAdv += ph.advCount
			if ph.advCount > maxAdv {
				maxAdv = ph.advCount
			}
		}
		if totalAdv == 0 {
			break
		}

		roundNum++
		isFinal := totalAdv <= k
		nextCount := 1
		if !isFinal {
			nextCount = PlanHeatCount(totalAdv, k, adv, 0)
		}

		heatFeeders := make([][]domain.SeatFeeder, nextCount)
		paired := len(prevHeats) == 2*nextCount
		if paired {
			for hIdx := 0; hIdx < nextCount; hIdx++ {
				a := prevHeats[2*hIdx]
				b := prevHeats[2*hIdx+1]
				sumAB := a.advCount + b.advCount
				if sumAB > k || (!isFinal && IsFeasibleElimPool(totalAdv, k, adv) && sumAB < adv+1) {
					paired = false
					break
				}
			}
		}
		if paired {
			for hIdx := 0; hIdx < nextCount; hIdx++ {
				srcA := prevHeats[2*hIdx]
				srcB := prevHeats[2*hIdx+1]
				for r := 1; r <= srcA.advCount; r++ {
					heatFeeders[hIdx] = append(heatFeeders[hIdx], domain.SeatFeeder{FromHeatID: srcA.id, FromRank: r})
				}
				for r := 1; r <= srcB.advCount; r++ {
					heatFeeders[hIdx] = append(heatFeeders[hIdx], domain.SeatFeeder{FromHeatID: srcB.id, FromRank: r})
				}
			}
		} else {
			var pool []domain.SeatFeeder
			for r := 1; r <= maxAdv; r++ {
				for _, ph := range prevHeats {
					if r <= ph.advCount {
						pool = append(pool, domain.SeatFeeder{FromHeatID: ph.id, FromRank: r})
					}
				}
			}
			heatFeeders = DistributeFeedersAcrossHeats(pool, nextCount, k)
		}

		nextHeats := make([]seHeatInfo, 0, nextCount)
		for hIdx := 0; hIdx < nextCount; hIdx++ {
			order++
			feeders := heatFeeders[hIdx]
			entrants := len(feeders)
			expWin := EffectiveAdvance(adv, entrants)
			var hid, title, lane string
			if isFinal {
				lane = "finals"
				expWin = 1
				if cfg.FinalsFormat == domain.FinalsChaseTheAce {
					hid = "CTA-1"
					title = fmt.Sprintf("Chase the Ace · Heat 1 (First to %d Wins)", cfg.AceWinsRequired)
				} else {
					hid = "GF-1"
					title = "Grand Final"
				}
			} else {
				lane = "winners"
				hid = fmt.Sprintf("W%d-%d", roundNum, hIdx+1)
				title = fmt.Sprintf("Semi-Final · Heat %d", hIdx+1)
				if nextCount > 2 {
					title = fmt.Sprintf("Round %d · Heat %d", roundNum, hIdx+1)
				}
				if nextCount == 1 {
					title = fmt.Sprintf("Round %d", roundNum)
				}
			}
			edges = appendGroupedBracketEdges(edges, feeders, hid, nil)
			heats = append(heats, domain.RaceHeat{
				ID:              hid,
				StageIndex:      stageIdx,
				StageName:       "Single Elimination",
				StageFormat:     domain.FormatSingleElimination,
				Round:           roundNum,
				Column:          roundNum,
				Order:           order,
				BracketLane:     lane,
				Title:           title,
				ShortLabel:      hid,
				StartMode:       domain.StartModeHeadsUp,
				TargetLaps:      cfg.TargetLaps,
				TimeLimitSec:    cfg.TimeLimitSec,
				ExpectedWinners: expWin,
				State:           domain.HeatWaiting,
				Seats:           buildFeederSeats(feeders, cfg.SeatChannels),
			})
			if !isFinal {
				nextHeats = append(nextHeats, seHeatInfo{id: hid, entrants: entrants, advCount: expWin})
			}
		}
		if isFinal {
			break
		}
		prevHeats = nextHeats
	}

	return heats, edges
}

// appendGroupedBracketEdges collapses `feeders` by `FromHeatID` (in first-seen order) into BracketEdges.
func appendGroupedBracketEdges(
	edges []domain.BracketEdge,
	feeders []domain.SeatFeeder,
	toHeatID string,
	dropByHeat map[string]bool,
) []domain.BracketEdge {
	var srcOrder []string
	ranksBySrc := make(map[string][]int)
	for _, fd := range feeders {
		if fd.FromHeatID == "" || fd.IsBye {
			continue
		}
		if _, seen := ranksBySrc[fd.FromHeatID]; !seen {
			srcOrder = append(srcOrder, fd.FromHeatID)
		}
		ranksBySrc[fd.FromHeatID] = append(ranksBySrc[fd.FromHeatID], fd.FromRank)
	}
	for _, srcID := range srcOrder {
		rks := ranksBySrc[srcID]
		sort.Ints(rks)
		edges = append(edges, domain.BracketEdge{
			FromHeatID: srcID,
			ToHeatID:   toHeatID,
			Ranks:      rks,
			IsDrop:     dropByHeat != nil && dropByHeat[srcID],
		})
	}
	return edges
}

// generateDoubleElimination builds an elimination-aware, propagation-aware Double Elimination bracket
// (preserving classic MultiGP 8-pilot 6-heat, 16-pilot 14-heat, and 32-pilot 30-heat layouts while
// sizing non-power-of-2 rosters so every Winners and Redemption heat eliminates or drops at least 1 pilot).
func generateDoubleElimination(
	cfg domain.RaceSetupConfig,
	seeded []seededPilot,
	stageIdx int,
	orderOffset int,
	lastCh map[int]uint8,
) ([]domain.RaceHeat, []domain.BracketEdge) {
	k := cfg.PilotsPerHeat
	adv := k / 2
	if adv < 1 {
		adv = 1
	}

	// Compact case: all pilots fit in a single heat (e.g. <= 4 pilots in 4-up).
	if len(seeded) <= k {
		if cfg.FinalsFormat == domain.FinalsChaseTheAce {
			heats := generateChaseTheAceStandalone(cfg, seeded, stageIdx, orderOffset, lastCh)
			for i := range heats {
				heats[i].StageName = "Double Elimination"
			}
			return heats, nil
		}
		return generateCompactDoubleElim(cfg, seeded, stageIdx, orderOffset, lastCh)
	}

	type deHeatInfo struct {
		id       string
		entrants int
		advCount int
	}

	m := PlanHeatCount(len(seeded), k, adv, 0)
	buckets := snakeDistribute(seeded, m)

	var heats []domain.RaceHeat
	var edges []domain.BracketEdge
	order := orderOffset
	wCol := 1
	lCol := 0
	wRoundNum := 1
	lRoundNum := 0

	// Winners Round 1 (m heats)
	wCurr := make([]deHeatInfo, m)
	for hIdx := 0; hIdx < m; hIdx++ {
		order++
		hid := fmt.Sprintf("W1-%d", hIdx+1)
		sz := len(buckets[hIdx])
		expWin := EffectiveAdvance(adv, sz)
		wCurr[hIdx] = deHeatInfo{id: hid, entrants: sz, advCount: expWin}
		seats := buildKnownSeats(buckets[hIdx], cfg.SeatChannels, lastCh, func(sp seededPilot) string {
			return fmt.Sprintf("Seed #%d", sp.seed)
		})
		for _, s := range seats {
			if s.PilotSlotIndex > 0 && s.Channel > 0 {
				lastCh[s.PilotSlotIndex] = domain.EncodeBandChannel(s.Band, s.Channel)
			}
		}
		title := fmt.Sprintf("Winners Round 1 · Heat %d", hIdx+1)
		if m == 1 {
			title = "Winners Final"
		}
		h := domain.RaceHeat{
			ID:              hid,
			StageIndex:      stageIdx,
			StageName:       "Double Elimination",
			StageFormat:     domain.FormatDoubleElimination,
			Round:           1,
			Column:          wCol,
			Order:           order,
			BracketLane:     "winners",
			Title:           title,
			ShortLabel:      hid,
			StartMode:       domain.StartModeHeadsUp,
			TargetLaps:      cfg.TargetLaps,
			TimeLimitSec:    cfg.TimeLimitSec,
			ExpectedWinners: expWin,
			State:           domain.HeatReady,
			Seats:           seats,
		}
		RecomputeHeat(&h, cfg.QualifyingMetric)
		heats = append(heats, h)
	}

	var pendingDrops []deHeatInfo
	pendingDrops = append(pendingDrops, wCurr...)
	var lSurv []deHeatInfo

	sumAdv := func(list []deHeatInfo) int {
		tot := 0
		for _, item := range list {
			tot += item.advCount
		}
		return tot
	}
	lPoolCount := func() int {
		tot := 0
		for _, d := range pendingDrops {
			if d.entrants > d.advCount {
				tot += d.entrants - d.advCount
			}
		}
		for _, s := range lSurv {
			tot += s.advCount
		}
		return tot
	}
	nextWinnersDropCount := func(wList []deHeatInfo) int {
		wTot := sumAdv(wList)
		if wTot <= adv {
			return 0
		}
		nwh := PlanHeatCount(wTot, k, adv, 0)
		base := wTot / nwh
		rem := wTot % nwh
		drops := 0
		for i := 0; i < nwh; i++ {
			sz := base
			if i < rem {
				sz++
			}
			drops += sz - EffectiveAdvance(adv, sz)
		}
		return drops
	}

	runLosersRound := func(isWinnersDone bool) {
		lTotal := lPoolCount()
		if lTotal == 0 {
			return
		}
		lRoundNum++
		lCol++
		if lCol < wCol {
			lCol = wCol
		}
		numL := PlanHeatCount(lTotal, k, adv, 0)
		isLosersFinal := isWinnersDone && numL == 1 && EffectiveAdvance(adv, lTotal) <= k-sumAdv(wCurr)

		dropByHeat := make(map[string]bool, len(pendingDrops))
		for _, d := range pendingDrops {
			dropByHeat[d.id] = true
		}

		heatFeeders := make([][]domain.SeatFeeder, numL)
		paired := false

		// Preserve classic bracket pairings whenever exact 2:1 or cross-bracket 1:1 pairing is valid and balanced.
		if len(lSurv) == 0 && len(pendingDrops) == 2*numL {
			okPair := true
			for hIdx := 0; hIdx < numL; hIdx++ {
				a := pendingDrops[2*hIdx]
				b := pendingDrops[2*hIdx+1]
				cnt := (a.entrants - a.advCount) + (b.entrants - b.advCount)
				if cnt > k || (IsFeasibleElimPool(lTotal, k, adv) && cnt < adv+1) {
					okPair = false
					break
				}
			}
			if okPair {
				paired = true
				for hIdx := 0; hIdx < numL; hIdx++ {
					a := pendingDrops[2*hIdx]
					b := pendingDrops[2*hIdx+1]
					for r := a.advCount + 1; r <= a.entrants; r++ {
						heatFeeders[hIdx] = append(heatFeeders[hIdx], domain.SeatFeeder{FromHeatID: a.id, FromRank: r})
					}
					for r := b.advCount + 1; r <= b.entrants; r++ {
						heatFeeders[hIdx] = append(heatFeeders[hIdx], domain.SeatFeeder{FromHeatID: b.id, FromRank: r})
					}
				}
			}
		} else if len(pendingDrops) == numL && len(lSurv) == numL {
			okPair := true
			for hIdx := 0; hIdx < numL; hIdx++ {
				d := pendingDrops[numL-1-hIdx]
				s := lSurv[hIdx]
				cnt := (d.entrants - d.advCount) + s.advCount
				if cnt > k || (IsFeasibleElimPool(lTotal, k, adv) && cnt < adv+1) {
					okPair = false
					break
				}
			}
			if okPair {
				paired = true
				for hIdx := 0; hIdx < numL; hIdx++ {
					d := pendingDrops[numL-1-hIdx]
					s := lSurv[hIdx]
					for r := d.advCount + 1; r <= d.entrants; r++ {
						heatFeeders[hIdx] = append(heatFeeders[hIdx], domain.SeatFeeder{FromHeatID: d.id, FromRank: r})
					}
					for r := 1; r <= s.advCount; r++ {
						heatFeeders[hIdx] = append(heatFeeders[hIdx], domain.SeatFeeder{FromHeatID: s.id, FromRank: r})
					}
				}
			}
		} else if len(pendingDrops) == 0 && len(lSurv) == 2*numL {
			okPair := true
			for hIdx := 0; hIdx < numL; hIdx++ {
				cnt := lSurv[2*hIdx].advCount + lSurv[2*hIdx+1].advCount
				if cnt > k || (IsFeasibleElimPool(lTotal, k, adv) && cnt < adv+1) {
					okPair = false
					break
				}
			}
			if okPair {
				paired = true
				for hIdx := 0; hIdx < numL; hIdx++ {
					a := lSurv[2*hIdx]
					b := lSurv[2*hIdx+1]
					for r := 1; r <= a.advCount; r++ {
						heatFeeders[hIdx] = append(heatFeeders[hIdx], domain.SeatFeeder{FromHeatID: a.id, FromRank: r})
					}
					for r := 1; r <= b.advCount; r++ {
						heatFeeders[hIdx] = append(heatFeeders[hIdx], domain.SeatFeeder{FromHeatID: b.id, FromRank: r})
					}
				}
			}
		}

		if !paired {
			var pool []domain.SeatFeeder
			maxDropOffset := 0
			for _, d := range pendingDrops {
				if d.entrants-d.advCount > maxDropOffset {
					maxDropOffset = d.entrants - d.advCount
				}
			}
			for off := 1; off <= maxDropOffset; off++ {
				for idx := len(pendingDrops) - 1; idx >= 0; idx-- {
					d := pendingDrops[idx]
					rnk := d.advCount + off
					if rnk <= d.entrants {
						pool = append(pool, domain.SeatFeeder{FromHeatID: d.id, FromRank: rnk})
					}
				}
			}
			maxSurvRank := 0
			for _, s := range lSurv {
				if s.advCount > maxSurvRank {
					maxSurvRank = s.advCount
				}
			}
			for r := 1; r <= maxSurvRank; r++ {
				for _, s := range lSurv {
					if r <= s.advCount {
						pool = append(pool, domain.SeatFeeder{FromHeatID: s.id, FromRank: r})
					}
				}
			}
			heatFeeders = DistributeFeedersAcrossHeats(pool, numL, k)
		}

		newSurv := make([]deHeatInfo, 0, numL)
		for hIdx := 0; hIdx < numL; hIdx++ {
			order++
			hid := fmt.Sprintf("L%d-%d", lRoundNum, hIdx+1)
			feeders := heatFeeders[hIdx]
			entrants := len(feeders)
			expWin := EffectiveAdvance(adv, entrants)
			edges = appendGroupedBracketEdges(edges, feeders, hid, dropByHeat)
			heats = append(heats, domain.RaceHeat{
				ID:              hid,
				StageIndex:      stageIdx,
				StageName:       "Double Elimination",
				StageFormat:     domain.FormatDoubleElimination,
				Round:           lRoundNum,
				Column:          lCol,
				Order:           order,
				BracketLane:     "losers",
				Title:           losersTitle(lRoundNum, hIdx+1, numL, isLosersFinal),
				ShortLabel:      hid,
				StartMode:       domain.StartModeHeadsUp,
				TargetLaps:      cfg.TargetLaps,
				TimeLimitSec:    cfg.TimeLimitSec,
				ExpectedWinners: expWin,
				State:           domain.HeatWaiting,
				Seats:           buildFeederSeats(feeders, cfg.SeatChannels),
			})
			newSurv = append(newSurv, deHeatInfo{id: hid, entrants: entrants, advCount: expWin})
		}
		pendingDrops = nil
		lSurv = newSurv
	}

	drainLosers := func() {
		for guard := 0; guard < 16; guard++ {
			wTot := sumAdv(wCurr)
			lTot := lPoolCount()
			if wTot <= adv {
				maxFinalFromL := k - wTot
				if maxFinalFromL < 1 {
					maxFinalFromL = 1
				}
				if lTot <= maxFinalFromL || lTot <= 1 {
					break
				}
				runLosersRound(true)
			} else {
				nextDrops := nextWinnersDropCount(wCurr)
				if lTot <= nextDrops || !IsFeasibleElimPool(lTot, k, adv) {
					break
				}
				runLosersRound(false)
			}
		}
	}

	// Consolidate W1 drops if feasible before W2 runs
	drainLosers()

	// Step through remaining Winners rounds + corresponding Losers rounds
	for sumAdv(wCurr) > adv {
		wCol++
		wRoundNum++
		wTotal := sumAdv(wCurr)
		wCount := PlanHeatCount(wTotal, k, adv, 0)
		isWinnersFinal := wCount == 1 && EffectiveAdvance(adv, wTotal) <= adv

		heatFeeders := make([][]domain.SeatFeeder, wCount)
		paired := len(wCurr) == 2*wCount
		if paired {
			for hIdx := 0; hIdx < wCount; hIdx++ {
				cnt := wCurr[2*hIdx].advCount + wCurr[2*hIdx+1].advCount
				if cnt > k || (IsFeasibleElimPool(wTotal, k, adv) && cnt < adv+1) {
					paired = false
					break
				}
			}
		}
		if paired {
			for hIdx := 0; hIdx < wCount; hIdx++ {
				a := wCurr[2*hIdx]
				b := wCurr[2*hIdx+1]
				for r := 1; r <= a.advCount; r++ {
					heatFeeders[hIdx] = append(heatFeeders[hIdx], domain.SeatFeeder{FromHeatID: a.id, FromRank: r})
				}
				for r := 1; r <= b.advCount; r++ {
					heatFeeders[hIdx] = append(heatFeeders[hIdx], domain.SeatFeeder{FromHeatID: b.id, FromRank: r})
				}
			}
		} else {
			maxR := 0
			for _, wh := range wCurr {
				if wh.advCount > maxR {
					maxR = wh.advCount
				}
			}
			var pool []domain.SeatFeeder
			for r := 1; r <= maxR; r++ {
				for _, wh := range wCurr {
					if r <= wh.advCount {
						pool = append(pool, domain.SeatFeeder{FromHeatID: wh.id, FromRank: r})
					}
				}
			}
			heatFeeders = DistributeFeedersAcrossHeats(pool, wCount, k)
		}

		wNext := make([]deHeatInfo, 0, wCount)
		for hIdx := 0; hIdx < wCount; hIdx++ {
			order++
			hid := fmt.Sprintf("W%d-%d", wRoundNum, hIdx+1)
			feeders := heatFeeders[hIdx]
			entrants := len(feeders)
			expWin := EffectiveAdvance(adv, entrants)
			edges = appendGroupedBracketEdges(edges, feeders, hid, nil)
			title := fmt.Sprintf("Winners Round %d · Heat %d", wRoundNum, hIdx+1)
			if isWinnersFinal {
				title = "Winners Final"
			} else if wCount == 1 {
				title = fmt.Sprintf("Winners Round %d", wRoundNum)
			}
			heats = append(heats, domain.RaceHeat{
				ID:              hid,
				StageIndex:      stageIdx,
				StageName:       "Double Elimination",
				StageFormat:     domain.FormatDoubleElimination,
				Round:           wRoundNum,
				Column:          wCol,
				Order:           order,
				BracketLane:     "winners",
				Title:           title,
				ShortLabel:      hid,
				StartMode:       domain.StartModeHeadsUp,
				TargetLaps:      cfg.TargetLaps,
				TimeLimitSec:    cfg.TimeLimitSec,
				ExpectedWinners: expWin,
				State:           domain.HeatWaiting,
				Seats:           buildFeederSeats(feeders, cfg.SeatChannels),
			})
			wNext = append(wNext, deHeatInfo{id: hid, entrants: entrants, advCount: expWin})
		}

		wCurr = wNext
		pendingDrops = append(pendingDrops, wCurr...)
		drainLosers()
	}

	// Finals: advancing winners from `wCurr` + survivors from `lSurv` (plus any single remaining drop)
	finalCol := lCol + 1
	if wCol+1 > finalCol {
		finalCol = wCol + 1
	}
	order++
	var finalFeeders []domain.SeatFeeder
	dropByHeat := make(map[string]bool, len(pendingDrops))
	for _, wh := range wCurr {
		for r := 1; r <= wh.advCount; r++ {
			finalFeeders = append(finalFeeders, domain.SeatFeeder{FromHeatID: wh.id, FromRank: r})
		}
	}
	for _, d := range pendingDrops {
		dropByHeat[d.id] = true
		for r := d.advCount + 1; r <= d.entrants; r++ {
			finalFeeders = append(finalFeeders, domain.SeatFeeder{FromHeatID: d.id, FromRank: r})
		}
	}
	for _, lh := range lSurv {
		for r := 1; r <= lh.advCount; r++ {
			finalFeeders = append(finalFeeders, domain.SeatFeeder{FromHeatID: lh.id, FromRank: r})
		}
	}
	if len(finalFeeders) > k {
		finalFeeders = finalFeeders[:k]
	}

	finalID := "GF-1"
	finalTitle := "Grand Final"
	if cfg.FinalsFormat == domain.FinalsChaseTheAce {
		finalID = "CTA-1"
		finalTitle = fmt.Sprintf("Chase the Ace · Heat 1 (First to %d Wins)", cfg.AceWinsRequired)
	}
	edges = appendGroupedBracketEdges(edges, finalFeeders, finalID, dropByHeat)
	heats = append(heats, domain.RaceHeat{
		ID:              finalID,
		StageIndex:      stageIdx,
		StageName:       "Double Elimination",
		StageFormat:     domain.FormatDoubleElimination,
		Round:           wRoundNum + 1,
		Column:          finalCol,
		Order:           order,
		BracketLane:     "finals",
		Title:           finalTitle,
		ShortLabel:      finalID,
		StartMode:       domain.StartModeHeadsUp,
		TargetLaps:      cfg.TargetLaps,
		TimeLimitSec:    cfg.TimeLimitSec,
		ExpectedWinners: 1,
		State:           domain.HeatWaiting,
		Seats:           buildFeederSeats(finalFeeders, cfg.SeatChannels),
	})

	return heats, edges
}

func generateCompactDoubleElim(
	cfg domain.RaceSetupConfig,
	seeded []seededPilot,
	stageIdx int,
	orderOffset int,
	lastCh map[int]uint8,
) ([]domain.RaceHeat, []domain.BracketEdge) {
	n := len(seeded)
	adv := n / 2
	if adv < 1 {
		adv = 1
	}
	seatsW1 := buildKnownSeats(seeded, cfg.SeatChannels, lastCh, func(sp seededPilot) string {
		return fmt.Sprintf("Seed #%d", sp.seed)
	})
	w1 := domain.RaceHeat{
		ID:              "W1-1",
		StageIndex:      stageIdx,
		StageName:       "Double Elimination",
		StageFormat:     domain.FormatDoubleElimination,
		Round:           1,
		Column:          1,
		Order:           orderOffset + 1,
		BracketLane:     "winners",
		Title:           "Winners Heat",
		ShortLabel:      "W1-1",
		StartMode:       domain.StartModeHeadsUp,
		TargetLaps:      cfg.TargetLaps,
		TimeLimitSec:    cfg.TimeLimitSec,
		ExpectedWinners: adv,
		State:           domain.HeatReady,
		Seats:           seatsW1,
	}
	RecomputeHeat(&w1, cfg.QualifyingMetric)

	dropRanks := makeRange(adv+1, n)
	var lFeeders []domain.SeatFeeder
	for _, r := range dropRanks {
		lFeeders = append(lFeeders, domain.SeatFeeder{FromHeatID: "W1-1", FromRank: r})
	}
	lAdv := int(math.Max(1, float64(len(dropRanks)/2)))
	if len(dropRanks) == 1 {
		lAdv = 1
	}
	l1 := domain.RaceHeat{
		ID:              "L1-1",
		StageIndex:      stageIdx,
		StageName:       "Double Elimination",
		StageFormat:     domain.FormatDoubleElimination,
		Round:           1,
		Column:          1,
		Order:           orderOffset + 2,
		BracketLane:     "losers",
		Title:           "Redemption Heat",
		ShortLabel:      "L1-1",
		StartMode:       domain.StartModeHeadsUp,
		TargetLaps:      cfg.TargetLaps,
		TimeLimitSec:    cfg.TimeLimitSec,
		ExpectedWinners: lAdv,
		State:           domain.HeatWaiting,
		Seats:           buildFeederSeats(lFeeders, cfg.SeatChannels),
	}

	advRanks := makeRange(1, adv)
	lAdvRanks := makeRange(1, lAdv)
	var gfFeeders []domain.SeatFeeder
	for _, r := range advRanks {
		gfFeeders = append(gfFeeders, domain.SeatFeeder{FromHeatID: "W1-1", FromRank: r})
	}
	for _, r := range lAdvRanks {
		gfFeeders = append(gfFeeders, domain.SeatFeeder{FromHeatID: "L1-1", FromRank: r})
	}
	gf := domain.RaceHeat{
		ID:              "GF-1",
		StageIndex:      stageIdx,
		StageName:       "Double Elimination",
		StageFormat:     domain.FormatDoubleElimination,
		Round:           2,
		Column:          2,
		Order:           orderOffset + 3,
		BracketLane:     "finals",
		Title:           "Grand Final",
		ShortLabel:      "GF-1",
		StartMode:       domain.StartModeHeadsUp,
		TargetLaps:      cfg.TargetLaps,
		TimeLimitSec:    cfg.TimeLimitSec,
		ExpectedWinners: 1,
		State:           domain.HeatWaiting,
		Seats:           buildFeederSeats(gfFeeders, cfg.SeatChannels),
	}
	edges := []domain.BracketEdge{
		{FromHeatID: "W1-1", ToHeatID: "GF-1", Ranks: advRanks},
		{FromHeatID: "W1-1", ToHeatID: "L1-1", Ranks: dropRanks, IsDrop: true},
		{FromHeatID: "L1-1", ToHeatID: "GF-1", Ranks: lAdvRanks},
	}
	return []domain.RaceHeat{w1, l1, gf}, edges
}

// snakeDistribute places seeded pilots into `m` power-of-2 heats using standard tournament bracket
// ordering (e.g. for m=4: Heat 1 gets #1,#8,#9,#16; Heat 2 gets #4,#5,#12,#13; Heat 3 gets #2,#7,#10,#15; Heat 4 gets #3,#6,#11,#14).
func snakeDistribute(seeded []seededPilot, m int) [][]seededPilot {
	order := bracketHeatSeedOrder(m)
	buckets := make([][]seededPilot, m)
	for i, sp := range seeded {
		pass := i / m
		pos := i % m
		var bIdx int
		if pass%2 == 0 {
			bIdx = order[pos]
		} else {
			bIdx = order[m-1-pos]
		}
		buckets[bIdx] = append(buckets[bIdx], sp)
	}
	return buckets
}

// bracketHeatSeedOrder returns the 0-based heat indices in standard tournament bracket placement order for power-of-2 `m`,
// or sequential 0..m-1 snake order when `m` is not a power of 2.
func bracketHeatSeedOrder(m int) []int {
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
	// Map 1-based bracket position to 0-based heat index
	posToHeat := make([]int, m)
	for heatIdx, seedNum := range seeds {
		posToHeat[seedNum-1] = heatIdx
	}
	return posToHeat
}

func dropFeedersFromW1(heatID string, pilotCount int, adv int, k int) ([]domain.SeatFeeder, []int) {
	var feeders []domain.SeatFeeder
	var ranks []int
	for r := adv + 1; r <= k; r++ {
		feeders = append(feeders, domain.SeatFeeder{
			FromHeatID: heatID,
			FromRank:   r,
			IsBye:      r > pilotCount,
		})
		ranks = append(ranks, r)
	}
	return feeders, ranks
}

func buildFeederSeats(feeders []domain.SeatFeeder, seatChannels []uint8) []domain.HeatSeat {
	totalSeats := len(seatChannels)
	if len(feeders) > totalSeats {
		totalSeats = len(feeders)
	}
	seats := make([]domain.HeatSeat, totalSeats)
	for i := 0; i < totalSeats; i++ {
		band := domain.BandRaceband
		ch := uint8(0)
		freq := uint16(0)
		if i < len(seatChannels) {
			if b, c, fr, ok := domain.DecodeBandChannel(seatChannels[i]); ok {
				band, ch, freq = b, c, fr
			}
		}
		if i < len(feeders) {
			fc := feeders[i]
			seats[i] = domain.HeatSeat{
				SeatIndex:    i + 1,
				SourceLabel:  fmt.Sprintf("%s · %s", Ordinal(fc.FromRank), fc.FromHeatID),
				Feeder:       &fc,
				Band:         band,
				Channel:      ch,
				FrequencyMHz: freq,
				Status:       domain.PilotHeatStaged,
				Laps:         []domain.HeatLap{},
			}
		} else {
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
	}
	return seats
}

func buildKnownSeats(
	pilots []seededPilot,
	seatChannels []uint8,
	lastCh map[int]uint8,
	labelFn func(seededPilot) string,
) []domain.HeatSeat {
	n := len(pilots)
	totalSeats := len(seatChannels)
	if n > totalSeats {
		totalSeats = n
	}
	availCh := make([]uint8, 0, len(seatChannels))
	availCh = append(availCh, seatChannels...)

	// `minimise_channel_change`: match pilots whose previous channel is in `availCh` first!
	assignedCh := make([]uint8, totalSeats)
	usedCh := make(map[uint8]bool)
	for i, sp := range pilots {
		if sp.slot.SlotIndex <= 0 {
			continue
		}
		prev := lastCh[sp.slot.SlotIndex]
		if prev > 0 && !usedCh[prev] && containsUint8(availCh, prev) {
			assignedCh[i] = prev
			usedCh[prev] = true
		}
	}
	for i := 0; i < totalSeats; i++ {
		if assignedCh[i] != 0 {
			continue
		}
		for _, ch := range availCh {
			if !usedCh[ch] {
				assignedCh[i] = ch
				usedCh[ch] = true
				break
			}
		}
	}

	seats := make([]domain.HeatSeat, totalSeats)
	for i := 0; i < totalSeats; i++ {
		seatCode := assignedCh[i]
		band, ch, freq, ok := domain.DecodeBandChannel(seatCode)
		if !ok {
			band = domain.BandRaceband
			ch = 0
			freq = 0
		}
		if i < n {
			sp := pilots[i]
			if sp.slot.SlotIndex <= 0 && sp.seed > 0 {
				fc := domain.SeatFeeder{FromStageSeed: sp.seed}
				seats[i] = domain.HeatSeat{
					SeatIndex:    i + 1,
					SourceLabel:  labelFn(sp),
					Feeder:       &fc,
					Band:         band,
					Channel:      ch,
					FrequencyMHz: freq,
					Status:       domain.PilotHeatStaged,
					Laps:         []domain.HeatLap{},
				}
				continue
			}
			prev := lastCh[sp.slot.SlotIndex]
			seats[i] = domain.HeatSeat{
				SeatIndex:      i + 1,
				PilotSlotIndex: sp.slot.SlotIndex,
				Callsign:       sp.slot.Callsign,
				PhoneticName:   sp.slot.PhoneticName,
				Color:          sp.slot.Color,
				Seed:           sp.seed,
				SourceLabel:    labelFn(sp),
				Band:           band,
				Channel:        ch,
				FrequencyMHz:   freq,
				ChannelChanged: prev > 0 && seatCode > 0 && prev != seatCode,
				PrevChannel:    prev,
				Status:         domain.PilotHeatStaged,
				Laps:           []domain.HeatLap{},
			}
		} else {
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
	}
	return seats
}

func losersTitle(round int, idx int, count int, isFinal bool) string {
	if isFinal {
		return "Losers Final"
	}
	if count == 1 {
		return fmt.Sprintf("Losers Round %d", round)
	}
	return fmt.Sprintf("Losers Round %d · Heat %d", round, idx)
}

func makeRange(lo, hi int) []int {
	if hi < lo {
		return nil
	}
	out := make([]int, hi-lo+1)
	for i := range out {
		out[i] = lo + i
	}
	return out
}

func containsUint8(list []uint8, v uint8) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// Ordinal formats 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 4 -> "4th".
func Ordinal(n int) string {
	abs := n
	if abs < 0 {
		abs = -abs
	}
	mod100 := abs % 100
	if mod100 >= 11 && mod100 <= 13 {
		return fmt.Sprintf("%dth", n)
	}
	switch abs % 10 {
	case 1:
		return fmt.Sprintf("%dst", n)
	case 2:
		return fmt.Sprintf("%dnd", n)
	case 3:
		return fmt.Sprintf("%drd", n)
	default:
		return fmt.Sprintf("%dth", n)
	}
}
