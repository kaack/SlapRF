import { Component } from "../core/component";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";
import { TimerFlasher } from "../widgets/TimerFlasher";

/** Flasher page: flash or read Seeed XIAO ESP32-C5 timers over USB (WebSerial). */
export class FlasherView extends Component {
  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);

    el.innerHTML = `
      <div class="settings">
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Flasher</h2>
            <p>Plug each Seeed XIAO ESP32-C5 into this computer over USB and flash or read it directly from the browser — no compiler, drivers, or command line needed.</p>
          </div>
          <div class="card" data-slot="flasher"></div>
        </section>
      </div>`;

    this.adopt(new TimerFlasher(this.slot("flasher"), store, api));
  }
}
