import { Component } from "../core/component";
import { isCustomSelectOpenWithin } from "../core/custom_select";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import {
  BAND_RACEBAND,
  decodeBandChannel,
  pilotChannelSearchTokens,
  renderMultiBandSelectOptionsHtml,
} from "../core/vtx_channels";
import { ApiClient } from "../services/api_client";
import { sharedMultiGPService } from "../services/multigp_service";
import { AppStore } from "../state/store";
import { isRotorHazardMode, PilotSlot } from "../types/models";
import { openMultiGPErrorModal } from "./MultiGPRaceModals";
import { showToast } from "./Toast";

const DEFAULT_ENTER_THRESHOLD_DBM = -58;
const DEFAULT_EXIT_THRESHOLD_DBM = -68;
const DEFAULT_LAPRF_GAIN = 59;
const DEFAULT_LAPRF_THRESHOLD = 800;
const DEFAULT_RH_ENTER_THRESHOLD = 95;
const DEFAULT_RH_EXIT_THRESHOLD = 70;
const PILOTS_PER_PAGE = 10;
const MAX_RECENT_PILLS = 8;

type RecentPilotPill =
  | { id: string; kind: "pilot"; slotIndex: number; fallbackCallsign: string }
  | { id: string; kind: "query"; query: string };

interface PilotDirSessionState {
  recentPills: RecentPilotPill[];
  activePillId: string | null;
}

const sessionStateByStore = new WeakMap<AppStore, PilotDirSessionState>();

function getSessionState(store: AppStore): PilotDirSessionState {
  let st = sessionStateByStore.get(store);
  if (!st) {
    st = { recentPills: [], activePillId: null };
    sessionStateByStore.set(store, st);
  }
  return st;
}

/**
 * Global system pilot directory (paginated at 10 per page).
 * Practice sessions and Races reference pilots from this master directory.
 */
