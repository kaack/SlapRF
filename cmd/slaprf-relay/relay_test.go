package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"

	"slaprf/internal/domain"
	"slaprf/internal/laprf"
	"slaprf/internal/tracker"
)

type testRelay struct {
	ltAddr string
	wsURL  string
	stop   func()
}

func startRelay(t *testing.T, extraOrigins ...string) *testRelay {
	t.Helper()
	ltLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	wsLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := &Relay{Version: "test", Origins: NewOriginPolicy(extraOrigins)}
	done := make(chan error, 1)
	go func() { done <- r.Serve(ctx, ltLn, wsLn) }()
	stop := func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("Serve returned %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Errorf("relay did not shut down")
		}
	}
	t.Cleanup(stop)
	return &testRelay{ltAddr: ltLn.Addr().String(), wsURL: "ws://" + wsLn.Addr().String() + "/", stop: stop}
}

type wsMsg struct {
	typ  websocket.MessageType
	data []byte
	err  error
}

type testBrowser struct {
	t    *testing.T
	ws   *websocket.Conn
	msgs chan wsMsg
}

func dialBrowser(t *testing.T, url, origin string) (*testBrowser, *http.Response, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	h := http.Header{}
	if origin != "" {
		h.Set("Origin", origin)
	}
	ws, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: h})
	if err != nil {
		return nil, resp, err
	}
	b := &testBrowser{t: t, ws: ws, msgs: make(chan wsMsg, 64)}
	go func() {
		for {
			typ, data, err := ws.Read(context.Background())
			b.msgs <- wsMsg{typ, data, err}
			if err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() { _ = ws.CloseNow() })
	return b, resp, nil
}

func (b *testBrowser) next() wsMsg {
	b.t.Helper()
	select {
	case m := <-b.msgs:
		return m
	case <-time.After(3 * time.Second):
		b.t.Fatalf("timed out waiting for a WebSocket message")
		return wsMsg{}
	}
}

func (b *testBrowser) expectEvent(want controlEvent) controlEvent {
	b.t.Helper()
	m := b.next()
	if m.err != nil {
		b.t.Fatalf("read error waiting for %+v: %v", want, m.err)
	}
	if m.typ != websocket.MessageText {
		b.t.Fatalf("expected text control event %+v, got binary %x", want, m.data)
	}
	var ev controlEvent
	if err := json.Unmarshal(m.data, &ev); err != nil {
		b.t.Fatalf("bad control event %q: %v", m.data, err)
	}
	if ev.T != want.T || ev.State != want.State || (want.Version != "" && ev.Version != want.Version) {
		b.t.Fatalf("got event %+v, want %+v", ev, want)
	}
	return ev
}

func (b *testBrowser) expectBinary(want []byte) {
	b.t.Helper()
	var got []byte
	for len(got) < len(want) {
		m := b.next()
		if m.err != nil || m.typ != websocket.MessageBinary {
			b.t.Fatalf("expected binary, got type=%v data=%q err=%v", m.typ, m.data, m.err)
		}
		got = append(got, m.data...)
	}
	if !bytes.Equal(got, want) {
		b.t.Fatalf("binary mismatch: got %x want %x", got, want)
	}
}

func (b *testBrowser) send(p []byte) {
	b.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := b.ws.Write(ctx, websocket.MessageBinary, p); err != nil {
		b.t.Fatalf("ws write: %v", err)
	}
}

