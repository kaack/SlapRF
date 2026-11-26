package tracker

import (
	"encoding/json"
	"math"
	"sort"
	"sync"

	"slaprf/internal/domain"
	"slaprf/internal/tracestore"
)

var (
	demoShowcaseOnce sync.Once
	demoShowcaseJSON []byte
)

func buildDemoRssiTrace(crossingOffsetsMs []int64, durationMs int32) []domain.HeatRssiSample {
	if durationMs < 46000 {
		durationMs = 46000
	}
	trace := make([]domain.HeatRssiSample, 0, (int(durationMs)+2500)/100+2)
	for t := int32(-2500); t <= durationMs; t += 100 {
		rssi := -92.0 + 1.4*math.Sin(float64(t)/720.0)
		for idx, pkMs := range crossingOffsetsMs {
			dist := math.Abs(float64(t) - float64(pkMs))
			if dist < 2400 {
				peakTop := -38.5 - float64(idx%3)*1.7
				sigma := 410.0
				bump := (peakTop - (-92.0)) * math.Exp(-(dist*dist)/(2*sigma*sigma))
				if -92.0+bump > rssi {
					rssi = -92.0 + bump
				}
			}
		}
		trace = append(trace, domain.HeatRssiSample{
			OffsetMs: t,
			Dbm:      int16(math.Round(rssi)),
		})
	}
	return trace
}

func threeGateSectorsForLap(totalSec float64, bestSplit [3]float64, overallBest [3]float64) []domain.SectorSplit {
	s1 := math.Round(totalSec*0.32*1000) / 1000
	s2 := math.Round(totalSec*0.35*1000) / 1000
	s3 := math.Round((totalSec-s1-s2)*1000) / 1000
	splits := [3]float64{s1, s2, s3}
	labels := [3]string{
		"S1 (Start / Finish → Gate 2)",
		"S2 (Gate 2 → Gate 3)",
		"S3 (Gate 3 → Start / Finish)",
	}
	fromGates := [3]uint8{1, 2, 3}
	toGates := [3]uint8{2, 3, 1}
	speeds := [3]float64{47.4, 44.8, 49.1}

	out := make([]domain.SectorSplit, 3)
	for i := 0; i < 3; i++ {
		badge := domain.BadgeNormal
		delta := 0.0
		if bestSplit[i] > 0 {
			delta = math.Round((splits[i]-bestSplit[i])*1000) / 1000
		}
		if overallBest[i] > 0 && math.Abs(splits[i]-overallBest[i]) < 0.0005 {
			badge = domain.BadgeOverallBest
		} else if bestSplit[i] > 0 && math.Abs(splits[i]-bestSplit[i]) < 0.0005 {
			badge = domain.BadgePersonalBest
		}
		out[i] = domain.SectorSplit{
			SectorIndex:    i + 1,
			FromGateID:     fromGates[i],
			ToGateID:       toGates[i],
			Label:          labels[i],
			SplitSeconds:   splits[i],
			ExitSpeedMph:   speeds[i],
			DeltaToBestSec: delta,
			Badge:          badge,
		}
	}
	return out
}

