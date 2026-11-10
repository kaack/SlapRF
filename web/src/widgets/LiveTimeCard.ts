import { Component } from "../core/component";
import { LiveTimeRelay, sharedLiveTimeRelay } from "../services/livetime_relay";
import { AppStore } from "../state/store";

/** MultiGP LiveTime toggle card on the Settings page. */
export class LiveTimeCard extends Component {
  private readonly relay: LiveTimeRelay;

  constructor(el: HTMLElement, _store: AppStore, relay: LiveTimeRelay = sharedLiveTimeRelay) {
    super(el);
    this.relay = relay;
    this.listen(el, "change", (e) => {
      const input = (e.target as HTMLElement).closest<HTMLInputElement>("input[data-action='toggle-livetime']");
      if (input) this.relay.setEnabled(input.checked);
    });
    this.onDispose(relay.subscribe(() => this.render()));
    this.render();
  }

  private render(): void {
    const s = this.relay.snapshot;

    this.el.innerHTML = `
      <div class="option-row">
        <div>
          <div class="option-title">LiveTime integration</div>
          <div class="option-sub">Emulates an ImmersionRC LapRF 8-way timer so MultiGP LiveTime can sync pilot channels, control races, and receive start-timer lap passes via <code>slaprf-relay</code>.${
            s.enabled ? ` Open the <a href="#/livetime" class="link-inline">LiveTime</a> tab for connection status and setup.` : ""
          }</div>
        </div>
        <label class="switch switch-lg"><input type="checkbox" data-action="toggle-livetime" ${s.enabled ? "checked" : ""} /><span></span></label>
      </div>`;
  }
}
