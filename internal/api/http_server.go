package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"path/filepath"
	"strconv"

	"github.com/evanw/esbuild/pkg/api"

	"slaprf/internal/domain"
	"slaprf/internal/firmware"
	"slaprf/internal/ingest"
	"slaprf/internal/laprf"
	"slaprf/internal/tracker"
)

// FullStateResponse is returned by `GET /api/state` on initial SPA load.
type FullStateResponse struct {
	ServerTimestampUs uint64                     `json:"serverTimestampUs"`
	Pilots            []domain.PilotSlot         `json:"pilots"`
	Pucks             []domain.GatePuck          `json:"pucks"`
	DetectedPucks     []domain.DetectedPuck      `json:"detectedPucks"`
	Laps              []domain.LapRecord         `json:"laps"`
	Crossings         []domain.GateCrossingEvent `json:"crossings"`
	Filtered          []domain.FilteredDetection `json:"filtered"`
	Summaries         []domain.PilotTrackSummary `json:"summaries"`
	Rules             domain.TimingRules         `json:"rules"`
	SimulatorRun      bool                       `json:"simulatorRunning"`
	RaceArmed         bool                       `json:"raceArmed"`
	LiveTimeStatus    laprf.LiveTimeStatus       `json:"liveTimeStatus"`
}

// StatusResponse is the lightweight payload polled by the SPA every few seconds
// (gate battery / link health, LiveTime connection, timing armed state).
type StatusResponse struct {
	ServerTimestampUs uint64                `json:"serverTimestampUs"`
	Pucks             []domain.GatePuck     `json:"pucks"`
	DetectedPucks     []domain.DetectedPuck `json:"detectedPucks"`
	SimulatorRun      bool                  `json:"simulatorRunning"`
	RaceArmed         bool                  `json:"raceArmed"`
	LiveTimeStatus    laprf.LiveTimeStatus  `json:"liveTimeStatus"`
}

// Server wires HTTP routes, the SSE streaming hub, and the pure-Go TypeScript bundler.
// It maintains two completely isolated timing engines (`simEngine` for the built-in track
// simulator and `realEngine` for physical XIAO ESP32-C5 hardware) so simulated timers,
// gates, pilots, rules, and laps never mix with real-world data.
type Server struct {
	simEngine   *tracker.Engine
	realEngine  *tracker.Engine
	simulator   *ingest.TrackSimulator
	laprfServer *laprf.Server
	sseHub      *SSEHub
	webRootDir  string
}

type gatedEventSubscriber struct {
	allow func() bool
	next  tracker.EventSubscriber
}

func (g *gatedEventSubscriber) OnTelemetryFrame(frame domain.PuckTelemetryFrame) {
	if g.allow() {
		g.next.OnTelemetryFrame(frame)
	}
}
func (g *gatedEventSubscriber) OnGateCrossing(event domain.GateCrossingEvent) {
	if g.allow() {
		g.next.OnGateCrossing(event)
	}
}
func (g *gatedEventSubscriber) OnDetectionFiltered(f domain.FilteredDetection) {
	if g.allow() {
		g.next.OnDetectionFiltered(f)
	}
}
func (g *gatedEventSubscriber) OnLapCompleted(lap domain.LapRecord, summaries []domain.PilotTrackSummary) {
	if g.allow() {
		g.next.OnLapCompleted(lap, summaries)
	}
}
func (g *gatedEventSubscriber) OnConfigUpdated(pilots []domain.PilotSlot, pucks []domain.GatePuck) {
	if g.allow() {
		g.next.OnConfigUpdated(pilots, pucks)
	}
}

// NewServer creates the HTTP and SSE server with separate simulation and real-world engines.
func NewServer(
	simEngine *tracker.Engine,
	simulator *ingest.TrackSimulator,
	laprfServer *laprf.Server,
	webRootDir string,
	realEngines ...*tracker.Engine,
) *Server {
	var realEngine *tracker.Engine
	if len(realEngines) > 0 && realEngines[0] != nil {
		realEngine = realEngines[0]
	} else {
		realEngine = tracker.NewRealEngine()
	}

	hub := NewSSEHub()
	simEngine.Subscribe(&gatedEventSubscriber{
		allow: func() bool { return simulator.IsRunning() },
		next:  hub,
	})
	realEngine.Subscribe(&gatedEventSubscriber{
		allow: func() bool { return !simulator.IsRunning() },
		next:  hub,
	})

	s := &Server{
		simEngine:   simEngine,
		realEngine:  realEngine,
		simulator:   simulator,
		laprfServer: laprfServer,
		sseHub:      hub,
		webRootDir:  webRootDir,
	}
	laprfServer.SetEngine(s.activeEngine())
	return s
}

func (s *Server) activeEngine() *tracker.Engine {
	if s.simulator.IsRunning() {
		return s.simEngine
	}
	return s.realEngine
}