func buildDemoPracticeDataset(
	pilots []domain.PilotSlot,
	slotIndices []int,
	lapsPerPilot int,
	baseUs uint64,
	lapIDStart uint64,
	eventIDStart uint64,
	paceOffsetSec float64,
) ([]domain.LapRecord, []domain.GateCrossingEvent, []domain.FilteredDetection) {
	pilotBySlot := make(map[int]domain.PilotSlot, len(pilots))
	for _, p := range pilots {
		pilotBySlot[p.SlotIndex] = p
	}

	rawSplits := make(map[int][][3]float64, len(slotIndices))
	pilotBestLap := make(map[int]float64, len(slotIndices))
	var pilotBestSecMap = make(map[int][3]float64, len(slotIndices))
	var overallBestSec [3]float64

	for pOrder, slot := range slotIndices {
		bests := [3]float64{999, 999, 999}
		bestLap := 999.0
		series := make([][3]float64, lapsPerPilot)
		for l := 0; l < lapsPerPilot; l++ {
			wave := []float64{0.34, 0.14, 0.0, 0.21, 0.09, 0.27}[l%6]
			total := 12.45 + paceOffsetSec + float64(pOrder)*0.42 + wave
			s1 := math.Round((total*0.32+float64((l+pOrder)%2)*0.04)*1000) / 1000
			s2 := math.Round((total*0.35-float64(l%2)*0.03)*1000) / 1000
			s3 := math.Round((total-s1-s2)*1000) / 1000
			sum := math.Round((s1+s2+s3)*1000) / 1000
			series[l] = [3]float64{s1, s2, s3}
			if sum < bestLap {
				bestLap = sum
			}
			for si := 0; si < 3; si++ {
				if series[l][si] < bests[si] {
					bests[si] = series[l][si]
				}
				if overallBestSec[si] == 0 || series[l][si] < overallBestSec[si] {
					overallBestSec[si] = series[l][si]
				}
			}
		}
		rawSplits[slot] = series
		pilotBestLap[slot] = bestLap
		pilotBestSecMap[slot] = bests
	}

	channels := [4]uint8{1, 3, 5, 8}
	var laps []domain.LapRecord
	var crossings []domain.GateCrossingEvent
	passingByGate := map[uint8]uint32{1: 0, 2: 0, 3: 0}
	eventID := eventIDStart
	lapID := lapIDStart

	gateNames := map[uint8]string{
		1: "Start / Finish",
		2: "Gate 2",
		3: "Gate 3",
	}

	cursorByPilot := make(map[int]uint64, len(slotIndices))
	for pOrder, slot := range slotIndices {
		p := pilotBySlot[slot]
		ch := channels[pOrder%len(channels)]
		freq := domain.FrequencyForBandChannel(domain.BandRaceband, ch)
		tUs := baseUs + uint64(pOrder)*1_150_000
		passingByGate[1]++
		eventID++
		crossings = append(crossings, domain.GateCrossingEvent{
			EventID:           eventID,
			GateID:            1,
			GateName:          gateNames[1],
			IsStartFinish:     true,
			StartedLap:        true,
			SlotIndex:         slot,
			Callsign:          p.Callsign,
			FrequencyMHz:      freq,
			TimestampUs:       tUs,
			PeakRSSIDbm:       -40.8,
			LapRFPeakHeight:   2160,
			BeamwidthMs:       86.0,
			EstimatedSpeedMph: 46.5,
			PassingNumber:     passingByGate[1],
		})
		cursorByPilot[slot] = tUs
	}

	for lIdx := 0; lIdx < lapsPerPilot; lIdx++ {
		for pOrder, slot := range slotIndices {
			p := pilotBySlot[slot]
			ch := channels[pOrder%len(channels)]
			freq := domain.FrequencyForBandChannel(domain.BandRaceband, ch)
			sp := rawSplits[slot][lIdx]
			tUs := cursorByPilot[slot]

			fromGates := [3]uint8{1, 2, 3}
			toGates := [3]uint8{2, 3, 1}
			labels := [3]string{
				"S1 (Start / Finish → Gate 2)",
				"S2 (Gate 2 → Gate 3)",
				"S3 (Gate 3 → Start / Finish)",
			}
			speeds := [3]float64{48.2, 45.1, 49.6}

			sectors := make([]domain.SectorSplit, 3)
			lapTotal := 0.0
			for sIdx := 0; sIdx < 3; sIdx++ {
				secDur := sp[sIdx]
				lapTotal += secDur
				tUs += uint64(math.Round(secDur * 1e6))
				toGate := toGates[sIdx]

				pBest := pilotBestSecMap[slot][sIdx]
				delta := math.Round((secDur-pBest)*1000) / 1000
				badge := domain.BadgeNormal
				if math.Abs(secDur-overallBestSec[sIdx]) < 0.0005 {
					badge = domain.BadgeOverallBest
				} else if math.Abs(secDur-pBest) < 0.0005 {
					badge = domain.BadgePersonalBest
				}
				sectors[sIdx] = domain.SectorSplit{
					SectorIndex:    sIdx + 1,
					FromGateID:     fromGates[sIdx],
					ToGateID:       toGate,
					Label:          labels[sIdx],
					SplitSeconds:   secDur,
					ExitSpeedMph:   speeds[sIdx],
					DeltaToBestSec: delta,
					Badge:          badge,
				}

				passingByGate[toGate]++
				eventID++
				crossings = append(crossings, domain.GateCrossingEvent{
					EventID:           eventID,
					GateID:            toGate,
					GateName:          gateNames[toGate],
					IsStartFinish:     toGate == 1,
					SlotIndex:         slot,
					Callsign:          p.Callsign,
					FrequencyMHz:      freq,
					TimestampUs:       tUs,
					PeakRSSIDbm:       -39.4 - float32(sIdx)*1.3,
					LapRFPeakHeight:   2200 - float32(sIdx)*55,
					BeamwidthMs:       84.0 + float64(sIdx)*3.0,
					EstimatedSpeedMph: speeds[sIdx],
					PassingNumber:     passingByGate[toGate],
				})
			}

			cursorByPilot[slot] = tUs
			lapTotal = math.Round(lapTotal*1000) / 1000
			best := pilotBestLap[slot]
			isPB := math.Abs(lapTotal-best) < 0.0005
			lapID++
			laps = append(laps, domain.LapRecord{
				LapID:         lapID,
				SlotIndex:     slot,
				Callsign:      p.Callsign,
				LapNumber:     lIdx + 1,
				LapTimeSec:    lapTotal,
				CompletedAtUs: tUs,
				DeltaToBest:   math.Round((lapTotal-best)*1000) / 1000,
				IsBestLap:     isPB,
				Sectors:       sectors,
			})
		}
	}

	var filtered []domain.FilteredDetection
	if len(slotIndices) >= 2 {
		p0 := pilotBySlot[slotIndices[0]]
		p1 := pilotBySlot[slotIndices[1]]
		filtered = []domain.FilteredDetection{
			{
				TimestampUs: baseUs + 8_200_000,
				GateID:      2,
				SlotIndex:   p0.SlotIndex,
				Callsign:    p0.Callsign,
				Reason:      domain.FilterMinLap,
				Detail:      "Gate 2 again after 1.18s - quicker than min lap (5.0s)",
				PeakRSSIDbm: -49.2,
			},
			{
				TimestampUs: baseUs + 16_500_000,
				GateID:      3,
				SlotIndex:   p1.SlotIndex,
				Callsign:    p1.Callsign,
				Reason:      domain.FilterSpike,
				Detail:      "Sharp 45 ms spike at Gate 3 (min crossing 120 ms)",
				PeakRSSIDbm: -51.6,
			},
		}
	}

	return laps, crossings, filtered
}

