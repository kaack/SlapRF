import { Component } from "../core/component";
import { esc, fmtDelta, fmtTime } from "../core/format";
import { icons } from "../core/icons";
import {
  formatBandChannelShort,
  pilotChannelSearchTokens,
} from "../core/vtx_channels";
import {
  AnalyticsScope,
  AnalyticsScopeKind,
  buildAnalyticsHash,
  getAnalyticsScope,
  getCurrentParsedHash,
  onAnalyticsScopeChange,
  pushAppHash,
  replaceAppHash,
  setAnalyticsScope,
  setAnalyticsTopBarContext,
} from "../core/router";
import { bestPossibleLap, practiceStats } from "../state/analysis";
import { lapsFor } from "../state/selectors";
import { AppStore, ResolvedAnalyticsScope } from "../state/store";
import { PilotSlot } from "../types/models";
import { LapComparison } from "../widgets/LapComparison";
import { LapPicker } from "../widgets/LapPicker";
import { renderEmpty, renderStatTiles } from "../widgets/markup";
import { PilotPicker } from "../widgets/PilotPicker";
import { PracticeRecommendation, SectionStats } from "../widgets/SectionConsistency";

const ANALYTICS_PILLS_STORAGE_KEY = "slaprf.ui.analyticsPills.v1";
const ANALYTICS_SELECTED_PILOT_KEY = "slaprf.ui.analyticsSelectedPilot.v1";
const ANALYTICS_LAST_BY_KIND_KEY = "slaprf.ui.analyticsLastByKind.v1";

