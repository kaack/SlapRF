package portable

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"slaprf/internal/api"
	"slaprf/internal/domain"
	"slaprf/internal/tracker"
)

type wsStreamMsg struct {
	msgType websocket.MessageType
	data    []byte
}

type wsStreamClient struct {
	ch chan wsStreamMsg
}

type engineStreamForwarder struct {
	hub    *streamHub
	engine *tracker.Engine
	allow  func() bool

	mu      sync.Mutex
	pending []domain.TimerTelemetryFrame
	encBuf  []byte
}

func newEngineStreamForwarder(hub *streamHub, engine *tracker.Engine, allow func() bool) *engineStreamForwarder {
	f := &engineStreamForwarder{
		hub:    hub,
		engine: engine,
		allow:  allow,
	}
	engine.Subscribe(f)
	return f
}

func (f *engineStreamForwarder) flushTelemetry() {
	if !f.hub.hasClients() {
		f.mu.Lock()
		f.pending = f.pending[:0]
		f.mu.Unlock()
		return
	}
	f.mu.Lock()
	if len(f.pending) == 0 {
		f.mu.Unlock()
		return
	}
	rssiCount := domain.MaxPilotSlots
	if f.engine != nil {
		if pc := f.engine.PilotCount(); pc > rssiCount {
			rssiCount = pc
		}
	}
	if rssiCount > domain.MaxPilotPoolSize {
		rssiCount = domain.MaxPilotPoolSize
	}
	f.encBuf = api.EncodeTelemetryBatch(f.encBuf[:0], f.pending, rssiCount)
	payload := append([]byte(nil), f.encBuf...)
	f.pending = f.pending[:0]
	f.mu.Unlock()

	f.hub.broadcast(wsStreamMsg{
		msgType: websocket.MessageBinary,
		data:    payload,
	})
}

func (f *engineStreamForwarder) sendJSON(eventType string, payload any) {
	if f.allow != nil && !f.allow() {
		return
	}
	f.flushTelemetry()
	if !f.hub.hasClients() {
		return
	}
	b, err := json.Marshal(api.StreamEnvelope{
		Type:    eventType,
		Payload: payload,
	})
	if err != nil {
		return
	}
	f.hub.broadcast(wsStreamMsg{
		msgType: websocket.MessageText,
		data:    b,
	})
}

func (f *engineStreamForwarder) OnTelemetryFrame(frame domain.TimerTelemetryFrame) {
	if f.allow != nil && !f.allow() {
		return
	}
	if !f.hub.hasClients() {
		return
	}
	f.mu.Lock()
	f.pending = append(f.pending, frame)
	count := len(f.pending)
	f.mu.Unlock()
	if count >= 8 {
		f.flushTelemetry()
	}
}

func (f *engineStreamForwarder) OnGateCrossing(ev domain.GateCrossingEvent) {
	f.sendJSON("crossing", ev)
}

func (f *engineStreamForwarder) OnDetectionFiltered(det domain.FilteredDetection) {
	f.sendJSON("filtered", det)
}

func (f *engineStreamForwarder) OnLapCompleted(lap domain.LapRecord, summaries []domain.PilotTrackSummary) {
	f.sendJSON("lap", map[string]any{
		"lap":       lap,
		"summaries": summaries,
	})
}

func (f *engineStreamForwarder) OnConfigUpdated(pilots []domain.PilotSlot, gates []domain.TrackGate) {
	var timers []domain.DetectedTimer
	if f.engine != nil {
		timers = f.engine.DetectedTimersSnapshot()
	}
	f.sendJSON("config", map[string]any{
		"pilots": pilots,
		"gates":  gates,
		"timers": timers,
	})
}

func (f *engineStreamForwarder) OnRaceUpdated(state domain.RaceTournamentState, eventState domain.EventManagerState, announcement *domain.RaceAnnouncement) {
	f.sendJSON("race", map[string]any{
		"raceState":    state,
		"eventState":   eventState,
		"announcement": announcement,
	})
}

func (f *engineStreamForwarder) OnPracticeUpdated(state domain.PracticeManagerState) {
	f.sendJSON("practice", state)
}

type streamHub struct {
	mu      sync.RWMutex
	clients map[*wsStreamClient]struct{}
	simFwd  *engineStreamForwarder
	realFwd *engineStreamForwarder
	stopCh  chan struct{}
	stopOnce sync.Once
}

func newStreamHub(simEngine, realEngine *tracker.Engine, isSim func() bool) *streamHub {
	h := &streamHub{
		clients: make(map[*wsStreamClient]struct{}),
		stopCh:  make(chan struct{}),
	}
	h.simFwd = newEngineStreamForwarder(h, simEngine, isSim)
	h.realFwd = newEngineStreamForwarder(h, realEngine, func() bool { return !isSim() })

	// Flush pending telemetry batches at 50 Hz (20 ms) so UI graphs run at silky 50-60 FPS
	// with minimal WebSocket frame overhead.
	go func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-h.stopCh:
				return
			case <-ticker.C:
				if isSim() {
					h.simFwd.flushTelemetry()
				} else {
					h.realFwd.flushTelemetry()
				}
			}
		}
	}()
	return h
}

func (h *streamHub) close() {
	h.stopOnce.Do(func() {
		close(h.stopCh)
	})
}

func (h *streamHub) hasClients() bool {
	h.mu.RLock()
	n := len(h.clients)
	h.mu.RUnlock()
	return n > 0
}

func (h *streamHub) broadcast(msg wsStreamMsg) {
	h.mu.RLock()
	for cl := range h.clients {
		select {
		case cl.ch <- msg:
		default:
			// If a slow client's buffer is full and this is binary telemetry, drop the batch
			// rather than stalling the timing engine or other race displays.
			if msg.msgType == websocket.MessageText {
				// Make room by dropping oldest queued item if possible so state transitions arrive.
				select {
				case <-cl.ch:
				default:
				}
				select {
				case cl.ch <- msg:
				default:
				}
			}
		}
	}
	h.mu.RUnlock()
}

func (s *Server) handleStreamWS(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	ws.SetReadLimit(64 << 10)
	defer func() { _ = ws.CloseNow() }()

	cl := &wsStreamClient{
		ch: make(chan wsStreamMsg, 256),
	}
	s.stream.mu.Lock()
	s.stream.clients[cl] = struct{}{}
	s.stream.mu.Unlock()
	defer func() {
		s.stream.mu.Lock()
		delete(s.stream.clients, cl)
		s.stream.mu.Unlock()
	}()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Drain client reads / close frames in background
	go func() {
		defer cancel()
		for {
			if _, _, rErr := ws.Read(ctx); rErr != nil {
				return
			}
		}
	}()

	pingTicker := time.NewTicker(wsPingInterval)
	defer pingTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-cl.ch:
			wCtx, wCancel := context.WithTimeout(ctx, wsWriteTimeout)
			wErr := ws.Write(wCtx, msg.msgType, msg.data)
			wCancel()
			if wErr != nil {
				return
			}
		case <-pingTicker.C:
			pCtx, pCancel := context.WithTimeout(ctx, wsWriteTimeout)
			pErr := ws.Ping(pCtx)
			pCancel()
			if pErr != nil {
				return
			}
		}
	}
}
