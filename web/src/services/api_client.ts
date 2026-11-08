import { AppStore } from "../state/store";
import {
  FilteredDetection,
  FullStateResponse,
  GateCrossingEvent,
  GatePuck,
  GateRuleOverrides,
  GateThresholdUpdate,
  GateUpdate,
  LapRecord,
  PilotSlot,
  PilotTrackSummary,
  PuckTelemetryFrame,
  StatusResponse,
  StreamEnvelope,
  TimingRules,
} from "../types/models";

interface LapPayload {
  lap: LapRecord;
  summaries: PilotTrackSummary[];
}

interface ConfigPayload {
  pilots: PilotSlot[];
  pucks: GatePuck[];
}

const STATUS_POLL_MS = 2000;
const RECONNECT_MS = 1500;

/** REST + Server-Sent-Events client. All server state flows into the AppStore. */
export class ApiClient {
  private readonly store: AppStore;
  private source: EventSource | null = null;

  constructor(store: AppStore) {
    this.store = store;
  }

  public async initialize(): Promise<void> {
    window.addEventListener("pagehide", () => {
      this.source?.close();
      this.source = null;
    });
    window.addEventListener("beforeunload", () => {
      this.source?.close();
      this.source = null;
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.source?.close();
        this.source = null;
      } else {
        this.connectStream();
        void this.refresh().catch(() => undefined);
      }
    });
    await this.refresh();
    this.connectStream();
    window.setInterval(() => {
      if (!document.hidden) void this.pollStatus();
    }, STATUS_POLL_MS);
  }

  public async refresh(): Promise<void> {
    this.store.hydrate(await this.request<FullStateResponse>("GET", "/api/state"));
  }

  public async toggleSimulator(): Promise<void> {
    this.store.hydrate(await this.request<FullStateResponse>("POST", "/api/sim/toggle"));
  }

  public async toggleArmed(): Promise<void> {
    this.store.applyStatus(await this.request<StatusResponse>("POST", "/api/timing/toggle-arm"));
  }

  public async simulatePack(): Promise<void> {
    await this.request("POST", "/api/sim/pack-burst");
  }

  public async resetSession(): Promise<void> {
    this.store.hydrate(await this.request<FullStateResponse>("POST", "/api/session/reset"));
  }

  public async updatePilotSlot(slot: PilotSlot): Promise<void> {
    this.store.hydrate(await this.request<FullStateResponse>("POST", "/api/pilots/update", slot));
  }

  public async updateTrackNode(update: GateUpdate): Promise<void> {
    this.store.hydrate(await this.request<FullStateResponse>("POST", "/api/track/update", update));
  }

  public async updateGate(update: GateUpdate): Promise<void> {
    await this.updateTrackNode(update);
  }

  public async addTrackNode(name = "", assignedPuckId = 0, trackOrder?: number): Promise<void> {
    this.store.hydrate(
      await this.request<FullStateResponse>("POST", "/api/track/add", {
        name,
        assignedPuckId,
        ...(trackOrder !== undefined ? { trackOrder } : {}),
      })
    );
  }

  public async addGate(name = "", assignedPuckId = 0, trackOrder?: number): Promise<void> {
    await this.addTrackNode(name, assignedPuckId, trackOrder);
  }

  public async removeTrackNode(puckId: number): Promise<void> {
    this.store.hydrate(await this.request<FullStateResponse>("POST", "/api/track/remove", { puckId }));
  }

  public async removeGate(puckId: number): Promise<void> {
    await this.removeTrackNode(puckId);
  }

  public async updateTimerColor(puckId: number, color: string): Promise<void> {
    this.store.hydrate(
      await this.request<FullStateResponse>("POST", "/api/timers/color", { puckId, color })
    );
  }

  public async updatePuckColor(puckId: number, color: string): Promise<void> {
    await this.updateTimerColor(puckId, color);
  }

  /** Registers a newly flashed timer (hub or spoke) with its flashed hardware ID/name. */
  public async provisionTimer(role: "hub" | "spoke", puckLabel: string): Promise<void> {
    this.store.hydrate(
      await this.request<FullStateResponse>("POST", "/api/timers/provision", { role, puckLabel })
    );
  }

  public async provisionGate(role: "hub" | "spoke", puckLabel: string): Promise<void> {
    await this.provisionTimer(role, puckLabel);
  }

  /** Downloads a pre-configured XIAO ESP32-C5 firmware binary stamped with role, puckLabel & active channels. */
  public async fetchFirmwareImage(
    role: "hub" | "spoke",
    puckLabel = "",
    wifiSSID = "",
    wifiPass = ""
  ): Promise<{ bytes: Uint8Array; sha256: string; filename: string }> {
    const params = new URLSearchParams({ role });
    if (puckLabel.trim()) {
      params.set("label", puckLabel.trim());
    }
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
    const filename = `slaprf-xiao-c5-${slug}.bin`;
    return { bytes: new Uint8Array(buf), sha256, filename };
  }

  /** Forwards a live 16-byte binary telemetry frame received over WebSerial into the timing engine. */
  public async ingestTelemetryFrame(frame: PuckTelemetryFrame): Promise<void> {
    await this.request("POST", "/api/ingest/frame", frame);
  }

  /** Lists visible & saved Wi-Fi networks detected by this computer. */
  public async listWifiNetworks(): Promise<
    Array<{ ssid: string; signalPct?: number; connected?: boolean; saved?: boolean }>
  > {
    try {
      const res = await this.request<{
        networks?: Array<{ ssid: string; signalPct?: number; connected?: boolean; saved?: boolean }>;
      }>("GET", "/api/wifi/networks");
      return res.networks ?? [];
    } catch {
      return [];
    }
  }

  /** Per-gate, per-pilot enter thresholds (all applied, or none if any is invalid). */
  public async setGateThresholds(updates: GateThresholdUpdate[]): Promise<void> {
    this.store.hydrate(await this.request<FullStateResponse>("POST", "/api/thresholds", updates));
  }

  /** One gate's timing-rule overrides; an empty object clears them. */
  public async setGateRules(puckId: number, overrides: GateRuleOverrides): Promise<void> {
    this.store.hydrate(await this.request<FullStateResponse>("POST", "/api/gates/rules", { puckId, overrides }));
  }

  /** Saves timing guardrails; the server clamps values and returns what it applied. */
  public async updateRules(rules: TimingRules): Promise<void> {
    this.store.applyRules(await this.request<TimingRules>("POST", "/api/rules", rules));
  }

  private async pollStatus(): Promise<void> {
    try {
      if (!this.source || this.source.readyState === EventSource.CLOSED) {
        this.connectStream();
      }
      if (!this.source || this.source.readyState !== EventSource.OPEN) {
        await this.refresh();
      } else {
        this.store.applyStatus(await this.request<StatusResponse>("GET", "/api/status"));
      }
    } catch {
      // Server restarting; the SSE reconnect loop will recover.
    }
  }

  private connectStream(): void {
    this.source?.close();
    const es = new EventSource("/api/stream");
    this.source = es;

    es.onmessage = (evt: MessageEvent<string>) => {
      const msg = JSON.parse(evt.data) as StreamEnvelope;
      switch (msg.type) {
        case "telemetry":
          this.store.ingestTelemetry(msg.payload as PuckTelemetryFrame);
          break;
        case "crossing":
          this.store.ingestCrossing(msg.payload as GateCrossingEvent);
          break;
        case "filtered":
          this.store.ingestFiltered(msg.payload as FilteredDetection);
          break;
        case "lap": {
          const p = msg.payload as LapPayload;
          this.store.ingestLap(p.lap, p.summaries);
          break;
        }
        case "config": {
          const c = msg.payload as ConfigPayload;
          this.store.applyConfig(c.pilots, c.pucks);
          break;
        }
      }
    };

    es.onerror = () => {
      // Server restart, or the server dropped this client for falling behind:
      // reconnect and re-sync from a full snapshot so no laps are missing.
      es.close();
      if (document.hidden) return;
      window.setTimeout(() => {
        if (document.hidden) return;
        this.connectStream();
        void this.refresh().catch(() => undefined);
      }, RECONNECT_MS);
    };
  }

  private async request<T = unknown>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`${method} ${url} failed: ${res.status}`);
    }
    return (await res.json()) as T;
  }
}
