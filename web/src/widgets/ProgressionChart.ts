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

/** Every pilot's lap (or section) times across the session, lap by lap. Lower is faster. */
export class ProgressionChart extends Component {
  private readonly store: AppStore;
  private readonly surface: CanvasSurface;
  /** When set, only this pilot is plotted (re-evaluated on refresh). */
  private readonly slotIndex: (() => number) | undefined;
  private metric: ProgressionMetric = { kind: "lap" };
  private series: Series[] = [];

  constructor(el: HTMLElement, store: AppStore, opts: { slotIndex?: () => number } = {}) {
    super(el);
    this.store = store;
    this.slotIndex = opts.slotIndex;
    this.surface = new CanvasSurface(el, (ctx, w, h) => this.draw(ctx, w, h));
    this.onDispose(() => this.surface.destroy());
    this.onDispose(store.subscribe(["laps", "config", "selection"], () => this.refresh()));
    this.refresh();
  }

  public setMetric(metric: ProgressionMetric): void {
    this.metric = metric;
    this.refresh();
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

    const all = this.series.flatMap((s) => s.points.map((p) => p.t));
    // Fit the axis to the spread of the times (not a % of the lap), so small differences show.
    const fast = Math.min(...all);
    const slow = Math.min(Math.max(...all), median(all) * OUTLIER_FACTOR);
    const pad = Math.max(0.02, (slow - fast) * 0.12);
    const lo = fast - pad;
    const hi = slow + pad;
    const maxLap = Math.max(...this.series.flatMap((s) => s.points.map((p) => p.lap)));
    const padL = 52;
    const padR = 16;
    const padT = 12;
    const padB = 28;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const xOf = (lap: number) => padL + (maxLap <= 1 ? plotW / 2 : ((lap - 1) / (maxLap - 1)) * plotW);
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
    const step = Math.max(1, Math.ceil(maxLap / 12));
    ctx.textAlign = "center";
    for (let lap = 1; lap <= maxLap; lap += step) {
      ctx.fillText(String(lap), xOf(lap), h - 9);
    }
    ctx.textAlign = "left";
    ctx.fillStyle = theme.text3;
    ctx.font = font(500, 10.5);
    ctx.fillText("faster ↑", padL + 6, padT + 10);

    // One pilot: mark their best so each lap reads against it.
    if (this.series.length === 1) {
      const best = Math.min(...this.series[0].points.map((p) => p.t));
      const y = Math.round(yOf(best)) + 0.5;
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
      ctx.fillText(`best ${best.toFixed(3)}s`, w - padR - 4, y - 5);
      ctx.textAlign = "left";
    }

    for (const s of this.series) {
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
  }
}
