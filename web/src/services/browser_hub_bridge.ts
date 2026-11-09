import { FIRMWARE_PROFILES, LATEST_FIRMWARE_VERSION } from "./esp_flasher";
import { recordKnownTimerStatus, sharedTimerConsole, TimerPeerSpoke, TimerStatus } from "./timer_console";
import { WasmSimTransport } from "./wasm_transport";

export type RealEngineMode = "auto" | "browser" | "desktop";
export type HubWifiState = "idle" | "connecting" | "reconnecting" | "connected" | "failed";
export type ConnectivityMethod = "usb" | "wifi";
export type ConnectionLedColor = "neon" | "blue" | "yellow" | "red" | "gray";

export interface ConnectionLedSummary {
  color: ConnectionLedColor;
  shortLabel: string;
  detail: string;
}

const HUB_HOST_STORAGE_KEY = "slaprf.ui.hub_host.v1";
const REAL_ENGINE_MODE_STORAGE_KEY = "slaprf.ui.real_engine_mode.v1";
const CONN_METHOD_STORAGE_KEY = "slaprf.ui.conn_method.v1";
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

function cString(bytes: Uint8Array): string {
  let end = bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      end = i;
      break;
    }
  }
  return new TextDecoder().decode(bytes.subarray(0, end)).trim();
}

/**
 * Connects the in-browser WebAssembly timing engine (`slaprf.wasm`) and Network page directly
 * to physical XIAO ESP32-C5 Hub & Spoke hardware:
 * 1. Over USB-C via `sharedTimerConsole` (`WebSerial` `@{"t":"pkt","hex":"..."}`).
 * 2. Over Wi-Fi via the Hub's HTTP/SSE endpoint (`http://<hubHost>/api/hub-stream`).
 */
export class BrowserHubBridge {
  private readonly wasm: WasmSimTransport;
  private readonly listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private active = false;
  private wifiDesired = false;

  public connMethod: ConnectivityMethod = "usb";
  public hubHost = DEFAULT_HUB_HOST;
  public wifiState: HubWifiState = "idle";
  public wifiError: string | null = null;
  public wifiReconnectAttempt = 0;
  public readonly maxReconnectAttempts = 5;
  public wifiFramesRx = 0;
  public usbFramesRx = 0;
  public discovering = false;
  public wifiStatus: TimerStatus | null = null;
  public wifiLastDbm: number[] = [-95, -95, -95, -95, -95, -95, -95, -95];
  private readonly wifiSpokes = new Map<number, TimerPeerSpoke & { lastRxMs: number }>();
  private lastPushedHex = "";
  private lastKnownWifiSig = "";
  private lastStreamNotifyMs = 0;
  private lastWifiPacketMs = 0;
  private watchdogTimer: number | null = null;
  public onPacketIngested?: () => void;

