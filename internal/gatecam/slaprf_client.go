package gatecam

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"slaprf/internal/applog"
	"slaprf/internal/domain"
)

const rssiRingDurationUs = 12_000_000 // Keep 12 s of 50 Hz RSSI history per pilot slot

type rssiPoint struct {
	tsUs uint64
	dbm  float32
}

// slaprfClient maintains the min-RTT clock lock and real-time `/v1/ws/stream` subscription to SlapRF.
type slaprfClient struct {
	cam        CameraProvider
	appLog     *applog.Logger
	onCrossing func(ev domain.GateCrossingEvent)
	onStatus   func()

	mu          sync.RWMutex
	cfg         LinkConfig
	syncSt      SyncStatus
	gateToTimer map[uint8]uint8
	rssiRing    map[string][]rssiPoint // key: "timerId:slotIndex"
	latestRSSI  [domain.MaxPilotSlots]float32

	reconnCh chan struct{}
	stopCh   chan struct{}
	stopOnce sync.Once
}

func newSlapRFClient(cam CameraProvider, cfg LinkConfig, appLog *applog.Logger, onCrossing func(domain.GateCrossingEvent), onStatus func()) *slaprfClient {
	if strings.TrimSpace(cfg.SlapRFURL) == "" {
		cfg.SlapRFURL = "http://127.0.0.1:18090"
	}
	c := &slaprfClient{
		cam:         cam,
		appLog:      appLog,
		onCrossing:  onCrossing,
		onStatus:    onStatus,
		cfg:         cfg,
		syncSt:      SyncStatus{SlapRFURL: cfg.SlapRFURL},
		gateToTimer: make(map[uint8]uint8),
		rssiRing:    make(map[string][]rssiPoint),
		reconnCh:    make(chan struct{}, 1),
		stopCh:      make(chan struct{}),
	}
	for i := range c.latestRSSI {
		c.latestRSSI[i] = -120
	}
	go c.runLoop()
	return c
}

func (c *slaprfClient) Close() {
	c.stopOnce.Do(func() {
		close(c.stopCh)
	})
}

func (c *slaprfClient) UpdateConfig(cfg LinkConfig) {
	if strings.TrimSpace(cfg.SlapRFURL) == "" {
		cfg.SlapRFURL = "http://127.0.0.1:18090"
	}
	cfg.SlapRFURL = strings.TrimRight(strings.TrimSpace(cfg.SlapRFURL), "/")
	c.mu.Lock()
	urlChanged := c.cfg.SlapRFURL != cfg.SlapRFURL || c.cfg.BasicAuth != cfg.BasicAuth
	c.cfg = cfg
	c.syncSt.SlapRFURL = cfg.SlapRFURL
	c.mu.Unlock()
	if urlChanged {
		select {
		case c.reconnCh <- struct{}{}:
		default:
		}
	}
}

func (c *slaprfClient) Config() LinkConfig {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.cfg
}

func (c *slaprfClient) Status() SyncStatus {
	c.mu.RLock()
	defer c.mu.RUnlock()
	cp := c.syncSt
	if len(c.syncSt.Pilots) > 0 {
		cp.Pilots = append([]PilotChannelInfo(nil), c.syncSt.Pilots...)
		var live []SlotRSSI
		for _, p := range cp.Pilots {
			if p.SlotIndex >= 1 && p.SlotIndex <= domain.MaxPilotSlots {
				dbm := c.latestRSSI[p.SlotIndex-1]
				if dbm > -118 && dbm < 0 {
					live = append(live, SlotRSSI{
						SlotIndex: p.SlotIndex,
						Callsign:  p.Callsign,
						RSSIDbm:   float32(round1(float64(dbm))),
					})
				}
			}
		}
		cp.LiveRSSI = live
	}
	if len(c.syncSt.Gates) > 0 {
		cp.Gates = append([]GateInfo(nil), c.syncSt.Gates...)
	}
	return cp
}

// SliceRSSITrace extracts buffered 50 Hz RSSI samples for `(gateId, slotIndex)` in `[startUs, endUs]`.
func (c *slaprfClient) SliceRSSITrace(gateID uint8, slotIndex int, rfTsUs, startUs, endUs uint64) []RSSISample {
	c.mu.RLock()
	defer c.mu.RUnlock()
	timerID := c.gateToTimer[gateID]
	if timerID == 0 {
		timerID = gateID
	}
	pts := c.rssiRing[fmt.Sprintf("%d:%d", timerID, slotIndex)]
	if len(pts) == 0 && timerID != gateID {
		pts = c.rssiRing[fmt.Sprintf("%d:%d", gateID, slotIndex)]
	}
	if len(pts) == 0 {
		// Fall back to any timer that recorded RSSI for this slotIndex
		suffix := fmt.Sprintf(":%d", slotIndex)
		for k, v := range c.rssiRing {
			if strings.HasSuffix(k, suffix) && len(v) > len(pts) {
				pts = v
			}
		}
	}
	out := make([]RSSISample, 0, len(pts))
	for _, pt := range pts {
		if pt.tsUs >= startUs && pt.tsUs <= endUs {
			out = append(out, RSSISample{
				TimestampUs: pt.tsUs,
				RelMs:       round2(float64(int64(pt.tsUs)-int64(rfTsUs)) / 1000.0),
				RSSIDbm:     float32(round1(float64(pt.dbm))),
			})
		}
	}
	return out
}

