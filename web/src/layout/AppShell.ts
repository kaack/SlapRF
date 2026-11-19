import { Component } from "../core/component";
import { scanCustomSelects } from "../core/custom_select";
import {
  getAnalyticsTopBarContext,
  getPracticeTopBarContext,
  getRacesTopBarContext,
  isSidebarCollapsed,
  navigateToRouteSection,
  onAnalyticsTopBarContextChange,
  onPracticeTopBarContextChange,
  onRacesTopBarContextChange,
  onSidebarCollapsedChange,
  RouteId,
  ROUTES,
  Router,
} from "../core/router";
import { SectionAnchorTracker } from "../core/section_anchors";
import { scanSettingsIntroCollapse } from "../core/settings_intro";
import { scanTableScrollIndicators } from "../core/table_scroll";
import { Announcer } from "../services/announcer";
import { ApiClient } from "../services/api_client";
import {
  capabilitiesSnapshot,
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
import { AboutView, preloadAboutVersion } from "../views/AboutView";
import { preloadSettingsStatuses } from "../widgets/DataSourceCard";
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
  private viewAnimTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRacesTab = getRacesTopBarContext().tab;
  private lastPracticeTab = getPracticeTopBarContext().tab;
  private lastAnalyticsMode = getAnalyticsTopBarContext().mode;

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
      onRacesTopBarContextChange(() => {
        const nextTab = getRacesTopBarContext().tab;
        if (nextTab === this.lastRacesTab) return;
        const prevTab = this.lastRacesTab;
        this.lastRacesTab = nextTab;
        if (this.activeRouteId === "races") {
          const isDrillDown = prevTab === "directory" && nextTab !== "directory";
          const isPopUp = prevTab !== "directory" && nextTab === "directory";
          if (isDrillDown) {
            this.animateActiveView("subpage-in");
          } else if (isPopUp) {
            this.animateActiveView("subpage-out");
          }
        }
      })
    );
    this.onDispose(
      onPracticeTopBarContextChange(() => {
        const nextTab = getPracticeTopBarContext().tab;
        if (nextTab === this.lastPracticeTab) return;
        this.lastPracticeTab = nextTab;
        if (this.activeRouteId === "live") {
          this.animateActiveView(nextTab === "directory" ? "subpage-out" : "subpage-in");
        }
      })
    );
    this.onDispose(
      onAnalyticsTopBarContextChange(() => {
        const nextMode = getAnalyticsTopBarContext().mode;
        if (nextMode === this.lastAnalyticsMode) return;
        this.lastAnalyticsMode = nextMode;
        if (this.activeRouteId === "pilot") {
          this.animateActiveView(nextMode === "chooser" ? "subpage-out" : "subpage-in");
        }
      })
    );
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
      if (this.viewAnimTimer !== null) {
        clearTimeout(this.viewAnimTimer);
        this.viewAnimTimer = null;
      }
      this.sectionTracker.destroy();
      for (const entry of this.mountedViews.values()) {
        entry.view.destroy();
      }
      this.mountedViews.clear();
    });
    this.installMobileSwipeNavigation();
    preloadSettingsStatuses();
    preloadAboutVersion(api);
    this.show(router.route);
  }

  private getAvailableMobileRoutes(): RouteId[] {
    const lockedOut = isServerDisconnectedLockout();
    const simOn = lockedOut ? false : this.store.simulatorRunning;
    const isExternalTimer =
      this.store.timingHardwareMode === "laprf" ||
      this.store.timingHardwareMode === "rotorhazard" ||
      this.store.timingHardwareMode === "rotorhazard_usb";
    const caps = capabilitiesSnapshot();
    const ltOn = caps.portable && !isExternalTimer && sharedLiveTimeRelay.snapshot.enabled;

    return ROUTES.filter((r) => {
      if (r.hiddenFromNav) return false;
      if (lockedOut && r.id !== "setup") return false;
      if (r.simOnly && !simOn) return false;
      if (r.liveTimeOnly && !ltOn) return false;
      if (r.id === "flasher" && isExternalTimer) return false;
      return true;
    }).map((r) => r.id);
  }

  private isInSubPage(): boolean {
    const route = this.activeRouteId ?? this.router.route;
    const rCtx = getRacesTopBarContext();
    const pCtx = getPracticeTopBarContext();
    const aCtx = getAnalyticsTopBarContext();
    return (
      (route === "races" && rCtx.tab !== "directory") ||
      (route === "live" && pCtx.tab === "session") ||
      (route === "pilot" && aCtx.mode === "scope")
    );
  }

  private installMobileSwipeNavigation(): void {
    const outlet = this.slot("outlet");
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let activePointerId: number | null = null;
    let ignoredSwipe = false;

    const canScrollHorizontally = (el: HTMLElement | null): boolean => {
      let cur: HTMLElement | null = el;
      while (cur && cur !== outlet && cur !== document.body) {
        if (
          cur instanceof HTMLInputElement ||
          cur instanceof HTMLTextAreaElement ||
          cur instanceof HTMLSelectElement ||
          cur.hasAttribute("data-rc-viewport") ||
          cur.classList.contains("pilot-picker") ||
          cur.classList.contains("track-canvas-viewport") ||
          cur.classList.contains("track-editor-canvas")
        ) {
          return true;
        }
        const style = window.getComputedStyle(cur);
        const ox = style.overflowX;
        if ((ox === "auto" || ox === "scroll") && cur.scrollWidth > cur.clientWidth + 4) {
          return true;
        }
        cur = cur.parentElement;
      }
      return false;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (window.innerWidth > 900) return;
      if (e.button !== 0 && e.pointerType === "mouse") return;
      if (this.isInSubPage()) return;
      if (
        document.querySelector(
          ".slaprf-modal-backdrop, .confirm-modal-backdrop, .mobile-more-drawer-overlay:not([hidden]), .pilot-dir-mobile-drawer-overlay, .practice-pilot-popover"
        )
      ) {
        return;
      }
      const target = e.target as HTMLElement | null;
      if (canScrollHorizontally(target)) {
        ignoredSwipe = true;
        activePointerId = null;
        return;
      }
      ignoredSwipe = false;
      activePointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      startTime = performance.now();
    };

    const onPointerUp = (e: PointerEvent) => {
      if (ignoredSwipe || activePointerId === null || e.pointerId !== activePointerId) return;
      activePointerId = null;
      if (window.innerWidth > 900 || this.isInSubPage()) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const dt = performance.now() - startTime;
      if (dt > 650) return;
      if (Math.abs(dx) < 54 || Math.abs(dx) < Math.abs(dy) * 1.45) return;

      const available = this.getAvailableMobileRoutes();
      const curRoute = this.activeRouteId ?? this.router.route;
      const curIdx = available.indexOf(curRoute);
      if (curIdx < 0) return;

      // Finger swipes left (dx < 0) -> advance to next route on the right
      // Finger swipes right (dx > 0) -> return to previous route on the left
      const nextIdx = dx < 0 ? curIdx + 1 : curIdx - 1;
      if (nextIdx < 0 || nextIdx >= available.length) return;
      this.router.navigateSection(available[nextIdx]);
    };

    const onPointerCancel = () => {
      activePointerId = null;
      ignoredSwipe = false;
    };

    const onTouchStart = (e: TouchEvent) => {
      if (window.innerWidth > 900 || e.touches.length !== 1) return;
      if (this.isInSubPage()) return;
      if (
        document.querySelector(
          ".slaprf-modal-backdrop, .confirm-modal-backdrop, .mobile-more-drawer-overlay:not([hidden]), .pilot-dir-mobile-drawer-overlay, .practice-pilot-popover"
        )
      ) {
        return;
      }
      const target = e.target as HTMLElement | null;
      if (canScrollHorizontally(target)) {
        ignoredSwipe = true;
        return;
      }
      ignoredSwipe = false;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      startTime = performance.now();
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (ignoredSwipe || e.changedTouches.length === 0) return;
      if (window.innerWidth > 900 || this.isInSubPage()) return;
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      const dt = performance.now() - startTime;
      if (dt > 650) return;
      if (Math.abs(dx) < 54 || Math.abs(dx) < Math.abs(dy) * 1.45) return;

      const available = this.getAvailableMobileRoutes();
      const curRoute = this.activeRouteId ?? this.router.route;
      const curIdx = available.indexOf(curRoute);
      if (curIdx < 0) return;

      const nextIdx = dx < 0 ? curIdx + 1 : curIdx - 1;
      if (nextIdx < 0 || nextIdx >= available.length) return;
      this.router.navigateSection(available[nextIdx]);
    };

    outlet.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    window.addEventListener("pointercancel", onPointerCancel, { passive: true });
    outlet.addEventListener("touchstart", onTouchStart, { passive: true });
    outlet.addEventListener("touchend", onTouchEnd, { passive: true });
    this.onDispose(() => {
      outlet.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      outlet.removeEventListener("touchstart", onTouchStart);
      outlet.removeEventListener("touchend", onTouchEnd);
    });
  }

  private animateActiveView(dir: "left" | "right" | "subpage-in" | "subpage-out"): void {
    if (!this.activeRouteId) return;
    const entry = this.mountedViews.get(this.activeRouteId);
    if (!entry) return;
    const host = entry.host;
    if (this.viewAnimTimer !== null) {
      clearTimeout(this.viewAnimTimer);
      this.viewAnimTimer = null;
    }
    scanCustomSelects(host);
    scanTableScrollIndicators(host);
    scanSettingsIntroCollapse(host);
    host.classList.remove(
      "is-view-enter-right",
      "is-view-enter-left",
      "is-subpage-enter",
      "is-subpage-exit"
    );
    void host.offsetWidth;
    const cls =
      dir === "subpage-in"
        ? "is-subpage-enter"
        : dir === "subpage-out"
          ? "is-subpage-exit"
          : dir === "left"
            ? "is-view-enter-left"
            : "is-view-enter-right";
    host.classList.add(cls);
    const dur = 300;
    this.viewAnimTimer = setTimeout(() => {
      this.viewAnimTimer = null;
      host.classList.remove(
        "is-view-enter-right",
        "is-view-enter-left",
        "is-subpage-enter",
        "is-subpage-exit"
      );
    }, dur);
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

    const prevRoute = this.activeRouteId;
    if (prevRoute && prevRoute !== route) {
      const prev = this.mountedViews.get(prevRoute);
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
      scanCustomSelects(entry.host);
      scanTableScrollIndicators(entry.host);
      scanSettingsIntroCollapse(entry.host);
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
      scanCustomSelects(host);
      scanTableScrollIndicators(host);
      scanSettingsIntroCollapse(host);
    }

    if (prevRoute && prevRoute !== route && entry) {
      const prevIdx = ROUTES.findIndex((r) => r.id === prevRoute);
      const nextIdx = ROUTES.findIndex((r) => r.id === route);
      this.animateActiveView(nextIdx >= 0 && prevIdx >= 0 && nextIdx < prevIdx ? "left" : "right");
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
