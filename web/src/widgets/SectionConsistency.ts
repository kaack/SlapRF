import { Component } from "../core/component";
import { esc, fmtTime } from "../core/format";
import { bestPossibleLap, SectionConsistency as ConsistencyRow, sectionConsistency } from "../state/analysis";
import { bestLapOf, lapsFor, sectionLabel, sectionShort } from "../state/selectors";
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
    const head = `
      <header class="card-head">
        <div>
          <h2>Recommendation</h2>
          <p>Session-wide section consistency comparing typical pace against personal best splits to pinpoint where to practice.</p>
        </div>
      </header>`;

    const rows = sectionConsistency(this.store, this.store.selectedPilot);
    const ready = rows.filter((r) => r.samples >= MIN_SAMPLES);
    if (ready.length === 0) {
      this.el.innerHTML =
        head + renderEmpty("Not enough laps yet", `Appears after ${MIN_SAMPLES} laps through each section.`);
      return;
    }
    const maxGap = Math.max(0.001, ...ready.map((r) => r.givenAway));
    const sortedByGap = [...ready].sort((a, b) => b.givenAway - a.givenAway);
    const opportunity = sortedByGap[0];
    const second = sortedByGap[1];

    this.el.innerHTML = `
      ${head}
      ${this.renderRecommendationSummary(ready, opportunity, second)}
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

  private renderRecommendationSummary(
    ready: ConsistencyRow[],
    opportunity: ConsistencyRow,
    second: ConsistencyRow | undefined
  ): string {
    const slotIndex = this.store.selectedPilot;
    const laps = lapsFor(this.store, slotIndex);
    const bestLap = bestLapOf(laps);
    const possible = bestPossibleLap(this.store, slotIndex);
    const totalGivenAway = ready.reduce((sum, r) => sum + r.givenAway, 0);

    const secShort = sectionShort(this.store, opportunity.fromPuckId);
    const secTitle = `${secShort} (${sectionLabel(this.store, opportunity.fromPuckId, opportunity.toPuckId)})`;
    const hasSignificantGap = opportunity.givenAway >= 0.02;

    const badgeCls = hasSignificantGap ? "is-accent" : "is-good";
    const badgeText = hasSignificantGap
      ? `Focus: ${esc(secShort)} (−${opportunity.givenAway.toFixed(3)}s)`
      : "Dialed consistency";

    let text: string;
    if (!hasSignificantGap) {
      text = `Your typical pace is within <strong>0.020s</strong> of your personal best across every section. Focus on carrying higher entry and exit speed through <strong>${esc(secTitle)}</strong> to push your baseline lower.`;
    } else {
      const mphDrop = opportunity.bestExitMph - opportunity.typicalExitMph;
      const speedClause =
        mphDrop >= 2
          ? `, where your typical exit speed is <strong>${mphDrop.toFixed(0)} mph slower</strong> (${opportunity.typicalExitMph.toFixed(0)} mph vs ${opportunity.bestExitMph.toFixed(0)} mph)`
          : "";
      text = `Focus your next packs on <strong>${esc(secTitle)}</strong> — your typical pass (<span class="mono">${fmtTime(opportunity.typical)}</span>) gives away <strong>+${opportunity.givenAway.toFixed(3)}s</strong> compared to your personal best split (<span class="mono">${fmtTime(opportunity.best)}</span>)${speedClause}.`;

      if (second && second.givenAway >= 0.03) {
        const sec2Title = `${sectionShort(this.store, second.fromPuckId)} (${sectionLabel(this.store, second.fromPuckId, second.toPuckId)})`;
        text += ` Secondary target: <strong>${esc(sec2Title)}</strong> (<span class="mono">+${second.givenAway.toFixed(3)}s</span> typical gap).`;
      }
      if (possible > 0 && bestLap > 0 && bestLap - possible > 0.005) {
        text += ` Linking your best splits across all sections unlocks a <strong>${fmtTime(possible)}</strong> composite lap (<span class="mono">−${(bestLap - possible).toFixed(3)}s</span> faster than your current best).`;
      }
    }

    return `
      <div class="insight-box">
        <div class="insight-head">
          <span class="insight-badge mono ${badgeCls}">${badgeText}</span>
          <div class="insight-chips">
            <span class="cmp-chip is-review">Typical loss · +${totalGivenAway.toFixed(3)}s/lap</span>
            ${
              possible > 0
                ? `<span class="insight-vs">·</span><span class="cmp-chip is-ref">Best possible · ${fmtTime(possible)}</span>`
                : ""
            }
          </div>
        </div>
        <p class="insight-body">${text}</p>
      </div>`;
  }
}
