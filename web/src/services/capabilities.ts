/**
 * Runtime capability detection & Backend Server connection manager.
 *
 * Distinguishes two clean operating modes:
 * 1. Native Go Backend Mode (`caps.portable === true`):
 *    - Either served directly from the `slaprf` Go binary (`backendBaseUrl === ""`), OR
 *    - Connected remotely from `https://slaprf.app` (or any static host) to a local (`127.0.0.1:8090`)
 *      or LAN / Raspberry Pi (`192.168.x.x:8090`) SlapRF Go server (`remoteBackend === true`).
 *    - Zero WebAssembly (`slaprf.wasm`) is loaded and zero browser `IndexedDB` is used; all engines,
 *      `bbolt` (`slaprf.db`) persistence, native USB serial, ESP32-C5 flashing, LapRF 8-Way,
 *      RotorHazard, LapRF Emulator :5403, and MultiGP run natively in Go.
 * 2. Standalone Browser Demo Mode (`caps.portable === false`, `caps.demoMode === true`):
 *    - Runs on `https://slaprf.app` when no Go server is connected.
 *    - Runs strictly in Demo Simulator Mode (`Simulation ON`) using `slaprf.wasm` + `IndexedDB`,
 *      showcasing 100% of simulated capabilities while allowing 1-click connection to a Go server.
 */

import { appendAuthParamToWsUrl } from "./auth";

export const PORTABLE_RELEASES_URL = "https://github.com/kaack/SlapRF/releases/latest";
export const ANDROID_APK_URL = `${PORTABLE_RELEASES_URL}/download/slaprf-android-arm64.apk`;
export const IOS_IPA_URL = `${PORTABLE_RELEASES_URL}/download/slaprf-ios-arm64.ipa`;
export const IOS_SIDELOADLY_URL = `sideloadly://?url=${encodeURIComponent(IOS_IPA_URL)}`;
export const ALTSTORE_SOURCE_URL = "https://slaprf.app/altstore-source.json";
export const IOS_SIDESTORE_URL = `sidestore://source?url=${encodeURIComponent(ALTSTORE_SOURCE_URL)}`;

export const BACKEND_URL_STORAGE_KEY = "slaprf.backend.url";
export const BACKEND_RECENT_STORAGE_KEY = "slaprf.backend.recent";
export const DEFAULT_LOCAL_SERVER_URL = "http://127.0.0.1:8090";

export interface PortableAsset {
  os: "windows" | "macos" | "linux";
  label: string;
  file: string;
}

/** Matches .github/workflows/release.yml asset names. */
export const PORTABLE_ASSETS: PortableAsset[] = [
  { os: "windows", label: "Windows (x64)", file: "slaprf-windows-amd64.exe" },
  { os: "macos", label: "macOS (Apple silicon)", file: "slaprf-macos-arm64" },
  { os: "macos", label: "macOS (Intel)", file: "slaprf-macos-amd64" },
  { os: "linux", label: "Linux (x64)", file: "slaprf-linux-amd64" },
  { os: "linux", label: "Linux (ARM64 / Raspberry Pi)", file: "slaprf-linux-arm64" },
];

export function detectClientOs(): PortableAsset["os"] | null {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = `${nav.userAgentData?.platform ?? ""} ${navigator.platform ?? ""} ${navigator.userAgent}`.toLowerCase();
  if (p.includes("win")) return "windows";
  if (p.includes("mac")) return "macos";
  if (p.includes("linux") && !p.includes("android")) return "linux";
  return null;
}

export function orderedPortableAssets(): Array<PortableAsset & { recommended: boolean }> {
  const os = detectClientOs();
  return [...PORTABLE_ASSETS]
    .sort((a, b) => Number(b.os === os) - Number(a.os === os))
    .map((a, idx) => ({ ...a, recommended: a.os === os && idx === 0 }));
}

export interface RuntimeCapabilities {
  probed: boolean;
  /** True whenever connected to a native Go SlapRF backend (same-origin OR remote). */
  portable: boolean;
  /** True when running standalone in the browser with no Go backend connected (Simulator Demo only). */
  demoMode: boolean;
  /** Empty string (`""`) for same-origin Go server, or `"http://127.0.0.1:8090"` when connected remotely. */
  backendBaseUrl: string;
  /** True when connected cross-origin to a Go backend (e.g. `https://slaprf.app` -> `http://127.0.0.1:8090`). */
  remoteBackend: boolean;
  version: string;
  hostname: string;
  storageBackend: "bbolt" | "indexeddb";
  nativeEngine: boolean;
  nativeUsb: boolean;
  lanIPs: string[];
  laprfEmulator: boolean;
  laprfClient: boolean;
  rotorhazardDiscover: boolean;
  multigpProxy: boolean;
  authRequired?: boolean;
  authenticated?: boolean;
  /** Non-null when running in Demo Mode and a local Go server was auto-detected on `127.0.0.1:8090`. */
  localDetectedUrl: string | null;
}

