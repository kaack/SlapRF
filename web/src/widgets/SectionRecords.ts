import { Component } from "../core/component";
import { esc, fmtDelta } from "../core/format";
import { sectionRecords } from "../state/analysis";
import { sectionLabel } from "../state/selectors";
import { AppStore } from "../state/store";
import { renderEmpty, sectionIdBadge } from "./markup";

/**
 * Pilots × sections: each pilot is a row and each section is a column, with the record holder
 * highlighted in purple and everyone else shown as a gap to the record. Shows who is quick where,
 * matching the pilot-per-row layout of the standings table above.
 */
export class SectionRecords extends Component {
  private readonly store: AppStore;

  constructor(el: HTMLElement, store: AppStore) {
    super(el);
    this.store = store;
    this.onDispose(store.subscribe(["laps", "config"], () => this.render()));
    this.render();
  }

  private render(): void {
    const records = sectionRecords(this.store);
    const pilots = this.store.enabledPilots.filter((p) => records.some((r) => r.bests.has(p.slotIndex)));
    if (pilots.length === 0) {
      this.el.innerHTML = renderEmpty("No sections flown yet", "Section records appear after the first full lap.");
      return;
    }

    const head = records
      .map(
        (r) =>
          `<th class="num" title="${esc(sectionLabel(this.store, r.fromPuckId, r.toPuckId))}">${sectionIdBadge(
            this.store,
            r.fromPuckId,
            r.toPuckId
          )}</th>`
      )
      .join("");

    const rows = pilots
      .map((p) => {
        const cells = records
          .map((r) => {
            const b = r.bests.get(p.slotIndex);
            if (!b) return `<td class="num muted">—</td>`;
            if (p.slotIndex === r.recordSlot) {
              return `<td class="num"><span class="split split-purple">${b.sec.toFixed(3)}</span></td>`;
            }
            return `<td class="num mono muted" title="${b.sec.toFixed(3)}s">${fmtDelta(b.sec - r.recordSec)}</td>`;
          })
          .join("");
        return `
          <tr>
            <td>
              <div class="pilot-cell">
                <span class="pilot-swatch" style="--c:${p.color}"></span>
                <div class="pilot-name">${esc(p.callsign)}</div>
              </div>
            </td>
            ${cells}
          </tr>`;
      })
      .join("");

    const tableInnerHtml = `
          <thead><tr><th>Pilot</th>${head}</tr></thead>
          <tbody>${rows}</tbody>`;

    const existingTable = this.el.querySelector<HTMLElement>("table.table-compact");
    if (existingTable) {
      existingTable.innerHTML = tableInnerHtml;
      return;
    }

    this.el.innerHTML = `
      <div class="table-scroll">
        <table class="table table-compact">${tableInnerHtml}
        </table>
      </div>
      <div class="legend-row"><span><i class="split-purple"></i>Section record</span><span>Others: gap to the record</span></div>`;
  }
}
