interface GateLine {
  p1x: number;
  p1y: number;
  p2x: number;
  p2y: number;
  dirSign: number;
  bandHalfWidthNorm: number;
  locked: boolean;
}

interface CameraConfig {
  targetFps: number;
  shutterUs: number;
  zoomRatio?: number;
  focusMode?: string;
  focusLocked: boolean;
  motionModel: string;
  sensitivity: number;
  lookbackHalfMs: number;
  rollingShutterComp: boolean;
}

interface LinkConfig {
  slaprfUrl: string;
  basicAuth: string;
  gateFilter: number;
  pilotFilter: number;
  exposeLan: boolean;
}

interface CameraStatus {
  active: boolean;
  simulated?: boolean;
  frameWidth: number;
  frameHeight: number;
  actualFps: number;
  supportedFps: number[];
  shutterUs: number;
  exposureUs?: number;
  iso?: number;
  zoomRatio?: number;
  minZoomRatio?: number;
  focusMode?: string;
  focusDistDiopters?: number;
  focusLocked: boolean;
  ringCapacity: number;
  ringFilled: number;
  ringSpanMs: number;
  opencvVersion: string;
  lastError?: string;
}

interface SyncStatus {
  connected: boolean;
  slaprfUrl: string;
  clockLocked: boolean;
  clockOffsetUs: number;
  minRttUs: number;
  syncErrorBoundMs: number;
  lastError?: string;
  pilots?: Array<{ slotIndex: number; callsign: string; frequencyMhz: number }>;
  gates?: Array<{ gateId: number; name: string; role: string }>;
  liveRssi?: Array<{ slotIndex: number; callsign: string; rssiDbm: number }>;
  lanUrls?: string[];
}

interface FrameObservation {
  index: number;
  frameWidth: number;
  frameHeight: number;
  hasBlob: boolean;
  onTrack: boolean;
  blobCx: number;
  blobCy: number;
  blobBoxX: number;
  blobBoxY: number;
  blobBoxW: number;
  blobBoxH: number;
  blobAreaPx: number;
  flowVx: number;
  flowVy: number;
  signedDistPx: number;
  frameTimestampUs: number;
  relToRfMs: number;
}

interface PassSummary {
  passId: number;
  createdAt: string;
  gateId: number;
  gateName: string;
  slotIndex: number;
  callsign: string;
  frequencyMhz: number;
  peakRssiDbm: number;
  holdMs: number;
  estimatedSpeedMph: number;
  status: "AUTO" | "MANUAL" | "NEEDS_MANUAL" | "EXCLUDED";
  confidence: number;
  rfTimestampUs: number;
  camTimestampUs?: number;
  crossingFrameIdx: number;
  frameCount: number;
  gateBiasMs?: number;
  gateBiasFrames?: number;
  spatialBiasCm?: number;
  lapNumber?: number;
  lapRfSec?: number;
  lapCamSec?: number;
  lapDeltaMs?: number;
}

interface PassRecord extends PassSummary {
  autoStatus: string;
  motionModel: string;
  gateSnapshot: GateLine;
  autoCrossingFrameIdx: number;
  autoFractionalFrame: number;
  manualFrameIdx?: number;
  rfNearestFrameIdx: number;
  framesPurged?: boolean;
  flowSpeedPxPerFr?: number;
  blobAreaPx?: number;
  rssiTrace?: Array<{ timestampUs: number; relMs: number; rssiDbm: number }>;
  frames: FrameObservation[];
}

interface SessionStats {
  totalPasses: number;
  validPasses: number;
  manualPasses: number;
  needsManualCount: number;
  excludedCount: number;
  meanBiasMs: number;
  stdBiasMs: number;
  p95AbsBiasMs: number;
  maxAbsBiasMs: number;
  meanBiasCm: number;
  lapCount: number;
  meanLapDeltaMs: number;
  stdLapDeltaMs: number;
  p95AbsLapDeltaMs: number;
  maxAbsLapDeltaMs: number;
  histogram: Array<{ label: string; minMs: number; maxMs: number; count: number }>;
  speedBuckets: Array<{ label: string; count: number; meanBiasMs: number; stdBiasMs: number }>;
}

interface AppState {
  version: string;
  gate: GateLine;
  camera: CameraConfig;
  link: LinkConfig;
  camInfo: CameraStatus;
  sync: SyncStatus;
  stats: SessionStats;
  passes: PassSummary[];
}

declare global {
  interface Window {
    GateCamAndroid?: {
      setPreviewVisible(visible: boolean): void;
      setPreviewBounds(leftCssPx: number, topCssPx: number, widthCssPx: number, heightCssPx: number, dpr: number): void;
    };
  }
}

const isNativeUnderlay = typeof window.GateCamAndroid !== "undefined";
if (isNativeUnderlay) {
  document.documentElement.classList.add("is-native-underlay");
  document.body.classList.add("is-native-underlay");
}

let state: AppState | null = null;
let route: "live" | "inspector" | "stats" = "live";
let inspectPassId = 0;
let inspectPass: PassRecord | null = null;
let inspectFrameIdx = 0;
let showGateOverlay = true;
let showBlobOverlay = true;
let showMaskMode = false;
let slowPlayTimer: number | null = null;
let setupOpen = false;
let dragHandle: "p1" | "p2" | null = null;
let previewPollTimer: number | null = null;
let tapFocusSpot: { x: number; y: number } | null = null;
let tapFocusTimer: number | null = null;

