package race

import (
	"fmt"
	"math"
	"math/rand"

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
		for round := 1; round <= cfg.QualifyingRounds; round++ {
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

	for round := 1; round <= cfg.QualifyingRounds; round++ {
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

	// Power-of-2 number of Round 1 heats so each round halves cleanly down to 1 Final heat.
	m := 1
	for m*k < len(seeded) {
		m *= 2
	}
	buckets := snakeDistribute(seeded, m)

	var heats []domain.RaceHeat
	var edges []domain.BracketEdge
	order := orderOffset

	// Round 1
	prevHeatIDs := make([]string, m)
	for hIdx := 0; hIdx < m; hIdx++ {
		order++
		hid := fmt.Sprintf("W1-%d", hIdx+1)
		prevHeatIDs[hIdx] = hid
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
			ExpectedWinners: adv,
			State:           domain.HeatReady,
			Seats:           seats,
		}
		RecomputeHeat(&h, cfg.QualifyingMetric)
		heats = append(heats, h)
	}

	roundNum := 1
	for len(prevHeatIDs) > 1 {
		roundNum++
		nextCount := len(prevHeatIDs) / 2
		nextIDs := make([]string, nextCount)
		isFinal := nextCount == 1
		for hIdx := 0; hIdx < nextCount; hIdx++ {
			order++
			srcA := prevHeatIDs[2*hIdx]
			srcB := prevHeatIDs[2*hIdx+1]
			var hid, title, lane string
			expWin := adv
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
			}
			nextIDs[hIdx] = hid

			var feeders []domain.SeatFeeder
			advRanks := makeRange(1, adv)
			for _, r := range advRanks {
				feeders = append(feeders, domain.SeatFeeder{FromHeatID: srcA, FromRank: r})
			}
			for _, r := range advRanks {
				feeders = append(feeders, domain.SeatFeeder{FromHeatID: srcB, FromRank: r})
			}
			edges = append(edges,
				domain.BracketEdge{FromHeatID: srcA, ToHeatID: hid, Ranks: advRanks},
				domain.BracketEdge{FromHeatID: srcB, ToHeatID: hid, Ranks: advRanks},
			)
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
		}
		prevHeatIDs = nextIDs
	}

	return heats, edges
}

