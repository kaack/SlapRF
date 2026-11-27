package race

import (
	"math"
	"sort"

	"slaprf/internal/domain"
)

// BalancedSlotAssignment describes the pilot assigned to one seat slot `(HeatIdx, SeatIdx)`
// in a balanced qualifying round. PilotSlotIndex == 0 indicates an open / empty seat.
type BalancedSlotAssignment struct {
	PilotSlotIndex int
	Callsign       string
	PhoneticName   string
	Color          string
	Seed           int
	Channel        uint8
}

// ScheduleFixedQualifyingRound preserves the exact heat groupings and VTX channels from `baseHeats`
// (Round 1) for all active pilots in `activePilots` so pilots never change VTX channels across rounds.
// Any newly checked-in walk-up pilot not present in `baseHeats` is placed into the first open seat.
func ScheduleFixedQualifyingRound(
	baseHeats []*domain.RaceHeat,
	dstHeatCount int,
	seatChannels []uint8,
	activePilots []domain.PilotSlot,
) [][]BalancedSlotAssignment {
	numSeats := len(seatChannels)
	if numSeats < 2 {
		seatChannels = domain.DefaultSeatChannels(4)
		numSeats = len(seatChannels)
	}
	if len(baseHeats) > dstHeatCount {
		dstHeatCount = len(baseHeats)
	}
	if dstHeatCount < 1 {
		dstHeatCount = 1
	}

	activeBySlot := make(map[int]domain.PilotSlot, len(activePilots))
	seedBySlot := make(map[int]int, len(activePilots))
	for i, p := range activePilots {
		if p.SlotIndex > 0 {
			activeBySlot[p.SlotIndex] = p
			seedBySlot[p.SlotIndex] = i + 1
		}
	}

	grid := make([][]BalancedSlotAssignment, dstHeatCount)
	for hIdx := 0; hIdx < dstHeatCount; hIdx++ {
		grid[hIdx] = make([]BalancedSlotAssignment, numSeats)
		for sIdx := 0; sIdx < numSeats; sIdx++ {
			grid[hIdx][sIdx].Channel = seatChannels[sIdx]
		}
	}

	placed := make(map[int]bool, len(activePilots))
	for hIdx, bh := range baseHeats {
		if bh == nil || hIdx >= dstHeatCount {
			continue
		}
		for sIdx, s := range bh.Seats {
			if s.PilotSlotIndex <= 0 || placed[s.PilotSlotIndex] {
				continue
			}
			p, ok := activeBySlot[s.PilotSlotIndex]
			if !ok {
				continue
			}
			chCode := domain.EncodeBandChannel(s.Band, s.Channel)
			targetSeat := -1
			for k := 0; k < numSeats; k++ {
				if grid[hIdx][k].PilotSlotIndex == 0 && grid[hIdx][k].Channel == chCode {
					targetSeat = k
					break
				}
			}
			if targetSeat < 0 && sIdx < numSeats && grid[hIdx][sIdx].PilotSlotIndex == 0 {
				targetSeat = sIdx
				if chCode > 0 {
					grid[hIdx][targetSeat].Channel = chCode
				}
			}
			if targetSeat < 0 {
				for k := 0; k < numSeats; k++ {
					if grid[hIdx][k].PilotSlotIndex == 0 {
						targetSeat = k
						break
					}
				}
			}
			if targetSeat >= 0 {
				placed[p.SlotIndex] = true
				grid[hIdx][targetSeat] = BalancedSlotAssignment{
					PilotSlotIndex: p.SlotIndex,
					Callsign:       p.Callsign,
					PhoneticName:   p.PhoneticName,
					Color:          p.Color,
					Seed:           seedBySlot[p.SlotIndex],
					Channel:        grid[hIdx][targetSeat].Channel,
				}
			}
		}
	}

	for _, p := range activePilots {
		if p.SlotIndex <= 0 || placed[p.SlotIndex] {
			continue
		}
		done := false
		for hIdx := 0; hIdx < dstHeatCount && !done; hIdx++ {
			for sIdx := 0; sIdx < numSeats; sIdx++ {
				if grid[hIdx][sIdx].PilotSlotIndex == 0 {
					placed[p.SlotIndex] = true
					grid[hIdx][sIdx] = BalancedSlotAssignment{
						PilotSlotIndex: p.SlotIndex,
						Callsign:       p.Callsign,
						PhoneticName:   p.PhoneticName,
						Color:          p.Color,
						Seed:           seedBySlot[p.SlotIndex],
						Channel:        grid[hIdx][sIdx].Channel,
					}
					done = true
					break
				}
			}
		}
	}

	return grid
}

