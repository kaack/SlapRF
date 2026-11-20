import { computeDirectionalPinch, computeWheelZoomFactors, PinchPoint, scrollOuterPageBy } from "../core/chart_pinch";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ApiClient } from "../services/api_client";
import { enterThresholdAt, exitThresholdAt, gateLabel, laprfThresholdAt, rhThresholdAt } from "../state/selectors";
import { AppStore } from "../state/store";
import { HeatCrossing, HeatRssiSample, HeatSeat, isRotorHazardMode, isSlapRFMode, RaceHeat, RaceTournamentState, TimingHardwareMode } from "../types/models";
import { showToast } from "./Toast";

const BAND_LETTER: Record<number, string> = { 0: "R", 1: "R", 2: "A", 3: "B", 4: "E", 5: "F", 6: "D" };
function bandChannelShort(band: number | undefined, ch: number | undefined): string {
  if (!ch || ch <= 0) return "—";
  return `${BAND_LETTER[band ?? 1] ?? "R"}${ch}`;
}

let activeLapEditorCleanup: (() => void) | null = null;

export function closeActiveLapEditorModal(): void {
  activeLapEditorCleanup?.();
}

interface DerivedCrossingRow {
  crossing: HeatCrossing;
  offsetMs: number;
  label: string;
  isHoleshot: boolean;
  isExtra: boolean;
  lapNumber: number;
  splitSec: number | null;
  isBestLap: boolean;
  isBestConsec: boolean;
  peakDbm: number | null;
}

interface DerivedCrossingsSummary {
  rows: DerivedCrossingRow[];
  bestConsecSec: number | null;
  consecWindow: 2 | 3;
  countedLaps: number;
  bestLapSec: number | null;
  holeshotSec: number | null;
  totalTimeSec: number | null;
}

const DEFAULT_SVG_W = 850;
const SVG_H = 224;
const PAD_L = 46;
const PAD_R = 18;
const PAD_T = 26;
const PAD_B = 28;
const PLOT_H = SVG_H - PAD_T - PAD_B;
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
const MAX_X_SPAN_MS = 300_000;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function extractRawCrossings(heat: RaceHeat, seat: HeatSeat): HeatCrossing[] {
  if (seat.crossings && seat.crossings.length > 0) {
    return seat.crossings;
  }
  const anchorUs = heat.startToneUs ?? 0;
  let runningSec = 0;
  return (seat.laps ?? []).map((l) => {
    if (!l.invalidated && l.splitTimeSec > 0) {
      runningSec += l.splitTimeSec;
    }
    const explicitTs = (l as { timestampUs?: number }).timestampUs;
    const relSec =
      l.raceElapsedSec && l.raceElapsedSec > 0
        ? l.raceElapsedSec
        : l.cumulativeSec && l.cumulativeSec > 0
          ? l.cumulativeSec
          : runningSec;
    const tsUs =
      typeof explicitTs === "number" && explicitTs > 0
        ? explicitTs
        : anchorUs + Math.round(relSec * 1_000_000);
    return {
      crossingId: l.crossingId,
      timestampUs: tsUs,
      invalidated: l.invalidated,
      manual: l.manual,
    };
  });
}

function getAnchorUs(heat: RaceHeat, seat: HeatSeat, raw: HeatCrossing[]): number {
  if (heat.startToneUs && heat.startToneUs > 0) {
    return heat.startToneUs;
  }
  if (raw.length > 0) {
    return raw[0].timestampUs > 800_000
      ? raw[0].timestampUs - Math.round((seat.holeshotSec || 0.8) * 1_000_000)
      : raw[0].timestampUs;
  }
  return 1_000_000_000;
}

function deriveCrossings(
  heat: RaceHeat,
  seat: HeatSeat,
  race?: RaceTournamentState,
  overrideCrossings?: HeatCrossing[] | null
): DerivedCrossingsSummary {
  const stage = (race?.stages ?? []).find((s) => s.index === heat.stageIndex);
  const qualMetric =
    stage?.settings?.qualifyingMetric || race?.config?.qualifyingMetric || "consecutive_3";
  const consecWindow: 2 | 3 = qualMetric === "consecutive_2" ? 2 : 3;

  const raw: HeatCrossing[] = overrideCrossings ?? extractRawCrossings(heat, seat);

  if (raw.length === 0) {
    return {
      rows: [],
      bestConsecSec: null,
      consecWindow,
      countedLaps: 0,
      bestLapSec: null,
      holeshotSec: null,
      totalTimeSec: null,
    };
  }

  const anchorUs = getAnchorUs(heat, seat, raw);

  const rows: DerivedCrossingRow[] = [];
  let hasHoleshot = false;
  let prevValidMs = 0;
  let countedLaps = 0;
  let bestSplit = Infinity;
  let holeshotSec: number | null = null;
  let runningLapSumSec = 0;

  for (let idx = 0; idx < raw.length; idx++) {
    const c = raw[idx];
    const offsetMs = Math.round((c.timestampUs - anchorUs) / 1000);
    const peakDbm = c.peakRssiDbm && c.peakRssiDbm !== 0 ? Math.round(c.peakRssiDbm) : null;

    if (c.invalidated && idx > 0) {
      rows.push({
        crossing: c,
        offsetMs,
        label: "INV",
        isHoleshot: false,
        isExtra: false,
        lapNumber: -1,
        splitSec: null,
        isBestLap: false,
        isBestConsec: false,
        peakDbm,
      });
      continue;
    }

    if (!hasHoleshot) {
      hasHoleshot = true;
      prevValidMs = offsetMs;
      const hsSec = heat.startMode === "heads_up" ? Math.max(0, offsetMs / 1000) : 0;
      holeshotSec = hsSec;
      rows.push({
        crossing: c.invalidated ? { ...c, invalidated: false } : c,
        offsetMs,
        label: "HS",
        isHoleshot: true,
        isExtra: false,
        lapNumber: 0,
        splitSec: hsSec,
        isBestLap: false,
        isBestConsec: false,
        peakDbm,
      });
      continue;
    }

    const isExtra =
      heat.targetLaps > 0 && heat.startMode === "heads_up" && countedLaps >= heat.targetLaps;
    const splitSec = Math.max(0, (offsetMs - prevValidMs) / 1000);
    if (!isExtra) {
      prevValidMs = offsetMs;
      countedLaps++;
      runningLapSumSec += splitSec;
      if (splitSec > 0 && splitSec < bestSplit) {
        bestSplit = splitSec;
      }
      rows.push({
        crossing: c,
        offsetMs,
        label: `L${countedLaps}`,
        isHoleshot: false,
        isExtra: false,
        lapNumber: countedLaps,
        splitSec,
        isBestLap: false,
        isBestConsec: false,
        peakDbm,
      });
    } else {
      rows.push({
        crossing: c,
        offsetMs,
        label: `+L${countedLaps + 1}`,
        isHoleshot: false,
        isExtra: true,
        lapNumber: countedLaps + 1,
        splitSec,
        isBestLap: false,
        isBestConsec: false,
        peakDbm,
      });
    }
  }

  const explicitDnf = seat.status === "dnf" && Boolean(seat.statusOverridden);
  const seatRunOverridden = seat.status === "dq" || seat.status === "dns" || explicitDnf;

  if (!seatRunOverridden && countedLaps > 1 && bestSplit < Infinity) {
    for (const r of rows) {
      if (!r.isHoleshot && !r.isExtra && !r.crossing.invalidated && r.splitSec !== null) {
        if (Math.abs(r.splitSec - bestSplit) < 0.0006) {
          r.isBestLap = true;
          break;
        }
      }
    }
  }

  let bestConsecSec: number | null = null;
  const validIndices: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.isHoleshot && !r.isExtra && !r.crossing.invalidated && r.splitSec !== null && r.splitSec > 0) {
      validIndices.push(i);
    }
  }
  if (validIndices.length >= consecWindow) {
    let bestWindowStart = -1;
    let bestWindowSum = Infinity;
    for (let w = 0; w <= validIndices.length - consecWindow; w++) {
      let sum = 0;
      for (let k = 0; k < consecWindow; k++) {
        sum += rows[validIndices[w + k]].splitSec ?? 0;
      }
      if (sum < bestWindowSum - 1e-6) {
        bestWindowSum = sum;
        bestWindowStart = w;
      }
    }
    if (bestWindowStart >= 0 && bestWindowSum < Infinity) {
      bestConsecSec = bestWindowSum;
      if (!seatRunOverridden) {
        for (let k = 0; k < consecWindow; k++) {
          rows[validIndices[bestWindowStart + k]].isBestConsec = true;
        }
      }
    }
  }

  const totalTimeSec =
    countedLaps > 0
      ? (heat.startMode === "heads_up" ? (holeshotSec ?? 0) : 0) +
        runningLapSumSec +
        (seat.penaltySec ?? 0)
      : null;

  return {
    rows,
    bestConsecSec,
    consecWindow,
    countedLaps,
    bestLapSec: bestSplit < Infinity ? bestSplit : null,
    holeshotSec,
    totalTimeSec,
  };
}

function computeFullTimeDomainMs(
  heat: RaceHeat,
  trace: HeatRssiSample[],
  rows: DerivedCrossingRow[]
): { minMs: number; maxMs: number } {
  let minMs = -1500;
  let maxMs = Math.max(15_000, Math.round((heat.elapsedSec || 0) * 1000) + 1500);
  for (const pt of trace) {
    if (pt.t < minMs) minMs = pt.t;
    if (pt.t + 1000 > maxMs) maxMs = pt.t + 1000;
  }
  for (const r of rows) {
    if (r.offsetMs - 1000 < minMs) minMs = r.offsetMs - 1000;
    if (r.offsetMs + 2500 > maxMs) maxMs = r.offsetMs + 2500;
  }
  return { minMs, maxMs: Math.max(minMs + 5000, maxMs) };
}

function computeVisibleTimeDomainMs(
  heat: RaceHeat,
  trace: HeatRssiSample[],
  rows: DerivedCrossingRow[],
  plotW: number
): { minMs: number; maxMs: number } {
  const fullDom = computeFullTimeDomainMs(heat, trace, rows);
  const maxVisibleLaps = Math.max(1, Math.floor(plotW / 190));

  if (rows.length === 0) {
    const targetSpan = maxVisibleLaps * 12_000;
    if (fullDom.maxMs - fullDom.minMs > targetSpan) {
      return { minMs: fullDom.minMs, maxMs: fullDom.minMs + Math.max(8000, targetSpan) };
    }
    return fullDom;
  }

  if (rows.length === 1) {
    const t0 = rows[0].offsetMs;
    const lo = Math.min(-1200, t0 - 2500);
    const hi = Math.max(lo + 6000, t0 + 4000);
    return { minMs: lo, maxMs: hi };
  }

  const endIdx = Math.min(
    rows.length - 1,
    rows[0].isHoleshot ? maxVisibleLaps : maxVisibleLaps - 1
  );
  if (endIdx >= rows.length - 1) {
    return fullDom;
  }

  const startMs = Math.min(-1200, rows[0].offsetMs - 1500);
  const endCrossingMs = rows[endIdx].offsetMs;
  const rawSpan = Math.max(4000, endCrossingMs - startMs);
  const rightPad = Math.max(1600, Math.round(rawSpan * 0.16));
  return {
    minMs: Math.round(startMs),
    maxMs: Math.round(endCrossingMs + rightPad),
  };
}

