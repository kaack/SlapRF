package ingest

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"io"
	"log"

	"slaprf/internal/domain"
	"slaprf/internal/tracker"
)

// BinaryDongleFrameMagic marks the start of a compact 16-byte binary ESP-NOW telemetry frame
// forwarded by the Laptop USB XIAO ESP32-C5 receiver dongle:
// [Magic:2 = 0xC5 0x58][PuckID:1][Seq:1][BatteryMv:2][NoiseFloor:1 (int8)][RSSI_0..7:8 (int8 dBm)][CRC8:1]
const (
	MagicByte0     byte = 0xC5
	MagicByte1     byte = 0x58
	BinaryFrameLen      = 16
)

// DongleReceiver ingests live 5.8 GHz RSSI streams from the USB XIAO ESP32-C5 receiver dongle.
type DongleReceiver struct {
	engine *tracker.Engine
}

// NewDongleReceiver creates a hardware stream receiver coupled to the timing engine.
func NewDongleReceiver(engine *tracker.Engine) *DongleReceiver {
	return &DongleReceiver{engine: engine}
}

// ConsumeJSONStream reads line-delimited JSON frames emitted by the USB XIAO ESP32-C5 dongle over USB-CDC Serial.
func (d *DongleReceiver) ConsumeJSONStream(r io.Reader) error {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var frame domain.PuckTelemetryFrame
		if err := json.Unmarshal(line, &frame); err != nil {
			log.Printf("[DongleReceiver] Malformed JSON frame: %v", err)
			continue
		}
		d.engine.IngestTelemetryFrame(frame)
	}
	return scanner.Err()
}

// ParseBinaryFrame decodes a 16-byte compact binary ESP-NOW frame from a XIAO ESP32-C5 Gate Puck.
func ParseBinaryFrame(raw []byte, nowUs uint64) (*domain.PuckTelemetryFrame, bool) {
	if len(raw) < BinaryFrameLen || raw[0] != MagicByte0 || raw[1] != MagicByte1 {
		return nil, false
	}
	puckID := raw[2]
	seq := uint32(raw[3])
	battMv := binary.LittleEndian.Uint16(raw[4:6])
	noiseFloor := float32(int8(raw[6]))

	var rssi [domain.MaxPilotSlots]float32
	for i := 0; i < domain.MaxPilotSlots; i++ {
		rssi[i] = float32(int8(raw[7+i]))
	}

	return &domain.PuckTelemetryFrame{
		PuckID:        puckID,
		SeqNum:        seq,
		TimestampUs:   nowUs,
		RSSI:          rssi,
		BatteryMv:     battMv,
		NoiseFloorDbm: noiseFloor,
	}, true
}
