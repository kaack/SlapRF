import { Component } from "../core/component";
import { isCustomSelectOpenWithin } from "../core/custom_select";
import { esc, fmtDelta, fmtTime } from "../core/format";
import { icons } from "../core/icons";
import { fitScheduleLineups } from "../core/table_scroll";
import {
  BAND_RACEBAND,
  decodeBandChannel,
  formatBandChannelShort,
  pilotChannelSearchTokens,
  renderMultiBandSelectOptionsHtml,
} from "../core/vtx_channels";
import {
  buildPracticeHash,
  getCurrentParsedHash,
  onPracticeRouteTargetChange,
  onPracticeTopBarCommand,
  PracticeRouteTarget,
  PracticeViewTab,
  pushAppHash,
  replaceAppHash,
  setPracticeTopBarContext,
  slugifyPracticeName,
} from "../core/router";
import { ApiClient } from "../services/api_client";
import { sectionKey } from "../state/analysis";
import { allLapsFor, gateColor, gateLabel, lapsFor, sectionLabel, sectionShort } from "../state/selectors";
import { AppStore } from "../state/store";
import { PracticeSession } from "../types/models";
import { openConfirmModal } from "../widgets/ConfirmModal";
import { openConfirmPreemptModal } from "../widgets/ConfirmPreemptModal";
import { renderEmpty, renderSectionCapsuleIcon, SPLIT_CLASS } from "../widgets/markup";
import { PilotPicker } from "../widgets/PilotPicker";
import { PilotRssiChart } from "../widgets/PilotRssiChart";
import { ScopedTrackWorkspace } from "../widgets/ScopedTrackWorkspace";
import { mountTagPillEditor, renderTagPillBoxHtml } from "../widgets/TagPillEditor";
import { cleanConnectionInvalidReason, showToast } from "../widgets/Toast";
import { AllPilotsPanel } from "./live/AllPilotsPanel";
import { PilotPanel } from "./live/PilotPanel";
import { PilotView } from "./PilotView";

type SessionDirStatusFilter = "all" | "live" | "stopped" | "laps";
type MobilePracticeTab = "pilots" | "track" | "overview" | "laps" | "trends" | "signals" | "analytics";

function formatShortSessionDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fastestSessionLap(session: PracticeSession): { sec: number; callsign: string } | null {
  let bestSec = 0;
  let bestCallsign = "";
  for (const lap of session.laps ?? []) {
    if (lap.invalidated) continue;
    if (lap.lapTimeSec > 0 && (bestSec === 0 || lap.lapTimeSec < bestSec)) {
      bestSec = lap.lapTimeSec;
      bestCallsign = lap.callsign;
    }
  }
  return bestSec > 0 ? { sec: bestSec, callsign: bestCallsign } : null;
}

/**
 * Practice view (`#/practice` directory & `#/practice/<session>` active session workspace):
 * 1. Directory view: 2-column `.settings-section` matching `Races`, with inline `+ Session`
 *    row creation, inline session name & comma-separated tag editing, tag filter pills,
 *    `Live` / `Stopped` status badges, and Open / Start-Stop / Delete icon actions.
 * 2. Session workspace: TopBar breadcrumb `< Practice › <Session>`, `All` + pilot chips +
 *    `+ Add pilot` popover right in `.picker-row`, `Start / Stop` session control, and
 *    live standings / lap progression / section splits / per-pilot RSSI stream.
 */
export class PracticeView extends Component {
  private readonly store: AppStore;
  private readonly workspaceStore: AppStore;
  private readonly trackEditorStore: AppStore;
  private readonly api: ApiClient;
  private readonly scopedApi: ApiClient;
  private activeTab: PracticeViewTab = "directory";
  private panel: Component | null = null;
  private shownFocus: number | null | undefined = undefined;

  private dirSearchQuery = "";
  private dirStatusFilter: SessionDirStatusFilter = "all";
  private selectedFilterTags = new Set<string>();
  private untaggedOnly = false;
  private editingNameForSessionId = "";
  private editingTagsForSessionId = "";
  private mobileSelectedSessionId = "";
  private lastOpenedMobileSessionId = "";
  private mobileSessionDrawerClosing = false;
  private mobileSessionDrawerCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private mobileSessionDrawerDragStartY: number | null = null;
  private dirFabOpen = false;
  private wsFabOpen = false;
  private pilotPopoverOpen = false;
  private activePracticeSlotIndex = 1;
  private pilotDrawerAnimatedOpen = false;
  private pilotDrawerClosing = false;
  private pilotDrawerCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private isViewActive = true;

  public override onDeactivate(): void {
    this.isViewActive = false;
    this.pilotPopoverOpen = false;
    this.pilotDrawerAnimatedOpen = false;
    this.pilotDrawerClosing = false;
    this.wsFabOpen = false;
  }

  public override onActivate(): void {
    this.isViewActive = true;
    this.lastDirSig = "";
    this.lastWorkspaceControlsSig = "";
    this.lastPopoverSig = "";
    if (this.pendingRouteTarget) {
      this.resolvePendingRouteIfReady();
    } else {
      this.syncAll(false);
    }
  }
  private errorMsg = "";
  private dismissedOngoingRaceId = "";

  private lastDirSig = "";
  private lastWorkspaceControlsSig = "";
  private lastPopoverSig = "";
  private lastMobilePilotsSig = "";
  private lastMobileSectorsSig = "";
  private lastMobileSignalsSig = "";
  private lastWsLineupFitSig = "";
  private mobilePracticeTab: MobilePracticeTab = "overview";
  private selectedMobileSectorKeys = new Set<string>();
  private lastMobileSectorCourseSig = "";
  private practiceSignalsSlot: number | null = null;
  private lastFocusedPracticePilotSlot: number | null = null;
  private trendsExplicitAll = false;
  private practiceSignalsChart: PilotRssiChart | null = null;
  private practiceSignalsChartEl: HTMLElement | null = null;
  private practiceTrackView: ScopedTrackWorkspace | null = null;
  private practiceTrackEl: HTMLElement | null = null;
  private practiceTrackSessionId = "";
  private practiceAnalyticsView: PilotView | null = null;
  private practiceAnalyticsEl: HTMLElement | null = null;
  private dirOpenMenuSessionId = "";
  private pendingRouteTarget: PracticeRouteTarget | null = null;
  private resolvingSessionId = "";

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.workspaceStore = store.forPracticeWorkspace();
    this.trackEditorStore = store.forPracticeTrackEditor(() => this.store.selectedPracticeSession);
    this.api = api;
    this.scopedApi =
      typeof api.forScope === "function"
        ? api.forScope(() => {
            const id = this.store.selectedPracticeSession?.sessionId;
            return id ? { kind: "practice", id } : null;
          })
        : api;

    const curHash = getCurrentParsedHash();
    this.pendingRouteTarget = curHash.practice ?? curHash.live ?? { tab: "directory" };
    this.activeTab = "directory";
    try {
      this.dismissedOngoingRaceId =
        window.sessionStorage.getItem("slaprf.practice.dismissedOngoingRaceId") ?? "";
    } catch {
      this.dismissedOngoingRaceId = "";
    }

    el.innerHTML = `
      <div class="settings" data-slot="directory"></div>
      <div class="view-stack practice-workspace-page" data-slot="workspace" data-mobile-practice-view="overview" style="display:none">
        <div class="races-page-topbar practice-page-topbar" data-slot="mobile-topbar">
          <div class="rc-topbar-side is-left" aria-hidden="true"></div>
          <div class="rc-topleft-bar" data-practice-topleft-bar>
            <div class="sched-lineup-wrap rc-topleft-scroll-wrap">
              <button type="button" class="sched-lineup-cue is-left" data-lineup-scroll="-1" aria-label="Scroll tabs left" title="Scroll left" hidden>${icons.chevronLeft(14)}</button>
              <div class="rc-topleft-seg sched-lineup" role="tablist" aria-label="Practice workspace mode" data-fit-lineup>
                <button type="button" role="tab" aria-selected="false" class="rc-topleft-btn rc-mode-btn" data-practice-mobile-tab="pilots">
                  ${icons.pilot(15)}<span>Pilots</span>
                </button>
                <button type="button" role="tab" aria-selected="false" class="rc-topleft-btn rc-mode-btn" data-practice-mobile-tab="track">
                  ${icons.gate(15)}<span>Track</span>
                </button>
                <button type="button" role="tab" aria-selected="true" class="rc-topleft-btn rc-mode-btn is-active" data-practice-mobile-tab="overview">
                  ${icons.flag(15)}<span>Overview</span>
                </button>
                <button type="button" role="tab" aria-selected="false" class="rc-topleft-btn rc-mode-btn" data-practice-mobile-tab="laps">
                  ${icons.timer(15)}<span>Laps</span>
                </button>
                <button type="button" role="tab" aria-selected="false" class="rc-topleft-btn rc-mode-btn" data-practice-mobile-tab="trends">
                  ${icons.chart(15)}<span>Trends</span>
                </button>
                <button type="button" role="tab" aria-selected="false" class="rc-topleft-btn rc-mode-btn" data-practice-mobile-tab="signals">
                  ${icons.signal(15)}<span>Signals</span>
                </button>
                <button type="button" role="tab" aria-selected="false" class="rc-topleft-btn rc-mode-btn" data-practice-mobile-tab="analytics">
                  ${icons.chart(15)}<span>Analytics</span>
                </button>
              </div>
              <button type="button" class="sched-lineup-cue is-right" data-lineup-scroll="1" aria-label="Scroll tabs right" title="More tabs" hidden>${icons.chevronRight(14)}</button>
            </div>
          </div>
          <div class="rc-topbar-side is-right" aria-hidden="true"></div>
          <div class="ws-standby-host" data-slot="standby-bar"></div>
        </div>
        <div class="practice-workspace-stack">
          <div data-slot="workspace-banner"></div>
          <div class="picker-row practice-picker-row">
            <div class="practice-picker-left">
              <div data-slot="picker"></div>
              <div class="practice-pilot-add-wrap" data-slot="pilot-add"></div>
            </div>
          </div>
          <div class="practice-action-strip" data-slot="session-controls" data-practice-mobile-pane="overview" role="region" aria-label="Practice session status and controls"></div>
          <div class="view-stack practice-panel-stack" data-slot="panel"></div>
          <section class="card card-flush practice-mobile-pilots-card" data-slot="mobile-pilots" data-practice-mobile-pane="pilots"></section>
          <div class="practice-mobile-track-wrap" data-slot="mobile-track" data-practice-mobile-pane="track"></div>
          <div class="practice-mobile-sectors-wrap" data-slot="mobile-sectors" data-practice-mobile-pane="laps"></div>
          <section class="rc-canvas-panel rc-page-card is-signals-panel practice-mobile-signals-panel" data-slot="mobile-signals" data-practice-mobile-pane="signals"></section>
          <div class="practice-mobile-analytics-wrap" data-slot="mobile-analytics" data-practice-mobile-pane="analytics"></div>
        </div>
      </div>`;

    this.adopt(
      new PilotPicker(this.slot("picker"), this.workspaceStore, {
        includeAll: true,
        value: () => store.liveFocus,
        onSelect: (slot) => {
          if (slot !== null) {
            this.trendsExplicitAll = false;
            this.lastFocusedPracticePilotSlot = slot;
            this.practiceSignalsSlot = slot;
            this.practiceSignalsChart?.setPilotSlotOverride(slot);
          } else {
            this.trendsExplicitAll = true;
          }
          store.setLiveFocus(slot);
        },
      })
    );

    this.listen(el, "click", this.handleClick);
    this.listen(el, "input", this.handleInput);
    this.listen(el, "change", this.handleChange);
    this.listen(el, "keydown", this.handleKeyDown);
    this.listen(el, "focusout", this.handleFocusOut);
    this.listen(el, "pointerdown", this.handleDrawerPointerDown);
    this.listen(el, "pointermove", this.handleDrawerPointerMove);
    this.listen(el, "pointerup", this.handleDrawerPointerUp);
    this.listen(el, "pointercancel", this.handleDrawerPointerUp);

