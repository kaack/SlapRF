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
  pilots?: Array<{ slotIndex: number; callsign: string; frequencyMhz: number; color?: string }>;
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

/* Crisp 2px Geometric Stroke Icons (Matching SlapRF web/src/core/icons.ts) */
const svg = (body: string, size = 16): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" shape-rendering="geometricPrecision" aria-hidden="true">${body}</svg>`;

const icons = {
  slaprf: (s = 22) =>
    svg(
      `<path d="M3.8 8V5.8A2 2 0 0 1 5.8 3.8H8" stroke="var(--text)"/><path d="M16 3.8h2.2a2 2 0 0 1 2 2V8" stroke="var(--text)"/><path d="M3.8 16v2.2a2 2 0 0 0 2 2H8" stroke="var(--text)"/><path d="M16 20.2h2.2a2 2 0 0 0 2-2V16" stroke="var(--text)"/><path d="M9.3 7.3a5.4 5.4 0 0 0 0 9.4" stroke="var(--text)"/><path d="M14.7 7.3a5.4 5.4 0 0 1 0 9.4" stroke="var(--text)"/><path d="M12 3.2v17.6" stroke="currentColor" stroke-width="2.2"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/>`,
      s
    ),
  camera: (s = 18) =>
    svg(
      `<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3.2"/>`,
      s
    ),
  passes: (s = 18) =>
    svg(
      `<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 4v16M17 4v16M2 9h5M17 9h5M2 15h5M17 15h5"/>`,
      s
    ),
  chart: (s = 18) => svg(`<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>`, s),
  settings: (s = 18) =>
    svg(
      `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>`,
      s
    ),
  lock: (s = 15) => svg(`<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`, s),
  unlock: (s = 15) => svg(`<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.8-1"/>`, s),
  flip: (s = 15) => svg(`<path d="m17 3 4 4-4 4"/><path d="M3 7h18"/><path d="m7 21-4-4 4-4"/><path d="M21 17H3"/>`, s),
  chevronLeft: (s = 16) => svg(`<path d="M15 6l-6 6 6 6"/>`, s),
  chevronRight: (s = 16) => svg(`<path d="M9 6l6 6-6 6"/>`, s),
  chevronDown: (s = 15) => svg(`<path d="m6 9 6 6 6-6"/>`, s),
  moreHorizontal: (s = 20) =>
    svg(
      `<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>`,
      s
    ),
  radar: (s = 15) =>
    svg(
      `<path d="M5 12.85a11 11 0 0 1 14 0"/><path d="M8.5 16.4a6 6 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1.3" fill="currentColor" stroke="none"/><path d="M2 9.2a16 16 0 0 1 20 0"/>`,
      s
    ),
  play: (s = 14) => svg(`<path d="M7 4l13 8-13 8z"/>`, s),
  pause: (s = 14) => svg(`<path d="M9 5v14M15 5v14"/>`, s),
  pin: (s = 15) => svg(`<path d="M8 3h8"/><path d="M9 3v5l-3 3v2h12v-2l-3-3V3"/><path d="M12 13v8"/>`, s),
  reset: (s = 15) => svg(`<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>`, s),
  ban: (s = 15) => svg(`<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>`, s),
  check: (s = 15) => svg(`<path d="M20 6 9 17l-5-5"/>`, s),
  download: (s = 15) => svg(`<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>`, s),
  trash: (s = 15) => svg(`<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>`, s),
  plus: (s = 15) => svg(`<path d="M12 5v14M5 12h14"/>`, s),
  moon: (s = 14) => svg(`<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>`, s),
  sun: (s = 14) =>
    svg(
      `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>`,
      s
    ),
};

const isNativeUnderlay = typeof window.GateCamAndroid !== "undefined";
if (isNativeUnderlay) {
  document.documentElement.classList.add("is-native-underlay");
  document.body.classList.add("is-native-underlay");
}

type RouteId = "live" | "passes" | "inspector" | "stats" | "settings";

let state: AppState | null = null;
let route: RouteId = "live";
let prevRouteBeforeInspect: "live" | "passes" | "stats" = "live";
let inspectPassId = 0;
let inspectPass: PassRecord | null = null;
let inspectFrameIdx = 0;
let showGateOverlay = true;
let showBlobOverlay = true;
let showMaskMode = false;
let slowPlayTimer: number | null = null;
let passFilter: "all" | "valid" | "review" = "all";
let dragHandle: "p1" | "p2" | null = null;
let previewPollTimer: number | null = null;
let tapFocusSpot: { x: number; y: number } | null = null;
let tapFocusTimer: number | null = null;
let settingsDraftLookback = 450;
let settingsDraftModel = "mog2";
let settingsDraftUrl = "";
let settingsDraftAuth = "";
let settingsDraftPilot = 0;
let settingsDraftSens = 16;
let settingsDraftRsComp = true;
let pilotDropdownOpen = false;
let moreDrawerOpen = false;
let discoverBusy = false;
let discoverNote = "";

function loadSettingsDraftFromState(): void {
  if (!state) return;
  settingsDraftLookback = state.camera.lookbackHalfMs || 450;
  settingsDraftModel = state.camera.motionModel || "mog2";
  settingsDraftUrl = state.link.slaprfUrl || "http://127.0.0.1:18090";
  settingsDraftAuth = state.link.basicAuth || "";
  settingsDraftPilot = state.link.pilotFilter || 0;
  settingsDraftSens = state.camera.sensitivity || 16;
  settingsDraftRsComp = Boolean(state.camera.rollingShutterComp);
}

const appRoot = document.getElementById("app")!;

