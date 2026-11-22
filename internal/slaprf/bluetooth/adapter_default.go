//go:build !android && !nobluetooth && (windows || (darwin && cgo))

package bluetooth

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

func isBLEDeviceKnown(_, _ string) bool {
	return true
}

func isBLEDeviceStillConnected(_, _ string) bool {
	return true
}

func cancelBLEPendingConnect(_, _ string) {}

func watchBLEDeviceDisconnect(_, _ string, _ <-chan struct{}, _ func(error)) {}

func acquireBLENotifySocket(_, _, _ string, _ <-chan struct{}, _ func([]byte)) (func(), bool) {
	return nil, false
}