export type BackendModalReason = "connect" | "real-hardware" | "manage";

type CapabilitiesListener = (caps: RuntimeCapabilities) => void;
type BackendModalOpener = (reason: BackendModalReason) => void;

let currentCaps: RuntimeCapabilities = {
  probed: false,
  portable: false,
  demoMode: true,
  backendBaseUrl: "",
  remoteBackend: false,
  version: "web",
  hostname: "",
  storageBackend: "indexeddb",
  nativeEngine: false,
  nativeUsb: false,
  lanIPs: [],
  laprfEmulator: false,
  laprfClient: false,
  rotorhazardDiscover: false,
  multigpProxy: false,
  localDetectedUrl: null,
};

export type DatasourceServerIntent = "none" | "inspect" | "connect" | "real-hardware";
type DatasourceIntentListener = (intent: DatasourceServerIntent) => void;

export interface BackendConnectionLostState {
  lost: boolean;
  serverUrl: string;
}
type ConnectionLostListener = (state: BackendConnectionLostState) => void;

const listeners = new Set<CapabilitiesListener>();
const intentListeners = new Set<DatasourceIntentListener>();
const connectionLostListeners = new Set<ConnectionLostListener>();
let modalOpener: BackendModalOpener | null = null;
let latestDatasourceIntent: DatasourceServerIntent = "none";
let datasourceUiMode: "demo" | "server" = "demo";
let connectionLostState: BackendConnectionLostState = {
  lost: false,
  serverUrl: "",
};

export function capabilitiesSnapshot(): RuntimeCapabilities {
  return currentCaps;
}

export function getDatasourceUiMode(): "demo" | "server" {
  return currentCaps.portable ? "server" : datasourceUiMode;
}

export function setDatasourceUiMode(mode: "demo" | "server"): void {
  const next = currentCaps.portable ? "server" : mode;
  if (datasourceUiMode === next) return;
  datasourceUiMode = next;
  if (!currentCaps.portable && typeof window !== "undefined") {
    try {
      window.slaprfWasm?.setRunning(next === "demo");
    } catch {
      // Ignore if WASM is not yet initialized
    }
  }
  notify();
}

/**
 * True when the user has selected `Server` mode in Datasource while NOT connected to any
 * SlapRF Server. While true, all Settings (except Backend connection) and all Sidebar tabs
 * (except Settings) are locked out until connected or switched back to `Demo`.
 */
export function isServerDisconnectedLockout(): boolean {
  return !currentCaps.portable && datasourceUiMode === "server";
}

export function connectionLostSnapshot(): BackendConnectionLostState {
  return connectionLostState;
}

export function subscribeConnectionLost(fn: ConnectionLostListener): () => void {
  connectionLostListeners.add(fn);
  return () => connectionLostListeners.delete(fn);
}

function notifyConnectionLost(): void {
  const snap = connectionLostState;
  connectionLostListeners.forEach((fn) => {
    try {
      fn(snap);
    } catch (err) {
      console.error("[capabilities] connection-lost listener error:", err);
    }
  });
}

export function reportBackendConnectionLost(serverUrl?: string): void {
  const resolved =
    (serverUrl && serverUrl.trim()) ||
    currentCaps.backendBaseUrl ||
    (typeof window !== "undefined" ? window.location.origin : DEFAULT_LOCAL_SERVER_URL);
  if (connectionLostState.lost && connectionLostState.serverUrl === resolved) {
    return;
  }
  connectionLostState = { lost: true, serverUrl: resolved };
  notifyConnectionLost();
}

export function clearBackendConnectionLost(): void {
  if (!connectionLostState.lost) return;
  connectionLostState = { lost: false, serverUrl: "" };
  notifyConnectionLost();
}

