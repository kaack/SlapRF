//go:build js && wasm

// Command slaprf-wasm is the standalone Browser Demo Simulator runtime for `slaprf.app`
// when no local or LAN SlapRF Go backend is connected.
//
// All physical hardware protocols (USB Serial, ESP32-C5 ROM bootloader flasher, LapRF 8-Way TCP,
// RotorHazard Socket.IO, LiveTime :5403 TCP server, and bbolt storage) live exclusively in the
// native Go server (`cmd/slaprf`). This WASM binary runs only the showcase `TrackSimulator` +
// `simEngine` so visitors on `slaprf.app` can explore 100% of SlapRF's race formats and simulated
// hardware modes with zero install before connecting to a real track server.
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"syscall/js"
	"time"

	"slaprf/internal/api"
	"slaprf/internal/domain"
	"slaprf/internal/ingest"
	"slaprf/internal/laprf"
	"slaprf/internal/tracker"
)

type wasmStreamSubscriber struct {
	mu          sync.RWMutex
	engine      *tracker.Engine
	callback    js.Value
	telemetryCb js.Value

	batchMu  sync.Mutex
	batching int
	pending  []domain.TimerTelemetryFrame
	encBuf   []byte
}

func (w *wasmStreamSubscriber) setCallback(cb js.Value) {
	w.mu.Lock()
	w.callback = cb
	w.mu.Unlock()
}

func (w *wasmStreamSubscriber) setTelemetryCallback(cb js.Value) {
	w.mu.Lock()
	w.telemetryCb = cb
	w.mu.Unlock()
}

func (w *wasmStreamSubscriber) beginBatch() {
	w.batchMu.Lock()
	w.batching++
	w.batchMu.Unlock()
}

func (w *wasmStreamSubscriber) endBatch() {
	w.batchMu.Lock()
	w.batching--
	w.batchMu.Unlock()
	w.flushTelemetry()
}

func (w *wasmStreamSubscriber) flushTelemetry() {
	w.mu.RLock()
	cb := w.telemetryCb
	w.mu.RUnlock()

	w.batchMu.Lock()
	if len(w.pending) == 0 {
		w.batchMu.Unlock()
		return
	}
	if cb.IsUndefined() || cb.IsNull() {
		w.pending = w.pending[:0]
		w.batchMu.Unlock()
		return
	}
	rssiCount := domain.MaxPilotSlots
	if w.engine != nil {
		if pc := w.engine.PilotCount(); pc > rssiCount {
			rssiCount = pc
		}
	}
	if rssiCount > domain.MaxPilotPoolSize {
		rssiCount = domain.MaxPilotPoolSize
	}
	w.encBuf = api.EncodeTelemetryBatch(w.encBuf[:0], w.pending, rssiCount)
	w.pending = w.pending[:0]
	u8 := js.Global().Get("Uint8Array").New(len(w.encBuf))
	js.CopyBytesToJS(u8, w.encBuf)
	w.batchMu.Unlock()
	cb.Invoke(u8)
}

func (w *wasmStreamSubscriber) send(eventType string, payload any) {
	w.flushTelemetry()
	w.mu.RLock()
	cb := w.callback
	w.mu.RUnlock()
	if cb.IsUndefined() || cb.IsNull() {
		return
	}
	b, err := json.Marshal(api.StreamEnvelope{
		Type:    eventType,
		Payload: payload,
	})
	if err != nil {
		return
	}
	cb.Invoke(string(b))
}

func (w *wasmStreamSubscriber) OnTelemetryFrame(frame domain.TimerTelemetryFrame) {
	w.mu.RLock()
	binaryTelemetry := !w.telemetryCb.IsUndefined() && !w.telemetryCb.IsNull()
	w.mu.RUnlock()
	if !binaryTelemetry {
		w.send("telemetry", frame)
		return
	}
	w.batchMu.Lock()
	w.pending = append(w.pending, frame)
	immediate := w.batching == 0
	w.batchMu.Unlock()
	if immediate {
		w.flushTelemetry()
	}
}

func (w *wasmStreamSubscriber) OnGateCrossing(event domain.GateCrossingEvent) {
	w.send("crossing", event)
}

func (w *wasmStreamSubscriber) OnDetectionFiltered(f domain.FilteredDetection) {
	w.send("filtered", f)
}

func (w *wasmStreamSubscriber) OnLapCompleted(lap domain.LapRecord, summaries []domain.PilotTrackSummary) {
	w.send("lap", map[string]any{
		"lap":       lap,
		"summaries": summaries,
	})
}

