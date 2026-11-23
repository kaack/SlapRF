package portable

import (
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var defaultTrustedWebOrigins = map[string]bool{
	"https://slaprf.app":       true,
	"https://www.slaprf.app":   true,
	"https://kaack.github.io":  true,
}

func (s *Server) isAllowedOrigin(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	norm := strings.TrimRight(strings.ToLower(origin), "/")
	if defaultTrustedWebOrigins[norm] {
		return true
	}
	for _, extra := range s.cfg.AllowedOrigins {
		clean := strings.TrimRight(strings.ToLower(strings.TrimSpace(extra)), "/")
		if clean == "*" || (clean != "" && clean == norm) {
			return true
		}
	}

	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if strings.EqualFold(u.Host, r.Host) {
		return true
	}
	origHost := u.Hostname()
	if isLoopbackHost(origHost) {
		return true
	}
	if s.cfg.AllowLANOrigins {
		if ip := net.ParseIP(origHost); ip != nil && (ip.IsPrivate() || ip.IsLinkLocalUnicast()) {
			return true
		}
		if strings.HasSuffix(strings.ToLower(origHost), ".local") {
			return true
		}
	}
	return false
}

func isVersionedAPIPath(p string) bool {
	return p == "/v1" || strings.HasPrefix(p, "/v1/")
}

type httpStatusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *httpStatusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *httpStatusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (s *Server) withCORSAndPNA(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		if origin != "" {
			if !s.isAllowedOrigin(r) {
				if isVersionedAPIPath(r.URL.Path) {
					http.Error(w, "forbidden origin", http.StatusForbidden)
					return
				}
			} else {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")
				w.Header().Set("Access-Control-Expose-Headers", "Location")
				if strings.EqualFold(r.Header.Get("Access-Control-Request-Private-Network"), "true") {
					w.Header().Set("Access-Control-Allow-Private-Network", "true")
				}
			}
		}

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if isVersionedAPIPath(r.URL.Path) &&
			r.URL.Path != "/v1/capabilities" &&
			r.URL.Path != "/v1/auth/sessions" {
			if !s.isRequestAuthenticated(r) {
				writeJSONNoStore(w, http.StatusUnauthorized, map[string]any{
					"error": "authentication required",
				})
				return
			}
		}

		isWS := strings.HasPrefix(r.URL.Path, "/v1/ws/") || strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
		if isVersionedAPIPath(r.URL.Path) && !isWS {
			start := time.Now()
			rec := &httpStatusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r)
			dur := time.Since(start).Round(100 * time.Microsecond)
			httpTag := "[HTTP]"
			if s.isSimScopedHTTPPath(r.URL.Path) {
				httpTag = "[SIM][HTTP]"
			}
			switch {
			case rec.status >= 500:
				s.appLog.Errorf("%s %s %s -> %d (%s)", httpTag, r.Method, r.URL.Path, rec.status, dur)
			case rec.status >= 400:
				s.appLog.Warnf("%s %s %s -> %d (%s)", httpTag, r.Method, r.URL.Path, rec.status, dur)
			case r.Method != http.MethodGet && r.Method != http.MethodHead:
				s.appLog.Debugf("%s %s %s -> %d (%s)", httpTag, r.Method, r.URL.Path, rec.status, dur)
			}
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) isSimScopedHTTPPath(path string) bool {
	if strings.HasPrefix(path, "/v1/sim") || strings.HasPrefix(path, "/v1/storage/sim") {
		return true
	}
	if strings.HasPrefix(path, "/v1/slaprf/") ||
		strings.HasPrefix(path, "/v1/laprf/") ||
		strings.HasPrefix(path, "/v1/rotorhazard/") ||
		strings.HasPrefix(path, "/v1/logs") ||
		strings.HasPrefix(path, "/v1/auth/") ||
		path == "/v1/storage" ||
		path == "/v1/storage/status" ||
		path == "/v1/storage:recordBackup" ||
		path == "/v1/capabilities" ||
		path == "/v1/version" {
		return false
	}
	return s.sim != nil && s.sim.IsRunning()
}
