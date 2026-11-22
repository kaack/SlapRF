package bluetooth

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"slaprf/internal/firmware"
	"slaprf/internal/slaprf"
)

// SlapRF Bluetooth Hub GATT contract (see docs/ble-hub-protocol.md).
const (
	BLEPortPrefix = "ble:"

	BLEServiceUUID = "5d1a0001-5a7e-4c0b-9e5f-534c41505246"
	BLERxCharUUID  = "5d1a0002-5a7e-4c0b-9e5f-534c41505246"
	BLETxCharUUID  = "5d1a0003-5a7e-4c0b-9e5f-534c41505246"

	BLEManufacturerCompanyID uint16 = 0xFFFF
	BLETransportName                = "ble"

	BLEMinWritePayload = 20
	BLEMaxWritePayload = 244

	bleMaxBufferedRx = 1 << 20
)

// ErrBLEUnsupported is returned when the current build has no Bluetooth LE backend.
var ErrBLEUnsupported = errors.New("Bluetooth hubs are not supported in this build")

// IsBLEPortName reports whether `name` is a Bluetooth hub port path (`ble:...`).
func IsBLEPortName(name string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(name)), BLEPortPrefix)
}

// BLEPortName formats the canonical `ble:<FP8HEX>` port path for a hub fingerprint.
func BLEPortName(fp uint32) string {
	return fmt.Sprintf("%s%08X", BLEPortPrefix, fp)
}

// ParseBLEPortName extracts the upper-case 8 hex digit fingerprint from a `ble:` port path.
func ParseBLEPortName(name string) (string, bool) {
	name = strings.TrimSpace(name)
	if !IsBLEPortName(name) {
		return "", false
	}
	fp := strings.ToUpper(strings.TrimSpace(name[len(BLEPortPrefix):]))
	if len(fp) != 8 {
		return "", false
	}
	for _, c := range fp {
		if !((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F')) {
			return "", false
		}
	}
	return fp, true
}

// BLEAdvertInfo is the decoded SlapRF manufacturer specific data from a hub advertisement.
type BLEAdvertInfo struct {
	Fingerprint uint32
	Role        uint8
	FwMajor     uint8
	FwMinor     uint8
	FwPatch     uint8
	HasFlags    bool
	Paired      bool
}

// FingerprintHex returns the fingerprint as 8 upper-case hex digits.
func (a BLEAdvertInfo) FingerprintHex() string {
	return fmt.Sprintf("%08X", a.Fingerprint)
}

// ParseBLEManufacturerData decodes `'S' 'R' <fp u32 LE> <role> <maj> <min> <patch> [<flags>]` found
// after the company ID in the hub's manufacturer specific data.
func ParseBLEManufacturerData(companyID uint16, data []byte) (BLEAdvertInfo, bool) {
	if companyID != BLEManufacturerCompanyID || len(data) < 7 {
		return BLEAdvertInfo{}, false
	}
	if data[0] != 'S' || data[1] != 'R' {
		return BLEAdvertInfo{}, false
	}
	info := BLEAdvertInfo{
		Fingerprint: binary.LittleEndian.Uint32(data[2:6]),
		Role:        data[6],
	}
	if len(data) >= 10 {
		info.FwMajor, info.FwMinor, info.FwPatch = data[7], data[8], data[9]
	}
	if len(data) >= 11 {
		info.HasFlags = true
		info.Paired = (data[10] & 0x01) != 0
	}
	return info, true
}

// BLEPortInfoFor builds the PortInfo entry listed for a discovered Bluetooth hub.
func BLEPortInfoFor(info BLEAdvertInfo, localName string) slaprf.PortInfo {
	label := strings.TrimSpace(localName)
	if label == "" {
		label = "SlapRF Hub"
	}
	product := label + " (Bluetooth)"
	if info.HasFlags && !info.Paired {
		product = label + " (Bluetooth · Pairing mode)"
	}
	return slaprf.PortInfo{
		Name:         BLEPortName(info.Fingerprint),
		IsUSB:        false,
		SerialNumber: info.FingerprintHex(),
		Product:      product,
		IsEspressif:  true,
		Transport:    BLETransportName,
	}
}

// BLEWritePayloadForMTU converts an ATT MTU into the largest write-without-response payload.
func BLEWritePayloadForMTU(attMTU int) int {
	n := attMTU - 3
	if n < BLEMinWritePayload {
		return BLEMinWritePayload
	}
	if n > BLEMaxWritePayload {
		return BLEMaxWritePayload
	}
	return n
}

// GATTConn is the minimal GATT client link a BLEStreamPort needs.
type GATTConn interface {
	WriteWithoutResponse(p []byte) error
	MaxWriteLen() int
	Close() error
}

// BLEStreamPort adapts a Bluetooth hub GATT link to firmware.SerialPort so `slaprf.Manager`,
// hub frame decoding, and `STATUS?` probing run identically over Bluetooth.
type BLEStreamPort struct {
	t GATTConn

	mu           sync.Mutex
	buf          []byte
	closed       bool
	disconnected bool
	discErr      error
	dropped      uint64
	timeout      time.Duration
	notify       chan struct{}

	writeMu   sync.Mutex
	closeOnce sync.Once
	closeErr  error
}

var (
	_ firmware.SerialPort        = (*BLEStreamPort)(nil)
	_ slaprf.FingerprintObserver = (*BLEStreamPort)(nil)
)

// NewBLEStreamPort wraps an already connected GATT client link whose TX notifications are enabled.
func NewBLEStreamPort(t GATTConn) *BLEStreamPort {
	return &BLEStreamPort{
		t:       t,
		timeout: 120 * time.Millisecond,
		notify:  make(chan struct{}, 1),
	}
}

func (p *BLEStreamPort) wake() {
	select {
	case p.notify <- struct{}{}:
	default:
	}
}

// Deliver appends one notification payload to the ordered receive stream.
func (p *BLEStreamPort) Deliver(b []byte) {
	if len(b) == 0 {
		return
	}
	p.mu.Lock()
	if p.closed || p.disconnected {
		p.mu.Unlock()
		return
	}
	p.buf = append(p.buf, b...)
	if over := len(p.buf) - bleMaxBufferedRx; over > 0 {
		p.dropped += uint64(over)
		p.buf = append(p.buf[:0], p.buf[over:]...)
	}
	p.mu.Unlock()
	p.wake()
}

// Disconnected marks the link as lost. Buffered bytes are still returned before Read reports EOF.
func (p *BLEStreamPort) Disconnected(err error) {
	p.mu.Lock()
	if !p.disconnected {
		p.disconnected = true
		p.discErr = err
	}
	p.mu.Unlock()
	p.wake()
}

// DroppedBytes returns how many received bytes were discarded because the reader stalled.
func (p *BLEStreamPort) DroppedBytes() uint64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.dropped
}

