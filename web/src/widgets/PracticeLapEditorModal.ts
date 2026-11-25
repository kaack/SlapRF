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
  label: string;
  splitSec: number | null;
  peakDbm: number | null;
}

interface LapWindowBounds {
  lap: LapRecord;
  startMs: number;
  endMs: number;
  framedMinMs: number;
  framedMaxMs: number;
}

const DEFAULT_SVG_W = 850;
const DEFAULT_SVG_H = 236;
const PAD_L = 46;
const PAD_R = 18;
const PAD_T = 30;
const PAD_B = 28;
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
const MIN_X_SPAN_MS = 1000;
const MAX_X_SPAN_MS = 600_000;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function fmtOffsetSec(ms: number): string {
  const sec = ms / 1000;
  return `${sec >= 0 ? "+" : ""}${sec.toFixed(2)}s`;
}

/**
 * Opens the Lap-Based Multi-Timer Practice RSSI & Gate Crossing Editor modal.
 * Shows all timers' `.rfbin` RSSI curves and marked crossings overlaid for the selected lap
 * (matching the `Signals` editor), and focuses any timer when clicked so you can drag/adjust
 * crossings, delete false triggers, add missing crossings, or tune thresholds.
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
  let selectedLapId: number | "all" = "all";
  let selectedCrossingId: number | null = null;
  let addMode = false;
  let customX: { minMs: number; maxMs: number } | null = null;
  let customY: { minDbm: number; maxDbm: number } | null = null;
  let userAdjustedX = false;
  let panAnimFrame = 0;
  let isSaving = false;
  let isAutoLabeling = false;
  const needsFreshActiveTrace =
    Boolean(initSess.active) &&
    (initSess.laps ?? []).some((l) => l.completedAtUs > rootStore.sessionTraceMaxTsUs(sessionId));
  let isLoadingTrace = !rootStore.hasSessionTrace(sessionId) || needsFreshActiveTrace;
  let nextDraftId = -1;

  // Map<gateId, DraftGateCrossing[]> for staged edits per timer
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

  const clampXDomain = (minMs: number, maxMs: number) => {
    const span = clamp(maxMs - minMs, MIN_X_SPAN_MS, MAX_X_SPAN_MS);
    const lo = clamp(minMs, -1_000_000_000, 1_000_000_000);
    return { minMs: Math.round(lo), maxMs: Math.round(lo + span) };
  };

  const computeLapBounds = (
    sess: PracticeSession,
    anchorUs: number,
    lapId: number | "all"
  ): LapWindowBounds | null => {
    if (lapId === "all") return null;
    const lap = getPilotLaps(sess).find((l) => l.lapId === lapId);
    if (!lap || !(lap.completedAtUs > 0)) return null;
    const startUs = Math.max(0, Math.round(lap.completedAtUs - lap.lapTimeSec * 1_000_000));
    const endUs = lap.completedAtUs;
    const startMs = Math.round((startUs - anchorUs) / 1000);
    const endMs = Math.round((endUs - anchorUs) / 1000);
    const padMs = Math.max(1600, Math.round(Math.max(1000, endMs - startMs) * 0.2));
    const framed = clampXDomain(startMs - padMs, Math.max(startMs + 2800, endMs + padMs));
    return {
      lap,
      startMs,
      endMs,
      framedMinMs: framed.minMs,
      framedMaxMs: framed.maxMs,
    };
  };

  const applySelectedLapFrame = (sess: PracticeSession): void => {
    userAdjustedX = false;
    if (selectedLapId === "all") {
      customX = null;
      return;
    }
    const anchorUs = computeSessionAnchorUs(sess);
    const bounds = computeLapBounds(sess, anchorUs, selectedLapId);
    if (bounds) {
      customX = { minMs: bounds.framedMinMs, maxMs: bounds.framedMaxMs };
    } else {
      customX = null;
    }
  };

  // Initialize `selectedLapId` from `initialLapId`, matching `focusStartUs`/`focusEndUs`, or latest lap
  {
    const initLaps = getPilotLaps(initSess);
    if (opts.initialLapId !== undefined && initLaps.some((l) => l.lapId === opts.initialLapId)) {
      selectedLapId = opts.initialLapId;
      applySelectedLapFrame(initSess);
    } else if (
      opts.focusStartUs !== undefined &&
      opts.focusEndUs !== undefined &&
      opts.focusEndUs >= opts.focusStartUs
    ) {
      const matched = initLaps.find((l) => Math.abs(l.completedAtUs - opts.focusEndUs!) <= 50_000);
      if (matched) {
        selectedLapId = matched.lapId;
        applySelectedLapFrame(initSess);
      } else {
        const anchor = computeSessionAnchorUs(initSess);
        const startMs = Math.round((opts.focusStartUs - anchor) / 1000);
        const endMs = Math.round((opts.focusEndUs - anchor) / 1000);
        const padMs = Math.max(1800, Math.round((endMs - startMs) * 0.22));
        customX = clampXDomain(startMs - padMs, Math.max(startMs + 3000, endMs + padMs));
        userAdjustedX = true;
      }
    } else if (initLaps.length > 0) {
      selectedLapId = initLaps[initLaps.length - 1].lapId;
      applySelectedLapFrame(initSess);
    }
  }

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

  /**
   * Slices `.rfbin` frames inside `[minMs, maxMs]` via binary search and preserves bucket peaks
   * when zoomed out, so zoomed-in lap views always render full 50-100 Hz peak fidelity!
   */
  const buildTraceMsInWindow = (
    sess: PracticeSession,
    anchorUs: number,
    gateId: number,
    slotIndex: number,
    minMs?: number,
    maxMs?: number
  ): Array<{ t: number; r: number }> => {
    const frames = getGateHistory(sess, gateId);
    if (frames.length === 0) return [];
    const slotZeroIdx = Math.max(0, slotIndex - 1);

    let loIdx = 0;
    let hiIdx = frames.length;
    if (minMs !== undefined && maxMs !== undefined) {
      const minUs = Math.max(0, anchorUs + (minMs - 2000) * 1000);
      const maxUs = Math.max(minUs, anchorUs + (maxMs + 2000) * 1000);
      let l = 0;
      let r = frames.length;
      while (l < r) {
        const m = (l + r) >>> 1;
        if (frames[m].timestampUs < minUs) l = m + 1;
        else r = m;
      }
      loIdx = Math.max(0, l - 1);
      l = loIdx;
      r = frames.length;
      while (l < r) {
        const m = (l + r) >>> 1;
        if (frames[m].timestampUs <= maxUs) l = m + 1;
        else r = m;
      }
      hiIdx = Math.min(frames.length, l + 1);
    }

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
      out.push({
        t: Math.round((bestFrame.timestampUs - anchorUs) / 1000),
        r: bestVal,
      });
    }
    return out;
  };

  const derivePassRows = (
    sess: PracticeSession,
    anchorUs: number,
    gateId: number
  ): DerivedPassRow[] => {
    const raw = activeGateCrossings(sess, gateId);
    const isSf = gateId === sfGateId();
    const gLbl = gateLabel(reviewStore, gateId);
    const gClr = gateColor(reviewStore, gateId);
    const rows: DerivedPassRow[] = [];
    let validIdx = 0;
    let prevValidMs: number | null = null;
    for (const c of raw) {
      const offsetMs = Math.round((c.timestampUs - anchorUs) / 1000);
      const peakDbm =
        c.peakRssiDbm !== undefined && c.peakRssiDbm !== 0 ? Math.round(c.peakRssiDbm) : null;
      const isInv = Boolean(c.invalidReason && !c.manual);
      if (isInv) {
        rows.push({
          crossing: c,
          gateId,
          gateLbl: gLbl,
          gateClr: gClr,
          offsetMs,
          label: "INV",
          splitSec: null,
          peakDbm,
        });
        continue;
      }
      validIdx++;
      let label: string;
      let splitSec: number | null = null;
      if (isSf) {
        if (validIdx === 1) {
          label = "HS";
        } else {
          label = `L${validIdx - 1}`;
          if (prevValidMs !== null) {
            splitSec = Math.max(0, (offsetMs - prevValidMs) / 1000);
          }
        }
      } else {
        label = `P${validIdx}`;
        if (prevValidMs !== null) {
          splitSec = Math.max(0, (offsetMs - prevValidMs) / 1000);
        }
      }
      prevValidMs = offsetMs;
      rows.push({
        crossing: c,
        gateId,
        gateLbl: gLbl,
        gateClr: gClr,
        offsetMs,
        label,
        splitSec,
        peakDbm,
      });
    }
    return rows;
  };

  const deriveAllPassRows = (sess: PracticeSession, anchorUs: number): DerivedPassRow[] => {
    const all: DerivedPassRow[] = [];
    for (const g of nodesList()) {
      all.push(...derivePassRows(sess, anchorUs, g.gateId));
    }
    all.sort((a, b) => a.offsetMs - b.offsetMs || a.gateId - b.gateId);
    return all;
  };

  const findCrossingRow = (
    sess: PracticeSession,
    anchorUs: number,
    crossingId: number,
    preferGateId?: number | null
  ): DerivedPassRow | undefined => {
    if (preferGateId !== undefined && preferGateId !== null) {
      const hit = derivePassRows(sess, anchorUs, preferGateId).find(
        (r) => r.crossing.crossingId === crossingId
      );
      if (hit) return hit;
    }
    return deriveAllPassRows(sess, anchorUs).find((r) => r.crossing.crossingId === crossingId);
  };

  let svgW = DEFAULT_SVG_W;
  let svgH = DEFAULT_SVG_H;
  const getPlotW = (): number => Math.max(200, svgW - PAD_L - PAD_R);
  const getPlotH = (): number => Math.max(120, svgH - PAD_T - PAD_B);
  let lastDomain = { minMs: -1000, maxMs: 25_000 };
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
    return Math.round(lastDomain.minMs + frac * (lastDomain.maxMs - lastDomain.minMs));
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

  const computeAutoDomainMs = (
    sess: PracticeSession,
    anchorUs: number,
    allRows: DerivedPassRow[]
  ): { minMs: number; maxMs: number } => {
    let minMs = 0;
    let maxMs = 20_000;
    let sawTrace = false;
    for (const g of nodesList()) {
      const hist = getGateHistory(sess, g.gateId);
      if (hist.length > 0) {
        const firstT = Math.round((hist[0].timestampUs - anchorUs) / 1000);
        const lastT = Math.round((hist[hist.length - 1].timestampUs - anchorUs) / 1000);
        if (!sawTrace) {
          minMs = Math.min(0, firstT - 500);
          maxMs = Math.max(minMs + 8000, lastT + 1000);
          sawTrace = true;
        } else {
          minMs = Math.min(minMs, firstT - 500);
          maxMs = Math.max(maxMs, lastT + 1000);
        }
      }
    }
    for (const r of allRows) {
      if (r.offsetMs - 1000 < minMs) minMs = r.offsetMs - 1000;
      if (r.offsetMs + 2000 > maxMs) maxMs = r.offsetMs + 2000;
    }
    const laps = getPilotLaps(sess);
    if (maxMs - minMs > 45_000 && laps.length >= 1) {
      const latestBounds = computeLapBounds(sess, anchorUs, laps[laps.length - 1].lapId);
      if (latestBounds) {
        return { minMs: latestBounds.framedMinMs, maxMs: latestBounds.framedMaxMs };
      }
    }
    return { minMs, maxMs: Math.max(minMs + 5000, maxMs) };
  };

  const renderGraphSvg = (
    sess: PracticeSession,
    anchorUs: number,
    allRows: DerivedPassRow[]
  ): string => {
    const plotW = getPlotW();
    const plotH = getPlotH();
    const refGateId = focusedGateId ?? sfGateId();
    const { enterDb, exitDb, hwMode } = getGateThresholds(refGateId, selectedPilotSlot);
    lastHwMode = hwMode;
    lastDomain = customX ?? computeAutoDomainMs(sess, anchorUs, allRows);
    lastYDomain = activeYDomain(hwMode);
    const spanMs = Math.max(1, lastDomain.maxMs - lastDomain.minMs);
    const ySpan = Math.max(1, lastYDomain.maxDbm - lastYDomain.minDbm);

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
        <text x="${PAD_L - 6}" y="${(yNum + 3.5).toFixed(1)}" class="lap-ed-axis-lbl" text-anchor="end">${db}</text>`);
    }

    // Lap window boundary framing when a specific lap is selected
    const lapBounds = computeLapBounds(sess, anchorUs, selectedLapId);
    const axisZeroMs = lapBounds ? lapBounds.startMs : 0;

    const stepMs =
      spanMs <= 3000 ? 250 : spanMs <= 7000 ? 500 : spanMs <= 14_000 ? 1000 : spanMs <= 30_000 ? 2000 : spanMs <= 70_000 ? 5000 : 10_000;
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
        <text x="${x}" y="${svgH - 8}" class="lap-ed-axis-lbl" text-anchor="middle">${(rel / 1000).toFixed(dec)}s</text>`);
    }

    let lapFrameHtml = "";
    if (lapBounds) {
      const xStart = clamp(msToX(lapBounds.startMs), PAD_L, svgW - PAD_R);
      const xEnd = clamp(msToX(lapBounds.endMs), PAD_L, svgW - PAD_R);
      if (xStart > PAD_L + 1) {
        lapFrameHtml += `<rect x="${PAD_L}" y="${PAD_T}" width="${(xStart - PAD_L).toFixed(1)}" height="${plotH}" fill="rgba(0,0,0,0.18)" pointer-events="none" />`;
      }
      if (xEnd < svgW - PAD_R - 1) {
        lapFrameHtml += `<rect x="${xEnd.toFixed(1)}" y="${PAD_T}" width="${(svgW - PAD_R - xEnd).toFixed(1)}" height="${plotH}" fill="rgba(0,0,0,0.18)" pointer-events="none" />`;
      }
      if (msToX(lapBounds.startMs) >= PAD_L && msToX(lapBounds.startMs) <= svgW - PAD_R) {
        lapFrameHtml += `<line x1="${xStart.toFixed(1)}" y1="${PAD_T}" x2="${xStart.toFixed(1)}" y2="${svgH - PAD_B}" class="lap-ed-horn-line" pointer-events="none" />`;
      }
      if (msToX(lapBounds.endMs) >= PAD_L && msToX(lapBounds.endMs) <= svgW - PAD_R) {
        lapFrameHtml += `<line x1="${xEnd.toFixed(1)}" y1="${PAD_T}" x2="${xEnd.toFixed(1)}" y2="${svgH - PAD_B}" class="lap-ed-horn-line" pointer-events="none" />`;
      }
    }

    // Draggable Enter / Exit threshold lines when a specific timer is focused
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
            ? `<g class="lap-ed-thresh-group is-enter is-draggable ${threshDrag?.kind === "enter" ? "is-dragging" : ""}" data-thresh-handle="enter">
                <line x1="${PAD_L}" y1="${enterY.toFixed(1)}" x2="${svgW - PAD_R}" y2="${enterY.toFixed(1)}" class="lap-ed-thresh-line is-enter" />
                <line x1="${PAD_L}" y1="${enterY.toFixed(1)}" x2="${svgW - PAD_R}" y2="${enterY.toFixed(1)}" class="lap-ed-thresh-hit" />
                <rect x="${enterPillX.toFixed(1)}" y="${(enterY - 8.5).toFixed(1)}" width="${enterPillW.toFixed(1)}" height="17" rx="4" class="lap-ed-thresh-pill is-enter" />
                <text x="${(enterPillX + enterPillW / 2).toFixed(1)}" y="${(enterY + 3.4).toFixed(1)}" class="lap-ed-thresh-lbl is-enter" text-anchor="middle">${enterLbl}</text>
              </g>`
            : ""
        }
        ${
          exitVisible
            ? `<g class="lap-ed-thresh-group is-exit is-draggable ${threshDrag?.kind === "exit" ? "is-dragging" : ""}" data-thresh-handle="exit">
                <line x1="${PAD_L}" y1="${exitY.toFixed(1)}" x2="${svgW - PAD_R}" y2="${exitY.toFixed(1)}" class="lap-ed-thresh-line is-exit" />
                <line x1="${PAD_L}" y1="${exitY.toFixed(1)}" x2="${svgW - PAD_R}" y2="${exitY.toFixed(1)}" class="lap-ed-thresh-hit" />
                <rect x="${exitPillX.toFixed(1)}" y="${(exitY - 8.5).toFixed(1)}" width="${exitPillW.toFixed(1)}" height="17" rx="4" class="lap-ed-thresh-pill is-exit" />
                <text x="${(exitPillX + exitPillW / 2).toFixed(1)}" y="${(exitY + 3.4).toFixed(1)}" class="lap-ed-thresh-lbl is-exit" text-anchor="middle">${exitLbl}</text>
              </g>`
            : ""
        }`;
    }

    // Build per-timer colored RSSI curves (background unfocused timers first, focused timer or All timers on top)
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

    // Render crossing pins (background unfocused timers first, then focused / All timers with 2-lane pill stagger)
    const orderedRows =
      focusedGateId === null
        ? allRows
        : [
            ...allRows.filter((r) => r.gateId !== focusedGateId),
            ...allRows.filter((r) => r.gateId === focusedGateId),
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
          // Subtle reference pin for non-focused timers (clickable to switch focus to that timer)
          return `
            <g class="lap-ed-pin is-ref-pin" style="opacity:0.32;cursor:pointer" data-crossing-pin="${r.crossing.crossingId}" data-crossing-gate="${r.gateId}">
              <line x1="${xf}" y1="${PAD_T}" x2="${xf}" y2="${svgH - PAD_B}" class="lap-ed-pin-line" style="stroke:${esc(r.gateClr)};stroke-dasharray:3 3" />
              <line x1="${xf}" y1="${PAD_T}" x2="${xf}" y2="${svgH - PAD_B}" class="lap-ed-pin-hit" />
            </g>`;
        }

        const cls = [
          "lap-ed-pin",
          inv ? "is-invalid" : r.label === "HS" ? "is-holeshot" : "",
          r.crossing.manual ? "is-manual" : "",
          isSel ? "is-selected" : "",
          isDragging ? "is-dragging" : "",
        ]
          .filter(Boolean)
          .join(" ");

        const subTime = isDragging
          ? fmtOffsetSec(effMs)
          : r.splitSec !== null
            ? `${r.splitSec.toFixed(2)}s`
            : fmtOffsetSec(effMs);
        const tagText =
          focusedGateId === null && nodes.length > 1
            ? `${r.gateLbl} · ${r.label}`
            : `${r.gateLbl} · ${r.label} · ${subTime}`;
        const pillW = Math.max(50, tagText.length * 6.3 + 12);
        const pillX = clamp(x - pillW / 2, PAD_L, svgW - PAD_R - pillW);
        let pillY = 3;
        if (pillX < lastLane0Right + 4 && !isDragging && !isSel) {
          pillY = 20;
        } else {
          lastLane0Right = pillX + pillW;
        }
        const pinStroke = isSel || isDragging ? "" : `style="stroke:${esc(r.gateClr)}"`;
        return `
          <g class="${cls}" data-crossing-pin="${r.crossing.crossingId}" data-crossing-gate="${r.gateId}">
            <line x1="${xf}" y1="${PAD_T}" x2="${xf}" y2="${svgH - PAD_B}" class="lap-ed-pin-line" ${pinStroke} />
            <line x1="${xf}" y1="${PAD_T}" x2="${xf}" y2="${svgH - PAD_B}" class="lap-ed-pin-hit" />
            <rect x="${pillX.toFixed(1)}" y="${pillY}" width="${pillW.toFixed(1)}" height="16.5" rx="4.5" class="lap-ed-pin-pill" ${pinStroke} />
            <text x="${(pillX + pillW / 2).toFixed(1)}" y="${(pillY + 11.7).toFixed(1)}" text-anchor="middle" class="lap-ed-pin-lbl">${esc(tagText)}</text>
          </g>`;
      })
      .join("");

    let hoverHtml = "";
    if (hoverInfo && !dragState && !threshDrag && !viewDrag) {
      const hx = clamp(msToX(hoverInfo.offsetMs), PAD_L, svgW - PAD_R).toFixed(1);
      const hLbl = `${fmtOffsetSec(hoverInfo.offsetMs)}${hoverInfo.dbm !== null ? ` · ${hoverInfo.gateLbl ? `${hoverInfo.gateLbl} ` : ""}${hoverInfo.dbm}${isSlapRFMode(hwMode) ? " dBm" : ""}` : ""}${addMode ? " (Click to add)" : ""}`;
      hoverHtml = `
        <g class="lap-ed-hover-guide ${addMode ? "is-add" : ""}" pointer-events="none">
          <line x1="${hx}" y1="${PAD_T}" x2="${hx}" y2="${svgH - PAD_B}" class="lap-ed-hover-line" />
          <text x="${clamp(Number(hx) + 6, PAD_L + 4, svgW - PAD_R - 140).toFixed(1)}" y="${svgH - PAD_B - 6}" class="lap-ed-hover-lbl">${esc(hLbl)}</text>
        </g>`;
    }

    const svgStateCls = [
      "lap-ed-svg",
      addMode ? "is-add-mode" : "",
      dragState || viewDrag?.mode === "xstretch" ? "is-dragging" : "",
      threshDrag || viewDrag?.mode === "ystretch" ? "is-dragging-thresh" : "",
      viewDrag?.mode === "pan" ? "is-panning" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return `
      <svg class="${svgStateCls}" viewBox="0 0 ${svgW} ${svgH}" data-lap-ed-svg>
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
        <rect x="0" y="${PAD_T}" width="${PAD_L}" height="${plotH}" fill="transparent" class="lap-ed-y-axis-hit" data-axis-drag="y"></rect>
        <rect x="${PAD_L}" y="${svgH - PAD_B}" width="${plotW}" height="${PAD_B}" fill="transparent" class="lap-ed-x-axis-hit" data-axis-drag="x"></rect>
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
    const prevTableWrap = backdrop.querySelector<HTMLElement>(".lap-ed-table-wrap");
    const savedTableScrollTop = prevTableWrap ? prevTableWrap.scrollTop : 0;

    const nodes = nodesList();
    if (nodes.length === 1 && focusedGateId === null) {
      focusedGateId = nodes[0].gateId;
    } else if (focusedGateId !== null && !nodes.some((n) => n.gateId === focusedGateId)) {
      focusedGateId = defaultFocusedGateId();
    }

    const pilotLaps = getPilotLaps(sess);
    if (selectedLapId !== "all" && !pilotLaps.some((l) => l.lapId === selectedLapId)) {
      selectedLapId = pilotLaps.length > 0 ? pilotLaps[pilotLaps.length - 1].lapId : "all";
      applySelectedLapFrame(sess);
    }

    const anchorUs = computeSessionAnchorUs(sess);
    const allRows = deriveAllPassRows(sess, anchorUs);
    const lapBounds = computeLapBounds(sess, anchorUs, selectedLapId);

    // Filter table rows by selected timer (`All` or focused) and selected lap window
    const visibleTableRows = allRows.filter((r) => {
      if (focusedGateId !== null && r.gateId !== focusedGateId) return false;
      if (selectedCrossingId !== null && r.crossing.crossingId === selectedCrossingId) return true;
      if (r.crossing.crossingId < 0) {
        // Keep staged crossings inside current chart domain visible
        const curDom = customX ?? computeAutoDomainMs(sess, anchorUs, allRows);
        return r.offsetMs >= curDom.minMs - 500 && r.offsetMs <= curDom.maxMs + 500;
      }
      if (lapBounds) {
        return r.offsetMs >= lapBounds.startMs - 900 && r.offsetMs <= lapBounds.endMs + 900;
      }
      return true;
    });

    const pilot =
      sess.pilots.find((p) => p.slotIndex === selectedPilotSlot) ??
      reviewStore.pilot(selectedPilotSlot);
    const callsign = pilot?.callsign || `Pilot ${selectedPilotSlot}`;
    const color = pilot?.color || "#38bdf8";
    const chLabel = pilot?.channel ? formatBandChannelShort(pilot.band, pilot.channel) : "";
    const { hwMode } = getGateThresholds(focusedGateId ?? sfGateId(), selectedPilotSlot);

    // Lap switcher (`< | L1 · 12.40s ▾ | >`)
    const curLapIdx =
      selectedLapId === "all"
        ? -1
        : pilotLaps.findIndex((l) => l.lapId === selectedLapId);
    const canPrevLap = pilotLaps.length > 0 && (selectedLapId === "all" || curLapIdx > 0);
    const canNextLap =
      pilotLaps.length > 0 && selectedLapId !== "all" && curLapIdx >= 0 && curLapIdx < pilotLaps.length - 1;
    const lapNavHtml =
      pilotLaps.length > 0
        ? `<div class="lap-ed-lap-nav" role="group" aria-label="Select lap">
            <button type="button" class="btn btn-ghost btn-xs lap-ed-lap-step-btn" data-lap-ed-prev-lap ${canPrevLap ? "" : "disabled"} title="Previous lap" aria-label="Previous lap">${icons.chevronLeft(14)}</button>
            <select class="lap-ed-lap-select" data-lap-ed-lap-select aria-label="Select lap">
              ${pilotLaps
                .map(
                  (l) =>
                    `<option value="${l.lapId}" ${selectedLapId === l.lapId ? "selected" : ""}>L${l.lapNumber} · ${fmtTime(l.lapTimeSec)}${l.invalidated ? " (scratched)" : ""}</option>`
                )
                .join("")}
              <option value="all" ${selectedLapId === "all" ? "selected" : ""}>All Laps (${pilotLaps.length})</option>
            </select>
            <button type="button" class="btn btn-ghost btn-xs lap-ed-lap-step-btn" data-lap-ed-next-lap ${canNextLap ? "" : "disabled"} title="Next lap" aria-label="Next lap">${icons.chevronRight(14)}</button>
          </div>`
        : "";

    // Multi-timer pills (`[All] [● H1] [● T1] ...`) matching `Signals`
    const allChipHtml =
      nodes.length > 1
        ? `<button type="button" class="btn ${focusedGateId === null ? "btn-armed" : "btn-ghost"} btn-xs" data-lap-ed-gate="all" title="Show all timers overlaid">All</button>`
        : "";
    const gateChipsHtml = `<div class="lap-ed-gate-pills">${allChipHtml}${nodes
      .map((g) => {
        const gActive = focusedGateId === g.gateId;
        const gLbl = gateLabel(reviewStore, g.gateId);
        const gClr = gateColor(reviewStore, g.gateId);
        return `<button type="button" class="btn ${gActive ? "btn-armed" : "btn-ghost"} btn-xs lap-ed-gate-chip" data-lap-ed-gate="${g.gateId}" title="${gActive && nodes.length > 1 ? `Editing ${esc(gLbl)} (tap again for All timers)` : `Focus ${esc(gLbl)} to edit crossings`}"><span class="dot" style="background:${esc(gClr)}"></span><span>${esc(gLbl)}</span></button>`;
      })
      .join("")}</div>`;

    const hasCustomView = Boolean(userAdjustedX || customY);
    const isDirty = hasUnsavedChanges();
    const curGateLabel = focusedGateId !== null ? gateLabel(reviewStore, focusedGateId) : null;
    const canAddCrossing = focusedGateId !== null;

    const emptyMsg =
      focusedGateId === null
        ? lapBounds
          ? `No crossings marked in L${lapBounds.lap.lapNumber}. Tap a timer chip above (e.g. ${esc(gateLabel(reviewStore, sfGateId()))}) to add a crossing.`
          : `No crossings recorded yet. Tap a timer chip above to add crossings.`
        : `No ${esc(curGateLabel)} passes in ${lapBounds ? `L${lapBounds.lap.lapNumber}` : "this view"}. Click <strong>Add Crossing</strong> or double-click a ${esc(curGateLabel)} peak above.`;

    const tableRowsHtml =
      visibleTableRows.length === 0
        ? `<tr><td colspan="7" class="muted" style="text-align:center; padding: 18px 12px;">${emptyMsg}</td></tr>`
        : visibleTableRows
            .map((r) => {
              const isSel = selectedCrossingId !== null && r.crossing.crossingId === selectedCrossingId;
              const splitCell =
                r.splitSec !== null
                  ? `<span class="lap-ed-num mono">${r.splitSec.toFixed(2)}s</span>`
                  : `<span class="muted">—</span>`;
              const rssiCell =
                r.peakDbm !== null
                  ? `<span class="lap-ed-num mono">${r.peakDbm}<span class="lap-ed-rssi-unit">${isSlapRFMode(hwMode) ? " dBm" : ""}</span></span>`
                  : `<span class="muted">—</span>`;
              return `
                <tr class="lap-ed-row ${r.label === "INV" ? "is-invalid-row" : ""} ${isSel ? "is-selected" : ""}" data-lap-ed-row="${r.crossing.crossingId}" data-lap-ed-row-gate="${r.gateId}">
                  <td class="lap-ed-col-timer"><span class="lap-ed-timer-pill"><span class="dot" style="background:${esc(r.gateClr)}"></span><span class="mono">${esc(r.gateLbl)}</span></span></td>
                  <td class="lap-ed-num mono lap-ed-col-pass">${esc(r.label)}</td>
                  <td class="lap-ed-num mono lap-ed-col-gate">${fmtOffsetSec(r.offsetMs)}</td>
                  <td class="lap-ed-col-split">${splitCell}</td>
                  <td class="lap-ed-col-rssi">${rssiCell}</td>
                  <td class="lap-ed-col-src"><span class="muted">${r.crossing.manual ? "Manual" : "Timer"}</span></td>
                  <td class="lap-ed-col-act">
                    <button type="button" class="btn btn-ghost lap-ed-act-btn lap-ed-del-btn" data-lap-ed-delete="${r.crossing.crossingId}" data-lap-ed-delete-gate="${r.gateId}" title="Delete ${esc(r.gateLbl)} crossing" aria-label="Delete ${esc(r.gateLbl)} crossing">
                      ${icons.trash(16)}
                    </button>
                  </td>
                </tr>`;
            })
            .join("");

    const captionHtml =
      focusedGateId === null && nodes.length > 1
        ? `Showing all timers for ${lapBounds ? `Lap ${lapBounds.lap.lapNumber}` : "session"}. Tap any timer chip, signal curve, or crossing pin to adjust, add, or remove crossings.`
        : `Editing <strong>${esc(curGateLabel ?? "")}</strong> — drag pins to adjust timing, double-click a peak to add a crossing, or drag Enter/Exit thresholds.`;

    backdrop.innerHTML = `
      <div class="slaprf-modal card rc-modal-xl lap-editor-modal" role="document">
        <div class="slaprf-modal-head lap-ed-head">
          <div class="slaprf-modal-title-row lap-ed-head-left">
            <h3>
              <span class="lap-ed-title-pilot">
                <span class="dot" style="background:${esc(color)}"></span>
                <span>${esc(callsign)}${chLabel ? ` (${esc(chLabel)})` : ""}</span>
              </span>
            </h3>
          </div>
          <div class="lap-ed-head-right">
            ${lapNavHtml}
            <button type="button" class="btn btn-ghost btn-xs lap-ed-desktop-close-btn" data-lap-ed-close aria-label="Close">
              ${icons.close(15)}
            </button>
          </div>
        </div>
        <div class="slaprf-modal-body lap-ed-body">
          <div class="lap-ed-controls-strip">
            <div class="lap-ed-controls-left">${gateChipsHtml}</div>
            <div class="lap-ed-controls-right" role="group" aria-label="Crossing actions">
              <button type="button" class="btn btn-ghost btn-xs" data-lap-ed-reset-view ${hasCustomView ? "" : "hidden"}>
                ${icons.maximize(13)}<span>Reset View</span>
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-xs"
                data-lap-ed-auto-label
                ${isAutoLabeling || isSaving || Boolean(rootStore.mlStatus.teacher?.download?.running) ? "disabled" : ""}
                title="Auto-label crossings on-device with AI"
              >
                ${icons.reviewCheck(13)}<span>${
                  isAutoLabeling
                    ? "Labeling…"
                    : rootStore.mlStatus.teacher?.download?.running
                      ? `AI ${Math.round(rootStore.mlStatus.teacher.download.percent || 0)}%`
                      : "Auto-Label"
                }</span>
              </button>
              <button
                type="button"
                class="btn ${addMode ? "btn-armed" : "btn-ghost"} btn-xs"
                data-lap-ed-add-mode
                ${canAddCrossing ? "" : "disabled"}
                title="${canAddCrossing ? `Add a crossing on ${esc(curGateLabel ?? "")}` : "Select a timer chip (H1, T1, …) first to add a crossing"}"
              >
                ${icons.plus(13)}<span>${addMode ? "Click Peak…" : curGateLabel && nodes.length > 1 ? `Add ${esc(curGateLabel)}` : "Add Crossing"}</span>
              </button>
            </div>
          </div>

          <div class="lap-ed-graph-card">
            <div class="lap-ed-svg-wrap" data-lap-ed-svg-wrap>
              ${renderGraphSvg(sess, anchorUs, allRows)}
            </div>
            <div class="lap-ed-graph-caption">${captionHtml}</div>
          </div>

          <div class="lap-ed-table-wrap">
            <table class="table rc-compact-table lap-ed-table">
              <thead>
                <tr>
                  <th class="lap-ed-col-timer">Timer</th>
                  <th class="lap-ed-col-pass">Pass</th>
                  <th class="lap-ed-col-gate">Time</th>
                  <th class="lap-ed-col-split">Split</th>
                  <th class="lap-ed-col-rssi">RSSI</th>
                  <th class="lap-ed-col-src">Source</th>
                  <th class="lap-ed-col-act" aria-label="Actions"></th>
                </tr>
              </thead>
              <tbody>${tableRowsHtml}</tbody>
            </table>
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

    const nextTableWrap = backdrop.querySelector<HTMLElement>(".lap-ed-table-wrap");
    if (nextTableWrap && savedTableScrollTop > 0) {
      nextTableWrap.scrollTop = savedTableScrollTop;
    }
  };

  const refreshSvgOnly = (): void => {
    const wrap = backdrop.querySelector<HTMLElement>("[data-lap-ed-svg-wrap]");
    const sess = getSession();
    if (!wrap || !sess) return;
    if (wrap.clientWidth > 120) svgW = Math.round(wrap.clientWidth);
    if (wrap.clientHeight > 120) svgH = Math.round(wrap.clientHeight);
    const anchorUs = computeSessionAnchorUs(sess);
    const allRows = deriveAllPassRows(sess, anchorUs);
    wrap.innerHTML = renderGraphSvg(sess, anchorUs, allRows);
    const resetBtn = backdrop.querySelector<HTMLButtonElement>("[data-lap-ed-reset-view]");
    if (resetBtn) resetBtn.hidden = !(userAdjustedX || customY);
  };

  const focusPassRow = (crossingId: number, rowGateId?: number): void => {
    const sess = getSession();
    if (!sess) return;
    const anchorUs = computeSessionAnchorUs(sess);
    const row = findCrossingRow(sess, anchorUs, crossingId, rowGateId ?? focusedGateId);
    if (!row) return;
    focusedGateId = row.gateId;
    selectedCrossingId = crossingId;
    if (selectedLapId === "all") {
      customX = clampXDomain(row.offsetMs - 4000, row.offsetMs + 4000);
      userAdjustedX = true;
    } else if (
      lastDomain &&
      (row.offsetMs < lastDomain.minMs + 250 || row.offsetMs > lastDomain.maxMs - 250)
    ) {
      customX = clampXDomain(row.offsetMs - 3500, row.offsetMs + 3500);
      userAdjustedX = true;
    }
    renderModal();
  };

  const stageAddCrossingAt = (offsetMs: number, targetGateId?: number): void => {
    const sess = getSession();
    const gid = targetGateId ?? focusedGateId;
    if (!sess || gid === null) return;
    const anchorUs = computeSessionAnchorUs(sess);
    const trace = buildTraceMsInWindow(
      sess,
      anchorUs,
      gid,
      selectedPilotSlot,
      offsetMs - 1000,
      offsetMs + 1000
    );
    const peak = sampleTraceAtMs(trace, offsetMs);
    const draft = ensureDraftGateCrossings(sess, gid);
    const newId = nextDraftId--;
    draft.push({
      crossingId: newId,
      gateId: gid,
      timestampUs: Math.max(1000, anchorUs + offsetMs * 1000),
      peakRssiDbm: peak ?? -52,
      manual: true,
    });
    draft.sort((a, b) => a.timestampUs - b.timestampUs);
    focusedGateId = gid;
    selectedCrossingId = newId;
    renderModal();
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

    const threshHandle = target.closest<SVGGElement>("[data-thresh-handle]");
    if (threshHandle && !addMode && focusedGateId !== null) {
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

    const pin = target.closest<SVGGElement>("[data-crossing-pin]");
    if (pin && !addMode) {
      e.preventDefault();
      const cid = Number(pin.getAttribute("data-crossing-pin") || "0");
      const pinGateAttr = Number(pin.getAttribute("data-crossing-gate") || "0");
      const anchorUs = computeSessionAnchorUs(sess);
      const row = findCrossingRow(sess, anchorUs, cid, pinGateAttr || focusedGateId);
      if (!row) return;
      if (!customX) {
        customX = { ...lastDomain };
      }
      // If clicking a non-focused timer's pin, focus that timer; if already focused (or 1-timer), allow dragging!
      if (focusedGateId !== row.gateId) {
        focusedGateId = row.gateId;
        selectedCrossingId = cid;
        renderModal();
        return;
      }
      selectedCrossingId = cid;
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

    if (addMode && focusedGateId !== null) {
      e.preventDefault();
      const offsetMs = clientXToMs(svg, e.clientX);
      addMode = false;
      hoverInfo = null;
      stageAddCrossingAt(offsetMs, focusedGateId);
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
            const nextSpan = clamp(startSpan * pinch.xSpanFactor, MIN_X_SPAN_MS, MAX_X_SPAN_MS);
            const anchorMs = pinchState.startMinMs + pinchState.anchorXFrac * startSpan;
            const liveXFrac = clamp(((pt1.svgX + pt2.svgX) * 0.5 - PAD_L) / plotW, 0, 1);
            const nextMin = anchorMs - liveXFrac * nextSpan;
            customX = clampXDomain(nextMin, nextMin + nextSpan);
            userAdjustedX = true;
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
      if (Math.hypot(dx, dy) >= 4.5) {
        viewDrag.panned = true;
      }
      if (viewDrag.panned) {
        const spanMs = viewDrag.startMaxMs - viewDrag.startMinMs;
        const deltaMs = -(dx / plotW) * spanMs;
        customX = clampXDomain(viewDrag.startMinMs + deltaMs, viewDrag.startMaxMs + deltaMs);
        userAdjustedX = true;
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
        // In `All` mode, show the strongest timer's RSSI at the hovered timestamp
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
      const nextSpan = clamp(spanMs * xSpanFactor, MIN_X_SPAN_MS, MAX_X_SPAN_MS);
      const frac = clamp((svgX - PAD_L) / plotW, 0, 1);
      const anchor = lastDomain.minMs + frac * spanMs;
      customX = clampXDomain(anchor - frac * nextSpan, anchor + (1 - frac) * nextSpan);
      userAdjustedX = true;
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

  const onDblClick = (e: MouseEvent): void => {
    const svg = backdrop.querySelector<SVGSVGElement>("[data-lap-ed-svg]");
    if (!svg || !(e.target instanceof Element) || !e.target.closest("[data-lap-ed-svg]")) return;
    if (focusedGateId === null) {
      showToast("Select a timer chip (H1, T1, …) first to add a crossing", "info");
      return;
    }
    const { svgX, svgY } = clientToSvgCoords(svg, e.clientX, e.clientY);
    if (svgX >= PAD_L && svgX <= svgW - PAD_R && svgY >= PAD_T && svgY <= svgH - PAD_B) {
      stageAddCrossingAt(clientXToMs(svg, e.clientX), focusedGateId);
    }
  };

  const stepSelectedLap = (dir: -1 | 1): void => {
    const sess = getSession();
    if (!sess) return;
    const laps = getPilotLaps(sess);
    if (laps.length === 0) return;
    if (selectedLapId === "all") {
      selectedLapId = dir < 0 ? laps[laps.length - 1].lapId : laps[0].lapId;
    } else {
      const idx = laps.findIndex((l) => l.lapId === selectedLapId);
      const nextIdx = clamp(idx + dir, 0, laps.length - 1);
      selectedLapId = laps[nextIdx].lapId;
    }
    selectedCrossingId = null;
    applySelectedLapFrame(sess);
    renderModal();
  };

  const onChange = (e: Event): void => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const lapSel = target.closest<HTMLSelectElement>("[data-lap-ed-lap-select]");
    if (lapSel) {
      const sess = getSession();
      if (!sess) return;
      selectedLapId = lapSel.value === "all" ? "all" : Number(lapSel.value || "0") || "all";
      selectedCrossingId = null;
      applySelectedLapFrame(sess);
      renderModal();
    }
  };

  const onClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target === backdrop || target.closest("[data-lap-ed-close]")) {
      close();
      return;
    }
    if (target.closest("[data-lap-ed-prev-lap]")) {
      stepSelectedLap(-1);
      return;
    }
    if (target.closest("[data-lap-ed-next-lap]")) {
      stepSelectedLap(1);
      return;
    }
    const gateBtn = target.closest<HTMLButtonElement>("[data-lap-ed-gate]");
    if (gateBtn) {
      const rawGate = gateBtn.dataset.lapEdGate || "all";
      if (rawGate === "all") {
        focusedGateId = null;
        addMode = false;
      } else {
        const nextGate = Number(rawGate || "1");
        if (nodesList().length > 1 && focusedGateId === nextGate) {
          focusedGateId = null;
          addMode = false;
        } else {
          focusedGateId = nextGate;
        }
      }
      selectedCrossingId = null;
      renderModal();
      return;
    }
    if (target.closest("[data-lap-ed-reset-view]")) {
      const sess = getSession();
      customY = null;
      if (sess) applySelectedLapFrame(sess);
      else customX = null;
      refreshSvgOnly();
      return;
    }
    if (target.closest("[data-lap-ed-add-mode]")) {
      if (focusedGateId === null) return;
      addMode = !addMode;
      renderModal();
      return;
    }
    if (target.closest("[data-lap-ed-auto-label]")) {
      void runAutoLabelPreview();
      return;
    }
    if (target.closest("[data-lap-ed-discard]")) {
      draftByGate.clear();
      draftThresholdsByGate.clear();
      addMode = false;
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
      const sess = getSession();
      if (sess && cid !== 0 && delGateId !== null) {
        const draft = ensureDraftGateCrossings(sess, delGateId);
        const idx = draft.findIndex((c) => c.crossingId === cid);
        if (idx >= 0) {
          draft.splice(idx, 1);
          if (selectedCrossingId === cid) selectedCrossingId = null;
          renderModal();
        }
      }
      return;
    }
    const rowEl = target.closest<HTMLElement>("[data-lap-ed-row]");
    if (rowEl) {
      const cid = Number(rowEl.dataset.lapEdRow || "0");
      const rgid = Number(rowEl.dataset.lapEdRowGate || "0") || undefined;
      if (cid !== 0) focusPassRow(cid, rgid);
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (addMode) {
        addMode = false;
        renderModal();
      } else {
        close();
      }
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
    addMode = false;
    renderModal();
    try {
      const res = await rootApi.labelPracticeSession(sessionId, {
        dryRun: true,
        slotIndex: selectedPilotSlot,
      });
      const latestSess = getSession();
      if (!latestSess) return;

      const byGateDecs = new Map<number, typeof res.decisions>();
      for (const d of res.decisions ?? []) {
        if (d.slotIndex !== selectedPilotSlot) continue;
        let arr = byGateDecs.get(d.gateId);
        if (!arr) {
          arr = [];
          byGateDecs.set(d.gateId, arr);
        }
        arr.push(d);
      }

      for (const node of nodesList()) {
        const gid = node.gateId;
        const orig = extractOriginalGateCrossings(latestSess, gid, selectedPilotSlot);
        const manualKept = orig.filter((c) => Boolean(c.manual)).map((c) => ({ ...c }));
        const nonManualOrig = orig.filter((c) => !c.manual);
        const usedOrigIds = new Set<number>();
        const nextList: DraftGateCrossing[] = [...manualKept];

        const gateDecs = (byGateDecs.get(gid) ?? []).filter(
          (d) => d.label === "crossing" && d.confidence >= 0.5
        );
        for (const dec of gateDecs) {
          if (manualKept.some((m) => Math.abs(m.timestampUs - dec.finalTsUs) <= 220_000)) {
            continue;
          }
          let bestOrig: DraftGateCrossing | null = null;
          let bestDiff = 220_001;
          for (const cand of nonManualOrig) {
            if (usedOrigIds.has(cand.crossingId)) continue;
            const diff = Math.abs(cand.timestampUs - dec.finalTsUs);
            if (diff < bestDiff) {
              bestDiff = diff;
              bestOrig = cand;
            }
          }
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
        `Staged ${res.crossingsCount} AI pass${res.crossingsCount === 1 ? "" : "es"} (${res.hardNegsCount} bleed/noise rejected)`,
        "info"
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      isAutoLabeling = false;
      renderModal();
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
    backdrop.removeEventListener("dblclick", onDblClick);
    backdrop.removeEventListener("change", onChange);
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
  backdrop.addEventListener("dblclick", onDblClick);
  backdrop.addEventListener("change", onChange);
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
  }
  void rootApi
    .ensurePracticeSessionTrace(sessionId, needsFreshActiveTrace)
    .then(() => {
      isLoadingTrace = false;
      if (document.body.contains(backdrop) && !dragState && !threshDrag && !viewDrag) {
        const latestSess = getSession();
        if (latestSess && !userAdjustedX && selectedLapId !== "all") {
          applySelectedLapFrame(latestSess);
        }
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
