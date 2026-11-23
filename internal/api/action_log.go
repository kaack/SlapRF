package api

import (
	"fmt"

	"slaprf/internal/applog"
)

// SetLogger attaches an operational logger (`applog.Logger` is nil-safe on all methods, so callers
// invoke `s.appLog.Infof(...)` directly without nil checks). Any action executed inside the
// simulator context is prefixed with `[SIM]` so simulated interactions never mix with real hardware.
func (s *Server) SetLogger(lg *applog.Logger) {
	s.appLog = lg
}

func (s *Server) isSimActive() bool {
	return s.simulator != nil && s.simulator.IsRunning()
}

func (s *Server) logUserAction(component string, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	if s.isSimActive() {
		s.appLog.Infof("[SIM][%s] %s", component, msg)
		return
	}
	s.appLog.Infof("[%s] %s", component, msg)
}

func (s *Server) logRealAction(component string, format string, args ...any) {
	s.appLog.Infof("[%s] %s", component, fmt.Sprintf(format, args...))
}

func (s *Server) logSimAction(component string, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	if component == "" {
		s.appLog.Infof("[SIM] %s", msg)
		return
	}
	s.appLog.Infof("[SIM][%s] %s", component, msg)
}
