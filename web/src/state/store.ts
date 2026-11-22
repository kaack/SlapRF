import {
  AnalyticsScope,
  slugifyPracticeName,
  slugifyRaceName,
} from "../core/router";
import { subscribeAppTheme } from "../core/theme";
import { isValidEncodedSeatChannel } from "../core/vtx_channels";
import {
  DetectedTimer,
  EventManagerState,
  FilteredDetection,
  FullStateResponse,
  GateCrossingEvent,
  LapRecord,
  LapRFEmulatorStatus,
  OperatingMode,
  PilotSlot,
  PilotTrackSummary,
  PracticeManagerState,
  PracticeSession,
  RaceAnnouncement,
  RaceHeat,
  RaceTournamentState,
  SimMultiGPState,
  SimState,
  StatusResponse,
  TimerTelemetryFrame,
  TimingHardwareMode,
  isRotorHazardMode,
  normalizeTimingHardwareMode,
  TimingRules,
  TrackNode,
} from "../types/models";
import { sharedLapRFEmulatorRelay } from "../services/laprf_emulator_relay";

/**
 * Change topics. Components subscribe only to what they render so that, for
 * example, a 50 Hz telemetry stream never re-renders a form the user is editing.
 * Raw telemetry is intentionally *not* a topic: canvases pull it every frame.
 */
export type Topic =
  | "config"
  | "laps"
  | "crossings"
  | "status"
  | "selection"
  | "rules"
  | "race"
  | "practice";

type Listener = () => void;
type LapListener = (lap: LapRecord) => void;
type CrossingListener = (ev: GateCrossingEvent) => void;
type RaceAnnouncementListener = (ann: RaceAnnouncement) => void;

/** Which lap the pilot is looking at, and what it's compared against. */
export type ReferenceChoice = "best" | "previous" | number;
export interface ComparisonSelection {
  /** Lap under review (null = always the latest lap). */
  lapId: number | null;
  /** Reference: personal best, the lap before, or a specific lap id. */
  reference: ReferenceChoice;
}

/** Signal history kept per gate (15 minutes in RAM), so the RSSI chart can be paused and scrolled back after landing. */
export const HISTORY_SECONDS = 900;
const HISTORY_US = HISTORY_SECONDS * 1_000_000;
/** Timers sweep at up to 100 Hz; history is trimmed by time, this only bounds memory. */
const HISTORY_SAMPLES = HISTORY_SECONDS * 100;
/** Trim in batches rather than shifting one frame at a time. */
const HISTORY_TRIM_SLACK = 500;

/** Enough timed passes (and rejected ones) to cover the signal history. */
const MAX_CROSSINGS = 3000;
const MAX_FILTERED = 1000;
const MAX_LAPS = 5000;
const UI_PREFS_STORAGE_KEY = "slaprf.ui.prefs.v1";

const DEFAULT_RULES: TimingRules = {
  minLapSec: 5,
  maxLapSec: 120,
  minCrossingSec: 0.12,
  beepOnCross: false,
};

function normalizeTimingRules(raw?: Partial<TimingRules> & { minPassHoldSec?: number } | null): TimingRules {
  if (!raw) return { ...DEFAULT_RULES };
  const minLapSec = typeof raw.minLapSec === "number" && raw.minLapSec > 0 ? raw.minLapSec : DEFAULT_RULES.minLapSec;
  const maxLapSec = typeof raw.maxLapSec === "number" && raw.maxLapSec > 0 ? raw.maxLapSec : DEFAULT_RULES.maxLapSec;
  const rawCrossing =
    typeof raw.minCrossingSec === "number" && raw.minCrossingSec > 0
      ? raw.minCrossingSec
      : typeof raw.minPassHoldSec === "number" && raw.minPassHoldSec > 0
        ? raw.minPassHoldSec
        : DEFAULT_RULES.minCrossingSec;
  return {
    minLapSec,
    maxLapSec,
    minCrossingSec: rawCrossing,
    beepOnCross: Boolean(raw.beepOnCross),
  };
}

const DEFAULT_RACE_STATE: RaceTournamentState = {
  mode: "practice",
  config: {
    eventName: "Club Race",
    structure: "single_stage",
    qualifyingRounds: 2,
    qualifyingMetric: "consecutive_3",
    qualifyingTimeLimitSec: 120,
    qualifyingTargetLaps: 0,
    mainFormat: "double_elimination",
    finalsFormat: "chase_the_ace",
    aceWinsRequired: 2,
    winnersAdvantageAce: false,
    pointsRounds: 3,
    pilotsPerHeat: 4,
    seatChannels: [1, 3, 5, 8],
    targetLaps: 3,
    timeLimitSec: 120,
    countdownSec: 5,
    overtimeGraceSec: 15,
    seeding: "roster_order",
  },
  generated: false,
  activeStageIndex: 1,
  totalStages: 1,
  qualifyingComplete: false,
  canStartStage2: false,
  activeHeatId: "",
  nextReadyHeatId: "",
  isComplete: false,
  heats: [],
  edges: [],
  standings: [],
};

function normalizeRosterList(roster?: RaceTournamentState["roster"]): NonNullable<RaceTournamentState["roster"]> {
  if (!Array.isArray(roster)) return [];
  return roster.map((p) => ({
    ...p,
    attendance:
      (p.attendance as string) === "left" || p.attendance === "forfeit" || p.attendance === "dnc"
        ? "dnc"
        : p.attendance === "dq"
          ? "dq"
          : p.attendance === "away"
            ? "away"
            : "active",
  }));
}

function normalizeTrackSnapshot(
  nodes?: TrackNode[] | null,
  trackInitialized?: boolean
): TrackNode[] | undefined {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return trackInitialized ? [] : undefined;
  }
  return [...nodes].sort((a, b) => a.trackOrder - b.trackOrder);
}

export interface ScopedStoreOverrides {
  nodes: () => { nodes: TrackNode[]; historical: boolean };
  rules?: () => TimingRules;
  isScopeLive?: () => boolean;
  laps?: () => LapRecord[];
  crossings?: () => GateCrossingEvent[];
  filtered?: () => FilteredDetection[];
  summaries?: () => PilotTrackSummary[];
  enabledPilots?: () => PilotSlot[];
  pilot?: (slotIndex: number) => PilotSlot | undefined;
  selectedPilot?: () => number;
  selectPilot?: (slotIndex: number) => void;
  lastCrossingFor?: (slotIndex: number) => GateCrossingEvent | undefined;
}

export type ResolvedAnalyticsScope =
  | {
      kind: "practice";
      id: string;
      slug: string;
      name: string;
      live: boolean;
      session?: PracticeSession;
    }
  | {
      kind: "race";
      id: string;
      slug: string;
      name: string;
      live: boolean;
      race?: RaceTournamentState;
    };

export interface AnalyticsPilotPool {
  inScope: PilotSlot[];
  globalOther: PilotSlot[];
  bySlot: Map<number, PilotSlot>;
}

function normalizeSeatChannels(
  val: unknown,
  fallback: number[] = [1, 3, 5, 8]
): number[] {
  if (Array.isArray(val)) {
    const nums = val
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && isValidEncodedSeatChannel(n));
    if (nums.length > 0) return nums;
  }
  if (typeof val === "string" && val.length > 0) {
    try {
      const bin = atob(val);
      const nums: number[] = [];
      for (let i = 0; i < bin.length; i++) {
        const ch = bin.charCodeAt(i);
        if (isValidEncodedSeatChannel(ch)) nums.push(ch);
      }
      if (nums.length > 0) return nums;
    } catch {
      // ignore invalid base64
    }
  }
  return [...fallback];
}

function normalizeRaceState(raw?: RaceTournamentState | null): RaceTournamentState {
  if (!raw) return DEFAULT_RACE_STATE;
  const cfgChannels = normalizeSeatChannels(
    raw.config?.seatChannels,
    DEFAULT_RACE_STATE.config.seatChannels
  );
  return {
    ...DEFAULT_RACE_STATE,
    ...raw,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === "string" && t.trim() !== "") : [],
    templateId: raw.templateId ?? "",
    trackInitialized: raw.trackInitialized,
    trackSnapshot: normalizeTrackSnapshot(raw.trackSnapshot, raw.trackInitialized),
    rules: raw.rules ? { ...DEFAULT_RULES, ...raw.rules } : undefined,
    roster: normalizeRosterList(raw.roster),
    stages: Array.isArray(raw.stages)
      ? raw.stages.map((st) => ({
          ...st,
          settings: st.settings
            ? {
                ...st.settings,
                seatChannels: normalizeSeatChannels(st.settings.seatChannels, cfgChannels),
              }
            : st.settings,
        }))
      : undefined,
    stageConnections: Array.isArray(raw.stageConnections) ? raw.stageConnections : undefined,
    rounds: Array.isArray(raw.rounds) ? raw.rounds : [],
    connections: Array.isArray(raw.connections) ? raw.connections : [],
    config: {
      ...DEFAULT_RACE_STATE.config,
      ...(raw.config ?? {}),
      seatChannels: cfgChannels,
    },
    heats: Array.isArray(raw.heats)
      ? raw.heats.map((h) => ({
          ...h,
          seats: Array.isArray(h.seats)
            ? h.seats.map((s) => ({
                ...s,
                laps: Array.isArray(s.laps) ? s.laps : [],
              }))
            : [],
        }))
      : [],
    edges: Array.isArray(raw.edges) ? raw.edges : [],
    standings: Array.isArray(raw.standings) ? raw.standings : [],
    qualStandings: Array.isArray(raw.qualStandings) ? raw.qualStandings : undefined,
  };
}

const DEFAULT_EVENT_STATE: EventManagerState = {
  activeRaceId: "",
  races: [],
};

