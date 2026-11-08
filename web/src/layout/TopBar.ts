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
  private lastSig = "";

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
      case "sim":
        void this.api.toggleSimulator();
        break;
      case "announcer":
        this.announcer.update({ enabled: !this.announcer.settings.enabled });
        break;
      case "arm":
        if (this.store.liveTime.connectedClients > 0) return;
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
    const { liveTime, raceArmed, simulatorRunning: sim } = this.store;
    const ltConnected = liveTime.connectedClients > 0;
    const voiceOn = this.announcer.settings.enabled;
    const sig = `${meta.id}:${sim ? 1 : 0}:${raceArmed ? 1 : 0}:${voiceOn ? 1 : 0}:${ltConnected ? 1 : 0}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    const simBtn = `
      <button class="btn ${sim ? "btn-armed" : "btn-ghost"}" data-action="sim" title="${sim ? "Switch to real-world hardware dataset" : "Switch to simulated track dataset"}" aria-label="${sim ? "Switch to real-world hardware dataset" : "Switch to simulated track dataset"}">
        ${sim ? icons.zap(19) : icons.zapOff(19)}<span class="topbar-btn-label">${sim ? "Simulation on" : "Simulation off"}</span>
      </button>`;

    let actions = simBtn;
    if (meta.id === "live") {
      const armTitle = ltConnected
        ? `Timing is controlled by MultiGP LiveTime (${raceArmed ? "currently armed" : "currently disarmed"})`
        : `${raceArmed ? "Pause" : "Resume"} lap timing`;
      actions += `
        <button class="btn ${voiceOn ? "btn-armed" : "btn-ghost"}" data-action="announcer" title="${voiceOn ? "Mute" : "Enable"} lap-time callouts" aria-label="${voiceOn ? "Mute" : "Enable"} lap-time callouts">
          ${voiceOn ? icons.speaker(19) : icons.speakerOff(19)}<span class="topbar-btn-label">Announcer</span>
        </button>
        <button class="btn ${raceArmed ? "btn-armed" : "btn-ghost"}" data-action="arm" ${ltConnected ? "disabled" : ""} title="${armTitle}" aria-label="${armTitle}">
          ${raceArmed ? icons.timer(19) : icons.timerOff(19)}<span class="topbar-btn-label">${raceArmed ? "Timing on" : "Timing off"}</span>
        </button>
        <button class="btn btn-ghost btn-icon" data-action="reset" title="Clear session laps" aria-label="Clear session laps">${icons.reset(19)}</button>`;
    } else if (meta.id === "pilot") {
      actions += `
        <button class="btn btn-ghost" data-action="reset" title="Clear session laps" aria-label="Clear session laps">
          ${icons.reset(19)}<span class="topbar-btn-label">Clear laps</span>
        </button>`;
    }

    this.el.innerHTML = `
      <div class="topbar-title">
        <h1>${meta.title}</h1>
        <p>${meta.subtitle}</p>
      </div>
      <div class="topbar-actions">${actions}</div>`;
  }
}