export class PilotSlotsEditor extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private searchQuery = "";
  private currentPage = 1;
  private mgpImportInFlight = false;
  private mobileSelectedSlot: number | null = null;
  private lastRfLocked = false;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;
    this.lastRfLocked = this.isLiveHeatLockingChannels();
    el.addEventListener("submit", this.handleSubmit);
    el.addEventListener("change", this.handleChange);
    el.addEventListener("input", this.handleInput);
    el.addEventListener("keydown", this.handleKeyDown);
    el.addEventListener("click", this.handleClick);
    this.onDispose(() => {
      el.removeEventListener("submit", this.handleSubmit);
      el.removeEventListener("change", this.handleChange);
      el.removeEventListener("input", this.handleInput);
      el.removeEventListener("keydown", this.handleKeyDown);
      el.removeEventListener("click", this.handleClick);
    });
    this.onDispose(
      sharedMultiGPService.subscribe(() => {
        if (!isCustomSelectOpenWithin(this.el)) {
          this.render();
        }
      })
    );
    this.onDispose(
      store.subscribe(["config"], () => {
        const active = document.activeElement;
        const editingRowInput =
          active instanceof HTMLInputElement &&
          this.el.contains(active) &&
          !active.hasAttribute("data-pilot-dir-search");
        if (!editingRowInput && !isCustomSelectOpenWithin(this.el)) {
          this.render();
        }
      })
    );
    this.onDispose(
      store.subscribe(["race"], () => {
        const nextLocked = this.isLiveHeatLockingChannels();
        if (nextLocked === this.lastRfLocked) return;
        this.lastRfLocked = nextLocked;
        const active = document.activeElement;
        const editingRowInput =
          active instanceof HTMLInputElement &&
          this.el.contains(active) &&
          !active.hasAttribute("data-pilot-dir-search");
        if (!editingRowInput) {
          this.render();
        }
      })
    );
    this.render();
  }

  private isLiveHeatLockingChannels(): boolean {
    const h = this.store.activeRaceHeat;
    return !!h && (h.state === "countdown" || h.state === "running" || h.state === "paused");
  }

  private hasDuplicateCallsign(callsign: string, excludeSlotIndex: number): boolean {
    const needle = callsign.trim().toLowerCase();
    if (!needle) return false;
    return this.store.pilots.some(
      (p) => p.slotIndex !== excludeSlotIndex && p.callsign.trim().toLowerCase() === needle
    );
  }

  private matchQuery(pilots: PilotSlot[], rawQuery: string): PilotSlot[] {
    const q = rawQuery.trim().toLowerCase();
    if (!q) return pilots;
    return pilots.filter((p) => {
      const chLabel = pilotChannelSearchTokens(p.band, p.channel, p.frequencyMhz);
      return (
        p.callsign.toLowerCase().includes(q) ||
        (p.phoneticName ?? "").toLowerCase().includes(q) ||
        chLabel.includes(q)
      );
    });
  }

  private reconcileRecentPills(pilots: PilotSlot[]): PilotDirSessionState {
    const st = getSessionState(this.store);
    const bySlot = new Map<number, PilotSlot>();
    for (const p of pilots) bySlot.set(p.slotIndex, p);

    const nextPills: RecentPilotPill[] = [];
    for (const pill of st.recentPills) {
      if (pill.kind === "pilot") {
        const livePilot = bySlot.get(pill.slotIndex);
        if (!livePilot) {
          if (st.activePillId === pill.id) {
            st.activePillId = null;
            this.currentPage = 1;
          }
          continue;
        }
        pill.fallbackCallsign = livePilot.callsign;
        nextPills.push(pill);
      } else {
        nextPills.push(pill);
      }
    }
    st.recentPills = nextPills;
    if (st.activePillId && !st.recentPills.some((p) => p.id === st.activePillId)) {
      st.activePillId = null;
      this.currentPage = 1;
    }
    return st;
  }

  private upsertRecentPill(pill: RecentPilotPill, select = true): void {
    const st = getSessionState(this.store);
    const labelLower =
      pill.kind === "pilot"
        ? pill.fallbackCallsign.trim().toLowerCase()
        : pill.query.trim().toLowerCase();

    st.recentPills = [
      pill,
      ...st.recentPills.filter((existing) => {
        if (existing.id === pill.id) return false;
        if (pill.kind === "pilot" && existing.kind === "query") {
          return existing.query.trim().toLowerCase() !== labelLower;
        }
        if (pill.kind === "query" && existing.kind === "query") {
          return existing.query.trim().toLowerCase() !== labelLower;
        }
        return true;
      }),
    ].slice(0, MAX_RECENT_PILLS);

    if (select) {
      st.activePillId = pill.id;
      this.currentPage = 1;
    }
  }

  private commitActiveSearchOnRowEdit(editedSlotIndex: number): void {
    const trimmed = this.searchQuery.trim();
    if (!trimmed) return;
    const pilots = this.store.pilots;
    const matches = this.matchQuery(pilots, trimmed);
    if (matches.length === 0) return;

    const exact = pilots.find((p) => p.callsign.trim().toLowerCase() === trimmed.toLowerCase());
    const targetPilot =
      exact ?? (matches.length === 1 ? this.store.pilot(editedSlotIndex) ?? matches[0] : undefined);

    if (targetPilot) {
      this.upsertRecentPill(
        {
          id: `pilot:${targetPilot.slotIndex}`,
          kind: "pilot",
          slotIndex: targetPilot.slotIndex,
          fallbackCallsign: targetPilot.callsign,
        },
        true
      );
    } else {
      this.upsertRecentPill(
        {
          id: `query:${trimmed.toLowerCase()}`,
          kind: "query",
          query: trimmed,
        },
        true
      );
    }

    this.searchQuery = "";
    const searchEl = this.el.querySelector<HTMLInputElement>("[data-pilot-dir-search]");
    if (searchEl) searchEl.value = "";
    const existingRecentSlot = this.el.querySelector<HTMLElement>("[data-pilot-recent-slot]");
    if (existingRecentSlot) {
      const st = this.reconcileRecentPills(pilots);
      existingRecentSlot.innerHTML = this.renderRecentBar(pilots, st);
    }
    const addBtn = this.el.querySelector<HTMLButtonElement>("[data-action=add-pilot]");
    if (addBtn) {
      addBtn.disabled = true;
      addBtn.title = "Search or type a unique callsign to add";
    }
    const noteEl = this.el.querySelector<HTMLElement>("[data-roster-note]");
    if (noteEl) {
      const shown = this.filterPilots(pilots);
      noteEl.textContent = this.formatFooterNote(pilots.length, shown.length, true, this.isLiveHeatLockingChannels());
    }
  }

  private filterPilots(pilots: PilotSlot[]): PilotSlot[] {
    const trimmed = this.searchQuery.trim();
    if (trimmed) {
      return this.matchQuery(pilots, trimmed);
    }
    const st = getSessionState(this.store);
    if (!st.activePillId) return pilots;
    const activePill = st.recentPills.find((p) => p.id === st.activePillId);
    if (!activePill) return pilots;
    if (activePill.kind === "pilot") {
      return pilots.filter((p) => p.slotIndex === activePill.slotIndex);
    }
    return this.matchQuery(pilots, activePill.query);
  }

  private renderRecentBar(pilots: PilotSlot[], st: PilotDirSessionState): string {
    if (st.recentPills.length === 0) return "";
    const bySlot = new Map<number, PilotSlot>();
    for (const p of pilots) bySlot.set(p.slotIndex, p);

    const pillsHtml = st.recentPills
      .map((pill) => {
        const isActive = st.activePillId === pill.id && !this.searchQuery.trim();
        let leadHtml = "";
        let label = "";
        if (pill.kind === "pilot") {
          const p = bySlot.get(pill.slotIndex);
          label = p?.callsign ?? pill.fallbackCallsign;
          const color = p?.color ?? "#94a3b8";
          leadHtml = `<span class="dot pilot-dir-recent-dot" style="--c:${esc(color)}"></span>`;
        } else {
          label = pill.query;
          leadHtml = `<span class="pilot-dir-recent-icon">${icons.search(11)}</span>`;
        }
        const toggleTitle = isActive
          ? `Click to unselect “${label}” and return to page 1`
          : `Filter by “${label}”`;
        return `
          <div class="pilot-dir-recent-pill ${isActive ? "is-active" : ""}" data-recent-pill="${esc(pill.id)}">
            <button
              type="button"
              class="pilot-dir-recent-select"
              data-recent-select="${esc(pill.id)}"
              aria-pressed="${isActive ? "true" : "false"}"
              title="${esc(toggleTitle)}"
            >
              ${leadHtml}
              <span class="pilot-dir-recent-text">${esc(label)}</span>
            </button>
            <button
              type="button"
              class="pilot-dir-recent-remove"
              data-recent-remove="${esc(pill.id)}"
              title="Remove “${esc(label)}” from recent"
              aria-label="Remove ${esc(label)} from recent"
            >
              ${icons.close(10)}
            </button>
          </div>`;
      })
      .join("");

    return `
      <div class="pilot-dir-recent-bar" role="region" aria-label="Recent pilot filters">
        <span class="pilot-dir-recent-label">Recent</span>
        <div class="pilot-dir-recent-list">
          ${pillsHtml}
        </div>
        <button
          type="button"
          class="pilot-dir-recent-clear"
          data-action="clear-recent-pilots"
          title="Clear recent filters and show all pilots"
        >
          Clear
        </button>
      </div>`;
  }

  private formatFooterNote(
    totalCount: number,
    shownCount: number,
    isFiltered: boolean,
    rfLocked: boolean
  ): string {
    if (rfLocked) {
      return "Live race heat in progress — active heat RF channels are locked until the heat finishes.";
    }
    if (isFiltered) {
      return `Showing ${shownCount} of ${totalCount} pilot${totalCount === 1 ? "" : "s"} in global directory · Assign pilots to Practice sessions or Races.`;
    }
    return `${totalCount} pilot${totalCount === 1 ? "" : "s"} in global directory · Assign pilots to Practice sessions or Races.`;
  }

  private render(): void {
    const pilots = this.store.pilots;
    const st = this.reconcileRecentPills(pilots);
    const shown = this.filterPilots(pilots);
    const canRemove = pilots.length > 2;
    const rfLocked = this.isLiveHeatLockingChannels();

    const trimmedSearch = this.searchQuery.trim();
    const exactMatch = trimmedSearch
      ? pilots.find((p) => p.callsign.trim().toLowerCase() === trimmedSearch.toLowerCase())
      : undefined;
    const addDisabled = !trimmedSearch || !!exactMatch;
    const addBtnTitle = exactMatch
      ? `Pilot “${exactMatch.callsign}” already exists`
      : trimmedSearch
        ? `Add pilot “${trimmedSearch}”`
        : "Search or type a unique callsign to add";

    const activePill = !trimmedSearch && st.activePillId
      ? st.recentPills.find((p) => p.id === st.activePillId)
      : undefined;
    const emptyFilterLabel = trimmedSearch
      ? trimmedSearch
      : activePill
        ? activePill.kind === "pilot"
          ? activePill.fallbackCallsign
          : activePill.query
        : "";

    const totalPages = Math.max(1, Math.ceil(shown.length / PILOTS_PER_PAGE));
    this.currentPage = Math.max(1, Math.min(this.currentPage, totalPages));
    const pageStart = (this.currentPage - 1) * PILOTS_PER_PAGE;
    const pagePilots = shown.slice(pageStart, pageStart + PILOTS_PER_PAGE);
    const pageEnd = Math.min(shown.length, pageStart + pagePilots.length);

    const rowsHtml =
      shown.length === 0
        ? `<div class="pilot-dir-empty note">No pilots match “${esc(emptyFilterLabel)}”.</div>`
        : pagePilots
            .map((p) =>
              this.renderPilotRow(
                p,
                canRemove,
                rfLocked,
                !!exactMatch && p.slotIndex === exactMatch.slotIndex
              )
            )
            .join("");

    const paginationHtml =
      shown.length > PILOTS_PER_PAGE
        ? `<div class="pilot-dir-pagination" role="navigation" aria-label="Pilots pagination">
             <span class="pilot-dir-page-summary mono">Showing ${pageStart + 1}–${pageEnd} of ${shown.length}</span>
             <div class="pilot-dir-page-controls">
               <button
                 type="button"
                 class="btn btn-ghost btn-sm"
                 data-pilot-page="prev"
                 ${this.currentPage <= 1 ? "disabled" : ""}
                 aria-label="Previous page"
               >Prev</button>
               <span class="pilot-dir-page-indicator mono">Page ${this.currentPage} of ${totalPages}</span>
               <button
                 type="button"
                 class="btn btn-ghost btn-sm"
                 data-pilot-page="next"
                 ${this.currentPage >= totalPages ? "disabled" : ""}
                 aria-label="Next page"
               >Next</button>
             </div>
           </div>`
        : "";

    const isLapRF = this.store.timingHardwareMode === "laprf";
    const isRH = isRotorHazardMode(this.store.timingHardwareMode);
    const col4Title = isLapRF
      ? "Gain (0–63)"
      : isRH
        ? "Enter (10–250)"
        : "Enter threshold";
    const col5Title = isLapRF
      ? "Threshold"
      : isRH
        ? "Exit (6–246)"
        : "Exit threshold";
    const innerHtml = `
          <div class="slot-row has-remove slot-head">
            <span>Pilot</span><span>Phonetic name</span><span>Default channel</span><span>${col4Title}</span><span>${col5Title}</span><span></span>
          </div>
          ${rowsHtml}`;

    const mobileHtml = this.renderMobilePills(
      shown,
      pagePilots,
      emptyFilterLabel,
      exactMatch
    );
    const mobileEditorHtml = this.renderMobilePilotEditor(
      pilots,
      canRemove,
      rfLocked
    );

    const isFiltered = Boolean(trimmedSearch || activePill);
    const recentBarHtml = this.renderRecentBar(pilots, st);
    const noteText = this.formatFooterNote(pilots.length, shown.length, isFiltered, rfLocked);

    const mgpAvailable = sharedMultiGPService.isAvailable(this.store);
    const existingMgpBtn = this.el.querySelector<HTMLButtonElement>("[data-action=import-mgp-pilots]");
    const existingTable = this.el.querySelector<HTMLElement>(".slot-table");
    const existingMobileSlot = this.el.querySelector<HTMLElement>("[data-pilot-mobile-slot]");
    const existingMobileEditorSlot = this.el.querySelector<HTMLElement>("[data-pilot-mobile-editor-slot]");
    const existingFoot = this.el.querySelector<HTMLElement>(".rules-foot");
    const existingPagerSlot = this.el.querySelector<HTMLElement>("[data-pilot-pagination-slot]");
    const existingRecentSlot = this.el.querySelector<HTMLElement>("[data-pilot-recent-slot]");
    if (
      existingTable &&
      existingMobileSlot &&
      existingMobileEditorSlot &&
      existingFoot &&
      existingPagerSlot &&
      existingRecentSlot
    ) {
      existingTable.innerHTML = innerHtml;
      existingMobileSlot.innerHTML = mobileHtml;
      existingMobileEditorSlot.innerHTML = mobileEditorHtml;
      existingPagerSlot.innerHTML = paginationHtml;
      existingRecentSlot.innerHTML = recentBarHtml;
      if (existingMgpBtn) {
        existingMgpBtn.hidden = !mgpAvailable;
        existingMgpBtn.disabled = this.mgpImportInFlight;
        const spanEl = existingMgpBtn.querySelector("span");
        if (spanEl) spanEl.textContent = this.mgpImportInFlight ? "Downloading…" : "Download from MultiGP";
      }
      const searchEl = this.el.querySelector<HTMLInputElement>("[data-pilot-dir-search]");
      if (searchEl && searchEl.value !== this.searchQuery) {
        searchEl.value = this.searchQuery;
      }
      const addBtn = this.el.querySelector<HTMLButtonElement>("[data-action=add-pilot]");
      if (addBtn) {
        addBtn.disabled = addDisabled;
        addBtn.title = addBtnTitle;
      }
      const noteEl = existingFoot.querySelector<HTMLElement>("[data-roster-note]");
      if (noteEl) noteEl.textContent = noteText;
      return;
    }

    this.el.innerHTML = `
      <div class="pilot-dir-toolbar">
        <div class="pilot-dir-search-bar">
          <div class="pilot-dir-search-wrap">
            ${icons.search(14)}
            <input
              type="search"
              class="input pilot-dir-search-input"
              data-pilot-dir-search
              placeholder="Search or add pilot..."
              aria-label="Search or add pilot"
              value="${esc(this.searchQuery)}"
              autocomplete="off"
            />
          </div>
          <button class="btn btn-unarmed" type="button" data-action="add-pilot" ${addDisabled ? "disabled" : ""} title="${esc(addBtnTitle)}">${icons.plus(14)}<span>Add</span></button>
        </div>
      </div>
      <div data-pilot-recent-slot>${recentBarHtml}</div>
      <div class="table-scroll">
        <div class="slot-table has-remove">${innerHtml}
        </div>
      </div>
      <div class="pilot-dir-mobile-view" data-pilot-mobile-slot>${mobileHtml}</div>
      <div data-pilot-pagination-slot>${paginationHtml}</div>
      <div class="pilot-dir-mobile-editor-wrap" data-pilot-mobile-editor-slot>${mobileEditorHtml}</div>
      <div class="dir-actions-row" role="group" aria-label="Import or export pilots">
        <button
          class="btn btn-ghost btn-sm pilot-dir-mgp-btn"
          type="button"
          data-action="import-mgp-pilots"
          ${mgpAvailable ? "" : "hidden"}
          ${this.mgpImportInFlight ? "disabled" : ""}
          title="Download &amp; merge chapter pilots from MultiGP"
          aria-label="Download pilots from MultiGP"
        >${icons.download(14)}<span>${this.mgpImportInFlight ? "Downloading…" : "Download from MultiGP"}</span></button>
        <button
          class="btn btn-ghost btn-sm"
          type="button"
          data-action="download-pilots-csv"
          title="Download pilots roster (CSV)"
          aria-label="Download pilots roster as CSV"
        >${icons.download(14)}<span>Download CSV</span></button>
        <button
          class="btn btn-ghost btn-sm"
          type="button"
          data-action="upload-pilots-csv"
          title="Upload &amp; merge pilots roster (CSV)"
          aria-label="Upload and merge pilots roster CSV"
        >${icons.upload(14)}<span>Upload CSV</span></button>
        <input type="file" accept=".csv,text/csv" data-pilot-csv-input hidden />
      </div>
      <div class="rules-foot">
        <p class="note" data-roster-note>${esc(noteText)}</p>
        <div class="rules-foot-actions">
          <button class="btn btn-ghost btn-sm" type="button" data-action="restore-default-pilots">Restore defaults</button>
        </div>
      </div>`;
  }

  private renderMobilePills(
    shown: PilotSlot[],
    pagePilots: PilotSlot[],
    emptyFilterLabel: string,
    exactMatch: PilotSlot | undefined
  ): string {
    if (shown.length === 0) {
      return `<div class="pilot-dir-empty note">No pilots match “${esc(emptyFilterLabel)}”.</div>`;
    }
    return `
      <div class="pilot-dir-mobile-pills" role="listbox" aria-label="Pilots">
        ${pagePilots
          .map((p) => {
            const isSelected = this.mobileSelectedSlot === p.slotIndex;
            const isExact = !!exactMatch && p.slotIndex === exactMatch.slotIndex;
            return `
              <button
                type="button"
                role="option"
                aria-selected="${isSelected ? "true" : "false"}"
                class="pilot-dir-mobile-pill ${isSelected ? "is-selected" : ""} ${isExact ? "is-exact-match" : ""}"
                data-mobile-pilot-select="${p.slotIndex}"
                title="Edit ${esc(p.callsign)}"
              >
                <span class="dot" style="--c:${esc(p.color)}"></span>
                <span class="pilot-dir-mobile-pill-name">${esc(p.callsign)}</span>
                ${p.mgpPilotId ? `<span class="badge pilot-mgp-badge mono" title="Linked MultiGP Pilot #${p.mgpPilotId}">MGP</span>` : ""}
              </button>`;
          })
          .join("")}
      </div>`;
  }

  private renderMobilePilotEditor(
    pilots: PilotSlot[],
    canRemove: boolean,
    rfLocked: boolean
  ): string {
    if (this.mobileSelectedSlot === null) return "";
    const p = pilots.find((x) => x.slotIndex === this.mobileSelectedSlot);
    if (!p) return "";

    const isLapRF = this.store.timingHardwareMode === "laprf";
    const isRH = isRotorHazardMode(this.store.timingHardwareMode);
    const enterVal = Math.round(p.enterThreshold || DEFAULT_ENTER_THRESHOLD_DBM);
    const exitVal = Math.round(
      p.exitThreshold && p.exitThreshold < enterVal ? p.exitThreshold : enterVal - 10
    );
    const isCustomThreshold = enterVal !== DEFAULT_ENTER_THRESHOLD_DBM;
    const isCustomExit = exitVal !== DEFAULT_EXIT_THRESHOLD_DBM;

    const gainVal = Math.max(0, Math.min(63, Math.round(p.attenuationGain || DEFAULT_LAPRF_GAIN)));
    const laprfThrVal = Math.max(
      300,
      Math.min(3500, Math.round(p.laprfThreshold || DEFAULT_LAPRF_THRESHOLD))
    );
    const isCustomGain = gainVal !== DEFAULT_LAPRF_GAIN;
    const isCustomLapRFThr = laprfThrVal !== DEFAULT_LAPRF_THRESHOLD;

    const rhEnterVal = Math.max(
      10,
      Math.min(250, Math.round(p.rhEnterThreshold || DEFAULT_RH_ENTER_THRESHOLD))
    );
    const rhExitVal = Math.max(
      6,
      Math.min(
        rhEnterVal - 4,
        Math.round(
          p.rhExitThreshold && p.rhExitThreshold > 0 && p.rhExitThreshold < rhEnterVal
            ? p.rhExitThreshold
            : rhEnterVal - 25
        )
      )
    );
    const isCustomRhEnter = rhEnterVal !== DEFAULT_RH_ENTER_THRESHOLD;
    const isCustomRhExit = rhExitVal !== DEFAULT_RH_EXIT_THRESHOLD;

    const options = renderMultiBandSelectOptionsHtml({
      selectedBand: p.band,
      selectedChannel: p.channel,
      includeUnassigned: true,
      unassignedLabel: "No default",
    });

    const col4Label = isLapRF ? "Gain (0–63)" : isRH ? "Enter (10–250)" : "Enter threshold";
    const col5Label = isLapRF ? "Threshold" : isRH ? "Exit (6–246)" : "Exit threshold";

    const col4Html = isLapRF
      ? `<div class="input-suffix ${isCustomGain ? "has-reset" : ""}">
          <input class="input mono" type="number" name="attenuationGain" value="${gainVal}" min="0" max="63" step="1" />
          <span>gain</span>
          ${isCustomGain ? `<button type="button" class="flasher-pass-toggle rule-inline-btn is-active" data-reset-laprf-gain="${p.slotIndex}" aria-label="Restore default LapRF gain">${icons.reset(13)}</button>` : ""}
        </div>`
      : isRH
        ? `<div class="input-suffix ${isCustomRhEnter ? "has-reset" : ""}">
          <input class="input mono" type="number" name="rhEnterThreshold" value="${rhEnterVal}" min="10" max="250" step="1" />
          <span>RSSI</span>
          ${isCustomRhEnter ? `<button type="button" class="flasher-pass-toggle rule-inline-btn is-active" data-reset-rh-enter="${p.slotIndex}" aria-label="Restore default RotorHazard Enter threshold">${icons.reset(13)}</button>` : ""}
        </div>`
        : `<div class="input-suffix ${isCustomThreshold ? "has-reset" : ""}">
          <input class="input mono" type="number" name="threshold" value="${enterVal}" min="-95" max="-20" step="1" />
          <span>dBm</span>
          ${isCustomThreshold ? `<button type="button" class="flasher-pass-toggle rule-inline-btn is-active" data-reset-threshold="${p.slotIndex}" aria-label="Restore default enter threshold">${icons.reset(13)}</button>` : ""}
        </div>`;

    const col5Html = isLapRF
      ? `<div class="input-suffix ${isCustomLapRFThr ? "has-reset" : ""}">
          <input class="input mono" type="number" name="laprfThreshold" value="${laprfThrVal}" min="300" max="3500" step="10" />
          <span>RSSI</span>
          ${isCustomLapRFThr ? `<button type="button" class="flasher-pass-toggle rule-inline-btn is-active" data-reset-laprf-threshold="${p.slotIndex}" aria-label="Restore default LapRF threshold">${icons.reset(13)}</button>` : ""}
        </div>`
      : isRH
        ? `<div class="input-suffix ${isCustomRhExit ? "has-reset" : ""}">
          <input class="input mono" type="number" name="rhExitThreshold" value="${rhExitVal}" min="6" max="246" step="1" />
          <span>RSSI</span>
          ${isCustomRhExit ? `<button type="button" class="flasher-pass-toggle rule-inline-btn is-active" data-reset-rh-exit="${p.slotIndex}" aria-label="Restore default RotorHazard Exit threshold">${icons.reset(13)}</button>` : ""}
        </div>`
        : `<div class="input-suffix ${isCustomExit ? "has-reset" : ""}">
          <input class="input mono" type="number" name="exitThreshold" value="${exitVal}" min="-105" max="-22" step="1" />
          <span>dBm</span>
          ${isCustomExit ? `<button type="button" class="flasher-pass-toggle rule-inline-btn is-active" data-reset-exit-threshold="${p.slotIndex}" aria-label="Restore default exit threshold">${icons.reset(13)}</button>` : ""}
        </div>`;

    return `
      <div class="pilot-dir-mobile-editor">
        <div class="pilot-dir-mobile-editor-head">
          <div class="pilot-dir-mobile-editor-title">
            <span class="dot" style="--c:${esc(p.color)}"></span>
            <strong>${esc(p.callsign)}</strong>
            ${p.mgpPilotId ? `<span class="badge pilot-mgp-badge mono">MGP</span>` : ""}
          </div>
          <div class="pilot-dir-mobile-editor-head-actions">
            <button
              type="button"
              class="btn btn-ghost btn-xs"
              data-remove-pilot="${p.slotIndex}"
              ${canRemove && !rfLocked ? "" : "disabled"}
              title="${canRemove ? `Remove ${esc(p.callsign)}` : "At least 2 pilots are required"}"
              aria-label="Remove ${esc(p.callsign)}"
            >${icons.trash(13)}<span>Remove</span></button>
            <button
              type="button"
              class="btn btn-ghost btn-xs"
              data-mobile-pilot-close
              aria-label="Close pilot editor"
            >${icons.close(14)}</button>
          </div>
        </div>
        <form class="pilot-dir-mobile-form" data-pilot="${p.slotIndex}">
          <div class="pilot-dir-mobile-grid">
            <label class="field">
              <span>Pilot</span>
              <div class="input-with-dot ${p.mgpPilotId ? "has-mgp" : ""}">
                <span class="dot" style="--c:${esc(p.color)}"></span>
                <input class="input" name="callsign" value="${esc(p.callsign)}" maxlength="32" autocomplete="off" />
                ${p.mgpPilotId ? `<span class="badge pilot-mgp-badge mono">MGP</span>` : ""}
              </div>
            </label>
            <label class="field">
              <span>Phonetic name</span>
              <input class="input" name="phoneticName" value="${esc(p.phoneticName ?? "")}" maxlength="32" autocomplete="off" />
            </label>
            <label class="field">
              <span>Default channel</span>
              <select class="input" name="channel" ${rfLocked ? "disabled" : ""}>${options}</select>
            </label>
            <div class="pilot-dir-mobile-thresh-row">
              <label class="field">
                <span>${col4Label}</span>
                ${col4Html}
              </label>
              <label class="field">
                <span>${col5Label}</span>
                ${col5Html}
              </label>
            </div>
          </div>
        </form>
      </div>`;
  }

  private renderPilotRow(
    p: PilotSlot,
    canRemove: boolean,
    rfLocked: boolean,
    isExactMatch = false
  ): string {
    const isLapRF = this.store.timingHardwareMode === "laprf";
    const isRH = isRotorHazardMode(this.store.timingHardwareMode);
    const enterVal = Math.round(p.enterThreshold || DEFAULT_ENTER_THRESHOLD_DBM);
    const exitVal = Math.round(
      p.exitThreshold && p.exitThreshold < enterVal ? p.exitThreshold : enterVal - 10
    );
    const isCustomThreshold = enterVal !== DEFAULT_ENTER_THRESHOLD_DBM;
    const isCustomExit = exitVal !== DEFAULT_EXIT_THRESHOLD_DBM;

    const gainVal = Math.max(0, Math.min(63, Math.round(p.attenuationGain || DEFAULT_LAPRF_GAIN)));
    const laprfThrVal = Math.max(
      300,
      Math.min(3500, Math.round(p.laprfThreshold || DEFAULT_LAPRF_THRESHOLD))
    );
    const isCustomGain = gainVal !== DEFAULT_LAPRF_GAIN;
    const isCustomLapRFThr = laprfThrVal !== DEFAULT_LAPRF_THRESHOLD;

    const rhEnterVal = Math.max(
      10,
      Math.min(250, Math.round(p.rhEnterThreshold || DEFAULT_RH_ENTER_THRESHOLD))
    );
    const rhExitVal = Math.max(
      6,
      Math.min(
        rhEnterVal - 4,
        Math.round(
          p.rhExitThreshold && p.rhExitThreshold > 0 && p.rhExitThreshold < rhEnterVal
            ? p.rhExitThreshold
            : rhEnterVal - 25
        )
      )
    );
    const isCustomRhEnter = rhEnterVal !== DEFAULT_RH_ENTER_THRESHOLD;
    const isCustomRhExit = rhExitVal !== DEFAULT_RH_EXIT_THRESHOLD;

    const options = renderMultiBandSelectOptionsHtml({
      selectedBand: p.band,
      selectedChannel: p.channel,
      includeUnassigned: true,
      unassignedLabel: "No default",
    });

    const col4Html = isLapRF
      ? `<div class="input-suffix ${isCustomGain ? "has-reset" : ""}">
          <input class="input mono" type="number" name="attenuationGain" value="${gainVal}" min="0" max="63" step="1" title="LapRF receiver gain (0–63, default 59)" />
          <span>gain</span>
          ${
            isCustomGain
              ? `<button type="button" class="flasher-pass-toggle rule-inline-btn is-active" data-reset-laprf-gain="${p.slotIndex}" title="Restore default LapRF gain (${DEFAULT_LAPRF_GAIN})" aria-label="Restore default LapRF gain">${icons.reset(13)}</button>`
              : ""
          }
        </div>`
      : isRH
        ? `<div class="input-suffix ${isCustomRhEnter ? "has-reset" : ""}">
          <input class="input mono" type="number" name="rhEnterThreshold" value="${rhEnterVal}" min="10" max="250" step="1" title="RotorHazard node EnterAt threshold (0–255 RSSI, default 95)" />
          <span>RSSI</span>
          ${
            isCustomRhEnter
              ? `<button type="button" class="flasher-pass-toggle rule-inline-btn is-active" data-reset-rh-enter="${p.slotIndex}" title="Restore default RotorHazard Enter threshold (${DEFAULT_RH_ENTER_THRESHOLD})" aria-label="Restore default RotorHazard Enter threshold">${icons.reset(13)}</button>`
              : ""
          }
        </div>`
        : `<div class="input-suffix ${isCustomThreshold ? "has-reset" : ""}">
          <input class="input mono" type="number" name="threshold" value="${enterVal}" min="-95" max="-20" step="1" title="Enter threshold (dBm)" />
          <span>dBm</span>
          ${
            isCustomThreshold
              ? `<button type="button" class="flasher-pass-toggle rule-inline-btn is-active" data-reset-threshold="${p.slotIndex}" title="Restore default enter threshold (${DEFAULT_ENTER_THRESHOLD_DBM} dBm)" aria-label="Restore default enter threshold (${DEFAULT_ENTER_THRESHOLD_DBM} dBm)">${icons.reset(13)}</button>`
              : ""
          }
        </div>`;

    const col5Html = isLapRF
      ? `<div class="input-suffix ${isCustomLapRFThr ? "has-reset" : ""}">
          <input class="input mono" type="number" name="laprfThreshold" value="${laprfThrVal}" min="300" max="3500" step="10" title="LapRF crossing threshold (300–3500, default 800)" />
          <span>RSSI</span>
          ${
            isCustomLapRFThr
              ? `<button type="button" class="flasher-pass-toggle rule-inline-btn is-active" data-reset-laprf-threshold="${p.slotIndex}" title="Restore default LapRF threshold (${DEFAULT_LAPRF_THRESHOLD})" aria-label="Restore default LapRF threshold">${icons.reset(13)}</button>`
              : ""
          }
        </div>`
      : isRH
        ? `<div class="input-suffix ${isCustomRhExit ? "has-reset" : ""}">
          <input class="input mono" type="number" name="rhExitThreshold" value="${rhExitVal}" min="6" max="246" step="1" title="RotorHazard node ExitAt threshold (must be at least 4 below Enter, default 70)" />
          <span>RSSI</span>
          ${
            isCustomRhExit
              ? `<button type="button" class="flasher-pass-toggle rule-inline-btn is-active" data-reset-rh-exit="${p.slotIndex}" title="Restore default RotorHazard Exit threshold (${DEFAULT_RH_EXIT_THRESHOLD})" aria-label="Restore default RotorHazard Exit threshold">${icons.reset(13)}</button>`
              : ""
          }
        </div>`
        : `<div class="input-suffix ${isCustomExit ? "has-reset" : ""}">
          <input class="input mono" type="number" name="exitThreshold" value="${exitVal}" min="-105" max="-22" step="1" title="Exit threshold (dBm, must be at least 2 dB below Enter)" />
          <span>dBm</span>
          ${
            isCustomExit
              ? `<button type="button" class="flasher-pass-toggle rule-inline-btn is-active" data-reset-exit-threshold="${p.slotIndex}" title="Restore default exit threshold (${DEFAULT_EXIT_THRESHOLD_DBM} dBm)" aria-label="Restore default exit threshold (${DEFAULT_EXIT_THRESHOLD_DBM} dBm)">${icons.reset(13)}</button>`
              : ""
          }
        </div>`;

    return `
      <form class="slot-row has-remove ${isExactMatch ? "is-exact-match" : ""}" data-pilot="${p.slotIndex}">
        <div class="input-with-dot ${p.mgpPilotId ? "has-mgp" : ""}">
          <span class="dot" style="--c:${p.color}"></span>
          <input class="input" name="callsign" value="${esc(p.callsign)}" maxlength="32" autocomplete="off" />
          ${p.mgpPilotId ? `<span class="badge pilot-mgp-badge mono" title="Linked MultiGP Pilot #${p.mgpPilotId}">MGP</span>` : ""}
        </div>
        <input class="input" name="phoneticName" value="${esc(p.phoneticName ?? "")}" maxlength="32" autocomplete="off" />
        <select class="input" name="channel" ${rfLocked ? "disabled" : ""}>${options}</select>
        ${col4Html}
        ${col5Html}
        <div class="pilot-row-remove-cell">
          <button type="button" class="gate-remove-btn" data-remove-pilot="${p.slotIndex}" ${canRemove && !rfLocked ? "" : "disabled"} title="${canRemove ? `Remove ${esc(p.callsign)}` : "At least 2 pilots are required"}" aria-label="Remove ${esc(p.callsign)}">${icons.trash(14)}</button>
        </div>
      </form>`;
  }

  private handleInput = (e: Event): void => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.hasAttribute("data-pilot-dir-search")) {
      this.searchQuery = target.value;
      if (this.searchQuery.trim()) {
        getSessionState(this.store).activePillId = null;
      }
      this.currentPage = 1;
      this.render();
      return;
    }
    if (target.name === "callsign") {
      const form = target.closest<HTMLFormElement>("form[data-pilot]");
      const slotIndex = Number(form?.dataset.pilot) || 0;
      const isDup = this.hasDuplicateCallsign(target.value, slotIndex);
      target.classList.toggle("is-invalid", isDup);
      target.title = isDup ? `Pilot callsign “${target.value.trim()}” already exists` : "";
    }
  };

  private handleClick = (e: Event): void => {
    const target = e.target as HTMLElement;
    const mobileSelectBtn = target.closest<HTMLButtonElement>("[data-mobile-pilot-select]");
    if (mobileSelectBtn) {
      const slot = Number(mobileSelectBtn.dataset.mobilePilotSelect);
      if (Number.isFinite(slot) && slot > 0) {
        this.mobileSelectedSlot = this.mobileSelectedSlot === slot ? null : slot;
        this.render();
      }
      return;
    }
    if (target.closest("[data-mobile-pilot-close]")) {
      this.mobileSelectedSlot = null;
      this.render();
      return;
    }
    const recentSelectBtn = target.closest<HTMLButtonElement>("[data-recent-select]");
    if (recentSelectBtn) {
      const pillId = recentSelectBtn.dataset.recentSelect ?? "";
      const st = getSessionState(this.store);
      this.searchQuery = "";
      if (st.activePillId === pillId) {
        st.activePillId = null;
      } else {
        st.activePillId = pillId;
      }
      this.currentPage = 1;
      this.render();
      return;
    }
    const recentRemoveBtn = target.closest<HTMLButtonElement>("[data-recent-remove]");
    if (recentRemoveBtn) {
      const pillId = recentRemoveBtn.dataset.recentRemove ?? "";
      const st = getSessionState(this.store);
      st.recentPills = st.recentPills.filter((p) => p.id !== pillId);
      if (st.activePillId === pillId) {
        st.activePillId = null;
      }
      this.currentPage = 1;
      this.render();
      return;
    }
    if (target.closest("[data-action=clear-recent-pilots]")) {
      const st = getSessionState(this.store);
      st.recentPills = [];
      st.activePillId = null;
      this.currentPage = 1;
      this.render();
      return;
    }
    const pageBtn = target.closest<HTMLButtonElement>("[data-pilot-page]");
    if (pageBtn && !pageBtn.disabled) {
      const dir = pageBtn.dataset.pilotPage;
      const shownCount = this.filterPilots(this.store.pilots).length;
      const totalPages = Math.max(1, Math.ceil(shownCount / PILOTS_PER_PAGE));
      if (dir === "prev" && this.currentPage > 1) {
        this.currentPage--;
        this.render();
      } else if (dir === "next" && this.currentPage < totalPages) {
        this.currentPage++;
        this.render();
      }
      return;
    }
    const resetThreshBtn = target.closest<HTMLButtonElement>("[data-reset-threshold]");
    if (resetThreshBtn) {
      const slotIndex = Number(resetThreshBtn.dataset.resetThreshold);
      const current = this.store.pilot(slotIndex);
      if (current) {
        this.commitActiveSearchOnRowEdit(slotIndex);
        const nextEnter = DEFAULT_ENTER_THRESHOLD_DBM;
        const nextExit = Math.min(nextEnter - 2, current.exitThreshold || DEFAULT_EXIT_THRESHOLD_DBM);
        void this.api
          .updatePilotSlot({
            ...current,
            enterThreshold: nextEnter,
            exitThreshold: nextExit,
          })
          .catch((err) => showToast(err instanceof Error ? err.message : String(err), "error"));
      }
      return;
    }
    const resetExitBtn = target.closest<HTMLButtonElement>("[data-reset-exit-threshold]");
    if (resetExitBtn) {
      const slotIndex = Number(resetExitBtn.dataset.resetExitThreshold);
      const current = this.store.pilot(slotIndex);
      if (current) {
        this.commitActiveSearchOnRowEdit(slotIndex);
        const curEnter = current.enterThreshold || DEFAULT_ENTER_THRESHOLD_DBM;
        void this.api
          .updatePilotSlot({
            ...current,
            enterThreshold: curEnter,
            exitThreshold: Math.min(curEnter - 2, DEFAULT_EXIT_THRESHOLD_DBM),
          })
          .catch((err) => showToast(err instanceof Error ? err.message : String(err), "error"));
      }
      return;
    }
    const resetGainBtn = target.closest<HTMLButtonElement>("[data-reset-laprf-gain]");
    if (resetGainBtn) {
      const slotIndex = Number(resetGainBtn.dataset.resetLaprfGain);
      const current = this.store.pilot(slotIndex);
      if (current) {
        this.commitActiveSearchOnRowEdit(slotIndex);
        void this.api
          .updatePilotSlot({ ...current, attenuationGain: DEFAULT_LAPRF_GAIN })
          .catch((err) => showToast(err instanceof Error ? err.message : String(err), "error"));
      }
      return;
    }
    const resetLaprfThrBtn = target.closest<HTMLButtonElement>("[data-reset-laprf-threshold]");
    if (resetLaprfThrBtn) {
      const slotIndex = Number(resetLaprfThrBtn.dataset.resetLaprfThreshold);
      const current = this.store.pilot(slotIndex);
      if (current) {
        this.commitActiveSearchOnRowEdit(slotIndex);
        void this.api
          .updatePilotSlot({ ...current, laprfThreshold: DEFAULT_LAPRF_THRESHOLD })
          .catch((err) => showToast(err instanceof Error ? err.message : String(err), "error"));
      }
      return;
    }
    const resetRhEnterBtn = target.closest<HTMLButtonElement>("[data-reset-rh-enter]");
    if (resetRhEnterBtn) {
      const slotIndex = Number(resetRhEnterBtn.dataset.resetRhEnter);
      const current = this.store.pilot(slotIndex);
      if (current) {
        this.commitActiveSearchOnRowEdit(slotIndex);
        const nextEnter = DEFAULT_RH_ENTER_THRESHOLD;
        const nextExit = Math.min(nextEnter - 4, current.rhExitThreshold || DEFAULT_RH_EXIT_THRESHOLD);
        void this.api
          .updatePilotSlot({
            ...current,
            rhEnterThreshold: nextEnter,
            rhExitThreshold: nextExit,
          })
          .catch((err) => showToast(err instanceof Error ? err.message : String(err), "error"));
      }
      return;
    }
    const resetRhExitBtn = target.closest<HTMLButtonElement>("[data-reset-rh-exit]");
    if (resetRhExitBtn) {
      const slotIndex = Number(resetRhExitBtn.dataset.resetRhExit);
      const current = this.store.pilot(slotIndex);
      if (current) {
        this.commitActiveSearchOnRowEdit(slotIndex);
        const curEnter = current.rhEnterThreshold || DEFAULT_RH_ENTER_THRESHOLD;
        void this.api
          .updatePilotSlot({
            ...current,
            rhEnterThreshold: curEnter,
            rhExitThreshold: Math.min(curEnter - 4, DEFAULT_RH_EXIT_THRESHOLD),
          })
          .catch((err) => showToast(err instanceof Error ? err.message : String(err), "error"));
      }
      return;
    }
    const removeBtn = target.closest<HTMLButtonElement>("[data-remove-pilot]");
    if (removeBtn && !removeBtn.disabled) {
      const slotIndex = Number(removeBtn.dataset.removePilot);
      if (slotIndex > 0) {
        void this.api
          .removePilot(slotIndex)
          .catch((err) => showToast(err instanceof Error ? err.message : String(err), "error"));
      }
      return;
    }
    const addBtn = target.closest<HTMLButtonElement>("[data-action=add-pilot]");
    if (addBtn && !addBtn.disabled) {
      this.submitSearchAddPilot(true);
      return;
    }
    if (target.closest("[data-action=import-mgp-pilots]")) {
      if (this.mgpImportInFlight) return;
      this.mgpImportInFlight = true;
      this.render();
      void sharedMultiGPService
        .importChapterPilots(this.store, this.api)
        .then((summary) => {
          showToast(
            `Imported MultiGP pilots from ${summary.chapterName} (${summary.added} added, ${summary.updated} linked) · ${summary.total} total in roster`,
            "info"
          );
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          openMultiGPErrorModal({
            title: "MultiGP Pilot Import Failed",
            raceName: sharedMultiGPService.getPrefs(this.store).chapterName || "MultiGP Chapter",
            errorMessage: msg,
          });
        })
        .finally(() => {
          this.mgpImportInFlight = false;
          this.render();
        });
      return;
    }
    if (target.closest("[data-action=download-pilots-csv]")) {
      void this.api
        .downloadPilotsRosterCsv()
        .then(() => showToast("Downloaded pilots roster CSV", "info"))
        .catch((err) => showToast(err instanceof Error ? err.message : String(err), "error"));
      return;
    }
    if (target.closest("[data-action=upload-pilots-csv]")) {
      const fileInput = this.el.querySelector<HTMLInputElement>("[data-pilot-csv-input]");
      if (fileInput) {
        fileInput.value = "";
        fileInput.click();
      }
      return;
    }
    if (target.closest("[data-action=restore-default-pilots]")) {
      const st = getSessionState(this.store);
      st.recentPills = [];
      st.activePillId = null;
      this.searchQuery = "";
      this.currentPage = 1;
      void this.api
        .resetPilotsToDefault()
        .catch((err) => showToast(err instanceof Error ? err.message : String(err), "error"));
    }
  };

  private submitSearchAddPilot(forceAdd = false): void {
    const trimmed = this.searchQuery.trim();
    if (!trimmed) return;
    const pilots = this.store.pilots;
    const matches = this.matchQuery(pilots, trimmed);
    const exact = pilots.find((p) => p.callsign.trim().toLowerCase() === trimmed.toLowerCase());

    // When pressing Enter (not clicking +Add explicitly) and the search matches existing pilot(s),
    // save that search into Recent pills and auto-select it instead of creating a duplicate/substring pilot.
    if (!forceAdd && matches.length > 0) {
      const singlePilot = exact ?? (matches.length === 1 ? matches[0] : undefined);
      if (singlePilot) {
        this.upsertRecentPill(
          {
            id: `pilot:${singlePilot.slotIndex}`,
            kind: "pilot",
            slotIndex: singlePilot.slotIndex,
            fallbackCallsign: singlePilot.callsign,
          },
          true
        );
      } else {
        this.upsertRecentPill(
          {
            id: `query:${trimmed.toLowerCase()}`,
            kind: "query",
            query: trimmed,
          },
          true
        );
      }
      this.searchQuery = "";
      const searchEl = this.el.querySelector<HTMLInputElement>("[data-pilot-dir-search]");
      if (searchEl) searchEl.value = "";
      this.render();
      return;
    }

    if (this.hasDuplicateCallsign(trimmed, 0)) return;
    this.searchQuery = "";
    const searchEl = this.el.querySelector<HTMLInputElement>("[data-pilot-dir-search]");
    if (searchEl) searchEl.value = "";
    getSessionState(this.store).activePillId = null;
    void this.api
      .addPilot(trimmed)
      .then(() => {
        const added = [...this.store.pilots]
          .reverse()
          .find((p) => p.callsign.trim().toLowerCase() === trimmed.toLowerCase());
        if (added) {
          this.upsertRecentPill(
            {
              id: `pilot:${added.slotIndex}`,
              kind: "pilot",
              slotIndex: added.slotIndex,
              fallbackCallsign: added.callsign,
            },
            true
          );
        } else {
          this.currentPage = 1;
        }
        this.render();
      })
      .catch((err) => showToast(err instanceof Error ? err.message : String(err), "error"));
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.hasAttribute("data-pilot-dir-search")) {
      if (e.key === "Enter") {
        e.preventDefault();
        this.submitSearchAddPilot();
      } else if (e.key === "Escape" && target.value) {
        e.preventDefault();
        target.value = "";
        this.searchQuery = "";
        this.currentPage = 1;
        this.render();
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      target.blur();
    } else if (e.key === "Escape") {
      target.value = target.defaultValue;
      target.blur();
    }
  };

  private handleChange = (e: Event): void => {
    const target = e.target as HTMLElement;
    if (target instanceof HTMLInputElement && target.hasAttribute("data-pilot-csv-input")) {
      const file = target.files?.[0];
      target.value = "";
      if (!file) return;
      void file
        .text()
        .then((csvText) => this.api.importPilotsRosterCsv(csvText))
        .then((summary) => {
          const parts: string[] = [];
          if (summary.added > 0) parts.push(`${summary.added} added`);
          if (summary.updated > 0) parts.push(`${summary.updated} updated`);
          const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
          showToast(
            `Imported pilots CSV${detail} · ${summary.total} total in roster`,
            "info"
          );
          this.render();
        })
        .catch((err) => showToast(err instanceof Error ? err.message : String(err), "error"));
      return;
    }
    if (target instanceof HTMLInputElement && target.hasAttribute("data-pilot-dir-search")) return;
    const form = target.closest("form");
    if (form) void this.save(form);
  };

  private handleSubmit = (e: Event): void => {
    e.preventDefault();
    void this.save(e.target as HTMLFormElement);
  };

  private async save(form: HTMLFormElement): Promise<void> {
    const slotIndex = Number(form.dataset.pilot);
    const current = this.store.pilot(slotIndex);
    if (!current) return;

    const data = new FormData(form);
    const rawCallsign = String(data.get("callsign") ?? "").trim();
    const nextCallsign = rawCallsign || current.callsign || `Pilot ${slotIndex}`;
    const callsignInput = form.querySelector<HTMLInputElement>('input[name="callsign"]');

    if (this.hasDuplicateCallsign(nextCallsign, slotIndex)) {
      showToast(`Pilot callsign “${nextCallsign}” already exists.`, "warn");
      if (callsignInput) {
        callsignInput.value = current.callsign;
        callsignInput.classList.remove("is-invalid");
        callsignInput.title = "";
      }
      return;
    }
    if (callsignInput) {
      callsignInput.classList.remove("is-invalid");
      callsignInput.title = "";
    }

    this.commitActiveSearchOnRowEdit(slotIndex);

    const isLapRF = this.store.timingHardwareMode === "laprf";
    const isRH = isRotorHazardMode(this.store.timingHardwareMode);
    let threshold = current.enterThreshold || DEFAULT_ENTER_THRESHOLD_DBM;
    let exitThreshold = current.exitThreshold || DEFAULT_EXIT_THRESHOLD_DBM;
    let attenuationGain = current.attenuationGain || DEFAULT_LAPRF_GAIN;
    let laprfThreshold = current.laprfThreshold || DEFAULT_LAPRF_THRESHOLD;
    let rhEnterThreshold = current.rhEnterThreshold || DEFAULT_RH_ENTER_THRESHOLD;
    let rhExitThreshold = current.rhExitThreshold || DEFAULT_RH_EXIT_THRESHOLD;

    if (isLapRF) {
      const rawGain = Number(data.get("attenuationGain"));
      if (Number.isFinite(rawGain)) {
        attenuationGain = Math.max(0, Math.min(63, Math.round(rawGain)));
      }
      const rawLaprfThr = Number(data.get("laprfThreshold"));
      if (Number.isFinite(rawLaprfThr)) {
        laprfThreshold = Math.max(300, Math.min(3500, Math.round(rawLaprfThr)));
      }
    } else if (isRH) {
      const rawEn = Number(data.get("rhEnterThreshold"));
      rhEnterThreshold = Number.isFinite(rawEn)
        ? Math.max(10, Math.min(250, Math.round(rawEn)))
        : DEFAULT_RH_ENTER_THRESHOLD;
      const rawEx = Number(data.get("rhExitThreshold"));
      rhExitThreshold = Number.isFinite(rawEx)
        ? Math.max(6, Math.min(rhEnterThreshold - 4, Math.round(rawEx)))
        : Math.max(6, rhEnterThreshold - 25);
    } else {
      const rawEnter = Number(data.get("threshold"));
      threshold = Number.isFinite(rawEnter)
        ? Math.max(-95, Math.min(-20, rawEnter))
        : DEFAULT_ENTER_THRESHOLD_DBM;
      const rawExit = Number(data.get("exitThreshold"));
      exitThreshold = Number.isFinite(rawExit)
        ? Math.max(-105, Math.min(threshold - 2, rawExit))
        : Math.max(-105, threshold - 10);
    }
    const rfLocked = this.isLiveHeatLockingChannels();
    const rawChannelCode = Number(data.get("channel"));
    const decoded = rfLocked ? null : decodeBandChannel(rawChannelCode);
    const band = rfLocked
      ? current.band || BAND_RACEBAND
      : decoded
        ? decoded.band
        : current.band || BAND_RACEBAND;
    const channel = rfLocked ? current.channel : decoded ? decoded.channel : 0;
    const frequencyMhz = rfLocked ? current.frequencyMhz : decoded ? decoded.frequencyMhz : 0;

    try {
      await this.api.updatePilotSlot({
        ...current,
        enabled: current.enabled,
        callsign: nextCallsign,
        phoneticName: String(data.get("phoneticName") ?? "").trim(),
        band,
        channel,
        frequencyMhz,
        enterThreshold: threshold,
        exitThreshold,
        attenuationGain,
        laprfThreshold,
        rhEnterThreshold,
        rhExitThreshold,
      });
    } catch (err) {
      if (callsignInput) {
        callsignInput.value = current.callsign;
      }
      showToast(err instanceof Error ? err.message : String(err), "error");
    }
  }
}
