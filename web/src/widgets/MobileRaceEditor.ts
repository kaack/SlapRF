import {
  closeCustomSelect,
  isCustomSelectOpenWithin,
  scanCustomSelects,
} from "../core/custom_select";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { fitScheduleLineups } from "../core/table_scroll";
import { adaptColorForTheme } from "../core/theme";
import {
  decodeBandChannel,
  formatBandChannelShort,
  formatEncodedChannelShort,
  isValidEncodedSeatChannel,
  renderMultiBandSelectOptionsHtml,
} from "../core/vtx_channels";
import { ApiClient } from "../services/api_client";
import {
  EventPilot,
  FinalsFormat,
  QualifyingMetric,
  RaceHeat,
  RaceRound,
  RaceSetupConfig,
  RaceTournamentState,
  RoundConnection,
  RoundConnectionMode,
  StageFormat,
  StartMode,
  TournamentStanding,
} from "../types/models";
import {
  formatQualifyingMetricLabel,
  formatRaceClock,
  heatStateBadge,
  isHandoffInRoundId,
  isHandoffOutRoundId,
  isHandoffPortalRound,
  isHeatUnstarted,
  isPilotsInRoundId,
  raceLifecycleBadge,
  roundNeedsDeleteConfirmation,
  seedColorForNumber,
} from "./BracketDiagram";
import { openConfirmModal } from "./ConfirmModal";
import { mountTagPillEditor, renderTagPillBoxHtml } from "./TagPillEditor";
import { cleanConnectionInvalidReason } from "./Toast";

export type MobileConstructKind =
  | "qualifying"
  | "open_qualifier"
  | "zippyq_qualifier"
  | "race"
  | "points_mains"
  | "finals";

export interface MobileRaceEditorUiState {
  activePageId: string;
  connectToPreviousOnAdd: boolean;
  isStripStuck: boolean;
  lastOrderedRoundIds: string[];
}

export function createDefaultMobileRaceEditorState(): MobileRaceEditorUiState {
  return {
    activePageId: "",
    connectToPreviousOnAdd: true,
    isStripStuck: false,
    lastOrderedRoundIds: [],
  };
}

export function resolveNextRoundIdAfterDelete(
  prevIds: string[],
  deletedId: string,
  nextRounds: RaceRound[]
): string {
  if (nextRounds.length === 0) return "";
  const validNext = new Set(nextRounds.map((r) => r.id));
  const idx = prevIds.indexOf(deletedId);
  if (idx > 0) {
    for (let k = idx - 1; k >= 0; k--) {
      if (validNext.has(prevIds[k])) return prevIds[k];
    }
    for (let k = idx + 1; k < prevIds.length; k++) {
      if (validNext.has(prevIds[k])) return prevIds[k];
    }
  } else if (idx === 0) {
    for (let k = 1; k < prevIds.length; k++) {
      if (validNext.has(prevIds[k])) return prevIds[k];
    }
  }
  return nextRounds[0].id;
}

export interface MobileRaceEditorCallbacks {
  getRace: () => RaceTournamentState;
  getAllTags: () => string[];
  api: ApiClient;
  ui: MobileRaceEditorUiState;
  onOpenTemplates: () => void;
  onOpenPilotsTab: () => void;
  onOpenQueueTab: () => void;
  onOpenReviewHeat: (heatId: string) => void;
  onError: (err: unknown) => void;
  onUiMutated: () => void;
}

const LANE_SORT_PRIORITY: Record<string, number> = {
  qualifying: 0,
  open_qual: 1,
  winners: 2,
  main: 2,
  mains: 3,
  losers: 4,
  finals: 5,
};

export function getSortedMobileRounds(race: RaceTournamentState): RaceRound[] {
  const realRounds = (race.rounds ?? []).filter((r) => !isHandoffPortalRound(r));
  return [...realRounds].sort((a, b) => {
    const colA = a.column || 1;
    const colB = b.column || 1;
    if (colA !== colB) return colA - colB;
    const priA = LANE_SORT_PRIORITY[a.bracketLane] ?? 2;
    const priB = LANE_SORT_PRIORITY[b.bracketLane] ?? 2;
    if (priA !== priB) return priA - priB;
    if ((a.round || 0) !== (b.round || 0)) return (a.round || 0) - (b.round || 0);
    return a.id.localeCompare(b.id);
  });
}

export function getRoundAddHeatRestriction(
  race: RaceTournamentState,
  round: RaceRound,
  roundHeats: RaceHeat[],
  realConnections: RoundConnection[],
  pilotsConn: RoundConnection | undefined,
  activePilots: EventPilot[]
): { canAdd: boolean; reason: string } {
  const pph = Math.max(2, race.config.pilotsPerHeat || 4);
  const defAdv = Math.max(1, Math.floor(pph / 2));

  let outAdv = 0;
  if (round.bracketLane !== "finals" && round.stageFormat !== "qualifying" && round.stageFormat !== "open_qualifier") {
    for (const c of realConnections) {
      if (c.invalid || c.fromRoundId !== round.id || c.mode !== "top_per_heat") {
        continue;
      }
      const cnt = c.count && c.count >= 1 ? c.count : defAdv;
      if (cnt > outAdv) outAdv = cnt;
    }
  }

  const inConns = realConnections.filter((c) => !c.invalid && c.toRoundId === round.id);
  const isAutoFed =
    inConns.length > 0 ||
    pilotsConn !== undefined ||
    round.seedSource === "all_active_pilots";

  if (!isAutoFed || outAdv < 1) {
    return { canAdd: true, reason: "" };
  }

  let startedCount = 0;
  let unstartedEntrants = 0;
  let totalEntrants = 0;
  for (const h of roundHeats) {
    let hEntrants = 0;
    for (const s of h.seats) {
      if (s.pilotSlotIndex > 0 || (s.feeder && !s.feeder.isBye)) {
        hEntrants++;
      }
    }
    totalEntrants += hEntrants;
    if (isHeatUnstarted(h.state)) {
      unstartedEntrants += hEntrants;
    } else {
      startedCount++;
    }
  }
  if (totalEntrants === 0 && (pilotsConn !== undefined || round.seedSource === "all_active_pilots")) {
    totalEntrants = activePilots.length;
    unstartedEntrants = activePilots.length;
  }

  const poolN = startedCount > 0 ? unstartedEntrants : totalEntrants;
  if (poolN < 2) {
    return { canAdd: true, reason: "" };
  }

  const minHeats = Math.max(1, Math.ceil(poolN / pph));
  const maxUnstartedHeats = Math.max(minHeats, Math.floor(poolN / (outAdv + 1)));
  const maxTotalHeats = startedCount + maxUnstartedHeats;

  if (roundHeats.length >= maxTotalHeats) {
    const minPilotsPerHeat = outAdv + 1;
    return {
      canAdd: false,
      reason: `Cannot add another heat: advancing Top ${outAdv} per heat requires at least ${minPilotsPerHeat} pilots per heat so at least 1 pilot is eliminated (${totalEntrants} pilots in this round, max ${maxTotalHeats} ${maxTotalHeats === 1 ? "heat" : "heats"}).`,
    };
  }

  return { canAdd: true, reason: "" };
}

export function formatMobileRoundDisplayTitle(round: RaceRound): string {
  const t = (round.title || "").trim();
  if (!t) {
    return `R${round.round || 1}`;
  }
  const mainMatch = /^([A-Z])\s*-?\s*Main$/i.exec(t);
  if (mainMatch) {
    return `${mainMatch[1].toUpperCase()}-Main`;
  }
  if (/^(?:finals|grand\s*finals?)$/i.test(t)) {
    return "Fin";
  }
  const qualMatch = /^qual(?:ifying|ifier)(?:\s*·?\s*(?:round|rd))?\s*r?(\d+)$/i.exec(t);
  if (qualMatch) {
    return `Q${qualMatch[1]}`;
  }
  const winMatch = /^winners?(?:\s+round)?\s*r?(\d+)$/i.exec(t);
  if (winMatch) {
    return `W${winMatch[1]}`;
  }
  const redMatch = /^(?:redemption|losers?)(?:\s+round)?\s*r?(\d+)$/i.exec(t);
  if (redMatch) {
    return `R${redMatch[1]}`;
  }
  const mainsMatch = /^mains?(?:\s+round)?\s*r?(\d+)$/i.exec(t);
  if (mainsMatch) {
    return `M${mainsMatch[1]}`;
  }
  const rndMatch = /^round\s*r?(\d+)$/i.exec(t);
  if (rndMatch) {
    return `R${rndMatch[1]}`;
  }
  const zqNumMatch = /^zippyq(?:\s+round)?\s*r?(\d+)$/i.exec(t);
  if (zqNumMatch) {
    return `ZQ${zqNumMatch[1]}`;
  }
  if (/^zippyq(?:\s+qualifier)?$/i.test(t)) {
    return "ZQ";
  }
  if (/^open\s+qualifier$/i.test(t)) {
    return "OQ";
  }
  return t;
}

export function formatDesktopRoundDisplayTitle(round: RaceRound): string {
  const t = (round.title || "").trim();
  if (!t) {
    return `Round ${round.round || 1}`;
  }
  const qualMatch = /^qual(?:ifying|ifier)(?:\s*·?\s*(?:round|rd))?\s*r?(\d+)$/i.exec(t);
  if (qualMatch) {
    return `Qualifying · Round ${qualMatch[1]}`;
  }
  return t;
}

export function formatRoundPillCode(round: RaceRound, index: number): string {
  const disp = formatMobileRoundDisplayTitle(round);
  if (/^semi[-\s]*finals?$/i.test(disp)) {
    return "Semi";
  }
  if (/^quarter[-\s]*finals?$/i.test(disp)) {
    return "QF";
  }
  if (disp.length <= 6) return disp || `R${index + 1}`;
  return disp.slice(0, 5).trim();
}

export function formatLaneBadge(round: RaceRound): { label: string; cls: string } {
  if (round.stageFormat === "open_qualifier" || round.bracketLane === "open_qual") {
    return { label: "Open Qual", cls: "is-qual" };
  }
  if (round.stageFormat === "qualifying" || round.bracketLane === "qualifying") {
    return { label: "Qualifying", cls: "is-qual" };
  }
  if (round.bracketLane === "finals") {
    return { label: "Finals", cls: "is-finals" };
  }
  if (round.bracketLane === "losers") {
    return { label: "Redemption", cls: "is-losers" };
  }
  if (round.stageFormat === "points_mains" || round.bracketLane === "mains") {
    return { label: "Points", cls: "is-mains" };
  }
  return { label: "Race Round", cls: "is-winners" };
}

export function formatRoundTimingSubtitle(round: RaceRound, race: RaceTournamentState): string {
  const cfg = race.config;
  const startLbl =
    (round.startMode ??
      (round.stageFormat === "qualifying" || round.stageFormat === "open_qualifier"
        ? "staggered"
        : "heads_up")) === "staggered"
      ? "Staggered"
      : "Heads-Up";
  const clockLbl = `${formatRaceClock(round.timeLimitSec || cfg.timeLimitSec || 120).replace(/\.0$/, "")} Clock`;

  if (round.stageFormat === "open_qualifier" || round.stageFormat === "qualifying") {
    const metric = round.qualifyingMetric || cfg.qualifyingMetric || "consecutive_3";
    const metricShort = formatQualifyingMetricLabel(metric);
    const maxPacks = round.maxPacksPerPilot ?? cfg.maxPacksPerPilot ?? 0;
    const packsBit =
      round.stageFormat === "open_qualifier"
        ? maxPacks > 0
          ? ` · Max ${maxPacks} packs`
          : " · Unlimited packs"
        : "";
    return `${startLbl} · ${clockLbl} · ${metricShort}${packsBit}`;
  }

  if (round.bracketLane === "finals") {
    const fFmt = round.finalsFormat || cfg.finalsFormat || "single_final";
    const laps = round.targetLaps > 0 ? `${round.targetLaps} Laps` : clockLbl;
    if (fFmt === "chase_the_ace") {
      const wins = Math.max(2, round.aceWinsRequired || cfg.aceWinsRequired || 2);
      return `${startLbl} · Chase the Ace (${wins} wins) · ${laps}`;
    }
    if (fFmt === "points_final") {
      const sh = Math.max(2, round.finalsHeats || 3);
      return `${startLbl} · ${sh}-Heat Points Series · ${laps}`;
    }
    return `${startLbl} · Single Final · ${laps}`;
  }

  const lapsLbl =
    round.targetLaps > 0 ? `First to ${round.targetLaps} Laps` : "Timed Laps";
  if (round.stageFormat === "points_mains") {
    return `${startLbl} · Points · ${lapsLbl} · ${clockLbl}`;
  }
  return `${startLbl} · ${lapsLbl} · ${clockLbl}`;
}

export function formatMobileConnectionSummary(conn: RoundConnection): string {
  if (conn.mode === "standings_top") {
    const dist = conn.distribution === "sequential" ? "Sequential" : "Snake";
    const sStart = Math.max(0, conn.seedStart || 0);
    const sEnd = Math.max(0, conn.seedEnd || 0);
    if (sStart > 1 && sEnd >= sStart) {
      return `Ranks #${sStart}-#${sEnd} · ${dist}`;
    }
    if (sStart === 1 && sEnd > 0) {
      return `Top ${sEnd} · ${dist}`;
    }
    if (conn.count && conn.count > 0) {
      return `Top ${conn.count} · ${dist}`;
    }
    return `All Qualified · ${dist}`;
  }
  const n = Math.max(1, conn.count || 2);
  switch (conn.mode) {
    case "bottom_per_heat":
      return `Bottom ${n} / heat`;
    case "all_pilots":
      return "All pilots · Balanced";
    case "all_pilots_ranked":
      return "All pilots · Ranked";
    case "top_per_heat":
    default:
      return `Top ${n} / heat`;
  }
}

export function formatInitialSeedModeLabel(round: RaceRound, hasPilotsConn: RoundConnection | undefined): string {
  if (round.stageFormat === "open_qualifier") {
    return "Flight Queue";
  }
  const dist = hasPilotsConn?.distribution || round.seedDistribution || "roster";
  const isSeeded = Boolean(hasPilotsConn) || round.seedSource === "all_active_pilots";
  if (!isSeeded) {
    return "Manual / Empty Seats";
  }
  if (dist === "random") return "Random Balanced";
  if (dist === "snake") return "Bracket Snake (Fold)";
  if (dist === "sequential") return "Grouped by Seed";
  return "Roster Order";
}

function renderConstructPickerCards(attrName: string): string {
  const items: Array<{
    kind: MobileConstructKind;
    title: string;
    sub: string;
    iconHtml: string;
  }> = [
    {
      kind: "qualifying",
      title: "Qualifier",
      sub: "Pre-scheduled staggered heats",
      iconHtml: icons.timer(16),
    },
    {
      kind: "open_qualifier",
      title: "Open Qualifier",
      sub: "Walk-up flight queue packs",
      iconHtml: icons.zap(16),
    },
    {
      kind: "zippyq_qualifier",
      title: "ZippyQ",
      sub: "MultiGP dynamic flight queue",
      iconHtml: icons.zap(16),
    },
    {
      kind: "race",
      title: "Race Round",
      sub: "Head-to-head elimination or main",
      iconHtml: icons.checkered(16),
    },
    {
      kind: "points_mains",
      title: "Points Round",
      sub: "Cumulative points division",
      iconHtml: icons.layers(16),
    },
    {
      kind: "finals",
      title: "Finals",
      sub: "Single heat, Chase the Ace, or Series",
      iconHtml: icons.trophy(16),
    },
  ];

  return `
    <div class="mre-construct-grid">
      ${items
        .map(
          (item) => `
        <button
          type="button"
          class="mre-construct-card"
          ${attrName}="${item.kind}"
        >
          <span class="mre-construct-ico">${item.iconHtml}</span>
          <span class="mre-construct-text">
            <strong>${esc(item.title)}</strong>
            <span class="note">${esc(item.sub)}</span>
          </span>
        </button>`
        )
        .join("")}
    </div>`;
}

function defaultRaceSeatChannels(count: number): number[] {
  if (count <= 2) return [1, 8].slice(0, Math.max(2, count));
  if (count === 3) return [1, 4, 8];
  if (count === 4) return [1, 3, 5, 8];
  if (count === 5) return [1, 3, 5, 7, 8];
  if (count === 6) return [1, 2, 4, 5, 7, 8];
  return [1, 2, 3, 4, 5, 6, 7, 8].slice(0, Math.min(8, count));
}

export function formatRaceSettingsSubtitle(race: RaceTournamentState): string {
  const cfg = race.config;
  const pph = Math.max(2, Math.min(8, cfg.pilotsPerHeat || 4));
  const channels =
    cfg.seatChannels && cfg.seatChannels.length === pph
      ? cfg.seatChannels
      : defaultRaceSeatChannels(pph);
  const chStr = channels
    .map((ch) => formatEncodedChannelShort(ch) || `R${ch}`)
    .join(" ");
  const cdSec = cfg.countdownSec ?? 5;
  const cdLbl = cdSec <= 0 ? "Instant Horn" : `${cdSec}s Countdown`;
  const clockStr = formatRaceClock(cfg.timeLimitSec || 120).replace(/\.0$/, "");
  const defLapsStr =
    cfg.targetLaps && cfg.targetLaps > 0
      ? `${cfg.targetLaps} Laps / ${clockStr}`
      : `${clockStr} Clock`;
  return `${pph}-Up (${chStr}) · ${cdLbl} · ${defLapsStr}`;
}