  constructor(wasm: WasmSimTransport) {
    this.wasm = wasm;
    try {
      const savedHost = window.localStorage.getItem(HUB_HOST_STORAGE_KEY);
      if (savedHost && savedHost.trim()) {
        this.hubHost = normalizeHost(savedHost);
      }
      const savedMethod = window.localStorage.getItem(CONN_METHOD_STORAGE_KEY);
      if (savedMethod === "wifi" || savedMethod === "usb") {
        this.connMethod = savedMethod;
      }
    } catch {
      // ignore storage errors
    }

    // Forward outbound 19-byte channel table frames (0xC5 0x5E) from WASM to the Hub over Wi-Fi WebSocket and/or USB-C
    this.wasm.onHubCommand((pkt) => {
      if (sharedTimerConsole.connected && sharedTimerConsole.lastStatus?.role === 1) {
        sharedTimerConsole.sendNetChannelsFromPacket(pkt);
      }
      if (this.wifiState === "connected" && this.ws && this.ws.readyState === WebSocket.OPEN && this.active) {
        const hex = bytesToHex(pkt);
        if (hex === this.lastPushedHex) return;
        this.lastPushedHex = hex;
        try {
          this.ws.send(pkt);
        } catch {
          // ignore send errors
        }
      }
    });

    // Forward inbound Hub/Spoke binary frames received over USB-C WebSerial into WASM
    sharedTimerConsole.subscribe({
      onHubPacket: (pkt) => {
        this.usbFramesRx++;
        this.inspectBinaryPacket(pkt);
        if (this.active) {
          this.wasm.ingestHubPacket(pkt);
          if (pkt.length === 36 && pkt[0] === 0xc5 && pkt[1] === 0x5a) {
            this.onPacketIngested?.();
          }
        }
        const nowMs = Date.now();
        if (this.usbFramesRx === 1 || nowMs - this.lastStreamNotifyMs >= 500) {
          this.lastStreamNotifyMs = nowMs;
          this.notify();
        }
      },
      onConnect: () => {
        this.connMethod = "usb";
        this.saveMethodPref("usb");
        window.setTimeout(() => this.wasm.pushHubChannels(), 350);
        this.notify();
      },
      onDisconnect: () => {
        this.notify();
      },
    });
    sharedTimerConsole.onStateChange(() => this.notify());
  }

  public setConnMethod(method: ConnectivityMethod): void {
    if (this.connMethod === method) return;
    this.connMethod = method;
    this.saveMethodPref(method);
    this.notify();
  }

  private saveMethodPref(method: ConnectivityMethod): void {
    try {
      window.localStorage.setItem(CONN_METHOD_STORAGE_KEY, method);
    } catch {
      // ignore
    }
  }

  /**
   * Computes the 5-state LED indicator summary used by the TopBar icon and Network page:
   * - `neon`: Connected to a Hub (USB-C role 1 or Wi-Fi SSE)
   * - `blue`: Connected to a Spoke (USB-C role 2)
   * - `yellow`: Connecting or lost connection and trying to reconnect
   * - `red`: All reconnect attempts failed (or Emergency Mode)
   * - `gray`: Disconnected
   */
  public getLedSummary(): ConnectionLedSummary {
    const usb = sharedTimerConsole;

    // 1. Active or recovering USB connection
    if (usb.reconnecting || usb.busyLabel) {
      const label = usb.reconnecting
        ? `Reconnecting USB (${usb.reconnectAttempt}/${usb.maxReconnectAttempts})…`
        : `${usb.busyLabel}…`;
      return {
        color: "yellow",
        shortLabel: "Reconnecting",
        detail: `${label} — click to open Network`,
      };
    }
    if (usb.connected) {
      const s = usb.lastStatus;
      if (s?.emergencyMode) {
        return {
          color: "red",
          shortLabel: `${s.label || "Timer"} · Emergency`,
          detail: `${s.label || "Timer"} is in Emergency Mode — click to open Network`,
        };
      }
      if (s && s.role === 2) {
        return {
          color: "blue",
          shortLabel: `${s.label || "S1"} · Spoke`,
          detail: `Connected to Spoke ${s.label || "S1"} (Slot ${s.slot || "?"}) over USB-C — click to open Network`,
        };
      }
      const hubName = s?.label || "H1";
      return {
        color: "neon",
        shortLabel: `${hubName} · Hub`,
        detail: `Connected to Hub ${hubName} over USB-C — click to open Network`,
      };
    }

    // 2. Active or recovering Wi-Fi SSE connection
    if (this.wifiState === "connecting" || this.wifiState === "reconnecting") {
      const att =
        this.wifiReconnectAttempt > 0
          ? ` (attempt ${this.wifiReconnectAttempt}/${this.maxReconnectAttempts})`
          : "";
      return {
        color: "yellow",
        shortLabel: "Connecting Wi-Fi",
        detail: `Connecting to Hub at ${this.hubHost}${att} — click to open Network`,
      };
    }
    if (this.wifiState === "connected") {
      const hubName = this.wifiStatus?.label || "H1";
      return {
        color: "neon",
        shortLabel: `${hubName} · Wi-Fi`,
        detail: `Connected to Hub ${hubName} (${this.hubHost}) over Wi-Fi SSE — click to open Network`,
      };
    }

    // 3. Failed reconnect states (Red)
    if (usb.reconnectFailed && this.connMethod === "usb") {
      return {
        color: "red",
        shortLabel: "USB Failed",
        detail: `${usb.lastError || "USB reconnect failed"} — click to open Network`,
      };
    }
    if (this.wifiState === "failed" && this.connMethod === "wifi") {
      return {
        color: "red",
        shortLabel: "Wi-Fi Failed",
        detail: `${this.wifiError || `Failed to connect to Hub at ${this.hubHost}`} — click to open Network`,
      };
    }

    // 4. Disconnected (Gray)
    return {
      color: "gray",
      shortLabel: "Disconnected",
      detail: "No timer connected — click to open Network",
    };
  }

