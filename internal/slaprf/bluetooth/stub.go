//go:build android || ios || nobluetooth || !(windows || linux || (darwin && cgo))

package bluetooth

import (
	"context"

	"slaprf/internal/firmware"
	"slaprf/internal/slaprf"
)

func bleListPorts() ([]slaprf.PortInfo, error) { return nil, nil }

func bleOpenPort(string, int) (firmware.SerialPort, error) { return nil, ErrBLEUnsupported }

func bleOpenPortContext(context.Context, string, int, func(string)) (firmware.SerialPort, error) {
	return nil, ErrBLEUnsupported
}
