import { adaptColorForTheme } from "../core/theme";
import { LapRecord } from "../types/models";
import { AppStore } from "./store";

export function lapsFor(store: AppStore, slotIndex: number): LapRecord[] {
  return store.laps.filter((l) => l.slotIndex === slotIndex && !l.invalidated);
}

export function allLapsFor(store: AppStore, slotIndex: number): LapRecord[] {
  return store.laps.filter((l) => l.slotIndex === slotIndex);
}

export function bestLapOf(laps: LapRecord[]): number {
  return laps.reduce((best, l) => (best === 0 || l.lapTimeSec < best ? l.lapTimeSec : best), 0);
}

export function fastestLap(store: AppStore): LapRecord | undefined {
  let fastest: LapRecord | undefined;
  for (const lap of store.laps) {
    if (lap.invalidated) continue;
    if (!fastest || lap.lapTimeSec < fastest.lapTimeSec) fastest = lap;
  }
  return fastest;
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Index (0-based, track order) of the sector the pilot is currently flying, or -1 if unknown. */
export function currentSectorIndex(store: AppStore, slotIndex: number): number {
  const last = store.lastCrossingFor(slotIndex);
  if (!last) return -1;
  return store.nodes.findIndex((p) => p.gateId === last.gateId);
}

/** Seconds since the pilot last crossed any gate (Infinity if never). */
export function secondsSinceSeen(store: AppStore, slotIndex: number): number {
  const last = store.lastCrossingFor(slotIndex);
  if (!last || store.latestTimestampUs === 0) return Infinity;
  return Math.max(0, (store.latestTimestampUs - last.timestampUs) / 1e6);
}

/** Canonical palette of timer colors, originating from the Timers section in System. */
export const TIMER_COLORS = [
  "#d4ff3a",
  "#38bdf8",
  "#f472b6",
  "#fb923c",
  "#a78bfa",
  "#2dd4bf",
  "#facc15",
  "#f87171",
  "#4ade80",
  "#60a5fa",
  "#e879f9",
  "#ffffff",
];
export const GATE_COLORS = TIMER_COLORS;

/**
 * The color assigned to a physical timer in the Timers section in System.
 */
export function timerColor(store: AppStore, hardwareTimerId: number): string {
  if (!hardwareTimerId || hardwareTimerId <= 0) return "#64748b";
  const detected = store.detectedTimers.find((d) => d.timerId === hardwareTimerId);
  if (detected?.color?.trim()) return adaptColorForTheme(detected.color.trim());
  const nodeWithTimer = store.nodes.find((p) => (p.assignedTimerId ?? p.gateId) === hardwareTimerId);
  if (nodeWithTimer?.color?.trim()) return adaptColorForTheme(nodeWithTimer.color.trim());
  return adaptColorForTheme(TIMER_COLORS[(hardwareTimerId - 1) % TIMER_COLORS.length]);
}

/**
 * The color of a node on the track, derived from the physical timer assigned to it
 * (used consistently across the RSSI viewer, Timing Rules tabs, section records, and lap analysis).
 */
export function gateColor(store: AppStore, gateId: number): string {
  const position = store.nodes.findIndex((p) => p.gateId === gateId);
  if (position < 0) return adaptColorForTheme(TIMER_COLORS[0]);
  const p = store.nodes[position];
  const assignedId = p.assignedTimerId ?? 0;
  if (store.isHistoricalTrack) {
    if (p.color?.trim()) return adaptColorForTheme(p.color.trim());
    if (assignedId > 0) return adaptColorForTheme(TIMER_COLORS[(assignedId - 1) % TIMER_COLORS.length]);
    return "#64748b";
  }
  if (assignedId > 0) {
    return timerColor(store, assignedId);
  }
  return p.color?.trim() ? adaptColorForTheme(p.color.trim()) : "#64748b";
}

/**
 * What a timer on the track is called everywhere in the UI:
 * its flashed timer label (e.g. "T1", "H1"), custom name override if any,
 * or default hardware ID ("H1" for Hub, "T1".."T6" for Spokes).
 */
export function gateLabel(store: AppStore, gateId: number): string {
  const position = store.nodes.findIndex((p) => p.gateId === gateId);
  if (position < 0) return `T${gateId}`;
  const p = store.nodes[position];
  const assignedId = p.assignedTimerId ?? 0;
  const custom = p.name?.trim();
  if (custom) return custom;
  if (store.isHistoricalTrack) {
    const snapLbl = p.timerLabel?.trim();
    if (snapLbl) return snapLbl;
    if (assignedId > 0) {
      return assignedId === 1 ? "H1" : `T${Math.max(1, assignedId - 1)}`;
    }
    return `T${position + 1}`;
  }
  const detected = assignedId > 0 ? store.detectedTimers.find((d) => d.timerId === assignedId) : undefined;
  const lbl = detected?.timerLabel?.trim() || p.timerLabel?.trim();
  if (lbl) return lbl;
  if (assignedId > 0) {
    return detected?.isHub || assignedId === 1 ? "H1" : `T${Math.max(1, assignedId - 1)}`;
  }
  return `T${position + 1}`;
}

/** The permanent hardware ID / name flashed onto a timer. */
export function timerHardwareId(p: { timerId: number; timerLabel?: string; isHub?: boolean }): string {
  return p.timerLabel?.trim() || (p.isHub ? "H1" : `T${Math.max(1, p.timerId - 1)}`);
}

/** Shown wherever timers are placed on the track (the Hub is a USB dongle that may also time on the track). */
export const HUB_ON_GATE_NOTE = "Placing the Hub on the track makes it time passes too (keep it within USB cable reach).";

/** True when the timer is currently assigned to a gate on the active course. */
export function timerHasGate(store: AppStore, timerId: number): boolean {
  return timerId > 0 && store.nodes.some((n) => (n.assignedTimerId ?? 0) === timerId);
}

/**
 * Role text for a timer: "Hub" or "Spoke".
 */
export function timerRoleText(_store: AppStore, d: { timerId: number; isHub: boolean }): string {
  return d.isHub ? "Hub" : "Spoke";
}

/** "Gate 2 → Split-S" style label for the stretch of track between two gates. */
export function sectionLabel(store: AppStore, fromGateId: number, toGateId: number): string {
  return `${gateLabel(store, fromGateId)} → ${gateLabel(store, toGateId)}`;
}

/** Compact "S1", "S2"… for the section that starts at this gate (for narrow table headers). */
export function sectionShort(store: AppStore, fromGateId: number): string {
  const position = store.nodes.findIndex((p) => p.gateId === fromGateId);
  return position < 0 ? "S?" : `S${position + 1}`;
}

/**
 * The LapRF crossing threshold (300..3500) a gate uses for a pilot: the gate's calibrated
 * override if set, otherwise the pilot's own `laprfThreshold` (default 800).
 */
export function laprfThresholdAt(
  store: AppStore,
  gateId: number,
  slotIndex: number
): { dbm: number; calibrated: boolean } {
  const pos = store.pilots.findIndex((p) => p.slotIndex === slotIndex);
  const pilot = store.pilots[pos];
  const override = store.node(gateId)?.laprfThresholds?.[pos] ?? 0;
  if (override > 0) {
    return { dbm: override, calibrated: true };
  }
  const base = pilot?.laprfThreshold && pilot.laprfThreshold > 0 ? pilot.laprfThreshold : 800;
  return { dbm: base, calibrated: false };
}

/**
 * Scales a SlapRF dBm enter threshold (-95..-20, default -58) onto RotorHazard's
 * 0..255 RX5808 RSSI scale (default 95, 2.5 units per dB).
 */
export function dbmToRHEnter(dbm: number): number {
  if (!Number.isFinite(dbm) || dbm === 0) return 95;
  return Math.max(10, Math.min(250, Math.round(95 + (dbm + 58) * 2.5)));
}

/**
 * Scales a SlapRF dBm exit threshold onto RotorHazard's 0..255 RSSI scale.
 */
export function dbmToRHExit(dbm: number, rhEnter: number): number {
  const maxExit = Math.max(6, rhEnter - 4);
  if (!Number.isFinite(dbm) || dbm === 0) return Math.max(6, Math.min(maxExit, rhEnter - 25));
  return Math.max(6, Math.min(maxExit, Math.round(95 + (dbm + 58) * 2.5)));
}

/**
 * The RotorHazard Enter / Exit hysteresis thresholds (10..250, gap >= 4) a gate uses for a pilot:
 * the gate's calibrated override if set, otherwise the pilot's own `rhEnterThreshold` / `rhExitThreshold`
 * (falling back to scaled dBm thresholds or defaults 95 / 70).
 */
export function rhThresholdAt(
  store: AppStore,
  gateId: number,
  slotIndex: number
): { enter: number; exit: number; enterCalibrated: boolean; exitCalibrated: boolean } {
  const pos = store.pilots.findIndex((p) => p.slotIndex === slotIndex);
  const pilot = store.pilots[pos];
  const node = store.node(gateId);
  const rawOverrideEnter = node?.rhEnterThresholds?.[pos] ?? 0;
  const rawOverrideExit = node?.rhExitThresholds?.[pos] ?? 0;
  const overrideEnter =
    rawOverrideEnter > 0
      ? rawOverrideEnter
      : node?.enterThresholds?.[pos]
        ? dbmToRHEnter(node.enterThresholds[pos])
        : 0;
  const baseEnter =
    pilot?.rhEnterThreshold && pilot.rhEnterThreshold > 0
      ? pilot.rhEnterThreshold
      : dbmToRHEnter(pilot?.enterThreshold ?? -58);
  const baseExit =
    pilot?.rhExitThreshold && pilot.rhExitThreshold > 0
      ? pilot.rhExitThreshold
      : dbmToRHExit(pilot?.exitThreshold ?? -68, baseEnter);

  const enter = Math.max(
    10,
    Math.min(250, Math.round(overrideEnter > 0 ? overrideEnter : baseEnter))
  );
  const overrideExit =
    rawOverrideExit > 0
      ? rawOverrideExit
      : node?.exitThresholds?.[pos]
        ? dbmToRHExit(node.exitThresholds[pos], enter)
        : 0;
  let exit: number;
  if (overrideExit > 0) {
    exit = Math.max(6, Math.min(enter - 4, Math.round(overrideExit)));
  } else if (overrideEnter > 0) {
    const gap = Math.max(4, Math.round(baseEnter - baseExit));
    exit = Math.max(6, Math.min(enter - 4, enter - gap));
  } else {
    exit = Math.max(6, Math.min(enter - 4, Math.round(baseExit)));
  }
  return {
    enter,
    exit,
    enterCalibrated: overrideEnter > 0,
    exitCalibrated: overrideExit > 0,
  };
}

/**
 * The enter threshold a gate uses for a pilot: the gate's calibrated value if one is set,
 * otherwise the pilot's own (mirrors thresholdsFor in internal/tracker/thresholds.go).
 */
export function enterThresholdAt(store: AppStore, gateId: number, slotIndex: number): { dbm: number; calibrated: boolean } {
  if (store.timingHardwareMode === "laprf" || store.timingHardwareMode === "laprf_usb") {
    return laprfThresholdAt(store, gateId, slotIndex);
  }
  if (store.timingHardwareMode === "rotorhazard" || store.timingHardwareMode === "rotorhazard_usb") {
    const rh = rhThresholdAt(store, gateId, slotIndex);
    return { dbm: rh.enter, calibrated: rh.enterCalibrated };
  }
  const pos = store.pilots.findIndex((p) => p.slotIndex === slotIndex);
  const pilot = store.pilots[pos];
  const override = store.node(gateId)?.enterThresholds?.[pos] ?? 0;
  return override !== 0 ? { dbm: override, calibrated: true } : { dbm: pilot?.enterThreshold ?? -58, calibrated: false };
}

/**
 * The exit threshold a gate uses for a pilot: the gate's calibrated exit value if set,
 * otherwise derived from the pilot's exit threshold / hysteresis gap clamped <= enter - 2 dB
 * (mirrors thresholdsFor in internal/tracker/thresholds.go).
 */
export function exitThresholdAt(store: AppStore, gateId: number, slotIndex: number): { dbm: number; calibrated: boolean } {
  if (store.timingHardwareMode === "rotorhazard" || store.timingHardwareMode === "rotorhazard_usb") {
    const rh = rhThresholdAt(store, gateId, slotIndex);
    return { dbm: rh.exit, calibrated: rh.exitCalibrated };
  }
  const pos = store.pilots.findIndex((p) => p.slotIndex === slotIndex);
  const pilot = store.pilots[pos];
  const enter = enterThresholdAt(store, gateId, slotIndex).dbm;
  const node = store.node(gateId);
  const overrideExit = node?.exitThresholds?.[pos] ?? 0;
  if (overrideExit !== 0) {
    return { dbm: Math.max(-105, Math.min(enter - 2, overrideExit)), calibrated: true };
  }
  const pilotEnter = pilot?.enterThreshold ?? -58;
  const pilotExit = pilot?.exitThreshold ?? (pilotEnter - 10);
  const overrideEnter = node?.enterThresholds?.[pos] ?? 0;
  if (overrideEnter !== 0) {
    const gap = Math.max(2, pilotEnter - pilotExit);
    return { dbm: Math.max(-105, enter - gap), calibrated: false };
  }
  return { dbm: Math.max(-105, Math.min(enter - 2, pilotExit)), calibrated: false };
}

/** A pilot counts as flying if they've crossed a gate recently. */
export const ON_TRACK_WINDOW_SEC = 20;

/** Returns the per-pilot timing-rule overrides stored on `node` for `slotIndex` (if any). */
export function pilotGateOverridesAt(node: TrackNode | undefined, slotIndex: number): GateRuleOverrides {
  if (!node?.pilotRuleOverrides || slotIndex <= 0) return {};
  return (
    node.pilotRuleOverrides[slotIndex] ??
    (node.pilotRuleOverrides as unknown as Record<string, GateRuleOverrides>)[String(slotIndex)] ??
    {}
  );
}

/** Resolves Tier 2 rules at `gateId`: Global rules + Gate-wide overrides (all pilots at this timer). */
export function gateRulesAt(store: AppStore, gateId: number): TimingRules {
  const base = store.rules;
  const o = store.node(gateId)?.ruleOverrides ?? {};
  const minLapSec = o.minLapSec ?? base.minLapSec;
  const rawMax = o.maxLapSec ?? base.maxLapSec;
  return {
    minLapSec,
    maxLapSec: Math.max(rawMax, minLapSec + 5),
    minCrossingSec: o.minCrossingSec ?? base.minCrossingSec,
    beepOnCross: o.beepOnCross !== undefined ? o.beepOnCross : Boolean(base.beepOnCross),
  };
}

/** Resolves Tier 3 rules for `(gateId, slotIndex)`: Global -> Gate-wide -> Pilot-at-Gate overrides. */
export function pilotGateRulesAt(store: AppStore, gateId: number, slotIndex: number): TimingRules {
  const gateEff = gateRulesAt(store, gateId);
  const po = pilotGateOverridesAt(store.node(gateId), slotIndex);
  const minLapSec = po.minLapSec ?? gateEff.minLapSec;
  const rawMax = po.maxLapSec ?? gateEff.maxLapSec;
  return {
    minLapSec,
    maxLapSec: Math.max(rawMax, minLapSec + 5),
    minCrossingSec: po.minCrossingSec ?? gateEff.minCrossingSec,
    beepOnCross: po.beepOnCross !== undefined ? po.beepOnCross : Boolean(gateEff.beepOnCross),
  };
}

/** Reports whether any global, gate-wide, or per-pilot rule currently has `beepOnCross` enabled. */
export function hasAnyBeepOnCrossConfigured(store: AppStore): boolean {
  if (store.rules.beepOnCross) return true;
  for (const n of store.nodes) {
    if (n.ruleOverrides?.beepOnCross === true) return true;
    if (n.pilotRuleOverrides) {
      for (const po of Object.values(n.pilotRuleOverrides)) {
        if (po?.beepOnCross === true) return true;
      }
    }
  }
  return false;
}