function renderMobileRaceHeaderCard(
  race: RaceTournamentState,
  roundsCount: number,
  canEditStructure: boolean,
  anyHeatStarted: boolean
): string {
  const raceTitle = (race.config.eventName || "").trim() || "Untitled Race";
  const settingsSub = formatRaceSettingsSubtitle(race);
  const configured =
    Boolean(race.generated) || roundsCount > 0 || (race.heats?.length ?? 0) > 0;
  const statusBadge = race.emergencyStopped
    ? { label: "Stopped", cls: "is-stopped" }
    : !configured
      ? { label: "New", cls: "is-waiting" }
      : raceLifecycleBadge(race.isComplete && !race.lifecycle ? "completed" : race.lifecycle);

  return `
    <div class="mre-race-header-wrap">
      <section class="card mre-round-header mre-race-header" aria-label="Race information">
        <div class="mre-round-header-top">
          <div class="mre-round-title-group">
            <h3 class="mre-round-title">${esc(raceTitle)}</h3>
            <span class="race-state-pill ${statusBadge.cls}" data-mre-race-status>${esc(statusBadge.label)}</span>
          </div>
          <div class="mre-round-header-btns">
            ${
              canEditStructure && !anyHeatStarted && roundsCount > 0
                ? `<button
                    type="button"
                    class="btn btn-ghost btn-xs mre-top-btn"
                    data-mre-open-templates
                    title="Apply tournament template"
                  >${icons.layers(13)}<span>Templates</span></button>`
                : ""
            }
            ${
              canEditStructure
                ? `<button
                    type="button"
                    class="btn btn-ghost btn-xs mre-icon-btn"
                    data-mre-open-defaults
                    title="Race settings"
                    aria-label="Race settings"
                  >${icons.sliders(19)}</button>`
                : ""
            }
            <button
              type="button"
              class="btn btn-ghost btn-xs mre-icon-btn dte-danger-icon"
              data-race-act="delete-race"
              data-race-id="${esc(race.raceId)}"
              ${!race.isComplete && !race.emergencyStopped && race.lifecycle === "active" ? "disabled" : ""}
              title="${!race.isComplete && !race.emergencyStopped && race.lifecycle === "active" ? "Pause or complete this race before deleting" : `Delete ${esc(raceTitle)}`}"
              aria-label="Delete race"
            >${icons.trash(17)}</button>
          </div>
        </div>
        <div class="mre-round-subtitle note">${esc(settingsSub)}</div>
      </section>
    </div>`;
}

export function renderMobileRaceEditorHtml(
  race: RaceTournamentState,
  ui: MobileRaceEditorUiState
): string {
  const rounds = getSortedMobileRounds(race);
  const canEditStructure =
    race.lifecycle !== "completed" && race.lifecycle !== "scrapped";
  const anyHeatStarted = (race.heats ?? []).some((h) => !isHeatUnstarted(h.state));
  const roster = race.roster ?? [];
  const activePilots = roster.filter((p) => p.checkedIn && p.attendance === "active");
  const raceHeaderHtml = renderMobileRaceHeaderCard(
    race,
    rounds.length,
    canEditStructure,
    anyHeatStarted
  );

  if (rounds.length === 0) {
    ui.activePageId = "";
    ui.lastOrderedRoundIds = [];
    return `
      <div class="mre-shell" data-mre-root>
        ${raceHeaderHtml}
        <div class="mre-empty-scroll" data-preserve-scroll="mre-empty">
          <div class="card mre-empty-card">
            <div class="mre-empty-hero">
              <span class="mre-empty-icon">${icons.bracket(24)}</span>
              <div class="mre-empty-copy">
                <strong>Build Race Schedule</strong>
                <p class="note">Start fast from a tournament template, or add your first round below.</p>
              </div>
            </div>
            <div class="mre-empty-roster-bar">
              <div class="mre-empty-roster-count">
                ${icons.pilot(14)}
                <span><strong>${activePilots.length}</strong> pilot${activePilots.length === 1 ? "" : "s"} checked in</span>
              </div>
              <button type="button" class="btn btn-ghost btn-xs" data-mre-open-pilots>
                <span>Manage Pilots</span>${icons.chevronRight(13)}
              </button>
            </div>
            <button type="button" class="btn btn-armed mre-primary-tpl-btn" data-mre-open-templates>
              ${icons.layers(15)}<span>Choose Race Template</span>
            </button>
            <div class="mre-empty-divider"><span>or add first round manually</span></div>
            ${canEditStructure ? renderConstructPickerCards("data-mre-add-round") : ""}
          </div>
        </div>
      </div>`;
  }

  const hasFinalsRound = rounds.some((r) => r.bracketLane === "finals");
  const canAppendRound = canEditStructure && !hasFinalsRound;
  const validPageIds = new Set(rounds.map((r) => r.id));
  if (canAppendRound) validPageIds.add("__add__");
  if (!ui.activePageId) {
    ui.activePageId = rounds[0].id;
  } else if (!validPageIds.has(ui.activePageId)) {
    ui.activePageId = resolveNextRoundIdAfterDelete(
      ui.lastOrderedRoundIds,
      ui.activePageId,
      rounds
    );
  }
  ui.lastOrderedRoundIds = rounds.map((r) => r.id);

  const roundById = new Map<string, RaceRound>();
  for (const r of rounds) roundById.set(r.id, r);

  const realConnections = (race.connections ?? []).filter(
    (c) =>
      !isHandoffInRoundId(c.fromRoundId) &&
      !isHandoffOutRoundId(c.toRoundId) &&
      !isPilotsInRoundId(c.fromRoundId) &&
      c.mode !== "pilots_in" &&
      c.mode !== "qual_feed" &&
      c.mode !== "stage_seeds"
  );

  const pilotsConnsByTarget = new Map<string, RoundConnection>();
  for (const c of race.connections ?? []) {
    if (c.mode === "pilots_in" || isPilotsInRoundId(c.fromRoundId)) {
      pilotsConnsByTarget.set(c.toRoundId, c);
    }
  }

  const stepperPillsHtml = rounds
    .map((r, idx) => {
      const active = ui.activePageId === r.id;
      const code = formatRoundPillCode(r, idx);
      const badge = formatLaneBadge(r);
      return `
        <button
          type="button"
          class="mre-step-pill ${badge.cls} ${active ? "is-active" : ""}"
          data-mre-step="${esc(r.id)}"
          aria-selected="${active ? "true" : "false"}"
          title="${esc(r.title)}"
        >
          <span>${esc(code)}</span>
        </button>`;
    })
    .join("");

  const addStepPillHtml = canAppendRound
    ? `<button
        type="button"
        class="mre-step-pill is-add-pill ${ui.activePageId === "__add__" ? "is-active" : ""}"
        data-mre-step="__add__"
        aria-label="Add round"
        title="Add round"
      >${icons.plus(13)}</button>`
    : "";

  const pagesHtml = rounds
    .map((round) =>
      renderSingleRoundPage(
        race,
        round,
        rounds,
        roundById,
        realConnections,
        pilotsConnsByTarget.get(round.id),
        activePilots,
        canEditStructure,
        ui.activePageId === round.id
      )
    )
    .join("");

  const lastConnectableRound = [...rounds]
    .reverse()
    .find((r) => r.bracketLane !== "finals");

  const addPageHtml = canAppendRound
    ? `<section class="mre-page is-add-page ${ui.activePageId === "__add__" ? "is-active-page" : ""}" data-mre-round-page="__add__" aria-label="Add Round">
        <div class="mre-page-scroll" data-preserve-scroll="mre-page:__add__">
          <div class="card mre-add-page-card">
            <header class="mre-add-page-head">
              <strong>Add Round to Race</strong>
              <p class="note">Swipe left or right between rounds at any time.</p>
            </header>
            ${
              lastConnectableRound
                ? `<label class="mre-connect-prev-toggle">
                    <input
                      type="checkbox"
                      data-mre-toggle-connect-prev
                      ${ui.connectToPreviousOnAdd ? "checked" : ""}
                    />
                    <span>Auto-connect after <strong>${esc(formatMobileRoundDisplayTitle(lastConnectableRound))}</strong></span>
                  </label>`
                : ""
            }
            ${renderConstructPickerCards("data-mre-add-round")}
          </div>
        </div>
      </section>`
    : "";

  const cueLabel = ui.isStripStuck
    ? "Show race info and menu"
    : "Scroll round switcher to top";

  return `
    <div class="mre-shell" data-mre-root>
      ${raceHeaderHtml}
      <div class="mre-strip-anchor" data-mre-strip-anchor aria-hidden="true"></div>
      <div class="mre-top-strip ${ui.isStripStuck ? "is-stuck" : ""}">
        <button
          type="button"
          class="mre-collapse-cue"
          data-mre-collapse-cue
          aria-label="${cueLabel}"
          title="${cueLabel}"
        >${icons.chevronsUp(16)}</button>
        <div class="mre-stepper-row" data-mre-stepper>
          <div class="sched-lineup-wrap mre-stepper-scroll-wrap">
            <button
              type="button"
              class="sched-lineup-cue is-left"
              data-lineup-scroll="-1"
              aria-label="Scroll rounds left"
              title="Scroll rounds left"
              hidden
            >${icons.chevronLeft(13)}</button>
            <div
              class="mre-stepper-pills sched-lineup"
              role="tablist"
              aria-label="Race rounds"
              data-fit-lineup
              data-native-touch-scroll
            >
              ${stepperPillsHtml}
            </div>
            <button
              type="button"
              class="sched-lineup-cue is-right"
              data-lineup-scroll="1"
              aria-label="Scroll rounds right"
              title="Scroll rounds right"
              hidden
            >${icons.chevronRight(13)}</button>
          </div>
          ${addStepPillHtml ? `<div class="mre-stepper-add-slot">${addStepPillHtml}</div>` : ""}
        </div>
      </div>
      <div class="mre-carousel" data-mre-carousel>
        ${pagesHtml}
        ${addPageHtml}
      </div>
    </div>`;
}

function renderSingleRoundPage(
  race: RaceTournamentState,
  round: RaceRound,
  allRounds: RaceRound[],
  roundById: Map<string, RaceRound>,
  realConnections: RoundConnection[],
  pilotsConn: RoundConnection | undefined,
  activePilots: EventPilot[],
  canEditStructure: boolean,
  isActivePage: boolean
): string {
  const roundHeats = (race.heats ?? [])
    .filter((h) => h.roundId === round.id)
    .sort((a, b) => a.order - b.order);
  const anyStartedInRound = roundHeats.some((h) => !isHeatUnstarted(h.state));
  const laneBadge = formatLaneBadge(round);
  const timingSub = formatRoundTimingSubtitle(round, race);

  const inConns = realConnections.filter((c) => c.toRoundId === round.id);
  const outConns = realConnections.filter((c) => c.fromRoundId === round.id);

  // Determine Early Seeding eligibility on outgoing `standings_top` connections
  const isQualRound =
    round.stageFormat === "qualifying" ||
    round.stageFormat === "open_qualifier" ||
    round.bracketLane === "qualifying" ||
    round.bracketLane === "open_qual";
  const confirmedQualHeatsCount = isQualRound
    ? (race.heats ?? []).filter(
        (h) =>
          (h.roundId === round.id ||
            h.stageFormat === "qualifying" ||
            h.stageFormat === "open_qualifier") &&
          h.state === "confirmed"
      ).length
    : 0;

  let inBodyHtml = "";
  if (inConns.length > 0) {
    inBodyHtml = inConns
      .map((c) => {
        const src = roundById.get(c.fromRoundId);
        const srcTitle = src ? formatMobileRoundDisplayTitle(src) : c.fromRoundId;
        const ruleSummary = formatMobileConnectionSummary(c);
        const invalidText =
          c.invalid && c.invalidReason
            ? cleanConnectionInvalidReason(c.invalidReason) || c.invalidReason
            : "";
        return `
          <div class="mre-io-item-group">
            <div class="mre-io-item ${c.invalid ? "is-invalid" : ""}">
              ${
                src
                  ? `<button type="button" class="mre-io-jump-btn mre-io-lead-jump" data-mre-jump-round="${esc(src.id)}" title="Go to ${esc(srcTitle)}" aria-label="Go to ${esc(srcTitle)}">
                      ${icons.chevronLeft(14)}
                    </button>`
                  : ""
              }
              <button
                type="button"
                class="mre-io-main-btn"
                data-mre-edit-conn="${esc(c.id)}"
                ${!canEditStructure ? "disabled" : ""}
              >
                <span class="mre-io-target"><strong>${esc(srcTitle)}</strong></span>
                <span class="mre-io-rule-pill mono">${esc(ruleSummary)}</span>
              </button>
              <div class="mre-io-side-btns">
                ${
                  src
                    ? `<button type="button" class="mre-io-jump-btn" data-mre-jump-round="${esc(src.id)}" title="Go to ${esc(srcTitle)}" aria-label="Go to ${esc(srcTitle)}">
                        ${icons.chevronLeft(14)}
                      </button>`
                    : ""
                }
                ${
                  canEditStructure && !anyStartedInRound
                    ? `<button type="button" class="mre-io-del-btn" data-mre-disconnect="${esc(c.id)}" title="Disconnect ${esc(srcTitle)}" aria-label="Disconnect">
                        ${icons.close(13)}
                      </button>`
                    : ""
                }
              </div>
            </div>
            ${
              invalidText
                ? `<div class="mre-io-invalid-note" role="status">${esc(invalidText)}</div>`
                : ""
            }
          </div>`;
      })
      .join("");
  } else {
    const seedModeLabel = formatInitialSeedModeLabel(round, pilotsConn);
    const isRandomSeeded =
      (pilotsConn?.distribution || round.seedDistribution) === "random" &&
      (Boolean(pilotsConn) || round.seedSource === "all_active_pilots");
    inBodyHtml = `
      <div class="mre-io-item is-root-seed">
        <button type="button" class="mre-io-jump-btn mre-io-lead-jump" data-mre-open-pilots title="Manage checked-in pilots" aria-label="Manage checked-in pilots">
          ${icons.chevronLeft(14)}
        </button>
        <button
          type="button"
          class="mre-io-main-btn"
          data-mre-open-seeding="${esc(round.id)}"
          ${!canEditStructure ? "disabled" : ""}
        >
          <span class="mre-io-target">${icons.pilot(13)} <strong>Pilots (${activePilots.length})</strong></span>
          <span class="mre-io-rule-pill">${esc(seedModeLabel)}</span>
        </button>
        <div class="mre-io-side-btns">
          ${
            isRandomSeeded && canEditStructure && !anyStartedInRound
              ? `<button type="button" class="btn btn-ghost btn-xs mre-reshuffle-btn" data-mre-reshuffle="${esc(round.id)}" title="Re-draw random heats">
                  <span>Reshuffle</span>
                </button>`
              : ""
          }
          <button type="button" class="mre-io-jump-btn" data-mre-open-pilots title="Manage checked-in pilots" aria-label="Manage checked-in pilots">
            ${icons.chevronLeft(14)}
          </button>
        </div>
      </div>`;
  }

  const showOutSection = round.bracketLane !== "finals" || outConns.length > 0;
  let outBodyHtml = "";
  if (showOutSection) {
    const outRowsHtml = outConns
      .map((c) => {
        const dst = roundById.get(c.toRoundId);
        const dstTitle = dst ? formatMobileRoundDisplayTitle(dst) : c.toRoundId;
        const dstHeats = (race.heats ?? []).filter((h) => h.roundId === c.toRoundId);
        const dstStarted = dstHeats.some((h) => !isHeatUnstarted(h.state));
        const ruleSummary = formatMobileConnectionSummary(c);
        const canSeedNow =
          canEditStructure &&
          isQualRound &&
          c.mode === "standings_top" &&
          confirmedQualHeatsCount >= 1 &&
          !c.seededEarly &&
          !dstStarted;
        const canReopenSeed =
          canEditStructure &&
          c.mode === "standings_top" &&
          Boolean(c.seededEarly) &&
          !dstStarted;

        return `
          <div class="mre-io-item-group">
            <div class="mre-io-item ${c.invalid ? "is-invalid" : ""}">
              ${
                dst
                  ? `<button type="button" class="mre-io-jump-btn mre-io-lead-jump" data-mre-jump-round="${esc(dst.id)}" title="Go to ${esc(dstTitle)}" aria-label="Go to ${esc(dstTitle)}">
                      ${icons.chevronRight(14)}
                    </button>`
                  : ""
              }
              <button
                type="button"
                class="mre-io-main-btn"
                data-mre-edit-conn="${esc(c.id)}"
                ${!canEditStructure ? "disabled" : ""}
              >
                <span class="mre-io-target"><strong>${esc(dstTitle)}</strong></span>
                <span class="mre-io-rule-pill mono">${esc(ruleSummary)}${c.seededEarly ? " · Seeded" : ""}</span>
              </button>
              <div class="mre-io-side-btns">
                ${
                  dst
                    ? `<button type="button" class="mre-io-jump-btn" data-mre-jump-round="${esc(dst.id)}" title="Go to ${esc(dstTitle)}" aria-label="Go to ${esc(dstTitle)}">
                        ${icons.chevronRight(14)}
                      </button>`
                    : ""
                }
                ${
                  canEditStructure && !dstStarted
                    ? `<button type="button" class="mre-io-del-btn" data-mre-disconnect="${esc(c.id)}" title="Disconnect ${esc(dstTitle)}" aria-label="Disconnect">
                        ${icons.close(13)}
                      </button>`
                    : ""
                }
              </div>
            </div>
            ${
              c.invalid && c.invalidReason
                ? `<div class="mre-io-invalid-note" role="status">${esc(cleanConnectionInvalidReason(c.invalidReason) || c.invalidReason)}</div>`
                : ""
            }
            ${
              canSeedNow
                ? `<div class="mre-seed-now-bar">
                    <span class="note">${confirmedQualHeatsCount} qual heat${confirmedQualHeatsCount === 1 ? "" : "s"} confirmed</span>
                    <button type="button" class="btn btn-armed btn-xs" data-mre-seed-now="${esc(c.id)}">
                      ${icons.zap(12)}<span>Seed ${esc(dstTitle)} Now</span>
                    </button>
                  </div>`
                : canReopenSeed
                  ? `<div class="mre-seed-now-bar is-seeded">
                      <span class="note">Seeded early into ${esc(dstTitle)}</span>
                      <button type="button" class="btn btn-ghost btn-xs" data-mre-reopen-seed="${esc(c.id)}">
                        ${icons.unlock(12)}<span>Reopen</span>
                      </button>
                    </div>`
                  : ""
            }
          </div>`;
      })
      .join("");

    const connectBtnHtml =
      canEditStructure && round.bracketLane !== "finals"
        ? `<button type="button" class="btn btn-ghost btn-xs mre-connect-next-btn" data-mre-connect-out="${esc(round.id)}">
            ${icons.plus(15)}<span>${outConns.length > 0 ? "Add Output" : "Connect Next Round"}</span>
          </button>`
        : outConns.length === 0
          ? `<div class="mre-io-terminal note">Terminal round (crowns winner / final standings)</div>`
          : "";

    outBodyHtml = `
      <div class="mre-io-section">
        <span class="mre-io-label">OUT</span>
        <div class="mre-io-rows">
          ${outRowsHtml}
          ${connectBtnHtml}
        </div>
      </div>`;
  }

  // Map which heat each pilot is seated in within this round for clear swap/assign context
  const seatedHeatBySlot = new Map<number, string>();
  for (const h of roundHeats) {
    for (const s of h.seats) {
      if (s.pilotSlotIndex > 0 && !seatedHeatBySlot.has(s.pilotSlotIndex)) {
        seatedHeatBySlot.set(s.pilotSlotIndex, h.shortLabel);
      }
    }
  }

  const heatsCardsHtml =
    round.stageFormat === "open_qualifier" && roundHeats.length === 0
      ? `<div class="card mre-oq-empty-card">
          <div class="mre-oq-empty-body">
            ${icons.zap(18)}
            <div>
              <strong>Dynamic Flight Queue</strong>
              <p class="note">Packs are queued on demand from the <strong>Queue</strong> tab as pilots walk up to fly.</p>
            </div>
          </div>
          <button type="button" class="btn btn-armed btn-sm" data-mre-open-queue>
            ${icons.zap(13)}<span>Open Queue Tab</span>
          </button>
        </div>`
      : roundHeats
          .map((heat) =>
            renderMobileHeatCard(
              race,
              heat,
              round,
              roundHeats.length,
              activePilots,
              seatedHeatBySlot,
              canEditStructure
            )
          )
          .join("");

  const displayTitle = formatMobileRoundDisplayTitle(round);
  const addHeatCheck = getRoundAddHeatRestriction(
    race,
    round,
    roundHeats,
    realConnections,
    pilotsConn,
    activePilots
  );

  const heatsFooterHtml =
    round.stageFormat === "open_qualifier"
      ? `<div class="mre-heats-footer">
          <button type="button" class="btn btn-ghost btn-sm mre-full-btn" data-mre-open-queue>
            ${icons.zap(14)}<span>Manage Flight Queue</span>
          </button>
        </div>`
      : canEditStructure && round.bracketLane !== "finals"
        ? `<div class="mre-heats-footer" ${!addHeatCheck.canAdd ? `title="${esc(addHeatCheck.reason)}"` : ""}>
            <button
              type="button"
              class="btn btn-ghost btn-sm mre-full-btn"
              data-mre-add-heat="${esc(round.id)}"
              ${!addHeatCheck.canAdd ? "disabled" : ""}
              title="${esc(addHeatCheck.canAdd ? `Add a heat to ${displayTitle}` : addHeatCheck.reason)}"
            >
              ${icons.plus(14)}<span>Add Heat to ${esc(displayTitle)}</span>
            </button>
          </div>`
        : "";

  const roundPosLabel = `${allRounds.findIndex((r) => r.id === round.id) + 1}/${allRounds.length}`;

  return `
    <section
      class="mre-page ${isActivePage ? "is-active-page" : ""}"
      data-mre-round-page="${esc(round.id)}"
      aria-label="${esc(displayTitle)}"
    >
      <div class="mre-page-scroll" data-preserve-scroll="mre-page:${esc(round.id)}">
        <header class="card mre-round-header">
          <div class="mre-round-header-top">
            <div class="mre-round-title-group">
              <h3 class="mre-round-title">${esc(displayTitle)}</h3>
              <span class="mre-lane-pill ${laneBadge.cls}">${esc(laneBadge.label)}</span>
              <span class="note mono mre-round-pos">${esc(roundPosLabel)}</span>
            </div>
            <div class="mre-round-header-btns">
              ${
                canEditStructure
                  ? `<button
                      type="button"
                      class="btn btn-ghost btn-xs mre-icon-btn"
                      data-mre-round-settings="${esc(round.id)}"
                      title="Round settings"
                      aria-label="Round settings"
                    >${icons.settings(15)}</button>`
                  : ""
              }
              ${
                canEditStructure && !anyStartedInRound
                  ? `<button
                      type="button"
                      class="btn btn-ghost btn-xs mre-icon-btn mre-danger-icon"
                      data-mre-delete-round="${esc(round.id)}"
                      title="Delete ${esc(displayTitle)}"
                      aria-label="Delete ${esc(displayTitle)}"
                    >${icons.trash(15)}</button>`
                  : ""
              }
            </div>
          </div>
          <div class="mre-round-subtitle note">${esc(timingSub)}</div>
        </header>

        <section class="card mre-io-card" aria-label="Round connections">
          <div class="mre-io-section">
            <span class="mre-io-label">IN</span>
            <div class="mre-io-rows">${inBodyHtml}</div>
          </div>
          ${outBodyHtml}
        </section>

        <div class="mre-heats-section">
          <div class="mre-heats-heading">
            <span>Heats (${roundHeats.length})</span>
            ${
              anyStartedInRound
                ? `<span class="note">${roundHeats.filter((h) => h.state === "confirmed").length}/${roundHeats.length} confirmed</span>`
                : ""
            }
          </div>
          <div class="mre-heats-list">
            ${heatsCardsHtml}
          </div>
          ${heatsFooterHtml}
        </div>
      </div>
    </section>`;
}

