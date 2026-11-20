package tracker

import (
	"testing"

	"slaprf/internal/domain"
)

func f64(v float64) *float64 { return &v }

// Every gate applies the minimum lap time as if it were the start gate.
func TestMinimumLapAppliesAtEveryGate(t *testing.T) {
	r := newRig(t)
	r.pass(1, 10)
	r.pass(2, 13)
	r.pass(3, 14.5)
	// Back at G2 4.6 s after it last timed this pilot: past the 2 s cool-down and the 3 s
	// echo window after G3, but nobody laps in 4.6 s.
	r.expectFiltered(r.pass(2, 17.6), domain.FilterMinLap)
}

func TestGateOverrideOnlyAffectsThatGate(t *testing.T) {
	r := newRig(t)
	if _, err := r.e.SetGateRules(2, domain.GateRuleOverrides{GateCooldownSec: f64(6), MinLapSec: f64(6)}); err != nil {
		t.Fatal(err)
	}
	r.pass(1, 10)
	r.pass(2, 13)
	// 5 s later at G2: inside G2's own 6 s cool-down.
	r.expectFiltered(r.pass(2, 18), domain.FilterCooldown)

	// G3 still uses the global 2 s cool-down.
	r.pass(3, 21)
	r.expectFiltered(r.pass(3, 22), domain.FilterCooldown)
	r.expectFiltered(r.pass(3, 24), domain.FilterMinLap) // 3 s: past cool-down, under min lap
}

func TestGateOverrideMinSectionUsesArrivingGate(t *testing.T) {
	r := newRig(t)
	// G2 sits right after a tight turn: nobody reaches it in under 2 s.
	if _, err := r.e.SetGateRules(2, domain.GateRuleOverrides{MinSectionSec: f64(2)}); err != nil {
		t.Fatal(err)
	}
	r.pass(1, 10)
	r.expectFiltered(r.pass(2, 11.5), domain.FilterTooSoon)
	r.expectAccepted(r.pass(2, 12.5))
}

func TestGateRuleOverridesAreClampedAndClearable(t *testing.T) {
	e := NewEngine()
	got, err := e.SetGateRules(3, domain.GateRuleOverrides{EchoWindowSec: f64(99)})
	if err != nil {
		t.Fatal(err)
	}
	if got.EchoWindowSec == nil || *got.EchoWindowSec != 15 {
		t.Fatalf("expected echo window clamped to 15, got %v", got.EchoWindowSec)
	}
	if _, err := e.SetGateRules(3, domain.GateRuleOverrides{}); err != nil {
		t.Fatal(err)
	}
	if o := gateByID(t, e, 3).RuleOverrides; o.EchoWindowSec != nil {
		t.Fatal("overrides should be cleared")
	}
	if _, err := e.SetGateRules(42, domain.GateRuleOverrides{}); err != ErrUnknownGate {
		t.Fatalf("expected ErrUnknownGate, got %v", err)
	}
}

func feedSingleGatePassAt(t *testing.T, e *Engine, timerID uint8, slotIndex int, startSec float64, peakDbm float32) {
	t.Helper()
	pilotIdx := -1
	for i, p := range e.pilots {
		if p.SlotIndex == slotIndex {
			pilotIdx = i
			break
		}
	}
	if pilotIdx < 0 {
		t.Fatalf("slotIndex %d not found", slotIndex)
	}
	baseUs := uint64(startSec * 1e6)
	span := peakDbm + 88.0
	samples := []struct {
		dtUs uint64
		rssi float32
	}{
		{0, -88},
		{20_000, -88},
		{40_000, -88 + span*0.25},
		{60_000, -88 + span*0.50},
		{80_000, -88 + span*0.72},
		{100_000, peakDbm - 4},
		{120_000, peakDbm - 2},
		{140_000, peakDbm - 0.5},
		{160_000, peakDbm},
		{180_000, peakDbm - 0.5},
		{200_000, peakDbm - 2},
		{220_000, peakDbm - 4},
		{240_000, -88 + span*0.72},
		{260_000, -88 + span*0.50},
		{280_000, -88 + span*0.25},
		{300_000, -88},
		{320_000, -88},
		{340_000, -88},
		{360_000, -88},
		{380_000, -88},
		{400_000, -88},
		{420_000, -88},
	}
	for _, s := range samples {
		var frame domain.TimerTelemetryFrame
		frame.TimerID = timerID
		frame.TimestampUs = baseUs + s.dtUs
		for k := range frame.RSSI {
			frame.RSSI[k] = -90
		}
		frame.RSSI[pilotIdx] = s.rssi
		e.IngestTelemetryFrame(frame)
	}
}

