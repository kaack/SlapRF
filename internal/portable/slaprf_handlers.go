package portable

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"

	"slaprf/internal/slaprf"
)

func (s *Server) serveSlapRFPorts(w http.ResponseWriter, r *http.Request, mgr *slaprf.Manager, showAll bool) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ports, err := mgr.ListPorts(r.Context(), showAll)
	if err != nil {
		writeJSONNoStore(w, http.StatusOK, map[string]any{
			"ports": []slaprf.PortInfo{},
			"error": err.Error(),
		})
		return
	}
	if ports == nil {
		ports = []slaprf.PortInfo{}
	}
	writeJSONNoStore(w, http.StatusOK, map[string]any{
		"ports": ports,
		"pool":  mgr.Snapshot(),
	})
}

func (s *Server) serveSlapRFStatus(w http.ResponseWriter, r *http.Request, mgr *slaprf.Manager) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSONNoStore(w, http.StatusOK, mgr.Snapshot())
}

func (s *Server) serveSlapRFConnect(w http.ResponseWriter, r *http.Request, mgr *slaprf.Manager, routePrefix string) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	var req struct {
		SlotIndex int    `json:"slotIndex"`
		PortName  string `json:"portName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON body"})
		return
	}
	if rawSlot := strings.TrimSpace(r.PathValue("slotIndex")); rawSlot != "" {
		parsed, err := strconv.Atoi(rawSlot)
		if err != nil || parsed < 0 || parsed >= slaprf.MaxConnections {
			writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "invalid slotIndex"})
			return
		}
		req.SlotIndex = parsed
	}
	normTarget, valErr := mgr.Transport().ValidateTarget(req.PortName)
	if valErr != nil {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": valErr.Error()})
		return
	}
	snap, err := mgr.Connect(req.SlotIndex, normTarget)
	if err != nil {
		if errors.Is(err, slaprf.ErrConnectCancelled) {
			writeJSONNoStore(w, http.StatusOK, map[string]any{
				"cancelled": true,
				"pool":      mgr.Snapshot(),
			})
			return
		}
		writeJSONNoStore(w, http.StatusBadGateway, map[string]any{
			"error": err.Error(),
			"pool":  mgr.Snapshot(),
		})
		return
	}
	if s.persistWorker != nil {
		s.persistWorker.MarkDirty()
	}
	status := http.StatusOK
	if r.Method == http.MethodPost {
		w.Header().Set("Location", routePrefix+"/connections/"+strconv.Itoa(req.SlotIndex))
		status = http.StatusCreated
	}
	writeJSONNoStore(w, status, map[string]any{
		"slot": snap,
		"pool": mgr.Snapshot(),
	})
}

func (s *Server) serveSlapRFDisconnectSlot(w http.ResponseWriter, r *http.Request, mgr *slaprf.Manager) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	rawSlot := strings.TrimSpace(r.PathValue("slotIndex"))
	slotIndex, err := strconv.Atoi(rawSlot)
	if err != nil || slotIndex < 0 || slotIndex >= slaprf.MaxConnections {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "invalid slotIndex"})
		return
	}
	if r.URL.Query().Get("forget") == "1" {
		_ = mgr.ForgetSlot(slotIndex, r.URL.Query().Get("fp"))
	} else {
		_ = mgr.Disconnect(slotIndex)
	}
	writeJSONNoStore(w, http.StatusOK, mgr.Snapshot())
}

func (s *Server) serveSlapRFDisconnectAll(w http.ResponseWriter, r *http.Request, mgr *slaprf.Manager) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	for i := 0; i < slaprf.MaxConnections; i++ {
		_ = mgr.Disconnect(i)
	}
	s.appLog.Infof("[%s] Disconnected all slots", strings.ToUpper(mgr.Transport().Name()))
	writeJSONNoStore(w, http.StatusOK, mgr.Snapshot())
}

func (s *Server) serveSlapRFCommand(w http.ResponseWriter, r *http.Request, mgr *slaprf.Manager) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		SlotIndex  int    `json:"slotIndex"`
		Command    string `json:"command"`
		ExpectType string `json:"expectType,omitempty"`
		TimeoutMs  int    `json:"timeoutMs,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON body"})
		return
	}
	trTag := strings.ToUpper(mgr.Transport().Name())
	cmdTrim := strings.TrimSpace(req.Command)
	if !strings.EqualFold(cmdTrim, "STATUS?") {
		s.appLog.Infof("[%s] Console command on slot=%d: %q", trTag, req.SlotIndex, cmdTrim)
	}
	if req.ExpectType != "" {
		timeout := 3 * time.Second
		if req.TimeoutMs > 0 && req.TimeoutMs <= 20000 {
			timeout = time.Duration(req.TimeoutMs) * time.Millisecond
		}
		reply, err := mgr.RequestReply(req.SlotIndex, req.Command, req.ExpectType, timeout)
		if err != nil {
			writeJSONNoStore(w, http.StatusGatewayTimeout, map[string]any{"error": err.Error()})
			return
		}
		writeJSONNoStore(w, http.StatusOK, map[string]any{
			"ok":    true,
			"reply": reply,
			"pool":  mgr.Snapshot(),
		})
		return
	}
	if err := mgr.SendCommand(req.SlotIndex, req.Command); err != nil {
		writeJSONNoStore(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	writeJSONNoStore(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) serveSlapRFKnownForget(w http.ResponseWriter, r *http.Request, mgr *slaprf.Manager) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	fp := strings.TrimSpace(r.PathValue("fp"))
	if fp == "" {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "missing timer fingerprint"})
		return
	}
	mgr.ForgetKnownTimer(fp)
	s.appLog.Infof("[%s] Forgot known timer fp=%s", strings.ToUpper(mgr.Transport().Name()), fp)
	writeJSONNoStore(w, http.StatusOK, mgr.Snapshot())
}

