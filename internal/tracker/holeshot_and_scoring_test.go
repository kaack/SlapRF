package tracker

import (
	"testing"

	"slaprf/internal/domain"
	"slaprf/internal/race"
)

func TestCompetitiveHoleshotAnnouncementAndPointsBonus(t *testing.T) {
	heat := domain.RaceHeat{
		ID:          "M1-1",
		StageIndex:  1,
		StageFormat: domain.FormatPointsMains,
		StartMode:   domain.StartModeHeadsUp,
		TargetLaps:  2,
		State:       domain.HeatRunning,
		StartToneUs: 1_000_000,
		Seats: []domain.HeatSeat{
			{
				SeatIndex:      1,
				PilotSlotIndex: 1,
				Callsign:       "Alpha",
				Status:         domain.PilotHeatRacing,
				Crossings: []domain.HeatCrossing{
					{CrossingID: 1, TimestampUs: 1_900_000},  // slower holeshot (0.9s)
					{CrossingID: 3, TimestampUs: 12_000_000}, // lap 1
					{CrossingID: 5, TimestampUs: 22_000_000}, // lap 2 -> 1st place finish (21.0s)
				},
			},
			{
				SeatIndex:      2,
				PilotSlotIndex: 2,
				Callsign:       "Bravo",
				Status:         domain.PilotHeatRacing,
				Crossings: []domain.HeatCrossing{
					{CrossingID: 2, TimestampUs: 1_450_000},  // fastest holeshot (0.45s)!
					{CrossingID: 4, TimestampUs: 13_000_000}, // lap 1
					{CrossingID: 6, TimestampUs: 24_500_000}, // lap 2 -> 2nd place finish (23.5s)
				},
			},
		},
	}

	race.RecomputeHeat(&heat, domain.QualMetricConsecutive3)

	// Alpha finished 1st (10 pts, no holeshot) -> 10 pts
	if heat.Seats[0].Position != 1 {
		t.Fatalf("expected Alpha position 1, got %d", heat.Seats[0].Position)
	}
	if heat.Seats[0].HoleshotWinner {
		t.Fatalf("expected Alpha HoleshotWinner=false")
	}
	if heat.Seats[0].Points != 10 {
		t.Fatalf("expected Alpha 10 points, got %d", heat.Seats[0].Points)
	}

	// Bravo finished 2nd (6 pts) + Holeshot bonus (+1 pt) -> 7 pts!
	if heat.Seats[1].Position != 2 {
		t.Fatalf("expected Bravo position 2, got %d", heat.Seats[1].Position)
	}
	if !heat.Seats[1].HoleshotWinner {
		t.Fatalf("expected Bravo HoleshotWinner=true")
	}
	if heat.Seats[1].Points != 7 {
		t.Fatalf("expected Bravo 7 points (6 for 2nd + 1 holeshot), got %d", heat.Seats[1].Points)
	}
}

func TestLiveHoleshotAndCompetitiveWinnerAnnouncements(t *testing.T) {
	eng := seedEngineWithPilots(t, 4)

	eng.ConfigureAndGenerateRace(domain.RaceSetupConfig{
		EventName:     "Points Cup",
		MainFormat:    domain.FormatPointsMains,
		PilotsPerHeat: 4,
		TargetLaps:    1,
		TimeLimitSec:  120,
		CountdownSec:  0,
	}, true)

	st, err := eng.RaceControlAction("start", "")
	if err != nil {
		t.Fatalf("start heat failed: %v", err)
	}
	if st.ActiveHeatID == "" {
		t.Fatalf("expected active heat ID")
	}

	eng.mu.Lock()
	targetHeat := eng.findHeatLocked(eng.raceState.ActiveHeatID)
	secondPilot := targetHeat.Seats[1].PilotSlotIndex
	secondCallsign := targetHeat.Seats[1].Callsign

	// First start-gate pass in the heat -> should emit "holeshot" announcement!
	changed, _, hsAnn := eng.recordRaceCrossingLocked(domain.GateCrossingEvent{
		EventID:       101,
		SlotIndex:     secondPilot,
		TimestampUs:   targetHeat.StartToneUs + 620_000,
		PeakRSSIDbm:   -52,
		IsStartFinish: true,
	}, nil)
	if !changed || hsAnn == nil {
		eng.mu.Unlock()
		t.Fatalf("expected holeshot announcement on first crossing, got changed=%v ann=%+v", changed, hsAnn)
	}
	if hsAnn.Kind != "holeshot" || hsAnn.Callsign != secondCallsign || !hsAnn.Competitive {
		eng.mu.Unlock()
		t.Fatalf("unexpected holeshot announcement: %+v", hsAnn)
	}

	// Second start-gate pass completes Lap 1 (1-lap competitive heat) -> should emit competitive 1st-place pilot_finished!
	changed2, _, winAnn := eng.recordRaceCrossingLocked(domain.GateCrossingEvent{
		EventID:       102,
		SlotIndex:     secondPilot,
		TimestampUs:   targetHeat.StartToneUs + 15_400_000,
		PeakRSSIDbm:   -50,
		IsStartFinish: true,
	}, nil)
	eng.mu.Unlock()

	if !changed2 || winAnn == nil {
		t.Fatalf("expected pilot_finished announcement, got changed=%v ann=%+v", changed2, winAnn)
	}
	if winAnn.Kind != "pilot_finished" || winAnn.Position != 1 || !winAnn.Competitive || winAnn.Callsign != secondCallsign {
		t.Fatalf("unexpected winner announcement: %+v", winAnn)
	}
}
