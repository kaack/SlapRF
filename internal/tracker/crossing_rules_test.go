package tracker

import (
	"testing"

	"slaprf/internal/domain"
)

// Default track: G1 start/finish → G2 → G3 → G4 → G1.

type crossingRig struct {
	t     *testing.T
	e     *Engine
	pilot domain.PilotSlot
}

func newRig(t *testing.T) *crossingRig {
	e := NewEngine()
	return &crossingRig{t: t, e: e, pilot: e.pilots[0]}
}

// pass feeds one detection at gate `gateID`, `atSec` seconds into the session.
func (r *crossingRig) pass(gateID uint8, atSec float64) crossingOutcome {
	r.t.Helper()
	r.e.mu.Lock()
	defer r.e.mu.Unlock()
	var gate domain.TrackGate
	for _, g := range r.e.gates {
		if g.GateID == gateID {
			gate = g
		}
	}
	out := r.e.applyCrossingLocked(r.pilot, gate, domain.GateCrossingEvent{
		GateID:      gateID,
		SlotIndex:   r.pilot.SlotIndex,
		TimestampUs: uint64(atSec * 1e6),
	})
	if out.lap != nil {
		r.e.laps = append(r.e.laps, *out.lap)
	}
	return out
}

func (r *crossingRig) expectAccepted(out crossingOutcome) {
	r.t.Helper()
	if out.rejected != nil {
		r.t.Fatalf("expected accepted, got %s: %s", out.rejected.Reason, out.rejected.Detail)
	}
}

func (r *crossingRig) expectFiltered(out crossingOutcome, reason domain.FilterReason) {
	r.t.Helper()
	if out.rejected == nil {
		r.t.Fatalf("expected %s, but the detection was accepted", reason)
	}
	if out.rejected.Reason != reason {
		r.t.Fatalf("expected %s, got %s (%s)", reason, out.rejected.Reason, out.rejected.Detail)
	}
}

func TestCleanLapIsRecordedWithEverySection(t *testing.T) {
	r := newRig(t)
	r.expectAccepted(r.pass(1, 10))
	r.expectAccepted(r.pass(2, 13))
	r.expectAccepted(r.pass(3, 16))
	r.expectAccepted(r.pass(4, 20))
	out := r.pass(1, 24)
	r.expectAccepted(out)
	if out.lap == nil || out.lap.LapTimeSec != 14 || len(out.lap.Sectors) != 4 {
		t.Fatalf("expected a 14 s lap with 4 sections, got %+v", out.lap)
	}
}

func TestPreviousGateEchoIsIgnored(t *testing.T) {
	r := newRig(t)
	r.pass(1, 10)
	r.pass(2, 13)
	// G1 picks the quad up again as it leaves G2 (gates close together).
	r.expectFiltered(r.pass(1, 14), domain.FilterEcho)
	// Progress is unchanged: the lap continues normally.
	r.expectAccepted(r.pass(3, 16))
}

func TestFlyingBackwardsThroughGateIsIgnored(t *testing.T) {
	r := newRig(t)
	r.pass(1, 10)
	r.pass(2, 13)
	r.pass(3, 16)
	// Pilot turns around and flies back through G2.
	r.expectFiltered(r.pass(2, 17.5), domain.FilterEcho)
}

func TestEchoWindowExpires(t *testing.T) {
	r := newRig(t)
	r.pass(1, 10)
	r.pass(2, 13)
	r.pass(3, 16)
	// Long after the window, the same gate pair is a genuine (if odd) pass.
	r.expectAccepted(r.pass(2, 16+r.e.rules.EchoWindowSec+2))
}

func TestGateCooldownSuppressesBounce(t *testing.T) {
	r := newRig(t)
	r.pass(1, 10)
	r.pass(2, 13)
	// Quad wobbles in G2 — the gate fires again 0.8 s later.
	r.expectFiltered(r.pass(2, 13.8), domain.FilterCooldown)
}

func TestImpossiblySoonSectionIsIgnored(t *testing.T) {
	r := newRig(t)
	r.pass(1, 10)
	// G2 fires 0.2 s after G1 — faster than any quad can cover the section.
	r.expectFiltered(r.pass(2, 10.2), domain.FilterTooSoon)
}

func TestMinimumLapTime(t *testing.T) {
	r := newRig(t)
	r.pass(1, 10)
	// Pilot crashes right after the start gate and the quad bounces back through it.
	r.expectFiltered(r.pass(1, 13), domain.FilterMinLap)
	if len(r.e.laps) != 0 {
		t.Fatal("no lap should be recorded")
	}
}

func TestOverlongLapIsNotCountedAndRestarts(t *testing.T) {
	r := newRig(t)
	r.pass(1, 10)
	r.pass(2, 13)
	// Crash, walk of shame, keep flying: next start/finish crossing well past max lap.
	r.pass(3, 80)
	out := r.pass(1, 10+r.e.rules.MaxLapSec+5)
	r.expectAccepted(out)
	if out.lap != nil || out.note == nil || out.note.Reason != domain.FilterLapTooLong {
		t.Fatalf("expected the lap to be dropped with a LAP_TOO_LONG note, got lap=%+v note=%+v", out.lap, out.note)
	}
	// The crossing started a new lap, which completes normally.
	r.pass(2, 148)
	r.pass(3, 151)
	r.pass(4, 155)
	if lap := r.pass(1, 159).lap; lap == nil {
		t.Fatal("the lap after the restart should count")
	}
}

func TestMissedSectorGateStillCompletesLap(t *testing.T) {
	r := newRig(t)
	r.pass(1, 10)
	r.pass(2, 13)
	// G3 missed (timer blocked / offline).
	r.pass(4, 20)
	out := r.pass(1, 24)
	if out.lap == nil || len(out.lap.Sectors) != 3 {
		t.Fatalf("expected a lap with 3 sections (G2→G4 spans the miss), got %+v", out.lap)
	}
}
