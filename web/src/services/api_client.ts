import { AppStore } from "../state/store";
import {
  BracketEditPayload,
  DetectedTimer,
  EventActionPayload,
  EventManagerState,
  FilteredDetection,
  FullStateResponse,
  GateCrossingEvent,
  GateRuleOverrides,
  GateThresholdUpdate,
  GateUpdate,
  isSlapRFMode,
  LapRecord,
  MultiGPRaceEntry,
  MultiGPRaceViewData,
  MultiGPScheduleRound,
  MultiGPSyncPlan,
  OperatingMode,
  PilotCSVImportSummary,
  PilotSlot,
  PilotTrackSummary,
  PracticeActionPayload,
  PracticeManagerState,
  RaceAnnouncement,
  RaceMarshalPayload,
  RaceSetupConfig,
  RaceTournamentState,
  SimMultiGPAdminAction,
  SimMultiGPState,
  StageControlAction,
  StatusResponse,
  StreamEnvelope,
  TimerTelemetryFrame,
  TimingHardwareMode,
  TimingRules,
  TrackNode,
  TrackScope,
} from "../types/models";
import { BackendHttpTransport } from "./backend_transport";
import { BrowserHubBridge } from "./browser_hub_bridge";
import {
  BACKEND_RECENT_STORAGE_KEY,
  BACKEND_URL_STORAGE_KEY,
  capabilitiesSnapshot,
  clearBackendConnectionLost,
  connectToBackend,
  enterDisconnectedServerSettingsMode,
  isServerDisconnectedLockout,
  openBackendConnectModal,
  probeServerReachable,
  reportBackendConnectionLost,
} from "./capabilities";
import { enginePersistence, LAST_BACKUP_STORAGE_KEY, LEGACY_LOCALSTORAGE_KEYS } from "./engine_persistence";
import {
  buildOrPatchFirmwareBin,
  generateFingerprint,
  HubLink,
  LATEST_FIRMWARE_VERSION,
} from "./esp_flasher";
import { bindSimSerialStore, bindSimTimerActionHandler, isSimulatedSerialPort } from "./sim_serial_port";
import { forgetKnownHardwareTimer, TimerConsole, TimerStatus, usbPool } from "./timer_console";
import { ApiTransport } from "./transport";
import { WasmSimTransport } from "./wasm_transport";

interface LapPayload {
  lap: LapRecord;
  summaries: PilotTrackSummary[];
}

interface ConfigPayload {
  pilots: PilotSlot[];
  gates: TrackNode[];
  timers?: DetectedTimer[];
}

interface RacePayload {
  serverTimestampUs?: number;
  raceState: RaceTournamentState;
  eventState?: EventManagerState | null;
  announcement?: RaceAnnouncement | null;
}

const STATUS_POLL_MS = 2000;
const SIM_MODE_STORAGE_KEY = "slaprf.ui.sim_mode.v1";

/**
 * REST + real-time stream client:
 * - Native Go Backend mode (`caps.portable === true`): Thin UI client talking to the local or LAN
 *   `slaprf` Go binary over HTTP REST (`/v1/*`) + `/v1/ws/stream` (`BackendHttpTransport`). Zero WASM and
 *   zero browser IndexedDB are used; all timing engines, `bbolt` storage, and hardware links run in Go.
 * - Standalone Browser Demo mode (`caps.demoMode === true`): Runs strictly in Simulation Mode
 *   using `WasmSimTransport` (`slaprf.wasm` + `IndexedDB`) to showcase all simulated capabilities.
 */
export class ApiClient {
  private readonly store: AppStore;
  private transport: ApiTransport;
  private backendMode: boolean;
  public readonly hubBridge: BrowserHubBridge;
  private simMode = true;
  private readonly provisionedUsbKeys = new Set<string>();
  private hubRefreshTimer: number | null = null;
  private viewingRaceId = "";

  public setViewingRaceId(raceId: string): void {
    this.viewingRaceId = raceId.trim();
  }

  public getViewingRaceId(): string {
    return this.viewingRaceId;
  }

  private resolveRaceFromStore(raceId?: string): RaceTournamentState {
    const tid = (raceId || this.viewingRaceId || "").trim();
    if (tid) {
      if (this.store.raceState.raceId === tid) return this.store.raceState;
      const found = this.store.races.find((r) => r.raceId === tid);
      if (found) return found;
    }
    return this.store.raceState;
  }

  constructor(store: AppStore) {
    this.store = store;
    bindSimSerialStore(this.store);
    bindSimTimerActionHandler((payload) => this.simTimerAction(payload));

    const caps = capabilitiesSnapshot();
    this.backendMode = caps.portable;

    if (this.backendMode) {
      const bt = new BackendHttpTransport(caps.backendBaseUrl);
      bt.onStreamReconnected = () => {
        clearBackendConnectionLost();
        void this.refresh().catch(() => undefined);
      };
      bt.onConnectionLost = () => {
        if (!isServerDisconnectedLockout()) {
          reportBackendConnectionLost(
            caps.backendBaseUrl || (typeof window !== "undefined" ? window.location.origin : "")
          );
        }
      };
      this.transport = bt;
      this.hubBridge = new BrowserHubBridge(null);
    } else {
      const wt = new WasmSimTransport();
      this.transport = wt;
      this.hubBridge = new BrowserHubBridge(wt);
      // Standalone Browser Demo Mode runs with Simulation ON unless locked in disconnected Server mode.
      const runDemoNow = !isServerDisconnectedLockout();
      this.simMode = runDemoNow;
      try {
        window.localStorage.setItem(SIM_MODE_STORAGE_KEY, String(runDemoNow));
      } catch {
        // Ignore storage access errors
      }
      wt.setSimRunning(runDemoNow);
    }

    this.hubBridge.onPacketIngested = () => {
      if (this.hubRefreshTimer !== null) return;
      this.hubRefreshTimer = window.setTimeout(() => {
        this.hubRefreshTimer = null;
        void this.pollStatus();
      }, 250);
    };
  }

  /** True when Real-world hardware mode is active. */
  public get usingBrowserRealEngine(): boolean {
    return !this.simMode;
  }

  private async persistBrowserEnginesIfDemo(): Promise<void> {
    if (this.backendMode) return;
    await enginePersistence.reconcileNow().catch(() => undefined);
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

    if (!this.backendMode) {
      await this.transport.setSimRunning(!isServerDisconnectedLockout());
    }
    this.hubBridge.setActive(true);
    this.bindUsbTimerSync();
    await this.refresh();

    if (this.backendMode) {
      this.simMode = this.store.simulatorRunning;
      try {
        window.localStorage.setItem(SIM_MODE_STORAGE_KEY, String(this.simMode));
      } catch {
        // Ignore storage access errors
      }
    }

    this.connectStream();
    await usbPool.attachBackendMode(this.simMode);
    if (this.simMode) {
      await usbPool.restorePersistedSimPorts();
    }

    window.setInterval(() => {
      void this.pollStatus();
    }, STATUS_POLL_MS);
  }

