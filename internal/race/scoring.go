package race

import (
	"math"
	"sort"

	"slaprf/internal/domain"
)

var defaultPointsTable = []int{10, 6, 4, 2, 1, 1, 1, 1}

// PointsForPosition returns championship points awarded for 1-based finishing position.
func PointsForPosition(pos int, status domain.PilotHeatStatus) int {
	if status == domain.PilotHeatDQ || status == domain.PilotHeatDNS || pos <= 0 {
		return 0
	}
	if pos-1 < len(defaultPointsTable) {
		return defaultPointsTable[pos-1]
	}
	return 1
}

// RecomputeHeat derives every seat's laps, split times, consecutive-3 window, rank, points, and
// advancement flag from its raw `Crossings` and marshal overrides.
func RecomputeHeat(heat *domain.RaceHeat, qualMetric domain.QualifyingMetric) {
	for i := range heat.Seats {
		recomputeSeatLaps(&heat.Seats[i], heat)
	}
	rankHeatSeats(heat, qualMetric)
}

func recomputeSeatLaps(seat *domain.HeatSeat, heat *domain.RaceHeat) {
	seat.HoleshotSec = 0
	seat.LapsCompleted = 0
	seat.TotalTimeSec = 0
	seat.BestLapSec = 0
	seat.BestConsecutive2Sec = 0
	seat.BestConsecutive3Sec = 0
	seat.LastLapSec = 0

	if seat.PilotSlotIndex <= 0 {
		seat.Laps = nil
		return
	}

	// Safety backfill: if a legacy/persisted heat seat ever had derived Laps without raw Crossings,
	// reconstruct Crossings so marshal overrides and recomputations never lose recorded laps.
	if len(seat.Crossings) == 0 && len(seat.Laps) > 0 {
		baseUs := heat.StartToneUs
		if baseUs == 0 {
			baseUs = 1_000_000
		}
		curUs := baseUs
		synthesized := make([]domain.HeatCrossing, 0, len(seat.Laps))
		for idx, l := range seat.Laps {
			cid := l.CrossingID
			if cid == 0 {
				cid = uint64(idx + 1)
			}
			deltaUs := uint64(math.Round(math.Max(0, l.SplitTimeSec) * 1e6))
			if l.LapNumber == 0 {
				curUs = baseUs + deltaUs
			} else {
				if deltaUs == 0 {
					deltaUs = 10_000_000
				}
				curUs += deltaUs
			}
			synthesized = append(synthesized, domain.HeatCrossing{
				CrossingID:  cid,
				TimestampUs: curUs,
				Invalidated: l.Invalidated,
				Manual:      l.Manual,
				Sectors:     append([]domain.SectorSplit(nil), l.Sectors...),
			})
		}
		seat.Crossings = synthesized
	}

	laps := make([]domain.HeatLap, 0, len(seat.Crossings))
	var validLapSplits []float64
	var firstValidUs uint64
	var prevValidUs uint64
	var prevAnyUs uint64
	hasHoleshot := false
	countedLaps := 0
	var lastCountedElapsedSec float64

	for _, c := range seat.Crossings {
		if c.Invalidated {
			var invSplitSec float64
			refUs := prevValidUs
			if refUs == 0 {
				if prevAnyUs > 0 {
					refUs = prevAnyUs
				} else if heat.StartToneUs > 0 {
					refUs = heat.StartToneUs
				}
			}
			if refUs > 0 && c.TimestampUs > refUs {
				invSplitSec = roundMillis(float64(c.TimestampUs-refUs) / 1e6)
			}
			prevAnyUs = c.TimestampUs
			laps = append(laps, domain.HeatLap{
				CrossingID:   c.CrossingID,
				LapNumber:    -1,
				SplitTimeSec: invSplitSec,
				Invalidated:  true,
				Manual:       c.Manual,
				Sectors:      c.Sectors,
			})
			continue
		}
		prevAnyUs = c.TimestampUs

		if !hasHoleshot {
			hasHoleshot = true
			firstValidUs = c.TimestampUs
			prevValidUs = c.TimestampUs
			var hs float64
			if heat.StartMode == domain.StartModeHeadsUp && heat.StartToneUs > 0 && c.TimestampUs >= heat.StartToneUs {
				hs = float64(c.TimestampUs-heat.StartToneUs) / 1e6
			}
			seat.HoleshotSec = roundMillis(hs)
			laps = append(laps, domain.HeatLap{
				CrossingID:     c.CrossingID,
				LapNumber:      0,
				SplitTimeSec:   seat.HoleshotSec,
				RaceElapsedSec: seat.HoleshotSec,
				Manual:         c.Manual,
			})
			continue
		}

		// In heads-up races with a target lap count, ignore extra crossings after finishing target laps.
		if heat.TargetLaps > 0 && heat.StartMode == domain.StartModeHeadsUp && countedLaps >= heat.TargetLaps {
			continue
		}

		var splitSec float64
		if c.TimestampUs > prevValidUs {
			splitSec = float64(c.TimestampUs-prevValidUs) / 1e6
		}
		prevValidUs = c.TimestampUs

		var elapsedSec float64
		if heat.StartMode == domain.StartModeHeadsUp && heat.StartToneUs > 0 && c.TimestampUs >= heat.StartToneUs {
			elapsedSec = float64(c.TimestampUs-heat.StartToneUs) / 1e6
		} else if c.TimestampUs >= firstValidUs {
			elapsedSec = float64(c.TimestampUs-firstValidUs) / 1e6
		}

		countedLaps++
		splitSec = roundMillis(splitSec)
		elapsedSec = roundMillis(elapsedSec)
		lastCountedElapsedSec = elapsedSec
		validLapSplits = append(validLapSplits, splitSec)
		seat.LastLapSec = splitSec
		if seat.BestLapSec == 0 || (splitSec > 0 && splitSec < seat.BestLapSec) {
			seat.BestLapSec = splitSec
		}

		laps = append(laps, domain.HeatLap{
			CrossingID:     c.CrossingID,
			LapNumber:      countedLaps,
			SplitTimeSec:   splitSec,
			RaceElapsedSec: elapsedSec,
			Manual:         c.Manual,
			Sectors:        c.Sectors,
		})
	}

	// When a pilot is DQ, DNS, or explicitly marked Crashed Out (DNF) by a marshal, keep all recorded
	// passes visible in `seat.Laps` with their lap numbers and split times preserved, while marking
	// them crossed out (`Invalidated: true`). Natural incomplete finishes (e.g. 2/3 laps when time
	// expires or when a single false-trigger lap is scratched in review) preserve their valid laps!
	if seat.Status == domain.PilotHeatDQ || seat.Status == domain.PilotHeatDNS || (seat.Status == domain.PilotHeatDNF && seat.StatusOverridden) {
		for i := range laps {
			laps[i].Invalidated = true
		}
	}

	seat.Laps = laps
	if seat.Status == domain.PilotHeatDQ || seat.Status == domain.PilotHeatDNS {
		seat.HoleshotSec = 0
		seat.LapsCompleted = 0
		seat.TotalTimeSec = 0
		seat.BestLapSec = 0
		seat.BestConsecutive2Sec = 0
		seat.BestConsecutive3Sec = 0
		seat.LastLapSec = 0
		return
	}

	seat.LapsCompleted = countedLaps
	if countedLaps > 0 {
		seat.TotalTimeSec = roundMillis(lastCountedElapsedSec + math.Max(0, seat.PenaltySec))
	} else if hasHoleshot && seat.PenaltySec > 0 {
		seat.TotalTimeSec = roundMillis(seat.HoleshotSec + seat.PenaltySec)
	}

	if len(validLapSplits) >= 2 {
		best2 := math.MaxFloat64
		for i := 0; i+1 < len(validLapSplits); i++ {
			s2 := validLapSplits[i] + validLapSplits[i+1]
			if s2 > 0 && s2 < best2 {
				best2 = s2
			}
		}
		if best2 < math.MaxFloat64 {
			seat.BestConsecutive2Sec = roundMillis(best2)
		}
	}

	if len(validLapSplits) >= 3 {
		best3 := math.MaxFloat64
		for i := 0; i+2 < len(validLapSplits); i++ {
			s3 := validLapSplits[i] + validLapSplits[i+1] + validLapSplits[i+2]
			if s3 > 0 && s3 < best3 {
				best3 = s3
			}
		}
		if best3 < math.MaxFloat64 {
			seat.BestConsecutive3Sec = roundMillis(best3)
		}
	}

	// Automatically transition racing <-> finished based on target laps if heat is active or finished
	if heat.TargetLaps > 0 && heat.StartMode == domain.StartModeHeadsUp {
		if seat.Status == domain.PilotHeatRacing && seat.LapsCompleted >= heat.TargetLaps {
			seat.Status = domain.PilotHeatFinished
		} else if seat.Status == domain.PilotHeatFinished && seat.LapsCompleted < heat.TargetLaps &&
			(heat.State == domain.HeatRunning || heat.State == domain.HeatPaused) {
			seat.Status = domain.PilotHeatRacing
		}
	}
}

