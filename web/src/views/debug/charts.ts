/**
 * Canvas chart helpers and data structures for the Debug page (#/debug).
 *
 * Implements:
 * - Signal over time (50 Hz live stream ring buffer, floor + threshold overlays, hover)
 * - Per-channel noise statistics (matches firmware/tools/noise_stats.py)
 * - Spectrum scan canvas (live trace, running average, max-hold, Wi-Fi + Raceband overlay, top 5 peaks)
 * - Waterfall spectrogram (scrolling offscreen ImageData buffer, perceptual palette)
 * - Health sparklines (sweep duration vs budget, free heap, frames/s to laptop, live rate & drops)
 * - CSV and PNG export helpers
 */
import { LiveSample, ScanResult, TimerStatus } from "../../services/timer_console";

export const RACEBAND = [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917];
export const DBM_MIN = -100;
export const DBM_MAX = -30;

/** Distinct channel colors (matching the pilot slot palette in the main app). */
export const CHANNEL_COLORS = [
  "#ef4444", // Ch 1 - Red
  "#3b82f6", // Ch 2 - Blue
  "#10b981", // Ch 3 - Emerald
  "#f59e0b", // Ch 4 - Amber
  "#a855f7", // Ch 5 - Purple
  "#06b6d4", // Ch 6 - Cyan
  "#ec4899", // Ch 7 - Pink
  "#84cc16", // Ch 8 - Lime
];

/** 5 GHz Wi-Fi UNII bands overlapping 5180–5917 MHz (§5.5). */
export interface WifiBandBlock {
  label: string;
  channels: string;
  startMHz: number;
  stopMHz: number;
  warnsRaceband?: boolean;
}

export const WIFI_BAND_BLOCKS: WifiBandBlock[] = [
  { label: "UNII-1/2", channels: "ch 36–64", startMHz: 5170, stopMHz: 5330 },
  { label: "UNII-2e", channels: "ch 100–144", startMHz: 5490, stopMHz: 5730 },
  { label: "UNII-3", channels: "ch 149–165", startMHz: 5735, stopMHz: 5835, warnsRaceband: true },
];

/** Pilot threshold info fetched from `/api/state`. */
export interface PilotThresholdInfo {
  slotIndex: number;
  callsign: string;
  frequencyMhz: number;
  enterThreshold: number;
  exitThreshold: number;
  color: string;
  enabled: boolean;
}

export interface ThemeTokens {
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  borderStrong: string;
  text: string;
  text2: string;
  text3: string;
  accent: string;
  good: string;
  warn: string;
  bad: string;
  fontMono: string;
  fontSans: string;
}

let cachedTokens: ThemeTokens | null = null;

export function getThemeTokens(): ThemeTokens {
  if (cachedTokens) return cachedTokens;
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  cachedTokens = {
    bg: v("--bg", "#0b0c0f"),
    surface: v("--surface", "#111317"),
    surface2: v("--surface-2", "#15181d"),
    border: v("--border", "#22252c"),
    borderStrong: v("--border-strong", "#2d3139"),
    text: v("--text", "#ecedef"),
    text2: v("--text-2", "#a3a8b3"),
    text3: v("--text-3", "#6c7280"),
    accent: v("--accent", "#d4ff3a"),
    good: v("--good", "#34d399"),
    warn: v("--warn", "#fbbf24"),
    bad: v("--bad", "#f87171"),
    fontMono: v("--font-mono", "monospace"),
    fontSans: v("--font-sans", "sans-serif"),
  };
  return cachedTokens;
}

export function racebandName(f: number): string {
  const i = RACEBAND.indexOf(f);
  return i >= 0 ? `R${i + 1}` : "";
}

/** Resize a canvas to match its CSS box and devicePixelRatio; returns 2D context in CSS pixels. */
export function prepareCanvas(
  canvas: HTMLCanvasElement,
  cssHeight: number
): { ctx: CanvasRenderingContext2D; width: number; height: number; dpr: number } {
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(240, Math.round(rect.width || canvas.clientWidth || 720));
  const height = cssHeight;
  const targetW = Math.round(width * dpr);
  const targetH = Math.round(height * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height, dpr };
}

// ============================================================================
// 5.1 Signal over time & 5.2 Per-channel noise table
// ============================================================================

export interface SignalPoint {
  /** Sweep counter `n` from firmware (50 Hz), or synthesized monotonically if missing. */
  n: number;
  /** Sweep duration in microseconds. */
  us: number;
  /** Received wall-clock timestamp (performance.now()). */
  tMs: number;
  dbm: number[];
  floor: number[];
  hits: number[];
}

export interface ChannelNoiseRow {
  index: number;
  freqMHz: number;
  bandLabel: string;
  pilotCallsign: string;
  enterThreshold: number;
  samples: number;
  mean: number | null;
  sd: number | null;
  max: number | null;
  floor: number | null;
  hitsPerSec: number;
  pctAboveFloor10: number;
  pctWouldTrigger: number;
  wouldTriggerPerSec: number;
}

export interface SignalStatsSummary {
  rows: ChannelNoiseRow[];
  durationSec: number;
  totalSamples: number;
  droppedLines: number;
  rateHz: number;
}

const MAX_SIGNAL_POINTS = 6000; // 2 min at 50 Hz

export class SignalRingBuffer {
  public points: SignalPoint[] = [];
  public droppedLines = 0;
  private synthN = 0;

  public clear(): void {
    this.points = [];
    this.droppedLines = 0;
    this.synthN = 0;
  }

  public push(sample: LiveSample, sweepHz = 50, liveMode: 1 | 2 = 2): void {
    const now = performance.now();
    const prev = this.points.length ? this.points[this.points.length - 1] : null;
    const expectedStep = liveMode === 2 ? 1 : Math.max(1, Math.round(sweepHz / 10));
    let n: number;
    if (typeof sample.n === "number") {
      n = sample.n;
      if (prev && n > prev.n + expectedStep) {
        // Ignore intentional pauses (LIVE 0, spectrum scans, mode switches) where wall-clock gap > 350 ms
        const wallGapMs = now - prev.tMs;
        const missedLines = Math.floor((n - prev.n) / expectedStep) - 1;
        if (missedLines > 0 && missedLines <= 25 && wallGapMs < 350) {
          this.droppedLines += missedLines;
        }
      } else if (prev && n < prev.n) {
        // Timer rebooted and counter reset
        this.points = [];
        this.droppedLines = 0;
      }
      this.synthN = n;
    } else {
      this.synthN += expectedStep;
      n = this.synthN;
    }

    const dbm = sample.dbm.slice(0, 8);
    const floor = sample.floor ? sample.floor.slice(0, 8) : [-127, -127, -127, -127, -127, -127, -127, -127];
    const hits = sample.hits ? sample.hits.slice(0, 8) : [0, 0, 0, 0, 0, 0, 0, 0];

    this.points.push({
      n,
      us: sample.us,
      tMs: now,
      dbm,
      floor,
      hits,
    });
    if (this.points.length > MAX_SIGNAL_POINTS) {
      this.points.splice(0, this.points.length - MAX_SIGNAL_POINTS);
    }
  }

  public latestN(): number {
    return this.points.length ? this.points[this.points.length - 1].n : 0;
  }

  public earliestN(): number {
    return this.points.length ? this.points[0].n : 0;
  }

