package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"slaprf/internal/applog"
	"slaprf/internal/domain"
	"slaprf/internal/ingest"
	"slaprf/internal/laprf"
	"slaprf/internal/multigp"
	"slaprf/internal/tracker"
)

// FullStateResponse is returned by `GET /v1/state` on initial SPA load and state mutations.
type FullStateResponse struct {
	ServerTimestampUs   uint64                        `json:"serverTimestampUs"`
	TimingHardwareMode  domain.TimingHardwareMode     `json:"timingHardwareMode"`
	Pilots              []domain.PilotSlot            `json:"pilots"`
	Gates               []domain.TrackGate            `json:"gates"`
	Timers              []domain.DetectedTimer        `json:"timers"`
	Laps                []domain.LapRecord            `json:"laps"`
	Crossings           []domain.GateCrossingEvent    `json:"crossings"`
	Filtered            []domain.FilteredDetection    `json:"filtered"`
	Summaries           []domain.PilotTrackSummary    `json:"summaries"`
	Rules               domain.TimingRules            `json:"rules"`
	SimulatorRun        bool                          `json:"simulatorRunning"`
	SimState            *domain.SimState              `json:"simState,omitempty"`
	SimMultiGP          *multigp.SimPersistedState    `json:"simMultiGP,omitempty"`
	RaceArmed           bool                          `json:"raceArmed"`
	LaprfEmulatorStatus laprf.EmulatorStatus          `json:"laprfEmulatorStatus"`
	RaceState           domain.RaceTournamentState    `json:"raceState"`
	EventState          domain.EventManagerState      `json:"eventState"`
	PracticeState       domain.PracticeManagerState   `json:"practiceState"`
	MLStatus            *domain.MLStatus              `json:"mlStatus,omitempty"`
	ImportSummary       *domain.PilotCSVImportSummary `json:"importSummary,omitempty"`
}

// StatusResponse is the lightweight payload polled by the SPA every few seconds
// (gate battery / link health, LapRF emulator connection, timing armed state).
type StatusResponse struct {
	ServerTimestampUs   uint64                        `json:"serverTimestampUs"`
	TimingHardwareMode  domain.TimingHardwareMode     `json:"timingHardwareMode"`
	Gates               []domain.TrackGate            `json:"gates"`
	Timers              []domain.DetectedTimer        `json:"timers"`
	SimulatorRun        bool                          `json:"simulatorRunning"`
	SimState            *domain.SimState              `json:"simState,omitempty"`
	SimMultiGP          *multigp.SimPersistedState    `json:"simMultiGP,omitempty"`
	RaceArmed           bool                          `json:"raceArmed"`
	LaprfEmulatorStatus laprf.EmulatorStatus          `json:"laprfEmulatorStatus"`
	RaceState           *domain.RaceTournamentState   `json:"raceState,omitempty"`
	EventState          *domain.EventManagerState     `json:"eventState,omitempty"`
	PracticeState       *domain.PracticeManagerState  `json:"practiceState,omitempty"`
	ImportSummary       *domain.PilotCSVImportSummary `json:"importSummary,omitempty"`
}

// RealBackendState is the real-world engine snapshot exchanged by `GET /v1/storage`
// and `PUT /v1/storage` (the "real" section of the app's JSON export file).
type RealBackendState struct {
	Engine tracker.PersistedEngineState `json:"engine"`
}

// SimBackendState is the simulated engine + simulator options snapshot exchanged by
// `GET /v1/storage/sim` and `PUT /v1/storage/sim`.
type SimBackendState struct {
	Engine  tracker.PersistedEngineState `json:"engine"`
	Options ingest.SimPersistedOptions   `json:"options"`
}

// ServerHooks allows a native host (e.g. `internal/portable` + `bbolt` persistence) to react
// immediately when REST requests mutate state, switch simulation mode, or reset/import storage.
type ServerHooks struct {
	OnMutation        func()
	OnModeChanged     func(simRunning bool)
	OnTimingStarted   func()
	OnStorageReset    func()
	OnStorageImport   func()
	OnLogLevelChanged func(level string)
}

