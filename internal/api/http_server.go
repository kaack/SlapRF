package api

import (
	"encoding/json"
	"net/http"

	"slaprf/internal/domain"
	"slaprf/internal/ingest"
	"slaprf/internal/laprf"
	"slaprf/internal/tracker"
)

// FullStateResponse is returned by `GET /api/state` on initial SPA load.
type FullStateResponse struct {
	ServerTimestampUs uint64                     `json:"serverTimestampUs"`
	Pilots            []domain.PilotSlot         `json:"pilots"`
	Gates             []domain.TrackGate         `json:"gates"`
	Timers            []domain.DetectedTimer     `json:"timers"`
	Laps              []domain.LapRecord         `json:"laps"`
	Crossings         []domain.GateCrossingEvent `json:"crossings"`
	Filtered          []domain.FilteredDetection `json:"filtered"`
	Summaries         []domain.PilotTrackSummary `json:"summaries"`
	Rules             domain.TimingRules         `json:"rules"`
	SimulatorRun      bool                       `json:"simulatorRunning"`
	SimState          *domain.SimState           `json:"simState,omitempty"`
	RaceArmed         bool                       `json:"raceArmed"`
	LiveTimeStatus    laprf.LiveTimeStatus       `json:"liveTimeStatus"`
}

// StatusResponse is the lightweight payload polled by the SPA every few seconds
// (gate battery / link health, LiveTime connection, timing armed state).
type StatusResponse struct {
	ServerTimestampUs uint64                 `json:"serverTimestampUs"`
	Gates             []domain.TrackGate     `json:"gates"`
	Timers            []domain.DetectedTimer `json:"timers"`
	SimulatorRun      bool                   `json:"simulatorRunning"`
	SimState          *domain.SimState       `json:"simState,omitempty"`
	RaceArmed         bool                   `json:"raceArmed"`
	LiveTimeStatus    laprf.LiveTimeStatus   `json:"liveTimeStatus"`
}

// RealBackendState is the real-world engine snapshot exchanged by `GET /api/storage/export`
// and `POST /api/storage/import` (the "real" section of the app's JSON export file).
// Older exports may carry a `liveTimeEnabled` flag; it is ignored on import because the
// LiveTime toggle is now a browser UI preference (see web/src/services/livetime_relay.ts).
type RealBackendState struct {
	Engine tracker.PersistedEngineState `json:"engine"`
}

// StreamEnvelope wraps a typed real-time message sent to the TypeScript SPA
// (delivered in-process by the WASM bridge's `onStream` callback).
type StreamEnvelope struct {
	Type    string      `json:"type"` // "telemetry" | "crossing" | "filtered" | "lap" | "config"
	Payload interface{} `json:"payload"`
}

// Server is the in-browser request router: cmd/slaprf-wasm sends every JS
// `request(method, url, body)` through Handler().ServeHTTP in-process.
// It maintains two completely isolated timing engines (`simEngine` for the built-in track
// simulator and `realEngine` for physical XIAO ESP32-C5 hardware) so simulated timers,
// gates, pilots, rules, and laps never mix with real-world data.
type Server struct {
	simEngine   *tracker.Engine
	realEngine  *tracker.Engine
	simulator   *ingest.TrackSimulator
	laprfServer *laprf.Server
}

// NewServer creates the request router with separate simulation and real-world engines.
func NewServer(
	simEngine *tracker.Engine,
	simulator *ingest.TrackSimulator,
	laprfServer *laprf.Server,
	realEngines ...*tracker.Engine,
) *Server {
	var realEngine *tracker.Engine
	if len(realEngines) > 0 && realEngines[0] != nil {
		realEngine = realEngines[0]
	} else {
		realEngine = tracker.NewRealEngine()
	}

	s := &Server{
		simEngine:   simEngine,
		realEngine:  realEngine,
		simulator:   simulator,
		laprfServer: laprfServer,
	}
	// The LapRF (LiveTime) emulation always serves whichever engine is active, whether the
	// simulator is toggled via /api/sim/toggle or directly (WASM bridge `setRunning`).
	laprfServer.Follow(s.activeEngine, simEngine, realEngine)
	return s
}

