import { Component } from "../core/component";
import { esc } from "../core/format";
import { gateColor, lapsFor, sectionLabel, sectionShort } from "../state/selectors";
import { AppStore } from "../state/store";
import { renderSectionCapsuleIcon } from "./markup";
import { ProgressionChart } from "./ProgressionChart";

/** Selected view: the whole lap, or the section that starts at this gate. */
type View =
  | { kind: "lap" }
  | { kind: "section"; sectorIndex: number; fromPuckId: number; toPuckId: number };

/**
 * Lap times through the session, switchable between the whole lap and any single section —
 * so you can see where on the track a pilot is improving. Shows every pilot, or just one
 * when `slotIndex` is given.
 */
export class LapTimesCard extends Component {
  private readonly store: AppStore;
  private readonly slotIndex: (() => number) | undefined;
  private readonly chart: ProgressionChart;
  private readonly hiddenSlots = new Set<number>();
  private view: View = { kind: "lap" };
  private renderedTabsSig = "";

  constructor(el: HTMLElement, store: AppStore, opts: { slotIndex?: () => number } = {}) {
    super(el);
    this.store = store;
    this.slotIndex = opts.slotIndex;

    el.innerHTML = `
      <header class="card-head">
        <div><h2>Lap times</h2><p data-slot="subtitle"></p></div>
        <div class="segmented" data-slot="views" role="tablist" aria-label="Show"></div>
      </header>
      <div class="canvas-host canvas-host-lg" data-slot="chart"></div>
      <div class="chart-legend" data-slot="legend"></div>`;

    this.chart = this.adopt(new ProgressionChart(this.slot("chart"), store, { slotIndex: this.slotIndex }));

    const handleSelect = (e: Event) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-view]");
      if (!btn) return;
      this.view =
        btn.dataset.view === "lap"
          ? { kind: "lap" }
          : {
              kind: "section",
              sectorIndex: Number(btn.dataset.sector),
              fromPuckId: Number(btn.dataset.from),
              toPuckId: Number(btn.dataset.to),
            };
      this.chart.setMetric(this.view);
      this.render();
    };

    this.listen(this.slot("views"), "pointerdown", (e) => {
      if (e.button !== 0) return;
      handleSelect(e);
    });
    this.listen(this.slot("views"), "click", handleSelect);

    this.listen(this.slot("legend"), "click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-legend-slot]");
      if (!btn) return;
      const slot = Number(btn.dataset.legendSlot);
      if (!Number.isFinite(slot)) return;
      if (this.hiddenSlots.has(slot)) {
        this.hiddenSlots.delete(slot);
      } else {
        this.hiddenSlots.add(slot);
      }
      this.chart.setHiddenSlots(this.hiddenSlots);
      this.render();
    });

    this.onDispose(store.subscribe(["laps", "config", "selection"], () => this.render()));
    this.render();
  }

  /** Sections in course order: each gate to the next, wrapping back to start / finish. */
  private sections(): Array<{ sectorIndex: number; from: number; to: number }> {
    const pucks = this.store.pucks;
    if (pucks.length === 0) return [];
    return pucks.map((p, i) => ({
      sectorIndex: i + 1,
      from: p.puckId,
      to: pucks[(i + 1) % pucks.length].puckId,
    }));
  }

  private render(): void {
    const sections = this.sections();
    const v = this.view;
    // If the course was reordered or gates changed, keep the selected section aligned with the course.
    if (v.kind === "section") {
      const byPair = sections.find((s) => s.from === v.fromPuckId && s.to === v.toPuckId);
      const byIdx = sections.find((s) => s.sectorIndex === v.sectorIndex);
      const match = byPair ?? byIdx;
      if (!match) {
        this.view = { kind: "lap" };
        this.chart.setMetric(this.view);
      } else if (match.from !== v.fromPuckId || match.to !== v.toPuckId || match.sectorIndex !== v.sectorIndex) {
        this.view = {
          kind: "section",
          sectorIndex: match.sectorIndex,
          fromPuckId: match.from,
          toPuckId: match.to,
        };
        this.chart.setMetric(this.view);
      }
    }
    const view = this.view;
    const isActive = (from: number, to: number) =>
      view.kind === "section" && view.fromPuckId === from && view.toPuckId === to;

    const tabsSig = sections
      .map(
        ({ sectorIndex, from, to }) =>
          `${sectorIndex}:${from}>${to}:${gateColor(this.store, from)}>${gateColor(this.store, to)}:${sectionShort(this.store, from)}:${sectionLabel(this.store, from, to)}`
      )
      .join("|");

    const viewsHost = this.slot("views");
    if (tabsSig !== this.renderedTabsSig) {
      this.renderedTabsSig = tabsSig;
      viewsHost.innerHTML =
        `<button type="button" role="tab" data-view="lap" class="${view.kind === "lap" ? "is-active" : ""}" aria-selected="${view.kind === "lap"}">Whole lap</button>` +
        sections
          .map(({ sectorIndex, from, to }) => {
            const active = isActive(from, to);
            return `<button type="button" role="tab" data-view="section" data-sector="${sectorIndex}" data-from="${from}" data-to="${to}" class="${active ? "is-active" : ""}"
                      aria-selected="${active}" title="${esc(sectionLabel(this.store, from, to))}">${renderSectionCapsuleIcon(gateColor(this.store, from), gateColor(this.store, to))}${sectionShort(this.store, from)}</button>`;
          })
          .join("");
    } else {
      viewsHost.querySelectorAll<HTMLButtonElement>("button[data-view]").forEach((btn) => {
        const active =
          btn.dataset.view === "lap"
            ? view.kind === "lap"
            : isActive(Number(btn.dataset.from), Number(btn.dataset.to));
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-selected", String(active));
      });
    }

    const single = this.slotIndex !== undefined;
    this.slot("subtitle").textContent =
      view.kind === "lap"
        ? single
          ? "Session timeline · dashed line is their best · gaps show pit swaps and recovery breaks"
          : "Session timeline · pilots flying at the same time align · gaps show pit swaps and breaks"
        : `${sectionShort(this.store, view.fromPuckId)} (${sectionLabel(this.store, view.fromPuckId, view.toPuckId)}) · ${single ? "their" : "each pilot's"} time on this stretch across the session timeline`;

    // One pilot needs no colour key.
    this.slot("legend").innerHTML = single
      ? ""
      : this.store.enabledPilots
          .filter((p) => lapsFor(this.store, p.slotIndex).length > 0)
          .map((p) => {
            const hidden = this.hiddenSlots.has(p.slotIndex);
            return `<button type="button" class="chart-legend-item ${hidden ? "is-hidden" : ""}" data-legend-slot="${p.slotIndex}" aria-pressed="${!hidden}" title="${hidden ? `Click to show ${esc(p.callsign)} on chart` : `Click to hide ${esc(p.callsign)} from chart`}">
              <i style="--c:${p.color}"></i>
              <span>${esc(p.callsign)}</span>
            </button>`;
          })
          .join("");
  }
}