// Handler builds the HTTP multiplexer for the application.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Real-time 50 Hz SSE stream
	mux.Handle("/api/stream", s.sseHub)

	// REST API endpoints
	mux.HandleFunc("/api/state", s.handleGetState)
	mux.HandleFunc("/api/status", s.handleGetStatus)
	mux.HandleFunc("/api/rules", s.handleRules)
	mux.HandleFunc("/api/timing/toggle-arm", s.handleToggleArm)
	mux.HandleFunc("/api/pilots/update", s.handleUpdatePilot)
	mux.HandleFunc("/api/track/update", s.handleUpdateGate)
	mux.HandleFunc("/api/track/add", s.handleAddGate)
	mux.HandleFunc("/api/track/remove", s.handleRemoveGate)
	mux.HandleFunc("/api/track/rules", s.handleGateRules)
	mux.HandleFunc("/api/timers/provision", s.handleProvisionGate)
	mux.HandleFunc("/api/timers/color", s.handleUpdatePuckColor)

	// Legacy aliases
	mux.HandleFunc("/api/gates/update", s.handleUpdateGate)
	mux.HandleFunc("/api/gates/add", s.handleAddGate)
	mux.HandleFunc("/api/gates/remove", s.handleRemoveGate)
	mux.HandleFunc("/api/gates/provision", s.handleProvisionGate)
	mux.HandleFunc("/api/pucks/color", s.handleUpdatePuckColor)
	mux.HandleFunc("/api/firmware/xiao-c5.bin", s.handleFirmwareImage)
	mux.HandleFunc("/api/wifi/networks", s.handleWifiNetworks)
	mux.HandleFunc("/api/thresholds", s.handleThresholds)
	mux.HandleFunc("/api/gates/rules", s.handleGateRules)
	mux.HandleFunc("/api/sim/toggle", s.handleToggleSim)
	mux.HandleFunc("/api/sim/pack-burst", s.handlePackBurst)
	mux.HandleFunc("/api/session/reset", s.handleResetSession)
	mux.HandleFunc("/api/ingest/frame", s.handleIngestFrame)

	// Zero-Node.js pure-Go TypeScript bundle endpoint
	mux.HandleFunc("/dist/app.js", s.handleTypeScriptBundle)

	// Static assets (HTML + CSS)
	fs := http.FileServer(http.Dir(s.webRootDir))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		fs.ServeHTTP(w, r)
	})

	return mux
}

