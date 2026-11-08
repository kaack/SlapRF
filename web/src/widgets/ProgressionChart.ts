import { CanvasSurface } from "../core/canvas";
import { Component } from "../core/component";
import { font, theme, withAlpha } from "../core/theme";
import { lapsFor, median } from "../state/selectors";
import { AppStore } from "../state/store";
import { LapRecord, PilotSlot } from "../types/models";

/** What the chart plots per lap: the whole lap, or one section of it. */
export type ProgressionMetric =
  | { kind: "lap" }
  | { kind: "section"; sectorIndex: number; fromPuckId: number; toPuckId: number };

interface Point {
  /** The pilot's lap number this session (1-based). */
  lap: number;
  t: number;
}

interface Series {
  pilot: PilotSlot;
  points: Point[];
}

/** Clip crash / pause laps so normal laps keep their resolution. */
const OUTLIER_FACTOR = 1.35;
/** Maximum number of laps shown in the viewport at one time. */
const WINDOW_LAPS = 50;
/** Maximum pixel distance from a plotted dot to trigger the hover tooltip. */
const HOVER_DOT_HIT_PX = 14;

interface HoveredPoint {
  pilot: PilotSlot;
  lap: number;
  t: number;
  x: number;
  y: number;
  clipped: boolean;
}

/**
 * Draws a smooth Fritsch–Carlson monotone cubic spline through `pts` so the curve passes
 * smoothly through every data point without artificial overshoot between laps.
 */
function traceMonotoneSpline(ctx: CanvasRenderingContext2D, pts: Array<{ x: number; y: number }>): void {
  const n = pts.length;
  if (n === 0) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  if (n === 1) return;
  if (n === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
    return;
  }

  const dx: number[] = new Array(n - 1);
  const dy: number[] = new Array(n - 1);
  const m: number[] = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x;
    dy[i] = pts[i + 1].y - pts[i].y;
    m[i] = dx[i] !== 0 ? dy[i] / dx[i] : 0;
  }

  const tangents: number[] = new Array(n);
  tangents[0] = m[0];
  tangents[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) {
      tangents[i] = 0;
    } else {
      tangents[i] = (m[i - 1] + m[i]) / 2;
    }
  }

  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
    } else {
      const a = tangents[i] / m[i];
      const b = tangents[i + 1] / m[i];
      const h = Math.hypot(a, b);
      if (h > 3) {
        const scale = 3 / h;
        tangents[i] = scale * a * m[i];
        tangents[i + 1] = scale * b * m[i];
      }
    }
  }

  for (let i = 0; i < n - 1; i++) {
    const segDx = dx[i] / 3;
    ctx.bezierCurveTo(
      pts[i].x + segDx,
      pts[i].y + tangents[i] * segDx,
      pts[i + 1].x - segDx,
      pts[i + 1].y - tangents[i + 1] * segDx,
      pts[i + 1].x,
      pts[i + 1].y
    );
  }
}

/** Every pilot's lap (or section) times across the session, lap by lap. Lower is faster. */
export class ProgressionChart extends Component {
  private readonly store: AppStore;
  private readonly surface: CanvasSurface;
  /** When set, only this pilot is plotted (re-evaluated on refresh). */
  private readonly slotIndex: (() => number) | undefined;
  private metric: ProgressionMetric = { kind: "lap" };
  private series: Series[] = [];
  private maxLap = 0;
  /** Rightmost visible lap number; null follows the most recent lap automatically. */
  private endLap: number | null = null;
  private drag: { startX: number; startEndLap: number; mode: "pan" | "thumb" } | null = null;
  private thumbHovered = false;
  private hoverPos: { x: number; y: number } | null = null;
  private hoveredDot = false;
  private plotGeom = { padL: 52, plotW: 1, h: 1 };

