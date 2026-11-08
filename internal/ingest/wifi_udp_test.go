package ingest

import (
	"testing"

	"slaprf/internal/domain"
	"slaprf/internal/tracker"
)

func TestSlidingWindowRecovers100PercentUnder50PercentPacketLoss(t *testing.T) {
	eng := tracker.NewRealEngine()
	rx := NewWiFiUDPReceiver(":0", eng)

	// Simulate 40 consecutive 20 ms 5.8 GHz sweeps (seq 240..255, wrapping around to 0..23)
	const totalSweeps = 40
	var ring []domain.PuckTelemetryFrame
	var recovered []domain.PuckTelemetryFrame

	var nowUs uint64 = 1_000_000
	burstIdx := 0

	for step := 0; step < totalSweeps; step++ {
		seq := uint8(240 + step) // Exercises 8-bit rollover (255 -> 0)
		var rssi [domain.MaxPilotPoolSize]float32
		rssi[0] = -80.0 + float32(step%15)

		ring = append(ring, domain.PuckTelemetryFrame{
			PuckID:        2,
			SeqNum:        uint32(seq),
			TimestampUs:   nowUs,
			RSSI:          rssi,
			BatteryMv:     4120,
			NoiseFloorDbm: -92,
		})
		if len(ring) > SlidingWindowSize {
			ring = ring[len(ring)-SlidingWindowSize:]
		}

		// Spoke transmits a 4-sample sliding window every 2 sweeps (40 ms / 25 Hz)
		if (step+1)%2 == 0 {
			pkt := EncodeWindowFrame(2, 4120, -92, ring)
			burstIdx++

			// Simulate severe 50% packet loss in the grass: drop every odd burst completely
			// (except the very last burst so the final 2 samples arrive).
			if burstIdx%2 == 1 && step < totalSweeps-1 {
				// Corrupted/lost in grass multipath null
			} else {
				frames := rx.DecodePacket(pkt[:], nowUs)
				recovered = append(recovered, frames...)
			}
		}
		nowUs += SampleIntervalUs
	}

	if len(recovered) != totalSweeps {
		t.Fatalf("expected all %d 50Hz samples recovered despite 50%% packet loss, got %d", totalSweeps, len(recovered))
	}

	for i, f := range recovered {
		expectedSeq := uint32(uint8(240 + i))
		expectedTs := uint64(1_000_000) + uint64(i)*SampleIntervalUs
		if f.SeqNum != expectedSeq {
			t.Fatalf("sample %d: expected seq %d, got %d", i, expectedSeq, f.SeqNum)
		}
		if f.TimestampUs != expectedTs {
			t.Fatalf("sample %d: expected reconstructed timestamp %d us, got %d us", i, expectedTs, f.TimestampUs)
		}
	}
}

func TestCorruptedPacketRejectedAndHealedByNextWindow(t *testing.T) {
	eng := tracker.NewRealEngine()
	rx := NewWiFiUDPReceiver(":0", eng)

	var samples [4]domain.PuckTelemetryFrame
	for i := 0; i < 4; i++ {
		samples[i] = domain.PuckTelemetryFrame{PuckID: 3, SeqNum: uint32(i + 1)}
	}

	// Burst 1 (samples 1, 2) corrupted by a 2.4 GHz ELRS hop
	badPkt := EncodeWindowFrame(3, 4100, -92, samples[:2])
	badPkt[10] ^= 0xFF // Flip bits in payload without updating CRC8
	if got := rx.DecodePacket(badPkt[:], 100_000); len(got) != 0 {
		t.Fatalf("expected corrupted packet to be rejected by CRC8, got %d frames", len(got))
	}

	// Burst 2 (40 ms later) carries sliding window [1, 2, 3, 4] and heals samples 1 & 2 automatically
	goodPkt := EncodeWindowFrame(3, 4100, -92, samples[:4])
	got := rx.DecodePacket(goodPkt[:], 140_000)
	if len(got) != 4 {
		t.Fatalf("expected all 4 samples healed by next window, got %d", len(got))
	}
	if got[0].TimestampUs != 80_000 || got[1].TimestampUs != 100_000 || got[2].TimestampUs != 120_000 || got[3].TimestampUs != 140_000 {
		t.Fatalf("unexpected reconstructed timestamps: %+v", got)
	}
}
