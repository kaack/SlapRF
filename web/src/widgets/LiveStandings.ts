import { Component } from "../core/component";
import { esc, fmtAgo, fmtDelta, fmtTime } from "../core/format";
import { adaptColorForTheme } from "../core/theme";
import { formatBandChannelWithFreq } from "../core/vtx_channels";
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
  private lastRowHtmlBySlot = new Map<number, string>();

  constructor(el: HTMLElement, store: AppStore, onSelect: (slotIndex: number) => void) {
    super(el);
    this.store = store;
    this.onSelect = onSelect;
    el.addEventListener("click", this.handleClick);
    this.onDispose(() => el.removeEventListener("click", this.handleClick));
    this.onDispose(store.subscribe(["laps", "crossings", "config", "practice"], () => this.render()));
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
      this.lastRowHtmlBySlot.clear();
      this.el.innerHTML = renderEmpty(
        "No pilots in this session",
        "Click + Add pilot above to assign pilots from the global directory."
      );
      return;
    }
    rows.sort((a, b) => {
      if (a.bestLap > 0 && b.bestLap > 0) return a.bestLap - b.bestLap;
      if ((a.bestLap > 0) !== (b.bestLap > 0)) return a.bestLap > 0 ? -1 : 1;
      return a.pilot.slotIndex - b.pilot.slotIndex;
    });
    const sessionBest = rows[0].bestLap;
    const rowSpecs = rows.map((r, i) => ({
      slotIndex: r.pilot.slotIndex,
      live: r.onTrack,
      cellsHtml: this.renderRowCells(r, i + 1, sessionBest),
    }));

    const existingBody = this.el.querySelector<HTMLElement>("table.table-standings tbody");
    if (existingBody) {
      const existingBySlot = new Map<number, HTMLTableRowElement>();
      for (const tr of Array.from(existingBody.children)) {
        if (tr instanceof HTMLTableRowElement) {
          const slot = Number(tr.dataset.pilot);
          if (slot > 0) existingBySlot.set(slot, tr);
        }
      }

      const activeSlots = new Set<number>();
      for (let i = 0; i < rowSpecs.length; i++) {
        const spec = rowSpecs[i];
        activeSlots.add(spec.slotIndex);
        let tr = existingBySlot.get(spec.slotIndex);
        const targetCls = `row-link ${spec.live ? "is-live" : "is-idle"}`;
        if (!tr) {
          tr = document.createElement("tr");
          tr.className = targetCls;
          tr.dataset.pilot = String(spec.slotIndex);
          tr.innerHTML = spec.cellsHtml;
          this.lastRowHtmlBySlot.set(spec.slotIndex, spec.cellsHtml);
        } else {
          if (tr.className !== targetCls) {
            tr.className = targetCls;
          }
          if (this.lastRowHtmlBySlot.get(spec.slotIndex) !== spec.cellsHtml) {
            tr.innerHTML = spec.cellsHtml;
            this.lastRowHtmlBySlot.set(spec.slotIndex, spec.cellsHtml);
          }
        }
        // Only reorder if this row is not already at index i, preserving :hover on untouched rows.
        const currentAtIdx = existingBody.children[i];
        if (currentAtIdx !== tr) {
          existingBody.insertBefore(tr, currentAtIdx ?? null);
        }
      }
      for (const [slot, tr] of existingBySlot) {
        if (!activeSlots.has(slot)) {
          tr.remove();
          this.lastRowHtmlBySlot.delete(slot);
        }
      }
      return;
    }

    this.lastRowHtmlBySlot.clear();
    const bodyHtml = rowSpecs
      .map((spec) => {
        this.lastRowHtmlBySlot.set(spec.slotIndex, spec.cellsHtml);
        return `<tr class="row-link ${spec.live ? "is-live" : "is-idle"}" data-pilot="${spec.slotIndex}">${spec.cellsHtml}</tr>`;
      })
      .join("");

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

  private renderRowCells(s: PracticeStats, rank: number, sessionBest: number): string {
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
    const gap = s.bestLap > 0 && sessionBest > 0 ? (s.bestLap === sessionBest ? `<span class="tone-accent col-gap-fastest">fastest</span>` : fmtDelta(s.bestLap - sessionBest)) : "";

    const pColor = adaptColorForTheme(pilot.color);
    return `
        <td class="col-pos"><span class="pos ${rank === 1 && s.bestLap > 0 ? "is-leader" : ""}">${rank}</span></td>
        <td>
          <div class="pilot-cell">
            <span class="pilot-swatch ${s.onTrack ? "is-live" : ""}" style="--c:${pColor}" title="${statusTitle}"></span>
            <div>
              <div class="pilot-name">
                <span>${esc(pilot.callsign)}</span>
              </div>
              <div class="pilot-meta">${pilot.channel > 0 ? esc(formatBandChannelWithFreq(pilot.band, pilot.channel, pilot.frequencyMhz)) : `<span class="tone-warn">No channel assigned</span>`}</div>
            </div>
          </div>
        </td>
        <td class="num mono">${s.laps.length}</td>
        <td class="num mono">${fmtTime(s.lastLap)}</td>
        <td class="num mono strong">${fmtTime(s.bestLap)}</td>
        <td class="num mono col-avg">${fmtTime(s.rollingAvg)}</td>
        <td class="num mono muted col-gap">${gap}</td>
        <td class="spark-cell col-spark" style="color:${pColor}">${renderSparkline(s.laps.slice(-SPARK_LAPS).map((l) => l.lapTimeSec), 96, 26)}</td>
        <td class="col-progress">
          <div class="sector-progress">
            <div class="segments">${segments}</div>
            <span class="sector-tag">${sector >= 0 ? `S${sector + 1}` : "—"}</span>
          </div>
        </td>`;
  }
}
