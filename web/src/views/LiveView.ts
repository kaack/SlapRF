import { Component } from "../core/component";
import { isCustomSelectOpenWithin } from "../core/custom_select";
import { esc, fmtTime } from "../core/format";
import { icons } from "../core/icons";
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
import { gateLabel } from "../state/selectors";
import { AppStore } from "../state/store";
import { PracticeSession } from "../types/models";
import { openConfirmModal } from "../widgets/ConfirmModal";
import { openConfirmPreemptModal } from "../widgets/ConfirmPreemptModal";
import { PilotPicker } from "../widgets/PilotPicker";
import { mountTagPillEditor, renderTagPillBoxHtml } from "../widgets/TagPillEditor";
import { cleanConnectionInvalidReason, showToast } from "../widgets/Toast";
import { AllPilotsPanel } from "./live/AllPilotsPanel";
import { PilotPanel } from "./live/PilotPanel";

type SessionDirStatusFilter = "all" | "live" | "stopped" | "laps";

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
    if (lap.lapTimeSec > 0 && (bestSec === 0 || lap.lapTimeSec < bestSec)) {
      bestSec = lap.lapTimeSec;
      bestCallsign = lap.callsign;
    }
  }
  return bestSec > 0 ? { sec: bestSec, callsign: bestCallsign } : null;
}

/**
 * Practice view (`#/live` directory & `#/live/session` active session workspace):
 * 1. Directory view: 2-column `.settings-section` matching `Races`, with inline `+ Session`
 *    row creation, inline session name & comma-separated tag editing, tag filter pills,
 *    `Live` / `Stopped` status badges, and Open / Start-Stop / Delete icon actions.
 * 2. Session workspace: TopBar breadcrumb `< Practice › <Session>`, `All` + pilot chips +
 *    `+ Add pilot` popover right in `.picker-row`, `Start / Stop` session control, and
 *    live standings / lap progression / section splits / per-pilot RSSI stream.
 */
export class LiveView extends Component {
  private readonly store: AppStore;
  private readonly workspaceStore: AppStore;
  private readonly api: ApiClient;
  private activeTab: PracticeViewTab = "directory";
  private panel: Component | null = null;
  private shownFocus: number | null | undefined = undefined;

  private dirSearchQuery = "";
  private dirStatusFilter: SessionDirStatusFilter = "all";
  private selectedFilterTags = new Set<string>();
  private untaggedOnly = false;
  private editingNameForSessionId = "";
  private editingTagsForSessionId = "";
  private pilotPopoverOpen = false;
  private isViewActive = true;

