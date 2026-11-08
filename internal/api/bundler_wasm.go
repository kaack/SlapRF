//go:build js

package api

import "net/http"

func (s *Server) handleTypeScriptBundle(w http.ResponseWriter, _ *http.Request) {
	http.NotFound(w, nil)
}

func (s *Server) handleWasmExecJS(w http.ResponseWriter, _ *http.Request) {
	http.NotFound(w, nil)
}

func (s *Server) handleSlaprfWasm(w http.ResponseWriter, _ *http.Request) {
	http.NotFound(w, nil)
}
