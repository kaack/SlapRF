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
    const onlineTimers = this.store.detectedPucks.filter((p) => p.online).length;
    const totalTimers = this.store.detectedPucks.length;
    const statusUp = sim || onlineTimers > 0;
    const statusTitle = sim ? "Active source: Track simulator" : "Active source: Live hardware (IRL)";
    const statusSub = sim
      ? `${this.store.enabledPilots.length} simulated pilots · ${totalTimers} virtual gate timers · isolated simulation dataset`
      : totalTimers > 0
        ? `${onlineTimers} of ${totalTimers} physical timer${totalTimers === 1 ? "" : "s"} online · real-world hardware dataset`
        : "Waiting for physical XIAO ESP32-C5 timers over Wi-Fi or USB · real-world hardware dataset";

    this.el.innerHTML = `
      <div class="livetime">
        <div class="livetime-status ${statusUp ? "is-up" : ""}">
          <span class="status-dot"></span>
          <div>
            <div class="livetime-status-title">${statusTitle}</div>
            <div class="livetime-status-sub">${statusSub}</div>
          </div>
        </div>
        <div class="option-row" style="padding-top:12px;border-top:1px solid var(--border);">
          <div>
            <div class="option-title">Simulated track &amp; pilots</div>
            <div class="option-sub">Switches to a self-contained simulation dataset (simulated pilots, 6S battery packs, pit swaps, crashes, track recovery walks, and virtual XIAO gate timers) and reveals the Simulator page in the navigation bar. Turn off to use your real-world hardware dataset.</div>
          </div>
          <div class="option-actions">
            <label class="switch switch-lg">
              <input type="checkbox" name="simulator" ${sim ? "checked" : ""} />
              <span></span>
            </label>
          </div>
        </div>
      </div>`;
  }
}
