package portable_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"

	"slaprf/internal/api"
	"slaprf/internal/firmware"
	"slaprf/internal/laprf"
	"slaprf/internal/portable"
	"slaprf/internal/rotorhazard"
	"slaprf/internal/serialport"
	"slaprf/internal/tracker"
)

func doJSONReq(t *testing.T, method string, fullURL string, origin string, body any) *http.Response {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal %s %s: %v", method, fullURL, err)
		}
		buf.Write(b)
	}
	req, err := http.NewRequest(method, fullURL, &buf)
	if err != nil {
		t.Fatalf("new request %s %s: %v", method, fullURL, err)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, fullURL, err)
	}
	return resp
}

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
	resp := doJSONReq(t, http.MethodGet, ts.URL+"/v1/capabilities", ts.URL, nil)
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
	preReq, _ := http.NewRequest(http.MethodOptions, ts.URL+"/v1/capabilities", nil)
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
	badResp := doJSONReq(t, http.MethodGet, ts.URL+"/v1/capabilities", "https://evil.example.com", nil)
	badResp.Body.Close()
	if badResp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for untrusted origin, got %d", badResp.StatusCode)
	}

	// 4. Unsupported method on /v1/capabilities returns 405 Method Not Allowed (never index.html)
	methodResp := doJSONReq(t, http.MethodPost, ts.URL+"/v1/capabilities", ts.URL, map[string]any{})
	methodResp.Body.Close()
	if methodResp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 for POST /v1/capabilities, got %d", methodResp.StatusCode)
	}

	// 5. Unknown /v1/nonexistent path returns 404 Not Found (never index.html)
	missingResp := doJSONReq(t, http.MethodGet, ts.URL+"/v1/nonexistent", ts.URL, nil)
	missingResp.Body.Close()
	if missingResp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for GET /v1/nonexistent, got %d", missingResp.StatusCode)
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
	resp, err := http.Post(ts.URL+"/v1/race/multigp/proxy/race/assignSlot?id=99&cycle=1&heat=2&slot=3", "application/json", body)
	if err != nil {
		t.Fatalf("POST /v1/race/multigp/proxy failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if seenPath != "/mgp/multigpwebservice/race/assignSlot" || seenQuery != "id=99&cycle=1&heat=2&slot=3" || seenAPIKey != "MGP-TEST-KEY" {
		t.Fatalf("unexpected upstream forwarding: path=%q query=%q key=%q", seenPath, seenQuery, seenAPIKey)
	}

	travResp, err := http.Post(ts.URL+"/v1/race/multigp/proxy/race/../../admin", "application/json", bytes.NewBufferString(`{}`))
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

	wsURL := "ws" + strings.TrimPrefix(ts1.URL, "http") + "/v1/ws/stream"
	ws, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial /v1/ws/stream: %v", err)
	}

	// Enable Simulation mode + plug virtual H1 USB on the Go server and add Pilot in Sim mode
	modeResp := doJSONReq(t, http.MethodPatch, ts1.URL+"/v1/sim", "", map[string]any{"running": true})
	if modeResp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH /v1/sim failed: %d", modeResp.StatusCode)
	}
	modeResp.Body.Close()

	hubResp := doJSONReq(t, http.MethodPut, ts1.URL+"/v1/sim/slaprf/hub-usb", "", map[string]any{"connected": true})
	if hubResp.StatusCode != http.StatusOK {
		t.Fatalf("PUT /v1/sim/slaprf/hub-usb failed: %d", hubResp.StatusCode)
	}
	hubResp.Body.Close()

	addResp := doJSONReq(t, http.MethodPost, ts1.URL+"/v1/pilots", "", map[string]any{
		"callsign":     "BOLT_PILOT",
		"phoneticName": "Bolt Pilot",
	})
	if addResp.StatusCode != http.StatusCreated {
		t.Fatalf("POST /v1/pilots expected 201 Created, got %d", addResp.StatusCode)
	}
	addResp.Body.Close()

	// Expect binary telemetry batch (version byte 0x01) over /v1/ws/stream from native Go simulator
	sawBinaryTelemetry := false
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		rCtx, rCancel := context.WithTimeout(ctx, 1*time.Second)
		typ, data, rErr := ws.Read(rCtx)
		rCancel()
		if rErr != nil {
			t.Fatalf("read /v1/ws/stream: %v", rErr)
		}
		if typ == websocket.MessageBinary && len(data) > 4 && data[0] == 1 {
			sawBinaryTelemetry = true
			break
		}
	}
	if !sawBinaryTelemetry {
		t.Fatalf("expected binary telemetry batch from native Go simulator over /v1/ws/stream")
	}

	_ = ws.CloseNow()
	ts1.Close()
	srv1.Close()

	// Boot a brand-new server instance against the same single-file slaprf.db
	srv2 := portable.NewServer(portable.Config{
		Version: "test",
		DBPath:  dbFile,
	})
	defer srv2.Close()
	ts2 := httptest.NewServer(srv2.Handler())
	defer ts2.Close()

	stResp, err := http.Get(ts2.URL + "/v1/state")
	if err != nil {
		t.Fatalf("GET /v1/state on restarted server: %v", err)
	}
	defer stResp.Body.Close()
	var rawState map[string]any
	if err := json.NewDecoder(stResp.Body).Decode(&rawState); err != nil {
		t.Fatalf("decode /v1/state: %v", err)
	}
	if simRun, _ := rawState["simulatorRunning"].(bool); !simRun {
		t.Fatalf("expected simulatorRunning=true hydrated from bbolt, got %v", rawState["simulatorRunning"])
	}
	rawJSON, _ := json.Marshal(rawState)
	if !strings.Contains(string(rawJSON), "BOLT_PILOT") {
		t.Fatalf("expected BOLT_PILOT hydrated from bbolt across server restart")
	}
}

