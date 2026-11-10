//go:build js && wasm

package main

import (
	"net"
	"sync"
	"syscall/js"

	"slaprf/internal/laprf"
)

// liveTimeBridge connects the in-WASM LapRF emulator to MultiGP LiveTime through the
// slaprf-relay WebSocket (web/src/services/livetime_relay.ts). The relay copies LiveTime's TCP
// :5403 bytes 1:1; here each LiveTime connection becomes a net.Pipe served by laprf.ServeConn.
//
// JS API (on window.slaprfWasm):
//
//	onLiveTimeOut(cb: ((chunk: Uint8Array) => void) | null)  // bytes for LiveTime
//	liveTimeOpen()                                            // LiveTime connected: new session
//	liveTimeData(chunk: Uint8Array)                           // bytes from LiveTime
//	liveTimeClose()                                           // LiveTime disconnected
type liveTimeBridge struct {
	srv *laprf.Server

	mu   sync.Mutex
	out  js.Value
	sess *liveTimeSession
}

type liveTimeSession struct {
	client net.Conn
	inbox  chan []byte
	once   sync.Once
	closed chan struct{}
}

func (s *liveTimeSession) close() {
	s.once.Do(func() {
		close(s.closed)
		_ = s.client.Close()
	})
}

// maxLiveTimeInbox bounds bytes queued from JS before the LapRF session reads them.
const maxLiveTimeInbox = 256

func registerLiveTimeAPI(apiObj js.Value, srv *laprf.Server) {
	b := &liveTimeBridge{srv: srv, out: js.Undefined()}

	apiObj.Set("onLiveTimeOut", js.FuncOf(func(_ js.Value, args []js.Value) any {
		b.mu.Lock()
		if len(args) > 0 && args[0].Type() == js.TypeFunction {
			b.out = args[0]
		} else {
			b.out = js.Undefined()
		}
		b.mu.Unlock()
		return nil
	}))

	apiObj.Set("liveTimeOpen", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		b.open()
		return nil
	}))

	apiObj.Set("liveTimeData", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) == 0 || args[0].IsUndefined() || args[0].IsNull() {
			return false
		}
		n := args[0].Get("byteLength").Int()
		if n <= 0 {
			return false
		}
		buf := make([]byte, n)
		js.CopyBytesToGo(buf, args[0])
		return b.data(buf)
	}))

	apiObj.Set("liveTimeClose", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		b.closeCurrent()
		return nil
	}))
}

// open starts a fresh LapRF session (replacing any previous one).
func (b *liveTimeBridge) open() {
	serverSide, clientSide := net.Pipe()
	b.mu.Lock()
	if b.sess != nil {
		b.sess.close()
	}
	sess := &liveTimeSession{
		client: clientSide,
		inbox:  make(chan []byte, maxLiveTimeInbox),
		closed: make(chan struct{}),
	}
	b.sess = sess
	b.mu.Unlock()

	go b.srv.ServeConn(serverSide)

	// Writer: JS callbacks must never block, so LiveTime bytes are queued and written here.
	go func() {
		for {
			select {
			case <-sess.closed:
				return
			case chunk := <-sess.inbox:
				if _, err := sess.client.Write(chunk); err != nil {
					sess.close()
					return
				}
			}
		}
	}()

	// Reader: everything the emulator writes (replies, 10 Hz STATUS, detections) goes to JS.
	go func() {
		defer sess.close()
		buf := make([]byte, 4096)
		for {
			n, err := sess.client.Read(buf)
			if n > 0 {
				b.mu.Lock()
				cb := b.out
				current := b.sess == sess
				b.mu.Unlock()
				if current && cb.Type() == js.TypeFunction {
					u8 := js.Global().Get("Uint8Array").New(n)
					js.CopyBytesToJS(u8, buf[:n])
					cb.Invoke(u8)
				}
			}
			if err != nil {
				return
			}
		}
	}()
}

// data queues bytes from LiveTime for the current session. Returns false when no session is
// open or the queue is full (the bytes are dropped).
func (b *liveTimeBridge) data(chunk []byte) bool {
	b.mu.Lock()
	sess := b.sess
	b.mu.Unlock()
	if sess == nil {
		return false
	}
	select {
	case <-sess.closed:
		return false
	case sess.inbox <- chunk:
		return true
	default:
		return false
	}
}

func (b *liveTimeBridge) closeCurrent() {
	b.mu.Lock()
	sess := b.sess
	b.sess = nil
	b.mu.Unlock()
	if sess != nil {
		sess.close()
	}
}
