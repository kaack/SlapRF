package laprf

import (
	"bytes"
	"encoding/binary"
	"errors"
	"math"
)

// Framing bytes for ImmersionRC LapRF binary wire protocol.
const (
	ByteSOR    byte = 0x5A // Start of Record
	ByteEOR    byte = 0x5B // End of Record
	ByteESC    byte = 0x5C // Escape prefix
	EscOffset  byte = 0x40 // Added when escaping, subtracted when unescaping
	HeaderSize int  = 6    // [Len:uint16][CRC:uint16][RecordType:uint16]
)

// RecordType identifies the LapRF command or telemetry block.
type RecordType uint16

const (
	RecordRFSetup    RecordType = 0xDA01 // Read/Write 8-channel pilot RF frequency & threshold configuration
	RecordTime       RecordType = 0xDA02 // Synchronize microsecond Real-Time Clock (RTC) with LiveTime
	RecordSettings   RecordType = 0xDA07 // Timer name & status interval configuration
	RecordDescriptor RecordType = 0xDA04 // Version & capability descriptor
	RecordStateCtrl  RecordType = 0xDA08 // Start / Stop race gate state control
	RecordDetection  RecordType = 0xDA09 // Gate passing detection record sent to LiveTime
	RecordStatus     RecordType = 0xDA0A // Periodic 8-slot RSSI & battery voltage heartbeat sent to LiveTime
)

// TLV Field represents a single [Signature][Size][Data] tuple inside a LapRF frame.
type TLVField struct {
	Signature uint8
	Data      []byte
}

// Packet represents a decoded LapRF protocol frame.
type Packet struct {
	Type   RecordType
	Fields []TLVField
}

// AppendUint8 adds a 1-byte unsigned integer TLV field.
func (p *Packet) AppendUint8(sig uint8, val uint8) {
	p.Fields = append(p.Fields, TLVField{Signature: sig, Data: []byte{val}})
}

// AppendUint16 adds a 2-byte little-endian unsigned integer TLV field.
func (p *Packet) AppendUint16(sig uint8, val uint16) {
	b := make([]byte, 2)
	binary.LittleEndian.PutUint16(b, val)
	p.Fields = append(p.Fields, TLVField{Signature: sig, Data: b})
}

// AppendUint32 adds a 4-byte little-endian unsigned integer TLV field.
func (p *Packet) AppendUint32(sig uint8, val uint32) {
	b := make([]byte, 4)
	binary.LittleEndian.PutUint32(b, val)
	p.Fields = append(p.Fields, TLVField{Signature: sig, Data: b})
}

// AppendUint64 adds an 8-byte little-endian unsigned integer TLV field (e.g., RTC microseconds).
func (p *Packet) AppendUint64(sig uint8, val uint64) {
	b := make([]byte, 8)
	binary.LittleEndian.PutUint64(b, val)
	p.Fields = append(p.Fields, TLVField{Signature: sig, Data: b})
}

// AppendFloat32 adds a 4-byte IEEE-754 little-endian float32 TLV field (e.g., RSSI, PeakHeight, Threshold).
func (p *Packet) AppendFloat32(sig uint8, val float32) {
	b := make([]byte, 4)
	binary.LittleEndian.PutUint32(b, math.Float32bits(val))
	p.Fields = append(p.Fields, TLVField{Signature: sig, Data: b})
}

// Encode serializes a Packet into a CRC-signed, byte-escaped wire frame bounded by SOR (0x5A) and EOR (0x5B).
func (p *Packet) Encode() []byte {
	var raw bytes.Buffer
	// Reserve 6-byte header: [Len:2][CRC:2][Type:2]
	raw.Write([]byte{0, 0, 0, 0, 0, 0})

	for _, f := range p.Fields {
		raw.WriteByte(f.Signature)
		raw.WriteByte(uint8(len(f.Data)))
		raw.Write(f.Data)
	}

	buf := raw.Bytes()
	totalLen := uint16(len(buf))
	binary.LittleEndian.PutUint16(buf[0:2], totalLen)
	binary.LittleEndian.PutUint16(buf[2:4], 0) // Zero CRC field before computing CRC16
	binary.LittleEndian.PutUint16(buf[4:6], uint16(p.Type))

	crc := ComputeCRC16(buf)
	binary.LittleEndian.PutUint16(buf[2:4], crc)

	// Escape payload and wrap in SOR / EOR
	var wire bytes.Buffer
	wire.Grow(len(buf) + 8)
	wire.WriteByte(ByteSOR)
	for _, b := range buf {
		if b == ByteSOR || b == ByteEOR || b == ByteESC {
			wire.WriteByte(ByteESC)
			wire.WriteByte(b + EscOffset)
		} else {
			wire.WriteByte(b)
		}
	}
	wire.WriteByte(ByteEOR)
	return wire.Bytes()
}

