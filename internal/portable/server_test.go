package portable_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"

	"slaprf/internal/firmware"
	"slaprf/internal/laprf"
	"slaprf/internal/portable"
	"slaprf/internal/rotorhazard"
	"slaprf/internal/tracker"
	"slaprf/internal/usb"
)

func TestCapabilitiesCORSAndRemoteSlapRFOrigin(t *testing.T) {
	srv := portable.NewServer(portable.Config{
		Version: "v2.0.0-native",
		StaticFS: fstest.MapFS{
			"index.html": &fstest.MapFile{Data: []byte("<html>slaprf</html>")},
		},
	})
	defer srv.Close()

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// 1. Valid same-origin request
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/capabilities", nil)
	req.Header.Set("Origin", ts.URL)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /api/capabilities failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var caps portable.CapabilitiesResponse
	if err := json.NewDecoder(resp.Body).Decode(&caps); err != nil {
		t.Fatalf("decode capabilities: %v", err)
	}
	if !caps.Portable || !caps.NativeEngine || !caps.NativeUSB || caps.StorageBackend != "bbolt" || caps.Version != "v2.0.0-native" {
		t.Fatalf("unexpected capabilities payload: %+v", caps)
	}

	// 2. Official hosted UI (https://slaprf.app) Private Network Access preflight + GET allowed
	preReq, _ := http.NewRequest(http.MethodOptions, ts.URL+"/api/capabilities", nil)
	preReq.Header.Set("Origin", "https://slaprf.app")
	preReq.Header.Set("Access-Control-Request-Method", "GET")
	preReq.Header.Set("Access-Control-Request-Private-Network", "true")
	preResp, err := http.DefaultClient.Do(preReq)
	if err != nil {
		t.Fatalf("OPTIONS preflight failed: %v", err)
	}
	preResp.Body.Close()
	if preResp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204 preflight, got %d", preResp.StatusCode)
	}
	if preResp.Header.Get("Access-Control-Allow-Origin") != "https://slaprf.app" {
		t.Fatalf("missing ACAO header for slaprf.app")
	}
	if preResp.Header.Get("Access-Control-Allow-Private-Network") != "true" {
		t.Fatalf("missing Access-Control-Allow-Private-Network: true header")
	}

	// 3. Untrusted external origin rejected with 403
	badReq, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/capabilities", nil)
	badReq.Header.Set("Origin", "https://evil.example.com")
	badResp, err := http.DefaultClient.Do(badReq)
	if err != nil {
		t.Fatalf("cross-origin request err: %v", err)
	}
	badResp.Body.Close()
	if badResp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for untrusted origin, got %d", badResp.StatusCode)
	}
}

func TestMultiGPProxy(t *testing.T) {
	var seenPath, seenQuery, seenAPIKey string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		seenQuery = r.URL.RawQuery
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if k, ok := payload["apiKey"].(string); ok {
			seenAPIKey = k
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":      true,
			"chapterId":   42,
			"chapterName": "Bay Area FPV",
		})
	}))
	defer upstream.Close()

	srv := portable.NewServer(portable.Config{
		Version:        "test",
		MultiGPBaseURL: upstream.URL + "/mgp/multigpwebservice",
	})
	defer srv.Close()

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := bytes.NewBufferString(`{"apiKey":"MGP-TEST-KEY"}`)
	resp, err := http.Post(ts.URL+"/api/mgp/race/assignSlot?id=99&cycle=1&heat=2&slot=3", "application/json", body)
	if err != nil {
		t.Fatalf("POST /api/mgp failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if seenPath != "/mgp/multigpwebservice/race/assignSlot" || seenQuery != "id=99&cycle=1&heat=2&slot=3" || seenAPIKey != "MGP-TEST-KEY" {
		t.Fatalf("unexpected upstream forwarding: path=%q query=%q key=%q", seenPath, seenQuery, seenAPIKey)
	}

	travResp, err := http.Post(ts.URL+"/api/mgp/race/../../admin", "application/json", bytes.NewBufferString(`{}`))
	if err != nil {
		t.Fatalf("traversal POST failed: %v", err)
	}
	travResp.Body.Close()
	if travResp.StatusCode == http.StatusOK {
		t.Fatalf("expected path traversal to be rejected")
	}
}

