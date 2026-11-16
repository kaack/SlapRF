import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import {
  AnalyticsScopeKind,
  buildAnalyticsHash,
  buildPracticeHash,
  buildRacesHash,
  dispatchPracticeTopBarCommand,
  dispatchRacesTopBarCommand,
  getAnalyticsScope,
  getPracticeTopBarContext,
  getRacesTopBarContext,
  getRememberedRouteHash,
  isSidebarCollapsed,
  onAnalyticsScopeChange,
  onAnalyticsTopBarContextChange,
  onPracticeTopBarContextChange,
  onRacesTopBarContextChange,
  onSidebarCollapsedChange,
  pushAppHash,
  RouteId,
  ROUTES,
  Router,
  setAnalyticsScope,
  slugifyPracticeName,
  slugifyRaceName,
  toggleSidebarCollapsed,
} from "../core/router";
import { AppTheme, getAppTheme, setAppTheme, subscribeAppTheme } from "../core/theme";
import { Announcer } from "../services/announcer";
import { ApiClient } from "../services/api_client";
import {
  capabilitiesSnapshot,
  isServerDisconnectedLockout,
  openDatasourceSettings,
  subscribeCapabilities,
} from "../services/capabilities";
import { sharedLapRFLink } from "../services/laprf_hardware_link";
import { sharedLiveTimeRelay } from "../services/livetime_relay";
import {
  isPwaStandalone,
  subscribePwaInstallState,
  triggerPwaInstallPrompt,
} from "../services/offline";
import { sharedRHLink } from "../services/rh_hardware_link";
import { TimerConsole, usbPool } from "../services/timer_console";
import { AppStore } from "../state/store";

interface BreadcrumbEntry {
  menuLabel: string;
  menuHref: string;
  menuAction?: string;
  inlineHtml: string;
}

