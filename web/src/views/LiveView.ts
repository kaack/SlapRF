import { Component } from "../core/component";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";
import { PilotPicker } from "../widgets/PilotPicker";
import { AllPilotsPanel } from "./live/AllPilotsPanel";
import { PilotPanel } from "./live/PilotPanel";

/** Practice track: one page, with an All | pilot selector that swaps the panel below it. */
export class LiveView extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private panel: Component | null = null;
  private shownFocus: number | null | undefined = undefined;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;

    el.innerHTML = `
      <div class="picker-row">
        <div data-slot="picker"></div>
      </div>
      <div class="view-stack" data-slot="panel"></div>`;

    this.adopt(
      new PilotPicker(this.slot("picker"), store, {
        includeAll: true,
        value: () => store.liveFocus,
        onSelect: (slot) => store.setLiveFocus(slot),
      })
    );

    this.onDispose(() => this.panel?.destroy());
    this.onDispose(store.subscribe(["selection", "config"], () => this.showPanel()));
    this.showPanel();
  }

  private showPanel(): void {
    const focus = this.store.liveFocus;
    // Switching between pilots keeps the same panel (it re-renders from the store);
    // only rebuild when moving between "All" and a single pilot.
    const mode = focus === null ? null : 0;
    const shownMode = this.shownFocus === undefined ? undefined : this.shownFocus === null ? null : 0;
    this.shownFocus = focus;
    if (mode === shownMode) return;

    this.panel?.destroy();
    const host = this.slot("panel");
    this.panel =
      focus === null
        ? new AllPilotsPanel(host, this.store, this.api, (slot) => this.store.setLiveFocus(slot))
        : new PilotPanel(host, this.store, this.api);
  }
}
