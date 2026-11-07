import { Component } from "../core/component";
import { AppStore } from "../state/store";

/** Connection instructions and live link status for MultiGP LiveTime. */
export class LiveTimeCard extends Component {
  private readonly store: AppStore;

  constructor(el: HTMLElement, store: AppStore) {
    super(el);
    this.store = store;
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
        <div class="livetime-status ${connected ? "is-up" : ""}">
          <span class="status-dot"></span>
          <div>
            <div class="livetime-status-title">${connected ? "LiveTime connected" : "Waiting for LiveTime"}</div>
            <div class="livetime-status-sub">${lt.connectedClients} client${lt.connectedClients === 1 ? "" : "s"} · ${lt.detectionsSent} passings sent · channel sync ${lastSync}</div>
          </div>
        </div>
        <ol class="steps">
          <li><span>In LiveTime, add a timing device of type</span><code>ImmersionRC LapRF (8-way)</code></li>
          <li><span>Point it at this computer</span><code>127.0.0.1 : ${port}</code></li>
          <li><span>Load a heat — pilot channels are pushed to every gate automatically.</span></li>
        </ol>
        <p class="note">Only the start gate reports laps to LiveTime. Sector gates feed Pilot insights.</p>
      </div>`;
  }
}
