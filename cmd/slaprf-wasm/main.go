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
	sim      *ingest.TrackSimulator
	callback js.Value
}

func (w *wasmStreamSubscriber) setCallback(cb js.Value) {
	w.mu.Lock()
	w.callback = cb
	w.mu.Unlock()
}

func (w *wasmStreamSubscriber) send(eventType string, payload interface{}) {
	if !w.sim.IsRunning() {
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

func main() {
	simEngine := tracker.NewEngine()
	sim := ingest.NewTrackSimulator(simEngine)
	sim.Prewarm(45 * time.Second)
	sim.Start()

	laprfSrv := laprf.NewServer(":5403", simEngine)
	srv := api.NewServer(simEngine, sim, laprfSrv, "", simEngine)
	handler := srv.Handler()

	streamSub := &wasmStreamSubscriber{sim: sim}
	simEngine.Subscribe(streamSub)

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
			streamSub.setCallback(args[0])
		} else {
			streamSub.setCallback(js.Undefined())
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

	js.Global().Set("slaprfWasm", apiObj)
	if cb := js.Global().Get("__slaprfWasmOnReady"); cb.Type() == js.TypeFunction {
		cb.Invoke(apiObj)
	}
	select {}
}
