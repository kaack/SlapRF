package api

import (
	"fmt"

	"slaprf/internal/applog"
)

// SetLogger attaches an operational logger so user-driven and simulator-driven mutations emit
// structured INFO entries to `slaprf.log` and Android `logcat`. Any action executed inside the
// simulator context is explicitly prefixed with `[SIM]` so simulated interactions never mix with
// real-hardware events in log analysis.
func (s *Server) SetLogger(lg *applog.Logger) {
	s.appLog = lg
}

func (s *Server) isSimActive() bool {
	return s != nil && s.simulator != nil && s.simulator.IsRunning()
}

func (s *Server) logUserAction(component string, format string, args ...any) {
	if s == nil || s.appLog == nil {
		return
	}
	msg := fmt.Sprintf(format, args...)
	if s.isSimActive() {
		s.appLog.Infof("[SIM][%s] %s", component, msg)
		return
	}
	s.appLog.Infof("[%s] %s", component, msg)
}

func (s *Server) logRealAction(component string, format string, args ...any) {
	if s == nil || s.appLog == nil {
		return
	}
	s.appLog.Infof("[%s] %s", component, fmt.Sprintf(format, args...))
}

func (s *Server) logSimAction(component string, format string, args ...any) {
	if s == nil || s.appLog == nil {
		return
	}
	msg := fmt.Sprintf(format, args...)
	if component == "" {
		s.appLog.Infof("[SIM] %s", msg)
		return
	}
	s.appLog.Infof("[SIM][%s] %s", component, msg)
}
