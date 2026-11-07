package tracker

import (
	"errors"
	"testing"

	"fpv-gate-timer/internal/domain"
)

func gateByID(t *testing.T, e *Engine, id uint8) domain.GatePuck {
	t.Helper()
	_, pucks, _, _, _ := e.StateSnapshot()
	for _, p := range pucks {
		if p.PuckID == id {
			return p
		}
	}
	t.Fatalf("gate %d not found", id)
	return domain.GatePuck{}
}

func at(position int) *int { return &position }

// assertLayout checks the gate order and that exactly one gate is the start gate.
func assertLayout(t *testing.T, e *Engine, want ...uint8) {
	t.Helper()
	_, pucks, _, _, _ := e.StateSnapshot()
	startCount := 0
	for i, p := range pucks {
		if p.PuckID != want[i] || p.TrackOrder != i {
			t.Fatalf("position %d: got puck %d (order %d), want puck %d", i, p.PuckID, p.TrackOrder, want[i])
		}
		if p.Role == domain.PuckRoleStartFinish {
			startCount++
		}
	}
	if startCount != 1 {
		t.Fatalf("expected exactly 1 START_FINISH gate, got %d", startCount)
	}
}

func TestRenameGate(t *testing.T) {
	e := NewEngine()
	g := gateByID(t, e, 3)
	if err := e.UpdateGate(domain.GateUpdate{PuckID: 3, Name: "  Dive gate  ", Role: g.Role}); err != nil {
		t.Fatal(err)
	}
	if got := gateByID(t, e, 3).Name; got != "Dive gate" {
		t.Fatalf("expected trimmed name, got %q", got)
	}
	assertLayout(t, e, 1, 2, 3, 4)
}

// A rename carries no position, so it can't undo a reorder made from another browser.
func TestRenameKeepsPosition(t *testing.T) {
	e := NewEngine()
	if err := e.UpdateGate(domain.GateUpdate{PuckID: 4, Role: domain.PuckRoleSectorGate, TrackOrder: at(1)}); err != nil {
		t.Fatal(err)
	}
	if err := e.UpdateGate(domain.GateUpdate{PuckID: 4, Name: "Hairpin", Role: domain.PuckRoleSectorGate}); err != nil {
		t.Fatal(err)
	}
	assertLayout(t, e, 1, 4, 2, 3)
}

func TestGateValidation(t *testing.T) {
	e := NewEngine()
	cases := []struct {
		u    domain.GateUpdate
		want error
	}{
		{domain.GateUpdate{PuckID: 99, Name: "x", Role: domain.PuckRoleSectorGate}, ErrUnknownGate},
		{domain.GateUpdate{PuckID: 2, Name: "x", Role: "FINISH"}, ErrInvalidGateRole},
	}
	for _, c := range cases {
		if err := e.UpdateGate(c.u); !errors.Is(err, c.want) {
			t.Errorf("%+v: expected %v, got %v", c.u, c.want, err)
		}
	}
}

func TestDraggingToFrontKeepsStartGateRole(t *testing.T) {
	e := NewEngine() // pucks 1 2 3 4 (puck 1 is START_FINISH)
	if err := e.UpdateGate(domain.GateUpdate{PuckID: 3, Role: domain.PuckRoleSectorGate, TrackOrder: at(0)}); err != nil {
		t.Fatal(err)
	}
	assertLayout(t, e, 3, 1, 2, 4)
	if got := gateByID(t, e, 1).Role; got != domain.PuckRoleStartFinish {
		t.Fatalf("expected puck 1 to remain START_FINISH after reorder, got %s", got)
	}
	if got := gateByID(t, e, 3).Role; got != domain.PuckRoleSectorGate {
		t.Fatalf("expected puck 3 to remain SECTOR_GATE after reorder, got %s", got)
	}
}

func TestDraggingStartGateKeepsItsRole(t *testing.T) {
	e := NewEngine()
	if err := e.UpdateGate(domain.GateUpdate{PuckID: 1, Role: domain.PuckRoleStartFinish, TrackOrder: at(2)}); err != nil {
		t.Fatal(err)
	}
	assertLayout(t, e, 2, 3, 1, 4)
	if got := gateByID(t, e, 1).Role; got != domain.PuckRoleStartFinish {
		t.Fatalf("expected puck 1 to keep START_FINISH role at position 2, got %s", got)
	}
}

func TestSetAsStartChangesRoleWithoutReordering(t *testing.T) {
	e := NewEngine()
	if err := e.UpdateGate(domain.GateUpdate{PuckID: 3, Role: domain.PuckRoleStartFinish}); err != nil {
		t.Fatal(err)
	}
	// Gate order remains 1, 2, 3, 4; only the start gate role moved to gate 3.
	assertLayout(t, e, 1, 2, 3, 4)
	if got := gateByID(t, e, 3).Role; got != domain.PuckRoleStartFinish {
		t.Fatalf("expected puck 3 to be START_FINISH, got %s", got)
	}
	if got := gateByID(t, e, 1).Role; got != domain.PuckRoleSectorGate {
		t.Fatalf("expected puck 1 to become SECTOR_GATE, got %s", got)
	}
}

