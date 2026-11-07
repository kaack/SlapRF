import { Component } from "../core/component";
import { esc, fmtDelta } from "../core/format";
import { sectionRecords } from "../state/analysis";
import { AppStore } from "../state/store";
import { renderEmpty, sectionIdBadge, subtleRoute } from "./markup";

/**
 * Sections × pilots: each pilot's best on every stretch of track, with the record holder
 * highlighted and everyone else shown as a gap to the record. Shows who is quick where,
 * independent of section length.
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

    const head = pilots
      .map((p) => `<th class="num"><span class="th-pilot"><span class="dot" style="--c:${p.color}"></span>${esc(p.callsign)}</span></th>`)
      .join("");

    const rows = records
      .map((r) => {
        const holder = r.recordSlot !== null ? this.store.pilot(r.recordSlot) : undefined;
        const cells = pilots
          .map((p) => {
            const b = r.bests.get(p.slotIndex);
            if (!b) return `<td class="num muted">—</td>`;
            if (p.slotIndex === r.recordSlot) return `<td class="num"><span class="split split-purple">${b.sec.toFixed(3)}</span></td>`;
            return `<td class="num mono muted">${fmtDelta(b.sec - r.recordSec)}</td>`;
          })
          .join("");
        return `
          <tr>
            <td>
              <div class="sec-cell">
                ${sectionIdBadge(this.store, r.fromPuckId)}
                <div class="sec-meta">
                  ${subtleRoute(this.store, r.fromPuckId, r.toPuckId)}
                  ${holder ? `<span class="sec-holder">· record ${esc(holder.callsign)}</span>` : ""}
                </div>
              </div>
            </td>
            ${cells}
          </tr>`;
      })
      .join("");

    this.el.innerHTML = `
      <div class="table-scroll">
        <table class="table table-compact">
          <thead><tr><th>Section</th>${head}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="legend-row"><span><i class="split-purple"></i>Section record</span><span>Others: gap to the record</span></div>`;
  }
}
