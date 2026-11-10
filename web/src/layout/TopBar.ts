import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ROUTES, Router } from "../core/router";
import { Announcer } from "../services/announcer";
import { ApiClient } from "../services/api_client";
import { sharedTimerConsole, TimerConsole } from "../services/timer_console";
import { AppStore } from "../state/store";

export class TopBar extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private readonly router: Router;
  private readonly announcer: Announcer;
  private lastSig = "";
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
    });
    this.onDispose(
      router.subscribe(() => {
        this.menuOpen = false;
        this.render();
      })
    );
    this.onDispose(store.subscribe(["status"], () => this.render()));
    this.onDispose(announcer.subscribe(() => this.render()));
    this.onDispose(sharedTimerConsole.onStateChange(() => this.render()));
    this.onDispose(
      sharedTimerConsole.subscribe({
        onConnect: () => this.render(),
        onStatus: () => this.render(),
        onDisconnect: () => this.render(),
      })
    );
    this.onDispose(api.hubBridge.subscribe(() => this.render()));
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
      case "usb-toggle":
        if (sharedTimerConsole.busyLabel) return;
        if (sharedTimerConsole.connected) {
          void sharedTimerConsole.disconnectCleanly();
        } else {
          void sharedTimerConsole.connectAndStart().catch(() => undefined);
        }
        break;
      case "go-network":
        this.router.navigate("network");
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
    }
  };

  private render(): void {
    const meta = this.router.meta();
    const { liveTime, raceArmed, simulatorRunning: sim } = this.store;
    const ltConnected = liveTime.connectedClients > 0;
    const voiceOn = this.announcer.settings.enabled;
    const usbOn = sharedTimerConsole.connected;
    const usbLabel = sharedTimerConsole.lastStatus?.label ?? "";
    const usbFp = sharedTimerConsole.lastStatus?.fp ?? "";
    const usbBusy = sharedTimerConsole.busyLabel ?? "";
    const led = this.api.hubBridge.getLedSummary();
    const sig = `${meta.id}:${sim ? 1 : 0}:${raceArmed ? 1 : 0}:${voiceOn ? 1 : 0}:${ltConnected ? 1 : 0}:${this.menuOpen ? 1 : 0}:${usbOn ? 1 : 0}:${usbLabel}:${usbBusy}:${led.color}:${led.shortLabel}:${led.detail}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    const simBtn = `
      <button class="btn ${sim ? "btn-armed" : "btn-ghost"}" data-action="sim" title="${sim ? "Switch to real-world hardware dataset" : "Switch to simulated track dataset"}" aria-label="${sim ? "Switch to real-world hardware dataset" : "Switch to simulated track dataset"}">
        ${sim ? icons.zap(19) : icons.zapOff(19)}<span class="topbar-btn-label">${sim ? "Simulation on" : "Simulation off"}</span>
      </button>`;

    const usbSupported = TimerConsole.supported();
    const usbBtnText = usbOn
      ? usbLabel
        ? `Connected · ${esc(usbLabel)}`
        : "Connected"
      : usbBusy
        ? `${esc(usbBusy)}…`
        : "Connect";
    const usbTitle = !usbSupported
      ? "USB connection requires Chrome, Edge, or Brave (WebSerial)"
      : usbOn
        ? `Connected over USB${usbLabel || usbFp ? ` (${usbLabel || "timer"}${usbFp ? ` · ${usbFp}` : ""})` : ""} — click to disconnect`
        : "Connect a timer over USB-C";
    const usbBtn = `
      <button type="button" class="btn ${usbOn ? "btn-armed" : "btn-ghost"}" data-action="usb-toggle" ${usbSupported && !usbBusy ? "" : "disabled"} title="${esc(usbTitle)}" aria-label="${esc(usbTitle)}">
        ${usbOn ? icons.plug(19) : icons.plugOff(19)}<span class="topbar-btn-label">${usbBtnText}</span>
      </button>`;

    const ledIndicator = `
      <button type="button" class="topbar-conn-led is-${led.color}" data-action="go-network" title="${esc(led.detail)}" aria-label="${esc(led.detail)}">
        <span class="topbar-conn-led-bulb" aria-hidden="true"></span>
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
        </button>`;
    }

    const navItems = ROUTES.filter((r) => !r.simOnly || sim)
      .map((r) => {
        const active = r.id === meta.id;
        return `<a class="nav-item ${active ? "is-active" : ""}" href="#/${r.id}" data-nav-item="${r.id}" ${active ? 'aria-current="page"' : ""}>${r.icon()}<span>${r.label}</span></a>`;
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
                  <div class="brand">
                    <div class="brand-mark">${icons.slaprf(25)}</div>
                    <div>
                      <div class="brand-name">SlapRF</div>
                      <div class="brand-sub">XIAO ESP32-C5 · 5.8 GHz</div>
                    </div>
                  </div>
                  <nav class="nav">${navItems}</nav>
                </div>`
              : ""
          }
        </div>
        <div class="topbar-title">
          <h1>${meta.title}</h1>
          <p>${meta.subtitle}</p>
        </div>
      </div>
      <div class="topbar-actions">
        ${actions}
        ${usbBtn}
        ${ledIndicator}
      </div>`;
  }
}
