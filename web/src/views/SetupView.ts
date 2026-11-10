import { Component } from "../core/component";
import { Announcer } from "../services/announcer";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";
import { AnnouncerSettings } from "../widgets/AnnouncerSettings";
import { DataSourceCard, PersistenceSettings } from "../widgets/DataSourceCard";
import { LiveTimeCard } from "../widgets/LiveTimeCard";
import { TimingRulesEditor } from "../widgets/TimingRulesEditor";

/** Settings page: label/description on the left, controls on the right. */
export class SetupView extends Component {
  constructor(el: HTMLElement, store: AppStore, api: ApiClient, announcer: Announcer) {
    super(el);

    el.innerHTML = `
      <div class="settings">
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Timing rules</h2>
            <p>Filters out false passes and stray signals. Set rules for all gates, or pick a single gate to customize it.</p>
          </div>
          <div class="card card-flush" data-slot="rules"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Announcer</h2>
            <p>Spoken lap times at the start gate. Uses the voices built into this computer — no internet needed.</p>
          </div>
          <div class="settings-cards" data-slot="announcer"></div>
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
            <h2>Data source</h2>
            <p>Switch between physical XIAO gate timers and the built-in simulator, or connect directly from the browser to your Hub over USB-C.</p>
          </div>
          <div class="settings-cards" data-slot="source"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Persistence</h2>
            <p>Export or import a full JSON snapshot of all application state, or wipe saved data back to clean system defaults.</p>
          </div>
          <div class="settings-cards" data-slot="persistence"></div>
        </section>
      </div>`;

    this.adopt(new TimingRulesEditor(this.slot("rules"), store, api));
    this.adopt(new AnnouncerSettings(this.slot("announcer"), announcer));
    this.adopt(new LiveTimeCard(this.slot("livetime"), store, api));
    this.adopt(new DataSourceCard(this.slot("source"), store, api));
    this.adopt(new PersistenceSettings(this.slot("persistence"), api, announcer));
  }
}
