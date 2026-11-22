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
)

func (s *Server) handleUSBPorts(w http.ResponseWriter, r *http.Request) {
	if tr := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("transport"))); tr != "" && tr != "usb" {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{
			"error": "Bluetooth discovery uses GET /v1/bluetooth/ports",
		})
		return
	}
	showAll := r.URL.Query().Get("all") == "1" || strings.EqualFold(r.URL.Query().Get("all"), "true")
	s.serveSlapRFPorts(w, r, s.usbMgr, showAll)
}

func (s *Server) handleUSBStatus(w http.ResponseWriter, r *http.Request) {
	s.serveSlapRFStatus(w, r, s.usbMgr)
}

func (s *Server) handleUSBConnect(w http.ResponseWriter, r *http.Request) {
	s.serveSlapRFConnect(w, r, s.usbMgr, "/v1/usb")
}

func (s *Server) handleUSBDisconnectSlot(w http.ResponseWriter, r *http.Request) {
	s.serveSlapRFDisconnectSlot(w, r, s.usbMgr)
}

func (s *Server) handleUSBDisconnectAll(w http.ResponseWriter, r *http.Request) {
	s.serveSlapRFDisconnectAll(w, r, s.usbMgr)
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
	s.serveSlapRFCommand(w, r, s.usbMgr)
}

func (s *Server) handleUSBKnownForget(w http.ResponseWriter, r *http.Request) {
	s.serveSlapRFKnownForget(w, r, s.usbMgr)
}

// handleSimHubUSB controls whether the Go server's simulated Hub `H1` virtual cable is plugged into `simHubRx`.
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
	s.serveSlapRFWS(w, r, s.usbMgr)
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

	port, info, openErr := s.usbTransport.OpenRawPort(s.usbMgr, portName, baud)
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