// StreamEnvelope wraps a typed real-time message sent to the TypeScript SPA
// (delivered in-process by the WASM bridge's `onStream` callback or over `/v1/ws/stream`).
type StreamEnvelope struct {
	Type    string      `json:"type"` // "telemetry" | "crossing" | "filtered" | "lap" | "config" | "race" | "practice"
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
	appLog      *applog.Logger
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
	// The LapRF 8-Way emulation always serves whichever engine is active, whether the
	// simulator is updated via PATCH /v1/sim or directly (WASM bridge `setRunning`).
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

type statusCaptureWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusCaptureWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusCaptureWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

// RegisterRoutes attaches all core `/v1/*` resource routes onto `mux`, wrapping mutating handlers
// so registered `ServerHooks` are notified after successful mutations.
//
// Design conventions:
//   - Singleton resources (`/v1/storage`, `/v1/sim`, `/v1/timing/arm`, `/v1/timing/mode`,
//     `/v1/hardware/mode`) always exist and are never `DELETE`d; state replacement uses `PUT` / `PATCH`,
//     while imperative operations use AIP-136 `:action` custom methods (`POST /v1/storage:reset`).
//   - Collection resources (`/v1/pilots`, `/v1/timers`, `/v1/practice/sessions`, `/v1/race/sessions`)
//     and scoped track sub-resources (`/v1/{practice|race}/sessions/{sessionId}/track/*`) use `GET` (list),
//     `POST` (`201 Created` + `Location`), `GET /{id}`, `PUT`/`PATCH /{id}`, `DELETE /{id}`, and `:action`.
func (s *Server) RegisterRoutes(mux *http.ServeMux) {
	wrap := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			rec := &statusCaptureWriter{ResponseWriter: w}
			h(rec, r)
			code := rec.status
			if code == 0 {
				code = http.StatusOK
			}
			if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions && code >= 200 && code < 300 {
				if s.hooks.OnMutation != nil {
					s.hooks.OnMutation()
				}
			}
		}
	}

	// Read-only System Singletons & Snapshots
	mux.HandleFunc("GET /v1/version", s.handleGetVersion)
	mux.HandleFunc("GET /v1/state", s.handleGetState)
	mux.HandleFunc("GET /v1/status", s.handleGetStatus)

	// Timing Singletons (`arm`, `mode`)
	mux.HandleFunc("GET /v1/timing/arm", s.handleGetArm)
	mux.HandleFunc("PUT /v1/timing/arm", wrap(s.handlePutArm))
	mux.HandleFunc("GET /v1/timing/mode", s.handleGetOperatingMode)
	mux.HandleFunc("PUT /v1/timing/mode", wrap(s.handlePutOperatingMode))

	// Pilots Collection, Items & Custom Operations (`:reset`, `:import`)
	mux.HandleFunc("GET /v1/pilots", s.handleGetPilots)
	mux.HandleFunc("POST /v1/pilots", wrap(s.handleCreatePilot))
	mux.HandleFunc("POST /v1/pilots:reset", wrap(s.handleResetPilots))
	mux.HandleFunc("POST /v1/pilots:import", wrap(s.handleImportPilots))
	mux.HandleFunc("GET /v1/pilots/export.csv", s.handleExportPilotsCSV)
	mux.HandleFunc("GET /v1/pilots/{slotIndex}", s.handleGetPilot)
	mux.HandleFunc("PUT /v1/pilots/{slotIndex}", wrap(s.handleUpdatePilot))
	mux.HandleFunc("DELETE /v1/pilots/{slotIndex}", wrap(s.handleDeletePilot))

	// Physical / Simulated Timers Hardware Inventory (`/v1/timers`)
	mux.HandleFunc("GET /v1/timers", s.handleGetTimers)
	mux.HandleFunc("POST /v1/timers", wrap(s.handleCreateTimer))
	mux.HandleFunc("GET /v1/timers/{timerId}", s.handleGetTimer)
	mux.HandleFunc("PATCH /v1/timers/{timerId}", wrap(s.handlePatchTimer))
	mux.HandleFunc("DELETE /v1/timers/{timerId}", wrap(s.handleDeleteTimer))

	// Practice Sessions Resource Hierarchy (`/v1/practice/sessions`)
	mux.HandleFunc("POST /v1/practice:reset", wrap(s.handleResetActivePracticeLaps))
	mux.HandleFunc("PUT /v1/practice/pack-loop", wrap(s.handlePutPracticePackLoop))
	mux.HandleFunc("POST /v1/practice/pack-loop:split", wrap(s.handleSplitPracticePackLoop))
	mux.HandleFunc("GET /v1/practice/sessions", s.handleGetPracticeSessions)
	mux.HandleFunc("POST /v1/practice/sessions", wrap(s.handleCreatePracticeSession))
	mux.HandleFunc("GET /v1/practice/sessions/{sessionId}", s.handleGetPracticeSession)
	mux.HandleFunc("GET /v1/practice/sessions/{sessionId}/trace", s.handleGetPracticeSessionTrace)
	mux.HandleFunc("PATCH /v1/practice/sessions/{sessionId}", wrap(s.handlePatchPracticeSession))
	mux.HandleFunc("DELETE /v1/practice/sessions/{sessionId}", wrap(s.handleDeletePracticeSession))
	mux.HandleFunc("POST /v1/practice/sessions/{sessionId}", wrap(s.handlePracticeSessionCustomAction))
	mux.HandleFunc("GET /v1/practice/sessions/{sessionId}/pilots", s.handleGetPracticeSessionPilots)
	mux.HandleFunc("POST /v1/practice/sessions/{sessionId}/pilots", wrap(s.handleAddPracticeSessionPilot))
	mux.HandleFunc("PUT /v1/practice/sessions/{sessionId}/pilots/{slotIndex}", wrap(s.handleUpdatePracticeSessionPilot))
	mux.HandleFunc("PATCH /v1/practice/sessions/{sessionId}/pilots/{slotIndex}", wrap(s.handleUpdatePracticeSessionPilot))
	mux.HandleFunc("DELETE /v1/practice/sessions/{sessionId}/pilots/{slotIndex}", wrap(s.handleDeletePracticeSessionPilot))
	mux.HandleFunc("GET /v1/practice/sessions/{sessionId}/laps", s.handleGetPracticeSessionLaps)
	mux.HandleFunc("DELETE /v1/practice/sessions/{sessionId}/laps", wrap(s.handleDeletePracticeSessionLaps))
	mux.HandleFunc("PATCH /v1/practice/sessions/{sessionId}/laps/{lapId}", wrap(s.handlePatchPracticeSessionLap))
	mux.HandleFunc("DELETE /v1/practice/sessions/{sessionId}/laps/{lapId}", wrap(s.handleDeletePracticeSessionLap))
	mux.HandleFunc("POST /v1/practice/sessions/{sessionId}/laps/{lapId}", wrap(s.handlePracticeSessionLapCustomAction))
	mux.HandleFunc("POST /v1/practice/sessions/{sessionId}/crossings", wrap(s.handleAddPracticeSessionCrossing))
	mux.HandleFunc("PATCH /v1/practice/sessions/{sessionId}/crossings/{eventId}", wrap(s.handlePatchPracticeSessionCrossing))
	mux.HandleFunc("DELETE /v1/practice/sessions/{sessionId}/crossings/{eventId}", wrap(s.handleDeletePracticeSessionCrossing))
	mux.HandleFunc("POST /v1/practice/sessions/{sessionId}/breaks", wrap(s.handleAddPracticeSessionBreak))
	mux.HandleFunc("PATCH /v1/practice/sessions/{sessionId}/breaks/{breakId}", wrap(s.handlePatchPracticeSessionBreak))
	mux.HandleFunc("DELETE /v1/practice/sessions/{sessionId}/breaks/{breakId}", wrap(s.handleDeletePracticeSessionBreak))
	s.registerScopedTrackRoutes(mux, wrap, trackScopePractice)

	// Race Sessions Resource Hierarchy (`/v1/race/sessions` - symmetric with `/v1/practice/sessions`)
	mux.HandleFunc("GET /v1/race/sessions", s.handleGetRaceSessions)
	mux.HandleFunc("POST /v1/race/sessions", wrap(s.handleCreateRaceSession))
	mux.HandleFunc("POST /v1/race/sessions:importMultiGP", wrap(s.handleMultiGPImportRace))
	mux.HandleFunc("GET /v1/race/sessions/{sessionId}", s.handleGetRaceSession)
	mux.HandleFunc("PATCH /v1/race/sessions/{sessionId}", wrap(s.handlePatchRaceSession))
	mux.HandleFunc("DELETE /v1/race/sessions/{sessionId}", wrap(s.handleDeleteRaceSession))
	mux.HandleFunc("POST /v1/race/sessions/{sessionId}", wrap(s.handleRaceSessionCustomAction))
	mux.HandleFunc("GET /v1/race/sessions/{sessionId}/config", s.handleGetRaceSessionConfig)
	mux.HandleFunc("PUT /v1/race/sessions/{sessionId}/config", wrap(s.handlePutRaceSessionConfig))
	mux.HandleFunc("GET /v1/race/sessions/{sessionId}/pilots", s.handleGetRaceSessionPilots)
	mux.HandleFunc("POST /v1/race/sessions/{sessionId}/pilots", wrap(s.handleAddRaceSessionPilot))
	mux.HandleFunc("POST /v1/race/sessions/{sessionId}/pilots:checkInAll", wrap(s.handleCheckInAllRaceSessionPilots))
	mux.HandleFunc("PATCH /v1/race/sessions/{sessionId}/pilots/{slotIndex}", wrap(s.handlePatchRaceSessionPilot))
	mux.HandleFunc("POST /v1/race/sessions/{sessionId}/stages/{stageRef}", wrap(s.handleRaceSessionStageCustomAction))
	mux.HandleFunc("POST /v1/race/sessions/{sessionId}/bracket:edit", wrap(s.handleEditRaceSessionBracket))
	mux.HandleFunc("POST /v1/race/sessions/{sessionId}/heats/{heatId}", wrap(s.handleRaceSessionHeatCustomAction))
	mux.HandleFunc("POST /v1/race/sessions/{sessionId}/heats/{heatId}/pilots/{slotIndex}", wrap(s.handleRaceSessionHeatPilotCustomAction))
	mux.HandleFunc("POST /v1/race/sessions/{sessionId}/crossings", wrap(s.handleAddRaceSessionCrossing))
	mux.HandleFunc("PATCH /v1/race/sessions/{sessionId}/crossings/{eventId}", wrap(s.handlePatchRaceSessionCrossing))
	mux.HandleFunc("DELETE /v1/race/sessions/{sessionId}/crossings/{eventId}", wrap(s.handleDeleteRaceSessionCrossing))
	mux.HandleFunc("GET /v1/race/sessions/{sessionId}/standings.csv", s.handleExportRaceSessionStandingsCSV)
	s.registerScopedTrackRoutes(mux, wrap, trackScopeRace)
	mux.HandleFunc("GET /v1/race/standings.csv", s.handleExportRaceResultsCSV)
	mux.HandleFunc("GET /v1/race/clock", s.handleGetRaceClock)

	// Race MultiGP Sync Resources
	mux.HandleFunc("POST /v1/race/sessions/{sessionId}/multigp:appendZippyQ", wrap(s.handleMultiGPAppendZippyQ))
	mux.HandleFunc("GET /v1/race/sessions/{sessionId}/multigp/sync-plan", s.handleMultiGPSyncPlan)
	mux.HandleFunc("PUT /v1/race/sessions/{sessionId}/multigp/sync-state", wrap(s.handleMultiGPMarkSynced))

	// Hardware Mode Singleton & RotorHazard Debug Stream Singleton
	mux.HandleFunc("GET /v1/hardware/mode", s.handleGetHardwareMode)
	mux.HandleFunc("PUT /v1/hardware/mode", wrap(s.handlePutHardwareMode))
	mux.HandleFunc("PUT /v1/rotorhazard/connections/{timerId}/debug-stream", s.handlePutRHDebugStream)

	// Simulator Singleton & Sub-resources (`/v1/sim`, `/v1/sim/slaprf/*`, `/v1/sim/laprf/*`, `/v1/sim/rotorhazard/*`, `/v1/sim/multigp/*`)
	mux.HandleFunc("GET /v1/sim", s.handleGetSim)
	mux.HandleFunc("PATCH /v1/sim", wrap(s.handlePatchSim))
	mux.HandleFunc("POST /v1/sim:packBurst", wrap(s.handleSimPackBurst))
	mux.HandleFunc("POST /v1/sim/pilots/{slotIndex}", wrap(s.handleSimPilotCustomAction))
	mux.HandleFunc("GET /v1/sim/slaprf/usb-hellos", s.handleSimUSBHellos)
	mux.HandleFunc("POST /v1/sim/slaprf/timers", wrap(s.handleCreateSimTimer))
	mux.HandleFunc("POST /v1/sim/slaprf/timers:reset", wrap(s.handleResetSimTimers))
	mux.HandleFunc("PATCH /v1/sim/slaprf/timers/{timerId}", wrap(s.handlePatchSimTimer))
	mux.HandleFunc("POST /v1/sim/slaprf/timers/{timerId}", wrap(s.handleSimTimerCustomAction))
	mux.HandleFunc("DELETE /v1/sim/slaprf/timers/{timerId}", wrap(s.handleDeleteSimTimer))
	mux.HandleFunc("GET /v1/sim/slaprf/timers/{timerId}/rssi", s.handleGetSimTimerRSSI)
	mux.HandleFunc("GET /v1/sim/laprf/devices", s.handleSimLapRFDiscover)
	mux.HandleFunc("POST /v1/sim/laprf/timers", wrap(s.handleCreateSimLapRFUnit))
	mux.HandleFunc("POST /v1/sim/laprf/timers:reset", wrap(s.handleResetSimLapRFUnits))
	mux.HandleFunc("PATCH /v1/sim/laprf/timers/{timerId}", wrap(s.handlePatchSimLapRFUnit))
	mux.HandleFunc("POST /v1/sim/laprf/timers/{timerId}", wrap(s.handleSimLapRFUnitCustomAction))
	mux.HandleFunc("DELETE /v1/sim/laprf/timers/{timerId}", wrap(s.handleDeleteSimLapRFUnit))
	mux.HandleFunc("GET /v1/sim/rotorhazard/devices", s.handleSimRHDiscover)
	mux.HandleFunc("POST /v1/sim/rotorhazard/timers", wrap(s.handleCreateSimRHUnit))
	mux.HandleFunc("POST /v1/sim/rotorhazard/timers:reset", wrap(s.handleResetSimRHUnits))
	mux.HandleFunc("PATCH /v1/sim/rotorhazard/timers/{timerId}", wrap(s.handlePatchSimRHUnit))
	mux.HandleFunc("POST /v1/sim/rotorhazard/timers/{timerId}", wrap(s.handleSimRHUnitCustomAction))
	mux.HandleFunc("DELETE /v1/sim/rotorhazard/timers/{timerId}", wrap(s.handleDeleteSimRHUnit))
	mux.HandleFunc("GET /v1/sim/multigp/admin", s.handleGetSimMultiGPAdmin)
	mux.HandleFunc("POST /v1/sim/multigp/admin:action", wrap(s.handleSimMultiGPAdminAction))
	mux.HandleFunc("POST /v1/sim/multigp/{subPath...}", wrap(s.handleSimMultiGPWebService))
	mux.HandleFunc("PUT /v1/sim/multigp/{subPath...}", wrap(s.handleSimMultiGPWebService))

	// Storage Singletons (`/v1/storage` & `/v1/storage/sim`) + Custom Operations (`:reset`, `:restoreDemo`)
	mux.HandleFunc("GET /v1/storage", s.handleExportStorage)
	mux.HandleFunc("PUT /v1/storage", s.handleImportStorage)
	mux.HandleFunc("POST /v1/storage:reset", s.handleResetStorage)
	mux.HandleFunc("POST /v1/storage:restoreDemo", s.handleRestoreDemoData)
	mux.HandleFunc("GET /v1/storage/sim", s.handleExportSimStorage)
	mux.HandleFunc("PUT /v1/storage/sim", s.handleImportSimStorage)

	// On-Device AI Crossing Detector, System 1 Teacher & Training (`/v1/ml`, `/v1/ml:train`, `/v1/ml/teacher*`, `/v1/ml/sessions/{sessionId}:label`, `/v1/ml/models/{modelId}`, `/v1/ml/dataset.tar.gz`, `/v1/ml/dataset:import`)
	mux.HandleFunc("GET /v1/ml", s.handleGetMLStatus)
	mux.HandleFunc("PATCH /v1/ml", wrap(s.handlePatchMLConfig))
	mux.HandleFunc("POST /v1/ml:train", wrap(s.handleStartMLTraining))
	mux.HandleFunc("POST /v1/ml:cancel", wrap(s.handleCancelMLTraining))
	mux.HandleFunc("GET /v1/ml/teacher", s.handleGetMLTeacher)
	mux.HandleFunc("POST /v1/ml/teacher:download", wrap(s.handleDownloadMLTeacher))
	mux.HandleFunc("POST /v1/ml/teacher:cancel", wrap(s.handleCancelMLTeacher))
	mux.HandleFunc("DELETE /v1/ml/teacher/{packId}", wrap(s.handleDeleteMLTeacherPack))
	mux.HandleFunc("POST /v1/ml/sessions/{sessionId}", wrap(s.handleMLSessionCustomAction))
	mux.HandleFunc("POST /v1/ml/models", wrap(s.handleCreateMLModel))
	mux.HandleFunc("PATCH /v1/ml/models/{modelId}", wrap(s.handlePatchMLModel))
	mux.HandleFunc("DELETE /v1/ml/models/{modelId}", wrap(s.handleDeleteMLModel))
	mux.HandleFunc("GET /v1/ml/dataset.tar.gz", s.handleExportMLDataset)
	mux.HandleFunc("POST /v1/ml/dataset:import", wrap(s.handleImportMLDataset))

	// Diagnostic Logs (`/v1/logs`, `/v1/logs/config`, `/v1/logs:clear`) — shared across Go Server & Browser WASM
	mux.HandleFunc("GET /v1/logs", s.handleLogsGet)
	mux.HandleFunc("GET /v1/logs/config", s.handleGetLogsConfig)
	mux.HandleFunc("PUT /v1/logs/config", s.handlePutLogsConfig)
	mux.HandleFunc("POST /v1/logs:clear", s.handleLogsClear)
}