func TestNativeLapRFEmulatorListenerAndLapRFClientConnect(t *testing.T) {
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

	// 2. Enable native Go LapRF emulator TCP listener via PUT /v1/laprf-emulator
	emulResp := doJSONReq(t, http.MethodPut, ts.URL+"/v1/laprf-emulator", "", map[string]any{
		"enabled": true,
		"port":    0,
		"bind":    "loopback",
	})
	if emulResp.StatusCode != http.StatusOK {
		t.Fatalf("PUT /v1/laprf-emulator failed: %d", emulResp.StatusCode)
	}
	var emulSnap portable.LapRFEmulatorSnapshot
	_ = json.NewDecoder(emulResp.Body).Decode(&emulSnap)
	emulResp.Body.Close()
	if emulSnap.RelayState != "connected" || emulSnap.ListenAddr == "" {
		t.Fatalf("expected native LapRF emulator listener connected, got %+v", emulSnap)
	}

	emulConn, err := net.Dial("tcp", emulSnap.ListenAddr)
	if err != nil {
		t.Fatalf("dial native LapRF emulator listener %s: %v", emulSnap.ListenAddr, err)
	}
	defer emulConn.Close()
	reqFrame := (&laprf.Packet{Type: laprf.RecordTime}).Encode()
	_, _ = emulConn.Write(reqFrame)
	buf := make([]byte, 256)
	_ = emulConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, err := emulConn.Read(buf)
	if err != nil || n == 0 {
		t.Fatalf("expected LapRF frame from native LapRF emulator server, err=%v", err)
	}

	// 3. Discover mock LapRF 8-Way puck via GET /v1/laprf/network/devices
	discResp, err := http.Get(ts.URL + "/v1/laprf/network/devices?hosts=127.0.0.1&port=" + strconv.Itoa(puckPort))
	if err != nil {
		t.Fatalf("GET /v1/laprf/network/devices: %v", err)
	}
	var discPayload struct {
		Devices []portable.DiscoveredLapRFDevice `json:"devices"`
	}
	_ = json.NewDecoder(discResp.Body).Decode(&discPayload)
	discResp.Body.Close()
	if len(discPayload.Devices) != 1 || !discPayload.Devices[0].Verified {
		t.Fatalf("expected 1 verified LapRF device, got %+v", discPayload.Devices)
	}

	// 4. Switch realEngine to LapRF 8-Way mode and connect natively via POST /v1/laprf/connections (201 Created)
	modeResp := doJSONReq(t, http.MethodPut, ts.URL+"/v1/hardware/mode", "", map[string]any{"mode": "laprf"})
	modeResp.Body.Close()

	cResp := doJSONReq(t, http.MethodPost, ts.URL+"/v1/laprf/connections", "", map[string]any{
		"host":  "127.0.0.1",
		"port":  puckPort,
		"label": "Start Puck",
	})
	if cResp.StatusCode != http.StatusCreated {
		t.Fatalf("POST /v1/laprf/connections expected 201 Created, got %d", cResp.StatusCode)
	}
	cResp.Body.Close()

	time.Sleep(250 * time.Millisecond)
	stResp, err := http.Get(ts.URL + "/v1/laprf/connections")
	if err != nil {
		t.Fatalf("GET /v1/laprf/connections: %v", err)
	}
	var stPayload struct {
		Connections []portable.LapRFDiagSnapshot `json:"connections"`
	}
	_ = json.NewDecoder(stResp.Body).Decode(&stPayload)
	stResp.Body.Close()
	if len(stPayload.Connections) != 1 || !stPayload.Connections[0].Connected {
		t.Fatalf("expected 1 connected native LapRF connection, got %+v", stPayload.Connections)
	}

	// 5. Public internet IP blocked by SSRF guard
	badResp := doJSONReq(t, http.MethodPost, ts.URL+"/v1/laprf/connections", "", map[string]any{"host": "8.8.8.8", "port": 5403})
	badResp.Body.Close()
	if badResp.StatusCode == http.StatusCreated || badResp.StatusCode == http.StatusOK {
		t.Fatalf("expected SSRF block for 8.8.8.8")
	}
}

