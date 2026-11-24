package portable

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"slaprf/internal/api"
	"slaprf/internal/applog"
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
	hub         *streamHub
	engine      *tracker.Engine
	appLog      *applog.Logger
	isSimEngine bool
	allow       func() bool

	mu      sync.Mutex
	pending []domain.TimerTelemetryFrame
	encBuf  []byte
}

func newEngineStreamForwarder(hub *streamHub, engine *tracker.Engine, appLog *applog.Logger, isSimEngine bool, allow func() bool) *engineStreamForwarder {
	f := &engineStreamForwarder{
		hub:         hub,
		engine:      engine,
		appLog:      appLog,
		isSimEngine: isSimEngine,
		allow:       allow,
	}
	engine.Subscribe(f)
	return f
}

func (f *engineStreamForwarder) logPrefix() string {
	if f.isSimEngine {
		return "[SIM]"
	}
	return ""
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
	if count >= 4 {
		f.flushTelemetry()
	}
}

func (f *engineStreamForwarder) isAllowed() bool {
	return f.allow == nil || f.allow()
}

func (f *engineStreamForwarder) OnGateCrossing(ev domain.GateCrossingEvent) {
	if f.isAllowed() {
		pfx := f.logPrefix()
		if ev.StartedLap {
			f.appLog.Infof("%s[Crossing] %s (slot=%d) started lap at gate #%d %q (peak=%.1f dBm, eventId=%d)",
				pfx, ev.Callsign, ev.SlotIndex, ev.GateID, ev.GateName, ev.PeakRSSIDbm, ev.EventID)
		} else {
			f.appLog.Debugf("%s[Crossing] %s (slot=%d) crossed gate #%d %q (peak=%.1f dBm, hold=%.0f ms, eventId=%d)",
				pfx, ev.Callsign, ev.SlotIndex, ev.GateID, ev.GateName, ev.PeakRSSIDbm, ev.HoldMs, ev.EventID)
		}
	}
	f.sendJSON("crossing", ev)
}

func (f *engineStreamForwarder) OnDetectionFiltered(det domain.FilteredDetection) {
	if f.isAllowed() {
		f.appLog.Debugf("%s[Filter] Rejected detection for %s (slot=%d) at gate #%d: reason=%s peak=%.1f dBm (%s)",
			f.logPrefix(), det.Callsign, det.SlotIndex, det.GateID, det.Reason, det.PeakRSSIDbm, det.Detail)
	}
	f.sendJSON("filtered", det)
}

func (f *engineStreamForwarder) OnLapCompleted(lap domain.LapRecord, summaries []domain.PilotTrackSummary) {
	if f.isAllowed() {
		f.appLog.Infof("%s[Lap] %s (slot=%d) completed lap #%d in %.3fs (lapId=%d, best=%v)",
			f.logPrefix(), lap.Callsign, lap.SlotIndex, lap.LapNumber, lap.LapTimeSec, lap.LapID, lap.IsBestLap)
	}
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
	if announcement != nil && announcement.Kind != "countdown_prompt" && f.isAllowed() {
		f.appLog.Infof("%s[RaceEvent] kind=%s race=%q (id=%s, heat=%q, pilot=%q) %s",
			f.logPrefix(), announcement.Kind, state.Config.EventName, state.RaceID, announcement.HeatID, announcement.Callsign, announcement.Text)
	}
	var serverTsUs uint64
	if f.engine != nil {
		serverTsUs = f.engine.NowUs()
	}
	f.sendJSON("race", map[string]any{
		"serverTimestampUs": serverTsUs,
		"raceState":         state,
		"eventState":        eventState,
		"announcement":      announcement,
	})
}

func (f *engineStreamForwarder) OnPracticeUpdated(state domain.PracticeManagerState) {
	f.sendJSON("practice", state)
}

func (f *engineStreamForwarder) OnMLUpdated(status domain.MLStatus) {
	f.sendJSON("ml_status", status)
}

type streamHub struct {
	mu      sync.RWMutex
	clients map[*wsStreamClient]struct{}
	simFwd  *engineStreamForwarder
	realFwd *engineStreamForwarder
	stopCh  chan struct{}
	stopOnce sync.Once
}

func newStreamHub(simEngine, realEngine *tracker.Engine, isSim func() bool, appLog *applog.Logger) *streamHub {
	h := &streamHub{
		clients: make(map[*wsStreamClient]struct{}),
		stopCh:  make(chan struct{}),
	}
	h.simFwd = newEngineStreamForwarder(h, simEngine, appLog, true, isSim)
	h.realFwd = newEngineStreamForwarder(h, realEngine, appLog, false, func() bool { return !isSim() })

	// Flush pending telemetry batches every 12 ms (~83 Hz) so UI graphs and crossing markers
	// update in real time with minimal WebSocket frame overhead.
	go func() {
		ticker := time.NewTicker(12 * time.Millisecond)
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
