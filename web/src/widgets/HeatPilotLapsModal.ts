import { esc } from "../core/format";
import { icons } from "../core/icons";
import { formatBandChannelWithFreq } from "../core/vtx_channels";
import { ApiClient } from "../services/api_client";
import { AppStore } from "../state/store";
import { HeatLap, HeatSeat, QualifyingMetric, RaceHeat, RaceTournamentState } from "../types/models";
import { heatStateBadge } from "./BracketDiagram";
import { openHeatLapEditorModal } from "./HeatLapEditorModal";
import { showToast } from "./Toast";

let activePilotLapsCleanup: (() => void) | null = null;

export function closeActivePilotLapsModal(): void {
  activePilotLapsCleanup?.();
}

export function computeBestConsecutiveCrossingIds(
  laps: HeatLap[],
  windowSize: 2 | 3 = 3
): { crossingIds: Set<number>; sumSec: number | null } {
  const valid = laps.filter((l) => l.lapNumber >= 1 && !l.invalidated && l.splitTimeSec > 0);
  if (valid.length < windowSize) {
    return { crossingIds: new Set<number>(), sumSec: null };
  }
  let bestSum = Infinity;
  let bestStart = -1;
  for (let i = 0; i <= valid.length - windowSize; i++) {
    let sum = 0;
    for (let k = 0; k < windowSize; k++) {
      sum += valid[i + k].splitTimeSec;
    }
    if (sum < bestSum - 1e-9) {
      bestSum = sum;
      bestStart = i;
    }
  }
  if (bestStart < 0 || !Number.isFinite(bestSum)) {
    return { crossingIds: new Set<number>(), sumSec: null };
  }
  const crossingIds = new Set<number>();
  for (let k = 0; k < windowSize; k++) {
    crossingIds.add(valid[bestStart + k].crossingId);
  }
  return { crossingIds, sumSec: bestSum };
}

function resolveRace(store: AppStore, raceId?: string): RaceTournamentState {
  if (raceId) {
    const found = store.races.find((r) => r.raceId === raceId);
    if (found) return found;
  }
  return store.raceState;
}