function renderMobileHeatCard(
  race: RaceTournamentState,
  heat: RaceHeat,
  round: RaceRound,
  roundHeatCount: number,
  activePilots: EventPilot[],
  seatedHeatBySlot: Map<number, string>,
  canEditStructure: boolean
): string {
  const badge = heatStateBadge(heat.state, heat.inOvertime, heat.note);
  const editableHeat = canEditStructure && isHeatUnstarted(heat.state);

  if (!editableHeat) {
    const sortedSeats = [...heat.seats].sort((a, b) => {
      const aR = a.position > 0;
      const bR = b.position > 0;
      if (aR && bR && a.position !== b.position) return a.position - b.position;
      if (aR !== bR) return aR ? -1 : 1;
      return a.seatIndex - b.seatIndex;
    });
    const canReview = heat.state === "confirmed" || heat.state === "finished";
    return `
      <article class="card mre-heat-card is-locked-heat">
        <header class="mre-heat-head">
          <div class="mre-heat-head-left">
            <strong class="mono">${esc(heat.shortLabel)}</strong>
            <span class="race-state-pill ${badge.cls}">${esc(badge.label)}</span>
          </div>
          <div class="mre-heat-head-right">
            <span class="mre-lock-tag note" title="Heat has started or finished">${icons.lock(12)}</span>
            ${
              canReview
                ? `<button type="button" class="btn btn-ghost btn-xs" data-mre-review-heat="${esc(heat.id)}">
                    <span>Review</span>${icons.chevronRight(12)}
                  </button>`
                : ""
            }
          </div>
        </header>
        <div class="mre-locked-seats">
          ${sortedSeats
            .map((s) => {
              const chLbl = formatBandChannelShort(s.band, s.channel) || `R${s.channel}`;
              const prevShort = s.prevChannel ? formatEncodedChannelShort(s.prevChannel) || "?" : "?";
              const lockedSwapHtml =
                s.pilotSlotIndex > 0 && s.channelChanged
                  ? `<span class="bkt-ch-delta" title="Channel changed from ${esc(prevShort)} to ${esc(chLbl)}">${icons.channelSwap(13)}</span>`
                  : "";
              const posTxt = s.position > 0 ? `#${s.position}` : "-";
              const metricTxt =
                s.pilotSlotIndex <= 0
                  ? s.feeder?.isBye
                    ? "BYE"
                    : "Empty"
                  : s.status === "dns"
                    ? "DNS"
                    : s.status === "dnf"
                      ? "DNF"
                      : s.status === "dq"
                        ? "DQ"
                        : s.lapsCompleted > 0
                          ? `${s.lapsCompleted}L · ${s.totalTimeSec.toFixed(2)}s`
                          : "0L";
              return `
                <div class="mre-locked-seat-row ${s.pilotSlotIndex <= 0 ? "is-empty" : ""}">
                  <span class="mre-locked-pos mono ${s.position === 1 ? "is-win" : ""}">${esc(posTxt)}</span>
                  <span class="mre-locked-ch badge mono">${esc(chLbl)}</span>
                  <span class="mre-locked-pilot">
                    ${
                      s.pilotSlotIndex > 0
                        ? `<span class="dot" style="--c:${adaptColorForTheme(s.color)}"></span><strong>${esc(s.callsign)}</strong>${lockedSwapHtml}${s.advances && heat.state === "confirmed" ? `<span class="mre-adv-mark">&#10003;</span>` : ""}`
                        : `${!s.feeder?.isBye && s.sourceLabel && s.sourceLabel !== "Open" && s.sourceLabel !== "Open / BYE" && s.sourceLabel !== "BYE" ? `<span class="dot is-hollow"></span>` : ""}<span class="note">${esc(s.sourceLabel || "Open")}</span>`
                    }
                  </span>
                  <span class="mre-locked-metric mono note">${esc(metricTxt)}</span>
                </div>`;
            })
            .join("")}
        </div>
      </article>`;
  }

  const canDeleteHeat =
    round.stageFormat === "open_qualifier" ||
    (round.bracketLane !== "finals" && roundHeatCount > 1);

  const qualStandings = race.qualStandings ?? [];

  const seatRowsHtml = heat.seats
    .map((s) => {
      const chOptions = renderMultiBandSelectOptionsHtml({
        selectedBand: s.band,
        selectedChannel: s.channel,
        compact: true,
      });

      const filled = s.pilotSlotIndex > 0;
      const isBye = !!s.feeder?.isBye && !filled;
      const rawSeedNum =
        (s.feeder?.fromStageSeed ?? 0) ||
        (s.feeder?.fromStandingsRank ?? 0) ||
        (!filled && !s.feeder && /^Seed #(\d+)$/.exec(s.sourceLabel || "")
          ? Number(/^Seed #(\d+)$/.exec(s.sourceLabel || "")?.[1] || 0)
          : 0);
      const isSeedPlaceholder = !filled && !isBye && rawSeedNum > 0;
      const isHeatPlaceholder =
        !filled &&
        !isBye &&
        !isSeedPlaceholder &&
        (!!s.feeder?.fromHeatId ||
          Boolean(s.sourceLabel && s.sourceLabel !== "Open / BYE" && s.sourceLabel !== "BYE"));

      let emptyLabel = "Open / BYE";
      let emptyDot = "";
      let emptySub = "";
      if (s.feeder) {
        if (filled && s.manualLock) {
          emptyLabel = `Restore (${s.sourceLabel || "Feeder"})`;
        } else if (isBye) {
          emptyLabel = "BYE";
        } else {
          emptyLabel = s.sourceLabel || "TBD";
          if (isSeedPlaceholder) {
            emptyDot = "hollow";
            const prov = qualStandings[rawSeedNum - 1];
            if (prov && prov.heatsFlown > 0 && (!s.feeder.fromRoundId || round.stageFormat !== "qualifying")) {
              emptySub = `~ ${prov.callsign}`;
            }
          } else if (isHeatPlaceholder) {
            emptyDot = "hollow";
          }
        }
      } else if (!filled && s.sourceLabel && s.sourceLabel !== "Open / BYE") {
        emptyLabel = s.sourceLabel;
        if (isSeedPlaceholder || isHeatPlaceholder) {
          emptyDot = "hollow";
        }
      }

      const pilotMap = new Map<number, { callsign: string; color: string }>();
      for (const p of activePilots) {
        pilotMap.set(p.slotIndex, { callsign: p.callsign, color: p.color });
      }
      if (filled && !pilotMap.has(s.pilotSlotIndex)) {
        pilotMap.set(s.pilotSlotIndex, {
          callsign: s.callsign || `Pilot #${s.pilotSlotIndex}`,
          color: s.color || "",
        });
      }

      const occupiedProv =
        filled && s.sourceLabel && s.sourceLabel !== "Open / BYE" ? s.sourceLabel : "";
      const seatShortCh = formatBandChannelShort(s.band, s.channel) || `R${s.channel}`;
      const prevShortCh = s.prevChannel ? formatEncodedChannelShort(s.prevChannel) || "?" : "?";
      const swapTitleText = `Channel changed from ${prevShortCh} to ${seatShortCh}`;

      const pilotOptsHtml = Array.from(pilotMap.entries())
        .map(([slotIdx, info]) => {
          const isCur = s.pilotSlotIndex === slotIdx;
          const otherHeat = seatedHeatBySlot.get(slotIdx);
          const suffix =
            !isCur && otherHeat && otherHeat !== heat.shortLabel ? ` (${otherHeat})` : "";
          const dotAttr = info.color ? ` data-dot="${esc(adaptColorForTheme(info.color))}"` : "";
          const subAttr = isCur && occupiedProv ? ` data-sub="${esc(occupiedProv)}"` : "";
          const swapAttr =
            isCur && s.channelChanged
              ? ` data-swap="1" data-swap-title="${esc(swapTitleText)}"`
              : "";
          return `<option value="${slotIdx}"${dotAttr}${subAttr}${swapAttr} ${isCur ? "selected" : ""}>${esc(info.callsign + suffix)}</option>`;
        })
        .join("");

      const placeholderCls = isSeedPlaceholder
        ? "is-seed-placeholder"
        : isHeatPlaceholder
          ? "is-heat-placeholder"
          : !filled
            ? "is-bye-placeholder"
            : "";

      const emptyDotAttr = emptyDot ? ` data-dot="${esc(emptyDot)}"` : "";
      const emptySubAttr = emptySub ? ` data-sub="${esc(emptySub)}"` : "";

      return `
        <div class="mre-seat-row ${filled ? "is-occupied" : "is-placeholder"}">
          <select
            class="input input-sm mono mre-seat-ch-select"
            data-mre-seat-ch
            data-live-safe="1"
            data-heat-id="${esc(heat.id)}"
            data-seat-idx="${s.seatIndex}"
            aria-label="Seat ${s.seatIndex} VTX channel"
          >${chOptions}</select>
          <select
            class="input input-sm mre-seat-pilot-select ${placeholderCls}"
            data-mre-seat-pilot
            data-live-safe="1"
            data-heat-id="${esc(heat.id)}"
            data-seat-idx="${s.seatIndex}"
            aria-label="Seat ${s.seatIndex} pilot"
          >
            <option value="0"${emptyDotAttr}${emptySubAttr} ${!filled ? "selected" : ""}>${esc(emptyLabel)}</option>
            ${pilotOptsHtml}
          </select>
          ${
            s.manualLock
              ? `<button
                  type="button"
                  class="btn btn-ghost btn-xs mre-seat-unlock-btn"
                  data-mre-unlock-seat
                  data-heat-id="${esc(heat.id)}"
                  data-seat-idx="${s.seatIndex}"
                  title="Unlock manual assignment"
                  aria-label="Unlock seat"
                >${icons.unlock(12)}</button>`
              : ""
          }
        </div>`;
    })
    .join("");

  return `
    <article class="card mre-heat-card">
      <header class="mre-heat-head">
        <div class="mre-heat-head-left">
          <strong class="mono">${esc(heat.shortLabel)}</strong>
          <span class="race-state-pill ${badge.cls}">${esc(badge.label)}</span>
        </div>
        <div class="mre-heat-head-right">
          ${
            canDeleteHeat
              ? `<button
                  type="button"
                  class="btn btn-ghost btn-xs mre-icon-btn"
                  data-mre-delete-heat="${esc(heat.id)}"
                  title="Delete ${esc(heat.shortLabel)}"
                  aria-label="Delete ${esc(heat.shortLabel)}"
                >${icons.close(14)}</button>`
              : ""
          }
        </div>
      </header>
      <div class="mre-seat-list">
        ${seatRowsHtml}
      </div>
    </article>`;
}

/* ============================================================================
 * Mobile Bottom-Sheet Modals (Initial Seeding, Connect Next Round, Early Seed)
 * ========================================================================== */

let activeMobileSheetClose: ((immediate?: boolean) => void) | null = null;

export function closeActiveMobileEditorSheet(): void {
  activeMobileSheetClose?.(true);
}

function openMobileBottomSheet(
  title: string,
  bodyHtml: string,
  footHtml: string
): { backdrop: HTMLElement; close: (immediate?: boolean) => void } {
  activeMobileSheetClose?.(true);

  const backdrop = document.createElement("div");
  backdrop.className = "pilot-dir-mobile-drawer-overlay mre-sheet-overlay";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", title);

  backdrop.innerHTML = `
    <div class="pilot-dir-mobile-drawer-backdrop" data-mre-sheet-close></div>
    <div class="pilot-dir-mobile-editor is-entering mre-bottom-sheet" role="document">
      <div class="mre-sheet-head" data-mre-sheet-drag-handle>
        <div class="mre-sheet-grip-row">
          <span class="pilot-dir-mobile-drawer-grip" aria-hidden="true"></span>
        </div>
        <div class="mre-sheet-title-row">
          <strong>${esc(title)}</strong>
          <button type="button" class="btn btn-ghost btn-xs" data-mre-sheet-close aria-label="Close">
            ${icons.close(15)}
          </button>
        </div>
      </div>
      <div class="mre-sheet-body">${bodyHtml}</div>
      ${footHtml ? `<div class="mre-sheet-foot">${footHtml}</div>` : ""}
    </div>`;

  let closing = false;
  const sheetEl = backdrop.querySelector<HTMLElement>(".mre-bottom-sheet");

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      if (isCustomSelectOpenWithin(backdrop)) {
        e.preventDefault();
        e.stopPropagation();
        closeCustomSelect();
        return;
      }
      e.preventDefault();
      close(false);
    }
  };

  const close = (immediate = false): void => {
    if (closing) {
      if (immediate && backdrop.parentNode) {
        backdrop.remove();
      }
      return;
    }
    closing = true;
    closeCustomSelect();
    window.removeEventListener("keydown", onKey, true);
    if (activeMobileSheetClose === close) {
      activeMobileSheetClose = null;
    }

    if (immediate || !backdrop.parentNode) {
      backdrop.remove();
      return;
    }

    backdrop.removeAttribute("role");
    backdrop.removeAttribute("aria-modal");
    backdrop.setAttribute("aria-hidden", "true");
    sheetEl?.classList.remove("is-entering");
    backdrop.classList.add("is-closing");
    window.setTimeout(() => {
      backdrop.remove();
    }, 305);
  };
  activeMobileSheetClose = close;

  window.addEventListener("keydown", onKey, true);
  backdrop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (t.hasAttribute("data-mre-sheet-close") || t.closest("[data-mre-sheet-close]")) {
      close(false);
    }
  });

  // Allow swiping down on the sheet header/grip to smoothly dismiss
  const dragHandle = backdrop.querySelector<HTMLElement>("[data-mre-sheet-drag-handle]");
  if (dragHandle && sheetEl) {
    let dragStartY: number | null = null;
    dragHandle.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length === 1) {
          dragStartY = e.touches[0].clientY;
        }
      },
      { passive: true }
    );
    dragHandle.addEventListener(
      "touchend",
      (e) => {
        if (dragStartY !== null && e.changedTouches.length > 0) {
          const dy = e.changedTouches[0].clientY - dragStartY;
          dragStartY = null;
          if (dy > 36) {
            close(false);
          }
        }
      },
      { passive: true }
    );
  }

  document.body.appendChild(backdrop);
  scanCustomSelects(backdrop);
  return { backdrop, close };
}