func (s *Server) activeEngine() *tracker.Engine {
	if s.simulator.IsRunning() {
		return s.simEngine
	}
	return s.realEngine
}

// RealEngine returns the hardware timing engine fed by the physical XIAO ESP32-C5 Hub Timer.
func (s *Server) RealEngine() *tracker.Engine {
	return s.realEngine
}

// Handler builds the HTTP multiplexer for the application's `/api/*` routes.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/api/version", s.handleGetVersion)
	mux.HandleFunc("/api/state", s.handleGetState)
	mux.HandleFunc("/api/status", s.handleGetStatus)
	mux.HandleFunc("/api/rules", s.handleRules)
	mux.HandleFunc("/api/timing/toggle-arm", s.handleToggleArm)
	mux.HandleFunc("/api/pilots/update", s.handleUpdatePilot)
	mux.HandleFunc("/api/pilots/reset", s.handleResetPilots)
	mux.HandleFunc("/api/track/update", s.handleUpdateGate)
	mux.HandleFunc("/api/track/add", s.handleAddGate)
	mux.HandleFunc("/api/track/remove", s.handleRemoveGate)
	mux.HandleFunc("/api/track/rules", s.handleGateRules)
	mux.HandleFunc("/api/track/reset", s.handleResetTrack)
	mux.HandleFunc("/api/timers/provision", s.handleProvisionGate)
	mux.HandleFunc("/api/timers/color", s.handleUpdateTimerColor)

	// Legacy aliases
	mux.HandleFunc("/api/gates/update", s.handleUpdateGate)
	mux.HandleFunc("/api/gates/add", s.handleAddGate)
	mux.HandleFunc("/api/gates/remove", s.handleRemoveGate)
	mux.HandleFunc("/api/gates/provision", s.handleProvisionGate)
	mux.HandleFunc("/api/thresholds", s.handleThresholds)
	mux.HandleFunc("/api/gates/rules", s.handleGateRules)
	mux.HandleFunc("/api/sim/toggle", s.handleToggleSim)
	mux.HandleFunc("/api/sim/pack-burst", s.handlePackBurst)
	mux.HandleFunc("/api/sim/pilot-action", s.handleSimPilotAction)
	mux.HandleFunc("/api/sim/track-walker", s.handleSimTrackWalker)
	mux.HandleFunc("/api/sim/timer-action", s.handleSimTimerAction)
	mux.HandleFunc("/api/session/reset", s.handleResetSession)
	mux.HandleFunc("/api/storage/reset", s.handleResetStorage)
	mux.HandleFunc("/api/storage/export", s.handleExportStorage)
	mux.HandleFunc("/api/storage/import", s.handleImportStorage)

	return mux
}

