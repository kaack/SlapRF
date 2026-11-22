import { Component } from "../core/component";
import { isCustomSelectOpenWithin, scanCustomSelects } from "../core/custom_select";
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
import { PilotSlot } from "../types/models";
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
  private lastOpenedDrawerSlot: number | null = null;
  private mobileDrawerClosing = false;
  private customSelectOpenOnPointerDown = false;
  private dirFabOpen = false;
  private drawerCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private drawerDragStartY: number | null = null;
  private lastRfLocked = false;
  private unfilteredMobileHeightPx = 0;
  private lastUnfilteredPilotCount = 0;

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
    window.addEventListener("pointerdown", this.handlePrePointerDown, true);
    const onDrawerAnimEnd = (e: AnimationEvent) => {
      if (e.animationName === "pilot-drawer-slide-up" && e.target instanceof HTMLElement) {
        e.target.classList.remove("is-entering");
      }
    };
    el.addEventListener("animationend", onDrawerAnimEnd);
    el.addEventListener("pointerdown", this.handleDrawerPointerDown);
    el.addEventListener("pointermove", this.handleDrawerPointerMove);
    el.addEventListener("pointerup", this.handleDrawerPointerUp);
    el.addEventListener("pointercancel", this.handleDrawerPointerUp);
    this.onDispose(() => {
      window.removeEventListener("pointerdown", this.handlePrePointerDown, true);
      el.removeEventListener("submit", this.handleSubmit);
      el.removeEventListener("change", this.handleChange);
      el.removeEventListener("input", this.handleInput);
      el.removeEventListener("keydown", this.handleKeyDown);
      el.removeEventListener("click", this.handleClick);
      el.removeEventListener("animationend", onDrawerAnimEnd);
      el.removeEventListener("pointerdown", this.handleDrawerPointerDown);
      el.removeEventListener("pointermove", this.handleDrawerPointerMove);
      el.removeEventListener("pointerup", this.handleDrawerPointerUp);
      el.removeEventListener("pointercancel", this.handleDrawerPointerUp);
      if (this.drawerCloseTimer !== null) {
        clearTimeout(this.drawerCloseTimer);
        this.drawerCloseTimer = null;
      }
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
      addBtn.disabled = false;
      addBtn.title = "Add a new pilot";
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
    const addDisabled = !!exactMatch;
    const addBtnTitle = exactMatch
      ? `Pilot “${exactMatch.callsign}” already exists`
      : trimmedSearch
        ? `Add pilot “${trimmedSearch}”`
        : "Add a new pilot";

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

    const innerHtml = `
          <div class="slot-row has-remove slot-head">
            <span>Pilot</span><span>Phonetic name</span><span>Default channel</span><span></span>
          </div>
          ${rowsHtml}`;

    const mobileHtml = this.renderMobilePills(
      shown,
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
    const mobileIoActionsHtml = `
      ${
        mgpAvailable
          ? `<button type="button" class="btn btn-sm pilot-dir-mgp-btn" data-action="import-mgp-pilots" ${this.mgpImportInFlight ? "disabled" : ""} title="Import pilots from MultiGP"><span>${this.mgpImportInFlight ? "Importing…" : "Import from MultiGP"}</span></button>`
          : ""
      }
      <button type="button" class="btn btn-sm pilot-dir-mgp-btn" data-action="upload-pilots-csv" title="Import from CSV"><span>Import from CSV</span></button>
      <button type="button" class="btn btn-sm pilot-dir-mgp-btn" data-action="download-pilots-csv" title="Export as CSV"><span>Export as CSV</span></button>`;
    const existingTable = this.el.querySelector<HTMLElement>(".slot-table");
    const existingMobileSlot = this.el.querySelector<HTMLElement>("[data-pilot-mobile-slot]");
    const existingMobileEditorSlot = this.el.querySelector<HTMLElement>("[data-pilot-mobile-editor-slot]");
    const existingPagerSlot = this.el.querySelector<HTMLElement>("[data-pilot-pagination-slot]");
    const existingRecentSlot = this.el.querySelector<HTMLElement>("[data-pilot-recent-slot]");
    const existingMobileIoSlot = this.el.querySelector<HTMLElement>("[data-pilot-mobile-io-slot]");
    if (
      existingTable &&
      existingMobileSlot &&
      existingMobileEditorSlot &&
      existingPagerSlot &&
      existingRecentSlot &&
      existingMobileIoSlot
    ) {
      existingTable.innerHTML = innerHtml;
      this.syncMobilePillsWithLockedHeight(existingMobileSlot, mobileHtml, pilots, isFiltered);
      if (!this.mobileDrawerClosing) {
        const existingOverlay = existingMobileEditorSlot.querySelector<HTMLElement>(
          ".pilot-dir-mobile-drawer-overlay"
        );
        if (
          this.mobileSelectedSlot !== null &&
          existingOverlay &&
          existingOverlay.dataset.drawerSlot === String(this.mobileSelectedSlot)
        ) {
          this.patchOpenMobilePilotDrawer(
            existingOverlay,
            existingMobileEditorSlot,
            pilots,
            canRemove,
            rfLocked
          );
        } else {
          existingMobileEditorSlot.innerHTML = mobileEditorHtml;
          scanCustomSelects(existingMobileEditorSlot);
        }
      }
      existingPagerSlot.innerHTML = paginationHtml;
      existingRecentSlot.innerHTML = recentBarHtml;
      existingMobileIoSlot.innerHTML = mobileIoActionsHtml;
      const searchEl = this.el.querySelector<HTMLInputElement>("[data-pilot-dir-search]");
      if (searchEl && searchEl.value !== this.searchQuery) {
        searchEl.value = this.searchQuery;
      }
      const addBtn = this.el.querySelector<HTMLButtonElement>("[data-action=add-pilot]");
      if (addBtn) {
        addBtn.disabled = addDisabled;
        addBtn.title = addBtnTitle;
      }
      return;
    }

    this.el.innerHTML = `
      <div class="pilot-dir-box-shell">
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
      </div>
      <div class="pilot-dir-mobile-footer" data-pilot-mobile-io-slot>${mobileIoActionsHtml}</div>
      <div class="pilot-dir-mobile-editor-wrap" data-pilot-mobile-editor-slot>${mobileEditorHtml}</div>
      <input type="file" accept=".csv,text/csv" data-pilot-csv-input hidden />`;

    const freshMobileSlot = this.el.querySelector<HTMLElement>("[data-pilot-mobile-slot]");
    if (freshMobileSlot) {
      this.syncMobilePillsWithLockedHeight(freshMobileSlot, mobileHtml, pilots, isFiltered);
    }
  }

  private syncMobilePillsWithLockedHeight(
    mobileSlot: HTMLElement,
    mobileHtml: string,
    allPilots: PilotSlot[],
    isFiltered: boolean
  ): void {
    if (typeof window === "undefined" || window.innerWidth > 768) {
      mobileSlot.style.minHeight = "";
      mobileSlot.innerHTML = mobileHtml;
      return;
    }
    if (!isFiltered || this.unfilteredMobileHeightPx <= 0) {
      mobileSlot.style.minHeight = "";
      mobileSlot.innerHTML = isFiltered ? this.renderMobilePills(allPilots, "", undefined) : mobileHtml;
      const measured = Math.round(mobileSlot.getBoundingClientRect().height);
      if (measured > 0) {
        this.unfilteredMobileHeightPx = measured;
        this.lastUnfilteredPilotCount = allPilots.length;
      }
      if (isFiltered) {
        mobileSlot.innerHTML = mobileHtml;
      }
    } else {
      mobileSlot.innerHTML = mobileHtml;
    }

    if (isFiltered && this.unfilteredMobileHeightPx > 0) {
      mobileSlot.style.minHeight = `${this.unfilteredMobileHeightPx}px`;
    } else {
      mobileSlot.style.minHeight = "";
    }
  }

  private renderDirectoryFab(mgpAvailable: boolean): string {
    const rows: Array<{ labelHtml: string; btnHtml: string }> = [
      {
        labelHtml: `<button type="button" class="rc-fab-label is-action" data-action="fab-add-pilot">Add Pilot</button>`,
        btnHtml: `<button type="button" class="rc-fab-btn" data-action="fab-add-pilot" title="Add Pilot" aria-label="Add Pilot">${icons.plus(16)}</button>`,
      },
      ...(mgpAvailable
        ? [
            {
              labelHtml: `<button type="button" class="rc-fab-label is-action" data-action="import-mgp-pilots" ${this.mgpImportInFlight ? "disabled" : ""}>${this.mgpImportInFlight ? "Syncing…" : "Sync from MultiGP"}</button>`,
              btnHtml: `<button type="button" class="rc-fab-btn" data-action="import-mgp-pilots" ${this.mgpImportInFlight ? "disabled" : ""} title="Sync from MultiGP" aria-label="Sync from MultiGP">${icons.download(16)}</button>`,
            },
          ]
        : []),
      {
        labelHtml: `<button type="button" class="rc-fab-label is-action" data-action="download-pilots-csv">Download CSV</button>`,
        btnHtml: `<button type="button" class="rc-fab-btn" data-action="download-pilots-csv" title="Download CSV" aria-label="Download CSV">${icons.download(16)}</button>`,
      },
      {
        labelHtml: `<button type="button" class="rc-fab-label is-action" data-action="upload-pilots-csv">Upload CSV</button>`,
        btnHtml: `<button type="button" class="rc-fab-btn" data-action="upload-pilots-csv" title="Upload CSV" aria-label="Upload CSV">${icons.upload(16)}</button>`,
      },
    ];
    const total = rows.length;
    const itemsHtml = rows
      .map(
        (r, idx) => `
          <div class="rc-fab-row" style="--from-dial:${total - 1 - idx};--from-top:${idx}">
            ${r.labelHtml}
            ${r.btnHtml}
          </div>`
      )
      .join("");

    return `
      <div class="rc-fab-menu dir-fab-menu ${this.dirFabOpen ? "is-open" : ""}">
        <div class="rc-fab-drawer" aria-hidden="${this.dirFabOpen ? "false" : "true"}" ${this.dirFabOpen ? "" : "inert"}>
          <div class="rc-fab-items">${itemsHtml}</div>
        </div>
        <button
          type="button"
          class="rc-fab-main"
          data-action="toggle-dir-fab"
          aria-expanded="${this.dirFabOpen ? "true" : "false"}"
          title="${this.dirFabOpen ? "Close actions menu" : "Pilot actions"}"
          aria-label="Pilot actions"
        >
          <span class="rc-fab-icon rc-fab-icon-plus">${icons.plus(20)}</span>
          <span class="rc-fab-icon rc-fab-icon-back">${icons.menuBack(19)}</span>
        </button>
      </div>`;
  }

  private syncDirFabDom(): void {
    const fabEl = this.el.querySelector<HTMLElement>(".dir-fab-menu");
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
  }

  private renderMobilePills(
    shown: PilotSlot[],
    emptyFilterLabel: string,
    exactMatch: PilotSlot | undefined
  ): string {
    if (shown.length === 0) {
      return `<div class="pilot-dir-empty note">No pilots match “${esc(emptyFilterLabel)}”.</div>`;
    }
    return `
      <div class="pilot-dir-mobile-pills" role="listbox" aria-label="Pilots">
        ${shown
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
    if (this.mobileSelectedSlot === null) {
      this.lastOpenedDrawerSlot = null;
      return "";
    }
    const p = pilots.find((x) => x.slotIndex === this.mobileSelectedSlot);
    if (!p) {
      this.lastOpenedDrawerSlot = null;
      return "";
    }
    const shouldAnimateEntry = this.lastOpenedDrawerSlot !== p.slotIndex;
    this.lastOpenedDrawerSlot = p.slotIndex;

    const options = renderMultiBandSelectOptionsHtml({
      selectedBand: p.band,
      selectedChannel: p.channel,
      includeUnassigned: true,
      unassignedLabel: "No default",
    });

    return `
      <div class="pilot-dir-mobile-drawer-overlay" data-drawer-slot="${p.slotIndex}" role="dialog" aria-modal="true" aria-label="Edit ${esc(p.callsign)}">
        <div class="pilot-dir-mobile-drawer-backdrop" data-mobile-pilot-close></div>
        <div class="pilot-dir-mobile-editor ${shouldAnimateEntry ? "is-entering" : ""}" data-mobile-pilot-drawer>
          <div class="dir-mobile-drawer-top-bar" data-mobile-pilot-handle>
            <button
              type="button"
              class="pilot-dir-mobile-drawer-handle"
              data-mobile-pilot-handle
              data-mobile-pilot-close
              aria-label="Dismiss pilot editor"
              title="Pull down or tap to dismiss"
            >
              <span class="pilot-dir-mobile-drawer-grip" aria-hidden="true"></span>
            </button>
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
              <div class="field">
                <span>Default channel</span>
                <select class="input" name="channel" ${rfLocked ? "disabled" : ""}>${options}</select>
              </div>
            </div>
          </form>
          <div class="dir-mobile-drawer-actions is-single-action">
            <button
              type="button"
              class="btn btn-ghost dir-mobile-drawer-btn"
              data-remove-pilot="${p.slotIndex}"
              ${canRemove && !rfLocked ? "" : "disabled"}
              title="${canRemove ? `Delete ${esc(p.callsign)}` : "At least 2 pilots are required"}"
              aria-label="Delete ${esc(p.callsign)}"
            >${icons.trash(15)}<span>Delete</span></button>
          </div>
        </div>
      </div>`;
  }

  private patchOpenMobilePilotDrawer(
    overlay: HTMLElement,
    slotHost: HTMLElement,
    pilots: PilotSlot[],
    canRemove: boolean,
    rfLocked: boolean
  ): void {
    const p =
      this.mobileSelectedSlot !== null
        ? pilots.find((x) => x.slotIndex === this.mobileSelectedSlot)
        : undefined;
    if (!p) {
      slotHost.innerHTML = "";
      return;
    }

    overlay.setAttribute("aria-label", `Edit ${p.callsign}`);
    const form = overlay.querySelector<HTMLFormElement>("form.pilot-dir-mobile-form");
    if (form) {
      const dot = form.querySelector<HTMLElement>(".input-with-dot > .dot");
      if (dot) dot.style.setProperty("--c", p.color);
      const callsignInp = form.querySelector<HTMLInputElement>('input[name="callsign"]');
      if (callsignInp && document.activeElement !== callsignInp && callsignInp.value !== p.callsign) {
        callsignInp.value = p.callsign;
        callsignInp.defaultValue = p.callsign;
      }
      const phoneticInp = form.querySelector<HTMLInputElement>('input[name="phoneticName"]');
      const nextPhonetic = p.phoneticName ?? "";
      if (phoneticInp && document.activeElement !== phoneticInp && phoneticInp.value !== nextPhonetic) {
        phoneticInp.value = nextPhonetic;
        phoneticInp.defaultValue = nextPhonetic;
      }
      const chSelect = form.querySelector<HTMLSelectElement>('select[name="channel"]');
      if (chSelect && !isCustomSelectOpenWithin(overlay)) {
        const nextOpts = renderMultiBandSelectOptionsHtml({
          selectedBand: p.band,
          selectedChannel: p.channel,
          includeUnassigned: true,
          unassignedLabel: "No default",
        });
        chSelect.disabled = rfLocked;
        chSelect.innerHTML = nextOpts;
        scanCustomSelects(overlay);
      }
    }

    const delBtn = overlay.querySelector<HTMLButtonElement>("[data-remove-pilot]");
    if (delBtn) {
      delBtn.disabled = !(canRemove && !rfLocked);
      delBtn.title = canRemove ? `Delete ${p.callsign}` : "At least 2 pilots are required";
      delBtn.setAttribute("aria-label", `Delete ${p.callsign}`);
    }
  }

  private renderPilotRow(
    p: PilotSlot,
    canRemove: boolean,
    rfLocked: boolean,
    isExactMatch = false
  ): string {
    const options = renderMultiBandSelectOptionsHtml({
      selectedBand: p.band,
      selectedChannel: p.channel,
      includeUnassigned: true,
      unassignedLabel: "No default",
    });

    return `
      <form class="slot-row has-remove ${isExactMatch ? "is-exact-match" : ""}" data-pilot="${p.slotIndex}">
        <div class="input-with-dot ${p.mgpPilotId ? "has-mgp" : ""}">
          <span class="dot" style="--c:${p.color}"></span>
          <input class="input" name="callsign" value="${esc(p.callsign)}" maxlength="32" autocomplete="off" />
          ${p.mgpPilotId ? `<span class="badge pilot-mgp-badge mono" title="Linked MultiGP Pilot #${p.mgpPilotId}">MGP</span>` : ""}
        </div>
        <input class="input" name="phoneticName" value="${esc(p.phoneticName ?? "")}" maxlength="32" autocomplete="off" />
        <select class="input" name="channel" ${rfLocked ? "disabled" : ""}>${options}</select>
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

  private dismissMobileDrawer(): void {
    if (this.mobileSelectedSlot === null || this.mobileDrawerClosing) return;
    const overlay = this.el.querySelector<HTMLElement>(".pilot-dir-mobile-drawer-overlay");
    if (!overlay) {
      this.mobileSelectedSlot = null;
      this.lastOpenedDrawerSlot = null;
      this.render();
      return;
    }
    this.mobileDrawerClosing = true;
    overlay.classList.add("is-closing");
    this.el.querySelectorAll<HTMLElement>(".pilot-dir-mobile-pill.is-selected").forEach((pill) => {
      pill.classList.remove("is-selected");
      pill.setAttribute("aria-selected", "false");
    });
    if (this.drawerCloseTimer !== null) {
      clearTimeout(this.drawerCloseTimer);
    }
    this.drawerCloseTimer = setTimeout(() => {
      this.drawerCloseTimer = null;
      if (!this.mobileDrawerClosing) return;
      this.mobileDrawerClosing = false;
      this.mobileSelectedSlot = null;
      this.lastOpenedDrawerSlot = null;
      this.render();
    }, 305);
  }

  private handlePrePointerDown = (e: PointerEvent): void => {
    this.customSelectOpenOnPointerDown = isCustomSelectOpenWithin(this.el);
    if (this.dirFabOpen) {
      const t = e.target as HTMLElement | null;
      if (!t || !t.closest(".dir-fab-menu")) {
        this.dirFabOpen = false;
        this.syncDirFabDom();
      }
    }
  };

  private handleDrawerPointerDown = (e: PointerEvent): void => {
    const t = e.target as HTMLElement | null;
    if (!t || !t.closest("[data-mobile-pilot-handle]") || t.closest("[data-remove-pilot]")) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    this.drawerDragStartY = e.clientY;
  };

  private handleDrawerPointerMove = (e: PointerEvent): void => {
    if (this.drawerDragStartY === null) return;
    const dy = e.clientY - this.drawerDragStartY;
    if (dy >= 22) {
      this.drawerDragStartY = null;
      this.dismissMobileDrawer();
    }
  };

  private handleDrawerPointerUp = (): void => {
    this.drawerDragStartY = null;
  };

  private handleClick = (e: Event): void => {
    const target = e.target as HTMLElement;
    const mobileSelectBtn = target.closest<HTMLButtonElement>("[data-mobile-pilot-select]");
    if (mobileSelectBtn) {
      const slot = Number(mobileSelectBtn.dataset.mobilePilotSelect);
      if (Number.isFinite(slot) && slot > 0) {
        if (this.drawerCloseTimer !== null) {
          clearTimeout(this.drawerCloseTimer);
          this.drawerCloseTimer = null;
        }
        if (this.mobileSelectedSlot === slot && !this.mobileDrawerClosing) {
          this.dismissMobileDrawer();
        } else {
          this.mobileDrawerClosing = false;
          this.mobileSelectedSlot = slot;
          this.render();
        }
      }
      return;
    }
    if (target.closest("[data-mobile-pilot-close]")) {
      if (this.customSelectOpenOnPointerDown) {
        this.customSelectOpenOnPointerDown = false;
        return;
      }
      this.dismissMobileDrawer();
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
    if (target.closest("[data-action=toggle-dir-fab]")) {
      this.dirFabOpen = !this.dirFabOpen;
      this.syncDirFabDom();
      return;
    }
    const addBtn = target.closest<HTMLButtonElement>("[data-action=add-pilot], [data-action=fab-add-pilot]");
    if (addBtn && !addBtn.disabled) {
      this.dirFabOpen = false;
      this.syncDirFabDom();
      const trimmed = this.searchQuery.trim();
      if (trimmed && !this.hasDuplicateCallsign(trimmed, -1)) {
        this.submitSearchAddPilot(true);
        return;
      }
      let idx = this.store.pilots.length + 1;
      let nextName = `Pilot ${idx}`;
      while (this.hasDuplicateCallsign(nextName, -1)) {
        idx++;
        nextName = `Pilot ${idx}`;
      }
      void this.api
        .addPilot(nextName)
        .then(() => {
          const added = [...this.store.pilots]
            .reverse()
            .find((p) => p.callsign.trim().toLowerCase() === nextName.toLowerCase());
          if (added) {
            if (window.innerWidth <= 768) {
              this.mobileSelectedSlot = added.slotIndex;
            }
            this.upsertRecentPill(
              {
                id: `pilot:${added.slotIndex}`,
                kind: "pilot",
                slotIndex: added.slotIndex,
                fallbackCallsign: added.callsign,
              },
              true
            );
          }
          this.render();
        })
        .catch((err) => showToast(err instanceof Error ? err.message : String(err), "error"));
      return;
    }
    if (target.closest("[data-action=import-mgp-pilots]")) {
      this.dirFabOpen = false;
      this.syncDirFabDom();
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
      this.dirFabOpen = false;
      this.syncDirFabDom();
      void this.api
        .downloadPilotsRosterCsv()
        .then(() => showToast("Downloaded pilots roster CSV", "info"))
        .catch((err) => showToast(err instanceof Error ? err.message : String(err), "error"));
      return;
    }
    if (target.closest("[data-action=upload-pilots-csv]")) {
      this.dirFabOpen = false;
      this.syncDirFabDom();
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
          if (window.innerWidth <= 768) {
            this.mobileSelectedSlot = added.slotIndex;
          }
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

    const threshold = current.enterThreshold || DEFAULT_ENTER_THRESHOLD_DBM;
    const exitThreshold = current.exitThreshold || DEFAULT_EXIT_THRESHOLD_DBM;
    const attenuationGain = current.attenuationGain || DEFAULT_LAPRF_GAIN;
    const laprfThreshold = current.laprfThreshold || DEFAULT_LAPRF_THRESHOLD;
    const rhEnterThreshold = current.rhEnterThreshold || DEFAULT_RH_ENTER_THRESHOLD;
    const rhExitThreshold = current.rhExitThreshold || DEFAULT_RH_EXIT_THRESHOLD;
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