const appRoot = document.getElementById("app")!;

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtSigned(v: number | undefined | null, digits = 1, unit = "ms"): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)} ${unit}`;
}

async function apiJSON<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(txt || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

function syncRouteFromHash(): void {
  const h = window.location.hash || "#/";
  stopSlowPlay();
  if (h.startsWith("#/pass/")) {
    const id = parseInt(h.slice("#/pass/".length), 10);
    if (id > 0) {
      route = "inspector";
      if (inspectPassId !== id) {
        inspectPassId = id;
        inspectPass = null;
        void loadPassDetail(id);
      }
      updateNativeUnderlayVisibility();
      render();
      return;
    }
  }
  if (h === "#/stats") {
    route = "stats";
    updateNativeUnderlayVisibility();
    render();
    return;
  }
  route = "live";
  updateNativeUnderlayVisibility();
  render();
}

async function loadPassDetail(passId: number): Promise<void> {
  try {
    const p = await apiJSON<PassRecord>("GET", `/v1/gatecam/passes/${passId}`);
    if (inspectPassId === passId) {
      inspectPass = p;
      inspectFrameIdx = p.crossingFrameIdx ?? 0;
      render();
    }
  } catch (err) {
    console.error("Failed to load pass detail:", err);
  }
}

function updateNativeUnderlayVisibility(): void {
  const isLive = route === "live" && !setupOpen;
  document.documentElement.classList.toggle("route-live", route === "live");
  document.body.classList.toggle("route-live", route === "live");
  if (window.GateCamAndroid) {
    window.GateCamAndroid.setPreviewVisible(isLive);
    if (isLive) {
      requestAnimationFrame(syncNativePreviewBounds);
    }
  }
  if (!isNativeUnderlay) {
    if (route === "live" && previewPollTimer === null) {
      previewPollTimer = window.setInterval(() => {
        const img = document.querySelector<HTMLImageElement>("[data-remote-preview]");
        if (img && route === "live") {
          img.src = `/v1/gatecam/preview.jpg?t=${Date.now()}`;
        }
      }, 180);
    } else if (route !== "live" && previewPollTimer !== null) {
      clearInterval(previewPollTimer);
      previewPollTimer = null;
    }
  }
}

function syncNativePreviewBounds(): void {
  if (!window.GateCamAndroid || route !== "live") return;
  const stage = document.querySelector<HTMLElement>(".viewfinder-stage");
  if (!stage) return;
  const r = stage.getBoundingClientRect();
  window.GateCamAndroid.setPreviewBounds(r.left, r.top, r.width, r.height, window.devicePixelRatio || 1);
}

window.addEventListener("resize", () => requestAnimationFrame(syncNativePreviewBounds));
window.addEventListener("hashchange", syncRouteFromHash);

window.addEventListener("keydown", (e) => {
  if (route !== "inspector" || !inspectPass || setupOpen) return;
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    stepInspectorFrame(-1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    stepInspectorFrame(1);
  }
});

function stopSlowPlay(): void {
  if (slowPlayTimer !== null) {
    clearInterval(slowPlayTimer);
    slowPlayTimer = null;
  }
}

function toggleSlowPlay(): void {
  if (slowPlayTimer !== null) {
    stopSlowPlay();
    render();
    return;
  }
  slowPlayTimer = window.setInterval(() => {
    if (!inspectPass || inspectPass.frames.length === 0) {
      stopSlowPlay();
      return;
    }
    inspectFrameIdx = (inspectFrameIdx + 1) % inspectPass.frames.length;
    renderInspectorDynamicOnly();
  }, 110);
  render();
}

function stepInspectorFrame(delta: number): void {
  stopSlowPlay();
  if (!inspectPass || inspectPass.frames.length === 0) return;
  inspectFrameIdx = Math.max(0, Math.min(inspectPass.frames.length - 1, inspectFrameIdx + delta));
  renderInspectorDynamicOnly();
}

function currentFrameDims(): { w: number; h: number } {
  const w = state?.camInfo?.frameWidth || 640;
  const h = state?.camInfo?.frameHeight || 360;
  return { w, h };
}

function fmtCamTelemetry(ci: CameraStatus): string {
  const parts: string[] = [];
  if (ci.exposureUs && ci.exposureUs > 0) {
    if (ci.exposureUs <= 8000) {
      parts.push(`1/${Math.max(100, Math.round(1_000_000 / ci.exposureUs))}s`);
    } else {
      parts.push(`${(ci.exposureUs / 1000).toFixed(1)}ms`);
    }
  }
  if (ci.iso && ci.iso > 0) {
    parts.push(`ISO ${ci.iso}`);
  }
  parts.push(`${ci.actualFps.toFixed(0)}fps`);
  parts.push(`${(ci.ringSpanMs / 1000).toFixed(1)}s`);
  return parts.join(" · ");
}

function gateGeometrySVG(g: GateLine, interactive: boolean, W = 640, H = 360): string {
  const x1 = g.p1x * W;
  const y1 = g.p1y * H;
  const x2 = g.p2x * W;
  const y2 = g.p2y * H;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const dir = g.dirSign < 0 ? -1 : 1;
  const nx = dir * (dy / len);
  const ny = -dir * (dx / len);
  const bandPx = (g.bandHalfWidthNorm || 0.18) * W;

  const mx = (x1 + x2) * 0.5;
  const my = (y1 + y2) * 0.5;
  const ax = mx + nx * 56;
  const ay = my + ny * 56;
  // Arrowhead wings
  const wx1 = ax - nx * 12 + (dx / len) * 7;
  const wy1 = ay - ny * 12 + (dy / len) * 7;
  const wx2 = ax - nx * 12 - (dx / len) * 7;
  const wy2 = ay - ny * 12 - (dy / len) * 7;

  return `
    <!-- Analysis Band (±bandPx) -->
    <line x1="${(x1 - nx * bandPx).toFixed(1)}" y1="${(y1 - ny * bandPx).toFixed(1)}"
          x2="${(x2 - nx * bandPx).toFixed(1)}" y2="${(y2 - ny * bandPx).toFixed(1)}"
          stroke="rgba(34,211,238,0.32)" stroke-width="1.5" stroke-dasharray="6 5" />
    <line x1="${(x1 + nx * bandPx).toFixed(1)}" y1="${(y1 + ny * bandPx).toFixed(1)}"
          x2="${(x2 + nx * bandPx).toFixed(1)}" y2="${(y2 + ny * bandPx).toFixed(1)}"
          stroke="rgba(34,211,238,0.32)" stroke-width="1.5" stroke-dasharray="6 5" />

    <!-- Primary Gate Plane Sightline -->
    <line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"
          stroke="#22d3ee" stroke-width="2.6" />

    <!-- Flight Direction Normal Arrow -->
    <g data-flip-dir="1" style="cursor:${interactive ? "pointer" : "default"}">
      <line x1="${mx.toFixed(1)}" y1="${my.toFixed(1)}" x2="${ax.toFixed(1)}" y2="${ay.toFixed(1)}"
            stroke="#fbbf24" stroke-width="3" />
      <polygon points="${ax.toFixed(1)},${ay.toFixed(1)} ${wx1.toFixed(1)},${wy1.toFixed(1)} ${wx2.toFixed(1)},${wy2.toFixed(1)}"
               fill="#fbbf24" />
      <circle cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="18" fill="transparent" />
    </g>

    ${
      interactive
        ? `
      <!-- Draggable Endpoints P1 & P2 -->
      <g data-handle="p1" style="cursor:${g.locked ? "not-allowed" : "grab"}">
        <circle cx="${x1.toFixed(1)}" cy="${y1.toFixed(1)}" r="22" fill="rgba(34,211,238,0.14)" stroke="#22d3ee" stroke-width="2" />
        <circle cx="${x1.toFixed(1)}" cy="${y1.toFixed(1)}" r="4" fill="#22d3ee" />
        <text x="${(x1 + 14).toFixed(1)}" y="${(y1 + 4).toFixed(1)}" fill="#22d3ee" font-size="11" font-family="monospace" font-weight="bold">P1</text>
      </g>
      <g data-handle="p2" style="cursor:${g.locked ? "not-allowed" : "grab"}">
        <circle cx="${x2.toFixed(1)}" cy="${y2.toFixed(1)}" r="22" fill="rgba(34,211,238,0.14)" stroke="#22d3ee" stroke-width="2" />
        <circle cx="${x2.toFixed(1)}" cy="${y2.toFixed(1)}" r="4" fill="#22d3ee" />
        <text x="${(x2 + 14).toFixed(1)}" y="${(y2 + 4).toFixed(1)}" fill="#22d3ee" font-size="11" font-family="monospace" font-weight="bold">P2</text>
      </g>
      ${
        tapFocusSpot
          ? `<rect x="${(tapFocusSpot.x * W - 20).toFixed(1)}" y="${(tapFocusSpot.y * H - 20).toFixed(1)}" width="40" height="40" rx="4"
                   fill="none" stroke="#10b981" stroke-width="2" />`
          : ""
      }`
        : ""
    }
  `;
}

function renderTopBar(): string {
  if (!state) return "";
  const sync = state.sync;
  const dotCls = sync.connected && sync.clockLocked ? "ok" : sync.connected ? "warn" : "err";
  const syncLabel = sync.clockLocked ? `±${sync.syncErrorBoundMs.toFixed(2)}ms` : "syncing";
  const gateFilterTxt = state.link.gateFilter > 0 ? `Gate #${state.link.gateFilter}` : "All Gates";
  return `
    <header class="topbar">
      <div class="topbar-left">
        <span class="brand">SlapRF <span class="brand-accent">GateCam</span></span>
        <span class="pill" title="${esc(sync.lastError || sync.slaprfUrl)}">
          <span class="dot ${dotCls}"></span>
          <span>${esc(sync.slaprfUrl.replace(/^https?:\/\//, ""))}</span>
        </span>
        <span class="pill">⏱ ${syncLabel}</span>
        <span class="pill">🎯 ${esc(gateFilterTxt)}</span>
      </div>
      <div class="topbar-right">
        ${state.camInfo.simulated ? `<button class="amber" data-act="sim-pass">+ Sim Pass</button>` : ""}
        <button class="${route === "live" ? "primary" : ""}" data-nav="#/">📷 Live</button>
        <button class="${route === "stats" ? "primary" : ""}" data-nav="#/stats">📊 Stats (${state.stats.validPasses})</button>
        <button data-act="open-setup">⚙ Setup</button>
      </div>
    </header>
  `;
}

