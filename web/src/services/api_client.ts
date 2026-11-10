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
import { BrowserHubBridge } from "./browser_hub_bridge";
import { enginePersistence, LAST_BACKUP_STORAGE_KEY, LEGACY_LOCALSTORAGE_KEYS } from "./engine_persistence";
import {
  buildOrPatchFirmwareBin,
  generateFingerprint,
  LATEST_FIRMWARE_VERSION,
} from "./esp_flasher";
import { bindSimSerialStore, isSimulatedSerialPort, listSimulatedTimers } from "./sim_serial_port";
import { forgetKnownHardwareTimer, TimerConsole, TimerStatus, usbPool } from "./timer_console";
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
 * REST + 50 Hz stream client. Every call runs in-browser against the Go timing engine compiled
 * to WebAssembly (`slaprf.wasm`, via `WasmSimTransport`), in both modes:
 * - Simulation mode: the built-in track simulator feeds the isolated simulation engine.
 * - Real-world mode: the physical Hub (USB-C WebSerial, via `BrowserHubBridge`) feeds the
 *   isolated real-world engine.
 */
export class ApiClient {
  private readonly store: AppStore;
  private readonly transport = new WasmSimTransport();
  public readonly hubBridge: BrowserHubBridge;
  private simMode = true;
  private readonly provisionedUsbKeys = new Set<string>();
  private hubRefreshTimer: number | null = null;

  constructor(store: AppStore) {
    this.store = store;
    bindSimSerialStore(this.store);
    this.hubBridge = new BrowserHubBridge(this.transport);
    this.hubBridge.onPacketIngested = () => {
      if (this.hubRefreshTimer !== null) return;
      this.hubRefreshTimer = window.setTimeout(() => {
        this.hubRefreshTimer = null;
        if (this.usingBrowserRealEngine) {
          void this.pollStatus();
        }
      }, 250);
    };
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
    this.transport.setSimRunning(this.simMode);
  }

  /** True when Real-world hardware mode is active (the in-browser engine is fed by the Hub). */
  public get usingBrowserRealEngine(): boolean {
    return !this.simMode;
  }

