import { Component } from "../core/component";
import {
  isSidebarCollapsed,
  navigateToRouteSection,
  onSidebarCollapsedChange,
  RouteId,
  Router,
} from "../core/router";
import { SectionAnchorTracker } from "../core/section_anchors";
import { Announcer } from "../services/announcer";
import { ApiClient } from "../services/api_client";
import {
  isServerDisconnectedLockout,
  registerBackendConnectModalOpener,
  subscribeCapabilities,
} from "../services/capabilities";
import { sharedLiveTimeRelay } from "../services/livetime_relay";
import { AppStore } from "../state/store";
import { LiveView } from "../views/LiveView";
import { LiveTimeView } from "../views/LiveTimeView";
import { PilotView } from "../views/PilotView";
import { PilotsView } from "../views/PilotsView";
import { RacesView } from "../views/RacesView";
import { DebugView } from "../views/DebugView";
import { FlasherView } from "../views/FlasherView";
import { NetworkView } from "../views/NetworkView";
import { SetupView } from "../views/SetupView";
import { SimView } from "../views/SimView";
import { TrackView } from "../views/TrackView";
import { AboutView } from "../views/AboutView";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

/** Application frame: persistent sidebar + top bar, with the routed view swapped in the outlet. */
export class AppShell extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private readonly router: Router;
  private readonly announcer: Announcer;
  private readonly sectionTracker: SectionAnchorTracker;
  private readonly mountedViews = new Map<
    RouteId,
    { host: HTMLElement; view: Component; scrollY: number }
  >();
  private activeRouteId: RouteId | null = null;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient, router: Router, announcer: Announcer) {
    super(el);
    this.store = store;
    this.api = api;
    this.router = router;
    this.announcer = announcer;
    registerBackendConnectModalOpener(() => {
      navigateToRouteSection("setup", "datasource");
    });

    el.innerHTML = `
      <aside class="sidebar" data-slot="sidebar"></aside>
      <div class="main">
        <header class="topbar" data-slot="topbar"></header>
        <main class="outlet" data-slot="outlet"></main>
      </div>`;

    this.sectionTracker = new SectionAnchorTracker(this.slot("outlet"), store);
    this.adopt(new Sidebar(this.slot("sidebar"), store, router));
    this.adopt(new TopBar(this.slot("topbar"), store, api, router, announcer));

    const syncSidebarCollapsed = () => {
      this.el.classList.toggle("is-sidebar-collapsed", isSidebarCollapsed());
    };
    syncSidebarCollapsed();
    this.onDispose(onSidebarCollapsedChange(syncSidebarCollapsed));

    this.onDispose(router.subscribe((route) => this.show(route)));
    this.onDispose(
      subscribeCapabilities(() => {
        if (isServerDisconnectedLockout() && this.router.route !== "setup") {
          navigateToRouteSection("setup", "datasource");
        }
      })
    );
    this.onDispose(
      store.subscribe(["status", "race"], () => {
        if (this.store.hasHydrated && !this.store.simulatorRunning && this.router.route === "sim") {
          this.router.navigateSection("races");
        }
      })
    );
    this.onDispose(
      sharedLiveTimeRelay.subscribe(() => {
        if (!sharedLiveTimeRelay.snapshot.enabled && this.router.route === "livetime") {
          this.router.navigateSection("setup");
        }
      })
    );
    this.onDispose(() => {
      this.sectionTracker.destroy();
      for (const entry of this.mountedViews.values()) {
        entry.view.destroy();
      }
      this.mountedViews.clear();
    });
    this.show(router.route);
  }

  private show(route: RouteId): void {
    if (isServerDisconnectedLockout() && route !== "setup") {
      navigateToRouteSection("setup", "datasource");
      return;
    }
    if (route === "sim" && this.store.hasHydrated && !this.store.simulatorRunning) {
      this.router.navigateSection("races");
      return;
    }
    if (route === "livetime" && !sharedLiveTimeRelay.snapshot.enabled) {
      this.router.navigateSection("setup");
      return;
    }

    if (this.activeRouteId && this.activeRouteId !== route) {
      const prev = this.mountedViews.get(this.activeRouteId);
      if (prev) {
        prev.scrollY = window.scrollY;
        prev.view.onDeactivate?.();
        prev.host.hidden = true;
        prev.host.style.display = "none";
      }
    }

    this.activeRouteId = route;
    const outlet = this.slot("outlet");
    let entry = this.mountedViews.get(route);
    let wasCached = false;

    if (entry) {
      wasCached = true;
      entry.host.hidden = false;
      entry.host.style.display = "";
      entry.view.onActivate?.();
      window.requestAnimationFrame(() => {
        window.dispatchEvent(new Event("resize"));
      });
    } else {
      const host = document.createElement("div");
      host.className = `view view-${route}`;
      outlet.appendChild(host);
      try {
        const view = this.createView(route, host);
        entry = { host, view, scrollY: 0 };
        this.mountedViews.set(route, entry);
      } catch (err) {
        console.error(`[AppShell] Failed to mount view "${route}":`, err);
      }
    }

    this.sectionTracker.onRouteMounted(route, entry?.scrollY ?? 0, wasCached);
  }

  private createView(route: RouteId, host: HTMLElement): Component {
    switch (route) {
      case "live":
        return new LiveView(host, this.store, this.api);
      case "races":
        return new RacesView(host, this.store, this.api, this.announcer);
      case "pilot":
        return new PilotView(host, this.store);
      case "pilots":
        return new PilotsView(host, this.store, this.api);
      case "track":
        return new TrackView(host, this.store, this.api);
      case "livetime":
        return new LiveTimeView(host, this.store);
      case "sim":
        return new SimView(host, this.store, this.api);
      case "network":
        return new NetworkView(host, this.store, this.api);
      case "setup":
        return new SetupView(host, this.store, this.api, this.announcer);
      case "flasher":
        return new FlasherView(host, this.store, this.api);
      case "debug":
        return new DebugView(host, this.api, this.store);
      case "about":
        return new AboutView(host, this.store, this.api);
    }
  }
}
