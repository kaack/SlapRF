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
            <p>Filters out false passes and stray signals. Set rules for all timers, or customize a single timer.</p>
          </div>
          <div class="card card-flush" data-slot="rules"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Announcer</h2>
            <p>Calls out lap times at the start timer using offline voices built into the app and browser.</p>
          </div>
          <div class="settings-cards" data-slot="announcer"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>MultiGP LiveTime</h2>
            <p>Emulates an ImmersionRC LapRF 8-way timer so LiveTime connects without plugins via the slaprf-relay helper.</p>
          </div>
          <div class="card" data-slot="livetime"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Data source</h2>
            <p>Switch between the built-in simulator and physical USB timers.</p>
          </div>
          <div class="settings-cards" data-slot="source"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Persistence</h2>
            <p>Back up, restore, or reset all saved app data in this browser.</p>
          </div>
          <div class="settings-cards" data-slot="persistence"></div>
        </section>
      </div>`;

    this.adopt(new TimingRulesEditor(this.slot("rules"), store, api));
    this.adopt(new AnnouncerSettings(this.slot("announcer"), announcer));
    this.adopt(new LiveTimeCard(this.slot("livetime"), store));
    this.adopt(new DataSourceCard(this.slot("source"), store, api));
    this.adopt(new PersistenceSettings(this.slot("persistence"), api, announcer));
  }
}