  constructor(el: HTMLElement, store: AppStore, opts: { slotIndex?: () => number } = {}) {
    super(el);
    this.store = store;
    this.slotIndex = opts.slotIndex;
    this.surface = new CanvasSurface(el, (ctx, w, h) => this.draw(ctx, w, h));
    this.onDispose(() => this.surface.destroy());

    this.listen(el, "pointerdown", (e) => {
      if (e.button !== 0 || this.maxLap <= WINDOW_LAPS) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const effectiveEnd = this.effectiveEndLap();
      const onScrollbar = y >= this.plotGeom.h - 18 && x >= this.plotGeom.padL && x <= this.plotGeom.padL + this.plotGeom.plotW;
      if (onScrollbar) {
        const plotW = Math.max(1, this.plotGeom.plotW);
        const thumbW = Math.max(24, (WINDOW_LAPS / this.maxLap) * plotW);
        const maxStart = Math.max(1, this.maxLap - WINDOW_LAPS);
        const startLap = Math.max(1, effectiveEnd - WINDOW_LAPS + 1);
        const thumbX = this.plotGeom.padL + ((startLap - 1) / maxStart) * (plotW - thumbW);
        // Clicking the track outside the thumb jumps the thumb to that position first.
        if (x < thumbX || x > thumbX + thumbW) {
          const ratio = Math.max(0, Math.min(1, (x - this.plotGeom.padL - thumbW / 2) / Math.max(1, plotW - thumbW)));
          const jumpedEnd = WINDOW_LAPS + ratio * (this.maxLap - WINDOW_LAPS);
          this.setEndLap(jumpedEnd);
        }
        this.drag = { startX: e.clientX, startEndLap: this.effectiveEndLap(), mode: "thumb" };
      } else {
        this.drag = { startX: e.clientX, startEndLap: effectiveEnd, mode: "pan" };
      }
      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
    });

    this.listen(el, "pointermove", (e) => {
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      this.hoverPos = { x, y };
      if (!this.drag) {
        if (this.maxLap > WINDOW_LAPS) {
          const overTrack =
            y >= this.plotGeom.h - 18 &&
            x >= this.plotGeom.padL &&
            x <= this.plotGeom.padL + this.plotGeom.plotW;
          let overThumb = false;
          if (overTrack) {
            const plotW = Math.max(1, this.plotGeom.plotW);
            const thumbW = Math.max(24, (WINDOW_LAPS / this.maxLap) * plotW);
            const maxStart = Math.max(1, this.maxLap - WINDOW_LAPS);
            const startLap = Math.max(1, this.effectiveEndLap() - WINDOW_LAPS + 1);
            const thumbX = this.plotGeom.padL + ((startLap - 1) / maxStart) * (plotW - thumbW);
            overThumb = x >= thumbX && x <= thumbX + thumbW;
          }
          this.thumbHovered = overTrack;
          el.style.cursor = overThumb
            ? "grab"
            : overTrack || this.hoveredDot
              ? "pointer"
              : "grab";
        } else {
          this.thumbHovered = false;
          el.style.cursor = this.hoveredDot ? "pointer" : "";
        }
        return;
      }
      const dx = e.clientX - this.drag.startX;
      const plotW = Math.max(1, this.plotGeom.plotW);
      let nextEnd: number;
      if (this.drag.mode === "thumb") {
        const thumbW = Math.max(24, (WINDOW_LAPS / this.maxLap) * plotW);
        const travel = Math.max(1, plotW - thumbW);
        const deltaLaps = (dx / travel) * (this.maxLap - WINDOW_LAPS);
        nextEnd = this.drag.startEndLap + deltaLaps;
      } else {
        const deltaLaps = -(dx / plotW) * (WINDOW_LAPS - 1);
        nextEnd = this.drag.startEndLap + deltaLaps;
      }
      this.setEndLap(nextEnd);
    });

    this.listen(el, "pointerleave", () => {
      this.hoverPos = null;
      this.hoveredDot = false;
      if (!this.drag) {
        this.thumbHovered = false;
        el.style.cursor = "";
      }
    });

    const endDrag = (e: PointerEvent) => {
      if (!this.drag) return;
      this.drag = null;
      if (el.hasPointerCapture(e.pointerId)) {
        el.releasePointerCapture(e.pointerId);
      }
      el.style.cursor = this.maxLap > WINDOW_LAPS ? "grab" : "";
    };
    this.listen(el, "pointerup", endDrag);
    this.listen(el, "pointercancel", endDrag);

    this.listen(
      el,
      "wheel",
      (e) => {
        if (this.maxLap <= WINDOW_LAPS) return;
        e.preventDefault();
        const rawDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (rawDelta === 0) return;
        const step = Math.sign(rawDelta) * Math.max(1, Math.round(WINDOW_LAPS * 0.1));
        this.setEndLap(this.effectiveEndLap() + step);
      },
      { passive: false }
    );

    this.listen(el, "dblclick", () => {
      if (this.endLap !== null) {
        this.endLap = null;
      }
    });

    this.onDispose(
      store.subscribe(["laps", "config", "selection"], () => {
        this.refresh();
      })
    );
    this.refresh();
  }

