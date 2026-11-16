package firmware

import (
	"bytes"
	"encoding/binary"
	"io"
	"sync"
	"testing"
	"time"

	"slaprf/internal/domain"
)

// mockRomSerial simulates an ESP32-C5 ROM bootloader responder in memory for fast deterministic tests.
type mockRomSerial struct {
	mu      sync.Mutex
	rxToHost bytes.Buffer
	written  [][]byte
	inBuf    []byte
	closed   bool
}

func (m *mockRomSerial) Read(p []byte) (int, error) {
	deadline := time.Now().Add(40 * time.Millisecond)
	for {
		m.mu.Lock()
		if m.closed {
			m.mu.Unlock()
			return 0, io.EOF
		}
		if m.rxToHost.Len() > 0 {
			n, err := m.rxToHost.Read(p)
			m.mu.Unlock()
			return n, err
		}
		m.mu.Unlock()
		if time.Now().After(deadline) {
			return 0, nil
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func (m *mockRomSerial) Write(p []byte) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.inBuf = append(m.inBuf, p...)
	// Decode any SLIP request frames (`0xC0 ... 0xC0`) and enqueue matching ROM ACKs
	for {
		start := bytes.IndexByte(m.inBuf, slipEnd)
		if start < 0 {
			break
		}
		endRel := bytes.IndexByte(m.inBuf[start+1:], slipEnd)
		if endRel < 0 {
			break
		}
		rawEsc := m.inBuf[start+1 : start+1+endRel]
		m.inBuf = m.inBuf[start+1+endRel+1:]
		if len(rawEsc) == 0 {
			continue
		}
		var unesc []byte
		esc := false
		for _, b := range rawEsc {
			if esc {
				esc = false
				if b == slipEscEnd {
					unesc = append(unesc, slipEnd)
				} else if b == slipEscEsc {
					unesc = append(unesc, slipEsc)
				} else {
					unesc = append(unesc, b)
				}
			} else if b == slipEsc {
				esc = true
			} else {
				unesc = append(unesc, b)
			}
		}
		if len(unesc) >= 8 && unesc[0] == 0x00 {
			op := unesc[1]
			cp := make([]byte, len(unesc))
			copy(cp, unesc)
			m.written = append(m.written, cp)
			// Build ROM ACK: [0x01][op][len=2 u16][val=0 u32][status=0][err=0]
			var ack [10]byte
			ack[0] = 0x01
			ack[1] = op
			binary.LittleEndian.PutUint16(ack[2:4], 2)
			m.rxToHost.Write(slipEncode(ack[:]))
		}
	}
	return len(p), nil
}

func (m *mockRomSerial) Close() error {
	m.mu.Lock()
	m.closed = true
	m.mu.Unlock()
	return nil
}

func (m *mockRomSerial) SetDTR(bool) error                 { return nil }
func (m *mockRomSerial) SetRTS(bool) error                 { return nil }
func (m *mockRomSerial) SetReadTimeout(time.Duration) error { return nil }

func TestFlashAndEraseXiaoC5WithMockRomBootloader(t *testing.T) {
	mock := &mockRomSerial{}
	opener := func(_ string, _ int) (SerialPort, error) {
		mock.mu.Lock()
		mock.closed = false
		mock.mu.Unlock()
		return mock, nil
	}

	var stages []string
	readout, err := FlashXiaoC5(
		"COM99",
		opener,
		SyntheticBase(),
		TimerConfig{
			Role:            RoleHubTimer,
			TimerLabel:      "H1",
			FirmwareVersion: "v0.1.4",
			SlotFreqsMHz:    domain.RacebandFrequenciesMHz,
		},
		false,
		func(p FlashProgress) {
			stages = append(stages, p.Stage)
		},
	)
	if err != nil {
		t.Fatalf("FlashXiaoC5 failed: %v", err)
	}
	if readout == nil || readout.Role != "hub" || readout.TimerLabel != "H1" {
		t.Fatalf("unexpected readout: %+v", readout)
	}
	if len(stages) == 0 || stages[len(stages)-1] != "done" {
		t.Fatalf("expected final stage 'done', got %v", stages)
	}

	mock2 := &mockRomSerial{}
	if err := EraseXiaoC5("COM99", func(string, int) (SerialPort, error) { return mock2, nil }, nil); err != nil {
		t.Fatalf("EraseXiaoC5 failed: %v", err)
	}
}
