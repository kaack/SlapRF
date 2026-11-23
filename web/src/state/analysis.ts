import { LapRecord, PilotSlot, SectorBadge } from "../types/models";
import { allLapsFor, bestLapOf, lapsFor, mean, median, ON_TRACK_WINDOW_SEC, secondsSinceSeen } from "./selectors";
import { AppStore } from "./store";

// ---------------------------------------------------------------------------
// Practice progress
// ---------------------------------------------------------------------------

export const ROLLING_WINDOW = 5;

export interface PracticeStats {
  pilot: PilotSlot;
  laps: LapRecord[];
  lastLap: number;
  bestLap: number;
  /** Mean of the most recent ROLLING_WINDOW laps. */
  rollingAvg: number;
  /** Rolling average now minus the window before it; negative = getting faster. */
  trend: number;
  onTrack: boolean;
  secondsSinceSeen: number;
}

export function practiceStats(store: AppStore, pilot: PilotSlot): PracticeStats {
  const laps = lapsFor(store, pilot.slotIndex);
  const times = laps.map((l) => l.lapTimeSec);
  const recent = times.slice(-ROLLING_WINDOW);
  const previous = times.slice(-ROLLING_WINDOW * 2, -ROLLING_WINDOW);
  const sessionLive = store.isScopeLive;
  const seen = sessionLive ? secondsSinceSeen(store, pilot.slotIndex) : Infinity;
  return {
    pilot,
    laps,
    lastLap: times.length ? times[times.length - 1] : 0,
    bestLap: bestLapOf(laps),
    rollingAvg: mean(recent),
    trend: recent.length === ROLLING_WINDOW && previous.length === ROLLING_WINDOW ? mean(recent) - mean(previous) : NaN,
    onTrack: sessionLive && seen <= ON_TRACK_WINDOW_SEC,
    secondsSinceSeen: seen,
  };
}

/** Rolling mean for each lap (window ends at that lap). */
export function rollingAverages(laps: LapRecord[], window = ROLLING_WINDOW): number[] {
  return laps.map((_, i) => mean(laps.slice(Math.max(0, i - window + 1), i + 1).map((l) => l.lapTimeSec)));
}

// ---------------------------------------------------------------------------
// Lap vs. lap comparison
// ---------------------------------------------------------------------------

/** Sections are identified by their gate pair so laps with a missed gate never misalign. */
export const sectionKey = (fromGateId: number, toGateId: number): string => `${fromGateId}>${toGateId}`;

export interface SectionDelta {
  key: string;
  fromGateId: number;
  toGateId: number;
  lapSec: number;
  refSec: number;
  /** lap − reference: positive = time lost, negative = time gained. */
  delta: number;
  lapExitMph: number;
  refExitMph: number;
}

export interface LapComparison {
  lap: LapRecord;
  ref: LapRecord;
  refLabel: string;
  sections: SectionDelta[];
  totalDelta: number;
  /** True when one of the laps missed a gate, so some sections can't be compared. */
  incomplete: boolean;
}

export function resolveComparison(store: AppStore, slotIndex: number): LapComparison | null {
  const laps = lapsFor(store, slotIndex);
  if (laps.length < 2) return null;

  const { lapId, reference } = store.comparison;
  const lap = (lapId !== null && laps.find((l) => l.lapId === lapId)) || laps[laps.length - 1];
  const lapIdx = laps.indexOf(lap);
  const others = laps.filter((l) => l.lapId !== lap.lapId);

  let ref: LapRecord | undefined;
  let refLabel = "";
  if (typeof reference === "number") {
    ref = others.find((l) => l.lapId === reference);
    if (ref) refLabel = `Lap ${ref.lapNumber}`;
  } else if (reference === "previous" && lapIdx > 0) {
    ref = laps[lapIdx - 1];
    refLabel = `Lap ${ref.lapNumber} (previous)`;
  }
  if (!ref) {
    ref = others.reduce((b, l) => (l.lapTimeSec < b.lapTimeSec ? l : b), others[0]);
    const lapIsBest = lap.lapTimeSec <= ref.lapTimeSec;
    refLabel = `Lap ${ref.lapNumber} (${lapIsBest ? "next best" : "best"})`;
  }

  const gates = store.nodes;
  const courseKeys = new Set(
    gates.length > 0 ? gates.map((p, i) => sectionKey(p.gateId, gates[(i + 1) % gates.length].gateId)) : []
  );
  const lapSectors = lap.sectors ?? [];
  const refSectors = ref.sectors ?? [];
  const refByKey = new Map(refSectors.map((s) => [sectionKey(s.fromGateId, s.toGateId), s]));
  const sections: SectionDelta[] = [];
  for (const s of lapSectors) {
    const key = sectionKey(s.fromGateId, s.toGateId);
    if (!courseKeys.has(key)) continue;
    const r = refByKey.get(key);
    if (!r) continue;
    sections.push({
      key,
      fromGateId: s.fromGateId,
      toGateId: s.toGateId,
      lapSec: s.splitSeconds,
      refSec: r.splitSeconds,
      delta: s.splitSeconds - r.splitSeconds,
      lapExitMph: s.exitSpeedMph,
      refExitMph: r.exitSpeedMph,
    });
  }

  return {
    lap,
    ref,
    refLabel,
    sections,
    totalDelta: lap.lapTimeSec - ref.lapTimeSec,
    incomplete: sections.length < Math.max(lapSectors.length, refSectors.length),
  };
}

