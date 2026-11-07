package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"

	"fpv-gate-timer/internal/domain"
)

const (
	// Telemetry is redrawn continuously, so a slow client can simply skip frames.
	telemetryQueueLen = 64
	// Timing events (laps, crossings, session) must not be skipped. This queue is deep enough
	// for minutes of race traffic; a client that still overflows it is disconnected and
	// re-syncs from /api/state when its EventSource reconnects.
	eventQueueLen = 4096
	// Browsers cap HTTP/1.1 connections per origin at 6. Capping concurrent SSE streams at 3
	// guarantees that fetch("/api/state") and asset requests never stall behind stale tabs.
	maxSSEClients = 3
)

// StreamEnvelope wraps a typed real-time message sent to the TypeScript SPA.
type StreamEnvelope struct {
	Type    string      `json:"type"` // "telemetry" | "crossing" | "filtered" | "lap" | "config"
	Payload interface{} `json:"payload"`
}

// LapCompletedPayload bundles a newly completed lap with the updated pilot track summaries.
type LapCompletedPayload struct {
	Lap       domain.LapRecord           `json:"lap"`
	Summaries []domain.PilotTrackSummary `json:"summaries"`
}

// ConfigUpdatedPayload bundles updated pilot slots and gate pucks.
type ConfigUpdatedPayload struct {
	Pilots []domain.PilotSlot `json:"pilots"`
	Pucks  []domain.GatePuck  `json:"pucks"`
}

type sseClient struct {
	telemetry chan []byte
	events    chan []byte
	overflow  chan struct{} // closed when the event queue overflows
	once      sync.Once
}

// SSEHub fans real-time telemetry and timing events out to browser clients.
// Publishing never blocks: the timing engine calls these hooks on its hot path, and a
// stalled engine would distort crossing timestamps.
type SSEHub struct {
	mu      sync.RWMutex
	clients map[*sseClient]struct{}
	order   []*sseClient
}

// NewSSEHub creates a new real-time event broadcaster.
func NewSSEHub() *SSEHub {
	return &SSEHub{clients: make(map[*sseClient]struct{})}
}

// ServeHTTP handles `GET /api/stream` SSE connections from the TypeScript SPA.
func (h *SSEHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	c := &sseClient{
		telemetry: make(chan []byte, telemetryQueueLen),
		events:    make(chan []byte, eventQueueLen),
		overflow:  make(chan struct{}),
	}
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.order = append(h.order, c)
	for len(h.order) > maxSSEClients {
		oldest := h.order[0]
		h.order = h.order[1:]
		delete(h.clients, oldest)
		oldest.once.Do(func() { close(oldest.overflow) })
	}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.clients, c)
		for i, item := range h.order {
			if item == c {
				h.order = append(h.order[:i], h.order[i+1:]...)
				break
			}
		}
		h.mu.Unlock()
	}()

	_, _ = fmt.Fprintf(w, "data: {\"type\":\"connected\"}\n\n")
	flusher.Flush()

	write := func(msg []byte) bool {
		if _, err := fmt.Fprintf(w, "data: %s\n\n", msg); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	ctx := r.Context()
	for {
		// Timing events always go out before queued telemetry.
		select {
		case msg := <-c.events:
			if !write(msg) {
				return
			}
			continue
		default:
		}
		select {
		case <-ctx.Done():
			return
		case <-c.overflow:
			return
		case msg := <-c.events:
			if !write(msg) {
				return
			}
		case msg := <-c.telemetry:
			if !write(msg) {
				return
			}
		}
	}
}

func (h *SSEHub) publish(env StreamEnvelope, isEvent bool) {
	data, err := json.Marshal(env)
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		if !isEvent {
			select {
			case c.telemetry <- data:
			default: // drop the frame for this slow client
			}
			continue
		}
		select {
		case c.events <- data:
		default:
			c.once.Do(func() { close(c.overflow) })
		}
	}
}

// --- tracker.EventSubscriber implementation ---

func (h *SSEHub) OnTelemetryFrame(frame domain.PuckTelemetryFrame) {
	h.publish(StreamEnvelope{Type: "telemetry", Payload: frame}, false)
}

func (h *SSEHub) OnGateCrossing(event domain.GateCrossingEvent) {
	h.publish(StreamEnvelope{Type: "crossing", Payload: event}, true)
}

func (h *SSEHub) OnLapCompleted(lap domain.LapRecord, summaries []domain.PilotTrackSummary) {
	h.publish(StreamEnvelope{Type: "lap", Payload: LapCompletedPayload{Lap: lap, Summaries: summaries}}, true)
}

func (h *SSEHub) OnConfigUpdated(pilots []domain.PilotSlot, pucks []domain.GatePuck) {
	h.publish(StreamEnvelope{Type: "config", Payload: ConfigUpdatedPayload{Pilots: pilots, Pucks: pucks}}, true)
}

func (h *SSEHub) OnDetectionFiltered(f domain.FilteredDetection) {
	h.publish(StreamEnvelope{Type: "filtered", Payload: f}, true)
}