// Handler builds the HTTP multiplexer for the application's `/v1/*` routes.
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
	mlStatus := eng.MLStatus()
	return FullStateResponse{
		ServerTimestampUs:   eng.NowUs(),
		TimingHardwareMode:  eng.TimingHardwareMode(),
		Pilots:              pilots,
		Gates:               gates,
		Timers:              eng.DetectedTimersSnapshot(),
		Laps:                laps,
		Crossings:           crossings,
		Filtered:            eng.FilteredSnapshot(),
		Summaries:           summaries,
		Rules:               eng.Rules(),
		SimulatorRun:        s.simulator.IsRunning(),
		SimState:            simState,
		SimMultiGP:          simMGP,
		RaceArmed:           eng.IsRaceArmed(),
		LaprfEmulatorStatus: s.laprfServer.Status(),
		RaceState:           raceState,
		EventState:          eventState,
		PracticeState:       practiceState,
		MLStatus:            &mlStatus,
	}
}

func (s *Server) handleGetState(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) buildStatusResponse(lite bool) StatusResponse {
	eng := s.activeEngine()
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
		ServerTimestampUs:   eng.NowUs(),
		TimingHardwareMode:  eng.TimingHardwareMode(),
		Gates:               gates,
		Timers:              eng.DetectedTimersSnapshot(),
		SimulatorRun:        s.simulator.IsRunning(),
		SimState:            simState,
		SimMultiGP:          simMGP,
		RaceArmed:           eng.IsRaceArmed(),
		LaprfEmulatorStatus: s.laprfServer.Status(),
	}
	if !lite {
		raceState := eng.RaceSnapshot()
		eventState := eng.EventSnapshot()
		practiceState := eng.PracticeSnapshot()
		resp.RaceState = &raceState
		resp.EventState = &eventState
		resp.PracticeState = &practiceState
	}
	return resp
}

