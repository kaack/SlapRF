//go:build !js

package rotorhazard

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type httpPollSession struct {
	mu      sync.Mutex
	sid     string
	queue   []string
	ws      *websocket.Conn
	upgraded bool
}

func newRandomSID() string {
	var b [10]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// HTTPHandler exposes a real Engine.IO v4 / Socket.IO v4 `/socket.io/` HTTP Polling + WebSocket
// endpoint for `SimServer`, reproducing `python-engineio`'s exact CORS preflight headers and
// `AdminAuth.py`'s polling-to-WebSocket HTTP Basic Auth session caching.
func (s *SimServer) HTTPHandler() http.Handler {
	var mu sync.Mutex
	sessions := make(map[string]*httpPollSession)

	enqueue := func(ps *httpPollSession, sioPkt string) {
		ps.mu.Lock()
		ws := ps.ws
		upgraded := ps.upgraded
		if !upgraded || ws == nil {
			ps.queue = append(ps.queue, sioPkt)
			ps.mu.Unlock()
			return
		}
		ps.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_ = ws.Write(ctx, websocket.MessageText, []byte(sioPkt))
		cancel()
	}

	writeCORS := func(w http.ResponseWriter, r *http.Request) {
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		if origin == "" {
			w.Header().Set("Access-Control-Allow-Origin", "*")
		} else {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Methods", "OPTIONS, GET, POST")
		if reqHdrs := strings.TrimSpace(r.Header.Get("Access-Control-Request-Headers")); reqHdrs != "" {
			w.Header().Set("Access-Control-Allow-Headers", reqHdrs)
		} else {
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/socket.io/", func(w http.ResponseWriter, r *http.Request) {
		writeCORS(w, r)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		q := r.URL.Query()
		transport := strings.ToLower(strings.TrimSpace(q.Get("transport")))
		sid := strings.TrimSpace(q.Get("sid"))
		user, pass, hasBasic := r.BasicAuth()

		if transport == "websocket" {
			var ps *httpPollSession
			if sid != "" {
				mu.Lock()
				ps = sessions[sid]
				mu.Unlock()
			}
			ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
			if err != nil {
				return
			}
			defer func() { _ = ws.CloseNow() }()

			directConnect := false
			if ps == nil {
				directConnect = true
				sid = newRandomSID()
				ps = &httpPollSession{sid: sid}
				mu.Lock()
				sessions[sid] = ps
				mu.Unlock()
				s.AttachSession(sid, user, pass, func(pkt string) {
					enqueue(ps, pkt)
				})
				openBytes, _ := json.Marshal(EIOOpenPayload{
					SID:          sid,
					Upgrades:     []string{},
					PingInterval: 25000,
					PingTimeout:  20000,
					MaxPayload:   1000000,
				})
				ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
				_ = ws.Write(ctx, websocket.MessageText, append([]byte{EIOPacketOpen}, openBytes...))
				cancel()
				ps.mu.Lock()
				ps.ws = ws
				ps.upgraded = true
				ps.mu.Unlock()
			} else if hasBasic {
				s.UpgradeSessionAuth(sid, user, pass)
			}

			defer func() {
				mu.Lock()
				delete(sessions, sid)
				mu.Unlock()
				s.DetachSession(sid)
			}()

			for {
				typ, data, rErr := ws.Read(r.Context())
				if rErr != nil {
					return
				}
				if typ != websocket.MessageText || len(data) == 0 {
					continue
				}
				msg := string(data)
				switch msg[0] {
				case EIOPacketPing:
					// EIO probe (`2probe` -> `3probe`) or regular ping (`2` -> `3`)
					pong := string(EIOPacketPong) + msg[1:]
					wCtx, wCancel := context.WithTimeout(r.Context(), 3*time.Second)
					_ = ws.Write(wCtx, websocket.MessageText, []byte(pong))
					wCancel()
				case EIOPacketUpgrade:
					// `5` upgrade complete: flush any queued packets over WS
					ps.mu.Lock()
					ps.ws = ws
					ps.upgraded = true
					queued := append([]string(nil), ps.queue...)
					ps.queue = nil
					ps.mu.Unlock()
					for _, qPkt := range queued {
						wCtx, wCancel := context.WithTimeout(r.Context(), 3*time.Second)
						_ = ws.Write(wCtx, websocket.MessageText, []byte(qPkt))
						wCancel()
					}
				case EIOPacketMessage:
					if len(msg) >= 2 && msg[1] == SIOPacketConnect {
						ackBytes, _ := json.Marshal(map[string]string{"sid": sid})
						wCtx, wCancel := context.WithTimeout(r.Context(), 3*time.Second)
						_ = ws.Write(wCtx, websocket.MessageText, append([]byte("40"), ackBytes...))
						wCancel()
					} else if len(msg) >= 2 && msg[1] == SIOPacketEvent {
						s.HandleClientFrame(sid, msg)
					}
				case EIOPacketClose:
					_ = directConnect
					return
				}
			}
		}

		// HTTP Long-Polling transport (`transport=polling`)
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")

		if sid == "" && r.Method == http.MethodGet {
			sid = newRandomSID()
			ps := &httpPollSession{sid: sid}
			mu.Lock()
			sessions[sid] = ps
			mu.Unlock()
			s.AttachSession(sid, user, pass, func(pkt string) {
				enqueue(ps, pkt)
			})
			openBytes, _ := json.Marshal(EIOOpenPayload{
				SID:          sid,
				Upgrades:     []string{"websocket"},
				PingInterval: 25000,
				PingTimeout:  20000,
				MaxPayload:   1000000,
			})
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(append([]byte{EIOPacketOpen}, openBytes...))
			return
		}

		mu.Lock()
		ps := sessions[sid]
		mu.Unlock()
		if ps == nil {
			http.Error(w, "unknown sid", http.StatusBadRequest)
			return
		}
		if hasBasic {
			s.UpgradeSessionAuth(sid, user, pass)
		}

		switch r.Method {
		case http.MethodPost:
			bodyBytes, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
			for _, pkt := range SplitEIOPayload(string(bodyBytes)) {
				if len(pkt) == 0 {
					continue
				}
				switch pkt[0] {
				case EIOPacketPing:
					enqueue(ps, string(EIOPacketPong)+pkt[1:])
				case EIOPacketMessage:
					if len(pkt) >= 2 && pkt[1] == SIOPacketConnect {
						ackBytes, _ := json.Marshal(map[string]string{"sid": sid})
						enqueue(ps, "40"+string(ackBytes))
					} else if len(pkt) >= 2 && pkt[1] == SIOPacketEvent {
						s.HandleClientFrame(sid, pkt)
					}
				case EIOPacketClose:
					mu.Lock()
					delete(sessions, sid)
					mu.Unlock()
					s.DetachSession(sid)
				}
			}
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, "ok")

		case http.MethodGet:
			ps.mu.Lock()
			queued := append([]string(nil), ps.queue...)
			ps.queue = nil
			upgraded := ps.upgraded
			ps.mu.Unlock()
			if len(queued) == 0 {
				if upgraded {
					w.WriteHeader(http.StatusOK)
					_, _ = io.WriteString(w, string(EIOPacketNoop))
					return
				}
				w.WriteHeader(http.StatusOK)
				_, _ = io.WriteString(w, string(EIOPacketNoop))
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, JoinEIOPayload(queued...))

		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
	return mux
}
