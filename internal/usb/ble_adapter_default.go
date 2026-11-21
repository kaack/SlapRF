//go:build !android && !nobluetooth && (windows || (darwin && cgo))

package usb

import "tinygo.org/x/bluetooth"

func selectBLEAdapter() (*bluetooth.Adapter, string) {
	return bluetooth.DefaultAdapter, ""
}

func ensureBLEAdapterPowered(_ string) error {
	return nil
}

func ensureBLEDiscoveryStopped(_ string) bool {
	return false
}

func isBLEDeviceStillConnected(_, _ string) bool {
	return true
}

func cancelBLEPendingConnect(_, _ string) {}

func watchBLEDeviceDisconnect(_, _ string, _ <-chan struct{}, _ func(error)) {}
