//go:build android

package serialport

import (
	"errors"

	"slaprf/internal/firmware"
)

// DefaultListPorts is a fallback stub on Android; cmd/slaprf-android injects the Android UsbManager JNI lister.
func DefaultListPorts() ([]PortInfo, error) {
	return nil, nil
}

// DefaultOpener is a fallback stub on Android; cmd/slaprf-android injects the Android UsbManager JNI opener.
func DefaultOpener(_ string, _ int) (firmware.SerialPort, error) {
	return nil, errors.New("USB serial opener not bound to Android UsbManager shim")
}