function loadLastByKind(): Partial<Record<AnalyticsScopeKind, string>> {
  try {
    const raw = window.localStorage.getItem(ANALYTICS_LAST_BY_KIND_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Partial<Record<AnalyticsScopeKind, string>> = {};
    if (typeof parsed.race === "string" && parsed.race.trim()) out.race = parsed.race.trim();
    if (typeof parsed.practice === "string" && parsed.practice.trim()) out.practice = parsed.practice.trim();
    return out;
  } catch {
    return {};
  }
}

function saveLastByKind(map: Partial<Record<AnalyticsScopeKind, string>>): void {
  try {
    window.localStorage.setItem(ANALYTICS_LAST_BY_KIND_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage errors
  }
}

function scopeStorageKey(scope: ResolvedAnalyticsScope): string {
  return `${scope.kind}:${scope.id || "default"}`;
}

function loadPillsMap(): Record<string, number[]> {
  try {
    const raw = window.localStorage.getItem(ANALYTICS_PILLS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number[]> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v)) {
        out[k] = v.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function savePillsMap(map: Record<string, number[]>): void {
  try {
    window.localStorage.setItem(ANALYTICS_PILLS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage errors
  }
}

function loadSelectedPilotMap(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(ANALYTICS_SELECTED_PILOT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isInteger(v) && v >= 1) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveSelectedPilotMap(map: Record<string, number>): void {
  try {
    window.localStorage.setItem(ANALYTICS_SELECTED_PILOT_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage errors
  }
}

type AnalyticsPilotFocusListener = () => void;
const analyticsPilotFocusListeners = new Set<AnalyticsPilotFocusListener>();

/**
 * Pre-selects a specific pilot slot in Scoped Analytics for a given scope (`practice` or `race`)
 * before navigating to `#/pilot/...`, ensuring the pill is present and active.
 */
export function focusAnalyticsPilotForScope(
  kind: "practice" | "race",
  resolvedScopeId: string,
  slotIndex: number | null
): void {
  if (!slotIndex || slotIndex < 1 || !resolvedScopeId) return;
  const key = `${kind}:${resolvedScopeId}`;
  const pillsMap = loadPillsMap();
  if (Array.isArray(pillsMap[key]) && !pillsMap[key].includes(slotIndex)) {
    pillsMap[key] = [...pillsMap[key], slotIndex];
    savePillsMap(pillsMap);
  }
  const selectedMap = loadSelectedPilotMap();
  selectedMap[key] = slotIndex;
  saveSelectedPilotMap(selectedMap);
  for (const fn of analyticsPilotFocusListeners) {
    fn();
  }
}

/**
 * Standalone Scoped Analytics (`#/pilot`), supporting both Practice Sessions (`Practices › <Session>`)
 * and Races (`Races › <Race>`), historical Track Snapshots, and user-curated per-scope pilot pills
 * with `×` removal and a circular `+` button to add any pilot (including `0 laps` pilots).
 */
export class PilotView extends Component {
  private readonly rootStore: AppStore;
  private readonly scopedStore: AppStore;
  private readonly lapPicker: LapPicker;
  private readonly fixedScopeGetter?: () => AnalyticsScope;

  private pillsByScope: Record<string, number[]> = loadPillsMap();
  private selectedByScope: Record<string, number> = loadSelectedPilotMap();
  private lastByKind: Partial<Record<AnalyticsScopeKind, string>> = loadLastByKind();
  private addMenuOpen = false;
  private pilotSearchQuery = "";
  private lastScopeKey = "";
  private lastActivePilotSlot = 0;
  private lastHeaderSig = "";
  private lastChooserSig = "";
  private isViewActive = true;

  public override onDeactivate(): void {
    this.isViewActive = false;
    this.addMenuOpen = false;
  }

  public override onActivate(): void {
    this.isViewActive = true;
    this.pillsByScope = loadPillsMap();
    this.selectedByScope = loadSelectedPilotMap();
    this.lastByKind = loadLastByKind();
    this.lastHeaderSig = "";
    this.lastChooserSig = "";
    this.syncAll();
    this.rootStore.notifySelectionChanged();
  }

  constructor(el: HTMLElement, store: AppStore, fixedScopeGetter?: () => AnalyticsScope) {
    super(el);
    this.rootStore = store;
    this.fixedScopeGetter = fixedScopeGetter;

    this.scopedStore = store.createScopedView({
      nodes: () => {
        const resolved = this.currentScope();
        return resolved.kind === "race"
          ? store.raceNodes(resolved.race)
          : store.practiceSessionNodes(resolved.session);
      },
      isScopeLive: () => this.currentScope().live,
      laps: () => store.analyticsLapsForScope(this.currentScope()),
      crossings: () => {
        const resolved = this.currentScope();
        return resolved.kind === "practice" && resolved.session ? resolved.session.crossings : [];
      },
      enabledPilots: () => (this.currentScope().id ? this.curatedPilotObjects() : []),
      pilot: (slotIndex: number) =>
        this.currentScope().id ? store.analyticsPilotPool(this.currentScope()).bySlot.get(slotIndex) : undefined,
      selectedPilot: () => (this.currentScope().id ? this.activeSlotForCurrentScope() : 0),
      selectPilot: (slotIndex: number) => this.selectScopePilot(slotIndex),
      lastCrossingFor: (slotIndex: number) => {
        const resolved = this.currentScope();
        return resolved.kind === "practice" && resolved.live
          ? store.lastCrossingFor(slotIndex)
          : undefined;
      },
    });

    el.innerHTML = `
      <div data-slot="analytics-chooser" style="display:none"></div>
      <div data-slot="analytics-empty-scope" style="display:none"></div>
      <div class="picker-row analytics-picker-row" data-slot="picker-row">
        <div class="analytics-pills-left" data-slot="pills-bar"></div>
        <div class="analytics-pills-right" data-slot="scope-meta"></div>
      </div>
      <div data-slot="empty-pills" style="display:none"></div>
      <div class="view-stack" data-slot="analytics-body">
        <div class="stat-row" data-slot="stats" data-section-anchor="overview"></div>
        <section class="card card-flush lap-metrics" data-section-anchor="lap-comparison">
          <div class="lap-metrics-picker" data-slot="laps"></div>
          <div class="lap-metrics-compare" data-slot="compare"></div>
        </section>
        <section class="card card-flush" data-slot="section-stats" data-section-anchor="section-splits"></section>
        <section class="card rec-card" data-slot="recommendation" data-section-anchor="recommendations"></section>
      </div>`;

    this.lapPicker = this.adopt(new LapPicker(this.slot("laps"), this.scopedStore));
    this.adopt(new LapComparison(this.slot("compare"), this.scopedStore));
    this.adopt(new SectionStats(this.slot("section-stats"), this.scopedStore));
    this.adopt(new PracticeRecommendation(this.slot("recommendation"), this.scopedStore));
    if (this.fixedScopeGetter) {
      this.adopt(
        new PilotPicker(this.slot("pills-bar"), this.scopedStore, {
          includeAll: false,
          value: () => this.activeSlotForCurrentScope(),
          onSelect: (slot) => {
            if (slot !== null) {
              this.selectScopePilot(slot);
            }
          },
        })
      );
    }

    this.listen(el, "click", this.handleClick);
    this.listen(el, "input", this.handleInput);
    this.listen(el, "keydown", this.handleKeyDown);
    document.addEventListener("pointerdown", this.handleOutsidePointer, true);
    document.addEventListener("keydown", this.handleGlobalEscape);
    this.onDispose(() => {
      document.removeEventListener("pointerdown", this.handleOutsidePointer, true);
      document.removeEventListener("keydown", this.handleGlobalEscape);
    });

    const onExternalPilotFocus = (): void => {
      this.pillsByScope = loadPillsMap();
      this.selectedByScope = loadSelectedPilotMap();
      this.scopedStore.setComparison({ lapId: null, reference: "best" });
      this.lapPicker.restoreDefaults();
      this.lastHeaderSig = "";
      if (this.isViewActive) {
        this.syncAll();
        this.rootStore.notifySelectionChanged();
      }
    };
    analyticsPilotFocusListeners.add(onExternalPilotFocus);
    this.onDispose(() => {
      analyticsPilotFocusListeners.delete(onExternalPilotFocus);
    });

    this.onDispose(
      onAnalyticsScopeChange(() => {
        this.pillsByScope = loadPillsMap();
        this.selectedByScope = loadSelectedPilotMap();
        this.lastByKind = loadLastByKind();
        this.addMenuOpen = false;
        this.pilotSearchQuery = "";
        this.lastHeaderSig = "";
        this.lastChooserSig = "";
        this.lapPicker.restoreDefaults();
        if (this.isViewActive) {
          this.syncAll();
          this.rootStore.notifySelectionChanged();
        }
      })
    );

    this.onDispose(
      store.subscribe(["config", "selection", "laps", "crossings", "practice", "race", "status"], () => {
        if (!this.isViewActive) return;
        this.syncAll();
      })
    );

    this.syncAll();
  }

  private currentScope(): ResolvedAnalyticsScope {
    const raw = this.fixedScopeGetter ? this.fixedScopeGetter() : getAnalyticsScope();
    return this.rootStore.resolveAnalyticsScope(raw);
  }

  private curatedSlotsForScope(resolved: ResolvedAnalyticsScope): number[] {
    const key = scopeStorageKey(resolved);
    const pool = this.rootStore.analyticsPilotPool(resolved);
    if (this.fixedScopeGetter) {
      const combined: number[] = [];
      const seen = new Set<number>();
      for (const p of pool.inScope) {
        if (!seen.has(p.slotIndex) && pool.bySlot.has(p.slotIndex)) {
          seen.add(p.slotIndex);
          combined.push(p.slotIndex);
        }
      }
      const laps = this.rootStore.analyticsLapsForScope(resolved);
      for (const l of laps) {
        if (!seen.has(l.slotIndex) && pool.bySlot.has(l.slotIndex)) {
          seen.add(l.slotIndex);
          combined.push(l.slotIndex);
        }
      }
      if (combined.length > 0) return combined;
      const firstGlobal = pool.globalOther[0];
      return firstGlobal ? [firstGlobal.slotIndex] : [];
    }
    const saved = this.pillsByScope[key];
    if (saved !== undefined) {
      const seen = new Set<number>();
      const valid: number[] = [];
      for (const slot of saved) {
        if (!seen.has(slot) && pool.bySlot.has(slot)) {
          seen.add(slot);
          valid.push(slot);
        }
      }
      return valid;
    }

    const laps = this.rootStore.analyticsLapsForScope(resolved);
    const withLaps: number[] = [];
    const seenLaps = new Set<number>();
    for (const l of laps) {
      if (!seenLaps.has(l.slotIndex) && pool.bySlot.has(l.slotIndex)) {
        seenLaps.add(l.slotIndex);
        withLaps.push(l.slotIndex);
      }
    }

    if (resolved.kind === "practice") {
      const combined: number[] = [...withLaps];
      for (const p of pool.inScope) {
        if (!combined.includes(p.slotIndex)) combined.push(p.slotIndex);
      }
      if (combined.length > 0) return combined.slice(0, 8);
    } else {
      if (withLaps.length > 0) return withLaps.slice(0, 6);
      const rosterSlots = pool.inScope.map((p) => p.slotIndex);
      if (rosterSlots.length > 0) return rosterSlots.slice(0, 4);
    }

    const firstGlobal = pool.globalOther[0];
    return firstGlobal ? [firstGlobal.slotIndex] : [];
  }

  private curatedPilotObjects(): PilotSlot[] {
    const resolved = this.currentScope();
    const pool = this.rootStore.analyticsPilotPool(resolved);
    return this.curatedSlotsForScope(resolved)
      .map((slot) => pool.bySlot.get(slot))
      .filter((p): p is PilotSlot => Boolean(p));
  }

  private activeSlotForCurrentScope(): number {
    const resolved = this.currentScope();
    const key = scopeStorageKey(resolved);
    const slots = this.curatedSlotsForScope(resolved);
    if (slots.length === 0) return 0;
    if (this.fixedScopeGetter && resolved.kind === "practice") {
      const liveFocus = this.rootStore.liveFocus;
      if (liveFocus !== null && slots.includes(liveFocus)) {
        if (this.selectedByScope[key] !== liveFocus) {
          this.selectedByScope[key] = liveFocus;
          saveSelectedPilotMap(this.selectedByScope);
        }
        return liveFocus;
      }
    }
    const saved = this.selectedByScope[key];
    if (saved && slots.includes(saved)) return saved;
    return slots[0];
  }

  private selectScopePilot(slotIndex: number): void {
    const resolved = this.currentScope();
    const key = scopeStorageKey(resolved);
    const slots = this.curatedSlotsForScope(resolved);
    if (!slots.includes(slotIndex)) return;
    const isPracticeEmbedded = Boolean(this.fixedScopeGetter && resolved.kind === "practice");
    if (
      this.selectedByScope[key] === slotIndex &&
      (!isPracticeEmbedded || this.rootStore.liveFocus === slotIndex)
    ) {
      return;
    }
    this.selectedByScope[key] = slotIndex;
    saveSelectedPilotMap(this.selectedByScope);
    if (isPracticeEmbedded && this.rootStore.liveFocus !== slotIndex) {
      this.rootStore.setLiveFocus(slotIndex);
    }
    this.scopedStore.setComparison({ lapId: null, reference: "best" });
    this.lastHeaderSig = "";
    this.syncAll();
    this.rootStore.notifySelectionChanged();
  }

  private addPilotPill(slotIndex: number): void {
    const resolved = this.currentScope();
    const key = scopeStorageKey(resolved);
    const current = [...this.curatedSlotsForScope(resolved)];
    if (!current.includes(slotIndex)) {
      current.push(slotIndex);
    }
    this.pillsByScope[key] = current;
    savePillsMap(this.pillsByScope);
    this.selectedByScope[key] = slotIndex;
    saveSelectedPilotMap(this.selectedByScope);
    this.addMenuOpen = false;
    this.pilotSearchQuery = "";
    this.scopedStore.setComparison({ lapId: null, reference: "best" });
    this.lastHeaderSig = "";
    this.syncAll();
    this.rootStore.notifySelectionChanged();
  }

  private removePilotPill(slotIndex: number): void {
    const resolved = this.currentScope();
    const key = scopeStorageKey(resolved);
    const prev = this.curatedSlotsForScope(resolved);
    const idx = prev.indexOf(slotIndex);
    if (idx < 0) return;
    const next = prev.filter((s) => s !== slotIndex);
    this.pillsByScope[key] = next;
    savePillsMap(this.pillsByScope);

    if (this.selectedByScope[key] === slotIndex || !next.includes(this.selectedByScope[key])) {
      if (next.length > 0) {
        const nextSlot = next[Math.min(idx, next.length - 1)];
        this.selectedByScope[key] = nextSlot;
      } else {
        delete this.selectedByScope[key];
      }
      saveSelectedPilotMap(this.selectedByScope);
      this.scopedStore.setComparison({ lapId: null, reference: "best" });
    }

    this.lastHeaderSig = "";
    this.syncAll();
    this.rootStore.notifySelectionChanged();
  }

  private handleOutsidePointer = (e: PointerEvent): void => {
    if (!this.addMenuOpen) return;
    const t = e.target as Node | null;
    const wrap = this.el.querySelector(".analytics-add-pilot-wrap");
    if (!t || !wrap?.contains(t)) {
      this.addMenuOpen = false;
      this.pilotSearchQuery = "";
      this.lastHeaderSig = "";
      this.renderHeaderBar();
    }
  };

  private handleGlobalEscape = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.addMenuOpen) {
      this.addMenuOpen = false;
      this.pilotSearchQuery = "";
      this.lastHeaderSig = "";
      this.renderHeaderBar();
    }
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (
      (e.key === "Enter" || e.key === " ") &&
      target.matches("[data-analytics-pilot-pill]")
    ) {
      e.preventDefault();
      const slot = Number(target.dataset.analyticsPilotPill);
      if (slot > 0) this.selectScopePilot(slot);
    }
  };

  private handleInput = (e: Event): void => {
    const target = e.target as HTMLElement | null;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.hasAttribute("data-analytics-pilot-search")) {
      this.pilotSearchQuery = target.value;
      const resultsEl = this.el.querySelector<HTMLElement>("[data-analytics-pilot-results]");
      if (resultsEl) {
        resultsEl.innerHTML = this.renderAddPilotResults(this.currentScope());
      }
    }
  };

  private handleClick = (e: Event): void => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const chooseBtn = target.closest<HTMLElement>("[data-analytics-choose]");
    if (chooseBtn) {
      const kind: AnalyticsScopeKind =
        chooseBtn.dataset.analyticsChoose === "race" ? "race" : "practice";
      const lastSlug = this.lastByKind[kind] ?? "";
      const resolved = this.rootStore.resolveAnalyticsScope({ kind, id: lastSlug });
      const slug = resolved.slug || "";
      if (slug) {
        this.lastByKind[kind] = slug;
        saveLastByKind(this.lastByKind);
      }
      setAnalyticsScope({ kind, id: slug });
      pushAppHash(buildAnalyticsHash({ kind, id: slug }));
      return;
    }

    const restoreBtn = target.closest<HTMLElement>('[data-action="restore-lap-defaults"]');
    if (restoreBtn) {
      this.lapPicker.restoreDefaults();
      return;
    }

    const removeBtn = target.closest<HTMLElement>("[data-analytics-remove-pilot]");
    if (removeBtn) {
      e.stopPropagation();
      const slot = Number(removeBtn.dataset.analyticsRemovePilot);
      if (slot > 0) this.removePilotPill(slot);
      return;
    }

    const pillEl = target.closest<HTMLElement>("[data-analytics-pilot-pill]");
    if (pillEl) {
      const slot = Number(pillEl.dataset.analyticsPilotPill);
      if (slot > 0) this.selectScopePilot(slot);
      return;
    }

    const toggleAddBtn = target.closest<HTMLElement>("[data-analytics-add-pilot-btn]");
    if (toggleAddBtn) {
      this.addMenuOpen = !this.addMenuOpen;
      if (!this.addMenuOpen) this.pilotSearchQuery = "";
      this.lastHeaderSig = "";
      this.renderHeaderBar();
      if (this.addMenuOpen) {
        window.requestAnimationFrame(() => {
          this.el.querySelector<HTMLInputElement>("[data-analytics-pilot-search]")?.focus();
        });
      }
      return;
    }

    const addOption = target.closest<HTMLElement>("[data-analytics-add-pilot]");
    if (addOption) {
      const slot = Number(addOption.dataset.analyticsAddPilot);
      if (slot > 0) this.addPilotPill(slot);
      return;
    }
  };

  private syncAll(): void {
    const isEmbedded = Boolean(this.fixedScopeGetter);
    const rawScope = this.fixedScopeGetter ? this.fixedScopeGetter() : getAnalyticsScope();
    const chooserEl = this.slot("analytics-chooser");
    const emptyScopeEl = this.slot("analytics-empty-scope");
    const pickerRowEl = this.slot("picker-row");
    const emptyPillsEl = this.slot("empty-pills");
    const bodyEl = this.slot("analytics-body");

    if (rawScope === null) {
      chooserEl.style.display = "";
      emptyScopeEl.style.display = "none";
      pickerRowEl.style.display = "none";
      emptyPillsEl.style.display = "none";
      bodyEl.style.display = "none";
      if (this.isViewActive && !isEmbedded) {
        setAnalyticsTopBarContext({
          mode: "chooser",
          scopeKind: "practice",
          scopeId: "",
          scopeName: "",
          scopeLive: false,
        });
      }
      this.renderChooser();
      if (!isEmbedded && this.rootStore.hasHydrated && getCurrentParsedHash().route === "pilot") {
        if (location.hash !== "#/pilot") {
          replaceAppHash("#/pilot");
        }
      }
      return;
    }

    chooserEl.style.display = "none";
    const resolved = this.rootStore.resolveAnalyticsScope(rawScope);
    const canonicalScopeId = resolved.slug || resolved.id;

    if (!resolved.id) {
      emptyScopeEl.style.display = "none";
      pickerRowEl.style.display = "none";
      emptyPillsEl.style.display = "none";
      bodyEl.style.display = "";
      if (!isEmbedded && this.rootStore.hasHydrated && getCurrentParsedHash().route === "pilot") {
        const desired = buildAnalyticsHash({ kind: resolved.kind, id: "" });
        if (location.hash !== desired) {
          replaceAppHash(desired);
        }
      }
      if (this.isViewActive && !isEmbedded) {
        setAnalyticsTopBarContext({
          mode: "scope",
          scopeKind: resolved.kind,
          scopeId: "",
          scopeName: "",
          scopeLive: false,
        });
      }
      const nextKey = `${resolved.kind}:empty`;
      const scopeChanged = this.lastScopeKey !== "" && this.lastScopeKey !== nextKey;
      this.lastScopeKey = nextKey;
      if (scopeChanged) {
        this.rootStore.notifySelectionChanged();
      }
      this.renderStats();
      return;
    }

    emptyScopeEl.style.display = "none";
    pickerRowEl.style.display = "";
    if (!isEmbedded && canonicalScopeId) {
      if (this.lastByKind[resolved.kind] !== canonicalScopeId) {
        this.lastByKind[resolved.kind] = canonicalScopeId;
        saveLastByKind(this.lastByKind);
      }
      if (
        this.rootStore.hasHydrated &&
        (rawScope.kind !== resolved.kind || rawScope.id !== canonicalScopeId)
      ) {
        setAnalyticsScope({ kind: resolved.kind, id: canonicalScopeId });
      }
      if (
        this.rootStore.hasHydrated &&
        getCurrentParsedHash().route === "pilot"
      ) {
        const anchor = getCurrentParsedHash().sectionAnchor;
        const desired = buildAnalyticsHash(
          { kind: resolved.kind, id: canonicalScopeId },
          anchor
        );
        if (location.hash !== desired) {
          replaceAppHash(desired);
        }
      }
    }
    if (this.isViewActive && !isEmbedded) {
      setAnalyticsTopBarContext({
        mode: "scope",
        scopeKind: resolved.kind,
        scopeId: resolved.id,
        scopeName: resolved.name,
        scopeLive: resolved.live,
      });
    }

    const nextKey = scopeStorageKey(resolved);
    const scopeChanged = this.lastScopeKey !== "" && this.lastScopeKey !== nextKey;
    this.lastScopeKey = nextKey;
    const activeSlot = this.activeSlotForCurrentScope();
    const pilotChanged =
      this.lastActivePilotSlot !== 0 && this.lastActivePilotSlot !== activeSlot;
    this.lastActivePilotSlot = activeSlot;
    if (scopeChanged || pilotChanged) {
      this.scopedStore.setComparison({ lapId: null, reference: "best" });
      this.lapPicker.restoreDefaults();
      this.lastHeaderSig = "";
      this.rootStore.notifySelectionChanged();
    }

    this.renderHeaderBar();
    this.renderStats();
  }

  private renderChooser(): void {
    const races = this.rootStore.races;
    const sessions = this.rootStore.practiceSessions;

    let totalRaceLaps = 0;
    let liveRaces = 0;
    for (const r of races) {
      if (
        r.lifecycle === "active" ||
        r.heats.some((h) => h.state === "running" || h.state === "countdown")
      ) {
        liveRaces++;
      }
      for (const h of r.heats) {
        for (const seat of h.seats) {
          if (seat.pilotSlotIndex <= 0) continue;
          for (const hl of seat.laps ?? []) {
            if (!hl.invalidated && hl.lapNumber >= 1 && hl.splitTimeSec > 0) {
              totalRaceLaps++;
            }
          }
        }
      }
    }

    let totalPracticeLaps = 0;
    let livePractices = 0;
    for (const s of sessions) {
      if (s.active) livePractices++;
      totalPracticeLaps += s.laps?.length ?? 0;
    }

    const sig = `${races.length}:${totalRaceLaps}:${liveRaces}:${sessions.length}:${totalPracticeLaps}:${livePractices}`;
    if (sig === this.lastChooserSig) return;
    this.lastChooserSig = sig;

    const raceMeta =
      races.length === 0
        ? "No races yet"
        : `${races.length} race${races.length === 1 ? "" : "s"} · ${totalRaceLaps} lap${totalRaceLaps === 1 ? "" : "s"}`;
    const practiceMeta =
      sessions.length === 0
        ? "No sessions yet"
        : `${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${totalPracticeLaps} lap${totalPracticeLaps === 1 ? "" : "s"}`;

    this.slot("analytics-chooser").innerHTML = `
      <div class="analytics-chooser-grid" data-analytics-chooser-grid>
        <button
          type="button"
          class="card analytics-chooser-card"
          data-analytics-choose="race"
        >
          <div class="analytics-chooser-card-top">
            <span class="analytics-chooser-icon">${icons.checkered(26)}</span>
            <span class="analytics-chooser-arrow">${icons.arrowRight(20)}</span>
          </div>
          <div class="analytics-chooser-body">
            <h3>Race Analytics</h3>
            <p>Inspect heat lap times, section splits, consistency, and theoretical bests from any race.</p>
          </div>
          <div class="analytics-chooser-foot">
            ${liveRaces > 0 ? `<span class="topbar-scope-live-dot" aria-hidden="true"></span>` : ""}
            <span class="mono">${esc(raceMeta)}</span>
          </div>
        </button>

        <button
          type="button"
          class="card analytics-chooser-card"
          data-analytics-choose="practice"
        >
          <div class="analytics-chooser-card-top">
            <span class="analytics-chooser-icon">${icons.flag(26)}</span>
            <span class="analytics-chooser-arrow">${icons.arrowRight(20)}</span>
          </div>
          <div class="analytics-chooser-body">
            <h3>Practice Analytics</h3>
            <p>Analyze open practice sessions, personal best progression, and section-by-section time loss.</p>
          </div>
          <div class="analytics-chooser-foot">
            ${livePractices > 0 ? `<span class="topbar-scope-live-dot" aria-hidden="true"></span>` : ""}
            <span class="mono">${esc(practiceMeta)}</span>
          </div>
        </button>
      </div>`;
  }

  private renderHeaderBar(): void {
    const resolved = this.currentScope();
    const pills = this.curatedPilotObjects();
    const activeSlot = this.activeSlotForCurrentScope();
    const trackInfo =
      resolved.kind === "race"
        ? this.rootStore.raceNodes(resolved.race)
        : this.rootStore.practiceSessionNodes(resolved.session);
    const gateCount = trackInfo.nodes.length;
    const secRange = gateCount > 1 ? `S1–S${gateCount}` : gateCount === 1 ? "S1" : "";

    const pillSummaries = pills.map((p) => {
      const s = practiceStats(this.scopedStore, p);
      return { p, lapsCount: s.laps.length, onTrack: s.onTrack };
    });

    const sig = `${scopeStorageKey(resolved)}:${activeSlot}:${this.addMenuOpen ? 1 : 0}:${trackInfo.historical ? 1 : 0}:${gateCount}:${pillSummaries.map((x) => `${x.p.slotIndex}:${x.p.callsign}:${x.p.color}:${x.lapsCount}:${x.onTrack ? 1 : 0}`).join("|")}`;
    if (sig !== this.lastHeaderSig) {
      this.lastHeaderSig = sig;

      if (!this.fixedScopeGetter) {
        const pillsHtml = pillSummaries
          .map(({ p, lapsCount, onTrack }) => {
            const active = p.slotIndex === activeSlot;
            return `
            <div
              class="pilot-chip analytics-pilot-pill ${active ? "is-active" : ""} ${onTrack ? "is-live" : ""}"
              role="tab"
              tabindex="0"
              aria-selected="${active ? "true" : "false"}"
              data-analytics-pilot-pill="${p.slotIndex}"
              data-pilot="${p.slotIndex}"
              style="--c:${esc(p.color)}"
            >
              <span class="dot ${onTrack ? "is-live" : ""}"></span>
              <span class="pilot-chip-name">${esc(p.callsign)}</span>
              <span class="pilot-chip-time">${lapsCount} lap${lapsCount === 1 ? "" : "s"}</span>
              <button
                type="button"
                class="analytics-pill-remove"
                data-analytics-remove-pilot="${p.slotIndex}"
                title="Remove ${esc(p.callsign)} pill"
                aria-label="Remove ${esc(p.callsign)} pill"
              >
                ${icons.close(12)}
              </button>
            </div>`;
          })
          .join("");

        this.slot("pills-bar").innerHTML = `
        <div class="pilot-picker analytics-pills-list" role="tablist" aria-label="Analytics pilots">
          ${pillsHtml}
        </div>
        <div class="analytics-add-pilot-wrap">
          <button
            type="button"
            class="analytics-add-pilot-btn ${this.addMenuOpen ? "is-open" : ""}"
            data-analytics-add-pilot-btn
            aria-haspopup="dialog"
            aria-expanded="${this.addMenuOpen ? "true" : "false"}"
            title="Add pilot pill"
            aria-label="Add pilot pill"
          >
            ${icons.plus(16)}
          </button>
          ${
            this.addMenuOpen
              ? `<div class="analytics-add-pilot-popover" data-analytics-add-pilot-menu role="dialog" aria-label="Add pilot pill">
                   <div class="analytics-add-pilot-search-wrap">
                     <input
                       type="search"
                       class="input input-sm"
                       data-analytics-pilot-search
                       placeholder="Filter pilots…"
                       value="${esc(this.pilotSearchQuery)}"
                       autocomplete="off"
                       aria-label="Filter pilots"
                     />
                   </div>
                   <div class="analytics-add-pilot-results" data-analytics-pilot-results>
                     ${this.renderAddPilotResults(resolved)}
                   </div>
                 </div>`
              : ""
          }
        </div>`;
      }

      this.slot("scope-meta").innerHTML = `
        <span
          class="track-scope-pill ${trackInfo.historical ? "is-locked" : "is-live"}"
          data-analytics-track-pill="${trackInfo.historical ? "locked" : "live"}"
          title="${
            trackInfo.historical
              ? "Viewing frozen historical track layout & sections recorded for this scope"
              : "Linked to current live Track configuration"
          }"
        >
          ${trackInfo.historical ? icons.lock(13) : icons.gate(13)}
          <span>${trackInfo.historical ? "Track snapshot" : "Live track"} · ${gateCount} gate${gateCount === 1 ? "" : "s"}${secRange ? ` · ${secRange}` : ""}</span>
        </span>`;
    } else if (this.addMenuOpen) {
      const resultsEl = this.el.querySelector<HTMLElement>("[data-analytics-pilot-results]");
      if (resultsEl) {
        resultsEl.innerHTML = this.renderAddPilotResults(resolved);
      }
    }

    const emptyPillsEl = this.slot("empty-pills");
    const bodyEl = this.slot("analytics-body");
    if (pills.length === 0) {
      emptyPillsEl.style.display = "";
      bodyEl.style.display = "none";
      emptyPillsEl.innerHTML = `
        <section class="card card-flush">
          ${renderEmpty(
            "No pilot pills shown",
            `Click the circular + button above to add pilots from ${resolved.name} or the global Pilots directory.`
          )}
        </section>`;
    } else {
      emptyPillsEl.style.display = "none";
      bodyEl.style.display = "";
    }
  }

  private renderAddPilotResults(resolved: ResolvedAnalyticsScope): string {
    const pool = this.rootStore.analyticsPilotPool(resolved);
    const shownSet = new Set(this.curatedSlotsForScope(resolved));
    const q = this.pilotSearchQuery.trim().toLowerCase();

    const matches = (p: PilotSlot): boolean => {
      if (!q) return true;
      const chLabel = pilotChannelSearchTokens(p.band, p.channel, p.frequencyMhz);
      return (
        p.callsign.toLowerCase().includes(q) ||
        (p.phoneticName ?? "").toLowerCase().includes(q) ||
        chLabel.includes(q)
      );
    };

    const inScopeAvail = pool.inScope.filter((p) => !shownSet.has(p.slotIndex) && matches(p));
    const globalAvail = pool.globalOther.filter((p) => !shownSet.has(p.slotIndex) && matches(p));

    if (inScopeAvail.length === 0 && globalAvail.length === 0) {
      return `<div class="analytics-add-pilot-empty">${
        q ? `No matching unadded pilots for "${esc(this.pilotSearchQuery.trim())}"` : "All pilots are already shown as pills"
      }</div>`;
    }

    const renderOption = (p: PilotSlot): string => {
      const lapCount = lapsFor(this.scopedStore, p.slotIndex).length;
      const chBadge = formatBandChannelShort(p.band, p.channel);
      return `
        <button
          type="button"
          class="analytics-add-pilot-item"
          data-analytics-add-pilot="${p.slotIndex}"
        >
          <span class="analytics-add-pilot-main">
            <span class="dot" style="--c:${esc(p.color)}"></span>
            <span class="analytics-add-pilot-name">${esc(p.callsign)}</span>
            ${chBadge ? `<span class="analytics-add-pilot-ch mono">${chBadge}</span>` : ""}
          </span>
          <span class="analytics-add-pilot-laps mono">${lapCount} lap${lapCount === 1 ? "" : "s"}</span>
        </button>`;
    };

    const scopeTitle = resolved.kind === "race" ? "In this race" : "In this session";
    return `
      ${
        inScopeAvail.length > 0
          ? `<div class="analytics-add-pilot-group">
               <div class="analytics-add-pilot-group-label">${scopeTitle}</div>
               ${inScopeAvail.map(renderOption).join("")}
             </div>`
          : ""
      }
      ${
        globalAvail.length > 0
          ? `<div class="analytics-add-pilot-group">
               <div class="analytics-add-pilot-group-label">Other pilots</div>
               ${globalAvail.map(renderOption).join("")}
             </div>`
          : ""
      }`;
  }

  private renderStats(): void {
    const resolved = this.currentScope();
    const activeSlot = resolved.id ? this.activeSlotForCurrentScope() : 0;
    const pilot = activeSlot ? this.scopedStore.pilot(activeSlot) : undefined;
    if (!resolved.id || !activeSlot || !pilot) {
      const emptyNote = !resolved.id
        ? resolved.kind === "race"
          ? "No races recorded"
          : "No practices recorded"
        : "No pilot selected";
      this.slot("stats").innerHTML = renderStatTiles([
        { label: "Best lap", value: "—", sub: emptyNote, tone: "accent" },
        { label: "Last lap", value: "—", sub: "—" },
        { label: "Average, last 5", value: "—", sub: "Trend after 10 laps" },
        { label: "Best possible lap", value: "—", sub: "Fly every section to unlock" },
      ]);
      return;
    }
    const s = practiceStats(this.scopedStore, pilot);
    const possible = bestPossibleLap(this.scopedStore, pilot.slotIndex);
    const linkGain = s.bestLap > 0 && possible > 0 ? s.bestLap - possible : 0;
    const zeroNote = `No laps yet in ${resolved.name}`;

    this.slot("stats").innerHTML = renderStatTiles([
      {
        label: "Best lap",
        value: fmtTime(s.bestLap),
        sub: s.laps.length > 0 ? `${s.laps.length} lap${s.laps.length === 1 ? "" : "s"} flown` : zeroNote,
        tone: "accent",
      },
      {
        label: "Last lap",
        value: fmtTime(s.lastLap),
        sub:
          s.lastLap > 0 && s.bestLap > 0
            ? s.lastLap === s.bestLap
              ? "Personal best"
              : `${fmtDelta(s.lastLap - s.bestLap)} vs best`
            : "—",
      },
      {
        label: "Average, last 5",
        value: fmtTime(s.rollingAvg),
        sub: Number.isFinite(s.trend) ? `${fmtDelta(s.trend)} vs the 5 before` : "Trend after 10 laps",
        tone: Number.isFinite(s.trend) ? (s.trend < 0 ? "good" : "bad") : undefined,
      },
      {
        label: "Best possible lap",
        value: fmtTime(possible),
        sub:
          possible > 0
            ? linkGain > 0.0005
              ? `${fmtDelta(-linkGain)} by linking your best sections`
              : "Your best lap links every best section"
            : "Fly every section to unlock",
      },
    ]);
  }
}
