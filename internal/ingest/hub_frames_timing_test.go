package ingest

import (
	"testing"

	"slaprf/internal/domain"
	"slaprf/internal/tracker"
)

// windowAt builds a 4-sample window frame whose newest sample has sequence number `newest`.
func windowAt(slot uint8, newest int) []byte {
	samples := make([]domain.TimerTelemetryFrame, 4)
	for i := range samples {
		samples[i] = domain.TimerTelemetryFrame{SeqNum: uint32(uint8(newest - 3 + i))}
	}
	return EncodeWindowFrame(slot, 4000, -92, samples)
}

// 100 Hz sweeps, a 4-sample window every 20 ms (each sample sent twice), but the browser receives
// them in 100 ms bursts (one USB read / a busy main thread): every sample must come out exactly
// once, 10 ms apart, never bunched at the burst's arrival time.
func TestWindowTimestampsStayEvenUnderBurstyArrival(t *testing.T) {
	eng := tracker.NewRealEngine()
	rx := NewHubFrameDecoder(eng)
	rx.IngestPacket(EncodeHelloFrame(2, 2, 0x00000002, 100, "S1"), 0)

	const frames = 200
	var got []domain.TimerTelemetryFrame
	var burst [][]byte
	for k := 0; k < frames; k++ {
		burst = append(burst, windowAt(2, 3+2*k))
		captureUs := uint64(1_000_000 + (3+2*k)*10_000) // when the newest sample was swept
		if len(burst) == 5 || k == frames-1 {
			arrivalUs := captureUs + 2_000 // delivered together, slightly after the last capture
			for _, pkt := range burst {
				got = append(got, rx.DecodePacket(pkt, arrivalUs)...)
			}
			burst = burst[:0]
		}
	}
	// The very first window is seeded from its (late) burst arrival; the timeline then pulls back
	// toward on-time arrivals within the first few hundred ms, after which spacing must be exact.
	if want := 4 + 2*(frames-1); len(got) != want {
		t.Fatalf("expected %d unique samples, got %d", want, len(got))
	}
	uneven := 0
	for i := 1; i < len(got); i++ {
		if got[i].TimestampUs <= got[i-1].TimestampUs {
			t.Fatalf("sample %d not monotonic: %d after %d", i, got[i].TimestampUs, got[i-1].TimestampUs)
		}
		if d := got[i].TimestampUs - got[i-1].TimestampUs; i > 50 && (d < 9_000 || d > 11_000) {
			uneven++
		}
	}
	if uneven > 0 {
		t.Fatalf("%d of %d sample spacings deviate from 10 ms by more than 1 ms", uneven, len(got)-51)
	}
	// The timeline tracks the earliest arrivals: the last sample is stamped no later than it arrived.
	last := got[len(got)-1]
	if arrival := uint64(1_000_000+(3+2*(frames-1))*10_000) + 2_000; last.TimestampUs > arrival {
		t.Fatalf("last sample stamped %d, after its arrival %d", last.TimestampUs, arrival)
	}
}

// A timer that goes silent for longer than half the 8-bit sequence space (1.28 s at 100 Hz) comes
// back with a sequence number that looks "older": its fresh samples must not be dropped.
func TestSilentTimerSamplesAcceptedAfterSequenceWrap(t *testing.T) {
	eng := tracker.NewRealEngine()
	rx := NewHubFrameDecoder(eng)
	rx.IngestPacket(EncodeHelloFrame(3, 2, 0x00000003, 100, "S2"), 0)

	if got := rx.DecodePacket(windowAt(3, 10), 1_000_000); len(got) != 4 {
		t.Fatalf("expected 4 samples, got %d", len(got))
	}
	// 1.5 s later: 150 sweeps on, seq 160 = 10+150 (mod 256 diff 150 >= 128 reads as "older").
	got := rx.DecodePacket(windowAt(3, 160), 2_500_000)
	if len(got) != 4 {
		t.Fatalf("expected 4 fresh samples after the timer's silence, got %d", len(got))
	}
	if got[3].TimestampUs != 2_500_000 {
		t.Fatalf("expected re-seeded timestamp 2500000, got %d", got[3].TimestampUs)
	}
}

// If the first frame arrived late (seeding the timeline late), on-time arrivals pull the timeline
// back (at most half an interval per sample, so it stays monotonic) instead of staying late forever.
func TestEarlyArrivalPullsTimelineBack(t *testing.T) {
	eng := tracker.NewRealEngine()
	rx := NewHubFrameDecoder(eng)
	rx.IngestPacket(EncodeHelloFrame(4, 2, 0x00000004, 100, "S3"), 0)

	// Newest sample swept at 1.03 s but delivered 60 ms late.
	rx.DecodePacket(windowAt(4, 3), 1_090_000)
	// Following windows (every 20 ms) arrive 0.5 ms after their newest sample was swept.
	var last domain.TimerTelemetryFrame
	var arrival uint64
	for k := 1; k <= 12; k++ {
		arrival = uint64(1_030_000+k*20_000) + 500
		got := rx.DecodePacket(windowAt(4, 3+2*k), arrival)
		if len(got) != 2 {
			t.Fatalf("window %d: expected 2 new samples, got %d", k, len(got))
		}
		last = got[1]
	}
	if last.TimestampUs > arrival || arrival-last.TimestampUs > 1_000 {
		t.Fatalf("timeline not pulled back to on-time arrivals: stamped %d, arrived %d", last.TimestampUs, arrival)
	}
}
