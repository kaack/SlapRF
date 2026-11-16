package race

import (
	"fmt"
	"testing"

	"slaprf/internal/domain"
)

func makeTestRoster(n int) []domain.PilotSlot {
	out := make([]domain.PilotSlot, n)
	for i := 0; i < n; i++ {
		out[i] = domain.PilotSlot{
			SlotIndex: i + 1,
			Callsign:  fmt.Sprintf("Pilot%d", i+1),
			Color:     domain.DefaultPilotColors[i%len(domain.DefaultPilotColors)],
		}
	}
	return out
}

func simulateConfirmBySeed(h *domain.RaceHeat, cfg domain.RaceSetupConfig) {
	h.StartToneUs = 1_000_000
	for si := range h.Seats {
		s := &h.Seats[si]
		if s.PilotSlotIndex <= 0 {
			continue
		}
		// Lower seed finishes slightly faster
		baseLapUs := uint64(12_000_000 + s.Seed*250_000)
		tUs := h.StartToneUs + uint64(400_000+s.Seed*20_000)
		s.Crossings = []domain.HeatCrossing{{CrossingID: uint64(si*10 + 1), TimestampUs: tUs}}
		laps := h.TargetLaps
		if laps == 0 {
			laps = 4
		}
		for l := 1; l <= laps; l++ {
			tUs += baseLapUs
			s.Crossings = append(s.Crossings, domain.HeatCrossing{
				CrossingID:  uint64(si*10 + 1 + l),
				TimestampUs: tUs,
			})
		}
		s.Status = domain.PilotHeatFinished
	}
	h.State = domain.HeatConfirmed
	RecomputeHeat(h, cfg.QualifyingMetric)
}

func TestDoubleElimination16PilotsChaseTheAce(t *testing.T) {
	roster := makeTestRoster(16)
	cfg := domain.DefaultRaceSetupConfig()
	cfg.MainFormat = domain.FormatDoubleElimination
	cfg.FinalsFormat = domain.FinalsChaseTheAce
	cfg.AceWinsRequired = 2

	st := GenerateTournament(cfg, roster, 42)
	if len(st.Heats) != 14 {
		t.Fatalf("expected 14 initial heats in 16-pilot MultiGP Double Elimination, got %d", len(st.Heats))
	}

	// Run all 13 pre-final heats in order
	for step := 0; step < 20; step++ {
		if st.NextReadyHeatID == "" || st.NextReadyHeatID == "CTA-1" {
			break
		}
		for i := range st.Heats {
			if st.Heats[i].ID == st.NextReadyHeatID {
				simulateConfirmBySeed(&st.Heats[i], cfg)
				break
			}
		}
		ResolveTournament(&st, roster)
	}

	if st.NextReadyHeatID != "CTA-1" {
		t.Fatalf("expected CTA-1 to be ready after 13 bracket heats, got %q", st.NextReadyHeatID)
	}

	// CTA-1: Pilot1 (Seed #1) wins -> 1 Ace (needs 2 Aces -> spawns CTA-2)
	for i := range st.Heats {
		if st.Heats[i].ID == "CTA-1" {
			simulateConfirmBySeed(&st.Heats[i], cfg)
		}
	}
	ResolveTournament(&st, roster)
	if st.IsComplete {
		t.Fatalf("expected tournament not complete after 1 Ace win")
	}
	if st.NextReadyHeatID != "CTA-2" {
		t.Fatalf("expected CTA-2 spawned and ready, got %q", st.NextReadyHeatID)
	}

	// CTA-2: Manual override makes 2nd seat win CTA-2 -> still nobody at 2 Aces -> spawns CTA-3!
	for i := range st.Heats {
		if st.Heats[i].ID == "CTA-2" {
			simulateConfirmBySeed(&st.Heats[i], cfg)
			for si := range st.Heats[i].Seats {
				if st.Heats[i].Seats[si].Seed == 2 {
					st.Heats[i].Seats[si].ManualPosition = 1
				}
			}
			RecomputeHeat(&st.Heats[i], cfg.QualifyingMetric)
		}
	}
	ResolveTournament(&st, roster)
	if st.IsComplete || st.NextReadyHeatID != "CTA-3" {
		t.Fatalf("expected CTA-3 spawned after split wins, complete=%v next=%q", st.IsComplete, st.NextReadyHeatID)
	}

	// CTA-3: Seed #1 wins 2nd Ace -> crowned Champion!
	for i := range st.Heats {
		if st.Heats[i].ID == "CTA-3" {
			simulateConfirmBySeed(&st.Heats[i], cfg)
		}
	}
	ResolveTournament(&st, roster)
	if !st.IsComplete || st.ChampionCallsign != "Pilot1" {
		t.Fatalf("expected Pilot1 crowned Champion after 2nd Ace, complete=%v champ=%q", st.IsComplete, st.ChampionCallsign)
	}
}