function openMobileRoundSettingsSheet(
  round: RaceRound,
  cb: MobileRaceEditorCallbacks
): void {
  const race = cb.getRace();
  const cfg = race.config;
  const heats = (race.heats ?? []).filter((h) => h.roundId === round.id);
  const startedCount = heats.filter((h) => !isHeatUnstarted(h.state)).length;
  const anyStarted = startedCount > 0;

  let curLane =
    round.bracketLane === "main" || round.bracketLane === "mains"
      ? "winners"
      : round.bracketLane === "open_qual"
        ? "qualifying"
        : round.bracketLane || "winners";
  let curStart: StartMode =
    round.startMode ??
    (round.stageFormat === "qualifying" || round.stageFormat === "open_qualifier"
      ? "staggered"
      : "heads_up");
  let curFormat: StageFormat =
    round.stageFormat === "open_qualifier"
      ? "open_qualifier"
      : round.stageFormat === "qualifying"
        ? "qualifying"
        : round.stageFormat === "points_mains"
          ? "points_mains"
          : "single_elimination";
  let curQualMetric: QualifyingMetric =
    round.qualifyingMetric || cfg?.qualifyingMetric || "consecutive_3";
  const curMaxPacks = Math.max(
    0,
    round.maxPacksPerPilot !== undefined ? round.maxPacksPerPilot : (cfg?.maxPacksPerPilot ?? 0)
  );
  const curHeatCount = Math.max(1, heats.length || round.targetHeats || 1);

  let curFinalsFormat: FinalsFormat =
    round.finalsFormat ||
    (cfg?.finalsFormat === "chase_the_ace" || cfg?.finalsFormat === "points_final"
      ? cfg.finalsFormat
      : "single_final");
  const curAceWins = Math.max(2, Math.min(5, round.aceWinsRequired || cfg?.aceWinsRequired || 2));
  const curWinnersAdv =
    round.winnersAdvantageAce !== undefined
      ? round.winnersAdvantageAce
      : cfg?.winnersAdvantageAce ?? true;
  const curFinalsHeats = Math.max(
    2,
    Math.min(
      7,
      round.finalsHeats || (curFinalsFormat === "points_final" && heats.length >= 2 ? heats.length : 3)
    )
  );

  const isInitFinals = curLane === "finals";
  const isInitQual = !isInitFinals && (curFormat === "qualifying" || curFormat === "open_qualifier");
  const isInitOpenQual = !isInitFinals && curFormat === "open_qualifier";
  const initialDisplayTitle = formatMobileRoundDisplayTitle(round);

  const bodyHtml = `
    <div class="mre-compact-fields">
      <label class="field mre-compact-field">
        <span>Round Name</span>
        <input
          type="text"
          class="input"
          data-sheet-round-title
          value="${esc(initialDisplayTitle)}"
          maxlength="48"
          placeholder="e.g. R1, W1, LCQ..."
        />
      </label>

      <div class="mre-compact-grid-2">
        <label class="field mre-compact-field">
          <span>Round Role</span>
          <select class="input" data-sheet-round-lane ${anyStarted ? "disabled" : ""}>
            <option value="winners" ${curLane === "winners" ? "selected" : ""}>Race / Upper</option>
            <option value="losers" ${curLane === "losers" ? "selected" : ""}>Redemption</option>
            <option value="qualifying" ${curLane === "qualifying" ? "selected" : ""}>Qualifying</option>
            <option value="finals" ${curLane === "finals" ? "selected" : ""}>Finals</option>
          </select>
        </label>

        <label class="field mre-compact-field" data-sheet-format-cell ${isInitFinals ? "hidden" : ""}>
          <span>Scoring Format</span>
          <select class="input" data-sheet-round-format ${anyStarted ? "disabled" : ""}>
            <option value="single_elimination" ${curFormat === "single_elimination" ? "selected" : ""}>Head-to-Head</option>
            <option value="qualifying" ${curFormat === "qualifying" ? "selected" : ""}>Timed Qualifying</option>
            <option value="open_qualifier" ${curFormat === "open_qualifier" ? "selected" : ""}>Open Qualifier</option>
            <option value="points_mains" ${curFormat === "points_mains" ? "selected" : ""}>Points Round</option>
          </select>
        </label>

        <label class="field mre-compact-field" data-sheet-finals-fmt-cell ${isInitFinals ? "" : "hidden"}>
          <span>Finals Format</span>
          <select class="input" data-sheet-finals-fmt ${anyStarted ? "disabled" : ""}>
            <option value="single_final" ${curFinalsFormat === "single_final" ? "selected" : ""}>Single Final</option>
            <option value="chase_the_ace" ${curFinalsFormat === "chase_the_ace" ? "selected" : ""}>Chase the Ace</option>
            <option value="points_final" ${curFinalsFormat === "points_final" ? "selected" : ""}>Points Series</option>
          </select>
        </label>
      </div>

      <div class="mre-compact-grid-2" data-sheet-start-row>
        <label class="field mre-compact-field">
          <span>Start Signal</span>
          <select class="input" data-sheet-round-start ${anyStarted ? "disabled" : ""}>
            <option value="heads_up" ${curStart === "heads_up" ? "selected" : ""}>Heads-Up Horn</option>
            <option value="staggered" ${curStart === "staggered" ? "selected" : ""}>Staggered Gate</option>
          </select>
        </label>

        <label class="field mre-compact-field" data-sheet-qual-metric-cell ${isInitQual ? "" : "hidden"}>
          <span>Ranked By</span>
          <select class="input" data-sheet-qual-metric ${anyStarted ? "disabled" : ""}>
            <option value="consecutive_3" ${curQualMetric === "consecutive_3" ? "selected" : ""}>Top 3 Consecutive</option>
            <option value="consecutive_2" ${curQualMetric === "consecutive_2" ? "selected" : ""}>Top 2 Consecutive</option>
            <option value="best_lap" ${curQualMetric === "best_lap" ? "selected" : ""}>Fastest Lap</option>
            <option value="laps_in_time" ${curQualMetric === "laps_in_time" ? "selected" : ""}>Most Laps in Time</option>
            <option value="points" ${curQualMetric === "points" ? "selected" : ""}>Heat Points</option>
          </select>
        </label>

        <label class="field mre-compact-field" data-sheet-ace-wins-cell ${isInitFinals && curFinalsFormat === "chase_the_ace" ? "" : "hidden"}>
          <span>Ace Wins (2-5)</span>
          <input
            type="number"
            class="input mono"
            data-sheet-ace-wins
            min="2"
            max="5"
            value="${curAceWins}"
            ${anyStarted ? "disabled" : ""}
          />
        </label>

        <label class="field mre-compact-field" data-sheet-series-heats-cell ${isInitFinals && curFinalsFormat === "points_final" ? "" : "hidden"}>
          <span>Series Heats (2-7)</span>
          <input
            type="number"
            class="input mono"
            data-sheet-finals-heats
            min="2"
            max="7"
            value="${curFinalsHeats}"
            ${anyStarted ? "disabled" : ""}
          />
        </label>

        <label class="field mre-compact-field" data-sheet-std-heats-top-cell ${!isInitFinals && !isInitQual ? "" : "hidden"}>
          <span>Heats</span>
          <input
            type="number"
            class="input mono"
            data-sheet-heat-count-std
            min="${Math.max(1, startedCount)}"
            max="16"
            value="${curHeatCount}"
          />
        </label>
      </div>

      <div class="mre-compact-timing-grid" data-sheet-timing-grid>
        <label class="field mre-compact-field" data-sheet-qual-heats-cell ${!isInitFinals && curFormat === "qualifying" ? "" : "hidden"}>
          <span>Heats</span>
          <input
            type="number"
            class="input mono"
            data-sheet-heat-count-qual
            min="${Math.max(1, startedCount)}"
            max="16"
            value="${curHeatCount}"
          />
        </label>

        <label class="field mre-compact-field" data-sheet-max-packs-cell ${isInitOpenQual ? "" : "hidden"}>
          <span>Max Packs (0=unlim)</span>
          <input
            type="number"
            class="input mono"
            data-sheet-max-packs
            min="0"
            max="50"
            value="${curMaxPacks}"
            ${anyStarted ? "disabled" : ""}
          />
        </label>

        <label class="field mre-compact-field" data-sheet-laps-cell ${isInitOpenQual ? "hidden" : ""}>
          <span>Target Laps</span>
          <input
            type="number"
            class="input mono"
            data-sheet-target-laps
            min="0"
            max="99"
            value="${round.targetLaps}"
            ${anyStarted ? "disabled" : ""}
          />
        </label>

        <label class="field mre-compact-field">
          <span>Time Limit (s)</span>
          <input
            type="number"
            class="input mono"
            data-sheet-time-limit
            min="15"
            max="3600"
            step="5"
            value="${round.timeLimitSec}"
            ${anyStarted ? "disabled" : ""}
          />
        </label>
      </div>

      <label
        class="mre-connect-prev-toggle mre-sheet-check-toggle"
        data-sheet-winners-adv-row
        ${isInitFinals && curFinalsFormat === "chase_the_ace" ? "" : "hidden"}
      >
        <input
          type="checkbox"
          data-sheet-winners-adv
          ${curWinnersAdv ? "checked" : ""}
          ${anyStarted ? "disabled" : ""}
        />
        <span>Upper bracket #1 starts with +1 Ace win</span>
      </label>
    </div>`;

  const footHtml = `
    <button type="button" class="btn btn-ghost" data-mre-sheet-close>Cancel</button>
    <button type="button" class="btn btn-armed" data-sheet-save-round>
      ${icons.check(15)}<span>Save</span>
    </button>`;

  const { backdrop, close } = openMobileBottomSheet(
    `Edit Round · ${initialDisplayTitle}`,
    bodyHtml,
    footHtml
  );

  const titleInp = backdrop.querySelector<HTMLInputElement>("[data-sheet-round-title]");
  const laneSel = backdrop.querySelector<HTMLSelectElement>("[data-sheet-round-lane]");
  const formatSel = backdrop.querySelector<HTMLSelectElement>("[data-sheet-round-format]");
  const finalsFmtSel = backdrop.querySelector<HTMLSelectElement>("[data-sheet-finals-fmt]");
  const startSel = backdrop.querySelector<HTMLSelectElement>("[data-sheet-round-start]");
  const qualMetricSel = backdrop.querySelector<HTMLSelectElement>("[data-sheet-qual-metric]");
  const heatStdInp = backdrop.querySelector<HTMLInputElement>("[data-sheet-heat-count-std]");
  const heatQualInp = backdrop.querySelector<HTMLInputElement>("[data-sheet-heat-count-qual]");
  const lapsInp = backdrop.querySelector<HTMLInputElement>("[data-sheet-target-laps]");

  const syncVisibility = (): void => {
    const isFinals = curLane === "finals";
    const isQual = !isFinals && (curFormat === "qualifying" || curFormat === "open_qualifier");
    const isOpenQual = !isFinals && curFormat === "open_qualifier";

    const setHidden = (sel: string, hide: boolean): void => {
      const el = backdrop.querySelector<HTMLElement>(sel);
      if (el) el.hidden = hide;
    };

    setHidden("[data-sheet-format-cell]", isFinals);
    setHidden("[data-sheet-finals-fmt-cell]", !isFinals);
    setHidden("[data-sheet-qual-metric-cell]", !isQual);
    setHidden("[data-sheet-ace-wins-cell]", !(isFinals && curFinalsFormat === "chase_the_ace"));
    setHidden("[data-sheet-series-heats-cell]", !(isFinals && curFinalsFormat === "points_final"));
    setHidden("[data-sheet-std-heats-top-cell]", !(!isFinals && !isQual));
    setHidden("[data-sheet-qual-heats-cell]", !(!isFinals && curFormat === "qualifying"));
    setHidden("[data-sheet-max-packs-cell]", !isOpenQual);
    setHidden("[data-sheet-laps-cell]", isOpenQual);
    setHidden("[data-sheet-winners-adv-row]", !(isFinals && curFinalsFormat === "chase_the_ace"));

    const startRow = backdrop.querySelector<HTMLElement>("[data-sheet-start-row]");
    if (startRow) {
      startRow.classList.toggle("is-single-col", isFinals && curFinalsFormat === "single_final");
    }
    const timingGrid = backdrop.querySelector<HTMLElement>("[data-sheet-timing-grid]");
    if (timingGrid) {
      timingGrid.classList.toggle("is-three-col", !isFinals && curFormat === "qualifying");
    }
    scanCustomSelects(backdrop);
  };

  syncVisibility();

  // Keep both heat-count inputs mirrored so switching format preserves user edits
  heatStdInp?.addEventListener("input", () => {
    if (heatQualInp && heatStdInp) heatQualInp.value = heatStdInp.value;
  });
  heatQualInp?.addEventListener("input", () => {
    if (heatStdInp && heatQualInp) heatStdInp.value = heatQualInp.value;
  });

  backdrop.addEventListener("change", (e) => {
    const t = e.target as HTMLElement | null;
    if (!(t instanceof HTMLSelectElement)) return;

    if (t === laneSel) {
      const prevLane = curLane;
      curLane = t.value;
      if (curLane === "finals") {
        curStart = "heads_up";
        if (startSel) startSel.value = curStart;
        if (lapsInp && Number(lapsInp.value) === 0) {
          lapsInp.value = String(cfg?.targetLaps || 3);
        }
      } else if (curLane === "qualifying" && prevLane !== "qualifying") {
        if (curFormat !== "open_qualifier") {
          curFormat = "qualifying";
          if (formatSel) formatSel.value = curFormat;
        }
        curStart = "staggered";
        if (startSel) startSel.value = curStart;
        if (lapsInp) lapsInp.value = "0";
      } else if ((curLane === "winners" || curLane === "losers") && prevLane === "qualifying") {
        if (curFormat === "qualifying" || curFormat === "open_qualifier") {
          curFormat = "single_elimination";
          if (formatSel) formatSel.value = curFormat;
        }
        curStart = "heads_up";
        if (startSel) startSel.value = curStart;
        if (lapsInp && Number(lapsInp.value) === 0) {
          lapsInp.value = String(cfg?.targetLaps || 3);
        }
      }
      syncVisibility();
      return;
    }

    if (t === formatSel) {
      const nextFmt = t.value as StageFormat;
      curFormat = nextFmt;
      if (nextFmt === "qualifying" || nextFmt === "open_qualifier") {
        curLane = "qualifying";
        if (laneSel) laneSel.value = curLane;
        curStart = "staggered";
        if (startSel) startSel.value = curStart;
        if (lapsInp) lapsInp.value = "0";
      } else {
        if (curLane === "qualifying") {
          curLane = "winners";
          if (laneSel) laneSel.value = curLane;
        }
        curStart = "heads_up";
        if (startSel) startSel.value = curStart;
        if (lapsInp && Number(lapsInp.value) === 0) {
          lapsInp.value = String(cfg?.targetLaps || 3);
        }
      }
      syncVisibility();
      return;
    }

    if (t === finalsFmtSel) {
      curFinalsFormat = t.value as FinalsFormat;
      syncVisibility();
      return;
    }

    if (t === startSel) {
      curStart = t.value as StartMode;
      return;
    }

    if (t === qualMetricSel) {
      curQualMetric = t.value as QualifyingMetric;
    }
  });

  const submitRound = (): void => {
    const saveBtn = backdrop.querySelector<HTMLButtonElement>("[data-sheet-save-round]");
    if (!saveBtn || saveBtn.disabled) return;
    saveBtn.disabled = true;

    const rawTitle = titleInp?.value.trim() || "";
    const title = !rawTitle || rawTitle === initialDisplayTitle ? round.title : rawTitle;
    const activeHeatInp = curFormat === "qualifying" ? heatQualInp : heatStdInp;

    if (anyStarted) {
      const requestedHeatCount = Math.max(
        Math.max(1, startedCount),
        Math.min(16, Number(activeHeatInp?.value) || curHeatCount)
      );
      void cb.api
        .bracketEdit({
          action: "update_round",
          roundId: round.id,
          title,
          ...(curLane !== "finals" ? { heatCount: requestedHeatCount } : {}),
        })
        .then(() => close(false))
        .catch((err) => {
          saveBtn.disabled = false;
          cb.onError(err);
        });
      return;
    }

    const bracketLane = curLane || round.bracketLane;
    const isFinals = bracketLane === "finals";
    const stageFormat = (isFinals ? "single_elimination" : curFormat) as StageFormat;
    const heatCount = Math.max(1, Math.min(16, Number(activeHeatInp?.value) || curHeatCount));
    const targetLaps = Math.max(0, Number(lapsInp?.value ?? round.targetLaps));
    const timeLimitSec = Math.max(
      15,
      Number(backdrop.querySelector<HTMLInputElement>("[data-sheet-time-limit]")?.value) ||
        round.timeLimitSec
    );
    const aceWinsRequired = Math.max(
      2,
      Math.min(
        5,
        Number(backdrop.querySelector<HTMLInputElement>("[data-sheet-ace-wins]")?.value) || 2
      )
    );
    const winnersAdvantageAce = Boolean(
      backdrop.querySelector<HTMLInputElement>("[data-sheet-winners-adv]")?.checked
    );
    const finalsHeats = Math.max(
      2,
      Math.min(
        7,
        Number(backdrop.querySelector<HTMLInputElement>("[data-sheet-finals-heats]")?.value) || 3
      )
    );
    const maxPacksVal = Math.max(
      0,
      Math.min(
        50,
        Number(
          backdrop.querySelector<HTMLInputElement>("[data-sheet-max-packs]")?.value ?? curMaxPacks
        )
      )
    );

    void cb.api
      .bracketEdit({
        action: "update_round",
        roundId: round.id,
        title,
        bracketLane: stageFormat === "open_qualifier" ? "open_qual" : bracketLane,
        stageFormat,
        startMode: curStart,
        heatCount: isFinals
          ? curFinalsFormat === "points_final"
            ? finalsHeats
            : 1
          : heatCount,
        targetLaps,
        timeLimitSec,
        ...(stageFormat === "qualifying" || stageFormat === "open_qualifier"
          ? { qualifyingMetric: curQualMetric }
          : {}),
        ...(stageFormat === "open_qualifier" ? { maxPacksPerPilot: maxPacksVal } : {}),
        ...(isFinals
          ? {
              finalsFormat: curFinalsFormat,
              aceWinsRequired,
              winnersAdvantageAce,
              finalsHeats,
            }
          : {}),
      })
      .then(() => close(false))
      .catch((err) => {
        saveBtn.disabled = false;
        cb.onError(err);
      });
  };

  titleInp?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitRound();
    }
  });

  backdrop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest("[data-sheet-save-round]")) {
      submitRound();
    }
  });
}

