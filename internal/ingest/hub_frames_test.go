package ingest

import (
	"testing"

	"slaprf/internal/domain"
	"slaprf/internal/firmware"
	"slaprf/internal/tracker"
)

func TestSlidingWindowRecovers100PercentUnder50PercentPacketLoss(t *testing.T) {
	eng := tracker.NewRealEngine()
	rx := NewHubFrameDecoder(eng)
	rx.IngestPacket(EncodeHelloFrame(2, 2, 0x00000002, firmware.SweepHz, "S1"), 0)

	// Simulate 40 consecutive 10 ms 5.8 GHz sweeps (seq 240..255, wrapping around to 0..23)
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
	rx := NewHubFrameDecoder(eng)
	rx.IngestPacket(EncodeHelloFrame(3, 2, 0x00000003, firmware.SweepHz, "S2"), 0)

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

	// Burst 2 (40 ms later, 10 ms sweeps) carries sliding window [1, 2, 3, 4] and heals samples 1 & 2 automatically
	goodPkt := EncodeWindowFrame(3, 4100, -92, samples[:4])
	got := rx.DecodePacket(goodPkt[:], 140_000)
	if len(got) != 4 {
		t.Fatalf("expected all 4 samples healed by next window, got %d", len(got))
	}
	if got[0].TimestampUs != 110_000 || got[1].TimestampUs != 120_000 || got[2].TimestampUs != 130_000 || got[3].TimestampUs != 140_000 {
		t.Fatalf("unexpected reconstructed timestamps: %+v", got)
	}
}