func (s *Server) handleGetStatus(w http.ResponseWriter, r *http.Request) {
	lite := r != nil && r.URL != nil && r.URL.Query().Get("lite") == "1"
	writeJSON(w, http.StatusOK, s.buildStatusResponse(lite))
}

// --- Timing Singletons (`/v1/timing/arm`, `/v1/timing/mode`) ---

func (s *Server) handleGetArm(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"armed": s.activeEngine().IsRaceArmed()})
}

func (s *Server) handlePutArm(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Armed *bool `json:"armed"`
	}
	if err := decodeJSONBody(r, &body); err != nil || body.Armed == nil {
		writeErrorJSON(w, http.StatusBadRequest, "request body must specify boolean field 'armed'")
		return
	}
	eng := s.activeEngine()
	wasArmed := eng.IsRaceArmed()
	eng.SetRaceArmed(*body.Armed)
	if wasArmed != *body.Armed {
		s.logUserAction("Timing", "Timing armed=%v", *body.Armed)
	}
	if !wasArmed && *body.Armed && s.hooks.OnTimingStarted != nil {
		s.hooks.OnTimingStarted()
	}
	writeJSON(w, http.StatusOK, s.buildStatusResponse(false))
}

func (s *Server) handleGetOperatingMode(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]domain.OperatingMode{"mode": s.activeEngine().OperatingMode()})
}

