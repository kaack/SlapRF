//go:build windows || linux

package usb

import (
	"sort"
	"strings"

	"go.bug.st/serial"
	"go.bug.st/serial/enumerator"
)

// DefaultListPorts enumerates host serial ports with USB VID/PID metadata on Windows and Linux.
func DefaultListPorts() ([]PortInfo, error) {
	details, err := enumerator.GetDetailedPortsList()
	if err != nil {
		names, fallbackErr := serial.GetPortsList()
		if fallbackErr != nil {
			return nil, err
		}
		out := make([]PortInfo, 0, len(names))
		for _, n := range names {
			out = append(out, PortInfo{Name: n})
		}
		sortPorts(out)
		return out, nil
	}
	out := make([]PortInfo, 0, len(details))
	for _, d := range details {
		vid := strings.ToUpper(strings.TrimSpace(d.VID))
		pid := strings.ToUpper(strings.TrimSpace(d.PID))
		isEsp := vid == EspressifVID
		prod := strings.TrimSpace(d.Product)
		if prod == "" && isEsp {
			prod = "Seeed XIAO ESP32-C5"
		}
		out = append(out, PortInfo{
			Name:         d.Name,
			IsUSB:        d.IsUSB,
			VID:          vid,
			PID:          pid,
			SerialNumber: strings.TrimSpace(d.SerialNumber),
			Product:      prod,
			IsEspressif:  isEsp,
		})
	}
	sortPorts(out)
	return out, nil
}

func sortPorts(ports []PortInfo) {
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