func TestHelloMapsHubSlotToStableTimerByFingerprint(t *testing.T) {
	eng := tracker.NewRealEngine()
	rx := NewHubFrameDecoder(eng)

	// Board announces itself in Hub slot 5 sweeping at 100 Hz.
	rx.IngestPacket(EncodeHelloFrame(5, 2, 0xCAFEBABE, 100, "S7"), 0)

	var timerID uint8
	for _, d := range eng.DetectedTimersSnapshot() {
		if d.Fingerprint == "CAFEBABE" {
			timerID = d.TimerID
			if d.TimerLabel != "S7" {
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
		t.Fatalf("expected 10 ms spacing for 100 Hz sweeps, got %d", got[0].TimestampUs)
	}

	// Re-joining in a different slot keeps the same stable timer ID.
	rx.IngestPacket(EncodeHelloFrame(2, 2, 0xCAFEBABE, 100, "S7"), 0)
	got = rx.DecodePacket(EncodeWindowFrame(2, 4100, -92, []domain.TimerTelemetryFrame{{SeqNum: 9}}), 2_000_000)
	if len(got) != 1 || got[0].TimerID != timerID {
		t.Fatalf("expected re-joined board to keep timer %d, got %+v", timerID, got)
	}
}

func TestFramesFromUnannouncedSlotAreDropped(t *testing.T) {
	eng := tracker.NewRealEngine()
	rx := NewHubFrameDecoder(eng)
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

	rx := NewHubFrameDecoder(eng)
	rx.IngestPacket(EncodeHelloFrame(1, 1, 0xBE7C0001, 100, "H1"), 0)
	var sample domain.TimerTelemetryFrame
	sample.SeqNum = 1
	sample.RSSI[4] = -47 // Hardware slot 4 carries Pilot 10's RSSI
	decoded := rx.DecodePacket(EncodeWindowFrame(1, 4100, -92, []domain.TimerTelemetryFrame{sample}), 100_000)
	if len(decoded) != 1 || decoded[0].RSSI[9] != -47 {
		t.Fatalf("expected hardware slot 4 RSSI (-47 dBm) to map to Pilot 10 (idx 9), got %+v", decoded)
	}
}

func TestDecodeWindowFrameHalfDbResolution(t *testing.T) {
	eng := tracker.NewRealEngine()
	rx := NewHubFrameDecoder(eng)
	rx.IngestPacket(EncodeHelloFrame(2, 2, 0xABCD1234, 100, "T1"), 100_000)

	var sample domain.TimerTelemetryFrame
	sample.SeqNum = 42
	sample.RSSI[0] = -89.5
	sample.RSSI[1] = -42.5
	sample.RSSI[2] = -127.0
	sample.RSSI[3] = 0.0
	pkt := EncodeWindowFrame(2, 4100, -91, []domain.TimerTelemetryFrame{sample})

	frames := rx.DecodePacket(pkt, 120_000)
	if len(frames) != 1 {
		t.Fatalf("expected 1 decoded frame from 0x60 packet, got %d", len(frames))
	}
	if frames[0].RSSI[0] != -89.5 || frames[0].RSSI[1] != -42.5 || frames[0].RSSI[2] != -127.0 || frames[0].RSSI[3] != 0.0 {
		t.Fatalf("unexpected 0.5 dB decoded values: %v", frames[0].RSSI[:4])
	}
}

func TestSlotRebindsCleanlyWhenEngineResetReassignsTimerIDs(t *testing.T) {
	eng := tracker.NewRealEngine()
	rx := NewHubFrameDecoder(eng)

	// Initial session: T2 (tdma=4) registers first -> gets timerID=2;
	// T1 (tdma=3) -> timerID=3; T3 (tdma=2) -> timerID=4; H1 (tdma=1) -> timerID=1.
	rx.BindSlotHello(1, "EFE44224", true, 50, "H1")
	rx.BindSlotHello(4, "7B1C4D9C", false, 100, "T2")
	rx.BindSlotHello(3, "D3FEDE5D", false, 100, "T1")
	rx.BindSlotHello(2, "53E049F7", false, 100, "T3")

	for slot := uint8(1); slot <= 4; slot++ {
		rx.IngestPacket(EncodeWindowFrame(slot, 4100, -91, []domain.TimerTelemetryFrame{{SeqNum: 1}}), 100_000)
	}

	// Wipe Engine timers (simulating POST /v1/storage:reset while BLE Hub stays connected).
	// T1 (tdma=3) transmits a window frame FIRST and claims timerID=2 (previously held by T2 on tdma=4!).
	eng.ResetToFactoryDefaults(false)
	rx.IngestPacket(EncodeWindowFrame(3, 4100, -91, []domain.TimerTelemetryFrame{{SeqNum: 2}}), 200_000)
	rx.IngestPacket(EncodeWindowFrame(2, 4100, -91, []domain.TimerTelemetryFrame{{SeqNum: 2}}), 210_000)

	// Next STATUS? push arrives and calls BindSlotHello for all 4 timers (allocating timerID=4 to T2).
	// Previously BindSlotHello(4, "7B1C4D9C", ...) saw HasDetectedTimer(2)==true (owned by T1!) and
	// left r.slots[4].timerID=2, starving T2 (timerID=4) at 0 samples while double-feeding T1.
	rx.BindSlotHello(1, "EFE44224", true, 50, "H1")
	rx.BindSlotHello(2, "53E049F7", false, 100, "T3")
	rx.BindSlotHello(3, "D3FEDE5D", false, 100, "T1")
	rx.BindSlotHello(4, "7B1C4D9C", false, 100, "T2")

	// Feed 3 new samples on every TDMA slot (1..4).
	for step := uint8(10); step < 13; step++ {
		nowUs := uint64(300_000) + uint64(step)*10_000
		for slot := uint8(1); slot <= 4; slot++ {
			var s domain.TimerTelemetryFrame
			s.SeqNum = uint32(step)
			s.RSSI[0] = -90.0 - float32(slot)
			rx.IngestPacket(EncodeWindowFrame(slot, 4100, -91, []domain.TimerTelemetryFrame{s}), nowUs)
		}
	}

	byFP := make(map[string]domain.DetectedTimer)
	for _, dt := range eng.DetectedTimersSnapshot() {
		byFP[dt.Fingerprint] = dt
	}
	for _, wantFP := range []string{"EFE44224", "53E049F7", "D3FEDE5D", "7B1C4D9C"} {
		dt, ok := byFP[wantFP]
		if !ok {
			t.Fatalf("missing detected timer for fp=%s", wantFP)
		}
		if dt.FramesRxCount < 3 {
			t.Fatalf("fp=%s (%s, timerID=%d) expected >=3 samples after reset, got %d", wantFP, dt.TimerLabel, dt.TimerID, dt.FramesRxCount)
		}
	}
	// T1 must have 1 + 3 = 4 samples (never polluted by T2's 3 samples), and T2 must have 3 samples.
	if byFP["D3FEDE5D"].FramesRxCount != 4 {
		t.Fatalf("expected T1 (D3FEDE5D) to have exact 4 samples without T2 cross-talk, got %d", byFP["D3FEDE5D"].FramesRxCount)
	}
	if byFP["7B1C4D9C"].FramesRxCount != 3 {
		t.Fatalf("expected T2 (7B1C4D9C) to have exact 3 samples, got %d", byFP["7B1C4D9C"].FramesRxCount)
	}

	// Also verify TDMA slot migration: if Hub reboots and T2 moves from slot 4 to slot 5, old slot 4 is evicted.
	rx.BindSlotHello(5, "7B1C4D9C", false, 100, "T2")
	if got := rx.DecodePacket(EncodeWindowFrame(4, 4100, -91, []domain.TimerTelemetryFrame{{SeqNum: 30}}), 500_000); len(got) != 0 {
		t.Fatalf("expected stale TDMA slot 4 to be evicted after T2 moved to slot 5, got %d frames", len(got))
	}
	if got := rx.DecodePacket(EncodeWindowFrame(5, 4100, -91, []domain.TimerTelemetryFrame{{SeqNum: 31}}), 510_000); len(got) != 1 || got[0].TimerID != byFP["7B1C4D9C"].TimerID {
		t.Fatalf("expected new TDMA slot 5 to route to T2 timerID=%d, got %+v", byFP["7B1C4D9C"].TimerID, got)
	}
}
