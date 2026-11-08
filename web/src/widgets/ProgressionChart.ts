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
      const y = e.clientY - rect.top;
      const effectiveEnd = this.effectiveEndLap();
      const mode = y >= this.plotGeom.h - 18 ? "thumb" : "pan";
      this.drag = { startX: e.clientX, startEndLap: effectiveEnd, mode };
      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
    });

    this.listen(el, "pointermove", (e) => {
      if (!this.drag) {
        if (this.maxLap > WINDOW_LAPS) {
          el.style.cursor = "grab";
        } else {
          el.style.cursor = "";
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
        this.surface.invalidate();
      }
    });

    this.onDispose(
      store.subscribe(["laps", "config", "selection"], () => {
        this.refresh();
        this.surface.invalidate();
      })
    );
    this.refresh();
  }

  public setMetric(metric: ProgressionMetric): void {
    this.metric = metric;
    this.refresh();
    this.surface.invalidate();
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
    this.surface.invalidate();
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

    for (const s of visibleSeries) {
      ctx.strokeStyle = s.pilot.color;
      ctx.lineWidth = 1.75;
      ctx.lineJoin = "round";
      ctx.beginPath();
      s.points.forEach((p, i) => (i === 0 ? ctx.moveTo(xOf(p.lap), yOf(p.t)) : ctx.lineTo(xOf(p.lap), yOf(p.t))));
      ctx.stroke();
      for (const p of s.points) {
        ctx.beginPath();
        ctx.arc(xOf(p.lap), yOf(p.t), p.t > hi ? 2 : 2.5, 0, Math.PI * 2);
        ctx.fillStyle = p.t > hi ? withAlpha(s.pilot.color, 0.4) : s.pilot.color;
        ctx.fill();
      }
    }

    // Draw horizontal scrollbar when session exceeds 50 laps.
    if (scrollable) {
      const trackY = h - 10;
      const trackH = 5;
      ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
      ctx.beginPath();
      ctx.roundRect(padL, trackY, plotW, trackH, 3);
      ctx.fill();

      const thumbW = Math.max(24, (WINDOW_LAPS / this.maxLap) * plotW);
      const maxStart = Math.max(1, this.maxLap - WINDOW_LAPS);
      const thumbX = padL + ((startLap - 1) / maxStart) * (plotW - thumbW);
      ctx.fillStyle = this.drag ? theme.accent : "rgba(255, 255, 255, 0.32)";
      ctx.beginPath();
      ctx.roundRect(thumbX, trackY, thumbW, trackH, 3);
      ctx.fill();
    }
  }
}