function openMobileRaceSettingsSheet(cb: MobileRaceEditorCallbacks): void {
  const initRace = cb.getRace();
  const cfg = initRace.config;
  let curPph = Math.max(2, Math.min(8, cfg.pilotsPerHeat || 4));
  let curCountdown = Math.max(0, cfg.countdownSec ?? 5);
  let currentChannels = (
    cfg.seatChannels && cfg.seatChannels.length === curPph
      ? [...cfg.seatChannels]
      : defaultRaceSeatChannels(curPph)
  ).map((c) => (isValidEncodedSeatChannel(c) ? c : 1));
  let currentTags = [...(initRace.tags ?? [])];

  const renderSeatChannelGridHtml = (channels: number[]): string =>
    channels
      .map(
        (ch, idx) => `
        <select
          class="input mono mre-sheet-seat-select"
          data-sheet-seat-idx="${idx}"
          aria-label="Seat ${idx + 1} VTX channel"
        >${renderMultiBandSelectOptionsHtml({ selectedEncoded: ch, subFreq: true })}</select>`
      )
      .join("");

  const pphChoices = [2, 3, 4, 5, 6, 8];
  const cdChoices: Array<{ v: number; label: string }> = [
    { v: 0, label: "Instant (0s)" },
    { v: 3, label: "3s Countdown" },
    { v: 5, label: "5s Countdown" },
    { v: 10, label: "10s Countdown" },
  ];
  const hasCustomCd = !cdChoices.some((c) => c.v === curCountdown);

  const bodyHtml = `
    <div class="mre-compact-fields">
      <label class="field mre-compact-field">
        <span>Race Name</span>
        <input
          type="text"
          class="input"
          data-sheet-race-name
          value="${esc(cfg.eventName)}"
          maxlength="64"
        />
      </label>

      <div class="field mre-compact-field">
        <span>Tags</span>
        ${renderTagPillBoxHtml({
          boxId: "mre-race-settings",
          tags: currentTags,
          placeholder: "Type tag + comma or Enter...",
          compact: true,
          ariaLabel: "Race tags",
        })}
      </div>

      <div class="mre-compact-grid-2">
        <label class="field mre-compact-field">
          <span>Pilots / Heat</span>
          <select class="input" data-sheet-pph>
            ${pphChoices
              .map(
                (n) =>
                  `<option value="${n}" ${n === curPph ? "selected" : ""}>${n} Pilots</option>`
              )
              .join("")}
          </select>
        </label>

        <label class="field mre-compact-field">
          <span>Start Countdown</span>
          <select class="input" data-sheet-countdown>
            ${
              hasCustomCd
                ? `<option value="${curCountdown}" selected>${curCountdown}s Countdown</option>`
                : ""
            }
            ${cdChoices
              .map(
                (c) =>
                  `<option value="${c.v}" ${c.v === curCountdown ? "selected" : ""}>${esc(c.label)}</option>`
              )
              .join("")}
          </select>
        </label>
      </div>

      <div class="field mre-compact-field">
        <span>Default Seat Channels</span>
        <div class="mre-seat-ch-grid" data-sheet-seat-grid>
          ${renderSeatChannelGridHtml(currentChannels)}
        </div>
      </div>

      <div class="mre-compact-grid-2">
        <label class="field mre-compact-field">
          <span>Default Laps (0=timed)</span>
          <input
            type="number"
            class="input mono"
            data-sheet-default-laps
            min="0"
            max="99"
            value="${cfg.targetLaps ?? 3}"
          />
        </label>

        <label class="field mre-compact-field">
          <span>Time Limit (s)</span>
          <input
            type="number"
            class="input mono"
            data-sheet-default-time
            min="15"
            max="3600"
            step="5"
            value="${cfg.timeLimitSec || 120}"
          />
        </label>
      </div>
    </div>`;

  const footHtml = `
    <button type="button" class="btn btn-ghost" data-mre-sheet-close>Cancel</button>
    <button type="button" class="btn btn-armed" data-sheet-save-race>
      ${icons.check(15)}<span>Save</span>
    </button>`;

  const { backdrop, close } = openMobileBottomSheet("Race Settings", bodyHtml, footHtml);

  const seatGridEl = backdrop.querySelector<HTMLElement>("[data-sheet-seat-grid]")!;
  const tagBoxEl = backdrop.querySelector<HTMLElement>('[data-tag-box="mre-race-settings"]')!;
  const tagEditor = mountTagPillEditor(tagBoxEl, {
    initialTags: currentTags,
    placeholder: "Type tag + comma or Enter...",
    onChange: (next) => {
      currentTags = next;
    },
  });

  backdrop.addEventListener("change", (e) => {
    const t = e.target as HTMLElement | null;
    if (!(t instanceof HTMLSelectElement)) return;

    if (t.hasAttribute("data-sheet-pph")) {
      curPph = Math.max(2, Math.min(8, Number(t.value) || 4));
      currentChannels = defaultRaceSeatChannels(curPph);
      seatGridEl.innerHTML = renderSeatChannelGridHtml(currentChannels);
      scanCustomSelects(seatGridEl);
      return;
    }

    if (t.hasAttribute("data-sheet-countdown")) {
      curCountdown = Math.max(0, Number(t.value) || 0);
      return;
    }

    if (t.dataset.sheetSeatIdx !== undefined) {
      const idx = Number(t.dataset.sheetSeatIdx);
      const ch = Number(t.value);
      if (idx >= 0 && idx < currentChannels.length && isValidEncodedSeatChannel(ch)) {
        const targetFreq = decodeBandChannel(ch)?.frequencyMhz ?? 0;
        const other = currentChannels.findIndex(
          (existing, i) =>
            i !== idx &&
            (existing === ch ||
              (targetFreq > 0 && decodeBandChannel(existing)?.frequencyMhz === targetFreq))
        );
        if (other >= 0) {
          currentChannels[other] = currentChannels[idx];
        }
        currentChannels[idx] = ch;
        seatGridEl.innerHTML = renderSeatChannelGridHtml(currentChannels);
        scanCustomSelects(seatGridEl);
      }
    }
  });

  const submitRaceSettings = (): void => {
    const saveBtn = backdrop.querySelector<HTMLButtonElement>("[data-sheet-save-race]");
    if (!saveBtn || saveBtn.disabled) return;
    saveBtn.disabled = true;

    tagEditor.flushPending();
    currentTags = tagEditor.getTags();
    const curRace = cb.getRace();
    const newName =
      backdrop.querySelector<HTMLInputElement>("[data-sheet-race-name]")?.value.trim() ||
      curRace.config.eventName;
    const targetLaps = Math.max(
      0,
      Number(backdrop.querySelector<HTMLInputElement>("[data-sheet-default-laps]")?.value ?? 3)
    );
    const timeLimitSec = Math.max(
      15,
      Number(backdrop.querySelector<HTMLInputElement>("[data-sheet-default-time]")?.value ?? 120)
    );

    const nextCfg: RaceSetupConfig = {
      ...curRace.config,
      eventName: newName,
      pilotsPerHeat: curPph,
      seatChannels: currentChannels.slice(0, curPph),
      countdownSec: curCountdown,
      targetLaps,
      timeLimitSec,
    };

    const prevTagsJoined = (curRace.tags ?? []).join("\u0000");
    const nextTagsJoined = currentTags.join("\u0000");

    const renamePromise =
      newName !== curRace.config.eventName && curRace.raceId
        ? cb.api.eventAction({ action: "rename_race", raceId: curRace.raceId, name: newName })
        : Promise.resolve();

    const tagsPromise =
      prevTagsJoined !== nextTagsJoined && curRace.raceId
        ? cb.api.eventAction({
            action: "set_race_tags",
            raceId: curRace.raceId,
            tags: currentTags,
          })
        : Promise.resolve();

    void renamePromise
      .then(() => tagsPromise)
      .then(() => cb.api.configureRace(nextCfg, false, true))
      .then(() => close(false))
      .catch((err) => {
        saveBtn.disabled = false;
        cb.onError(err);
      });
  };

  backdrop
    .querySelector<HTMLInputElement>("[data-sheet-race-name]")
    ?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitRaceSettings();
      }
    });

  backdrop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest("[data-sheet-save-race]")) {
      submitRaceSettings();
    }
  });
}

function openMobileInitialSeedingSheet(
  round: RaceRound,
  cb: MobileRaceEditorCallbacks
): void {
  const race = cb.getRace();
  const roundHeats = (race.heats ?? []).filter((h) => h.roundId === round.id);
  const locked = roundHeats.some((h) => !isHeatUnstarted(h.state));
  const activeCount = (race.roster ?? []).filter(
    (p) => p.checkedIn && p.attendance === "active"
  ).length;
  const pilotsConn = (race.connections ?? []).find(
    (c) =>
      c.toRoundId === round.id &&
      (c.mode === "pilots_in" || isPilotsInRoundId(c.fromRoundId))
  );

  if (round.stageFormat === "open_qualifier") {
    const { backdrop, close } = openMobileBottomSheet(
      `Initial Seeding · ${round.title}`,
      `<p class="note" style="margin:0 0 12px">Open Qualifier rounds pull checked-in pilots dynamically from the Flight Queue as they walk up to fly.</p>
       <button type="button" class="btn btn-ghost mre-full-btn" data-sheet-manage-pilots>
         ${icons.pilot(14)}<span>Manage Checked-In Pilots (${activeCount})</span>
       </button>`,
      `<button type="button" class="btn btn-armed mre-full-btn" data-sheet-open-queue>${icons.zap(14)}<span>Open Queue Tab</span></button>`
    );
    backdrop.addEventListener("click", (e) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("[data-sheet-manage-pilots]")) {
        close();
        cb.onOpenPilotsTab();
      } else if (t?.closest("[data-sheet-open-queue]")) {
        close();
        cb.onOpenQueueTab();
      }
    });
    return;
  }

  const isCurrentlySeeded = Boolean(pilotsConn) || round.seedSource === "all_active_pilots";
  let selectedMode: "random" | "snake" | "sequential" | "roster" | "empty" = !isCurrentlySeeded
    ? "empty"
    : ((pilotsConn?.distribution || round.seedDistribution || "roster") as
        | "random"
        | "snake"
        | "sequential"
        | "roster");
  if (!["random", "snake", "sequential", "roster", "empty"].includes(selectedMode)) {
    selectedMode = "roster";
  }

  const choices: Array<{ id: typeof selectedMode; title: string; desc: string }> = [
    {
      id: "random",
      title: "Random Balanced",
      desc: "Randomize heats while keeping default VTX channels conflict-free.",
    },
    {
      id: "snake",
      title: "Bracket Snake (Fold)",
      desc: "Fold checked-in pilots across heats (#1, #8, #9 vs #2, #7, #10).",
    },
    {
      id: "sequential",
      title: "Grouped by Seed",
      desc: "Group adjacent roster order together (#1-#4 in Heat 1, #5-#8 in Heat 2).",
    },
    {
      id: "roster",
      title: "Roster Order",
      desc: "Fill heats directly in check-in roster order with balanced VTX rotation.",
    },
    {
      id: "empty",
      title: "Manual / Empty Seats",
      desc: "Leave seats empty so you can pick each pilot manually per heat.",
    },
  ];

  const bodyHtml = `
    <button type="button" class="btn btn-ghost btn-sm mre-full-btn" data-sheet-manage-pilots style="margin-bottom:10px">
      ${icons.pilot(14)}<span>Manage Checked-In Pilots (${activeCount})</span>${icons.chevronRight(13)}
    </button>
    <div class="mre-choice-list" role="radiogroup" aria-label="Initial seeding order">
      ${choices
        .map(
          (c) => `
        <button
          type="button"
          class="mre-choice-row ${c.id === selectedMode ? "is-selected" : ""}"
          data-sheet-seed-mode="${c.id}"
          ${locked ? "disabled" : ""}
        >
          <span class="mre-choice-text">
            <strong>${esc(c.title)}</strong>
            <span class="note">${esc(c.desc)}</span>
          </span>
          <span class="mre-choice-check">${c.id === selectedMode ? icons.check(15) : ""}</span>
        </button>`
        )
        .join("")}
    </div>`;

  const footHtml = `
    <button type="button" class="btn btn-ghost" data-mre-sheet-close>Cancel</button>
    <button type="button" class="btn btn-armed" data-sheet-save-seed ${locked ? "disabled" : ""}>
      ${icons.check(15)}<span>Apply Seeding</span>
    </button>`;

  const { backdrop, close } = openMobileBottomSheet(
    `Initial Seeding · ${formatMobileRoundDisplayTitle(round)}`,
    bodyHtml,
    footHtml
  );

  backdrop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;

    if (t.closest("[data-sheet-manage-pilots]")) {
      close();
      cb.onOpenPilotsTab();
      return;
    }

    const modeBtn = t.closest<HTMLButtonElement>("[data-sheet-seed-mode]");
    if (modeBtn && !modeBtn.disabled) {
      selectedMode = modeBtn.dataset.sheetSeedMode as typeof selectedMode;
      backdrop.querySelectorAll<HTMLElement>("[data-sheet-seed-mode]").forEach((el) => {
        const active = el.dataset.sheetSeedMode === selectedMode;
        el.classList.toggle("is-selected", active);
        const chk = el.querySelector(".mre-choice-check");
        if (chk) chk.innerHTML = active ? icons.check(15) : "";
      });
      return;
    }

    const saveBtn = t.closest<HTMLButtonElement>("[data-sheet-save-seed]");
    if (saveBtn && !saveBtn.disabled) {
      saveBtn.disabled = true;
      const stageIdx = round.stageIndex || 1;
      const fromPilotsId = `stage${stageIdx}-pilots-in`;
      const p =
        selectedMode === "empty"
          ? pilotsConn
            ? cb.api.bracketEdit({
                action: "disconnect_rounds",
                connectionId: pilotsConn.id,
                fromRoundId: fromPilotsId,
                toRoundId: round.id,
              })
            : cb.api.bracketEdit({
                action: "link_round",
                roundId: round.id,
                linkMode: "empty",
              })
          : pilotsConn
            ? cb.api.bracketEdit({
                action: "update_connection",
                connectionId: pilotsConn.id,
                fromRoundId: fromPilotsId,
                toRoundId: round.id,
                linkMode: "pilots_in",
                distribution: selectedMode,
              })
            : cb.api.bracketEdit({
                action: "connect_rounds",
                fromRoundId: fromPilotsId,
                toRoundId: round.id,
                linkMode: "pilots_in",
                distribution: selectedMode,
              });

      void p
        .then(() => close())
        .catch((err) => {
          saveBtn.disabled = false;
          cb.onError(err);
        });
    }
  });
}

