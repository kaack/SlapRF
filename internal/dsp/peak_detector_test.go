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
	if errMs > 15 {
		t.Fatalf("crossing timestamp off by %.2f ms (want <= 15 ms with zero-phase plateau refinement)", errMs)
	}
}

func TestZeroLagAcrossSpeedsAt100Hz(t *testing.T) {
	for _, speedMps := range []float64{12, 22, 32, 42} {
		det := NewChannelDetector(1, 1)
		const frameUs = 10_000 // 100 Hz hardware sweep rate
		const centerUs = 6_000_000
		var got *CrossingCandidate
		for ts := uint64(1_000_000); ts <= 11_000_000; ts += frameUs {
			dtSec := (float64(ts) - centerUs) / 1e6
			x := speedMps * dtSec
			d := math.Sqrt(x*x + 1.25*1.25)
			rssi := float32(-24.5 - 23.5*math.Log10(d))
			if c := det.ProcessSample(rssi, ts, -58, -68, 1_000_000); c != nil {
				got = c
			}
		}
		if got == nil {
			t.Fatalf("%.0f m/s: expected crossing", speedMps)
		}
		errMs := math.Abs(float64(got.TimestampUs)-centerUs) / 1000.0
		if errMs > 8.0 {
			t.Errorf("%.0f m/s: crossing timestamp error %.2f ms exceeds 8 ms zero-phase budget", speedMps, errMs)
		}
	}
}

func TestMedianPreFilterRejectsSingleSweepSpikesAndSmoothsJitter(t *testing.T) {
	det := NewChannelDetector(1, 1)
	const frameUs = 10_000 // 100 Hz
	ts := uint64(1_000_000)

	// Feed 200 samples of stationary VTX at -75 dBm with ±1.5 dB alternating RF noise plus
	// isolated single-sweep +35 dB interference spikes (to -40 dBm, well above -58 enter).
	for i := 0; i < 200; i++ {
		raw := float32(-75.0)
		if i%2 == 0 {
			raw += 1.5
		} else {
			raw -= 1.5
		}
		if i == 60 || i == 130 {
			raw = -40.0 // Single-sweep spike
		}
		if c := det.ProcessSample(raw, ts, -58, -68, 500_000); c != nil {
			t.Fatalf("unexpected false crossing on single-sweep spike at sample %d", i)
		}
		if i >= 20 {
			if diff := math.Abs(float64(det.SmoothedRSSI() - (-75.0))); diff > 0.6 {
				t.Fatalf("sample %d: smoothed RSSI %.2f dBm drifted %.2f dB from -75 dBm mean", i, det.SmoothedRSSI(), diff)
			}
		}
		ts += frameUs
	}
}

func TestPlateauCentroidCentersFlatTopAndDipoleNullPass(t *testing.T) {
	det := NewChannelDetector(1, 1)
	const frameUs = 10_000 // 100 Hz
	const centerUs = 3_000_000
	var got *CrossingCandidate

	// Simulate a close gate fly-through centered at t = 3.000 s whose peak is saturated/flat
	// across ±80 ms with a slight +0.8 dB multipath bump on the late shoulder (+70 ms) and a
	// -1.0 dB overhead antenna null at t = 3.000 s. Single-sample argmax would snap +70 ms late;
	// plateau centroid must stay centered near 3.000 s.
	for ts := uint64(2_000_000); ts <= 4_000_000; ts += frameUs {
		dtMs := (float64(ts) - centerUs) / 1000.0
		rssi := -26.0 - 0.00035*dtMs*dtMs
		if rssi > -28.0 {
			rssi = -28.0 // Saturated flat top across ~±75 ms
			if math.Abs(dtMs) < 20 {
				rssi -= 1.0 // Overhead dipole null right at gate plane
			}
			if math.Abs(dtMs-65) < 15 {
				rssi += 0.8 // Multipath ripple on trailing shoulder
			}
		}
		if rssi < -90 {
			rssi = -90
		}
		if c := det.ProcessSample(float32(rssi), ts, -55, -68, 500_000); c != nil {
			got = c
		}
	}
	if got == nil {
		t.Fatalf("expected crossing candidate")
	}
	errMs := math.Abs(float64(got.TimestampUs)-centerUs) / 1000.0
	if errMs > 18.0 {
		t.Fatalf("expected plateau centroid near center (err <= 18 ms), got err=%.1f ms", errMs)
	}
}

