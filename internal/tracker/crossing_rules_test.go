package tracker

import (
	"testing"

	"slaprf/internal/domain"
)

// Default track: G1 start/finish -> G2 -> G3 -> G4 -> G1.

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
	return r.passWithHold(gateID, atSec, 0, 0)
}

func (r *crossingRig) passWithHold(gateID uint8, atSec float64, holdMs float64, areaDbSec float64) crossingOutcome {
	r.t.Helper()
	r.e.mu.Lock()
	defer r.e.mu.Unlock()
	var gate domain.TrackGate
	for _, g := range r.e.gates {
		if g.GateID == gateID {
			gate = g
		}
	}
	ev := domain.GateCrossingEvent{
		GateID:      gateID,
		SlotIndex:   r.pilot.SlotIndex,
		TimestampUs: uint64(atSec * 1e6),
	}
	if holdMs > 0 || areaDbSec > 0 {
		ev.PeakRSSIDbm = -42
		ev.HoldMs = holdMs
		ev.AboveEnterMs = holdMs * 0.8
		ev.PassAreaDbSec = areaDbSec
		ev.BeamwidthMs = holdMs
	}
	out := r.e.applyCrossingLocked(r.pilot, gate, ev)
	if out.rejected == nil {
		if out.supersededEventID != 0 {
			r.e.removeCrossingByIDLocked(out.supersededEventID)
		}
		r.e.nextEventID++
		ev.EventID = r.e.nextEventID
		r.e.crossings = append(r.e.crossings, ev)
	}
	if out.lap != nil {
		r.e.laps = append(r.e.laps, *out.lap)
	}
	return out
}

func (r *crossingRig) passEvent(ev domain.GateCrossingEvent) crossingOutcome {
	r.t.Helper()
	r.e.mu.Lock()
	defer r.e.mu.Unlock()
	var gate domain.TrackGate
	for _, g := range r.e.gates {
		if g.GateID == ev.GateID {
			gate = g
		}
	}
	ev.SlotIndex = r.pilot.SlotIndex
	out := r.e.applyCrossingLocked(r.pilot, gate, ev)
	if out.rejected == nil {
		if out.supersededEventID != 0 {
			r.e.removeCrossingByIDLocked(out.supersededEventID)
		}
		r.e.nextEventID++
		ev.EventID = r.e.nextEventID
		r.e.crossings = append(r.e.crossings, ev)
	}
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

func TestTimersActIndependentlyWithoutCrossGateRejection(t *testing.T) {
	r := newRig(t)
	r.expectAccepted(r.pass(1, 10.0))
	// G2 only 0.2 s after G1: accepted because forward sequential gates have no artificial min-section lockout.
	r.expectAccepted(r.pass(2, 10.2))
	// G3 at 12.0 s advances forward in track order cleanly.
	r.expectAccepted(r.pass(3, 12.0))
	// G2 at 16.0 s (>= 5 s after G2's 10.2 s pass, but before Start/Finish G1) is out of sequential track order
	// and skipped so return-lane proximity cannot corrupt the final section or arm G2's MinLapSec!
	r.expectFiltered(r.pass(2, 16.0), domain.FilterOutOfOrder)
	// Finish Lap 1 at G1 (17.5 s), then hit G2 on Lap 2 (19.0 s, only 3.0 s after the skipped out-of-order G2):
	// G2 MUST be accepted because the skipped out-of-order detection did not arm MinLapSec!
	r.expectAccepted(r.pass(1, 17.5))
	r.expectAccepted(r.pass(2, 19.0))
	// Same-gate minimum lap time still guards G2 against immediate repeat triggers.
	r.expectFiltered(r.pass(2, 19.8), domain.FilterMinLap)
}

func TestMinimumCrossingTimeRejectsShortSpikes(t *testing.T) {
	r := newRig(t)
	// Default MinCrossingSec is 0.12 s (120 ms): a 65 ms RF spike is rejected.
	r.expectFiltered(r.passWithHold(1, 10.0, 65, 3.0), domain.FilterSpike)
	// A genuine 220 ms pass with healthy dB*s area is accepted.
	r.expectAccepted(r.passWithHold(1, 10.5, 220, 4.5))
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
		t.Fatalf("expected a lap with 3 sections (G2->G4 spans the miss), got %+v", out.lap)
	}
}