function openMobileConnectOutSheet(
  fromRound: RaceRound,
  cb: MobileRaceEditorCallbacks
): void {
  const race = cb.getRace();
  const pph = Math.max(2, Math.min(8, race.config.pilotsPerHeat || 4));
  const maxPerHeat = Math.max(1, pph - 1);
  const allRounds = getSortedMobileRounds(race);
  const existingOutIds = new Set(
    (race.connections ?? [])
      .filter((c) => c.fromRoundId === fromRound.id && !c.invalid)
      .map((c) => c.toRoundId)
  );
  const candidateExisting = allRounds.filter(
    (r) =>
      r.id !== fromRound.id &&
      !existingOutIds.has(r.id) &&
      (r.column >= fromRound.column || r.bracketLane === "finals" || r.bracketLane === "losers")
  );

  const isFromQual =
    fromRound.stageFormat === "qualifying" ||
    fromRound.stageFormat === "open_qualifier" ||
    fromRound.bracketLane === "qualifying" ||
    fromRound.bracketLane === "open_qual";

  let selectedTarget =
    candidateExisting[0]?.id || (isFromQual ? "__new:race" : "__new:finals");
  let selectedRule: RoundConnectionMode = isFromQual ? "standings_top" : "top_per_heat";
  let cutKind: "all" | "top_n" | "range" = "all";

  const targetOptionsHtml = [
    ...candidateExisting.map(
      (r) => `<option value="${esc(r.id)}">Existing: ${esc(formatMobileRoundDisplayTitle(r))}</option>`
    ),
    `<option value="__new:race" ${selectedTarget === "__new:race" ? "selected" : ""}>+ New Race Round</option>`,
    `<option value="__new:losers">+ New Redemption Round</option>`,
    `<option value="__new:points_mains">+ New Points Round</option>`,
    `<option value="__new:qualifying">+ New Qualifier Round</option>`,
    `<option value="__new:finals" ${selectedTarget === "__new:finals" ? "selected" : ""}>+ New Finals Round</option>`,
  ].join("");

  const bodyHtml = `
    <div class="mre-sheet-fields">
      <label class="field">
        <span>Destination Round</span>
        <select class="input" data-sheet-target-round>${targetOptionsHtml}</select>
      </label>

      <label class="field">
        <span>Propagation Rule</span>
        <select class="input" data-sheet-rule-mode>
          ${
            isFromQual
              ? `<option value="standings_top" selected>Standings Cut (Qual / Points)</option>
                 <option value="all_pilots">All Pilots · Balanced Next Qual Round</option>
                 <option value="top_per_heat">Top K per Heat</option>`
              : `<option value="top_per_heat" selected>Top K per Heat (Winners Advance)</option>
                 <option value="bottom_per_heat">Bottom K per Heat (Drop to Redemption)</option>
                 <option value="standings_top">Overall Standings Cut</option>`
          }
        </select>
      </label>

      <div class="field" data-sheet-perheat-wrap ${selectedRule === "top_per_heat" || selectedRule === "bottom_per_heat" ? "" : "hidden"}>
        <span>Pilots per heat (1-${maxPerHeat})</span>
        <input type="number" class="input mono" data-sheet-perheat-count min="1" max="${maxPerHeat}" value="${Math.min(2, maxPerHeat)}" />
      </div>

      <div class="mre-sheet-standings-group" data-sheet-standings-wrap ${selectedRule === "standings_top" ? "" : "hidden"}>
        <label class="field">
          <span>Pilot Cut</span>
          <select class="input" data-sheet-cut-kind>
            <option value="all" selected>All Qualified Pilots</option>
            <option value="top_n">Top N Fastest</option>
            <option value="range">Rank Range (#Start - #End)</option>
          </select>
        </label>
        <label class="field" data-sheet-topn-field hidden>
          <span>Top N Pilots</span>
          <input type="number" class="input mono" data-sheet-topn-val min="1" max="64" value="${pph * 2}" />
        </label>
        <div class="field" data-sheet-range-field hidden>
          <span>Rank Range</span>
          <div class="rc-range-pair">
            <div class="rc-range-field">
              <span class="rc-range-prefix">#</span>
              <input type="number" class="input mono" data-sheet-range-start min="1" max="64" value="1" />
            </div>
            <span class="rc-range-sep">to</span>
            <div class="rc-range-field">
              <span class="rc-range-prefix">#</span>
              <input type="number" class="input mono" data-sheet-range-end min="1" max="64" value="${pph}" />
            </div>
          </div>
        </div>
        <label class="field">
          <span>Heat Seeding Fold</span>
          <select class="input" data-sheet-fold>
            <option value="snake" selected>Bracket Snake (Fold)</option>
            <option value="sequential">Sequential by Rank</option>
          </select>
        </label>
      </div>
    </div>`;

  const footHtml = `
    <button type="button" class="btn btn-ghost" data-mre-sheet-close>Cancel</button>
    <button type="button" class="btn btn-armed" data-sheet-connect-save>
      ${icons.link(14)}<span>Connect</span>
    </button>`;

  const { backdrop, close } = openMobileBottomSheet(
    `Connect From ${formatMobileRoundDisplayTitle(fromRound)}`,
    bodyHtml,
    footHtml
  );

  const syncRuleVisibility = (): void => {
    const perHeatWrap = backdrop.querySelector<HTMLElement>("[data-sheet-perheat-wrap]");
    const stWrap = backdrop.querySelector<HTMLElement>("[data-sheet-standings-wrap]");
    const topNField = backdrop.querySelector<HTMLElement>("[data-sheet-topn-field]");
    const rangeField = backdrop.querySelector<HTMLElement>("[data-sheet-range-field]");
    if (perHeatWrap) {
      perHeatWrap.hidden =
        selectedRule !== "top_per_heat" && selectedRule !== "bottom_per_heat";
    }
    if (stWrap) {
      stWrap.hidden = selectedRule !== "standings_top";
    }
    if (topNField) topNField.hidden = selectedRule !== "standings_top" || cutKind !== "top_n";
    if (rangeField) rangeField.hidden = selectedRule !== "standings_top" || cutKind !== "range";
  };

  backdrop.addEventListener("change", (e) => {
    const t = e.target as HTMLElement | null;
    if (!(t instanceof HTMLSelectElement)) return;
    if (t.hasAttribute("data-sheet-target-round")) {
      selectedTarget = t.value;
      if (selectedTarget === "__new:losers" && !isFromQual) {
        selectedRule = "bottom_per_heat";
        const rSel = backdrop.querySelector<HTMLSelectElement>("[data-sheet-rule-mode]");
        if (rSel) rSel.value = "bottom_per_heat";
        syncRuleVisibility();
      } else if (selectedTarget === "__new:qualifying" && isFromQual) {
        selectedRule = "all_pilots";
        const rSel = backdrop.querySelector<HTMLSelectElement>("[data-sheet-rule-mode]");
        if (rSel) rSel.value = "all_pilots";
        syncRuleVisibility();
      }
      return;
    }
    if (t.hasAttribute("data-sheet-rule-mode")) {
      selectedRule = t.value as RoundConnectionMode;
      syncRuleVisibility();
      return;
    }
    if (t.hasAttribute("data-sheet-cut-kind")) {
      cutKind = t.value as "all" | "top_n" | "range";
      syncRuleVisibility();
    }
  });

  backdrop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    const saveBtn = t?.closest<HTMLButtonElement>("[data-sheet-connect-save]");
    if (!saveBtn || saveBtn.disabled) return;
    saveBtn.disabled = true;

    const perHeatVal = Math.max(
      1,
      Math.min(
        maxPerHeat,
        Number(backdrop.querySelector<HTMLInputElement>("[data-sheet-perheat-count]")?.value) || 2
      )
    );
    const foldVal =
      backdrop.querySelector<HTMLSelectElement>("[data-sheet-fold]")?.value === "sequential"
        ? "sequential"
        : "snake";

    let seedStart = 0;
    let seedEnd = 0;
    let advanceCount = 0;
    if (selectedRule === "top_per_heat" || selectedRule === "bottom_per_heat") {
      advanceCount = perHeatVal;
    } else if (selectedRule === "standings_top") {
      if (cutKind === "top_n") {
        const n = Math.max(
          1,
          Math.min(
            64,
            Number(backdrop.querySelector<HTMLInputElement>("[data-sheet-topn-val]")?.value) || pph
          )
        );
        seedStart = 1;
        seedEnd = n;
        advanceCount = n;
      } else if (cutKind === "range") {
        seedStart = Math.max(
          1,
          Math.min(
            64,
            Number(backdrop.querySelector<HTMLInputElement>("[data-sheet-range-start]")?.value) || 1
          )
        );
        seedEnd = Math.max(
          seedStart,
          Math.min(
            64,
            Number(backdrop.querySelector<HTMLInputElement>("[data-sheet-range-end]")?.value) ||
              seedStart
          )
        );
        advanceCount = seedEnd - seedStart + 1;
      }
    }

    const fromPort: "right" | "bottom" =
      selectedRule === "bottom_per_heat" ? "bottom" : "right";

    if (selectedTarget.startsWith("__new:")) {
      const newKind = selectedTarget.slice("__new:".length);
      let bracketLane = "winners";
      let stageFormat: StageFormat = "single_elimination";
      let targetLaps = race.config.targetLaps || 3;
      let title: string | undefined;
      if (newKind === "losers") {
        bracketLane = "losers";
      } else if (newKind === "points_mains") {
        bracketLane = "mains";
        stageFormat = "points_mains";
      } else if (newKind === "qualifying") {
        const qCount = allRounds.filter((r) => r.stageFormat === "qualifying").length;
        title = `Qualifying ${qCount + 1}`;
        bracketLane = "qualifying";
        stageFormat = "qualifying";
        targetLaps = 0;
      } else if (newKind === "finals") {
        title = "Finals";
        bracketLane = "finals";
      }

      const prevIds = new Set((race.rounds ?? []).map((r) => r.id));
      void cb.api
        .bracketEdit({
          action: "add_round",
          stageIndex: fromRound.stageIndex || 1,
          title,
          bracketLane,
          stageFormat,
          targetLaps,
          timeLimitSec: race.config.timeLimitSec || 120,
          fromRoundId: fromRound.id,
          fromPort,
          linkMode: selectedRule,
          advanceCount,
          seedStart,
          seedEnd,
          distribution: foldVal,
        })
        .then((next) => {
          const added = (next.rounds ?? []).find(
            (r) => !prevIds.has(r.id) && !isHandoffPortalRound(r)
          );
          if (added) {
            cb.ui.activePageId = added.id;
            cb.onUiMutated();
          }
          close();
        })
        .catch((err) => {
          saveBtn.disabled = false;
          cb.onError(err);
        });
    } else {
      void cb.api
        .bracketEdit({
          action: "connect_rounds",
          fromRoundId: fromRound.id,
          toRoundId: selectedTarget,
          fromPort,
          linkMode: selectedRule,
          advanceCount,
          seedStart,
          seedEnd,
          distribution: foldVal,
        })
        .then(() => {
          close();
        })
        .catch((err) => {
          saveBtn.disabled = false;
          cb.onError(err);
        });
    }
  });
}

function openMobileEditConnectionSheet(
  connectionId: string,
  cb: MobileRaceEditorCallbacks
): void {
  const race = cb.getRace();
  const conn = (race.connections ?? []).find((c) => c.id === connectionId);
  if (!conn) return;

  const fromRound = (race.rounds ?? []).find((r) => r.id === conn.fromRoundId);
  const toRound = (race.rounds ?? []).find((r) => r.id === conn.toRoundId);

  if (conn.mode === "pilots_in" || isPilotsInRoundId(conn.fromRoundId)) {
    if (toRound) {
      openMobileInitialSeedingSheet(toRound, cb);
    }
    return;
  }

  const pph = Math.max(2, Math.min(8, race.config.pilotsPerHeat || 4));
  const maxPerHeat = Math.max(1, pph - 1);
  const activePilotCount = (race.roster ?? []).filter(
    (p) => p.checkedIn && p.attendance === "active"
  ).length;

  const toHeats = (race.heats ?? []).filter((h) => h.roundId === conn.toRoundId);
  const lockedTarget = !conn.invalid && toHeats.some((h) => !isHeatUnstarted(h.state));

  const sourceTitle = fromRound ? formatMobileRoundDisplayTitle(fromRound) : conn.fromRoundId;
  const targetTitle = toRound ? formatMobileRoundDisplayTitle(toRound) : conn.toRoundId;

  const rawMode = (conn.mode || "top_per_heat") as RoundConnectionMode;
  let curMode:
    | "top_per_heat"
    | "bottom_per_heat"
    | "standings_top"
    | "all_pilots"
    | "all_pilots_ranked" =
    rawMode === "bottom_per_heat" ||
    rawMode === "standings_top" ||
    rawMode === "all_pilots" ||
    rawMode === "all_pilots_ranked"
      ? rawMode
      : "top_per_heat";

  const curCount =
    conn.count && conn.count > 0
      ? conn.count
      : conn.seedEnd && conn.seedEnd > 0
        ? conn.seedEnd
        : curMode === "standings_top"
          ? Math.max(pph, activePilotCount || pph)
          : Math.min(2, maxPerHeat);

  let curStandingsCut: "all" | "top_n" | "range" =
    conn.seedStart && conn.seedStart > 1
      ? "range"
      : (conn.seedEnd && conn.seedEnd > 0) || (conn.count && conn.count > 0)
        ? "top_n"
        : "all";

  const curSeedStart = conn.seedStart && conn.seedStart > 0 ? conn.seedStart : 1;
  const curSeedEnd =
    conn.seedEnd && conn.seedEnd >= curSeedStart
      ? conn.seedEnd
      : Math.max(curSeedStart, activePilotCount || pph);
  let curSeedDist: "snake" | "sequential" =
    conn.distribution === "sequential" ? "sequential" : "snake";
  let curStandingsMetric: QualifyingMetric =
    conn.rankingMetric ||
    fromRound?.qualifyingMetric ||
    race.config.qualifyingMetric ||
    "consecutive_3";

  const isSourceQual =
    fromRound?.stageFormat === "qualifying" ||
    fromRound?.stageFormat === "open_qualifier" ||
    fromRound?.bracketLane === "qualifying" ||
    fromRound?.bracketLane === "open_qual";
  const confirmedQualCount = isSourceQual
    ? (race.heats ?? []).filter(
        (h) =>
          (h.roundId === conn.fromRoundId ||
            h.stageFormat === "qualifying" ||
            h.stageFormat === "open_qualifier") &&
          h.state === "confirmed"
      ).length
    : 0;
  const canSeedEarlyNow =
    curMode === "standings_top" &&
    isSourceQual &&
    confirmedQualCount >= 1 &&
    !conn.seededEarly &&
    !lockedTarget;
  const canReopenEarlyNow =
    curMode === "standings_top" && Boolean(conn.seededEarly) && !lockedTarget;

  const invalidText =
    conn.invalid && conn.invalidReason
      ? cleanConnectionInvalidReason(conn.invalidReason) || conn.invalidReason
      : "";

  const isInitPerHeat = curMode === "top_per_heat" || curMode === "bottom_per_heat";
  const isInitStandings = curMode === "standings_top";

  const bodyHtml = `
    <div class="mre-compact-fields">
      <div class="mre-conn-flow-bar">
        <strong>${esc(sourceTitle)}</strong>
        <span class="mre-conn-flow-arrow">${icons.arrowRight(13)}</span>
        <strong>${esc(targetTitle)}</strong>
      </div>

      ${
        invalidText
          ? `<div class="mre-io-invalid-note" role="status"><span class="mre-io-invalid-ico">${icons.alertTriangle(14)}</span>${esc(invalidText)}</div>`
          : ""
      }

      <label class="field mre-compact-field">
        <span>Advancement Rule</span>
        <select class="input" data-sheet-wconn-mode ${lockedTarget ? "disabled" : ""}>
          <option value="top_per_heat" ${curMode === "top_per_heat" ? "selected" : ""}>Top N per Heat (Advance)</option>
          <option value="bottom_per_heat" ${curMode === "bottom_per_heat" ? "selected" : ""}>Bottom N per Heat (Redemption)</option>
          <option value="standings_top" ${curMode === "standings_top" ? "selected" : ""}>Standings Cut (Qual / Points)</option>
          <option value="all_pilots" ${curMode === "all_pilots" ? "selected" : ""}>All Pilots · Balanced</option>
          <option value="all_pilots_ranked" ${curMode === "all_pilots_ranked" ? "selected" : ""}>All Pilots · Ranked</option>
        </select>
      </label>

      <label class="field mre-compact-field" data-sheet-wconn-perheat-cell ${isInitPerHeat ? "" : "hidden"}>
        <span>Pilots per Heat (1-${maxPerHeat})</span>
        <input
          type="number"
          class="input mono"
          data-sheet-wconn-count
          min="1"
          max="${maxPerHeat}"
          value="${Math.max(1, Math.min(maxPerHeat, curCount))}"
          ${lockedTarget ? "disabled" : ""}
        />
      </label>

      <div class="mre-compact-grid-2" data-sheet-wconn-st-row1 ${isInitStandings ? "" : "hidden"}>
        <label class="field mre-compact-field">
          <span>Pilot Cut</span>
          <select class="input" data-sheet-wconn-cut ${lockedTarget ? "disabled" : ""}>
            <option value="all" ${curStandingsCut === "all" ? "selected" : ""}>All Qualified</option>
            <option value="top_n" ${curStandingsCut === "top_n" ? "selected" : ""}>Top N Fastest</option>
            <option value="range" ${curStandingsCut === "range" ? "selected" : ""}>Rank Range</option>
          </select>
        </label>

        <label class="field mre-compact-field">
          <span>Heat Seeding Fold</span>
          <select class="input" data-sheet-wconn-fold ${lockedTarget ? "disabled" : ""}>
            <option value="snake" ${curSeedDist === "snake" ? "selected" : ""}>Bracket Snake</option>
            <option value="sequential" ${curSeedDist === "sequential" ? "selected" : ""}>Sequential</option>
          </select>
        </label>
      </div>

      <div
        class="mre-compact-grid-2 ${curStandingsCut === "all" ? "is-single-col" : ""}"
        data-sheet-wconn-st-row2
        ${isInitStandings ? "" : "hidden"}
      >
        <label class="field mre-compact-field" data-sheet-wconn-topn-cell ${isInitStandings && curStandingsCut === "top_n" ? "" : "hidden"}>
          <span>Top N Pilots</span>
          <input
            type="number"
            class="input mono"
            data-sheet-wconn-topn
            min="1"
            max="64"
            value="${Math.max(1, conn.seedEnd || conn.count || pph)}"
            ${lockedTarget ? "disabled" : ""}
          />
        </label>

        <div class="field mre-compact-field" data-sheet-wconn-range-cell ${isInitStandings && curStandingsCut === "range" ? "" : "hidden"}>
          <span>Rank Range</span>
          <div class="rc-range-pair">
            <div class="rc-range-field">
              <span class="rc-range-prefix">#</span>
              <input
                type="number"
                class="input mono"
                data-sheet-wconn-start
                min="1"
                max="64"
                value="${curSeedStart}"
                aria-label="Start rank"
                ${lockedTarget ? "disabled" : ""}
              />
            </div>
            <span class="rc-range-sep">to</span>
            <div class="rc-range-field">
              <span class="rc-range-prefix">#</span>
              <input
                type="number"
                class="input mono"
                data-sheet-wconn-end
                min="1"
                max="64"
                value="${curSeedEnd}"
                aria-label="End rank"
                ${lockedTarget ? "disabled" : ""}
              />
            </div>
          </div>
        </div>

        <label class="field mre-compact-field">
          <span>Ranked By</span>
          <select class="input" data-sheet-wconn-metric ${lockedTarget ? "disabled" : ""}>
            <option value="consecutive_3" ${curStandingsMetric === "consecutive_3" ? "selected" : ""}>Top 3 Consecutive</option>
            <option value="consecutive_2" ${curStandingsMetric === "consecutive_2" ? "selected" : ""}>Top 2 Consecutive</option>
            <option value="best_lap" ${curStandingsMetric === "best_lap" ? "selected" : ""}>Fastest Lap</option>
            <option value="laps_in_time" ${curStandingsMetric === "laps_in_time" ? "selected" : ""}>Most Laps in Time</option>
            <option value="points" ${curStandingsMetric === "points" ? "selected" : ""}>Heat Points</option>
          </select>
        </label>
      </div>

      ${
        canSeedEarlyNow
          ? `<div class="mre-seed-now-bar">
              <span class="note">${confirmedQualCount} qual heat${confirmedQualCount === 1 ? "" : "s"} confirmed</span>
              <button type="button" class="btn btn-armed btn-xs" data-sheet-wconn-seed-now>
                ${icons.zap(12)}<span>Seed Now</span>
              </button>
            </div>`
          : canReopenEarlyNow
            ? `<div class="mre-seed-now-bar is-seeded">
                <span class="note">Seeded early into ${esc(targetTitle)}</span>
                <button type="button" class="btn btn-ghost btn-xs" data-sheet-wconn-reopen-seed>
                  ${icons.unlock(12)}<span>Reopen</span>
                </button>
              </div>`
            : ""
      }

      ${
        lockedTarget
          ? `<p class="note" style="margin:0">Heats in ${esc(targetTitle)} have already started. Reset them before changing this rule.</p>`
          : ""
      }
    </div>`;

  const footHtml = `
    <button type="button" class="btn btn-ghost" data-mre-sheet-close>Cancel</button>
    <button type="button" class="btn btn-armed" data-sheet-wconn-save ${lockedTarget ? "disabled" : ""}>
      ${icons.check(15)}<span>Save</span>
    </button>`;

  const { backdrop, close } = openMobileBottomSheet("Edit Connection", bodyHtml, footHtml);

  const syncConnFields = (): void => {
    const isPerHeat = curMode === "top_per_heat" || curMode === "bottom_per_heat";
    const isSt = curMode === "standings_top";
    const setHidden = (sel: string, hide: boolean): void => {
      const el = backdrop.querySelector<HTMLElement>(sel);
      if (el) el.hidden = hide;
    };
    setHidden("[data-sheet-wconn-perheat-cell]", !isPerHeat);
    setHidden("[data-sheet-wconn-st-row1]", !isSt);
    setHidden("[data-sheet-wconn-st-row2]", !isSt);
    setHidden("[data-sheet-wconn-topn-cell]", !(isSt && curStandingsCut === "top_n"));
    setHidden("[data-sheet-wconn-range-cell]", !(isSt && curStandingsCut === "range"));
    const stRow2 = backdrop.querySelector<HTMLElement>("[data-sheet-wconn-st-row2]");
    if (stRow2) {
      stRow2.classList.toggle("is-single-col", curStandingsCut === "all");
    }
    scanCustomSelects(backdrop);
  };

  backdrop.addEventListener("change", (e) => {
    const t = e.target as HTMLElement | null;
    if (!(t instanceof HTMLSelectElement)) return;
    if (t.hasAttribute("data-sheet-wconn-mode")) {
      curMode = (
        t.value === "bottom_per_heat" ||
        t.value === "standings_top" ||
        t.value === "all_pilots" ||
        t.value === "all_pilots_ranked"
          ? t.value
          : "top_per_heat"
      ) as typeof curMode;
      syncConnFields();
      return;
    }
    if (t.hasAttribute("data-sheet-wconn-cut")) {
      curStandingsCut = (
        t.value === "top_n" || t.value === "range" ? t.value : "all"
      ) as typeof curStandingsCut;
      syncConnFields();
      return;
    }
    if (t.hasAttribute("data-sheet-wconn-fold")) {
      curSeedDist = t.value === "sequential" ? "sequential" : "snake";
      return;
    }
    if (t.hasAttribute("data-sheet-wconn-metric")) {
      curStandingsMetric = (t.value || "consecutive_3") as QualifyingMetric;
    }
  });

  backdrop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;

    const seedNowBtn = t.closest<HTMLButtonElement>("[data-sheet-wconn-seed-now]");
    if (seedNowBtn && !seedNowBtn.disabled) {
      seedNowBtn.disabled = true;
      void cb.api
        .bracketEdit({
          action: "seed_connection_now",
          connectionId: conn.id,
        })
        .then(() => close(false))
        .catch((err) => {
          seedNowBtn.disabled = false;
          cb.onError(err);
        });
      return;
    }

    const reopenBtn = t.closest<HTMLButtonElement>("[data-sheet-wconn-reopen-seed]");
    if (reopenBtn && !reopenBtn.disabled) {
      reopenBtn.disabled = true;
      void cb.api
        .bracketEdit({
          action: "reopen_connection_seed",
          connectionId: conn.id,
        })
        .then(() => close(false))
        .catch((err) => {
          reopenBtn.disabled = false;
          cb.onError(err);
        });
      return;
    }

    const saveBtn = t.closest<HTMLButtonElement>("[data-sheet-wconn-save]");
    if (!saveBtn || saveBtn.disabled) return;
    saveBtn.disabled = true;

    let actionPromise: Promise<RaceTournamentState>;
    if (curMode === "standings_top") {
      let sStart = 0;
      let sEnd = 0;
      let adv = 0;
      if (curStandingsCut === "top_n") {
        const n = Math.max(
          1,
          Math.min(
            64,
            Number(backdrop.querySelector<HTMLInputElement>("[data-sheet-wconn-topn]")?.value) || pph
          )
        );
        sStart = 1;
        sEnd = n;
        adv = n;
      } else if (curStandingsCut === "range") {
        sStart = Math.max(
          1,
          Math.min(
            64,
            Number(backdrop.querySelector<HTMLInputElement>("[data-sheet-wconn-start]")?.value) || 1
          )
        );
        sEnd = Math.max(
          sStart,
          Math.min(
            64,
            Number(backdrop.querySelector<HTMLInputElement>("[data-sheet-wconn-end]")?.value) ||
              sStart
          )
        );
        adv = sEnd - sStart + 1;
      }
      actionPromise = cb.api.bracketEdit({
        action: "update_connection",
        connectionId: conn.id,
        linkMode: "standings_top",
        advanceCount: adv,
        seedStart: sStart,
        seedEnd: sEnd,
        distribution: curSeedDist,
        qualifyingMetric: curStandingsMetric,
      });
    } else {
      const rawCount =
        Number(backdrop.querySelector<HTMLInputElement>("[data-sheet-wconn-count]")?.value) || 2;
      const advanceCount =
        curMode === "top_per_heat" || curMode === "bottom_per_heat"
          ? Math.max(1, Math.min(maxPerHeat, rawCount))
          : 0;
      actionPromise = cb.api.bracketEdit({
        action: "update_connection",
        connectionId: conn.id,
        linkMode: curMode,
        advanceCount,
      });
    }

    void actionPromise
      .then(() => close(false))
      .catch((err) => {
        saveBtn.disabled = false;
        cb.onError(err);
      });
  });
}

