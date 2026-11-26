import { esc, fmtTime } from "../core/format";
import { icons } from "../core/icons";
import { formatBandChannelShort } from "../core/vtx_channels";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";
import { LapRecord, PracticeSession } from "../types/models";
import { closeActiveLapEditorModal } from "./HeatLapEditorModal";
import { PilotRssiChart } from "./PilotRssiChart";
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

interface LockedLapWindowBounds {
  lapNumber: number | null;
  lapTimeSec: number | null;
  startUs: number;
  endUs: number;
  hardMinUs: number;
  hardMaxUs: number;
  passMinUs: number;
  passMaxUs: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Opens the Single-Lap Practice RSSI Editor modal mounting the real `Signals` (`PilotRssiChart`)
 * widget locked strictly to the clicked lap:
 * - Identical `Signals` Canvas graph height, stretchable X/Y axes (`Auto X` / `Auto Y`), and
 *   in-chart `[ + ]` + `[ 🔒 / 🔓 ]` action buttons.
 * - Identical stacked `.channel-legend > .channel` per-timer rows (`All timers`, `H1`, `T1`, …)
 *   directly below the graph.
 * - Strictly bounded to the selected lap (`Start` .. `Finish`): no lap switcher, no scrolling
 *   into adjacent laps, and instant single-lap `Auto-Label`.
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

  const initSess = getSession();
  if (!initSess) return;

  const reviewStore = rootStore.forPracticeSessionReview(getSession);
  const scopedApi =
    typeof rootApi.forScope === "function"
      ? rootApi.forScope(() => ({ kind: "practice", id: sessionId }))
      : rootApi;

  let selectedPilotSlot = initialPilotSlotIndex;
  if (
    initSess.pilots.length > 0 &&
    !initSess.pilots.some((p) => p.slotIndex === selectedPilotSlot)
  ) {
    selectedPilotSlot = initSess.pilots[0].slotIndex;
  }

  const getPilotLaps = (sess: PracticeSession): LapRecord[] =>
    (sess.laps ?? [])
      .filter((l) => l.slotIndex === selectedPilotSlot)
      .sort(
        (a, b) =>
          a.completedAtUs - b.completedAtUs || a.lapNumber - b.lapNumber || a.lapId - b.lapId
      );

  const lapStartUsOf = (lap: LapRecord): number =>
    Math.max(0, Math.round(lap.completedAtUs - lap.lapTimeSec * 1_000_000));

  const initPilotLaps = getPilotLaps(initSess);
  let lockedLap: LapRecord | undefined;
  if (
    opts.initialLapId !== undefined &&
    opts.focusEndUs !== undefined &&
    opts.focusEndUs > 0
  ) {
    lockedLap = initPilotLaps.find(
      (l) => l.lapId === opts.initialLapId && Math.abs(l.completedAtUs - opts.focusEndUs!) <= 150_000
    );
  }
  if (!lockedLap && opts.focusEndUs !== undefined && opts.focusEndUs > 0) {
    lockedLap = initPilotLaps.find((l) => Math.abs(l.completedAtUs - opts.focusEndUs!) <= 150_000);
  }
  if (!lockedLap && opts.initialLapId !== undefined) {
    lockedLap = initPilotLaps.find((l) => l.lapId === opts.initialLapId);
  }
  if (!lockedLap && opts.focusStartUs === undefined && initPilotLaps.length > 0) {
    lockedLap = initPilotLaps[initPilotLaps.length - 1];
  }
  let lockedLapId: number | null = lockedLap?.lapId ?? null;
  let lockedLapNumber: number | null = lockedLap?.lapNumber ?? null;
  let fallbackStartUs =
    lockedLap !== undefined
      ? lapStartUsOf(lockedLap)
      : opts.focusStartUs;
  let fallbackEndUs =
    lockedLap !== undefined
      ? lockedLap.completedAtUs
      : opts.focusEndUs;