func TestStaticBrowserModeVsNativeServerModeWasmIsolation(t *testing.T) {
	site := fstest.MapFS{
		"index.html":       &fstest.MapFile{Data: []byte("<html>slaprf-spa</html>")},
		"dist/app.js":      &fstest.MapFile{Data: []byte("console.log('ui');")},
		"wasm/slaprf.wasm": &fstest.MapFile{Data: []byte{0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00}},
	}

	// 1. Native Go Server Mode: /v1/capabilities returns 200, while /wasm/slaprf.wasm returns 404.
	srv := portable.NewServer(portable.Config{
		Version:  "v2.5.0-server",
		StaticFS: site,
	})
	defer srv.Close()
	nativeTS := httptest.NewServer(srv.Handler())
	defer nativeTS.Close()

	capResp, err := http.Get(nativeTS.URL + "/v1/capabilities")
	if err != nil || capResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on /v1/capabilities in Server Mode, err=%v", err)
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

	// 2. Pure Browser Mode (-browser): /v1/capabilities returns 404, while /wasm/slaprf.wasm returns 200 application/wasm.
	browserTS := httptest.NewServer(portable.NewStaticBrowserHandler(site))
	defer browserTS.Close()

	noCapResp, err := http.Get(browserTS.URL + "/v1/capabilities")
	if err != nil {
		t.Fatalf("GET /v1/capabilities in Pure Browser Mode: %v", err)
	}
	noCapResp.Body.Close()
	if noCapResp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for /v1/capabilities in Pure Browser Mode, got %d", noCapResp.StatusCode)
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
		USBListPorts: func() ([]serialport.PortInfo, error) {
			return []serialport.PortInfo{{
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

	r1 := doJSONReq(t, http.MethodPatch, ts.URL+"/v1/sim", ts.URL, map[string]any{"running": false})
	r1.Body.Close()

	r2 := doJSONReq(t, http.MethodPut, ts.URL+"/v1/hardware/mode", ts.URL, map[string]any{"mode": "rotorhazard_usb"})
	r2.Body.Close()

	// Connect COM42 as RotorHazard USB device via POST /v1/rotorhazard/connections (201 Created)
	connResp := doJSONReq(t, http.MethodPost, ts.URL+"/v1/rotorhazard/connections", ts.URL, map[string]any{
		"transport": "usb",
		"portName":  "COM42",
		"label":     "R1",
	})
	defer connResp.Body.Close()
	if connResp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201 Created on POST /v1/rotorhazard/connections USB, got %d", connResp.StatusCode)
	}
	var connPayload struct {
		Connection portable.RHDiagSnapshot `json:"connection"`
	}
	if err := json.NewDecoder(connResp.Body).Decode(&connPayload); err != nil {
		t.Fatalf("decode /v1/rotorhazard/connections: %v", err)
	}
	if connPayload.Connection.Transport != "usb" || !connPayload.Connection.Connected || connPayload.Connection.APILevel != 36 || connPayload.Connection.NodeCount != 8 {
		t.Fatalf("unexpected RH USB connection snapshot: %+v", connPayload.Connection)
	}

	// Activate practice session via POST /v1/practice/sessions/current:start so pilot channels tune onto the USB node
	r3 := doJSONReq(t, http.MethodPost, ts.URL+"/v1/practice/sessions/current:start", ts.URL, map[string]any{})
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

	// 1. Default: auth disabled, /v1/capabilities reports authRequired=false, /v1/state returns 200.
	capResp, err := http.Get(ts.URL + "/v1/capabilities")
	if err != nil || capResp.StatusCode != http.StatusOK {
		t.Fatalf("GET /v1/capabilities failed: %v", err)
	}
	var caps portable.CapabilitiesResponse
	_ = json.NewDecoder(capResp.Body).Decode(&caps)
	capResp.Body.Close()
	if caps.AuthRequired || !caps.Authenticated {
		t.Fatalf("expected default AuthRequired=false, Authenticated=true, got %+v", caps)
	}

	stResp, err := http.Get(ts.URL + "/v1/state")
	if err != nil || stResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on /v1/state when auth disabled, got %v err=%v", stResp, err)
	}
	stResp.Body.Close()

	// 2. Enable Basic Auth via PUT /v1/auth/config
	cfgBody := map[string]any{
		"enabled":  true,
		"username": "admin",
		"password": "secret-password",
	}
	cfgResp := doJSONReq(t, http.MethodPut, ts.URL+"/v1/auth/config", "", cfgBody)
	if cfgResp.StatusCode != http.StatusOK {
		t.Fatalf("PUT /v1/auth/config failed: status=%d", cfgResp.StatusCode)
	}
	cfgResp.Body.Close()

	// 3. Unauthenticated /v1/capabilities reports authRequired=true, authenticated=false
	capResp2, err := http.Get(ts.URL + "/v1/capabilities")
	if err != nil || capResp2.StatusCode != http.StatusOK {
		t.Fatalf("GET /v1/capabilities after enabling auth failed: %v", err)
	}
	var caps2 portable.CapabilitiesResponse
	_ = json.NewDecoder(capResp2.Body).Decode(&caps2)
	capResp2.Body.Close()
	if !caps2.AuthRequired || caps2.Authenticated {
		t.Fatalf("expected AuthRequired=true, Authenticated=false when unauthenticated, got %+v", caps2)
	}

	// 4. Unauthenticated /v1/state is blocked at server level with 401
	unauthResp, err := http.Get(ts.URL + "/v1/state")
	if err != nil {
		t.Fatalf("GET /v1/state unauthenticated err: %v", err)
	}
	unauthResp.Body.Close()
	if unauthResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 on unauthenticated /v1/state, got %d", unauthResp.StatusCode)
	}

	// 5. Wrong credentials to POST /v1/auth/sessions return 401
	badLoginResp := doJSONReq(t, http.MethodPost, ts.URL+"/v1/auth/sessions", "", map[string]any{
		"username": "admin",
		"password": "wrong",
	})
	badLoginResp.Body.Close()
	if badLoginResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for bad login, got %d", badLoginResp.StatusCode)
	}

	// 6. Valid credentials to POST /v1/auth/sessions return 201 Created
	goodLoginResp := doJSONReq(t, http.MethodPost, ts.URL+"/v1/auth/sessions", "", map[string]any{
		"username": "admin",
		"password": "secret-password",
	})
	goodLoginResp.Body.Close()
	if goodLoginResp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201 Created for valid login, got %d", goodLoginResp.StatusCode)
	}

	// 7. Authenticated request with Basic Auth header succeeds on /v1/state
	authReq, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/state", nil)
	authReq.SetBasicAuth("admin", "secret-password")
	authStResp, err := http.DefaultClient.Do(authReq)
	if err != nil {
		t.Fatalf("authenticated GET /v1/state err: %v", err)
	}
	authStResp.Body.Close()
	if authStResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for Basic Auth GET /v1/state, got %d", authStResp.StatusCode)
	}

	// 8. Wipe application data via POST /v1/storage:reset resets Basic Auth back to disabled (DELETE /v1/storage is 405)
	delStoreReq, _ := http.NewRequest(http.MethodDelete, ts.URL+"/v1/storage", nil)
	delStoreReq.SetBasicAuth("admin", "secret-password")
	delStoreResp, err := http.DefaultClient.Do(delStoreReq)
	if err != nil || delStoreResp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 on DELETE /v1/storage singleton, got %v err=%v", delStoreResp, err)
	}
	delStoreResp.Body.Close()

	resetReq, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/storage:reset", bytes.NewBufferString(`{}`))
	resetReq.Header.Set("Content-Type", "application/json")
	resetReq.SetBasicAuth("admin", "secret-password")
	resetResp, err := http.DefaultClient.Do(resetReq)
	if err != nil || resetResp.StatusCode != http.StatusOK {
		t.Fatalf("POST /v1/storage:reset failed: %v", err)
	}
	resetResp.Body.Close()

	stAfterWipe, err := http.Get(ts.URL + "/v1/state")
	if err != nil || stAfterWipe.StatusCode != http.StatusOK {
		t.Fatalf("expected unauthenticated /v1/state to return 200 after storage wipe, got %v err=%v", stAfterWipe, err)
	}
	stAfterWipe.Body.Close()

	// 9. Re-enable auth on a persistent DB, then restart with DisableAuth: true (-no-auth) to recover access
	dbFile := filepath.Join(t.TempDir(), "recover.db")
	srvLocked := portable.NewServer(portable.Config{
		Version: "v2.5.0-auth",
		DBPath:  dbFile,
	})
	tsLocked := httptest.NewServer(srvLocked.Handler())
	cfgResp2 := doJSONReq(t, http.MethodPut, tsLocked.URL+"/v1/auth/config", "", cfgBody)
	if cfgResp2.StatusCode != http.StatusOK {
		t.Fatalf("PUT /v1/auth/config on persistent DB failed: %d", cfgResp2.StatusCode)
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

	recResp, err := http.Get(tsRecovered.URL + "/v1/state")
	if err != nil || recResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on /v1/state after DisableAuth (-no-auth) startup, got %v err=%v", recResp, err)
	}
	recResp.Body.Close()
}

