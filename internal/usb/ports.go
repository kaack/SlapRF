package usb

import "sort"

const EspressifVID = "303A"

// PortInfo describes an enumerated OS or Android USB serial port.
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