func (c *slaprfClient) runLoop() {
	hc := &http.Client{Timeout: 3 * time.Second}
	backoff := 1 * time.Second

	for {
		select {
		case <-c.stopCh:
			return
		default:
		}

		sessionCtx, cancelSession := context.WithCancel(context.Background())
		go func() {
			select {
			case <-c.stopCh:
				cancelSession()
			case <-c.reconnCh:
				cancelSession()
			case <-sessionCtx.Done():
			}
		}()

		err := c.runConnectedSession(sessionCtx, hc)
		cancelSession()
		if err != nil {
			c.mu.Lock()
			c.syncSt.Connected = false
			c.syncSt.LastError = err.Error()
			c.mu.Unlock()
			if c.onStatus != nil {
				c.onStatus()
			}
		}

		select {
		case <-c.stopCh:
			return
		case <-c.reconnCh:
			backoff = 500 * time.Millisecond
		case <-time.After(backoff):
			if backoff < 4*time.Second {
				backoff += 500 * time.Millisecond
			}
		}
	}
}

func (c *slaprfClient) runConnectedSession(ctx context.Context, hc *http.Client) error {
	cfg := c.Config()
	baseURL := strings.TrimRight(cfg.SlapRFURL, "/")

	// 1. Perform initial 7-sample Cristian min-RTT clock synchronization + metadata fetch.
	if err := c.syncClockAndMetadata(ctx, hc, baseURL, cfg.BasicAuth, 7); err != nil {
		return err
	}

	// 2. Open WebSocket to /v1/ws/stream
	wsURL, err := toWebSocketURL(baseURL + "/v1/ws/stream")
	if err != nil {
		return err
	}
	hdr := http.Header{}
	if strings.TrimSpace(cfg.BasicAuth) != "" {
		hdr.Set("Authorization", basicAuthHeaderVal(cfg.BasicAuth))
	}
	dialCtx, dialCancel := context.WithTimeout(ctx, 4*time.Second)
	ws, _, err := websocket.Dial(dialCtx, wsURL, &websocket.DialOptions{HTTPHeader: hdr})
	dialCancel()
	if err != nil {
		return err
	}
	ws.SetReadLimit(2 << 20)
	defer func() { _ = ws.CloseNow() }()

	c.mu.Lock()
	c.syncSt.Connected = true
	c.syncSt.LastError = ""
	c.mu.Unlock()
	c.appLog.Infof("[GateCam] Connected to SlapRF stream %s (minRTT=%d us, offset=%d us)",
		baseURL, c.Status().MinRTTUs, c.Status().ClockOffsetUs)
	if c.onStatus != nil {
		c.onStatus()
	}

	// Periodic background clock re-sync every 5 seconds
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = c.syncClockAndMetadata(ctx, hc, baseURL, cfg.BasicAuth, 5)
				if c.onStatus != nil {
					c.onStatus()
				}
			}
		}
	}()

	for {
		msgType, raw, rErr := ws.Read(ctx)
		if rErr != nil {
			return rErr
		}
		if msgType == websocket.MessageBinary {
			c.ingestBinaryTelemetry(raw)
			continue
		}
		c.ingestTextEnvelope(raw)
	}
}

func (c *slaprfClient) syncClockAndMetadata(ctx context.Context, hc *http.Client, baseURL, basicAuth string, samples int) error {
	bestRTTNs := int64(math.MaxInt64)
	var bestOffsetUs int64
	var lastGates []domain.TrackGate

	for i := 0; i < samples; i++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1/status?lite=1", nil)
		if err != nil {
			return err
		}
		if strings.TrimSpace(basicAuth) != "" {
			req.Header.Set("Authorization", basicAuthHeaderVal(basicAuth))
		}
		t0Ns := c.cam.CurrentSensorClockNs()
		resp, err := hc.Do(req)
		t1Ns := c.cam.CurrentSensorClockNs()
		if err != nil {
			return err
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
		_ = resp.Body.Close()
		if resp.StatusCode >= 400 {
			return fmt.Errorf("SlapRF HTTP %d on /v1/status", resp.StatusCode)
		}
		var st struct {
			ServerTimestampUs uint64             `json:"serverTimestampUs"`
			Gates             []domain.TrackGate `json:"gates"`
		}
		if err := json.Unmarshal(body, &st); err != nil {
			return err
		}
		lastGates = st.Gates
		rttNs := t1Ns - t0Ns
		if rttNs >= 0 && rttNs < bestRTTNs {
			bestRTTNs = rttNs
			midSensorUs := ((t0Ns + t1Ns) / 2) / 1000
			bestOffsetUs = int64(st.ServerTimestampUs) - midSensorUs
		}
	}

	// Fetch pilot roster once per sync cycle
	var pilots []domain.PilotSlot
	if pReq, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1/pilots", nil); err == nil {
		if strings.TrimSpace(basicAuth) != "" {
			pReq.Header.Set("Authorization", basicAuthHeaderVal(basicAuth))
		}
		if pResp, pErr := hc.Do(pReq); pErr == nil {
			if pResp.StatusCode == http.StatusOK {
				_ = json.NewDecoder(io.LimitReader(pResp.Body, 256<<10)).Decode(&pilots)
			}
			_ = pResp.Body.Close()
		}
	}

	c.mu.Lock()
	if bestRTTNs < math.MaxInt64 {
		minRTTUs := bestRTTNs / 1000
		c.syncSt.ClockLocked = true
		c.syncSt.ClockOffsetUs = bestOffsetUs
		c.syncSt.MinRTTUs = minRTTUs
		c.syncSt.SyncErrorBoundMs = round2(float64(bestRTTNs) / 2e6)
	}
	if len(lastGates) > 0 {
		c.applyGatesLocked(lastGates)
	}
	if len(pilots) > 0 {
		c.applyPilotsLocked(pilots)
	}
	c.mu.Unlock()
	return nil
}