  public setMetric(metric: ProgressionMetric): void {
    this.metric = metric;
    this.refresh();
  }

  private effectiveEndLap(): number {
    if (this.maxLap <= WINDOW_LAPS || this.endLap === null) {
      return this.maxLap;
    }
    return Math.min(this.maxLap, Math.max(WINDOW_LAPS, Math.round(this.endLap)));
  }

  private setEndLap(next: number): void {
    const clamped = Math.min(this.maxLap, Math.max(WINDOW_LAPS, next));
    this.endLap = clamped >= this.maxLap - 0.25 ? null : clamped;
  }

  private valueOf(lap: LapRecord): number | undefined {
    if (this.metric.kind === "lap") return lap.lapTimeSec;
    const { sectorIndex, fromPuckId, toPuckId } = this.metric;
    const byPair = lap.sectors.find((s) => s.fromPuckId === fromPuckId && s.toPuckId === toPuckId);
    if (byPair) return byPair.splitSeconds;
    return lap.sectors.find((s) => s.sectorIndex === sectorIndex)?.splitSeconds;
  }

  private refresh(): void {
    const only = this.slotIndex?.();
    this.series = this.store.enabledPilots
      .filter((pilot) => only === undefined || pilot.slotIndex === only)
      .map((pilot) => ({
        pilot,
        points: lapsFor(this.store, pilot.slotIndex).flatMap((lap, i) => {
          const t = this.valueOf(lap);
          return t !== undefined && t > 0 ? [{ lap: i + 1, t }] : [];
        }),
      }))
      .filter((s) => s.points.length > 0);

    this.maxLap =
      this.series.length > 0 ? Math.max(...this.series.flatMap((s) => s.points.map((p) => p.lap))) : 0;
    if (this.maxLap <= WINDOW_LAPS) {
      this.endLap = null;
    }
  }

  private draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (this.series.length === 0) {
      ctx.fillStyle = theme.text3;
      ctx.font = font(500, 12);
      ctx.textAlign = "center";
      ctx.fillText(
        this.metric.kind === "lap" ? "Lap times appear here as pilots complete laps" : "No times for this section yet",
        w / 2,
        h / 2
      );
      ctx.textAlign = "left";
      return;
    }

    const scrollable = this.maxLap > WINDOW_LAPS;
    const endLap = this.effectiveEndLap();
    const startLap = scrollable ? Math.max(1, endLap - WINDOW_LAPS + 1) : 1;

    const visibleSeries = this.series
      .map((s) => ({
        pilot: s.pilot,
        points: s.points.filter((p) => p.lap >= startLap && p.lap <= endLap),
      }))
      .filter((s) => s.points.length > 0);

    const allSessionTimes = this.series.flatMap((s) => s.points.map((p) => p.t));
    const visibleTimes = visibleSeries.flatMap((s) => s.points.map((p) => p.t));
    const scaleTimes = visibleTimes.length > 0 ? visibleTimes : allSessionTimes;