func (s *Server) handlePutOperatingMode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode domain.OperatingMode `json:"mode"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.Mode != domain.ModePractice && body.Mode != domain.ModeRace {
		writeErrorJSON(w, http.StatusBadRequest, "mode must be 'practice' or 'race'")
		return
	}
	prev := s.activeEngine().OperatingMode()
	s.activeEngine().SetOperatingMode(body.Mode)
	if prev != body.Mode {
		s.logUserAction("Timing", "Operating mode changed from %s to %s", prev, body.Mode)
	}
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

// --- Gate Rule Overrides Decoder & Timers Hardware Inventory (`/v1/timers`) ---

func decodeGateRuleOverrides(r *http.Request) (domain.GateRuleOverrides, error) {
	rawBytes, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return domain.GateRuleOverrides{}, err
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(rawBytes, &probe); err != nil {
		return domain.GateRuleOverrides{}, err
	}
	if nested, hasNested := probe["overrides"]; hasNested {
		var ov domain.GateRuleOverrides
		if err := json.Unmarshal(nested, &ov); err != nil {
			return domain.GateRuleOverrides{}, err
		}
		return ov, nil
	}
	var ov domain.GateRuleOverrides
	if err := json.Unmarshal(rawBytes, &ov); err != nil {
		return domain.GateRuleOverrides{}, err
	}
	return ov, nil
}

func (s *Server) handleGetTimers(w http.ResponseWriter, _ *http.Request) {
	timers := s.activeEngine().DetectedTimersSnapshot()
	if timers == nil {
		timers = []domain.DetectedTimer{}
	}
	writeJSON(w, http.StatusOK, timers)
}

func (s *Server) handleGetTimer(w http.ResponseWriter, r *http.Request) {
	timerID, ok := parseUint8PathValue(w, r, "timerId")
	if !ok {
		return
	}
	for _, t := range s.activeEngine().DetectedTimersSnapshot() {
		if t.TimerID == timerID {
			writeJSON(w, http.StatusOK, t)
			return
		}
	}
	writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("timer %d not found", timerID))
}

func (s *Server) handleCreateTimer(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Role        string `json:"role"`
		TimerLabel  string `json:"timerLabel"`
		Fingerprint string `json:"fingerprint,omitempty"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	id, err := s.activeEngine().ProvisionGate(tracker.ProvisionRequest{
		Role:        body.Role,
		Label:       body.TimerLabel,
		Fingerprint: body.Fingerprint,
	})
	if err != nil {
		writeEngineError(w, err)
		return
	}
	s.logUserAction("Timers", "Provisioned timer #%d (role=%s, label=%q, fp=%s)", id, body.Role, body.TimerLabel, body.Fingerprint)
	w.Header().Set("Location", fmt.Sprintf("/v1/timers/%d", id))
	writeJSON(w, http.StatusCreated, s.buildFullStateResponse())
}

