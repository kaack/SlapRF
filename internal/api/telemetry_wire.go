package api

import (
	"encoding/binary"
	"math"

	"slaprf/internal/domain"
)

// EncodeTelemetryBatch appends the compact little-endian binary telemetry batch decoded by
// `decodeTelemetryBatch` in `web/src/services/wasm_transport.ts`:
//
//	Header: [version=1 u8][rssiCount u8][count u16]
//	Per frame: [timerId u8][0 u8][batteryMv u16][seqNum u32][timestampUs f64][noiseFloorDbm f32][rssi f32 * rssiCount]
func EncodeTelemetryBatch(dst []byte, frames []domain.TimerTelemetryFrame, rssiCount int) []byte {
	if rssiCount < domain.MaxPilotSlots {
		rssiCount = domain.MaxPilotSlots
	} else if rssiCount > domain.MaxPilotPoolSize {
		rssiCount = domain.MaxPilotPoolSize
	}
	recLen := 20 + 4*rssiCount
	n := len(frames)
	if n > 0xFFFF {
		n = 0xFFFF
	}
	need := 4 + n*recLen
	if cap(dst) < need {
		dst = make([]byte, 0, need*2)
	}
	b := dst[:need]
	b[0] = 1
	b[1] = uint8(rssiCount)
	binary.LittleEndian.PutUint16(b[2:4], uint16(n))
	o := 4
	for i := 0; i < n; i++ {
		f := &frames[i]
		b[o] = f.TimerID
		b[o+1] = 0
		binary.LittleEndian.PutUint16(b[o+2:], f.BatteryMv)
		binary.LittleEndian.PutUint32(b[o+4:], f.SeqNum)
		binary.LittleEndian.PutUint64(b[o+8:], math.Float64bits(float64(f.TimestampUs)))
		binary.LittleEndian.PutUint32(b[o+16:], math.Float32bits(f.NoiseFloorDbm))
		for k := 0; k < rssiCount; k++ {
			binary.LittleEndian.PutUint32(b[o+20+4*k:], math.Float32bits(f.RSSI[k]))
		}
		o += recLen
	}
	return b
}
