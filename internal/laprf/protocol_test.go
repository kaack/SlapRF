package laprf

import (
	"encoding/binary"
	"testing"
)

func TestLapRFRoundTripAndEscaping(t *testing.T) {
	// Include magic bytes 0x5A, 0x5B, 0x5C inside the timestamp to exercise byte stuffing
	rtcTime := uint64(0x005A5B5C11223344)
	pkt := BuildDetectionPacket(3, rtcTime, 42, 2450.5)

	wire := pkt.Encode()
	if wire[0] != ByteSOR || wire[len(wire)-1] != ByteEOR {
		t.Fatalf("expected SOR/EOR delimiters, got %x .. %x", wire[0], wire[len(wire)-1])
	}

	// Ensure no unescaped SOR/EOR exists inside the body
	for i := 1; i < len(wire)-1; i++ {
		if wire[i] == ByteSOR || wire[i] == ByteEOR {
			t.Fatalf("found unescaped control byte 0x%x at index %d", wire[i], i)
		}
	}

	decoded, err := DecodeFrame(wire)
	if err != nil {
		t.Fatalf("DecodeFrame failed: %v", err)
	}
	if decoded.Type != RecordDetection {
		t.Fatalf("expected RecordDetection (0x%x), got 0x%x", RecordDetection, decoded.Type)
	}

	var gotSlot uint8
	var gotRTC uint64
	var gotPass uint32
	for _, f := range decoded.Fields {
		switch f.Signature {
		case 0x01:
			gotSlot = f.Data[0]
		case 0x02:
			gotRTC = binary.LittleEndian.Uint64(f.Data)
		case 0x21:
			gotPass = binary.LittleEndian.Uint32(f.Data)
		}
	}

	if gotSlot != 3 {
		t.Errorf("expected slot 3, got %d", gotSlot)
	}
	if gotRTC != rtcTime {
		t.Errorf("expected RTC 0x%x, got 0x%x", rtcTime, gotRTC)
	}
	if gotPass != 42 {
		t.Errorf("expected passing 42, got %d", gotPass)
	}
}