func TestApproachJitterNearEnterThresholdDoesNotBlockRealPeakPass(t *testing.T) {
	r := newRig(t)
	// Configure gate thresholds matching field telemetry (-75 dBm enter, -83 dBm exit).
	r.e.mu.Lock()
	for gi := range r.e.gates {
		r.e.gates[gi].EnterThresholds[0] = -75
		r.e.gates[gi].ExitThresholds[0] = -83
	}
	r.e.mu.Unlock()

	// Start lap at G1, clean pass at G2.
	r.expectAccepted(r.passWithHold(1, 10.0, 620, 12.0))
	r.expectAccepted(r.passWithHold(2, 13.8, 590, 13.5))

	// Approach jitter at G3 (t=14.88s): barely crosses -75 dBm enter (-70.82 dBm), lingers in the
	// -83..-75 hysteresis band (hold=662 ms, passAreaDbSec=2.51 dB*s above exit), but only has
	// 117.7 ms / 0.19 dB*s above enterThreshold. Must be rejected as SPIKE!
	r.expectFiltered(r.passEvent(domain.GateCrossingEvent{
		GateID:              3,
		TimestampUs:         14_880_000,
		PeakRSSIDbm:         -70.82,
		HoldMs:              662.1,
		AboveEnterMs:        117.7,
		AboveEnterAreaDbSec: 0.19,
		PassAreaDbSec:       2.51,
		BeamwidthMs:         430.4,
	}), domain.FilterSpike)

	// 2.08 s later (t=16.96s, < 5.0 s MinLapSec), the real strong G3 pass (-59.86 dBm) arrives and MUST be accepted!
	r.expectAccepted(r.passEvent(domain.GateCrossingEvent{
		GateID:              3,
		TimestampUs:         16_960_000,
		PeakRSSIDbm:         -59.86,
		HoldMs:              640.0,
		AboveEnterMs:        510.0,
		AboveEnterAreaDbSec: 5.40,
		PassAreaDbSec:       11.20,
		BeamwidthMs:         360.0,
	}))

	// Wide cross-talk wobble on G2 (t=19.52s) while flying from G4 toward G1: long hold above exit
	// (2121 ms, 9.66 dB*s) but shallow 0.88 dB*s above enter (-71.06 dBm). Must be rejected so it
	// neither adds a bogus split nor blinds G2 on the next lap 4.67 s later!
	r.expectAccepted(r.passWithHold(4, 18.60, 610, 12.8))
	r.expectFiltered(r.passEvent(domain.GateCrossingEvent{
		GateID:              2,
		TimestampUs:         19_520_000,
		PeakRSSIDbm:         -71.06,
		HoldMs:              2121.2,
		AboveEnterMs:        449.0,
		AboveEnterAreaDbSec: 0.88,
		PassAreaDbSec:       9.66,
		BeamwidthMs:         1441.4,
	}), domain.FilterSpike)

	// Finish Lap 1 at G1 (t=21.86s): all 4 genuine sections must be intact!
	lap1 := r.passWithHold(1, 21.86, 630, 13.1)
	r.expectAccepted(lap1)
	if lap1.lap == nil || len(lap1.lap.Sectors) != 4 {
		t.Fatalf("expected clean 4-section lap 1 without jitter corruption, got %+v", lap1.lap)
	}
	if lap1.lap.Sectors[1].SplitSeconds != 3.16 {
		t.Fatalf("expected G2->G3 split to use the real peak at 16.96s (3.16s), got %.3fs", lap1.lap.Sectors[1].SplitSeconds)
	}

	// On Lap 2, real G2 pass at t=24.19s (4.67 s after the rejected 19.52s cross-talk wobble) is accepted!
	r.expectAccepted(r.passWithHold(2, 24.19, 600, 13.0))
}