func TestNonPowerOfTwoByes10PilotsAndTwoStageQualifying(t *testing.T) {
	roster := domain.DefaultPilotSlots() // 10 simulated Bay Area pilots
	cfg := domain.DefaultRaceSetupConfig()
	cfg.Structure = domain.StructureTwoStage
	cfg.QualifyingRounds = 2
	cfg.MainFormat = domain.FormatDoubleElimination
	cfg.FinalsFormat = domain.FinalsSingle

	st := GenerateTournament(cfg, roster, 1)
	if st.ActiveStageIndex != 1 || st.TotalStages != 2 {
		t.Fatalf("expected stage 1 of 2, got %d/%d", st.ActiveStageIndex, st.TotalStages)
	}

	// Stage 2 heats must ALREADY exist upfront with "Seed #1..#10" placeholders in Waiting state!
	stage2Placeholders := 0
	for _, h := range st.Heats {
		if h.StageIndex == 2 {
			if h.State != domain.HeatWaiting {
				t.Fatalf("expected Stage 2 heat %s to start in Waiting state, got %s", h.ID, h.State)
			}
			for _, s := range h.Seats {
				if s.Feeder != nil && s.Feeder.FromStageSeed > 0 {
					stage2Placeholders++
					if s.PilotSlotIndex != 0 {
						t.Fatalf("expected unpopulated placeholder on %s seat %d, got slot %d", h.ID, s.SeatIndex, s.PilotSlotIndex)
					}
				}
			}
		}
	}
	if stage2Placeholders != 10 {
		t.Fatalf("expected 10 Stage 2 FromStageSeed placeholders upfront, got %d", stage2Placeholders)
	}

	// Confirm only the first Stage 1 heat -> CanStartStage2 (Early Seeding) becomes true, still in Stage 1
	for i := range st.Heats {
		if st.Heats[i].ID == st.NextReadyHeatID {
			simulateConfirmBySeed(&st.Heats[i], cfg)
			break
		}
	}
	ResolveTournament(&st, roster)
	if st.ActiveStageIndex != 1 || st.QualifyingComplete || !st.CanStartStage2 {
		t.Fatalf("after 1st qual heat expected stage=1 complete=false canStartEarly=true, got stage=%d complete=%v canStart=%v",
			st.ActiveStageIndex, st.QualifyingComplete, st.CanStartStage2)
	}

	// Complete remaining Stage 1 qualifying heats -> automatically seeds Stage 2 and advances ActiveStageIndex to 2!
	var lastStage1HeatID string
	for st.ActiveStageIndex == 1 && st.NextReadyHeatID != "" {
		for i := range st.Heats {
			if st.Heats[i].ID == st.NextReadyHeatID {
				lastStage1HeatID = st.Heats[i].ID
				simulateConfirmBySeed(&st.Heats[i], cfg)
				break
			}
		}
		ResolveTournament(&st, roster)
	}
	if !st.QualifyingComplete || st.ActiveStageIndex != 2 {
		t.Fatalf("expected QualifyingComplete=true and auto-advance to Stage 2, got complete=%v stage=%d", st.QualifyingComplete, st.ActiveStageIndex)
	}

	// Before any Stage 2 heat starts, Stage 1 heats remain unlockable; unlocking reverts Stage 2 back to placeholders!
	for i := range st.Heats {
		if st.Heats[i].ID == lastStage1HeatID {
			if !st.Heats[i].CanUnlock {
				t.Fatalf("expected Stage 1 heat %s to remain unlockable before Stage 2 starts", lastStage1HeatID)
			}
			st.Heats[i].State = domain.HeatFinished
			break
		}
	}
	ResolveTournament(&st, roster)
	if st.ActiveStageIndex != 1 || st.QualifyingComplete {
		t.Fatalf("expected unlocking Stage 1 heat to revert ActiveStageIndex=1, got stage=%d complete=%v", st.ActiveStageIndex, st.QualifyingComplete)
	}
	for _, h := range st.Heats {
		if h.StageIndex == 2 && h.ID == "W1-1" && h.State != domain.HeatWaiting {
			t.Fatalf("expected W1-1 to revert to Waiting when Stage 1 unlocked, got %s", h.State)
		}
	}

	// Re-confirm the unlocked Stage 1 heat -> Stage 2 re-populates automatically
	for i := range st.Heats {
		if st.Heats[i].ID == lastStage1HeatID {
			st.Heats[i].State = domain.HeatConfirmed
			break
		}
	}
	ResolveTournament(&st, roster)
	if st.ActiveStageIndex != 2 {
		t.Fatalf("expected ActiveStageIndex == 2 after re-confirming Stage 1, got %d", st.ActiveStageIndex)
	}

	// Run entire 10-pilot Double Elimination with byes to completion
	safety := 0
	for !st.IsComplete && st.NextReadyHeatID != "" && safety < 30 {
		safety++
		for i := range st.Heats {
			if st.Heats[i].ID == st.NextReadyHeatID {
				simulateConfirmBySeed(&st.Heats[i], cfg)
				break
			}
		}
		ResolveTournament(&st, roster)
	}
	if !st.IsComplete || st.ChampionCallsign == "" {
		t.Fatalf("expected 10-pilot bracket with byes to complete cleanly, complete=%v champ=%q next=%q",
			st.IsComplete, st.ChampionCallsign, st.NextReadyHeatID)
	}
}