type qualPilotEntry struct {
	slot         int
	callsign     string
	phoneticName string
	color        string
	seed         int
	prevCh       uint8
	srcHeatIdx   int // -1 if no upstream heat (initial round)
}

// ScheduleBalancedQualifyingRound computes heat-and-seat lineups for a Qualifying round `dstHeatCount`
// fed by `srcHeats` (or `fallbackPilots` when `srcHeats` is empty), jointly optimizing:
//  1. Sticky VTX Channels: pilots stay on the exact Raceband channel they flew on previously whenever possible.
//  2. No Back-to-Back Heats: pilots in the trailing heat(s) of `srcHeats` are kept out of the leading
//     heat(s) of the destination round whenever mathematically possible (`dstHeatCount >= 3`, or when spare seats exist).
//  3. Opponent Mixing: minimizes repeat co-pilot pairings across `priorStageHeats` + `srcHeats`.
//  4. Balanced Heat Sizes: keeps heat headcounts within +/- 1 pilot across the round.
func ScheduleBalancedQualifyingRound(
	srcHeats []*domain.RaceHeat,
	dstHeatCount int,
	seatChannels []uint8,
	priorStageHeats []domain.RaceHeat,
	fallbackPilots []domain.PilotSlot,
	roundNumber int,
) [][]BalancedSlotAssignment {
	numSeats := len(seatChannels)
	if numSeats < 2 {
		seatChannels = domain.DefaultSeatChannels(4)
		numSeats = len(seatChannels)
	}
	if dstHeatCount < 1 {
		dstHeatCount = 1
	}

	var entries []qualPilotEntry
	seen := make(map[int]bool)

	for hi, sh := range srcHeats {
		if sh == nil {
			continue
		}
		for _, s := range sh.Seats {
			if s.PilotSlotIndex <= 0 || s.Status == domain.PilotHeatDNS || s.Status == domain.PilotHeatDQ || seen[s.PilotSlotIndex] {
				continue
			}
			seen[s.PilotSlotIndex] = true
			entries = append(entries, qualPilotEntry{
				slot:         s.PilotSlotIndex,
				callsign:     s.Callsign,
				phoneticName: s.PhoneticName,
				color:        s.Color,
				seed:         s.Seed,
				prevCh:       domain.EncodeBandChannel(s.Band, s.Channel),
				srcHeatIdx:   hi,
			})
		}
	}

	if len(entries) == 0 && len(fallbackPilots) > 0 {
		for idx, p := range fallbackPilots {
			if p.SlotIndex <= 0 || seen[p.SlotIndex] {
				continue
			}
			seen[p.SlotIndex] = true
			entries = append(entries, qualPilotEntry{
				slot:         p.SlotIndex,
				callsign:     p.Callsign,
				phoneticName: p.PhoneticName,
				color:        p.Color,
				seed:         idx + 1,
				prevCh:       domain.EncodeBandChannel(p.Band, p.Channel),
				srcHeatIdx:   -1,
			})
		}
	}

	out := make([][]BalancedSlotAssignment, dstHeatCount)
	for h := 0; h < dstHeatCount; h++ {
		out[h] = make([]BalancedSlotAssignment, numSeats)
		for s := 0; s < numSeats; s++ {
			out[h][s] = BalancedSlotAssignment{Channel: seatChannels[s]}
		}
	}
	if len(entries) == 0 {
		return out
	}

	// Clamp entries to round capacity `dstHeatCount * numSeats`
	maxCap := dstHeatCount * numSeats
	if len(entries) > maxCap {
		entries = entries[:maxCap]
	}

	bySlot := make(map[int]qualPilotEntry, len(entries))
	for _, e := range entries {
		bySlot[e.slot] = e
	}

	// Build historical co-pilot pair counts across all prior stage heats (plus srcHeats if not already included)
	pairCounts := make(map[[2]int]int)
	countedHeatIDs := make(map[string]bool)
	recordHeatPairs := func(h *domain.RaceHeat) {
		if h == nil {
			return
		}
		if h.ID != "" {
			if countedHeatIDs[h.ID] {
				return
			}
			countedHeatIDs[h.ID] = true
		}
		var pSlots []int
		for _, s := range h.Seats {
			if s.PilotSlotIndex > 0 && s.Status != domain.PilotHeatDNS && s.Status != domain.PilotHeatDQ {
				pSlots = append(pSlots, s.PilotSlotIndex)
			}
		}
		for i := 0; i < len(pSlots); i++ {
			for j := i + 1; j < len(pSlots); j++ {
				a, b := pSlots[i], pSlots[j]
				if a > b {
					a, b = b, a
				}
				pairCounts[[2]int{a, b}]++
			}
		}
	}
	for i := range priorStageHeats {
		recordHeatPairs(&priorStageHeats[i])
	}
	for _, sh := range srcHeats {
		recordHeatPairs(sh)
	}

	seatIdxByCh := make(map[uint8]int, numSeats)
	for s, ch := range seatChannels {
		seatIdxByCh[ch] = s
	}

	totalPilots := len(entries)
	minPerHeat := totalPilots / dstHeatCount
	maxPerHeatAllowed := (totalPilots + dstHeatCount - 1) / dstHeatCount
	numSrcHeats := len(srcHeats)

	// Initial round (no upstream heats): distribute pilots cleanly across heats while honoring preferred channels
	// when capacity allows, keeping heats balanced within +/- 1 pilot.
	if numSrcHeats == 0 {
		grid := buildInitialGrid(entries, dstHeatCount, numSeats, seatIdxByCh)
		for h := 0; h < dstHeatCount; h++ {
			for s := 0; s < numSeats; s++ {
				pSlot := grid[h][s]
				if pSlot > 0 {
					pe := bySlot[pSlot]
					out[h][s] = BalancedSlotAssignment{
						PilotSlotIndex: pe.slot,
						Callsign:       pe.callsign,
						PhoneticName:   pe.phoneticName,
						Color:          pe.color,
						Seed:           pe.seed,
						Channel:        seatChannels[s],
					}
				}
			}
		}
		return out
	}

	// Group pilots by preferred seat index (matching previous VTX channel whenever available)
	bySeat := make([][]qualPilotEntry, numSeats)
	var unmatched []qualPilotEntry
	for _, e := range entries {
		if sIdx, ok := seatIdxByCh[e.prevCh]; ok && len(bySeat[sIdx]) < dstHeatCount {
			bySeat[sIdx] = append(bySeat[sIdx], e)
		} else {
			unmatched = append(unmatched, e)
		}
	}
	// Place any overflow/unmatched pilots into seat lanes that still have < dstHeatCount pilots
	for _, e := range unmatched {
		bestS := 0
		for s := 1; s < numSeats; s++ {
			if len(bySeat[s]) < len(bySeat[bestS]) {
				bestS = s
			}
		}
		bySeat[bestS] = append(bySeat[bestS], e)
	}
	for s := 0; s < numSeats; s++ {
		sort.SliceStable(bySeat[s], func(i, j int) bool {
			if bySeat[s][i].srcHeatIdx != bySeat[s][j].srcHeatIdx {
				return bySeat[s][i].srcHeatIdx < bySeat[s][j].srcHeatIdx
			}
			return bySeat[s][i].slot < bySeat[s][j].slot
		})
	}

	scoreGrid := func(grid [][]int) int64 {
		var cost int64

		for h := 0; h < dstHeatCount; h++ {
			hc := 0
			var occ []int
			for s := 0; s < numSeats; s++ {
				pSlot := grid[h][s]
				if pSlot <= 0 {
					continue
				}
				hc++
				occ = append(occ, pSlot)
				pe := bySlot[pSlot]

				// 1. Channel stickiness (only penalized if pilot had a valid seatChannel and isn't on it)
				if _, hadValid := seatIdxByCh[pe.prevCh]; hadValid && seatChannels[s] != pe.prevCh {
					cost += 1_000_000
				}

				// 2. Chronological rest buffer from upstream round heat `pe.srcHeatIdx` to `h`
				if pe.srcHeatIdx >= 0 {
					gap := (numSrcHeats - 1 - pe.srcHeatIdx) + h
					if gap == 0 {
						// Consecutive / back-to-back flight across round boundary!
						cost += 50_000
					} else if gap == 1 {
						// Only 1 heat of rest; gently prefer >= 2 heats of rest on larger stages
						cost += 30
					}
				}

				// Small deterministic tie-breaker
				cost += int64((h*5 + s*3 + pe.slot + roundNumber) % 7)
			}

			// 3. Heat headcount balance (keep every heat within [minPerHeat .. maxPerHeatAllowed])
			if hc == 0 && totalPilots >= dstHeatCount {
				cost += 500_000
			}
			if hc < minPerHeat {
				diff := minPerHeat - hc
				cost += int64(diff*diff) * 100_000
			} else if hc > maxPerHeatAllowed {
				diff := hc - maxPerHeatAllowed
				cost += int64(diff*diff) * 100_000
			}

			// 4. Opponent diversity penalty across all prior rounds
			for i := 0; i < len(occ); i++ {
				for j := i + 1; j < len(occ); j++ {
					a, b := occ[i], occ[j]
					if a > b {
						a, b = b, a
					}
					prevTogether := pairCounts[[2]int{a, b}]
					if prevTogether > 0 {
						cost += int64(prevTogether*(prevTogether+1)/2) * 500
					}
				}
			}
		}

		return cost
	}

	var bestGrid [][]int
	bestCost := int64(math.MaxInt64)

	// Multi-start deterministic Latin-shift initializations + steepest-descent 2-swap & 3-cycle search
	numStarts := dstHeatCount * 2
	if numStarts < 6 {
		numStarts = 6
	}
	if numStarts > 16 {
		numStarts = 16
	}

	for startIdx := 0; startIdx < numStarts; startIdx++ {
		grid := make([][]int, dstHeatCount)
		for h := 0; h < dstHeatCount; h++ {
			grid[h] = make([]int, numSeats)
		}
		for s := 0; s < numSeats; s++ {
			pilotsInLane := bySeat[s]
			shift := (startIdx + s*(roundNumber+1) + s) % dstHeatCount
			for k, pe := range pilotsInLane {
				baseH := pe.srcHeatIdx
				if baseH < 0 || baseH >= dstHeatCount {
					baseH = k % dstHeatCount
				}
				targetH := (baseH + shift) % dstHeatCount
				for step := 0; step < dstHeatCount; step++ {
					candH := (targetH + step) % dstHeatCount
					if grid[candH][s] == 0 {
						grid[candH][s] = pe.slot
						break
					}
				}
			}
		}

		curCost := scoreGrid(grid)
		for iter := 0; iter < 64; iter++ {
			improved := false

			// All pairwise within-channel swaps `(h1, s) <-> (h2, s)` (preserves 100% channel stickiness!)
			for s := 0; s < numSeats; s++ {
				for h1 := 0; h1 < dstHeatCount; h1++ {
					for h2 := h1 + 1; h2 < dstHeatCount; h2++ {
						if grid[h1][s] == grid[h2][s] {
							continue
						}
						grid[h1][s], grid[h2][s] = grid[h2][s], grid[h1][s]
						candCost := scoreGrid(grid)
						if candCost < curCost {
							curCost = candCost
							improved = true
						} else {
							grid[h1][s], grid[h2][s] = grid[h2][s], grid[h1][s]
						}
					}
				}
			}

			// Whole-heat order swaps `grid[h1] <-> grid[h2]` (reorders heats in the destination round
			// without changing any pilot's channel or opponent group — very effective for eliminating boundary back-to-backs!)
			for h1 := 0; h1 < dstHeatCount; h1++ {
				for h2 := h1 + 1; h2 < dstHeatCount; h2++ {
					grid[h1], grid[h2] = grid[h2], grid[h1]
					candCost := scoreGrid(grid)
					if candCost < curCost {
						curCost = candCost
						improved = true
					} else {
						grid[h1], grid[h2] = grid[h2], grid[h1]
					}
				}
			}

			if !improved {
				break
			}
		}

		if curCost < bestCost {
			bestCost = curCost
			bestGrid = grid
		}
	}

	for h := 0; h < dstHeatCount; h++ {
		for s := 0; s < numSeats; s++ {
			pSlot := bestGrid[h][s]
			if pSlot > 0 {
				pe := bySlot[pSlot]
				out[h][s] = BalancedSlotAssignment{
					PilotSlotIndex: pe.slot,
					Callsign:       pe.callsign,
					PhoneticName:   pe.phoneticName,
					Color:          pe.color,
					Seed:           pe.seed,
					Channel:        seatChannels[s],
				}
			}
		}
	}

	return out
}

