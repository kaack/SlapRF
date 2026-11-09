import {
  DetectedTimer,
  FilteredDetection,
  FullStateResponse,
  GateCrossingEvent,
  LapRecord,
  LiveTimeStatus,
  PilotSlot,
  PilotTrackSummary,
  SimState,
  StatusResponse,
  TimerTelemetryFrame,
  TimingRules,
  TrackNode,
} from "../types/models";

/**
 * Change topics. Components subscribe only to what they render so that, for
 * example, a 50 Hz telemetry stream never re-renders a form the user is editing.
 * Raw telemetry is intentionally *not* a topic: canvases pull it every frame.
 */
export type Topic = "config" | "laps" | "crossings" | "status" | "selection" | "rules";

type Listener = () => void;
type LapListener = (lap: LapRecord) => void;
type CrossingListener = (ev: GateCrossingEvent) => void;

/** Which lap the pilot is looking at, and what it's compared against. */
export type ReferenceChoice = "best" | "previous" | number;
export interface ComparisonSelection {
  /** Lap under review (null = always the latest lap). */
  lapId: number | null;
  /** Reference: personal best, the lap before, or a specific lap id. */
  reference: ReferenceChoice;
}

/** Signal history kept per gate, so the RSSI chart can be paused and scrolled back. */
export const HISTORY_SECONDS = 120;
/** Gates stream telemetry at 50 Hz. */
const HISTORY_SAMPLES = HISTORY_SECONDS * 50;
/** Trim in batches rather than shifting one frame at a time. */
const HISTORY_TRIM_SLACK = 250;

/** Enough timed passes (and rejected ones) to cover the signal history. */
const MAX_CROSSINGS = 1500;
const MAX_FILTERED = 500;
const MAX_LAPS = 5000;

