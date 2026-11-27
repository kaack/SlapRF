package race

import (
	"fmt"
	"sort"
	"strings"

	"slaprf/internal/domain"
)

// ResolveTournament synchronizes pilot callsigns/colors from `roster`, propagates confirmed heat
// results through all bracket edges (including automatic byes and Chase the Ace heat spawning),
// updates `CanUnlock`, `NextReadyHeatID`, `Champion`, and recomputes overall `Standings`.
func ResolveTournament(st *domain.RaceTournamentState, roster []domain.PilotSlot) {
	ResolveTournamentWithAttendance(st, roster, nil)
}

// ResolveTournamentWithAttendance resolves tournament progression while respecting Event pilot
// attendance (`away` / `left` pilots automatically receive `PilotHeatDNS` when fed into new heats)
// and manual seat overrides (`ManualLock`).
func ResolveTournamentWithAttendance(
	st *domain.RaceTournamentState,
	roster []domain.PilotSlot,
	attendance map[int]domain.PilotAttendance,
) {
	if st == nil || !st.Generated {
		return
	}

	rosterBySlot := make(map[int]domain.PilotSlot, len(roster))
	for _, p := range roster {
		rosterBySlot[p.SlotIndex] = p
	}

	frozenHistory := st.Lifecycle == domain.LifecycleCompleted || st.Lifecycle == domain.LifecycleScrapped

	// Refresh callsign, phoneticName, and color on filled seats for open/active races, and synthesize
	// an effective roster that includes any historical pilots no longer in the live directory.
	effectiveRoster := append([]domain.PilotSlot(nil), roster...)
	seenSlot := make(map[int]bool, len(roster))
	for _, p := range roster {
		seenSlot[p.SlotIndex] = true
	}
	for hi := range st.Heats {
		for si := range st.Heats[hi].Seats {
			s := &st.Heats[hi].Seats[si]
			if s.PilotSlotIndex <= 0 {
				continue
			}
			if !frozenHistory {
				if rp, ok := rosterBySlot[s.PilotSlotIndex]; ok {
					s.Callsign = rp.Callsign
					s.PhoneticName = rp.PhoneticName
					if rp.Color != "" {
						s.Color = rp.Color
					}
				}
			}
			if !seenSlot[s.PilotSlotIndex] {
				seenSlot[s.PilotSlotIndex] = true
				effectiveRoster = append(effectiveRoster, domain.PilotSlot{
					SlotIndex:    s.PilotSlotIndex,
					Callsign:     s.Callsign,
					PhoneticName: s.PhoneticName,
					Color:        s.Color,
				})
			}
		}
	}

	EnsureStagesMetadata(st)
	SyncRoundsMetadata(st)

	stageByIdx := make(map[int]*domain.RaceStage, len(st.Stages))
	for i := range st.Stages {
		stageByIdx[st.Stages[i].Index] = &st.Stages[i]
	}

	// Propagate feeder seats iteratively per stage in topological DAG order.
	heatByID := make(map[string]*domain.RaceHeat, len(st.Heats))
	hasOutgoingFeeder := make(map[string]bool, len(st.Heats))
	hasOutgoingCol := make(map[[2]int]bool)
	hasOutgoingRound := make(map[string]bool)
	heatsPerStage := make(map[int]int)
	confirmedPerStage := make(map[int]int)
	for i := range st.Heats {
		heatsPerStage[st.Heats[i].StageIndex]++
		if st.Heats[i].State == domain.HeatConfirmed {
			confirmedPerStage[st.Heats[i].StageIndex]++
		}
		heatByID[st.Heats[i].ID] = &st.Heats[i]
		for _, s := range st.Heats[i].Seats {
			if s.Feeder != nil {
				if s.Feeder.FromHeatID != "" {
					hasOutgoingFeeder[s.Feeder.FromHeatID] = true
				}
				if s.Feeder.FromRoundColumn > 0 {
					hasOutgoingCol[[2]int{st.Heats[i].StageIndex, s.Feeder.FromRoundColumn}] = true
				}
				if s.Feeder.FromRoundID != "" {
					hasOutgoingRound[s.Feeder.FromRoundID] = true
				}
			}
		}
	}

	topoOrder := TopologicalStageIndices(st)
	if len(topoOrder) == 0 {
		topoOrder = []int{1}
	}

	stageSeedsReady := make(map[int]bool, len(topoOrder))
	stageIncomingSeeds := make(map[int][]domain.TournamentStanding, len(topoOrder))
	stageCompleted := make(map[int]bool, len(topoOrder))

	// Build initial roster standings slice for root stages (so FromStageSeed on a Custom root stage resolves from checked-in pilots)
	rootSeedStandings := make([]domain.TournamentStanding, len(effectiveRoster))
	for i, p := range effectiveRoster {
		rootSeedStandings[i] = domain.TournamentStanding{
			Rank:           i + 1,
			PilotSlotIndex: p.SlotIndex,
			Callsign:       p.Callsign,
			PhoneticName:   p.PhoneticName,
			Color:          p.Color,
			Seed:           i + 1,
		}
	}

	for _, sIdx := range topoOrder {
		stg := stageByIdx[sIdx]
		var stgSettings domain.StageSettings
		if stg != nil {
			stgSettings = stg.Settings.Normalized(st.Config, stg.Format)
			stg.WaitingOnStageNames = nil
			if sIdx == 1 && st.Stage2SeededEarly {
				stg.CompletedEarly = true
			}
		} else {
			stgSettings = domain.DefaultStageSettingsFromConfig(st.Config, st.Config.MainFormat)
		}

		inStageConns := IncomingStageConnections(st, sIdx)
		anyStageRealStarted := AnyRealHeatStartedInStage(st, sIdx)

		if len(inStageConns) == 0 {
			ready := stg == nil || !stg.Dangling
			if stg != nil {
				stg.PrerequisitesMet = ready
			}
			stageSeedsReady[sIdx] = ready
			stageIncomingSeeds[sIdx] = rootSeedStandings
		} else {
			var waitingNames []string
			for _, sc := range inStageConns {
				upStg := stageByIdx[sc.FromStageIndex]
				upTitle := fmt.Sprintf("Stage %d", sc.FromStageIndex)
				if upStg != nil && upStg.Title != "" {
					upTitle = upStg.Title
				}
				upEarlyReady := upStg != nil && upStg.CompletedEarly && confirmedPerStage[sc.FromStageIndex] > 0
				if !stageCompleted[sc.FromStageIndex] && !upEarlyReady && !anyStageRealStarted {
					waitingNames = append(waitingNames, upTitle)
				}
			}
			prereqMet := len(waitingNames) == 0 && (stg == nil || !stg.Dangling)
			if stg != nil {
				stg.WaitingOnStageNames = waitingNames
				stg.PrerequisitesMet = prereqMet
			}
			stageSeedsReady[sIdx] = prereqMet

			var combined []domain.TournamentStanding
			seenPilot := make(map[int]bool)
			for _, sc := range inStageConns {
				upRankings := ComputeStageStandingsWithMetric(st, effectiveRoster, sc.FromStageIndex, sc.RankingMetric, stageIncomingSeeds[sc.FromStageIndex], stageCompleted[sc.FromStageIndex])
				sliced := sliceStandingsForStageConnection(upRankings, sc, st.Config.Stage2MaxSeeds, len(st.Stages) == 2 && sIdx == 2)
				for _, row := range sliced {
					if row.PilotSlotIndex <= 0 || seenPilot[row.PilotSlotIndex] {
						continue
					}
					seenPilot[row.PilotSlotIndex] = true
					cp := row
					cp.Seed = len(combined) + 1
					cp.Rank = len(combined) + 1
					combined = append(combined, cp)
				}
			}
			stageIncomingSeeds[sIdx] = combined
		}

		// Propagate feeders inside stage `sIdx`
		for pass := 0; pass < 8; pass++ {
			changed := false
			lastCh := LastChannelByPilotConfirmed(st.Heats)

			for hi := range st.Heats {
				h := &st.Heats[hi]
				if h.StageIndex != sIdx {
					continue
				}
				if h.State != domain.HeatWaiting && h.State != domain.HeatReady && h.State != domain.HeatStaged && h.State != domain.HeatConfirmed {
					continue
				}
				hasFeeders := false
				hasSeatedPilot := false
				for _, s := range h.Seats {
					if s.Feeder != nil {
						hasFeeders = true
					}
					if s.PilotSlotIndex > 0 && s.Status != domain.PilotHeatDNS && s.Status != domain.PilotHeatDQ {
						hasSeatedPilot = true
					}
				}
				if !hasFeeders {
					if h.State == domain.HeatWaiting && hasSeatedPilot && stageSeedsReady[sIdx] {
						h.State = domain.HeatReady
						changed = true
					} else if (h.State == domain.HeatReady || h.State == domain.HeatStaged) && !hasSeatedPilot {
						h.State = domain.HeatWaiting
						changed = true
					}
					continue
				}
				if (h.State == domain.HeatConfirmed && h.Note != "Auto-advance (bye)") ||
					h.State == domain.HeatFinished ||
					h.State == domain.HeatRunning ||
					h.State == domain.HeatPaused ||
					h.State == domain.HeatCountdown {
					continue
				}

				allFeedersConfirmed := true
				filledPilots := 0
				inSeeds := stageIncomingSeeds[sIdx]
				seedsReady := stageSeedsReady[sIdx]
				stageStarted := false
				nonQualStarted := false
				for i := range st.Heats {
					oh := &st.Heats[i]
					if oh.StageIndex != sIdx || oh.Note == "Auto-advance (bye)" {
						continue
					}
					if oh.State == domain.HeatCountdown || oh.State == domain.HeatRunning || oh.State == domain.HeatPaused || oh.State == domain.HeatFinished || oh.State == domain.HeatConfirmed || oh.State == domain.HeatAborted {
						stageStarted = true
						if oh.StageFormat != domain.FormatQualifying && oh.StageFormat != domain.FormatOpenQualifier {
							nonQualStarted = true
						}
					}
				}
				if !stageStarted && attendance != nil && len(inSeeds) > 0 {
					availSeeds := make([]domain.TournamentStanding, 0, len(inSeeds))
					for _, row := range inSeeds {
						if !attendance[row.PilotSlotIndex].IsAbsent() {
							availSeeds = append(availSeeds, row)
						}
					}
					inSeeds = availSeeds
				}

				for si := range h.Seats {
					s := &h.Seats[si]
					if s.ManualLock {
						if s.PilotSlotIndex > 0 && s.Status != domain.PilotHeatDNS && s.Status != domain.PilotHeatDQ {
							filledPilots++
						}
						continue
					}
					if s.Feeder == nil {
						if s.PilotSlotIndex > 0 && s.Status != domain.PilotHeatDNS && s.Status != domain.PilotHeatDQ {
							filledPilots++
						}
						continue
					}
					if s.Feeder.FromStageSeed > 0 {
						maxSeeds := len(inSeeds)
						if !seedsReady {
							allFeedersConfirmed = false
							s.Feeder.IsBye = false
							if s.PilotSlotIndex != 0 {
								clearFedSeat(s)
								changed = true
							}
							continue
						}
						if s.Feeder.FromStageSeed > maxSeeds {
							s.Feeder.IsBye = true
							if s.PilotSlotIndex != 0 {
								clearFedSeat(s)
								changed = true
							}
							continue
						}
						s.Feeder.IsBye = false
						picked := inSeeds[s.Feeder.FromStageSeed-1]
						isAbsent := attendance != nil && attendance[picked.PilotSlotIndex].IsAbsent()
						if s.PilotSlotIndex != picked.PilotSlotIndex || s.Seed != s.Feeder.FromStageSeed {
							s.PilotSlotIndex = picked.PilotSlotIndex
							s.Callsign = picked.Callsign
							s.PhoneticName = picked.PhoneticName
							s.Color = picked.Color
							s.Seed = s.Feeder.FromStageSeed
							if isAbsent {
								s.Status = domain.PilotHeatDNS
							} else {
								s.Status = domain.PilotHeatStaged
							}
							changed = true
						} else if isAbsent && s.Status == domain.PilotHeatStaged {
							s.Status = domain.PilotHeatDNS
							changed = true
						}
						if s.Status != domain.PilotHeatDNS && s.Status != domain.PilotHeatDQ {
							filledPilots++
						}
						continue
					}
					if s.Feeder.IsBye && s.Feeder.FromHeatID == "" && s.Feeder.FromRoundColumn == 0 && s.Feeder.FromRoundID == "" {
						if s.PilotSlotIndex != 0 {
							clearFedSeat(s)
							changed = true
						}
						continue
					}
					if s.Feeder.FromHeatID == "" && (s.Feeder.FromRoundID != "" || s.Feeder.FromRoundColumn > 0) && s.Feeder.FromStandingsRank > 0 {
						if !IsStandingsFeederReady(st, h.RoundID, h.StageIndex, h.ID, *s.Feeder) {
							allFeedersConfirmed = false
							s.Feeder.IsBye = false
							if s.PilotSlotIndex != 0 {
								clearFedSeat(s)
								changed = true
							}
							continue
						}
						ranked := ComputeStandingsForFeeder(st, effectiveRoster, h.StageIndex, *s.Feeder)
						if !nonQualStarted && attendance != nil && len(ranked) > 0 {
							availRanked := make([]domain.TournamentStanding, 0, len(ranked))
							for _, row := range ranked {
								if !attendance[row.PilotSlotIndex].IsAbsent() {
									availRanked = append(availRanked, row)
								}
							}
							ranked = availRanked
						}
						if s.Feeder.FromStandingsRank > len(ranked) {
							s.Feeder.IsBye = true
							if s.PilotSlotIndex != 0 {
								clearFedSeat(s)
								changed = true
							}
							continue
						}
						s.Feeder.IsBye = false
						picked := ranked[s.Feeder.FromStandingsRank-1]
						isAbsent := attendance != nil && attendance[picked.PilotSlotIndex].IsAbsent()
						if s.PilotSlotIndex != picked.PilotSlotIndex || s.Seed != picked.Rank {
							s.PilotSlotIndex = picked.PilotSlotIndex
							s.Callsign = picked.Callsign
							s.PhoneticName = picked.PhoneticName
							s.Color = picked.Color
							s.Seed = picked.Rank
							if isAbsent {
								s.Status = domain.PilotHeatDNS
							} else {
								s.Status = domain.PilotHeatStaged
							}
							changed = true
						} else if isAbsent && s.Status == domain.PilotHeatStaged {
							s.Status = domain.PilotHeatDNS
							changed = true
						}
						if s.Status != domain.PilotHeatDNS && s.Status != domain.PilotHeatDQ {
							filledPilots++
						}
						continue
					}
					src := heatByID[s.Feeder.FromHeatID]
					if src != nil {
						if src.State != domain.HeatWaiting {
							srcContenders := 0
							for _, us := range src.Seats {
								if us.PilotSlotIndex > 0 && us.Status != domain.PilotHeatDNS && us.Status != domain.PilotHeatDQ {
									srcContenders++
								}
							}
							newBye := s.Feeder.FromRank > srcContenders
							if s.Feeder.IsBye != newBye {
								s.Feeder.IsBye = newBye
								changed = true
							}
						} else {
							maxPossible := 0
							for _, us := range src.Seats {
								if (us.PilotSlotIndex > 0 && us.Status != domain.PilotHeatDNS && us.Status != domain.PilotHeatDQ) ||
									(us.PilotSlotIndex == 0 && us.Feeder != nil && !us.Feeder.IsBye) {
									maxPossible++
								}
							}
							newBye := maxPossible > 0 && s.Feeder.FromRank > maxPossible
							if s.Feeder.IsBye != newBye {
								s.Feeder.IsBye = newBye
								changed = true
							}
						}
					}
					if src == nil || src.State != domain.HeatConfirmed {
						allFeedersConfirmed = false
						if s.PilotSlotIndex != 0 {
							clearFedSeat(s)
							changed = true
						}
						continue
					}
					fed := findPilotAtRank(src, s.Feeder.FromRank)
					if fed == nil {
						if s.PilotSlotIndex != 0 {
							clearFedSeat(s)
							changed = true
						}
						continue
					}
					isAbsent := attendance != nil && attendance[fed.PilotSlotIndex].IsAbsent()
					if s.PilotSlotIndex != fed.PilotSlotIndex {
						s.PilotSlotIndex = fed.PilotSlotIndex
						s.Callsign = fed.Callsign
						s.PhoneticName = fed.PhoneticName
						s.Color = fed.Color
						s.Seed = fed.Seed
						if isAbsent {
							s.Status = domain.PilotHeatDNS
						} else {
							s.Status = domain.PilotHeatStaged
						}
						changed = true
					} else if isAbsent && s.Status == domain.PilotHeatStaged {
						s.Status = domain.PilotHeatDNS
						changed = true
					}
					if s.Status != domain.PilotHeatDNS && s.Status != domain.PilotHeatDQ {
						filledPilots++
					}
				}

				if allFeedersConfirmed {
					reassignFedHeatChannels(h, stgSettings.SeatChannels, lastCh)
					RecomputeHeat(h, stgSettings.QualifyingMetric)

					isIntermediate := h.BracketLane != "finals" && (hasOutgoingFeeder[h.ID] || hasOutgoingCol[[2]int{h.StageIndex, h.Column}] || hasOutgoingRound[h.RoundID])
					if isIntermediate && filledPilots == 0 {
						if h.State != domain.HeatConfirmed {
							for si := range h.Seats {
								if h.Seats[si].PilotSlotIndex > 0 && h.Seats[si].Status != domain.PilotHeatDNS && h.Seats[si].Status != domain.PilotHeatDQ {
									h.Seats[si].Status = domain.PilotHeatFinished
								}
							}
							h.State = domain.HeatConfirmed
							h.Note = "Auto-advance (bye)"
							RecomputeHeat(h, stgSettings.QualifyingMetric)
							changed = true
						}
					} else if h.State == domain.HeatWaiting || (h.State == domain.HeatConfirmed && h.Note == "Auto-advance (bye)") {
						if h.State == domain.HeatConfirmed && h.Note == "Auto-advance (bye)" {
							for si := range h.Seats {
								if h.Seats[si].PilotSlotIndex > 0 && h.Seats[si].Status == domain.PilotHeatFinished {
									h.Seats[si].Status = domain.PilotHeatStaged
								}
							}
						}
						h.State = domain.HeatReady
						h.Note = ""
						RecomputeHeat(h, stgSettings.QualifyingMetric)
						changed = true
					}
				} else if h.State != domain.HeatWaiting {
					h.State = domain.HeatWaiting
					h.Note = ""
					changed = true
				}
			}

			if !changed {
				break
			}
		}

		// Handle Chase the Ace progression inside stage `sIdx`
		ctaComplete, ctaChampSlot, ctaChampName := resolveChaseTheAceForStage(st, sIdx, attendance)
		// Rebuild heatByID in case CTA spawned/trimmed heats
		heatByID = make(map[string]*domain.RaceHeat, len(st.Heats))
		confirmedPerStage[sIdx] = 0
		for i := range st.Heats {
			heatByID[st.Heats[i].ID] = &st.Heats[i]
			if st.Heats[i].StageIndex == sIdx && st.Heats[i].State == domain.HeatConfirmed {
				confirmedPerStage[sIdx]++
			}
		}

		// Determine stage completion & champion for stage `sIdx`
		stgDone, stgChampSlot, stgChampName := resolveStageCompletionAndChampion(st, sIdx, ctaComplete, ctaChampSlot, ctaChampName)
		stageCompleted[sIdx] = stgDone
		if stg != nil {
			stg.ChampionSlotIndex = stgChampSlot
			stg.ChampionCallsign = stgChampName
			stg.Standings = ComputeStageStandingsWithMetric(st, effectiveRoster, sIdx, "", stageIncomingSeeds[sIdx], stgDone)
			isTerminalOrElim := stg.Format != domain.FormatQualifying || len(OutgoingStageConnections(st, sIdx)) == 0
			if stgDone && isTerminalOrElim && stg.ChampionSlotIndex == 0 && len(stg.Standings) > 0 && stg.Standings[0].HeatsFlown > 0 {
				stg.ChampionSlotIndex = stg.Standings[0].PilotSlotIndex
				stg.ChampionCallsign = stg.Standings[0].Callsign
				stg.Standings[0].BracketStatus = "Champion"
			}
		}
	}

	// Update ActiveStageIndex and per-stage Status (at most 1 stage is StageStatusActive!)
	if len(st.Stages) > 0 {
		if st.ActiveStageIndex < 1 || st.ActiveStageIndex > len(st.Stages) {
			st.ActiveStageIndex = 1
		}
		curActive := stageByIdx[st.ActiveStageIndex]
		// Auto-advance ActiveStageIndex when the current stage finishes (or is pending while another stage is ready),
		// UNLESS the organizer explicitly paused the current stage (`PausedByUser`).
		if curActive != nil && !curActive.PausedByUser && (stageCompleted[curActive.Index] || !curActive.PrerequisitesMet) {
			for _, idx := range topoOrder {
				cand := stageByIdx[idx]
				if cand != nil && cand.PrerequisitesMet && !stageCompleted[idx] && !cand.PausedByUser && (heatsPerStage[idx] > 0 || cand.Format == domain.FormatOpenQualifier) {
					st.ActiveStageIndex = idx
					break
				}
			}
		}

		for i := range st.Stages {
			s := &st.Stages[i]
			if stageCompleted[s.Index] {
				s.Status = domain.StageStatusCompleted
				s.PausedByUser = false
			} else if !s.PrerequisitesMet {
				s.Status = domain.StageStatusPending
			} else if s.PausedByUser {
				s.Status = domain.StageStatusPaused
			} else if s.Index == st.ActiveStageIndex {
				s.Status = domain.StageStatusActive
			} else {
				s.Status = domain.StageStatusReady
			}
		}

		// Sync qualifying status & standings across both legacy 2-stage and unified single-graph tournaments
		if len(st.Stages) >= 2 {
			st.QualStandings = append([]domain.TournamentStanding(nil), st.Stages[0].Standings...)
			st.QualifyingComplete = stageCompleted[1]
			st.CanStartStage2 = confirmedPerStage[1] > 0 && !stageSeedsReady[2] && heatsPerStage[2] > 0
		} else {
			syncUnifiedQualifyingStatus(st, effectiveRoster)
		}

		// Overall race completion: all terminal stages completed and no non-terminal stage pending/running
		allStagesFinished := st.FormatInvalidReason == ""
		var primaryTerminal *domain.RaceStage
		for i := range st.Stages {
			s := &st.Stages[i]
			outs := OutgoingStageConnections(st, s.Index)
			if len(outs) == 0 && primaryTerminal == nil {
				primaryTerminal = s
			}
			if stageCompleted[s.Index] {
				continue
			}
			if s.CompletedEarly && confirmedPerStage[s.Index] > 0 && len(outs) > 0 {
				s.Status = domain.StageStatusCompleted
				continue
			}
			allStagesFinished = false
		}
		st.IsComplete = allStagesFinished
		if st.IsComplete {
			champStage := stageByIdx[st.ActiveStageIndex]
			if champStage == nil || (champStage.ChampionSlotIndex == 0 && primaryTerminal != nil) {
				champStage = primaryTerminal
			}
			if champStage != nil {
				st.ChampionSlotIndex = champStage.ChampionSlotIndex
				st.ChampionCallsign = champStage.ChampionCallsign
			}
		} else {
			st.ChampionSlotIndex = 0
			st.ChampionCallsign = ""
		}
	}

	// Recompute PrevChannel / ChannelChanged badges across all heats so manual lineup/channel edits stay accurate
	refreshChannelChangeAlerts(st.Heats)

	// Compute `CanUnlock` on every confirmed heat
	updateUnlockFlags(st)

	// Find next ready heat in the ActiveStageIndex (unless ActiveStage is paused by user!)
	st.NextReadyHeatID = ""
	activeStg := stageByIdx[st.ActiveStageIndex]
	if activeStg == nil || (activeStg.PrerequisitesMet && !activeStg.PausedByUser) {
		for _, h := range st.Heats {
			if h.StageIndex == st.ActiveStageIndex &&
				(h.State == domain.HeatReady || h.State == domain.HeatStaged) &&
				!IsRoundSkippedByEarlySeed(st, h.RoundID) {
				st.NextReadyHeatID = h.ID
				break
			}
		}
	}
	if st.NextReadyHeatID != "" {
		curHeat := heatByID[st.ActiveHeatID]
		if curHeat == nil {
			st.ActiveHeatID = st.NextReadyHeatID
		} else if curHeat.State == domain.HeatWaiting {
			if curStg := stageByIdx[curHeat.StageIndex]; curStg != nil && !curStg.PrerequisitesMet {
				st.ActiveHeatID = st.NextReadyHeatID
			} else if len(st.Stages) <= 1 {
				st.ActiveHeatID = st.NextReadyHeatID
			}
		} else if (curHeat.State == domain.HeatReady || curHeat.State == domain.HeatStaged) && IsRoundSkippedByEarlySeed(st, curHeat.RoundID) {
			st.ActiveHeatID = st.NextReadyHeatID
		}
	}

	// Recompute active stage standings as primary `st.Standings`
	if activeStg != nil && len(activeStg.Standings) > 0 {
		st.Standings = append([]domain.TournamentStanding(nil), activeStg.Standings...)
	} else {
		st.Standings = ComputeStandings(st, effectiveRoster)
	}

	// Overlay race-level Roster attendance status (`DQ` / `DNC` / `Away`) on Standings
	attMap := make(map[int]domain.PilotAttendance, len(st.Roster))
	for _, ep := range st.Roster {
		attMap[ep.SlotIndex] = domain.NormalizeAttendance(ep.Attendance)
	}
	for k, v := range attendance {
		attMap[k] = domain.NormalizeAttendance(v)
	}
	applyAttendanceToStandings := func(rows []domain.TournamentStanding) {
		if len(rows) == 0 || len(attMap) == 0 {
			return
		}
		hasDQ := false
		for i := range rows {
			att := attMap[rows[i].PilotSlotIndex]
			switch att {
			case domain.AttendanceDQ:
				rows[i].BracketStatus = "DQ"
				hasDQ = true
			case domain.AttendanceDNC:
				if rows[i].BracketStatus != "Champion" {
					rows[i].BracketStatus = "DNC"
				}
			}
		}
		if hasDQ {
			sort.SliceStable(rows, func(i, j int) bool {
				iDQ := attMap[rows[i].PilotSlotIndex] == domain.AttendanceDQ
				jDQ := attMap[rows[j].PilotSlotIndex] == domain.AttendanceDQ
				if iDQ != jDQ {
					return !iDQ
				}
				return false
			})
			for i := range rows {
				rows[i].Rank = i + 1
			}
		}
	}
	for i := range st.Stages {
		applyAttendanceToStandings(st.Stages[i].Standings)
	}
	applyAttendanceToStandings(st.Standings)
	if st.ChampionSlotIndex > 0 && attMap[st.ChampionSlotIndex] == domain.AttendanceDQ {
		st.ChampionSlotIndex = 0
		st.ChampionCallsign = ""
	}
	if st.IsComplete && st.ChampionSlotIndex == 0 && len(st.Standings) > 0 && st.Standings[0].HeatsFlown > 0 && attMap[st.Standings[0].PilotSlotIndex] != domain.AttendanceDQ {
		st.ChampionSlotIndex = st.Standings[0].PilotSlotIndex
		st.ChampionCallsign = st.Standings[0].Callsign
		st.Standings[0].BracketStatus = "Champion"
	}

	// Keep Rounds metadata aligned with heats
	SyncRoundsMetadata(st)

	// Sync Lifecycle automatically between draft / active / completed (never clobbering paused or scrapped)
	syncTournamentLifecycle(st)
}