func TestReorderCheckpoints(t *testing.T) {
	e := NewEngine()
	if err := e.UpdateGate(domain.GateUpdate{PuckID: 4, Role: domain.PuckRoleSectorGate, TrackOrder: at(1)}); err != nil {
		t.Fatal(err)
	}
	assertLayout(t, e, 1, 4, 2, 3)
}

// Unnamed gates are labelled by position, so their label follows them as the course is reordered.
func TestUnnamedGatesAreLabelledByPosition(t *testing.T) {
	e := NewEngine()
	if err := e.UpdateGate(domain.GateUpdate{PuckID: 2, Name: "Split-S", Role: domain.PuckRoleSectorGate}); err != nil {
		t.Fatal(err)
	}
	if err := e.UpdateGate(domain.GateUpdate{PuckID: 4, Role: domain.PuckRoleSectorGate, TrackOrder: at(0)}); err != nil {
		t.Fatal(err)
	} // order: 4 1 2 3

	e.mu.Lock()
	defer e.mu.Unlock()
	for id, want := range map[uint8]string{4: "Gate 1", 1: "Gate 2", 2: "Split-S", 3: "Gate 4"} {
		if got := e.gateLabelLocked(id); got != want {
			t.Errorf("puck %d: got %q, want %q", id, got, want)
		}
	}
}

func TestPuckLabelAndDisplayNameOverride(t *testing.T) {
	e := NewEngine()
	// Flash a Spoke puck with ID "Blue-Puck" -> claims the first unlabelled sector gate (Puck 2).
	id, err := e.ProvisionGate("spoke", "Blue-Puck")
	if err != nil {
		t.Fatal(err)
	}
	if id != 2 {
		t.Fatalf("expected spoke puck to claim puck #2, got #%d", id)
	}

	// Without a display-name override, gateLabelLocked returns the flashed PuckLabel ("Blue-Puck").
	e.mu.Lock()
	gotDefault := e.gateLabelLocked(2)
	e.mu.Unlock()
	if gotDefault != "Blue-Puck" {
		t.Fatalf("expected flashed label 'Blue-Puck', got %q", gotDefault)
	}

	// Setting a display name in the Gates editor overrides the UI label while preserving PuckLabel.
	if err := e.UpdateGate(domain.GateUpdate{PuckID: 2, Name: "Corkscrew", Role: domain.PuckRoleSectorGate}); err != nil {
		t.Fatal(err)
	}
	g := gateByID(t, e, 2)
	if g.PuckLabel != "Blue-Puck" || g.Name != "Corkscrew" {
		t.Fatalf("expected PuckLabel='Blue-Puck' and Name='Corkscrew', got %+v", g)
	}
	e.mu.Lock()
	gotOverride := e.gateLabelLocked(2)
	e.mu.Unlock()
	if gotOverride != "Corkscrew" {
		t.Fatalf("expected overridden label 'Corkscrew', got %q", gotOverride)
	}
}

func TestAddUnassignedGateAndBindDetectedPuck(t *testing.T) {
	e := NewEngine()
	if _, err := e.ProvisionGate("spoke", "Spoke-Alpha"); err != nil {
		t.Fatal(err)
	}

	// Add a 5th gate with no puck assigned (assignedPuckID = 0).
	created, err := e.AddGate("Dive Gate", 0)
	if err != nil {
		t.Fatal(err)
	}
	if created.PuckID != 5 || created.AssignedPuckID != 0 || created.Online {
		t.Fatalf("expected unassigned offline gate #5, got %+v", created)
	}

	// Tie physical puck #2 ("Spoke-Alpha") to Gate #5 -> Gate #2 becomes unassigned, Gate #5 gets puck #2.
	puck2 := uint8(2)
	if err := e.UpdateGate(domain.GateUpdate{
		PuckID:         5,
		Name:           "Dive Gate",
		Role:           domain.PuckRoleSectorGate,
		AssignedPuckID: &puck2,
	}); err != nil {
		t.Fatal(err)
	}

	g2 := gateByID(t, e, 2)
	if g2.AssignedPuckID != 0 {
		t.Fatalf("expected gate #2 to be unassigned after moving puck #2 to gate #5, got %d", g2.AssignedPuckID)
	}
	g5 := gateByID(t, e, 5)
	if g5.AssignedPuckID != 2 || g5.PuckLabel != "Spoke-Alpha" {
		t.Fatalf("expected gate #5 to have AssignedPuckID=2 and PuckLabel='Spoke-Alpha', got %+v", g5)
	}

	// Removing Gate #5 leaves physical puck #2 in DetectedPucksSnapshot().
	if err := e.RemoveGate(5); err != nil {
		t.Fatal(err)
	}
	detected := e.DetectedPucksSnapshot()
	if len(detected) != 4 {
		t.Fatalf("expected 4 detected pucks to remain after removing gate #5, got %d", len(detected))
	}
}