func rankHeatSeats(heat *domain.RaceHeat, qualMetric domain.QualifyingMetric) {
	activeIdx := make([]int, 0, len(heat.Seats))
	for i := range heat.Seats {
		heat.Seats[i].Position = 0
		heat.Seats[i].Points = 0
		heat.Seats[i].HoleshotWinner = false
		heat.Seats[i].Advances = false
		if heat.Seats[i].PilotSlotIndex > 0 {
			activeIdx = append(activeIdx, i)
		}
	}
	if len(activeIdx) == 0 {
		return
	}

	unstarted := heat.State == "" ||
		heat.State == domain.HeatWaiting ||
		heat.State == domain.HeatReady ||
		heat.State == domain.HeatStaged ||
		heat.State == domain.HeatCountdown
	if unstarted {
		anyProgress := false
		for _, seatIdx := range activeIdx {
			s := &heat.Seats[seatIdx]
			if len(s.Crossings) > 0 || s.LapsCompleted > 0 || s.ManualPosition > 0 {
				anyProgress = true
				break
			}
		}
		if !anyProgress {
			return
		}
	}

	isQual := heat.StageFormat == domain.FormatQualifying || heat.StageFormat == domain.FormatOpenQualifier
	isCompetitiveHeadsUp := heat.StartMode == domain.StartModeHeadsUp && !isQual

	holeshotSeatIdx := -1
	var earliestHoleshotUs uint64
	if isCompetitiveHeadsUp {
		for _, seatIdx := range activeIdx {
			s := &heat.Seats[seatIdx]
			if s.Status == domain.PilotHeatDQ || s.Status == domain.PilotHeatDNS {
				continue
			}
			hsUs, ok := firstValidCrossingUs(s.Crossings)
			if !ok {
				continue
			}
			if holeshotSeatIdx == -1 || hsUs < earliestHoleshotUs {
				holeshotSeatIdx = seatIdx
				earliestHoleshotUs = hsUs
			}
		}
		if holeshotSeatIdx >= 0 {
			heat.Seats[holeshotSeatIdx].HoleshotWinner = true
		}
	}

	sort.SliceStable(activeIdx, func(a, b int) bool {
		sa := &heat.Seats[activeIdx[a]]
		sb := &heat.Seats[activeIdx[b]]

		// 1. Disqualified pilots always rank at the very bottom, and DNS (scratched) just above DQ.
		dqA := sa.Status == domain.PilotHeatDQ
		dqB := sb.Status == domain.PilotHeatDQ
		if dqA != dqB {
			return !dqA
		}
		dnsA := sa.Status == domain.PilotHeatDNS
		dnsB := sb.Status == domain.PilotHeatDNS
		if dnsA != dnsB {
			return !dnsA
		}

		// 2. Explicit manual position override from Race Director.
		manA := sa.ManualPosition > 0
		manB := sb.ManualPosition > 0
		if manA && manB && sa.ManualPosition != sb.ManualPosition {
			return sa.ManualPosition < sb.ManualPosition
		}
		if manA != manB {
			if manA {
				return sa.ManualPosition <= b+1
			}
			return a+1 < sb.ManualPosition
		}

		// 3. Qualifying ranking vs Heads-Up race ranking.
		if isQual {
			return compareQualifyingSeats(sa, sb, qualMetric)
		}
		return compareHeadsUpSeats(sa, sb)
	})

	// Apply explicit ManualPosition slots cleanly if only one or some seats were manually positioned
	ordered := applyManualSlotOverrides(activeIdx, heat.Seats)

	for rankIdx, seatIdx := range ordered {
		pos := rankIdx + 1
		s := &heat.Seats[seatIdx]
		s.Position = pos
		if s.Status == domain.PilotHeatDQ || s.Status == domain.PilotHeatDNS {
			s.Points = 0
			s.Advances = false
			continue
		}
		if heat.State == domain.HeatFinished || heat.State == domain.HeatConfirmed || s.LapsCompleted > 0 || len(s.Crossings) > 0 {
			s.Points = PointsForPosition(pos, s.Status)
			if s.HoleshotWinner {
				s.Points += 1
			}
		}
		if heat.ExpectedWinners > 0 && pos <= heat.ExpectedWinners {
			s.Advances = true
		}
	}
}