func (s *Server) handleGetState(w http.ResponseWriter, r *http.Request) {
	eng := s.activeEngine()
	pilots, pucks, laps, crossings, summaries := eng.StateSnapshot()
	resp := FullStateResponse{
		ServerTimestampUs: eng.NowUs(),
		Pilots:            pilots,
		Pucks:             pucks,
		DetectedPucks:     eng.DetectedPucksSnapshot(),
		Laps:              laps,
		Crossings:         crossings,
		Filtered:          eng.FilteredSnapshot(),
		Summaries:         summaries,
		Rules:             eng.Rules(),
		SimulatorRun:      s.simulator.IsRunning(),
		RaceArmed:         eng.IsRaceArmed(),
		LiveTimeStatus:    s.laprfServer.Status(),
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleGetStatus(w http.ResponseWriter, _ *http.Request) {
	eng := s.activeEngine()
	_, pucks, _, _, _ := eng.StateSnapshot()
	writeJSON(w, http.StatusOK, StatusResponse{
		ServerTimestampUs: eng.NowUs(),
		Pucks:             pucks,
		DetectedPucks:     eng.DetectedPucksSnapshot(),
		SimulatorRun:      s.simulator.IsRunning(),
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
		writeJSON(w, http.StatusOK, eng.SetRules(rules))
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
	if slot.Channel >= 1 && slot.Channel <= 8 && slot.Band == domain.BandRaceband {
		slot.FrequencyMHz = domain.RacebandFrequenciesMHz[slot.Channel-1]
	}
	if slot.ExitThreshold == 0 || slot.ExitThreshold >= slot.EnterThreshold {
		slot.ExitThreshold = slot.EnterThreshold - 10.0
	}
	s.activeEngine().UpdatePilotSlot(slot)
	s.handleGetState(w, r)
}

// handleThresholds calibrates gates per pilot: a list of {puckId, slotIndex, enterDbm}
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

// handleGateRules sets one gate's timing-rule overrides: {puckId, overrides: {...}}.
// Omitted fields use the global rules; an empty overrides object clears them all.
func (s *Server) handleGateRules(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		PuckID    uint8                    `json:"puckId"`
		Overrides domain.GateRuleOverrides `json:"overrides"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if _, err := s.activeEngine().SetGateRules(body.PuckID, body.Overrides); err != nil {
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

func (s *Server) handleUpdatePuckColor(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		PuckID uint8  `json:"puckId"`
		Color  string `json:"color"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.activeEngine().SetPuckColor(body.PuckID, body.Color); err != nil {
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
		Name           string `json:"name"`
		AssignedPuckID uint8  `json:"assignedPuckId"`
		TrackOrder     *int   `json:"trackOrder,omitempty"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	var err error
	eng := s.activeEngine()
	if body.TrackOrder != nil {
		_, err = eng.AddGate(body.Name, body.AssignedPuckID, *body.TrackOrder)
	} else {
		_, err = eng.AddGate(body.Name, body.AssignedPuckID)
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
		PuckID uint8 `json:"puckId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.activeEngine().RemoveGate(body.PuckID); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.handleGetState(w, r)
}

// handleProvisionGate registers a newly flashed gate puck (or updates its flashed PuckLabel)
// in the real-world engine (and active engine if different) so its ID/name shows up immediately.
func (s *Server) handleProvisionGate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Role      string `json:"role"`
		PuckLabel string `json:"puckLabel"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if _, err := s.realEngine.ProvisionGate(body.Role, body.PuckLabel); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.handleGetState(w, r)
}

// handleFirmwareImage builds and returns the XIAO ESP32-C5 firmware binary with the
// requested role (`hub` = Start Gate + Wi-Fi Bridge to laptop; `spoke` = ESP-NOW
// sector gate that talks to the Hub puck), flashed PuckLabel, current 8-channel pilot
// frequency table, and optional Wi-Fi credentials stamped into the `SLAPRF01` block.
func (s *Server) handleFirmwareImage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var role uint8
	switch r.URL.Query().Get("role") {
	case "hub":
		role = firmware.RoleStartBridge
	case "spoke":
		role = firmware.RoleFieldPuck
	}

	var puckID uint8
	if rawID := r.URL.Query().Get("puckId"); rawID != "" {
		parsed, err := strconv.Atoi(rawID)
		if err != nil || parsed < 1 || parsed > 6 {
			http.Error(w, "invalid timerId", http.StatusBadRequest)
			return
		}
		puckID = uint8(parsed)
	}

	pilots, _, _, _, _ := s.activeEngine().StateSnapshot()
	var freqs [domain.MaxPilotSlots]uint16
	for i := 0; i < domain.MaxPilotSlots && i < len(pilots); i++ {
		freqs[i] = pilots[i].FrequencyMHz
	}

	built, err := firmware.BuildXIAOC5Image(firmware.PuckConfig{
		Role:         role,
		PuckID:       puckID,
		PuckLabel:    r.URL.Query().Get("label"),
		SlotFreqsMHz: freqs,
		WifiSSID:     r.URL.Query().Get("ssid"),
		WifiPass:     r.URL.Query().Get("pass"),
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", built.Filename))
	w.Header().Set("X-SlapRF-SHA256", built.SHA256Hex)
	w.Header().Set("X-SlapRF-Puck-ID", strconv.Itoa(int(built.Config.PuckID)))
	w.Header().Set("X-SlapRF-Role", strconv.Itoa(int(built.Config.Role)))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(built.Bytes)
}

func (s *Server) handleToggleSim(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	next := !s.simulator.IsRunning()
	s.simulator.SetRunning(next)
	s.laprfServer.SetEngine(s.activeEngine())
	s.handleGetState(w, r)
}

func (s *Server) handlePackBurst(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.simulator.TriggerPackBurst()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleResetSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.activeEngine().ResetSession()
	s.handleGetState(w, r)
}

func (s *Server) handleIngestFrame(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var frame domain.PuckTelemetryFrame
	if err := json.NewDecoder(r.Body).Decode(&frame); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.realEngine.IngestTelemetryFrame(frame)
	writeJSON(w, http.StatusOK, map[string]bool{"ingested": true})
}

// handleTypeScriptBundle compiles `web/src/main.ts` and all imported TypeScript modules
// in memory using esbuild's native Go library (zero Node.js required).
func (s *Server) handleTypeScriptBundle(w http.ResponseWriter, _ *http.Request) {
	absRoot, err := filepath.Abs(s.webRootDir)
	if err != nil {
		absRoot = s.webRootDir
	}
	if realRoot, err := filepath.EvalSymlinks(absRoot); err == nil {
		absRoot = realRoot
	}
	entryPoint := filepath.Join(absRoot, "src", "main.ts")
	result := api.Build(api.BuildOptions{
		AbsWorkingDir: absRoot,
		EntryPoints:   []string{entryPoint},
		Bundle:        true,
		Write:         false,
		Target:        api.ES2022,
		Format:        api.FormatIIFE,
		Sourcemap:     api.SourceMapInline,
	})

	if len(result.Errors) > 0 {
		log.Printf("[TS Bundler] Compilation error: %v", result.Errors[0].Text)
		w.Header().Set("Content-Type", "application/javascript")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = fmt.Fprintf(w, "console.error(%q);", result.Errors[0].Text)
		return
	}

	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if len(result.OutputFiles) > 0 {
		_, _ = w.Write(result.OutputFiles[0].Contents)
	}
}

func writeJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
