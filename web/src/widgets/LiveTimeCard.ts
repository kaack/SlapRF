import { Component } from "../core/component";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";

/** Connection instructions and live link status for MultiGP LiveTime. */
export class LiveTimeCard extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;
    el.addEventListener("change", (e) => {
      const input = (e.target as HTMLElement).closest<HTMLInputElement>("input[data-action='toggle-livetime']");
      if (input) void this.api.setLiveTimeEnabled(input.checked);
    });
    this.onDispose(store.subscribe(["status"], () => this.render()));
    this.render();
  }

  private render(): void {
    const lt = this.store.liveTime;
    const port = lt.listenAddr.split(":").pop() || "5403";
    const connected = lt.connectedClients > 0;
    const lastSync = lt.lastRfSetupSync && !lt.lastRfSetupSync.startsWith("0001")
      ? new Date(lt.lastRfSetupSync).toLocaleTimeString()
      : "never";

    this.el.innerHTML = `
      <div class="livetime">
        <div class="option-row">
          <div>
            <div class="option-title">LiveTime integration</div>
            <div class="option-sub">Emulates an ImmersionRC LapRF 8-way timer over TCP so MultiGP LiveTime can sync pilot channels and receive start-gate lap passings.</div>
          </div>
          <label class="switch switch-lg"><input type="checkbox" data-action="toggle-livetime" ${lt.enabled ? "checked" : ""} /><span></span></label>
        </div>
        ${
          lt.enabled
            ? `
        <div class="livetime-body">
          <div class="livetime-status ${connected ? "is-up" : ""}">
            <span class="status-dot"></span>
            <div>
              <div class="livetime-status-title">${connected ? "LiveTime connected" : "Waiting for LiveTime"}</div>
              <div class="livetime-status-sub">${lt.connectedClients} client${lt.connectedClients === 1 ? "" : "s"} · ${lt.detectionsSent} passings sent · channel sync ${lastSync}</div>
            </div>
          </div>
          <ol class="steps">
            <li><div class="step-body"><span>In LiveTime, add a timing device of type</span> <code>ImmersionRC LapRF (8-way)</code></div></li>
            <li><div class="step-body"><span>Point it at this computer</span> <code>127.0.0.1 : ${port}</code></div></li>
            <li><div class="step-body"><span>Load a heat — pilot channels are pushed to every gate automatically.</span></div></li>
          </ol>
          <p class="note">Only the start gate reports laps to LiveTime. Sector gates feed Pilot insights.</p>
        </div>`
            : ""
        }
      </div>`;
  }
}