func (s *Server) serveSlapRFWS(w http.ResponseWriter, r *http.Request, mgr *slaprf.Manager) {
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

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	go func() {
		defer cancel()
		for {
			if _, _, rErr := ws.Read(ctx); rErr != nil {
				return
			}
		}
	}()

	if r.URL.Query().Get("sim") == "1" {
		ch := make(chan []byte, 128)
		unsub := s.subscribeSimHubBytes(func(raw []byte) {
			cp := append([]byte(nil), raw...)
			select {
			case ch <- cp:
			default:
			}
		})
		defer unsub()

		if hellos := s.sim.BuildHubHelloStream(); len(hellos) > 0 {
			wCtx, wCancel := context.WithTimeout(ctx, wsWriteTimeout)
			_ = ws.Write(wCtx, websocket.MessageBinary, hellos)
			wCancel()
		}

		pingTicker := time.NewTicker(wsPingInterval)
		defer pingTicker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case pkt := <-ch:
				wCtx, wCancel := context.WithTimeout(ctx, wsWriteTimeout)
				wErr := ws.Write(wCtx, websocket.MessageBinary, pkt)
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

	evCh := make(chan slaprf.Event, 256)
	unsub := mgr.Subscribe(func(ev slaprf.Event) {
		select {
		case evCh <- ev:
		default:
			if ev.Type == "pool_state" || ev.Type == "status" {
				select {
				case <-evCh:
				default:
				}
				select {
				case evCh <- ev:
				default:
				}
			}
		}
	})
	defer unsub()

	initSnap := mgr.Snapshot()
	if b, mErr := json.Marshal(slaprf.Event{
		Type:      "pool_state",
		SlotIndex: initSnap.DebugSlotIndex,
		Pool:      &initSnap,
	}); mErr == nil {
		wCtx, wCancel := context.WithTimeout(ctx, wsWriteTimeout)
		_ = ws.Write(wCtx, websocket.MessageText, b)
		wCancel()
	}

	pingTicker := time.NewTicker(wsPingInterval)
	defer pingTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case ev := <-evCh:
			b, mErr := json.Marshal(ev)
			if mErr != nil {
				continue
			}
			wCtx, wCancel := context.WithTimeout(ctx, wsWriteTimeout)
			wErr := ws.Write(wCtx, websocket.MessageText, b)
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

func writeJSONNoStore(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
