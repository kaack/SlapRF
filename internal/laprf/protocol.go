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
	HeaderSize int  = 7    // [SOR:1][Len:uint16][CRC:uint16][RecordType:uint16]
)

// RecordType identifies the LapRF command or telemetry block.
type RecordType uint16

const (
	RecordRSSI      RecordType = 0xDA01 // RSSI statistics / streaming rate configuration
	RecordRFSetup   RecordType = 0xDA02 // Read/Write 8-channel pilot RF frequency & threshold configuration
	RecordStateCtrl RecordType = 0xDA04 // Start / Stop race gate state control
	RecordSettings  RecordType = 0xDA07 // Timer name, min lap time & status interval configuration
	RecordDetection RecordType = 0xDA09 // Gate passing detection record sent to host
	RecordStatus    RecordType = 0xDA0A // Periodic 8-slot RSSI & battery voltage heartbeat sent to host
	RecordTime      RecordType = 0xDA0C // Synchronize microsecond Real-Time Clock (RTC) with host
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
// Matches ImmersionRC LapRFProtocol.cs / CRCCalc.cs:
//   unescaped layout: [SOR:1][Len:uint16][CRC:uint16][Type:uint16][TLVs...][EOR:1]
//   where Len is the total unescaped length (including SOR and EOR) and CRC16 is computed
//   over the entire unescaped buffer with bytes 3..4 zeroed.
func (p *Packet) Encode() []byte {
	var raw bytes.Buffer
	// Reserve 7-byte header: [SOR:1][Len:2][CRC:2][Type:2]
	raw.Write([]byte{ByteSOR, 0, 0, 0, 0, 0, 0})

	for _, f := range p.Fields {
		raw.WriteByte(f.Signature)
		raw.WriteByte(uint8(len(f.Data)))
		raw.Write(f.Data)
	}
	raw.WriteByte(ByteEOR)

	buf := raw.Bytes()
	totalLen := uint16(len(buf))
	binary.LittleEndian.PutUint16(buf[1:3], totalLen)
	binary.LittleEndian.PutUint16(buf[3:5], 0) // Zero CRC field before computing CRC16
	binary.LittleEndian.PutUint16(buf[5:7], uint16(p.Type))

	crc := ComputeCRC16(buf)
	binary.LittleEndian.PutUint16(buf[3:5], crc)

	// Escape interior bytes (1 .. len-2) and keep outer SOR / EOR delimiters unescaped
	var wire bytes.Buffer
	wire.Grow(len(buf) + 8)
	wire.WriteByte(ByteSOR)
	for i := 1; i < len(buf)-1; i++ {
		b := buf[i]
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

// DecodeFrame unescapes and parses a raw wire frame bounded by SOR (0x5A) and EOR (0x5B).
func DecodeFrame(wire []byte) (*Packet, error) {
	if len(wire) < 2 || wire[0] != ByteSOR || wire[len(wire)-1] != ByteEOR {
		return nil, errors.New("laprf: missing SOR/EOR frame delimiters")
	}

	raw := make([]byte, 0, len(wire))
	raw = append(raw, ByteSOR)
	for i := 1; i < len(wire)-1; i++ {
		if wire[i] == ByteESC {
			i++
			if i >= len(wire)-1 {
				return nil, errors.New("laprf: truncated escape sequence")
			}
			raw = append(raw, wire[i]-EscOffset)
		} else {
			raw = append(raw, wire[i])
		}
	}
	raw = append(raw, ByteEOR)

	if len(raw) < HeaderSize+1 {
		return nil, errors.New("laprf: frame shorter than header")
	}

	declaredLen := int(binary.LittleEndian.Uint16(raw[1:3]))
	expectedCRC := binary.LittleEndian.Uint16(raw[3:5])
	recType := RecordType(binary.LittleEndian.Uint16(raw[5:7]))

	if declaredLen > len(raw) || declaredLen < HeaderSize+1 {
		return nil, errors.New("laprf: invalid declared frame length")
	}
	raw = raw[:declaredLen]

	// Verify CRC16 with bytes 3..4 zeroed
	crcCheckBuf := make([]byte, len(raw))
	copy(crcCheckBuf, raw)
	crcCheckBuf[3] = 0
	crcCheckBuf[4] = 0
	actualCRC := ComputeCRC16(crcCheckBuf)
	if actualCRC != expectedCRC {
		return nil, errors.New("laprf: CRC16 mismatch")
	}

	pkt := &Packet{Type: recType}
	pos := HeaderSize
	end := len(raw) - 1 // stop before trailing EOR
	for pos < end {
		sig := raw[pos]
		if sig == ByteEOR {
			break
		}
		if pos+2 > end {
			break
		}
		size := int(raw[pos+1])
		pos += 2
		if pos+size > end {
			return nil, errors.New("laprf: TLV field exceeds packet boundary")
		}
		data := make([]byte, size)
		copy(data, raw[pos:pos+size])
		pkt.Fields = append(pkt.Fields, TLVField{Signature: sig, Data: data})
		pos += size
	}

	return pkt, nil
}

func reflectBits(in uint16, nbits int) uint16 {
	var out uint16
	for i := 0; i < nbits; i++ {
		if (in & 0x01) != 0 {
			out |= 1 << ((nbits - 1) - i)
		}
		in >>= 1
	}
	return out
}

var crc16Table = func() [256]uint16 {
	var table [256]uint16
	for i := uint16(0); i < 256; i++ {
		rem := (i << 8) & 0xFF00
		for j := 8; j > 0; j-- {
			if (rem & 0x8000) != 0 {
				rem = ((rem << 1) & 0xFFFF) ^ 0x8005
			} else {
				rem = (rem << 1) & 0xFFFF
			}
		}
		table[i] = rem
	}
	return table
}()

// ComputeCRC16 computes the ImmersionRC LapRF reflected CRC-16/ARC (polynomial 0x8005, reflected in/out).
func ComputeCRC16(data []byte) uint16 {
	var rem uint16 = 0x0000
	for _, b := range data {
		a := reflectBits(uint16(b), 8) & 0xFF
		hi := (rem >> 8) & 0xFF
		lo := (rem << 8) & 0xFFFF
		idx := (a ^ hi) & 0xFF
		rem = crc16Table[idx] ^ lo
	}
	return reflectBits(rem, 16)
}

// BuildDetectionPacket creates a 0xDA09 passing record for LapRF 8-Way clients.
// Note: Only the 4 canonical fields (0x01, 0x21, 0x22, 0x02) may be emitted, and 0x02 (RTC_TIME)
// MUST be last because LapRFProtocol.cs does not skip unknown field signatures and enqueues the
// PassingRecord immediately upon decoding field 0x02.
func BuildDetectionPacket(
	slotIndex uint8,
	rtcTimeUs uint64,
	passingNumber uint32,
	peakHeight float32,
) *Packet {
	pkt := &Packet{Type: RecordDetection}
	pkt.AppendUint8(0x01, slotIndex)      // Pilot Slot (1..8)
	pkt.AppendUint32(0x21, passingNumber) // Monotonic passing number
	peakU16 := uint16(0)
	if peakHeight > 0 {
		if peakHeight > 65535 {
			peakU16 = 65535
		} else {
			peakU16 = uint16(peakHeight)
		}
	}
	pkt.AppendUint16(0x22, peakU16)   // Detection peak height (uint16)
	pkt.AppendUint64(0x02, rtcTimeUs) // 64-bit RTC Time in microseconds (must be last)
	return pkt
}