function normalizeEventState(raw?: EventManagerState | null): EventManagerState {
  if (!raw) return DEFAULT_EVENT_STATE;
  return {
    initialized: raw.initialized,
    activeRaceId: raw.activeRaceId ?? "",
    races: Array.isArray(raw.races) ? raw.races.map((r) => normalizeRaceState(r)) : [],
  };
}

const DEFAULT_PRACTICE_STATE: PracticeManagerState = {
  activeSessionId: "",
  selectedSessionId: "",
  sessions: [],
};

function normalizePracticeSession(raw: PracticeSession): PracticeSession {
  return {
    ...raw,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === "string" && t.trim() !== "") : [],
    pilots: Array.isArray(raw.pilots) ? raw.pilots : [],
    trackInitialized: raw.trackInitialized,
    trackSnapshot: normalizeTrackSnapshot(raw.trackSnapshot, raw.trackInitialized),
    rules: raw.rules ? { ...DEFAULT_RULES, ...raw.rules } : undefined,
    laps: Array.isArray(raw.laps)
      ? raw.laps.map((l) => (Array.isArray(l.sectors) ? l : { ...l, sectors: [] }))
      : [],
    crossings: Array.isArray(raw.crossings) ? raw.crossings : [],
    filtered: Array.isArray(raw.filtered) ? raw.filtered : [],
    summaries: Array.isArray(raw.summaries) ? raw.summaries : [],
  };
}

function normalizePracticeState(raw?: PracticeManagerState | null): PracticeManagerState {
  if (!raw) return DEFAULT_PRACTICE_STATE;
  return {
    initialized: raw.initialized,
    activeSessionId: raw.activeSessionId ?? "",
    selectedSessionId: raw.selectedSessionId ?? "",
    sessions: Array.isArray(raw.sessions) ? raw.sessions.map((s) => normalizePracticeSession(s)) : [],
  };
}

export class AppStore {
  private _pilots: PilotSlot[] = [];
  private _nodes: TrackNode[] = [];
  private _detectedTimers: DetectedTimer[] = [];
  private _usbTimer: DetectedTimer | null = null;
  private _laps: LapRecord[] = [];
  private _crossings: GateCrossingEvent[] = [];
  private _filtered: FilteredDetection[] = [];
  private _summaries: PilotTrackSummary[] = [];
  private _rules: TimingRules = DEFAULT_RULES;
  private _timingHardwareMode: TimingHardwareMode = "slaprf";
  private _simulatorRunning = false;
  private _simState: SimState | null = null;
  private _simMultiGP: SimMultiGPState | null = null;
  private _raceArmed = true;
  private _raceState: RaceTournamentState = DEFAULT_RACE_STATE;
  private _eventState: EventManagerState = DEFAULT_EVENT_STATE;
  private _practiceState: PracticeManagerState = DEFAULT_PRACTICE_STATE;
  private _laprfEmulator: LapRFEmulatorStatus = {
    connectedClients: 0,
    detectionsSent: 0,
    statusFramesSent: 0,
    lastRfSetupSync: "",
    raceArmedByHost: true,
  };
  private _latestTimestampUs = 0;
  private _latestTelemetryTimestampUs = 0;
  private _lastIngestPerfMs = 0;
  private _lastSeenIso = "";
  private _lastSeenIsoAtMs = -Infinity;
  private _playheadUs = 0;
  private _lastPlayheadPerfMs = 0;
  private _streamAnchorBaseUs = 0;
  private _streamAnchorPerfMs = 0;
  private _ingestCount = 0;
  private _selectedPilot = 1;
  /** Live view focus: null shows every pilot, a slot index follows that pilot. */
  private _liveFocus: number | null = null;
  private _comparison: ComparisonSelection = { lapId: null, reference: "best" };

  private readonly simHistory = new Map<number, TimerTelemetryFrame[]>();
  private readonly realHistory = new Map<number, TimerTelemetryFrame[]>();
  private readonly lastCrossingBySlot = new Map<number, GateCrossingEvent>();
  private readonly listeners = new Map<Topic, Set<Listener>>();
  private readonly lapListeners = new Set<LapListener>();
  private readonly crossingListeners = new Set<CrossingListener>();
  private readonly startGateListeners = new Set<CrossingListener>();
  private readonly raceAnnouncementListeners = new Set<RaceAnnouncementListener>();

  constructor() {
    this.loadUiPrefs();
    subscribeAppTheme(() => {
      this.emit("config", "status", "race", "practice", "selection");
    });
  }

  public reloadUiPrefs(): void {
    this._selectedPilot = 1;
    this._liveFocus = null;
    this._comparison = { lapId: null, reference: "best" };
    this.loadUiPrefs();
    this.ensureValidSelection();
    this.emit("selection");
  }

  public resetUiPrefs(): void {
    this._selectedPilot = 1;
    this._liveFocus = null;
    this._comparison = { lapId: null, reference: "best" };
    this.saveUiPrefs();
    this.ensureValidSelection();
    this.emit("selection");
  }

  private loadUiPrefs(): void {
    try {
      const raw = window.localStorage.getItem(UI_PREFS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        selectedPilot?: number;
        liveFocus?: number | null;
        comparison?: ComparisonSelection;
      };
      if (typeof parsed.selectedPilot === "number" && parsed.selectedPilot >= 1) {
        this._selectedPilot = parsed.selectedPilot;
      }
      if (parsed.liveFocus === null || (typeof parsed.liveFocus === "number" && parsed.liveFocus >= 1)) {
        this._liveFocus = parsed.liveFocus;
      }
      if (parsed.comparison && typeof parsed.comparison === "object") {
        const ref = parsed.comparison.reference;
        if (ref === "best" || ref === "previous" || typeof ref === "number") {
          this._comparison = {
            lapId: typeof parsed.comparison.lapId === "number" ? parsed.comparison.lapId : null,
            reference: ref,
          };
        }
      }
    } catch {
      // Ignore storage access errors
    }
  }

  private saveUiPrefs(): void {
    try {
      window.localStorage.setItem(
        UI_PREFS_STORAGE_KEY,
        JSON.stringify({
          selectedPilot: this._selectedPilot,
          liveFocus: this._liveFocus,
          comparison: this._comparison,
        })
      );
    } catch {
      // Ignore storage access errors
    }
  }

  private get activeHistory(): Map<number, TimerTelemetryFrame[]> {
    return this._simulatorRunning ? this.simHistory : this.realHistory;
  }

  // ---- subscriptions -------------------------------------------------------

  /** Fires once per newly recorded lap (never on hydrate/reset) — used by the announcer. */
  public onLapRecorded(fn: LapListener): () => void {
    this.lapListeners.add(fn);
    return () => this.lapListeners.delete(fn);
  }

  /** Fires immediately whenever any live gate crossing is accepted (Practice or Race). */
  public onGateCrossing(fn: CrossingListener): () => void {
    this.crossingListeners.add(fn);
    return () => this.crossingListeners.delete(fn);
  }

  /**
   * Fires when a pilot passes through the Start/Finish gate to start a lap without a previous
   * reference point (initial start pass or first pass after reset/timeout) — used by the announcer.
   */
  public onStartGateDetected(fn: CrossingListener): () => void {
    this.startGateListeners.add(fn);
    return () => this.startGateListeners.delete(fn);
  }

  public onRaceAnnouncement(fn: RaceAnnouncementListener): () => void {
    this.raceAnnouncementListeners.add(fn);
    return () => this.raceAnnouncementListeners.delete(fn);
  }

  public subscribe(topics: Topic[], fn: Listener): () => void {
    for (const topic of topics) {
      let set = this.listeners.get(topic);
      if (!set) {
        set = new Set();
        this.listeners.set(topic, set);
      }
      set.add(fn);
    }
    return () => topics.forEach((t) => this.listeners.get(t)?.delete(fn));
  }

  /** Re-fires view/widget subscribers when the UI theme toggles so theme-adapted colors re-render immediately. */
  public notifyThemeChanged(): void {
    this.emit("config", "status", "laps", "race", "practice", "selection");
  }

  private _stateRev = 0;
  private _cachedPracticeNodes: {
    rev: number;
    sess: PracticeSession | null | undefined;
    res: { nodes: TrackNode[]; historical: boolean };
  } | null = null;
  private _cachedRaceNodes: {
    rev: number;
    race: RaceTournamentState | null | undefined;
    res: { nodes: TrackNode[]; historical: boolean };
  } | null = null;
  private _cachedNodes: { rev: number; res: TrackNode[] } | null = null;
  private _cachedDetectedTimers: { rev: number; res: DetectedTimer[] } | null = null;
  private _cachedCrossings: {
    rev: number;
    sess: PracticeSession | undefined;
    res: GateCrossingEvent[];
  } | null = null;
  private _cachedFiltered: {
    rev: number;
    sess: PracticeSession | undefined;
    res: FilteredDetection[];
  } | null = null;
  private _cachedLaps: {
    rev: number;
    sess: PracticeSession | undefined;
    res: LapRecord[];
  } | null = null;
  private _cachedSummaries: {
    rev: number;
    sess: PracticeSession | undefined;
    res: PilotTrackSummary[];
  } | null = null;

  public get stateRev(): number {
    return this._stateRev;
  }

  private emit(...topics: Topic[]): void {
    this._stateRev = (this._stateRev + 1) | 0;
    const fired = new Set<Listener>();
    for (const topic of topics) {
      this.listeners.get(topic)?.forEach((fn) => {
        if (!fired.has(fn)) {
          fired.add(fn);
          try {
            fn();
          } catch (err) {
            console.error(`[AppStore] subscriber error on ${topic}:`, err);
          }
        }
      });
    }
  }

  // ---- read model ----------------------------------------------------------