function renderStatusBadge(status: PassSummary["status"], conf: number): string {
  if (status === "AUTO") return `<span class="badge auto">AUTO ${Math.round(conf * 100)}%</span>`;
  if (status === "MANUAL") return `<span class="badge manual">MANUAL</span>`;
  if (status === "EXCLUDED") return `<span class="badge excl">EXCLUDED</span>`;
  return `<span class="badge warn">PICK FRAME</span>`;
}

function renderLiveView(): string {
  if (!state) return "";
  const g = state.gate;
  const cam = state.camera;
  const ci = state.camInfo;
  const { w: fw, h: fh } = currentFrameDims();
  const st = state.stats;
  const rssiItems = state.sync.liveRssi ?? [];
  const rssiHtml =
    rssiItems.length > 0
      ? rssiItems.map((r) => `${esc(r.callsign)} <b>${r.rssiDbm.toFixed(0)} dBm</b>`).join(" · ")
      : `Waiting for 50 Hz RSSI...`;
  const minZoom = ci.minZoomRatio ?? 1.0;
  const curZoom = ci.zoomRatio ?? cam.zoomRatio ?? 1.0;
  const hasUltraWide = minZoom > 0.3 && minZoom < 0.9;
  const isUltra = hasUltraWide && curZoom < 0.85;
  const curFocusMode = ci.focusMode || cam.focusMode || "gate";
  const supFps = ci.supportedFps && ci.supportedFps.length > 0 ? ci.supportedFps : [60, 120];
  const isHighSpeed = cam.targetFps >= 120 && supFps.includes(120);

  return `
    <div class="live-grid">
      <div class="cam-column">
        <div class="viewfinder-wrap">
          <div class="viewfinder-stage" id="live-stage" style="aspect-ratio:${fw} / ${fh}">
            ${!isNativeUnderlay ? `<img class="preview-img" data-remote-preview src="/v1/gatecam/preview.jpg?t=${Date.now()}" alt="Gate preview" />` : ""}
            <svg class="gate-svg" id="live-gate-svg" viewBox="0 0 ${fw} ${fh}" preserveAspectRatio="none">
              ${gateGeometrySVG(g, true, fw, fh)}
            </svg>
          </div>
        </div>
        <div class="hud-rssi-bar">
          <span class="hud-rssi-text" data-hud-rssi>${rssiHtml}</span>
          <span class="hud-ring-text" data-hud-ring>${fmtCamTelemetry(ci)} ●</span>
        </div>
        <div class="cam-controls">
          <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;">
            ${
              hasUltraWide
                ? `<div class="seg-group" title="Camera Lens Field of View (60 fps mode)">
                     <button class="${isUltra ? "active" : ""}" data-zoom="${minZoom.toFixed(2)}">0.5x</button>
                     <button class="${!isUltra ? "active" : ""}" data-zoom="1.0">1x</button>
                   </div>`
                : ""
            }
            <div class="seg-group" title="Camera Capture Rate">
              <button class="${cam.targetFps === 60 ? "active" : ""}" data-fps="60">60</button>
              ${supFps.includes(120) ? `<button class="${cam.targetFps === 120 ? "active" : ""}" data-fps="120">${supFps.includes(240) ? "120" : "120 fps"}</button>` : ""}
              ${supFps.includes(240) ? `<button class="${cam.targetFps === 240 ? "active" : ""}" data-fps="240">240 fps</button>` : ""}
            </div>
            ${
              isHighSpeed
                ? `<select disabled title="Android High-Speed 120/240 fps mode uses automatic exposure">
                     <option selected>Shutter: Auto (HS)</option>
                   </select>`
                : `<select data-shutter title="Shutter-Priority Exposure (Auto-ISO)">
                     <option value="0" ${cam.shutterUs === 0 ? "selected" : ""}>Shutter: Auto</option>
                     <option value="4000" ${cam.shutterUs === 4000 ? "selected" : ""}>1/250s</option>
                     <option value="2000" ${cam.shutterUs === 2000 ? "selected" : ""}>1/500s</option>
                     <option value="1000" ${cam.shutterUs === 1000 ? "selected" : ""}>1/1000s</option>
                     <option value="500" ${cam.shutterUs === 500 ? "selected" : ""}>1/2000s</option>
                     <option value="250" ${cam.shutterUs === 250 ? "selected" : ""}>1/4000s</option>
                   </select>`
            }
            <select data-focus-mode title="Fixed/Locked Focus (Prevents Focus Hunting)">
              <option value="gate" ${curFocusMode === "gate" ? "selected" : ""}>Focus: Gate (3m)</option>
              <option value="near" ${curFocusMode === "near" ? "selected" : ""}>Focus: Near (1m)</option>
              <option value="inf" ${curFocusMode === "inf" ? "selected" : ""}>Focus: Far (∞)</option>
              <option value="tap" ${curFocusMode === "tap" ? "selected" : ""}>Focus: Tap Lock</option>
            </select>
            <button class="${curFocusMode === "tap" ? "primary" : ""}" data-act="lock-af" title="Focus once on the Gate Line (or tap anywhere on camera) and lock">🎯 Focus</button>
            <button data-act="flip-dir">⇄ Dir</button>
            <button class="${g.locked ? "amber" : ""}" data-act="toggle-lock">${g.locked ? "🔒 Locked" : "🔓 Line"}</button>
          </div>
        </div>
      </div>

      <aside class="side-panel">
        <div class="section-title">Session Accuracy (${st.validPasses} Valid / ${st.totalPasses} Total)</div>
        <div class="kpi-grid">
          <div class="kpi-card">
            <div class="kpi-label">Gate Bias (μ)</div>
            <div class="kpi-val">${st.validPasses > 0 ? fmtSigned(st.meanBiasMs, 2) : "—"}</div>
            <div class="kpi-sub">${st.validPasses > 0 ? fmtSigned(st.meanBiasCm, 1, "cm") : "t_RF - t_cam"}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Pass Jitter (σ)</div>
            <div class="kpi-val">${st.validPasses > 1 ? `±${st.stdBiasMs.toFixed(2)} ms` : "—"}</div>
            <div class="kpi-sub">P95: ${st.validPasses > 0 ? `${st.p95AbsBiasMs.toFixed(1)} ms` : "—"}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Lap Error (σ)</div>
            <div class="kpi-val">${st.lapCount > 1 ? `±${st.stdLapDeltaMs.toFixed(2)} ms` : "—"}</div>
            <div class="kpi-sub">${st.lapCount} paired lap${st.lapCount === 1 ? "" : "s"}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">P95 |ΔLap|</div>
            <div class="kpi-val">${st.lapCount > 0 ? `${st.p95AbsLapDeltaMs.toFixed(2)} ms` : "—"}</div>
            <div class="kpi-sub">Max: ${st.lapCount > 0 ? `${st.maxAbsLapDeltaMs.toFixed(1)} ms` : "—"}</div>
          </div>
        </div>

        <div class="section-title">Recent Crossings (Tap to Scrub Frames)</div>
        <div class="pass-list">
          ${
            state.passes.length === 0
              ? `<div style="padding:18px 8px;color:var(--muted);text-align:center;line-height:1.5;">
                   Align <b>P1–P2</b> with both gate posts and fly a pass.<br/>
                   GateCam automatically slices ±${cam.lookbackHalfMs} ms around each SlapRF crossing.
                 </div>`
              : state.passes
                  .map(
                    (p) => `
                <div class="pass-card" data-open-pass="${p.passId}">
                  <img class="pass-thumb" src="/v1/gatecam/passes/${p.passId}/thumb.jpg" alt="Pass #${p.passId}" loading="lazy" />
                  <div class="pass-meta">
                    <div class="pass-row1">
                      <span>#${p.passId} ${esc(p.callsign)}</span>
                      ${renderStatusBadge(p.status, p.confidence)}
                    </div>
                    <div class="pass-row2">
                      Bias: <b style="color:var(--text)">${fmtSigned(p.gateBiasMs, 2)}</b>
                      ${p.gateBiasFrames !== undefined ? `(${fmtSigned(p.gateBiasFrames, 1, "fr")})` : ""}
                    </div>
                    <div class="pass-row3">
                      ${
                        p.lapNumber && p.lapRfSec !== undefined
                          ? `Lap #${p.lapNumber}: ${p.lapRfSec.toFixed(3)}s (Δ ${fmtSigned(p.lapDeltaMs, 2)})`
                          : `Peak ${p.peakRssiDbm.toFixed(1)} dBm · Hold ${p.holdMs.toFixed(0)}ms`
                      }
                    </div>
                  </div>
                </div>`
                  )
                  .join("")
          }
        </div>
      </aside>
    </div>
  `;
}

