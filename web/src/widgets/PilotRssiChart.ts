import { CanvasSurface } from "../core/canvas";
import { computeDirectionalPinch, computeWheelZoomFactors, PinchPoint, scrollOuterPageBy } from "../core/chart_pinch";
import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { adaptColorForTheme, font, inkOnColor, theme, withAlpha } from "../core/theme";
import { ApiClient } from "../services/api_client";
import { suggestThreshold } from "../state/calibration";
import { enterThresholdAt, exitThresholdAt, gateColor, gateLabel } from "../state/selectors";
import { AppStore, HISTORY_SECONDS } from "../state/store";
import { GateThresholdUpdate, isRotorHazardMode, TimerTelemetryFrame, TimingHardwareMode } from "../types/models";
import { FILTER_LABELS } from "./markup";

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
const WINDOWS_SEC = [1, 2, 5, 10, 15, 30, 60, 120] as const;
const DEFAULT_WINDOW_US = 15_000_000;
const MIN_WINDOW_US = 400_000;
const MAX_WINDOW_US = 120_000_000;
const LEGEND_REFRESH_MS = 150;
/** How close (px) the cursor must be to a pass marker to show its details. */
const MARKER_HIT_PX = 7;
/** Threshold tags: height, and how close (px) to a threshold line counts as grabbing it. */
const TAG_H = 18;
const TAG_GAP = 4;
const LINE_HIT_PX = 5;
/** Room on the right for the threshold tags. */
const TAG_GUTTER = 84;
const RSSI_CHART_STORAGE_KEY = "slaprf.ui.rssi_chart.v1";

const PAD = { l: 46, r: 16 + TAG_GUTTER, t: 12, b: 26 };

/** A pass the pilot made through a gate: timed, or set aside by the timing rules. */
interface PassMarker {
  ts: number;
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
  /** Values shown while a save is in flight, so the line doesn't jump back. */
  private readonly pending = new Map<number, { enter: number; exit: number }>();
  private tags: TagBox[] = [];
  /** Previous thresholds, to undo the last calibration change. */
  private undo: GateThresholdUpdate[] | null = null;
  private calibMessage = "";
  /** Gate shown on its own (with its editable threshold); null shows every gate. */
  private focus: number | null = null;
  /** Optional explicit pilot slot override (e.g. when embedded in Race Control). */
  private pilotSlotOverride: number | null = null;
  /** Optional multi-pilot overlay mode ("All" seated pilots in Race Control). */
  private multiPilotSlots: number[] | null = null;
  /** Plot geometry from the last frame, for mapping pointer positions to time and dBm. */
  private plot = { x: PAD.l, w: 1, h: 1 };
  private lastHardwareMode: TimingHardwareMode = "slaprf";
  private autoYHoldUntilMs = 0;
  private lastLegendStructSig = "";

