package portable

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"slaprf/internal/applog"
	"slaprf/internal/storage"
)

// LogsResponse is returned by `GET /v1/logs`.
type LogsResponse struct {
	LogPath   string   `json:"logPath"`
	SizeBytes int64    `json:"sizeBytes"`
	Level     string   `json:"level"`
	Levels    []string `json:"levels"`
	LineCount int      `json:"lineCount"`
	Lines     []string `json:"lines"`
}

func (s *Server) handleLogsGet(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
	if format == "text" || format == "raw" {
		raw := s.appLog.ReadFullText()
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Disposition", `attachment; filename="slaprf.log"`)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(raw)
		return
	}

	tail := 200
	if rawTail := strings.TrimSpace(r.URL.Query().Get("tail")); rawTail != "" {
		if n, err := strconv.Atoi(rawTail); err == nil && n > 0 {
			if n > applog.DefaultRingLines {
				n = applog.DefaultRingLines
			}
			tail = n
		}
	}
	st := s.appLog.Status()
	lines := s.appLog.Tail(tail)
	if lines == nil {
		lines = []string{}
	}
	writeJSONNoStore(w, http.StatusOK, LogsResponse{
		LogPath:   st.LogPath,
		SizeBytes: st.SizeBytes,
		Level:     st.Level,
		Levels:    st.Levels,
		LineCount: st.LineCount,
		Lines:     lines,
	})
}

func (s *Server) handleLogsConfig(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method == http.MethodGet {
		writeJSONNoStore(w, http.StatusOK, s.appLog.Status())
		return
	}
	if r.Method != http.MethodPut {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	bodyBytes, err := io.ReadAll(io.LimitReader(r.Body, 4096))
	if err != nil {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "failed to read request body"})
		return
	}
	var payload struct {
		Level   string `json:"level"`
		Verbose *bool  `json:"verbose,omitempty"`
	}
	if err := json.Unmarshal(bodyBytes, &payload); err != nil {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON request body"})
		return
	}

	var lvl applog.Level
	var ok bool
	if strings.TrimSpace(payload.Level) != "" {
		lvl, ok = applog.ParseLevel(payload.Level)
		if !ok {
			writeJSONNoStore(w, http.StatusBadRequest, map[string]any{
				"error": "invalid log level: must be one of trace, debug, info, warn, error",
			})
			return
		}
	} else if payload.Verbose != nil {
		if *payload.Verbose {
			lvl = applog.LevelDebug
		} else {
			lvl = applog.LevelInfo
		}
	} else {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{
			"error": "missing level field (trace, debug, info, warn, error)",
		})
		return
	}

	prevLvl := s.appLog.Level()
	s.appLog.SetLevel(lvl)
	if prevLvl != lvl {
		s.appLog.Infof("[Logs] Log severity level changed from %s to %s", prevLvl.String(), lvl.String())
	}
	if s.store != nil {
		_ = s.store.PutJSON(storage.KeyLogLevel, lvl.String())
	}
	writeJSONNoStore(w, http.StatusOK, s.appLog.Status())
}

func (s *Server) handleLogsClear(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_ = s.appLog.Clear()
	writeJSONNoStore(w, http.StatusOK, s.appLog.Status())
}