function renderInspectorTimelineSVG(p: PassRecord, curIdx: number): string {
  const W = 600;
  const H = 82;
  const frames = p.frames;
  if (!frames || frames.length === 0) return "";
  const minRel = frames[0].relToRfMs;
  const maxRel = frames[frames.length - 1].relToRfMs;
  const span = Math.max(10, maxRel - minRel);
  const xOfMs = (ms: number) => 12 + ((ms - minRel) / span) * (W - 24);

  // RSSI polyline (-96 .. -30 dBm)
  let rssiPts = "";
  for (const s of p.rssiTrace ?? []) {
    const x = xOfMs(s.relMs);
    const norm = Math.max(0, Math.min(1, (s.rssiDbm - -96) / 62));
    const y = H - 14 - norm * (H - 26);
    rssiPts += `${x.toFixed(1)},${y.toFixed(1)} `;
  }

  // Signed distance d_k polyline (-120 .. +120 px)
  let distPts = "";
  for (const f of frames) {
    if (!f.hasBlob) continue;
    const x = xOfMs(f.relToRfMs);
    const norm = Math.max(-1, Math.min(1, f.signedDistPx / 110));
    const y = H * 0.5 - norm * (H * 0.36);
    distPts += `${x.toFixed(1)},${y.toFixed(1)} `;
  }

  const xRF = xOfMs(0);
  const camRelMs = p.camTimestampUs ? (p.camTimestampUs - p.rfTimestampUs) / 1000.0 : null;
  const xCam = camRelMs !== null ? xOfMs(camRelMs) : null;
  const curRel = frames[curIdx]?.relToRfMs ?? 0;
  const xCur = xOfMs(curRel);

  return `
    <svg class="timeline-svg" id="inspector-timeline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <!-- Zero distance horizontal guide -->
      <line x1="12" y1="${(H * 0.5).toFixed(1)}" x2="${W - 12}" y2="${(H * 0.5).toFixed(1)}"
            stroke="rgba(148,163,184,0.22)" stroke-dasharray="4 4" />
      ${rssiPts ? `<polyline fill="none" stroke="#f59e0b" stroke-width="1.8" points="${rssiPts.trim()}" />` : ""}
      ${distPts ? `<polyline fill="none" stroke="#22d3ee" stroke-width="2" points="${distPts.trim()}" />` : ""}

      <!-- SlapRF t_RF Marker (Amber) -->
      <line x1="${xRF.toFixed(1)}" y1="4" x2="${xRF.toFixed(1)}" y2="${H - 4}" stroke="#f59e0b" stroke-width="2" />
      <text x="${(xRF + 4).toFixed(1)}" y="13" fill="#f59e0b" font-size="10" font-family="monospace">t_RF</text>

      <!-- Camera t_cam Marker (Cyan) -->
      ${
        xCam !== null
          ? `<line x1="${xCam.toFixed(1)}" y1="4" x2="${xCam.toFixed(1)}" y2="${H - 4}" stroke="#22d3ee" stroke-width="2" />
             <text x="${Math.max(14, xCam - 34).toFixed(1)}" y="${H - 5}" fill="#22d3ee" font-size="10" font-family="monospace">t_cam</text>`
          : ""
      }

      <!-- Current Scrubber Playhead -->
      <line id="tl-playhead" x1="${xCur.toFixed(1)}" y1="0" x2="${xCur.toFixed(1)}" y2="${H}" stroke="#ffffff" stroke-width="1.8" />
    </svg>
  `;
}

function renderInspectorFrameOverlaySVG(p: PassRecord, f: FrameObservation | undefined): string {
  const W = f?.frameWidth || state?.camInfo?.frameWidth || 640;
  const H = f?.frameHeight || state?.camInfo?.frameHeight || 360;
  let svg = showGateOverlay ? gateGeometrySVG(p.gateSnapshot, false, W, H) : "";
  if (showBlobOverlay && f && f.hasBlob) {
    const cx = f.blobCx * W;
    const cy = f.blobCy * H;
    const bx = f.blobBoxX * W;
    const by = f.blobBoxY * H;
    const bw = Math.max(12, f.blobBoxW * W);
    const bh = Math.max(12, f.blobBoxH * H);
    const color = f.onTrack ? "#10b981" : "#94a3b8";
    svg += `
      <rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}"
            fill="none" stroke="${color}" stroke-width="2" />
      <line x1="${(cx - 9).toFixed(1)}" y1="${cy.toFixed(1)}" x2="${(cx + 9).toFixed(1)}" y2="${cy.toFixed(1)}"
            stroke="#fbbf24" stroke-width="2" />
      <line x1="${cx.toFixed(1)}" y1="${(cy - 9).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${(cy + 9).toFixed(1)}"
            stroke="#fbbf24" stroke-width="2" />
      <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3.5" fill="#fbbf24" />
    `;
  }
  return svg;
}