function getTheme(): "dark" | "light" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function setTheme(mode: "dark" | "light"): void {
  document.documentElement.dataset.theme = mode;
  try {
    localStorage.setItem("slaprf.gatecam.theme.v1", mode);
  } catch {
    // ignore storage errors
  }
  document.querySelectorAll<HTMLElement>("[data-theme-set]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.getAttribute("data-theme-set") === mode);
  });
}

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtSigned(v: number | undefined | null, digits = 1, unit = "ms"): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return "--";
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
  pilotDropdownOpen = false;
  moreDrawerOpen = false;
  if (h.startsWith("#/pass/")) {
    const id = parseInt(h.slice("#/pass/".length), 10);
    if (id > 0) {
      if (route === "live" || route === "passes" || route === "stats") {
        prevRouteBeforeInspect = route;
      }
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
  if (h === "#/passes") {
    route = "passes";
  } else if (h === "#/stats") {
    route = "stats";
  } else if (h === "#/settings") {
    route = "settings";
    discoverNote = "";
    loadSettingsDraftFromState();
  } else {
    route = "live";
  }
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
  const isLive = route === "live";
  document.documentElement.classList.toggle("route-live", isLive);
  document.body.classList.toggle("route-live", isLive);
  if (window.GateCamAndroid) {
    window.GateCamAndroid.setPreviewVisible(isLive);
    if (isLive) {
      requestAnimationFrame(syncNativePreviewBounds);
    }
  }
  if (!isNativeUnderlay) {
    if (isLive && previewPollTimer === null) {
      previewPollTimer = window.setInterval(() => {
        const img = document.querySelector<HTMLImageElement>("[data-remote-preview]");
        if (img && route === "live") {
          img.src = `/v1/gatecam/preview.jpg?t=${Date.now()}`;
        }
      }, 180);
    } else if (!isLive && previewPollTimer !== null) {
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
  if (route !== "inspector" || !inspectPass) return;
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

function fmtCamHudTop(ci: CameraStatus, sync: SyncStatus): string {
  const parts: string[] = [`${Math.round(ci.actualFps)}fps`];
  if (ci.exposureUs && ci.exposureUs > 0 && ci.exposureUs <= 8000) {
    parts.push(`1/${Math.max(100, Math.round(1_000_000 / ci.exposureUs))}s`);
  }
  const rssi = sync.liveRssi ?? [];
  if (rssi.length > 0) {
    parts.push(`${rssi[0].callsign} ${rssi[0].rssiDbm.toFixed(0)}dBm`);
  } else if (ci.ringSpanMs > 0) {
    parts.push(`${(ci.ringSpanMs / 1000).toFixed(1)}s`);
  }
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
  const ax = mx + nx * 46;
  const ay = my + ny * 46;
  const wx1 = ax - nx * 10 + (dx / len) * 6;
  const wy1 = ay - ny * 10 + (dy / len) * 6;
  const wx2 = ax - nx * 10 - (dx / len) * 6;
  const wy2 = ay - ny * 10 - (dy / len) * 6;

  const volt = "#d4ff3a";
  const voltCorridor = "rgba(212, 255, 58, 0.24)";

  return `
    <!-- Corridor Bounds -->
    <line x1="${(x1 - nx * bandPx).toFixed(1)}" y1="${(y1 - ny * bandPx).toFixed(1)}"
          x2="${(x2 - nx * bandPx).toFixed(1)}" y2="${(y2 - ny * bandPx).toFixed(1)}"
          stroke="${voltCorridor}" stroke-width="1.25" stroke-dasharray="5 5" />
    <line x1="${(x1 + nx * bandPx).toFixed(1)}" y1="${(y1 + ny * bandPx).toFixed(1)}"
          x2="${(x2 + nx * bandPx).toFixed(1)}" y2="${(y2 + ny * bandPx).toFixed(1)}"
          stroke="${voltCorridor}" stroke-width="1.25" stroke-dasharray="5 5" />

    <!-- Start Gate Sightline -->
    <line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"
          stroke="${volt}" stroke-width="2.2" />

    <!-- Flight Direction Vector -->
    <g data-flip-dir="1" style="cursor:${interactive ? "pointer" : "default"}">
      <line x1="${mx.toFixed(1)}" y1="${my.toFixed(1)}" x2="${ax.toFixed(1)}" y2="${ay.toFixed(1)}"
            stroke="${volt}" stroke-width="2.2" />
      <polygon points="${ax.toFixed(1)},${ay.toFixed(1)} ${wx1.toFixed(1)},${wy1.toFixed(1)} ${wx2.toFixed(1)},${wy2.toFixed(1)}"
               fill="${volt}" />
      <circle cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="18" fill="transparent" />
    </g>

    ${
      interactive
        ? `
      <g data-handle="p1" style="cursor:${g.locked ? "default" : "grab"}">
        <circle cx="${x1.toFixed(1)}" cy="${y1.toFixed(1)}" r="18" fill="rgba(11, 12, 15, 0.38)" stroke="${volt}" stroke-width="1.8" />
        <circle cx="${x1.toFixed(1)}" cy="${y1.toFixed(1)}" r="3.5" fill="${volt}" />
      </g>
      <g data-handle="p2" style="cursor:${g.locked ? "default" : "grab"}">
        <circle cx="${x2.toFixed(1)}" cy="${y2.toFixed(1)}" r="18" fill="rgba(11, 12, 15, 0.38)" stroke="${volt}" stroke-width="1.8" />
        <circle cx="${x2.toFixed(1)}" cy="${y2.toFixed(1)}" r="3.5" fill="${volt}" />
      </g>
      ${
        tapFocusSpot
          ? `<rect x="${(tapFocusSpot.x * W - 18).toFixed(1)}" y="${(tapFocusSpot.y * H - 18).toFixed(1)}" width="36" height="36" rx="6"
                   fill="none" stroke="#34d399" stroke-width="2" />`
          : ""
      }`
        : ""
    }
  `;
}

function renderSidebar(): string {
  if (!state) return "";
  const theme = getTheme();
  const total = state.passes.length;
  const activeTab = route === "inspector" ? "passes" : route;

  return `
    <aside class="sidebar" aria-label="Main navigation">
      <div class="brand">
        <div class="brand-mark">${icons.slaprf(22)}</div>
        <div class="brand-copy">
          <span class="brand-name">SlapRF</span>
          <span class="brand-tag">GateCam</span>
        </div>
      </div>
      <div class="sidebar-nav-shell">
        <nav class="nav">
          <button type="button" class="nav-item ${activeTab === "live" ? "is-active" : ""}" data-nav="#/">
            ${icons.camera(20)}
            <span>Camera</span>
          </button>
          <button type="button" class="nav-item ${activeTab === "passes" ? "is-active" : ""}" data-nav="#/passes">
            ${icons.passes(20)}
            <span>Passes</span>
            ${total > 0 ? `<span class="nav-count">${total}</span>` : ""}
          </button>
          <button type="button" class="nav-item ${activeTab === "stats" ? "is-active" : ""}" data-nav="#/stats">
            ${icons.chart(20)}
            <span>Accuracy</span>
          </button>
          <button type="button" class="nav-item ${activeTab === "settings" ? "is-active" : ""}" data-nav="#/settings">
            ${icons.settings(20)}
            <span>Settings</span>
          </button>
          <button type="button" class="nav-item mobile-more-tab-btn ${moreDrawerOpen ? "is-active" : ""}" data-act="toggle-more" aria-expanded="${moreDrawerOpen ? "true" : "false"}" aria-label="More options">
            ${icons.moreHorizontal(20)}
            <span>More</span>
          </button>
        </nav>
      </div>
      <div class="sidebar-footer">
        <span class="sidebar-theme-label">Theme</span>
        <div class="theme-toggler" role="group" aria-label="Color theme">
          <button type="button" class="theme-btn ${theme === "dark" ? "is-active" : ""}" data-theme-set="dark" title="Dark theme">
            ${icons.moon(14)}
          </button>
          <button type="button" class="theme-btn ${theme === "light" ? "is-active" : ""}" data-theme-set="light" title="Light theme">
            ${icons.sun(14)}
          </button>
        </div>
      </div>
    </aside>
  `;
}

function renderMoreDrawer(): string {
  if (!state) return "";
  const theme = getTheme();
  return `
    <div class="more-drawer-overlay" data-more-overlay ${moreDrawerOpen ? "" : "hidden"}>
      <div class="more-drawer-backdrop" data-act="close-more"></div>
      <div class="more-drawer-sheet" role="dialog" aria-label="More options">
        <button type="button" class="more-drawer-handle" data-act="close-more" aria-label="Close">
          <span class="more-drawer-grip"></span>
        </button>
        <div class="more-grid">
          <a class="more-tile" href="/v1/gatecam/export.zip" download>
            ${icons.download(22)}
            <span>Export ZIP</span>
          </a>
          <a class="more-tile" href="/v1/gatecam/report.csv" download>
            ${icons.download(22)}
            <span>Export CSV</span>
          </a>
          <button type="button" class="more-tile" data-act="clear-passes">
            ${icons.trash(22)}
            <span>Clear Passes</span>
          </button>
        </div>
        <div class="more-theme-bar">
          <span class="sidebar-theme-label">Appearance</span>
          <div class="theme-toggler" role="group" aria-label="Color theme">
            <button type="button" class="theme-btn ${theme === "dark" ? "is-active" : ""}" data-theme-set="dark">
              ${icons.moon(14)}<span>Dark</span>
            </button>
            <button type="button" class="theme-btn ${theme === "light" ? "is-active" : ""}" data-theme-set="light">
              ${icons.sun(14)}<span>Light</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderTopBar(): string {
  if (!state) return "";
  const sync = state.sync;
  const isUp = sync.connected && sync.clockLocked;
  const dotCls = isUp ? "is-up" : sync.connected ? "is-warn" : "";
  const linkSummary = isUp ? `±${sync.syncErrorBoundMs.toFixed(1)} ms` : sync.connected ? "Syncing" : "Offline";

  const backHash =
    prevRouteBeforeInspect === "passes" ? "#/passes" : prevRouteBeforeInspect === "stats" ? "#/stats" : "#/";

  let leftHtml = "";
  if (route === "inspector") {
    const titleTxt = inspectPass ? `#${inspectPass.passId} ${esc(inspectPass.callsign)}` : `Pass #${inspectPassId}`;
    leftHtml = `
      <button type="button" class="btn btn-sm" data-nav="${backHash}">
        ${icons.chevronLeft(15)}
        <span>Back</span>
      </button>
      <span class="topbar-title">${titleTxt}</span>
    `;
  } else {
    const pageTitle =
      route === "passes"
        ? "Passes"
        : route === "stats"
          ? "Accuracy"
          : route === "settings"
            ? "Settings"
            : "GateCam";
    leftHtml = `
      <div class="topbar-mobile-brand">
        <div class="brand-mark">${icons.slaprf(19)}</div>
      </div>
      <span class="topbar-title">${pageTitle}</span>
    `;
  }

  return `
    <header class="topbar">
      <div class="topbar-left">${leftHtml}</div>
      <div class="topbar-right">
        ${
          state.camInfo.simulated
            ? `<button type="button" class="btn btn-sm btn-armed" data-act="sim-pass">${icons.plus(14)}<span>Sim Pass</span></button>`
            : ""
        }
        <button type="button" class="pill ${isUp ? "is-up" : ""}" data-nav="#/settings" title="${esc(sync.lastError || sync.slaprfUrl)}">
          <span class="status-dot ${dotCls}"></span>
          <span class="mono">${esc(linkSummary)}</span>
        </button>
      </div>
    </header>
  `;
}

function renderStatusBadge(status: PassSummary["status"], conf: number): string {
  if (status === "AUTO") return `<span class="badge auto">AUTO ${Math.round(conf * 100)}%</span>`;
  if (status === "MANUAL") return `<span class="badge manual">MANUAL</span>`;
  if (status === "EXCLUDED") return `<span class="badge excl">EXCLUDED</span>`;
  return `<span class="badge warn">REVIEW</span>`;
}

function renderPassCard(p: PassSummary): string {
  const subTxt =
    p.lapNumber && p.lapRfSec !== undefined
      ? `Lap ${p.lapNumber} · ${p.lapRfSec.toFixed(3)}s (${fmtSigned(p.lapDeltaMs, 2)})`
      : `${p.peakRssiDbm.toFixed(0)} dBm · ${p.holdMs.toFixed(0)} ms hold`;
  return `
    <div class="pass-card" data-open-pass="${p.passId}">
      <img class="pass-thumb" src="/v1/gatecam/passes/${p.passId}/thumb.jpg" alt="Pass ${p.passId}" loading="lazy" />
      <div class="pass-meta">
        <div class="pass-callsign">
          <span>#${p.passId} ${esc(p.callsign)}</span>
        </div>
        <div class="pass-sub mono">${subTxt}</div>
      </div>
      <div class="pass-right">
        <span class="pass-bias">${fmtSigned(p.gateBiasMs, 2)}</span>
        ${renderStatusBadge(p.status, p.confidence)}
      </div>
    </div>
  `;
}

function renderLiveView(): string {
  if (!state) return "";
  const g = state.gate;
  const cam = state.camera;
  const ci = state.camInfo;
  const { w: fw, h: fh } = currentFrameDims();
  const st = state.stats;

  const minZoom = ci.minZoomRatio ?? 1.0;
  const curZoom = ci.zoomRatio ?? cam.zoomRatio ?? 1.0;
  const hasUltraWide = minZoom > 0.3 && minZoom < 0.9;
  const isUltra = hasUltraWide && curZoom < 0.85;
  const curFocusMode = ci.focusMode || cam.focusMode || "gate";
  const supFps = ci.supportedFps && ci.supportedFps.length > 0 ? ci.supportedFps : [60, 120];
  const isHighSpeed = cam.targetFps >= 120 && supFps.includes(120);

  return `
    <div class="live-layout">
      <div class="cam-pane">
        <div class="viewfinder-frame">
          <div class="viewfinder-stage" id="live-stage" style="aspect-ratio:${fw} / ${fh}">
            ${!isNativeUnderlay ? `<img class="preview-img" data-remote-preview src="/v1/gatecam/preview.jpg?t=${Date.now()}" alt="Start gate preview" />` : ""}
            <svg class="gate-svg" id="live-gate-svg" viewBox="0 0 ${fw} ${fh}" preserveAspectRatio="none">
              ${gateGeometrySVG(g, true, fw, fh)}
            </svg>
            <div class="vf-hud-top">
              <span class="vf-chip mono" data-hud-ring>${esc(fmtCamHudTop(ci, state.sync))}</span>
              <div class="vf-actions">
                ${
                  hasUltraWide && !isHighSpeed
                    ? `<button type="button" class="vf-btn mono" data-zoom="${isUltra ? "1.0" : minZoom.toFixed(2)}" title="Toggle Ultra-Wide / 1x">${isUltra ? "0.5x" : "1x"}</button>`
                    : ""
                }
                <button type="button" class="vf-btn" data-act="flip-dir" title="Flip flight direction">
                  ${icons.flip(13)}
                </button>
                <button type="button" class="vf-btn ${g.locked ? "is-locked" : ""}" data-act="toggle-lock" title="Lock gate sightline">
                  ${g.locked ? icons.lock(13) : icons.unlock(13)}
                  <span>${g.locked ? "Locked" : "Line"}</span>
                </button>
              </div>
            </div>
            <div class="vf-hud-bottom">
              <div class="vf-seg" role="group" aria-label="Focus distance">
                <button type="button" class="${curFocusMode === "gate" ? "is-active" : ""}" data-focus-val="gate">3m</button>
                <button type="button" class="${curFocusMode === "near" ? "is-active" : ""}" data-focus-val="near">1m</button>
                <button type="button" class="${curFocusMode === "inf" ? "is-active" : ""}" data-focus-val="inf">∞</button>
                ${curFocusMode === "tap" ? `<button type="button" class="is-active" data-act="lock-af">Spot</button>` : ""}
              </div>
              <div class="vf-seg mono" role="group" aria-label="Capture frame rate">
                <button type="button" class="${cam.targetFps === 60 ? "is-active" : ""}" data-fps="60">60</button>
                ${supFps.includes(120) ? `<button type="button" class="${cam.targetFps === 120 ? "is-active" : ""}" data-fps="120">120</button>` : ""}
                ${supFps.includes(240) ? `<button type="button" class="${cam.targetFps === 240 ? "is-active" : ""}" data-fps="240">240</button>` : ""}
              </div>
            </div>
          </div>
        </div>

        ${
          !isHighSpeed
            ? `<div class="cam-toolbar">
                 <div class="cam-toolbar-row">
                   <span class="ctrl-label">Shutter</span>
                   <div class="segmented mono" role="group" aria-label="Shutter speed">
                     <button type="button" class="${cam.shutterUs === 0 ? "is-active" : ""}" data-shutter-val="0">Auto</button>
                     <button type="button" class="${cam.shutterUs === 1000 ? "is-active" : ""}" data-shutter-val="1000">1/1000</button>
                     <button type="button" class="${cam.shutterUs === 500 ? "is-active" : ""}" data-shutter-val="500">1/2000</button>
                     <button type="button" class="${cam.shutterUs === 250 ? "is-active" : ""}" data-shutter-val="250">1/4000</button>
                   </div>
                   ${
                     hasUltraWide
                       ? `<div class="segmented mono" role="group" aria-label="Lens field of view">
                            <button type="button" class="${isUltra ? "is-active" : ""}" data-zoom="${minZoom.toFixed(2)}">0.5x</button>
                            <button type="button" class="${!isUltra ? "is-active" : ""}" data-zoom="1.0">1x</button>
                          </div>`
                       : ""
                   }
                 </div>
               </div>`
            : ""
        }
      </div>

      <aside class="feed-pane">
        <div class="stat-row">
          <div class="stat">
            <div class="stat-label">Start Bias</div>
            <div class="stat-value">${st.validPasses > 0 ? fmtSigned(st.meanBiasMs, 2) : "--"}</div>
            <div class="stat-sub">${st.validPasses > 0 ? fmtSigned(st.meanBiasCm, 1, "cm") : "RF vs camera"}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Pass Jitter</div>
            <div class="stat-value">${st.validPasses > 1 ? `±${st.stdBiasMs.toFixed(2)} ms` : "--"}</div>
            <div class="stat-sub">P95 ${st.validPasses > 0 ? `${st.p95AbsBiasMs.toFixed(1)} ms` : "--"}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Lap Error</div>
            <div class="stat-value">${st.lapCount > 1 ? `±${st.stdLapDeltaMs.toFixed(2)} ms` : "--"}</div>
            <div class="stat-sub">${st.lapCount} lap${st.lapCount === 1 ? "" : "s"}</div>
          </div>
        </div>

        <div class="feed-card">
          <div class="feed-head">
            <span class="feed-title">Start Gate Passes</span>
            <span class="badge">${st.validPasses} valid / ${st.totalPasses}</span>
          </div>
          <div class="pass-list">
            ${
              state.passes.length === 0
                ? `<div class="empty-state">
                     Align the Volt line with the Start Gate posts. Tap anywhere on the video to spot-lock focus.
                   </div>`
                : state.passes.map(renderPassCard).join("")
            }
          </div>
        </div>
      </aside>
    </div>
  `;
}

function renderPassesView(): string {
  if (!state) return "";
  const filtered = state.passes.filter((p) => {
    if (passFilter === "valid") return p.status === "AUTO" || p.status === "MANUAL";
    if (passFilter === "review") return p.status === "NEEDS_MANUAL";
    return true;
  });

  return `
    <div class="page-scroll">
      <div class="page-inner">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
          <div class="segmented" role="group" aria-label="Pass filter">
            <button type="button" class="${passFilter === "all" ? "is-active" : ""}" data-pass-filter="all">All (${state.passes.length})</button>
            <button type="button" class="${passFilter === "valid" ? "is-active" : ""}" data-pass-filter="valid">Valid (${state.stats.validPasses})</button>
            <button type="button" class="${passFilter === "review" ? "is-active" : ""}" data-pass-filter="review">Review (${state.stats.needsManualCount})</button>
          </div>
          ${
            state.passes.length > 0
              ? `<button type="button" class="btn btn-sm btn-danger" data-act="clear-passes">${icons.trash(14)}<span>Clear All</span></button>`
              : ""
          }
        </div>

        <div class="card" style="padding:10px;">
          ${
            filtered.length === 0
              ? `<div class="empty-state">No Start Gate passes match this filter yet.</div>`
              : `<div style="display:flex;flex-direction:column;gap:6px;">${filtered.map(renderPassCard).join("")}</div>`
          }
        </div>
      </div>
    </div>
  `;
}

function renderInspectorTimelineSVG(p: PassRecord, curIdx: number): string {
  const W = 600;
  const H = 78;
  const frames = p.frames;
  if (!frames || frames.length === 0) return "";
  const minRel = frames[0].relToRfMs;
  const maxRel = frames[frames.length - 1].relToRfMs;
  const span = Math.max(10, maxRel - minRel);
  const xOfMs = (ms: number) => 12 + ((ms - minRel) / span) * (W - 24);

  let rssiPts = "";
  for (const s of p.rssiTrace ?? []) {
    const x = xOfMs(s.relMs);
    const norm = Math.max(0, Math.min(1, (s.rssiDbm - -96) / 62));
    const y = H - 12 - norm * (H - 24);
    rssiPts += `${x.toFixed(1)},${y.toFixed(1)} `;
  }

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
      <line x1="12" y1="${(H * 0.5).toFixed(1)}" x2="${W - 12}" y2="${(H * 0.5).toFixed(1)}"
            stroke="rgba(163, 168, 179, 0.2)" stroke-dasharray="4 4" />
      ${rssiPts ? `<polyline fill="none" stroke="#fbbf24" stroke-width="1.75" points="${rssiPts.trim()}" />` : ""}
      ${distPts ? `<polyline fill="none" stroke="#d4ff3a" stroke-width="2" points="${distPts.trim()}" />` : ""}

      <line x1="${xRF.toFixed(1)}" y1="4" x2="${xRF.toFixed(1)}" y2="${H - 4}" stroke="#fbbf24" stroke-width="1.8" />
      <text x="${(xRF + 4).toFixed(1)}" y="12" fill="#fbbf24" font-size="10" font-family="monospace">RF</text>

      ${
        xCam !== null
          ? `<line x1="${xCam.toFixed(1)}" y1="4" x2="${xCam.toFixed(1)}" y2="${H - 4}" stroke="#d4ff3a" stroke-width="1.8" />
             <text x="${Math.max(14, xCam - 28).toFixed(1)}" y="${H - 5}" fill="#d4ff3a" font-size="10" font-family="monospace">CAM</text>`
          : ""
      }

      <line id="tl-playhead" x1="${xCur.toFixed(1)}" y1="0" x2="${xCur.toFixed(1)}" y2="${H}" stroke="#ffffff" stroke-width="1.8" />
    </svg>
  `;
}

function renderInspectorFrameOverlaySVG(p: PassRecord, f: FrameObservation | undefined): string {
  const W = f?.frameWidth || state?.camInfo?.frameWidth || 640;
  const H = f?.frameHeight || state?.camInfo?.frameHeight || 360;
  let out = showGateOverlay ? gateGeometrySVG(p.gateSnapshot, false, W, H) : "";
  if (showBlobOverlay && f && f.hasBlob) {
    const cx = f.blobCx * W;
    const cy = f.blobCy * H;
    const bx = f.blobBoxX * W;
    const by = f.blobBoxY * H;
    const bw = Math.max(12, f.blobBoxW * W);
    const bh = Math.max(12, f.blobBoxH * H);
    const color = f.onTrack ? "#34d399" : "#a3a8b3";
    out += `
      <rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}"
            rx="3" fill="none" stroke="${color}" stroke-width="2" />
      <line x1="${(cx - 8).toFixed(1)}" y1="${cy.toFixed(1)}" x2="${(cx + 8).toFixed(1)}" y2="${cy.toFixed(1)}"
            stroke="#d4ff3a" stroke-width="2" />
      <line x1="${cx.toFixed(1)}" y1="${(cy - 8).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${(cy + 8).toFixed(1)}"
            stroke="#d4ff3a" stroke-width="2" />
      <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3" fill="#d4ff3a" />
    `;
  }
  return out;
}

function renderInspectorView(): string {
  if (!inspectPass) {
    return `<div class="page-scroll"><div class="empty-state">Decoding pass #${inspectPassId} frames...</div></div>`;
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
  const fw = f?.frameWidth || 640;
  const fh = f?.frameHeight || 360;

  return `
    <div class="inspector-layout">
      <div class="inspector-main">
        <div class="inspector-bar">
          <div style="display:flex;align-items:center;gap:8px;">
            ${renderStatusBadge(p.status, p.confidence)}
            <span id="insp-frame-label" class="mono" style="font-size:12px;color:var(--text-2);">
              Fr ${inspectFrameIdx + 1}/${frames.length} · ${f ? fmtSigned(f.relToRfMs, 2) : "--"} vs RF
            </span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <div class="segmented" role="group" aria-label="Overlay layers">
              <button type="button" class="${showGateOverlay ? "is-active" : ""}" data-insp-toggle="gate">Gate</button>
              <button type="button" class="${showBlobOverlay ? "is-active" : ""}" data-insp-toggle="blob">Drone</button>
              <button type="button" class="${showMaskMode ? "is-active" : ""}" data-insp-toggle="mask">Mask</button>
            </div>
            <button type="button" class="btn btn-sm btn-icon" ${olderId ? `data-nav="#/pass/${olderId}"` : "disabled"} title="Older pass">
              ${icons.chevronLeft(15)}
            </button>
            <button type="button" class="btn btn-sm btn-icon" ${newerId ? `data-nav="#/pass/${newerId}"` : "disabled"} title="Newer pass">
              ${icons.chevronRight(15)}
            </button>
          </div>
        </div>

        <div class="inspector-frame-box">
          <div class="inspector-stage" style="aspect-ratio:${fw} / ${fh}">
            <img id="insp-img" class="preview-img" src="${frameSrc}" alt="Frame ${inspectFrameIdx}" />
            <svg id="insp-svg" class="gate-svg" viewBox="0 0 ${fw} ${fh}" preserveAspectRatio="none">
              ${renderInspectorFrameOverlaySVG(p, f)}
            </svg>
          </div>
        </div>

        <div class="timeline-card">
          ${renderInspectorTimelineSVG(p, inspectFrameIdx)}
          <div class="scrubber-bar">
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button type="button" class="btn btn-sm mono" data-insp-jump="${p.crossingFrameIdx}">@Cam #${p.crossingFrameIdx + 1}</button>
              <button type="button" class="btn btn-sm" data-insp-step="-1">${icons.chevronLeft(14)}<span>-1</span></button>
              <button type="button" class="btn btn-sm ${slowPlayTimer !== null ? "btn-armed" : ""}" data-act="slow-play">
                ${slowPlayTimer !== null ? icons.pause(13) : icons.play(13)}
                <span>${slowPlayTimer !== null ? "Pause" : "0.1x"}</span>
              </button>
              <button type="button" class="btn btn-sm" data-insp-step="1"><span>+1</span>${icons.chevronRight(14)}</button>
              <button type="button" class="btn btn-sm mono" data-insp-jump="${p.rfNearestFrameIdx}">@RF #${p.rfNearestFrameIdx + 1}</button>
            </div>
          </div>
        </div>
      </div>

      <aside class="inspector-side">
        <div class="card">
          <div class="card-head"><h2>Start Gate Timing</h2></div>
          <div class="kv-list">
            <div class="kv-row">
              <span>Start Bias (RF - Cam)</span>
              <strong class="mono">${fmtSigned(p.gateBiasMs, 2)}</strong>
            </div>
            <div class="kv-row">
              <span>Frame Offset</span>
              <span class="mono">${fmtSigned(p.gateBiasFrames, 2, "fr")}${p.spatialBiasCm !== undefined ? ` (${fmtSigned(p.spatialBiasCm, 1, "cm")})` : ""}</span>
            </div>
            ${
              p.lapNumber && p.lapRfSec !== undefined && p.lapCamSec !== undefined
                ? `<div class="kv-divider"></div>
                   <div class="kv-row">
                     <span>Lap ${p.lapNumber} (SlapRF)</span>
                     <span class="mono">${p.lapRfSec.toFixed(4)} s</span>
                   </div>
                   <div class="kv-row">
                     <span>Lap ${p.lapNumber} (Camera)</span>
                     <span class="mono">${p.lapCamSec.toFixed(4)} s</span>
                   </div>
                   <div class="kv-row">
                     <span>Lap Delta</span>
                     <strong class="mono">${fmtSigned(p.lapDeltaMs, 2)}</strong>
                   </div>`
                : ""
            }
            <div class="kv-divider"></div>
            <div class="kv-row">
              <span>RF Peak / Hold</span>
              <span class="mono">${p.peakRssiDbm.toFixed(1)} dBm / ${p.holdMs.toFixed(0)} ms</span>
            </div>
            <div class="kv-row">
              <span>Motion Model</span>
              <span class="mono">${(p.motionModel || "mog2").toUpperCase()} · ${p.blobAreaPx ?? 0} px</span>
            </div>
          </div>
        </div>

        <div class="card" style="display:flex;flex-direction:column;gap:8px;">
          <div class="card-head" style="margin-bottom:4px;"><h2>Crossing Frame</h2></div>
          <button type="button" class="btn btn-primary" id="btn-pin-frame" data-act="pin-frame">
            ${icons.pin(15)}
            <span>Pin Frame #${inspectFrameIdx + 1}</span>
          </button>
          <button type="button" class="btn" data-act="restore-auto">
            ${icons.reset(15)}
            <span>Restore Auto (#${p.autoCrossingFrameIdx + 1})</span>
          </button>
          <button type="button" class="btn ${p.status === "EXCLUDED" ? "btn-armed" : "btn-danger"}" data-act="toggle-exclude">
            ${p.status === "EXCLUDED" ? icons.check(15) : icons.ban(15)}
            <span>${p.status === "EXCLUDED" ? "Include in Accuracy" : "Exclude Pass"}</span>
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
  const svgEl = document.getElementById("insp-svg");
  if (svgEl) {
    svgEl.innerHTML = renderInspectorFrameOverlaySVG(p, f);
  }
  const lbl = document.getElementById("insp-frame-label");
  if (lbl) {
    lbl.textContent = `Fr ${inspectFrameIdx + 1}/${p.frames.length} · ${f ? fmtSigned(f.relToRfMs, 2) : "--"} vs RF`;
  }
  const pinBtn = document.getElementById("btn-pin-frame");
  if (pinBtn) {
    pinBtn.innerHTML = `${icons.pin(15)}<span>Pin Frame #${inspectFrameIdx + 1}</span>`;
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

  return `
    <div class="page-scroll stats-scroll">
      <div class="page-inner">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
          <div>
            <h2 style="font-size:15px;font-weight:650;">GateCam Verification Report</h2>
            <p style="font-size:12px;color:var(--text-3);margin-top:2px;">Start Gate RF vs high-speed optical crossing accuracy</p>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <a class="btn btn-sm btn-primary" href="/v1/gatecam/export.zip" download>
              ${icons.download(14)}
              <span>Export ZIP</span>
            </a>
            <a class="btn btn-sm" href="/v1/gatecam/report.csv" download>
              ${icons.download(14)}
              <span>CSV</span>
            </a>
            ${
              st.totalPasses > 0
                ? `<button type="button" class="btn btn-sm btn-danger" data-act="clear-passes">${icons.trash(14)}<span>Reset</span></button>`
                : ""
            }
          </div>
        </div>

        <div class="stat-row cols-4">
          <div class="stat">
            <div class="stat-label">Valid Passes</div>
            <div class="stat-value">${st.validPasses} / ${st.totalPasses}</div>
            <div class="stat-sub">${st.manualPasses} manual · ${st.excludedCount} excluded</div>
          </div>
          <div class="stat">
            <div class="stat-label">Mean Start Bias</div>
            <div class="stat-value">${st.validPasses > 0 ? fmtSigned(st.meanBiasMs, 2) : "--"}</div>
            <div class="stat-sub">${st.validPasses > 0 ? `${fmtSigned(st.meanBiasCm, 1, "cm")} spatial` : "RF - camera"}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Pass Jitter</div>
            <div class="stat-value">${st.validPasses > 1 ? `±${st.stdBiasMs.toFixed(2)} ms` : "--"}</div>
            <div class="stat-sub">P95 ${st.p95AbsBiasMs.toFixed(2)} ms · Max ${st.maxAbsBiasMs.toFixed(2)} ms</div>
          </div>
          <div class="stat">
            <div class="stat-label">Lap Error</div>
            <div class="stat-value">${st.lapCount > 1 ? `±${st.stdLapDeltaMs.toFixed(2)} ms` : "--"}</div>
            <div class="stat-sub">P95 ${st.p95AbsLapDeltaMs.toFixed(2)} ms (${st.lapCount} laps)</div>
          </div>
        </div>

        <div class="two-col">
          <div class="card">
            <div class="card-head"><h2>Start Bias Distribution</h2></div>
            ${st.histogram
              .map(
                (b) => `
              <div class="hist-row mono">
                <span>${esc(b.label)}</span>
                <div class="hist-track"><div class="hist-fill" style="width:${((b.count / maxBin) * 100).toFixed(1)}%"></div></div>
                <span class="num">${b.count}</span>
              </div>`
              )
              .join("")}
          </div>

          <div class="card">
            <div class="card-head"><h2>Bias by Drone Speed</h2></div>
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr><th>Speed Band</th><th class="num">Passes</th><th class="num">Mean Bias</th><th class="num">Jitter</th></tr>
                </thead>
                <tbody class="mono">
                  ${st.speedBuckets
                    .map(
                      (sb) => `
                    <tr>
                      <td style="font-family:var(--font-sans)">${esc(sb.label)}</td>
                      <td class="num">${sb.count}</td>
                      <td class="num">${sb.count > 0 ? fmtSigned(sb.meanBiasMs, 2) : "--"}</td>
                      <td class="num">${sb.count > 1 ? `±${sb.stdBiasMs.toFixed(2)} ms` : "--"}</td>
                    </tr>`
                    )
                    .join("")}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="card" style="padding:0;overflow:hidden;">
          <div class="card-head" style="padding:14px 16px 0;"><h2>Start Gate Pass Log</h2></div>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>#</th><th>Time</th><th>Pilot</th><th>Status</th><th class="num">Peak dBm</th>
                  <th class="num">Bias</th><th class="num">Lap</th><th class="num">SlapRF</th><th class="num">Camera</th><th class="num">Delta</th>
                </tr>
              </thead>
              <tbody class="mono">
                ${
                  state.passes.length === 0
                    ? `<tr><td colspan="10" style="text-align:center;color:var(--text-3);padding:20px;font-family:var(--font-sans);">No Start Gate passes recorded yet.</td></tr>`
                    : state.passes
                        .map(
                          (p) => `
                        <tr class="clickable" data-open-pass="${p.passId}">
                          <td>#${p.passId}</td>
                          <td>${esc(p.createdAt)}</td>
                          <td style="font-family:var(--font-sans);font-weight:600;">${esc(p.callsign)}</td>
                          <td>${renderStatusBadge(p.status, p.confidence)}</td>
                          <td class="num">${p.peakRssiDbm.toFixed(1)}</td>
                          <td class="num"><strong>${fmtSigned(p.gateBiasMs, 2)}</strong></td>
                          <td class="num">${p.lapNumber || "--"}</td>
                          <td class="num">${p.lapRfSec !== undefined ? `${p.lapRfSec.toFixed(3)}s` : "--"}</td>
                          <td class="num">${p.lapCamSec !== undefined ? `${p.lapCamSec.toFixed(3)}s` : "--"}</td>
                          <td class="num">${fmtSigned(p.lapDeltaMs, 2)}</td>
                        </tr>`
                        )
                        .join("")
                }
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderSettingsView(): string {
  if (!state) return "";
  const pilots = state.sync.pilots ?? [];
  const startGate = (state.sync.gates ?? []).find((g) => g.role === "START_FINISH");
  const startGateLabel = startGate
    ? `Locked to Start / Finish Gate (#${startGate.gateId}${startGate.name ? ` ${startGate.name}` : ""})`
    : "Automatically locks onto SlapRF's Start / Finish Gate";

  const activePilot = pilots.find((p) => p.slotIndex === settingsDraftPilot);
  const pilotTriggerHtml = activePilot
    ? `<span class="pilot-dot" style="--c:${esc(activePilot.color || "#34d399")}"></span>
       <span>Slot ${activePilot.slotIndex} · ${esc(activePilot.callsign)}</span>
       ${activePilot.frequencyMhz > 0 ? `<span class="badge mono">${activePilot.frequencyMhz} MHz</span>` : ""}`
    : `<span class="pilot-dot is-hollow"></span>
       <span>All Active Pilots</span>`;

  return `
    <div class="page-scroll">
      <div class="page-inner settings-grid">
        <div class="card">
          <div class="card-head"><h2>SlapRF Engine Link</h2></div>
          <div style="display:flex;flex-direction:column;gap:12px;">
            <div class="field">
              <label for="cfg-url">SlapRF Server URL</label>
              <div style="display:flex;gap:8px;">
                <input class="input mono" type="text" id="cfg-url" style="flex:1" value="${esc(settingsDraftUrl)}" placeholder="http://127.0.0.1:18090" />
                <button type="button" class="btn ${discoverBusy ? "btn-armed" : ""}" data-act="discover-link" ${discoverBusy ? "disabled" : ""}>
                  ${icons.radar(15)}
                  <span>${discoverBusy ? "Probing..." : "Discover"}</span>
                </button>
              </div>
              <span class="field-hint">${esc(discoverNote || startGateLabel)}</span>
            </div>

            <div class="field">
              <label>Pilot Filter</label>
              <div class="custom-select" data-pilot-dropdown>
                <button type="button" class="custom-select-btn ${pilotDropdownOpen ? "is-open" : ""}" data-act="toggle-pilot-select" aria-haspopup="listbox" aria-expanded="${pilotDropdownOpen ? "true" : "false"}">
                  <span class="custom-select-val">${pilotTriggerHtml}</span>
                  ${icons.chevronDown(15)}
                </button>
                ${
                  pilotDropdownOpen
                    ? `<div class="custom-select-menu" role="listbox">
                         <button type="button" class="custom-select-opt ${settingsDraftPilot === 0 ? "is-selected" : ""}" data-pilot-opt="0">
                           <span class="custom-select-val">
                             <span class="pilot-dot is-hollow"></span>
                             <span>All Active Pilots</span>
                           </span>
                           ${settingsDraftPilot === 0 ? `<span class="opt-check">${icons.check(14)}</span>` : ""}
                         </button>
                         ${pilots
                           .map(
                             (p) => `
                           <button type="button" class="custom-select-opt ${settingsDraftPilot === p.slotIndex ? "is-selected" : ""}" data-pilot-opt="${p.slotIndex}">
                             <span class="custom-select-val">
                               <span class="pilot-dot" style="--c:${esc(p.color || "#34d399")}"></span>
                               <span>Slot ${p.slotIndex} · ${esc(p.callsign)}</span>
                               ${p.frequencyMhz > 0 ? `<span class="badge mono">${p.frequencyMhz} MHz</span>` : ""}
                             </span>
                             ${settingsDraftPilot === p.slotIndex ? `<span class="opt-check">${icons.check(14)}</span>` : ""}
                           </button>`
                           )
                           .join("")}
                       </div>`
                    : ""
                }
              </div>
            </div>

            <div class="field">
              <label for="cfg-auth">HTTP Basic Auth (optional)</label>
              <input class="input" type="password" id="cfg-auth" value="${esc(settingsDraftAuth)}" placeholder="user:password" />
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Optical Crossing Solver</h2></div>
          <div style="display:flex;flex-direction:column;gap:14px;">
            <div class="field">
              <label>Lookback Window Around Crossing</label>
              <div class="segmented" role="group" aria-label="Lookback window" style="align-self:flex-start;">
                <button type="button" class="${settingsDraftLookback === 300 ? "is-active" : ""}" data-cfg-lb="300">±300 ms</button>
                <button type="button" class="${settingsDraftLookback === 450 ? "is-active" : ""}" data-cfg-lb="450">±450 ms</button>
                <button type="button" class="${settingsDraftLookback === 600 ? "is-active" : ""}" data-cfg-lb="600">±600 ms</button>
              </div>
            </div>

            <div class="field">
              <label>Motion Subtractor</label>
              <div class="segmented" role="group" aria-label="Motion subtractor" style="align-self:flex-start;">
                <button type="button" class="${settingsDraftModel === "mog2" ? "is-active" : ""}" data-cfg-model="mog2">MOG2</button>
                <button type="button" class="${settingsDraftModel === "knn" ? "is-active" : ""}" data-cfg-model="knn">KNN</button>
              </div>
            </div>

            <div class="field">
              <label for="cfg-sens">Motion Threshold (<span id="sens-lbl" class="mono">${settingsDraftSens.toFixed(0)}</span>)</label>
              <input type="range" id="cfg-sens" min="6" max="40" step="2" value="${settingsDraftSens}" />
              <span class="field-hint">Lower values detect smaller distant drones; higher values reject wind shake.</span>
            </div>

            <div class="check-row">
              <span>Rolling-shutter readout skew compensation</span>
              <label class="switch">
                <input type="checkbox" id="cfg-rsshutter" ${settingsDraftRsComp ? "checked" : ""} />
                <span></span>
              </label>
            </div>
          </div>
        </div>

        <div style="display:flex;justify-content:flex-end;">
          <button type="button" class="btn btn-primary" data-act="save-setup" style="height:38px;padding:0 18px;">
            ${icons.check(15)}
            <span>Save Settings</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function render(): void {
  if (!state) {
    appRoot.innerHTML = `<div style="padding:32px;color:var(--text-3);">Starting SlapRF GateCam...</div>`;
    return;
  }
  const outletHtml =
    route === "inspector"
      ? renderInspectorView()
      : route === "passes"
        ? renderPassesView()
        : route === "stats"
          ? renderStatsView()
          : route === "settings"
            ? renderSettingsView()
            : renderLiveView();

  appRoot.innerHTML = `
    <div class="app-shell ${route === "inspector" ? "is-subpage" : ""}">
      ${renderSidebar()}
      <div class="main-col">
        ${renderTopBar()}
        <main class="outlet">${outletHtml}</main>
      </div>
      ${renderMoreDrawer()}
    </div>
  `;
  bindLivePointerHandlers();
  bindTimelineScrubHandlers();
  if (route === "live") {
    requestAnimationFrame(syncNativePreviewBounds);
  }
}

function bindLivePointerHandlers(): void {
  const svgEl = document.getElementById("live-gate-svg");
  if (!svgEl || !state) return;

  svgEl.onpointerdown = (e: PointerEvent) => {
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
      svgEl.setPointerCapture(e.pointerId);
      return;
    }

    const r = svgEl.getBoundingClientRect();
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

  svgEl.onpointermove = (e: PointerEvent) => {
    if (!dragHandle || !state) return;
    const r = svgEl.getBoundingClientRect();
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
    svgEl.innerHTML = gateGeometrySVG(state.gate, true, fw, fh);
  };

  const finishDrag = () => {
    if (!dragHandle || !state) return;
    dragHandle = null;
    void updateGate(state.gate);
  };
  svgEl.onpointerup = finishDrag;
  svgEl.onpointercancel = finishDrag;
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

document.addEventListener("pointerdown", (e) => {
  if (!pilotDropdownOpen) return;
  const t = e.target as HTMLElement | null;
  if (!t?.closest("[data-pilot-dropdown]")) {
    pilotDropdownOpen = false;
    render();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && (pilotDropdownOpen || moreDrawerOpen)) {
    pilotDropdownOpen = false;
    moreDrawerOpen = false;
    render();
  }
});

appRoot.addEventListener("click", async (e) => {
  const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(
    "[data-nav],[data-open-pass],[data-fps],[data-zoom],[data-focus-val],[data-shutter-val],[data-pass-filter],[data-cfg-lb],[data-cfg-model],[data-pilot-opt],[data-theme-set],[data-act],[data-insp-step],[data-insp-jump],[data-insp-toggle]"
  );
  if (!el || !state) return;

  const themeAttr = el.getAttribute("data-theme-set");
  if (themeAttr === "dark" || themeAttr === "light") {
    setTheme(themeAttr);
    return;
  }

  const pilotOpt = el.getAttribute("data-pilot-opt");
  if (pilotOpt !== null) {
    settingsDraftPilot = parseInt(pilotOpt, 10) || 0;
    pilotDropdownOpen = false;
    render();
    return;
  }

  const nav = el.getAttribute("data-nav");
  if (nav) {
    moreDrawerOpen = false;
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
    const nextFps = nextZoom < 0.9 && state.camera.targetFps > 60 ? 60 : state.camera.targetFps;
    await updateCamera({ ...state.camera, zoomRatio: nextZoom, targetFps: nextFps });
    return;
  }
  const focusVal = el.getAttribute("data-focus-val");
  if (focusVal) {
    await updateCamera({ ...state.camera, focusMode: focusVal, focusLocked: true });
    return;
  }
  const shutterVal = el.getAttribute("data-shutter-val");
  if (shutterVal) {
    await updateCamera({ ...state.camera, shutterUs: parseInt(shutterVal, 10) || 0 });
    return;
  }
  const pf = el.getAttribute("data-pass-filter");
  if (pf === "all" || pf === "valid" || pf === "review") {
    passFilter = pf;
    render();
    return;
  }
  const cfgLb = el.getAttribute("data-cfg-lb");
  if (cfgLb) {
    settingsDraftLookback = parseInt(cfgLb, 10) || 450;
    render();
    return;
  }
  const cfgModel = el.getAttribute("data-cfg-model");
  if (cfgModel) {
    settingsDraftModel = cfgModel;
    render();
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

  const act = el.getAttribute("data-act");
  switch (act) {
    case "toggle-more":
      moreDrawerOpen = !moreDrawerOpen;
      render();
      break;
    case "close-more":
      moreDrawerOpen = false;
      render();
      break;
    case "toggle-pilot-select":
      pilotDropdownOpen = !pilotDropdownOpen;
      render();
      break;
    case "discover-link": {
      discoverBusy = true;
      discoverNote = "Probing SlapRF ports (:18090, :8090)...";
      render();
      try {
        const res = await apiJSON<{ found: boolean; slaprfUrl: string; state: AppState }>(
          "POST",
          "/v1/gatecam/link:discover",
          { hintUrl: settingsDraftUrl, basicAuth: settingsDraftAuth }
        );
        state = res.state;
        if (res.found && res.slaprfUrl) {
          settingsDraftUrl = res.slaprfUrl;
          discoverNote = `Connected to ${res.slaprfUrl}`;
        } else {
          discoverNote = "No SlapRF server responded on :18090 or :8090";
        }
      } catch {
        discoverNote = "Discovery probe failed";
      } finally {
        discoverBusy = false;
        render();
      }
      break;
    }
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
      moreDrawerOpen = false;
      state = await apiJSON<AppState>("POST", "/v1/gatecam/passes:clear", {});
      render();
      break;
    case "save-setup": {
      await apiJSON("PUT", "/v1/gatecam/camera", {
        ...state.camera,
        lookbackHalfMs: settingsDraftLookback,
        motionModel: settingsDraftModel,
        sensitivity: settingsDraftSens,
        rollingShutterComp: settingsDraftRsComp,
      });
      state = await apiJSON<AppState>("PUT", "/v1/gatecam/link", {
        slaprfUrl: settingsDraftUrl.trim(),
        basicAuth: settingsDraftAuth,
        gateFilter: 0,
        pilotFilter: settingsDraftPilot,
        exposeLan: false,
      });
      window.location.hash = "#/";
      break;
    }
  }
});

appRoot.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement | null;
  if (!t) return;
  if (t.id === "cfg-url") {
    settingsDraftUrl = t.value;
  } else if (t.id === "cfg-auth") {
    settingsDraftAuth = t.value;
  } else if (t.id === "cfg-sens") {
    settingsDraftSens = parseFloat(t.value) || 16;
    const lbl = document.getElementById("sens-lbl");
    if (lbl) lbl.textContent = t.value;
  }
});

appRoot.addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement | null;
  if (t?.id === "cfg-rsshutter") {
    settingsDraftRsComp = t.checked;
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
        if (!dragHandle && route !== "settings") render();
      } else if (msg.type === "hud" && msg.payload && state) {
        state.camInfo = msg.payload.camera;
        state.sync = msg.payload.sync;
        const ringEl = document.querySelector("[data-hud-ring]");
        if (ringEl) {
          ringEl.textContent = fmtCamHudTop(state.camInfo, state.sync);
        }
      } else if ((msg.type === "pass_added" || msg.type === "pass_updated") && state) {
        void refreshStateSilently().then(() => {
          if (!dragHandle && route !== "inspector" && route !== "settings") render();
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
  loadSettingsDraftFromState();
  syncRouteFromHash();
  connectLiveWS();
}

void boot();
