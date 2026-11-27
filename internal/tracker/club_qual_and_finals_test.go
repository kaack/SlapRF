package tracker

import (
	"testing"

	"slaprf/internal/domain"
)

func TestClubQualifyingAddRoundFixedLineupsAwayReseedAndFinalsStructure(t *testing.T) {
	e := NewRealEngine()

	created, err := e.EventAction(EventActionPayload{
		Action: "create_race",
		Name:   "Wednesday Club Whoops",
	})
	if err != nil {
		t.Fatalf("create_race: %v", err)
	}
	rid := created.RaceID

	// 1. Start with Qualifying + Chase the Ace (1 round initially, fixed VTX lineups)
	st, err := e.BracketEditAction(BracketEditPayload{
		Action:               "apply_template",
		RaceID:               rid,
		TemplateID:           "qual_chase_the_ace",
		PilotsPerHeat:        4,
		QualifyingRounds:     1,
		QualifyingLineupMode: domain.QualLineupFixed,
	})
	if err != nil {
		t.Fatalf("apply_template: %v", err)
	}
	if st.Heats[0].ShortLabel != "Q1-H1" || st.Heats[1].ShortLabel != "Q1-H2" {
		t.Fatalf("expected Q1-H1 and Q1-H2 short labels, got %q and %q", st.Heats[0].ShortLabel, st.Heats[1].ShortLabel)
	}

	// Snapshot Round 1 pilot -> (heatIdx, band, channel)
	type seatKey struct {
		heatIdx int
		band    domain.Band
		ch      uint8
	}
	r1SeatByPilot := make(map[int]seatKey)
	for hIdx := 0; hIdx < 2; hIdx++ {
		for _, s := range st.Heats[hIdx].Seats {
			if s.PilotSlotIndex > 0 {
				r1SeatByPilot[s.PilotSlotIndex] = seatKey{heatIdx: hIdx, band: s.Band, ch: s.Channel}
			}
		}
	}

	// Run & confirm Round 1 heats (Q1-1 and Q1-2)
	if _, err := e.EventAction(EventActionPayload{Action: "race_lifecycle", RaceID: rid, LifecycleAction: "start_race"}); err != nil {
		t.Fatalf("start_race: %v", err)
	}
	for _, hid := range []string{"Q1-1", "Q1-2"} {
		if _, err := e.RaceControlAction("start", hid); err != nil {
			t.Fatalf("start %s: %v", hid, err)
		}
		cur := e.RaceSnapshot()
		var targetHeat domain.RaceHeat
		for _, h := range cur.Heats {
			if h.ID == hid {
				targetHeat = h
			}
		}
		for _, s := range targetHeat.Seats {
			if s.PilotSlotIndex <= 0 {
				continue
			}
			// Give lower slotIndex faster laps so standings order is deterministic 1..8
			for lap := 0; lap < 4; lap++ {
				if _, err := e.MarshalPilotAction(RaceMarshalPayload{
					HeatID:         hid,
					PilotSlotIndex: s.PilotSlotIndex,
					Action:         "add_lap",
				}); err != nil {
					t.Fatalf("add_lap %s pilot %d: %v", hid, s.PilotSlotIndex, err)
				}
			}
		}
		if _, err := e.RaceControlAction("stop", hid); err != nil {
			t.Fatalf("stop %s: %v", hid, err)
		}
		if _, err := e.RaceControlAction("confirm", hid); err != nil {
			t.Fatalf("confirm %s: %v", hid, err)
		}
	}

	// 2. Append Round 2 on demand via `add_qualifying_round` (`fixed` mode) AFTER Round 1 completed!
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:               "add_qualifying_round",
		RaceID:               rid,
		QualifyingLineupMode: domain.QualLineupFixed,
	})
	if err != nil {
		t.Fatalf("add_qualifying_round: %v", err)
	}
	var q2Heats []domain.RaceHeat
	for _, h := range st.Heats {
		if h.StageFormat == domain.FormatQualifying && h.Round == 2 {
			q2Heats = append(q2Heats, h)
		}
	}
	if len(q2Heats) != 2 || q2Heats[0].ShortLabel != "Q2-H1" || q2Heats[1].ShortLabel != "Q2-H2" {
		t.Fatalf("expected Q2-H1 and Q2-H2 added, got %+v", q2Heats)
	}
	for hIdx, h := range q2Heats {
		for _, s := range h.Seats {
			if s.PilotSlotIndex <= 0 {
				continue
			}
			want := r1SeatByPilot[s.PilotSlotIndex]
			if want.heatIdx != hIdx || want.band != s.Band || want.ch != s.Channel {
				t.Fatalf("pilot %d moved from R1 (%+v) to R2 heat %d %v%d", s.PilotSlotIndex, want, hIdx, s.Band, s.Channel)
			}
		}
	}

	// Run & confirm Round 2 so Qualifying is complete and CTA-1 is seeded with Top 4
	for _, h := range q2Heats {
		if _, err := e.RaceControlAction("start", h.ID); err != nil {
			t.Fatalf("start %s: %v", h.ID, err)
		}
		if _, err := e.RaceControlAction("stop", h.ID); err != nil {
			t.Fatalf("stop %s: %v", h.ID, err)
		}
		st, err = e.RaceControlAction("confirm", h.ID)
		if err != nil {
			t.Fatalf("confirm %s: %v", h.ID, err)
		}
	}

	var ctaHeat *domain.RaceHeat
	for i := range st.Heats {
		if st.Heats[i].ID == "CTA-1" {
			ctaHeat = &st.Heats[i]
		}
	}
	if ctaHeat == nil || ctaHeat.ShortLabel != "CTA-G1" {
		t.Fatalf("expected CTA-1 with ShortLabel=CTA-G1, got %+v", ctaHeat)
	}
	origSeed2Pilot := ctaHeat.Seats[1].PilotSlotIndex
	if origSeed2Pilot <= 0 {
		t.Fatalf("expected Seed #2 seated in CTA-G1, got %+v", ctaHeat.Seats)
	}

	// 3. Mark Seed #2 `away` (left early before Finals) -> active qualifiers shift up so all 4 Finals seats stay staged!
	st, err = e.EventAction(EventActionPayload{
		Action:     "update_attendance",
		RaceID:     rid,
		SlotIndex:  origSeed2Pilot,
		Attendance: domain.AttendanceAway,
	})
	if err != nil {
		t.Fatalf("set_attendance away: %v", err)
	}
	for i := range st.Heats {
		if st.Heats[i].ID == "CTA-1" {
			ctaHeat = &st.Heats[i]
		}
	}
	for si, s := range ctaHeat.Seats {
		if s.PilotSlotIndex == origSeed2Pilot {
			t.Fatalf("expected departed pilot %d removed from unstarted CTA-G1 seat %d", origSeed2Pilot, si+1)
		}
		if s.PilotSlotIndex <= 0 || s.Status != domain.PilotHeatStaged {
			t.Fatalf("expected CTA-G1 seat %d filled & staged by promoted qualifier, got %+v", si+1, s)
		}
	}

	// Restore pilot active, then switch Finals structure to `qual_ladder_mains` (All Pilots · Bump-Up Mains) WITHOUT losing Q1 & Q2!
	_, _ = e.EventAction(EventActionPayload{
		Action:     "update_attendance",
		RaceID:     rid,
		SlotIndex:  origSeed2Pilot,
		Attendance: domain.AttendanceActive,
	})
	st, err = e.BracketEditAction(BracketEditPayload{
		Action:       "set_finals_structure",
		RaceID:       rid,
		TemplateID:   "qual_ladder_mains",
		FinalsFormat: domain.FinalsChaseTheAce,
	})
	if err != nil {
		t.Fatalf("set_finals_structure qual_ladder_mains: %v", err)
	}
	confirmedQualCount := 0
	hasBMain := false
	hasAMainCTA := false
	for _, h := range st.Heats {
		if h.StageFormat == domain.FormatQualifying && h.State == domain.HeatConfirmed {
			confirmedQualCount++
		}
		if h.ShortLabel == "B-H1" {
			hasBMain = true
		}
		if h.ShortLabel == "CTA-G1" {
			hasAMainCTA = true
		}
	}
	if confirmedQualCount != 4 || !hasBMain || !hasAMainCTA {
		t.Fatalf("expected 4 confirmed qualifying heats preserved + B-H1 + CTA-G1, got confirmedQual=%d hasBMain=%v hasAMainCTA=%v", confirmedQualCount, hasBMain, hasAMainCTA)
	}
}

