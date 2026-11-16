import { Component } from "../core/component";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";
import { PilotSlotsEditor } from "../widgets/PilotSlotsEditor";

/** Global Pilots directory page. */
export class PilotsView extends Component {
  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);

    el.innerHTML = `
      <div class="settings">
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Pilots</h2>
            <p>Master directory of known pilots, phonetic callouts, default 5.8 GHz channels, and RF calibration thresholds (up to 32 pilots). Assign pilots to <a class="inline-link" href="#/live">Practice</a> sessions or <a class="inline-link" href="#/races">Races</a>.</p>
          </div>
          <div class="card card-flush" data-slot="pilots"></div>
        </section>
      </div>`;

    this.adopt(new PilotSlotsEditor(this.slot("pilots"), store, api));
  }
}