export class TopBar extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private readonly router: Router;
  private readonly announcer: Announcer;
  private lastSig = "";
  private menuOpen = false;
  private scopeMenuOpen = false;
  private crumbMenuOpen = false;
  private pwaMenuOpen = false;
  private activeCrumbItems: BreadcrumbEntry[] = [];
  private collapsedCrumbCount = 0;
  private lastObservedWidth = 0;
  private resizeObserver: ResizeObserver | null = null;

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
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver((entries) => {
        const w = Math.round(entries[0]?.contentRect.width ?? this.el.clientWidth);
        if (w > 0 && w !== this.lastObservedWidth) {
          this.lastObservedWidth = w;
          if (this.crumbMenuOpen || this.scopeMenuOpen) {
            this.crumbMenuOpen = false;
            this.scopeMenuOpen = false;
            this.lastSig = "";
            this.render();
            return;
          }
          this.fitActiveBreadcrumb();
        }
      });
      this.resizeObserver.observe(this.el);
      this.onDispose(() => {
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
      });
    }
    this.onDispose(
      router.subscribe(() => {
        this.menuOpen = false;
        this.scopeMenuOpen = false;
        this.crumbMenuOpen = false;
        this.pwaMenuOpen = false;
        this.render();
      })
    );
    this.onDispose(store.subscribe(["status", "config", "race", "practice", "laps"], () => this.render()));
    this.onDispose(announcer.subscribe(() => this.render()));
    this.onDispose(usbPool.onChange(() => this.render()));
    this.onDispose(api.hubBridge.subscribe(() => this.render()));
    this.onDispose(sharedLapRFLink.subscribe(() => this.render()));
    this.onDispose(sharedRHLink.subscribe(() => this.render()));
    this.onDispose(sharedLiveTimeRelay.subscribe(() => this.render()));
    this.onDispose(subscribeCapabilities(() => this.render()));
    this.onDispose(subscribePwaInstallState(() => this.render()));
    this.onDispose(onRacesTopBarContextChange(() => this.render()));
    this.onDispose(onPracticeTopBarContextChange(() => this.render()));
    this.onDispose(onAnalyticsScopeChange(() => this.render()));
    this.onDispose(onAnalyticsTopBarContextChange(() => this.render()));
    this.onDispose(onSidebarCollapsedChange(() => this.render()));
    this.onDispose(subscribeAppTheme(() => this.render()));
    this.render();
  }

  private handleOutsidePointer = (e: PointerEvent): void => {
    const t = e.target as Node | null;
    if (this.menuOpen) {
      const menuWrap = this.el.querySelector(".topbar-menu-wrap");
      if (!t || !menuWrap?.contains(t)) {
        this.setMenuOpen(false);
      }
    }
    if (this.scopeMenuOpen) {
      const scopeWrap = this.el.querySelector(".topbar-scope-picker-wrap");
      const toggleBtn =
        t instanceof Element ? t.closest('[data-action="toggle-analytics-scope"]') : null;
      if (!t || (!scopeWrap?.contains(t) && !toggleBtn)) {
        this.scopeMenuOpen = false;
        this.lastSig = "";
        this.render();
      }
    }
    if (this.crumbMenuOpen) {
      const crumbWrap = this.el.querySelector(".topbar-crumb-ellipsis-wrap");
      if (!t || !crumbWrap?.contains(t)) {
        this.crumbMenuOpen = false;
        this.lastSig = "";
        this.render();
      }
    }
    if (this.pwaMenuOpen) {
      const pwaWrap = this.el.querySelector(".topbar-pwa-wrap");
      if (!t || !pwaWrap?.contains(t)) {
        this.pwaMenuOpen = false;
        this.lastSig = "";
        this.render();
      }
    }
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && (this.menuOpen || this.scopeMenuOpen || this.crumbMenuOpen || this.pwaMenuOpen)) {
      this.setMenuOpen(false);
      if (this.scopeMenuOpen || this.crumbMenuOpen || this.pwaMenuOpen) {
        this.scopeMenuOpen = false;
        this.crumbMenuOpen = false;
        this.pwaMenuOpen = false;
        this.lastSig = "";
        this.render();
      }
    }
  };

  private handleClick = (e: Event): void => {
    const target = e.target as HTMLElement;
    const themeBtn = target.closest<HTMLButtonElement>("button[data-set-theme]");
    if (themeBtn) {
      e.preventDefault();
      const nextTheme = themeBtn.dataset.setTheme as AppTheme | undefined;
      if (nextTheme === "dark" || nextTheme === "light") {
        setAppTheme(nextTheme);
      }
      return;
    }
    if (target.closest("[data-crumb-menu-link]")) {
      this.crumbMenuOpen = false;
      this.lastSig = "";
      this.render();
      return;
    }
    const navItem = target.closest<HTMLElement>("[data-nav-item]");
    if (navItem) {
      e.preventDefault();
      const routeId = navItem.dataset.navItem as RouteId | undefined;
      if (navItem.classList.contains("is-disabled") || (isServerDisconnectedLockout() && routeId !== "setup")) {
        return;
      }
      this.menuOpen = false;
      this.lastSig = "";
      this.render();
      if (routeId) {
        this.router.navigateSection(routeId);
      }
      return;
    }

    const actionEl = target.closest<HTMLElement>("[data-action]");
    switch (actionEl?.dataset.action) {
      case "menu":
        this.setMenuOpen(!this.menuOpen);
        break;
      case "expand-sidebar":
        toggleSidebarCollapsed();
        break;
      case "races-back":
        dispatchRacesTopBarCommand({ type: "set-tab", tab: "directory" });
        break;
      case "practice-back":
        dispatchPracticeTopBarCommand({ type: "set-tab", tab: "directory" });
        break;
      case "analytics-chooser":
        e.preventDefault();
        this.scopeMenuOpen = false;
        this.crumbMenuOpen = false;
        setAnalyticsScope(null);
        pushAppHash("#/pilot");
        this.lastSig = "";
        this.render();
        break;
      case "toggle-analytics-scope":
        this.scopeMenuOpen = !this.scopeMenuOpen;
        this.crumbMenuOpen = false;
        this.lastSig = "";
        this.render();
        break;
      case "toggle-crumb-menu":
        this.crumbMenuOpen = !this.crumbMenuOpen;
        this.scopeMenuOpen = false;
        this.menuOpen = false;
        this.lastSig = "";
        this.render();
        break;
      case "pick-analytics-scope": {
        const kind = actionEl.dataset.scopeKind as AnalyticsScopeKind | undefined;
        const slugOrId = actionEl.dataset.scopeSlug || actionEl.dataset.scopeId || "";
        if ((kind === "practice" || kind === "race") && slugOrId) {
          this.scopeMenuOpen = false;
          setAnalyticsScope({ kind, id: slugOrId });
          pushAppHash(buildAnalyticsHash({ kind, id: slugOrId }));
          this.lastSig = "";
          this.render();
        }
        break;
      }
      case "races-tab": {
        const tab = actionEl.dataset.tab as "format" | "edit" | "control" | "review";
        if (tab === "format" || tab === "edit" || tab === "control" || tab === "review") {
          dispatchRacesTopBarCommand({ type: "set-tab", tab });
        }
        break;
      }
      case "races-stage": {
        const stg = Number(actionEl.dataset.stage);
        if (stg >= 1 && stg <= 5) {
          dispatchRacesTopBarCommand({ type: "set-stage", stage: stg });
        }
        break;
      }
      case "sim":
        if (!capabilitiesSnapshot().demoMode) {
          void this.api.toggleSimulator();
        }
        break;
      case "go-datasource":
        openDatasourceSettings("inspect");
        break;
      case "usb-toggle": {
        if (isServerDisconnectedLockout()) return;
        const main = usbPool.mainConsole;
        if (main.busyLabel) return;
        if (main.connected || main.reconnecting) {
          void main.disconnectCleanly();
        } else {
          void usbPool.connectMain().catch(() => undefined);
        }
        break;
      }
      case "go-network":
        if (isServerDisconnectedLockout()) return;
        this.router.navigate("network");
        break;
      case "announcer":
        this.announcer.update({ enabled: !this.announcer.settings.enabled });
        break;
      case "install-pwa":
        void triggerPwaInstallPrompt().then((mode) => {
          if (mode === "prompted") {
            this.pwaMenuOpen = false;
          } else {
            this.pwaMenuOpen = !this.pwaMenuOpen;
            this.menuOpen = false;
            this.scopeMenuOpen = false;
            this.crumbMenuOpen = false;
          }
          this.lastSig = "";
          this.render();
        });
        break;
      case "close-pwa-popover":
        this.pwaMenuOpen = false;
        this.lastSig = "";
        this.render();
        break;
      case "pack":
        void this.api.simulatePack();
        break;
    }
  };

  private render(): void {
    const meta = this.router.meta();
    const { liveTime, simulatorRunning: sim } = this.store;
    const ltConnected = liveTime.connectedClients > 0;
    const ltEnabled = sharedLiveTimeRelay.snapshot.enabled;
    const voiceOn = this.announcer.settings.enabled;
    const main = usbPool.mainConsole;
    const usbOn = main.connected;
    const activeLabel = usbOn
      ? main.isOtherDevice
        ? "Other"
        : main.lastStatus?.label ||
          main.lastConfig?.timerLabel ||
          (main.lastStatus?.role === 1 ? "H1" : "")
      : "";
    const usbFp = main.lastStatus?.fp || main.lastConfig?.fingerprint || "";
    const usbBusy = main.busyLabel ?? "";
    const hwMode = this.store.timingHardwareMode;
    const led = this.api.hubBridge.getLedSummary(this.store);
    const sbCollapsed = isSidebarCollapsed();
    const caps = capabilitiesSnapshot();
    const lockedOut = isServerDisconnectedLockout();
    const rCtx = getRacesTopBarContext();
    const pCtx = getPracticeTopBarContext();
    const inRaceWorkspace = meta.id === "races" && rCtx.tab !== "directory";
    const inPracticeWorkspace = meta.id === "live" && pCtx.tab === "session";
    const inAnalytics = meta.id === "pilot";
    const rawAnalyticsScope = inAnalytics ? getAnalyticsScope() : null;
    const aScope = rawAnalyticsScope ? this.store.resolveAnalyticsScope(rawAnalyticsScope) : null;
    const scopePopoverCounts =
      inAnalytics && this.scopeMenuOpen
        ? `${this.store.practiceSessions.map((s) => `${s.sessionId}:${s.name}:${s.active ? 1 : 0}:${s.laps.length}`).join("|")}::${this.store.races.map((r) => `${r.raceId ?? ""}:${r.config.eventName}:${r.lifecycle ?? ""}`).join("|")}`
        : "";

    const appTheme = getAppTheme();
    const pwaStandalone = isPwaStandalone();
    const sig = `${meta.id}:${appTheme}:${hwMode}:${sim ? 1 : 0}:${caps.demoMode ? 1 : 0}:${caps.portable ? 1 : 0}:${lockedOut ? 1 : 0}:${caps.remoteBackend ? 1 : 0}:${caps.backendBaseUrl}:${caps.localDetectedUrl ?? ""}:${ltEnabled ? 1 : 0}:${voiceOn ? 1 : 0}:${ltConnected ? 1 : 0}:${this.scopeMenuOpen ? 1 : 0}:${this.crumbMenuOpen ? 1 : 0}:${this.pwaMenuOpen ? 1 : 0}:${pwaStandalone ? 1 : 0}:${usbOn ? 1 : 0}:${activeLabel}:${usbFp}:${usbBusy}:${led.color}:${led.shortLabel}:${led.detail}:${sbCollapsed ? 1 : 0}:${rCtx.tab}:${rCtx.raceId ?? ""}:${rCtx.raceName}:${rCtx.activeStage}:${rCtx.totalStages}:${rCtx.stageTitle}:${pCtx.tab}:${pCtx.sessionId ?? ""}:${pCtx.sessionName}:${pCtx.active ? 1 : 0}:${aScope ? `${aScope.kind}:${aScope.id}:${aScope.name}:${aScope.live ? 1 : 0}` : ""}:${scopePopoverCounts}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    const simBtn = caps.demoMode
      ? ""
      : `
      <button class="btn ${sim ? "btn-armed" : "btn-ghost"}" data-action="sim" title="${
        sim
          ? "Switch to real-world hardware dataset"
          : "Switch to simulated track dataset"
      }" aria-label="${sim ? "Switch to real-world hardware dataset" : "Switch to simulated track dataset"}">
        ${sim ? icons.zap(19) : icons.zapOff(19)}<span class="topbar-btn-label">${sim ? "Simulation on" : "Simulation off"}</span>
      </button>`;

    const pwaBtn = pwaStandalone
      ? ""
      : `
      <div class="topbar-pwa-wrap">
        <button
          type="button"
          class="btn btn-ghost topbar-pwa-btn ${this.pwaMenuOpen ? "is-open" : ""}"
          data-action="install-pwa"
          title="Install SlapRF as an app"
          aria-label="Install SlapRF as an app"
          aria-expanded="${this.pwaMenuOpen ? "true" : "false"}"
        >
          ${icons.installPwa(19)}
        </button>
        ${this.pwaMenuOpen ? this.renderPwaInstallPopover() : ""}
      </div>`;

    const usbSupported = TimerConsole.supported() && !lockedOut;
    const usbBtnText = usbOn
      ? activeLabel
        ? `Connected · ${esc(activeLabel)}`
        : "Connected"
      : usbBusy
        ? `${esc(usbBusy)}…`
        : "Connect";
    const usbTitle = !usbSupported
      ? "Connect a SlapRF Server to open USB serial ports"
      : usbOn
        ? `Connected over USB${activeLabel ? ` (${activeLabel}${usbFp ? ` · ${usbFp}` : ""})` : ""} · click to disconnect`
        : "Connect a timer over USB-C";

    const usbBtn =
      hwMode === "slaprf"
        ? `
      <button type="button" class="btn ${usbOn ? "btn-armed" : "btn-ghost"}" data-action="usb-toggle" ${usbSupported && !usbBusy ? "" : "disabled"} title="${esc(usbTitle)}" aria-label="${esc(usbTitle)}">
        ${usbOn ? icons.plug(19) : icons.plugOff(19)}<span class="topbar-btn-label">${usbBtnText}</span>
      </button>`
        : "";

    const ledIndicator = `
      <button type="button" class="topbar-conn-led is-${led.color}" data-action="go-network" ${lockedOut ? "disabled" : ""} title="${esc(lockedOut ? "Connect a SlapRF Server in Datasource" : led.detail)}" aria-label="${esc(lockedOut ? "Connect a SlapRF Server in Datasource" : led.detail)}">
        <span class="topbar-conn-led-bulb" aria-hidden="true"></span>
      </button>`;

    let actions = `${simBtn}${pwaBtn}`;
    if (meta.id === "sim" || meta.id === "live") {
      actions += `
        <button class="btn ${voiceOn ? "btn-armed" : "btn-ghost"}" data-action="announcer" title="${voiceOn ? "Mute" : "Enable"} lap-time callouts" aria-label="${voiceOn ? "Mute" : "Enable"} lap-time callouts">
          ${voiceOn ? icons.speaker(19) : icons.speakerOff(19)}<span class="topbar-btn-label">Announcer</span>
        </button>`;
    } else if (meta.id === "races") {
      actions += `
        <button class="btn ${voiceOn ? "btn-armed" : "btn-ghost"}" data-action="announcer" title="${voiceOn ? "Mute" : "Enable"} race announcer &amp; start horn" aria-label="${voiceOn ? "Mute" : "Enable"} race announcer">
          ${voiceOn ? icons.speaker(19) : icons.speakerOff(19)}<span class="topbar-btn-label">Announcer</span>
        </button>`;
    }

    const isExternalTimer =
      this.store.timingHardwareMode === "laprf" ||
      this.store.timingHardwareMode === "rotorhazard" ||
      this.store.timingHardwareMode === "rotorhazard_usb";
    const effectiveSimForNav = lockedOut ? false : sim;
    const navItems = ROUTES.filter(
      (r) =>
        (!r.simOnly || effectiveSimForNav) &&
        (!r.liveTimeOnly || (ltEnabled && !isExternalTimer && !lockedOut)) &&
        (r.id !== "flasher" || !isExternalTimer)
    )
      .map((r) => {
        const active = r.id === meta.id;
        const disabled = lockedOut && r.id !== "setup";
        const itemHref = active ? `#/${r.id}` : getRememberedRouteHash(r.id);
        return `<a class="nav-item ${active ? "is-active" : ""} ${disabled ? "is-disabled" : ""}" href="${esc(itemHref)}" data-nav-item="${r.id}" ${active ? 'aria-current="page"' : ""} ${disabled ? 'aria-disabled="true" tabindex="-1"' : ""}>${r.icon()}<span>${r.label}</span></a>`;
      })
      .join("");

    const raceLabel = rCtx.raceName || "Untitled Race";
    const stageNum = Math.max(1, rCtx.activeStage || 1);
    const stageNumLabel = `Stage ${stageNum}`;
    const stageFullTitle = rCtx.stageTitle ? `${stageNumLabel} · ${rCtx.stageTitle}` : stageNumLabel;
    const raceSlug = rCtx.raceId ? slugifyRaceName(raceLabel) : undefined;
    const practiceSlug = pCtx.sessionId
      ? slugifyPracticeName(pCtx.sessionName || "Practice Session")
      : undefined;
    const racesDirHref = buildRacesHash("directory");
    const raceFormatHref = buildRacesHash("format", raceSlug);
    const raceStageHref = buildRacesHash("edit", raceSlug, stageNum);
    const raceControlHref = buildRacesHash("control", raceSlug);
    const raceReviewHref = buildRacesHash("review", raceSlug);
    const practiceDirHref = buildPracticeHash("directory");
    const practiceSessionHref = buildPracticeHash("session", practiceSlug);

    const raceCrumbs: Array<{ label: string; href: string; title: string; iconHtml?: string }> = [
      { label: "Race", href: racesDirHref, title: "All races" },
      { label: raceLabel, href: raceFormatHref, title: `Open ${raceLabel}` },
    ];
    if (rCtx.tab === "edit") {
      raceCrumbs.push({
        label: stageNumLabel,
        href: raceStageHref,
        title: `Configure ${stageFullTitle}`,
        iconHtml: icons.settings(15),
      });
    } else if (rCtx.tab === "control") {
      raceCrumbs.push({
        label: stageNumLabel,
        href: raceControlHref,
        title: `Control ${stageFullTitle}`,
        iconHtml: icons.checkered(15),
      });
    } else if (rCtx.tab === "review") {
      raceCrumbs.push({
        label: stageNumLabel,
        href: raceReviewHref,
        title: `Review ${stageFullTitle}`,
        iconHtml: icons.reviewCheck(15),
      });
    } else {
      raceCrumbs.push({
        label: "Format",
        href: raceFormatHref,
        title: "Configure Format overview",
        iconHtml: icons.settings(15),
      });
    }

    const toLinkEntries = (
      crumbs: Array<{ label: string; href: string; title: string; iconHtml?: string }>
    ): BreadcrumbEntry[] =>
      crumbs.map((c, idx) => {
        const isLast = idx === crumbs.length - 1;
        return {
          menuLabel: c.label,
          menuHref: c.href,
          inlineHtml: `<a class="topbar-crumb-item" href="${esc(c.href)}" ${isLast ? 'aria-current="page"' : ""} title="${esc(c.title)}">${c.iconHtml ?? ""}<span>${esc(c.label)}</span></a>`,
        };
      });

    const practiceSessionName = pCtx.sessionName || "Practice Session";
    let breadcrumbAttr = "";
    let breadcrumbAria = "";
    let breadcrumbClass = "topbar-breadcrumb";
    if (inRaceWorkspace) {
      this.activeCrumbItems = toLinkEntries(raceCrumbs);
      breadcrumbAttr = "data-race-breadcrumb";
      breadcrumbAria = "Race navigation";
    } else if (inPracticeWorkspace) {
      this.activeCrumbItems = toLinkEntries([
        { label: "Practice", href: practiceDirHref, title: "All practice sessions" },
        {
          label: practiceSessionName,
          href: practiceSessionHref,
          title: practiceSessionName,
        },
      ]);
      breadcrumbAttr = "data-practice-breadcrumb";
      breadcrumbAria = "Practice session navigation";
    } else if (inAnalytics && aScope) {
      const hasScopeItem = Boolean(aScope.id);
      const emptyLabel =
        aScope.kind === "race" ? "(No races recorded)" : "(No practices recorded)";
      this.activeCrumbItems = [
        {
          menuLabel: "Analytics",
          menuHref: "#/pilot",
          menuAction: "analytics-chooser",
          inlineHtml: `<a class="topbar-crumb-item" href="#/pilot" data-action="analytics-chooser" title="Return to Analytics chooser">Analytics</a>`,
        },
        {
          menuLabel: hasScopeItem ? aScope.name : emptyLabel,
          menuHref: buildAnalyticsHash({ kind: aScope.kind, id: aScope.id }),
          inlineHtml: hasScopeItem
            ? `<div class="topbar-scope-picker-wrap">
                 <button
                   type="button"
                   class="topbar-scope-trigger ${this.scopeMenuOpen ? "is-open" : ""}"
                   data-action="toggle-analytics-scope"
                   data-analytics-scope-trigger
                   aria-haspopup="listbox"
                   aria-expanded="${this.scopeMenuOpen ? "true" : "false"}"
                   title="Switch ${aScope.kind === "race" ? "race" : "practice session"}"
                 >
                   ${aScope.live ? `<span class="topbar-scope-live-dot" aria-hidden="true"></span>` : ""}
                   <span class="topbar-scope-name">${esc(aScope.name)}</span>
                   ${icons.chevronDown(14)}
                 </button>
                 ${this.scopeMenuOpen ? this.renderAnalyticsScopePopover(aScope.kind, aScope.id) : ""}
               </div>`
            : `<span class="topbar-crumb-item is-muted" aria-current="page">${esc(emptyLabel)}</span>`,
        },
      ];
      breadcrumbAttr = "data-analytics-breadcrumb";
      breadcrumbAria = "Analytics navigation";
      breadcrumbClass = "topbar-breadcrumb topbar-analytics-breadcrumb";
    } else {
      this.activeCrumbItems = [];
      this.collapsedCrumbCount = 0;
    }

    const pageSubtitle =
      meta.id === "debug" && hwMode === "rotorhazard_usb"
        ? "RotorHazard USB diagnostics: binary serial self-test, RX5808 node health, live 0–255 RSSI monitor, and threshold noise"
        : meta.id === "debug" && hwMode === "rotorhazard"
          ? "RotorHazard diagnostics: Socket.IO self-test, RX5808 node health, live 0–255 RSSI monitor, and threshold noise"
          : meta.id === "debug" && hwMode === "laprf"
            ? "LapRF 8-Way diagnostics: TCP/USB link status, 8-slot RSSI telemetry, clock sync, and supply voltage"
            : meta.id === "network" && hwMode === "rotorhazard_usb"
              ? "RotorHazard USB serial nodes, multi-seat RX5808 tuning, and live 0–255 node RSSI"
              : meta.id === "network" && hwMode === "rotorhazard"
                ? "RotorHazard timing devices, per-device admin credentials, clock sync, and live 0–255 RX5808 node RSSI"
                : meta.id === "network" && hwMode === "laprf"
                  ? "LapRF 8-Way pucks over Ethernet (:5403) or USB CDC, clock sync, and live 8-slot RSSI"
                  : meta.subtitle;

    const titleMarkup =
      this.activeCrumbItems.length > 0
        ? `<nav class="${breadcrumbClass}" ${breadcrumbAttr} aria-label="${esc(breadcrumbAria)}">
             ${this.buildBreadcrumbTrailHtml(this.activeCrumbItems, this.collapsedCrumbCount)}
           </nav>`
        : `<div class="topbar-title">
             <h1>${meta.title}</h1>
             <p>${pageSubtitle}</p>
           </div>`;

    this.el.innerHTML = `
      <div class="topbar-left">
        ${
          sbCollapsed
            ? `<button class="btn btn-ghost topbar-sidebar-expand-btn" data-action="expand-sidebar" type="button" title="Expand left navigation" aria-label="Expand left navigation">
                 ${icons.sidebarToggle(18)}
               </button>`
            : ""
        }
        <div class="topbar-menu-wrap">
          <button class="btn btn-ghost topbar-menu-btn ${this.menuOpen ? "is-open" : ""}" data-action="menu" type="button" aria-label="${this.menuOpen ? "Close navigation menu" : "Open navigation menu"}" aria-expanded="${this.menuOpen ? "true" : "false"}">
            <span class="topbar-hamburger" aria-hidden="true"><span></span><span></span><span></span></span>
          </button>
          ${this.menuOpen ? this.buildNavPopoverHtml() : ""}
        </div>
        ${titleMarkup}
      </div>
      <div class="topbar-actions ${inRaceWorkspace ? "is-race-workspace" : ""}">
        ${actions}
        ${usbBtn}
        ${ledIndicator}
      </div>`;

    this.fitActiveBreadcrumb();
  }

  private buildBreadcrumbTrailHtml(items: BreadcrumbEntry[], collapsedCount: number): string {
    const c = Math.max(0, Math.min(collapsedCount, Math.max(0, items.length - 1)));
    const collapsed = items.slice(0, c);
    const visible = items.slice(c);
    const isLastOnly = visible.length <= 1;

    const ellipsisHtml =
      c > 0
        ? `<div class="topbar-crumb-ellipsis-wrap">
             <button
               type="button"
               class="topbar-crumb-ellipsis ${this.crumbMenuOpen ? "is-open" : ""}"
               data-action="toggle-crumb-menu"
               aria-haspopup="menu"
               aria-expanded="${this.crumbMenuOpen ? "true" : "false"}"
               aria-label="Open breadcrumb levels"
               title="Jump to parent level"
             >…</button>
             ${
               this.crumbMenuOpen
                 ? `<div class="topbar-crumb-popover" role="menu" aria-label="Parent levels">
                      ${collapsed
                        .map(
                          (anc, idx) => `
                            <a
                              class="topbar-crumb-menu-item"
                              href="${esc(anc.menuHref)}"
                              ${anc.menuAction ? `data-action="${esc(anc.menuAction)}"` : "data-crumb-menu-link"}
                              role="menuitem"
                              style="--crumb-depth:${idx}"
                            >
                              <span class="topbar-crumb-menu-indent" aria-hidden="true">${idx > 0 ? "↳" : ""}</span>
                              <span class="topbar-crumb-menu-label">${esc(anc.menuLabel)}</span>
                            </a>`
                        )
                        .join("")}
                    </div>`
                 : ""
             }
           </div>`
        : "";

    const visibleHtml = visible
      .map(
        (item, idx) =>
          `${idx > 0 ? `<span class="topbar-crumb-sep" aria-hidden="true">›</span>` : ""}${item.inlineHtml}`
      )
      .join("");

    return `<div class="topbar-crumb-trail ${isLastOnly ? "is-last-only" : ""}">${ellipsisHtml}${visibleHtml}</div>`;
  }

  private fitActiveBreadcrumb(): void {
    const items = this.activeCrumbItems;
    if (items.length === 0) return;
    const navEl = this.el.querySelector<HTMLElement>("nav.topbar-breadcrumb");
    if (!navEl) return;

    if (this.crumbMenuOpen || this.scopeMenuOpen) {
      const clamped = Math.max(0, Math.min(this.collapsedCrumbCount, items.length - 1));
      this.collapsedCrumbCount = clamped;
      navEl.innerHTML = this.buildBreadcrumbTrailHtml(items, clamped);
      return;
    }

    if (items.length <= 1) {
      this.collapsedCrumbCount = 0;
      navEl.innerHTML = this.buildBreadcrumbTrailHtml(items, 0);
      return;
    }

    let collapsed = 0;
    navEl.innerHTML = this.buildBreadcrumbTrailHtml(items, 0);
    const availW = navEl.clientWidth;
    if (availW > 0) {
      let trailEl = navEl.querySelector<HTMLElement>(".topbar-crumb-trail");
      while (collapsed < items.length - 1 && trailEl && trailEl.scrollWidth > availW + 1) {
        collapsed++;
        navEl.innerHTML = this.buildBreadcrumbTrailHtml(items, collapsed);
        trailEl = navEl.querySelector<HTMLElement>(".topbar-crumb-trail");
      }
    }
    this.collapsedCrumbCount = collapsed;
  }

  private renderAnalyticsScopePopover(activeKind: AnalyticsScopeKind, activeId: string): string {
    const sessions = this.store.practiceSessions;
    const races = this.store.races;

    const practiceRows =
      sessions.length > 0
        ? sessions
            .map((s, idx) => {
              const isSelected = activeKind === "practice" && activeId === s.sessionId;
              const lapCount = s.laps.length;
              const dispName = s.name || `Practice ${idx + 1}`;
              return `
                <button
                  type="button"
                  role="option"
                  aria-selected="${isSelected ? "true" : "false"}"
                  class="topbar-scope-item ${isSelected ? "is-active" : ""}"
                  data-action="pick-analytics-scope"
                  data-scope-kind="practice"
                  data-scope-id="${esc(s.sessionId)}"
                  data-scope-slug="${esc(slugifyPracticeName(dispName))}"
                >
                  <span class="topbar-scope-item-main">
                    ${s.active ? `<span class="topbar-scope-live-dot" aria-hidden="true"></span>` : ""}
                    <span class="topbar-scope-item-title">${esc(dispName)}</span>
                  </span>
                  <span class="topbar-scope-item-meta">${lapCount} lap${lapCount === 1 ? "" : "s"} · ${s.active ? "Live" : "Stopped"}</span>
                </button>`;
            })
            .join("")
        : `<div class="topbar-scope-empty">No practice sessions yet</div>`;

    const raceRows =
      races.length > 0
        ? races
            .map((r, idx) => {
              const rid = r.raceId ?? "";
              const isSelected = activeKind === "race" && activeId === rid;
              let lapCount = 0;
              for (const h of r.heats) {
                for (const seat of h.seats) {
                  if (seat.pilotSlotIndex <= 0) continue;
                  for (const hl of seat.laps ?? []) {
                    if (!hl.invalidated && hl.lapNumber >= 1 && hl.splitTimeSec > 0) lapCount++;
                  }
                }
              }
              const isLive = Boolean(
                r.lifecycle === "active" ||
                  r.heats.some((h) => h.state === "running" || h.state === "countdown")
              );
              const stateLabel = isLive
                ? "Live"
                : r.lifecycle === "completed" || r.isComplete
                  ? "Completed"
                  : r.lifecycle === "scrapped"
                    ? "Scrapped"
                    : r.lifecycle === "paused"
                      ? "Paused"
                      : "Draft";
              const dispName = r.config.eventName || `Race ${idx + 1}`;
              return `
                <button
                  type="button"
                  role="option"
                  aria-selected="${isSelected ? "true" : "false"}"
                  class="topbar-scope-item ${isSelected ? "is-active" : ""}"
                  data-action="pick-analytics-scope"
                  data-scope-kind="race"
                  data-scope-id="${esc(rid)}"
                  data-scope-slug="${esc(slugifyRaceName(dispName))}"
                >
                  <span class="topbar-scope-item-main">
                    ${isLive ? `<span class="topbar-scope-live-dot" aria-hidden="true"></span>` : ""}
                    <span class="topbar-scope-item-title">${esc(dispName)}</span>
                  </span>
                  <span class="topbar-scope-item-meta">${lapCount} lap${lapCount === 1 ? "" : "s"} · ${stateLabel}</span>
                </button>`;
            })
            .join("")
        : `<div class="topbar-scope-empty">No races yet</div>`;

    return `
      <div class="topbar-scope-popover" data-analytics-scope-menu role="listbox" aria-label="Select ${activeKind === "race" ? "Race" : "Practice session"}">
        <div class="topbar-scope-group">
          <div class="topbar-scope-group-label">${activeKind === "race" ? icons.checkered(13) : icons.flag(13)}<span>${activeKind === "race" ? "Race" : "Practice"}</span></div>
          ${activeKind === "race" ? raceRows : practiceRows}
        </div>
      </div>`;
  }

  private renderPwaInstallPopover(): string {
    const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
    const isIos = /iphone|ipad|ipod/i.test(ua);
    const bodyText = isIos
      ? "Tap the Share button in Safari, then choose “Add to Home Screen” to install SlapRF as a full-screen app."
      : "Open your browser menu (⋮) and choose “Install app” or “Add to Home screen” (or use the install icon in the address bar).";
    return `
      <div class="topbar-pwa-popover" data-pwa-install-popover role="dialog" aria-label="Install SlapRF app">
        <div class="topbar-pwa-popover-head">
          <span class="topbar-pwa-popover-title">${icons.installPwa(16)}<span>Install SlapRF App</span></span>
          <button type="button" class="btn btn-ghost btn-xs topbar-pwa-popover-close" data-action="close-pwa-popover" aria-label="Close">
            ${icons.close(14)}
          </button>
        </div>
        <p class="topbar-pwa-popover-body">${esc(bodyText)}</p>
      </div>`;
  }

  private setMenuOpen(open: boolean): void {
    if (this.menuOpen === open) return;
    this.menuOpen = open;
    const wrap = this.el.querySelector<HTMLElement>(".topbar-menu-wrap");
    const btn = wrap?.querySelector<HTMLButtonElement>(".topbar-menu-btn");
    if (!wrap || !btn) {
      this.lastSig = "";
      this.render();
      return;
    }
    btn.classList.toggle("is-open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
    const existingPopover = wrap.querySelector(".topbar-nav-popover");
    if (existingPopover) {
      existingPopover.remove();
    }
    if (open) {
      wrap.insertAdjacentHTML("beforeend", this.buildNavPopoverHtml());
    }
  }

  private buildNavPopoverHtml(): string {
    const meta = this.router.meta();
    const { simulatorRunning: sim } = this.store;
    const ltEnabled = sharedLiveTimeRelay.snapshot.enabled;
    const caps = capabilitiesSnapshot();
    const lockedOut = isServerDisconnectedLockout();
    const appTheme = getAppTheme();
    const isExternalTimer =
      this.store.timingHardwareMode === "laprf" ||
      this.store.timingHardwareMode === "rotorhazard" ||
      this.store.timingHardwareMode === "rotorhazard_usb";
    const effectiveSimForNav = lockedOut ? false : sim;
    const navItems = ROUTES.filter(
      (r) =>
        (!r.simOnly || effectiveSimForNav) &&
        (!r.liveTimeOnly || (ltEnabled && !isExternalTimer && !lockedOut)) &&
        (r.id !== "flasher" || !isExternalTimer)
    )
      .map((r) => {
        const active = r.id === meta.id;
        const disabled = lockedOut && r.id !== "setup";
        const itemHref = active ? `#/${r.id}` : getRememberedRouteHash(r.id);
        return `<a class="nav-item ${active ? "is-active" : ""} ${disabled ? "is-disabled" : ""}" href="${esc(itemHref)}" data-nav-item="${r.id}" ${active ? 'aria-current="page"' : ""} ${disabled ? 'aria-disabled="true" tabindex="-1"' : ""}>${r.icon()}<span>${r.label}</span></a>`;
      })
      .join("");

    return `<div class="topbar-nav-popover" role="menu" aria-label="Main navigation">
      <div class="brand">
        <div class="brand-mark">${icons.slaprf(25)}</div>
        <div class="brand-copy">
          <div class="brand-name">SlapRF</div>
        </div>
      </div>
      <nav class="nav">
        ${navItems}
        <div class="sidebar-theme-row" data-theme-toggler-row>
          <span class="sidebar-theme-label">Theme</span>
          <div class="sidebar-theme-toggler" role="group" aria-label="Color theme">
            <button type="button" class="sidebar-theme-btn ${appTheme === "dark" ? "is-active" : ""}" data-set-theme="dark" title="Dark theme" aria-label="Dark theme" aria-pressed="${appTheme === "dark" ? "true" : "false"}">
              ${icons.moon(15)}
            </button>
            <button type="button" class="sidebar-theme-btn ${appTheme === "light" ? "is-active" : ""}" data-set-theme="light" title="Light theme" aria-label="Light theme" aria-pressed="${appTheme === "light" ? "true" : "false"}">
              ${icons.sun(15)}
            </button>
          </div>
        </div>
      </nav>
      ${
        caps.demoMode && !lockedOut
          ? `<button type="button" class="sidebar-demo-disclaimer" data-action="go-datasource">
               <span class="sidebar-demo-disclaimer-title">Browser Demo</span>
               <span class="sidebar-demo-disclaimer-body">Simulated in your browser. Click to connect a SlapRF Server.</span>
             </button>`
          : ""
      }
    </div>`;
  }
}
