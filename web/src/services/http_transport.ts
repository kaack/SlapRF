import {
  DetectedTimer,
  FullStateResponse,
  GateRuleOverrides,
  GateThresholdUpdate,
  GateUpdate,
  PilotSlot,
  StatusResponse,
  StreamEnvelope,
  TimingRules,
  TrackNode,
} from "../types/models";
import { ApiTransport, FirmwareImageResult } from "./transport";

const RECONNECT_MS = 1500;
const REAL_FALLBACK_STORAGE_KEY = "slaprf.real_fallback.v1";
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
  private fallbackPilots: PilotSlot[] = [1, 3, 5, 8, 0, 0, 0, 0].map((ch, i) => ({
    slotIndex: i + 1,
    callsign: `Pilot ${i + 1}`,
    enabled: i < 4,
    band: 1,
    channel: ch,
    frequencyMhz: ch > 0 ? RACEBAND_MHZ[ch - 1] : 0,
    enterThreshold: -58,
    exitThreshold: -68,
    attenuationGain: 52,
    color: PILOT_COLORS[i],
  }));
  private fallbackNodes: TrackNode[] = [];
  private fallbackDetectedTimers: DetectedTimer[] = [];
  private fallbackRules: TimingRules = {
    minLapSec: 5,
    maxLapSec: 120,
    gateCooldownSec: 2,
    minSectionSec: 0.5,
    echoWindowSec: 3,
  };
  private fallbackArmed = true;
  private fallbackLiveTimeEnabled = false;

  constructor() {
    this.loadOfflineFallback();
  }

  private loadOfflineFallback(): void {
    try {
      const raw = window.localStorage.getItem(REAL_FALLBACK_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        pilots?: PilotSlot[];
        nodes?: TrackNode[];
        timers?: DetectedTimer[];
        rules?: TimingRules;
        armed?: boolean;
        liveTimeEnabled?: boolean;
      };
      if (Array.isArray(parsed.pilots) && parsed.pilots.length > 0) this.fallbackPilots = parsed.pilots;
      if (Array.isArray(parsed.nodes)) this.fallbackNodes = parsed.nodes;
      if (Array.isArray(parsed.timers)) this.fallbackDetectedTimers = parsed.timers;
      if (parsed.rules) this.fallbackRules = { ...this.fallbackRules, ...parsed.rules };
      if (typeof parsed.armed === "boolean") this.fallbackArmed = parsed.armed;
      if (typeof parsed.liveTimeEnabled === "boolean") this.fallbackLiveTimeEnabled = parsed.liveTimeEnabled;
    } catch {
      // Ignore storage parse errors
    }
  }

  private saveOfflineFallback(): void {
    try {
      window.localStorage.setItem(
        REAL_FALLBACK_STORAGE_KEY,
        JSON.stringify({
          pilots: this.fallbackPilots,
          nodes: this.fallbackNodes,
          timers: this.fallbackDetectedTimers,
          rules: this.fallbackRules,
          armed: this.fallbackArmed,
          liveTimeEnabled: this.fallbackLiveTimeEnabled,
        })
      );
    } catch {
      // Ignore storage quota errors
    }
  }

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
    timerLabel: string,
    wifiSSID: string,
    wifiPass: string,
    profile: string,
    fingerprint: string
  ): Promise<FirmwareImageResult> {
    const params = new URLSearchParams({ role, profile, fingerprint });
    if (timerLabel.trim()) params.set("label", timerLabel.trim());
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
    const slug = timerLabel.trim() ? timerLabel.trim().replace(/[^a-zA-Z0-9_-]+/g, "-") : role;
    return {
      bytes: new Uint8Array(buf),
      sha256,
      filename: `slaprf-xiao-c5-${slug}-${profile}.bin`,
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
      if (!this.onEnvelope || !this.backendAvailable) return;
      this.reconnectTimer = window.setTimeout(() => {
        if (this.onEnvelope) {
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

  private handleOfflineFallback(method: string, url: string, body?: unknown): unknown {
    if (url === "/api/timing/toggle-arm") {
      this.fallbackArmed = !this.fallbackArmed;
      this.saveOfflineFallback();
      return this.offlineStatus();
    }
    if (url === "/api/livetime/toggle") {
      const b = (body ?? {}) as { enabled?: boolean };
      this.fallbackLiveTimeEnabled = b.enabled !== undefined ? b.enabled : !this.fallbackLiveTimeEnabled;
      this.saveOfflineFallback();
      return this.offlineStatus();
    }
    if (url === "/api/status") {
      return this.offlineStatus();
    }
    if (url === "/api/rules") {
      if (body) {
        this.fallbackRules = { ...this.fallbackRules, ...(body as TimingRules) };
        this.saveOfflineFallback();
      }
      return { ...this.fallbackRules };
    }
    if (url === "/api/pilots/update" && body) {
      const upd = body as PilotSlot;
      const idx = this.fallbackPilots.findIndex((p) => p.slotIndex === upd.slotIndex);
      if (idx >= 0) {
        const wasEnabled = this.fallbackPilots[idx].enabled;
        const next = { ...this.fallbackPilots[idx], ...upd };
        next.frequencyMhz = next.channel >= 1 && next.channel <= 8 ? RACEBAND_MHZ[next.channel - 1] : 0;
        if (next.enabled) {
          const otherEnabled = this.fallbackPilots.filter((p, i) => i !== idx && p.enabled);
          if (otherEnabled.length >= 8) {
            next.enabled = false;
          } else if (next.channel > 0 && otherEnabled.some((p) => p.channel === next.channel)) {
            if (!wasEnabled) {
              next.channel = 0;
              next.frequencyMhz = 0;
            } else {
              this.fallbackPilots.forEach((p, i) => {
                if (i !== idx && p.enabled && p.channel === next.channel) {
                  p.channel = 0;
                  p.frequencyMhz = 0;
                }
              });
            }
          }
        }
        this.fallbackPilots[idx] = next;
      }
    } else if (url === "/api/thresholds" && Array.isArray(body)) {
      for (const u of body as GateThresholdUpdate[]) {
        const node = this.fallbackNodes.find((n) => n.gateId === u.gateId);
        const pos = this.fallbackPilots.findIndex((p) => p.slotIndex === u.slotIndex);
        if (node && pos >= 0) node.enterThresholds[pos] = u.enterDbm;
      }
    } else if ((url === "/api/gates/rules" || url === "/api/track/rules") && body) {
      const b = body as { gateId: number; overrides: GateRuleOverrides };
      const node = this.fallbackNodes.find((n) => n.gateId === b.gateId);
      if (node) node.ruleOverrides = { ...b.overrides };
    } else if ((url === "/api/track/update" || url === "/api/gates/update") && body) {
      const u = body as GateUpdate;
      const node = this.fallbackNodes.find((n) => n.gateId === u.gateId);
      if (node) {
        if (u.name !== undefined) node.name = u.name;
        if (u.role === "START_FINISH") {
          this.fallbackNodes.forEach((n) => (n.role = n.gateId === node.gateId ? "START_FINISH" : "SECTOR_GATE"));
        }
      }
    } else if (url === "/api/track/add" || url === "/api/gates/add") {
      const b = (body ?? {}) as { name?: string; assignedTimerId?: number };
      const nextId = this.fallbackNodes.length + 1;
      if (nextId <= 6) {
        this.fallbackNodes.push({
          gateId: nextId,
          assignedTimerId: b.assignedTimerId ?? 0,
          timerLabel: "",
          name: b.name ?? "",
          color: GATE_COLORS[(nextId - 1) % GATE_COLORS.length],
          role: this.fallbackNodes.length === 0 ? "START_FINISH" : "SECTOR_GATE",
          trackOrder: this.fallbackNodes.length,
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
      const b = body as { gateId: number };
      this.fallbackNodes = this.fallbackNodes.filter((n) => n.gateId !== b.gateId);
    } else if (url === "/api/timers/provision" && body) {
      const b = body as {
        role?: "hub" | "spoke";
        timerLabel?: string;
        firmwareProfile?: string;
        fingerprint?: string;
      };
      const isHub = b.role === "hub";
      const label = (b.timerLabel ?? (isHub ? "H1" : "S1")).trim();
      const fp = (b.fingerprint ?? "").trim().toUpperCase();
      const existing = this.fallbackDetectedTimers.find(
        (d) =>
          (fp && d.fingerprint?.toUpperCase() === fp) ||
          (isHub && d.isHub) ||
          d.timerLabel.toUpperCase() === label.toUpperCase()
      );
      if (existing) {
        existing.timerLabel = label;
        existing.isHub = isHub;
        existing.firmwareProfile = b.firmwareProfile ?? existing.firmwareProfile;
        existing.fingerprint = fp || existing.fingerprint;
      } else {
        const nextId = isHub
          ? 1
          : Math.max(2, ...this.fallbackDetectedTimers.map((d) => d.timerId + 1));
        this.fallbackDetectedTimers.push({
          timerId: nextId,
          timerLabel: label,
          color: GATE_COLORS[(nextId - 1) % GATE_COLORS.length],
          isHub,
          firmwareVersion: "v1.4.2",
          firmwareProfile: b.firmwareProfile ?? "balanced",
          fingerprint: fp,
          batteryMv: 3950,
          batteryPct: 82,
          noiseFloorDbm: -92,
          online: false,
          lastSeenAt: new Date().toISOString(),
        });
      }
    } else if (url === "/api/timers/color" && body) {
      const b = body as { timerId: number; color: string };
      const det = this.fallbackDetectedTimers.find((d) => d.timerId === b.timerId);
      if (det) det.color = b.color;
      const gate = this.fallbackNodes.find((n) => (n.assignedTimerId ?? n.gateId) === b.timerId);
      if (gate) gate.color = b.color;
    } else if (url === "/api/wifi/networks") {
      return { networks: [] };
    }
    if (method === "POST") {
      this.saveOfflineFallback();
    }
    return this.offlineState();
  }

  private offlineStatus(): StatusResponse {
    return {
      serverTimestampUs: 0,
      gates: this.fallbackNodes.map((n) => ({ ...n })),
      timers: this.fallbackDetectedTimers.map((d) => ({ ...d })),
      simulatorRunning: false,
      raceArmed: this.fallbackArmed,
      liveTimeStatus: {
        enabled: this.fallbackLiveTimeEnabled,
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
