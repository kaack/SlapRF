package firmware

import (
	"bytes"
	"io"
	"time"
)

// EspressifUSBVID is the USB Vendor ID for Seeed Studio XIAO ESP32-C5 USB-Serial-JTAG.
const EspressifUSBVID uint16 = 0x303A

// TimerReadout summarizes the `SLAPRF02` config block read from a XIAO ESP32-C5.
//
// Flashing and erasing run in the browser (esptool-js over WebSerial, see
// web/src/services/esptool_flasher.ts). The server only reads config blocks from running timers.
type TimerReadout struct {
	Chip            string   `json:"chip"`
	Role            string   `json:"role"` // "hub" | "spoke"
	TimerLabel      string   `json:"timerLabel"`
	FrequenciesMHz  []uint16 `json:"frequenciesMHz"`
	FirmwareVersion string   `json:"firmwareVersion"`
	Fingerprint     string   `json:"fingerprint"`
}

// SerialPort abstracts an OS or mock USB serial port.
type SerialPort interface {
	io.ReadWriteCloser
	SetDTR(dtr bool) error
	SetRTS(rts bool) error
	SetReadTimeout(t time.Duration) error
}

// SerialOpener opens a named OS serial port.
type SerialOpener func(portName string, baud int) (SerialPort, error)

// SetUSBSerialDTRRTS sets RTS before DTR so Windows `usbser.sys` caches RTS and flushes the exact
// `(dtr, rts)` pair in one USB `SET_CONTROL_LINE_STATE` packet without transient download-latch glitches.
func SetUSBSerialDTRRTS(p SerialPort, dtr, rts bool) {
	if p == nil {
		return
	}
	_ = p.SetRTS(rts)
	_ = p.SetDTR(dtr)
}

// DisarmUSBJtagLatch steps `(1,1) -> (1,0) -> (0,0)` so closing the port never traps ESP32-C5 in ROM bootloader mode.
func DisarmUSBJtagLatch(p SerialPort) {
	if p == nil {
		return
	}
	SetUSBSerialDTRRTS(p, true, false)
	SetUSBSerialDTRRTS(p, false, false)
}

// ParseConfigReadout scans `raw` for a valid 160-byte `SLAPRF02` block and converts it to `TimerReadout`.
func ParseConfigReadout(raw []byte) (*TimerReadout, bool) {
	idx := bytes.Index(raw, []byte(ConfigMagic))
	if idx < 0 || idx+configLen > len(raw) {
		return nil, false
	}
	cfg, err := InspectConfig(raw[idx : idx+configLen])
	if err != nil {
		return nil, false
	}
	role := "spoke"
	if cfg.Role == RoleHubTimer {
		role = "hub"
	}
	freqs := make([]uint16, len(cfg.SlotFreqsMHz))
	copy(freqs, cfg.SlotFreqsMHz[:])
	return &TimerReadout{
		Chip:            "Seeed XIAO ESP32-C5 (RISC-V 240 MHz)",
		Role:            role,
		TimerLabel:      cfg.TimerLabel,
		FrequenciesMHz:  freqs,
		FirmwareVersion: cfg.FirmwareVersion,
		Fingerprint:     FormatFingerprint(cfg.Fingerprint),
	}, true
}
