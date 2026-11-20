import { TimerTelemetryFrame } from "../types/models";
import { median } from "./selectors";

/** A pass must rise at least this far above the baseline to count as one. */
const MIN_PEAK_RISE_DB = 10;
/** Two peaks closer than this are the same pass (multipath wobble). */
const PEAK_SEPARATION_US = 400_000;
/** Focus manual calibration on a 120 s window ending around the latest active pass activity. */
const ACTIVE_CALIB_WINDOW_US = 120_000_000;
/** Trim leading VTX-off bench silence (>= 15 s <= -85.5 dBm) before active flying. */
const VTX_OFF_GAP_US = 15_000_000;
/** Where between the baseline and the typical pass peak the threshold sits. */
const THRESHOLD_FRACTION = 0.55;
/** Keep the threshold this far below the weaker passes so they still trigger. */
const WEAK_PASS_MARGIN_DB = 4;
/** ...and at least this far above the floor so noise never triggers it. */
const MIN_FLOOR_MARGIN_DB = 6;
/** ...and this far above the top of the noise band when valleys aren't directly measured. */
const NOISE_MARGIN_DB = 3;
/** A peak counts as a pass if it reaches this fraction of the way from floor to the strong passes. */
const PASS_PROMINENCE = 0.45;
const MIN_PASSES = 2;

export type CalibrationResult =
  | { ok: true; enterDbm: number; exitDbm: number; floorDbm: number; peakDbm: number; passes: number }
  | { ok: false; reason: string };

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

/**
 * Slices a long (up to 15-minute) telemetry buffer down to the most recent <= 120 s active pack
 * window so post-landing bench silence or an older battery pack from 10 minutes ago doesn't skew
 * the thresholds of the pack the pilot just flew.
 */
function selectRecentActiveWindow(frames: TimerTelemetryFrame[], slotPos: number, globalFloor: number): TimerTelemetryFrame[] {
  if (frames.length < 100) return frames;
  const spanUs = frames[frames.length - 1].timestampUs - frames[0].timestampUs;
  let work = frames;

  if (spanUs > ACTIVE_CALIB_WINDOW_US) {
    let lastActiveTs = frames[frames.length - 1].timestampUs;
    for (let i = frames.length - 1; i >= 0; i--) {
      const v = frames[i].rssi[slotPos];
      if (typeof v === "number" && v >= globalFloor + MIN_PEAK_RISE_DB) {
        lastActiveTs = Math.min(frames[frames.length - 1].timestampUs, frames[i].timestampUs + 5_000_000);
        break;
      }
    }
    const startTs = lastActiveTs - ACTIVE_CALIB_WINDOW_US;
    const sliced = frames.filter((f) => f.timestampUs >= startTs && f.timestampUs <= lastActiveTs);
    if (sliced.length >= 100) {
      work = sliced;
    }
  }

  // In dBm mode, trim leading >= 15 s VTX-off silence (<= -85.5 dBm) if active flying follows it.
  if (globalFloor < 0 && work.length >= 100) {
    let quietStartIdx = -1;
    let bestWakeIdx = -1;
    for (let i = 0; i < work.length; i++) {
      const v = work[i].rssi[slotPos];
      if (typeof v !== "number") continue;
      if (v <= -85.5) {
        if (quietStartIdx < 0) quietStartIdx = i;
      } else if (v >= -81.5) {
        if (quietStartIdx >= 0 && work[i].timestampUs - work[quietStartIdx].timestampUs >= VTX_OFF_GAP_US) {
          bestWakeIdx = i;
        }
        quietStartIdx = -1;
      }
    }
    if (bestWakeIdx > 0) {
      const keepCutoff = work[bestWakeIdx].timestampUs - 2_000_000;
      const postWake = work.filter((f) => f.timestampUs >= keepCutoff);
      if (postWake.length >= 100) {
        work = postWake;
      }
    }
  }

  return work;
}

/**
 * Suggests an enter and exit threshold for one pilot at one gate from recent signal history:
 * finds the baseline between passes and the peaks of the passes, then puts the threshold a bit
 * over halfway up so weaker passes still clear it while noise and neighbouring gates do not.
 */
