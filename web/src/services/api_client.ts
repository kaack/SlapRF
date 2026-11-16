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
  raceState: RaceTournamentState;
  eventState?: EventManagerState | null;
  announcement?: RaceAnnouncement | null;
}

const STATUS_POLL_MS = 2000;
const SIM_MODE_STORAGE_KEY = "slaprf.ui.sim_mode.v1";

/**
 * REST + real-time stream client:
 * - Native Go Backend mode (`caps.portable === true`): Thin UI client talking to the local or LAN
 *   `slaprf` Go binary over HTTP REST + `/api/ws/stream` (`BackendHttpTransport`). Zero WASM and
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
    this.store.hydrate(await this.transport.request<FullStateResponse>("GET", "/api/state"));
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
      (url.startsWith("/api/sim/toggle") || url.startsWith("/api/sim/mode")) &&
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

  public async setSimSpeed(speedMultiplier: number): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/sim/speed", { speedMultiplier })
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
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/sim/timer-action", payload)
    );
    await usbPool.reconcileSimulatedPorts();
  }

  public async pollStatusNow(): Promise<void> {
    await this.pollStatus();
  }

  public async resetSession(): Promise<void> {
    this.store.hydrate(await this.transport.request<FullStateResponse>("POST", "/api/session/reset"));
    await this.persistBrowserEnginesIfDemo();
  }

  public async resetPilotsToDefault(): Promise<void> {
    this.store.hydrate(await this.transport.request<FullStateResponse>("POST", "/api/pilots/reset"));
    this.transport.pushHubChannels();
  }

  public async resetTrackToDefault(): Promise<void> {
    this.store.hydrate(await this.transport.request<FullStateResponse>("POST", "/api/track/reset"));
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
      .request<FullStateResponse>("POST", "/api/storage/reset")
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
  }

  /**
   * Populates the active engine with the showcase demo dataset (Bay Area pilots, 3-gate SlapRF
   * track with Hub H1 + 3 Spoke timers, 3 practice sessions, and 4 tournaments).
   */
  public async restoreDemoData(): Promise<void> {
    this.store.clearActiveHistory();
    const state = await this.transport
      .request<FullStateResponse>("POST", "/api/storage/demo")
      .catch(() => null);
    if (state) {
      this.store.hydrate(state);
    } else {
      await this.refresh();
    }
    if (this.simMode && this.store.timingHardwareMode === "slaprf") {
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
      realData = await this.transport.request<unknown>("GET", "/api/storage/export");
    } catch {
      // ignore
    }

    if (this.backendMode) {
      await this.transport.request("POST", "/api/storage/backup-recorded", {}).catch(() => undefined);
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
      await this.transport.request("POST", "/api/storage/import", bundle.real).catch(() => undefined);
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

  public async updatePilotSlot(slot: PilotSlot): Promise<void> {
    this.store.hydrate(await this.transport.request<FullStateResponse>("POST", "/api/pilots/update", slot));
    this.transport.pushHubChannels();
  }

  public async addPilot(callsign = "", phoneticName = ""): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/pilots/add", {
        callsign,
        phoneticName,
      })
    );
    this.transport.pushHubChannels();
  }

  public async removePilot(slotIndex: number): Promise<void> {
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/pilots/remove", { slotIndex })
    );
    this.transport.pushHubChannels();
  }

  public async downloadPilotsRosterCsv(fallbackName = "slaprf-pilots.csv"): Promise<string> {
    const url = "/api/pilots/export.csv";
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
    const res = await this.transport.request<FullStateResponse>("POST", "/api/pilots/import", { csv });
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
    this.store.hydrate(await this.transport.request<FullStateResponse>("POST", "/api/race/mode", { mode }));
    this.transport.pushHubChannels();
  }

  public async configureRace(
    config: RaceSetupConfig,
    generate: boolean,
    applyToExisting = false,
    raceId?: string
  ): Promise<void> {
    const targetRaceId = (raceId || this.viewingRaceId || "").trim();
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/race/setup", {
        ...(targetRaceId ? { raceId: targetRaceId } : {}),
        config,
        generate,
        applyToExisting,
      })
    );
    this.transport.pushHubChannels();
  }

  public async advanceRaceStage2(): Promise<void> {
    this.store.hydrate(await this.transport.request<FullStateResponse>("POST", "/api/race/advance-stage", {}));
    this.transport.pushHubChannels();
  }

  public async raceControl(
    action: string,
    heatId = "",
    raceId?: string,
    preemptOngoing = false
  ): Promise<void> {
    const targetRaceId = (raceId || this.viewingRaceId || "").trim();
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/race/control", {
        ...(targetRaceId ? { raceId: targetRaceId } : {}),
        action,
        heatId,
        ...(preemptOngoing ? { preemptOngoing: true } : {}),
      })
    );
    this.transport.pushHubChannels();
  }

  public async raceMarshal(payload: RaceMarshalPayload): Promise<void> {
    const targetRaceId = (payload.raceId || this.viewingRaceId || "").trim();
    const effectivePayload =
      targetRaceId && !payload.raceId ? { ...payload, raceId: targetRaceId } : payload;
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/race/marshal", effectivePayload)
    );
    this.transport.pushHubChannels();
  }

  public async eventAction(payload: EventActionPayload): Promise<void> {
    const perRaceScoped =
      payload.action === "update_attendance" ||
      payload.action === "check_in_all" ||
      payload.action === "add_event_pilot" ||
      payload.action === "add_race_pilot" ||
      payload.action === "race_lifecycle" ||
      payload.action === "stage_control" ||
      payload.action === "set_race_tags" ||
      payload.action === "rename_race";
    const effectivePayload =
      perRaceScoped && !payload.raceId && this.viewingRaceId
        ? { ...payload, raceId: this.viewingRaceId }
        : payload;
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/events/action", effectivePayload)
    );
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
    this.store.hydrate(await this.transport.request<FullStateResponse>("POST", "/api/practice/action", payload));
    this.transport.pushHubChannels();
  }

  public async bracketEdit(payload: BracketEditPayload): Promise<RaceTournamentState> {
    const targetRaceId = (payload.raceId || this.viewingRaceId || "").trim();
    const effectivePayload =
      targetRaceId && !payload.raceId ? { ...payload, raceId: targetRaceId } : payload;
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/race/bracket-edit", effectivePayload)
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
    if (raceId) params.set("raceId", raceId);
    if (stageIndex > 0) params.set("stageIndex", String(stageIndex));
    const qs = params.toString();
    const url = `/api/races/export.csv${qs ? `?${qs}` : ""}`;
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
    const snap = await this.transport.request<RaceTournamentState>("POST", "/api/race/tick", {});
    this.store.ingestRace(snap, null, null);
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
    await this.persistBrowserEnginesIfDemo();
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

  /** Retrieves the WASM engine's build version info (release tag, commit_hash, branch_name). */
  public async getVersionInfo(): Promise<{ release_tag: string; commit_hash: string; branch_name: string }> {
    return await this.transport.request<{ release_tag: string; commit_hash: string; branch_name: string }>("GET", "/api/version");
  }

  /** Switches the active engine between SlapRF ("slaprf"), LapRF 8-Way ("laprf"), and RotorHazard ("rotorhazard"). */
  public async setTimingHardwareMode(mode: TimingHardwareMode): Promise<void> {
    if (mode !== "slaprf") {
      await usbPool.disconnectSimulatedPorts();
    }
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/hardware/mode", { mode })
    );
    if (mode === "slaprf") {
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
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/sim/laprf-action", payload)
    );
  }

  /** Discovers powered-on simulated LapRF 8-Way timers on the virtual LAN in Simulation Mode. */
  public async simLapRFDiscover(): Promise<{
    subnet: string;
    devices: Array<{ host: string; port: number; label: string; timerId: number; connected: boolean; voltageMv: number }>;
  }> {
    return await this.transport.request("GET", "/api/sim/laprf-discover");
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
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/sim/rh-action", payload)
    );
  }

  /** Enables or disables idle RF node streaming on a RotorHazard timer from `#/debug`. */
  public async setRHDebugStream(timerId: number, active: boolean): Promise<void> {
    await this.transport.request<{ ok: boolean }>("POST", "/api/hardware/rh-debug-stream", {
      timerId,
      active,
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
    return await this.transport.request("GET", "/api/sim/rh-discover");
  }

  /** Calls a MultiGP WebService v1.0.4 endpoint against the in-memory Simulated MultiGP server. */
  public async simMultiGPWebService<T = unknown>(subPath: string, body: unknown): Promise<T> {
    return await this.transport.request<T>("POST", `/api/sim/mgp/${subPath}`, body);
  }

  /** Reads or mutates the Simulated MultiGP chapter, API key, races, and ZippyQ queue (`#/sim`). */
  public async simMultiGPAdmin(payload?: SimMultiGPAdminAction): Promise<SimMultiGPState> {
    const next = payload
      ? await this.transport.request<SimMultiGPState>("POST", "/api/sim/mgp-admin", payload)
      : await this.transport.request<SimMultiGPState>("GET", "/api/sim/mgp-admin");
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
    }>("POST", "/api/mgp-sync/import", { race, importMode, templateId });
    this.store.hydrate(res.state);
    await this.persistBrowserEnginesIfDemo();
    return res.createdRace;
  }

  /** Appends newly pulled MultiGP `getAdditionalRounds` ZippyQ heats to a linked SlapRF race. */
  public async multiGPAppendZippyQ(
    raceId: string,
    rounds: MultiGPScheduleRound[]
  ): Promise<{ addedHeats: number; raceState: RaceTournamentState }> {
    const res = await this.transport.request<{
      addedHeats: number;
      raceState: RaceTournamentState;
      eventState: EventManagerState;
    }>("POST", "/api/mgp-sync/append-zippyq", { raceId, rounds });
    this.store.ingestRace(res.raceState, res.eventState, null);
    await this.persistBrowserEnginesIfDemo();
    return { addedHeats: res.addedHeats, raceState: res.raceState };
  }

  /** Builds a MultiGP `assignSlot` + `captureOverallRaceResult` sync plan for a linked SlapRF race. */
  public async multiGPBuildSyncPlan(raceId: string, forceAll = false): Promise<MultiGPSyncPlan> {
    return await this.transport.request<MultiGPSyncPlan>("POST", "/api/mgp-sync/plan", {
      raceId,
      forceAll,
    });
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
    this.store.hydrate(
      await this.transport.request<FullStateResponse>("POST", "/api/mgp-sync/mark-synced", {
        raceId,
        syncedHeatIds,
        overallSynced,
        ...(linkMeta ?? {}),
      })
    );
    await this.persistBrowserEnginesIfDemo();
  }

  /** Merges chapter pilots from MultiGP into the global SlapRF pilot directory without deleting any existing pilots. */
  public async multiGPImportPilots(pilots: MultiGPRaceEntry[]): Promise<PilotCSVImportSummary> {
    const resp = await this.transport.request<FullStateResponse>("POST", "/api/mgp-sync/import-pilots", {
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
      const status = await this.transport.request<StatusResponse>("GET", "/api/status");
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
            this.store.ingestRace(r.raceState, r.eventState ?? null, r.announcement);
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
