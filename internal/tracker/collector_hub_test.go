package tracker

import (
	"testing"

	"slaprf/internal/domain"
)

// The real-hardware Hub is a USB collector dongle: it is registered as a timer (ID 1) but never
// tied to a gate, and Spokes take the gates, the first one becoming start/finish.
func TestCollectorHubNeverHoldsAGate(t *testing.T) {
	e := NewRealEngine()

	hubID, err := e.RegisterTimerHello("A0767469", true, domain.DefaultFirmwareProfile, "H1")
	if err != nil {
		t.Fatalf("register hub: %v", err)
	}
	if hubID != 1 {
		t.Fatalf("hub timer ID = %d, want 1", hubID)
	}
	_, gates, _, _, _ := e.StateSnapshot()
	if len(gates) != 0 {
		t.Fatalf("hub created %d gate(s), want 0", len(gates))
	}

	s1, err := e.RegisterTimerHello("DA9B4CA7", false, domain.DefaultFirmwareProfile, "S1")
	if err != nil {
		t.Fatalf("register spoke 1: %v", err)
	}
	s2, err := e.RegisterTimerHello("11223344", false, domain.DefaultFirmwareProfile, "S2")
	if err != nil {
		t.Fatalf("register spoke 2: %v", err)
	}
	if s1 == 1 || s2 == 1 || s1 == s2 {
		t.Fatalf("spoke IDs %d, %d must be distinct and never the hub's ID 1", s1, s2)
	}

	_, gates, _, _, _ = e.StateSnapshot()
	if len(gates) != 2 {
		t.Fatalf("got %d gates, want 2 (one per spoke)", len(gates))
	}
	starts := 0
	for _, g := range gates {
		if g.AssignedTimerID == hubID {
			t.Fatalf("gate %d is tied to the hub", g.GateID)
		}
		if g.Role == domain.GateRoleStartFinish {
			starts++
			if g.AssignedTimerID != s1 {
				t.Fatalf("start/finish gate tied to timer %d, want first spoke %d", g.AssignedTimerID, s1)
			}
		}
	}
	if starts != 1 {
		t.Fatalf("got %d start/finish gates, want 1", starts)
	}

	// Re-announcing the hub (periodic HELLO) keeps it gate-less and on ID 1.
	again, err := e.RegisterTimerHello("A0767469", true, domain.DefaultFirmwareProfile, "H1")
	if err != nil || again != hubID {
		t.Fatalf("re-register hub: id=%d err=%v", again, err)
	}
	_, gates, _, _, _ = e.StateSnapshot()
	for _, g := range gates {
		if g.AssignedTimerID == hubID {
			t.Fatalf("hub re-announce tied it to gate %d", g.GateID)
		}
	}
}

// The simulator keeps the classic model where the simulated Hub times the start/finish gate.
func TestSimulatorHubStillTimesAGate(t *testing.T) {
	e := NewEngine()
	if e.hubIsCollector {
		t.Fatal("simulator engine must not use the collector-hub model")
	}
}