func TestLapInvalidationRecomputesAdjacentSplit(t *testing.T) {
	h := domain.RaceHeat{
		ID:              "W1-1",
		StageFormat:     domain.FormatDoubleElimination,
		StartMode:       domain.StartModeHeadsUp,
		TargetLaps:      3,
		ExpectedWinners: 2,
		StartToneUs:     1_000_000,
		State:           domain.HeatRunning,
		Seats: []domain.HeatSeat{
			{
				SeatIndex:      1,
				PilotSlotIndex: 1,
				Callsign:       "FAERRY",
				Status:         domain.PilotHeatRacing,
				Crossings: []domain.HeatCrossing{
					{CrossingID: 1, TimestampUs: 1_500_000},  // Holeshot (0.5s)
					{CrossingID: 2, TimestampUs: 6_500_000},  // False early trigger at 5.0s!
					{CrossingID: 3, TimestampUs: 15_500_000}, // True Lap 1 completion (14.0s from holeshot)
				},
			},
		},
	}

	RecomputeHeat(&h, domain.QualMetricConsecutive3)
	if h.Seats[0].LapsCompleted != 2 {
		t.Fatalf("expected 2 laps before invalidation, got %d", h.Seats[0].LapsCompleted)
	}

	// Marshal invalidates false crossing #2 -> crossing #3 seamlessly becomes Lap 1 with 14.0s split!
	h.Seats[0].Crossings[1].Invalidated = true
	RecomputeHeat(&h, domain.QualMetricConsecutive3)
	if h.Seats[0].LapsCompleted != 1 || h.Seats[0].BestLapSec != 14.0 {
		t.Fatalf("expected 1 lap of 14.0s after invalidating false pass, got laps=%d best=%.3f",
			h.Seats[0].LapsCompleted, h.Seats[0].BestLapSec)
	}
}

