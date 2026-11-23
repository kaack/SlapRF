package gatecam

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"slaprf/internal/applog"
	"slaprf/internal/domain"
)

const maxRetainedFullBurstPasses = 40

// Config configures a GateCam HTTP + WebSocket verification server.
type Config struct {
	Version      string
	DataDir      string
	StaticFS     fs.FS
	DefaultLink  string // Defaults to "http://127.0.0.1:18090"
	Camera       CameraProvider
	AppLog       *applog.Logger
	OnLanChanged func(expose bool) ([]string, error)
}

type persistedSettings struct {
	Gate   GateLine     `json:"gate"`
	Camera CameraConfig `json:"camera"`
	Link   LinkConfig   `json:"link"`
}

type wsSubscriber struct {
	ch chan []byte
}

// Server coordinates the CameraProvider, SlapRF stream subscriber, lookback crossing solver,
// session store, and `:18095` HTTP/WS UI & export routes.
type Server struct {
	cfg      Config
	appLog   *applog.Logger
	cam      CameraProvider
	client   *slaprfClient
	savePath string

	mu          sync.RWMutex
	gate        GateLine
	camCfg      CameraConfig
	linkCfg     LinkConfig
	lanURLs     []string
	passes      []*PassRecord
	passByID    map[int]*PassRecord
	nextPassID  int
	stats       SessionStats

	wsMu    sync.RWMutex
	wsClients map[*wsSubscriber]struct{}

	stopCh   chan struct{}
	stopOnce sync.Once
}

// NewServer creates and starts a GateCam verification backend.
func NewServer(cfg Config) *Server {
	if cfg.Version == "" {
		cfg.Version = "dev"
	}
	if cfg.Camera == nil {
		cfg.Camera = NewSimCameraProvider()
	}
	appLogger := cfg.AppLog
	if appLogger == nil {
		logPath := ""
		if cfg.DataDir != "" {
			_ = os.MkdirAll(cfg.DataDir, 0o755)
			logPath = filepath.Join(cfg.DataDir, "gatecam.log")
		}
		appLogger = applog.New(applog.Options{FilePath: logPath, Level: applog.LevelInfo, HasLevel: true})
	}
	defLink := strings.TrimSpace(cfg.DefaultLink)
	if defLink == "" {
		defLink = "http://127.0.0.1:18090"
	}

	s := &Server{
		cfg:       cfg,
		appLog:    appLogger,
		cam:       cfg.Camera,
		gate:      DefaultGateLine(),
		camCfg:    DefaultCameraConfig(),
		linkCfg:   LinkConfig{SlapRFURL: defLink, ExposeLAN: true},
		passByID:  make(map[int]*PassRecord),
		wsClients: make(map[*wsSubscriber]struct{}),
		stopCh:    make(chan struct{}),
	}
	if cfg.DataDir != "" {
		s.savePath = filepath.Join(cfg.DataDir, "gatecam-settings.json")
		s.loadSettings()
	}
	_, _ = s.cam.Configure(s.camCfg)
	s.stats = RecomputeLapsAndStats(nil)

	s.client = newSlapRFClient(s.cam, s.linkCfg, appLogger, s.handleSlapRFCrossing, func() {
		s.broadcastWS("status", s.buildStateSnapshot())
	})

	// Push live 5 Hz HUD status/RSSI updates to connected WebView / remote laptop browsers
	go func() {
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-s.stopCh:
				return
			case <-ticker.C:
				if s.hasWSClients() {
					s.broadcastWS("hud", map[string]any{
						"camera": s.cam.Status(),
						"sync":   s.syncStatusWithLAN(),
					})
				}
			}
		}
	}()

	return s
}

func (s *Server) Close() {
	s.stopOnce.Do(func() {
		close(s.stopCh)
		if s.client != nil {
			s.client.Close()
		}
	})
}

func (s *Server) AppLog() *applog.Logger {
	return s.appLog
}

func (s *Server) SetLanURLs(urls []string) {
	s.mu.Lock()
	s.lanURLs = append([]string(nil), urls...)
	s.mu.Unlock()
}

func (s *Server) ExposeLAN() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.linkCfg.ExposeLAN
}

