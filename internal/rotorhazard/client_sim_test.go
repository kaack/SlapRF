package rotorhazard

import (
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"slaprf/internal/domain"
)

func TestEIOAndSIOCodec(t *testing.T) {
	zeroArg, err := EncodeSIOEvent("discard_laps", nil, false)
	if err != nil {
		t.Fatalf("EncodeSIOEvent zero-arg failed: %v", err)
	}
	if zeroArg != `42["discard_laps"]` {
		t.Fatalf("expected exact zero-arg Socket.IO packet, got %q", zeroArg)
	}
	decZero, err := DecodeSIOEvent(zeroArg)
	if err != nil || decZero.Name != "discard_laps" || decZero.HasArg {
		t.Fatalf("unexpected decoded zero-arg packet: %+v, err=%v", decZero, err)
	}

	withArg, err := EncodeSIOEvent("join_cluster_ex", map[string]any{"mode": "split"}, true)
	if err != nil {
		t.Fatalf("EncodeSIOEvent with-arg failed: %v", err)
	}
	decArg, err := DecodeSIOEvent(withArg)
	if err != nil || decArg.Name != "join_cluster_ex" || !decArg.HasArg {
		t.Fatalf("unexpected decoded with-arg packet: %+v, err=%v", decArg, err)
	}

	joined := JoinEIOPayload(`40{"sid":"abc"}`, withArg)
	parts := SplitEIOPayload(joined)
	if len(parts) != 2 || parts[0] != `40{"sid":"abc"}` || parts[1] != withArg {
		t.Fatalf("SplitEIOPayload EIO v4 failed: %v", parts)
	}

	// Legacy Engine.IO v3 `<len>:<pkt>` framing compatibility
	eio3 := `15:40{"sid":"abc"}19:42["discard_laps"]!`
	// Note: 19 chars is `42["discard_laps"]!`
	parts3 := SplitEIOPayload(eio3)
	if len(parts3) != 2 || parts3[0] != `40{"sid":"abc"}` {
		t.Fatalf("SplitEIOPayload EIO v3 failed: %v", parts3)
	}
}

