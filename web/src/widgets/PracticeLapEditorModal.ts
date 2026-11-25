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
    (sess.laps ?? []).filter((l) => l.slotIndex === selectedPilotSlot);

  const initPilotLaps = getPilotLaps(initSess);
  let lockedLap: LapRecord | undefined;
  if (opts.initialLapId !== undefined) {
    lockedLap = initPilotLaps.find((l) => l.lapId === opts.initialLapId);
  }
  if (!lockedLap && opts.focusEndUs !== undefined && opts.focusEndUs > 0) {
    lockedLap = initPilotLaps.find((l) => Math.abs(l.completedAtUs - opts.focusEndUs!) <= 150_000);
  }
  if (!lockedLap && opts.focusStartUs === undefined && initPilotLaps.length > 0) {
    lockedLap = initPilotLaps[initPilotLaps.length - 1];
  }
  let lockedLapId: number | null = lockedLap?.lapId ?? null;
  let lockedLapNumber: number | null = lockedLap?.lapNumber ?? null;
  const fallbackStartUs = opts.focusStartUs;
  const fallbackEndUs = opts.focusEndUs;

  const resolveCurrentLapIndex = (sess: PracticeSession): number => {
    const pLaps = getPilotLaps(sess);
    if (pLaps.length === 0) return -1;
    if (lockedLapId !== null) {
      const idx = pLaps.findIndex((l) => l.lapId === lockedLapId);
      if (idx >= 0) return idx;
    }
    if (lockedLapNumber !== null) {
      const idx = pLaps.findIndex((l) => l.lapNumber === lockedLapNumber);
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const computeLapBounds = (sess: PracticeSession): LockedLapWindowBounds => {
    const pLaps = getPilotLaps(sess);
    const liveLap =
      (lockedLapId !== null ? pLaps.find((l) => l.lapId === lockedLapId) : undefined) ??
      (lockedLapNumber !== null ? pLaps.find((l) => l.lapNumber === lockedLapNumber) : undefined) ??
      lockedLap;

    if (liveLap && liveLap.completedAtUs > 0) {
      const startUs = Math.max(0, Math.round(liveLap.completedAtUs - liveLap.lapTimeSec * 1_000_000));
      const endUs = liveLap.completedAtUs;
      const spanUs = Math.max(1_000_000, endUs - startUs);
      const padUs = clamp(Math.round(spanUs * 0.1), 800_000, 1_600_000);
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
      const padUs = clamp(Math.round(spanUs * 0.1), 800_000, 1_600_000);
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
  const needsFreshActiveTrace =
    Boolean(initSess.active) &&
    (initSess.laps ?? []).some((l) => l.completedAtUs > rootStore.sessionTraceMaxTsUs(sessionId));

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
    const lapPart =
      bounds.lapNumber !== null
        ? ` · L${bounds.lapNumber}${bounds.lapTimeSec !== null ? ` · ${fmtTime(bounds.lapTimeSec)}` : ""}`
        : bounds.lapTimeSec !== null && bounds.lapTimeSec > 0
          ? ` · ${fmtTime(bounds.lapTimeSec)}`
          : "";

    const teacher = rootStore.mlStatus.teacher;
    const hasTeacherSupport = Boolean(
      teacher?.ready || (teacher?.packs && teacher.packs.length > 0)
    );
    const dlRunning = Boolean(teacher?.download?.running);
    const autoLabelTitle = isAutoLabeling
      ? "Labeling peaks in this lap…"
      : dlRunning
        ? `Downloading AI labeler (${Math.round((teacher?.download?.fraction ?? 0) * 100)}%)…`
        : teacher?.ready
          ? "Auto-label gate crossings on this lap"
          : "Download on-device AI labeler";
    const autoLabelText = isAutoLabeling
      ? "Labeling…"
      : dlRunning
        ? `${Math.round((teacher?.download?.fraction ?? 0) * 100)}%`
        : "Auto-Label";

    headEl.innerHTML = `
      <div class="lap-ed-head-left">
        <h3>${esc(who)}${esc(lapPart)}</h3>
      </div>
      <div class="lap-ed-head-right">
        ${
          hasTeacherSupport
            ? `<button type="button" class="btn btn-sm ${isAutoLabeling ? "btn-armed" : "btn-ghost"}" data-lap-ed-auto-label ${dlRunning ? "disabled" : ""} title="${esc(autoLabelTitle)}">
                 ${isAutoLabeling || dlRunning ? icons.spinner(13) : icons.zap(13)}<span>${esc(autoLabelText)}</span>
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

  const canStepLap = (dir: -1 | 1): boolean => {
    const sess = getSession();
    if (!sess) return false;
    const pLaps = getPilotLaps(sess);
    const curIdx = resolveCurrentLapIndex(sess);
    if (curIdx < 0) return false;
    const nextIdx = curIdx + dir;
    return nextIdx >= 0 && nextIdx < pLaps.length;
  };

  let chartRef: PilotRssiChart | null = null;
  const stepToAdjacentLap = (dir: -1 | 1): void => {
    const sess = getSession();
    if (!sess || !chartRef) return;
    const pLaps = getPilotLaps(sess);
    const curIdx = resolveCurrentLapIndex(sess);
    if (curIdx < 0) return;
    const target = pLaps[curIdx + dir];
    if (!target) return;
    lockedLap = target;
    lockedLapId = target.lapId;
    lockedLapNumber = target.lapNumber;
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
      renderHeader();
      return;
    }

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
        const nextBounds = computeLapBounds(latestSess);
        chart.setLapWindow({
          minUs: nextBounds.hardMinUs,
          maxUs: nextBounds.hardMaxUs,
          passMinUs: nextBounds.passMinUs,
          passMaxUs: nextBounds.passMaxUs,
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

  const onBackdropClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target === backdrop || target.closest("[data-lap-ed-close]")) {
      close();
      return;
    }
    if (target.closest("[data-lap-ed-auto-label]")) {
      void runSingleLapAutoLabel();
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

  const unsubStore = rootStore.subscribe(["practice", "laps", "crossings", "ml"], () => {
    if (!document.body.contains(backdrop)) return;
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

  if (!rootStore.hasSessionTrace(sessionId) || needsFreshActiveTrace) {
    void rootApi.ensurePracticeSessionTrace(sessionId, needsFreshActiveTrace).catch(() => undefined);
  }
}