func TestNativeStreamWebSocketAndBboltRestartPersistence(t *testing.T) {
	dbFile := filepath.Join(t.TempDir(), "slaprf.db")

	srv1 := portable.NewServer(portable.Config{
		Version: "test",
		DBPath:  dbFile,
	})
	ts1 := httptest.NewServer(srv1.Handler())

	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()

	wsURL := "ws" + strings.TrimPrefix(ts1.URL, "http") + "/api/ws/stream"
	ws, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial /api/ws/stream: %v", err)
	}

	// Enable Simulation mode + plug virtual H1 USB on the Go server and add Pilot in Sim mode
	modeResp, err := http.Post(ts1.URL+"/api/sim/mode", "application/json", bytes.NewBufferString(`{"running":true}`))
	if err != nil || modeResp.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/sim/mode failed: %v", err)
	}
	modeResp.Body.Close()

	hubResp, err := http.Post(ts1.URL+"/api/sim/hub-usb", "application/json", bytes.NewBufferString(`{"connected":true}`))
	if err != nil || hubResp.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/sim/hub-usb failed: %v", err)
	}
	hubResp.Body.Close()

	addResp, err := http.Post(ts1.URL+"/api/pilots/add", "application/json", bytes.NewBufferString(`{"callsign":"BOLT_PILOT","phoneticName":"Bolt Pilot"}`))
	if err != nil || addResp.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/pilots/add failed: %v", err)
	}
	addResp.Body.Close()

	// Expect binary telemetry batch (version byte 0x01) over /api/ws/stream from native Go simulator
	sawBinaryTelemetry := false
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		rCtx, rCancel := context.WithTimeout(ctx, 1*time.Second)
		typ, data, rErr := ws.Read(rCtx)
		rCancel()
		if rErr != nil {
			t.Fatalf("read /api/ws/stream: %v", rErr)
		}
		if typ == websocket.MessageBinary && len(data) > 4 && data[0] == 1 {
			sawBinaryTelemetry = true
			break
		}
	}
	if !sawBinaryTelemetry {
		t.Fatalf("expected binary telemetry batch from native Go simulator over /api/ws/stream")
	}

	_ = ws.CloseNow()
	ts1.Close()
	srv1.Close() // Flushes bbolt cleanly

	// Boot a brand-new server instance against the same single-file slaprf.db
	srv2 := portable.NewServer(portable.Config{
		Version: "test",
		DBPath:  dbFile,
	})
	defer srv2.Close()
	ts2 := httptest.NewServer(srv2.Handler())
	defer ts2.Close()

	stResp, err := http.Get(ts2.URL + "/api/state")
	if err != nil {
		t.Fatalf("GET /api/state on restarted server: %v", err)
	}
	defer stResp.Body.Close()
	bodyBytes, _ := json.Marshal(map[string]any{})
	_ = bodyBytes
	var rawState map[string]any
	if err := json.NewDecoder(stResp.Body).Decode(&rawState); err != nil {
		t.Fatalf("decode /api/state: %v", err)
	}
	if simRun, _ := rawState["simulatorRunning"].(bool); !simRun {
		t.Fatalf("expected simulatorRunning=true hydrated from bbolt, got %v", rawState["simulatorRunning"])
	}
	rawJSON, _ := json.Marshal(rawState)
	if !strings.Contains(string(rawJSON), "BOLT_PILOT") {
		t.Fatalf("expected BOLT_PILOT hydrated from bbolt across server restart")
	}
}