  private get hasPracticeSessions(): boolean {
    return Boolean(this._practiceState.initialized || this._practiceState.sessions.length > 0);
  }

  private get isLiveRaceHeatRunning(): boolean {
    if (Boolean(this._practiceState?.activeSessionId)) {
      return false;
    }
    const rs = this._raceState;
    if (
      rs &&
      rs.lifecycle !== "paused" &&
      rs.lifecycle !== "completed" &&
      rs.lifecycle !== "scrapped" &&
      rs.heats?.some((h) => h.state === "countdown" || h.state === "running")
    ) {
      return true;
    }
    return Boolean(
      this._eventState.races.some(
        (r) =>
          r.generated &&
          r.lifecycle !== "paused" &&
          r.lifecycle !== "completed" &&
          r.lifecycle !== "scrapped" &&
          r.heats?.some((h) => h.state === "countdown" || h.state === "running")
      )
    );
  }

  private isSelectedSessionLiveStream(sess: PracticeSession): boolean {
    return (
      sess.active &&
      sess.sessionId === this._practiceState.activeSessionId &&
      !this.isLiveRaceHeatRunning
    );
  }

  public get pilots(): PilotSlot[] {
    return this._pilots;
  }
  public get enabledPilots(): PilotSlot[] {
    if (this.hasPracticeSessions) {
      const sess = this.selectedPracticeSession;
      if (!sess) return [];
      return sess.pilots.map((sp) => {
        const base = this._pilots.find((p) => p.slotIndex === sp.slotIndex);
        return {
          slotIndex: sp.slotIndex,
          callsign: base?.callsign || sp.callsign,
          phoneticName: base?.phoneticName ?? sp.phoneticName ?? "",
          enabled: true,
          band: sp.band || base?.band || 1,
          channel: sp.channel,
          frequencyMhz: sp.frequencyMhz || base?.frequencyMhz || 0,
          enterThreshold: base?.enterThreshold ?? -58,
          exitThreshold: base?.exitThreshold ?? -66,
          laprfThreshold: base?.laprfThreshold ?? 800,
          rhEnterThreshold: base?.rhEnterThreshold ?? 95,
          rhExitThreshold: base?.rhExitThreshold ?? 70,
          attenuationGain: base?.attenuationGain ?? 59,
          color: base?.color || sp.color || "#38bdf8",
          mgpPilotId: base?.mgpPilotId,
          mgpUserName: base?.mgpUserName,
        };
      });
    }
    return this._pilots.filter((p) => p.enabled);
  }
  /** True when this AppStore view is reading a frozen historical TrackSnapshot rather than live hardware. */
  public get isHistoricalTrack(): boolean {
    return false;
  }

  /** True when the viewed session/race scope is currently live on track. */
  public get isScopeLive(): boolean {
    const sess = this.selectedPracticeSession;
    return !sess || sess.active;
  }

  private enrichTrackNodesWithLiveTimers(nodes: TrackNode[]): TrackNode[] {
    const detected = this.detectedTimers;
    if (detected.length === 0) {
      return [...nodes].sort((a, b) => a.trackOrder - b.trackOrder);
    }
    const usb = !this._simulatorRunning && this._usbTimer?.fingerprint ? this._usbTimer : null;
    return [...nodes]
      .sort((a, b) => a.trackOrder - b.trackOrder)
      .map((n) => {
        const tid = n.assignedTimerId ?? 0;
        if (tid <= 0) {
          return { ...n, online: false };
        }
        const d = detected.find((t) => t.timerId === tid);
        if (!d) {
          return { ...n, online: false };
        }
        let noiseFloor = d.noiseFloorDbm;
        if (
          usb &&
          d.fingerprint &&
          d.fingerprint.toUpperCase() === usb.fingerprint!.toUpperCase() &&
          d.online
        ) {
          noiseFloor = usb.noiseFloorDbm;
        }
        return {
          ...n,
          timerLabel: d.timerLabel?.trim() || n.timerLabel,
          firmwareVersion: d.firmwareVersion || n.firmwareVersion,
          color: d.color?.trim() || n.color,
          batteryMv: d.batteryMv,
          batteryPct: d.batteryPct,
          noiseFloorDbm: noiseFloor,
          lastRssi: d.lastRssi ?? n.lastRssi,
          online: d.online,
        };
      });
  }

  /** Resolves the ordered track gates for `sess`: always `sess`'s own track when initialized/present. */
  public practiceSessionNodes(sess?: PracticeSession | null): { nodes: TrackNode[]; historical: boolean } {
    const cached = this._cachedPracticeNodes;
    if (cached && cached.rev === this._stateRev && cached.sess === sess) {
      return cached.res;
    }
    let res: { nodes: TrackNode[]; historical: boolean };
    if (sess && (sess.trackInitialized || (Array.isArray(sess.trackSnapshot) && sess.trackSnapshot.length > 0))) {
      const base = sess.trackSnapshot ?? [];
      if (sess.active) {
        res = { nodes: this.enrichTrackNodesWithLiveTimers(base), historical: false };
      } else {
        res = { nodes: base, historical: true };
      }
    } else {
      res = { nodes: this.nodes, historical: false };
    }
    this._cachedPracticeNodes = { rev: this._stateRev, sess, res };
    return res;
  }

  /** Resolves the timing rules for `sess`. */
  public practiceSessionRules(sess?: PracticeSession | null): TimingRules {
    return sess?.rules ?? this._rules;
  }

  /** Resolves the ordered track gates for `race`: always `race`'s own track when initialized/present. */
  public raceNodes(race?: RaceTournamentState | null): { nodes: TrackNode[]; historical: boolean } {
    const cached = this._cachedRaceNodes;
    if (cached && cached.rev === this._stateRev && cached.race === race) {
      return cached.res;
    }
    const isClosed = Boolean(
      race && (race.lifecycle === "completed" || race.lifecycle === "scrapped" || race.isComplete)
    );
    let res: { nodes: TrackNode[]; historical: boolean };
    if (race && (race.trackInitialized || (Array.isArray(race.trackSnapshot) && race.trackSnapshot.length > 0))) {
      const base = race.trackSnapshot ?? [];
      if (isClosed) {
        res = { nodes: base, historical: true };
      } else {
        res = { nodes: this.enrichTrackNodesWithLiveTimers(base), historical: false };
      }
    } else {
      res = { nodes: this.nodes, historical: isClosed };
    }
    this._cachedRaceNodes = { rev: this._stateRev, race, res };
    return res;
  }

  /** Resolves the timing rules for `race`. */
  public raceRules(race?: RaceTournamentState | null): TimingRules {
    return race?.rules ?? this._rules;
  }

  /** Resolves the active Analytics scope (`PracticeSession` or `RaceTournamentState`) within the requested kind. */
  public resolveAnalyticsScope(requested?: AnalyticsScope | null): ResolvedAnalyticsScope {
    if (requested?.kind === "practice") {
      if (requested.id) {
        const reqTrim = requested.id.trim();
        const reqLower = reqTrim.toLowerCase();
        const reqSlug = slugifyPracticeName(reqTrim);
        const sess =
          this.practiceSessions.find((s) => {
            const sSlug = slugifyPracticeName(s.name || "Practice Session");
            return sSlug === reqLower || sSlug === reqSlug;
          }) ?? this.practiceSessions.find((s) => s.sessionId === reqTrim);
        if (sess) {
          const name = sess.name || "Practice Session";
          return {
            kind: "practice",
            id: sess.sessionId,
            slug: slugifyPracticeName(name),
            name,
            live: Boolean(sess.active),
            session: sess,
          };
        }
      }
      const fallbackSess =
        this.activePracticeSession ??
        this.selectedPracticeSession ??
        this.practiceSessions[0];
      if (fallbackSess) {
        const name = fallbackSess.name || "Practice Session";
        return {
          kind: "practice",
          id: fallbackSess.sessionId,
          slug: slugifyPracticeName(name),
          name,
          live: Boolean(fallbackSess.active),
          session: fallbackSess,
        };
      }
      return {
        kind: "practice",
        id: "",
        slug: "",
        name: "",
        live: false,
      };
    }

    if (requested?.kind === "race") {
      if (requested.id) {
        const reqTrim = requested.id.trim();
        const reqLower = reqTrim.toLowerCase();
        const reqSlug = slugifyRaceName(reqTrim);
        const race =
          this.races.find((r) => {
            const rSlug = slugifyRaceName(r.config.eventName || "Race");
            return rSlug === reqLower || rSlug === reqSlug;
          }) ?? this.races.find((r) => (r.raceId ?? "") === reqTrim);
        if (race) {
          const isLive = Boolean(
            race.lifecycle === "active" ||
              race.heats.some((h) => h.state === "running" || h.state === "countdown")
          );
          const name = race.config.eventName || "Race";
          return {
            kind: "race",
            id: race.raceId ?? requested.id,
            slug: slugifyRaceName(name),
            name,
            live: isLive,
            race,
          };
        }
      }
      const fallbackRace = this.ongoingRace ?? this.races[0];
      if (fallbackRace) {
        const isLive = Boolean(
          fallbackRace.lifecycle === "active" ||
            fallbackRace.heats.some((h) => h.state === "running" || h.state === "countdown")
        );
        const name = fallbackRace.config.eventName || "Race";
        return {
          kind: "race",
          id: fallbackRace.raceId ?? "",
          slug: slugifyRaceName(name),
          name,
          live: isLive,
          race: fallbackRace,
        };
      }
      return {
        kind: "race",
        id: "",
        slug: "",
        name: "",
        live: false,
      };
    }

    const ongoing = this.ongoingRace;
    if (ongoing && ongoing.raceId) {
      const name = ongoing.config.eventName || "Race";
      return {
        kind: "race",
        id: ongoing.raceId,
        slug: slugifyRaceName(name),
        name,
        live: true,
        race: ongoing,
      };
    }

    const activeSess = this.activePracticeSession;
    if (activeSess) {
      const name = activeSess.name || "Practice Session";
      return {
        kind: "practice",
        id: activeSess.sessionId,
        slug: slugifyPracticeName(name),
        name,
        live: true,
        session: activeSess,
      };
    }

    const selSess = this.selectedPracticeSession;
    if (selSess) {
      const name = selSess.name || "Practice Session";
      return {
        kind: "practice",
        id: selSess.sessionId,
        slug: slugifyPracticeName(name),
        name,
        live: Boolean(selSess.active),
        session: selSess,
      };
    }

    const firstRace = this.races[0];
    if (firstRace && firstRace.raceId) {
      const name = firstRace.config.eventName || "Race";
      return {
        kind: "race",
        id: firstRace.raceId,
        slug: slugifyRaceName(name),
        name,
        live: Boolean(firstRace.lifecycle === "active"),
        race: firstRace,
      };
    }

    return {
      kind: "practice",
      id: "",
      slug: "",
      name: "",
      live: false,
    };
  }