func firstValidCrossingUs(cs []domain.HeatCrossing) (uint64, bool) {
	for _, c := range cs {
		if !c.Invalidated {
			return c.TimestampUs, true
		}
	}
	return 0, false
}

func applyManualSlotOverrides(sorted []int, seats []domain.HeatSeat) []int {
	hasManual := false
	for _, idx := range sorted {
		if seats[idx].ManualPosition > 0 && seats[idx].Status != domain.PilotHeatDQ && seats[idx].Status != domain.PilotHeatDNS {
			hasManual = true
			break
		}
	}
	if !hasManual {
		return sorted
	}
	n := len(sorted)
	result := make([]int, n)
	for i := range result {
		result[i] = -1
	}
	var autoList []int
	type manItem struct {
		seatIdx int
		target  int
	}
	var manuals []manItem
	for _, idx := range sorted {
		mp := seats[idx].ManualPosition
		if mp > 0 && seats[idx].Status != domain.PilotHeatDQ && seats[idx].Status != domain.PilotHeatDNS {
			if mp > n {
				mp = n
			}
			manuals = append(manuals, manItem{seatIdx: idx, target: mp - 1})
		} else {
			autoList = append(autoList, idx)
		}
	}
	sort.SliceStable(manuals, func(i, j int) bool { return manuals[i].target < manuals[j].target })
	for _, m := range manuals {
		pos := m.target
		for pos < n && result[pos] != -1 {
			pos++
		}
		if pos >= n {
			for pos = n - 1; pos >= 0 && result[pos] != -1; pos-- {
			}
		}
		if pos >= 0 {
			result[pos] = m.seatIdx
		}
	}
	ai := 0
	for i := range result {
		if result[i] == -1 && ai < len(autoList) {
			result[i] = autoList[ai]
			ai++
		}
	}
	return result
}