export function openHeatPilotLapsModal(
  store: AppStore,
  api: ApiClient,
  heatId: string,
  pilotSlotIndex: number,
  raceId?: string
): void {
  closeActivePilotLapsModal();

  const backdrop = document.createElement("div");
  backdrop.className = "slaprf-modal-backdrop pilot-laps-modal-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", "Pilot heat laps");

  const renderModal = (): void => {
    const prevPane = backdrop.querySelector<HTMLElement>("[data-pilot-laps-scroll]");
    const prevScrollTop = prevPane ? prevPane.scrollTop : 0;

    const race = resolveRace(store, raceId);
    const heat: RaceHeat | undefined = race.heats.find((h) => h.id === heatId);
    const seat: HeatSeat | undefined = heat?.seats.find((s) => s.pilotSlotIndex === pilotSlotIndex);

    if (!heat || !seat) {
      cleanup();
      return;
    }

    const stage = (race.stages ?? []).find((st) => st.index === heat.stageIndex);
    const isQual =
      heat.stageFormat === "qualifying" ||
      heat.stageFormat === "open_qualifier" ||
      stage?.format === "qualifying" ||
      stage?.format === "open_qualifier";
    const qualMetric: QualifyingMetric =
      stage?.settings?.qualifyingMetric || race.config.qualifyingMetric || "consecutive_3";

    const canMarshal = heat.state !== "waiting" && heat.state !== "confirmed";
    const explicitDnf = seat.status === "dnf" && Boolean(seat.statusOverridden);
    const seatRunOverridden = seat.status === "dq" || seat.status === "dns" || explicitDnf;
    const canToggleChip = canMarshal && !seatRunOverridden;

    let bestCrossingId = -1;
    let bestLapSec = Infinity;
    for (const l of seat.laps) {
      if (l.lapNumber >= 1 && !l.invalidated && l.splitTimeSec > 0 && l.splitTimeSec < bestLapSec) {
        bestLapSec = l.splitTimeSec;
        bestCrossingId = l.crossingId;
      }
    }
    const hasBestLap = bestCrossingId > 0 && Number.isFinite(bestLapSec);
    const consec3 = computeBestConsecutiveCrossingIds(seat.laps, 3);
    const consec2 = computeBestConsecutiveCrossingIds(seat.laps, 2);
    const highlightWindow: 2 | 3 = isQual && qualMetric === "consecutive_2" ? 2 : 3;
    const highlightedConsecIds = seatRunOverridden
      ? new Set<number>()
      : highlightWindow === 2
        ? consec2.crossingIds
        : consec3.crossingIds;

    const holeshotLap = seat.laps.find((l) => l.lapNumber === 0 && !l.invalidated);
    const heatBadge = heatStateBadge(heat.state, heat.inOvertime);

    interface StatItem {
      label: string;
      value: string;
      primary?: boolean;
      consecNeon?: boolean;
    }
    const stats: StatItem[] = [];

    if (isQual) {
      if (qualMetric === "consecutive_2") {
        stats.push({
          label: "Best 2 Consec",
          value: !seatRunOverridden && consec2.sumSec !== null ? `${consec2.sumSec.toFixed(2)}s` : "—",
          primary: true,
          consecNeon: !seatRunOverridden && consec2.sumSec !== null,
        });
        stats.push({
          label: "Best 3 Consec",
          value: !seatRunOverridden && consec3.sumSec !== null ? `${consec3.sumSec.toFixed(2)}s` : "—",
        });
      } else {
        stats.push({
          label: "Best 3 Consec",
          value: !seatRunOverridden && consec3.sumSec !== null ? `${consec3.sumSec.toFixed(2)}s` : "—",
          primary: qualMetric === "consecutive_3",
          consecNeon: !seatRunOverridden && consec3.sumSec !== null,
        });
      }
      stats.push({
        label: "Fastest Lap",
        value: !seatRunOverridden && hasBestLap ? `🔥 ${bestLapSec.toFixed(2)}s` : "—",
        primary: qualMetric === "fastest_lap",
      });
      stats.push({
        label: "Valid Laps",
        value:
          heat.targetLaps > 0
            ? `${seat.lapsCompleted}/${heat.targetLaps}`
            : `${seat.lapsCompleted}`,
        primary: qualMetric === "total_laps",
      });
      if (heat.startMode === "heads_up" && holeshotLap && !seatRunOverridden) {
        stats.push({
          label: "Holeshot",
          value: `${holeshotLap.splitTimeSec.toFixed(2)}s`,
        });
      }
    } else {
      stats.push({
        label: "Position",
        value: seat.position > 0 ? `#${seat.position}` : "—",
        primary: true,
      });
      stats.push({
        label: "Laps",
        value:
          heat.targetLaps > 0
            ? `${seat.lapsCompleted}/${heat.targetLaps}`
            : `${seat.lapsCompleted}`,
      });
      stats.push({
        label: "Total Time",
        value:
          !seatRunOverridden && seat.totalTimeSec > 0
            ? `${seat.totalTimeSec.toFixed(2)}s${seat.penaltySec > 0 ? ` (+${seat.penaltySec}s)` : ""}`
            : seat.penaltySec > 0
              ? `+${seat.penaltySec}s pen`
              : "—",
      });
      stats.push({
        label: "Fastest Lap",
        value: !seatRunOverridden && hasBestLap ? `🔥 ${bestLapSec.toFixed(2)}s` : "—",
      });
      stats.push({
        label: "Best 3 Consec",
        value: !seatRunOverridden && consec3.sumSec !== null ? `${consec3.sumSec.toFixed(2)}s` : "—",
        consecNeon: !seatRunOverridden && consec3.sumSec !== null,
      });
    }

    const statsStripHtml = stats
      .map(
        (st) => `
          <div class="pilot-laps-stat-item ${st.primary ? "is-primary" : ""} ${st.consecNeon ? "is-consec-neon" : ""}">
            <span class="pilot-laps-stat-label">${esc(st.label)}</span>
            <strong class="pilot-laps-stat-val mono">${esc(st.value)}</strong>
          </div>`
      )
      .join("");

    const chipsHtml =
      seat.laps.length > 0
        ? `<div class="pilot-laps-all-grid">${seat.laps
            .map((l) => {
              const tag = l.lapNumber === 0 ? "HS" : l.lapNumber < 0 ? "INV" : `L${l.lapNumber}`;
              const chipInvalid = l.invalidated || seatRunOverridden;
              const isHotLap = !chipInvalid && l.crossingId === bestCrossingId;
              const isBestConsec = !chipInvalid && highlightedConsecIds.has(l.crossingId);
              const chipTitle = canToggleChip
                ? l.invalidated
                  ? "Click to restore lap"
                  : "Click to drop / cross out lap"
                : seatRunOverridden && canMarshal
                  ? "Change pilot status from DNS / Crashed Out / DQ to restore laps"
                  : `${tag} ${l.splitTimeSec.toFixed(2)}s`;
              return `<button
                type="button"
                class="race-lap-chip mono ${chipInvalid ? "is-invalid" : ""} ${l.manual ? "is-manual" : ""} ${isHotLap ? "is-hot-lap" : ""} ${isBestConsec ? "is-best-consec" : ""}"
                data-modal-toggle-lap="${l.crossingId}"
                ${canToggleChip ? "" : "disabled"}
                title="${esc(chipTitle)}"
              >${isHotLap ? "🔥 " : ""}${tag} ${l.splitTimeSec.toFixed(2)}s</button>`;
            })
            .join("")}</div>`
        : `<div class="race-empty-state" style="padding:22px 12px"><p style="margin:0">No passes recorded yet for ${esc(seat.callsign)}.</p></div>`;

    const consecLegendText =
      highlightWindow === 2 ? "Fastest 2 consecutive" : "Fastest 3 consecutive";

    backdrop.innerHTML = `
      <div class="slaprf-modal pilot-laps-modal card" role="document">
        <div class="slaprf-modal-head">
          <div class="slaprf-modal-title-row">
            <span class="dot" style="--c:${seat.color || "#38bdf8"}"></span>
            <h3>${esc(seat.callsign)}</h3>
            <span class="badge mono">${esc(formatBandChannelWithFreq(seat.band, seat.channel, seat.frequencyMhz, false))}</span>
            <span class="badge mono">${esc(heat.shortLabel)}</span>
            <span class="race-state-pill ${heatBadge.cls}"><span>${esc(heatBadge.label)}</span></span>
          </div>
          <button type="button" class="btn btn-ghost btn-xs" data-pilot-laps-close aria-label="Close">
            ${icons.close(15)}
          </button>
        </div>

        <div class="pilot-laps-stats-strip" data-pilot-laps-stats>
          ${statsStripHtml}
        </div>

        <div class="pilot-laps-grid-pane" data-pilot-laps-scroll>
          ${chipsHtml}
        </div>

        <div class="slaprf-modal-foot pilot-laps-modal-foot">
          <div class="pilot-laps-legend note">
            ${canToggleChip ? `<span>Click any lap to cross out / restore</span><span>·</span>` : ""}
            <span class="pilot-laps-legend-consec"><span class="pilot-laps-neon-swatch" aria-hidden="true"></span>${esc(consecLegendText)}</span>
            <span>·</span>
            <span>🔥 Hot lap</span>
          </div>
          <div class="pilot-laps-foot-btns">
            <button type="button" class="btn btn-ghost btn-sm" data-pilot-laps-open-rssi>
              ${icons.gauge(14)}
              <span>RSSI Editor</span>
            </button>
            <button type="button" class="btn btn-armed btn-sm" data-pilot-laps-close>
              <span>Done</span>
            </button>
          </div>
        </div>
      </div>
    `;

    const nextPane = backdrop.querySelector<HTMLElement>("[data-pilot-laps-scroll]");
    if (nextPane && prevScrollTop > 0) {
      nextPane.scrollTop = prevScrollTop;
    }
  };

  const unsub = store.subscribe(["race", "config"], () => {
    renderModal();
  });

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    }
  };

  const cleanup = (): void => {
    unsub();
    window.removeEventListener("keydown", onKeyDown, true);
    if (backdrop.parentNode) {
      backdrop.parentNode.removeChild(backdrop);
    }
    if (activePilotLapsCleanup === cleanup) {
      activePilotLapsCleanup = null;
    }
  };
  activePilotLapsCleanup = cleanup;

  window.addEventListener("keydown", onKeyDown, true);

  backdrop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (t === backdrop || t.closest("[data-pilot-laps-close]")) {
      cleanup();
      return;
    }
    if (t.closest("[data-pilot-laps-open-rssi]")) {
      cleanup();
      openHeatLapEditorModal(store, api, heatId, pilotSlotIndex, raceId);
      return;
    }
    const chipBtn = t.closest<HTMLButtonElement>("[data-modal-toggle-lap]");
    if (chipBtn && !chipBtn.disabled) {
      const crossingId = Number(chipBtn.dataset.modalToggleLap);
      if (crossingId > 0) {
        void api
          .raceMarshal({
            raceId,
            heatId,
            pilotSlotIndex,
            action: "toggle_lap",
            crossingId,
          })
          .catch((err) => {
            showToast(err instanceof Error ? err.message : String(err), "warn");
          });
      }
    }
  });

  renderModal();
  if (!activePilotLapsCleanup) {
    return;
  }
  document.body.appendChild(backdrop);
}
