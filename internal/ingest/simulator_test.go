package ingest

import (
	"math/rand"
	"testing"

	"slaprf/internal/domain"
	"slaprf/internal/tracker"
	_ "slaprf/web"
)

// TestSimulatedLapsVisitEveryGate runs 10 simulated minutes on a deterministic clock and
// checks that every lap passes through every gate. A skipped gate means the peak detector
// missed a real pass — which would corrupt sector analysis.
func TestSimulatedLapsVisitEveryGate(t *testing.T) {
	engine := tracker.NewEngine()
	sim := NewTrackSimulator(engine)
	sim.rng = rand.New(rand.NewSource(42))

	var nowUs uint64 = 1_000_000
	sim.clock = func() uint64 { return nowUs }

	const frames = 10 * 60 * 50
	for i := 0; i < frames; i++ {
		sim.step(0.020)
		nowUs += 20_000
	}

	_, gates, laps, _, _ := engine.StateSnapshot()
	if len(laps) < 60 {
		t.Fatalf("expected at least 60 laps in 10 minutes, got %d", len(laps))
	}
	incomplete := 0
	for _, lap := range laps {
		if len(lap.Sectors) != len(gates) {
			incomplete++
			t.Logf("%s lap %d: %d sectors %+v", lap.Callsign, lap.LapNumber, len(lap.Sectors), lap.Sectors)
		}
	}
	if incomplete > 0 {
		t.Fatalf("%d of %d laps skipped a gate", incomplete, len(laps))
	}
}

func TestSimulatorControlsAndTimerLifecycle(t *testing.T) {
	engine := tracker.NewEngine()
	sim := NewTrackSimulator(engine)

	// 1. Force crash on slot 1 (Faerry)
	sim.TriggerPilotAction(1, "crash")
	snap := sim.Snapshot()
	if len(snap.Pilots) == 0 || snap.Pilots[0].Status != "CRASHED_VTX_ON" || !snap.Pilots[0].VtxActive {
		t.Fatalf("expected slot 1 to be CRASHED_VTX_ON with VTX active, got %+v", snap.Pilots[0])
	}

	// 2. Trigger turtle recovery -> enters TURTLE_RECOVERY before resuming FLYING
	sim.TriggerPilotAction(1, "recover")
	snap = sim.Snapshot()
	if snap.Pilots[0].Status != "TURTLE_RECOVERY" || !snap.Pilots[0].VtxActive {
		t.Fatalf("expected slot 1 to enter TURTLE_RECOVERY with VTX active, got %+v", snap.Pilots[0])
	}

	// 3. Activate track walker -> flying pilots climb to AVOIDING or return to pit, crashed pilot enters WALKING_RECOVERY on field
	sim.SetTrackWalker(true)
	snap = sim.Snapshot()
	if !snap.TrackWalkerActive {
		t.Fatalf("expected TrackWalkerActive=true")
	}
	if snap.Pilots[0].Status != "WALKING_RECOVERY" || snap.Pilots[0].StateRemainingSec <= 0 {
		t.Fatalf("expected crashed pilot to enter WALKING_RECOVERY on field during track walk, got %+v", snap.Pilots[0])
	}
	if snap.Pilots[1].Status != "AVOIDING" && snap.Pilots[1].Status != "LANDING" && snap.Pilots[1].Status != "PIT_SWAP" && snap.Pilots[1].Status != "PILOT_BREAK" && snap.Pilots[1].Status != "CHARGING_WAIT" {
		t.Fatalf("expected flying pilot to react by climbing to AVOIDING or landing to pits, got %+v", snap.Pilots[1])
	}
	sim.SetTrackWalker(false)
	snap = sim.Snapshot()
	if snap.Pilots[0].Status != "PIT_SWAP" && snap.Pilots[0].Status != "PILOT_BREAK" && snap.Pilots[0].Status != "CHARGING_WAIT" {
		t.Fatalf("expected crashed pilot to move to pit state after recovery walk finishes, got %s", snap.Pilots[0].Status)
	}
	if len(snap.Pilots[0].Packs) != 3 {
		t.Fatalf("expected 3 LiPo packs per pilot, got %d", len(snap.Pilots[0].Packs))
	}

	// Slot 3 (Din) starts airborne with Pack #2 (78%) and Pack #3 (40%) charging;
	// pitting first enters the 5s LANDING stage, and once landed enters CHARGING_WAIT.
	sim.TriggerPilotAction(3, "pit")
	snap = sim.Snapshot()
	if snap.Pilots[2].Status != "LANDING" {
		t.Fatalf("expected slot 3 to enter LANDING stage first, got %s", snap.Pilots[2].Status)
	}
	sim.step(5.1)
	snap = sim.Snapshot()
	if snap.Pilots[2].Status != "CHARGING_WAIT" {
		t.Fatalf("expected slot 3 to enter CHARGING_WAIT after landing when all 3 packs are < 100%%, got %s", snap.Pilots[2].Status)
	}

	// 3. Toggle power off on T2, add T5, delete T5
	if poweredOn := sim.ToggleTimerPower(2); poweredOn {
		t.Fatalf("expected T2 to be powered off")
	}
	snap = sim.Snapshot()
	for _, tm := range snap.Timers {
		if tm.TimerID == 2 && (tm.PoweredOn || tm.Online) {
			t.Fatalf("expected T2 PoweredOn=false and Online=false, got %+v", tm)
		}
	}
	if poweredOn := sim.ToggleTimerPower(2); !poweredOn {
		t.Fatalf("expected T2 to be powered back on")
	}

	newID, err := sim.AddTimer("spoke", "T6 Split-S Exit")
	if err != nil || newID != 6 {
		t.Fatalf("expected AddTimer to create T6 (id=6; T1 hub + T2..T5 spokes exist), got id=%d err=%v", newID, err)
	}
	if err := sim.DeleteTimer(newID); err != nil {
		t.Fatalf("expected DeleteTimer(6) to succeed, got %v", err)
	}
}

