import { Component } from "../core/component";
import { icons } from "../core/icons";
import {
  getRememberedRouteHash,
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
import { AppStore } from "../state/store";

export class Sidebar extends Component {
  private readonly store: AppStore;
  private readonly router: Router;

  constructor(el: HTMLElement, store: AppStore, router: Router) {
    super(el);
    this.store = store;
    this.router = router;

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
      <nav class="nav nav-flat">
        ${ROUTES.map((r) => `<a class="nav-item" href="${getRememberedRouteHash(r.id)}" data-route="${r.id}" ${r.simOnly ? 'data-sim-only="1"' : ""}${r.liveTimeOnly ? 'data-livetime-only="1"' : ""}>${r.icon()}<span>${r.label}</span></a>`).join("")}
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
      <button type="button" class="sidebar-demo-disclaimer" data-demo-disclaimer="1" hidden aria-label="Browser Demo — open Datasource settings">
        <span class="sidebar-demo-disclaimer-title">Browser Demo</span>
        <span class="sidebar-demo-disclaimer-body" data-demo-disclaimer-body>Simulated in your browser. Connect a SlapRF Server in Datasource to time real hardware.</span>
      </button>`;

    const collapseBtn = el.querySelector<HTMLButtonElement>("[data-action=collapse-sidebar]");
    const onCollapseClick = () => toggleSidebarCollapsed();
    collapseBtn?.addEventListener("click", onCollapseClick);
    const onNavClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
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
      if (routeId) {
        this.router.navigateSection(routeId);
      }
    };
    el.addEventListener("click", onNavClick);
    this.onDispose(() => {
      collapseBtn?.removeEventListener("click", onCollapseClick);
      el.removeEventListener("click", onNavClick);
    });

    this.highlight(router.route);
    this.syncRememberedHrefs();
    this.syncThemeToggler();
    this.onDispose(subscribeAppTheme(() => this.syncThemeToggler()));
    this.onDispose(router.subscribe((route) => {
      this.highlight(route);
      this.syncRememberedHrefs();
    }));
    this.onDispose(onRememberedRouteHashChange(() => this.syncRememberedHrefs()));
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
  }
}
