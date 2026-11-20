package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"slaprf/internal/domain"
	"slaprf/internal/ingest"
	"slaprf/internal/laprf"
	"slaprf/internal/multigp"
	"slaprf/internal/tracker"
)

// FullStateResponse is returned by `GET /api/state` on initial SPA load.
type FullStateResponse struct {
	ServerTimestampUs  uint64                      `json:"serverTimestampUs"`
	TimingHardwareMode domain.TimingHardwareMode   `json:"timingHardwareMode"`
	Pilots             []domain.PilotSlot          `json:"pilots"`
	Gates              []domain.TrackGate          `json:"gates"`
	Timers             []domain.DetectedTimer      `json:"timers"`
	Laps               []domain.LapRecord          `json:"laps"`
	Crossings          []domain.GateCrossingEvent  `json:"crossings"`
	Filtered           []domain.FilteredDetection  `json:"filtered"`
	Summaries          []domain.PilotTrackSummary  `json:"summaries"`
	Rules              domain.TimingRules          `json:"rules"`
	SimulatorRun       bool                        `json:"simulatorRunning"`
	SimState           *domain.SimState            `json:"simState,omitempty"`
	SimMultiGP         *multigp.SimPersistedState    `json:"simMultiGP,omitempty"`
	RaceArmed          bool                          `json:"raceArmed"`
	LiveTimeStatus     laprf.LiveTimeStatus          `json:"liveTimeStatus"`
	RaceState          domain.RaceTournamentState    `json:"raceState"`
	EventState         domain.EventManagerState      `json:"eventState"`
	PracticeState      domain.PracticeManagerState   `json:"practiceState"`
	ImportSummary      *domain.PilotCSVImportSummary `json:"importSummary,omitempty"`
}

// StatusResponse is the lightweight payload polled by the SPA every few seconds
// (gate battery / link health, LiveTime connection, timing armed state).
type StatusResponse struct {
	ServerTimestampUs  uint64                      `json:"serverTimestampUs"`
	TimingHardwareMode domain.TimingHardwareMode   `json:"timingHardwareMode"`
	Gates              []domain.TrackGate          `json:"gates"`
	Timers             []domain.DetectedTimer      `json:"timers"`
	SimulatorRun       bool                        `json:"simulatorRunning"`
	SimState           *domain.SimState            `json:"simState,omitempty"`
	SimMultiGP         *multigp.SimPersistedState  `json:"simMultiGP,omitempty"`
	RaceArmed          bool                          `json:"raceArmed"`
	LiveTimeStatus     laprf.LiveTimeStatus          `json:"liveTimeStatus"`
	RaceState          *domain.RaceTournamentState   `json:"raceState,omitempty"`
	EventState         *domain.EventManagerState     `json:"eventState,omitempty"`
	PracticeState      *domain.PracticeManagerState  `json:"practiceState,omitempty"`
	ImportSummary      *domain.PilotCSVImportSummary `json:"importSummary,omitempty"`
}

// RealBackendState is the real-world engine snapshot exchanged by `GET /api/storage/export`
// and `POST /api/storage/import` (the "real" section of the app's JSON export file).
// Older exports may carry a `liveTimeEnabled` flag; it is ignored on import because the
// LiveTime toggle is now a browser UI preference (see web/src/services/livetime_relay.ts).
type RealBackendState struct {
	Engine tracker.PersistedEngineState `json:"engine"`
}

// SimBackendState is the simulated engine + simulator options snapshot exchanged by
// `GET /api/storage/sim-export` and `POST /api/storage/sim-import`.
type SimBackendState struct {
	Engine  tracker.PersistedEngineState `json:"engine"`
	Options ingest.SimPersistedOptions   `json:"options"`
}

// ServerHooks allows a native host (e.g. `internal/portable` + `bbolt` persistence) to react
// immediately when REST requests mutate state, switch simulation mode, or reset/import storage.
type ServerHooks struct {
	OnMutation      func()
	OnModeChanged   func(simRunning bool)
	OnTimingStarted func()
	OnStorageReset  func()
	OnStorageImport func()
}

