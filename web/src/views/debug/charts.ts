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

  public push(sample: LiveSample, sweepHz = 50): void {
    const prev = this.points.length ? this.points[this.points.length - 1] : null;
    let n: number;
    if (typeof sample.n === "number") {
      n = sample.n;
      if (prev && n > prev.n + 1) {
        // In LIVE 2 (every sweep), step is 1. In LIVE 1 (~10 Hz), step is sweepHz/10 (typically 5).
        // Only count as dropped if we're in every-sweep mode or if a gap exceeds one LIVE 1 interval.
        const gap = n - prev.n - 1;
        if (gap > 0 && gap < 5000) {
          this.droppedLines += gap;
        }
      } else if (prev && n < prev.n) {
        // Timer rebooted and counter reset
        this.points = [];
        this.droppedLines = 0;
      }
      this.synthN = n;
    } else {
      const step = Math.max(1, Math.round(sweepHz / 10));
      this.synthN += step;
      n = this.synthN;
    }

    const dbm = sample.dbm.slice(0, 8);
    const floor = sample.floor ? sample.floor.slice(0, 8) : [-127, -127, -127, -127, -127, -127, -127, -127];
    const hits = sample.hits ? sample.hits.slice(0, 8) : [0, 0, 0, 0, 0, 0, 0, 0];

    this.points.push({
      n,
      us: sample.us,
      tMs: performance.now(),
      dbm,
      floor,
      hits,
    });
    if (this.points.length > MAX_SIGNAL_POINTS) {
      this.points.splice(0, this.points.length - MAX_SIGNAL_POINTS);
    }
  }

  /** Slice points within the last `windowSec` seconds (based on `n` at `sweepHz`). */
  public windowPoints(windowSec: number, sweepHz = 50): SignalPoint[] {
    if (!this.points.length) return [];
    const lastN = this.points[this.points.length - 1].n;
    const minN = lastN - Math.round(windowSec * sweepHz);
    // Binary search for minN
    let lo = 0;
    let hi = this.points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.points[mid].n < minN) lo = mid + 1;
      else hi = mid;
    }
    return this.points.slice(lo);
  }

  /** Compute per-channel statistics over the active window (§5.2, matching noise_stats.py). */
  public computeStats(
    windowSec: number,
    freqs: number[],
    pilots: PilotThresholdInfo[],
    sweepHz = 50
  ): SignalStatsSummary {
    const pts = this.windowPoints(windowSec, sweepHz);
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
      if (diff > 0) windowDrops += diff;
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
  freqs: number[];
  enabledChannels: boolean[];
  showFloor: boolean;
  showHitLine: boolean;
  showThresholds: boolean;
  pilots: PilotThresholdInfo[];
  hover: { x: number; y: number } | null;
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

  const yOf = (dbm: number) => {
    const c = Math.max(DBM_MIN, Math.min(DBM_MAX, dbm));
    return T + (1 - (c - DBM_MIN) / (DBM_MAX - DBM_MIN)) * plotH;
  };

  // Horizontal grid lines (dBm)
  ctx.font = `10px ${tokens.fontMono}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let d = DBM_MIN; d <= DBM_MAX; d += 10) {
    const y = Math.round(yOf(d)) + 0.5;
    ctx.strokeStyle = tokens.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(L, y);
    ctx.lineTo(W - R, y);
    ctx.stroke();
    ctx.fillStyle = tokens.text3;
    ctx.fillText(`${d}`, L - 6, y);
  }

  // Vertical time grid lines
  const windowSweeps = Math.max(1, Math.round(opts.windowSec * opts.sweepHz));
  const stepSec = opts.windowSec <= 15 ? 2 : opts.windowSec <= 40 ? 5 : 20;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let s = 0; s <= opts.windowSec; s += stepSec) {
    const x = Math.round(L + (1 - s / opts.windowSec) * plotW) + 0.5;
    ctx.strokeStyle = tokens.border;
    ctx.beginPath();
    ctx.moveTo(x, T);
    ctx.lineTo(x, T + plotH);
    ctx.stroke();
    ctx.fillStyle = tokens.text3;
    ctx.fillText(s === 0 ? "now" : `-${s}s`, x, T + plotH + 6);
  }

  const pts = ring.windowPoints(opts.windowSec, opts.sweepHz);
  if (!pts.length) {
    ctx.fillStyle = tokens.text3;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `12px ${tokens.fontSans}`;
    ctx.fillText("Waiting for live sweep samples…", L + plotW / 2, T + plotH / 2);
    return;
  }

  const lastN = pts[pts.length - 1].n;
  const startN = lastN - windowSweeps;
  const xOfN = (n: number) => L + ((n - startN) / windowSweeps) * plotW;

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

  // Draw each enabled channel trace; break the path when `n` jumps (dropped lines) so gaps show honestly
  const maxStepN = Math.max(2, Math.round(opts.sweepHz / 5)); // >200 ms gap breaks the line
  for (let ch = 0; ch < 8; ch++) {
    if (!opts.enabledChannels[ch]) continue;
    ctx.strokeStyle = CHANNEL_COLORS[ch];
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let penDown = false;
    let prevN = -1;
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      const v = p.dbm[ch];
      if (v === undefined || v <= -127) {
        penDown = false;
        continue;
      }
      const x = xOfN(p.n);
      const y = yOf(v);
      if (!penDown || p.n - prevN > maxStepN) {
        ctx.moveTo(x, y);
        penDown = true;
      } else {
        ctx.lineTo(x, y);
      }
      prevN = p.n;
    }
    ctx.stroke();
  }

  ctx.restore();

  // Hover readout
  if (opts.hover && opts.hover.x >= L && opts.hover.x <= W - R && opts.hover.y >= T && opts.hover.y <= T + plotH) {
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

    const ageSec = ((lastN - best.n) / opts.sweepHz).toFixed(2);
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
        ctx.fillStyle = CHANNEL_COLORS[ch];
        ctx.beginPath();
        ctx.arc(hx, yOf(v), 3.5, 0, Math.PI * 2);
        ctx.fill();
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
  private offscreen: HTMLCanvasElement | null = null;
  private wfWidth = 0;
  private readonly maxRows = 200;

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
      const [r, g, b] = dbmToRgb(dbm[i]);
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

/** Perceptual dark → blue → cyan → volt (#d4ff3a) → white palette for −100…−40 dBm (§5.3). */
export function dbmToRgb(dbm: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, (dbm - -100) / (-40 - -100)));
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
  hover: { x: number; y: number } | null;
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
    ctx.fillText("Run a scan or start Live scan to see the 5.8 GHz spectrum.", L + plotW / 2, T + plotH / 2);
    return;
  }

  const stop = s.start + s.step * (s.dbm.length - 1);
  const span = Math.max(1, stop - s.start);
  const xOf = (f: number) => L + ((f - s.start) / span) * plotW;
  const yOf = (d: number) =>
    T + (1 - (Math.max(DBM_MIN, Math.min(DBM_MAX, d)) - DBM_MIN) / (DBM_MAX - DBM_MIN)) * plotH;

  // Horizontal dBm grid
  ctx.font = `10px ${tokens.fontMono}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let d = DBM_MIN; d <= DBM_MAX; d += 10) {
    const y = Math.round(yOf(d)) + 0.5;
    ctx.strokeStyle = tokens.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(L, y);
    ctx.lineTo(W - R, y);
    ctx.stroke();
    ctx.fillStyle = tokens.text3;
    ctx.fillText(`${d}`, L - 6, y);
  }

  // Frequency ticks every 100 MHz
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let f = Math.ceil(s.start / 100) * 100; f <= stop; f += 100) {
    const x = Math.round(xOf(f)) + 0.5;
    ctx.fillStyle = tokens.text3;
    ctx.fillText(`${f}`, x, T + plotH + 6);
  }

  drawBandOverlay(ctx, s.start, stop, L, R, T, plotW, plotH, opts.showWifiOverlay, tokens);

  // Max-hold trace
  if (opts.showMaxHold && acc.maxHold && acc.maxHold.length === s.dbm.length) {
    ctx.strokeStyle = tokens.accent;
    ctx.globalAlpha = 0.32;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (let i = 0; i < acc.maxHold.length; i++) {
      const x = xOf(s.start + i * s.step);
      const y = yOf(acc.maxHold[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Running average trace
  const avg = opts.showAverage ? acc.getAverage() : null;
  if (avg && avg.length === s.dbm.length) {
    ctx.strokeStyle = "#38bdf8";
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (let i = 0; i < avg.length; i++) {
      const x = xOf(s.start + i * s.step);
      const y = yOf(avg[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Live / current scan trace
  ctx.strokeStyle = tokens.accent;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = "round";
  ctx.beginPath();
  let peakIdx = 0;
  for (let i = 0; i < s.dbm.length; i++) {
    if (s.dbm[i] > s.dbm[peakIdx]) peakIdx = i;
    const x = xOf(s.start + i * s.step);
    const y = yOf(s.dbm[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Peak dot & label
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

  // Hover readout
  if (opts.hover && opts.hover.x >= L && opts.hover.x <= W - R && opts.hover.y >= T && opts.hover.y <= T + plotH) {
    const fCursor = s.start + ((opts.hover.x - L) / plotW) * span;
    const idx = Math.max(0, Math.min(s.dbm.length - 1, Math.round((fCursor - s.start) / Math.max(1, s.step))));
    const f = s.start + idx * s.step;
    const hx = xOf(f);
    const hy = yOf(s.dbm[idx]);

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

/** Draw the scrolling Waterfall spectrogram canvas (§5.3). */
export function drawWaterfallCanvas(
  canvas: HTMLCanvasElement,
  acc: SpectrumAccumulator,
  showWifiOverlay: boolean,
  hover: { x: number; y: number } | null
): void {
  const s = acc.latest;
  const off = acc.getOffscreen();
  const tokens = getThemeTokens();
  const { ctx, width: W, height: H } = prepareCanvas(canvas, 200);
  const L = 44;
  const R = 14;
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
    ctx.fillText("Scan passes will build a waterfall history here.", L + plotW / 2, T + plotH / 2);
    return;
  }

  const stop = s.start + s.step * (s.dbm.length - 1);
  const span = Math.max(1, stop - s.start);
  const xOf = (f: number) => L + ((f - s.start) / span) * plotW;

  // Draw offscreen ImageData scaled into the plot box
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, off.width, off.height, L, T, plotW, plotH);
  ctx.restore();

  // Border around waterfall plot
  ctx.strokeStyle = tokens.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(L + 0.5, T + 0.5, plotW - 1, plotH - 1);

  // Y-axis age ticks (rows)
  const passSec = s.passMs && s.passMs > 20 ? s.passMs / 1000 : 0.32;
  const totalSec = off.height * passSec;
  ctx.fillStyle = tokens.text3;
  ctx.font = `10px ${tokens.fontMono}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText("now", L - 6, T + 6);
  ctx.fillText(`-${Math.round(totalSec / 2)}s`, L - 6, T + plotH / 2);
  ctx.fillText(`-${Math.round(totalSec)}s`, L - 6, T + plotH - 6);

  // X-axis frequency ticks
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let f = Math.ceil(s.start / 100) * 100; f <= stop; f += 100) {
    const x = Math.round(xOf(f)) + 0.5;
    ctx.fillStyle = tokens.text3;
    ctx.fillText(`${f}`, x, T + plotH + 6);
  }

  drawBandOverlay(ctx, s.start, stop, L, R, T, plotW, plotH, showWifiOverlay, tokens);

  // Hover readout (MHz, dBm, age)
  if (hover && hover.x >= L && hover.x <= W - R && hover.y >= T && hover.y <= T + plotH) {
    const fCursor = s.start + ((hover.x - L) / plotW) * span;
    const binIdx = Math.max(0, Math.min(s.dbm.length - 1, Math.round((fCursor - s.start) / Math.max(1, s.step))));
    const rowIdx = Math.max(0, Math.min(off.height - 1, Math.floor(((hover.y - T) / plotH) * off.height)));
    const f = s.start + binIdx * s.step;
    const histIdx = acc.history.length - 1 - rowIdx;
    const histRow = histIdx >= 0 ? acc.history[histIdx] : null;
    const dbmVal = histRow ? histRow.dbm[binIdx] : null;
    const age = (rowIdx * passSec).toFixed(1);

    const tipLines: Array<{ text: string; color: string }> = [
      { text: `${f} MHz  (${nearestBandHint(f)})`, color: tokens.text },
      { text: dbmVal !== null && dbmVal !== undefined ? `${dbmVal} dBm · -${age} s (row #${rowIdx + 1})` : `-${age} s`, color: tokens.accent },
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

export function drawHealthSparklines(canvas: HTMLCanvasElement, health: HealthHistory, hasServer: boolean): void {
  const tokens = getThemeTokens();
  const rect = canvas.getBoundingClientRect();
  const isMobile = (rect.width || canvas.clientWidth || 720) < 560;
  const totalCells = hasServer ? 4 : 3;
  const cols = isMobile ? 2 : totalCells;
  const rows = Math.ceil(totalCells / cols);
  const { ctx, width: W, height: H } = prepareCanvas(canvas, rows === 2 ? 250 : 132);
  ctx.clearRect(0, 0, W, H);

  const pts = health.points;
  const gap = 12;
  const cellW = (W - gap * (cols - 1)) / cols;
  const cellH = (H - gap * (rows - 1) - 4) / rows;

  const drawCell = (
    idx: number,
    title: string,
    latestText: string,
    latestTone: string,
    values: Array<number | null>,
    minV: number,
    maxV: number,
    color: string,
    threshold?: { value: number; color: string; label: string }
  ) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x0 = col * (cellW + gap);
    const y0 = 2 + row * (cellH + gap);
    const padX = 10;
    const plotTop = y0 + 36;
    const plotBot = y0 + cellH - 8;
    const plotH = Math.max(12, plotBot - plotTop);
    const plotW = Math.max(10, cellW - padX * 2);

    ctx.fillStyle = tokens.surface2;
    ctx.strokeStyle = tokens.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x0 + 0.5, y0 + 0.5, cellW - 1, cellH - 1, 7);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = tokens.text3;
    ctx.font = `11px ${tokens.fontSans}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(title, x0 + padX, y0 + 7);

    ctx.fillStyle = latestTone;
    ctx.font = `600 12px ${tokens.fontMono}`;
    ctx.fillText(latestText, x0 + padX, y0 + 21);

    const valid = values.filter((v): v is number => v !== null && Number.isFinite(v));
    if (valid.length < 2) return;

    const lo = Math.min(minV, ...valid);
    const hi = Math.max(maxV, ...valid, lo + 1e-3);
    const yOf = (v: number) => plotBot - ((v - lo) / (hi - lo)) * plotH;
    const xOf = (i: number) => x0 + padX + (i / Math.max(1, values.length - 1)) * plotW;

    if (threshold && threshold.value >= lo && threshold.value <= hi) {
      const ty = Math.round(yOf(threshold.value)) + 0.5;
      ctx.strokeStyle = threshold.color;
      ctx.globalAlpha = 0.55;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x0 + padX, ty);
      ctx.lineTo(x0 + padX + plotW, ty);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null || !Number.isFinite(v)) {
        started = false;
        continue;
      }
      const x = xOf(i);
      const y = yOf(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Mark budget overruns on cell 0
    if (threshold) {
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v !== null && v > threshold.value) {
          ctx.fillStyle = tokens.warn;
          ctx.beginPath();
          ctx.arc(xOf(i), yOf(v), 2.3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  };

  const last = pts.length ? pts[pts.length - 1] : null;
  const budgetMs = last ? last.sweepBudgetUs / 1000 : 7.0;
  const sweepMs = last ? last.sweepUs / 1000 : 0;
  const sweepOver = last ? last.sweepUs > last.sweepBudgetUs : false;

  drawCell(
    0,
    "Sweep duration",
    last ? `${sweepMs.toFixed(2)} ms / ${budgetMs.toFixed(1)} ms` : "—",
    sweepOver ? tokens.warn : tokens.text,
    pts.map((p) => p.sweepUs / 1000),
    4.5,
    Math.max(7.8, budgetMs + 0.5),
    tokens.accent,
    { value: budgetMs, color: tokens.warn, label: "budget" }
  );

  drawCell(
    1,
    "Free heap",
    last ? `${last.heapFreeKB.toFixed(0)} KB (min ${last.heapMinKB.toFixed(0)})` : "—",
    last && last.heapMinKB < 20 ? tokens.warn : tokens.text,
    pts.map((p) => p.heapFreeKB),
    16,
    80,
    tokens.good,
    { value: 20, color: tokens.bad, label: "20 KB" }
  );

  let col = 2;
  if (hasServer) {
    const fps = last?.framesPerSec ?? null;
    drawCell(
      col++,
      "Laptop UDP link",
      fps !== null ? `${fps.toFixed(0)} frames/s` : "—",
      fps !== null && fps < 10 ? tokens.warn : tokens.text,
      pts.map((p) => p.framesPerSec),
      0,
      55,
      "#38bdf8"
    );
  }

  const dropsTotal = pts.reduce((acc, p) => acc + p.droppedDelta, 0);
  drawCell(
    col,
    "USB live stream",
    last ? `${last.liveRateHz.toFixed(0)}/s · ${dropsTotal} dropped` : "—",
    dropsTotal > 0 ? tokens.warn : tokens.text,
    pts.map((p) => p.liveRateHz),
    0,
    55,
    "#c084fc"
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
