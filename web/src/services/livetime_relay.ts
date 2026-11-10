/**
 * MultiGP LiveTime link via the `slaprf-relay` helper (cmd/slaprf-relay).
 *
 * Browsers cannot accept TCP connections, so LiveTime connects to the relay on TCP :5403 and the
 * relay forwards the raw bytes over a loopback WebSocket (ws://127.0.0.1:5404). The ImmersionRC
 * LapRF protocol itself runs in the WASM engine (internal/laprf): this service only shuttles
 * bytes between the WebSocket and `slaprfWasm.liveTimeOpen/Data/Close`.
 *
 * Relay wire format: BINARY messages = raw LapRF bytes (both directions); TEXT messages = JSON
 * control events from the relay: {"t":"hello","version"}, {"t":"livetime","state":"connected","peer"},
 * {"t":"livetime","state":"disconnected"}.
 *
 * The on/off switch is a UI preference (localStorage), deliberately not engine state.
 */

const ENABLED_STORAGE_KEY = "slaprf.ui.livetime_enabled.v1";
export const LIVETIME_RELAY_URL = "ws://127.0.0.1:5404/";
export const LIVETIME_PORT = 5403;

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 5000;
/** Close code the relay sends to a tab that was replaced by a newer SlapRF tab. */
const CLOSE_REPLACED = 4001;

export type RelayState = "off" | "connecting" | "connected" | "unreachable";
export type LiveTimeLinkState = "waiting" | "connected";

export interface LiveTimeRelaySnapshot {
  enabled: boolean;
  relayState: RelayState;
  liveTimeState: LiveTimeLinkState;
  /** LiveTime's ip:port as seen by the relay (when connected). */
  peer: string;
  relayVersion: string;
  /** Bytes received from LiveTime / sent to LiveTime since the page loaded. */
  bytesIn: number;
  bytesOut: number;
  lastError: string;
}

/** LiveTime part of the `window.slaprfWasm` bridge (cmd/slaprf-wasm/livetime.go). */
interface LiveTimeWasmApi {
  liveTimeOpen(): void;
  liveTimeData(chunk: Uint8Array): boolean;
  liveTimeClose(): void;
  onLiveTimeOut(cb: ((chunk: Uint8Array) => void) | null): void;
}

function wasmApi(): LiveTimeWasmApi | null {
  const w = (window as unknown as { slaprfWasm?: Partial<LiveTimeWasmApi> }).slaprfWasm;
  return w && typeof w.liveTimeOpen === "function" ? (w as LiveTimeWasmApi) : null;
}

type Listener = (s: LiveTimeRelaySnapshot) => void;

export class LiveTimeRelay {
  private enabled = false;
  private started = false;
  private ws: WebSocket | null = null;
  private retryTimer: number | null = null;
  private backoffMs = BACKOFF_MIN_MS;
  private sessionOpen = false;
  private readonly listeners = new Set<Listener>();

  private relayState: RelayState = "off";
  private liveTimeState: LiveTimeLinkState = "waiting";
  private peer = "";
  private relayVersion = "";
  private bytesIn = 0;
  private bytesOut = 0;
  private lastError = "";

  constructor() {
    try {
      this.enabled = window.localStorage.getItem(ENABLED_STORAGE_KEY) === "true";
    } catch {
      // Ignore storage access errors
    }
  }

  public get snapshot(): LiveTimeRelaySnapshot {
    return {
      enabled: this.enabled,
      relayState: this.relayState,
      liveTimeState: this.liveTimeState,
      peer: this.peer,
      relayVersion: this.relayVersion,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      lastError: this.lastError,
    };
  }

  /**
   * Notified on state changes (relay/LiveTime connect/disconnect, toggle, errors). Byte counters
   * change constantly (10 Hz status frames) and do not trigger notifications; read `snapshot`.
   */
  public subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Call once the WASM engine is ready; connects if LiveTime was left enabled. */
  public start(): void {
    this.started = true;
    if (this.enabled) this.connect();
  }

