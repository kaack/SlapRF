import { LapRecord } from "../types/models";
import { AppStore } from "./store";

export function lapsFor(store: AppStore, slotIndex: number): LapRecord[] {
  return store.laps.filter((l) => l.slotIndex === slotIndex);
}

export function bestLapOf(laps: LapRecord[]): number {
  return laps.reduce((best, l) => (best === 0 || l.lapTimeSec < best ? l.lapTimeSec : best), 0);
}

export function fastestLap(store: AppStore): LapRecord | undefined {
  let fastest: LapRecord | undefined;
  for (const lap of store.laps) {
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
  if (detected?.color?.trim()) return detected.color.trim();
  const nodeWithTimer = store.nodes.find((p) => (p.assignedTimerId ?? p.gateId) === hardwareTimerId);
  if (nodeWithTimer?.color?.trim()) return nodeWithTimer.color.trim();
  return TIMER_COLORS[(hardwareTimerId - 1) % TIMER_COLORS.length];
}

/**
 * The color of a node on the track, derived from the physical timer assigned to it
 * (used consistently across the RSSI viewer, Timing Rules tabs, section records, and lap analysis).
 */
export function gateColor(store: AppStore, gateId: number): string {
  const position = store.nodes.findIndex((p) => p.gateId === gateId);
  if (position < 0) return TIMER_COLORS[0];
  const p = store.nodes[position];
  const assignedId = p.assignedTimerId ?? 0;
  if (assignedId > 0) {
    return timerColor(store, assignedId);
  }
  return p.color?.trim() || "#64748b";
}

/**
 * What a gate is called everywhere in the UI:
 *   1. Its display-name override (`name`) from the Track editor if set,
 *   2. Otherwise "Gate N" by its position on the course.
 */
export function gateLabel(store: AppStore, gateId: number): string {
  const position = store.nodes.findIndex((p) => p.gateId === gateId);
  if (position < 0) return "Unknown gate";
  const p = store.nodes[position];
  return p.name.trim() || `Gate ${position + 1}`;
}

/** The permanent hardware ID / name flashed onto a timer. */
export function timerHardwareId(p: { timerId: number; timerLabel?: string; isHub?: boolean }): string {
  return p.timerLabel?.trim() || (p.isHub ? "H1" : `T${Math.max(1, p.timerId - 1)}`);
}

/** Shown wherever timers are placed on gates (the Hub is a USB dongle that may also time a gate). */
export const HUB_ON_GATE_NOTE = "Placing the Hub on a gate makes it sweep too — keep it within USB cable reach";

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
 * The enter threshold a gate uses for a pilot: the gate's calibrated value if one is set,
 * otherwise the pilot's own (mirrors thresholdsFor in internal/tracker/thresholds.go).
 */
export function enterThresholdAt(store: AppStore, gateId: number, slotIndex: number): { dbm: number; calibrated: boolean } {
  const pos = store.pilots.findIndex((p) => p.slotIndex === slotIndex);
  const pilot = store.pilots[pos];
  const override = store.node(gateId)?.enterThresholds?.[pos] ?? 0;
  return override !== 0 ? { dbm: override, calibrated: true } : { dbm: pilot?.enterThreshold ?? -58, calibrated: false };
}

/** A pilot counts as flying if they've crossed a gate recently. */
export const ON_TRACK_WINDOW_SEC = 20;
