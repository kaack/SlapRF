//go:build !windows && !linux

package usb

import (
	"sort"
	"strings"

	"go.bug.st/serial"
)

// DefaultListPorts enumerates serial ports in pure Go (CGO_ENABLED=0) on macOS and other POSIX systems.
func DefaultListPorts() ([]PortInfo, error) {
	names, err := serial.GetPortsList()
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool, len(names))
	out := make([]PortInfo, 0, len(names))
	for _, name := range names {
		// On macOS, prefer /dev/cu.* callout devices over blocking /dev/tty.* dial-in twins.
		if strings.HasPrefix(name, "/dev/tty.") {
			cu := "/dev/cu." + strings.TrimPrefix(name, "/dev/tty.")
			hasCU := false
			for _, other := range names {
				if other == cu {
					hasCU = true
					break
				}
			}
			if hasCU {
				continue
			}
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		lower := strings.ToLower(name)
		// Skip macOS built-in Bluetooth / debug virtual ports unless explicitly requested
		if strings.Contains(lower, "bluetooth-incoming-port") || strings.Contains(lower, "debug-console") {
			continue
		}
		isModem := strings.Contains(lower, "usbmodem") || strings.Contains(lower, "ttyacm")
		isUSB := isModem || strings.Contains(lower, "usbserial") || strings.Contains(lower, "ttyusb")
		prod := ""
		vid := ""
		if isModem {
			vid = EspressifVID
			prod = "USB JTAG/serial (ESP32-C5)"
		}
		out = append(out, PortInfo{
			Name:        name,
			IsUSB:       isUSB,
			VID:         vid,
			Product:     prod,
			IsEspressif: isModem,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].IsEspressif != out[j].IsEspressif {
			return out[i].IsEspressif
		}
		if out[i].IsUSB != out[j].IsUSB {
			return out[i].IsUSB
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}