  /** Synthesizes live Hub + Spoke status from binary HELLO (0xC5 0x5A) and WINDOW (0xC5 0x59) frames. */
  private inspectBinaryPacket(pkt: Uint8Array): void {
    if (pkt.length < 7 || pkt[0] !== 0xc5) return;
    const nowMs = Date.now();

    if (pkt[1] === 0x5a && pkt.length >= 36) {
      const slot = pkt[2];
      const role = pkt[3];
      const fp =
        (pkt[4] | (pkt[5] << 8) | (pkt[6] << 16) | ((pkt[7] << 24) >>> 0))
          .toString(16)
          .padStart(8, "0")
          .toUpperCase();
      const profileCode = pkt[8] || 1;
      const sweepHz = pkt[9] || 50;
      const label = cString(pkt.subarray(10, 34)) || (role === 1 ? "H1" : `S${Math.max(1, slot - 1)}`);

      if (role === 1 || slot === 1) {
        if (!this.wifiStatus) {
          this.wifiStatus = {
            fw: LATEST_FIRMWARE_VERSION,
            role: 1,
            profile: profileCode,
            fp,
            label,
            uptimeMs: 0,
            reset: "power-on",
            boots: 1,
            heapFree: 180 * 1024,
            heapMin: 160 * 1024,
            sweepHz,
            sweeps: 0,
            sweepUs: 11200,
            sweepUsMax: 12400,
            sweepBudgetUs: Math.round(1_000_000 / sweepHz),
            rf: { ok: true, enabled: true, gain: 66, gainMax: 66, floorDb: -92 },
            chip: { model: "ESP32-C5", rev: "v1.0", mac: "", flashMB: 4 },
            net: { mode: "ap+sta", stations: 1 },
            channel: 1,
            slot: 1,
            spokes: [],
            freqsTemporary: false,
            freqs: [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917],
          };
        } else {
          this.wifiStatus.fp = fp;
          this.wifiStatus.label = label;
          this.wifiStatus.profile = profileCode;
          this.wifiStatus.sweepHz = sweepHz;
        }
        const sig = `${fp}:${label}:${profileCode}:${this.wifiSpokes.size}`;
        if (sig !== this.lastKnownWifiSig) {
          this.lastKnownWifiSig = sig;
          recordKnownTimerStatus(this.wifiStatus);
        }
      } else if (slot >= 2 && slot <= 7) {
        const prev = this.wifiSpokes.get(slot);
        const identityChanged = !prev || prev.fp !== fp || prev.label !== label;
        this.wifiSpokes.set(slot, {
          slot,
          fp,
          label,
          profile: profileCode,
          fw: LATEST_FIRMWARE_VERSION,
          online: true,
          msAgo: prev ? Math.max(0, nowMs - prev.lastRxMs) : 0,
          frames: prev?.frames ?? 0,
          seq: prev?.seq ?? 0,
          dbm: prev?.dbm,
          lastRxMs: prev?.lastRxMs ?? nowMs,
        });
        this.syncWifiSpokesList();
        if (identityChanged && this.wifiStatus) {
          recordKnownTimerStatus(this.wifiStatus);
        }
      }
      return;
    }

    if (pkt[1] === 0x59 && pkt.length >= 16) {
      const slot = pkt[2];
      const count = pkt[3];
      if (count <= 0 || pkt.length < 7 + count * 9 + 1) return;
      const noiseFloor = (pkt[6] << 24) >> 24;
      const lastOff = 7 + (count - 1) * 9;
      const seq = pkt[lastOff];
      const dbm: number[] = [];
      for (let ch = 0; ch < 8; ch++) {
        dbm.push((pkt[lastOff + 1 + ch] << 24) >> 24);
      }

      if (slot === 1) {
        this.wifiLastDbm = dbm;
        if (this.wifiStatus) {
          this.wifiStatus.rf.floorDb = noiseFloor;
          this.wifiStatus.sweeps += count;
        }
      } else if (slot >= 2 && slot <= 7) {
        const prev = this.wifiSpokes.get(slot);
        this.wifiSpokes.set(slot, {
          slot,
          fp: prev?.fp || `SLOT${slot}`,
          label: prev?.label || `S${slot - 1}`,
          profile: prev?.profile ?? this.wifiStatus?.profile ?? 1,
          fw: prev?.fw || LATEST_FIRMWARE_VERSION,
          online: true,
          msAgo: 0,
          frames: (prev?.frames ?? 0) + 1,
          seq,
          dbm,
          lastRxMs: nowMs,
        });
        this.syncWifiSpokesList();
      }
    }
  }

