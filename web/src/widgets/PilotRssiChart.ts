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

const DBM_MIN = -95;
const DBM_MAX = -20;
const WINDOWS_SEC = [5, 10, 30, 60];
const MIN_WINDOW_US = 1_000_000;
const MAX_WINDOW_US = 60_000_000;
const LEGEND_REFRESH_MS = 150;
/** How close (px) the cursor must be to a pass marker to show its details. */
const MARKER_HIT_PX = 7;
/** Threshold tags: height, and how close (px) to a threshold line counts as grabbing it. */
const TAG_H = 18;
const TAG_GAP = 4;
const LINE_HIT_PX = 5;
/** Room on the right for the threshold tags. */
const TAG_GUTTER = 84;

/** One colour per gate, in course order (only gates share this chart, so pilot colours don't apply). */
const GATE_COLORS = ["#d4ff3a", "#38bdf8", "#f472b6", "#fb923c", "#a78bfa", "#2dd4bf", "#facc15", "#f87171"];

const PAD = { l: 46, r: 16 + TAG_GUTTER, t: 34, b: 26 };

/** A pass the pilot made through a gate: timed, or set aside by the timing rules. */
interface PassMarker {
  ts: number;
  puckId: number;
  counted: boolean;
  title: string;
  detail: string;
}

/** Where a gate's threshold tag was drawn, for hit-testing drags. */
interface TagBox {
  puckId: number;
  x: number;
  y: number;
  w: number;
  lineY: number;
}

/**
 * The selected pilot's 5.8 GHz signal as seen by every gate, and the place to calibrate
 * detection. "All gates" overlays every trace without thresholds, to keep it readable;
 * picking one gate (above the chart, or by clicking its chip below) shows just that trace
 * with its threshold line, which you drag to adjust — or let Auto-calibrate work it out from
 * the recent signal. Also: pause, drag to scroll back (up to two minutes), wheel to zoom, and
 * jump pass to pass — including passes that didn't count.
 */
