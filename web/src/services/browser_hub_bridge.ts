import { sharedTimerConsole } from "./timer_console";
import { WasmSimTransport } from "./wasm_transport";

export type RealEngineMode = "auto" | "browser" | "desktop";
export type HubWifiState = "idle" | "connecting" | "connected" | "error";

const HUB_HOST_STORAGE_KEY = "slaprf.ui.hub_host.v1";
const REAL_ENGINE_MODE_STORAGE_KEY = "slaprf.ui.real_engine_mode.v1";
const DEFAULT_HUB_HOST = "192.168.4.1";

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0").toUpperCase();
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.trim();
  if (clean.length < 8 || clean.length % 2 !== 0) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) return null;
    out[i] = b;
  }
  return out;
}

function normalizeHost(raw: string): string {
  let h = (raw || "").trim();
  h = h.replace(/^https?:\/\//i, "").replace(/^ws+:\/\//i, "");
  const slash = h.indexOf("/");
  if (slash >= 0) h = h.slice(0, slash);
  return h || DEFAULT_HUB_HOST;
}

/**
 * Connects the in-browser WebAssembly timing engine (`slaprf.wasm`) directly to physical
 * XIAO ESP32-C5 Hub & Spoke hardware without needing the desktop Go server (`slaprf.exe`):
 * 1. Over Wi-Fi via the Hub's HTTP/SSE endpoint (`http://<hubHost>/api/hub-stream`).
 * 2. Over USB-C via `sharedTimerConsole` (`WebSerial` `@{"t":"pkt","hex":"..."}`).
 */
export class BrowserHubBridge {
  private readonly wasm: WasmSimTransport;
  private readonly listeners = new Set<() => void>();
  private eventSource: EventSource | null = null;
  private reconnectTimer: number | null = null;
  private active = false;

  public hubHost = DEFAULT_HUB_HOST;
  public wifiState: HubWifiState = "idle";
  public wifiError: string | null = null;
  public wifiFramesRx = 0;
  public usbFramesRx = 0;
  public discovering = false;
  public onPacketIngested?: () => void;

  constructor(wasm: WasmSimTransport) {
    this.wasm = wasm;
    try {
      const savedHost = window.localStorage.getItem(HUB_HOST_STORAGE_KEY);
      if (savedHost && savedHost.trim()) {
        this.hubHost = normalizeHost(savedHost);
      }
    } catch {
      // ignore storage errors
    }

    // Forward outbound 19-byte channel table frames (0xC5 0x5E) from WASM to the Hub over Wi-Fi and/or USB-C
    this.wasm.onHubCommand((pkt) => {
      if (!this.active) return;
      if (sharedTimerConsole.connected && sharedTimerConsole.lastStatus?.role === 1) {
        sharedTimerConsole.sendNetChannelsFromPacket(pkt);
      }
      if (this.wifiState === "connected" && this.hubHost) {
        const hex = bytesToHex(pkt);
        void fetch(`http://${this.hubHost}/api/hub-channels?hex=${hex}`, {
          method: "GET",
          mode: "cors",
        }).catch(() => undefined);
      }
    });

    // Forward inbound Hub/Spoke binary frames received over USB-C WebSerial into WASM
    sharedTimerConsole.subscribe({
      onHubPacket: (pkt) => {
        if (!this.active) return;
        this.usbFramesRx++;
        const n = this.wasm.ingestHubPacket(pkt);
        if (n > 0 || (pkt.length === 36 && pkt[0] === 0xc5 && pkt[1] === 0x5a)) {
          this.onPacketIngested?.();
        }
        if (this.usbFramesRx === 1 || this.usbFramesRx % 25 === 0) {
          this.notify();
        }
      },
      onConnect: () => {
        if (this.active) {
          window.setTimeout(() => this.wasm.pushHubChannels(), 350);
          this.notify();
        }
      },
      onDisconnect: () => {
        if (this.active) {
          this.notify();
        }
      },
    });
  }

  public subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    this.listeners.forEach((fn) => {
      try {
        fn();
      } catch {
        // ignore listener errors
      }
    });
  }

  public static loadModePref(): RealEngineMode {
    try {
      const v = window.localStorage.getItem(REAL_ENGINE_MODE_STORAGE_KEY);
      if (v === "browser" || v === "desktop" || v === "auto") {
        return v;
      }
    } catch {
      // ignore
    }
    return "auto";
  }

  public static saveModePref(mode: RealEngineMode): void {
    try {
      window.localStorage.setItem(REAL_ENGINE_MODE_STORAGE_KEY, mode);
    } catch {
      // ignore
    }
  }

  public setHubHost(host: string, reconnectNow = true): void {
    const next = normalizeHost(host);
    this.hubHost = next;
    try {
      window.localStorage.setItem(HUB_HOST_STORAGE_KEY, next);
    } catch {
      // ignore
    }
    this.notify();
    if (this.active && reconnectNow) {
      this.connectWifiStream();
    }
  }

  public setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (active) {
      this.connectWifiStream();
      if (sharedTimerConsole.connected) {
        void sharedTimerConsole.send("STATUS?").catch(() => undefined);
      }
    } else {
      this.disconnectWifiStream();
    }
    this.notify();
  }

  public resetDefaults(): void {
    this.setHubHost(DEFAULT_HUB_HOST, this.active);
    BrowserHubBridge.saveModePref("auto");
    this.notify();
  }

  public async discoverHub(): Promise<string | null> {
    if (this.discovering) return null;
    this.discovering = true;
    this.wifiError = null;
    this.notify();

    const candidates = Array.from(
      new Set([this.hubHost, DEFAULT_HUB_HOST, "slaprf-hub.local"].filter(Boolean))
    );

    try {
      for (const host of candidates) {
        const ok = await this.probeHost(host, 1400);
        if (ok) {
          this.setHubHost(host, true);
          return host;
        }
      }
      this.wifiError = `No Hub found at ${candidates.join(" or ")}. Join the "SlapRF" Wi-Fi AP (192.168.4.1), enter the Hub's LAN IP, or connect via USB-C.`;
      this.wifiState = "error";
      return null;
    } finally {
      this.discovering = false;
      this.notify();
    }
  }

  private async probeHost(host: string, timeoutMs: number): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`http://${host}/api/hub-info`, {
        method: "GET",
        mode: "cors",
        signal: ctrl.signal,
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { slaprfHub?: boolean };
      return Boolean(data && data.slaprfHub);
    } catch {
      return false;
    } finally {
      window.clearTimeout(timer);
    }
  }

  public connectWifiStream(): void {
    this.clearReconnect();
    this.closeEventSource();
    if (!this.active || !this.hubHost) {
      this.wifiState = "idle";
      this.notify();
      return;
    }

    this.wifiState = "connecting";
    this.wifiError = null;
    this.notify();

    try {
      const url = `http://${this.hubHost}/api/hub-stream`;
      const es = new EventSource(url);
      this.eventSource = es;

      es.onopen = () => {
        if (this.eventSource !== es) return;
        this.wifiState = "connected";
        this.wifiError = null;
        this.wasm.pushHubChannels();
        this.notify();
      };

      es.onmessage = (ev) => {
        if (this.eventSource !== es || typeof ev.data !== "string") return;
        const pkt = hexToBytes(ev.data);
        if (!pkt) return;
        this.wifiFramesRx++;
        const n = this.wasm.ingestHubPacket(pkt);
        if (n > 0 || (pkt.length === 36 && pkt[0] === 0xc5 && pkt[1] === 0x5a)) {
          this.onPacketIngested?.();
        }
        if (this.wifiFramesRx === 1 || this.wifiFramesRx % 25 === 0) {
          this.notify();
        }
      };

      es.onerror = () => {
        if (this.eventSource !== es) return;
        this.closeEventSource();
        const isHttps = typeof window !== "undefined" && window.location.protocol === "https:";
        this.wifiState = "error";
        this.wifiError = isHttps
          ? `Waiting for Hub at http://${this.hubHost} (if blocked by HTTPS mixed-content, allow Insecure Content in site settings or connect the Hub over USB-C).`
          : `Waiting for Hub at http://${this.hubHost}…`;
        this.notify();
        if (this.active) {
          this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = null;
            if (this.active) this.connectWifiStream();
          }, 3500);
        }
      };
    } catch (err) {
      this.wifiState = "error";
      this.wifiError = err instanceof Error ? err.message : String(err);
      this.notify();
    }
  }

  public disconnectWifiStream(): void {
    this.clearReconnect();
    this.closeEventSource();
    this.wifiState = "idle";
    this.notify();
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeEventSource(): void {
    if (this.eventSource) {
      try {
        this.eventSource.close();
      } catch {
        // ignore
      }
      this.eventSource = null;
    }
  }
}