func TestClientAndSimServerInMemorySplitLifecycle(t *testing.T) {
	var engineClockUs uint64 = 10_000_000 // 10.000s
	rhBaseEpochMs := 1_700_000_050_000.0  // arbitrary wall clock on Pi

	simSrv := NewSimServer(SimServerConfig{
		Hostname:      "rh-gate1",
		ReleaseVer:    "4.5.1",
		NodeCount:     8,
		AdminUsername: "admin",
		AdminPassword: "rotorhazard",
		EpochMsFn: func() float64 {
			return rhBaseEpochMs + float64(engineClockUs)/1000.0
		},
	})

	var hbCount int
	var passes []ClientPassEvent
	var client *Client

	simSrv.AttachSession("mem-1", "admin", "rotorhazard", func(sioPkt string) {
		client.FeedSIOFrame(sioPkt)
	})

	client = NewClient(ClientHooks{
		NowUs: func() uint64 { return engineClockUs },
		SendSIO: func(sioPkt string) {
			simSrv.HandleClientFrame("mem-1", sioPkt)
		},
		OnHeartbeat: func(ev ClientHeartbeatEvent) {
			hbCount++
		},
		OnPass: func(ev ClientPassEvent) {
			passes = append(passes, ev)
		},
	})

	var nodes [domain.MaxPilotSlots]NodeConfig
	nodes[0] = NodeConfig{
		Enabled:      true,
		Band:         domain.BandRaceband,
		Channel:      1,
		FrequencyMHz: 5658,
		EnterAtLevel: 100,
		ExitAtLevel:  75,
	}
	nodes[1] = NodeConfig{
		Enabled:      true,
		Band:         domain.BandRaceband,
		Channel:      3,
		FrequencyMHz: 5732,
		EnterAtLevel: 110,
		ExitAtLevel:  80,
	}

	client.OnConnected()
	// Start disarmed: heartbeat streams, but passes MUST be suppressed while disarmed (`RHRace.py` contract)
	client.SyncNodesAndArm(nodes, false)

	snap := client.Snapshot()
	if !snap.Connected || !snap.AuthKnown || !snap.AuthOK || !snap.ClockSynced {
		t.Fatalf("expected connected, authenticated, clock-synced client, got %+v", snap)
	}
	if snap.ServerVersion != "4.5.1" || snap.ServerHostname != "rh-gate1" || snap.NodeCount != 8 {
		t.Fatalf("unexpected server metadata: %+v", snap)
	}
	if simSrv.RaceStatus() != RHRaceStatusReady {
		t.Fatalf("expected disarmed RH server in READY(0), got %d", simSrv.RaceStatus())
	}

	// Simulate a gate pass while disarmed -> heartbeat increments, 0 passes emitted
	var rssi [domain.MaxPilotSlots]float32
	for i := range rssi {
		rssi[i] = 24
	}
	engineClockUs += 100_000
	rssi[0] = 185
	simSrv.StepRSSI(rhBaseEpochMs+float64(engineClockUs)/1000.0, rssi, true)
	engineClockUs += 100_000
	rssi[0] = 40
	simSrv.StepRSSI(rhBaseEpochMs+float64(engineClockUs)/1000.0, rssi, true)
	if hbCount < 2 {
		t.Fatalf("expected heartbeats while disarmed, got %d", hbCount)
	}
	if len(passes) != 0 {
		t.Fatalf("expected 0 passes while disarmed, got %d", len(passes))
	}

	// Arm gate detection -> RH enters RACING(1) immediately via secondary_race_format
	client.SyncNodesAndArm(nodes, true)
	if simSrv.RaceStatus() != RHRaceStatusRacing {
		t.Fatalf("expected armed RH server in RACING(1), got %d", simSrv.RaceStatus())
	}

	// Simulate approach -> peak (212 at t = 15.250s) -> exit (< 75)
	engineClockUs = 15_100_000
	rssi[0] = 120
	simSrv.StepRSSI(rhBaseEpochMs+float64(engineClockUs)/1000.0, rssi, false)

	peakUs := uint64(15_250_000)
	engineClockUs = peakUs
	rssi[0] = 212
	simSrv.StepRSSI(rhBaseEpochMs+float64(engineClockUs)/1000.0, rssi, true)

	engineClockUs = 15_400_000
	rssi[0] = 55
	simSrv.StepRSSI(rhBaseEpochMs+float64(engineClockUs)/1000.0, rssi, true)

	if len(passes) != 1 {
		t.Fatalf("expected 1 pass_record when armed, got %d", len(passes))
	}
	got := passes[0]
	if got.SlotIndex != 1 || got.FrequencyMHz != 5658 || got.PeakRSSI != 212 {
		t.Fatalf("unexpected pass event: %+v", got)
	}
	diffUs := int64(got.HostTimeUs) - int64(peakUs)
	if diffUs < -2000 || diffUs > 2000 {
		t.Fatalf("expected pass timestamp mapped within 2ms of peakUs (%d), got %d (diff %d us)", peakUs, got.HostTimeUs, diffUs)
	}
	if simSrv.AckedPasses() != 1 {
		t.Fatalf("expected SendAckQueue cluster_message_ack count == 1, got %d", simSrv.AckedPasses())
	}

	// Disarm -> stop_race + zero-arg discard_laps -> returns cleanly to READY(0), ready to re-arm!
	client.SyncNodesAndArm(nodes, false)
	if simSrv.RaceStatus() != RHRaceStatusReady {
		t.Fatalf("expected disarmed RH server back in READY(0) after stop_race+discard_laps, got %d", simSrv.RaceStatus())
	}
	client.SyncNodesAndArm(nodes, true)
	if simSrv.RaceStatus() != RHRaceStatusRacing {
		t.Fatalf("expected re-armed RH server in RACING(1), got %d", simSrv.RaceStatus())
	}
}

