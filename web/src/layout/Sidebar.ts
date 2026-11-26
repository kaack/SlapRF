import { Component } from "../core/component";
import { icons } from "../core/icons";
import {
  getAnalyticsTopBarContext,
  getPracticeTopBarContext,
  getRacesTopBarContext,
  getRememberedRouteHash,
  onAnalyticsTopBarContextChange,
  onPracticeTopBarContextChange,
  onRacesTopBarContextChange,
  onRememberedRouteHashChange,
  ROUTES,
  RouteId,
  Router,
  toggleSidebarCollapsed,
} from "../core/router";
import { AppTheme, getAppTheme, setAppTheme, subscribeAppTheme } from "../core/theme";
import {
  capabilitiesSnapshot,
  isServerDisconnectedLockout,
  openDatasourceSettings,
  subscribeCapabilities,
} from "../services/capabilities";
import { sharedLapRFEmulatorRelay } from "../services/laprf_emulator_relay";
import { sharedMultiGPService } from "../services/multigp_service";
import { usbPool } from "../services/timer_console";
import { AppStore } from "../state/store";

const PRIMARY_MOBILE_ROUTES = new Set<RouteId>(["races", "practice", "pilots", "network"]);

export class Sidebar extends Component {
  private readonly store: AppStore;
  private readonly router: Router;
  private moreDrawerOpen = false;
  private moreDrawerClosing = false;
  private moreDrawerCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private moreDrawerWarmupTimer: ReturnType<typeof setTimeout> | null = null;
  private moreDrawerWarmupRaf = 0;
  private moreDrawerPendingAction: (() => void) | null = null;
  private moreDrawerDragStartY: number | null = null;
  private lastMoreBtnKey = "";

