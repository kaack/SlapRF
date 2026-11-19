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
        <section class="settings-section is-single-col">
          <div class="card card-flush" data-slot="pilots"></div>
        </section>
      </div>`;

    this.adopt(new PilotSlotsEditor(this.slot("pilots"), store, api));
  }
}