// The simulated Hub is a gate-less collector: it produces no telemetry or crossings until it is
// dragged onto a gate, then times that gate like a Spoke, and stops again once dragged off.
func TestSimulatedHubSweepsOnlyWhileOnAGate(t *testing.T) {
	engine := tracker.NewEngine()
	sim := NewTrackSimulator(engine)
	sim.rng = rand.New(rand.NewSource(7))
	var nowUs uint64 = 1_000_000
	sim.clock = func() uint64 { return nowUs }
	run := func(seconds int) {
		for i := 0; i < seconds*50; i++ {
			sim.step(0.020)
			nowUs += 20_000
		}
	}
	hubID := domain.SimHubTimerID
	gateOf := func() (domain.TrackGate, bool) {
		_, gates, _, _, _ := engine.StateSnapshot()
		for _, g := range gates {
			if g.AssignedTimerID == hubID {
				return g, true
			}
		}
		return domain.TrackGate{}, false
	}
	crossingsAt := func(gateID uint8) int {
		_, _, _, crossings, _ := engine.StateSnapshot()
		n := 0
		for _, c := range crossings {
			if c.GateID == gateID {
				n++
			}
		}
		return n
	}

	run(30)
	if _, onGate := gateOf(); onGate {
		t.Fatal("simulated hub must not hold a gate by default")
	}
	hubOnline := false
	for _, d := range engine.DetectedTimersSnapshot() {
		if d.TimerID == hubID {
			hubOnline = d.IsHub && d.Online
		}
	}
	if !hubOnline {
		t.Fatal("gate-less simulated hub should still be registered and online")
	}

	// Drag the hub onto gate 3 (replacing its spoke): the gate keeps producing crossings, now
	// from the hub's own sweep.
	_, gates, _, _, _ := engine.StateSnapshot()
	target := gates[2]
	if err := engine.UpdateGate(domain.GateUpdate{GateID: target.GateID, Name: target.Name, Role: target.Role, AssignedTimerID: &hubID}); err != nil {
		t.Fatal(err)
	}
	before := crossingsAt(target.GateID)
	framesBefore := target.FramesRxCount
	run(30)
	g, onGate := gateOf()
	if !onGate || g.GateID != target.GateID {
		t.Fatal("hub should time the gate it was dragged onto")
	}
	if g.FramesRxCount <= framesBefore || crossingsAt(target.GateID) <= before {
		t.Fatalf("hub on gate %d produced no telemetry/crossings (frames %d->%d)", target.GateID, framesBefore, g.FramesRxCount)
	}

	// Drag it off (leave the gate empty): no more telemetry or crossings at that gate.
	none := uint8(0)
	if err := engine.UpdateGate(domain.GateUpdate{GateID: target.GateID, Name: target.Name, Role: target.Role, AssignedTimerID: &none}); err != nil {
		t.Fatal(err)
	}
	_, gates, _, _, _ = engine.StateSnapshot()
	framesOff := gates[2].FramesRxCount
	offCount := crossingsAt(target.GateID)
	run(30)
	_, gates, _, _, _ = engine.StateSnapshot()
	if gates[2].FramesRxCount != framesOff || crossingsAt(target.GateID) != offCount {
		t.Fatalf("empty gate %d kept receiving telemetry after the hub was dragged off", target.GateID)
	}
}

