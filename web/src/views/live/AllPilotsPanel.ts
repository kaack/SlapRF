import { Component } from "../../core/component";
import { fmtTime } from "../../core/format";
import { icons } from "../../core/icons";
import { ApiClient } from "../../services/api_client";
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
  private readonly api: ApiClient;
  private resetFlashTimer: number | null = null;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient, follow: (slotIndex: number) => void) {
    super(el);
    this.store = store;
    this.api = api;

    el.innerHTML = `
      <div class="stat-row" data-slot="stats"></div>
      <section class="card card-flush">
        <header class="card-head">
          <div class="settings-intro"><h2>Pilots</h2><p>Ranked by best lap. Click a pilot to follow their live lap.</p></div>
          <button type="button" class="btn btn-sm btn-icon btn-ghost" data-action="reset-laps" title="Clear session laps" aria-label="Clear session laps">
            ${icons.trash(17)}
          </button>
        </header>
        <div data-slot="standings"></div>
      </section>
      <section class="card card-flush" data-slot="laptimes"></section>
      <section class="card card-flush">
        <header class="card-head"><div class="settings-intro"><h2>Section records</h2><p>Fastest time for each pilot in every section.</p></div></header>
        <div data-slot="records"></div>
      </section>`;

    this.listen(el, "click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-action="reset-laps"]');
      if (!btn) return;
      if (confirm("Clear all laps for this session?")) {
        btn.classList.remove("btn-ghost");
        btn.classList.add("btn-armed");
        if (this.resetFlashTimer !== null) {
          window.clearTimeout(this.resetFlashTimer);
        }
        this.resetFlashTimer = window.setTimeout(() => {
          this.resetFlashTimer = null;
          btn.classList.remove("btn-armed");
          btn.classList.add("btn-ghost");
        }, 350);
        void this.api.resetSession();
      }
    });

    this.adopt(new LiveStandings(this.slot("standings"), store, follow));
    this.adopt(new LapTimesCard(this.slot("laptimes"), store));
    this.adopt(new SectionRecords(this.slot("records"), store));

    this.onDispose(() => {
      if (this.resetFlashTimer !== null) {
        window.clearTimeout(this.resetFlashTimer);
      }
    });

    this.onDispose(store.subscribe(["laps", "crossings", "config", "status"], () => this.renderStats()));
    this.renderStats();
  }

  private renderStats(): void {
    const s = this.store;
    const resetBtn = this.el.querySelector<HTMLButtonElement>('[data-action="reset-laps"]');
    if (resetBtn) {
      resetBtn.disabled = s.laps.length === 0 && s.crossings.length === 0;
    }
    const flying = s.enabledPilots.filter((p) => practiceStats(s, p).onTrack).length;
    const fastest = fastestLap(s);
    const online = s.nodes.filter((p) => p.online).length;

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
        label: "Timers online",
        value: `${online}/${s.nodes.length}`,
        sub: s.nodes.length ? `Lowest battery ${s.nodes.reduce((m, p) => Math.min(m, p.batteryPct), 100)}%` : "No timers",
        tone: online < s.nodes.length ? "bad" : undefined,
      },
    ]);
  }
}
