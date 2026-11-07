import { Component } from "../core/component";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";

/** Toggle between the built-in track simulator and live USB dongle hardware. */
export class DataSourceCard extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;
    el.addEventListener("change", this.handleChange);
    this.onDispose(() => el.removeEventListener("change", this.handleChange));
    this.onDispose(store.subscribe(["status"], () => this.render()));
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
          <div class="option-title">Track simulator</div>
          <div class="option-sub">Generates realistic 8-pilot RSSI at every gate. Turn off once the USB receiver dongle is connected.</div>
        </div>
        <label class="switch switch-lg">
          <input type="checkbox" name="simulator" ${sim ? "checked" : ""} />
          <span></span>
        </label>
      </div>`;
  }
}
