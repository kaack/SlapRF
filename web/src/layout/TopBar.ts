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
  getAnalyticsTopBarContext,
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
import { sharedLapRFEmulatorRelay } from "../services/laprf_emulator_relay";
import { sharedRHLink } from "../services/rh_hardware_link";
import { getPairedBluetoothHub, TimerConsole, usbPool } from "../services/timer_console";
import { openDeviceConnectionSheet } from "../widgets/DeviceConnectionSheet";
import { AppStore } from "../state/store";
import { isSlapRFMode } from "../types/models";

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
  private activeCrumbItems: BreadcrumbEntry[] = [];
  private collapsedCrumbCount = 0;
  private lastObservedWidth = 0;
  private resizeObserver: ResizeObserver | null = null;
  private mobileCollapsed = false;
  private lastWasSubPage = false;
  private lastRacesTab = "";
  private readonly lastScrollTopByEl = new WeakMap<EventTarget, number>();
  private readonly downScrollAnchorByEl = new WeakMap<EventTarget, number>();

  constructor(el: HTMLElement, store: AppStore, api: ApiClient, router: Router, announcer: Announcer) {
    super(el);
    this.store = store;
    this.api = api;
    this.router = router;
    this.announcer = announcer;

    el.addEventListener("click", this.handleClick);
    document.addEventListener("pointerdown", this.handleOutsidePointer, true);
    window.addEventListener("scroll", this.handleGlobalScroll, { capture: true, passive: true });
    document.addEventListener("keydown", this.handleKeyDown);
    this.onDispose(() => {
      el.removeEventListener("click", this.handleClick);
      document.removeEventListener("pointerdown", this.handleOutsidePointer, true);
      window.removeEventListener("scroll", this.handleGlobalScroll, true);
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
        this.setMobileCollapsed(false);
        this.lastScrollTopByEl.set(document, 0);
        this.downScrollAnchorByEl.set(document, 0);
        this.render();
      })
    );
    this.onDispose(store.subscribe(["status", "config", "race", "practice", "laps"], () => this.render()));
    this.onDispose(announcer.subscribe(() => this.render()));
    this.onDispose(usbPool.onChange(() => this.render()));
    this.onDispose(api.hubBridge.subscribe(() => this.render()));
    this.onDispose(sharedLapRFLink.subscribe(() => this.render()));
    this.onDispose(sharedRHLink.subscribe(() => this.render()));
    this.onDispose(sharedLapRFEmulatorRelay.subscribe(() => this.render()));
    this.onDispose(subscribeCapabilities(() => this.render()));
    this.onDispose(
      onRacesTopBarContextChange(() => {
        const curTab = getRacesTopBarContext().tab;
        if (curTab !== this.lastRacesTab) {
          this.lastRacesTab = curTab;
          this.setMobileCollapsed(false);
          this.lastScrollTopByEl.set(document, 0);
          this.downScrollAnchorByEl.set(document, 0);
        }
        this.render();
      })
    );
    this.onDispose(onPracticeTopBarContextChange(() => this.render()));
    this.onDispose(onAnalyticsScopeChange(() => this.render()));
    this.onDispose(onAnalyticsTopBarContextChange(() => this.render()));
    this.onDispose(onSidebarCollapsedChange(() => this.render()));
    this.onDispose(subscribeAppTheme(() => this.render()));
    this.render();
  }

  private setMobileCollapsed(collapsed: boolean): void {
    if (this.mobileCollapsed === collapsed) return;
    this.mobileCollapsed = collapsed;
    this.el.classList.toggle("is-mobile-collapsed", collapsed);
    this.el.closest(".app")?.classList.toggle("is-mobile-topbar-collapsed", collapsed);
  }

  private handleGlobalScroll = (e: Event): void => {
    const target = e.target;
    if (!target) return;
    if (this.router.route === "races" && getRacesTopBarContext().tab !== "directory") {
      if (this.mobileCollapsed) {
        this.setMobileCollapsed(false);
      }
      return;
    }
    let curTop = 0;
    let keyTarget: EventTarget = target;
    if (
      target === window ||
      target === document ||
      target === document.documentElement ||
      target === document.body
    ) {
      keyTarget = document;
      curTop = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    } else if (target instanceof HTMLElement) {
      if (
        target.closest(
          ".sidebar, .topbar, .custom-select-popover, .mgp-page-backdrop, .lap-editor-backdrop, .lap-ed-table-wrap, .table-scroll, .rc-panel-body, .rc-mobile-laps-scroll, [data-mre-carousel], [data-mre-stepper], [data-rc-topleft-track], .races-page:not(.is-configure-page) .races-page-stack, .practice-mobile-analytics-wrap, .practice-mobile-review-wrap, .practice-mobile-ai-wrap"
        )
      ) {
        return;
      }
      curTop = target.scrollTop;
    } else {
      return;
    }
    const prevTop = this.lastScrollTopByEl.get(keyTarget) ?? 0;
    this.lastScrollTopByEl.set(keyTarget, curTop);
    if (curTop <= 16) {
      this.downScrollAnchorByEl.set(keyTarget, curTop);
      this.setMobileCollapsed(false);
    } else if (curTop < prevTop - 8) {
      this.downScrollAnchorByEl.set(keyTarget, curTop);
      this.setMobileCollapsed(false);
    } else if (curTop > prevTop) {
      const anchor = this.downScrollAnchorByEl.get(keyTarget) ?? 0;
      if (!this.downScrollAnchorByEl.has(keyTarget)) {
        this.downScrollAnchorByEl.set(keyTarget, anchor);
      }
      if (curTop >= 68 && curTop - anchor >= 64) {
        this.setMobileCollapsed(true);
      }
    }
  };

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
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && (this.menuOpen || this.scopeMenuOpen || this.crumbMenuOpen)) {
      this.setMenuOpen(false);
      if (this.scopeMenuOpen || this.crumbMenuOpen) {
        this.scopeMenuOpen = false;
        this.crumbMenuOpen = false;
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
      case "toggle-mobile-topbar":
        e.preventDefault();
        e.stopPropagation();
        if (this.handleDragged) {
          this.handleDragged = false;
          return;
        }
        this.setMobileCollapsed(!this.mobileCollapsed);
        return;
      case "menu":
        this.setMenuOpen(!this.menuOpen);
        break;
      case "expand-sidebar":
        toggleSidebarCollapsed();
        break;
      case "races-back":
        e.preventDefault();
        dispatchRacesTopBarCommand({ type: "set-tab", tab: "directory" });
        break;
      case "practice-back":
        e.preventDefault();
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
        if (main.connecting || main.reconnecting || main.busyLabel) {
          void main.cancelConnect();
          return;
        }
        if (main.connected) {
          openDeviceConnectionSheet({
            console: main,
            bluetoothMode: this.store.timingHardwareMode === "slaprf_ble",
          });
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
        this.announcer.toggleEnabledFromGesture();
        break;
      case "pack":
        void this.api.simulatePack();
        break;
    }
  };

  private render(): void {
    const meta = this.router.meta();
    const { laprfEmulator, simulatorRunning: sim } = this.store;
    const emulConnected = laprfEmulator.connectedClients > 0;
    const emulEnabled = sharedLapRFEmulatorRelay.snapshot.enabled;
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
    const inPracticeWorkspace = meta.id === "practice" && pCtx.tab === "session";
    const inAnalytics = meta.id === "pilot";
    const aTopCtx = getAnalyticsTopBarContext();
    const rawAnalyticsScope = inAnalytics ? getAnalyticsScope() : null;
    const aScope = rawAnalyticsScope ? this.store.resolveAnalyticsScope(rawAnalyticsScope) : null;
    const inAnalyticsScope = inAnalytics && (aTopCtx.mode === "scope" || Boolean(aScope));
    const isSubPage = inRaceWorkspace || inPracticeWorkspace || inAnalyticsScope;
    const scopePopoverCounts =
      inAnalytics && this.scopeMenuOpen
        ? `${this.store.practiceSessions.map((s) => `${s.sessionId}:${s.name}:${s.active ? 1 : 0}:${s.laps.length}`).join("|")}::${this.store.races.map((r) => `${r.raceId ?? ""}:${r.config.eventName}:${r.lifecycle ?? ""}`).join("|")}`
        : "";

    const appTheme = getAppTheme();
    const isBleMode = hwMode === "slaprf_ble";
    const isNetMode = hwMode === "slaprf_net";
    const pairedBleHub = isBleMode ? getPairedBluetoothHub() : null;
    const sig = `${meta.id}:${appTheme}:${hwMode}:${sim ? 1 : 0}:${caps.demoMode ? 1 : 0}:${caps.portable ? 1 : 0}:${lockedOut ? 1 : 0}:${caps.remoteBackend ? 1 : 0}:${caps.backendBaseUrl}:${caps.localDetectedUrl ?? ""}:${emulEnabled ? 1 : 0}:${voiceOn ? 1 : 0}:${emulConnected ? 1 : 0}:${this.scopeMenuOpen ? 1 : 0}:${this.crumbMenuOpen ? 1 : 0}:${usbOn ? 1 : 0}:${activeLabel}:${usbFp}:${usbBusy}:${pairedBleHub?.fp ?? ""}:${led.color}:${led.shortLabel}:${led.detail}:${sbCollapsed ? 1 : 0}:${rCtx.tab}:${rCtx.raceId ?? ""}:${rCtx.raceName}:${rCtx.activeStage}:${rCtx.totalStages}:${rCtx.stageTitle}:${rCtx.live ? 1 : 0}:${pCtx.tab}:${pCtx.sessionId ?? ""}:${pCtx.sessionName}:${pCtx.active ? 1 : 0}:${aTopCtx.mode}:${aScope ? `${aScope.kind}:${aScope.id}:${aScope.name}:${aScope.live ? 1 : 0}` : ""}:${scopePopoverCounts}`;
    this.el.classList.toggle("has-subpage-back", isSubPage);
    this.el.closest(".app")?.classList.toggle("is-mobile-subpage", isSubPage);
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

    const usbSupported = TimerConsole.supported() && !lockedOut;
    const usbBtnText = usbOn
      ? activeLabel
        ? `Connected · ${esc(activeLabel)}`
        : "Connected"
      : usbBusy
        ? `${esc(usbBusy)}…`
        : isBleMode
          ? pairedBleHub
            ? "Connect"
            : "Pair Device"
          : "Connect";
    const usbTitle = !usbSupported
      ? isBleMode
        ? "Connect a SlapRF Server or open the mobile app to connect a Bluetooth Hub"
        : isNetMode
          ? "Connect a SlapRF Server to connect to a PoE Ethernet Bridge"
          : "Connect a SlapRF Server to open USB serial ports"
      : usbOn
        ? `Connected over ${main.transportLabel === "Bluetooth" || isBleMode ? "Bluetooth" : main.transportLabel === "Ethernet" || isNetMode ? "Ethernet" : "USB"}${activeLabel ? ` (${activeLabel}${usbFp ? ` · ${usbFp}` : ""})` : ""} · click for connection options`
        : isBleMode
          ? pairedBleHub
            ? `Connect to paired Bluetooth Hub ${pairedBleHub.label} (${pairedBleHub.fp})`
            : "Pair a SlapRF Bluetooth Hub"
          : isNetMode
            ? "Connect to a SlapRF PoE Ethernet Bridge (:5480)"
            : "Connect a timer over USB-C";

    const usbBtn =
      isSlapRFMode(hwMode)
        ? `
      <button type="button" class="btn ${usbOn ? "btn-armed" : "btn-ghost"}" data-action="usb-toggle" ${usbSupported && !usbBusy ? "" : "disabled"} title="${esc(usbTitle)}" aria-label="${esc(usbTitle)}">
        ${usbOn ? icons.plug(19) : icons.plugOff(19)}<span class="topbar-btn-label">${usbBtnText}</span>
      </button>`
        : "";

    const ledIndicator = `
      <button type="button" class="topbar-conn-led is-${led.color}" data-action="go-network" ${lockedOut ? "disabled" : ""} title="${esc(lockedOut ? "Connect a SlapRF Server in Datasource" : led.detail)}" aria-label="${esc(lockedOut ? "Connect a SlapRF Server in Datasource" : led.detail)}">
        <span class="topbar-conn-led-bulb" aria-hidden="true"></span>
      </button>`;

    let actions = simBtn;
    if (meta.id === "sim" || meta.id === "practice") {
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
      this.store.timingHardwareMode === "laprf_usb" ||
      this.store.timingHardwareMode === "rotorhazard" ||
      this.store.timingHardwareMode === "rotorhazard_usb";
    const effectiveSimForNav = lockedOut ? false : sim;
    const navItems = ROUTES.filter(
      (r) =>
        !r.hiddenFromNav &&
        (!r.simOnly || effectiveSimForNav) &&
        (!r.laprfEmulatorOnly || (emulEnabled && !isExternalTimer && !lockedOut))
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
    const raceMultiGPHref = buildRacesHash("multigp", raceSlug);
    const practiceDirHref = buildPracticeHash("directory");
    const practiceSessionHref = buildPracticeHash("session", practiceSlug);

    const wsIsLive = Boolean((inRaceWorkspace && rCtx.live) || (inPracticeWorkspace && pCtx.active));
    const wsLivePillHtml = wsIsLive
      ? `<span class="topbar-ws-live-pill" data-ws-live-pill title="Live RF timing active"><span class="topbar-ws-live-dot" aria-hidden="true"></span><span>LIVE</span></span>`
      : "";

    const raceCrumbs: Array<{
      label: string;
      href: string;
      title: string;
      action?: string;
      iconHtml?: string;
      suffixHtml?: string;
    }> = [
      { label: "Race", href: racesDirHref, title: "All races", action: "races-back" },
      { label: raceLabel, href: raceStageHref, title: raceLabel, suffixHtml: inRaceWorkspace ? wsLivePillHtml : "" },
    ];

    const toLinkEntries = (
      crumbs: Array<{ label: string; href: string; title: string; action?: string; iconHtml?: string; suffixHtml?: string }>
    ): BreadcrumbEntry[] =>
      crumbs.map((c, idx) => {
        const isLast = idx === crumbs.length - 1;
        return {
          menuLabel: c.label,
          menuHref: c.href,
          menuAction: c.action,
          inlineHtml: isLast
            ? `<span class="topbar-crumb-item" aria-current="page" title="${esc(c.title)}">${c.iconHtml ?? ""}<span>${esc(c.label)}</span>${c.suffixHtml ?? ""}</span>`
            : `<a class="topbar-crumb-item" href="${esc(c.href)}" ${c.action ? `data-action="${esc(c.action)}"` : ""} title="${esc(c.title)}">${c.iconHtml ?? ""}<span>${esc(c.label)}</span>${c.suffixHtml ?? ""}</a>`,
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
        { label: "Practice", href: practiceDirHref, title: "All practice sessions", action: "practice-back" },
        {
          label: practiceSessionName,
          href: practiceSessionHref,
          title: practiceSessionName,
          suffixHtml: wsLivePillHtml,
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
        ? "RotorHazard USB diagnostics: binary serial self-test, RX5808 node health, live 0-255 RSSI monitor, spectrum scan & waterfall"
        : meta.id === "debug" && hwMode === "rotorhazard"
          ? "RotorHazard diagnostics: Socket.IO self-test, RX5808 node health, live 0-255 RSSI monitor, and threshold noise"
          : meta.id === "debug" && hwMode === "laprf_usb"
            ? "LapRF 8-Way USB diagnostics: USB CDC link status, 8-slot RSSI telemetry, clock sync, and supply voltage"
            : meta.id === "debug" && hwMode === "laprf"
              ? "LapRF 8-Way diagnostics: Ethernet TCP :5403 link status, 8-slot RSSI telemetry, clock sync, and supply voltage"
              : meta.id === "debug" && hwMode === "slaprf_ble"
                ? "SlapRF Bluetooth Hub diagnostics: BLE link sync, pairing state, 5.8 GHz receiver health, live RSSI monitor & spectrum scan"
                : meta.id === "debug" && hwMode === "slaprf_net"
                  ? "SlapRF Network diagnostics: PoE Ethernet TCP :5480 serial bridge, 5.8 GHz receiver health, live RSSI monitor & spectrum scan"
                  : meta.id === "network" && hwMode === "rotorhazard_usb"
                    ? "RotorHazard USB serial nodes, multi-node RX5808 tuning, and live 0-255 node RSSI"
                    : meta.id === "network" && hwMode === "rotorhazard"
                      ? "RotorHazard timing devices, per-device admin credentials, clock sync, and live 0–255 RX5808 node RSSI"
                      : meta.id === "network" && hwMode === "laprf_usb"
                        ? "LapRF 8-Way pucks over USB CDC serial (115200 baud), clock sync, and live 8-slot RSSI"
                        : meta.id === "network" && hwMode === "laprf"
                          ? "LapRF 8-Way pucks over Ethernet (:5403), LAN discovery, clock sync, and live 8-slot RSSI"
                          : meta.id === "network" && hwMode === "slaprf_ble"
                            ? "SlapRF Bluetooth Hub wireless connection, pairing status, and live 8-channel 5.8 GHz RSSI"
                            : meta.id === "network" && hwMode === "slaprf_net"
                              ? "SlapRF PoE Ethernet Bridge (:5480), LAN discovery, 2.4 GHz ESP-NOW Spokes, and live 5.8 GHz RSSI"
                              : meta.subtitle;

    const hideTopLevelSubtitle = meta.id === "races" || meta.id === "practice";
    const titleMarkup =
      this.activeCrumbItems.length > 0
        ? `<nav class="${breadcrumbClass}" ${breadcrumbAttr} aria-label="${esc(breadcrumbAria)}">
             ${this.buildBreadcrumbTrailHtml(this.activeCrumbItems)}
           </nav>`
        : hideTopLevelSubtitle
          ? `<div class="topbar-title is-no-subtitle">
               <h1>${meta.title}</h1>
             </div>`
          : `<div class="topbar-title">
               <h1>${meta.title}</h1>
               <p>${pageSubtitle}</p>
             </div>`;

    const animateBackBtn = isSubPage && !this.lastWasSubPage;
    this.lastWasSubPage = isSubPage;
    const backBtnCls = `btn btn-ghost topbar-back-btn${animateBackBtn ? " is-entering" : ""}`;
    const subpageBackMarkup = inRaceWorkspace
      ? `<a class="${backBtnCls}" href="#/races" data-action="races-back" title="Back to Races" aria-label="Back to Races">
           ${icons.chevronLeft(18)}<span>Back</span>
         </a>`
      : inPracticeWorkspace
        ? `<a class="${backBtnCls}" href="#/practice" data-action="practice-back" title="Back to Practices" aria-label="Back to Practices">
             ${icons.chevronLeft(18)}<span>Back</span>
           </a>`
        : inAnalyticsScope
          ? `<a class="${backBtnCls}" href="#/pilot" data-action="analytics-chooser" title="Back to Analytics" aria-label="Back to Analytics">
               ${icons.chevronLeft(18)}<span>Back</span>
             </a>`
          : "";

    const mobileTopBrandMarkup = !isSubPage
      ? `<div class="topbar-mobile-brand" data-topbar-mobile-brand>
           <div class="brand-mark">${icons.slaprf(22)}</div>
           <div class="brand-name">SlapRF</div>
         </div>`
      : "";

    const mobileSubpageCtxMarkup =
      (inRaceWorkspace || inPracticeWorkspace) && wsLivePillHtml
        ? `<div class="topbar-mobile-subpage-ctx" data-topbar-mobile-live>${wsLivePillHtml}</div>`
        : "";

    this.el.innerHTML = `
      <div class="topbar-left">
        ${
          sbCollapsed
            ? `<button class="btn btn-ghost topbar-sidebar-expand-btn" data-action="expand-sidebar" type="button" title="Expand left navigation" aria-label="Expand left navigation">
                 ${icons.sidebarToggle(18)}
               </button>`
            : ""
        }
        ${titleMarkup}
        ${mobileTopBrandMarkup}
        ${subpageBackMarkup}
        ${mobileSubpageCtxMarkup}
        <div class="topbar-menu-wrap">
          <button class="btn btn-ghost topbar-menu-btn ${this.menuOpen ? "is-open" : ""}" data-action="menu" type="button" aria-label="${this.menuOpen ? "Close navigation menu" : "Open navigation menu"}" aria-expanded="${this.menuOpen ? "true" : "false"}">
            <span class="topbar-hamburger" aria-hidden="true"><span></span><span></span><span></span></span>
          </button>
          ${this.menuOpen ? this.buildNavPopoverHtml() : ""}
        </div>
      </div>
      <div class="topbar-actions ${inRaceWorkspace ? "is-race-workspace" : ""}">
        ${actions}
        ${usbBtn}
        ${ledIndicator}
      </div>`;

    this.el.classList.toggle("is-mobile-collapsed", this.mobileCollapsed);
    this.el.closest(".app")?.classList.toggle("is-mobile-topbar-collapsed", this.mobileCollapsed);
    this.el.classList.toggle("has-subpage-back", isSubPage);
    this.el.closest(".app")?.classList.toggle("is-mobile-subpage", isSubPage);
    this.fitActiveBreadcrumb();
  }

  private buildBreadcrumbTrailHtml(items: BreadcrumbEntry[]): string {
    const visibleHtml = items
      .map(
        (item, idx) =>
          `${idx > 0 ? `<span class="topbar-crumb-sep" aria-hidden="true">${icons.chevronRight(16)}</span>` : ""}${item.inlineHtml}`
      )
      .join("");

    return `<div class="topbar-crumb-trail">${visibleHtml}</div>`;
  }

  private fitActiveBreadcrumb(): void {
    const items = this.activeCrumbItems;
    if (items.length === 0) return;
    const navEl = this.el.querySelector<HTMLElement>("nav.topbar-breadcrumb");
    if (!navEl) return;

    let trailEl = navEl.querySelector<HTMLElement>(".topbar-crumb-trail");
    if (!trailEl) {
      navEl.innerHTML = this.buildBreadcrumbTrailHtml(items);
      trailEl = navEl.querySelector<HTMLElement>(".topbar-crumb-trail");
    }
    if (!trailEl || items.length <= 1) return;

    trailEl.classList.remove("is-root-only");
    const availW = navEl.clientWidth;
    if (availW <= 0) return;

    const firstItem = trailEl.querySelector<HTMLElement>(":scope > .topbar-crumb-item:first-child");
    const sepEl = trailEl.querySelector<HTMLElement>(":scope > .topbar-crumb-sep");
    const firstW = firstItem ? firstItem.offsetWidth : 0;
    const sepW = sepEl ? sepEl.offsetWidth : 16;
    const remainingForTitle = availW - (firstW + sepW + 12);
    if (remainingForTitle < 28) {
      trailEl.classList.add("is-root-only");
    }
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
    const emulEnabled = sharedLapRFEmulatorRelay.snapshot.enabled;
    const caps = capabilitiesSnapshot();
    const lockedOut = isServerDisconnectedLockout();
    const appTheme = getAppTheme();
    const isExternalTimer =
      this.store.timingHardwareMode === "laprf" ||
      this.store.timingHardwareMode === "laprf_usb" ||
      this.store.timingHardwareMode === "rotorhazard" ||
      this.store.timingHardwareMode === "rotorhazard_usb";
    const effectiveSimForNav = lockedOut ? false : sim;
    const navItems = ROUTES.filter(
      (r) =>
        !r.hiddenFromNav &&
        (!r.simOnly || effectiveSimForNav) &&
        (!r.laprfEmulatorOnly || (emulEnabled && !isExternalTimer && !lockedOut))
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
