import { Component } from "../core/component";
import { RouteId, Router } from "../core/router";
import { Announcer } from "../services/announcer";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";
import { LiveView } from "../views/LiveView";
import { PilotView } from "../views/PilotView";
import { PilotsView } from "../views/PilotsView";
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
  private view: Component | null = null;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient, router: Router, announcer: Announcer) {
    super(el);
    this.store = store;
    this.api = api;
    this.router = router;
    this.announcer = announcer;

    el.innerHTML = `
      <aside class="sidebar" data-slot="sidebar"></aside>
      <div class="main">
        <header class="topbar" data-slot="topbar"></header>
        <main class="outlet" data-slot="outlet"></main>
      </div>`;

    this.adopt(new Sidebar(this.slot("sidebar"), store, router));
    this.adopt(new TopBar(this.slot("topbar"), store, api, router, announcer));

    this.onDispose(router.subscribe((route) => this.show(route)));
    this.onDispose(
      store.subscribe(["status"], () => {
        if (!this.store.simulatorRunning && this.router.route === "sim") {
          this.router.navigate("live");
        }
      })
    );
    this.onDispose(() => this.view?.destroy());
    this.show(router.route);
  }

  private show(route: RouteId): void {
    if (route === "sim" && !this.store.simulatorRunning) {
      this.router.navigate("live");
      return;
    }
    this.view?.destroy();
    const outlet = this.slot("outlet");
    outlet.replaceChildren();
    const host = document.createElement("div");
    host.className = `view view-${route}`;
    outlet.appendChild(host);
    try {
      this.view = this.createView(route, host);
    } catch (err) {
      console.error(`[AppShell] Failed to mount view "${route}":`, err);
    }
    window.scrollTo({ top: 0 });
  }

  private createView(route: RouteId, host: HTMLElement): Component {
    switch (route) {
      case "live":
        return new LiveView(host, this.store, this.api);
      case "pilot":
        return new PilotView(host, this.store);
      case "pilots":
        return new PilotsView(host, this.store, this.api);
      case "track":
        return new TrackView(host, this.store, this.api);
      case "sim":
        return new SimView(host, this.store, this.api);
      case "network":
        return new NetworkView(host, this.store, this.api);
      case "setup":
        return new SetupView(host, this.store, this.api, this.announcer);
      case "flasher":
        return new FlasherView(host, this.store, this.api);
      case "debug":
        return new DebugView(host, this.api);
      case "about":
        return new AboutView(host, this.store, this.api);
    }
  }
}
