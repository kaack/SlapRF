import { Component } from "../core/component";
import { fmtDelta, fmtTime } from "../core/format";
import { decisiveSection, LapComparison as Comparison, resolveComparison, SectionDelta } from "../state/analysis";
import { sectionShort } from "../state/selectors";
import { AppStore } from "../state/store";
import { renderEmpty, routeLabel } from "./markup";

/** Changes smaller than this are noise at 50 Hz sampling. */
const NEGLIGIBLE_SEC = 0.01;
const NOTABLE_MPH = 3;

/**
 * Step 2 of pilot analysis: the lap picked in step 1 against its reference, section by
 * section — where the time went and why. Selection lives in the lap picker only.
 */
export class LapComparison extends Component {
  private readonly store: AppStore;

  constructor(el: HTMLElement, store: AppStore) {
    super(el);
    this.store = store;
    this.onDispose(store.subscribe(["laps", "selection", "config"], () => this.render()));
    this.render();
  }

  private render(): void {
    const cmp = resolveComparison(this.store, this.store.selectedPilot);
    if (!cmp) {
      this.el.innerHTML = `
        <header class="card-head"><div><h2><span class="step">2</span>Where the time went</h2></div></header>
        ${renderEmpty("Fly at least two laps", "Then pick a lap above to see where it gained or lost time.")}`;
      return;
    }
    const maxAbs = Math.max(NEGLIGIBLE_SEC, ...cmp.sections.map((s) => Math.abs(s.delta)));

    this.el.innerHTML = `
      <header class="card-head">
        <div>
          <h2><span class="step">2</span>Where the time went</h2>
          <p><span class="cmp-chip is-review">Lap ${cmp.lap.lapNumber}</span> against <span class="cmp-chip is-ref">${cmp.refLabel}</span>, section by section</p>
        </div>
      </header>
      ${this.renderSummary(cmp)}
      <div class="table-scroll">
        <table class="table cmp-table">
          <thead>
            <tr>
              <th>Section</th>
              <th class="num">Lap ${cmp.lap.lapNumber}</th>
              <th class="num">Lap ${cmp.ref.lapNumber}</th>
              <th class="col-delta">Gained / lost</th>
              <th class="num">Exit speed</th>
            </tr>
          </thead>
          <tbody>${cmp.sections.map((s) => this.renderRow(s, maxAbs)).join("")}</tbody>
          <tfoot>
            <tr>
              <td>Full lap</td>
              <td class="num mono strong">${fmtTime(cmp.lap.lapTimeSec)}</td>
              <td class="num mono muted">${fmtTime(cmp.ref.lapTimeSec)}</td>
              <td class="col-delta"><span class="mono strong ${toneOf(cmp.totalDelta)}">${fmtDelta(cmp.totalDelta)}</span></td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>`;
  }

  private renderSummary(cmp: Comparison): string {
    const { lap, refLabel, totalDelta } = cmp;
    const abs = Math.abs(totalDelta).toFixed(3);
    let text: string;
    if (Math.abs(totalDelta) < NEGLIGIBLE_SEC) {
      text = `Lap ${lap.lapNumber} matched ${refLabel}.`;
    } else {
      text = `Lap ${lap.lapNumber} was <strong>${abs}s ${totalDelta < 0 ? "faster" : "slower"}</strong> than ${refLabel}.`;
      const key = decisiveSection(cmp);
      if (key && Math.abs(key.delta) >= NEGLIGIBLE_SEC) {
        text += ` ${totalDelta < 0 ? "The biggest gain came" : "Most of it went"} in <strong>${this.route(key)}</strong> (${fmtDelta(key.delta)}s)`;
        const mph = key.lapExitMph - key.refExitMph;
        text += Math.abs(mph) >= NOTABLE_MPH ? `, exiting ${Math.abs(mph).toFixed(0)} mph ${mph < 0 ? "slower" : "faster"}.` : ".";
      }
    }
    if (cmp.incomplete) {
      text += ` <span class="muted">Some sections can't be compared — a gate was missed on one of the laps.</span>`;
    }
    return `
      <div class="cmp-summary">
        <div class="cmp-total mono ${toneOf(totalDelta)}">${fmtDelta(totalDelta)}</div>
        <p>${text}</p>
      </div>`;
  }

  private renderRow(s: SectionDelta, maxAbs: number): string {
    const width = Math.min(50, (Math.abs(s.delta) / maxAbs) * 50);
    const side = s.delta > 0 ? "loss" : "gain";
    const mph = s.lapExitMph - s.refExitMph;
    return `
      <tr>
        <td>
          ${this.route(s)}
        </td>
        <td class="num mono">${s.lapSec.toFixed(3)}</td>
        <td class="num mono muted">${s.refSec.toFixed(3)}</td>
        <td class="col-delta">
          <div class="delta-cell">
            <div class="diverge"><span class="diverge-bar is-${side}" style="width:${width.toFixed(1)}%"></span></div>
            <span class="mono ${toneOf(s.delta)}">${fmtDelta(s.delta)}</span>
          </div>
        </td>
        <td class="num mono">
          ${s.lapExitMph.toFixed(0)}<small> vs ${s.refExitMph.toFixed(0)}</small>
          ${Math.abs(mph) >= NOTABLE_MPH ? `<span class="${mph < 0 ? "tone-bad" : "tone-good"}">${mph > 0 ? "+" : "−"}${Math.abs(mph).toFixed(0)}</span>` : ""}
        </td>
      </tr>`;
  }

  private route(s: { fromPuckId: number; toPuckId: number }): string {
    return routeLabel(this.store, s.fromPuckId, s.toPuckId);
  }
}

function toneOf(delta: number): string {
  if (Math.abs(delta) < NEGLIGIBLE_SEC) return "muted";
  return delta > 0 ? "tone-bad" : "tone-good";
}
