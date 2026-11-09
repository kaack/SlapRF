package ingest

import (
	"testing"

	"slaprf/internal/domain"
	"slaprf/internal/tracker"
)

func TestSlidingWindowRecovers100PercentUnder50PercentPacketLoss(t *testing.T) {
	eng := tracker.NewRealEngine()
	rx := NewWiFiUDPReceiver(":0", eng)
	rx.IngestPacket(EncodeHelloFrame(2, 2, 0x00000002, 1, 50, "S1"), 0)

	// Simulate 40 consecutive 20 ms 5.8 GHz sweeps (seq 240..255, wrapping around to 0..23)
	const totalSweeps = 40
	var ring []domain.TimerTelemetryFrame
	var recovered []domain.TimerTelemetryFrame

	var nowUs uint64 = 1_000_000
	burstIdx := 0

	for step := 0; step < totalSweeps; step++ {
		seq := uint8(240 + step) // Exercises 8-bit rollover (255 -> 0)
		var rssi [domain.MaxPilotPoolSize]float32
		rssi[0] = -80.0 + float32(step%15)

		ring = append(ring, domain.TimerTelemetryFrame{
			TimerID:       2,
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
	rx.IngestPacket(EncodeHelloFrame(3, 2, 0x00000003, 1, 50, "S2"), 0)

	var samples [4]domain.TimerTelemetryFrame
	for i := 0; i < 4; i++ {
		samples[i] = domain.TimerTelemetryFrame{TimerID: 3, SeqNum: uint32(i + 1)}
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

func TestHelloMapsHubSlotToStableTimerByFingerprint(t *testing.T) {
	eng := tracker.NewRealEngine()
	rx := NewWiFiUDPReceiver(":0", eng)

	// Board announces itself in Hub slot 5 running the 100 Hz indoor profile.
	rx.IngestPacket(EncodeHelloFrame(5, 2, 0xCAFEBABE, 3, 100, "S7"), 0)

	var timerID uint8
	for _, d := range eng.DetectedTimersSnapshot() {
		if d.Fingerprint == "CAFEBABE" {
			timerID = d.TimerID
			if d.TimerLabel != "S7" || d.FirmwareProfile != "indoor" {
				t.Fatalf("unexpected registered timer: %+v", d)
			}
		}
	}
	if timerID == 0 {
		t.Fatal("expected Hello to register the fingerprinted timer")
	}

	samples := []domain.TimerTelemetryFrame{{SeqNum: 1}, {SeqNum: 2}}
	got := rx.DecodePacket(EncodeWindowFrame(5, 4100, -92, samples), 1_000_000)
	if len(got) != 2 || got[0].TimerID != timerID {
		t.Fatalf("expected slot 5 frames to map to timer %d, got %+v", timerID, got)
	}
	if got[0].TimestampUs != 1_000_000-10_000 {
		t.Fatalf("expected 10 ms spacing for 100 Hz profile, got %d", got[0].TimestampUs)
	}

	// Re-joining in a different slot keeps the same stable timer ID.
	rx.IngestPacket(EncodeHelloFrame(2, 2, 0xCAFEBABE, 3, 100, "S7"), 0)
	got = rx.DecodePacket(EncodeWindowFrame(2, 4100, -92, []domain.TimerTelemetryFrame{{SeqNum: 9}}), 2_000_000)
	if len(got) != 1 || got[0].TimerID != timerID {
		t.Fatalf("expected re-joined board to keep timer %d, got %+v", timerID, got)
	}
}

func TestFramesFromUnannouncedSlotAreDropped(t *testing.T) {
	eng := tracker.NewRealEngine()
	rx := NewWiFiUDPReceiver(":0", eng)
	if got := rx.DecodePacket(EncodeWindowFrame(4, 4100, -92, []domain.TimerTelemetryFrame{{SeqNum: 1}}), 1_000_000); len(got) != 0 {
		t.Fatalf("expected frames from a slot without HELLO to be dropped, got %d", len(got))
	}
}

func TestSelectivePilotChannelTableAndUpperPoolMapping(t *testing.T) {
	eng := tracker.NewEngine()
	// By default in NewEngine(), Pilots 1..4 (indices 0..3) are enabled on R1(5658), R3(5732), R5(5806), R8(5917)
	// and Pilots 5..10 are disabled.
	freqs, slotToPilot := eng.ActivePilotChannels()
	wantFreqs := [domain.MaxPilotSlots]uint16{5658, 5732, 5806, 5917, 0, 0, 0, 0}
	if freqs != wantFreqs {
		t.Fatalf("expected active pilot channel table %v, got %v", wantFreqs, freqs)
	}
	if slotToPilot[0] != 0 || slotToPilot[1] != 1 || slotToPilot[2] != 2 || slotToPilot[3] != 3 {
		t.Fatalf("unexpected default slotToPilot mapping: %v", slotToPilot)
	}

	// Enable Pilot 10 (SlotIndex 10, array index 9) on R6 (5843 MHz): should claim free hardware slot 4.
	eng.UpdatePilotSlot(domain.PilotSlot{
		SlotIndex:    10,
		Callsign:     "FreeLove",
		Band:         domain.BandRaceband,
		Channel:      6,
		FrequencyMHz: 5843,
		Enabled:      true,
	})
	freqs, slotToPilot = eng.ActivePilotChannels()
	if freqs[4] != 5843 || slotToPilot[4] != 9 {
		t.Fatalf("expected Pilot 10 (idx 9) to claim hardware slot 4 at 5843 MHz, got freqs=%v slotToPilot=%v", freqs, slotToPilot)
	}

	pkt := EncodeChannelsFrame(freqs)
	if len(pkt) != ChannelsFrameLen || pkt[0] != FrameMagic0 || pkt[1] != FrameMagicChannels || !validCRC8(pkt) {
		t.Fatalf("invalid channels frame: %x", pkt)
	}

	rx := NewWiFiUDPReceiver(":0", eng)
	rx.IngestPacket(EncodeHelloFrame(1, 1, 0xBE7C0001, 3, 100, "H1"), 0)
	var sample domain.TimerTelemetryFrame
	sample.SeqNum = 1
	sample.RSSI[4] = -47 // Hardware slot 4 carries Pilot 10's RSSI
	decoded := rx.DecodePacket(EncodeWindowFrame(1, 4100, -92, []domain.TimerTelemetryFrame{sample}), 100_000)
	if len(decoded) != 1 || decoded[0].RSSI[9] != -47 {
		t.Fatalf("expected hardware slot 4 RSSI (-47 dBm) to map to Pilot 10 (idx 9), got %+v", decoded)
	}
}
