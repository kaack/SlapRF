import { closeCustomSelect, isCustomSelectOpenWithin, scanCustomSelects } from "../core/custom_select";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { adaptColorForTheme } from "../core/theme";
import {
  decodeBandChannel,
  formatBandChannelShort,
  formatEncodedChannelShort,
  renderMultiBandSelectOptionsHtml,
} from "../core/vtx_channels";
import { ApiClient } from "../services/api_client";
import {
  EventPilot,
  RaceHeat,
  RaceRound,
  RaceTournamentState,
  RoundConnection,
  RoundConnectionMode,
  StageFormat,
  TournamentStanding,
} from "../types/models";
import {
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
import {
  formatInitialSeedModeLabel,
  formatLaneBadge,
  formatMobileConnectionSummary,
  formatMobileRoundDisplayTitle,
  formatRaceSettingsSubtitle,
  formatRoundTimingSubtitle,
  getRoundAddHeatRestriction,
  getSortedMobileRounds,
  MobileConstructKind,
} from "./MobileRaceEditor";
import {
  openRaceSettingsModal,
  openRoundCustomizeModal,
  openWireConnectionModal,
} from "./RoundModals";
import { cleanConnectionInvalidReason } from "./Toast";

const PILOTS_COLLAPSED_STORAGE_KEY = "slaprf.rc.tablePilotsCollapsed.v1";

export interface DesktopRaceTableUiState {
  pilotsCollapsed: boolean;
  connectToPreviousOnAdd: boolean;
  pendingScrollRoundId: string;
  pendingScrollHeatsBottomRoundId?: string;
}

export function createDefaultDesktopRaceTableState(): DesktopRaceTableUiState {
  let pilotsCollapsed = false;
  try {
    if (typeof window !== "undefined") {
      pilotsCollapsed = window.localStorage.getItem(PILOTS_COLLAPSED_STORAGE_KEY) === "1";
    }
  } catch {
    pilotsCollapsed = false;
  }
  return {
    pilotsCollapsed,
    connectToPreviousOnAdd: true,
    pendingScrollRoundId: "",
  };
}

export function persistDesktopTablePilotsCollapsed(collapsed: boolean): void {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(PILOTS_COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
    }
  } catch {
    // Ignore storage errors
  }
}

