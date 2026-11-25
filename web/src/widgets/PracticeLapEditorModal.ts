import {
  computeDirectionalPinch,
  computeWheelZoomFactors,
  PinchPoint,
  scrollOuterPageBy,
} from "../core/chart_pinch";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { formatBandChannelShort } from "../core/vtx_channels";
import { ApiClient } from "../services/api_client";
import {
  enterThresholdAt,
  exitThresholdAt,
  gateLabel,
  laprfThresholdAt,
  rhThresholdAt,
} from "../state/selectors";
import { AppStore } from "../state/store";
import {
  isLapRFMode,
  isRotorHazardMode,
  isSlapRFMode,
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
  offsetMs: number;
  label: string;
  splitSec: number | null;
  peakDbm: number | null;
}

const DEFAULT_SVG_W = 850;
const DEFAULT_SVG_H = 224;
const PAD_L = 46;
const PAD_R = 18;
const PAD_T = 26;
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
 * Opens the interactive Practice RSSI & Gate Crossing Editor modal (matching `HeatLapEditorModal`),
 * supporting per-timer `.rfbin` RSSI curves (`H1`, `T1`, `T2`, ...), draggable crossing pins,
 * click/double-click `+ Add Crossing`, pass deletion, threshold dragging, and lap-focused zoom.
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

  let selectedGateId = opts.initialGateId ?? sfGateId();
  let selectedCrossingId: number | null = null;
  let addMode = false;
  let customX: { minMs: number; maxMs: number } | null = null;
  let customY: { minDbm: number; maxDbm: number } | null = null;
  let panAnimFrame = 0;
  let isSaving = false;
  let isAutoLabeling = false;
  let nextDraftId = -1;

  // Map<gateId, DraftGateCrossing[]> for staged edits per timer
  const draftByGate = new Map<number, DraftGateCrossing[]>();
  const draftThresholdsByGate = new Map<
    number,
    { enterDb: number; exitDb: number; hwMode: TimingHardwareMode }
  >();

  const computeSessionAnchorUs = (sess: PracticeSession): number => {
    let minUs = Number.POSITIVE_INFINITY;
    for (const n of reviewStore.nodes) {
      const hist = reviewStore.historyFor(n.gateId);
      if (hist.length > 0 && hist[0].timestampUs > 0 && hist[0].timestampUs < minUs) {
        minUs = hist[0].timestampUs;
      }
    }
    for (const c of sess.crossings ?? []) {
      if (c.timestampUs > 0 && c.timestampUs < minUs) {
        minUs = c.timestampUs;
      }
    }
    if (!Number.isFinite(minUs)) return 1_000_000;
    return Math.max(0, minUs - 500_000);
  };

  if (
    opts.focusStartUs !== undefined &&
    opts.focusEndUs !== undefined &&
    opts.focusEndUs >= opts.focusStartUs
  ) {
    const anchor = computeSessionAnchorUs(initSess);
    const startMs = Math.round((opts.focusStartUs - anchor) / 1000);
    const endMs = Math.round((opts.focusEndUs - anchor) / 1000);
    const padMs = Math.max(1800, Math.round((endMs - startMs) * 0.22));
    customX = {
      minMs: startMs - padMs,
      maxMs: Math.max(startMs + 3000, endMs + padMs),
    };
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

  const buildTraceMs = (
    sess: PracticeSession,
    anchorUs: number,
    gateId: number,
    slotIndex: number
  ): Array<{ t: number; r: number }> => {
    let frames = reviewStore.historyFor(gateId);
    if (frames.length === 0 && sess.active) {
      frames = rootStore.historyFor(gateId);
    }
    if (frames.length === 0) return [];
    const slotZeroIdx = Math.max(0, slotIndex - 1);
    const step = frames.length > 2400 ? Math.ceil(frames.length / 2400) : 1;
    const out: Array<{ t: number; r: number }> = [];
    for (let i = 0; i < frames.length; i += step) {
      const fr = frames[i];
      const val = fr.rssi[slotZeroIdx];
      if (val === undefined || val <= -125) continue;
      out.push({
        t: Math.round((fr.timestampUs - anchorUs) / 1000),
        r: val,
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
        offsetMs,
        label,
        splitSec,
        peakDbm,
      });
    }
    return rows;
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
    pointerId: number;
    currentOffsetMs: number;
  } | null = null;
  let threshDrag: {
    kind: "enter" | "exit";
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
  } | null = null;
  let hoverInfo: { offsetMs: number; dbm: number | null } | null = null;

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
    if (isLapRFMode(hwMode)) {
      let thr = drafted
        ? drafted.enterDb
        : laprfThresholdAt(reviewStore, gateId, slotIndex).dbm;
      if (threshDrag) thr = threshDrag.currentDbm;
      return { enterDb: Math.round(thr), exitDb: Math.round(thr), hwMode };
    }
    if (isRotorHazardMode(hwMode)) {
      const pair = rhThresholdAt(reviewStore, gateId, slotIndex);
      let enterVal = drafted ? drafted.enterDb : pair.enter;
      let exitVal = drafted ? drafted.exitDb : pair.exit;
      exitVal = clamp(exitVal, 6, enterVal - 4);
      if (threshDrag) {
        if (threshDrag.kind === "enter") {
          enterVal = clamp(threshDrag.currentDbm, Math.max(10, exitVal + 4), 250);
          exitVal = clamp(exitVal, 6, enterVal - 4);
        } else {
          exitVal = clamp(threshDrag.currentDbm, 6, enterVal - 4);
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
    if (threshDrag) {
      if (threshDrag.kind === "enter") {
        enterDb = threshDrag.currentDbm;
        exitDb = Math.min(enterDb - 2, exitDb);
      } else {
        exitDb = Math.min(enterDb - 2, threshDrag.currentDbm);
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

  const clampXDomain = (minMs: number, maxMs: number) => {
    const span = clamp(maxMs - minMs, MIN_X_SPAN_MS, MAX_X_SPAN_MS);
    const lo = clamp(minMs, -30_000, 3_600_000);
    return { minMs: Math.round(lo), maxMs: Math.round(lo + span) };
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
    trace: Array<{ t: number; r: number }>,
    rows: DerivedPassRow[]
  ): { minMs: number; maxMs: number } => {
    let minMs = 0;
    let maxMs = 20_000;
    if (trace.length > 0) {
      minMs = Math.min(0, trace[0].t - 500);
      maxMs = Math.max(minMs + 8000, trace[trace.length - 1].t + 1000);
    }
    for (const r of rows) {
      if (r.offsetMs - 1000 < minMs) minMs = r.offsetMs - 1000;
      if (r.offsetMs + 2000 > maxMs) maxMs = r.offsetMs + 2000;
    }
    if (maxMs - minMs > 45_000 && rows.length >= 2) {
      const firstMs = rows[0].offsetMs;
      const thirdMs = rows[Math.min(rows.length - 1, 3)].offsetMs;
      return {
        minMs: Math.max(minMs, firstMs - 2000),
        maxMs: Math.max(firstMs + 8000, thirdMs + 3000),
      };
    }
    return { minMs, maxMs: Math.max(minMs + 5000, maxMs) };
  };

  const renderGraphSvg = (
    trace: Array<{ t: number; r: number }>,
    rows: DerivedPassRow[]
  ): string => {
    const plotW = getPlotW();
    const plotH = getPlotH();
    const { enterDb, exitDb, hwMode } = getGateThresholds(selectedGateId, selectedPilotSlot);
    lastHwMode = hwMode;
    lastDomain = customX ?? computeAutoDomainMs(trace, rows);
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

    const stepMs =
      spanMs <= 3000 ? 250 : spanMs <= 7000 ? 500 : spanMs <= 14_000 ? 1000 : spanMs <= 30_000 ? 2000 : spanMs <= 70_000 ? 5000 : 10_000;
    const firstTick = Math.ceil(lastDomain.minMs / stepMs) * stepMs;
    const xTicks: string[] = [];
    for (let t = firstTick; t <= lastDomain.maxMs; t += stepMs) {
      const xNum = msToX(t);
      if (xNum < PAD_L || xNum > svgW - PAD_R) continue;
      const x = xNum.toFixed(1);
      const dec = stepMs < 500 ? 2 : t % 1000 === 0 && stepMs >= 1000 ? 0 : 1;
      xTicks.push(`
        <line x1="${x}" y1="${PAD_T}" x2="${x}" y2="${svgH - PAD_B}" class="lap-ed-grid-line is-vert" />
        <text x="${x}" y="${svgH - 8}" class="lap-ed-axis-lbl" text-anchor="middle">${(t / 1000).toFixed(dec)}s</text>`);
    }

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

    const threshHtml = `
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

    const visiblePts = trace.filter(
      (p) => p.t >= lastDomain.minMs - 2000 && p.t <= lastDomain.maxMs + 2000
    );
    let waveHtml = "";
    if (visiblePts.length >= 2) {
      const pts = visiblePts.map((p) => `${msToX(p.t).toFixed(1)},${dbmToY(p.r).toFixed(1)}`);
      const xFirst = msToX(visiblePts[0].t).toFixed(1);
      const xLast = msToX(visiblePts[visiblePts.length - 1].t).toFixed(1);
      const baseY = (svgH - PAD_B + 4).toFixed(1);
      waveHtml = `
        <path d="M ${xFirst},${baseY} L ${pts.join(" L ")} L ${xLast},${baseY} Z" class="lap-ed-rssi-area" />
        <path d="M ${pts.join(" L ")}" class="lap-ed-rssi-line" />`;
    } else {
      const flatVal = isLapRFMode(hwMode) ? 360 : isRotorHazardMode(hwMode) ? 22 : -90;
      const flatY = clamp(dbmToY(flatVal), PAD_T + 8, svgH - PAD_B - 8).toFixed(1);
      waveHtml = `
        <line x1="${PAD_L}" y1="${flatY}" x2="${svgW - PAD_R}" y2="${flatY}" class="lap-ed-rssi-line is-synthetic" />
        <text x="${PAD_L + plotW / 2}" y="${PAD_T + plotH / 2}" class="lap-ed-empty-svg" text-anchor="middle">No RSSI waveform recorded</text>`;
    }

    const pinsHtml = rows
      .map((r) => {
        const effMs =
          dragState && dragState.crossingId === r.crossing.crossingId
            ? dragState.currentOffsetMs
            : r.offsetMs;
        const rawX = msToX(effMs);
        const isDragging = Boolean(dragState && dragState.crossingId === r.crossing.crossingId);
        const isSel = selectedCrossingId !== null && r.crossing.crossingId === selectedCrossingId;
        if (!isDragging && (rawX < PAD_L - 2 || rawX > svgW - PAD_R + 2)) {
          return "";
        }
        const x = clamp(rawX, PAD_L, svgW - PAD_R);
        const xf = x.toFixed(1);
        const inv = r.label === "INV";
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
        const tagText = `${r.label} · ${subTime}`;
        const pillW = Math.max(54, tagText.length * 6.5 + 14);
        const pillX = clamp(x - pillW / 2, PAD_L, svgW - PAD_R - pillW);
        return `
          <g class="${cls}" data-crossing-pin="${r.crossing.crossingId}">
            <line x1="${xf}" y1="${PAD_T}" x2="${xf}" y2="${svgH - PAD_B}" class="lap-ed-pin-line" />
            <line x1="${xf}" y1="${PAD_T}" x2="${xf}" y2="${svgH - PAD_B}" class="lap-ed-pin-hit" />
            <rect x="${pillX.toFixed(1)}" y="4" width="${pillW.toFixed(1)}" height="18" rx="5" class="lap-ed-pin-pill" />
            <text x="${(pillX + pillW / 2).toFixed(1)}" y="16.5" text-anchor="middle" class="lap-ed-pin-lbl">${esc(tagText)}</text>
          </g>`;
      })
      .join("");

    let hoverHtml = "";
    if (hoverInfo && !dragState && !threshDrag && !viewDrag) {
      const hx = clamp(msToX(hoverInfo.offsetMs), PAD_L, svgW - PAD_R).toFixed(1);
      const hLbl = `${fmtOffsetSec(hoverInfo.offsetMs)}${hoverInfo.dbm !== null ? ` · ${hoverInfo.dbm}${isSlapRFMode(hwMode) ? " dBm" : ""}` : ""}${addMode ? " (Click to add)" : ""}`;
      hoverHtml = `
        <g class="lap-ed-hover-guide ${addMode ? "is-add" : ""}" pointer-events="none">
          <line x1="${hx}" y1="${PAD_T}" x2="${hx}" y2="${svgH - PAD_B}" class="lap-ed-hover-line" />
          <text x="${clamp(Number(hx) + 6, PAD_L + 4, svgW - PAD_R - 120).toFixed(1)}" y="${svgH - PAD_B - 6}" class="lap-ed-hover-lbl">${esc(hLbl)}</text>
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
          <linearGradient id="lapEdRssiGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.34" />
            <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.02" />
          </linearGradient>
          <clipPath id="lapEdPlotClip">
            <rect x="${PAD_L}" y="${PAD_T}" width="${plotW}" height="${plotH}" rx="4" />
          </clipPath>
        </defs>
        <rect x="${PAD_L}" y="${PAD_T}" width="${plotW}" height="${plotH}" rx="4" class="lap-ed-plot-bg" />
        ${yTicks.join("")}
        ${xTicks.join("")}
        <g clip-path="url(#lapEdPlotClip)">
          ${waveHtml}
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

    const anchorUs = computeSessionAnchorUs(sess);
    const trace = buildTraceMs(sess, anchorUs, selectedGateId, selectedPilotSlot);
    const rows = derivePassRows(sess, anchorUs, selectedGateId);
    const pilot =
      sess.pilots.find((p) => p.slotIndex === selectedPilotSlot) ??
      reviewStore.pilot(selectedPilotSlot);
    const callsign = pilot?.callsign || `Pilot ${selectedPilotSlot}`;
    const color = pilot?.color || "#38bdf8";
    const chLabel = pilot?.channel ? formatBandChannelShort(pilot.band, pilot.channel) : "";
    const { hwMode } = getGateThresholds(selectedGateId, selectedPilotSlot);

    const gateChipsHtml = `<div class="lap-ed-gate-pills">${nodesList()
      .map((g) => {
        const gActive = g.gateId === selectedGateId;
        const gLbl = gateLabel(reviewStore, g.gateId);
        return `<button type="button" class="btn ${gActive ? "btn-armed" : "btn-ghost"} btn-xs" data-lap-ed-gate="${g.gateId}">${esc(gLbl)}</button>`;
      })
      .join("")}</div>`;

    const hasCustomView = Boolean(customX || customY);
    const isDirty = hasUnsavedChanges();
    const curGateLabel = gateLabel(reviewStore, selectedGateId);

    const tableRowsHtml =
      rows.length === 0
        ? `<tr><td colspan="6" class="muted" style="text-align:center; padding: 18px 12px;">No passes recorded at ${esc(curGateLabel)}. Click <strong>Add Crossing</strong> or double-click an RSSI peak above.</td></tr>`
        : rows
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
                <tr class="lap-ed-row ${r.label === "INV" ? "is-invalid-row" : ""} ${isSel ? "is-selected" : ""}" data-lap-ed-row="${r.crossing.crossingId}">
                  <td class="lap-ed-num mono lap-ed-col-pass">${esc(r.label)}</td>
                  <td class="lap-ed-num mono lap-ed-col-gate">${fmtOffsetSec(r.offsetMs)}</td>
                  <td class="lap-ed-col-split">${splitCell}</td>
                  <td class="lap-ed-col-rssi">${rssiCell}</td>
                  <td class="lap-ed-col-src"><span class="muted">${r.crossing.manual ? "Manual" : "Timer"}</span></td>
                  <td class="lap-ed-col-act">
                    <button type="button" class="btn btn-ghost lap-ed-act-btn lap-ed-del-btn" data-lap-ed-delete="${r.crossing.crossingId}" title="Delete crossing" aria-label="Delete crossing">
                      ${icons.trash(16)}
                    </button>
                  </td>
                </tr>`;
            })
            .join("");

    backdrop.innerHTML = `
      <div class="slaprf-modal card rc-modal-xl lap-editor-modal" role="document">
        <div class="slaprf-modal-head">
          <div class="slaprf-modal-title-row">
            <h3>
              <span class="lap-ed-title-pilot">
                <span class="dot" style="background:${esc(color)}"></span>
                <span>${esc(callsign)}${chLabel ? ` (${esc(chLabel)})` : ""}</span>
              </span>
            </h3>
          </div>
          <button type="button" class="btn btn-ghost btn-xs lap-ed-desktop-close-btn" data-lap-ed-close aria-label="Close">
            ${icons.close(15)}
          </button>
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
              <button type="button" class="btn ${addMode ? "btn-armed" : "btn-ghost"} btn-xs" data-lap-ed-add-mode>
                ${icons.plus(13)}<span>${addMode ? "Click Peak…" : "Add Crossing"}</span>
              </button>
            </div>
          </div>

          <div class="lap-ed-graph-card">
            <div class="lap-ed-svg-wrap" data-lap-ed-svg-wrap>
              ${renderGraphSvg(trace, rows)}
            </div>
            <div class="lap-ed-graph-caption">Select any timer above, drag pins to adjust timing, double-click an RSSI peak to add a pass, or delete false triggers below.</div>
          </div>

          <div class="lap-ed-table-wrap">
            <table class="table rc-compact-table lap-ed-table">
              <thead>
                <tr>
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
    const trace = buildTraceMs(sess, anchorUs, selectedGateId, selectedPilotSlot);
    const rows = derivePassRows(sess, anchorUs, selectedGateId);
    wrap.innerHTML = renderGraphSvg(trace, rows);
    const resetBtn = backdrop.querySelector<HTMLButtonElement>("[data-lap-ed-reset-view]");
    if (resetBtn) resetBtn.hidden = !(customX || customY);
  };

  const focusPassRow = (crossingId: number): void => {
    const sess = getSession();
    if (!sess) return;
    const anchorUs = computeSessionAnchorUs(sess);
    const rows = derivePassRows(sess, anchorUs, selectedGateId);
    const row = rows.find((r) => r.crossing.crossingId === crossingId);
    if (!row) return;
    selectedCrossingId = crossingId;
    customX = clampXDomain(row.offsetMs - 4000, row.offsetMs + 4000);
    renderModal();
  };

  const stageAddCrossingAt = (offsetMs: number): void => {
    const sess = getSession();
    if (!sess) return;
    const anchorUs = computeSessionAnchorUs(sess);
    const trace = buildTraceMs(sess, anchorUs, selectedGateId, selectedPilotSlot);
    const peak = sampleTraceAtMs(trace, offsetMs);
    const draft = ensureDraftGateCrossings(sess, selectedGateId);
    const newId = nextDraftId--;
    draft.push({
      crossingId: newId,
      gateId: selectedGateId,
      timestampUs: Math.max(1000, anchorUs + offsetMs * 1000),
      peakRssiDbm: peak ?? -52,
      manual: true,
    });
    draft.sort((a, b) => a.timestampUs - b.timestampUs);
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
    if (threshHandle && !addMode) {
      e.preventDefault();
      const kind = threshHandle.getAttribute("data-thresh-handle") === "exit" ? "exit" : "enter";
      const cur = getGateThresholds(selectedGateId, selectedPilotSlot);
      threshDrag = {
        kind,
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
      const anchorUs = computeSessionAnchorUs(sess);
      const rows = derivePassRows(sess, anchorUs, selectedGateId);
      const row = rows.find((r) => r.crossing.crossingId === cid);
      if (!row) return;
      if (!customX) {
        customX = { ...lastDomain };
      }
      selectedCrossingId = cid;
      dragState = {
        crossingId: cid,
        pointerId: e.pointerId,
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

    if (addMode) {
      e.preventDefault();
      const offsetMs = clientXToMs(svg, e.clientX);
      addMode = false;
      hoverInfo = null;
      stageAddCrossingAt(offsetMs);
      return;
    }

    if (svgX >= PAD_L && svgX <= svgW - PAD_R && svgY >= PAD_T && svgY <= svgH - PAD_B) {
      e.preventDefault();
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
      if (Math.abs(dx) >= 1.5 || customX) {
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
      return;
    }

    if (threshDrag) {
      const { svgY } = clientToSvgCoords(svg, e.clientX, e.clientY);
      threshDrag.currentDbm = yToDbm(svgY);
      refreshSvgOnly();
      return;
    }

    if (dragState) {
      dragState.currentOffsetMs = clientXToMs(svg, e.clientX);
      refreshSvgOnly();
      return;
    }

    if (e.pointerType === "mouse") {
      const offsetMs = clientXToMs(svg, e.clientX);
      const anchorUs = computeSessionAnchorUs(sess);
      const trace = buildTraceMs(sess, anchorUs, selectedGateId, selectedPilotSlot);
      hoverInfo = { offsetMs, dbm: sampleTraceAtMs(trace, offsetMs) };
      refreshSvgOnly();
    }
  };

  const onPointerUp = (e: PointerEvent): void => {
    touchPts.delete(e.pointerId);
    if (touchPts.size < 2) pinchState = null;

    const sess = getSession();
    if (dragState && sess) {
      const movedId = dragState.crossingId;
      const nextMs = dragState.currentOffsetMs;
      dragState = null;
      const anchorUs = computeSessionAnchorUs(sess);
      const trace = buildTraceMs(sess, anchorUs, selectedGateId, selectedPilotSlot);
      const draft = ensureDraftGateCrossings(sess, selectedGateId);
      const item = draft.find((c) => c.crossingId === movedId);
      if (item) {
        item.timestampUs = Math.max(1000, anchorUs + nextMs * 1000);
        const pk = sampleTraceAtMs(trace, nextMs);
        if (pk !== null) item.peakRssiDbm = pk;
        item.manual = true;
        draft.sort((a, b) => a.timestampUs - b.timestampUs);
      }
      renderModal();
      return;
    }

    if (threshDrag) {
      const cur = getGateThresholds(selectedGateId, selectedPilotSlot);
      threshDrag = null;
      draftThresholdsByGate.set(selectedGateId, cur);
      renderModal();
      return;
    }

    if (viewDrag) {
      viewDrag = null;
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
    const { svgX, svgY } = clientToSvgCoords(svg, e.clientX, e.clientY);
    if (svgX >= PAD_L && svgX <= svgW - PAD_R && svgY >= PAD_T && svgY <= svgH - PAD_B) {
      stageAddCrossingAt(clientXToMs(svg, e.clientX));
    }
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
      selectedGateId = Number(gateBtn.dataset.lapEdGate || "1");
      selectedCrossingId = null;
      renderModal();
      return;
    }
    if (target.closest("[data-lap-ed-reset-view]")) {
      customX = null;
      customY = null;
      refreshSvgOnly();
      return;
    }
    if (target.closest("[data-lap-ed-add-mode]")) {
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
      const sess = getSession();
      if (sess && cid !== 0) {
        const draft = ensureDraftGateCrossings(sess, selectedGateId);
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
      if (cid !== 0) focusPassRow(cid);
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
          // Match closest unedited crossing within +-220 ms so Save Changes cleanly adjusts rather than delete+add
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
    .ensurePracticeSessionTrace(sessionId)
    .then(() => {
      if (document.body.contains(backdrop) && !dragState && !threshDrag && !viewDrag) {
        renderModal();
      }
    })
    .catch(() => undefined);
}