func TestThreeTierHierarchyAndOptInRetroactivePracticeReplay(t *testing.T) {
	e := NewEngine()
	sfTimerID := e.gates[0].AssignedTimerID // Gate 1 (Start/Finish)

	// Gate 1 timer-level override (Tier 2: all pilots at Gate 1 require minLapSec = 8.0, maxLapSec = 45.0).
	if _, err := e.SetGateRules(1, domain.GateRuleOverrides{
		MinLapSec: f64(8.0),
		MaxLapSec: f64(45.0),
	}); err != nil {
		t.Fatal(err)
	}
	// Pilot 2 per-pilot override at Gate 1 (Tier 3: Pilot 2 is faster and allowed 3.5 s laps).
	if _, err := e.SetPilotGateRules(1, 2, domain.GateRuleOverrides{
		MinLapSec: f64(3.5),
	}); err != nil {
		t.Fatal(err)
	}

	// Both Pilot 1 and Pilot 2 pass Gate 1 with a 4.5 s lap interval (monotonically increasing timestamps).
	feedSingleGatePassAt(t, e, sfTimerID, 1, 10.0, -42)
	feedSingleGatePassAt(t, e, sfTimerID, 2, 10.5, -42)
	feedSingleGatePassAt(t, e, sfTimerID, 1, 14.5, -42) // Rejected for Pilot 1 (4.5s < 8.0s Gate 1 rule)
	feedSingleGatePassAt(t, e, sfTimerID, 2, 15.0, -42) // Accepted for Pilot 2 (4.5s >= 3.5s Pilot 2 override)

	ps := e.PracticeSnapshot()
	if len(ps.Sessions) == 0 {
		t.Fatal("expected active practice session")
	}
	countLaps := func(slot int) int {
		n := 0
		for _, l := range e.PracticeSnapshot().Sessions[0].Laps {
			if l.SlotIndex == slot && !l.Invalidated {
				n++
			}
		}
		return n
	}
	if got := countLaps(1); got != 0 {
		t.Fatalf("Pilot 1 should have 0 laps under Gate 1 8.0s minLap, got %d", got)
	}
	if got := countLaps(2); got != 1 {
		t.Fatalf("Pilot 2 should have 1 lap under per-pilot 3.5s override, got %d", got)
	}

	// Lower Pilot 1's minLapSec at Gate 1 to 4.0s WITHOUT retroactive replay (default going-forward mode).
	if _, err := e.SetPilotGateRules(1, 1, domain.GateRuleOverrides{MinLapSec: f64(4.0)}); err != nil {
		t.Fatal(err)
	}
	if got := countLaps(1); got != 0 {
		t.Fatalf("going-forward mode must not rewrite already-recorded practice laps, got %d", got)
	}

	// Now opt into retroactive replay: Pilot 1's buffered 4.5s pass at t = 14.5s becomes a counted lap!
	if !e.RecalculateBufferedPractice() {
		t.Fatal("expected RecalculateBufferedPractice to replay buffered frames")
	}
	if got := countLaps(1); got != 1 {
		t.Fatalf("retroactive replay should recover Pilot 1's 4.5s lap, got %d", got)
	}

	// Also feed a weak -62 dBm pass at t = 20.0s (missed under default -58 dBm enter threshold),
	// then lower Pilot 1's Gate 1 enter threshold to -66 dBm and replay retroactively.
	feedSingleGatePassAt(t, e, sfTimerID, 1, 20.0, -62)
	if got := countLaps(1); got != 1 {
		t.Fatalf("weak -62 dBm pass should initially miss -58 dBm threshold, got %d laps", got)
	}
	if err := e.SetGateThresholds([]domain.GateThresholdUpdate{{
		GateID:    1,
		SlotIndex: 1,
		EnterDbm:  -66,
		ExitDbm:   -74,
	}}); err != nil {
		t.Fatal(err)
	}
	if got := countLaps(1); got != 1 {
		t.Fatalf("SetGateThresholds without retroactive opt-in must leave recorded laps at 1, got %d", got)
	}
	e.RecalculateBufferedPractice()
	if got := countLaps(1); got != 2 {
		t.Fatalf("retroactive threshold replay should recover Pilot 1's second lap at 20.0s, got %d", got)
	}

	// Verify Race mode never allows retroactive replay to run.
	e.mu.Lock()
	e.raceState.Mode = domain.ModeRace
	e.mu.Unlock()
	if e.RecalculateBufferedPractice() {
		t.Fatal("RecalculateBufferedPractice must be a no-op during Race mode")
	}
}
