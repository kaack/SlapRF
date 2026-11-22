package serialport

import (
	"context"
	"errors"
	"sort"
	"strings"

	"slaprf/internal/firmware"
)

const EspressifVID = "303A"

// ErrOpenCancelled indicates an in-flight port open was cancelled via context.
var ErrOpenCancelled = errors.New("serial port open cancelled")

// PortInfo describes an enumerated physical or virtual timing device port.
type PortInfo struct {
	Name         string `json:"name"`
	IsUSB        bool   `json:"isUsb"`
	VID          string `json:"vid,omitempty"`
	PID          string `json:"pid,omitempty"`
	SerialNumber string `json:"serialNumber,omitempty"`
	Product      string `json:"product,omitempty"`
	IsEspressif  bool   `json:"isEspressif"`
	Transport    string `json:"transport,omitempty"`
}

// Lister enumerates available serial ports on the host OS.
type Lister func() ([]PortInfo, error)

// SortPorts orders Espressif USB ports first, then generic USB serial adapters, then by name.
func SortPorts(ports []PortInfo) {
	sort.Slice(ports, func(i, j int) bool {
		if ports[i].IsEspressif != ports[j].IsEspressif {
			return ports[i].IsEspressif
		}
		if ports[i].IsUSB != ports[j].IsUSB {
			return ports[i].IsUSB
		}
		return ports[i].Name < ports[j].Name
	})
}

// FilterUSBPorts filters OS serial ports to Espressif USB boards (`showAll == false`) or all USB
// serial ports (`showAll == true`, falling back to all OS ports if none report `IsUSB`).
func FilterUSBPorts(ports []PortInfo, showAll bool) []PortInfo {
	out := make([]PortInfo, 0, len(ports))
	if showAll {
		for _, p := range ports {
			if p.Transport == "" && (p.IsEspressif || p.IsUSB) {
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
		SortPorts(out)
		return out
	}
	for _, p := range ports {
		if p.Transport == "" && p.IsEspressif {
			out = append(out, p)
		}
	}
	SortPorts(out)
	return out
}

// OpenContext wraps `opener(portName, baud)` so callers can abort a blocking open immediately when
// `ctx` is cancelled (closing any late-arriving handle in the background).
func OpenContext(ctx context.Context, opener firmware.SerialOpener, portName string, baud int) (firmware.SerialPort, error) {
	if err := ctx.Err(); err != nil {
		return nil, ErrOpenCancelled
	}
	portName = strings.TrimSpace(portName)
	if opener == nil {
		opener = DefaultOpener
	}
	type res struct {
		p   firmware.SerialPort
		err error
	}
	ch := make(chan res, 1)
	go func() {
		p, err := opener(portName, baud)
		ch <- res{p: p, err: err}
	}()
	select {
	case <-ctx.Done():
		go func() {
			if r := <-ch; r.p != nil {
				_ = r.p.Close()
			}
		}()
		return nil, ErrOpenCancelled
	case r := <-ch:
		if ctx.Err() != nil {
			if r.p != nil {
				_ = r.p.Close()
			}
			return nil, ErrOpenCancelled
		}
		return r.p, r.err
	}
}
