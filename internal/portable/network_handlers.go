package portable

import (
	"encoding/json"
	"net/http"
	"strings"

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
	skipScan := r.URL.Query().Get("scan") == "0"

	connectedSlot := -1
	activeTarget := ""
	pool := s.netMgr.Snapshot()
	for _, sl := range pool.Slots {
		if sl.PortName != "" && (sl.Connected || sl.Connecting || sl.Reconnecting) {
			connectedSlot = sl.SlotIndex
			activeTarget = sl.PortName
			break
		}
	}
	target := qTarget
	if target == "" {
		target = activeTarget
	}

	var devs []slaprfnet.DiscoveredDevice
	var subnet string
	if !skipScan || target == "" {
		discDevs, discSubnet, err := s.netTransport.DiscoverDevices(r.Context())
		if err == nil && discDevs != nil {
			devs = discDevs
			subnet = discSubnet
		}
		if target == "" && len(devs) > 0 {
			target = devs[0].Endpoint
		}
	}
	if devs == nil {
		devs = []slaprfnet.DiscoveredDevice{}
	}

	var bridge *slaprfnet.BridgeStatus
	var queryErr string
	if target != "" {
		st, err := s.netTransport.QueryBridgeStatus(r.Context(), target)
		if err != nil {
			queryErr = err.Error()
		} else {
			bridge = st
			target = st.Endpoint
		}
	}

	writeJSONNoStore(w, http.StatusOK, map[string]any{
		"target":        target,
		"activeTarget":  activeTarget,
		"connectedSlot": connectedSlot,
		"subnet":        subnet,
		"bridge":        bridge,
		"devices":       devs,
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
			if sl.PortName != "" && (sl.Connected || sl.Connecting || sl.Reconnecting) {
				target = sl.PortName
				break
			}
		}
	}
	if target == "" {
		if devs, _, err := s.netTransport.DiscoverDevices(r.Context()); err == nil && len(devs) > 0 {
			target = devs[0].Endpoint
		}
	}
	if target == "" {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": "no PoE Bridge target specified or discovered on the local network"})
		return
	}

	res, err := s.netTransport.SendBridgeAction(r.Context(), target, req)
	if err != nil {
		writeJSONNoStore(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSONNoStore(w, http.StatusOK, res)
}