// DecodeFrame unescapes and parses a raw wire frame (including or excluding outer SOR/EOR bytes).
func DecodeFrame(wire []byte) (*Packet, error) {
	if len(wire) >= 2 && wire[0] == ByteSOR && wire[len(wire)-1] == ByteEOR {
		wire = wire[1 : len(wire)-1]
	}

	raw := make([]byte, 0, len(wire))
	for i := 0; i < len(wire); i++ {
		if wire[i] == ByteESC {
			i++
			if i >= len(wire) {
				return nil, errors.New("laprf: truncated escape sequence")
			}
			raw = append(raw, wire[i]-EscOffset)
		} else {
			raw = append(raw, wire[i])
		}
	}

	if len(raw) < HeaderSize {
		return nil, errors.New("laprf: frame shorter than 6-byte header")
	}

	declaredLen := int(binary.LittleEndian.Uint16(raw[0:2]))
	expectedCRC := binary.LittleEndian.Uint16(raw[2:4])
	recType := RecordType(binary.LittleEndian.Uint16(raw[4:6]))

	if declaredLen > len(raw) {
		return nil, errors.New("laprf: declared length exceeds frame size")
	}
	raw = raw[:declaredLen]

	// Verify CRC16 with bytes 2..3 zeroed
	crcCheckBuf := make([]byte, len(raw))
	copy(crcCheckBuf, raw)
	crcCheckBuf[2] = 0
	crcCheckBuf[3] = 0
	actualCRC := ComputeCRC16(crcCheckBuf)
	if actualCRC != expectedCRC {
		return nil, errors.New("laprf: CRC16 mismatch")
	}

	pkt := &Packet{Type: recType}
	pos := HeaderSize
	for pos < len(raw) {
		if pos+2 > len(raw) {
			break
		}
		sig := raw[pos]
		size := int(raw[pos+1])
		pos += 2
		if pos+size > len(raw) {
			return nil, errors.New("laprf: TLV field exceeds packet boundary")
		}
		data := make([]byte, size)
		copy(data, raw[pos:pos+size])
		pkt.Fields = append(pkt.Fields, TLVField{Signature: sig, Data: data})
		pos += size
	}

	return pkt, nil
}

// ComputeCRC16 computes the ImmersionRC LapRF reflected CRC-16-CCITT (polynomial 0x1021).
func ComputeCRC16(data []byte) uint16 {
	var crc uint16 = 0x0000
	for _, b := range data {
		crc ^= uint16(b) << 8
		for i := 0; i < 8; i++ {
			if (crc & 0x8000) != 0 {
				crc = (crc << 1) ^ 0x1021
			} else {
				crc <<= 1
			}
		}
	}
	return crc
}

// BuildDetectionPacket creates a 0xDA09 passing record for MultiGP LiveTime.
func BuildDetectionPacket(
	slotIndex uint8,
	rtcTimeUs uint64,
	passingNumber uint32,
	peakHeight float32,
) *Packet {
	pkt := &Packet{Type: RecordDetection}
	pkt.AppendUint32(0x20, uint32(slotIndex)) // Decoder / Pilot ID
	pkt.AppendUint8(0x01, slotIndex)          // Pilot Slot (1..8)
	pkt.AppendUint64(0x02, rtcTimeUs)         // 64-bit RTC Time in microseconds
	pkt.AppendUint32(0x21, passingNumber)     // Monotonic passing number
	pkt.AppendFloat32(0x22, peakHeight)       // Peak height
	pkt.AppendUint16(0x23, 0x0001)            // Valid passing flag
	return pkt
}