  private syncWifiSpokesList(): void {
    if (!this.wifiStatus) return;
    const nowMs = Date.now();
    this.wifiStatus.spokes = [...this.wifiSpokes.values()].map((sp) => ({
      slot: sp.slot,
      fp: sp.fp,
      label: sp.label,
      profile: sp.profile,
      fw: sp.fw,
      online: nowMs - sp.lastRxMs < 2500,
      msAgo: Math.max(0, nowMs - sp.lastRxMs),
      frames: sp.frames,
      seq: sp.seq,
      dbm: sp.dbm,
    }));
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

  public setHubHost(host: string, reconnectNow = false): void {
    const next = normalizeHost(host);
    this.hubHost = next;
    try {
      window.localStorage.setItem(HUB_HOST_STORAGE_KEY, next);
    } catch {
      // ignore
    }
    this.notify();
    if (reconnectNow && (this.wifiDesired || this.wifiState === "connected")) {
      this.connectWifiStream(true);
    }
  }

  public setActive(active: boolean): void {
    this.active = active;
    this.notify();
  }

  public resetDefaults(): void {
    this.setHubHost(DEFAULT_HUB_HOST, false);
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
          this.setHubHost(host, false);
          this.connectWifiStream(true);
          return host;
        }
      }
      this.wifiError = `No Hub found at ${candidates.join(" or ")}. Join the "SlapRF" Wi-Fi AP (192.168.4.1) or enter the Hub's LAN IP.`;
      this.wifiState = "failed";
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

