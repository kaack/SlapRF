package usb

import (
	"fmt"
	"strings"
	"time"

	"go.bug.st/serial"

	"slaprf/internal/firmware"
)

const EspressifVID = "303A"

// PortInfo describes an enumerated OS serial port.
type PortInfo struct {
	Name         string `json:"name"`
	IsUSB        bool   `json:"isUsb"`
	VID          string `json:"vid,omitempty"`
	PID          string `json:"pid,omitempty"`
	SerialNumber string `json:"serialNumber,omitempty"`
	Product      string `json:"product,omitempty"`
	IsEspressif  bool   `json:"isEspressif"`
}

// PortLister enumerates available serial ports on the host OS.
type PortLister func() ([]PortInfo, error)

type osSerialPort struct {
	port serial.Port
}

func (p *osSerialPort) Read(b []byte) (int, error)  { return p.port.Read(b) }
func (p *osSerialPort) Write(b []byte) (int, error) { return p.port.Write(b) }
func (p *osSerialPort) Close() error                { return p.port.Close() }
func (p *osSerialPort) SetDTR(v bool) error         { return p.port.SetDTR(v) }
func (p *osSerialPort) SetRTS(v bool) error         { return p.port.SetRTS(v) }
func (p *osSerialPort) SetReadTimeout(t time.Duration) error {
	return p.port.SetReadTimeout(t)
}
func (p *osSerialPort) ResetInputBuffer() error  { return p.port.ResetInputBuffer() }
func (p *osSerialPort) ResetOutputBuffer() error { return p.port.ResetOutputBuffer() }

// DefaultSerialOpener opens an OS serial port via the cross-platform go.bug.st/serial library.
func DefaultSerialOpener(portName string, baud int) (firmware.SerialPort, error) {
	portName = strings.TrimSpace(portName)
	if portName == "" {
		return nil, fmt.Errorf("missing serial port name")
	}
	if baud <= 0 {
		baud = 115200
	}
	mode := &serial.Mode{
		BaudRate:          baud,
		DataBits:          8,
		Parity:            serial.NoParity,
		StopBits:          serial.OneStopBit,
		InitialStatusBits: &serial.ModemOutputBits{DTR: false, RTS: false},
	}
	p, err := serial.Open(portName, mode)
	if err != nil {
		return nil, err
	}
	return &osSerialPort{port: p}, nil
}