func (s *Server) loadSettings() {
	if s.savePath == "" {
		return
	}
	b, err := os.ReadFile(s.savePath)
	if err != nil {
		return
	}
	var saved persistedSettings
	if json.Unmarshal(b, &saved) != nil {
		return
	}
	if saved.Gate.BandHalfWidthNorm > 0 {
		s.gate = saved.Gate
	}
	if saved.Camera.TargetFPS > 0 {
		s.camCfg = saved.Camera
	}
	if strings.TrimSpace(saved.Link.SlapRFURL) != "" {
		s.linkCfg = saved.Link
	}
}

func (s *Server) saveSettingsLocked() {
	if s.savePath == "" {
		return
	}
	b, err := json.MarshalIndent(persistedSettings{
		Gate:   s.gate,
		Camera: s.camCfg,
		Link:   s.linkCfg,
	}, "", "  ")
	if err == nil {
		_ = os.WriteFile(s.savePath, b, 0o644)
	}
}

func (s *Server) handleSlapRFCrossing(ev domain.GateCrossingEvent) {
	s.mu.RLock()
	gateFilter := s.linkCfg.GateFilter
	pilotFilter := s.linkCfg.PilotFilter
	halfMs := s.camCfg.LookbackHalfMs
	gate := s.gate
	camCfg := s.camCfg
	s.mu.RUnlock()

	if gateFilter > 0 && int(ev.GateID) != gateFilter {
		return
	}
	if pilotFilter > 0 && ev.SlotIndex != pilotFilter {
		return
	}
	if halfMs < 150 {
		halfMs = 450
	}

	syncSt := s.client.Status()
	clockOffsetUs := syncSt.ClockOffsetUs
	if !syncSt.ClockLocked {
		// Estimate offset directly from current sensor clock if crossing arrived before sync finished
		clockOffsetUs = int64(ev.TimestampUs) - s.cam.CurrentSensorClockNs()/1000
	}

	go s.processCrossingLookback(ev, gate, camCfg, halfMs, clockOffsetUs)
}

func (s *Server) processCrossingLookback(ev domain.GateCrossingEvent, gate GateLine, camCfg CameraConfig, halfMs int, clockOffsetUs int64) {
	targetSensorNs := (int64(ev.TimestampUs) - clockOffsetUs) * 1000
	endSensorNs := targetSensorNs + int64(halfMs)*1_000_000
	startSensorNs := targetSensorNs - int64(halfMs)*1_000_000

	// Wait briefly if post-crossing frames up to endSensorNs are still arriving from a live hardware sensor
	if !s.cam.Status().Simulated {
		nowSensorNs := s.cam.CurrentSensorClockNs()
		if waitNs := endSensorNs - nowSensorNs + 18_000_000; waitNs > 0 && waitNs <= 700_000_000 {
			select {
			case <-s.stopCh:
				return
			case <-time.After(time.Duration(waitNs)):
			}
		}
	}

	frames, err := s.cam.ExtractAndAnalyzeBurst(LookbackRequest{
		StartSensorNs: startSensorNs,
		EndSensorNs:   endSensorNs,
		Gate:          gate,
		MotionModel:   camCfg.MotionModel,
		Sensitivity:   camCfg.Sensitivity,
	})
	if err != nil {
		s.appLog.Warnf("[GateCam] Lookback extraction failed for crossing #%d: %v", ev.EventID, err)
	}

	startUs := uint64(0)
	if int64(ev.TimestampUs) > int64(halfMs)*1000 {
		startUs = ev.TimestampUs - uint64(halfMs)*1000
	}
	endUs := ev.TimestampUs + uint64(halfMs)*1000
	rssiTrace := s.client.SliceRSSITrace(ev.GateID, ev.SlotIndex, ev.TimestampUs, startUs, endUs)

	rec := &PassRecord{
		CreatedAt:         time.Now().Format("15:04:05.000"),
		EventID:           ev.EventID,
		GateID:            ev.GateID,
		GateName:          ev.GateName,
		SlotIndex:         ev.SlotIndex,
		Callsign:          ev.Callsign,
		FrequencyMHz:      ev.FrequencyMHz,
		PeakRSSIDbm:       ev.PeakRSSIDbm,
		HoldMs:            ev.HoldMs,
		EstimatedSpeedMph: ev.EstimatedSpeedMph,
		RFTimestampUs:     ev.TimestampUs,
		MotionModel:       camCfg.MotionModel,
		RSSITrace:         rssiTrace,
	}
	SolveLookback(rec, frames, gate, clockOffsetUs, camCfg.RollingShutterComp)

	s.mu.Lock()
	s.nextPassID++
	rec.PassID = s.nextPassID
	s.passes = append(s.passes, rec)
	s.passByID[rec.PassID] = rec
	// Evict heavy JPEG slices on older passes beyond maxRetainedFullBurstPasses while keeping ThumbJPEG & stats
	if len(s.passes) > maxRetainedFullBurstPasses {
		old := s.passes[len(s.passes)-maxRetainedFullBurstPasses-1]
		if !old.FramesPurged {
			for i := range old.Frames {
				old.Frames[i].JPEG = nil
				old.Frames[i].MaskJPEG = nil
			}
			old.FramesPurged = true
		}
	}
	s.stats = RecomputeLapsAndStats(s.passes)
	summary := SummaryOf(rec)
	statsSnap := s.stats
	s.mu.Unlock()

	biasTxt := "needs-manual"
	if rec.GateBiasMs != nil {
		biasTxt = fmt.Sprintf("%+.2f ms", *rec.GateBiasMs)
	}
	s.appLog.Infof("[GateCam] Pass #%d %s (slot=%d, gate=#%d): status=%s bias=%s frames=%d",
		rec.PassID, rec.Callsign, rec.SlotIndex, rec.GateID, rec.Status, biasTxt, rec.FrameCount)

	s.broadcastWS("pass_added", map[string]any{
		"pass":  summary,
		"stats": statsSnap,
	})
}

