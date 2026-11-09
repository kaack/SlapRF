import { Component } from "../core/component";
import { esc, fmtAgo, fmtDelta, fmtTime } from "../core/format";
import { practiceStats, PracticeStats } from "../state/analysis";
import { currentSectorIndex, gateColor } from "../state/selectors";
import { AppStore } from "../state/store";
import { renderEmpty, renderSparkline } from "./markup";

const SPARK_LAPS = 12;
const IDLE_REFRESH_MS = 5000;

/**
 * Live table of every pilot: whether they're flying, which section they're in, and their
 * lap times. Ranked by best lap (fastest first); pilots without a lap go last.
 */
export class LiveStandings extends Component {
  private readonly store: AppStore;
  private readonly onSelect: (slotIndex: number) => void;

  constructor(el: HTMLElement, store: AppStore, onSelect: (slotIndex: number) => void) {
    super(el);
    this.store = store;
    this.onSelect = onSelect;
    el.addEventListener("click", this.handleClick);
    this.onDispose(() => el.removeEventListener("click", this.handleClick));
    this.onDispose(store.subscribe(["laps", "crossings", "config"], () => this.render()));
    // Keep "on track / idle 3m ago" fresh even when nobody is crossing gates.
    const timer = window.setInterval(() => this.render(), IDLE_REFRESH_MS);
    this.onDispose(() => window.clearInterval(timer));
    this.render();
  }

  private handleClick = (e: Event): void => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-pilot]");
    if (row) this.onSelect(Number(row.dataset.pilot));
  };

  private render(): void {
    const rows = this.store.enabledPilots.map((p) => practiceStats(this.store, p));
    if (rows.length === 0) {
      this.el.innerHTML = renderEmpty("No pilots enabled", "Enable pilot slots in System.");
      return;
    }
    rows.sort((a, b) => {
      if (a.bestLap > 0 && b.bestLap > 0) return a.bestLap - b.bestLap;
      if ((a.bestLap > 0) !== (b.bestLap > 0)) return a.bestLap > 0 ? -1 : 1;
      return a.pilot.slotIndex - b.pilot.slotIndex;
    });
    const sessionBest = rows[0].bestLap;
    const bodyHtml = rows.map((r, i) => this.renderRow(r, i + 1, sessionBest)).join("");

    const existingBody = this.el.querySelector<HTMLElement>("table.table-standings tbody");
    if (existingBody) {
      existingBody.innerHTML = bodyHtml;
      return;
    }

    this.el.innerHTML = `
      <div class="table-scroll">
        <table class="table table-standings">
          <thead>
            <tr>
              <th class="col-pos">#</th>
              <th>Pilot</th>
              <th class="num">Laps</th>
              <th class="num">Last</th>
              <th class="num">Best</th>
              <th class="num col-avg">Avg 5</th>
              <th class="num col-gap">Gap</th>
              <th class="col-spark">Recent laps</th>
              <th class="col-progress">On track</th>
            </tr>
          </thead>
          <tbody>${bodyHtml}</tbody>
        </table>
      </div>`;
  }

  private renderRow(s: PracticeStats, rank: number, sessionBest: number): string {
    const { pilot } = s;
    const sector = s.onTrack ? currentSectorIndex(this.store, pilot.slotIndex) : -1;
    const gates = this.store.nodes;
    const segments = gates
      .map((p, i) => {
        const nextGate = gates[(i + 1) % gates.length];
        const c1 = gateColor(this.store, p.gateId);
        const c2 = nextGate ? gateColor(this.store, nextGate.gateId) : c1;
        return `<span class="seg ${i < sector ? "is-done" : i === sector ? "is-live" : ""}" style="--c1:${c1};--c2:${c2}"></span>`;
      })
      .join("");
    const statusTitle = s.onTrack ? "On track" : s.laps.length ? `Idle · ${fmtAgo(s.secondsSinceSeen)}` : "Not flown";
    const gap = s.bestLap > 0 && sessionBest > 0 ? (s.bestLap === sessionBest ? `<span class="tone-accent">fastest</span>` : fmtDelta(s.bestLap - sessionBest)) : "";

    return `
      <tr class="row-link ${s.onTrack ? "" : "is-idle"}" data-pilot="${pilot.slotIndex}">
        <td class="col-pos"><span class="pos ${rank === 1 && s.bestLap > 0 ? "is-leader" : ""}">${rank}</span></td>
        <td>
          <div class="pilot-cell">
            <span class="pilot-swatch" style="--c:${pilot.color}"></span>
            <div>
              <div class="pilot-name">
                <span>${esc(pilot.callsign)}</span>
                <span class="pilot-live-dot ${s.onTrack ? "is-live" : ""}" title="${statusTitle}"></span>
              </div>
              <div class="pilot-meta">${pilot.channel > 0 ? `R${pilot.channel} · ${pilot.frequencyMhz} MHz` : `<span class="tone-warn">No channel assigned</span>`}</div>
            </div>
          </div>
        </td>
        <td class="num mono">${s.laps.length}</td>
        <td class="num mono">${fmtTime(s.lastLap)}</td>
        <td class="num mono strong">${fmtTime(s.bestLap)}</td>
        <td class="num mono col-avg">${fmtTime(s.rollingAvg)}</td>
        <td class="num mono muted col-gap">${gap}</td>
        <td class="spark-cell col-spark" style="color:${pilot.color}">${renderSparkline(s.laps.slice(-SPARK_LAPS).map((l) => l.lapTimeSec), 96, 26)}</td>
        <td class="col-progress">
          <div class="sector-progress">
            <div class="segments">${segments}</div>
            <span class="sector-tag">${sector >= 0 ? `S${sector + 1}` : "—"}</span>
          </div>
        </td>
      </tr>`;
  }
}