func TestStrongerRealPassSupersedesBorderlinePrematureBumpWithinMinLap(t *testing.T) {
	r := newRig(t)
	r.e.mu.Lock()
	for gi := range r.e.gates {
		r.e.gates[gi].EnterThresholds[0] = -75
		r.e.gates[gi].ExitThresholds[0] = -83
	}
	r.e.mu.Unlock()

	r.expectAccepted(r.passWithHold(1, 10.0, 600, 12.0))
	r.expectAccepted(r.passWithHold(2, 13.0, 600, 12.5))

	// Borderline pre-hump at G3 (-67.5 dBm, +7.5 dB above enter, 2.2 dB*s) gets accepted at 14.1s.
	r.expectAccepted(r.passEvent(domain.GateCrossingEvent{
		GateID:              3,
		TimestampUs:         14_100_000,
		PeakRSSIDbm:         -67.5,
		HoldMs:              480.0,
		AboveEnterMs:        260.0,
		AboveEnterAreaDbSec: 1.55,
		PassAreaDbSec:       2.20,
		BeamwidthMs:         310.0,
	}))

	// 2.1 s later (t=16.2s, inside 5.0 s MinLapSec), the true gate pass (-56.0 dBm, +11.5 dB stronger,
	// 12.4 dB*s area) supersedes the premature bump and replaces the premature G2->G3 split!
	realG3 := r.passEvent(domain.GateCrossingEvent{
		GateID:              3,
		TimestampUs:         16_200_000,
		PeakRSSIDbm:         -56.0,
		HoldMs:              680.0,
		AboveEnterMs:        520.0,
		AboveEnterAreaDbSec: 6.80,
		PassAreaDbSec:       12.40,
		BeamwidthMs:         350.0,
	})
	r.expectAccepted(realG3)
	if realG3.supersededEventID == 0 || realG3.note == nil || realG3.note.Reason != domain.FilterSpike {
		t.Fatalf("expected premature G3 bump to be superseded with SPIKE note, got %+v", realG3)
	}

	r.expectAccepted(r.passWithHold(4, 20.0, 600, 12.0))
	fin := r.passWithHold(1, 24.0, 600, 12.0)
	r.expectAccepted(fin)
	if fin.lap == nil || len(fin.lap.Sectors) != 4 {
		t.Fatalf("expected 4 sections on completed lap, got %+v", fin.lap)
	}
	if fin.lap.Sectors[1].SplitSeconds != 3.2 || fin.lap.Sectors[2].SplitSeconds != 3.8 {
		t.Fatalf("expected superseded G2->G3=3.2s and G3->G4=3.8s, got %+v", fin.lap.Sectors)
	}
}

