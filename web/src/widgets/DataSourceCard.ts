import { Component } from "../core/component";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";

/** Toggle between real-world physical XIAO hardware and the built-in track simulator. */
export class DataSourceCard extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;
    el.addEventListener("change", this.handleChange);
    el.addEventListener("click", this.handleClick);
    this.onDispose(() => {
      el.removeEventListener("change", this.handleChange);
      el.removeEventListener("click", this.handleClick);
    });
    this.onDispose(store.subscribe(["status", "config"], () => this.render()));
    this.render();
  }

  private handleChange = (e: Event): void => {
    if ((e.target as HTMLInputElement).name === "simulator") {
      void this.api.toggleSimulator();
    }
  };

  private handleClick = (e: Event): void => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-action='reset-stored']");
    if (!btn) return;
    const sim = this.store.simulatorRunning;
    const msg = sim
      ? "Reset all saved simulator data (pilots, track layout, timers, rules, and laps) back to factory defaults and start a fresh simulation?"
      : "Reset all saved hardware data (pilots, track layout, provisioned timers, rules, and laps) in the local database back to factory defaults?";
    if (!window.confirm(msg)) return;
    void this.api.resetStoredData();
  };

  private render(): void {
    const sim = this.store.simulatorRunning;
    this.el.innerHTML = `
      <div class="card">
        <div class="option-row">
          <div>
            <div class="option-title">Simulation active</div>
            <div class="option-sub">Feeds the app with simulated pilots, gates, and 6S flight packs in a separate dataset. Turn off to use your physical timers.</div>
          </div>
          <div class="option-actions">
            <label class="switch switch-lg">
              <input type="checkbox" name="simulator" ${sim ? "checked" : ""} />
              <span></span>
            </label>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="option-row">
          <div>
            <div class="option-title">${sim ? "Reset simulator data" : "Reset hardware data"}</div>
            <div class="option-sub">${
              sim
                ? "Clears saved simulator settings, custom pilots, track layout, timers, and recorded laps from browser storage and starts a fresh simulation."
                : "Clears saved pilots, track layout, provisioned timers, timing rules, and recorded laps from the local database and starts clean."
            }</div>
          </div>
          <div class="option-actions">
            <button type="button" class="btn btn-ghost" data-action="reset-stored">
              ${sim ? "Reset simulator" : "Reset hardware data"}
            </button>
          </div>
        </div>
      </div>`;
  }
}
