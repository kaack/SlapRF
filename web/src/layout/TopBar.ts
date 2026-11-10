import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ROUTES, Router } from "../core/router";
import { Announcer } from "../services/announcer";
import { ApiClient } from "../services/api_client";
import { MAX_USB_CONNECTIONS, TimerConsole, usbPool } from "../services/timer_console";
import { AppStore } from "../state/store";

export class TopBar extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private readonly router: Router;
  private readonly announcer: Announcer;
  private lastSig = "";
  private menuOpen = false;
  private usbMenuOpen = false;

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
        this.usbMenuOpen = false;
        this.render();
      })
    );
    this.onDispose(store.subscribe(["status"], () => this.render()));
    this.onDispose(announcer.subscribe(() => this.render()));
    this.onDispose(
      usbPool.onChange(() => {
        if (usbPool.connectedConsoles().length === 0) {
          this.usbMenuOpen = false;
        }
        this.render();
      })
    );
    this.onDispose(api.hubBridge.subscribe(() => this.render()));
    this.render();
  }

  private handleOutsidePointer = (e: PointerEvent): void => {
    if (!this.menuOpen && !this.usbMenuOpen) return;
    const t = e.target as Node | null;
    if (this.menuOpen) {
      const menuWrap = this.el.querySelector(".topbar-menu-wrap");
      if (!t || !menuWrap?.contains(t)) {
        this.menuOpen = false;
      }
    }
    if (this.usbMenuOpen) {
      const usbWrap = this.el.querySelector(".topbar-usb-wrap");
      if (!t || !usbWrap?.contains(t)) {
        this.usbMenuOpen = false;
      }
    }
    this.render();
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && (this.menuOpen || this.usbMenuOpen)) {
      this.menuOpen = false;
      this.usbMenuOpen = false;
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

    const actionEl = target.closest<HTMLElement>("[data-action]");
    switch (actionEl?.dataset.action) {
      case "menu":
        this.menuOpen = !this.menuOpen;
        this.usbMenuOpen = false;
        this.render();
        break;
      case "sim":
        void this.api.toggleSimulator();
        break;
      case "usb-toggle": {
        const busySlot = usbPool.slots.find((c) => c.busyLabel);
        if (busySlot) return;
        const connected = usbPool.connectedConsoles();
        if (connected.length > 0) {
          this.usbMenuOpen = !this.usbMenuOpen;
          this.menuOpen = false;
          this.render();
        } else {
          this.usbMenuOpen = false;
          void usbPool.connectNew().catch(() => undefined);
        }
        break;
      }
      case "usb-select-slot": {
        const idx = Number(actionEl.dataset.usbSlot);
        if (Number.isFinite(idx)) {
          usbPool.selectDebugSlot(idx);
          this.usbMenuOpen = false;
          this.render();
        }
        break;
      }
      case "usb-disconnect-slot": {
        const idx = Number(actionEl.dataset.usbSlot);
        if (Number.isFinite(idx) && usbPool.slots[idx]) {
          void usbPool.slots[idx].disconnectCleanly();
        }
        break;
      }
      case "usb-connect-add": {
        this.usbMenuOpen = false;
        this.render();
        void usbPool.connectNew().catch(() => undefined);
        break;
      }
      case "usb-disconnect-all": {
        this.usbMenuOpen = false;
        this.render();
        void usbPool.disconnectAllCleanly();
        break;
      }
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
    const connectedUsb = usbPool.connectedConsoles();
    const usbOn = connectedUsb.length > 0;
    const activeConsole = usbPool.debugConsole;
    const activeLabel = activeConsole.connected
      ? activeConsole.isOtherDevice
        ? "Other"
        : activeConsole.lastStatus?.label ||
          activeConsole.lastConfig?.timerLabel ||
          (activeConsole.lastStatus?.role === 1 ? "H1" : `USB ${activeConsole.slotIndex + 1}`)
      : "";
    const usbLabels = connectedUsb
      .map((c) =>
        c.isOtherDevice
          ? "Other"
          : c.lastStatus?.label || c.lastConfig?.timerLabel || (c.lastStatus?.role === 1 ? "H1" : `USB ${c.slotIndex + 1}`)
      )
      .join(" + ");
    const usbFps = connectedUsb.map((c) => c.lastStatus?.fp || "").filter(Boolean).join(", ");
    const usbBusy = usbPool.slots.find((c) => c.busyLabel)?.busyLabel ?? "";
    const led = this.api.hubBridge.getLedSummary();
    const sig = `${meta.id}:${sim ? 1 : 0}:${raceArmed ? 1 : 0}:${voiceOn ? 1 : 0}:${ltConnected ? 1 : 0}:${this.menuOpen ? 1 : 0}:${this.usbMenuOpen ? 1 : 0}:${connectedUsb.length}:${activeConsole.slotIndex}:${activeLabel}:${usbLabels}:${usbBusy}:${led.color}:${led.shortLabel}:${led.detail}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    const simBtn = `
      <button class="btn ${sim ? "btn-armed" : "btn-ghost"}" data-action="sim" title="${sim ? "Switch to real-world hardware dataset" : "Switch to simulated track dataset"}" aria-label="${sim ? "Switch to real-world hardware dataset" : "Switch to simulated track dataset"}">
        ${sim ? icons.zap(19) : icons.zapOff(19)}<span class="topbar-btn-label">${sim ? "Simulation on" : "Simulation off"}</span>
      </button>`;

    const usbSupported = TimerConsole.supported();
    const usbBtnText = usbOn
      ? activeLabel
        ? connectedUsb.length > 1
          ? `Connected · ${esc(activeLabel)} (${connectedUsb.length}/${MAX_USB_CONNECTIONS})`
          : `Connected · ${esc(activeLabel)}`
        : "Connected"
      : usbBusy
        ? `${esc(usbBusy)}…`
        : "Connect";
    const usbTitle = !usbSupported
      ? "USB connection requires Chrome, Edge, or Brave (WebSerial)"
      : usbOn
        ? `Connected over USB (${connectedUsb.length}/${MAX_USB_CONNECTIONS}${usbLabels ? `: ${usbLabels}` : ""}${usbFps ? ` · ${usbFps}` : ""}) — click to switch or disconnect`
        : "Connect a timer over USB-C";

    const usbMenuRowsHtml = connectedUsb
      .map((c) => {
        const s = c.lastStatus;
        const cfg = c.lastConfig;
        const isActive = c === activeConsole;
        const isOther = c.isOtherDevice;
        const isSpoke = s ? s.role === 2 : cfg?.role === "spoke";
        const label = isOther
          ? "Other"
          : s?.label || cfg?.timerLabel || (s?.role === 1 || cfg?.role === "hub" ? "H1" : `USB ${c.slotIndex + 1}`);
        const roleMeta = s
          ? s.emergencyMode
            ? "Emergency"
            : s.role === 1
              ? "Hub"
              : `Spoke${s.slot ? ` · slot ${s.slot}` : ""}`
          : cfg
            ? cfg.role === "hub"
              ? "Hub"
              : "Spoke"
            : isOther
              ? `USB ${c.slotIndex + 1}`
              : "Reading…";
        const fp = s?.fp || cfg?.fingerprint || "";
        const dotClass = s?.emergencyMode || isOther ? "is-emergency" : isSpoke ? "is-spoke" : "is-up";
        return `
          <div class="topbar-usb-item ${isActive ? "is-active" : ""}">
            <button
              type="button"
              class="topbar-usb-select"
              data-action="usb-select-slot"
              data-usb-slot="${c.slotIndex}"
              title="Switch active USB connection to ${esc(label)}"
            >
              <span class="status-dot ${dotClass}"></span>
              <span class="topbar-usb-item-main">
                <span class="topbar-usb-item-name">${esc(label)} <span class="note">· ${esc(roleMeta)}</span></span>
                ${fp ? `<span class="topbar-usb-item-fp mono">${esc(fp)}</span>` : ""}
              </span>
              ${isActive ? `<span class="badge badge-good">Active</span>` : ""}
            </button>
            <button
              type="button"
              class="btn btn-sm btn-icon btn-ghost topbar-usb-item-disc"
              data-action="usb-disconnect-slot"
              data-usb-slot="${c.slotIndex}"
              title="Disconnect ${esc(label)}"
              aria-label="Disconnect ${esc(label)}"
            >${icons.plugOff(15)}</button>
          </div>`;
      })
      .join("");

    const canAddMoreUsb = connectedUsb.length < MAX_USB_CONNECTIONS;
    const usbPopoverHtml =
      usbOn && this.usbMenuOpen
        ? `<div class="topbar-usb-popover" role="menu" aria-label="USB connections">
            <div class="topbar-usb-head">
              <span>USB connections</span>
              <span class="mono">${connectedUsb.length}/${MAX_USB_CONNECTIONS}</span>
            </div>
            <div class="topbar-usb-list">
              ${usbMenuRowsHtml}
            </div>
            ${
              canAddMoreUsb
                ? `<div class="topbar-usb-foot">
                    <button type="button" class="btn btn-sm btn-ghost topbar-usb-foot-btn" data-action="usb-connect-add" ${usbBusy ? "disabled" : ""}>
                      ${icons.plug(16)}<span>+ Connect USB (${connectedUsb.length}/${MAX_USB_CONNECTIONS})</span>
                    </button>
                  </div>`
                : ""
            }
          </div>`
        : "";

    const usbBtn = `
      <div class="topbar-usb-wrap">
        <button type="button" class="btn ${usbOn ? "btn-armed" : "btn-ghost"} ${this.usbMenuOpen ? "is-open" : ""}" data-action="usb-toggle" aria-expanded="${this.usbMenuOpen ? "true" : "false"}" ${usbSupported && !usbBusy ? "" : "disabled"} title="${esc(usbTitle)}" aria-label="${esc(usbTitle)}">
          ${usbOn ? icons.plug(19) : icons.plugOff(19)}<span class="topbar-btn-label">${usbBtnText}</span>${usbOn ? `<span class="topbar-usb-caret">${icons.chevronDown(14)}</span>` : ""}
        </button>
        ${usbPopoverHtml}
      </div>`;

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
