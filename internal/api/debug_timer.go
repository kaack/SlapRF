package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// debugTimerResponse tells the Debug page whether a USB-connected timer's data is also reaching
// this laptop over the Hub's Wi-Fi link (always from the real engine, never the simulator).
type debugTimerResponse struct {
	Found       bool      `json:"found"`
	TimerID     uint8     `json:"timerId,omitempty"`
	Label       string    `json:"label,omitempty"`
	Online      bool      `json:"online"`
	LastSeenAt  time.Time `json:"lastSeenAt,omitempty"`
	MsSinceSeen int64     `json:"msSinceSeen,omitempty"`
	FramesRx    uint64    `json:"framesRx"`
	Simulator   bool      `json:"simulatorActive"`
}

// handleDebugTimer: GET /api/debug/timer?fp=BE7C0001
func (s *Server) handleDebugTimer(w http.ResponseWriter, r *http.Request) {
	fp := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("fp")))
	resp := debugTimerResponse{Simulator: s.activeEngine() != s.realEngine}
	if fp != "" {
		for _, d := range s.realEngine.DetectedTimersSnapshot() {
			if d.Fingerprint != fp {
				continue
			}
			resp.Found = true
			resp.TimerID = d.TimerID
			resp.Label = d.TimerLabel
			resp.Online = d.Online
			resp.LastSeenAt = d.LastSeenAt
			if !d.LastSeenAt.IsZero() {
				resp.MsSinceSeen = time.Since(d.LastSeenAt).Milliseconds()
			}
			_, gates, _, _, _ := s.realEngine.StateSnapshot()
			for _, g := range gates {
				if g.AssignedTimerID == d.TimerID {
					resp.FramesRx = g.FramesRxCount
				}
			}
			break
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(resp)
}
