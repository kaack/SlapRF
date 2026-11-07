package ingest

import (
	"math/rand"
	"testing"

	"fpv-gate-timer/internal/tracker"
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
	if len(laps) < 100 {
		t.Fatalf("expected well over 100 laps in 10 minutes, got %d", len(laps))
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
