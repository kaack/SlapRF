import { AppStore } from "../state/store";
import {
  FilteredDetection,
  FullStateResponse,
  GateCrossingEvent,
  GateRuleOverrides,
  GateThresholdUpdate,
  GateUpdate,
  LapRecord,
  PilotSlot,
  PilotTrackSummary,
  StatusResponse,
  StreamEnvelope,
  TimerTelemetryFrame,
  TimingRules,
  TrackNode,
} from "../types/models";
import { HttpRealTransport } from "./http_transport";
import {
  buildOrPatchFirmwareBin,
  DEFAULT_FIRMWARE_PROFILE,
  FIRMWARE_PROFILES,
  generateFingerprint,
  LATEST_FIRMWARE_VERSION,
} from "./esp_flasher";
import { sharedTimerConsole, TimerStatus } from "./timer_console";
import { ApiTransport } from "./transport";
import { WasmSimTransport } from "./wasm_transport";

interface LapPayload {
  lap: LapRecord;
  summaries: PilotTrackSummary[];
}

interface ConfigPayload {
  pilots: PilotSlot[];
  gates: TrackNode[];
}

const STATUS_POLL_MS = 2000;
const SIM_MODE_STORAGE_KEY = "slaprf.ui.sim_mode.v1";

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
  private readonly provisionedUsbKeys = new Set<string>();

  constructor(store: AppStore) {
    this.store = store;
    try {
      const savedMode = window.localStorage.getItem(SIM_MODE_STORAGE_KEY);
      if (savedMode === "false") {
        this.simMode = false;
      } else if (savedMode === "true") {
        this.simMode = true;
      }
    } catch {
      // Ignore storage access errors
    }
  }

  private get transport(): ApiTransport {
    return this.simMode ? this.wasmTransport : this.httpTransport;
  }

  public async initialize(): Promise<void> {
    window.addEventListener("pagehide", () => this.transport.disconnectStream());
    window.addEventListener("beforeunload", () => this.transport.disconnectStream());
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        this.connectStream();
        void this.refresh().catch(() => undefined);
      }
    });
    this.bindUsbTimerSync();
    await this.refresh();
    this.connectStream();
    window.setInterval(() => {
      void this.pollStatus();
    }, STATUS_POLL_MS);
  }

  private bindUsbTimerSync(): void {
    const syncFromConsole = (s: TimerStatus | null) => {
      if (!sharedTimerConsole.connected || !s) {
        this.store.setUsbDetectedTimer(null);
        return;
      }
      const cfg = sharedTimerConsole.lastConfig;
      const isHub = s.role === 1 || cfg?.role === "hub";
      const label = (s.label || cfg?.timerLabel || (isHub ? "H1" : `S${Math.max(1, (s.slot || 2) - 1)}`)).trim();
      const profileId =
        cfg?.firmwareProfile ||
        FIRMWARE_PROFILES.find((p) => p.code === s.profile)?.id ||
        DEFAULT_FIRMWARE_PROFILE;
      const fp = (s.fp || cfg?.fingerprint || "").trim().toUpperCase();
      const timerId = isHub ? 1 : Math.max(2, s.slot || 2);

      this.store.setUsbDetectedTimer({
        timerId,
        timerLabel: label,
        color: "#d4ff3a",
        isHub,
        firmwareVersion: s.fw || cfg?.firmwareVersion || LATEST_FIRMWARE_VERSION,
        firmwareProfile: profileId,
        fingerprint: fp,
        batteryMv: 3950,
        batteryPct: 82,
        noiseFloorDbm: Math.round(s.rf?.floorDb ?? -92),
        online: false,
        lastSeenAt: "",
      });

      const provKey = `${this.simMode ? "sim" : "real"}:${isHub ? "hub" : "spoke"}:${label}:${fp}`;
      if (!this.provisionedUsbKeys.has(provKey)) {
        this.provisionedUsbKeys.add(provKey);
        void this.provisionTimer(isHub ? "hub" : "spoke", label, profileId, fp).catch(() => undefined);
      }
    };

    sharedTimerConsole.subscribe({
      onStatus: (s) => syncFromConsole(s),
      onConfig: () => syncFromConsole(sharedTimerConsole.lastStatus),
      onDisconnect: () => this.store.setUsbDetectedTimer(null),
    });
  }

  public async refresh(): Promise<void> {
    this.store.hydrate(await this.transport.request<FullStateResponse>("GET", "/api/state"));
  }

  public async toggleSimulator(): Promise<void> {
    this.transport.disconnectStream();
    this.simMode = !this.simMode;
    try {
      window.localStorage.setItem(SIM_MODE_STORAGE_KEY, String(this.simMode));
    } catch {
      // Ignore storage access errors
    }
    this.connectStream();
    await this.refresh();
    if (!this.simMode && sharedTimerConsole.connected && sharedTimerConsole.lastStatus) {
      const s = sharedTimerConsole.lastStatus;
      const cfg = sharedTimerConsole.lastConfig;
      const isHub = s.role === 1 || cfg?.role === "hub";
      const label = (s.label || cfg?.timerLabel || (isHub ? "H1" : `S${Math.max(1, (s.slot || 2) - 1)}`)).trim();
      const profileId =
        cfg?.firmwareProfile ||
        FIRMWARE_PROFILES.find((p) => p.code === s.profile)?.id ||
        DEFAULT_FIRMWARE_PROFILE;
      const fp = (s.fp || cfg?.fingerprint || "").trim().toUpperCase();
      await this.provisionTimer(isHub ? "hub" : "spoke", label, profileId, fp).catch(() => undefined);
    }
  }

  public async toggleArmed(): Promise<void> {
    this.store.applyStatus(await this.transport.request<StatusResponse>("POST", "/api/timing/toggle-arm"));
  }

  public async setLiveTimeEnabled(enabled: boolean): Promise<void> {
    this.store.applyStatus(
      await this.transport.request<StatusResponse>("POST", "/api/livetime/toggle", { enabled })
    );
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
    timerId?: number;
    role?: "hub" | "spoke";
    label?: string;
    firmwareProfile?: string;
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

  public async addTrackNode(name = "", assignedTimerId = 0, trackOrder?: number): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/track/add", {
        name,
        assignedTimerId,
        ...(trackOrder !== undefined ? { trackOrder } : {}),
      })
    );
  }

  public async addGate(name = "", assignedTimerId = 0, trackOrder?: number): Promise<void> {
    await this.addTrackNode(name, assignedTimerId, trackOrder);
  }

  public async removeTrackNode(nodeId: number): Promise<void> {
    this.store.hydrate(await this.transport.request<FullStateResponse>("POST", "/api/track/remove", { gateId: nodeId }));
  }

  public async removeGate(nodeId: number): Promise<void> {
    await this.removeTrackNode(nodeId);
  }

  public async updateTimerColor(timerId: number, color: string): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/timers/color", { timerId, color })
    );
  }

  /** Registers a newly flashed timer (hub or spoke) with its name, firmware profile, and board fingerprint. */
  public async provisionTimer(
    role: "hub" | "spoke",
    timerLabel: string,
    firmwareProfile = DEFAULT_FIRMWARE_PROFILE,
    fingerprint = ""
  ): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/timers/provision", {
        role,
        timerLabel,
        firmwareProfile,
        fingerprint,
      })
    );
  }

  /**
   * Builds or patches a pre-configured XIAO ESP32-C5 firmware binary stamped with role, name,
   * firmware profile, board fingerprint & active channels. Works both against the Go backend and
   * 100% client-side in the browser from static `.bin` assets with zero Go server needed.
   */
  public async fetchFirmwareImage(
    role: "hub" | "spoke",
    timerLabel = "",
    wifiSSID = "",
    wifiPass = "",
    profile = DEFAULT_FIRMWARE_PROFILE,
    fingerprint = generateFingerprint()
  ): Promise<{ bytes: Uint8Array; sha256: string; filename: string }> {
    try {
      return await this.transport.fetchFirmwareImage(role, timerLabel, wifiSSID, wifiPass, profile, fingerprint);
    } catch {
      const freqs = this.store.pilots.slice(0, 8).map((p) => p.frequencyMhz);
      const built = await buildOrPatchFirmwareBin({
        role,
        timerLabel,
        wifiSSID,
        wifiPass,
        profile,
        fingerprint,
        frequenciesMHz: freqs,
      });
      return { bytes: built.bytes, sha256: "", filename: built.filename };
    }
  }
  /** Forwards a live 16-byte binary telemetry frame received over WebSerial into the timing engine. */
  public async ingestTelemetryFrame(frame: TimerTelemetryFrame): Promise<void> {
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
  public async setGateRules(nodeId: number, overrides: GateRuleOverrides): Promise<void> {
    this.store.hydrate(await this.transport.request<FullStateResponse>("POST", "/api/gates/rules", { gateId: nodeId, overrides }));
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
          this.store.ingestTelemetry(msg.payload as TimerTelemetryFrame);
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
          this.store.applyConfig(c.pilots, c.gates);
          break;
        }
      }
    });
  }
}
