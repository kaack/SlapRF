//go:build js && wasm

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"syscall/js"
	"time"

	"slaprf/internal/api"
	"slaprf/internal/domain"
	"slaprf/internal/ingest"
	"slaprf/internal/laprf"
	"slaprf/internal/tracker"
)

type wasmStreamSubscriber struct {
	mu       sync.RWMutex
	allow    func() bool
	callback js.Value
}

func (w *wasmStreamSubscriber) setCallback(cb js.Value) {
	w.mu.Lock()
	w.callback = cb
	w.mu.Unlock()
}

func (w *wasmStreamSubscriber) send(eventType string, payload interface{}) {
	if w.allow != nil && !w.allow() {
		return
	}
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
	w.send("telemetry", frame)
}

func (w *wasmStreamSubscriber) OnGateCrossing(event domain.GateCrossingEvent) {
	w.send("crossing", event)
}

func (w *wasmStreamSubscriber) OnDetectionFiltered(f domain.FilteredDetection) {
	w.send("filtered", f)
}

func (w *wasmStreamSubscriber) OnLapCompleted(lap domain.LapRecord, summaries []domain.PilotTrackSummary) {
	w.send("lap", map[string]interface{}{
		"lap":       lap,
		"summaries": summaries,
	})
}

func (w *wasmStreamSubscriber) OnConfigUpdated(pilots []domain.PilotSlot, gates []domain.TrackGate) {
	w.send("config", map[string]interface{}{
		"pilots": pilots,
		"gates":  gates,
	})
}

const (
	simStorageKey  = "slaprf.sim_state.v1"
	realStorageKey = "slaprf.real_state.v1"
)

type persistedSimBundle struct {
	Engine  tracker.PersistedEngineState `json:"engine"`
	Options ingest.SimPersistedOptions   `json:"options"`
}

func loadSimFromLocalStorage(simEngine *tracker.Engine, sim *ingest.TrackSimulator) bool {
	ls := js.Global().Get("localStorage")
	if ls.IsUndefined() || ls.IsNull() {
		return false
	}
	val := ls.Call("getItem", simStorageKey)
	if val.IsUndefined() || val.IsNull() {
		return false
	}
	raw := val.String()
	if raw == "" {
		return false
	}
	var payload persistedSimBundle
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return false
	}
	simEngine.RestoreState(payload.Engine, true)
	sim.RestoreOptions(payload.Options)
	return true
}

func loadRealFromLocalStorage(realEngine *tracker.Engine) bool {
	ls := js.Global().Get("localStorage")
	if ls.IsUndefined() || ls.IsNull() {
		return false
	}
	val := ls.Call("getItem", realStorageKey)
	if val.IsUndefined() || val.IsNull() {
		return false
	}
	raw := val.String()
	if raw == "" {
		return false
	}
	var state tracker.PersistedEngineState
	if err := json.Unmarshal([]byte(raw), &state); err != nil {
		return false
	}
	realEngine.RestoreState(state, false)
	return true
}