func (s *Server) handleGetState(w http.ResponseWriter, r *http.Request) {
	eng := s.activeEngine()
	pilots, gates, laps, crossings, summaries := eng.StateSnapshot()
	var simState *domain.SimState
	if s.simulator.IsRunning() {
		snap := s.simulator.Snapshot()
		simState = &snap
	}
	resp := FullStateResponse{
		ServerTimestampUs: eng.NowUs(),
		Pilots:            pilots,
		Gates:             gates,
		Timers:            eng.DetectedTimersSnapshot(),
		Laps:              laps,
		Crossings:         crossings,
		Filtered:          eng.FilteredSnapshot(),
		Summaries:         summaries,
		Rules:             eng.Rules(),
		SimulatorRun:      s.simulator.IsRunning(),
		SimState:          simState,
		RaceArmed:         eng.IsRaceArmed(),
		LiveTimeStatus:    s.laprfServer.Status(),
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleGetStatus(w http.ResponseWriter, _ *http.Request) {
	eng := s.activeEngine()
	_, gates, _, _, _ := eng.StateSnapshot()
	var simState *domain.SimState
	if s.simulator.IsRunning() {
		snap := s.simulator.Snapshot()
		simState = &snap
	}
	writeJSON(w, http.StatusOK, StatusResponse{
		ServerTimestampUs: eng.NowUs(),
		Gates:             gates,
		Timers:            eng.DetectedTimersSnapshot(),
		SimulatorRun:      s.simulator.IsRunning(),
		SimState:          simState,
		RaceArmed:         eng.IsRaceArmed(),
		LiveTimeStatus:    s.laprfServer.Status(),
	})
}

// handleRules reads (GET) or replaces (POST) the timing guardrails. Values are clamped
// server-side; the applied rules are returned.
func (s *Server) handleRules(w http.ResponseWriter, r *http.Request) {
	eng := s.activeEngine()
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, eng.Rules())
	case http.MethodPost:
		var rules domain.TimingRules
		if err := json.NewDecoder(r.Body).Decode(&rules); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		applied := eng.SetRules(rules)
		writeJSON(w, http.StatusOK, applied)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleToggleArm pauses / resumes lap detection. When MultiGP LiveTime is connected,
// LiveTime owns the arm/disarm state over the LapRF protocol and manual toggling is ignored.
func (s *Server) handleToggleArm(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.laprfServer.Status().ConnectedClients == 0 {
		eng := s.activeEngine()
		eng.SetRaceArmed(!eng.IsRaceArmed())
	}
	s.handleGetStatus(w, r)
}

func (s *Server) handleUpdatePilot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var slot domain.PilotSlot
	if err := json.NewDecoder(r.Body).Decode(&slot); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if slot.Channel == 0 {
		slot.FrequencyMHz = 0
	} else if slot.Channel >= 1 && slot.Channel <= 8 && slot.Band == domain.BandRaceband {
		slot.FrequencyMHz = domain.RacebandFrequenciesMHz[slot.Channel-1]
	}
	if slot.ExitThreshold == 0 || slot.ExitThreshold >= slot.EnterThreshold {
		slot.ExitThreshold = slot.EnterThreshold - 10.0
	}
	s.activeEngine().UpdatePilotSlot(slot)
	s.handleGetState(w, r)
}

// handleThresholds calibrates gates per pilot: a list of {gateId, slotIndex, enterDbm}
// (enterDbm 0 = back to the pilot's own threshold). Applied all-or-nothing.
func (s *Server) handleThresholds(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var updates []domain.GateThresholdUpdate
	if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.activeEngine().SetGateThresholds(updates); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.handleGetState(w, r)
}

// handleGateRules sets one gate's timing-rule overrides: {gateId, overrides: {...}}.
// Omitted fields use the global rules; an empty overrides object clears them all.
func (s *Server) handleGateRules(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		GateID    uint8                    `json:"gateId"`
		Overrides domain.GateRuleOverrides `json:"overrides"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if _, err := s.activeEngine().SetGateRules(body.GateID, body.Overrides); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.handleGetState(w, r)
}

func (s *Server) handleUpdateGate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var upd domain.GateUpdate
	if err := json.NewDecoder(r.Body).Decode(&upd); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.activeEngine().UpdateGate(upd); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.handleGetState(w, r)
}

func (s *Server) handleUpdateTimerColor(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		TimerID uint8  `json:"timerId"`
		Color   string `json:"color"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.activeEngine().SetTimerColor(body.TimerID, body.Color); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.handleGetState(w, r)
}

func (s *Server) handleAddGate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Name            string `json:"name"`
		AssignedTimerID uint8  `json:"assignedTimerId"`
		TrackOrder      *int   `json:"trackOrder,omitempty"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	var err error
	eng := s.activeEngine()
	if body.TrackOrder != nil {
		_, err = eng.AddGate(body.Name, body.AssignedTimerID, *body.TrackOrder)
	} else {
		_, err = eng.AddGate(body.Name, body.AssignedTimerID)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.handleGetState(w, r)
}

func (s *Server) handleRemoveGate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		GateID uint8 `json:"gateId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.activeEngine().RemoveGate(body.GateID); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.handleGetState(w, r)
}

