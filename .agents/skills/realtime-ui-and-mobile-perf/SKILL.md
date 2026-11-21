---
name: realtime-ui-and-mobile-perf
description: >-
  Build jitter-free 60 FPS real-time signal charts, leak-free cached view lifecycles, gesture-safe
  Web Audio/Speech callouts, and responsive mobile/touch interactions in SlapRF's TypeScript SPA.
  Activate when working on canvas charts, high-rate telemetry UI, view navigation, audio/TTS, or
  mobile layouts (web/src/ and web/styles/).
---

# Real-Time 60 FPS UI, Lifecycle & Mobile Touch Engineering

SlapRF's frontend (`web/src/`) is a zero-framework TypeScript SPA rendering continuous 50-100 Hz multi-timer telemetry at 60/120 FPS on desktop and mobile devices. Follow these patterns to prevent frame drops, chart jitter, memory/timer leaks, and touch conflicts.

## 1. Cached View Lifecycle (`onActivate` / `onDeactivate`)

`AppShell` caches mounted top-level views across route switches and invokes `view.onDeactivate()` when leaving a route and `view.onActivate()` when returning:
- **Stop background work in `onDeactivate()`**: Cancel `requestAnimationFrame` loops, stop high-rate hardware streams (`LIVE 0`, `SCAN STOP`, RotorHazard debug stream), clear view-local polling intervals, and gate incoming console/store callbacks behind an `isActive` / `viewActive` flag so offscreen views never mutate hidden DOM or trigger background API requests.
- **Resume cleanly in `onActivate()`**: Mark dirty flags, re-render current store state, and restart the `requestAnimationFrame` loop.

---

## 2. Zero Main-Thread Stalls on Telemetry Hot Paths

1. **Never Poll Full `/v1/state` or Unfiltered `/v1/status` Continuously**:
   - Full state JSON includes every tournament heat, practice session, crossing, and lap (~100s of KB, costing `20-30 ms` of synchronous JSON serialization in WASM and dropping 60 Hz frames).
   - While the real-time stream (`WebSocket` or `wasm.onStream`) is connected, always poll `/v1/status?lite=1` (`< 1 ms`) and read `pilots`, `detectedTimers`, and `nodes` directly from `AppStore` in RAM.
2. **Targeted Store Subscriptions**:
   - Raw 50 Hz telemetry is intentionally **not** a `store.subscribe(...)` topic: canvases pull `store.historyFor(gateId)` inside `requestAnimationFrame`, while form/table components subscribe only to structural topics (`"config"`, `"laps"`, `"race"`, `"practice"`, `"selection"`).
   - Avoid replacing interactive DOM nodes (`innerHTML`) on fast timers while hovered, or clicks will be swallowed (`!el.matches(":hover")` + diffing `lastHtml` before assigning `innerHTML`).

---

## 3. Silky-Smooth 60/120 FPS Signal Charts (`PilotRssiChart` & `DebugView`)

1. **Constant-Velocity Playheads**:
   - Drive live scrolling right-edges from `store.smoothLatestTimestampUs` (or `SignalRingBuffer.smoothLatestN`), which advances monotonically with `performance.now()` using a gentle PLL trim rather than stepping only when 20-40 ms packet batches arrive.
2. **Deterministic `Auto X` Windows & Decimation Buckets**:
   - Never compute `Auto X` window duration from noisy wall-clock sample arrival intervals (`tMs` deltas), which causes integer rounding flips and horizontal X-axis jumping. Keep `Auto X` at a fixed deterministic duration (`15 s`).
   - Compute zoomed-out decimation `step` from `windowUs` and `plotW` (never from fluctuating `to - from` sample counts) and bucket samples by immutable `Math.floor(fr.timestampUs / bucketUs)` (never by 8-bit wrapping `seqNum` or shifting array index `i`), preserving each bucket's peak RSSI.

---

## 4. Mobile Layout & Touch Gesture Rules (`<= 860px`, down to `320px`)

1. **Canvas Touch vs AppShell Swipe Navigation**:
   - `AppShell` supports 1-finger horizontal swipe navigation across primary tabs on mobile, **except** inside interactive surfaces (`canvas`, `[data-signal-canvas]`, `.scope-canvas`, bracket diagrams, horizontal scroll wrappers).
   - Multi-touch chart gestures (`web/src/core/chart_pinch.ts`) distinguish directional 2-finger X/Y pinch-zoom from parallel 2-finger vertical page scrolling (`scrollOuterPageBy`). Preserve this behavior whenever editing chart pointer handlers.
2. **Responsive Containers & Bottom-Sheet Drawers**:
   - Wrap wide data tables in horizontal overflow shells so narrow viewports (`320px..390px`) never blow out page width.
   - Lock header/chip heights (`36px` / `46px`) across empty/populated states so toggling filters or timer selection never causes vertical layout shift.

---

## 5. Browser Autoplay & SpeechSynthesis / Web Audio Unlock

Browsers (macOS Safari/Chrome and Windows Chrome/Edge) block `speechSynthesis.speak()` (`error: "not-allowed"`) and `AudioContext` until the first user gesture (`click`, `pointerup`, `touchend`, `keydown`):
- Any UI control that enables audio/announcer from a user click must call synchronous `wakeAudio()` / `toggleEnabledFromGesture()` inside the gesture turn before `await`ing network/WASM calls.
- Keep `PiperNeuralTts.isVoiceLoaded()` fallback active so an uncached neural voice model download never blocks immediate callouts.
