/**
 * Basic Authentication manager for SlapRF.
 *
 * - Native Go Server Mode (`caps.portable === true`):
 *   Authentication is enforced at the Go HTTP server level (`/v1/*` and `/v1/ws/*`)
 *   against credentials stored in `slaprf.db` (`auth.config`).
 * - Standalone Browser Demo Mode (`caps.portable === false`):
 *   Authentication is stored in `localStorage` (`slaprf.auth.demo.v1`) and enforced
 *   on the boot loading screen before entering the application.
 */

export const DEMO_AUTH_STORAGE_KEY = "slaprf.auth.demo.v1";
export const REMEMBERED_AUTH_STORAGE_KEY = "slaprf.auth.remembered.v1";

export interface RememberedAuthCredentials {
  mode: "server" | "demo";
  backendBaseUrl: string;
  username: string;
  token: string;
}

export interface AuthConfigStatus {
  enabled: boolean;
  username: string;
  password: string;
  hasPassword: boolean;
}

interface StoredDemoAuthConfig {
  enabled: boolean;
  username: string;
  password: string;
}

let activeBasicToken = "";
let demoSessionUnlocked = false;
let fetchInterceptorInstalled = false;

export function encodeBasicToken(username: string, password: string): string {
  const raw = `${username}:${password}`;
  try {
    const bytes = new TextEncoder().encode(raw);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) {
      bin += String.fromCharCode(bytes[i]);
    }
    return window.btoa(bin);
  } catch {
    return typeof window !== "undefined" ? window.btoa(raw) : "";
  }
}

export function getActiveBasicToken(): string {
  return activeBasicToken;
}

export function setActiveBasicToken(token: string): void {
  activeBasicToken = token.trim();
}

export function decodeBasicToken(token: string): { username: string; password: string } | null {
  if (!token || typeof window === "undefined") return null;
  try {
    const bin = window.atob(token);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    const raw = new TextDecoder().decode(bytes);
    const idx = raw.indexOf(":");
    if (idx < 0) return null;
    return { username: raw.slice(0, idx), password: raw.slice(idx + 1) };
  } catch {
    return null;
  }
}

export function getRememberedAuthCredentials(
  mode?: "server" | "demo",
  backendBaseUrl = ""
): RememberedAuthCredentials | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(REMEMBERED_AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RememberedAuthCredentials>;
    if (!parsed.token || !parsed.username || (parsed.mode !== "server" && parsed.mode !== "demo")) {
      return null;
    }
    const cleanBase = typeof parsed.backendBaseUrl === "string" ? parsed.backendBaseUrl.replace(/\/+$/, "") : "";
    if (mode && parsed.mode !== mode) return null;
    if (mode === "server" && cleanBase !== backendBaseUrl.replace(/\/+$/, "")) return null;
    return {
      mode: parsed.mode,
      backendBaseUrl: cleanBase,
      username: parsed.username,
      token: parsed.token,
    };
  } catch {
    return null;
  }
}

export function hasRememberedAuthCredentials(mode?: "server" | "demo", backendBaseUrl = ""): boolean {
  return getRememberedAuthCredentials(mode, backendBaseUrl) !== null;
}