func main() {
	simEngine := tracker.NewEngine()
	realEngine := tracker.NewRealEngine()
	sim := ingest.NewTrackSimulator(simEngine)
	if !loadSimFromLocalStorage(simEngine, sim) {
		sim.Prewarm(45 * time.Second)
	}
	_ = loadRealFromLocalStorage(realEngine)
	sim.Start()

	hubRx := ingest.NewHubFrameDecoder(realEngine)
	var hubCmdMu sync.RWMutex
	var hubCmdCb js.Value
	hubRx.SetOutboundSender(func(pkt []byte) {
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

	laprfSrv := laprf.NewServer(":5403", simEngine)
	srv := api.NewServer(simEngine, sim, laprfSrv, "", realEngine)
	handler := srv.Handler()

	simStreamSub := &wasmStreamSubscriber{allow: func() bool { return sim.IsRunning() }}
	realStreamSub := &wasmStreamSubscriber{allow: func() bool { return !sim.IsRunning() }}
	simEngine.Subscribe(simStreamSub)
	realEngine.Subscribe(realStreamSub)

	apiObj := js.Global().Get("Object").New()

	// request(method: string, url: string, bodyStr?: string) => { status: number, body: string }
	apiObj.Set("request", js.FuncOf(func(_ js.Value, args []js.Value) any {
		method := http.MethodGet
		if len(args) > 0 {
			method = args[0].String()
		}
		url := "/api/state"
		if len(args) > 1 {
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
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		res := js.Global().Get("Object").New()
		res.Set("status", rec.Code)
		res.Set("body", rec.Body.String())
		return res
	}))

	// fetchBytes(url: string) => { status: number, bytes: Uint8Array, sha256: string }
	apiObj.Set("fetchBytes", js.FuncOf(func(_ js.Value, args []js.Value) any {
		url := ""
		if len(args) > 0 {
			url = args[0].String()
		}
		req := httptest.NewRequest(http.MethodGet, url, nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		raw := rec.Body.Bytes()
		u8 := js.Global().Get("Uint8Array").New(len(raw))
		js.CopyBytesToJS(u8, raw)

		res := js.Global().Get("Object").New()
		res.Set("status", rec.Code)
		res.Set("bytes", u8)
		res.Set("sha256", rec.Header().Get("X-SlapRF-SHA256"))
		return res
	}))

	// onStream(callback: ((envelopeJson: string) => void) | null)
	apiObj.Set("onStream", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) > 0 {
			simStreamSub.setCallback(args[0])
			realStreamSub.setCallback(args[0])
		} else {
			simStreamSub.setCallback(js.Undefined())
			realStreamSub.setCallback(js.Undefined())
		}
		return nil
	}))

	// setRunning(running: boolean)
	apiObj.Set("setRunning", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) > 0 {
			sim.SetRunning(args[0].Bool())
		}
		return nil
	}))

	// ingestHubPacket(bytes: Uint8Array) => number (frames decoded into realEngine)
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
		return hubRx.IngestPacket(buf, realEngine.NowUs())
	}))

	// onHubCommand(callback: ((pkt: Uint8Array) => void) | null)
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

	// pushHubChannels()
	apiObj.Set("pushHubChannels", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		hubRx.PushActiveChannels()
		return nil
	}))

	// exportRealState() => string (JSON of realEngine state)
	apiObj.Set("exportRealState", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		b, err := json.Marshal(realEngine.ExportState())
		if err != nil {
			return ""
		}
		return string(b)
	}))

	// restoreRealState(jsonStr: string) => boolean
	apiObj.Set("restoreRealState", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) == 0 || args[0].Type() != js.TypeString {
			return false
		}
		raw := args[0].String()
		if raw == "" {
			return false
		}
		var state tracker.PersistedEngineState
		if err := json.Unmarshal([]byte(raw), &state); err != nil {
			return false
		}
		realEngine.RestoreState(state, false)
		return true
	}))

	// exportSimState() => string (JSON of simulated engine + simulator options)
	apiObj.Set("exportSimState", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		payload := struct {
			Engine  tracker.PersistedEngineState `json:"engine"`
			Options ingest.SimPersistedOptions   `json:"options"`
		}{
			Engine:  simEngine.ExportState(),
			Options: sim.ExportOptions(),
		}
		b, err := json.Marshal(payload)
		if err != nil {
			return ""
		}
		return string(b)
	}))

	// restoreSimState(jsonStr: string) => boolean
	apiObj.Set("restoreSimState", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) == 0 || args[0].Type() != js.TypeString {
			return false
		}
		raw := args[0].String()
		if raw == "" {
			return false
		}
		var payload struct {
			Engine  tracker.PersistedEngineState `json:"engine"`
			Options ingest.SimPersistedOptions   `json:"options"`
		}
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return false
		}
		simEngine.RestoreState(payload.Engine, true)
		sim.RestoreOptions(payload.Options)
		return true
	}))

	js.Global().Set("slaprfWasm", apiObj)
	if cb := js.Global().Get("__slaprfWasmOnReady"); cb.Type() == js.TypeFunction {
		cb.Invoke(apiObj)
	}
	select {}
}
