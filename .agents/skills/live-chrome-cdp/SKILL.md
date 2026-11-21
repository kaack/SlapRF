---
name: live-chrome-cdp
description: >-
  Attach to the user's live Chrome browser over Chrome DevTools Protocol (CDP) to collect runtime
  evidence (DOM, canvas coordinates, JS store, WebSerial, and WASM state) before modifying source
  code, and verify UI fixes live. Activate whenever debugging UI bugs, visual glitches, animations,
  or runtime state discrepancies in the web app or docs.
---

# Live Chrome CDP Debugging (Evidence-First)

When diagnosing a web UI, canvas, WASM, or state bug, **never guess from static code**. Attach to the live Chrome window over CDP, measure the exact runtime state where expected and actual behavior diverge, apply the fix, and re-verify in the live browser.

## 1. Enable Remote Debugging & Start the Persistent Bridge

1. Ensure Chrome has remote debugging enabled (`chrome://inspect/#remote-debugging` -> check **Discover network targets** / enable local debugging so Chrome writes `DevToolsActivePort`, or launch Chrome with `--remote-debugging-port=9222`).
2. Start [cdp_daemon.ps1](./scripts/cdp_daemon.ps1) once as a background daemon (`http://127.0.0.1:9224/`). It opens **one** persistent WebSocket to Chrome so the user clicks **Allow** at most once per session:
   ```powershell
   # Windows PowerShell (or pwsh on macOS/Linux)
   powershell -NoProfile -ExecutionPolicy Bypass -File ".agents/skills/live-chrome-cdp/scripts/cdp_daemon.ps1"
   ```

## 2. Inspect Live Targets & Evaluate Runtime State

Always invoke [cdp.ps1](./scripts/cdp.ps1) with `-NoProfile -ExecutionPolicy Bypass -File` and an explicit `-UrlMatch` matching the active port (`*8090*`, `*8099*`, `*1313*`, etc.):

```powershell
# 1. List open Chrome tabs to find the exact URL (and check for duplicate SlapRF tabs)
powershell -NoProfile -ExecutionPolicy Bypass -File ".agents/skills/live-chrome-cdp/scripts/cdp.ps1" -ListTargets

# 2. Evaluate JS in the matching tab (returns strings or JSON-serialized objects)
powershell -NoProfile -ExecutionPolicy Bypass -File ".agents/skills/live-chrome-cdp/scripts/cdp.ps1" -UrlMatch "*8090*" -Eval "JSON.stringify({ hash: location.hash, hidden: document.hidden, hasWasm: Boolean(window.slaprfWasm) })"

# 3. Hard-reload (ignoreCache: true) and evaluate after reload
powershell -NoProfile -ExecutionPolicy Bypass -File ".agents/skills/live-chrome-cdp/scripts/cdp.ps1" -UrlMatch "*8090*" -Reload -Eval "location.href"
```

## 3. Critical Operational Rules & Pitfalls

1. **Never `await requestAnimationFrame` in Occluded Tabs**:
   - When the user focuses their IDE/terminal, Chrome throttles or completely pauses `requestAnimationFrame` in occluded browser windows.
   - An expression like `await new Promise(r => requestAnimationFrame(r))` will hang `Runtime.evaluate` until the tab is brought to the foreground.
   - Instead, hook draw/API methods (`CanvasRenderingContext2D.prototype.clearRect`, `window.slaprfWasm.request`, etc.), wait with `await new Promise(r => setTimeout(r, 1500))`, restore the originals, and return `JSON.stringify(...)`.
2. **Clear Service Worker Cache When Serving Static `./_site`**:
   - Production builds (`cmd/build-web`) generate `sw.js`, which precaches `dist/app.js` and `wasm/slaprf.wasm`. Before reloading a static `./_site` preview server, unregister service workers and clear `caches`:
     ```javascript
     (async () => {
       for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
       for (const k of await caches.keys()) await caches.delete(k);
       return "cleared";
     })()
     ```
   - *(Tip: `cmd/devserver` does not register a Service Worker and serves with `Cache-Control: no-store`.)*
3. **Multi-Tab Writer Lock (`SlapRF is already open in another tab`)**:
   - In WASM Demo mode, only one tab holds the `navigator.locks` writer lock; secondary tabs pause before booting `window.slaprfWasm`. Always run `-ListTargets` and target the active tab URL with a specific `-UrlMatch` (for example `-UrlMatch "*8099/#/debug*"`).
4. **Profile Main-Thread Stalls & WASM Calls Directly**:
   - Wrap `window.slaprfWasm.request` or attach a `PerformanceObserver({ type: "longtask" })` over a 2-second window to catch unexpected synchronous JSON serialization or polling leaks immediately.