func TestNativeLiveTimeListenerAndLapRFClientConnect(t *testing.T) {
	// 1. Spin up a mock physical LapRF 8-Way puck on loopback
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen mock puck: %v", err)
	}
	defer ln.Close()
	puckPort := ln.Addr().(*net.TCPAddr).Port

	puck := laprf.NewServer(tracker.NewEngine())
	go func() {
		for {
			c, aErr := ln.Accept()
			if aErr != nil {
				return
			}
			go puck.ServeConn(c)
		}
	}()

	srv := portable.NewServer(portable.Config{Version: "test"})
	defer srv.Close()
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// 2. Enable native Go LiveTime TCP listener (port 0 loopback) and talk LapRF directly to it
	ltResp, err := http.Post(ts.URL+"/api/livetime/config", "application/json", bytes.NewBufferString(`{"enabled":true,"port":0,"bind":"loopback"}`))
	if err != nil || ltResp.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/livetime/config failed: %v", err)
	}
	var ltSnap portable.LiveTimeSnapshot
	_ = json.NewDecoder(ltResp.Body).Decode(&ltSnap)
	ltResp.Body.Close()
	if ltSnap.RelayState != "connected" || ltSnap.ListenAddr == "" {
		t.Fatalf("expected native LiveTime listener connected, got %+v", ltSnap)
	}

	ltConn, err := net.Dial("tcp", ltSnap.ListenAddr)
	if err != nil {
		t.Fatalf("dial native LiveTime listener %s: %v", ltSnap.ListenAddr, err)
	}
	defer ltConn.Close()
	reqFrame := (&laprf.Packet{Type: laprf.RecordTime}).Encode()
	_, _ = ltConn.Write(reqFrame)
	buf := make([]byte, 256)
	_ = ltConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, err := ltConn.Read(buf)
	if err != nil || n == 0 {
		t.Fatalf("expected LapRF frame from native LiveTime server, err=%v", err)
	}

	// 3. Discover mock LapRF 8-Way puck via /api/laprf-discover
	discResp, err := http.Get(ts.URL + "/api/laprf-discover?hosts=127.0.0.1&port=" + strconv.Itoa(puckPort))
	if err != nil {
		t.Fatalf("GET /api/laprf-discover: %v", err)
	}
	var discPayload struct {
		Devices []portable.DiscoveredLapRFDevice `json:"devices"`
	}
	_ = json.NewDecoder(discResp.Body).Decode(&discPayload)
	discResp.Body.Close()
	if len(discPayload.Devices) != 1 || !discPayload.Devices[0].Verified {
		t.Fatalf("expected 1 verified LapRF device, got %+v", discPayload.Devices)
	}

	// 4. Switch realEngine to LapRF 8-Way mode and connect natively in Go via /api/laprf/connect
	tsResp, _ := http.Post(ts.URL+"/api/hardware/mode", "application/json", bytes.NewBufferString(`{"mode":"laprf"}`))
	if tsResp != nil {
		tsResp.Body.Close()
	}
	connBody, _ := json.Marshal(map[string]any{
		"host":  "127.0.0.1",
		"port":  puckPort,
		"label": "Start Puck",
	})
	cResp, err := http.Post(ts.URL+"/api/laprf/connect", "application/json", bytes.NewReader(connBody))
	if err != nil || cResp.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/laprf/connect failed: status=%v err=%v", cResp, err)
	}
	cResp.Body.Close()

	// Wait briefly for dual-probe RTC sync + status heartbeat
	time.Sleep(250 * time.Millisecond)
	stResp, err := http.Get(ts.URL + "/api/laprf/status")
	if err != nil {
		t.Fatalf("GET /api/laprf/status: %v", err)
	}
	var stPayload struct {
		Sessions []portable.LapRFDiagSnapshot `json:"sessions"`
	}
	_ = json.NewDecoder(stResp.Body).Decode(&stPayload)
	stResp.Body.Close()
	if len(stPayload.Sessions) != 1 || !stPayload.Sessions[0].Connected {
		t.Fatalf("expected 1 connected native LapRF session, got %+v", stPayload.Sessions)
	}

	// 5. Public internet IP blocked by SSRF guard
	badResp, err := http.Post(ts.URL+"/api/laprf/connect", "application/json", bytes.NewBufferString(`{"host":"8.8.8.8","port":5403}`))
	if err != nil {
		t.Fatalf("POST /api/laprf/connect 8.8.8.8 err: %v", err)
	}
	badResp.Body.Close()
	if badResp.StatusCode == http.StatusOK {
		t.Fatalf("expected SSRF block for 8.8.8.8")
	}
}

