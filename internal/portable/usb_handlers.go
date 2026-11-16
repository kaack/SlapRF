package portable

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"

	"slaprf/internal/usb"
)

func (s *Server) handleUSBPorts(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	showAll := r.URL.Query().Get("all") == "1" || strings.EqualFold(r.URL.Query().Get("all"), "true")
	ports, err := s.usbMgr.ListPorts(showAll)
	if err != nil {
		writeJSONNoStore(w, http.StatusOK, map[string]any{
			"ports": []usb.PortInfo{},
			"error": err.Error(),
		})
		return
	}
	if ports == nil {
		ports = []usb.PortInfo{}
	}
	writeJSONNoStore(w, http.StatusOK, map[string]any{
		"ports": ports,
		"pool":  s.usbMgr.Snapshot(),
	})
}

func (s *Server) handleUSBStatus(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSONNoStore(w, http.StatusOK, s.usbMgr.Snapshot())
}

func (s *Server) handleUSBConnect(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
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
	snap, err := s.usbMgr.Connect(req.SlotIndex, req.PortName)
	if err != nil {
		writeJSONNoStore(w, http.StatusBadGateway, map[string]any{
			"error": err.Error(),
			"pool":  s.usbMgr.Snapshot(),
		})
		return
	}
	if s.persistWorker != nil {
		s.persistWorker.MarkDirty()
	}
	writeJSONNoStore(w, http.StatusOK, map[string]any{
		"slot": snap,
		"pool": s.usbMgr.Snapshot(),
	})
}

func (s *Server) handleUSBDisconnect(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		SlotIndex int  `json:"slotIndex"`
		All       bool `json:"all"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.All {
		for i := 0; i < usb.MaxUSBConnections; i++ {
			_ = s.usbMgr.Disconnect(i)
		}
	} else {
		_ = s.usbMgr.Disconnect(req.SlotIndex)
	}
	writeJSONNoStore(w, http.StatusOK, s.usbMgr.Snapshot())
}

func (s *Server) handleUSBDebugSlot(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		SlotIndex int `json:"slotIndex"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON body"})
		return
	}
	s.usbMgr.SetDebugSlot(req.SlotIndex)
	writeJSONNoStore(w, http.StatusOK, s.usbMgr.Snapshot())
}

func (s *Server) handleUSBCommand(w http.ResponseWriter, r *http.Request) {
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
	if req.ExpectType != "" {
		timeout := 3 * time.Second
		if req.TimeoutMs > 0 && req.TimeoutMs <= 20000 {
			timeout = time.Duration(req.TimeoutMs) * time.Millisecond
		}
		reply, err := s.usbMgr.RequestReply(req.SlotIndex, req.Command, req.ExpectType, timeout)
		if err != nil {
			writeJSONNoStore(w, http.StatusGatewayTimeout, map[string]any{"error": err.Error()})
			return
		}
		writeJSONNoStore(w, http.StatusOK, map[string]any{
			"ok":    true,
			"reply": reply,
			"pool":  s.usbMgr.Snapshot(),
		})
		return
	}
	if err := s.usbMgr.SendCommand(req.SlotIndex, req.Command); err != nil {
		writeJSONNoStore(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	writeJSONNoStore(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleUSBFlash(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req usb.FlashBoardRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON body"})
		return
	}
	readout, err := s.usbMgr.FlashBoard(r.Context(), req)
	if err != nil {
		writeJSONNoStore(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	writeJSONNoStore(w, http.StatusOK, map[string]any{
		"ok":      true,
		"readout": readout,
		"pool":    s.usbMgr.Snapshot(),
	})
}

func (s *Server) handleUSBErase(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		PortName  string `json:"portName"`
		SlotIndex int    `json:"slotIndex"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON body"})
		return
	}
	if err := s.usbMgr.EraseBoard(r.Context(), req.PortName, req.SlotIndex); err != nil {
		writeJSONNoStore(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	writeJSONNoStore(w, http.StatusOK, map[string]any{
		"ok":   true,
		"pool": s.usbMgr.Snapshot(),
	})
}

func (s *Server) handleUSBKnownForget(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		FP string `json:"fp"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON body"})
		return
	}
	s.usbMgr.ForgetKnownTimer(req.FP)
	writeJSONNoStore(w, http.StatusOK, s.usbMgr.Snapshot())
}

// handleSimHubUSB controls whether the Go server's simulated Hub `H1` virtual USB cable is plugged into `simHubRx`.
func (s *Server) handleSimHubUSB(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method == http.MethodGet {
		writeJSONNoStore(w, http.StatusOK, map[string]any{
			"connected": s.simHubUSBConnected.Load(),
		})
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Connected bool `json:"connected"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON body"})
		return
	}
	s.setSimHubUSBConnected(req.Connected)
	writeJSONNoStore(w, http.StatusOK, map[string]any{
		"connected": s.simHubUSBConnected.Load(),
	})
}

func (s *Server) handleUSBWS(w http.ResponseWriter, r *http.Request) {
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

	isSimWS := r.URL.Query().Get("sim") == "1"
	if isSimWS {
		ch := make(chan []byte, 128)
		unsub := s.subscribeSimHubBytes(func(raw []byte) {
			cp := append([]byte(nil), raw...)
			select {
			case ch <- cp:
			default:
			}
		})
		defer unsub()

		// Immediately send cached HELLO stream so the simulated USB console has H1 + Spokes right away
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

	evCh := make(chan usb.USBEvent, 256)
	unsub := s.usbMgr.Subscribe(func(ev usb.USBEvent) {
		select {
		case evCh <- ev:
		default:
			if ev.Type == "pool_state" || ev.Type == "flash_progress" || ev.Type == "status" {
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

	// Send initial pool snapshot on connect
	initSnap := s.usbMgr.Snapshot()
	if b, mErr := json.Marshal(usb.USBEvent{
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
