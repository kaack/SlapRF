//go:build !android && !nobluetooth && (windows || (darwin && cgo))

package usb

import "tinygo.org/x/bluetooth"

func selectBLEAdapter() *bluetooth.Adapter {
	return bluetooth.DefaultAdapter
}
