import { PuckTelemetryFrame } from "../types/models";
import { median } from "./selectors";

/** A pass must rise at least this far above the noise floor to count as one. */
const MIN_PEAK_RISE_DB = 12;
/** Two peaks closer than this are the same pass (multipath wobble). */
const PEAK_SEPARATION_US = 400_000;
/** Where between the noise floor and the typical pass peak the threshold sits. */
const THRESHOLD_FRACTION = 0.55;
/** Keep the threshold this far below the weaker passes so they still trigger. */
const WEAK_PASS_MARGIN_DB = 4;
/** …and at least this far above the floor so noise never triggers it. */
const MIN_FLOOR_MARGIN_DB = 8;
/** …and this far above the top of the noise band. */
const NOISE_MARGIN_DB = 3;
/** A peak counts as a pass if it reaches this fraction of the way from floor to the strong passes. */
const PASS_PROMINENCE = 0.5;
const MIN_PASSES = 2;

export type CalibrationResult =
  | { ok: true; enterDbm: number; floorDbm: number; peakDbm: number; passes: number }
  | { ok: false; reason: string };

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

/**
 * Suggests an enter threshold for one pilot at one gate from recent signal history:
 * finds the noise floor (quiet signal between passes) and the peaks of the passes, then
 * puts the threshold a bit over halfway up — low enough that weaker passes still clear
 * it, high enough above the floor that noise and neighbouring gates don't.
 */
export function suggestThreshold(frames: PuckTelemetryFrame[], slotPos: number): CalibrationResult {
  const values = frames.map((f) => f.rssi[slotPos]).filter((v): v is number => typeof v === "number");
  if (values.length < 100) return { ok: false, reason: "not enough signal recorded yet" };

  const sorted = [...values].sort((a, b) => a - b);
  const floor = percentile(sorted, 0.2);

  // Peaks: local maxima well above the floor, at least PEAK_SEPARATION_US apart.
  const peaks: number[] = [];
  let lastPeakTs = -Infinity;
  for (let i = 0; i < frames.length; i++) {
    const v = frames[i].rssi[slotPos];
    if (v === undefined || v < floor + MIN_PEAK_RISE_DB) continue;
    const ts = frames[i].timestampUs;
    if (ts - lastPeakTs < PEAK_SEPARATION_US) continue;
    let isMax = true;
    for (let j = i - 1; j >= 0 && ts - frames[j].timestampUs <= PEAK_SEPARATION_US; j--) {
      if ((frames[j].rssi[slotPos] ?? -Infinity) > v) { isMax = false; break; }
    }
    for (let j = i + 1; isMax && j < frames.length && frames[j].timestampUs - ts <= PEAK_SEPARATION_US; j++) {
      if ((frames[j].rssi[slotPos] ?? -Infinity) > v) isMax = false;
    }
    if (isMax) {
      peaks.push(v);
      lastPeakTs = ts;
    }
  }
  if (peaks.length < MIN_PASSES) return { ok: false, reason: peaks.length ? "only one pass seen" : "no passes seen" };

  // Real passes cluster near the top; bumps from the quad flying past a neighbouring gate
  // are much weaker. Keep peaks at least halfway between the floor and the strong passes.
  const strong = percentile([...peaks].sort((a, b) => a - b), 0.9);
  const passes = peaks.filter((p) => p >= floor + PASS_PROMINENCE * (strong - floor));
  if (passes.length < MIN_PASSES) return { ok: false, reason: "not enough clear passes" };

  // Passes are a small share of the time (well under 10%), so the 90th percentile of all
  // samples is the top of the noise / approach band. Stay clear of it.
  const noiseCeiling = percentile(sorted, 0.9);

  const peak = median(passes);
  const weak = percentile([...passes].sort((a, b) => a - b), 0.25);
  let enter = floor + THRESHOLD_FRACTION * (peak - floor);
  enter = Math.min(enter, weak - WEAK_PASS_MARGIN_DB);
  enter = Math.max(enter, floor + MIN_FLOOR_MARGIN_DB, noiseCeiling + NOISE_MARGIN_DB);
  return { ok: true, enterDbm: Math.round(enter), floorDbm: Math.round(floor), peakDbm: Math.round(peak), passes: passes.length };
}
