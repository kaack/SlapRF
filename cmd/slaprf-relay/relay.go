package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// Close codes sent to the browser WebSocket (4000-4999 is the application range).
const (
	closeReplaced websocket.StatusCode = 4001 // a newer browser tab attached to the relay
)

const (
	wsWriteTimeout  = 5 * time.Second
	tcpWriteTimeout = 5 * time.Second
	wsPingInterval  = 20 * time.Second
	wsReadLimit     = 1 << 20
)

// Relay copies bytes between one LiveTime TCP client and one browser WebSocket client.
//
// It has no knowledge of the LapRF protocol: binary WebSocket messages are written to the TCP
// socket unchanged and every TCP read is sent as one binary WebSocket message. Text messages
// are small JSON control events from relay to browser (see controlEvent).
//
// Connection rules:
//   - One browser and one LiveTime client at a time; a new connection replaces (closes) the old.
//   - LiveTime may connect while no browser is attached: the TCP connection is kept open, the
//     browser is told about it as soon as it attaches, and LiveTime->browser bytes received in
//     the meantime are dropped (nothing is buffered; LiveTime re-sends its setup requests and
//     the emulator streams fresh 10 Hz status once the browser is there).
//   - Browser->LiveTime bytes while no LiveTime client is connected are dropped too.
type Relay struct {
	Version string
	Origins *OriginPolicy
	Log     *log.Logger

	// evMu serializes LiveTime state changes with the control events describing them, so the
	// browser always sees hello -> current state -> later changes, in order.
	evMu sync.Mutex

	mu      sync.Mutex
	browser *browserConn
	lt      *liveTimeConn
	baseCtx context.Context

	ltToBrowser atomic.Uint64
	browserToLT atomic.Uint64
	dropped     atomic.Uint64
}

type browserConn struct {
	ws     *websocket.Conn
	label  string
	ctx    context.Context
	cancel context.CancelFunc
}

type liveTimeConn struct {
	conn net.Conn
	peer string
}

// controlEvent is a TEXT WebSocket message from relay to browser.
type controlEvent struct {
	T       string `json:"t"`                 // "hello" | "livetime"
	Version string `json:"version,omitempty"` // hello: relay version
	State   string `json:"state,omitempty"`   // livetime: "connected" | "disconnected"
	Peer    string `json:"peer,omitempty"`    // livetime connected: LiveTime's ip:port
}

func (b *browserConn) sendJSON(ev controlEvent) error {
	data, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(b.ctx, wsWriteTimeout)
	defer cancel()
	return b.ws.Write(ctx, websocket.MessageText, data)
}

func (b *browserConn) sendBinary(p []byte) error {
	ctx, cancel := context.WithTimeout(b.ctx, wsWriteTimeout)
	defer cancel()
	return b.ws.Write(ctx, websocket.MessageBinary, p)
}

func liveTimeEvent(lt *liveTimeConn) controlEvent {
	if lt == nil {
		return controlEvent{T: "livetime", State: "disconnected"}
	}
	return controlEvent{T: "livetime", State: "connected", Peer: lt.peer}
}

func (r *Relay) logf(format string, args ...any) {
	if r.Log != nil {
		r.Log.Printf(format, args...)
	}
}

