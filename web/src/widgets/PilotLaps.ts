import { Component } from "../core/component";
import { esc, fmtDelta, fmtTime } from "../core/format";
import { sectionKey } from "../state/analysis";
import { gateColor, lapsFor, sectionLabel, sectionShort } from "../state/selectors";
import { AppStore } from "../state/store";
import { LapRecord } from "../types/models";
import { renderEmpty, SPLIT_CLASS } from "./markup";

const VISIBLE_LAPS = 20;

interface Column {
  from: number;
  to: number;
}

/** The selected pilot's completed laps, newest first, with every section split. */
export class PilotLaps extends Component {
  private readonly store: AppStore;

  constructor(el: HTMLElement, store: AppStore) {
    super(el);
    this.store = store;
    this.onDispose(store.subscribe(["laps", "selection", "config"], () => this.render()));
    this.render();
  }

  private render(): void {
    const pilot = this.store.pilot(this.store.selectedPilot);
    if (!pilot) {
      this.el.innerHTML = renderEmpty("No pilot selected", "Pick a pilot above.");
      return;
    }
    const laps = lapsFor(this.store, pilot.slotIndex);
    if (laps.length === 0) {
      this.el.innerHTML = renderEmpty("No laps yet", `${pilot.callsign}'s laps appear here as they complete them.`);
      return;
    }

    // Columns follow the course: each gate to the next, wrapping back to start / finish.
    const gates = this.store.nodes;
    const cols: Column[] = gates.map((p, i) => ({ from: p.gateId, to: gates[(i + 1) % gates.length].gateId }));
    const head = cols
      .map((c) => `<th class="num" title="${esc(sectionLabel(this.store, c.from, c.to))}"><span class="th-pilot"><span class="dot" style="--c:${gateColor(this.store, c.from)}"></span>${sectionShort(this.store, c.from)}</span></th>`)
      .join("");
    const rows = [...laps].reverse().slice(0, VISIBLE_LAPS).map((lap) => this.renderLap(lap, cols)).join("");

    const tableInnerHtml = `
          <thead><tr><th>Lap</th>${head}<th class="num">Lap time</th><th class="num">vs best</th></tr></thead>
          <tbody>${rows}</tbody>`;

    const existingTable = this.el.querySelector<HTMLElement>("table.table-compact");
    if (existingTable) {
      existingTable.innerHTML = tableInnerHtml;
      return;
    }

    this.el.innerHTML = `
      <div class="table-scroll table-scroll-y">
        <table class="table table-compact">${tableInnerHtml}
        </table>
      </div>
      <div class="legend-row">
        <span><i class="split-purple"></i>Track record</span>
        <span><i class="split-good"></i>Own best</span>
        <span><i class="split-bad"></i>&gt;10% off own best</span>
      </div>`;
  }

  private renderLap(lap: LapRecord, cols: Column[]): string {
    const byKey = new Map((lap.sectors ?? []).map((s) => [sectionKey(s.fromGateId, s.toGateId), s]));
    const cells = cols
      .map((c) => {
        const s = byKey.get(sectionKey(c.from, c.to));
        return s
          ? `<td class="num"><span class="split ${SPLIT_CLASS[s.badge]}">${s.splitSeconds.toFixed(3)}</span></td>`
          : `<td class="num muted" title="Timer missed">—</td>`;
      })
      .join("");
    const vs = lap.isBestLap && lap.lapNumber > 1 ? `<span class="badge badge-good">PB</span>` : lap.deltaToBest > 0 ? fmtDelta(lap.deltaToBest) : "best";
    return `
      <tr>
        <td class="mono">${lap.lapNumber}</td>
        ${cells}
        <td class="num mono strong ${lap.isBestLap ? "tone-good" : ""}">${fmtTime(lap.lapTimeSec)}</td>
        <td class="num mono muted">${vs}</td>
      </tr>`;
  }
}
