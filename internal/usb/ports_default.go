//go:build !android

package usb

import "slaprf/internal/firmware"

// DefaultListPorts enumerates host USB/OS serial ports plus (when BLE scanning is enabled in
// SlapRF Bluetooth mode) any SlapRF Bluetooth hubs found by a short background BLE scan (`ble:<FP>`).
func DefaultListPorts() ([]PortInfo, error) {
	if !BLEScanEnabled() {
		ports, err := listUSBPorts()
		if err != nil {
			return nil, err
		}
		sortPorts(ports)
		return ports, nil
	}
	return MergeBLEPorts(listUSBPorts, bleListPorts)()
}

// DefaultSerialOpener opens `ble:<FP>` paths over Bluetooth LE and every other path as an OS
// serial port exactly as before.
func DefaultSerialOpener(portName string, baud int) (firmware.SerialPort, error) {
	return DispatchBLEOpener(openUSBSerialPort, bleOpenPort)(portName, baud)
}