func TestDualEntryExitHysteresisRejectsMidPassDip(t *testing.T) {
	det := NewChannelDetector(1, 1)
	const frameUs = 20_000
	ts := uint64(1_000_000)

	// Signal enters at -55 dBm, hits -30 dBm, dips to -48 dBm (antenna null, still > -55 enter & > -66 exit),
	// rises to the true -26 dBm peak, then falls below the -66 dBm exit threshold.
	profile := []float32{
		-80, -76, -70, -62, -54, -46, -38, -31, -30, -35, -42, -48, -46, -36, -28, -26, -26, -26, -31, -40, -50, -60, -68, -74, -80, -80, -80, -80, -80, -80, -80, -80,
	}
	var out []*CrossingCandidate
	for _, rssi := range profile {
		if c := det.ProcessSample(rssi, ts, -55, -66, 300_000); c != nil {
			out = append(out, c)
		}
		ts += frameUs
	}
	if len(out) != 1 {
		t.Fatalf("expected 1 crossing across mid-pass dip, got %d", len(out))
	}
	if out[0].PeakRSSIDbm < -29 {
		t.Fatalf("expected peak near true -26 dBm smoothed maximum, got %.1f dBm", out[0].PeakRSSIDbm)
	}
}

func TestMultipathNotchPassProducesSmoothSingleCrossing(t *testing.T) {
	det := NewChannelDetector(1, 1)
	const frameUs = 10_000 // 100 Hz
	var got []*CrossingCandidate
	var minNearPeak float32 = 0

	// Simulate an indoor pass centered at t = 4.0 s (-75 dBm valley -> -53 dBm peak -> -75 dBm valley)
	// with repeated 70 ms -13 dB destructive Rayleigh multipath dropouts right across the crest.
	for ts := uint64(1_000_000); ts <= 7_000_000; ts += frameUs {
		dtSec := (float64(ts) - 4_000_000.0) / 1e6
		env := -75.0 + 22.0*math.Exp(-0.5*(dtSec/0.65)*(dtSec/0.65))
		// Inject 70 ms deep multipath dropouts at -220 ms, -40 ms, and +160 ms around peak
		if (dtSec >= -0.25 && dtSec <= -0.18) || (dtSec >= -0.07 && dtSec <= 0.00) || (dtSec >= 0.13 && dtSec <= 0.20) {
			env -= 13.0
		}
		if c := det.ProcessSample(float32(env), ts, -63, -70, 500_000); c != nil {
			got = append(got, c)
		}
		if math.Abs(dtSec) <= 0.25 {
			if minNearPeak == 0 || det.SmoothedRSSI() < minNearPeak {
				minNearPeak = det.SmoothedRSSI()
			}
		}
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 clean crossing despite multipath dropouts, got %d", len(got))
	}
	if minNearPeak < -61.0 {
		t.Fatalf("expected 2-pole trimmed-mean envelope to bridge 70 ms multipath dropouts (>= -61 dBm), got %.1f dBm", minNearPeak)
	}
}

