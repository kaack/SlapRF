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
import { HttpRealTransport } from "./http_transport";
import { buildOrPatchFirmwareBin, LATEST_FIRMWARE_VERSION } from "./esp_flasher";
import { ApiTransport } from "./transport";
import { WasmSimTransport } from "./wasm_transport";

interface LapPayload {
  lap: LapRecord;
  summaries: PilotTrackSummary[];
}

interface ConfigPayload {
  pilots: PilotSlot[];
  pucks: GatePuck[];
}

const STATUS_POLL_MS = 2000;

/**
 * REST + 50 Hz stream client routed through an `ApiTransport` interface:
 * - Simulation mode (`WasmSimTransport`): executes the Go timing & physics engine
 *   compiled to WebAssembly (`slaprf.wasm`) right in the browser (works on static GitHub Pages).
 * - Real-world mode (`HttpRealTransport`): connects to the native Go backend (`/api/*` & `/api/stream`).
 */
export class ApiClient {
  private readonly store: AppStore;
  private readonly wasmTransport = new WasmSimTransport();
  private readonly httpTransport = new HttpRealTransport();
  private simMode = true;

  constructor(store: AppStore) {
    this.store = store;
  }

  private get transport(): ApiTransport {
    return this.simMode ? this.wasmTransport : this.httpTransport;
  }

  public async initialize(): Promise<void> {
    window.addEventListener("pagehide", () => this.transport.disconnectStream());
    window.addEventListener("beforeunload", () => this.transport.disconnectStream());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.transport.disconnectStream();
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
    this.store.hydrate(await this.transport.request<FullStateResponse>("GET", "/api/state"));
  }

  public async toggleSimulator(): Promise<void> {
    this.transport.disconnectStream();
    this.simMode = !this.simMode;
    this.connectStream();
    await this.refresh();
  }

  public async toggleArmed(): Promise<void> {
    this.store.applyStatus(await this.transport.request<StatusResponse>("POST", "/api/timing/toggle-arm"));
  }

  public async simulatePack(): Promise<void> {
    this.store.hydrate(await this.transport.request<FullStateResponse>("POST", "/api/sim/pack-burst"));
  }