func syncTournamentLifecycle(st *domain.RaceTournamentState) {
	if st.Lifecycle == domain.LifecyclePaused || st.Lifecycle == domain.LifecycleScrapped {
		return
	}
	if st.IsComplete {
		st.Lifecycle = domain.LifecycleCompleted
		return
	}
	anyRealStarted := false
	for _, h := range st.Heats {
		if h.State == domain.HeatCountdown || h.State == domain.HeatRunning ||
			h.State == domain.HeatPaused || h.State == domain.HeatFinished ||
			(h.State == domain.HeatConfirmed && h.Note != "Auto-advance (bye)") {
			anyRealStarted = true
			break
		}
	}
	if anyRealStarted {
		st.Lifecycle = domain.LifecycleActive
	} else if st.Lifecycle == "" || st.Lifecycle == domain.LifecycleCompleted {
		st.Lifecycle = domain.LifecycleDraft
	}
}

func refreshChannelChangeAlerts(heats []domain.RaceHeat) {
	prevByPilot := make(map[int]uint8)
	for hi := range heats {
		h := &heats[hi]
		if h.Note == "Auto-advance (bye)" {
			continue
		}
		for si := range h.Seats {
			s := &h.Seats[si]
			curCode := domain.EncodeBandChannel(s.Band, s.Channel)
			if s.PilotSlotIndex <= 0 || curCode == 0 {
				s.PrevChannel = 0
				s.ChannelChanged = false
				continue
			}
			prev := prevByPilot[s.PilotSlotIndex]
			if h.State == domain.HeatWaiting || h.State == domain.HeatReady || h.State == domain.HeatStaged {
				s.PrevChannel = prev
				s.ChannelChanged = prev > 0 && prev != curCode
			}
			prevByPilot[s.PilotSlotIndex] = curCode
		}
	}
}

func clearFedSeat(s *domain.HeatSeat) {
	s.PilotSlotIndex = 0
	s.Callsign = ""
	s.PhoneticName = ""
	s.Color = ""
	s.Seed = 0
	s.ChannelChanged = false
	s.PrevChannel = 0
	s.Status = domain.PilotHeatStaged
	s.PreOverrideStatus = ""
	s.StatusOverridden = false
	s.RosterDQ = false
	s.Crossings = nil
	s.RssiTrace = nil
	s.Laps = nil
	s.ManualPosition = 0
	s.PenaltySec = 0
}

func findPilotAtRank(heat *domain.RaceHeat, rank int) *domain.HeatSeat {
	for i := range heat.Seats {
		s := &heat.Seats[i]
		if s.PilotSlotIndex > 0 && s.Position == rank && s.Status != domain.PilotHeatDQ && s.Status != domain.PilotHeatDNS {
			return s
		}
	}
	return nil
}

func reassignFedHeatChannels(h *domain.RaceHeat, seatChannels []uint8, lastCh map[int]uint8) {
	var filledIdx []int
	for i := range h.Seats {
		if h.Seats[i].PilotSlotIndex > 0 {
			filledIdx = append(filledIdx, i)
		}
	}
	avail := make([]uint8, 0, len(seatChannels))
	avail = append(avail, seatChannels...)
	used := make(map[uint8]bool)
	usedFreq := make(map[uint16]bool)
	markUsed := func(code uint8) {
		used[code] = true
		if _, _, fr, ok := domain.DecodeBandChannel(code); ok && fr > 0 {
			usedFreq[fr] = true
		}
	}
	canUse := func(code uint8) bool {
		if code == 0 || used[code] {
			return false
		}
		_, _, fr, ok := domain.DecodeBandChannel(code)
		return ok && fr > 0 && !usedFreq[fr]
	}

	assigned := make(map[int]uint8)
	// Preserve any manually locked seat's explicit channel first
	for _, si := range filledIdx {
		curCode := domain.EncodeBandChannel(h.Seats[si].Band, h.Seats[si].Channel)
		if h.Seats[si].ManualLock && canUse(curCode) {
			assigned[si] = curCode
			markUsed(curCode)
		}
	}
	for _, si := range filledIdx {
		if assigned[si] != 0 {
			continue
		}
		prev := lastCh[h.Seats[si].PilotSlotIndex]
		if prev > 0 && canUse(prev) && containsUint8(avail, prev) {
			assigned[si] = prev
			markUsed(prev)
		}
	}
	for _, si := range filledIdx {
		if assigned[si] != 0 {
			continue
		}
		for _, code := range avail {
			if canUse(code) {
				assigned[si] = code
				markUsed(code)
				break
			}
		}
		if assigned[si] == 0 {
			for ch := uint8(1); ch <= 8; ch++ {
				if canUse(ch) {
					assigned[si] = ch
					markUsed(ch)
					break
				}
			}
		}
	}
	// Ensure empty seats in `h` also hold non-colliding spare channels from `avail`
	for i := range h.Seats {
		if h.Seats[i].PilotSlotIndex > 0 {
			code := assigned[i]
			prev := lastCh[h.Seats[i].PilotSlotIndex]
			band, ch, freq, ok := domain.DecodeBandChannel(code)
			if !ok {
				band, ch, freq = domain.BandRaceband, 0, 0
			}
			h.Seats[i].Band = band
			h.Seats[i].Channel = ch
			h.Seats[i].FrequencyMHz = freq
			h.Seats[i].PrevChannel = prev
			h.Seats[i].ChannelChanged = prev > 0 && code > 0 && prev != code
		} else {
			curCode := domain.EncodeBandChannel(h.Seats[i].Band, h.Seats[i].Channel)
			if curCode == 0 || !canUse(curCode) {
				for _, code := range avail {
					if canUse(code) {
						if band, ch, freq, ok := domain.DecodeBandChannel(code); ok {
							h.Seats[i].Band = band
							h.Seats[i].Channel = ch
							h.Seats[i].FrequencyMHz = freq
							markUsed(code)
							break
						}
					}
				}
			} else {
				markUsed(curCode)
			}
		}
	}
}

func isCTAHeatID(id string) bool {
	return strings.HasPrefix(id, "CTA-") || strings.Contains(id, "-CTA-")
}

func isGrandFinalHeatID(id string) bool {
	return id == "GF-1" || strings.HasSuffix(id, "-GF-1")
}

func ctaPrefixForHeat(id string, stageIdx int) string {
	if idx := strings.Index(id, "-CTA-"); idx > 0 {
		return id[:idx] + "-CTA"
	}
	if strings.HasPrefix(id, "CTA-") {
		return "CTA"
	}
	if stageIdx >= 3 {
		return fmt.Sprintf("S%d-CTA", stageIdx)
	}
	return "CTA"
}

func findStagePtr(st *domain.RaceTournamentState, stageIdx int) *domain.RaceStage {
	if st == nil {
		return nil
	}
	for i := range st.Stages {
		if st.Stages[i].Index == stageIdx {
			return &st.Stages[i]
		}
	}
	return nil
}

