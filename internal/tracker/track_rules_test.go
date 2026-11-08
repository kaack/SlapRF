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
