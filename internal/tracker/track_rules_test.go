package tracker

import (
	"encoding/json"
	"testing"

	"slaprf/internal/domain"
)

func f64(v float64) *float64 { return &v }
func bPtr(v bool) *bool      { return &v }

// Every gate applies the minimum lap time independently as if it were the start gate.
func TestMinimumLapAppliesAtEveryGate(t *testing.T) {
	r := newRig(t)
	r.pass(1, 10)
	r.pass(2, 13)
	r.pass(3, 14.5)
	// Back at G2 4.6 s after it last timed this pilot: under the 5 s minimum lap time.
	r.expectFiltered(r.pass(2, 17.6), domain.FilterMinLap)
}

func TestGateOverrideOnlyAffectsThatGate(t *testing.T) {
	r := newRig(t)
	if _, err := r.e.SetGateRules(2, domain.GateRuleOverrides{MinLapSec: f64(7), MinCrossingSec: f64(0.20)}); err != nil {
		t.Fatal(err)
	}
	r.pass(1, 10)
	// 150 ms pass at G2: rejected by G2's 200 ms minimum crossing time override.
	r.expectFiltered(r.passWithHold(2, 12.5, 150, 3.5), domain.FilterSpike)
	// 240 ms pass at G2: accepted.
	r.expectAccepted(r.passWithHold(2, 13.0, 240, 4.5))
	// 6 s later at G2: inside G2's own 7 s minimum lap time.
	r.expectFiltered(r.pass(2, 19.0), domain.FilterMinLap)

	// G3 still uses the global 5 s minimum lap time and 120 ms minimum crossing time.
	r.expectAccepted(r.passWithHold(3, 21.0, 150, 3.5))
	r.expectFiltered(r.pass(3, 24.0), domain.FilterMinLap)
	r.expectAccepted(r.pass(3, 26.5))
}

