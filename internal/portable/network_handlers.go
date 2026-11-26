package portable

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"slaprf/internal/domain"
	slaprfnet "slaprf/internal/slaprf/network"
)

func (s *Server) handleNetworkPorts(w http.ResponseWriter, r *http.Request) {
	s.serveSlapRFPorts(w, r, s.netMgr, false)
}

func (s *Server) handleNetworkDevices(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	devs, subnet, err := s.netTransport.DiscoverDevices(r.Context())
	if err != nil {
		writeJSONNoStore(w, http.StatusOK, map[string]any{
			"subnet":  subnet,
			"devices": []slaprfnet.DiscoveredDevice{},
			"error":   err.Error(),
		})
		return
	}
	if devs == nil {
		devs = []slaprfnet.DiscoveredDevice{}
	}
	pool := s.netMgr.Snapshot()
	connectedEndpoints := make(map[string]bool)
	for _, sl := range pool.Slots {
		if sl.PortName != "" && (sl.Connected || sl.Connecting || sl.Reconnecting) {
			connectedEndpoints[sl.PortName] = true
		}
	}
	for i := range devs {
		devs[i].Connected = connectedEndpoints[devs[i].Endpoint]
	}
	writeJSONNoStore(w, http.StatusOK, map[string]any{
		"subnet":  subnet,
		"devices": devs,
		"pool":    pool,
	})
}

func (s *Server) handleNetworkStatus(w http.ResponseWriter, r *http.Request) {
	s.serveSlapRFStatus(w, r, s.netMgr)
}

func (s *Server) handleNetworkConnect(w http.ResponseWriter, r *http.Request) {
	s.serveSlapRFConnect(w, r, s.netMgr, "/v1/slaprf/network")
}

func (s *Server) handleNetworkDisconnectSlot(w http.ResponseWriter, r *http.Request) {
	s.serveSlapRFDisconnectSlot(w, r, s.netMgr)
}

func (s *Server) handleNetworkDisconnectAll(w http.ResponseWriter, r *http.Request) {
	s.serveSlapRFDisconnectAll(w, r, s.netMgr)
}

func (s *Server) handleNetworkCommand(w http.ResponseWriter, r *http.Request) {
	s.serveSlapRFCommand(w, r, s.netMgr)
}

func (s *Server) handleNetworkSurvey(w http.ResponseWriter, r *http.Request) {
	s.serveHubSurvey(w, r, domain.HardwareModeSlapRFNet, s.netMgr)
}

func (s *Server) handleNetworkWS(w http.ResponseWriter, r *http.Request) {
	s.serveSlapRFWS(w, r, s.netMgr)
}

func (s *Server) handleNetworkBridgeStatus(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	qTarget := strings.TrimSpace(r.URL.Query().Get("target"))

	connectedSlot := -1
	activeTarget := ""
	pool := s.netMgr.Snapshot()
	for _, sl := range pool.Slots {
		if sl.PortName != "" && (sl.Connected || sl.Reconnecting) {
			connectedSlot = sl.SlotIndex
			activeTarget = sl.PortName
			break
		}
	}
	target := qTarget
	if target == "" {
		target = activeTarget
	}

	if target == "" {
		writeJSONNoStore(w, http.StatusOK, map[string]any{
			"target":        "",
			"activeTarget":  "",
			"connectedSlot": -1,
			"subnet":        "",
			"bridge":        nil,
			"devices":       []slaprfnet.DiscoveredDevice{},
			"error":         "Not connected to a PoE Bridge.",
		})
		return
	}

	var bridge *slaprfnet.BridgeStatus
	var queryErr string
	st, err := s.netTransport.QueryBridgeStatus(r.Context(), target)
	if err != nil {
		queryErr = err.Error()
	} else {
		bridge = st
		target = st.Endpoint
	}

	writeJSONNoStore(w, http.StatusOK, map[string]any{
		"target":        target,
		"activeTarget":  activeTarget,
		"connectedSlot": connectedSlot,
		"subnet":        "",
		"bridge":        bridge,
		"devices":       []slaprfnet.DiscoveredDevice{},
		"error":         queryErr,
	})
}

func (s *Server) handleNetworkBridgeAction(w http.ResponseWriter, r *http.Request) {
	if !s.isAllowedOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req slaprfnet.BridgeActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON request body"})
		return
	}

	target := strings.TrimSpace(req.Target)
	if target == "" {
		pool := s.netMgr.Snapshot()
		for _, sl := range pool.Slots {
			if sl.PortName != "" && (sl.Connected || sl.Reconnecting) {
				target = sl.PortName
				break
			}
		}
	}
	if target == "" {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "not connected to a PoE Bridge"})
		return
	}

	res, err := s.netTransport.SendBridgeAction(r.Context(), target, req)
	if err != nil {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	if strings.EqualFold(strings.TrimSpace(req.Action), "reset-usb") {
		// Reset HubRx state so Hub H1's boot HELLO immediately triggers a fresh 5.8 GHz channel push,
		// and re-query STATUS? once the attached USB timer finishes booting.
		s.realHubRx.Reset()
		go func() {
			time.Sleep(350 * time.Millisecond)
			_ = s.netMgr.SendCommand(0, "STATUS?")
		}()
	}
	writeJSONNoStore(w, http.StatusOK, res)
}