func TestStaticBrowserModeVsNativeServerModeWasmIsolation(t *testing.T) {
	site := fstest.MapFS{
		"index.html":       &fstest.MapFile{Data: []byte("<html>slaprf-spa</html>")},
		"dist/app.js":      &fstest.MapFile{Data: []byte("console.log('ui');")},
		"wasm/slaprf.wasm": &fstest.MapFile{Data: []byte{0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00}},
	}

	// 1. Native Go Server Mode: /api/capabilities returns 200, while /wasm/slaprf.wasm returns 404.
	srv := portable.NewServer(portable.Config{
		Version:  "v2.5.0-server",
		StaticFS: site,
	})
	defer srv.Close()
	nativeTS := httptest.NewServer(srv.Handler())
	defer nativeTS.Close()

	capResp, err := http.Get(nativeTS.URL + "/api/capabilities")
	if err != nil || capResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on /api/capabilities in Server Mode, err=%v", err)
	}
	capResp.Body.Close()

	wasmBlockedResp, err := http.Get(nativeTS.URL + "/wasm/slaprf.wasm")
	if err != nil {
		t.Fatalf("GET /wasm/slaprf.wasm in Server Mode: %v", err)
	}
	wasmBlockedResp.Body.Close()
	if wasmBlockedResp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for /wasm/slaprf.wasm in Server Mode, got %d", wasmBlockedResp.StatusCode)
	}

	// 2. Pure Browser Mode (-browser): /api/capabilities returns 404, while /wasm/slaprf.wasm returns 200 application/wasm.
	browserTS := httptest.NewServer(portable.NewStaticBrowserHandler(site))
	defer browserTS.Close()

	noCapResp, err := http.Get(browserTS.URL + "/api/capabilities")
	if err != nil {
		t.Fatalf("GET /api/capabilities in Pure Browser Mode: %v", err)
	}
	noCapResp.Body.Close()
	if noCapResp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for /api/capabilities in Pure Browser Mode, got %d", noCapResp.StatusCode)
	}

	wasmOKResp, err := http.Get(browserTS.URL + "/wasm/slaprf.wasm")
	if err != nil {
		t.Fatalf("GET /wasm/slaprf.wasm in Pure Browser Mode: %v", err)
	}
	wasmOKResp.Body.Close()
	if wasmOKResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for /wasm/slaprf.wasm in Pure Browser Mode, got %d", wasmOKResp.StatusCode)
	}
	if ct := wasmOKResp.Header.Get("Content-Type"); !strings.Contains(ct, "application/wasm") {
		t.Fatalf("expected Content-Type application/wasm, got %q", ct)
	}
}

