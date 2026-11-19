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
import { sharedLiveTimeRelay } from "../services/livetime_relay";
import { sharedMultiGPService } from "../services/multigp_service";
import { AppStore } from "../state/store";

const PRIMARY_MOBILE_ROUTES = new Set<RouteId>(["races", "live", "pilots", "track"]);

export class Sidebar extends Component {
  private readonly store: AppStore;
  private readonly router: Router;
  private moreDrawerOpen = false;
  private moreDrawerClosing = false;
  private moreDrawerCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private moreDrawerDragStartY: number | null = null;

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
          ${visibleRoutes.map((r) => `<a class="nav-item ${PRIMARY_MOBILE_ROUTES.has(r.id) ? "is-mobile-primary" : "is-mobile-secondary"}" href="${getRememberedRouteHash(r.id)}" data-route="${r.id}" ${r.simOnly ? 'data-sim-only="1"' : ""}${r.liveTimeOnly ? 'data-livetime-only="1"' : ""}>${r.icon()}<span>${r.label}</span></a>`).join("")}
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
                ${r.simOnly ? 'data-sim-only="1"' : ""}${r.liveTimeOnly ? 'data-livetime-only="1"' : ""}
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
        openDatasourceSettings("inspect");
        return;
      }
      const navLink = target?.closest<HTMLAnchorElement>("a[data-route]");
      if (!navLink) return;
      e.preventDefault();
      const routeId = navLink.dataset.route as RouteId | undefined;
      if (isServerDisconnectedLockout() && routeId !== "setup") {
        return;
      }
      this.closeMoreDrawer(true);
      if (routeId) {
        this.router.navigateSection(routeId);
      }
    };
    el.addEventListener("click", onNavClick);
    this.onDispose(() => {
      collapseBtn?.removeEventListener("click", onCollapseClick);
      el.removeEventListener("pointerdown", onDrawerPointerDown);
      el.removeEventListener("pointermove", onDrawerPointerMove);
      el.removeEventListener("pointerup", onDrawerPointerUp);
      el.removeEventListener("pointercancel", onDrawerPointerUp);
      el.removeEventListener("click", onNavClick);
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
        this.closeMoreDrawer(true);
        this.highlight(route);
        this.syncRememberedHrefs();
        this.syncMobileSubPageState();
      })
    );
    this.onDispose(onRememberedRouteHashChange(() => this.syncRememberedHrefs()));
    this.onDispose(
      onRacesTopBarContextChange(() => {
        this.closeMoreDrawer(true);
        this.syncMobileSubPageState();
      })
    );
    this.onDispose(
      onPracticeTopBarContextChange(() => {
        this.closeMoreDrawer(true);
        this.syncMobileSubPageState();
      })
    );
    this.onDispose(
      onAnalyticsTopBarContextChange(() => {
        this.closeMoreDrawer(true);
        this.syncMobileSubPageState();
      })
    );
    this.onDispose(
      store.subscribe(["status", "config"], () => {
        this.syncConditionalNav();
      })
    );
    this.onDispose(
      sharedLiveTimeRelay.subscribe(() => {
        this.syncConditionalNav();
      })
    );
    this.onDispose(
      subscribeCapabilities(() => {
        this.syncConditionalNav();
      })
    );
    this.syncConditionalNav();
    this.syncMobileSubPageState();
  }

  private openMoreDrawer(): void {
    if (this.moreDrawerCloseTimer !== null) {
      clearTimeout(this.moreDrawerCloseTimer);
      this.moreDrawerCloseTimer = null;
    }
    this.moreDrawerClosing = false;
    this.moreDrawerOpen = true;
    const overlay = this.el.querySelector<HTMLElement>("[data-mobile-more-overlay]");
    const sheet = overlay?.querySelector<HTMLElement>(".mobile-more-drawer-sheet");
    if (overlay) {
      overlay.hidden = false;
      overlay.classList.remove("is-closing");
    }
    if (sheet) {
      sheet.classList.remove("is-entering");
      void sheet.offsetWidth;
      sheet.classList.add("is-entering");
    }
    const moreBtn = this.el.querySelector<HTMLButtonElement>('[data-action="toggle-mobile-more"]');
    moreBtn?.setAttribute("aria-expanded", "true");
    this.highlight(this.router.route);
  }

  private closeMoreDrawer(immediate = false): void {
    if (!this.moreDrawerOpen && !this.moreDrawerClosing) return;
    const overlay = this.el.querySelector<HTMLElement>("[data-mobile-more-overlay]");
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
      this.highlight(this.router.route);
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
    }, 200);
  }

  private syncMobileSubPageState(): void {
    const route = this.router.route;
    const rCtx = getRacesTopBarContext();
    const pCtx = getPracticeTopBarContext();
    const aCtx = getAnalyticsTopBarContext();
    const isSubPage =
      (route === "races" && rCtx.tab !== "directory") ||
      (route === "live" && pCtx.tab === "session") ||
      (route === "pilot" && aCtx.mode === "scope");
    this.el.closest(".app")?.classList.toggle("is-mobile-subpage", isSubPage);
  }

  private syncConditionalNav(): void {
    const lockedOut = isServerDisconnectedLockout();
    const simOn = lockedOut ? false : this.store.simulatorRunning;
    const isExternalTimer =
      this.store.timingHardwareMode === "laprf" ||
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
    const ltOn = isPortable && !isExternalTimer && sharedLiveTimeRelay.snapshot.enabled;
    this.el.querySelectorAll<HTMLElement>("[data-livetime-only]").forEach((a) => {
      a.style.display = ltOn ? "" : "none";
    });
    this.el.querySelectorAll<HTMLElement>('[data-route="flasher"]').forEach((a) => {
      a.style.display = isExternalTimer ? "none" : "";
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
      if (secMeta) {
        moreBtn.innerHTML = `${secMeta.icon()}<span>${secMeta.label}</span>`;
        moreBtn.setAttribute("aria-label", `${secMeta.label} — More navigation`);
      } else {
        moreBtn.innerHTML = `${icons.moreHorizontal(20)}<span>More</span>`;
        moreBtn.setAttribute("aria-label", "More navigation");
      }
      moreBtn.classList.toggle("is-active", this.moreDrawerOpen || isSecondaryRoute);
    }
  }
}
