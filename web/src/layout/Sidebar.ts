import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ROUTES, RouteId, Router } from "../core/router";
import { gateLabel } from "../state/selectors";
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
        ${ROUTES.map((r) => `<a class="nav-item" href="#/${r.id}" data-route="${r.id}" ${r.simOnly ? 'data-sim-only="1"' : ""}>${r.icon()}<span>${r.label}</span></a>`).join("")}
      </nav>
      <div class="sidebar-foot">
        <div class="nav-group">Gates</div>
        <div data-slot="gates"></div>
      </div>`;

    this.highlight(router.route);
    this.onDispose(router.subscribe((route) => this.highlight(route)));
    this.onDispose(
      store.subscribe(["status", "config"], () => {
        this.syncSimNav();
        this.renderGates();
      })
    );
    this.syncSimNav();
    this.renderGates();
  }

  private syncSimNav(): void {
    const simOn = this.store.simulatorRunning;
    this.el.querySelectorAll<HTMLElement>("[data-sim-only]").forEach((a) => {
      a.style.display = simOn ? "" : "none";
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

  private renderGates(): void {
    this.slot("gates").innerHTML = this.store.pucks
      .map(
        (p) => `
        <div class="mini-gate">
          <span class="status-dot ${p.online ? "is-up" : ""}"></span>
          <span>${esc(gateLabel(this.store, p.puckId))}</span>
          <span class="mini-gate-batt mono ${p.batteryPct <= 20 ? "tone-bad" : ""}">${p.batteryPct}%</span>
        </div>`
      )
      .join("");
  }
}