func (w *wasmStreamSubscriber) OnConfigUpdated(pilots []domain.PilotSlot, gates []domain.TrackGate) {
	var timers []domain.DetectedTimer
	if w.engine != nil {
		timers = w.engine.DetectedTimersSnapshot()
	}
	w.send("config", map[string]any{
		"pilots": pilots,
		"gates":  gates,
		"timers": timers,
	})
}

func (w *wasmStreamSubscriber) OnRaceUpdated(state domain.RaceTournamentState, eventState domain.EventManagerState, announcement *domain.RaceAnnouncement) {
	var serverTsUs uint64
	if w.engine != nil {
		serverTsUs = w.engine.NowUs()
	}
	w.send("race", map[string]any{
		"serverTimestampUs": serverTsUs,
		"raceState":         state,
		"eventState":        eventState,
		"announcement":      announcement,
	})
}

func (w *wasmStreamSubscriber) OnPracticeUpdated(state domain.PracticeManagerState) {
	w.send("practice", state)
}

type persistedSimBundle struct {
	Engine  tracker.PersistedEngineState `json:"engine"`
	Options ingest.SimPersistedOptions   `json:"options"`
}

func bootStateString(field string) string {
	bs := js.Global().Get("__slaprfBootState")
	if bs.Type() != js.TypeObject {
		return ""
	}
	v := bs.Get(field)
	if v.Type() != js.TypeString {
		return ""
	}
	return v.String()
}

func loadSimFromBootState(simEngine *tracker.Engine, sim *ingest.TrackSimulator) bool {
	raw := bootStateString("sim")
	if raw == "" {
		return false
	}
	var payload persistedSimBundle
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return false
	}
	if !ingest.SimStateCompatible(payload.Options) {
		return false
	}
	simEngine.RestoreState(payload.Engine, true)
	sim.RestoreOptions(payload.Options)
	return true
}

func ingestRawHubStream(rx *ingest.HubFrameDecoder, eng *tracker.Engine, raw []byte) {
	nowUs := eng.NowUs()
	pos := 0
	for pos+2 <= len(raw) {
		if raw[pos] != 0x1E {
			pos++
			continue
		}
		pktLen := int(raw[pos+1])
		if pos+2+pktLen > len(raw) {
			break
		}
		rx.IngestPacket(raw[pos+2:pos+2+pktLen], nowUs)
		pos += 2 + pktLen
	}
}