// Serve runs the relay on the given listeners until ctx is cancelled, then closes everything.
func (r *Relay) Serve(ctx context.Context, liveTimeLn, wsLn net.Listener) error {
	if r.Origins == nil {
		r.Origins = NewOriginPolicy(nil)
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	r.mu.Lock()
	r.baseCtx = ctx
	r.mu.Unlock()

	httpSrv := &http.Server{
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}

	var wg sync.WaitGroup
	errCh := make(chan error, 2)
	wg.Add(3)
	go func() {
		defer wg.Done()
		if err := httpSrv.Serve(wsLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- fmt.Errorf("websocket server: %w", err)
		}
	}()
	go func() {
		defer wg.Done()
		if err := r.acceptLiveTime(ctx, liveTimeLn); err != nil {
			errCh <- fmt.Errorf("livetime listener: %w", err)
		}
	}()
	go func() {
		defer wg.Done()
		r.statsLoop(ctx, 30*time.Second)
	}()

	var err error
	select {
	case <-ctx.Done():
	case err = <-errCh:
	}
	cancel()

	_ = liveTimeLn.Close()
	shutdownCtx, stop := context.WithTimeout(context.Background(), 2*time.Second)
	_ = httpSrv.Shutdown(shutdownCtx)
	stop()

	r.mu.Lock()
	b, lt := r.browser, r.lt
	r.browser, r.lt = nil, nil
	r.mu.Unlock()
	if b != nil {
		_ = b.ws.Close(websocket.StatusGoingAway, "relay shutting down")
	}
	if lt != nil {
		_ = lt.conn.Close()
	}
	wg.Wait()
	return err
}

// ServeHTTP handles the browser side: a WebSocket upgrade on "/" from an allowed origin.
// Plain GET requests (someone opening the URL in a tab) get a one-line status text.
func (r *Relay) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	if req.URL.Path != "/" {
		http.NotFound(w, req)
		return
	}
	origin := req.Header.Get("Origin")
	if !r.Origins.Allowed(origin) {
		r.logf("Rejected browser connection from origin %q (not allowed; see -allow-origin)", origin)
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	if !strings.EqualFold(req.Header.Get("Upgrade"), "websocket") {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintf(w, "slaprf-relay %s is running. Open https://slaprf.app and enable LiveTime.\n", r.Version)
		return
	}

	// Origin was verified above with scheme-aware rules, so skip the library's host-only check.
	ws, err := websocket.Accept(w, req, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		r.logf("WebSocket upgrade failed: %v", err)
		return
	}
	ws.SetReadLimit(wsReadLimit)

	label := origin
	if label == "" {
		label = "a non-browser client (" + req.RemoteAddr + ")"
	}
	ctx, cancel := context.WithCancel(req.Context())
	b := &browserConn{ws: ws, label: label, ctx: ctx, cancel: cancel}
	defer cancel()

	if !r.attachBrowser(b) {
		_ = ws.CloseNow()
		return
	}
	go r.pingLoop(b)
	r.browserReadLoop(b)

	r.mu.Lock()
	current := r.browser == b
	if current {
		r.browser = nil
	}
	r.mu.Unlock()
	if current {
		r.logf("Browser disconnected (%s)", b.label)
	}
	_ = ws.CloseNow()
}

func (r *Relay) attachBrowser(b *browserConn) bool {
	r.evMu.Lock()
	defer r.evMu.Unlock()

	r.mu.Lock()
	old := r.browser
	lt := r.lt
	r.browser = nil // no data to anyone until the new browser has its initial state
	r.mu.Unlock()
	if old != nil {
		r.logf("Replacing previous browser connection (%s)", old.label)
		go func() { _ = old.ws.Close(closeReplaced, "replaced by a newer SlapRF tab") }()
	}

	if err := b.sendJSON(controlEvent{T: "hello", Version: r.Version}); err != nil {
		return false
	}
	if err := b.sendJSON(liveTimeEvent(lt)); err != nil {
		return false
	}
	r.mu.Lock()
	r.browser = b
	r.mu.Unlock()
	r.logf("Browser connected from %s", b.label)
	return true
}

func (r *Relay) browserReadLoop(b *browserConn) {
	for {
		typ, data, err := b.ws.Read(b.ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageBinary || len(data) == 0 {
			continue // text messages from the browser are reserved; ignore
		}
		r.mu.Lock()
		lt := r.lt
		current := r.browser == b
		r.mu.Unlock()
		if !current {
			return
		}
		if lt == nil {
			r.dropped.Add(uint64(len(data)))
			continue
		}
		_ = lt.conn.SetWriteDeadline(time.Now().Add(tcpWriteTimeout))
		if _, err := lt.conn.Write(data); err != nil {
			r.logf("Write to LiveTime failed: %v", err)
			_ = lt.conn.Close()
			continue
		}
		r.browserToLT.Add(uint64(len(data)))
	}
}

func (r *Relay) pingLoop(b *browserConn) {
	t := time.NewTicker(wsPingInterval)
	defer t.Stop()
	for {
		select {
		case <-b.ctx.Done():
			return
		case <-t.C:
			ctx, cancel := context.WithTimeout(b.ctx, wsWriteTimeout)
			err := b.ws.Ping(ctx)
			cancel()
			if err != nil {
				b.cancel()
				return
			}
		}
	}
}

func (r *Relay) acceptLiveTime(ctx context.Context, ln net.Listener) error {
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				continue
			}
			return err
		}
		lt := &liveTimeConn{conn: conn, peer: conn.RemoteAddr().String()}
		r.attachLiveTime(lt)
		go r.liveTimeReadLoop(lt)
	}
}

