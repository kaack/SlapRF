//go:build android

package usb

import (
	"errors"

	"slaprf/internal/firmware"
)

// DefaultListPorts is a fallback stub on Android; cmd/slaprf-android injects the official
// UsbManager JNI PortLister into portable.Config.
func DefaultListPorts() ([]PortInfo, error) {
	return nil, nil
}

// DefaultSerialOpener is a fallback stub on Android; cmd/slaprf-android injects the official
// UsbManager JNI SerialOpener into portable.Config.
func DefaultSerialOpener(_ string, _ int) (firmware.SerialPort, error) {
	return nil, errors.New("USB serial opener not bound to Android UsbManager shim")
}