type recordedHeatOffsets struct {
	raceID string
	heatID string
	bySlot map[int][]int64
}

func confirmShowcaseHeat(
	eng *Engine,
	raceID string,
	heatID string,
	penaltySeatIdx int,
	penaltySec float64,
	heatSeed int,
) (recordedHeatOffsets, bool) {
	if _, err := eng.RaceControlActionWithOptions(raceID, "start", heatID, true); err != nil {
		return recordedHeatOffsets{}, false
	}
	_, _ = eng.RaceControlActionWithOptions(raceID, "skip_countdown", heatID, true)
	if _, err := eng.RaceControlActionWithOptions(raceID, "stop", heatID, true); err != nil {
		return recordedHeatOffsets{}, false
	}

	rs := eng.RaceSnapshot()
	var targetHeat *domain.RaceHeat
	for i := range rs.Heats {
		if rs.Heats[i].ID == heatID {
			targetHeat = &rs.Heats[i]
			break
		}
	}
	if targetHeat == nil {
		return recordedHeatOffsets{}, false
	}

	rec := recordedHeatOffsets{
		raceID: raceID,
		heatID: heatID,
		bySlot: make(map[int][]int64, len(targetHeat.Seats)),
	}

	for sIdx, seat := range targetHeat.Seats {
		if seat.PilotSlotIndex <= 0 {
			continue
		}
		// Order pace subtly by pilot slot + heatSeed so faster seeds advance naturally while staying competitive
		skillBias := int64((seat.PilotSlotIndex%5)*210 + (heatSeed%3)*95 + sIdx*140)
		holeshotMs := int64(1380 + sIdx*175)
		lap1Ms := holeshotMs + 12450 + skillBias
		lap2Ms := lap1Ms + 12280 + skillBias
		lap3Ms := lap2Ms + 12390 + skillBias
		offsets := []int64{holeshotMs, lap1Ms, lap2Ms, lap3Ms}
		rec.bySlot[seat.PilotSlotIndex] = offsets

		for _, off := range offsets {
			ms := off
			_, _ = eng.MarshalPilotAction(RaceMarshalPayload{
				RaceID:         raceID,
				HeatID:         heatID,
				PilotSlotIndex: seat.PilotSlotIndex,
				Action:         "add_crossing",
				OffsetMs:       &ms,
			})
		}

		if penaltySeatIdx > 0 && seat.SeatIndex == penaltySeatIdx && penaltySec > 0 {
			_, _ = eng.MarshalPilotAction(RaceMarshalPayload{
				RaceID:         raceID,
				HeatID:         heatID,
				PilotSlotIndex: seat.PilotSlotIndex,
				Action:         "set_penalty",
				PenaltySec:     penaltySec,
			})
		}
	}

	if _, err := eng.RaceControlActionWithOptions(raceID, "confirm", heatID, true); err != nil {
		return recordedHeatOffsets{}, false
	}
	return rec, true
}

