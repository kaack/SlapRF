import { Component } from "../../core/component";
import { fmtTime } from "../../core/format";
import { practiceStats } from "../../state/analysis";
import { fastestLap } from "../../state/selectors";
import { AppStore } from "../../state/store";
import { LapTimesCard } from "../../widgets/LapTimesCard";
import { LiveStandings } from "../../widgets/LiveStandings";
import { renderStatTiles } from "../../widgets/markup";
import { SectionRecords } from "../../widgets/SectionRecords";

/**
 * Live view, "All" selected: who is flying right now, how everyone's laps are trending
 * (whole lap or per section), and who is quickest on each stretch of track.
 */
export class AllPilotsPanel extends Component {
  private readonly store: AppStore;

  constructor(el: HTMLElement, store: AppStore, follow: (slotIndex: number) => void) {
    super(el);
    this.store = store;

    el.innerHTML = `
      <div class="stat-row" data-slot="stats"></div>
      <section class="card card-flush">
        <header class="card-head"><div class="settings-intro"><h2>Pilots</h2><p>Ranked by best lap · click a pilot to follow their current lap</p></div></header>
        <div data-slot="standings"></div>
      </section>
      <section class="card" data-slot="laptimes"></section>
      <section class="card card-flush">
        <header class="card-head"><div class="settings-intro"><h2>Section records</h2><p>Each pilot's best on every stretch of track — who is quick where</p></div></header>
        <div data-slot="records"></div>
      </section>`;

    this.adopt(new LiveStandings(this.slot("standings"), store, follow));
    this.adopt(new LapTimesCard(this.slot("laptimes"), store));
    this.adopt(new SectionRecords(this.slot("records"), store));

    this.onDispose(store.subscribe(["laps", "crossings", "config", "status"], () => this.renderStats()));
    this.renderStats();
  }

  private renderStats(): void {
    const s = this.store;
    const flying = s.enabledPilots.filter((p) => practiceStats(s, p).onTrack).length;
    const fastest = fastestLap(s);
    const online = s.pucks.filter((p) => p.online).length;

    this.slot("stats").innerHTML = renderStatTiles([
      { label: "Flying now", value: String(flying), sub: `${s.enabledPilots.length} pilots enabled` },
      { label: "Laps this session", value: String(s.laps.length), sub: s.raceArmed ? "Timing on" : "Timing paused" },
      {
        label: "Session best",
        value: fmtTime(fastest?.lapTimeSec ?? 0),
        sub: fastest ? `${fastest.callsign} · lap ${fastest.lapNumber}` : "No laps yet",
        tone: fastest ? "accent" : undefined,
      },
      {
        label: "Gates online",
        value: `${online}/${s.pucks.length}`,
        sub: s.pucks.length ? `Lowest battery ${s.pucks.reduce((m, p) => Math.min(m, p.batteryPct), 100)}%` : "No gates",
        tone: online < s.pucks.length ? "bad" : undefined,
      },
    ]);
  }
}
