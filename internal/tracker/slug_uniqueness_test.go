package tracker

import (
	"testing"

	"slaprf/internal/domain"
)

func TestSlugifyRaceAndPracticeNames(t *testing.T) {
	raceCases := []struct {
		in   string
		want string
	}{
		{"Friday Qualifier #2", "friday-qualifier-2"},
		{"Race 1 · Open Class", "race-1-open-class"},
		{"Pro & Am Finals", "pro-and-am-finals"},
		{"   ---   ", "race"},
		{"Format", "format-race"},
		{"Control", "control-race"},
		{"Stage 1", "stage-1-race"},
		{"directory", "directory-race"},
		{"Session 1", "session-1"},
	}
	for _, tc := range raceCases {
		if got := domain.SlugifyRaceName(tc.in); got != tc.want {
			t.Fatalf("SlugifyRaceName(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}

	pracCases := []struct {
		in   string
		want string
	}{
		{"Session 1", "session-1"},
		{"Morning Warm-Up & Tune", "morning-warm-up-and-tune"},
		{"Session", "session-practice"},
		{"Directory", "directory-practice"},
		{"", "practice"},
	}
	for _, tc := range pracCases {
		if got := domain.SlugifyPracticeName(tc.in); got != tc.want {
			t.Fatalf("SlugifyPracticeName(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestRaceAndPracticeSlugUniquenessAndDisambiguation(t *testing.T) {
	e := NewEngine()

	// 1. Explicit race creation with colliding slug fails
	r1, err := e.EventAction(EventActionPayload{
		Action: "create_race",
		Name:   "Friday Qualifier",
	})
	if err != nil {
		t.Fatalf("create Friday Qualifier failed: %v", err)
	}
	if _, err := e.EventAction(EventActionPayload{
		Action: "create_race",
		Name:   "friday-qualifier!",
	}); err == nil {
		t.Fatalf("expected duplicate race slug creation to fail")
	}

	// 2. Second valid race + rename collision guard
	r2, err := e.EventAction(EventActionPayload{
		Action: "create_race",
		Name:   "Saturday Mains",
	})
	if err != nil {
		t.Fatalf("create Saturday Mains failed: %v", err)
	}
	if _, err := e.EventAction(EventActionPayload{
		Action: "rename_race",
		RaceID: r2.RaceID,
		Name:   "FRIDAY   QUALIFIER",
	}); err == nil {
		t.Fatalf("expected colliding rename_race to fail")
	}

	// Same-race casing tweak (same RaceID) is allowed!
	if _, err := e.EventAction(EventActionPayload{
		Action: "rename_race",
		RaceID: r1.RaceID,
		Name:   "Friday Qualifier!",
	}); err != nil {
		t.Fatalf("expected renaming race to same slug on itself to succeed, got %v", err)
	}

	// 3. Practice session creation & rename collision guard
	if _, err := e.PracticeAction(PracticeActionPayload{
		Action: "create_session",
		Name:   "Evening Pack 1",
	}); err != nil {
		t.Fatalf("create Evening Pack 1 failed: %v", err)
	}
	if _, err := e.PracticeAction(PracticeActionPayload{
		Action: "create_session",
		Name:   "evening-pack-1",
	}); err == nil {
		t.Fatalf("expected duplicate practice session slug creation to fail")
	}
	ps, err := e.PracticeAction(PracticeActionPayload{
		Action: "create_session",
		Name:   "Evening Pack 2",
	})
	if err != nil {
		t.Fatalf("create Evening Pack 2 failed: %v", err)
	}
	var pack2ID string
	for _, s := range ps.Sessions {
		if s.Name == "Evening Pack 2" {
			pack2ID = s.SessionID
		}
	}
	if _, err := e.PracticeAction(PracticeActionPayload{
		Action:    "rename_session",
		SessionID: pack2ID,
		Name:      "Evening Pack 1",
	}); err == nil {
		t.Fatalf("expected colliding rename_session to fail")
	}

	// 4. Legacy RestoreState duplicate disambiguation
	exported := e.ExportState()
	if len(exported.EventState.Races) >= 2 {
		exported.EventState.Races[0].Config.EventName = "Club Race"
		exported.EventState.Races[1].Config.EventName = "club-race"
	}
	if len(exported.PracticeState.Sessions) >= 2 {
		exported.PracticeState.Sessions[0].Name = "Open Track"
		exported.PracticeState.Sessions[1].Name = "open-track"
	}

	e2 := NewEngine()
	e2.RestoreState(exported, true)

	evSnap := e2.EventSnapshot()
	if evSnap.Races[0].Config.EventName != "Club Race" || evSnap.Races[1].Config.EventName != "club-race (2)" {
		t.Fatalf("expected legacy duplicate races to disambiguate cleanly, got %q and %q",
			evSnap.Races[0].Config.EventName, evSnap.Races[1].Config.EventName)
	}

	pSnap := e2.PracticeSnapshot()
	if pSnap.Sessions[0].Name != "Open Track" || pSnap.Sessions[1].Name != "open-track (2)" {
		t.Fatalf("expected legacy duplicate practice sessions to disambiguate cleanly, got %q and %q",
			pSnap.Sessions[0].Name, pSnap.Sessions[1].Name)
	}
}
