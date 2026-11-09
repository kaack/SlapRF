import { Component } from "../core/component";
import { esc } from "../core/format";
import { practiceStats } from "../state/analysis";
import { AppStore } from "../state/store";

const IDLE_REFRESH_MS = 5000;

export interface PilotPickerOptions {
  /** Currently selected slot; null means the "All" chip. */
  value: () => number | null;
  onSelect: (slotIndex: number | null) => void;
  /** Show an "All" chip before the pilots. */
  includeAll?: boolean;
}

/** Row of pilot chips. Used by the live view (with "All") and pilot analysis. */
export class PilotPicker extends Component {
  private readonly store: AppStore;
  private readonly opts: PilotPickerOptions;
  private renderedStructureSig = "";

  constructor(el: HTMLElement, store: AppStore, opts?: Partial<PilotPickerOptions>) {
    super(el);
    this.store = store;
    this.opts = {
      value: opts?.value ?? (() => store.selectedPilot),
      onSelect: opts?.onSelect ?? ((slot) => slot !== null && store.selectPilot(slot)),
      includeAll: opts?.includeAll ?? false,
    };
    el.classList.add("pilot-picker");
    el.setAttribute("role", "tablist");
    el.setAttribute("aria-label", "Pilot");
    const handleSelect = (e: Event) => {
      const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-pilot]");
      if (!chip) return;
      const v = chip.dataset.pilot;
      this.opts.onSelect(v === "all" ? null : Number(v));
    };
    this.listen(el, "pointerdown", (e) => {
      if (e.button !== 0) return;
      handleSelect(e);
    });
    this.listen(el, "click", handleSelect);
    this.onDispose(store.subscribe(["config", "selection", "laps", "crossings"], () => this.render()));
    const timer = window.setInterval(() => this.render(), IDLE_REFRESH_MS);
    this.onDispose(() => window.clearInterval(timer));
    this.render();
  }

  private render(): void {
    const selected = this.opts.value();
    const enabled = this.store.enabledPilots;
    const structureSig = `${this.opts.includeAll ? "all|" : ""}${enabled.map((p) => p.slotIndex).join(",")}`;

    if (structureSig !== this.renderedStructureSig) {
      this.renderedStructureSig = structureSig;
      const all = this.opts.includeAll
        ? `<button class="pilot-chip pilot-chip-all ${selected === null ? "is-active" : ""}" role="tab"
             aria-selected="${selected === null}" data-pilot="all">
             <span class="pilot-chip-name">All</span>
           </button>`
        : "";
      const pilots = enabled
        .map((p) => {
          const active = p.slotIndex === selected;
          const s = practiceStats(this.store, p);
          const laps = s.laps.length;
          return `
            <button class="pilot-chip ${active ? "is-active" : ""} ${s.onTrack ? "is-live" : ""}" role="tab" aria-selected="${active}" data-pilot="${p.slotIndex}" style="--c:${p.color}">
              <span class="dot ${s.onTrack ? "is-live" : ""}"></span>
              <span class="pilot-chip-name">${esc(p.callsign)}</span>
              <span class="pilot-chip-time">${laps} laps</span>
            </button>`;
        })
        .join("");
      this.el.innerHTML = all + pilots;
      return;
    }

    const allBtn = this.el.querySelector<HTMLButtonElement>('button[data-pilot="all"]');
    if (allBtn) {
      const isAll = selected === null;
      allBtn.classList.toggle("is-active", isAll);
      allBtn.setAttribute("aria-selected", String(isAll));
    }

    for (const p of enabled) {
      const btn = this.el.querySelector<HTMLButtonElement>(`button[data-pilot="${p.slotIndex}"]`);
      if (!btn) continue;
      const active = p.slotIndex === selected;
      const s = practiceStats(this.store, p);
      const laps = s.laps.length;
      btn.classList.toggle("is-active", active);
      btn.classList.toggle("is-live", s.onTrack);
      btn.setAttribute("aria-selected", String(active));
      btn.style.setProperty("--c", p.color);
      const dot = btn.querySelector<HTMLElement>(".dot");
      if (dot) dot.classList.toggle("is-live", s.onTrack);
      const nameEl = btn.querySelector<HTMLElement>(".pilot-chip-name");
      if (nameEl && nameEl.textContent !== p.callsign) nameEl.textContent = p.callsign;
      const timeEl = btn.querySelector<HTMLElement>(".pilot-chip-time");
      const timeText = `${laps} laps`;
      if (timeEl && timeEl.textContent !== timeText) timeEl.textContent = timeText;
    }
  }
}
