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

    el.innerHTML = `
      <div class="scoped-track-workspace">
        <div class="card card-flush" data-slot="track" data-section-anchor="track"></div>
        <div class="card card-flush" data-slot="rules" data-section-anchor="timing-rules"></div>
      </div>`;

    this.adopt(new TrackEditor(this.slot("track"), scopedStore, scopedApi, { readOnly: opts.readOnly }));
    this.adopt(
      new TimingRulesEditor(this.slot("rules"), scopedStore, scopedApi, { readOnly: opts.readOnly })
    );
  }
}
