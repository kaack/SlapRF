package multigp

import (
	"math"

	"slaprf/internal/domain"
)

func roundMillis(sec float64) float64 {
	if sec <= 0 || math.IsNaN(sec) || math.IsInf(sec, 0) {
		return 0
	}
	return math.Round(sec*1000.0) / 1000.0
}

// ComputeSeatMetrics calculates MultiGP `assignSlot` timing metrics from a SlapRF HeatSeat,
// honoring invalidated laps (`HeatLap.Invalidated`), holeshot (`LapNumber == 0`), and DQ/DNS status.
func ComputeSeatMetrics(seat domain.HeatSeat, scoringDisabled bool) AssignSlotData {
	if seat.PilotSlotIndex <= 0 || seat.Status == domain.PilotHeatDNS || seat.Status == domain.PilotHeatDQ {
		return AssignSlotData{}
	}

	valid := make([]float64, 0, len(seat.Laps))
	hasInvalid := false
	for _, lap := range seat.Laps {
		if lap.LapNumber < 1 {
			continue // Lap 0 is the holeshot pass
		}
		if lap.Invalidated {
			hasInvalid = true
			continue
		}
		if lap.SplitTimeSec > 0 {
			valid = append(valid, lap.SplitTimeSec)
		}
	}

	var totalSum float64
	var best1 float64
	for _, t := range valid {
		totalSum += t
		if best1 == 0 || t < best1 {
			best1 = t
		}
	}

	var best2 float64
	for i := 0; i+1 < len(valid); i++ {
		s2 := valid[i] + valid[i+1]
		if best2 == 0 || s2 < best2 {
			best2 = s2
		}
	}

	var best3 float64
	for i := 0; i+2 < len(valid); i++ {
		s3 := valid[i] + valid[i+1] + valid[i+2]
		if best3 == 0 || s3 < best3 {
			best3 = s3
		}
	}

	totalTime := totalSum
	if !hasInvalid && seat.TotalTimeSec > totalSum && len(valid) > 0 {
		totalTime = seat.TotalTimeSec
	}

	var score float64
	if !scoringDisabled {
		rank := seat.Position
		if seat.ManualPosition > 0 {
			rank = seat.ManualPosition
		}
		if seat.Points > 0 {
			score = float64(seat.Points)
		} else if rank > 0 {
			pts := 7 - rank
			if pts < 1 {
				pts = 1
			}
			score = float64(pts)
		}
	}

	return AssignSlotData{
		Score:                       score,
		TotalLaps:                   len(valid),
		TotalTime:                   roundMillis(totalTime),
		FastestLapTime:              roundMillis(best1),
		Fastest2ConsecutiveLapsTime: roundMillis(best2),
		Fastest3ConsecutiveLapsTime: roundMillis(best3),
	}
}
