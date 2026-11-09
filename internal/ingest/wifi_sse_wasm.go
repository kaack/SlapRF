//go:build js && wasm

package ingest

func (r *WiFiUDPReceiver) sendHTTPChannels(_, _ string) {}

// Start is a no-op in WASM because BrowserHubBridge streams SSE via browser EventSource.
func (r *WiFiUDPReceiver) Start() error {
	return nil
}
