package portable

import (
	"net"
	"net/http"
	"net/url"
	"strings"
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
		next.ServeHTTP(w, r)
	})
}