function renderInspectorView(): string {
  if (!inspectPass) {
    return `<div style="padding:32px;text-align:center;color:var(--muted);">Loading pass #${inspectPassId} lookback frames...</div>`;
  }
  const p = inspectPass;
  const frames = p.frames ?? [];
  const f = frames[inspectFrameIdx];
  const frameSrc =
    frames.length > 0 && !p.framesPurged
      ? `/v1/gatecam/passes/${p.passId}/frames/${inspectFrameIdx}.jpg${showMaskMode ? "?mask=1" : ""}`
      : `/v1/gatecam/passes/${p.passId}/thumb.jpg`;

  const allIds = (state?.passes ?? []).map((x) => x.passId);
  const posInList = allIds.indexOf(p.passId);
  const newerId = posInList > 0 ? allIds[posInList - 1] : 0;
  const olderId = posInList >= 0 && posInList < allIds.length - 1 ? allIds[posInList + 1] : 0;

  return `
    <div class="inspector-layout">
      <div class="inspector-main">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:8px;">
            <button data-nav="#/">← Back</button>
            <b>Pass #${p.passId} · ${esc(p.callsign)} (${p.frequencyMhz} MHz) · Gate #${p.gateId}</b>
            ${renderStatusBadge(p.status, p.confidence)}
          </div>
          <div style="display:flex;gap:6px;">
            <button ${olderId ? `data-nav="#/pass/${olderId}"` : "disabled"}>◀ Older</button>
            <button ${newerId ? `data-nav="#/pass/${newerId}"` : "disabled"}>Newer ▶</button>
          </div>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;font-family:var(--mono);font-size:11.5px;color:var(--muted);">
          <span id="insp-frame-label">
            Frame ${inspectFrameIdx + 1} / ${frames.length}
            · t = ${f ? fmtSigned(f.relToRfMs, 2) : "—"} vs RF
            · Blob d = ${f && f.hasBlob ? `${f.signedDistPx >= 0 ? "+" : ""}${f.signedDistPx.toFixed(1)} px` : "none"}
          </span>
          <div style="display:flex;gap:6px;">
            <button class="${showGateOverlay ? "primary" : ""}" data-insp-toggle="gate">✓ Gate</button>
            <button class="${showBlobOverlay ? "primary" : ""}" data-insp-toggle="blob">✓ Blob ⊕</button>
            <button class="${showMaskMode ? "amber" : ""}" data-insp-toggle="mask">MOG2 Mask</button>
          </div>
        </div>

        <div class="inspector-frame-box">
          <div class="inspector-stage" style="aspect-ratio:${f?.frameWidth || 360} / ${f?.frameHeight || 640}">
            <img id="insp-img" class="preview-img" src="${frameSrc}" alt="Frame ${inspectFrameIdx}" />
            <svg id="insp-svg" class="gate-svg" viewBox="0 0 ${f?.frameWidth || 360} ${f?.frameHeight || 640}" preserveAspectRatio="none">
              ${renderInspectorFrameOverlaySVG(p, f)}
            </svg>
          </div>
        </div>

        <div class="timeline-card">
          ${renderInspectorTimelineSVG(p, inspectFrameIdx)}
          <div class="scrubber-bar" style="margin-top:6px;">
            <div style="display:flex;gap:5px;flex-wrap:wrap;">
              <button data-insp-jump="${p.crossingFrameIdx}">⏮ @Cam (#${p.crossingFrameIdx + 1})</button>
              <button data-insp-step="-1">◀ -1 Frame</button>
              <button class="${slowPlayTimer !== null ? "active" : ""}" data-act="slow-play">${slowPlayTimer !== null ? "⏸ Pause" : "▶ Slow 0.1x"}</button>
              <button data-insp-step="1">+1 Frame ▶</button>
              <button data-insp-jump="${p.rfNearestFrameIdx}">@RF (#${p.rfNearestFrameIdx + 1}) ⏭</button>
            </div>
            <span style="font-family:var(--mono);font-size:11px;color:var(--muted);">Drag timeline or use ◀ / ▶ keys</span>
          </div>
        </div>
      </div>

      <aside class="side-panel" style="padding:10px;gap:10px;overflow-y:auto;">
        <div class="card-box">
          <div class="section-title" style="padding:0 0 6px;">Timing Comparison</div>
          <div style="font-family:var(--mono);font-size:12px;line-height:1.7;">
            <div>SlapRF Peak (t_RF): <b style="color:var(--amber)">${(p.rfTimestampUs / 1e6).toFixed(4)} s</b></div>
            <div>Camera Cross (t_cam): <b style="color:var(--cyan)">${p.camTimestampUs ? `${(p.camTimestampUs / 1e6).toFixed(4)} s` : "—"}</b></div>
            <hr style="border:none;border-top:1px solid var(--border);margin:6px 0;" />
            <div>Gate Bias (t_RF - t_cam): <b style="font-size:14px;color:var(--text)">${fmtSigned(p.gateBiasMs, 2)}</b></div>
            <div style="color:var(--muted);">Frame Offset: ${fmtSigned(p.gateBiasFrames, 2, "frames")} ${p.spatialBiasCm !== undefined ? `(${fmtSigned(p.spatialBiasCm, 1, "cm")})` : ""}</div>
            ${
              p.lapNumber && p.lapRfSec !== undefined && p.lapCamSec !== undefined
                ? `<hr style="border:none;border-top:1px solid var(--border);margin:6px 0;" />
                   <div>Lap #${p.lapNumber} SlapRF: <b>${p.lapRfSec.toFixed(4)} s</b></div>
                   <div>Lap #${p.lapNumber} Camera: <b>${p.lapCamSec.toFixed(4)} s</b></div>
                   <div>Lap Error (ΔLap): <b style="color:var(--cyan)">${fmtSigned(p.lapDeltaMs, 2)}</b></div>`
                : ""
            }
          </div>
        </div>

        <div class="card-box">
          <div class="section-title" style="padding:0 0 6px;">Detection Details</div>
          <div style="font-family:var(--mono);font-size:11.5px;line-height:1.65;color:var(--muted);">
            <div>Model: <b style="color:var(--text)">OpenCV ${(p.motionModel || "mog2").toUpperCase()}</b></div>
            <div>Auto Frac Frame: <b style="color:var(--text)">#${(p.autoFractionalFrame + 1).toFixed(2)}</b></div>
            <div>Peak Blob Area: <b style="color:var(--text)">${p.blobAreaPx ?? 0} px</b></div>
            <div>Flow Velocity: <b style="color:var(--text)">${(p.flowSpeedPxPerFr ?? 0).toFixed(1)} px/fr</b></div>
            <div>RF Peak / Hold: <b style="color:var(--text)">${p.peakRssiDbm.toFixed(1)} dBm / ${p.holdMs.toFixed(0)} ms</b></div>
          </div>
        </div>

        <div class="card-box" style="display:flex;flex-direction:column;gap:7px;">
          <div class="section-title" style="padding:0;">Manual Curation</div>
          <button class="primary" id="btn-pin-frame" data-act="pin-frame">📌 Pin Frame #${inspectFrameIdx + 1} as Crossing</button>
          <button data-act="restore-auto">↺ Restore Auto Crossing</button>
          <button class="${p.status === "EXCLUDED" ? "amber" : "danger"}" data-act="toggle-exclude">
            ${p.status === "EXCLUDED" ? "✓ Re-Include Pass in Stats" : "🗑 Exclude Pass from Stats"}
          </button>
        </div>
      </aside>
    </div>
  `;
}

function renderInspectorDynamicOnly(): void {
  if (route !== "inspector" || !inspectPass) return;
  const p = inspectPass;
  const f = p.frames[inspectFrameIdx];
  const img = document.getElementById("insp-img") as HTMLImageElement | null;
  if (img && !p.framesPurged) {
    img.src = `/v1/gatecam/passes/${p.passId}/frames/${inspectFrameIdx}.jpg${showMaskMode ? "?mask=1" : ""}`;
  }
  const svg = document.getElementById("insp-svg");
  if (svg) {
    svg.innerHTML = renderInspectorFrameOverlaySVG(p, f);
  }
  const lbl = document.getElementById("insp-frame-label");
  if (lbl) {
    lbl.textContent = `Frame ${inspectFrameIdx + 1} / ${p.frames.length} · t = ${f ? fmtSigned(f.relToRfMs, 2) : "—"} vs RF · Blob d = ${
      f && f.hasBlob ? `${f.signedDistPx >= 0 ? "+" : ""}${f.signedDistPx.toFixed(1)} px` : "none"
    }`;
  }
  const pinBtn = document.getElementById("btn-pin-frame");
  if (pinBtn) {
    pinBtn.textContent = `📌 Pin Frame #${inspectFrameIdx + 1} as Crossing`;
  }
  const playhead = document.getElementById("tl-playhead");
  if (playhead && p.frames.length > 1) {
    const minRel = p.frames[0].relToRfMs;
    const maxRel = p.frames[p.frames.length - 1].relToRfMs;
    const span = Math.max(10, maxRel - minRel);
    const xCur = 12 + (((f?.relToRfMs ?? 0) - minRel) / span) * (600 - 24);
    playhead.setAttribute("x1", xCur.toFixed(1));
    playhead.setAttribute("x2", xCur.toFixed(1));
  }
}

