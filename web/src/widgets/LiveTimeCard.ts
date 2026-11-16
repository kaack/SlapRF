import { Component } from "../core/component";
import { LiveTimeRelay, sharedLiveTimeRelay } from "../services/livetime_relay";
import { AppStore } from "../state/store";

/** LapRF TCP :5403 server emulation toggle card on the Settings page (SlapRF Portable). */
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
          <div class="option-title">LapRF emulator</div>
          <div class="option-sub">Exposes SlapRF as a LapRF 8-Way timer on TCP port 5403 so MultiGP LiveTime, FPVTrackside, and other LapRF-compatible software can sync pilot channels, control races, and receive lap passes.</div>
        </div>
        <div class="option-actions">
          <label class="switch switch-lg"><input type="checkbox" data-action="toggle-livetime" ${s.enabled ? "checked" : ""} /><span></span></label>
        </div>
      </div>`;
  }
}