func (s *Server) syncStatusWithLAN() SyncStatus {
	st := s.client.Status()
	s.mu.RLock()
	st.LanURLs = append([]string(nil), s.lanURLs...)
	s.mu.RUnlock()
	return st
}

func (s *Server) buildStateSnapshot() map[string]any {
	s.mu.RLock()
	summaries := make([]PassSummary, 0, len(s.passes))
	for i := len(s.passes) - 1; i >= 0; i-- {
		summaries = append(summaries, SummaryOf(s.passes[i]))
	}
	out := map[string]any{
		"version": s.cfg.Version,
		"gate":    s.gate,
		"camera":  s.camCfg,
		"link":    s.linkCfg,
		"camInfo": s.cam.Status(),
		"sync":    s.syncStatusWithLAN(),
		"stats":   s.stats,
		"passes":  summaries,
	}
	s.mu.RUnlock()
	return out
}

// Handler returns the complete `:18095` HTTP + WebSocket handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	s.RegisterAPIRoutes(mux)

	if s.cfg.StaticFS == nil {
		return withCORS(mux)
	}

	fileServer := http.FileServer(http.FS(s.cfg.StaticFS))
	combined := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/") {
			mux.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		clean := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if clean == "" {
			clean = "index.html"
		}
		if _, err := fs.Stat(s.cfg.StaticFS, clean); err != nil && !strings.Contains(path.Base(clean), ".") {
			if idx, rErr := fs.ReadFile(s.cfg.StaticFS, "index.html"); rErr == nil {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				_, _ = w.Write(idx)
				return
			}
		}
		fileServer.ServeHTTP(w, r)
	})
	return withCORS(combined)
}

// RegisterAPIRoutes mounts `/v1/gatecam/*` onto `mux`.
func (s *Server) RegisterAPIRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/gatecam/state", s.handleGetState)
	mux.HandleFunc("PUT /v1/gatecam/gate", s.handlePutGate)
	mux.HandleFunc("PUT /v1/gatecam/camera", s.handlePutCamera)
	mux.HandleFunc("POST /v1/gatecam/camera:focus", s.handlePostFocus)
	mux.HandleFunc("PUT /v1/gatecam/link", s.handlePutLink)
	mux.HandleFunc("GET /v1/gatecam/preview.jpg", s.handlePreviewJPEG)

	mux.HandleFunc("GET /v1/gatecam/passes", s.handleListPasses)
	mux.HandleFunc("POST /v1/gatecam/passes:clear", s.handleClearPasses)
	mux.HandleFunc("GET /v1/gatecam/passes/{passId}", s.handleGetPassOrCustom)
	mux.HandleFunc("POST /v1/gatecam/passes/{passId}", s.handlePassAction)
	mux.HandleFunc("GET /v1/gatecam/passes/{passId}/thumb.jpg", s.handlePassThumb)
	mux.HandleFunc("GET /v1/gatecam/passes/{passId}/frames/{frameFile}", s.handlePassFrameJPEG)

	mux.HandleFunc("POST /v1/gatecam/dev:simulatePass", s.handleDevSimulatePass)

	mux.HandleFunc("GET /v1/gatecam/report.json", s.handleReportJSON)
	mux.HandleFunc("GET /v1/gatecam/report.csv", s.handleReportCSV)
	mux.HandleFunc("GET /v1/gatecam/export.zip", s.handleExportZIP)
	mux.HandleFunc("GET /v1/gatecam/ws", s.handleWS)
}