type atomicTestSerialPort struct {
	firmware.SerialPort
	lastDTR   bool
	lastRTS   bool
	atomicHit int
}

func (a *atomicTestSerialPort) SetDTRRTS(dtr, rts bool) error {
	a.lastDTR = dtr
	a.lastRTS = rts
	a.atomicHit++
	return nil
}

func TestUSBRawWebSocketBridgeForMobileFlasher(t *testing.T) {
	hostPort, devPort := rotorhazard.NewInMemorySerialPair()
	wrappedPort := &atomicTestSerialPort{SerialPort: hostPort}

	srv := portable.NewServer(portable.Config{
		Version: "v0.0.6-android",
		DBPath:  filepath.Join(t.TempDir(), "slaprf.db"),
		USBListPorts: func() ([]serialport.PortInfo, error) {
			return []serialport.PortInfo{{
				Name:        "/dev/bus/usb/001/003",
				IsUSB:       true,
				VID:         "303A",
				PID:         "1001",
				Product:     "Seeed XIAO ESP32-C5 (USB JTAG/serial)",
				IsEspressif: true,
			}}, nil
		},
		USBOpenPort: func(portName string, baud int) (firmware.SerialPort, error) {
			if portName != "/dev/bus/usb/001/003" {
				t.Fatalf("expected re-enumerated Espressif port /dev/bus/usb/001/003, got %q", portName)
			}
			return wrappedPort, nil
		},
	})
	defer srv.Close()

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/v1/ws/slaprf/usb-raw?port=%2Fdev%2Fbus%2Fusb%2F001%2F002&baud=115200"
	ws, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{ts.URL}},
	})
	if err != nil {
		t.Fatalf("websocket dial /v1/ws/slaprf/usb-raw: %v", err)
	}
	defer func() { _ = ws.CloseNow() }()

	mt, openBytes, err := ws.Read(ctx)
	if err != nil || mt != websocket.MessageText {
		t.Fatalf("read open handshake: mt=%v err=%v", mt, err)
	}
	var openMsg struct {
		Type     string `json:"type"`
		Ok       bool   `json:"ok"`
		PortName string `json:"portName"`
		VID      int    `json:"vid"`
		PID      int    `json:"pid"`
	}
	if err := json.Unmarshal(openBytes, &openMsg); err != nil {
		t.Fatalf("unmarshal openMsg: %v", err)
	}
	if openMsg.Type != "open" || !openMsg.Ok || openMsg.PortName != "/dev/bus/usb/001/003" || openMsg.VID != 0x303A || openMsg.PID != 0x1001 {
		t.Fatalf("unexpected open handshake: %+v", openMsg)
	}

	if err := ws.Write(ctx, websocket.MessageBinary, []byte("\xc0\x00\x08\xc0")); err != nil {
		t.Fatalf("ws write binary: %v", err)
	}
	rxOnDev := make([]byte, 16)
	_ = devPort.SetReadTimeout(time.Second)
	n, err := devPort.Read(rxOnDev)
	if err != nil || string(rxOnDev[:n]) != "\xc0\x00\x08\xc0" {
		t.Fatalf("device did not receive SLIP frame: n=%d err=%v", n, err)
	}

	_, _ = devPort.Write([]byte("\xc0\x01\x08\x00\xc0"))
	mt, rxOnWS, err := ws.Read(ctx)
	if err != nil || mt != websocket.MessageBinary || string(rxOnWS) != "\xc0\x01\x08\x00\xc0" {
		t.Fatalf("ws did not receive SLIP reply: mt=%v data=%x err=%v", mt, rxOnWS, err)
	}

	if err := ws.Write(ctx, websocket.MessageText, []byte(`{"type":"signals","id":7,"dtr":true,"rts":false}`)); err != nil {
		t.Fatalf("ws write signals: %v", err)
	}
	mt, ackBytes, err := ws.Read(ctx)
	if err != nil || mt != websocket.MessageText || !strings.Contains(string(ackBytes), `"id":7`) {
		t.Fatalf("expected ack for id=7, got mt=%v body=%s err=%v", mt, string(ackBytes), err)
	}
	if wrappedPort.atomicHit != 1 || !wrappedPort.lastDTR || wrappedPort.lastRTS {
		t.Fatalf("expected AtomicDTRRTSSetter(true,false) hit once, got hits=%d dtr=%v rts=%v", wrappedPort.atomicHit, wrappedPort.lastDTR, wrappedPort.lastRTS)
	}

	if err := ws.Write(ctx, websocket.MessageText, []byte(`{"type":"close","id":8}`)); err != nil {
		t.Fatalf("ws write close: %v", err)
	}
	mt, closeAck, err := ws.Read(ctx)
	if err != nil || mt != websocket.MessageText || !strings.Contains(string(closeAck), `"id":8`) {
		t.Fatalf("expected close ack id=8, got mt=%v body=%s err=%v", mt, string(closeAck), err)
	}
}

