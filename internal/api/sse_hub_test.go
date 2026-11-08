package api

import (
	"testing"
	"time"

	"slaprf/internal/domain"
)

// A client that never reads must not slow down the timing engine.
func TestPublishNeverBlocksOnStalledClient(t *testing.T) {
	hub := NewSSEHub()
	stalled := &sseClient{
		telemetry: make(chan []byte, 1),
		events:    make(chan []byte, 1),
		overflow:  make(chan struct{}),
	}
	hub.clients[stalled] = struct{}{}

	start := time.Now()
	for i := 0; i < 1000; i++ {
		hub.OnTelemetryFrame(domain.PuckTelemetryFrame{PuckID: 1})
		hub.OnGateCrossing(domain.GateCrossingEvent{EventID: uint64(i)})
	}
	if elapsed := time.Since(start); elapsed > 200*time.Millisecond {
		t.Fatalf("publishing to a stalled client took %v", elapsed)
	}
	select {
	case <-stalled.overflow:
	default:
		t.Fatal("stalled client should be flagged for disconnect once its event queue overflows")
	}
}