func dialLiveTime(t *testing.T, addr string) net.Conn {
	t.Helper()
	c, err := net.DialTimeout("tcp", addr, 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func readN(t *testing.T, c net.Conn, n int) []byte {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, n)
	if _, err := io.ReadFull(c, buf); err != nil {
		t.Fatalf("tcp read: %v", err)
	}
	return buf
}

func TestRelayBytesAndControlEvents(t *testing.T) {
	r := startRelay(t)
	b, _, err := dialBrowser(t, r.wsURL, "https://slaprf.app")
	if err != nil {
		t.Fatal(err)
	}
	b.expectEvent(controlEvent{T: "hello", Version: "test"})
	b.expectEvent(controlEvent{T: "livetime", State: "disconnected"})

	lt := dialLiveTime(t, r.ltAddr)
	ev := b.expectEvent(controlEvent{T: "livetime", State: "connected"})
	if ev.Peer != lt.LocalAddr().String() {
		t.Fatalf("peer = %q, want %q", ev.Peer, lt.LocalAddr())
	}

	// LiveTime -> browser, including LapRF framing bytes, unmodified.
	up := []byte{0x5A, 0x01, 0x5C, 0x7B, 0x00, 0xFF, 0x5B}
	if _, err := lt.Write(up); err != nil {
		t.Fatal(err)
	}
	b.expectBinary(up)

	// Browser -> LiveTime.
	down := []byte{0x5A, 0x10, 0x20, 0x5B}
	b.send(down)
	if got := readN(t, lt, len(down)); !bytes.Equal(got, down) {
		t.Fatalf("tcp got %x want %x", got, down)
	}

	_ = lt.Close()
	b.expectEvent(controlEvent{T: "livetime", State: "disconnected"})
}

func TestRelayOriginCheck(t *testing.T) {
	r := startRelay(t, "https://timing.example.org", "http://192.168.1.20:*")
	for _, origin := range []string{"https://evil.example", "null", "http://slaprf.app", "https://slaprf.app.evil.example", "http://192.168.1.21:8090"} {
		_, resp, err := dialBrowser(t, r.wsURL, origin)
		if err == nil {
			t.Fatalf("origin %q was accepted", origin)
		}
		if resp == nil || resp.StatusCode != http.StatusForbidden {
			t.Fatalf("origin %q: expected 403, got resp=%v err=%v", origin, resp, err)
		}
	}
	for _, origin := range []string{"https://slaprf.app", "http://localhost:8090", "http://127.0.0.1:8090", "https://localhost", "https://timing.example.org", "http://192.168.1.20:3000", ""} {
		b, _, err := dialBrowser(t, r.wsURL, origin)
		if err != nil {
			t.Fatalf("origin %q rejected: %v", origin, err)
		}
		b.expectEvent(controlEvent{T: "hello"})
		_ = b.ws.Close(websocket.StatusNormalClosure, "")
	}
}

func TestOriginPolicy(t *testing.T) {
	p := NewOriginPolicy([]string{"HTTPS://Race.Example.org/", "http://10.0.0.5:*"})
	cases := map[string]bool{
		"https://slaprf.app":        true,
		"https://slaprf.app:443":    false, // browsers never send the default port
		"http://localhost:5173":     true,
		"http://[::1]:8090":         true,
		"https://race.example.org":  true,
		"http://10.0.0.5:1234":      true,
		"https://10.0.0.5:1234":     false,
		"https://slaprf.app/path":   false,
		"ftp://localhost":           false,
		"null":                      false,
		"https://evil.slaprf.app":   false,
		"https://localhost.evil.io": false,
	}
	for origin, want := range cases {
		if got := p.Allowed(origin); got != want {
			t.Errorf("Allowed(%q) = %v, want %v", origin, got, want)
		}
	}
}

func TestRelayBrowserReplacement(t *testing.T) {
	r := startRelay(t)
	lt := dialLiveTime(t, r.ltAddr)

	b1, _, err := dialBrowser(t, r.wsURL, "http://localhost:8090")
	if err != nil {
		t.Fatal(err)
	}
	b1.expectEvent(controlEvent{T: "hello"})
	b1.expectEvent(controlEvent{T: "livetime", State: "connected"})

	b2, _, err := dialBrowser(t, r.wsURL, "https://slaprf.app")
	if err != nil {
		t.Fatal(err)
	}
	b2.expectEvent(controlEvent{T: "hello"})
	b2.expectEvent(controlEvent{T: "livetime", State: "connected"})

	m := b1.next()
	if websocket.CloseStatus(m.err) != closeReplaced {
		t.Fatalf("old browser: expected close %d, got %+v", closeReplaced, m)
	}

	payload := []byte("to-new-tab")
	if _, err := lt.Write(payload); err != nil {
		t.Fatal(err)
	}
	b2.expectBinary(payload)
}

func TestRelayLiveTimeReplacement(t *testing.T) {
	r := startRelay(t)
	b, _, err := dialBrowser(t, r.wsURL, "https://slaprf.app")
	if err != nil {
		t.Fatal(err)
	}
	b.expectEvent(controlEvent{T: "hello"})
	b.expectEvent(controlEvent{T: "livetime", State: "disconnected"})

	lt1 := dialLiveTime(t, r.ltAddr)
	b.expectEvent(controlEvent{T: "livetime", State: "connected"})
	lt2 := dialLiveTime(t, r.ltAddr)
	ev := b.expectEvent(controlEvent{T: "livetime", State: "connected"})
	if ev.Peer != lt2.LocalAddr().String() {
		t.Fatalf("expected new peer %s, got %s", lt2.LocalAddr(), ev.Peer)
	}

	// The old connection is closed by the relay.
	_ = lt1.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := lt1.Read(make([]byte, 1)); err == nil {
		t.Fatalf("old LiveTime connection still open")
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatalf("old LiveTime connection not closed")
	}

	// Bytes flow to/from the new client only, and no spurious "disconnected" was sent.
	b.send([]byte("hi"))
	if got := readN(t, lt2, 2); string(got) != "hi" {
		t.Fatalf("got %q", got)
	}
	if _, err := lt2.Write([]byte("yo")); err != nil {
		t.Fatal(err)
	}
	b.expectBinary([]byte("yo"))
}

func TestRelayLiveTimeBeforeBrowser(t *testing.T) {
	r := startRelay(t)
	lt := dialLiveTime(t, r.ltAddr)
	if _, err := lt.Write([]byte("dropped")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond) // let the relay read (and drop) it

	b, _, err := dialBrowser(t, r.wsURL, "https://slaprf.app")
	if err != nil {
		t.Fatal(err)
	}
	b.expectEvent(controlEvent{T: "hello"})
	ev := b.expectEvent(controlEvent{T: "livetime", State: "connected"})
	if ev.Peer == "" {
		t.Fatalf("missing peer")
	}
	if _, err := lt.Write([]byte("kept")); err != nil {
		t.Fatal(err)
	}
	b.expectBinary([]byte("kept")) // "dropped" was not buffered
}

func TestRelayPlainGET(t *testing.T) {
	r := startRelay(t)
	resp, err := http.Get("http" + r.wsURL[2:])
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !bytes.Contains(body, []byte("slaprf-relay")) {
		t.Fatalf("unexpected GET response %d %q", resp.StatusCode, body)
	}
}

// TestRelayWithLapRFEmulator runs the real LapRF emulator behind the relay, bridged exactly
// like the browser does it (WebSocket <-> net.Pipe <-> laprf.Server.ServeConn), and drives it
// from a fake LiveTime over TCP.
func TestRelayWithLapRFEmulator(t *testing.T) {
	r := startRelay(t)
	eng := tracker.NewRealEngine()
	srv := laprf.NewServer(eng)

	// --- fake browser tab: mirrors web/src/services/livetime_relay.ts + cmd/slaprf-wasm/livetime.go
	b, _, err := dialBrowser(t, r.wsURL, "https://slaprf.app")
	if err != nil {
		t.Fatal(err)
	}
	b.expectEvent(controlEvent{T: "hello"})
	b.expectEvent(controlEvent{T: "livetime", State: "disconnected"})

	lt := dialLiveTime(t, r.ltAddr)
	b.expectEvent(controlEvent{T: "livetime", State: "connected"})

	serverSide, clientSide := net.Pipe()
	defer clientSide.Close()
	go srv.ServeConn(serverSide)
	go func() { // emulator -> WebSocket
		buf := make([]byte, 4096)
		for {
			n, err := clientSide.Read(buf)
			if n > 0 {
				_ = b.ws.Write(context.Background(), websocket.MessageBinary, append([]byte(nil), buf[:n]...))
			}
			if err != nil {
				return
			}
		}
	}()
	go func() { // WebSocket -> emulator
		for m := range b.msgs {
			if m.err != nil {
				return
			}
			if m.typ == websocket.MessageBinary {
				if _, err := clientSide.Write(m.data); err != nil {
					return
				}
			}
		}
	}()

	// --- fake LiveTime over TCP
	frames := make(chan *laprf.Packet, 256)
	go func() {
		buf := make([]byte, 4096)
		var frame []byte
		in := false
		for {
			n, err := lt.Read(buf)
			for _, c := range buf[:n] {
				if c == laprf.ByteSOR {
					in, frame = true, append(frame[:0], c)
				} else if in {
					frame = append(frame, c)
					if c == laprf.ByteEOR {
						in = false
						if p, err := laprf.DecodeFrame(frame); err == nil {
							frames <- p
						}
					}
				}
			}
			if err != nil {
				close(frames)
				return
			}
		}
	}()
	waitFor := func(rt laprf.RecordType) *laprf.Packet {
		t.Helper()
		deadline := time.After(3 * time.Second)
		for {
			select {
			case p, ok := <-frames:
				if !ok {
					t.Fatalf("LiveTime connection closed")
				}
				if p.Type == rt {
					return p
				}
			case <-deadline:
				t.Fatalf("timed out waiting for 0x%04X", uint16(rt))
			}
		}
	}

	rf := &laprf.Packet{Type: laprf.RecordRFSetup}
	rf.AppendUint8(0x01, 1)
	rf.AppendUint16(0x20, 1)
	rf.AppendUint16(0x21, 7) // R7
	rf.AppendUint16(0x22, uint16(domain.BandRaceband))
	rf.AppendUint16(0x25, 5880)
	if _, err := lt.Write(rf.Encode()); err != nil {
		t.Fatal(err)
	}
	reply := waitFor(laprf.RecordRFSetup)
	var freq1 uint16
	slot := 0
	for _, f := range reply.Fields {
		if f.Signature == 0x01 {
			slot = int(f.Data[0])
		}
		if f.Signature == 0x25 && slot == 1 {
			freq1 = binary.LittleEndian.Uint16(f.Data)
		}
	}
	if freq1 != 5880 {
		t.Fatalf("RF setup reply slot 1 freq = %d, want 5880", freq1)
	}

	if _, err := lt.Write((&laprf.Packet{Type: laprf.RecordTime}).Encode()); err != nil {
		t.Fatal(err)
	}
	tr := waitFor(laprf.RecordTime)
	if len(tr.Fields) == 0 || len(tr.Fields[0].Data) != 8 {
		t.Fatalf("bad time reply %+v", tr)
	}
	waitFor(laprf.RecordStatus) // 10 Hz heartbeat reaches LiveTime through the relay
}