  public setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    try {
      window.localStorage.setItem(ENABLED_STORAGE_KEY, String(enabled));
    } catch {
      // Ignore storage access errors
    }
    if (enabled) {
      this.lastError = "";
      this.backoffMs = BACKOFF_MIN_MS;
      if (this.started) this.connect();
    } else {
      this.disconnect();
      this.relayState = "off";
      this.lastError = "";
    }
    this.emit();
  }

  /** Retry immediately (e.g. after another tab took over the relay). */
  public reconnect(): void {
    if (!this.enabled) return;
    this.disconnect();
    this.lastError = "";
    this.backoffMs = BACKOFF_MIN_MS;
    this.connect();
  }

  private emit(): void {
    const snap = this.snapshot;
    this.listeners.forEach((fn) => {
      try {
        fn(snap);
      } catch (err) {
        console.error("[LiveTimeRelay] listener error:", err);
      }
    });
  }

  private connect(): void {
    if (!this.enabled || this.ws) return;
    this.clearRetry();
    if (this.relayState !== "unreachable") this.relayState = "connecting";
    this.emit();

    let ws: WebSocket;
    try {
      ws = new WebSocket(LIVETIME_RELAY_URL);
    } catch (err) {
      this.relayState = "unreachable";
      this.lastError = err instanceof Error ? err.message : String(err);
      this.emit();
      this.scheduleRetry();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    let opened = false;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      opened = true;
      this.backoffMs = BACKOFF_MIN_MS;
      this.relayState = "connected";
      this.lastError = "";
      this.emit();
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      if (typeof ev.data === "string") {
        this.handleControl(ev.data);
        return;
      }
      const chunk = new Uint8Array(ev.data as ArrayBuffer);
      this.bytesIn += chunk.byteLength;
      if (this.sessionOpen) wasmApi()?.liveTimeData(chunk);
    };

    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.closeSession();
      if (!this.enabled) return;
      if (ev.code === CLOSE_REPLACED) {
        // Another SlapRF tab attached to the relay. Do not fight over it.
        this.relayState = "unreachable";
        this.lastError = "Another SlapRF tab is now connected to the relay.";
        this.emit();
        return;
      }
      this.relayState = opened ? "connecting" : "unreachable";
      this.lastError = opened
        ? `Relay connection closed${ev.reason ? `: ${ev.reason}` : ""}.`
        : `slaprf-relay is not reachable at ${LIVETIME_RELAY_URL}`;
      this.emit();
      this.scheduleRetry();
    };

    ws.onerror = () => {
      // onclose follows with the details; nothing to do here.
    };
  }

  private disconnect(): void {
    this.clearRetry();
    const ws = this.ws;
    this.ws = null;
    this.closeSession();
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(1000, "LiveTime disabled");
      } catch {
        // ignore
      }
    }
  }

  private handleControl(raw: string): void {
    let msg: { t?: string; version?: string; state?: string; peer?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === "hello") {
      this.relayVersion = msg.version ?? "";
      this.emit();
    } else if (msg.t === "livetime") {
      if (msg.state === "connected") {
        this.openSession(msg.peer ?? "");
      } else {
        this.closeSession();
      }
      this.emit();
    }
  }

  /** LiveTime connected to the relay: start a fresh LapRF session in the WASM engine. */
  private openSession(peer: string): void {
    const wasm = wasmApi();
    if (!wasm) {
      this.lastError = "Timing engine not ready yet.";
      return;
    }
    if (this.sessionOpen) wasm.liveTimeClose(); // a new LiveTime client replaced the old one
    wasm.onLiveTimeOut((chunk) => {
      const ws = this.ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
        this.bytesOut += chunk.byteLength;
      }
    });
    wasm.liveTimeOpen();
    this.sessionOpen = true;
    this.liveTimeState = "connected";
    this.peer = peer;
  }

  private closeSession(): void {
    if (this.sessionOpen) {
      wasmApi()?.liveTimeClose();
      this.sessionOpen = false;
    }
    this.liveTimeState = "waiting";
    this.peer = "";
  }

  private scheduleRetry(): void {
    this.clearRetry();
    if (!this.enabled) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

/** App-wide LiveTime relay link (one per tab). */
export const sharedLiveTimeRelay = new LiveTimeRelay();
