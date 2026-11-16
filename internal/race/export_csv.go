package race

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"strconv"
	"strings"

	"slaprf/internal/domain"
)

// BuildRaceResultsCSV generates an organizer-ready CSV export of stage standings, best consecutive-3
// & fastest lap times, pack counts, points, and per-pilot valid lap splits.
func BuildRaceResultsCSV(st *domain.RaceTournamentState, roster []domain.PilotSlot, stageIdx int) string {
	if st == nil {
		return ""
	}
	EnsureStagesMetadata(st)
	if stageIdx < 1 {
		stageIdx = st.ActiveStageIndex
	}
	if stageIdx < 1 {
		stageIdx = 1
	}

	effectiveRoster := roster
	if len(st.Roster) > 0 {
		rmap := make(map[int]domain.PilotSlot, len(roster))
		for _, p := range roster {
			rmap[p.SlotIndex] = p
		}
		merged := make([]domain.PilotSlot, 0, len(st.Roster))
		for _, ep := range st.Roster {
			if gp, ok := rmap[ep.SlotIndex]; ok {
				merged = append(merged, gp)
			} else {
				merged = append(merged, domain.PilotSlot{
					SlotIndex:    ep.SlotIndex,
					Callsign:     ep.Callsign,
					PhoneticName: ep.PhoneticName,
					Color:        ep.Color,
				})
			}
		}
		effectiveRoster = merged
	}

	stg := findStagePtr(st, stageIdx)
	var rows []domain.TournamentStanding
	if stg != nil && len(stg.Standings) > 0 {
		rows = stg.Standings
	} else {
		done := st.IsComplete || (stg != nil && stg.Status == domain.StageStatusCompleted)
		rows = ComputeStageStandingsWithMetric(st, effectiveRoster, stageIdx, "", nil, done)
	}

	metric := st.Config.QualifyingMetric
	if stg != nil {
		metric = stg.Settings.Normalized(st.Config, stg.Format).QualifyingMetric
	}

	bestPackBySlot := make(map[int]string)
	bestValBySlot := make(map[int]float64)
	validLapsBySlot := make(map[int][]string)

	for _, h := range st.Heats {
		if h.StageIndex != stageIdx || (h.State != domain.HeatConfirmed && h.State != domain.HeatFinished) {
			continue
		}
		packLabel := h.ShortLabel
		if packLabel == "" {
			packLabel = h.ID
		}
		for _, s := range h.Seats {
			if s.PilotSlotIndex <= 0 || s.Status == domain.PilotHeatDQ || s.Status == domain.PilotHeatDNS {
				continue
			}
			for _, lap := range s.Laps {
				if lap.LapNumber >= 1 && !lap.Invalidated && lap.SplitTimeSec > 0 {
					validLapsBySlot[s.PilotSlotIndex] = append(
						validLapsBySlot[s.PilotSlotIndex],
						fmt.Sprintf("%.3f", lap.SplitTimeSec),
					)
				}
			}
			switch metric {
			case domain.QualMetricBestLap:
				if s.BestLapSec > 0 && (bestValBySlot[s.PilotSlotIndex] == 0 || s.BestLapSec < bestValBySlot[s.PilotSlotIndex]) {
					bestValBySlot[s.PilotSlotIndex] = s.BestLapSec
					bestPackBySlot[s.PilotSlotIndex] = packLabel
				}
			case domain.QualMetricConsecutive2:
				if s.BestConsecutive2Sec > 0 && (bestValBySlot[s.PilotSlotIndex] == 0 || s.BestConsecutive2Sec < bestValBySlot[s.PilotSlotIndex]) {
					bestValBySlot[s.PilotSlotIndex] = s.BestConsecutive2Sec
					bestPackBySlot[s.PilotSlotIndex] = packLabel
				} else if bestValBySlot[s.PilotSlotIndex] == 0 && s.BestLapSec > 0 {
					bestPackBySlot[s.PilotSlotIndex] = packLabel
				}
			case domain.QualMetricLapsInTime:
				val := float64(s.LapsCompleted)
				if val > bestValBySlot[s.PilotSlotIndex] {
					bestValBySlot[s.PilotSlotIndex] = val
					bestPackBySlot[s.PilotSlotIndex] = packLabel
				}
			default:
				if s.BestConsecutive3Sec > 0 && (bestValBySlot[s.PilotSlotIndex] == 0 || s.BestConsecutive3Sec < bestValBySlot[s.PilotSlotIndex]) {
					bestValBySlot[s.PilotSlotIndex] = s.BestConsecutive3Sec
					bestPackBySlot[s.PilotSlotIndex] = packLabel
				} else if bestValBySlot[s.PilotSlotIndex] == 0 && s.BestLapSec > 0 {
					bestPackBySlot[s.PilotSlotIndex] = packLabel
				}
			}
		}
	}

	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	_ = w.Write([]string{
		"Rank",
		"Callsign",
		"PhoneticName",
		"Seed",
		"Status",
		"Best3ConsecutiveSec",
		"BestLapSec",
		"TotalLaps",
		"PacksFlown",
		"Wins",
		"Points",
		"BestPack",
		"AllValidLapsSec",
	})

	fmtSec := func(v float64) string {
		if v <= 0 {
			return ""
		}
		return fmt.Sprintf("%.3f", v)
	}

	for _, r := range rows {
		_ = w.Write([]string{
			strconv.Itoa(r.Rank),
			r.Callsign,
			r.PhoneticName,
			strconv.Itoa(r.Seed),
			r.BracketStatus,
			fmtSec(r.BestConsecutive3Sec),
			fmtSec(r.BestLapSec),
			strconv.Itoa(r.TotalLaps),
			strconv.Itoa(r.HeatsFlown),
			strconv.Itoa(r.Wins),
			strconv.Itoa(r.Points),
			bestPackBySlot[r.PilotSlotIndex],
			strings.Join(validLapsBySlot[r.PilotSlotIndex], ";"),
		})
	}
	w.Flush()
	return buf.String()
}
