import { Component } from "../core/component";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";
import { TrackEditor } from "../widgets/TrackEditor";

/** Track page: interactive course timeline editor. */
export class TrackView extends Component {
  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);

    el.innerHTML = `
      <div class="settings">
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Track</h2>
            <p>Drag timers onto the line in flying order. Each span between timers is a section (S1, S2, S3…). Click the checkered flag under a timer to set the start timer where laps are counted.</p>
          </div>
          <div class="card card-flush" data-slot="track"></div>
        </section>
      </div>`;

    this.adopt(new TrackEditor(this.slot("track"), store, api));
  }
}