func stageFinalsRounds(st *domain.RaceTournamentState, stageIdx int) []*domain.RaceRound {
	var out []*domain.RaceRound
	for i := range st.Rounds {
		if st.Rounds[i].StageIndex == stageIdx && st.Rounds[i].BracketLane == "finals" {
			out = append(out, &st.Rounds[i])
		}
	}
	if len(out) > 1 {
		primaryScore := func(r *domain.RaceRound) int {
			tl := strings.ToLower(strings.TrimSpace(r.Title))
			if strings.Contains(tl, "a-main") || strings.Contains(tl, "a main") || tl == "grand final" || tl == "finals" {
				return 0
			}
			if strings.Contains(tl, "b-main") || strings.Contains(tl, "b main") {
				return 2
			}
			return 1
		}
		sort.SliceStable(out, func(i, j int) bool {
			pi, pj := primaryScore(out[i]), primaryScore(out[j])
			if pi != pj {
				return pi < pj
			}
			if out[i].HasPos && out[j].HasPos && out[i].PosY != out[j].PosY {
				return out[i].PosY < out[j].PosY
			}
			if out[i].Column != out[j].Column {
				return out[i].Column > out[j].Column
			}
			return out[i].Round < out[j].Round
		})
	}
	return out
}

func stageFinalsRound(st *domain.RaceTournamentState, stageIdx int) *domain.RaceRound {
	list := stageFinalsRounds(st, stageIdx)
	if len(list) == 0 {
		return nil
	}
	return list[0]
}

func resolveSingleCTAFinals(
	st *domain.RaceTournamentState,
	stageIdx int,
	finalsRnd *domain.RaceRound,
	attendance map[int]domain.PilotAttendance,
) (bool, int, string) {
	stg := findStagePtr(st, stageIdx)
	isCTAStage := finalsRnd == nil && stg != nil && stg.Format == domain.FormatChaseTheAce

	isMatch := func(h domain.RaceHeat) bool {
		if h.StageIndex != stageIdx {
			return false
		}
		if finalsRnd != nil {
			return h.RoundID == finalsRnd.ID
		}
		if isCTAHeatID(h.ID) {
			return true
		}
		return isCTAStage && h.BracketLane == "finals"
	}

	var ctaIndices []int
	for i := range st.Heats {
		if isMatch(st.Heats[i]) {
			ctaIndices = append(ctaIndices, i)
		}
	}
	if len(ctaIndices) == 0 {
		return false, 0, ""
	}

	firstCTA := &st.Heats[ctaIndices[0]]
	if firstCTA.State == domain.HeatWaiting {
		// Trim any extra CTA heats if CTA-1 reverted to waiting
		if len(ctaIndices) > 1 {
			keep := make([]domain.RaceHeat, 0, len(st.Heats))
			for i, h := range st.Heats {
				if i > ctaIndices[0] && isMatch(h) {
					continue
				}
				keep = append(keep, h)
			}
			st.Heats = keep
		}
		return false, 0, ""
	}

	heatByID := make(map[string]*domain.RaceHeat, len(st.Heats))
	for i := range st.Heats {
		heatByID[st.Heats[i].ID] = &st.Heats[i]
	}

	winAdv := st.Config.WinnersAdvantageAce
	reqWins := st.Config.AceWinsRequired
	qualMetric := st.Config.QualifyingMetric
	if stg != nil {
		norm := stg.Settings.Normalized(st.Config, stg.Format)
		winAdv = norm.WinnersAdvantageAce
		reqWins = norm.AceWinsRequired
		qualMetric = norm.QualifyingMetric
	}
	if finalsRnd != nil {
		if finalsRnd.AceWinsRequired >= 2 {
			reqWins = finalsRnd.AceWinsRequired
		}
		if finalsRnd.FinalsFormat == domain.FinalsChaseTheAce {
			winAdv = finalsRnd.WinnersAdvantageAce || winAdv
		}
	}
	if reqWins < 2 {
		reqWins = 2
	}

	// Track cumulative Ace wins across CTA heats (including optional 1-Ace Winners Final advantage)
	aceWins := make(map[int]int)
	if winAdv {
		for _, s := range firstCTA.Seats {
			if s.PilotSlotIndex <= 0 || s.Feeder == nil || s.Feeder.FromRank != 1 {
				continue
			}
			srcHeat := heatByID[s.Feeder.FromHeatID]
			fromWinners := strings.HasPrefix(s.Feeder.FromHeatID, "W") || strings.Contains(s.Feeder.FromHeatID, "-W") || (srcHeat != nil && srcHeat.BracketLane == "winners")
			if fromWinners {
				aceWins[s.PilotSlotIndex] = 1
			}
		}
	}

	championSlot := 0
	championName := ""
	decidedAtIdx := -1

	for _, hi := range ctaIndices {
		h := &st.Heats[hi]
		for si := range h.Seats {
			pSlot := h.Seats[si].PilotSlotIndex
			if pSlot <= 0 {
				continue
			}
			before := aceWins[pSlot]
			h.Seats[si].AceWinsBefore = before
			after := before
			if h.State == domain.HeatConfirmed && h.Seats[si].Position == 1 &&
				h.Seats[si].Status != domain.PilotHeatDQ && h.Seats[si].Status != domain.PilotHeatDNS {
				after = before + 1
			}
			h.Seats[si].AceWinsAfter = after
		}
		if h.State == domain.HeatConfirmed {
			for _, s := range h.Seats {
				if s.PilotSlotIndex > 0 && s.Position == 1 && s.Status != domain.PilotHeatDQ && s.Status != domain.PilotHeatDNS {
					aceWins[s.PilotSlotIndex]++
					if aceWins[s.PilotSlotIndex] >= reqWins && championSlot == 0 {
						championSlot = s.PilotSlotIndex
						championName = s.Callsign
						decidedAtIdx = hi
					}
				}
			}
		}
	}

	if championSlot > 0 {
		// Remove any unflown CTA heats after `decidedAtIdx`
		keep := make([]domain.RaceHeat, 0, len(st.Heats))
		for i, h := range st.Heats {
			if i > decidedAtIdx && isMatch(h) && (h.State == domain.HeatWaiting || h.State == domain.HeatReady || h.State == domain.HeatStaged) {
				continue
			}
			keep = append(keep, h)
		}
		st.Heats = keep
		return true, championSlot, championName
	}

	// If every existing CTA heat is confirmed and nobody has `reqWins` yet (and <= 12 CTA heats safety cap),
	// spawn the next CTA heat automatically inside the same Finals round with identical pilot seats & channels!
	allCTAConfirmed := true
	for _, hi := range ctaIndices {
		if st.Heats[hi].State != domain.HeatConfirmed {
			allCTAConfirmed = false
			break
		}
	}
	lastCTA := st.Heats[ctaIndices[len(ctaIndices)-1]]
	if allCTAConfirmed && lastCTA.State == domain.HeatConfirmed && len(ctaIndices) < 12 {
		var activeContenders []domain.HeatSeat
		for _, s := range lastCTA.Seats {
			isAbsent := attendance != nil && attendance[s.PilotSlotIndex].IsAbsent()
			if s.PilotSlotIndex > 0 && s.Status != domain.PilotHeatDQ && s.Status != domain.PilotHeatDNS && !isAbsent {
				activeContenders = append(activeContenders, s)
			}
		}
		if len(activeContenders) == 1 {
			return true, activeContenders[0].PilotSlotIndex, activeContenders[0].Callsign
		}
		if len(activeContenders) >= 2 {
			nextNum := len(ctaIndices) + 1
			nextSeats := make([]domain.HeatSeat, len(lastCTA.Seats))
			for i, s := range lastCTA.Seats {
				stStatus := domain.PilotHeatStaged
				if s.PilotSlotIndex > 0 {
					isAbsent := attendance != nil && attendance[s.PilotSlotIndex].IsAbsent()
					if isAbsent || s.Status == domain.PilotHeatDNS {
						stStatus = domain.PilotHeatDNS
					}
				}
				srcLbl := s.SourceLabel
				if s.PilotSlotIndex > 0 {
					srcLbl = fmt.Sprintf("Aces: %d/%d", aceWins[s.PilotSlotIndex], reqWins)
				}
				nextSeats[i] = domain.HeatSeat{
					SeatIndex:      s.SeatIndex,
					PilotSlotIndex: s.PilotSlotIndex,
					Callsign:       s.Callsign,
					PhoneticName:   s.PhoneticName,
					Color:          s.Color,
					Seed:           s.Seed,
					SourceLabel:    srcLbl,
					Band:           s.Band,
					Channel:        s.Channel,
					FrequencyMHz:   s.FrequencyMHz,
					Status:         stStatus,
					AceWinsBefore:  aceWins[s.PilotSlotIndex],
					AceWinsAfter:   aceWins[s.PilotSlotIndex],
					Laps:           []domain.HeatLap{},
				}
			}
			prefix := ctaPrefixForHeat(firstCTA.ID, stageIdx)
			nextID := fmt.Sprintf("%s-%d", prefix, nextNum)
			usedIDs := make(map[string]bool, len(st.Heats))
			for _, eh := range st.Heats {
				usedIDs[eh.ID] = true
			}
			for usedIDs[nextID] {
				nextNum++
				nextID = fmt.Sprintf("%s-%d", prefix, nextNum)
			}
			nextHeat := domain.RaceHeat{
				ID:              nextID,
				RoundID:         firstCTA.RoundID,
				StageIndex:      firstCTA.StageIndex,
				StageName:       firstCTA.StageName,
				StageFormat:     firstCTA.StageFormat,
				Round:           firstCTA.Round,
				Column:          firstCTA.Column,
				Order:           len(st.Heats) + 1,
				BracketLane:     "finals",
				Title:           fmt.Sprintf("Chase the Ace · Game %d (First to %d Wins)", nextNum, reqWins),
				ShortLabel:      FormatHeatShortLabel(nextID),
				StartMode:       domain.StartModeHeadsUp,
				TargetLaps:      firstCTA.TargetLaps,
				TimeLimitSec:    firstCTA.TimeLimitSec,
				ExpectedWinners: 1,
				State:           domain.HeatReady,
				Seats:           nextSeats,
			}
			RecomputeHeat(&nextHeat, qualMetric)
			st.Heats = append(st.Heats, nextHeat)
		}
	}
	return false, 0, ""
}

func resolveChaseTheAceForStage(
	st *domain.RaceTournamentState,
	stageIdx int,
	attendance map[int]domain.PilotAttendance,
) (bool, int, string) {
	finalsList := stageFinalsRounds(st, stageIdx)
	var ctaRounds []*domain.RaceRound
	for _, fr := range finalsList {
		if fr.FinalsFormat == domain.FinalsChaseTheAce || fr.StageFormat == domain.FormatChaseTheAce {
			ctaRounds = append(ctaRounds, fr)
		}
	}
	if len(ctaRounds) == 0 {
		return resolveSingleCTAFinals(st, stageIdx, nil, attendance)
	}
	allDone := true
	primaryChampSlot := 0
	primaryChampName := ""
	for idx, fr := range ctaRounds {
		done, cSlot, cName := resolveSingleCTAFinals(st, stageIdx, fr, attendance)
		if !done {
			allDone = false
		}
		if idx == 0 && done {
			primaryChampSlot = cSlot
			primaryChampName = cName
		}
	}
	return allDone && len(finalsList) == len(ctaRounds), primaryChampSlot, primaryChampName
}

func resolveSingleFinalsRoundWinner(finalsRnd *domain.RaceRound, finalsHeats []*domain.RaceHeat) (bool, int, string) {
	if len(finalsHeats) == 0 {
		return false, 0, ""
	}
	for _, fh := range finalsHeats {
		if fh.State != domain.HeatConfirmed {
			return false, 0, ""
		}
	}
	if len(finalsHeats) == 1 && (finalsRnd == nil || finalsRnd.FinalsFormat != domain.FinalsPoints) {
		winner := findPilotAtRank(finalsHeats[0], 1)
		if winner != nil {
			return true, winner.PilotSlotIndex, winner.Callsign
		}
		return true, 0, ""
	}

	type finalsScore struct {
		slot       int
		callsign   string
		points     int
		wins       int
		laps       int
		bestLapSec float64
		lastPos    int
	}
	scores := make(map[int]*finalsScore)
	for _, fh := range finalsHeats {
		for _, s := range fh.Seats {
			if s.PilotSlotIndex <= 0 || s.Status == domain.PilotHeatDNS || s.Status == domain.PilotHeatDQ {
				continue
			}
			sc := scores[s.PilotSlotIndex]
			if sc == nil {
				sc = &finalsScore{slot: s.PilotSlotIndex, callsign: s.Callsign, lastPos: 99}
				scores[s.PilotSlotIndex] = sc
			}
			sc.points += s.Points
			sc.laps += s.LapsCompleted
			if s.Position == 1 {
				sc.wins++
			}
			if s.Position > 0 {
				sc.lastPos = s.Position
			}
			if s.BestLapSec > 0 && (sc.bestLapSec == 0 || s.BestLapSec < sc.bestLapSec) {
				sc.bestLapSec = s.BestLapSec
			}
		}
	}
	var best *finalsScore
	for _, sc := range scores {
		if best == nil {
			best = sc
			continue
		}
		if sc.points != best.points {
			if sc.points > best.points {
				best = sc
			}
			continue
		}
		if sc.wins != best.wins {
			if sc.wins > best.wins {
				best = sc
			}
			continue
		}
		if sc.laps != best.laps {
			if sc.laps > best.laps {
				best = sc
			}
			continue
		}
		if sc.bestLapSec > 0 && best.bestLapSec > 0 && sc.bestLapSec != best.bestLapSec {
			if sc.bestLapSec < best.bestLapSec {
				best = sc
			}
			continue
		}
		if sc.lastPos < best.lastPos {
			best = sc
		}
	}
	if best != nil {
		return true, best.slot, best.callsign
	}
	return true, 0, ""
}

func resolveStageCompletionAndChampion(
	st *domain.RaceTournamentState,
	stageIdx int,
	ctaComplete bool,
	ctaChampSlot int,
	ctaChampName string,
) (bool, int, string) {
	stg := findStagePtr(st, stageIdx)
	if stg != nil && !stg.PrerequisitesMet {
		return false, 0, ""
	}

	if stg != nil && stg.CompletedEarly && len(OutgoingStageConnections(st, stageIdx)) > 0 {
		for _, h := range st.Heats {
			if h.StageIndex == stageIdx && h.State == domain.HeatConfirmed {
				return true, 0, ""
			}
		}
	}

	// Check if stage is purely an Open Qualifier (no downstream non-open-qual rounds)
	hasNonOQRound := false
	hasUnclosedOQRound := false
	for _, r := range st.Rounds {
		if r.StageIndex != stageIdx || domain.IsStagePortalRoundID(r.ID) {
			continue
		}
		isOQ := r.StageFormat == domain.FormatOpenQualifier || domain.IsOpenQualRoundID(r.ID)
		if !isOQ {
			hasNonOQRound = true
		} else if !IsRoundSkippedByEarlySeed(st, r.ID) && (stg == nil || !stg.CompletedEarly) && st.Lifecycle != domain.LifecycleCompleted {
			hasUnclosedOQRound = true
		}
	}
	if !hasNonOQRound && ((stg != nil && stg.Format == domain.FormatOpenQualifier) || (stg == nil && st.Config.MainFormat == domain.FormatOpenQualifier)) {
		if (stg != nil && stg.CompletedEarly) || st.Lifecycle == domain.LifecycleCompleted {
			return true, 0, ""
		}
		return false, 0, ""
	}
	if hasUnclosedOQRound {
		return false, 0, ""
	}

	if stg != nil && stg.Format == domain.FormatQualifying && !hasNonOQRound {
		// Pure qualifying stage
		feedHeats := stageFeedingHeats(st, stageIdx)
		if len(feedHeats) == 0 {
			return false, 0, ""
		}
		for _, fh := range feedHeats {
			if fh.State != domain.HeatConfirmed && !IsRoundSkippedByEarlySeed(st, fh.RoundID) {
				return false, 0, ""
			}
		}
		return true, 0, ""
	}

	// Ensure all non-skipped heats in `stageIdx` are confirmed before declaring completion
	hasAnyConfirmedOrActiveHeat := false
	for _, h := range st.Heats {
		if h.StageIndex != stageIdx {
			continue
		}
		if IsRoundSkippedByEarlySeed(st, h.RoundID) && (h.State == domain.HeatWaiting || h.State == domain.HeatReady || h.State == domain.HeatStaged) {
			continue
		}
		hasAnyConfirmedOrActiveHeat = true
		if h.State != domain.HeatConfirmed {
			return false, 0, ""
		}
	}

	if ctaComplete {
		return true, ctaChampSlot, ctaChampName
	}

	finalsList := stageFinalsRounds(st, stageIdx)
	if len(finalsList) > 0 {
		primaryChampSlot := 0
		primaryChampName := ""
		for idx, fr := range finalsList {
			isCTA := fr.FinalsFormat == domain.FinalsChaseTheAce || fr.StageFormat == domain.FormatChaseTheAce
			if isCTA {
				// Validate CTA winner was decided for this Finals round
				var ctaHeats []*domain.RaceHeat
				for i := range st.Heats {
					if st.Heats[i].StageIndex == stageIdx && st.Heats[i].RoundID == fr.ID {
						ctaHeats = append(ctaHeats, &st.Heats[i])
					}
				}
				if len(ctaHeats) == 0 {
					return false, 0, ""
				}
				reqWins := fr.AceWinsRequired
				if reqWins < 2 {
					reqWins = st.Config.AceWinsRequired
				}
				if reqWins < 2 {
					reqWins = 2
				}
				lastH := ctaHeats[len(ctaHeats)-1]
				decidedSlot := 0
				decidedName := ""
				activeCnt := 0
				var loneContender domain.HeatSeat
				for _, s := range lastH.Seats {
					if s.PilotSlotIndex > 0 && s.Status != domain.PilotHeatDQ && s.Status != domain.PilotHeatDNS {
						activeCnt++
						loneContender = s
						if s.AceWinsAfter >= reqWins && decidedSlot == 0 {
							decidedSlot = s.PilotSlotIndex
							decidedName = s.Callsign
						}
					}
				}
				if decidedSlot == 0 && activeCnt == 1 {
					decidedSlot = loneContender.PilotSlotIndex
					decidedName = loneContender.Callsign
				}
				if decidedSlot == 0 && len(ctaHeats) < 12 {
					return false, 0, ""
				}
				if idx == 0 {
					primaryChampSlot = decidedSlot
					primaryChampName = decidedName
				}
				continue
			}

			var rHeats []*domain.RaceHeat
			for i := range st.Heats {
				if st.Heats[i].StageIndex == stageIdx && st.Heats[i].RoundID == fr.ID {
					rHeats = append(rHeats, &st.Heats[i])
				}
			}
			done, cSlot, cName := resolveSingleFinalsRoundWinner(fr, rHeats)
			if !done {
				return false, 0, ""
			}
			if idx == 0 {
				primaryChampSlot = cSlot
				primaryChampName = cName
			}
		}
		return true, primaryChampSlot, primaryChampName
	}

	if stg != nil && stg.Format == domain.FormatChaseTheAce {
		return false, 0, ""
	}
	for _, h := range st.Heats {
		if h.StageIndex == stageIdx && isCTAHeatID(h.ID) {
			return false, 0, ""
		}
	}

	// Legacy fallback for Grand Final heats without an explicit Finals Round struct
	var legacyFinals []*domain.RaceHeat
	for i := range st.Heats {
		h := &st.Heats[i]
		if h.StageIndex == stageIdx && (h.BracketLane == "finals" || isGrandFinalHeatID(h.ID)) {
			legacyFinals = append(legacyFinals, h)
		}
	}
	if len(legacyFinals) > 0 {
		return resolveSingleFinalsRoundWinner(nil, legacyFinals)
	}

	return hasAnyConfirmedOrActiveHeat, 0, ""
}