  public async simPilotAction(
    slotIndex: number,
    action:
      | "crash"
      | "recover"
      | "walk-recover"
      | "pit"
      | "break"
      | "pause"
      | "launch"
      | "refill-launch"
      | "resume"
  ): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/sim/pilot-action", { slotIndex, action })
    );
  }

  public async setTrackWalker(active: boolean): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/sim/track-walker", { active })
    );
  }

  public async simTimerAction(payload: {
    action: "toggle-power" | "delete" | "add";
    puckId?: number;
    role?: "hub" | "spoke";
    label?: string;
    firmwareVersion?: string;
  }): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/sim/timer-action", payload)
    );
  }

  public async pollStatusNow(): Promise<void> {
    await this.pollStatus();
  }

  public async resetSession(): Promise<void> {
    this.store.hydrate(await this.transport.request<FullStateResponse>("POST", "/api/session/reset"));
  }

  public async updatePilotSlot(slot: PilotSlot): Promise<void> {
    this.store.hydrate(await this.transport.request<FullStateResponse>("POST", "/api/pilots/update", slot));
  }

  public async updateTrackNode(update: GateUpdate): Promise<void> {
    this.store.hydrate(await this.transport.request<FullStateResponse>("POST", "/api/track/update", update));
  }

  public async updateGate(update: GateUpdate): Promise<void> {
    await this.updateTrackNode(update);
  }

  public async addTrackNode(name = "", assignedPuckId = 0, trackOrder?: number): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/track/add", {
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
    this.store.hydrate(await this.transport.request<FullStateResponse>("POST", "/api/track/remove", { puckId }));
  }

  public async removeGate(puckId: number): Promise<void> {
    await this.removeTrackNode(puckId);
  }

  public async updateTimerColor(puckId: number, color: string): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/timers/color", { puckId, color })
    );
  }

  public async updatePuckColor(puckId: number, color: string): Promise<void> {
    await this.updateTimerColor(puckId, color);
  }

  /** Registers a newly flashed timer (hub or spoke) with its flashed hardware ID/name and firmware version. */
  public async provisionTimer(
    role: "hub" | "spoke",
    puckLabel: string,
    firmwareVersion = LATEST_FIRMWARE_VERSION
  ): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/timers/provision", {
        role,
        puckLabel,
        firmwareVersion,
      })
    );
  }

  public async provisionGate(
    role: "hub" | "spoke",
    puckLabel: string,
    firmwareVersion = LATEST_FIRMWARE_VERSION
  ): Promise<void> {
    await this.provisionTimer(role, puckLabel, firmwareVersion);
  }

  /**
   * Builds or patches a pre-configured XIAO ESP32-C5 firmware binary stamped with role,
   * puckLabel, firmwareVersion & active channels. Works both against the Go backend and
   * 100% client-side in the browser from static `.bin` assets with zero Go server needed.
   */
  public async fetchFirmwareImage(
    role: "hub" | "spoke",
    puckLabel = "",
    wifiSSID = "",
    wifiPass = "",
    firmwareVersion = LATEST_FIRMWARE_VERSION
  ): Promise<{ bytes: Uint8Array; sha256: string; filename: string }> {
    try {
      return await this.transport.fetchFirmwareImage(role, puckLabel, wifiSSID, wifiPass, firmwareVersion);
    } catch {
      const freqs = this.store.pilots.slice(0, 8).map((p) => p.frequencyMhz);
      const built = await buildOrPatchFirmwareBin({
        role,
        puckLabel,
        wifiSSID,
        wifiPass,
        firmwareVersion,
        frequenciesMHz: freqs,
      });
      return { bytes: built.bytes, sha256: "", filename: built.filename };
    }
  }

  /** Forwards a live 16-byte binary telemetry frame received over WebSerial into the timing engine. */
  public async ingestTelemetryFrame(frame: PuckTelemetryFrame): Promise<void> {
    await this.httpTransport.request("POST", "/api/ingest/frame", frame);
  }

  /** Lists visible & saved Wi-Fi networks detected by this computer. */
  public async listWifiNetworks(): Promise<
    Array<{ ssid: string; signalPct?: number; connected?: boolean; saved?: boolean }>
  > {
    try {
      const res = await this.httpTransport.request<{
        networks?: Array<{ ssid: string; signalPct?: number; connected?: boolean; saved?: boolean }>;
      }>("GET", "/api/wifi/networks");
      return res.networks ?? [];
    } catch {
      return [];
    }
  }

  /** Per-gate, per-pilot enter thresholds (all applied, or none if any is invalid). */
  public async setGateThresholds(updates: GateThresholdUpdate[]): Promise<void> {
    this.store.hydrate(await this.transport.request<FullStateResponse>("POST", "/api/thresholds", updates));
  }

  /** One gate's timing-rule overrides; an empty object clears them. */
  public async setGateRules(puckId: number, overrides: GateRuleOverrides): Promise<void> {
    this.store.hydrate(await this.transport.request<FullStateResponse>("POST", "/api/gates/rules", { puckId, overrides }));
  }

  /** Saves timing guardrails; the server clamps values and returns what it applied. */
  public async updateRules(rules: TimingRules): Promise<void> {
    this.store.applyRules(await this.transport.request<TimingRules>("POST", "/api/rules", rules));
  }

  private async pollStatus(): Promise<void> {
    try {
      this.store.applyStatus(await this.transport.request<StatusResponse>("GET", "/api/status"));
    } catch {
      // Ignore transient poll errors
    }
  }

  private connectStream(): void {
    this.transport.connectStream((msg: StreamEnvelope) => {
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
    });
  }
}
