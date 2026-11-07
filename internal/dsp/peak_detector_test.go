package dsp

import (
	"math"
	"testing"
)

// simulatePass feeds a straight-line gate pass at speedMps and returns every confirmed crossing.
// Gates are ~90 m apart on a real track, so the signal never drops to the noise floor between them.
func simulatePass(t *testing.T, speedMps float64, maxDistM float64) []*CrossingCandidate {
	t.Helper()
	det := NewChannelDetector(1, 1)
	const frameUs = 20_000
	var out []*CrossingCandidate
	ts := uint64(1_000_000)
	for x := -maxDistM; x <= maxDistM; x += speedMps * frameUs / 1e6 {
		d := math.Sqrt(x*x + 1.25*1.25)
		rssi := float32(-24.5 - 23.5*math.Log10(d))
		if c := det.ProcessSample(rssi, ts, -58, -68, 1_400_000); c != nil {
			out = append(out, c)
		}
		ts += frameUs
	}
	return out
}

func TestSlowPassBetweenCloseGatesIsDetected(t *testing.T) {
	// 18 m/s (~40 mph) technical section, next gate 45 m away: signal bottoms out around -63 dBm,
	// never reaching the -68 dBm absolute exit threshold.
	crossings := simulatePass(t, 18, 45)
	if len(crossings) != 1 {
		t.Fatalf("expected exactly 1 crossing, got %d", len(crossings))
	}
}

// With only a short debounce (the engine's setting — cool-down is a separate timing rule),
// the tail of a single pass must not re-trigger the detector while the signal is still strong.
func TestSinglePassYieldsOneCandidateWithShortDebounce(t *testing.T) {
	for _, speed := range []float64{15, 25, 35} {
		det := NewChannelDetector(1, 1)
		const frameUs = 20_000
		count := 0
		ts := uint64(1_000_000)
		for x := -60.0; x <= 60; x += speed * frameUs / 1e6 {
			d := math.Sqrt(x*x + 1.25*1.25)
			rssi := float32(-24.5 - 23.5*math.Log10(d))
			if det.ProcessSample(rssi, ts, -58, -68, 300_000) != nil {
				count++
			}
			ts += frameUs
		}
		if count != 1 {
			t.Errorf("%.0f m/s: expected 1 candidate, got %d", speed, count)
		}
	}
}

func TestCrossingTimestampIsNearClosestApproach(t *testing.T) {
	crossings := simulatePass(t, 30, 60)
	if len(crossings) != 1 {
		t.Fatalf("expected exactly 1 crossing, got %d", len(crossings))
	}
	// Closest approach happens 60 m / 30 m/s = 2.0 s after the first sample (t0 = 1.0 s).
	const expectedUs = 3_000_000
	errMs := math.Abs(float64(crossings[0].TimestampUs)-expectedUs) / 1000
	// EMA smoothing adds a small, consistent lag; it must stay well inside one 50 Hz frame budget x3.
	if errMs > 60 {
		t.Fatalf("crossing timestamp off by %.1f ms", errMs)
	}
}
