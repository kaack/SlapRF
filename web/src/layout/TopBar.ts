import { Component } from "../core/component";
import { icons } from "../core/icons";
import { Router } from "../core/router";
import { Announcer } from "../services/announcer";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";

export class TopBar extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private readonly router: Router;
  private readonly announcer: Announcer;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient, router: Router, announcer: Announcer) {
    super(el);
    this.store = store;
    this.api = api;
    this.router = router;
    this.announcer = announcer;

    el.addEventListener("click", this.handleClick);
    this.onDispose(() => el.removeEventListener("click", this.handleClick));
    this.onDispose(router.subscribe(() => this.render()));
    this.onDispose(store.subscribe(["status"], () => this.render()));
    this.onDispose(announcer.subscribe(() => this.render()));
    this.render();
  }

  private handleClick = (e: Event): void => {
    switch ((e.target as HTMLElement).closest<HTMLElement>("[data-action]")?.dataset.action) {
      case "announcer":
        this.announcer.update({ enabled: !this.announcer.settings.enabled });
        break;
      case "arm":
        void this.api.toggleArmed();
        break;
      case "pack":
        void this.api.simulatePack();
        break;
      case "reset":
        if (confirm("Clear all laps for this session?")) void this.api.resetSession();
        break;
    }
  };

  private render(): void {
    const meta = this.router.meta();
    const { raceArmed } = this.store;
    const voiceOn = this.announcer.settings.enabled;

    let actions = "";
    if (meta.id === "live") {
      actions = `
        <button class="btn ${voiceOn ? "btn-armed" : "btn-ghost"}" data-action="announcer" title="${voiceOn ? "Mute" : "Enable"} lap-time callouts" aria-label="${voiceOn ? "Mute" : "Enable"} lap-time callouts">
          ${voiceOn ? icons.speaker() : icons.speakerOff()}<span class="topbar-btn-label">Announcer</span>
        </button>
        <button class="btn ${raceArmed ? "btn-armed" : ""}" data-action="arm" title="${raceArmed ? "Pause" : "Resume"} lap timing" aria-label="${raceArmed ? "Pause" : "Resume"} lap timing">
          ${raceArmed ? icons.pause() : icons.play()}<span class="topbar-btn-label">${raceArmed ? "Timing on" : "Timing paused"}</span>
        </button>
        <button class="btn btn-ghost btn-icon" data-action="reset" title="Clear session laps" aria-label="Clear session laps">${icons.reset()}</button>`;
    } else if (meta.id === "pilot") {
      actions = `
        <button class="btn btn-ghost" data-action="reset" title="Clear session laps" aria-label="Clear session laps">
          ${icons.reset()}<span class="topbar-btn-label">Clear laps</span>
        </button>`;
    }

    this.el.innerHTML = `
      <div class="topbar-title">
        <h1>${meta.title}</h1>
        <p>${meta.subtitle}</p>
      </div>
      ${actions ? `<div class="topbar-actions">${actions}</div>` : ""}`;
  }
}
