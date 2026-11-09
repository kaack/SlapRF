//go:build !js

package ingest

import (
	"bufio"
	"context"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

func (r *WiFiUDPReceiver) sendHTTPChannels(host, hexStr string) {
	go func(h, payload string) {
		client := &http.Client{Timeout: 1500 * time.Millisecond}
		resp, err := client.Get(fmt.Sprintf("http://%s/api/hub-channels?hex=%s", h, payload))
		if err == nil && resp != nil {
			_ = resp.Body.Close()
		}
	}(host, hexStr)
}

// Start begins connecting to the Hub Timer's HTTP SSE stream (`/api/hub-stream`) in the background.
func (r *WiFiUDPReceiver) Start() error {
	log.Printf("[Wi-Fi Hub Bridge] Streaming from Hub SSE http://%s/api/hub-stream", r.HubHost())
	go r.sseLoop()
	return nil
}

func (r *WiFiUDPReceiver) sseLoop() {
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

func (r *WiFiUDPReceiver) streamFromHost(host string) bool {
	ctx, cancel := context.WithCancel(context.Background())
	r.mu.Lock()
	r.cancelSSE = cancel
	r.mu.Unlock()
	defer func() {
		cancel()
		r.mu.Lock()
		r.sseConnected = false
		r.mu.Unlock()
	}()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://%s/api/hub-stream", host), nil)
	if err != nil {
		return false
	}
	req.Header.Set("Accept", "text/event-stream")

	transport := &http.Transport{
		ResponseHeaderTimeout: 1800 * time.Millisecond,
	}
	client := &http.Client{Transport: transport}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}

	r.mu.Lock()
	r.activeHost = host
	r.sseConnected = true
	r.mu.Unlock()

	log.Printf("[Wi-Fi Hub Bridge] Connected to Hub SSE stream at http://%s/api/hub-stream", host)
	r.pushActiveChannelsToHub()

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		hexPayload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if len(hexPayload) < 8 || len(hexPayload)%2 != 0 {
			continue
		}
		raw, decErr := hex.DecodeString(hexPayload)
		if decErr != nil || len(raw) == 0 {
			continue
		}
		r.IngestPacket(raw, r.engine.NowUs())
	}
	return true
}
