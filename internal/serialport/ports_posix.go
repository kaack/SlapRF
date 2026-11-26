//go:build !windows && !linux && !android && !ios && !js

package serialport

import (
	"strings"

	"go.bug.st/serial"
)

func listUSBPorts() ([]PortInfo, error) {
	names, err := serial.GetPortsList()
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool, len(names))
	out := make([]PortInfo, 0, len(names))
	for _, name := range names {
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
	SortPorts(out)
	return out, nil
}
