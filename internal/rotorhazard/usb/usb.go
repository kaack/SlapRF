package usb

import (
	"slaprf/internal/firmware"
	"slaprf/internal/rotorhazard"
	"slaprf/internal/serialport"
)

// PortInfo describes a host USB serial port candidate for a RotorHazard serial node.
type PortInfo = serialport.PortInfo

// Lister enumerates host serial ports.
type Lister = serialport.Lister

// DefaultOpener opens an OS USB serial port for a RotorHazard node (`115200` / `921600` baud).
func DefaultOpener() firmware.SerialOpener {
	return serialport.DefaultOpener
}

// WrapOpener adapts a `firmware.SerialOpener` into `rotorhazard.SerialPortOpener`.
func WrapOpener(opener firmware.SerialOpener) rotorhazard.SerialPortOpener {
	if opener == nil {
		opener = serialport.DefaultOpener
	}
	return func(portName string, baud int) (rotorhazard.SerialPort, error) {
		return opener(portName, baud)
	}
}

// ListPorts enumerates USB serial ports for RotorHazard nodes (ESP32-C5 `FPVGateC5MK`, Arduino
// Nano CH340/FTDI/CP2102, RP2040, STM32 CDC), or all OS serial ports when `showAll` is true.
func ListPorts(lister Lister, showAll bool) ([]PortInfo, error) {
	if lister == nil {
		lister = serialport.DefaultListPorts
	}
	ports, err := lister()
	if err != nil {
		return nil, err
	}
	if showAll {
		out := make([]PortInfo, 0, len(ports))
		for _, p := range ports {
			if p.Transport == "" {
				out = append(out, p)
			}
		}
		serialport.SortPorts(out)
		return out, nil
	}
	out := make([]PortInfo, 0, len(ports))
	for _, p := range ports {
		if p.Transport == "" && (p.IsUSB || p.IsEspressif) {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		for _, p := range ports {
			if p.Transport == "" {
				out = append(out, p)
			}
		}
	}
	serialport.SortPorts(out)
	return out, nil
}