func TestHTTPPollingBasicAuthToWebSocketUpgrade(t *testing.T) {
	simSrv := NewSimServer(SimServerConfig{
		Hostname:      "rh-lan-pi",
		ReleaseVer:    "4.5.1",
		NodeCount:     4,
		AdminUsername: "admin",
		AdminPassword: "secret-rh-pass",
		EpochMsFn:     func() float64 { return float64(time.Now().UnixMilli()) },
	})
	ts := httptest.NewServer(simSrv.HTTPHandler())
	defer ts.Close()

	// 1. Verify CORS preflight allows Authorization header with credentials
	optReq, _ := http.NewRequest(http.MethodOptions, ts.URL+"/socket.io/?EIO=4&transport=polling", nil)
	optReq.Header.Set("Origin", "http://127.0.0.1:8090")
	optReq.Header.Set("Access-Control-Request-Method", "GET")
	optReq.Header.Set("Access-Control-Request-Headers", "authorization,content-type")
	optResp, err := http.DefaultClient.Do(optReq)
	if err != nil {
		t.Fatalf("CORS preflight failed: %v", err)
	}
	_ = optResp.Body.Close()
	if optResp.Header.Get("Access-Control-Allow-Origin") != "http://127.0.0.1:8090" ||
		optResp.Header.Get("Access-Control-Allow-Credentials") != "true" ||
		!strings.Contains(strings.ToLower(optResp.Header.Get("Access-Control-Allow-Headers")), "authorization") {
		t.Fatalf("unexpected CORS preflight headers: %+v", optResp.Header)
	}

	// 2. Step 1 of browser Engine.IO handshake: HTTP polling GET with Basic Auth
	basicHdr := "Basic " + base64.StdEncoding.EncodeToString([]byte("admin:secret-rh-pass"))
	pollURL := ts.URL + "/socket.io/?EIO=4&transport=polling"
	getReq, _ := http.NewRequest(http.MethodGet, pollURL, nil)
	getReq.Header.Set("Authorization", basicHdr)
	getResp, err := http.DefaultClient.Do(getReq)
	if err != nil {
		t.Fatalf("polling open GET failed: %v", err)
	}
	openBody, _ := io.ReadAll(getResp.Body)
	_ = getResp.Body.Close()
	eioOpen, err := DecodeEIOOpen(string(openBody))
	if err != nil {
		t.Fatalf("DecodeEIOOpen failed on %q: %v", string(openBody), err)
	}

	// 3. Step 2: HTTP polling POST `40` (Socket.IO connect)
	sidPollURL := pollURL + "&sid=" + eioOpen.SID
	postReq, _ := http.NewRequest(http.MethodPost, sidPollURL, bytes.NewBufferString("40"))
	postReq.Header.Set("Authorization", basicHdr)
	postResp, err := http.DefaultClient.Do(postReq)
	if err != nil {
		t.Fatalf("polling connect POST failed: %v", err)
	}
	_ = postResp.Body.Close()

	// 4. Step 3: Upgrade to WebSocket WITHOUT custom headers (matching browser `new WebSocket()`)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/socket.io/?EIO=4&transport=websocket&sid=" + eioOpen.SID
	ws, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("WebSocket upgrade dial failed: %v", err)
	}
	defer func() { _ = ws.CloseNow() }()

	// EIO v4 probe -> upgrade (`2probe` -> `3probe` -> `5`)
	if err := ws.Write(ctx, websocket.MessageText, []byte("2probe")); err != nil {
		t.Fatalf("write 2probe failed: %v", err)
	}
	_, probeResp, err := ws.Read(ctx)
	if err != nil || string(probeResp) != "3probe" {
		t.Fatalf("expected 3probe, got %q (err=%v)", string(probeResp), err)
	}
	if err := ws.Write(ctx, websocket.MessageText, []byte("5")); err != nil {
		t.Fatalf("write upgrade 5 failed: %v", err)
	}

	// Hook `Client` over this upgraded WebSocket and verify `auth_ok == true` + `stage_race` works!
	var wg sync.WaitGroup
	var metaMu sync.Mutex
	var latestMeta ClientStatusSnapshot

	client := NewClient(ClientHooks{
		NowUs: func() uint64 { return uint64(time.Now().UnixMicro()) },
		SendSIO: func(sioFrame string) {
			_ = ws.Write(ctx, websocket.MessageText, []byte(sioFrame))
		},
		OnMeta: func(st ClientStatusSnapshot) {
			metaMu.Lock()
			latestMeta = st
			metaMu.Unlock()
		},
	})

	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			_, data, rErr := ws.Read(ctx)
			if rErr != nil {
				return
			}
			msg := string(data)
			if strings.HasPrefix(msg, "42") {
				client.FeedSIOFrame(msg)
			}
		}
	}()

	var nodes [domain.MaxPilotSlots]NodeConfig
	nodes[0] = NodeConfig{Enabled: true, Band: domain.BandRaceband, Channel: 1, FrequencyMHz: 5658, EnterAtLevel: 98, ExitAtLevel: 72}
	client.OnConnected()
	client.SyncNodesAndArm(nodes, true)

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		metaMu.Lock()
		ok := latestMeta.AuthKnown && latestMeta.AuthOK && latestMeta.NodeCount == 4 && simSrv.RaceStatus() == RHRaceStatusRacing
		metaMu.Unlock()
		if ok {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	metaMu.Lock()
	finalMeta := latestMeta
	metaMu.Unlock()
	if !finalMeta.AuthKnown || !finalMeta.AuthOK || finalMeta.NodeCount != 4 || simSrv.RaceStatus() != RHRaceStatusRacing {
		t.Fatalf("expected upgraded WS session to retain Basic Auth and arm 4-node RH server; meta=%+v, raceStatus=%d", finalMeta, simSrv.RaceStatus())
	}

	cancel()
	_ = ws.CloseNow()
	wg.Wait()
}
