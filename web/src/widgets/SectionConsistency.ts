import { Component } from "../core/component";
import { fmtTime } from "../core/format";
import { sectionConsistency } from "../state/analysis";
import { AppStore } from "../state/store";
import { renderEmpty, routeLabel } from "./markup";

/** Need a few laps before "typical" means anything. */
const MIN_SAMPLES = 3;

/**
 * Per section: the pilot's typical (median) time vs. their own best on that same stretch.
 * Sections differ in length, so the gap — not the raw time — shows where practice pays off.
 */
export class SectionConsistency extends Component {
  private readonly store: AppStore;

  constructor(el: HTMLElement, store: AppStore) {
    super(el);
    this.store = store;
    this.onDispose(store.subscribe(["laps", "selection", "config"], () => this.render()));
    this.render();
  }

  private render(): void {
    const rows = sectionConsistency(this.store, this.store.selectedPilot);
    const ready = rows.filter((r) => r.samples >= MIN_SAMPLES);
    if (ready.length === 0) {
      this.el.innerHTML = renderEmpty("Not enough laps yet", `Appears after ${MIN_SAMPLES} laps through each section.`);
      return;
    }
    const maxGap = Math.max(0.001, ...ready.map((r) => r.givenAway));
    const opportunity = ready.reduce((a, b) => (b.givenAway > a.givenAway ? b : a));

    this.el.innerHTML = `
      <div class="consistency">
        ${rows
          .map((r) => {
            const enough = r.samples >= MIN_SAMPLES;
            const isTop = enough && r === opportunity && r.givenAway >= 0.02;
            const pct = enough ? (r.givenAway / maxGap) * 100 : 0;
            return `
              <div class="cons-row ${isTop ? "is-top" : ""}">
                <div class="cons-head">
                  <div class="sec-name">${routeLabel(this.store, r.fromPuckId, r.toPuckId)}</div>
                  ${isTop ? `<span class="badge badge-accent">Biggest opportunity</span>` : ""}
                </div>
                <div class="cons-figs">
                  <span>Best <strong class="mono">${fmtTime(r.best)}</strong></span>
                  <span>Typical <strong class="mono">${enough ? fmtTime(r.typical) : "—"}</strong></span>
                  <span>Exit <strong class="mono">${r.typicalExitMph.toFixed(0)}</strong><small> mph · best lap ${r.bestExitMph.toFixed(0)}</small></span>
                </div>
                <div class="cons-gap">
                  <div class="cons-track"><span style="width:${pct.toFixed(0)}%"></span></div>
                  <span class="mono">${enough ? `+${r.givenAway.toFixed(3)}` : `${r.samples}/${MIN_SAMPLES} laps`}</span>
                </div>
              </div>`;
          })
          .join("")}
      </div>`;
  }
}
