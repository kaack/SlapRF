//go:build !android && !ios && !js

package serialport

import "slaprf/internal/firmware"

// DefaultListPorts enumerates host OS USB/serial ports.
func DefaultListPorts() ([]PortInfo, error) {
	ports, err := listUSBPorts()
	if err != nil {
		return nil, err
	}
	SortPorts(ports)
	return ports, nil
}

// DefaultOpener opens an OS serial port with DTR=false and RTS=false.
func DefaultOpener(portName string, baud int) (firmware.SerialPort, error) {
	return openUSBSerialPort(portName, baud)
}