func TestBriefExitNadirAndRejectedSpikeNeverSwallowFollowingPass(t *testing.T) {
	// Regression for live flight telemetry (enter = -67 dBm, exit = -73 dBm):
	// A 50 ms -66.5 dBm pre-blip dips to -73.0 dBm for a single 20 ms sample, then the signal
	// immediately climbs through a -65.5 dBm shoulder / -69.5 dBm notch into a real -52.5 dBm pass.
	// Previously, setting awaitingRearm = true even when s <= effectiveExit required s <= -73.0 dBm
	// a second time and swallowed the entire -52.5 dBm pass!
	det := NewChannelDetector(1, 7)
	const frameUs = 20_000 // 50 Hz BLE Hub
	ts := uint64(10_000_000)

	feed := func(rssi float32, count int) []*CrossingCandidate {
		var out []*CrossingCandidate
		for i := 0; i < count; i++ {
			if c := det.ProcessSample(rssi, ts, -67, -73, 300_000); c != nil {
				out = append(out, c)
			}
			ts += frameUs
		}
		return out
	}

	// Settle at -78 dBm, then create a brief -66 dBm blip that dips to -74 dBm just long enough to exit
	// at s <= -73 dBm on a single sample before rebounding above -73 dBm.
	_ = feed(-78, 15)
	var blipOut []*CrossingCandidate
	blipProfile := []float32{
		-70, -64.5, -64.5, -64.5, -64.5, -65.0, -71, -77, -77, -77, -77, -77, -77, -77, -77,
	}
	for _, rssi := range blipProfile {
		c := det.ProcessSample(rssi, ts, -67, -73, 300_000)
		ts += frameUs
		if c != nil {
			blipOut = append(blipOut, c)
			// Simulate engine rejecting this short blip as FilterSpike and rolling back lockout:
			det.RollbackRejectedSpike()
			break
		}
	}
	if len(blipOut) != 1 {
		t.Fatalf("expected 1 short blip candidate before the real pass, got %d", len(blipOut))
	}

	// Immediately rebound above -73 dBm (-71 -> -65.5 shoulder -> -69.5 notch, never touching <= -70 dBm!)
	// and climb into the real -52.5 dBm gate pass over 2.8 seconds, then exit to -79 dBm.
	var realPass []*CrossingCandidate
	approachAndPass := []struct {
		rssi  float32
		steps int
	}{
		{-71.0, 5},  // rebounds right above -73 dBm exit
		{-65.5, 12}, // pre-shoulder
		{-69.5, 12}, // notch stays 0.5 dB above (enter - 3 dB = -70.0 dBm)!
		{-61.0, 20}, // rising flank
		{-52.5, 25}, // obvious -52.5 dBm gate pass apex
		{-60.0, 15}, // falling flank
		{-79.0, 25}, // clean exit to -79 dBm
	}
	for _, seg := range approachAndPass {
		realPass = append(realPass, feed(seg.rssi, seg.steps)...)
	}

	if len(realPass) != 1 {
		t.Fatalf("expected real -52.5 dBm pass to be detected cleanly, got %d candidates", len(realPass))
	}
	if realPass[0].PeakRSSIDbm < -54.0 {
		t.Fatalf("expected real pass peak near -52.5 dBm, got %.1f dBm", realPass[0].PeakRSSIDbm)
	}
}

