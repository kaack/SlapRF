//go:build android || ios

package serialport

import (
	"errors"

	"slaprf/internal/firmware"
)

// DefaultListPorts is a fallback stub on Android and iOS; cmd/slaprf-android injects the Android UsbManager JNI lister.
func DefaultListPorts() ([]PortInfo, error) {
	return nil, nil
}

// DefaultOpener is a fallback stub on Android and iOS; cmd/slaprf-android injects the Android UsbManager JNI opener.
func DefaultOpener(_ string, _ int) (firmware.SerialPort, error) {
	return nil, errors.New("direct USB serial is not supported on this mobile host")
}