// AnyRealHeatStartedInStage reports whether any heat in `stageIdx` has actually started
// (ignoring auto-advanced bye heats or waiting/ready/staged heats).
func AnyRealHeatStartedInStage(st *domain.RaceTournamentState, stageIdx int) bool {
	if st == nil {
		return false
	}
	for _, h := range st.Heats {
		if h.StageIndex != stageIdx {
			continue
		}
		if h.State == domain.HeatCountdown || h.State == domain.HeatRunning ||
			h.State == domain.HeatPaused || h.State == domain.HeatFinished || h.State == domain.HeatAborted ||
			(h.State == domain.HeatConfirmed && h.Note != "Auto-advance (bye)") {
			return true
		}
	}
	return false
}

// AnyCompletedOrRunningHeatInStage reports whether any non-bye heat in `stageIdx` is completed
// (`finished` / `confirmed`) or actively racing (`countdown` / `running`). Stages with only
// uncompleted (`waiting`, `ready`, `staged`, `paused`, `aborted`, or bye) heats may be deleted.
func AnyCompletedOrRunningHeatInStage(st *domain.RaceTournamentState, stageIdx int) bool {
	if st == nil {
		return false
	}
	for _, h := range st.Heats {
		if h.StageIndex != stageIdx {
			continue
		}
		if h.State == domain.HeatCountdown || h.State == domain.HeatRunning ||
			h.State == domain.HeatFinished ||
			(h.State == domain.HeatConfirmed && h.Note != "Auto-advance (bye)") {
			return true
		}
	}
	return false
}

// stageFeedingHeats returns the heats in `stageIdx` that feed into its outgoing Seeding Handoff portal
// (or all heats in `stageIdx` when running a terminal Qualifying stage).
func stageFeedingHeats(st *domain.RaceTournamentState, stageIdx int) []*domain.RaceHeat {
	if st == nil {
		return nil
	}
	hasOutgoing := len(OutgoingStageConnections(st, stageIdx)) > 0 || (len(st.Stages) == 0 && st.TotalStages >= 2 && stageIdx == 1)
	handoffOutID := domain.StageHandoffOutID(stageIdx)
	if hasOutgoing {
		revAdj := make(map[string][]string)
		for _, c := range st.Connections {
			if !c.Invalid && c.FromRoundID != "" && c.ToRoundID != "" {
				revAdj[c.ToRoundID] = append(revAdj[c.ToRoundID], c.FromRoundID)
			}
		}
		fedRounds := make(map[string]bool)
		queue := append([]string(nil), revAdj[handoffOutID]...)
		for len(queue) > 0 {
			cur := queue[0]
			queue = queue[1:]
			if fedRounds[cur] {
				continue
			}
			fedRounds[cur] = true
			for _, prev := range revAdj[cur] {
				if !fedRounds[prev] {
					queue = append(queue, prev)
				}
			}
		}
		hasHandoffRound := false
		for _, r := range st.Rounds {
			if r.ID == handoffOutID {
				hasHandoffRound = true
				break
			}
		}
		var out []*domain.RaceHeat
		if len(fedRounds) > 0 {
			for i := range st.Heats {
				if st.Heats[i].StageIndex == stageIdx && fedRounds[st.Heats[i].RoundID] {
					out = append(out, &st.Heats[i])
				}
			}
			return out
		}
		stg := findStagePtr(st, stageIdx)
		isCustomStage := st.TemplateID == "custom" || (stg != nil && (stg.Customized || stg.Format == domain.FormatCustom))
		if hasHandoffRound && isCustomStage {
			return nil
		}
		for i := range st.Heats {
			if st.Heats[i].StageIndex == stageIdx {
				out = append(out, &st.Heats[i])
			}
		}
		return out
	}

	var out []*domain.RaceHeat
	for i := range st.Heats {
		if st.Heats[i].StageIndex == stageIdx {
			out = append(out, &st.Heats[i])
		}
	}
	return out
}

func stage1FeedingHeats(st *domain.RaceTournamentState) []*domain.RaceHeat {
	return stageFeedingHeats(st, 1)
}

func updateUnlockFlags(st *domain.RaceTournamentState) {
	for i := range st.Heats {
		h := &st.Heats[i]
		h.CanUnlock = h.State == domain.HeatConfirmed && h.Note != "Auto-advance (bye)"
	}
}

// LastChannelByPilot returns the last assigned encoded VTX channel code for each pilot across `heats`.
func LastChannelByPilot(heats []domain.RaceHeat) map[int]uint8 {
	out := make(map[int]uint8)
	for _, h := range heats {
		for _, s := range h.Seats {
			if s.PilotSlotIndex > 0 {
				if code := domain.EncodeBandChannel(s.Band, s.Channel); code > 0 {
					out[s.PilotSlotIndex] = code
				}
			}
		}
	}
	return out
}

// LastChannelByPilotConfirmed returns the last encoded VTX channel code from confirmed heats (or Round 1 heats).
func LastChannelByPilotConfirmed(heats []domain.RaceHeat) map[int]uint8 {
	out := make(map[int]uint8)
	for _, h := range heats {
		if h.State == domain.HeatConfirmed || h.Round == 1 {
			for _, s := range h.Seats {
				if s.PilotSlotIndex > 0 {
					if code := domain.EncodeBandChannel(s.Band, s.Channel); code > 0 {
						out[s.PilotSlotIndex] = code
					}
				}
			}
		}
	}
	return out
}

func sliceStandingsForStageConnection(
	upRankings []domain.TournamentStanding,
	sc domain.StageConnection,
	legacyStage2MaxSeeds int,
	isLegacyTwoStage2 bool,
) []domain.TournamentStanding {
	if len(upRankings) == 0 {
		return nil
	}
	switch sc.Mode {
	case "top_n":
		cnt := sc.Count
		if cnt < 1 || cnt > len(upRankings) {
			cnt = len(upRankings)
		}
		return append([]domain.TournamentStanding(nil), upRankings[:cnt]...)
	case "seed_range":
		start := sc.SeedStart
		if start < 1 {
			start = 1
		}
		if start > len(upRankings) {
			return nil
		}
		end := sc.SeedEnd
		if end <= 0 || end > len(upRankings) {
			end = len(upRankings)
		}
		if end < start {
			return nil
		}
		return append([]domain.TournamentStanding(nil), upRankings[start-1:end]...)
	default: // "all_pilots"
		cnt := len(upRankings)
		if isLegacyTwoStage2 && legacyStage2MaxSeeds > 0 && legacyStage2MaxSeeds < cnt {
			cnt = legacyStage2MaxSeeds
		}
		return append([]domain.TournamentStanding(nil), upRankings[:cnt]...)
	}
}

func rankAdvancesFromStage(rank int, outs []domain.StageConnection, legacyStage2MaxSeeds int, isLegacyTwoStage1 bool) bool {
	if len(outs) == 0 {
		return true
	}
	for _, sc := range outs {
		switch sc.Mode {
		case "top_n":
			cnt := sc.Count
			if cnt < 1 || rank <= cnt {
				return true
			}
		case "seed_range":
			start := sc.SeedStart
			if start < 1 {
				start = 1
			}
			if rank >= start && (sc.SeedEnd <= 0 || rank <= sc.SeedEnd) {
				return true
			}
		default: // "all_pilots"
			if isLegacyTwoStage1 && legacyStage2MaxSeeds > 0 {
				if rank <= legacyStage2MaxSeeds {
					return true
				}
			} else {
				return true
			}
		}
	}
	return false
}

func buildStageParticipantRoster(
	st *domain.RaceTournamentState,
	roster []domain.PilotSlot,
	stageIdx int,
	incomingSeeds []domain.TournamentStanding,
) []domain.PilotSlot {
	hasIncoming := len(IncomingStageConnections(st, stageIdx)) > 0
	if !hasIncoming || len(incomingSeeds) == 0 {
		return roster
	}
	rosterBySlot := make(map[int]domain.PilotSlot, len(roster))
	for _, p := range roster {
		rosterBySlot[p.SlotIndex] = p
	}
	seen := make(map[int]bool, len(incomingSeeds))
	out := make([]domain.PilotSlot, 0, len(incomingSeeds))
	for _, sd := range incomingSeeds {
		if sd.PilotSlotIndex <= 0 || seen[sd.PilotSlotIndex] {
			continue
		}
		seen[sd.PilotSlotIndex] = true
		if rp, ok := rosterBySlot[sd.PilotSlotIndex]; ok {
			out = append(out, rp)
		} else {
			out = append(out, domain.PilotSlot{
				SlotIndex:    sd.PilotSlotIndex,
				Callsign:     sd.Callsign,
				PhoneticName: sd.PhoneticName,
				Color:        sd.Color,
			})
		}
	}
	// Include any manually assigned pilots seated directly in heats of `stageIdx`
	for _, h := range st.Heats {
		if h.StageIndex != stageIdx {
			continue
		}
		for _, s := range h.Seats {
			if s.PilotSlotIndex <= 0 || seen[s.PilotSlotIndex] {
				continue
			}
			seen[s.PilotSlotIndex] = true
			if rp, ok := rosterBySlot[s.PilotSlotIndex]; ok {
				out = append(out, rp)
			} else {
				out = append(out, domain.PilotSlot{
					SlotIndex:    s.PilotSlotIndex,
					Callsign:     s.Callsign,
					PhoneticName: s.PhoneticName,
					Color:        s.Color,
				})
			}
		}
	}
	return out
}

// QualifierChainRoundIDs walks upstream from `roundID` across valid `all_pilots` or same-phase
// cumulative rounds (`FormatQualifying`, `FormatOpenQualifier`, `FormatPointsMains`), returning the
// connected round IDs in topological column order (`Q1 -> Q2 -> ... -> Qr`).
func QualifierChainRoundIDs(st *domain.RaceTournamentState, roundID string) []string {
	if st == nil || roundID == "" {
		return nil
	}
	roundByID := make(map[string]*domain.RaceRound, len(st.Rounds))
	for i := range st.Rounds {
		roundByID[st.Rounds[i].ID] = &st.Rounds[i]
	}
	targetR := roundByID[roundID]
	if targetR == nil {
		return []string{roundID}
	}
	isQualLike := func(r *domain.RaceRound) bool {
		if r == nil {
			return false
		}
		return r.StageFormat == domain.FormatQualifying || r.StageFormat == domain.FormatOpenQualifier || domain.IsOpenQualRoundID(r.ID)
	}
	targetIsQual := isQualLike(targetR)
	targetIsPoints := targetR.StageFormat == domain.FormatPointsMains

	visited := map[string]bool{roundID: true}
	queue := []string{roundID}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, c := range st.Connections {
			if c.Invalid || c.ToRoundID != cur || c.FromRoundID == "" || visited[c.FromRoundID] {
				continue
			}
			upR := roundByID[c.FromRoundID]
			if upR == nil || domain.IsStagePortalRoundID(upR.ID) {
				continue
			}
			sameChain := false
			if c.Mode == "all_pilots" {
				if (targetIsQual && isQualLike(upR)) || (targetIsPoints && upR.StageFormat == domain.FormatPointsMains) || (!targetIsQual && !targetIsPoints) {
					sameChain = true
				}
			} else if targetIsQual && isQualLike(upR) {
				sameChain = true
			}
			if sameChain {
				visited[upR.ID] = true
				queue = append(queue, upR.ID)
			}
		}
	}

	out := make([]string, 0, len(visited))
	for id := range visited {
		out = append(out, id)
	}
	sort.SliceStable(out, func(i, j int) bool {
		ri, rj := roundByID[out[i]], roundByID[out[j]]
		if ri == nil || rj == nil {
			return out[i] < out[j]
		}
		if ri.Column != rj.Column {
			return ri.Column < rj.Column
		}
		return ri.Round < rj.Round
	})
	return out
}

func isStandingsCutMode(mode string) bool {
	return mode == "standings_top" || mode == "all_pilots_ranked"
}

// IsRoundSkippedByEarlySeed reports whether `roundID` belongs to an upstream qualifier chain whose
// outgoing bracket/mains cut connection(s) have all been locked early via `Seed Now` (`SeededEarly`).
// When true, any remaining unstarted heats in `roundID` are bypassed so Race Control advances straight
// to the seeded downstream round (while `reopen_connection_seed` restores them if unstarted).
func IsRoundSkippedByEarlySeed(st *domain.RaceTournamentState, roundID string) bool {
	if st == nil || roundID == "" {
		return false
	}
	roundByID := make(map[string]*domain.RaceRound, len(st.Rounds))
	for i := range st.Rounds {
		roundByID[st.Rounds[i].ID] = &st.Rounds[i]
	}
	r := roundByID[roundID]
	if r == nil || domain.IsStagePortalRoundID(r.ID) {
		return false
	}
	if r.StageFormat != domain.FormatQualifying && r.StageFormat != domain.FormatOpenQualifier && !domain.IsOpenQualRoundID(r.ID) {
		return false
	}

	// Walk forward along `all_pilots` qualifier links to find the terminal qualifier round(s) of this chain
	visited := map[string]bool{roundID: true}
	queue := []string{roundID}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, c := range st.Connections {
			if c.Invalid || c.FromRoundID != cur || visited[c.ToRoundID] {
				continue
			}
			dst := roundByID[c.ToRoundID]
			if dst != nil && c.Mode == "all_pilots" && (dst.StageFormat == domain.FormatQualifying || dst.StageFormat == domain.FormatOpenQualifier) {
				visited[dst.ID] = true
				queue = append(queue, dst.ID)
			}
		}
	}

	var cutConns []domain.RoundConnection
	for _, c := range st.Connections {
		if !c.Invalid && visited[c.FromRoundID] && isStandingsCutMode(c.Mode) {
			cutConns = append(cutConns, c)
		}
	}
	if len(cutConns) == 0 {
		return false
	}
	for _, cc := range cutConns {
		if !cc.SeededEarly && !st.Stage2SeededEarly {
			return false
		}
	}
	// Ensure >= 1 heat in the upstream chain is actually confirmed
	chainSet := make(map[string]bool)
	for _, cc := range cutConns {
		for _, cid := range QualifierChainRoundIDs(st, cc.FromRoundID) {
			chainSet[cid] = true
		}
	}
	for _, h := range st.Heats {
		if chainSet[h.RoundID] && h.State == domain.HeatConfirmed {
			return true
		}
	}
	return false
}