func TestDNSAttendanceAutoByeAndManualLockPersistence(t *testing.T) {
	roster := makeTestRoster(7) // 7 pilots in 4-up -> W1-1 has 4 pilots, W1-2 has 3 pilots + 1 Open/BYE seat
	cfg := domain.DefaultRaceSetupConfig()
	cfg.MainFormat = domain.FormatDoubleElimination
	cfg.FinalsFormat = domain.FinalsSingle

	st := GenerateTournament(cfg, roster, 7)
	// Verify Seed #1's heat (W1-1) receives the BYE and is padded to 4 seats with 4th seat open
	var w11 *domain.RaceHeat
	for i := range st.Heats {
		if st.Heats[i].ID == "W1-1" {
			w11 = &st.Heats[i]
		}
	}
	if w11 == nil || len(w11.Seats) != 4 || w11.Seats[3].PilotSlotIndex != 0 {
		t.Fatalf("expected W1-1 padded to 4 seats with 4th seat open (Seed #1 bye), got %+v", w11)
	}

	// Manually lock a pilot into GF-1 Seat 4 before upstream heats run
	for i := range st.Heats {
		if st.Heats[i].ID == "GF-1" {
			st.Heats[i].Seats[3].PilotSlotIndex = 7
			st.Heats[i].Seats[3].Callsign = "Pilot7"
			st.Heats[i].Seats[3].ManualLock = true
		}
	}

	// Confirm W1-1 and W1-2, then mark 2 of the 3 dropped pilots as Left Event -> L1-1 only has 1 active pilot (<= 2 ExpectedWinners) -> auto-bye!
	for i := range st.Heats {
		if st.Heats[i].ID == "W1-1" || st.Heats[i].ID == "W1-2" {
			simulateConfirmBySeed(&st.Heats[i], cfg)
		}
	}
	// First resolve without attendance to see who dropped to L1-1
	ResolveTournament(&st, roster)
	var l1 *domain.RaceHeat
	for i := range st.Heats {
		if st.Heats[i].ID == "L1-1" {
			l1 = &st.Heats[i]
		}
	}
	if l1 == nil || l1.State != domain.HeatReady {
		t.Fatalf("expected L1-1 ready with 3 dropped pilots, got %+v", l1)
	}

	// Now mark 2 of the dropped pilots in L1-1 as AttendanceForfeit and set their unstarted seat to DNS:
	// with 1 active pilot remaining (>= 1), L1-1 MUST remain Ready so the pilot actually flies the heat!
	att := make(map[int]domain.PilotAttendance)
	scratched := 0
	for si := range l1.Seats {
		if l1.Seats[si].PilotSlotIndex > 0 && scratched < 2 {
			att[l1.Seats[si].PilotSlotIndex] = domain.AttendanceForfeit
			l1.Seats[si].Status = domain.PilotHeatDNS
			scratched++
		}
	}
	ResolveTournamentWithAttendance(&st, roster, att)
	if l1.State != domain.HeatReady {
		t.Fatalf("expected L1-1 to remain Ready when 1 active pilot still needs to race, got state=%s note=%q", l1.State, l1.Note)
	}

	// Now mark the final remaining pilot in L1-1 as forfeited so 0 active pilots remain -> auto-skip empty bye heat!
	for si := range l1.Seats {
		if l1.Seats[si].PilotSlotIndex > 0 && att[l1.Seats[si].PilotSlotIndex] != domain.AttendanceForfeit {
			att[l1.Seats[si].PilotSlotIndex] = domain.AttendanceForfeit
			l1.Seats[si].Status = domain.PilotHeatDNS
		}
	}
	ResolveTournamentWithAttendance(&st, roster, att)
	if l1.State != domain.HeatConfirmed || l1.Note != "Auto-advance (bye)" {
		t.Fatalf("expected empty L1-1 (0 active pilots) to auto-skip, got state=%s note=%q", l1.State, l1.Note)
	}

	// Verify GF-1 Seat 4 kept its ManualLock pilot untouched!
	for _, h := range st.Heats {
		if h.ID == "GF-1" && (h.Seats[3].PilotSlotIndex != 7 || !h.Seats[3].ManualLock) {
			t.Fatalf("expected ManualLock on GF-1 Seat 4 to survive upstream confirmations, got %+v", h.Seats[3])
		}
	}
}