export function suggestThreshold(frames: TimerTelemetryFrame[], slotPos: number): CalibrationResult {
  const allValues = frames.map((f) => f.rssi[slotPos]).filter((v): v is number => typeof v === "number");
  if (allValues.length < 100) return { ok: false, reason: "not enough signal recorded yet" };

  const globalSorted = [...allValues].sort((a, b) => a - b);
  const globalFloor = percentile(globalSorted, 0.2);

  const work = selectRecentActiveWindow(frames, slotPos, globalFloor);
  const values = work.map((f) => f.rssi[slotPos]).filter((v): v is number => typeof v === "number");
  const sorted = [...values].sort((a, b) => a - b);
  const floor = percentile(sorted, 0.2);
  const isDbm = floor < 0;

  // Peaks: local maxima well above the local/global floor, at least PEAK_SEPARATION_US apart.
  const peakItems: Array<{ ts: number; val: number; idx: number }> = [];
  let lastPeakTs = -Infinity;
  for (let i = 0; i < work.length; i++) {
    const v = work[i].rssi[slotPos];
    if (v === undefined || v < floor + MIN_PEAK_RISE_DB) continue;
    const ts = work[i].timestampUs;
    if (ts - lastPeakTs < PEAK_SEPARATION_US) continue;
    let isMax = true;
    for (let j = i - 1; j >= 0 && ts - work[j].timestampUs <= PEAK_SEPARATION_US; j--) {
      if ((work[j].rssi[slotPos] ?? -Infinity) > v) {
        isMax = false;
        break;
      }
    }
    for (let j = i + 1; isMax && j < work.length && work[j].timestampUs - ts <= PEAK_SEPARATION_US; j++) {
      if ((work[j].rssi[slotPos] ?? -Infinity) > v) isMax = false;
    }
    if (isMax) {
      peakItems.push({ ts, val: v, idx: i });
      lastPeakTs = ts;
    }
  }
  if (peakItems.length < MIN_PASSES) {
    return { ok: false, reason: peakItems.length ? "only one pass seen" : "no passes seen" };
  }

  // Real passes cluster near the top; bumps from the quad flying past a neighbouring gate
  // are much weaker. Keep peaks reaching PASS_PROMINENCE from baseline to strong passes.
  const strong = percentile(peakItems.map((p) => p.val).sort((a, b) => a - b), 0.9);
  const passItems = peakItems.filter((p) => p.val >= floor + PASS_PROMINENCE * (strong - floor));
  if (passItems.length < MIN_PASSES) return { ok: false, reason: "not enough clear passes" };

  // Measure actual inter-pass VTX-on valleys (> -85 dBm in dBm mode) so indoor room baselines
  // (-74 dBm) aren't dragged down to -92 dBm by pre/post-flight bench noise.
  const valleys: number[] = [];
  if (isDbm) {
    for (let k = 0; k < passItems.length - 1; k++) {
      const a = passItems[k];
      const b = passItems[k + 1];
      if (b.ts <= a.ts || b.ts - a.ts > 25_000_000) continue;
      let vMin = Infinity;
      for (let j = a.idx + 1; j < b.idx; j++) {
        const rv = work[j].rssi[slotPos];
        if (typeof rv === "number" && rv < vMin) vMin = rv;
      }
      if (Number.isFinite(vMin) && vMin > -85) {
        valleys.push(vMin);
      }
    }
  }

  const hasMeasuredValleys = valleys.length > 0;
  const sortedValleys = [...valleys].sort((a, b) => a - b);
  const activeFloor = hasMeasuredValleys ? median(sortedValleys) : floor;
  const valleyHigh = hasMeasuredValleys ? percentile(sortedValleys, 0.75) : floor;
  const noiseCeiling = percentile(sorted, hasMeasuredValleys ? 0.65 : 0.9);

  const passes = passItems.map((p) => p.val);
  const peak = median(passes);
  const weak = percentile([...passes].sort((a, b) => a - b), 0.25);
  let enter = activeFloor + THRESHOLD_FRACTION * (peak - activeFloor);
  enter = Math.min(enter, weak - WEAK_PASS_MARGIN_DB);
  enter = Math.max(
    enter,
    activeFloor + (hasMeasuredValleys ? MIN_FLOOR_MARGIN_DB : 8),
    hasMeasuredValleys ? valleyHigh + 4.5 : noiseCeiling + NOISE_MARGIN_DB
  );
  const enterDbm = Math.round(enter);
  const rawExit = Math.round(activeFloor + 0.25 * (peak - activeFloor));
  const valleyClear = hasMeasuredValleys ? Math.ceil(valleyHigh) + 2 : Math.round(activeFloor) + 4;
  const minHyst = hasMeasuredValleys ? 5 : 6;
  const exitDbm = Math.max(-105, Math.min(enterDbm - minHyst, Math.max(valleyClear, rawExit)));
  return {
    ok: true,
    enterDbm,
    exitDbm,
    floorDbm: Math.round(activeFloor),
    peakDbm: Math.round(peak),
    passes: passes.length,
  };
}
