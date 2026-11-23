import { Component } from "../core/component";
import { esc, fmtDelta, fmtTime } from "../core/format";
import { icons } from "../core/icons";
import { sectionKey } from "../state/analysis";
import { allLapsFor, gateColor, sectionLabel, sectionShort } from "../state/selectors";
import { AppStore } from "../state/store";
import { LapRecord } from "../types/models";
import { renderEmpty, SPLIT_CLASS } from "./markup";

const VISIBLE_LAPS = 20;

interface Column {
  from: number;
  to: number;
}

function formatLapWallClock(store: AppStore, lap: LapRecord): string {
  let ms = lap.completedAtMs ?? 0;
  if (!(ms > 0)) {
    const sess = store.selectedPracticeSession;
    const baseMs = sess?.createdAt ? Date.parse(sess.createdAt) : NaN;
    if (Number.isFinite(baseMs) && baseMs > 0) {
      const all = store.laps;
      const minUs = all.reduce(
        (m, l) => (m === 0 || (l.completedAtUs > 0 && l.completedAtUs < m) ? l.completedAtUs : m),
        0
      );
      const offsetMs = lap.completedAtUs >= minUs ? (lap.completedAtUs - minUs) / 1000 : 0;
      ms = Math.round(baseMs + 15_000 + offsetMs);
    } else {
      const latestUs = Math.max(store.latestTimestampUs, lap.completedAtUs);
      const agoMs = Math.max(0, (latestUs - lap.completedAtUs) / 1000);
      ms = Math.round(Date.now() - agoMs);
    }
  }
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export interface PilotLapsCallbacks {
  onToggleLap?: (lapId: number) => void;
  onDeleteLap?: (lapId: number) => void;
}

/** The selected pilot's completed laps, newest first, with every section split. */
export class PilotLaps extends Component {
  private readonly store: AppStore;
  private readonly onToggleLap?: (lapId: number) => void;
  private readonly onDeleteLap?: (lapId: number) => void;

  constructor(
    el: HTMLElement,
    store: AppStore,
    callbacks?: ((lapId: number) => void) | PilotLapsCallbacks
  ) {
    super(el);
    this.store = store;
    if (typeof callbacks === "function") {
      this.onToggleLap = callbacks;
    } else if (callbacks) {
      this.onToggleLap = callbacks.onToggleLap;
      this.onDeleteLap = callbacks.onDeleteLap;
    }
    this.listen(el, "click", (e) => {
      const target = e.target as HTMLElement;
      const delBtn = target.closest<HTMLButtonElement>("[data-practice-delete-lap]");
      if (delBtn) {
        e.stopPropagation();
        const lapId = Number(delBtn.dataset.practiceDeleteLap);
        if (!(lapId > 0)) return;
        this.store.deletePracticeLap(lapId);
        this.onDeleteLap?.(lapId);
        return;
      }
      const btn = target.closest<HTMLElement>("[data-practice-toggle-lap]");
      if (!btn) return;
      e.stopPropagation();
      const lapId = Number(btn.dataset.practiceToggleLap);
      if (!(lapId > 0)) return;
      this.store.togglePracticeLap(lapId);
      this.onToggleLap?.(lapId);
    });
    this.onDispose(store.subscribe(["laps", "selection", "config", "practice"], () => this.render()));
    this.render();
  }

  private render(): void {
    const pilot =
      this.store.selectedPilot !== null ? this.store.pilot(this.store.selectedPilot) : undefined;
    const isAllMode = !pilot;
    const laps = pilot ? allLapsFor(this.store, pilot.slotIndex) : this.store.laps;
    if (laps.length === 0) {
      this.el.innerHTML = renderEmpty(
        "No laps yet",
        pilot
          ? `${pilot.callsign}'s laps appear here as they complete them.`
          : "Completed laps appear here as pilots cross the finish gate."
      );
      return;
    }

    // Columns follow the course: each gate to the next, wrapping back to start / finish.
    const gates = this.store.nodes;
    const cols: Column[] = gates.map((p, i) => ({ from: p.gateId, to: gates[(i + 1) % gates.length].gateId }));
    const head = cols
      .map((c) => `<th class="num col-sector" title="${esc(sectionLabel(this.store, c.from, c.to))}"><span class="th-pilot"><span class="dot" style="--c:${gateColor(this.store, c.from)}"></span>${sectionShort(this.store, c.from)}</span></th>`)
      .join("");
    const rows = [...laps]
      .reverse()
      .slice(0, VISIBLE_LAPS)
      .map((lap) => this.renderLap(lap, cols, isAllMode))
      .join("");

    const pilotTh = isAllMode ? `<th class="col-pilot">Pilot</th>` : "";
    const tableInnerHtml = `
          <thead><tr>${pilotTh}<th class="col-lap-num">Lap</th><th class="col-lap-clock">Time</th>${head}<th class="num col-lap-time">Lap time</th><th class="num col-vs-best">vs best</th></tr></thead>
          <tbody>${rows}</tbody>`;

    const existingTable = this.el.querySelector<HTMLElement>("table.table-compact");
    if (existingTable) {
      existingTable.style.setProperty("--sector-cols", String(cols.length));
      existingTable.style.setProperty("--pilot-col-extra", isAllMode ? "136px" : "0px");
      existingTable.innerHTML = tableInnerHtml;
      return;
    }

    this.el.innerHTML = `
      <div class="table-scroll table-scroll-y">
        <table class="table table-compact practice-laps-table" style="--sector-cols:${cols.length};--pilot-col-extra:${isAllMode ? "136px" : "0px"}">${tableInnerHtml}
        </table>
      </div>
      <div class="legend-row">
        <span><i class="split-purple"></i>Track record</span>
        <span><i class="split-good"></i>Own best</span>
        <span><i class="split-bad"></i>&gt;10% off own best</span>
      </div>`;
  }

  private renderLap(lap: LapRecord, cols: Column[], showPilot = false): string {
    const isInvalid = Boolean(lap.invalidated);
    const byKey = new Map((lap.sectors ?? []).map((s) => [sectionKey(s.fromGateId, s.toGateId), s]));
    const cells = cols
      .map((c) => {
        const s = byKey.get(sectionKey(c.from, c.to));
        return s
          ? `<td class="num col-sector"><span class="split ${isInvalid ? "" : SPLIT_CLASS[s.badge]}">${s.splitSeconds.toFixed(3)}</span></td>`
          : `<td class="num muted col-sector" title="Timer missed">—</td>`;
      })
      .join("");
    const vs = isInvalid
      ? "—"
      : lap.isBestLap && lap.lapNumber > 1
        ? `<span class="badge badge-good">PB</span>`
        : lap.deltaToBest > 0
          ? fmtDelta(lap.deltaToBest)
          : "best";
    const pObj = showPilot ? this.store.pilot(lap.slotIndex) : undefined;
    const pColor = pObj?.color || "#38bdf8";
    const pilotTd = showPilot
      ? `<td class="col-pilot"><div class="pilot-cell"><span class="pilot-swatch" style="--c:${esc(pColor)}"></span><div class="pilot-name"><span>${esc(lap.callsign)}</span></div></div></td>`
      : "";
    const clockText = formatLapWallClock(this.store, lap);
    const toggleTitle = isInvalid
      ? `Restore Lap ${lap.lapNumber}`
      : `Scratch Lap ${lap.lapNumber} (click again to restore or delete)`;
    const lapNumContent = isInvalid
      ? `<span class="lap-num-cell"><button
            type="button"
            role="checkbox"
            aria-checked="false"
            class="lap-num-toggle"
            data-practice-toggle-lap="${lap.lapId}"
            title="${esc(toggleTitle)}"
            aria-label="${esc(toggleTitle)}"
          >${lap.lapNumber}</button><button
            type="button"
            class="lap-delete-btn"
            data-practice-delete-lap="${lap.lapId}"
            title="Delete Lap ${lap.lapNumber}"
            aria-label="Delete Lap ${lap.lapNumber}"
          >${icons.trash(13)}</button></span>`
      : `<button
            type="button"
            role="checkbox"
            aria-checked="true"
            class="lap-num-toggle"
            data-practice-toggle-lap="${lap.lapId}"
            title="${esc(toggleTitle)}"
            aria-label="${esc(toggleTitle)}"
          >${lap.lapNumber}</button>`;
    return `
      <tr class="${isInvalid ? "is-invalidated" : ""}" data-lap-row="${lap.lapId}" data-practice-toggle-lap="${lap.lapId}" title="${esc(toggleTitle)}">
        ${pilotTd}
        <td class="mono col-lap-num">
          ${lapNumContent}
        </td>
        <td class="mono muted col-lap-clock">${esc(clockText)}</td>
        ${cells}
        <td class="num mono strong col-lap-time ${!isInvalid && lap.isBestLap ? "tone-good" : ""}">${fmtTime(lap.lapTimeSec)}</td>
        <td class="num mono muted col-vs-best">${vs}</td>
      </tr>`;
  }
}