func (r *Relay) attachLiveTime(lt *liveTimeConn) {
	r.evMu.Lock()
	defer r.evMu.Unlock()
	r.mu.Lock()
	old := r.lt
	r.lt = lt
	b := r.browser
	r.mu.Unlock()
	if old != nil {
		r.logf("Replacing previous LiveTime connection (%s)", old.peer)
		_ = old.conn.Close()
	}
	if b != nil {
		r.logf("LiveTime connected from %s", lt.peer)
		_ = b.sendJSON(liveTimeEvent(lt))
	} else {
		r.logf("LiveTime connected from %s (no browser attached yet: open SlapRF and enable LiveTime)", lt.peer)
	}
}

func (r *Relay) liveTimeReadLoop(lt *liveTimeConn) {
	buf := make([]byte, 32*1024)
	for {
		n, err := lt.conn.Read(buf)
		if n > 0 {
			r.mu.Lock()
			b := r.browser
			current := r.lt == lt
			r.mu.Unlock()
			if !current {
				break
			}
			if b == nil {
				r.dropped.Add(uint64(n))
			} else if werr := b.sendBinary(buf[:n]); werr != nil {
				r.dropped.Add(uint64(n))
			} else {
				r.ltToBrowser.Add(uint64(n))
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
				r.logf("LiveTime read error: %v", err)
			}
			break
		}
	}
	_ = lt.conn.Close()

	r.evMu.Lock()
	defer r.evMu.Unlock()
	r.mu.Lock()
	current := r.lt == lt
	if current {
		r.lt = nil
	}
	b := r.browser
	r.mu.Unlock()
	if current {
		r.logf("LiveTime disconnected (%s)", lt.peer)
		if b != nil {
			_ = b.sendJSON(liveTimeEvent(nil))
		}
	}
}

// statsLoop logs byte counts at most once per interval, and only when something moved.
func (r *Relay) statsLoop(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	var lastIn, lastOut, lastDrop uint64
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			in, out, drop := r.ltToBrowser.Load(), r.browserToLT.Load(), r.dropped.Load()
			if in == lastIn && out == lastOut && drop == lastDrop {
				continue
			}
			msg := fmt.Sprintf("Relayed in the last %s: LiveTime -> browser %d B, browser -> LiveTime %d B",
				every, in-lastIn, out-lastOut)
			if drop != lastDrop {
				msg += fmt.Sprintf(", dropped %d B (other side not connected)", drop-lastDrop)
			}
			r.logf("%s", msg)
			lastIn, lastOut, lastDrop = in, out, drop
		}
	}
}

// OriginPolicy decides which browser origins may open the relay WebSocket.
//
// Defaults: https://slaprf.app, and http(s)://localhost, 127.0.0.1 or [::1] on any port (dev
// server, self-hosted builds). Requests without an Origin header (non-browser tools) are allowed:
// web pages cannot omit it, and such tools could reach LiveTime's port directly anyway.
// Extra entries are exact origins ("https://timing.example.org") or "scheme://host:*" for any port.
type OriginPolicy struct {
	exact    map[string]bool
	anyPort  map[string]bool // "scheme://host"
	loopback bool
}

// NewOriginPolicy returns the default policy extended with extra origins.
func NewOriginPolicy(extra []string) *OriginPolicy {
	p := &OriginPolicy{
		exact:    map[string]bool{"https://slaprf.app": true},
		anyPort:  map[string]bool{},
		loopback: true,
	}
	for _, e := range extra {
		e = strings.TrimRight(strings.ToLower(strings.TrimSpace(e)), "/")
		if e == "" {
			continue
		}
		if strings.HasSuffix(e, ":*") {
			p.anyPort[strings.TrimSuffix(e, ":*")] = true
		} else {
			p.exact[e] = true
		}
	}
	return p
}

// Allowed reports whether a WebSocket upgrade with this Origin header value may proceed.
func (p *OriginPolicy) Allowed(origin string) bool {
	if origin == "" {
		return true
	}
	u, err := url.Parse(strings.ToLower(origin))
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return false // includes "null" (sandboxed iframes, file://)
	}
	if (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.User != nil {
		return false
	}
	norm := u.Scheme + "://" + u.Host
	if p.exact[norm] || p.anyPort[u.Scheme+"://"+u.Hostname()] {
		return true
	}
	if p.loopback {
		switch u.Hostname() {
		case "localhost", "127.0.0.1", "::1":
			return true
		}
	}
	return false
}
