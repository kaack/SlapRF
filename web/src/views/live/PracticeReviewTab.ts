import { Component } from "../../core/component";
import { esc, fmtDelta, fmtTime, LAP_BREAK_GAP_THRESHOLD_SEC, lapBreakGapSec, renderLapBreakRowHtml } from "../../core/format";
import { icons } from "../../core/icons";
import { ApiClient } from "../../services/api_client";
import { AppStore } from "../../state/store";
import { LapRecord, PracticeSession } from "../../types/models";
import { openPracticeLapEditorModal } from "../../widgets/PracticeLapEditorModal";

/**
 * Practice `Review` tab (`#/practice/<session>/review`) — mirrors Race `Review`:
 * - Lists recorded laps for the selected pilot with split deltas and 1-tap scratch/restore.
 * - Lets you open the interactive RSSI & Gate Crossing Editor (`openPracticeLapEditorModal`)
 *   either for the whole session or zoomed directly onto any individual lap on-demand.
 */
export class PracticeReviewTab extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private selectedSlot = 1;
  private lastSig = "";

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;

    this.listen(el, "click", this.handleClick);
    this.onDispose(
      store.subscribe(["practice", "laps", "crossings", "config", "selection"], () => {
        this.render();
      })
    );
    this.render(true);
  }

  public onActivate(): void {
    const sess = this.store.selectedPracticeSession;
    if (sess && (!this.store.hasSessionTrace(sess.sessionId) || this.store.sessionTraceNeedsRefresh(sess))) {
      void this.api
        .ensurePracticeSessionTrace(sess.sessionId, this.store.hasSessionTrace(sess.sessionId))
        .catch(() => undefined);
    }
    this.render(true);
  }

  private resolveActivePilotSlot(sess: PracticeSession): number {
    if (
      this.store.liveFocus !== null &&
      sess.pilots.some((p) => p.slotIndex === this.store.liveFocus)
    ) {
      this.selectedSlot = this.store.liveFocus;
      return this.selectedSlot;
    }
    if (sess.pilots.some((p) => p.slotIndex === this.selectedSlot)) {
      return this.selectedSlot;
    }
    this.selectedSlot = sess.pilots[0]?.slotIndex ?? 1;
    return this.selectedSlot;
  }

  private computeSig(sess: PracticeSession | undefined): string {
    if (!sess) return "none";
    const slot = this.resolveActivePilotSlot(sess);
    const gateCount = this.store.practiceSessionNodes(sess).nodes.length;
    const lapsSig = (sess.laps ?? [])
      .filter((l) => l.slotIndex === slot)
      .map(
        (l) =>
          `${l.lapId}:${l.lapNumber}:${l.lapTimeSec}:${(l.sectors ?? []).length}:${l.invalidated ? 1 : 0}:${l.isBestLap ? 1 : 0}`
      )
      .join(",");
    const pilotsSig = (sess.pilots ?? [])
      .map((p) => `${p.slotIndex}:${p.callsign}:${p.band ?? 1}:${p.channel}`)
      .join("|");
    const breaksSig = (sess.breaks ?? [])
      .filter((b) => b.slotIndex === slot)
      .map((b) => `${b.breakId}:${b.timestampUs}`)
      .join(",");
    return `${sess.sessionId}:${sess.name}:${slot}:${gateCount}:${sess.crossings.length}:${breaksSig}:${pilotsSig}:${lapsSig}`;
  }

  public render(force = false): void {
    const sess = this.store.selectedPracticeSession;
    const sig = this.computeSig(sess);
    if (!force && sig === this.lastSig) return;
    this.lastSig = sig;

    if (!sess) {
      this.el.innerHTML = "";
      return;
    }

    const slot = this.resolveActivePilotSlot(sess);
    const pilot = sess.pilots.find((p) => p.slotIndex === slot);
    const callsign = pilot?.callsign || `Pilot ${slot}`;
    const pilotLaps: LapRecord[] = (sess.laps ?? [])
      .filter((l) => l.slotIndex === slot)
      .sort(
        (a, b) =>
          a.completedAtUs - b.completedAtUs || a.lapNumber - b.lapNumber || a.lapId - b.lapId
      );
    const validLaps = pilotLaps.filter((l) => !l.invalidated);
    const bestSec = validLaps.reduce(
      (b, l) => (l.lapTimeSec > 0 && (b === 0 || l.lapTimeSec < b) ? l.lapTimeSec : b),
      0
    );

    const orderedNodes = this.store.practiceSessionNodes(sess).nodes;
    const expectedSectors = orderedNodes.length >= 2 ? orderedNodes.length : 0;
    const reversedPilotLaps = pilotLaps.slice().reverse();
    const rowsHtml =
      reversedPilotLaps.length === 0
        ? `<tr><td colspan="5" class="muted" style="text-align:center; padding: 22px 12px;">No laps recorded yet for ${esc(callsign)}. <button type="button" class="btn btn-ghost btn-xs" data-review-open-editor style="margin-left:6px">${icons.rssiBadge(13)}<span>Open RSSI</span></button></td></tr>`
        : reversedPilotLaps
            .map((lap, idx) => {
              const inv = Boolean(lap.invalidated);
              const sectors = lap.sectors ?? [];
              const hasMissedTimers = !inv && expectedSectors >= 2 && sectors.length < expectedSectors;
              let missedTitle = "";
              if (hasMissedTimers) {
                const visitedGateIds = new Set<number>();
                for (const s of sectors) {
                  if (s.fromGateId) visitedGateIds.add(s.fromGateId);
                  if (s.toGateId) visitedGateIds.add(s.toGateId);
                }
                const missedNames = orderedNodes
                  .slice(1)
                  .filter((g) => !visitedGateIds.has(g.gateId))
                  .map((g, gi) => g.name || `T${gi + 1}`);
                missedTitle =
                  missedNames.length > 0
                    ? `Missed timer${missedNames.length > 1 ? "s" : ""}: ${missedNames.join(", ")}`
                    : `Missed segment${expectedSectors - sectors.length > 1 ? "s" : ""} (${sectors.length}/${expectedSectors})`;
              }
              const startUs = Math.max(0, Math.round(lap.completedAtUs - lap.lapTimeSec * 1_000_000));
              const deltaHtml = inv
                ? `<span class="muted">Scratched</span>`
                : lap.isBestLap
                  ? `<span class="split-best">best</span>`
                  : bestSec > 0
                    ? `<span class="mono muted">${esc(fmtDelta(lap.lapTimeSec - bestSec))}</span>`
                    : `<span class="muted">—</span>`;
              const secSummary =
                sectors.length > 0
                  ? sectors.map((s) => s.splitSeconds.toFixed(2)).join(" · ")
                  : "—";
              const rowHtml = `
                <tr class="practice-review-row ${inv ? "is-invalidated" : ""} ${hasMissedTimers ? "is-missed-timers" : ""}" data-review-lap-row="${lap.lapId}" data-lap-start-us="${startUs}" data-lap-end-us="${lap.completedAtUs}"${missedTitle ? ` title="${esc(missedTitle)}"` : ""}>
                  <td class="mono practice-review-lap-cell ${hasMissedTimers ? "is-missed" : ""}"><strong>L${lap.lapNumber}</strong>${hasMissedTimers ? `<span class="practice-review-missed-icon" data-missed-timers title="${esc(missedTitle)}">${icons.alertTriangle(12)}</span>` : ""}</td>
                  <td class="mono">${lap.isBestLap && !inv ? `<span class="split-best">${fmtTime(lap.lapTimeSec)}</span>` : fmtTime(lap.lapTimeSec)}</td>
                  <td>${deltaHtml}</td>
                  <td class="mono note practice-review-splits-col">${esc(secSummary)}</td>
                  <td class="practice-review-actions-col">
                    <div class="practice-review-actions">
                      <button
                        type="button"
                        class="btn btn-ghost btn-xs practice-review-act-btn"
                        data-review-open-lap-rssi="${lap.lapId}"
                        data-lap-start-us="${startUs}"
                        data-lap-end-us="${lap.completedAtUs}"
                        title="Open RSSI crossing editor for Lap ${lap.lapNumber}"
                        aria-label="Open RSSI crossing editor for Lap ${lap.lapNumber}"
                      >${icons.rssiBadge(13)}<span>RSSI</span></button>
                      <button
                        type="button"
                        class="btn btn-ghost btn-xs practice-review-act-btn is-icon"
                        data-review-toggle-lap="${lap.lapId}"
                        title="${inv ? "Restore lap" : "Scratch lap"}"
                        aria-label="${inv ? "Restore lap" : "Scratch lap"}"
                      >${inv ? icons.reset(13) : icons.ban(13)}</button>
                    </div>
                  </td>
                </tr>`;
              const older = reversedPilotLaps[idx + 1];
              if (older) {
                const gapSec = lapBreakGapSec(lap, older);
                const manualBreak = (sess.breaks ?? []).find(
                  (b) =>
                    b.slotIndex === slot &&
                    b.timestampUs >= older.completedAtUs &&
                    b.timestampUs <= startUs
                );
                if (
                  gapSec >= LAP_BREAK_GAP_THRESHOLD_SEC ||
                  manualBreak ||
                  lap.lapNumber > older.lapNumber + 1
                ) {
                  return rowHtml + renderLapBreakRowHtml(gapSec, 5, manualBreak?.breakId);
                }
              }
              return rowHtml;
            })
            .join("");

    this.el.innerHTML = `
      <div class="practice-review-pane">
        <section class="card card-flush practice-review-card">
          <div class="table-scroll practice-review-table-scroll">
            <table class="table table-compact practice-review-table">
              <thead>
                <tr>
                  <th>Lap</th>
                  <th>Time</th>
                  <th>vs Best</th>
                  <th class="practice-review-splits-col">Sections</th>
                  <th style="text-align:right">Actions</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        </section>
      </div>`;
  }

  private readonly handleClick = (e: MouseEvent): void => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const sess = this.store.selectedPracticeSession;
    if (!sess) return;

    if (target.closest("[data-review-open-editor]")) {
      openPracticeLapEditorModal(this.store, this.api, sess.sessionId, this.selectedSlot);
      return;
    }

    const delBreakBtn = target.closest<HTMLButtonElement>("[data-delete-break-id]");
    if (delBreakBtn) {
      e.stopPropagation();
      const breakId = Number(delBreakBtn.dataset.deleteBreakId || "0");
      if (breakId > 0) {
        void this.api.deleteBreak(breakId, { kind: "practice", id: sess.sessionId });
      }
      return;
    }

    const rssiBtn = target.closest<HTMLButtonElement>("[data-review-open-lap-rssi]");
    if (rssiBtn) {
      e.stopPropagation();
      const lapId = Number(rssiBtn.dataset.reviewOpenLapRssi || "0") || undefined;
      const startUs = Number(rssiBtn.dataset.lapStartUs || "0");
      const endUs = Number(rssiBtn.dataset.lapEndUs || "0");
      openPracticeLapEditorModal(this.store, this.api, sess.sessionId, this.selectedSlot, {
        initialLapId: lapId,
        focusStartUs: startUs,
        focusEndUs: endUs,
      });
      return;
    }

    const toggleBtn = target.closest<HTMLButtonElement>("[data-review-toggle-lap]");
    if (toggleBtn) {
      e.stopPropagation();
      const lapId = Number(toggleBtn.dataset.reviewToggleLap || "0");
      if (lapId > 0) {
        void this.api.practiceAction({
          action: "toggle_session_lap",
          sessionId: sess.sessionId,
          lapId,
        });
      }
      return;
    }

    const row = target.closest<HTMLElement>("[data-review-lap-row]");
    if (row) {
      const lapId = Number(row.dataset.reviewLapRow || "0") || undefined;
      const startUs = Number(row.dataset.lapStartUs || "0");
      const endUs = Number(row.dataset.lapEndUs || "0");
      openPracticeLapEditorModal(this.store, this.api, sess.sessionId, this.selectedSlot, {
        initialLapId: lapId,
        focusStartUs: startUs,
        focusEndUs: endUs,
      });
    }
  };
}
