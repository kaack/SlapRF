package portable

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"slaprf/internal/firmware"
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
	transport := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("transport")))
	var (
		ports []usb.PortInfo
		err   error
	)
	switch transport {
	case "usb":
		ports, err = s.usbMgr.ListUSBPorts(showAll)
	case "ble":
		ports, err = s.usbMgr.ListBLEPorts()
	default:
		ports, err = s.usbMgr.ListPorts(showAll)
	}
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
		if err != nil || parsed < 0 || parsed >= usb.MaxUSBConnections {
			writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "invalid USB slotIndex"})
			return
		}
		req.SlotIndex = parsed
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
	status := http.StatusOK
	if r.Method == http.MethodPost {
		w.Header().Set("Location", "/v1/usb/connections/"+strconv.Itoa(req.SlotIndex))
		status = http.StatusCreated
	}
	writeJSONNoStore(w, status, map[string]any{
		"slot": snap,
		"pool": s.usbMgr.Snapshot(),
	})
}

func (s *Server) handleUSBDisconnectSlot(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	rawSlot := strings.TrimSpace(r.PathValue("slotIndex"))
	slotIndex, err := strconv.Atoi(rawSlot)
	if err != nil || slotIndex < 0 || slotIndex >= usb.MaxUSBConnections {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "invalid USB slotIndex"})
		return
	}
	if r.URL.Query().Get("forget") == "1" {
		_ = s.usbMgr.ForgetSlot(slotIndex, r.URL.Query().Get("fp"))
	} else {
		_ = s.usbMgr.Disconnect(slotIndex)
	}
	writeJSONNoStore(w, http.StatusOK, s.usbMgr.Snapshot())
}

func (s *Server) handleUSBDisconnectAll(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	for i := 0; i < usb.MaxUSBConnections; i++ {
		_ = s.usbMgr.Disconnect(i)
	}
	writeJSONNoStore(w, http.StatusOK, s.usbMgr.Snapshot())
}

func (s *Server) handleUSBDebugSlot(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method == http.MethodGet {
		snap := s.usbMgr.Snapshot()
		writeJSONNoStore(w, http.StatusOK, map[string]any{
			"slotIndex": snap.DebugSlotIndex,
			"pool":      snap,
		})
		return
	}
	if r.Method != http.MethodPut {
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

func (s *Server) handleUSBKnownForget(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	fp := strings.TrimSpace(r.PathValue("fp"))
	if fp == "" {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "missing timer fingerprint"})
		return
	}
	s.usbMgr.ForgetKnownTimer(fp)
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
	if r.Method != http.MethodPut {
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

// handleUSBRawWS bridges an exclusive physical USB serial port (OS serial or Android USB Host)
// over a raw binary + control WebSocket so esptool-js can read, flash, and erase XIAO ESP32-C5
// timers natively on Android WebView and non-WebSerial browsers.
func (s *Server) handleUSBRawWS(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	ws.SetReadLimit(512 << 10)
	defer func() { _ = ws.CloseNow() }()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	var wsWriteMu sync.Mutex
	sendText := func(v any) error {
		b, mErr := json.Marshal(v)
		if mErr != nil {
			return mErr
		}
		wsWriteMu.Lock()
		defer wsWriteMu.Unlock()
		wCtx, wCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer wCancel()
		return ws.Write(wCtx, websocket.MessageText, b)
	}
	sendBin := func(payload []byte) error {
		wsWriteMu.Lock()
		defer wsWriteMu.Unlock()
		wCtx, wCancel := context.WithTimeout(ctx, 10*time.Second)
		defer wCancel()
		return ws.Write(wCtx, websocket.MessageBinary, payload)
	}

	portName := strings.TrimSpace(r.URL.Query().Get("port"))
	baud := 115200
	if bStr := strings.TrimSpace(r.URL.Query().Get("baud")); bStr != "" {
		if bNum, pErr := strconv.Atoi(bStr); pErr == nil && bNum > 0 {
			baud = bNum
		}
	}

	port, info, openErr := s.usbMgr.OpenRawPort(portName, baud)
	if openErr != nil {
		_ = sendText(map[string]any{
			"type":  "open",
			"ok":    false,
			"error": openErr.Error(),
		})
		_ = ws.Close(websocket.StatusNormalClosure, "open failed")
		return
	}

	var closePortOnce sync.Once
	closePort := func() {
		closePortOnce.Do(func() {
			_ = port.Close()
		})
	}
	defer closePort()
	_ = port.SetReadTimeout(40 * time.Millisecond)

	vidNum := 0
	if info.VID != "" {
		if parsed, pErr := strconv.ParseInt(info.VID, 16, 32); pErr == nil {
			vidNum = int(parsed)
		}
	}
	if vidNum == 0 && info.IsEspressif {
		vidNum = 0x303A
	}
	pidNum := 0
	if info.PID != "" {
		if parsed, pErr := strconv.ParseInt(info.PID, 16, 32); pErr == nil {
			pidNum = int(parsed)
		}
	}
	if pidNum == 0 && vidNum == 0x303A {
		pidNum = 0x1001
	}

	if wErr := sendText(map[string]any{
		"type":     "open",
		"ok":       true,
		"portName": info.Name,
		"vid":      vidNum,
		"pid":      pidNum,
	}); wErr != nil {
		return
	}

	var closingCleanly sync.Mutex
	isClosing := false

	go func() {
		defer cancel()
		buf := make([]byte, 8192)
		for {
			if ctx.Err() != nil {
				return
			}
			n, rErr := port.Read(buf)
			if n > 0 {
				if wErr := sendBin(buf[:n]); wErr != nil {
					return
				}
			}
			if rErr != nil {
				closingCleanly.Lock()
				clean := isClosing
				closingCleanly.Unlock()
				if !clean {
					_ = sendText(map[string]any{"type": "closed"})
				}
				return
			}
		}
	}()

	for {
		msgType, msgBytes, rErr := ws.Read(ctx)
		if rErr != nil {
			return
		}
		if msgType == websocket.MessageBinary {
			written := 0
			for written < len(msgBytes) {
				wn, wErr := port.Write(msgBytes[written:])
				if wErr != nil {
					_ = sendText(map[string]any{
						"type":  "error",
						"error": wErr.Error(),
					})
					return
				}
				if wn <= 0 {
					break
				}
				written += wn
			}
			continue
		}

		var ctrl struct {
			Type string `json:"type"`
			ID   int    `json:"id"`
			DTR  bool   `json:"dtr"`
			RTS  bool   `json:"rts"`
		}
		if jErr := json.Unmarshal(msgBytes, &ctrl); jErr != nil {
			continue
		}
		switch ctrl.Type {
		case "signals":
			var sigErr error
			if atomicPort, ok := port.(firmware.AtomicDTRRTSSetter); ok {
				sigErr = atomicPort.SetDTRRTS(ctrl.DTR, ctrl.RTS)
			} else {
				_ = port.SetRTS(ctrl.RTS)
				sigErr = port.SetDTR(ctrl.DTR)
			}
			resp := map[string]any{
				"type": "ack",
				"id":   ctrl.ID,
				"ok":   sigErr == nil,
			}
			if sigErr != nil {
				resp["error"] = sigErr.Error()
			}
			_ = sendText(resp)
		case "close":
			closingCleanly.Lock()
			isClosing = true
			closingCleanly.Unlock()
			closePort()
			_ = sendText(map[string]any{
				"type": "ack",
				"id":   ctrl.ID,
				"ok":   true,
			})
			_ = ws.Close(websocket.StatusNormalClosure, "closed")
			return
		}
	}
}
