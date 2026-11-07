import { Component } from "../core/component";
import { Announcer } from "../services/announcer";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";
import { AnnouncerSettings } from "../widgets/AnnouncerSettings";
import { DataSourceCard } from "../widgets/DataSourceCard";
import { LiveTimeCard } from "../widgets/LiveTimeCard";
import { PilotSlotsEditor } from "../widgets/PilotSlotsEditor";
import { TimerFlasher } from "../widgets/TimerFlasher";
import { TimersList } from "../widgets/TimersList";
import { TimingRulesEditor } from "../widgets/TimingRulesEditor";
import { TrackEditor } from "../widgets/TrackEditor";

/** Settings page: label/description on the left, controls on the right. */
export class SetupView extends Component {
  constructor(el: HTMLElement, store: AppStore, api: ApiClient, announcer: Announcer) {
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

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Timing rules</h2>
            <p>Guardrails for real-world video-signal detection. Set them for all gates, then pick a gate to override any rule just there — where a timer sits on the track can call for different values. Rejected passes show on each pilot's signal chart in Live.</p>
          </div>
          <div class="card card-flush" data-slot="rules"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Announcer</h2>
            <p>Spoken lap times at the start gate. Uses the voices built into this computer — no internet needed.</p>
          </div>
          <div class="card" data-slot="announcer"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>MultiGP LiveTime</h2>
            <p>This app emulates an ImmersionRC LapRF 8-way timer, so LiveTime connects without plugins.</p>
          </div>
          <div class="card" data-slot="livetime"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Flasher</h2>
            <p>Plug each Seeed XIAO ESP32-C5 into this computer over USB and flash or read it directly from the browser — no compiler, drivers, or command line needed.</p>
          </div>
          <div class="card" data-slot="flasher"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Timers</h2>
            <p>Physical XIAO ESP32-C5 timers discovered over Wi-Fi / ESP-NOW or USB, showing their color, flashed ID, online status, role, RF noise floor, and battery health.</p>
          </div>
          <div class="card card-flush" data-slot="timers"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Track</h2>
            <p>Drag timers onto the track timeline in the order pilots fly them. Each stretch between two timers defines a section (S1, S2, S3…), and clicking a node lets you name the gate or mark it as the start gate.</p>
          </div>
          <div class="card card-flush" data-slot="track"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Data source</h2>
            <p>Use the simulator to rehearse a race day before the hardware arrives.</p>
          </div>
          <div class="card" data-slot="source"></div>
        </section>
      </div>`;

    this.adopt(new PilotSlotsEditor(this.slot("pilots"), store, api));
    this.adopt(new TimingRulesEditor(this.slot("rules"), store, api));
    this.adopt(new AnnouncerSettings(this.slot("announcer"), announcer));
    this.adopt(new LiveTimeCard(this.slot("livetime"), store));
    this.adopt(new TimerFlasher(this.slot("flasher"), store, api));
    this.adopt(new TimersList(this.slot("timers"), store, api));
    this.adopt(new TrackEditor(this.slot("track"), store, api));
    this.adopt(new DataSourceCard(this.slot("source"), store, api));
  }
}