// StreamEnvelope wraps a typed real-time message sent to the TypeScript SPA
// (delivered in-process by the WASM bridge's `onStream` callback or over `/api/ws/stream`).
type StreamEnvelope struct {
	Type    string      `json:"type"` // "telemetry" | "crossing" | "filtered" | "lap" | "config"
	Payload interface{} `json:"payload"`
}

// Server is the HTTP request router shared by the native Go server (`internal/portable`) and
// the standalone browser demo (`cmd/slaprf-wasm`).
// It maintains two completely isolated timing engines (`simEngine` for the built-in track
// simulator and `realEngine` for physical timing hardware) so simulated timers,
// gates, pilots, rules, and laps never mix with real-world data.
type Server struct {
	simEngine   *tracker.Engine
	realEngine  *tracker.Engine
	simulator   *ingest.TrackSimulator
	laprfServer *laprf.Server
	hooks       ServerHooks
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

// SetHooks attaches optional persistence / lifecycle callbacks invoked after mutations.
func (s *Server) SetHooks(hooks ServerHooks) {
	s.hooks = hooks
}

// SimEngine returns the built-in simulation engine.
func (s *Server) SimEngine() *tracker.Engine {
	return s.simEngine
}

// RealEngine returns the hardware timing engine fed by physical timing hardware.
func (s *Server) RealEngine() *tracker.Engine {
	return s.realEngine
}

// RegisterRoutes attaches all core `/api/*` routes onto `mux`, wrapping non-GET mutations so
// registered `ServerHooks` are notified cleanly.
func (s *Server) RegisterRoutes(mux *http.ServeMux) {
	wrap := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			h(w, r)
			if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions && r.URL.Path != "/api/race/tick" {
				if s.hooks.OnMutation != nil {
					s.hooks.OnMutation()
				}
			}
		}
	}

	mux.HandleFunc("/api/version", s.handleGetVersion)
	mux.HandleFunc("/api/state", s.handleGetState)
	mux.HandleFunc("/api/status", s.handleGetStatus)
	mux.HandleFunc("/api/rules", wrap(s.handleRules))
	mux.HandleFunc("/api/timing/toggle-arm", wrap(s.handleToggleArm))
	mux.HandleFunc("/api/pilots/update", wrap(s.handleUpdatePilot))
	mux.HandleFunc("/api/pilots/add", wrap(s.handleAddPilot))
	mux.HandleFunc("/api/pilots/remove", wrap(s.handleRemovePilot))
	mux.HandleFunc("/api/pilots/reset", wrap(s.handleResetPilots))
	mux.HandleFunc("/api/pilots/export.csv", s.handleExportPilotsCSV)
	mux.HandleFunc("/api/pilots/import", wrap(s.handleImportPilotsCSV))
	mux.HandleFunc("/api/race/mode", wrap(s.handleRaceMode))
	mux.HandleFunc("/api/race/setup", wrap(s.handleRaceSetup))
	mux.HandleFunc("/api/race/advance-stage", wrap(s.handleRaceAdvanceStage))
	mux.HandleFunc("/api/race/control", wrap(s.handleRaceControl))
	mux.HandleFunc("/api/race/marshal", wrap(s.handleRaceMarshal))
	mux.HandleFunc("/api/race/bracket-edit", wrap(s.handleRaceBracketEdit))
	mux.HandleFunc("/api/race/tick", s.handleRaceTick)
	mux.HandleFunc("/api/race/export.csv", s.handleExportRaceResultsCSV)
	mux.HandleFunc("/api/races/export.csv", s.handleExportRaceResultsCSV)
	mux.HandleFunc("/api/events/action", wrap(s.handleEventAction))
	mux.HandleFunc("/api/practice/action", wrap(s.handlePracticeAction))
	mux.HandleFunc("/api/track/update", wrap(s.handleUpdateGate))
	mux.HandleFunc("/api/track/add", wrap(s.handleAddGate))
	mux.HandleFunc("/api/track/remove", wrap(s.handleRemoveGate))
	mux.HandleFunc("/api/track/rules", wrap(s.handleGateRules))
	mux.HandleFunc("/api/track/reset", wrap(s.handleResetTrack))
	mux.HandleFunc("/api/timers/provision", wrap(s.handleProvisionGate))
	mux.HandleFunc("/api/timers/color", wrap(s.handleUpdateTimerColor))
	mux.HandleFunc("/api/timers/delete", wrap(s.handleDeleteTimer))

	// Legacy aliases
	mux.HandleFunc("/api/gates/update", wrap(s.handleUpdateGate))
	mux.HandleFunc("/api/gates/add", wrap(s.handleAddGate))
	mux.HandleFunc("/api/gates/remove", wrap(s.handleRemoveGate))
	mux.HandleFunc("/api/gates/provision", wrap(s.handleProvisionGate))
	mux.HandleFunc("/api/thresholds", wrap(s.handleThresholds))
	mux.HandleFunc("/api/gates/rules", wrap(s.handleGateRules))
	mux.HandleFunc("/api/sim/toggle", wrap(s.handleToggleSim))
	mux.HandleFunc("/api/sim/mode", wrap(s.handleSetSimMode))
	mux.HandleFunc("/api/sim/speed", wrap(s.handleSimSpeed))
	mux.HandleFunc("/api/sim/pack-burst", wrap(s.handlePackBurst))
	mux.HandleFunc("/api/sim/pilot-action", wrap(s.handleSimPilotAction))
	mux.HandleFunc("/api/sim/track-walker", wrap(s.handleSimTrackWalker))
	mux.HandleFunc("/api/sim/timer-action", wrap(s.handleSimTimerAction))
	mux.HandleFunc("/api/sim/timer-diag", s.handleSimTimerDiag)
	mux.HandleFunc("/api/sim/timer-rssi", s.handleSimTimerRSSI)
	mux.HandleFunc("/api/sim/usb-hellos", s.handleSimUSBHellos)
	mux.HandleFunc("/api/sim/laprf-action", wrap(s.handleSimLapRFAction))
	mux.HandleFunc("/api/sim/laprf-discover", s.handleSimLapRFDiscover)
	mux.HandleFunc("/api/sim/rh-action", wrap(s.handleSimRHAction))
	mux.HandleFunc("/api/sim/rh-discover", s.handleSimRHDiscover)
	mux.HandleFunc("/api/sim/mgp/", wrap(s.handleSimMultiGPWebService))
	mux.HandleFunc("/api/sim/mgp-admin", wrap(s.handleSimMultiGPAdmin))
	mux.HandleFunc("/api/hardware/mode", wrap(s.handleHardwareMode))
	mux.HandleFunc("/api/hardware/rh-debug-stream", s.handleRHDebugStream)
	mux.HandleFunc("/api/hardware/rh-scan", s.handleRHScan)
	mux.HandleFunc("/api/mgp-sync/import", wrap(s.handleMultiGPImportRace))
	mux.HandleFunc("/api/mgp-sync/import-pilots", wrap(s.handleMultiGPImportPilots))
	mux.HandleFunc("/api/mgp-sync/append-zippyq", wrap(s.handleMultiGPAppendZippyQ))
	mux.HandleFunc("/api/mgp-sync/plan", s.handleMultiGPSyncPlan)
	mux.HandleFunc("/api/mgp-sync/mark-synced", wrap(s.handleMultiGPMarkSynced))
	mux.HandleFunc("/api/session/reset", wrap(s.handleResetSession))
	mux.HandleFunc("/api/storage/reset", s.handleResetStorage)
	mux.HandleFunc("/api/storage/demo", s.handleRestoreDemoData)
	mux.HandleFunc("/api/storage/export", s.handleExportStorage)
	mux.HandleFunc("/api/storage/import", s.handleImportStorage)
	mux.HandleFunc("/api/storage/sim-export", s.handleExportSimStorage)
	mux.HandleFunc("/api/storage/sim-import", s.handleImportSimStorage)
}

