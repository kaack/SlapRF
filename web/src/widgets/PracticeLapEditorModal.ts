import {
  computeDirectionalPinch,
  computeWheelZoomFactors,
  PinchPoint,
  scrollOuterPageBy,
} from "../core/chart_pinch";
import { esc, fmtTime } from "../core/format";
import { icons } from "../core/icons";
import { formatBandChannelShort } from "../core/vtx_channels";
import { ApiClient } from "../services/api_client";
import {
  enterThresholdAt,
  exitThresholdAt,
  gateColor,
  gateLabel,
  laprfThresholdAt,
  rhThresholdAt,
} from "../state/selectors";
import { AppStore } from "../state/store";
import {
  isLapRFMode,
  isRotorHazardMode,
  isSlapRFMode,
  LapRecord,
  PracticeSession,
  TimingHardwareMode,
} from "../types/models";
import { closeActiveLapEditorModal } from "./HeatLapEditorModal";
import { showToast } from "./Toast";

let activePracticeEditorCleanup: (() => void) | null = null;

export function closeActivePracticeLapEditorModal(): void {
  activePracticeEditorCleanup?.();
}

export interface PracticeLapEditorOptions {
  initialLapId?: number;
  initialGateId?: number;
  focusStartUs?: number;
  focusEndUs?: number;
}

interface DraftGateCrossing {
  crossingId: number; // positive = existing eventId, negative = newly staged
  gateId: number;
  timestampUs: number;
  peakRssiDbm?: number;
  manual?: boolean;
  invalidReason?: string;
}

interface DerivedPassRow {
  crossing: DraftGateCrossing;
  gateId: number;
  gateLbl: string;
  gateClr: string;
  offsetMs: number;
  relMs: number; // ms relative to lap start (0 ms = Start crossing of this lap)
  label: string;
  splitSec: number | null;
  peakDbm: number | null;
}

interface LockedLapBounds {
  lapNumber: number | null;
  lapTimeSec: number | null;
  startMs: number;
  endMs: number;
  hardMinMs: number;
  hardMaxMs: number;
}

const DEFAULT_SVG_W = 850;
const DEFAULT_SVG_H = 260;
const PAD_L = 28;
const PAD_R = 6;
const PAD_T = 28;
const PAD_B = 24;
const DBM_MIN = -98;
const DBM_MAX = -22;
const DBM_ABS_MIN = -108;
const DBM_ABS_MAX = -8;
const MIN_Y_SPAN_DB = 12;
const MAX_Y_SPAN_DB = 100;
const LAPRF_Y_MIN = 250;
const LAPRF_Y_MAX = 3400;
const LAPRF_ABS_MIN = 150;
const LAPRF_ABS_MAX = 3600;
const LAPRF_MIN_Y_SPAN = 200;
const LAPRF_MAX_Y_SPAN = 3450;
const RH_Y_MIN = 0;
const RH_Y_MAX = 255;
const RH_ABS_MIN = 0;
const RH_ABS_MAX = 260;
const RH_MIN_Y_SPAN = 24;
const RH_MAX_Y_SPAN = 260;
const MIN_X_SPAN_MS = 800;
const MAX_FALLBACK_X_SPAN_MS = 120_000;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function fmtRelSec(ms: number): string {
  const sec = ms / 1000;
  if (Math.abs(sec) < 0.005) return "0.00s";
  return `${sec > 0 ? "+" : ""}${sec.toFixed(2)}s`;
}

/**
 * Opens the Single-Lap Practice RSSI Editor modal matching the `Signals` tab UX:
 * - Viewport is locked to the selected lap (`Start` .. `Finish`), with stretchable X-axis and Y-axis scales.
 * - Inside the chart area: compact `[ + ]` and `[ 🔒 / 🔓 ]` action buttons when a timer is focused.
 * - Below the chart: timer selector row (`All`, `H1`, `T1`, …) and the lap's crossings row right underneath.
 */
