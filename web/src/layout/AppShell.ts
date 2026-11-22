import { computeDirectionalPinch, PinchPoint, scrollOuterPageBy } from "../core/chart_pinch";
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
import { sharedLapRFEmulatorRelay } from "../services/laprf_emulator_relay";
import { AppStore } from "../state/store";
import { PracticeView } from "../views/PracticeView";
import { LapRFEmulatorView } from "../views/LapRFEmulatorView";
import { PilotView } from "../views/PilotView";
import { PilotsView } from "../views/PilotsView";
import { RacesView } from "../views/RacesView";
import { DebugView } from "../views/DebugView";
import { FlasherView } from "../views/FlasherView";
import { NetworkView } from "../views/NetworkView";
import { SetupView } from "../views/SetupView";
import { SimView } from "../views/SimView";
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
  private neighborWarmupTimer: ReturnType<typeof setTimeout> | null = null;
  private swipePointerActive = false;
  private dragPausedRoute: RouteId | null = null;
  private dragActivatedNeighbor: RouteId | null = null;
  private resetSwipeGestureState: (() => void) | null = null;
  private pendingSwipeTransition: {
    fromRoute: RouteId;
    toRoute: RouteId;
    dx: number;
    width: number;
    scrollY: number;
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
        if (this.activeRouteId === "practice") {
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
          return;
        }
        if (this.store.hasHydrated) {
          this.scheduleIdleNeighborWarmup();
        }
      })
    );
    this.onDispose(
      sharedLapRFEmulatorRelay.subscribe(() => {
        if (!sharedLapRFEmulatorRelay.snapshot.enabled && this.router.route === "laprf-emulator") {
          this.router.navigateSection("setup");
        }
      })
    );
    this.onDispose(() => {
      this.cancelIdleNeighborWarmup();
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

  private getSwipeableMobileRoutes(): RouteId[] {
    if (isServerDisconnectedLockout()) return [];
    const simOn = this.store.simulatorRunning;
    const isExternalTimer =
      this.store.timingHardwareMode === "laprf" ||
      this.store.timingHardwareMode === "laprf_usb" ||
      this.store.timingHardwareMode === "rotorhazard" ||
      this.store.timingHardwareMode === "rotorhazard_usb";
    const caps = capabilitiesSnapshot();
    const emulOn = caps.portable && !isExternalTimer && sharedLapRFEmulatorRelay.snapshot.enabled;
    const hideFlasher = isExternalTimer;

    const primaryOrder: RouteId[] = ["races", "practice", "pilots", "network"];
    const primarySet = new Set<RouteId>(primaryOrder);
    const visibleSet = new Set<RouteId>();
    const secondary: RouteId[] = [];

    for (const r of ROUTES) {
      if (r.hiddenFromNav) continue;
      if (r.simOnly && !simOn) continue;
      if (r.laprfEmulatorOnly && !emulOn) continue;
      if (r.id === "flasher" && hideFlasher) continue;
      visibleSet.add(r.id);
      if (!primarySet.has(r.id)) {
        secondary.push(r.id);
      }
    }

    const out: RouteId[] = [];
    for (const id of primaryOrder) {
      if (visibleSet.has(id)) {
        out.push(id);
      }
    }
    out.push(...secondary);
    return out;
  }

  private isInSubPage(): boolean {
    const route = this.activeRouteId ?? this.router.route;
    const rCtx = getRacesTopBarContext();
    const pCtx = getPracticeTopBarContext();
    const aCtx = getAnalyticsTopBarContext();
    return (
      (route === "races" && rCtx.tab !== "directory") ||
      (route === "practice" && pCtx.tab === "session") ||
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

  private cancelIdleNeighborWarmup(): void {
    if (this.neighborWarmupTimer !== null) {
      clearTimeout(this.neighborWarmupTimer);
      this.neighborWarmupTimer = null;
    }
  }

  private scheduleIdleNeighborWarmup(delayMs = 240): void {
    this.cancelIdleNeighborWarmup();
    if (typeof window === "undefined" || window.innerWidth > 900) return;
    if (!this.store.hasHydrated || this.swipePointerActive || this.swipeSettleTimer !== null) return;
    this.neighborWarmupTimer = setTimeout(() => {
      this.neighborWarmupTimer = null;
      if (!this.el.isConnected || window.innerWidth > 900 || !this.store.hasHydrated) return;
      if (this.swipePointerActive || this.swipeSettleTimer !== null || this.isInSubPage()) return;
      const curRoute = this.activeRouteId ?? this.router.route;
      const available = this.getSwipeableMobileRoutes();
      const curIdx = available.indexOf(curRoute);
      if (curIdx < 0) return;
      const candidates: RouteId[] = [];
      if (curIdx + 1 < available.length) candidates.push(available[curIdx + 1]);
      if (curIdx - 1 >= 0) candidates.push(available[curIdx - 1]);
      const unmounted = candidates.filter((id) => !this.mountedViews.has(id));
      if (unmounted.length === 0) return;
      this.ensureViewMounted(unmounted[0]);
      if (unmounted.length > 1) {
        this.scheduleIdleNeighborWarmup(180);
      }
    }, delayMs);
  }

  private ensureViewMounted(route: RouteId): { host: HTMLElement; view: Component; scrollY: number } | undefined {
    let entry = this.mountedViews.get(route);
    if (entry) return entry;
    const outlet = this.slot("outlet");
    const host = document.createElement("div");
    host.className = `view view-${route} is-swipe-peek`;
    host.style.visibility = "hidden";
    host.style.transform = "translate3d(120%, 0, 0)";
    outlet.appendChild(host);
    try {
      const view = this.createView(route, host);
      entry = { host, view, scrollY: 0 };
      this.mountedViews.set(route, entry);
      scanCustomSelects(host);
      scanTableScrollIndicators(host);
      scanSettingsIntroCollapse(host);
      if (this.activeRouteId && this.activeRouteId !== route) {
        view.onDeactivate?.();
      }
    } catch (err) {
      console.error(`[AppShell] Failed to pre-mount view "${route}":`, err);
    }
    host.classList.remove("is-swipe-peek");
    host.style.visibility = "";
    host.style.transform = "";
    host.hidden = true;
    host.style.display = "none";
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
    let dragWidth = 390;
    let dragScrollY = 0;
    let dragAvailableRoutes: RouteId[] = [];
    let dragCurIdx = -1;
    let dragStagePrepared = false;
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

    const resumeDragPausedRoute = () => {
      const paused = this.dragPausedRoute;
      if (!paused) return;
      this.dragPausedRoute = null;
      if (paused === (this.activeRouteId ?? this.router.route)) {
        this.mountedViews.get(paused)?.view.onActivate?.();
      }
    };

    const deactivateDragNeighborIfUnused = () => {
      const activated = this.dragActivatedNeighbor;
      if (!activated) return;
      this.dragActivatedNeighbor = null;
      if (activated !== (this.activeRouteId ?? this.router.route)) {
        this.mountedViews.get(activated)?.view.onDeactivate?.();
      }
    };

    this.resetSwipeGestureState = () => {
      activePointers.clear();
      this.swipePointerActive = false;
      multiTouchTainted = false;
      ignoredSwipe = false;
      activePointerId = null;
      dragLock = "none";
      dragNeighborRoute = null;
      dragAvailableRoutes = [];
      dragCurIdx = -1;
      dragStagePrepared = false;
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
      dragAvailableRoutes = [];
      dragCurIdx = -1;
      dragStagePrepared = false;
      lastDx = 0;
      if (hideNeighbor) {
        deactivateDragNeighborIfUnused();
        resumeDragPausedRoute();
      }
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
          cur.classList.contains("track-canvas-viewport") ||
          cur.classList.contains("track-editor-canvas") ||
          cur.classList.contains("gate-track-scroll-shell") ||
          (cur.classList.contains("gate-track-scroll") && !cur.classList.contains("sim-track-scroll")) ||
          (cur.classList.contains("gate-unassigned-list") && !cur.classList.contains("sim-pit-list"))
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
      const available = this.getSwipeableMobileRoutes();
      if (!available.includes(curRoute) || this.isInSubPage()) {
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
      this.cancelIdleNeighborWarmup();
      this.swipePointerActive = true;
      ignoredSwipe = false;
      activePointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      startTime = performance.now();
      lastDx = 0;
      dragLock = "none";
      dragNeighborRoute = null;
      dragStagePrepared = false;
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
          const curRoute = this.activeRouteId ?? this.router.route;
          dragAvailableRoutes = this.getSwipeableMobileRoutes();
          dragCurIdx = dragAvailableRoutes.indexOf(curRoute);
          if (dragCurIdx < 0) {
            ignoredSwipe = true;
            activePointerId = null;
            return;
          }
          dragWidth = Math.max(280, outlet.clientWidth || window.innerWidth || 390);
          dragScrollY = Math.max(0, window.scrollY);
          dragLock = "x";
        } else {
          return;
        }
      }

      if (dragLock !== "x") return;

      const curRoute = this.activeRouteId ?? this.router.route;
      const curEntry = this.mountedViews.get(curRoute);
      if (!curEntry) return;

      if (!dragStagePrepared) {
        dragStagePrepared = true;
        if (this.dragPausedRoute !== curRoute) {
          this.dragPausedRoute = curRoute;
          curEntry.view.onDeactivate?.();
        }
        outlet.classList.add("is-swipe-stage");
        curEntry.host.classList.remove("is-view-enter-left", "is-view-enter-right");
        curEntry.host.classList.add("is-swipe-active");
        curEntry.host.style.transition = "none";
      }

      lastDx = dx;
      const width = dragWidth;
      const nextIdx = dx < 0 ? dragCurIdx + 1 : dx > 0 ? dragCurIdx - 1 : -1;
      const targetNeighbor: RouteId | null =
        nextIdx >= 0 && nextIdx < dragAvailableRoutes.length ? dragAvailableRoutes[nextIdx] : null;

      if (dragNeighborRoute && dragNeighborRoute !== targetNeighbor) {
        const oldNeighbor = this.mountedViews.get(dragNeighborRoute);
        if (oldNeighbor && dragNeighborRoute !== curRoute) {
          if (this.dragActivatedNeighbor === dragNeighborRoute) {
            this.dragActivatedNeighbor = null;
            oldNeighbor.view.onDeactivate?.();
          }
          oldNeighbor.host.classList.remove("is-swipe-peek");
          oldNeighbor.host.style.transition = "";
          oldNeighbor.host.style.transform = "";
          oldNeighbor.host.style.top = "";
          oldNeighbor.host.hidden = true;
          oldNeighbor.host.style.display = "none";
        }
        dragNeighborRoute = null;
      }

      if (targetNeighbor) {
        let neighborEntry = this.mountedViews.get(targetNeighbor);
        if (dragNeighborRoute !== targetNeighbor) {
          neighborEntry = this.ensureViewMounted(targetNeighbor);
          if (neighborEntry) {
            dragNeighborRoute = targetNeighbor;
            const neighborScrollY = Math.max(0, neighborEntry.scrollY || 0);
            const clampedInitDx = Math.max(-width, Math.min(width, dx));
            const initOffset = clampedInitDx < 0 ? width + clampedInitDx : -width + clampedInitDx;
            neighborEntry.host.classList.add("is-swipe-peek");
            neighborEntry.host.style.top = `${8 + dragScrollY - neighborScrollY}px`;
            neighborEntry.host.style.transition = "none";
            neighborEntry.host.style.transform = `translate3d(${initOffset}px, 0, 0)`;
            neighborEntry.host.hidden = false;
            neighborEntry.host.style.display = "";
            if (this.dragActivatedNeighbor !== targetNeighbor) {
              deactivateDragNeighborIfUnused();
              this.dragActivatedNeighbor = targetNeighbor;
              neighborEntry.view.onActivate?.();
              scanCustomSelects(neighborEntry.host);
              scanTableScrollIndicators(neighborEntry.host);
              scanSettingsIntroCollapse(neighborEntry.host);
            }
          }
        }
        if (neighborEntry) {
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
        this.swipePointerActive = false;
        multiTouchTainted = false;
      }
      if (!wasTracked) {
        if (wasDraggingX) cleanupInteractiveDrag(true);
        if (e.pointerId === activePointerId) activePointerId = null;
        this.scheduleIdleNeighborWarmup();
        return;
      }
      activePointerId = null;
      if (window.innerWidth > 900 || this.isInSubPage()) {
        if (wasDraggingX) cleanupInteractiveDrag(true);
        return;
      }
      const curRoute = this.activeRouteId ?? this.router.route;
      const available = wasDraggingX && dragAvailableRoutes.length > 0 ? dragAvailableRoutes : this.getSwipeableMobileRoutes();
      const curIdx = wasDraggingX && dragCurIdx >= 0 ? dragCurIdx : available.indexOf(curRoute);
      if (curIdx < 0) {
        if (wasDraggingX) cleanupInteractiveDrag(true);
        return;
      }

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const dt = performance.now() - startTime;
      const width = wasDraggingX ? dragWidth : Math.max(280, outlet.clientWidth || window.innerWidth || 390);

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
            scrollY: dragScrollY,
          };
        } else if (wasDraggingX) {
          cleanupInteractiveDrag(true);
        }
        dragNeighborRoute = null;
        dragLock = "none";
        dragAvailableRoutes = [];
        dragCurIdx = -1;
        dragStagePrepared = false;
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
        dragAvailableRoutes = [];
        dragCurIdx = -1;
        dragStagePrepared = false;
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
          deactivateDragNeighborIfUnused();
          resumeDragPausedRoute();
          this.scheduleIdleNeighborWarmup();
        };
        this.swipeSettleCleanup = finalizeCancel;
        this.swipeSettleTimer = setTimeout(() => {
          this.swipeSettleTimer = null;
          this.swipeSettleCleanup = null;
          finalizeCancel();
        }, 190);
      } else {
        this.scheduleIdleNeighborWarmup();
      }
    };

    const onWindowPointerCancel = (e: PointerEvent) => {
      activePointers.delete(e.pointerId);
      if (activePointers.size === 0) {
        this.swipePointerActive = false;
        multiTouchTainted = false;
      }
      if (dragLock === "x") {
        cleanupInteractiveDrag(true);
      }
      activePointerId = null;
      ignoredSwipe = true;
      this.scheduleIdleNeighborWarmup();
    };

    window.addEventListener("pointerdown", onWindowPointerDown, { capture: true, passive: true });
    outlet.addEventListener("pointerdown", onOutletPointerDown, { passive: true });
    outlet.addEventListener("touchmove", onOutletTouchMove, { passive: false });
    window.addEventListener("pointermove", onWindowPointerMove, { capture: true, passive: true });
    window.addEventListener("pointerup", onWindowPointerUp, { capture: true, passive: true });
    window.addEventListener("pointercancel", onWindowPointerCancel, { capture: true, passive: true });

    // Universal 2-finger vertical page scrolling over nested scrollable elements and non-RF interactive containers.
    // RF charts (.debug-canvas, .scope-canvas, [data-lap-ed-svg]) handle their own 2-finger page-scroll vs pinch.
    let twoFingerScrollState: {
      p1Start: PinchPoint;
      p2Start: PinchPoint;
      lastMidClientY: number;
      target: EventTarget | null;
      lockedMode: "none" | "page-scroll" | "pinch";
      delegatedToChart: boolean;
    } | null = null;

    const isRfChartHandlingOwnTwoFingerScroll = (el: EventTarget | null): boolean => {
      const node = el instanceof Element ? el : null;
      if (!node) return false;
      return Boolean(
        node.closest(
          "[data-signal-canvas], [data-spectrum-canvas], [data-waterfall-canvas], .scope-canvas, [data-lap-ed-svg]"
        )
      );
    };

    const onWindowTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const t0 = e.touches[0];
        const t1 = e.touches[1];
        twoFingerScrollState = {
          p1Start: { x: t0.clientX, y: t0.clientY },
          p2Start: { x: t1.clientX, y: t1.clientY },
          lastMidClientY: (t0.clientY + t1.clientY) * 0.5,
          target: e.target,
          lockedMode: "none",
          delegatedToChart:
            isRfChartHandlingOwnTwoFingerScroll(t0.target) ||
            isRfChartHandlingOwnTwoFingerScroll(t1.target) ||
            isRfChartHandlingOwnTwoFingerScroll(e.target),
        };
      } else {
        twoFingerScrollState = null;
      }
    };

    const canScrollInsideModalDialog = (target: EventTarget | null, modalBackdrop: HTMLElement): boolean => {
      if (!(target instanceof Element)) return false;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return true;
      }
      const dialog = target.closest<HTMLElement>(
        ".slaprf-modal, .confirm-modal, .modal-card, .pilot-dir-mobile-editor, .mobile-more-drawer-sheet, .device-conn-drawer-sheet"
      );
      if (!dialog || !modalBackdrop.contains(dialog)) {
        return false;
      }
      let cur: HTMLElement | null = target instanceof HTMLElement ? target : target.parentElement;
      while (cur && modalBackdrop.contains(cur)) {
        if (cur.scrollHeight > cur.clientHeight + 1 || cur.scrollWidth > cur.clientWidth + 1) {
          const st = window.getComputedStyle(cur);
          const oy = st.overflowY;
          const ox = st.overflowX;
          if (
            ((oy === "auto" || oy === "scroll") && cur.scrollHeight > cur.clientHeight + 1) ||
            ((ox === "auto" || ox === "scroll") && cur.scrollWidth > cur.clientWidth + 1)
          ) {
            return true;
          }
        }
        if (cur === dialog) break;
        cur = cur.parentElement;
      }
      return false;
    };

    const onWindowTouchMove = (e: TouchEvent) => {
      const openModalBackdrop = document.querySelector<HTMLElement>(
        ".slaprf-modal-backdrop:not([hidden]):not(.is-closing), .confirm-modal-backdrop:not([hidden]):not(.is-closing), .modal-backdrop:not([hidden]):not(.is-closing), .mobile-more-drawer-overlay:not([hidden]):not(.is-closing), .pilot-dir-mobile-drawer-overlay:not([hidden]):not(.is-closing), .practice-pilot-drawer-overlay:not([hidden]):not(.is-closing), .device-conn-drawer-overlay:not([hidden]):not(.is-closing)"
      );
      if (openModalBackdrop && !canScrollInsideModalDialog(e.target, openModalBackdrop)) {
        if (e.cancelable) {
          e.preventDefault();
        }
        return;
      }
      if (e.touches.length !== 2 || !twoFingerScrollState) {
        return;
      }
      if (twoFingerScrollState.delegatedToChart || twoFingerScrollState.lockedMode === "pinch") {
        return;
      }
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const p1Now = { x: t0.clientX, y: t0.clientY };
      const p2Now = { x: t1.clientX, y: t1.clientY };
      const curMidY = (t0.clientY + t1.clientY) * 0.5;
      const dyClient = curMidY - twoFingerScrollState.lastMidClientY;
      twoFingerScrollState.lastMidClientY = curMidY;

      if (twoFingerScrollState.lockedMode === "none") {
        const pinch = computeDirectionalPinch(
          twoFingerScrollState.p1Start,
          twoFingerScrollState.p2Start,
          p1Now,
          p2Now
        );
        const d1y = p1Now.y - twoFingerScrollState.p1Start.y;
        const d2y = p2Now.y - twoFingerScrollState.p2Start.y;
        const bothMovedSameVert = (d1y > 4 && d2y > 4) || (d1y < -4 && d2y < -4);
        if (pinch.mode === "page-scroll" && bothMovedSameVert) {
          twoFingerScrollState.lockedMode = "page-scroll";
        } else {
          const d0 = Math.hypot(
            twoFingerScrollState.p2Start.x - twoFingerScrollState.p1Start.x,
            twoFingerScrollState.p2Start.y - twoFingerScrollState.p1Start.y
          );
          const dNow = Math.hypot(p2Now.x - p1Now.x, p2Now.y - p1Now.y);
          if (Math.abs(dNow - d0) >= 14) {
            twoFingerScrollState.lockedMode = "pinch";
            return;
          }
        }
      }

      if (twoFingerScrollState.lockedMode === "page-scroll") {
        if (e.cancelable) {
          e.preventDefault();
        }
        scrollOuterPageBy(-dyClient, twoFingerScrollState.target);
      }
    };

    const onWindowTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        twoFingerScrollState = null;
      }
    };

    window.addEventListener("touchstart", onWindowTouchStart, { capture: true, passive: true });
    window.addEventListener("touchmove", onWindowTouchMove, { capture: true, passive: false });
    window.addEventListener("touchend", onWindowTouchEnd, { capture: true, passive: true });
    window.addEventListener("touchcancel", onWindowTouchEnd, { capture: true, passive: true });

    this.onDispose(() => {
      window.removeEventListener("pointerdown", onWindowPointerDown, true);
      outlet.removeEventListener("pointerdown", onOutletPointerDown);
      outlet.removeEventListener("touchmove", onOutletTouchMove);
      window.removeEventListener("pointermove", onWindowPointerMove, true);
      window.removeEventListener("pointerup", onWindowPointerUp, true);
      window.removeEventListener("pointercancel", onWindowPointerCancel, true);
      window.removeEventListener("touchstart", onWindowTouchStart, true);
      window.removeEventListener("touchmove", onWindowTouchMove, true);
      window.removeEventListener("touchend", onWindowTouchEnd, true);
      window.removeEventListener("touchcancel", onWindowTouchEnd, true);
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
    if (route === "laprf-emulator" && !sharedLapRFEmulatorRelay.snapshot.enabled) {
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
    const alreadyDeactivated = prevRoute !== null && this.dragPausedRoute === prevRoute;
    this.dragPausedRoute = null;
    const alreadyActivatedDuringPeek = this.dragActivatedNeighbor === route;
    if (this.dragActivatedNeighbor && this.dragActivatedNeighbor !== route) {
      this.mountedViews.get(this.dragActivatedNeighbor)?.view.onDeactivate?.();
    }
    this.dragActivatedNeighbor = null;
    if (prevEntry) {
      prevEntry.scrollY = swipeTrans ? swipeTrans.scrollY : window.scrollY;
      if (!alreadyDeactivated) {
        prevEntry.view.onDeactivate?.();
      }
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
      if (!alreadyActivatedDuringPeek) {
        entry.view.onActivate?.();
        scanCustomSelects(entry.host);
        scanTableScrollIndicators(entry.host);
        scanSettingsIntroCollapse(entry.host);
        window.requestAnimationFrame(() => {
          window.dispatchEvent(new Event("resize"));
        });
      }
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
      const { dx, width, scrollY } = swipeTrans;
      const incomingStart = dx < 0 ? width + dx : -width + dx;
      const outgoingEnd = dx < 0 ? -width : width;
      const targetScrollY = Math.max(0, entry.scrollY || 0);

      outlet.classList.add("is-swipe-stage");
      prevEntry.host.classList.remove("is-swipe-peek", "is-swipe-exiting");
      prevEntry.host.classList.add("is-swipe-active");

      const wasPeeking = entry.host.classList.contains("is-swipe-peek");
      entry.host.classList.remove("is-swipe-active", "is-swipe-exiting", "is-view-enter-left", "is-view-enter-right");
      entry.host.classList.add("is-swipe-peek");
      entry.host.style.top = `${8 + scrollY - targetScrollY}px`;

      if (!wasPeeking) {
        prevEntry.host.style.transition = "none";
        prevEntry.host.style.transform = `translate3d(${dx}px, 0, 0)`;
        entry.host.style.transition = "none";
        entry.host.style.transform = `translate3d(${incomingStart}px, 0, 0)`;
        void entry.host.offsetWidth;
      }

      prevEntry.host.style.transition = "transform 190ms cubic-bezier(0.22, 1, 0.36, 1)";
      prevEntry.host.style.transform = `translate3d(${outgoingEnd}px, 0, 0)`;
      entry.host.style.transition = "transform 190ms cubic-bezier(0.22, 1, 0.36, 1)";
      entry.host.style.transform = "translate3d(0px, 0, 0)";

      let finalized = false;
      const finalizeCommit = () => {
        if (finalized) return;
        finalized = true;
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

        if (this.activeRouteId === route) {
          this.sectionTracker.onRouteMounted(route, targetScrollY, wasCached);
          this.scheduleIdleNeighborWarmup();
        }
      };

      this.swipeSettleCleanup = finalizeCommit;
      this.swipeSettleTimer = setTimeout(() => {
        this.swipeSettleTimer = null;
        this.swipeSettleCleanup = null;
        finalizeCommit();
      }, 198);
      return;
    } else if (prevRoute && prevRoute !== route && entry) {
      const mobileRoutes = window.innerWidth <= 900 ? this.getSwipeableMobileRoutes() : null;
      const prevIdx = mobileRoutes ? mobileRoutes.indexOf(prevRoute) : ROUTES.findIndex((r) => r.id === prevRoute);
      const nextIdx = mobileRoutes ? mobileRoutes.indexOf(route) : ROUTES.findIndex((r) => r.id === route);
      this.animateActiveView(nextIdx >= 0 && prevIdx >= 0 && nextIdx < prevIdx ? "left" : "right");
    }

    this.sectionTracker.onRouteMounted(route, entry?.scrollY ?? 0, wasCached);
    this.scheduleIdleNeighborWarmup();
  }

  private createView(route: RouteId, host: HTMLElement): Component {
    switch (route) {
      case "practice":
        return new PracticeView(host, this.store, this.api);
      case "races":
        return new RacesView(host, this.store, this.api, this.announcer);
      case "pilot":
        return new PilotView(host, this.store);
      case "pilots":
        return new PilotsView(host, this.store, this.api);
      case "laprf-emulator":
        return new LapRFEmulatorView(host, this.store);
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