  public connectWifiStream(resetAttempts = true): void {
    this.connMethod = "wifi";
    this.saveMethodPref("wifi");
    this.wifiDesired = true;
    this.clearReconnect();
    this.closeSocket();
    if (!this.hubHost) {
      this.wifiState = "idle";
      this.notify();
      return;
    }

    if (resetAttempts) {
      this.wifiReconnectAttempt = 0;
    }
    this.wifiState = this.wifiReconnectAttempt > 0 ? "reconnecting" : "connecting";
    this.wifiError = null;
    this.notify();

    try {
      const url = `ws://${this.hubHost}/ws`;
      const sock = new WebSocket(url);
      sock.binaryType = "arraybuffer";
      this.ws = sock;

      sock.onopen = () => {
        if (this.ws !== sock) return;
        this.wifiState = "connected";
        this.wifiReconnectAttempt = 0;
        this.wifiError = null;
        this.lastPushedHex = "";
        this.lastWifiPacketMs = Date.now();
        this.startWatchdog();
        if (this.active) {
          this.wasm.pushHubChannels();
        }
        this.notify();
      };

      sock.onmessage = (ev) => {
        if (this.ws !== sock) return;
        let pkt: Uint8Array | null = null;
        if (ev.data instanceof ArrayBuffer) {
          pkt = new Uint8Array(ev.data);
        } else if (typeof ev.data === "string") {
          pkt = hexToBytes(ev.data);
        }
        if (!pkt || pkt.length < 4) return;
        const nowMs = Date.now();
        this.lastWifiPacketMs = nowMs;
        this.wifiFramesRx++;
        this.inspectBinaryPacket(pkt);
        if (this.active) {
          this.wasm.ingestHubPacket(pkt);
          if (pkt.length === 36 && pkt[0] === 0xc5 && pkt[1] === 0x5a) {
            this.onPacketIngested?.();
          }
        }
        if (this.wifiFramesRx === 1 || nowMs - this.lastStreamNotifyMs >= 500) {
          this.lastStreamNotifyMs = nowMs;
          this.notify();
        }
      };

      sock.onerror = () => {
        if (this.ws !== sock) return;
        this.handleStreamDisconnect();
      };

      sock.onclose = () => {
        if (this.ws !== sock) return;
        this.handleStreamDisconnect();
      };
    } catch (err) {
      this.wifiDesired = false;
      this.wifiState = "failed";
      this.wifiError = err instanceof Error ? err.message : String(err);
      this.notify();
    }
  }

  private handleStreamDisconnect(): void {
    this.closeSocket();
    if (!this.wifiDesired) {
      this.wifiState = "idle";
      this.notify();
      return;
    }
    const nextAttempt = this.wifiReconnectAttempt + 1;
    if (nextAttempt <= this.maxReconnectAttempts) {
      this.wifiReconnectAttempt = nextAttempt;
      this.wifiState = "reconnecting";
      this.wifiError = `Reconnecting to Hub at ws://${this.hubHost}/ws (attempt ${nextAttempt} of ${this.maxReconnectAttempts})…`;
      this.notify();
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        if (this.wifiDesired) {
          this.connectWifiStream(false);
        }
      }, 1800);
    } else {
      this.wifiDesired = false;
      this.wifiState = "failed";
      const isHttps = typeof window !== "undefined" && window.location.protocol === "https:";
      this.wifiError = isHttps
        ? `Failed after ${this.maxReconnectAttempts} attempts to reach ws://${this.hubHost}/ws (if blocked by HTTPS mixed-content, allow Insecure Content in site settings or use Direct USB-C).`
        : `Failed after ${this.maxReconnectAttempts} attempts to reach Hub at ws://${this.hubHost}/ws. Verify you are connected to the "SlapRF" Wi-Fi AP or check the Hub IP.`;
      this.notify();
    }
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdogTimer = window.setInterval(() => {
      if (this.wifiState === "connected" && this.lastWifiPacketMs > 0) {
        if (Date.now() - this.lastWifiPacketMs > 3500) {
          this.handleStreamDisconnect();
        }
      }
    }, 1500);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer !== null) {
      window.clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  public disconnectWifiStream(): void {
    this.wifiDesired = false;
    this.wifiReconnectAttempt = 0;
    this.clearReconnect();
    this.closeSocket();
    this.wifiState = "idle";
    this.wifiError = null;
    this.wifiStatus = null;
    this.wifiSpokes.clear();
    this.notify();
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeSocket(): void {
    this.stopWatchdog();
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}