export function openPracticeLapEditorModal(
  rootStore: AppStore,
  rootApi: ApiClient,
  sessionId: string,
  initialPilotSlotIndex: number,
  opts: PracticeLapEditorOptions = {}
): void {
  closeActiveLapEditorModal();
  if (activePracticeEditorCleanup) {
    activePracticeEditorCleanup();
  }

  const getSession = (): PracticeSession | undefined =>
    rootStore.practiceSessions.find((s) => s.sessionId === sessionId);

  const reviewStore = rootStore.forPracticeSessionReview(getSession);
  const scopedApi =
    typeof rootApi.forScope === "function"
      ? rootApi.forScope(() => ({ kind: "practice", id: sessionId }))
      : rootApi;

  const initSess = getSession();
  if (!initSess) return;

  let selectedPilotSlot = initialPilotSlotIndex;
  if (
    initSess.pilots.length > 0 &&
    !initSess.pilots.some((p) => p.slotIndex === selectedPilotSlot)
  ) {
    selectedPilotSlot = initSess.pilots[0].slotIndex;
  }

  const nodesList = () => reviewStore.nodes;
  const sfGateId = () =>
    nodesList().find((n) => n.role === "START_FINISH")?.gateId ?? nodesList()[0]?.gateId ?? 1;

  const getPilotLaps = (sess: PracticeSession): LapRecord[] =>
    (sess.laps ?? []).filter((l) => l.slotIndex === selectedPilotSlot);

  // `focusedGateId === null` means "All Timers" view (default when >1 timer); single-timer tracks auto-focus!
  const defaultFocusedGateId = (): number | null => {
    const nodes = nodesList();
    if (opts.initialGateId !== undefined && nodes.some((n) => n.gateId === opts.initialGateId)) {
      return opts.initialGateId;
    }
    return nodes.length === 1 ? nodes[0].gateId : null;
  };

  let focusedGateId: number | null = defaultFocusedGateId();
  // Matches `PilotRssiChart.chartLinesLocked`: locked by default until the user taps the lock icon!
  let chartLinesLocked = true;
  let selectedCrossingId: number | null = null;
  let customX: { minMs: number; maxMs: number } | null = null;
  let customY: { minDbm: number; maxDbm: number } | null = null;
  let panAnimFrame = 0;
  let isSaving = false;
  let isAutoLabeling = false;
  const needsFreshActiveTrace =
    Boolean(initSess.active) &&
    (initSess.laps ?? []).some((l) => l.completedAtUs > rootStore.sessionTraceMaxTsUs(sessionId));
  let isLoadingTrace = !rootStore.hasSessionTrace(sessionId) || needsFreshActiveTrace;
  let nextDraftId = -1;

  // Resolve the immutable target lap opened from Review
  const initPilotLaps = getPilotLaps(initSess);
  let lockedLap: LapRecord | undefined;
  if (opts.initialLapId !== undefined) {
    lockedLap = initPilotLaps.find((l) => l.lapId === opts.initialLapId);
  }
  if (!lockedLap && opts.focusEndUs !== undefined && opts.focusEndUs > 0) {
    lockedLap = initPilotLaps.find((l) => Math.abs(l.completedAtUs - opts.focusEndUs!) <= 50_000);
  }
  if (!lockedLap && opts.focusStartUs === undefined && initPilotLaps.length > 0) {
    lockedLap = initPilotLaps[initPilotLaps.length - 1];
  }
  const lockedLapId: number | null = lockedLap?.lapId ?? null;
  const fallbackStartUs = opts.focusStartUs;
  const fallbackEndUs = opts.focusEndUs;

  const draftByGate = new Map<number, DraftGateCrossing[]>();
  const draftThresholdsByGate = new Map<
    number,
    { enterDb: number; exitDb: number; hwMode: TimingHardwareMode }
  >();

  const getGateHistory = (sess: PracticeSession, gateId: number) =>
    rootStore.sessionTraceHistoryFor(sess.sessionId, gateId, Boolean(sess.active));

  const computeSessionAnchorUs = (sess: PracticeSession): number => {
    let minUs = Number.POSITIVE_INFINITY;
    for (const l of sess.laps ?? []) {
      if (l.completedAtUs > 0) {
        const startUs = Math.max(0, Math.round(l.completedAtUs - l.lapTimeSec * 1_000_000));
        if (startUs > 0 && startUs < minUs) minUs = startUs;
      }
    }
    for (const c of sess.crossings ?? []) {
      if (c.timestampUs > 0 && c.timestampUs < minUs) {
        minUs = c.timestampUs;
      }
    }
    if (!Number.isFinite(minUs)) {
      for (const n of reviewStore.nodes) {
        const hist = getGateHistory(sess, n.gateId);
        if (hist.length > 0 && hist[0].timestampUs > 0 && hist[0].timestampUs < minUs) {
          minUs = hist[0].timestampUs;
        }
      }
    }
    if (!Number.isFinite(minUs)) return 1_000_000;
    return Math.max(0, minUs - 500_000);
  };

  const computeLockedLapBounds = (
    sess: PracticeSession,
    anchorUs: number
  ): LockedLapBounds | null => {
    const liveLap =
      lockedLapId !== null
        ? getPilotLaps(sess).find((l) => l.lapId === lockedLapId) ?? lockedLap
        : undefined;
    if (liveLap && liveLap.completedAtUs > 0) {
      const startUs = Math.max(0, Math.round(liveLap.completedAtUs - liveLap.lapTimeSec * 1_000_000));
      const endUs = liveLap.completedAtUs;
      const startMs = Math.round((startUs - anchorUs) / 1000);
      const endMs = Math.round((endUs - anchorUs) / 1000);
      const padMs = clamp(Math.round(Math.max(1000, endMs - startMs) * 0.12), 800, 1800);
      return {
        lapNumber: liveLap.lapNumber,
        lapTimeSec: liveLap.lapTimeSec,
        startMs,
        endMs,
        hardMinMs: startMs - padMs,
        hardMaxMs: Math.max(startMs + 1500, endMs + padMs),
      };
    }
    if (
      fallbackStartUs !== undefined &&
      fallbackEndUs !== undefined &&
      fallbackEndUs >= fallbackStartUs &&
      fallbackEndUs > 0
    ) {
      const startMs = Math.round((fallbackStartUs - anchorUs) / 1000);
      const endMs = Math.round((fallbackEndUs - anchorUs) / 1000);
      const padMs = clamp(Math.round(Math.max(1000, endMs - startMs) * 0.12), 800, 1800);
      return {
        lapNumber: null,
        lapTimeSec: Math.max(0, (fallbackEndUs - fallbackStartUs) / 1_000_000),
        startMs,
        endMs,
        hardMinMs: startMs - padMs,
        hardMaxMs: Math.max(startMs + 1500, endMs + padMs),
      };
    }
    return null;
  };

  let activeHardBounds: LockedLapBounds | null = computeLockedLapBounds(
    initSess,
    computeSessionAnchorUs(initSess)
  );

  const clampXDomain = (minMs: number, maxMs: number) => {
    if (activeHardBounds) {
      const fullLapSpan = Math.max(MIN_X_SPAN_MS, activeHardBounds.hardMaxMs - activeHardBounds.hardMinMs);
      const span = clamp(maxMs - minMs, MIN_X_SPAN_MS, fullLapSpan);
      const maxLo = activeHardBounds.hardMaxMs - span;
      const lo = clamp(minMs, activeHardBounds.hardMinMs, maxLo);
      return { minMs: Math.round(lo), maxMs: Math.round(lo + span) };
    }
    const span = clamp(maxMs - minMs, MIN_X_SPAN_MS, MAX_FALLBACK_X_SPAN_MS);
    const lo = clamp(minMs, -1_000_000_000, 1_000_000_000);
    return { minMs: Math.round(lo), maxMs: Math.round(lo + span) };
  };

  const isCustomXZoomed = (): boolean => {
    if (!customX) return false;
    if (!activeHardBounds) return true;
    return (
      Math.abs(customX.minMs - activeHardBounds.hardMinMs) > 5 ||
      Math.abs(customX.maxMs - activeHardBounds.hardMaxMs) > 5
    );
  };

  const canEditFocusedLines = (): boolean => focusedGateId !== null && !chartLinesLocked;

  const extractOriginalGateCrossings = (
    sess: PracticeSession,
    gateId: number,
    slotIndex: number
  ): DraftGateCrossing[] =>
    (sess.crossings ?? [])
      .filter((c) => c.gateId === gateId && c.slotIndex === slotIndex)
      .map((c) => ({
        crossingId: c.eventId,
        gateId: c.gateId,
        timestampUs: c.timestampUs,
        peakRssiDbm: c.peakRssiDbm,
        manual: c.manual,
        invalidReason: c.invalidReason,
      }))
      .sort((a, b) => a.timestampUs - b.timestampUs);

  const activeGateCrossings = (sess: PracticeSession, gateId: number): DraftGateCrossing[] =>
    draftByGate.get(gateId) ?? extractOriginalGateCrossings(sess, gateId, selectedPilotSlot);

  const ensureDraftGateCrossings = (sess: PracticeSession, gateId: number): DraftGateCrossing[] => {
    let list = draftByGate.get(gateId);
    if (!list) {
      list = extractOriginalGateCrossings(sess, gateId, selectedPilotSlot).map((c) => ({ ...c }));
      draftByGate.set(gateId, list);
    }
    return list;
  };

  const hasUnsavedChanges = (): boolean =>
    draftByGate.size > 0 || draftThresholdsByGate.size > 0;

  const buildTraceMsInWindow = (
    sess: PracticeSession,
    anchorUs: number,
    gateId: number,
    slotIndex: number,
    minMs: number,
    maxMs: number
  ): Array<{ t: number; r: number }> => {
    const frames = getGateHistory(sess, gateId);
    if (frames.length === 0) return [];
    const slotZeroIdx = Math.max(0, slotIndex - 1);

    const padMinMs = activeHardBounds ? activeHardBounds.hardMinMs - 200 : minMs - 2000;
    const padMaxMs = activeHardBounds ? activeHardBounds.hardMaxMs + 200 : maxMs + 2000;
    const minUs = Math.max(0, anchorUs + padMinMs * 1000);
    const maxUs = Math.max(minUs, anchorUs + padMaxMs * 1000);

    let l = 0;
    let r = frames.length;
    while (l < r) {
      const m = (l + r) >>> 1;
      if (frames[m].timestampUs < minUs) l = m + 1;
      else r = m;
    }
    const loIdx = Math.max(0, l - 1);
    l = loIdx;
    r = frames.length;
    while (l < r) {
      const m = (l + r) >>> 1;
      if (frames[m].timestampUs <= maxUs) l = m + 1;
      else r = m;
    }
    const hiIdx = Math.min(frames.length, l + 1);

    const spanCount = hiIdx - loIdx;
    if (spanCount <= 0) return [];
    const step = spanCount > 1600 ? Math.ceil(spanCount / 1600) : 1;
    const out: Array<{ t: number; r: number }> = [];
    for (let i = loIdx; i < hiIdx; i += step) {
      let bestFrame = frames[i];
      let bestVal = bestFrame.rssi[slotZeroIdx];
      for (let k = 1; k < step && i + k < hiIdx; k++) {
        const cand = frames[i + k];
        const cv = cand.rssi[slotZeroIdx];
        if (cv !== undefined && (bestVal === undefined || cv > bestVal)) {
          bestFrame = cand;
          bestVal = cv;
        }
      }
      if (bestVal === undefined || bestVal <= -125) continue;
      const tMs = Math.round((bestFrame.timestampUs - anchorUs) / 1000);
      if (activeHardBounds && (tMs < activeHardBounds.hardMinMs - 100 || tMs > activeHardBounds.hardMaxMs + 100)) {
        continue;
      }
      out.push({ t: tMs, r: bestVal });
    }
    return out;
  };

  const deriveLapPassRows = (
    sess: PracticeSession,
    anchorUs: number,
    lapBounds: LockedLapBounds | null
  ): DerivedPassRow[] => {
    const sfId = sfGateId();
    const zeroMs = lapBounds ? lapBounds.startMs : 0;
    const rawItems: Array<{ crossing: DraftGateCrossing; offsetMs: number }> = [];

    for (const g of nodesList()) {
      for (const c of activeGateCrossings(sess, g.gateId)) {
        const offsetMs = Math.round((c.timestampUs - anchorUs) / 1000);
        if (lapBounds && c.crossingId >= 0) {
          const tolMs = g.gateId === sfId ? 450 : 250;
          if (offsetMs < lapBounds.startMs - tolMs || offsetMs > lapBounds.endMs + tolMs) {
            continue;
          }
        }
        rawItems.push({ crossing: c, offsetMs });
      }
    }

    rawItems.sort((a, b) => a.offsetMs - b.offsetMs || a.crossing.gateId - b.crossing.gateId);

    const rows: DerivedPassRow[] = [];
    const perGateCount = new Map<number, number>();
    let prevValidOffsetMs: number | null = null;

    for (const item of rawItems) {
      const { crossing: c, offsetMs } = item;
      const gLbl = gateLabel(reviewStore, c.gateId);
      const gClr = gateColor(reviewStore, c.gateId);
      const peakDbm =
        c.peakRssiDbm !== undefined && c.peakRssiDbm !== 0 ? Math.round(c.peakRssiDbm) : null;
      const isInv = Boolean(c.invalidReason && !c.manual);
      if (isInv) {
        rows.push({
          crossing: c,
          gateId: c.gateId,
          gateLbl: gLbl,
          gateClr: gClr,
          offsetMs,
          relMs: offsetMs - zeroMs,
          label: "INV",
          splitSec: null,
          peakDbm,
        });
        continue;
      }

      const cnt = (perGateCount.get(c.gateId) ?? 0) + 1;
      perGateCount.set(c.gateId, cnt);

      let label: string;
      if (lapBounds && c.gateId === sfId) {
        const distStart = Math.abs(offsetMs - lapBounds.startMs);
        const distEnd = Math.abs(offsetMs - lapBounds.endMs);
        if (distStart <= distEnd && cnt === 1) {
          label = "Start";
        } else {
          label = "Finish";
        }
      } else {
        label = cnt === 1 ? "Pass" : `Pass ${cnt}`;
      }

      const splitSec =
        prevValidOffsetMs !== null ? Math.max(0, (offsetMs - prevValidOffsetMs) / 1000) : null;
      prevValidOffsetMs = offsetMs;

      rows.push({
        crossing: c,
        gateId: c.gateId,
        gateLbl: gLbl,
        gateClr: gClr,
        offsetMs,
        relMs: offsetMs - zeroMs,
        label,
        splitSec,
        peakDbm,
      });
    }
    return rows;
  };

  let svgW = DEFAULT_SVG_W;
  let svgH = DEFAULT_SVG_H;
  const getPlotW = (): number => Math.max(180, svgW - PAD_L - PAD_R);
  const getPlotH = (): number => Math.max(120, svgH - PAD_T - PAD_B);
  let lastDomain = { minMs: -1000, maxMs: 15_000 };
  let lastYDomain = { minDbm: DBM_MIN, maxDbm: DBM_MAX };
  let lastHwMode: TimingHardwareMode = "slaprf";

  let dragState: {
    crossingId: number;
    gateId: number;
    pointerId: number;
    startClientX: number;
    moved: boolean;
    currentOffsetMs: number;
  } | null = null;
  let threshDrag: {
    kind: "enter" | "exit";
    gateId: number;
    pointerId: number;
    currentDbm: number;
  } | null = null;
  let viewDrag: {
    mode: "pan" | "xstretch" | "ystretch";
    pointerId: number;
    startSvgX: number;
    startSvgY: number;
    startMinMs: number;
    startMaxMs: number;
    startMinDbm: number;
    startMaxDbm: number;
    anchorFrac: number;
    tappedTraceGateId: number | null;
    panned: boolean;
  } | null = null;
  let hoverInfo: { offsetMs: number; dbm: number | null; gateLbl: string } | null = null;

  const backdrop = document.createElement("div");
  backdrop.className = "slaprf-modal-backdrop lap-editor-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", "Practice RSSI & Gate Crossing Editor");

  const getGateThresholds = (
    gateId: number,
    slotIndex: number
  ): { enterDb: number; exitDb: number; hwMode: TimingHardwareMode } => {
    const hwMode = reviewStore.timingHardwareMode;
    const drafted = draftThresholdsByGate.get(gateId);
    const activeThreshDrag = threshDrag && threshDrag.gateId === gateId ? threshDrag : null;
    if (isLapRFMode(hwMode)) {
      let thr = drafted
        ? drafted.enterDb
        : laprfThresholdAt(reviewStore, gateId, slotIndex).dbm;
      if (activeThreshDrag) thr = activeThreshDrag.currentDbm;
      return { enterDb: Math.round(thr), exitDb: Math.round(thr), hwMode };
    }
    if (isRotorHazardMode(hwMode)) {
      const pair = rhThresholdAt(reviewStore, gateId, slotIndex);
      let enterVal = drafted ? drafted.enterDb : pair.enter;
      let exitVal = drafted ? drafted.exitDb : pair.exit;
      exitVal = clamp(exitVal, 6, enterVal - 4);
      if (activeThreshDrag) {
        if (activeThreshDrag.kind === "enter") {
          enterVal = clamp(activeThreshDrag.currentDbm, Math.max(10, exitVal + 4), 250);
          exitVal = clamp(exitVal, 6, enterVal - 4);
        } else {
          exitVal = clamp(activeThreshDrag.currentDbm, 6, enterVal - 4);
        }
      }
      return { enterDb: Math.round(enterVal), exitDb: Math.round(exitVal), hwMode };
    }
    let enterDb = drafted
      ? drafted.enterDb
      : enterThresholdAt(reviewStore, gateId, slotIndex).dbm;
    let exitDb = drafted
      ? drafted.exitDb
      : exitThresholdAt(reviewStore, gateId, slotIndex).dbm;
    exitDb = Math.min(enterDb - 2, exitDb);
    if (activeThreshDrag) {
      if (activeThreshDrag.kind === "enter") {
        enterDb = activeThreshDrag.currentDbm;
        exitDb = Math.min(enterDb - 2, exitDb);
      } else {
        exitDb = Math.min(enterDb - 2, activeThreshDrag.currentDbm);
      }
    }
    return { enterDb: Math.round(enterDb), exitDb: Math.round(exitDb), hwMode: "slaprf" };
  };

  const ySpanBounds = (hwMode: TimingHardwareMode) => {
    if (isLapRFMode(hwMode)) {
      return { minSpan: LAPRF_MIN_Y_SPAN, maxSpan: LAPRF_MAX_Y_SPAN, absLo: LAPRF_ABS_MIN, absHi: LAPRF_ABS_MAX };
    }
    if (isRotorHazardMode(hwMode)) {
      return { minSpan: RH_MIN_Y_SPAN, maxSpan: RH_MAX_Y_SPAN, absLo: RH_ABS_MIN, absHi: RH_ABS_MAX };
    }
    return { minSpan: MIN_Y_SPAN_DB, maxSpan: MAX_Y_SPAN_DB, absLo: DBM_ABS_MIN, absHi: DBM_ABS_MAX };
  };

  const clampYDomain = (minDbm: number, maxDbm: number) => {
    const { minSpan, maxSpan, absLo, absHi } = ySpanBounds(lastHwMode);
    let span = clamp(maxDbm - minDbm, minSpan, maxSpan);
    let lo = minDbm;
    let hi = lo + span;
    if (lo < absLo) {
      lo = absLo;
      hi = lo + span;
    }
    if (hi > absHi) {
      hi = absHi;
      lo = Math.max(absLo, hi - span);
      span = hi - lo;
    }
    return { minDbm: lo, maxDbm: hi };
  };

  const activeYDomain = (hwMode: TimingHardwareMode) =>
    customY ??
    (isLapRFMode(hwMode)
      ? { minDbm: LAPRF_Y_MIN, maxDbm: LAPRF_Y_MAX }
      : isRotorHazardMode(hwMode)
        ? { minDbm: RH_Y_MIN, maxDbm: RH_Y_MAX }
        : { minDbm: DBM_MIN, maxDbm: DBM_MAX });

  const dbmToY = (dbm: number): number => {
    const span = Math.max(1, lastYDomain.maxDbm - lastYDomain.minDbm);
    return PAD_T + ((lastYDomain.maxDbm - dbm) / span) * getPlotH();
  };

  const yToDbm = (svgY: number): number => {
    const plotH = getPlotH();
    const clampedY = clamp(svgY, PAD_T, PAD_T + plotH);
    const frac = (clampedY - PAD_T) / plotH;
    return Math.round(lastYDomain.maxDbm - frac * (lastYDomain.maxDbm - lastYDomain.minDbm));
  };

  const msToX = (ms: number): number => {
    const span = Math.max(1, lastDomain.maxMs - lastDomain.minMs);
    return PAD_L + ((ms - lastDomain.minMs) / span) * getPlotW();
  };

  const clientToSvgCoords = (svgEl: SVGSVGElement, clientX: number, clientY: number) => {
    const rect = svgEl.getBoundingClientRect();
    const svgX = rect.width > 0 ? ((clientX - rect.left) / rect.width) * svgW : PAD_L;
    const svgY = rect.height > 0 ? ((clientY - rect.top) / rect.height) * svgH : PAD_T;
    return { svgX, svgY };
  };

  const clientXToMs = (svgEl: SVGSVGElement, clientX: number): number => {
    const plotW = getPlotW();
    const { svgX } = clientToSvgCoords(svgEl, clientX, 0);
    const frac = (clamp(svgX, PAD_L, PAD_L + plotW) - PAD_L) / plotW;
    const rawMs = Math.round(lastDomain.minMs + frac * (lastDomain.maxMs - lastDomain.minMs));
    if (activeHardBounds) {
      return clamp(rawMs, activeHardBounds.hardMinMs, activeHardBounds.hardMaxMs);
    }
    return rawMs;
  };

  const sampleTraceAtMs = (trace: Array<{ t: number; r: number }>, ms: number): number | null => {
    if (trace.length === 0) return null;
    let bestIdx = 0;
    let bestDist = Math.abs(trace[0].t - ms);
    for (let i = 1; i < trace.length; i++) {
      const d = Math.abs(trace[i].t - ms);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestDist <= 600 ? Math.round(trace[bestIdx].r) : null;
  };

  const computeDefaultDomainMs = (
    sess: PracticeSession,
    anchorUs: number,
    lapRows: DerivedPassRow[]
  ): { minMs: number; maxMs: number } => {
    if (activeHardBounds) {
      return { minMs: activeHardBounds.hardMinMs, maxMs: activeHardBounds.hardMaxMs };
    }
    let minMs = 0;
    let maxMs = 15_000;
    let sawTrace = false;
    for (const g of nodesList()) {
      const hist = getGateHistory(sess, g.gateId);
      if (hist.length > 0) {
        const lastT = Math.round((hist[hist.length - 1].timestampUs - anchorUs) / 1000);
        const firstT = Math.max(
          Math.round((hist[0].timestampUs - anchorUs) / 1000),
          lastT - 20_000
        );
        if (!sawTrace) {
          minMs = firstT - 500;
          maxMs = Math.max(minMs + 5000, lastT + 1000);
          sawTrace = true;
        } else {
          minMs = Math.min(minMs, firstT - 500);
          maxMs = Math.max(maxMs, lastT + 1000);
        }
      }
    }
    for (const r of lapRows) {
      if (r.offsetMs - 1000 < minMs) minMs = r.offsetMs - 1000;
      if (r.offsetMs + 1500 > maxMs) maxMs = r.offsetMs + 1500;
    }
    return { minMs, maxMs: Math.max(minMs + 4000, maxMs) };
  };

  const renderGraphSvg = (
    sess: PracticeSession,
    anchorUs: number,
    lapRows: DerivedPassRow[]
  ): string => {
    const plotW = getPlotW();
    const plotH = getPlotH();
    const refGateId = focusedGateId ?? sfGateId();
    const { enterDb, exitDb, hwMode } = getGateThresholds(refGateId, selectedPilotSlot);
    lastHwMode = hwMode;
    activeHardBounds = computeLockedLapBounds(sess, anchorUs);
    lastDomain = customX ? clampXDomain(customX.minMs, customX.maxMs) : computeDefaultDomainMs(sess, anchorUs, lapRows);
    lastYDomain = activeYDomain(hwMode);
    const spanMs = Math.max(1, lastDomain.maxMs - lastDomain.minMs);
    const ySpan = Math.max(1, lastYDomain.maxDbm - lastYDomain.minDbm);
    const axisZeroMs = activeHardBounds ? activeHardBounds.startMs : 0;
    const unlocked = canEditFocusedLines();

    const yStep =
      isLapRFMode(hwMode)
        ? ySpan <= 600 ? 100 : 250
        : isRotorHazardMode(hwMode)
          ? ySpan <= 50 ? 10 : 25
          : ySpan <= 24 ? 5 : ySpan <= 52 ? 10 : 15;
    const firstYDb = Math.ceil(lastYDomain.minDbm / yStep) * yStep;
    const yTicks: string[] = [];
    for (let db = firstYDb; db <= lastYDomain.maxDbm; db += yStep) {
      const yNum = dbmToY(db);
      if (yNum < PAD_T + 2 || yNum > svgH - PAD_B - 2) continue;
      const y = yNum.toFixed(1);
      yTicks.push(`
        <line x1="${PAD_L}" y1="${y}" x2="${svgW - PAD_R}" y2="${y}" class="lap-ed-grid-line" />
        <text x="${PAD_L - 4}" y="${(yNum + 3.5).toFixed(1)}" class="lap-ed-axis-lbl" text-anchor="end">${db}</text>`);
    }

    const stepMs =
      spanMs <= 2500 ? 250 : spanMs <= 6000 ? 500 : spanMs <= 14_000 ? 1000 : spanMs <= 30_000 ? 2000 : 5000;
    const firstTickRel = Math.ceil((lastDomain.minMs - axisZeroMs) / stepMs) * stepMs;
    const lastTickRel = lastDomain.maxMs - axisZeroMs;
    const xTicks: string[] = [];
    for (let rel = firstTickRel; rel <= lastTickRel; rel += stepMs) {
      const t = axisZeroMs + rel;
      const xNum = msToX(t);
      if (xNum < PAD_L || xNum > svgW - PAD_R) continue;
      const x = xNum.toFixed(1);
      const dec = stepMs < 500 ? 2 : rel % 1000 === 0 && stepMs >= 1000 ? 0 : 1;
      xTicks.push(`
        <line x1="${x}" y1="${PAD_T}" x2="${x}" y2="${svgH - PAD_B}" class="lap-ed-grid-line is-vert" />
        <text x="${x}" y="${svgH - 7}" class="lap-ed-axis-lbl" text-anchor="middle">${(rel / 1000).toFixed(dec)}s</text>`);
    }

    let lapFrameHtml = "";
    if (activeHardBounds) {
      const xStart = clamp(msToX(activeHardBounds.startMs), PAD_L, svgW - PAD_R);
      const xEnd = clamp(msToX(activeHardBounds.endMs), PAD_L, svgW - PAD_R);
      if (xStart > PAD_L + 1) {
        lapFrameHtml += `<rect x="${PAD_L}" y="${PAD_T}" width="${(xStart - PAD_L).toFixed(1)}" height="${plotH}" fill="rgba(0,0,0,0.20)" pointer-events="none" />`;
      }
      if (xEnd < svgW - PAD_R - 1) {
        lapFrameHtml += `<rect x="${xEnd.toFixed(1)}" y="${PAD_T}" width="${(svgW - PAD_R - xEnd).toFixed(1)}" height="${plotH}" fill="rgba(0,0,0,0.20)" pointer-events="none" />`;
      }
    }

    // Threshold lines on focused timer (draggable when unlocked, matching `Signals`)
    let threshHtml = "";
    if (focusedGateId !== null) {
      const enterY = dbmToY(enterDb);
      const exitY = dbmToY(exitDb);
      const enterVisible = enterY >= PAD_T - 2 && enterY <= svgH - PAD_B + 2;
      const exitVisible = !isLapRFMode(hwMode) && exitY >= PAD_T - 2 && exitY <= svgH - PAD_B + 2;
      const enterLbl = isLapRFMode(hwMode) ? `Thresh ${enterDb}` : isRotorHazardMode(hwMode) ? `Enter ${enterDb}` : `Enter ${enterDb} dBm`;
      const exitLbl = isRotorHazardMode(hwMode) ? `Exit ${exitDb}` : `Exit ${exitDb} dBm`;
      const enterPillW = Math.max(76, enterLbl.length * 6.3 + 12);
      const exitPillW = Math.max(72, exitLbl.length * 6.3 + 12);
      const enterPillX = svgW - PAD_R - enterPillW - 4;
      const exitPillX =
        enterVisible && Math.abs(exitY - enterY) < 18
          ? Math.max(PAD_L + 4, enterPillX - exitPillW - 6)
          : svgW - PAD_R - exitPillW - 4;

      threshHtml = `
        ${
          enterVisible
            ? `<g class="lap-ed-thresh-group is-enter ${unlocked ? "is-draggable" : ""} ${threshDrag?.kind === "enter" ? "is-dragging" : ""}" ${unlocked ? 'data-thresh-handle="enter"' : 'pointer-events="none"'}>
                <line x1="${PAD_L}" y1="${enterY.toFixed(1)}" x2="${svgW - PAD_R}" y2="${enterY.toFixed(1)}" class="lap-ed-thresh-line is-enter" />
                ${unlocked ? `<line x1="${PAD_L}" y1="${enterY.toFixed(1)}" x2="${svgW - PAD_R}" y2="${enterY.toFixed(1)}" class="lap-ed-thresh-hit" />` : ""}
                <rect x="${enterPillX.toFixed(1)}" y="${(enterY - 8.5).toFixed(1)}" width="${enterPillW.toFixed(1)}" height="17" rx="4" class="lap-ed-thresh-pill is-enter" />
                <text x="${(enterPillX + enterPillW / 2).toFixed(1)}" y="${(enterY + 3.4).toFixed(1)}" class="lap-ed-thresh-lbl is-enter" text-anchor="middle">${enterLbl}</text>
              </g>`
            : ""
        }
        ${
          exitVisible
            ? `<g class="lap-ed-thresh-group is-exit ${unlocked ? "is-draggable" : ""} ${threshDrag?.kind === "exit" ? "is-dragging" : ""}" ${unlocked ? 'data-thresh-handle="exit"' : 'pointer-events="none"'}>
                <line x1="${PAD_L}" y1="${exitY.toFixed(1)}" x2="${svgW - PAD_R}" y2="${exitY.toFixed(1)}" class="lap-ed-thresh-line is-exit" />
                ${unlocked ? `<line x1="${PAD_L}" y1="${exitY.toFixed(1)}" x2="${svgW - PAD_R}" y2="${exitY.toFixed(1)}" class="lap-ed-thresh-hit" />` : ""}
                <rect x="${exitPillX.toFixed(1)}" y="${(exitY - 8.5).toFixed(1)}" width="${exitPillW.toFixed(1)}" height="17" rx="4" class="lap-ed-thresh-pill is-exit" />
                <text x="${(exitPillX + exitPillW / 2).toFixed(1)}" y="${(exitY + 3.4).toFixed(1)}" class="lap-ed-thresh-lbl is-exit" text-anchor="middle">${exitLbl}</text>
              </g>`
            : ""
        }`;
    }

    const nodes = nodesList();
    const orderedNodes =
      focusedGateId === null
        ? nodes
        : [
            ...nodes.filter((n) => n.gateId !== focusedGateId),
            ...nodes.filter((n) => n.gateId === focusedGateId),
          ];

    const gradDefs: string[] = [];
    const waveParts: string[] = [];
    let anyRealWave = false;

    for (const g of orderedNodes) {
      const trace = buildTraceMsInWindow(
        sess,
        anchorUs,
        g.gateId,
        selectedPilotSlot,
        lastDomain.minMs,
        lastDomain.maxMs
      );
      if (trace.length < 2) continue;
      anyRealWave = true;
      const gClr = gateColor(reviewStore, g.gateId);
      const isFocused = focusedGateId === null || g.gateId === focusedGateId;
      const pts = trace.map((p) => `${msToX(p.t).toFixed(1)},${dbmToY(p.r).toFixed(1)}`);
      const dLine = `M ${pts.join(" L ")}`;
      if (isFocused) {
        const gradId = `lapEdGrad_${g.gateId}`;
        const topAlpha = focusedGateId === null ? "0.14" : "0.28";
        gradDefs.push(`
          <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${esc(gClr)}" stop-opacity="${topAlpha}" />
            <stop offset="100%" stop-color="${esc(gClr)}" stop-opacity="0.01" />
          </linearGradient>`);
        const xFirst = msToX(trace[0].t).toFixed(1);
        const xLast = msToX(trace[trace.length - 1].t).toFixed(1);
        const baseY = (svgH - PAD_B + 4).toFixed(1);
        const strokeW = focusedGateId === null ? "1.8" : "2.1";
        waveParts.push(`
          <path d="M ${xFirst},${baseY} L ${pts.join(" L ")} L ${xLast},${baseY} Z" fill="url(#${gradId})" pointer-events="none" />
          <path d="${dLine}" class="lap-ed-rssi-line" style="stroke:${esc(gClr)};stroke-width:${strokeW}" pointer-events="none" />
          ${
            focusedGateId === null && nodes.length > 1
              ? `<path d="${dLine}" fill="none" stroke="transparent" stroke-width="12" class="lap-ed-trace-hit" data-trace-gate="${g.gateId}" />`
              : ""
          }`);
      } else {
        waveParts.push(`
          <path d="${dLine}" class="lap-ed-rssi-line is-unfocused" style="stroke:${esc(gClr)};stroke-width:1.35;opacity:0.25" pointer-events="none" />
          <path d="${dLine}" fill="none" stroke="transparent" stroke-width="12" class="lap-ed-trace-hit" data-trace-gate="${g.gateId}" />`);
      }
    }

    if (!anyRealWave) {
      const flatVal = isLapRFMode(hwMode) ? 360 : isRotorHazardMode(hwMode) ? 22 : -90;
      const flatY = clamp(dbmToY(flatVal), PAD_T + 8, svgH - PAD_B - 8).toFixed(1);
      const emptyLabel = isLoadingTrace ? "Loading RSSI waveform…" : "No RSSI waveform recorded";
      waveParts.push(`
        <line x1="${PAD_L}" y1="${flatY}" x2="${svgW - PAD_R}" y2="${flatY}" class="lap-ed-rssi-line is-synthetic" />
        <text x="${PAD_L + plotW / 2}" y="${PAD_T + plotH / 2}" class="lap-ed-empty-svg" text-anchor="middle">${emptyLabel}</text>`);
    }

    const orderedRows =
      focusedGateId === null
        ? lapRows
        : [
            ...lapRows.filter((r) => r.gateId !== focusedGateId),
            ...lapRows.filter((r) => r.gateId === focusedGateId),
          ];

    let lastLane0Right = -9999;
    const pinsHtml = orderedRows
      .map((r) => {
        const isDragging = Boolean(dragState && dragState.crossingId === r.crossing.crossingId);
        const effMs = isDragging && dragState ? dragState.currentOffsetMs : r.offsetMs;
        const rawX = msToX(effMs);
        if (!isDragging && (rawX < PAD_L - 2 || rawX > svgW - PAD_R + 2)) {
          return "";
        }
        const x = clamp(rawX, PAD_L, svgW - PAD_R);
        const xf = x.toFixed(1);
        const isGateFocused = focusedGateId === null || r.gateId === focusedGateId;
        const isSel = selectedCrossingId !== null && r.crossing.crossingId === selectedCrossingId;
        const inv = r.label === "INV";

        if (!isGateFocused && !isDragging) {
          return `
            <g class="lap-ed-pin is-ref-pin" style="opacity:0.32;cursor:pointer" data-crossing-pin="${r.crossing.crossingId}" data-crossing-gate="${r.gateId}">
              <line x1="${xf}" y1="${PAD_T}" x2="${xf}" y2="${svgH - PAD_B}" class="lap-ed-pin-line" style="stroke:${esc(r.gateClr)};stroke-dasharray:3 3" />
              <line x1="${xf}" y1="${PAD_T}" x2="${xf}" y2="${svgH - PAD_B}" class="lap-ed-pin-hit" />
            </g>`;
        }

        const pinEditable = unlocked && r.gateId === focusedGateId;
        const cls = [
          "lap-ed-pin",
          !pinEditable ? "is-locked" : "",
          inv ? "is-invalid" : r.label === "Start" ? "is-holeshot" : "",
          r.crossing.manual ? "is-manual" : "",
          isSel ? "is-selected" : "",
          isDragging ? "is-dragging" : "",
        ]
          .filter(Boolean)
          .join(" ");

        const relDragMs = effMs - axisZeroMs;
        const tagText =
          focusedGateId === null && nodes.length > 1
            ? r.label === "Start" || r.label === "Finish"
              ? `${r.gateLbl} · ${r.label}`
              : r.gateLbl
            : `${r.gateLbl} · ${fmtRelSec(relDragMs)}`;
        const showInlineDel = pinEditable && !isDragging;
        const delExtraW = showInlineDel ? 16 : 0;
        const pillW = Math.max(44, tagText.length * 6.3 + 12 + delExtraW);
        const pillX = clamp(x - pillW / 2, PAD_L, svgW - PAD_R - pillW);
        let pillY = 2;
        if (pillX < lastLane0Right + 4 && !isDragging && !isSel) {
          pillY = 19;
        } else {
          lastLane0Right = pillX + pillW;
        }
        const textCenterX = pillX + (pillW - delExtraW) / 2;
        const delCx = pillX + pillW - 9;
        const delCy = pillY + 8.25;
        const pinStroke = isSel || isDragging ? "" : `style="stroke:${esc(r.gateClr)}"`;
        return `
          <g class="${cls}" data-crossing-pin="${r.crossing.crossingId}" data-crossing-gate="${r.gateId}">
            <line x1="${xf}" y1="${PAD_T}" x2="${xf}" y2="${svgH - PAD_B}" class="lap-ed-pin-line" ${pinStroke} />
            <line x1="${xf}" y1="${PAD_T}" x2="${xf}" y2="${svgH - PAD_B}" class="lap-ed-pin-hit" />
            <rect x="${pillX.toFixed(1)}" y="${pillY}" width="${pillW.toFixed(1)}" height="16.5" rx="4.5" class="lap-ed-pin-pill" ${pinStroke} />
            <text x="${textCenterX.toFixed(1)}" y="${(pillY + 11.7).toFixed(1)}" text-anchor="middle" class="lap-ed-pin-lbl">${esc(tagText)}</text>
            ${
              showInlineDel
                ? `<g class="lap-ed-pin-del" data-pin-delete="${r.crossing.crossingId}" data-pin-delete-gate="${r.gateId}">
                    <circle cx="${delCx.toFixed(1)}" cy="${delCy.toFixed(1)}" r="6.5" fill="rgba(239,68,68,0.22)" />
                    <path d="M ${(delCx - 2.6).toFixed(1)},${(delCy - 2.6).toFixed(1)} L ${(delCx + 2.6).toFixed(1)},${(delCy + 2.6).toFixed(1)} M ${(delCx + 2.6).toFixed(1)},${(delCy - 2.6).toFixed(1)} L ${(delCx - 2.6).toFixed(1)},${(delCy + 2.6).toFixed(1)}" stroke="#fca5a5" stroke-width="1.35" stroke-linecap="round" />
                  </g>`
                : ""
            }
          </g>`;
      })
      .join("");

    let hoverHtml = "";
    if (hoverInfo && !dragState && !threshDrag && !viewDrag) {
      const hx = clamp(msToX(hoverInfo.offsetMs), PAD_L, svgW - PAD_R).toFixed(1);
      const hLbl = `${fmtRelSec(hoverInfo.offsetMs - axisZeroMs)}${hoverInfo.dbm !== null ? ` · ${hoverInfo.gateLbl ? `${hoverInfo.gateLbl} ` : ""}${hoverInfo.dbm}${isSlapRFMode(hwMode) ? " dBm" : ""}` : ""}`;
      hoverHtml = `
        <g class="lap-ed-hover-guide" pointer-events="none">
          <line x1="${hx}" y1="${PAD_T}" x2="${hx}" y2="${svgH - PAD_B}" class="lap-ed-hover-line" />
          <text x="${clamp(Number(hx) + 6, PAD_L + 4, svgW - PAD_R - 140).toFixed(1)}" y="${svgH - PAD_B - 6}" class="lap-ed-hover-lbl">${esc(hLbl)}</text>
        </g>`;
    }

    const svgStateCls = [
      "lap-ed-svg",
      dragState || viewDrag?.mode === "xstretch" ? "is-dragging" : "",
      threshDrag || viewDrag?.mode === "ystretch" ? "is-dragging-thresh" : "",
      viewDrag?.mode === "pan" ? "is-panning" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return `
      <svg class="${svgStateCls}" viewBox="0 0 ${svgW} ${svgH}" preserveAspectRatio="none" data-lap-ed-svg>
        <defs>
          ${gradDefs.join("")}
          <clipPath id="lapEdPlotClip">
            <rect x="${PAD_L}" y="${PAD_T}" width="${plotW}" height="${plotH}" rx="4" />
          </clipPath>
        </defs>
        <rect x="${PAD_L}" y="${PAD_T}" width="${plotW}" height="${plotH}" rx="4" class="lap-ed-plot-bg" />
        ${yTicks.join("")}
        ${xTicks.join("")}
        <g clip-path="url(#lapEdPlotClip)">
          ${lapFrameHtml}
          ${waveParts.join("")}
        </g>
        ${threshHtml}
        ${hoverHtml}
        ${pinsHtml}
        <rect x="0" y="${PAD_T}" width="${PAD_L + 6}" height="${plotH}" fill="transparent" class="lap-ed-y-axis-hit" data-axis-drag="y"></rect>
        <rect x="${PAD_L}" y="${svgH - PAD_B - 6}" width="${plotW}" height="${PAD_B + 6}" fill="transparent" class="lap-ed-x-axis-hit" data-axis-drag="x"></rect>
      </svg>`;
  };

  const renderModal = (): void => {
    const sess = getSession();
    if (!sess) {
      close();
      return;
    }
    const prevSvgWrap = backdrop.querySelector<HTMLElement>("[data-lap-ed-svg-wrap]");
    if (prevSvgWrap) {
      if (prevSvgWrap.clientWidth > 120) svgW = Math.round(prevSvgWrap.clientWidth);
      if (prevSvgWrap.clientHeight > 120) svgH = Math.round(prevSvgWrap.clientHeight);
    }

    const nodes = nodesList();
    if (nodes.length === 1 && focusedGateId === null) {
      focusedGateId = nodes[0].gateId;
    } else if (focusedGateId !== null && !nodes.some((n) => n.gateId === focusedGateId)) {
      focusedGateId = defaultFocusedGateId();
    }

    const anchorUs = computeSessionAnchorUs(sess);
    activeHardBounds = computeLockedLapBounds(sess, anchorUs);
    const lapRows = deriveLapPassRows(sess, anchorUs, activeHardBounds);
    const visibleCrossingRows =
      focusedGateId === null ? lapRows : lapRows.filter((r) => r.gateId === focusedGateId);

    const pilot =
      sess.pilots.find((p) => p.slotIndex === selectedPilotSlot) ??
      reviewStore.pilot(selectedPilotSlot);
    const callsign = pilot?.callsign || `Pilot ${selectedPilotSlot}`;
    const color = pilot?.color || "#38bdf8";
    const chLabel = pilot?.channel ? formatBandChannelShort(pilot.band, pilot.channel) : "";
    const { hwMode } = getGateThresholds(focusedGateId ?? sfGateId(), selectedPilotSlot);

    const lapBadgeHtml =
      activeHardBounds?.lapNumber !== null && activeHardBounds?.lapNumber !== undefined
        ? `<span class="lap-ed-badge mono">L${activeHardBounds.lapNumber}${activeHardBounds.lapTimeSec !== null ? ` · ${fmtTime(activeHardBounds.lapTimeSec)}` : ""}</span>`
        : "";

    const hasCustomView = Boolean(isCustomXZoomed() || customY);
    const isDirty = hasUnsavedChanges();
    const curGateLabel = focusedGateId !== null ? gateLabel(reviewStore, focusedGateId) : null;
    const unlocked = canEditFocusedLines();

    // In-chart top bar matching `Signals` (`[Auto-Label] [Reset View]` on left, `[ + ] [ 🔒 ]` on right!)
    const chartOverlayActionsHtml =
      focusedGateId !== null && curGateLabel
        ? `<div class="lap-ed-chart-lock-group" role="group" aria-label="Chart line controls">
            <button
              type="button"
              class="scope-chart-action-btn"
              data-lap-ed-add-crossing
              ${unlocked ? "" : "disabled"}
              title="${unlocked ? `Add ${esc(curGateLabel)} crossing` : `Unlock chart lines to add ${esc(curGateLabel)} crossings`}"
              aria-label="${unlocked ? `Add ${esc(curGateLabel)} crossing` : `Unlock chart lines to add ${esc(curGateLabel)} crossings`}"
            >${icons.plus(15)}</button>
            <button
              type="button"
              class="scope-chart-action-btn ${chartLinesLocked ? "is-locked" : "is-unlocked"}"
              data-lap-ed-toggle-lock
              aria-pressed="${String(!chartLinesLocked)}"
              title="${chartLinesLocked ? `Unlock ${esc(curGateLabel)} threshold and crossing lines` : `Lock ${esc(curGateLabel)} threshold and crossing lines`}"
              aria-label="${chartLinesLocked ? `Unlock ${esc(curGateLabel)} threshold and crossing lines` : `Lock ${esc(curGateLabel)} threshold and crossing lines`}"
            >${chartLinesLocked ? icons.lock(14) : icons.unlock(14)}</button>
          </div>`
        : `<span class="lap-ed-chart-select-hint muted">Select a timer below to unlock &amp; edit</span>`;

    // Row 1 below chart: Timer selector pills (`All`, `H1`, `T1`, ...) matching `Signals`
    const allChipHtml =
      nodes.length > 1
        ? `<button type="button" class="btn ${focusedGateId === null ? "btn-armed" : "btn-ghost"} btn-xs lap-ed-gate-chip" data-lap-ed-gate="all" title="Show all timers overlaid"><span class="dot channel-all-dot"></span><span>All</span></button>`
        : "";
    const gateChipsHtml = `<div class="lap-ed-timers-row" role="group" aria-label="Timers">${allChipHtml}${nodes
      .map((g) => {
        const gActive = focusedGateId === g.gateId;
        const gLbl = gateLabel(reviewStore, g.gateId);
        const gClr = gateColor(reviewStore, g.gateId);
        return `<button type="button" class="btn ${gActive ? "btn-armed" : "btn-ghost"} btn-xs lap-ed-gate-chip" data-lap-ed-gate="${g.gateId}" title="${gActive && nodes.length > 1 ? `Viewing ${esc(gLbl)} (tap again for All timers)` : `Select ${esc(gLbl)}`}"><span class="dot" style="background:${esc(gClr)}"></span><span>${esc(gLbl)}</span></button>`;
      })
      .join("")}</div>`;

    // Row 2 below timers: Compact Crossings row for THIS lap
    const crossingsRowHtml =
      visibleCrossingRows.length === 0
        ? `<div class="lap-ed-crossings-empty muted">${
            focusedGateId === null
              ? "No crossings marked in this lap."
              : `No ${esc(curGateLabel ?? "")} crossing in this lap${chartLinesLocked ? " · tap lock icon in chart to add" : " · tap + in chart to add"}.`
          }</div>`
        : visibleCrossingRows
            .map((r) => {
              const isSel = selectedCrossingId !== null && r.crossing.crossingId === selectedCrossingId;
              const chipEditable = !chartLinesLocked && focusedGateId === r.gateId;
              const rolePrefix =
                r.label === "Start" || r.label === "Finish" ? `${r.label} · ` : "";
              const dbmSuffix =
                r.peakDbm !== null
                  ? ` · ${r.peakDbm}${isSlapRFMode(hwMode) ? "dBm" : ""}`
                  : "";
              return `<div class="lap-ed-crossing-chip ${isSel ? "is-selected" : ""} ${r.label === "INV" ? "is-invalid" : ""}" data-lap-ed-row="${r.crossing.crossingId}" data-lap-ed-row-gate="${r.gateId}">
                <span class="dot" style="background:${esc(r.gateClr)}"></span>
                <strong class="mono">${esc(r.gateLbl)}</strong>
                <span class="lap-ed-chip-meta mono">${esc(rolePrefix)}${fmtRelSec(r.relMs)}${esc(dbmSuffix)}</span>
                ${
                  chipEditable
                    ? `<button type="button" class="lap-ed-chip-del" data-lap-ed-delete="${r.crossing.crossingId}" data-lap-ed-delete-gate="${r.gateId}" title="Delete ${esc(r.gateLbl)} crossing" aria-label="Delete ${esc(r.gateLbl)} crossing">${icons.close(12)}</button>`
                    : ""
                }
              </div>`;
            })
            .join("");

    backdrop.innerHTML = `
      <div class="slaprf-modal card rc-modal-xl lap-editor-modal" role="document">
        <div class="slaprf-modal-head lap-ed-head">
          <div class="slaprf-modal-title-row lap-ed-head-left">
            <h3>
              <span class="lap-ed-title-pilot">
                <span class="dot" style="background:${esc(color)}"></span>
                <span>${esc(callsign)}${chLabel ? ` (${esc(chLabel)})` : ""}</span>
                ${lapBadgeHtml}
              </span>
            </h3>
          </div>
          <button type="button" class="btn btn-ghost btn-xs lap-ed-desktop-close-btn" data-lap-ed-close aria-label="Close">
            ${icons.close(15)}
          </button>
        </div>
        <div class="slaprf-modal-body lap-ed-body">
          <div class="lap-ed-graph-card">
            <div class="lap-ed-chart-toolbar">
              <div class="lap-ed-chart-toolbar-left">
                <button
                  type="button"
                  class="btn btn-ghost btn-xs"
                  data-lap-ed-auto-label
                  ${isSaving || Boolean(rootStore.mlStatus.teacher?.download?.running) ? "disabled" : ""}
                  title="${isAutoLabeling ? "Cancel AI auto-labeling" : "Auto-label crossings in this lap on-device"}"
                >
                  ${isAutoLabeling ? icons.close(12) : icons.reviewCheck(13)}<span>${
                    isAutoLabeling
                      ? "Cancel AI"
                      : rootStore.mlStatus.teacher?.download?.running
                        ? `AI ${Math.round(rootStore.mlStatus.teacher.download.percent || 0)}%`
                        : "Auto-Label"
                  }</span>
                </button>
                <button type="button" class="btn btn-ghost btn-xs" data-lap-ed-reset-view ${hasCustomView ? "" : "hidden"}>
                  ${icons.maximize(13)}<span>Reset Scale</span>
                </button>
              </div>
              <div class="lap-ed-chart-toolbar-right">
                ${chartOverlayActionsHtml}
              </div>
            </div>
            <div class="lap-ed-svg-wrap" data-lap-ed-svg-wrap>
              ${renderGraphSvg(sess, anchorUs, lapRows)}
            </div>
          </div>

          ${gateChipsHtml}

          <div class="lap-ed-crossings-strip" role="list" aria-label="Lap crossings">
            ${crossingsRowHtml}
          </div>
        </div>
        <div class="slaprf-modal-foot lap-ed-save-foot">
          <button type="button" class="btn" data-lap-ed-discard ${isDirty && !isSaving ? "" : "disabled"}>
            ${icons.close(15)}<span>Discard</span>
          </button>
          <button type="button" class="btn btn-armed" data-lap-ed-save ${isDirty && !isSaving ? "" : "disabled"}>
            ${icons.check(15)}<span>${isSaving ? "Saving…" : "Save Changes"}</span>
          </button>
        </div>
      </div>`;

    const nextSvgWrap = backdrop.querySelector<HTMLElement>("[data-lap-ed-svg-wrap]");
    if (resizeObserver && nextSvgWrap) {
      resizeObserver.observe(nextSvgWrap);
    }
  };

  const refreshSvgOnly = (): void => {
    const wrap = backdrop.querySelector<HTMLElement>("[data-lap-ed-svg-wrap]");
    const sess = getSession();
    if (!wrap || !sess) return;
    if (wrap.clientWidth > 120) svgW = Math.round(wrap.clientWidth);
    if (wrap.clientHeight > 120) svgH = Math.round(wrap.clientHeight);
    const anchorUs = computeSessionAnchorUs(sess);
    activeHardBounds = computeLockedLapBounds(sess, anchorUs);
    const lapRows = deriveLapPassRows(sess, anchorUs, activeHardBounds);
    wrap.innerHTML = renderGraphSvg(sess, anchorUs, lapRows);
    const resetBtn = backdrop.querySelector<HTMLButtonElement>("[data-lap-ed-reset-view]");
    if (resetBtn) resetBtn.hidden = !(isCustomXZoomed() || customY);
  };

  const focusPassRow = (crossingId: number): void => {
    const sess = getSession();
    if (!sess) return;
    const anchorUs = computeSessionAnchorUs(sess);
    const lapRows = deriveLapPassRows(sess, anchorUs, computeLockedLapBounds(sess, anchorUs));
    const row = lapRows.find((r) => r.crossing.crossingId === crossingId);
    if (!row) return;
    focusedGateId = row.gateId;
    selectedCrossingId = crossingId;
    renderModal();
  };

  /**
   * Matches `PilotRssiChart.addManualCrossing()`: immediately drops a new crossing onto the focused
   * timer's strongest uncrossed RSSI peak inside the visible lap window (or window midpoint if flat)
   * so the user can drag it directly without an extra click-mode step!
   */
  const stageAddManualCrossing = (): void => {
    const sess = getSession();
    if (!sess || focusedGateId === null || chartLinesLocked) return;
    const gid = focusedGateId;
    const anchorUs = computeSessionAnchorUs(sess);
    const dom = customX ? clampXDomain(customX.minMs, customX.maxMs) : computeDefaultDomainMs(sess, anchorUs, []);
    const searchLo = activeHardBounds ? Math.max(dom.minMs, activeHardBounds.startMs - 200) : dom.minMs;
    const searchHi = activeHardBounds ? Math.min(dom.maxMs, activeHardBounds.endMs + 200) : dom.maxMs;
    const trace = buildTraceMsInWindow(sess, anchorUs, gid, selectedPilotSlot, searchLo, searchHi);
    const draft = ensureDraftGateCrossings(sess, gid);

    // Pick strongest uncrossed peak in `[searchLo, searchHi]`, falling back to window center
    let targetMs = Math.round((searchLo + searchHi) * 0.5);
    let bestPeakDbm: number | null = null;
    for (const pt of trace) {
      if (pt.t < searchLo || pt.t > searchHi) continue;
      const candUs = Math.max(1000, anchorUs + pt.t * 1000);
      const nearExisting = draft.some((c) => Math.abs(c.timestampUs - candUs) < 280_000);
      if (!nearExisting && (bestPeakDbm === null || pt.r > bestPeakDbm)) {
        bestPeakDbm = pt.r;
        targetMs = pt.t;
      }
    }

    let tsUs = Math.max(1000, anchorUs + targetMs * 1000);
    while (draft.some((c) => Math.abs(c.timestampUs - tsUs) < 35_000)) {
      tsUs += 150_000;
    }
    const sampledPeak = sampleTraceAtMs(trace, Math.round((tsUs - anchorUs) / 1000));
    const newId = nextDraftId--;
    draft.push({
      crossingId: newId,
      gateId: gid,
      timestampUs: tsUs,
      peakRssiDbm: sampledPeak ?? (bestPeakDbm !== null ? Math.round(bestPeakDbm) : -52),
      manual: true,
    });
    draft.sort((a, b) => a.timestampUs - b.timestampUs);
    selectedCrossingId = newId;
    renderModal();
  };

  const deleteDraftCrossing = (cid: number, delGateId: number | null): void => {
    const sess = getSession();
    if (!sess || cid === 0 || delGateId === null) return;
    const draft = ensureDraftGateCrossings(sess, delGateId);
    const idx = draft.findIndex((c) => c.crossingId === cid);
    if (idx >= 0) {
      draft.splice(idx, 1);
      if (selectedCrossingId === cid) selectedCrossingId = null;
      renderModal();
    }
  };

  const saveChanges = async (): Promise<void> => {
    const sess = getSession();
    if (!sess || isSaving || !hasUnsavedChanges()) return;
    isSaving = true;
    renderModal();
    try {
      const stagedGates = Array.from(draftByGate.entries());
      const stagedThresh = Array.from(draftThresholdsByGate.entries());
      draftByGate.clear();
      draftThresholdsByGate.clear();

      for (const [gateId, draftList] of stagedGates) {
        const origList = extractOriginalGateCrossings(sess, gateId, selectedPilotSlot);
        const draftById = new Map(draftList.map((c) => [c.crossingId, c]));

        for (const orig of origList) {
          if (!draftById.has(orig.crossingId)) {
            await scopedApi.deleteCrossing(orig.crossingId);
          }
        }
        for (const orig of origList) {
          const upd = draftById.get(orig.crossingId);
          if (upd && Math.abs(upd.timestampUs - orig.timestampUs) >= 1000) {
            await scopedApi.adjustCrossing(orig.crossingId, upd.timestampUs);
          }
        }
        for (const item of draftList) {
          if (item.crossingId < 0) {
            await scopedApi.addCrossing(
              gateId,
              selectedPilotSlot,
              item.timestampUs,
              item.peakRssiDbm
            );
          }
        }
      }

      for (const [gateId, thr] of stagedThresh) {
        if (isLapRFMode(thr.hwMode)) {
          await scopedApi.setGateThresholds([
            { gateId, slotIndex: selectedPilotSlot, enterDbm: 0, laprfThreshold: thr.enterDb },
          ]);
        } else if (isRotorHazardMode(thr.hwMode)) {
          await scopedApi.setGateThresholds([
            {
              gateId,
              slotIndex: selectedPilotSlot,
              enterDbm: 0,
              rhEnterThreshold: thr.enterDb,
              rhExitThreshold: thr.exitDb,
            },
          ]);
        } else {
          await scopedApi.setGateThresholds([
            {
              gateId,
              slotIndex: selectedPilotSlot,
              enterDbm: thr.enterDb,
              exitDbm: thr.exitDb,
            },
          ]);
        }
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      isSaving = false;
      renderModal();
    }
  };

  const touchPts = new Map<
    number,
    { px: PinchPoint; client: PinchPoint; svgX: number; svgY: number }
  >();
  let pinchState: {
    id1: number;
    id2: number;
    p1Start: PinchPoint;
    p2Start: PinchPoint;
    p1ClientStart: PinchPoint;
    p2ClientStart: PinchPoint;
    lastMidClientY: number;
    pageScrollLocked: boolean;
    pinchLocked: boolean;
    startMinMs: number;
    startMaxMs: number;
    startMinDbm: number;
    startMaxDbm: number;
    anchorXFrac: number;
    anchorYFrac: number;
  } | null = null;

  const onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const target = e.target as Element | null;
    const sess = getSession();
    const svg = backdrop.querySelector<SVGSVGElement>("[data-lap-ed-svg]");
    if (!target || !sess || !svg || !target.closest("[data-lap-ed-svg]")) return;

    // Inline `×` delete button on an unlocked crossing pin
    const pinDel = target.closest<SVGGElement>("[data-pin-delete]");
    if (pinDel) {
      e.preventDefault();
      e.stopPropagation();
      const cid = Number(pinDel.getAttribute("data-pin-delete") || "0");
      const gid = Number(pinDel.getAttribute("data-pin-delete-gate") || "0") || focusedGateId;
      deleteDraftCrossing(cid, gid);
      return;
    }

    const plotW = getPlotW();
    const { svgX, svgY } = clientToSvgCoords(svg, e.clientX, e.clientY);

    if (e.pointerType === "touch") {
      const svgRect = svg.getBoundingClientRect();
      touchPts.set(e.pointerId, {
        px: { x: e.clientX - svgRect.left, y: e.clientY - svgRect.top },
        client: { x: e.clientX, y: e.clientY },
        svgX,
        svgY,
      });
      try {
        backdrop.setPointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
      if (touchPts.size >= 2) {
        e.preventDefault();
        viewDrag = null;
        threshDrag = null;
        dragState = null;
        const [[id1, pt1], [id2, pt2]] = Array.from(touchPts.entries());
        pinchState = {
          id1,
          id2,
          p1Start: { ...pt1.px },
          p2Start: { ...pt2.px },
          p1ClientStart: { ...pt1.client },
          p2ClientStart: { ...pt2.client },
          lastMidClientY: (pt1.client.y + pt2.client.y) * 0.5,
          pageScrollLocked: false,
          pinchLocked: false,
          startMinMs: lastDomain.minMs,
          startMaxMs: lastDomain.maxMs,
          startMinDbm: lastYDomain.minDbm,
          startMaxDbm: lastYDomain.maxDbm,
          anchorXFrac: clamp(((pt1.svgX + pt2.svgX) * 0.5 - PAD_L) / plotW, 0, 1),
          anchorYFrac: clamp(1 - ((pt1.svgY + pt2.svgY) * 0.5 - PAD_T) / getPlotH(), 0, 1),
        };
        refreshSvgOnly();
        return;
      }
    }

    // 1. Stretchable Y-axis (left) and X-axis (bottom)
    const axisEl = target.closest("[data-axis-drag]");
    const axisKind = axisEl?.getAttribute("data-axis-drag");
    if (axisKind === "y" || (svgX < PAD_L && svgY >= PAD_T && svgY <= svgH - PAD_B)) {
      e.preventDefault();
      const yFrac = clamp(1 - (svgY - PAD_T) / getPlotH(), 0, 1);
      viewDrag = {
        mode: "ystretch",
        pointerId: e.pointerId,
        startSvgX: svgX,
        startSvgY: svgY,
        startMinMs: lastDomain.minMs,
        startMaxMs: lastDomain.maxMs,
        startMinDbm: lastYDomain.minDbm,
        startMaxDbm: lastYDomain.maxDbm,
        anchorFrac: yFrac,
        tappedTraceGateId: null,
        panned: true,
      };
      hoverInfo = null;
      try {
        backdrop.setPointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
      refreshSvgOnly();
      return;
    }

    if (axisKind === "x" || (svgY > svgH - PAD_B && svgX >= PAD_L && svgX <= svgW - PAD_R)) {
      e.preventDefault();
      const xFrac = clamp((svgX - PAD_L) / plotW, 0, 1);
      viewDrag = {
        mode: "xstretch",
        pointerId: e.pointerId,
        startSvgX: svgX,
        startSvgY: svgY,
        startMinMs: lastDomain.minMs,
        startMaxMs: lastDomain.maxMs,
        startMinDbm: lastYDomain.minDbm,
        startMaxDbm: lastYDomain.maxDbm,
        anchorFrac: xFrac,
        tappedTraceGateId: null,
        panned: true,
      };
      hoverInfo = null;
      try {
        backdrop.setPointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
      refreshSvgOnly();
      return;
    }

    // 2. Threshold drag (when unlocked on a focused timer)
    const threshHandle = target.closest<SVGGElement>("[data-thresh-handle]");
    if (threshHandle && canEditFocusedLines() && focusedGateId !== null) {
      e.preventDefault();
      const kind = threshHandle.getAttribute("data-thresh-handle") === "exit" ? "exit" : "enter";
      const cur = getGateThresholds(focusedGateId, selectedPilotSlot);
      threshDrag = {
        kind,
        gateId: focusedGateId,
        pointerId: e.pointerId,
        currentDbm: kind === "enter" ? cur.enterDb : cur.exitDb,
      };
      try {
        backdrop.setPointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
      refreshSvgOnly();
      return;
    }

    // 3. Crossing pin select / drag (draggable when unlocked on that timer; selects timer when tapped in All mode)
    const pin = target.closest<SVGGElement>("[data-crossing-pin]");
    if (pin) {
      e.preventDefault();
      const cid = Number(pin.getAttribute("data-crossing-pin") || "0");
      const anchorUs = computeSessionAnchorUs(sess);
      const lapRows = deriveLapPassRows(sess, anchorUs, computeLockedLapBounds(sess, anchorUs));
      const row = lapRows.find((r) => r.crossing.crossingId === cid);
      if (!row) return;
      if (focusedGateId !== row.gateId) {
        focusedGateId = row.gateId;
        selectedCrossingId = cid;
        renderModal();
        return;
      }
      selectedCrossingId = cid;
      if (chartLinesLocked) {
        renderModal();
        return;
      }
      dragState = {
        crossingId: cid,
        gateId: row.gateId,
        pointerId: e.pointerId,
        startClientX: e.clientX,
        moved: false,
        currentOffsetMs: row.offsetMs,
      };
      try {
        backdrop.setPointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
      refreshSvgOnly();
      return;
    }

    if (svgX >= PAD_L && svgX <= svgW - PAD_R && svgY >= PAD_T && svgY <= svgH - PAD_B) {
      e.preventDefault();
      const traceHit = target.closest<SVGElement>("[data-trace-gate]");
      const tappedTraceGateId = traceHit
        ? Number(traceHit.getAttribute("data-trace-gate") || "0") || null
        : null;
      viewDrag = {
        mode: "pan",
        pointerId: e.pointerId,
        startSvgX: svgX,
        startSvgY: svgY,
        startMinMs: lastDomain.minMs,
        startMaxMs: lastDomain.maxMs,
        startMinDbm: lastYDomain.minDbm,
        startMaxDbm: lastYDomain.maxDbm,
        anchorFrac: 0.5,
        tappedTraceGateId,
        panned: false,
      };
      try {
        backdrop.setPointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
      refreshSvgOnly();
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    const svg = backdrop.querySelector<SVGSVGElement>("[data-lap-ed-svg]");
    const sess = getSession();
    if (!svg || !sess) return;

    if (e.pointerType === "touch" && touchPts.has(e.pointerId)) {
      const svgRect = svg.getBoundingClientRect();
      const { svgX, svgY } = clientToSvgCoords(svg, e.clientX, e.clientY);
      touchPts.set(e.pointerId, {
        px: { x: e.clientX - svgRect.left, y: e.clientY - svgRect.top },
        client: { x: e.clientX, y: e.clientY },
        svgX,
        svgY,
      });
      if (pinchState) {
        const pt1 = touchPts.get(pinchState.id1);
        const pt2 = touchPts.get(pinchState.id2);
        if (pt1 && pt2) {
          const clientPinch = computeDirectionalPinch(
            pinchState.p1ClientStart,
            pinchState.p2ClientStart,
            pt1.client,
            pt2.client
          );
          const curMidY = (pt1.client.y + pt2.client.y) * 0.5;
          const dyClient = curMidY - pinchState.lastMidClientY;
          pinchState.lastMidClientY = curMidY;
          if (!pinchState.pinchLocked && clientPinch.mode === "page-scroll") {
            pinchState.pageScrollLocked = true;
            scrollOuterPageBy(-dyClient, svg);
            return;
          }
          pinchState.pinchLocked = true;
          const plotW = getPlotW();
          const pinch = computeDirectionalPinch(pinchState.p1Start, pinchState.p2Start, pt1.px, pt2.px);
          if (pinch.mode === "x" || pinch.mode === "xy") {
            const startSpan = pinchState.startMaxMs - pinchState.startMinMs;
            const maxSpan = activeHardBounds
              ? Math.max(MIN_X_SPAN_MS, activeHardBounds.hardMaxMs - activeHardBounds.hardMinMs)
              : MAX_FALLBACK_X_SPAN_MS;
            const nextSpan = clamp(startSpan * pinch.xSpanFactor, MIN_X_SPAN_MS, maxSpan);
            const anchorMs = pinchState.startMinMs + pinchState.anchorXFrac * startSpan;
            const liveXFrac = clamp(((pt1.svgX + pt2.svgX) * 0.5 - PAD_L) / plotW, 0, 1);
            const nextMin = anchorMs - liveXFrac * nextSpan;
            customX = clampXDomain(nextMin, nextMin + nextSpan);
          }
          if (pinch.mode === "y" || pinch.mode === "xy") {
            const startSpanDb = pinchState.startMaxDbm - pinchState.startMinDbm;
            const { minSpan, maxSpan } = ySpanBounds(lastHwMode);
            const nextSpanDb = clamp(startSpanDb * pinch.ySpanFactor, minSpan, maxSpan);
            const anchorDb = pinchState.startMinDbm + pinchState.anchorYFrac * startSpanDb;
            const liveYFrac = clamp(1 - ((pt1.svgY + pt2.svgY) * 0.5 - PAD_T) / getPlotH(), 0, 1);
            const nextMinDb = anchorDb - liveYFrac * nextSpanDb;
            customY = clampYDomain(nextMinDb, nextMinDb + nextSpanDb);
          }
          refreshSvgOnly();
        }
        return;
      }
    }

    if (viewDrag) {
      const plotW = getPlotW();
      const { svgX, svgY } = clientToSvgCoords(svg, e.clientX, e.clientY);
      const dx = svgX - viewDrag.startSvgX;
      const dy = svgY - viewDrag.startSvgY;

      if (viewDrag.mode === "ystretch") {
        const startSpan = viewDrag.startMaxDbm - viewDrag.startMinDbm;
        const factor = Math.exp(dy / 135);
        const { minSpan, maxSpan } = ySpanBounds(lastHwMode);
        const nextSpan = clamp(startSpan * factor, minSpan, maxSpan);
        const anchorDbm = viewDrag.startMinDbm + viewDrag.anchorFrac * startSpan;
        const nextMin = anchorDbm - viewDrag.anchorFrac * nextSpan;
        customY = clampYDomain(nextMin, nextMin + nextSpan);
        refreshSvgOnly();
        return;
      }

      if (viewDrag.mode === "xstretch") {
        const startSpan = viewDrag.startMaxMs - viewDrag.startMinMs;
        const factor = Math.exp(-dx / 145);
        const maxSpan = activeHardBounds
          ? Math.max(MIN_X_SPAN_MS, activeHardBounds.hardMaxMs - activeHardBounds.hardMinMs)
          : MAX_FALLBACK_X_SPAN_MS;
        const nextSpan = clamp(startSpan * factor, MIN_X_SPAN_MS, maxSpan);
        const anchorMs = viewDrag.startMinMs + viewDrag.anchorFrac * startSpan;
        const nextMin = anchorMs - viewDrag.anchorFrac * nextSpan;
        customX = clampXDomain(nextMin, nextMin + nextSpan);
        refreshSvgOnly();
        return;
      }

      if (Math.hypot(dx, dy) >= 4.5) {
        viewDrag.panned = true;
      }
      if (viewDrag.panned) {
        if (!activeHardBounds || isCustomXZoomed()) {
          const spanMs = viewDrag.startMaxMs - viewDrag.startMinMs;
          const deltaMs = -(dx / plotW) * spanMs;
          customX = clampXDomain(viewDrag.startMinMs + deltaMs, viewDrag.startMaxMs + deltaMs);
        }
        if (Math.abs(dy) >= 2.5 || customY) {
          const spanDb = viewDrag.startMaxDbm - viewDrag.startMinDbm;
          const deltaDb = (dy / getPlotH()) * spanDb;
          customY = clampYDomain(viewDrag.startMinDbm + deltaDb, viewDrag.startMaxDbm + deltaDb);
        }
        refreshSvgOnly();
      }
      return;
    }

    if (threshDrag) {
      const { svgY } = clientToSvgCoords(svg, e.clientX, e.clientY);
      threshDrag.currentDbm = yToDbm(svgY);
      refreshSvgOnly();
      return;
    }

    if (dragState) {
      if (Math.abs(e.clientX - dragState.startClientX) >= 2) {
        dragState.moved = true;
      }
      dragState.currentOffsetMs = clientXToMs(svg, e.clientX);
      refreshSvgOnly();
      return;
    }

    if (e.pointerType === "mouse") {
      const offsetMs = clientXToMs(svg, e.clientX);
      const anchorUs = computeSessionAnchorUs(sess);
      if (focusedGateId !== null) {
        const trace = buildTraceMsInWindow(
          sess,
          anchorUs,
          focusedGateId,
          selectedPilotSlot,
          offsetMs - 800,
          offsetMs + 800
        );
        hoverInfo = {
          offsetMs,
          dbm: sampleTraceAtMs(trace, offsetMs),
          gateLbl: gateLabel(reviewStore, focusedGateId),
        };
      } else {
        let bestDbm: number | null = null;
        let bestLbl = "";
        for (const g of nodesList()) {
          const trace = buildTraceMsInWindow(
            sess,
            anchorUs,
            g.gateId,
            selectedPilotSlot,
            offsetMs - 800,
            offsetMs + 800
          );
          const v = sampleTraceAtMs(trace, offsetMs);
          if (v !== null && (bestDbm === null || v > bestDbm)) {
            bestDbm = v;
            bestLbl = gateLabel(reviewStore, g.gateId);
          }
        }
        hoverInfo = { offsetMs, dbm: bestDbm, gateLbl: bestLbl };
      }
      refreshSvgOnly();
    }
  };

  const onPointerUp = (e: PointerEvent): void => {
    touchPts.delete(e.pointerId);
    if (touchPts.size < 2) pinchState = null;

    const sess = getSession();
    if (dragState && sess) {
      const movedId = dragState.crossingId;
      const movedGateId = dragState.gateId;
      const nextMs = dragState.currentOffsetMs;
      const didMove = dragState.moved;
      dragState = null;
      if (didMove) {
        const anchorUs = computeSessionAnchorUs(sess);
        const trace = buildTraceMsInWindow(
          sess,
          anchorUs,
          movedGateId,
          selectedPilotSlot,
          nextMs - 1000,
          nextMs + 1000
        );
        const draft = ensureDraftGateCrossings(sess, movedGateId);
        const item = draft.find((c) => c.crossingId === movedId);
        if (item) {
          item.timestampUs = Math.max(1000, anchorUs + nextMs * 1000);
          const pk = sampleTraceAtMs(trace, nextMs);
          if (pk !== null) item.peakRssiDbm = pk;
          item.manual = true;
          draft.sort((a, b) => a.timestampUs - b.timestampUs);
        }
      }
      renderModal();
      return;
    }

    if (threshDrag) {
      const cur = getGateThresholds(threshDrag.gateId, selectedPilotSlot);
      const tGate = threshDrag.gateId;
      threshDrag = null;
      draftThresholdsByGate.set(tGate, cur);
      renderModal();
      return;
    }

    if (viewDrag) {
      const tappedGate = !viewDrag.panned ? viewDrag.tappedTraceGateId : null;
      viewDrag = null;
      if (tappedGate !== null && tappedGate !== focusedGateId) {
        focusedGateId = tappedGate;
        selectedCrossingId = null;
        renderModal();
        return;
      }
      refreshSvgOnly();
    }
  };

  const onWheel = (e: WheelEvent): void => {
    const svg = backdrop.querySelector<SVGSVGElement>("[data-lap-ed-svg]");
    if (!svg || !(e.target instanceof Element) || !e.target.closest("[data-lap-ed-svg]")) return;
    e.preventDefault();
    const plotW = getPlotW();
    const { svgX, svgY } = clientToSvgCoords(svg, e.clientX, e.clientY);
    const { xSpanFactor, ySpanFactor, mode } = computeWheelZoomFactors(e);
    if (mode === "x" || mode === "xy") {
      const spanMs = lastDomain.maxMs - lastDomain.minMs;
      const maxSpan = activeHardBounds
        ? Math.max(MIN_X_SPAN_MS, activeHardBounds.hardMaxMs - activeHardBounds.hardMinMs)
        : MAX_FALLBACK_X_SPAN_MS;
      const nextSpan = clamp(spanMs * xSpanFactor, MIN_X_SPAN_MS, maxSpan);
      const frac = clamp((svgX - PAD_L) / plotW, 0, 1);
      const anchor = lastDomain.minMs + frac * spanMs;
      customX = clampXDomain(anchor - frac * nextSpan, anchor + (1 - frac) * nextSpan);
    }
    if (mode === "y" || mode === "xy") {
      const spanDb = lastYDomain.maxDbm - lastYDomain.minDbm;
      const { minSpan, maxSpan } = ySpanBounds(lastHwMode);
      const nextSpanDb = clamp(spanDb * ySpanFactor, minSpan, maxSpan);
      const yFrac = clamp(1 - (svgY - PAD_T) / getPlotH(), 0, 1);
      const anchorDb = lastYDomain.minDbm + yFrac * spanDb;
      customY = clampYDomain(anchorDb - yFrac * nextSpanDb, anchorDb + (1 - yFrac) * nextSpanDb);
    }
    refreshSvgOnly();
  };

  const onClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target === backdrop || target.closest("[data-lap-ed-close]")) {
      close();
      return;
    }
    const gateBtn = target.closest<HTMLButtonElement>("[data-lap-ed-gate]");
    if (gateBtn) {
      const rawGate = gateBtn.dataset.lapEdGate || "all";
      if (rawGate === "all") {
        focusedGateId = null;
      } else {
        const nextGate = Number(rawGate || "1");
        if (nodesList().length > 1 && focusedGateId === nextGate) {
          focusedGateId = null;
        } else {
          focusedGateId = nextGate;
        }
      }
      selectedCrossingId = null;
      renderModal();
      return;
    }
    if (target.closest("[data-lap-ed-toggle-lock]")) {
      if (focusedGateId !== null) {
        chartLinesLocked = !chartLinesLocked;
        renderModal();
      }
      return;
    }
    if (target.closest("[data-lap-ed-add-crossing]")) {
      stageAddManualCrossing();
      return;
    }
    if (target.closest("[data-lap-ed-reset-view]")) {
      customX = null;
      customY = null;
      refreshSvgOnly();
      return;
    }
    if (target.closest("[data-lap-ed-auto-label]")) {
      if (isAutoLabeling) {
        isAutoLabeling = false;
        void rootApi.cancelMLTraining().catch(() => undefined);
        renderModal();
      } else {
        void runAutoLabelPreview();
      }
      return;
    }
    if (target.closest("[data-lap-ed-discard]")) {
      draftByGate.clear();
      draftThresholdsByGate.clear();
      renderModal();
      return;
    }
    if (target.closest("[data-lap-ed-save]")) {
      void saveChanges();
      return;
    }
    const delBtn = target.closest<HTMLButtonElement>("[data-lap-ed-delete]");
    if (delBtn) {
      e.stopPropagation();
      const cid = Number(delBtn.dataset.lapEdDelete || "0");
      const delGateId = Number(delBtn.dataset.lapEdDeleteGate || "0") || focusedGateId;
      deleteDraftCrossing(cid, delGateId);
      return;
    }
    const rowEl = target.closest<HTMLElement>("[data-lap-ed-row]");
    if (rowEl) {
      const cid = Number(rowEl.dataset.lapEdRow || "0");
      if (cid !== 0) focusPassRow(cid);
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  const onTopBarBackCapture = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const backBtn = target.closest<HTMLElement>(
      ".topbar-back-btn, [data-action='races-back'], [data-action='practice-back']"
    );
    if (backBtn) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const onHashChange = (): void => {
    close();
  };

  const runAutoLabelPreview = async (): Promise<void> => {
    const sess = getSession();
    if (!sess || isAutoLabeling || isSaving) return;
    const teacher = rootStore.mlStatus.teacher;
    if (teacher && !teacher.ready) {
      if (!teacher.download?.running) {
        try {
          await rootApi.downloadMLTeacherPack(rootStore.mlStatus.config.teacherPackId);
          showToast("Downloading on-device AI labeler in background…", "info");
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err), "error");
        }
      }
      return;
    }

    isAutoLabeling = true;
    renderModal();
    try {
      const preAnchorUs = computeSessionAnchorUs(sess);
      const preBounds = computeLockedLapBounds(sess, preAnchorUs);
      const reqStartUs = preBounds
        ? Math.max(0, preAnchorUs + (preBounds.startMs - 450) * 1000)
        : undefined;
      const reqEndUs = preBounds ? preAnchorUs + (preBounds.endMs + 450) * 1000 : undefined;
      const res = await rootApi.labelPracticeSession(sessionId, {
        dryRun: true,
        slotIndex: selectedPilotSlot,
        startUs: reqStartUs,
        endUs: reqEndUs,
      });
      if (!document.body.contains(backdrop) || !isAutoLabeling) return;
      const latestSess = getSession();
      if (!latestSess) return;
      const anchorUs = computeSessionAnchorUs(latestSess);
      const bounds = computeLockedLapBounds(latestSess, anchorUs);
      const minBoundUs = bounds ? Math.max(0, anchorUs + (bounds.startMs - 450) * 1000) : 0;
      const maxBoundUs = bounds ? anchorUs + (bounds.endMs + 450) * 1000 : Number.POSITIVE_INFINITY;

      const byGateDecs = new Map<number, typeof res.decisions>();
      for (const d of res.decisions ?? []) {
        if (d.slotIndex !== selectedPilotSlot) continue;
        if (d.finalTsUs < minBoundUs || d.finalTsUs > maxBoundUs) continue;
        let arr = byGateDecs.get(d.gateId);
        if (!arr) {
          arr = [];
          byGateDecs.set(d.gateId, arr);
        }
        arr.push(d);
      }

      let stagedInLap = 0;
      for (const node of nodesList()) {
        const gid = node.gateId;
        const orig = extractOriginalGateCrossings(latestSess, gid, selectedPilotSlot);
        const preserved = orig
          .filter(
            (c) =>
              Boolean(c.manual) || c.timestampUs < minBoundUs || c.timestampUs > maxBoundUs
          )
          .map((c) => ({ ...c }));
        const nonManualInLap = orig.filter(
          (c) => !c.manual && c.timestampUs >= minBoundUs && c.timestampUs <= maxBoundUs
        );
        const usedOrigIds = new Set<number>();
        const nextList: DraftGateCrossing[] = [...preserved];

        const gateDecs = (byGateDecs.get(gid) ?? []).filter(
          (d) => d.label === "crossing" && d.confidence >= 0.5
        );
        for (const dec of gateDecs) {
          if (preserved.some((m) => Math.abs(m.timestampUs - dec.finalTsUs) <= 220_000)) {
            continue;
          }
          let bestOrig: DraftGateCrossing | null = null;
          let bestDiff = 220_001;
          for (const cand of nonManualInLap) {
            if (usedOrigIds.has(cand.crossingId)) continue;
            const diff = Math.abs(cand.timestampUs - dec.finalTsUs);
            if (diff < bestDiff) {
              bestDiff = diff;
              bestOrig = cand;
            }
          }
          stagedInLap++;
          if (bestOrig) {
            usedOrigIds.add(bestOrig.crossingId);
            nextList.push({
              ...bestOrig,
              timestampUs: dec.finalTsUs,
              peakRssiDbm: dec.peakRssiDbm,
            });
          } else {
            nextList.push({
              crossingId: nextDraftId--,
              gateId: gid,
              timestampUs: dec.finalTsUs,
              peakRssiDbm: dec.peakRssiDbm,
              manual: true,
            });
          }
        }
        nextList.sort((a, b) => a.timestampUs - b.timestampUs);
        draftByGate.set(gid, nextList);
      }

      showToast(
        `Staged ${stagedInLap} AI pass${stagedInLap === 1 ? "" : "es"} in this lap`,
        "info"
      );
    } catch (err) {
      if (isAutoLabeling) {
        showToast(err instanceof Error ? err.message : String(err), "error");
      }
    } finally {
      isAutoLabeling = false;
      if (document.body.contains(backdrop)) {
        renderModal();
      }
    }
  };

  const unsubStore = rootStore.subscribe(["practice", "laps", "crossings", "config", "ml"], () => {
    if (!dragState && !threshDrag && !viewDrag && !isSaving && !isAutoLabeling) {
      renderModal();
    }
  });

  let resizeObserver: ResizeObserver | null = null;
  const topbarEl = document.querySelector<HTMLElement>(".topbar");
  const appEl = document.querySelector<HTMLElement>(".app");
  const hadSubpageBack = Boolean(topbarEl?.classList.contains("has-subpage-back"));
  const hadMobileSubpage = Boolean(appEl?.classList.contains("is-mobile-subpage"));
  topbarEl?.classList.remove("is-mobile-collapsed");
  appEl?.classList.remove("is-mobile-topbar-collapsed");
  topbarEl?.classList.add("has-subpage-back");
  appEl?.classList.add("is-mobile-subpage");

  function close(): void {
    if (panAnimFrame) cancelAnimationFrame(panAnimFrame);
    if (isAutoLabeling) {
      isAutoLabeling = false;
      void rootApi.cancelMLTraining().catch(() => undefined);
    }
    unsubStore();
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (!hadSubpageBack) {
      topbarEl?.classList.remove("has-subpage-back");
    }
    if (!hadMobileSubpage) {
      appEl?.classList.remove("is-mobile-subpage");
    }
    backdrop.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    backdrop.removeEventListener("wheel", onWheel);
    backdrop.removeEventListener("click", onClick);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("click", onTopBarBackCapture, true);
    window.removeEventListener("hashchange", onHashChange);
    backdrop.remove();
    if (activePracticeEditorCleanup === close) {
      activePracticeEditorCleanup = null;
    }
  }

  activePracticeEditorCleanup = close;
  backdrop.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  backdrop.addEventListener("wheel", onWheel, { passive: false });
  backdrop.addEventListener("click", onClick);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("click", onTopBarBackCapture, true);
  window.addEventListener("hashchange", onHashChange);
  document.body.appendChild(backdrop);

  renderModal();
  const mountedWrap = backdrop.querySelector<HTMLElement>("[data-lap-ed-svg-wrap]");
  if (
    mountedWrap &&
    ((mountedWrap.clientWidth > 120 && Math.abs(mountedWrap.clientWidth - svgW) >= 2) ||
      (mountedWrap.clientHeight > 120 && Math.abs(mountedWrap.clientHeight - svgH) >= 2))
  ) {
    if (mountedWrap.clientWidth > 120) svgW = Math.round(mountedWrap.clientWidth);
    if (mountedWrap.clientHeight > 120) svgH = Math.round(mountedWrap.clientHeight);
    refreshSvgOnly();
  }
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => {
      const wEl = backdrop.querySelector<HTMLElement>("[data-lap-ed-svg-wrap]");
      if (
        wEl &&
        ((wEl.clientWidth > 120 && Math.abs(wEl.clientWidth - svgW) >= 2) ||
          (wEl.clientHeight > 120 && Math.abs(wEl.clientHeight - svgH) >= 2))
      ) {
        if (wEl.clientWidth > 120) svgW = Math.round(wEl.clientWidth);
        if (wEl.clientHeight > 120) svgH = Math.round(wEl.clientHeight);
        refreshSvgOnly();
      }
    });
    resizeObserver.observe(backdrop);
    if (mountedWrap) {
      resizeObserver.observe(mountedWrap);
    }
  }
  void rootApi
    .ensurePracticeSessionTrace(sessionId, needsFreshActiveTrace)
    .then(() => {
      isLoadingTrace = false;
      if (document.body.contains(backdrop) && !dragState && !threshDrag && !viewDrag) {
        renderModal();
      }
    })
    .catch(() => {
      isLoadingTrace = false;
      if (document.body.contains(backdrop) && !dragState && !threshDrag && !viewDrag) {
        refreshSvgOnly();
      }
    });
}
