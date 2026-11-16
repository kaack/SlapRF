import { Component } from "../core/component";
import { Announcer } from "../services/announcer";
import { ApiClient } from "../services/api_client";
import {
  capabilitiesSnapshot,
  isServerDisconnectedLockout,
  subscribeCapabilities,
} from "../services/capabilities";
import { AppStore } from "../state/store";
import { AnnouncerSettings } from "../widgets/AnnouncerSettings";
import {
  AuthenticationSettingsCard,
  DataSourceCard,
  MultiGPSettingsCard,
  PersistenceSettings,
  TimingDevicesCard,
} from "../widgets/DataSourceCard";
import { LiveTimeCard } from "../widgets/LiveTimeCard";
import { TimingRulesEditor } from "../widgets/TimingRulesEditor";

/** Settings page: label/description on the left, controls on the right. */
export class SetupView extends Component {
  private readonly store: AppStore;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient, announcer: Announcer) {
    super(el);
    this.store = store;

    el.innerHTML = `
      <div class="settings">
        <section class="settings-section" data-section-anchor="datasource">
          <div class="settings-intro">
            <h2>Datasource</h2>
            <p>Choose between standalone Demo mode and a SlapRF Server backend, or toggle track simulation.</p>
          </div>
          <div class="settings-cards" data-slot="source"></div>
        </section>

        <section class="settings-section" data-section-anchor="timing-devices">
          <div class="settings-intro">
            <h2>Timing devices</h2>
            <p>Select the timing system used to detect passes on the course.</p>
          </div>
          <div class="settings-cards" data-slot="timing-devices"></div>
        </section>

        <section class="settings-section" data-section-anchor="multigp" data-slot="multigp-section">
          <div class="settings-intro">
            <h2>MultiGP</h2>
            <p>Import chapter races, pull ZippyQ rounds, and push official heat times &amp; podium results directly to MultiGP.</p>
          </div>
          <div class="settings-cards" data-slot="multigp"></div>
        </section>

        <section class="settings-section" data-section-anchor="timing-rules">
          <div class="settings-intro">
            <h2>Timing rules</h2>
            <p>Filters out false passes and stray signals. Set rules for all timers, or customize a single timer.</p>
          </div>
          <div class="card card-flush" data-slot="rules"></div>
        </section>

        <section class="settings-section" data-section-anchor="announcer">
          <div class="settings-intro">
            <h2>Announcer</h2>
            <p>Calls out lap times at the start timer using offline voices built into the app and browser.</p>
          </div>
          <div class="settings-cards" data-slot="announcer"></div>
        </section>

        <section class="settings-section" data-section-anchor="laprf-emulator" data-slot="emulator-section">
          <div class="settings-intro">
            <h2>LapRF emulator</h2>
            <p>Hosts a local TCP :5403 LapRF server in SlapRF Portable so external software like MultiGP LiveTime and FPVTrackside can receive passes from SlapRF hardware.</p>
          </div>
          <div class="card" data-slot="livetime"></div>
        </section>

        <section class="settings-section" data-section-anchor="authentication">
          <div class="settings-intro">
            <h2>Authentication</h2>
            <p>Optionally require a username and password to sign in to this SlapRF instance.</p>
          </div>
          <div class="settings-cards" data-slot="authentication"></div>
        </section>

        <section class="settings-section" data-section-anchor="persistence">
          <div class="settings-intro">
            <h2>Persistence</h2>
            <p>Back up, restore, or reset all saved app data in this browser.</p>
          </div>
          <div class="settings-cards" data-slot="persistence"></div>
        </section>
      </div>`;

    this.adopt(new DataSourceCard(this.slot("source"), store, api));
    this.adopt(new TimingDevicesCard(this.slot("timing-devices"), store, api));
    this.adopt(new MultiGPSettingsCard(this.slot("multigp"), store, api));
    this.adopt(new TimingRulesEditor(this.slot("rules"), store, api));
    this.adopt(new AnnouncerSettings(this.slot("announcer"), announcer));
    this.adopt(new LiveTimeCard(this.slot("livetime"), store));
    this.adopt(new AuthenticationSettingsCard(this.slot("authentication")));
    this.adopt(new PersistenceSettings(this.slot("persistence"), api, announcer));

    this.onDispose(store.subscribe(["status", "config"], () => this.syncVisibility()));
    this.onDispose(subscribeCapabilities(() => this.syncVisibility()));
    this.syncVisibility();
  }

  private syncVisibility(): void {
    const caps = capabilitiesSnapshot();
    const lockedOut = isServerDisconnectedLockout();
    const sim = lockedOut ? false : this.store.simulatorRunning;
    const isLapRF = this.store.timingHardwareMode === "laprf";

    const mgpSec = this.el.querySelector<HTMLElement>('[data-slot="multigp-section"]');
    if (mgpSec) {
      mgpSec.style.display = sim || caps.portable || lockedOut ? "" : "none";
    }
    const emuSec = this.el.querySelector<HTMLElement>('[data-slot="emulator-section"]');
    if (emuSec) {
      emuSec.style.display = caps.portable && !isLapRF ? "" : "none";
    }

    this.el.querySelectorAll<HTMLElement>(".settings-section").forEach((sec) => {
      if (sec.dataset.sectionAnchor === "datasource") return;
      sec.classList.toggle("is-server-locked", lockedOut);
      (sec as HTMLElement & { inert?: boolean }).inert = lockedOut;
      if (lockedOut) {
        sec.setAttribute("aria-disabled", "true");
      } else {
        sec.removeAttribute("aria-disabled");
      }
    });
  }
}