// handleProvisionGate registers a newly flashed gate timer (or updates its flashed TimerLabel)
// in the real-world engine (and active engine if different) so its ID/name shows up immediately.
func (s *Server) handleProvisionGate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Role        string `json:"role"`
		TimerLabel  string `json:"timerLabel"`
		Profile     string `json:"firmwareProfile,omitempty"`
		Fingerprint string `json:"fingerprint,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	req := tracker.ProvisionRequest{
		Role:        body.Role,
		Label:       body.TimerLabel,
		Profile:     body.Profile,
		Fingerprint: body.Fingerprint,
	}
	if _, err := s.activeEngine().ProvisionGate(req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if s.activeEngine() != s.realEngine {
		_, _ = s.realEngine.ProvisionGate(req)
	}
	s.handleGetState(w, r)
}

func (s *Server) handleToggleSim(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	next := !s.simulator.IsRunning()
	s.simulator.SetRunning(next)
	s.handleGetState(w, r)
}

func (s *Server) handlePackBurst(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.simulator.TriggerPackBurst()
	s.handleGetState(w, r)
}

func (s *Server) handleSimPilotAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		SlotIndex int    `json:"slotIndex"`
		Action    string `json:"action"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.simulator.TriggerPilotAction(body.SlotIndex, body.Action)
	s.handleGetState(w, r)
}

func (s *Server) handleSimTrackWalker(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Active bool `json:"active"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.simulator.SetTrackWalker(body.Active)
	s.handleGetState(w, r)
}

func (s *Server) handleSimTimerAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Action  string `json:"action"` // "toggle-power", "delete", "add"
		TimerID uint8  `json:"timerId,omitempty"`
		Role    string `json:"role,omitempty"`
		Label   string `json:"label,omitempty"`
		Profile string `json:"firmwareProfile,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	switch body.Action {
	case "toggle-power":
		s.simulator.ToggleTimerPower(body.TimerID)
	case "delete":
		if err := s.simulator.DeleteTimer(body.TimerID); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	case "add":
		if _, err := s.simulator.AddTimer(body.Role, body.Label, body.Profile); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	case "reset-timers":
		s.simulator.ResetTimersAndTrackToDefault()
	default:
		http.Error(w, "unknown timer action", http.StatusBadRequest)
		return
	}
	s.handleGetState(w, r)
}

func (s *Server) handleResetPilots(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.activeEngine().ResetPilotsToDefault(s.simulator.IsRunning())
	s.handleGetState(w, r)
}

func (s *Server) handleResetTrack(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.simulator.IsRunning() {
		s.simulator.ResetTimersAndTrackToDefault()
	} else {
		s.realEngine.ResetTrackToDefault(false)
	}
	s.handleGetState(w, r)
}

func (s *Server) handleResetSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.activeEngine().ResetSession()
	s.handleGetState(w, r)
}

func (s *Server) handleResetStorage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.simulator.ResetToFactoryDefaults()
	if s.realEngine != nil && s.realEngine != s.simEngine {
		s.realEngine.ResetToFactoryDefaults(false)
	}
	s.handleGetState(w, r)
}

func (s *Server) handleExportStorage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, RealBackendState{
		Engine: s.realEngine.ExportState(),
	})
}

func (s *Server) handleImportStorage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var state RealBackendState
	if err := json.NewDecoder(r.Body).Decode(&state); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.realEngine.RestoreState(state.Engine, false)
	s.handleGetState(w, r)
}

func writeJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
