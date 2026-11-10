import { CanvasSurface } from "../core/canvas";
import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { font, theme, withAlpha } from "../core/theme";
import { ApiClient } from "../services/api_client";
import { suggestThreshold } from "../state/calibration";
import { enterThresholdAt, gateColor, gateLabel } from "../state/selectors";
import { AppStore, HISTORY_SECONDS } from "../state/store";
import { GateThresholdUpdate, TimerTelemetryFrame } from "../types/models";
import { FILTER_LABELS } from "./markup";

const DBM_MIN = -100;
const DBM_MAX = -15;
const DEFAULT_Y_MIN = -95;
const DEFAULT_Y_MAX = -20;
const WINDOWS_SEC = [1, 2, 5, 10, 30, 60, 120] as const;
const DEFAULT_WINDOW_US = 5_000_000;
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

const PAD = { l: 46, r: 16 + TAG_GUTTER, t: 34, b: 26 };

/** A pass the pilot made through a gate: timed, or set aside by the timing rules. */
interface PassMarker {
  ts: number;
  gateId: number;
  counted: boolean;
  title: string;
  detail: string;
}

/** Where a gate's threshold tag was drawn, for hit-testing drags. */
interface TagBox {
  gateId: number;
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
  private tagDrag: { gateId: number; dbm: number } | null = null;
  /** Values shown while a save is in flight, so the line doesn't jump back. */
  private readonly pending = new Map<number, number>();
  private tags: TagBox[] = [];
  /** Previous thresholds, to undo the last calibration change. */
  private undo: GateThresholdUpdate[] | null = null;
  private calibMessage = "";
  /** Gate shown on its own (with its editable threshold); null shows every gate. */
  private focus: number | null = null;
  /** Plot geometry from the last frame, for mapping pointer positions to time and dBm. */
  private plot = { x: PAD.l, w: 1, h: 1 };