export class PilotRssiChart extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private windowUs = 5_000_000;
  /** End of the visible window; null follows live. */
  private endUs: number | null = null;
  /** Latest timestamp at the moment of pausing — the zero point of the axis while paused. */
  private refUs = 0;
  private hoverX: number | null = null;
  private hoverY: number | null = null;
  private drag: { x: number; endUs: number } | null = null;
  /** Threshold being dragged, with its live value. */
  private tagDrag: { puckId: number; dbm: number } | null = null;
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
  private get shownPucks() {
    return this.focus === null ? this.store.pucks : this.store.pucks.filter((p) => p.puckId === this.focus);
  }

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;
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
        <div class="segmented scope-windows" data-slot="windows" role="group" aria-label="Time window">
          ${WINDOWS_SEC.map((s) => `<button type="button" data-window="${s}">${s}s</button>`).join("")}
        </div>
      </div>
      <div class="canvas-host canvas-host-md scope-canvas" data-slot="chart" tabindex="0"
           aria-label="Signal chart. Space pauses, arrow keys jump between passes."></div>
      <div class="channel-legend" data-slot="legend"></div>
      <div class="scope-calib" data-slot="calib"></div>`;

    const host = this.slot("chart");
    const surface = new CanvasSurface(host, (ctx, w, h) => this.draw(ctx, w, h));
    this.onDispose(() => surface.destroy());

    this.listen(el, "click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-act], [data-window], [data-calib], [data-focus]");
      if (!btn) return;
      if (btn.dataset.focus) {
        this.focus = btn.dataset.focus === "all" ? null : Number(btn.dataset.focus);
        this.calibMessage = "";
        this.renderControls();
        this.renderCalib();
        this.renderLegend();
      } else if (btn.dataset.window) this.setWindow(Number(btn.dataset.window) * 1e6);
      else if (btn.dataset.calib === "auto") void this.autoCalibrate();
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
    this.listen(host, "pointerdown", (e) => {
      try {
        host.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic / already-released pointers can't be captured; dragging still works.
      }
      const r = host.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const grabbed = this.tagAt(x, y);
      if (grabbed !== null) {
        this.tagDrag = { puckId: grabbed, dbm: this.thresholdOf(grabbed).dbm };
        return;
      }
      const onAxis = y >= r.height - PAD.b && x >= PAD.l && x <= PAD.l + this.plot.w;
      this.drag = { x: e.clientX, endUs: this.viewEnd() };
      host.classList.add("is-dragging");
      if (onAxis) host.classList.add("is-over-axis");
    });
    this.listen(host, "pointermove", (e) => {
      const r = host.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.hoverY = e.clientY - r.top;
      if (this.tagDrag) {
        this.tagDrag.dbm = Math.round(this.dbmAt(this.hoverY));
        return;
      }
      if (!this.drag) {
        const overTag = this.tagAt(this.hoverX, this.hoverY) !== null;
        const overAxis =
          !overTag &&
          this.hoverY >= r.height - PAD.b &&
          this.hoverX >= PAD.l &&
          this.hoverX <= PAD.l + this.plot.w;
        host.classList.toggle("is-over-tag", overTag);
        host.classList.toggle("is-over-axis", overAxis);
        return;
      }
      const dx = e.clientX - this.drag.x;
      if (Math.abs(dx) < 2 && this.endUs === null) return;
      this.pauseAt(this.drag.endUs - (dx / this.plot.w) * this.windowUs);
      this.renderControls();
    });
    const endDrag = () => {
      if (this.tagDrag) {
        const { puckId, dbm } = this.tagDrag;
        this.tagDrag = null;
        if (dbm !== this.thresholdOf(puckId).dbm) void this.saveManual(puckId, dbm);
      }
      this.drag = null;
      host.classList.remove("is-dragging");
    };
    this.listen(host, "pointerup", endDrag);
    this.listen(host, "pointercancel", endDrag);
    this.listen(host, "pointerleave", () => {
      this.hoverX = null;
      this.hoverY = null;
      if (!this.drag) {
        host.classList.remove("is-over-tag", "is-over-axis");
      }
    });
    // Wheel zooms around the cursor; needs a non-passive listener to stop the page scrolling.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      this.zoom(e.deltaY > 0 ? 1.25 : 0.8, e.clientX - host.getBoundingClientRect().left);
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
        this.renderControls();
        this.renderCalib();
      })
    );
    this.onDispose(
      store.subscribe(["config"], () => {
        if (this.focus !== null && !store.puck(this.focus)) this.focus = null;
        this.renderCalib();
      })
    );
    this.renderControls();
    this.renderCalib();
    this.renderLegend();
  }

  // ---- view window -----------------------------------------------------------

  private get latest(): number {
    return this.store.latestTimestampUs;
  }

  private get livePlayhead(): number {
    return this.store.smoothLatestTimestampUs;
  }

  private get earliest(): number {
    const firsts = this.store.pucks.map((p) => this.store.historyFor(p.puckId)[0]?.timestampUs ?? Infinity);
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
    return PAD.t + this.plot.h * (1 - (Math.max(DBM_MIN, Math.min(DBM_MAX, dbm)) - DBM_MIN) / (DBM_MAX - DBM_MIN));
  }

  private dbmAt(y: number): number {
    const v = DBM_MIN + (1 - (y - PAD.t) / this.plot.h) * (DBM_MAX - DBM_MIN);
    return Math.max(DBM_MIN, Math.min(DBM_MAX, v));
  }

  private setWindow(us: number): void {
    const center = this.viewEnd() - this.windowUs / 2;
    this.windowUs = us;
    if (this.endUs !== null) this.endUs = this.clampEnd(center + us / 2);
    this.renderControls();
  }

  private zoom(factor: number, x: number): void {
    const anchor = this.timeAt(x);
    const frac = Math.min(1, Math.max(0, (x - this.plot.x) / this.plot.w));
    const next = Math.min(MAX_WINDOW_US, Math.max(MIN_WINDOW_US, this.windowUs * factor));
    this.windowUs = next;
    // Following live keeps the right edge at "now"; otherwise zoom around the cursor.
    if (this.endUs !== null) this.endUs = this.clampEnd(anchor + (1 - frac) * next);
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
  private thresholdOf(puckId: number): { dbm: number; calibrated: boolean } {
    if (this.tagDrag?.puckId === puckId) return { dbm: this.tagDrag.dbm, calibrated: true };
    const pending = this.pending.get(puckId);
    if (pending !== undefined) return { dbm: pending, calibrated: pending !== 0 };
    return enterThresholdAt(this.store, puckId, this.store.selectedPilot);
  }

  /** Gate whose threshold tag (or line) is under the pointer, if any. Tags win over lines. */
  private tagAt(x: number, y: number): number | null {
    for (const t of this.tags) {
      if (x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + TAG_H) return t.puckId;
    }
    if (x < PAD.l || x > PAD.l + this.plot.w) return null;
    let best: TagBox | null = null;
    for (const t of this.tags) {
      if (Math.abs(y - t.lineY) <= LINE_HIT_PX && (!best || Math.abs(y - t.lineY) < Math.abs(y - best.lineY))) best = t;
    }
    return best?.puckId ?? null;
  }

  /** Raw stored overrides for this pilot (0 = pilot default), for undo. */
  private currentOverrides(): GateThresholdUpdate[] {
    const slotIndex = this.store.selectedPilot;
    const pos = this.store.pilots.findIndex((p) => p.slotIndex === slotIndex);
    return this.store.pucks.map((p) => ({ puckId: p.puckId, slotIndex, enterDbm: p.enterThresholds?.[pos] ?? 0 }));
  }

  private async apply(updates: GateThresholdUpdate[], message: string): Promise<void> {
    const before = this.currentOverrides().filter((o) => updates.some((u) => u.puckId === o.puckId));
    updates.forEach((u) => this.pending.set(u.puckId, u.enterDbm === 0 ? this.pilotDefault() : u.enterDbm));
    try {
      await this.api.setGateThresholds(updates);
      this.undo = before;
      this.calibMessage = message;
    } catch {
      this.calibMessage = "Couldn't save the thresholds — is the timer still running?";
    } finally {
      updates.forEach((u) => this.pending.delete(u.puckId));
      this.renderCalib();
    }
  }

  private pilotDefault(): number {
    return this.store.pilot(this.store.selectedPilot)?.enterThreshold ?? -58;
  }

  private saveManual(puckId: number, dbm: number): Promise<void> {
    return this.apply(
      [{ puckId, slotIndex: this.store.selectedPilot, enterDbm: dbm }],
      `${gateLabel(this.store, puckId)} set to ${dbm} dBm.`
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
    for (const puck of this.shownPucks) {
      const result = suggestThreshold(this.store.historyFor(puck.puckId), pos);
      const name = gateLabel(this.store, puck.puckId);
      if (result.ok) {
        updates.push({ puckId: puck.puckId, slotIndex: pilot.slotIndex, enterDbm: result.enterDbm });
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
        ? `Every gate is back on ${who}'s own threshold (${this.pilotDefault()} dBm).`
        : `${gateLabel(this.store, this.focus)} is back on ${who}'s own threshold (${this.pilotDefault()} dBm).`;
    return this.apply(
      this.shownPucks.map((p) => ({ puckId: p.puckId, slotIndex, enterDbm: 0 })),
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

  private colorOf(puckId: number): string {
    return gateColor(this.store, puckId);
  }

  /** This pilot's passes in [from, to], oldest first. */
  private passes(from: number, to: number): PassMarker[] {
    const slot = this.store.selectedPilot;
    const timed: PassMarker[] = this.store.crossings
      .filter((c) => c.slotIndex === slot && c.timestampUs >= from && c.timestampUs <= to)
      .map((c) => ({
        ts: c.timestampUs,
        puckId: c.puckId,
        counted: true,
        title: `${gateLabel(this.store, c.puckId)} · ${c.estimatedSpeedMph.toFixed(0)} mph`,
        detail: `Timed · peak ${c.peakRssiDbm.toFixed(0)} dBm`,
      }));
    const rejected: PassMarker[] = this.store.filtered
      .filter((f) => f.slotIndex === slot && f.timestampUs >= from && f.timestampUs <= to)
      .map((f) => ({
        ts: f.timestampUs,
        puckId: f.puckId,
        counted: false,
        title: `${gateLabel(this.store, f.puckId)} · not counted (${FILTER_LABELS[f.reason]})`,
        detail: f.detail,
      }));
    return [...timed, ...rejected].sort((a, b) => a.ts - b.ts);
  }

  /** Passes filtered to the currently focused gate (or all gates when focus is null). */
  private focusedPasses(from: number, to: number): PassMarker[] {
    const all = this.passes(from, to);
    return this.focus === null ? all : all.filter((p) => p.puckId === this.focus);
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

  private rssiAt(puckId: number, slot: number, ts: number): number | undefined {
    const frames = this.store.historyFor(puckId);
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
    const start = end - this.windowUs;
    const xOf = (ts: number) => PAD.l + plotW * ((ts - start) / this.windowUs);
    const yOf = (dbm: number) => this.yOf(dbm);

    this.drawGrid(ctx, w, h, start, end, xOf, yOf);

    if (this.latest > 0) {
      // Traces, decimated to roughly one point per pixel when zoomed out.
      ctx.save();
      ctx.beginPath();
      ctx.rect(PAD.l, PAD.t - 4, plotW, plotH + 8);
      ctx.clip();
      ctx.lineJoin = "round";
      ctx.lineWidth = 1.6;
      for (const puck of this.shownPucks) {
        const frames = this.store.historyFor(puck.puckId);
        const from = Math.max(0, PilotRssiChart.firstAtOrAfter(frames, start) - 1);
        const to = Math.min(frames.length - 1, PilotRssiChart.firstAtOrAfter(frames, end));
        if (to - from < 1) continue;
        const step = Math.max(1, Math.floor((to - from) / plotW));
        ctx.strokeStyle = this.colorOf(puck.puckId);
        ctx.beginPath();
        // Start on a multiple of the step so the same samples are drawn as the view scrolls
        // (otherwise zoomed-out traces shimmer).
        const first = Math.max(0, from - (from % step));
        let lastX = PAD.l;
        let lastY = PAD.t;
        let lastTs = 0;
        for (let i = first; i <= to; i += step) {
          const x = xOf(frames[i].timestampUs);
          const y = yOf(frames[i].rssi[slot] ?? DBM_MIN);
          if (i === first) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
          lastX = x;
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

    if (this.focus !== null) this.drawThresholds(ctx, w, plotW);
    if (this.latest === 0) return;

    // Pass markers: dashed in the gate's colour when timed, red when set aside.
    ctx.font = font(600, 10.5);
    const rows = this.labelRows(ctx, xOf, end);
    const passes = this.focusedPasses(start, end);
    let hovered: PassMarker | null = null;
    passes.forEach((p) => {
      const x = xOf(p.ts);
      const color = p.counted ? this.colorOf(p.puckId) : theme.bad;
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

    if (!this.tagDrag && this.hoverX !== null && this.hoverX >= PAD.l && this.hoverX <= PAD.l + plotW) {
      this.drawCursor(ctx, h, plotH, this.hoverX, hovered);
    }
  }

  /**
   * One threshold line per gate, in the gate's colour, with a draggable tag at the right
   * edge. Tags that would overlap are moved into extra columns to the left. Outlined tags
   * use the pilot's own threshold; filled tags are calibrated for that gate.
   */
  private drawThresholds(ctx: CanvasRenderingContext2D, w: number, plotW: number): void {
    ctx.font = font(700, 10.5);
    const items = this.shownPucks.map((p) => {
      const t = this.thresholdOf(p.puckId);
      const name = gateLabel(this.store, p.puckId);
      const text = `${name.length > 8 ? `${name.slice(0, 7)}…` : name} ${t.dbm.toFixed(0)}`;
      return { puckId: p.puckId, ...t, text, lineY: this.yOf(t.dbm), width: ctx.measureText(text).width + 14 };
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
      placed.push({ puckId: item.puckId, x: w - 16 - item.width - col * colW, y: top, w: item.width, lineY: item.lineY });
    }
    this.tags = placed;

    const active = this.tagDrag?.puckId ?? (this.hoverX !== null && this.hoverY !== null ? this.tagAt(this.hoverX, this.hoverY) : null);
    for (const item of items) {
      const color = this.colorOf(item.puckId);
      const box = placed.find((b) => b.puckId === item.puckId)!;
      const isActive = active === item.puckId;
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
    return `${p.ts}:${p.puckId}:${p.counted ? 1 : 0}`;
  }

  private drawGrid(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    start: number,
    end: number,
    xOf: (ts: number) => number,
    yOf: (dbm: number) => number
  ): void {
    ctx.font = font(500, 10.5, true);
    ctx.lineWidth = 1;
    for (const level of [-90, -75, -60, -45, -30]) {
      const y = Math.round(yOf(level)) + 0.5;
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
    const ref = this.ref;
    const stepSec = this.windowUs <= 6e6 ? 1 : this.windowUs <= 12e6 ? 2 : this.windowUs <= 35e6 ? 5 : 10;
    const stepUs = stepSec * 1e6;
    ctx.textAlign = "center";
    ctx.fillStyle = theme.text3;
    for (let t = ref - Math.floor((ref - start) / stepUs) * stepUs; t <= end + 1; t += stepUs) {
      const ago = Math.round((ref - t) / 1e6);
      ctx.fillText(ago === 0 ? (this.endUs === null ? "now" : "paused") : `−${ago}s`, xOf(t), h - 8);
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

    const gateScope = this.focus === null ? "all gates" : gateLabel(this.store, this.focus);
    const prevBtn = this.el.querySelector<HTMLButtonElement>('[data-act="prev"]');
    const nextBtn = this.el.querySelector<HTMLButtonElement>('[data-act="next"]');
    if (prevBtn) prevBtn.title = `Previous pass at ${gateScope} (←)`;
    if (nextBtn) nextBtn.title = `Next pass at ${gateScope} (→)`;

    this.slot("windows")
      .querySelectorAll<HTMLElement>("[data-window]")
      .forEach((b) => b.classList.toggle("is-active", Number(b.dataset.window) * 1e6 === Math.round(this.windowUs)));
    this.slot("hint").textContent = live ? "Live · drag to scroll back, wheel to zoom" : "Paused · drag to scroll, wheel to zoom";
  }

  /** The calibration row: what the tags mean, Auto-calibrate, Reset, and the last result with Undo. */
  private renderCalib(): void {
    const pilot = this.store.pilot(this.store.selectedPilot);
    if (!pilot) return;
    const minutes = Math.round(HISTORY_SECONDS / 60);

    let text: string;
    let actions: string;
    if (this.focus === null) {
      const anyCalibrated = this.store.pucks.some((p) => enterThresholdAt(this.store, p.puckId, pilot.slotIndex).calibrated);
      text = this.calibMessage || "Select a gate above to view or drag its threshold, or auto-calibrate all gates.";
      actions = `
        <div class="scope-calib-actions">
          ${this.undo ? `<button class="btn btn-sm btn-ghost" type="button" data-calib="undo">${icons.reset(15)}<span>Undo</span></button>` : ""}
          ${anyCalibrated ? `<button class="btn btn-sm btn-ghost" type="button" data-calib="reset" title="Use ${esc(pilot.callsign)}'s own threshold at every gate">${icons.reset(15)}<span>Reset all</span></button>` : ""}
          <button class="btn btn-sm btn-ghost" type="button" data-calib="auto" title="Set each gate's threshold from the last ${minutes} minutes of signal">${icons.target(16)}<span>Auto-calibrate all</span></button>
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

  /** Each gate's reading at the cursor (or at the right edge of the view), plus the "All gates" option. */
  private renderLegend(): void {
    const pilot = this.store.pilot(this.store.selectedPilot);
    if (!pilot) return;
    const slot = this.store.pilots.indexOf(pilot);
    const at = this.hoverX !== null && this.hoverX >= this.plot.x && this.hoverX <= this.plot.x + this.plot.w ? this.timeAt(this.hoverX) : this.viewEnd();
    const allChip = `
      <button type="button" class="channel channel-all ${this.focus === null ? "is-focus" : "is-dim"}"
              data-focus="all" title="Show all gates (${this.store.pucks.length})">
        <span class="dot channel-all-dot"></span>
        <span class="channel-name">All gates</span>
        <span class="channel-dbm mono">${this.store.pucks.length} gates</span>
      </button>`;
    const gateChips = this.store.pucks
      .map((p) => {
        const dbm = this.rssiAt(p.puckId, slot, at) ?? DBM_MIN;
        const hot = dbm >= this.thresholdOf(p.puckId).dbm;
        const dim = this.focus !== null && this.focus !== p.puckId;
        return `
          <button type="button" class="channel ${hot ? "is-hot" : ""} ${dim ? "is-dim" : ""} ${this.focus === p.puckId ? "is-focus" : ""}"
                  data-focus="${this.focus === p.puckId ? "all" : p.puckId}" title="${this.focus === p.puckId ? "Show all gates" : "Show only this gate"}">
            <span class="dot" style="--c:${this.colorOf(p.puckId)}"></span>
            <span class="channel-name">${esc(gateLabel(this.store, p.puckId))}</span>
            <span class="channel-dbm mono">${dbm.toFixed(0)} dBm</span>
          </button>`;
      })
      .join("");
    this.slot("legend").innerHTML = allChip + gateChips;
  }
}
