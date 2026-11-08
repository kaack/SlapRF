import {
  FullStateResponse,
  GatePuck,
  GateRuleOverrides,
  GateThresholdUpdate,
  GateUpdate,
  PilotSlot,
  StatusResponse,
  StreamEnvelope,
  TimingRules,
} from "../types/models";
import { ApiTransport, FirmwareImageResult } from "./transport";

const RECONNECT_MS = 1500;
const RACEBAND_MHZ = [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917];
const PILOT_COLORS = ["#ef4444", "#3b82f6", "#10b981", "#f59e0b", "#a855f7", "#06b6d4", "#ec4899", "#84cc16"];
const GATE_COLORS = ["#d4ff3a", "#38bdf8", "#f472b6", "#fb923c", "#a78bfa", "#2dd4bf", "#facc15", "#f87171"];

/**
 * Real-world HTTP + Server-Sent-Events transport.
 * Connects to the native Go backend (`/api/*` and `/api/stream`) when running locally,
 * and falls back cleanly to an empty real-world state when hosted on static GitHub Pages.
 */
export class HttpRealTransport implements ApiTransport {
  private source: EventSource | null = null;
  private onEnvelope: ((msg: StreamEnvelope) => void) | null = null;
  private reconnectTimer: number | null = null;
  private backendAvailable = true;

  // Offline real-world state fallback when running on static GitHub Pages with no backend
  private fallbackPilots: PilotSlot[] = [1, 3, 5, 8, 2, 4, 6, 7].map((ch, i) => ({
    slotIndex: i + 1,
    callsign: `Pilot ${i + 1}`,
    enabled: i < 4,
    band: 1,
    channel: ch,
    frequencyMhz: RACEBAND_MHZ[ch - 1],
    enterThreshold: -58,
    exitThreshold: -68,
    attenuationGain: 52,
    color: PILOT_COLORS[i],
  }));
  private fallbackPucks: GatePuck[] = [];
  private fallbackRules: TimingRules = {
    minLapSec: 5,
    maxLapSec: 120,
    gateCooldownSec: 2,
    minSectionSec: 0.5,
    echoWindowSec: 3,
  };
  private fallbackArmed = true;