func TestCompactTrackNearBaselineConfirmsPostPeakWithoutWaitingForExit(t *testing.T) {
	det := NewChannelDetector(1, 0)
	const frameUs = 20_000 // 50 Hz BLE Hub rate
	ts := uint64(1_000_000)

	feedVal := func(rssi float32) (*CrossingCandidate, uint64) {
		sampleTs := ts
		c := det.ProcessSample(rssi, sampleTs, -70, -76, 1_500_000)
		ts += frameUs
		return c, sampleTs
	}

	// Settle ambient floor at -82 dBm.
	for i := 0; i < 20; i++ {
		_, _ = feedVal(-82.0)
	}

	runCompactPass := func(peakDbm float32) (cand *CrossingCandidate, emitDelayUs uint64, truePeakTs uint64, extras int) {
		// 300 ms approach climb (-78 -> peakDbm), 80 ms crest, 260 ms descent to -68.5 dBm,
		// then 2.2 seconds cruising near the track at -68.5 dBm (7.5 dB ABOVE -76 dBm exit!).
		for i := 0; i < 15; i++ {
			frac := float32(i+1) / 15.0
			v := -78.0 + frac*(peakDbm - -78.0)
			if c, sampleTs := feedVal(v); c != nil && cand == nil {
				cand = c
				emitDelayUs = sampleTs
			}
		}
		crestStart := ts
		for i := 0; i < 4; i++ {
			if c, sampleTs := feedVal(peakDbm); c != nil {
				if cand == nil {
					cand = c
					emitDelayUs = sampleTs
				} else {
					extras++
				}
			}
		}
		crestEnd := ts - frameUs
		truePeakTs = crestStart + (crestEnd-crestStart)/2

		// 13 samples (260 ms) descending from peakDbm to -68.5 dBm.
		for i := 0; i < 13; i++ {
			frac := float32(i+1) / 13.0
			v := peakDbm + frac*(-68.5-peakDbm)
			if c, sampleTs := feedVal(v); c != nil {
				if cand == nil {
					cand = c
					emitDelayUs = sampleTs - truePeakTs
				} else {
					extras++
				}
			}
		}

		// 110 samples (2.2 seconds) staying at -68.5 dBm above exitThreshold (-76 dBm).
		for i := 0; i < 110; i++ {
			if c, sampleTs := feedVal(-68.5); c != nil {
				if cand == nil {
					cand = c
					emitDelayUs = sampleTs - truePeakTs
				} else {
					extras++
				}
			}
		}

		// Far side of track drops to -81 dBm for 1.0 s before next lap.
		for i := 0; i < 50; i++ {
			if c, sampleTs := feedVal(-81.0); c != nil {
				if cand == nil {
					cand = c
					emitDelayUs = sampleTs - truePeakTs
				} else {
					extras++
				}
			}
		}
		return cand, emitDelayUs, truePeakTs, extras
	}

	c1, delay1Us, peak1Ts, extras1 := runCompactPass(-53.0)
	if c1 == nil {
		t.Fatalf("expected Pass 1 (-53.0 dBm) to emit a crossing candidate")
	}
	if extras1 != 0 {
		t.Fatalf("expected zero duplicate crossings on 2.2 s near-track tail, got %d", extras1)
	}
	if delay1Us > 420_000 {
		t.Fatalf("expected Pass 1 to confirm in real time (<= 420 ms post-peak), got %.1f ms", float64(delay1Us)/1000.0)
	}
	diff1Ms := float64(int64(c1.TimestampUs)-int64(peak1Ts)) / 1000.0
	if diff1Ms < -45.0 || diff1Ms > 45.0 {
		t.Fatalf("expected Pass 1 refined peak timestamp within +-45 ms of crest, got %+.1f ms", diff1Ms)
	}

	// Pass 2 on a wider line (-58.5 dBm, 5.5 dB below Pass 1) should also confirm in real time.
	c2, delay2Us, peak2Ts, extras2 := runCompactPass(-58.5)
	if c2 == nil {
		t.Fatalf("expected Pass 2 (-58.5 dBm) to emit a crossing candidate")
	}
	if extras2 != 0 {
		t.Fatalf("expected zero duplicate crossings on Pass 2 tail, got %d", extras2)
	}
	if delay2Us > 420_000 {
		t.Fatalf("expected Pass 2 (-58.5 dBm) to confirm in real time (<= 420 ms post-peak), got %.1f ms", float64(delay2Us)/1000.0)
	}
	diff2Ms := float64(int64(c2.TimestampUs)-int64(peak2Ts)) / 1000.0
	if diff2Ms < -45.0 || diff2Ms > 45.0 {
		t.Fatalf("expected Pass 2 refined peak timestamp within +-45 ms of crest, got %+.1f ms", diff2Ms)
	}
}