  /** Slice points within `[endN - windowSec * sweepHz, endN]` (or up to the latest point when `endN` is null). */
  public windowPoints(windowSec: number, sweepHz = 50, endN: number | null = null, padSweeps = 0): SignalPoint[] {
    if (!this.points.length) return [];
    const targetEndN = endN ?? this.points[this.points.length - 1].n;
    const minN = targetEndN - windowSec * sweepHz - padSweeps;
    const maxN = targetEndN + padSweeps;
    // Binary search for minN
    let lo = 0;
    let hi = this.points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.points[mid].n < minN) lo = mid + 1;
      else hi = mid;
    }
    if (endN === null && padSweeps <= 0) {
      return this.points.slice(lo);
    }
    // Binary search for first point > maxN
    let endIdx = this.points.length;
    let rLo = lo;
    let rHi = this.points.length;
    while (rLo < rHi) {
      const mid = (rLo + rHi) >> 1;
      if (this.points[mid].n <= maxN) rLo = mid + 1;
      else rHi = mid;
    }
    endIdx = rLo;
    return this.points.slice(lo, endIdx);
  }

  /** Compute per-channel statistics over the active window (§5.2, matching noise_stats.py). */
  public computeStats(
    windowSec: number,
    freqs: number[],
    pilots: PilotThresholdInfo[],
    sweepHz = 50,
    endN: number | null = null
  ): SignalStatsSummary {
    const pts = this.windowPoints(windowSec, sweepHz, endN);
    if (pts.length < 2) {
      const emptyRows: ChannelNoiseRow[] = freqs.map((f, i) => {
        const pilot = pilots.find((p) => p.enabled && p.frequencyMhz === f);
        return {
          index: i,
          freqMHz: f,
          bandLabel: racebandName(f),
          pilotCallsign: pilot?.callsign ?? "",
          enterThreshold: pilot?.enterThreshold ?? -58,
          samples: 0,
          mean: null,
          sd: null,
          max: null,
          floor: null,
          hitsPerSec: 0,
          pctAboveFloor10: 0,
          pctWouldTrigger: 0,
          wouldTriggerPerSec: 0,
        };
      });
      return { rows: emptyRows, durationSec: 0, totalSamples: pts.length, droppedLines: 0, rateHz: 0 };
    }

    const first = pts[0];
    const last = pts[pts.length - 1];
    const nSpan = Math.max(1, last.n - first.n);
    const dur = nSpan / sweepHz;
    let windowDrops = 0;
    for (let k = 1; k < pts.length; k++) {
      const diff = pts[k].n - pts[k - 1].n - 1;
      const wallGapMs = pts[k].tMs - pts[k - 1].tMs;
      if (diff > 0 && diff <= 25 && wallGapMs < 350) windowDrops += diff;
    }
    const wallSec = Math.max(0.1, (last.tMs - first.tMs) / 1000);
    const rateHz = (pts.length - 1) / wallSec;

    const rows: ChannelNoiseRow[] = freqs.map((f, i) => {
      const pilot = pilots.find((p) => p.enabled && p.frequencyMhz === f);
      const enterThr = pilot?.enterThreshold ?? -58;
      let sum = 0;
      let sumSq = 0;
      let max = -128;
      let count = 0;
      let hitsSum = 0;
      let aboveFloor10 = 0;
      let wouldTrigger = 0;
      let latestFloor: number | null = null;

      for (let k = 0; k < pts.length; k++) {
        const p = pts[k];
        const v = p.dbm[i];
        const fl = p.floor[i];
        if (fl !== undefined && fl > -127) latestFloor = fl;
        hitsSum += p.hits[i] ?? 0;
        if (v === undefined || v <= -127) continue;
        count++;
        sum += v;
        sumSq += v * v;
        if (v > max) max = v;
        const effFloor = fl !== undefined && fl > -127 ? fl : -91;
        if (v > effFloor + 10) aboveFloor10++;
        if (v >= enterThr) wouldTrigger++;
      }

      if (count === 0) {
        return {
          index: i,
          freqMHz: f,
          bandLabel: racebandName(f),
          pilotCallsign: pilot?.callsign ?? "",
          enterThreshold: enterThr,
          samples: 0,
          mean: null,
          sd: null,
          max: null,
          floor: latestFloor,
          hitsPerSec: 0,
          pctAboveFloor10: 0,
          pctWouldTrigger: 0,
          wouldTriggerPerSec: 0,
        };
      }

      const mean = sum / count;
      const variance = Math.max(0, sumSq / count - mean * mean);
      const sd = Math.sqrt(variance);

      return {
        index: i,
        freqMHz: f,
        bandLabel: racebandName(f),
        pilotCallsign: pilot?.callsign ?? "",
        enterThreshold: enterThr,
        samples: count,
        mean,
        sd,
        max,
        floor: latestFloor,
        hitsPerSec: hitsSum / Math.max(0.2, dur),
        pctAboveFloor10: (aboveFloor10 / count) * 100,
        pctWouldTrigger: (wouldTrigger / count) * 100,
        wouldTriggerPerSec: wouldTrigger / Math.max(0.2, dur),
      };
    });

    return {
      rows,
      durationSec: dur,
      totalSamples: pts.length,
      droppedLines: windowDrops,
      rateHz,
    };
  }
}

export interface SignalChartOptions {
  windowSec: number;
  sweepHz: number;
  endN?: number | null;
  refN?: number | null;
  yMinDbm?: number;
  yMaxDbm?: number;
  autoX?: boolean;
  autoY?: boolean;
  yZoomBox?: { y0: number; y1: number } | null;
  freqs: number[];
  enabledChannels: boolean[];
  showFloor: boolean;
  showHitLine: boolean;
  showThresholds: boolean;
  pilots: PilotThresholdInfo[];
  hover: { x: number; y: number } | null;
}

/**
 * Trace a clamped uniform cubic B-spline through `pts` using exact cubic Bézier segments.
 * Guaranteed C² continuous, convex-hull bounded (never overshoots peaks), and filters ±1 dB integer quantization steps.
 */
function traceBSpline(ctx: CanvasRenderingContext2D, pts: Array<{ x: number; y: number }>, moveFirst = true): void {
  const n = pts.length;
  if (n === 0) return;
  if (moveFirst) ctx.moveTo(pts[0].x, pts[0].y);
  if (n === 1) return;
  if (n === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
    return;
  }
  const at = (idx: number) => pts[Math.max(0, Math.min(n - 1, idx))];
  for (let i = -1; i <= n - 1; i++) {
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const cp1x = (2 * p1.x + p2.x) / 3;
    const cp1y = (2 * p1.y + p2.y) / 3;
    const cp2x = (p1.x + 2 * p2.x) / 3;
    const cp2y = (p1.y + 2 * p2.y) / 3;
    const endX = (p1.x + 4 * p2.x + p3.x) / 6;
    const endY = (p1.y + 4 * p2.y + p3.y) / 6;
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, endX, endY);
  }
}

/**
 * Decimate a dense contiguous trace segment using fixed sweep-number (`n`) buckets so panning
 * or stretching the X-axis never shifts bucket boundaries.
 */
function decimateSignalSegment(
  pts: Array<{ n: number; x: number; y: number; dbm: number }>,
  strideN: number
): Array<{ x: number; y: number }> {
  if (strideN <= 1 || pts.length <= 6) {
    return pts;
  }
  const out: Array<{ x: number; y: number }> = [];
  let i = 0;
  while (i < pts.length) {
    const bKey = Math.floor(pts[i].n / strideN);
    let sumX = 0;
    let sumY = 0;
    let minDbm = 1000;
    let maxDbm = -1000;
    let peakPt = pts[i];
    let count = 0;
    while (i < pts.length && Math.floor(pts[i].n / strideN) === bKey) {
      const p = pts[i];
      sumX += p.x;
      sumY += p.y;
      if (p.dbm < minDbm) minDbm = p.dbm;
      if (p.dbm > maxDbm) {
        maxDbm = p.dbm;
        peakPt = p;
      }
      count++;
      i++;
    }
    if (maxDbm - minDbm >= 5) {
      out.push({ x: peakPt.x, y: peakPt.y });
    } else {
      out.push({ x: sumX / count, y: sumY / count });
    }
  }
  return out;
}