  public async initialize(): Promise<void> {
    window.addEventListener("pagehide", () => {
      this.transport.disconnectStream();
      this.hubBridge.setActive(false);
    });
    window.addEventListener("beforeunload", () => {
      this.transport.disconnectStream();
      this.hubBridge.setActive(false);
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        this.connectStream();
        void this.refresh().catch(() => undefined);
      }
    });
    this.transport.setSimRunning(this.simMode);
    this.hubBridge.setActive(this.usingBrowserRealEngine);
    this.bindUsbTimerSync();
    await this.refresh();
    if (this.simMode) {
      await this.autoConnectSimulatedHub();
    }
    this.connectStream();
    window.setInterval(() => {
      void this.pollStatus();
    }, STATUS_POLL_MS);
  }

  private async autoConnectSimulatedHub(): Promise<void> {
    if (!this.simMode || usbPool.mainConsole.connected) return;
    const timers = listSimulatedTimers();
    const target = timers.find((t) => t.isHub && t.poweredOn) ?? timers.find((t) => t.poweredOn);
    if (target) {
      await usbPool.connectSimulatedTimer(target.timerId, 0).catch(() => undefined);
    }
  }

  private bindUsbTimerSync(): void {
    const lastKeyByConsole = new Map<TimerConsole, string>();
    const syncConsole = (c: TimerConsole, s: TimerStatus | null) => {
      const primary = usbPool.primaryConsole();
      if (!primary.connected || !primary.lastStatus) {
        this.store.setUsbDetectedTimer(null);
      } else {
        const ps = primary.lastStatus;
        const pcfg = primary.lastConfig;
        const pIsHub = ps.role === 1 || pcfg?.role === "hub";
        const pLabel = (ps.label || pcfg?.timerLabel || (pIsHub ? "H1" : "T1")).trim();
        const pFp = (ps.fp || pcfg?.fingerprint || "").trim().toUpperCase();
        const pTimerId = pIsHub ? 1 : Math.max(2, ps.slot || 2);
        this.store.setUsbDetectedTimer({
          timerId: pTimerId,
          timerLabel: pLabel,
          color: "#d4ff3a",
          isHub: pIsHub,
          firmwareVersion: ps.fw || pcfg?.firmwareVersion || LATEST_FIRMWARE_VERSION,
          fingerprint: pFp,
          batteryMv: 3950,
          batteryPct: 82,
          noiseFloorDbm: Math.round(ps.rf?.floorDb ?? -92),
          online: false,
          lastSeenAt: "",
        });
      }

      if (!c.connected || !s) {
        const prevKey = lastKeyByConsole.get(c);
        if (prevKey) {
          this.provisionedUsbKeys.delete(prevKey);
          lastKeyByConsole.delete(c);
        }
        return;
      }
      if (this.simMode || isSimulatedSerialPort(c.rawPort)) return;
      const cfg = c.lastConfig;
      const isHub = s.role === 1 || cfg?.role === "hub";
      const label = (s.label || cfg?.timerLabel || (isHub ? "H1" : "T1")).trim();
      const fp = (s.fp || cfg?.fingerprint || "").trim().toUpperCase();
      if (!fp || fp.startsWith("53504B")) return;
      const provKey = `${this.simMode ? "sim" : "real"}:${isHub ? "hub" : "spoke"}:${label}:${fp}`;
      lastKeyByConsole.set(c, provKey);
      if (!this.provisionedUsbKeys.has(provKey)) {
        this.provisionedUsbKeys.add(provKey);
        void this.provisionTimer(isHub ? "hub" : "spoke", label, fp).catch(() => undefined);
      }
    };

    for (const c of usbPool.slots) {
      c.subscribe({
        onStatus: (s) => syncConsole(c, s),
        onConfig: () => syncConsole(c, c.lastStatus),
        onDisconnect: () => syncConsole(c, null),
      });
    }
  }

  public async refresh(): Promise<void> {
    this.store.hydrate(await this.transport.request<FullStateResponse>("GET", "/api/state"));
  }

  public async toggleSimulator(): Promise<void> {
    this.transport.disconnectStream();
    const nextSimMode = !this.simMode;
    if (!nextSimMode) {
      await usbPool.disconnectSimulatedPorts();
    } else {
      await usbPool.disconnectAllCleanly();
    }
    this.simMode = nextSimMode;
    try {
      window.localStorage.setItem(SIM_MODE_STORAGE_KEY, String(this.simMode));
    } catch {
      // Ignore storage access errors
    }
    this.transport.setSimRunning(this.simMode);
    this.hubBridge.setActive(this.usingBrowserRealEngine);
    this.connectStream();
    await this.refresh();
    if (this.simMode) {
      await this.autoConnectSimulatedHub();
    } else {
      for (const c of usbPool.connectedConsoles()) {
        const s = c.lastStatus;
        if (!s) continue;
        const cfg = c.lastConfig;
        const isHub = s.role === 1 || cfg?.role === "hub";
        const label = (s.label || cfg?.timerLabel || (isHub ? "H1" : "T1")).trim();
        const fp = (s.fp || cfg?.fingerprint || "").trim().toUpperCase();
        if (!fp || fp.startsWith("53504B")) continue;
        await this.provisionTimer(isHub ? "hub" : "spoke", label, fp).catch(() => undefined);
      }
    }
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
    action: "toggle-power" | "delete" | "add" | "reset-timers";
    timerId?: number;
    role?: "hub" | "spoke";
    label?: string;
  }): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/sim/timer-action", payload)
    );
    await usbPool.reconcileSimulatedPorts();
    if (payload.action === "reset-timers") {
      await this.autoConnectSimulatedHub();
    }
  }

  public async pollStatusNow(): Promise<void> {
    await this.pollStatus();
  }

  public async resetSession(): Promise<void> {
    this.store.hydrate(await this.transport.request<FullStateResponse>("POST", "/api/session/reset"));
    await enginePersistence.reconcileNow().catch(() => undefined);
  }

  public async resetPilotsToDefault(): Promise<void> {
    this.store.hydrate(await this.transport.request<FullStateResponse>("POST", "/api/pilots/reset"));
    if (this.usingBrowserRealEngine) {
      this.transport.pushHubChannels();
    }
  }

  public async resetTrackToDefault(): Promise<void> {
    this.store.hydrate(await this.transport.request<FullStateResponse>("POST", "/api/track/reset"));
  }

  public async resetStoredData(): Promise<void> {
    await this.wipeApplicationData();
  }

  /**
   * Wipes all saved application state (pilots, track, laps, timing rules, announcer settings,
   * simulator state, and UI preferences) in browser storage and the in-browser engines,
   * restoring clean system defaults.
   */
  public async wipeApplicationData(): Promise<void> {
    const keepSimMode = this.simMode;
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && (k.startsWith("slaprf.") || k === "gate-timer.announcer")) {
          keysToRemove.push(k);
        }
      }
      for (const k of keysToRemove) {
        window.localStorage.removeItem(k);
      }
      window.localStorage.setItem(SIM_MODE_STORAGE_KEY, String(keepSimMode));
    } catch {
      // Ignore storage access errors
    }

    this.hubBridge.setActive(this.usingBrowserRealEngine);

    this.store.clearActiveHistory();
    this.store.resetUiPrefs();

    const state = await this.transport
      .request<FullStateResponse>("POST", "/api/storage/reset")
      .catch(() => null);
    // Clear IndexedDB and store the engines' fresh defaults in one transaction.
    await enginePersistence.wipeAndReconcile().catch((err) => {
      console.error("[storage] wipe failed:", err);
    });
    if (state) {
      this.store.hydrate(state);
    } else {
      await this.refresh();
    }
  }

  /**
   * Exports the full application state (simulator state, real hardware engine state, announcer
   * settings, known timers, and UI preferences) as a JSON-serializable bundle.
   */
  public async exportApplicationData(): Promise<Record<string, unknown>> {
    // Make sure IndexedDB matches the engines before taking the backup (no-op in read-only tabs).
    await enginePersistence.reconcileNow().catch(() => undefined);

    let simData: unknown = null;
    try {
      const rawSim = await this.transport.exportSimStateJson();
      if (rawSim) simData = JSON.parse(rawSim);
    } catch {
      // ignore
    }

    let realData: unknown = null;
    try {
      realData = await this.transport.request<unknown>("GET", "/api/storage/export");
    } catch {
      // ignore
    }

    const clientPrefs: Record<string, unknown> = {};
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (
          k &&
          (k.startsWith("slaprf.") || k === "gate-timer.announcer") &&
          !LEGACY_LOCALSTORAGE_KEYS.includes(k) &&
          k !== LAST_BACKUP_STORAGE_KEY
        ) {
          const val = window.localStorage.getItem(k);
          if (val !== null) {
            try {
              clientPrefs[k] = JSON.parse(val);
            } catch {
              clientPrefs[k] = val;
            }
          }
        }
      }
    } catch {
      // ignore
    }

    return {
      app: "SlapRF",
      version: 1,
      exportedAt: new Date().toISOString(),
      sim: simData,
      real: realData,
      preferences: clientPrefs,
    };
  }

  /**
   * Imports a previously exported JSON application state bundle, restoring simulator state,
   * real hardware engine state, announcer settings, and all UI preferences.
   */
  public async importApplicationData(rawBundle: unknown): Promise<void> {
    if (!rawBundle || typeof rawBundle !== "object") {
      throw new Error("Invalid application data file: expected a JSON object.");
    }
    const bundle = rawBundle as Record<string, unknown>;
    if (bundle.app !== undefined && bundle.app !== "SlapRF") {
      throw new Error("Invalid application data file: not a SlapRF export.");
    }
    if (!("sim" in bundle) && !("real" in bundle) && !("preferences" in bundle)) {
      throw new Error("Invalid application data file: missing state sections.");
    }

    const prefs = bundle.preferences;
    if (prefs && typeof prefs === "object") {
      for (const [k, v] of Object.entries(prefs as Record<string, unknown>)) {
        if (!k.startsWith("slaprf.") && k !== "gate-timer.announcer") continue;
        if (LEGACY_LOCALSTORAGE_KEYS.includes(k) || k === LAST_BACKUP_STORAGE_KEY) continue;
        try {
          if (typeof v === "string") {
            window.localStorage.setItem(k, v);
          } else {
            window.localStorage.setItem(k, JSON.stringify(v));
          }
        } catch {
          // ignore
        }
      }
    }

    if (bundle.sim && typeof bundle.sim === "object") {
      await this.transport.importSimStateJson(JSON.stringify(bundle.sim));
    }

    if (bundle.real && typeof bundle.real === "object") {
      await this.transport.request("POST", "/api/storage/import", bundle.real).catch(() => undefined);
    }

    // Persist the imported engines to IndexedDB now (one transaction), not on the next debounce.
    await enginePersistence.reconcileNow().catch((err) => {
      console.error("[storage] saving imported state failed:", err);
    });

    try {
      const savedMode = window.localStorage.getItem(SIM_MODE_STORAGE_KEY);
      const nextSimMode = savedMode !== "false";
      if (nextSimMode !== this.simMode) {
        this.transport.disconnectStream();
        this.simMode = nextSimMode;
      }
      this.transport.setSimRunning(this.simMode);
      this.hubBridge.setActive(this.usingBrowserRealEngine);
      this.connectStream();
    } catch {
      // ignore
    }

    this.store.clearActiveHistory();
    this.store.reloadUiPrefs();
    await this.refresh();
  }

  public async updatePilotSlot(slot: PilotSlot): Promise<void> {
    this.store.hydrate(await this.transport.request<FullStateResponse>("POST", "/api/pilots/update", slot));
    if (this.usingBrowserRealEngine) {
      this.transport.pushHubChannels();
    }
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

  public async deleteTimer(timerId: number, fingerprint?: string, timerLabel?: string): Promise<void> {
    forgetKnownHardwareTimer(fingerprint, timerLabel);
    if (this.store.detectedTimers.some((d) => d.timerId === timerId)) {
      const usb = usbPool.primaryConsole();
      if (usb.lastStatus && fingerprint && usb.lastStatus.fp?.toUpperCase() === fingerprint.toUpperCase()) {
        this.store.setUsbDetectedTimer(null);
      }
    }
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/timers/delete", { timerId })
    );
    await enginePersistence.reconcileNow().catch(() => undefined);
  }

  /** Registers a newly flashed timer (hub or spoke) with its name and board fingerprint. */
  public async provisionTimer(
    role: "hub" | "spoke",
    timerLabel: string,
    fingerprint = ""
  ): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/timers/provision", {
        role,
        timerLabel,
        fingerprint,
      })
    );
  }

  /**
   * Builds or patches a pre-configured XIAO ESP32-C5 firmware binary stamped with role, name,
   * board fingerprint & active channels, 100% client-side in the browser from the static
   * `./firmware/slaprf-xiao-c5.bin` image.
   */
  public async fetchFirmwareImage(
    role: "hub" | "spoke",
    timerLabel = "",
    fingerprint = generateFingerprint()
  ): Promise<{ bytes: Uint8Array; sha256: string; filename: string }> {
    const freqs = this.store.pilots.slice(0, 8).map((p) => p.frequencyMhz);
    const built = await buildOrPatchFirmwareBin({
      role,
      timerLabel,
      fingerprint,
      frequenciesMHz: freqs,
    });
    return { bytes: built.bytes, sha256: "", filename: built.filename };
  }

  /**
   * Current state of the active timing engine. Used by the Debug page for pilot thresholds,
   * timer status, and frame-rate checks.
   */
  public async getRealEngineState(): Promise<FullStateResponse | null> {
    try {
      return await this.transport.request<FullStateResponse>("GET", "/api/state");
    } catch {
      return null;
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

  /** Retrieves the WASM engine's build version info (release tag, commit hash, branch name). */
  public async getVersionInfo(): Promise<{ release_tag: string; commit_hash: string; branch_name: string }> {
    return await this.transport.request<{ release_tag: string; commit_hash: string; branch_name: string }>("GET", "/api/version");
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
