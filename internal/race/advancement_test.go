package race

import (
	"testing"

	"slaprf/internal/domain"
)

func TestEffectiveAdvanceAlwaysLeavesSomeoneBehind(t *testing.T) {
	cases := []struct{ req, entrants, want int }{
		{2, 4, 2},
		{2, 3, 2},
		{2, 2, 1}, // top 2 of a 2 pilot heat would advance everyone
		{3, 3, 2},
		{1, 2, 1},
		{2, 1, 1}, // lone pilot walks through
		{2, 0, 0},
		{0, 4, 0},
	}
	for _, c := range cases {
		if got := EffectiveAdvance(c.req, c.entrants); got != c.want {
			t.Errorf("EffectiveAdvance(%d,%d)=%d want %d", c.req, c.entrants, got, c.want)
		}
	}
}

func TestPlanHeatCountKeepsEveryHeatEliminating(t *testing.T) {
	cases := []struct{ n, pph, adv, preferred, want int }{
		{10, 4, 2, 0, 3}, // 4,3,3
		{10, 4, 2, 5, 3}, // 5 heats would be 2-up with top 2 advancing: capped
		{10, 4, 1, 5, 5}, // top 1 makes 2-up heats valid again
		{8, 4, 2, 4, 2},  // 4 heats of 2 -> 2 heats of 4
		{5, 4, 2, 0, 2},  // infeasible (3,2): capacity minimum, short heat is clamped
		{16, 4, 2, 0, 4}, // 4 x 4
		{4, 4, 2, 0, 1},  // one heat of 4
		{12, 4, 0, 0, 3}, // nothing advances: plain capacity
	}
	for _, c := range cases {
		if got := PlanHeatCount(c.n, c.pph, c.adv, c.preferred); got != c.want {
			t.Errorf("PlanHeatCount(n=%d,pph=%d,adv=%d,pref=%d)=%d want %d", c.n, c.pph, c.adv, c.preferred, got, c.want)
		}
	}
}

// assertBracketEliminates fails when any non-final heat that holds 2+ pilots advances all of them,
// and when n >= 6 (4-up, top 2) fails if ANY heat in the bracket has fewer than 3 entrants.
func assertBracketEliminates(t *testing.T, label string, heats []domain.RaceHeat, requireAtLeastThree bool) {
	t.Helper()
	for i := range heats {
		h := &heats[i]
		n := HeatEntrants(h)
		if requireAtLeastThree && n < 3 {
			t.Errorf("%s: heat %s only has %d entrants (expected >= 3 so Top 2 always eliminates >= 1)", label, h.ID, n)
		}
		if h.BracketLane == "finals" {
			continue
		}
		if n >= 2 && h.ExpectedWinners >= n {
			t.Errorf("%s: heat %s holds %d pilots yet advances %d (nobody eliminated)", label, h.ID, n, h.ExpectedWinners)
		}
	}
}

func TestGeneratedBracketsNeverAdvanceAWholeHeatAndResolveToChampion(t *testing.T) {
	for _, format := range []domain.StageFormat{domain.FormatSingleElimination, domain.FormatDoubleElimination} {
		for n := 5; n <= 32; n++ {
			roster := makeTestRoster(n)
			cfg := domain.DefaultRaceSetupConfig()
			cfg.MainFormat = format
			cfg.FinalsFormat = domain.FinalsSingle
			st := GenerateTournament(cfg, roster, 7)
			label := string(format) + " n=" + itoa(n)
			assertBracketEliminates(t, label, st.Heats, n >= 6)

			// Simulate full tournament resolution end-to-end and verify a Champion is crowned.
			for step := 0; step < 64 && !st.IsComplete; step++ {
				if st.NextReadyHeatID == "" {
					t.Fatalf("%s: stalled before completion at step %d", label, step)
				}
				ran := false
				for i := range st.Heats {
					if st.Heats[i].ID == st.NextReadyHeatID {
						simulateConfirmBySeed(&st.Heats[i], cfg)
						ran = true
						break
					}
				}
				if !ran {
					t.Fatalf("%s: NextReadyHeatID %q not found", label, st.NextReadyHeatID)
				}
				ResolveTournament(&st, roster)
			}
			if !st.IsComplete || st.ChampionSlotIndex <= 0 {
				t.Fatalf("%s: tournament did not complete cleanly (isComplete=%v, champion=%d)", label, st.IsComplete, st.ChampionSlotIndex)
			}
		}
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := ""
	for n > 0 {
		digits = string(rune('0'+n%10)) + digits
		n /= 10
	}
	return digits
}
