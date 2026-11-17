package race

import "slaprf/internal/domain"

// Elimination-aware heat sizing & feeder distribution.
//
// A bracket heat is only meaningful when at least one pilot does NOT advance along its
// "top" wire (they either drop to a Redemption heat or are out of the event). If "Top 2" leave
// a heat that only holds 2 pilots, nobody is ever eliminated and the heat is pointless. The helpers
// below keep every source heat at `advance + 1` pilots whenever the pool allows it, and clamp
// the advancing slots of an undersized heat so there is always at least one elimination.

// HeatEntrants counts the pilots that will actually fly `h`: seated pilots plus seats that are
// still waiting on a real (non-bye) feeder.
func HeatEntrants(h *domain.RaceHeat) int {
	if h == nil {
		return 0
	}
	n := 0
	for _, s := range h.Seats {
		if s.PilotSlotIndex > 0 {
			n++
		} else if s.Feeder != nil && !s.Feeder.IsBye {
			n++
		}
	}
	return n
}

// EffectiveAdvance returns how many pilots may advance from a heat with `entrants` pilots when the
// wire asks for the top `requested`. At least one pilot is always left behind (eliminated or
// dropped), except for 0 or 1 entrant heats where the lone pilot simply walks through.
func EffectiveAdvance(requested, entrants int) int {
	if requested < 1 {
		return 0
	}
	if entrants <= 1 {
		return entrants
	}
	if requested > entrants-1 {
		return entrants - 1
	}
	return requested
}

// IsFeasibleElimPool reports whether `n` entrants can be partitioned into heats of at most `pph`
// seats such that every heat holds at least `advance + 1` entrants (eliminating or dropping at
// least one pilot per heat when `advance` pilots advance).
func IsFeasibleElimPool(n, pph, advance int) bool {
	if pph < 1 {
		pph = 1
	}
	if advance < 1 {
		return n >= 1
	}
	if n < advance+1 {
		return false
	}
	minHeats := (n + pph - 1) / pph
	maxHeats := n / (advance + 1)
	return minHeats <= maxHeats
}

// PlanHeatCount picks how many heats a source round should have for `n` entrants so that every
// heat can lose at least one pilot after `advance` pilots go forward.
//
//   - It never goes below the capacity minimum ceil(n / pph).
//   - `preferred` (an explicit user "target heats" request) is honored when it is feasible.
//   - It never creates more heats than floor(n / (advance+1)) as long as that still fits everyone.
//
// When even the capacity minimum cannot satisfy the elimination rule (for example 5 pilots in
// 4-up heats with Top 2 advancing) the minimum is returned and EffectiveAdvance clamps the
// smaller heat.
func PlanHeatCount(n, pph, advance, preferred int) int {
	if pph < 1 {
		pph = 1
	}
	minHeats := (n + pph - 1) / pph
	if minHeats < 1 {
		minHeats = 1
	}
	heats := minHeats
	if preferred > heats {
		heats = preferred
	}
	if advance < 1 || n < 2 {
		return heats
	}
	maxHeats := n / (advance + 1)
	if maxHeats < minHeats {
		return minHeats
	}
	if heats > maxHeats {
		heats = maxHeats
	}
	return heats
}

// DistributeFeedersAcrossHeats folds `feeders` across `numHeats` heats (up to `pph` per heat)
// using snake ordering while avoiding placing two feeders from the same `FromHeatID` into the same
// destination heat whenever another heat with spare balanced capacity has not seen `FromHeatID` yet.
func DistributeFeedersAcrossHeats(feeders []domain.SeatFeeder, numHeats int, pph int) [][]domain.SeatFeeder {
	if numHeats < 1 {
		numHeats = 1
	}
	if pph < 1 {
		pph = 4
	}
	minBalanced := len(feeders) / numHeats
	extra := len(feeders) % numHeats
	hasSrc := func(list []domain.SeatFeeder, heatID string) bool {
		if heatID == "" {
			return false
		}
		for _, f := range list {
			if f.FromHeatID == heatID {
				return true
			}
		}
		return false
	}
	out := make([][]domain.SeatFeeder, numHeats)
	fullExtra := 0
	canAcceptBalanced := func(h int) bool {
		if len(out[h]) >= pph {
			return false
		}
		if len(out[h]) < minBalanced {
			return true
		}
		return len(out[h]) == minBalanced && fullExtra < extra
	}
	for idx, fd := range feeders {
		pass := idx / numHeats
		rem := idx % numHeats
		pref := rem
		if pass%2 == 1 {
			pref = numHeats - 1 - rem
		}
		dst := -1
		// 1. Prefer snake slot `pref` if within exact balanced quota and no duplicate source heat.
		if canAcceptBalanced(pref) && !hasSrc(out[pref], fd.FromHeatID) {
			dst = pref
		}
		// 2. Otherwise pick the least-filled heat within exact balanced quota without a duplicate source heat.
		if dst < 0 && fd.FromHeatID != "" {
			for step := 0; step < numHeats; step++ {
				cand := (pref + step) % numHeats
				if canAcceptBalanced(cand) && !hasSrc(out[cand], fd.FromHeatID) {
					if dst < 0 || len(out[cand]) < len(out[dst]) {
						dst = cand
					}
				}
			}
		}
		// 3. Otherwise pick the least-filled heat within exact balanced quota (or under `pph`).
		if dst < 0 {
			for step := 0; step < numHeats; step++ {
				cand := (pref + step) % numHeats
				if canAcceptBalanced(cand) {
					if dst < 0 || len(out[cand]) < len(out[dst]) {
						dst = cand
					}
				}
			}
		}
		if dst < 0 {
			for step := 0; step < numHeats; step++ {
				cand := (pref + step) % numHeats
				if len(out[cand]) < pph {
					dst = cand
					break
				}
			}
		}
		if dst < 0 {
			break
		}
		out[dst] = append(out[dst], fd)
		if len(out[dst]) == minBalanced+1 {
			fullExtra++
		}
	}
	return out
}

// OutgoingTopAdvance returns the largest `top_per_heat` count leaving `roundID` across `conns`,
// using `defaultCount` for wires that have no explicit count. Finals have no advancing wires.
func OutgoingTopAdvance(conns []domain.RoundConnection, roundID string, defaultCount int) int {
	best := 0
	for _, c := range conns {
		if c.Invalid || c.FromRoundID != roundID || c.Mode != "top_per_heat" {
			continue
		}
		cnt := c.Count
		if cnt < 1 {
			cnt = defaultCount
		}
		if cnt > best {
			best = cnt
		}
	}
	return best
}