  public async request<T = unknown>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        throw new Error(`${method} ${url} failed: ${res.status}`);
      }
      const data = (await res.json()) as Record<string, unknown>;
      // Ensure the native Go server is switched to its isolated realEngine whenever HttpRealTransport is active.
      if ((url === "/api/state" || url === "/api/status") && data && data.simulatorRunning === true) {
        const switched = await fetch("/api/sim/toggle", { method: "POST" });
        if (switched.ok) {
          const stateData = (await switched.json()) as T;
          this.backendAvailable = true;
          return stateData;
        }
      }
      this.backendAvailable = true;
      return data as T;
    } catch {
      this.backendAvailable = false;
      return this.handleOfflineFallback(method, url, body) as T;
    }
  }

  public async fetchFirmwareImage(
    role: "hub" | "spoke",
    puckLabel: string,
    wifiSSID: string,
    wifiPass: string
  ): Promise<FirmwareImageResult> {
    const params = new URLSearchParams({ role });
    if (puckLabel.trim()) params.set("label", puckLabel.trim());
    if (role === "hub" && wifiSSID.trim()) {
      params.set("ssid", wifiSSID.trim());
      params.set("pass", wifiPass);
    }
    const res = await fetch(`/api/firmware/xiao-c5.bin?${params.toString()}`, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`Firmware build failed: ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    const sha256 = res.headers.get("X-SlapRF-SHA256") ?? "";
    const slug = puckLabel.trim() ? puckLabel.trim().replace(/[^a-zA-Z0-9_-]+/g, "-") : role;
    return {
      bytes: new Uint8Array(buf),
      sha256,
      filename: `slaprf-xiao-c5-${slug}.bin`,
    };
  }

  public connectStream(onEnvelope: (msg: StreamEnvelope) => void): void {
    this.onEnvelope = onEnvelope;
    this.openEventSource();
  }

  private openEventSource(): void {
    this.source?.close();
    if (!this.onEnvelope) return;
    const es = new EventSource("/api/stream");
    this.source = es;

    es.onmessage = (evt: MessageEvent<string>) => {
      if (!this.onEnvelope) return;
      try {
        this.onEnvelope(JSON.parse(evt.data) as StreamEnvelope);
      } catch (err) {
        console.error("[HttpRealTransport] stream parse error:", err);
      }
    };

    es.onerror = () => {
      es.close();
      if (document.hidden || !this.onEnvelope || !this.backendAvailable) return;
      this.reconnectTimer = window.setTimeout(() => {
        if (!document.hidden && this.onEnvelope) {
          this.openEventSource();
        }
      }, RECONNECT_MS);
    };
  }

  public disconnectStream(): void {
    this.onEnvelope = null;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.source?.close();
    this.source = null;
  }

  private handleOfflineFallback(_method: string, url: string, body?: unknown): unknown {
    if (url === "/api/timing/toggle-arm") {
      this.fallbackArmed = !this.fallbackArmed;
      return this.offlineStatus();
    }
    if (url === "/api/status") {
      return this.offlineStatus();
    }
    if (url === "/api/rules") {
      if (body) {
        this.fallbackRules = { ...this.fallbackRules, ...(body as TimingRules) };
      }
      return { ...this.fallbackRules };
    }
    if (url === "/api/pilots/update" && body) {
      const upd = body as PilotSlot;
      const idx = this.fallbackPilots.findIndex((p) => p.slotIndex === upd.slotIndex);
      if (idx >= 0) {
        const next = { ...this.fallbackPilots[idx], ...upd };
        if (next.enabled) {
          const otherEnabled = this.fallbackPilots.filter((p, i) => i !== idx && p.enabled);
          if (otherEnabled.length >= 8) {
            next.enabled = false;
          } else if (otherEnabled.some((p) => p.channel === next.channel)) {
            const used = new Set(otherEnabled.map((p) => p.channel));
            for (let ch = 1; ch <= 8; ch++) {
              if (!used.has(ch)) {
                next.channel = ch;
                next.frequencyMhz = RACEBAND_MHZ[ch - 1];
                break;
              }
            }
          }
        }
        this.fallbackPilots[idx] = next;
      }
    } else if (url === "/api/thresholds" && Array.isArray(body)) {
      for (const u of body as GateThresholdUpdate[]) {
        const puck = this.fallbackPucks.find((p) => p.puckId === u.puckId);
        const pos = this.fallbackPilots.findIndex((p) => p.slotIndex === u.slotIndex);
        if (puck && pos >= 0) puck.enterThresholds[pos] = u.enterDbm;
      }
    } else if ((url === "/api/gates/rules" || url === "/api/track/rules") && body) {
      const b = body as { puckId: number; overrides: GateRuleOverrides };
      const puck = this.fallbackPucks.find((p) => p.puckId === b.puckId);
      if (puck) puck.ruleOverrides = { ...b.overrides };
    } else if ((url === "/api/track/update" || url === "/api/gates/update") && body) {
      const u = body as GateUpdate;
      const puck = this.fallbackPucks.find((p) => p.puckId === u.puckId);
      if (puck) {
        if (u.name !== undefined) puck.name = u.name;
        if (u.role === "START_FINISH") {
          this.fallbackPucks.forEach((p) => (p.role = p.puckId === puck.puckId ? "START_FINISH" : "SECTOR_GATE"));
        }
      }
    } else if (url === "/api/track/add" || url === "/api/gates/add") {
      const b = (body ?? {}) as { name?: string; assignedPuckId?: number };
      const nextId = this.fallbackPucks.length + 1;
      if (nextId <= 6) {
        this.fallbackPucks.push({
          puckId: nextId,
          assignedPuckId: b.assignedPuckId ?? 0,
          puckLabel: "",
          name: b.name ?? "",
          color: GATE_COLORS[(nextId - 1) % GATE_COLORS.length],
          role: this.fallbackPucks.length === 0 ? "START_FINISH" : "SECTOR_GATE",
          trackOrder: this.fallbackPucks.length,
          mapX: 0.5,
          mapY: 0.5,
          batteryMv: 0,
          batteryPct: 0,
          noiseFloorDbm: -92,
          lastRssi: [-92, -92, -92, -92, -92, -92, -92, -92],
          enterThresholds: [0, 0, 0, 0, 0, 0, 0, 0],
          ruleOverrides: {},
          online: false,
          lastSeenAt: "",
          framesRxCount: 0,
        });
      }
    } else if ((url === "/api/track/remove" || url === "/api/gates/remove") && body) {
      const b = body as { puckId: number };
      this.fallbackPucks = this.fallbackPucks.filter((p) => p.puckId !== b.puckId);
    } else if (url === "/api/wifi/networks") {
      return { networks: [] };
    }
    return this.offlineState();
  }

  private offlineStatus(): StatusResponse {
    return {
      serverTimestampUs: 0,
      pucks: this.fallbackPucks.map((p) => ({ ...p })),
      detectedPucks: [],
      simulatorRunning: false,
      raceArmed: this.fallbackArmed,
      liveTimeStatus: {
        listenAddr: ":5403",
        connectedClients: 0,
        detectionsSent: 0,
        statusFramesSent: 0,
        lastRfSetupSync: "",
        raceArmedByHost: this.fallbackArmed,
      },
    };
  }

  private offlineState(): FullStateResponse {
    return {
      ...this.offlineStatus(),
      pilots: this.fallbackPilots.map((p) => ({ ...p })),
      laps: [],
      crossings: [],
      filtered: [],
      summaries: [],
      rules: { ...this.fallbackRules },
    };
  }
}