  private get hwMode(): TimingHardwareMode {
    return this.store.timingHardwareMode;
  }
  private get isLapRF(): boolean {
    return this.hwMode === "laprf";
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

  private get activePilotSlot(): number {
    if (this.multiPilotSlots && this.multiPilotSlots.length > 0) {
      return this.multiPilotSlots[0];
    }
    return this.pilotSlotOverride !== null ? this.pilotSlotOverride : this.store.selectedPilot;
  }

  public setPilotSlotOverride(slotIndex: number | null): void {
    if (this.pilotSlotOverride === slotIndex && !this.isMultiPilotMode) return;
    this.pilotSlotOverride = slotIndex;
    if (slotIndex !== null) {
      this.multiPilotSlots = null;
    }
    this.tags = [];
    this.undo = null;
    this.calibMessage = "";
    this.smoothYMin = null;
    this.smoothYMax = null;
    this.renderControls();
    this.renderCalib();
    this.renderLegend();
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
    if (same) return;
    this.multiPilotSlots = next;
    if (next !== null) {
      this.pilotSlotOverride = null;
    }
    this.tags = [];
    this.undo = null;
    this.calibMessage = "";
    this.smoothYMin = null;
    this.smoothYMax = null;
    this.renderControls();
    this.renderCalib();
    this.renderLegend();
  }

  private get isMobileLayout(): boolean {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 860px)").matches
    );
  }

  private get padL(): number {
    return this.isMobileLayout ? 26 : PAD.l;
  }

  /** Right padding: threshold tags now sit inside the right edge of the plot. */
  private get padR(): number {
    return this.isMobileLayout ? 4 : 16;
  }

  /** The gates drawn on the chart: the focused one, or all of them. */
  private get shownGates() {
    return this.focus === null ? this.store.nodes : this.store.nodes.filter((p) => p.gateId === this.focus);
  }

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;
    this.loadChartPrefs();
    el.classList.add("scope-root");
    el.innerHTML = `
      <div class="scope-toolbar">
        <div class="scope-transport" role="group" aria-label="Signal playback and pass navigation">
          <button class="btn btn-sm btn-ghost scope-step-btn" type="button" data-act="prev" title="Previous pass (←)">
            ${icons.chevronLeft(16)}<span class="scope-step-text-full">Prev pass</span><span class="scope-step-text-short">Prev</span>
          </button>
          <button class="btn btn-sm scope-live-btn" type="button" data-act="live"></button>
          <button class="btn btn-sm btn-ghost scope-step-btn" type="button" data-act="next" title="Next pass (→)">
            <span class="scope-step-text-full">Next pass</span><span class="scope-step-text-short">Next</span>${icons.chevronRight(16)}
          </button>
        </div>
      </div>
      <div class="canvas-host canvas-host-md scope-canvas" data-slot="chart" tabindex="0"
           aria-label="Signal chart. Space pauses, arrow keys jump between passes."></div>
      <div class="scope-bottom-bar">
        <div class="scope-axis-controls" data-slot="axis-controls" role="group" aria-label="X and Y axis scale controls"></div>
        <span class="scope-hint" data-slot="hint"></span>
      </div>
      <div class="channel-legend" data-slot="legend"></div>
      <div class="scope-calib" data-slot="calib"></div>`;

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

    this.listen(el, "click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>(
        "[data-act], [data-window], [data-axis-act], [data-calib], [data-focus]"
      );
      if (!btn) return;
      if (btn.dataset.focus) {
        this.focus = btn.dataset.focus === "all" ? null : Number(btn.dataset.focus);
        this.calibMessage = "";
        this.saveChartPrefs();
        this.renderControls();
        this.renderCalib();
        this.renderLegend();
      } else if (btn.dataset.axisAct === "toggle-menu") {
        const menu = btn.dataset.menu as "rssi-x" | "rssi-y";
        this.openAxisMenu = this.openAxisMenu === menu ? null : menu;
        this.renderControls();
      } else if (btn.dataset.axisAct === "auto-x") {
        this.autoX = true;
        this.windowUs = DEFAULT_WINDOW_US;
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
      else if (btn.dataset.calib === "undo") void this.undoLast();
      else if (btn.dataset.act === "live") this.toggleLive();
      else if (btn.dataset.act) this.jump(btn.dataset.act === "prev" ? -1 : 1);
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

    this.listen(host, "dblclick", () => {
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
      const yFrac = Math.max(0, Math.min(1, 1 - (y - PAD.t) / Math.max(10, this.plot.h)));

      if (wf.mode === "x" || wf.mode === "xy") {
        const prevWin = this.windowUs;
        const prevEnd = this.viewEnd();
        const nextWin = Math.max(MIN_WINDOW_US, Math.min(MAX_WINDOW_US, prevWin * wf.xSpanFactor));
        this.autoX = false;
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
          this.drag = null;
          this.yZoomBox = null;
          this.hoverX = null;
          this.hoverY = null;
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
            anchorYFrac: Math.max(0, Math.min(1, 1 - (midY - PAD.t) / Math.max(10, this.plot.h))),
          };
          host.classList.add("is-dragging");
          return;
        }
      }

      this.hoverX = x;
      this.hoverY = y;

      const grabbed = this.tagAt(x, y);
      if (grabbed !== null) {
        const curDbm =
          grabbed.kind === "enter"
            ? this.thresholdOf(grabbed.gateId).dbm
            : this.exitThresholdOf(grabbed.gateId).dbm;
        this.tagDrag = { gateId: grabbed.gateId, kind: grabbed.kind, dbm: curDbm };
        return;
      }

      const isTouch = e.pointerType === "touch";
      const yAxisW = isTouch ? (this.isMobileLayout ? 36 : 54) : this.padL;
      const xAxisH = isTouch ? 34 : PAD.b;

      if (x < yAxisW) {
        // Dragging on left Y-axis stretches/shrinks the dBm scale smoothly
        const yFrac = Math.max(0, Math.min(1, 1 - (y - PAD.t) / Math.max(10, this.plot.h)));
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
              this.autoX = false;
              const nextWin = Math.max(
                MIN_WINDOW_US,
                Math.min(MAX_WINDOW_US, pinchState.startWindowUs * pinch.xSpanFactor)
              );
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
        const overTag = this.tagAt(x, y) !== null;
        const overYAxis = !overTag && x < this.padL && y >= PAD.t && y <= r.height - PAD.b;
        const overXAxis =
          !overTag && !overYAxis && y >= r.height - PAD.b && x >= this.padL && x <= this.padL + this.plot.w;
        host.classList.toggle("is-over-tag", overTag);
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
        this.autoX = false;
        const factor = Math.exp(-dx / 150);
        const nextUs = Math.max(MIN_WINDOW_US, Math.min(MAX_WINDOW_US, this.drag.startWindowUs * factor));
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
            this.yZoomBox = null;
            host.classList.remove("is-dragging", "is-over-axis", "is-over-yaxis");
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

      if (this.tagDrag) {
        const { gateId, kind, dbm } = this.tagDrag;
        this.tagDrag = null;
        const prev = kind === "enter" ? this.thresholdOf(gateId).dbm : this.exitThresholdOf(gateId).dbm;
        if (dbm !== prev) void this.saveManual(gateId, kind, dbm);
      }
      if (this.drag) {
        if (this.drag.mode === "ybox" && this.yZoomBox) {
          const ya = Math.max(PAD.t, Math.min(PAD.t + this.plot.h, Math.min(this.yZoomBox.y0, this.yZoomBox.y1)));
          const yb = Math.max(PAD.t, Math.min(PAD.t + this.plot.h, Math.max(this.yZoomBox.y0, this.yZoomBox.y1)));
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
      host.classList.remove("is-dragging", "is-over-axis", "is-over-yaxis");
    };
    this.listen(host, "pointerup", endDrag);
    this.listen(host, "pointercancel", endDrag);
    this.listen(host, "pointerleave", () => {
      this.hoverX = null;
      this.hoverY = null;
      if (!this.drag) {
        host.classList.remove("is-over-tag", "is-over-axis", "is-over-yaxis");
      }
    });

    const timer = window.setInterval(() => {
      if (document.hidden || this.el.offsetParent === null) return;
      // Don't rebuild the chips under the pointer — that can swallow a click.
      if (!this.slot("legend").matches(":hover")) this.renderLegend();
    }, LEGEND_REFRESH_MS);
    this.onDispose(() => window.clearInterval(timer));
    this.onDispose(
      store.subscribe(["selection"], () => {
        // Undo belongs to the pilot it was made for.
        this.undo = null;
        this.calibMessage = "";
        this.smoothYMin = null;
        this.smoothYMax = null;
        this.renderControls();
        this.renderCalib();
      })
    );
    this.onDispose(
      store.subscribe(["config", "status"], () => {
        this.syncHardwareModeScale();
        if (this.focus !== null && !store.node(this.focus)) this.focus = null;
        this.renderControls();
        this.renderCalib();
      })
    );
    this.syncHardwareModeScale();
    this.renderControls();
    this.renderCalib();
    this.renderLegend();
  }

  // ---- view window & Y scale -------------------------------------------------

  private get latest(): number {
    return this.store.latestTimestampUs;
  }

  private get livePlayhead(): number {
    return this.store.smoothLatestTimestampUs;
  }

  private get earliest(): number {
    const firsts = this.store.nodes.map((p) => this.store.historyFor(p.gateId)[0]?.timestampUs ?? Infinity);
    const e = Math.min(...firsts);
    return Number.isFinite(e) ? e : this.latest;
  }

  private viewEnd(): number {
    if (this.endUs !== null) return this.endUs;
    if (this.drag && "startEndUs" in this.drag) return this.drag.startEndUs;
    return this.livePlayhead;
  }

  private clampEnd(end: number): number {
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
    return PAD.t + this.plot.h * (1 - (dbm - this.yMin) / span);
  }

  private dbmAt(y: number): number {
    const span = Math.max(4, this.yMax - this.yMin);
    const v = this.yMin + (1 - (y - PAD.t) / this.plot.h) * span;
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
        : Math.min(absHi, Math.ceil((maxD + 6) / 2) * 2);
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
    this.endUs = null;
    this.autoX = true;
    this.windowUs = DEFAULT_WINDOW_US;
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
      if (parsed.focus === null || (typeof parsed.focus === "number" && parsed.focus >= 1)) {
        this.focus = parsed.focus;
      }
    } catch {
      // Ignore storage access errors
    }
  }

  private saveChartPrefs(): void {
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
        })
      );
    } catch {
      // Ignore storage access errors
    }
  }

  public restoreDefaults(): void {
    this.windowUs = DEFAULT_WINDOW_US;
    this.autoX = true;
    this.autoY = true;
    this.yMin = this.defYMin;
    this.yMax = this.defYMax;
    this.smoothYMin = null;
    this.smoothYMax = null;
    this.focus = null;
    this.endUs = null;
    this.calibMessage = "";
    this.saveChartPrefs();
    this.renderControls();
    this.renderCalib();
    this.renderLegend();
  }

  private setWindow(us: number, isAuto = false): void {
    const center = this.viewEnd() - this.windowUs / 2;
    this.windowUs = us;
    this.autoX = isAuto;
    if (this.endUs !== null) this.endUs = this.clampEnd(center + us / 2);
    this.saveChartPrefs();
    this.renderControls();
  }

  private zoom(factor: number, x: number): void {
    const anchor = this.timeAt(x);
    const frac = Math.min(1, Math.max(0, (x - this.plot.x) / this.plot.w));
    const next = Math.min(MAX_WINDOW_US, Math.max(MIN_WINDOW_US, this.windowUs * factor));
    this.windowUs = next;
    this.autoX = false;
    // Following live keeps the right edge at "now"; otherwise zoom around the cursor.
    if (this.endUs !== null) this.endUs = this.clampEnd(anchor + (1 - frac) * next);
    this.saveChartPrefs();
    this.renderControls();
  }

  private toggleLive(): void {
    if (this.endUs === null) this.pauseAt(this.latest);
    else this.endUs = null;
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

  /** Gate & kind whose threshold tag (or line) is under the pointer, if any. Tags win over lines. */
  private tagAt(x: number, y: number): { gateId: number; kind: "enter" | "exit" } | null {
    if (this.store.isHistoricalTrack || this.isMultiPilotMode) return null;
    for (const t of this.tags) {
      if (x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + TAG_H) {
        return { gateId: t.gateId, kind: t.kind };
      }
    }
    if (x < this.padL || x > this.padL + this.plot.w) return null;
    let best: TagBox | null = null;
    for (const t of this.tags) {
      if (Math.abs(y - t.lineY) <= LINE_HIT_PX && (!best || Math.abs(y - t.lineY) < Math.abs(y - best.lineY))) best = t;
    }
    return best ? { gateId: best.gateId, kind: best.kind } : null;
  }

  /** Raw stored overrides for this pilot (0 = pilot default), for undo. */
  private currentOverrides(): GateThresholdUpdate[] {
    const slotIndex = this.activePilotSlot;
    const pos = this.store.pilots.findIndex((p) => p.slotIndex === slotIndex);
    if (this.isLapRF) {
      return this.store.nodes.map((p) => ({
        gateId: p.gateId,
        slotIndex,
        enterDbm: 0,
        laprfThreshold: p.laprfThresholds?.[pos] ?? 0,
      }));
    }
    if (this.isRH) {
      return this.store.nodes.map((p) => ({
        gateId: p.gateId,
        slotIndex,
        enterDbm: 0,
        rhEnterThreshold: p.rhEnterThresholds?.[pos] ?? 0,
        rhExitThreshold: p.rhExitThresholds?.[pos] ?? 0,
      }));
    }
    return this.store.nodes.map((p) => ({
      gateId: p.gateId,
      slotIndex,
      enterDbm: p.enterThresholds?.[pos] ?? 0,
      exitDbm: p.exitThresholds?.[pos] ?? 0,
    }));
  }

  private async apply(updates: GateThresholdUpdate[], message: string): Promise<void> {
    const before = this.currentOverrides().filter((o) => updates.some((u) => u.gateId === o.gateId));
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
      this.undo = before;
      this.calibMessage = message;
    } catch {
      this.calibMessage = "Could not save thresholds.";
    } finally {
      updates.forEach((u) => this.pending.delete(u.gateId));
      this.renderCalib();
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

  /**
   * Works out each gate's threshold from the recent signal (see suggestThreshold): noise
   * floor between passes vs. the peaks of the passes themselves.
   */
  private async autoCalibrate(): Promise<void> {
    const pilot = this.store.pilot(this.activePilotSlot);
    if (!pilot) return;
    const pos = this.store.pilots.indexOf(pilot);
    const updates: GateThresholdUpdate[] = [];
    const done: string[] = [];
    const skipped: string[] = [];
    const isRH = isRotorHazardMode(this.store.timingHardwareMode);
    for (const gate of this.shownGates) {
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
      this.calibMessage = `Cannot calibrate yet (${skipped[0] ?? "no signal"}). Let ${pilot.callsign} fly a few laps with this page open, then try again.`;
      this.renderCalib();
      return;
    }
    const minutes = Math.round(HISTORY_SECONDS / 60);
    const unit = isRH ? "RSSI" : "dBm";
    await this.apply(
      updates,
      `Calibrated from the last ${minutes} min: ${done.join(" · ")} ${unit}.${skipped.length ? ` Skipped ${skipped.join(", ")}.` : ""}`
    );
  }

  private resetToDefault(): Promise<void> {
    const slotIndex = this.activePilotSlot;
    const who = this.store.pilot(slotIndex)?.callsign ?? "the pilot";
    if (this.isLapRF) {
      const message =
        this.focus === null
          ? `Every timer is back on ${who}'s own threshold (${this.pilotDefault()}).`
          : `${gateLabel(this.store, this.focus)} is back on ${who}'s own threshold (${this.pilotDefault()}).`;
      return this.apply(
        this.shownGates.map((p) => ({ gateId: p.gateId, slotIndex, enterDbm: 0, laprfThreshold: -1 })),
        message
      );
    }
    if (this.isRH) {
      const message =
        this.focus === null
          ? `Every timer is back on ${who}'s own thresholds (${this.pilotDefault()}/${this.pilotExitDefault()}).`
          : `${gateLabel(this.store, this.focus)} is back on ${who}'s own thresholds (${this.pilotDefault()}/${this.pilotExitDefault()}).`;
      return this.apply(
        this.shownGates.map((p) => ({
          gateId: p.gateId,
          slotIndex,
          enterDbm: 0,
          rhEnterThreshold: -1,
          rhExitThreshold: -1,
        })),
        message
      );
    }
    const message =
      this.focus === null
        ? `Every timer is back on ${who}'s own thresholds (${this.pilotDefault()}/${this.pilotExitDefault()} dBm).`
        : `${gateLabel(this.store, this.focus)} is back on ${who}'s own thresholds (${this.pilotDefault()}/${this.pilotExitDefault()} dBm).`;
    return this.apply(
      this.shownGates.map((p) => ({ gateId: p.gateId, slotIndex, enterDbm: 0, exitDbm: 0 })),
      message
    );
  }

  private async undoLast(): Promise<void> {
    const previous = this.undo;
    if (!previous) return;
    this.undo = null;
    await this.api.setGateThresholds(previous).catch(() => undefined);
    this.undo = null;
    this.calibMessage = "Undone.";
    this.renderCalib();
  }

  // ---- data ------------------------------------------------------------------

  private colorOf(gateId: number): string {
    return gateColor(this.store, gateId);
  }

  /** Selected pilot's (or all seated pilots') passes in [from, to], oldest first. */
  private passes(from: number, to: number): PassMarker[] {
    if (this.isMultiPilotMode && this.multiPilotSlots) {
      const slotSet = new Set(this.multiPilotSlots);
      const timed: PassMarker[] = this.store.crossings
        .filter((c) => slotSet.has(c.slotIndex) && c.timestampUs >= from && c.timestampUs <= to)
        .map((c) => {
          const p = this.store.pilot(c.slotIndex);
          return {
            ts: c.timestampUs,
            gateId: c.gateId,
            counted: true,
            title: `${p?.callsign ?? c.callsign ?? `P${c.slotIndex}`} · ${gateLabel(this.store, c.gateId)}`,
            detail: `Timed · peak ${c.peakRssiDbm.toFixed(0)}${this.unitSuffix}`,
            color: p?.color,
            slotIndex: c.slotIndex,
          };
        });
      const rejected: PassMarker[] = this.store.filtered
        .filter((f) => slotSet.has(f.slotIndex) && f.timestampUs >= from && f.timestampUs <= to)
        .map((f) => {
          const p = this.store.pilot(f.slotIndex);
          return {
            ts: f.timestampUs,
            gateId: f.gateId,
            counted: false,
            title: `${p?.callsign ?? `P${f.slotIndex}`} · ${gateLabel(this.store, f.gateId)} (${FILTER_LABELS[f.reason]})`,
            detail: f.detail,
            color: p?.color,
            slotIndex: f.slotIndex,
          };
        });
      return [...timed, ...rejected].sort((a, b) => a.ts - b.ts);
    }
    const slot = this.activePilotSlot;
    const timed: PassMarker[] = this.store.crossings
      .filter((c) => c.slotIndex === slot && c.timestampUs >= from && c.timestampUs <= to)
      .map((c) => ({
        ts: c.timestampUs,
        gateId: c.gateId,
        counted: true,
        title: `${gateLabel(this.store, c.gateId)} · ${c.estimatedSpeedMph.toFixed(0)} mph`,
        detail: `Timed · peak ${c.peakRssiDbm.toFixed(0)}${this.unitSuffix}`,
        slotIndex: c.slotIndex,
      }));
    const rejected: PassMarker[] = this.store.filtered
      .filter((f) => f.slotIndex === slot && f.timestampUs >= from && f.timestampUs <= to)
      .map((f) => ({
        ts: f.timestampUs,
        gateId: f.gateId,
        counted: false,
        title: `${gateLabel(this.store, f.gateId)} · not counted (${FILTER_LABELS[f.reason]})`,
        detail: f.detail,
        slotIndex: f.slotIndex,
      }));
    return [...timed, ...rejected].sort((a, b) => a.ts - b.ts);
  }

  /** Passes filtered to the currently focused gate (or all gates when focus is null). */
  private focusedPasses(from: number, to: number): PassMarker[] {
    const all = this.passes(from, to);
    return this.focus === null ? all : all.filter((p) => p.gateId === this.focus);
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
    const plotW = w - padL - this.padR;
    const plotH = h - PAD.t - PAD.b;
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

    const xOf = (ts: number) => padL + plotW * ((ts - start) / this.windowUs);
    const yOf = (dbm: number) => this.yOf(dbm);

    this.drawGrid(ctx, w, h, start, end, ref, xOf, yOf);

    if (this.latest > 0) {
      // Traces, decimated to roughly one point per pixel when zoomed out.
      ctx.save();
      ctx.beginPath();
      ctx.rect(padL, PAD.t - 4, plotW, plotH + 8);
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
        const step = Math.max(1, Math.floor((to - from) / plotW));
        for (const entry of pilotEntries) {
          ctx.strokeStyle = this.isMultiPilotMode
            ? adaptColorForTheme(entry.pilot.color || this.colorOf(gate.gateId))
            : this.colorOf(gate.gateId);
          ctx.setLineDash([]);
          ctx.beginPath();
          let lastY = PAD.t;
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
            // Anchor decimation buckets to immutable `seqNum` (rather than mutable array index `i`,
            // which shifts on `trimHistory`) and preserve each bucket's peak RSSI so gate crossings
            // never shimmer or alias while scrolling zoomed-out windows.
            let started = false;
            let curBucket = -1;
            let peakVal = -Infinity;
            let peakTs = 0;
            for (let i = from; i <= to; i++) {
              const fr = frames[i];
              const b = Math.floor((fr.seqNum || i) / step);
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
      const ya = Math.max(PAD.t, Math.min(PAD.t + plotH, Math.min(this.yZoomBox.y0, this.yZoomBox.y1)));
      const yb = Math.max(PAD.t, Math.min(PAD.t + plotH, Math.max(this.yZoomBox.y0, this.yZoomBox.y1)));
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
    if (this.latest === 0) return;

    // Pass markers: dashed in the gate's (or pilot's) colour when timed, red when set aside.
    ctx.font = font(600, 10.5);
    const rows = this.labelRows(ctx, xOf, end);
    const passes = this.focusedPasses(start, end);
    let hovered: PassMarker | null = null;
    passes.forEach((p) => {
      const x = xOf(p.ts);
      const color = p.counted ? adaptColorForTheme(p.color || this.colorOf(p.gateId)) : theme.bad;
      ctx.save();
      ctx.strokeStyle = withAlpha(color, p.counted ? 0.7 : 0.9);
      ctx.lineWidth = p.counted ? 1 : 1.5;
      ctx.setLineDash(p.counted ? [2, 3] : [5, 3]);
      ctx.beginPath();
      ctx.moveTo(x, PAD.t);
      ctx.lineTo(x, PAD.t + plotH);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = color;
      ctx.font = font(600, 10.5);
      ctx.fillText(this.labelOf(p), x + 5, PAD.t + 11 + (rows.get(PilotRssiChart.keyOf(p)) ?? 0) * 12);
      if (this.hoverX !== null && Math.abs(this.hoverX - x) <= MARKER_HIT_PX) hovered = p;
    });

    if (!this.tagDrag && !this.yZoomBox && this.hoverX !== null && this.hoverX >= padL && this.hoverX <= padL + plotW) {
      this.drawCursor(ctx, h, plotH, this.hoverX, hovered);
    }
  }

  /**
   * Dual Enter and Exit threshold lines per focused gate, with draggable tags at the right
   * edge. Tags that would overlap are moved into extra columns to the left. Outlined tags
   * use the pilot's own threshold; filled tags are calibrated for that gate.
   */
  private drawThresholds(ctx: CanvasRenderingContext2D, w: number, plotW: number, plotH: number): void {
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
      const enY = Math.max(PAD.t, Math.min(PAD.t + plotH, this.yOf(en.dbm)));
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
        const exY = Math.max(PAD.t, Math.min(PAD.t + plotH, this.yOf(ex.dbm)));
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
    return p.counted ? p.title : `✕ ${p.title}`;
  }

  /**
   * Puts each pass label on the top row unless it would run into the previous label there,
   * in which case it drops to the second row. Laid out over the whole history (oldest
   * first), not just the visible window, so a label keeps its row while it scrolls past —
   * otherwise labels jump between rows whenever an older pass leaves the view.
   */
  private labelRows(ctx: CanvasRenderingContext2D, xOf: (ts: number) => number, end: number): Map<string, number> {
    const rows = new Map<string, number>();
    const rowEnd = [-Infinity, -Infinity];
    for (const p of this.focusedPasses(this.earliest, end)) {
      const x = xOf(p.ts) + 5;
      const width = ctx.measureText(this.labelOf(p)).width;
      const row = x > rowEnd[0] + 6 ? 0 : x > rowEnd[1] + 6 ? 1 : 0;
      rowEnd[row] = x + width;
      rows.set(PilotRssiChart.keyOf(p), row);
    }
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
    for (let level = Math.ceil(this.yMin / dStep) * dStep; level <= this.yMax; level += dStep) {
      const y = Math.round(yOf(level)) + 0.5;
      if (y < PAD.t - 1 || y > h - PAD.b + 1) continue;
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
                      : 20;
    const stepUs = stepSec * 1e6;
    ctx.textAlign = "center";
    ctx.fillStyle = theme.text3;
    for (let t = ref - Math.floor((ref - start) / stepUs) * stepUs; t <= end + 1; t += stepUs) {
      const x = xOf(t);
      if (x < padL - 4 || x > w - this.padR + 4) continue;
      const agoSec = Math.max(0, (ref - t) / 1e6);
      const lbl =
        agoSec < 0.02
          ? this.endUs === null
            ? "now"
            : "paused"
          : stepSec < 0.5
            ? `−${agoSec.toFixed(2)}s`
            : stepSec < 1
              ? `−${agoSec.toFixed(1)}s`
              : `−${Math.round(agoSec)}s`;
      ctx.fillText(lbl, x, h - 8);
    }
    ctx.textAlign = "left";
  }

  /** Crosshair with the time under the cursor, plus details of a pass marker being hovered. */
  private drawCursor(ctx: CanvasRenderingContext2D, h: number, plotH: number, x: number, hovered: PassMarker | null): void {
    ctx.save();
    ctx.strokeStyle = withAlpha(theme.text, 0.25);
    ctx.beginPath();
    ctx.moveTo(x + 0.5, PAD.t);
    ctx.lineTo(x + 0.5, PAD.t + plotH);
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
    const by = PAD.t + 8;
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
    btn.className = `btn btn-sm scope-live-btn ${live ? "btn-armed" : "btn-ghost"}`;
    btn.title = live ? "Following live signal stream · click to pause (Space)" : "Stream paused · click to resume live stream (Space)";
    btn.setAttribute("aria-label", btn.title);
    btn.setAttribute("aria-pressed", String(live));
    btn.innerHTML = `<span class="status-dot ${live ? "is-up" : ""}"></span><span>Live</span>`;

    const gateScope = this.focus === null ? "all timers" : gateLabel(this.store, this.focus);
    const prevBtn = this.el.querySelector<HTMLButtonElement>('[data-act="prev"]');
    const nextBtn = this.el.querySelector<HTMLButtonElement>('[data-act="next"]');
    if (prevBtn) prevBtn.title = `Previous pass at ${gateScope} (←)`;
    if (nextBtn) nextBtn.title = `Next pass at ${gateScope} (→)`;

    const winSec = this.windowUs / 1e6;
    const xWinLabel =
      Math.round(winSec) === 120
        ? "2 min"
        : winSec < 10 && Math.abs(winSec - Math.round(winSec)) >= 0.05
          ? `${winSec.toFixed(1)} s`
          : `${Math.round(winSec)} s`;
    const xWinShort =
      Math.round(winSec) === 120
        ? "2m"
        : winSec < 10 && Math.abs(winSec - Math.round(winSec)) >= 0.05
          ? `${winSec.toFixed(1)}s`
          : `${Math.round(winSec)}s`;

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

    this.slot("axis-controls").innerHTML = `
      <div class="debug-axis-pill ${this.autoX ? "is-armed" : "is-unarmed"}" data-axis-pill>
        <button type="button" class="debug-axis-pill-main" data-axis-act="${this.autoX ? "toggle-menu" : "auto-x"}" data-menu="rssi-x" title="${this.autoX ? `Auto X-axis time window (${xWinLabel}) · click to choose a time window preset, or drag X-axis to stretch` : "Click to reset X-axis time window to Auto X (15 s)"}">
          ${icons.target(13)}<span>${this.autoX ? "Auto X" : `<span class="debug-hint-desktop">X: ${xWinLabel}</span><span class="debug-hint-mobile">X: ${xWinShort}</span>`}</span>
        </button>
        <button type="button" class="debug-axis-pill-arrow" data-axis-act="toggle-menu" data-menu="rssi-x" aria-expanded="${this.openAxisMenu === "rssi-x"}" title="Choose X-axis time window">
          ${icons.chevronDown(12)}
        </button>
        ${
          this.openAxisMenu === "rssi-x"
            ? `<div class="debug-axis-menu" role="menu" aria-label="X-axis time window">
                <button type="button" class="debug-axis-menu-item ${this.autoX ? "is-active" : ""}" data-axis-act="auto-x" role="menuitem">
                  <span>Auto X</span><span class="note">15 s</span>
                </button>
                <div class="debug-axis-menu-sep"></div>
                ${WINDOWS_SEC.map((w) => {
                  const active = !this.autoX && Math.abs(winSec - w) < 0.05;
                  const label = w === 120 ? "2 min" : `${w} s`;
                  return `<button type="button" class="debug-axis-menu-item ${active ? "is-active" : ""}" data-window="${w}" role="menuitem"><span>${label}</span></button>`;
                }).join("")}
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

    this.slot("hint").textContent = live
      ? "Live · drag chart to pan · Shift+drag box to zoom · drag axes to stretch"
      : "Paused · drag chart to pan · Shift+drag box to zoom · drag axes to stretch";
  }

  /** The calibration row: what the tags mean, Auto-calibrate, Reset, and the last result with Undo. */
  private renderCalib(): void {
    if (this.isMultiPilotMode) {
      const count = (this.multiPilotSlots ?? []).length;
      this.slot("calib").innerHTML = `
        <span class="scope-calib-text">Showing all ${count} seated pilots simultaneously — select an individual pilot above to tune thresholds.</span>`;
      return;
    }
    const pilot = this.store.pilot(this.activePilotSlot);
    if (!pilot) return;
    if (this.store.isHistoricalTrack) {
      this.slot("calib").innerHTML = `
        <span class="scope-calib-text">Historical track snapshot (read-only) — thresholds reflect recorded session gates.</span>`;
      return;
    }
    const minutes = Math.round(HISTORY_SECONDS / 60);
    const isLapRF = this.isLapRF;
    const isRH = this.isRH;
    const canAutoCalib = !isLapRF && !isRH;

    let text: string;
    let actions: string;
    if (this.focus === null) {
      const anyCalibrated = this.store.nodes.some((p) =>
        isLapRF
          ? enterThresholdAt(this.store, p.gateId, pilot.slotIndex).calibrated
          : enterThresholdAt(this.store, p.gateId, pilot.slotIndex).calibrated ||
            exitThresholdAt(this.store, p.gateId, pilot.slotIndex).calibrated
      );
      text =
        this.calibMessage ||
        (isLapRF
          ? "Select a timer above to view or drag its LapRF crossing threshold (300–3500)."
          : isRH
            ? "Select a timer above to view or drag its RotorHazard Enter & Exit thresholds (0–255)."
            : "Timers auto-calibrate every 30 s from live lap passes · select a timer above to inspect or drag its thresholds.");
      actions = `
        <div class="scope-calib-actions">
          ${this.undo ? `<button class="btn btn-sm btn-ghost" type="button" data-calib="undo">${icons.reset(15)}<span>Undo</span></button>` : ""}
          ${anyCalibrated ? `<button class="btn btn-sm btn-ghost" type="button" data-calib="reset" title="Use ${esc(pilot.callsign)}'s own threshold at every timer">${icons.reset(15)}<span>Reset all</span></button>` : ""}
          ${canAutoCalib ? `<button class="btn btn-sm btn-ghost" type="button" data-calib="auto" title="Set each timer's thresholds from the last ${minutes} minutes of signal">${icons.target(16)}<span>Auto-calibrate all</span></button>` : ""}
        </div>`;
    } else {
      const name = gateLabel(this.store, this.focus);
      const t = enterThresholdAt(this.store, this.focus, pilot.slotIndex);
      const ex = exitThresholdAt(this.store, this.focus, pilot.slotIndex);
      const isCal = isLapRF ? t.calibrated : t.calibrated || ex.calibrated;
      text =
        this.calibMessage ||
        (isLapRF
          ? `${name}: Threshold ${t.dbm.toFixed(0)} ${isCal ? "(calibrated)" : `(${pilot.callsign}'s default)`} · drag line to adjust`
          : `${name}: Enter ${t.dbm.toFixed(0)} / Exit ${ex.dbm.toFixed(0)}${this.unitSuffix} ${isCal ? "(calibrated)" : `(${pilot.callsign}'s default)`} · drag lines to adjust`);
      actions = `
        <div class="scope-calib-actions">
          ${this.undo ? `<button class="btn btn-sm btn-ghost" type="button" data-calib="undo">${icons.reset(15)}<span>Undo</span></button>` : ""}
          ${isCal ? `<button class="btn btn-sm btn-ghost" type="button" data-calib="reset" title="Use ${esc(pilot.callsign)}'s own threshold at ${esc(name)}">${icons.reset(15)}<span>Reset</span></button>` : ""}
          ${canAutoCalib ? `<button class="btn btn-sm btn-ghost" type="button" data-calib="auto" title="Set ${esc(name)}'s thresholds from the last ${minutes} minutes of signal">${icons.target(16)}<span>Auto-calibrate</span></button>` : ""}
        </div>`;
    }
    this.slot("calib").innerHTML = `
      <span class="scope-calib-text">${esc(text)}</span>
      ${actions}`;
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

    const structSig = [
      this.focus ?? "all",
      this.isMultiPilotMode ? "multi" : "single",
      unitSuffix,
      this.store.nodes.map((p) => `${p.gateId}:${gateLabel(this.store, p.gateId)}:${this.colorOf(p.gateId)}`).join(","),
    ].join("|");

    const legendEl = this.slot("legend");
    if (structSig !== this.lastLegendStructSig || legendEl.childElementCount === 0) {
      this.lastLegendStructSig = structSig;
      const allChip = `
        <button type="button" class="channel channel-all ${this.focus === null ? "is-focus" : "is-dim"}"
                data-focus="all" title="Show all timers (${this.store.nodes.length})">
          <span class="dot channel-all-dot"></span>
          <span class="channel-name">All timers</span>
          <span class="channel-dbm mono">${this.store.nodes.length} timers</span>
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
          const hot = !this.isMultiPilotMode && dbm >= this.thresholdOf(p.gateId).dbm;
          const dim = this.focus !== null && this.focus !== p.gateId;
          return `
            <button type="button" class="channel ${hot ? "is-hot" : ""} ${dim ? "is-dim" : ""} ${this.focus === p.gateId ? "is-focus" : ""}"
                    data-gate-chip="${p.gateId}"
                    data-focus="${this.focus === p.gateId ? "all" : p.gateId}" title="${this.focus === p.gateId ? "Show all timers" : "Show only this timer"}">
              <span class="dot" style="--c:${this.colorOf(p.gateId)}"></span>
              <span class="channel-name">${esc(gateLabel(this.store, p.gateId))}</span>
              <span class="channel-dbm mono" data-gate-dbm="${p.gateId}">${this.isMultiPilotMode ? "peak " : ""}${dbm.toFixed(0)}${unitSuffix}</span>
            </button>`;
        })
        .join("");
      legendEl.innerHTML = allChip + gateChips;
      return;
    }

    // Fast in-place update of live RSSI numbers without rebuilding button DOM
    for (const p of this.store.nodes) {
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
      const chipBtn = legendEl.querySelector<HTMLElement>(`[data-gate-chip="${p.gateId}"]`);
      if (chipBtn) {
        chipBtn.classList.toggle("is-hot", hot);
      }
      const valSpan = legendEl.querySelector<HTMLElement>(`[data-gate-dbm="${p.gateId}"]`);
      const nextText = `${this.isMultiPilotMode ? "peak " : ""}${dbm.toFixed(0)}${unitSuffix}`;
      if (valSpan && valSpan.textContent !== nextText) {
        valSpan.textContent = nextText;
      }
    }
  }
}