func (s *Server) handleGetState(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.buildStateSnapshot())
}

func (s *Server) handlePutGate(w http.ResponseWriter, r *http.Request) {
	var next GateLine
	if err := json.NewDecoder(io.LimitReader(r.Body, 16384)).Decode(&next); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	next.P1X = clamp01(next.P1X)
	next.P1Y = clamp01(next.P1Y)
	next.P2X = clamp01(next.P2X)
	next.P2Y = clamp01(next.P2Y)
	if next.DirSign >= 0 {
		next.DirSign = 1
	} else {
		next.DirSign = -1
	}
	if next.BandHalfWidthNorm <= 0.04 || next.BandHalfWidthNorm > 0.45 {
		next.BandHalfWidthNorm = 0.18
	}
	s.mu.Lock()
	s.gate = next
	s.saveSettingsLocked()
	s.mu.Unlock()
	snap := s.buildStateSnapshot()
	s.broadcastWS("status", snap)
	writeJSON(w, http.StatusOK, snap)
}

func (s *Server) handlePutCamera(w http.ResponseWriter, r *http.Request) {
	var next CameraConfig
	if err := json.NewDecoder(io.LimitReader(r.Body, 16384)).Decode(&next); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	st, err := s.cam.Configure(next)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.mu.Lock()
	s.camCfg = next
	s.camCfg.FocusLocked = st.FocusLocked
	s.saveSettingsLocked()
	s.mu.Unlock()
	snap := s.buildStateSnapshot()
	s.broadcastWS("status", snap)
	writeJSON(w, http.StatusOK, snap)
}

