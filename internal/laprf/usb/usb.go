package usb

import (
	"slaprf/internal/firmware"
	"slaprf/internal/serialport"
)

// DefaultBaud is the standard ImmersionRC LapRF 8-Way USB CDC baud rate.
const DefaultBaud = 115200

// PortInfo describes a host USB serial port candidate for a LapRF 8-Way puck.
type PortInfo = serialport.PortInfo

// Lister enumerates host serial ports.
type Lister = serialport.Lister

// DefaultOpener opens an OS USB serial port for a LapRF 8-Way timer.
func DefaultOpener() firmware.SerialOpener {
	return serialport.DefaultOpener
}

// ListPorts enumerates USB serial ports for LapRF 8-Way timers, or all OS ports when `showAll` is true.
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
		if p.Transport == "" && p.IsUSB {
			out = append(out, p)
		}
	}
	serialport.SortPorts(out)
	return out, nil
}