export function saveRememberedAuthCredentials(entry: {
  mode: "server" | "demo";
  backendBaseUrl?: string;
  username: string;
  token: string;
}): void {
  if (typeof window === "undefined") return;
  try {
    const payload: RememberedAuthCredentials = {
      mode: entry.mode,
      backendBaseUrl: (entry.backendBaseUrl ?? "").replace(/\/+$/, ""),
      username: entry.username.trim(),
      token: entry.token.trim(),
    };
    window.localStorage.setItem(REMEMBERED_AUTH_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage write errors
  }
}

export function clearRememberedAuthCredentials(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(REMEMBERED_AUTH_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function clearActiveAuthSession(): void {
  activeBasicToken = "";
  demoSessionUnlocked = false;
}

export function appendAuthParamToWsUrl(wsUrl: string): string {
  if (!activeBasicToken) return wsUrl;
  const sep = wsUrl.includes("?") ? "&" : "?";
  return `${wsUrl}${sep}slaprf_auth=${encodeURIComponent(activeBasicToken)}`;
}

function isApiTargetUrl(rawUrl: string): boolean {
  if (!rawUrl) return false;
  if (rawUrl.startsWith("/v1/") || rawUrl === "/v1") return true;
  try {
    const u = new URL(rawUrl, typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:8090");
    return u.pathname.startsWith("/v1/") || u.pathname === "/v1";
  } catch {
    return false;
  }
}

export function installAuthFetchInterceptor(): void {
  if (fetchInterceptorInstalled || typeof window === "undefined" || typeof window.fetch !== "function") {
    return;
  }
  fetchInterceptorInstalled = true;
  const origFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!activeBasicToken) {
      return origFetch(input, init);
    }
    const urlStr =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (!isApiTargetUrl(urlStr)) {
      return origFetch(input, init);
    }
    const nextInit: RequestInit = { ...(init ?? {}) };
    const headers = new Headers(nextInit.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Basic ${activeBasicToken}`);
    }
    nextInit.headers = headers;
    return origFetch(input, nextInit);
  };
}

// --- Demo Mode Basic Auth (localStorage) ---

function readStoredDemoAuth(): StoredDemoAuthConfig {
  if (typeof window === "undefined") {
    return { enabled: false, username: "", password: "" };
  }
  try {
    const raw = window.localStorage.getItem(DEMO_AUTH_STORAGE_KEY);
    if (!raw) return { enabled: false, username: "", password: "" };
    const parsed = JSON.parse(raw) as Partial<StoredDemoAuthConfig>;
    return {
      enabled: Boolean(parsed.enabled && parsed.username && parsed.password),
      username: typeof parsed.username === "string" ? parsed.username.trim() : "",
      password: typeof parsed.password === "string" ? parsed.password : "",
    };
  } catch {
    return { enabled: false, username: "", password: "" };
  }
}

export function getDemoAuthConfig(): AuthConfigStatus {
  const cfg = readStoredDemoAuth();
  return {
    enabled: cfg.enabled,
    username: cfg.username,
    password: cfg.password,
    hasPassword: cfg.password.length > 0,
  };
}

export function saveDemoAuthConfig(req: {
  enabled: boolean;
  username: string;
  password?: string;
}): { ok: boolean; status: AuthConfigStatus; error?: string } {
  const existing = readStoredDemoAuth();
  const cleanUser = req.username.trim();
  const nextPass = req.password && req.password.length > 0 ? req.password : existing.password;

  if (req.enabled && (!cleanUser || !nextPass)) {
    return {
      ok: false,
      status: getDemoAuthConfig(),
      error: "Username and password are required to enable authentication.",
    };
  }

  const next: StoredDemoAuthConfig = {
    enabled: req.enabled,
    username: cleanUser || existing.username,
    password: nextPass,
  };

  try {
    if (!next.enabled && !next.username && !next.password) {
      window.localStorage.removeItem(DEMO_AUTH_STORAGE_KEY);
    } else {
      window.localStorage.setItem(DEMO_AUTH_STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    // Ignore storage write errors
  }

  return {
    ok: true,
    status: {
      enabled: next.enabled,
      username: next.username,
      password: next.password,
      hasPassword: next.password.length > 0,
    },
  };
}

export function isDemoAuthRequired(): boolean {
  const cfg = readStoredDemoAuth();
  return cfg.enabled && !demoSessionUnlocked;
}

export function verifyDemoAuthLogin(username: string, password: string): boolean {
  const cfg = readStoredDemoAuth();
  if (!cfg.enabled) {
    demoSessionUnlocked = true;
    return true;
  }
  if (username.trim() === cfg.username && password === cfg.password) {
    demoSessionUnlocked = true;
    return true;
  }
  return false;
}

// --- Native Go Server Mode Basic Auth (/v1/auth/*) ---

export async function fetchServerAuthConfig(baseUrl = ""): Promise<AuthConfigStatus> {
  const target = baseUrl ? `${baseUrl.replace(/\/+$/, "")}/v1/auth/config` : "/v1/auth/config";
  const resp = await fetch(target, {
    method: "GET",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) {
    throw new Error(`Failed to load authentication settings (${resp.status})`);
  }
  const data = (await resp.json()) as Partial<AuthConfigStatus>;
  return {
    enabled: Boolean(data.enabled),
    username: typeof data.username === "string" ? data.username : "",
    password: typeof data.password === "string" ? data.password : "",
    hasPassword: Boolean(data.hasPassword),
  };
}

export async function saveServerAuthConfig(
  req: { enabled: boolean; username: string; password?: string },
  baseUrl = ""
): Promise<{ ok: boolean; status: AuthConfigStatus; error?: string }> {
  const target = baseUrl ? `${baseUrl.replace(/\/+$/, "")}/v1/auth/config` : "/v1/auth/config";
  const resp = await fetch(target, {
    method: "PUT",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      enabled: req.enabled,
      username: req.username,
      password: req.password ?? "",
    }),
  });
  const data = (await resp.json().catch(() => ({}))) as Partial<
    AuthConfigStatus & { ok?: boolean; error?: string }
  >;
  if (!resp.ok || data.ok === false) {
    return {
      ok: false,
      status: {
        enabled: Boolean(data.enabled),
        username: typeof data.username === "string" ? data.username : req.username,
        password: typeof data.password === "string" ? data.password : (req.password ?? ""),
        hasPassword: Boolean(data.hasPassword),
      },
      error: data.error || `Failed to save authentication settings (${resp.status})`,
    };
  }
  return {
    ok: true,
    status: {
      enabled: Boolean(data.enabled),
      username: typeof data.username === "string" ? data.username : req.username.trim(),
      password: typeof data.password === "string" ? data.password : (req.password ?? ""),
      hasPassword: Boolean(data.hasPassword),
    },
  };
}

export async function loginServerAuth(
  username: string,
  password: string,
  baseUrl = ""
): Promise<{ ok: boolean; error?: string }> {
  const cleanUser = username.trim();
  const token = encodeBasicToken(cleanUser, password);
  const target = baseUrl ? `${baseUrl.replace(/\/+$/, "")}/v1/auth/sessions` : "/v1/auth/sessions";
  try {
    const resp = await fetch(target, {
      method: "POST",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Basic ${token}`,
      },
      body: JSON.stringify({ username: cleanUser, password }),
    });
    const data = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!resp.ok || data.ok === false) {
      return {
        ok: false,
        error: data.error || "Invalid username or password.",
      };
    }
    setActiveBasicToken(token);
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: "Unable to reach SlapRF Server to verify credentials.",
    };
  }
}

export async function loginServerAuthWithToken(
  token: string,
  baseUrl = ""
): Promise<{ ok: boolean; error?: string }> {
  const cleanToken = token.trim();
  if (!cleanToken) return { ok: false, error: "Invalid credentials." };
  const target = baseUrl ? `${baseUrl.replace(/\/+$/, "")}/v1/auth/sessions` : "/v1/auth/sessions";
  try {
    const resp = await fetch(target, {
      method: "POST",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Basic ${cleanToken}`,
      },
      body: "{}",
    });
    const data = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!resp.ok || data.ok === false) {
      return {
        ok: false,
        error: data.error || "Invalid username or password.",
      };
    }
    setActiveBasicToken(cleanToken);
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: "Unable to reach SlapRF Server to verify credentials.",
    };
  }
}
