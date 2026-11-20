//go:build windows || (linux && !android)

package usb

import (
	"strings"

	"go.bug.st/serial"
	"go.bug.st/serial/enumerator"
)

// listUSBPorts enumerates host serial ports with USB VID/PID metadata on Windows and desktop Linux.
func listUSBPorts() ([]PortInfo, error) {
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
		if isEsp && (prod == "" || strings.HasPrefix(strings.ToLower(prod), "usb serial device") || strings.HasPrefix(strings.ToLower(prod), "usb jtag") || strings.Contains(strings.ToLower(prod), "seeed xiao") || strings.Contains(strings.ToLower(prod), "esp32-c5")) {
			prod = "ESP32-C5"
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