function fmtOffsetSec(ms: number): string {
  const sec = ms / 1000;
  return `${sec >= 0 ? "+" : ""}${sec.toFixed(2)}s`;
}

export function openHeatLapEditorModal(
  store: AppStore,
  api: ApiClient,
  heatId: string,
  initialPilotSlotIndex: number,
  raceId?: string
): void {
  if (activeLapEditorCleanup) {
    activeLapEditorCleanup();
  }

  let selectedPilotSlot = initialPilotSlotIndex;
  const defaultSfGateId =
    store.nodes.find((n) => n.role === "START_FINISH")?.gateId ?? store.nodes[0]?.gateId ?? 1;
  let selectedGateId = defaultSfGateId;
  let selectedCrossingId: number | null = null;
  let addMode = false;
  let customX: { minMs: number; maxMs: number } | null = null;
  let customY: { minDbm: number; maxDbm: number } | null = null;
  let panAnimFrame = 0;
  let draftCrossings: HeatCrossing[] | null = null;
  const draftThresholdsByGate = new Map<
    number,
    { enterDb: number; exitDb: number; hwMode: TimingHardwareMode }
  >();
  let nextDraftCrossingId = -1;
  let isSaving = false;

  const hasUnsavedChanges = (): boolean =>
    draftCrossings !== null || draftThresholdsByGate.size > 0;

  const ensureDraftCrossings = (heat: RaceHeat, seat: HeatSeat): HeatCrossing[] => {
    if (!draftCrossings) {
      draftCrossings = extractRawCrossings(heat, seat).map((c) => ({ ...c }));
    }
    return draftCrossings;
  };

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
  backdrop.setAttribute("aria-label", "Lap Timings & RSSI Gate Crossing Editor");

  const resolveRace = (): RaceTournamentState | undefined => {
    const races = store.races ?? [];
    if (raceId) {
      const exact = races.find((r) => r.raceId === raceId);
      if (exact) return exact;
    }
    const containing = races.find((r) => (r.heats ?? []).some((h) => h.id === heatId));
    return containing ?? store.raceState;
  };

  const getHeatAndSeat = (): {
    race: RaceTournamentState | undefined;
    heat: RaceHeat | undefined;
    seat: HeatSeat | undefined;
  } => {
    const race = resolveRace();
    const heat = (race?.heats ?? []).find((h) => h.id === heatId);
    if (!heat) return { race, heat: undefined, seat: undefined };
    const occupied = (heat.seats ?? []).filter((s) => s.pilotSlotIndex > 0);
    let seat = occupied.find((s) => s.pilotSlotIndex === selectedPilotSlot);
    if (!seat && occupied.length > 0) {
      seat = occupied[0];
      selectedPilotSlot = seat.pilotSlotIndex;
    }
    return { race, heat, seat };
  };

  const getSeatHardwareMode = (heat: RaceHeat, seat: HeatSeat): TimingHardwareMode => {
    if (
      isRotorHazardMode(heat.hardwareMode) ||
      heat.hardwareMode === "laprf" ||
      (heat.hardwareMode && isSlapRFMode(heat.hardwareMode))
    ) {
      return heat.hardwareMode;
    }
    const en = seat.enterRssiDbm ?? 0;
    if (en < 0) return "slaprf";
    if (en > 260) return "laprf";
    if (en > 0 && en <= 255) return isRotorHazardMode(store.timingHardwareMode) ? store.timingHardwareMode : "rotorhazard";
    if (seat.rssiTrace && seat.rssiTrace.length > 0) {
      if (seat.rssiTrace.some((pt) => pt.r < 0)) return "slaprf";
      if (seat.rssiTrace.some((pt) => pt.r > 260)) return "laprf";
      if (seat.rssiTrace.some((pt) => pt.r > 0 && pt.r <= 255)) {
        return isRotorHazardMode(store.timingHardwareMode) ? store.timingHardwareMode : "rotorhazard";
      }
    }
    return store.timingHardwareMode;
  };

  const getGateThresholds = (
    heat: RaceHeat,
    seat: HeatSeat
  ): { enterDb: number; exitDb: number; hwMode: TimingHardwareMode } => {
    const hwMode = getSeatHardwareMode(heat, seat);
    const drafted = draftThresholdsByGate.get(selectedGateId);
    const hasNode = Boolean(store.node(selectedGateId));
    const sfId = store.nodes.find((n) => n.role === "START_FINISH")?.gateId ?? store.nodes[0]?.gateId ?? 1;
    if (hwMode === "laprf") {
      let thr = drafted
        ? drafted.enterDb
        : hasNode && store.timingHardwareMode === "laprf"
          ? laprfThresholdAt(store, selectedGateId, seat.pilotSlotIndex).dbm
          : seat.enterRssiDbm && seat.enterRssiDbm > 260
            ? seat.enterRssiDbm
            : 800;
      if (!drafted && selectedGateId === sfId && !hasNode && seat.enterRssiDbm && seat.enterRssiDbm > 260) {
        thr = seat.enterRssiDbm;
      }
      if (threshDrag) {
        thr = threshDrag.currentDbm;
      }
      return { enterDb: Math.round(thr), exitDb: Math.round(thr), hwMode: "laprf" };
    }
    if (isRotorHazardMode(hwMode)) {
      let enterVal: number;
      let exitVal: number;
      if (drafted) {
        enterVal = drafted.enterDb;
        exitVal = drafted.exitDb;
      } else if (hasNode && isRotorHazardMode(store.timingHardwareMode)) {
        const pair = rhThresholdAt(store, selectedGateId, seat.pilotSlotIndex);
        enterVal = pair.enter;
        exitVal = pair.exit;
      } else {
        enterVal =
          seat.enterRssiDbm && seat.enterRssiDbm > 0 && seat.enterRssiDbm <= 255
            ? seat.enterRssiDbm
            : 95;
        exitVal =
          seat.exitRssiDbm && seat.exitRssiDbm > 0 && seat.exitRssiDbm < enterVal
            ? seat.exitRssiDbm
            : Math.max(6, enterVal - 25);
      }
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
      : hasNode && isSlapRFMode(store.timingHardwareMode)
        ? enterThresholdAt(store, selectedGateId, seat.pilotSlotIndex).dbm
        : seat.enterRssiDbm && seat.enterRssiDbm < 0
          ? seat.enterRssiDbm
          : -58;
    if (!drafted && selectedGateId === sfId && !hasNode && seat.enterRssiDbm && seat.enterRssiDbm < 0) {
      enterDb = seat.enterRssiDbm;
    }
    let exitDb = drafted
      ? drafted.exitDb
      : hasNode && isSlapRFMode(store.timingHardwareMode)
        ? exitThresholdAt(store, selectedGateId, seat.pilotSlotIndex).dbm
        : seat.exitRssiDbm && seat.exitRssiDbm < 0
          ? seat.exitRssiDbm
          : enterDb - 10;
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

  let svgW = DEFAULT_SVG_W;
  const getPlotW = (): number => Math.max(200, svgW - PAD_L - PAD_R);

  let lastDomain = { minMs: -1500, maxMs: 20_000 };
  let lastYDomain = { minDbm: DBM_MIN, maxDbm: DBM_MAX };
  let lastSeatHwMode: TimingHardwareMode = "slaprf";

  const cancelPanAnim = (): void => {
    if (panAnimFrame) {
      cancelAnimationFrame(panAnimFrame);
      panAnimFrame = 0;
    }
  };

  const syncSelectedRowDom = (): void => {
    backdrop.querySelectorAll<HTMLElement>("[data-lap-ed-row]").forEach((tr) => {
      const cid = Number(tr.dataset.lapEdRow || "0");
      tr.classList.toggle("is-selected", selectedCrossingId !== null && cid === selectedCrossingId);
    });
  };

  const scrollCrossingIntoView = (crossingId: number): void => {
    const { race, heat, seat } = getHeatAndSeat();
    if (!heat || !seat) return;
    const { rows } = deriveCrossings(heat, seat, race, draftCrossings);
    const idx = rows.findIndex((r) => r.crossing.crossingId === crossingId);
    if (idx < 0) return;

    selectedCrossingId = crossingId;
    syncSelectedRowDom();

    const endMs = rows[idx].offsetMs;
    let startMs = Math.min(0, endMs - 1500);
    if (idx > 0) {
      let prevRow = rows[idx - 1];
      for (let j = idx - 1; j >= 0; j--) {
        if (!rows[j].crossing.invalidated) {
          prevRow = rows[j];
          break;
        }
      }
      startMs = prevRow.offsetMs;
    }

    const lapSpan = Math.max(2500, endMs - startMs);
    const plotW = getPlotW();
    const maxVisibleLaps = Math.max(1, Math.floor(plotW / 190));
    const trace = seat.rssiTrace ?? [];
    const fullDom = computeFullTimeDomainMs(heat, trace, rows);

    let targetDom: { minMs: number; maxMs: number };
    if (maxVisibleLaps === 1) {
      const pad = Math.max(1400, Math.round(lapSpan * 0.18));
      targetDom = clampXDomain(startMs - pad, endMs + pad);
    } else {
      const defaultVis = computeVisibleTimeDomainMs(heat, trace, rows, plotW);
      const defaultSpan = Math.max(lapSpan * 1.45, defaultVis.maxMs - defaultVis.minMs);
      const curSpan = customX
        ? Math.max(lapSpan * 1.35, lastDomain.maxMs - lastDomain.minMs)
        : defaultSpan;
      const midMs = (startMs + endMs) / 2;
      let lo = midMs - curSpan / 2;
      let hi = midMs + curSpan / 2;
      if (curSpan <= fullDom.maxMs - fullDom.minMs) {
        if (lo < fullDom.minMs) {
          lo = fullDom.minMs;
          hi = lo + curSpan;
        } else if (hi > fullDom.maxMs) {
          hi = fullDom.maxMs;
          lo = hi - curSpan;
        }
      }
      targetDom = clampXDomain(lo, hi);
    }

    cancelPanAnim();
    const wrap = backdrop.querySelector<HTMLElement>("[data-lap-ed-svg-wrap]");
    const isLiveBrowser = Boolean(wrap && wrap.clientWidth > 120);
    const fromMin = lastDomain.minMs;
    const fromMax = lastDomain.maxMs;
    if (
      !isLiveBrowser ||
      typeof requestAnimationFrame === "undefined" ||
      (Math.abs(targetDom.minMs - fromMin) < 40 && Math.abs(targetDom.maxMs - fromMax) < 40)
    ) {
      customX = targetDom;
      refreshSvgOnly();
      return;
    }

    const startTime = performance.now();
    const duration = 200;
    const step = (now: number): void => {
      const t = clamp((now - startTime) / duration, 0, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      customX = {
        minMs: Math.round(fromMin + (targetDom.minMs - fromMin) * ease),
        maxMs: Math.round(fromMax + (targetDom.maxMs - fromMax) * ease),
      };
      refreshSvgOnly();
      if (t < 1) {
        panAnimFrame = requestAnimationFrame(step);
      } else {
        panAnimFrame = 0;
        customX = targetDom;
        refreshSvgOnly();
      }
    };
    panAnimFrame = requestAnimationFrame(step);
  };

  const activeYDomain = (hwMode: TimingHardwareMode): { minDbm: number; maxDbm: number } =>
    customY ??
    (hwMode === "laprf"
      ? { minDbm: LAPRF_Y_MIN, maxDbm: LAPRF_Y_MAX }
      : isRotorHazardMode(hwMode)
        ? { minDbm: RH_Y_MIN, maxDbm: RH_Y_MAX }
        : { minDbm: DBM_MIN, maxDbm: DBM_MAX });

  const dbmToY = (dbm: number): number => {
    const span = Math.max(1, lastYDomain.maxDbm - lastYDomain.minDbm);
    const frac = (lastYDomain.maxDbm - dbm) / span;
    return PAD_T + frac * PLOT_H;
  };

  const yToDbm = (svgY: number): number => {
    const clampedY = clamp(svgY, PAD_T, PAD_T + PLOT_H);
    const frac = (clampedY - PAD_T) / PLOT_H;
    return Math.round(lastYDomain.maxDbm - frac * (lastYDomain.maxDbm - lastYDomain.minDbm));
  };

  const clientToSvgCoords = (svgEl: SVGSVGElement, clientX: number, clientY: number): { svgX: number; svgY: number } => {
    const rect = svgEl.getBoundingClientRect();
    const svgX = rect.width > 0 ? ((clientX - rect.left) / rect.width) * svgW : PAD_L;
    const svgY = rect.height > 0 ? ((clientY - rect.top) / rect.height) * SVG_H : PAD_T;
    return { svgX, svgY };
  };

  const clientYToDbm = (svgEl: SVGSVGElement, clientY: number): number => {
    const { svgY } = clientToSvgCoords(svgEl, 0, clientY);
    return yToDbm(svgY);
  };

  const msToX = (ms: number): number => {
    const span = Math.max(1, lastDomain.maxMs - lastDomain.minMs);
    return PAD_L + ((ms - lastDomain.minMs) / span) * getPlotW();
  };

  const clientXToMs = (svgEl: SVGSVGElement, clientX: number): number => {
    const plotW = getPlotW();
    const { svgX } = clientToSvgCoords(svgEl, clientX, 0);
    const clampedX = clamp(svgX, PAD_L, PAD_L + plotW);
    const frac = (clampedX - PAD_L) / plotW;
    return Math.round(lastDomain.minMs + frac * (lastDomain.maxMs - lastDomain.minMs));
  };

  const ySpanBounds = (hwMode: TimingHardwareMode): { minSpan: number; maxSpan: number; absLo: number; absHi: number } => {
    if (hwMode === "laprf") {
      return { minSpan: LAPRF_MIN_Y_SPAN, maxSpan: LAPRF_MAX_Y_SPAN, absLo: LAPRF_ABS_MIN, absHi: LAPRF_ABS_MAX };
    }
    if (isRotorHazardMode(hwMode)) {
      return { minSpan: RH_MIN_Y_SPAN, maxSpan: RH_MAX_Y_SPAN, absLo: RH_ABS_MIN, absHi: RH_ABS_MAX };
    }
    return { minSpan: MIN_Y_SPAN_DB, maxSpan: MAX_Y_SPAN_DB, absLo: DBM_ABS_MIN, absHi: DBM_ABS_MAX };
  };

  const clampYDomain = (minDbm: number, maxDbm: number): { minDbm: number; maxDbm: number } => {
    const { minSpan, maxSpan, absLo, absHi } = ySpanBounds(lastSeatHwMode);
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

  const clampXDomain = (minMs: number, maxMs: number): { minMs: number; maxMs: number } => {
    const span = clamp(maxMs - minMs, MIN_X_SPAN_MS, MAX_X_SPAN_MS);
    const lo = clamp(minMs, -60_000, 600_000);
    return { minMs: Math.round(lo), maxMs: Math.round(lo + span) };
  };

  const syncResetViewBtn = (): void => {
    const btn = backdrop.querySelector<HTMLButtonElement>("[data-lap-ed-reset-view]");
    if (!btn) return;
    const hasCustom = Boolean(customX || customY);
    btn.hidden = !hasCustom;
  };

  const sampleTraceAtMs = (trace: HeatRssiSample[], ms: number): number | null => {
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
    return bestDist <= 600 ? trace[bestIdx].r : null;
  };

  const renderGraphSvg = (heat: RaceHeat, seat: HeatSeat, rows: DerivedCrossingRow[]): string => {
    const plotW = getPlotW();
    const trace = seat.rssiTrace ?? [];
    const { enterDb, exitDb, hwMode } = getGateThresholds(heat, seat);
    if (lastSeatHwMode !== hwMode) {
      lastSeatHwMode = hwMode;
      customY = null;
    }
    const autoDom = computeVisibleTimeDomainMs(heat, trace, rows, plotW);
    lastDomain = customX ?? autoDom;
    lastYDomain = activeYDomain(hwMode);
    const spanMs = Math.max(1, lastDomain.maxMs - lastDomain.minMs);
    const ySpan = Math.max(1, lastYDomain.maxDbm - lastYDomain.minDbm);
    const locked = heat.state === "confirmed";

    // Dynamic Y gridlines
    const yStep =
      hwMode === "laprf"
        ? ySpan <= 600
          ? 100
          : ySpan <= 1500
            ? 250
            : 500
        : isRotorHazardMode(hwMode)
          ? ySpan <= 50
            ? 10
            : ySpan <= 120
              ? 25
              : 50
          : ySpan <= 24
            ? 5
            : ySpan <= 52
              ? 10
              : 15;
    const firstYDb = Math.ceil(lastYDomain.minDbm / yStep) * yStep;
    const yTicks: string[] = [];
    for (let db = firstYDb; db <= lastYDomain.maxDbm; db += yStep) {
      const yNum = dbmToY(db);
      if (yNum < PAD_T + 2 || yNum > SVG_H - PAD_B - 2) continue;
      const y = yNum.toFixed(1);
      yTicks.push(`
        <line x1="${PAD_L}" y1="${y}" x2="${svgW - PAD_R}" y2="${y}" class="lap-ed-grid-line" />
        <text x="${PAD_L - 6}" y="${(yNum + 3.5).toFixed(1)}" class="lap-ed-axis-lbl" text-anchor="end">${db}</text>`);
    }

    // Dynamic X time ticks
    const stepMs =
      spanMs <= 3000
        ? 250
        : spanMs <= 7000
          ? 500
          : spanMs <= 14_000
            ? 1000
            : spanMs <= 24_000
              ? 2000
              : spanMs <= 50_000
                ? 5000
                : spanMs <= 120_000
                  ? 10_000
                  : 20_000;
    const firstTick = Math.ceil(lastDomain.minMs / stepMs) * stepMs;
    const xTicks: string[] = [];
    for (let t = firstTick; t <= lastDomain.maxMs; t += stepMs) {
      const xNum = msToX(t);
      if (xNum < PAD_L || xNum > svgW - PAD_R) continue;
      const x = xNum.toFixed(1);
      const decimals = stepMs < 500 ? 2 : t % 1000 === 0 && stepMs >= 1000 ? 0 : 1;
      const secLbl = `${(t / 1000).toFixed(decimals)}s`;
      xTicks.push(`
        <line x1="${x}" y1="${PAD_T}" x2="${x}" y2="${SVG_H - PAD_B}" class="lap-ed-grid-line is-vert" />
        <text x="${x}" y="${SVG_H - 8}" class="lap-ed-axis-lbl" text-anchor="middle">${secLbl}</text>`);
    }

    // Threshold line(s): single Threshold in LapRF mode, Enter & Exit in SlapRF and RotorHazard modes
    const enterY = dbmToY(enterDb);
    const exitY = dbmToY(exitDb);
    const enterVisible = enterY >= PAD_T - 2 && enterY <= SVG_H - PAD_B + 2;
    const exitVisible = hwMode !== "laprf" && exitY >= PAD_T - 2 && exitY <= SVG_H - PAD_B + 2;
    const enterYf = enterY.toFixed(1);
    const exitYf = exitY.toFixed(1);
    const canDragThresh =
      !store.isHistoricalTrack &&
      Boolean(store.node(selectedGateId)) &&
      (store.timingHardwareMode === hwMode ||
        (isSlapRFMode(store.timingHardwareMode) && isSlapRFMode(hwMode)) ||
        (isRotorHazardMode(store.timingHardwareMode) && isRotorHazardMode(hwMode)));
    const enterLbl =
      hwMode === "laprf"
        ? `Thresh ${enterDb}`
        : isRotorHazardMode(hwMode)
          ? `Enter ${enterDb}`
          : `Enter ${enterDb} dBm`;
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
          ? `<g class="lap-ed-thresh-group is-enter ${canDragThresh ? "is-draggable" : ""} ${threshDrag?.kind === "enter" ? "is-dragging" : ""}" ${canDragThresh ? 'data-thresh-handle="enter"' : ""}>
              <line x1="${PAD_L}" y1="${enterYf}" x2="${svgW - PAD_R}" y2="${enterYf}" class="lap-ed-thresh-line is-enter" />
              ${canDragThresh ? `<line x1="${PAD_L}" y1="${enterYf}" x2="${svgW - PAD_R}" y2="${enterYf}" class="lap-ed-thresh-hit" />` : ""}
              <rect x="${enterPillX.toFixed(1)}" y="${(enterY - 8.5).toFixed(1)}" width="${enterPillW.toFixed(1)}" height="17" rx="4" class="lap-ed-thresh-pill is-enter" />
              <text x="${(enterPillX + enterPillW / 2).toFixed(1)}" y="${(enterY + 3.4).toFixed(1)}" class="lap-ed-thresh-lbl is-enter" text-anchor="middle">${enterLbl}</text>
            </g>`
          : ""
      }
      ${
        exitVisible
          ? `<g class="lap-ed-thresh-group is-exit ${canDragThresh ? "is-draggable" : ""} ${threshDrag?.kind === "exit" ? "is-dragging" : ""}" ${canDragThresh ? 'data-thresh-handle="exit"' : ""}>
              <line x1="${PAD_L}" y1="${exitYf}" x2="${svgW - PAD_R}" y2="${exitYf}" class="lap-ed-thresh-line is-exit" />
              ${canDragThresh ? `<line x1="${PAD_L}" y1="${exitYf}" x2="${svgW - PAD_R}" y2="${exitYf}" class="lap-ed-thresh-hit" />` : ""}
              <rect x="${exitPillX.toFixed(1)}" y="${(exitY - 8.5).toFixed(1)}" width="${exitPillW.toFixed(1)}" height="17" rx="4" class="lap-ed-thresh-pill is-exit" />
              <text x="${(exitPillX + exitPillW / 2).toFixed(1)}" y="${(exitY + 3.4).toFixed(1)}" class="lap-ed-thresh-lbl is-exit" text-anchor="middle">${exitLbl}</text>
            </g>`
          : ""
      }`;

    // Start horn line at t = 0
    let hornHtml = "";
    if (lastDomain.minMs <= 0 && lastDomain.maxMs >= 0) {
      const hx = msToX(0).toFixed(1);
      hornHtml = `
        <line x1="${hx}" y1="${PAD_T}" x2="${hx}" y2="${SVG_H - PAD_B}" class="lap-ed-horn-line" />
        <text x="${(Number(hx) + 4).toFixed(1)}" y="${PAD_T + 11}" class="lap-ed-horn-lbl">HORN 0.0s</text>`;
    }

    // RSSI waveform path (or synthetic crossing pulses if heat predates live RSSI capture)
    let waveHtml = "";
    if (trace.length >= 2) {
      const pts = trace.map((p) => `${msToX(p.t).toFixed(1)},${dbmToY(p.r).toFixed(1)}`);
      const xFirst = msToX(trace[0].t).toFixed(1);
      const xLast = msToX(trace[trace.length - 1].t).toFixed(1);
      const baseY = (SVG_H - PAD_B + 4).toFixed(1);
      const areaD = `M ${xFirst},${baseY} L ${pts.join(" L ")} L ${xLast},${baseY} Z`;
      const lineD = `M ${pts.join(" L ")}`;
      waveHtml = `
        <path d="${areaD}" class="lap-ed-rssi-area" />
        <path d="${lineD}" class="lap-ed-rssi-line" />`;
    } else if (rows.length > 0) {
      const synPts: string[] = [];
      const steps = 180;
      const baseFloor = hwMode === "laprf" ? 360 : isRotorHazardMode(hwMode) ? 22 : -90;
      const defaultPeak = hwMode === "laprf" ? 2100 : isRotorHazardMode(hwMode) ? 185 : -44;
      for (let i = 0; i <= steps; i++) {
        const ms = lastDomain.minMs + (i / steps) * spanMs;
        let db = baseFloor;
        for (const r of rows) {
          const effMs =
            dragState && dragState.crossingId === r.crossing.crossingId
              ? dragState.currentOffsetMs
              : r.offsetMs;
          const dist = Math.abs(ms - effMs);
          if (dist < 900) {
            const pk = r.peakDbm ?? defaultPeak;
            const g = Math.exp(-(dist * dist) / (2 * 180 * 180));
            db = Math.max(db, baseFloor + (pk - baseFloor) * g);
          }
        }
        synPts.push(`${msToX(ms).toFixed(1)},${dbmToY(db).toFixed(1)}`);
      }
      waveHtml = `<path d="M ${synPts.join(" L ")}" class="lap-ed-rssi-line is-synthetic" />`;
    } else {
      waveHtml = `<text x="${PAD_L + plotW / 2}" y="${PAD_T + PLOT_H / 2}" class="lap-ed-empty-svg" text-anchor="middle">No RSSI trace recorded yet — double-click or use "+ Add Crossing" to place a manual crossing</text>`;
    }

    // Crossing pins (only render pins visible within current X window)
    const pinsHtml = rows
      .map((r) => {
        const effMs =
          dragState && dragState.crossingId === r.crossing.crossingId
            ? dragState.currentOffsetMs
            : r.offsetMs;
        const rawX = msToX(effMs);
        const isDragging = Boolean(dragState && dragState.crossingId === r.crossing.crossingId);
        const isSelected = selectedCrossingId !== null && r.crossing.crossingId === selectedCrossingId;
        if (!isDragging && (rawX < PAD_L - 2 || rawX > svgW - PAD_R + 2)) {
          return "";
        }
        const x = clamp(rawX, PAD_L, svgW - PAD_R);
        const xf = x.toFixed(1);
        const inv = Boolean(r.crossing.invalidated);
        const cls = [
          "lap-ed-pin",
          inv ? "is-invalid" : r.isHoleshot ? "is-holeshot" : "",
          !inv && r.isBestLap ? "is-best" : "",
          !inv && r.isBestConsec ? "is-best-consec" : "",
          r.crossing.manual ? "is-manual" : "",
          isSelected ? "is-selected" : "",
          isDragging ? "is-dragging" : "",
          locked ? "is-locked" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const subTime = isDragging
          ? fmtOffsetSec(effMs)
          : r.splitSec !== null && !r.isHoleshot
            ? `${r.splitSec.toFixed(2)}s`
            : fmtOffsetSec(effMs);
        const tagText = `${r.label} · ${subTime}`;
        const pillW = Math.max(54, tagText.length * 6.5 + 14);
        const pillX = clamp(x - pillW / 2, PAD_L, svgW - PAD_R - pillW);
        return `
          <g class="${cls}" data-crossing-pin="${r.crossing.crossingId}">
            <line x1="${xf}" y1="${PAD_T}" x2="${xf}" y2="${SVG_H - PAD_B}" class="lap-ed-pin-line" />
            <line x1="${xf}" y1="${PAD_T}" x2="${xf}" y2="${SVG_H - PAD_B}" class="lap-ed-pin-hit" />
            <rect x="${pillX.toFixed(1)}" y="4" width="${pillW.toFixed(1)}" height="18" rx="5" class="lap-ed-pin-pill" />
            <text x="${(pillX + pillW / 2).toFixed(1)}" y="16.5" text-anchor="middle" class="lap-ed-pin-lbl">${esc(tagText)}</text>
          </g>`;
      })
      .join("");

    // Hover cursor guide
    let hoverHtml = "";
    if (hoverInfo && !dragState && !threshDrag && !viewDrag) {
      const hx = clamp(msToX(hoverInfo.offsetMs), PAD_L, svgW - PAD_R).toFixed(1);
      const hLbl = `${fmtOffsetSec(hoverInfo.offsetMs)}${hoverInfo.dbm !== null ? ` · ${hoverInfo.dbm}${isSlapRFMode(hwMode) ? " dBm" : ""}` : ""}${addMode ? " (Click to add)" : ""}`;
      hoverHtml = `
        <g class="lap-ed-hover-guide ${addMode ? "is-add" : ""}" pointer-events="none">
          <line x1="${hx}" y1="${PAD_T}" x2="${hx}" y2="${SVG_H - PAD_B}" class="lap-ed-hover-line" />
          <text x="${clamp(Number(hx) + 6, PAD_L + 4, svgW - PAD_R - 120).toFixed(1)}" y="${SVG_H - PAD_B - 6}" class="lap-ed-hover-lbl">${esc(hLbl)}</text>
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
      <svg class="${svgStateCls}" viewBox="0 0 ${svgW} ${SVG_H}" data-lap-ed-svg>
        <defs>
          <linearGradient id="lapEdRssiGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.34" />
            <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.02" />
          </linearGradient>
          <clipPath id="lapEdPlotClip">
            <rect x="${PAD_L}" y="${PAD_T}" width="${plotW}" height="${PLOT_H}" rx="4" />
          </clipPath>
        </defs>
        <rect x="${PAD_L}" y="${PAD_T}" width="${plotW}" height="${PLOT_H}" rx="4" class="lap-ed-plot-bg" />
        ${yTicks.join("")}
        ${xTicks.join("")}
        <g clip-path="url(#lapEdPlotClip)">
          ${hornHtml}
          ${waveHtml}
        </g>
        ${threshHtml}
        ${hoverHtml}
        ${pinsHtml}
        <rect x="0" y="${PAD_T}" width="${PAD_L}" height="${PLOT_H}" fill="transparent" class="lap-ed-y-axis-hit" data-axis-drag="y"><title>Drag vertically to scale Y axis (double-click to reset)</title></rect>
        <rect x="${PAD_L}" y="${SVG_H - PAD_B}" width="${plotW}" height="${PAD_B}" fill="transparent" class="lap-ed-x-axis-hit" data-axis-drag="x"><title>Drag horizontally to scale X axis (double-click to reset)</title></rect>
      </svg>`;
  };

  let lastTableSig = "";
  let lastTraceSig = "";

  const computeSigs = (
    heat: RaceHeat,
    seat: HeatSeat,
    summary: DerivedCrossingsSummary
  ): { tableSig: string; traceSig: string } => {
    const occupied = heat.seats.filter((s) => s.pilotSlotIndex > 0);
    const { enterDb, exitDb, hwMode } = getGateThresholds(heat, seat);
    const gatesSig = store.nodes.map((g) => `${g.gateId}:${gateLabel(store, g.gateId)}`).join(",");
    const pilotsSig = occupied
      .map((s) => `${s.pilotSlotIndex}:${s.callsign}:${s.color || ""}:${s.band}:${s.channel}:${s.lapsCompleted}`)
      .join("|");
    const rowsSig = summary.rows
      .map(
        (r) =>
          `${r.crossing.crossingId}:${r.label}:${r.offsetMs}:${r.splitSec ?? ""}:${r.isBestLap ? 1 : 0}:${r.isBestConsec ? 1 : 0}:${r.isExtra ? 1 : 0}:${r.peakDbm ?? ""}:${r.crossing.invalidated ? 1 : 0}:${r.crossing.manual ? 1 : 0}`
      )
      .join(";");
    const tableSig = [
      heat.id,
      heat.title,
      heat.state,
      heat.canUnlock ? 1 : 0,
      heat.targetLaps,
      heat.startMode,
      selectedPilotSlot,
      selectedGateId,
      addMode ? 1 : 0,
      hasUnsavedChanges() ? 1 : 0,
      isSaving ? 1 : 0,
      enterDb,
      exitDb,
      hwMode,
      seat.band,
      seat.channel,
      seat.frequencyMhz || 0,
      seat.status,
      seat.statusOverridden ? 1 : 0,
      seat.lapsCompleted,
      (seat.holeshotSec ?? 0).toFixed(3),
      (seat.bestLapSec ?? 0).toFixed(3),
      (seat.totalTimeSec ?? 0).toFixed(3),
      (seat.penaltySec ?? 0).toFixed(3),
      summary.consecWindow,
      summary.bestConsecSec !== null ? summary.bestConsecSec.toFixed(3) : "",
      gatesSig,
      pilotsSig,
      rowsSig,
    ].join("#");

    const trace = seat.rssiTrace ?? [];
    const lastPt = trace.length > 0 ? trace[trace.length - 1] : undefined;
    const traceSig = `${trace.length}:${lastPt ? `${lastPt.t}:${lastPt.r}` : ""}:${Math.round((heat.elapsedSec || 0) * 10)}`;
    return { tableSig, traceSig };
  };

  const renderModal = (resetScroll = false): void => {
    const { race, heat, seat } = getHeatAndSeat();
    if (!heat || !seat) {
      close();
      return;
    }
    const prevSvgWrap = backdrop.querySelector<HTMLElement>("[data-lap-ed-svg-wrap]");
    if (prevSvgWrap && prevSvgWrap.clientWidth > 120) {
      svgW = Math.round(prevSvgWrap.clientWidth);
    }
    const prevTableWrap = backdrop.querySelector<HTMLElement>(".lap-ed-table-wrap");
    const prevBody = backdrop.querySelector<HTMLElement>(".lap-ed-body");
    const savedTableScrollTop = !resetScroll && prevTableWrap ? prevTableWrap.scrollTop : 0;
    const savedTableScrollLeft = !resetScroll && prevTableWrap ? prevTableWrap.scrollLeft : 0;
    const savedBodyScrollTop = !resetScroll && prevBody ? prevBody.scrollTop : 0;

    const locked = heat.state === "confirmed";
    const summary = deriveCrossings(heat, seat, race, draftCrossings);
    const { rows, bestConsecSec, consecWindow } = summary;
    const sigs = computeSigs(heat, seat, summary);
    lastTableSig = sigs.tableSig;
    lastTraceSig = sigs.traceSig;
    const chLabel = seat.channel > 0 ? bandChannelShort(seat.band, seat.channel) : "—";
    const { enterDb, exitDb, hwMode } = getGateThresholds(heat, seat);
    const gateChipsHtml =
      store.nodes.length > 1
        ? `<div class="lap-ed-gate-pills">${store.nodes
            .map((g) => {
              const gActive = g.gateId === selectedGateId;
              const gLbl = gateLabel(store, g.gateId);
              return `<button type="button" class="btn ${gActive ? "btn-armed" : "btn-ghost"} btn-xs" data-lap-ed-gate="${g.gateId}" title="Inspect/adjust thresholds for ${esc(gLbl)}">${esc(gLbl)}</button>`;
            })
            .join("")}</div>`
        : "";

    const effLapsCompleted = draftCrossings !== null ? summary.countedLaps : seat.lapsCompleted;
    const lapsTargetStr =
      heat.targetLaps > 0 ? `${effLapsCompleted}/${heat.targetLaps}` : `${effLapsCompleted}`;
    const bestVal = draftCrossings !== null ? (summary.bestLapSec ?? 0) : (seat.bestLapSec ?? 0);
    const hsVal = draftCrossings !== null ? (summary.holeshotSec ?? 0) : (seat.holeshotSec ?? 0);
    const totalVal = draftCrossings !== null ? (summary.totalTimeSec ?? 0) : (seat.totalTimeSec ?? 0);
    const penVal = seat.penaltySec ?? 0;
    const bestStr = bestVal > 0 ? `${bestVal.toFixed(2)}s` : "—";
    const bestConsecStr = bestConsecSec !== null && bestConsecSec > 0 ? `${bestConsecSec.toFixed(2)}s` : "—";
    const hsStr =
      rows.some((r) => r.isHoleshot) && heat.startMode === "heads_up"
        ? `${hsVal.toFixed(2)}s`
        : "—";
    const totalStr =
      totalVal > 0
        ? `${totalVal.toFixed(2)}s${penVal > 0 ? ` (+${penVal}s)` : ""}`
        : "—";

    const tableRowsHtml =
      rows.length === 0
        ? `<tr><td colspan="6" class="muted" style="text-align:center; padding: 18px 12px;">No gate crossings recorded for ${esc(seat.callsign)} yet. Click <strong>Add Crossing</strong> above or double-click an RSSI peak to add one.</td></tr>`
        : rows
            .map((r) => {
              const inv = Boolean(r.crossing.invalidated);
              const isSelectedRow =
                selectedCrossingId !== null && r.crossing.crossingId === selectedCrossingId;
              const splitCell = inv
                ? `<span class="muted">Ignored</span>`
                : r.isHoleshot
                  ? `<span class="lap-ed-num mono muted">${r.splitSec !== null ? `${r.splitSec.toFixed(2)}s` : "0.00s"}</span>`
                  : r.splitSec !== null
                    ? `${r.isBestLap ? "🔥 " : ""}<span class="lap-ed-num mono ${r.isBestConsec ? "is-best-consec-time" : ""} ${r.isExtra ? "muted" : ""}" ${r.isExtra ? 'title="Extra pass recorded after target laps completed"' : ""}>${r.splitSec.toFixed(2)}s</span>`
                    : "—";
              const rssiCell =
                r.peakDbm !== null
                  ? `<span class="lap-ed-num mono">${r.peakDbm}<span class="lap-ed-rssi-unit">${isSlapRFMode(hwMode) ? " dBm" : ""}</span></span>`
                  : `<span class="muted">—</span>`;
              const srcCell = r.crossing.manual
                ? `<span class="muted">Manual</span>`
                : `<span class="muted">Timer</span>`;
              return `
                <tr class="lap-ed-row ${inv ? "is-invalid-row" : ""} ${r.isExtra ? "is-extra-row" : ""} ${isSelectedRow ? "is-selected" : ""}" data-lap-ed-row="${r.crossing.crossingId}">
                  <td class="lap-ed-num mono lap-ed-col-pass" ${r.isExtra ? 'title="Extra pass recorded after target laps completed"' : ""}>${esc(r.label)}</td>
                  <td class="lap-ed-num mono lap-ed-col-gate">${fmtOffsetSec(r.offsetMs)}</td>
                  <td class="lap-ed-col-split">${splitCell}</td>
                  <td class="lap-ed-col-rssi">${rssiCell}</td>
                  <td class="lap-ed-col-src">${srcCell}</td>
                  <td class="lap-ed-col-act">
                    ${
                      r.isHoleshot
                        ? `<span class="muted">—</span>`
                        : `<button type="button" class="btn btn-ghost lap-ed-act-btn" data-lap-ed-toggle="${r.crossing.crossingId}" ${locked ? "disabled" : ""} title="${inv ? "Restore crossing" : "Cross out crossing"}" aria-label="${inv ? "Restore crossing" : "Cross out crossing"}">
                            ${inv ? icons.reset(16) : icons.ban(16)}
                          </button>
                          <button type="button" class="btn btn-ghost lap-ed-act-btn lap-ed-del-btn" data-lap-ed-delete="${r.crossing.crossingId}" ${locked ? "disabled" : ""} title="Delete crossing" aria-label="Delete crossing">
                            ${icons.trash(16)}
                          </button>`
                    }
                  </td>
                </tr>`;
            })
            .join("");

    const hasCustomView = Boolean(customX || customY);
    const isDirty = hasUnsavedChanges();
    const heatAcronym = (() => {
      if (heat.shortLabel && heat.shortLabel.trim()) {
        return heat.shortLabel.trim();
      }
      const m = heat.title.match(/^([A-Za-z]+)\s*(\d+)\s*[·\-:]+\s*Heat\s*(\d+)/i);
      if (m) {
        return `${m[1][0].toUpperCase()}${m[2]}-${m[3]}`;
      }
      return heat.id || heat.title;
    })();

    backdrop.innerHTML = `
      <div class="slaprf-modal card rc-modal-xl lap-editor-modal" role="document">
        <div class="slaprf-modal-head">
          <div class="slaprf-modal-title-row">
            <h3>
              <span class="lap-ed-title-pilot">
                <span class="dot" style="background:${esc(seat.color || "#38bdf8")}"></span>
                <span>${esc(seat.callsign)}</span>
              </span>
              <span class="lap-ed-title-sep">-</span>
              <span>${esc(heatAcronym)} Review</span>
            </h3>
          </div>
          <button type="button" class="btn btn-ghost btn-xs lap-ed-desktop-close-btn" data-lap-ed-close aria-label="Close">
            ${icons.close(15)}
          </button>
        </div>
        <div class="slaprf-modal-body lap-ed-body">
          <div class="lap-ed-metrics-strip">
            <div class="lap-ed-metric"><span class="lap-ed-metric-lbl">Channel</span><span class="lap-ed-metric-val mono">${esc(chLabel)}<span class="lap-ed-lbl-full"> · ${seat.frequencyMhz || "—"} MHz</span></span></div>
            <div class="lap-ed-metric"><span class="lap-ed-metric-lbl">Laps</span><span class="lap-ed-metric-val mono">${lapsTargetStr}</span></div>
            <div class="lap-ed-metric"><span class="lap-ed-metric-lbl"><span class="lap-ed-lbl-full">Best ${consecWindow}-Lap</span><span class="lap-ed-lbl-short">Best ${consecWindow}C</span></span><span class="lap-ed-metric-val mono">${bestConsecStr}</span></div>
            <div class="lap-ed-metric"><span class="lap-ed-metric-lbl">Best Lap</span><span class="lap-ed-metric-val mono">${bestStr}</span></div>
            <div class="lap-ed-metric"><span class="lap-ed-metric-lbl">Holeshot</span><span class="lap-ed-metric-val mono">${hsStr}</span></div>
            <div class="lap-ed-metric"><span class="lap-ed-metric-lbl"><span class="lap-ed-lbl-full">Total Time</span><span class="lap-ed-lbl-short">Total</span></span><span class="lap-ed-metric-val mono">${totalStr}</span></div>
            <div class="lap-ed-metric is-thresh-metric"><span class="lap-ed-metric-lbl">${hwMode === "laprf" ? "Threshold" : "Enter / Exit"}</span><span class="lap-ed-metric-val mono">${hwMode === "laprf" ? `${enterDb}` : isRotorHazardMode(hwMode) ? `${enterDb} / ${exitDb}` : `${enterDb} / ${exitDb} dBm`}</span></div>
          </div>

          ${
            locked
              ? `<div class="lap-ed-locked-note" style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
                  <span>This heat is <strong>Confirmed</strong> (read-only). Switch its status to <strong>Review</strong> to edit crossings or laps.</span>
                  <button type="button" class="btn btn-ghost btn-xs" data-lap-ed-unlock>
                    ${icons.unlock(13)}<span>Switch to Review</span>
                  </button>
                </div>`
              : ""
          }

          <div class="lap-ed-controls-strip">
            <div class="lap-ed-controls-left">${gateChipsHtml}</div>
            <div class="lap-ed-controls-right" role="group" aria-label="Crossing actions">
              <button type="button" class="btn btn-ghost btn-xs" data-lap-ed-reset-view ${hasCustomView ? "" : "hidden"} title="Reset zoom and axis scales">
                ${icons.maximize(13)}<span>Reset View</span>
              </button>
              <button type="button" class="btn ${addMode ? "btn-armed" : "btn-ghost"} btn-xs" data-lap-ed-add-mode ${locked ? "disabled" : ""} title="Click a point on the RSSI graph to insert a gate crossing">
                ${icons.plus(13)}<span>${addMode ? "Click Graph to Drop…" : "Add Crossing"}</span>
              </button>
              <button type="button" class="btn btn-ghost btn-xs" data-lap-ed-add-end ${locked ? "disabled" : ""} title="Append synthetic lap crossing at the end">
                ${icons.plus(13)}<span>Append Lap</span>
              </button>
            </div>
          </div>

          <div class="lap-ed-graph-card">
            <div class="lap-ed-svg-wrap" data-lap-ed-svg-wrap>
              ${renderGraphSvg(heat, seat, rows)}
            </div>
            <div class="lap-ed-graph-caption">Drag pins to adjust splits, slide Enter/Exit threshold lines, drag X/Y axes or scroll to zoom &amp; pan, or double-click a spike to add a pass.</div>
          </div>

          <div class="lap-ed-table-wrap">
            <table class="table rc-compact-table lap-ed-table">
              <thead>
                <tr>
                  <th class="lap-ed-col-pass">Pass</th>
                  <th class="lap-ed-col-gate"><span class="lap-ed-lbl-full">Gate Time</span><span class="lap-ed-lbl-short">Gate</span></th>
                  <th class="lap-ed-col-split"><span class="lap-ed-lbl-full">Lap Split</span><span class="lap-ed-lbl-short">Split</span></th>
                  <th class="lap-ed-col-rssi"><span class="lap-ed-lbl-full">Peak RSSI</span><span class="lap-ed-lbl-short">RSSI</span></th>
                  <th class="lap-ed-col-src">Source</th>
                  <th class="lap-ed-col-act" aria-label="Actions"><span class="lap-ed-lbl-full">Actions</span></th>
                </tr>
              </thead>
              <tbody>${tableRowsHtml}</tbody>
            </table>
          </div>
        </div>
        ${
          !locked
            ? `<div class="slaprf-modal-foot lap-ed-save-foot">
                <button type="button" class="btn" data-lap-ed-discard ${isDirty && !isSaving ? "" : "disabled"}>
                  ${icons.close(15)}<span>Discard Changes</span>
                </button>
                <button type="button" class="btn btn-armed" data-lap-ed-save ${isDirty && !isSaving ? "" : "disabled"}>
                  ${icons.check(15)}<span>${isSaving ? "Saving…" : "Save Changes"}</span>
                </button>
              </div>`
            : ""
        }
      </div>
    `;

    const nextTableWrap = backdrop.querySelector<HTMLElement>(".lap-ed-table-wrap");
    if (nextTableWrap) {
      nextTableWrap.scrollTop = savedTableScrollTop;
      nextTableWrap.scrollLeft = savedTableScrollLeft;
    }
    const nextBody = backdrop.querySelector<HTMLElement>(".lap-ed-body");
    if (nextBody) {
      nextBody.scrollTop = savedBodyScrollTop;
    }
  };

  const refreshSvgOnly = (): void => {
    const wrap = backdrop.querySelector<HTMLElement>("[data-lap-ed-svg-wrap]");
    const { race, heat, seat } = getHeatAndSeat();
    if (!wrap || !heat || !seat) return;
    if (wrap.clientWidth > 120) {
      svgW = Math.round(wrap.clientWidth);
    }
    const summary = deriveCrossings(heat, seat, race, draftCrossings);
    lastTraceSig = computeSigs(heat, seat, summary).traceSig;
    wrap.innerHTML = renderGraphSvg(heat, seat, summary.rows);
    syncResetViewBtn();
  };

  const runMarshal = async (payload: Parameters<ApiClient["raceMarshal"]>[0]): Promise<void> => {
    try {
      const { race } = getHeatAndSeat();
      const effective = race?.raceId && !payload.raceId ? { ...payload, raceId: race.raceId } : payload;
      await api.raceMarshal(effective);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), "error");
    }
  };

  const stageAddCrossing = (offsetMs: number): void => {
    const { heat, seat } = getHeatAndSeat();
    if (!heat || !seat) return;
    const draft = ensureDraftCrossings(heat, seat);
    const anchorUs = getAnchorUs(heat, seat, draft.length > 0 ? draft : extractRawCrossings(heat, seat));
    const peak = sampleTraceAtMs(seat.rssiTrace ?? [], offsetMs);
    draft.push({
      crossingId: nextDraftCrossingId--,
      timestampUs: Math.max(1000, anchorUs + offsetMs * 1000),
      peakRssiDbm: peak !== null ? peak : undefined,
      manual: true,
    });
    draft.sort((a, b) => a.timestampUs - b.timestampUs);
    renderModal(false);
  };

  const stageMoveCrossing = (crossingId: number, offsetMs: number): void => {
    const { heat, seat } = getHeatAndSeat();
    if (!heat || !seat) return;
    const draft = ensureDraftCrossings(heat, seat);
    const anchorUs = getAnchorUs(heat, seat, draft);
    const target = draft.find((c) => c.crossingId === crossingId);
    if (!target) return;
    target.timestampUs = Math.max(1000, anchorUs + offsetMs * 1000);
    const peak = sampleTraceAtMs(seat.rssiTrace ?? [], offsetMs);
    if (peak !== null) {
      target.peakRssiDbm = peak;
    }
    target.manual = true;
    draft.sort((a, b) => a.timestampUs - b.timestampUs);
    renderModal(false);
  };

  const stageToggleCrossing = (crossingId: number): void => {
    const { heat, seat } = getHeatAndSeat();
    if (!heat || !seat) return;
    const draft = ensureDraftCrossings(heat, seat);
    const idx = draft.findIndex((c) => c.crossingId === crossingId);
    if (idx <= 0) return;
    draft[idx].invalidated = !draft[idx].invalidated;
    renderModal(false);
  };

  const stageDeleteCrossing = (crossingId: number): void => {
    const { heat, seat } = getHeatAndSeat();
    if (!heat || !seat) return;
    const draft = ensureDraftCrossings(heat, seat);
    const idx = draft.findIndex((c) => c.crossingId === crossingId);
    if (idx <= 0) return;
    draft.splice(idx, 1);
    if (selectedCrossingId === crossingId) {
      selectedCrossingId = null;
    }
    renderModal(false);
  };

  const stageAppendLap = (): void => {
    const { heat, seat } = getHeatAndSeat();
    if (!heat || !seat) return;
    const draft = ensureDraftCrossings(heat, seat);
    const anchorUs = getAnchorUs(heat, seat, draft);
    if (draft.length === 0) {
      const hsUs = anchorUs + 800_000;
      draft.push(
        {
          crossingId: nextDraftCrossingId--,
          timestampUs: hsUs,
          manual: true,
        },
        {
          crossingId: nextDraftCrossingId--,
          timestampUs: hsUs + 12_000_000,
          manual: true,
        }
      );
    } else {
      const lastUs = draft[draft.length - 1].timestampUs;
      draft.push({
        crossingId: nextDraftCrossingId--,
        timestampUs: lastUs + 12_000_000,
        manual: true,
      });
    }
    renderModal(false);
  };

  const discardDraftChanges = (): void => {
    draftCrossings = null;
    draftThresholdsByGate.clear();
    addMode = false;
    renderModal(false);
  };

  const saveDraftChanges = async (): Promise<void> => {
    if (isSaving || !hasUnsavedChanges()) return;
    const { race, heat, seat } = getHeatAndSeat();
    if (!heat || !seat) return;
    isSaving = true;
    renderModal(false);
    try {
      const origRaw = extractRawCrossings(heat, seat);
      const anchorUs = getAnchorUs(heat, seat, origRaw);
      const currentDraft = draftCrossings;
      const currentThresh = Array.from(draftThresholdsByGate.entries());
      draftCrossings = null;
      draftThresholdsByGate.clear();

      if (currentDraft !== null) {
        const draftById = new Map<number, HeatCrossing>();
        for (const c of currentDraft) {
          draftById.set(c.crossingId, c);
        }

        // 1. Delete removed original crossings
        for (const orig of origRaw) {
          if (!draftById.has(orig.crossingId)) {
            await runMarshal({
              raceId: race?.raceId,
              heatId: heat.id,
              pilotSlotIndex: seat.pilotSlotIndex,
              action: "delete_crossing",
              crossingId: orig.crossingId,
            });
          }
        }

        // 2. Move or toggle existing original crossings
        for (const orig of origRaw) {
          const updated = draftById.get(orig.crossingId);
          if (!updated) continue;
          const origMs = Math.round((orig.timestampUs - anchorUs) / 1000);
          const nextMs = Math.round((updated.timestampUs - anchorUs) / 1000);
          if (origMs !== nextMs) {
            await runMarshal({
              raceId: race?.raceId,
              heatId: heat.id,
              pilotSlotIndex: seat.pilotSlotIndex,
              action: "move_crossing",
              crossingId: orig.crossingId,
              offsetMs: nextMs,
            });
          }
          if (Boolean(orig.invalidated) !== Boolean(updated.invalidated)) {
            await runMarshal({
              raceId: race?.raceId,
              heatId: heat.id,
              pilotSlotIndex: seat.pilotSlotIndex,
              action: "toggle_lap",
              crossingId: orig.crossingId,
            });
          }
        }

        // 3. Add newly created crossings
        const origIds = new Set(origRaw.map((c) => c.crossingId));
        for (const added of currentDraft) {
          if (origIds.has(added.crossingId)) continue;
          const nextMs = Math.round((added.timestampUs - anchorUs) / 1000);
          await runMarshal({
            raceId: race?.raceId,
            heatId: heat.id,
            pilotSlotIndex: seat.pilotSlotIndex,
            action: "add_crossing",
            offsetMs: nextMs,
          });
          if (added.invalidated) {
            const latest = getHeatAndSeat();
            const latestRaw =
              latest.heat && latest.seat ? extractRawCrossings(latest.heat, latest.seat) : [];
            const latestAnchor =
              latest.heat && latest.seat ? getAnchorUs(latest.heat, latest.seat, latestRaw) : anchorUs;
            const matched = latestRaw.find(
              (c) =>
                !origIds.has(c.crossingId) &&
                Math.abs(Math.round((c.timestampUs - latestAnchor) / 1000) - nextMs) <= 5
            );
            if (matched) {
              await runMarshal({
                raceId: race?.raceId,
                heatId: heat.id,
                pilotSlotIndex: seat.pilotSlotIndex,
                action: "toggle_lap",
                crossingId: matched.crossingId,
              });
            }
          }
        }
      }

      // 4. Commit any staged threshold changes
      for (const [gateId, thr] of currentThresh) {
        if (!store.node(gateId)) continue;
        if (thr.hwMode === "laprf") {
          await api.setGateThresholds([
            {
              gateId,
              slotIndex: seat.pilotSlotIndex,
              enterDbm: 0,
              laprfThreshold: clamp(thr.enterDb, 300, 3500),
            },
          ]);
        } else if (isRotorHazardMode(thr.hwMode)) {
          await api.setGateThresholds([
            {
              gateId,
              slotIndex: seat.pilotSlotIndex,
              enterDbm: 0,
              rhEnterThreshold: thr.enterDb,
              rhExitThreshold: thr.exitDb,
            },
          ]);
        } else {
          await api.setGateThresholds([
            {
              gateId,
              slotIndex: seat.pilotSlotIndex,
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
      renderModal(false);
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
    if (!target) return;
    const { race, heat, seat } = getHeatAndSeat();
    if (!heat || !seat) return;
    const locked = heat.state === "confirmed";
    const svg = backdrop.querySelector<SVGSVGElement>("[data-lap-ed-svg]");
    if (!svg || !target.closest("[data-lap-ed-svg]")) return;

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
        // Ignore capture failure
      }
      if (touchPts.size >= 2) {
        e.preventDefault();
        cancelPanAnim();
        viewDrag = null;
        threshDrag = null;
        dragState = null;
        hoverInfo = null;
        const [[id1, pt1], [id2, pt2]] = Array.from(touchPts.entries());
        const midSvgX = (pt1.svgX + pt2.svgX) * 0.5;
        const midSvgY = (pt1.svgY + pt2.svgY) * 0.5;
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
          anchorXFrac: clamp((midSvgX - PAD_L) / plotW, 0, 1),
          anchorYFrac: clamp(1 - (midSvgY - PAD_T) / PLOT_H, 0, 1),
        };
        refreshSvgOnly();
        return;
      }
    }

    // 1. Axis scale drag (Y-axis on left, X-axis on bottom) — works even if heat is locked
    const axisEl = target.closest("[data-axis-drag]");
    const axisKind = axisEl?.getAttribute("data-axis-drag");
    if (axisKind === "y" || (svgX < PAD_L && svgY >= PAD_T && svgY <= SVG_H - PAD_B)) {
      e.preventDefault();
      const yFrac = clamp(1 - (svgY - PAD_T) / PLOT_H, 0, 1);
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
      };
      hoverInfo = null;
      try {
        backdrop.setPointerCapture(e.pointerId);
      } catch {
        // Ignore capture failure
      }
      refreshSvgOnly();
      return;
    }

    if (axisKind === "x" || (svgY > SVG_H - PAD_B && svgX >= PAD_L && svgX <= svgW - PAD_R)) {
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
      };
      hoverInfo = null;
      try {
        backdrop.setPointerCapture(e.pointerId);
      } catch {
        // Ignore capture failure
      }
      refreshSvgOnly();
      return;
    }

    // 2. Threshold drag
    const threshHandle = target.closest<SVGGElement>("[data-thresh-handle]");
    if (threshHandle && !addMode && !store.isHistoricalTrack && store.node(selectedGateId)) {
      e.preventDefault();
      const kind = threshHandle.getAttribute("data-thresh-handle") === "exit" ? "exit" : "enter";
      const cur = getGateThresholds(heat, seat);
      threshDrag = {
        kind,
        pointerId: e.pointerId,
        currentDbm: kind === "enter" ? cur.enterDb : cur.exitDb,
      };
      hoverInfo = null;
      try {
        backdrop.setPointerCapture(e.pointerId);
      } catch {
        // Ignore capture failure
      }
      refreshSvgOnly();
      return;
    }

    // 3. Crossing pin drag (when unlocked) or pin select
    const pin = target.closest<SVGGElement>("[data-crossing-pin]");
    if (pin && !addMode) {
      cancelPanAnim();
      const cid = Number(pin.getAttribute("data-crossing-pin") || "0");
      if (cid > 0) {
        selectedCrossingId = cid;
        syncSelectedRowDom();
        const rowEl = backdrop.querySelector<HTMLElement>(`[data-lap-ed-row="${cid}"]`);
        rowEl?.scrollIntoView?.({ block: "nearest" });
      }
      if (!locked) {
        e.preventDefault();
        const { rows } = deriveCrossings(heat, seat, race, draftCrossings);
        const row = rows.find((r) => r.crossing.crossingId === cid);
        if (!row) return;
        dragState = {
          crossingId: cid,
          pointerId: e.pointerId,
          currentOffsetMs: row.offsetMs,
        };
        hoverInfo = null;
        try {
          backdrop.setPointerCapture(e.pointerId);
        } catch {
          // Ignore capture failure
        }
        refreshSvgOnly();
        return;
      }
      refreshSvgOnly();
      return;
    }

    // 4. Add-crossing click mode (when unlocked)
    if (!locked && addMode) {
      e.preventDefault();
      const offsetMs = clientXToMs(svg, e.clientX);
      addMode = false;
      hoverInfo = null;
      stageAddCrossing(offsetMs);
      return;
    }

    // 5. Empty plot area drag -> Pan X & Y smoothly
    if (svgX >= PAD_L && svgX <= svgW - PAD_R && svgY >= PAD_T && svgY <= SVG_H - PAD_B) {
      e.preventDefault();
      cancelPanAnim();
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
      hoverInfo = null;
      try {
        backdrop.setPointerCapture(e.pointerId);
      } catch {
        // Ignore capture failure
      }
      refreshSvgOnly();
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    const svg = backdrop.querySelector<SVGSVGElement>("[data-lap-ed-svg]");
    const { heat, seat } = getHeatAndSeat();
    if (!svg || !heat || !seat) return;

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
          const curMidClientY = (pt1.client.y + pt2.client.y) * 0.5;
          const dyClient = curMidClientY - pinchState.lastMidClientY;
          pinchState.lastMidClientY = curMidClientY;
          const d1y = pt1.client.y - pinchState.p1ClientStart.y;
          const d2y = pt2.client.y - pinchState.p2ClientStart.y;
          const bothMovedSameVert = (d1y > 4 && d2y > 4) || (d1y < -4 && d2y < -4);

          if (
            !pinchState.pinchLocked &&
            (pinchState.pageScrollLocked || (clientPinch.mode === "page-scroll" && bothMovedSameVert))
          ) {
            pinchState.pageScrollLocked = true;
            scrollOuterPageBy(-dyClient, svg);
            return;
          }
          const d0 = Math.hypot(
            pinchState.p2ClientStart.x - pinchState.p1ClientStart.x,
            pinchState.p2ClientStart.y - pinchState.p1ClientStart.y
          );
          const dNow = Math.hypot(pt2.client.x - pt1.client.x, pt2.client.y - pt1.client.y);
          if (Math.abs(dNow - d0) >= 14) {
            pinchState.pinchLocked = true;
          }

          const plotW = getPlotW();
          const pinch = computeDirectionalPinch(pinchState.p1Start, pinchState.p2Start, pt1.px, pt2.px);
          if (pinch.mode === "page-scroll") {
            return;
          }
          if (pinch.mode === "x" || pinch.mode === "xy") {
            const startSpanMs = pinchState.startMaxMs - pinchState.startMinMs;
            const nextSpanMs = clamp(startSpanMs * pinch.xSpanFactor, MIN_X_SPAN_MS, MAX_X_SPAN_MS);
            const anchorMs = pinchState.startMinMs + pinchState.anchorXFrac * startSpanMs;
            const liveXFrac = clamp(((pt1.svgX + pt2.svgX) * 0.5 - PAD_L) / plotW, 0, 1);
            const nextMinMs = anchorMs - liveXFrac * nextSpanMs;
            customX = clampXDomain(nextMinMs, nextMinMs + nextSpanMs);
          }
          if (pinch.mode === "y" || pinch.mode === "xy") {
            const startSpanDb = pinchState.startMaxDbm - pinchState.startMinDbm;
            const { minSpan, maxSpan } = ySpanBounds(lastSeatHwMode);
            const nextSpanDb = clamp(startSpanDb * pinch.ySpanFactor, minSpan, maxSpan);
            const anchorDb = pinchState.startMinDbm + pinchState.anchorYFrac * startSpanDb;
            const liveYFrac = clamp(1 - ((pt1.svgY + pt2.svgY) * 0.5 - PAD_T) / PLOT_H, 0, 1);
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
        const { minSpan, maxSpan } = ySpanBounds(lastSeatHwMode);
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
        const nextSpan = clamp(startSpan * factor, MIN_X_SPAN_MS, MAX_X_SPAN_MS);
        const anchorMs = viewDrag.startMinMs + viewDrag.anchorFrac * startSpan;
        const nextMin = anchorMs - viewDrag.anchorFrac * nextSpan;
        customX = clampXDomain(nextMin, nextMin + nextSpan);
        refreshSvgOnly();
        return;
      }

      // mode === "pan"
      if (Math.abs(dx) >= 1.5 || customX) {
        const spanMs = viewDrag.startMaxMs - viewDrag.startMinMs;
        const deltaMs = -(dx / plotW) * spanMs;
        customX = clampXDomain(viewDrag.startMinMs + deltaMs, viewDrag.startMaxMs + deltaMs);
      }
      if (Math.abs(dy) >= 2.5 || customY) {
        const spanDb = viewDrag.startMaxDbm - viewDrag.startMinDbm;
        const deltaDb = (dy / PLOT_H) * spanDb;
        customY = clampYDomain(viewDrag.startMinDbm + deltaDb, viewDrag.startMaxDbm + deltaDb);
      }
      refreshSvgOnly();
      return;
    }

    if (threshDrag) {
      const rawDbm = clientYToDbm(svg, e.clientY);
      const hwMode = getSeatHardwareMode(heat, seat);
      const drafted = draftThresholdsByGate.get(selectedGateId);
      if (hwMode === "laprf") {
        threshDrag.currentDbm = clamp(rawDbm, 300, 3500);
      } else if (isRotorHazardMode(hwMode)) {
        const savedEnter = drafted
          ? drafted.enterDb
          : enterThresholdAt(store, selectedGateId, seat.pilotSlotIndex).dbm;
        const savedExit = drafted
          ? drafted.exitDb
          : exitThresholdAt(store, selectedGateId, seat.pilotSlotIndex).dbm;
        if (threshDrag.kind === "enter") {
          threshDrag.currentDbm = clamp(rawDbm, Math.max(10, savedExit + 4), 250);
        } else {
          threshDrag.currentDbm = clamp(rawDbm, 6, savedEnter - 4);
        }
      } else {
        const savedEnter = drafted
          ? drafted.enterDb
          : enterThresholdAt(store, selectedGateId, seat.pilotSlotIndex).dbm;
        const savedExit = drafted
          ? drafted.exitDb
          : exitThresholdAt(store, selectedGateId, seat.pilotSlotIndex).dbm;
        if (threshDrag.kind === "enter") {
          threshDrag.currentDbm = clamp(rawDbm, Math.max(DBM_ABS_MIN + 2, savedExit + 2), DBM_ABS_MAX);
        } else {
          threshDrag.currentDbm = clamp(rawDbm, DBM_ABS_MIN, savedEnter - 2);
        }
      }
      refreshSvgOnly();
      return;
    }

    if (dragState) {
      dragState.currentOffsetMs = clientXToMs(svg, e.clientX);
      refreshSvgOnly();
      return;
    }

    const target = e.target as Element | null;
    if (
      target &&
      target.closest("[data-lap-ed-svg]") &&
      !target.closest("[data-thresh-handle]") &&
      !target.closest("[data-axis-drag]")
    ) {
      const offsetMs = clientXToMs(svg, e.clientX);
      const dbm = sampleTraceAtMs(seat.rssiTrace ?? [], offsetMs);
      hoverInfo = { offsetMs, dbm };
      refreshSvgOnly();
    } else if (hoverInfo) {
      hoverInfo = null;
      refreshSvgOnly();
    }
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType === "touch") {
      touchPts.delete(e.pointerId);
      if (pinchState !== null) {
        try {
          backdrop.releasePointerCapture(e.pointerId);
        } catch {
          // Ignore
        }
        if (touchPts.size < 2) {
          const wasPageScroll = pinchState.pageScrollLocked;
          pinchState = null;
          if (touchPts.size === 1 && !wasPageScroll) {
            const [[remId, remPt]] = Array.from(touchPts.entries());
            viewDrag = {
              mode: "pan",
              pointerId: remId,
              startSvgX: remPt.svgX,
              startSvgY: remPt.svgY,
              startMinMs: lastDomain.minMs,
              startMaxMs: lastDomain.maxMs,
              startMinDbm: lastYDomain.minDbm,
              startMaxDbm: lastYDomain.maxDbm,
              anchorFrac: 0.5,
            };
          }
          refreshSvgOnly();
        }
        return;
      }
    }

    if (viewDrag) {
      viewDrag = null;
      try {
        backdrop.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
      refreshSvgOnly();
      return;
    }

    if (threshDrag) {
      const finishedThresh = threshDrag;
      threshDrag = null;
      try {
        backdrop.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
      const { heat, seat } = getHeatAndSeat();
      if (!heat || !seat || !store.node(selectedGateId)) return;
      const cur = getGateThresholds(heat, seat);
      if (cur.hwMode === "laprf") {
        const thr = clamp(Math.round(finishedThresh.currentDbm), 300, 3500);
        draftThresholdsByGate.set(selectedGateId, {
          enterDb: thr,
          exitDb: thr,
          hwMode: "laprf",
        });
      } else if (isRotorHazardMode(cur.hwMode)) {
        const rhEnterThreshold =
          finishedThresh.kind === "enter"
            ? clamp(Math.round(finishedThresh.currentDbm), Math.max(10, Math.round(cur.exitDb) + 4), 250)
            : clamp(Math.round(cur.enterDb), 10, 250);
        const rhExitThreshold =
          finishedThresh.kind === "exit"
            ? clamp(Math.round(finishedThresh.currentDbm), 6, rhEnterThreshold - 4)
            : clamp(Math.round(cur.exitDb), 6, rhEnterThreshold - 4);
        draftThresholdsByGate.set(selectedGateId, {
          enterDb: rhEnterThreshold,
          exitDb: rhExitThreshold,
          hwMode: cur.hwMode,
        });
      } else {
        const enterDbm = Math.round(
          finishedThresh.kind === "enter" ? finishedThresh.currentDbm : cur.enterDb
        );
        const exitDbm = Math.round(
          finishedThresh.kind === "exit"
            ? Math.min(enterDbm - 2, finishedThresh.currentDbm)
            : Math.min(enterDbm - 2, cur.exitDb)
        );
        draftThresholdsByGate.set(selectedGateId, {
          enterDb: enterDbm,
          exitDb: exitDbm,
          hwMode: "slaprf",
        });
      }
      renderModal(false);
      return;
    }

    if (!dragState) return;
    const finished = dragState;
    dragState = null;
    try {
      backdrop.releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
    stageMoveCrossing(finished.crossingId, finished.currentOffsetMs);
  };

  const onWheel = (e: WheelEvent): void => {
    const target = e.target as Element | null;
    const svg = backdrop.querySelector<SVGSVGElement>("[data-lap-ed-svg]");
    if (!target || !svg || !target.closest("[data-lap-ed-svg]")) return;
    e.preventDefault();

    const plotW = getPlotW();
    const { svgX, svgY } = clientToSvgCoords(svg, e.clientX, e.clientY);

    // Modifier wheel zoom (Ctrl/Meta = Diagonal X+Y, Shift = X-only, Alt = Y-only)
    const modWf = computeWheelZoomFactors(e);
    if (modWf) {
      if (modWf.mode === "x" || modWf.mode === "xy") {
        const spanMs = lastDomain.maxMs - lastDomain.minMs;
        const xFrac = clamp((svgX - PAD_L) / plotW, 0, 1);
        const anchorMs = lastDomain.minMs + xFrac * spanMs;
        const nextSpan = clamp(spanMs * modWf.xSpanFactor, MIN_X_SPAN_MS, MAX_X_SPAN_MS);
        const nextMin = anchorMs - xFrac * nextSpan;
        customX = clampXDomain(nextMin, nextMin + nextSpan);
      }
      if (modWf.mode === "y" || modWf.mode === "xy") {
        const spanDb = lastYDomain.maxDbm - lastYDomain.minDbm;
        const yFrac = clamp(1 - (svgY - PAD_T) / PLOT_H, 0, 1);
        const anchorDbm = lastYDomain.minDbm + yFrac * spanDb;
        const { minSpan, maxSpan } = ySpanBounds(lastSeatHwMode);
        const nextSpan = clamp(spanDb * modWf.ySpanFactor, minSpan, maxSpan);
        const nextMin = anchorDbm - yFrac * nextSpan;
        customY = clampYDomain(nextMin, nextMin + nextSpan);
      }
      refreshSvgOnly();
      return;
    }

    // Horizontal trackpad scroll -> pan X
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const spanMs = lastDomain.maxMs - lastDomain.minMs;
      const deltaMs = (clamp(e.deltaX, -160, 160) / plotW) * spanMs;
      customX = clampXDomain(lastDomain.minMs + deltaMs, lastDomain.maxMs + deltaMs);
      refreshSvgOnly();
      return;
    }

    const factor = Math.exp(clamp(e.deltaY, -120, 120) * 0.0022);

    // Wheeling directly over the left Y-axis -> zoom Y scale
    if (svgX < PAD_L) {
      const spanDb = lastYDomain.maxDbm - lastYDomain.minDbm;
      const yFrac = clamp(1 - (svgY - PAD_T) / PLOT_H, 0, 1);
      const anchorDbm = lastYDomain.minDbm + yFrac * spanDb;
      const { minSpan, maxSpan } = ySpanBounds(lastSeatHwMode);
      const nextSpan = clamp(spanDb * factor, minSpan, maxSpan);
      const nextMin = anchorDbm - yFrac * nextSpan;
      customY = clampYDomain(nextMin, nextMin + nextSpan);
      refreshSvgOnly();
      return;
    }

    // Default wheel / pinch -> zoom X time window around cursor
    const spanMs = lastDomain.maxMs - lastDomain.minMs;
    const xFrac = clamp((svgX - PAD_L) / plotW, 0, 1);
    const anchorMs = lastDomain.minMs + xFrac * spanMs;
    const nextSpan = clamp(spanMs * factor, MIN_X_SPAN_MS, MAX_X_SPAN_MS);
    const nextMin = anchorMs - xFrac * nextSpan;
    customX = clampXDomain(nextMin, nextMin + nextSpan);
    refreshSvgOnly();
  };

  const onDblClick = (e: MouseEvent): void => {
    const target = e.target as Element | null;
    const svg = backdrop.querySelector<SVGSVGElement>("[data-lap-ed-svg]");
    const { heat, seat } = getHeatAndSeat();
    if (!target || !svg || !heat || !seat) return;
    if (!target.closest("[data-lap-ed-svg]")) return;

    const { svgX, svgY } = clientToSvgCoords(svg, e.clientX, e.clientY);
    const axisKind = target.closest("[data-axis-drag]")?.getAttribute("data-axis-drag");
    if (axisKind === "y" || svgX < PAD_L) {
      e.preventDefault();
      customY = null;
      refreshSvgOnly();
      return;
    }
    if (axisKind === "x" || svgY > SVG_H - PAD_B) {
      e.preventDefault();
      customX = null;
      refreshSvgOnly();
      return;
    }

    const locked = heat.state === "confirmed";
    if (locked) return;
    if (target.closest("[data-crossing-pin]") || target.closest("[data-thresh-handle]")) {
      return;
    }
    e.preventDefault();
    const offsetMs = clientXToMs(svg, e.clientX);
    stageAddCrossing(offsetMs);
  };

  const onClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target === backdrop || target.closest("[data-lap-ed-close]")) {
      close();
      return;
    }
    const discardBtn = target.closest<HTMLElement>("[data-lap-ed-discard]");
    if (discardBtn) {
      discardDraftChanges();
      return;
    }
    const saveBtn = target.closest<HTMLElement>("[data-lap-ed-save]");
    if (saveBtn) {
      void saveDraftChanges();
      return;
    }
    const resetViewBtn = target.closest<HTMLElement>("[data-lap-ed-reset-view]");
    if (resetViewBtn) {
      cancelPanAnim();
      customX = null;
      customY = null;
      refreshSvgOnly();
      return;
    }
    const gateBtn = target.closest<HTMLElement>("[data-lap-ed-gate]");
    if (gateBtn) {
      const nextGid = Number(gateBtn.dataset.lapEdGate || "0");
      if (nextGid > 0) {
        selectedGateId = nextGid;
        renderModal();
      }
      return;
    }
    const addModeBtn = target.closest<HTMLElement>("[data-lap-ed-add-mode]");
    if (addModeBtn) {
      addMode = !addMode;
      renderModal();
      return;
    }
    const unlockBtn = target.closest<HTMLElement>("[data-lap-ed-unlock]");
    if (unlockBtn) {
      const { race, heat } = getHeatAndSeat();
      if (heat && heat.state === "confirmed") {
        void api.raceControl("unlock", heat.id, race?.raceId).catch((err) => {
          showToast(err instanceof Error ? err.message : String(err), "error");
        });
      }
      return;
    }
    const addEndBtn = target.closest<HTMLElement>("[data-lap-ed-add-end]");
    if (addEndBtn) {
      const { heat, seat } = getHeatAndSeat();
      const locked = heat ? heat.state === "confirmed" : true;
      if (heat && seat && !locked) {
        stageAppendLap();
      }
      return;
    }
    const toggleBtn = target.closest<HTMLElement>("[data-lap-ed-toggle]");
    if (toggleBtn) {
      const { heat, seat } = getHeatAndSeat();
      const cid = Number(toggleBtn.dataset.lapEdToggle || "0");
      if (heat && seat && cid !== 0) {
        stageToggleCrossing(cid);
      }
      return;
    }
    const delBtn = target.closest<HTMLElement>("[data-lap-ed-delete]");
    if (delBtn) {
      const { heat, seat } = getHeatAndSeat();
      const cid = Number(delBtn.dataset.lapEdDelete || "0");
      if (heat && seat && cid !== 0) {
        stageDeleteCrossing(cid);
      }
      return;
    }
    const rowEl = target.closest<HTMLElement>("[data-lap-ed-row]");
    if (rowEl) {
      const cid = Number(rowEl.dataset.lapEdRow || "0");
      if (cid !== 0) {
        scrollCrossingIntoView(cid);
      }
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

  const unsub = store.subscribe(["race", "config"], () => {
    if (dragState || threshDrag || viewDrag) {
      return;
    }
    const { race, heat, seat } = getHeatAndSeat();
    if (!heat || !seat) {
      close();
      return;
    }
    const summary = deriveCrossings(heat, seat, race, draftCrossings);
    const nextSigs = computeSigs(heat, seat, summary);
    if (nextSigs.tableSig !== lastTableSig) {
      renderModal(false);
    } else if (nextSigs.traceSig !== lastTraceSig) {
      refreshSvgOnly();
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
    cancelPanAnim();
    unsub();
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (!hadSubpageBack) {
      topbarEl?.classList.remove("has-subpage-back");
    }
    if (!hadMobileSubpage) {
      appEl?.classList.remove("is-mobile-subpage");
    }
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("click", onTopBarBackCapture, true);
    window.removeEventListener("hashchange", onHashChange);
    backdrop.removeEventListener("pointerdown", onPointerDown);
    backdrop.removeEventListener("pointermove", onPointerMove);
    backdrop.removeEventListener("pointerup", onPointerUp);
    backdrop.removeEventListener("pointercancel", onPointerUp);
    backdrop.removeEventListener("wheel", onWheel);
    backdrop.removeEventListener("dblclick", onDblClick);
    backdrop.removeEventListener("click", onClick);
    if (backdrop.parentNode) {
      backdrop.parentNode.removeChild(backdrop);
    }
    if (activeLapEditorCleanup === close) {
      activeLapEditorCleanup = null;
    }
  }

  activeLapEditorCleanup = close;
  backdrop.addEventListener("pointerdown", onPointerDown);
  backdrop.addEventListener("pointermove", onPointerMove);
  backdrop.addEventListener("pointerup", onPointerUp);
  backdrop.addEventListener("pointercancel", onPointerUp);
  backdrop.addEventListener("wheel", onWheel, { passive: false });
  backdrop.addEventListener("dblclick", onDblClick);
  backdrop.addEventListener("click", onClick);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("click", onTopBarBackCapture, true);
  window.addEventListener("hashchange", onHashChange);
  document.body.appendChild(backdrop);
  renderModal();
  const mountedWrap = backdrop.querySelector<HTMLElement>("[data-lap-ed-svg-wrap]");
  if (mountedWrap && mountedWrap.clientWidth > 120 && Math.abs(mountedWrap.clientWidth - svgW) >= 2) {
    svgW = Math.round(mountedWrap.clientWidth);
    refreshSvgOnly();
  }
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => {
      const wEl = backdrop.querySelector<HTMLElement>("[data-lap-ed-svg-wrap]");
      if (wEl && wEl.clientWidth > 120 && Math.abs(wEl.clientWidth - svgW) >= 2) {
        svgW = Math.round(wEl.clientWidth);
        refreshSvgOnly();
      }
    });
    resizeObserver.observe(backdrop);
  }
}