func TestRotorHazardUSBManagerEndToEnd(t *testing.T) {
	simNode := rotorhazard.NewSimSerialNode(rotorhazard.SimSerialNodeConfig{
		SeatCount: 8,
		APILevel:  36,
		FwVersion: "FPVGateC5 1.2",
		ProcType:  "ESP32-C5",
	})

	srv := portable.NewServer(portable.Config{
		Version: "v2.5.0-test",
		DBPath:  filepath.Join(t.TempDir(), "slaprf.db"),
		StaticFS: fstest.MapFS{
			"index.html": &fstest.MapFile{Data: []byte("<html>slaprf</html>")},
		},
		USBListPorts: func() ([]usb.PortInfo, error) {
			return []usb.PortInfo{{
				Name:        "COM42",
				IsUSB:       true,
				VID:         "303A",
				PID:         "1001",
				Product:     "FPVGateC5 RotorHazard USB",
				IsEspressif: true,
			}}, nil
		},
		USBOpenPort: func(portName string, baud int) (firmware.SerialPort, error) {
			hp, dp := rotorhazard.NewInMemorySerialPair()
			go func() { _ = simNode.Serve(dp) }()
			return hp, nil
		},
	})
	defer srv.Close()

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// Switch to Real Hardware mode and select RotorHazard (USB)
	postReq := func(path string, body any) *http.Response {
		b, _ := json.Marshal(body)
		req, _ := http.NewRequest(http.MethodPost, ts.URL+path, bytes.NewReader(b))
		req.Header.Set("Origin", ts.URL)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("POST %s: %v", path, err)
		}
		return resp
	}

	r1 := postReq("/api/sim/toggle", map[string]any{"running": false})
	r1.Body.Close()

	r2 := postReq("/api/hardware/mode", map[string]any{"mode": "rotorhazard_usb"})
	r2.Body.Close()

	// Connect COM42 as RotorHazard USB device
	connResp := postReq("/api/rh/connect", map[string]any{
		"transport": "usb",
		"portName":  "COM42",
		"label":     "R1",
	})
	defer connResp.Body.Close()
	if connResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on /api/rh/connect USB, got %d", connResp.StatusCode)
	}
	var connPayload struct {
		Session portable.RHDiagSnapshot `json:"session"`
	}
	if err := json.NewDecoder(connResp.Body).Decode(&connPayload); err != nil {
		t.Fatalf("decode /api/rh/connect: %v", err)
	}
	if connPayload.Session.Transport != "usb" || !connPayload.Session.Connected || connPayload.Session.APILevel != 36 || connPayload.Session.NodeCount != 8 {
		t.Fatalf("unexpected RH USB session snapshot: %+v", connPayload.Session)
	}

	// Open a Practice session so pilot channels tune onto the USB node, then verify seat 0 frequency
	r3 := postReq("/api/practice/start", map[string]any{"name": "USB Practice"})
	r3.Body.Close()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		f0, _, _ := simNode.SeatConfig(0)
		if f0 > 5000 && f0 < 6000 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	f0, _, _ := simNode.SeatConfig(0)
	if f0 < 5000 || f0 > 6000 {
		t.Fatalf("expected Seat 0 tuned to active 5.8 GHz pilot frequency, got %d MHz", f0)
	}
}