  public bindUsbTimerSync(): void {
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
    this.store.hydrate(await this.transport.request<FullStateResponse>("GET", "/v1/state"));
  }

  /**
   * Probes the SlapRF Server and restores live HTTP + WebSocket state when the user clicks
   * `Try Reconnecting` on the connection-lost loading screen.
   */
  public async reconnectBackendNow(baseUrl?: string): Promise<boolean> {
    const targetUrl = (baseUrl ?? capabilitiesSnapshot().backendBaseUrl ?? "").trim();
    const sameOrigin =
      !targetUrl ||
      (typeof window !== "undefined" &&
        targetUrl.toLowerCase() === window.location.origin.toLowerCase());
    const caps = await probeServerReachable(sameOrigin ? "" : targetUrl, 2200);
    if (!caps) {
      return false;
    }
    if (!this.backendMode) {
      await connectToBackend(targetUrl || window.location.origin);
      return true;
    }
    if (this.transport instanceof BackendHttpTransport) {
      this.transport.setPaused(false);
    }
    clearBackendConnectionLost();
    await this.refresh();
    this.connectStream();
    return true;
  }

  /**
   * Pauses failed server polling and enters the disconnected `Server` Settings lockout so the
   * user can adjust connection settings or switch to `Demo` without hitting a dead reload.
   */
  public enterDisconnectedSettingsFromOutage(): void {
    if (this.transport instanceof BackendHttpTransport) {
      this.transport.setPaused(true);
    }
    this.simMode = false;
    enterDisconnectedServerSettingsMode();
  }

  /**
   * Ensures in-browser WASM Demo Simulation is running when the user switches Datasource back
   * from disconnected `Server` mode to `Demo` mode.
   */
  public async ensureDemoModeActive(): Promise<void> {
    if (this.backendMode) {
      if (this.transport instanceof BackendHttpTransport) {
        this.transport.setPaused(true);
      }
      const wt = new WasmSimTransport();
      this.transport = wt;
      this.backendMode = false;
    }
    this.simMode = true;
    try {
      window.localStorage.setItem(SIM_MODE_STORAGE_KEY, "true");
    } catch {
      // ignore
    }
    await this.transport.setSimRunning(true);
    await this.refresh();
    this.connectStream();
  }

  /**
   * Synchronizes the live UI store and IndexedDB persistence after a direct in-browser WASM HTTP
   * mutation invoked via `window.slaprfCurl(...)` (Playwright / CDP test harness or DevTools).
   */
  public async syncAfterDirectWasmCall(
    method: string,
    url: string,
    status: number,
    parsedJson: unknown
  ): Promise<void> {
    if (status < 200 || status >= 300 || method.toUpperCase() === "GET") {
      return;
    }
    if (
      (url === "/v1/sim" || url.startsWith("/v1/sim?")) &&
      parsedJson &&
      typeof parsedJson === "object" &&
      typeof (parsedJson as { simulatorRunning?: unknown }).simulatorRunning === "boolean"
    ) {
      const nextSim = (parsedJson as { simulatorRunning: boolean }).simulatorRunning;
      this.simMode = nextSim;
      try {
        window.localStorage.setItem(SIM_MODE_STORAGE_KEY, String(this.simMode));
      } catch {
        // Ignore storage access errors
      }
      if (!this.backendMode) {
        await this.transport.setSimRunning(this.simMode);
      }
      await usbPool.attachBackendMode(this.simMode);
    }
    if (!this.backendMode) {
      enginePersistence.notePost();
    }
    await this.refresh();
  }

  public async toggleSimulator(): Promise<void> {
    if (capabilitiesSnapshot().demoMode) {
      openBackendConnectModal("real-hardware");
      return;
    }
    const nextSimMode = !this.simMode;
    this.simMode = nextSimMode;
    try {
      window.localStorage.setItem(SIM_MODE_STORAGE_KEY, String(this.simMode));
    } catch {
      // Ignore storage access errors
    }
    if (!this.backendMode) {
      this.transport.disconnectStream();
    }
    await this.transport.setSimRunning(this.simMode);
    this.hubBridge.setActive(true);
    if (!this.backendMode) {
      this.connectStream();
    }
    await this.refresh();
    await usbPool.attachBackendMode(this.simMode);
    if (this.simMode) {
      await usbPool.suspendRealAndRestoreSim();
    } else {
      await usbPool.suspendSimAndRestoreReal();
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
    this.store.applyStatus(
      await this.transport.request<StatusResponse>("PUT", "/v1/timing/arm", {
        armed: !this.store.raceArmed,
      })
    );
  }

  public async simulatePack(): Promise<void> {
    this.store.hydrate(await this.transport.request<FullStateResponse>("POST", "/v1/sim:packBurst", {}));
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
      await this.transport.request<FullStateResponse>("POST", `/v1/sim/pilots/${slotIndex}:action`, { action })
    );
  }