function renderStatsView(): string {
  if (!state) return "";
  const st = state.stats;
  const maxBin = Math.max(1, ...st.histogram.map((b) => b.count));
  const lanList = state.sync.lanUrls ?? [];

  return `
    <div class="stats-scroll">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
        <h2 style="margin:0;font-size:16px;">GateCam Verification Report — ${st.totalPasses} Passes</h2>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <a class="btn primary" href="/v1/gatecam/export.zip" download>⬇ Export ZIP (JSON + CSV + Frames)</a>
          <a class="btn" href="/v1/gatecam/report.csv" download>⬇ CSV</a>
          <button class="danger" data-act="clear-passes">🧹 Clear Session</button>
        </div>
      </div>

      <div class="stats-kpi-row">
        <div class="kpi-card">
          <div class="kpi-label">VALID PASSES</div>
          <div class="kpi-val">${st.validPasses} / ${st.totalPasses}</div>
          <div class="kpi-sub">${st.manualPasses} manual · ${st.excludedCount} excluded</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">MEAN GATE BIAS (μ)</div>
          <div class="kpi-val">${st.validPasses > 0 ? fmtSigned(st.meanBiasMs, 2) : "—"}</div>
          <div class="kpi-sub">${st.validPasses > 0 ? `${fmtSigned(st.meanBiasCm, 1, "cm")} spatial` : "t_RF - t_camera"}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">SINGLE-PASS JITTER (σ)</div>
          <div class="kpi-val">${st.validPasses > 1 ? `±${st.stdBiasMs.toFixed(2)} ms` : "—"}</div>
          <div class="kpi-sub">P95: ${st.p95AbsBiasMs.toFixed(2)} ms · Max: ${st.maxAbsBiasMs.toFixed(2)} ms</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">LAP DURATION ERROR (σ)</div>
          <div class="kpi-val">${st.lapCount > 1 ? `±${st.stdLapDeltaMs.toFixed(2)} ms` : "—"}</div>
          <div class="kpi-sub">μ: ${fmtSigned(st.meanLapDeltaMs, 2)} · P95: ${st.p95AbsLapDeltaMs.toFixed(2)} ms</div>
        </div>
      </div>

      <div class="stats-two-col">
        <div class="card-box">
          <div class="section-title" style="padding:0 0 8px;">Gate Bias Distribution (t_RF - t_camera)</div>
          ${st.histogram
            .map(
              (b) => `
            <div class="hist-row">
              <span>${esc(b.label)}</span>
              <div class="hist-track"><div class="hist-fill" style="width:${((b.count / maxBin) * 100).toFixed(1)}%"></div></div>
              <span style="text-align:right">${b.count}</span>
            </div>`
            )
            .join("")}
        </div>

        <div class="card-box">
          <div class="section-title" style="padding:0 0 8px;">Bias by Pass Speed (Zero-Phase Filter Check)</div>
          <table class="data-table">
            <thead><tr><th>Pass Bucket</th><th>Count</th><th>Mean Bias</th><th>Std Dev</th></tr></thead>
            <tbody>
              ${st.speedBuckets
                .map(
                  (sb) => `
                <tr>
                  <td>${esc(sb.label)}</td>
                  <td>${sb.count}</td>
                  <td>${sb.count > 0 ? fmtSigned(sb.meanBiasMs, 2) : "—"}</td>
                  <td>${sb.count > 1 ? `±${sb.stdBiasMs.toFixed(2)} ms` : "—"}</td>
                </tr>`
                )
                .join("")}
            </tbody>
          </table>
          ${
            lanList.length > 0
              ? `<div style="margin-top:10px;font-size:11.5px;color:var(--muted);font-family:var(--mono);">
                   Remote Tripod URL: <b style="color:var(--cyan)">${esc(lanList.join(", "))}</b>
                 </div>`
              : ""
          }
        </div>
      </div>

      <div class="card-box">
        <div class="section-title" style="padding:0 0 8px;">Pass-by-Pass Log (Click Row to Open Frame Scrubber)</div>
        <div style="overflow-x:auto;">
          <table class="data-table">
            <thead>
              <tr>
                <th>#</th><th>Time</th><th>Pilot</th><th>Status</th><th>Peak dBm</th><th>Hold</th>
                <th>Gate Bias</th><th>Lap #</th><th>Lap SlapRF</th><th>Lap Cam</th><th>ΔLap</th>
              </tr>
            </thead>
            <tbody>
              ${state.passes
                .map(
                  (p) => `
                <tr class="clickable" data-open-pass="${p.passId}">
                  <td>#${p.passId}</td>
                  <td>${esc(p.createdAt)}</td>
                  <td><b>${esc(p.callsign)}</b></td>
                  <td>${renderStatusBadge(p.status, p.confidence)}</td>
                  <td>${p.peakRssiDbm.toFixed(1)}</td>
                  <td>${p.holdMs.toFixed(0)} ms</td>
                  <td><b>${fmtSigned(p.gateBiasMs, 2)}</b></td>
                  <td>${p.lapNumber || "—"}</td>
                  <td>${p.lapRfSec !== undefined ? `${p.lapRfSec.toFixed(3)}s` : "—"}</td>
                  <td>${p.lapCamSec !== undefined ? `${p.lapCamSec.toFixed(3)}s` : "—"}</td>
                  <td>${fmtSigned(p.lapDeltaMs, 2)}</td>
                </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function renderSetupModal(): string {
  if (!setupOpen || !state) return "";
  const l = state.link;
  const c = state.camera;
  const gates = state.sync.gates ?? [];
  const pilots = state.sync.pilots ?? [];

  return `
    <div class="modal-backdrop" data-close-backdrop="1">
      <div class="modal-card">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <b style="font-size:14px;">GateCam Link & OpenCV Motion Settings</b>
          <button data-act="close-setup">✕</button>
        </div>

        <div class="field-row">
          <label>SlapRF Server URL (:18090 Same Phone or :8090 LAN)</label>
          <div style="display:flex;gap:6px;">
            <input type="text" id="cfg-url" style="flex:1" value="${esc(l.slaprfUrl)}" placeholder="http://127.0.0.1:18090" />
            <button data-preset-url="http://127.0.0.1:18090">:18090</button>
            <button data-preset-url="http://127.0.0.1:8090">:8090</button>
          </div>
        </div>

        <div class="field-row">
          <label>HTTP Basic Auth (optional user:pass)</label>
          <input type="password" id="cfg-auth" value="${esc(l.basicAuth)}" placeholder="Leave blank if disabled" />
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div class="field-row">
            <label>Target Gate Filter</label>
            <select id="cfg-gate">
              <option value="0" ${l.gateFilter === 0 ? "selected" : ""}>All Gates</option>
              ${gates.map((g) => `<option value="${g.gateId}" ${l.gateFilter === g.gateId ? "selected" : ""}>Gate #${g.gateId} — ${esc(g.name)}</option>`).join("")}
            </select>
          </div>
          <div class="field-row">
            <label>Pilot Filter</label>
            <select id="cfg-pilot">
              <option value="0" ${l.pilotFilter === 0 ? "selected" : ""}>All Pilots</option>
              ${pilots.map((p) => `<option value="${p.slotIndex}" ${l.pilotFilter === p.slotIndex ? "selected" : ""}>Slot ${p.slotIndex} — ${esc(p.callsign)}</option>`).join("")}
            </select>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div class="field-row">
            <label>Lookback Window (±ms)</label>
            <select id="cfg-lookback">
              <option value="300" ${c.lookbackHalfMs === 300 ? "selected" : ""}>±300 ms</option>
              <option value="450" ${c.lookbackHalfMs === 450 ? "selected" : ""}>±450 ms (Default)</option>
              <option value="600" ${c.lookbackHalfMs === 600 ? "selected" : ""}>±600 ms</option>
            </select>
          </div>
          <div class="field-row">
            <label>OpenCV Motion Subtractor</label>
            <select id="cfg-model">
              <option value="mog2" ${c.motionModel === "mog2" ? "selected" : ""}>OpenCV MOG2 (Shadow Reject)</option>
              <option value="knn" ${c.motionModel === "knn" ? "selected" : ""}>OpenCV KNN</option>
            </select>
          </div>
        </div>

        <div class="field-row">
          <label>MOG2 Sensitivity (varThreshold: <span id="sens-lbl">${c.sensitivity.toFixed(0)}</span> — lower = more sensitive)</label>
          <input type="range" id="cfg-sens" min="6" max="40" step="2" value="${c.sensitivity}" />
        </div>

        <label style="display:flex;align-items:center;gap:8px;font-size:12px;">
          <input type="checkbox" id="cfg-rsshutter" ${c.rollingShutterComp ? "checked" : ""} />
          Compensate CMOS rolling-shutter readout skew
        </label>

        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px;">
          <button data-act="close-setup">Cancel</button>
          <button class="primary" data-act="save-setup">Save & Apply</button>
        </div>
      </div>
    </div>
  `;
}

function render(): void {
  if (!state) {
    appRoot.innerHTML = `<div style="padding:32px;color:var(--muted);">Starting SlapRF GateCam...</div>`;
    return;
  }
  const bodyHtml =
    route === "inspector" ? renderInspectorView() : route === "stats" ? renderStatsView() : renderLiveView();
  appRoot.innerHTML = renderTopBar() + bodyHtml + renderSetupModal();
  bindLivePointerHandlers();
  bindTimelineScrubHandlers();
  if (route === "live") {
    requestAnimationFrame(syncNativePreviewBounds);
  }
}

function bindLivePointerHandlers(): void {
  const svg = document.getElementById("live-gate-svg");
  if (!svg || !state) return;

  svg.onpointerdown = (e: PointerEvent) => {
    if (!state) return;
    const target = e.target as Element | null;
    if (target?.closest("[data-flip-dir]")) {
      void updateGate({ ...state.gate, dirSign: state.gate.dirSign < 0 ? 1 : -1 });
      return;
    }
    const hEl = target?.closest("[data-handle]");
    const handle = hEl?.getAttribute("data-handle") as "p1" | "p2" | null;
    if (handle) {
      if (state.gate.locked) return;
      dragHandle = handle;
      svg.setPointerCapture(e.pointerId);
      return;
    }

    // Tapping anywhere else on the camera preview triggers one-shot tap-to-focus & locks AF there!
    const r = svg.getBoundingClientRect();
    const nx = Math.max(0.02, Math.min(0.98, (e.clientX - r.left) / Math.max(1, r.width)));
    const ny = Math.max(0.02, Math.min(0.98, (e.clientY - r.top) / Math.max(1, r.height)));
    tapFocusSpot = { x: nx, y: ny };
    if (tapFocusTimer !== null) clearTimeout(tapFocusTimer);
    render();
    tapFocusTimer = window.setTimeout(() => {
      tapFocusSpot = null;
      tapFocusTimer = null;
      if (route === "live" && !dragHandle) render();
    }, 850);
    void apiJSON<AppState>("POST", "/v1/gatecam/camera:focus", { x: nx, y: ny }).then((next) => {
      state = next;
      if (!dragHandle) render();
    });
  };

  svg.onpointermove = (e: PointerEvent) => {
    if (!dragHandle || !state) return;
    const r = svg.getBoundingClientRect();
    const nx = Math.max(0.03, Math.min(0.97, (e.clientX - r.left) / Math.max(1, r.width)));
    const ny = Math.max(0.04, Math.min(0.96, (e.clientY - r.top) / Math.max(1, r.height)));
    if (dragHandle === "p1") {
      state.gate.p1x = nx;
      state.gate.p1y = ny;
    } else {
      state.gate.p2x = nx;
      state.gate.p2y = ny;
    }
    const { w: fw, h: fh } = currentFrameDims();
    svg.innerHTML = gateGeometrySVG(state.gate, true, fw, fh);
  };

  const finishDrag = () => {
    if (!dragHandle || !state) return;
    dragHandle = null;
    void updateGate(state.gate);
  };
  svg.onpointerup = finishDrag;
  svg.onpointercancel = finishDrag;
}

function bindTimelineScrubHandlers(): void {
  const tl = document.getElementById("inspector-timeline");
  if (!tl || !inspectPass || inspectPass.frames.length === 0) return;

  let scrubbing = false;
  const scrubAt = (clientX: number) => {
    if (!inspectPass || inspectPass.frames.length === 0) return;
    const r = tl.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - r.left - 8) / Math.max(1, r.width - 16)));
    const minRel = inspectPass.frames[0].relToRfMs;
    const maxRel = inspectPass.frames[inspectPass.frames.length - 1].relToRfMs;
    const wantMs = minRel + frac * (maxRel - minRel);
    let bestIdx = 0;
    let bestDiff = Infinity;
    inspectPass.frames.forEach((f, idx) => {
      const d = Math.abs(f.relToRfMs - wantMs);
      if (d < bestDiff) {
        bestDiff = d;
        bestIdx = idx;
      }
    });
    inspectFrameIdx = bestIdx;
    renderInspectorDynamicOnly();
  };

  tl.onpointerdown = (e: PointerEvent) => {
    stopSlowPlay();
    scrubbing = true;
    tl.setPointerCapture(e.pointerId);
    scrubAt(e.clientX);
  };
  tl.onpointermove = (e: PointerEvent) => {
    if (scrubbing) scrubAt(e.clientX);
  };
  tl.onpointerup = () => {
    scrubbing = false;
  };
}

async function updateGate(next: GateLine): Promise<void> {
  state = await apiJSON<AppState>("PUT", "/v1/gatecam/gate", next);
  render();
}

async function updateCamera(next: CameraConfig): Promise<void> {
  state = await apiJSON<AppState>("PUT", "/v1/gatecam/camera", next);
  render();
}

appRoot.addEventListener("click", async (e) => {
  const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(
    "[data-nav],[data-open-pass],[data-fps],[data-zoom],[data-act],[data-insp-step],[data-insp-jump],[data-insp-toggle],[data-preset-url],[data-close-backdrop]"
  );
  if (!el || !state) return;

  if (el.hasAttribute("data-close-backdrop") && e.target === el) {
    setupOpen = false;
    updateNativeUnderlayVisibility();
    render();
    return;
  }

  const nav = el.getAttribute("data-nav");
  if (nav) {
    window.location.hash = nav;
    return;
  }
  const openPass = el.getAttribute("data-open-pass");
  if (openPass) {
    window.location.hash = `#/pass/${openPass}`;
    return;
  }
  const fpsAttr = el.getAttribute("data-fps");
  if (fpsAttr) {
    await updateCamera({ ...state.camera, targetFps: parseInt(fpsAttr, 10) });
    return;
  }
  const zoomAttr = el.getAttribute("data-zoom");
  if (zoomAttr) {
    const nextZoom = parseFloat(zoomAttr) || 1.0;
    // Ultra-Wide (< 1.0x) requires standard 60 fps session on Android Camera2
    const nextFps = nextZoom < 0.9 && state.camera.targetFps > 60 ? 60 : state.camera.targetFps;
    await updateCamera({ ...state.camera, zoomRatio: nextZoom, targetFps: nextFps });
    return;
  }
  const stepAttr = el.getAttribute("data-insp-step");
  if (stepAttr) {
    stepInspectorFrame(parseInt(stepAttr, 10));
    return;
  }
  const jumpAttr = el.getAttribute("data-insp-jump");
  if (jumpAttr) {
    stopSlowPlay();
    inspectFrameIdx = Math.max(0, parseInt(jumpAttr, 10) || 0);
    renderInspectorDynamicOnly();
    return;
  }
  const toggleAttr = el.getAttribute("data-insp-toggle");
  if (toggleAttr) {
    if (toggleAttr === "gate") showGateOverlay = !showGateOverlay;
    if (toggleAttr === "blob") showBlobOverlay = !showBlobOverlay;
    if (toggleAttr === "mask") showMaskMode = !showMaskMode;
    render();
    return;
  }
  const presetURL = el.getAttribute("data-preset-url");
  if (presetURL) {
    const inp = document.getElementById("cfg-url") as HTMLInputElement | null;
    if (inp) inp.value = presetURL;
    return;
  }

  const act = el.getAttribute("data-act");
  switch (act) {
    case "flip-dir":
      await updateGate({ ...state.gate, dirSign: state.gate.dirSign < 0 ? 1 : -1 });
      break;
    case "toggle-lock":
      await updateGate({ ...state.gate, locked: !state.gate.locked });
      break;
    case "lock-af":
      state = await apiJSON<AppState>("POST", "/v1/gatecam/camera:focus", {});
      render();
      break;
    case "sim-pass":
      state = await apiJSON<AppState>("POST", "/v1/gatecam/dev:simulatePass", {});
      render();
      break;
    case "slow-play":
      toggleSlowPlay();
      break;
    case "pin-frame":
      if (inspectPass) {
        const res = await apiJSON<{ pass: PassRecord; stats: SessionStats }>(
          "POST",
          `/v1/gatecam/passes/${inspectPass.passId}:pin`,
          { frameIdx: inspectFrameIdx }
        );
        inspectPass = res.pass;
        state.stats = res.stats;
        await refreshStateSilently();
        render();
      }
      break;
    case "restore-auto":
      if (inspectPass) {
        const res = await apiJSON<{ pass: PassRecord; stats: SessionStats }>(
          "POST",
          `/v1/gatecam/passes/${inspectPass.passId}:restoreAuto`,
          {}
        );
        inspectPass = res.pass;
        inspectFrameIdx = res.pass.crossingFrameIdx;
        await refreshStateSilently();
        render();
      }
      break;
    case "toggle-exclude":
      if (inspectPass) {
        const wantExcluded = inspectPass.status !== "EXCLUDED";
        const res = await apiJSON<{ pass: PassRecord; stats: SessionStats }>(
          "POST",
          `/v1/gatecam/passes/${inspectPass.passId}:exclude`,
          { excluded: wantExcluded }
        );
        inspectPass = res.pass;
        await refreshStateSilently();
        render();
      }
      break;
    case "clear-passes":
      state = await apiJSON<AppState>("POST", "/v1/gatecam/passes:clear", {});
      render();
      break;
    case "open-setup":
      setupOpen = true;
      updateNativeUnderlayVisibility();
      render();
      break;
    case "close-setup":
      setupOpen = false;
      updateNativeUnderlayVisibility();
      render();
      break;
    case "save-setup": {
      const urlVal = (document.getElementById("cfg-url") as HTMLInputElement).value.trim();
      const authVal = (document.getElementById("cfg-auth") as HTMLInputElement).value;
      const gateVal = parseInt((document.getElementById("cfg-gate") as HTMLSelectElement).value, 10) || 0;
      const pilotVal = parseInt((document.getElementById("cfg-pilot") as HTMLSelectElement).value, 10) || 0;
      const lbVal = parseInt((document.getElementById("cfg-lookback") as HTMLSelectElement).value, 10) || 450;
      const modelVal = (document.getElementById("cfg-model") as HTMLSelectElement).value;
      const sensVal = parseFloat((document.getElementById("cfg-sens") as HTMLInputElement).value) || 16;
      const rsVal = (document.getElementById("cfg-rsshutter") as HTMLInputElement).checked;

      await apiJSON("PUT", "/v1/gatecam/camera", {
        ...state.camera,
        lookbackHalfMs: lbVal,
        motionModel: modelVal,
        sensitivity: sensVal,
        rollingShutterComp: rsVal,
      });
      state = await apiJSON<AppState>("PUT", "/v1/gatecam/link", {
        slaprfUrl: urlVal,
        basicAuth: authVal,
        gateFilter: gateVal,
        pilotFilter: pilotVal,
        exposeLan: false,
      });
      setupOpen = false;
      updateNativeUnderlayVisibility();
      render();
      break;
    }
  }
});