// IsStandingsFeederReady reports whether an upstream qualifier/points standings feeder (`FromRoundID` or `FromRoundColumn`)
// is ready to resolve concrete pilot placements into `dstRoundID`.
func IsStandingsFeederReady(
	st *domain.RaceTournamentState,
	dstRoundID string,
	stageIdx int,
	excludeHeatID string,
	f domain.SeatFeeder,
) bool {
	if st == nil {
		return false
	}
	if f.FromRoundID != "" {
		seededEarly := st.Stage2SeededEarly
		for _, c := range st.Connections {
			if !c.Invalid && c.FromRoundID == f.FromRoundID && (dstRoundID == "" || c.ToRoundID == dstRoundID) && c.SeededEarly {
				seededEarly = true
				break
			}
		}
		if !seededEarly {
			// Also check if all cut wires leaving FromRoundID were seeded early together
			allFromEarly := false
			for _, c := range st.Connections {
				if !c.Invalid && c.FromRoundID == f.FromRoundID && isStandingsCutMode(c.Mode) {
					allFromEarly = true
					if !c.SeededEarly {
						allFromEarly = false
						break
					}
				}
			}
			if allFromEarly {
				seededEarly = true
			}
		}

		chainIDs := QualifierChainRoundIDs(st, f.FromRoundID)
		chainSet := make(map[string]bool, len(chainIDs))
		hasOQ := false
		for _, cid := range chainIDs {
			chainSet[cid] = true
			for _, r := range st.Rounds {
				if r.ID == cid && (r.StageFormat == domain.FormatOpenQualifier || domain.IsOpenQualRoundID(r.ID)) {
					hasOQ = true
				}
			}
		}
		total := 0
		confirmed := 0
		for _, uh := range st.Heats {
			if chainSet[uh.RoundID] && uh.ID != excludeHeatID {
				total++
				if uh.State == domain.HeatConfirmed {
					confirmed++
				}
			}
		}
		if seededEarly {
			return confirmed >= 1
		}
		if hasOQ {
			return st.Lifecycle == domain.LifecycleCompleted && confirmed >= 1
		}
		return total > 0 && confirmed == total
	}

	// Legacy column fallback when FromRoundID is empty
	hasAnyInCols := false
	confirmedCols := 0
	colsConfirmed := true
	for _, uh := range st.Heats {
		if uh.StageIndex == stageIdx && uh.Column <= f.FromRoundColumn && uh.ID != excludeHeatID {
			hasAnyInCols = true
			if uh.State == domain.HeatConfirmed {
				confirmedCols++
			} else {
				colsConfirmed = false
			}
		}
	}
	if st.Stage2SeededEarly && confirmedCols >= 1 {
		return true
	}
	return hasAnyInCols && colsConfirmed
}

// ComputeStandingsForRoundChain ranks `roster` across all confirmed heats in the connected upstream
// chain ending at `fromRoundID` (`QualifierChainRoundIDs`), using `metricOverride` (or the source round's metric).
func ComputeStandingsForRoundChain(
	st *domain.RaceTournamentState,
	roster []domain.PilotSlot,
	fromRoundID string,
	metricOverride domain.QualifyingMetric,
) []domain.TournamentStanding {
	if st == nil {
		return nil
	}
	chainIDs := QualifierChainRoundIDs(st, fromRoundID)
	chainSet := make(map[string]bool, len(chainIDs))
	for _, cid := range chainIDs {
		chainSet[cid] = true
	}

	var srcRound *domain.RaceRound
	for i := range st.Rounds {
		if st.Rounds[i].ID == fromRoundID {
			srcRound = &st.Rounds[i]
			break
		}
	}

	stats := make(map[int]*domain.TournamentStanding, len(roster))
	for i, p := range roster {
		stats[p.SlotIndex] = &domain.TournamentStanding{
			PilotSlotIndex: p.SlotIndex,
			Callsign:       p.Callsign,
			PhoneticName:   p.PhoneticName,
			Color:          p.Color,
			Seed:           i + 1,
			BracketStatus:  "Qualifying",
		}
	}

	hasQualHeats := srcRound != nil && (srcRound.StageFormat == domain.FormatQualifying || srcRound.StageFormat == domain.FormatOpenQualifier || domain.IsOpenQualRoundID(srcRound.ID))
	for _, h := range st.Heats {
		if !chainSet[h.RoundID] || (h.State != domain.HeatConfirmed && h.State != domain.HeatFinished) {
			continue
		}
		if h.StageFormat == domain.FormatQualifying || h.StageFormat == domain.FormatOpenQualifier {
			hasQualHeats = true
		}
		for _, s := range h.Seats {
			row := stats[s.PilotSlotIndex]
			if row == nil {
				continue
			}
			if s.Seed > 0 {
				row.Seed = s.Seed
			}
			if s.Status == domain.PilotHeatDQ || s.Status == domain.PilotHeatDNS {
				continue
			}
			row.HeatsFlown++
			row.TotalLaps += s.LapsCompleted
			row.Points += s.Points
			if s.Position == 1 {
				row.Wins++
			}
			if s.BestLapSec > 0 && (row.BestLapSec == 0 || s.BestLapSec < row.BestLapSec) {
				row.BestLapSec = s.BestLapSec
			}
			if s.BestConsecutive2Sec > 0 && (row.BestConsecutive2Sec == 0 || s.BestConsecutive2Sec < row.BestConsecutive2Sec) {
				row.BestConsecutive2Sec = s.BestConsecutive2Sec
			}
			if s.BestConsecutive3Sec > 0 && (row.BestConsecutive3Sec == 0 || s.BestConsecutive3Sec < row.BestConsecutive3Sec) {
				row.BestConsecutive3Sec = s.BestConsecutive3Sec
			}
		}
	}

	rows := make([]domain.TournamentStanding, 0, len(stats))
	for _, r := range stats {
		rows = append(rows, *r)
	}
	metric := st.Config.QualifyingMetric
	if srcRound != nil && srcRound.QualifyingMetric != "" {
		metric = srcRound.QualifyingMetric
	}
	if metricOverride != "" {
		metric = metricOverride
	}
	sortQualifyingRows(rows, metric, hasQualHeats || metricOverride != "")
	for i := range rows {
		rows[i].Rank = i + 1
	}
	return rows
}

// ComputeStandingsForFeeder resolves ranked standings for a `SeatFeeder` (`FromRoundID` or legacy `FromRoundColumn`).
func ComputeStandingsForFeeder(
	st *domain.RaceTournamentState,
	roster []domain.PilotSlot,
	stageIdx int,
	f domain.SeatFeeder,
) []domain.TournamentStanding {
	if f.FromRoundID != "" {
		metric := f.RankingMetric
		if metric == "" {
			for _, c := range st.Connections {
				if !c.Invalid && c.FromRoundID == f.FromRoundID && c.RankingMetric != "" {
					metric = c.RankingMetric
					break
				}
			}
		}
		return ComputeStandingsForRoundChain(st, roster, f.FromRoundID, metric)
	}
	return ComputeStandingsUpToColumn(st, roster, stageIdx, f.FromRoundColumn)
}

