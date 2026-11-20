//go:build !android

package usb

import "slaprf/internal/firmware"

// DefaultListPorts enumerates host USB/OS serial ports plus any SlapRF Bluetooth hubs found by
// a short background BLE scan (listed as `ble:<FP>`).
func DefaultListPorts() ([]PortInfo, error) {
	return MergeBLEPorts(listUSBPorts, bleListPorts)()
}

// DefaultSerialOpener opens `ble:<FP>` paths over Bluetooth LE and every other path as an OS
// serial port exactly as before.
func DefaultSerialOpener(portName string, baud int) (firmware.SerialPort, error) {
	return DispatchBLEOpener(openUSBSerialPort, bleOpenPort)(portName, baud)
}