func TestPortableSeparatesUSBAndBluetoothAPIsAndCancelConnect(t *testing.T) {
	var usbListCalls, bleListCalls int
	openStarted := make(chan struct{})
	openBlock := make(chan struct{})
	defer close(openBlock)

	srv := portable.NewServer(portable.Config{
		Version: "v0.0.13-test",
		DBPath:  filepath.Join(t.TempDir(), "slaprf.db"),
		USBListPorts: func() ([]serialport.PortInfo, error) {
			usbListCalls++
			return []serialport.PortInfo{{
				Name:        "/dev/ttyACM0",
				IsUSB:       true,
				VID:         "303A",
				IsEspressif: true,
				Product:     "ESP32-C5",
			}}, nil
		},
		BLEListPorts: func() ([]serialport.PortInfo, error) {
			bleListCalls++
			return []serialport.PortInfo{{
				Name:        "ble:EFE44224",
				IsEspressif: true,
				Product:     "SlapRF H1 (Bluetooth)",
				Transport:   "ble",
			}}, nil
		},
		BLEOpenPort: func(portName string, _ int) (firmware.SerialPort, error) {
			close(openStarted)
			<-openBlock
			return nil, nil
		},
	})
	defer srv.Close()

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// 1. /v1/slaprf/usb/ports only invokes USBListPorts.
	r1 := doJSONReq(t, http.MethodGet, ts.URL+"/v1/slaprf/usb/ports", "", nil)
	defer r1.Body.Close()
	if r1.StatusCode != http.StatusOK || usbListCalls != 1 || bleListCalls != 0 {
		t.Fatalf("/v1/slaprf/usb/ports status=%d usbCalls=%d bleCalls=%d", r1.StatusCode, usbListCalls, bleListCalls)
	}

	// 2. /v1/slaprf/bluetooth/ports only invokes BLEListPorts.
	r2 := doJSONReq(t, http.MethodGet, ts.URL+"/v1/slaprf/bluetooth/ports", "", nil)
	defer r2.Body.Close()
	if r2.StatusCode != http.StatusOK || usbListCalls != 1 || bleListCalls != 1 {
		t.Fatalf("/v1/slaprf/bluetooth/ports status=%d usbCalls=%d bleCalls=%d", r2.StatusCode, usbListCalls, bleListCalls)
	}

	// 3. /v1/rotorhazard/usb/ports serves RotorHazard USB discovery without touching BLE.
	rRH := doJSONReq(t, http.MethodGet, ts.URL+"/v1/rotorhazard/usb/ports", "", nil)
	defer rRH.Body.Close()
	if rRH.StatusCode != http.StatusOK || bleListCalls != 1 {
		t.Fatalf("/v1/rotorhazard/usb/ports status=%d bleCalls=%d", rRH.StatusCode, bleListCalls)
	}

	// 4. Cross-transport connect requests are rejected with 400 Bad Request.
	badUSB := doJSONReq(t, http.MethodPut, ts.URL+"/v1/slaprf/usb/connections/0", "", map[string]any{"portName": "ble:EFE44224"})
	defer badUSB.Body.Close()
	if badUSB.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 when passing ble:* to /v1/slaprf/usb/connections, got %d", badUSB.StatusCode)
	}
	badBLE := doJSONReq(t, http.MethodPut, ts.URL+"/v1/slaprf/bluetooth/connections/0", "", map[string]any{"portName": "/dev/ttyACM0"})
	defer badBLE.Body.Close()
	if badBLE.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 when passing USB port to /v1/slaprf/bluetooth/connections, got %d", badBLE.StatusCode)
	}

	// 5. In-flight /v1/slaprf/bluetooth/connections/0 exposes live Connecting + ConnectStatus and cancels cleanly on DELETE.
	connRespCh := make(chan *http.Response, 1)
	go func() {
		connRespCh <- doJSONReq(t, http.MethodPut, ts.URL+"/v1/slaprf/bluetooth/connections/0", "", map[string]any{"portName": "ble:EFE44224"})
	}()
	<-openStarted

	stResp := doJSONReq(t, http.MethodGet, ts.URL+"/v1/slaprf/bluetooth/connections", "", nil)
	defer stResp.Body.Close()
	var pool struct {
		Slots []struct {
			Connecting    bool   `json:"connecting"`
			ConnectStatus string `json:"connectStatus"`
		} `json:"slots"`
	}
	_ = json.NewDecoder(stResp.Body).Decode(&pool)
	if len(pool.Slots) == 0 || !pool.Slots[0].Connecting || pool.Slots[0].ConnectStatus == "" {
		t.Fatalf("expected Connecting=true + ConnectStatus on /v1/slaprf/bluetooth/connections, got %+v", pool.Slots)
	}

	delResp := doJSONReq(t, http.MethodDelete, ts.URL+"/v1/slaprf/bluetooth/connections/0", "", nil)
	defer delResp.Body.Close()
	if delResp.StatusCode != http.StatusOK {
		t.Fatalf("DELETE /v1/slaprf/bluetooth/connections/0 status=%d", delResp.StatusCode)
	}

	select {
	case cResp := <-connRespCh:
		defer cResp.Body.Close()
		if cResp.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK {cancelled:true} on cancelled connect, got %d", cResp.StatusCode)
		}
		var cBody map[string]any
		_ = json.NewDecoder(cResp.Body).Decode(&cBody)
		if cBody["cancelled"] != true {
			t.Fatalf("expected cancelled=true, got %+v", cBody)
		}
	case <-time.After(1 * time.Second):
		t.Fatalf("PUT /v1/slaprf/bluetooth/connections/0 did not unblock after DELETE cancel")
	}
}