  /** Returns all counted LapRecords for an Analytics scope (Practice Session or Race). */
  public analyticsLapsForScope(resolved: ResolvedAnalyticsScope): LapRecord[] {
    const sanitizeLapSectors = (lap: LapRecord): LapRecord => {
      const sectors = lap.sectors;
      const lapTime = lap.lapTimeSec;
      if (!Array.isArray(sectors) || sectors.length === 0 || !(lapTime > 0)) {
        return lap;
      }
      let sum = 0;
      let maxIdx = 0;
      for (let i = 0; i < sectors.length; i++) {
        const sec = sectors[i].splitSeconds;
        sum += sec;
        if (sec > sectors[maxIdx].splitSeconds) {
          maxIdx = i;
        }
      }
      if (sum <= lapTime + 0.05) {
        return lap;
      }
      const nextSectors = sectors.map((s) => ({ ...s }));
      if (nextSectors.length === 1) {
        nextSectors[0].splitSeconds = Math.round(lapTime * 1000) / 1000;
        return { ...lap, sectors: nextSectors };
      }
      const otherSum = sum - nextSectors[maxIdx].splitSeconds;
      if (otherSum > 0 && otherSum < lapTime) {
        nextSectors[maxIdx].splitSeconds = Math.round((lapTime - otherSum) * 1000) / 1000;
        return { ...lap, sectors: nextSectors };
      }
      if (sum > 0) {
        const scale = lapTime / sum;
        let running = 0;
        for (let i = 0; i < nextSectors.length; i++) {
          if (i === nextSectors.length - 1) {
            nextSectors[i].splitSeconds = Math.round(Math.max(0.001, lapTime - running) * 1000) / 1000;
          } else {
            const v = Math.round(Math.max(0.001, nextSectors[i].splitSeconds * scale) * 1000) / 1000;
            nextSectors[i].splitSeconds = v;
            running += v;
          }
        }
      }
      return { ...lap, sectors: nextSectors };
    };

    if (resolved.kind === "practice") {
      const sess = resolved.session;
      if (!sess) {
        return [];
      }
      const raw = this.isSelectedSessionLiveStream(sess) ? this._laps : sess.laps;
      return raw.filter((l) => !l.invalidated).map(sanitizeLapSectors);
    }

    const race = resolved.race;
    if (!race) {
      return [];
    }
    const orderedHeats = [...race.heats].sort(
      (a, b) =>
        a.stageIndex - b.stageIndex ||
        a.order - b.order ||
        a.round - b.round ||
        a.id.localeCompare(b.id)
    );

    const bestBySlot = new Map<number, number>();
    for (const heat of orderedHeats) {
      for (const seat of heat.seats) {
        if (seat.pilotSlotIndex <= 0) continue;
        for (const hl of seat.laps ?? []) {
          if (hl.invalidated || hl.lapNumber < 1 || !(hl.splitTimeSec > 0)) continue;
          const prev = bestBySlot.get(seat.pilotSlotIndex);
          if (prev === undefined || hl.splitTimeSec < prev) {
            bestBySlot.set(seat.pilotSlotIndex, hl.splitTimeSec);
          }
        }
      }
    }

    const countBySlot = new Map<number, number>();
    const usedIds = new Set<number>();
    let nextSyntheticId = 1_000_001;
    const out: LapRecord[] = [];

    orderedHeats.forEach((heat, hIdx) => {
      for (const seat of heat.seats) {
        const slot = seat.pilotSlotIndex;
        if (slot <= 0) continue;
        const basePilot = this._pilots.find((p) => p.slotIndex === slot);
        const callsign = basePilot?.callsign || seat.callsign || `Pilot ${slot}`;
        for (const hl of seat.laps ?? []) {
          if (hl.invalidated || hl.lapNumber < 1 || !(hl.splitTimeSec > 0)) continue;
          const lapNum = (countBySlot.get(slot) ?? 0) + 1;
          countBySlot.set(slot, lapNum);
          let lapId = hl.crossingId > 0 ? hl.crossingId : 0;
          if (lapId <= 0 || usedIds.has(lapId)) {
            while (usedIds.has(nextSyntheticId)) nextSyntheticId++;
            lapId = nextSyntheticId++;
          }
          usedIds.add(lapId);
          const best = bestBySlot.get(slot) ?? hl.splitTimeSec;
          const delta = Math.round((hl.splitTimeSec - best) * 1000) / 1000;
          out.push(
            sanitizeLapSectors({
              lapId,
              slotIndex: slot,
              callsign,
              lapNumber: lapNum,
              lapTimeSec: hl.splitTimeSec,
              deltaToBest: Math.max(0, delta),
              sectors: Array.isArray(hl.sectors) ? hl.sectors : [],
              completedAtUs: Math.round((hIdx * 10_000 + (hl.raceElapsedSec || lapNum)) * 1_000_000),
              isBestLap: Math.abs(hl.splitTimeSec - best) < 0.0005,
            })
          );
        }
      }
    });

    return out;
  }

  /** Builds the in-scope and global pilot pools for an Analytics scope. */
  public analyticsPilotPool(resolved: ResolvedAnalyticsScope): AnalyticsPilotPool {
    const bySlot = new Map<number, PilotSlot>();
    for (const p of this._pilots) {
      bySlot.set(p.slotIndex, { ...p, enabled: true });
    }

    const inScopeSlots = new Set<number>();
    if (resolved.kind === "practice") {
      const sess = resolved.session;
      if (sess) {
        for (const sp of sess.pilots) {
          inScopeSlots.add(sp.slotIndex);
          const existing = bySlot.get(sp.slotIndex);
          bySlot.set(sp.slotIndex, {
            slotIndex: sp.slotIndex,
            callsign: existing?.callsign || sp.callsign,
            phoneticName: existing?.phoneticName ?? sp.phoneticName ?? "",
            enabled: true,
            band: sp.band || existing?.band || 1,
            channel: sp.channel || existing?.channel || 0,
            frequencyMhz: sp.frequencyMhz || existing?.frequencyMhz || 0,
            enterThreshold: existing?.enterThreshold ?? -58,
            exitThreshold: existing?.exitThreshold ?? -66,
            attenuationGain: existing?.attenuationGain ?? 0,
            color: existing?.color || sp.color || "#38bdf8",
          });
        }
        for (const lap of sess.laps) {
          inScopeSlots.add(lap.slotIndex);
          if (!bySlot.has(lap.slotIndex)) {
            bySlot.set(lap.slotIndex, {
              slotIndex: lap.slotIndex,
              callsign: lap.callsign || `Pilot ${lap.slotIndex}`,
              enabled: true,
              band: 1,
              channel: 0,
              frequencyMhz: 0,
              enterThreshold: -58,
              exitThreshold: -66,
              attenuationGain: 0,
              color: "#38bdf8",
            });
          }
        }
      } else {
        for (const p of this._pilots) {
          if (p.enabled) inScopeSlots.add(p.slotIndex);
        }
      }
    } else {
      const race = resolved.race;
      if (race) {
        for (const rp of race.roster ?? []) {
          if (rp.checkedIn && rp.attendance !== "forfeit" && rp.attendance !== "dnc") {
            inScopeSlots.add(rp.slotIndex);
          }
          if (!bySlot.has(rp.slotIndex)) {
            bySlot.set(rp.slotIndex, {
              slotIndex: rp.slotIndex,
              callsign: rp.callsign || `Pilot ${rp.slotIndex}`,
              phoneticName: rp.phoneticName ?? "",
              enabled: true,
              band: 1,
              channel: 0,
              frequencyMhz: 0,
              enterThreshold: -58,
              exitThreshold: -66,
              attenuationGain: 0,
              color: rp.color || "#38bdf8",
            });
          }
        }
        for (const heat of race.heats) {
          for (const seat of heat.seats) {
            if (seat.pilotSlotIndex <= 0) continue;
            inScopeSlots.add(seat.pilotSlotIndex);
            const existing = bySlot.get(seat.pilotSlotIndex);
            bySlot.set(seat.pilotSlotIndex, {
              slotIndex: seat.pilotSlotIndex,
              callsign: existing?.callsign || seat.callsign || `Pilot ${seat.pilotSlotIndex}`,
              phoneticName: existing?.phoneticName ?? seat.phoneticName ?? "",
              enabled: true,
              band: seat.band || existing?.band || 1,
              channel: seat.channel || existing?.channel || 0,
              frequencyMhz: seat.frequencyMhz || existing?.frequencyMhz || 0,
              enterThreshold: existing?.enterThreshold ?? -58,
              exitThreshold: existing?.exitThreshold ?? -66,
              attenuationGain: existing?.attenuationGain ?? 0,
              color: existing?.color || seat.color || "#38bdf8",
            });
          }
        }
      }
    }

    const inScope: PilotSlot[] = [];
    const globalOther: PilotSlot[] = [];
    for (const [slot, pilot] of bySlot.entries()) {
      if (inScopeSlots.has(slot)) {
        inScope.push(pilot);
      } else {
        globalOther.push(pilot);
      }
    }
    inScope.sort((a, b) => a.slotIndex - b.slotIndex);
    globalOther.sort((a, b) => a.slotIndex - b.slotIndex);

    return { inScope, globalOther, bySlot };
  }