const DEFAULT_RULES: TimingRules = {
  minLapSec: 5,
  maxLapSec: 120,
  gateCooldownSec: 2,
  minSectionSec: 0.5,
  echoWindowSec: 3,
};

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
  private _simulatorRunning = false;
  private _simState: SimState | null = null;
  private _raceArmed = true;
  private _liveTime: LiveTimeStatus = {
    enabled: false,
    listenAddr: ":5403",
    connectedClients: 0,
    detectionsSent: 0,
    statusFramesSent: 0,
    lastRfSetupSync: "",
    raceArmedByHost: true,
  };
  private _latestTimestampUs = 0;
  private _latestTelemetryTimestampUs = 0;
  private _lastIngestPerfMs = 0;
  private _playheadUs = 0;
  private _lastPlayheadPerfMs = 0;
  private _selectedPilot = 1;
  /** Live view focus: null shows every pilot, a slot index follows that pilot. */
  private _liveFocus: number | null = null;
  private _comparison: ComparisonSelection = { lapId: null, reference: "best" };

  private readonly simHistory = new Map<number, TimerTelemetryFrame[]>();
  private readonly realHistory = new Map<number, TimerTelemetryFrame[]>();
  private readonly lastCrossingBySlot = new Map<number, GateCrossingEvent>();
  private readonly listeners = new Map<Topic, Set<Listener>>();
  private readonly lapListeners = new Set<LapListener>();
  private readonly startGateListeners = new Set<CrossingListener>();

  private get activeHistory(): Map<number, TimerTelemetryFrame[]> {
    return this._simulatorRunning ? this.simHistory : this.realHistory;
  }

  // ---- subscriptions -------------------------------------------------------

  /** Fires once per newly recorded lap (never on hydrate/reset) — used by the announcer. */
  public onLapRecorded(fn: LapListener): () => void {
    this.lapListeners.add(fn);
    return () => this.lapListeners.delete(fn);
  }

  /**
   * Fires when a pilot passes through the Start/Finish gate to start a lap without a previous
   * reference point (initial start pass or first pass after reset/timeout) — used by the announcer.
   */
  public onStartGateDetected(fn: CrossingListener): () => void {
    this.startGateListeners.add(fn);
    return () => this.startGateListeners.delete(fn);
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

  private emit(...topics: Topic[]): void {
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

  public get pilots(): PilotSlot[] {
    return this._pilots;
  }
  public get enabledPilots(): PilotSlot[] {
    return this._pilots.filter((p) => p.enabled);
  }
  /** Track nodes (gates) sorted by their position around the track. */
  public get nodes(): TrackNode[] {
    if (!this._simulatorRunning && this._usbTimer) {
      const usb = this._usbTimer;
      const matchedDet = this.detectedTimers.find(
        (d) =>
          (usb.fingerprint && d.fingerprint && d.fingerprint.toUpperCase() === usb.fingerprint.toUpperCase()) ||
          (usb.puckLabel && d.puckLabel.toUpperCase() === usb.puckLabel.toUpperCase()) ||
          d.puckId === usb.puckId
      );
      const targetId = matchedDet?.puckId ?? usb.puckId;
      return this._nodes.map((n) => {
        const assigned = n.assignedPuckId ?? n.puckId;
        if (assigned === targetId) {
          return {
            ...n,
            online: true,
            noiseFloorDbm: usb.noiseFloorDbm,
            lastSeenAt: usb.lastSeenAt || n.lastSeenAt,
          };
        }
        return n;
      });
    }
    return this._nodes;
  }
  public get pucks(): TrackNode[] {
    return this.nodes;
  }
  /** Physical XIAO timers discovered over Wi-Fi/ESP-NOW, flashed over USB, or currently plugged in via USB. */
  public get detectedTimers(): DetectedTimer[] {
    if (!this._simulatorRunning && this._usbTimer) {
      const usb = this._usbTimer;
      const list = this._detectedTimers.map((d) => ({ ...d }));
      const idx = list.findIndex(
        (d) =>
          (usb.fingerprint && d.fingerprint && d.fingerprint.toUpperCase() === usb.fingerprint.toUpperCase()) ||
          (usb.puckLabel && d.puckLabel.toUpperCase() === usb.puckLabel.toUpperCase()) ||
          d.puckId === usb.puckId
      );
      if (idx >= 0) {
        const existing = list[idx];
        list[idx] = {
          ...existing,
          puckLabel: usb.puckLabel || existing.puckLabel,
          isHub: usb.isHub,
          firmwareVersion: usb.firmwareVersion || existing.firmwareVersion,
          firmwareProfile: usb.firmwareProfile || existing.firmwareProfile,
          fingerprint: usb.fingerprint || existing.fingerprint,
          noiseFloorDbm: usb.noiseFloorDbm,
          batteryMv: existing.batteryMv > 0 ? existing.batteryMv : usb.batteryMv,
          batteryPct: existing.batteryPct > 0 ? existing.batteryPct : usb.batteryPct,
          online: true,
          lastSeenAt: usb.lastSeenAt || existing.lastSeenAt,
        };
      } else {
        list.push({ ...usb });
      }
      return list;
    }
    return this._detectedTimers;
  }
  public get detectedPucks(): DetectedTimer[] {
    return this.detectedTimers;
  }

  public setUsbDetectedTimer(timer: DetectedTimer | null): void {
    this._usbTimer = timer;
    this.emit("status", "config");
  }
  public get laps(): LapRecord[] {
    return this._laps;
  }
  public get crossings(): GateCrossingEvent[] {
    return this._crossings;
  }
  /** Detections set aside by the timing rules, oldest first. */
  public get filtered(): FilteredDetection[] {
    return this._filtered;
  }
  public get summaries(): PilotTrackSummary[] {
    return this._summaries;
  }
  public get rules(): TimingRules {
    return this._rules;
  }
  public get simulatorRunning(): boolean {
    return this._simulatorRunning;
  }
  public get simState(): SimState | null {
    return this._simState;
  }
  public get raceArmed(): boolean {
    return this._raceArmed;
  }
  public get liveTime(): LiveTimeStatus {
    return this._liveTime;
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
    const dtUs = Math.max(0, Math.min(100_000, (nowMs - this._lastPlayheadPerfMs) * 1000));
    this._lastPlayheadPerfMs = nowMs;
    // Target slightly behind the newest telemetry sample (~35 ms = ~1 superframe) so every gate's
    // trace stays anchored to the right edge and brief Wi-Fi jitter never stalls the playhead.
    const targetUs = latest - 35_000;
    if (this._playheadUs === 0 || Math.abs(targetUs - this._playheadUs) > 400_000) {
      this._playheadUs = targetUs;
      return Math.round(this._playheadUs);
    }
    // Advance at true wall-clock rate (`dtUs`), plus a gentle proportional nudge (4% per frame,
    // clamped to ±35% of `dtUs`) so the chart ALWAYS scrolls forward smoothly at 60 FPS and never
    // pauses between 40 ms sliding-window bursts or during minor Wi-Fi latency spikes.
    const errorUs = targetUs - (this._playheadUs + dtUs);
    const maxCorrectionUs = dtUs * 0.35;
    const correctionUs = Math.max(-maxCorrectionUs, Math.min(maxCorrectionUs, errorUs * 0.04));
    this._playheadUs += dtUs + correctionUs;
    return Math.round(this._playheadUs);
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
    return this._nodes.find((n) => n.puckId === nodeId);
  }
  public puck(nodeId: number): TrackNode | undefined {
    return this.node(nodeId);
  }
  public summaryFor(slotIndex: number): PilotTrackSummary | undefined {
    return this._summaries.find((s) => s.slotIndex === slotIndex);
  }
  public lastCrossingFor(slotIndex: number): GateCrossingEvent | undefined {
    return this.lastCrossingBySlot.get(slotIndex);
  }
  public historyFor(nodeId: number): TimerTelemetryFrame[] {
    return this.activeHistory.get(nodeId) ?? [];
  }

  // ---- mutations -----------------------------------------------------------

  public hydrate(state: FullStateResponse): void {
    const modeChanged = this._simulatorRunning !== state.simulatorRunning;
    this._pilots = state.pilots ?? [];
    this.setNodes(state.pucks ?? []);
    this._detectedTimers = state.detectedPucks ?? [];
    this._laps = state.laps ?? [];
    this._crossings = state.crossings ?? [];
    this._filtered = state.filtered ?? [];
    this._summaries = state.summaries ?? [];
    this._rules = state.rules ?? DEFAULT_RULES;
    this._simulatorRunning = state.simulatorRunning;
    this._simState = state.simState ?? null;
    this._raceArmed = state.raceArmed;
    this._liveTime = state.liveTimeStatus;
    if (modeChanged) {
      this._comparison = { lapId: null, reference: "best" };
      this._playheadUs = 0;
      this._latestTelemetryTimestampUs = 0;
      this._lastIngestPerfMs = 0;
    }

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
    this.emit("config", "laps", "crossings", "status", "selection", "rules");
  }

  public applyStatus(status: StatusResponse): void {
    const before = this._nodes.map((n) => n.puckId).join(",");
    this.setNodes(status.pucks ?? []);
    if (status.detectedPucks) {
      this._detectedTimers = status.detectedPucks;
    }
    if (status.serverTimestampUs && status.serverTimestampUs > this._latestTimestampUs) {
      this._latestTimestampUs = status.serverTimestampUs;
    }
    this._simulatorRunning = status.simulatorRunning;
    if (status.simState !== undefined) {
      this._simState = status.simState;
    } else if (!status.simulatorRunning) {
      this._simState = null;
    }
    this._raceArmed = status.raceArmed;
    this._liveTime = status.liveTimeStatus;

    const gatesChanged = before !== this._nodes.map((n) => n.puckId).join(",");
    if (gatesChanged) {
      this.ensureValidSelection();
      this.emit("status", "config");
    } else {
      this.emit("status");
    }
  }

  public applyConfig(pilots: PilotSlot[], nodes: TrackNode[]): void {
    this._pilots = pilots;
    this.setNodes(nodes);
    this.ensureValidSelection();
    this.emit("config");
  }

  public applyRules(rules: TimingRules): void {
    this._rules = rules;
    this.emit("rules");
  }

  public ingestTelemetry(frame: TimerTelemetryFrame): void {
    const hist = this.activeHistory;
    let buf = hist.get(frame.puckId);
    if (!buf) {
      buf = [];
      hist.set(frame.puckId, buf);
    }
    buf.push(frame);
    if (buf.length > HISTORY_SAMPLES + HISTORY_TRIM_SLACK) buf.splice(0, buf.length - HISTORY_SAMPLES);

    if (frame.timestampUs > this._latestTimestampUs) {
      this._latestTimestampUs = frame.timestampUs;
    }
    if (frame.timestampUs > this._latestTelemetryTimestampUs) {
      this._latestTelemetryTimestampUs = frame.timestampUs;
    }
    this._lastIngestPerfMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    const node = this.node(frame.puckId);
    if (node) node.lastRssi = frame.rssi;
  }

  public ingestCrossing(ev: GateCrossingEvent): void {
    this._crossings.push(ev);
    if (this._crossings.length > MAX_CROSSINGS) this._crossings.shift();
    if (ev.timestampUs > this._latestTimestampUs) {
      this._latestTimestampUs = ev.timestampUs;
    }
    this.lastCrossingBySlot.set(ev.slotIndex, ev);
    this.emit("crossings");
    if (ev.startedLap) {
      this.startGateListeners.forEach((fn) => fn(ev));
    }
  }

  public ingestFiltered(f: FilteredDetection): void {
    this._filtered.push(f);
    if (this._filtered.length > MAX_FILTERED) this._filtered.shift();
    if (f.timestampUs > this._latestTimestampUs) {
      this._latestTimestampUs = f.timestampUs;
    }
    this.emit("crossings");
  }

  public ingestLap(lap: LapRecord, summaries: PilotTrackSummary[]): void {
    this._laps.push(lap);
    if (this._laps.length > MAX_LAPS) this._laps.shift();
    if (lap.completedAtUs > this._latestTimestampUs) {
      this._latestTimestampUs = lap.completedAtUs;
    }
    this._summaries = summaries;
    this.emit("laps");
    this.lapListeners.forEach((fn) => fn(lap));
  }

  public selectPilot(slotIndex: number): void {
    if (slotIndex === this._selectedPilot) return;
    this._selectedPilot = slotIndex;
    this._comparison = { lapId: null, reference: "best" };
    this.emit("selection");
  }

  public setComparison(next: Partial<ComparisonSelection>): void {
    this._comparison = { ...this._comparison, ...next };
    this.emit("selection");
  }

  /** Switch the live view between all pilots (null) and following one pilot. */
  public setLiveFocus(slotIndex: number | null): void {
    if (slotIndex !== null) this.selectPilot(slotIndex);
    if (slotIndex === this._liveFocus) return;
    this._liveFocus = slotIndex;
    this.emit("selection");
  }

  private setNodes(nodes: TrackNode[]): void {
    this._nodes = [...nodes].sort((a, b) => a.trackOrder - b.trackOrder);
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