    // Fit the axis to the spread of the times (not a % of the lap), so small differences show.
    const fast = Math.min(...scaleTimes);
    const slow = Math.min(Math.max(...scaleTimes), median(scaleTimes) * OUTLIER_FACTOR);
    const pad = Math.max(0.02, (slow - fast) * 0.12);
    const lo = fast - pad;
    const hi = slow + pad;

    const padL = 52;
    const padR = 16;
    const padT = 12;
    const padB = scrollable ? 40 : 28;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    this.plotGeom = { padL, plotW, h };

    const spanLaps = Math.max(1, endLap - startLap);
    const xOf = (lap: number) =>
      padL + (endLap <= startLap ? plotW / 2 : ((lap - startLap) / spanLaps) * plotW);
    const yOf = (t: number) => padT + ((Math.min(t, hi) - lo) / (hi - lo || 1)) * plotH;
    const decimals = hi - lo < 0.3 ? 3 : hi - lo < 1.5 ? 2 : 1;

    // Grid: 4 time levels, lap numbers along the bottom.
    ctx.font = font(500, 10.5, true);
    for (let i = 0; i <= 3; i++) {
      const t = lo + ((hi - lo) * i) / 3;
      const y = Math.round(yOf(t)) + 0.5;
      ctx.strokeStyle = theme.grid;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.fillStyle = theme.text3;
      ctx.textAlign = "right";
      ctx.fillText(`${t.toFixed(decimals)}s`, padL - 8, y + 3.5);
    }

    const visibleCount = endLap - startLap + 1;
    const step = Math.max(1, Math.ceil(visibleCount / 12));
    const firstTick = Math.ceil(startLap / step) * step;
    ctx.textAlign = "center";
    if (firstTick > startLap) {
      ctx.fillText(String(startLap), xOf(startLap), h - (scrollable ? 21 : 9));
    }
    for (let lap = firstTick; lap <= endLap; lap += step) {
      ctx.fillText(String(lap), xOf(lap), h - (scrollable ? 21 : 9));
    }

    ctx.textAlign = "left";
    ctx.fillStyle = theme.text3;
    ctx.font = font(500, 10.5);
    ctx.fillText("faster ↑", padL + 6, padT + 10);

    if (scrollable) {
      ctx.textAlign = "right";
      ctx.fillStyle = this.endLap !== null ? theme.accent : theme.text3;
      ctx.font = font(500, 10.5);
      const statusText =
        this.endLap !== null
          ? `Laps ${startLap}–${endLap} of ${this.maxLap} · double-click for latest`
          : `Last ${WINDOW_LAPS} laps (${startLap}–${endLap} of ${this.maxLap}) · drag or scroll`;
      ctx.fillText(statusText, w - padR, padT + 10);
      ctx.textAlign = "left";
    }

    // One pilot: mark their best so each lap reads against it.
    if (this.series.length === 1) {
      const best = Math.min(...this.series[0].points.map((p) => p.t));
      const y = Math.round(Math.max(padT, Math.min(padT + plotH, yOf(best)))) + 0.5;
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = withAlpha(theme.good, 0.6);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = theme.good;
      ctx.font = font(600, 10.5);
      ctx.textAlign = "right";
      ctx.fillText(`best ${best.toFixed(3)}s`, w - padR - 4, Math.max(padT + 22, y - 5));
      ctx.textAlign = "left";
    }

    let closestHover: HoveredPoint | null = null;
    let closestDist = HOVER_DOT_HIT_PX;