func TestDoubleElimRedemptionHeatWithDroppedPilotStaysReady(t *testing.T) {
	for _, nPilots := range []int{5, 6, 9} {
		cfg := domain.DefaultRaceSetupConfig()
		cfg.Structure = domain.StructureSingleStage
		cfg.MainFormat = domain.FormatDoubleElimination
		cfg.PilotsPerHeat = 4

		roster := makeTestRoster(nPilots)
		st := GenerateTournament(cfg, roster, 7)

		// Confirm all Winners Round 1 heats so 3rd/4th-place pilots drop into Redemption Round 1 (L1-*)
		for i := range st.Heats {
			if st.Heats[i].BracketLane == "winners" && st.Heats[i].Round == 1 {
				simulateConfirmBySeed(&st.Heats[i], cfg)
			}
		}
		ResolveTournament(&st, roster)

		foundPopulatedRedemption := false
		for _, h := range st.Heats {
			if h.BracketLane != "losers" || h.Round != 1 {
				continue
			}
			activeCount := 0
			for _, s := range h.Seats {
				if s.PilotSlotIndex > 0 && s.Status != domain.PilotHeatDNS && s.Status != domain.PilotHeatDQ {
					activeCount++
					if s.Status != domain.PilotHeatStaged || s.Position != 0 {
						t.Fatalf("nPilots=%d heat %s: expected dropped pilot %s to be staged with position=0 before racing, got status=%s pos=%d",
							nPilots, h.ID, s.Callsign, s.Status, s.Position)
					}
				}
			}
			if activeCount > 0 {
				foundPopulatedRedemption = true
				if h.State != domain.HeatReady {
					t.Fatalf("nPilots=%d heat %s: expected Ready with %d dropped pilot(s), got state=%s note=%q",
						nPilots, h.ID, activeCount, h.State, h.Note)
				}
			}
		}
		if !foundPopulatedRedemption {
			t.Fatalf("nPilots=%d: expected at least one Redemption Round 1 heat with a dropped pilot", nPilots)
		}
	}
}

func TestOpenQualifierTitleAndConsecutive2Metric(t *testing.T) {
	cfg := domain.DefaultRaceSetupConfig()
	cfg.Structure = domain.StructureSingleStage
	cfg.MainFormat = domain.FormatOpenQualifier
	cfg.QualifyingMetric = domain.QualMetricConsecutive2
	roster := makeTestRoster(4)

	st := GenerateTournament(cfg, roster, 4)

	var oqRound *domain.RaceRound
	for i := range st.Rounds {
		if st.Rounds[i].ID == "stage1-open-qual" {
			oqRound = &st.Rounds[i]
			break
		}
	}
	if oqRound == nil {
		t.Fatalf("expected stage1-open-qual round to exist")
	}
	if oqRound.Title != "Open Qualifier" {
		t.Fatalf("expected stage1-open-qual round title 'Open Qualifier', got %q", oqRound.Title)
	}

	// Verify Consecutive-2 metric ranks a pilot with faster 2-lap burst ahead of a pilot with faster 3-lap sum
	st.Heats = append(st.Heats, domain.RaceHeat{
		ID:          "OQ-1",
		StageIndex:  1,
		StageFormat: domain.FormatOpenQualifier,
		Round:       1,
		RoundID:     "stage1-open-qual",
		Order:       1,
		Title:       "Open Qualifier · Pack 1",
		ShortLabel:  "OQ-1",
		State:       domain.HeatConfirmed,
		Seats: []domain.HeatSeat{
			{
				SeatIndex:           0,
				PilotSlotIndex:      1,
				Callsign:            "Pilot1",
				LapsCompleted:       3,
				BestLapSec:          14.5,
				BestConsecutive2Sec: 30.0,
				BestConsecutive3Sec: 45.0,
				Status:              domain.PilotHeatFinished,
			},
			{
				SeatIndex:           1,
				PilotSlotIndex:      2,
				Callsign:            "Pilot2",
				LapsCompleted:       3,
				BestLapSec:          13.8,
				BestConsecutive2Sec: 28.2,
				BestConsecutive3Sec: 48.5,
				Status:              domain.PilotHeatFinished,
			},
		},
	})
	ResolveTournament(&st, roster)
	if len(st.Standings) < 2 {
		t.Fatalf("expected standings to have at least 2 entries, got %d", len(st.Standings))
	}
	if st.Standings[0].PilotSlotIndex != 2 {
		t.Fatalf("expected Pilot2 (28.2s Consec-2) ranked #1 under consecutive_2 metric, got slot %d", st.Standings[0].PilotSlotIndex)
	}
	if st.Standings[0].BestConsecutive2Sec != 28.2 {
		t.Fatalf("expected BestConsecutive2Sec=28.2, got %v", st.Standings[0].BestConsecutive2Sec)
	}
}