  /**
   * Builds a lightweight scoped read-view over `this` AppStore so historical Practice Sessions,
   * completed Races, and scoped Analytics (`#/pilot`) read their recorded `trackSnapshot` and
   * scoped laps/pilots without ever mutating global `store.nodes` (which `#/track` & `#/sim` edit).
   */
  public createScopedView(overrides: ScopedStoreOverrides): AppStore {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const base = this;
    const view = Object.create(base) as AppStore;
    let lastNodesRef: TrackNode[] | null = null;
    const nodeById = new Map<number, TrackNode>();
    const syncNodeMap = (): TrackNode[] => {
      const arr = overrides.nodes().nodes;
      if (arr !== lastNodesRef) {
        lastNodesRef = arr;
        nodeById.clear();
        for (let i = 0; i < arr.length; i++) {
          nodeById.set(arr[i].gateId, arr[i]);
        }
      }
      return arr;
    };
    const props: PropertyDescriptorMap = {
      nodes: {
        get: () => syncNodeMap(),
        enumerable: true,
      },
      isHistoricalTrack: {
        get: () => overrides.nodes().historical,
        enumerable: true,
      },
      node: {
        value: (nodeId: number) => {
          syncNodeMap();
          return nodeById.get(nodeId);
        },
      },
      pilot: {
        value: overrides.pilot ? overrides.pilot : (slotIndex: number) => base.pilot(slotIndex),
      },
      subscribe: {
        value: base.subscribe.bind(base),
      },
      onLapRecorded: {
        value: base.onLapRecorded.bind(base),
      },
      onGateCrossing: {
        value: base.onGateCrossing.bind(base),
      },
      onStartGateDetected: {
        value: base.onStartGateDetected.bind(base),
      },
      onRaceAnnouncement: {
        value: base.onRaceAnnouncement.bind(base),
      },
      selectPilot: {
        value: overrides.selectPilot ? overrides.selectPilot : base.selectPilot.bind(base),
      },
      setComparison: {
        value: base.setComparison.bind(base),
      },
      setLiveFocus: {
        value: base.setLiveFocus.bind(base),
      },
      historyFor: {
        value: base.historyFor.bind(base),
      },
      clearActiveHistory: {
        value: base.clearActiveHistory.bind(base),
      },
      togglePracticeLap: {
        value: base.togglePracticeLap.bind(base),
      },
    };
    if (overrides.rules) {
      props.rules = { get: overrides.rules, enumerable: true };
    }
    if (overrides.isScopeLive) {
      props.isScopeLive = { get: overrides.isScopeLive, enumerable: true };
    }
    if (overrides.selectedPilot) {
      props.selectedPilot = { get: overrides.selectedPilot, enumerable: true };
    }
    if (overrides.laps) {
      props.laps = { get: overrides.laps, enumerable: true };
    }
    if (overrides.crossings) {
      props.crossings = { get: overrides.crossings, enumerable: true };
    }
    if (overrides.filtered) {
      props.filtered = { get: overrides.filtered, enumerable: true };
    }
    if (overrides.summaries) {
      props.summaries = { get: overrides.summaries, enumerable: true };
    }
    if (overrides.enabledPilots) {
      props.enabledPilots = { get: overrides.enabledPilots, enumerable: true };
    }
    if (overrides.lastCrossingFor) {
      props.lastCrossingFor = { value: overrides.lastCrossingFor };
    }
    props.summaryFor = {
      value: (slotIndex: number) => view.summaries.find((s) => s.slotIndex === slotIndex),
    };
    Object.defineProperties(view, props);
    return view;
  }

  /** Emits a UI selection notification without mutating root `_selectedPilot`. */
  public notifySelectionChanged(): void {
    this.emit("selection");
  }

  /** Scoped store view for Practice workspace views (`Overview`, `Laps`, `Trends`, `Signals`). */
  public forPracticeWorkspace(): AppStore {
    return this.createScopedView({
      nodes: () => this.practiceSessionNodes(this.selectedPracticeSession),
      rules: () => this.practiceSessionRules(this.selectedPracticeSession),
    });
  }

  /** Scoped store view for editing a Practice session's `Track` & `TimingRules` (live timer badges even while paused/stopped). */
  public forPracticeTrackEditor(getSession: () => PracticeSession | null | undefined): AppStore {
    return this.createScopedView({
      nodes: () => {
        const sess = getSession();
        if (sess && (sess.trackInitialized || (Array.isArray(sess.trackSnapshot) && sess.trackSnapshot.length > 0))) {
          return {
            nodes: this.enrichTrackNodesWithLiveTimers(sess.trackSnapshot ?? []),
            historical: false,
          };
        }
        return { nodes: this.nodes, historical: false };
      },
      rules: () => this.practiceSessionRules(getSession()),
    });
  }

  /** Scoped store view for a Race workspace (`Track`, `Signals`, `HeatLapEditorModal`). */
  public forRaceWorkspace(getRace: () => RaceTournamentState | null | undefined): AppStore {
    return this.createScopedView({
      nodes: () => this.raceNodes(getRace()),
      rules: () => this.raceRules(getRace()),
    });
  }

  /** Track nodes (gates) sorted by their position around the track. */
  public get nodes(): TrackNode[] {
    if (this._cachedNodes && this._cachedNodes.rev === this._stateRev) {
      return this._cachedNodes.res;
    }
    let res = this._nodes;
    if (!this._simulatorRunning && this._usbTimer && this._usbTimer.fingerprint) {
      const usb = this._usbTimer;
      const matchedDet = this.detectedTimers.find(
        (d) => d.fingerprint && d.fingerprint.toUpperCase() === usb.fingerprint!.toUpperCase()
      );
      if (matchedDet) {
        res = this._nodes.map((n) => {
          const assigned = n.assignedTimerId ?? n.gateId;
          if (assigned === matchedDet.timerId && n.online) {
            return {
              ...n,
              noiseFloorDbm: usb.noiseFloorDbm,
            };
          }
          return n;
        });
      }
    }
    this._cachedNodes = { rev: this._stateRev, res };
    return res;
  }
  /** Physical XIAO timers discovered via the USB Hub (ESP-NOW), flashed over USB, or currently plugged in via USB. */
  public get detectedTimers(): DetectedTimer[] {
    if (this._cachedDetectedTimers && this._cachedDetectedTimers.rev === this._stateRev) {
      return this._cachedDetectedTimers.res;
    }
    let res = this._detectedTimers;
    if (!this._simulatorRunning && this._usbTimer && this._usbTimer.fingerprint) {
      const usb = this._usbTimer;
      const list = this._detectedTimers.map((d) => ({ ...d }));
      const idx = list.findIndex(
        (d) => d.fingerprint && d.fingerprint.toUpperCase() === usb.fingerprint!.toUpperCase()
      );
      if (idx >= 0) {
        const existing = list[idx];
        list[idx] = {
          ...existing,
          timerLabel: usb.timerLabel || existing.timerLabel,
          isHub: usb.isHub,
          firmwareVersion: usb.firmwareVersion || existing.firmwareVersion,
          fingerprint: usb.fingerprint || existing.fingerprint,
          noiseFloorDbm: existing.online ? existing.noiseFloorDbm : usb.noiseFloorDbm,
          batteryMv: existing.batteryMv > 0 ? existing.batteryMv : usb.batteryMv,
          batteryPct: existing.batteryPct > 0 ? existing.batteryPct : usb.batteryPct,
          online: existing.online,
          lastSeenAt: existing.lastSeenAt,
        };
      }
      res = list;
    }
    this._cachedDetectedTimers = { rev: this._stateRev, res };
    return res;
  }