func (s *Server) handlePatchTimer(w http.ResponseWriter, r *http.Request) {
	timerID, ok := parseUint8PathValue(w, r, "timerId")
	if !ok {
		return
	}
	var body struct {
		Color string `json:"color"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.activeEngine().SetTimerColor(timerID, body.Color); err != nil {
		writeEngineError(w, err)
		return
	}
	s.logUserAction("Timers", "Updated timer #%d color=%s", timerID, body.Color)
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleDeleteTimer(w http.ResponseWriter, r *http.Request) {
	timerID, ok := parseUint8PathValue(w, r, "timerId")
	if !ok {
		return
	}
	exists := false
	for _, t := range s.activeEngine().DetectedTimersSnapshot() {
		if t.TimerID == timerID {
			exists = true
			break
		}
	}
	if !exists && s.simulator.IsRunning() {
		for _, st := range s.simulator.Snapshot().Timers {
			if st.TimerID == timerID {
				exists = true
				break
			}
		}
	}
	if !exists {
		writeErrorJSON(w, http.StatusNotFound, fmt.Sprintf("timer %d not found", timerID))
		return
	}
	var err error
	if s.simulator.IsRunning() {
		err = s.simulator.DismissDisconnectedTimer(timerID)
	} else {
		if s.realEngine.IsTimerActivelyOnline(timerID) {
			err = tracker.ErrTimerStillActive
		} else {
			err = s.realEngine.DeleteDetectedTimer(timerID)
		}
	}
	if err != nil {
		writeEngineError(w, err)
		return
	}
	s.logUserAction("Timers", "Deleted timer #%d", timerID)
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

// --- Storage Singletons & Custom Operations (`/v1/storage`, `/v1/storage:reset`, `/v1/storage:restoreDemo`) ---

func (s *Server) handleResetStorage(w http.ResponseWriter, r *http.Request) {
	if err := decodeOptionalJSONBody(r, &struct{}{}); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
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
	s.logUserAction("Storage", "Wiped application data and restored factory defaults")
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleRestoreDemoData(w http.ResponseWriter, r *http.Request) {
	if err := decodeOptionalJSONBody(r, &struct{}{}); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
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
	s.logUserAction("Storage", "Restored showcase demo dataset")
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleExportStorage(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, RealBackendState{
		Engine: s.realEngine.ExportState(),
	})
}

func (s *Server) handleImportStorage(w http.ResponseWriter, r *http.Request) {
	var state RealBackendState
	if err := decodeJSONBody(r, &state); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	s.realEngine.RestoreState(state.Engine, false)
	tracker.SyncBootTimes(s.simEngine, s.realEngine)
	if s.hooks.OnStorageImport != nil {
		s.hooks.OnStorageImport()
	}
	s.logRealAction("Storage", "Imported real-hardware application data backup")
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

func (s *Server) handleExportSimStorage(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, SimBackendState{
		Engine:  s.simEngine.ExportState(),
		Options: s.simulator.ExportOptions(),
	})
}

func (s *Server) handleImportSimStorage(w http.ResponseWriter, r *http.Request) {
	var state SimBackendState
	if err := decodeJSONBody(r, &state); err != nil {
		writeErrorJSON(w, http.StatusBadRequest, err.Error())
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
	s.logSimAction("Storage", "Imported simulator application data backup")
	writeJSON(w, http.StatusOK, s.buildFullStateResponse())
}

// --- Shared HTTP / AIP-136 `:action` / Error Helpers ---

func decodeJSONBody(r *http.Request, dst any) error {
	if r == nil || r.Body == nil {
		return errors.New("request body is required")
	}
	dec := json.NewDecoder(io.LimitReader(r.Body, 8<<20))
	return dec.Decode(dst)
}

func decodeOptionalJSONBody(r *http.Request, dst any) error {
	if r == nil || r.Body == nil {
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil {
		return err
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil
	}
	return json.Unmarshal(raw, dst)
}

// rejectColonInPathValue rejects accidental `:action` suffixes on GET/PUT/PATCH/DELETE item routes,
// returning `405 Method Not Allowed` with `Allow: POST` when `raw` carries a `:verb` suffix.
func rejectColonInPathValue(w http.ResponseWriter, raw string) bool {
	if idx := strings.IndexByte(raw, ':'); idx >= 0 {
		if strings.TrimSpace(raw[idx+1:]) != "" {
			w.Header().Set("Allow", "POST")
			writeErrorJSON(w, http.StatusMethodNotAllowed, "custom ':action' methods require HTTP POST")
		} else {
			writeErrorJSON(w, http.StatusBadRequest, "empty custom method after ':'")
		}
		return false
	}
	return true
}

// cutCustomActionPathValue splits `{param}:{action}` for `POST` custom methods on item resources.
// If no `:` is present, it responds with `405 Method Not Allowed` (setting `Allow` to `itemAllowMethods`
// when non-empty) because `POST` on an item URL without `:action` is not valid REST CRUD.
func cutCustomActionPathValue(w http.ResponseWriter, r *http.Request, param string, itemAllowMethods string) (string, string, bool) {
	raw := strings.TrimSpace(r.PathValue(param))
	id, action, hasColon := strings.Cut(raw, ":")
	if !hasColon {
		if itemAllowMethods != "" {
			w.Header().Set("Allow", itemAllowMethods)
		}
		writeErrorJSON(w, http.StatusMethodNotAllowed, "POST on an item resource requires a ':action' custom method")
		return "", "", false
	}
	id = strings.TrimSpace(id)
	action = strings.TrimSpace(action)
	if id == "" || action == "" {
		writeErrorJSON(w, http.StatusBadRequest, fmt.Sprintf("invalid custom method target %q", raw))
		return "", "", false
	}
	return id, action, true
}

func parsePositiveIntString(w http.ResponseWriter, label string, raw string) (int, bool) {
	val, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || val <= 0 {
		writeErrorJSON(w, http.StatusBadRequest, fmt.Sprintf("invalid %s %q", label, raw))
		return 0, false
	}
	return val, true
}

func parseUint8String(w http.ResponseWriter, label string, raw string) (uint8, bool) {
	val, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || val <= 0 || val > 255 {
		writeErrorJSON(w, http.StatusBadRequest, fmt.Sprintf("invalid %s %q", label, raw))
		return 0, false
	}
	return uint8(val), true
}

func parsePositiveIntPathValue(w http.ResponseWriter, r *http.Request, name string) (int, bool) {
	raw := strings.TrimSpace(r.PathValue(name))
	if !rejectColonInPathValue(w, raw) {
		return 0, false
	}
	return parsePositiveIntString(w, name, raw)
}

func parseUint8PathValue(w http.ResponseWriter, r *http.Request, name string) (uint8, bool) {
	raw := strings.TrimSpace(r.PathValue(name))
	if !rejectColonInPathValue(w, raw) {
		return 0, false
	}
	return parseUint8String(w, name, raw)
}

func parseUint64PathValue(w http.ResponseWriter, r *http.Request, name string) (uint64, bool) {
	raw := strings.TrimSpace(r.PathValue(name))
	if !rejectColonInPathValue(w, raw) {
		return 0, false
	}
	val, err := strconv.ParseUint(raw, 10, 64)
	if err != nil || val == 0 {
		writeErrorJSON(w, http.StatusBadRequest, fmt.Sprintf("invalid %s %q", name, raw))
		return 0, false
	}
	return val, true
}

func statusForEngineError(err error) int {
	if err == nil {
		return http.StatusOK
	}
	if errors.Is(err, tracker.ErrUnknownGate) || errors.Is(err, tracker.ErrUnknownPilot) ||
		errors.Is(err, tracker.ErrPracticeNotFound) || errors.Is(err, tracker.ErrRaceNotFound) {
		return http.StatusNotFound
	}
	if errors.Is(err, tracker.ErrMinOneGate) || errors.Is(err, tracker.ErrHubExists) ||
		errors.Is(err, tracker.ErrRaceTrackReadOnly) {
		return http.StatusConflict
	}
	lower := strings.ToLower(err.Error())
	if strings.Contains(lower, "not found") ||
		strings.HasPrefix(lower, "unknown gate") ||
		strings.Contains(lower, "is not in this session") ||
		strings.Contains(lower, "is not in heat") {
		return http.StatusNotFound
	}
	if strings.Contains(lower, "already exists") ||
		strings.Contains(lower, "already in use") ||
		strings.Contains(lower, "already has counted heats") ||
		strings.Contains(lower, "at least 2 pilots") ||
		strings.Contains(lower, "at least one gate") ||
		strings.Contains(lower, "cannot delete") ||
		strings.Contains(lower, "started round") ||
		strings.Contains(lower, "is ongoing") ||
		strings.Contains(lower, "is active") ||
		strings.Contains(lower, "confirm preemption") ||
		strings.Contains(lower, "pause it first") ||
		strings.Contains(lower, "pause or complete") ||
		strings.Contains(lower, "unlock confirmed heat") ||
		strings.Contains(lower, "-heat limit") {
		return http.StatusConflict
	}
	return http.StatusBadRequest
}

func writeEngineError(w http.ResponseWriter, err error) {
	writeErrorJSON(w, statusForEngineError(err), err.Error())
}

func writeErrorJSON(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": strings.TrimSpace(msg)})
}

func writeJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
