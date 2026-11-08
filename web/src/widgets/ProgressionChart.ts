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
  /** Session timestamp in seconds when the lap was completed. */
  atSec: number;
  /** Full lap duration in seconds, used to detect gaps between flight stints. */
  lapTimeSec: number;
  /** Plotted metric in seconds (whole lap or section split). */
  t: number;
}

interface Series {
  pilot: PilotSlot;
  points: Point[];
}

/** Clip crash / pause laps so normal laps keep their resolution. */
const OUTLIER_FACTOR = 1.35;
/** Maximum session time window (in seconds) shown in the viewport at one time on desktop (8 minutes) vs mobile (3 minutes). */
const WINDOW_SEC_DESKTOP = 480;
const WINDOW_SEC_MOBILE = 180;
/** Maximum pixel distance from a plotted dot to trigger the hover tooltip. */
const HOVER_DOT_HIT_PX = 16;

function fmtSessionClock(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

function chooseTimeTickStep(spanSec: number): number {
  const candidates = [5, 10, 15, 30, 60, 120, 180, 300, 600];
  for (const step of candidates) {
    if (spanSec / step <= 10) return step;
  }
  return 600;
}

interface HoveredPoint {
  pilot: PilotSlot;
  lap: number;
  atSec: number;
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

/** Every pilot's lap (or section) times across the session timeline. Lower is faster. */
export class ProgressionChart extends Component {
  private readonly store: AppStore;
  private readonly surface: CanvasSurface;
  /** When set, only this pilot is plotted (re-evaluated on refresh). */
  private readonly slotIndex: (() => number) | undefined;
  private hiddenSlots = new Set<number>();
  private metric: ProgressionMetric = { kind: "lap" };
  private series: Series[] = [];
  private minTimeSec = 0;
  private maxTimeSec = 0;
  /** Rightmost visible session time (sec); null follows the most recent lap automatically. */
  private endTimeSec: number | null = null;
  private drag: { startX: number; startEndSec: number; mode: "pan" | "thumb" } | null = null;
  private thumbHovered = false;
  private hoverPos: { x: number; y: number } | null = null;
  private hoveredDot = false;
  private plotGeom = { padL: 52, plotW: 1, h: 1, w: 600 };

  private windowSec(): number {
    return this.plotGeom.w > 0 && this.plotGeom.w <= 560 ? WINDOW_SEC_MOBILE : WINDOW_SEC_DESKTOP;
  }

  constructor(el: HTMLElement, store: AppStore, opts: { slotIndex?: () => number } = {}) {
    super(el);
    this.store = store;
    this.slotIndex = opts.slotIndex;
    this.surface = new CanvasSurface(el, (ctx, w, h) => this.draw(ctx, w, h));
    this.onDispose(() => this.surface.destroy());

    this.listen(el, "pointerdown", (e) => {
      const winSec = this.windowSec();
      const totalSpan = this.maxTimeSec - this.minTimeSec;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      this.hoverPos = { x, y };
      if ((e.pointerType === "mouse" && e.button !== 0) || totalSpan <= winSec) return;
      const effectiveEnd = this.effectiveEndTimeSec();
      const onScrollbar =
        y >= this.plotGeom.h - 24 &&
        x >= this.plotGeom.padL &&
        x <= this.plotGeom.padL + this.plotGeom.plotW;
      if (onScrollbar) {
        const plotW = Math.max(1, this.plotGeom.plotW);
        const thumbW = Math.max(28, (winSec / totalSpan) * plotW);
        const maxStart = Math.max(1, totalSpan - winSec);
        const startSec = Math.max(this.minTimeSec, effectiveEnd - winSec);
        const thumbX =
          this.plotGeom.padL + ((startSec - this.minTimeSec) / maxStart) * (plotW - thumbW);
        // Clicking the track outside the thumb jumps the thumb to that position first.
        if (x < thumbX || x > thumbX + thumbW) {
          const ratio = Math.max(
            0,
            Math.min(1, (x - this.plotGeom.padL - thumbW / 2) / Math.max(1, plotW - thumbW))
          );
          const jumpedEnd = this.minTimeSec + winSec + ratio * (totalSpan - winSec);
          this.setEndTimeSec(jumpedEnd);
        }
        this.drag = { startX: e.clientX, startEndSec: this.effectiveEndTimeSec(), mode: "thumb" };
      } else {
        this.drag = { startX: e.clientX, startEndSec: effectiveEnd, mode: "pan" };
      }
      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
    });

    this.listen(el, "pointermove", (e) => {
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      this.hoverPos = { x, y };
      const winSec = this.windowSec();
      const totalSpan = this.maxTimeSec - this.minTimeSec;
      if (!this.drag) {
        if (totalSpan > winSec) {
          const overTrack =
            y >= this.plotGeom.h - 24 &&
            x >= this.plotGeom.padL &&
            x <= this.plotGeom.padL + this.plotGeom.plotW;
          let overThumb = false;
          if (overTrack) {
            const plotW = Math.max(1, this.plotGeom.plotW);
            const thumbW = Math.max(28, (winSec / totalSpan) * plotW);
            const maxStart = Math.max(1, totalSpan - winSec);
            const startSec = Math.max(this.minTimeSec, this.effectiveEndTimeSec() - winSec);
            const thumbX =
              this.plotGeom.padL + ((startSec - this.minTimeSec) / maxStart) * (plotW - thumbW);
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
        const thumbW = Math.max(28, (winSec / totalSpan) * plotW);
        const travel = Math.max(1, plotW - thumbW);
        const deltaSec = (dx / travel) * (totalSpan - winSec);
        nextEnd = this.drag.startEndSec + deltaSec;
      } else {
        const deltaSec = -(dx / plotW) * winSec;
        nextEnd = this.drag.startEndSec + deltaSec;
      }
      this.setEndTimeSec(nextEnd);
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
      el.style.cursor = this.maxTimeSec - this.minTimeSec > this.windowSec() ? "grab" : "";
    };
    this.listen(el, "pointerup", endDrag);
    this.listen(el, "pointercancel", endDrag);

    this.listen(
      el,
      "wheel",
      (e) => {
        const winSec = this.windowSec();
        if (this.maxTimeSec - this.minTimeSec <= winSec) return;
        e.preventDefault();
        const rawDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (rawDelta === 0) return;
        const step = Math.sign(rawDelta) * Math.max(15, Math.round(winSec * 0.1));
        this.setEndTimeSec(this.effectiveEndTimeSec() + step);
      },
      { passive: false }
    );

    this.listen(el, "dblclick", () => {
      if (this.endTimeSec !== null) {
        this.endTimeSec = null;
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

  public setHiddenSlots(hidden: ReadonlySet<number>): void {
    this.hiddenSlots = new Set(hidden);
    this.refresh();
  }

  private effectiveEndTimeSec(): number {
    const winSec = this.windowSec();
    const totalSpan = this.maxTimeSec - this.minTimeSec;
    if (totalSpan <= winSec || this.endTimeSec === null) {
      return this.maxTimeSec;
    }
    return Math.min(this.maxTimeSec, Math.max(this.minTimeSec + winSec, this.endTimeSec));
  }

  private setEndTimeSec(next: number): void {
    const winSec = this.windowSec();
    const clamped = Math.min(this.maxTimeSec, Math.max(this.minTimeSec + winSec, next));
    this.endTimeSec = clamped >= this.maxTimeSec - 2.0 ? null : clamped;
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
    let fallbackSec = 0;
    this.series = this.store.enabledPilots
      .filter(
        (pilot) =>
          (only === undefined || pilot.slotIndex === only) &&
          (only !== undefined || !this.hiddenSlots.has(pilot.slotIndex))
      )
      .map((pilot) => {
        fallbackSec = 0;
        return {
          pilot,
          points: lapsFor(this.store, pilot.slotIndex).flatMap((lap, i) => {
            fallbackSec += lap.lapTimeSec;
            const t = this.valueOf(lap);
            const atSec =
              lap.completedAtUs && lap.completedAtUs > 0
                ? lap.completedAtUs / 1_000_000
                : fallbackSec;
            return t !== undefined && t > 0
              ? [{ lap: lap.lapNumber || i + 1, atSec, lapTimeSec: lap.lapTimeSec, t }]
              : [];
          }),
        };
      })
      .filter((s) => s.points.length > 0);

    const allAtSec = this.series.flatMap((s) => s.points.map((p) => p.atSec));
    if (allAtSec.length > 0) {
      const rawMin = Math.min(...allAtSec);
      this.minTimeSec = rawMin < 45 ? 0 : Math.floor(rawMin / 15) * 15;
      this.maxTimeSec = Math.max(...allAtSec);
    } else {
      this.minTimeSec = 0;
      this.maxTimeSec = 0;
    }
    if (this.maxTimeSec - this.minTimeSec <= this.windowSec()) {
      this.endTimeSec = null;
    }
  }

  private draw(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.plotGeom.w = w;
    if (this.series.length === 0) {
      ctx.fillStyle = theme.text3;
      ctx.font = font(500, 12);
      ctx.textAlign = "center";
      const anyLapsExist =
        this.slotIndex === undefined &&
        this.hiddenSlots.size > 0 &&
        this.store.enabledPilots.some((p) => lapsFor(this.store, p.slotIndex).length > 0);
      ctx.fillText(
        anyLapsExist
          ? "All pilots hidden — click a pilot in the legend below to plot their laps"
          : this.metric.kind === "lap"
          ? "Lap times appear here as pilots complete laps"
          : "No times for this section yet",
        w / 2,
        h / 2
      );
      ctx.textAlign = "left";
      return;
    }

    const winSec = this.windowSec();
    const totalSpan = this.maxTimeSec - this.minTimeSec;
    const scrollable = totalSpan > winSec;
    const endSec = this.effectiveEndTimeSec();
    const startSec = scrollable ? Math.max(this.minTimeSec, endSec - winSec) : this.minTimeSec;

    const visibleSeries = this.series
      .map((s) => ({
        pilot: s.pilot,
        points: s.points.filter((p) => p.atSec >= startSec - 30 && p.atSec <= endSec + 30),
      }))
      .filter((s) => s.points.length > 0);

    const allSessionTimes = this.series.flatMap((s) => s.points.map((p) => p.t));
    const inWindowTimes = this.series.flatMap((s) =>
      s.points.filter((p) => p.atSec >= startSec && p.atSec <= endSec).map((p) => p.t)
    );
    const scaleTimes = inWindowTimes.length > 0 ? inWindowTimes : allSessionTimes;

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
    this.plotGeom = { padL, plotW, h, w };

    const spanSec = Math.max(10, endSec - startSec);
    const xOf = (atSec: number) =>
      padL + (endSec <= startSec ? plotW / 2 : ((atSec - startSec) / spanSec) * plotW);
    const yOf = (t: number) => padT + ((Math.min(t, hi) - lo) / (hi - lo || 1)) * plotH;
    const decimals = hi - lo < 0.3 ? 3 : hi - lo < 1.5 ? 2 : 1;

    // Grid: 4 time levels, session clock timestamps along the bottom.
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

    const tickStep = chooseTimeTickStep(spanSec);
    const firstTick = Math.ceil(startSec / tickStep) * tickStep;
    ctx.textAlign = "center";
    ctx.fillStyle = theme.text3;
    for (let tSec = firstTick; tSec <= endSec; tSec += tickStep) {
      const x = xOf(tSec);
      if (x >= padL + 14 && x <= w - padR - 14) {
        ctx.fillText(fmtSessionClock(tSec), x, h - (scrollable ? 21 : 9));
      }
    }

    ctx.textAlign = "left";
    ctx.fillStyle = theme.text3;
    ctx.font = font(500, 10.5);
    ctx.fillText("faster ↑", padL + 6, padT + 10);

    if (scrollable) {
      ctx.textAlign = "right";
      ctx.fillStyle = this.endTimeSec !== null ? theme.accent : theme.text3;
      ctx.font = font(500, 10.5);
      const winMin = Math.round(winSec / 60);
      const statusText =
        this.endTimeSec !== null
          ? `${fmtSessionClock(startSec)}–${fmtSessionClock(endSec)} of ${fmtSessionClock(this.maxTimeSec)} · double-tap for latest`
          : `Last ${winMin}m (${fmtSessionClock(startSec)}–${fmtSessionClock(endSec)}) · swipe or scroll`;
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
        atSec: p.atSec,
        lapTimeSec: p.lapTimeSec,
        t: p.t,
        x: xOf(p.atSec),
        y: yOf(p.t),
        clipped: p.t > hi,
      }));

      // Split into contiguous flight stints so pit stops, breaks, and crash recoveries show a real gap
      const stints: Array<typeof screenPts> = [];
      for (const pt of screenPts) {
        const currentStint = stints[stints.length - 1];
        if (!currentStint || currentStint.length === 0) {
          stints.push([pt]);
          continue;
        }
        const prev = currentStint[currentStint.length - 1];
        const gapSec = pt.atSec - prev.atSec;
        const maxContinuousGap = Math.max(22, pt.lapTimeSec * 1.65);
        if (gapSec > maxContinuousGap) {
          stints.push([pt]);
        } else {
          currentStint.push(pt);
        }
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(padL - 2, padT - 4, plotW + 4, plotH + 8);
      ctx.clip();
      ctx.strokeStyle = s.pilot.color;
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const stint of stints) {
        if (stint.length < 2) continue;
        ctx.beginPath();
        traceMonotoneSpline(ctx, stint);
        ctx.stroke();
      }
      ctx.restore();

      for (const p of screenPts) {
        if (p.x < padL - 2 || p.x > padL + plotW + 2) continue;
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

    // Draw horizontal scrollbar when session exceeds winSec.
    if (scrollable) {
      const trackY = h - 10;
      const trackH = 6;
      ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
      ctx.beginPath();
      ctx.roundRect(padL, trackY, plotW, trackH, 3);
      ctx.fill();

      const thumbW = Math.max(28, (winSec / totalSpan) * plotW);
      const maxStart = Math.max(1, totalSpan - winSec);
      const thumbX = padL + ((startSec - this.minTimeSec) / maxStart) * (plotW - thumbW);
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

    const titleText = `${hp.pilot.callsign} · Lap ${hp.lap} (${fmtSessionClock(hp.atSec)})`;
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