appRoot.addEventListener("change", async (e) => {
  const t = e.target as HTMLElement | null;
  if (!t || !state) return;
  if (t.hasAttribute("data-shutter")) {
    const us = parseInt((t as HTMLSelectElement).value, 10) || 0;
    await updateCamera({ ...state.camera, shutterUs: us });
    return;
  }
  if (t.hasAttribute("data-focus-mode")) {
    const fm = (t as HTMLSelectElement).value || "gate";
    await updateCamera({ ...state.camera, focusMode: fm, focusLocked: true });
  }
});

appRoot.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement | null;
  if (t?.id === "cfg-sens") {
    const lbl = document.getElementById("sens-lbl");
    if (lbl) lbl.textContent = t.value;
  }
});

async function refreshStateSilently(): Promise<void> {
  try {
    state = await apiJSON<AppState>("GET", "/v1/gatecam/state");
  } catch {
    // ignore transient reload errors
  }
}

function connectLiveWS(): void {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${window.location.host}/v1/gatecam/ws`);
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === "status" && msg.payload) {
        state = msg.payload as AppState;
        if (!dragHandle) render();
      } else if (msg.type === "hud" && msg.payload && state) {
        state.camInfo = msg.payload.camera;
        state.sync = msg.payload.sync;
        // Fast DOM patch for 4 Hz HUD without touching SVG drag state
        const rssiEl = document.querySelector("[data-hud-rssi]");
        if (rssiEl) {
          const items = state.sync.liveRssi ?? [];
          rssiEl.innerHTML =
            items.length > 0
              ? items.map((r) => `${esc(r.callsign)} <b>${r.rssiDbm.toFixed(0)} dBm</b>`).join(" · ")
              : `Waiting for 50 Hz RSSI on ${esc(state.sync.slaprfUrl)}...`;
        }
        const ringEl = document.querySelector("[data-hud-ring]");
        if (ringEl) {
          ringEl.textContent = `${fmtCamTelemetry(state.camInfo)} ●`;
        }
      } else if ((msg.type === "pass_added" || msg.type === "pass_updated") && state) {
        void refreshStateSilently().then(() => {
          if (!dragHandle && route !== "inspector") render();
        });
      }
    } catch {
      // ignore malformed frames
    }
  };
  ws.onclose = () => {
    setTimeout(connectLiveWS, 1500);
  };
}

async function boot(): Promise<void> {
  state = await apiJSON<AppState>("GET", "/v1/gatecam/state");
  syncRouteFromHash();
  connectLiveWS();
}

void boot();