// Read returns buffered stream bytes, waits up to the read timeout for more, and returns io.EOF once closed or lost.
func (p *BLEStreamPort) Read(b []byte) (int, error) {
	if len(b) == 0 {
		return 0, nil
	}
	p.mu.Lock()
	timeout := p.timeout
	p.mu.Unlock()
	var timer *time.Timer
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()
	for {
		p.mu.Lock()
		if len(p.buf) > 0 {
			n := copy(b, p.buf)
			p.buf = p.buf[n:]
			if len(p.buf) == 0 {
				p.buf = nil
			}
			p.mu.Unlock()
			return n, nil
		}
		if p.closed || p.disconnected {
			p.mu.Unlock()
			return 0, io.EOF
		}
		p.mu.Unlock()
		if timer == nil {
			timer = time.NewTimer(timeout)
		}
		select {
		case <-p.notify:
		case <-timer.C:
			return 0, nil
		}
	}
}

// Write sends `b` to the hub RX characteristic, split into MTU-sized write-without-response chunks.
func (p *BLEStreamPort) Write(b []byte) (int, error) {
	if len(b) == 0 {
		return 0, nil
	}
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	total := 0
	for total < len(b) {
		p.mu.Lock()
		dead := p.closed || p.disconnected
		p.mu.Unlock()
		if dead {
			return total, io.ErrClosedPipe
		}
		max := p.t.MaxWriteLen()
		if max <= 0 {
			max = BLEMinWritePayload
		}
		chunk := b[total:]
		if len(chunk) > max {
			chunk = chunk[:max]
		}
		if err := p.t.WriteWithoutResponse(chunk); err != nil {
			return total, fmt.Errorf("Bluetooth write failed: %w", err)
		}
		total += len(chunk)
	}
	return total, nil
}

func (p *BLEStreamPort) SetDTR(bool) error { return nil }
func (p *BLEStreamPort) SetRTS(bool) error { return nil }

func (p *BLEStreamPort) SetReadTimeout(t time.Duration) error {
	if t <= 0 {
		t = 50 * time.Millisecond
	}
	p.mu.Lock()
	p.timeout = t
	p.mu.Unlock()
	return nil
}

func (p *BLEStreamPort) ResetInputBuffer() error {
	p.mu.Lock()
	p.buf = nil
	p.mu.Unlock()
	return nil
}

func (p *BLEStreamPort) ResetOutputBuffer() error { return nil }

// NoteConnectedFingerprint informs the underlying BLE connection of the Hub's canonical 8-hex fingerprint.
func (p *BLEStreamPort) NoteConnectedFingerprint(fpHex string) {
	if obs, ok := p.t.(slaprf.FingerprintObserver); ok {
		obs.NoteConnectedFingerprint(fpHex)
	}
}

// Close disconnects the GATT link and unblocks pending reads with io.EOF.
func (p *BLEStreamPort) Close() error {
	p.closeOnce.Do(func() {
		p.mu.Lock()
		p.closed = true
		p.buf = nil
		p.mu.Unlock()
		p.wake()
		p.writeMu.Lock()
		p.closeErr = p.t.Close()
		p.writeMu.Unlock()
	})
	return p.closeErr
}
