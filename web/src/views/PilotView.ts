import { Component } from "../core/component";
import { fmtDelta, fmtTime } from "../core/format";
import { bestPossibleLap, practiceStats } from "../state/analysis";
import { AppStore } from "../state/store";
import { LapComparison } from "../widgets/LapComparison";
import { LapPicker } from "../widgets/LapPicker";
import { renderStatTiles } from "../widgets/markup";
import { PilotPicker } from "../widgets/PilotPicker";
import { SectionConsistency } from "../widgets/SectionConsistency";

/**
 * Pilot analysis, read top to bottom: session numbers → (1) pick a lap on the bar chart →
 * (2) where that lap gained or lost time against its reference → where to practice across
 * the whole session. Laps are only ever chosen in step 1; everything below follows it.
 */
export class PilotView extends Component {
  private readonly store: AppStore;

  constructor(el: HTMLElement, store: AppStore) {
    super(el);
    this.store = store;

    el.innerHTML = `
      <div class="picker-row">
        <div data-slot="picker"></div>
      </div>
      <div class="stat-row" data-slot="stats"></div>
      <section class="card" data-slot="laps"></section>
      <section class="card card-flush" data-slot="compare"></section>
      <section class="card card-flush" data-slot="consistency"></section>`;

    this.adopt(new PilotPicker(this.slot("picker"), store));
    this.adopt(new LapPicker(this.slot("laps"), store));
    this.adopt(new LapComparison(this.slot("compare"), store));
    this.adopt(new SectionConsistency(this.slot("consistency"), store));

    this.onDispose(store.subscribe(["config", "selection", "laps"], () => this.renderStats()));
    this.renderStats();
  }

  private renderStats(): void {
    const pilot = this.store.pilot(this.store.selectedPilot);
    if (!pilot) {
      this.slot("stats").innerHTML = "";
      return;
    }
    const s = practiceStats(this.store, pilot);
    const possible = bestPossibleLap(this.store, pilot.slotIndex);
    const linkGain = s.bestLap > 0 && possible > 0 ? s.bestLap - possible : 0;

    this.slot("stats").innerHTML = renderStatTiles([
      { label: "Best lap", value: fmtTime(s.bestLap), sub: `${s.laps.length} laps flown`, tone: "accent" },
      {
        label: "Last lap",
        value: fmtTime(s.lastLap),
        sub: s.lastLap > 0 && s.bestLap > 0 ? (s.lastLap === s.bestLap ? "Personal best" : `${fmtDelta(s.lastLap - s.bestLap)} vs best`) : "—",
      },
      {
        label: "Average, last 5",
        value: fmtTime(s.rollingAvg),
        sub: Number.isFinite(s.trend) ? `${fmtDelta(s.trend)} vs the 5 before` : "Trend after 10 laps",
        tone: Number.isFinite(s.trend) ? (s.trend < 0 ? "good" : "bad") : undefined,
      },
      {
        label: "Best possible lap",
        value: fmtTime(possible),
        sub: possible > 0 ? (linkGain > 0.0005 ? `${fmtDelta(-linkGain)} by linking your best sections` : "Your best lap links every best section") : "Fly every gate to unlock",
      },
    ]);
  }
}
