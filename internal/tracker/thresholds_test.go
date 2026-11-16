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

func TestGateDualEnterAndExitThresholds(t *testing.T) {
	e := NewEngine()
	pilot := e.pilots[0]
	if err := e.SetGateThresholds([]domain.GateThresholdUpdate{{
		GateID:    1,
		SlotIndex: pilot.SlotIndex,
		EnterDbm:  -52,
		ExitDbm:   -64,
	}}); err != nil {
		t.Fatal(err)
	}
	g1 := gateByID(t, e, 1)
	enter, exit := thresholdsFor(&g1, 0, pilot)
	if enter != -52 || exit != -64 {
		t.Fatalf("expected enter -52 exit -64, got enter %v exit %v", enter, exit)
	}

	// Exit threshold above (enter - 2 dB) is clamped to maintain hysteresis.
	if err := e.SetGateThresholds([]domain.GateThresholdUpdate{{
		GateID:    1,
		SlotIndex: pilot.SlotIndex,
		EnterDbm:  -52,
		ExitDbm:   -50,
	}}); err != nil {
		t.Fatal(err)
	}
	g1 = gateByID(t, e, 1)
	enter, exit = thresholdsFor(&g1, 0, pilot)
	if enter != -52 || exit != -54 {
		t.Fatalf("expected clamped exit -54, got enter %v exit %v", enter, exit)
	}
}

func TestRotorHazardDbmThresholdScaling(t *testing.T) {
	if got := dbmToRHEnter(-58); got != 95 {
		t.Fatalf("dbmToRHEnter(-58) = %v, want 95", got)
	}
	if got := dbmToRHExit(-68, 95); got != 70 {
		t.Fatalf("dbmToRHExit(-68, 95) = %v, want 70", got)
	}

	// Pilot with custom dBm thresholds and no explicit RH thresholds scales into 0..255.
	pilot := domain.PilotSlot{
		SlotIndex:      1,
		EnterThreshold: -50, // 95 + (-50+58)*2.5 = 115
		ExitThreshold:  -60, // 95 + (-60+58)*2.5 = 90
	}
	enter, exit := rhThresholdsFor(nil, 0, pilot)
	if enter != 115 || exit != 90 {
		t.Fatalf("rhThresholdsFor scaled dBm = (%v, %v), want (115, 90)", enter, exit)
	}

	// SetGateThresholds in RotorHazard mode scales negative dBm inputs to 0..255.
	e := NewEngine()
	e.SetTimingHardwareMode(domain.HardwareModeRotorHazard, true)
	if err := e.SetGateThresholds([]domain.GateThresholdUpdate{{
		GateID:    1,
		SlotIndex: pilot.SlotIndex,
		EnterDbm:  -52, // 95 + 6*2.5 = 110
		ExitDbm:   -62, // 95 - 4*2.5 = 85
	}}); err != nil {
		t.Fatal(err)
	}
	g1 := gateByID(t, e, 1)
	enter, exit = rhThresholdsFor(&g1, 0, pilot)
	if enter != 110 || exit != 85 {
		t.Fatalf("expected RH scaled gate thresholds (110, 85), got (%v, %v)", enter, exit)
	}
}


