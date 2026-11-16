package race

import (
	"fmt"
	"testing"

	"slaprf/internal/domain"
)

func makeBalancedQualRoster(n int) []domain.PilotSlot {
	out := make([]domain.PilotSlot, 0, n)
	channels := []uint8{1, 3, 6, 8}
	for i := 0; i < n; i++ {
		out = append(out, domain.PilotSlot{
			SlotIndex:    i + 1,
			Callsign:     fmt.Sprintf("P%02d", i+1),
			PhoneticName: fmt.Sprintf("Pilot %d", i+1),
			Color:        "#60a5fa",
			Channel:      channels[i%len(channels)],
			Enabled:      true,
		})
	}
	return out
}

func assertQualifyingScheduleInvariants(t *testing.T, heats []domain.RaceHeat, pilots []domain.PilotSlot, rounds int) {
	t.Helper()
	byRound := make(map[int][]domain.RaceHeat)
	for _, h := range heats {
		byRound[h.Round] = append(byRound[h.Round], h)
	}
	if len(byRound) != rounds {
		t.Fatalf("expected %d rounds, got %d", rounds, len(byRound))
	}

	pilotChannel := make(map[int]uint8)
	pairHistory := make(map[[2]int]int)

	for r := 1; r <= rounds; r++ {
		rHeats := byRound[r]
		if len(rHeats) == 0 {
			t.Fatalf("round %d has 0 heats", r)
		}
		seenInRound := make(map[int]bool)
		minOcc := 999
		maxOcc := 0

		for _, h := range rHeats {
			var seated []int
			usedCh := make(map[uint8]bool)
			for _, s := range h.Seats {
				if s.PilotSlotIndex <= 0 {
					continue
				}
				if seenInRound[s.PilotSlotIndex] {
					t.Fatalf("round %d seats pilot %d twice", r, s.PilotSlotIndex)
				}
				seenInRound[s.PilotSlotIndex] = true
				if usedCh[s.Channel] {
					t.Fatalf("heat %s has duplicate channel %d", h.ID, s.Channel)
				}
				usedCh[s.Channel] = true

				if prevCh, ok := pilotChannel[s.PilotSlotIndex]; ok && prevCh != s.Channel {
					t.Fatalf("pilot %d switched channel between rounds (%d -> %d) in heat %s", s.PilotSlotIndex, prevCh, s.Channel, h.ID)
				}
				pilotChannel[s.PilotSlotIndex] = s.Channel
				seated = append(seated, s.PilotSlotIndex)
			}
			if len(seated) < minOcc {
				minOcc = len(seated)
			}
			if len(seated) > maxOcc {
				maxOcc = len(seated)
			}
			for i := 0; i < len(seated); i++ {
				for j := i + 1; j < len(seated); j++ {
					a, b := seated[i], seated[j]
					if a > b {
						a, b = b, a
					}
					pairHistory[[2]int{a, b}]++
				}
			}
		}

		if len(seenInRound) != len(pilots) {
			t.Fatalf("round %d seated %d pilots, expected %d", r, len(seenInRound), len(pilots))
		}
		if maxOcc-minOcc > 1 {
			t.Fatalf("round %d heats unbalanced: min=%d max=%d", r, minOcc, maxOcc)
		}

		if r > 1 && len(rHeats) >= 3 {
			prevHeats := byRound[r-1]
			lastPrev := prevHeats[len(prevHeats)-1]
			firstCur := rHeats[0]
			prevPilots := make(map[int]bool)
			for _, s := range lastPrev.Seats {
				if s.PilotSlotIndex > 0 {
					prevPilots[s.PilotSlotIndex] = true
				}
			}
			for _, s := range firstCur.Seats {
				if s.PilotSlotIndex > 0 && prevPilots[s.PilotSlotIndex] {
					t.Fatalf("back-to-back flight detected across R%d (%s) -> R%d (%s) for pilot %d",
						r-1, lastPrev.ID, r, firstCur.ID, s.PilotSlotIndex)
				}
			}
		}
	}

	// Verify opponent mixing actually rotated heats (not identical lineups across rounds)
	if len(pilots) >= 12 && rounds >= 3 {
		triples := 0
		for _, c := range pairHistory {
			if c >= 3 {
				triples++
			}
		}
		if triples > 0 {
			t.Fatalf("expected 0 pairs flying together in all 3 rounds for %d pilots, got %d", len(pilots), triples)
		}
	}
}

func TestQualifyingBalancedRotation12And16Pilots(t *testing.T) {
	for _, nPilots := range []int{10, 12, 16} {
		t.Run(fmt.Sprintf("%d_pilots", nPilots), func(t *testing.T) {
			pilots := makeBalancedQualRoster(nPilots)
			cfg := domain.DefaultRaceSetupConfig()
			cfg.Structure = domain.StructureSingleStage
			cfg.MainFormat = domain.FormatQualifying
			cfg.PilotsPerHeat = 4
			cfg.QualifyingRounds = 3
			cfg.SeatChannels = []uint8{1, 3, 6, 8}

			st := GenerateTournament(cfg, pilots, 42)
			assertQualifyingScheduleInvariants(t, st.Heats, pilots, 3)

			// Verify single-stage Qualifying derives `all_pilots` (Balanced) connections Q1 -> Q2 -> Q3
			SyncRoundsMetadata(&st)
			allPilotsConns := 0
			for _, c := range st.Connections {
				if c.Mode == "all_pilots" {
					allPilotsConns++
					badge := FormatConnectionBadge(c)
					if badge != "All pilots · Balanced" {
						t.Fatalf("expected badge 'All pilots · Balanced', got %q", badge)
					}
				}
			}
			if allPilotsConns != 2 {
				t.Fatalf("expected 2 all_pilots connections across 3 qualifying rounds, got %d (%+v)", allPilotsConns, st.Connections)
			}
		})
	}
}
