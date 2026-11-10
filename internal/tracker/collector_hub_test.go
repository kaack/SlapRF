package tracker

import (
	"testing"

	"slaprf/internal/domain"
)

// The real-hardware Hub is a USB collector dongle: it is registered as a timer (ID 1) but never
// tied to a gate, and Spokes take the gates, the first one becoming start/finish.
func TestCollectorHubNeverHoldsAGate(t *testing.T) {
	e := NewRealEngine()

	hubID, err := e.RegisterTimerHello("A0767469", true, "H1")
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

	s1, err := e.RegisterTimerHello("DA9B4CA7", false, "S1")
	if err != nil {
		t.Fatalf("register spoke 1: %v", err)
	}
	s2, err := e.RegisterTimerHello("11223344", false, "S2")
	if err != nil {
		t.Fatalf("register spoke 2: %v", err)
	}
	if s1 == 1 || s2 == 1 || s1 == s2 {
		t.Fatalf("spoke IDs %d, %d must be distinct and never the hub's ID 1", s1, s2)
	}

	_, gates, _, _, _ = e.StateSnapshot()
	if len(gates) != 0 {
		t.Fatalf("got %d gates, want 0 (newly discovered spokes stay unassigned until dragged onto the track)", len(gates))
	}

	// Dragging Spoke 1 and Spoke 2 onto the track creates gates for them.
	if _, err := e.AddGate("", s1); err != nil {
		t.Fatalf("add gate for s1: %v", err)
	}
	if _, err := e.AddGate("", s2); err != nil {
		t.Fatalf("add gate for s2: %v", err)
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

	// Dragging the Hub onto a gate (UpdateGate) makes it that gate's timer, and periodic HELLO
	// re-announcements must not undo the user's choice.
	var startGate domain.TrackGate
	for _, g := range gates {
		if g.Role == domain.GateRoleStartFinish {
			startGate = g
		}
	}
	hub := hubID
	if err := e.UpdateGate(domain.GateUpdate{GateID: startGate.GateID, Name: startGate.Name, Role: startGate.Role, AssignedTimerID: &hub}); err != nil {
		t.Fatalf("drag hub onto gate: %v", err)
	}
	if _, err := e.RegisterTimerHello("A0767469", true, "H1"); err != nil {
		t.Fatalf("re-register hub: %v", err)
	}
	_, gates, _, _, _ = e.StateSnapshot()
	tied := false
	for _, g := range gates {
		if g.GateID == startGate.GateID && g.AssignedTimerID == hubID {
			tied = true
		}
	}
	if !tied {
		t.Fatalf("hub re-announce removed the user's gate assignment")
	}
	// Dragging it off returns it to a pure dongle.
	none := uint8(0)
	if err := e.UpdateGate(domain.GateUpdate{GateID: startGate.GateID, Name: startGate.Name, Role: startGate.Role, AssignedTimerID: &none}); err != nil {
		t.Fatalf("drag hub off gate: %v", err)
	}

	// Re-announcing the hub (periodic HELLO) keeps it gate-less and on ID 1.
	again, err := e.RegisterTimerHello("A0767469", true, "H1")
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

// The simulator engine follows the same collector model as real hardware: the simulated Hub is
// registered (timer 1, IsHub) without a gate, simulated Spokes time every default gate (the
// first one start/finish), and the Hub can be dragged onto a gate and off again.
func TestSimulatorEngineUsesCollectorHubModel(t *testing.T) {
	e := NewEngine()
	timers := e.DetectedTimersSnapshot()
	_, gates, _, _, _ := e.StateSnapshot()

	if len(gates) != len(domain.DefaultTrackGates()) {
		t.Fatalf("got %d default gates, want %d", len(gates), len(domain.DefaultTrackGates()))
	}
	hubs := 0
	byID := map[uint8]domain.DetectedTimer{}
	for _, d := range timers {
		byID[d.TimerID] = d
		if d.IsHub {
			hubs++
			if d.TimerID != domain.SimHubTimerID {
				t.Fatalf("simulated hub has timer ID %d, want %d", d.TimerID, domain.SimHubTimerID)
			}
		}
	}
	if hubs != 1 {
		t.Fatalf("got %d simulated hubs, want 1", hubs)
	}
	if len(timers) != len(gates)+1 {
		t.Fatalf("got %d simulated timers, want %d (hub + one spoke per gate)", len(timers), len(gates)+1)
	}
	for _, g := range gates {
		d, ok := byID[g.AssignedTimerID]
		if !ok || d.IsHub {
			t.Fatalf("gate %d is timed by timer %d (hub=%v), want a spoke", g.GateID, g.AssignedTimerID, d.IsHub)
		}
		if g.Role == domain.GateRoleStartFinish && g.TrackOrder != 0 {
			t.Fatalf("start/finish gate %d is not first in track order", g.GateID)
		}
	}

	// A second simulated hub is rejected; a new spoke never takes timer ID 1.
	if _, err := e.AddSimulatedTimer("hub", ""); err != ErrHubExists {
		t.Fatalf("adding a 2nd hub: err=%v, want ErrHubExists", err)
	}
	id, err := e.AddSimulatedTimer("spoke", "")
	if err != nil || id == domain.SimHubTimerID {
		t.Fatalf("add spoke: id=%d err=%v", id, err)
	}

	// Drag the hub onto the start/finish gate, then off again.
	start := gates[0]
	hub := domain.SimHubTimerID
	if err := e.UpdateGate(domain.GateUpdate{GateID: start.GateID, Name: start.Name, Role: start.Role, AssignedTimerID: &hub}); err != nil {
		t.Fatalf("drag hub onto gate: %v", err)
	}
	_, gates, _, _, _ = e.StateSnapshot()
	if gates[0].AssignedTimerID != hub {
		t.Fatalf("start gate timed by %d after drag, want hub", gates[0].AssignedTimerID)
	}
	none := uint8(0)
	if err := e.UpdateGate(domain.GateUpdate{GateID: start.GateID, Name: start.Name, Role: start.Role, AssignedTimerID: &none}); err != nil {
		t.Fatalf("drag hub off gate: %v", err)
	}
	for _, g := range func() []domain.TrackGate { _, gs, _, _, _ := e.StateSnapshot(); return gs }() {
		if g.AssignedTimerID == hub {
			t.Fatalf("hub still tied to gate %d", g.GateID)
		}
	}

	// Factory / track resets restore the same model.
	e.ResetTrackToDefault(true)
	_, gates, _, _, _ = e.StateSnapshot()
	for _, g := range gates {
		if g.AssignedTimerID == hub || g.AssignedTimerID == 0 {
			t.Fatalf("after track reset gate %d timed by %d, want a spoke", g.GateID, g.AssignedTimerID)
		}
	}
}