func sortQualifyingRows(rows []domain.TournamentStanding, metric domain.QualifyingMetric, useQualMetric bool) {
	sort.SliceStable(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		if useQualMetric {
			switch metric {
			case domain.QualMetricBestLap:
				if (a.BestLapSec > 0) != (b.BestLapSec > 0) {
					return a.BestLapSec > 0
				}
				if a.BestLapSec > 0 && a.BestLapSec != b.BestLapSec {
					return a.BestLapSec < b.BestLapSec
				}
			case domain.QualMetricLapsInTime:
				if a.TotalLaps != b.TotalLaps {
					return a.TotalLaps > b.TotalLaps
				}
			case domain.QualMetricPoints:
				if a.Points != b.Points {
					return a.Points > b.Points
				}
				if a.Wins != b.Wins {
					return a.Wins > b.Wins
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
			default:
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
		} else {
			if a.Points != b.Points {
				return a.Points > b.Points
			}
			if a.Wins != b.Wins {
				return a.Wins > b.Wins
			}
		}
		if a.TotalLaps != b.TotalLaps {
			return a.TotalLaps > b.TotalLaps
		}
		if (a.BestLapSec > 0) != (b.BestLapSec > 0) {
			return a.BestLapSec > 0
		}
		if a.BestLapSec > 0 && a.BestLapSec != b.BestLapSec {
			return a.BestLapSec < b.BestLapSec
		}
		return a.Seed < b.Seed
	})
}

func rankAdvancesViaRoundCuts(rank int, cutConns []domain.RoundConnection) bool {
	if len(cutConns) == 0 {
		return true
	}
	for _, c := range cutConns {
		sStart := c.SeedStart
		if sStart < 1 {
			sStart = 1
		}
		sEnd := c.SeedEnd
		if sEnd <= 0 && c.Count > 0 && sStart == 1 {
			sEnd = c.Count
		}
		if rank >= sStart && (sEnd <= 0 || rank <= sEnd) {
			return true
		}
	}
	return false
}

func syncUnifiedQualifyingStatus(st *domain.RaceTournamentState, roster []domain.PilotSlot) {
	if st == nil {
		return
	}
	roundByID := make(map[string]*domain.RaceRound, len(st.Rounds))
	var qualRoundIDs []string
	hasNonQual := false
	for i := range st.Rounds {
		r := &st.Rounds[i]
		if domain.IsStagePortalRoundID(r.ID) {
			continue
		}
		roundByID[r.ID] = r
		if r.StageFormat == domain.FormatQualifying || r.StageFormat == domain.FormatOpenQualifier || domain.IsOpenQualRoundID(r.ID) {
			qualRoundIDs = append(qualRoundIDs, r.ID)
		} else {
			hasNonQual = true
		}
	}
	if len(qualRoundIDs) == 0 {
		st.QualifyingComplete = false
		st.CanStartStage2 = false
		return
	}
	var cutConns []domain.RoundConnection
	var lastQualID string
	maxQualCol := -1
	for _, qid := range qualRoundIDs {
		if r := roundByID[qid]; r != nil && r.Column >= maxQualCol {
			maxQualCol = r.Column
			lastQualID = qid
		}
		for _, c := range st.Connections {
			if !c.Invalid && c.FromRoundID == qid && isStandingsCutMode(c.Mode) {
				cutConns = append(cutConns, c)
			}
		}
	}
	if lastQualID != "" {
		var metric domain.QualifyingMetric
		if len(cutConns) > 0 && cutConns[0].RankingMetric != "" {
			metric = cutConns[0].RankingMetric
		}
		qRows := ComputeStandingsForRoundChain(st, roster, lastQualID, metric)
		for i := range qRows {
			if len(cutConns) > 0 {
				if rankAdvancesViaRoundCuts(i+1, cutConns) {
					qRows[i].BracketStatus = fmt.Sprintf("Seed #%d", i+1)
				} else {
					qRows[i].BracketStatus = fmt.Sprintf("Cut (#%d)", i+1)
				}
			} else {
				qRows[i].BracketStatus = fmt.Sprintf("Seed #%d", i+1)
			}
		}
		st.QualStandings = qRows
	}
	if !hasNonQual || len(cutConns) == 0 {
		if len(st.Stages) == 1 && (st.Stages[0].Format == domain.FormatQualifying || st.Stages[0].Format == domain.FormatOpenQualifier) {
			st.QualStandings = append([]domain.TournamentStanding(nil), st.Stages[0].Standings...)
		}
		st.QualifyingComplete = false
		st.CanStartStage2 = false
		return
	}

	qualSet := make(map[string]bool, len(qualRoundIDs))
	for _, qid := range qualRoundIDs {
		qualSet[qid] = true
	}
	anyQualConfirmed := false
	for _, h := range st.Heats {
		if qualSet[h.RoundID] && h.State == domain.HeatConfirmed {
			anyQualConfirmed = true
			break
		}
	}
	allCutsReady := true
	for _, cc := range cutConns {
		if !IsStandingsFeederReady(st, cc.ToRoundID, 1, "", domain.SeatFeeder{FromRoundID: cc.FromRoundID, FromStandingsRank: 1}) {
			allCutsReady = false
			break
		}
	}
	st.QualifyingComplete = allCutsReady
	st.CanStartStage2 = anyQualConfirmed && !allCutsReady
}

// ComputeStageStandingsWithMetric computes live standings for `stageIdx`, optionally ranking by an
// explicit `metricOverride` when slicing seeds for a downstream StageConnection.
func ComputeStageStandingsWithMetric(
	st *domain.RaceTournamentState,
	roster []domain.PilotSlot,
	stageIdx int,
	metricOverride domain.QualifyingMetric,
	incomingSeeds []domain.TournamentStanding,
	stageDone bool,
) []domain.TournamentStanding {
	if st == nil {
		return nil
	}
	stg := findStagePtr(st, stageIdx)
	format := st.Config.MainFormat
	stgSettings := domain.DefaultStageSettingsFromConfig(st.Config, format)
	champSlot := st.ChampionSlotIndex
	if stg != nil {
		format = stg.Format
		stgSettings = stg.Settings.Normalized(st.Config, format)
		champSlot = stg.ChampionSlotIndex
	} else if st.TotalStages >= 2 && stageIdx == 1 {
		format = domain.FormatQualifying
		stgSettings = domain.DefaultStageSettingsFromConfig(st.Config, format)
	}

	participants := buildStageParticipantRoster(st, roster, stageIdx, incomingSeeds)

	// Unified single-graph mixed Qualifying + Bracket/Mains detection
	qualRoundSet := make(map[string]bool)
	var lastQualRoundID string
	maxQualCol := -1
	hasNonQualRound := false
	var cutConns []domain.RoundConnection
	if len(st.Stages) <= 1 && stageIdx == 1 && metricOverride == "" {
		for _, r := range st.Rounds {
			if r.StageIndex != stageIdx || domain.IsStagePortalRoundID(r.ID) {
				continue
			}
			if r.StageFormat == domain.FormatQualifying || r.StageFormat == domain.FormatOpenQualifier || domain.IsOpenQualRoundID(r.ID) {
				qualRoundSet[r.ID] = true
				if r.Column >= maxQualCol {
					maxQualCol = r.Column
					lastQualRoundID = r.ID
				}
			} else {
				hasNonQualRound = true
			}
		}
		if len(qualRoundSet) > 0 && hasNonQualRound {
			for _, c := range st.Connections {
				if !c.Invalid && qualRoundSet[c.FromRoundID] && isStandingsCutMode(c.Mode) {
					cutConns = append(cutConns, c)
				}
			}
		}
	}

	isMixedUnified := len(qualRoundSet) > 0 && hasNonQualRound && lastQualRoundID != ""
	var unifiedQualRows []domain.TournamentStanding
	if isMixedUnified {
		var cutMetric domain.QualifyingMetric
		if len(cutConns) > 0 && cutConns[0].RankingMetric != "" {
			cutMetric = cutConns[0].RankingMetric
		}
		unifiedQualRows = ComputeStandingsForRoundChain(st, participants, lastQualRoundID, cutMetric)
		for i := range unifiedQualRows {
			if len(cutConns) > 0 {
				if rankAdvancesViaRoundCuts(i+1, cutConns) {
					unifiedQualRows[i].BracketStatus = fmt.Sprintf("Seed #%d", i+1)
				} else {
					unifiedQualRows[i].BracketStatus = fmt.Sprintf("Cut (#%d)", i+1)
				}
			} else {
				unifiedQualRows[i].BracketStatus = fmt.Sprintf("Seed #%d", i+1)
			}
		}
		allCutsReady := len(cutConns) > 0
		for _, cc := range cutConns {
			if !IsStandingsFeederReady(st, cc.ToRoundID, stageIdx, "", domain.SeatFeeder{FromRoundID: cc.FromRoundID, FromStandingsRank: 1}) {
				allCutsReady = false
				break
			}
		}
		anyPostQualStarted := false
		for _, h := range st.Heats {
			if h.StageIndex == stageIdx && !qualRoundSet[h.RoundID] &&
				(h.State == domain.HeatCountdown || h.State == domain.HeatRunning || h.State == domain.HeatPaused || h.State == domain.HeatFinished ||
					(h.State == domain.HeatConfirmed && h.Note != "Auto-advance (bye)")) {
				anyPostQualStarted = true
				break
			}
		}
		// While Qualifying is still underway and no Mains/Bracket heat has started yet, display live Qualifying Standings!
		if !allCutsReady && !anyPostQualStarted {
			return unifiedQualRows
		}
	}

	if format == domain.FormatQualifying || format == domain.FormatOpenQualifier || metricOverride != "" {
		bracketStatusLbl := "Qualifying"
		if format == domain.FormatOpenQualifier {
			bracketStatusLbl = "Open Qualifier"
		}
		stats := make(map[int]*domain.TournamentStanding, len(participants))
		for i, p := range participants {
			stats[p.SlotIndex] = &domain.TournamentStanding{
				PilotSlotIndex: p.SlotIndex,
				Callsign:       p.Callsign,
				PhoneticName:   p.PhoneticName,
				Color:          p.Color,
				Seed:           i + 1,
				BracketStatus:  bracketStatusLbl,
			}
		}
		var feedHeats []*domain.RaceHeat
		if format == domain.FormatQualifying {
			feedHeats = stageFeedingHeats(st, stageIdx)
		} else {
			for i := range st.Heats {
				if st.Heats[i].StageIndex == stageIdx {
					feedHeats = append(feedHeats, &st.Heats[i])
				}
			}
		}
		for _, h := range feedHeats {
			if h.State != domain.HeatConfirmed && h.State != domain.HeatFinished {
				continue
			}
			for _, s := range h.Seats {
				row := stats[s.PilotSlotIndex]
				if row == nil {
					continue
				}
				if s.Seed > 0 {
					row.Seed = s.Seed
				}
				if s.Status == domain.PilotHeatDQ || s.Status == domain.PilotHeatDNS {
					continue
				}
				row.HeatsFlown++
				row.TotalLaps += s.LapsCompleted
				row.Points += s.Points
				if s.Position == 1 {
					row.Wins++
				}
				if s.BestLapSec > 0 && (row.BestLapSec == 0 || s.BestLapSec < row.BestLapSec) {
					row.BestLapSec = s.BestLapSec
				}
				if s.BestConsecutive2Sec > 0 && (row.BestConsecutive2Sec == 0 || s.BestConsecutive2Sec < row.BestConsecutive2Sec) {
					row.BestConsecutive2Sec = s.BestConsecutive2Sec
				}
				if s.BestConsecutive3Sec > 0 && (row.BestConsecutive3Sec == 0 || s.BestConsecutive3Sec < row.BestConsecutive3Sec) {
					row.BestConsecutive3Sec = s.BestConsecutive3Sec
				}
			}
		}

		rows := make([]domain.TournamentStanding, 0, len(stats))
		for _, r := range stats {
			rows = append(rows, *r)
		}
		metric := stgSettings.QualifyingMetric
		if metricOverride != "" {
			metric = metricOverride
		}
		sortQualifyingRows(rows, metric, true)

		outs := OutgoingStageConnections(st, stageIdx)
		isLegacyTwoStage1 := len(st.Stages) == 0 && st.TotalStages == 2 && stageIdx == 1
		for i := range rows {
			rows[i].Rank = i + 1
			if len(outs) > 0 || isLegacyTwoStage1 {
				if rankAdvancesFromStage(i+1, outs, st.Config.Stage2MaxSeeds, isLegacyTwoStage1) {
					rows[i].BracketStatus = fmt.Sprintf("Seed #%d", i+1)
				} else {
					rows[i].BracketStatus = fmt.Sprintf("Cut (#%d)", i+1)
				}
			} else if stageDone && i == 0 && rows[0].HeatsFlown > 0 {
				rows[i].BracketStatus = "Champion"
			} else {
				rows[i].BracketStatus = fmt.Sprintf("Seed #%d", i+1)
			}
		}
		return rows
	}

	type elimMeta struct {
		row            domain.TournamentStanding
		activeLane     string // "champion" | "finals" | "winners" | "losers" | "eliminated" | "mains" | "cut_qual"
		elimOrder      int    // heat Order where eliminated (higher = survived longer = better rank!)
		elimHeatPos    int    // finishing position in elimination heat (lower = better!)
		finalFinishPos int
		inBracket      bool
	}

	qualSeedBySlot := make(map[int]domain.TournamentStanding, len(unifiedQualRows))
	for _, qr := range unifiedQualRows {
		qualSeedBySlot[qr.PilotSlotIndex] = qr
	}

	items := make(map[int]*elimMeta, len(participants))
	for i, p := range participants {
		initSeed := i + 1
		var bestLap, bestC2, bestC3 float64
		if qr, ok := qualSeedBySlot[p.SlotIndex]; ok && qr.Rank > 0 {
			initSeed = qr.Rank
			bestLap = qr.BestLapSec
			bestC2 = qr.BestConsecutive2Sec
			bestC3 = qr.BestConsecutive3Sec
		}
		items[p.SlotIndex] = &elimMeta{
			row: domain.TournamentStanding{
				PilotSlotIndex:      p.SlotIndex,
				Callsign:            p.Callsign,
				PhoneticName:        p.PhoneticName,
				Color:               p.Color,
				Seed:                initSeed,
				BestLapSec:          bestLap,
				BestConsecutive2Sec: bestC2,
				BestConsecutive3Sec: bestC3,
				BracketStatus:       "Ready",
			},
			activeLane: "winners",
		}
	}

	hasElimLanes := format == domain.FormatDoubleElimination || format == domain.FormatSingleElimination
	hasLosersLane := format == domain.FormatDoubleElimination
	hasPointsMains := format == domain.FormatPointsMains
	hasCTALane := format == domain.FormatChaseTheAce
	if format == domain.FormatCustom || isMixedUnified {
		for _, h := range st.Heats {
			if h.StageIndex != stageIdx || qualRoundSet[h.RoundID] {
				continue
			}
			if h.BracketLane == "losers" {
				hasLosersLane = true
				hasElimLanes = true
			} else if h.BracketLane == "winners" || h.BracketLane == "finals" {
				hasElimLanes = true
			} else if h.BracketLane == "mains" || h.StageFormat == domain.FormatPointsMains {
				hasPointsMains = true
			}
			if h.StageFormat == domain.FormatChaseTheAce || isCTAHeatID(h.ID) {
				hasCTALane = true
			}
		}
		if hasPointsMains && !hasElimLanes {
			format = domain.FormatPointsMains
		} else if hasCTALane && !hasLosersLane && !hasPointsMains {
			// Check if post-qualifying is purely Chase the Ace Finals
			onlyFinals := true
			for _, h := range st.Heats {
				if h.StageIndex == stageIdx && !qualRoundSet[h.RoundID] && h.BracketLane != "finals" {
					onlyFinals = false
					break
				}
			}
			if onlyFinals {
				format = domain.FormatChaseTheAce
			}
		}
	}

	for _, h := range st.Heats {
		if h.StageIndex != stageIdx {
			continue
		}
		if isMixedUnified && qualRoundSet[h.RoundID] {
			continue
		}
		for _, s := range h.Seats {
			if s.PilotSlotIndex <= 0 {
				continue
			}
			em := items[s.PilotSlotIndex]
			if em == nil {
				continue
			}
			em.inBracket = true
			if s.Seed > 0 && !isMixedUnified {
				em.row.Seed = s.Seed
			}
			if h.State == domain.HeatConfirmed && h.Note != "Auto-advance (bye)" && s.Status != domain.PilotHeatDNS {
				em.row.HeatsFlown++
				em.row.TotalLaps += s.LapsCompleted
				em.row.Points += s.Points
				if s.Position == 1 && s.Status != domain.PilotHeatDQ && s.Status != domain.PilotHeatDNS {
					em.row.Wins++
				}
				if s.BestLapSec > 0 && (em.row.BestLapSec == 0 || s.BestLapSec < em.row.BestLapSec) {
					em.row.BestLapSec = s.BestLapSec
				}
				if s.BestConsecutive2Sec > 0 && (em.row.BestConsecutive2Sec == 0 || s.BestConsecutive2Sec < em.row.BestConsecutive2Sec) {
					em.row.BestConsecutive2Sec = s.BestConsecutive2Sec
				}
				if s.BestConsecutive3Sec > 0 && (em.row.BestConsecutive3Sec == 0 || s.BestConsecutive3Sec < em.row.BestConsecutive3Sec) {
					em.row.BestConsecutive3Sec = s.BestConsecutive3Sec
				}
			}

			if isCTAHeatID(h.ID) || h.BracketLane == "finals" {
				if s.AceWinsAfter > em.row.AceWins {
					em.row.AceWins = s.AceWinsAfter
				} else if s.AceWinsBefore > em.row.AceWins {
					em.row.AceWins = s.AceWinsBefore
				}
			}

			if hasElimLanes {
				if h.State == domain.HeatConfirmed {
					if h.BracketLane == "finals" || isGrandFinalHeatID(h.ID) || isCTAHeatID(h.ID) {
						em.activeLane = "finals"
						em.finalFinishPos = s.Position
					} else if !s.Advances {
						em.row.Losses++
						if !hasLosersLane || h.BracketLane == "losers" {
							em.activeLane = "eliminated"
							em.elimOrder = h.Order
							em.elimHeatPos = s.Position
						} else {
							em.activeLane = "losers"
						}
					} else if h.BracketLane == "winners" {
						em.activeLane = "winners"
					} else if h.BracketLane == "losers" {
						em.activeLane = "losers"
					}
				} else if h.BracketLane == "finals" && s.PilotSlotIndex > 0 {
					em.activeLane = "finals"
				} else if h.BracketLane == "losers" && em.activeLane != "eliminated" {
					em.activeLane = "losers"
				}
			} else if format == domain.FormatChaseTheAce {
				em.activeLane = "finals"
			} else {
				em.activeLane = "mains"
				if h.Division != "" {
					em.row.BracketStatus = fmt.Sprintf("%s Main", h.Division)
				}
			}
		}
	}

	if isMixedUnified {
		for slot, em := range items {
			if !em.inBracket {
				em.activeLane = "cut_qual"
				if qr, ok := qualSeedBySlot[slot]; ok {
					em.row.HeatsFlown = qr.HeatsFlown
					em.row.TotalLaps = qr.TotalLaps
				}
			}
		}
	}

	if champSlot > 0 {
		if champ, ok := items[champSlot]; ok {
			champ.activeLane = "champion"
		}
	}

	list := make([]*elimMeta, 0, len(items))
	for _, em := range items {
		list = append(list, em)
	}

	lanePriority := func(lane string) int {
		switch lane {
		case "champion":
			return 0
		case "finals":
			return 1
		case "winners":
			return 2
		case "losers":
			return 3
		case "mains":
			return 4
		case "eliminated":
			return 5
		default: // "cut_qual"
			return 6
		}
	}

	sort.SliceStable(list, func(i, j int) bool {
		a, b := list[i], list[j]
		if (a.activeLane == "cut_qual") != (b.activeLane == "cut_qual") {
			return a.activeLane != "cut_qual"
		}
		if a.activeLane == "cut_qual" && b.activeLane == "cut_qual" {
			return a.row.Seed < b.row.Seed
		}
		if format == domain.FormatPointsMains || (!hasElimLanes && format != domain.FormatChaseTheAce) {
			if a.row.Points != b.row.Points {
				return a.row.Points > b.row.Points
			}
			if a.row.Wins != b.row.Wins {
				return a.row.Wins > b.row.Wins
			}
			if a.row.TotalLaps != b.row.TotalLaps {
				return a.row.TotalLaps > b.row.TotalLaps
			}
			return a.row.Seed < b.row.Seed
		}
		if format == domain.FormatChaseTheAce {
			if a.row.AceWins != b.row.AceWins {
				return a.row.AceWins > b.row.AceWins
			}
			if a.row.Points != b.row.Points {
				return a.row.Points > b.row.Points
			}
			return a.row.Seed < b.row.Seed
		}

		pa, pb := lanePriority(a.activeLane), lanePriority(b.activeLane)
		if pa != pb {
			return pa < pb
		}
		if a.activeLane == "finals" {
			if a.row.AceWins != b.row.AceWins {
				return a.row.AceWins > b.row.AceWins
			}
			if a.finalFinishPos > 0 && b.finalFinishPos > 0 && a.finalFinishPos != b.finalFinishPos {
				return a.finalFinishPos < b.finalFinishPos
			}
			if a.row.Points != b.row.Points {
				return a.row.Points > b.row.Points
			}
		}
		if a.activeLane == "eliminated" {
			if a.elimOrder != b.elimOrder {
				return a.elimOrder > b.elimOrder
			}
			if a.elimHeatPos != b.elimHeatPos {
				return a.elimHeatPos < b.elimHeatPos
			}
		}
		if a.row.Points != b.row.Points {
			return a.row.Points > b.row.Points
		}
		return a.row.Seed < b.row.Seed
	})

	primaryFinals := stageFinalsRound(st, stageIdx)
	isCTAFinals := stgSettings.FinalsFormat == domain.FinalsChaseTheAce || format == domain.FormatChaseTheAce ||
		(primaryFinals != nil && (primaryFinals.FinalsFormat == domain.FinalsChaseTheAce || primaryFinals.StageFormat == domain.FormatChaseTheAce))
	aceReq := stgSettings.AceWinsRequired
	if primaryFinals != nil && primaryFinals.AceWinsRequired >= 2 {
		aceReq = primaryFinals.AceWinsRequired
	}
	if aceReq < 2 {
		aceReq = 2
	}

	out := make([]domain.TournamentStanding, len(list))
	for i, em := range list {
		em.row.Rank = i + 1
		switch em.activeLane {
		case "champion":
			em.row.BracketStatus = "Champion"
		case "finals":
			if isCTAFinals {
				if stageDone {
					em.row.BracketStatus = Ordinal(i + 1)
				} else {
					em.row.BracketStatus = fmt.Sprintf("Finals (%d/%d Aces)", em.row.AceWins, aceReq)
				}
			} else if stageDone {
				em.row.BracketStatus = Ordinal(i + 1)
			} else {
				em.row.BracketStatus = "Grand Final"
			}
		case "winners":
			em.row.BracketStatus = "Winners Bracket"
		case "losers":
			em.row.BracketStatus = "Redemption"
		case "eliminated":
			em.row.BracketStatus = fmt.Sprintf("Eliminated (%s)", Ordinal(i+1))
		case "cut_qual":
			em.row.BracketStatus = fmt.Sprintf("Cut (#%d)", em.row.Seed)
		case "mains":
			if stageDone && i == 0 && em.row.HeatsFlown > 0 {
				em.row.BracketStatus = "Champion"
			}
		}
		out[i] = em.row
	}
	return out
}

// ComputeQualifyingStandings ranks all event pilots based on Stage 1 / Qualifying heats.
func ComputeQualifyingStandings(st *domain.RaceTournamentState, roster []domain.PilotSlot) []domain.TournamentStanding {
	if st == nil {
		return nil
	}
	if len(st.QualStandings) > 0 {
		return append([]domain.TournamentStanding(nil), st.QualStandings...)
	}
	stg := findStagePtr(st, 1)
	done := st.QualifyingComplete || (stg != nil && stg.Status == domain.StageStatusCompleted)
	return ComputeStageStandingsWithMetric(st, roster, 1, st.Config.QualifyingMetric, nil, done)
}

// ComputeStandings computes live overall standings for the active stage.
func ComputeStandings(st *domain.RaceTournamentState, roster []domain.PilotSlot) []domain.TournamentStanding {
	if st == nil {
		return nil
	}
	sIdx := st.ActiveStageIndex
	if sIdx < 1 {
		sIdx = 1
	}
	stg := findStagePtr(st, sIdx)
	if stg != nil && len(stg.Standings) > 0 {
		return append([]domain.TournamentStanding(nil), stg.Standings...)
	}
	done := st.IsComplete || (stg != nil && stg.Status == domain.StageStatusCompleted)
	rows := ComputeStageStandingsWithMetric(st, roster, sIdx, "", nil, done)
	if st.IsComplete && st.ChampionSlotIndex == 0 && len(rows) > 0 && rows[0].HeatsFlown > 0 {
		rows[0].BracketStatus = "Champion"
		st.ChampionSlotIndex = rows[0].PilotSlotIndex
		st.ChampionCallsign = rows[0].Callsign
	}
	return rows
}

// ComputeStandingsUpToColumn ranks pilots using confirmed heats in `stageIdx` with `Column <= maxCol`.
func ComputeStandingsUpToColumn(
	st *domain.RaceTournamentState,
	roster []domain.PilotSlot,
	stageIdx int,
	maxCol int,
) []domain.TournamentStanding {
	stats := make(map[int]*domain.TournamentStanding, len(roster))
	for i, p := range roster {
		stats[p.SlotIndex] = &domain.TournamentStanding{
			PilotSlotIndex: p.SlotIndex,
			Callsign:       p.Callsign,
			PhoneticName:   p.PhoneticName,
			Color:          p.Color,
			Seed:           i + 1,
		}
	}
	hasQualHeats := false
	for _, h := range st.Heats {
		if h.StageIndex != stageIdx || h.Column > maxCol || h.State != domain.HeatConfirmed {
			continue
		}
		if h.StageFormat == domain.FormatQualifying || h.StageFormat == domain.FormatOpenQualifier {
			hasQualHeats = true
		}
		for _, s := range h.Seats {
			row := stats[s.PilotSlotIndex]
			if row == nil || s.Status == domain.PilotHeatDQ || s.Status == domain.PilotHeatDNS {
				continue
			}
			row.HeatsFlown++
			row.TotalLaps += s.LapsCompleted
			row.Points += s.Points
			if s.Position == 1 {
				row.Wins++
			}
			if s.BestLapSec > 0 && (row.BestLapSec == 0 || s.BestLapSec < row.BestLapSec) {
				row.BestLapSec = s.BestLapSec
			}
			if s.BestConsecutive2Sec > 0 && (row.BestConsecutive2Sec == 0 || s.BestConsecutive2Sec < row.BestConsecutive2Sec) {
				row.BestConsecutive2Sec = s.BestConsecutive2Sec
			}
			if s.BestConsecutive3Sec > 0 && (row.BestConsecutive3Sec == 0 || s.BestConsecutive3Sec < row.BestConsecutive3Sec) {
				row.BestConsecutive3Sec = s.BestConsecutive3Sec
			}
		}
	}
	rows := make([]domain.TournamentStanding, 0, len(stats))
	for _, r := range stats {
		rows = append(rows, *r)
	}
	sortQualifyingRows(rows, st.Config.QualifyingMetric, hasQualHeats)
	for i := range rows {
		rows[i].Rank = i + 1
	}
	return rows
}

// RebuildEdgesFromFeeders derives `st.Edges` cleanly from `HeatSeat.Feeder` links across `st.Heats`.
func RebuildEdgesFromFeeders(st *domain.RaceTournamentState) {
	if st == nil {
		return
	}
	heatByID := make(map[string]*domain.RaceHeat, len(st.Heats))
	for i := range st.Heats {
		heatByID[st.Heats[i].ID] = &st.Heats[i]
	}
	type edgeKey struct {
		from string
		to   string
	}
	order := make([]edgeKey, 0)
	byKey := make(map[edgeKey]*domain.BracketEdge)

	for _, dst := range st.Heats {
		for _, s := range dst.Seats {
			if s.Feeder == nil || s.Feeder.FromHeatID == "" {
				continue
			}
			src := heatByID[s.Feeder.FromHeatID]
			if src == nil {
				continue
			}
			k := edgeKey{from: src.ID, to: dst.ID}
			isDrop := (src.BracketLane == "winners" && dst.BracketLane == "losers") ||
				(src.ExpectedWinners > 0 && s.Feeder.FromRank > src.ExpectedWinners)
			ed := byKey[k]
			if ed == nil {
				ed = &domain.BracketEdge{
					FromHeatID: src.ID,
					ToHeatID:   dst.ID,
					Ranks:      []int{s.Feeder.FromRank},
					IsDrop:     isDrop,
				}
				byKey[k] = ed
				order = append(order, k)
			} else {
				seen := false
				for _, r := range ed.Ranks {
					if r == s.Feeder.FromRank {
						seen = true
						break
					}
				}
				if !seen {
					ed.Ranks = append(ed.Ranks, s.Feeder.FromRank)
				}
				if isDrop {
					ed.IsDrop = true
				}
			}
		}
	}
	edges := make([]domain.BracketEdge, len(order))
	for i, k := range order {
		edges[i] = *byKey[k]
	}
	st.Edges = edges
}

// FormatConnectionBadge returns a concise, plain-English label for a RoundConnection wire.
func FormatConnectionBadge(c domain.RoundConnection) string {
	cnt := c.Count
	if cnt < 1 {
		cnt = 2
	}
	switch c.Mode {
	case "top_per_heat":
		return fmt.Sprintf("Top %d / heat", cnt)
	case "bottom_per_heat":
		return fmt.Sprintf("Bottom %d / heat", cnt)
	case "standings_top":
		distSuffix := ""
		if c.Distribution == "sequential" {
			distSuffix = " · Sequential"
		} else if c.Distribution == "snake" {
			distSuffix = " · Snake"
		}
		sStart := c.SeedStart
		if sStart < 1 {
			sStart = 1
		}
		if c.SeedEnd > 0 && c.SeedEnd >= sStart {
			if sStart == 1 {
				return fmt.Sprintf("Top %d (#1-#%d)%s", c.SeedEnd, c.SeedEnd, distSuffix)
			}
			return fmt.Sprintf("Ranks #%d-#%d%s", sStart, c.SeedEnd, distSuffix)
		}
		if sStart > 1 {
			return fmt.Sprintf("Ranks #%d+%s", sStart, distSuffix)
		}
		if c.Count > 0 {
			return fmt.Sprintf("Top %d%s", c.Count, distSuffix)
		}
		return fmt.Sprintf("All Qualified%s", distSuffix)
	case "pilots_in":
		if c.Distribution == "snake" {
			return "Checked-In Pilots · Snake"
		}
		if c.Distribution == "sequential" {
			return "Checked-In Pilots · Grouped"
		}
		if c.Distribution == "random" {
			return "Checked-In Pilots · Random"
		}
		return "Checked-In Pilots"
	case "all_pilots":
		return "All pilots · Balanced"
	case "all_pilots_ranked":
		return "All pilots · Ranked"
	case "qual_feed":
		return "Counts for Seeding"
	case "stage_seeds":
		start := c.SeedStart
		if start < 1 {
			start = 1
		}
		distSuffix := ""
		if c.Distribution == "sequential" {
			distSuffix = " · By Rank"
		} else if c.Distribution == "snake" {
			distSuffix = " · Snake"
		}
		if c.SeedEnd > 0 && c.SeedEnd >= start {
			if start == 1 {
				return fmt.Sprintf("Top %d Seeds (#1-#%d)%s", c.SeedEnd, c.SeedEnd, distSuffix)
			}
			return fmt.Sprintf("Seeds #%d-#%d%s", start, c.SeedEnd, distSuffix)
		}
		if start > 1 {
			return fmt.Sprintf("Seeds #%d+%s", start, distSuffix)
		}
		return fmt.Sprintf("All Seeds%s", distSuffix)
	default:
		return fmt.Sprintf("Top %d / heat", cnt)
	}
}

// SyncRoundsMetadata ensures `st.Rounds`, `h.RoundID`, and `st.Connections` stay cleanly synchronized
// across both pre-defined Templates and Custom Round Graphs across 1..5 stages.
func SyncRoundsMetadata(st *domain.RaceTournamentState) {
	if st == nil {
		return
	}
	EnsureStagesMetadata(st)

	stageByIdx := make(map[int]*domain.RaceStage, len(st.Stages))
	for i := range st.Stages {
		stageByIdx[st.Stages[i].Index] = &st.Stages[i]
	}

	type rKey struct {
		stage int
		col   int
		lane  string
	}
	existingByKey := make(map[rKey]domain.RaceRound, len(st.Rounds))
	existingByID := make(map[string]domain.RaceRound, len(st.Rounds))
	for _, r := range st.Rounds {
		existingByKey[rKey{stage: r.StageIndex, col: r.Column, lane: r.BracketLane}] = r
		if r.ID != "" {
			existingByID[r.ID] = r
		}
	}

	// Ensure every heat has a deterministic or preserved RoundID and clear ShortLabel
	for i := range st.Heats {
		h := &st.Heats[i]
		if h.ShortLabel == "" || h.ShortLabel == h.ID {
			h.ShortLabel = FormatHeatShortLabel(h.ID)
		}
		if h.RoundID != "" {
			if _, ok := existingByID[h.RoundID]; ok {
				continue
			}
		}
		k := rKey{stage: h.StageIndex, col: h.Column, lane: h.BracketLane}
		if ex, ok := existingByKey[k]; ok && ex.ID != "" && h.RoundID == "" {
			h.RoundID = ex.ID
		} else if h.RoundID == "" {
			h.RoundID = fmt.Sprintf("s%d-c%d-%s", h.StageIndex, h.Column, h.BracketLane)
		}
	}

	seenID := make(map[string]bool)
	var out []domain.RaceRound

	for _, h := range st.Heats {
		if seenID[h.RoundID] {
			continue
		}
		seenID[h.RoundID] = true

		hasFeeder := false
		hasPilots := false
		for _, oh := range st.Heats {
			if oh.RoundID != h.RoundID {
				continue
			}
			for _, s := range oh.Seats {
				if s.Feeder != nil && !s.Feeder.IsBye {
					hasFeeder = true
				}
				if s.PilotSlotIndex > 0 {
					hasPilots = true
				}
			}
		}

		if ex, ok := existingByID[h.RoundID]; ok {
			ex.StageIndex = h.StageIndex
			ex.Column = h.Column
			ex.BracketLane = h.BracketLane
			ex.Round = h.Round
			if ex.SeedSource == "" && !hasFeeder && hasPilots && h.Column <= 1 {
				ex.SeedSource = "all_active_pilots"
			}
			out = append(out, ex)
			continue
		}

		title := defaultRoundTitle(h.BracketLane, h.Round, h.Column)
		seedSrc := ""
		if !hasFeeder && hasPilots && h.Column <= 1 {
			seedSrc = "all_active_pilots"
		}
		stg := stageByIdx[h.StageIndex]
		stgSettings := domain.DefaultStageSettingsFromConfig(st.Config, h.StageFormat)
		if stg != nil {
			stgSettings = stg.Settings.Normalized(st.Config, stg.Format)
		}
		newRound := domain.RaceRound{
			ID:           h.RoundID,
			StageIndex:   h.StageIndex,
			Round:        h.Round,
			Column:       h.Column,
			BracketLane:  h.BracketLane,
			Title:        title,
			StageFormat:  h.StageFormat,
			StartMode:    h.StartMode,
			TargetLaps:   h.TargetLaps,
			TimeLimitSec: h.TimeLimitSec,
			SeedSource:   seedSrc,
		}
		if h.BracketLane == "finals" {
			if isCTAHeatID(h.ID) || h.StageFormat == domain.FormatChaseTheAce || stgSettings.FinalsFormat == domain.FinalsChaseTheAce {
				newRound.FinalsFormat = domain.FinalsChaseTheAce
				newRound.AceWinsRequired = stgSettings.AceWinsRequired
				if newRound.AceWinsRequired < 2 {
					newRound.AceWinsRequired = 2
				}
				newRound.WinnersAdvantageAce = stgSettings.WinnersAdvantageAce
			} else if stgSettings.FinalsFormat == domain.FinalsPoints {
				newRound.FinalsFormat = domain.FinalsPoints
				newRound.FinalsHeats = stgSettings.PointsRounds
				if newRound.FinalsHeats < 2 {
					newRound.FinalsHeats = 3
				}
			} else {
				newRound.FinalsFormat = domain.FinalsSingle
			}
		}
		out = append(out, newRound)
	}

	// Preserve any empty custom rounds that currently have 0 heats (excluding virtual portal nodes handled below)
	for _, r := range st.Rounds {
		if domain.IsStagePortalRoundID(r.ID) {
			continue
		}
		if r.ID == "" || seenID[r.ID] {
			continue
		}
		stg := stageByIdx[r.StageIndex]
		if len(st.Stages) > 0 && stg == nil {
			continue
		}
		if st.TemplateID == "custom" || strings.HasPrefix(r.ID, "mgp-r") ||
			(stg != nil && (stg.Customized || stg.Format == domain.FormatCustom || (stg.Format == domain.FormatOpenQualifier && !domain.IsOpenQualRoundID(r.ID)))) {
			seenID[r.ID] = true
			out = append(out, r)
		}
	}

	// Emit Open Qualifier Flight-Line round & Stage Handoff Out / Handoff In portal nodes across all stages in `st.Stages`
	for _, s := range st.Stages {
		inConns := IncomingStageConnections(st, s.Index)

		// Open Qualifier stages always expose their Flight-Line round node even before Pack 1 is queued
		if s.Format == domain.FormatOpenQualifier {
			oqID := domain.OpenQualRoundID(s.Index)
			hasOtherStageRound := false
			for _, r := range out {
				if r.StageIndex == s.Index && !domain.IsStagePortalRoundID(r.ID) && r.ID != oqID {
					hasOtherStageRound = true
					break
				}
			}
			if !s.Customized && !seenID[oqID] && !hasOtherStageRound {
				stgSettings := s.Settings.Normalized(st.Config, s.Format)
				seedSrc := "all_active_pilots"
				if len(inConns) > 0 {
					seedSrc = ""
				}
				isZippyQ := strings.Contains(strings.ToLower(s.Title), "zippyq") ||
					(st.MGPLink != nil && st.MGPLink.IsZippyQ && s.Index == 1)
				defaultOqTitle := "Open Qualifier"
				if isZippyQ {
					defaultOqTitle = "ZippyQ Round 1"
				}
				if ex, ok := existingByID[oqID]; ok {
					ex.StageIndex = s.Index
					ex.BracketLane = "open_qual"
					ex.StageFormat = domain.FormatOpenQualifier
					if ex.Column < 1 {
						ex.Column = 1
					}
					if ex.Round < 1 {
						ex.Round = 1
					}
					if ex.Title == "" || ex.Title == "Flight Line Packs" || ex.Title == "Flight line" || ex.Title == "Flight Queue" ||
						(isZippyQ && (ex.Title == "Open Qualifier" || ex.Title == "ZippyQ" || ex.Title == "ZippyQ Qualifier")) ||
						(!isZippyQ && (ex.Title == "ZippyQ" || ex.Title == "ZippyQ Qualifier" || ex.Title == "ZippyQ Round 1")) {
						ex.Title = defaultOqTitle
					}
					if ex.SeedSource == "" && seedSrc != "" {
						ex.SeedSource = seedSrc
					}
					seenID[oqID] = true
					out = append(out, ex)
				} else {
					seenID[oqID] = true
					out = append(out, domain.RaceRound{
						ID:           oqID,
						StageIndex:   s.Index,
						Round:        1,
						Column:       1,
						BracketLane:  "open_qual",
						Title:        defaultOqTitle,
						StageFormat:  domain.FormatOpenQualifier,
						StartMode:    domain.StartModeStaggered,
						TargetLaps:   stgSettings.TargetLaps,
						TimeLimitSec: stgSettings.TimeLimitSec,
						SeedSource:   seedSrc,
					})
				}
			}
		}
	}

	ReconcileStagesFromRoundContents(st, out)
	stageByIdx = make(map[int]*domain.RaceStage, len(st.Stages))
	for i := range st.Stages {
		stageByIdx[st.Stages[i].Index] = &st.Stages[i]
	}

	for _, s := range st.Stages {
		inConns := IncomingStageConnections(st, s.Index)
		outConns := OutgoingStageConnections(st, s.Index)
		nonPortalCount := 0
		finalsCount := 0
		for _, r := range out {
			if r.StageIndex == s.Index && !domain.IsStagePortalRoundID(r.ID) {
				nonPortalCount++
				if r.BracketLane == "finals" {
					finalsCount++
				}
			}
		}

		// Outgoing seeding portal for Qualifying / Open Qualifier stages, or any non-empty customized stage without its own Finals round that feeds a downstream stage
		if len(outConns) > 0 && (s.Format == domain.FormatQualifying || s.Format == domain.FormatOpenQualifier || ((s.Customized || s.Format == domain.FormatCustom) && nonPortalCount > 0 && finalsCount == 0)) {
			outID := domain.StageHandoffOutID(s.Index)
			maxCol := 1
			for _, r := range out {
				if r.StageIndex == s.Index && r.Column > maxCol {
					maxCol = r.Column
				}
			}
			defaultOutTitle := "Next Stage Seeding"
			if len(outConns) == 1 {
				if dst := stageByIdx[outConns[0].ToStageIndex]; dst != nil && dst.Title != "" {
					if len(st.Stages) == 2 && s.Index == 1 && dst.Index == 2 {
						defaultOutTitle = "Stage 2 Seeding"
					} else {
						defaultOutTitle = fmt.Sprintf("%s Seeding", dst.Title)
					}
				}
			}
			if ex, ok := existingByID[outID]; ok {
				ex.StageIndex = s.Index
				ex.BracketLane = "handoff_out"
				ex.Column = maxCol + 1
				ex.Round = maxCol + 1
				if ex.Title == "" {
					ex.Title = defaultOutTitle
				}
				seenID[outID] = true
				out = append(out, ex)
			} else {
				seenID[outID] = true
				out = append(out, domain.RaceRound{
					ID:          outID,
					StageIndex:  s.Index,
					Round:       maxCol + 1,
					Column:      maxCol + 1,
					BracketLane: "handoff_out",
					Title:       defaultOutTitle,
					StageFormat: domain.FormatQualifying,
				})
			}
		}

		// Incoming seeds portal for stages fed by one or more upstream stages
		if len(inConns) > 0 {
			inID := domain.StageHandoffInID(s.Index)
			defaultInTitle := "Incoming Seeds"
			if len(inConns) == 1 {
				if up := stageByIdx[inConns[0].FromStageIndex]; up != nil && up.Format == domain.FormatQualifying {
					defaultInTitle = "Qualifying Seeds"
				}
			}
			if ex, ok := existingByID[inID]; ok {
				ex.StageIndex = s.Index
				ex.BracketLane = "handoff_in"
				ex.Column = 0
				ex.Round = 0
				if ex.Title == "" {
					ex.Title = defaultInTitle
				}
				seenID[inID] = true
				out = append(out, ex)
			} else {
				seenID[inID] = true
				out = append(out, domain.RaceRound{
					ID:          inID,
					StageIndex:  s.Index,
					Round:       0,
					Column:      0,
					BracketLane: "handoff_in",
					Title:       defaultInTitle,
					StageFormat: s.Format,
				})
			}
		}
	}

	laneRank := func(lane string) int {
		switch lane {
		case "handoff_in":
			return 0
		case "qualifying":
			return 1
		case "winners":
			return 2
		case "mains":
			return 3
		case "losers":
			return 4
		case "finals":
			return 5
		case "handoff_out":
			return 7
		default:
			return 6
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].StageIndex != out[j].StageIndex {
			return out[i].StageIndex < out[j].StageIndex
		}
		if out[i].Column != out[j].Column {
			return out[i].Column < out[j].Column
		}
		stg := stageByIdx[out[i].StageIndex]
		if st.TemplateID == "custom" || (stg != nil && (stg.Customized || stg.Format == domain.FormatCustom)) {
			return out[i].Round < out[j].Round
		}
		return laneRank(out[i].BracketLane) < laneRank(out[j].BracketLane)
	})
	st.Rounds = out

	roundByID := make(map[string]*domain.RaceRound, len(st.Rounds))
	stages := make(map[int]bool)
	for i := range st.Rounds {
		roundByID[st.Rounds[i].ID] = &st.Rounds[i]
		stages[st.Rounds[i].StageIndex] = true
	}

	// Prune connections pointing to deleted rounds & normalize StageIndex
	validConns := make([]domain.RoundConnection, 0, len(st.Connections))
	connsPerStage := make(map[int]int)
	for _, c := range st.Connections {
		fromR, okFrom := roundByID[c.FromRoundID]
		toR, okTo := roundByID[c.ToRoundID]
		if !okFrom || !okTo {
			continue
		}
		if toR.StageIndex > 0 {
			c.StageIndex = toR.StageIndex
		} else if fromR.StageIndex > 0 {
			c.StageIndex = fromR.StageIndex
		}
		validConns = append(validConns, c)
		connsPerStage[c.StageIndex]++
	}
	st.Connections = validConns

	// For non-customized generated stages, derive visual RoundConnection wires from SeatFeeders
	if len(st.Stages) > 0 || st.TemplateID != "custom" {
		stageList := make([]int, 0, len(stages))
		for s := range stages {
			stageList = append(stageList, s)
		}
		sort.Ints(stageList)
		for _, sIdx := range stageList {
			stg := stageByIdx[sIdx]
			if stg != nil && (stg.Customized || stg.Format == domain.FormatCustom) {
				continue
			}
			if connsPerStage[sIdx] == 0 {
				derived := deriveStageConnections(st, sIdx)
				st.Connections = append(st.Connections, derived...)
			}
		}
	}

	// Refresh human-readable LinkSummary on every round (ignoring invalid connections)
	inByRound := make(map[string][]domain.RoundConnection)
	invalidInCount := make(map[string]int)
	for _, c := range st.Connections {
		if c.Invalid {
			invalidInCount[c.ToRoundID]++
			continue
		}
		inByRound[c.ToRoundID] = append(inByRound[c.ToRoundID], c)
	}
	for i := range st.Rounds {
		r := &st.Rounds[i]
		if domain.IsStageHandoffOutID(r.ID) {
			ins := inByRound[r.ID]
			if len(ins) > 0 {
				r.LinkSummary = fmt.Sprintf("%d Qualifying round(s)", len(ins))
			} else {
				r.LinkSummary = "Connect Qualifying rounds"
			}
			continue
		}
		if domain.IsStageHandoffInID(r.ID) {
			inStageConns := IncomingStageConnections(st, r.StageIndex)
			if len(inStageConns) == 0 {
				r.LinkSummary = "Checked-in race roster"
			} else if len(st.Stages) == 2 && r.StageIndex == 2 && len(inStageConns) == 1 && inStageConns[0].FromStageIndex == 1 {
				sc := inStageConns[0]
				if sc.Mode == "seed_range" {
					r.LinkSummary = fmt.Sprintf("%s from Stage 1", FormatStageConnectionBadge(sc))
				} else if sc.Mode == "top_n" && sc.Count > 0 {
					r.LinkSummary = fmt.Sprintf("Top %d from Stage 1", sc.Count)
				} else if st.Config.Stage2MaxSeeds > 0 {
					r.LinkSummary = fmt.Sprintf("Top %d from Stage 1", st.Config.Stage2MaxSeeds)
				} else {
					r.LinkSummary = "All qualified seeds from Stage 1"
				}
			} else {
				parts := make([]string, 0, len(inStageConns))
				for _, sc := range inStageConns {
					upTitle := fmt.Sprintf("Stage %d", sc.FromStageIndex)
					if up := stageByIdx[sc.FromStageIndex]; up != nil && up.Title != "" {
						upTitle = up.Title
					}
					parts = append(parts, fmt.Sprintf("%s from %s", FormatStageConnectionBadge(sc), upTitle))
				}
				r.LinkSummary = strings.Join(parts, " + ")
			}
			continue
		}
		ins := inByRound[r.ID]
		if len(ins) == 1 {
			src := roundByID[ins[0].FromRoundID]
			if src != nil {
				r.LinkSummary = fmt.Sprintf("%s · %s", FormatConnectionBadge(ins[0]), src.Title)
			} else {
				r.LinkSummary = FormatConnectionBadge(ins[0])
			}
		} else if len(ins) > 1 {
			parts := make([]string, 0, len(ins))
			for _, c := range ins {
				src := roundByID[c.FromRoundID]
				if src != nil {
					parts = append(parts, fmt.Sprintf("%s (%s)", FormatConnectionBadge(c), src.Title))
				} else {
					parts = append(parts, FormatConnectionBadge(c))
				}
			}
			r.LinkSummary = strings.Join(parts, " + ")
		} else if r.SeedSource == "all_active_pilots" {
			r.LinkSummary = "All active pilots"
		} else if invalidInCount[r.ID] > 0 {
			r.LinkSummary = "Invalid connection"
		} else {
			r.LinkSummary = ""
		}
	}
}

