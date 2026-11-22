import { Component } from "../core/component";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";
import { TimingRulesEditor } from "./TimingRulesEditor";
import { TrackEditor } from "./TrackEditor";

export interface ScopedTrackWorkspaceOptions {
  contextLabel?: "practice" | "race";
  readOnly?: () => boolean;
}

/**
 * Per-Practice / per-Race Track & Timing Rules workspace embedded inside
 * `PracticeView` (`Track` tab) and `RacesView` (`Track` tab).
 */
export class ScopedTrackWorkspace extends Component {
  constructor(
    el: HTMLElement,
    scopedStore: AppStore,
    scopedApi: ApiClient,
    opts: ScopedTrackWorkspaceOptions = {}
  ) {
    super(el);
    const kindLabel = opts.contextLabel === "race" ? "race" : "practice session";

    el.innerHTML = `
      <div class="settings scoped-track-workspace">
        <section class="settings-section" data-section-anchor="track">
          <div class="settings-intro">
            <h2>Track</h2>
            <p>Drag timers onto the line in flying order for this ${kindLabel}. Each span between timers is a section (S1, S2, S3…). Click the checkered flag under a timer to set the start timer where laps are counted.</p>
          </div>
          <div class="card card-flush" data-slot="track"></div>
        </section>

        <section class="settings-section" data-section-anchor="timing-rules">
          <div class="settings-intro">
            <h2>Timing rules</h2>
            <p>Filters out false passes and stray signals for this ${kindLabel}. Set rules for all timers on this track, or customize a single timer.</p>
          </div>
          <div class="card card-flush" data-slot="rules"></div>
        </section>
      </div>`;

    this.adopt(new TrackEditor(this.slot("track"), scopedStore, scopedApi, { readOnly: opts.readOnly }));
    this.adopt(
      new TimingRulesEditor(this.slot("rules"), scopedStore, scopedApi, { readOnly: opts.readOnly })
    );
  }
}
