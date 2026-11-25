import { CanvasSurface } from "../core/canvas";
import { computeDirectionalPinch, computeWheelZoomFactors, PinchPoint, scrollOuterPageBy } from "../core/chart_pinch";
import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { adaptColorForTheme, font, inkOnColor, theme, withAlpha } from "../core/theme";
import { ApiClient } from "../services/api_client";
import { playPreviewCrossingBeep } from "../services/crossing_beep";
import { suggestThreshold } from "../state/calibration";
import {
  enterThresholdAt,
  exitThresholdAt,
  gateColor,
  gateLabel,
  gateOverrideBeepMode,
  gateRulesAt,
  pilotGateOverridesAt,
  pilotGateRulesAt,
  resolveCrossingBeepMode,
} from "../state/selectors";
import { AppStore, HISTORY_SECONDS } from "../state/store";
import {
  CrossingBeepMode,
  FilterReason,
  GateRuleKey,
  GateRuleOverrides,
  GateThresholdUpdate,
  isLapRFMode,
  isRotorHazardMode,
  NumericGateRuleKey,
  TimerTelemetryFrame,
  TimingHardwareMode,
  TimingRules,
} from "../types/models";
import { FILTER_LABELS, FILTER_SHORT_CODES } from "./markup";

export interface PilotRssiLapWindow {
  /** Hard left viewport bound in microseconds (`Start - pad`). */
  minUs: number;
  /** Hard right viewport bound in microseconds (`Finish + pad`). */
  maxUs: number;
  /** Pass-visibility bounds `[passMinUs, passMaxUs]` so only crossings belonging to this lap appear. */
  passMinUs?: number;
  passMaxUs?: number;
  /** Optional initial focused timer ID (`null` = All timers). */
  initialFocusGateId?: number | null;
}

export interface PilotRssiChartOptions {
  /** "practice" (default) shows session lap/filtered counters; "race" shows active heat context. */
  contextMode?: "practice" | "race";
  /** When set, locks the chart strictly to a single lap window `[minUs, maxUs]`. */
  lapWindow?: PilotRssiLapWindow;
}

interface TuneRuleSpec {
  key: GateRuleKey;
  label: string;
  fullLabel: string;
  help: string;
  step: number;
  min: number;
  max: number;
  decimals: number;
  reason: FilterReason;
}

const OVERRIDE_KEYS: ReadonlyArray<keyof GateRuleOverrides> = [
  "minLapSec",
  "maxLapSec",
  "minCrossingSec",
];

const DEFAULT_TUNE_RULES: TimingRules = {
  minLapSec: 5,
  maxLapSec: 120,
  minCrossingSec: 0.12,
  beepOnCross: false,
  beepMode: "off",
};

const TUNE_BEEP_MODES: ReadonlyArray<{ mode: CrossingBeepMode; label: string; title: string }> = [
  { mode: "off", label: "Off", title: "No crossing beep" },
  { mode: "enter", label: "Enter", title: "Beep on Enter — as signal crosses enter threshold" },
  { mode: "peak", label: "Peak", title: "Beep on Peak — right at the signal crest over the gate" },
  { mode: "exit", label: "Exit", title: "Beep on Exit — as signal drops below exit threshold" },
];

function renderTuneBeepModeSegHtml(activeMode: CrossingBeepMode): string {
  return `<div class="scope-tune-seg beep-mode-seg" role="radiogroup" aria-label="Beep on crossing">
    ${TUNE_BEEP_MODES.map(
      (opt) => `<button
        type="button"
        role="radio"
        aria-checked="${activeMode === opt.mode}"
        class="scope-tune-seg-btn ${activeMode === opt.mode ? "is-active" : ""}"
        data-tune-beep-mode="${opt.mode}"
        title="${opt.title}"
      >${opt.label}</button>`
    ).join("")}
  </div>`;
}

function countGateOverrides(ovr: GateRuleOverrides | undefined, baseRules: TimingRules): number {
  if (!ovr) return 0;
  let n = 0;
  for (const k of OVERRIDE_KEYS) {
    if (ovr[k] !== undefined && Math.abs((ovr[k] as number) - baseRules[k as NumericGateRuleKey]) > 1e-6) {
      n++;
    }
  }
  const ovrMode = gateOverrideBeepMode(ovr);
  const baseMode = resolveCrossingBeepMode(baseRules.beepMode, baseRules.beepOnCross);
  if (ovrMode !== undefined && ovrMode !== baseMode) {
    n++;
  }
  return n;
}

function countPilotOverrides(ovr: GateRuleOverrides | undefined, gateRules: TimingRules): number {
  if (!ovr) return 0;
  let n = 0;
  for (const k of OVERRIDE_KEYS) {
    if (ovr[k] !== undefined && Math.abs((ovr[k] as number) - gateRules[k as NumericGateRuleKey]) > 1e-6) {
      n++;
    }
  }
  return n;
}

function countGlobalOverrides(rules: TimingRules): number {
  let n = 0;
  for (const spec of TUNE_RULES) {
    if (Math.abs(rules[spec.key] - DEFAULT_TUNE_RULES[spec.key]) > 1e-6) {
      n++;
    }
  }
  if (resolveCrossingBeepMode(rules.beepMode, rules.beepOnCross) !== "off") {
    n++;
  }
  return n;
}

const TUNE_RULES: TuneRuleSpec[] = [
  {
    key: "minLapSec",
    label: "Minimum lap time",
    fullLabel: "Minimum lap time (seconds)",
    help: "Shortest valid time before the same timer can count a pilot again.",
    step: 0.5,
    min: 1,
    max: 120,
    decimals: 1,
    reason: "MIN_LAP",
  },
  {
    key: "maxLapSec",
    label: "Maximum lap time",
    fullLabel: "Maximum lap time (seconds)",
    help: "Laps longer than this are discarded (crashes, landings, or pack swaps).",
    step: 5,
    min: 10,
    max: 900,
    decimals: 0,
    reason: "LAP_TOO_LONG",
  },
  {
    key: "minCrossingSec",
    label: "Minimum crossing time",
    fullLabel: "Minimum crossing time (seconds)",
    help: "Minimum signal hold duration required across the gate to reject sharp RF or Wi-Fi spikes.",
    step: 0.02,
    min: 0.04,
    max: 1.5,
    decimals: 2,
    reason: "SPIKE",
  },
];

const DBM_MIN = -100;
const DBM_MAX = -15;
const DEFAULT_Y_MIN = -95;
const DEFAULT_Y_MAX = -20;
const LAPRF_Y_ABS_MIN = 200;
const LAPRF_Y_ABS_MAX = 3550;
const LAPRF_DEFAULT_Y_MIN = 250;
const LAPRF_DEFAULT_Y_MAX = 3400;
const RH_Y_ABS_MIN = 0;
const RH_Y_ABS_MAX = 260;
const RH_DEFAULT_Y_MIN = 0;
const RH_DEFAULT_Y_MAX = 255;
const WINDOWS_SEC = [1, 15, 60, 300, 600] as const;
const DEFAULT_WINDOW_US = 15_000_000;
const MIN_WINDOW_US = 400_000;
const MAX_WINDOW_US = HISTORY_SECONDS * 1_000_000;
const LEGEND_REFRESH_MS = 150;
const MIN_CALIB_SPIN_MS = 480;
/** How close (px) the cursor must be to a pass marker to show its details. */
const MARKER_HIT_PX = 7;
/** Threshold tags: pill height and vertical spacing. */
const TAG_H = 18;
const TAG_GAP = 4;
/** Room on the right for the threshold tags. */
const TAG_GUTTER = 84;
const RSSI_CHART_STORAGE_KEY = "slaprf.ui.rssi_chart.v1";

const PAD = { l: 46, r: 16 + TAG_GUTTER, t: 12, b: 26 };

/** A pass the pilot made through a gate: timed, or set aside by the timing rules. */
interface PassMarker {
  ts: number;
  origTs?: number;
  eventId?: number;
  gateId: number;
  counted: boolean;
  title: string;
  detail: string;
  color?: string;
  slotIndex?: number;
}

/** Where a gate's threshold tag was drawn, for hit-testing drags. */
interface TagBox {
  gateId: number;
  kind: "enter" | "exit";
  x: number;
  y: number;
  w: number;
  lineY: number;
}

/** Where a timed crossing handle & vertical line were drawn when paused on a single timer. */
interface CrossingBox {
  eventId: number;
  gateId: number;
  slotIndex: number;
  origTsUs: number;
  tsUs: number;
  title: string;
  counted: boolean;
  lineX: number;
  pillX: number;
  pillY: number;
  pillW: number;
  delX: number;
  delY: number;
  delW: number;
}

interface LiveCrossingEval {
  effTs: number;
  counted: boolean;
  invalidReason: FilterReason | null;
  invalidDetail: string;
  suffix: string;
  detailPrefix: string;
}

type RssiDragState =
  | {
      mode: "pan";
      startX: number;
      startY: number;
      startEndUs: number;
      startYMin: number;
      startYMax: number;
    }
  | {
      mode: "xstretch";
      startX: number;
      startEndUs: number;
      startWindowUs: number;
      anchorFrac: number;
    }
  | {
      mode: "ystretch";
      startY: number;
      startYMin: number;
      startYMax: number;
      anchorFrac: number;
    }
  | {
      mode: "ybox";
      startY: number;
    };

/**
 * The selected pilot's 5.8 GHz signal as seen by every gate, and the place to calibrate
 * detection. "All gates" overlays every trace without thresholds, to keep it readable;
 * picking one gate (above the chart, or by clicking its chip below) shows just that trace
 * with its threshold line, which you drag to adjust — or let Auto-calibrate work it out from
 * the recent signal.
 *
 * Supports the same X and Y axis controls and axis-stretching gestures as the Debug charts:
 * - X and Y axis split-pill presets (`Auto X`, `1s..2m`, `Auto Y`, `Noise floor`, `Full scale`)
 * - Drag left Y-axis to stretch/shrink dBm scale; drag bottom X-axis to stretch/shrink time scale
 * - Drag plot to pan X (time) and Y (dBm); Shift+drag to box-zoom Y; double-click to reset axes
 */