export interface DesktopRaceTableCallbacks {
  getRace: () => RaceTournamentState;
  getAllTags: () => string[];
  api: ApiClient;
  ui: DesktopRaceTableUiState;
  onOpenPilotsTab: () => void;
  onOpenTemplates: () => void;
  onOpenControlQueue: () => void;
  onOpenReviewHeat: (heatId: string) => void;
  onError: (msg: string) => void;
  onUiMutated: () => void;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function renderConstructButtons(attrName: string): string {
  const items: Array<{
    kind: MobileConstructKind;
    title: string;
    sub: string;
    iconHtml: string;
  }> = [
    {
      kind: "qualifying",
      title: "Qualifier",
      sub: "Staggered timed heats",
      iconHtml: icons.timer(15),
    },
    {
      kind: "open_qualifier",
      title: "Open Qualifier",
      sub: "Walk-up flight queue",
      iconHtml: icons.zap(15),
    },
    {
      kind: "zippyq_qualifier",
      title: "ZippyQ",
      sub: "Dynamic flight queue",
      iconHtml: icons.zap(15),
    },
    {
      kind: "race",
      title: "Race Round",
      sub: "Head-to-head elimination",
      iconHtml: icons.checkered(15),
    },
    {
      kind: "points_mains",
      title: "Points Round",
      sub: "Cumulative points heats",
      iconHtml: icons.layers(15),
    },
    {
      kind: "finals",
      title: "Finals",
      sub: "Single, Chase Ace, or Series",
      iconHtml: icons.trophy(15),
    },
  ];

  return `
    <div class="dte-construct-list">
      ${items
        .map(
          (it) => `
        <button type="button" class="dte-construct-btn" ${attrName}="${it.kind}">
          <span class="dte-construct-ico">${it.iconHtml}</span>
          <span class="dte-construct-copy">
            <strong>${esc(it.title)}</strong>
            <span class="note">${esc(it.sub)}</span>
          </span>
        </button>`
        )
        .join("")}
    </div>`;
}

export function renderSetupRaceSubRibbonHtml(
  race: RaceTournamentState,
  setupViewToggleHtml: string,
  isFloating = false
): string {
  const rounds = getSortedMobileRounds(race);
  const canEditStructure =
    race.lifecycle !== "completed" && race.lifecycle !== "scrapped";
  const anyHeatStarted = (race.heats ?? []).some((h) => !isHeatUnstarted(h.state));
  const raceTitle = (race.config.eventName || "").trim() || "Untitled Race";
  const settingsSub = formatRaceSettingsSubtitle(race);
  const configured =
    Boolean(race.generated) || rounds.length > 0 || (race.heats?.length ?? 0) > 0;
  const statusBadge = race.emergencyStopped
    ? { label: "Stopped", cls: "is-stopped" }
    : !configured
      ? { label: "New", cls: "is-waiting" }
      : raceLifecycleBadge(race.isComplete && !race.lifecycle ? "completed" : race.lifecycle);
  const isOngoing =
    !race.isComplete &&
    !race.emergencyStopped &&
    (race.lifecycle === "active" ||
      (race.heats ?? []).some(
        (h) => h.state === "running" || h.state === "countdown" || h.state === "armed"
      ));

  return `
    <section
      class="dte-race-summary ${isFloating ? "is-floating-subribbon" : ""}"
      data-dte-race-summary
      data-rc-hud
      aria-label="Race summary"
    >
      <div class="dte-race-summary-main">
        <div class="dte-race-title-row">
          <h2 class="dte-race-title">${esc(raceTitle)}</h2>
          <span class="race-state-pill ${statusBadge.cls}" data-dte-race-status>${esc(statusBadge.label)}</span>
          <span class="note dte-race-settings-sub">${esc(settingsSub)}</span>
        </div>
      </div>
      <div class="dte-race-summary-actions">
        ${
          canEditStructure && !anyHeatStarted
            ? `<button
                type="button"
                class="btn btn-ghost btn-sm"
                data-dte-open-templates
                title="Apply tournament template"
              >${icons.layers(14)}<span>Templates</span></button>`
            : ""
        }
        ${setupViewToggleHtml}
        ${
          canEditStructure
            ? `<button
                type="button"
                class="btn btn-ghost dte-summary-icon-btn"
                data-dte-open-defaults
                title="Race settings"
                aria-label="Race settings"
              >${icons.sliders(20)}</button>`
            : ""
        }
        <button
          type="button"
          class="btn btn-ghost dte-summary-icon-btn dte-danger-icon"
          data-race-act="delete-race"
          data-race-id="${esc(race.raceId)}"
          ${isOngoing ? "disabled" : ""}
          title="${isOngoing ? "Pause or complete this race before deleting" : `Delete ${esc(raceTitle)}`}"
          aria-label="Delete race"
        >${icons.trash(19)}</button>
      </div>
    </section>`;
}

export function renderDesktopRaceTableEditorHtml(
  race: RaceTournamentState,
  ui: DesktopRaceTableUiState,
  topLeftBarHtml: string,
  setupViewToggleHtml: string
): string {
  const rounds = getSortedMobileRounds(race);
  const canEditStructure =
    race.lifecycle !== "completed" && race.lifecycle !== "scrapped";
  const roster = race.roster ?? [];
  const activePilots = roster.filter((p) => p.checkedIn && p.attendance === "active");

  const topbarHtml = `
    <div class="races-page-topbar dte-page-topbar" data-rc-hud>
      <div class="rc-topbar-side is-left" aria-hidden="true"></div>
      ${topLeftBarHtml}
      <div class="rc-topbar-side is-right" aria-hidden="true"></div>
    </div>`;

  const raceSummaryHtml = renderSetupRaceSubRibbonHtml(race, setupViewToggleHtml, false);

  if (rounds.length === 0) {
    return `
      <div class="races-page is-setup-table-page" data-rc-page="configure" data-dte-root>
        ${topbarHtml}
        ${raceSummaryHtml}
        <div class="dte-board-wrap">
          <div class="dte-board-scroll" data-dte-scroll data-preserve-scroll="dte-board">
            <section class="card dte-empty-card" aria-label="Build Race Schedule">
              <div class="dte-empty-head">
                <span class="dte-empty-ico">${icons.panels(22)}</span>
                <div>
                  <h3>Build Race Schedule</h3>
                  <p class="note">Pick a tournament template to populate all rounds, or add your first round column below.</p>
                </div>
              </div>
              <div class="dte-empty-actions">
                <button type="button" class="btn btn-armed" data-dte-open-templates>
                  ${icons.layers(15)}<span>Choose Race Template</span>
                </button>
              </div>
              ${
                canEditStructure
                  ? `<div class="dte-empty-sub">Or add first round column manually</div>
                     ${renderConstructButtons("data-dte-add-round")}`
                  : ""
              }
            </section>
          </div>
        </div>
      </div>`;
  }

  const roundById = new Map<string, RaceRound>();
  for (const r of rounds) roundById.set(r.id, r);

  const realConnections = (race.connections ?? []).filter(
    (c) =>
      !isHandoffInRoundId(c.fromRoundId) &&
      !isHandoffOutRoundId(c.toRoundId) &&
      !isPilotsInRoundId(c.fromRoundId) &&
      c.mode !== "pilots_in" &&
      c.mode !== "stage_seeds" &&
      c.mode !== "qual_feed"
  );

  const pilotsConnsByTarget = new Map<string, RoundConnection>();
  for (const c of race.connections ?? []) {
    if (c.mode === "pilots_in" || isPilotsInRoundId(c.fromRoundId)) {
      pilotsConnsByTarget.set(c.toRoundId, c);
    }
  }

  const roundColsHtml = rounds
    .map((round, idx) =>
      renderDesktopRoundColumn(
        race,
        round,
        idx,
        rounds.length,
        roundById,
        realConnections,
        pilotsConnsByTarget.get(round.id),
        activePilots,
        canEditStructure
      )
    )
    .join("");

  const hasFinalsRound = rounds.some((r) => r.bracketLane === "finals");
  const lastConnectable = [...rounds].reverse().find((r) => r.bracketLane !== "finals");
  const addRoundColHtml =
    canEditStructure && !hasFinalsRound
      ? `<section class="card dte-col is-add-col" aria-label="Add Round">
        <header class="dte-col-head">
          <div class="dte-col-title-wrap">
            ${icons.plus(14)}
            <strong>Add Round</strong>
          </div>
        </header>
        <div class="dte-add-col-body">
          ${
            lastConnectable
              ? `<label class="mre-sheet-check-toggle dte-connect-prev-check">
                  <input
                    type="checkbox"
                    data-dte-toggle-connect-prev
                    ${ui.connectToPreviousOnAdd ? "checked" : ""}
                  />
                  <span>Connect after <strong>${esc(formatMobileRoundDisplayTitle(lastConnectable))}</strong></span>
                </label>`
              : ""
          }
          ${renderConstructButtons("data-dte-add-round")}
        </div>
      </section>`
    : "";

  return `
    <div class="races-page is-setup-table-page" data-rc-page="configure" data-dte-root>
      ${topbarHtml}
      ${raceSummaryHtml}
      <div class="dte-board-wrap" data-dte-board-wrap>
        <button
          type="button"
          class="dte-scroll-cue is-left"
          data-dte-scroll-dir="-1"
          aria-label="Scroll rounds left"
          title="Scroll rounds left"
          hidden
        >${icons.chevronLeft(24)}</button>
        <div class="dte-board-scroll" data-dte-scroll data-preserve-scroll="dte-board">
          ${roundColsHtml}
          ${addRoundColHtml}
        </div>
        <button
          type="button"
          class="dte-scroll-cue is-right"
          data-dte-scroll-dir="1"
          aria-label="Scroll rounds right"
          title="Scroll rounds right"
          hidden
        >${icons.chevronRight(24)}</button>
      </div>
    </div>`;
}

function renderDesktopRoundColumn(
  race: RaceTournamentState,
  round: RaceRound,
  roundIdx: number,
  totalRounds: number,
  roundById: Map<string, RaceRound>,
  realConnections: RoundConnection[],
  pilotsConn: RoundConnection | undefined,
  activePilots: EventPilot[],
  canEditStructure: boolean
): string {
  const roundHeats = (race.heats ?? [])
    .filter((h) => h.roundId === round.id)
    .sort((a, b) => a.order - b.order);
  const anyStartedInRound = roundHeats.some((h) => !isHeatUnstarted(h.state));
  const laneBadge = formatLaneBadge(round);
  const timingSub = formatRoundTimingSubtitle(round, race);

  const inConns = realConnections.filter((c) => c.toRoundId === round.id);
  const outConns = realConnections.filter((c) => c.fromRoundId === round.id);

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

  let inRowsHtml = "";
  if (inConns.length > 0) {
    inRowsHtml = inConns
      .map((c) => {
        const src = roundById.get(c.fromRoundId);
        const srcTitle = src ? formatMobileRoundDisplayTitle(src) : c.fromRoundId;
        const srcFullTitle = src?.title || srcTitle;
        const ruleSummary = formatMobileConnectionSummary(c);
        const invalidText =
          c.invalid && c.invalidReason
            ? cleanConnectionInvalidReason(c.invalidReason) || c.invalidReason
            : "";
        return `
          <div class="dte-io-item-group">
            <div class="dte-io-row ${c.invalid ? "is-invalid" : ""}">
              ${
                src
                  ? `<button type="button" class="dte-io-mini-btn dte-io-lead-jump" data-dte-jump-round="${esc(src.id)}" title="Scroll to ${esc(srcFullTitle)}" aria-label="Scroll to ${esc(srcFullTitle)}">${icons.chevronLeft(13)}</button>`
                  : ""
              }
              <button
                type="button"
                class="dte-io-main-btn"
                data-dte-edit-conn="${esc(c.id)}"
                ${!canEditStructure ? "disabled" : ""}
                title="Edit progression rule from ${esc(srcFullTitle)}"
              >
                <span class="dte-io-target"><strong>${esc(srcTitle)}</strong></span>
                <span class="dte-io-rule mono">${esc(ruleSummary)}</span>
              </button>
              <div class="dte-io-actions">
                ${
                  src
                    ? `<button type="button" class="dte-io-mini-btn" data-dte-jump-round="${esc(src.id)}" title="Scroll to ${esc(srcFullTitle)}" aria-label="Scroll to ${esc(srcFullTitle)}">${icons.chevronLeft(13)}</button>`
                    : ""
                }
                ${
                  canEditStructure && !anyStartedInRound
                    ? `<button type="button" class="dte-io-mini-btn" data-dte-disconnect="${esc(c.id)}" title="Disconnect ${esc(srcFullTitle)}" aria-label="Disconnect">${icons.close(12)}</button>`
                    : ""
                }
              </div>
            </div>
            ${
              invalidText
                ? `<div class="mre-io-invalid-note dte-io-invalid-note" role="status">${esc(invalidText)}</div>`
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
    inRowsHtml = `
      <div class="dte-io-row is-root-seed">
        <button type="button" class="dte-io-mini-btn dte-io-lead-jump" data-dte-jump-round="__pilots__" title="Open Pilots tab" aria-label="Open Pilots tab">${icons.chevronLeft(13)}</button>
        <button
          type="button"
          class="dte-io-main-btn"
          data-dte-open-seeding="${esc(round.id)}"
          ${!canEditStructure ? "disabled" : ""}
          title="Configure initial pilot seeding for ${esc(round.title)}"
        >
          <span class="dte-io-target">${icons.pilot(12)}<strong>Pilots (${activePilots.length})</strong></span>
          <span class="dte-io-rule">${esc(seedModeLabel)}</span>
        </button>
        <div class="dte-io-actions">
          ${
            isRandomSeeded && canEditStructure && !anyStartedInRound
              ? `<button type="button" class="btn btn-ghost btn-xs dte-reshuffle-btn" data-dte-reshuffle="${esc(round.id)}" title="Re-draw random heats">Reshuffle</button>`
              : ""
          }
          <button type="button" class="dte-io-mini-btn" data-dte-jump-round="__pilots__" title="Open Pilots tab" aria-label="Open Pilots tab">${icons.chevronLeft(13)}</button>
        </div>
      </div>`;
  }

  const showOut = round.bracketLane !== "finals" || outConns.length > 0;
  let outSectionHtml = "";
  if (showOut) {
    const outRowsHtml = outConns
      .map((c) => {
        const dst = roundById.get(c.toRoundId);
        const dstTitle = dst ? formatMobileRoundDisplayTitle(dst) : c.toRoundId;
        const dstFullTitle = dst?.title || dstTitle;
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
          <div class="dte-io-item-group">
            <div class="dte-io-row ${c.invalid ? "is-invalid" : ""}">
              ${
                dst
                  ? `<button type="button" class="dte-io-mini-btn dte-io-lead-jump" data-dte-jump-round="${esc(dst.id)}" title="Scroll to ${esc(dstFullTitle)}" aria-label="Scroll to ${esc(dstFullTitle)}">${icons.chevronRight(13)}</button>`
                  : ""
              }
              <button
                type="button"
                class="dte-io-main-btn"
                data-dte-edit-conn="${esc(c.id)}"
                ${!canEditStructure ? "disabled" : ""}
                title="Edit progression rule to ${esc(dstFullTitle)}"
              >
                <span class="dte-io-target"><strong>${esc(dstTitle)}</strong></span>
                <span class="dte-io-rule mono">${esc(ruleSummary)}${c.seededEarly ? " · Seeded" : ""}</span>
              </button>
              <div class="dte-io-actions">
                ${
                  dst
                    ? `<button type="button" class="dte-io-mini-btn" data-dte-jump-round="${esc(dst.id)}" title="Scroll to ${esc(dstFullTitle)}" aria-label="Scroll to ${esc(dstFullTitle)}">${icons.chevronRight(13)}</button>`
                    : ""
                }
                ${
                  canEditStructure && !dstStarted
                    ? `<button type="button" class="dte-io-mini-btn" data-dte-disconnect="${esc(c.id)}" title="Disconnect ${esc(dstFullTitle)}" aria-label="Disconnect">${icons.close(12)}</button>`
                    : ""
                }
              </div>
            </div>
            ${
              c.invalid && c.invalidReason
                ? `<div class="mre-io-invalid-note dte-io-invalid-note" role="status">${esc(cleanConnectionInvalidReason(c.invalidReason) || c.invalidReason)}</div>`
                : ""
            }
            ${
              canSeedNow
                ? `<div class="dte-seed-bar">
                    <span class="note">${confirmedQualHeatsCount} confirmed</span>
                    <button type="button" class="btn btn-armed btn-xs" data-dte-seed-now="${esc(c.id)}">
                      ${icons.zap(11)}<span>Seed ${esc(dstTitle)} Now</span>
                    </button>
                  </div>`
                : canReopenSeed
                  ? `<div class="dte-seed-bar is-seeded">
                      <span class="note">Seeded early</span>
                      <button type="button" class="btn btn-ghost btn-xs" data-dte-reopen-seed="${esc(c.id)}">
                        ${icons.unlock(11)}<span>Reopen</span>
                      </button>
                    </div>`
                  : ""
            }
          </div>`;
      })
      .join("");

    const connectBtnHtml =
      canEditStructure && round.bracketLane !== "finals"
        ? `<button type="button" class="btn btn-ghost btn-xs dte-connect-btn" data-dte-connect-out="${esc(round.id)}">
            ${icons.plus(15)}<span>${outConns.length > 0 ? "Add Output" : "Connect Next Round"}</span>
          </button>`
        : "";

    outSectionHtml = `
      <div class="dte-io-group">
        <span class="dte-io-lbl">OUT</span>
        <div class="dte-io-stack">
          ${outRowsHtml}
          ${connectBtnHtml}
        </div>
      </div>`;
  }

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
      ? `<div class="dte-oq-empty">
          <div class="dte-oq-empty-copy">
            ${icons.zap(16)}
            <div>
              <strong>Dynamic Flight Queue</strong>
              <p class="note">Queue packs on demand from the Queue tab as pilots step up to fly.</p>
            </div>
          </div>
          <button type="button" class="btn btn-armed btn-xs" data-dte-open-queue>
            ${icons.zap(12)}<span>Open Queue Tab</span>
          </button>
        </div>`
      : roundHeats
          .map((heat) =>
            renderDesktopHeatCard(
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

  const footerHtml =
    round.stageFormat === "open_qualifier"
      ? `<div class="dte-col-foot">
          <button type="button" class="btn btn-ghost btn-xs dte-full-btn" data-dte-open-queue>
            ${icons.zap(13)}<span>Manage Flight Queue</span>
          </button>
        </div>`
      : canEditStructure && round.bracketLane !== "finals"
        ? `<div class="dte-col-foot" ${!addHeatCheck.canAdd ? `title="${esc(addHeatCheck.reason)}"` : ""}>
            <button
              type="button"
              class="btn btn-ghost btn-xs dte-full-btn"
              data-dte-add-heat="${esc(round.id)}"
              ${!addHeatCheck.canAdd ? "disabled" : ""}
              title="${esc(addHeatCheck.canAdd ? `Add a heat to ${displayTitle}` : addHeatCheck.reason)}"
            >
              ${icons.plus(13)}<span>Add Heat</span>
            </button>
          </div>`
        : "";

  return `
    <section
      class="card dte-col is-round-col lane-${esc(round.bracketLane || "winners")}"
      data-dte-round-col="${esc(round.id)}"
      aria-label="${esc(round.title)}"
    >
      <header class="dte-col-head dte-round-head">
        <div class="dte-round-head-top">
          <div class="dte-round-title-group">
            <h3 class="dte-round-title" title="${esc(round.title)}">${esc(displayTitle)}</h3>
            <span class="mre-lane-pill ${laneBadge.cls}">${esc(laneBadge.label)}</span>
            <span class="note mono dte-round-pos">${roundIdx + 1}/${totalRounds}</span>
          </div>
          <div class="dte-round-head-btns">
            ${
              canEditStructure
                ? `<button
                    type="button"
                    class="btn btn-ghost btn-xs dte-icon-btn"
                    data-dte-round-settings="${esc(round.id)}"
                    title="Round settings"
                    aria-label="Round settings"
                  >${icons.settings(14)}</button>`
                : ""
            }
            ${
              canEditStructure && !anyStartedInRound
                ? `<button
                    type="button"
                    class="btn btn-ghost btn-xs dte-icon-btn dte-danger-icon"
                    data-dte-delete-round="${esc(round.id)}"
                    title="Delete ${esc(round.title)}"
                    aria-label="Delete ${esc(round.title)}"
                  >${icons.trash(14)}</button>`
                : ""
            }
          </div>
        </div>
        <div class="note dte-round-sub">${esc(timingSub)}</div>
      </header>

      <div class="dte-io-card">
        <div class="dte-io-group">
          <span class="dte-io-lbl">IN</span>
          <div class="dte-io-stack">${inRowsHtml}</div>
        </div>
        ${outSectionHtml}
      </div>

      <div class="dte-heats-section">
        <div class="dte-heats-head">
          <span>Heats (${roundHeats.length})</span>
          ${
            anyStartedInRound
              ? `<span class="note">${roundHeats.filter((h) => h.state === "confirmed").length}/${roundHeats.length} confirmed</span>`
              : ""
          }
        </div>
        <div class="dte-heats-list" data-dte-heats-list data-preserve-scroll="dte-heats:${esc(round.id)}">
          ${heatsCardsHtml}
        </div>
        ${footerHtml}
      </div>
    </section>`;
}

function renderDesktopHeatCard(
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
      <article class="dte-heat-card is-locked">
        <header class="dte-heat-head">
          <div class="dte-heat-head-left">
            <strong class="mono dte-heat-title">${esc(heat.shortLabel)}</strong>
            <span class="race-state-pill ${badge.cls}">${esc(badge.label)}</span>
          </div>
          <div class="dte-heat-head-right">
            <span class="note" title="Heat has started or finished">${icons.lock(12)}</span>
            ${
              canReview
                ? `<button type="button" class="btn btn-ghost btn-xs" data-dte-review-heat="${esc(heat.id)}">
                    <span>Review</span>${icons.chevronRight(12)}
                  </button>`
                : ""
            }
          </div>
        </header>
        <div class="dte-locked-seats">
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
                <div class="dte-locked-seat ${s.pilotSlotIndex <= 0 ? "is-empty" : ""}">
                  <span class="dte-locked-pos mono ${s.position === 1 ? "is-win" : ""}">${esc(posTxt)}</span>
                  <span class="badge mono">${esc(chLbl)}</span>
                  <span class="dte-locked-pilot">
                    ${
                      s.pilotSlotIndex > 0
                        ? `<span class="dot" style="--c:${adaptColorForTheme(s.color)}"></span><strong>${esc(s.callsign)}</strong>${lockedSwapHtml}${s.advances && heat.state === "confirmed" ? `<span class="mre-adv-mark">&#10003;</span>` : ""}`
                        : `${!s.feeder?.isBye && s.sourceLabel && s.sourceLabel !== "Open" && s.sourceLabel !== "Open / BYE" && s.sourceLabel !== "BYE" ? `<span class="dot is-hollow"></span>` : ""}<span class="note">${esc(s.sourceLabel || "Open")}</span>`
                    }
                  </span>
                  <span class="mono note">${esc(metricTxt)}</span>
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
        subFreq: true,
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
        <div
          class="dte-seat-row ${filled ? "is-occupied" : "is-placeholder"}"
          data-drop-heat="${esc(heat.id)}"
          data-drop-seat="${s.seatIndex}"
        >
          <select
            class="input input-sm mono dte-seat-ch-select"
            data-dte-seat-ch
            data-live-safe="1"
            data-heat-id="${esc(heat.id)}"
            data-seat-idx="${s.seatIndex}"
            aria-label="Seat ${s.seatIndex} VTX channel"
          >${chOptions}</select>
          <select
            class="input input-sm dte-seat-pilot-select ${placeholderCls}"
            data-dte-seat-pilot
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
                  class="btn btn-ghost btn-xs dte-seat-unlock-btn"
                  data-dte-unlock-seat
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
    <article class="dte-heat-card">
      <header class="dte-heat-head">
        <div class="dte-heat-head-left">
          <strong class="mono dte-heat-title">${esc(heat.shortLabel)}</strong>
          <span class="race-state-pill ${badge.cls}">${esc(badge.label)}</span>
        </div>
        <div class="dte-heat-head-right">
          ${
            canDeleteHeat
              ? `<button
                  type="button"
                  class="btn btn-ghost btn-xs dte-icon-btn"
                  data-dte-delete-heat="${esc(heat.id)}"
                  title="Delete ${esc(heat.shortLabel)}"
                  aria-label="Delete ${esc(heat.shortLabel)}"
                >${icons.close(13)}</button>`
              : ""
          }
        </div>
      </header>
      <div class="dte-seat-list">
        ${seatRowsHtml}
      </div>
    </article>`;
}

/* ============================================================================
 * Centered Desktop Modals for Connect Next Round & Early Seed Now
 * ========================================================================== */

let activeDteModalCleanup: (() => void) | null = null;

export function closeActiveDesktopTableModal(): void {
  activeDteModalCleanup?.();
}

function mountDesktopModal(
  title: string,
  iconSvg: string,
  bodyHtml: string,
  footHtml: string
): { backdrop: HTMLElement; close: () => void } {
  activeDteModalCleanup?.();

  const backdrop = document.createElement("div");
  backdrop.className = "slaprf-modal-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", title);

  backdrop.innerHTML = `
    <div class="slaprf-modal card rc-modal-md" role="document">
      <div class="slaprf-modal-head">
        <div class="slaprf-modal-title-row">
          <span class="slaprf-modal-icon">${iconSvg}</span>
          <h3>${esc(title)}</h3>
        </div>
        <button type="button" class="btn btn-ghost btn-xs" data-dte-modal-close aria-label="Close">
          ${icons.close(15)}
        </button>
      </div>
      <div class="slaprf-modal-body">${bodyHtml}</div>
      <div class="slaprf-modal-foot">${footHtml}</div>
    </div>`;

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      if (isCustomSelectOpenWithin(backdrop)) {
        e.preventDefault();
        e.stopPropagation();
        closeCustomSelect();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const close = (): void => {
    closeCustomSelect();
    window.removeEventListener("keydown", onKeyDown, true);
    backdrop.remove();
    if (activeDteModalCleanup === close) {
      activeDteModalCleanup = null;
    }
  };
  activeDteModalCleanup = close;

  window.addEventListener("keydown", onKeyDown, true);
  backdrop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (t === backdrop || t.closest("[data-dte-modal-close]")) {
      close();
    }
  });

  document.body.appendChild(backdrop);
  scanCustomSelects(backdrop);
  return { backdrop, close };
}

function openDesktopConnectOutModal(
  fromRound: RaceRound,
  cb: DesktopRaceTableCallbacks
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
      (r) => `<option value="${esc(r.id)}">Existing: ${esc(r.title)}</option>`
    ),
    `<option value="__new:race" ${selectedTarget === "__new:race" ? "selected" : ""}>+ New Race Round</option>`,
    `<option value="__new:losers">+ New Redemption Round</option>`,
    `<option value="__new:points_mains">+ New Points Round</option>`,
    `<option value="__new:qualifying">+ New Qualifier Round</option>`,
    `<option value="__new:finals" ${selectedTarget === "__new:finals" ? "selected" : ""}>+ New Finals Round</option>`,
  ].join("");

  const bodyHtml = `
    <div class="mre-compact-fields">
      <label class="field mre-compact-field">
        <span>Destination Round</span>
        <select class="input" data-dte-target-round>${targetOptionsHtml}</select>
      </label>

      <label class="field mre-compact-field">
        <span>Propagation Rule</span>
        <select class="input" data-dte-rule-mode>
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

      <label class="field mre-compact-field" data-dte-perheat-wrap ${selectedRule === "top_per_heat" || selectedRule === "bottom_per_heat" ? "" : "hidden"}>
        <span>Pilots per heat (1-${maxPerHeat})</span>
        <input type="number" class="input mono" data-dte-perheat-count min="1" max="${maxPerHeat}" value="${Math.min(2, maxPerHeat)}" />
      </label>

      <div class="mre-compact-fields" data-dte-standings-wrap ${selectedRule === "standings_top" ? "" : "hidden"}>
        <div class="mre-compact-grid-2">
          <label class="field mre-compact-field">
            <span>Pilot Cut</span>
            <select class="input" data-dte-cut-kind>
              <option value="all" selected>All Qualified Pilots</option>
              <option value="top_n">Top N Fastest</option>
              <option value="range">Rank Range (#Start - #End)</option>
            </select>
          </label>
          <label class="field mre-compact-field">
            <span>Heat Seeding Fold</span>
            <select class="input" data-dte-fold>
              <option value="snake" selected>Bracket Snake (Fold)</option>
              <option value="sequential">Sequential by Rank</option>
            </select>
          </label>
        </div>
        <label class="field mre-compact-field" data-dte-topn-field hidden>
          <span>Top N Pilots</span>
          <input type="number" class="input mono" data-dte-topn-val min="1" max="64" value="${pph * 2}" />
        </label>
        <div class="field mre-compact-field" data-dte-range-field hidden>
          <span>Rank Range</span>
          <div class="rc-range-pair">
            <div class="rc-range-field">
              <span class="rc-range-prefix">#</span>
              <input type="number" class="input mono" data-dte-range-start min="1" max="64" value="1" />
            </div>
            <span class="rc-range-sep">to</span>
            <div class="rc-range-field">
              <span class="rc-range-prefix">#</span>
              <input type="number" class="input mono" data-dte-range-end min="1" max="64" value="${pph}" />
            </div>
          </div>
        </div>
      </div>
    </div>`;

  const footHtml = `
    <button type="button" class="btn btn-ghost" data-dte-modal-close>Cancel</button>
    <button type="button" class="btn btn-armed" data-dte-connect-save>
      ${icons.link(14)}<span>Connect</span>
    </button>`;

  const { backdrop, close } = mountDesktopModal(
    `Connect From ${fromRound.title}`,
    icons.link(16),
    bodyHtml,
    footHtml
  );

  const syncRuleVis = (): void => {
    const perHeatWrap = backdrop.querySelector<HTMLElement>("[data-dte-perheat-wrap]");
    const stWrap = backdrop.querySelector<HTMLElement>("[data-dte-standings-wrap]");
    const topNField = backdrop.querySelector<HTMLElement>("[data-dte-topn-field]");
    const rangeField = backdrop.querySelector<HTMLElement>("[data-dte-range-field]");
    if (perHeatWrap) {
      perHeatWrap.hidden = selectedRule !== "top_per_heat" && selectedRule !== "bottom_per_heat";
    }
    if (stWrap) stWrap.hidden = selectedRule !== "standings_top";
    if (topNField) topNField.hidden = selectedRule !== "standings_top" || cutKind !== "top_n";
    if (rangeField) rangeField.hidden = selectedRule !== "standings_top" || cutKind !== "range";
    scanCustomSelects(backdrop);
  };

  backdrop.addEventListener("change", (e) => {
    const t = e.target as HTMLElement | null;
    if (!(t instanceof HTMLSelectElement)) return;
    if (t.hasAttribute("data-dte-target-round")) {
      selectedTarget = t.value;
      if (selectedTarget === "__new:losers" && !isFromQual) {
        selectedRule = "bottom_per_heat";
        const rSel = backdrop.querySelector<HTMLSelectElement>("[data-dte-rule-mode]");
        if (rSel) rSel.value = "bottom_per_heat";
        syncRuleVis();
      } else if (selectedTarget === "__new:qualifying" && isFromQual) {
        selectedRule = "all_pilots";
        const rSel = backdrop.querySelector<HTMLSelectElement>("[data-dte-rule-mode]");
        if (rSel) rSel.value = "all_pilots";
        syncRuleVis();
      }
      return;
    }
    if (t.hasAttribute("data-dte-rule-mode")) {
      selectedRule = t.value as RoundConnectionMode;
      syncRuleVis();
      return;
    }
    if (t.hasAttribute("data-dte-cut-kind")) {
      cutKind = t.value as "all" | "top_n" | "range";
      syncRuleVis();
    }
  });

  backdrop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    const saveBtn = t?.closest<HTMLButtonElement>("[data-dte-connect-save]");
    if (!saveBtn || saveBtn.disabled) return;
    saveBtn.disabled = true;

    const perHeatVal = Math.max(
      1,
      Math.min(
        maxPerHeat,
        Number(backdrop.querySelector<HTMLInputElement>("[data-dte-perheat-count]")?.value) || 2
      )
    );
    const foldVal =
      backdrop.querySelector<HTMLSelectElement>("[data-dte-fold]")?.value === "sequential"
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
            Number(backdrop.querySelector<HTMLInputElement>("[data-dte-topn-val]")?.value) || pph
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
            Number(backdrop.querySelector<HTMLInputElement>("[data-dte-range-start]")?.value) || 1
          )
        );
        seedEnd = Math.max(
          seedStart,
          Math.min(
            64,
            Number(backdrop.querySelector<HTMLInputElement>("[data-dte-range-end]")?.value) ||
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
            cb.ui.pendingScrollRoundId = added.id;
            cb.onUiMutated();
          }
          close();
        })
        .catch((err) => {
          saveBtn.disabled = false;
          cb.onError(errText(err));
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
          cb.onError(errText(err));
        });
    }
  });
}

function openDesktopSeedNowModal(
  conn: RoundConnection,
  cb: DesktopRaceTableCallbacks
): void {
  const race = cb.getRace();
  const srcRound = (race.rounds ?? []).find((r) => r.id === conn.fromRoundId);
  const dstRound = (race.rounds ?? []).find((r) => r.id === conn.toRoundId);
  const dstTitle = dstRound?.title || conn.toRoundId;

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
      ? `<div class="mre-sheet-warn" style="margin-top:8px">
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
    <button type="button" class="btn btn-ghost" data-dte-modal-close>Cancel</button>
    <button type="button" class="btn btn-armed" data-dte-confirm-seed-now>
      ${icons.zap(14)}<span>Seed ${esc(dstTitle)} Now</span>
    </button>`;

  const { backdrop, close } = mountDesktopModal(
    `Seed ${dstTitle} Now`,
    icons.zap(16),
    bodyHtml,
    footHtml
  );

  backdrop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    const btn = t?.closest<HTMLButtonElement>("[data-dte-confirm-seed-now]");
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    void cb.api
      .bracketEdit({
        action: "seed_connection_now",
        connectionId: conn.id,
      })
      .then(() => {
        if (dstRound) {
          cb.ui.pendingScrollRoundId = dstRound.id;
          cb.onUiMutated();
        }
        close();
      })
      .catch((err) => {
        btn.disabled = false;
        cb.onError(errText(err));
      });
  });
}

/* ============================================================================
 * Event Delegation, Add Round, & Horizontal Scrub / Cue Sync
 * ========================================================================== */

function addConstructFromDesktopTable(
  kind: MobileConstructKind,
  cb: DesktopRaceTableCallbacks
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
        cb.ui.pendingScrollRoundId = added.id;
        cb.onUiMutated();
      }
    })
    .catch((err) => cb.onError(errText(err)));
}

function scrollRoundColIntoView(root: ParentNode, roundId: string, flash = false): void {
  const scroller = root.querySelector<HTMLElement>("[data-dte-scroll]");
  const col =
    roundId === "__pilots__"
      ? root.querySelector<HTMLElement>("[data-dte-pilots-col]")
      : root.querySelector<HTMLElement>(`[data-dte-round-col="${CSS.escape(roundId)}"]`);
  if (!scroller || !col) return;
  const targetLeft =
    roundId === "__pilots__"
      ? 0
      : Math.max(
          0,
          col.offsetLeft - scroller.offsetLeft - Math.max(16, (scroller.clientWidth - col.offsetWidth) / 2)
        );
  scroller.scrollTo({ left: targetLeft, behavior: "smooth" });
  if (flash) {
    col.classList.remove("is-jump-highlight");
    void col.offsetWidth;
    col.classList.add("is-jump-highlight");
    window.setTimeout(() => col.classList.remove("is-jump-highlight"), 1100);
  }
}

let cleanupDteScrub: (() => void) | null = null;

function syncDesktopTableScrollCues(root: ParentNode): void {
  const dteRoot =
    root instanceof HTMLElement && root.hasAttribute("data-dte-root")
      ? root
      : root.querySelector<HTMLElement>("[data-dte-root]");
  if (!dteRoot) return;
  const scroller = dteRoot.querySelector<HTMLElement>("[data-dte-scroll]");
  const leftCue = dteRoot.querySelector<HTMLButtonElement>('[data-dte-scroll-dir="-1"]');
  const rightCue = dteRoot.querySelector<HTMLButtonElement>('[data-dte-scroll-dir="1"]');
  if (!scroller) return;

  const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  const hasOverflow = maxScroll > 6;
  if (leftCue) {
    leftCue.hidden = !hasOverflow || scroller.scrollLeft <= 4;
  }
  if (rightCue) {
    rightCue.hidden = !hasOverflow || scroller.scrollLeft >= maxScroll - 4;
  }
}

export function syncDesktopTableAfterRender(
  root: ParentNode,
  ui: DesktopRaceTableUiState
): void {
  cleanupDteScrub?.();
  cleanupDteScrub = null;

  const dteRoot = root.querySelector<HTMLElement>("[data-dte-root]");
  if (!dteRoot) return;
  scanCustomSelects(dteRoot);

  const scroller = dteRoot.querySelector<HTMLElement>("[data-dte-scroll]");
  if (!scroller) return;

  const syncCues = (): void => syncDesktopTableScrollCues(dteRoot);

  syncCues();

  if (ui.pendingScrollHeatsBottomRoundId) {
    const heatRoundId = ui.pendingScrollHeatsBottomRoundId;
    ui.pendingScrollHeatsBottomRoundId = "";
    const col = dteRoot.querySelector<HTMLElement>(
      `[data-dte-round-col="${CSS.escape(heatRoundId)}"]`
    );
    const heatsList = col?.querySelector<HTMLElement>("[data-dte-heats-list]");
    if (heatsList) {
      heatsList.scrollTop = heatsList.scrollHeight;
    }
  }

  if (ui.pendingScrollRoundId) {
    const targetId = ui.pendingScrollRoundId;
    ui.pendingScrollRoundId = "";
    requestAnimationFrame(() => {
      scrollRoundColIntoView(dteRoot, targetId, true);
      syncCues();
    });
  }

  const onScroll = (): void => syncCues();
  const onResize = (): void => syncCues();

  // Allow grabbing empty background or non-interactive areas to scrub horizontally with inertial momentum
  let dragStartX: number | null = null;
  let dragStartScrollLeft = 0;
  let isScrubbing = false;
  let momentumRafId = 0;
  let dragSamples: Array<{ x: number; t: number }> = [];

  const cancelMomentum = (): void => {
    if (momentumRafId) {
      window.cancelAnimationFrame(momentumRafId);
      momentumRafId = 0;
    }
    scroller.classList.remove("is-coasting");
  };

  const nowMs = (): number =>
    typeof performance !== "undefined" ? performance.now() : Date.now();

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (!t.closest("[data-dte-board-wrap], [data-dte-nav-gap]")) return;
    if (
      t.closest(
        "button, input, select, textarea, a, label, .custom-select-wrap, [draggable='true']"
      )
    ) {
      cancelMomentum();
      const btn = t.closest("button");
      if (btn && scroller.contains(btn)) {
        // Prevent browser focus-into-view from shifting .dte-board-scroll horizontally
        e.preventDefault();
      }
      return;
    }
    const heatsList = t.closest<HTMLElement>("[data-dte-heats-list]");
    if (heatsList && e.clientX >= heatsList.getBoundingClientRect().left + heatsList.clientWidth) {
      return;
    }
    const pilotsList = t.closest<HTMLElement>("[data-rc-pilots-results]");
    if (pilotsList && e.clientX >= pilotsList.getBoundingClientRect().left + pilotsList.clientWidth) {
      return;
    }
    cancelMomentum();
    dragStartX = e.clientX;
    dragStartScrollLeft = scroller.scrollLeft;
    isScrubbing = false;
    dragSamples = [{ x: e.clientX, t: nowMs() }];
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (dragStartX === null) return;
    const dx = e.clientX - dragStartX;
    if (!isScrubbing && Math.abs(dx) > 4) {
      isScrubbing = true;
      scroller.classList.add("is-scrubbing");
      dteRoot.classList.add("is-scrubbing");
    }
    if (isScrubbing) {
      scroller.scrollLeft = dragStartScrollLeft - dx;
      const now = nowMs();
      dragSamples.push({ x: e.clientX, t: now });
      while (dragSamples.length > 2 && now - dragSamples[0].t > 100) {
        dragSamples.shift();
      }
      syncCues();
    }
  };

  const onPointerUp = (): void => {
    if (dragStartX === null) return;
    dragStartX = null;
    if (isScrubbing) {
      isScrubbing = false;
      scroller.classList.remove("is-scrubbing");
      dteRoot.classList.remove("is-scrubbing");

      const now = nowMs();
      const last = dragSamples[dragSamples.length - 1];
      if (last && dragSamples.length >= 2 && now - last.t < 75) {
        let first = dragSamples[0];
        for (let i = 0; i < dragSamples.length - 1; i++) {
          if (last.t - dragSamples[i].t <= 95) {
            first = dragSamples[i];
            break;
          }
        }
        const dt = Math.max(8, last.t - first.t);
        const vx = (first.x - last.x) / dt; // scrollLeft px per ms
        let velPxPerFrame = vx * 16.67;
        const speed = Math.abs(vx);
        if (speed > 0.65) {
          // Natural throw acceleration boost on fast flicks
          velPxPerFrame *= 1 + Math.min(0.75, (speed - 0.65) * 0.42);
        }
        velPxPerFrame = Math.max(-96, Math.min(96, velPxPerFrame));

        if (Math.abs(velPxPerFrame) >= 1.1) {
          scroller.classList.add("is-coasting");
          let lastFrameT = now;
          const stepMomentum = (frameNow: number): void => {
            const frameDt = Math.min(48, Math.max(4, frameNow - lastFrameT));
            lastFrameT = frameNow;
            const frames = frameDt / 16.67;
            const prevLeft = scroller.scrollLeft;
            const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
            const nextLeft = Math.max(0, Math.min(maxScroll, prevLeft + velPxPerFrame * frames));
            scroller.scrollLeft = nextLeft;
            syncCues();
            velPxPerFrame *= Math.pow(0.945, frames);
            const hitEdge =
              (nextLeft <= 0.5 && velPxPerFrame < 0) ||
              (nextLeft >= maxScroll - 0.5 && velPxPerFrame > 0);
            if (Math.abs(velPxPerFrame) < 0.45 || hitEdge) {
              cancelMomentum();
              return;
            }
            momentumRafId = window.requestAnimationFrame(stepMomentum);
          };
          momentumRafId = window.requestAnimationFrame(stepMomentum);
        }
      }
      dragSamples = [];
    }
  };

  const onWheel = (): void => {
    if (momentumRafId) cancelMomentum();
  };

  scroller.addEventListener("scroll", onScroll, { passive: true });
  scroller.addEventListener("wheel", onWheel, { passive: true });
  dteRoot.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("resize", onResize);

  cleanupDteScrub = () => {
    cancelMomentum();
    scroller.removeEventListener("scroll", onScroll);
    scroller.removeEventListener("wheel", onWheel);
    dteRoot.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    window.removeEventListener("resize", onResize);
  };
}

export function handleDesktopRaceTableClick(
  e: Event,
  root: ParentNode,
  cb: DesktopRaceTableCallbacks
): boolean {
  const target = e.target as HTMLElement | null;
  if (!target || (!target.closest("[data-dte-root]") && !target.closest("[data-dte-race-summary]"))) {
    return false;
  }

  const scrollCueBtn = target.closest<HTMLButtonElement>("[data-dte-scroll-dir]");
  if (scrollCueBtn) {
    if (scrollCueBtn.disabled) return true;
    const dir = Number(scrollCueBtn.dataset.dteScrollDir) || 1;
    const scroller = root.querySelector<HTMLElement>("[data-dte-scroll]");
    if (scroller) {
      const step = Math.max(300, Math.round(scroller.clientWidth * 0.65));
      scroller.scrollBy({ left: dir * step, behavior: "smooth" });
    }
    return true;
  }

  if (target.closest("[data-dte-toggle-pilots]")) {
    cb.ui.pilotsCollapsed = !cb.ui.pilotsCollapsed;
    persistDesktopTablePilotsCollapsed(cb.ui.pilotsCollapsed);
    const pilotsCol = root.querySelector<HTMLElement>("[data-dte-pilots-col]");
    if (pilotsCol) {
      pilotsCol.classList.toggle("is-collapsed", cb.ui.pilotsCollapsed);
      pilotsCol.setAttribute(
        "aria-label",
        cb.ui.pilotsCollapsed ? "Checked-In Pilots (collapsed)" : "Checked-In Pilots"
      );
      requestAnimationFrame(() => syncDesktopTableScrollCues(root));
      window.setTimeout(() => syncDesktopTableScrollCues(root), 280);
      return true;
    }
    cb.onUiMutated();
    return true;
  }

  if (target.closest("[data-dte-open-templates]")) {
    cb.onOpenTemplates();
    return true;
  }

  if (target.closest("[data-dte-open-defaults]")) {
    openRaceSettingsModal({
      getRace: cb.getRace,
      getAllTags: cb.getAllTags,
      api: cb.api,
      onError: cb.onError,
    });
    return true;
  }

  if (target.closest("[data-dte-open-queue]")) {
    cb.onOpenControlQueue();
    return true;
  }

  const reviewBtn = target.closest<HTMLButtonElement>("[data-dte-review-heat]");
  if (reviewBtn) {
    const hid = reviewBtn.dataset.dteReviewHeat || "";
    if (hid) cb.onOpenReviewHeat(hid);
    return true;
  }

  const jumpBtn = target.closest<HTMLButtonElement>("[data-dte-jump-round]");
  if (jumpBtn) {
    const rid = jumpBtn.dataset.dteJumpRound || "";
    if (rid === "__pilots__") {
      cb.onOpenPilotsTab();
      return true;
    }
    if (rid) scrollRoundColIntoView(root, rid, true);
    return true;
  }

  const addRoundBtn = target.closest<HTMLButtonElement>("[data-dte-add-round]");
  if (addRoundBtn && !addRoundBtn.disabled) {
    const kind = (addRoundBtn.dataset.dteAddRound || "race") as MobileConstructKind;
    addConstructFromDesktopTable(kind, cb);
    return true;
  }

  const roundSettingsBtn = target.closest<HTMLButtonElement>("[data-dte-round-settings]");
  if (roundSettingsBtn) {
    const rid = roundSettingsBtn.dataset.dteRoundSettings || "";
    const race = cb.getRace();
    const round = (race.rounds ?? []).find((r) => r.id === rid);
    if (round) {
      const heats = (race.heats ?? []).filter((h) => h.roundId === round.id);
      openRoundCustomizeModal({
        round,
        heats,
        race,
        raceConfig: race.config,
        api: cb.api,
        onError: cb.onError,
      });
    }
    return true;
  }

  const delRoundBtn = target.closest<HTMLButtonElement>("[data-dte-delete-round]");
  if (delRoundBtn && !delRoundBtn.disabled) {
    const rid = delRoundBtn.dataset.dteDeleteRound || "";
    const race = cb.getRace();
    const round = (race.rounds ?? []).find((r) => r.id === rid);
    if (!round) return true;
    const doDelete = () =>
      cb.api
        .bracketEdit({ action: "delete_round", roundId: round.id })
        .catch((err) => cb.onError(errText(err)));

    if (roundNeedsDeleteConfirmation(race, round.id)) {
      openConfirmModal({
        title: `Delete ${round.title}?`,
        messageHtml: `<p>Remove <strong>${esc(round.title)}</strong> and disconnect its progression rules?</p>`,
        confirmLabel: "Delete Round",
        danger: true,
        onConfirm: doDelete,
      });
    } else {
      void doDelete();
    }
    return true;
  }

  const seedingBtn = target.closest<HTMLButtonElement>("[data-dte-open-seeding]");
  if (seedingBtn && !seedingBtn.disabled) {
    const rid = seedingBtn.dataset.dteOpenSeeding || "";
    const race = cb.getRace();
    const round = (race.rounds ?? []).find((r) => r.id === rid);
    if (round) {
      const pilotsConn = (race.connections ?? []).find(
        (c) =>
          c.toRoundId === round.id &&
          (c.mode === "pilots_in" || isPilotsInRoundId(c.fromRoundId))
      );
      const cid =
        pilotsConn?.id || `conn-stage${round.stageIndex || 1}-pilots-in-${round.id}`;
      openWireConnectionModal({
        connectionId: cid,
        getRace: cb.getRace,
        api: cb.api,
        onError: cb.onError,
      });
    }
    return true;
  }

  const reshuffleBtn = target.closest<HTMLButtonElement>("[data-dte-reshuffle]");
  if (reshuffleBtn && !reshuffleBtn.disabled) {
    const rid = reshuffleBtn.dataset.dteReshuffle || "";
    if (rid) {
      void cb.api
        .bracketEdit({ action: "reshuffle_round", roundId: rid })
        .catch((err) => cb.onError(errText(err)));
    }
    return true;
  }

  const editConnBtn = target.closest<HTMLButtonElement>("[data-dte-edit-conn]");
  if (editConnBtn && !editConnBtn.disabled) {
    const cid = editConnBtn.dataset.dteEditConn || "";
    if (cid) {
      openWireConnectionModal({
        connectionId: cid,
        getRace: cb.getRace,
        api: cb.api,
        onError: cb.onError,
      });
    }
    return true;
  }

  const disconnectBtn = target.closest<HTMLButtonElement>("[data-dte-disconnect]");
  if (disconnectBtn && !disconnectBtn.disabled) {
    const cid = disconnectBtn.dataset.dteDisconnect || "";
    if (cid) {
      void cb.api
        .bracketEdit({ action: "disconnect_rounds", connectionId: cid })
        .catch((err) => cb.onError(errText(err)));
    }
    return true;
  }

  const connectOutBtn = target.closest<HTMLButtonElement>("[data-dte-connect-out]");
  if (connectOutBtn && !connectOutBtn.disabled) {
    const rid = connectOutBtn.dataset.dteConnectOut || "";
    const fromRound = (cb.getRace().rounds ?? []).find((r) => r.id === rid);
    if (fromRound) {
      openDesktopConnectOutModal(fromRound, cb);
    }
    return true;
  }

  const seedNowBtn = target.closest<HTMLButtonElement>("[data-dte-seed-now]");
  if (seedNowBtn && !seedNowBtn.disabled) {
    const cid = seedNowBtn.dataset.dteSeedNow || "";
    const conn = (cb.getRace().connections ?? []).find((c) => c.id === cid);
    if (conn) {
      openDesktopSeedNowModal(conn, cb);
    }
    return true;
  }

  const reopenSeedBtn = target.closest<HTMLButtonElement>("[data-dte-reopen-seed]");
  if (reopenSeedBtn && !reopenSeedBtn.disabled) {
    const cid = reopenSeedBtn.dataset.dteReopenSeed || "";
    if (cid) {
      void cb.api
        .bracketEdit({ action: "reopen_connection_seed", connectionId: cid })
        .catch((err) => cb.onError(errText(err)));
    }
    return true;
  }

  const addHeatBtn = target.closest<HTMLButtonElement>("[data-dte-add-heat]");
  if (addHeatBtn && !addHeatBtn.disabled) {
    const rid = addHeatBtn.dataset.dteAddHeat || "";
    if (rid) {
      cb.ui.pendingScrollHeatsBottomRoundId = rid;
      void cb.api
        .bracketEdit({ action: "add_heat", roundId: rid })
        .catch((err) => cb.onError(errText(err)));
    }
    return true;
  }

  const delHeatBtn = target.closest<HTMLButtonElement>("[data-dte-delete-heat]");
  if (delHeatBtn && !delHeatBtn.disabled) {
    const hid = delHeatBtn.dataset.dteDeleteHeat || "";
    if (hid) {
      void cb.api
        .bracketEdit({ action: "delete_heat", heatId: hid })
        .catch((err) => cb.onError(errText(err)));
    }
    return true;
  }

  const unlockSeatBtn = target.closest<HTMLButtonElement>("[data-dte-unlock-seat]");
  if (unlockSeatBtn && !unlockSeatBtn.disabled) {
    const heatId = unlockSeatBtn.dataset.heatId || "";
    const seatIndex = Number(unlockSeatBtn.dataset.seatIdx) || 0;
    if (heatId && seatIndex > 0) {
      void cb.api
        .bracketEdit({ action: "unlock_seat", heatId, seatIndex })
        .catch((err) => cb.onError(errText(err)));
    }
    return true;
  }

  return false;
}

export function handleDesktopRaceTableChange(
  e: Event,
  cb: DesktopRaceTableCallbacks
): boolean {
  const target = e.target as HTMLElement | null;
  if (!target || !target.closest("[data-dte-root]")) return false;

  if (
    target instanceof HTMLInputElement &&
    target.hasAttribute("data-dte-toggle-connect-prev")
  ) {
    cb.ui.connectToPreviousOnAdd = target.checked;
    return true;
  }

  if (target instanceof HTMLSelectElement) {
    if (target.hasAttribute("data-dte-seat-ch")) {
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
          .catch((err) => cb.onError(errText(err)));
      }
      return true;
    }

    if (target.hasAttribute("data-dte-seat-pilot")) {
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
          .catch((err) => cb.onError(errText(err)));
      } else {
        void cb.api
          .bracketEdit({
            action: "assign_pilot_seat",
            heatId,
            seatIndex,
            pilotSlotIndex,
          })
          .catch((err) => cb.onError(errText(err)));
      }
      return true;
    }
  }

  return false;
}
