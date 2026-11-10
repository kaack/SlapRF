import { Component } from "../core/component";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";
import { TimersList } from "../widgets/TimersList";
import { TrackEditor } from "../widgets/TrackEditor";

/** Track page: track timeline editor above the physical discovered timers table. */
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

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Timers</h2>
            <p>Physical XIAO ESP32-C5 timers discovered via the USB Hub (ESP-NOW) or USB, showing their color, flashed ID, online status, role, RF noise floor, and battery health.</p>
          </div>
          <div class="card card-flush" data-slot="timers"></div>
        </section>
      </div>`;

    this.adopt(new TrackEditor(this.slot("track"), store, api));
    this.adopt(new TimersList(this.slot("timers"), store, api));
  }
}