func buildShowcaseEngineStateJSON() []byte {
	tmp := NewEngine()
	tmp.mu.Lock()
	tmp.timingHardwareMode = domain.HardwareModeSlapRF
	tmp.pilots = domain.DefaultPilotSlots()
	tmp.gates = domain.DemoTrackGates()
	tmp.detected = make(map[uint8]*domain.DetectedTimer)
	tmp.seedSimTimersLocked()
	tmp.practiceState = domain.PracticeManagerState{}
	tmp.eventState = domain.EventManagerState{}
	tmp.raceState = newDefaultRaceState()
	tmp.resetSessionLocked()
	tmp.initDetectorsLocked()
	tmp.ensureEventStateInitializedLocked()
	tmp.ensurePracticeStateInitializedLocked()
	tmp.mu.Unlock()

	checkInFirstN := func(raceID string, n int) {
		total := tmp.PilotCount()
		for slot := 1; slot <= total; slot++ {
			checked := slot <= n
			_, _ = tmp.EventAction(EventActionPayload{
				Action:    "update_attendance",
				RaceID:    raceID,
				SlotIndex: slot,
				CheckedIn: &checked,
			})
		}
	}

	var allRecordedHeats []recordedHeatOffsets

	// 1. Draft Race Ready to Start: "Sunday Spec Shootout" (Single Elimination, 8 pilots)
	if rDraft, err := tmp.EventAction(EventActionPayload{
		Action: "create_race",
		Name:   "Sunday Spec Shootout",
		Tags:   []string{"Spec", "Single-Elim"},
	}); err == nil {
		checkInFirstN(rDraft.RaceID, 8)
		_, _ = tmp.BracketEditAction(BracketEditPayload{
			Action:        "apply_template",
			RaceID:        rDraft.RaceID,
			TemplateID:    "single_elimination",
			PilotsPerHeat: 4,
			TargetLaps:    3,
		})
		// Showcase an independent 2-gate Spec Course + 6.0s Min Lap rule on the draft race.
		_ = tmp.RemoveRaceGate(rDraft.RaceID, 3)
		specRules := domain.DefaultTimingRules()
		specRules.MinLapSec = 6.0
		_, _ = tmp.SetRaceRules(rDraft.RaceID, specRules)
	}

	// 2. Paused Open Qualifier: "Wednesday Open Qualifier" (Best 3 Consecutive Laps, 2 confirmed packs + 2 queued)
	if rOQ, err := tmp.EventAction(EventActionPayload{
		Action: "create_race",
		Name:   "Wednesday Open Qualifier",
		Tags:   []string{"Open-Qualifier", "Packs"},
	}); err == nil {
		checkInFirstN(rOQ.RaceID, 8)
		maxPacks := 3
		_, _ = tmp.BracketEditAction(BracketEditPayload{
			Action:           "apply_template",
			RaceID:           rOQ.RaceID,
			TemplateID:       "open_qualifier",
			PilotsPerHeat:    4,
			TimeLimitSec:     120,
			QualifyingMetric: domain.QualMetricConsecutive3,
			MaxPacksPerPilot: &maxPacks,
		})
		_, _ = tmp.BracketEditAction(BracketEditPayload{
			Action: "open_qual_enqueue_all",
			RaceID: rOQ.RaceID,
		})
		_, _ = tmp.EventAction(EventActionPayload{
			Action:          "race_lifecycle",
			RaceID:          rOQ.RaceID,
			LifecycleAction: "start_race",
			PreemptOngoing:  true,
		})
		for idx, hID := range []string{"OQ-1", "OQ-2"} {
			if rec, ok := confirmShowcaseHeat(tmp, rOQ.RaceID, hID, 0, 0, idx+1); ok {
				allRecordedHeats = append(allRecordedHeats, rec)
			}
		}
		_, _ = tmp.BracketEditAction(BracketEditPayload{
			Action: "open_qual_enqueue_all",
			RaceID: rOQ.RaceID,
		})
		_, _ = tmp.EventAction(EventActionPayload{
			Action:          "race_lifecycle",
			RaceID:          rOQ.RaceID,
			LifecycleAction: "pause_race",
			Reason:          "Pack swap break",
		})
	}

	// 3. Paused Multi-Phase Tournament: "Friday Night Qualifier & Mains" (Qualifying complete -> Double Elim Mains underway on unified graph)
	if rTwoStage, err := tmp.EventAction(EventActionPayload{
		Action: "create_race",
		Name:   "Friday Night Qualifier & Mains",
		Tags:   []string{"Qual + Mains", "Club"},
	}); err == nil {
		checkInFirstN(rTwoStage.RaceID, 8)
		_, _ = tmp.BracketEditAction(BracketEditPayload{
			Action:           "apply_template",
			RaceID:           rTwoStage.RaceID,
			TemplateID:       "qual_double_elim",
			PilotsPerHeat:    4,
			TargetLaps:       3,
			QualifyingRounds: 2,
		})
		_, _ = tmp.EventAction(EventActionPayload{
			Action:          "race_lifecycle",
			RaceID:          rTwoStage.RaceID,
			LifecycleAction: "start_race",
			PreemptOngoing:  true,
		})
		// Confirm all Qualifying heats so Mains seeds automatically on the unified graph
		for step := 0; step < 8; step++ {
			snap := tmp.RaceSnapshot()
			nextS1 := ""
			for _, h := range snap.Heats {
				if h.StageFormat == domain.FormatQualifying && (h.State == domain.HeatStaged || h.State == domain.HeatReady) {
					hasPilot := false
					for _, s := range h.Seats {
						if s.PilotSlotIndex > 0 {
							hasPilot = true
							break
						}
					}
					if hasPilot {
						nextS1 = h.ID
						break
					}
				}
			}
			if nextS1 == "" {
				break
			}
			if rec, ok := confirmShowcaseHeat(tmp, rTwoStage.RaceID, nextS1, 0, 0, step+1); ok {
				allRecordedHeats = append(allRecordedHeats, rec)
			} else {
				break
			}
		}
		// Confirm first Mains heat with a +5s marshal penalty on Seat 3
		snapMains := tmp.RaceSnapshot()
		for _, h := range snapMains.Heats {
			if h.StageFormat != domain.FormatQualifying && (h.State == domain.HeatStaged || h.State == domain.HeatReady) {
				if rec, ok := confirmShowcaseHeat(tmp, rTwoStage.RaceID, h.ID, 3, 5.0, 9); ok {
					allRecordedHeats = append(allRecordedHeats, rec)
				}
				break
			}
		}
		_, _ = tmp.EventAction(EventActionPayload{
			Action:          "race_lifecycle",
			RaceID:          rTwoStage.RaceID,
			LifecycleAction: "pause_race",
			Reason:          "Mains bracket in progress",
		})
	}

	// 4. Completed Championship: "Bay Area Championship" (Double Elimination, all bracket heats confirmed & Champion crowned)
	if rChamp, err := tmp.EventAction(EventActionPayload{
		Action: "create_race",
		Name:   "Bay Area Championship",
		Tags:   []string{"Championship", "Double-Elim"},
	}); err == nil {
		checkInFirstN(rChamp.RaceID, 8)
		_, _ = tmp.BracketEditAction(BracketEditPayload{
			Action:        "apply_template",
			RaceID:        rChamp.RaceID,
			TemplateID:    "double_elimination",
			PilotsPerHeat: 4,
			TargetLaps:    3,
			FinalsFormat:  domain.FinalsSingle,
		})
		_, _ = tmp.EventAction(EventActionPayload{
			Action:          "race_lifecycle",
			RaceID:          rChamp.RaceID,
			LifecycleAction: "start_race",
			PreemptOngoing:  true,
		})
		for step := 0; step < 16; step++ {
			snap := tmp.RaceSnapshot()
			if snap.IsComplete {
				break
			}
			nextHeat := ""
			if snap.ActiveHeatID != "" {
				for _, h := range snap.Heats {
					if h.ID == snap.ActiveHeatID && (h.State == domain.HeatStaged || h.State == domain.HeatReady) {
						nextHeat = h.ID
						break
					}
				}
			}
			if nextHeat == "" {
				for _, h := range snap.Heats {
					if h.State == domain.HeatStaged || h.State == domain.HeatReady {
						hasPilot := false
						for _, s := range h.Seats {
							if s.PilotSlotIndex > 0 {
								hasPilot = true
								break
							}
						}
						if hasPilot {
							nextHeat = h.ID
							break
						}
					}
				}
			}
			if nextHeat == "" {
				break
			}
			if rec, ok := confirmShowcaseHeat(tmp, rChamp.RaceID, nextHeat, 0, 0, step+2); ok {
				allRecordedHeats = append(allRecordedHeats, rec)
			} else {
				break
			}
		}
		_, _ = tmp.EventAction(EventActionPayload{
			Action:          "race_lifecycle",
			RaceID:          rChamp.RaceID,
			LifecycleAction: "complete_race",
		})
	}

	st := tmp.ExportState()

	// Enrich every confirmed heat across all showcase races with 3-sector splits & 10 Hz Start/Finish RSSI waveforms
	recLookup := make(map[string]map[int][]int64, len(allRecordedHeats))
	for _, rec := range allRecordedHeats {
		recLookup[rec.raceID+"::"+rec.heatID] = rec.bySlot
	}
	enrichRace := func(r *domain.RaceTournamentState) {
		if r == nil {
			return
		}
		var overallBest [3]float64
		for hi := range r.Heats {
			h := &r.Heats[hi]
			bySlot, ok := recLookup[r.RaceID+"::"+h.ID]
			if !ok {
				continue
			}
			h.ElapsedSec = 42.6
			for si := range h.Seats {
				seat := &h.Seats[si]
				offs := bySlot[seat.PilotSlotIndex]
				if len(offs) == 0 {
					continue
				}
				seat.RssiTrace = buildDemoRssiTrace(offs, int32(offs[len(offs)-1]+3500))
				bestSplit := [3]float64{999, 999, 999}
				for _, lap := range seat.Laps {
					if lap.LapNumber <= 0 || lap.SplitTimeSec <= 0 {
						continue
					}
					s1 := math.Round(lap.SplitTimeSec*0.32*1000) / 1000
					s2 := math.Round(lap.SplitTimeSec*0.35*1000) / 1000
					s3 := math.Round((lap.SplitTimeSec-s1-s2)*1000) / 1000
					cand := [3]float64{s1, s2, s3}
					for k := 0; k < 3; k++ {
						if cand[k] < bestSplit[k] {
							bestSplit[k] = cand[k]
						}
						if overallBest[k] == 0 || cand[k] < overallBest[k] {
							overallBest[k] = cand[k]
						}
					}
				}
				for li := range seat.Laps {
					lap := &seat.Laps[li]
					lap.Manual = false
					if lap.LapNumber <= 0 || lap.SplitTimeSec <= 0 {
						continue
					}
					lap.Sectors = threeGateSectorsForLap(lap.SplitTimeSec, bestSplit, overallBest)
				}
				for ci := range seat.Crossings {
					if ci > 0 && ci < len(seat.Laps) && len(seat.Laps[ci].Sectors) > 0 {
						seat.Crossings[ci].Sectors = append([]domain.SectorSplit(nil), seat.Laps[ci].Sectors...)
					}
					seat.Crossings[ci].PeakRSSIDbm = -40.2
					seat.Crossings[ci].Manual = false
				}
			}
		}
	}
	enrichRace(st.RaceState)
	if st.EventState != nil {
		for ri := range st.EventState.Races {
			enrichRace(&st.EventState.Races[ri])
		}
	}

	// Build 3 showcase Practice sessions on the 3-gate course:
	// - Session 1 ("Open Track Practice"): active & selected live session (FAERRY, MeWo, Din, BigRamon on R1/R3/R5/R8)
	// - Session 2 ("Spec Class Pace"): completed historical session (Red5, SwampDog, Morbid, Kyosanym)
	// - Session 3 ("Morning Track Tune"): completed historical session (FAERRY, OneEye, FreeLove)
	makeSessionPilot := func(slot int, ch uint8) domain.PracticeSessionPilot {
		p := st.Pilots[slot-1]
		return domain.PracticeSessionPilot{
			SlotIndex:    p.SlotIndex,
			Callsign:     p.Callsign,
			PhoneticName: p.PhoneticName,
			Color:        p.Color,
			Band:         domain.BandRaceband,
			Channel:      ch,
			FrequencyMHz: domain.FrequencyForBandChannel(domain.BandRaceband, ch),
		}
	}

	tuneLaps, tuneCrossings, tuneFiltered := buildDemoPracticeDataset(
		st.Pilots, []int{1, 9, 10}, 2, 4_000_000, 0, 0, 0.55,
	)
	specLaps, specCrossings, specFiltered := buildDemoPracticeDataset(
		st.Pilots, []int{5, 6, 7, 8}, 3, 45_000_000, 100, 200, 0.28,
	)
	liveLaps, liveCrossings, liveFiltered := buildDemoPracticeDataset(
		st.Pilots, []int{1, 2, 3, 4}, 3, 110_000_000, 300, 500, 0.0,
	)

	var maxCompletedUs uint64 = 165_000_000
	for _, l := range liveLaps {
		if l.CompletedAtUs > maxCompletedUs {
			maxCompletedUs = l.CompletedAtUs
		}
	}

	if st.RaceState != nil {
		st.RaceState.Mode = domain.ModePractice
	}
	openRules := domain.DefaultTimingRules().Normalized()
	specPaceRules := domain.DefaultTimingRules()
	specPaceRules.MinLapSec = 5.5
	specPaceRules.MaxLapSec = 90.0
	specPaceRules = specPaceRules.Normalized()
	tuneRules := domain.DefaultTimingRules()
	tuneRules.MinLapSec = 4.5
	tuneRules = tuneRules.Normalized()

	// Convert tuneLaps/tuneCrossings/tuneFiltered to a 1-gate Start/Finish warmup track for Session 3
	var tuneOneGate []domain.TrackGate
	if len(st.Gates) > 0 {
		g0 := cloneTrackGate(st.Gates[0])
		g0.Role = domain.GateRoleStartFinish
		g0.TrackOrder = 0
		tuneOneGate = []domain.TrackGate{g0}
	}
	for i := range tuneLaps {
		tuneLaps[i].Sectors = []domain.SectorSplit{
			{
				SectorIndex:    1,
				FromGateID:     1,
				ToGateID:       1,
				Label:          "S1 (Start / Finish → Start / Finish)",
				SplitSeconds:   tuneLaps[i].LapTimeSec,
				ExitSpeedMph:   49.4,
				DeltaToBestSec: tuneLaps[i].DeltaToBest,
				Badge:          domain.BadgeNormal,
			},
		}
		if tuneLaps[i].IsBestLap {
			tuneLaps[i].Sectors[0].Badge = domain.BadgePersonalBest
		}
	}
	keptTuneCrossings := make([]domain.GateCrossingEvent, 0, len(tuneCrossings))
	var sfPass uint32
	for _, c := range tuneCrossings {
		if c.GateID != 1 {
			continue
		}
		sfPass++
		c.PassingNumber = sfPass
		keptTuneCrossings = append(keptTuneCrossings, c)
	}
	tuneCrossings = keptTuneCrossings
	for i := range tuneFiltered {
		tuneFiltered[i].GateID = 1
		if tuneFiltered[i].Reason == domain.FilterMinLap {
			tuneFiltered[i].Detail = "Start / Finish again after 1.18s - quicker than min lap (4.5s)"
		} else {
			tuneFiltered[i].Detail = "Sharp 45 ms spike at Start / Finish (min crossing 120 ms)"
		}
	}

	st.SavedAtUnixUs = 0
	st.ElapsedUs = maxCompletedUs + 15_000_000
	st.RaceArmed = true
	st.Laps = liveLaps
	st.Crossings = liveCrossings
	st.Filtered = liveFiltered
	st.PracticeState = &domain.PracticeManagerState{
		Initialized:       true,
		ActiveSessionID:   "session-1",
		SelectedSessionID: "session-1",
		Sessions: []domain.PracticeSession{
			{
				SessionID: "session-1",
				Name:      "Open Track Practice",
				Tags:      []string{"Live", "5-Inch"},
				Active:    true,
				Paused:    false,
				CreatedAt: "2026-11-15T18:10:00Z",
				UpdatedAt: "2026-11-15T18:30:00Z",
				Pilots: []domain.PracticeSessionPilot{
					makeSessionPilot(1, 1),
					makeSessionPilot(2, 3),
					makeSessionPilot(3, 5),
					makeSessionPilot(4, 8),
				},
				TrackInitialized: true,
				TrackSnapshot:    cloneTrackGates(st.Gates),
				Rules:            &openRules,
				Laps:             liveLaps,
				Crossings:        liveCrossings,
				Filtered:         liveFiltered,
			},
			{
				SessionID: "session-2",
				Name:      "Spec Class Pace",
				Tags:      []string{"Spec", "6S"},
				Active:    false,
				Paused:    false,
				CreatedAt: "2026-11-15T17:15:00Z",
				UpdatedAt: "2026-11-15T17:40:00Z",
				Pilots: []domain.PracticeSessionPilot{
					makeSessionPilot(5, 1),
					makeSessionPilot(6, 3),
					makeSessionPilot(7, 5),
					makeSessionPilot(8, 8),
				},
				TrackInitialized: true,
				TrackSnapshot:    cloneTrackGates(st.Gates),
				Rules:            &specPaceRules,
				Laps:             specLaps,
				Crossings:        specCrossings,
				Filtered:         specFiltered,
			},
			{
				SessionID: "session-3",
				Name:      "Morning Track Tune",
				Tags:      []string{"Warmup", "Tuning"},
				Active:    false,
				Paused:    false,
				CreatedAt: "2026-11-15T16:20:00Z",
				UpdatedAt: "2026-11-15T16:40:00Z",
				Pilots: []domain.PracticeSessionPilot{
					makeSessionPilot(1, 1),
					makeSessionPilot(9, 3),
					makeSessionPilot(10, 5),
				},
				TrackInitialized: true,
				TrackSnapshot:    tuneOneGate,
				Rules:            &tuneRules,
				Laps:             tuneLaps,
				Crossings:        tuneCrossings,
				Filtered:         tuneFiltered,
			},
		},
	}

	raw, _ := json.Marshal(st)
	return raw
}