    for (const s of visibleSeries) {
      const screenPts = s.points.map((p) => ({
        lap: p.lap,
        t: p.t,
        x: xOf(p.lap),
        y: yOf(p.t),
        clipped: p.t > hi,
      }));

      ctx.save();
      ctx.beginPath();
      ctx.rect(padL - 2, padT - 4, plotW + 4, plotH + 8);
      ctx.clip();
      ctx.strokeStyle = s.pilot.color;
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      traceMonotoneSpline(ctx, screenPts);
      ctx.stroke();
      ctx.restore();

      for (const p of screenPts) {
        if (!this.drag && this.hoverPos) {
          const d = Math.hypot(this.hoverPos.x - p.x, this.hoverPos.y - p.y);
          if (d <= closestDist) {
            closestDist = d;
            closestHover = { pilot: s.pilot, ...p };
          }
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.clipped ? 2.2 : 3, 0, Math.PI * 2);
        ctx.fillStyle = p.clipped ? withAlpha(s.pilot.color, 0.45) : s.pilot.color;
        ctx.fill();
      }
    }

    this.hoveredDot = closestHover !== null;

    if (closestHover) {
      this.drawHoverTooltip(ctx, w, padL, padT, plotW, plotH, closestHover);
    }

    // Draw horizontal scrollbar when session exceeds 50 laps.
    if (scrollable) {
      const trackY = h - 10;
      const trackH = 6;
      ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
      ctx.beginPath();
      ctx.roundRect(padL, trackY, plotW, trackH, 3);
      ctx.fill();

      const thumbW = Math.max(24, (WINDOW_LAPS / this.maxLap) * plotW);
      const maxStart = Math.max(1, this.maxLap - WINDOW_LAPS);
      const thumbX = padL + ((startLap - 1) / maxStart) * (plotW - thumbW);
      ctx.fillStyle =
        this.drag?.mode === "thumb" || this.thumbHovered ? theme.accent : "rgba(255, 255, 255, 0.32)";
      ctx.beginPath();
      ctx.roundRect(thumbX, trackY, thumbW, trackH, 3);
      ctx.fill();
    }
  }

  private drawHoverTooltip(
    ctx: CanvasRenderingContext2D,
    w: number,
    padL: number,
    padT: number,
    plotW: number,
    plotH: number,
    hp: HoveredPoint
  ): void {
    // Highlighted ring + enlarged dot
    ctx.save();
    ctx.strokeStyle = withAlpha(hp.pilot.color, 0.35);
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(hp.x, hp.y, 6, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = hp.pilot.color;
    ctx.strokeStyle = theme.surface;
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    ctx.arc(hp.x, hp.y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    const titleText = `${hp.pilot.callsign} · Lap ${hp.lap}`;
    const timeText = `${hp.t.toFixed(3)}s${hp.clipped ? " (clipped)" : ""}`;

    ctx.font = font(600, 11.5);
    const titleW = ctx.measureText(titleText).width;
    ctx.font = font(700, 12.5, true);
    const timeW = ctx.measureText(timeText).width;

    const boxW = Math.max(titleW + 28, timeW + 24);
    const boxH = 44;
    let bx = hp.x - boxW / 2;
    bx = Math.max(padL + 4, Math.min(w - 16 - boxW, bx));
    let by = hp.y - boxH - 12;
    if (by < padT + 4) {
      by = Math.min(padT + plotH - boxH - 4, hp.y + 12);
    }

    ctx.fillStyle = withAlpha(theme.surface, 0.96);
    ctx.strokeStyle = withAlpha(hp.pilot.color, 0.7);
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.roundRect(bx, by, boxW, boxH, 7);
    ctx.fill();
    ctx.stroke();

    // Pilot color dot
    ctx.fillStyle = hp.pilot.color;
    ctx.beginPath();
    ctx.arc(bx + 12, by + 15, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // Pilot + Lap label
    ctx.fillStyle = theme.text2;
    ctx.font = font(600, 11.5);
    ctx.textAlign = "left";
    ctx.fillText(titleText, bx + 20, by + 18.5);

    // Exact lap/section time
    ctx.fillStyle = theme.text;
    ctx.font = font(700, 12.5, true);
    ctx.fillText(timeText, bx + 10, by + 35.5);
    ctx.restore();
  }
}
