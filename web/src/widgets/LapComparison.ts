import { Component } from "../core/component";
import { esc, fmtDelta, fmtTime } from "../core/format";
import { decisiveSection, LapComparison as Comparison, resolveComparison, SectionDelta } from "../state/analysis";
import { sectionLabel, sectionShort } from "../state/selectors";
import { AppStore } from "../state/store";
import { renderEmpty, routeLabel } from "./markup";

/** Changes smaller than this are noise at 50 Hz sampling. */
const NEGLIGIBLE_SEC = 0.01;
const NOTABLE_MPH = 3;

/**
 * Section-by-section comparison between the two laps selected in LapPicker.
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
    const head = `
      <header class="card-head">
        <div>
          <h2>Analysis</h2>
          <p>Section-by-section split times and exit speeds comparing the two selected laps in detail.</p>
        </div>
      </header>`;

    const cmp = resolveComparison(this.store, this.store.selectedPilot);
    if (!cmp) {
      this.el.innerHTML = head + renderEmpty("Fly at least two laps", "Then pick a lap above to see where it gained or lost time.");
      return;
    }
    const maxAbs = Math.max(NEGLIGIBLE_SEC, ...cmp.sections.map((s) => Math.abs(s.delta)));

    this.el.innerHTML = `
      ${head}
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
    const { lap, ref, refLabel, totalDelta } = cmp;
    const abs = Math.abs(totalDelta).toFixed(3);
    const isEven = Math.abs(totalDelta) < NEGLIGIBLE_SEC;
    const isFaster = totalDelta < 0;
    const badgeCls = isEven ? "is-neutral" : isFaster ? "is-good" : "is-bad";
    const badgeText = isEven
      ? "Matched pace"
      : `${fmtDelta(totalDelta)}s ${isFaster ? "faster" : "slower"}`;

    let text: string;
    if (isEven) {
      text = `<strong>Lap ${lap.lapNumber}</strong> (${fmtTime(lap.lapTimeSec)}) matched the overall time of <strong>${esc(refLabel)}</strong> (${fmtTime(ref.lapTimeSec)}).`;
    } else {
      text = `<strong>Lap ${lap.lapNumber}</strong> (${fmtTime(lap.lapTimeSec)}) was <strong>${abs}s ${isFaster ? "faster" : "slower"}</strong> overall than <strong>${esc(refLabel)}</strong> (${fmtTime(ref.lapTimeSec)}).`;
      const key = decisiveSection(cmp);
      if (key && Math.abs(key.delta) >= NEGLIGIBLE_SEC) {
        const secTitle = `${sectionShort(this.store, key.fromPuckId)} (${sectionLabel(this.store, key.fromPuckId, key.toPuckId)})`;
        text += ` ${isFaster ? "The largest time gain came in" : "Most of the time was lost in"} <strong>${esc(secTitle)}</strong> (<span class="mono">${fmtDelta(key.delta)}s</span>)`;
        const mph = key.lapExitMph - key.refExitMph;
        text +=
          Math.abs(mph) >= NOTABLE_MPH
            ? `, exiting <strong>${Math.abs(mph).toFixed(0)} mph ${mph < 0 ? "slower" : "faster"}</strong> (${key.lapExitMph.toFixed(0)} mph vs ${key.refExitMph.toFixed(0)} mph).`
            : ".";
      }
    }
    if (cmp.incomplete) {
      text += ` <span class="muted">Some sections could not be compared because a gate was missed on one of the laps.</span>`;
    }
    return `
      <div class="insight-box">
        <div class="insight-head">
          <span class="insight-badge mono ${badgeCls}">${badgeText}</span>
          <div class="insight-chips">
            <span class="cmp-chip is-review">Lap ${lap.lapNumber} · ${fmtTime(lap.lapTimeSec)}</span>
            <span class="insight-vs">vs</span>
            <span class="cmp-chip is-ref">${esc(refLabel)} · ${fmtTime(ref.lapTimeSec)}</span>
          </div>
        </div>
        <p class="insight-body">${text}</p>
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
