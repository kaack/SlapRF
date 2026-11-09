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
    this.onDispose(() => {
      el.removeEventListener("change", this.handleChange);
    });
    this.onDispose(store.subscribe(["status", "config"], () => this.render()));
    this.render();
  }

  private handleChange = (e: Event): void => {
    if ((e.target as HTMLInputElement).name === "simulator") {
      void this.api.toggleSimulator();
    }
  };

  private render(): void {
    const sim = this.store.simulatorRunning;
    this.el.innerHTML = `
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
      </div>`;
  }
}