func deriveStageConnections(st *domain.RaceTournamentState, stageIdx int) []domain.RoundConnection {
	heatByID := make(map[string]*domain.RaceHeat)
	colToRoundID := make(map[int]string)
	for i := range st.Heats {
		h := &st.Heats[i]
		if h.StageIndex != stageIdx {
			continue
		}
		heatByID[h.ID] = h
		if _, exists := colToRoundID[h.Column]; !exists && h.RoundID != "" {
			colToRoundID[h.Column] = h.RoundID
		}
	}

	inPortalID := domain.StageHandoffInID(stageIdx)
	outPortalID := domain.StageHandoffOutID(stageIdx)
	hasInPortal := false
	hasOutPortal := false
	roundLaneByID := make(map[string]string)
	for _, r := range st.Rounds {
		if r.StageIndex != stageIdx {
			continue
		}
		roundLaneByID[r.ID] = r.BracketLane
		if r.ID == inPortalID {
			hasInPortal = true
		}
		if r.ID == outPortalID {
			hasOutPortal = true
		}
	}

	type connKey struct {
		fromID string
		toID   string
		mode   string
	}
	var order []connKey
	seenKey := make(map[connKey]bool)
	ranksPerHeat := make(map[connKey]map[string]map[int]bool)
	minStdRank := make(map[connKey]int)
	maxStdRank := make(map[connKey]int)
	var seedConns []domain.RoundConnection

	for _, r := range st.Rounds {
		if r.StageIndex != stageIdx {
			continue
		}
		if hasInPortal && r.ID != inPortalID {
			hasStageSeed := false
			minSeed := 0
			maxSeed := 0
			for _, h := range st.Heats {
				if h.RoundID != r.ID {
					continue
				}
				for _, s := range h.Seats {
					if s.Feeder != nil && s.Feeder.FromStageSeed > 0 {
						if !hasStageSeed || s.Feeder.FromStageSeed < minSeed {
							minSeed = s.Feeder.FromStageSeed
						}
						if !hasStageSeed || s.Feeder.FromStageSeed > maxSeed {
							maxSeed = s.Feeder.FromStageSeed
						}
						hasStageSeed = true
					}
				}
			}
			if hasStageSeed {
				if r.StageFormat == domain.FormatPointsMains && r.Column > 1 {
					if prevID := colToRoundID[r.Column-1]; prevID != "" && prevID != r.ID {
						ck := connKey{fromID: prevID, toID: r.ID, mode: "all_pilots"}
						if !seenKey[ck] {
							seenKey[ck] = true
							order = append(order, ck)
						}
					}
				} else {
					dist := "snake"
					if r.BracketLane == "mains" || r.StageFormat == domain.FormatPointsMains || r.StageFormat == domain.FormatChaseTheAce {
						dist = "sequential"
					}
					seedEnd := 0
					if len(st.Stages) == 2 && stageIdx == 2 && st.Config.Stage2MaxSeeds > 0 {
						seedEnd = st.Config.Stage2MaxSeeds
					} else if minSeed > 1 {
						seedEnd = maxSeed
					}
					seedConns = append(seedConns, domain.RoundConnection{
						ID:           fmt.Sprintf("conn-%s-%s-stage_seeds", inPortalID, r.ID),
						StageIndex:   stageIdx,
						FromRoundID:  inPortalID,
						ToRoundID:    r.ID,
						FromPort:     "right",
						ToPort:       "left",
						Mode:         "stage_seeds",
						Count:        maxSeed - minSeed + 1,
						SeedStart:    minSeed,
						SeedEnd:      seedEnd,
						Distribution: dist,
					})
				}
			}
		}
		for _, h := range st.Heats {
			if h.RoundID != r.ID {
				continue
			}
			for _, s := range h.Seats {
				if s.Feeder == nil || s.Feeder.IsBye {
					continue
				}
				if s.Feeder.FromHeatID != "" {
					srcH := heatByID[s.Feeder.FromHeatID]
					if srcH == nil || srcH.RoundID == "" || srcH.RoundID == r.ID {
						continue
					}
					expWin := srcH.ExpectedWinners
					if expWin < 1 {
						expWin = len(srcH.Seats) / 2
						if expWin < 1 {
							expWin = 1
						}
					}
					mode := "top_per_heat"
					if s.Feeder.FromRank > expWin {
						mode = "bottom_per_heat"
					}
					ck := connKey{fromID: srcH.RoundID, toID: r.ID, mode: mode}
					if !seenKey[ck] {
						seenKey[ck] = true
						order = append(order, ck)
						ranksPerHeat[ck] = make(map[string]map[int]bool)
					}
					if ranksPerHeat[ck][srcH.ID] == nil {
						ranksPerHeat[ck][srcH.ID] = make(map[int]bool)
					}
					ranksPerHeat[ck][srcH.ID][s.Feeder.FromRank] = true
				} else if s.Feeder.FromRoundID != "" || s.Feeder.FromRoundColumn > 0 {
					srcID := s.Feeder.FromRoundID
					if srcID == "" && s.Feeder.FromRoundColumn > 0 {
						srcID = colToRoundID[s.Feeder.FromRoundColumn]
					}
					if srcID == "" || srcID == r.ID {
						continue
					}
					if r.StageFormat == domain.FormatPointsMains && r.Round > 1 {
						if prevID := colToRoundID[r.Column-1]; prevID != "" && prevID != r.ID && prevID != srcID {
							ck := connKey{fromID: prevID, toID: r.ID, mode: "all_pilots"}
							if !seenKey[ck] {
								seenKey[ck] = true
								order = append(order, ck)
							}
							continue
						}
					}
					ck := connKey{fromID: srcID, toID: r.ID, mode: "standings_top"}
					if !seenKey[ck] {
						seenKey[ck] = true
						order = append(order, ck)
					}
					if minStdRank[ck] == 0 || s.Feeder.FromStandingsRank < minStdRank[ck] {
						minStdRank[ck] = s.Feeder.FromStandingsRank
					}
					if s.Feeder.FromStandingsRank > maxStdRank[ck] {
						maxStdRank[ck] = s.Feeder.FromStandingsRank
					}
				}
			}
		}
	}

	out := make([]domain.RoundConnection, 0, len(seedConns)+len(order)+4)
	out = append(out, seedConns...)
	for _, ck := range order {
		cnt := 2
		sStart := 0
		sEnd := 0
		dist := ""
		if ck.mode == "standings_top" {
			sStart = minStdRank[ck]
			if sStart < 1 {
				sStart = 1
			}
			sEnd = maxStdRank[ck]
			if sEnd >= sStart {
				cnt = sEnd - sStart + 1
			} else if maxStdRank[ck] > 0 {
				cnt = maxStdRank[ck]
			} else {
				cnt = 4
			}
			if roundLaneByID[ck.toID] == "mains" {
				dist = "sequential"
			} else {
				dist = "snake"
			}
		} else if ck.mode == "all_pilots" {
			cnt = 0
		} else {
			maxRanks := 0
			for _, rkSet := range ranksPerHeat[ck] {
				if len(rkSet) > maxRanks {
					maxRanks = len(rkSet)
				}
			}
			if maxRanks > 0 {
				cnt = maxRanks
			}
		}
		fromPort := "right"
		toPort := "left"
		if ck.mode == "bottom_per_heat" && roundLaneByID[ck.fromID] != "losers" {
			fromPort = "bottom"
			toPort = "top"
		} else if roundLaneByID[ck.fromID] == "losers" && roundLaneByID[ck.toID] == "finals" {
			toPort = "bottom"
		}
		out = append(out, domain.RoundConnection{
			ID:           fmt.Sprintf("conn-%s-%s-%s", ck.fromID, ck.toID, ck.mode),
			StageIndex:   stageIdx,
			FromRoundID:  ck.fromID,
			ToRoundID:    ck.toID,
			FromPort:     fromPort,
			ToPort:       toPort,
			Mode:         ck.mode,
			Count:        cnt,
			SeedStart:    sStart,
			SeedEnd:      sEnd,
			Distribution: dist,
		})
	}
	// Connect sequential Qualifying rounds (`Q1 -> Q2 -> ...`) with `all_pilots` wires even on unified graphs
	var qualRounds []domain.RaceRound
	for _, r := range st.Rounds {
		if r.StageIndex == stageIdx && !domain.IsStagePortalRoundID(r.ID) && r.StageFormat == domain.FormatQualifying {
			qualRounds = append(qualRounds, r)
		}
	}
	if len(qualRounds) > 1 {
		for idx := 0; idx+1 < len(qualRounds); idx++ {
			cur := qualRounds[idx]
			nxt := qualRounds[idx+1]
			if nxt.Column > cur.Column {
				ck := connKey{fromID: cur.ID, toID: nxt.ID, mode: "all_pilots"}
				if !seenKey[ck] {
					seenKey[ck] = true
					out = append(out, domain.RoundConnection{
						ID:          fmt.Sprintf("conn-%s-%s-all_pilots", cur.ID, nxt.ID),
						StageIndex:  stageIdx,
						FromRoundID: cur.ID,
						ToRoundID:   nxt.ID,
						FromPort:    "right",
						ToPort:      "left",
						Mode:        "all_pilots",
						Count:       0,
					})
				}
			}
		}
	}
	if hasOutPortal && len(qualRounds) > 0 {
		lastQ := qualRounds[len(qualRounds)-1]
		out = append(out, domain.RoundConnection{
			ID:          fmt.Sprintf("conn-%s-%s-qual_feed", lastQ.ID, outPortalID),
			StageIndex:  stageIdx,
			FromRoundID: lastQ.ID,
			ToRoundID:   outPortalID,
			FromPort:    "right",
			ToPort:      "left",
			Mode:        "qual_feed",
			Count:       st.Config.Stage2MaxSeeds,
		})
	}
	stg := findStagePtr(st, stageIdx)
	if stg != nil && stg.Format == domain.FormatOpenQualifier {
		var openRounds []domain.RaceRound
		for _, r := range st.Rounds {
			if r.StageIndex == stageIdx && !domain.IsStagePortalRoundID(r.ID) {
				openRounds = append(openRounds, r)
			}
		}
		if len(openRounds) == 0 && !stg.Customized {
			openRounds = append(openRounds, domain.RaceRound{ID: domain.OpenQualRoundID(stageIdx), Column: 1})
		}
		if hasInPortal && len(openRounds) > 0 {
			out = append(out, domain.RoundConnection{
				ID:           fmt.Sprintf("conn-%s-%s-stage_seeds", inPortalID, openRounds[0].ID),
				StageIndex:   stageIdx,
				FromRoundID:  inPortalID,
				ToRoundID:    openRounds[0].ID,
				FromPort:     "right",
				ToPort:       "left",
				Mode:         "stage_seeds",
				SeedStart:    1,
				Distribution: "sequential",
			})
		}
		for idx, r := range openRounds {
			if idx+1 < len(openRounds) && openRounds[idx+1].Column > r.Column {
				nxt := openRounds[idx+1]
				out = append(out, domain.RoundConnection{
					ID:          fmt.Sprintf("conn-%s-%s-all_pilots", r.ID, nxt.ID),
					StageIndex:  stageIdx,
					FromRoundID: r.ID,
					ToRoundID:   nxt.ID,
					FromPort:    "right",
					ToPort:      "left",
					Mode:        "all_pilots",
					Count:       0,
				})
			} else if hasOutPortal {
				out = append(out, domain.RoundConnection{
					ID:          fmt.Sprintf("conn-%s-%s-qual_feed", r.ID, outPortalID),
					StageIndex:  stageIdx,
					FromRoundID: r.ID,
					ToRoundID:   outPortalID,
					FromPort:    "right",
					ToPort:      "left",
					Mode:        "qual_feed",
					Count:       st.Config.Stage2MaxSeeds,
				})
			}
		}
	} else if !hasInPortal && ((stg != nil && stg.Format == domain.FormatPointsMains) || (stg == nil && st.Config.MainFormat == domain.FormatPointsMains)) {
		var mainsRounds []domain.RaceRound
		for _, r := range st.Rounds {
			if r.StageIndex == stageIdx && !domain.IsStagePortalRoundID(r.ID) {
				mainsRounds = append(mainsRounds, r)
			}
		}
		for idx, r := range mainsRounds {
			if idx+1 < len(mainsRounds) && mainsRounds[idx+1].Column > r.Column {
				nxt := mainsRounds[idx+1]
				out = append(out, domain.RoundConnection{
					ID:          fmt.Sprintf("conn-%s-%s-all_pilots", r.ID, nxt.ID),
					StageIndex:  stageIdx,
					FromRoundID: r.ID,
					ToRoundID:   nxt.ID,
					Mode:        "all_pilots",
					Count:       0,
				})
			}
		}
	}
	return out
}

func defaultRoundTitle(lane string, round int, col int) string {
	switch lane {
	case "handoff_out":
		return "Stage 2 Seeding"
	case "handoff_in":
		return "Qualifying Seeds"
	case "pilots_in":
		return "Checked-In Pilots"
	case "open_qual":
		return "Open Qualifier"
	case "qualifying":
		return fmt.Sprintf("Qualifying R%d", round)
	case "winners":
		return fmt.Sprintf("Winners R%d", round)
	case "losers":
		return fmt.Sprintf("Redemption R%d", round)
	case "mains":
		return fmt.Sprintf("Mains R%d", round)
	case "finals":
		return "Finals"
	default:
		return fmt.Sprintf("Round %d", col)
	}
}
