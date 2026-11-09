//go:build !js

package ingest

import (
	"bufio"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

var (
	activeWSMu   sync.Mutex
	activeWSConn net.Conn
)

func (r *WiFiUDPReceiver) sendHTTPChannels(host, hexStr string) {
	go func(h, payload string) {
		if raw, err := hex.DecodeString(payload); err == nil && len(raw) == ChannelsFrameLen {
			activeWSMu.Lock()
			c := activeWSConn
			if c != nil {
				_ = c.SetWriteDeadline(time.Now().Add(500 * time.Millisecond))
				wErr := writeWSClientFrame(c, 0x2, raw)
				_ = c.SetWriteDeadline(time.Time{})
				activeWSMu.Unlock()
				if wErr == nil {
					return
				}
			} else {
				activeWSMu.Unlock()
			}
		}
		client := &http.Client{Timeout: 1500 * time.Millisecond}
		resp, err := client.Get(fmt.Sprintf("http://%s/api/hub-channels?hex=%s", h, payload))
		if err == nil && resp != nil {
			_ = resp.Body.Close()
		}
	}(host, hexStr)
}

// Start begins connecting to the Hub Timer's WebSocket stream (`ws://<host>/ws`) in the background.
func (r *WiFiUDPReceiver) Start() error {
	log.Printf("[Wi-Fi Hub Bridge] Streaming from Hub WebSocket ws://%s/ws", r.HubHost())
	go r.wsLoop()
	return nil
}

func (r *WiFiUDPReceiver) wsLoop() {
	for {
		select {
		case <-r.stopCh:
			return
		default:
		}

		r.mu.Lock()
		primary := r.hubHost
		r.mu.Unlock()

		candidates := []string{primary}
		if primary != DefaultHubHost {
			candidates = append(candidates, DefaultHubHost)
		}

		connectedAny := false
		for _, host := range candidates {
			select {
			case <-r.stopCh:
				return
			default:
			}
			if r.streamFromHost(host) {
				connectedAny = true
				break
			}
		}

		waitDur := 2500 * time.Millisecond
		if connectedAny {
			waitDur = 500 * time.Millisecond
		}
		select {
		case <-r.stopCh:
			return
		case <-time.After(waitDur):
		}
	}
}

func dialAddr(host string) string {
	if strings.Contains(host, ":") {
		return host
	}
	return host + ":80"
}

func writeWSClientFrame(w io.Writer, opcode byte, payload []byte) error {
	mask := [4]byte{0x37, 0xFA, 0x21, 0x3D}
	n := len(payload)
	hdr := make([]byte, 0, 10+n)
	hdr = append(hdr, 0x80|opcode)
	if n < 126 {
		hdr = append(hdr, 0x80|byte(n))
	} else {
		hdr = append(hdr, 0x80|126, byte(n>>8), byte(n))
	}
	hdr = append(hdr, mask[:]...)
	for i := 0; i < n; i++ {
		hdr = append(hdr, payload[i]^mask[i&3])
	}
	_, err := w.Write(hdr)
	return err
}

func (r *WiFiUDPReceiver) streamFromHost(host string) bool {
	conn, err := net.DialTimeout("tcp", dialAddr(host), 1800*time.Millisecond)
	if err != nil {
		return false
	}
	r.mu.Lock()
	r.cancelSSE = func() { _ = conn.Close() }
	r.mu.Unlock()

	defer func() {
		activeWSMu.Lock()
		if activeWSConn == conn {
			activeWSConn = nil
		}
		activeWSMu.Unlock()
		_ = conn.Close()
		r.mu.Lock()
		r.sseConnected = false
		r.mu.Unlock()
	}()

	_ = conn.SetDeadline(time.Now().Add(2000 * time.Millisecond))
	req := fmt.Sprintf(
		"GET /ws HTTP/1.1\r\n"+
			"Host: %s\r\n"+
			"Upgrade: websocket\r\n"+
			"Connection: Upgrade\r\n"+
			"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"+
			"Sec-WebSocket-Version: 13\r\n\r\n",
		host,
	)
	if _, err := conn.Write([]byte(req)); err != nil {
		return false
	}

	br := bufio.NewReader(conn)
	statusLine, err := br.ReadString('\n')
	if err != nil || !strings.Contains(statusLine, "101") {
		return false
	}
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return false
		}
		if strings.TrimSpace(line) == "" {
			break
		}
	}
	_ = conn.SetDeadline(time.Time{})

	activeWSMu.Lock()
	activeWSConn = conn
	activeWSMu.Unlock()

	r.mu.Lock()
	r.activeHost = host
	r.sseConnected = true
	r.mu.Unlock()

	log.Printf("[Wi-Fi Hub Bridge] Connected to Hub WebSocket at ws://%s/ws", host)
	r.pushActiveChannelsToHub()

	var hdr [2]byte
	for {
		_ = conn.SetReadDeadline(time.Now().Add(3500 * time.Millisecond))
		if _, err := io.ReadFull(br, hdr[:]); err != nil {
			return true
		}
		opcode := hdr[0] & 0x0F
		masked := (hdr[1] & 0x80) != 0
		payloadLen := int(hdr[1] & 0x7F)
		switch payloadLen {
		case 126:
			var ext [2]byte
			if _, err := io.ReadFull(br, ext[:]); err != nil {
				return true
			}
			payloadLen = int(binary.BigEndian.Uint16(ext[:]))
		case 127:
			var ext [8]byte
			if _, err := io.ReadFull(br, ext[:]); err != nil {
				return true
			}
			payloadLen = int(binary.BigEndian.Uint64(ext[:]))
		}
		if payloadLen < 0 || payloadLen > 4096 {
			return true
		}
		var maskKey [4]byte
		if masked {
			if _, err := io.ReadFull(br, maskKey[:]); err != nil {
				return true
			}
		}
		payload := make([]byte, payloadLen)
		if payloadLen > 0 {
			if _, err := io.ReadFull(br, payload); err != nil {
				return true
			}
			if masked {
				for i := range payload {
					payload[i] ^= maskKey[i&3]
				}
			}
		}
		switch opcode {
		case 0x2: // Binary frame
			if len(payload) >= 4 {
				r.IngestPacket(payload, r.engine.NowUs())
			}
		case 0x8: // Close
			return true
		case 0x9: // Ping -> reply Pong
			activeWSMu.Lock()
			_ = conn.SetWriteDeadline(time.Now().Add(500 * time.Millisecond))
			_ = writeWSClientFrame(conn, 0xA, payload)
			_ = conn.SetWriteDeadline(time.Time{})
			activeWSMu.Unlock()
		}
	}
}
