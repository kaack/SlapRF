import { Component } from "../core/component";
import { icons } from "../core/icons";
import { ROUTES, Router } from "../core/router";
import { Announcer } from "../services/announcer";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";

export class TopBar extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private readonly router: Router;
  private readonly announcer: Announcer;
  private lastSig = "";
  private resetFlashActive = false;
  private resetFlashTimer: number | null = null;
  private menuOpen = false;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient, router: Router, announcer: Announcer) {
    super(el);
    this.store = store;
    this.api = api;
    this.router = router;
    this.announcer = announcer;

    el.addEventListener("click", this.handleClick);
    document.addEventListener("pointerdown", this.handleOutsidePointer, true);
    document.addEventListener("keydown", this.handleKeyDown);
    this.onDispose(() => {
      el.removeEventListener("click", this.handleClick);
      document.removeEventListener("pointerdown", this.handleOutsidePointer, true);
      document.removeEventListener("keydown", this.handleKeyDown);
      if (this.resetFlashTimer !== null) {
        window.clearTimeout(this.resetFlashTimer);
      }
    });
    this.onDispose(
      router.subscribe(() => {
        this.menuOpen = false;
        this.render();
      })
    );
    this.onDispose(store.subscribe(["status"], () => this.render()));
    this.onDispose(announcer.subscribe(() => this.render()));
    this.render();
  }

  private handleOutsidePointer = (e: PointerEvent): void => {
    if (!this.menuOpen) return;
    const t = e.target as Node | null;
    if (t && this.el.contains(t)) return;
    this.menuOpen = false;
    this.render();
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.menuOpen) {
      this.menuOpen = false;
      this.render();
    }
  };

  private handleClick = (e: Event): void => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-nav-item]")) {
      this.menuOpen = false;
      this.render();
      return;
    }

    switch (target.closest<HTMLElement>("[data-action]")?.dataset.action) {
      case "menu":
        this.menuOpen = !this.menuOpen;
        this.render();
        break;
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
        if (confirm("Clear all laps for this session?")) {
          this.flashResetButton();
          void this.api.resetSession();
        }
        break;
    }
  };

  private flashResetButton(): void {
    this.resetFlashActive = true;
    this.render();
    if (this.resetFlashTimer !== null) {
      window.clearTimeout(this.resetFlashTimer);
    }
    this.resetFlashTimer = window.setTimeout(() => {
      this.resetFlashTimer = null;
      this.resetFlashActive = false;
      this.render();
    }, 350);
  }

  private render(): void {
    const meta = this.router.meta();
    const { liveTime, raceArmed, simulatorRunning: sim } = this.store;
    const ltConnected = liveTime.connectedClients > 0;
    const voiceOn = this.announcer.settings.enabled;
    const sig = `${meta.id}:${sim ? 1 : 0}:${raceArmed ? 1 : 0}:${voiceOn ? 1 : 0}:${ltConnected ? 1 : 0}:${this.resetFlashActive ? 1 : 0}:${this.menuOpen ? 1 : 0}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    const simBtn = `
      <button class="btn ${sim ? "btn-armed" : "btn-ghost"}" data-action="sim" title="${sim ? "Switch to real-world hardware dataset" : "Switch to simulated track dataset"}" aria-label="${sim ? "Switch to real-world hardware dataset" : "Switch to simulated track dataset"}">
        ${sim ? icons.zap(19) : icons.zapOff(19)}<span class="topbar-btn-label">${sim ? "Simulation on" : "Simulation off"}</span>
      </button>`;
    const resetBtn = `
      <button class="btn ${this.resetFlashActive ? "btn-armed" : "btn-ghost"}" data-action="reset" title="Clear session laps" aria-label="Clear session laps">
        ${icons.reset(19)}<span class="topbar-btn-label">Reset laps</span>
      </button>`;

    let actions = simBtn;
    if (meta.id === "live" || meta.id === "sim") {
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
        ${resetBtn}`;
    } else if (meta.id === "pilot") {
      actions += resetBtn;
    }

    const navItems = ROUTES.filter((r) => !r.simOnly || sim)
      .map((r) => {
        const active = r.id === meta.id;
        return `<a class="topbar-nav-item ${active ? "is-active" : ""}" href="#/${r.id}" data-nav-item="${r.id}" ${active ? 'aria-current="page"' : ""}>
          <span class="topbar-nav-icon">${r.icon(17)}</span>
          <span class="topbar-nav-text">
            <span class="topbar-nav-label">${r.label}</span>
            <span class="topbar-nav-sub">${r.subtitle}</span>
          </span>
        </a>`;
      })
      .join("");

    this.el.innerHTML = `
      <div class="topbar-left">
        <div class="topbar-menu-wrap">
          <button class="btn btn-ghost topbar-menu-btn ${this.menuOpen ? "is-open" : ""}" data-action="menu" type="button" aria-label="Open navigation menu" aria-expanded="${this.menuOpen ? "true" : "false"}">
            ${this.menuOpen ? icons.close(20) : icons.menu(20)}
          </button>
          ${
            this.menuOpen
              ? `<div class="topbar-nav-popover" role="menu" aria-label="Main navigation">
                  <div class="topbar-nav-brand">
                    <span class="brand-mark">${icons.slaprf(20)}</span>
                    <div>
                      <div class="brand-name">SlapRF</div>
                      <div class="brand-sub">XIAO ESP32-C5 · 5.8 GHz</div>
                    </div>
                  </div>
                  <div class="topbar-nav-list">${navItems}</div>
                </div>`
              : ""
          }
        </div>
        <div class="topbar-title">
          <h1>${meta.title}</h1>
          <p>${meta.subtitle}</p>
        </div>
      </div>
      <div class="topbar-actions">${actions}</div>`;
  }
}