func compareQualifyingSeats(a, b *domain.HeatSeat, metric domain.QualifyingMetric) bool {
	switch metric {
	case domain.QualMetricBestLap:
		if (a.BestLapSec > 0) != (b.BestLapSec > 0) {
			return a.BestLapSec > 0
		}
		if a.BestLapSec > 0 && a.BestLapSec != b.BestLapSec {
			return a.BestLapSec < b.BestLapSec
		}
	case domain.QualMetricLapsInTime:
		if a.LapsCompleted != b.LapsCompleted {
			return a.LapsCompleted > b.LapsCompleted
		}
		if a.TotalTimeSec != b.TotalTimeSec {
			return a.TotalTimeSec < b.TotalTimeSec
		}
	case domain.QualMetricConsecutive2:
		if (a.BestConsecutive2Sec > 0) != (b.BestConsecutive2Sec > 0) {
			return a.BestConsecutive2Sec > 0
		}
		if a.BestConsecutive2Sec > 0 && a.BestConsecutive2Sec != b.BestConsecutive2Sec {
			return a.BestConsecutive2Sec < b.BestConsecutive2Sec
		}
		if (a.BestLapSec > 0) != (b.BestLapSec > 0) {
			return a.BestLapSec > 0
		}
		if a.BestLapSec > 0 && a.BestLapSec != b.BestLapSec {
			return a.BestLapSec < b.BestLapSec
		}
	default: // QualMetricConsecutive3
		if (a.BestConsecutive3Sec > 0) != (b.BestConsecutive3Sec > 0) {
			return a.BestConsecutive3Sec > 0
		}
		if a.BestConsecutive3Sec > 0 && a.BestConsecutive3Sec != b.BestConsecutive3Sec {
			return a.BestConsecutive3Sec < b.BestConsecutive3Sec
		}
		if (a.BestLapSec > 0) != (b.BestLapSec > 0) {
			return a.BestLapSec > 0
		}
		if a.BestLapSec > 0 && a.BestLapSec != b.BestLapSec {
			return a.BestLapSec < b.BestLapSec
		}
	}
	return compareHeadsUpSeats(a, b)
}

func compareHeadsUpSeats(a, b *domain.HeatSeat) bool {
	finA := a.Status == domain.PilotHeatFinished
	finB := b.Status == domain.PilotHeatFinished
	if finA != finB {
		return finA
	}
	if a.LapsCompleted != b.LapsCompleted {
		return a.LapsCompleted > b.LapsCompleted
	}
	if a.LapsCompleted > 0 && a.TotalTimeSec != b.TotalTimeSec {
		return a.TotalTimeSec < b.TotalTimeSec
	}
	hasHsA := len(a.Crossings) > 0 && !allInvalid(a.Crossings)
	hasHsB := len(b.Crossings) > 0 && !allInvalid(b.Crossings)
	if hasHsA != hasHsB {
		return hasHsA
	}
	if hasHsA && a.HoleshotSec != b.HoleshotSec {
		return a.HoleshotSec < b.HoleshotSec
	}
	dnfA := a.Status == domain.PilotHeatDNF
	dnfB := b.Status == domain.PilotHeatDNF
	if dnfA != dnfB {
		return !dnfA
	}
	if a.Seed > 0 && b.Seed > 0 && a.Seed != b.Seed {
		return a.Seed < b.Seed
	}
	return a.SeatIndex < b.SeatIndex
}

func allInvalid(cs []domain.HeatCrossing) bool {
	for _, c := range cs {
		if !c.Invalidated {
			return false
		}
	}
	return true
}

func roundMillis(v float64) float64 {
	return math.Round(v*1000) / 1000
}