func TestDiagnosticLogsSideBySideAndRuntimeLevels(t *testing.T) {
	dir := t.TempDir()
	dbFile := filepath.Join(dir, "slaprf.db")
	wantLogFile := filepath.Join(dir, "slaprf.log")

	srv := portable.NewServer(portable.Config{
		Version: "v0.0.16-test",
		DBPath:  dbFile,
	})
	ts := httptest.NewServer(srv.Handler())

	if srv.LogPath() != wantLogFile {
		t.Fatalf("LogPath() = %q, want side-by-side %q", srv.LogPath(), wantLogFile)
	}
	if _, err := os.Stat(wantLogFile); err != nil {
		t.Fatalf("expected side-by-side slaprf.log created on startup: %v", err)
	}

	// Default level is info
	getResp, err := http.Get(ts.URL + "/v1/logs?tail=50")
	if err != nil || getResp.StatusCode != http.StatusOK {
		t.Fatalf("GET /v1/logs failed: %v", err)
	}
	var logSnap api.LogsResponse
	_ = json.NewDecoder(getResp.Body).Decode(&logSnap)
	getResp.Body.Close()
	if logSnap.Level != "info" || len(logSnap.Lines) == 0 {
		t.Fatalf("expected initial level=info and startup log lines, got %+v", logSnap)
	}

	// Switch to debug level and trigger a mutating HTTP request
	cfgResp := doJSONReq(t, http.MethodPut, ts.URL+"/v1/logs/config", "", map[string]any{"level": "debug"})
	cfgResp.Body.Close()
	if cfgResp.StatusCode != http.StatusOK {
		t.Fatalf("PUT /v1/logs/config status=%d", cfgResp.StatusCode)
	}

	armResp := doJSONReq(t, http.MethodPut, ts.URL+"/v1/timing/arm", "", map[string]any{"armed": true})
	armResp.Body.Close()
	pracStartSim := doJSONReq(t, http.MethodPost, ts.URL+"/v1/practice/sessions/current:start", "", map[string]any{})
	pracStartSim.Body.Close()
	simConn := doJSONReq(t, http.MethodPut, ts.URL+"/v1/sim/slaprf/hub-usb", "", map[string]any{"connected": true})
	simConn.Body.Close()
	simDisc := doJSONReq(t, http.MethodPut, ts.URL+"/v1/sim/slaprf/hub-usb", "", map[string]any{"connected": false})
	simDisc.Body.Close()

	// Disable simulator and run real-workspace practice actions -> must log WITHOUT [SIM]
	simOffResp := doJSONReq(t, http.MethodPatch, ts.URL+"/v1/sim", "", map[string]any{"running": false})
	simOffResp.Body.Close()
	pracStartReal := doJSONReq(t, http.MethodPost, ts.URL+"/v1/practice/sessions/current:start", "", map[string]any{})
	pracStartReal.Body.Close()
	pracStopReal := doJSONReq(t, http.MethodPost, ts.URL+"/v1/practice/sessions/current:stop", "", map[string]any{})
	pracStopReal.Body.Close()

	txtResp, err := http.Get(ts.URL + "/v1/logs?format=text")
	if err != nil || txtResp.StatusCode != http.StatusOK {
		t.Fatalf("GET /v1/logs?format=text failed: %v", err)
	}
	rawBytes, _ := io.ReadAll(txtResp.Body)
	txtResp.Body.Close()
	rawStr := string(rawBytes)
	for _, want := range []string{
		"[DEBUG] [SIM][HTTP] PUT /v1/timing/arm",
		"[INFO] [SIM][Practice] Session",
		"[INFO] [SIM][Network] Disconnected simulated Hub H1",
		"[INFO] [SIM][Network] Connected simulated Hub H1",
		"[INFO] [Server] Simulation mode DISABLED",
		"[INFO] [Practice] Session",
		"action=stop",
		"[DEBUG] [HTTP] POST /v1/practice/sessions/current:stop",
	} {
		if !strings.Contains(rawStr, want) {
			t.Fatalf("expected %q in slaprf.log download, got:\n%s", want, rawStr)
		}
	}

	ts.Close()
	srv.Close()

	// Verify persisted log level reloads across server restarts
	srv2 := portable.NewServer(portable.Config{
		Version: "v0.0.16-test",
		DBPath:  dbFile,
	})
	defer srv2.Close()
	if got := srv2.AppLog().Level().String(); got != "debug" {
		t.Fatalf("expected persisted log level debug after restart, got %q", got)
	}
}
