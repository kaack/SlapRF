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
  pushAppHash,
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
  private swipeSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private swipeSettleCleanup: (() => void) | null = null;
  private resetSwipeGestureState: (() => void) | null = null;
  private pendingSwipeTransition: {
    fromRoute: RouteId;
    toRoute: RouteId;
    dx: number;
    width: number;
  } | null = null;
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
      this.finishSwipeSettleImmediately();
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

  private static readonly SWIPEABLE_PRIMARY_ROUTES: readonly RouteId[] = ["live", "races", "pilots", "track"];

  private getSwipeablePrimaryMobileRoutes(): RouteId[] {
    if (isServerDisconnectedLockout()) return [];
    return [...AppShell.SWIPEABLE_PRIMARY_ROUTES];
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

  private finishSwipeSettleImmediately(): void {
    if (this.swipeSettleTimer !== null) {
      clearTimeout(this.swipeSettleTimer);
      this.swipeSettleTimer = null;
    }
    if (this.swipeSettleCleanup) {
      const fn = this.swipeSettleCleanup;
      this.swipeSettleCleanup = null;
      fn();
    }
    this.pendingSwipeTransition = null;
  }

  private ensureViewMounted(route: RouteId): { host: HTMLElement; view: Component; scrollY: number } | undefined {
    let entry = this.mountedViews.get(route);
    if (entry) return entry;
    const outlet = this.slot("outlet");
    const host = document.createElement("div");
    host.className = `view view-${route}`;
    host.hidden = true;
    host.style.display = "none";
    outlet.appendChild(host);
    try {
      const view = this.createView(route, host);
      if (this.activeRouteId && this.activeRouteId !== route) {
        view.onDeactivate?.();
      }
      entry = { host, view, scrollY: 0 };
      this.mountedViews.set(route, entry);
      scanCustomSelects(host);
      scanTableScrollIndicators(host);
      scanSettingsIntroCollapse(host);
    } catch (err) {
      console.error(`[AppShell] Failed to pre-mount view "${route}":`, err);
    }
    return entry;
  }

  private installMobileSwipeNavigation(): void {
    const outlet = this.slot("outlet");
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let lastDx = 0;
    let activePointerId: number | null = null;
    let ignoredSwipe = false;
    let multiTouchTainted = false;
    let dragLock: "none" | "x" | "y" = "none";
    let dragNeighborRoute: RouteId | null = null;
    const activePointers = new Map<number, { ts: number; target: EventTarget | null }>();

    const pruneStalePointers = (now: number) => {
      for (const [id, info] of activePointers.entries()) {
        const disconnected = info.target instanceof Node && !info.target.isConnected;
        if (disconnected || now - info.ts > 1500) {
          activePointers.delete(id);
        }
      }
      if (activePointers.size <= 1 && activePointerId === null) {
        multiTouchTainted = false;
      }
    };

    this.resetSwipeGestureState = () => {
      activePointers.clear();
      multiTouchTainted = false;
      ignoredSwipe = false;
      activePointerId = null;
      dragLock = "none";
      dragNeighborRoute = null;
      lastDx = 0;
    };

    const cleanupInteractiveDrag = (hideNeighbor: boolean) => {
      const curRoute = this.activeRouteId ?? this.router.route;
      const curEntry = this.mountedViews.get(curRoute);
      if (curEntry) {
        curEntry.host.classList.remove("is-swipe-active");
        curEntry.host.style.transition = "";
        curEntry.host.style.transform = "";
      }
      if (dragNeighborRoute && dragNeighborRoute !== curRoute) {
        const neighborEntry = this.mountedViews.get(dragNeighborRoute);
        if (neighborEntry) {
          neighborEntry.host.classList.remove("is-swipe-peek", "is-swipe-exiting");
          neighborEntry.host.style.transition = "";
          neighborEntry.host.style.transform = "";
          neighborEntry.host.style.top = "";
          if (hideNeighbor) {
            neighborEntry.host.hidden = true;
            neighborEntry.host.style.display = "none";
          }
        }
      }
      outlet.classList.remove("is-swipe-stage");
      dragNeighborRoute = null;
      dragLock = "none";
      lastDx = 0;
    };

    const isInteractiveOrHorizontalSurface = (el: EventTarget | null): boolean => {
      let cur: Element | null = el instanceof Element ? el : null;
      while (cur && cur !== outlet && cur !== document.body) {
        if (
          cur instanceof HTMLCanvasElement ||
          cur instanceof HTMLInputElement ||
          cur instanceof HTMLTextAreaElement ||
          cur instanceof HTMLSelectElement ||
          cur.hasAttribute("data-rc-viewport") ||
          cur.hasAttribute("data-mre-carousel") ||
          cur.classList.contains("debug-canvas") ||
          cur.classList.contains("debug-canvas-wrap") ||
          cur.classList.contains("scope-canvas") ||
          cur.classList.contains("canvas-host") ||
          cur.classList.contains("surface-canvas") ||
          cur.classList.contains("lap-ed-svg") ||
          cur.classList.contains("lap-ed-svg-wrap") ||
          cur.classList.contains("bkt-viewport") ||
          cur.classList.contains("fmt-viewport") ||
          cur.classList.contains("net-mobile-graph") ||
          cur.classList.contains("track-canvas-viewport") ||
          cur.classList.contains("track-editor-canvas")
        ) {
          return true;
        }
        if (cur instanceof HTMLElement) {
          const style = window.getComputedStyle(cur);
          if (style.touchAction === "none") {
            return true;
          }
          const ox = style.overflowX;
          if ((ox === "auto" || ox === "scroll") && cur.scrollWidth > cur.clientWidth + 4) {
            return true;
          }
        }
        cur = cur.parentElement;
      }
      return false;
    };

    const onWindowPointerDown = (e: PointerEvent) => {
      const now = performance.now();
      pruneStalePointers(now);
      activePointers.set(e.pointerId, { ts: now, target: e.target });
      if (activePointers.size > 1) {
        // Any multi-touch gesture (such as 2-finger chart pinch) immediately cancels tab-swipe navigation
        // until every finger leaves the screen.
        if (dragLock === "x") {
          cleanupInteractiveDrag(true);
        }
        multiTouchTainted = true;
        ignoredSwipe = true;
        activePointerId = null;
      }
    };

    const onOutletPointerDown = (e: PointerEvent) => {
      this.finishSwipeSettleImmediately();
      if (multiTouchTainted || activePointers.size > 1) {
        ignoredSwipe = true;
        activePointerId = null;
        return;
      }
      if (window.innerWidth > 900) return;
      if (e.button !== 0 && e.pointerType === "mouse") return;
      const curRoute = this.activeRouteId ?? this.router.route;
      if (!AppShell.SWIPEABLE_PRIMARY_ROUTES.includes(curRoute) || this.isInSubPage()) {
        ignoredSwipe = true;
        activePointerId = null;
        return;
      }
      if (
        document.querySelector(
          ".modal-backdrop:not([hidden]), .slaprf-modal-backdrop:not([hidden]), .confirm-modal-backdrop:not([hidden]), .mobile-more-drawer-overlay:not([hidden]):not(.is-closing), .pilot-dir-mobile-drawer-overlay:not([hidden])"
        )
      ) {
        ignoredSwipe = true;
        activePointerId = null;
        return;
      }
      if (isInteractiveOrHorizontalSurface(e.target)) {
        ignoredSwipe = true;
        activePointerId = null;
        return;
      }
      ignoredSwipe = false;
      activePointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      startTime = performance.now();
      lastDx = 0;
      dragLock = "none";
      dragNeighborRoute = null;
    };

    const onOutletTouchMove = (e: TouchEvent) => {
      if (dragLock === "x" && e.cancelable) {
        e.preventDefault();
      }
    };

    const onWindowPointerMove = (e: PointerEvent) => {
      const tracked = activePointers.get(e.pointerId);
      if (tracked) tracked.ts = performance.now();
      if (multiTouchTainted || ignoredSwipe || activePointerId === null || e.pointerId !== activePointerId) {
        return;
      }
      if (window.innerWidth > 900 || this.isInSubPage()) {
        if (dragLock === "x") cleanupInteractiveDrag(true);
        ignoredSwipe = true;
        activePointerId = null;
        return;
      }

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (dragLock === "none") {
        const dist = Math.hypot(dx, dy);
        if (dist < 10) return;
        if (Math.abs(dy) >= Math.abs(dx) * 0.85) {
          dragLock = "y";
          ignoredSwipe = true;
          activePointerId = null;
          return;
        }
        if (Math.abs(dx) > Math.abs(dy) * 1.2) {
          dragLock = "x";
        } else {
          return;
        }
      }

      if (dragLock !== "x") return;

      const curRoute = this.activeRouteId ?? this.router.route;
      const available = this.getSwipeablePrimaryMobileRoutes();
      const curIdx = available.indexOf(curRoute);
      if (curIdx < 0) {
        cleanupInteractiveDrag(true);
        ignoredSwipe = true;
        activePointerId = null;
        return;
      }

      lastDx = dx;
      const width = Math.max(280, outlet.clientWidth || window.innerWidth || 390);
      const nextIdx = dx < 0 ? curIdx + 1 : dx > 0 ? curIdx - 1 : -1;
      const targetNeighbor: RouteId | null =
        nextIdx >= 0 && nextIdx < available.length ? available[nextIdx] : null;

      if (dragNeighborRoute && dragNeighborRoute !== targetNeighbor) {
        const oldNeighbor = this.mountedViews.get(dragNeighborRoute);
        if (oldNeighbor && dragNeighborRoute !== curRoute) {
          oldNeighbor.host.classList.remove("is-swipe-peek");
          oldNeighbor.host.style.transition = "";
          oldNeighbor.host.style.transform = "";
          oldNeighbor.host.style.top = "";
          oldNeighbor.host.hidden = true;
          oldNeighbor.host.style.display = "none";
        }
        dragNeighborRoute = null;
      }

      const curEntry = this.mountedViews.get(curRoute);
      if (!curEntry) return;

      outlet.classList.add("is-swipe-stage");
      curEntry.host.classList.remove("is-view-enter-left", "is-view-enter-right");
      curEntry.host.classList.add("is-swipe-active");
      curEntry.host.style.transition = "none";

      if (targetNeighbor) {
        const neighborEntry = this.ensureViewMounted(targetNeighbor);
        if (neighborEntry) {
          dragNeighborRoute = targetNeighbor;
          neighborEntry.host.hidden = false;
          neighborEntry.host.style.display = "";
          neighborEntry.host.classList.add("is-swipe-peek");
          neighborEntry.host.style.top = `${8 + Math.max(0, window.scrollY)}px`;
          neighborEntry.host.style.transition = "none";
          const clampedDx = Math.max(-width, Math.min(width, dx));
          const neighborOffset = clampedDx < 0 ? width + clampedDx : -width + clampedDx;
          curEntry.host.style.transform = `translate3d(${clampedDx}px, 0, 0)`;
          neighborEntry.host.style.transform = `translate3d(${neighborOffset}px, 0, 0)`;
          return;
        }
      }

      // Rubber-band resistance at first / last primary route
      curEntry.host.style.transform = `translate3d(${Math.round(dx * 0.22)}px, 0, 0)`;
    };

    const onWindowPointerUp = (e: PointerEvent) => {
      const wasTracked = !multiTouchTainted && !ignoredSwipe && activePointerId !== null && e.pointerId === activePointerId;
      const wasDraggingX = dragLock === "x";
      activePointers.delete(e.pointerId);
      if (activePointers.size === 0) {
        multiTouchTainted = false;
      }
      if (!wasTracked) {
        if (wasDraggingX) cleanupInteractiveDrag(true);
        if (e.pointerId === activePointerId) activePointerId = null;
        return;
      }
      activePointerId = null;
      if (window.innerWidth > 900 || this.isInSubPage()) {
        if (wasDraggingX) cleanupInteractiveDrag(true);
        return;
      }
      const curRoute = this.activeRouteId ?? this.router.route;
      const available = this.getSwipeablePrimaryMobileRoutes();
      const curIdx = available.indexOf(curRoute);
      if (curIdx < 0) {
        if (wasDraggingX) cleanupInteractiveDrag(true);
        return;
      }

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const dt = performance.now() - startTime;
      const width = Math.max(280, outlet.clientWidth || window.innerWidth || 390);

      const nextIdx = dx < 0 ? curIdx + 1 : curIdx - 1;
      const canAdvance = nextIdx >= 0 && nextIdx < available.length;
      const meetsFlickOrDrag =
        wasDraggingX
          ? Math.abs(dx) >= Math.min(88, width * 0.22) || (Math.abs(dx) >= 42 && dt <= 340)
          : dt <= 650 && Math.abs(dx) >= 54 && Math.abs(dx) >= Math.abs(dy) * 1.45;

      if (canAdvance && meetsFlickOrDrag) {
        const targetRoute = available[nextIdx];
        if (wasDraggingX && Math.abs(dx) > 4) {
          this.pendingSwipeTransition = {
            fromRoute: curRoute,
            toRoute: targetRoute,
            dx: Math.max(-width, Math.min(width, dx)),
            width,
          };
        } else if (wasDraggingX) {
          cleanupInteractiveDrag(true);
        }
        dragNeighborRoute = null;
        dragLock = "none";
        lastDx = 0;
        pushAppHash(`#/${targetRoute}`);
        return;
      }

      // Spring back to current route if drag was started but not committed
      if (wasDraggingX) {
        const curEntry = this.mountedViews.get(curRoute);
        const neighborRoute = dragNeighborRoute;
        const neighborEntry = neighborRoute ? this.mountedViews.get(neighborRoute) : undefined;
        dragNeighborRoute = null;
        dragLock = "none";
        lastDx = 0;

        if (curEntry) {
          curEntry.host.style.transition = "transform 180ms cubic-bezier(0.22, 1, 0.36, 1)";
          curEntry.host.style.transform = "translate3d(0px, 0, 0)";
        }
        if (neighborEntry) {
          neighborEntry.host.style.transition = "transform 180ms cubic-bezier(0.22, 1, 0.36, 1)";
          neighborEntry.host.style.transform = `translate3d(${dx < 0 ? width : -width}px, 0, 0)`;
        }
        const finalizeCancel = () => {
          if (curEntry) {
            curEntry.host.classList.remove("is-swipe-active");
            curEntry.host.style.transition = "";
            curEntry.host.style.transform = "";
          }
          if (neighborEntry && neighborRoute !== (this.activeRouteId ?? this.router.route)) {
            neighborEntry.host.classList.remove("is-swipe-peek", "is-swipe-exiting");
            neighborEntry.host.style.transition = "";
            neighborEntry.host.style.transform = "";
            neighborEntry.host.style.top = "";
            neighborEntry.host.hidden = true;
            neighborEntry.host.style.display = "none";
          }
          outlet.classList.remove("is-swipe-stage");
        };
        this.swipeSettleCleanup = finalizeCancel;
        this.swipeSettleTimer = setTimeout(() => {
          this.swipeSettleTimer = null;
          this.swipeSettleCleanup = null;
          finalizeCancel();
        }, 190);
      }
    };

    const onWindowPointerCancel = (e: PointerEvent) => {
      activePointers.delete(e.pointerId);
      if (activePointers.size === 0) {
        multiTouchTainted = false;
      }
      if (dragLock === "x") {
        cleanupInteractiveDrag(true);
      }
      activePointerId = null;
      ignoredSwipe = true;
    };

    window.addEventListener("pointerdown", onWindowPointerDown, { capture: true, passive: true });
    outlet.addEventListener("pointerdown", onOutletPointerDown, { passive: true });
    outlet.addEventListener("touchmove", onOutletTouchMove, { passive: false });
    window.addEventListener("pointermove", onWindowPointerMove, { capture: true, passive: true });
    window.addEventListener("pointerup", onWindowPointerUp, { capture: true, passive: true });
    window.addEventListener("pointercancel", onWindowPointerCancel, { capture: true, passive: true });
    this.onDispose(() => {
      window.removeEventListener("pointerdown", onWindowPointerDown, true);
      outlet.removeEventListener("pointerdown", onOutletPointerDown);
      outlet.removeEventListener("touchmove", onOutletTouchMove);
      window.removeEventListener("pointermove", onWindowPointerMove, true);
      window.removeEventListener("pointerup", onWindowPointerUp, true);
      window.removeEventListener("pointercancel", onWindowPointerCancel, true);
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

    const swipeTrans =
      this.pendingSwipeTransition &&
      this.pendingSwipeTransition.fromRoute === this.activeRouteId &&
      this.pendingSwipeTransition.toRoute === route
        ? this.pendingSwipeTransition
        : null;
    this.pendingSwipeTransition = null;
    this.resetSwipeGestureState?.();
    if (!swipeTrans) {
      this.finishSwipeSettleImmediately();
    }

    const prevRoute = this.activeRouteId;
    const prevEntry = prevRoute && prevRoute !== route ? this.mountedViews.get(prevRoute) : undefined;
    if (prevEntry) {
      prevEntry.scrollY = window.scrollY;
      prevEntry.view.onDeactivate?.();
      if (!swipeTrans) {
        prevEntry.host.hidden = true;
        prevEntry.host.style.display = "none";
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

    if (swipeTrans && prevEntry && entry) {
      const { dx, width } = swipeTrans;
      const incomingStart = dx < 0 ? width + dx : -width + dx;
      const outgoingEnd = dx < 0 ? -width : width;

      outlet.classList.add("is-swipe-stage");
      prevEntry.host.classList.remove("is-swipe-active", "is-swipe-peek");
      prevEntry.host.classList.add("is-swipe-exiting");
      prevEntry.host.style.top = "8px";
      prevEntry.host.style.transition = "none";
      prevEntry.host.style.transform = `translate3d(${dx}px, 0, 0)`;

      entry.host.classList.remove("is-swipe-peek", "is-swipe-exiting", "is-view-enter-left", "is-view-enter-right");
      entry.host.classList.add("is-swipe-active");
      entry.host.style.top = "";
      entry.host.style.transition = "none";
      entry.host.style.transform = `translate3d(${incomingStart}px, 0, 0)`;

      void entry.host.offsetWidth;

      prevEntry.host.style.transition = "transform 200ms cubic-bezier(0.22, 1, 0.36, 1)";
      prevEntry.host.style.transform = `translate3d(${outgoingEnd}px, 0, 0)`;
      entry.host.style.transition = "transform 200ms cubic-bezier(0.22, 1, 0.36, 1)";
      entry.host.style.transform = "translate3d(0px, 0, 0)";

      const finalizeCommit = () => {
        if (this.activeRouteId !== prevRoute) {
          prevEntry.host.hidden = true;
          prevEntry.host.style.display = "none";
        }
        prevEntry.host.classList.remove("is-swipe-exiting", "is-swipe-active", "is-swipe-peek");
        prevEntry.host.style.transition = "";
        prevEntry.host.style.transform = "";
        prevEntry.host.style.top = "";

        entry!.host.classList.remove("is-swipe-active", "is-swipe-peek", "is-swipe-exiting");
        entry!.host.style.transition = "";
        entry!.host.style.transform = "";
        entry!.host.style.top = "";
        outlet.classList.remove("is-swipe-stage");
      };

      this.swipeSettleCleanup = finalizeCommit;
      this.swipeSettleTimer = setTimeout(() => {
        this.swipeSettleTimer = null;
        this.swipeSettleCleanup = null;
        finalizeCommit();
      }, 210);
    } else if (prevRoute && prevRoute !== route && entry) {
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
