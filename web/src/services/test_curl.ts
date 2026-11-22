import { ApiClient } from "./api_client";
import { capabilitiesSnapshot, resolveBackendUrl } from "./capabilities";

export interface SlaprfCurlRequest {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  target?: "auto" | "wasm" | "host";
  syncUi?: boolean;
}

export interface SlaprfCurlResponse {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
  json: unknown | null;
  durationMs: number;
  target: "wasm" | "host";
}

export interface SlaprfCurlLogEntry {
  timestampIso: string;
  method: string;
  url: string;
  target: "wasm" | "host";
  status: number;
  durationMs: number;
}

declare global {
  interface Window {
    slaprfCurl?: (
      reqOrSpec: SlaprfCurlRequest | string,
      bodyOrOpts?: unknown
    ) => Promise<SlaprfCurlResponse>;
    slaprfCurlHistory?: SlaprfCurlLogEntry[];
  }
}

const MAX_CURL_HISTORY = 200;

function isPortableHostRoute(url: string): boolean {
  const pathOnly = url.split("?")[0] || "";
  return (
    pathOnly === "/v1/capabilities" ||
    pathOnly === "/v1/auth/sessions" ||
    pathOnly === "/v1/auth/config" ||
    pathOnly === "/v1/storage/status" ||
    pathOnly === "/v1/storage:recordBackup" ||
    pathOnly === "/v1/laprf-emulator" ||
    pathOnly.startsWith("/v1/laprf/") ||
    pathOnly === "/v1/laprf:sync" ||
    (pathOnly.startsWith("/v1/rh/") && !pathOnly.endsWith("/debug-stream")) ||
    pathOnly === "/v1/rh:sync" ||
    pathOnly.startsWith("/v1/usb/") ||
    pathOnly === "/v1/usb:command" ||
    pathOnly.startsWith("/v1/bluetooth/") ||
    pathOnly === "/v1/bluetooth:command" ||
    pathOnly.startsWith("/v1/race/multigp/proxy/")
  );
}

function normalizeCurlInput(
  reqOrSpec: SlaprfCurlRequest | string,
  bodyOrOpts?: unknown
): SlaprfCurlRequest {
  if (typeof reqOrSpec === "string") {
    const trimmed = reqOrSpec.trim();
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx > 0) {
      const maybeMethod = trimmed.slice(0, spaceIdx).toUpperCase();
      const restUrl = trimmed.slice(spaceIdx + 1).trim();
      if (
        restUrl.startsWith("/") ||
        restUrl.startsWith("http://") ||
        restUrl.startsWith("https://")
      ) {
        return {
          method: maybeMethod,
          url: restUrl,
          body: bodyOrOpts,
        };
      }
    }
    return {
      method: bodyOrOpts !== undefined ? "POST" : "GET",
      url: trimmed,
      body: bodyOrOpts,
    };
  }
  return reqOrSpec;
}

function encodeRequestBody(
  body: unknown,
  headers: Record<string, string>
): { rawBody: string; hasBody: boolean } {
  if (body === undefined || body === null) {
    return { rawBody: "", hasBody: false };
  }
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const hasContentType = Object.keys(headers).some(
        (k) => k.toLowerCase() === "content-type"
      );
      if (!hasContentType) {
        headers["Content-Type"] = "application/json";
      }
    }
    return { rawBody: body, hasBody: body.length > 0 };
  }
  const hasContentType = Object.keys(headers).some(
    (k) => k.toLowerCase() === "content-type"
  );
  if (!hasContentType) {
    headers["Content-Type"] = "application/json";
  }
  return { rawBody: JSON.stringify(body), hasBody: true };
}

function tryParseJson(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const first = trimmed[0];
  if (first !== "{" && first !== "[" && first !== '"' && first !== "-" && (first < "0" || first > "9") && trimmed !== "true" && trimmed !== "false" && trimmed !== "null") {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Installs `window.slaprfCurl` so Playwright / CDP tests (and interactive DevTools debugging) can
 * issue direct HTTP/curl calls against the live in-browser Go WASM engine (`window.slaprfWasm`)
 * as well as Portable host routes (`/v1/capabilities`, `/v1/race/multigp/proxy/*`, `/v1/laprf/devices`).
 */
export function installSlaprfCurlBridge(api: ApiClient): void {
  if (!window.slaprfCurlHistory) {
    window.slaprfCurlHistory = [];
  }

  window.slaprfCurl = async (
    reqOrSpec: SlaprfCurlRequest | string,
    bodyOrOpts?: unknown
  ): Promise<SlaprfCurlResponse> => {
    const req = normalizeCurlInput(reqOrSpec, bodyOrOpts);
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    const { rawBody, hasBody } = encodeRequestBody(req.body, headers);
    const method = (req.method || (hasBody ? "POST" : "GET")).toUpperCase().trim();
    const url = req.url.trim() || "/v1/state";

    const caps = capabilitiesSnapshot();
    let target: "wasm" | "host";
    if (caps.portable) {
      target = req.target === "wasm" && Boolean(window.slaprfWasm) ? "wasm" : "host";
    } else if (req.target === "wasm" || req.target === "host") {
      target = req.target;
    } else {
      target = isPortableHostRoute(url) ? "host" : "wasm";
    }

    const t0 = performance.now();
    let status = 500;
    let respHeaders: Record<string, string> = {};
    let respBody = "";

    if (target === "host") {
      const fetchInit: RequestInit = {
        method,
        headers,
      };
      if (hasBody && method !== "GET" && method !== "HEAD") {
        fetchInit.body = rawBody;
      }
      const targetUrl = caps.portable ? resolveBackendUrl(url) : url;
      const res = await window.fetch(targetUrl, fetchInit);
      status = res.status;
      res.headers.forEach((val, key) => {
        respHeaders[key.toLowerCase()] = val;
      });
      respBody = await res.text();
    } else {
      for (let i = 0; i < 400 && !window.slaprfWasm; i++) {
        await new Promise((r) => window.setTimeout(r, 25));
      }
      if (!window.slaprfWasm) {
        throw new Error("window.slaprfWasm is not initialized");
      }
      const wasmRes = window.slaprfWasm.request(method, url, rawBody, headers);
      status = wasmRes.status;
      respHeaders = { ...(wasmRes.headers ?? {}) };
      respBody = wasmRes.body ?? "";
    }

    const durationMs = Math.round((performance.now() - t0) * 100) / 100;
    const parsedJson = tryParseJson(respBody);

    if ((target === "wasm" || caps.portable) && req.syncUi !== false) {
      await api.syncAfterDirectWasmCall(method, url, status, parsedJson);
    }

    const history = window.slaprfCurlHistory!;
    history.push({
      timestampIso: new Date().toISOString(),
      method,
      url,
      target,
      status,
      durationMs,
    });
    if (history.length > MAX_CURL_HISTORY) {
      history.splice(0, history.length - MAX_CURL_HISTORY);
    }

    return {
      ok: status >= 200 && status < 300,
      status,
      headers: respHeaders,
      body: respBody,
      json: parsedJson,
      durationMs,
      target,
    };
  };
}