  /** Right padding: room for the threshold tag only when one gate is shown. */
  private get padR(): number {
    return this.focus === null ? 16 : PAD.r;
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
        <span class="scope-hint" data-slot="hint"></span>
        <div class="scope-axis-controls" data-slot="axis-controls" role="group" aria-label="X and Y axis scale controls"></div>
      </div>
      <div class="canvas-host canvas-host-md scope-canvas" data-slot="chart" tabindex="0"
           aria-label="Signal chart. Space pauses, arrow keys jump between passes."></div>
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
        this.yMin = -98;
        this.yMax = -64;
        this.smoothYMin = this.yMin;
        this.smoothYMax = this.yMax;
        this.openAxisMenu = null;
        this.saveChartPrefs();
        this.renderControls();
      } else if (btn.dataset.axisAct === "full-y") {
        this.autoY = false;
        this.yMin = DEFAULT_Y_MIN;
        this.yMax = DEFAULT_Y_MAX;
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

    this.listen(host, "dblclick", () => {
      this.resetAxesToAuto();
    });

    this.listen(host, "pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.pointerType === "touch") {
        const now = performance.now();
        if (now - lastTapTime < 320 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 28) {
          lastTapTime = 0;
          this.resetAxesToAuto();
          return;
        }
        lastTapTime = now;
        lastTapX = e.clientX;
        lastTapY = e.clientY;
      }

      try {
        host.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic / already-released pointers can't be captured; dragging still works.
      }
      const r = host.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      this.hoverX = x;
      this.hoverY = y;

      const grabbed = this.tagAt(x, y);
      if (grabbed !== null) {
        this.tagDrag = { gateId: grabbed, dbm: this.thresholdOf(grabbed).dbm };
        return;
      }

      const isTouch = e.pointerType === "touch";
      const yAxisW = isTouch ? 54 : PAD.l;
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

      if (y >= r.height - xAxisH && x >= PAD.l && x <= PAD.l + this.plot.w) {
        // Dragging on bottom X-axis stretches/shrinks the time window smoothly
        const xFrac = Math.max(0, Math.min(1, (x - PAD.l) / Math.max(10, this.plot.w)));
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
      this.hoverX = x;
      this.hoverY = y;

      if (this.tagDrag) {
        this.tagDrag.dbm = Math.round(this.dbmAt(y));
        return;
      }

      if (!this.drag) {
        const overTag = this.tagAt(x, y) !== null;
        const overYAxis = !overTag && x < PAD.l && y >= PAD.t && y <= r.height - PAD.b;
        const overXAxis =
          !overTag && !overYAxis && y >= r.height - PAD.b && x >= PAD.l && x <= PAD.l + this.plot.w;
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

    const endDrag = () => {
      if (this.tagDrag) {
        const { gateId, dbm } = this.tagDrag;
        this.tagDrag = null;
        if (dbm !== this.thresholdOf(gateId).dbm) void this.saveManual(gateId, dbm);
      }
      if (this.drag) {
        if (this.drag.mode === "ybox" && this.yZoomBox) {
          const ya = Math.max(PAD.t, Math.min(PAD.t + this.plot.h, Math.min(this.yZoomBox.y0, this.yZoomBox.y1)));
          const yb = Math.max(PAD.t, Math.min(PAD.t + this.plot.h, Math.max(this.yZoomBox.y0, this.yZoomBox.y1)));
          if (yb - ya >= 10) {
            const dHigh = this.dbmAt(ya);
            const dLow = this.dbmAt(yb);
            if (dHigh - dLow >= 4) {
              this.autoY = false;
              this.yMin = Math.max(DBM_MIN, dLow);
              this.yMax = Math.min(DBM_MAX, dHigh);
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
    // Wheel zooms around the cursor (or stretches Y when over the left Y-axis).
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = host.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (x < PAD.l) {
        const factor = e.deltaY > 0 ? 1.18 : 0.85;
        const yFrac = Math.max(0, Math.min(1, 1 - (y - PAD.t) / Math.max(10, this.plot.h)));
        this.applyDbmStretch(this.yMin, this.yMax, yFrac, factor);
        this.saveChartPrefs();
        this.renderControls();
      } else {
        this.zoom(e.deltaY > 0 ? 1.25 : 0.8, x);
      }
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    this.onDispose(() => host.removeEventListener("wheel", onWheel));

    const timer = window.setInterval(() => {
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
      store.subscribe(["config"], () => {
        if (this.focus !== null && !store.node(this.focus)) this.focus = null;
        this.renderCalib();
      })
    );
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
    return this.endUs ?? this.livePlayhead;
  }

  private clampEnd(end: number): number {
    return Math.min(this.latest, Math.max(this.earliest + this.windowUs, end));
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
    return Math.max(DBM_MIN, Math.min(DBM_MAX, v));
  }

  private applyDbmStretch(startMin: number, startMax: number, anchorFrac: number, factor: number): void {
    const curSpan = Math.max(6, startMax - startMin);
    const nextSpan = Math.max(6, Math.min(DBM_MAX - DBM_MIN, curSpan * factor));
    const anchorDbm = startMin + anchorFrac * curSpan;
    let nextMin = anchorDbm - anchorFrac * nextSpan;
    let nextMax = nextMin + nextSpan;
    if (nextMin < DBM_MIN) {
      nextMin = DBM_MIN;
      nextMax = Math.min(DBM_MAX, DBM_MIN + nextSpan);
    }
    if (nextMax > DBM_MAX) {
      nextMax = DBM_MAX;
      nextMin = Math.max(DBM_MIN, DBM_MAX - nextSpan);
    }
    this.autoY = false;
    this.yMin = nextMin;
    this.yMax = nextMax;
    this.smoothYMin = nextMin;
    this.smoothYMax = nextMax;
  }

  private applyDbmPan(startMin: number, startMax: number, deltaDbm: number): void {
    const span = Math.max(6, startMax - startMin);
    let nextMin = startMin + deltaDbm;
    let nextMax = nextMin + span;
    if (nextMin < DBM_MIN) {
      nextMin = DBM_MIN;
      nextMax = Math.min(DBM_MAX, DBM_MIN + span);
    }
    if (nextMax > DBM_MAX) {
      nextMax = DBM_MAX;
      nextMin = Math.max(DBM_MIN, DBM_MAX - span);
    }
    this.autoY = false;
    this.yMin = nextMin;
    this.yMax = nextMax;
    this.smoothYMin = nextMin;
    this.smoothYMax = nextMax;
  }

  private updateAutoY(start: number, end: number, slot: number): void {
    if (!this.autoY) return;
    let minD = 1000;
    let maxD = -1000;
    for (const gate of this.shownGates) {
      const frames = this.store.historyFor(gate.gateId);
      if (!frames.length) continue;
      const from = Math.max(0, PilotRssiChart.firstAtOrAfter(frames, start) - 1);
      const to = Math.min(frames.length - 1, PilotRssiChart.firstAtOrAfter(frames, end));
      for (let i = from; i <= to; i++) {
        const v = frames[i]?.rssi[slot];
        if (v !== undefined && v > -127 && v < 0) {
          if (v < minD) minD = v;
          if (v > maxD) maxD = v;
        }
      }
      const thr = this.thresholdOf(gate.gateId).dbm;
      if (this.focus !== null || maxD >= thr - 14) {
        if (thr > maxD) maxD = thr;
        if (thr < minD) minD = thr;
      }
    }
    if (minD > maxD) {
      this.yMin = DEFAULT_Y_MIN;
      this.yMax = DEFAULT_Y_MAX;
      return;
    }
    let targetMin = Math.max(DBM_MIN, Math.floor((minD - 5) / 2) * 2);
    let targetMax = Math.min(DBM_MAX, Math.ceil((maxD + 6) / 2) * 2);
    const minSpan = 22;
    if (targetMax - targetMin < minSpan) {
      const extra = minSpan - (targetMax - targetMin);
      targetMin = Math.max(DBM_MIN, targetMin - Math.floor(extra * 0.35));
      targetMax = Math.min(DBM_MAX, targetMin + minSpan);
    }
    if (this.smoothYMin === null || this.smoothYMax === null) {
      this.smoothYMin = targetMin;
      this.smoothYMax = targetMax;
    } else {
      const curMin = this.smoothYMin;
      const curMax = this.smoothYMax;
      const needMinMove = minD < curMin + 2 || minD > curMin + 9;
      const needMaxMove = maxD > curMax - 2 || maxD < curMax - 10;
      const effTargetMin = needMinMove ? targetMin : curMin;
      const effTargetMax = needMaxMove ? targetMax : curMax;
      const diffMin = effTargetMin - curMin;
      const diffMax = effTargetMax - curMax;
      if (Math.abs(diffMin) > 0.05) {
        const alphaMin = diffMin < 0 ? 0.35 : 0.08;
        this.smoothYMin = Math.abs(diffMin) < 0.25 ? effTargetMin : curMin + diffMin * alphaMin;
      }
      if (Math.abs(diffMax) > 0.05) {
        const alphaMax = diffMax > 0 ? 0.4 : 0.08;
        this.smoothYMax = Math.abs(diffMax) < 0.25 ? effTargetMax : curMax + diffMax * alphaMax;
      }
    }
    this.yMin = this.smoothYMin;
    this.yMax = Math.max(this.yMin + 12, this.smoothYMax);
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
      if (typeof parsed.windowUs === "number" && parsed.windowUs >= MIN_WINDOW_US && parsed.windowUs <= MAX_WINDOW_US) {
        this.windowUs = parsed.windowUs;
      }
      if (typeof parsed.autoX === "boolean") {
        this.autoX = parsed.autoX;
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
    this.yMin = DEFAULT_Y_MIN;
    this.yMax = DEFAULT_Y_MAX;
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
    if (this.endUs === null) this.refUs = this.latest;
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

  /** The threshold to show for a gate: while dragging, the dragged value; then pending; then stored. */
  private thresholdOf(gateId: number): { dbm: number; calibrated: boolean } {
    if (this.tagDrag?.gateId === gateId) return { dbm: this.tagDrag.dbm, calibrated: true };
    const pending = this.pending.get(gateId);
    if (pending !== undefined) return { dbm: pending, calibrated: pending !== 0 };
    return enterThresholdAt(this.store, gateId, this.store.selectedPilot);
  }

  /** Gate whose threshold tag (or line) is under the pointer, if any. Tags win over lines. */
  private tagAt(x: number, y: number): number | null {
    for (const t of this.tags) {
      if (x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + TAG_H) return t.gateId;
    }
    if (x < PAD.l || x > PAD.l + this.plot.w) return null;
    let best: TagBox | null = null;
    for (const t of this.tags) {
      if (Math.abs(y - t.lineY) <= LINE_HIT_PX && (!best || Math.abs(y - t.lineY) < Math.abs(y - best.lineY))) best = t;
    }
    return best?.gateId ?? null;
  }

  /** Raw stored overrides for this pilot (0 = pilot default), for undo. */
  private currentOverrides(): GateThresholdUpdate[] {
    const slotIndex = this.store.selectedPilot;
    const pos = this.store.pilots.findIndex((p) => p.slotIndex === slotIndex);
    return this.store.nodes.map((p) => ({ gateId: p.gateId, slotIndex, enterDbm: p.enterThresholds?.[pos] ?? 0 }));
  }

  private async apply(updates: GateThresholdUpdate[], message: string): Promise<void> {
    const before = this.currentOverrides().filter((o) => updates.some((u) => u.gateId === o.gateId));
    updates.forEach((u) => this.pending.set(u.gateId, u.enterDbm === 0 ? this.pilotDefault() : u.enterDbm));
    try {
      await this.api.setGateThresholds(updates);
      this.undo = before;
      this.calibMessage = message;
    } catch {
      this.calibMessage = "Couldn't save the thresholds — is the timer still running?";
    } finally {
      updates.forEach((u) => this.pending.delete(u.gateId));
      this.renderCalib();
    }
  }

  private pilotDefault(): number {
    return this.store.pilot(this.store.selectedPilot)?.enterThreshold ?? -58;
  }

  private saveManual(gateId: number, dbm: number): Promise<void> {
    return this.apply(
      [{ gateId, slotIndex: this.store.selectedPilot, enterDbm: dbm }],
      `${gateLabel(this.store, gateId)} set to ${dbm} dBm.`
    );
  }

  /**
   * Works out each gate's threshold from the recent signal (see suggestThreshold): noise
   * floor between passes vs. the peaks of the passes themselves.
   */
  private async autoCalibrate(): Promise<void> {
    const pilot = this.store.pilot(this.store.selectedPilot);
    if (!pilot) return;
    const pos = this.store.pilots.indexOf(pilot);
    const updates: GateThresholdUpdate[] = [];
    const done: string[] = [];
    const skipped: string[] = [];
    for (const gate of this.shownGates) {
      const result = suggestThreshold(this.store.historyFor(gate.gateId), pos);
      const name = gateLabel(this.store, gate.gateId);
      if (result.ok) {
        updates.push({ gateId: gate.gateId, slotIndex: pilot.slotIndex, enterDbm: result.enterDbm });
        done.push(`${name} ${result.enterDbm}`);
      } else {
        skipped.push(`${name}: ${result.reason}`);
      }
    }
    if (updates.length === 0) {
      this.calibMessage = `Couldn't calibrate yet — ${skipped[0] ?? "no signal"}. Let ${pilot.callsign} fly a few laps with this page open, then try again.`;
      this.renderCalib();
      return;
    }
    const minutes = Math.round(HISTORY_SECONDS / 60);
    await this.apply(
      updates,
      `Calibrated from the last ${minutes} min: ${done.join(" · ")} dBm.${skipped.length ? ` Skipped ${skipped.join(", ")}.` : ""}`
    );
  }

  private resetToDefault(): Promise<void> {
    const slotIndex = this.store.selectedPilot;
    const who = this.store.pilot(slotIndex)?.callsign ?? "the pilot";
    const message =
      this.focus === null
        ? `Every timer is back on ${who}'s own threshold (${this.pilotDefault()} dBm).`
        : `${gateLabel(this.store, this.focus)} is back on ${who}'s own threshold (${this.pilotDefault()} dBm).`;
    return this.apply(
      this.shownGates.map((p) => ({ gateId: p.gateId, slotIndex, enterDbm: 0 })),
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

  /** This pilot's passes in [from, to], oldest first. */
  private passes(from: number, to: number): PassMarker[] {
    const slot = this.store.selectedPilot;
    const timed: PassMarker[] = this.store.crossings
      .filter((c) => c.slotIndex === slot && c.timestampUs >= from && c.timestampUs <= to)
      .map((c) => ({
        ts: c.timestampUs,
        gateId: c.gateId,
        counted: true,
        title: `${gateLabel(this.store, c.gateId)} · ${c.estimatedSpeedMph.toFixed(0)} mph`,
        detail: `Timed · peak ${c.peakRssiDbm.toFixed(0)} dBm`,
      }));
    const rejected: PassMarker[] = this.store.filtered
      .filter((f) => f.slotIndex === slot && f.timestampUs >= from && f.timestampUs <= to)
      .map((f) => ({
        ts: f.timestampUs,
        gateId: f.gateId,
        counted: false,
        title: `${gateLabel(this.store, f.gateId)} · not counted (${FILTER_LABELS[f.reason]})`,
        detail: f.detail,
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
    const pilot = this.store.pilot(this.store.selectedPilot);
    if (!pilot) return;
    const slot = this.store.pilots.indexOf(pilot);
    const plotW = w - PAD.l - this.padR;
    const plotH = h - PAD.t - PAD.b;
    this.plot = { x: PAD.l, w: plotW, h: plotH };

    if (this.endUs !== null) this.endUs = this.clampEnd(this.endUs);
    const end = this.viewEnd();
    const ref = this.endUs === null ? end : this.refUs;
    const start = end - this.windowUs;

    this.updateAutoY(start, end, slot);

    const xOf = (ts: number) => PAD.l + plotW * ((ts - start) / this.windowUs);
    const yOf = (dbm: number) => this.yOf(dbm);

    this.drawGrid(ctx, w, h, start, end, ref, xOf, yOf);

    if (this.latest > 0) {
      // Traces, decimated to roughly one point per pixel when zoomed out.
      ctx.save();
      ctx.beginPath();
      ctx.rect(PAD.l, PAD.t - 4, plotW, plotH + 8);
      ctx.clip();
      ctx.lineJoin = "round";
      ctx.lineWidth = 1.6;
      for (const gate of this.shownGates) {
        const frames = this.store.historyFor(gate.gateId);
        const from = Math.max(0, PilotRssiChart.firstAtOrAfter(frames, start) - 1);
        const to = Math.min(frames.length - 1, PilotRssiChart.firstAtOrAfter(frames, end));
        if (to - from < 1) continue;
        const step = Math.max(1, Math.floor((to - from) / plotW));
        ctx.strokeStyle = this.colorOf(gate.gateId);
        ctx.beginPath();
        // Start on a multiple of the step so the same samples are drawn as the view scrolls
        // (otherwise zoomed-out traces shimmer).
        const first = Math.max(0, from - (from % step));
        let lastY = PAD.t;
        let lastTs = 0;
        for (let i = first; i <= to; i += step) {
          const x = xOf(frames[i].timestampUs);
          const y = yOf(frames[i].rssi[slot] ?? this.yMin);
          if (i === first) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
          lastY = y;
          lastTs = frames[i].timestampUs;
        }
        // When following live, extend the newest sample horizontally to the right edge if it is
        // within a few superframes (<= 300 ms), so traces stay flush with the right edge
        // between 40 ms packet bursts instead of visibly stepping at the tip.
        if (this.endUs === null && to === frames.length - 1 && end > lastTs && end - lastTs <= 300_000) {
          ctx.lineTo(Math.min(PAD.l + plotW, xOf(end)), lastY);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // Shift+drag Y box-zoom overlay
    if (this.yZoomBox) {
      const ya = Math.max(PAD.t, Math.min(PAD.t + plotH, Math.min(this.yZoomBox.y0, this.yZoomBox.y1)));
      const yb = Math.max(PAD.t, Math.min(PAD.t + plotH, Math.max(this.yZoomBox.y0, this.yZoomBox.y1)));
      ctx.save();
      ctx.fillStyle = "rgba(212, 255, 58, 0.12)";
      ctx.fillRect(PAD.l, ya, plotW, Math.max(1, yb - ya));
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(PAD.l, ya + 0.5);
      ctx.lineTo(w - this.padR, ya + 0.5);
      ctx.moveTo(PAD.l, yb + 0.5);
      ctx.lineTo(w - this.padR, yb + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      const dHigh = Math.round(this.dbmAt(ya));
      const dLow = Math.round(this.dbmAt(yb));
      ctx.fillStyle = theme.accent;
      ctx.font = font(600, 10.5, true);
      ctx.textAlign = "left";
      ctx.fillText(`Zoom Y: ${dLow} to ${dHigh} dBm`, PAD.l + 8, (ya + yb) / 2 + 3.5);
      ctx.restore();
    }

    if (this.focus !== null) this.drawThresholds(ctx, w, plotW, plotH);
    if (this.latest === 0) return;

    // Pass markers: dashed in the gate's colour when timed, red when set aside.
    ctx.font = font(600, 10.5);
    const rows = this.labelRows(ctx, xOf, end);
    const passes = this.focusedPasses(start, end);
    let hovered: PassMarker | null = null;
    passes.forEach((p) => {
      const x = xOf(p.ts);
      const color = p.counted ? this.colorOf(p.gateId) : theme.bad;
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
      ctx.fillText(this.labelOf(p), x + 5, PAD.t - 18 + (rows.get(PilotRssiChart.keyOf(p)) ?? 0) * 12);
      if (this.hoverX !== null && Math.abs(this.hoverX - x) <= MARKER_HIT_PX) hovered = p;
    });

    if (!this.tagDrag && !this.yZoomBox && this.hoverX !== null && this.hoverX >= PAD.l && this.hoverX <= PAD.l + plotW) {
      this.drawCursor(ctx, h, plotH, this.hoverX, hovered);
    }
  }

  /**
   * One threshold line per gate, in the gate's colour, with a draggable tag at the right
   * edge. Tags that would overlap are moved into extra columns to the left. Outlined tags
   * use the pilot's own threshold; filled tags are calibrated for that gate.
   */
  private drawThresholds(ctx: CanvasRenderingContext2D, w: number, plotW: number, plotH: number): void {
    ctx.font = font(700, 10.5);
    const items = this.shownGates.map((p) => {
      const t = this.thresholdOf(p.gateId);
      const name = gateLabel(this.store, p.gateId);
      const text = `${name.length > 8 ? `${name.slice(0, 7)}…` : name} ${t.dbm.toFixed(0)}`;
      const clampedY = Math.max(PAD.t, Math.min(PAD.t + plotH, this.yOf(t.dbm)));
      return { gateId: p.gateId, ...t, text, lineY: clampedY, width: ctx.measureText(text).width + 14 };
    });
    const colW = Math.max(...items.map((i) => i.width), 40) + TAG_GAP;

    // Column layout: each tag takes the right-most column where it doesn't overlap another.
    const columns: Array<Array<{ top: number }>> = [];
    const placed: TagBox[] = [];
    for (const item of [...items].sort((a, b) => a.lineY - b.lineY)) {
      const top = item.lineY - TAG_H / 2;
      let col = 0;
      while (columns[col]?.some((o) => Math.abs(o.top - top) < TAG_H + 2)) col++;
      (columns[col] ??= []).push({ top });
      placed.push({ gateId: item.gateId, x: w - 16 - item.width - col * colW, y: top, w: item.width, lineY: item.lineY });
    }
    this.tags = placed;

    const active = this.tagDrag?.gateId ?? (this.hoverX !== null && this.hoverY !== null ? this.tagAt(this.hoverX, this.hoverY) : null);
    for (const item of items) {
      const color = this.colorOf(item.gateId);
      const box = placed.find((b) => b.gateId === item.gateId)!;
      const isActive = active === item.gateId;
      // Line across the plot, joined to its tag.
      ctx.save();
      ctx.strokeStyle = withAlpha(color, isActive ? 0.95 : 0.45);
      ctx.lineWidth = isActive ? 1.5 : 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(PAD.l, item.lineY);
      ctx.lineTo(Math.max(PAD.l + plotW, box.x), item.lineY);
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
      ctx.fillStyle = item.calibrated ? "#0b0d10" : color;
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
    return `${p.ts}:${p.gateId}:${p.counted ? 1 : 0}`;
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
    const dStep = ySpan <= 14 ? 2 : ySpan <= 32 ? 5 : ySpan <= 60 ? 10 : 15;
    for (let level = Math.ceil(this.yMin / dStep) * dStep; level <= this.yMax; level += dStep) {
      const y = Math.round(yOf(level)) + 0.5;
      if (y < PAD.t - 1 || y > h - PAD.b + 1) continue;
      ctx.strokeStyle = theme.grid;
      ctx.beginPath();
      ctx.moveTo(PAD.l, y);
      ctx.lineTo(w - this.padR, y);
      ctx.stroke();
      ctx.fillStyle = theme.text3;
      ctx.textAlign = "right";
      ctx.fillText(`${level}`, PAD.l - 10, y + 3.5);
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
              : winSec <= 16
                ? 2
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
      if (x < PAD.l - 4 || x > w - this.padR + 4) continue;
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
    ctx.fillStyle = theme.surface;
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
    const bx = Math.min(x + 10, PAD.l + this.plot.w - boxW);
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
    btn.title = live ? "Following live signal stream — click to pause (Space)" : "Stream paused — click to resume live stream (Space)";
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

    const isFloorY = !this.autoY && Math.round(this.yMin) === -98 && Math.round(this.yMax) === -64;
    const isFullY = !this.autoY && Math.round(this.yMin) === DEFAULT_Y_MIN && Math.round(this.yMax) === DEFAULT_Y_MAX;
    const yShort = isFloorY ? "Floor" : isFullY ? "Full" : `${Math.round(this.yMax - this.yMin)}dB`;

    this.slot("axis-controls").innerHTML = `
      <div class="debug-axis-pill ${this.autoX ? "is-armed" : "is-unarmed"}" data-axis-pill>
        <button type="button" class="debug-axis-pill-main" data-axis-act="${this.autoX ? "toggle-menu" : "auto-x"}" data-menu="rssi-x" title="${this.autoX ? `Auto X-axis time window (${xWinLabel}) — click to choose a time window preset, or drag X-axis to stretch` : "Click to reset X-axis time window to Auto X (5 s)"}">
          ${icons.target(13)}<span>${this.autoX ? "Auto X" : `<span class="debug-hint-desktop">X: ${xWinLabel}</span><span class="debug-hint-mobile">X: ${xWinShort}</span>`}</span>
        </button>
        <button type="button" class="debug-axis-pill-arrow" data-axis-act="toggle-menu" data-menu="rssi-x" aria-expanded="${this.openAxisMenu === "rssi-x"}" title="Choose X-axis time window">
          ${icons.chevronDown(12)}
        </button>
        ${
          this.openAxisMenu === "rssi-x"
            ? `<div class="debug-axis-menu" role="menu" aria-label="X-axis time window">
                <button type="button" class="debug-axis-menu-item ${this.autoX ? "is-active" : ""}" data-axis-act="auto-x" role="menuitem">
                  <span>Auto X</span><span class="note">5 s</span>
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
        <button type="button" class="debug-axis-pill-main" data-axis-act="${this.autoY ? "toggle-menu" : "auto-y"}" data-menu="rssi-y" title="${this.autoY ? "Auto Y-axis scaling is ON — fits visible timer traces automatically. Click to choose a scale preset, or drag the Y-axis to stretch." : "Click to reset Y-axis range to Auto Y"}">
          ${icons.target(13)}<span>${this.autoY ? "Auto Y" : `<span class="debug-hint-desktop">Y: ${Math.round(this.yMin)}…${Math.round(this.yMax)} dBm</span><span class="debug-hint-mobile">Y: ${yShort}</span>`}</span>
        </button>
        <button type="button" class="debug-axis-pill-arrow" data-axis-act="toggle-menu" data-menu="rssi-y" aria-expanded="${this.openAxisMenu === "rssi-y"}" title="Choose Y-axis dBm scale">
          ${icons.chevronDown(12)}
        </button>
        ${
          this.openAxisMenu === "rssi-y"
            ? `<div class="debug-axis-menu" role="menu" aria-label="Y-axis dBm scale">
                <button type="button" class="debug-axis-menu-item ${this.autoY ? "is-active" : ""}" data-axis-act="auto-y" role="menuitem">
                  <span>Auto Y</span><span class="note">Fit traces</span>
                </button>
                <div class="debug-axis-menu-sep"></div>
                <button type="button" class="debug-axis-menu-item ${isFloorY ? "is-active" : ""}" data-axis-act="floor-y" role="menuitem">
                  <span>Noise floor</span><span class="note">−98…−64 dBm</span>
                </button>
                <button type="button" class="debug-axis-menu-item ${isFullY ? "is-active" : ""}" data-axis-act="full-y" role="menuitem">
                  <span>Full scale</span><span class="note">${DEFAULT_Y_MIN}…${DEFAULT_Y_MAX} dBm</span>
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
    const pilot = this.store.pilot(this.store.selectedPilot);
    if (!pilot) return;
    const minutes = Math.round(HISTORY_SECONDS / 60);

    let text: string;
    let actions: string;
    if (this.focus === null) {
      const anyCalibrated = this.store.nodes.some((p) => enterThresholdAt(this.store, p.gateId, pilot.slotIndex).calibrated);
      text = this.calibMessage || "Select a timer above to view or drag its threshold, or auto-calibrate all timers.";
      actions = `
        <div class="scope-calib-actions">
          ${this.undo ? `<button class="btn btn-sm btn-ghost" type="button" data-calib="undo">${icons.reset(15)}<span>Undo</span></button>` : ""}
          ${anyCalibrated ? `<button class="btn btn-sm btn-ghost" type="button" data-calib="reset" title="Use ${esc(pilot.callsign)}'s own threshold at every timer">${icons.reset(15)}<span>Reset all</span></button>` : ""}
          <button class="btn btn-sm btn-ghost" type="button" data-calib="auto" title="Set each timer's threshold from the last ${minutes} minutes of signal">${icons.target(16)}<span>Auto-calibrate all</span></button>
        </div>`;
    } else {
      const name = gateLabel(this.store, this.focus);
      const t = enterThresholdAt(this.store, this.focus, pilot.slotIndex);
      text =
        this.calibMessage ||
        `${name}: ${t.dbm.toFixed(0)} dBm ${t.calibrated ? "(calibrated)" : `(${pilot.callsign}'s default)`} · drag line to adjust`;
      actions = `
        <div class="scope-calib-actions">
          ${this.undo ? `<button class="btn btn-sm btn-ghost" type="button" data-calib="undo">${icons.reset(15)}<span>Undo</span></button>` : ""}
          ${t.calibrated ? `<button class="btn btn-sm btn-ghost" type="button" data-calib="reset" title="Use ${esc(pilot.callsign)}'s own threshold at ${esc(name)}">${icons.reset(15)}<span>Reset</span></button>` : ""}
          <button class="btn btn-sm btn-ghost" type="button" data-calib="auto" title="Set ${esc(name)}'s threshold from the last ${minutes} minutes of signal">${icons.target(16)}<span>Auto-calibrate</span></button>
        </div>`;
    }
    this.slot("calib").innerHTML = `
      <span class="scope-calib-text">${esc(text)}</span>
      ${actions}`;
  }

  /** Each timer's reading at the cursor (or at the right edge of the view), plus the "All timers" option. */
  private renderLegend(): void {
    const pilot = this.store.pilot(this.store.selectedPilot);
    if (!pilot) return;
    const slot = this.store.pilots.indexOf(pilot);
    const at = this.hoverX !== null && this.hoverX >= this.plot.x && this.hoverX <= this.plot.x + this.plot.w ? this.timeAt(this.hoverX) : this.viewEnd();
    const allChip = `
      <button type="button" class="channel channel-all ${this.focus === null ? "is-focus" : "is-dim"}"
              data-focus="all" title="Show all timers (${this.store.nodes.length})">
        <span class="dot channel-all-dot"></span>
        <span class="channel-name">All timers</span>
        <span class="channel-dbm mono">${this.store.nodes.length} timers</span>
      </button>`;
    const gateChips = this.store.nodes
      .map((p) => {
        const dbm = this.rssiAt(p.gateId, slot, at) ?? DEFAULT_Y_MIN;
        const hot = dbm >= this.thresholdOf(p.gateId).dbm;
        const dim = this.focus !== null && this.focus !== p.gateId;
        return `
          <button type="button" class="channel ${hot ? "is-hot" : ""} ${dim ? "is-dim" : ""} ${this.focus === p.gateId ? "is-focus" : ""}"
                  data-focus="${this.focus === p.gateId ? "all" : p.gateId}" title="${this.focus === p.gateId ? "Show all timers" : "Show only this timer"}">
            <span class="dot" style="--c:${this.colorOf(p.gateId)}"></span>
            <span class="channel-name">${esc(gateLabel(this.store, p.gateId))}</span>
            <span class="channel-dbm mono">${dbm.toFixed(0)} dBm</span>
          </button>`;
      })
      .join("");
    this.slot("legend").innerHTML = allChip + gateChips;
  }
}
