import { Component } from "../core/component";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";
import { PilotSlotsEditor } from "../widgets/PilotSlotsEditor";

/** Pilots page: configure the eight timing slots and Raceband channels. */
export class PilotsView extends Component {
  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);

    el.innerHTML = `
      <div class="settings">
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Pilots &amp; channels</h2>
            <p>Eight timing slots, matching LiveTime. Channels are overwritten whenever LiveTime loads a heat.</p>
          </div>
          <div class="card card-flush" data-slot="pilots"></div>
        </section>
      </div>`;

    this.adopt(new PilotSlotsEditor(this.slot("pilots"), store, api));
  }
}
