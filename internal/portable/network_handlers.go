package portable

import (
	"net/http"

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
	writeJSONNoStore(w, http.StatusOK, map[string]any{
		"subnet":  subnet,
		"devices": devs,
		"pool":    s.netMgr.Snapshot(),
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
