import { LapRecord, PilotSlot } from "../types/models";
import { bestLapOf, lapsFor, mean, median, ON_TRACK_WINDOW_SEC, secondsSinceSeen } from "./selectors";
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
  const seen = secondsSinceSeen(store, pilot.slotIndex);
  return {
    pilot,
    laps,
    lastLap: times.length ? times[times.length - 1] : 0,
    bestLap: bestLapOf(laps),
    rollingAvg: mean(recent),
    trend: recent.length === ROLLING_WINDOW && previous.length === ROLLING_WINDOW ? mean(recent) - mean(previous) : NaN,
    onTrack: seen <= ON_TRACK_WINDOW_SEC,
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
export const sectionKey = (fromPuckId: number, toPuckId: number): string => `${fromPuckId}>${toPuckId}`;

export interface SectionDelta {
  key: string;
  fromPuckId: number;
  toPuckId: number;
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

  const pucks = store.pucks;
  const courseKeys = new Set(
    pucks.map((p, i) => sectionKey(p.puckId, pucks[(i + 1) % pucks.length].puckId))
  );
  const refByKey = new Map(ref.sectors.map((s) => [sectionKey(s.fromPuckId, s.toPuckId), s]));
  const sections: SectionDelta[] = [];
  for (const s of lap.sectors) {
    const key = sectionKey(s.fromPuckId, s.toPuckId);
    if (!courseKeys.has(key)) continue;
    const r = refByKey.get(key);
    if (!r) continue;
    sections.push({
      key,
      fromPuckId: s.fromPuckId,
      toPuckId: s.toPuckId,
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
    incomplete: sections.length < Math.max(lap.sectors.length, ref.sectors.length),
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
  fromPuckId: number;
  toPuckId: number;
  samples: number;
  best: number;
  typical: number;
  /** typical − best: time usually given away vs. the pilot's own best on this stretch. */
  givenAway: number;
  typicalExitMph: number;
  bestExitMph: number;
}

export function sectionConsistency(store: AppStore, slotIndex: number): SectionConsistency[] {
  const pucks = store.pucks;
  if (pucks.length === 0) return [];

  const groups = new Map<string, { from: number; to: number; times: number[]; exits: number[]; bestExit: number; best: number }>();
  for (let i = 0; i < pucks.length; i++) {
    const from = pucks[i].puckId;
    const to = pucks[(i + 1) % pucks.length].puckId;
    if (from === to) continue;
    groups.set(sectionKey(from, to), { from, to, times: [], exits: [], bestExit: 0, best: Infinity });
  }

  for (const lap of lapsFor(store, slotIndex)) {
    for (const s of lap.sectors) {
      const g = groups.get(sectionKey(s.fromPuckId, s.toPuckId));
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
        fromPuckId: g.from,
        toPuckId: g.to,
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
  return sections.length === store.pucks.length && sections.length > 0 ? sections.reduce((s, c) => s + c.best, 0) : 0;
}

// ---------------------------------------------------------------------------
// Session-wide metrics
// ---------------------------------------------------------------------------

export interface SectionRecord {
  key: string;
  fromPuckId: number;
  toPuckId: number;
  /** Each pilot's best on this section. */
  bests: Map<number, { sec: number; exitMph: number }>;
  recordSlot: number | null;
  recordSec: number;
}

/** For every section of the track: each pilot's best, and who holds the record. */
export function sectionRecords(store: AppStore): SectionRecord[] {
  const pucks = store.pucks;
  const records: SectionRecord[] = pucks.map((p, i) => {
    const to = pucks[(i + 1) % pucks.length];
    return { key: sectionKey(p.puckId, to.puckId), fromPuckId: p.puckId, toPuckId: to.puckId, bests: new Map(), recordSlot: null, recordSec: 0 };
  });
  const byKey = new Map(records.map((r) => [r.key, r]));
  for (const lap of store.laps) {
    for (const s of lap.sectors) {
      const r = byKey.get(sectionKey(s.fromPuckId, s.toPuckId));
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
  fromPuckId: number;
  toPuckId: number;
  state: LiveSectionState;
  /** Done: the split. Current: time since entering the section. */
  splitSec: number;
  /** The pilot's own best on this section (0 if never flown). */
  bestSec: number;
  delta: number;
}

export interface CurrentLap {
  lapNumber: number;
  elapsedSec: number;
  sections: LiveSection[];
  /** Sum of deltas over completed sections vs. the pilot's best sections. */
  deltaSoFar: number;
}

/**
 * Reconstructs the lap in progress from accepted crossings since the pilot's last
 * start / finish pass. Returns null if they haven't started a lap or stopped flying.
 */
export function currentLap(store: AppStore, slotIndex: number): CurrentLap | null {
  const pucks = store.pucks;
  const sfIdx = pucks.findIndex((p) => p.role === "START_FINISH");
  if (sfIdx < 0) return null;
  const sfId = pucks[sfIdx].puckId;

  const mine = store.crossings.filter((c) => c.slotIndex === slotIndex);
  let startIdx = -1;
  for (let i = mine.length - 1; i >= 0; i--) {
    if (mine[i].puckId === sfId) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return null;

  const start = mine[startIdx];
  const now = store.latestTimestampUs;
  const elapsedSec = (now - start.timestampUs) / 1e6;
  if (elapsedSec > store.rules.maxLapSec) return null;

  // Sections around the loop, starting at the start / finish gate.
  const order = [...pucks.slice(sfIdx), ...pucks.slice(0, sfIdx)];
  const best = new Map(sectionConsistency(store, slotIndex).map((s) => [s.key, s.best]));
  const sections: LiveSection[] = order.map((p, i) => {
    const to = order[(i + 1) % order.length];
    const key = sectionKey(p.puckId, to.puckId);
    return { key, fromPuckId: p.puckId, toPuckId: to.puckId, state: "pending", splitSec: 0, bestSec: best.get(key) ?? 0, delta: NaN };
  });
  const indexOfGate = (puckId: number) => order.findIndex((p) => p.puckId === puckId);

  let prev = start;
  let deltaSoFar = 0;
  for (const c of mine.slice(startIdx + 1)) {
    const split = (c.timestampUs - prev.timestampUs) / 1e6;
    const from = indexOfGate(prev.puckId);
    const to = indexOfGate(c.puckId);
    if (from >= 0 && to === (from + 1) % order.length) {
      const s = sections[from];
      s.state = "done";
      s.splitSec = split;
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

  const cur = sections.find((s) => s.fromPuckId === prev.puckId && s.state === "pending");
  if (cur) {
    cur.state = "current";
    cur.splitSec = (now - prev.timestampUs) / 1e6;
  }

  return { lapNumber: lapsFor(store, slotIndex).length + 1, elapsedSec, sections, deltaSoFar };
}
