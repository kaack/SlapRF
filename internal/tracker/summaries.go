package tracker

import (
	"math"
	"sort"

	"fpv-gate-timer/internal/domain"
)

// orderedPucksLocked returns the gate pucks in track order.
func (e *Engine) orderedPucksLocked() []domain.GatePuck {
	ordered := append([]domain.GatePuck(nil), e.pucks...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].TrackOrder < ordered[j].TrackOrder })
	return ordered
}

func (e *Engine) computeSummariesLocked() []domain.PilotTrackSummary {
	ordered := e.orderedPucksLocked()
	numSectors := len(ordered)
	if numSectors < 1 {
		return []domain.PilotTrackSummary{}
	}

	summaries := make([]domain.PilotTrackSummary, 0, len(e.pilots))
	for _, pilot := range e.pilots {
		if !pilot.Enabled {
			continue
		}

		var lapsCompleted int
		var lastLapSec, bestLapSec float64
		for _, l := range e.laps {
			if l.SlotIndex == pilot.SlotIndex {
				lapsCompleted++
				lastLapSec = l.LapTimeSec
				if bestLapSec == 0 || l.LapTimeSec < bestLapSec {
					bestLapSec = l.LapTimeSec
				}
			}
		}

		sectorStats := make([]domain.SectorBottleneckStat, 0, numSectors)
		var theoreticalBest float64
		allSectorsHaveBest := true

		for sIdx := 1; sIdx <= numSectors; sIdx++ {
			fromPuck := ordered[(sIdx-1)%numSectors].PuckID
			toPuck := ordered[sIdx%numSectors].PuckID
			hist := e.sectorHistory[sectorKey(pilot.SlotIndex, pairKey(fromPuck, toPuck))]
			stat := domain.SectorBottleneckStat{
				SectorIndex: sIdx,
				Label:       e.sectionLabelLocked(fromPuck, toPuck),
				FromPuckID:  fromPuck,
				ToPuckID:    toPuck,
			}
			if len(hist) == 0 {
				allSectorsHaveBest = false
				sectorStats = append(sectorStats, stat)
				continue
			}

			best := hist[0].SplitSeconds
			var sum, speedSum float64
			for _, h := range hist {
				best = math.Min(best, h.SplitSeconds)
				sum += h.SplitSeconds
				speedSum += h.ExitSpeedMph
			}
			avg := sum / float64(len(hist))
			var varianceSum float64
			for _, h := range hist {
				varianceSum += (h.SplitSeconds - avg) * (h.SplitSeconds - avg)
			}
			theoreticalBest += best

			stat.BestSplitSec = round3(best)
			stat.AverageSplitSec = round3(avg)
			stat.StdDevSec = round3(math.Sqrt(varianceSum / float64(len(hist))))
			stat.AvgTimeLostSec = round3(avg - best)
			stat.AverageExitSpeedMph = math.Round(speedSum/float64(len(hist))*10) / 10
			sectorStats = append(sectorStats, stat)
		}

		if !allSectorsHaveBest {
			theoreticalBest = 0
		}
		var potentialGain float64
		if bestLapSec > 0 && theoreticalBest > 0 && bestLapSec > theoreticalBest {
			potentialGain = round3(bestLapSec - theoreticalBest)
		}

		curSector := 1
		var lastPuck uint8 = 1
		if prog, ok := e.progress[pilot.SlotIndex]; ok && prog.lastPuckID > 0 {
			curSector = len(prog.currentSectors) + 1
			lastPuck = prog.lastPuckID
		}

		summaries = append(summaries, domain.PilotTrackSummary{
			SlotIndex:          pilot.SlotIndex,
			Callsign:           pilot.Callsign,
			Color:              pilot.Color,
			ChannelLabel:       pilot.ChannelLabel(),
			LapsCompleted:      lapsCompleted,
			LastLapSec:         lastLapSec,
			BestLapSec:         bestLapSec,
			TheoreticalBestSec: round3(theoreticalBest),
			PotentialGainSec:   potentialGain,
			CurrentSectorIndex: curSector,
			LastPuckID:         lastPuck,
			SectorStats:        sectorStats,
		})
	}

	sort.Slice(summaries, func(i, j int) bool {
		a, b := summaries[i], summaries[j]
		if a.BestLapSec > 0 && b.BestLapSec > 0 {
			return a.BestLapSec < b.BestLapSec
		}
		if a.BestLapSec > 0 != (b.BestLapSec > 0) {
			return a.BestLapSec > 0
		}
		return a.SlotIndex < b.SlotIndex
	})
	return summaries
}
