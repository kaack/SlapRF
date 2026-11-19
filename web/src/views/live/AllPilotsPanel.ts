import { Component } from "../../core/component";
import { esc, fmtDelta, fmtTime } from "../../core/format";
import { icons } from "../../core/icons";
import { ApiClient } from "../../services/api_client";
import { practiceStats } from "../../state/analysis";
import { fastestLap } from "../../state/selectors";
import { AppStore } from "../../state/store";
import { LapTimesCard } from "../../widgets/LapTimesCard";
import { LiveStandings } from "../../widgets/LiveStandings";
import { openConfirmModal } from "../../widgets/ConfirmModal";
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
      <div class="stat-row" data-slot="stats" data-practice-mobile-pane="overview"></div>
      <section class="card card-flush practice-standings-card" data-practice-mobile-pane="overview">
        <header class="card-head">
          <div class="settings-intro"><h2>Pilots</h2><p>Ranked by best lap. Click a pilot to follow their live lap.</p></div>
          <button type="button" class="btn btn-sm btn-icon btn-ghost" data-action="reset-laps" title="Clear session laps" aria-label="Clear session laps">
            ${icons.trash(17)}
          </button>
        </header>
        <div data-slot="standings"></div>
      </section>
      <section class="card card-flush practice-trends-card" data-slot="laptimes" data-practice-mobile-pane="trends"></section>
      <section class="card card-flush practice-sections-card practice-desktop-sections-card" data-practice-mobile-pane="trends">
        <header class="card-head"><div class="settings-intro"><h2>Section records</h2><p>Fastest time for each pilot in every section.</p></div></header>
        <div data-slot="records"></div>
      </section>`;

    this.listen(el, "click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-action="reset-laps"]');
      if (!btn) return;
      const sess = this.store.selectedPracticeSession;
      const sessLabel = sess ? `<strong>${esc(sess.name)}</strong>` : "this practice session";
      openConfirmModal({
        title: "Clear Session Laps?",
        messageHtml: `<p>Clear all recorded laps for ${sessLabel}?</p>`,
        confirmLabel: "Clear Laps",
        danger: true,
        onConfirm: async () => {
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
          const curSess = this.store.selectedPracticeSession;
          if (curSess) {
            await this.api.practiceAction({ action: "clear_session_laps", sessionId: curSess.sessionId });
          } else {
            await this.api.resetSession();
          }
        },
      });
    });

    this.adopt(new LiveStandings(this.slot("standings"), store, follow));
    this.adopt(new LapTimesCard(this.slot("laptimes"), store));
    this.adopt(new SectionRecords(this.slot("records"), store));

    this.onDispose(() => {
      if (this.resetFlashTimer !== null) {
        window.clearTimeout(this.resetFlashTimer);
      }
    });

    this.onDispose(store.subscribe(["laps", "crossings", "config", "status", "practice"], () => this.renderStats()));
    this.renderStats();
  }

  private renderStats(): void {
    const s = this.store;
    const resetBtn = this.el.querySelector<HTMLButtonElement>('[data-action="reset-laps"]');
    if (resetBtn) {
      resetBtn.disabled = s.laps.length === 0 && s.crossings.length === 0;
    }

    const pilotStats = s.enabledPilots.map((p) => practiceStats(s, p));
    const fastest = fastestLap(s);

    // 1. Most consistent: pilot with >= 2 laps who has the lowest lap-time standard deviation.
    let mostConsistent: { callsign: string; stdDevSec: number; lapCount: number } | null = null;
    for (const ps of pilotStats) {
      const validTimes = ps.laps.map((l) => l.lapTimeSec).filter((t) => t > 0);
      if (validTimes.length < 2) continue;
      const meanSec = validTimes.reduce((acc, t) => acc + t, 0) / validTimes.length;
      const variance =
        validTimes.reduce((acc, t) => acc + (t - meanSec) ** 2, 0) / validTimes.length;
      const stdDevSec = Math.sqrt(variance);
      if (
        !mostConsistent ||
        stdDevSec < mostConsistent.stdDevSec - 1e-6 ||
        (Math.abs(stdDevSec - mostConsistent.stdDevSec) <= 1e-6 &&
          validTimes.length > mostConsistent.lapCount)
      ) {
        mostConsistent = {
          callsign: ps.pilot.callsign,
          stdDevSec,
          lapCount: validTimes.length,
        };
      }
    }

    // 2. Most laps: pilot with the highest completed lap count in this session.
    let mostLaps: { callsign: string; lapCount: number } | null = null;
    for (const ps of pilotStats) {
      const count = ps.laps.length;
      if (count <= 0) continue;
      if (!mostLaps || count > mostLaps.lapCount) {
        mostLaps = {
          callsign: ps.pilot.callsign,
          lapCount: count,
        };
      }
    }

    // 4. Overall fastest: best ratio of total laps to total track time (lowest mean track time per lap).
    let overallFastest: {
      callsign: string;
      lapCount: number;
      totalSec: number;
      avgSec: number;
    } | null = null;
    const hasMultiLapPilot = pilotStats.some(
      (ps) => ps.laps.filter((l) => l.lapTimeSec > 0).length >= 2
    );
    const minLapsForOverall = hasMultiLapPilot ? 2 : 1;
    for (const ps of pilotStats) {
      const validTimes = ps.laps.map((l) => l.lapTimeSec).filter((t) => t > 0);
      if (validTimes.length < minLapsForOverall) continue;
      const totalSec = validTimes.reduce((acc, t) => acc + t, 0);
      if (totalSec <= 0) continue;
      const avgSec = totalSec / validTimes.length;
      if (
        !overallFastest ||
        avgSec < overallFastest.avgSec - 1e-6 ||
        (Math.abs(avgSec - overallFastest.avgSec) <= 1e-6 &&
          validTimes.length > overallFastest.lapCount)
      ) {
        overallFastest = {
          callsign: ps.pilot.callsign,
          lapCount: validTimes.length,
          totalSec,
          avgSec,
        };
      }
    }

    if (pilotStats.length === 1) {
      const ps = pilotStats[0];
      this.slot("stats").innerHTML = renderStatTiles([
        {
          label: "Last lap",
          value: fmtTime(ps.lastLap),
          sub:
            ps.lastLap > 0 && ps.bestLap > 0
              ? ps.lastLap === ps.bestLap
                ? "Personal best"
                : `${fmtDelta(ps.lastLap - ps.bestLap)} vs best`
              : "No laps yet",
        },
        {
          label: "Fastest lap",
          value: fmtTime(ps.bestLap),
          sub: `${ps.laps.length} lap${ps.laps.length === 1 ? "" : "s"} this session`,
          tone: ps.bestLap > 0 ? "accent" : undefined,
        },
        {
          label: "Average, last 5",
          value: fmtTime(ps.rollingAvg),
          sub: Number.isFinite(ps.trend)
            ? `${fmtDelta(ps.trend)} vs the 5 before`
            : "Trend after 10 laps",
          tone: Number.isFinite(ps.trend) ? (ps.trend < 0 ? "good" : "bad") : undefined,
        },
        {
          label: "Consistency",
          value: mostConsistent ? `±${mostConsistent.stdDevSec.toFixed(2)}s` : "—",
          sub: mostConsistent
            ? `Spread across ${mostConsistent.lapCount} laps`
            : "Need 2+ laps",
        },
      ]);
      return;
    }

    this.slot("stats").innerHTML = renderStatTiles([
      {
        label: "Most consistent",
        value: mostConsistent ? mostConsistent.callsign : "—",
        sub: mostConsistent
          ? `±${mostConsistent.stdDevSec.toFixed(2)}s spread · ${mostConsistent.lapCount} laps`
          : "Need 2+ laps",
      },
      {
        label: "Most laps",
        value: mostLaps ? mostLaps.callsign : "—",
        sub: mostLaps
          ? `${mostLaps.lapCount} lap${mostLaps.lapCount === 1 ? "" : "s"} · ${s.laps.length} total`
          : "No laps yet",
      },
      {
        label: "Session fastest",
        value: fastest ? fastest.callsign : "—",
        sub: fastest ? `Lap ${fastest.lapNumber} · ${fmtTime(fastest.lapTimeSec)}s` : "No laps yet",
        tone: fastest ? "accent" : undefined,
      },
      {
        label: "Overall fastest",
        value: overallFastest ? overallFastest.callsign : "—",
        sub: overallFastest
          ? `${overallFastest.lapCount} laps / ${overallFastest.totalSec.toFixed(1)}s (${overallFastest.avgSec.toFixed(2)}s/lap)`
          : "Total laps over least track time",
      },
    ]);
  }
}