  public async setTrackWalker(active: boolean): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("PATCH", "/v1/sim", { trackWalker: active })
    );
  }

  public async setSimSpeed(speedMultiplier: number): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("PATCH", "/v1/sim", { speedMultiplier })
    );
    await this.persistBrowserEnginesIfDemo();
  }

  public async simTimerAction(payload: {
    action: "toggle-power" | "delete" | "add" | "reset-timers" | "erase" | "flash";
    timerId?: number;
    role?: "hub" | "spoke" | "unflashed";
    label?: string;
    fingerprint?: string;
    firmwareVersion?: string;
  }): Promise<void> {
    let state: FullStateResponse;
    switch (payload.action) {
      case "add":
        state = await this.transport.request<FullStateResponse>("POST", "/v1/sim/slaprf/timers", {
          role: payload.role,
          label: payload.label,
        });
        break;
      case "reset-timers":
        state = await this.transport.request<FullStateResponse>("POST", "/v1/sim/slaprf/timers:reset", {});
        break;
      case "delete":
        state = await this.transport.request<FullStateResponse>(
          "DELETE",
          `/v1/sim/slaprf/timers/${payload.timerId ?? 0}`
        );
        break;
      default:
        state = await this.transport.request<FullStateResponse>(
          "POST",
          `/v1/sim/slaprf/timers/${payload.timerId ?? 0}:action`,
          payload
        );
        break;
    }
    this.store.hydrate(state);
    await usbPool.reconcileSimulatedPorts();
  }

  public async pollStatusNow(): Promise<void> {
    await this.pollStatus();
  }

  public async resetSession(): Promise<void> {
    this.store.hydrate(await this.transport.request<FullStateResponse>("POST", "/v1/practice:reset", {}));
    await this.persistBrowserEnginesIfDemo();
  }

  public async resetPilotsToDefault(): Promise<void> {
    this.store.hydrate(await this.transport.request<FullStateResponse>("POST", "/v1/pilots:reset", {}));
    this.transport.pushHubChannels();
  }

  public async resetTrackToDefault(scope?: TrackScope | null): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", `${this.resolveTrackBaseUrl(scope)}:reset`, {})
    );
  }

  public async resetStoredData(): Promise<void> {
    await this.wipeApplicationData();
  }

  /**
   * Wipes all saved application state (pilots, track, laps, timing rules, announcer settings,
   * simulator state, and UI preferences) in storage and the active engines,
   * restoring clean system defaults while keeping any remote backend connection settings.
   */
  public async wipeApplicationData(): Promise<void> {
    const keepSimMode = this.backendMode ? this.simMode : true;
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (
          k &&
          (k.startsWith("slaprf.") || k === "gate-timer.announcer") &&
          k !== BACKEND_URL_STORAGE_KEY &&
          k !== BACKEND_RECENT_STORAGE_KEY
        ) {
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

    this.hubBridge.setActive(true);

    this.store.clearActiveHistory();
    this.store.resetUiPrefs();

    const state = await this.transport
      .request<FullStateResponse>("POST", "/v1/storage:reset", {})
      .catch(() => null);
    if (!this.backendMode) {
      // Clear IndexedDB and store the engines' fresh defaults in one transaction.
      await enginePersistence.wipeAndReconcile().catch((err) => {
        console.error("[storage] wipe failed:", err);
      });
    }
    if (state) {
      this.store.hydrate(state);
    } else {
      await this.refresh();
    }
    this.store.setLiveFocus(null);
  }

  /**
   * Populates the active engine with the showcase demo dataset (Bay Area pilots, 3-gate SlapRF
   * track with Hub H1 + 3 Spoke timers, 3 practice sessions, and 4 tournaments).
   */
  public async restoreDemoData(): Promise<void> {
    this.store.clearActiveHistory();
    const state = await this.transport
      .request<FullStateResponse>("POST", "/v1/storage:restoreDemo", {})
      .catch(() => null);
    if (state) {
      this.store.hydrate(state);
    } else {
      await this.refresh();
    }
    this.store.setLiveFocus(null);
    if (this.simMode && isSlapRFMode(this.store.timingHardwareMode)) {
      await usbPool.connectDefaultSimHub();
      await this.refresh();
    }
    if (!this.backendMode) {
      await enginePersistence.reconcile(true, true).catch((err) => {
        console.error("[storage] demo restore persist failed:", err);
      });
    }
  }

  /**
   * Exports the full application state (simulator state, real hardware engine state, announcer
   * settings, known timers, and UI preferences) as a JSON-serializable bundle.
   */
  public async exportApplicationData(): Promise<Record<string, unknown>> {
    await this.persistBrowserEnginesIfDemo();

    let simData: unknown = null;
    try {
      const rawSim = await this.transport.exportSimStateJson();
      if (rawSim) simData = JSON.parse(rawSim);
    } catch {
      // ignore
    }

    let realData: unknown = null;
    try {
      realData = await this.transport.request<unknown>("GET", "/v1/storage");
    } catch {
      // ignore
    }

    if (this.backendMode) {
      await this.transport.request("POST", "/v1/storage:recordBackup", {}).catch(() => undefined);
    }

    const clientPrefs: Record<string, unknown> = {};
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (
          k &&
          (k.startsWith("slaprf.") || k === "gate-timer.announcer") &&
          !LEGACY_LOCALSTORAGE_KEYS.includes(k) &&
          k !== LAST_BACKUP_STORAGE_KEY &&
          k !== BACKEND_URL_STORAGE_KEY &&
          k !== BACKEND_RECENT_STORAGE_KEY
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
        if (
          LEGACY_LOCALSTORAGE_KEYS.includes(k) ||
          k === LAST_BACKUP_STORAGE_KEY ||
          k === BACKEND_URL_STORAGE_KEY ||
          k === BACKEND_RECENT_STORAGE_KEY
        ) {
          continue;
        }
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
      await this.transport.request("PUT", "/v1/storage", bundle.real).catch(() => undefined);
    }

    await this.persistBrowserEnginesIfDemo();

    try {
      const savedMode = window.localStorage.getItem(SIM_MODE_STORAGE_KEY);
      const nextSimMode = this.backendMode ? savedMode !== "false" : true;
      if (!this.backendMode) {
        window.localStorage.setItem(SIM_MODE_STORAGE_KEY, "true");
      }
      if (nextSimMode !== this.simMode) {
        if (!this.backendMode) {
          this.transport.disconnectStream();
        }
        this.simMode = nextSimMode;
      }
      await this.transport.setSimRunning(this.simMode);
      await usbPool.attachBackendMode(this.simMode);
      this.hubBridge.setActive(true);
      if (!this.backendMode) {
        this.connectStream();
      }
    } catch {
      // ignore
    }

    this.store.clearActiveHistory();
    this.store.reloadUiPrefs();
    await this.refresh();
  }

  public async getLogsConfig(): Promise<{
    logPath: string;
    sizeBytes: number;
    level: string;
    levels?: string[];
    lineCount: number;
    maxLines?: number;
  }> {
    return await this.transport.request("GET", "/v1/logs/config");
  }

  public async setLogLevel(level: string): Promise<{
    logPath: string;
    sizeBytes: number;
    level: string;
    levels?: string[];
    lineCount: number;
    maxLines?: number;
  }> {
    return await this.transport.request("PUT", "/v1/logs/config", { level });
  }

  public async clearLogs(): Promise<{
    logPath: string;
    sizeBytes: number;
    level: string;
    levels?: string[];
    lineCount: number;
    maxLines?: number;
  }> {
    return await this.transport.request("POST", "/v1/logs:clear", {});
  }

  public async downloadLogsText(): Promise<string> {
    if (this.transport.requestText) {
      return await this.transport.requestText("GET", "/v1/logs?format=text");
    }
    const resp = await this.transport.request<{ lines?: string[] }>("GET", "/v1/logs?tail=1000");
    return resp.lines && resp.lines.length > 0 ? resp.lines.join("\n") + "\n" : "";
  }

  public async updatePilotSlot(slot: PilotSlot): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("PUT", `/v1/pilots/${slot.slotIndex}`, slot)
    );
    this.transport.pushHubChannels();
  }

  public async addPilot(callsign = "", phoneticName = ""): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/v1/pilots", {
        callsign,
        phoneticName,
      })
    );
    this.transport.pushHubChannels();
  }

  public async removePilot(slotIndex: number): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("DELETE", `/v1/pilots/${slotIndex}`)
    );
    this.transport.pushHubChannels();
  }

  public async downloadPilotsRosterCsv(fallbackName = "slaprf-pilots.csv"): Promise<string> {
    const url = "/v1/pilots/export.csv";
    const csvText = this.transport.requestText
      ? await this.transport.requestText("GET", url)
      : await fetch(url).then(async (r) => {
          if (!r.ok) throw new Error(await r.text());
          return r.text();
        });
    const safeBase = fallbackName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const filename = safeBase.endsWith(".csv") ? safeBase : `${safeBase || "slaprf-pilots"}.csv`;
    const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 2500);
    return csvText;
  }

  public async importPilotsRosterCsv(csv: string): Promise<PilotCSVImportSummary> {
    const res = await this.transport.request<FullStateResponse>("POST", "/v1/pilots:import", { csv });
    this.store.hydrate(res);
    this.transport.pushHubChannels();
    return (
      res.importSummary ?? {
        added: 0,
        updated: 0,
        total: this.store.pilots.length,
      }
    );
  }

  public async setOperatingMode(mode: OperatingMode): Promise<void> {
    this.store.hydrate(await this.transport.request<FullStateResponse>("PUT", "/v1/timing/mode", { mode }));
    this.transport.pushHubChannels();
  }

  private resolveTargetRaceSessionId(explicitRaceId?: string): string {
    return (explicitRaceId || this.viewingRaceId || this.store.raceState.raceId || "current").trim() || "current";
  }

  private resolveTargetPracticeSessionId(explicitSessionId?: string): string {
    return (
      explicitSessionId ||
      this.store.practiceState.selectedSessionId ||
      this.store.practiceState.activeSessionId ||
      "current"
    ).trim() || "current";
  }

  public async configureRace(
    config: RaceSetupConfig,
    generate: boolean,
    applyToExisting = false,
    raceId?: string
  ): Promise<void> {
    const targetRaceId = (raceId || this.viewingRaceId || "").trim();
    const sid = encodeURIComponent(targetRaceId || "current");
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("PUT", `/v1/race/sessions/${sid}/config`, {
        config,
        generate,
        applyToExisting,
      })
    );
    this.transport.pushHubChannels();
  }

  public async advanceRaceStage2(): Promise<void> {
    const sid = encodeURIComponent(this.resolveTargetRaceSessionId());
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", `/v1/race/sessions/${sid}/stages/current:advance`, {})
    );
    this.transport.pushHubChannels();
  }

  public async raceControl(
    action: string,
    heatId = "",
    raceId?: string,
    preemptOngoing = false
  ): Promise<void> {
    const targetRaceId = (raceId || this.viewingRaceId || "").trim();
    const sid = encodeURIComponent(targetRaceId || "current");
    const hid = encodeURIComponent(heatId.trim() || "current");
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", `/v1/race/sessions/${sid}/heats/${hid}:control`, {
        action,
        ...(preemptOngoing ? { preemptOngoing: true } : {}),
      })
    );
    this.transport.pushHubChannels();
  }

  public async raceMarshal(payload: RaceMarshalPayload): Promise<void> {
    const targetRaceId = (payload.raceId || this.viewingRaceId || "").trim();
    const sid = encodeURIComponent(targetRaceId || "current");
    const hid = encodeURIComponent((payload.heatId || "").trim() || "current");
    this.store.hydrate(
      await this.transport.request<FullStateResponse>(
        "POST",
        `/v1/race/sessions/${sid}/heats/${hid}/pilots/${payload.pilotSlotIndex}:marshal`,
        payload
      )
    );
    this.transport.pushHubChannels();
  }

  public async eventAction(payload: EventActionPayload): Promise<void> {
    const targetRaceId = (payload.raceId || this.viewingRaceId || "").trim();
    const sid = encodeURIComponent(targetRaceId || "current");
    let state: FullStateResponse;

    switch (payload.action) {
      case "create_race":
        state = await this.transport.request<FullStateResponse>("POST", "/v1/race/sessions", {
          name: payload.name,
          tags: payload.tags,
          copyConfig: payload.copyConfig,
          dontSelect: payload.dontSelect,
        });
        break;
      case "delete_race":
        state = await this.transport.request<FullStateResponse>(
          "DELETE",
          `/v1/race/sessions/${encodeURIComponent((payload.raceId || "").trim() || "current")}`
        );
        break;
      case "select_race":
        state = await this.transport.request<FullStateResponse>(
          "PATCH",
          `/v1/race/sessions/${encodeURIComponent((payload.raceId || "").trim() || "current")}`,
          { selected: true }
        );
        break;
      case "rename_race":
        state = await this.transport.request<FullStateResponse>("PATCH", `/v1/race/sessions/${sid}`, {
          name: payload.name ?? "",
        });
        break;
      case "set_race_tags":
        state = await this.transport.request<FullStateResponse>("PATCH", `/v1/race/sessions/${sid}`, {
          tags: payload.tags ?? [],
        });
        break;
      case "race_lifecycle": {
        const verbMap: Record<string, string> = {
          start_race: "start",
          pause_race: "pause",
          resume_race: "resume",
          stop_race: "stop",
          emergency_stop: "stop",
          complete_race: "complete",
          scrap_race: "scrap",
          reopen_race: "reopen",
        };
        const verb = verbMap[payload.lifecycleAction || ""] || (payload.lifecycleAction || "start").replace(/_race$/, "");
        state = await this.transport.request<FullStateResponse>("POST", `/v1/race/sessions/${sid}:${verb}`, {
          reason: payload.reason,
          preemptOngoing: payload.preemptOngoing,
        });
        break;
      }
      case "add_event_pilot":
      case "add_race_pilot":
        state = await this.transport.request<FullStateResponse>(
          "POST",
          `/v1/race/sessions/${sid}/pilots`,
          {
            slotIndex: payload.slotIndex,
            callsign: payload.callsign,
            phoneticName: payload.phoneticName,
          }
        );
        break;
      case "check_in_all":
        state = await this.transport.request<FullStateResponse>(
          "POST",
          `/v1/race/sessions/${sid}/pilots:checkInAll`,
          {}
        );
        break;
      case "update_attendance":
        state = await this.transport.request<FullStateResponse>(
          "PATCH",
          `/v1/race/sessions/${sid}/pilots/${payload.slotIndex ?? 0}`,
          {
            checkedIn: payload.checkedIn,
            attendance: payload.attendance,
            pilotNote: payload.pilotNote,
          }
        );
        break;
      case "stage_control": {
        const stageRef =
          payload.stageIndex && payload.stageIndex > 0
            ? String(payload.stageIndex)
            : (payload.stageId || "current").trim() || "current";
        state = await this.transport.request<FullStateResponse>(
          "POST",
          `/v1/race/sessions/${sid}/stages/${encodeURIComponent(stageRef)}:control`,
          {
            stageAction: payload.stageAction,
            stageId: payload.stageId,
          }
        );
        break;
      }
      default:
        throw new Error(`Unsupported race session action: ${String(payload.action)}`);
    }

    this.store.hydrate(state);
    this.transport.pushHubChannels();
  }

  public async stageControl(
    stageAction: StageControlAction,
    stageIndex?: number,
    stageId?: string,
    raceId?: string
  ): Promise<void> {
    await this.eventAction({
      action: "stage_control",
      raceId: raceId || this.viewingRaceId || undefined,
      stageAction,
      stageIndex,
      stageId,
    });
  }

  public async practiceAction(payload: PracticeActionPayload): Promise<void> {
    const sid = encodeURIComponent(this.resolveTargetPracticeSessionId(payload.sessionId));
    let state: FullStateResponse;

    switch (payload.action) {
      case "create_session":
        state = await this.transport.request<FullStateResponse>("POST", "/v1/practice/sessions", {
          name: payload.name,
          tags: payload.tags,
          dontSelect: payload.dontSelect,
        });
        break;
      case "delete_session":
        state = await this.transport.request<FullStateResponse>(
          "DELETE",
          `/v1/practice/sessions/${encodeURIComponent((payload.sessionId || "").trim() || "current")}`
        );
        break;
      case "select_session":
        state = await this.transport.request<FullStateResponse>(
          "PATCH",
          `/v1/practice/sessions/${encodeURIComponent((payload.sessionId || "").trim() || "current")}`,
          { selected: true }
        );
        break;
      case "rename_session":
        state = await this.transport.request<FullStateResponse>("PATCH", `/v1/practice/sessions/${sid}`, {
          name: payload.name ?? "",
        });
        break;
      case "set_session_tags":
        state = await this.transport.request<FullStateResponse>("PATCH", `/v1/practice/sessions/${sid}`, {
          tags: payload.tags ?? [],
        });
        break;
      case "start_session":
        state = await this.transport.request<FullStateResponse>("POST", `/v1/practice/sessions/${sid}:start`, {
          preemptOngoing: payload.preemptOngoing,
        });
        break;
      case "resume_session":
        state = await this.transport.request<FullStateResponse>("POST", `/v1/practice/sessions/${sid}:resume`, {
          preemptOngoing: payload.preemptOngoing,
        });
        break;
      case "pause_session":
        state = await this.transport.request<FullStateResponse>("POST", `/v1/practice/sessions/${sid}:pause`, {});
        break;
      case "stop_session":
        state = await this.transport.request<FullStateResponse>("POST", `/v1/practice/sessions/${sid}:stop`, {});
        break;
      case "add_session_pilot":
        state = await this.transport.request<FullStateResponse>(
          "POST",
          `/v1/practice/sessions/${sid}/pilots`,
          {
            slotIndex: payload.slotIndex,
            callsign: payload.callsign,
            phoneticName: payload.phoneticName,
            band: payload.band,
            channel: payload.channel,
          }
        );
        break;
      case "set_session_pilot_channel":
        state = await this.transport.request<FullStateResponse>(
          "PUT",
          `/v1/practice/sessions/${sid}/pilots/${payload.slotIndex ?? 0}`,
          {
            band: payload.band,
            channel: payload.channel ?? 0,
          }
        );
        break;
      case "remove_session_pilot":
        state = await this.transport.request<FullStateResponse>(
          "DELETE",
          `/v1/practice/sessions/${sid}/pilots/${payload.slotIndex ?? 0}`
        );
        break;
      case "clear_session_laps":
        state = await this.transport.request<FullStateResponse>(
          "POST",
          `/v1/practice/sessions/${sid}:clearLaps`,
          {}
        );
        break;
      case "clear_pilot_laps":
        state = await this.transport.request<FullStateResponse>(
          "DELETE",
          `/v1/practice/sessions/${sid}/laps?slotIndex=${encodeURIComponent(String(payload.slotIndex ?? 0))}`
        );
        break;
      case "toggle_session_lap":
        state = await this.transport.request<FullStateResponse>(
          "POST",
          `/v1/practice/sessions/${sid}/laps/${payload.lapId ?? 0}:toggle`,
          {}
        );
        break;
      case "delete_session_lap":
        state = await this.transport.request<FullStateResponse>(
          "DELETE",
          `/v1/practice/sessions/${sid}/laps/${payload.lapId ?? 0}`
        );
        break;
      default:
        throw new Error(`Unsupported practice session action: ${String(payload.action)}`);
    }

    this.store.hydrate(state);
    this.transport.pushHubChannels();
  }

  public async bracketEdit(payload: BracketEditPayload): Promise<RaceTournamentState> {
    const targetRaceId = (payload.raceId || this.viewingRaceId || "").trim();
    const sid = encodeURIComponent(targetRaceId || "current");
    this.store.hydrate(
      await this.transport.request<FullStateResponse>(
        "POST",
        `/v1/race/sessions/${sid}/bracket:edit`,
        payload
      )
    );
    this.transport.pushHubChannels();
    return this.resolveRaceFromStore(targetRaceId);
  }

  public async downloadRaceResultsCsv(
    raceId = "",
    stageIndex = 0,
    fallbackName = "slaprf-qualifier-results.csv"
  ): Promise<string> {
    const params = new URLSearchParams();
    if (stageIndex > 0) params.set("stageIndex", String(stageIndex));
    const qs = params.toString();
    const cleanRaceId = raceId.trim();
    const basePath = cleanRaceId
      ? `/v1/race/sessions/${encodeURIComponent(cleanRaceId)}/standings.csv`
      : "/v1/race/standings.csv";
    const url = `${basePath}${qs ? `?${qs}` : ""}`;
    const csvText = this.transport.requestText
      ? await this.transport.requestText("GET", url)
      : await fetch(url).then(async (r) => {
          if (!r.ok) throw new Error(await r.text());
          return r.text();
        });
    const safeBase = fallbackName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const filename = safeBase.endsWith(".csv") ? safeBase : `${safeBase || "slaprf-qualifier-results"}.csv`;
    const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 2500);
    return csvText;
  }

  public async tickRaceClock(): Promise<void> {
    const snap = await this.transport.request<RaceTournamentState>("GET", "/v1/race/clock");
    this.store.ingestRace(snap, null, null);
  }

  private _scopeResolver?: () => TrackScope | null;

  /** Returns a lightweight view of `ApiClient` whose track and timing-rule calls target `resolver()`. */
  public forScope(resolver: () => TrackScope | null): ApiClient {
    const scoped = Object.create(this) as ApiClient;
    Object.defineProperty(scoped, "_scopeResolver", {
      value: resolver,
      enumerable: false,
    });
    return scoped;
  }

  private resolveSessionBaseUrl(explicitScope?: TrackScope | null): string {
    const scope = explicitScope ?? this._scopeResolver?.() ?? null;
    if (scope && scope.id) {
      return `/v1/${scope.kind}/sessions/${encodeURIComponent(scope.id)}`;
    }
    const selSess = this.store.selectedPracticeSession;
    if (selSess?.sessionId) {
      return `/v1/practice/sessions/${encodeURIComponent(selSess.sessionId)}`;
    }
    const rid = this.viewingRaceId || this.store.raceState.raceId || this.store.eventState.activeRaceId;
    if (rid) {
      return `/v1/race/sessions/${encodeURIComponent(rid)}`;
    }
    return `/v1/practice/sessions/current`;
  }

  private resolveTrackBaseUrl(explicitScope?: TrackScope | null): string {
    return `${this.resolveSessionBaseUrl(explicitScope)}/track`;
  }

  public async addCrossing(
    gateId: number,
    slotIndex: number,
    timestampUs: number,
    peakRssiDbm?: number,
    scope?: TrackScope | null
  ): Promise<void> {
    const body: { gateId: number; slotIndex: number; timestampUs: number; peakRssiDbm?: number } = {
      gateId: Math.round(gateId),
      slotIndex: Math.round(slotIndex),
      timestampUs: Math.round(timestampUs),
    };
    if (typeof peakRssiDbm === "number" && Number.isFinite(peakRssiDbm)) {
      body.peakRssiDbm = Math.round(peakRssiDbm * 100) / 100;
    }
    this.store.hydrate(
      await this.transport.request<FullStateResponse>(
        "POST",
        `${this.resolveSessionBaseUrl(scope)}/crossings`,
        body
      )
    );
  }

  public async adjustCrossing(
    eventId: number,
    timestampUs: number,
    peakRssiDbm?: number,
    scope?: TrackScope | null
  ): Promise<void> {
    const body: { timestampUs: number; peakRssiDbm?: number } = {
      timestampUs: Math.round(timestampUs),
    };
    if (typeof peakRssiDbm === "number" && Number.isFinite(peakRssiDbm)) {
      body.peakRssiDbm = Math.round(peakRssiDbm * 100) / 100;
    }
    this.store.hydrate(
      await this.transport.request<FullStateResponse>(
        "PATCH",
        `${this.resolveSessionBaseUrl(scope)}/crossings/${encodeURIComponent(String(eventId))}`,
        body
      )
    );
  }

  public async deleteCrossing(eventId: number, scope?: TrackScope | null): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>(
        "DELETE",
        `${this.resolveSessionBaseUrl(scope)}/crossings/${encodeURIComponent(String(eventId))}`
      )
    );
  }

  public async updateTrackNode(update: GateUpdate, scope?: TrackScope | null): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>(
        "PUT",
        `${this.resolveTrackBaseUrl(scope)}/gates/${update.gateId}`,
        update
      )
    );
  }

  public async updateGate(update: GateUpdate, scope?: TrackScope | null): Promise<void> {
    await this.updateTrackNode(update, scope);
  }

  public async addTrackNode(
    name = "",
    assignedTimerId = 0,
    trackOrder?: number,
    scope?: TrackScope | null
  ): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>(
        "POST",
        `${this.resolveTrackBaseUrl(scope)}/gates`,
        {
          name,
          assignedTimerId,
          ...(trackOrder !== undefined ? { trackOrder } : {}),
        }
      )
    );
  }

  public async addGate(
    name = "",
    assignedTimerId = 0,
    trackOrder?: number,
    scope?: TrackScope | null
  ): Promise<void> {
    await this.addTrackNode(name, assignedTimerId, trackOrder, scope);
  }

  public async removeTrackNode(nodeId: number, scope?: TrackScope | null): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>(
        "DELETE",
        `${this.resolveTrackBaseUrl(scope)}/gates/${nodeId}`
      )
    );
  }

  public async removeGate(nodeId: number, scope?: TrackScope | null): Promise<void> {
    await this.removeTrackNode(nodeId, scope);
  }

  public async updateTimerColor(timerId: number, color: string): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("PATCH", `/v1/timers/${timerId}`, { color })
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
      await this.transport.request<FullStateResponse>("DELETE", `/v1/timers/${timerId}`)
    );
    await this.persistBrowserEnginesIfDemo();
  }

  /** Registers a newly flashed timer (hub or spoke) with its name and board fingerprint. */
  public async provisionTimer(
    role: "hub" | "spoke",
    timerLabel: string,
    fingerprint = ""
  ): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/v1/timers", {
        role,
        timerLabel,
        fingerprint,
      })
    );
  }

  /**
   * Builds or patches a pre-configured XIAO ESP32-C5 firmware binary stamped with role, name,
   * board fingerprint & active channels, 100% client-side in the browser from the static
   * `./firmware/slaprf-xiao-c5.bin` image, or the Bluetooth Hub image
   * `./firmware/slaprf-xiao-c5-ble.bin` when `hubLink` is "ble" (Hub only).
   */
  public async fetchFirmwareImage(
    role: "hub" | "spoke",
    timerLabel = "",
    fingerprint = generateFingerprint(),
    hubLink: HubLink = "usb"
  ): Promise<{ bytes: Uint8Array; sha256: string; filename: string }> {
    const enabledFreqs = this.store.enabledPilots.map((p) => p.frequencyMhz).filter((f) => f > 0);
    const freqs =
      enabledFreqs.length > 0
        ? enabledFreqs.slice(0, 8)
        : this.store.pilots.slice(0, 8).map((p) => p.frequencyMhz);
    const built = await buildOrPatchFirmwareBin({
      role,
      timerLabel,
      fingerprint,
      frequenciesMHz: freqs,
      hubLink,
    });
    return { bytes: built.bytes, sha256: "", filename: built.filename };
  }

  /**
   * Current state of the active timing engine. Used by the Debug page for pilot thresholds,
   * timer status, and frame-rate checks.
   */
  public async getRealEngineState(): Promise<FullStateResponse | null> {
    try {
      return await this.transport.request<FullStateResponse>("GET", "/v1/state");
    } catch {
      return null;
    }
  }

  /** Per-gate, per-pilot enter thresholds (all applied, or none if any is invalid). */
  public async setGateThresholds(updates: GateThresholdUpdate[], scope?: TrackScope | null): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>(
        "PUT",
        `${this.resolveTrackBaseUrl(scope)}/thresholds`,
        updates
      )
    );
  }

  /** One gate's timing-rule overrides across all pilots; an empty object clears them. */
  public async setGateRules(
    nodeId: number,
    overrides: GateRuleOverrides,
    scope?: TrackScope | null
  ): Promise<void> {
    const base = this.resolveTrackBaseUrl(scope);
    const state =
      Object.keys(overrides).length === 0
        ? await this.transport.request<FullStateResponse>("POST", `${base}/gates/${nodeId}/rules:reset`, {})
        : await this.transport.request<FullStateResponse>("PUT", `${base}/gates/${nodeId}/rules`, overrides);
    this.store.hydrate(state);
  }

  /** One pilot's timing-rule overrides at one gate (Tier 3); an empty object clears them. */
  public async setPilotGateRules(
    nodeId: number,
    slotIndex: number,
    overrides: GateRuleOverrides,
    scope?: TrackScope | null
  ): Promise<void> {
    const base = this.resolveTrackBaseUrl(scope);
    const state =
      Object.keys(overrides).length === 0
        ? await this.transport.request<FullStateResponse>(
            "POST",
            `${base}/gates/${nodeId}/pilots/${slotIndex}/rules:reset`,
            {}
          )
        : await this.transport.request<FullStateResponse>(
            "PUT",
            `${base}/gates/${nodeId}/pilots/${slotIndex}/rules`,
            overrides
          );
    this.store.hydrate(state);
  }

  /** Saves timing guardrails for the scoped track; the server clamps values and returns updated state. */
  public async updateRules(rules: TimingRules, scope?: TrackScope | null): Promise<void> {
    const res = await this.transport.request<FullStateResponse | TimingRules>(
      "PUT",
      `${this.resolveTrackBaseUrl(scope)}/rules`,
      rules
    );
    if (res && typeof res === "object" && "pilots" in res) {
      this.store.hydrate(res);
    } else if (res) {
      this.store.applyRules(res as TimingRules);
    }
  }

  /** Retrieves the WASM engine's build version info (release tag, commit_hash, branch_name). */
  public async getVersionInfo(): Promise<{ release_tag: string; commit_hash: string; branch_name: string }> {
    return await this.transport.request<{ release_tag: string; commit_hash: string; branch_name: string }>("GET", "/v1/version");
  }

  /** Switches the active engine between SlapRF USB ("slaprf"), SlapRF Bluetooth ("slaprf_ble"), LapRF 8-Way ("laprf"), and RotorHazard ("rotorhazard" / "rotorhazard_usb"). */
  public async setTimingHardwareMode(mode: TimingHardwareMode): Promise<void> {
    const prevMode = this.store.timingHardwareMode;
    if (!isSlapRFMode(mode) || prevMode !== mode) {
      await usbPool.disconnectSimulatedPorts();
    }
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("PUT", "/v1/hardware/mode", { mode })
    );
    if (this.backendMode) {
      await usbPool.attachBackendMode(this.simMode);
    }
    if (isSlapRFMode(mode)) {
      await usbPool.reconcileSimulatedPorts();
    }
    await this.persistBrowserEnginesIfDemo();
  }

  /** Mutates simulated LapRF 8-Way timers in Simulation Mode. */
  public async simLapRFAction(payload: {
    action: "connect" | "toggle-power" | "toggle-connect" | "connect-host" | "disconnect" | "update" | "add" | "delete" | "reset";
    timerId?: number;
    label?: string;
    host?: string;
    port?: number;
    voltageMv?: number;
  }): Promise<void> {
    let state: FullStateResponse;
    switch (payload.action) {
      case "add":
      case "connect-host":
        state = await this.transport.request<FullStateResponse>("POST", "/v1/sim/laprf/timers", payload);
        break;
      case "reset":
        state = await this.transport.request<FullStateResponse>("POST", "/v1/sim/laprf/timers:reset", {});
        break;
      case "delete":
        state = await this.transport.request<FullStateResponse>(
          "DELETE",
          `/v1/sim/laprf/timers/${payload.timerId ?? 0}`
        );
        break;
      case "update":
        state = await this.transport.request<FullStateResponse>(
          "PATCH",
          `/v1/sim/laprf/timers/${payload.timerId ?? 0}`,
          payload
        );
        break;
      default:
        state = await this.transport.request<FullStateResponse>(
          "POST",
          `/v1/sim/laprf/timers/${payload.timerId ?? 0}:action`,
          payload
        );
        break;
    }
    this.store.hydrate(state);
  }

  /** Discovers powered-on simulated LapRF 8-Way timers on the virtual LAN in Simulation Mode. */
  public async simLapRFDiscover(): Promise<{
    subnet: string;
    devices: Array<{ host: string; port: number; label: string; timerId: number; connected: boolean; voltageMv: number }>;
  }> {
    return await this.transport.request("GET", "/v1/sim/laprf/devices");
  }

  /** Mutates simulated RotorHazard timing devices in Simulation Mode. */
  public async simRotorHazardAction(payload: {
    action: "connect" | "toggle-power" | "toggle-connect" | "connect-host" | "connect-port" | "disconnect" | "update" | "add" | "delete" | "reset";
    timerId?: number;
    label?: string;
    transport?: string;
    portName?: string;
    baudRate?: number;
    host?: string;
    port?: number;
    nodeCount?: number;
    adminUser?: string;
    adminPass?: string;
  }): Promise<void> {
    let state: FullStateResponse;
    switch (payload.action) {
      case "add":
      case "connect-host":
      case "connect-port":
        state = await this.transport.request<FullStateResponse>("POST", "/v1/sim/rotorhazard/timers", payload);
        break;
      case "reset":
        state = await this.transport.request<FullStateResponse>("POST", "/v1/sim/rotorhazard/timers:reset", {});
        break;
      case "delete":
        state = await this.transport.request<FullStateResponse>(
          "DELETE",
          `/v1/sim/rotorhazard/timers/${payload.timerId ?? 0}`
        );
        break;
      case "update":
        state = await this.transport.request<FullStateResponse>(
          "PATCH",
          `/v1/sim/rotorhazard/timers/${payload.timerId ?? 0}`,
          payload
        );
        break;
      default:
        state = await this.transport.request<FullStateResponse>(
          "POST",
          `/v1/sim/rotorhazard/timers/${payload.timerId ?? 0}:action`,
          payload
        );
        break;
    }
    this.store.hydrate(state);
  }

  /** Enables or disables idle RF node streaming on a RotorHazard timer from `#/debug`. */
  public async setRHDebugStream(timerId: number, active: boolean): Promise<void> {
    await this.transport.request<{ ok: boolean }>("PUT", `/v1/rotorhazard/connections/${timerId}/debug-stream`, {
      active,
    });
  }

  /** Triggers a single or continuous 0-255 RSSI spectrum sweep on a simulated RotorHazard USB timer. */
  public async runRHUSBScan(payload: {
    timerId: number;
    mode: "once" | "live" | "stop";
    start: number;
    stop: number;
    step: number;
  }): Promise<{
    ok: boolean;
    scanLive?: boolean;
    scan?: {
      seq: number;
      start: number;
      stop: number;
      step: number;
      passMs: number;
      live: boolean;
      values: number[];
    };
  }> {
    return await this.transport.request("POST", `/v1/sim/rotorhazard/timers/${payload.timerId}:scan`, {
      mode: payload.mode,
      start: payload.start,
      stop: payload.stop,
      step: payload.step,
    });
  }

  /** Discovers powered-on simulated RotorHazard devices on the virtual LAN or USB bus in Simulation Mode. */
  public async simRotorHazardDiscover(): Promise<{
    subnet: string;
    devices: Array<{
      transport?: string;
      portName?: string;
      baudRate?: number;
      apiLevel?: number;
      host: string;
      port: number;
      label: string;
      timerId: number;
      nodeCount: number;
      serverVersion?: string;
      connected: boolean;
    }>;
  }> {
    return await this.transport.request("GET", "/v1/sim/rotorhazard/devices");
  }

  /** Calls a MultiGP WebService v1.0.4 endpoint against the in-memory Simulated MultiGP server. */
  public async simMultiGPWebService<T = unknown>(subPath: string, body: unknown): Promise<T> {
    return await this.transport.request<T>("POST", `/v1/sim/multigp/${subPath}`, body);
  }

  /** Reads or mutates the Simulated MultiGP chapter, API key, races, and ZippyQ queue (`#/sim`). */
  public async simMultiGPAdmin(payload?: SimMultiGPAdminAction): Promise<SimMultiGPState> {
    const next = payload
      ? await this.transport.request<SimMultiGPState>("POST", "/v1/sim/multigp/admin:action", payload)
      : await this.transport.request<SimMultiGPState>("GET", "/v1/sim/multigp/admin");
    await this.pollStatus();
    await this.persistBrowserEnginesIfDemo();
    return next;
  }

  /** Imports a MultiGP race into SlapRF (`schedule` | `zippyq` | `bracket`). */
  public async multiGPImportRace(
    race: MultiGPRaceViewData,
    importMode: "schedule" | "zippyq" | "bracket",
    templateId = ""
  ): Promise<RaceTournamentState> {
    const res = await this.transport.request<{
      createdRace: RaceTournamentState;
      state: FullStateResponse;
    }>("POST", "/v1/race/sessions:importMultiGP", { race, importMode, templateId });
    this.store.hydrate(res.state);
    await this.persistBrowserEnginesIfDemo();
    return res.createdRace;
  }

  /** Appends newly pulled MultiGP `getAdditionalRounds` ZippyQ heats to a linked SlapRF race. */
  public async multiGPAppendZippyQ(
    raceId: string,
    rounds: MultiGPScheduleRound[]
  ): Promise<{ addedHeats: number; raceState: RaceTournamentState }> {
    const sid = encodeURIComponent(raceId.trim() || "current");
    const res = await this.transport.request<{
      addedHeats: number;
      raceState: RaceTournamentState;
      eventState: EventManagerState;
    }>("POST", `/v1/race/sessions/${sid}/multigp:appendZippyQ`, { rounds });
    this.store.ingestRace(res.raceState, res.eventState, null);
    await this.persistBrowserEnginesIfDemo();
    return { addedHeats: res.addedHeats, raceState: res.raceState };
  }

  /** Builds a MultiGP `assignSlot` + `captureOverallRaceResult` sync plan for a linked SlapRF race. */
  public async multiGPBuildSyncPlan(raceId: string, forceAll = false): Promise<MultiGPSyncPlan> {
    const sid = encodeURIComponent(raceId.trim() || "current");
    const qs = forceAll ? "?forceAll=1" : "";
    return await this.transport.request<MultiGPSyncPlan>(
      "GET",
      `/v1/race/sessions/${sid}/multigp/sync-plan${qs}`
    );
  }

  /** Marks pushed heats (and optionally overall standings) as synced on a linked or newly uploaded SlapRF race. */
  public async multiGPMarkSynced(
    raceId: string,
    syncedHeatIds: string[],
    overallSynced: boolean,
    linkMeta?: {
      mgpRaceId?: number;
      mgpRaceName?: string;
      chapterId?: number;
      chapterName?: string;
    }
  ): Promise<void> {
    const sid = encodeURIComponent(raceId.trim() || "current");
    this.store.hydrate(
      await this.transport.request<FullStateResponse>(
        "PUT",
        `/v1/race/sessions/${sid}/multigp/sync-state`,
        {
          syncedHeatIds,
          overallSynced,
          ...(linkMeta ?? {}),
        }
      )
    );
    await this.persistBrowserEnginesIfDemo();
  }

  /** Merges chapter pilots from MultiGP into the global SlapRF pilot directory without deleting any existing pilots. */
  public async multiGPImportPilots(pilots: MultiGPRaceEntry[]): Promise<PilotCSVImportSummary> {
    const resp = await this.transport.request<FullStateResponse>("POST", "/v1/pilots:import", {
      pilots,
    });
    this.store.hydrate(resp);
    this.transport.pushHubChannels();
    await this.persistBrowserEnginesIfDemo();
    return resp.importSummary ?? { added: 0, updated: 0, total: resp.pilots.length };
  }

  private async pollStatus(): Promise<void> {
    if (isServerDisconnectedLockout()) return;
    try {
      // While the real-time stream is open (WebSocket on native Go server or onStream in WASM),
      // practice/race/lap deltas are already pushed immediately, so poll `/v1/status?lite=1`
      // (~1 KB instead of re-serializing and re-normalizing hundreds of KB of lap history every 2 s).
      const statusUrl = this.transport.isStreamConnected?.() ? "/v1/status?lite=1" : "/v1/status";
      const status = await this.transport.request<StatusResponse>("GET", statusUrl);
      const prevHwMode = this.store.timingHardwareMode;
      this.store.applyStatus(status);
      if (this.backendMode && status.simulatorRunning !== this.simMode) {
        this.simMode = status.simulatorRunning;
        try {
          window.localStorage.setItem(SIM_MODE_STORAGE_KEY, String(this.simMode));
        } catch {
          // ignore
        }
        void usbPool.attachBackendMode(this.simMode);
        void this.refresh().catch(() => undefined);
      } else if (this.backendMode && this.store.timingHardwareMode !== prevHwMode) {
        void usbPool.attachBackendMode(this.simMode);
      }
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
          this.store.applyConfig(c.pilots, c.gates, c.timers);
          this.transport.pushHubChannels();
          break;
        }
        case "race": {
          const r = msg.payload as RacePayload;
          if (r && r.raceState) {
            this.store.ingestRace(r.raceState, r.eventState ?? null, r.announcement, r.serverTimestampUs);
          }
          break;
        }
        case "practice": {
          const p = msg.payload as PracticeManagerState;
          if (p) {
            this.store.ingestPractice(p);
          }
          break;
        }
      }
    });
  }
}