function openMobileSeedNowSheet(
  conn: RoundConnection,
  cb: MobileRaceEditorCallbacks
): void {
  const race = cb.getRace();
  const srcRound = (race.rounds ?? []).find((r) => r.id === conn.fromRoundId);
  const dstRound = (race.rounds ?? []).find((r) => r.id === conn.toRoundId);
  const dstTitle = dstRound ? formatMobileRoundDisplayTitle(dstRound) : conn.toRoundId;

  const qualHeats = (race.heats ?? []).filter(
    (h) =>
      h.roundId === conn.fromRoundId ||
      h.stageFormat === "qualifying" ||
      h.stageFormat === "open_qualifier"
  );
  const confirmedCount = qualHeats.filter((h) => h.state === "confirmed").length;
  const unflownCount = qualHeats.filter((h) => h.state !== "confirmed" && h.state !== "aborted").length;

  const standings: TournamentStanding[] =
    race.qualStandings && race.qualStandings.length > 0
      ? race.qualStandings
      : (race.standings ?? []);
  const sStart = Math.max(1, conn.seedStart || 1);
  const sEnd =
    conn.seedEnd && conn.seedEnd >= sStart
      ? conn.seedEnd
      : conn.count && conn.count > 0
        ? conn.count
        : standings.length;
  const slice = standings.slice(sStart - 1, sEnd).slice(0, 8);

  const previewHtml =
    slice.length > 0
      ? `<div class="mre-seed-preview-list">
          ${slice
            .map(
              (st) => `
            <div class="mre-seed-preview-row">
              <span class="mono note">#${st.rank}</span>
              <span class="dot" style="--c:${adaptColorForTheme(st.color)}"></span>
              <strong>${esc(st.callsign)}</strong>
              <span class="mono note">${
                st.bestConsecutive3Sec > 0
                  ? `${st.bestConsecutive3Sec.toFixed(2)}s`
                  : st.bestLapSec > 0
                    ? `${st.bestLapSec.toFixed(2)}s`
                    : `${st.heatsFlown}H`
              }</span>
            </div>`
            )
            .join("")}
        </div>`
      : `<p class="note">Advancing pilots will lock from confirmed heats so far.</p>`;

  const warnHtml =
    unflownCount > 0
      ? `<div class="mre-sheet-warn">
          ${icons.siren(14)}
          <span>${
            srcRound?.stageFormat === "open_qualifier"
              ? `${unflownCount} unstarted queued pack${unflownCount === 1 ? "" : "s"} will be cleared.`
              : `${unflownCount} remaining qualifying heat${unflownCount === 1 ? "" : "s"} will be skipped.`
          }</span>
        </div>`
      : "";

  const bodyHtml = `
    <p class="note" style="margin:0 0 10px">
      Lock provisional standings from <strong>${confirmedCount} confirmed heat${confirmedCount === 1 ? "" : "s"}</strong> into <strong>${esc(dstTitle)}</strong> now?
    </p>
    ${previewHtml}
    ${warnHtml}`;

  const footHtml = `
    <button type="button" class="btn btn-ghost" data-mre-sheet-close>Cancel</button>
    <button type="button" class="btn btn-armed" data-sheet-confirm-seed-now>
      ${icons.zap(14)}<span>Seed ${esc(dstTitle)} Now</span>
    </button>`;

  const { backdrop, close } = openMobileBottomSheet(
    `Seed ${dstTitle} Now`,
    bodyHtml,
    footHtml
  );

  backdrop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    const btn = t?.closest<HTMLButtonElement>("[data-sheet-confirm-seed-now]");
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    void cb.api
      .bracketEdit({
        action: "seed_connection_now",
        connectionId: conn.id,
      })
      .then(() => {
        if (dstRound) {
          cb.ui.activePageId = dstRound.id;
          cb.onUiMutated();
        }
        close();
      })
      .catch((err) => {
        btn.disabled = false;
        cb.onError(err);
      });
  });
}

/* ============================================================================
 * Event Delegation & Carousel Scroll Synchronization
 * ========================================================================== */

const activeCarouselAnimations = new WeakMap<HTMLElement, () => void>();

export function scrollMobileCarouselToPage(
  root: ParentNode,
  pageId: string,
  behavior: ScrollBehavior = "smooth"
): void {
  const carousel = root.querySelector<HTMLElement>("[data-mre-carousel]");
  if (!carousel) return;
  const page = carousel.querySelector<HTMLElement>(
    `[data-mre-round-page="${CSS.escape(pageId)}"]`
  );
  if (!page) return;

  activeCarouselAnimations.get(carousel)?.();

  const pages = Array.from(carousel.querySelectorAll<HTMLElement>("[data-mre-round-page]"));
  const pageIdx = pages.indexOf(page);
  const width = carousel.clientWidth;
  const targetLeft =
    pageIdx >= 0 && width > 0
      ? pageIdx * width
      : Math.max(0, page.offsetLeft - carousel.offsetLeft);
  const startLeft = carousel.scrollLeft;
  const delta = targetLeft - startLeft;
  const dist = Math.abs(delta);
  const markOnlyTargetInView = (): void => {
    pages.forEach((p) => {
      const only = p === page;
      if (p.classList.contains("is-in-view") !== only) {
        p.classList.toggle("is-in-view", only);
      }
    });
  };

  if (dist <= 1) {
    syncStepperActiveDom(root, pageId, false);
    markOnlyTargetInView();
    carousel.classList.remove("is-swiping");
    carousel.style.scrollSnapType = "";
    delete carousel.dataset.mreProgTarget;
    delete carousel.dataset.mreProgUntil;
    return;
  }

  if (behavior !== "smooth" || typeof requestAnimationFrame !== "function") {
    syncStepperActiveDom(root, pageId, false);
    markOnlyTargetInView();
    carousel.classList.remove("is-swiping");
    carousel.style.scrollSnapType = "";
    delete carousel.dataset.mreProgTarget;
    delete carousel.dataset.mreProgUntil;
    carousel.scrollLeft = targetLeft;
    return;
  }

  const pagesCrossed = width > 0 ? Math.max(1, Math.round(dist / width)) : 1;
  const durationMs = Math.min(380, 230 + Math.min(4, pagesCrossed - 1) * 38);
  const startTime = performance.now();
  let rafId = 0;
  let cancelled = false;

  carousel.classList.add("is-swiping");
  carousel.style.scrollSnapType = "none";
  carousel.dataset.mreProgTarget = String(targetLeft);
  carousel.dataset.mreProgUntil = String(Date.now() + durationMs + 120);

  const finish = (snapToTarget: boolean): void => {
    if (cancelled) return;
    cancelled = true;
    if (rafId) cancelAnimationFrame(rafId);
    carousel.removeEventListener("pointerdown", onUserInterrupt, { capture: true } as EventListenerOptions);
    carousel.removeEventListener("touchstart", onUserInterrupt, { capture: true } as EventListenerOptions);
    carousel.removeEventListener("wheel", onUserInterrupt, { capture: true } as EventListenerOptions);
    if (activeCarouselAnimations.get(carousel) === cancelAnim) {
      activeCarouselAnimations.delete(carousel);
    }
    if (snapToTarget) {
      carousel.dataset.mreProgUntil = String(Date.now() + 80);
      carousel.scrollLeft = targetLeft;
      syncStepperActiveDom(root, pageId, false);
      markOnlyTargetInView();
      carousel.classList.remove("is-swiping");
    }
    carousel.style.scrollSnapType = "";
    requestAnimationFrame(() => {
      delete carousel.dataset.mreProgTarget;
    });
  };

  const cancelAnim = (): void => finish(false);
  const onUserInterrupt = (): void => finish(false);

  carousel.addEventListener("pointerdown", onUserInterrupt, { capture: true, passive: true });
  carousel.addEventListener("touchstart", onUserInterrupt, { capture: true, passive: true });
  carousel.addEventListener("wheel", onUserInterrupt, { capture: true, passive: true });
  activeCarouselAnimations.set(carousel, cancelAnim);

  const step = (now: number): void => {
    if (cancelled) return;
    const t = Math.min(1, Math.max(0, (now - startTime) / durationMs));
    const eased = 1 - Math.pow(1 - t, 3);
    carousel.scrollLeft = startLeft + delta * eased;
    if (t < 1) {
      rafId = requestAnimationFrame(step);
    } else {
      finish(true);
    }
  };

  rafId = requestAnimationFrame(step);
}

let cleanupMreWindowScroll: (() => void) | null = null;

function getRoundStripDockScrollY(root: ParentNode): number {
  if (typeof window === "undefined" || typeof document === "undefined") return 0;
  const anchor =
    root.querySelector<HTMLElement>("[data-mre-strip-anchor]") ??
    root.querySelector<HTMLElement>("[data-mre-root]");
  if (!anchor) return 0;
  const topbar = document.querySelector<HTMLElement>(".topbar");
  const topbarH = topbar ? topbar.offsetHeight : 0;
  const anchorDocTop = anchor.getBoundingClientRect().top + window.scrollY;
  return Math.max(0, Math.ceil(anchorDocTop - topbarH));
}

function anchorMobileRoundSwitchScroll(root: ParentNode): void {
  if (typeof window === "undefined") return;
  const dockY = getRoundStripDockScrollY(root);
  if (dockY > 0 && window.scrollY > dockY) {
    window.scrollTo(0, dockY + 1);
  }
}

function bindMreStickyStripScroll(root: ParentNode, ui: MobileRaceEditorUiState): void {
  cleanupMreWindowScroll?.();
  cleanupMreWindowScroll = null;
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const strip = root.querySelector<HTMLElement>(".mre-top-strip");
  if (!strip) return;
  const cueBtn = strip.querySelector<HTMLElement>("[data-mre-collapse-cue]");

  let lastStuck: boolean | null = ui.isStripStuck;
  const syncStuck = (force = false): void => {
    if (!document.body.contains(strip)) {
      cleanupMreWindowScroll?.();
      cleanupMreWindowScroll = null;
      return;
    }
    const dockY = getRoundStripDockScrollY(root);
    const threshold = lastStuck ? dockY - 6 : dockY - 2;
    const stuck = dockY > 0 && window.scrollY >= threshold;
    ui.isStripStuck = stuck;
    if (!force && stuck === lastStuck) return;
    lastStuck = stuck;
    strip.classList.toggle("is-stuck", stuck);
    if (cueBtn) {
      const lbl = stuck ? "Show race info and menu" : "Scroll round switcher to top";
      if (cueBtn.getAttribute("aria-label") !== lbl) {
        cueBtn.setAttribute("aria-label", lbl);
      }
      if (cueBtn.getAttribute("title") !== lbl) {
        cueBtn.setAttribute("title", lbl);
      }
    }
  };

  let touchStartY: number | null = null;
  const onCueTouchStart = (e: TouchEvent): void => {
    if (e.touches.length === 1) {
      touchStartY = e.touches[0].clientY;
    }
  };
  const onCueTouchEnd = (e: TouchEvent): void => {
    if (touchStartY === null || e.changedTouches.length === 0) return;
    const dy = e.changedTouches[0].clientY - touchStartY;
    touchStartY = null;
    const dockY = getRoundStripDockScrollY(root);
    if (dockY <= 0) return;
    if (dy <= -14 && window.scrollY < dockY - 2) {
      window.scrollTo({ top: dockY + 1, behavior: "smooth" });
    } else if (dy >= 14 && window.scrollY > 4) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  strip.classList.add("no-cue-anim");
  syncStuck(true);
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      strip.classList.remove("no-cue-anim");
    });
  } else {
    strip.classList.remove("no-cue-anim");
  }

  const onWinScroll = (): void => syncStuck(false);
  window.addEventListener("scroll", onWinScroll, { passive: true });
  cueBtn?.addEventListener("touchstart", onCueTouchStart, { passive: true });
  cueBtn?.addEventListener("touchend", onCueTouchEnd, { passive: true });
  cleanupMreWindowScroll = () => {
    window.removeEventListener("scroll", onWinScroll);
    cueBtn?.removeEventListener("touchstart", onCueTouchStart);
    cueBtn?.removeEventListener("touchend", onCueTouchEnd);
  };
}

let cleanupMreCarouselGestures: (() => void) | null = null;

