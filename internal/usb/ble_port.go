package usb

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"slaprf/internal/firmware"
)

// SlapRF Bluetooth Hub GATT contract (see docs/ble-hub-protocol.md).
const (
	// BLEPortPrefix marks a port path as a Bluetooth LE hub link (`ble:<FP8HEX>`).
	BLEPortPrefix = "ble:"

	BLEServiceUUID = "5d1a0001-5a7e-4c0b-9e5f-534c41505246"
	BLERxCharUUID  = "5d1a0002-5a7e-4c0b-9e5f-534c41505246"
	BLETxCharUUID  = "5d1a0003-5a7e-4c0b-9e5f-534c41505246"

	// BLEManufacturerCompanyID is the company ID carried in the hub scan response.
	BLEManufacturerCompanyID uint16 = 0xFFFF

	// BLETransportName is the PortInfo.Transport value for Bluetooth hub ports.
	BLETransportName = "ble"

	// BLEMinWritePayload is the write payload for the default ATT MTU (23 - 3).
	BLEMinWritePayload = 20
	// BLEMaxWritePayload is the write payload for the requested ATT MTU (247 - 3).
	BLEMaxWritePayload = 244

	// bleMaxBufferedRx caps unread notification bytes so a stalled reader cannot grow memory forever.
	bleMaxBufferedRx = 1 << 20
)

// ErrBLEUnsupported is returned when the current build has no Bluetooth LE backend.
var ErrBLEUnsupported = errors.New("Bluetooth hubs are not supported in this build")

var (
	bleScanEnabled   atomic.Bool
	bleSuppressDepth atomic.Int32
)

// SetBLEScanEnabled controls whether host/Android port enumeration scans for SlapRF Bluetooth Hubs.
// When false (e.g. in SlapRF USB, LapRF, or RotorHazard modes), DefaultListPorts and Android JNI
// skip BLE scanning entirely so no background Bluetooth scan or permission prompt is triggered.
func SetBLEScanEnabled(enabled bool) {
	bleScanEnabled.Store(enabled)
}

// BLEScanEnabled reports whether BLE hub scanning is currently active for port enumeration.
func BLEScanEnabled() bool {
	return bleScanEnabled.Load() && bleSuppressDepth.Load() == 0
}

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
func BLEPortInfoFor(info BLEAdvertInfo, localName string) PortInfo {
	label := strings.TrimSpace(localName)
	if label == "" {
		label = "SlapRF Hub"
	}
	product := label + " (Bluetooth)"
	if info.HasFlags && !info.Paired {
		product = label + " (Bluetooth · Pairing mode)"
	}
	return PortInfo{
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

// MergeBLEPorts returns a PortLister that appends Bluetooth hub ports from `bleList` to the
// USB ports from `usbList`. Bluetooth is optional: its errors never hide USB ports.
func MergeBLEPorts(usbList, bleList PortLister) PortLister {
	return func() ([]PortInfo, error) {
		var out []PortInfo
		var usbErr error
		if usbList != nil {
			out, usbErr = usbList()
		}
		var ble []PortInfo
		if bleList != nil {
			ble, _ = bleList()
		}
		if usbErr != nil && len(ble) == 0 {
			return nil, usbErr
		}
		out = append(out, ble...)
		sortPorts(out)
		return out, nil
	}
}

// DispatchBLEOpener returns a SerialOpener that routes `ble:` paths to `bleOpen` and every
// other path to `usbOpen` unchanged.
func DispatchBLEOpener(usbOpen, bleOpen firmware.SerialOpener) firmware.SerialOpener {
	return func(portName string, baud int) (firmware.SerialPort, error) {
		if IsBLEPortName(portName) {
			if bleOpen == nil {
				return nil, ErrBLEUnsupported
			}
			return bleOpen(strings.TrimSpace(portName), baud)
		}
		if usbOpen == nil {
			return nil, errors.New("USB serial opener not available")
		}
		return usbOpen(portName, baud)
	}
}

// BLETransport is the minimal GATT client link a BLEStreamPort needs: writes to the hub RX
// characteristic (write without response) and teardown. Notification bytes from the TX
// characteristic are pushed into the port with Deliver, link loss with Disconnected.
type BLETransport interface {
	// WriteWithoutResponse writes one ATT payload (at most MaxWriteLen bytes) to RX.
	WriteWithoutResponse(p []byte) error
	// MaxWriteLen is the current write payload size (ATT_MTU - 3).
	MaxWriteLen() int
	// Close tears down the GATT connection.
	Close() error
}

// BLEStreamPort adapts a Bluetooth hub GATT link to firmware.SerialPort so the USB manager,
// hub frame decoder and STATUS? probing run unchanged over Bluetooth.
type BLEStreamPort struct {
	t BLETransport

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

var _ firmware.SerialPort = (*BLEStreamPort)(nil)

// NewBLEStreamPort wraps an already connected transport whose TX notifications are enabled.
func NewBLEStreamPort(t BLETransport) *BLEStreamPort {
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

// Deliver appends one notification payload to the ordered receive stream. It copies `b`.
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

// Read returns buffered stream bytes, waits up to the read timeout for more (returning 0, nil
// on timeout like a serial port), and returns io.EOF once the link is closed or lost.
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

// Write sends `b` to the hub RX characteristic, split into MTU sized write-without-response
// chunks. Concurrent Write calls are serialized so chunks never interleave.
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

// SetDTR is a no-op: a Bluetooth link has no modem control lines.
func (p *BLEStreamPort) SetDTR(bool) error { return nil }

// SetRTS is a no-op: a Bluetooth link has no modem control lines.
func (p *BLEStreamPort) SetRTS(bool) error { return nil }

// SetReadTimeout sets how long Read waits for new bytes before returning 0, nil.
func (p *BLEStreamPort) SetReadTimeout(t time.Duration) error {
	if t <= 0 {
		t = 50 * time.Millisecond
	}
	p.mu.Lock()
	p.timeout = t
	p.mu.Unlock()
	return nil
}

// ResetInputBuffer discards unread received bytes.
func (p *BLEStreamPort) ResetInputBuffer() error {
	p.mu.Lock()
	p.buf = nil
	p.mu.Unlock()
	return nil
}

// ResetOutputBuffer is a no-op: writes are sent synchronously.
func (p *BLEStreamPort) ResetOutputBuffer() error { return nil }

// Close disconnects the GATT link and unblocks pending reads with io.EOF. Safe to call twice.
func (p *BLEStreamPort) Close() error {
	p.closeOnce.Do(func() {
		p.mu.Lock()
		p.closed = true
		p.buf = nil
		p.mu.Unlock()
		p.wake()
		// Wait for an in-flight Write to finish so the transport is not torn down mid-call.
		p.writeMu.Lock()
		p.closeErr = p.t.Close()
		p.writeMu.Unlock()
	})
	return p.closeErr
}
