import { Component } from "../../core/component";
import { fmtAgo, fmtDelta, fmtRaceClock, fmtTime } from "../../core/format";
import { currentLap, practiceStats } from "../../state/analysis";
import { ApiClient } from "../../services/api_client";
import { AppStore } from "../../state/store";
import { LapTimesCard } from "../../widgets/LapTimesCard";
import { renderStatTiles, StatTile } from "../../widgets/markup";
import { PilotLaps } from "../../widgets/PilotLaps";
import { PilotRssiChart } from "../../widgets/PilotRssiChart";

/** The running lap clock in the KPI bar ticks this often. */
const CLOCK_REFRESH_MS = 100;
const NEGLIGIBLE_SEC = 0.01;

/**
 * Live view, one pilot selected: KPIs led by the lap in progress, their signal at every
 * gate (pausable and scrollable, with every pass marked), their lap-time trend (whole lap
 * or one section), and their completed laps.
 */
export class PilotPanel extends Component {
  private readonly store: AppStore;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;

    el.innerHTML = `
      <div class="stat-row" data-slot="stats"></div>
      <section class="card card-flush">
        <div class="card-body">
          <header class="card-head"><div class="settings-intro"><h2>Signal at each gate</h2><p>This pilot's 5.8 GHz signal as every gate sees it · pick one gate to see and adjust its threshold · red pass lines didn't count — hover for why</p></div></header>
          <div data-slot="rssi"></div>
        </div>
        <div class="rules-foot">
          <p class="note">Default chart view follows the live 5s stream with all gates visible.</p>
          <button class="btn btn-ghost btn-sm" type="button" data-action="restore-rssi-defaults">Restore defaults</button>
        </div>
      </section>
      <section class="card card-flush" data-slot="laptimes"></section>
      <section class="card card-flush">
        <header class="card-head"><div class="settings-intro"><h2>Laps</h2><p>Completed laps, newest first · each section against the pilot's own best</p></div></header>
        <div data-slot="laps"></div>
      </section>`;

    const rssiChart = this.adopt(new PilotRssiChart(this.slot("rssi"), store, api));
    this.adopt(new LapTimesCard(this.slot("laptimes"), store, { slotIndex: () => store.selectedPilot }));
    this.adopt(new PilotLaps(this.slot("laps"), store));

    this.listen(el, "click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-action="restore-rssi-defaults"]');
      if (!btn) return;
      rssiChart.restoreDefaults();
    });

    const timer = window.setInterval(() => this.renderStats(), CLOCK_REFRESH_MS);
    this.onDispose(() => window.clearInterval(timer));
    this.renderStats();
  }

  private renderStats(): void {
    const pilot = this.store.pilot(this.store.selectedPilot);
    if (!pilot) {
      this.slot("stats").innerHTML = "";
      return;
    }
    const s = practiceStats(this.store, pilot);
    this.slot("stats").innerHTML = renderStatTiles([
      this.lapInProgressTile(pilot.slotIndex, s.laps.length, s.secondsSinceSeen),
      {
        label: "Last lap",
        value: fmtTime(s.lastLap),
        sub: s.lastLap > 0 && s.bestLap > 0 ? (s.lastLap === s.bestLap ? "Personal best" : `${fmtDelta(s.lastLap - s.bestLap)} vs best`) : "—",
      },
      { label: "Best lap", value: fmtTime(s.bestLap), sub: `${s.laps.length} laps this session`, tone: s.bestLap > 0 ? "accent" : undefined },
      {
        label: "Average, last 5",
        value: fmtTime(s.rollingAvg),
        sub: Number.isFinite(s.trend) ? `${fmtDelta(s.trend)} vs the 5 before` : "Trend after 10 laps",
        tone: Number.isFinite(s.trend) ? (s.trend < 0 ? "good" : "bad") : undefined,
      },
    ]);
  }

  /** Running clock for the lap being flown; when not on a lap, when they were last seen. */
  private lapInProgressTile(slotIndex: number, lapsFlown: number, secondsSinceSeen: number): StatTile {
    const live = currentLap(this.store, slotIndex);
    if (!live) {
      return {
        label: "Lap in progress",
        value: "—",
        sub: Number.isFinite(secondsSinceSeen) ? `Not on a lap · last seen ${fmtAgo(secondsSinceSeen)}` : lapsFlown ? "Not on a lap" : "Not flown yet",
      };
    }
    const anyDone = live.sections.some((x) => x.state === "done" && x.bestSec > 0);
    const d = live.deltaSoFar;
    return {
      label: `Lap ${live.lapNumber} in progress`,
      value: fmtRaceClock(live.elapsedSec),
      sub: anyDone ? `${fmtDelta(d)} vs own best sections` : "First section…",
      subTone: !anyDone || Math.abs(d) < NEGLIGIBLE_SEC ? undefined : d > 0 ? "bad" : "good",
    };
  }
}
