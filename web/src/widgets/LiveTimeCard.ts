import { Component } from "../core/component";
import { icons } from "../core/icons";
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
          <div class="option-sub">Emulates an ImmersionRC LapRF 8-way timer so MultiGP LiveTime can sync pilot channels, control races, and receive start-timer lap passes via <code>slaprf-relay</code>.</div>
          ${
            s.enabled
              ? `<p class="option-sub livetime-enabled-note">LiveTime is enabled. Go to the <a href="#/livetime" class="link-inline">LiveTime</a> tab for relay status, downloads, and setup instructions.</p>`
              : ""
          }
        </div>
        <div class="option-actions">
          ${
            s.enabled
              ? `<a class="btn btn-sm btn-ghost" href="#/livetime">${icons.timer(14)}<span>Open LiveTime</span>${icons.arrowRight(13)}</a>`
              : ""
          }
          <label class="switch switch-lg"><input type="checkbox" data-action="toggle-livetime" ${s.enabled ? "checked" : ""} /><span></span></label>
        </div>
      </div>`;
  }
}