func showcaseDemoEngineState() PersistedEngineState {
	demoShowcaseOnce.Do(func() {
		demoShowcaseJSON = buildShowcaseEngineStateJSON()
	})
	var st PersistedEngineState
	_ = json.Unmarshal(demoShowcaseJSON, &st)
	return st
}

func isShowcaseDemoPracticeSession(sess domain.PracticeSession) bool {
	switch sess.SessionID {
	case "session-1":
		return sess.CreatedAt == "2026-11-15T18:10:00Z"
	case "session-2":
		return sess.CreatedAt == "2026-11-15T17:15:00Z"
	case "session-3":
		return sess.CreatedAt == "2026-11-15T16:20:00Z"
	default:
		return false
	}
}

// buildDemoPracticeTraceSamples synthesizes multi-gate 40 Hz `.rfbin` RSSI samples aligned with
// every crossing, sector pass, and filtered spike in `sess` so clicking any lap in a showcase
// Practice session renders full per-timer RSSI waveforms in `PracticeLapEditorModal` and `Signals`.
func buildDemoPracticeTraceSamples(sess domain.PracticeSession, minEndUs uint64) []tracestore.Sample {
	if len(sess.Pilots) == 0 || (len(sess.Crossings) == 0 && len(sess.Laps) == 0) {
		return nil
	}

	var gateIDs []uint8
	for _, g := range sess.TrackSnapshot {
		if g.GateID > 0 {
			gateIDs = append(gateIDs, g.GateID)
		}
	}
	if len(gateIDs) == 0 {
		seenGate := make(map[uint8]bool, 4)
		for _, c := range sess.Crossings {
			if c.GateID > 0 && !seenGate[c.GateID] {
				seenGate[c.GateID] = true
				gateIDs = append(gateIDs, c.GateID)
			}
		}
		sort.Slice(gateIDs, func(i, j int) bool { return gateIDs[i] < gateIDs[j] })
	}
	if len(gateIDs) == 0 {
		gateIDs = []uint8{1}
	}

	slotIndices := make([]uint8, 0, len(sess.Pilots))
	seenSlot := make(map[uint8]bool, len(sess.Pilots))
	for _, p := range sess.Pilots {
		if p.SlotIndex >= 1 && p.SlotIndex <= domain.MaxPilotPoolSize {
			u := uint8(p.SlotIndex)
			if !seenSlot[u] {
				seenSlot[u] = true
				slotIndices = append(slotIndices, u)
			}
		}
	}
	sort.Slice(slotIndices, func(i, j int) bool { return slotIndices[i] < slotIndices[j] })
	if len(slotIndices) == 0 {
		return nil
	}

	var minTsUs, maxTsUs uint64
	noteTs := func(ts uint64) {
		if ts == 0 {
			return
		}
		if minTsUs == 0 || ts < minTsUs {
			minTsUs = ts
		}
		if ts > maxTsUs {
			maxTsUs = ts
		}
	}
	for _, c := range sess.Crossings {
		noteTs(c.TimestampUs)
	}
	for _, l := range sess.Laps {
		noteTs(l.CompletedAtUs)
		durUs := uint64(math.Round(math.Max(0, l.LapTimeSec) * 1e6))
		if l.CompletedAtUs > durUs {
			noteTs(l.CompletedAtUs - durUs)
		}
	}
	for _, f := range sess.Filtered {
		noteTs(f.TimestampUs)
	}
	if maxTsUs == 0 {
		return nil
	}

	startUs := uint64(500_000)
	if minTsUs > 3_500_000 {
		startUs = minTsUs - 3_500_000
	}
	endUs := maxTsUs + 3_500_000
	if sess.Active && minEndUs > endUs && minEndUs <= maxTsUs+18_000_000 {
		endUs = minEndUs
	}

	type gsKey struct {
		gateID uint8
		slot   uint8
	}
	crossByGS := make(map[gsKey][]domain.GateCrossingEvent, len(gateIDs)*len(slotIndices))
	crossBySlot := make(map[uint8][]domain.GateCrossingEvent, len(slotIndices))
	for _, c := range sess.Crossings {
		if c.SlotIndex < 1 || c.SlotIndex > domain.MaxPilotPoolSize {
			continue
		}
		su := uint8(c.SlotIndex)
		crossByGS[gsKey{gateID: c.GateID, slot: su}] = append(crossByGS[gsKey{gateID: c.GateID, slot: su}], c)
		crossBySlot[su] = append(crossBySlot[su], c)
	}
	filtByGS := make(map[gsKey][]domain.FilteredDetection, 4)
	for _, f := range sess.Filtered {
		if f.SlotIndex < 1 || f.SlotIndex > domain.MaxPilotPoolSize {
			continue
		}
		su := uint8(f.SlotIndex)
		filtByGS[gsKey{gateID: f.GateID, slot: su}] = append(filtByGS[gsKey{gateID: f.GateID, slot: su}], f)
	}

	const stepUs = uint64(25_000) // 40 Hz per gate
	estCount := int((endUs-startUs)/stepUs+2) * len(gateIDs)
	out := make([]tracestore.Sample, 0, estCount)
	seqByGate := make(map[uint8]uint32, len(gateIDs))

	// Pre-compensate ~30 ms causal 2-pole envelope lag in `dsp.ChannelDetector.FilterSample`
	// so smoothed replay peaks align with recorded `GateCrossingEvent.TimestampUs` markers.
	const filterLeadUs = 30_000.0

	for tsUs := startUs; tsUs <= endUs; tsUs += stepUs {
		tF := float64(tsUs)
		for gOrd, gateID := range gateIDs {
			seqByGate[gateID]++
			noiseFloor := float32(-92.0 - 0.3*float64(gOrd%3))
			baseFloor := float64(noiseFloor)
			rssis := make([]float32, len(slotIndices))

			for sIdx, slot := range slotIndices {
				rssi := baseFloor +
					1.05*math.Sin(tF/420_000.0+float64(slot)*1.73+float64(gateID)*0.91) +
					0.55*math.Cos(tF/185_000.0+float64(slot)*2.31+float64(gateID)*1.37)

				for _, c := range crossByGS[gsKey{gateID: gateID, slot: slot}] {
					dist := math.Abs(tF - (float64(c.TimestampUs) - filterLeadUs))
					if dist < 2_200_000.0 {
						peakTop := float64(c.PeakRSSIDbm) + 1.4
						if peakTop < -54.0 || peakTop > -15.0 {
							peakTop = -39.5
						}
						const sigmaMain = 220_000.0
						lobe := baseFloor + (peakTop-baseFloor)*math.Exp(-(dist*dist)/(2*sigmaMain*sigmaMain))
						const sigmaSkirt = 660_000.0
						skirt := baseFloor + (-74.0-baseFloor)*math.Exp(-(dist*dist)/(2*sigmaSkirt*sigmaSkirt))
						if lobe > rssi {
							rssi = lobe
						}
						if skirt > rssi {
							rssi = skirt
						}
					}
				}

				if len(gateIDs) > 1 {
					for _, c := range crossBySlot[slot] {
						if c.GateID == gateID {
							continue
						}
						dist := math.Abs(tF - (float64(c.TimestampUs) - filterLeadUs))
						if dist < 1_600_000.0 {
							const sigmaFar = 480_000.0
							farBleed := baseFloor + (-81.5-baseFloor)*math.Exp(-(dist*dist)/(2*sigmaFar*sigmaFar))
							if farBleed > rssi {
								rssi = farBleed
							}
						}
					}
				}

				for _, f := range filtByGS[gsKey{gateID: gateID, slot: slot}] {
					lead := filterLeadUs
					sigma := 200_000.0
					peakBoost := 1.4
					if f.Reason == domain.FilterSpike {
						lead = 15_000.0
						sigma = 42_000.0
						peakBoost = 6.5
					}
					dist := math.Abs(tF - (float64(f.TimestampUs) - lead))
					if dist < 1_600_000.0 {
						peakTop := float64(f.PeakRSSIDbm) + peakBoost
						bump := baseFloor + (peakTop-baseFloor)*math.Exp(-(dist*dist)/(2*sigma*sigma))
						if bump > rssi {
							rssi = bump
						}
					}
				}

				rssis[sIdx] = float32(rssi)
			}

			slotsCopy := make([]uint8, len(slotIndices))
			copy(slotsCopy, slotIndices)
			out = append(out, tracestore.Sample{
				GateID:        gateID,
				SeqNum:        seqByGate[gateID],
				TimestampUs:   tsUs,
				NoiseFloorDbm: noiseFloor,
				SlotIndices:   slotsCopy,
				RSSIDbm:       rssis,
			})
		}
	}
	return out
}