export class PilotRssiChart extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private readonly contextMode: "practice" | "race";
  private lapWindow: {
    minUs: number;
    maxUs: number;
    passMinUs: number;
    passMaxUs: number;
  } | null = null;
  private readonly lapWindowAllowedEventIds = new Set<number>();
  private windowUs = DEFAULT_WINDOW_US;
  private autoX = true;
  private autoY = true;
  private yMin = DEFAULT_Y_MIN;
  private yMax = DEFAULT_Y_MAX;
  private smoothYMin: number | null = null;
  private smoothYMax: number | null = null;
  private openAxisMenu: "rssi-x" | "rssi-y" | null = null;
  /** End of the visible window; null follows live. */
  private endUs: number | null = null;
  /** Latest timestamp at the moment of pausing — the zero point of the axis while paused. */
  private refUs = 0;
  private hoverX: number | null = null;
  private hoverY: number | null = null;
  private drag: RssiDragState | null = null;
  private yZoomBox: { y0: number; y1: number } | null = null;
  /** Threshold being dragged, with its live value. */
  private tagDrag: { gateId: number; kind: "enter" | "exit"; dbm: number } | null = null;
  /** Crossing line being dragged left/right while paused on a focused timer. */
  private crossingDrag: {
    eventId: number;
    gateId: number;
    slotIndex: number;
    title: string;
    origTsUs: number;
    tsUs: number;
    minTsUs: number;
    maxTsUs: number;
    grabOffsetPx: number;
  } | null = null;
  /** Optimistic crossing timestamps while a PATCH is in flight, so the line never snaps back. */
  private readonly pendingCrossings = new Map<number, number>();
  private readonly pendingDeletedCrossings = new Set<number>();
  private pendingDeleteCrossing: { box: CrossingBox; startX: number; startY: number } | null = null;
  private crossingBoxes: CrossingBox[] = [];
  /** Values shown while a save is in flight, so the line doesn't jump back. */
  private readonly pending = new Map<number, { enter: number; exit: number }>();
  private readonly calibratingGates = new Set<number>();
  private readonly calibSpinTimers = new Set<number>();
  private readonly calibReadyCache = new Map<
    string,
    { ok: boolean; checkedAtMs: number; frameCount: number; passCount: number }
  >();
  private tags: TagBox[] = [];
  private calibMessage = "";
  private calibMessageShort = "";
  /** Selected timer IDs; empty = "All timers", 1 = single focused timer, 2+ = multi-timer comparison. */
  private readonly selectedGates = new Set<number>();
  /** When true (default), threshold lines and crossing lines cannot be dragged accidentally while scrolling. */
  private chartLinesLocked = true;
  private lastOverlayActionsSig = "";
  private liveEvalSig = "";
  private readonly liveEvalByEventId = new Map<number, LiveCrossingEval>();
  /** Optional explicit pilot slot override (e.g. when embedded in Race Control). */
  private pilotSlotOverride: number | null = null;
  /** Optional multi-pilot overlay mode ("All" seated pilots in Race Control). */
  private multiPilotSlots: number[] | null = null;
  /** Plot geometry from the last frame, for mapping pointer positions to time and dBm. */
  private plot = { x: PAD.l, w: 1, h: 1 };
  private lastHardwareMode: TimingHardwareMode = "slaprf";
  private autoYHoldUntilMs = 0;
  private lastLegendStructSig = "";
  private lastFastLegendKey = "";
  private legendScrollingUntilMs = 0;
  private readonly legendRowDomByGate = new Map<
    number,
    { chipEl: HTMLElement; dbmEl: HTMLElement; lastHot: boolean; lastText: string }
  >();
  private mobileLayoutCached = false;
  private gateMetaRev = -1;
  private readonly gateMetaById = new Map<number, { label: string; color: string }>();
  private lastAxisControlsHtml = "";
  private lastCalibHtml = "";
  private lastTuneDrawerHtml = "";
  private lastDragReadoutText: string | null = null;
  private readonly tuneDrawerEl: HTMLElement;
  private tuningGateId: number | null = null;
  private tuneDrawerOpen = false;
  private tuningScope: "pilot" | "gate" = "pilot";
  private tuneDrawerClosing = false;
  private tuneDrawerCloseTimer: number | null = null;
  private readonly labelWidthCache = new Map<string, number>();
  private cachedLabelSig = "";
  private cachedLabelRows = new Map<string, number>();
  private crossingLapCacheRev = -1;
  private readonly crossingLapMeta = new Map<string, { suffix: string; detailPrefix: string }>();

  private get hwMode(): TimingHardwareMode {
    return this.store.timingHardwareMode;
  }
  private get isLapRF(): boolean {
    return isLapRFMode(this.hwMode);
  }
  private get isRH(): boolean {
    return isRotorHazardMode(this.hwMode);
  }
  private get unitSuffix(): string {
    return this.isLapRF || this.isRH ? "" : " dBm";
  }
  private get absYMin(): number {
    return this.isLapRF ? LAPRF_Y_ABS_MIN : this.isRH ? RH_Y_ABS_MIN : DBM_MIN;
  }
  private get absYMax(): number {
    return this.isLapRF ? LAPRF_Y_ABS_MAX : this.isRH ? RH_Y_ABS_MAX : DBM_MAX;
  }
  private get defYMin(): number {
    return this.isLapRF ? LAPRF_DEFAULT_Y_MIN : this.isRH ? RH_DEFAULT_Y_MIN : DEFAULT_Y_MIN;
  }
  private get defYMax(): number {
    return this.isLapRF ? LAPRF_DEFAULT_Y_MAX : this.isRH ? RH_DEFAULT_Y_MAX : DEFAULT_Y_MAX;
  }
  private syncHardwareModeScale(): void {
    if (this.lastHardwareMode === this.hwMode) return;
    this.lastHardwareMode = this.hwMode;
    this.autoY = true;
    this.yMin = this.defYMin;
    this.yMax = this.defYMax;
    this.smoothYMin = null;
    this.smoothYMax = null;
  }

  private get isMultiPilotMode(): boolean {
    return Boolean(this.multiPilotSlots && this.multiPilotSlots.length > 0);
  }

  /** Single selected timer ID when exactly 1 timer is checked, otherwise null ("All" or 2+ compared timers). */
  private get focus(): number | null {
    return this.selectedGates.size === 1 ? this.selectedGates.values().next().value ?? null : null;
  }

  private set focus(gateId: number | null) {
    this.selectedGates.clear();
    if (gateId !== null && gateId > 0) {
      this.selectedGates.add(gateId);
    }
  }

  private get selectedGatesKey(): string {
    return this.selectedGates.size === 0
      ? "all"
      : Array.from(this.selectedGates)
          .sort((a, b) => a - b)
          .join(",");
  }

  /** True when a single timer is selected and the chart lines lock has been unlocked. */
  private get canEditLines(): boolean {
    return !this.chartLinesLocked && this.focus !== null && !this.isMultiPilotMode && !this.store.isHistoricalTrack;
  }

  /** True when unlocked on a single timer and paused (or viewing a stopped Practice pack), enabling crossing-line dragging & deletion. */
  private get canEditCrossings(): boolean {
    const canModifyCrossings =
      !this.chartLinesLocked &&
      this.focus !== null &&
      !this.isMultiPilotMode &&
      (this.contextMode === "practice" || !this.store.isHistoricalTrack);
    return canModifyCrossings && (this.endUs !== null || !this.store.isScopeLive);
  }

  private get activePilotSlot(): number {
    if (this.multiPilotSlots && this.multiPilotSlots.length > 0) {
      return this.multiPilotSlots[0];
    }
    return this.pilotSlotOverride !== null ? this.pilotSlotOverride : this.store.selectedPilot;
  }

  public setPilotSlotOverride(slotIndex: number | null): void {
    if (this.pilotSlotOverride === slotIndex && !this.isMultiPilotMode) {
      this.renderTuningDrawer();
      return;
    }
    this.pilotSlotOverride = slotIndex;
    if (slotIndex !== null) {
      this.multiPilotSlots = null;
    }
    this.tags = [];
    this.calibMessage = "";
    this.calibMessageShort = "";
    this.smoothYMin = null;
    this.smoothYMax = null;
    this.renderControls();
    this.renderCalib();
    this.renderLegend();
    this.renderTuningDrawer();
  }

  public setMultiPilotSlots(slotIndices: number[] | null): void {
    const next =
      slotIndices && slotIndices.length > 0
        ? Array.from(new Set(slotIndices.filter((n) => n > 0)))
        : null;
    const prev = this.multiPilotSlots;
    const same =
      (prev === null && next === null) ||
      (prev !== null &&
        next !== null &&
        prev.length === next.length &&
        prev.every((v, idx) => v === next[idx]));
    if (same) {
      this.renderTuningDrawer();
      return;
    }
    this.multiPilotSlots = next;
    if (next !== null) {
      this.pilotSlotOverride = null;
    }
    this.tags = [];
    this.calibMessage = "";
    this.calibMessageShort = "";
    this.smoothYMin = null;
    this.smoothYMax = null;
    this.renderControls();
    this.renderCalib();
    this.renderLegend();
    this.renderTuningDrawer();
  }

  private computeIsMobileLayout(): boolean {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 860px)").matches
    );
  }

  private get isMobileLayout(): boolean {
    return this.mobileLayoutCached;
  }

  private get padL(): number {
    return this.isMobileLayout ? 26 : PAD.l;
  }

  private get padT(): number {
    return this.isMobileLayout ? 6 : PAD.t;
  }

  /** Right padding: threshold tags now sit inside the right edge of the plot. */
  private get padR(): number {
    return this.isMobileLayout ? 4 : 16;
  }

  /** The gates drawn on the chart: all of them, or the checked timer subset. */
  private get shownGates() {
    return this.selectedGates.size === 0
      ? this.store.nodes
      : this.store.nodes.filter((p) => this.selectedGates.has(p.gateId));
  }

  constructor(el: HTMLElement, store: AppStore, api: ApiClient, options?: PilotRssiChartOptions) {
    super(el);
    this.store = store;
    this.api = api;
    this.contextMode = options?.contextMode ?? "practice";
    this.mobileLayoutCached = this.computeIsMobileLayout();
    if (options?.lapWindow) {
      const minUs = Math.max(0, Math.round(options.lapWindow.minUs));
      const maxUs = Math.max(minUs + MIN_WINDOW_US, Math.round(options.lapWindow.maxUs));
      this.lapWindow = {
        minUs,
        maxUs,
        passMinUs: Math.max(minUs, Math.round(options.lapWindow.passMinUs ?? minUs)),
        passMaxUs: Math.min(maxUs, Math.round(options.lapWindow.passMaxUs ?? maxUs)),
      };
      this.autoX = true;
      this.windowUs = this.defaultWindowUs;
      this.refUs = maxUs;
      this.endUs = maxUs;
      if (options.lapWindow.initialFocusGateId !== undefined) {
        this.focus = options.lapWindow.initialFocusGateId;
      }
    } else {
      this.loadChartPrefs();
    }
    el.classList.add("scope-root");
    if (this.lapWindow) {
      el.classList.add("is-lap-locked");
    }
    el.innerHTML = `
      <div class="scope-graph-box">
        <div class="scope-toolbar">
          <div class="scope-chart-left-actions" data-slot="chart-left-actions"${this.lapWindow ? "" : " hidden"}>
            <button class="scope-chart-action-btn" type="button" data-act="reset-view" title="Reset X and Y axes to full lap view" aria-label="Reset view">${icons.maximize(14)}</button>
          </div>
          <div class="scope-transport" role="group" aria-label="Signal playback and pass navigation"${this.lapWindow ? " hidden" : ""}>
            <button class="btn btn-sm btn-ghost scope-step-btn" type="button" data-act="prev" title="Previous pass (←)">
              ${icons.chevronLeft(16)}<span class="scope-step-text-full">Prev pass</span><span class="scope-step-text-short">Prev</span>
            </button>
            <button class="btn btn-sm scope-live-btn" type="button" data-act="live"${this.lapWindow ? " hidden" : ""}></button>
            <button class="btn btn-sm btn-ghost scope-step-btn" type="button" data-act="next" title="Next pass (→)">
              <span class="scope-step-text-full">Next pass</span><span class="scope-step-text-short">Next</span>${icons.chevronRight(16)}
            </button>
          </div>
          <div class="scope-chart-overlay-actions" data-slot="chart-actions" hidden>
            <button class="scope-chart-action-btn" type="button" data-act="add-crossing" title="Unlock chart lines to add crossings" aria-label="Add crossing" disabled>${icons.plus(15)}</button>
            <button class="scope-chart-action-btn is-locked" type="button" data-act="toggle-chart-lock" aria-pressed="false" title="Unlock chart lines to adjust thresholds or crossings" aria-label="Unlock chart lines">${icons.lock(14)}</button>
          </div>
          <span class="scope-ai-chip" data-slot="ai-chip" hidden></span>
        </div>
        <div class="canvas-host canvas-host-md scope-canvas" data-slot="chart" tabindex="0"
             aria-label="Signal chart. Space pauses, arrow keys jump between passes."></div>
        <div class="scope-bottom-bar">
          <div class="scope-axis-controls" data-slot="axis-controls" role="group" aria-label="X and Y axis scale controls"></div>
          <span class="scope-hint" data-slot="hint"></span>
          <span class="scope-drag-readout mono" data-slot="drag-readout" hidden></span>
        </div>
      </div>
      <div class="channel-legend" data-slot="legend"></div>
      <div class="scope-calib" data-slot="calib"></div>
      <div class="scope-tune-drawer is-mobile-closed" data-slot="tune-drawer"></div>`;

    this.tuneDrawerEl = this.slot("tune-drawer");
    this.onDispose(() => {
      if (this.tuneDrawerCloseTimer !== null) {
        window.clearTimeout(this.tuneDrawerCloseTimer);
        this.tuneDrawerCloseTimer = null;
      }
      for (const tid of this.calibSpinTimers) {
        window.clearTimeout(tid);
      }
      this.calibSpinTimers.clear();
      this.calibratingGates.clear();
      if (this.tuneDrawerEl.parentElement && this.tuneDrawerEl.parentElement !== this.el) {
        this.tuneDrawerEl.remove();
      }
    });

    const host = this.slot("chart");
    const surface = new CanvasSurface(host, (ctx, w, h) => this.draw(ctx, w, h));
    this.onDispose(() => surface.destroy());

    // Close open axis dropdown menu when clicking outside
    this.listen(window as unknown as HTMLElement, "pointerdown", (e: PointerEvent) => {
      if (!this.openAxisMenu) return;
      const target = e.target as HTMLElement | null;
      if (target && target.closest("[data-axis-pill]")) return;
      this.openAxisMenu = null;
      this.renderControls();
    });

    const handleTuneClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>(
        "[data-tune-scope], [data-tune-act], [data-tune-beep-mode], [data-tune-step], [data-tune-reset-key], [data-tune-override-toggle]"
      );
      if (!btn) return;
      if (btn.dataset.tuneScope) {
        const nextScope = btn.dataset.tuneScope === "gate" ? "gate" : "pilot";
        if (this.tuningScope !== nextScope) {
          this.tuningScope = nextScope;
          this.renderTuningDrawer();
        }
        return;
      }
      if (btn.dataset.tuneAct === "close") {
        this.dismissMobileTuneDrawer();
        return;
      }
      if (btn.dataset.tuneAct === "restore-defaults") {
        void this.restoreScopeTuneDefaults();
        return;
      }
      if (btn.dataset.tuneBeepMode) {
        void this.setTuneBeepMode(btn.dataset.tuneBeepMode as CrossingBeepMode);
        return;
      }
      if (btn.dataset.tuneAct === "reset-beep") {
        void this.resetTuneBeep();
        return;
      }
      if (btn.dataset.tuneOverrideToggle) {
        const key = btn.dataset.tuneOverrideToggle as GateRuleKey;
        const row = btn.closest<HTMLElement>(".rule-row");
        const input = row?.querySelector<HTMLInputElement>(`input[data-tune-input="${key}"]`);
        if (row && input) {
          if (input.disabled) {
            input.disabled = false;
            row.classList.add("is-overridden");
            input.focus();
            const raw = Number(input.value);
            if (Number.isFinite(raw)) {
              void this.applyTuneRuleValue(key, raw);
            }
          } else {
            void this.resetSingleTuneRule(key);
          }
        }
        return;
      }
      if (btn.dataset.tuneResetKey) {
        void this.resetSingleTuneRule(btn.dataset.tuneResetKey as GateRuleKey);
        return;
      }
      if (btn.dataset.tuneStep && btn.dataset.tuneKey) {
        const deltaDir = Number(btn.dataset.tuneStep);
        const key = btn.dataset.tuneKey as GateRuleKey;
        void this.stepTuneRule(key, deltaDir);
      }
    };
    this.listen(this.tuneDrawerEl, "click", handleTuneClick);

    let drawerSwipeStartY: number | null = null;
    this.listen(this.tuneDrawerEl, "pointerdown", (e: PointerEvent) => {
      if (!this.isMobileLayout || !this.tuneDrawerOpen || this.tuneDrawerClosing) return;
      const target = e.target as HTMLElement | null;
      if (!target || !target.closest(".scope-tune-mobile-handle-bar, .scope-tune-head")) return;
      if (target.closest("button:not(.pilot-dir-mobile-drawer-handle)")) return;
      if (e.button !== 0 && e.pointerType === "mouse") return;
      drawerSwipeStartY = e.clientY;
    });
    this.listen(window as unknown as HTMLElement, "pointermove", (e: PointerEvent) => {
      if (drawerSwipeStartY === null) return;
      const dy = e.clientY - drawerSwipeStartY;
      if (dy >= 22) {
        drawerSwipeStartY = null;
        this.dismissMobileTuneDrawer();
      }
    });
    const endDrawerSwipe = () => {
      drawerSwipeStartY = null;
    };
    this.listen(window as unknown as HTMLElement, "pointerup", endDrawerSwipe);
    this.listen(window as unknown as HTMLElement, "pointercancel", endDrawerSwipe);

    this.listen(this.tuneDrawerEl, "focusin", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement) || !target.dataset.tuneInput) return;
      target.dataset.originalValue = target.value;
    });

    this.listen(this.tuneDrawerEl, "beforeinput", (e: InputEvent) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement) || !target.dataset.tuneInput) return;
      if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") {
        e.preventDefault();
        target.blur();
      }
    });

    this.listen(this.tuneDrawerEl, "focusout", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement) || !target.dataset.tuneInput) return;
      const trimmed = target.value.trim();
      if (trimmed === "" && target.dataset.originalValue !== undefined) {
        target.value = target.dataset.originalValue;
        return;
      }
      const key = target.dataset.tuneInput as GateRuleKey | undefined;
      if (key && trimmed !== "" && trimmed !== target.dataset.originalValue) {
        const raw = Number(trimmed);
        if (Number.isFinite(raw)) {
          target.dataset.originalValue = trimmed;
          void this.applyTuneRuleValue(key, raw);
        }
      }
    });

    this.listen(this.tuneDrawerEl, "change", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      const key = target.dataset.tuneInput as GateRuleKey | undefined;
      if (!key) return;
      if (target.value.trim() === "") return;
      const raw = Number(target.value);
      if (!Number.isFinite(raw)) return;
      target.dataset.originalValue = target.value.trim();
      void this.applyTuneRuleValue(key, raw);
    });

    this.listen(this.tuneDrawerEl, "keydown", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement) || !target.dataset.tuneInput) return;
      if (e.key === "Enter" || e.keyCode === 13) {
        e.preventDefault();
        target.blur();
      } else if (e.key === "Escape") {
        target.value = target.dataset.originalValue ?? target.defaultValue;
        target.blur();
      }
    });

    this.listen(el, "click", (e) => {
      if (this.tuneDrawerEl.contains(e.target as Node)) return;
      const btn = (e.target as HTMLElement).closest<HTMLElement>(
        "[data-gate-check], [data-act], [data-window], [data-axis-act], [data-calib], [data-calib-gate], [data-tune-gate], [data-focus]"
      );
      if (!btn) return;
      if (btn.dataset.gateCheck) {
        e.stopPropagation();
        const gId = Number(btn.dataset.gateCheck);
        if (Number.isFinite(gId) && gId > 0) {
          if (this.selectedGates.has(gId)) {
            this.selectedGates.delete(gId);
          } else {
            this.selectedGates.add(gId);
          }
          if (this.focus === null) {
            this.tuneDrawerOpen = false;
            this.tuningGateId = null;
          } else if (this.tuneDrawerOpen) {
            this.tuningGateId = this.focus;
          } else {
            this.tuningGateId = null;
          }
          this.calibMessage = "";
          this.calibMessageShort = "";
          this.saveChartPrefs();
          this.renderControls();
          this.renderCalib();
          this.renderLegend();
          this.renderTuningDrawer();
        }
        return;
      }
      if (btn.dataset.calibGate) {
        e.stopPropagation();
        if (btn.dataset.calibBusy === "1" || btn.getAttribute("aria-disabled") === "true") {
          return;
        }
        const rawGate = btn.dataset.calibGate;
        const gId = rawGate === "all" ? null : Number(rawGate);
        if (gId !== null && this.calibratingGates.has(gId)) {
          return;
        }
        const mode = btn.dataset.calibMode === "reset" ? "reset" : "auto";
        if (gId !== null && this.focus !== gId) {
          this.focus = gId;
          if (this.tuneDrawerOpen) {
            this.tuningGateId = gId;
          }
          this.saveChartPrefs();
        }
        if (mode === "reset") {
          void this.resetToDefault(gId);
        } else {
          void this.autoCalibrate(gId);
        }
        this.renderControls();
        this.renderCalib();
        this.renderLegend();
        this.renderTuningDrawer();
        return;
      }
      if (btn.dataset.tuneGate) {
        e.stopPropagation();
        const rawGate = btn.dataset.tuneGate;
        const gId = rawGate === "all" ? null : Number(rawGate);
        if (this.tuneDrawerOpen && this.tuningGateId === gId && !this.tuneDrawerClosing) {
          this.dismissMobileTuneDrawer();
          return;
        }
        if (this.tuneDrawerCloseTimer !== null) {
          window.clearTimeout(this.tuneDrawerCloseTimer);
          this.tuneDrawerCloseTimer = null;
        }
        this.tuneDrawerClosing = false;
        this.tuneDrawerEl.classList.remove("is-closing");
        this.tuneDrawerOpen = true;
        this.tuningGateId = gId;
        if (gId !== null && this.focus !== gId) {
          this.focus = gId;
          this.calibMessage = "";
          this.calibMessageShort = "";
          this.saveChartPrefs();
        }
        if (
          document.activeElement instanceof HTMLElement &&
          this.tuneDrawerEl.contains(document.activeElement)
        ) {
          document.activeElement.blur();
        }
        this.renderControls();
        this.renderCalib();
        this.renderLegend();
        this.renderTuningDrawer();
        return;
      }
      if (btn.dataset.focus) {
        if (
          document.activeElement instanceof HTMLElement &&
          this.tuneDrawerEl.contains(document.activeElement)
        ) {
          document.activeElement.blur();
        }
        this.focus = btn.dataset.focus === "all" ? null : Number(btn.dataset.focus);
        if (this.focus === null) {
          this.tuneDrawerOpen = false;
          this.tuningGateId = null;
        } else if (this.tuneDrawerOpen) {
          this.tuningGateId = this.focus;
        } else {
          this.tuningGateId = null;
        }
        this.calibMessage = "";
        this.calibMessageShort = "";
        this.saveChartPrefs();
        this.renderControls();
        this.renderCalib();
        this.renderLegend();
        this.renderTuningDrawer();
      } else if (btn.dataset.axisAct === "toggle-menu") {
        const menu = btn.dataset.menu as "rssi-x" | "rssi-y";
        this.openAxisMenu = this.openAxisMenu === menu ? null : menu;
        this.renderControls();
      } else if (btn.dataset.axisAct === "auto-x") {
        this.autoX = true;
        this.windowUs = this.defaultWindowUs;
        if (this.lapWindow) {
          this.refUs = this.lapWindow.maxUs;
          this.endUs = this.lapWindow.maxUs;
        }
        this.openAxisMenu = null;
        this.saveChartPrefs();
        this.renderControls();
      } else if (btn.dataset.axisAct === "auto-y") {
        this.autoY = true;
        this.smoothYMin = null;
        this.smoothYMax = null;
        this.openAxisMenu = null;
        this.saveChartPrefs();
        this.renderControls();
      } else if (btn.dataset.axisAct === "floor-y") {
        this.autoY = false;
        this.yMin = this.isLapRF ? 250 : this.isRH ? 0 : -98;
        this.yMax = this.isLapRF ? 1400 : this.isRH ? 110 : -64;
        this.smoothYMin = this.yMin;
        this.smoothYMax = this.yMax;
        this.openAxisMenu = null;
        this.saveChartPrefs();
        this.renderControls();
      } else if (btn.dataset.axisAct === "full-y") {
        this.autoY = false;
        this.yMin = this.defYMin;
        this.yMax = this.defYMax;
        this.smoothYMin = this.yMin;
        this.smoothYMax = this.yMax;
        this.openAxisMenu = null;
        this.saveChartPrefs();
        this.renderControls();
      } else if (btn.dataset.window) {
        this.openAxisMenu = null;
        this.setWindow(Number(btn.dataset.window) * 1e6, false);
      } else if (btn.dataset.calib === "auto") void this.autoCalibrate();
      else if (btn.dataset.calib === "reset") void this.resetToDefault();
      else if (btn.dataset.act === "reset-view") this.resetAxesToAuto();
      else if (btn.dataset.act === "toggle-chart-lock") this.toggleChartLock();
      else if (btn.dataset.act === "add-crossing") void this.addManualCrossing();
      else if (btn.dataset.act === "live") this.toggleLive();
      else if (btn.dataset.act) this.jump(btn.dataset.act === "prev" ? -1 : 1);
    });

    this.listen(el, "keydown", (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (
        target.hasAttribute("data-calib-gate") ||
        target.hasAttribute("data-tune-gate") ||
        target.hasAttribute("data-gate-check")
      ) {
        e.preventDefault();
        e.stopPropagation();
        target.click();
      }
    });

    this.listen(host, "keydown", (e) => {
      if (e.key === " ") this.toggleLive();
      else if (e.key === "ArrowLeft") this.jump(-1);
      else if (e.key === "ArrowRight") this.jump(1);
      else return;
      e.preventDefault();
    });

    let lastTapTime = 0;
    let lastTapX = 0;
    let lastTapY = 0;
    let tapCandidate: {
      pointerId: number;
      startX: number;
      startY: number;
      startMs: number;
      moved: boolean;
    } | null = null;
    const touchPts = new Map<number, PinchPoint & { clientX: number; clientY: number }>();
    let pinchState: {
      id1: number;
      id2: number;
      p1Start: PinchPoint;
      p2Start: PinchPoint;
      p1ClientStart: PinchPoint;
      p2ClientStart: PinchPoint;
      lastMidClientY: number;
      pageScrollLocked: boolean;
      pinchLocked: boolean;
      wasLive: boolean;
      startEndUs: number;
      startWindowUs: number;
      startYMin: number;
      startYMax: number;
      anchorXFrac: number;
      anchorYFrac: number;
    } | null = null;

    this.listen(host, "dblclick", (e) => {
      if ((e.target as HTMLElement | null)?.closest("[data-slot='chart-actions']")) return;
      this.resetAxesToAuto();
    });

    const onWheel = (e: WheelEvent) => {
      const wf = computeWheelZoomFactors(e);
      if (!wf) return;
      e.preventDefault();
      const r = host.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const xFrac = Math.max(0, Math.min(1, (x - this.padL) / Math.max(10, this.plot.w)));
      const yFrac = Math.max(0, Math.min(1, 1 - (y - this.padT) / Math.max(10, this.plot.h)));

      if (wf.mode === "x" || wf.mode === "xy") {
        const prevWin = this.windowUs;
        const prevEnd = this.viewEnd();
        const nextWin = Math.max(MIN_WINDOW_US, Math.min(this.maxAllowedWindowUs, prevWin * wf.xSpanFactor));
        this.autoX = Boolean(this.lapWindow && Math.abs(nextWin - this.maxAllowedWindowUs) < 5_000);
        this.windowUs = nextWin;
        if (this.endUs !== null) {
          const anchorUs = prevEnd - (1 - xFrac) * prevWin;
          this.endUs = this.clampEnd(anchorUs + (1 - xFrac) * nextWin);
        }
      }
      if (wf.mode === "y" || wf.mode === "xy") {
        this.applyDbmStretch(this.yMin, this.yMax, yFrac, wf.ySpanFactor);
      }
      this.saveChartPrefs();
      this.renderControls();
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    this.onDispose(() => host.removeEventListener("wheel", onWheel));

    this.listen(host, "pointerdown", (e) => {
      if ((e.target as HTMLElement | null)?.closest("[data-slot='chart-actions']")) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;

      try {
        host.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic / already-released pointers can't be captured; dragging still works.
      }
      const r = host.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;

      if (e.pointerType === "touch") {
        touchPts.set(e.pointerId, { x, y, clientX: e.clientX, clientY: e.clientY });
        if (touchPts.size === 1) {
          tapCandidate = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            startMs: performance.now(),
            moved: false,
          };
        } else {
          tapCandidate = null;
          lastTapTime = 0;
        }
        if (touchPts.size >= 2) {
          this.tagDrag = null;
          this.crossingDrag = null;
          this.drag = null;
          this.yZoomBox = null;
          this.hoverX = null;
          this.hoverY = null;
          host.classList.remove("is-over-crossing");
          const [[id1, pt1], [id2, pt2]] = Array.from(touchPts.entries());
          const midX = (pt1.x + pt2.x) * 0.5;
          const midY = (pt1.y + pt2.y) * 0.5;
          pinchState = {
            id1,
            id2,
            p1Start: { x: pt1.x, y: pt1.y },
            p2Start: { x: pt2.x, y: pt2.y },
            p1ClientStart: { x: pt1.clientX, y: pt1.clientY },
            p2ClientStart: { x: pt2.clientX, y: pt2.clientY },
            lastMidClientY: (pt1.clientY + pt2.clientY) * 0.5,
            pageScrollLocked: false,
            pinchLocked: false,
            wasLive: this.endUs === null,
            startEndUs: this.viewEnd(),
            startWindowUs: this.windowUs,
            startYMin: this.yMin,
            startYMax: this.yMax,
            anchorXFrac: Math.max(0, Math.min(1, (midX - this.padL) / Math.max(10, this.plot.w))),
            anchorYFrac: Math.max(0, Math.min(1, 1 - (midY - this.padT) / Math.max(10, this.plot.h))),
          };
          host.classList.add("is-dragging");
          return;
        }
      }

      this.hoverX = x;
      this.hoverY = y;
      const isTouch = e.pointerType === "touch";

      const grabbedBox = this.tagBoxAt(x, y, isTouch);
      if (grabbedBox !== null) {
        const curDbm =
          grabbedBox.kind === "enter"
            ? this.thresholdOf(grabbedBox.gateId).dbm
            : this.exitThresholdOf(grabbedBox.gateId).dbm;
        this.tagDrag = { gateId: grabbedBox.gateId, kind: grabbedBox.kind, dbm: curDbm };
        return;
      }

      const grabbedCrossing = this.crossingAt(x, y, isTouch);
      if (grabbedCrossing !== null) {
        if (grabbedCrossing.inDelete) {
          this.pendingDeleteCrossing = { box: grabbedCrossing.box, startX: x, startY: y };
          host.classList.add("is-over-crossing-delete");
          return;
        }
        const bounds = this.crossingBoundsFor(
          grabbedCrossing.box.eventId,
          grabbedCrossing.box.slotIndex,
          grabbedCrossing.box.gateId,
          grabbedCrossing.box.origTsUs
        );
        this.crossingDrag = {
          eventId: grabbedCrossing.box.eventId,
          gateId: grabbedCrossing.box.gateId,
          slotIndex: grabbedCrossing.box.slotIndex,
          title: grabbedCrossing.box.title,
          origTsUs: grabbedCrossing.box.origTsUs,
          tsUs: grabbedCrossing.box.tsUs,
          minTsUs: bounds.minTsUs,
          maxTsUs: bounds.maxTsUs,
          grabOffsetPx: grabbedCrossing.inPill ? x - grabbedCrossing.box.lineX : 0,
        };
        host.classList.add("is-dragging", "is-over-crossing");
        return;
      }

      const yAxisW = isTouch ? (this.isMobileLayout ? 36 : 54) : this.padL;
      const xAxisH = isTouch ? 34 : PAD.b;

      if (x < yAxisW) {
        // Dragging on left Y-axis stretches/shrinks the dBm scale smoothly
        const yFrac = Math.max(0, Math.min(1, 1 - (y - this.padT) / Math.max(10, this.plot.h)));
        this.drag = {
          mode: "ystretch",
          startY: y,
          startYMin: this.yMin,
          startYMax: this.yMax,
          anchorFrac: yFrac,
        };
        host.classList.add("is-dragging", "is-over-yaxis");
        return;
      }

      if (y >= r.height - xAxisH && x >= this.padL && x <= this.padL + this.plot.w) {
        // Dragging on bottom X-axis stretches/shrinks the time window smoothly
        const xFrac = Math.max(0, Math.min(1, (x - this.padL) / Math.max(10, this.plot.w)));
        this.drag = {
          mode: "xstretch",
          startX: x,
          startEndUs: this.viewEnd(),
          startWindowUs: this.windowUs,
          anchorFrac: xFrac,
        };
        host.classList.add("is-dragging", "is-over-axis");
        return;
      }

      if (e.shiftKey) {
        this.drag = {
          mode: "ybox",
          startY: y,
        };
        this.yZoomBox = { y0: y, y1: y };
        host.classList.add("is-dragging");
        return;
      }

      this.drag = {
        mode: "pan",
        startX: x,
        startY: y,
        startEndUs: this.viewEnd(),
        startYMin: this.yMin,
        startYMax: this.yMax,
      };
      host.classList.add("is-dragging");
    });

    this.listen(host, "pointermove", (e) => {
      if (!this.crossingDrag && !this.tagDrag && !this.drag && (e.target as HTMLElement | null)?.closest("[data-slot='chart-actions']")) {
        this.hoverX = null;
        this.hoverY = null;
        host.classList.remove("is-over-tag", "is-over-axis", "is-over-yaxis", "is-over-crossing", "is-over-crossing-delete");
        return;
      }
      const r = host.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;

      if (e.pointerType === "touch" && touchPts.has(e.pointerId)) {
        touchPts.set(e.pointerId, { x, y, clientX: e.clientX, clientY: e.clientY });
        if (
          tapCandidate &&
          tapCandidate.pointerId === e.pointerId &&
          Math.hypot(e.clientX - tapCandidate.startX, e.clientY - tapCandidate.startY) > 12
        ) {
          tapCandidate.moved = true;
        }
        if (pinchState) {
          const p1Now = touchPts.get(pinchState.id1);
          const p2Now = touchPts.get(pinchState.id2);
          if (p1Now && p2Now) {
            const clientPinch = computeDirectionalPinch(
              pinchState.p1ClientStart,
              pinchState.p2ClientStart,
              { x: p1Now.clientX, y: p1Now.clientY },
              { x: p2Now.clientX, y: p2Now.clientY }
            );
            const curMidClientY = (p1Now.clientY + p2Now.clientY) * 0.5;
            const dyClient = curMidClientY - pinchState.lastMidClientY;
            pinchState.lastMidClientY = curMidClientY;
            const d1y = p1Now.clientY - pinchState.p1ClientStart.y;
            const d2y = p2Now.clientY - pinchState.p2ClientStart.y;
            const bothMovedSameVert = (d1y > 4 && d2y > 4) || (d1y < -4 && d2y < -4);

            if (
              !pinchState.pinchLocked &&
              (pinchState.pageScrollLocked || (clientPinch.mode === "page-scroll" && bothMovedSameVert))
            ) {
              pinchState.pageScrollLocked = true;
              scrollOuterPageBy(-dyClient, host);
              return;
            }
            const d0 = Math.hypot(
              pinchState.p2ClientStart.x - pinchState.p1ClientStart.x,
              pinchState.p2ClientStart.y - pinchState.p1ClientStart.y
            );
            const dNow = Math.hypot(p2Now.clientX - p1Now.clientX, p2Now.clientY - p1Now.clientY);
            if (Math.abs(dNow - d0) >= 14) {
              pinchState.pinchLocked = true;
            }

            const pinch = computeDirectionalPinch(pinchState.p1Start, pinchState.p2Start, p1Now, p2Now);
            if (pinch.mode === "page-scroll") {
              return;
            }
            if (pinch.mode === "x" || pinch.mode === "xy") {
              const nextWin = Math.max(
                MIN_WINDOW_US,
                Math.min(this.maxAllowedWindowUs, pinchState.startWindowUs * pinch.xSpanFactor)
              );
              this.autoX = Boolean(this.lapWindow && Math.abs(nextWin - this.maxAllowedWindowUs) < 5_000);
              this.windowUs = nextWin;
              if (!pinchState.wasLive) {
                const liveXFrac = Math.max(0, Math.min(1, (pinch.midX - this.padL) / Math.max(10, this.plot.w)));
                const anchorUs = pinchState.startEndUs - (1 - pinchState.anchorXFrac) * pinchState.startWindowUs;
                this.endUs = this.clampEnd(anchorUs + (1 - liveXFrac) * nextWin);
              } else if (Math.abs(pinch.midX - pinch.startMidX) > 18) {
                const dxMid = pinch.midX - pinch.startMidX;
                this.pauseAt(pinchState.startEndUs - (dxMid / Math.max(10, this.plot.w)) * nextWin);
              }
            }
            if (pinch.mode === "y" || pinch.mode === "xy") {
              this.applyDbmStretch(
                pinchState.startYMin,
                pinchState.startYMax,
                pinchState.anchorYFrac,
                pinch.ySpanFactor
              );
              const dyMid = pinch.midY - pinch.startMidY;
              if (Math.abs(dyMid) > 2) {
                const curSpan = this.yMax - this.yMin;
                const deltaDbm = (dyMid / Math.max(10, this.plot.h)) * curSpan;
                this.applyDbmPan(this.yMin, this.yMax, deltaDbm);
              }
            }
            this.renderControls();
          }
          return;
        }
      }

      this.hoverX = x;
      this.hoverY = y;

      if (this.crossingDrag) {
        const rawTs = Math.round(this.timeAt(x - this.crossingDrag.grabOffsetPx));
        this.crossingDrag.tsUs = Math.max(
          this.crossingDrag.minTsUs,
          Math.min(this.crossingDrag.maxTsUs, rawTs)
        );
        return;
      }

      if (this.tagDrag) {
        const rawDbm = Math.round(this.dbmAt(y));
        if (this.isLapRF) {
          this.tagDrag.dbm = Math.max(300, Math.min(3500, rawDbm));
        } else if (this.isRH) {
          if (this.tagDrag.kind === "enter") {
            const ex = this.exitThresholdOf(this.tagDrag.gateId).dbm;
            this.tagDrag.dbm = Math.max(Math.max(10, ex + 4), Math.min(250, rawDbm));
          } else {
            const en = this.thresholdOf(this.tagDrag.gateId).dbm;
            this.tagDrag.dbm = Math.max(6, Math.min(en - 4, rawDbm));
          }
        } else if (this.tagDrag.kind === "enter") {
          const ex = this.exitThresholdOf(this.tagDrag.gateId).dbm;
          this.tagDrag.dbm = Math.max(ex + 2, Math.min(-20, rawDbm));
        } else {
          const en = this.thresholdOf(this.tagDrag.gateId).dbm;
          this.tagDrag.dbm = Math.max(-100, Math.min(en - 2, rawDbm));
        }
        return;
      }

      if (!this.drag) {
        const isTouchMove = e.pointerType === "touch";
        const overTagBox = this.tagBoxAt(x, y, isTouchMove) !== null;
        const crossingHit = !overTagBox ? this.crossingAt(x, y, isTouchMove) : null;
        const overCrossingDelete = Boolean(crossingHit?.inDelete);
        const overCrossing = crossingHit !== null && !overCrossingDelete;
        const overTag = overTagBox;
        const overYAxis =
          !overTag &&
          !overCrossing &&
          !overCrossingDelete &&
          x < this.padL &&
          y >= this.padT &&
          y <= r.height - PAD.b;
        const overXAxis =
          !overTag &&
          !overCrossing &&
          !overCrossingDelete &&
          !overYAxis &&
          y >= r.height - PAD.b &&
          x >= this.padL &&
          x <= this.padL + this.plot.w;
        host.classList.toggle("is-over-tag", overTag);
        host.classList.toggle("is-over-crossing", overCrossing);
        host.classList.toggle("is-over-crossing-delete", overCrossingDelete);
        host.classList.toggle("is-over-yaxis", overYAxis);
        host.classList.toggle("is-over-axis", overXAxis);
        return;
      }

      if (this.drag.mode === "ystretch") {
        const dy = y - this.drag.startY;
        const factor = Math.exp(dy / 140);
        this.applyDbmStretch(this.drag.startYMin, this.drag.startYMax, this.drag.anchorFrac, factor);
        this.renderControls();
        return;
      }

      if (this.drag.mode === "xstretch") {
        const dx = x - this.drag.startX;
        const factor = Math.exp(-dx / 150);
        const nextUs = Math.max(MIN_WINDOW_US, Math.min(this.maxAllowedWindowUs, this.drag.startWindowUs * factor));
        this.autoX = Boolean(this.lapWindow && Math.abs(nextUs - this.maxAllowedWindowUs) < 5_000);
        const anchorUs = this.drag.startEndUs - (1 - this.drag.anchorFrac) * this.drag.startWindowUs;
        this.windowUs = nextUs;
        if (this.endUs !== null) {
          this.endUs = this.clampEnd(anchorUs + (1 - this.drag.anchorFrac) * nextUs);
        }
        this.renderControls();
        return;
      }

      if (this.drag.mode === "ybox") {
        this.yZoomBox = { y0: this.drag.startY, y1: y };
        return;
      }

      // mode === "pan"
      const dx = x - this.drag.startX;
      const dy = y - this.drag.startY;
      if (Math.abs(dx) >= 2 || this.endUs !== null) {
        this.pauseAt(this.drag.startEndUs - (dx / Math.max(10, this.plot.w)) * this.windowUs);
      }
      if (Math.abs(dy) > 3 || !this.autoY) {
        const ySpan = this.drag.startYMax - this.drag.startYMin;
        const deltaDbm = (dy / Math.max(10, this.plot.h)) * ySpan;
        this.applyDbmPan(this.drag.startYMin, this.drag.startYMax, deltaDbm);
      }
      this.renderControls();
    });

    const endDrag = (e: PointerEvent) => {
      if (e.pointerType === "touch") {
        const wasSingleCleanTap =
          e.type === "pointerup" &&
          pinchState === null &&
          touchPts.size === 1 &&
          tapCandidate !== null &&
          tapCandidate.pointerId === e.pointerId &&
          !tapCandidate.moved &&
          performance.now() - tapCandidate.startMs < 300;
        tapCandidate = null;
        touchPts.delete(e.pointerId);

        if (wasSingleCleanTap) {
          const now = performance.now();
          if (now - lastTapTime < 340 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 32) {
            lastTapTime = 0;
            this.drag = null;
            this.tagDrag = null;
            this.crossingDrag = null;
            this.yZoomBox = null;
            host.classList.remove("is-dragging", "is-over-axis", "is-over-yaxis", "is-over-crossing");
            this.resetAxesToAuto();
            return;
          }
          lastTapTime = now;
          lastTapX = e.clientX;
          lastTapY = e.clientY;
        }

        if (pinchState !== null) {
          const wasPageScroll = pinchState.pageScrollLocked;
          if (touchPts.size < 2) {
            pinchState = null;
            this.saveChartPrefs();
            this.renderControls();
            if (touchPts.size === 1 && !wasPageScroll) {
              const remPt = Array.from(touchPts.values())[0];
              this.drag = {
                mode: "pan",
                startX: remPt.x,
                startY: remPt.y,
                startEndUs: this.viewEnd(),
                startYMin: this.yMin,
                startYMax: this.yMax,
              };
            } else {
              host.classList.remove("is-dragging", "is-over-axis", "is-over-yaxis");
            }
          }
          return;
        }
      }

      if (this.pendingDeleteCrossing) {
        const pendingDel = this.pendingDeleteCrossing;
        this.pendingDeleteCrossing = null;
        const r = host.getBoundingClientRect();
        const ux = e.clientX - r.left;
        const uy = e.clientY - r.top;
        if (
          e.type !== "pointercancel" &&
          Math.hypot(ux - pendingDel.startX, uy - pendingDel.startY) <= 14
        ) {
          void this.deleteManualCrossing(pendingDel.box.eventId, pendingDel.box.title);
        }
      }
      if (this.crossingDrag) {
        const { eventId, gateId, title, tsUs, origTsUs } = this.crossingDrag;
        this.crossingDrag = null;
        this.syncDragReadout(null);
        if (e.type !== "pointercancel" && Math.abs(tsUs - origTsUs) >= 5_000) {
          void this.saveManualCrossing(eventId, gateId, title, tsUs, origTsUs);
        }
      }
      if (this.tagDrag) {
        const { gateId, kind, dbm } = this.tagDrag;
        this.tagDrag = null;
        const prev = kind === "enter" ? this.thresholdOf(gateId).dbm : this.exitThresholdOf(gateId).dbm;
        if (dbm !== prev) void this.saveManual(gateId, kind, dbm);
      }
      if (e.pointerType === "touch") {
        this.hoverX = null;
        this.hoverY = null;
      }
      if (this.drag) {
        if (this.drag.mode === "ybox" && this.yZoomBox) {
          const ya = Math.max(this.padT, Math.min(this.padT + this.plot.h, Math.min(this.yZoomBox.y0, this.yZoomBox.y1)));
          const yb = Math.max(this.padT, Math.min(this.padT + this.plot.h, Math.max(this.yZoomBox.y0, this.yZoomBox.y1)));
          if (yb - ya >= 10) {
            const dHigh = this.dbmAt(ya);
            const dLow = this.dbmAt(yb);
            if (dHigh - dLow >= (this.isLapRF ? 150 : this.isRH ? 16 : 4)) {
              this.autoY = false;
              this.yMin = Math.max(this.absYMin, dLow);
              this.yMax = Math.min(this.absYMax, dHigh);
              this.smoothYMin = this.yMin;
              this.smoothYMax = this.yMax;
            }
          }
        }
        this.drag = null;
        this.yZoomBox = null;
        this.saveChartPrefs();
        this.renderControls();
      }
      host.classList.remove(
        "is-dragging",
        "is-over-axis",
        "is-over-yaxis",
        "is-over-crossing",
        "is-over-crossing-delete"
      );
    };
    this.listen(host, "pointerup", endDrag);
    this.listen(host, "pointercancel", endDrag);
    this.listen(host, "pointerleave", () => {
      this.hoverX = null;
      this.hoverY = null;
      if (!this.drag && !this.crossingDrag) {
        host.classList.remove(
          "is-over-tag",
          "is-over-axis",
          "is-over-yaxis",
          "is-over-crossing",
          "is-over-crossing-delete"
        );
      }
    });

    const legendEl = this.slot("legend");
    const markLegendScroll = () => {
      this.legendScrollingUntilMs =
        (typeof performance !== "undefined" ? performance.now() : Date.now()) + 180;
    };
    legendEl.addEventListener("scroll", markLegendScroll, { passive: true });
    this.onDispose(() => legendEl.removeEventListener("scroll", markLegendScroll));

    const timer = window.setInterval(() => {
      if (document.hidden || !this.el.isConnected || this.plot.w <= 1) return;
      const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (nowMs < this.legendScrollingUntilMs) return;
      // Don't rebuild the chips under the pointer — that can swallow a click.
      if (!legendEl.matches(":hover")) this.renderLegend();
    }, LEGEND_REFRESH_MS);
    this.onDispose(() => window.clearInterval(timer));
    this.onDispose(
      store.subscribe(["selection"], () => {
        this.calibMessage = "";
        this.calibMessageShort = "";
        this.smoothYMin = null;
        this.smoothYMax = null;
        this.renderControls();
        this.renderCalib();
        this.renderLegend();
        this.renderTuningDrawer();
      })
    );
    this.onDispose(
      store.subscribe(["config", "status", "rules", "ml"], () => {
        this.syncHardwareModeScale();
        for (const gId of Array.from(this.selectedGates)) {
          if (!store.node(gId)) this.selectedGates.delete(gId);
        }
        if (this.tuningGateId !== null && !store.node(this.tuningGateId)) this.tuningGateId = null;
        this.renderControls();
        this.renderCalib();
        this.renderLegend();
        this.renderTuningDrawer();
      })
    );
    this.onDispose(
      store.subscribe(["laps", "crossings", "practice"], () => {
        this.renderCalib();
        this.renderLegend();
        if (this.tuningGateId !== null) {
          this.renderTuningDrawer();
        }
      })
    );
    this.listen(window as unknown as HTMLElement, "resize", () => {
      const nowMobile = this.computeIsMobileLayout();
      if (nowMobile !== this.mobileLayoutCached) {
        this.mobileLayoutCached = nowMobile;
        this.renderTuningDrawer();
      } else if (nowMobile && this.tuneDrawerOpen) {
        this.syncMobileDrawerTop(this.tuneDrawerEl);
      }
    });
    this.syncHardwareModeScale();
    this.renderControls();
    this.renderCalib();
    this.renderLegend();
    this.renderTuningDrawer();
  }

  // ---- view window & Y scale -------------------------------------------------

  private get latest(): number {
    return this.store.latestTimestampUs;
  }

  private get livePlayhead(): number {
    return this.store.smoothLatestTimestampUs;
  }

  private get earliest(): number {
    let e = Infinity;
    const nodes = this.store.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const first = this.store.historyFor(nodes[i].gateId)[0];
      if (first && first.timestampUs < e) e = first.timestampUs;
    }
    return Number.isFinite(e) ? e : this.latest;
  }

  private viewEnd(): number {
    if (this.endUs !== null) return this.endUs;
    if (this.drag && "startEndUs" in this.drag) return this.drag.startEndUs;
    return this.livePlayhead;
  }

  private get maxAllowedWindowUs(): number {
    return this.lapWindow
      ? Math.max(MIN_WINDOW_US, this.lapWindow.maxUs - this.lapWindow.minUs)
      : MAX_WINDOW_US;
  }

  private get defaultWindowUs(): number {
    return this.lapWindow ? this.maxAllowedWindowUs : DEFAULT_WINDOW_US;
  }

  /** Updates the locked single-lap bounds in place while preserving user zoom if zoomed in. */
  public setLapWindow(next: PilotRssiLapWindow): void {
    const minUs = Math.max(0, Math.round(next.minUs));
    const maxUs = Math.max(minUs + MIN_WINDOW_US, Math.round(next.maxUs));
    this.lapWindow = {
      minUs,
      maxUs,
      passMinUs: Math.max(minUs, Math.round(next.passMinUs ?? minUs)),
      passMaxUs: Math.min(maxUs, Math.round(next.passMaxUs ?? maxUs)),
    };
    this.refUs = maxUs;
    if (this.autoX || this.windowUs > this.maxAllowedWindowUs) {
      this.autoX = true;
      this.windowUs = this.defaultWindowUs;
      this.endUs = maxUs;
    } else if (this.endUs !== null) {
      this.endUs = this.clampEnd(this.endUs);
    } else {
      this.endUs = maxUs;
    }
    this.renderControls();
  }

  private clampEnd(end: number): number {
    if (this.lapWindow) {
      const minEnd = Math.min(this.lapWindow.maxUs, this.lapWindow.minUs + this.windowUs);
      return Math.min(this.lapWindow.maxUs, Math.max(minEnd, end));
    }
    const latest =
      this.endUs !== null && this.refUs > 0
        ? this.refUs
        : this.drag && "startEndUs" in this.drag
          ? this.drag.startEndUs
          : this.latest;
    const earliest = this.earliest;
    const minEnd = earliest;
    const maxEnd = Math.max(latest, earliest + this.windowUs);
    return Math.min(maxEnd, Math.max(minEnd, end));
  }

  private timeAt(x: number): number {
    return this.viewEnd() - this.windowUs * (1 - (x - this.plot.x) / this.plot.w);
  }

  private yOf(dbm: number): number {
    const span = Math.max(4, this.yMax - this.yMin);
    return this.padT + this.plot.h * (1 - (dbm - this.yMin) / span);
  }

  private dbmAt(y: number): number {
    const span = Math.max(4, this.yMax - this.yMin);
    const v = this.yMin + (1 - (y - this.padT) / this.plot.h) * span;
    return Math.max(this.absYMin, Math.min(this.absYMax, v));
  }

  private applyDbmStretch(startMin: number, startMax: number, anchorFrac: number, factor: number): void {
    const minSpan = this.isLapRF ? 200 : this.isRH ? 24 : 6;
    const absLo = this.absYMin;
    const absHi = this.absYMax;
    const curSpan = Math.max(minSpan, startMax - startMin);
    const nextSpan = Math.max(minSpan, Math.min(absHi - absLo, curSpan * factor));
    const anchorDbm = startMin + anchorFrac * curSpan;
    let nextMin = anchorDbm - anchorFrac * nextSpan;
    let nextMax = nextMin + nextSpan;
    if (nextMin < absLo) {
      nextMin = absLo;
      nextMax = Math.min(absHi, absLo + nextSpan);
    }
    if (nextMax > absHi) {
      nextMax = absHi;
      nextMin = Math.max(absLo, absHi - nextSpan);
    }
    this.autoY = false;
    this.yMin = nextMin;
    this.yMax = nextMax;
    this.smoothYMin = nextMin;
    this.smoothYMax = nextMax;
  }

  private applyDbmPan(startMin: number, startMax: number, deltaDbm: number): void {
    const minSpan = this.isLapRF ? 200 : this.isRH ? 24 : 6;
    const absLo = this.absYMin;
    const absHi = this.absYMax;
    const span = Math.max(minSpan, startMax - startMin);
    let nextMin = startMin + deltaDbm;
    let nextMax = nextMin + span;
    if (nextMin < absLo) {
      nextMin = absLo;
      nextMax = Math.min(absHi, absLo + span);
    }
    if (nextMax > absHi) {
      nextMax = absHi;
      nextMin = Math.max(absLo, absHi - span);
    }
    this.autoY = false;
    this.yMin = nextMin;
    this.yMax = nextMax;
    this.smoothYMin = nextMin;
    this.smoothYMax = nextMax;
  }

  private updateAutoY(start: number, end: number, slots: number[]): void {
    this.syncHardwareModeScale();
    if (!this.autoY) return;
    const isLapRF = this.isLapRF;
    const isRH = this.isRH;
    let minD = Infinity;
    let maxD = -Infinity;
    for (const gate of this.shownGates) {
      const frames = this.store.historyFor(gate.gateId);
      if (!frames.length) continue;
      const from = Math.max(0, PilotRssiChart.firstAtOrAfter(frames, start) - 1);
      const to = Math.min(frames.length - 1, PilotRssiChart.firstAtOrAfter(frames, end));
      for (let i = from; i <= to; i++) {
        const rssiArr = frames[i]?.rssi;
        if (!rssiArr) continue;
        for (const slot of slots) {
          const v = rssiArr[slot];
          const valid = isLapRF
            ? v !== undefined && v > 50 && v <= 4000
            : isRH
              ? v !== undefined && v > 0 && v <= 260
              : v !== undefined && v > -127 && v < 0;
          if (valid) {
            if (v! < minD) minD = v!;
            if (v! > maxD) maxD = v!;
          }
        }
      }
      if (!this.isMultiPilotMode) {
        const thr = this.thresholdOf(gate.gateId).dbm;
        if (isLapRF) {
          if (this.focus !== null || maxD >= thr - 250) {
            if (thr > maxD) maxD = thr;
            if (thr < minD) minD = thr;
          }
        } else {
          const exThr = this.exitThresholdOf(gate.gateId).dbm;
          const nearGap = isRH ? 35 : 14;
          if (this.focus !== null || maxD >= thr - nearGap) {
            if (thr > maxD) maxD = thr;
            if (thr < minD) minD = thr;
            if (this.focus !== null) {
              if (exThr > maxD) maxD = exThr;
              if (exThr < minD) minD = exThr;
            }
          }
        }
      }
    }
    if (minD > maxD) {
      this.yMin = this.defYMin;
      this.yMax = this.defYMax;
      return;
    }
    const absLo = this.absYMin;
    const absHi = this.absYMax;
    let targetMin = isLapRF
      ? Math.max(absLo, Math.floor((minD - 120) / 50) * 50)
      : isRH
        ? Math.max(absLo, Math.floor((minD - 12) / 5) * 5)
        : Math.max(absLo, Math.floor((minD - 5) / 2) * 2);
    let targetMax = isLapRF
      ? Math.min(absHi, Math.ceil((maxD + 160) / 50) * 50)
      : isRH
        ? Math.min(absHi, Math.ceil((maxD + 16) / 5) * 5)
        : Math.min(absHi, Math.ceil((maxD + 3) / 2) * 2);
    const minSpan = isLapRF ? 700 : isRH ? 60 : 22;
    if (targetMax - targetMin < minSpan) {
      const extra = minSpan - (targetMax - targetMin);
      targetMin = Math.max(absLo, targetMin - Math.floor(extra * 0.35));
      targetMax = Math.min(absHi, targetMin + minSpan);
    }
    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (this.smoothYMin === null || this.smoothYMax === null) {
      this.smoothYMin = targetMin;
      this.smoothYMax = targetMax;
      this.autoYHoldUntilMs = nowMs + 5000;
    } else {
      const curMin = this.smoothYMin;
      const curMax = this.smoothYMax;
      const marginLo = isLapRF ? 40 : isRH ? 5 : 2;
      const marginHi = isLapRF ? 260 : isRH ? 32 : 12;
      const expandMin = minD < curMin + marginLo;
      const expandMax = maxD > curMax - marginLo;
      if (expandMin || expandMax) {
        this.autoYHoldUntilMs = nowMs + 5000;
      }
      const canShrink = nowMs >= this.autoYHoldUntilMs;
      const shrinkMin = canShrink && minD > curMin + marginHi;
      const shrinkMax = canShrink && maxD < curMax - marginHi;
      const effTargetMin = expandMin || shrinkMin ? targetMin : curMin;
      const effTargetMax = expandMax || shrinkMax ? targetMax : curMax;
      const diffMin = effTargetMin - curMin;
      const diffMax = effTargetMax - curMax;
      if (Math.abs(diffMin) > 0.05) {
        const alphaMin = diffMin < 0 ? 0.35 : 0.06;
        this.smoothYMin = Math.abs(diffMin) < 0.25 ? effTargetMin : curMin + diffMin * alphaMin;
      }
      if (Math.abs(diffMax) > 0.05) {
        const alphaMax = diffMax > 0 ? 0.4 : 0.06;
        this.smoothYMax = Math.abs(diffMax) < 0.25 ? effTargetMax : curMax + diffMax * alphaMax;
      }
    }
    this.yMin = this.smoothYMin;
    this.yMax = Math.max(this.yMin + (isLapRF ? 300 : isRH ? 30 : 12), this.smoothYMax);
  }

  private resetAxesToAuto(): void {
    this.autoX = true;
    this.windowUs = this.defaultWindowUs;
    if (this.lapWindow) {
      this.refUs = this.lapWindow.maxUs;
      this.endUs = this.lapWindow.maxUs;
    } else {
      this.endUs = null;
    }
    this.autoY = true;
    this.smoothYMin = null;
    this.smoothYMax = null;
    this.saveChartPrefs();
    this.renderControls();
  }

  private loadChartPrefs(): void {
    try {
      const raw = window.localStorage.getItem(RSSI_CHART_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        windowUs?: number;
        autoX?: boolean;
        autoY?: boolean;
        yMin?: number;
        yMax?: number;
        focus?: number | null;
        selectedGates?: number[];
      };
      if (typeof parsed.autoX === "boolean") {
        this.autoX = parsed.autoX;
      }
      if (this.autoX) {
        this.windowUs = DEFAULT_WINDOW_US;
      } else if (typeof parsed.windowUs === "number" && parsed.windowUs >= MIN_WINDOW_US && parsed.windowUs <= MAX_WINDOW_US) {
        this.windowUs = parsed.windowUs;
      }
      if (typeof parsed.autoY === "boolean") {
        this.autoY = parsed.autoY;
      }
      if (typeof parsed.yMin === "number" && typeof parsed.yMax === "number" && parsed.yMax - parsed.yMin >= 6) {
        this.yMin = Math.max(DBM_MIN, parsed.yMin);
        this.yMax = Math.min(DBM_MAX, parsed.yMax);
      }
      if (Array.isArray(parsed.selectedGates)) {
        this.selectedGates.clear();
        for (const id of parsed.selectedGates) {
          if (typeof id === "number" && Number.isFinite(id) && id >= 1) {
            this.selectedGates.add(Math.round(id));
          }
        }
      } else if (parsed.focus === null || (typeof parsed.focus === "number" && parsed.focus >= 1)) {
        this.focus = parsed.focus;
      }
    } catch {
      // Ignore storage access errors
    }
  }

  private saveChartPrefs(): void {
    if (this.lapWindow) return;
    try {
      window.localStorage.setItem(
        RSSI_CHART_STORAGE_KEY,
        JSON.stringify({
          windowUs: this.windowUs,
          autoX: this.autoX,
          autoY: this.autoY,
          yMin: this.yMin,
          yMax: this.yMax,
          focus: this.focus,
          selectedGates: Array.from(this.selectedGates),
        })
      );
    } catch {
      // Ignore storage access errors
    }
  }

  /** Focuses a specific timer (or all timers if null) and centers the X-axis window around `centerTsUs`. */
  public focusGateAndWindow(
    gateId: number | null,
    centerTsUs: number,
    spanUs = 6_000_000,
    unlockForEdit = false
  ): void {
    this.focus = gateId;
    if (unlockForEdit && gateId !== null) {
      this.chartLinesLocked = false;
    }
    this.autoX = false;
    this.windowUs = Math.min(this.maxAllowedWindowUs, Math.max(MIN_WINDOW_US, spanUs));
    if (this.lapWindow) {
      this.refUs = this.lapWindow.maxUs;
      this.endUs = this.clampEnd(Math.round(centerTsUs + this.windowUs / 2));
    } else {
      const latest = this.latest;
      this.refUs = latest > 0 ? latest : centerTsUs;
      this.endUs = Math.round(centerTsUs + this.windowUs / 2);
    }
    this.renderControls();
    this.renderCalib();
    this.renderLegend();
    this.renderTuningDrawer();
  }

  public restoreDefaults(): void {
    this.windowUs = this.defaultWindowUs;
    this.autoX = true;
    this.autoY = true;
    this.yMin = this.defYMin;
    this.yMax = this.defYMax;
    this.smoothYMin = null;
    this.smoothYMax = null;
    this.selectedGates.clear();
    this.chartLinesLocked = true;
    if (this.lapWindow) {
      this.refUs = this.lapWindow.maxUs;
      this.endUs = this.lapWindow.maxUs;
    } else {
      this.endUs = null;
    }
    this.calibMessage = "";
    this.saveChartPrefs();
    this.renderControls();
    this.renderCalib();
    this.renderLegend();
    this.renderTuningDrawer();
  }

  private setWindow(us: number, isAuto = false): void {
    const center = this.viewEnd() - this.windowUs / 2;
    const clampedUs = Math.min(this.maxAllowedWindowUs, Math.max(MIN_WINDOW_US, us));
    this.windowUs = clampedUs;
    this.autoX = isAuto;
    if (this.endUs !== null) this.endUs = this.clampEnd(center + clampedUs / 2);
    this.saveChartPrefs();
    this.renderControls();
  }

  private zoom(factor: number, x: number): void {
    const anchor = this.timeAt(x);
    const frac = Math.min(1, Math.max(0, (x - this.plot.x) / this.plot.w));
    const next = Math.min(this.maxAllowedWindowUs, Math.max(MIN_WINDOW_US, this.windowUs * factor));
    this.windowUs = next;
    this.autoX = Boolean(this.lapWindow && Math.abs(next - this.maxAllowedWindowUs) < 5_000);
    // Following live keeps the right edge at "now"; otherwise zoom around the cursor.
    if (this.endUs !== null) this.endUs = this.clampEnd(anchor + (1 - frac) * next);
    this.saveChartPrefs();
    this.renderControls();
  }

  private toggleLive(): void {
    if (this.lapWindow) return;
    if (this.endUs === null) {
      this.pauseAt(this.latest);
    } else {
      this.endUs = null;
      this.crossingDrag = null;
    }
    this.renderControls();
  }

  /**
   * Freeze the view ending at `end`. The time axis is labelled relative to the moment of
   * pausing, so the labels stay put while new data keeps arriving in the background.
   */
  private pauseAt(end: number): void {
    if (this.endUs === null) {
      this.refUs = this.drag && "startEndUs" in this.drag ? this.drag.startEndUs : this.latest;
      this.endUs = this.refUs;
    }
    this.endUs = this.clampEnd(end);
  }

  /** "Now" for axis labels: the live edge, or the moment the view was paused. */
  private get ref(): number {
    return this.endUs === null ? this.livePlayhead : this.refUs;
  }

  /** Centre the window on the previous / next pass (timed or not) for the focused gate (or all gates). */
  private jump(dir: -1 | 1): void {
    const center = this.viewEnd() - this.windowUs / 2;
    const passes = this.focusedPasses(this.earliest, this.latest);
    const target =
      dir < 0 ? [...passes].reverse().find((p) => p.ts < center - 50_000) : passes.find((p) => p.ts > center + 50_000);
    if (!target) return;
    this.pauseAt(target.ts + this.windowUs / 2);
    this.renderControls();
  }

  // ---- thresholds & calibration ----------------------------------------------

  /** The enter threshold to show for a gate: while dragging, the dragged value; then pending; then stored. */
  private thresholdOf(gateId: number): { dbm: number; calibrated: boolean } {
    if (this.tagDrag?.gateId === gateId && this.tagDrag.kind === "enter") {
      return { dbm: this.tagDrag.dbm, calibrated: true };
    }
    const pending = this.pending.get(gateId);
    if (pending !== undefined) return { dbm: pending.enter, calibrated: true };
    return enterThresholdAt(this.store, gateId, this.activePilotSlot);
  }

  /** The exit threshold to show for a gate: while dragging, the dragged value; then pending; then stored. */
  private exitThresholdOf(gateId: number): { dbm: number; calibrated: boolean } {
    if (this.tagDrag?.gateId === gateId && this.tagDrag.kind === "exit") {
      return { dbm: this.tagDrag.dbm, calibrated: true };
    }
    const pending = this.pending.get(gateId);
    if (pending !== undefined) return { dbm: pending.exit, calibrated: true };
    return exitThresholdAt(this.store, gateId, this.activePilotSlot);
  }

  private toggleChartLock(): void {
    this.chartLinesLocked = !this.chartLinesLocked;
    if (!this.chartLinesLocked) {
      if (this.endUs === null) {
        const anchor =
          this.latest > 0
            ? this.latest
            : this.store.crossings.length > 0
              ? this.store.crossings[this.store.crossings.length - 1].timestampUs
              : 0;
        if (anchor > 0) {
          this.pauseAt(anchor);
        }
      }
    } else {
      this.tagDrag = null;
      this.crossingDrag = null;
      this.pendingDeleteCrossing = null;
    }
    this.renderControls();
    this.renderCalib();
  }

  /** Threshold pill handle directly under `(x, y)`, if any. Thresholds drag strictly by their pill handles. */
  private tagBoxAt(x: number, y: number, isTouch = false): { gateId: number; kind: "enter" | "exit" } | null {
    if (!this.canEditLines) return null;
    const pad = isTouch ? 4 : 0;
    for (const t of this.tags) {
      if (x >= t.x - pad && x <= t.x + t.w + pad && y >= t.y - pad && y <= t.y + TAG_H + pad) {
        return { gateId: t.gateId, kind: t.kind };
      }
    }
    return null;
  }

  /** Gate & kind whose threshold pill handle is under the pointer, if any. */
  private tagAt(x: number, y: number): { gateId: number; kind: "enter" | "exit" } | null {
    return this.tagBoxAt(x, y);
  }

  /** Timed crossing pill, delete `×` button, or vertical line under `(x, y)` when unlocked & paused. */
  private crossingAt(
    x: number,
    y: number,
    isTouch = false
  ): { box: CrossingBox; inPill: boolean; inDelete: boolean } | null {
    if (!this.canEditCrossings || this.crossingBoxes.length === 0) return null;
    const padPad = isTouch ? 4 : 0;
    for (let i = this.crossingBoxes.length - 1; i >= 0; i--) {
      const b = this.crossingBoxes[i];
      if (
        x >= b.pillX - padPad &&
        x <= b.pillX + b.pillW + padPad &&
        y >= b.pillY - padPad &&
        y <= b.pillY + TAG_H + padPad
      ) {
        const inDelete = x >= b.delX - (isTouch ? 3 : 0);
        return { box: b, inPill: true, inDelete };
      }
    }
    if (y < this.padT || y > this.padT + this.plot.h) return null;
    if (x < this.padL - 4 || x > this.padL + this.plot.w + 4) return null;
    const hitPx = isTouch ? 16 : MARKER_HIT_PX;
    let best: CrossingBox | null = null;
    for (const b of this.crossingBoxes) {
      const dx = Math.abs(x - b.lineX);
      if (dx <= hitPx && (!best || dx < Math.abs(x - best.lineX))) {
        best = b;
      }
    }
    return best ? { box: best, inPill: false, inDelete: false } : null;
  }

  /** Computes the allowed microsecond range `[minTsUs, maxTsUs]` for freely dragging a crossing line. */
  private crossingBoundsFor(
    eventId: number,
    _slotIndex: number,
    _gateId: number,
    origTsUs: number
  ): { minTsUs: number; maxTsUs: number } {
    if (this.lapWindow) {
      if (eventId > 0) this.lapWindowAllowedEventIds.add(eventId);
      const minTsUs = Math.max(1, Math.round(this.lapWindow.minUs));
      const maxTsUs = Math.max(minTsUs, Math.round(this.lapWindow.maxUs));
      return { minTsUs, maxTsUs };
    }
    const end = this.viewEnd();
    const start = end - this.windowUs;
    let minTsUs = Math.min(this.earliest, start);
    if (this.store.crossings.length > 0) {
      minTsUs = Math.min(minTsUs, this.store.crossings[0].timestampUs - this.windowUs);
    }
    minTsUs = Math.max(1, Math.round(minTsUs));
    const maxTsUs = Math.max(
      origTsUs + 60_000_000,
      this.latest > 0 ? this.latest + this.windowUs : 0,
      Math.round(end + this.windowUs)
    );
    return { minTsUs, maxTsUs: Math.max(minTsUs, maxTsUs) };
  }

  private async addManualCrossing(): Promise<void> {
    if (
      this.chartLinesLocked ||
      this.focus === null ||
      this.isMultiPilotMode ||
      (this.contextMode !== "practice" && this.store.isHistoricalTrack)
    ) {
      return;
    }
    const gateId = this.focus;
    if (this.endUs === null) {
      const anchor =
        this.latest > 0
          ? this.latest
          : this.store.crossings.length > 0
            ? this.store.crossings[this.store.crossings.length - 1].timestampUs
            : 15_000_000;
      this.pauseAt(anchor);
      this.renderControls();
    }
    const end = this.viewEnd();
    const start = end - this.windowUs;
    let tsUs = Math.max(1, Math.round(start + this.windowUs * 0.5));
    if (this.lapWindow) {
      tsUs = Math.max(this.lapWindow.minUs, Math.min(this.lapWindow.maxUs, tsUs));
    }
    const slot = this.activePilotSlot;
    while (
      this.store.crossings.some(
        (c) =>
          c.slotIndex === slot &&
          c.gateId === gateId &&
          !this.pendingDeletedCrossings.has(c.eventId) &&
          Math.abs(c.timestampUs - tsUs) < 35_000
      )
    ) {
      tsUs += 150_000;
    }
    if (this.lapWindow) {
      tsUs = Math.max(this.lapWindow.minUs, Math.min(this.lapWindow.maxUs, tsUs));
    }
    const prevIds = this.lapWindow
      ? new Set<number>(this.store.crossings.map((c) => c.eventId))
      : null;
    const pilot = this.store.pilot(slot);
    const pos = pilot ? this.store.pilots.indexOf(pilot) : -1;
    const peakDbm = pos >= 0 ? this.rssiAt(gateId, pos, tsUs) : undefined;
    const gateLbl = this.labelOfGate(gateId);
    try {
      await this.api.addCrossing(gateId, slot, tsUs, peakDbm);
      if (prevIds) {
        for (const c of this.store.crossings) {
          if (c.eventId > 0 && !prevIds.has(c.eventId)) {
            this.lapWindowAllowedEventIds.add(c.eventId);
          }
        }
      }
      this.calibMessage = `Added ${gateLbl} crossing — drag handle to position.`;
      this.calibMessageShort = `Added ${gateLbl} crossing`;
    } catch {
      this.calibMessage = `Could not add ${gateLbl} crossing.`;
      this.calibMessageShort = `Could not add ${gateLbl} crossing.`;
    } finally {
      this.renderCalib();
    }
  }

  private async deleteManualCrossing(eventId: number, title: string): Promise<void> {
    if (!eventId || this.pendingDeletedCrossings.has(eventId)) return;
    this.pendingDeletedCrossings.add(eventId);
    try {
      await this.api.deleteCrossing(eventId);
      this.calibMessage = `Removed ${title}.`;
      this.calibMessageShort = `Removed ${title}`;
    } catch {
      this.calibMessage = `Could not remove ${title}.`;
      this.calibMessageShort = `Could not remove ${title}.`;
    } finally {
      this.pendingDeletedCrossings.delete(eventId);
      this.renderCalib();
    }
  }

  private async saveManualCrossing(
    eventId: number,
    gateId: number,
    title: string,
    tsUs: number,
    origTsUs: number
  ): Promise<void> {
    this.pendingCrossings.set(eventId, tsUs);
    const pilot = this.store.pilot(this.activePilotSlot);
    const pos = pilot ? this.store.pilots.indexOf(pilot) : -1;
    const peakDbm = pos >= 0 ? this.rssiAt(gateId, pos, tsUs) : undefined;
    const deltaSec = (tsUs - origTsUs) / 1e6;
    const signed = `${deltaSec >= 0 ? "+" : "−"}${Math.abs(deltaSec).toFixed(2)}s`;
    try {
      await this.api.adjustCrossing(eventId, tsUs, peakDbm);
      this.calibMessage = `Adjusted ${title} (${signed}).`;
      this.calibMessageShort = `${title} adjusted (${signed})`;
    } catch {
      this.calibMessage = `Could not adjust ${title}.`;
      this.calibMessageShort = `Could not adjust ${title}.`;
    } finally {
      this.pendingCrossings.delete(eventId);
      this.renderCalib();
    }
  }

  private async apply(updates: GateThresholdUpdate[], message: string, shortMessage?: string): Promise<void> {
    updates.forEach((u) => {
      if (this.isLapRF) {
        const rawT = u.laprfThreshold ?? u.enterDbm;
        const en = !rawT || rawT <= 0 ? this.pilotDefault() : rawT;
        this.pending.set(u.gateId, { enter: en, exit: en });
        return;
      }
      if (this.isRH) {
        const rawEn = u.rhEnterThreshold ?? 0;
        const rawEx = u.rhExitThreshold ?? 0;
        const en = rawEn <= 0 ? this.pilotDefault() : rawEn;
        const ex =
          rawEx > 0
            ? Math.max(6, Math.min(en - 4, rawEx))
            : Math.max(6, Math.min(en - 4, this.pilotExitDefault()));
        this.pending.set(u.gateId, { enter: en, exit: ex });
        return;
      }
      const en = u.enterDbm === 0 ? this.pilotDefault() : u.enterDbm;
      const ex =
        u.exitDbm && u.exitDbm !== 0
          ? Math.min(en - 2, u.exitDbm)
          : Math.min(en - 2, this.pilotExitDefault());
      this.pending.set(u.gateId, { enter: en, exit: ex });
    });
    try {
      await this.api.setGateThresholds(updates);
      this.calibMessage = message;
      this.calibMessageShort = shortMessage ?? message;
    } catch {
      this.calibMessage = "Could not save thresholds.";
      this.calibMessageShort = "Could not save thresholds.";
    } finally {
      updates.forEach((u) => this.pending.delete(u.gateId));
      this.renderCalib();
      this.renderLegend();
    }
  }

  private pilotDefault(): number {
    const p = this.store.pilot(this.activePilotSlot);
    if (this.isLapRF) {
      return p?.laprfThreshold && p.laprfThreshold > 0 ? p.laprfThreshold : 800;
    }
    if (this.isRH) {
      return p?.rhEnterThreshold && p.rhEnterThreshold > 0 ? p.rhEnterThreshold : 95;
    }
    return p?.enterThreshold ?? -58;
  }

  private pilotExitDefault(): number {
    const p = this.store.pilot(this.activePilotSlot);
    if (this.isRH) {
      const en = this.pilotDefault();
      return p?.rhExitThreshold && p.rhExitThreshold > 0 && p.rhExitThreshold < en
        ? p.rhExitThreshold
        : Math.max(6, en - 25);
    }
    const en = p?.enterThreshold ?? -58;
    return p?.exitThreshold && p.exitThreshold < en ? p.exitThreshold : en - 10;
  }

  private saveManual(gateId: number, kind: "enter" | "exit", dbm: number): Promise<void> {
    if (this.isLapRF) {
      const laprfThreshold = Math.max(300, Math.min(3500, Math.round(dbm)));
      return this.apply(
        [{ gateId, slotIndex: this.activePilotSlot, enterDbm: 0, laprfThreshold }],
        `${gateLabel(this.store, gateId)} set to Threshold ${laprfThreshold}.`
      );
    }
    if (this.isRH) {
      const curEnter = enterThresholdAt(this.store, gateId, this.activePilotSlot).dbm;
      const curExit = exitThresholdAt(this.store, gateId, this.activePilotSlot).dbm;
      const rhEnterThreshold =
        kind === "enter" ? Math.max(10, Math.min(250, Math.round(dbm))) : Math.round(curEnter);
      const rhExitThreshold =
        kind === "exit"
          ? Math.max(6, Math.min(rhEnterThreshold - 4, Math.round(dbm)))
          : Math.max(6, Math.min(rhEnterThreshold - 4, Math.round(curExit)));
      return this.apply(
        [
          {
            gateId,
            slotIndex: this.activePilotSlot,
            enterDbm: 0,
            rhEnterThreshold,
            rhExitThreshold,
          },
        ],
        `${gateLabel(this.store, gateId)} set to Enter ${rhEnterThreshold} / Exit ${rhExitThreshold}.`
      );
    }
    const curEnter = enterThresholdAt(this.store, gateId, this.activePilotSlot).dbm;
    const curExit = exitThresholdAt(this.store, gateId, this.activePilotSlot).dbm;
    const enterDbm = kind === "enter" ? Math.max(-95, Math.min(-20, dbm)) : curEnter;
    const exitDbm =
      kind === "exit"
        ? Math.max(-105, Math.min(enterDbm - 2, dbm))
        : Math.max(-105, Math.min(enterDbm - 2, curExit));
    return this.apply(
      [{ gateId, slotIndex: this.activePilotSlot, enterDbm, exitDbm }],
      `${gateLabel(this.store, gateId)} set to Enter ${enterDbm} / Exit ${exitDbm} dBm.`
    );
  }

  private canGateCalibrateNow(gateId: number, slotPos: number): boolean {
    if (slotPos < 0) return false;
    const frames = this.store.historyFor(gateId);
    if (frames.length < 100) return false;
    const passCount = this.store.crossings.length + this.store.filtered.length;
    const key = `${gateId}:${slotPos}`;
    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    const cached = this.calibReadyCache.get(key);
    if (cached) {
      if (cached.ok && nowMs - cached.checkedAtMs < 10_000) {
        return true;
      }
      if (
        !cached.ok &&
        cached.passCount === passCount &&
        frames.length - cached.frameCount < 100 &&
        nowMs - cached.checkedAtMs < 2_000
      ) {
        return false;
      }
    }
    const tail = frames.length > 6_500 ? frames.slice(frames.length - 6_500) : frames;
    const ok = suggestThreshold(tail, slotPos).ok;
    this.calibReadyCache.set(key, {
      ok,
      checkedAtMs: nowMs,
      frameCount: frames.length,
      passCount,
    });
    return ok;
  }

  private waitMinCalibSpin(startedAtMs: number): Promise<void> {
    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    const remMs = Math.max(0, MIN_CALIB_SPIN_MS - (nowMs - startedAtMs));
    if (remMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const tid = window.setTimeout(() => {
        this.calibSpinTimers.delete(tid);
        resolve();
      }, remMs);
      this.calibSpinTimers.add(tid);
    });
  }

  /**
   * Works out each gate's threshold from the recent signal (see suggestThreshold): noise
   * floor between passes vs. the peaks of the passes themselves.
   */
  private async autoCalibrate(targetGateId?: number | null): Promise<void> {
    const pilot = this.store.pilot(this.activePilotSlot);
    if (!pilot) return;
    const targetGates =
      targetGateId === undefined
        ? this.shownGates
        : targetGateId === null
          ? this.store.nodes
          : this.store.nodes.filter((p) => p.gateId === targetGateId);
    const gateIds = targetGates.map((g) => g.gateId).filter((id) => !this.calibratingGates.has(id));
    if (gateIds.length === 0) return;

    const startedAtMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    for (const id of gateIds) {
      this.calibratingGates.add(id);
    }
    this.renderCalib();
    this.renderLegend();

    try {
      const pos = this.store.pilots.indexOf(pilot);
      const updates: GateThresholdUpdate[] = [];
      const done: string[] = [];
      const skipped: string[] = [];
      const isRH = isRotorHazardMode(this.store.timingHardwareMode);
      for (const gate of targetGates) {
        const result = suggestThreshold(this.store.historyFor(gate.gateId), pos);
        const name = gateLabel(this.store, gate.gateId);
        if (result.ok) {
          if (isRH) {
            const rhEnterThreshold = Math.max(10, Math.min(250, Math.round(result.enterDbm)));
            const rhExitThreshold = Math.max(6, Math.min(rhEnterThreshold - 4, Math.round(result.exitDbm)));
            updates.push({
              gateId: gate.gateId,
              slotIndex: pilot.slotIndex,
              enterDbm: 0,
              rhEnterThreshold,
              rhExitThreshold,
            });
            done.push(`${name} ${rhEnterThreshold}/${rhExitThreshold}`);
          } else {
            updates.push({
              gateId: gate.gateId,
              slotIndex: pilot.slotIndex,
              enterDbm: result.enterDbm,
              exitDbm: result.exitDbm,
              auto: true,
            });
            done.push(`${name} ${result.enterDbm}/${result.exitDbm}`);
          }
        } else {
          skipped.push(`${name}: ${result.reason}`);
        }
      }
      if (updates.length === 0) {
        await this.waitMinCalibSpin(startedAtMs);
        if (this.disposed) return;
        this.calibMessage = `Cannot calibrate yet (${skipped[0] ?? "no signal"}). Let ${pilot.callsign} fly a few laps with this page open, then try again.`;
        this.calibMessageShort = "Cannot calibrate yet · fly a few passes first";
        return;
      }
      const minutes = Math.round(HISTORY_SECONDS / 60);
      const unit = isRH ? "RSSI" : "dBm";
      await Promise.all([
        this.apply(
          updates,
          `Calibrated from the last ${minutes} min: ${done.join(" · ")} ${unit}.${skipped.length ? ` Skipped ${skipped.join(", ")}.` : ""}`,
          `Calibrated: ${done.join(" · ")} ${unit}`
        ),
        this.waitMinCalibSpin(startedAtMs),
      ]);
    } finally {
      for (const id of gateIds) {
        this.calibratingGates.delete(id);
      }
      if (!this.disposed) {
        this.renderCalib();
        this.renderLegend();
      }
    }
  }

  private resetToDefault(targetGateId?: number | null): Promise<void> {
    const slotIndex = this.activePilotSlot;
    const who = this.store.pilot(slotIndex)?.callsign ?? "the pilot";
    const effFocus = targetGateId === undefined ? this.focus : targetGateId;
    const targetGates =
      effFocus === null
        ? this.store.nodes
        : this.store.nodes.filter((p) => p.gateId === effFocus);
    if (this.isLapRF) {
      const message =
        effFocus === null
          ? `Every timer is back on ${who}'s own threshold (${this.pilotDefault()}).`
          : `${gateLabel(this.store, effFocus)} is back on ${who}'s own threshold (${this.pilotDefault()}).`;
      const shortMsg =
        effFocus === null
          ? `Calibration cleared (${this.pilotDefault()})`
          : `${gateLabel(this.store, effFocus)}: calibration cleared (${this.pilotDefault()})`;
      return this.apply(
        targetGates.map((p) => ({ gateId: p.gateId, slotIndex, enterDbm: 0, laprfThreshold: -1 })),
        message,
        shortMsg
      );
    }
    if (this.isRH) {
      const message =
        effFocus === null
          ? `Every timer is back on ${who}'s own thresholds (${this.pilotDefault()}/${this.pilotExitDefault()}).`
          : `${gateLabel(this.store, effFocus)} is back on ${who}'s own thresholds (${this.pilotDefault()}/${this.pilotExitDefault()}).`;
      const shortMsg =
        effFocus === null
          ? `Calibration cleared (${this.pilotDefault()}/${this.pilotExitDefault()})`
          : `${gateLabel(this.store, effFocus)}: calibration cleared (${this.pilotDefault()}/${this.pilotExitDefault()})`;
      return this.apply(
        targetGates.map((p) => ({
          gateId: p.gateId,
          slotIndex,
          enterDbm: 0,
          rhEnterThreshold: -1,
          rhExitThreshold: -1,
        })),
        message,
        shortMsg
      );
    }
    const message =
      effFocus === null
        ? `Every timer is back on ${who}'s own thresholds (${this.pilotDefault()}/${this.pilotExitDefault()} dBm).`
        : `${gateLabel(this.store, effFocus)} is back on ${who}'s own thresholds (${this.pilotDefault()}/${this.pilotExitDefault()} dBm).`;
    const shortMsg =
      effFocus === null
        ? `Calibration cleared (${this.pilotDefault()}/${this.pilotExitDefault()} dBm)`
        : `${gateLabel(this.store, effFocus)}: calibration cleared (${this.pilotDefault()}/${this.pilotExitDefault()} dBm)`;
    return this.apply(
      targetGates.map((p) => ({ gateId: p.gateId, slotIndex, enterDbm: 0, exitDbm: 0 })),
      message,
      shortMsg
    );
  }

  // ---- data ------------------------------------------------------------------

  private syncGateMetaCache(): void {
    const rev = this.store.stateRev ?? 0;
    if (this.gateMetaRev === rev) return;
    this.gateMetaRev = rev;
    this.gateMetaById.clear();
    for (const node of this.store.nodes) {
      this.gateMetaById.set(node.gateId, {
        label: gateLabel(this.store, node.gateId),
        color: gateColor(this.store, node.gateId),
      });
    }
  }

  private colorOf(gateId: number): string {
    this.syncGateMetaCache();
    return this.gateMetaById.get(gateId)?.color ?? gateColor(this.store, gateId);
  }

  private labelOfGate(gateId: number): string {
    this.syncGateMetaCache();
    return this.gateMetaById.get(gateId)?.label ?? gateLabel(this.store, gateId);
  }

  /** Binary-search first index in a chronological `{ timestampUs }` array with `timestampUs >= ts`. */
  private static firstEventAtOrAfter<T extends { timestampUs: number }>(items: T[], ts: number): number {
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (items[mid].timestampUs < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private static crossingMetaKey(c: GateCrossingEvent): string {
    return `${c.slotIndex}:${c.gateId}:${c.timestampUs}:${c.eventId ?? 0}`;
  }

  private syncCrossingLapMeta(): void {
    const rev = this.store.stateRev ?? 0;
    if (this.crossingLapCacheRev === rev) return;
    this.crossingLapCacheRev = rev;
    this.crossingLapMeta.clear();

    const crossings = this.store.crossings;
    if (crossings.length === 0) return;

    const sfGateIds = new Set<number>();
    for (const node of this.store.nodes) {
      if (node.role === "START_FINISH") {
        sfGateIds.add(node.gateId);
      }
    }

    const lapsBySlot = new Map<
      number,
      Array<{
        lapNumber: number;
        completedAtUs: number;
        startAtUs: number;
        lapTimeSec: number;
        invalidated: boolean;
      }>
    >();
    for (const lap of this.store.laps) {
      let list = lapsBySlot.get(lap.slotIndex);
      if (!list) {
        list = [];
        lapsBySlot.set(lap.slotIndex, list);
      }
      list.push({
        lapNumber: lap.lapNumber,
        completedAtUs: lap.completedAtUs,
        startAtUs: 0,
        lapTimeSec: lap.lapTimeSec,
        invalidated: Boolean(lap.invalidated),
      });
    }
    lapsBySlot.forEach((list) => {
      list.sort((a, b) => a.completedAtUs - b.completedAtUs);
      for (let i = 0; i < list.length; i++) {
        const cur = list[i];
        cur.startAtUs =
          cur.lapTimeSec > 0
            ? Math.max(0, Math.round(cur.completedAtUs - cur.lapTimeSec * 1_000_000))
            : i > 0
              ? list[i - 1].completedAtUs
              : 0;
      }
    });

    const crossingsBySlot = new Map<number, GateCrossingEvent[]>();
    for (let i = 0; i < crossings.length; i++) {
      const c = crossings[i];
      let list = crossingsBySlot.get(c.slotIndex);
      if (!list) {
        list = [];
        crossingsBySlot.set(c.slotIndex, list);
      }
      list.push(c);
    }

    const maxLapUs = Math.max(15, this.store.rules.maxLapSec || 120) * 1_000_000;

    crossingsBySlot.forEach((slotCrossings, slotIndex) => {
      const slotLaps = lapsBySlot.get(slotIndex) ?? [];
      const sfTimestamps: number[] = [];
      for (let i = 0; i < slotCrossings.length; i++) {
        const c = slotCrossings[i];
        if (c.isStartFinish || sfGateIds.has(c.gateId)) {
          sfTimestamps.push(c.timestampUs);
        }
      }

      let lapCursor = 0;
      let sfCursor = 0;
      for (let i = 0; i < slotCrossings.length; i++) {
        const c = slotCrossings[i];
        const ts = c.timestampUs;
        const isSF = Boolean(c.isStartFinish || sfGateIds.has(c.gateId));
        let suffix = "";
        let detailPrefix = "Timed";

        while (lapCursor < slotLaps.length && slotLaps[lapCursor].completedAtUs + 10_000 < ts) {
          lapCursor++;
        }
        while (sfCursor + 1 < sfTimestamps.length && sfTimestamps[sfCursor + 1] <= ts) {
          sfCursor++;
        }

        if (isSF) {
          const matchedLap =
            lapCursor < slotLaps.length &&
            Math.abs(slotLaps[lapCursor].completedAtUs - ts) <= 10_000
              ? slotLaps[lapCursor]
              : undefined;
          if (matchedLap) {
            suffix = `Lap ${matchedLap.lapNumber}`;
            detailPrefix = matchedLap.invalidated
              ? `Lap ${matchedLap.lapNumber} (scratched)`
              : `Lap ${matchedLap.lapNumber} (${matchedLap.lapTimeSec.toFixed(2)}s)`;
          } else if (c.startedLap || slotLaps.length === 0) {
            suffix = "Start";
            detailPrefix = "Start";
          }
        } else {
          const candidateLap = lapCursor < slotLaps.length ? slotLaps[lapCursor] : undefined;
          if (
            candidateLap &&
            ts >= candidateLap.startAtUs - 50_000 &&
            ts <= candidateLap.completedAtUs + 10_000
          ) {
            suffix = `Lap ${candidateLap.lapNumber}`;
            detailPrefix = candidateLap.invalidated
              ? `Lap ${candidateLap.lapNumber} (scratched)`
              : `Lap ${candidateLap.lapNumber}`;
          } else {
            const lastSfTs =
              sfTimestamps.length > 0 && sfTimestamps[sfCursor] <= ts
                ? sfTimestamps[sfCursor]
                : undefined;
            const hasLaterSf =
              sfTimestamps.length > 0 && sfTimestamps[sfTimestamps.length - 1] > ts;
            const prevCrossTs = i > 0 ? slotCrossings[i - 1].timestampUs : lastSfTs ?? ts;
            if (lastSfTs !== undefined && !hasLaterSf && ts - prevCrossTs <= maxLapUs) {
              let prevLapNum = 0;
              for (let li = slotLaps.length - 1; li >= 0; li--) {
                if (slotLaps[li].completedAtUs <= lastSfTs + 10_000) {
                  prevLapNum = slotLaps[li].lapNumber;
                  break;
                }
              }
              const nextLapNum = prevLapNum + 1;
              suffix = `Lap ${nextLapNum}`;
              detailPrefix = `Lap ${nextLapNum} (in progress)`;
            }
          }
        }

        this.crossingLapMeta.set(PilotRssiChart.crossingMetaKey(c), {
          suffix,
          detailPrefix,
        });
      }
    });
  }

  private evaluateLivePilotCrossings(slotIndex: number): Map<number, LiveCrossingEval> {
    const dragSig = this.crossingDrag ? `${this.crossingDrag.eventId}:${this.crossingDrag.tsUs}` : "";
    const pendSig =
      this.pendingCrossings.size > 0
        ? Array.from(this.pendingCrossings.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join(",")
        : "";
    const delSig =
      this.pendingDeletedCrossings.size > 0 ? Array.from(this.pendingDeletedCrossings).join(",") : "";
    const nodes = this.store.nodes;
    const rules = this.store.rules;
    const rulesSig = `${rules.minLapSec}:${rules.maxLapSec}:${nodes
      .map((n) => {
        const eff = pilotGateRulesAt(this.store, n.gateId, slotIndex);
        return `${n.gateId}:${n.trackOrder}:${n.role}:${eff.minLapSec}:${eff.maxLapSec}`;
      })
      .join("|")}`;
    const sig = `${this.store.stateRev ?? 0}:${this.store.crossings.length}:${slotIndex}:${dragSig}:${pendSig}:${delSig}:${rulesSig}`;
    if (sig === this.liveEvalSig) {
      return this.liveEvalByEventId;
    }
    this.liveEvalSig = sig;
    this.liveEvalByEventId.clear();

    const ordered = [...nodes].sort((a, b) => a.trackOrder - b.trackOrder);
    const orderedIdx = new Map<number, number>();
    ordered.forEach((n, idx) => orderedIdx.set(n.gateId, idx));
    const sfGate = ordered.find((n) => n.role === "START_FINISH") ?? ordered[0];
    const sfGateId = sfGate?.gateId ?? 1;
    const hasSfGate = Boolean(ordered[0] && ordered[0].role === "START_FINISH");

    const list: Array<{ ev: GateCrossingEvent; effTs: number }> = [];
    for (const c of this.store.crossings) {
      if (c.slotIndex !== slotIndex || !c.eventId || this.pendingDeletedCrossings.has(c.eventId)) {
        continue;
      }
      const effTs =
        this.crossingDrag && this.crossingDrag.eventId === c.eventId
          ? this.crossingDrag.tsUs
          : this.pendingCrossings.has(c.eventId)
            ? this.pendingCrossings.get(c.eventId)!
            : c.timestampUs;
      list.push({ ev: c, effTs });
    }
    list.sort((a, b) => (a.effTs !== b.effTs ? a.effTs - b.effTs : a.ev.eventId - b.ev.eventId));

    const lastAcceptedGateUs = new Map<number, number>();
    let lapStartUs = 0;
    let lastGateId = 0;
    let lastGateTimeUs = 0;
    let completedLaps = 0;

    // Pre-scan valid SF timestamps so in-progress vs completed lap numbering is exact
    const validSfIndices = new Set<number>();
    {
      const tmpLastGateUs = new Map<number, number>();
      let tmpLapStart = 0;
      let tmpLastGate = 0;
      let tmpLastTime = 0;
      for (let i = 0; i < list.length; i++) {
        const { ev, effTs } = list[i];
        const effRules = pilotGateRulesAt(this.store, ev.gateId, slotIndex);
        const isSF = Boolean(ev.isStartFinish || ev.gateId === sfGateId);
        if (tmpLastGate !== 0 && (effTs - tmpLastTime) / 1e6 > effRules.maxLapSec) {
          tmpLapStart = 0;
          tmpLastGate = 0;
          tmpLastTime = 0;
        }
        if (!isSF && tmpLapStart === 0 && hasSfGate) continue;
        if (isSF && tmpLapStart > 0 && (effTs - tmpLapStart) / 1e6 < effRules.minLapSec) continue;
        const prevSame = tmpLastGateUs.get(ev.gateId);
        if (prevSame !== undefined && (effTs - prevSame) / 1e6 < effRules.minLapSec) continue;
        if (!isSF && tmpLapStart > 0 && tmpLastGate !== 0 && ordered.length >= 2) {
          const li = orderedIdx.get(tmpLastGate);
          const ci = orderedIdx.get(ev.gateId);
          if (li !== undefined && ci !== undefined && ci <= li) continue;
        }
        tmpLastGateUs.set(ev.gateId, effTs);
        if (isSF) {
          validSfIndices.add(i);
          tmpLapStart = effTs;
        }
        tmpLastGate = ev.gateId;
        tmpLastTime = effTs;
      }
    }

    for (let i = 0; i < list.length; i++) {
      const { ev, effTs } = list[i];
      const effRules = pilotGateRulesAt(this.store, ev.gateId, slotIndex);
      const isSF = Boolean(ev.isStartFinish || ev.gateId === sfGateId);
      const gateLbl = this.labelOfGate(ev.gateId);

      if (lastGateId !== 0 && (effTs - lastGateTimeUs) / 1e6 > effRules.maxLapSec) {
        lapStartUs = 0;
        lastGateId = 0;
        lastGateTimeUs = 0;
      }

      if (!isSF && lapStartUs === 0 && hasSfGate) {
        const sfLbl = this.labelOfGate(ordered[0].gateId);
        const detail = `${gateLbl} before ${sfLbl} (Start/Finish) - waiting for lap start`;
        this.liveEvalByEventId.set(ev.eventId, {
          effTs,
          counted: false,
          invalidReason: "OUT_OF_ORDER",
          invalidDetail: detail,
          suffix: FILTER_LABELS.OUT_OF_ORDER,
          detailPrefix: detail,
        });
        continue;
      }

      if (isSF && lapStartUs > 0) {
        const lapSec = Math.max(0, (effTs - lapStartUs) / 1e6);
        if (lapSec < effRules.minLapSec) {
          const detail = `Lap would be ${lapSec.toFixed(2)}s (min lap ${effRules.minLapSec.toFixed(1)}s)`;
          this.liveEvalByEventId.set(ev.eventId, {
            effTs,
            counted: false,
            invalidReason: "MIN_LAP",
            invalidDetail: detail,
            suffix: FILTER_LABELS.MIN_LAP,
            detailPrefix: detail,
          });
          continue;
        }
      }

      const prevSameUs = lastAcceptedGateUs.get(ev.gateId);
      if (prevSameUs !== undefined) {
        const sinceSame = Math.max(0, (effTs - prevSameUs) / 1e6);
        if (sinceSame < effRules.minLapSec) {
          const detail = isSF
            ? `Lap would be ${sinceSame.toFixed(2)}s (min lap ${effRules.minLapSec.toFixed(1)}s)`
            : `${gateLbl} again after ${sinceSame.toFixed(2)}s - quicker than min lap (${effRules.minLapSec.toFixed(1)}s)`;
          this.liveEvalByEventId.set(ev.eventId, {
            effTs,
            counted: false,
            invalidReason: "MIN_LAP",
            invalidDetail: detail,
            suffix: FILTER_LABELS.MIN_LAP,
            detailPrefix: detail,
          });
          continue;
        }
      }

      if (!isSF && lapStartUs > 0 && lastGateId !== 0 && ordered.length >= 2) {
        const lastIdx = orderedIdx.get(lastGateId);
        const candIdx = orderedIdx.get(ev.gateId);
        if (lastIdx !== undefined && candIdx !== undefined && candIdx <= lastIdx) {
          const nextIdx = (lastIdx + 1) % ordered.length;
          const lastLbl = this.labelOfGate(lastGateId);
          const nextLbl = this.labelOfGate(ordered[nextIdx].gateId);
          const detail = `${gateLbl} out of track order after ${lastLbl} (expecting ${nextLbl})`;
          this.liveEvalByEventId.set(ev.eventId, {
            effTs,
            counted: false,
            invalidReason: "OUT_OF_ORDER",
            invalidDetail: detail,
            suffix: FILTER_LABELS.OUT_OF_ORDER,
            detailPrefix: detail,
          });
          continue;
        }
      }

      // Valid crossing
      lastAcceptedGateUs.set(ev.gateId, effTs);
      let suffix = "";
      let detailPrefix = "Timed";
      if (isSF) {
        if (lapStartUs > 0) {
          const lapSec = (effTs - lapStartUs) / 1e6;
          if (lapSec > effRules.maxLapSec) {
            suffix = "Start";
            detailPrefix = "Start";
          } else {
            completedLaps++;
            suffix = `Lap ${completedLaps}`;
            detailPrefix = `Lap ${completedLaps} (${lapSec.toFixed(2)}s)`;
          }
        } else {
          suffix = "Start";
          detailPrefix = "Start";
        }
        lapStartUs = effTs;
      } else {
        const curLapNum = completedLaps + 1;
        let hasClosingSf = false;
        for (let j = i + 1; j < list.length; j++) {
          if (validSfIndices.has(j)) {
            hasClosingSf = true;
            break;
          }
        }
        const splitSec = lastGateTimeUs > 0 ? Math.max(0, (effTs - lastGateTimeUs) / 1e6) : 0;
        suffix = `Lap ${curLapNum}`;
        detailPrefix = hasClosingSf
          ? `Lap ${curLapNum}${splitSec > 0 ? ` · +${splitSec.toFixed(2)}s` : ""}`
          : `Lap ${curLapNum} (in progress)`;
      }
      lastGateId = ev.gateId;
      lastGateTimeUs = effTs;

      this.liveEvalByEventId.set(ev.eventId, {
        effTs,
        counted: true,
        invalidReason: null,
        invalidDetail: "",
        suffix,
        detailPrefix,
      });
    }

    return this.liveEvalByEventId;
  }

  /** Selected pilot's (or all seated pilots') passes in [from, to], oldest first. */
  private passes(from: number, to: number, gateFilter: ReadonlySet<number> | null = null): PassMarker[] {
    if (this.lapWindow) {
      from = Math.max(from, this.lapWindow.minUs);
      to = Math.min(to, this.lapWindow.maxUs);
      if (from > to) return [];
    }
    const crossings = this.store.crossings;
    const filtered = this.store.filtered;
    const out: PassMarker[] = [];
    if (crossings.length > 0 && this.isMultiPilotMode) {
      this.syncCrossingLapMeta();
    }
    const cStart = PilotRssiChart.firstEventAtOrAfter(crossings, from);
    const fStart = PilotRssiChart.firstEventAtOrAfter(filtered, from);
    const inLockedLapPassBounds = (tsUs: number, eventId?: number): boolean => {
      if (!this.lapWindow) return true;
      if (
        eventId !== undefined &&
        eventId > 0 &&
        (this.lapWindowAllowedEventIds.has(eventId) ||
          this.crossingDrag?.eventId === eventId ||
          this.pendingCrossings.has(eventId))
      ) {
        return tsUs >= this.lapWindow.minUs && tsUs <= this.lapWindow.maxUs;
      }
      return tsUs >= this.lapWindow.passMinUs && tsUs <= this.lapWindow.passMaxUs;
    };

    if (this.isMultiPilotMode && this.multiPilotSlots) {
      const slotSet = new Set(this.multiPilotSlots);
      for (let i = cStart; i < crossings.length; i++) {
        const c = crossings[i];
        if (c.timestampUs > to) break;
        if (gateFilter !== null && !gateFilter.has(c.gateId)) continue;
        if (!slotSet.has(c.slotIndex)) continue;
        const p = this.store.pilot(c.slotIndex);
        const who = p?.callsign ?? c.callsign ?? `P${c.slotIndex}`;
        const gateLbl = this.labelOfGate(c.gateId);
        const counted = !c.invalidReason;
        const meta = this.crossingLapMeta.get(PilotRssiChart.crossingMetaKey(c));
        out.push({
          ts: c.timestampUs,
          gateId: c.gateId,
          counted,
          title: !counted && c.invalidReason
            ? `${who} · ${gateLbl}-${FILTER_SHORT_CODES[c.invalidReason] ?? c.invalidReason}`
            : meta?.suffix
              ? `${who} · ${gateLbl} · ${meta.suffix}`
              : `${who} · ${gateLbl}`,
          detail: !counted && c.invalidDetail
            ? c.invalidDetail
            : `${meta?.detailPrefix ?? "Timed"} · peak ${c.peakRssiDbm.toFixed(0)}${this.unitSuffix}`,
          color: p?.color,
          slotIndex: c.slotIndex,
        });
      }
      for (let i = fStart; i < filtered.length; i++) {
        const f = filtered[i];
        if (f.timestampUs > to) break;
        if (gateFilter !== null && !gateFilter.has(f.gateId)) continue;
        if (!slotSet.has(f.slotIndex)) continue;
        const p = this.store.pilot(f.slotIndex);
        out.push({
          ts: f.timestampUs,
          gateId: f.gateId,
          counted: false,
          title: `${p?.callsign ?? `P${f.slotIndex}`} · ${this.labelOfGate(f.gateId)}-${FILTER_SHORT_CODES[f.reason] ?? f.reason}`,
          detail: f.detail,
          color: p?.color,
          slotIndex: f.slotIndex,
        });
      }
      if (out.length > 1) out.sort((a, b) => a.ts - b.ts);
      return out;
    }

    const slot = this.activePilotSlot;
    const hasLiveOverrides =
      this.crossingDrag !== null || this.pendingCrossings.size > 0 || this.pendingDeletedCrossings.size > 0;
    if (crossings.length > 0 && !hasLiveOverrides) {
      this.syncCrossingLapMeta();
    }
    const evalMap = hasLiveOverrides && crossings.length > 0 ? this.evaluateLivePilotCrossings(slot) : null;
    const scanStart = hasLiveOverrides ? 0 : cStart;
    const crossingTsSet = new Set<string>();

    for (let i = scanStart; i < crossings.length; i++) {
      const c = crossings[i];
      if (!hasLiveOverrides && c.timestampUs > to) break;
      if (gateFilter !== null && !gateFilter.has(c.gateId)) continue;
      if (c.slotIndex !== slot) continue;
      if (c.eventId && this.pendingDeletedCrossings.has(c.eventId)) continue;

      const evRes = c.eventId && evalMap ? evalMap.get(c.eventId) : undefined;
      const effTs = evRes ? evRes.effTs : c.timestampUs;
      if (effTs < from || effTs > to) continue;
      if (!inLockedLapPassBounds(c.timestampUs, c.eventId) && !inLockedLapPassBounds(effTs, c.eventId)) {
        continue;
      }

      crossingTsSet.add(`${c.gateId}:${c.timestampUs}`);
      const gateLbl = this.labelOfGate(c.gateId);
      const counted = evRes ? evRes.counted : !c.invalidReason;
      const invReason = evRes ? evRes.invalidReason : (c.invalidReason ?? null);
      const invDetail = evRes ? evRes.invalidDetail : (c.invalidDetail ?? "");
      const meta = !evRes ? this.crossingLapMeta.get(PilotRssiChart.crossingMetaKey(c)) : undefined;
      const suffix = evRes ? evRes.suffix : (meta?.suffix ?? "");
      const detailPrefix = evRes ? evRes.detailPrefix : (meta?.detailPrefix ?? "Timed");

      out.push({
        ts: effTs,
        origTs: c.timestampUs,
        eventId: c.eventId,
        gateId: c.gateId,
        counted,
        title: !counted && invReason
          ? `${gateLbl}-${FILTER_SHORT_CODES[invReason] ?? invReason}`
          : suffix
            ? `${gateLbl} · ${suffix}`
            : gateLbl,
        detail: !counted && invDetail
          ? invDetail
          : `${detailPrefix} · peak ${c.peakRssiDbm.toFixed(0)}${this.unitSuffix}`,
        slotIndex: c.slotIndex,
      });
    }
    for (let i = fStart; i < filtered.length; i++) {
      const f = filtered[i];
      if (f.timestampUs > to) break;
      if (gateFilter !== null && !gateFilter.has(f.gateId)) continue;
      if (f.slotIndex !== slot) continue;
      if (!inLockedLapPassBounds(f.timestampUs)) continue;
      if (crossingTsSet.has(`${f.gateId}:${f.timestampUs}`)) continue;
      out.push({
        ts: f.timestampUs,
        gateId: f.gateId,
        counted: false,
        title: `${this.labelOfGate(f.gateId)}-${FILTER_SHORT_CODES[f.reason] ?? f.reason}`,
        detail: f.detail,
        slotIndex: f.slotIndex,
      });
    }
    if (out.length > 1) out.sort((a, b) => a.ts - b.ts);
    return out;
  }

  /** Passes filtered to the currently checked timer subset (or all timers when none checked). */
  private focusedPasses(from: number, to: number): PassMarker[] {
    return this.passes(from, to, this.selectedGates.size > 0 ? this.selectedGates : null);
  }

  /** Index of the first frame at or after ts (binary search; frames are in time order). */
  private static firstAtOrAfter(frames: TimerTelemetryFrame[], ts: number): number {
    let lo = 0;
    let hi = frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].timestampUs < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private rssiAt(gateId: number, slot: number, ts: number): number | undefined {
    const frames = this.store.historyFor(gateId);
    if (frames.length === 0) return undefined;
    const i = Math.min(frames.length - 1, PilotRssiChart.firstAtOrAfter(frames, ts));
    return frames[i].rssi[slot];
  }

  // ---- drawing ---------------------------------------------------------------

  private draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const activePilots = this.isMultiPilotMode
      ? (this.multiPilotSlots ?? [])
          .map((si) => this.store.pilot(si))
          .filter((p): p is NonNullable<typeof p> => Boolean(p))
      : (() => {
          const single = this.store.pilot(this.activePilotSlot);
          return single ? [single] : [];
        })();
    if (activePilots.length === 0) return;
    const pilotEntries = activePilots
      .map((pilot) => ({ pilot, slot: this.store.pilots.indexOf(pilot) }))
      .filter((entry) => entry.slot >= 0);
    if (pilotEntries.length === 0) return;

    const padL = this.padL;
    const padT = this.padT;
    const plotW = w - padL - this.padR;
    const plotH = h - padT - PAD.b;
    this.plot = { x: padL, w: plotW, h: plotH };

    if (this.endUs !== null) this.endUs = this.clampEnd(this.endUs);
    const end = this.viewEnd();
    const ref = this.endUs === null ? end : this.refUs;
    const start = end - this.windowUs;

    this.updateAutoY(
      start,
      end,
      pilotEntries.map((e) => e.slot)
    );

    const xScale = plotW / this.windowUs;
    const ySpanLocal = Math.max(4, this.yMax - this.yMin);
    const yScale = plotH / ySpanLocal;
    const yMaxLocal = this.yMax;
    const xOf = (ts: number) => padL + (ts - start) * xScale;
    const yOf = (dbm: number) => padT + (yMaxLocal - dbm) * yScale;

    this.drawGrid(ctx, w, h, start, end, ref, xOf, yOf);

    if (this.latest > 0) {
      // Traces, decimated to roughly one point per pixel when zoomed out.
      ctx.save();
      ctx.beginPath();
      ctx.rect(padL, padT - 4, plotW, plotH + 8);
      ctx.clip();
      ctx.lineJoin = "round";
      ctx.lineWidth = 1.6;
      const gates = this.shownGates;
      gates.forEach((gate, gateIdx) => {
        const frames = this.store.historyFor(gate.gateId);
        const isPausedView = this.endUs !== null || (this.drag !== null && "startEndUs" in this.drag);
        const capEnd = isPausedView && ref > 0 ? Math.min(end, ref) : end;
        const from = Math.max(0, PilotRssiChart.firstAtOrAfter(frames, start) - 1);
        const to = Math.min(frames.length - 1, PilotRssiChart.firstAtOrAfter(frames, capEnd));
        if (to - from < 1) return;
        const samplePeriodUs = this.isRH && !this.hwMode.endsWith("_usb") ? 100_000 : 20_000;
        const estSamples = this.windowUs / samplePeriodUs;
        const step = Math.max(1, Math.floor(estSamples / Math.max(1, plotW)));
        for (const entry of pilotEntries) {
          ctx.strokeStyle = this.isMultiPilotMode
            ? adaptColorForTheme(entry.pilot.color || this.colorOf(gate.gateId))
            : this.colorOf(gate.gateId);
          ctx.setLineDash([]);
          ctx.beginPath();
          let lastY = padT;
          let lastTs = 0;
          if (step === 1) {
            for (let i = from; i <= to; i++) {
              const x = xOf(frames[i].timestampUs);
              const y = yOf(frames[i].rssi[entry.slot] ?? this.yMin);
              if (i === from) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
              lastY = y;
              lastTs = frames[i].timestampUs;
            }
          } else {
            // Anchor decimation buckets to immutable `timestampUs` (rather than 8-bit wrapping `seqNum`
            // or mutable array index `i`, which shifts on `trimHistory`) and preserve each bucket's
            // peak RSSI so gate crossings never shimmer or alias while scrolling zoomed-out windows.
            const bucketUs = step * samplePeriodUs;
            let started = false;
            let curBucket = -1;
            let peakVal = -Infinity;
            let peakTs = 0;
            for (let i = from; i <= to; i++) {
              const fr = frames[i];
              const b = Math.floor(fr.timestampUs / bucketUs);
              const val = fr.rssi[entry.slot] ?? this.yMin;
              if (b !== curBucket) {
                if (curBucket >= 0) {
                  const bx = xOf(peakTs);
                  const by = yOf(peakVal);
                  if (!started) {
                    ctx.moveTo(bx, by);
                    started = true;
                  } else {
                    ctx.lineTo(bx, by);
                  }
                  lastY = by;
                  lastTs = peakTs;
                }
                curBucket = b;
                peakVal = val;
                peakTs = fr.timestampUs;
              } else if (val >= peakVal) {
                peakVal = val;
                peakTs = fr.timestampUs;
              }
            }
            if (curBucket >= 0) {
              const bx = xOf(peakTs);
              const by = yOf(peakVal);
              if (!started) ctx.moveTo(bx, by);
              else ctx.lineTo(bx, by);
              lastY = by;
              lastTs = peakTs;
            }
          }
          if (
            this.endUs === null &&
            to === frames.length - 1 &&
            end > lastTs &&
            end - lastTs > 25_000 &&
            end - lastTs <= 300_000
          ) {
            ctx.lineTo(Math.min(padL + plotW, xOf(end)), lastY);
          }
          ctx.stroke();
        }
      });
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Shift+drag Y box-zoom overlay
    if (this.yZoomBox) {
      const ya = Math.max(padT, Math.min(padT + plotH, Math.min(this.yZoomBox.y0, this.yZoomBox.y1)));
      const yb = Math.max(padT, Math.min(padT + plotH, Math.max(this.yZoomBox.y0, this.yZoomBox.y1)));
      ctx.save();
      ctx.fillStyle = withAlpha(theme.accent, 0.12);
      ctx.fillRect(padL, ya, plotW, Math.max(1, yb - ya));
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(padL, ya + 0.5);
      ctx.lineTo(w - this.padR, ya + 0.5);
      ctx.moveTo(padL, yb + 0.5);
      ctx.lineTo(w - this.padR, yb + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      const dHigh = Math.round(this.dbmAt(ya));
      const dLow = Math.round(this.dbmAt(yb));
      ctx.fillStyle = theme.accent;
      ctx.font = font(600, 10.5, true);
      ctx.textAlign = "left";
      ctx.fillText(`Zoom Y: ${dLow} to ${dHigh}${this.unitSuffix}`, padL + 8, (ya + yb) / 2 + 3.5);
      ctx.restore();
    }

    if (this.focus !== null && !this.isMultiPilotMode) {
      this.drawThresholds(ctx, w, plotW, plotH);
    } else {
      this.tags = [];
    }
    if (this.latest === 0 && this.store.crossings.length === 0) {
      this.crossingBoxes = [];
      return;
    }

    // Pass markers: dashed in the gate's (or pilot's) colour when timed, red when set aside.
    // When paused & unlocked on a focused timer, crossings render interactive pill handles with `×` delete.
    ctx.font = font(600, 10.5);
    const passes = this.focusedPasses(start, end);
    const rows = passes.length > 0 ? this.labelRows(ctx, start, end) : this.cachedLabelRows;
    const canEdit = this.canEditCrossings;
    const prevCrossingHit =
      canEdit && !this.tagDrag && this.hoverX !== null && this.hoverY !== null
        ? this.crossingAt(this.hoverX, this.hoverY)
        : null;
    const nextCrossingBoxes: CrossingBox[] = [];
    let hovered: PassMarker | null = null;

    if (this.crossingDrag && this.crossingDrag.origTsUs >= start && this.crossingDrag.origTsUs <= end) {
      const origX = xOf(this.crossingDrag.origTsUs);
      const origColor = adaptColorForTheme(this.colorOf(this.crossingDrag.gateId));
      ctx.save();
      ctx.strokeStyle = withAlpha(origColor, 0.28);
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(origX, padT);
      ctx.lineTo(origX, padT + plotH);
      ctx.stroke();
      ctx.restore();
    }

    passes.forEach((p) => {
      const x = xOf(p.ts);
      const color = p.counted ? adaptColorForTheme(p.color || this.colorOf(p.gateId)) : theme.bad;
      const editable = canEdit && (p.eventId ?? 0) > 0;
      const isDraggingThis = editable && this.crossingDrag?.eventId === p.eventId;
      const isActiveCrossing =
        editable && (isDraggingThis || prevCrossingHit?.box.eventId === p.eventId);
      const isHoverDelete =
        editable && !isDraggingThis && Boolean(prevCrossingHit?.inDelete && prevCrossingHit.box.eventId === p.eventId);

      ctx.save();
      ctx.strokeStyle = withAlpha(color, isActiveCrossing ? 0.96 : p.counted ? 0.75 : 0.92);
      ctx.lineWidth = isActiveCrossing ? 2 : editable ? 1.4 : p.counted ? 1 : 1.5;
      ctx.setLineDash(isDraggingThis ? [] : editable ? (p.counted ? [4, 3] : [5, 3]) : p.counted ? [2, 3] : [5, 3]);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.restore();

      const lbl = this.labelOf(p);
      const row = rows.get(PilotRssiChart.keyOf(p)) ?? 0;
      if (editable) {
        ctx.font = font(700, 10.5);
        const delW = 16;
        const textW = ctx.measureText(lbl).width;
        const pillW = textW + 12 + delW;
        const pillY = p.counted
          ? padT + 2 + row * (TAG_H + 3)
          : Math.max(padT + 2, padT + plotH - TAG_H - 3 - row * (TAG_H + 3));
        const pillX = Math.max(
          padL + 2,
          Math.min(Math.max(padL + 2, padL + plotW - pillW - 2), x + 4)
        );
        const delX = pillX + pillW - delW;
        ctx.beginPath();
        ctx.roundRect(pillX, pillY, pillW, TAG_H, 5);
        if (isDraggingThis) {
          ctx.fillStyle = color;
          ctx.fill();
        } else {
          ctx.fillStyle = p.counted ? theme.surface : withAlpha(theme.bad, 0.14);
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = p.counted ? 1 : 1.4;
          ctx.stroke();
        }
        if (isActiveCrossing) {
          ctx.strokeStyle = p.counted ? theme.text : theme.bad;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        const fg = isDraggingThis ? inkOnColor(color) : color;
        ctx.fillStyle = fg;
        ctx.textAlign = "left";
        ctx.fillText(lbl, pillX + 7, pillY + 12.5);

        // Separator and `×` delete icon inside right end of handle
        ctx.save();
        if (isHoverDelete) {
          ctx.fillStyle = theme.bad;
          ctx.beginPath();
          ctx.roundRect(delX + 1, pillY + 2, delW - 3, TAG_H - 4, 3.5);
          ctx.fill();
        } else {
          ctx.strokeStyle = withAlpha(fg, 0.26);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(delX + 0.5, pillY + 3.5);
          ctx.lineTo(delX + 0.5, pillY + TAG_H - 3.5);
          ctx.stroke();
        }
        const cx = delX + delW * 0.5 - 0.5;
        const cy = pillY + TAG_H * 0.5;
        const rHalf = 2.8;
        ctx.strokeStyle = isHoverDelete ? "#ffffff" : fg;
        ctx.lineWidth = 1.5;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(cx - rHalf, cy - rHalf);
        ctx.lineTo(cx + rHalf, cy + rHalf);
        ctx.moveTo(cx + rHalf, cy - rHalf);
        ctx.lineTo(cx - rHalf, cy + rHalf);
        ctx.stroke();
        ctx.restore();

        nextCrossingBoxes.push({
          eventId: p.eventId!,
          gateId: p.gateId,
          slotIndex: p.slotIndex ?? this.activePilotSlot,
          origTsUs: p.origTs ?? p.ts,
          tsUs: p.ts,
          title: p.title,
          counted: p.counted,
          lineX: x,
          pillX,
          pillY,
          pillW,
          delX,
          delY: pillY,
          delW,
        });
      } else {
        ctx.fillStyle = color;
        ctx.font = font(600, 10.5);
        const tw = ctx.measureText(lbl).width;
        const tx = Math.max(padL + 2, Math.min(Math.max(padL + 2, padL + plotW - tw - 2), x + 4));
        const ty = p.counted
          ? padT + 11 + row * 12
          : Math.max(padT + 11, padT + plotH - 5 - row * 12);
        ctx.fillText(lbl, tx, ty);
      }

      if (isActiveCrossing) {
        hovered = p;
      } else if (this.hoverX !== null && Math.abs(this.hoverX - x) <= MARKER_HIT_PX) {
        hovered = p;
      }
    });
    this.crossingBoxes = nextCrossingBoxes;

    if (this.crossingDrag) {
      const pilotEntry = pilotEntries[0];
      const liveDbm = pilotEntry
        ? this.rssiAt(this.crossingDrag.gateId, pilotEntry.slot, this.crossingDrag.tsUs)
        : undefined;
      const gLbl = this.labelOfGate(this.crossingDrag.gateId);
      const readout =
        liveDbm !== undefined
          ? `${gLbl} · ${liveDbm.toFixed(1)}${this.unitSuffix}`
          : gLbl;
      this.syncDragReadout(readout);
    } else {
      if (this.lastDragReadoutText !== null) {
        this.syncDragReadout(null);
      }
      if (
        !this.tagDrag &&
        !this.yZoomBox &&
        !canEdit &&
        this.hoverX !== null &&
        this.hoverX >= padL &&
        this.hoverX <= padL + plotW
      ) {
        this.drawCursor(ctx, h, plotH, this.hoverX, hovered);
      }
    }
  }

  private syncDragReadout(text: string | null): void {
    if (text === this.lastDragReadoutText) return;
    this.lastDragReadoutText = text;
    const readoutEl = this.el.querySelector<HTMLElement>('[data-slot="drag-readout"]');
    const hintEl = this.el.querySelector<HTMLElement>('[data-slot="hint"]');
    if (!readoutEl) return;
    if (text === null) {
      readoutEl.hidden = true;
      readoutEl.textContent = "";
      if (hintEl) hintEl.hidden = false;
    } else {
      readoutEl.textContent = text;
      readoutEl.hidden = false;
      if (hintEl) hintEl.hidden = true;
    }
  }

  /**
   * Dual Enter and Exit threshold lines per focused gate, with draggable tags at the right
   * edge. Tags that would overlap are moved into extra columns to the left. Outlined tags
   * use the pilot's own threshold; filled tags are calibrated for that gate.
   */
  private drawThresholds(ctx: CanvasRenderingContext2D, w: number, plotW: number, plotH: number): void {
    const padT = this.padT;
    ctx.font = font(700, 10.5);
    const items: Array<{
      gateId: number;
      kind: "enter" | "exit";
      dbm: number;
      calibrated: boolean;
      text: string;
      lineY: number;
      width: number;
    }> = [];
    for (const p of this.shownGates) {
      const en = this.thresholdOf(p.gateId);
      const enText = this.isLapRF ? `Thresh ${en.dbm.toFixed(0)}` : `Enter ${en.dbm.toFixed(0)}`;
      const enY = Math.max(padT, Math.min(padT + plotH, this.yOf(en.dbm)));
      items.push({
        gateId: p.gateId,
        kind: "enter",
        dbm: en.dbm,
        calibrated: en.calibrated,
        text: enText,
        lineY: enY,
        width: ctx.measureText(enText).width + 14,
      });
      if (!this.isLapRF) {
        const ex = this.exitThresholdOf(p.gateId);
        const exText = `Exit ${ex.dbm.toFixed(0)}`;
        const exY = Math.max(padT, Math.min(padT + plotH, this.yOf(ex.dbm)));
        items.push({
          gateId: p.gateId,
          kind: "exit",
          dbm: ex.dbm,
          calibrated: ex.calibrated,
          text: exText,
          lineY: exY,
          width: ctx.measureText(exText).width + 14,
        });
      }
    }
    const colW = Math.max(...items.map((i) => i.width), 40) + TAG_GAP;

    const padL = this.padL;
    const rightEdge = padL + plotW - 6;
    // Column layout: each tag takes the right-most column where it doesn't overlap another.
    const columns: Array<Array<{ top: number }>> = [];
    const placed: TagBox[] = [];
    for (const item of [...items].sort((a, b) => a.lineY - b.lineY)) {
      const top = item.lineY - TAG_H / 2;
      let col = 0;
      while (columns[col]?.some((o) => Math.abs(o.top - top) < TAG_H + 2)) col++;
      (columns[col] ??= []).push({ top });
      placed.push({
        gateId: item.gateId,
        kind: item.kind,
        x: rightEdge - item.width - col * colW,
        y: top,
        w: item.width,
        lineY: item.lineY,
      });
    }
    this.tags = placed;

    const hoveredTag =
      this.tagDrag
        ? { gateId: this.tagDrag.gateId, kind: this.tagDrag.kind }
        : this.hoverX !== null && this.hoverY !== null
          ? this.tagAt(this.hoverX, this.hoverY)
          : null;
    for (const item of items) {
      const color = item.kind === "enter" ? this.colorOf(item.gateId) : "#94a3b8";
      const box = placed.find((b) => b.gateId === item.gateId && b.kind === item.kind)!;
      const isActive =
        hoveredTag !== null && hoveredTag.gateId === item.gateId && hoveredTag.kind === item.kind;
      // Line across the plot, joined to its tag.
      ctx.save();
      ctx.strokeStyle = withAlpha(color, isActive ? 0.95 : item.kind === "enter" ? 0.55 : 0.42);
      ctx.lineWidth = isActive ? 1.6 : 1.1;
      ctx.setLineDash(item.kind === "enter" ? [6, 4] : [3, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, item.lineY);
      ctx.lineTo(padL + plotW, item.lineY);
      ctx.stroke();
      ctx.restore();
      // Tag
      ctx.beginPath();
      ctx.roundRect(box.x, box.y, box.w, TAG_H, 5);
      if (item.calibrated) {
        ctx.fillStyle = color;
        ctx.fill();
      } else {
        ctx.fillStyle = theme.surface;
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      if (isActive) {
        ctx.strokeStyle = theme.text;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.fillStyle = item.calibrated ? inkOnColor(color) : color;
      ctx.font = font(700, 10.5);
      ctx.textAlign = "left";
      ctx.fillText(item.text, box.x + 7, box.y + 12.5);
    }
  }

  private labelOf(p: PassMarker): string {
    return p.title;
  }

  /**
   * Puts counted labels along the top of the plot and rejected (`OO`/`TS`/`TL`/`SP`) labels
   * along the bottom of the plot so rejected tags never collide with counted lap markers.
   */
  private labelRows(ctx: CanvasRenderingContext2D, start: number, end: number): Map<string, number> {
    const lookbackStart = Math.max(0, start - this.windowUs * 2);
    const windowPasses = this.focusedPasses(lookbackStart, end);
    const firstTs = windowPasses.length > 0 ? windowPasses[0].ts : 0;
    const lastTs = windowPasses.length > 0 ? windowPasses[windowPasses.length - 1].ts : 0;
    const multiSig = this.isMultiPilotMode ? (this.multiPilotSlots ?? []).join(",") : "";
    const editMode = this.canEditCrossings ? 1 : 0;
    const dragSig = this.crossingDrag ? `${this.crossingDrag.eventId}:${this.crossingDrag.tsUs}` : "";
    const sig = `${windowPasses.length}:${firstTs}:${lastTs}:${this.store.laps.length}:${this.store.stateRev ?? 0}:${editMode}:${dragSig}:${Math.round(this.windowUs)}:${Math.round(this.plot.w)}:${this.selectedGatesKey}:${this.activePilotSlot}:${multiSig}`;
    if (sig === this.cachedLabelSig) {
      return this.cachedLabelRows;
    }

    const rows = new Map<string, number>();
    const topRowEnd = [-Infinity, -Infinity];
    const botRowEnd = [-Infinity, -Infinity];
    const pxPerUs = Math.max(1e-9, this.plot.w / this.windowUs);
    const baseTs = firstTs;
    for (let i = 0; i < windowPasses.length; i++) {
      const p = windowPasses[i];
      const lbl = this.labelOf(p);
      let width = this.labelWidthCache.get(lbl);
      if (width === undefined) {
        width = ctx.measureText(lbl).width;
        if (this.labelWidthCache.size > 512) this.labelWidthCache.clear();
        this.labelWidthCache.set(lbl, width);
      }
      const x = (p.ts - baseTs) * pxPerUs;
      const targetRowEnd = p.counted ? topRowEnd : botRowEnd;
      const padExtra = editMode && (p.eventId ?? 0) > 0 ? 32 : 4;
      const row = x > targetRowEnd[0] + 6 ? 0 : x > targetRowEnd[1] + 6 ? 1 : 0;
      targetRowEnd[row] = x + width + padExtra;
      rows.set(PilotRssiChart.keyOf(p), row);
    }
    this.cachedLabelSig = sig;
    this.cachedLabelRows = rows;
    return rows;
  }

  private static keyOf(p: PassMarker): string {
    return `${p.ts}:${p.gateId}:${p.slotIndex ?? 0}:${p.counted ? 1 : 0}`;
  }

  private drawGrid(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    start: number,
    end: number,
    ref: number,
    xOf: (ts: number) => number,
    yOf: (dbm: number) => number
  ): void {
    ctx.font = font(500, 10.5, true);
    ctx.lineWidth = 1;
    const ySpan = Math.max(4, this.yMax - this.yMin);
    const dStep = this.isLapRF
      ? ySpan <= 500
        ? 100
        : ySpan <= 1400
          ? 250
          : 500
      : this.isRH
        ? ySpan <= 40
          ? 5
          : ySpan <= 90
            ? 15
            : ySpan <= 160
              ? 25
              : 50
        : ySpan <= 14
          ? 2
          : ySpan <= 32
            ? 5
            : ySpan <= 80
              ? 10
              : 15;
    const padL = this.padL;
    const padT = this.padT;
    for (let level = Math.ceil(this.yMin / dStep) * dStep; level <= this.yMax; level += dStep) {
      const y = Math.round(yOf(level)) + 0.5;
      if (y < padT - 1 || y > h - PAD.b + 1) continue;
      ctx.strokeStyle = theme.grid;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - this.padR, y);
      ctx.stroke();
      ctx.fillStyle = theme.text3;
      ctx.textAlign = "right";
      ctx.fillText(`${level}`, padL - (this.isMobileLayout ? 4 : 10), y + 3.5);
    }

    // Time ticks, labelled relative to now (or to when the view was paused).
    const winSec = this.windowUs / 1e6;
    const stepSec =
      winSec <= 0.8
        ? 0.1
        : winSec <= 1.8
          ? 0.25
          : winSec <= 4
            ? 0.5
            : winSec <= 8
              ? 1
              : winSec <= 12
                ? 2
                : winSec <= 20
                  ? 3
                  : winSec <= 38
                    ? 5
                    : winSec <= 75
                      ? 10
                      : winSec <= 160
                        ? 20
                        : winSec <= 400
                          ? 60
                          : 120;
    const stepUs = stepSec * 1e6;
    ctx.textAlign = "center";
    ctx.fillStyle = theme.text3;
    for (let t = ref - Math.floor((ref - start) / stepUs) * stepUs; t <= end + 1; t += stepUs) {
      const x = xOf(t);
      if (x < padL - 4 || x > w - this.padR + 4) continue;
      const agoSec = Math.max(0, (ref - t) / 1e6);
      const roundedAgo = Math.round(agoSec);
      const lbl =
        agoSec < 0.02
          ? this.endUs === null
            ? "now"
            : "paused"
          : stepSec < 0.5
            ? `−${agoSec.toFixed(2)}s`
            : stepSec < 1
              ? `−${agoSec.toFixed(1)}s`
              : stepSec >= 60 && roundedAgo % 60 === 0
                ? `−${roundedAgo / 60}m`
                : roundedAgo >= 120
                  ? `−${Math.floor(roundedAgo / 60)}m${roundedAgo % 60}s`
                  : `−${roundedAgo}s`;
      ctx.fillText(lbl, x, h - 8);
    }
    ctx.textAlign = "left";
  }

  /** Crosshair with the time under the cursor, plus details of a pass marker being hovered. */
  private drawCursor(ctx: CanvasRenderingContext2D, h: number, plotH: number, x: number, hovered: PassMarker | null): void {
    const padT = this.padT;
    ctx.save();
    ctx.strokeStyle = withAlpha(theme.text, 0.25);
    ctx.beginPath();
    ctx.moveTo(x + 0.5, padT);
    ctx.lineTo(x + 0.5, padT + plotH);
    ctx.stroke();
    ctx.restore();

    const ago = (this.ref - this.timeAt(x)) / 1e6;
    const label = ago < 0.05 ? "now" : `−${ago.toFixed(2)}s`;
    ctx.font = font(600, 10.5, true);
    const lw = ctx.measureText(label).width + 10;
    ctx.fillStyle = theme.chartSurface;
    ctx.fillRect(x - lw / 2, h - 20, lw, 16);
    ctx.fillStyle = theme.text;
    ctx.textAlign = "center";
    ctx.fillText(label, x, h - 8);
    ctx.textAlign = "left";

    if (!hovered) return;
    const lines = [hovered.title, hovered.detail];
    ctx.font = font(500, 11.5);
    const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20;
    const boxH = 42;
    const bx = Math.min(x + 10, this.padL + this.plot.w - boxW);
    const by = padT + 8;
    ctx.fillStyle = withAlpha(theme.surface, 0.95);
    ctx.strokeStyle = hovered.counted ? theme.gridStrong : withAlpha(theme.bad, 0.6);
    ctx.beginPath();
    ctx.roundRect(bx, by, boxW, boxH, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = hovered.counted ? theme.text : theme.bad;
    ctx.font = font(600, 11.5);
    ctx.fillText(lines[0], bx + 10, by + 17);
    ctx.fillStyle = theme.text2;
    ctx.font = font(500, 11.5);
    ctx.fillText(lines[1], bx + 10, by + 33);
  }

  // ---- controls & legend -----------------------------------------------------

  private renderControls(): void {
    const live = this.endUs === null;
    const btn = this.el.querySelector<HTMLButtonElement>('[data-act="live"]')!;
    const wantLiveClass = `btn btn-sm scope-live-btn ${live ? "btn-armed" : "btn-ghost"}`;
    const wantLiveTitle = live
      ? "Following live signal stream · click to pause (Space)"
      : "Stream paused · click to resume live stream (Space)";
    const wantLiveHtml = `<span class="status-dot ${live ? "is-up" : ""}"></span><span>Live</span>`;
    if (btn.className !== wantLiveClass) btn.className = wantLiveClass;
    if (btn.title !== wantLiveTitle) {
      btn.title = wantLiveTitle;
      btn.setAttribute("aria-label", wantLiveTitle);
    }
    if (btn.getAttribute("aria-pressed") !== String(live)) btn.setAttribute("aria-pressed", String(live));
    if (btn.innerHTML !== wantLiveHtml) btn.innerHTML = wantLiveHtml;

    const gateScope =
      this.focus !== null
        ? gateLabel(this.store, this.focus)
        : this.selectedGates.size >= 2
          ? `${this.selectedGates.size} selected timers`
          : "all timers";
    const prevBtn = this.el.querySelector<HTMLButtonElement>('[data-act="prev"]');
    const nextBtn = this.el.querySelector<HTMLButtonElement>('[data-act="next"]');
    if (prevBtn) prevBtn.title = `Previous pass at ${gateScope} (←)`;
    if (nextBtn) nextBtn.title = `Next pass at ${gateScope} (→)`;

    const resetViewBtn = this.el.querySelector<HTMLButtonElement>('[data-act="reset-view"]');
    if (resetViewBtn && this.lapWindow) {
      const isZoomed = !this.autoX || !this.autoY;
      const wantClass = `scope-chart-action-btn ${isZoomed ? "is-unlocked" : ""}`;
      if (resetViewBtn.className !== wantClass) resetViewBtn.className = wantClass;
    }

    const overlayEl = this.el.querySelector<HTMLElement>('[data-slot="chart-actions"]');
    if (overlayEl) {
      const showOverlay =
        this.focus !== null &&
        !this.isMultiPilotMode &&
        (this.contextMode === "practice" || !this.store.isHistoricalTrack);
      const overlaySig = `${showOverlay ? 1 : 0}:${this.focus ?? 0}:${this.chartLinesLocked ? 1 : 0}`;
      if (overlaySig !== this.lastOverlayActionsSig) {
        this.lastOverlayActionsSig = overlaySig;
        overlayEl.hidden = !showOverlay;
        if (showOverlay && this.focus !== null) {
          const gName = gateLabel(this.store, this.focus);
          const addBtn = overlayEl.querySelector<HTMLButtonElement>('[data-act="add-crossing"]');
          const lockBtn = overlayEl.querySelector<HTMLButtonElement>('[data-act="toggle-chart-lock"]');
          if (addBtn) {
            addBtn.disabled = this.chartLinesLocked;
            const addTitle = this.chartLinesLocked
              ? `Unlock chart lines to add ${gName} crossings`
              : `Add ${gName} crossing`;
            addBtn.title = addTitle;
            addBtn.setAttribute("aria-label", addTitle);
          }
          if (lockBtn) {
            lockBtn.className = `scope-chart-action-btn ${this.chartLinesLocked ? "is-locked" : "is-unlocked"}`;
            lockBtn.setAttribute("aria-pressed", String(!this.chartLinesLocked));
            const lockTitle = this.chartLinesLocked
              ? `Unlock ${gName} threshold and crossing lines`
              : `Lock ${gName} threshold and crossing lines`;
            lockBtn.title = lockTitle;
            lockBtn.setAttribute("aria-label", lockTitle);
            lockBtn.innerHTML = this.chartLinesLocked ? icons.lock(14) : icons.unlock(14);
          }
        }
      }
    }

    const aiChipEl = this.el.querySelector<HTMLElement>('[data-slot="ai-chip"]');
    if (aiChipEl) {
      const mlSt = this.store.mlStatus;
      if (mlSt?.config?.detectorMode === "ai") {
        const mod = mlSt.models?.find((m) => m.modelId === mlSt.config.activeModelId);
        const verLabel = mod ? `AI v${mod.version}` : "AI";
        const activeSlot = this.activePilotSlot;
        const tunes = (mlSt.liveTunes ?? []).filter((lt) => lt.slotIndex === activeSlot);
        const tuneSuffix =
          mlSt.config.liveTuneEnabled && tunes.length > 0
            ? ` · Tuned (${tunes[0].lapsUsed}L)`
            : mlSt.config.liveTuneEnabled
              ? " · Live Tune"
              : "";
        aiChipEl.hidden = false;
        aiChipEl.textContent = `${verLabel}${tuneSuffix}`;
      } else {
        aiChipEl.hidden = true;
      }
    }

    const winSec = this.windowUs / 1e6;
    const roundedWin = Math.round(winSec);
    const xWinLabel =
      roundedWin >= 120 && roundedWin % 60 === 0
        ? `${roundedWin / 60} min`
        : winSec < 10 && Math.abs(winSec - roundedWin) >= 0.05
          ? `${winSec.toFixed(1)} s`
          : `${roundedWin} s`;
    const xWinShort =
      roundedWin >= 120 && roundedWin % 60 === 0
        ? `${roundedWin / 60}m`
        : winSec < 10 && Math.abs(winSec - roundedWin) >= 0.05
          ? `${winSec.toFixed(1)}s`
          : `${roundedWin}s`;

    const isLapRF = this.isLapRF;
    const isRH = this.isRH;
    const unitSuffix = this.unitSuffix;
    const floorLo = isLapRF ? 250 : isRH ? 0 : -98;
    const floorHi = isLapRF ? 1400 : isRH ? 110 : -64;
    const isFloorY =
      !this.autoY && Math.round(this.yMin) === floorLo && Math.round(this.yMax) === floorHi;
    const isFullY =
      !this.autoY && Math.round(this.yMin) === this.defYMin && Math.round(this.yMax) === this.defYMax;
    const yShort = isFloorY
      ? "Floor"
      : isFullY
        ? "Full"
        : `${Math.round(this.yMax - this.yMin)}${isLapRF || isRH ? "" : "dB"}`;

    const autoWinSec = this.defaultWindowUs / 1e6;
    const autoWinLabel =
      Math.round(autoWinSec) >= 120 && Math.round(autoWinSec) % 60 === 0
        ? `${Math.round(autoWinSec) / 60} min`
        : autoWinSec < 10 && Math.abs(autoWinSec - Math.round(autoWinSec)) >= 0.05
          ? `${autoWinSec.toFixed(1)} s`
          : `${Math.round(autoWinSec)} s`;
    const visiblePresets = this.lapWindow
      ? WINDOWS_SEC.filter((w) => w < autoWinSec - 0.25)
      : WINDOWS_SEC;

    const nextAxisHtml = `
      <div class="debug-axis-pill ${this.autoX ? "is-armed" : "is-unarmed"}" data-axis-pill>
        <button type="button" class="debug-axis-pill-main" data-axis-act="${this.autoX ? "toggle-menu" : "auto-x"}" data-menu="rssi-x" title="${this.autoX ? `Auto X-axis time window (${xWinLabel}) · click to choose a time window preset, or drag X-axis to stretch` : `Click to reset X-axis time window to Auto X (${autoWinLabel})`}">
          ${icons.target(13)}<span>${this.autoX ? "Auto X" : `<span class="debug-hint-desktop">X: ${xWinLabel}</span><span class="debug-hint-mobile">X: ${xWinShort}</span>`}</span>
        </button>
        <button type="button" class="debug-axis-pill-arrow" data-axis-act="toggle-menu" data-menu="rssi-x" aria-expanded="${this.openAxisMenu === "rssi-x"}" title="Choose X-axis time window">
          ${icons.chevronDown(12)}
        </button>
        ${
          this.openAxisMenu === "rssi-x"
            ? `<div class="debug-axis-menu" role="menu" aria-label="X-axis time window">
                <button type="button" class="debug-axis-menu-item ${this.autoX ? "is-active" : ""}" data-axis-act="auto-x" role="menuitem">
                  <span>Auto X</span><span class="note">${this.lapWindow ? `Full lap (${autoWinLabel})` : autoWinLabel}</span>
                </button>
                ${
                  visiblePresets.length > 0
                    ? `<div class="debug-axis-menu-sep"></div>
                       ${visiblePresets.map((w) => {
                         const active = !this.autoX && Math.abs(winSec - w) < 0.05;
                         const label = w >= 120 ? `${w / 60} min` : `${w} s`;
                         return `<button type="button" class="debug-axis-menu-item ${active ? "is-active" : ""}" data-window="${w}" role="menuitem"><span>${label}</span></button>`;
                       }).join("")}`
                    : ""
                }
              </div>`
            : ""
        }
      </div>
      <div class="debug-axis-pill ${this.autoY ? "is-armed" : "is-unarmed"}" data-axis-pill>
        <button type="button" class="debug-axis-pill-main" data-axis-act="${this.autoY ? "toggle-menu" : "auto-y"}" data-menu="rssi-y" title="${this.autoY ? "Auto Y-axis scaling is ON (fits visible timer traces automatically). Click to choose a scale preset, or drag the Y-axis to stretch." : "Click to reset Y-axis range to Auto Y"}">
          ${icons.target(13)}<span>${this.autoY ? "Auto Y" : `<span class="debug-hint-desktop">Y: ${Math.round(this.yMin)}…${Math.round(this.yMax)}${unitSuffix}</span><span class="debug-hint-mobile">Y: ${yShort}</span>`}</span>
        </button>
        <button type="button" class="debug-axis-pill-arrow" data-axis-act="toggle-menu" data-menu="rssi-y" aria-expanded="${this.openAxisMenu === "rssi-y"}" title="Choose Y-axis scale">
          ${icons.chevronDown(12)}
        </button>
        ${
          this.openAxisMenu === "rssi-y"
            ? `<div class="debug-axis-menu" role="menu" aria-label="Y-axis scale">
                <button type="button" class="debug-axis-menu-item ${this.autoY ? "is-active" : ""}" data-axis-act="auto-y" role="menuitem">
                  <span>Auto Y</span><span class="note">Fit traces</span>
                </button>
                <div class="debug-axis-menu-sep"></div>
                <button type="button" class="debug-axis-menu-item ${isFloorY ? "is-active" : ""}" data-axis-act="floor-y" role="menuitem">
                  <span>Noise floor</span><span class="note">${isLapRF ? "250…1400" : isRH ? "0…110" : "−98…−64 dBm"}</span>
                </button>
                <button type="button" class="debug-axis-menu-item ${isFullY ? "is-active" : ""}" data-axis-act="full-y" role="menuitem">
                  <span>Full scale</span><span class="note">${this.defYMin}…${this.defYMax}${unitSuffix}</span>
                </button>
              </div>`
            : ""
        }
      </div>`;
    if (nextAxisHtml !== this.lastAxisControlsHtml) {
      this.lastAxisControlsHtml = nextAxisHtml;
      this.slot("axis-controls").innerHTML = nextAxisHtml;
    }

    const nextHint = live
      ? "Live · drag chart to pan · Shift+drag box to zoom · drag axes to stretch"
      : this.canEditCrossings
        ? "Paused · drag crossing lines or thresholds to adjust · drag chart to pan"
        : "Paused · drag chart to pan · Shift+drag box to zoom · drag axes to stretch";
    const hintEl = this.slot("hint");
    if (hintEl.textContent !== nextHint) hintEl.textContent = nextHint;
  }

  /** The calibration row: what the tags mean, Auto-calibrate, Reset, and the last result with Undo. */
  private renderCalib(): void {
    if (this.isMultiPilotMode) {
      const count = (this.multiPilotSlots ?? []).length;
      const multiHtml = `<span class="scope-calib-text">Showing all ${count} seated pilots simultaneously - select an individual pilot above to tune thresholds.</span>`;
      if (multiHtml !== this.lastCalibHtml) {
        this.lastCalibHtml = multiHtml;
        this.slot("calib").innerHTML = multiHtml;
      }
      return;
    }
    const pilot = this.store.pilot(this.activePilotSlot);
    if (!pilot) return;
    if (this.store.isHistoricalTrack) {
      const histHtml = `<span class="scope-calib-text">Historical track snapshot (read-only) - thresholds reflect recorded session gates.</span>`;
      if (histHtml !== this.lastCalibHtml) {
        this.lastCalibHtml = histHtml;
        this.slot("calib").innerHTML = histHtml;
      }
      return;
    }
    const minutes = Math.round(HISTORY_SECONDS / 60);
    const isLapRF = this.isLapRF;
    const isRH = this.isRH;
    const canAutoCalib = !isLapRF && !isRH;

    const canTune = !this.isMultiPilotMode && !this.store.isHistoricalTrack;
    let textHtml: string;
    let actions: string;
    if (this.focus === null) {
      if (this.calibMessage) {
        const shortMsg = this.calibMessageShort || this.calibMessage;
        textHtml = `<span class="scope-calib-text-full">${esc(this.calibMessage)}</span><span class="scope-calib-text-short">${esc(shortMsg)}</span>`;
      } else if (this.selectedGates.size >= 2) {
        const names = this.shownGates.map((g) => this.labelOfGate(g.gateId)).join(", ");
        const fullText = `Comparing ${this.selectedGates.size} timers (${names}) · select a single timer to unlock or adjust thresholds and crossings.`;
        const shortText = `Comparing ${names} · select 1 timer to edit.`;
        textHtml = `<span class="scope-calib-text-full">${esc(fullText)}</span><span class="scope-calib-text-short">${esc(shortText)}</span>`;
      } else {
        const fullText = isLapRF
          ? "Select a timer above to view or drag its LapRF crossing threshold (300–3500)."
          : isRH
            ? "Select a timer above to view or drag its RotorHazard Enter & Exit thresholds (0–255)."
            : "Timers auto-calibrate continuously from live lap passes · select a timer above to inspect or drag its thresholds.";
        const shortText = "Select a timer above to inspect or adjust thresholds.";
        textHtml = `<span class="scope-calib-text-full">${esc(fullText)}</span><span class="scope-calib-text-short">${esc(shortText)}</span>`;
      }
      actions = "";
    } else {
      const name = gateLabel(this.store, this.focus);
      const pilotPos = this.store.pilots.indexOf(pilot);
      const t = enterThresholdAt(this.store, this.focus, pilot.slotIndex);
      const ex = exitThresholdAt(this.store, this.focus, pilot.slotIndex);
      const isCal = isLapRF ? t.calibrated : t.calibrated || ex.calibrated;
      const isCalibrating = this.calibratingGates.has(this.focus);
      const canCalibThisGate = canAutoCalib && (isCal || isCalibrating || this.canGateCalibrateNow(this.focus, pilotPos));
      const isTuneOpen = this.tuneDrawerOpen && this.tuningGateId === this.focus;
      if (this.calibMessage) {
        const shortMsg = this.calibMessageShort || this.calibMessage;
        textHtml = `<span class="scope-calib-text-full">${esc(this.calibMessage)}</span><span class="scope-calib-text-short">${esc(shortMsg)}</span>`;
      } else {
        const baseText = isLapRF
          ? `${name}: Threshold ${t.dbm.toFixed(0)} ${isCal ? "(calibrated)" : "(default)"}`
          : `${name}: Enter ${t.dbm.toFixed(0)} / Exit ${ex.dbm.toFixed(0)}${this.unitSuffix} ${isCal ? "(calibrated)" : "(default)"}`;
        const dragHint = this.chartLinesLocked
          ? " · unlock lines in chart to adjust"
          : isLapRF
            ? " · drag line to adjust"
            : " · drag lines to adjust";
        textHtml = `${esc(baseText)}<span class="scope-calib-drag-hint">${esc(dragHint)}</span>`;
      }
      const calibButton = isCalibrating
        ? `<button class="btn btn-sm btn-ghost is-calibrating" type="button" data-calib="busy" disabled aria-disabled="true" title="Calibrating ${esc(name)}…">${icons.spinner(16)}<span>Calibrating…</span></button>`
        : isCal
          ? `<button class="btn btn-sm btn-ghost" type="button" data-calib="reset" title="Clear calibrated thresholds at ${esc(name)} and restore ${esc(pilot.callsign)}'s default thresholds">${icons.targetOff(16)}<span>Clear calibration</span></button>`
          : canCalibThisGate
            ? `<button class="btn btn-sm btn-ghost" type="button" data-calib="auto" title="Calibrate ${esc(name)}'s thresholds from the last ${minutes} minutes of signal">${icons.target(17)}<span>Calibrate</span></button>`
            : "";
      const actionButtons = [
        calibButton,
        canTune ? `<button class="btn btn-sm btn-ghost scope-calib-tune-btn ${isTuneOpen ? "is-active" : ""}" type="button" data-tune-gate="${this.focus}" aria-expanded="${isTuneOpen}" title="Fine-tune detection rules for ${esc(name)}">${icons.sliders(17)}<span>Fine-tune</span></button>` : "",
      ].filter(Boolean).join("");
      actions = actionButtons ? `<div class="scope-calib-actions">${actionButtons}</div>` : "";
    }
    const nextCalibHtml = `
      <span class="scope-calib-text">${textHtml}</span>
      ${actions}`;
    if (nextCalibHtml !== this.lastCalibHtml) {
      this.lastCalibHtml = nextCalibHtml;
      this.slot("calib").innerHTML = nextCalibHtml;
    }
  }

  /** Each timer's reading at the cursor (or at the right edge of the view), plus the "All timers" option. */
  private renderLegend(): void {
    const unitSuffix = this.unitSuffix;
    const at = this.hoverX !== null && this.hoverX >= this.plot.x && this.hoverX <= this.plot.x + this.plot.w ? this.timeAt(this.hoverX) : this.viewEnd();
    let slots: number[] = [];
    if (this.isMultiPilotMode) {
      slots = (this.multiPilotSlots ?? [])
        .map((si) => {
          const p = this.store.pilot(si);
          return p ? this.store.pilots.indexOf(p) : -1;
        })
        .filter((idx) => idx >= 0);
    } else {
      const pilot = this.store.pilot(this.activePilotSlot);
      if (!pilot) return;
      const idx = this.store.pilots.indexOf(pilot);
      if (idx >= 0) slots = [idx];
    }
    if (slots.length === 0) return;

    const legendEl = this.slot("legend");
    const activeSlot = this.activePilotSlot;
    const canTune = !this.isMultiPilotMode && !this.store.isHistoricalTrack;
    const isLapRF = this.isLapRF;
    const isRH = this.isRH;
    const canAutoCalib = !isLapRF && !isRH;
    const activePilotIdx = slots[0] ?? -1;
    let readyMask = 0;
    if (canTune && canAutoCalib) {
      const nodes = this.store.nodes;
      for (let i = 0; i < nodes.length; i++) {
        if (this.canGateCalibrateNow(nodes[i].gateId, activePilotIdx)) {
          readyMask |= 1 << (i & 30);
        }
      }
    }
    const selKey = this.selectedGatesKey;
    const calibBusyKey = this.calibratingGates.size > 0 ? Array.from(this.calibratingGates).sort((a, b) => a - b).join(",") : "";
    const fastKey = `${this.store.stateRev ?? 0}|${selKey}|${this.tuningGateId ?? "closed"}|${this.tuneDrawerOpen ? 1 : 0}|${activeSlot}|${this.isMultiPilotMode ? (this.multiPilotSlots ?? []).join(",") : "single"}|${unitSuffix}|${this.pending.size}|${calibBusyKey}|${readyMask}`;
    if (fastKey !== this.lastFastLegendKey || legendEl.childElementCount === 0) {
      this.lastFastLegendKey = fastKey;
      const globalOvrCount = canTune ? countGlobalOverrides(this.store.rules) : 0;
      const isGateCalibrated = (gateId: number): boolean => {
        if (!canTune) return false;
        const t = enterThresholdAt(this.store, gateId, activeSlot);
        if (isLapRF) return t.calibrated;
        return t.calibrated || exitThresholdAt(this.store, gateId, activeSlot).calibrated;
      };
      const anyCalibrated = canTune && this.store.nodes.some((p) => isGateCalibrated(p.gateId));
      const structSig = [
        selKey,
        this.tuningGateId ?? "closed",
        this.tuneDrawerOpen ? "open" : "closed",
        this.isMultiPilotMode ? "multi" : "single",
        canTune ? "tunable" : "readonly",
        canAutoCalib ? "autocalib" : "manualcalib",
        anyCalibrated ? "anycal" : "nocal",
        unitSuffix,
        `global:${globalOvrCount}`,
        `busy:${calibBusyKey}`,
        `ready:${readyMask}`,
        this.store.nodes
          .map((p) => {
            const gEff = gateRulesAt(this.store, p.gateId);
            const gOvr = countGateOverrides(p.ruleOverrides, this.store.rules);
            const pOvr = countPilotOverrides(pilotGateOverridesAt(p, activeSlot), gEff);
            const cal = isGateCalibrated(p.gateId) ? 1 : 0;
            const busy = this.calibratingGates.has(p.gateId) ? 1 : 0;
            const rdy = canAutoCalib && this.canGateCalibrateNow(p.gateId, activePilotIdx) ? 1 : 0;
            return `${p.gateId}:${this.labelOfGate(p.gateId)}:${this.colorOf(p.gateId)}:${gOvr}:${pOvr}:${cal}:${busy}:${rdy}`;
          })
          .join(","),
      ].join("|");

      if (structSig !== this.lastLegendStructSig || legendEl.childElementCount === 0) {
        this.lastLegendStructSig = structSig;
        const isAllSelected = this.selectedGates.size === 0;
        const allChip = `
          <button type="button" class="channel channel-all ${isAllSelected ? "is-focus" : "is-dim"}"
                  data-focus="all" title="Show all timers (${this.store.nodes.length})">
            <span class="dot channel-all-dot"></span>
            <span class="channel-name">All timers</span>
            <span class="channel-right-cols">
              <span class="channel-dbm mono">${this.store.nodes.length} timers</span>
            </span>
          </button>`;
        const gateChips = this.store.nodes
          .map((p) => {
            let dbm = this.defYMin;
            let hasReading = false;
            for (const s of slots) {
              const v = this.rssiAt(p.gateId, s, at);
              if (v !== undefined && (!hasReading || v > dbm)) {
                dbm = v;
                hasReading = true;
              }
            }
            const isChecked = this.selectedGates.has(p.gateId);
            const isSolo = this.selectedGates.size === 1 && isChecked;
            const hot = !this.isMultiPilotMode && dbm >= this.thresholdOf(p.gateId).dbm;
            const dim = !isAllSelected && !isChecked;
            const label = this.labelOfGate(p.gateId);
            const gOvrCount = canTune ? countGateOverrides(p.ruleOverrides, this.store.rules) : 0;
            const pOvrCount = canTune
              ? countPilotOverrides(pilotGateOverridesAt(p, activeSlot), gateRulesAt(this.store, p.gateId))
              : 0;
            const hasOvr = gOvrCount + pOvrCount > 0;
            const isCal = isGateCalibrated(p.gateId);
            const isCalibrating = this.calibratingGates.has(p.gateId);
            const canCalibGate = canAutoCalib && this.canGateCalibrateNow(p.gateId, activePilotIdx);
            const isGateTuneOpen = this.tuneDrawerOpen && this.tuningGateId === p.gateId;
            const calibColHtml = canTune
              ? isCalibrating
                ? `<span role="button" aria-disabled="true" class="channel-mobile-action-btn is-calib is-calibrating" data-calib-gate="${p.gateId}" data-calib-busy="1" title="Calibrating ${esc(label)}…" aria-label="Calibrating ${esc(label)}…">${icons.spinner(18)}</span>`
                : isCal
                  ? `<span role="button" tabindex="0" class="channel-mobile-action-btn is-calib is-calibrated" data-calib-gate="${p.gateId}" data-calib-mode="reset" title="Clear calibrated thresholds for ${esc(label)}" aria-label="Clear calibrated thresholds for ${esc(label)}">${icons.targetOff(18)}</span>`
                  : canCalibGate
                    ? `<span role="button" tabindex="0" class="channel-mobile-action-btn is-calib" data-calib-gate="${p.gateId}" data-calib-mode="auto" title="Calibrate ${esc(label)}" aria-label="Calibrate ${esc(label)}">${icons.target(18)}</span>`
                    : `<span class="channel-mobile-action-spacer" aria-hidden="true"></span>`
              : "";
            const tuneColHtml = canTune
              ? `<span role="button" tabindex="0" class="channel-mobile-action-btn is-tune ${isGateTuneOpen ? "is-active" : ""}" data-tune-gate="${p.gateId}" title="Fine-tune ${esc(label)}" aria-label="Fine-tune ${esc(label)}">${icons.sliders(18)}</span>`
              : "";
            const initText = `${this.isMultiPilotMode ? "peak " : ""}${dbm.toFixed(0)}${unitSuffix}`;
            return `
              <button type="button" class="channel ${hot ? "is-hot" : ""} ${dim ? "is-dim" : ""} ${isChecked ? "is-focus" : ""}"
                      data-gate-chip="${p.gateId}"
                      data-focus="${isSolo ? "all" : p.gateId}" title="${isSolo ? "Show all timers" : "Show only this timer"}">
                <span class="practice-sector-checkbox channel-gate-check ${isChecked ? "is-checked" : ""}"
                      data-gate-check="${p.gateId}"
                      role="checkbox"
                      aria-checked="${isChecked}"
                      tabindex="0"
                      title="${isChecked ? `Hide ${esc(label)} trace` : `Compare ${esc(label)} trace`}"
                      aria-label="Toggle ${esc(label)} trace"></span>
                <span class="dot" style="--c:${this.colorOf(p.gateId)}"></span>
                <span class="channel-name">${esc(label)}</span>
                ${hasOvr ? `<span class="channel-custom-icon" title="Customized" aria-label="Customized">${icons.pencil(12)}</span>` : ""}
                <span class="channel-right-cols">
                  <span class="channel-dbm mono" data-gate-dbm="${p.gateId}">${initText}</span>
                  ${calibColHtml}
                  ${tuneColHtml}
                </span>
              </button>`;
          })
          .join("");
        legendEl.innerHTML = allChip + gateChips;
        this.legendRowDomByGate.clear();
        for (const p of this.store.nodes) {
          const chipEl = legendEl.querySelector<HTMLElement>(`[data-gate-chip="${p.gateId}"]`);
          const dbmEl = legendEl.querySelector<HTMLElement>(`[data-gate-dbm="${p.gateId}"]`);
          if (chipEl && dbmEl) {
            this.legendRowDomByGate.set(p.gateId, {
              chipEl,
              dbmEl,
              lastHot: chipEl.classList.contains("is-hot"),
              lastText: dbmEl.textContent ?? "",
            });
          }
        }
        return;
      }
    }

    // Fast in-place update of live RSSI numbers using cached DOM element references
    const prefix = this.isMultiPilotMode ? "peak " : "";
    for (const p of this.store.nodes) {
      const rowRef = this.legendRowDomByGate.get(p.gateId);
      if (!rowRef) continue;
      let dbm = this.defYMin;
      let hasReading = false;
      for (const s of slots) {
        const v = this.rssiAt(p.gateId, s, at);
        if (v !== undefined && (!hasReading || v > dbm)) {
          dbm = v;
          hasReading = true;
        }
      }
      const hot = !this.isMultiPilotMode && dbm >= this.thresholdOf(p.gateId).dbm;
      if (hot !== rowRef.lastHot) {
        rowRef.lastHot = hot;
        rowRef.chipEl.classList.toggle("is-hot", hot);
      }
      const nextText = `${prefix}${Math.round(dbm)}${unitSuffix}`;
      if (nextText !== rowRef.lastText) {
        rowRef.lastText = nextText;
        rowRef.dbmEl.textContent = nextText;
      }
    }
  }

  private formatTuneVal(val: number, decimals: number): string {
    if (decimals <= 0) return String(Math.round(val));
    const fixed = val.toFixed(decimals);
    return fixed.replace(/\.0+$/, "").replace(/(\.\d*?[1-9])0+$/, "$1");
  }

  private get activeTuneGateId(): number | null {
    return this.tuningGateId ?? this.focus;
  }

  private currentScopeOverrides(gateId: number, slotIndex: number): GateRuleOverrides {
    const node = this.store.node(gateId);
    if (!node) return {};
    if (this.tuningScope === "pilot") {
      return { ...pilotGateOverridesAt(node, slotIndex) };
    }
    return { ...(node.ruleOverrides ?? {}) };
  }

  private effectiveRulesForScope(gateId: number | null, slotIndex: number): TimingRules {
    if (gateId === null) {
      return this.store.rules;
    }
    return this.tuningScope === "pilot"
      ? pilotGateRulesAt(this.store, gateId, slotIndex)
      : gateRulesAt(this.store, gateId);
  }

  private async applyTuneRuleValue(key: GateRuleKey, rawVal: number): Promise<void> {
    if (this.store.isHistoricalTrack) return;
    const spec = TUNE_RULES.find((s) => s.key === key);
    if (!spec) return;
    const clamped = Math.max(spec.min, Math.min(spec.max, Number(rawVal.toFixed(spec.decimals + 1))));
    const targetGateId = this.activeTuneGateId;
    if (targetGateId === null) {
      await this.api.updateRules({ ...this.store.rules, [key]: clamped }).catch(() => undefined);
      return;
    }
    const slotIndex = this.activePilotSlot;
    const nextOverrides: GateRuleOverrides = {
      ...this.currentScopeOverrides(targetGateId, slotIndex),
      [key]: clamped,
    };
    if (this.tuningScope === "pilot") {
      await this.api.setPilotGateRules(targetGateId, slotIndex, nextOverrides).catch(() => undefined);
    } else {
      await this.api.setGateRules(targetGateId, nextOverrides).catch(() => undefined);
    }
  }

  private async stepTuneRule(key: GateRuleKey, dir: number): Promise<void> {
    if (this.store.isHistoricalTrack) return;
    const spec = TUNE_RULES.find((s) => s.key === key);
    if (!spec) return;
    const targetGateId = this.activeTuneGateId;
    const slotIndex = this.activePilotSlot;
    const eff = this.effectiveRulesForScope(targetGateId, slotIndex);
    const next = eff[key] + dir * spec.step;
    await this.applyTuneRuleValue(key, next);
  }

  private async resetSingleTuneRule(key: GateRuleKey): Promise<void> {
    if (this.store.isHistoricalTrack) return;
    const targetGateId = this.activeTuneGateId;
    if (targetGateId === null) {
      await this.api.updateRules({ ...this.store.rules, [key]: DEFAULT_TUNE_RULES[key] }).catch(() => undefined);
      return;
    }
    const slotIndex = this.activePilotSlot;
    const nextOverrides: GateRuleOverrides = {
      ...this.currentScopeOverrides(targetGateId, slotIndex),
    };
    delete nextOverrides[key];
    if (this.tuningScope === "pilot") {
      await this.api.setPilotGateRules(targetGateId, slotIndex, nextOverrides).catch(() => undefined);
    } else {
      await this.api.setGateRules(targetGateId, nextOverrides).catch(() => undefined);
    }
  }

  private async setTuneBeepMode(nextMode: CrossingBeepMode): Promise<void> {
    if (this.store.isHistoricalTrack) return;
    if (
      nextMode !== "off" &&
      nextMode !== "enter" &&
      nextMode !== "peak" &&
      nextMode !== "exit"
    ) {
      return;
    }
    const targetGateId = this.activeTuneGateId;
    if (targetGateId === null) {
      const curMode = resolveCrossingBeepMode(this.store.rules.beepMode, this.store.rules.beepOnCross);
      this.optimisticallySelectTuneBeepMode(nextMode);
      const previewGateId = this.store.nodes[0]?.gateId ?? 1;
      playPreviewCrossingBeep(this.store, previewGateId, nextMode);
      if (nextMode === curMode) return;
      await this.api
        .updateRules({
          ...this.store.rules,
          beepMode: nextMode,
          beepOnCross: nextMode !== "off",
        })
        .catch(() => undefined);
      return;
    }
    const gate = this.store.node(targetGateId);
    const globalMode = resolveCrossingBeepMode(this.store.rules.beepMode, this.store.rules.beepOnCross);
    const gateOvr = { ...(gate?.ruleOverrides ?? {}) };
    this.optimisticallySelectTuneBeepMode(nextMode);
    playPreviewCrossingBeep(this.store, targetGateId, nextMode);
    if (nextMode === globalMode) {
      delete gateOvr.beepMode;
      delete gateOvr.beepOnCross;
    } else {
      gateOvr.beepMode = nextMode;
      gateOvr.beepOnCross = nextMode !== "off";
    }
    await this.api.setGateRules(targetGateId, gateOvr).catch(() => undefined);
  }

  private optimisticallySelectTuneBeepMode(nextMode: CrossingBeepMode): void {
    this.tuneDrawerEl.querySelectorAll<HTMLButtonElement>("[data-tune-beep-mode]").forEach((btn) => {
      const active = btn.dataset.tuneBeepMode === nextMode;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-checked", String(active));
    });
  }

  private async restoreScopeTuneDefaults(): Promise<void> {
    if (this.store.isHistoricalTrack) return;
    const targetGateId = this.activeTuneGateId;
    if (targetGateId === null) {
      await this.api.updateRules(DEFAULT_TUNE_RULES).catch(() => undefined);
      return;
    }
    const slotIndex = this.activePilotSlot;
    if (this.tuningScope === "pilot") {
      await this.api.setPilotGateRules(targetGateId, slotIndex, {}).catch(() => undefined);
    } else {
      await this.api.setGateRules(targetGateId, {}).catch(() => undefined);
    }
  }

  private async resetTuneBeep(): Promise<void> {
    if (this.store.isHistoricalTrack) return;
    const targetGateId = this.activeTuneGateId;
    if (targetGateId === null) {
      this.optimisticallySelectTuneBeepMode("off");
      playPreviewCrossingBeep(this.store, 1, "off");
      await this.api
        .updateRules({ ...this.store.rules, beepMode: "off", beepOnCross: false })
        .catch(() => undefined);
      return;
    }
    const gate = this.store.node(targetGateId);
    const nextOverrides: GateRuleOverrides = {
      ...(gate?.ruleOverrides ?? {}),
    };
    delete nextOverrides.beepMode;
    delete nextOverrides.beepOnCross;
    const globalMode = resolveCrossingBeepMode(this.store.rules.beepMode, this.store.rules.beepOnCross);
    this.optimisticallySelectTuneBeepMode(globalMode);
    if (globalMode === "off") {
      playPreviewCrossingBeep(this.store, targetGateId, "off");
    }
    await this.api.setGateRules(targetGateId, nextOverrides).catch(() => undefined);
  }

  /** Ensures the fine-tune card is mounted as a sibling box right below `.rc-signals-card-box` when inside a Signals panel. */
  private syncTuneDrawerPlacement(): void {
    const cardBox = this.el.closest<HTMLElement>(".rc-signals-card-box");
    if (cardBox && cardBox.parentElement && this.tuneDrawerEl.parentElement !== cardBox.parentElement) {
      cardBox.insertAdjacentElement("afterend", this.tuneDrawerEl);
    }
  }

  private dismissMobileTuneDrawer(): void {
    if (!this.tuneDrawerOpen || this.tuneDrawerClosing) return;
    if (!this.isMobileLayout) {
      this.tuneDrawerOpen = false;
      this.tuningGateId = null;
      this.renderCalib();
      this.renderLegend();
      this.renderTuningDrawer();
      return;
    }
    this.tuneDrawerClosing = true;
    this.tuneDrawerEl.classList.add("is-closing");
    if (this.tuneDrawerCloseTimer !== null) {
      window.clearTimeout(this.tuneDrawerCloseTimer);
    }
    this.tuneDrawerCloseTimer = window.setTimeout(() => {
      this.tuneDrawerCloseTimer = null;
      if (!this.tuneDrawerClosing) return;
      this.tuneDrawerClosing = false;
      this.tuneDrawerEl.classList.remove("is-closing");
      this.tuneDrawerOpen = false;
      this.tuningGateId = null;
      this.renderCalib();
      this.renderLegend();
      this.renderTuningDrawer();
    }, 200);
  }

  /** Renders the fine-tuning box (always visible below Signal at each timer on desktop; bottom drawer on mobile). */
  private renderTuningDrawer(): void {
    this.syncTuneDrawerPlacement();
    const drawerEl = this.tuneDrawerEl;
    if (this.tuneDrawerClosing) {
      return;
    }
    if (this.isMultiPilotMode || this.store.isHistoricalTrack) {
      drawerEl.hidden = true;
      drawerEl.classList.add("is-mobile-closed");
      if (this.lastTuneDrawerHtml !== "") {
        this.lastTuneDrawerHtml = "";
        drawerEl.innerHTML = "";
      }
      return;
    }

    const activeEl = document.activeElement;
    if (activeEl instanceof HTMLInputElement && drawerEl.contains(activeEl)) {
      return;
    }

    const pilot = this.store.pilot(this.activePilotSlot);
    const targetGateId = this.activeTuneGateId;
    const gate = targetGateId !== null ? this.store.node(targetGateId) : undefined;
    if (!pilot || !gate) {
      drawerEl.hidden = true;
      drawerEl.classList.add("is-mobile-closed");
      return;
    }

    drawerEl.hidden = false;
    drawerEl.classList.toggle("is-mobile-closed", !this.tuneDrawerOpen);
    if (this.tuneDrawerOpen) {
      this.syncMobileDrawerTop(drawerEl);
    }

    const isGlobalScope = !gate;
    const gateName = gate ? gateLabel(this.store, gate.gateId) : "All timers";
    const color = gate ? this.colorOf(gate.gateId) : "";
    const gateOverrides = gate?.ruleOverrides ?? {};
    const pilotOverrides = gate ? pilotGateOverridesAt(gate, pilot.slotIndex) : {};
    const gateEffRules = gate ? gateRulesAt(this.store, gate.gateId) : this.store.rules;
    const gateOvrCount = countGateOverrides(gateOverrides, this.store.rules);
    const pilotOvrCount = countPilotOverrides(pilotOverrides, gateEffRules);
    const isPilotScope = !isGlobalScope && this.tuningScope === "pilot";
    const activeOverrides = isPilotScope ? pilotOverrides : gateOverrides;
    const effRules = gate
      ? isPilotScope
        ? pilotGateRulesAt(this.store, gate.gateId, pilot.slotIndex)
        : gateEffRules
      : this.store.rules;

    const globalBeepMode = resolveCrossingBeepMode(
      this.store.rules.beepMode,
      this.store.rules.beepOnCross
    );
    const gateOvrBeepMode = gateOverrideBeepMode(gateOverrides);
    const beepOverridden = isGlobalScope
      ? globalBeepMode !== "off"
      : gateOvrBeepMode !== undefined && gateOvrBeepMode !== globalBeepMode;
    const beepEffMode: CrossingBeepMode = resolveCrossingBeepMode(
      gateEffRules.beepMode,
      gateEffRules.beepOnCross
    );
    const beepHelpText = `Plays a single beep on gate enter, at the signal peak, or on gate exit ${isGlobalScope ? "for all timers" : "at this timer"}.`;

    const beepCardHtml = `
      <div class="scope-tune-card is-beep-card ${beepOverridden ? "is-overridden" : ""}" data-tune-card="beepOnCross">
        <div class="scope-tune-card-info">
          <div class="scope-tune-card-title-row">
            <span class="scope-tune-card-label">Beep on crossing</span>
            ${
              beepOverridden
                ? `<span class="scope-tune-custom-icon" title="Customized" aria-label="Customized">${icons.pencil(12)}</span>`
                : ""
            }
          </div>
          <div class="scope-tune-card-help">${beepHelpText}</div>
        </div>
        <div class="scope-tune-card-controls">
          ${renderTuneBeepModeSegHtml(beepEffMode)}
          ${
            beepOverridden
              ? `<button type="button" class="btn btn-sm btn-ghost scope-tune-reset-btn" data-tune-act="reset-beep" title="Restore default Beep on crossing" aria-label="Restore default Beep on crossing">${icons.reset(13)}</button>`
              : `<span class="scope-tune-reset-spacer" aria-hidden="true"></span>`
          }
        </div>
      </div>`;

    const cardsHtml = TUNE_RULES.map((spec) => {
      const isOverridden = isGlobalScope
        ? Math.abs(effRules[spec.key] - DEFAULT_TUNE_RULES[spec.key]) > 1e-6
        : activeOverrides[spec.key] !== undefined;
      const curVal = effRules[spec.key];
      const valStr = this.formatTuneVal(curVal, spec.decimals);
      return `
        <div class="scope-tune-card ${isOverridden ? "is-overridden" : ""}" data-tune-card="${spec.key}">
          <div class="scope-tune-card-info">
            <div class="scope-tune-card-title-row">
              <span class="scope-tune-card-label">${esc(spec.label)}</span>
              ${
                isOverridden
                  ? `<span class="scope-tune-custom-icon" title="Customized" aria-label="Customized">${icons.pencil(12)}</span>`
                  : ""
              }
            </div>
            <div class="scope-tune-card-help">${esc(spec.help)}</div>
          </div>
          <div class="scope-tune-card-controls">
            <div class="scope-tune-stepper">
              <button type="button" class="scope-tune-step-btn" data-tune-step="-1" data-tune-key="${spec.key}" title="Decrease ${esc(spec.label)}" aria-label="Decrease ${esc(spec.label)}">${icons.minus(12)}</button>
              <div class="scope-tune-input-wrap">
                <input
                  class="input mono scope-tune-input"
                  type="text"
                  inputmode="decimal"
                  enterkeyhint="done"
                  data-tune-input="${spec.key}"
                  value="${valStr}"
                  step="${spec.step}"
                  min="${spec.min}"
                  max="${spec.max}"
                  aria-label="${esc(spec.label)} in seconds"
                />
                <span class="scope-tune-unit">s</span>
              </div>
              <button type="button" class="scope-tune-step-btn" data-tune-step="1" data-tune-key="${spec.key}" title="Increase ${esc(spec.label)}" aria-label="Increase ${esc(spec.label)}">${icons.plus(12)}</button>
            </div>
            ${
              isOverridden
                ? `<button type="button" class="btn btn-sm btn-ghost scope-tune-reset-btn" data-tune-reset-key="${spec.key}" title="Restore default ${esc(spec.label)}" aria-label="Restore default ${esc(spec.label)}">${icons.reset(13)}</button>`
                : `<span class="scope-tune-reset-spacer" aria-hidden="true"></span>`
            }
          </div>
        </div>`;
    }).join("");

    const inheritedRules = gate
      ? isPilotScope
        ? gateRulesAt(this.store, gate.gateId)
        : this.store.rules
      : DEFAULT_TUNE_RULES;

    const desktopRowsHtml = TUNE_RULES.map((spec) => {
      const isOverridden = isGlobalScope
        ? Math.abs(effRules[spec.key] - DEFAULT_TUNE_RULES[spec.key]) > 1e-6
        : activeOverrides[spec.key] !== undefined;
      const curVal = effRules[spec.key];
      const valStr = this.formatTuneVal(curVal, spec.decimals);
      const inhStr = this.formatTuneVal(inheritedRules[spec.key], spec.decimals);
      if (isGlobalScope) {
        return `
          <div class="rule-row ${isOverridden ? "is-overridden" : ""}" data-tune-card="${spec.key}">
            <div class="rule-text">
              <div class="rule-label">${esc(spec.fullLabel)}</div>
              <div class="rule-help">${esc(spec.help)}</div>
            </div>
            <div class="flasher-pass-wrap rule-input ${isOverridden ? "has-inline-action" : ""}">
              <input
                class="input mono ${isOverridden ? "flasher-pass-input" : ""}"
                type="number"
                data-tune-input="${spec.key}"
                value="${valStr}"
                step="${spec.step}"
                min="${spec.min}"
                max="${spec.max}"
                aria-label="${esc(spec.fullLabel)}"
              />
              ${
                isOverridden
                  ? `<button class="flasher-pass-toggle rule-inline-btn is-active" type="button" data-tune-reset-key="${spec.key}" title="Restore default (${inhStr} s)" aria-label="Restore default (${inhStr} s)">${icons.reset(14)}</button>`
                  : ""
              }
            </div>
          </div>`;
      }
      const toggleTitle = isOverridden
        ? `Revert to inherited default (${inhStr} s)`
        : `Edit to override (inherits ${inhStr} s)`;
      return `
        <div class="rule-row ${isOverridden ? "is-overridden" : ""}" data-tune-card="${spec.key}">
          <div class="rule-text">
            <div class="rule-label">${esc(spec.fullLabel)}</div>
            <div class="rule-help">${esc(spec.help)}</div>
          </div>
          <div class="flasher-pass-wrap rule-input has-inline-action">
            <input
              class="input mono flasher-pass-input"
              type="number"
              data-tune-input="${spec.key}"
              value="${valStr}"
              step="${spec.step}"
              min="${spec.min}"
              max="${spec.max}"
              aria-label="${esc(spec.fullLabel)}"
              ${isOverridden ? "" : "disabled"}
            />
            <button
              class="flasher-pass-toggle rule-inline-btn ${isOverridden ? "is-active" : ""}"
              type="button"
              data-tune-override-toggle="${spec.key}"
              title="${toggleTitle}"
              aria-label="${toggleTitle}"
              aria-pressed="${isOverridden}"
            >
              ${isOverridden ? icons.reset(14) : icons.pencil(14)}
            </button>
          </div>
        </div>`;
    }).join("");

    const desktopBeepRowHtml = `
      <div class="rule-row ${beepOverridden ? "is-overridden" : ""}" data-tune-card="beepOnCross">
        <div class="rule-text">
          <div class="rule-label">Beep on crossing</div>
          <div class="rule-help">${beepHelpText}</div>
        </div>
        <div class="rule-input rule-switch-wrap">
          ${renderTuneBeepModeSegHtml(beepEffMode)}
          ${
            beepOverridden
              ? `<button type="button" class="btn btn-sm btn-ghost scope-tune-reset-btn" data-tune-act="reset-beep" title="Restore default Beep on crossing" aria-label="Restore default Beep on crossing">${icons.reset(13)}</button>`
              : `<span class="scope-tune-reset-spacer" aria-hidden="true"></span>`
          }
        </div>
      </div>`;

    const desktopFootNote = isGlobalScope
      ? "Applies to new detections on this track."
      : isPilotScope
        ? `Edited rules apply only to ${esc(pilot.callsign)} at ${esc(gateName)}.`
        : `Edited rules apply only to ${esc(gateName)}.`;

    const headDotHtml = isGlobalScope
      ? `<span class="dot channel-all-dot"></span>`
      : `<span class="dot" style="--c:${color}"></span>`;

    const headActionsHtml = isGlobalScope
      ? `<span class="note rc-hide-mobile">Select a timer above to customize per-timer or per-pilot rules</span>`
      : `
          <div class="scope-tune-seg" role="group" aria-label="Apply settings to">
            <button
              type="button"
              class="scope-tune-seg-btn ${isPilotScope ? "is-active" : ""}"
              data-tune-scope="pilot"
              aria-pressed="${isPilotScope}"
              title="Customize detection rules only for ${esc(pilot.callsign)} at ${esc(gateName)}"
            >
              <span>Only ${esc(pilot.callsign)}</span>
              ${pilotOvrCount > 0 ? `<span class="scope-tune-badge">${pilotOvrCount}</span>` : ""}
            </button>
            <button
              type="button"
              class="scope-tune-seg-btn ${!isPilotScope ? "is-active" : ""}"
              data-tune-scope="gate"
              aria-pressed="${!isPilotScope}"
              title="Customize detection rules for all pilots at ${esc(gateName)}"
            >
              <span>All pilots</span>
              ${gateOvrCount > 0 ? `<span class="scope-tune-badge">${gateOvrCount}</span>` : ""}
            </button>
          </div>`;

    const bodyContentHtml = this.isMobileLayout
      ? `<div class="scope-tune-grid">
          ${cardsHtml}
          ${beepCardHtml}
        </div>`
      : `<div class="rules scope-tune-desktop-rules">
          ${desktopRowsHtml}
          ${desktopBeepRowHtml}
          <div class="rules-foot">
            <p class="note">${desktopFootNote}</p>
            <button class="btn btn-ghost btn-sm" type="button" data-tune-act="restore-defaults">Restore defaults</button>
          </div>
        </div>`;

    const nextHtml = `
      <div class="dir-mobile-drawer-top-bar scope-tune-mobile-handle-bar">
        <button
          type="button"
          class="pilot-dir-mobile-drawer-handle"
          data-tune-act="close"
          title="Close fine-tuning drawer"
          aria-label="Close fine-tuning drawer"
        >
          <span class="pilot-dir-mobile-drawer-grip" aria-hidden="true"></span>
        </button>
      </div>
      <div class="scope-tune-head">
        <div class="scope-tune-title-group">
          ${headDotHtml}
          <strong>${esc(gateName)} · Fine-tune</strong>
        </div>
        <div class="scope-tune-head-actions">
          ${headActionsHtml}
        </div>
      </div>
      ${bodyContentHtml}`;

    if (nextHtml !== this.lastTuneDrawerHtml) {
      this.lastTuneDrawerHtml = nextHtml;
      drawerEl.innerHTML = nextHtml;
    }
  }

  /** Anchors the mobile bottom drawer right below the graph box so the graph stays visible. */
  private syncMobileDrawerTop(drawerEl: HTMLElement): void {
    const graphBox =
      this.el.querySelector<HTMLElement>(".scope-graph-box") ??
      this.el.querySelector<HTMLElement>(".scope-bottom-bar") ??
      this.slot("chart");
    const rect = graphBox.getBoundingClientRect();
    if (rect.bottom > 80) {
      drawerEl.style.setProperty("--scope-graph-bottom", `${Math.ceil(rect.bottom + 8)}px`);
    } else {
      drawerEl.style.removeProperty("--scope-graph-bottom");
    }
  }
}