  const lockToLap = (lap: LapRecord): void => {
    lockedLap = lap;
    lockedLapId = lap.lapId;
    lockedLapNumber = lap.lapNumber;
    fallbackStartUs = lapStartUsOf(lap);
    fallbackEndUs = lap.completedAtUs;
  };

  const resolveCurrentLapIndex = (sess: PracticeSession): number => {
    const pLaps = getPilotLaps(sess);
    if (pLaps.length === 0) return -1;
    if (lockedLapId === null && lockedLapNumber === null) return -1;

    // 1. If a merged multi-lap window `[fallbackStartUs .. fallbackEndUs]` was just split by
    //    inserting a mid-window Start/Finish crossing, stay on the first split lap so clicking
    //    `Next` visits the second split half instead of skipping over it.
    if (
      fallbackStartUs !== undefined &&
      fallbackEndUs !== undefined &&
      fallbackEndUs - fallbackStartUs >= 4_000_000
    ) {
      const firstSplitIdx = pLaps.findIndex((l, idx) => {
        if (idx + 1 >= pLaps.length) return false;
        const sUs = lapStartUsOf(l);
        const nextEndUs = pLaps[idx + 1].completedAtUs;
        return (
          Math.abs(sUs - fallbackStartUs!) <= 500_000 &&
          l.completedAtUs < fallbackEndUs! - 1_000_000 &&
          Math.abs(nextEndUs - fallbackEndUs!) <= 1_500_000
        );
      });
      if (firstSplitIdx >= 0) return firstSplitIdx;
    }

    // 2. Match `(lapId + completedAtUs)` first so even legacy duplicate `lapId`s never alias.
    if (lockedLapId !== null && fallbackEndUs !== undefined) {
      const exactIdx = pLaps.findIndex(
        (l) => l.lapId === lockedLapId && Math.abs(l.completedAtUs - fallbackEndUs!) <= 2_000_000
      );
      if (exactIdx >= 0) return exactIdx;
    }

    // 3. Unique `lapId` match (disambiguated by timestamp or lapNumber if duplicated).
    if (lockedLapId !== null) {
      const matchingIndices: number[] = [];
      for (let i = 0; i < pLaps.length; i++) {
        if (pLaps[i].lapId === lockedLapId) matchingIndices.push(i);
      }
      if (matchingIndices.length === 1) {
        return matchingIndices[0];
      }
      if (matchingIndices.length > 1) {
        if (fallbackEndUs !== undefined) {
          let bestIdx = matchingIndices[0];
          let bestDiff = Math.abs(pLaps[bestIdx].completedAtUs - fallbackEndUs);
          for (const idx of matchingIndices) {
            const d = Math.abs(pLaps[idx].completedAtUs - fallbackEndUs);
            if (d < bestDiff) {
              bestDiff = d;
              bestIdx = idx;
            }
          }
          return bestIdx;
        }
        if (lockedLapNumber !== null) {
          const byNum = matchingIndices.find((idx) => pLaps[idx].lapNumber === lockedLapNumber);
          if (byNum !== undefined) return byNum;
        }
        return matchingIndices[0];
      }
    }

    // 4. Midpoint overlap fallback when an H1 drag or Auto-Label moved `completedAtUs` > 50 ms
    //    (assigning a new `lapId`) while an earlier edit also shifted `lapNumber`.
    if (
      fallbackStartUs !== undefined &&
      fallbackEndUs !== undefined &&
      fallbackEndUs > fallbackStartUs
    ) {
      const midUs = 0.5 * (fallbackStartUs + fallbackEndUs);
      const midIdx = pLaps.findIndex(
        (l) => lapStartUsOf(l) - 250_000 <= midUs && midUs <= l.completedAtUs + 250_000
      );
      if (midIdx >= 0) return midIdx;
    }

    // 5. `lapNumber` fallback.
    if (lockedLapNumber !== null) {
      const idx = pLaps.findIndex((l) => l.lapNumber === lockedLapNumber);
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const computeLapBounds = (sess: PracticeSession): LockedLapWindowBounds => {
    const pLaps = getPilotLaps(sess);
    const curIdx = resolveCurrentLapIndex(sess);
    const liveLap = (curIdx >= 0 ? pLaps[curIdx] : undefined) ?? lockedLap;

    if (liveLap && liveLap.completedAtUs > 0) {
      const startUs = Math.max(0, Math.round(liveLap.completedAtUs - liveLap.lapTimeSec * 1_000_000));
      const endUs = liveLap.completedAtUs;
      const spanUs = Math.max(1_000_000, endUs - startUs);
      const padUs = clamp(Math.round(spanUs * 0.12), 1_000_000, 2_000_000);
      return {
        lapNumber: liveLap.lapNumber,
        lapTimeSec: liveLap.lapTimeSec,
        startUs,
        endUs,
        hardMinUs: Math.max(0, startUs - padUs),
        hardMaxUs: Math.max(startUs + 1_500_000, endUs + padUs),
        passMinUs: Math.max(0, startUs - 350_000),
        passMaxUs: endUs + 350_000,
      };
    }

    if (
      fallbackStartUs !== undefined &&
      fallbackEndUs !== undefined &&
      fallbackEndUs >= fallbackStartUs &&
      fallbackEndUs > 0
    ) {
      const spanUs = Math.max(1_000_000, fallbackEndUs - fallbackStartUs);
      const padUs = clamp(Math.round(spanUs * 0.12), 1_000_000, 2_000_000);
      return {
        lapNumber: null,
        lapTimeSec: Math.max(0, (fallbackEndUs - fallbackStartUs) / 1_000_000),
        startUs: fallbackStartUs,
        endUs: fallbackEndUs,
        hardMinUs: Math.max(0, fallbackStartUs - padUs),
        hardMaxUs: Math.max(fallbackStartUs + 1_500_000, fallbackEndUs + padUs),
        passMinUs: Math.max(0, fallbackStartUs - 350_000),
        passMaxUs: fallbackEndUs + 350_000,
      };
    }

    const latestUs = Math.max(15_000_000, reviewStore.latestTimestampUs || 15_000_000);
    const startUs = Math.max(0, latestUs - 12_000_000);
    return {
      lapNumber: null,
      lapTimeSec: null,
      startUs,
      endUs: latestUs,
      hardMinUs: startUs,
      hardMaxUs: latestUs,
      passMinUs: startUs,
      passMaxUs: latestUs,
    };
  };

  const defaultFocusedGateId = (): number | null => {
    const nodes = reviewStore.nodes;
    if (opts.initialGateId !== undefined && nodes.some((n) => n.gateId === opts.initialGateId)) {
      return opts.initialGateId;
    }
    return nodes.length === 1 ? nodes[0].gateId : null;
  };

  let isAutoLabeling = false;
  const needsFreshTrace = rootStore.sessionTraceNeedsRefresh(initSess);

  const backdrop = document.createElement("div");
  backdrop.className = "slaprf-modal-backdrop lap-editor-backdrop is-practice-signals-backdrop";
  backdrop.setAttribute("role", "presentation");

  const initBounds = computeLapBounds(initSess);
  backdrop.innerHTML = `
    <div class="slaprf-modal lap-editor-modal is-practice-signals-editor" role="dialog" aria-modal="true" aria-label="Lap RSSI Signal">
      <div class="slaprf-modal-head lap-ed-head" data-lap-ed-head></div>
      <div class="slaprf-modal-body lap-ed-body is-signals-editor-body">
        <div class="rc-signals-card-box">
          <div class="rc-panel-body is-signals-body">
            <div class="rc-signals-chart-host">
              <div class="rc-signals-chart-inner" data-lap-ed-chart-host></div>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  const headEl = backdrop.querySelector<HTMLElement>("[data-lap-ed-head]")!;
  const chartInnerEl = backdrop.querySelector<HTMLElement>("[data-lap-ed-chart-host]")!;

  const renderHeader = (): void => {
    const sess = getSession();
    if (!sess) return;
    const bounds = computeLapBounds(sess);
    const pilotInfo = sess.pilots.find((p) => p.slotIndex === selectedPilotSlot);
    const rootPilot = rootStore.pilot(selectedPilotSlot);
    const callsign = pilotInfo?.callsign || rootPilot?.callsign || `Pilot ${selectedPilotSlot}`;
    const chLabel = pilotInfo
      ? formatBandChannelShort(pilotInfo.band, pilotInfo.channel)
      : rootPilot
        ? formatBandChannelShort(rootPilot.band, rootPilot.channel)
        : "";
    const who = `${callsign}${chLabel ? ` (${chLabel})` : ""}`;
    const hasBreakInWindow = (sess.breaks ?? []).some(
      (b) =>
        b.slotIndex === selectedPilotSlot &&
        b.timestampUs >= bounds.passMinUs &&
        b.timestampUs <= bounds.passMaxUs
    );
    const lapPart =
      bounds.lapNumber !== null
        ? ` · L${bounds.lapNumber}${bounds.lapTimeSec !== null ? ` · ${fmtTime(bounds.lapTimeSec)}` : ""}`
        : hasBreakInWindow
          ? ` · Break${bounds.lapTimeSec !== null && bounds.lapTimeSec > 0 ? ` · ${fmtTime(bounds.lapTimeSec)}` : ""}`
          : bounds.lapTimeSec !== null && bounds.lapTimeSec > 0
            ? ` · ${fmtTime(bounds.lapTimeSec)}`
            : "";

    const teacher = rootStore.mlStatus.teacher;
    const hasTeacherSupport = Boolean(
      teacher?.ready || (teacher?.packs && teacher.packs.length > 0)
    );
    const autoLabelTitle = isAutoLabeling
      ? "Labeling gate crossings in track order…"
      : "Auto-label gate crossings on this lap in track order";
    const autoLabelText = isAutoLabeling ? "Labeling…" : "Auto-Label";

    headEl.innerHTML = `
      <div class="lap-ed-head-left">
        <h3>${esc(who)}${esc(lapPart)}</h3>
      </div>
      <div class="lap-ed-head-right">
        <button type="button" class="btn btn-sm btn-ghost" data-lap-ed-add-break title="Insert a flight break in this window so before/after stints do not merge into a lap">
          ${icons.splitBreak(14)}<span>Break</span>
        </button>
        ${
          hasTeacherSupport
            ? `<button type="button" class="btn btn-sm ${isAutoLabeling ? "btn-armed" : "btn-ghost"}" data-lap-ed-auto-label ${isAutoLabeling ? "disabled" : ""} title="${esc(autoLabelTitle)}">
                 ${isAutoLabeling ? icons.spinner(13) : icons.zap(13)}<span>${esc(autoLabelText)}</span>
               </button>`
            : ""
        }
        <button type="button" class="btn btn-sm btn-ghost btn-icon lap-ed-desktop-close-btn" data-lap-ed-close aria-label="Close">
          ${icons.close(15)}
        </button>
      </div>`;
  };

  renderHeader();
  document.body.appendChild(backdrop);

  const findAdjacentLapTarget = (sess: PracticeSession, dir: -1 | 1): LapRecord | undefined => {
    const pLaps = getPilotLaps(sess);
    if (pLaps.length === 0) return undefined;
    const curIdx = resolveCurrentLapIndex(sess);
    if (curIdx >= 0) {
      return pLaps[curIdx + dir];
    }
    const bounds = computeLapBounds(sess);
    const breakInWindow = (sess.breaks ?? []).find(
      (b) =>
        b.slotIndex === selectedPilotSlot &&
        b.timestampUs >= bounds.passMinUs &&
        b.timestampUs <= bounds.passMaxUs
    );
    if (dir < 0) {
      const refUs = breakInWindow ? breakInWindow.timestampUs : bounds.startUs;
      for (let i = pLaps.length - 1; i >= 0; i--) {
        if (pLaps[i].completedAtUs <= refUs + 250_000) {
          return pLaps[i];
        }
      }
      return undefined;
    }
    const refUs = breakInWindow ? breakInWindow.timestampUs : bounds.endUs;
    for (let i = 0; i < pLaps.length; i++) {
      const lapStartUs = lapStartUsOf(pLaps[i]);
      if (lapStartUs >= refUs - 250_000) {
        return pLaps[i];
      }
    }
    return undefined;
  };

  const canStepLap = (dir: -1 | 1): boolean => {
    const sess = getSession();
    if (!sess) return false;
    return findAdjacentLapTarget(sess, dir) !== undefined;
  };

  let chartRef: PilotRssiChart | null = null;
  const stepToAdjacentLap = (dir: -1 | 1): void => {
    const sess = getSession();
    if (!sess || !chartRef) return;
    const target = findAdjacentLapTarget(sess, dir);
    if (!target) return;
    lockToLap(target);
    renderHeader();
    const nextBounds = computeLapBounds(sess);
    chartRef.setLapWindow(
      {
        minUs: nextBounds.hardMinUs,
        maxUs: nextBounds.hardMaxUs,
        passMinUs: nextBounds.passMinUs,
        passMaxUs: nextBounds.passMaxUs,
        canStepLap,
        onStepLap: stepToAdjacentLap,
      },
      true
    );
  };

  const chart = new PilotRssiChart(chartInnerEl, reviewStore, scopedApi, {
    contextMode: "practice",
    lapWindow: {
      minUs: initBounds.hardMinUs,
      maxUs: initBounds.hardMaxUs,
      passMinUs: initBounds.passMinUs,
      passMaxUs: initBounds.passMaxUs,
      initialFocusGateId: defaultFocusedGateId(),
      canStepLap,
      onStepLap: stepToAdjacentLap,
    },
  });
  chartRef = chart;
  chart.setPilotSlotOverride(selectedPilotSlot);

  const runSingleLapAutoLabel = async (): Promise<void> => {
    const sess = getSession();
    if (!sess || isAutoLabeling) return;

    isAutoLabeling = true;
    renderHeader();
    try {
      const bounds = computeLapBounds(sess);
      const res = await rootApi.labelPracticeSession(sessionId, {
        dryRun: false,
        slotIndex: selectedPilotSlot,
        startUs: bounds.passMinUs,
        endUs: bounds.passMaxUs,
      });
      if (!document.body.contains(backdrop)) return;
      const latestSess = getSession();
      if (latestSess) {
        const curIdx = resolveCurrentLapIndex(latestSess);
        const pLaps = getPilotLaps(latestSess);
        if (curIdx >= 0 && pLaps[curIdx]) {
          lockToLap(pLaps[curIdx]);
        }
        const nextBounds = computeLapBounds(latestSess);
        chart.setLapWindow({
          minUs: nextBounds.hardMinUs,
          maxUs: nextBounds.hardMaxUs,
          passMinUs: nextBounds.passMinUs,
          passMaxUs: nextBounds.passMaxUs,
          canStepLap,
          onStepLap: stepToAdjacentLap,
        });
      }
      const count = res.crossingsCount ?? (res.decisions ?? []).filter((d) => d.label === "crossing").length;
      showToast(`Auto-labeled ${count} pass${count === 1 ? "" : "es"} in this lap`, "info");
    } catch (err) {
      if (document.body.contains(backdrop)) {
        showToast(err instanceof Error ? err.message : String(err), "error");
      }
    } finally {
      isAutoLabeling = false;
      if (document.body.contains(backdrop)) {
        renderHeader();
      }
    }
  };

  const runInsertBreak = async (): Promise<void> => {
    const sess = getSession();
    if (!sess || !chartRef) return;
    const bounds = computeLapBounds(sess);
    let tsUs = chartRef.visibleCenterTimestampUs();
    if (bounds.endUs > bounds.startUs + 120_000) {
      tsUs = clamp(tsUs, bounds.startUs + 50_000, bounds.endUs - 50_000);
    } else {
      tsUs = clamp(tsUs, bounds.hardMinUs + 10_000, bounds.hardMaxUs - 10_000);
    }
    fallbackStartUs = bounds.startUs;
    fallbackEndUs = bounds.endUs;
    lockedLap = undefined;
    lockedLapId = null;
    lockedLapNumber = null;
    try {
      await scopedApi.addBreak(selectedPilotSlot, tsUs);
      showToast("Added break — drag BREAK handle on chart or click × to undo", "info");
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), "error");
    }
  };

  const onBackdropClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target === backdrop || target.closest("[data-lap-ed-close]")) {
      close();
      return;
    }
    if (target.closest("[data-lap-ed-add-break]")) {
      void runInsertBreak();
      return;
    }
    if (target.closest("[data-lap-ed-auto-label]")) {
      void runSingleLapAutoLabel();
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (chartRef?.cancelAddCrossingMode()) {
        return;
      }
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

  const unsubStore = rootStore.subscribe(["practice", "laps", "crossings", "ml"], () => {
    if (!document.body.contains(backdrop)) return;
    const sess = getSession();
    if (sess && (lockedLapId !== null || lockedLapNumber !== null)) {
      const curIdx = resolveCurrentLapIndex(sess);
      const pLaps = getPilotLaps(sess);
      if (curIdx >= 0 && pLaps[curIdx]) {
        lockToLap(pLaps[curIdx]);
      }
      const nextBounds = computeLapBounds(sess);
      chart.setLapWindow({
        minUs: nextBounds.hardMinUs,
        maxUs: nextBounds.hardMaxUs,
        passMinUs: nextBounds.passMinUs,
        passMaxUs: nextBounds.passMaxUs,
        canStepLap,
        onStepLap: stepToAdjacentLap,
      });
    } else {
      chart.renderControls();
    }
    renderHeader();
  });

  const topbarEl = document.querySelector<HTMLElement>(".topbar");
  const appEl = document.querySelector<HTMLElement>(".app");
  const hadSubpageBack = Boolean(topbarEl?.classList.contains("has-subpage-back"));
  const hadMobileSubpage = Boolean(appEl?.classList.contains("is-mobile-subpage"));
  topbarEl?.classList.remove("is-mobile-collapsed");
  appEl?.classList.remove("is-mobile-topbar-collapsed");
  topbarEl?.classList.add("has-subpage-back");
  appEl?.classList.add("is-mobile-subpage");

  function close(): void {
    unsubStore();
    chart.destroy();
    if (!hadSubpageBack) {
      topbarEl?.classList.remove("has-subpage-back");
    }
    if (!hadMobileSubpage) {
      appEl?.classList.remove("is-mobile-subpage");
    }
    backdrop.removeEventListener("click", onBackdropClick);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("click", onTopBarBackCapture, true);
    window.removeEventListener("hashchange", onHashChange);
    backdrop.remove();
    if (activePracticeEditorCleanup === close) {
      activePracticeEditorCleanup = null;
    }
  }

  activePracticeEditorCleanup = close;
  backdrop.addEventListener("click", onBackdropClick);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("click", onTopBarBackCapture, true);
  window.addEventListener("hashchange", onHashChange);

  if (!rootStore.hasSessionTrace(sessionId) || needsFreshTrace) {
    void rootApi.ensurePracticeSessionTrace(sessionId, needsFreshTrace).catch(() => undefined);
  }
}
