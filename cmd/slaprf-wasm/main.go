//go:build js && wasm

package main

import (
	"encoding/binary"
	"encoding/json"
	"math"
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
	// telemetryCb, when set, receives telemetry as binary batches (encodeTelemetryBatch) instead
	// of one JSON envelope per sample on `callback`.
	telemetryCb js.Value

	batchMu  sync.Mutex
	batching int                          // >0 while inside an ingest call: telemetry is buffered
	pending  []domain.TimerTelemetryFrame // buffered telemetry, flushed as one batch
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

// beginBatch buffers telemetry until the matching endBatch, so one ingest call (all Hub frames of
// a USB read) crosses the JS boundary once instead of once per sample.
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

// flushTelemetry delivers buffered telemetry (also called before any other event, so the JS side
// sees events in engine order).
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
	w.encBuf = encodeTelemetryBatch(w.encBuf[:0], w.pending)
	w.pending = w.pending[:0]
	u8 := js.Global().Get("Uint8Array").New(len(w.encBuf))
	js.CopyBytesToJS(u8, w.encBuf)
	w.batchMu.Unlock()
	cb.Invoke(u8)
}

// encodeTelemetryBatch appends the binary telemetry batch decoded by `decodeTelemetryBatch` in
// web/src/services/wasm_transport.ts (little-endian):
// [1][rssiCount][count u16] then per frame
// [timerId u8][0][batteryMv u16][seqNum u32][timestampUs f64][noiseFloorDbm f32][rssi f32 x rssiCount].
func encodeTelemetryBatch(dst []byte, frames []domain.TimerTelemetryFrame) []byte {
	const rssiCount = domain.MaxPilotPoolSize
	const recLen = 20 + 4*rssiCount
	n := len(frames)
	if n > 0xFFFF {
		n = 0xFFFF
	}
	need := 4 + n*recLen
	if cap(dst) < need {
		dst = make([]byte, 0, need*2)
	}
	b := dst[:need]
	b[0] = 1
	b[1] = rssiCount
	binary.LittleEndian.PutUint16(b[2:4], uint16(n))
	o := 4
	for i := 0; i < n; i++ {
		f := &frames[i]
		b[o] = f.TimerID
		b[o+1] = 0
		binary.LittleEndian.PutUint16(b[o+2:], f.BatteryMv)
		binary.LittleEndian.PutUint32(b[o+4:], f.SeqNum)
		binary.LittleEndian.PutUint64(b[o+8:], math.Float64bits(float64(f.TimestampUs)))
		binary.LittleEndian.PutUint32(b[o+16:], math.Float32bits(f.NoiseFloorDbm))
		for k := 0; k < rssiCount; k++ {
			binary.LittleEndian.PutUint32(b[o+20+4*k:], math.Float32bits(f.RSSI[k]))
		}
		o += recLen
	}
	return b
}

func (w *wasmStreamSubscriber) send(eventType string, payload interface{}) {
	if w.allow != nil && !w.allow() {
		return
	}
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
	if w.allow != nil && !w.allow() {
		return
	}
	w.batchMu.Lock()
	w.pending = append(w.pending, frame)
	immediate := w.batching == 0
	w.batchMu.Unlock()
	if immediate {
		w.flushTelemetry() // e.g. simulator ticks: deliver right away
	}
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

type persistedSimBundle struct {
	Engine  tracker.PersistedEngineState `json:"engine"`
	Options ingest.SimPersistedOptions   `json:"options"`
}

// bootStateString returns `globalThis.__slaprfBootState[field]` — the persisted engine state the
// TypeScript app loads from IndexedDB (web/src/services/engine_persistence.ts) and hands over
// before starting this runtime — or "" when absent. Persistence itself lives entirely in TS.
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
		return false // Saved by an older sim model: start from the default course instead
	}
	simEngine.RestoreState(payload.Engine, true)
	sim.RestoreOptions(payload.Options)
	return true
}

func loadRealFromBootState(realEngine *tracker.Engine) bool {
	raw := bootStateString("real")
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
	if !loadSimFromBootState(simEngine, sim) {
		sim.Prewarm(45 * time.Second)
	}
	_ = loadRealFromBootState(realEngine)
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

	laprfSrv := laprf.NewServer(simEngine) // api.NewServer re-points it at the active engine
	srv := api.NewServer(simEngine, sim, laprfSrv, realEngine)
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

	// onTelemetry(callback: ((batch: Uint8Array) => void) | null): binary telemetry batches
	// (see encodeTelemetryBatch). While set, telemetry no longer goes through onStream.
	apiObj.Set("onTelemetry", js.FuncOf(func(_ js.Value, args []js.Value) any {
		cb := js.Undefined()
		if len(args) > 0 && args[0].Type() == js.TypeFunction {
			cb = args[0]
		}
		simStreamSub.setTelemetryCallback(cb)
		realStreamSub.setTelemetryCallback(cb)
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
		realStreamSub.beginBatch()
		defer realStreamSub.endBatch()
		return hubRx.IngestPacket(buf, realEngine.NowUs())
	}))

	// ingestHubPackets(packed: Uint8Array) => number: every Hub frame of one USB read, packed as
	// [len u8][frame bytes] records, in one call (one copy, one arrival timestamp, and one
	// telemetry batch back to JS instead of per-frame boundary crossings).
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
		nowUs := realEngine.NowUs()
		realStreamSub.beginBatch()
		defer realStreamSub.endBatch()
		total := 0
		for o := 0; o < length; {
			n := int(buf[o])
			o++
			if o+n > length {
				break
			}
			total += hubRx.IngestPacket(buf[o:o+n], nowUs)
			o += n
		}
		return total
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
		if !ingest.SimStateCompatible(payload.Options) {
			return false
		}
		simEngine.RestoreState(payload.Engine, true)
		sim.RestoreOptions(payload.Options)
		return true
	}))

	registerLiveTimeAPI(apiObj, laprfSrv)

	js.Global().Set("slaprfWasm", apiObj)
	if cb := js.Global().Get("__slaprfWasmOnReady"); cb.Type() == js.TypeFunction {
		cb.Invoke(apiObj)
	}
	select {}
}