func (s *Server) handlePostFocus(w http.ResponseWriter, r *http.Request) {
	var body struct {
		X float64 `json:"x"`
		Y float64 `json:"y"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body)
	if body.X == 0 && body.Y == 0 {
		s.mu.RLock()
		body.X = (s.gate.P1X + s.gate.P2X) * 0.5
		body.Y = (s.gate.P1Y + s.gate.P2Y) * 0.5
		s.mu.RUnlock()
	}
	if err := s.cam.TriggerFocusLock(clamp01(body.X), clamp01(body.Y)); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.mu.Lock()
	s.camCfg.FocusLocked = s.cam.Status().FocusLocked
	s.saveSettingsLocked()
	s.mu.Unlock()
	snap := s.buildStateSnapshot()
	s.broadcastWS("status", snap)
	writeJSON(w, http.StatusOK, snap)
}

func (s *Server) handlePutLink(w http.ResponseWriter, r *http.Request) {
	var next LinkConfig
	if err := json.NewDecoder(io.LimitReader(r.Body, 16384)).Decode(&next); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(next.SlapRFURL) == "" {
		next.SlapRFURL = "http://127.0.0.1:18090"
	}
	s.mu.Lock()
	lanChanged := s.linkCfg.ExposeLAN != next.ExposeLAN
	s.linkCfg = next
	s.saveSettingsLocked()
	s.mu.Unlock()

	if lanChanged && s.cfg.OnLanChanged != nil {
		if urls, err := s.cfg.OnLanChanged(next.ExposeLAN); err == nil {
			s.SetLanURLs(urls)
		}
	}
	s.client.UpdateConfig(next)
	snap := s.buildStateSnapshot()
	s.broadcastWS("status", snap)
	writeJSON(w, http.StatusOK, snap)
}

func (s *Server) handlePreviewJPEG(w http.ResponseWriter, _ *http.Request) {
	jpg, _, err := s.cam.LatestPreviewJPEG()
	if err != nil || len(jpg) == 0 {
		http.NotFound(w, nil)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(jpg)
}

func (s *Server) handleListPasses(w http.ResponseWriter, _ *http.Request) {
	s.mu.RLock()
	summaries := make([]PassSummary, 0, len(s.passes))
	for i := len(s.passes) - 1; i >= 0; i-- {
		summaries = append(summaries, SummaryOf(s.passes[i]))
	}
	st := s.stats
	s.mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{"passes": summaries, "stats": st})
}

func (s *Server) handleClearPasses(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	s.passes = nil
	s.passByID = make(map[int]*PassRecord)
	s.nextPassID = 0
	s.stats = RecomputeLapsAndStats(nil)
	s.mu.Unlock()
	snap := s.buildStateSnapshot()
	s.broadcastWS("status", snap)
	writeJSON(w, http.StatusOK, snap)
}

func (s *Server) handleGetPassOrCustom(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimSpace(r.PathValue("passId"))
	id, err := strconv.Atoi(raw)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid passId")
		return
	}
	s.mu.RLock()
	p := s.passByID[id]
	s.mu.RUnlock()
	if p == nil {
		writeErr(w, http.StatusNotFound, "pass not found")
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) handlePassAction(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimSpace(r.PathValue("passId"))
	idStr, verb, ok := strings.Cut(raw, ":")
	if !ok {
		writeErr(w, http.StatusMethodNotAllowed, "POST requires :pin, :restoreAuto, or :exclude")
		return
	}
	id, err := strconv.Atoi(idStr)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid passId")
		return
	}

	s.mu.Lock()
	p := s.passByID[id]
	if p == nil {
		s.mu.Unlock()
		writeErr(w, http.StatusNotFound, "pass not found")
		return
	}

	switch verb {
	case "pin":
		var body struct {
			FrameIdx int `json:"frameIdx"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
			s.mu.Unlock()
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		if body.FrameIdx < 0 || body.FrameIdx >= len(p.Frames) {
			s.mu.Unlock()
			writeErr(w, http.StatusBadRequest, "frameIdx out of range")
			return
		}
		idx := body.FrameIdx
		p.ManualFrameIdx = &idx
		p.Status = PassStatusManual
		p.CrossingFrameIdx = idx
		p.CamTimestampUs = p.Frames[idx].FrameTimestampUs
		p.Confidence = 1.0
		if len(p.Frames[idx].JPEG) > 0 {
			p.ThumbJPEG = p.Frames[idx].JPEG
		}
		populatePassBias(p, estimateFramePeriodMs(p.Frames))

	case "restoreAuto":
		p.ManualFrameIdx = nil
		p.Status = p.AutoStatus
		p.CamTimestampUs = p.AutoCamTimestampUs
		p.CrossingFrameIdx = p.AutoCrossingFrameIdx
		if p.CrossingFrameIdx >= 0 && p.CrossingFrameIdx < len(p.Frames) && len(p.Frames[p.CrossingFrameIdx].JPEG) > 0 {
			p.ThumbJPEG = p.Frames[p.CrossingFrameIdx].JPEG
		}
		populatePassBias(p, estimateFramePeriodMs(p.Frames))

	case "exclude":
		var body struct {
			Excluded bool `json:"excluded"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body)
		if body.Excluded {
			p.Status = PassStatusExcluded
		} else if p.ManualFrameIdx != nil {
			p.Status = PassStatusManual
		} else {
			p.Status = p.AutoStatus
		}
		populatePassBias(p, estimateFramePeriodMs(p.Frames))

	default:
		s.mu.Unlock()
		writeErr(w, http.StatusNotFound, "unknown pass action "+verb)
		return
	}

	s.stats = RecomputeLapsAndStats(s.passes)
	passCopy := *p
	statsSnap := s.stats
	summary := SummaryOf(p)
	s.mu.Unlock()

	s.broadcastWS("pass_updated", map[string]any{
		"pass":  summary,
		"stats": statsSnap,
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"pass":  passCopy,
		"stats": statsSnap,
	})
}

func (s *Server) handlePassThumb(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.PathValue("passId"))
	s.mu.RLock()
	p := s.passByID[id]
	var jpg []byte
	if p != nil {
		jpg = p.ThumbJPEG
	}
	s.mu.RUnlock()
	if len(jpg) == 0 {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write(jpg)
}

func (s *Server) handlePassFrameJPEG(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.PathValue("passId"))
	frameFile := strings.TrimSuffix(r.PathValue("frameFile"), ".jpg")
	idx, err := strconv.Atoi(frameFile)
	if err != nil || idx < 0 {
		http.NotFound(w, r)
		return
	}
	wantMask := r.URL.Query().Get("mask") == "1"

	s.mu.RLock()
	p := s.passByID[id]
	var jpg []byte
	if p != nil && idx < len(p.Frames) {
		if wantMask && len(p.Frames[idx].MaskJPEG) > 0 {
			jpg = p.Frames[idx].MaskJPEG
		} else {
			jpg = p.Frames[idx].JPEG
		}
	}
	s.mu.RUnlock()
	if len(jpg) == 0 {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write(jpg)
}

func (s *Server) handleDevSimulatePass(w http.ResponseWriter, _ *http.Request) {
	nowUs := uint64(s.cam.CurrentSensorClockNs() / 1000)
	s.mu.RLock()
	seq := s.nextPassID + 1
	gate := s.gate
	camCfg := s.camCfg
	s.mu.RUnlock()

	ev := domain.GateCrossingEvent{
		EventID:           uint64(1000 + seq),
		GateID:            1,
		GateName:          "Start / Finish",
		IsStartFinish:     true,
		SlotIndex:         1,
		Callsign:          "VORTEX",
		FrequencyMHz:      5658,
		TimestampUs:       nowUs,
		PeakRSSIDbm:       -44.5,
		HoldMs:            185,
		EstimatedSpeedMph: 48.5,
	}
	s.processCrossingLookback(ev, gate, camCfg, camCfg.LookbackHalfMs, 0)
	writeJSON(w, http.StatusOK, s.buildStateSnapshot())
}

func (s *Server) handleReportJSON(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Disposition", `attachment; filename="gatecam-report.json"`)
	writeJSON(w, http.StatusOK, s.buildStateSnapshot())
}

func (s *Server) handleReportCSV(w http.ResponseWriter, _ *http.Request) {
	csvBytes := s.encodePassesCSV()
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="gatecam-passes.csv"`)
	_, _ = w.Write(csvBytes)
}

func (s *Server) handleExportZIP(w http.ResponseWriter, _ *http.Request) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	if repBytes, err := json.MarshalIndent(s.buildStateSnapshot(), "", "  "); err == nil {
		if f, cErr := zw.Create("gatecam-report.json"); cErr == nil {
			_, _ = f.Write(repBytes)
		}
	}
	if f, err := zw.Create("gatecam-passes.csv"); err == nil {
		_, _ = f.Write(s.encodePassesCSV())
	}

	s.mu.RLock()
	for _, p := range s.passes {
		if len(p.ThumbJPEG) > 0 {
			if f, err := zw.Create(fmt.Sprintf("passes/pass_%03d_%s_crossing.jpg", p.PassID, p.Callsign)); err == nil {
				_, _ = f.Write(p.ThumbJPEG)
			}
		}
		// Include bracketing ±2 keyframes when retained in memory
		for delta := -2; delta <= 2; delta++ {
			k := p.CrossingFrameIdx + delta
			if k >= 0 && k < len(p.Frames) && len(p.Frames[k].JPEG) > 0 {
				name := fmt.Sprintf("passes/pass_%03d_frame_%03d.jpg", p.PassID, k)
				if f, err := zw.Create(name); err == nil {
					_, _ = f.Write(p.Frames[k].JPEG)
				}
			}
		}
	}
	s.mu.RUnlock()
	_ = zw.Close()

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="gatecam-verification.zip"`)
	_, _ = w.Write(buf.Bytes())
}

func (s *Server) encodePassesCSV() []byte {
	var buf bytes.Buffer
	cw := csv.NewWriter(&buf)
	_ = cw.Write([]string{
		"passId", "createdAt", "callsign", "slotIndex", "gateId", "status", "confidence",
		"peakRssiDbm", "holdMs", "estimatedSpeedMph", "rfTimestampUs", "camTimestampUs",
		"gateBiasMs", "gateBiasFrames", "spatialBiasCm", "lapNumber", "lapRfSec", "lapCamSec", "lapDeltaMs",
	})
	s.mu.RLock()
	for _, p := range s.passes {
		_ = cw.Write([]string{
			strconv.Itoa(p.PassID),
			p.CreatedAt,
			p.Callsign,
			strconv.Itoa(p.SlotIndex),
			strconv.Itoa(int(p.GateID)),
			string(p.Status),
			fmt.Sprintf("%.2f", p.Confidence),
			fmt.Sprintf("%.1f", p.PeakRSSIDbm),
			fmt.Sprintf("%.1f", p.HoldMs),
			fmt.Sprintf("%.1f", p.EstimatedSpeedMph),
			strconv.FormatUint(p.RFTimestampUs, 10),
			strconv.FormatUint(p.CamTimestampUs, 10),
			optFloatStr(p.GateBiasMs, "%.2f"),
			optFloatStr(p.GateBiasFrames, "%.2f"),
			optFloatStr(p.SpatialBiasCm, "%.1f"),
			strconv.Itoa(p.LapNumber),
			optFloatStr(p.LapRFSec, "%.4f"),
			optFloatStr(p.LapCamSec, "%.4f"),
			optFloatStr(p.LapDeltaMs, "%.2f"),
		})
	}
	s.mu.RUnlock()
	cw.Flush()
	return buf.Bytes()
}

func (s *Server) hasWSClients() bool {
	s.wsMu.RLock()
	n := len(s.wsClients)
	s.wsMu.RUnlock()
	return n > 0
}

func (s *Server) broadcastWS(evType string, payload any) {
	if !s.hasWSClients() {
		return
	}
	b, err := json.Marshal(map[string]any{"type": evType, "payload": payload})
	if err != nil {
		return
	}
	s.wsMu.RLock()
	for cl := range s.wsClients {
		select {
		case cl.ch <- b:
		default:
			select {
			case <-cl.ch:
			default:
			}
			select {
			case cl.ch <- b:
			default:
			}
		}
	}
	s.wsMu.RUnlock()
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer func() { _ = ws.CloseNow() }()

	sub := &wsSubscriber{ch: make(chan []byte, 64)}
	s.wsMu.Lock()
	s.wsClients[sub] = struct{}{}
	s.wsMu.Unlock()
	defer func() {
		s.wsMu.Lock()
		delete(s.wsClients, sub)
		s.wsMu.Unlock()
	}()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() {
		defer cancel()
		for {
			if _, _, rErr := ws.Read(ctx); rErr != nil {
				return
			}
		}
	}()

	if initBytes, mErr := json.Marshal(map[string]any{"type": "status", "payload": s.buildStateSnapshot()}); mErr == nil {
		wCtx, wCancel := context.WithTimeout(ctx, 3*time.Second)
		_ = ws.Write(wCtx, websocket.MessageText, initBytes)
		wCancel()
	}

	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-sub.ch:
			wCtx, wCancel := context.WithTimeout(ctx, 3*time.Second)
			err := ws.Write(wCtx, websocket.MessageText, msg)
			wCancel()
			if err != nil {
				return
			}
		case <-ping.C:
			pCtx, pCancel := context.WithTimeout(ctx, 3*time.Second)
			err := ws.Ping(pCtx)
			pCancel()
			if err != nil {
				return
			}
		}
	}
}

// LocalIPv4URLs returns `http://<lan-ip>:<port>` strings for active private IPv4 interfaces.
func LocalIPv4URLs(port int) []string {
	if port <= 0 {
		return nil
	}
	pStr := strconv.Itoa(port)
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var out []string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, a := range addrs {
			if ipNet, ok := a.(*net.IPNet); ok {
				ip4 := ipNet.IP.To4()
				if ip4 != nil && ip4.IsPrivate() {
					out = append(out, "http://"+net.JoinHostPort(ip4.String(), pStr))
				}
			}
		}
	}
	return out
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func optFloatStr(p *float64, format string) string {
	if p == nil {
		return ""
	}
	return fmt.Sprintf(format, *p)
}
