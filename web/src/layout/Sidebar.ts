import { Component } from "../core/component";
import { icons } from "../core/icons";
import { ROUTES, RouteId, Router } from "../core/router";
import { sharedLiveTimeRelay } from "../services/livetime_relay";
import { AppStore } from "../state/store";

export class Sidebar extends Component {
  private readonly store: AppStore;

  constructor(el: HTMLElement, store: AppStore, router: Router) {
    super(el);
    this.store = store;

    el.innerHTML = `
      <div class="brand">
        <div class="brand-mark">${icons.slaprf(25)}</div>
        <div>
          <div class="brand-name">SlapRF</div>
          <div class="brand-sub">XIAO ESP32-C5 · 5.8 GHz</div>
        </div>
      </div>
      <nav class="nav nav-flat">
        ${ROUTES.map((r) => `<a class="nav-item" href="#/${r.id}" data-route="${r.id}" ${r.simOnly ? 'data-sim-only="1"' : ""}${r.liveTimeOnly ? 'data-livetime-only="1"' : ""}>${r.icon()}<span>${r.label}</span></a>`).join("")}
      </nav>`;

    this.highlight(router.route);
    this.onDispose(router.subscribe((route) => this.highlight(route)));
    this.onDispose(
      store.subscribe(["status"], () => {
        this.syncConditionalNav();
      })
    );
    this.onDispose(
      sharedLiveTimeRelay.subscribe(() => {
        this.syncConditionalNav();
      })
    );
    this.syncConditionalNav();
  }

  private syncConditionalNav(): void {
    const simOn = this.store.simulatorRunning;
    this.el.querySelectorAll<HTMLElement>("[data-sim-only]").forEach((a) => {
      a.style.display = simOn ? "" : "none";
    });
    const ltOn = sharedLiveTimeRelay.snapshot.enabled;
    this.el.querySelectorAll<HTMLElement>("[data-livetime-only]").forEach((a) => {
      a.style.display = ltOn ? "" : "none";
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