func TestServerBasicAuthenticationAndStorageWipe(t *testing.T) {
	srv := portable.NewServer(portable.Config{
		Version: "v2.5.0-auth",
		DBPath:  filepath.Join(t.TempDir(), "slaprf.db"),
		StaticFS: fstest.MapFS{
			"index.html": &fstest.MapFile{Data: []byte("<html>slaprf</html>")},
		},
	})
	defer srv.Close()

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// 1. Default: auth disabled, /api/capabilities reports authRequired=false, /api/state returns 200.
	capResp, err := http.Get(ts.URL + "/api/capabilities")
	if err != nil || capResp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/capabilities failed: %v", err)
	}
	var caps portable.CapabilitiesResponse
	_ = json.NewDecoder(capResp.Body).Decode(&caps)
	capResp.Body.Close()
	if caps.AuthRequired || !caps.Authenticated {
		t.Fatalf("expected default AuthRequired=false, Authenticated=true, got %+v", caps)
	}

	stResp, err := http.Get(ts.URL + "/api/state")
	if err != nil || stResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on /api/state when auth disabled, got %v err=%v", stResp, err)
	}
	stResp.Body.Close()

	// 2. Enable Basic Auth via POST /api/auth/config
	cfgBody, _ := json.Marshal(map[string]any{
		"enabled":  true,
		"username": "admin",
		"password": "secret-password",
	})
	cfgResp, err := http.Post(ts.URL+"/api/auth/config", "application/json", bytes.NewReader(cfgBody))
	if err != nil || cfgResp.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/auth/config failed: status=%v err=%v", cfgResp, err)
	}
	cfgResp.Body.Close()

	// 3. Unauthenticated /api/capabilities reports authRequired=true, authenticated=false
	capResp2, err := http.Get(ts.URL + "/api/capabilities")
	if err != nil || capResp2.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/capabilities after enabling auth failed: %v", err)
	}
	var caps2 portable.CapabilitiesResponse
	_ = json.NewDecoder(capResp2.Body).Decode(&caps2)
	capResp2.Body.Close()
	if !caps2.AuthRequired || caps2.Authenticated {
		t.Fatalf("expected AuthRequired=true, Authenticated=false when unauthenticated, got %+v", caps2)
	}

	// 4. Unauthenticated /api/state is blocked at server level with 401
	unauthResp, err := http.Get(ts.URL + "/api/state")
	if err != nil {
		t.Fatalf("GET /api/state unauthenticated err: %v", err)
	}
	unauthResp.Body.Close()
	if unauthResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 on unauthenticated /api/state, got %d", unauthResp.StatusCode)
	}

	// 5. Wrong credentials to POST /api/auth/login return 401
	badLogin, _ := json.Marshal(map[string]any{"username": "admin", "password": "wrong"})
	badLoginResp, err := http.Post(ts.URL+"/api/auth/login", "application/json", bytes.NewReader(badLogin))
	if err != nil {
		t.Fatalf("POST /api/auth/login bad err: %v", err)
	}
	badLoginResp.Body.Close()
	if badLoginResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for bad login, got %d", badLoginResp.StatusCode)
	}

	// 6. Valid credentials to POST /api/auth/login return 200
	goodLogin, _ := json.Marshal(map[string]any{"username": "admin", "password": "secret-password"})
	goodLoginResp, err := http.Post(ts.URL+"/api/auth/login", "application/json", bytes.NewReader(goodLogin))
	if err != nil {
		t.Fatalf("POST /api/auth/login good err: %v", err)
	}
	goodLoginResp.Body.Close()
	if goodLoginResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for valid login, got %d", goodLoginResp.StatusCode)
	}

	// 7. Authenticated request with Basic Auth header succeeds on /api/state
	authReq, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/state", nil)
	authReq.SetBasicAuth("admin", "secret-password")
	authStResp, err := http.DefaultClient.Do(authReq)
	if err != nil {
		t.Fatalf("authenticated GET /api/state err: %v", err)
	}
	authStResp.Body.Close()
	if authStResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for Basic Auth GET /api/state, got %d", authStResp.StatusCode)
	}

	// 8. Wipe application data resets Basic Auth back to disabled
	resetReq, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/storage/reset", bytes.NewBufferString(`{}`))
	resetReq.SetBasicAuth("admin", "secret-password")
	resetResp, err := http.DefaultClient.Do(resetReq)
	if err != nil || resetResp.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/storage/reset failed: %v", err)
	}
	resetResp.Body.Close()

	stAfterWipe, err := http.Get(ts.URL + "/api/state")
	if err != nil || stAfterWipe.StatusCode != http.StatusOK {
		t.Fatalf("expected unauthenticated /api/state to return 200 after storage wipe, got %v err=%v", stAfterWipe, err)
	}
	stAfterWipe.Body.Close()

	// 9. Re-enable auth on a persistent DB, then restart with DisableAuth: true (-no-auth) to recover access
	dbFile := filepath.Join(t.TempDir(), "recover.db")
	srvLocked := portable.NewServer(portable.Config{
		Version: "v2.5.0-auth",
		DBPath:  dbFile,
	})
	tsLocked := httptest.NewServer(srvLocked.Handler())
	cfgResp2, err := http.Post(tsLocked.URL+"/api/auth/config", "application/json", bytes.NewReader(cfgBody))
	if err != nil || cfgResp2.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/auth/config on persistent DB failed: %v", err)
	}
	cfgResp2.Body.Close()
	tsLocked.Close()
	srvLocked.Close()

	srvRecovered := portable.NewServer(portable.Config{
		Version:     "v2.5.0-auth",
		DBPath:      dbFile,
		DisableAuth: true,
	})
	defer srvRecovered.Close()
	tsRecovered := httptest.NewServer(srvRecovered.Handler())
	defer tsRecovered.Close()

	recResp, err := http.Get(tsRecovered.URL + "/api/state")
	if err != nil || recResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on /api/state after DisableAuth (-no-auth) startup, got %v err=%v", recResp, err)
	}
	recResp.Body.Close()
}
