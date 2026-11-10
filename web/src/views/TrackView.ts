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
            <p>Drag timers onto the track timeline in the order pilots fly them. Each stretch between two timers defines a section (S1, S2, S3…), and clicking a node lets you name the gate or mark it as the start gate.</p>
          </div>
          <div class="card card-flush" data-slot="track"></div>
        </section>
      </div>`;

    this.adopt(new TrackEditor(this.slot("track"), store, api));
  }
}
