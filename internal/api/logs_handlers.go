package api

import (
	"io"
	"net/http"
	"strconv"
	"strings"

	"slaprf/internal/applog"
)

// LogsResponse is returned by `GET /v1/logs` in both native Go server mode (`slaprf.log` + ring)
// and pure browser WASM mode (`slaprf.wasm` bounded in-memory ring buffer).
type LogsResponse struct {
	LogPath   string   `json:"logPath"`
	SizeBytes int64    `json:"sizeBytes"`
	Level     string   `json:"level"`
	Levels    []string `json:"levels"`
	LineCount int      `json:"lineCount"`
	MaxLines  int      `json:"maxLines,omitempty"`
	Lines     []string `json:"lines"`
}

func (s *Server) handleLogsGet(w http.ResponseWriter, r *http.Request) {
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

	maxCap := s.appLog.RingCap()
	tail := 200
	if rawTail := strings.TrimSpace(r.URL.Query().Get("tail")); rawTail != "" {
		if n, err := strconv.Atoi(rawTail); err == nil && n > 0 {
			if n > maxCap {
				n = maxCap
			}
			tail = n
		}
	}
	st := s.appLog.Status()
	lines := s.appLog.Tail(tail)
	if lines == nil {
		lines = []string{}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, LogsResponse{
		LogPath:   st.LogPath,
		SizeBytes: st.SizeBytes,
		Level:     st.Level,
		Levels:    st.Levels,
		LineCount: st.LineCount,
		MaxLines:  st.MaxLines,
		Lines:     lines,
	})
}

func (s *Server) handleGetLogsConfig(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, s.appLog.Status())
}

func (s *Server) handlePutLogsConfig(w http.ResponseWriter, r *http.Request) {
	rawBytes, err := io.ReadAll(io.LimitReader(r.Body, 4096))
	if err != nil {
		writeErrorJSON(w, http.StatusBadRequest, "failed to read request body")
		return
	}
	var payload struct {
		Level   string `json:"level"`
		Verbose *bool  `json:"verbose,omitempty"`
	}
	if err := decodeOptionalJSONBody(
		&http.Request{Body: io.NopCloser(strings.NewReader(string(rawBytes)))},
		&payload,
	); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, "invalid JSON request body")
		return
	}

	var lvl applog.Level
	var ok bool
	if strings.TrimSpace(payload.Level) != "" {
		lvl, ok = applog.ParseLevel(payload.Level)
		if !ok {
			writeErrorJSON(w, http.StatusBadRequest, "invalid log level: must be one of trace, debug, info, warn, error")
			return
		}
	} else if payload.Verbose != nil {
		if *payload.Verbose {
			lvl = applog.LevelDebug
		} else {
			lvl = applog.LevelInfo
		}
	} else {
		writeErrorJSON(w, http.StatusBadRequest, "missing level field (trace, debug, info, warn, error)")
		return
	}

	s.appLog.SetLevel(lvl)
	if s.hooks.OnLogLevelChanged != nil {
		s.hooks.OnLogLevelChanged(lvl.String())
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, s.appLog.Status())
}

func (s *Server) handleLogsClear(w http.ResponseWriter, r *http.Request) {
	if err := decodeOptionalJSONBody(r, &struct{}{}); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	_ = s.appLog.Clear()
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, s.appLog.Status())
}