// Handler builds the HTTP multiplexer for the application's `/api/*` routes.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	s.RegisterRoutes(mux)
	return mux
}

func (s *Server) buildFullStateResponse() FullStateResponse {
	eng := s.activeEngine()
	raceState := eng.RaceSnapshot()
	eventState := eng.EventSnapshot()
	practiceState := eng.PracticeSnapshot()
	pilots, gates, laps, crossings, summaries := eng.StateSnapshot()
	// Send [] (not null) when no track is set up, so clients can iterate without null checks.
	if gates == nil {
		gates = []domain.TrackGate{}
	}
	var simState *domain.SimState
	var simMGP *multigp.SimPersistedState
	if s.simulator.IsRunning() {
		snap := s.simulator.Snapshot()
		simState = &snap
		s.simulator.SyncMultiGPPilotPool()
		mgpExp := s.simulator.MultiGPBackend().ExportState()
		simMGP = &mgpExp
	}
	return FullStateResponse{
		ServerTimestampUs:  eng.NowUs(),
		TimingHardwareMode: eng.TimingHardwareMode(),
		Pilots:             pilots,
		Gates:              gates,
		Timers:             eng.DetectedTimersSnapshot(),
		Laps:               laps,
		Crossings:          crossings,
		Filtered:           eng.FilteredSnapshot(),
		Summaries:          summaries,
		Rules:              eng.Rules(),
		SimulatorRun:       s.simulator.IsRunning(),
		SimState:           simState,
		SimMultiGP:         simMGP,
		RaceArmed:          eng.IsRaceArmed(),
		LiveTimeStatus:     s.laprfServer.Status(),
		RaceState:          raceState,
		EventState:         eventState,
		PracticeState:      practiceState,
	}
}

