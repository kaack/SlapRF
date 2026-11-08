import { Component } from "../core/component";
import { esc, fmtTime } from "../core/format";
import { bestPossibleLap, SectionConsistency as ConsistencyRow, sectionConsistency } from "../state/analysis";
import { bestLapOf, lapsFor, sectionLabel, sectionShort } from "../state/selectors";
import { AppStore } from "../state/store";
import { renderEmpty, routeLabel } from "./markup";

/** Need a few laps before "typical" means anything. */
const MIN_SAMPLES = 3;
/** Typical-vs-best gaps below this are within normal lap-to-lap noise. */
const SIGNIFICANT_GAP_SEC = 0.02;
/** Exit-speed drops below this aren't worth calling out. */
const NOTABLE_MPH = 2;

interface ConsistencyData {
  rows: ConsistencyRow[];
  ready: ConsistencyRow[];
  /** Ready sections, biggest typical-vs-best gap first. */
  ranked: ConsistencyRow[];
}

function loadConsistency(store: AppStore): ConsistencyData {
  const rows = sectionConsistency(store, store.selectedPilot);
  const ready = rows.filter((r) => r.samples >= MIN_SAMPLES);
  const ranked = [...ready].sort((a, b) => b.givenAway - a.givenAway);
  return { rows, ready, ranked };
}

function sectionName(store: AppStore, r: ConsistencyRow): string {
  return `${sectionShort(store, r.fromPuckId)} · ${sectionLabel(store, r.fromPuckId, r.toPuckId)}`;
}

/**
 * Per-section table for the whole session: the pilot's best time through each section,
 * their typical (median) time, and how much slower typical is than best.
 */
export class SectionStats extends Component {
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
          <h2>Section stats</h2>
          <p>Every lap this session, per section. <strong>Lost vs best</strong> is how much slower your typical pass is than your best one — the bigger it is, the more time there is to find.</p>
        </div>
      </header>`;

    const { rows, ready, ranked } = loadConsistency(this.store);
    if (ready.length === 0) {
      this.el.innerHTML = head + renderEmpty("Not enough laps yet", `Appears after ${MIN_SAMPLES} laps through each section.`);
      return;
    }
    const top = ranked[0].givenAway >= SIGNIFICANT_GAP_SEC ? ranked[0] : undefined;

    this.el.innerHTML = `
      ${head}
      <div class="table-scroll">
        <table class="table stats-table">
          <thead>
            <tr>
              <th>Section</th>
              <th class="num">Best</th>
              <th class="num">Typical</th>
              <th class="num">Lost vs best</th>
              <th class="num">Exit speed <small>typical / best</small></th>
              <th class="num">Passes</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map((r) => {
                const enough = r.samples >= MIN_SAMPLES;
                const isTop = r === top;
                return `
                  <tr class="${isTop ? "is-top" : ""}">
                    <td>
                      <span class="stats-sec">
                        ${routeLabel(this.store, r.fromPuckId, r.toPuckId)}
                        ${isTop ? `<span class="badge">Biggest opportunity</span>` : ""}
                      </span>
                    </td>
                    <td class="num mono">${fmtTime(r.best)}</td>
                    <td class="num mono">${enough ? fmtTime(r.typical) : "—"}</td>
                    <td class="num mono ${isTop ? "strong" : enough && r.givenAway >= SIGNIFICANT_GAP_SEC ? "" : "muted"}">
                      ${enough ? `+${r.givenAway.toFixed(3)}s` : "—"}
                    </td>
                    <td class="num mono">${r.typicalExitMph.toFixed(0)} <span class="muted">/ ${r.bestExitMph.toFixed(0)} mph</span></td>
                    <td class="num mono muted">${enough ? r.samples : `${r.samples}/${MIN_SAMPLES}`}</td>
                  </tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>`;
  }
}

/** Plain-language coaching advice derived from the section stats. */
export class PracticeRecommendation extends Component {
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
        <div><h2>Recommendation</h2></div>
      </header>`;

    const { ready, ranked } = loadConsistency(this.store);
    if (ready.length === 0) {
      this.el.innerHTML = head + renderEmpty("Not enough laps yet", `A recommendation appears after ${MIN_SAMPLES} laps through each section.`);
      return;
    }

    const slotIndex = this.store.selectedPilot;
    const bestLap = bestLapOf(lapsFor(this.store, slotIndex));
    const possible = bestPossibleLap(this.store, slotIndex);
    const linkGain = possible > 0 && bestLap > 0 ? bestLap - possible : 0;
    const top = ranked[0];
    const second = ranked[1];

    let lead: string;
    const points: string[] = [];

    if (top.givenAway < SIGNIFICANT_GAP_SEC) {
      lead = `You're flying consistently — your typical pass is within ${SIGNIFICANT_GAP_SEC.toFixed(2)}s of your best in every section.`;
      const slowestExit = [...ready].sort((a, b) => a.typicalExitMph - b.typicalExitMph)[0];
      points.push(
        `To go faster now you need new personal bests rather than more consistency. Try carrying more speed out of <strong>${esc(sectionName(this.store, slowestExit))}</strong>, where your exit speed is lowest (${slowestExit.typicalExitMph.toFixed(0)} mph).`
      );
    } else {
      lead = `Practice <strong>${esc(sectionName(this.store, top))}</strong> next.`;
      points.push(
        `Your typical pass takes <strong class="mono">${fmtTime(top.typical)}</strong>, but your best is <strong class="mono">${fmtTime(top.best)}</strong> — that's <strong>${top.givenAway.toFixed(3)}s</strong> left on the table every lap, more than any other section.`
      );
      const mphDrop = top.bestExitMph - top.typicalExitMph;
      if (mphDrop >= NOTABLE_MPH) {
        points.push(
          `You usually exit <strong>${mphDrop.toFixed(0)} mph slower</strong> than on your best pass (${top.typicalExitMph.toFixed(0)} vs ${top.bestExitMph.toFixed(0)} mph). Focus on a cleaner line so you carry speed out of it.`
        );
      }
      if (second && second.givenAway >= SIGNIFICANT_GAP_SEC) {
        points.push(
          `After that, work on <strong>${esc(sectionName(this.store, second))}</strong> (${second.givenAway.toFixed(3)}s lost per lap).`
        );
      }
    }
    if (linkGain > 0.005) {
      points.push(
        `Linking your best time in every section would be a <strong class="mono">${fmtTime(possible)}</strong> lap — ${linkGain.toFixed(3)}s faster than your current best of ${fmtTime(bestLap)}.`
      );
    }

    this.el.innerHTML = `
      ${head}
      <div class="rec-body">
        <p class="rec-lead">${lead}</p>
        <ul class="rec-list">${points.map((p) => `<li>${p}</li>`).join("")}</ul>
      </div>`;
  }
}