    const onDocPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node | null;
      if (
        this.dirOpenMenuSessionId &&
        (!target || !(target instanceof Element && target.closest(".dir-row-more-wrap")))
      ) {
        this.dirOpenMenuSessionId = "";
        this.lastDirSig = "";
        this.renderDirectory();
      }
      if (
        this.dirFabOpen &&
        (!target || !(target instanceof Element && target.closest(".dir-fab-menu")))
      ) {
        this.dirFabOpen = false;
        this.syncDirFabDom();
      }
      if (
        this.wsFabOpen &&
        (!target || !(target instanceof Element && target.closest("[data-practice-ws-fab]")))
      ) {
        this.wsFabOpen = false;
        this.syncWsFabDom();
      }
      if (!this.pilotPopoverOpen) return;
      const wrap = this.slot("pilot-add");
      if (
        !target ||
        (!wrap.contains(target) &&
          !(target instanceof Element && target.closest(".custom-select-popover")) &&
          !(target instanceof Element && target.closest("[data-practice-act=open-pilot-drawer]")) &&
          !(target instanceof Element && target.closest("[data-practice-act=toggle-pilot-popover]")))
      ) {
        this.dismissPilotPopoverOrDrawer();
      }
    };
    const onDocKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !e.defaultPrevented && this.pilotPopoverOpen) {
        this.dismissPilotPopoverOrDrawer();
      }
    };
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("keydown", onDocKeyDown);
    this.onDispose(() => {
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      document.removeEventListener("keydown", onDocKeyDown);
      if (this.mobileSessionDrawerCloseTimer !== null) {
        clearTimeout(this.mobileSessionDrawerCloseTimer);
        this.mobileSessionDrawerCloseTimer = null;
      }
      if (this.pilotDrawerCloseTimer !== null) {
        clearTimeout(this.pilotDrawerCloseTimer);
        this.pilotDrawerCloseTimer = null;
      }
      this.disposePracticeSignalsChart();
      this.disposePracticeTrackView();
      this.disposePracticeAnalyticsView();
      this.panel?.destroy();
      setPracticeTopBarContext({
        tab: "directory",
        sessionId: "",
        sessionName: "",
        active: false,
      });
    });

    this.onDispose(
      onPracticeRouteTargetChange((target) => {
        this.pendingRouteTarget = target;
        this.resolvePendingRouteIfReady();
      })
    );

    this.onDispose(
      onPracticeTopBarCommand((cmd) => {
        if (cmd.type === "set-tab") {
          this.pendingRouteTarget = null;
          this.setTab(cmd.tab, true);
        }
      })
    );

    this.onDispose(
      store.subscribe(["practice", "config", "laps", "crossings", "selection", "race", "status"], () => {
        if (this.store.liveFocus !== null) {
          this.trendsExplicitAll = false;
          this.lastFocusedPracticePilotSlot = this.store.liveFocus;
          this.practiceSignalsSlot = this.store.liveFocus;
          this.practiceSignalsChart?.setPilotSlotOverride(this.store.liveFocus);
        }
        if (!this.isViewActive) return;
        if (this.pendingRouteTarget) {
          this.resolvePendingRouteIfReady();
          return;
        }
        this.syncAll();
      })
    );

    this.resolvePendingRouteIfReady();
    this.syncAll();
  }

  private resolvePendingRouteIfReady(): void {
    const target = this.pendingRouteTarget;
    if (!target) return;

    if (target.tab === "directory") {
      this.pendingRouteTarget = null;
      this.resolvingSessionId = "";
      this.setTab("directory", false);
      return;
    }

    if (!this.store.hasHydrated && this.store.practiceSessions.length === 0) {
      return;
    }

    const sessions = this.store.practiceSessions;
    if (sessions.length === 0) {
      this.pendingRouteTarget = null;
      this.resolvingSessionId = "";
      this.activeTab = "directory";
      this.syncAll();
      return;
    }

    const matched = target.sessionId
      ? sessions.find((s) => {
          const reqTrim = target.sessionId!.trim();
          const reqLower = reqTrim.toLowerCase();
          const reqSlug = slugifyPracticeName(reqTrim);
          const sSlug = slugifyPracticeName(s.name || "Practice Session");
          return sSlug === reqLower || sSlug === reqSlug;
        }) ?? sessions.find((s) => s.sessionId === target.sessionId)
      : undefined;
    const desiredId =
      matched?.sessionId ||
      this.store.selectedPracticeSession?.sessionId ||
      sessions[0]?.sessionId ||
      "";

    if (!desiredId) {
      this.pendingRouteTarget = null;
      this.activeTab = "directory";
      this.syncAll();
      return;
    }

    if (this.store.selectedPracticeSession?.sessionId !== desiredId) {
      if (this.resolvingSessionId === desiredId) return;
      this.resolvingSessionId = desiredId;
      void this.api
        .practiceAction({ action: "select_session", sessionId: desiredId })
        .then(() => {
          this.resolvingSessionId = "";
          if (!this.disposed) {
            this.resolvePendingRouteIfReady();
          }
        })
        .catch((err) => {
          this.resolvingSessionId = "";
          this.pendingRouteTarget = null;
          this.reportErr(err);
        });
      return;
    }

    const requestedPane = (target.pane || "").trim().toLowerCase() as MobilePracticeTab;
    this.pendingRouteTarget = null;
    this.resolvingSessionId = "";
    this.setTab("session", false);
    if (
      requestedPane === "pilots" ||
      requestedPane === "track" ||
      requestedPane === "overview" ||
      requestedPane === "laps" ||
      requestedPane === "trends" ||
      requestedPane === "signals" ||
      requestedPane === "analytics"
    ) {
      this.setMobilePracticeTab(requestedPane, null, false);
    }
  }

  private setTab(next: PracticeViewTab, pushHistory = false): void {
    if (next === "session" && !this.store.selectedPracticeSession) {
      return;
    }
    const enteringSession = next === "session" && this.activeTab !== "session";
    this.activeTab = next;
    if (next === "directory") {
      this.pilotPopoverOpen = false;
    } else if (enteringSession) {
      this.mobilePracticeTab = "overview";
      if (this.store.liveFocus !== null) {
        this.store.setLiveFocus(null);
      }
      const wsEl = this.slot("workspace");
      wsEl.dataset.mobilePracticeView = "overview";
      wsEl.querySelectorAll<HTMLElement>("[data-practice-mobile-tab]").forEach((btn) => {
        const active = btn.dataset.practiceMobileTab === "overview";
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-selected", active ? "true" : "false");
      });
    }
    this.errorMsg = "";
    this.lastDirSig = "";
    this.lastWorkspaceControlsSig = "";
    this.lastPopoverSig = "";
    this.syncAll(pushHistory);
  }

  private reportErr = (err: unknown): void => {
    const raw = err instanceof Error ? err.message : String(err ?? "Action failed");
    const msg = cleanConnectionInvalidReason(raw) || raw.trim();
    this.errorMsg = "";
    showToast(msg, "error", { title: "Practice Session" });
  };

  private syncUrlAndTopBar(pushHistory = false): void {
    const sess = this.store.selectedPracticeSession;
    if (this.activeTab === "session" && !sess) {
      this.activeTab = "directory";
    }
    if (this.isViewActive) {
      setPracticeTopBarContext({
        tab: this.activeTab,
        sessionId: sess?.sessionId ?? "",
        sessionName: sess?.name ?? "",
        active: Boolean(sess?.active && !sess?.paused && this.store.raceArmed),
      });
    }

    if (getCurrentParsedHash().route !== "practice") return;
    if (!this.store.hasHydrated && this.pendingRouteTarget) return;
    const sessSlug = sess
      ? slugifyPracticeName(sess.name || "Practice Session")
      : undefined;
    const desiredHash =
      this.activeTab === "session"
        ? buildPracticeHash("session", sessSlug)
        : buildPracticeHash("directory");
    if (location.hash !== desiredHash) {
      if (pushHistory) {
        pushAppHash(desiredHash);
      } else {
        replaceAppHash(desiredHash);
      }
    }
  }

  private syncAll(pushHistory = false): void {
    const dirEl = this.slot("directory");
    const wsEl = this.slot("workspace");

    if (this.activeTab === "directory") {
      dirEl.style.display = "";
      wsEl.style.display = "none";
      this.disposePracticeSignalsChart();
      this.disposePracticeTrackView();
      this.disposePracticeAnalyticsView();
      this.renderDirectory();
    } else {
      dirEl.style.display = "none";
      wsEl.style.display = "";
      wsEl.dataset.mobilePracticeView = this.mobilePracticeTab;
      this.ensureSinglePilotFocusForMobileTab(this.mobilePracticeTab);
      this.renderWorkspaceChrome();
      const tab = this.mobilePracticeTab;
      if (tab === "signals") {
        if (this.panel) {
          this.panel.destroy();
          this.panel = undefined;
          this.shownFocus = undefined;
        }
        this.renderMobileSignalsPanel();
      } else if (tab === "pilots") {
        if (this.panel) {
          this.panel.destroy();
          this.panel = undefined;
          this.shownFocus = undefined;
        }
        this.renderMobilePilotsPanel();
      } else if (tab === "track") {
        if (this.panel) {
          this.panel.destroy();
          this.panel = undefined;
          this.shownFocus = undefined;
        }
        this.renderMobileTrackPanel();
      } else if (tab === "analytics") {
        if (this.panel) {
          this.panel.destroy();
          this.panel = undefined;
          this.shownFocus = undefined;
        }
        this.renderMobileAnalyticsPanel();
      } else {
        this.showPanel();
        if (tab === "laps") {
          this.renderMobileSectorsPanel();
        }
      }
      const lineupSig = `${tab}:${this.workspaceStore.enabledPilots.map((p) => `${p.slotIndex}:${p.callsign}`).join(",")}`;
      if (lineupSig !== this.lastWsLineupFitSig) {
        this.lastWsLineupFitSig = lineupSig;
        fitScheduleLineups(wsEl);
      }
    }
    this.syncUrlAndTopBar(pushHistory);
  }

  private scrollTabButtonIntoStrip(btn: HTMLElement | null | undefined): void {
    if (!btn) return;
    const track = btn.closest<HTMLElement>(".sched-lineup");
    if (!track) return;
    const maxScroll = track.scrollWidth - track.clientWidth;
    if (maxScroll <= 0) return;
    const trackRect = track.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const pad = 34;
    let targetLeft = track.scrollLeft;
    if (btnRect.left < trackRect.left + pad) {
      targetLeft += btnRect.left - (trackRect.left + pad);
    } else if (btnRect.right > trackRect.right - pad) {
      targetLeft += btnRect.right - (trackRect.right - pad);
    } else {
      return;
    }
    targetLeft = Math.max(0, Math.min(maxScroll, targetLeft));
    try {
      track.scrollTo({ left: targetLeft, behavior: "smooth" });
    } catch {
      track.scrollLeft = targetLeft;
    }
  }

  private ensureSinglePilotFocusForMobileTab(tab: MobilePracticeTab): void {
    if (this.store.liveFocus !== null) {
      this.lastFocusedPracticePilotSlot = this.store.liveFocus;
      this.practiceSignalsSlot = this.store.liveFocus;
    }
    if (tab === "overview") {
      if (this.store.liveFocus !== null) {
        this.store.setLiveFocus(null);
      }
      return;
    }
    if (
      tab !== "laps" &&
      tab !== "trends" &&
      tab !== "signals" &&
      tab !== "analytics"
    ) {
      return;
    }
    const enabled = this.workspaceStore.enabledPilots;
    if (enabled.length === 0) return;
    const cur = this.store.liveFocus;
    if (cur === null || !enabled.some((p) => p.slotIndex === cur)) {
      if (tab === "trends" && this.trendsExplicitAll) {
        return;
      }
      const preferred =
        this.lastFocusedPracticePilotSlot !== null &&
        enabled.some((p) => p.slotIndex === this.lastFocusedPracticePilotSlot)
          ? this.lastFocusedPracticePilotSlot
          : this.practiceSignalsSlot !== null &&
              enabled.some((p) => p.slotIndex === this.practiceSignalsSlot)
            ? this.practiceSignalsSlot
            : enabled[0].slotIndex;
      this.lastFocusedPracticePilotSlot = preferred;
      this.practiceSignalsSlot = preferred;
      this.store.setLiveFocus(preferred);
    }
    if (this.store.liveFocus !== null) {
      this.lastFocusedPracticePilotSlot = this.store.liveFocus;
      this.practiceSignalsSlot = this.store.liveFocus;
    }
  }

  private setMobilePracticeTab(
    nextTab: MobilePracticeTab,
    btnEl?: HTMLElement | null,
    forceFade = false
  ): void {
    const prevTab = this.mobilePracticeTab;
    this.mobilePracticeTab = nextTab;
    const wsEl = this.slot("workspace");
    wsEl.dataset.mobilePracticeView = nextTab;
    wsEl.querySelectorAll<HTMLElement>("[data-practice-mobile-tab]").forEach((btn) => {
      const active = btn.dataset.practiceMobileTab === nextTab;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    const activeBtn =
      btnEl ?? wsEl.querySelector<HTMLElement>(`[data-practice-mobile-tab="${nextTab}"]`);
    this.scrollTabButtonIntoStrip(activeBtn);
    if (nextTab === "overview") {
      if (this.store.liveFocus !== null) {
        this.lastFocusedPracticePilotSlot = this.store.liveFocus;
        this.practiceSignalsSlot = this.store.liveFocus;
        this.store.setLiveFocus(null);
      }
    } else {
      this.ensureSinglePilotFocusForMobileTab(nextTab);
    }
    if (nextTab === "pilots") {
      this.renderMobilePilotsPanel();
    } else if (nextTab === "track") {
      this.renderMobileTrackPanel();
    } else if (nextTab === "laps") {
      this.showPanel();
      this.renderMobileSectorsPanel();
    } else if (nextTab === "signals") {
      if (this.panel) {
        this.panel.destroy();
        this.panel = undefined;
        this.shownFocus = undefined;
      }
      this.renderMobileSignalsPanel(true);
    } else if (nextTab === "analytics") {
      if (this.panel) {
        this.panel.destroy();
        this.panel = undefined;
        this.shownFocus = undefined;
      }
      this.renderMobileAnalyticsPanel(true);
    } else {
      this.showPanel();
    }
    if (forceFade || prevTab !== nextTab) {
      const stackEl = wsEl.querySelector<HTMLElement>(".practice-workspace-stack");
      if (stackEl) {
        stackEl.classList.remove("is-ws-tab-enter");
        void stackEl.offsetWidth;
        stackEl.classList.add("is-ws-tab-enter");
      }
    }
    fitScheduleLineups(wsEl);
    window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
    });
  }

  // ---- Event Handlers ------------------------------------------------------

  private openPracticeSession(sid: string): void {
    if (!sid) return;
    this.errorMsg = "";
    this.editingNameForSessionId = "";
    this.editingTagsForSessionId = "";
    const selectPromise =
      this.store.selectedPracticeSession?.sessionId === sid
        ? Promise.resolve()
        : this.api.practiceAction({ action: "select_session", sessionId: sid });
    void selectPromise
      .then(() => {
        this.pendingRouteTarget = null;
        this.setTab("session", true);
      })
      .catch(this.reportErr);
  }

  private handleClick = (e: Event): void => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const mobileTabBtn = target.closest<HTMLButtonElement>("[data-practice-mobile-tab]");
    if (mobileTabBtn && !mobileTabBtn.disabled) {
      const nextTab = mobileTabBtn.dataset.practiceMobileTab as MobilePracticeTab | undefined;
      if (nextTab) {
        this.setMobilePracticeTab(nextTab, mobileTabBtn);
      }
      return;
    }

    const sectorToggleBtn = target.closest<HTMLButtonElement>("[data-practice-sector-toggle]");
    if (sectorToggleBtn && !sectorToggleBtn.disabled) {
      const key = sectorToggleBtn.dataset.practiceSectorToggle ?? "";
      if (key) {
        if (this.selectedMobileSectorKeys.has(key)) {
          this.selectedMobileSectorKeys.delete(key);
        } else if (this.selectedMobileSectorKeys.size < 3) {
          this.selectedMobileSectorKeys.add(key);
        }
        this.lastMobileSectorsSig = "";
        this.renderMobileSectorsPanel();
      }
      return;
    }

    const lapDeleteBtn = target.closest<HTMLButtonElement>("[data-practice-delete-lap]");
    if (lapDeleteBtn) {
      const lapId = Number(lapDeleteBtn.dataset.practiceDeleteLap ?? "0");
      if (lapId > 0) {
        this.store.deletePracticeLap(lapId);
        const sid = this.store.selectedPracticeSession?.sessionId;
        void this.api
          .practiceAction({ action: "delete_session_lap", sessionId: sid, lapId })
          .catch(this.reportErr);
      }
      return;
    }

    const lapToggleEl = target.closest<HTMLElement>("[data-practice-toggle-lap]");
    if (lapToggleEl) {
      const lapId = Number(lapToggleEl.dataset.practiceToggleLap ?? "0");
      if (lapId > 0) {
        this.store.togglePracticeLap(lapId);
        const sid = this.store.selectedPracticeSession?.sessionId;
        void this.api
          .practiceAction({ action: "toggle_session_lap", sessionId: sid, lapId })
          .catch(this.reportErr);
      }
      return;
    }

    const sigPilotBtn = target.closest<HTMLButtonElement>("[data-practice-sig-pilot]");
    if (sigPilotBtn) {
      const nextSlot = Number(sigPilotBtn.dataset.practiceSigPilot ?? "0");
      if (nextSlot > 0 && this.practiceSignalsSlot !== nextSlot) {
        this.practiceSignalsSlot = nextSlot;
        this.el.querySelectorAll<HTMLElement>("[data-practice-sig-pilot]").forEach((btn) => {
          btn.classList.toggle("is-active", btn.dataset.practiceSigPilot === String(nextSlot));
        });
        this.practiceSignalsChart?.setPilotSlotOverride(nextSlot);
        if (this.store.liveFocus !== nextSlot) {
          this.store.setLiveFocus(nextSlot);
        }
      }
      this.scrollTabButtonIntoStrip(sigPilotBtn);
      return;
    }

    const statusBtn = target.closest<HTMLButtonElement>("[data-session-dir-status]");
    if (statusBtn) {
      const nextSt = (statusBtn.dataset.sessionDirStatus || "all") as SessionDirStatusFilter;
      if (this.dirStatusFilter !== nextSt) {
        this.dirStatusFilter = nextSt;
        this.lastDirSig = "";
        this.renderDirectory(true);
      }
      return;
    }

    const filterBtn = target.closest<HTMLButtonElement>("[data-tag-filter]");
    if (filterBtn) {
      const rawTag = filterBtn.dataset.tagFilter ?? "";
      if (rawTag === "__all__") {
        this.selectedFilterTags.clear();
        this.untaggedOnly = false;
      } else if (rawTag === "__reset_all__") {
        this.dirSearchQuery = "";
        this.dirStatusFilter = "all";
        this.selectedFilterTags.clear();
        this.untaggedOnly = false;
      } else if (rawTag === "__untagged__") {
        this.untaggedOnly = !this.untaggedOnly;
        if (this.untaggedOnly) this.selectedFilterTags.clear();
      } else if (rawTag) {
        this.untaggedOnly = false;
        const key = rawTag.toLowerCase();
        if (this.selectedFilterTags.has(key)) {
          this.selectedFilterTags.delete(key);
        } else {
          this.selectedFilterTags.add(key);
        }
      }
      this.lastDirSig = "";
      this.renderDirectory(true);
      return;
    }

    const mobileSelectBtn = target.closest<HTMLButtonElement>("[data-mobile-session-select]");
    if (mobileSelectBtn) {
      e.stopPropagation();
      const sid = mobileSelectBtn.dataset.mobileSessionSelect ?? "";
      if (sid) {
        if (this.mobileSessionDrawerCloseTimer !== null) {
          clearTimeout(this.mobileSessionDrawerCloseTimer);
          this.mobileSessionDrawerCloseTimer = null;
        }
        if (this.mobileSelectedSessionId === sid && !this.mobileSessionDrawerClosing) {
          this.dismissMobileSessionDrawer();
        } else {
          this.mobileSessionDrawerClosing = false;
          this.mobileSelectedSessionId = sid;
          this.lastDirSig = "";
          this.renderDirectory(true);
        }
      }
      return;
    }

    if (target.closest("[data-mobile-session-close]")) {
      this.dismissMobileSessionDrawer();
      return;
    }

    const actBtn = target.closest<HTMLElement>("[data-practice-act]");
    if (actBtn) {
      if (actBtn instanceof HTMLButtonElement && actBtn.disabled) return;
      const act = actBtn.dataset.practiceAct ?? "";

      switch (act) {
        case "dismiss-err":
          this.errorMsg = "";
          this.lastDirSig = "";
          this.lastWorkspaceControlsSig = "";
          this.syncAll();
          return;

        case "dismiss-ongoing-race-note": {
          const ongoing = this.store.ongoingRace;
          if (ongoing?.raceId) {
            this.setDismissedOngoingRaceId(ongoing.raceId);
            const noteEl = this.el.querySelector<HTMLElement>("[data-practice-ongoing-race-note]");
            if (noteEl) {
              this.lastDirSig = this.computeDirSig(this.store.practiceSessions);
              noteEl.classList.add("is-leaving");
              window.setTimeout(() => {
                noteEl.remove();
              }, 230);
            } else {
              this.lastDirSig = "";
              this.renderDirectory(true);
            }
          }
          return;
        }

        case "toggle-dir-fab":
          this.dirFabOpen = !this.dirFabOpen;
          this.syncDirFabDom();
          return;

        case "create-session-inline": {
          this.createSessionInline(false);
          return;
        }

        case "open-session": {
          const sid = actBtn.dataset.sessionId ?? "";
          this.dirOpenMenuSessionId = "";
          this.mobileSelectedSessionId = "";
          this.lastOpenedMobileSessionId = "";
          this.openPracticeSession(sid);
          return;
        }

        case "toggle-dir-session-menu": {
          const sid = actBtn.dataset.sessionId ?? "";
          if (!sid) return;
          this.dirOpenMenuSessionId = this.dirOpenMenuSessionId === sid ? "" : sid;
          this.lastDirSig = "";
          this.renderDirectory();
          return;
        }

        case "dir-open-session-settings": {
          const sid = actBtn.dataset.sessionId ?? "";
          if (!sid) return;
          this.dirOpenMenuSessionId = "";
          this.lastDirSig = "";
          this.renderDirectory();
          const found = this.store.practiceSessions.find((s) => s.sessionId === sid);
          if (found) {
            this.openPracticeSessionSettingsModal(found);
          }
          return;
        }

        case "start-session": {
          const sid = actBtn.dataset.sessionId || this.store.selectedPracticeSession?.sessionId || "";
          if (!sid) return;
          this.errorMsg = "";
          this.startOrResumePracticeWithPreemptCheck("start_session", sid);
          return;
        }

        case "pause-session": {
          const sid = actBtn.dataset.sessionId || this.store.selectedPracticeSession?.sessionId || "";
          if (!sid) return;
          this.errorMsg = "";
          void this.api.practiceAction({ action: "pause_session", sessionId: sid }).catch(this.reportErr);
          return;
        }

        case "resume-session": {
          const sid = actBtn.dataset.sessionId || this.store.selectedPracticeSession?.sessionId || "";
          if (!sid) return;
          this.errorMsg = "";
          this.startOrResumePracticeWithPreemptCheck("resume_session", sid);
          return;
        }

        case "stop-session": {
          const sid = actBtn.dataset.sessionId || this.store.selectedPracticeSession?.sessionId || "";
          if (!sid) return;
          this.errorMsg = "";
          void this.api.practiceAction({ action: "stop_session", sessionId: sid }).catch(this.reportErr);
          return;
        }

        case "edit-session-name": {
          const sid = actBtn.dataset.sessionId ?? "";
          if (!sid) return;
          this.beginSessionNameEdit(sid);
          return;
        }

        case "edit-session-tags": {
          const sid = actBtn.dataset.sessionId ?? "";
          if (!sid) return;
          this.beginSessionTagsEdit(sid);
          return;
        }

        case "delete-session": {
          const sid = actBtn.dataset.sessionId ?? "";
          if (this.dirOpenMenuSessionId) {
            this.dirOpenMenuSessionId = "";
            this.lastDirSig = "";
            this.renderDirectory();
          }
          const found = this.store.practiceSessions.find((s) => s.sessionId === sid);
          if (!found) return;
          if (found.active) {
            this.reportErr(`Pause active session “${found.name}” before deleting it.`);
            return;
          }
          const lapCount = found.laps.length;
          openConfirmModal({
            title: `Delete Session “${found.name}”?`,
            messageHtml: `<p>Are you sure you want to permanently delete <strong>${esc(found.name)}</strong>?</p>`,
            warningHtml:
              lapCount > 0
                ? `This session contains <strong>${lapCount} recorded lap${lapCount === 1 ? "" : "s"}</strong> that will be permanently deleted.`
                : undefined,
            confirmLabel: "Delete Session",
            danger: true,
            onConfirm: () =>
              this.api
                .practiceAction({ action: "delete_session", sessionId: sid })
                .catch(this.reportErr),
          });
          return;
        }

        case "toggle-ws-fab":
          this.wsFabOpen = !this.wsFabOpen;
          this.syncWsFabDom();
          return;

        case "open-pilot-drawer": {
          this.wsFabOpen = false;
          this.syncWsFabDom();
          if (this.pilotDrawerCloseTimer !== null) {
            clearTimeout(this.pilotDrawerCloseTimer);
            this.pilotDrawerCloseTimer = null;
          }
          this.pilotDrawerClosing = false;
          this.pilotPopoverOpen = true;
          this.lastPopoverSig = "";
          this.renderPilotAddSlot();
          return;
        }

        case "toggle-pilot-popover":
          if (this.pilotPopoverOpen) {
            this.dismissPilotPopoverOrDrawer();
          } else {
            if (this.pilotDrawerCloseTimer !== null) {
              clearTimeout(this.pilotDrawerCloseTimer);
              this.pilotDrawerCloseTimer = null;
            }
            this.pilotDrawerClosing = false;
            this.pilotPopoverOpen = true;
            this.lastPopoverSig = "";
            this.renderPilotAddSlot();
          }
          return;

        case "toggle-session-pilot": {
          const sess = this.store.selectedPracticeSession;
          const slotIndex = Number(actBtn.dataset.slotIndex);
          if (!sess || !slotIndex) return;
          const isInSession = sess.pilots.some((p) => p.slotIndex === slotIndex);
          this.errorMsg = "";
          void this.api
            .practiceAction({
              action: isInSession ? "remove_session_pilot" : "add_session_pilot",
              sessionId: sess.sessionId,
              slotIndex,
            })
            .catch(this.reportErr);
          return;
        }

        case "close-pilot-popover":
          this.dismissPilotPopoverOrDrawer();
          return;

        case "add-session-pilot": {
          const sess = this.store.selectedPracticeSession;
          const slotIndex = Number(actBtn.dataset.slotIndex);
          if (!sess || !slotIndex) return;
          this.errorMsg = "";
          void this.api
            .practiceAction({
              action: "add_session_pilot",
              sessionId: sess.sessionId,
              slotIndex,
            })
            .catch(this.reportErr);
          return;
        }

        case "remove-session-pilot": {
          const sess = this.store.selectedPracticeSession;
          const slotIndex = Number(actBtn.dataset.slotIndex);
          if (!sess || !slotIndex) return;
          this.errorMsg = "";
          void this.api
            .practiceAction({
              action: "remove_session_pilot",
              sessionId: sess.sessionId,
              slotIndex,
            })
            .catch(this.reportErr);
          return;
        }

        case "create-and-add-pilot": {
          this.submitNewSessionPilot();
          return;
        }
      }
      return;
    }

    if (target.closest("[data-practice-pilot-backdrop]")) {
      this.dismissPilotPopoverOrDrawer();
      return;
    }

    const sessRow = target.closest<HTMLElement>("tr[data-session-row]");
    if (sessRow) {
      const sid = sessRow.dataset.sessionRow ?? "";
      if (sid && target.closest("td.races-table-name-cell") && !target.closest("input")) {
        this.beginSessionNameEdit(sid);
        return;
      }
      if (
        sid &&
        target.closest("td.races-table-tags-cell") &&
        !target.closest(".slaprf-tag-box, .race-tag-comma-wrap, input, button")
      ) {
        this.beginSessionTagsEdit(sid);
      }
    }
  };

  private startOrResumePracticeWithPreemptCheck(
    action: "start_session" | "resume_session",
    sid: string
  ): void {
    const targetSess = this.store.practiceSessions.find((s) => s.sessionId === sid);
    const targetName = targetSess?.name || "this practice session";
    const verb = action === "resume_session" ? "Resuming" : "Starting";
    const titleVerb = action === "resume_session" ? "Resume" : "Start";

    const ongoingRace = this.store.ongoingRace;
    const activeSess = this.store.activePracticeSession;
    const otherPracticeActive = Boolean(
      activeSess && activeSess.active && !activeSess.paused && activeSess.sessionId !== sid
    );

    if (ongoingRace) {
      const anyHeatRunning = (ongoingRace.heats ?? []).some(
        (h) => h.state === "running" || h.state === "countdown"
      );
      if (!anyHeatRunning && (ongoingRace.heats ?? []).some((h) => h.state === "paused")) {
        void this.api
          .practiceAction({ action, sessionId: sid, preemptOngoing: true })
          .catch(this.reportErr);
        return;
      }
      const raceName = ongoingRace.config.eventName || "Race";
      openConfirmPreemptModal({
        title: `Pause Ongoing Race & ${titleVerb} Practice?`,
        bodyHtml: `<p>Race <strong>${esc(raceName)}</strong> is currently ongoing.</p><p>${verb} <strong>${esc(targetName)}</strong> will pause <strong>${esc(raceName)}</strong> on the RF timers.</p>`,
        okLabel: `${titleVerb} Practice`,
        onConfirm: () =>
          this.api
            .practiceAction({ action, sessionId: sid, preemptOngoing: true })
            .catch(this.reportErr),
      });
      return;
    }

    if (otherPracticeActive && activeSess) {
      const otherName = activeSess.name || "Practice Session";
      openConfirmPreemptModal({
        title: `Pause Active Practice & ${titleVerb} Session?`,
        bodyHtml: `<p>Practice session <strong>${esc(otherName)}</strong> is currently active.</p><p>${verb} <strong>${esc(targetName)}</strong> will pause <strong>${esc(otherName)}</strong>.</p>`,
        okLabel: `${titleVerb} Session`,
        onConfirm: () =>
          this.api
            .practiceAction({ action, sessionId: sid, preemptOngoing: true })
            .catch(this.reportErr),
      });
      return;
    }

    void this.api.practiceAction({ action, sessionId: sid }).catch(this.reportErr);
  }

  private syncSessionPilotPopoverFilter(popEl: HTMLElement | null): void {
    if (!popEl) return;
    const inp = popEl.querySelector<HTMLInputElement>("input[data-new-session-pilot-input]");
    const createBtn = popEl.querySelector<HTMLButtonElement>('[data-practice-act="create-and-add-pilot"]');

    const trimmed = (inp?.value ?? "").trim();
    const needle = trimmed.toLowerCase();
    const exactGlobal = needle
      ? this.store.pilots.find((p) => p.callsign.trim().toLowerCase() === needle)
      : undefined;

    popEl
      .querySelectorAll<HTMLElement>("[data-practice-pilot-row]")
      .forEach((row) => {
        const hay = row.dataset.pilotSearchHay ?? "";
        const callsign = row.dataset.pilotCallsign ?? "";
        const show = !needle || hay.includes(needle);
        row.hidden = !show;
        row.classList.toggle("is-exact-match", !!needle && callsign === needle);
      });

    if (createBtn) {
      createBtn.disabled = !trimmed || !!exactGlobal;
      createBtn.title = exactGlobal
        ? `Pilot “${exactGlobal.callsign}” already exists`
        : trimmed
          ? `Create global pilot “${trimmed}” and add to this session`
          : "Search or type a unique callsign to add";
    }
  }

  private submitNewSessionPilot(): void {
    const sess = this.store.selectedPracticeSession;
    if (!sess) return;
    const popEl =
      this.pilotPopoverOpen
        ? this.el.querySelector<HTMLElement>("[data-slot='pilot-add'] .practice-pilot-popover")
        : this.el.querySelector<HTMLElement>("[data-slot='mobile-pilots'] .practice-pilot-popover") ??
          this.el.querySelector<HTMLElement>(".practice-pilot-popover");
    const inp = popEl?.querySelector<HTMLInputElement>("input[data-new-session-pilot-input]") ??
      this.el.querySelector<HTMLInputElement>("input[data-new-session-pilot-input]");
    const callsign = inp?.value.trim() ?? "";
    if (!callsign) {
      inp?.focus();
      return;
    }
    const dup = this.store.pilots.some(
      (p) => p.callsign.trim().toLowerCase() === callsign.toLowerCase()
    );
    if (dup) {
      this.syncSessionPilotPopoverFilter(popEl ?? null);
      return;
    }
    this.errorMsg = "";
    void this.api
      .practiceAction({
        action: "add_session_pilot",
        sessionId: sess.sessionId,
        callsign,
      })
      .then(() => {
        const freshPop =
          this.pilotPopoverOpen
            ? this.el.querySelector<HTMLElement>("[data-slot='pilot-add'] .practice-pilot-popover")
            : this.el.querySelector<HTMLElement>("[data-slot='mobile-pilots'] .practice-pilot-popover") ??
              this.el.querySelector<HTMLElement>(".practice-pilot-popover");
        const freshInp = freshPop?.querySelector<HTMLInputElement>("input[data-new-session-pilot-input]");
        if (freshInp) {
          freshInp.value = "";
          freshInp.focus();
        }
        this.syncSessionPilotPopoverFilter(freshPop ?? null);
      })
      .catch(this.reportErr);
  }

  private patchSessionRowsInlineDom(sessionIds: Iterable<string>): boolean {
    const dirHost = this.slot("directory");
    const uniqueIds = Array.from(new Set(Array.from(sessionIds).filter(Boolean)));
    if (uniqueIds.length === 0) return false;
    let patchedAll = true;
    for (const id of uniqueIds) {
      const tr = dirHost.querySelector<HTMLTableRowElement>(
        `tr[data-session-row="${CSS.escape(id)}"]`
      );
      const sess = this.store.practiceSessions.find((s) => s.sessionId === id);
      if (!tr || !sess) {
        patchedAll = false;
        continue;
      }
      const nameBox = tr.querySelector<HTMLElement>(
        "td.races-table-name-cell > .races-cell-box"
      );
      if (nameBox) {
        nameBox.innerHTML = this.renderSmartNameCell(id, sess.name || "Practice Session");
      }
      const tagsBox = tr.querySelector<HTMLElement>(
        "td.races-table-tags-cell > .races-cell-box"
      );
      if (tagsBox) {
        tagsBox.innerHTML = this.renderSmartTagsCell(id, sess.tags ?? []);
      }
    }
    if (patchedAll) {
      this.lastDirSig = this.computeDirSig(this.store.practiceSessions);
    }
    return patchedAll;
  }

  private beginSessionNameEdit(sid: string): void {
    const prevName = this.editingNameForSessionId;
    const prevTags = this.editingTagsForSessionId;
    this.editingNameForSessionId = sid;
    this.editingTagsForSessionId = "";
    if (!this.patchSessionRowsInlineDom([prevName, prevTags, sid])) {
      this.lastDirSig = "";
      this.renderDirectory(true);
    }
    const focusInput = () => {
      const inp = this.el.querySelector<HTMLInputElement>(
        `input[data-session-name-input="${CSS.escape(sid)}"]`
      );
      if (inp) {
        inp.focus();
        inp.select();
      }
    };
    focusInput();
    requestAnimationFrame(focusInput);
  }

  private beginSessionTagsEdit(sid: string): void {
    const prevName = this.editingNameForSessionId;
    const prevTags = this.editingTagsForSessionId;
    this.editingTagsForSessionId = sid;
    this.editingNameForSessionId = "";
    if (this.patchSessionRowsInlineDom([prevName, prevTags, sid])) {
      this.mountActiveSessionTagEditor(true);
    } else {
      this.lastDirSig = "";
      this.renderDirectory(true);
    }
  }

  private commitSessionNameInline(sid: string, rawValue: string): void {
    if (!sid) return;
    const found = this.store.practiceSessions.find((s) => s.sessionId === sid);
    if (this.editingNameForSessionId === sid) {
      this.editingNameForSessionId = "";
    }
    const nextName = rawValue.trim();
    if (!found || !nextName || found.name === nextName) {
      if (!this.patchSessionRowsInlineDom([sid])) {
        this.lastDirSig = "";
        this.renderDirectory(true);
      }
      return;
    }
    void this.api
      .practiceAction({ action: "rename_session", sessionId: sid, name: nextName })
      .then(() => {
        if (!this.patchSessionRowsInlineDom([sid])) {
          this.lastDirSig = "";
          this.renderDirectory(true);
        }
      })
      .catch(this.reportErr);
  }

  private commitSessionTagsList(sid: string, nextTags: string[]): void {
    if (!sid) return;
    const found = this.store.practiceSessions.find((s) => s.sessionId === sid);
    const curTags = found?.tags ?? [];
    const same =
      curTags.length === nextTags.length && curTags.every((v, idx) => v === nextTags[idx]);
    this.editingTagsForSessionId = "";
    if (!same) {
      void this.api
        .practiceAction({ action: "set_session_tags", sessionId: sid, tags: nextTags })
        .then(() => {
          this.lastDirSig = "";
          this.renderDirectory(true);
        })
        .catch(this.reportErr);
    } else if (!this.patchSessionRowsInlineDom([sid])) {
      this.lastDirSig = "";
      this.renderDirectory(true);
    }
  }

  private dismissMobileSessionDrawer(): void {
    if (!this.mobileSelectedSessionId || this.mobileSessionDrawerClosing) return;
    const dirHost = this.slot("directory");
    const overlay = dirHost.querySelector<HTMLElement>(".pilot-dir-mobile-drawer-overlay");
    if (!overlay) {
      this.mobileSelectedSessionId = "";
      this.lastOpenedMobileSessionId = "";
      this.lastDirSig = "";
      this.renderDirectory(true);
      return;
    }
    this.mobileSessionDrawerClosing = true;
    overlay.classList.add("is-closing");
    dirHost.querySelectorAll<HTMLElement>(".dir-mobile-chip.is-selected").forEach((chip) => {
      chip.classList.remove("is-selected");
      chip.setAttribute("aria-selected", "false");
    });
    if (this.mobileSessionDrawerCloseTimer !== null) {
      clearTimeout(this.mobileSessionDrawerCloseTimer);
    }
    this.mobileSessionDrawerCloseTimer = setTimeout(() => {
      this.mobileSessionDrawerCloseTimer = null;
      if (!this.mobileSessionDrawerClosing) return;
      this.mobileSessionDrawerClosing = false;
      this.mobileSelectedSessionId = "";
      this.lastOpenedMobileSessionId = "";
      this.lastDirSig = "";
      this.renderDirectory(true);
    }, 305);
  }

  private dismissPilotPopoverOrDrawer(): void {
    if (!this.pilotPopoverOpen || this.pilotDrawerClosing) return;
    const wrap = this.slot("pilot-add");
    const overlay = wrap.querySelector<HTMLElement>(".practice-pilot-drawer-overlay");
    const isMobile = window.matchMedia(
      "(max-width: 900px), (max-height: 540px) and (orientation: landscape) and (max-width: 1024px)"
    ).matches;
    if (!overlay || !isMobile) {
      this.pilotPopoverOpen = false;
      this.pilotDrawerAnimatedOpen = false;
      this.lastPopoverSig = "";
      this.renderPilotAddSlot();
      return;
    }
    this.pilotDrawerClosing = true;
    overlay.classList.add("is-closing");
    if (this.pilotDrawerCloseTimer !== null) {
      clearTimeout(this.pilotDrawerCloseTimer);
    }
    this.pilotDrawerCloseTimer = setTimeout(() => {
      this.pilotDrawerCloseTimer = null;
      if (!this.pilotDrawerClosing) return;
      this.pilotDrawerClosing = false;
      this.pilotPopoverOpen = false;
      this.pilotDrawerAnimatedOpen = false;
      this.lastPopoverSig = "";
      this.renderPilotAddSlot();
    }, 305);
  }

  private syncWsFabDom(): void {
    const wsEl = this.slot("workspace");
    const fabEl = wsEl.querySelector<HTMLElement>("[data-practice-ws-fab]");
    if (!fabEl) return;
    fabEl.classList.toggle("is-open", this.wsFabOpen);
    const drawer = fabEl.querySelector<HTMLElement>("[data-practice-ws-fab-drawer]");
    if (drawer) {
      drawer.setAttribute("aria-hidden", this.wsFabOpen ? "false" : "true");
      if (this.wsFabOpen) drawer.removeAttribute("inert");
      else drawer.setAttribute("inert", "");
    }
    const mainBtn = fabEl.querySelector<HTMLButtonElement>('[data-practice-act="toggle-ws-fab"]');
    if (mainBtn) {
      mainBtn.setAttribute("aria-expanded", this.wsFabOpen ? "true" : "false");
    }
  }

  private handleDrawerPointerDown = (e: PointerEvent): void => {
    const t = e.target as HTMLElement | null;
    if (!t || (!t.closest("[data-mobile-session-handle]") && !t.closest("[data-practice-pilot-handle]"))) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    this.mobileSessionDrawerDragStartY = e.clientY;
  };

  private handleDrawerPointerMove = (e: PointerEvent): void => {
    if (this.mobileSessionDrawerDragStartY === null) return;
    const dy = e.clientY - this.mobileSessionDrawerDragStartY;
    if (dy >= 22) {
      this.mobileSessionDrawerDragStartY = null;
      if (this.pilotPopoverOpen) {
        this.dismissPilotPopoverOrDrawer();
      } else {
        this.dismissMobileSessionDrawer();
      }
    }
  };

  private handleDrawerPointerUp = (): void => {
    this.mobileSessionDrawerDragStartY = null;
  };

  private mountActiveSessionTagEditor(autoFocus = true): void {
    const dirHost = this.slot("directory");
    if (this.mobileSelectedSessionId) {
      const drawerBox = dirHost.querySelector<HTMLElement>(
        `[data-tag-box="session-drawer-${CSS.escape(this.mobileSelectedSessionId)}"]`
      );
      if (drawerBox) {
        const found = this.store.practiceSessions.find(
          (s) => s.sessionId === this.mobileSelectedSessionId
        );
        mountTagPillEditor(drawerBox, {
          initialTags: found?.tags ?? [],
          placeholder: "Add tags (comma or Enter)…",
          autoFocus: false,
          onCommit: (nextTags) => this.commitSessionTagsList(this.mobileSelectedSessionId, nextTags),
        });
      }
    }
    const sid = this.editingTagsForSessionId;
    if (!sid) return;
    const boxEl = dirHost.querySelector<HTMLElement>(
      `[data-tag-box="session-row-${CSS.escape(sid)}"]`
    );
    if (!boxEl) return;
    const found = this.store.practiceSessions.find((s) => s.sessionId === sid);
    mountTagPillEditor(boxEl, {
      initialTags: found?.tags ?? [],
      placeholder: "Add tags (comma or Enter)…",
      autoFocus,
      onCommit: (nextTags) => this.commitSessionTagsList(sid, nextTags),
      onCancel: () => {
        if (this.editingTagsForSessionId === sid) {
          this.editingTagsForSessionId = "";
          if (!this.patchSessionRowsInlineDom([sid])) {
            this.lastDirSig = "";
            this.renderDirectory(true);
          }
        }
      },
    });
  }

  private handleInput = (e: Event): void => {
    const t = e.target as HTMLElement | null;
    if (t instanceof HTMLInputElement && t.hasAttribute("data-session-dir-search")) {
      this.dirSearchQuery = t.value;
      this.refreshDirectoryResultsDom();
      return;
    }
    if (t instanceof HTMLInputElement && t.hasAttribute("data-new-session-pilot-input")) {
      this.syncSessionPilotPopoverFilter(t.closest<HTMLElement>(".practice-pilot-popover"));
    }
  };

  private handleChange = (e: Event): void => {
    const t = e.target as HTMLElement | null;
    if (!t) return;

    if (t instanceof HTMLSelectElement && t.hasAttribute("data-session-pilot-channel")) {
      const sess = this.store.selectedPracticeSession;
      const slotIndex = Number(t.dataset.sessionPilotChannel);
      const rawVal = Number(t.value);
      if (!sess || !slotIndex || !Number.isFinite(rawVal)) return;
      const dec = decodeBandChannel(rawVal);
      const band = dec ? dec.band : BAND_RACEBAND;
      const channel = dec ? dec.channel : 0;
      void this.api
        .practiceAction({
          action: "set_session_pilot_channel",
          sessionId: sess.sessionId,
          slotIndex,
          band,
          channel,
        })
        .catch(this.reportErr);
    }
  };

  private handleFocusOut = (e: FocusEvent): void => {
    const t = e.target as HTMLElement | null;
    if (t instanceof HTMLInputElement && t.hasAttribute("data-session-name-input")) {
      const sid = t.dataset.sessionNameInput ?? "";
      const val = t.value;
      if (sid && (this.editingNameForSessionId === sid || this.mobileSelectedSessionId === sid)) {
        window.setTimeout(() => {
          if (this.editingNameForSessionId === sid || this.mobileSelectedSessionId === sid) {
            this.commitSessionNameInline(sid, val);
          }
        }, 0);
      }
    }
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null;
    if (!t) return;

    if (t instanceof HTMLInputElement && t.hasAttribute("data-session-name-input")) {
      const sid = t.dataset.sessionNameInput ?? "";
      if (e.key === "Enter") {
        e.preventDefault();
        if (sid) this.commitSessionNameInline(sid, t.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.editingNameForSessionId = "";
        if (!this.patchSessionRowsInlineDom([sid])) {
          this.lastDirSig = "";
          this.renderDirectory(true);
        }
      }
      return;
    }

    if (t instanceof HTMLInputElement && t.hasAttribute("data-session-dir-search")) {
      if (e.key === "Enter") {
        e.preventDefault();
        this.createSessionInline(true);
      } else if (e.key === "Escape" && this.dirSearchQuery) {
        e.preventDefault();
        this.dirSearchQuery = "";
        t.value = "";
        this.refreshDirectoryResultsDom();
      }
      return;
    }

    if (t instanceof HTMLInputElement && t.hasAttribute("data-new-session-pilot-input")) {
      if (e.key === "Enter") {
        e.preventDefault();
        this.submitNewSessionPilot();
      } else if (e.key === "Escape" && t.value) {
        e.preventDefault();
        t.value = "";
        this.syncSessionPilotPopoverFilter(t.closest<HTMLElement>(".practice-pilot-popover"));
      }
    }
  };

  // ---- Directory View (`#/live`) -------------------------------------------

  private renderSmartNameCell(
    sessionId: string,
    displayName: string
  ): string {
    if (this.editingNameForSessionId === sessionId) {
      return `
        <div class="race-name-edit-wrap">
          <input
            type="text"
            class="input input-sm races-inline-name"
            data-session-name-input="${esc(sessionId)}"
            value="${esc(displayName)}"
            placeholder="Session name"
            maxlength="64"
            autocomplete="off"
            aria-label="Edit session name"
          />
        </div>`;
    }
    return `
      <div class="race-name-smart-row">
        <div class="race-name-title-group">
          <button
            type="button"
            class="races-row-title-btn"
            data-practice-act="edit-session-name"
            data-session-id="${esc(sessionId)}"
            title="Click to rename session"
          >${esc(displayName)}</button>
        </div>
      </div>`;
  }

  private renderSmartTagsCell(sessionId: string, tags: string[]): string {
    if (this.editingTagsForSessionId === sessionId) {
      return `
        <div class="race-tag-comma-wrap">
          ${renderTagPillBoxHtml({
            boxId: `session-row-${sessionId}`,
            tags,
            placeholder: "Add tags (comma or Enter)…",
            compact: true,
            ariaLabel: "Edit session tags",
          })}
        </div>`;
    }

    const visibleTags = tags.slice(0, 3);
    const hiddenTags = tags.slice(3);
    const pillsMarkup =
      visibleTags.length > 0
        ? visibleTags
            .map((t) => {
              const isFiltered = this.selectedFilterTags.has(t.toLowerCase());
              return `<span class="race-tag-pill ${isFiltered ? "is-active" : ""}">#${esc(t)}</span>`;
            })
            .join("")
        : `<span class="note races-no-tags-note">Add tags…</span>`;

    const overflowMarkup =
      hiddenTags.length > 0
        ? `<span class="race-tag-overflow" title="${esc(hiddenTags.map((x) => `#${x}`).join(", "))}">+${hiddenTags.length}</span>`
        : "";

    return `
      <button
        type="button"
        class="race-tags-click-target"
        data-practice-act="edit-session-tags"
        data-session-id="${esc(sessionId)}"
        title="Click to edit tags"
        aria-label="Edit session tags"
      >${pillsMarkup}${overflowMarkup}</button>`;
  }

  private setDismissedOngoingRaceId(raceId: string): void {
    this.dismissedOngoingRaceId = raceId;
    try {
      if (raceId) {
        window.sessionStorage.setItem("slaprf.practice.dismissedOngoingRaceId", raceId);
      } else {
        window.sessionStorage.removeItem("slaprf.practice.dismissedOngoingRaceId");
      }
    } catch {
      // ignore storage restrictions
    }
  }

  private computeDirSig(sessions: PracticeSession[]): string {
    const ongoing = this.store.ongoingRace;
    if (!ongoing && this.dismissedOngoingRaceId) {
      this.setDismissedOngoingRaceId("");
    }
    const ongoingVisible =
      Boolean(ongoing) && ongoing!.raceId !== this.dismissedOngoingRaceId;
    const rowsSig = sessions
      .map((s) => {
        const best = fastestSessionLap(s);
        const trackSig = this.store
          .practiceSessionNodes(s)
          .nodes.map((g) => `${g.gateId}:${g.name ?? ""}:${g.timerLabel ?? ""}`)
          .join(",");
        return `${s.sessionId}:${s.name}:${(s.tags ?? []).join(",")}:${s.active ? 1 : 0}:${s.paused ? 1 : 0}:${s.pilots.length}:${s.laps.length}:${best ? best.sec.toFixed(3) : 0}:${trackSig}`;
      })
      .join("|");
    return [
      rowsSig,
      this.dirSearchQuery,
      this.dirStatusFilter,
      Array.from(this.selectedFilterTags).sort().join(","),
      this.untaggedOnly ? 1 : 0,
      this.editingNameForSessionId,
      this.editingTagsForSessionId,
      this.mobileSelectedSessionId,
      this.dirOpenMenuSessionId,
      this.dirFabOpen ? 1 : 0,
      ongoingVisible && ongoing ? `${ongoing.raceId}:${ongoing.config.eventName}` : "",
      this.errorMsg,
    ].join("::");
  }

  private computeSessionDirectoryViewModel(): {
    allSessions: PracticeSession[];
    filtered: PracticeSession[];
    sortedTags: Array<{ key: string; label: string; count: number }>;
    untaggedCount: number;
    liveCount: number;
    stoppedCount: number;
    withLapsCount: number;
    hasAnyFilter: boolean;
    isTagAllSelected: boolean;
    tableOrEmptyMarkup: string;
    footNote: string;
  } {
    const allSessions = this.store.practiceSessions;

    const tagDisplayByKey = new Map<string, string>();
    const tagCounts = new Map<string, number>();
    let untaggedCount = 0;
    let liveCount = 0;
    let stoppedCount = 0;
    let withLapsCount = 0;

    for (const s of allSessions) {
      const sTags = s.tags ?? [];
      if (sTags.length === 0) {
        untaggedCount++;
      } else {
        for (const t of sTags) {
          const key = t.toLowerCase();
          if (!tagDisplayByKey.has(key)) tagDisplayByKey.set(key, t);
          tagCounts.set(key, (tagCounts.get(key) ?? 0) + 1);
        }
      }
      if (s.active) liveCount++;
      else stoppedCount++;
      if (s.laps.length > 0) withLapsCount++;
    }

    for (const selKey of Array.from(this.selectedFilterTags)) {
      if (!tagDisplayByKey.has(selKey)) {
        this.selectedFilterTags.delete(selKey);
      }
    }

    const sortedTags = Array.from(tagDisplayByKey.entries())
      .map(([key, label]) => ({ key, label, count: tagCounts.get(key) ?? 0 }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));

    const isTagAllSelected = this.selectedFilterTags.size === 0 && !this.untaggedOnly;
    const rawQuery = this.dirSearchQuery.trim().toLowerCase();
    const cleanTagQuery = rawQuery.replace(/^#+/, "");
    const hasAnyFilter =
      !isTagAllSelected || this.dirStatusFilter !== "all" || rawQuery.length > 0;

    const filtered = allSessions.filter((s, idx) => {
      if (this.dirStatusFilter === "live" && !s.active) return false;
      if (this.dirStatusFilter === "stopped" && s.active) return false;
      if (this.dirStatusFilter === "laps" && s.laps.length === 0) return false;

      const sTags = s.tags ?? [];
      if (this.untaggedOnly && sTags.length > 0) return false;
      if (this.selectedFilterTags.size > 0) {
        const sKeys = new Set(sTags.map((t) => t.toLowerCase()));
        for (const reqKey of this.selectedFilterTags) {
          if (!sKeys.has(reqKey)) return false;
        }
      }

      if (rawQuery) {
        const dispName = (s.name || `Practice ${idx + 1}`).toLowerCase();
        const pilotMatch = s.pilots.some((p) => p.callsign.toLowerCase().includes(rawQuery));
        const tagMatch =
          cleanTagQuery.length > 0 &&
          sTags.some((t) => t.toLowerCase().includes(cleanTagQuery));
        const statusWord = s.active ? "live" : s.paused ? "paused idle" : "idle stopped";
        if (
          !dispName.includes(rawQuery) &&
          !pilotMatch &&
          !tagMatch &&
          !statusWord.includes(rawQuery)
        ) {
          return false;
        }
      }
      return true;
    });

    const tableOrEmptyMarkup =
      allSessions.length === 0
        ? `<div class="races-dir-empty">
            <div class="race-empty-icon">${icons.flag(28)}</div>
            <div class="races-dir-empty-title">No practice sessions yet</div>
            <p class="note">Click <strong>+ Session</strong> below to create a practice session inline, then click the row to open it and record laps.</p>
          </div>`
        : filtered.length === 0
          ? `<div class="races-dir-empty">
              <div class="race-empty-icon">${icons.search(26)}</div>
              <div class="races-dir-empty-title">No sessions match current filter</div>
              <p class="note">Adjust your search, status filter, or tag selection above to view practice sessions.</p>
              <div style="margin-top:8px">
                <button type="button" class="btn btn-ghost btn-sm" data-tag-filter="__reset_all__">Show all (${allSessions.length})</button>
              </div>
            </div>`
          : `<div class="table-scroll">
              <table class="table races-table">
                <thead>
                  <tr>
                    <th class="races-col-name">Session</th>
                    <th class="races-col-type">Summary</th>
                    <th class="races-col-tags">Tags</th>
                    <th class="races-col-date">Date</th>
                    <th class="races-col-status">Status</th>
                    <th class="races-col-actions" aria-label="Open"></th>
                  </tr>
                </thead>
                <tbody>
                  ${filtered
                    .map((s, idx) => {
                      const sid = s.sessionId;
                      const pilotCount = s.pilots.length;
                      const lapCount = s.laps.length;
                      const trackInfo = this.store.practiceSessionNodes(s);
                      const gateCount = trackInfo.nodes.length;
                      const createdText = formatShortSessionDate(s.createdAt) || "—";
                      const summaryShort = `${pilotCount} pilot${pilotCount === 1 ? "" : "s"} · ${lapCount} lap${lapCount === 1 ? "" : "s"}`;
                      const best = fastestSessionLap(s);
                      const bestNote = best
                        ? `Best ${fmtTime(best.sec)}s (${best.callsign})`
                        : "No laps yet";
                      const summaryTip = `${summaryShort} · ${gateCount} gate${gateCount === 1 ? "" : "s"}${trackInfo.historical ? " (snapshot)" : ""} · ${bestNote}`;
                      const statusLabel = s.active ? "Live" : s.paused ? "Paused" : "Idle";
                      const statusCls = s.active ? "is-live" : s.paused ? "is-paused" : "is-waiting";
                      const dispName = s.name || `Practice ${idx + 1}`;

                      return `
                        <tr class="${s.active ? "is-current-race" : ""}" data-session-row="${esc(sid)}">
                          <td class="races-col-name races-table-name-cell">
                            <div class="races-cell-box is-single">
                              ${this.renderSmartNameCell(sid, dispName)}
                            </div>
                          </td>
                          <td class="races-col-type">
                            <div class="races-cell-box is-single">
                              <span class="races-table-type-text" title="${esc(summaryTip)}">${esc(summaryShort)}</span>
                            </div>
                          </td>
                          <td class="races-col-tags races-table-tags-cell">
                            <div class="races-cell-box is-single">
                              ${this.renderSmartTagsCell(sid, s.tags ?? [])}
                            </div>
                          </td>
                          <td class="races-col-date">
                            <div class="races-cell-box is-single">
                              <span class="races-table-date" title="${esc(s.createdAt ?? "")}">${esc(createdText)}</span>
                            </div>
                          </td>
                          <td class="races-col-status races-table-status-col">
                            <div class="races-cell-box is-single">
                              <div class="races-table-status-cell">
                                <span class="race-state-pill ${statusCls}" title="${esc(`${statusLabel} · ${bestNote}`)}">${statusLabel}</span>
                              </div>
                            </div>
                          </td>
                          <td class="races-col-actions">
                            <div class="races-cell-box is-single">
                              <div class="races-row-actions">
                                <button
                                  type="button"
                                  class="btn btn-ghost btn-xs dir-open-btn"
                                  data-practice-act="open-session"
                                  data-session-id="${esc(sid)}"
                                  title="Open session workspace"
                                  aria-label="Open session workspace"
                                >Open</button>
                                <div class="dir-row-more-wrap">
                                  <button
                                    type="button"
                                    class="btn btn-ghost btn-xs dir-row-more-btn ${this.dirOpenMenuSessionId === sid ? "is-open" : ""}"
                                    data-practice-act="toggle-dir-session-menu"
                                    data-session-id="${esc(sid)}"
                                    title="Session options"
                                    aria-label="Options for ${esc(dispName)}"
                                    aria-haspopup="menu"
                                    aria-expanded="${this.dirOpenMenuSessionId === sid ? "true" : "false"}"
                                  >${icons.moreHorizontal(15)}</button>
                                  ${
                                    this.dirOpenMenuSessionId === sid
                                      ? `<div class="dir-row-more-menu" role="menu" aria-label="Options for ${esc(dispName)}">
                                           <button
                                             type="button"
                                             class="dir-row-more-item"
                                             role="menuitem"
                                             data-practice-act="dir-open-session-settings"
                                             data-session-id="${esc(sid)}"
                                           ><span>Settings</span></button>
                                           <button
                                             type="button"
                                             class="dir-row-more-item"
                                             role="menuitem"
                                             data-practice-act="delete-session"
                                             data-session-id="${esc(sid)}"
                                             ${s.active ? "disabled" : ""}
                                             title="${s.active ? "Pause this live session before deleting" : "Delete session"}"
                                           ><span>Delete</span></button>
                                         </div>`
                                      : ""
                                  }
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>`;
                    })
                    .join("")}
                </tbody>
              </table>
            </div>
            <div class="dir-mobile-mosaic" role="listbox" aria-label="Practice sessions">
              ${filtered
                .map((s, idx) => {
                  const sid = s.sessionId;
                  const pilotCount = s.pilots.length;
                  const lapCount = s.laps.length;
                  const summaryShort = `${pilotCount}p · ${lapCount}L`;
                  const statusLabel = s.active ? "Live" : s.paused ? "Paused" : "Idle";
                  const statusCls = s.active ? "is-live" : s.paused ? "is-paused" : "is-waiting";
                  const dispName = s.name || `Practice ${idx + 1}`;
                  const isSelected = this.mobileSelectedSessionId === sid;
                  return `
                    <div
                      role="option"
                      tabindex="0"
                      aria-selected="${isSelected ? "true" : "false"}"
                      class="dir-mobile-chip ${isSelected ? "is-selected" : ""} ${s.active ? "is-live" : ""}"
                      data-practice-act="open-session"
                      data-session-id="${esc(sid)}"
                    >
                      <div class="dir-mobile-chip-top">
                        <div class="dir-mobile-chip-badges">
                          <span class="race-state-pill ${statusCls}">${statusLabel}</span>
                        </div>
                        <button
                          type="button"
                          class="dir-mobile-chip-more-btn"
                          data-mobile-session-select="${esc(sid)}"
                          title="Session options"
                          aria-label="Options for ${esc(dispName)}"
                        >${icons.moreHorizontal(16)}</button>
                      </div>
                      <strong class="dir-mobile-chip-title">${esc(dispName)}</strong>
                      <span class="dir-mobile-chip-sub">${esc(summaryShort)}</span>
                    </div>`;
                })
                .join("")}
            </div>
            ${this.renderMobileSessionDrawer(allSessions)}`;

    const footNote =
      allSessions.length === 0
        ? "No sessions created yet · Click + Session to add one inline."
        : hasAnyFilter
          ? `Showing ${filtered.length} of ${allSessions.length} session${allSessions.length === 1 ? "" : "s"}`
          : `${allSessions.length} session${allSessions.length === 1 ? "" : "s"} · Click a name or tag cell to edit inline, or click Open to view.`;

    return {
      allSessions,
      filtered,
      sortedTags,
      untaggedCount,
      liveCount,
      stoppedCount,
      withLapsCount,
      hasAnyFilter,
      isTagAllSelected,
      tableOrEmptyMarkup,
      footNote,
    };
  }

  private renderMobileSessionDrawer(allSessions: PracticeSession[]): string {
    if (!this.mobileSelectedSessionId) {
      this.lastOpenedMobileSessionId = "";
      return "";
    }
    const idx = allSessions.findIndex((s) => s.sessionId === this.mobileSelectedSessionId);
    const s = idx >= 0 ? allSessions[idx] : undefined;
    if (!s) {
      this.lastOpenedMobileSessionId = "";
      return "";
    }
    const sid = s.sessionId;
    const shouldAnimateEntry = this.lastOpenedMobileSessionId !== sid;
    this.lastOpenedMobileSessionId = sid;

    const dispName = s.name || `Practice ${idx + 1}`;
    const statusLabel = s.active ? "Live" : s.paused ? "Paused" : "Idle";
    const statusCls = s.active ? "is-live" : s.paused ? "is-paused" : "is-waiting";
    const pilotCount = s.pilots.length;
    const lapCount = s.laps.length;
    const summaryShort = `${pilotCount} pilot${pilotCount === 1 ? "" : "s"} · ${lapCount} lap${lapCount === 1 ? "" : "s"}`;
    const best = fastestSessionLap(s);
    const bestNote = best ? `${fmtTime(best.sec)}s (${best.callsign})` : "No laps yet";
    const trackInfo = this.store.practiceSessionNodes(s);
    const gateCount = trackInfo.nodes.length;
    const createdText = formatShortSessionDate(s.createdAt) || "—";

    return `
      <div class="pilot-dir-mobile-drawer-overlay" role="dialog" aria-modal="true" aria-label="Edit ${esc(dispName)}">
        <div class="pilot-dir-mobile-drawer-backdrop" data-mobile-session-close></div>
        <div class="pilot-dir-mobile-editor ${shouldAnimateEntry ? "is-entering" : ""}" data-mobile-session-drawer>
          <div class="dir-mobile-drawer-top-bar" data-mobile-session-handle>
            <button
              type="button"
              class="pilot-dir-mobile-drawer-handle"
              data-mobile-session-handle
              data-mobile-session-close
              aria-label="Dismiss session editor"
              title="Pull down or tap to dismiss"
            >
              <span class="pilot-dir-mobile-drawer-grip" aria-hidden="true"></span>
            </button>
            <div class="dir-mobile-drawer-top-status">
              <span class="race-state-pill ${statusCls}">${statusLabel}</span>
            </div>
          </div>
          <div class="pilot-dir-mobile-grid">
            <label class="field">
              <span>Session name</span>
              <input
                type="text"
                class="input"
                data-session-name-input="${esc(sid)}"
                value="${esc(dispName)}"
                placeholder="Session name"
                maxlength="64"
                autocomplete="off"
              />
            </label>
            <div class="field">
              <span>Tags</span>
              ${renderTagPillBoxHtml({
                boxId: `session-drawer-${sid}`,
                tags: s.tags ?? [],
                placeholder: "Add tags (comma or Enter)…",
                compact: false,
                ariaLabel: "Edit session tags",
              })}
            </div>
            <div class="dir-mobile-drawer-meta-grid">
              <div class="dir-mobile-drawer-meta-item">
                <span class="note">Summary</span>
                <strong>${esc(summaryShort)}</strong>
              </div>
              <div class="dir-mobile-drawer-meta-item">
                <span class="note">Best lap</span>
                <strong>${esc(bestNote)}</strong>
              </div>
              <div class="dir-mobile-drawer-meta-item">
                <span class="note">Track</span>
                <strong>${gateCount} gate${gateCount === 1 ? "" : "s"}</strong>
              </div>
              <div class="dir-mobile-drawer-meta-item">
                <span class="note">Created</span>
                <strong>${esc(createdText)}</strong>
              </div>
            </div>
          </div>
          <div class="dir-mobile-drawer-actions is-single-action">
            <button
              type="button"
              class="btn btn-ghost dir-mobile-drawer-btn"
              data-practice-act="delete-session"
              data-session-id="${esc(sid)}"
              ${s.active ? "disabled" : ""}
              title="${s.active ? "Pause this live session before deleting" : "Delete session"}"
            >${icons.trash(15)}<span>Delete</span></button>
          </div>
        </div>
      </div>`;
  }

  private findExactSessionByName(
    name: string,
    allSessions = this.store.practiceSessions
  ): PracticeSession | undefined {
    const trimmed = name.trim().toLowerCase();
    if (!trimmed || trimmed.startsWith("#")) return undefined;
    return allSessions.find(
      (s, idx) => (s.name || `Practice ${idx + 1}`).trim().toLowerCase() === trimmed
    );
  }

  private createSessionInline(fromEnterKey = false): void {
    const allSessions = this.store.practiceSessions;
    const trimmedQuery = this.dirSearchQuery.trim();
    if (fromEnterKey && (!trimmedQuery || trimmedQuery.startsWith("#"))) {
      return;
    }
    const exactMatch = this.findExactSessionByName(trimmedQuery, allSessions);
    if (exactMatch) {
      return;
    }
    const customName = !trimmedQuery.startsWith("#") ? trimmedQuery : "";
    this.dirFabOpen = false;
    this.dirSearchQuery = "";
    const searchEl = this.el.querySelector<HTMLInputElement>("[data-session-dir-search]");
    if (searchEl) searchEl.value = "";
    this.dirStatusFilter = "all";
    this.selectedFilterTags.clear();
    this.untaggedOnly = false;
    this.editingNameForSessionId = "";
    this.editingTagsForSessionId = "";
    this.errorMsg = "";
    void this.api
      .practiceAction({
        action: "create_session",
        ...(customName ? { name: customName } : {}),
        dontSelect: true,
      })
      .then(() => {
        this.lastDirSig = "";
        this.renderDirectory(true);
      })
      .catch(this.reportErr);
  }

  private refreshDirectoryResultsDom(): void {
    const dirHost = this.slot("directory");
    const resultsEl = dirHost.querySelector<HTMLElement>("[data-session-dir-results]");
    if (!resultsEl) {
      this.lastDirSig = "";
      this.renderDirectory();
      return;
    }
    const vm = this.computeSessionDirectoryViewModel();
    const prevOverlay = resultsEl.querySelector<HTMLElement>(".pilot-dir-mobile-drawer-overlay");
    if (prevOverlay && this.mobileSelectedSessionId && !this.mobileSessionDrawerClosing) {
      const temp = document.createElement("div");
      temp.innerHTML = vm.tableOrEmptyMarkup;
      const nextOverlay = temp.querySelector<HTMLElement>(".pilot-dir-mobile-drawer-overlay");
      const prevEditor = prevOverlay.querySelector<HTMLElement>(".pilot-dir-mobile-editor");
      const nextEditor = nextOverlay?.querySelector<HTMLElement>(".pilot-dir-mobile-editor");
      const prevMosaic = resultsEl.querySelector<HTMLElement>(".dir-mobile-mosaic");
      const nextMosaic = temp.querySelector<HTMLElement>(".dir-mobile-mosaic");
      const prevTable = resultsEl.querySelector<HTMLElement>(".table-scroll-shell, .table-scroll");
      const nextTable = temp.querySelector<HTMLElement>(".table-scroll");
      if (prevEditor && nextEditor && prevMosaic && nextMosaic) {
        nextEditor.classList.remove("is-entering");
        prevEditor.replaceWith(nextEditor);
        prevMosaic.replaceWith(nextMosaic);
        if (prevTable && nextTable) {
          prevTable.replaceWith(nextTable);
        }
      } else {
        resultsEl.innerHTML = vm.tableOrEmptyMarkup;
      }
    } else {
      resultsEl.innerHTML = vm.tableOrEmptyMarkup;
    }
    const footEl = dirHost.querySelector<HTMLElement>("[data-session-dir-foot-note]");
    if (footEl) footEl.textContent = vm.footNote;
    const clearWrap = dirHost.querySelector<HTMLElement>("[data-session-dir-clear-wrap]");
    if (clearWrap) {
      clearWrap.innerHTML = vm.hasAnyFilter
        ? `<button type="button" class="btn btn-ghost btn-xs" data-tag-filter="__reset_all__">Clear (${vm.filtered.length}/${vm.allSessions.length})</button>`
        : "";
    }
    const trimmedSearch = this.dirSearchQuery.trim();
    const exactMatch = this.findExactSessionByName(trimmedSearch, vm.allSessions);
    const addBtn = dirHost.querySelector<HTMLButtonElement>(
      '[data-practice-act="create-session-inline"]'
    );
    if (addBtn) {
      addBtn.disabled = Boolean(exactMatch);
      addBtn.title = exactMatch
        ? `Practice “${exactMatch.name || trimmedSearch}” already exists`
        : trimmedSearch && !trimmedSearch.startsWith("#")
          ? `Add practice “${trimmedSearch}”`
          : "Add Practice";
    }
    this.mountActiveSessionTagEditor(false);
    this.lastDirSig = this.computeDirSig(this.store.practiceSessions);
  }

  private syncDirFabDom(): void {
    const dirHost = this.slot("directory");
    const fabEl = dirHost.querySelector<HTMLElement>(".dir-fab-menu");
    if (!fabEl) return;
    fabEl.classList.toggle("is-open", this.dirFabOpen);
    const drawer = fabEl.querySelector<HTMLElement>(".rc-fab-drawer");
    if (drawer) {
      drawer.setAttribute("aria-hidden", this.dirFabOpen ? "false" : "true");
      if (this.dirFabOpen) drawer.removeAttribute("inert");
      else drawer.setAttribute("inert", "");
    }
    const mainBtn = fabEl.querySelector<HTMLButtonElement>(".rc-fab-main");
    if (mainBtn) {
      mainBtn.setAttribute("aria-expanded", this.dirFabOpen ? "true" : "false");
    }
    this.lastDirSig = this.computeDirSig(this.store.practiceSessions);
  }

  private renderDirectory(force = false): void {
    const dirHost = this.slot("directory");
    const activeEl = document.activeElement;
    if (
      !force &&
      activeEl instanceof HTMLInputElement &&
      dirHost.contains(activeEl) &&
      ((activeEl.hasAttribute("data-session-name-input") &&
        Boolean(this.editingNameForSessionId)) ||
        (activeEl.hasAttribute("data-tag-box-input") &&
          Boolean(this.editingTagsForSessionId)) ||
        activeEl.hasAttribute("data-session-dir-search"))
    ) {
      return;
    }

    const allSessions = this.store.practiceSessions;
    const sig = this.computeDirSig(allSessions);
    if (sig === this.lastDirSig) return;
    this.lastDirSig = sig;

    const ongoingRace = this.store.ongoingRace;
    const vm = this.computeSessionDirectoryViewModel();
    const {
      filtered,
      liveCount,
      stoppedCount,
      withLapsCount,
      hasAnyFilter,
      tableOrEmptyMarkup,
    } = vm;

    const trimmedSearch = this.dirSearchQuery.trim();
    const exactMatch = this.findExactSessionByName(trimmedSearch, allSessions);
    const addDisabled = Boolean(exactMatch);
    const addBtnTitle = exactMatch
      ? `Practice “${exactMatch.name || trimmedSearch}” already exists`
      : trimmedSearch && !trimmedSearch.startsWith("#")
        ? `Add practice “${trimmedSearch}”`
        : "Add Practice";

    const filterToolbarMarkup = `
      <div class="dir-filter-toolbar" data-session-dir-toolbar>
        <div class="dir-filter-main-row">
          <div class="dir-filter-search-bar">
            <div class="dir-filter-search-row">
              ${icons.search(14)}
              <input
                type="search"
                class="input dir-filter-search-input"
                data-session-dir-search
                placeholder="Search or add practice..."
                aria-label="Search or add practice"
                value="${esc(this.dirSearchQuery)}"
                autocomplete="off"
              />
            </div>
            <button type="button" class="btn btn-unarmed" data-practice-act="create-session-inline" ${addDisabled ? "disabled" : ""} title="${esc(addBtnTitle)}" aria-label="Add Practice">${icons.plus(14)}<span>Add</span></button>
          </div>
          <div class="dir-filter-right">
            <div class="segmented dir-filter-seg" role="tablist" aria-label="Filter practice sessions by status">
              <button type="button" class="${this.dirStatusFilter === "all" ? "is-active" : ""}" data-session-dir-status="all">
                All (${allSessions.length})
              </button>
              <button type="button" class="${this.dirStatusFilter === "live" ? "is-active" : ""}" data-session-dir-status="live">
                Live (${liveCount})
              </button>
              <button type="button" class="${this.dirStatusFilter === "stopped" ? "is-active" : ""}" data-session-dir-status="stopped">
                Idle (${stoppedCount})
              </button>
              <button type="button" class="${this.dirStatusFilter === "laps" ? "is-active" : ""}" data-session-dir-status="laps">
                With Laps (${withLapsCount})
              </button>
            </div>
            <span data-session-dir-clear-wrap>${
              hasAnyFilter
                ? `<button type="button" class="btn btn-ghost btn-xs" data-tag-filter="__reset_all__">Clear (${filtered.length}/${allSessions.length})</button>`
                : ""
            }</span>
          </div>
        </div>
      </div>`;

    const showOngoingNote =
      Boolean(ongoingRace) && ongoingRace!.raceId !== this.dismissedOngoingRaceId;
    const ongoingRaceName = ongoingRace?.config.eventName?.trim() || "Live race";
    const ongoingRacePrefix = /^race\b/i.test(ongoingRaceName) ? "" : "Race ";
    const ongoingNote = showOngoingNote && ongoingRace
      ? `<div class="practice-ongoing-race-note" role="status" data-practice-ongoing-race-note>
          <div class="practice-ongoing-race-note-body">
            ${icons.checkered(14)}
            <span>${ongoingRacePrefix}<strong>${esc(ongoingRaceName)}</strong> is currently live on RF hardware. Pause or complete it in <a href="#/races">Race</a> before starting a practice session.</span>
          </div>
          <button
            type="button"
            class="practice-ongoing-race-dismiss"
            data-practice-act="dismiss-ongoing-race-note"
            title="Dismiss notice"
            aria-label="Dismiss live race notice"
          >${icons.close(14)}</button>
        </div>`
      : "";

    dirHost.innerHTML = `
      <section class="settings-section is-single-col">
        <div class="settings-cards">
          ${ongoingNote}
          <div class="card card-flush races-dir-card">
            ${filterToolbarMarkup}
            <div data-session-dir-results>${tableOrEmptyMarkup}</div>
          </div>
        </div>
      </section>`;
    this.mountActiveSessionTagEditor(true);
  }

  // ---- Session Workspace (`#/live/session`) --------------------------------

  private renderWorkspaceChrome(): void {
    const sess = this.store.selectedPracticeSession;
    const ongoingRace = this.store.ongoingRace;
    const trackInfo = this.store.practiceSessionNodes(sess);
    const trackSig = trackInfo.nodes
      .map((g) => `${g.gateId}:${g.name ?? ""}:${g.timerLabel ?? ""}:${g.color ?? ""}`)
      .join(",");
    const focusSlot = this.store.liveFocus;
    const controlsSig = [
      sess?.sessionId ?? "",
      sess?.active ? 1 : 0,
      sess?.paused ? 1 : 0,
      this.store.raceArmed ? 1 : 0,
      sess?.pilots.length ?? 0,
      sess?.laps.length ?? 0,
      focusSlot ?? "all",
      trackInfo.historical ? 1 : 0,
      trackSig,
      ongoingRace?.raceId ?? "",
      ongoingRace?.config.eventName ?? "",
      this.errorMsg,
    ].join(":");

    if (controlsSig !== this.lastWorkspaceControlsSig) {
      this.lastWorkspaceControlsSig = controlsSig;
      const bannerEl = this.slot("workspace-banner");
      bannerEl.innerHTML = "";

      const topbarEl = this.slot("mobile-topbar");
      const standbyEl = this.slot("standby-bar");
      const ctrlEl = this.slot("session-controls");
      if (sess) {
        const isActive = Boolean(sess.active && !sess.paused && this.store.raceArmed);
        const isPaused = Boolean(sess.paused || (sess.active && !this.store.raceArmed));
        const statusKey = isActive ? "active" : isPaused ? "paused" : "idle";
        const ledDotClass = isActive ? "is-up" : "";
        const statusTitle = isActive
          ? "Live RF timing active"
          : isPaused
            ? "Practice session paused"
            : "Practice session idle";

        topbarEl.classList.toggle("is-ws-live", isActive);
        topbarEl.classList.toggle("is-ws-standby", !isActive);

        const toggleAction = isActive
          ? "pause-session"
          : isPaused
            ? "resume-session"
            : "start-session";
        const toggleText = isActive
          ? "Pause"
          : isPaused
            ? "Resume"
            : "Start";
        const toggleTitle = isActive
          ? "Pause live RF timing for this practice session"
          : ongoingRace
            ? `Race '${ongoingRace.config.eventName}' is ongoing - click to pause it and ${isPaused ? "resume" : "start"} practice`
            : isPaused
              ? "Resume live RF timing for this practice session"
              : "Start live RF timing for this practice session";

        if (isActive) {
          standbyEl.innerHTML = "";
        } else {
          const stripToneCls = isPaused ? "is-paused" : "is-idle";
          const pillText = isPaused ? "Paused" : "Idle";
          const standbyMsg = isPaused
            ? "Practice is paused - laps aren't counting"
            : "Practice is idle - laps aren't counting";
          standbyEl.innerHTML = `
            <div class="ws-standby-bar ${stripToneCls}" data-ws-standby-bar="practice" role="status">
              <div class="ws-standby-copy">
                <span class="ws-standby-pill">${pillText}</span>
                <span class="ws-standby-text">${standbyMsg}</span>
              </div>
            </div>`;
        }

        const toggleButtonHtml = `<button
              type="button"
              class="btn btn-sm ${isActive ? "btn-armed" : "btn-unarmed"}"
              data-practice-act="${toggleAction}"
              data-session-id="${esc(sess.sessionId)}"
              title="${esc(toggleTitle)}"
            >
              ${isActive ? icons.pause(14) : icons.play(14)}<span>${toggleText}</span>
            </button>`;

        const gateCount = trackInfo.nodes.length;
        ctrlEl.innerHTML = `
          <div class="practice-strip-info">
            <span
              class="status-dot ${ledDotClass}"
              data-practice-status="${statusKey}"
              title="${esc(statusTitle)}"
            ></span>
            <span class="practice-strip-meta">${sess.pilots.length} pilot${sess.pilots.length === 1 ? "" : "s"} · ${sess.laps.length} lap${sess.laps.length === 1 ? "" : "s"} · ${gateCount} gate${gateCount === 1 ? "" : "s"}</span>
          </div>
          <div class="practice-strip-actions">
            ${toggleButtonHtml}
          </div>`;
      } else {
        topbarEl.classList.remove("is-ws-live", "is-ws-standby");
        standbyEl.innerHTML = "";
        ctrlEl.innerHTML = "";
      }
    }

    this.renderPilotAddSlot();
  }

  private buildSessionPilotsManagerMarkup(
    sess: PracticeSession,
    lapCountsBySlot: Map<number, number>,
    inlineMobile = false
  ): string {
    const sessionPilotBySlot = new Map(sess.pilots.map((sp) => [sp.slotIndex, sp]));
    return `
      <div class="practice-pilot-popover${inlineMobile ? " is-inline-mobile-panel" : this.pilotDrawerAnimatedOpen ? "" : " is-entering"}" role="${inlineMobile ? "region" : "dialog"}" aria-label="Manage session pilots">
        ${
          inlineMobile
            ? `<header class="rc-panel-header rc-hide-mobile">
                <div class="rc-panel-title-wrap">
                  ${icons.pilot(14)}
                  <strong>Session Pilots</strong>
                  <span class="badge mono bkt-pilots-count-pill">${sess.pilots.length} in session</span>
                </div>
              </header>`
            : `<div class="dir-mobile-drawer-top-bar practice-pilot-drawer-top-bar">
                <button
                  type="button"
                  class="pilot-dir-mobile-drawer-handle"
                  data-practice-pilot-handle="1"
                  data-practice-act="close-pilot-popover"
                  aria-label="Drag down or tap to close"
                  title="Close"
                >
                  <span class="pilot-dir-mobile-drawer-grip"></span>
                </button>
              </div>
              <div class="practice-pop-head">
                <div>
                  <div class="practice-pop-title">Session pilots (${sess.pilots.length})</div>
                  <div class="note">Search and toggle pilots in or out of this practice session.</div>
                </div>
                <button type="button" class="btn btn-xs btn-icon btn-ghost practice-pop-close-btn" data-practice-act="close-pilot-popover" aria-label="Close">
                  ${icons.close(14)}
                </button>
              </div>`
        }

        <div class="rc-pilots-search-bar practice-pop-search-bar">
          <div class="rc-pilots-search-row">
            ${icons.search(13)}
            <input
              type="search"
              class="input input-sm rc-pilots-search-input"
              data-new-session-pilot-input
              placeholder="Search pilots or type new callsign..."
              maxlength="24"
              autocomplete="off"
              aria-label="Search or add pilot"
            />
          </div>
          <button
            type="button"
            class="btn btn-ghost btn-xs bkt-pilots-add-btn"
            data-practice-act="create-and-add-pilot"
            disabled
            title="Search or type a unique callsign to add"
          >
            ${icons.plus(12)}<span>Add</span>
          </button>
        </div>

        <div class="practice-pop-section practice-pop-unified-section">
          <div class="practice-pop-list practice-pop-unified-list">
            ${
              this.store.pilots.length === 0
                ? `<div class="practice-pop-empty note">No pilots yet. Type a callsign above and click Add.</div>`
                : this.store.pilots
                    .map((gp) => {
                      const sp = sessionPilotBySlot.get(gp.slotIndex);
                      const isActiveInSession = Boolean(sp);
                      const color = gp.color || sp?.color || "#38bdf8";
                      const callsign = gp.callsign || sp?.callsign || `Pilot ${gp.slotIndex}`;
                      const laps = lapCountsBySlot.get(gp.slotIndex) ?? 0;
                      const callsignLower = callsign.trim().toLowerCase();
                      const activeBand = sp ? sp.band : gp.band;
                      const activeChannel = sp ? sp.channel : gp.channel;
                      const activeFreq = sp ? sp.frequencyMhz : gp.frequencyMhz;
                      const chSearch = pilotChannelSearchTokens(activeBand, activeChannel, activeFreq);
                      const hay = `${callsign} ${gp.phoneticName ?? ""} ${chSearch} #${gp.slotIndex}`.toLowerCase();
                      const chOpts = isActiveInSession && sp
                        ? renderMultiBandSelectOptionsHtml({
                            selectedBand: sp.band,
                            selectedChannel: sp.channel,
                            includeUnassigned: true,
                            unassignedLabel: "No ch",
                            compact: true,
                          })
                        : "";
                      const inactiveChLabel = formatBandChannelShort(gp.band, gp.channel) || "No ch";
                      return `
                        <div
                          class="practice-pop-row practice-toggle-row ${isActiveInSession ? "is-active-pilot" : ""}"
                          data-practice-pilot-row="${gp.slotIndex}"
                          data-pilot-callsign="${esc(callsignLower)}"
                          data-pilot-search-hay="${esc(hay)}"
                        >
                          <div class="practice-pop-pilot-info">
                            <span class="dot ${isActiveInSession && sess.active && !sess.paused && this.store.raceArmed ? "is-live" : "is-off"}" style="--c:${esc(color)}"></span>
                            <span class="practice-pop-name">${esc(callsign)}</span>
                            ${
                              laps > 0
                                ? `<span class="note mono">${laps} lap${laps === 1 ? "" : "s"}</span>`
                                : !isActiveInSession
                                  ? `<span class="note mono">${inactiveChLabel}</span>`
                                  : ""
                            }
                          </div>
                          <div class="practice-pop-row-actions">
                            ${
                              isActiveInSession
                                ? `<select
                                    class="input mono practice-pop-ch-select"
                                    data-session-pilot-channel="${gp.slotIndex}"
                                    aria-label="Channel for ${esc(callsign)}"
                                  >
                                    ${chOpts}
                                  </select>`
                                : ""
                            }
                            <button
                              type="button"
                              role="switch"
                              aria-checked="${isActiveInSession ? "true" : "false"}"
                              class="practice-pilot-switch ${isActiveInSession ? "is-on" : ""}"
                              data-practice-act="toggle-session-pilot"
                              data-slot-index="${gp.slotIndex}"
                              title="${isActiveInSession ? `Remove ${callsign} from session (retains laps)` : `Add ${callsign} to session`}"
                              aria-label="${isActiveInSession ? `Remove ${callsign} from session` : `Add ${callsign} to session`}"
                            >
                              <span class="practice-pilot-switch-thumb"></span>
                            </button>
                          </div>
                        </div>`;
                    })
                    .join("")
            }
          </div>
        </div>
      </div>`;
  }

  private renderPilotAddSlot(): void {
    const wrap = this.slot("pilot-add");
    const sess = this.store.selectedPracticeSession;
    if (!sess) {
      wrap.innerHTML = "";
      return;
    }

    const activeEl = document.activeElement;
    if (
      this.pilotPopoverOpen &&
      (isCustomSelectOpenWithin(wrap) ||
        (activeEl &&
          wrap.contains(activeEl) &&
          (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLSelectElement)))
    ) {
      // Do not clobber active typing/select interaction unless pilot membership changed
      const assignedKey = sess.pilots.map((p) => `${p.slotIndex}:${p.band ?? 1}:${p.channel}`).join(",");
      const globalKey = this.store.pilots.map((p) => `${p.slotIndex}:${p.callsign}`).join(",");
      const quickSig = `open:${sess.sessionId}:${assignedKey}:${globalKey}`;
      if (quickSig === this.lastPopoverSig) {
        return;
      }
    }

    const assignedKey = sess.pilots
      .map((p) => `${p.slotIndex}:${p.callsign}:${p.band ?? 1}:${p.channel}`)
      .join(",");
    const globalKey = this.store.pilots
      .map((p) => `${p.slotIndex}:${p.callsign}:${p.band ?? 1}:${p.channel}`)
      .join(",");
    const lapCountsBySlot = new Map<number, number>();
    for (const lap of sess.laps) {
      lapCountsBySlot.set(lap.slotIndex, (lapCountsBySlot.get(lap.slotIndex) ?? 0) + 1);
    }
    const lapsKey = Array.from(lapCountsBySlot.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    const fullSig = `${this.pilotPopoverOpen ? "open" : "closed"}:${sess.sessionId}:${assignedKey}:${globalKey}:${lapsKey}`;
    if (fullSig === this.lastPopoverSig) return;
    this.lastPopoverSig = fullSig;

    const popoverHtml = this.pilotPopoverOpen
      ? `<div class="practice-pilot-drawer-overlay">
          <div class="pilot-dir-mobile-drawer-backdrop practice-pilot-drawer-backdrop" data-practice-pilot-backdrop="1"></div>
          ${this.buildSessionPilotsManagerMarkup(sess, lapCountsBySlot, false)}
        </div>`
      : "";

    const prevInp = wrap.querySelector<HTMLInputElement>("input[data-new-session-pilot-input]");
    const prevSearchVal = prevInp?.value ?? "";
    const hadInputFocus = Boolean(prevInp && document.activeElement === prevInp);
    const prevList = wrap.querySelector<HTMLElement>(".practice-pop-unified-list");
    const prevListScroll = prevList?.scrollTop ?? 0;

    const existingOverlay = wrap.querySelector<HTMLElement>(".practice-pilot-drawer-overlay");
    if (this.pilotPopoverOpen && existingOverlay && !this.pilotDrawerClosing) {
      const existingPop = existingOverlay.querySelector<HTMLElement>(".practice-pilot-popover");
      const temp = document.createElement("div");
      temp.innerHTML = this.buildSessionPilotsManagerMarkup(sess, lapCountsBySlot, false);
      const freshPop = temp.querySelector<HTMLElement>(".practice-pilot-popover");
      if (existingPop && freshPop) {
        freshPop.classList.remove("is-entering");
        existingPop.replaceWith(freshPop);
      }
    } else {
      wrap.innerHTML = `
        <button
          type="button"
          class="practice-add-pilot-btn ${this.pilotPopoverOpen ? "is-open" : ""}"
          data-practice-act="toggle-pilot-popover"
          aria-expanded="${this.pilotPopoverOpen ? "true" : "false"}"
          title="Add or remove pilots for this practice session"
        >
          ${icons.plus(14)}<span>Add pilot</span>
        </button>
        ${popoverHtml}`;
    }

    this.pilotDrawerAnimatedOpen = this.pilotPopoverOpen;

    if (this.pilotPopoverOpen) {
      const nextPop = wrap.querySelector<HTMLElement>(".practice-pilot-popover");
      const nextInp = wrap.querySelector<HTMLInputElement>("input[data-new-session-pilot-input]");
      if (nextInp && prevSearchVal) {
        nextInp.value = prevSearchVal;
        this.syncSessionPilotPopoverFilter(nextPop);
      }
      if (nextInp && hadInputFocus) {
        nextInp.focus();
      }
      const nextList = wrap.querySelector<HTMLElement>(".practice-pop-unified-list");
      if (nextList && prevListScroll > 0) {
        nextList.scrollTop = prevListScroll;
      }
    }
  }

  private renderMobilePilotsPanel(): void {
    const host = this.slot("mobile-pilots");
    const sess = this.store.selectedPracticeSession;
    if (this.activeTab !== "session" || !sess) {
      host.innerHTML = "";
      this.lastMobilePilotsSig = "";
      return;
    }

    const activeEl = document.activeElement;
    if (
      isCustomSelectOpenWithin(host) ||
      (activeEl &&
        host.contains(activeEl) &&
        (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLSelectElement))
    ) {
      const assignedKey = sess.pilots.map((p) => `${p.slotIndex}:${p.band ?? 1}:${p.channel}`).join(",");
      const globalKey = this.store.pilots.map((p) => `${p.slotIndex}:${p.callsign}`).join(",");
      const quickSig = `mobile-pilots:${sess.sessionId}:${assignedKey}:${globalKey}`;
      if (quickSig === this.lastMobilePilotsSig) {
        return;
      }
    }

    const assignedKey = sess.pilots
      .map((p) => `${p.slotIndex}:${p.callsign}:${p.band ?? 1}:${p.channel}`)
      .join(",");
    const globalKey = this.store.pilots
      .map((p) => `${p.slotIndex}:${p.callsign}:${p.band ?? 1}:${p.channel}`)
      .join(",");
    const lapCountsBySlot = new Map<number, number>();
    for (const lap of sess.laps) {
      lapCountsBySlot.set(lap.slotIndex, (lapCountsBySlot.get(lap.slotIndex) ?? 0) + 1);
    }
    const lapsKey = Array.from(lapCountsBySlot.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    const fullSig = `mobile-pilots:${sess.sessionId}:${assignedKey}:${globalKey}:${lapsKey}:${sess.active ? 1 : 0}:${sess.paused ? 1 : 0}:${this.store.raceArmed ? 1 : 0}`;
    if (fullSig === this.lastMobilePilotsSig && host.querySelector(".practice-pilot-popover")) {
      return;
    }
    this.lastMobilePilotsSig = fullSig;

    const prevInp = host.querySelector<HTMLInputElement>("input[data-new-session-pilot-input]");
    const prevSearchVal = prevInp?.value ?? "";
    const hadInputFocus = Boolean(prevInp && document.activeElement === prevInp);
    const prevList = host.querySelector<HTMLElement>(".practice-pop-unified-list");
    const prevListScroll = prevList?.scrollTop ?? 0;

    host.innerHTML = this.buildSessionPilotsManagerMarkup(sess, lapCountsBySlot, true);

    const nextPop = host.querySelector<HTMLElement>(".practice-pilot-popover");
    const nextInp = host.querySelector<HTMLInputElement>("input[data-new-session-pilot-input]");
    if (nextInp && prevSearchVal) {
      nextInp.value = prevSearchVal;
      this.syncSessionPilotPopoverFilter(nextPop);
    }
    if (nextInp && hadInputFocus) {
      nextInp.focus();
    }
    const nextList = host.querySelector<HTMLElement>(".practice-pop-unified-list");
    if (nextList && prevListScroll > 0) {
      nextList.scrollTop = prevListScroll;
    }
  }

  private renderMobileSectorsPanel(): void {
    const host = this.slot("mobile-sectors");
    const sess = this.store.selectedPracticeSession;
    if (this.activeTab !== "session" || !sess) {
      host.innerHTML = "";
      this.lastMobileSectorsSig = "";
      return;
    }

    const gates = this.workspaceStore.nodes;
    const cols = gates.map((p, i) => {
      const to = gates[(i + 1) % gates.length].gateId;
      return {
        sectorIndex: i + 1,
        from: p.gateId,
        to,
        key: sectionKey(p.gateId, to),
      };
    });

    if (cols.length > 0) {
      const courseSig = `${sess.sessionId}:${cols.map((c) => c.key).join(",")}`;
      const validKeys = new Set(cols.map((c) => c.key));
      for (const k of Array.from(this.selectedMobileSectorKeys)) {
        if (!validKeys.has(k)) {
          this.selectedMobileSectorKeys.delete(k);
        }
      }
      if (courseSig !== this.lastMobileSectorCourseSig) {
        this.lastMobileSectorCourseSig = courseSig;
        this.selectedMobileSectorKeys.clear();
        for (const c of cols.slice(0, 3)) {
          this.selectedMobileSectorKeys.add(c.key);
        }
      }
    }

    const checkedCols = cols.filter((c) => this.selectedMobileSectorKeys.has(c.key)).slice(0, 3);
    const enabled = this.workspaceStore.enabledPilots;
    const focusSlot =
      this.store.liveFocus !== null && enabled.some((p) => p.slotIndex === this.store.liveFocus)
        ? this.store.liveFocus
        : enabled[0]?.slotIndex ?? null;
    const pilot = focusSlot !== null ? this.workspaceStore.pilot(focusSlot) : undefined;
    const laps = pilot ? allLapsFor(this.workspaceStore, pilot.slotIndex) : [];

    const lapsSig = laps
      .slice(-20)
      .map(
        (l) =>
          `${l.lapId}:${l.lapNumber}:${l.lapTimeSec}:${l.invalidated ? 1 : 0}:${l.isBestLap ? 1 : 0}:${l.deltaToBest}:${(l.sectors ?? []).map((s) => `${s.fromGateId}>${s.toGateId}=${s.splitSeconds}:${s.badge}`).join(",")}`
      )
      .join("|");
    const gatesMetaSig = cols
      .map(
        (c) =>
          `${c.key}:${gateColor(this.workspaceStore, c.from)}>${gateColor(this.workspaceStore, c.to)}:${sectionShort(this.workspaceStore, c.from)}:${sectionLabel(this.workspaceStore, c.from, c.to)}`
      )
      .join("|");
    const checkedSig = checkedCols.map((c) => c.key).join(",");
    const fullSig = `${sess.sessionId}:${pilot?.slotIndex ?? 0}:${pilot?.callsign ?? ""}:${checkedSig}:${gatesMetaSig}:${lapsSig}`;
    if (fullSig === this.lastMobileSectorsSig && host.children.length > 0) {
      return;
    }
    this.lastMobileSectorsSig = fullSig;

    const prevTableScroll = host.querySelector<HTMLElement>(".table-scroll")?.scrollTop ?? 0;
    const prevPickerScroll =
      host.querySelector<HTMLElement>(".practice-sectors-picker-list")?.scrollTop ?? 0;

    const tableMarkup =
      laps.length === 0
        ? renderEmpty(
            "No laps yet",
            pilot
              ? `${pilot.callsign}'s laps appear here as they complete them.`
              : "Select a pilot to view their laps."
          )
        : `<div class="table-scroll">
            <table class="table table-compact practice-sectors-table" style="--mobile-sector-cols:${checkedCols.length}">
              <thead>
                <tr>
                  <th class="col-mobile-lap-num">Lap</th>
                  ${checkedCols
                    .map(
                      (c) =>
                        `<th class="num col-mobile-sector" title="${esc(sectionLabel(this.workspaceStore, c.from, c.to))}"><span class="th-pilot"><span class="dot" style="--c:${gateColor(this.workspaceStore, c.from)}"></span>${sectionShort(this.workspaceStore, c.from)}</span></th>`
                    )
                    .join("")}
                  <th class="num col-lap-time">Lap time</th>
                  <th class="num col-vs-best">vs best</th>
                </tr>
              </thead>
              <tbody>
                ${[...laps]
                  .reverse()
                  .slice(0, 20)
                  .map((lap) => {
                    const isInvalid = Boolean(lap.invalidated);
                    const byKey = new Map(
                      (lap.sectors ?? []).map((s) => [sectionKey(s.fromGateId, s.toGateId), s])
                    );
                    const cells = checkedCols
                      .map((c) => {
                        const s = byKey.get(c.key);
                        return s
                          ? `<td class="num col-mobile-sector"><span class="split ${isInvalid ? "" : SPLIT_CLASS[s.badge]}">${s.splitSeconds.toFixed(3)}</span></td>`
                          : `<td class="num muted col-mobile-sector" title="Timer missed">—</td>`;
                      })
                      .join("");
                    const vs = isInvalid
                      ? "—"
                      : lap.isBestLap && lap.lapNumber > 1
                        ? `<span class="badge badge-good">PB</span>`
                        : lap.deltaToBest > 0
                          ? fmtDelta(lap.deltaToBest)
                          : "best";
                    const toggleTitle = isInvalid
                      ? `Restore Lap ${lap.lapNumber}`
                      : `Scratch Lap ${lap.lapNumber} (click again to restore or delete)`;
                    const lapNumContent = isInvalid
                      ? `<span class="lap-num-cell"><button
                          type="button"
                          role="checkbox"
                          aria-checked="false"
                          class="lap-num-toggle"
                          data-practice-toggle-lap="${lap.lapId}"
                          title="${esc(toggleTitle)}"
                          aria-label="${esc(toggleTitle)}"
                        >${lap.lapNumber}</button><button
                          type="button"
                          class="lap-delete-btn"
                          data-practice-delete-lap="${lap.lapId}"
                          title="Delete Lap ${lap.lapNumber}"
                          aria-label="Delete Lap ${lap.lapNumber}"
                        >${icons.trash(13)}</button></span>`
                      : `<button
                          type="button"
                          role="checkbox"
                          aria-checked="true"
                          class="lap-num-toggle"
                          data-practice-toggle-lap="${lap.lapId}"
                          title="${esc(toggleTitle)}"
                          aria-label="${esc(toggleTitle)}"
                        >${lap.lapNumber}</button>`;
                    return `<tr class="${isInvalid ? "is-invalidated" : ""}" data-lap-row="${lap.lapId}" data-practice-toggle-lap="${lap.lapId}" title="${esc(toggleTitle)}">
                      <td class="mono col-mobile-lap-num">
                        ${lapNumContent}
                      </td>
                      ${cells}
                      <td class="num mono strong col-lap-time ${!isInvalid && lap.isBestLap ? "tone-good" : ""}">${fmtTime(lap.lapTimeSec)}</td>
                      <td class="num mono muted col-vs-best">${vs}</td>
                    </tr>`;
                  })
                  .join("")}
              </tbody>
            </table>
          </div>`;

    const pickerMarkup =
      cols.length === 0
        ? `<div class="note" style="padding:12px">No gates configured for this session.</div>`
        : `<div class="channel-legend practice-sectors-picker-list" role="group" aria-label="Select up to 3 sectors to display">
            ${cols
              .map((c) => {
                const checked = this.selectedMobileSectorKeys.has(c.key);
                const atMax = !checked && this.selectedMobileSectorKeys.size >= 3;
                const route = sectionLabel(this.workspaceStore, c.from, c.to);
                return `
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked="${checked ? "true" : "false"}"
                    class="channel practice-sector-check-row ${checked ? "is-checked" : "is-dim"}"
                    data-practice-sector-toggle="${esc(c.key)}"
                    ${atMax ? "disabled" : ""}
                    title="${atMax ? "Select up to 3 sectors at a time" : esc(route)}"
                  >
                    <span class="practice-sector-checkbox ${checked ? "is-checked" : ""}" aria-hidden="true"></span>
                    ${renderSectionCapsuleIcon(
                      gateColor(this.workspaceStore, c.from),
                      gateColor(this.workspaceStore, c.to)
                    )}
                    <span class="channel-name">${sectionShort(this.workspaceStore, c.from)}</span>
                    <span class="channel-dbm mono">${esc(route)}</span>
                  </button>`;
              })
              .join("")}
          </div>`;

    host.innerHTML = `
      <section class="card card-flush practice-sectors-table-card">
        ${tableMarkup}
      </section>
      ${pickerMarkup}`;

    const nextTableScroll = host.querySelector<HTMLElement>(".table-scroll");
    if (nextTableScroll && prevTableScroll > 0) {
      nextTableScroll.scrollTop = prevTableScroll;
    }
    const nextPickerScroll = host.querySelector<HTMLElement>(".practice-sectors-picker-list");
    if (nextPickerScroll && prevPickerScroll > 0) {
      nextPickerScroll.scrollTop = prevPickerScroll;
    }
  }

  private disposePracticeSignalsChart(): void {
    if (this.practiceSignalsChart) {
      this.practiceSignalsChart.destroy();
      this.practiceSignalsChart = null;
    }
    if (this.practiceSignalsChartEl) {
      this.practiceSignalsChartEl.remove();
      this.practiceSignalsChartEl = null;
    }
    this.lastMobileSignalsSig = "";
  }

  private disposePracticeTrackView(): void {
    if (this.practiceTrackView) {
      this.practiceTrackView.destroy();
      this.practiceTrackView = null;
    }
    if (this.practiceTrackEl) {
      this.practiceTrackEl.remove();
      this.practiceTrackEl = null;
    }
    this.practiceTrackSessionId = "";
  }

  private renderMobileTrackPanel(): void {
    const host = this.slot("mobile-track");
    const curSessionId = this.store.selectedPracticeSession?.sessionId ?? "";
    if (this.activeTab !== "session") {
      this.disposePracticeTrackView();
      host.innerHTML = "";
      return;
    }
    if (this.practiceTrackView && this.practiceTrackSessionId !== curSessionId) {
      this.disposePracticeTrackView();
    }
    if (!this.practiceTrackView || !this.practiceTrackEl) {
      this.practiceTrackSessionId = curSessionId;
      this.practiceTrackEl = document.createElement("div");
      this.practiceTrackEl.className = "view rc-track-embedded";
      this.practiceTrackView = new ScopedTrackWorkspace(
        this.practiceTrackEl,
        this.trackEditorStore,
        this.scopedApi,
        { contextLabel: "practice" }
      );
    }
    if (this.practiceTrackEl.parentElement !== host) {
      host.appendChild(this.practiceTrackEl);
    }
  }

  private disposePracticeAnalyticsView(): void {
    if (this.practiceAnalyticsView) {
      this.practiceAnalyticsView.destroy();
      this.practiceAnalyticsView = null;
    }
    if (this.practiceAnalyticsEl) {
      this.practiceAnalyticsEl.remove();
      this.practiceAnalyticsEl = null;
    }
  }

  private renderMobileAnalyticsPanel(force = false): void {
    const host = this.slot("mobile-analytics");
    if (this.activeTab !== "session") {
      this.disposePracticeAnalyticsView();
      host.innerHTML = "";
      return;
    }
    if (!this.practiceAnalyticsView || !this.practiceAnalyticsEl) {
      this.practiceAnalyticsEl = document.createElement("div");
      this.practiceAnalyticsEl.className = "view view-pilot rc-analytics-embedded";
      this.practiceAnalyticsView = new PilotView(
        this.practiceAnalyticsEl,
        this.store,
        () => ({
          kind: "practice",
          id: this.store.selectedPracticeSession?.sessionId ?? "",
        })
      );
    }
    if (this.practiceAnalyticsEl.parentElement !== host) {
      host.appendChild(this.practiceAnalyticsEl);
    }
    if (force) {
      this.practiceAnalyticsView.onActivate();
    }
  }

  private openPracticeSessionSettingsModal(sess: PracticeSession): void {
    document.querySelectorAll(".slaprf-modal-backdrop[data-practice-settings-modal]").forEach((el) => el.remove());
    let currentTags = [...(sess.tags ?? [])];
    const dispName = sess.name || "Practice Session";
    const backdrop = document.createElement("div");
    backdrop.className = "slaprf-modal-backdrop";
    backdrop.setAttribute("data-practice-settings-modal", "1");
    backdrop.innerHTML = `
      <div class="slaprf-modal rc-modal-md" role="dialog" aria-modal="true" aria-label="Practice Settings">
        <div class="slaprf-modal-head">
          <div class="slaprf-modal-title-row">
            ${icons.sliders(17)}
            <h3>Practice Settings</h3>
          </div>
          <button type="button" class="slaprf-modal-close" data-modal-close aria-label="Close">
            ${icons.close(15)}
          </button>
        </div>
        <div class="slaprf-modal-body">
          <div class="rc-modal-form">
            <label class="field">
              <span>Session Name</span>
              <input
                type="text"
                class="input"
                data-modal-session-name
                value="${esc(dispName)}"
                placeholder="Session name"
                maxlength="64"
                autocomplete="off"
              />
            </label>
            <div class="field">
              <span>Tags</span>
              ${renderTagPillBoxHtml({
                boxId: "practice-settings",
                tags: currentTags,
                placeholder: "Add tags (press comma or Enter)...",
                compact: false,
                ariaLabel: "Edit practice session tags",
              })}
            </div>
          </div>
        </div>
        <div class="slaprf-modal-actions">
          <button type="button" class="btn btn-ghost" data-modal-close>Cancel</button>
          <button type="button" class="btn btn-armed" data-modal-save-practice-settings>Save Settings</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const tagBoxEl = backdrop.querySelector<HTMLElement>('[data-tag-box="practice-settings"]')!;
    const tagEditor = mountTagPillEditor(tagBoxEl, {
      initialTags: currentTags,
      placeholder: "Add tags (press comma or Enter)...",
      onChange: (next) => {
        currentTags = next;
      },
    });

    const close = (): void => {
      document.removeEventListener("keydown", onEsc);
      backdrop.remove();
    };
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onEsc);

    backdrop.addEventListener("click", (e) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t === backdrop || t.closest("[data-modal-close]")) {
        close();
        return;
      }
      const saveBtn = t.closest<HTMLButtonElement>("[data-modal-save-practice-settings]");
      if (saveBtn && !saveBtn.disabled) {
        saveBtn.disabled = true;
        tagEditor.flushPending();
        currentTags = tagEditor.getTags();
        const newName =
          backdrop.querySelector<HTMLInputElement>("[data-modal-session-name]")?.value.trim() ||
          dispName;
        const prevTagsJoined = (sess.tags ?? []).join("\u0000");
        const nextTagsJoined = currentTags.join("\u0000");
        const renamePromise =
          newName !== sess.name
            ? this.api.practiceAction({
                action: "rename_session",
                sessionId: sess.sessionId,
                name: newName,
              })
            : Promise.resolve();
        const tagsPromise =
          prevTagsJoined !== nextTagsJoined
            ? this.api.practiceAction({
                action: "set_session_tags",
                sessionId: sess.sessionId,
                tags: currentTags,
              })
            : Promise.resolve();
        void renamePromise
          .then(() => tagsPromise)
          .then(() => close())
          .catch((err) => {
            saveBtn.disabled = false;
            this.reportErr(err);
          });
      }
    });
  }

  private getPracticeSignalsCandidates(): Array<{
    slotIndex: number;
    callsign: string;
    color: string;
    channelLabel: string;
  }> {
    const candidates: Array<{
      slotIndex: number;
      callsign: string;
      color: string;
      channelLabel: string;
    }> = [];
    const seen = new Set<number>();
    const sess = this.store.selectedPracticeSession;
    for (const sp of sess?.pilots ?? []) {
      if (sp.slotIndex > 0 && !seen.has(sp.slotIndex)) {
        seen.add(sp.slotIndex);
        const gp = this.store.pilot(sp.slotIndex);
        candidates.push({
          slotIndex: sp.slotIndex,
          callsign: sp.callsign || gp?.callsign || `Pilot ${sp.slotIndex}`,
          color: sp.color || gp?.color || "#38bdf8",
          channelLabel: formatBandChannelShort(sp.band ?? gp?.band, sp.channel || gp?.channel || 0),
        });
      }
    }
    for (const gp of this.store.enabledPilots) {
      if (gp.slotIndex > 0 && !seen.has(gp.slotIndex)) {
        seen.add(gp.slotIndex);
        candidates.push({
          slotIndex: gp.slotIndex,
          callsign: gp.callsign,
          color: gp.color || "#38bdf8",
          channelLabel: formatBandChannelShort(gp.band, gp.channel),
        });
      }
    }
    return candidates;
  }

  private renderMobileSignalsPanel(force = false): void {
    const host = this.slot("mobile-signals");
    if (this.activeTab !== "session") {
      this.disposePracticeSignalsChart();
      host.innerHTML = "";
      return;
    }
    const candidates = this.getPracticeSignalsCandidates();
    if (candidates.length === 0) {
      this.disposePracticeSignalsChart();
      host.innerHTML = `<div class="rc-panel-body is-signals-body"><div class="note" style="padding:12px 4px">No pilots in this practice session yet.</div></div>`;
      return;
    }
    const focusSlot = this.store.liveFocus;
    if (
      focusSlot !== null &&
      candidates.some((c) => c.slotIndex === focusSlot)
    ) {
      this.practiceSignalsSlot = focusSlot;
    } else if (
      this.practiceSignalsSlot === null ||
      !candidates.some((c) => c.slotIndex === this.practiceSignalsSlot)
    ) {
      this.practiceSignalsSlot = candidates[0].slotIndex;
    }
    const selectedSlot = this.practiceSignalsSlot;
    const sig = `${selectedSlot}:${candidates.map((c) => `${c.slotIndex}:${c.callsign}:${c.color}:${c.channelLabel}`).join("|")}`;
    if (!force && sig === this.lastMobileSignalsSig && host.querySelector("[data-practice-signals-chart]")) {
      this.practiceSignalsChart?.setPilotSlotOverride(selectedSlot);
      return;
    }
    this.lastMobileSignalsSig = sig;
    this.practiceSignalsChartEl?.remove();

    const pilotBarHtml = `
      <div class="sched-lineup-wrap rc-signals-pilot-wrap">
        <button type="button" class="sched-lineup-cue is-left" data-lineup-scroll="-1" aria-label="Scroll pilots left" title="Scroll left" hidden>${icons.chevronLeft(13)}</button>
        <div class="rc-signals-pilot-bar sched-lineup" role="tablist" aria-label="Select pilot signal trace" data-fit-lineup>
          ${candidates
            .map(
              (c) => `
                <button
                  type="button"
                  class="races-filter-pill rc-sig-pilot-pill ${c.slotIndex === selectedSlot ? "is-active" : ""}"
                  data-practice-sig-pilot="${c.slotIndex}"
                  style="--c:${esc(c.color)}"
                >
                  <span class="dot" style="--c:${esc(c.color)}"></span>
                  <span>${esc(c.callsign)}</span>
                  ${c.channelLabel ? `<span class="mono note">${esc(c.channelLabel)}</span>` : ""}
                </button>`
            )
            .join("")}
        </div>
        <button type="button" class="sched-lineup-cue is-right" data-lineup-scroll="1" aria-label="Scroll pilots right" title="More pilots" hidden>${icons.chevronRight(13)}</button>
      </div>`;

    host.innerHTML = `
      <div class="rc-signals-card-box">
        <header class="rc-panel-header rc-hide-mobile">
          <div class="rc-panel-title-wrap">
            ${icons.signal(14)}
            <strong>Signal at each timer</strong>
            <span class="note rc-hide-mobile">Live RSSI &amp; gate crossing thresholds</span>
          </div>
        </header>
        <div class="rc-panel-body is-signals-body">
          ${pilotBarHtml}
          <div class="rc-signals-chart-host" data-practice-signals-chart></div>
        </div>
      </div>`;

    const chartHost = host.querySelector<HTMLElement>("[data-practice-signals-chart]");
    if (chartHost) {
      if (!this.practiceSignalsChart || !this.practiceSignalsChartEl) {
        this.practiceSignalsChartEl = document.createElement("div");
        this.practiceSignalsChartEl.className = "rc-signals-chart-inner";
        chartHost.appendChild(this.practiceSignalsChartEl);
        this.practiceSignalsChart = new PilotRssiChart(
          this.practiceSignalsChartEl,
          this.workspaceStore,
          this.scopedApi
        );
      } else {
        chartHost.appendChild(this.practiceSignalsChartEl);
      }
      this.practiceSignalsChart.setPilotSlotOverride(selectedSlot);
    }
    fitScheduleLineups(host);
  }

  private showPanel(): void {
    const focus = this.store.liveFocus;
    const mode = focus === null ? null : 0;
    const shownMode = this.shownFocus === undefined ? undefined : this.shownFocus === null ? null : 0;
    this.shownFocus = focus;
    if (mode === shownMode && this.panel) return;

    this.panel?.destroy();
    const host = this.slot("panel");
    const onSelectPilot = (slot: number) => {
      if (this.mobilePracticeTab === "overview") {
        this.mobilePracticeTab = "laps";
        this.slot("workspace").dataset.mobilePracticeView = "laps";
        this.store.setLiveFocus(slot);
        this.setMobilePracticeTab("laps", null, true);
      } else {
        this.store.setLiveFocus(slot);
      }
    };
    this.panel =
      focus === null
        ? new AllPilotsPanel(host, this.workspaceStore, this.api, onSelectPilot)
        : new PilotPanel(host, this.workspaceStore, this.api);
  }
}