func (e *Engine) hydrateShowcasePracticeTracesLocked(minActiveEndUs uint64) {
	if len(e.practiceState.Sessions) == 0 {
		return
	}
	hasDemo := false
	for i := range e.practiceState.Sessions {
		if isShowcaseDemoPracticeSession(e.practiceState.Sessions[i]) {
			hasDemo = true
			break
		}
	}
	if !hasDemo {
		return
	}
	ts := e.ensureTraceStoreLocked()
	for i := range e.practiceState.Sessions {
		sess := &e.practiceState.Sessions[i]
		if !isShowcaseDemoPracticeSession(*sess) {
			continue
		}
		existing, _ := ts.ReadSession(sess.SessionID)
		firstCrossUs := uint64(0)
		for _, c := range sess.Crossings {
			if c.TimestampUs > 0 && (firstCrossUs == 0 || c.TimestampUs < firstCrossUs) {
				firstCrossUs = c.TimestampUs
			}
		}
		if len(existing) > 0 && (firstCrossUs == 0 || existing[0].TimestampUs <= firstCrossUs) {
			if sess.TraceSampleCount < len(existing) {
				sess.TraceSampleCount = len(existing)
			}
			continue
		}

		demoSamples := buildDemoPracticeTraceSamples(*sess, minActiveEndUs)
		if len(demoSamples) == 0 {
			continue
		}
		_ = ts.DeleteSession(sess.SessionID)
		if len(existing) > 0 {
			cutoffUs := existing[0].TimestampUs
			for _, ds := range demoSamples {
				if ds.TimestampUs < cutoffUs {
					ts.Append(sess.SessionID, ds)
				}
			}
			for _, ex := range existing {
				ts.Append(sess.SessionID, ex)
			}
		} else {
			for _, ds := range demoSamples {
				ts.Append(sess.SessionID, ds)
			}
		}
		sum := ts.SealSession(sess.SessionID)
		sess.TraceSampleCount = sum.SampleCount
		sess.TraceDurationSec = sum.DurationSec
	}
}