func main() {
	simEngine := tracker.NewEngine()
	sim := ingest.NewTrackSimulator(simEngine)
	simHubRx := ingest.NewHubFrameDecoder(simEngine)
	simStreamSub := &wasmStreamSubscriber{engine: simEngine}
	simEngine.Subscribe(simStreamSub)
	sim.SetTelemetryBatchHooks(simStreamSub.beginBatch, simStreamSub.endBatch)

	var simHubUSBConnected atomic.Bool
	var simHubUsbMu sync.RWMutex
	var simHubUsbCb js.Value
	sim.SetHubFrameSink(func(raw []byte) {
		if len(raw) == 0 {
			return
		}
		if simHubUSBConnected.Load() {
			ingestRawHubStream(simHubRx, simEngine, raw)
		}
		simHubUsbMu.RLock()
		cb := simHubUsbCb
		simHubUsbMu.RUnlock()
		if cb.IsUndefined() || cb.IsNull() {
			return
		}
		u8 := js.Global().Get("Uint8Array").New(len(raw))
		js.CopyBytesToJS(u8, raw)
		cb.Invoke(u8)
	})

	sim.SetSlapRFModeSyncHook(func() {
		simHubRx.Reset()
		if simHubUSBConnected.Load() && sim.IsRunning() {
			simStreamSub.beginBatch()
			ingestRawHubStream(simHubRx, simEngine, sim.BuildHubHelloStream())
			simStreamSub.endBatch()
		} else {
			simEngine.SetAllTimersOffline()
		}
	})

	loadedBootState := loadSimFromBootState(simEngine, sim)
	if !loadedBootState {
		simHubUSBConnected.Store(true)
		sim.RestoreDemoData()
	} else if simEngine.TimingHardwareMode() == domain.HardwareModeSlapRF {
		simEngine.SetAllTimersOffline()
	} else {
		sim.SyncHardwareMode()
	}
	sim.Start()
	sim.SetRunning(true) // Standalone Browser Demo Mode always runs Simulator ON
	if !loadedBootState && simEngine.TimingHardwareMode() == domain.HardwareModeSlapRF {
		simHubRx.Reset()
		ingestRawHubStream(simHubRx, simEngine, sim.BuildHubHelloStream())
	}

	var hubCmdMu sync.RWMutex
	var hubCmdCb js.Value
	simHubRx.SetOutboundSender(func(pkt []byte) {
		hubCmdMu.RLock()
		cb := hubCmdCb
		hubCmdMu.RUnlock()
		if cb.IsUndefined() || cb.IsNull() {
			return
		}
		u8 := js.Global().Get("Uint8Array").New(len(pkt))
		js.CopyBytesToJS(u8, pkt)
		cb.Invoke(u8)
	})

	laprfSrv := laprf.NewServer(simEngine)
	srv := api.NewServer(simEngine, sim, laprfSrv, simEngine)
	// Enforce Simulator ON even if /api/sim/toggle or /api/sim/mode is called inside Demo WASM
	srv.SetHooks(api.ServerHooks{
		OnModeChanged: func(running bool) {
			if !running {
				sim.SetRunning(true)
			}
		},
	})
	handler := srv.Handler()

	// Advance live heat countdowns and race timers natively inside WASM at 10 Hz so the UI
	// never needs to poll POST /api/race/tick across the JS/JSON boundary.
	go func() {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for range ticker.C {
			simEngine.TickRaceClock()
		}
	}()

	apiObj := js.Global().Get("Object").New()

	apiObj.Set("request", js.FuncOf(func(_ js.Value, args []js.Value) any {
		method := http.MethodGet
		if len(args) > 0 && args[0].Type() == js.TypeString && args[0].String() != "" {
			method = strings.ToUpper(strings.TrimSpace(args[0].String()))
		}
		url := "/api/state"
		if len(args) > 1 && args[1].Type() == js.TypeString && args[1].String() != "" {
			url = args[1].String()
		}
		var bodyReader *strings.Reader
		if len(args) > 2 && !args[2].IsUndefined() && !args[2].IsNull() && args[2].String() != "" {
			bodyReader = strings.NewReader(args[2].String())
		} else {
			bodyReader = strings.NewReader("")
		}

		req := httptest.NewRequest(method, url, bodyReader)
		if bodyReader.Len() > 0 {
			req.Header.Set("Content-Type", "application/json")
		}
		if len(args) > 3 && args[3].Type() == js.TypeObject && !args[3].IsNull() {
			keys := js.Global().Get("Object").Call("keys", args[3])
			for i := 0; i < keys.Length(); i++ {
				k := keys.Index(i).String()
				v := args[3].Get(k)
				if v.Type() == js.TypeString {
					req.Header.Set(k, v.String())
				}
			}
		}

		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		hdrObj := js.Global().Get("Object").New()
		for k, vals := range rec.Header() {
			if len(vals) > 0 {
				hdrObj.Set(strings.ToLower(k), strings.Join(vals, ", "))
			}
		}

		res := js.Global().Get("Object").New()
		res.Set("status", rec.Code)
		res.Set("headers", hdrObj)
		res.Set("body", rec.Body.String())
		return res
	}))

	apiObj.Set("onStream", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) > 0 {
			simStreamSub.setCallback(args[0])
		} else {
			simStreamSub.setCallback(js.Undefined())
		}
		return nil
	}))

	apiObj.Set("onTelemetry", js.FuncOf(func(_ js.Value, args []js.Value) any {
		cb := js.Undefined()
		if len(args) > 0 && args[0].Type() == js.TypeFunction {
			cb = args[0]
		}
		simStreamSub.setTelemetryCallback(cb)
		return nil
	}))

	apiObj.Set("setRunning", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		// Standalone Browser Demo Mode always keeps Simulator running
		sim.SetRunning(true)
		return nil
	}))

	apiObj.Set("ingestHubPacket", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) == 0 || args[0].IsUndefined() || args[0].IsNull() {
			return 0
		}
		length := args[0].Get("byteLength").Int()
		if length <= 0 || length > 512 {
			return 0
		}
		buf := make([]byte, length)
		js.CopyBytesToGo(buf, args[0])
		simStreamSub.beginBatch()
		defer simStreamSub.endBatch()
		return simHubRx.IngestPacket(buf, simEngine.NowUs())
	}))

	var packBuf []byte
	apiObj.Set("ingestHubPackets", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) == 0 || args[0].IsUndefined() || args[0].IsNull() {
			return 0
		}
		length := args[0].Get("byteLength").Int()
		if length <= 0 || length > 1<<20 {
			return 0
		}
		if cap(packBuf) < length {
			packBuf = make([]byte, length*2)
		}
		buf := packBuf[:length]
		js.CopyBytesToGo(buf, args[0])
		nowUs := simEngine.NowUs()
		simStreamSub.beginBatch()
		defer simStreamSub.endBatch()
		total := 0
		for o := 0; o < length; {
			n := int(buf[o])
			o++
			if o+n > length {
				break
			}
			total += simHubRx.IngestPacket(buf[o:o+n], nowUs)
			o += n
		}
		return total
	}))

	apiObj.Set("onHubCommand", js.FuncOf(func(_ js.Value, args []js.Value) any {
		hubCmdMu.Lock()
		if len(args) > 0 {
			hubCmdCb = args[0]
		} else {
			hubCmdCb = js.Undefined()
		}
		hubCmdMu.Unlock()
		return nil
	}))

	apiObj.Set("pushHubChannels", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		simHubRx.PushActiveChannels()
		return nil
	}))

	apiObj.Set("setSimHubUsbConnected", js.FuncOf(func(_ js.Value, args []js.Value) any {
		connected := len(args) > 0 && args[0].Truthy()
		simHubUSBConnected.Store(connected)
		if !connected {
			if simEngine.TimingHardwareMode() == domain.HardwareModeSlapRF {
				simEngine.SetAllTimersOffline()
			}
			return nil
		}
		if sim.IsRunning() && simEngine.TimingHardwareMode() == domain.HardwareModeSlapRF {
			simHubRx.Reset()
			simStreamSub.beginBatch()
			ingestRawHubStream(simHubRx, simEngine, sim.BuildHubHelloStream())
			simStreamSub.endBatch()
		}
		return nil
	}))

	apiObj.Set("onSimHubUsbBytes", js.FuncOf(func(_ js.Value, args []js.Value) any {
		simHubUsbMu.Lock()
		if len(args) > 0 && args[0].Type() == js.TypeFunction {
			simHubUsbCb = args[0]
		} else {
			simHubUsbCb = js.Undefined()
		}
		simHubUsbMu.Unlock()
		return nil
	}))

	apiObj.Set("flushSimHubHellos", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		raw := sim.BuildHubHelloStream()
		u8 := js.Global().Get("Uint8Array").New(len(raw))
		if len(raw) > 0 {
			js.CopyBytesToJS(u8, raw)
		}
		return u8
	}))

	apiObj.Set("setSimTimerDiagState", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) < 5 {
			return nil
		}
		sim.SetTimerDiagState(
			uint8(args[0].Int()),
			args[1].Bool(),
			args[2].Bool(),
			args[3].Bool(),
			uint8(args[4].Int()),
		)
		return nil
	}))

	apiObj.Set("getSimTimerRssi", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) < 1 {
			return js.Null()
		}
		rssi, ok := sim.TimerRSSI(uint8(args[0].Int()))
		if !ok {
			return js.Null()
		}
		arr := js.Global().Get("Array").New(len(rssi))
		for i, v := range rssi {
			arr.SetIndex(i, float64(v))
		}
		return arr
	}))

	apiObj.Set("exportRealState", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		return ""
	}))
	apiObj.Set("restoreRealState", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		return false
	}))

	apiObj.Set("exportSimState", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		payload := persistedSimBundle{
			Engine:  simEngine.ExportState(),
			Options: sim.ExportOptions(),
		}
		b, err := json.Marshal(payload)
		if err != nil {
			return ""
		}
		return string(b)
	}))

	apiObj.Set("restoreSimState", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) == 0 || args[0].Type() != js.TypeString {
			return false
		}
		raw := args[0].String()
		if raw == "" {
			return false
		}
		var payload persistedSimBundle
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return false
		}
		if !ingest.SimStateCompatible(payload.Options) {
			return false
		}
		simEngine.RestoreState(payload.Engine, true)
		sim.RestoreOptions(payload.Options)
		sim.SetRunning(true)
		return true
	}))

	js.Global().Set("slaprfWasm", apiObj)
	if cb := js.Global().Get("__slaprfWasmOnReady"); cb.Type() == js.TypeFunction {
		cb.Invoke(apiObj)
	}
	select {}
}
