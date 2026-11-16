package api

import (
	"encoding/binary"
	"math"
	"testing"

	"slaprf/internal/domain"
)

func TestEncodeTelemetryBatch(t *testing.T) {
	var frame domain.TimerTelemetryFrame
	frame.TimerID = 3
	frame.BatteryMv = 4120
	frame.SeqNum = 42
	frame.TimestampUs = 1_250_000
	frame.NoiseFloorDbm = -94.5
	frame.RSSI[0] = -62.25
	frame.RSSI[7] = -88.0

	raw := EncodeTelemetryBatch(nil, []domain.TimerTelemetryFrame{frame}, 8)
	wantLen := 4 + (20 + 4*8)
	if len(raw) != wantLen {
		t.Fatalf("len(raw) = %d, want %d", len(raw), wantLen)
	}
	if raw[0] != 1 || raw[1] != 8 {
		t.Fatalf("header = [%d, %d], want [1, 8]", raw[0], raw[1])
	}
	if cnt := binary.LittleEndian.Uint16(raw[2:4]); cnt != 1 {
		t.Fatalf("count = %d, want 1", cnt)
	}
	if raw[4] != 3 {
		t.Fatalf("timerId = %d, want 3", raw[4])
	}
	if batt := binary.LittleEndian.Uint16(raw[6:8]); batt != 4120 {
		t.Fatalf("batteryMv = %d, want 4120", batt)
	}
	r0 := math.Float32frombits(binary.LittleEndian.Uint32(raw[24:28]))
	if r0 != -62.25 {
		t.Fatalf("rssi[0] = %v, want -62.25", r0)
	}
}
