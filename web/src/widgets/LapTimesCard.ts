import { Component } from "../core/component";
import { esc } from "../core/format";
import { gateColor, lapsFor, sectionLabel, sectionShort } from "../state/selectors";
import { AppStore } from "../state/store";
import { renderSectionCapsuleIcon } from "./markup";
import { ProgressionChart } from "./ProgressionChart";

/** Selected view: the whole lap, or the section that starts at this gate. */
type View =
  | { kind: "lap" }
  | { kind: "section"; sectorIndex: number; fromGateId: number; toGateId: number };

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
        <div class="settings-intro"><h2>Lap times</h2><p><span data-slot="subtitle"></span></p></div>
      </header>
      <div class="canvas-host canvas-host-lg" data-slot="chart"></div>
      <div class="chart-legend" data-slot="legend"></div>
      <div class="channel-legend" data-slot="views" role="tablist" aria-label="Show"></div>`;

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
              fromGateId: Number(btn.dataset.from),
              toGateId: Number(btn.dataset.to),
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
    const gates = this.store.nodes;
    if (gates.length === 0) return [];
    return gates.map((p, i) => ({
      sectorIndex: i + 1,
      from: p.gateId,
      to: gates[(i + 1) % gates.length].gateId,
    }));
  }

  private render(): void {
    const sections = this.sections();
    const v = this.view;
    // If the course was reordered or gates changed, keep the selected section aligned with the course.
    if (v.kind === "section") {
      const byPair = sections.find((s) => s.from === v.fromGateId && s.to === v.toGateId);
      const byIdx = sections.find((s) => s.sectorIndex === v.sectorIndex);
      const match = byPair ?? byIdx;
      if (!match) {
        this.view = { kind: "lap" };
        this.chart.setMetric(this.view);
      } else if (match.from !== v.fromGateId || match.to !== v.toGateId || match.sectorIndex !== v.sectorIndex) {
        this.view = {
          kind: "section",
          sectorIndex: match.sectorIndex,
          fromGateId: match.from,
          toGateId: match.to,
        };
        this.chart.setMetric(this.view);
      }
    }
    const view = this.view;
    const isActive = (from: number, to: number) =>
      view.kind === "section" && view.fromGateId === from && view.toGateId === to;

    const tabsSig = sections
      .map(
        ({ sectorIndex, from, to }) =>
          `${sectorIndex}:${from}>${to}:${gateColor(this.store, from)}>${gateColor(this.store, to)}:${sectionShort(this.store, from)}:${sectionLabel(this.store, from, to)}`
      )
      .join("|");

    const viewsHost = this.slot("views");
    if (tabsSig !== this.renderedTabsSig) {
      this.renderedTabsSig = tabsSig;
      const wholeActive = view.kind === "lap";
      viewsHost.innerHTML =
        `<button type="button" role="tab" data-view="lap" class="channel channel-all ${wholeActive ? "is-focus" : "is-dim"}" aria-selected="${wholeActive}" title="Show whole lap times">
          <span class="dot channel-all-dot"></span>
          <span class="channel-name">Whole lap</span>
          <span class="channel-dbm mono">${sections.length} ${sections.length === 1 ? "section" : "sections"}</span>
        </button>` +
        sections
          .map(({ sectorIndex, from, to }) => {
            const active = isActive(from, to);
            const dim = !wholeActive && !active;
            const route = sectionLabel(this.store, from, to);
            return `<button type="button" role="tab" data-view="section" data-sector="${sectorIndex}" data-from="${from}" data-to="${to}" class="channel ${active ? "is-focus" : ""} ${dim ? "is-dim" : ""}"
                      aria-selected="${active}" title="${esc(route)}">
                      ${renderSectionCapsuleIcon(gateColor(this.store, from), gateColor(this.store, to))}
                      <span class="channel-name">${sectionShort(this.store, from)}</span>
                      <span class="channel-dbm mono">${esc(route)}</span>
                    </button>`;
          })
          .join("");
    } else {
      const wholeActive = view.kind === "lap";
      viewsHost.querySelectorAll<HTMLButtonElement>("button[data-view]").forEach((btn) => {
        const active =
          btn.dataset.view === "lap"
            ? wholeActive
            : isActive(Number(btn.dataset.from), Number(btn.dataset.to));
        const dim = btn.dataset.view === "lap" ? !wholeActive : !wholeActive && !active;
        btn.classList.toggle("is-focus", active);
        btn.classList.toggle("is-dim", dim);
        btn.setAttribute("aria-selected", String(active));
      });
    }

    const single = this.slotIndex !== undefined;
    this.slot("subtitle").textContent =
      view.kind === "lap"
        ? single
          ? "Session timeline · dashed line is their best · gaps show pit swaps and recovery breaks"
          : "Session timeline · pilots flying at the same time align · gaps show pit swaps and breaks"
        : `${sectionShort(this.store, view.fromGateId)} (${sectionLabel(this.store, view.fromGateId, view.toGateId)}) · ${single ? "their" : "each pilot's"} time on this stretch across the session timeline`;

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