func (s *Server) handleGetState(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleGetStatus(w http.ResponseWriter, r *http.Request) {
	eng := s.activeEngine()
	lite := r != nil && r.URL != nil && r.URL.Query().Get("lite") == "1"
	_, gates, _, _, _ := eng.StateSnapshot()
	if gates == nil {
		gates = []domain.TrackGate{}
	}
	var simState *domain.SimState
	var simMGP *multigp.SimPersistedState
	if s.simulator.IsRunning() {
		snap := s.simulator.Snapshot()
		simState = &snap
		mgpExp := s.simulator.MultiGPBackend().ExportState()
		simMGP = &mgpExp
	}
	resp := StatusResponse{
		ServerTimestampUs:  eng.NowUs(),
		TimingHardwareMode: eng.TimingHardwareMode(),
		Gates:              gates,
		Timers:             eng.DetectedTimersSnapshot(),
		SimulatorRun:       s.simulator.IsRunning(),
		SimState:           simState,
		SimMultiGP:         simMGP,
		RaceArmed:          eng.IsRaceArmed(),
		LiveTimeStatus:     s.laprfServer.Status(),
	}
	if !lite {
		raceState := eng.RaceSnapshot()
		eventState := eng.EventSnapshot()
		practiceState := eng.PracticeSnapshot()
		resp.RaceState = &raceState
		resp.EventState = &eventState
		resp.PracticeState = &practiceState
	}
	writeJSON(w, http.StatusOK, resp)
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
		if r.URL.Query().Get("retroactive") == "1" {
			eng.RecalculateBufferedPractice()
		}
		writeJSON(w, http.StatusOK, applied)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleToggleArm pauses / resumes local lap recording in SlapRF (while LapRF passthrough
// continues forwarding gate crossings whenever a LapRF host is connected and armed).
func (s *Server) handleToggleArm(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	eng := s.activeEngine()
	eng.SetRaceArmed(!eng.IsRaceArmed())
	if eng.IsRaceArmed() && s.hooks.OnTimingStarted != nil {
		s.hooks.OnTimingStarted()
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
	} else {
		if slot.Band == 0 {
			slot.Band = domain.BandRaceband
		}
		if freq := domain.FrequencyForBandChannel(slot.Band, slot.Channel); freq > 0 {
			slot.FrequencyMHz = freq
		}
	}
	if slot.ExitThreshold == 0 {
		slot.ExitThreshold = slot.EnterThreshold - 10.0
	} else if slot.ExitThreshold > slot.EnterThreshold-domain.MinHysteresisGapDb {
		slot.ExitThreshold = slot.EnterThreshold - domain.MinHysteresisGapDb
	}
	if err := s.activeEngine().UpdatePilotSlot(slot); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
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
	eng := s.activeEngine()
	if err := eng.SetGateThresholds(updates); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if r.URL.Query().Get("retroactive") == "1" {
		eng.RecalculateBufferedPractice()
	}
	s.handleGetState(w, r)
}

// handleGateRules sets one gate's timing-rule overrides across all pilots (`slotIndex == 0`) or
// for one specific pilot at that gate (`slotIndex >= 1`): `{gateId, slotIndex?, overrides: {...}}`.
// Omitted fields inherit from the parent tier; an empty overrides object clears that tier.
func (s *Server) handleGateRules(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		GateID      uint8                    `json:"gateId"`
		SlotIndex   int                      `json:"slotIndex,omitempty"`
		Overrides   domain.GateRuleOverrides `json:"overrides"`
		Retroactive bool                     `json:"retroactive,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	eng := s.activeEngine()
	var err error
	if body.SlotIndex > 0 {
		_, err = eng.SetPilotGateRules(body.GateID, body.SlotIndex, body.Overrides)
	} else {
		_, err = eng.SetGateRules(body.GateID, body.Overrides)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if body.Retroactive || r.URL.Query().Get("retroactive") == "1" {
		eng.RecalculateBufferedPractice()
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

func (s *Server) handleDeleteTimer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		TimerID uint8 `json:"timerId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var err error
	if s.simulator.IsRunning() {
		err = s.simulator.DeleteTimer(body.TimerID)
	} else {
		err = s.realEngine.DeleteDetectedTimer(body.TimerID)
	}
	if err != nil {
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
		Fingerprint string `json:"fingerprint,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	req := tracker.ProvisionRequest{
		Role:        body.Role,
		Label:       body.TimerLabel,
		Fingerprint: body.Fingerprint,
	}
	if _, err := s.activeEngine().ProvisionGate(req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
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
	if s.hooks.OnModeChanged != nil {
		s.hooks.OnModeChanged(next)
	}
	s.handleGetState(w, r)
}

func (s *Server) handleSetSimMode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Running bool `json:"running"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if s.simulator.IsRunning() != body.Running {
		s.simulator.SetRunning(body.Running)
		if s.hooks.OnModeChanged != nil {
			s.hooks.OnModeChanged(body.Running)
		}
	}
	s.handleGetState(w, r)
}

func (s *Server) handleSimTimerDiag(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		TimerID       uint8 `json:"timerId"`
		RFEnabled     bool  `json:"rfEnabled"`
		EmergencyMode bool  `json:"emergencyMode"`
		ScanLive      bool  `json:"scanLive"`
		ChanMask      uint8 `json:"chanMask"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.simulator.SetTimerDiagState(body.TimerID, body.RFEnabled, body.EmergencyMode, body.ScanLive, body.ChanMask)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleSimTimerRSSI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	tid, _ := strconv.Atoi(r.URL.Query().Get("timerId"))
	if tid <= 0 {
		writeJSON(w, http.StatusOK, map[string]any{"rssi": nil})
		return
	}
	rssi, ok := s.simulator.TimerRSSI(uint8(tid))
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"rssi": nil})
		return
	}
	out := make([]float32, len(rssi))
	copy(out, rssi[:])
	writeJSON(w, http.StatusOK, map[string]any{"rssi": out})
}

func (s *Server) handleSimUSBHellos(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	raw := s.simulator.BuildHubHelloStream()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.WriteHeader(http.StatusOK)
	if len(raw) > 0 {
		_, _ = w.Write(raw)
	}
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

func (s *Server) handleSimSpeed(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		SpeedMultiplier int `json:"speedMultiplier"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.simulator.SetSpeedMultiplier(body.SpeedMultiplier)
	s.handleGetState(w, r)
}

func (s *Server) handleSimTimerAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Action          string `json:"action"` // "toggle-power", "delete", "add", "reset-timers", "erase", "flash"
		TimerID         uint8  `json:"timerId,omitempty"`
		Role            string `json:"role,omitempty"`
		Label           string `json:"label,omitempty"`
		Fingerprint     string `json:"fingerprint,omitempty"`
		FirmwareVersion string `json:"firmwareVersion,omitempty"`
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
		if _, err := s.simulator.AddTimer(body.Role, body.Label); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	case "erase":
		if err := s.simulator.EraseBoard(body.TimerID); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	case "flash":
		if err := s.simulator.FlashBoard(body.TimerID, body.Role, body.Label, body.Fingerprint, body.FirmwareVersion); err != nil {
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

func (s *Server) handleExportRaceResultsCSV(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	raceID := r.URL.Query().Get("raceId")
	stageIdx := 0
	if rawStage := r.URL.Query().Get("stageIndex"); rawStage != "" {
		if parsed, err := strconv.Atoi(rawStage); err == nil && parsed >= 1 {
			stageIdx = parsed
		}
	}
	filename, csvBody, err := s.activeEngine().ExportRaceResultsCSV(raceID, stageIdx)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	_, _ = w.Write([]byte(csvBody))
}

func (s *Server) handleResetSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.activeEngine().ResetSession()
	if s.activeEngine().IsRaceArmed() && s.hooks.OnTimingStarted != nil {
		s.hooks.OnTimingStarted()
	}
	s.handleGetState(w, r)
}

func (s *Server) handleResetStorage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	wasRunning := s.simulator.IsRunning()
	s.simulator.ResetToFactoryDefaults()
	s.simulator.SetRunning(wasRunning)
	if s.realEngine != nil && s.realEngine != s.simEngine {
		s.realEngine.ResetToFactoryDefaults(false)
	}
	tracker.SyncBootTimes(s.simEngine, s.realEngine)
	if s.hooks.OnStorageReset != nil {
		s.hooks.OnStorageReset()
	}
	s.handleGetState(w, r)
}

func (s *Server) handleRestoreDemoData(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.activeEngine() == s.simEngine {
		wasRunning := s.simulator.IsRunning()
		s.simulator.RestoreDemoData()
		s.simulator.SetRunning(wasRunning)
	} else {
		s.activeEngine().RestoreDemoData()
	}
	tracker.SyncBootTimes(s.simEngine, s.realEngine)
	if s.hooks.OnStorageImport != nil {
		s.hooks.OnStorageImport()
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
	tracker.SyncBootTimes(s.simEngine, s.realEngine)
	if s.hooks.OnStorageImport != nil {
		s.hooks.OnStorageImport()
	}
	s.handleGetState(w, r)
}

func (s *Server) handleExportSimStorage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, SimBackendState{
		Engine:  s.simEngine.ExportState(),
		Options: s.simulator.ExportOptions(),
	})
}

func (s *Server) handleImportSimStorage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var state SimBackendState
	if err := json.NewDecoder(r.Body).Decode(&state); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if ingest.SimStateCompatible(state.Options) {
		wasRunning := s.simulator.IsRunning()
		s.simEngine.RestoreState(state.Engine, true)
		s.simulator.RestoreOptions(state.Options)
		s.simulator.SetRunning(wasRunning)
		tracker.SyncBootTimes(s.simEngine, s.realEngine)
	}
	if s.hooks.OnStorageImport != nil {
		s.hooks.OnStorageImport()
	}
	s.handleGetState(w, r)
}

func writeJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