/** Render the Signal-over-time multi-channel chart onto `canvas`. */
export function drawSignalOverTimeCanvas(
  canvas: HTMLCanvasElement,
  ring: SignalRingBuffer,
  opts: SignalChartOptions
): void {
  const tokens = getThemeTokens();
  const { ctx, width: W, height: H } = prepareCanvas(canvas, 250);
  const L = 44;
  const R = 14;
  const T = 12;
  const B = 26;
  const plotW = Math.max(10, W - L - R);
  const plotH = Math.max(10, H - T - B);

  ctx.clearRect(0, 0, W, H);

  const yMin = opts.yMinDbm ?? DBM_MIN;
  const yMax = Math.max(yMin + 4, opts.yMaxDbm ?? DBM_MAX);
  const ySpan = yMax - yMin;

  const yOf = (dbm: number) => {
    return T + (1 - (dbm - yMin) / ySpan) * plotH;
  };
  const dbmAtY = (y: number) => {
    return yMin + (1 - (y - T) / plotH) * ySpan;
  };

  // Horizontal grid lines (dBm) with adaptive step when Y-zoomed
  const dStep = ySpan <= 12 ? 2 : ySpan <= 30 ? 5 : 10;
  ctx.font = `10px ${tokens.fontMono}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let d = Math.ceil(yMin / dStep) * dStep; d <= yMax; d += dStep) {
    const y = Math.round(yOf(d)) + 0.5;
    if (y < T - 1 || y > T + plotH + 1) continue;
    ctx.strokeStyle = tokens.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(L, y);
    ctx.lineTo(W - R, y);
    ctx.stroke();
    ctx.fillStyle = tokens.text3;
    ctx.fillText(`${d}`, L - 6, y);
  }

  // Vertical time grid lines (labelled relative to now or to when the view was paused, matching PilotRssiChart)
  const windowSweeps = Math.max(1, opts.windowSec * opts.sweepHz);
  const latestN = ring.latestN();
  const viewEndN = opts.endN ?? latestN;
  const refN = opts.endN === null || opts.endN === undefined ? latestN : (opts.refN ?? latestN);
  const startN = viewEndN - windowSweeps;
  const xOfN = (n: number) => L + ((n - startN) / windowSweeps) * plotW;

  const stepSec =
    opts.windowSec <= 0.8
      ? 0.1
      : opts.windowSec <= 1.8
        ? 0.25
        : opts.windowSec <= 4
          ? 0.5
          : opts.windowSec <= 8
            ? 1
            : opts.windowSec <= 16
              ? 2
              : opts.windowSec <= 40
                ? 5
                : opts.windowSec <= 80
                  ? 10
                  : 20;
  const stepSweeps = stepSec * opts.sweepHz;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  if (stepSweeps > 0) {
    const firstTickN = refN - Math.floor((refN - startN) / stepSweeps) * stepSweeps;
    for (let tN = firstTickN; tN <= viewEndN + 0.5; tN += stepSweeps) {
      const x = Math.round(xOfN(tN)) + 0.5;
      if (x < L - 1 || x > W - R + 1) continue;
      ctx.strokeStyle = tokens.border;
      ctx.beginPath();
      ctx.moveTo(x, T);
      ctx.lineTo(x, T + plotH);
      ctx.stroke();
      const agoSec = Math.max(0, (refN - tN) / opts.sweepHz);
      ctx.fillStyle = tokens.text3;
      const lbl =
        agoSec < 0.02
          ? opts.endN === null || opts.endN === undefined
            ? "now"
            : "paused"
          : stepSec < 0.5
            ? `-${agoSec.toFixed(2)}s`
            : stepSec < 1
              ? `-${agoSec.toFixed(1)}s`
              : `-${Math.round(agoSec)}s`;
      ctx.fillText(lbl, x, T + plotH + 6);
    }
  }

  const pts = ring.windowPoints(opts.windowSec, opts.sweepHz, opts.endN ?? null, 3);
  if (!pts.length) {
    ctx.fillStyle = tokens.text3;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `12px ${tokens.fontSans}`;
    ctx.fillText("Waiting for live sweep samples…", L + plotW / 2, T + plotH / 2);
    return;
  }

  // Clip plot region
  ctx.save();
  ctx.beginPath();
  ctx.rect(L, T, plotW, plotH);
  ctx.clip();

  // Pilot enter threshold lines (when enabled and matched by frequency)
  if (opts.showThresholds) {
    const drawnThresholds = new Set<string>();
    opts.freqs.forEach((f, ch) => {
      if (!opts.enabledChannels[ch]) return;
      const pilot = opts.pilots.find((p) => p.enabled && p.frequencyMhz === f);
      const thr = pilot ? pilot.enterThreshold : ch === 0 ? -58 : null;
      if (thr === null) return;
      const key = `${thr}:${pilot ? CHANNEL_COLORS[ch] : tokens.warn}`;
      if (drawnThresholds.has(key)) return;
      drawnThresholds.add(key);

      const y = Math.round(yOf(thr)) + 0.5;
      ctx.strokeStyle = pilot ? CHANNEL_COLORS[ch] : tokens.warn;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(L, y);
      ctx.lineTo(W - R, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = pilot ? CHANNEL_COLORS[ch] : tokens.warn;
      ctx.font = `9.5px ${tokens.fontMono}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      const label = pilot ? `${pilot.callsign} enter ${thr} dBm` : `default enter ${thr} dBm`;
      ctx.fillText(label, L + 6, y - 2);
      ctx.globalAlpha = 1;
    });
  }

  // Per-channel floor and floor+10dB hit lines (drawn for latest floor of enabled channels)
  const lastPt = pts[pts.length - 1];
  for (let ch = 0; ch < 8; ch++) {
    if (!opts.enabledChannels[ch]) continue;
    const fl = lastPt.floor[ch];
    if (fl === undefined || fl <= -127) continue;
    const col = CHANNEL_COLORS[ch];
    if (opts.showFloor) {
      const yFl = Math.round(yOf(fl)) + 0.5;
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(L, yFl);
      ctx.lineTo(W - R, yFl);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (opts.showHitLine) {
      const yHit = Math.round(yOf(fl + 10)) + 0.5;
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(L, yHit);
      ctx.lineTo(W - R, yHit);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.globalAlpha = 1;

  // Draw each enabled channel trace using uniform cubic B-splines; break the path when `n` jumps so gaps show honestly
  const maxStepN = Math.max(2, Math.round(opts.sweepHz / 5)); // >200 ms gap breaks the line
  const pxPerSweep = plotW / Math.max(1, windowSweeps);
  const showSampleDots = pxPerSweep >= 7.5;
  const strideN = windowSweeps > 360 ? Math.max(1, Math.floor(windowSweeps / 240)) : 1;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (let ch = 0; ch < 8; ch++) {
    if (!opts.enabledChannels[ch]) continue;
    const col = CHANNEL_COLORS[ch];
    ctx.strokeStyle = col;
    ctx.lineWidth = showSampleDots ? 1.85 : 1.65;
    ctx.beginPath();

    let segment: Array<{ n: number; x: number; y: number; dbm: number }> = [];
    let prevN = -1;
    const flushSegment = () => {
      if (segment.length === 0) return;
      const smoothed = decimateSignalSegment(segment, strideN);
      traceBSpline(ctx, smoothed, true);
      segment = [];
    };

    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      const v = p.dbm[ch];
      if (v === undefined || v <= -127) {
        flushSegment();
        continue;
      }
      if (segment.length > 0 && p.n - prevN > maxStepN) {
        flushSegment();
      }
      segment.push({ n: p.n, x: xOfN(p.n), y: yOf(v), dbm: v });
      prevN = p.n;
    }
    flushSegment();
    ctx.stroke();

    // When stretched horizontally (zoomed in on time), render individual sweep sample dots
    if (showSampleDots) {
      ctx.fillStyle = col;
      const dotR = pxPerSweep >= 12 ? 2.3 : 1.7;
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k];
        const v = p.dbm[ch];
        if (v === undefined || v <= -127) continue;
        ctx.beginPath();
        ctx.arc(xOfN(p.n), yOf(v), dotR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Draw Y-axis zoom selection band when dragging vertically
  if (opts.yZoomBox) {
    const ya = Math.max(T, Math.min(T + plotH, Math.min(opts.yZoomBox.y0, opts.yZoomBox.y1)));
    const yb = Math.max(T, Math.min(T + plotH, Math.max(opts.yZoomBox.y0, opts.yZoomBox.y1)));
    ctx.fillStyle = "rgba(212, 255, 58, 0.12)";
    ctx.fillRect(L, ya, plotW, Math.max(1, yb - ya));
    ctx.strokeStyle = tokens.accent;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(L, ya + 0.5);
    ctx.lineTo(W - R, ya + 0.5);
    ctx.moveTo(L, yb + 0.5);
    ctx.lineTo(W - R, yb + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    const dHigh = Math.round(dbmAtY(ya));
    const dLow = Math.round(dbmAtY(yb));
    ctx.fillStyle = tokens.accent;
    ctx.font = `10.5px ${tokens.fontMono}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(`Zoom Y: ${dLow} to ${dHigh} dBm`, L + 8, (ya + yb) / 2);
  }

  ctx.restore();

  // Hover readout
  if (!opts.yZoomBox && opts.hover && opts.hover.x >= L && opts.hover.x <= W - R && opts.hover.y >= T && opts.hover.y <= T + plotH) {
    const targetN = startN + ((opts.hover.x - L) / plotW) * windowSweeps;
    // Find nearest point by n
    let best = pts[0];
    let bestDist = Math.abs(best.n - targetN);
    for (let k = 1; k < pts.length; k++) {
      const d = Math.abs(pts[k].n - targetN);
      if (d < bestDist) {
        best = pts[k];
        bestDist = d;
      }
    }
    const hx = xOfN(best.n);
    ctx.strokeStyle = tokens.text3;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(hx, T);
    ctx.lineTo(hx, T + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    // Find closest channel to cursor Y at `best`
    let bestCh = -1;
    let bestChDist = 1e9;
    for (let ch = 0; ch < 8; ch++) {
      if (!opts.enabledChannels[ch]) continue;
      const v = best.dbm[ch];
      if (v === undefined || v <= -127) continue;
      const dy = Math.abs(yOf(v) - opts.hover.y);
      if (dy < bestChDist) {
        bestChDist = dy;
        bestCh = ch;
      }
    }

    const ageSec = ((refN - best.n) / opts.sweepHz).toFixed(2);
    const lines: Array<{ text: string; color: string }> = [
      { text: `-${ageSec} s  (sweep #${best.n})`, color: tokens.text2 },
    ];
    for (let ch = 0; ch < 8; ch++) {
      if (!opts.enabledChannels[ch]) continue;
      const v = best.dbm[ch];
      if (v === undefined || v <= -127) continue;
      const f = opts.freqs[ch] ?? RACEBAND[ch];
      const rb = racebandName(f) || `Ch${ch + 1}`;
      const fl = best.floor[ch];
      const mark = ch === bestCh ? "▸ " : "  ";
      lines.push({
        text: `${mark}${rb} ${f}: ${v} dBm${fl && fl > -127 ? ` (fl ${fl})` : ""}`,
        color: CHANNEL_COLORS[ch],
      });
      if (ch === bestCh) {
        const cy = yOf(v);
        if (cy >= T && cy <= T + plotH) {
          ctx.fillStyle = CHANNEL_COLORS[ch];
          ctx.beginPath();
          ctx.arc(hx, cy, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    drawTooltipBox(ctx, hx, opts.hover.y, lines, L, W - R, T, T + plotH, tokens);
  }
}

// ============================================================================
// 5.3 Waterfall (spectrogram) & 5.4 Spectrum chart upgrades & 5.5 Band overlay
// ============================================================================

export interface SpectrumPeak {
  freqMHz: number;
  dbm: number;
  bandHint: string;
}

export class SpectrumAccumulator {
  public latest: ScanResult | null = null;
  public maxHold: number[] | null = null;
  public avgSum: number[] | null = null;
  public avgCount = 0;
  public history: Array<{ tsIso: string; passMs: number; start: number; step: number; dbm: number[] }> = [];
  /** Vertical scroll offset in waterfall rows (0 = pinned to newest row at top). */
  public scrollRow = 0;
  public readonly maxRows = 1200;
  public visibleRows = 80;
  public colorMinDbm = -100;
  public colorMaxDbm = -40;
  private offscreen: HTMLCanvasElement | null = null;
  private wfWidth = 0;

  public maxScrollRow(): number {
    return Math.max(0, this.history.length - this.visibleRows);
  }

  public setScrollRow(row: number): void {
    this.scrollRow = Math.max(0, Math.min(this.maxScrollRow(), Math.round(row)));
  }

  public setVisibleRows(rows: number): void {
    this.visibleRows = Math.max(8, Math.min(400, Math.round(rows)));
    this.setScrollRow(this.scrollRow);
  }

  public setColorRange(minDbm: number, maxDbm: number): void {
    const lo = Math.max(-115, Math.min(-35, Math.round(minDbm)));
    const hi = Math.max(lo + 8, Math.min(-15, Math.round(maxDbm)));
    if (lo === this.colorMinDbm && hi === this.colorMaxDbm) return;
    this.colorMinDbm = lo;
    this.colorMaxDbm = hi;
    this.repaintOffscreen();
  }

  public clearHoldAndAvg(): void {
    if (this.latest) {
      this.maxHold = [...this.latest.dbm];
      this.avgSum = [...this.latest.dbm];
      this.avgCount = 1;
    } else {
      this.maxHold = null;
      this.avgSum = null;
      this.avgCount = 0;
    }
  }

  public clearAll(): void {
    this.latest = null;
    this.maxHold = null;
    this.avgSum = null;
    this.avgCount = 0;
    this.history = [];
    this.scrollRow = 0;
    this.offscreen = null;
    this.wfWidth = 0;
  }

  public pushScan(s: ScanResult): void {
    const n = s.dbm.length;
    if (!n) return;
    const sameGrid =
      this.latest !== null &&
      this.latest.start === s.start &&
      this.latest.step === s.step &&
      this.latest.dbm.length === n;

    if (!sameGrid || !this.maxHold || !this.avgSum) {
      this.maxHold = [...s.dbm];
      this.avgSum = [...s.dbm];
      this.avgCount = 1;
      this.history = [];
      this.scrollRow = 0;
      this.resetOffscreen(n);
    } else {
      this.avgCount++;
      for (let i = 0; i < n; i++) {
        const v = s.dbm[i];
        if (v > this.maxHold[i]) this.maxHold[i] = v;
        this.avgSum[i] += v;
      }
    }

    this.latest = s;
    this.history.push({
      tsIso: new Date().toISOString(),
      passMs: s.passMs ?? 0,
      start: s.start,
      step: s.step,
      dbm: [...s.dbm],
    });
    if (this.history.length > this.maxRows) {
      this.history.splice(0, this.history.length - this.maxRows);
    }

    this.appendWaterfallRow(s.dbm);
    // If the user has scrolled down to inspect an older row, keep that historical slice stationary
    if (this.scrollRow > 0) {
      this.setScrollRow(this.scrollRow + 1);
    }
  }

  public getAverage(): number[] | null {
    if (!this.avgSum || this.avgCount < 1) return null;
    return this.avgSum.map((sum) => sum / this.avgCount);
  }

  private resetOffscreen(bins: number): void {
    const c = document.createElement("canvas");
    c.width = bins;
    c.height = this.maxRows;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#0b0c0f";
    ctx.fillRect(0, 0, c.width, c.height);
    this.offscreen = c;
    this.wfWidth = bins;
  }

  private repaintOffscreen(): void {
    if (!this.latest || !this.history.length) return;
    const bins = this.latest.dbm.length;
    this.resetOffscreen(bins);
    const c = this.offscreen!;
    const ctx = c.getContext("2d")!;
    const rowsToPaint = Math.min(this.maxRows, this.history.length);
    const img = ctx.createImageData(bins, rowsToPaint);
    const data = img.data;
    for (let r = 0; r < rowsToPaint; r++) {
      const hRow = this.history[this.history.length - 1 - r];
      for (let i = 0; i < bins; i++) {
        const [cr, cg, cb] = dbmToRgb(hRow.dbm[i], this.colorMinDbm, this.colorMaxDbm);
        const o = (r * bins + i) * 4;
        data[o] = cr;
        data[o + 1] = cg;
        data[o + 2] = cb;
        data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /** Shift the offscreen canvas down by 1 row and paint the new scan on row 0 via ImageData. */
  private appendWaterfallRow(dbm: number[]): void {
    const bins = dbm.length;
    if (!this.offscreen || this.wfWidth !== bins) {
      this.resetOffscreen(bins);
    }
    const c = this.offscreen!;
    const ctx = c.getContext("2d")!;
    // Shift existing image 1px down
    ctx.drawImage(c, 0, 0, bins, this.maxRows - 1, 0, 1, bins, this.maxRows - 1);
    const rowImg = ctx.createImageData(bins, 1);
    const data = rowImg.data;
    for (let i = 0; i < bins; i++) {
      const [r, g, b] = dbmToRgb(dbm[i], this.colorMinDbm, this.colorMaxDbm);
      const o = i * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
    ctx.putImageData(rowImg, 0, 0);
  }

  public getOffscreen(): HTMLCanvasElement | null {
    return this.offscreen;
  }

  /** Top 5 local maxima at least 6 dB above the scan median (§5.4). */
  public topPeaks(maxPeaks = 5): SpectrumPeak[] {
    const s = this.latest;
    if (!s || s.dbm.length < 3) return [];
    const sorted = [...s.dbm].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const threshold = median + 6;

    const candidates: Array<{ idx: number; dbm: number }> = [];
    for (let i = 0; i < s.dbm.length; i++) {
      const v = s.dbm[i];
      if (v < threshold) continue;
      const left = i > 0 ? s.dbm[i - 1] : -128;
      const right = i < s.dbm.length - 1 ? s.dbm[i + 1] : -128;
      if (v >= left && v >= right) {
        candidates.push({ idx: i, dbm: v });
      }
    }
    candidates.sort((a, b) => b.dbm - a.dbm);

    // Suppress neighbors within 15 MHz of a stronger peak
    const picked: SpectrumPeak[] = [];
    const minSepBins = Math.max(1, Math.round(15 / Math.max(1, s.step)));
    for (const c of candidates) {
      if (picked.length >= maxPeaks) break;
      const f = s.start + c.idx * s.step;
      if (picked.some((p) => Math.abs(p.freqMHz - f) < minSepBins * s.step)) continue;
      picked.push({
        freqMHz: f,
        dbm: c.dbm,
        bandHint: nearestBandHint(f),
      });
    }
    return picked;
  }
}

export function nearestBandHint(freqMHz: number): string {
  const parts: string[] = [];
  // Nearest Raceband channel within 18 MHz
  let bestRb = -1;
  let bestDist = 999;
  for (let i = 0; i < RACEBAND.length; i++) {
    const d = Math.abs(RACEBAND[i] - freqMHz);
    if (d < bestDist) {
      bestDist = d;
      bestRb = i;
    }
  }
  if (bestRb >= 0 && bestDist <= 18) {
    const delta = freqMHz - RACEBAND[bestRb];
    parts.push(`R${bestRb + 1}${delta === 0 ? "" : ` (${delta > 0 ? "+" : ""}${delta})`}`);
  }
  // Wi-Fi 5 GHz channel (channel = (MHz - 5000) / 5)
  for (const b of WIFI_BAND_BLOCKS) {
    if (freqMHz >= b.startMHz && freqMHz <= b.stopMHz) {
      const wifiCh = Math.round((freqMHz - 5000) / 5);
      parts.push(`Wi-Fi ch ${wifiCh} (${b.label})`);
      break;
    }
  }
  return parts.join(" · ") || "out of band";
}

/** Perceptual dark → blue → cyan → volt (#d4ff3a) → white palette (§5.3). */
export function dbmToRgb(dbm: number, minDbm = -100, maxDbm = -40): [number, number, number] {
  const span = Math.max(4, maxDbm - minDbm);
  const t = Math.max(0, Math.min(1, (dbm - minDbm) / span));
  // 5-stop gradient:
  // 0.00: #0b0c0f (11, 12, 15)
  // 0.28: #172554 (23, 37, 84)
  // 0.55: #0891b2 (8, 145, 178)
  // 0.82: #d4ff3a (212, 255, 58)
  // 1.00: #ffffff (255, 255, 255)
  const stops: Array<[number, number, number, number]> = [
    [0.0, 11, 12, 15],
    [0.28, 23, 37, 84],
    [0.55, 8, 145, 178],
    [0.82, 212, 255, 58],
    [1.0, 255, 255, 255],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, r0, g0, b0] = stops[i];
    const [t1, r1, g1, b1] = stops[i + 1];
    if (t <= t1) {
      const u = (t - t0) / Math.max(1e-6, t1 - t0);
      return [
        Math.round(r0 + (r1 - r0) * u),
        Math.round(g0 + (g1 - g0) * u),
        Math.round(b0 + (b1 - b0) * u),
      ];
    }
  }
  return [255, 255, 255];
}

/** Shared band overlay: Wi-Fi UNII shaded blocks + Raceband vertical dashed markers (§5.5). */
function drawBandOverlay(
  ctx: CanvasRenderingContext2D,
  startMHz: number,
  stopMHz: number,
  L: number,
  R: number,
  T: number,
  plotW: number,
  plotH: number,
  showWifi: boolean,
  tokens: ThemeTokens
): void {
  const span = Math.max(1, stopMHz - startMHz);
  const xOf = (f: number) => L + ((f - startMHz) / span) * plotW;

  if (showWifi) {
    for (const b of WIFI_BAND_BLOCKS) {
      const a = Math.max(startMHz, b.startMHz);
      const z = Math.min(stopMHz, b.stopMHz);
      if (z <= a) continue;
      const x0 = xOf(a);
      const x1 = xOf(z);
      ctx.fillStyle = b.warnsRaceband ? "rgba(251, 191, 36, 0.07)" : "rgba(56, 189, 248, 0.06)";
      ctx.fillRect(x0, T, x1 - x0, plotH);
      ctx.strokeStyle = b.warnsRaceband ? "rgba(251, 191, 36, 0.22)" : "rgba(56, 189, 248, 0.18)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0, T);
      ctx.lineTo(x0, T + plotH);
      ctx.moveTo(x1, T);
      ctx.lineTo(x1, T + plotH);
      ctx.stroke();

      if (x1 - x0 > 46) {
        ctx.fillStyle = b.warnsRaceband ? "rgba(251, 191, 36, 0.75)" : "rgba(163, 168, 179, 0.65)";
        ctx.font = `9.5px ${tokens.fontMono}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(`${b.label} (${b.channels})`, (x0 + x1) / 2, T + plotH - 4);
      }
    }
  }

  // Raceband R1-R8 vertical markers
  ctx.font = `9.5px ${tokens.fontMono}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let i = 0; i < RACEBAND.length; i++) {
    const f = RACEBAND[i];
    if (f < startMHz || f > stopMHz) continue;
    const x = Math.round(xOf(f)) + 0.5;
    ctx.strokeStyle = "rgba(212, 255, 58, 0.25)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, T);
    ctx.lineTo(x, T + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(212, 255, 58, 0.78)";
    ctx.fillText(`R${i + 1}`, x, T + 3);
  }
}

export interface SpectrumCanvasOptions {
  showMaxHold: boolean;
  showAverage: boolean;
  showWifiOverlay: boolean;
  viewStartMHz?: number | null;
  viewStopMHz?: number | null;
  yMinDbm?: number;
  yMaxDbm?: number;
  autoY?: boolean;
  zoomBox?: { x0: number; x1: number } | null;
  hover: { x: number; y: number } | null;
}

function freqTickStep(spanMHz: number): number {
  if (spanMHz <= 40) return 5;
  if (spanMHz <= 90) return 10;
  if (spanMHz <= 200) return 20;
  if (spanMHz <= 420) return 50;
  return 100;
}

function drawFreqZoomBox(
  ctx: CanvasRenderingContext2D,
  zoomBox: { x0: number; x1: number },
  vStart: number,
  span: number,
  L: number,
  R: number,
  T: number,
  W: number,
  plotW: number,
  plotH: number,
  tokens: ThemeTokens
): void {
  const xa = Math.max(L, Math.min(W - R, Math.min(zoomBox.x0, zoomBox.x1)));
  const xb = Math.max(L, Math.min(W - R, Math.max(zoomBox.x0, zoomBox.x1)));
  ctx.fillStyle = "rgba(212, 255, 58, 0.14)";
  ctx.fillRect(xa, T, Math.max(1, xb - xa), plotH);
  ctx.strokeStyle = tokens.accent;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(xa + 0.5, T);
  ctx.lineTo(xa + 0.5, T + plotH);
  ctx.moveTo(xb + 0.5, T);
  ctx.lineTo(xb + 0.5, T + plotH);
  ctx.stroke();
  ctx.setLineDash([]);

  const f0 = Math.round(vStart + ((xa - L) / plotW) * span);
  const f1 = Math.round(vStart + ((xb - L) / plotW) * span);
  const label = `${f0}–${f1} MHz (${Math.max(0, f1 - f0)} MHz)`;
  ctx.font = `10.5px ${tokens.fontMono}`;
  const tw = ctx.measureText(label).width + 12;
  const cx = Math.max(L + tw / 2 + 4, Math.min(W - R - tw / 2 - 4, (xa + xb) / 2));
  ctx.fillStyle = "rgba(11, 12, 15, 0.88)";
  ctx.fillRect(cx - tw / 2, T + 8, tw, 18);
  ctx.strokeStyle = tokens.accent;
  ctx.strokeRect(cx - tw / 2 + 0.5, T + 8.5, tw - 1, 17);
  ctx.fillStyle = tokens.accent;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, cx, T + 17);
}

/** Draw the upgraded Spectrum Scan canvas (§5.4 + §5.5). */
export function drawSpectrumCanvas(
  canvas: HTMLCanvasElement,
  acc: SpectrumAccumulator,
  opts: SpectrumCanvasOptions
): void {
  const s = acc.latest;
  const tokens = getThemeTokens();
  const { ctx, width: W, height: H } = prepareCanvas(canvas, 230);
  const L = 44;
  const R = 14;
  const T = 12;
  const B = 26;
  const plotW = Math.max(10, W - L - R);
  const plotH = Math.max(10, H - T - B);

  ctx.clearRect(0, 0, W, H);

  if (!s || !s.dbm.length) {
    ctx.fillStyle = tokens.text3;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `12px ${tokens.fontSans}`;
    ctx.fillText("Click Scan once or Live on to see the 5.8 GHz spectrum.", L + plotW / 2, T + plotH / 2);
    return;
  }

  const scanStop = s.start + s.step * (s.dbm.length - 1);
  const vStart = Math.max(s.start, Math.min(scanStop - s.step, opts.viewStartMHz ?? s.start));
  const vStop = Math.min(scanStop, Math.max(vStart + s.step, opts.viewStopMHz ?? scanStop));
  const span = Math.max(1, vStop - vStart);
  const yMin = opts.yMinDbm ?? DBM_MIN;
  const yMax = Math.max(yMin + 4, opts.yMaxDbm ?? DBM_MAX);
  const ySpan = yMax - yMin;
  const xOf = (f: number) => L + ((f - vStart) / span) * plotW;
  const yOf = (d: number) => T + (1 - (d - yMin) / ySpan) * plotH;

  // Horizontal dBm grid with adaptive step when Y-zoomed
  const dStep = ySpan <= 14 ? 2 : ySpan <= 32 ? 5 : 10;
  ctx.font = `10px ${tokens.fontMono}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let d = Math.ceil(yMin / dStep) * dStep; d <= yMax; d += dStep) {
    const y = Math.round(yOf(d)) + 0.5;
    if (y < T - 1 || y > T + plotH + 1) continue;
    ctx.strokeStyle = tokens.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(L, y);
    ctx.lineTo(W - R, y);
    ctx.stroke();
    ctx.fillStyle = tokens.text3;
    ctx.fillText(`${d}`, L - 6, y);
  }

  // Adaptive frequency ticks
  const fStep = freqTickStep(span);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let f = Math.ceil(vStart / fStep) * fStep; f <= vStop; f += fStep) {
    const x = Math.round(xOf(f)) + 0.5;
    ctx.fillStyle = tokens.text3;
    ctx.fillText(`${f}`, x, T + plotH + 6);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(L, T, plotW, plotH);
  ctx.clip();

  drawBandOverlay(ctx, vStart, vStop, L, R, T, plotW, plotH, opts.showWifiOverlay, tokens);

  // Max-hold trace (B-spline smoothed)
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (opts.showMaxHold && acc.maxHold && acc.maxHold.length === s.dbm.length) {
    ctx.strokeStyle = tokens.accent;
    ctx.globalAlpha = 0.34;
    ctx.lineWidth = 1.2;
    const holdPts = acc.maxHold.map((v, i) => ({ x: xOf(s.start + i * s.step), y: yOf(v) }));
    ctx.beginPath();
    traceBSpline(ctx, holdPts, true);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Running average trace (B-spline smoothed)
  const avg = opts.showAverage ? acc.getAverage() : null;
  if (avg && avg.length === s.dbm.length) {
    ctx.strokeStyle = "#38bdf8";
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1.4;
    const avgPts = avg.map((v, i) => ({ x: xOf(s.start + i * s.step), y: yOf(v) }));
    ctx.beginPath();
    traceBSpline(ctx, avgPts, true);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Live / current scan trace (B-spline smoothed) & peak within visible range
  ctx.strokeStyle = tokens.accent;
  ctx.lineWidth = 1.75;
  let peakIdx = -1;
  const livePts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < s.dbm.length; i++) {
    const f = s.start + i * s.step;
    if (f >= vStart && f <= vStop && (peakIdx < 0 || s.dbm[i] > s.dbm[peakIdx])) {
      peakIdx = i;
    }
    livePts.push({ x: xOf(f), y: yOf(s.dbm[i]) });
  }
  ctx.beginPath();
  traceBSpline(ctx, livePts, true);
  ctx.stroke();

  // Peak dot & label inside visible range
  if (peakIdx >= 0) {
    const peakFreq = s.start + peakIdx * s.step;
    const px = xOf(peakFreq);
    const py = yOf(s.dbm[peakIdx]);
    ctx.fillStyle = tokens.accent;
    ctx.beginPath();
    ctx.arc(px, py, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = tokens.text;
    ctx.font = `10.5px ${tokens.fontMono}`;
    ctx.textAlign = px > W - R - 130 ? "right" : "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${peakFreq} MHz · ${s.dbm[peakIdx]} dBm`, px + (px > W - R - 130 ? -6 : 6), Math.max(T + 22, py - 5));
  }

  if (opts.zoomBox) {
    drawFreqZoomBox(ctx, opts.zoomBox, vStart, span, L, R, T, W, plotW, plotH, tokens);
  }

  ctx.restore();

  // Hover readout
  if (!opts.zoomBox && opts.hover && opts.hover.x >= L && opts.hover.x <= W - R && opts.hover.y >= T && opts.hover.y <= T + plotH) {
    const fCursor = vStart + ((opts.hover.x - L) / plotW) * span;
    const idx = Math.max(0, Math.min(s.dbm.length - 1, Math.round((fCursor - s.start) / Math.max(1, s.step))));
    const f = s.start + idx * s.step;
    const hx = xOf(f);
    const hy = yOf(s.dbm[idx]);

    if (hx >= L && hx <= W - R) {
      ctx.strokeStyle = tokens.text3;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(hx, T);
      ctx.lineTo(hx, T + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = tokens.text;
      ctx.beginPath();
      ctx.arc(hx, hy, 3, 0, Math.PI * 2);
      ctx.fill();

      const tipLines: Array<{ text: string; color: string }> = [
        { text: `${f} MHz  (${nearestBandHint(f)})`, color: tokens.text },
        { text: `Current: ${s.dbm[idx]} dBm`, color: tokens.accent },
      ];
      if (avg) tipLines.push({ text: `Average: ${avg[idx].toFixed(1)} dBm`, color: "#38bdf8" });
      if (acc.maxHold) tipLines.push({ text: `Max hold: ${acc.maxHold[idx]} dBm`, color: tokens.text2 });

      drawTooltipBox(ctx, hx, opts.hover.y, tipLines, L, W - R, T, T + plotH, tokens);
    }
  }
}

export interface WaterfallCanvasOptions {
  showWifiOverlay: boolean;
  viewStartMHz?: number | null;
  viewStopMHz?: number | null;
  zoomBox?: { x0: number; x1: number } | null;
  hover: { x: number; y: number } | null;
}

/** Draw the vertically scrollable & frequency-zoomable Waterfall spectrogram canvas (§5.3). */
export function drawWaterfallCanvas(
  canvas: HTMLCanvasElement,
  acc: SpectrumAccumulator,
  showWifiOverlay: boolean,
  hover: { x: number; y: number } | null,
  viewStartMHz?: number | null,
  viewStopMHz?: number | null,
  zoomBox?: { x0: number; x1: number } | null
): void {
  const s = acc.latest;
  const off = acc.getOffscreen();
  const tokens = getThemeTokens();
  const { ctx, width: W, height: H } = prepareCanvas(canvas, 220);
  const L = 44;
  const R = 18;
  const T = 6;
  const B = 24;
  const plotW = Math.max(10, W - L - R);
  const plotH = Math.max(10, H - T - B);

  ctx.clearRect(0, 0, W, H);

  if (!s || !off || !acc.history.length) {
    ctx.fillStyle = tokens.text3;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `12px ${tokens.fontSans}`;
    ctx.fillText("Scan passes will build a scrollable waterfall history here.", L + plotW / 2, T + plotH / 2);
    return;
  }

  const scanStop = s.start + s.step * (s.dbm.length - 1);
  const vStart = Math.max(s.start, Math.min(scanStop - s.step, viewStartMHz ?? s.start));
  const vStop = Math.min(scanStop, Math.max(vStart + s.step, viewStopMHz ?? scanStop));
  const span = Math.max(1, vStop - vStart);
  const xOf = (f: number) => L + ((f - vStart) / span) * plotW;

  const visRows = acc.visibleRows;
  const startRow = Math.max(0, Math.min(acc.maxScrollRow(), acc.scrollRow));

  // Slice both horizontal frequency bins [bin0 .. bin1] and vertical rows [startRow .. startRow + visRows]
  const bin0 = Math.max(0, Math.min(off.width - 1, (vStart - s.start) / Math.max(1, s.step)));
  const bin1 = Math.max(bin0 + 1, Math.min(off.width, (vStop - s.start) / Math.max(1, s.step) + 1));
  ctx.save();
  ctx.beginPath();
  ctx.rect(L, T, plotW, plotH);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, bin0, startRow, bin1 - bin0, visRows, L, T, plotW, plotH);
  drawBandOverlay(ctx, vStart, vStop, L, R, T, plotW, plotH, showWifiOverlay, tokens);
  if (zoomBox) {
    drawFreqZoomBox(ctx, zoomBox, vStart, span, L, R, T, W, plotW, plotH, tokens);
  }
  ctx.restore();

  // Border around waterfall plot
  ctx.strokeStyle = tokens.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(L + 0.5, T + 0.5, plotW - 1, plotH - 1);

  // Y-axis age ticks (reflecting current vertical scroll offset and row stretch)
  const passSec = s.passMs && s.passMs > 20 ? s.passMs / 1000 : 0.32;
  const topAgeSec = startRow * passSec;
  const midAgeSec = (startRow + visRows / 2) * passSec;
  const botAgeSec = (startRow + visRows) * passSec;
  ctx.fillStyle = tokens.text3;
  ctx.font = `10px ${tokens.fontMono}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(startRow === 0 ? "now" : `-${topAgeSec.toFixed(1)}s`, L - 6, T + 6);
  ctx.fillText(visRows <= 30 ? `-${midAgeSec.toFixed(1)}s` : `-${midAgeSec.toFixed(0)}s`, L - 6, T + plotH / 2);
  ctx.fillText(visRows <= 30 ? `-${botAgeSec.toFixed(1)}s` : `-${botAgeSec.toFixed(0)}s`, L - 6, T + plotH - 6);

  // Vertical scrollbar track + thumb on the right margin when history exceeds 1 viewport
  const totalStored = Math.max(visRows, acc.history.length);
  const sbX = W - R + 5;
  const sbW = 6;
  ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
  ctx.fillRect(sbX, T, sbW, plotH);
  const thumbFrac = Math.min(1, visRows / totalStored);
  const thumbH = Math.max(18, Math.round(plotH * thumbFrac));
  const maxScroll = Math.max(1, acc.maxScrollRow());
  const scrollFrac = acc.maxScrollRow() > 0 ? startRow / maxScroll : 0;
  const thumbY = T + Math.round((plotH - thumbH) * scrollFrac);
  ctx.fillStyle = startRow > 0 ? tokens.warn : acc.history.length > visRows ? tokens.accent : "rgba(255, 255, 255, 0.18)";
  ctx.fillRect(sbX, thumbY, sbW, thumbH);

  // Adaptive X-axis frequency ticks
  const fStep = freqTickStep(span);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let f = Math.ceil(vStart / fStep) * fStep; f <= vStop; f += fStep) {
    const x = Math.round(xOf(f)) + 0.5;
    ctx.fillStyle = tokens.text3;
    ctx.fillText(`${f}`, x, T + plotH + 6);
  }

  // Hover readout (MHz, dBm, age, pass index)
  if (!zoomBox && hover && hover.x >= L && hover.x <= W - R && hover.y >= T && hover.y <= T + plotH) {
    const fCursor = vStart + ((hover.x - L) / plotW) * span;
    const binIdx = Math.max(0, Math.min(s.dbm.length - 1, Math.round((fCursor - s.start) / Math.max(1, s.step))));
    const localRow = Math.max(0, Math.min(visRows - 1, Math.floor(((hover.y - T) / plotH) * visRows)));
    const rowIdx = startRow + localRow;
    const f = s.start + binIdx * s.step;
    const histIdx = acc.history.length - 1 - rowIdx;
    const histRow = histIdx >= 0 ? acc.history[histIdx] : null;
    const dbmVal = histRow ? histRow.dbm[binIdx] : null;
    const age = (rowIdx * passSec).toFixed(1);

    const tipLines: Array<{ text: string; color: string }> = [
      { text: `${f} MHz  (${nearestBandHint(f)})`, color: tokens.text },
      {
        text:
          dbmVal !== null && dbmVal !== undefined
            ? `${dbmVal} dBm · -${age} s (pass -${rowIdx + 1} of ${acc.history.length})`
            : `-${age} s (no pass at row #${rowIdx + 1})`,
        color: tokens.accent,
      },
    ];
    drawTooltipBox(ctx, hover.x, hover.y, tipLines, L, W - R, T, T + plotH, tokens);
  }
}

// ============================================================================
// 5.6 Health over time sparklines
// ============================================================================

export interface HealthPoint {
  tMs: number;
  tsIso: string;
  sweepUs: number;
  sweepUsMax: number;
  sweepBudgetUs: number;
  heapFreeKB: number;
  heapMinKB: number;
  framesPerSec: number | null;
  liveRateHz: number;
  droppedDelta: number;
}

const MAX_HEALTH_POINTS = 150; // 5 min at 2s intervals

export class HealthHistory {
  public points: HealthPoint[] = [];
  private prevFramesRx: number | null = null;
  private prevFramesAt = 0;
  private prevLiveCount = 0;
  private prevLiveAt = 0;
  private prevDropped = 0;

  public clear(): void {
    this.points = [];
    this.prevFramesRx = null;
    this.prevFramesAt = 0;
    this.prevLiveCount = 0;
    this.prevLiveAt = 0;
    this.prevDropped = 0;
  }

  public record(
    status: TimerStatus,
    liveCount: number,
    totalDropped: number,
    framesRx: number | null
  ): void {
    const now = performance.now();
    let fps: number | null = null;
    if (framesRx !== null) {
      if (this.prevFramesRx !== null && now > this.prevFramesAt && framesRx >= this.prevFramesRx) {
        fps = ((framesRx - this.prevFramesRx) * 1000) / (now - this.prevFramesAt);
      }
      this.prevFramesRx = framesRx;
      this.prevFramesAt = now;
    }

    let liveHz = 0;
    if (this.prevLiveAt > 0 && now > this.prevLiveAt && liveCount >= this.prevLiveCount) {
      liveHz = ((liveCount - this.prevLiveCount) * 1000) / (now - this.prevLiveAt);
    }
    this.prevLiveCount = liveCount;
    this.prevLiveAt = now;

    const dropDelta = Math.max(0, totalDropped - this.prevDropped);
    this.prevDropped = totalDropped;

    const budget = status.sweepBudgetUs || (status.sweepHz ? Math.round(1e6 / status.sweepHz) : 7000);
    this.points.push({
      tMs: now,
      tsIso: new Date().toISOString(),
      sweepUs: status.sweepUs,
      sweepUsMax: status.sweepUsMax,
      sweepBudgetUs: budget,
      heapFreeKB: status.heapFree / 1024,
      heapMinKB: status.heapMin / 1024,
      framesPerSec: fps,
      liveRateHz: liveHz,
      droppedDelta: dropDelta,
    });
    if (this.points.length > MAX_HEALTH_POINTS) {
      this.points.splice(0, this.points.length - MAX_HEALTH_POINTS);
    }
  }
}

function downsampleSeries(values: Array<number | null>, maxBuckets: number): number[] {
  const valid = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (valid.length <= maxBuckets) return valid;
  const out: number[] = [];
  const step = (valid.length - 1) / (maxBuckets - 1);
  for (let b = 0; b < maxBuckets; b++) {
    if (b === maxBuckets - 1) {
      out.push(valid[valid.length - 1]);
      continue;
    }
    const i0 = Math.floor(b * step);
    const i1 = Math.min(valid.length - 1, Math.ceil((b + 0.5) * step));
    let sum = 0;
    let count = 0;
    for (let i = i0; i <= i1; i++) {
      sum += valid[i];
      count++;
    }
    out.push(count ? sum / count : valid[i0]);
  }
  return out;
}

function traceSmoothSpline(ctx: CanvasRenderingContext2D, pts: Array<{ x: number; y: number }>): void {
  if (!pts.length) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) return;
  if (pts.length === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
    return;
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const tension = 0.22;
    const cp1x = p1.x + (p2.x - p0.x) * tension;
    let cp1y = p1.y + (p2.y - p0.y) * tension;
    const cp2x = p2.x - (p3.x - p1.x) * tension;
    let cp2y = p2.y - (p3.y - p1.y) * tension;
    const minY = Math.min(p1.y, p2.y);
    const maxY = Math.max(p1.y, p2.y);
    cp1y = Math.max(minY, Math.min(maxY, cp1y));
    cp2y = Math.max(minY, Math.min(maxY, cp2y));
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
  }
}

function drawSingleSparkCanvas(
  canvas: HTMLCanvasElement,
  values: Array<number | null>,
  minV: number,
  maxV: number,
  color: string,
  fillRgba: string,
  threshold?: { value: number; color: string }
): void {
  const { ctx, width: W, height: H } = prepareCanvas(canvas, 32);
  ctx.clearRect(0, 0, W, H);

  const padX = 4;
  const plotTop = 4;
  const plotBot = H - 4;
  const plotH = Math.max(12, plotBot - plotTop);
  const plotW = Math.max(20, W - padX * 2);

  // Subtle baseline & mid guideline
  ctx.strokeStyle = "rgba(255, 255, 255, 0.045)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const midY = Math.round(plotTop + plotH / 2) + 0.5;
  const botY = Math.round(plotBot) + 0.5;
  ctx.moveTo(padX, midY);
  ctx.lineTo(padX + plotW, midY);
  ctx.moveTo(padX, botY);
  ctx.lineTo(padX + plotW, botY);
  ctx.stroke();

  const sparkWindow = 36;
  const decimated = downsampleSeries(values, sparkWindow);
  if (!decimated.length) return;

  const lo = Math.min(minV, ...decimated);
  const hi = Math.max(maxV, ...decimated, lo + 1e-3);
  const yOf = (v: number) => plotBot - ((v - lo) / (hi - lo)) * plotH;

  // Fixed horizontal step (~3.3 px per sample on a 124px sparkline) anchored at the right edge
  // so early samples grow naturally from the right instead of stretching 2 points across the canvas.
  const stepX = plotW / (sparkWindow - 1);
  const xOf = (i: number) => padX + plotW - (decimated.length - 1 - i) * stepX;

  if (threshold && threshold.value >= lo && threshold.value <= hi) {
    const ty = Math.round(yOf(threshold.value)) + 0.5;
    ctx.strokeStyle = threshold.color;
    ctx.globalAlpha = 0.45;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padX, ty);
    ctx.lineTo(padX + plotW, ty);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  const coords = decimated.map((v, i) => ({ x: xOf(i), y: yOf(v) }));
  if (coords.length === 1) {
    coords.unshift({ x: Math.max(padX, coords[0].x - stepX), y: coords[0].y });
  }

  // Faint dotted leader from left edge when history has not filled the full sparkWindow yet
  if (coords[0].x > padX + 2) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(padX, coords[0].y);
    ctx.lineTo(coords[0].x, coords[0].y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // Soft vertical gradient fill under B-spline
  const grad = ctx.createLinearGradient(0, plotTop, 0, plotBot);
  grad.addColorStop(0, fillRgba);
  grad.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  traceBSpline(ctx, coords, true);
  ctx.lineTo(coords[coords.length - 1].x, plotBot);
  ctx.lineTo(coords[0].x, plotBot);
  ctx.closePath();
  ctx.fill();

  // Smooth B-spline stroke
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  traceBSpline(ctx, coords, true);
  ctx.stroke();

  // Single live endpoint dot on the rightmost reading
  const tip = coords[coords.length - 1];
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(tip.x, tip.y, 2.4, 0, Math.PI * 2);
  ctx.fill();
}

export function drawHealthSparklines(root: HTMLElement, health: HealthHistory, hasServer: boolean): void {
  const tokens = getThemeTokens();
  const pts = health.points;
  const last = pts.length ? pts[pts.length - 1] : null;

  const udpCard = root.querySelector<HTMLElement>('[data-health-card="udp"]');
  if (udpCard) {
    udpCard.hidden = !hasServer;
  }
  root.classList.toggle("is-three-cards", !hasServer);

  const updateCard = (
    key: "sweep" | "heap" | "udp" | "usb",
    latestText: string,
    metaText: string,
    isWarn: boolean,
    values: Array<number | null>,
    minV: number,
    maxV: number,
    color: string,
    fillRgba: string,
    threshold?: { value: number; color: string }
  ) => {
    const valEl = root.querySelector<HTMLElement>(`[data-health-val="${key}"]`);
    if (valEl) {
      valEl.textContent = latestText;
      valEl.classList.toggle("debug-tone-warn", isWarn);
    }
    const metaEl = root.querySelector<HTMLElement>(`[data-health-meta="${key}"]`);
    if (metaEl) {
      metaEl.textContent = metaText;
    }
    const c = root.querySelector<HTMLCanvasElement>(`[data-spark-canvas="${key}"]`);
    if (c) {
      drawSingleSparkCanvas(c, values, minV, maxV, color, fillRgba, threshold);
    }
  };

  const budgetMs = last ? last.sweepBudgetUs / 1000 : 7.0;
  const sweepMs = last ? last.sweepUs / 1000 : 0;
  const sweepOver = last ? last.sweepUs > last.sweepBudgetUs : false;
  const sweepVals = pts.map((p) => p.sweepUs / 1000);
  const sweepRange = sweepVals.length
    ? `${Math.min(...sweepVals).toFixed(1)}–${Math.max(...sweepVals).toFixed(1)} ms · ${budgetMs.toFixed(1)} ms budget`
    : "Waiting for data…";

  updateCard(
    "sweep",
    last ? `${sweepMs.toFixed(2)} ms` : "—",
    sweepRange,
    sweepOver,
    sweepVals,
    4.0,
    Math.max(7.8, budgetMs + 0.5),
    tokens.accent,
    "rgba(212, 255, 58, 0.14)",
    { value: budgetMs, color: tokens.warn }
  );

  const heapVals = pts.map((p) => p.heapFreeKB);
  const heapRange = last ? `Lowest ${last.heapMinKB.toFixed(0)} KB` : "Waiting for data…";
  updateCard(
    "heap",
    last ? `${last.heapFreeKB.toFixed(0)} KB` : "—",
    heapRange,
    Boolean(last && last.heapMinKB < 20),
    heapVals,
    16,
    80,
    tokens.good,
    "rgba(52, 211, 153, 0.14)",
    { value: 20, color: tokens.bad }
  );

  if (hasServer) {
    const fps = last?.framesPerSec ?? null;
    const fpsVals = pts.map((p) => p.framesPerSec);
    const validFps = fpsVals.filter((v): v is number => v !== null && Number.isFinite(v));
    const fpsRange = validFps.length
      ? `${Math.min(...validFps).toFixed(0)}–${Math.max(...validFps).toFixed(0)} frames/s`
      : "Waiting for data…";
    updateCard(
      "udp",
      fps !== null ? `${fps.toFixed(0)} / s` : "—",
      fpsRange,
      fps !== null && fps < 10,
      fpsVals,
      0,
      55,
      "#38bdf8",
      "rgba(56, 189, 248, 0.14)"
    );
  }

  const dropsTotal = pts.reduce((acc, p) => acc + p.droppedDelta, 0);
  const usbVals = pts.map((p) => p.liveRateHz);
  const usbRange = pts.length ? `${dropsTotal} dropped` : "Waiting for data…";
  updateCard(
    "usb",
    last ? `${last.liveRateHz.toFixed(0)} sweeps/s` : "—",
    usbRange,
    dropsTotal > 0,
    usbVals,
    0,
    55,
    "#c084fc",
    "rgba(192, 132, 252, 0.14)"
  );
}

// ============================================================================
// 5.7 Export helpers (CSV & PNG)
// ============================================================================

export function buildFileStamp(status: TimerStatus | null, prefix: string, ext: string): string {
  const label = (status?.label || status?.fp || "timer").replace(/[^a-zA-Z0-9_-]/g, "_");
  const iso = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `slaprf-${prefix}-${label}-${iso}.${ext}`;
}

export function downloadTextFile(filename: string, content: string, mime = "text/csv;charset=utf-8"): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCanvasPng(canvas: HTMLCanvasElement, filename: string): void {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, "image/png");
}

export function exportSignalCsv(ring: SignalRingBuffer, sweepHz = 50): string {
  const header = "n,ms,sweep_us,R1,R2,R3,R4,R5,R6,R7,R8,floor1,floor2,floor3,floor4,floor5,floor6,floor7,floor8";
  const n0 = ring.points.length ? ring.points[0].n : 0;
  const lines = ring.points.map((p) => {
    const ms = Math.round(((p.n - n0) * 1000) / sweepHz);
    return `${p.n},${ms},${p.us},${p.dbm.join(",")},${p.floor.join(",")}`;
  });
  return [header, ...lines].join("\n") + "\n";
}

export function exportScanHistoryCsv(acc: SpectrumAccumulator): string {
  if (!acc.history.length) return "";
  const last = acc.history[acc.history.length - 1];
  const freqs: number[] = [];
  for (let i = 0; i < last.dbm.length; i++) freqs.push(last.start + i * last.step);
  const header = ["timestamp", "pass_ms", ...freqs.map((f) => `${f}_MHz`)].join(",");
  const rows = acc.history.map((h) => [h.tsIso, h.passMs, ...h.dbm].join(","));
  return [header, ...rows].join("\n") + "\n";
}

// ============================================================================
// Internal tooltip helper
// ============================================================================

function drawTooltipBox(
  ctx: CanvasRenderingContext2D,
  anchorX: number,
  anchorY: number,
  lines: Array<{ text: string; color: string }>,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  tokens: ThemeTokens
): void {
  ctx.save();
  ctx.font = `11px ${tokens.fontMono}`;
  const padX = 8;
  const padY = 6;
  const lineH = 15;
  let boxW = 0;
  for (const l of lines) {
    const w = ctx.measureText(l.text).width;
    if (w > boxW) boxW = w;
  }
  boxW += padX * 2;
  const boxH = lines.length * lineH + padY * 2;

  let bx = anchorX + 12;
  if (bx + boxW > maxX) bx = anchorX - boxW - 12;
  bx = Math.max(minX + 2, Math.min(maxX - boxW - 2, bx));
  const by = Math.max(minY + 2, Math.min(maxY - boxH - 2, anchorY - boxH / 2));

  ctx.fillStyle = "rgba(17, 19, 23, 0.94)";
  ctx.strokeStyle = tokens.borderStrong;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(bx, by, boxW, boxH, 6);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  lines.forEach((l, i) => {
    ctx.fillStyle = l.color;
    ctx.fillText(l.text, bx + padX, by + padY + i * lineH);
  });
  ctx.restore();
}
