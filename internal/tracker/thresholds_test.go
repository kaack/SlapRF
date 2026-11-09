package tracker

import (
	"errors"
	"testing"

	"slaprf/internal/domain"
)

func TestGateThresholdOverridesPilotDefault(t *testing.T) {
	e := NewEngine()
	pilot := e.pilots[0] // enter -58, exit -68 by default
	if err := e.SetGateThresholds([]domain.GateThresholdUpdate{{GateID: 2, SlotIndex: pilot.SlotIndex, EnterDbm: -50}}); err != nil {
		t.Fatal(err)
	}
	g2 := gateByID(t, e, 2)
	enter, exit := thresholdsFor(&g2, 0, pilot)
	if enter != -50 || exit != -50-(pilot.EnterThreshold-pilot.ExitThreshold) {
		t.Fatalf("gate 2: got enter %v exit %v", enter, exit)
	}
	// Other gates keep the pilot's own threshold.
	g1 := gateByID(t, e, 1)
	if enter, _ := thresholdsFor(&g1, 0, pilot); enter != pilot.EnterThreshold {
		t.Fatalf("gate 1 should use the pilot default, got %v", enter)
	}
}

func TestGateThresholdClearAndClamp(t *testing.T) {
	e := NewEngine()
	slot := e.pilots[1].SlotIndex
	if err := e.SetGateThresholds([]domain.GateThresholdUpdate{{GateID: 3, SlotIndex: slot, EnterDbm: -5}}); err != nil {
		t.Fatal(err)
	}
	if got := gateByID(t, e, 3).EnterThresholds[1]; got != domain.MaxThresholdDbm {
		t.Fatalf("expected clamp to %v, got %v", domain.MaxThresholdDbm, got)
	}
	if err := e.SetGateThresholds([]domain.GateThresholdUpdate{{GateID: 3, SlotIndex: slot, EnterDbm: 0}}); err != nil {
		t.Fatal(err)
	}
	if got := gateByID(t, e, 3).EnterThresholds[1]; got != 0 {
		t.Fatalf("expected override cleared, got %v", got)
	}
}

func TestGateThresholdsAllOrNothing(t *testing.T) {
	e := NewEngine()
	slot := e.pilots[0].SlotIndex
	err := e.SetGateThresholds([]domain.GateThresholdUpdate{
		{GateID: 1, SlotIndex: slot, EnterDbm: -40},
		{GateID: 99, SlotIndex: slot, EnterDbm: -40},
	})
	if !errors.Is(err, ErrUnknownGate) {
		t.Fatalf("expected ErrUnknownGate, got %v", err)
	}
	if got := gateByID(t, e, 1).EnterThresholds[0]; got != 0 {
		t.Fatalf("nothing should be applied when one update is invalid, got %v", got)
	}
}