/** The section that contributed most to the overall gain (or loss) of the compared lap. */
export function decisiveSection(cmp: LapComparison): SectionDelta | undefined {
  const sign = cmp.totalDelta >= 0 ? 1 : -1;
  return cmp.sections.reduce<SectionDelta | undefined>(
    (best, s) => (s.delta * sign > (best ? best.delta * sign : 0) ? s : best),
    undefined
  );
}

// ---------------------------------------------------------------------------
// Consistency: typical time vs. own best, per section
// ---------------------------------------------------------------------------

export interface SectionConsistency {
  key: string;
  fromGateId: number;
  toGateId: number;
  samples: number;
  best: number;
  typical: number;
  /** typical − best: time usually given away vs. the pilot's own best on this stretch. */
  givenAway: number;
  typicalExitMph: number;
  bestExitMph: number;
}

export function sectionConsistency(store: AppStore, slotIndex: number): SectionConsistency[] {
  const gates = store.nodes;
  if (gates.length === 0) return [];

  const groups = new Map<string, { from: number; to: number; times: number[]; exits: number[]; bestExit: number; best: number }>();
  for (let i = 0; i < gates.length; i++) {
    const from = gates[i].gateId;
    const to = gates[(i + 1) % gates.length].gateId;
    if (from === to) continue;
    groups.set(sectionKey(from, to), { from, to, times: [], exits: [], bestExit: 0, best: Infinity });
  }

  for (const lap of lapsFor(store, slotIndex)) {
    for (const s of lap.sectors ?? []) {
      const g = groups.get(sectionKey(s.fromGateId, s.toGateId));
      if (!g) continue;
      g.times.push(s.splitSeconds);
      g.exits.push(s.exitSpeedMph);
      if (s.splitSeconds < g.best) {
        g.best = s.splitSeconds;
        g.bestExit = s.exitSpeedMph;
      }
    }
  }

  return [...groups.entries()]
    .filter(([, g]) => g.times.length > 0)
    .map(([key, g]) => {
      const typical = median(g.times);
      return {
        key,
        fromGateId: g.from,
        toGateId: g.to,
        samples: g.times.length,
        best: g.best,
        typical,
        givenAway: typical - g.best,
        typicalExitMph: median(g.exits),
        bestExitMph: g.bestExit,
      };
    });
}

/** Sum of the pilot's best time on each section — the lap they could fly by linking them. */
export function bestPossibleLap(store: AppStore, slotIndex: number): number {
  const sections = sectionConsistency(store, slotIndex);
  return sections.length === store.nodes.length && sections.length > 0 ? sections.reduce((s, c) => s + c.best, 0) : 0;
}

// ---------------------------------------------------------------------------
// Session-wide metrics
// ---------------------------------------------------------------------------

export interface SectionRecord {
  key: string;
  fromGateId: number;
  toGateId: number;
  /** Each pilot's best on this section. */
  bests: Map<number, { sec: number; exitMph: number }>;
  recordSlot: number | null;
  recordSec: number;
}

