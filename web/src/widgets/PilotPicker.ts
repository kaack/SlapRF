import { Component } from "../core/component";
import { esc } from "../core/format";
import { lapsFor } from "../state/selectors";
import { AppStore } from "../state/store";

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
    this.onDispose(store.subscribe(["config", "selection", "laps"], () => this.render()));
    this.render();
  }

  private render(): void {
    const selected = this.opts.value();
    const all = this.opts.includeAll
      ? `<button class="pilot-chip pilot-chip-all ${selected === null ? "is-active" : ""}" role="tab"
           aria-selected="${selected === null}" data-pilot="all">
           <span class="pilot-chip-name">All</span>
         </button>`
      : "";
    const pilots = this.store.enabledPilots
      .map((p) => {
        const active = p.slotIndex === selected;
        const laps = lapsFor(this.store, p.slotIndex).length;
        return `
          <button class="pilot-chip ${active ? "is-active" : ""}" role="tab" aria-selected="${active}" data-pilot="${p.slotIndex}" style="--c:${p.color}">
            <span class="dot"></span>
            <span class="pilot-chip-name">${esc(p.callsign)}</span>
            <span class="pilot-chip-time mono">${laps} laps</span>
          </button>`;
      })
      .join("");
    this.el.innerHTML = all + pilots;
  }
}