func TestGateRuleOverridesAreClampedLegacyMigratedAndClearable(t *testing.T) {
	e := NewEngine()
	got, err := e.SetGateRules(3, domain.GateRuleOverrides{MinCrossingSec: f64(99)})
	if err != nil {
		t.Fatal(err)
	}
	if got.MinCrossingSec == nil || *got.MinCrossingSec != 1.5 {
		t.Fatalf("expected min crossing time clamped to 1.5, got %v", got.MinCrossingSec)
	}
	if _, err := e.SetGateRules(3, domain.GateRuleOverrides{}); err != nil {
		t.Fatal(err)
	}
	if o := gateByID(t, e, 3).RuleOverrides; !o.IsEmpty() {
		t.Fatal("overrides should be cleared")
	}
	if _, err := e.SetGateRules(42, domain.GateRuleOverrides{}); err != ErrUnknownGate {
		t.Fatalf("expected ErrUnknownGate, got %v", err)
	}

	// Verify legacy `minPassHoldSec` JSON unmarshaling migrates cleanly to `MinCrossingSec`.
	var legacyRules domain.TimingRules
	if err := json.Unmarshal([]byte(`{"minLapSec":6,"maxLapSec":90,"minPassHoldSec":0.18}`), &legacyRules); err != nil {
		t.Fatal(err)
	}
	if legacyRules.MinCrossingSec != 0.18 {
		t.Fatalf("expected legacy minPassHoldSec 0.18 migrated to MinCrossingSec, got %v", legacyRules.MinCrossingSec)
	}
	var legacyOvr domain.GateRuleOverrides
	if err := json.Unmarshal([]byte(`{"minPassHoldSec":0.22}`), &legacyOvr); err != nil {
		t.Fatal(err)
	}
	if legacyOvr.MinCrossingSec == nil || *legacyOvr.MinCrossingSec != 0.22 {
		t.Fatalf("expected legacy override minPassHoldSec 0.22 migrated to MinCrossingSec, got %v", legacyOvr.MinCrossingSec)
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

func TestThreeTierHierarchyAppliesGoingForward(t *testing.T) {
	e := NewEngine()
	sfTimerID := e.gates[0].AssignedTimerID // Gate 1 (Start/Finish)

	// Gate 1 timer-level override (Tier 2: all pilots at Gate 1 require minLapSec = 8.0, maxLapSec = 45.0, beepOnCross = true).
	if _, err := e.SetGateRules(1, domain.GateRuleOverrides{
		MinLapSec:   f64(8.0),
		MaxLapSec:   f64(45.0),
		BeepOnCross: bPtr(true),
	}); err != nil {
		t.Fatal(err)
	}
	// Pilot 2 per-pilot override at Gate 1 (Tier 3: Pilot 2 is faster and allowed 3.5 s laps, beepOnCross = false).
	if _, err := e.SetPilotGateRules(1, 2, domain.GateRuleOverrides{
		MinLapSec:   f64(3.5),
		BeepOnCross: bPtr(false),
	}); err != nil {
		t.Fatal(err)
	}

	g1 := gateByID(t, e, 1)
	if !g1.RulesForPilot(e.Rules(), 1).BeepOnCross {
		t.Fatal("expected Pilot 1 to inherit Gate 1 BeepOnCross = true")
	}
	if g1.RulesForPilot(e.Rules(), 2).BeepOnCross {
		t.Fatal("expected Pilot 2 override BeepOnCross = false")
	}

	// Both Pilot 1 and Pilot 2 pass Gate 1 with a 4.5 s lap interval.
	feedSingleGatePassAt(t, e, sfTimerID, 1, 10.0, -42)
	feedSingleGatePassAt(t, e, sfTimerID, 2, 10.5, -42)
	feedSingleGatePassAt(t, e, sfTimerID, 1, 14.5, -42) // Rejected for Pilot 1 (4.5s < 8.0s Gate 1 rule)
	feedSingleGatePassAt(t, e, sfTimerID, 2, 15.0, -42) // Accepted for Pilot 2 (4.5s >= 3.5s Pilot 2 override)

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

	// Lower Pilot 1's minLapSec at Gate 1 to 4.0s: applies going forward without rewriting past passes,
	// and scores the next 4.5s lap cleanly.
	if _, err := e.SetPilotGateRules(1, 1, domain.GateRuleOverrides{MinLapSec: f64(4.0)}); err != nil {
		t.Fatal(err)
	}
	if got := countLaps(1); got != 0 {
		t.Fatalf("rule edits must not rewrite already-recorded laps, got %d", got)
	}
	feedSingleGatePassAt(t, e, sfTimerID, 1, 19.0, -42) // 9.0s since initial t=10.0s start -> counted!
	feedSingleGatePassAt(t, e, sfTimerID, 1, 23.5, -42) // 4.5s since t=19.0s -> counted under new 4.0s rule!
	if got := countLaps(1); got != 2 {
		t.Fatalf("expected Pilot 1 to score 2 upcoming laps after lowering minLapSec to 4.0s, got %d", got)
	}
}

func TestParentAgreementAutoCollapsesChildRuleOverrides(t *testing.T) {
	e := NewEngine()
	ps := e.PracticeSnapshot()
	sid := ps.Sessions[0].SessionID

	// 1. Set All Timers BeepOnCross = true, MinLapSec = 6.0
	rOn := domain.DefaultTimingRules()
	rOn.BeepOnCross = true
	rOn.MinLapSec = 6.0
	if _, err := e.SetPracticeRules(sid, rOn); err != nil {
		t.Fatalf("SetPracticeRules(ON) failed: %v", err)
	}

	// 2. Override Gate 1 (H1) to BeepOnCross = false and MinLapSec = 8.0
	ovr, err := e.SetPracticeGateRules(sid, 1, domain.GateRuleOverrides{
		BeepOnCross: bPtr(false),
		MinLapSec:   f64(8.0),
	})
	if err != nil {
		t.Fatalf("SetPracticeGateRules failed: %v", err)
	}
	if ovr.BeepOnCross == nil || *ovr.BeepOnCross != false || ovr.MinLapSec == nil || *ovr.MinLapSec != 8.0 {
		t.Fatalf("expected diverging Gate 1 overrides preserved, got %+v", ovr)
	}

	// 3. Turn All Timers BeepOnCross = false globally -> Gate 1 now agrees with All Timers on BeepOnCross,
	// so Gate 1's BeepOnCross override MUST auto-collapse to nil (while MinLapSec = 8.0 remains overridden).
	rOff := rOn
	rOff.BeepOnCross = false
	if _, err := e.SetPracticeRules(sid, rOff); err != nil {
		t.Fatalf("SetPracticeRules(OFF) failed: %v", err)
	}
	afterGlobalOff, err := e.PracticeGateRules(sid, 1)
	if err != nil {
		t.Fatalf("PracticeGateRules failed: %v", err)
	}
	if afterGlobalOff.BeepOnCross != nil {
		t.Fatalf("expected Gate 1 BeepOnCross override collapsed to nil when All Timers became false, got %v", *afterGlobalOff.BeepOnCross)
	}
	if afterGlobalOff.MinLapSec == nil || *afterGlobalOff.MinLapSec != 8.0 {
		t.Fatalf("expected Gate 1 MinLapSec = 8.0 override retained, got %+v", afterGlobalOff)
	}

	// 4. Turn All Timers BeepOnCross = true again -> Gate 1 now inherits BeepOnCross = true cleanly!
	if _, err := e.SetPracticeRules(sid, rOn); err != nil {
		t.Fatalf("SetPracticeRules(ON again) failed: %v", err)
	}
	gates, _, rules, err := e.PracticeTrackSnapshot(sid)
	if err != nil {
		t.Fatalf("PracticeTrackSnapshot failed: %v", err)
	}
	if !rules.ForGate(gates[0].RuleOverrides).BeepOnCross {
		t.Fatalf("expected Gate 1 to inherit BeepOnCross = true after prior override auto-collapsed")
	}

	// 5. Setting Gate 1 MinLapSec back to 6.0 (matching All Timers) collapses Gate 1 overrides to IsEmpty()
	collapsed, err := e.SetPracticeGateRules(sid, 1, domain.GateRuleOverrides{MinLapSec: f64(6.0)})
	if err != nil {
		t.Fatalf("SetPracticeRules(matching parent) failed: %v", err)
	}
	if !collapsed.IsEmpty() {
		t.Fatalf("expected Gate 1 overrides completely empty when matching parent, got %+v", collapsed)
	}

	// 6. Multi-state BeepMode ("off" | "enter" | "peak" | "exit"): overriding Gate 1 to "enter" while All Timers is "peak"
	// preserves the "enter" override, then switching All Timers to "enter" auto-collapses Gate 1's override.
	rPeak := domain.DefaultTimingRules()
	rPeak.BeepMode = domain.BeepModePeak
	rPeak.BeepOnCross = true
	if _, err := e.SetPracticeRules(sid, rPeak); err != nil {
		t.Fatalf("SetPracticeRules(PEAK) failed: %v", err)
	}
	enterMode := domain.BeepModeEnter
	ovrEnter, err := e.SetPracticeGateRules(sid, 1, domain.GateRuleOverrides{BeepMode: &enterMode})
	if err != nil {
		t.Fatalf("SetPracticeGateRules(ENTER) failed: %v", err)
	}
	if ovrEnter.BeepMode == nil || *ovrEnter.BeepMode != domain.BeepModeEnter {
		t.Fatalf("expected Gate 1 BeepMode='enter' override preserved against 'peak' parent, got %+v", ovrEnter)
	}
	rEnter := domain.DefaultTimingRules()
	rEnter.BeepMode = domain.BeepModeEnter
	rEnter.BeepOnCross = true
	if _, err := e.SetPracticeRules(sid, rEnter); err != nil {
		t.Fatalf("SetPracticeRules(ENTER) failed: %v", err)
	}
	afterGlobalEnter, err := e.PracticeGateRules(sid, 1)
	if err != nil {
		t.Fatalf("PracticeGateRules failed: %v", err)
	}
	if afterGlobalEnter.BeepMode != nil || afterGlobalEnter.BeepOnCross != nil {
		t.Fatalf("expected Gate 1 BeepMode override auto-collapsed when All Timers became 'enter', got %+v", afterGlobalEnter)
	}
}
