package ingest

import (
	"math/rand"
	"testing"

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

	_, pucks, laps, _, _ := engine.StateSnapshot()
	if len(laps) < 60 {
		t.Fatalf("expected at least 60 laps in 10 minutes, got %d", len(laps))
	}
	incomplete := 0
	for _, lap := range laps {
		if len(lap.Sectors) != len(pucks) {
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
		if tm.PuckID == 2 && (tm.PoweredOn || tm.Online) {
			t.Fatalf("expected T2 PoweredOn=false and Online=false, got %+v", tm)
		}
	}
	if poweredOn := sim.ToggleTimerPower(2); !poweredOn {
		t.Fatalf("expected T2 to be powered back on")
	}

	newID, err := sim.AddTimer("spoke", "T5 Split-S Exit", "open-ground")
	if err != nil || newID != 5 {
		t.Fatalf("expected AddTimer to create T5 (id=5), got id=%d err=%v", newID, err)
	}
	if err := sim.DeleteTimer(newID); err != nil {
		t.Fatalf("expected DeleteTimer(5) to succeed, got %v", err)
	}
}