/** For every section of the track: each pilot's best, and who holds the record. */
export function sectionRecords(store: AppStore): SectionRecord[] {
  const gates = store.nodes;
  const records: SectionRecord[] = gates.map((p, i) => {
    const to = gates[(i + 1) % gates.length];
    return { key: sectionKey(p.gateId, to.gateId), fromGateId: p.gateId, toGateId: to.gateId, bests: new Map(), recordSlot: null, recordSec: 0 };
  });
  const byKey = new Map(records.map((r) => [r.key, r]));
  for (const lap of store.laps) {
    if (lap.invalidated) continue;
    for (const s of lap.sectors ?? []) {
      const r = byKey.get(sectionKey(s.fromGateId, s.toGateId));
      if (!r) continue;
      const cur = r.bests.get(lap.slotIndex);
      if (!cur || s.splitSeconds < cur.sec) r.bests.set(lap.slotIndex, { sec: s.splitSeconds, exitMph: s.exitSpeedMph });
    }
  }
  for (const r of records) {
    for (const [slot, b] of r.bests) {
      if (r.recordSlot === null || b.sec < r.recordSec) {
        r.recordSlot = slot;
        r.recordSec = b.sec;
      }
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Live: the lap a pilot is flying right now
// ---------------------------------------------------------------------------

export type LiveSectionState = "done" | "current" | "pending" | "missed";

export interface LiveSection {
  key: string;
  fromGateId: number;
  toGateId: number;
  state: LiveSectionState;
  /** Done: the split. Current: time since entering the section. */
  splitSec: number;
  /** The pilot's own best on this section (0 if never flown). */
  bestSec: number;
  delta: number;
  badge: SectorBadge;
}

export interface CurrentLap {
  lapNumber: number;
  startTimestampUs: number;
  elapsedSec: number;
  sections: LiveSection[];
  /** Sum of deltas over completed sections vs. the pilot's best sections. */
  deltaSoFar: number;
  /** Set during the brief (<600 ms wall-clock) window after a finish crossing arrives before its `LapRecord`. */
  provisionalLapTimeSec?: number;
}

/**
 * Reconstructs the lap in progress from accepted crossings since the pilot's last
 * start / finish pass. Returns null if they haven't started a lap or stopped flying.
 */
export function currentLap(store: AppStore, slotIndex: number): CurrentLap | null {
  const sess = store.selectedPracticeSession;
  if (sess && (!sess.active || sess.paused)) return null;
  const gates = store.nodes;
  const sfIdx = gates.findIndex((p) => p.role === "START_FINISH");
  if (sfIdx < 0) return null;
  const sfId = gates[sfIdx].gateId;

  const mine = store.crossings.filter((c) => c.slotIndex === slotIndex);
  let startIdx = -1;
  for (let i = mine.length - 1; i >= 0; i--) {
    if (mine[i].gateId === sfId) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return null;

  const allMine = allLapsFor(store, slotIndex);
  let start = mine[startIdx];
  const now = Math.max(
    store.latestTimestampUs,
    store.smoothLatestTimestampUs || 0,
    store.liveServerTimestampUs || 0
  );
  // If a finish crossing at Start/Finish arrived over WebSocket a few milliseconds before its
  // matching `LapRecord` (note: `start.timestampUs` is the RSSI peak, which can be 300-1500 ms
  // earlier than `now` when finalized on exit!), check wall-clock `lastCrossingIngestPerfMs` so
  // the finishing lap fills in its final section + total time immediately without ever blanking out.
  let endSliceIdx = mine.length;
  let provisionalLapTimeSec: number | undefined;
  const nowPerfMs = typeof performance !== "undefined" ? performance.now() : Date.now();
  const crossAgeMs = nowPerfMs - store.lastCrossingIngestPerfMs(slotIndex);
  if (
    startIdx > 0 &&
    !start.startedLap &&
    store.lastCrossingIngestPerfMs(slotIndex) > 0 &&
    crossAgeMs >= 0 &&
    crossAgeMs < 600 &&
    !allMine.some((l) => Math.abs(l.completedAtUs - start.timestampUs) <= 50_000)
  ) {
    const finishEv = start;
    for (let i = startIdx - 1; i >= 0; i--) {
      if (mine[i].gateId === sfId && (finishEv.timestampUs - mine[i].timestampUs) / 1e6 <= store.rules.maxLapSec) {
        endSliceIdx = startIdx + 1;
        startIdx = i;
        start = mine[i];
        provisionalLapTimeSec = Math.max(0, (finishEv.timestampUs - start.timestampUs) / 1e6);
        break;
      }
    }
  }
  const elapsedSec = Math.max(0, (now - start.timestampUs) / 1e6);
  if (elapsedSec > store.rules.maxLapSec) return null;

  // Sections around the loop, starting at the start / finish gate.
  const order = [...gates.slice(sfIdx), ...gates.slice(0, sfIdx)];
  const best = new Map(sectionConsistency(store, slotIndex).map((s) => [s.key, s.best]));
  const overall = new Map(sectionRecords(store).map((r) => [r.key, r.recordSlot !== null ? r.recordSec : 0]));
  const sections: LiveSection[] = order.map((p, i) => {
    const to = order[(i + 1) % order.length];
    const key = sectionKey(p.gateId, to.gateId);
    return {
      key,
      fromGateId: p.gateId,
      toGateId: to.gateId,
      state: "pending",
      splitSec: 0,
      bestSec: best.get(key) ?? 0,
      delta: NaN,
      badge: "NORMAL",
    };
  });
  const indexOfGate = (gateId: number) => order.findIndex((p) => p.gateId === gateId);

  let prev = start;
  let deltaSoFar = 0;
  for (const c of mine.slice(startIdx + 1, endSliceIdx)) {
    const split = (c.timestampUs - prev.timestampUs) / 1e6;
    const from = indexOfGate(prev.gateId);
    const to = indexOfGate(c.gateId);
    if (from >= 0 && to === (from + 1) % order.length) {
      const s = sections[from];
      s.state = "done";
      s.splitSec = split;
      const oBest = overall.get(s.key) ?? 0;
      if (oBest <= 0 || split <= oBest + 0.0005) {
        s.badge = "OVERALL_BEST";
      } else if (s.bestSec <= 0 || split <= s.bestSec + 0.0005) {
        s.badge = "PERSONAL_BEST";
      } else if (split > s.bestSec * 1.10) {
        s.badge = "OFF_PACE";
      } else {
        s.badge = "NORMAL";
      }
      if (s.bestSec > 0) {
        s.delta = split - s.bestSec;
        deltaSoFar += s.delta;
      }
    } else if (from >= 0 && to > from) {
      // A gate in between didn't see the pilot: those sections have no split.
      for (let i = from; i < to; i++) sections[i].state = "missed";
    }
    prev = c;
  }

  const cur = sections.find((s) => s.fromGateId === prev.gateId && s.state === "pending");
  if (cur) {
    cur.state = "current";
    cur.splitSec = Math.max(0, (now - prev.timestampUs) / 1e6);
  }

  const nextLapNum =
    (allMine.length > 0 ? allMine[allMine.length - 1].lapNumber : 0) + 1;

  return {
    lapNumber: nextLapNum,
    startTimestampUs: start.timestampUs,
    elapsedSec,
    sections,
    deltaSoFar,
    ...(provisionalLapTimeSec !== undefined ? { provisionalLapTimeSec } : {}),
  };
}

/** Dwell duration (ms) to keep a just-finished lap's numbers in the active row before inserting below. */
export const LIVE_LAP_COMPLETION_HOLD_MS = 1100;

export interface LiveLapTableState {
  /** Active row at Row #1 (`tr.is-in-progress`), either mid-lap or holding a just-finished lap's numbers. */
  live: CurrentLap | null;
  /** Completed lap whose numbers are currently held inside `live` on Row #1 before inserting below. */
  heldLap: LapRecord | null;
  /** True when `heldLap` came from `laps` (vs provisional finish crossing) and should be excluded from history below. */
  excludeHeldFromHistory: boolean;
  /** Remaining ms (> 0) before `heldLap` inserts into the history rows below and `live` clears for the next lap. */
  holdRemainingMs: number;
}

/**
 * Returns remaining dwell time in ms (> 0) when a continuous flying lap just completed via
 * `store.ingestLap` so the user can see the final section split, `Lap time`, and `vs best` fill in
 * on the top row for ~1.1 s wall-clock before clearing and inserting the completed row below.
 */
export function liveLapHoldRemainingMs(
  store: AppStore,
  slotIndex: number,
  live: CurrentLap | null,
  laps: LapRecord[],
  holdMs = LIVE_LAP_COMPLETION_HOLD_MS
): number {
  if (!live || laps.length === 0) return 0;
  if (live.sections.some((s) => s.state === "done" || s.state === "missed")) return 0;
  const lastLap = laps[laps.length - 1];
  if (!lastLap || Math.abs(live.startTimestampUs - lastLap.completedAtUs) > 50_000) {
    return 0;
  }
  const ingestedAtMs = store.lastLapIngestPerfMs(slotIndex);
  if (!(ingestedAtMs > 0)) return 0;
  const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
  const elapsedWallMs = Math.max(0, nowMs - ingestedAtMs);
  return elapsedWallMs < holdMs ? Math.ceil(holdMs - elapsedWallMs) : 0;
}

/**
 * Resolves the active Row #1 state (`tr.is-in-progress`): when a continuous flying lap just
 * finished (`< 1.1 s` ago), keeps `tr.is-in-progress` in place without changing row style, fills in
 * all final numbers (`Lap time`, `vs best`, last section) on that active row, and holds off
 * inserting the completed row below until the hold expires.
 */
export function resolveLiveLapTableState(
  store: AppStore,
  slotIndex: number,
  rawLive: CurrentLap | null,
  laps: LapRecord[],
  holdMs = LIVE_LAP_COMPLETION_HOLD_MS
): LiveLapTableState {
  if (rawLive?.provisionalLapTimeSec !== undefined) {
    const synthLap: LapRecord = {
      lapId: -1,
      slotIndex,
      callsign: "",
      lapNumber: rawLive.lapNumber,
      lapTimeSec: rawLive.provisionalLapTimeSec,
      deltaToBest: rawLive.deltaSoFar,
      completedAtUs: rawLive.startTimestampUs + Math.round(rawLive.provisionalLapTimeSec * 1e6),
      isBestLap: false,
      sectors: rawLive.sections
        .filter((s) => s.state === "done")
        .map((s, idx) => ({
          sectorIndex: idx,
          fromGateId: s.fromGateId,
          toGateId: s.toGateId,
          label: "",
          splitSeconds: s.splitSec,
          deltaToBestSec: Number.isFinite(s.delta) ? s.delta : 0,
          exitSpeedMph: 0,
          badge: s.badge,
        })),
    };
    return {
      live: rawLive,
      heldLap: synthLap,
      excludeHeldFromHistory: false,
      holdRemainingMs: holdMs,
    };
  }
  const remaining = liveLapHoldRemainingMs(store, slotIndex, rawLive, laps, holdMs);
  if (remaining <= 0 || laps.length === 0) {
    return { live: rawLive, heldLap: null, excludeHeldFromHistory: false, holdRemainingMs: 0 };
  }
  const heldLap = laps[laps.length - 1];
  const gates = store.nodes;
  const byKey = new Map(
    (heldLap.sectors ?? []).map((s) => [sectionKey(s.fromGateId, s.toGateId), s])
  );
  const heldSections: LiveSection[] = gates.map((g, i) => {
    const to = gates[(i + 1) % gates.length];
    const key = sectionKey(g.gateId, to.gateId);
    const sec = byKey.get(key);
    return sec
      ? {
          key,
          fromGateId: g.gateId,
          toGateId: to.gateId,
          state: "done",
          splitSec: sec.splitSeconds,
          bestSec: 0,
          delta: sec.deltaToBestSec,
          badge: sec.badge,
        }
      : {
          key,
          fromGateId: g.gateId,
          toGateId: to.gateId,
          state: "missed",
          splitSec: 0,
          bestSec: 0,
          delta: NaN,
          badge: "NORMAL",
        };
  });
  return {
    live: {
      lapNumber: heldLap.lapNumber,
      startTimestampUs: Math.max(0, heldLap.completedAtUs - Math.round(heldLap.lapTimeSec * 1e6)),
      elapsedSec: heldLap.lapTimeSec,
      sections: heldSections,
      deltaSoFar: heldLap.deltaToBest,
    },
    heldLap,
    excludeHeldFromHistory: true,
    holdRemainingMs: remaining,
  };
}
