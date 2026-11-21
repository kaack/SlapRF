import { FullStateResponse, StreamEnvelope } from "../types/models";
import {
  clearBackendConnectionLost,
  probeServerReachable,
  resolveBackendUrl,
  resolveBackendWsUrl,
} from "./capabilities";
import { ApiTransport, HttpMethod } from "./transport";
import { decodeTelemetryBatch, unwrapApiErrorMessage } from "./wasm_transport";

const STREAM_RECONNECT_MIN_MS = 500;
const STREAM_RECONNECT_MAX_MS = 3000;

/**
 * Native Go Backend HTTP + WebSocket transport (`BackendHttpTransport`).
 *
 * Used whenever SlapRF is running as a Portable native app (`127.0.0.1:8090`) OR connected remotely
 * from `https://slaprf.app` / LAN browser to a laptop or headless Raspberry Pi running `slaprf`.
 * Zero `slaprf.wasm` is loaded and zero browser `IndexedDB` is touched.
 */
export class BackendHttpTransport implements ApiTransport {
  private readonly baseUrl: string;
  private ws: WebSocket | null = null;
  private streamCallback: ((msg: StreamEnvelope) => void) | null = null;
  private reconnectTimer: number | null = null;
  private backoffMs = STREAM_RECONNECT_MIN_MS;
  private hadPriorConnection = false;
  private paused = false;
  private checkingReachability = false;
  public onStreamReconnected?: () => void;
  public onConnectionLost?: () => void;

  constructor(baseUrl = "") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  public setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      this.disconnectStream();
    }
  }

  public isPaused(): boolean {
    return this.paused;
  }

  public isStreamConnected(): boolean {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  private verifyServerReachable(): void {
    if (this.paused || this.checkingReachability) return;
    this.checkingReachability = true;
    void probeServerReachable(this.baseUrl, 1200)
      .then((caps) => {
        if (this.paused) return;
        if (!caps) {
          this.onConnectionLost?.();
        } else {
          clearBackendConnectionLost();
        }
      })
      .finally(() => {
        this.checkingReachability = false;
      });
  }

  public urlFor(path: string): string {
    return resolveBackendUrl(path, this.baseUrl);
  }

  public wsUrlFor(path: string): string {
    return resolveBackendWsUrl(path, this.baseUrl);
  }

  public async request<T = unknown>(method: HttpMethod, url: string, body?: unknown): Promise<T> {
    if (this.paused) {
      throw new Error("Backend transport is paused (disconnected).");
    }
    const target = this.urlFor(url);
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    const init: RequestInit = {
      method,
      headers,
      cache: "no-store",
    };
    if (body !== undefined && method !== "GET") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let resp: Response;
    try {
      resp = await fetch(target, init);
    } catch (err) {
      this.verifyServerReachable();
      throw err;
    }
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`HTTP ${method} ${url} failed (${resp.status}): ${unwrapApiErrorMessage(text)}`);
    }
    clearBackendConnectionLost();
    return (text ? JSON.parse(text) : {}) as T;
  }

  public async requestText(method: HttpMethod, url: string, body?: unknown): Promise<string> {
    if (this.paused) {
      throw new Error("Backend transport is paused (disconnected).");
    }
    const target = this.urlFor(url);
    const headers: Record<string, string> = {};
    const init: RequestInit = {
      method,
      headers,
      cache: "no-store",
    };
    if (body !== undefined && method !== "GET") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let resp: Response;
    try {
      resp = await fetch(target, init);
    } catch (err) {
      this.verifyServerReachable();
      throw err;
    }
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`HTTP ${method} ${url} failed (${resp.status}): ${unwrapApiErrorMessage(text)}`);
    }
    clearBackendConnectionLost();
    return text;
  }

  public async setSimRunning(running: boolean): Promise<void> {
    await this.request<FullStateResponse>("PATCH", "/v1/sim", { running });
  }

  public pushHubChannels(): void {
    // Native Go `usb.Manager` subscribes directly to `realEngine.OnConfigUpdated` and pushes
    // `NETCHANNELS` over USB-C automatically without browser involvement.
  }

  public connectStream(onEnvelope: (msg: StreamEnvelope) => void): void {
    if (this.paused) return;
    this.streamCallback = onEnvelope;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.openStreamSocket();
  }

  public disconnectStream(): void {
    this.streamCallback = null;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(1000, "Client stream closed");
      } catch {
        // Ignore close errors
      }
    }
  }

  private openStreamSocket(): void {
    if (!this.streamCallback) return;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrlFor("/v1/ws/stream"));
    } catch {
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.backoffMs = STREAM_RECONNECT_MIN_MS;
      clearBackendConnectionLost();
      if (this.hadPriorConnection) {
        this.onStreamReconnected?.();
      }
      this.hadPriorConnection = true;
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws || !this.streamCallback) return;
      const cb = this.streamCallback;
      if (ev.data instanceof ArrayBuffer) {
        try {
          const frames = decodeTelemetryBatch(new Uint8Array(ev.data));
          for (let i = 0; i < frames.length; i++) {
            cb({ type: "telemetry", payload: frames[i] });
          }
        } catch (err) {
          console.error("[BackendHttpTransport] binary telemetry decode error:", err);
        }
        return;
      }
      if (typeof ev.data === "string") {
        try {
          const env = JSON.parse(ev.data) as StreamEnvelope;
          cb(env);
        } catch (err) {
          console.error("[BackendHttpTransport] stream parse error:", err);
        }
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.streamCallback && !this.paused) {
        this.verifyServerReachable();
        this.scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // Handled in onclose
    };
  }

  private scheduleReconnect(): void {
    if (!this.streamCallback || this.reconnectTimer !== null) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, STREAM_RECONNECT_MAX_MS);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.openStreamSocket();
    }, delay);
  }

  public async exportSimStateJson(): Promise<string> {
    return await this.requestText("GET", "/v1/storage/sim");
  }

  public async importSimStateJson(jsonStr: string): Promise<boolean> {
    const parsed = JSON.parse(jsonStr) as unknown;
    const res = await this.request<{ ok?: boolean }>("PUT", "/v1/storage/sim", parsed);
    return Boolean(res?.ok ?? true);
  }
}
