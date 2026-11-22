//go:build js

package serialport

import (
	"errors"

	"slaprf/internal/firmware"
)

func DefaultListPorts() ([]PortInfo, error) {
	return nil, nil
}

func DefaultOpener(_ string, _ int) (firmware.SerialPort, error) {
	return nil, errors.New("OS serial ports unavailable in WASM")
}
