package portable

import "net/http"

func (s *Server) handleBluetoothPorts(w http.ResponseWriter, r *http.Request) {
	s.serveSlapRFPorts(w, r, s.bleMgr, false)
}

func (s *Server) handleBluetoothStatus(w http.ResponseWriter, r *http.Request) {
	s.serveSlapRFStatus(w, r, s.bleMgr)
}

func (s *Server) handleBluetoothConnect(w http.ResponseWriter, r *http.Request) {
	s.serveSlapRFConnect(w, r, s.bleMgr, "/v1/bluetooth")
}

func (s *Server) handleBluetoothDisconnectSlot(w http.ResponseWriter, r *http.Request) {
	s.serveSlapRFDisconnectSlot(w, r, s.bleMgr)
}

func (s *Server) handleBluetoothDisconnectAll(w http.ResponseWriter, r *http.Request) {
	s.serveSlapRFDisconnectAll(w, r, s.bleMgr)
}

func (s *Server) handleBluetoothCommand(w http.ResponseWriter, r *http.Request) {
	s.serveSlapRFCommand(w, r, s.bleMgr)
}

func (s *Server) handleBluetoothKnownForget(w http.ResponseWriter, r *http.Request) {
	s.serveSlapRFKnownForget(w, r, s.bleMgr)
}

func (s *Server) handleBluetoothWS(w http.ResponseWriter, r *http.Request) {
	s.serveSlapRFWS(w, r, s.bleMgr)
}