func (c *slaprfClient) applyGatesLocked(gates []domain.TrackGate) {
	out := make([]GateInfo, 0, len(gates))
	for _, g := range gates {
		out = append(out, GateInfo{
			GateID: g.GateID,
			Name:   g.Name,
			Role:   string(g.Role),
		})
		if g.AssignedTimerID > 0 {
			c.gateToTimer[g.GateID] = g.AssignedTimerID
		}
	}
	c.syncSt.Gates = out
}

func (c *slaprfClient) applyPilotsLocked(pilots []domain.PilotSlot) {
	out := make([]PilotChannelInfo, 0, len(pilots))
	for _, p := range pilots {
		if !p.Enabled && p.FrequencyMHz == 0 && strings.TrimSpace(p.Callsign) == "" {
			continue
		}
		out = append(out, PilotChannelInfo{
			SlotIndex:    p.SlotIndex,
			Callsign:     p.Callsign,
			FrequencyMHz: p.FrequencyMHz,
			Color:        p.Color,
		})
	}
	c.syncSt.Pilots = out
}

func (c *slaprfClient) ingestBinaryTelemetry(b []byte) {
	if len(b) < 4 || b[0] != 1 {
		return
	}
	rssiCount := int(b[1])
	count := int(binary.LittleEndian.Uint16(b[2:4]))
	recLen := 20 + 4*rssiCount
	if rssiCount <= 0 || count <= 0 || len(b) < 4+count*recLen {
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	o := 4
	for i := 0; i < count; i++ {
		timerID := b[o]
		tsUs := uint64(math.Float64frombits(binary.LittleEndian.Uint64(b[o+8 : o+16])))
		maxSlots := rssiCount
		if maxSlots > domain.MaxPilotSlots {
			maxSlots = domain.MaxPilotSlots
		}
		for s := 0; s < maxSlots; s++ {
			dbm := math.Float32frombits(binary.LittleEndian.Uint32(b[o+20+4*s : o+24+4*s]))
			if dbm > -119 && dbm < 0 {
				c.latestRSSI[s] = dbm
				key := fmt.Sprintf("%d:%d", timerID, s+1)
				ring := append(c.rssiRing[key], rssiPoint{tsUs: tsUs, dbm: dbm})
				if len(ring) > 640 {
					cutoff := tsUs - rssiRingDurationUs
					trimIdx := 0
					for trimIdx < len(ring) && ring[trimIdx].tsUs < cutoff {
						trimIdx++
					}
					if trimIdx > 0 {
						ring = append([]rssiPoint(nil), ring[trimIdx:]...)
					}
				}
				c.rssiRing[key] = ring
			}
		}
		o += recLen
	}
}

func (c *slaprfClient) ingestTextEnvelope(raw []byte) {
	var env struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if json.Unmarshal(raw, &env) != nil {
		return
	}
	switch env.Type {
	case "crossing":
		var ev domain.GateCrossingEvent
		if json.Unmarshal(env.Payload, &ev) == nil && c.onCrossing != nil {
			c.onCrossing(ev)
		}
	case "config":
		var cfg struct {
			Pilots []domain.PilotSlot `json:"pilots"`
			Gates  []domain.TrackGate `json:"gates"`
		}
		if json.Unmarshal(env.Payload, &cfg) == nil {
			c.mu.Lock()
			if len(cfg.Pilots) > 0 {
				c.applyPilotsLocked(cfg.Pilots)
			}
			if len(cfg.Gates) > 0 {
				c.applyGatesLocked(cfg.Gates)
			}
			c.mu.Unlock()
			if c.onStatus != nil {
				c.onStatus()
			}
		}
	}
}

func toWebSocketURL(httpURL string) (string, error) {
	u, err := url.Parse(httpURL)
	if err != nil {
		return "", err
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
		u.Scheme = "wss"
	case "http", "":
		u.Scheme = "ws"
	}
	return u.String(), nil
}

func basicAuthHeaderVal(raw string) string {
	clean := strings.TrimSpace(raw)
	if strings.HasPrefix(strings.ToLower(clean), "basic ") {
		return clean
	}
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(clean))
}
