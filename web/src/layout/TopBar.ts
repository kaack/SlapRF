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
    const { liveTime, raceArmed, simulatorRunning } = this.store;
    const ltUp = liveTime.connectedClients > 0;
    const voiceOn = this.announcer.settings.enabled;

    this.el.innerHTML = `
      <div class="topbar-title">
        <h1>${meta.title}</h1>
        <p>${meta.subtitle}</p>
      </div>
      <div class="topbar-actions">
        <button class="btn ${voiceOn ? "btn-armed" : "btn-ghost"}" data-action="announcer" title="${voiceOn ? "Mute" : "Enable"} lap-time callouts">
          ${voiceOn ? icons.speaker() : icons.speakerOff()}<span>Announcer</span>
        </button>
        <span class="pill ${ltUp ? "is-up" : ""}" title="${ltUp ? "LiveTime is connected and can arm / pause timing" : `Waiting for LiveTime on TCP ${liveTime.listenAddr}`}">
          <span class="status-dot ${ltUp ? "is-up" : ""}"></span>${ltUp ? "LiveTime connected" : "LiveTime idle"}
        </span>
        ${simulatorRunning ? `<button class="btn btn-ghost" data-action="pack" title="Bunch all pilots up before the start gate">${icons.zap()}<span>Simulate pack</span></button>` : ""}
        <button class="btn ${raceArmed ? "btn-armed" : ""}" data-action="arm" title="${raceArmed ? "Pause" : "Resume"} lap timing">
          ${raceArmed ? icons.pause() : icons.play()}<span>${raceArmed ? "Timing on" : "Timing paused"}</span>
        </button>
        <button class="btn btn-ghost btn-icon" data-action="reset" title="Clear session laps" aria-label="Clear session laps">${icons.reset()}</button>
      </div>`;
  }
}
