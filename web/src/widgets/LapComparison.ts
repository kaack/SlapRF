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
    const cmp = resolveComparison(this.store, this.store.selectedPilot);
    if (!cmp) {
      this.el.innerHTML = renderEmpty("Fly at least two laps", "Then click a bar above to see where that lap gained or lost time.");
      return;
    }
    const maxAbs = Math.max(NEGLIGIBLE_SEC, ...cmp.sections.map((s) => Math.abs(s.delta)));

    this.el.innerHTML = `
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
      </div>
      ${this.renderAnalysis(cmp)}`;
  }

  private sectionName(s: { fromPuckId: number; toPuckId: number }): string {
    return `${sectionShort(this.store, s.fromPuckId)} · ${sectionLabel(this.store, s.fromPuckId, s.toPuckId)}`;
  }

  /** Plain-language takeaway for the two laps, in the same style as the Recommendation card. */
  private renderAnalysis(cmp: Comparison): string {
    const { lap, ref, refLabel, totalDelta } = cmp;
    const isEven = Math.abs(totalDelta) < NEGLIGIBLE_SEC;
    const isFaster = totalDelta < 0;

    const refTime = fmtTime(ref.lapTimeSec);
    const refText = refLabel.endsWith(")") ? refLabel.replace(/\)$/, `, ${refTime})`) : `${refLabel} (${refTime})`;
    const lead = isEven
      ? `Lap ${lap.lapNumber} (${fmtTime(lap.lapTimeSec)}) matched ${esc(refText)}.`
      : `Lap ${lap.lapNumber} (${fmtTime(lap.lapTimeSec)}) was <strong>${Math.abs(totalDelta).toFixed(3)}s ${isFaster ? "faster" : "slower"}</strong> than ${esc(refText)}.`;

    const points: string[] = [];
    const key = isEven ? undefined : decisiveSection(cmp);
    if (key && Math.abs(key.delta) >= NEGLIGIBLE_SEC) {
      points.push(
        `${isFaster ? "Most of the gain came in" : "Most of the time was lost in"} <strong>${esc(this.sectionName(key))}</strong> (${fmtDelta(key.delta)}s).`
      );
      const mph = key.lapExitMph - key.refExitMph;
      if (Math.abs(mph) >= NOTABLE_MPH) {
        points.push(
          `You exited that section <strong>${Math.abs(mph).toFixed(0)} mph ${mph < 0 ? "slower" : "faster"}</strong> (${key.lapExitMph.toFixed(0)} vs ${key.refExitMph.toFixed(0)} mph)${mph < 0 && !isFaster ? " — carrying less speed out of it cost time into the next one too" : ""}.`
        );
      }
    }
    // The biggest section that went the other way, so the pilot sees what still worked (or didn't).
    const counter = cmp.sections
      .filter((s) => (isFaster ? s.delta > 0 : s.delta < 0) && Math.abs(s.delta) >= NEGLIGIBLE_SEC)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
    if (!isEven && counter) {
      points.push(
        isFaster
          ? `It wasn't faster everywhere: <strong>${esc(this.sectionName(counter))}</strong> was ${Math.abs(counter.delta).toFixed(3)}s slower.`
          : `You did gain time in <strong>${esc(this.sectionName(counter))}</strong> (${fmtDelta(counter.delta)}s).`
      );
    }
    if (cmp.incomplete) {
      points.push(`Some sections couldn't be compared because a gate was missed on one of the laps.`);
    }

    return `
      <div class="lap-analysis">
        <p class="rec-lead">${lead}</p>
        ${points.length ? `<ul class="rec-list">${points.map((p) => `<li>${p}</li>`).join("")}</ul>` : ""}
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