func TestLegacyShortLabelRestoreAndRaceSettingsWhilePracticeActive(t *testing.T) {
	e := NewRealEngine()

	// 1. Create a race, apply template, corrupt ShortLabel back to legacy "Q1-1"/"CTA-1", and RestoreState
	r1, err := e.EventAction(EventActionPayload{Action: "create_race", Name: "Legacy Label Race"})
	if err != nil {
		t.Fatalf("create_race: %v", err)
	}
	_, _ = e.EventAction(EventActionPayload{Action: "check_in_all", RaceID: r1.RaceID})
	_, err = e.BracketEditAction(BracketEditPayload{
		Action:        "apply_template",
		RaceID:        r1.RaceID,
		TemplateID:    "qual_chase_the_ace",
		PilotsPerHeat: 4,
	})
	if err != nil {
		t.Fatalf("apply_template: %v", err)
	}
	snap := e.ExportState()
	for ri := range snap.EventState.Races {
		for hi := range snap.EventState.Races[ri].Heats {
			h := &snap.EventState.Races[ri].Heats[hi]
			h.ShortLabel = h.ID
		}
	}
	for hi := range snap.RaceState.Heats {
		snap.RaceState.Heats[hi].ShortLabel = snap.RaceState.Heats[hi].ID
	}

	e2 := NewRealEngine()
	e2.RestoreState(snap, true)
	for _, h := range e2.RaceSnapshot().Heats {
		if h.ID == "Q1-1" && h.ShortLabel != "Q1-H1" {
			t.Fatalf("expected restored Q1-1 ShortLabel upgraded to Q1-H1, got %q", h.ShortLabel)
		}
		if h.ID == "CTA-1" && h.ShortLabel != "CTA-G1" {
			t.Fatalf("expected restored CTA-1 ShortLabel upgraded to CTA-G1, got %q", h.ShortLabel)
		}
	}

	// 2. Start an active Practice session and verify Race Settings & Reopen work without stopping Practice!
	ps, err := e2.PracticeAction(PracticeActionPayload{Action: "create_session", Name: "Warmup Packs"})
	if err != nil {
		t.Fatalf("create_session: %v", err)
	}
	sessID := ps.SelectedSessionID
	ps, err = e2.PracticeAction(PracticeActionPayload{Action: "start_session", SessionID: sessID, PreemptOngoing: true})
	if err != nil {
		t.Fatalf("start_session: %v", err)
	}
	if ps.ActiveSessionID != sessID {
		t.Fatalf("expected practice session %s active", sessID)
	}

	// Update Race Settings (targetLaps=5, countdownSec=3) while Practice is active -> syncs into EventState.Races cleanly!
	nextCfg := e2.RaceSnapshot().Config
	nextCfg.TargetLaps = 5
	nextCfg.CountdownSec = 3
	updatedRace := e2.ConfigureAndGenerateRaceForID(r1.RaceID, nextCfg, false, true)
	if updatedRace.Config.TargetLaps != 5 || updatedRace.Config.CountdownSec != 3 {
		t.Fatalf("expected updated race config persisted, got %+v", updatedRace.Config)
	}
	foundInEvent := false
	for _, er := range e2.EventSnapshot().Races {
		if er.RaceID == r1.RaceID {
			foundInEvent = true
			if er.Config.TargetLaps != 5 || er.Config.CountdownSec != 3 {
				t.Fatalf("expected EventState.Races synced with updated config, got %+v", er.Config)
			}
		}
	}
	if !foundInEvent {
		t.Fatalf("expected race %s in EventState.Races", r1.RaceID)
	}
	if e2.PracticeSnapshot().ActiveSessionID != sessID {
		t.Fatalf("expected practice session still active after editing race settings")
	}
}