// generateDoubleElimination builds a standard MultiGP / FPVTrackside Double Elimination bracket
// (8-pilot 6-heat, 16-pilot 14-heat, 32-pilot 30-heat, or compact <=4-pilot bracket) with
// balanced snake seeding, automatic bye detection, and Single Final or Chase the Ace Finals.
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

	// Standard bracket sizing: M = 2^m Round-1 Winners heats where M * k >= len(seeded), M >= 2.
	m := 2
	for m*k < len(seeded) {
		m *= 2
	}
	buckets := snakeDistribute(seeded, m)
	bucketSizes := make(map[string]int)

	var heats []domain.RaceHeat
	var edges []domain.BracketEdge
	order := orderOffset
	wCol := 1
	lCol := 1

	// Winners Round 1 (m heats)
	wPrev := make([]string, m)
	for hIdx := 0; hIdx < m; hIdx++ {
		order++
		hid := fmt.Sprintf("W1-%d", hIdx+1)
		wPrev[hIdx] = hid
		bucketSizes[hid] = len(buckets[hIdx])
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
			StageName:       "Double Elimination",
			StageFormat:     domain.FormatDoubleElimination,
			Round:           1,
			Column:          wCol,
			Order:           order,
			BracketLane:     "winners",
			Title:           fmt.Sprintf("Winners Round 1 · Heat %d", hIdx+1),
			ShortLabel:      hid,
			StartMode:       domain.StartModeHeadsUp,
			TargetLaps:      cfg.TargetLaps,
			TimeLimitSec:    cfg.TimeLimitSec,
			ExpectedWinners: adv,
			State:           domain.HeatReady,
			Seats:           seats,
		}
		RecomputeHeat(&h, cfg.QualifyingMetric)
		heats = append(heats, h)
	}

	// Losers Round 1 (m/2 heats): fed by drops (ranks adv+1..k) from pairs of W1 heats, aligned directly below W1.
	lRoundNum := 1
	lPrev := make([]string, m/2)
	for hIdx := 0; hIdx < m/2; hIdx++ {
		order++
		hid := fmt.Sprintf("L1-%d", hIdx+1)
		lPrev[hIdx] = hid
		srcA := wPrev[2*hIdx]
		srcB := wPrev[2*hIdx+1]
		feeders, ranksA := dropFeedersFromW1(srcA, bucketSizes[srcA], adv, k)
		feedersB, ranksB := dropFeedersFromW1(srcB, bucketSizes[srcB], adv, k)
		feeders = append(feeders, feedersB...)
		if len(ranksA) > 0 {
			edges = append(edges, domain.BracketEdge{FromHeatID: srcA, ToHeatID: hid, Ranks: ranksA, IsDrop: true})
		}
		if len(ranksB) > 0 {
			edges = append(edges, domain.BracketEdge{FromHeatID: srcB, ToHeatID: hid, Ranks: ranksB, IsDrop: true})
		}
		heats = append(heats, domain.RaceHeat{
			ID:              hid,
			StageIndex:      stageIdx,
			StageName:       "Double Elimination",
			StageFormat:     domain.FormatDoubleElimination,
			Round:           1,
			Column:          lCol,
			Order:           order,
			BracketLane:     "losers",
			Title:           losersTitle(1, hIdx+1, m/2, false),
			ShortLabel:      hid,
			StartMode:       domain.StartModeHeadsUp,
			TargetLaps:      cfg.TargetLaps,
			TimeLimitSec:    cfg.TimeLimitSec,
			ExpectedWinners: adv,
			State:           domain.HeatWaiting,
			Seats:           buildFeederSeats(feeders, cfg.SeatChannels),
		})
	}

	advRanks := makeRange(1, adv)
	dropRanks := makeRange(adv+1, k)
	wRoundNum := 1

	// Step through remaining Winners rounds + corresponding Losers major/minor rounds.
	for len(wPrev) > 1 {
		wCol++
		wRoundNum++
		wCount := len(wPrev) / 2
		wCurr := make([]string, wCount)
		isWinnersFinal := wCount == 1
		for hIdx := 0; hIdx < wCount; hIdx++ {
			order++
			hid := fmt.Sprintf("W%d-%d", wRoundNum, hIdx+1)
			wCurr[hIdx] = hid
			srcA := wPrev[2*hIdx]
			srcB := wPrev[2*hIdx+1]
			var feeders []domain.SeatFeeder
			for _, r := range advRanks {
				feeders = append(feeders, domain.SeatFeeder{FromHeatID: srcA, FromRank: r})
			}
			for _, r := range advRanks {
				feeders = append(feeders, domain.SeatFeeder{FromHeatID: srcB, FromRank: r})
			}
			edges = append(edges,
				domain.BracketEdge{FromHeatID: srcA, ToHeatID: hid, Ranks: advRanks},
				domain.BracketEdge{FromHeatID: srcB, ToHeatID: hid, Ranks: advRanks},
			)
			title := fmt.Sprintf("Winners Round %d · Heat %d", wRoundNum, hIdx+1)
			if isWinnersFinal {
				title = "Winners Final"
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
				ExpectedWinners: adv,
				State:           domain.HeatWaiting,
				Seats:           buildFeederSeats(feeders, cfg.SeatChannels),
			})
		}

		// Major Losers round: cross-pairs drops from wCurr (reversed) with survivors from lPrev!
		lCol++
		if lCol < wCol {
			lCol = wCol
		}
		lRoundNum++
		lMajor := make([]string, wCount)
		isLosersFinal := isWinnersFinal && wCount == 1
		for hIdx := 0; hIdx < wCount; hIdx++ {
			order++
			hid := fmt.Sprintf("L%d-%d", lRoundNum, hIdx+1)
			lMajor[hIdx] = hid
			dropSrc := wCurr[wCount-1-hIdx] // Cross-bracket to avoid immediate rematches!
			survSrc := lPrev[hIdx]
			var feeders []domain.SeatFeeder
			for _, r := range dropRanks {
				feeders = append(feeders, domain.SeatFeeder{FromHeatID: dropSrc, FromRank: r})
			}
			for _, r := range advRanks {
				feeders = append(feeders, domain.SeatFeeder{FromHeatID: survSrc, FromRank: r})
			}
			edges = append(edges,
				domain.BracketEdge{FromHeatID: dropSrc, ToHeatID: hid, Ranks: dropRanks, IsDrop: true},
				domain.BracketEdge{FromHeatID: survSrc, ToHeatID: hid, Ranks: advRanks},
			)
			heats = append(heats, domain.RaceHeat{
				ID:              hid,
				StageIndex:      stageIdx,
				StageName:       "Double Elimination",
				StageFormat:     domain.FormatDoubleElimination,
				Round:           lRoundNum,
				Column:          lCol,
				Order:           order,
				BracketLane:     "losers",
				Title:           losersTitle(lRoundNum, hIdx+1, wCount, isLosersFinal),
				ShortLabel:      hid,
				StartMode:       domain.StartModeHeadsUp,
				TargetLaps:      cfg.TargetLaps,
				TimeLimitSec:    cfg.TimeLimitSec,
				ExpectedWinners: adv,
				State:           domain.HeatWaiting,
				Seats:           buildFeederSeats(feeders, cfg.SeatChannels),
			})
		}

		// Minor Losers consolidation round if more than 1 Losers heat remains.
		if len(lMajor) > 1 {
			lCol++
			lRoundNum++
			lMinorCount := len(lMajor) / 2
			lMinor := make([]string, lMinorCount)
			for hIdx := 0; hIdx < lMinorCount; hIdx++ {
				order++
				hid := fmt.Sprintf("L%d-%d", lRoundNum, hIdx+1)
				lMinor[hIdx] = hid
				srcA := lMajor[2*hIdx]
				srcB := lMajor[2*hIdx+1]
				var feeders []domain.SeatFeeder
				for _, r := range advRanks {
					feeders = append(feeders, domain.SeatFeeder{FromHeatID: srcA, FromRank: r})
				}
				for _, r := range advRanks {
					feeders = append(feeders, domain.SeatFeeder{FromHeatID: srcB, FromRank: r})
				}
				edges = append(edges,
					domain.BracketEdge{FromHeatID: srcA, ToHeatID: hid, Ranks: advRanks},
					domain.BracketEdge{FromHeatID: srcB, ToHeatID: hid, Ranks: advRanks},
				)
				heats = append(heats, domain.RaceHeat{
					ID:              hid,
					StageIndex:      stageIdx,
					StageName:       "Double Elimination",
					StageFormat:     domain.FormatDoubleElimination,
					Round:           lRoundNum,
					Column:          lCol,
					Order:           order,
					BracketLane:     "losers",
					Title:           losersTitle(lRoundNum, hIdx+1, lMinorCount, false),
					ShortLabel:      hid,
					StartMode:       domain.StartModeHeadsUp,
					TargetLaps:      cfg.TargetLaps,
					TimeLimitSec:    cfg.TimeLimitSec,
					ExpectedWinners: adv,
					State:           domain.HeatWaiting,
					Seats:           buildFeederSeats(feeders, cfg.SeatChannels),
				})
			}
			lPrev = lMinor
		} else {
			lPrev = lMajor
		}
		wPrev = wCurr
	}

	// Finals: Top `adv` from Winners Final (wPrev[0]) + Top `adv` from Losers Final (lPrev[0])
	finalCol := lCol + 1
	if wCol+1 > finalCol {
		finalCol = wCol + 1
	}
	order++
	wFinalID := wPrev[0]
	lFinalID := lPrev[0]
	var finalFeeders []domain.SeatFeeder
	for _, r := range advRanks {
		finalFeeders = append(finalFeeders, domain.SeatFeeder{FromHeatID: wFinalID, FromRank: r})
	}
	for _, r := range advRanks {
		finalFeeders = append(finalFeeders, domain.SeatFeeder{FromHeatID: lFinalID, FromRank: r})
	}

	finalID := "GF-1"
	finalTitle := "Grand Final"
	if cfg.FinalsFormat == domain.FinalsChaseTheAce {
		finalID = "CTA-1"
		finalTitle = fmt.Sprintf("Chase the Ace · Heat 1 (First to %d Wins)", cfg.AceWinsRequired)
	}
	edges = append(edges,
		domain.BracketEdge{FromHeatID: wFinalID, ToHeatID: finalID, Ranks: advRanks},
		domain.BracketEdge{FromHeatID: lFinalID, ToHeatID: finalID, Ranks: advRanks},
	)
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

// bracketHeatSeedOrder returns the 0-based heat indices in standard tournament bracket placement order for power-of-2 `m`.
func bracketHeatSeedOrder(m int) []int {
	if m <= 1 {
		return []int{0}
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
	seats := make([]domain.HeatSeat, len(feeders))
	for i, f := range feeders {
		fc := f
		band := domain.BandRaceband
		ch := uint8(0)
		freq := uint16(0)
		if i < len(seatChannels) {
			if b, c, fr, ok := domain.DecodeBandChannel(seatChannels[i]); ok {
				band, ch, freq = b, c, fr
			}
		}
		seats[i] = domain.HeatSeat{
			SeatIndex:    i + 1,
			SourceLabel:  fmt.Sprintf("%s · %s", Ordinal(f.FromRank), f.FromHeatID),
			Feeder:       &fc,
			Band:         band,
			Channel:      ch,
			FrequencyMHz: freq,
			Status:       domain.PilotHeatStaged,
			Laps:         []domain.HeatLap{},
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