  public setUsbDetectedTimer(timer: DetectedTimer | null): void {
    const prev = this._usbTimer;
    if (prev === null && timer === null) return;
    const identitySame =
      prev !== null &&
      timer !== null &&
      prev.timerId === timer.timerId &&
      prev.timerLabel === timer.timerLabel &&
      prev.isHub === timer.isHub &&
      prev.firmwareVersion === timer.firmwareVersion &&
      prev.fingerprint === timer.fingerprint;
    const floorDiff =
      prev && timer ? Math.abs((prev.noiseFloorDbm ?? -92) - (timer.noiseFloorDbm ?? -92)) : 999;
    this._usbTimer = timer;
    this._stateRev = (this._stateRev + 1) | 0;
    if (!identitySame) {
      this.emit("status", "config");
    } else if (floorDiff >= 2) {
      this.emit("status");
    }
  }
  public get laps(): LapRecord[] {
    if (this.hasPracticeSessions) {
      const sess = this.selectedPracticeSession;
      if (!sess) return [];
      const cached = this._cachedLaps;
      if (cached && cached.rev === this._stateRev && cached.sess === sess) {
        return cached.res;
      }
      const activeSlots = new Set(sess.pilots.map((p) => p.slotIndex));
      const raw = this.isSelectedSessionLiveStream(sess) ? this._laps : sess.laps;
      const res = raw.filter((l) => activeSlots.has(l.slotIndex));
      this._cachedLaps = { rev: this._stateRev, sess, res };
      return res;
    }
    return this._laps;
  }
  public get crossings(): GateCrossingEvent[] {
    if (this.hasPracticeSessions) {
      const sess = this.selectedPracticeSession;
      if (!sess) return [];
      const cached = this._cachedCrossings;
      if (cached && cached.rev === this._stateRev && cached.sess === sess) {
        return cached.res;
      }
      const activeSlots = new Set(sess.pilots.map((p) => p.slotIndex));
      const raw = this.isSelectedSessionLiveStream(sess) ? this._crossings : sess.crossings;
      const res = raw.filter((c) => activeSlots.has(c.slotIndex));
      this._cachedCrossings = { rev: this._stateRev, sess, res };
      return res;
    }
    return this._crossings;
  }
  /** Detections set aside by the timing rules, oldest first. */
  public get filtered(): FilteredDetection[] {
    if (this.hasPracticeSessions) {
      const sess = this.selectedPracticeSession;
      if (!sess) return [];
      const cached = this._cachedFiltered;
      if (cached && cached.rev === this._stateRev && cached.sess === sess) {
        return cached.res;
      }
      const activeSlots = new Set(sess.pilots.map((p) => p.slotIndex));
      const raw = this.isSelectedSessionLiveStream(sess) ? this._filtered : sess.filtered;
      const res = raw.filter((f) => activeSlots.has(f.slotIndex));
      this._cachedFiltered = { rev: this._stateRev, sess, res };
      return res;
    }
    return this._filtered;
  }
  public get summaries(): PilotTrackSummary[] {
    if (this.hasPracticeSessions) {
      const sess = this.selectedPracticeSession;
      if (!sess) return [];
      const cached = this._cachedSummaries;
      if (cached && cached.rev === this._stateRev && cached.sess === sess) {
        return cached.res;
      }
      const activeSlots = new Set(sess.pilots.map((p) => p.slotIndex));
      const raw = this.isSelectedSessionLiveStream(sess) ? this._summaries : sess.summaries;
      const res = raw.filter((s) => activeSlots.has(s.slotIndex));
      this._cachedSummaries = { rev: this._stateRev, sess, res };
      return res;
    }
    return this._summaries;
  }
  public get rules(): TimingRules {
    return this._rules;
  }
  public get timingHardwareMode(): TimingHardwareMode {
    return this._timingHardwareMode;
  }
  public get simulatorRunning(): boolean {
    return this._simulatorRunning;
  }
  public get simState(): SimState | null {
    return this._simState;
  }
  public get simMultiGP(): SimMultiGPState | null {
    return this._simMultiGP;
  }
  public get raceArmed(): boolean {
    return this._raceArmed;
  }
  public get raceState(): RaceTournamentState {
    return this._raceState;
  }
  public get eventState(): EventManagerState {
    return this._eventState;
  }
  public get races(): RaceTournamentState[] {
    return this._eventState.races;
  }
  public get allRaceTags(): string[] {
    const seen = new Map<string, string>();
    for (const r of this._eventState.races) {
      for (const t of r.tags ?? []) {
        const key = t.toLowerCase();
        if (!seen.has(key)) seen.set(key, t);
      }
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }
  public get practiceState(): PracticeManagerState {
    return this._practiceState;
  }
  public get practiceSessions(): PracticeSession[] {
    return this._practiceState.sessions;
  }
  public get activePracticeSession(): PracticeSession | undefined {
    if (!this._practiceState.activeSessionId) return undefined;
    return this._practiceState.sessions.find((s) => s.sessionId === this._practiceState.activeSessionId);
  }
  public get selectedPracticeSession(): PracticeSession | undefined {
    const id = this._practiceState.selectedSessionId || this._practiceState.activeSessionId;
    return (
      this._practiceState.sessions.find((s) => s.sessionId === id) ?? this._practiceState.sessions[0]
    );
  }
  public get allPracticeTags(): string[] {
    const seen = new Map<string, string>();
    for (const s of this._practiceState.sessions) {
      for (const t of s.tags ?? []) {
        const key = t.toLowerCase();
        if (!seen.has(key)) seen.set(key, t);
      }
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }
  /** Returns any currently ongoing race across the event state, or undefined if none. */
  public get ongoingRace(): RaceTournamentState | undefined {
    return this._eventState.races.find(
      (r) =>
        r.generated &&
        (r.lifecycle === "active" ||
          Boolean(r.heats?.some((h) => h.state === "countdown" || h.state === "running")))
    );
  }
  public get operatingMode(): OperatingMode {
    return this._raceState?.mode === "race" ? "race" : "practice";
  }
  public get activeRaceHeat(): RaceHeat | undefined {
    const heats = this._raceState?.heats ?? [];
    const id = this._raceState?.activeHeatId || this._raceState?.nextReadyHeatId;
    return heats.find((h) => h.id === id) ?? heats[0];
  }
  public get laprfEmulator(): LapRFEmulatorStatus {
    return this._laprfEmulator;
  }
  /** Most recent engine timestamp seen on the telemetry stream. */
  public get latestTimestampUs(): number {
    return this._latestTimestampUs;
  }
  /**
   * Smooth 60 FPS live playhead timestamp (microseconds).
   * Advances continuously using `performance.now()` between 40 ms sliding-window packet
   * bursts and gently slews to track `_latestTimestampUs` so real-time signal charts glide
   * smoothly at the display refresh rate instead of stepping only when UDP packets arrive.
   */
  public get smoothLatestTimestampUs(): number {
    const latest = this._latestTelemetryTimestampUs || this._latestTimestampUs;
    if (latest === 0) return 0;
    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    // Same animation frame: return the already-stepped playhead so multiple callers see the exact same value.
    if (this._playheadUs > 0 && Math.abs(nowMs - this._lastPlayheadPerfMs) < 0.5) {
      return Math.round(this._playheadUs);
    }
    // If no telemetry has arrived in the last 500 ms (e.g. simulator paused or timers powered off), hold steady.
    if (this._lastIngestPerfMs === 0 || nowMs - this._lastIngestPerfMs > 500) {
      this._playheadUs = latest;
      this._lastPlayheadPerfMs = nowMs;
      return latest;
    }
    const speedMult = this._simulatorRunning ? Math.max(1, this._simState?.speedMultiplier || 1) : 1;
    const wallDtUs = Math.max(0, Math.min(100_000, (nowMs - this._lastPlayheadPerfMs) * 1000));
    const dtUs = wallDtUs * speedMult;
    this._lastPlayheadPerfMs = nowMs;
    // Follow the minimum-latency stream clock line with ~195 ms lookback (> 145 ms 1 Hz BLE STATUS
    // burst gap) so the playhead never outruns incoming batches and advances at near-constant VSync rate.
    const streamClockUs =
      this._streamAnchorPerfMs > 0
        ? this._streamAnchorBaseUs + Math.max(0, (nowMs - this._streamAnchorPerfMs) * 1000) * speedMult
        : latest;
    const baseLookbackUs =
      this._timingHardwareMode === "laprf" ||
      this._timingHardwareMode === "laprf_usb" ||
      isRotorHazardMode(this._timingHardwareMode)
        ? 230_000
        : 195_000;
    const targetUs = Math.max(0, streamClockUs - baseLookbackUs * speedMult);
    if (this._playheadUs === 0 || Math.abs(targetUs - this._playheadUs) > 700_000 * speedMult) {
      this._playheadUs = Math.min(latest, targetUs);
      return Math.round(this._playheadUs);
    }
    // Advance at the active engine clock rate (`dtUs`), with a tiny +-2.5% PLL trim so zoomed-in
    // 1-2 s signal windows scroll at steady VSync speed without 1 Hz batch velocity whips.
    const errorUs = targetUs - (this._playheadUs + dtUs);
    const maxCorrectionUs = dtUs * 0.025;
    const correctionUs = Math.max(-maxCorrectionUs, Math.min(maxCorrectionUs, errorUs * 0.02));
    this._playheadUs = Math.min(latest, this._playheadUs + dtUs + correctionUs);
    return Math.round(this._playheadUs);
  }
  private _lastRaceSyncPerfMs = 0;
  private _serverClockBaseUs = 0;
  private _serverClockPerfMs = 0;
  private _lastReturnedServerTsUs = 0;

  public get lastRaceSyncPerfMs(): number {
    return this._lastRaceSyncPerfMs;
  }

  /**
   * Monotonic server engine clock in microseconds (`eng.NowUs()`), extrapolated smoothly with
   * `performance.now()` between HTTP/WebSocket syncs regardless of whether any timing hardware
   * or telemetry stream is active.
   */
  public get liveServerTimestampUs(): number {
    if (this._serverClockBaseUs <= 0) {
      return 0;
    }
    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (this._serverClockPerfMs <= 0) {
      return this._serverClockBaseUs;
    }
    const speedMult = this._simulatorRunning ? Math.max(1, this._simState?.speedMultiplier || 1) : 1;
    const dtUs = Math.max(0, (nowMs - this._serverClockPerfMs) * 1000) * speedMult;
    const rawUs = Math.round(this._serverClockBaseUs + dtUs);
    // Hold monotonic against tiny (<500 ms) HTTP poll RTT jitter, while snapping immediately on large clock resets.
    if (this._lastReturnedServerTsUs > 0 && Math.abs(rawUs - this._lastReturnedServerTsUs) <= 500_000) {
      this._lastReturnedServerTsUs = Math.max(this._lastReturnedServerTsUs, rawUs);
      return this._lastReturnedServerTsUs;
    }
    this._lastReturnedServerTsUs = rawUs;
    return rawUs;
  }

  private anchorServerClock(serverTsUs: number | undefined, resetMonotonic = false): void {
    if (!serverTsUs || serverTsUs <= 0) return;
    this._serverClockBaseUs = serverTsUs;
    this._serverClockPerfMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (resetMonotonic) {
      this._lastReturnedServerTsUs = serverTsUs;
    }
  }
  public get selectedPilot(): number {
    return this._selectedPilot;
  }
  public get liveFocus(): number | null {
    return this._liveFocus;
  }
  public get comparison(): ComparisonSelection {
    return this._comparison;
  }

  public pilot(slotIndex: number): PilotSlot | undefined {
    return this._pilots.find((p) => p.slotIndex === slotIndex);
  }
  public node(nodeId: number): TrackNode | undefined {
    return this._nodes.find((n) => n.gateId === nodeId);
  }
  public summaryFor(slotIndex: number): PilotTrackSummary | undefined {
    return this.summaries.find((s) => s.slotIndex === slotIndex);
  }
  public lastCrossingFor(slotIndex: number): GateCrossingEvent | undefined {
    if (this.hasPracticeSessions) {
      const sess = this.selectedPracticeSession;
      if (!sess) return undefined;
      if (!sess.pilots.some((p) => p.slotIndex === slotIndex)) return undefined;
      if (this.isSelectedSessionLiveStream(sess)) {
        return this.lastCrossingBySlot.get(slotIndex);
      }
      for (let i = sess.crossings.length - 1; i >= 0; i--) {
        if (sess.crossings[i].slotIndex === slotIndex) {
          return sess.crossings[i];
        }
      }
      return undefined;
    }
    return this.lastCrossingBySlot.get(slotIndex);
  }
  public historyFor(nodeId: number): TimerTelemetryFrame[] {
    return this.activeHistory.get(nodeId) ?? [];
  }

  public clearActiveHistory(): void {
    this.activeHistory.clear();
    this._playheadUs = 0;
    this._streamAnchorBaseUs = 0;
    this._streamAnchorPerfMs = 0;
    this._latestTelemetryTimestampUs = 0;
    this._lastIngestPerfMs = 0;
  }

  // ---- mutations -----------------------------------------------------------

  private _hasHydrated = false;

  public get hasHydrated(): boolean {
    return this._hasHydrated;
  }

  public hydrate(state: FullStateResponse): void {
    const modeChanged = this._hasHydrated && this._simulatorRunning !== state.simulatorRunning;
    this._hasHydrated = true;
    this._pilots = state.pilots ?? [];
    this.setNodes(state.gates ?? []);
    this._detectedTimers = state.timers ?? [];
    this._laps = (state.laps ?? []).map((l) => (Array.isArray(l.sectors) ? l : { ...l, sectors: [] }));
    this._crossings = state.crossings ?? [];
    this._filtered = state.filtered ?? [];
    this._summaries = state.summaries ?? [];
    this._rules = normalizeTimingRules(state.rules);
    this._timingHardwareMode = normalizeTimingHardwareMode(state.timingHardwareMode);
    sharedLapRFEmulatorRelay.setSuppressed(
      this._timingHardwareMode === "laprf" || this._timingHardwareMode === "laprf_usb"
    );
    this._simulatorRunning = state.simulatorRunning;
    this._simState = state.simState ?? null;
    this._simMultiGP = state.simMultiGP ?? null;
    this._raceArmed = state.raceArmed;
    this._laprfEmulator = state.laprfEmulatorStatus;
    if (state.raceState) {
      this._raceState = normalizeRaceState(state.raceState);
    }
    if (state.eventState) {
      this._eventState = normalizeEventState(state.eventState);
    }
    if (state.practiceState) {
      this._practiceState = normalizePracticeState(state.practiceState);
    }
    if (modeChanged) {
      this._comparison = { lapId: null, reference: "best" };
      this._playheadUs = 0;
      this._streamAnchorBaseUs = 0;
      this._streamAnchorPerfMs = 0;
      this._latestTelemetryTimestampUs = 0;
      this._lastIngestPerfMs = 0;
      this._serverClockBaseUs = 0;
      this._serverClockPerfMs = 0;
      this._lastReturnedServerTsUs = 0;
    }
    this.anchorServerClock(state.serverTimestampUs, modeChanged);

    this.lastCrossingBySlot.clear();
    let maxTs = state.serverTimestampUs ?? 0;
    for (const ev of this._crossings) {
      this.lastCrossingBySlot.set(ev.slotIndex, ev);
      if (ev.timestampUs > maxTs) maxTs = ev.timestampUs;
    }
    for (const lap of this._laps) {
      if (lap.completedAtUs > maxTs) maxTs = lap.completedAtUs;
    }
    for (const frames of this.activeHistory.values()) {
      const last = frames[frames.length - 1];
      if (last && last.timestampUs > maxTs) maxTs = last.timestampUs;
    }
    this._latestTimestampUs = maxTs;
    this.ensureValidSelection();
    this.emit("config", "laps", "crossings", "status", "selection", "rules", "race", "practice");
  }

  public applyStatus(status: StatusResponse): void {
    const before = this._nodes.map((n) => n.gateId).join(",");
    this.setNodes(status.gates ?? []);
    if (status.timers) {
      this._detectedTimers = status.timers;
    }
    if (status.serverTimestampUs && status.serverTimestampUs > this._latestTimestampUs) {
      this._latestTimestampUs = status.serverTimestampUs;
    }
    this.anchorServerClock(status.serverTimestampUs, false);
    if (status.timingHardwareMode) {
      const nextHw: TimingHardwareMode = normalizeTimingHardwareMode(status.timingHardwareMode);
      if (nextHw !== this._timingHardwareMode) {
        this._timingHardwareMode = nextHw;
        sharedLapRFEmulatorRelay.setSuppressed(nextHw === "laprf" || nextHw === "laprf_usb");
      }
    }
    this._simulatorRunning = status.simulatorRunning;
    if (status.simState !== undefined) {
      this._simState = status.simState;
    } else if (!status.simulatorRunning) {
      this._simState = null;
    }
    if (status.simMultiGP !== undefined) {
      this._simMultiGP = status.simMultiGP;
    } else if (!status.simulatorRunning) {
      this._simMultiGP = null;
    }
    this._raceArmed = status.raceArmed;
    this._laprfEmulator = status.laprfEmulatorStatus;
    const hadRace = status.raceState !== undefined || status.eventState !== undefined;
    const hadPractice = status.practiceState !== undefined;
    if (status.raceState) {
      this._raceState = normalizeRaceState(status.raceState);
    }
    if (status.eventState) {
      this._eventState = normalizeEventState(status.eventState);
    }
    if (status.practiceState) {
      this._practiceState = normalizePracticeState(status.practiceState);
    }

    const gatesChanged = before !== this._nodes.map((n) => n.gateId).join(",");
    const topics: Topic[] = ["status"];
    if (gatesChanged) {
      this.ensureValidSelection();
      topics.push("config");
    }
    if (hadRace) {
      this._lastRaceSyncPerfMs = typeof performance !== "undefined" ? performance.now() : Date.now();
      topics.push("race");
    }
    if (hadPractice) {
      this.ensureValidSelection();
      topics.push("practice");
    }
    this.emit(...topics);
  }

  public ingestPractice(practiceState: PracticeManagerState): void {
    this._practiceState = normalizePracticeState(practiceState);
    if (!this.isLiveRaceHeatRunning) {
      const activeSess = this.activePracticeSession;
      if (activeSess) {
        this._laps = [...activeSess.laps];
        this._crossings = [...activeSess.crossings];
        this._filtered = [...activeSess.filtered];
        this._summaries = [...activeSess.summaries];
      }
    }
    this.ensureValidSelection();
    this.emit("practice", "config", "laps", "crossings", "selection");
  }

  /** Optimistically toggles `invalidated` on a practice lap and recomputes personal bests and badges across valid laps. */
  public togglePracticeLap(lapId: number): void {
    const recomputeList = (list: LapRecord[]): void => {
      const bestBySlot = new Map<number, number>();
      const overallBestSec = new Map<string, number>();
      const pilotBestSec = new Map<string, number>();

      for (const l of list) {
        if (l.lapId === lapId) {
          l.invalidated = !l.invalidated;
        }
      }

      for (const l of list) {
        if (l.invalidated || !(l.lapTimeSec > 0)) continue;
        const curBest = bestBySlot.get(l.slotIndex);
        if (curBest === undefined || l.lapTimeSec < curBest) {
          bestBySlot.set(l.slotIndex, l.lapTimeSec);
        }
        for (const s of l.sectors ?? []) {
          if (!(s.splitSeconds > 0)) continue;
          const pKey = `${s.fromGateId}>${s.toGateId}`;
          const sKey = `${l.slotIndex}:${pKey}`;
          const oCur = overallBestSec.get(pKey);
          if (oCur === undefined || s.splitSeconds < oCur) overallBestSec.set(pKey, s.splitSeconds);
          const pCur = pilotBestSec.get(sKey);
          if (pCur === undefined || s.splitSeconds < pCur) pilotBestSec.set(sKey, s.splitSeconds);
        }
      }

      for (const l of list) {
        if (l.invalidated) {
          l.isBestLap = false;
          continue;
        }
        const bestLap = bestBySlot.get(l.slotIndex) ?? 0;
        if (bestLap > 0) {
          l.isBestLap = Math.abs(l.lapTimeSec - bestLap) < 0.0005;
          l.deltaToBest = l.isBestLap ? 0 : Math.round((l.lapTimeSec - bestLap) * 1000) / 1000;
        }
        for (const s of l.sectors ?? []) {
          const pKey = `${s.fromGateId}>${s.toGateId}`;
          const sKey = `${l.slotIndex}:${pKey}`;
          const pBest = pilotBestSec.get(sKey) ?? 0;
          const oBest = overallBestSec.get(pKey) ?? 0;
          s.deltaToBestSec = pBest > 0 ? Math.round((s.splitSeconds - pBest) * 1000) / 1000 : 0;
          if (oBest > 0 && s.splitSeconds <= oBest + 0.0005) {
            s.badge = "OVERALL_BEST";
          } else if (pBest > 0 && s.splitSeconds <= pBest + 0.0005) {
            s.badge = "PERSONAL_BEST";
          } else if (pBest > 0 && s.splitSeconds > pBest * 1.1) {
            s.badge = "OFF_PACE";
          } else {
            s.badge = "NORMAL";
          }
        }
      }
    };

    recomputeList(this._laps);
    const sess = this.selectedPracticeSession;
    if (sess && sess.laps !== this._laps) {
      recomputeList(sess.laps);
    }
    this.emit("laps", "practice");
  }

  public ingestRace(
    raceState: RaceTournamentState,
    eventState?: EventManagerState | null,
    announcement?: RaceAnnouncement | null,
    serverTimestampUs?: number
  ): void {
    this._raceState = normalizeRaceState(raceState);
    if (eventState) {
      this._eventState = normalizeEventState(eventState);
    }
    this._lastRaceSyncPerfMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (serverTimestampUs && serverTimestampUs > 0) {
      if (serverTimestampUs > this._latestTimestampUs) {
        this._latestTimestampUs = serverTimestampUs;
      }
      this.anchorServerClock(serverTimestampUs, false);
    }
    this.emit("race");
    if (announcement) {
      this.raceAnnouncementListeners.forEach((fn) => fn(announcement));
    }
  }

  public applyConfig(
    pilots: PilotSlot[] | null | undefined,
    nodes: TrackNode[] | null | undefined,
    timers?: DetectedTimer[] | null
  ): void {
    this._pilots = pilots ?? [];
    this.setNodes(nodes ?? []);
    if (Array.isArray(timers)) {
      this._detectedTimers = timers;
    }
    this.ensureValidSelection();
    this.emit("config");
  }

  public applyRules(rules: TimingRules): void {
    this._rules = normalizeTimingRules(rules);
    this.emit("rules");
  }

  public ingestTelemetry(frame: TimerTelemetryFrame): void {
    const hist = this.activeHistory;
    let buf = hist.get(frame.timerId);
    if (!buf) {
      buf = [];
      hist.set(frame.timerId, buf);
    }
    buf.push(frame);
    this._ingestCount = (this._ingestCount + 1) | 0;
    if (buf.length > HISTORY_SAMPLES + HISTORY_TRIM_SLACK || (this._ingestCount & 1023) === 0) {
      this.trimHistory(buf);
    }

    if (frame.timestampUs > this._latestTimestampUs) {
      this._latestTimestampUs = frame.timestampUs;
    }
    if (frame.timestampUs > this._latestTelemetryTimestampUs) {
      this._latestTelemetryTimestampUs = frame.timestampUs;
    }
    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    this._lastIngestPerfMs = nowMs;
    const speedMult = this._simulatorRunning ? Math.max(1, this._simState?.speedMultiplier || 1) : 1;
    if (this._streamAnchorPerfMs === 0) {
      this._streamAnchorBaseUs = frame.timestampUs;
      this._streamAnchorPerfMs = nowMs;
    } else {
      const elapsedUs = Math.max(0, (nowMs - this._streamAnchorPerfMs) * 1000) * speedMult;
      const predictedUs = this._streamAnchorBaseUs + elapsedUs;
      const diffUs = frame.timestampUs - predictedUs;
      if (Math.abs(diffUs) > 600_000 * speedMult) {
        this._streamAnchorBaseUs = frame.timestampUs;
        this._streamAnchorPerfMs = nowMs;
      } else if (diffUs > 0) {
        this._streamAnchorBaseUs = predictedUs + diffUs * 0.25;
        this._streamAnchorPerfMs = nowMs;
      } else {
        this._streamAnchorBaseUs = predictedUs + diffUs * 0.004;
        this._streamAnchorPerfMs = nowMs;
      }
    }
    if (frame.timestampUs > this.liveServerTimestampUs) {
      this._serverClockBaseUs = frame.timestampUs;
      this._serverClockPerfMs = nowMs;
    }
    // Up to ~700 samples/s on real hardware: format the "last seen" stamp at most every 100 ms.
    if (nowMs - this._lastSeenIsoAtMs >= 100) {
      this._lastSeenIsoAtMs = nowMs;
      this._lastSeenIso = new Date().toISOString();
    }
    const nowIso = this._lastSeenIso;
    const node = this.node(frame.timerId);
    let onlineChanged = false;
    if (node) {
      if (!node.online) onlineChanged = true;
      node.lastRssi = frame.rssi;
      node.framesRxCount = (node.framesRxCount ?? 0) + 1;
      node.online = true;
      node.lastSeenAt = nowIso;
    }
    const assignedTimerId = node?.assignedTimerId ?? frame.timerId;
    const det = this._detectedTimers.find((d) => d.timerId === assignedTimerId);
    if (det) {
      if (!det.online) onlineChanged = true;
      det.lastRssi = frame.rssi;
      det.framesRxCount = (det.framesRxCount ?? 0) + 1;
      det.online = true;
      det.lastSeenAt = nowIso;
    }
    if (onlineChanged) {
      this._stateRev = (this._stateRev + 1) | 0;
    }
  }

  /** Drops samples older than HISTORY_SECONDS behind the newest one (and caps the count). */
  private trimHistory(buf: TimerTelemetryFrame[]): void {
    const cutoffUs = buf[buf.length - 1].timestampUs - HISTORY_US;
    let drop = 0;
    if (buf[0].timestampUs < cutoffUs) {
      let lo = 0;
      let hi = buf.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (buf[mid].timestampUs < cutoffUs) lo = mid + 1;
        else hi = mid;
      }
      drop = lo;
    }
    drop = Math.max(drop, buf.length - HISTORY_SAMPLES);
    if (drop > 0) buf.splice(0, drop);
  }

  public ingestCrossing(ev: GateCrossingEvent): void {
    this._crossings.push(ev);
    if (this._crossings.length > MAX_CROSSINGS) this._crossings.shift();
    const activeSess = !this.isLiveRaceHeatRunning ? this.activePracticeSession : undefined;
    if (activeSess) {
      activeSess.crossings.push(ev);
      if (activeSess.crossings.length > MAX_CROSSINGS) activeSess.crossings.shift();
    }
    if (ev.timestampUs > this._latestTimestampUs) {
      this._latestTimestampUs = ev.timestampUs;
    }
    this.lastCrossingBySlot.set(ev.slotIndex, ev);
    this.crossingListeners.forEach((fn) => fn(ev));
    this.emit("crossings");
    if (ev.startedLap) {
      this.startGateListeners.forEach((fn) => fn(ev));
    }
  }

  public ingestFiltered(f: FilteredDetection): void {
    this._filtered.push(f);
    if (this._filtered.length > MAX_FILTERED) this._filtered.shift();
    const activeSess = !this.isLiveRaceHeatRunning ? this.activePracticeSession : undefined;
    if (activeSess) {
      activeSess.filtered.push(f);
      if (activeSess.filtered.length > MAX_FILTERED) activeSess.filtered.shift();
    }
    if (f.timestampUs > this._latestTimestampUs) {
      this._latestTimestampUs = f.timestampUs;
    }
    this.emit("crossings");
  }

  public ingestLap(lap: LapRecord, summaries: PilotTrackSummary[]): void {
    const normalized: LapRecord = Array.isArray(lap.sectors) ? lap : { ...lap, sectors: [] };
    this._laps.push(normalized);
    if (this._laps.length > MAX_LAPS) this._laps.shift();
    const activeSess = !this.isLiveRaceHeatRunning ? this.activePracticeSession : undefined;
    if (activeSess) {
      activeSess.laps.push(normalized);
      if (activeSess.laps.length > MAX_LAPS) activeSess.laps.shift();
      activeSess.summaries = summaries;
    }
    if (normalized.completedAtUs > this._latestTimestampUs) {
      this._latestTimestampUs = normalized.completedAtUs;
    }
    this._summaries = summaries;
    this.emit("laps");
    this.lapListeners.forEach((fn) => fn(normalized));
  }

  public selectPilot(slotIndex: number): void {
    if (slotIndex === this._selectedPilot) return;
    this._selectedPilot = slotIndex;
    this._comparison = { lapId: null, reference: "best" };
    this.saveUiPrefs();
    this.emit("selection");
  }

  public setComparison(next: Partial<ComparisonSelection>): void {
    this._comparison = { ...this._comparison, ...next };
    this.saveUiPrefs();
    this.emit("selection");
  }

  /** Switch the live view between all pilots (null) and following one pilot. */
  public setLiveFocus(slotIndex: number | null): void {
    const pilotChanged = slotIndex !== null && slotIndex !== this._selectedPilot;
    const focusChanged = slotIndex !== this._liveFocus;
    if (!pilotChanged && !focusChanged) return;
    if (pilotChanged) {
      this._selectedPilot = slotIndex;
      this._comparison = { lapId: null, reference: "best" };
    }
    this._liveFocus = slotIndex;
    this.saveUiPrefs();
    this.emit("selection");
  }

  private setNodes(nodes: TrackNode[] | null | undefined): void {
    this._nodes = [...(nodes ?? [])].sort((a, b) => a.trackOrder - b.trackOrder);
    this._stateRev = (this._stateRev + 1) | 0;
  }

  private ensureValidSelection(): void {
    const enabled = this.enabledPilots;
    if (enabled.length > 0 && !enabled.some((p) => p.slotIndex === this._selectedPilot)) {
      this._selectedPilot = enabled[0].slotIndex;
    }
    if (this._liveFocus !== null && !enabled.some((p) => p.slotIndex === this._liveFocus)) {
      this._liveFocus = null;
    }
  }
}