  public override onDeactivate(): void {
    this.isViewActive = false;
    this.pilotPopoverOpen = false;
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
  private pendingRouteTarget: PracticeRouteTarget | null = null;
  private resolvingSessionId = "";

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.workspaceStore = store.forPracticeWorkspace();
    this.api = api;

    this.pendingRouteTarget = getCurrentParsedHash().live ?? { tab: "directory" };
    this.activeTab = "directory";
    try {
      this.dismissedOngoingRaceId =
        window.sessionStorage.getItem("slaprf.practice.dismissedOngoingRaceId") ?? "";
    } catch {
      this.dismissedOngoingRaceId = "";
    }

    el.innerHTML = `
      <div class="settings" data-slot="directory"></div>
      <div class="view-stack" data-slot="workspace" style="display:none">
        <div data-slot="workspace-banner"></div>
        <div class="picker-row practice-picker-row">
          <div class="practice-picker-left">
            <div data-slot="picker"></div>
            <div class="practice-pilot-add-wrap" data-slot="pilot-add"></div>
          </div>
        </div>
        <div class="practice-action-strip" data-slot="session-controls" role="region" aria-label="Practice session status and controls"></div>
        <div class="view-stack" data-slot="panel"></div>
      </div>`;

    this.adopt(
      new PilotPicker(this.slot("picker"), store, {
        includeAll: true,
        value: () => store.liveFocus,
        onSelect: (slot) => store.setLiveFocus(slot),
      })
    );

    this.listen(el, "click", this.handleClick);
    this.listen(el, "input", this.handleInput);
    this.listen(el, "change", this.handleChange);
    this.listen(el, "keydown", this.handleKeyDown);
    this.listen(el, "focusout", this.handleFocusOut);

    const onDocPointerDown = (e: PointerEvent): void => {
      if (!this.pilotPopoverOpen) return;
      const target = e.target as Node | null;
      const wrap = this.slot("pilot-add");
      if (
        !target ||
        (!wrap.contains(target) &&
          !(target instanceof Element && target.closest(".custom-select-popover")))
      ) {
        this.pilotPopoverOpen = false;
        this.lastPopoverSig = "";
        this.renderPilotAddSlot();
      }
    };
    const onDocKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !e.defaultPrevented && this.pilotPopoverOpen) {
        this.pilotPopoverOpen = false;
        this.lastPopoverSig = "";
        this.renderPilotAddSlot();
      }
    };
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("keydown", onDocKeyDown);
    this.onDispose(() => {
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      document.removeEventListener("keydown", onDocKeyDown);
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

    this.pendingRouteTarget = null;
    this.resolvingSessionId = "";
    this.setTab("session", false);
  }

  private setTab(next: PracticeViewTab, pushHistory = false): void {
    if (next === "session" && !this.store.selectedPracticeSession) {
      return;
    }
    this.activeTab = next;
    if (next === "directory") {
      this.pilotPopoverOpen = false;
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
        active: Boolean(sess?.active),
      });
    }

    if (getCurrentParsedHash().route !== "live") return;
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
    this.syncUrlAndTopBar(pushHistory);
    const dirEl = this.slot("directory");
    const wsEl = this.slot("workspace");

    if (this.activeTab === "directory") {
      dirEl.style.display = "";
      wsEl.style.display = "none";
      this.renderDirectory();
    } else {
      dirEl.style.display = "none";
      wsEl.style.display = "";
      this.renderWorkspaceChrome();
      this.showPanel();
    }
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

    const actBtn = target.closest<HTMLButtonElement>("[data-practice-act]");
    if (actBtn) {
      if (actBtn.disabled) return;
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
            this.lastDirSig = "";
            this.renderDirectory(true);
          }
          return;
        }

        case "create-session-inline": {
          this.dirSearchQuery = "";
          this.dirStatusFilter = "all";
          this.selectedFilterTags.clear();
          this.untaggedOnly = false;
          this.editingNameForSessionId = "";
          this.editingTagsForSessionId = "";
          this.errorMsg = "";
          void this.api
            .practiceAction({ action: "create_session", dontSelect: true })
            .then(() => {
              this.lastDirSig = "";
              this.renderDirectory(true);
            })
            .catch(this.reportErr);
          return;
        }

        case "open-session": {
          const sid = actBtn.dataset.sessionId ?? "";
          this.openPracticeSession(sid);
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

        case "toggle-pilot-popover":
          this.pilotPopoverOpen = !this.pilotPopoverOpen;
          this.lastPopoverSig = "";
          this.renderPilotAddSlot();
          return;

        case "close-pilot-popover":
          this.pilotPopoverOpen = false;
          this.lastPopoverSig = "";
          this.renderPilotAddSlot();
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
    const sess = this.store.selectedPracticeSession;
    const sessionFull = (sess?.pilots.length ?? 0) >= 8;

    const trimmed = (inp?.value ?? "").trim();
    const needle = trimmed.toLowerCase();
    const exactGlobal = needle
      ? this.store.pilots.find((p) => p.callsign.trim().toLowerCase() === needle)
      : undefined;

    popEl
      .querySelectorAll<HTMLElement>("[data-session-pilot-row], [data-available-pilot-row]")
      .forEach((row) => {
        const hay = row.dataset.pilotSearchHay ?? "";
        const callsign = row.dataset.pilotCallsign ?? "";
        const show = !needle || hay.includes(needle);
        row.hidden = !show;
        row.classList.toggle("is-exact-match", !!needle && callsign === needle);
      });

    if (createBtn) {
      createBtn.disabled = sessionFull || !trimmed || !!exactGlobal;
      createBtn.title = sessionFull
        ? "Maximum 8 pilots per session"
        : exactGlobal
          ? `Pilot “${exactGlobal.callsign}” already exists`
          : trimmed
            ? `Create global pilot “${trimmed}” and add to this session`
            : "Search or type a unique callsign to add";
    }
  }

  private submitNewSessionPilot(): void {
    const sess = this.store.selectedPracticeSession;
    if (!sess) return;
    const inp = this.el.querySelector<HTMLInputElement>("input[data-new-session-pilot-input]");
    const callsign = inp?.value.trim() ?? "";
    if (!callsign) {
      inp?.focus();
      return;
    }
    const dup = this.store.pilots.some(
      (p) => p.callsign.trim().toLowerCase() === callsign.toLowerCase()
    );
    if (dup) {
      this.syncSessionPilotPopoverFilter(this.el.querySelector<HTMLElement>(".practice-pilot-popover"));
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
        const freshInp = this.el.querySelector<HTMLInputElement>("input[data-new-session-pilot-input]");
        if (freshInp) {
          freshInp.value = "";
          freshInp.focus();
        }
        this.syncSessionPilotPopoverFilter(this.el.querySelector<HTMLElement>(".practice-pilot-popover"));
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

  private mountActiveSessionTagEditor(autoFocus = true): void {
    const sid = this.editingTagsForSessionId;
    if (!sid) return;
    const dirHost = this.slot("directory");
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
      if (sid && this.editingNameForSessionId === sid) {
        window.setTimeout(() => {
          if (this.editingNameForSessionId === sid) {
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
      if (e.key === "Escape" && this.dirSearchQuery) {
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
    const ongoingRace = this.store.ongoingRace;

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
                    <th class="races-col-actions">Actions</th>
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
                      const toggleAct = s.active
                        ? "pause-session"
                        : s.paused
                          ? "resume-session"
                          : "start-session";
                      const toggleLabel = s.active
                        ? "Pause session"
                        : s.paused
                          ? "Resume session"
                          : "Start session";

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
                                  class="btn btn-icon btn-ghost dir-action-btn"
                                  data-practice-act="open-session"
                                  data-session-id="${esc(sid)}"
                                  title="Open session workspace"
                                  aria-label="Open session workspace"
                                >
                                  ${icons.arrowRight(18)}
                                </button>
                                <button
                                  type="button"
                                  class="btn btn-icon dir-action-btn ${s.active ? "btn-armed" : "btn-ghost"}"
                                  data-practice-act="${toggleAct}"
                                  data-session-id="${esc(sid)}"
                                  title="${
                                    s.active
                                      ? "Pause live RF timing for this session"
                                      : ongoingRace
                                        ? `Race '${ongoingRace.config.eventName}' is ongoing — click to pause it and ${toggleLabel.toLowerCase()}`
                                        : `${toggleLabel} on RF hardware`
                                  }"
                                  aria-label="${toggleLabel}"
                                >
                                  ${s.active ? icons.pause(18) : icons.play(18)}
                                </button>
                                <button
                                  type="button"
                                  class="btn btn-icon btn-ghost dir-action-btn"
                                  data-practice-act="delete-session"
                                  data-session-id="${esc(sid)}"
                                  ${s.active ? "disabled" : ""}
                                  title="${s.active ? "Pause this live session before deleting" : "Delete session"}"
                                  aria-label="Delete session"
                                >
                                  ${icons.trash(18)}
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>`;
                    })
                    .join("")}
                </tbody>
              </table>
            </div>`;

    const footNote =
      allSessions.length === 0
        ? "No sessions created yet · Click + Session to add one inline."
        : hasAnyFilter
          ? `Showing ${filtered.length} of ${allSessions.length} session${allSessions.length === 1 ? "" : "s"}`
          : `${allSessions.length} session${allSessions.length === 1 ? "" : "s"} · Click a name or tag cell to edit inline, or use Actions to open.`;

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

  private refreshDirectoryResultsDom(): void {
    const dirHost = this.slot("directory");
    const resultsEl = dirHost.querySelector<HTMLElement>("[data-session-dir-results]");
    if (!resultsEl) {
      this.lastDirSig = "";
      this.renderDirectory();
      return;
    }
    const vm = this.computeSessionDirectoryViewModel();
    resultsEl.innerHTML = vm.tableOrEmptyMarkup;
    const footEl = dirHost.querySelector<HTMLElement>("[data-session-dir-foot-note]");
    if (footEl) footEl.textContent = vm.footNote;
    const clearWrap = dirHost.querySelector<HTMLElement>("[data-session-dir-clear-wrap]");
    if (clearWrap) {
      clearWrap.innerHTML = vm.hasAnyFilter
        ? `<button type="button" class="btn btn-ghost btn-xs" data-tag-filter="__reset_all__">Clear (${vm.filtered.length}/${vm.allSessions.length})</button>`
        : "";
    }
    this.mountActiveSessionTagEditor(false);
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
      sortedTags,
      untaggedCount,
      liveCount,
      stoppedCount,
      withLapsCount,
      hasAnyFilter,
      isTagAllSelected,
      tableOrEmptyMarkup,
      footNote,
    } = vm;

    const tagsSubRow = `<div class="dir-filter-tags-row" role="toolbar" aria-label="Filter practice sessions by tag">
            <button type="button" class="races-filter-pill ${isTagAllSelected ? "is-active" : ""}" data-tag-filter="__all__">
              All tags (${allSessions.length})
            </button>
            ${sortedTags
              .map(
                ({ key, label, count }) => `
                <button
                  type="button"
                  class="races-filter-pill ${this.selectedFilterTags.has(key) ? "is-active" : ""}"
                  data-tag-filter="${esc(label)}"
                  title="Toggle filter for #${esc(label)}"
                >
                  ${icons.tag(12)}<span>#${esc(label)} (${count})</span>
                </button>`
              )
              .join("")}
            <button type="button" class="races-filter-pill ${this.untaggedOnly ? "is-active" : ""}" data-tag-filter="__untagged__">
              Untagged (${untaggedCount})
            </button>
          </div>`;

    const filterToolbarMarkup = `
      <div class="dir-filter-toolbar" data-session-dir-toolbar>
        <div class="dir-filter-main-row">
          <div class="dir-filter-search-row">
            ${icons.search(15)}
            <input
              type="search"
              class="input input-sm dir-filter-search-input"
              data-session-dir-search
              placeholder="Filter sessions by name, pilot, or #tag…"
              aria-label="Filter practice sessions"
              value="${esc(this.dirSearchQuery)}"
              autocomplete="off"
            />
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
        ${tagsSubRow}
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
      <section class="settings-section">
        <div class="settings-intro">
          <h2>Practice sessions</h2>
          <p>Organize open practice, warmups, and tuning packs. Click any session row to open its timing workspace, or filter by name, pilot, status, and tags.</p>
        </div>
        <div class="settings-cards">
          ${ongoingNote}
          <div class="card card-flush races-dir-card">
            ${filterToolbarMarkup}
            <div data-session-dir-results>${tableOrEmptyMarkup}</div>
            <div class="rules-foot">
              <p class="note" data-session-dir-foot-note>${esc(footNote)}</p>
              <div class="rules-foot-actions">
                <button class="btn btn-ghost btn-sm" type="button" data-practice-act="create-session-inline">${icons.plus(14)}<span>Session</span></button>
              </div>
            </div>
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
            ? `Race '${ongoingRace.config.eventName}' is ongoing — click to pause it and ${isPaused ? "resume" : "start"} practice`
            : isPaused
              ? "Resume live RF timing for this practice session"
              : "Start live RF timing for this practice session";

        const toggleButtonHtml = `<button
              type="button"
              class="btn btn-sm ${isActive ? "btn-armed" : "btn-unarmed"}"
              data-practice-act="${toggleAction}"
              data-session-id="${esc(sess.sessionId)}"
              title="${esc(toggleTitle)}"
            >
              ${isActive ? icons.pause(14) : icons.play(14)}<span>${toggleText}</span>
            </button>`;

        ctrlEl.innerHTML = `
          <div class="practice-strip-info">
            <span
              class="status-dot ${ledDotClass}"
              data-practice-status="${statusKey}"
              title="${esc(statusTitle)}"
            ></span>
            <span class="practice-strip-meta">${sess.pilots.length} pilot${sess.pilots.length === 1 ? "" : "s"} · ${sess.laps.length} lap${sess.laps.length === 1 ? "" : "s"}</span>
          </div>
          <div class="practice-strip-actions">
            ${toggleButtonHtml}
          </div>`;
      } else {
        ctrlEl.innerHTML = "";
      }
    }

    this.renderPilotAddSlot();
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

    const assignedSet = new Set(sess.pilots.map((p) => p.slotIndex));
    const availableGlobal = this.store.pilots.filter((p) => !assignedSet.has(p.slotIndex));
    const sessionFull = sess.pilots.length >= 8;

    const popoverHtml = this.pilotPopoverOpen
      ? `<div class="practice-pilot-popover" role="dialog" aria-label="Manage session pilots">
          <div class="practice-pop-head">
            <div>
              <div class="practice-pop-title">Session pilots (${sess.pilots.length}/8)</div>
              <div class="note">Removing a pilot keeps their recorded laps in this session.</div>
            </div>
            <button type="button" class="btn btn-xs btn-icon btn-ghost" data-practice-act="close-pilot-popover" aria-label="Close">
              ${icons.close(14)}
            </button>
          </div>

          <div class="rc-pilots-search-bar practice-pop-search-bar">
            <div class="rc-pilots-search-row">
              ${icons.search(13)}
              <input
                type="search"
                class="input input-sm rc-pilots-search-input"
                data-new-session-pilot-input
                placeholder="Search or add pilot..."
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
              title="${sessionFull ? "Maximum 8 pilots per session" : "Search or type a unique callsign to add"}"
            >
              ${icons.plus(12)}<span>Add</span>
            </button>
          </div>

          <div class="practice-pop-section">
            ${
              sess.pilots.length === 0
                ? `<div class="practice-pop-empty note">No pilots assigned yet. Add from global pilots below.</div>`
                : `<div class="practice-pop-list">
                    ${sess.pilots
                      .map((sp) => {
                        const base = this.store.pilot(sp.slotIndex);
                        const color = base?.color || sp.color || "#38bdf8";
                        const callsign = base?.callsign || sp.callsign;
                        const laps = lapCountsBySlot.get(sp.slotIndex) ?? 0;
                        const chOpts = renderMultiBandSelectOptionsHtml({
                          selectedBand: sp.band,
                          selectedChannel: sp.channel,
                          includeUnassigned: true,
                          unassignedLabel: "No ch",
                          compact: true,
                        });
                        const callsignLower = callsign.trim().toLowerCase();
                        const chSearch = pilotChannelSearchTokens(sp.band, sp.channel, sp.frequencyMhz);
                        const hay = `${callsign} ${base?.phoneticName ?? ""} ${chSearch} #${sp.slotIndex}`.toLowerCase();
                        return `
                          <div class="practice-pop-row" data-session-pilot-row="${sp.slotIndex}" data-pilot-callsign="${esc(callsignLower)}" data-pilot-search-hay="${esc(hay)}">
                            <div class="practice-pop-pilot-info">
                              <span class="dot ${sess.active && !sess.paused && this.store.raceArmed ? "is-live" : "is-off"}" style="--c:${esc(color)}"></span>
                              <span class="practice-pop-name">${esc(callsign)}</span>
                              <span class="note mono">${laps} lap${laps === 1 ? "" : "s"}</span>
                            </div>
                            <div class="practice-pop-row-actions">
                              <select
                                class="input mono practice-pop-ch-select"
                                data-session-pilot-channel="${sp.slotIndex}"
                                aria-label="Channel for ${esc(callsign)}"
                              >
                                ${chOpts}
                              </select>
                              <button
                                type="button"
                                class="btn btn-xs btn-icon btn-ghost"
                                data-practice-act="remove-session-pilot"
                                data-slot-index="${sp.slotIndex}"
                                title="Remove from session (retains recorded laps)"
                                aria-label="Remove ${esc(callsign)} from session"
                              >
                                ${icons.close(13)}
                              </button>
                            </div>
                          </div>`;
                      })
                      .join("")}
                  </div>`
            }
          </div>

          <div class="practice-pop-section">
            <div class="practice-pop-subhead">
              <span>Global pilot directory</span>
              <a href="#/pilots" class="practice-pop-dir-link">Manage all ›</a>
            </div>
            ${
              availableGlobal.length === 0
                ? `<div class="practice-pop-empty note">All global pilots are already assigned to this session.</div>`
                : `<div class="practice-pop-list practice-pop-available-list">
                    ${availableGlobal
                      .map((gp) => {
                        const savedLaps = lapCountsBySlot.get(gp.slotIndex) ?? 0;
                        const chLabel = formatBandChannelShort(gp.band, gp.channel) || "No ch";
                        const callsignLower = gp.callsign.trim().toLowerCase();
                        const chSearch = pilotChannelSearchTokens(gp.band, gp.channel, gp.frequencyMhz);
                        const hay = `${gp.callsign} ${gp.phoneticName ?? ""} ${chSearch} #${gp.slotIndex}`.toLowerCase();
                        return `
                          <div class="practice-pop-row" data-available-pilot-row="${gp.slotIndex}" data-pilot-callsign="${esc(callsignLower)}" data-pilot-search-hay="${esc(hay)}">
                            <div class="practice-pop-pilot-info">
                              <span class="dot is-off" style="--c:${esc(gp.color || "#38bdf8")}"></span>
                              <span class="practice-pop-name">${esc(gp.callsign)}</span>
                              <span class="note mono">${chLabel}</span>
                              ${
                                savedLaps > 0
                                  ? `<span class="practice-saved-laps-pill" title="Recorded laps preserved in this session">${savedLaps} lap${savedLaps === 1 ? "" : "s"} saved</span>`
                                  : ""
                              }
                            </div>
                            <button
                              type="button"
                              class="btn btn-ghost btn-xs"
                              data-practice-act="add-session-pilot"
                              data-slot-index="${gp.slotIndex}"
                              ${sessionFull ? "disabled" : ""}
                              title="${sessionFull ? "Maximum 8 pilots per session" : `Add ${gp.callsign} to session`}"
                            >
                              ${icons.plus(12)}<span>Add</span>
                            </button>
                          </div>`;
                      })
                      .join("")}
                  </div>`
            }
          </div>
        </div>`
      : "";

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

  private showPanel(): void {
    const focus = this.store.liveFocus;
    const mode = focus === null ? null : 0;
    const shownMode = this.shownFocus === undefined ? undefined : this.shownFocus === null ? null : 0;
    this.shownFocus = focus;
    if (mode === shownMode && this.panel) return;

    this.panel?.destroy();
    const host = this.slot("panel");
    this.panel =
      focus === null
        ? new AllPilotsPanel(host, this.workspaceStore, this.api, (slot) => this.store.setLiveFocus(slot))
        : new PilotPanel(host, this.workspaceStore, this.api);
  }
}
