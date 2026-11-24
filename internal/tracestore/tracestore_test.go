package tracestore

import (
	"math"
	"testing"
)

func TestFileAndMemoryStoreRoundTripAndTruncatedTailRecovery(t *testing.T) {
	dir := t.TempDir()
	fs, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	defer fs.Close()

	ms := NewMemoryStore()
	defer ms.Close()

	for name, st := range map[string]Store{"file": fs, "memory": ms} {
		t.Run(name, func(t *testing.T) {
			sid := "session-1001"
			ts := uint64(5_000_000)
			for i := 0; i < 300; i++ {
				gateID := uint8((i % 4) + 1)
				st.Append(sid, Sample{
					GateID:        gateID,
					SeqNum:        uint32(i),
					TimestampUs:   ts,
					NoiseFloorDbm: -91.0,
					SlotIndices:   []uint8{1},
					RSSIDbm:       []float32{-91.0 + float32(i%35)*0.75},
				})
				if i == 150 {
					// Simulate a 12-second lull exceeding the 6.55s delta window.
					ts += 12_000_000
				} else {
					ts += 10_000
				}
			}
			// Append second pilot mid-session.
			st.Append(sid, Sample{
				GateID:        1,
				SeqNum:        301,
				TimestampUs:   ts,
				NoiseFloorDbm: -90.0,
				SlotIndices:   []uint8{1, 4},
				RSSIDbm:       []float32{-54.25, -67.80},
			})

			sum := st.SealSession(sid)
			if sum.SampleCount != 301 {
				t.Fatalf("expected 301 samples, got %d", sum.SampleCount)
			}
			if sum.DurationSec < 14.9 || sum.DurationSec > 15.1 {
				t.Fatalf("expected ~15.0s duration, got %.3f", sum.DurationSec)
			}

			got, err := st.ReadSession(sid)
			if err != nil {
				t.Fatalf("ReadSession: %v", err)
			}
			if len(got) != 301 {
				t.Fatalf("expected 301 decoded samples, got %d", len(got))
			}
			last := got[len(got)-1]
			if len(last.SlotIndices) != 2 || last.SlotIndices[1] != 4 {
				t.Fatalf("expected [1,4] slots on last sample, got %v", last.SlotIndices)
			}
			if math.Abs(float64(last.RSSIDbm[0] - -54.25)) > 0.06 || math.Abs(float64(last.RSSIDbm[1] - -67.80)) > 0.06 {
				t.Fatalf("unexpected quantized RSSI: %v", last.RSSIDbm)
			}

			frames := ToTelemetryFrames(got[len(got)-1:])
			if len(frames) != 1 || math.Abs(float64(frames[0].RSSI[0] - -54.25)) > 0.06 || math.Abs(float64(frames[0].RSSI[3] - -67.80)) > 0.06 {
				t.Fatalf("unexpected ToTelemetryFrames conversion: rssi[0]=%.2f rssi[3]=%.2f", frames[0].RSSI[0], frames[0].RSSI[3])
			}

			raw, err := st.ReadRawBytes(sid)
			if err != nil || len(raw) < 32 {
				t.Fatalf("ReadRawBytes failed: len=%d err=%v", len(raw), err)
			}
			// Simulate abrupt power loss mid-record by chopping the last 3 bytes.
			truncated, err := DecodeSamples(raw[:len(raw)-3])
			if err != nil {
				t.Fatalf("expected clean partial recovery on truncated tail, got err=%v", err)
			}
			if len(truncated) != 300 {
				t.Fatalf("expected 300 intact samples before truncated tail, got %d", len(truncated))
			}
		})
	}
}
