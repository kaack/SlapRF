package portable

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
)

const boltKeyAuthConfig = "auth.config"

// AuthConfig stores the server-level Basic Authentication configuration in bbolt (slaprf.db).
type AuthConfig struct {
	Enabled        bool   `json:"enabled"`
	Username       string `json:"username"`
	Password       string `json:"password,omitempty"`
	PasswordSHA256 string `json:"passwordSha256,omitempty"`
}

func hashPasswordSHA256(pw string) string {
	sum := sha256.Sum256([]byte(pw))
	return hex.EncodeToString(sum[:])
}

func constantTimeEqualStr(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func (s *Server) loadPersistedAuthConfig() {
	if s.store == nil {
		return
	}
	var cfg AuthConfig
	if ok, err := s.store.GetJSON(boltKeyAuthConfig, &cfg); err == nil && ok {
		s.authMu.Lock()
		s.authCfg = cfg
		s.authMu.Unlock()
	}
}

func (s *Server) resetAuthConfig() {
	s.authMu.Lock()
	s.authCfg = AuthConfig{}
	s.authMu.Unlock()
	if s.store != nil {
		_ = s.store.PutJSON(boltKeyAuthConfig, AuthConfig{})
	}
}

func (s *Server) isAuthEnabled() bool {
	s.authMu.RLock()
	defer s.authMu.RUnlock()
	return s.authCfg.Enabled && s.authCfg.Username != "" && s.authCfg.PasswordSHA256 != ""
}

func (s *Server) verifyCredentials(username, password string) bool {
	s.authMu.RLock()
	cfg := s.authCfg
	s.authMu.RUnlock()

	if !cfg.Enabled || cfg.Username == "" || cfg.PasswordSHA256 == "" {
		return true
	}
	userOK := constantTimeEqualStr(strings.TrimSpace(username), cfg.Username)
	passOK := constantTimeEqualStr(hashPasswordSHA256(password), cfg.PasswordSHA256)
	return userOK && passOK
}

func (s *Server) isRequestAuthenticated(r *http.Request) bool {
	if !s.isAuthEnabled() {
		return true
	}
	if user, pass, ok := r.BasicAuth(); ok {
		return s.verifyCredentials(user, pass)
	}
	if qToken := strings.TrimSpace(r.URL.Query().Get("slaprf_auth")); qToken != "" {
		raw, err := base64.StdEncoding.DecodeString(qToken)
		if err != nil {
			raw, err = base64.RawStdEncoding.DecodeString(qToken)
		}
		if err == nil {
			if idx := strings.IndexByte(string(raw), ':'); idx >= 0 {
				user := string(raw[:idx])
				pass := string(raw[idx+1:])
				return s.verifyCredentials(user, pass)
			}
		}
	}
	return false
}

func (s *Server) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	user := strings.TrimSpace(body.Username)
	pass := body.Password
	if user == "" && pass == "" {
		if bUser, bPass, ok := r.BasicAuth(); ok {
			user = strings.TrimSpace(bUser)
			pass = bPass
		}
	}

	if !s.verifyCredentials(user, pass) {
		writeJSONNoStore(w, http.StatusUnauthorized, map[string]any{
			"ok":    false,
			"error": "Invalid username or password.",
		})
		return
	}

	s.authMu.RLock()
	cfg := s.authCfg
	s.authMu.RUnlock()

	w.Header().Set("Location", "/v1/auth/sessions/current")
	writeJSONNoStore(w, http.StatusCreated, map[string]any{
		"ok":       true,
		"enabled":  cfg.Enabled,
		"username": cfg.Username,
	})
}

func (s *Server) handleAuthConfig(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}

	switch r.Method {
	case http.MethodGet:
		s.authMu.RLock()
		cfg := s.authCfg
		s.authMu.RUnlock()
		writeJSONNoStore(w, http.StatusOK, map[string]any{
			"enabled":     cfg.Enabled,
			"username":    cfg.Username,
			"password":    cfg.Password,
			"hasPassword": cfg.PasswordSHA256 != "",
		})

	case http.MethodPut:
		var req struct {
			Enabled  bool   `json:"enabled"`
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		cleanUser := strings.TrimSpace(req.Username)
		cleanPass := req.Password

		s.authMu.Lock()
		next := s.authCfg
		next.Enabled = req.Enabled
		if cleanUser != "" || !req.Enabled {
			next.Username = cleanUser
		}
		if cleanPass != "" {
			next.Password = cleanPass
			next.PasswordSHA256 = hashPasswordSHA256(cleanPass)
		}
		if next.Enabled && (next.Username == "" || next.PasswordSHA256 == "") {
			s.authMu.Unlock()
			writeJSONNoStore(w, http.StatusBadRequest, map[string]any{
				"ok":    false,
				"error": "Username and password are required to enable authentication.",
			})
			return
		}
		s.authCfg = next
		s.authMu.Unlock()

		if s.store != nil {
			_ = s.store.PutJSON(boltKeyAuthConfig, next)
		}

		writeJSONNoStore(w, http.StatusOK, map[string]any{
			"ok":          true,
			"enabled":     next.Enabled,
			"username":    next.Username,
			"password":    next.Password,
			"hasPassword": next.PasswordSHA256 != "",
		})

	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
