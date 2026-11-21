import { Component } from "../core/component";
import { LapRFEmulatorRelay, sharedLapRFEmulatorRelay } from "../services/laprf_emulator_relay";
import { AppStore } from "../state/store";

/** LapRF 8-Way TCP :5403 server emulation toggle card on the Settings page. */
export class LapRFEmulatorCard extends Component {
  private readonly relay: LapRFEmulatorRelay;

  constructor(el: HTMLElement, _store: AppStore, relay: LapRFEmulatorRelay = sharedLapRFEmulatorRelay) {
    super(el);
    this.relay = relay;
    this.listen(el, "change", (e) => {
      const input = (e.target as HTMLElement).closest<HTMLInputElement>("input[data-action='toggle-laprf-emulator']");
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
          <div class="option-title">LapRF 8-Way emulator</div>
          <div class="option-sub">Exposes SlapRF as an ImmersionRC LapRF 8-Way timer on TCP port 5403 so any LapRF-compatible timing client can sync pilot channels, control races, and receive lap passes.</div>
        </div>
        <div class="option-actions">
          <label class="switch switch-lg"><input type="checkbox" data-action="toggle-laprf-emulator" ${s.enabled ? "checked" : ""} /><span></span></label>
        </div>
      </div>`;
  }
}