func TestReturnLaneOutOfOrderPassPreservesS4AndSubsequentS1S2(t *testing.T) {
	r := newRig(t)

	// Sector gate hit before Start/Finish begins Lap 1 is skipped as OUT_OF_ORDER without arming MinLapSec.
	r.expectFiltered(r.passWithHold(2, 8.70, 800, 10.0), domain.FilterOutOfOrder)

	// Replay the 6-lap field trajectory (H1=G1, T1=G2, T2=G3, T3=G4) where the return lane from T3->H1
	// passes near T1 ~1.3 s before H1 on every lap:
	// Lap 1 (T2 & T3 missed, return-lane T1 skipped):
	r.expectAccepted(r.passWithHold(1, 10.000, 600, 20.9))
	r.expectAccepted(r.passWithHold(2, 11.681, 600, 15.4))
	r.expectFiltered(r.passWithHold(2, 20.905, 800, 10.6), domain.FilterOutOfOrder)
	lap1 := r.passWithHold(1, 22.202, 600, 45.7)
	r.expectAccepted(lap1)

	// Lap 2:
	r.expectAccepted(r.passWithHold(2, 26.283, 600, 11.0))
	r.expectAccepted(r.passWithHold(3, 28.624, 600, 16.2))
	r.expectAccepted(r.passWithHold(4, 30.865, 600, 19.4))
	r.expectFiltered(r.passWithHold(2, 33.885, 800, 11.3), domain.FilterOutOfOrder)
	lap2 := r.passWithHold(1, 35.119, 600, 47.3)
	r.expectAccepted(lap2)

	// Lap 3 (real T1 arrives 2.769 s into Lap 3 = 4.003 s after the skipped return-lane T1):
	r.expectAccepted(r.passWithHold(2, 37.888, 600, 14.0))
	r.expectAccepted(r.passWithHold(3, 41.670, 600, 25.7))
	r.expectAccepted(r.passWithHold(4, 44.261, 600, 22.1))
	r.expectFiltered(r.passWithHold(2, 47.280, 800, 21.2), domain.FilterOutOfOrder)
	lap3 := r.passWithHold(1, 48.590, 600, 35.1)
	r.expectAccepted(lap3)

	// Lap 4 (real T1 arrives 4.062 s after the skipped return-lane T1):
	r.expectAccepted(r.passWithHold(2, 51.342, 600, 18.0))
	r.expectAccepted(r.passWithHold(3, 54.504, 600, 27.3))
	r.expectAccepted(r.passWithHold(4, 56.969, 600, 22.0))
	r.expectFiltered(r.passWithHold(2, 59.822, 800, 20.4), domain.FilterOutOfOrder)
	lap4 := r.passWithHold(1, 61.876, 600, 40.5)
	r.expectAccepted(lap4)

	// Lap 5 (real T1 arrives 4.641 s after the skipped return-lane T1):
	r.expectAccepted(r.passWithHold(2, 64.463, 600, 17.5))
	r.expectAccepted(r.passWithHold(3, 67.141, 600, 22.2))
	r.expectAccepted(r.passWithHold(4, 69.537, 600, 21.3))
	r.expectFiltered(r.passWithHold(2, 72.189, 800, 15.5), domain.FilterOutOfOrder)
	lap5 := r.passWithHold(1, 73.741, 600, 35.3)
	r.expectAccepted(lap5)

	// Lap 6:
	r.expectAccepted(r.passWithHold(2, 78.093, 600, 16.0))
	r.expectAccepted(r.passWithHold(3, 81.121, 600, 17.4))
	r.expectAccepted(r.passWithHold(4, 83.644, 600, 17.3))
	r.expectFiltered(r.passWithHold(2, 86.732, 800, 10.9), domain.FilterOutOfOrder)
	lap6 := r.passWithHold(1, 87.640, 600, 73.4)
	r.expectAccepted(lap6)

	for idx, out := range []crossingOutcome{lap2, lap3, lap4, lap5, lap6} {
		lapNum := idx + 2
		if out.lap == nil || len(out.lap.Sectors) != 4 {
			t.Fatalf("Lap %d: expected 4 canonical sections (S1..S4), got %+v", lapNum, out.lap)
		}
		wantPairs := [4][2]uint8{{1, 2}, {2, 3}, {3, 4}, {4, 1}}
		for si, wp := range wantPairs {
			got := out.lap.Sectors[si]
			if got.FromGateID != wp[0] || got.ToGateID != wp[1] || got.SplitSeconds <= 0 {
				t.Fatalf("Lap %d S%d: expected %d->%d > 0s, got %+v", lapNum, si+1, wp[0], wp[1], got)
			}
		}
	}
}

func TestMalformedSplicedFingerprintIsRejected(t *testing.T) {
	e := NewRealEngine()
	if id, err := e.RegisterTimerHello("53E01C4D9C", false, "T2"); err == nil || id != 0 {
		t.Fatalf("expected 10-hex spliced BLE fingerprint to be rejected, got id=%d err=%v", id, err)
	}
}
