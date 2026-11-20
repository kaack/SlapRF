//go:build !android && (nobluetooth || !(windows || linux || (darwin && cgo)))

package usb

import "slaprf/internal/firmware"

// bleListPorts reports no Bluetooth hubs in builds without a BLE backend (for example macOS
// with CGO_ENABLED=0, or any build using the `nobluetooth` tag).
func bleListPorts() ([]PortInfo, error) { return nil, nil }

func bleOpenPort(string, int) (firmware.SerialPort, error) { return nil, ErrBLEUnsupported }