  constructor(el: HTMLElement, store: AppStore, router: Router) {
    super(el);
    this.store = store;
    this.router = router;

    const visibleRoutes = ROUTES.filter((r) => !r.hiddenFromNav);
    const secondaryRoutes = visibleRoutes.filter((r) => !PRIMARY_MOBILE_ROUTES.has(r.id));

    el.innerHTML = `
      <div class="brand" data-brand-root>
        <div class="brand-mark">${icons.slaprf(25)}</div>
        <div class="brand-copy" data-brand-copy>
          <div class="brand-name">SlapRF</div>
        </div>
        <button type="button" class="btn btn-ghost sidebar-collapse-btn" data-action="collapse-sidebar" title="Collapse left navigation" aria-label="Collapse left navigation">
          ${icons.sidebarToggle(16)}
        </button>
      </div>
      <div class="sidebar-nav-shell">
        <nav class="nav nav-flat" data-sidebar-nav>
          ${visibleRoutes.map((r) => `<a class="nav-item ${PRIMARY_MOBILE_ROUTES.has(r.id) ? "is-mobile-primary" : "is-mobile-secondary"}" href="${getRememberedRouteHash(r.id)}" data-route="${r.id}" ${r.simOnly ? 'data-sim-only="1"' : ""}${r.laprfEmulatorOnly ? 'data-laprf-emulator-only="1"' : ""}${r.poeBridgeOnly ? 'data-poe-only="1"' : ""}>${r.icon()}<span>${r.label}</span></a>`).join("")}
          <button
            type="button"
            class="nav-item mobile-more-tab-btn"
            data-action="toggle-mobile-more"
            aria-expanded="false"
            aria-label="More navigation"
          >
            ${icons.moreHorizontal(20)}
            <span>More</span>
          </button>
          <div class="sidebar-theme-row" data-theme-toggler-row>
            <span class="sidebar-theme-label">Theme</span>
            <div class="sidebar-theme-toggler" role="group" aria-label="Color theme">
              <button type="button" class="sidebar-theme-btn" data-set-theme="dark" title="Dark theme" aria-label="Dark theme" aria-pressed="true">
                ${icons.moon(15)}
              </button>
              <button type="button" class="sidebar-theme-btn" data-set-theme="light" title="Light theme" aria-label="Light theme" aria-pressed="false">
                ${icons.sun(15)}
              </button>
            </div>
          </div>
        </nav>
      </div>
      <div class="mobile-more-drawer-overlay" data-mobile-more-overlay hidden>
        <div class="pilot-dir-mobile-drawer-backdrop" data-mobile-more-close="1"></div>
        <div class="pilot-dir-mobile-editor mobile-more-drawer-sheet" role="dialog" aria-label="More navigation">
          <div class="dir-mobile-drawer-top-bar">
            <button
              type="button"
              class="pilot-dir-mobile-drawer-handle"
              data-mobile-more-handle="1"
              data-mobile-more-close="1"
              aria-label="Drag down or tap to close"
              title="Close"
            >
              <span class="pilot-dir-mobile-drawer-grip"></span>
            </button>
          </div>
          <div class="mobile-more-grid">
            ${secondaryRoutes
              .map(
                (r) => `
              <a
                class="mobile-more-tile"
                href="${getRememberedRouteHash(r.id)}"
                data-route="${r.id}"
                ${r.simOnly ? 'data-sim-only="1"' : ""}${r.laprfEmulatorOnly ? 'data-laprf-emulator-only="1"' : ""}${r.poeBridgeOnly ? 'data-poe-only="1"' : ""}
              >
                <span class="mobile-more-tile-icon">${r.icon()}</span>
                <span class="mobile-more-tile-label">${r.label}</span>
              </a>`
              )
              .join("")}
          </div>
          <div class="mobile-more-theme-bar">
            <div class="sidebar-theme-toggler" role="group" aria-label="Color theme">
              <button type="button" class="sidebar-theme-btn" data-set-theme="dark" title="Dark theme" aria-label="Dark theme" aria-pressed="true">
                ${icons.moon(15)}<span>Dark</span>
              </button>
              <button type="button" class="sidebar-theme-btn" data-set-theme="light" title="Light theme" aria-label="Light theme" aria-pressed="false">
                ${icons.sun(15)}<span>Light</span>
              </button>
            </div>
          </div>
        </div>
      </div>
      <button type="button" class="sidebar-demo-disclaimer" data-demo-disclaimer="1" hidden aria-label="Browser Demo — open Datasource settings">
        <span class="sidebar-demo-disclaimer-title">Browser Demo</span>
        <span class="sidebar-demo-disclaimer-body" data-demo-disclaimer-body>Simulated in your browser. Connect a SlapRF Server in Datasource to time real hardware.</span>
      </button>`;

    const collapseBtn = el.querySelector<HTMLButtonElement>("[data-action=collapse-sidebar]");
    const onCollapseClick = () => toggleSidebarCollapsed();
    collapseBtn?.addEventListener("click", onCollapseClick);

    const onDrawerPointerDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || !t.closest("[data-mobile-more-handle]")) return;
      if (e.button !== 0 && e.pointerType === "mouse") return;
      this.moreDrawerDragStartY = e.clientY;
    };
    const onDrawerPointerMove = (e: PointerEvent) => {
      if (this.moreDrawerDragStartY === null) return;
      if (e.clientY - this.moreDrawerDragStartY >= 22) {
        this.moreDrawerDragStartY = null;
        this.closeMoreDrawer();
      }
    };
    const onDrawerPointerUp = () => {
      this.moreDrawerDragStartY = null;
    };
    el.addEventListener("pointerdown", onDrawerPointerDown);
    el.addEventListener("pointermove", onDrawerPointerMove);
    el.addEventListener("pointerup", onDrawerPointerUp);
    el.addEventListener("pointercancel", onDrawerPointerUp);

    const onNavClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-action=toggle-mobile-more]")) {
        e.preventDefault();
        e.stopPropagation();
        if (this.moreDrawerOpen && !this.moreDrawerClosing) {
          this.closeMoreDrawer();
        } else {
          this.openMoreDrawer();
        }
        return;
      }
      if (target?.closest("[data-mobile-more-close]")) {
        e.preventDefault();
        e.stopPropagation();
        this.closeMoreDrawer();
        return;
      }
      const themeBtn = target?.closest<HTMLButtonElement>("button[data-set-theme]");
      if (themeBtn) {
        e.preventDefault();
        const nextTheme = themeBtn.dataset.setTheme as AppTheme | undefined;
        if (nextTheme === "dark" || nextTheme === "light") {
          setAppTheme(nextTheme);
        }
        return;
      }
      if (target?.closest("[data-demo-disclaimer]")) {
        e.preventDefault();
        if (this.moreDrawerOpen || this.moreDrawerClosing) {
          this.closeMoreDrawer(false, () => openDatasourceSettings("inspect"));
        } else {
          openDatasourceSettings("inspect");
        }
        return;
      }
      const navLink = target?.closest<HTMLAnchorElement>("a[data-route]");
      if (!navLink) return;
      e.preventDefault();
      const routeId = navLink.dataset.route as RouteId | undefined;
      if (isServerDisconnectedLockout() && routeId !== "setup") {
        return;
      }
      if (this.moreDrawerOpen || this.moreDrawerClosing) {
        this.closeMoreDrawer(false, () => {
          if (routeId) {
            this.router.navigateSection(routeId);
          }
        });
        if (routeId) {
          this.el
            .querySelectorAll<HTMLElement>(".mobile-more-tile[data-route]")
            .forEach((tile) => tile.classList.toggle("is-active", tile.dataset.route === routeId));
        }
        return;
      }
      if (routeId) {
        this.router.navigateSection(routeId);
      }
    };
    el.addEventListener("click", onNavClick);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        this.scheduleMoreDrawerGpuPrewarm(260);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    this.onDispose(() => {
      collapseBtn?.removeEventListener("click", onCollapseClick);
      el.removeEventListener("pointerdown", onDrawerPointerDown);
      el.removeEventListener("pointermove", onDrawerPointerMove);
      el.removeEventListener("pointerup", onDrawerPointerUp);
      el.removeEventListener("pointercancel", onDrawerPointerUp);
      el.removeEventListener("click", onNavClick);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      this.cancelMoreDrawerGpuPrewarm();
      if (this.moreDrawerCloseTimer !== null) {
        clearTimeout(this.moreDrawerCloseTimer);
        this.moreDrawerCloseTimer = null;
      }
    });

    this.highlight(router.route);
    this.syncRememberedHrefs();
    this.syncThemeToggler();
    this.onDispose(subscribeAppTheme(() => this.syncThemeToggler()));
    this.onDispose(
      router.subscribe((route) => {
        if (this.moreDrawerOpen && !this.moreDrawerClosing) {
          this.closeMoreDrawer(false);
        }
        this.highlight(route);
        this.syncRememberedHrefs();
        this.syncMobileSubPageState();
      })
    );
    this.onDispose(onRememberedRouteHashChange(() => this.syncRememberedHrefs()));
    this.onDispose(
      onRacesTopBarContextChange(() => {
        if (this.moreDrawerOpen && !this.moreDrawerClosing) {
          this.closeMoreDrawer(false);
        }
        this.syncMobileSubPageState();
      })
    );
    this.onDispose(
      onPracticeTopBarContextChange(() => {
        if (this.moreDrawerOpen && !this.moreDrawerClosing) {
          this.closeMoreDrawer(false);
        }
        this.syncMobileSubPageState();
      })
    );
    this.onDispose(
      onAnalyticsTopBarContextChange(() => {
        if (this.moreDrawerOpen && !this.moreDrawerClosing) {
          this.closeMoreDrawer(false);
        }
        this.syncMobileSubPageState();
      })
    );
    this.onDispose(
      store.subscribe(["status", "config"], () => {
        this.syncConditionalNav();
      })
    );
    this.onDispose(
      sharedLapRFEmulatorRelay.subscribe(() => {
        this.syncConditionalNav();
      })
    );
    this.onDispose(
      subscribeCapabilities(() => {
        this.syncConditionalNav();
      })
    );
    this.onDispose(
      usbPool.onChange(() => {
        this.syncConditionalNav();
      })
    );
    this.syncConditionalNav();
    this.syncMobileSubPageState();
    this.scheduleMoreDrawerGpuPrewarm(200);
  }

  private cancelMoreDrawerGpuPrewarm(): boolean {
    let wasWarming = false;
    if (this.moreDrawerWarmupTimer !== null) {
      clearTimeout(this.moreDrawerWarmupTimer);
      this.moreDrawerWarmupTimer = null;
    }
    if (this.moreDrawerWarmupRaf !== 0) {
      window.cancelAnimationFrame(this.moreDrawerWarmupRaf);
      this.moreDrawerWarmupRaf = 0;
    }
    const overlay = this.el.querySelector<HTMLElement>("[data-mobile-more-overlay]");
    if (overlay?.classList.contains("is-gpu-prewarm")) {
      overlay.classList.remove("is-gpu-prewarm");
      wasWarming = true;
    }
    return wasWarming;
  }

  private scheduleMoreDrawerGpuPrewarm(delayMs: number): void {
    this.cancelMoreDrawerGpuPrewarm();
    if (typeof window === "undefined" || window.innerWidth > 900) return;
    if (this.moreDrawerOpen || this.moreDrawerClosing) return;
    this.moreDrawerWarmupTimer = setTimeout(() => {
      this.moreDrawerWarmupTimer = null;
      if (!this.el.isConnected || window.innerWidth > 900 || this.moreDrawerOpen || this.moreDrawerClosing) return;
      const overlay = this.el.querySelector<HTMLElement>("[data-mobile-more-overlay]");
      if (!overlay || !overlay.hidden) return;
      overlay.classList.add("is-gpu-prewarm");
      this.moreDrawerWarmupRaf = window.requestAnimationFrame(() => {
        this.moreDrawerWarmupRaf = window.requestAnimationFrame(() => {
          this.moreDrawerWarmupRaf = 0;
          overlay.classList.remove("is-gpu-prewarm");
        });
      });
    }, delayMs);
  }

  private openMoreDrawer(): void {
    const wasWarming = this.cancelMoreDrawerGpuPrewarm();
    if (this.moreDrawerCloseTimer !== null) {
      clearTimeout(this.moreDrawerCloseTimer);
      this.moreDrawerCloseTimer = null;
    }
    this.moreDrawerPendingAction = null;
    this.moreDrawerClosing = false;
    this.moreDrawerOpen = true;
    const overlay = this.el.querySelector<HTMLElement>("[data-mobile-more-overlay]");
    const sheet = overlay?.querySelector<HTMLElement>(".mobile-more-drawer-sheet");
    if (overlay) {
      if (wasWarming && sheet) {
        void sheet.offsetWidth;
      }
      overlay.classList.remove("is-closing");
      overlay.hidden = false;
    }
    sheet?.classList.add("is-entering");
    const moreBtn = this.el.querySelector<HTMLButtonElement>('[data-action="toggle-mobile-more"]');
    moreBtn?.setAttribute("aria-expanded", "true");
    this.highlight(this.router.route);
  }

  private closeMoreDrawer(immediate = false, onClosed?: () => void): void {
    this.cancelMoreDrawerGpuPrewarm();
    if (onClosed) {
      this.moreDrawerPendingAction = onClosed;
    }
    if (!this.moreDrawerOpen && !this.moreDrawerClosing) {
      const pending = this.moreDrawerPendingAction;
      this.moreDrawerPendingAction = null;
      pending?.();
      return;
    }
    const overlay = this.el.querySelector<HTMLElement>("[data-mobile-more-overlay]");
    const sheet = overlay?.querySelector<HTMLElement>(".mobile-more-drawer-sheet");
    const moreBtn = this.el.querySelector<HTMLButtonElement>('[data-action="toggle-mobile-more"]');
    moreBtn?.setAttribute("aria-expanded", "false");
    if (!overlay || immediate) {
      if (this.moreDrawerCloseTimer !== null) {
        clearTimeout(this.moreDrawerCloseTimer);
        this.moreDrawerCloseTimer = null;
      }
      this.moreDrawerOpen = false;
      this.moreDrawerClosing = false;
      if (overlay) {
        overlay.hidden = true;
        overlay.classList.remove("is-closing");
      }
      sheet?.classList.remove("is-entering");
      this.highlight(this.router.route);
      const pending = this.moreDrawerPendingAction;
      this.moreDrawerPendingAction = null;
      pending?.();
      return;
    }
    if (this.moreDrawerClosing) return;
    this.moreDrawerClosing = true;
    this.moreDrawerOpen = false;
    overlay.classList.add("is-closing");
    this.highlight(this.router.route);
    if (this.moreDrawerCloseTimer !== null) {
      clearTimeout(this.moreDrawerCloseTimer);
    }
    this.moreDrawerCloseTimer = setTimeout(() => {
      this.moreDrawerCloseTimer = null;
      this.moreDrawerClosing = false;
      overlay.hidden = true;
      overlay.classList.remove("is-closing");
      sheet?.classList.remove("is-entering");
      const pending = this.moreDrawerPendingAction;
      this.moreDrawerPendingAction = null;
      pending?.();
    }, 195);
  }

  private syncMobileSubPageState(): void {
    const route = this.router.route;
    const rCtx = getRacesTopBarContext();
    const pCtx = getPracticeTopBarContext();
    const aCtx = getAnalyticsTopBarContext();
    const isSubPage =
      (route === "races" && rCtx.tab !== "directory") ||
      (route === "practice" && pCtx.tab === "session") ||
      (route === "pilot" && aCtx.mode === "scope");
    this.el.closest(".app")?.classList.toggle("is-mobile-subpage", isSubPage);
  }

  private syncConditionalNav(): void {
    const lockedOut = isServerDisconnectedLockout();
    const simOn = lockedOut ? false : this.store.simulatorRunning;
    const isExternalTimer =
      this.store.timingHardwareMode === "laprf" ||
      this.store.timingHardwareMode === "laprf_usb" ||
      this.store.timingHardwareMode === "rotorhazard" ||
      this.store.timingHardwareMode === "rotorhazard_usb";
    const caps = capabilitiesSnapshot();
    const isPortable = caps.portable;
    const isDemo = caps.demoMode && !lockedOut;

    const demoDisclaimer = this.el.querySelector<HTMLElement>("[data-demo-disclaimer]");
    const demoDisclaimerBody = this.el.querySelector<HTMLElement>("[data-demo-disclaimer-body]");
    if (demoDisclaimer) {
      demoDisclaimer.hidden = !isDemo;
    }
    if (demoDisclaimerBody) {
      demoDisclaimerBody.textContent = caps.localDetectedUrl
        ? `Simulated in browser (${caps.localDetectedUrl} detected). Click to connect Server.`
        : "Simulated in your browser. Click to connect a SlapRF Server for real hardware.";
    }

    this.el.querySelectorAll<HTMLElement>("[data-sim-only]").forEach((a) => {
      a.style.display = simOn ? "" : "none";
    });
    const emulOn = isPortable && !isExternalTimer && sharedLapRFEmulatorRelay.snapshot.enabled;
    this.el.querySelectorAll<HTMLElement>("[data-laprf-emulator-only]").forEach((a) => {
      a.style.display = emulOn ? "" : "none";
    });
    const poeConnected =
      this.store.timingHardwareMode === "slaprf_net" &&
      (usbPool.mainConsole.connected || usbPool.mainConsole.reconnecting);
    const poeOn = !lockedOut && poeConnected;
    this.el.querySelectorAll<HTMLElement>("[data-poe-only]").forEach((a) => {
      a.style.display = poeOn ? "" : "none";
    });
    const hideUsbFlasher = isPortable && !caps.nativeUsb;
    this.el.querySelectorAll<HTMLElement>('[data-route="flasher"]').forEach((a) => {
      a.style.display = hideUsbFlasher ? "none" : "";
    });

    this.el.querySelectorAll<HTMLAnchorElement>("a[data-route]").forEach((a) => {
      const disabled = lockedOut && a.dataset.route !== "setup";
      a.classList.toggle("is-disabled", disabled);
      if (disabled) {
        a.setAttribute("aria-disabled", "true");
        a.tabIndex = -1;
      } else {
        a.removeAttribute("aria-disabled");
        a.removeAttribute("tabindex");
      }
    });
  }

  private syncRememberedHrefs(): void {
    this.el.querySelectorAll<HTMLAnchorElement>("a[data-route]").forEach((a) => {
      const rId = a.dataset.route as RouteId | undefined;
      if (!rId) return;
      a.href = this.router.route === rId ? `#/${rId}` : getRememberedRouteHash(rId);
    });
  }

  private syncThemeToggler(): void {
    const mode = getAppTheme();
    this.el.querySelectorAll<HTMLButtonElement>("button[data-set-theme]").forEach((btn) => {
      const active = btn.dataset.setTheme === mode;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  private highlight(route: RouteId): void {
    this.el.querySelectorAll<HTMLElement>("[data-route]").forEach((a) => {
      const active = a.dataset.route === route;
      a.classList.toggle("is-active", active);
      if (active) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    const moreBtn = this.el.querySelector<HTMLButtonElement>('[data-action="toggle-mobile-more"]');
    if (moreBtn) {
      const isSecondaryRoute = !PRIMARY_MOBILE_ROUTES.has(route);
      const secMeta = isSecondaryRoute ? ROUTES.find((r) => r.id === route) : undefined;
      const nextKey = secMeta ? `sec:${secMeta.id}` : "more";
      if (this.lastMoreBtnKey !== nextKey) {
        this.lastMoreBtnKey = nextKey;
        if (secMeta) {
          moreBtn.innerHTML = `${secMeta.icon()}<span>${secMeta.label}</span><span class="mobile-more-edge-cue" aria-hidden="true">${icons.moreVertical(20)}</span>`;
          moreBtn.setAttribute("aria-label", `${secMeta.label} — More navigation`);
        } else {
          moreBtn.innerHTML = `${icons.moreHorizontal(20)}<span>More</span>`;
          moreBtn.setAttribute("aria-label", "More navigation");
        }
      }
      moreBtn.classList.toggle("has-secondary-route", Boolean(secMeta));
      moreBtn.classList.toggle("is-active", this.moreDrawerOpen || isSecondaryRoute);
    }
  }
}