export function subscribeCapabilities(fn: CapabilitiesListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function subscribeDatasourceIntent(fn: DatasourceIntentListener): () => void {
  intentListeners.add(fn);
  return () => intentListeners.delete(fn);
}

export function consumeDatasourceIntent(): DatasourceServerIntent {
  const cur = latestDatasourceIntent;
  latestDatasourceIntent = "none";
  return cur;
}

export function registerBackendConnectModalOpener(fn: BackendModalOpener | null): void {
  modalOpener = fn;
}

/**
 * Navigates to `#/setup/datasource` and updates the inline Datasource editor state
 * (without opening any modal dialog).
 */
export function openDatasourceSettings(intent: DatasourceServerIntent = "inspect"): void {
  const hasUiConsumer = modalOpener !== null || intentListeners.size > 0;
  if (hasUiConsumer) {
    latestDatasourceIntent = intent;
    if (!currentCaps.portable && (intent === "connect" || intent === "real-hardware")) {
      datasourceUiMode = "server";
      try {
        window.slaprfWasm?.setRunning(false);
      } catch {
        // ignore
      }
      notify();
    }
  }
  const reason: BackendModalReason =
    intent === "real-hardware" ? "real-hardware" : intent === "connect" ? "connect" : "manage";
  if (modalOpener) {
    modalOpener(reason);
  }
  intentListeners.forEach((fn) => {
    try {
      fn(intent);
    } catch (err) {
      console.error("[capabilities] datasource intent listener error:", err);
    }
  });
}

export function openBackendConnectModal(reason: BackendModalReason = "connect"): void {
  const intent: DatasourceServerIntent =
    reason === "real-hardware" ? "real-hardware" : reason === "connect" ? "connect" : "inspect";
  openDatasourceSettings(intent);
}

function notify(): void {
  const snap = currentCaps;
  listeners.forEach((fn) => {
    try {
      fn(snap);
    } catch (err) {
      console.error("[capabilities] listener error:", err);
    }
  });
}

export function isLoopbackHostname(host: string): boolean {
  const clean = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return clean === "127.0.0.1" || clean === "localhost" || clean === "::1";
}

/**
 * Normalizes user-entered server strings (`"127.0.0.1:8090"`, `"raspberrypi.local"`, `"http://192.168.1.50:8090/"`)
 * into a canonical origin URL with no trailing slash (`"http://127.0.0.1:8090"`).
 */
export function normalizeBackendUrl(raw: string): string {
  let s = raw.trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) {
    if (/^wss?:\/\//i.test(s)) {
      s = s.replace(/^ws/i, "http");
    } else {
      s = `http://${s}`;
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "";
  }
  // Default to port 8090 when user enters a bare hostname/IP (e.g. `192.168.1.50` or `raspberrypi.local`) over HTTP
  if (!parsed.port && parsed.protocol === "http:" && !s.includes(":80")) {
    parsed.port = "8090";
  }
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Checks whether an HTTPS page (`https://slaprf.app`) would be blocked by browser Mixed-Content rules
 * when opening an unencrypted `ws://` WebSocket to a non-loopback LAN `http://` server.
 * Note: W3C Secure Contexts explicitly exempt loopback (`http://127.0.0.1` / `ws://127.0.0.1`), so
 * `https://slaprf.app` -> `http://127.0.0.1:8090` works natively!
 */
export function isMixedContentRemoteBlocked(pageProtocol: string, backendBaseUrl: string): boolean {
  if (pageProtocol !== "https:" || !backendBaseUrl) return false;
  try {
    const u = new URL(backendBaseUrl);
    if (u.protocol === "https:") return false;
    return !isLoopbackHostname(u.hostname);
  } catch {
    return false;
  }
}

/** Resolves a `/v1/...` path against the active Go backend (`""` same-origin or remote base URL). */
export function resolveBackendUrl(path: string, explicitBase?: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = (explicitBase ?? currentCaps.backendBaseUrl).replace(/\/+$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return base ? `${base}${cleanPath}` : cleanPath;
}

/** Resolves a WebSocket `/v1/ws/...` path (`ws://` or `wss://`) against the active Go backend. */
export function resolveBackendWsUrl(path: string, explicitBase?: string): string {
  if (/^wss?:\/\//i.test(path)) return appendAuthParamToWsUrl(path);
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const base = (explicitBase ?? currentCaps.backendBaseUrl).replace(/\/+$/, "");
  if (base) {
    const u = new URL(base);
    const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
    return appendAuthParamToWsUrl(`${wsProto}//${u.host}${cleanPath}`);
  }
  const pageProto = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";
  const pageHost = typeof window !== "undefined" ? window.location.host : "127.0.0.1:8090";
  return appendAuthParamToWsUrl(`${pageProto}//${pageHost}${cleanPath}`);
}

export function getSavedBackendUrl(): string {
  if (typeof window === "undefined") return "";
  try {
    // Allow `?server=http://...` query parameter for 1-click connection (or `?server=demo` to disconnect)
    const params = new URLSearchParams(window.location.search);
    const qServer = params.get("server");
    if (qServer !== null) {
      const cleanQ = qServer.trim();
      if (!cleanQ || cleanQ.toLowerCase() === "demo" || cleanQ.toLowerCase() === "none") {
        window.localStorage.removeItem(BACKEND_URL_STORAGE_KEY);
        return "";
      }
      const norm = normalizeBackendUrl(cleanQ);
      if (norm) {
        window.localStorage.setItem(BACKEND_URL_STORAGE_KEY, norm);
        rememberRecentBackendUrl(norm);
        return norm;
      }
    }
    const saved = window.localStorage.getItem(BACKEND_URL_STORAGE_KEY) ?? "";
    return saved ? normalizeBackendUrl(saved) : "";
  } catch {
    return "";
  }
}

export function getRecentBackendUrls(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(BACKEND_RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === "string")
      .map((x) => normalizeBackendUrl(x))
      .filter(Boolean)
      .slice(0, 5);
  } catch {
    return [];
  }
}

export function rememberRecentBackendUrl(url: string): void {
  const norm = normalizeBackendUrl(url);
  if (!norm || typeof window === "undefined") return;
  try {
    const existing = getRecentBackendUrls().filter((u) => u !== norm);
    existing.unshift(norm);
    window.localStorage.setItem(BACKEND_RECENT_STORAGE_KEY, JSON.stringify(existing.slice(0, 5)));
  } catch {
    // Ignore storage errors
  }
}

export function removeRecentBackendUrl(url: string): void {
  const norm = normalizeBackendUrl(url);
  if (typeof window === "undefined") return;
  try {
    const next = getRecentBackendUrls().filter((u) => u !== norm);
    window.localStorage.setItem(BACKEND_RECENT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage errors
  }
}

function buildBackendCaps(
  data: Partial<RuntimeCapabilities> & { hostname?: string; storageBackend?: string; nativeEngine?: boolean; nativeUsb?: boolean },
  backendBaseUrl: string,
  remoteBackend: boolean
): RuntimeCapabilities {
  return {
    probed: true,
    portable: true,
    demoMode: false,
    backendBaseUrl,
    remoteBackend,
    version: typeof data.version === "string" && data.version ? data.version : "portable",
    hostname: typeof data.hostname === "string" ? data.hostname : "",
    storageBackend: data.storageBackend === "bbolt" ? "bbolt" : "bbolt",
    nativeEngine: Boolean(data.nativeEngine ?? true),
    nativeUsb: Boolean(data.nativeUsb ?? true),
    lanIPs: Array.isArray(data.lanIPs) ? data.lanIPs.filter((x): x is string => typeof x === "string") : [],
    laprfEmulator: Boolean(data.laprfEmulator ?? true),
    laprfClient: Boolean(data.laprfClient ?? true),
    rotorhazardDiscover: Boolean(data.rotorhazardDiscover ?? true),
    multigpProxy: Boolean(data.multigpProxy ?? true),
    authRequired: Boolean(data.authRequired),
    authenticated: Boolean(data.authenticated ?? !data.authRequired),
    localDetectedUrl: null,
  };
}

async function fetchCapsAt(baseUrl: string, timeoutMs = 1500): Promise<RuntimeCapabilities | null> {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl && typeof window !== "undefined" ? window.setTimeout(() => ctrl.abort(), timeoutMs) : null;
  const target = baseUrl ? `${baseUrl.replace(/\/+$/, "")}/v1/capabilities` : "/v1/capabilities";
  try {
    const resp = await fetch(target, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: ctrl?.signal,
    });
    if (!resp.ok) return null;
    const ct = resp.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) return null;
    const data = (await resp.json()) as Partial<RuntimeCapabilities>;
    if (data && data.portable === true) {
      const sameOrigin =
        !baseUrl ||
        (typeof window !== "undefined" && baseUrl.toLowerCase() === window.location.origin.toLowerCase());
      return buildBackendCaps(data, sameOrigin ? "" : baseUrl, !sameOrigin);
    }
  } catch {
    // Unreachable or static site
  } finally {
    if (timer !== null && typeof window !== "undefined") window.clearTimeout(timer);
  }
  return null;
}

export interface ProbeBackendResult {
  ok: boolean;
  normalizedUrl: string;
  caps?: RuntimeCapabilities;
  mixedContentBlocked?: boolean;
  error?: string;
}

/**
 * Tests a candidate Go backend URL from the Connect Server modal before switching the app to it.
 */
export async function probeBackendCandidate(rawUrl: string): Promise<ProbeBackendResult> {
  const normalizedUrl = normalizeBackendUrl(rawUrl);
  if (!normalizedUrl) {
    return {
      ok: false,
      normalizedUrl: "",
      error: "Enter a valid server address (for example 127.0.0.1:8090 or 192.168.1.50:8090).",
    };
  }
  const pageProto = typeof window !== "undefined" ? window.location.protocol : "http:";
  if (isMixedContentRemoteBlocked(pageProto, normalizedUrl)) {
    return {
      ok: false,
      normalizedUrl,
      mixedContentBlocked: true,
      error:
        "HTTPS pages cannot open unencrypted LAN WebSockets (ws://). Open the Track Server's built-in UI directly at the link below, or connect over localhost (127.0.0.1:8090).",
    };
  }
  const caps = await fetchCapsAt(normalizedUrl, 3000);
  if (!caps) {
    return {
      ok: false,
      normalizedUrl,
      error: `Could not reach a SlapRF Server at ${normalizedUrl}. Make sure slaprf is running (use "slaprf -lan" for LAN / Raspberry Pi connections).`,
    };
  }
  return { ok: true, normalizedUrl, caps };
}

export async function probeServerReachable(
  baseUrl = "",
  timeoutMs = 1500
): Promise<RuntimeCapabilities | null> {
  return await fetchCapsAt(baseUrl, timeoutMs);
}

/**
 * On-demand check for a local `127.0.0.1:8090` SlapRF Server. Invoked only when the user
 * explicitly requests local discovery from Settings -> Datasource -> Server so public origins
 * (`https://slaprf.app`) never trigger Chrome's "Apps on device" permission prompt on initial load.
 */
export async function discoverLocalServer(timeoutMs = 2000): Promise<string | null> {
  const detected = await fetchCapsAt(DEFAULT_LOCAL_SERVER_URL, timeoutMs);
  if (detected) {
    if (!currentCaps.portable && currentCaps.localDetectedUrl !== DEFAULT_LOCAL_SERVER_URL) {
      currentCaps = {
        ...currentCaps,
        localDetectedUrl: DEFAULT_LOCAL_SERVER_URL,
      };
      notify();
    }
    return DEFAULT_LOCAL_SERVER_URL;
  }
  if (!currentCaps.portable && currentCaps.localDetectedUrl !== null) {
    currentCaps = {
      ...currentCaps,
      localDetectedUrl: null,
    };
    notify();
  }
  return null;
}

/**
 * Transitions from an unreachable / lost SlapRF Server connection into the disconnected
 * `Server` Settings lockout without forcing a full-page browser reload (preventing browser
 * `ERR_CONNECTION_REFUSED` if the same-origin server went offline).
 */
export function enterDisconnectedServerSettingsMode(): string {
  const lostUrl =
    connectionLostState.serverUrl ||
    currentCaps.backendBaseUrl ||
    (typeof window !== "undefined" ? window.location.origin : DEFAULT_LOCAL_SERVER_URL);
  const normLost = normalizeBackendUrl(lostUrl);
  if (typeof window !== "undefined") {
    try {
      if (normLost) {
        rememberRecentBackendUrl(normLost);
      }
      window.localStorage.removeItem(BACKEND_URL_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  currentCaps = {
    probed: true,
    portable: false,
    demoMode: true,
    backendBaseUrl: "",
    remoteBackend: false,
    version: "web",
    hostname: "",
    storageBackend: "indexeddb",
    nativeEngine: false,
    nativeUsb: false,
    lanIPs: [],
    laprfEmulator: false,
    laprfClient: false,
    rotorhazardDiscover: false,
    multigpProxy: false,
    localDetectedUrl: null,
  };
  datasourceUiMode = "server";
  clearBackendConnectionLost();
  notify();
  return normLost || DEFAULT_LOCAL_SERVER_URL;
}

/**
 * Saves `rawUrl` as the active backend server and reloads into Native Go Backend Mode.
 */
export async function connectToBackend(
  rawUrl: string,
  opts?: { disableSimOnConnect?: boolean }
): Promise<RuntimeCapabilities> {
  const res = await probeBackendCandidate(rawUrl);
  if (!res.ok || !res.caps) {
    throw new Error(res.error || "Unable to connect to SlapRF Server.");
  }
  if (opts?.disableSimOnConnect) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer =
      ctrl && typeof window !== "undefined" ? window.setTimeout(() => ctrl.abort(), 1500) : null;
    try {
      await fetch(`${res.normalizedUrl}/v1/sim`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ running: false }),
        signal: ctrl?.signal,
      });
    } catch {
      // Best-effort pre-reload sync
    } finally {
      if (timer !== null && typeof window !== "undefined") window.clearTimeout(timer);
    }
  }
  if (typeof window !== "undefined") {
    try {
      const sameOrigin = res.normalizedUrl.toLowerCase() === window.location.origin.toLowerCase();
      if (sameOrigin) {
        window.localStorage.removeItem(BACKEND_URL_STORAGE_KEY);
      } else {
        window.localStorage.setItem(BACKEND_URL_STORAGE_KEY, res.normalizedUrl);
        rememberRecentBackendUrl(res.normalizedUrl);
      }
      clearBackendConnectionLost();
      // Strip any `?server=...` query param before reload so future disconnects work cleanly
      const cleanHref = `${window.location.origin}${window.location.pathname}${window.location.hash}`;
      if (window.location.search) {
        window.location.replace(cleanHref);
      } else {
        window.location.reload();
      }
    } catch {
      // Ignore navigation errors in headless unit tests
    }
  }
  return res.caps;
}

/**
 * Disconnects from a remotely configured Go backend and reloads into Standalone Browser Demo Mode.
 */
export function disconnectFromBackend(): void {
  if (typeof window === "undefined") return;
  try {
    datasourceUiMode = "demo";
    clearBackendConnectionLost();
    window.localStorage.removeItem(BACKEND_URL_STORAGE_KEY);
    const cleanHref = `${window.location.origin}${window.location.pathname}${window.location.hash}`;
    if (window.location.search) {
      window.location.replace(cleanHref);
    } else {
      window.location.reload();
    }
  } catch {
    // Ignore storage/navigation errors
  }
}

export async function probeCapabilities(): Promise<RuntimeCapabilities> {
  datasourceUiMode = "demo";
  clearBackendConnectionLost();

  // 1. Check same-origin Go server first (when UI is served directly by `slaprf`).
  const sameOriginCaps = await fetchCapsAt("", 1500);
  if (sameOriginCaps) {
    datasourceUiMode = "server";
    currentCaps = sameOriginCaps;
    notify();
    return currentCaps;
  }

  // 2. Check configured remote backend URL (`?server=...` or `slaprf.backend.url`).
  const savedRemote = getSavedBackendUrl();
  const pageProto = typeof window !== "undefined" ? window.location.protocol : "http:";
  if (savedRemote && !isMixedContentRemoteBlocked(pageProto, savedRemote)) {
    const remoteCaps = await fetchCapsAt(savedRemote, 2200);
    if (remoteCaps) {
      rememberRecentBackendUrl(savedRemote);
      datasourceUiMode = "server";
      currentCaps = remoteCaps;
      notify();
      return currentCaps;
    }
    // Configured remote server is unreachable on boot — surface the connection-lost screen!
    datasourceUiMode = "server";
    reportBackendConnectionLost(savedRemote);
  }

  // 3. Fall back to Standalone Browser Demo Mode (`slaprf.wasm` + `IndexedDB`, Simulation ON locked).
  //    Do NOT probe `127.0.0.1:8090` automatically on initial load from a public origin (`slaprf.app`),
  //    as that triggers Chrome's "Apps on device" / Local Network Access permission prompt before the
  //    user ever asks to connect to a local server.
  currentCaps = {
    probed: true,
    portable: false,
    demoMode: true,
    backendBaseUrl: "",
    remoteBackend: false,
    version: "web",
    hostname: "",
    storageBackend: "indexeddb",
    nativeEngine: false,
    nativeUsb: false,
    lanIPs: [],
    laprfEmulator: false,
    laprfClient: false,
    rotorhazardDiscover: false,
    multigpProxy: false,
    localDetectedUrl: null,
  };
  notify();

  return currentCaps;
}