func buildInitialGrid(
	entries []qualPilotEntry,
	dstHeatCount int,
	numSeats int,
	seatIdxByCh map[uint8]int,
) [][]int {
	grid := make([][]int, dstHeatCount)
	heatCounts := make([]int, dstHeatCount)
	for h := 0; h < dstHeatCount; h++ {
		grid[h] = make([]int, numSeats)
	}

	maxAllowed := (len(entries) + dstHeatCount - 1) / dstHeatCount
	var deferred []int

	// First pass: seat pilots who already have a matching preferred Raceband channel into the least-filled heat with that channel free
	for idx, e := range entries {
		sIdx, ok := seatIdxByCh[e.prevCh]
		if !ok {
			deferred = append(deferred, idx)
			continue
		}
		bestH := -1
		for h := 0; h < dstHeatCount; h++ {
			if grid[h][sIdx] == 0 && heatCounts[h] < maxAllowed {
				if bestH < 0 || heatCounts[h] < heatCounts[bestH] {
					bestH = h
				}
			}
		}
		if bestH >= 0 {
			grid[bestH][sIdx] = e.slot
			heatCounts[bestH]++
		} else {
			deferred = append(deferred, idx)
		}
	}

	// Second pass: distribute remaining pilots into the least-filled heats so headcounts stay balanced
	for _, idx := range deferred {
		e := entries[idx]
		bestH := -1
		bestS := -1
		for h := 0; h < dstHeatCount; h++ {
			for s := 0; s < numSeats; s++ {
				if grid[h][s] == 0 {
					if bestH < 0 || heatCounts[h] < heatCounts[bestH] {
						bestH = h
						bestS = s
					}
					break
				}
			}
		}
		if bestH >= 0 && bestS >= 0 {
			grid[bestH][bestS] = e.slot
			heatCounts[bestH]++
		}
	}
	return grid
}