export function syncMobileCarouselAfterRender(
  root: ParentNode,
  ui: MobileRaceEditorUiState
): void {
  cleanupMreCarouselGestures?.();
  cleanupMreCarouselGestures = null;
  bindMreStickyStripScroll(root, ui);
  const carousel = root.querySelector<HTMLElement>("[data-mre-carousel]");
  if (!carousel || !ui.activePageId) return;

  scrollMobileCarouselToPage(root, ui.activePageId, "instant" as ScrollBehavior);
  syncStepperActiveDom(root, ui.activePageId, false);
  fitScheduleLineups(root);

  let rafPending = false;
  let isGestureHeld = false;
  let swipeSettleTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSettledPageId = ui.activePageId;

  const syncVisiblePages = (): boolean => {
    const width = carousel.clientWidth;
    if (width <= 0) return true;
    const sl = carousel.scrollLeft;
    const pages = Array.from(
      carousel.querySelectorAll<HTMLElement>("[data-mre-round-page]")
    );
    let activeIdx = 0;
    pages.forEach((p, idx) => {
      const pLeft = idx * width;
      const pRight = pLeft + width;
      const inView = pRight > sl + 2 && pLeft < sl + width - 2;
      if (p.classList.contains("is-in-view") !== inView) {
        p.classList.toggle("is-in-view", inView);
      }
      if (p.dataset.mreRoundPage === ui.activePageId) {
        activeIdx = idx;
      }
    });
    return Math.abs(sl - activeIdx * width) <= 3;
  };

  syncVisiblePages();

  const scheduleSwipeSettle = (delayMs = 140): void => {
    if (swipeSettleTimer) clearTimeout(swipeSettleTimer);
    swipeSettleTimer = setTimeout(() => {
      swipeSettleTimer = null;
      if (!document.body.contains(carousel)) return;
      if (carousel.dataset.mreProgTarget) return;
      const aligned = syncVisiblePages();
      if (isGestureHeld || !aligned) {
        if (!isGestureHeld && !aligned) {
          scheduleSwipeSettle(120);
        }
        return;
      }
      if (ui.activePageId !== lastSettledPageId) {
        lastSettledPageId = ui.activePageId;
        anchorMobileRoundSwitchScroll(root);
      }
      syncStepperActiveDom(root, ui.activePageId, false);
      syncVisiblePages();
      carousel.classList.remove("is-swiping");
    }, delayMs);
  };

  const onGestureStart = (): void => {
    isGestureHeld = true;
    if (swipeSettleTimer) {
      clearTimeout(swipeSettleTimer);
      swipeSettleTimer = null;
    }
    if (!carousel.dataset.mreProgTarget) {
      carousel.classList.add("is-swiping");
    }
  };

  const onGestureEnd = (): void => {
    if (!isGestureHeld) return;
    isGestureHeld = false;
    if (!carousel.dataset.mreProgTarget) {
      scheduleSwipeSettle(140);
    }
  };

  carousel.addEventListener("pointerdown", onGestureStart, { passive: true });
  carousel.addEventListener("touchstart", onGestureStart, { passive: true });
  window.addEventListener("pointerup", onGestureEnd, { passive: true });
  window.addEventListener("pointercancel", onGestureEnd, { passive: true });
  window.addEventListener("touchend", onGestureEnd, { passive: true });
  window.addEventListener("touchcancel", onGestureEnd, { passive: true });
  cleanupMreCarouselGestures = () => {
    if (swipeSettleTimer) {
      clearTimeout(swipeSettleTimer);
      swipeSettleTimer = null;
    }
    carousel.removeEventListener("pointerdown", onGestureStart);
    carousel.removeEventListener("touchstart", onGestureStart);
    window.removeEventListener("pointerup", onGestureEnd);
    window.removeEventListener("pointercancel", onGestureEnd);
    window.removeEventListener("touchend", onGestureEnd);
    window.removeEventListener("touchcancel", onGestureEnd);
  };

  carousel.addEventListener(
    "scroll",
    () => {
      if (!carousel.dataset.mreProgTarget) {
        if (!carousel.classList.contains("is-swiping")) {
          carousel.classList.add("is-swiping");
        }
        if (!isGestureHeld) {
          scheduleSwipeSettle(140);
        }
      }
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        const progUntil = Number(carousel.dataset.mreProgUntil) || 0;
        if (progUntil > Date.now()) {
          syncVisiblePages();
          return;
        }
        const width = carousel.clientWidth;
        if (width <= 0) return;
        const pages = Array.from(
          carousel.querySelectorAll<HTMLElement>("[data-mre-round-page]")
        );
        if (pages.length === 0) return;
        const center = carousel.scrollLeft + width * 0.5;
        let bestId = ui.activePageId;
        let bestDist = Infinity;
        for (const p of pages) {
          const pCenter = p.offsetLeft + p.offsetWidth * 0.5;
          const d = Math.abs(pCenter - center);
          if (d < bestDist) {
            bestDist = d;
            bestId = p.dataset.mreRoundPage || bestId;
          }
        }
        if (bestId && bestId !== ui.activePageId) {
          ui.activePageId = bestId;
          syncStepperActiveDom(root, bestId, true);
        }
        syncVisiblePages();
      });
    },
    { passive: true }
  );
}

function syncStepperActiveDom(root: ParentNode, activePageId: string, animate = false): void {
  root.querySelectorAll<HTMLElement>("[data-mre-round-page]").forEach((page) => {
    page.classList.toggle("is-active-page", page.dataset.mreRoundPage === activePageId);
  });
  const stepper = root.querySelector<HTMLElement>("[data-mre-stepper]");
  if (!stepper) return;
  const pillsWrap = stepper.querySelector<HTMLElement>(".mre-stepper-pills");
  let activePill: HTMLElement | null = null;
  let activeIdx = 0;
  let i = 0;
  stepper.querySelectorAll<HTMLElement>("[data-mre-step]").forEach((pill) => {
    const isAct = pill.dataset.mreStep === activePageId;
    if (pill.classList.contains("is-active") !== isAct) {
      pill.classList.toggle("is-active", isAct);
    }
    const ariaVal = isAct ? "true" : "false";
    if (pill.getAttribute("aria-selected") !== ariaVal) {
      pill.setAttribute("aria-selected", ariaVal);
    }
    const insideScrollable = Boolean(pillsWrap && pillsWrap.contains(pill));
    if (isAct && insideScrollable) {
      activePill = pill;
      activeIdx = i;
    }
    if (insideScrollable) {
      i++;
    }
  });
  if (activePill && pillsWrap && pillsWrap.scrollWidth > pillsWrap.clientWidth) {
    const nextScroll =
      activeIdx === 0
        ? 0
        : Math.max(
            0,
            (activePill as HTMLElement).offsetLeft -
              (pillsWrap.clientWidth - (activePill as HTMLElement).offsetWidth) / 2
          );
    if (animate && typeof pillsWrap.scrollTo === "function") {
      try {
        pillsWrap.scrollTo({ left: nextScroll, behavior: "smooth" });
      } catch {
        pillsWrap.scrollLeft = nextScroll;
      }
    } else {
      pillsWrap.scrollLeft = nextScroll;
    }
  }
}

export function addConstructFromMobile(
  kind: MobileConstructKind,
  cb: MobileRaceEditorCallbacks
): void {
  const race = cb.getRace();
  const rounds = getSortedMobileRounds(race);
  const existingCount = rounds.length;
  const qualCount = rounds.filter((r) => r.stageFormat === "qualifying").length;
  const lastConnectable = [...rounds].reverse().find((r) => r.bracketLane !== "finals");
  const shouldConnectPrev =
    existingCount > 0 &&
    cb.ui.connectToPreviousOnAdd &&
    Boolean(lastConnectable) &&
    kind !== "open_qualifier" &&
    kind !== "zippyq_qualifier";

  let title: string | undefined;
  let bracketLane = "winners";
  let stageFormat: StageFormat = "single_elimination";
  let targetLaps = race.config.targetLaps || 3;
  let linkMode: RoundConnectionMode | "all_active_pilots" | "empty" =
    existingCount === 0 ? "all_active_pilots" : "empty";

  switch (kind) {
    case "qualifying":
      title = `Qualifying ${qualCount + 1}`;
      bracketLane = "qualifying";
      stageFormat = "qualifying";
      targetLaps = 0;
      if (existingCount === 0) linkMode = "all_active_pilots";
      break;
    case "open_qualifier":
      title = "Open Qualifier";
      bracketLane = "open_qual";
      stageFormat = "open_qualifier";
      targetLaps = 0;
      linkMode = "empty";
      break;
    case "zippyq_qualifier":
      title = "ZippyQ Qualifier";
      bracketLane = "open_qual";
      stageFormat = "open_qualifier";
      targetLaps = 0;
      linkMode = "empty";
      break;
    case "points_mains":
      bracketLane = "mains";
      stageFormat = "points_mains";
      break;
    case "finals":
      title = "Finals";
      bracketLane = "finals";
      break;
    case "race":
    default:
      break;
  }

  let fromRoundId: string | undefined;
  if (shouldConnectPrev && lastConnectable) {
    fromRoundId = lastConnectable.id;
    const isPrevQual =
      lastConnectable.stageFormat === "qualifying" ||
      lastConnectable.stageFormat === "open_qualifier";
    linkMode =
      kind === "qualifying" && isPrevQual
        ? "all_pilots"
        : isPrevQual || lastConnectable.stageFormat === "points_mains"
          ? "standings_top"
          : "top_per_heat";
  }

  const prevIds = new Set((race.rounds ?? []).map((r) => r.id));
  void cb.api
    .bracketEdit({
      action: "add_round",
      stageIndex: 1,
      title,
      bracketLane,
      stageFormat,
      targetLaps,
      timeLimitSec: race.config.timeLimitSec || 120,
      ...(fromRoundId ? { fromRoundId } : {}),
      linkMode,
      ...(existingCount === 0 && linkMode === "all_active_pilots"
        ? { distribution: "random" }
        : {}),
    })
    .then((next) => {
      const added = (next.rounds ?? []).find(
        (r) => !prevIds.has(r.id) && !isHandoffPortalRound(r)
      );
      if (added) {
        cb.ui.activePageId = added.id;
        cb.onUiMutated();
      }
    })
    .catch(cb.onError);
}

export function handleMobileRaceEditorClick(
  e: Event,
  root: ParentNode,
  cb: MobileRaceEditorCallbacks
): boolean {
  const target = e.target as HTMLElement | null;
  if (!target || !target.closest("[data-mre-root]")) return false;

  if (target.closest("[data-mre-collapse-cue]")) {
    if (typeof window !== "undefined") {
      const dockY = getRoundStripDockScrollY(root);
      if (dockY > 0 && window.scrollY < dockY - 2) {
        window.scrollTo({ top: dockY + 1, behavior: "smooth" });
      } else {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    }
    return true;
  }

  const stepBtn = target.closest<HTMLButtonElement>("[data-mre-step]");
  if (stepBtn) {
    const pid = stepBtn.dataset.mreStep || "";
    if (pid) {
      cb.ui.activePageId = pid;
      root.querySelector<HTMLElement>("[data-mre-carousel]")?.classList.add("is-swiping");
      syncStepperActiveDom(root, pid, true);
      anchorMobileRoundSwitchScroll(root);
      scrollMobileCarouselToPage(root, pid, "smooth");
    }
    return true;
  }

  const jumpBtn = target.closest<HTMLButtonElement>("[data-mre-jump-round]");
  if (jumpBtn) {
    const rid = jumpBtn.dataset.mreJumpRound || "";
    if (rid) {
      cb.ui.activePageId = rid;
      root.querySelector<HTMLElement>("[data-mre-carousel]")?.classList.add("is-swiping");
      syncStepperActiveDom(root, rid, true);
      anchorMobileRoundSwitchScroll(root);
      scrollMobileCarouselToPage(root, rid, "smooth");
    }
    return true;
  }

  if (target.closest("[data-mre-open-templates]")) {
    cb.onOpenTemplates();
    return true;
  }

  if (target.closest("[data-mre-open-defaults]")) {
    openMobileRaceSettingsSheet(cb);
    return true;
  }

  if (target.closest("[data-mre-open-pilots]")) {
    cb.onOpenPilotsTab();
    return true;
  }

  if (target.closest("[data-mre-open-queue]")) {
    cb.onOpenQueueTab();
    return true;
  }

  const reviewBtn = target.closest<HTMLButtonElement>("[data-mre-review-heat]");
  if (reviewBtn) {
    const hid = reviewBtn.dataset.mreReviewHeat || "";
    if (hid) cb.onOpenReviewHeat(hid);
    return true;
  }

  const addRoundBtn = target.closest<HTMLButtonElement>("[data-mre-add-round]");
  if (addRoundBtn && !addRoundBtn.disabled) {
    const kind = (addRoundBtn.dataset.mreAddRound || "race") as MobileConstructKind;
    addConstructFromMobile(kind, cb);
    return true;
  }

  const roundSettingsBtn = target.closest<HTMLButtonElement>("[data-mre-round-settings]");
  if (roundSettingsBtn) {
    const rid = roundSettingsBtn.dataset.mreRoundSettings || "";
    const race = cb.getRace();
    const round = (race.rounds ?? []).find((r) => r.id === rid);
    if (round) {
      openMobileRoundSettingsSheet(round, cb);
    }
    return true;
  }

  const delRoundBtn = target.closest<HTMLButtonElement>("[data-mre-delete-round]");
  if (delRoundBtn && !delRoundBtn.disabled) {
    const rid = delRoundBtn.dataset.mreDeleteRound || "";
    const race = cb.getRace();
    const round = (race.rounds ?? []).find((r) => r.id === rid);
    if (!round) return true;
    const doDelete = () => {
      const prevRoundIds = getSortedMobileRounds(cb.getRace()).map((r) => r.id);
      return cb.api
        .bracketEdit({ action: "delete_round", roundId: round.id })
        .then((next) => {
          const rem = getSortedMobileRounds(next);
          cb.ui.activePageId = resolveNextRoundIdAfterDelete(prevRoundIds, round.id, rem);
          cb.ui.lastOrderedRoundIds = rem.map((r) => r.id);
          cb.onUiMutated();
        })
        .catch(cb.onError);
    };

    if (roundNeedsDeleteConfirmation(race, round.id)) {
      const delTitle = formatMobileRoundDisplayTitle(round);
      openConfirmModal({
        title: `Delete ${delTitle}?`,
        messageHtml: `<p>Remove <strong>${esc(delTitle)}</strong> and disconnect its progression rules?</p>`,
        confirmLabel: "Delete Round",
        danger: true,
        onConfirm: doDelete,
      });
    } else {
      void doDelete();
    }
    return true;
  }

  const seedingBtn = target.closest<HTMLButtonElement>("[data-mre-open-seeding]");
  if (seedingBtn && !seedingBtn.disabled) {
    const rid = seedingBtn.dataset.mreOpenSeeding || "";
    const round = (cb.getRace().rounds ?? []).find((r) => r.id === rid);
    if (round) {
      openMobileInitialSeedingSheet(round, cb);
    }
    return true;
  }

  const reshuffleBtn = target.closest<HTMLButtonElement>("[data-mre-reshuffle]");
  if (reshuffleBtn && !reshuffleBtn.disabled) {
    const rid = reshuffleBtn.dataset.mreReshuffle || "";
    if (rid) {
      void cb.api.bracketEdit({ action: "reshuffle_round", roundId: rid }).catch(cb.onError);
    }
    return true;
  }

  const editConnBtn = target.closest<HTMLButtonElement>("[data-mre-edit-conn]");
  if (editConnBtn && !editConnBtn.disabled) {
    const cid = editConnBtn.dataset.mreEditConn || "";
    if (cid) {
      openMobileEditConnectionSheet(cid, cb);
    }
    return true;
  }

  const disconnectBtn = target.closest<HTMLButtonElement>("[data-mre-disconnect]");
  if (disconnectBtn && !disconnectBtn.disabled) {
    const cid = disconnectBtn.dataset.mreDisconnect || "";
    if (cid) {
      void cb.api
        .bracketEdit({ action: "disconnect_rounds", connectionId: cid })
        .catch(cb.onError);
    }
    return true;
  }

  const connectOutBtn = target.closest<HTMLButtonElement>("[data-mre-connect-out]");
  if (connectOutBtn && !connectOutBtn.disabled) {
    const rid = connectOutBtn.dataset.mreConnectOut || "";
    const fromRound = (cb.getRace().rounds ?? []).find((r) => r.id === rid);
    if (fromRound) {
      openMobileConnectOutSheet(fromRound, cb);
    }
    return true;
  }

  const seedNowBtn = target.closest<HTMLButtonElement>("[data-mre-seed-now]");
  if (seedNowBtn && !seedNowBtn.disabled) {
    const cid = seedNowBtn.dataset.mreSeedNow || "";
    const conn = (cb.getRace().connections ?? []).find((c) => c.id === cid);
    if (conn) {
      openMobileSeedNowSheet(conn, cb);
    }
    return true;
  }

  const reopenSeedBtn = target.closest<HTMLButtonElement>("[data-mre-reopen-seed]");
  if (reopenSeedBtn && !reopenSeedBtn.disabled) {
    const cid = reopenSeedBtn.dataset.mreReopenSeed || "";
    if (cid) {
      void cb.api
        .bracketEdit({ action: "reopen_connection_seed", connectionId: cid })
        .catch(cb.onError);
    }
    return true;
  }

  const addHeatBtn = target.closest<HTMLButtonElement>("[data-mre-add-heat]");
  if (addHeatBtn && !addHeatBtn.disabled) {
    const rid = addHeatBtn.dataset.mreAddHeat || "";
    if (rid) {
      void cb.api.bracketEdit({ action: "add_heat", roundId: rid }).catch(cb.onError);
    }
    return true;
  }

  const delHeatBtn = target.closest<HTMLButtonElement>("[data-mre-delete-heat]");
  if (delHeatBtn && !delHeatBtn.disabled) {
    const hid = delHeatBtn.dataset.mreDeleteHeat || "";
    if (hid) {
      void cb.api.bracketEdit({ action: "delete_heat", heatId: hid }).catch(cb.onError);
    }
    return true;
  }

  const unlockSeatBtn = target.closest<HTMLButtonElement>("[data-mre-unlock-seat]");
  if (unlockSeatBtn && !unlockSeatBtn.disabled) {
    const heatId = unlockSeatBtn.dataset.heatId || "";
    const seatIndex = Number(unlockSeatBtn.dataset.seatIdx) || 0;
    if (heatId && seatIndex > 0) {
      void cb.api
        .bracketEdit({ action: "unlock_seat", heatId, seatIndex })
        .catch(cb.onError);
    }
    return true;
  }

  return false;
}

export function handleMobileRaceEditorChange(
  e: Event,
  cb: MobileRaceEditorCallbacks
): boolean {
  const target = e.target as HTMLElement | null;
  if (!target || !target.closest("[data-mre-root]")) return false;

  if (
    target instanceof HTMLInputElement &&
    target.hasAttribute("data-mre-toggle-connect-prev")
  ) {
    cb.ui.connectToPreviousOnAdd = target.checked;
    return true;
  }

  if (target instanceof HTMLSelectElement) {
    if (target.hasAttribute("data-mre-seat-ch")) {
      const heatId = target.dataset.heatId || "";
      const seatIndex = Number(target.dataset.seatIdx) || 0;
      const code = Number(target.value) || 0;
      const dec = decodeBandChannel(code);
      if (heatId && seatIndex > 0 && dec) {
        void cb.api
          .bracketEdit({
            action: "set_seat_channel",
            heatId,
            seatIndex,
            band: dec.band,
            channel: dec.channel,
          })
          .catch(cb.onError);
      }
      return true;
    }

    if (target.hasAttribute("data-mre-seat-pilot")) {
      const heatId = target.dataset.heatId || "";
      const seatIndex = Number(target.dataset.seatIdx) || 0;
      const pilotSlotIndex = Number(target.value) || 0;
      if (!heatId || seatIndex <= 0) return true;
      if (pilotSlotIndex <= 0) {
        void cb.api
          .bracketEdit({
            action: "clear_seat",
            heatId,
            seatIndex,
          })
          .catch(cb.onError);
      } else {
        void cb.api
          .bracketEdit({
            action: "assign_pilot_seat",
            heatId,
            seatIndex,
            pilotSlotIndex,
          })
          .catch(cb.onError);
      }
      return true;
    }
  }

  return false;
}
