import { Component } from "../../core/component";
import { esc, fmtAgo, fmtDelta, fmtRaceClock, fmtTime } from "../../core/format";
import { icons } from "../../core/icons";
import { currentLap, practiceStats } from "../../state/analysis";
import { allLapsFor } from "../../state/selectors";
import { ApiClient } from "../../services/api_client";
import { AppStore } from "../../state/store";
import { openConfirmModal } from "../../widgets/ConfirmModal";
import { LapTimesCard } from "../../widgets/LapTimesCard";
import { renderStatTiles, StatTile } from "../../widgets/markup";
import { PilotLaps } from "../../widgets/PilotLaps";
import { SectionRecords } from "../../widgets/SectionRecords";

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
  private readonly api: ApiClient;
  private clearFlashTimer: number | null = null;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;

    el.innerHTML = `
      <div class="stat-row" data-slot="stats" data-practice-mobile-pane="overview"></div>
      <section class="card card-flush practice-trends-card" data-slot="laptimes" data-practice-mobile-pane="trends"></section>
      <section class="card card-flush practice-sections-card practice-desktop-sections-card" data-practice-mobile-pane="trends">
        <header class="card-head"><div class="settings-intro"><h2>Section records</h2><p>Fastest time for each pilot in every section.</p></div></header>
        <div data-slot="records"></div>
      </section>
      <section class="card card-flush practice-laps-card practice-desktop-laps-card">
        <header class="card-head">
          <div class="settings-intro"><h2>Laps</h2><p>Completed laps, newest first. Click a lap to scratch or delete it.</p></div>
          <button type="button" class="btn btn-sm btn-icon btn-ghost" data-action="clear-pilot-laps" title="Clear pilot laps" aria-label="Clear pilot laps">
            ${icons.trash(17)}
          </button>
        </header>
        <div data-slot="laps"></div>
      </section>`;

    this.listen(el, "click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-action="clear-pilot-laps"]');
      if (!btn || btn.disabled) return;
      e.stopPropagation();
      const pilot = this.store.pilot(this.store.selectedPilot);
      if (!pilot) return;
      this.confirmClearPilotLaps(pilot.slotIndex, btn);
    });

    this.adopt(new LapTimesCard(this.slot("laptimes"), store, { slotIndex: () => store.selectedPilot }));
    this.adopt(new SectionRecords(this.slot("records"), store));
    this.adopt(
      new PilotLaps(this.slot("laps"), store, {
        onToggleLap: (lapId) => {
          const sid = store.selectedPracticeSession?.sessionId;
          void api.practiceAction({ action: "toggle_session_lap", sessionId: sid, lapId }).catch(() => {
            // Ignore if no backend connected in standalone test
          });
        },
        onDeleteLap: (lapId) => {
          const sid = store.selectedPracticeSession?.sessionId;
          void api.practiceAction({ action: "delete_session_lap", sessionId: sid, lapId }).catch(() => {
            // Ignore if no backend connected in standalone test
          });
        },
        onClearPilotLaps: (slotIndex) => {
          this.confirmClearPilotLaps(slotIndex);
        },
      })
    );

    this.onDispose(() => {
      if (this.clearFlashTimer !== null) {
        window.clearTimeout(this.clearFlashTimer);
      }
    });

    const timer = window.setInterval(() => this.renderStats(), CLOCK_REFRESH_MS);
    this.onDispose(() => window.clearInterval(timer));
    this.onDispose(
      store.subscribe(["selection", "laps", "crossings", "practice"], () => this.renderStats())
    );
    this.renderStats();
  }

  private confirmClearPilotLaps(slotIndex: number, flashBtn?: HTMLButtonElement): void {
    const pilot = this.store.pilot(slotIndex);
    if (!pilot) return;
    const lapCount = allLapsFor(this.store, slotIndex).length;
    const sess = this.store.selectedPracticeSession;
    const sessLabel = sess ? `<strong>${esc(sess.name)}</strong>` : "this practice session";
    openConfirmModal({
      title: "Clear Pilot Laps?",
      messageHtml: `<p>Delete all ${lapCount > 0 ? `${lapCount} ` : ""}recorded lap${lapCount === 1 ? "" : "s"} for <strong>${esc(pilot.callsign)}</strong> in ${sessLabel}?</p>`,
      confirmLabel: "Clear Laps",
      danger: true,
      onConfirm: async () => {
        if (flashBtn) {
          flashBtn.classList.remove("btn-ghost");
          flashBtn.classList.add("btn-armed");
          if (this.clearFlashTimer !== null) {
            window.clearTimeout(this.clearFlashTimer);
          }
          this.clearFlashTimer = window.setTimeout(() => {
            this.clearFlashTimer = null;
            flashBtn.classList.remove("btn-armed");
            flashBtn.classList.add("btn-ghost");
          }, 350);
        }
        const curSess = this.store.selectedPracticeSession;
        this.store.clearPracticePilotLaps(slotIndex);
        await this.api
          .practiceAction({
            action: "clear_pilot_laps",
            sessionId: curSess?.sessionId,
            slotIndex,
          })
          .catch(() => {
            // Ignore if no backend connected in standalone test
          });
      },
    });
  }

  private renderStats(): void {
    const pilot = this.store.pilot(this.store.selectedPilot);
    const clearBtn = this.el.querySelector<HTMLButtonElement>('[data-action="clear-pilot-laps"]');
    if (!pilot) {
      if (clearBtn) clearBtn.disabled = true;
      this.slot("stats").innerHTML = "";
      return;
    }
    if (clearBtn) {
      clearBtn.disabled =
        allLapsFor(this.store, pilot.slotIndex).length === 0 &&
        !currentLap(this.store, pilot.slotIndex);
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
