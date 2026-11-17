import { esc } from "../core/format";
import { icons } from "../core/icons";
import {
  buildMultiBandCanvasOptions,
  decodeBandChannel,
  formatEncodedChannelShort,
  isValidEncodedSeatChannel,
} from "../core/vtx_channels";
import { ApiClient } from "../services/api_client";
import {
  FinalsFormat,
  QualifyingMetric,
  RaceRound,
  RaceSetupConfig,
  RaceStage,
  RaceTournamentState,
  RoundConnectionMode,
  StageConnectionMode,
  StageFormat,
  StartMode,
} from "../types/models";
import {
  anyDownstreamStageStarted,
  effectiveStageSeedCount,
  isHandoffInRoundId,
  isHandoffOutRoundId,
  isHandoffPortalRound,
  isHeatUnstarted,
} from "./BracketDiagram";
import {
  CanvasSelectChangeDetail,
  CanvasSelectOption,
  closeCanvasSelectPopover,
  ensureCanvasSelectGlobalBinding,
  renderCanvasSelect,
} from "./CanvasSelect";
import { mountTagPillEditor, renderTagPillBoxHtml } from "./TagPillEditor";
import {
  notifyNewlyInvalidConnections,
  notifyNewlyInvalidStageConnections,
} from "./Toast";

let activeCustomModalCleanup: (() => void) | null = null;

export function closeActiveRoundModal(): void {
  activeCustomModalCleanup?.();
}

function mountModalShell(
  title: string,
  iconSvg: string,
  sizeCls: "rc-modal-md" | "rc-modal-lg" | "rc-modal-xl",
  bodyHtml: string,
  footHtml: string
): { backdrop: HTMLElement; close: () => void } {
  if (activeCustomModalCleanup) {
    activeCustomModalCleanup();
  }

  const backdrop = document.createElement("div");
  backdrop.className = "slaprf-modal-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", title);

  backdrop.innerHTML = `
    <div class="slaprf-modal card ${sizeCls}" role="document">
      <div class="slaprf-modal-head">
        <div class="slaprf-modal-title-row">
          <span class="slaprf-modal-icon">${iconSvg}</span>
          <h3>${esc(title)}</h3>
        </div>
        <button type="button" class="btn btn-ghost btn-xs" data-rc-modal-close aria-label="Close">
          ${icons.close(15)}
        </button>
      </div>
      <div class="slaprf-modal-body">${bodyHtml}</div>
      ${footHtml ? `<div class="slaprf-modal-foot">${footHtml}</div>` : ""}
    </div>
  `;

  const close = (): void => {
    closeCanvasSelectPopover();
    window.removeEventListener("keydown", onKeyDown, true);
    if (backdrop.parentNode) {
      backdrop.parentNode.removeChild(backdrop);
    }
    if (activeCustomModalCleanup === close) {
      activeCustomModalCleanup = null;
    }
  };
  activeCustomModalCleanup = close;
  ensureCanvasSelectGlobalBinding();

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      if (document.querySelector("[data-cselect-popover]")) {
        e.preventDefault();
        e.stopPropagation();
        closeCanvasSelectPopover();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  window.addEventListener("keydown", onKeyDown, true);

  backdrop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (t === backdrop || t.closest("[data-rc-modal-close]")) {
      close();
    }
  });

  document.body.appendChild(backdrop);
  return { backdrop, close };
}

/* ============================================================================
 * 1. Customize Round Modal (Title, Role, Format, Start, Laps, Time, Finals Rules)
 * ========================================================================== */

export interface RoundCustomizeModalOptions {
  round: RaceRound;
  heats: RaceHeat[];
  incomingCount?: number;
  race?: RaceTournamentState;
  raceConfig?: RaceSetupConfig;
  api: ApiClient;
  onError?: (msg: string) => void;
}

function describeFinalsWinnerRule(
  fmt: FinalsFormat,
  aceWins: number,
  winnersAdv: boolean,
  seriesHeats: number
): string {
  if (fmt === "chase_the_ace") {
    const advClause = winnersAdv
      ? " Winners Bracket #1 enters with +1 starting Ace win."
      : "";
    return `Finalists face each other in repeat heats inside this Finals round until one contender reaches ${aceWins} heat wins to claim Champion.${advClause}`;
  }
  if (fmt === "points_final") {
    return `The same group of finalists races ${seriesHeats} Championship heats head-to-head; highest cumulative points across the Finals series wins Champion.`;
  }
  return "Single Championship heat (GF-1) where all finalists face off; 1st place across the line claims Race Champion.";
}

export function openRoundCustomizeModal(opts: RoundCustomizeModalOptions): void {
  const { round, heats, race, api, onError } = opts;
  const cfg = opts.raceConfig ?? race?.config;
  const reportError = (msg: string): void => {
    if (onError) onError(msg);
  };
  const startedCount = heats.filter((h) => !isHeatUnstarted(h.state)).length;
  const anyStarted = startedCount > 0;
  let curLane =
    round.bracketLane === "main" || round.bracketLane === "mains"
      ? "winners"
      : round.bracketLane || "winners";
  let curStart: StartMode =
    round.startMode ??
    (round.stageFormat === "qualifying" ? "staggered" : "heads_up");
  let curFormat: StageFormat =
    round.stageFormat === "qualifying"
      ? "qualifying"
      : round.stageFormat === "points_mains"
        ? "points_mains"
        : "single_elimination";
  // Show the heat count actually planned (the engine may hold it below the requested target so every
  // heat can still eliminate someone); fall back to the requested target for rounds with no heats yet.
  const curHeatCount = Math.max(1, heats.length || round.targetHeats || 1);

  const otherFinalsInStage = (race?.rounds ?? []).find(
    (r) =>
      r.stageIndex === round.stageIndex &&
      r.bracketLane === "finals" &&
      r.id !== round.id &&
      !isHandoffPortalRound(r)
  );

  let curFinalsFormat: FinalsFormat =
    round.finalsFormat ||
    (cfg?.finalsFormat === "chase_the_ace" || cfg?.finalsFormat === "points_final"
      ? cfg.finalsFormat
      : "single_final");
  const curAceWins = Math.max(
    2,
    Math.min(5, round.aceWinsRequired || cfg?.aceWinsRequired || 2)
  );
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

  const laneOptions: CanvasSelectOption[] = [
    { value: "winners", label: "Race / Upper Bracket" },
    { value: "losers", label: "Redemption / Lower Bracket" },
    { value: "qualifying", label: "Qualifying" },
    {
      value: "finals",
      label: otherFinalsInStage
        ? `Finals (Used by ${otherFinalsInStage.title})`
        : "Championship Finals (1 group)",
      disabled: !!otherFinalsInStage,
    },
  ];

  const formatOptions: CanvasSelectOption[] = [
    { value: "single_elimination", label: "Head-to-Head Race" },
    { value: "qualifying", label: "Timed Qualifying" },
    { value: "points_mains", label: "Points Mains" },
  ];

  const startOptions: CanvasSelectOption[] = [
    { value: "heads_up", label: "Heads-up Horn Start" },
    { value: "staggered", label: "Staggered Gate Pass Start" },
  ];

  const finalsFmtOptions: CanvasSelectOption[] = [
    { value: "single_final", label: "Single Heat Final" },
    { value: "chase_the_ace", label: "Chase the Ace Final" },
    { value: "points_final", label: "Points Series Final" },
  ];

  const renderLaneSelect = (): string =>
    renderCanvasSelect({
      value: curLane,
      label: laneOptions.find((o) => o.value === curLane)?.label ?? "Race / Upper Bracket",
      options: laneOptions,
      disabled: anyStarted,
      dataAttrs: "data-round-lane",
      title: "Round role / bracket lane",
    });

  const renderFormatSelect = (): string =>
    renderCanvasSelect({
      value: curFormat,
      label: formatOptions.find((o) => o.value === curFormat)?.label ?? "Head-to-Head Race",
      options: formatOptions,
      disabled: anyStarted,
      dataAttrs: "data-round-format",
      title: "Round scoring format",
    });

  const renderStartSelect = (): string =>
    renderCanvasSelect({
      value: curStart,
      label: startOptions.find((o) => o.value === curStart)?.label ?? "Heads-up Horn Start",
      options: startOptions,
      disabled: anyStarted,
      dataAttrs: "data-round-start",
      title: "Heat start signal",
    });

  const renderFinalsFmtSelect = (): string =>
    renderCanvasSelect({
      value: curFinalsFormat,
      label: finalsFmtOptions.find((o) => o.value === curFinalsFormat)?.label ?? "Single Heat Final",
      options: finalsFmtOptions,
      disabled: anyStarted,
      dataAttrs: "data-round-finals-fmt",
      title: "Championship Finals format",
    });

  const isInitiallyFinals = curLane === "finals";

  const bodyHtml = `
    <div class="rc-settings-list">
      <div class="rc-setting-row">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Round name</span>
          <span class="rc-setting-desc">Label displayed on this round card and heat schedule.</span>
        </div>
        <div class="rc-setting-control">
          <input
            type="text"
            class="input"
            data-modal-field="title"
            value="${esc(round.title)}"
            maxlength="48"
            placeholder="e.g. Winners R1, Redemption R2, Finals…"
          />
        </div>
      </div>

      <div class="rc-setting-row">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Round role</span>
          <span class="rc-setting-desc">Bracket lane used for seeding, drops, and finals progression.</span>
        </div>
        <div class="rc-setting-control" data-round-lane-wrap>${renderLaneSelect()}</div>
      </div>

      <div class="rc-setting-row" data-standard-only ${isInitiallyFinals ? "hidden" : ""}>
        <div class="rc-setting-info">
          <span class="rc-setting-title">Scoring format</span>
          <span class="rc-setting-desc">How heats in this round score and rank pilots.</span>
        </div>
        <div class="rc-setting-control" data-round-format-wrap>${renderFormatSelect()}</div>
      </div>

      <div class="rc-setting-row" data-standard-only ${isInitiallyFinals ? "hidden" : ""}>
        <div class="rc-setting-info">
          <span class="rc-setting-title">Number of heats</span>
          <span class="rc-setting-desc">Total heats scheduled in this round.</span>
        </div>
        <div class="rc-setting-control">
          <input
            type="number"
            class="input mono"
            data-modal-field="heatCount"
            min="${Math.max(1, startedCount)}"
            max="16"
            value="${curHeatCount}"
          />
        </div>
      </div>

      <div class="rc-setting-row is-top-aligned" data-finals-only ${isInitiallyFinals ? "" : "hidden"}>
        <div class="rc-setting-info">
          <span class="rc-setting-title">Finals format</span>
          <span class="rc-setting-desc" data-finals-rule-desc>
            ${esc(describeFinalsWinnerRule(curFinalsFormat, curAceWins, curWinnersAdv, curFinalsHeats))}
          </span>
        </div>
        <div class="rc-setting-control" data-round-finals-fmt-wrap>${renderFinalsFmtSelect()}</div>
      </div>

      <div class="rc-setting-row" data-finals-cta-only ${isInitiallyFinals && curFinalsFormat === "chase_the_ace" ? "" : "hidden"}>
        <div class="rc-setting-info">
          <span class="rc-setting-title">Ace wins required</span>
          <span class="rc-setting-desc">Heat wins required by a finalist to claim Race Champion.</span>
        </div>
        <div class="rc-setting-control">
          <input
            type="number"
            class="input mono"
            data-modal-field="aceWinsRequired"
            min="2"
            max="5"
            value="${curAceWins}"
            ${anyStarted ? "disabled" : ""}
          />
        </div>
      </div>

      <div class="rc-setting-row" data-finals-cta-only ${isInitiallyFinals && curFinalsFormat === "chase_the_ace" ? "" : "hidden"}>
        <div class="rc-setting-info">
          <span class="rc-setting-title">Winners-bracket advantage</span>
          <span class="rc-setting-desc">Winners Bracket #1 enters Finals with +1 starting Ace win.</span>
        </div>
        <div class="rc-setting-control is-end">
          <label class="switch">
            <input
              type="checkbox"
              data-modal-field="winnersAdvantageAce"
              ${curWinnersAdv ? "checked" : ""}
              ${anyStarted ? "disabled" : ""}
            />
            <span></span>
          </label>
        </div>
      </div>

      <div class="rc-setting-row" data-finals-pts-only ${isInitiallyFinals && curFinalsFormat === "points_final" ? "" : "hidden"}>
        <div class="rc-setting-info">
          <span class="rc-setting-title">Finals series heats</span>
          <span class="rc-setting-desc">Number of head-to-head Championship heats in the points series.</span>
        </div>
        <div class="rc-setting-control">
          <input
            type="number"
            class="input mono"
            data-modal-field="finalsHeats"
            min="2"
            max="7"
            value="${curFinalsHeats}"
            ${anyStarted ? "disabled" : ""}
          />
        </div>
      </div>

      <div class="rc-setting-row">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Start signal</span>
          <span class="rc-setting-desc">Simultaneous horn start or staggered first-gate pass clock.</span>
        </div>
        <div class="rc-setting-control" data-round-start-wrap>${renderStartSelect()}</div>
      </div>

      <div class="rc-setting-row">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Target laps</span>
          <span class="rc-setting-desc">Laps required to finish each heat (0 = unlimited within time limit).</span>
        </div>
        <div class="rc-setting-control">
          <input
            type="number"
            class="input mono"
            data-modal-field="targetLaps"
            min="0"
            max="99"
            value="${round.targetLaps}"
            ${anyStarted ? "disabled" : ""}
          />
        </div>
      </div>

      <div class="rc-setting-row">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Time limit</span>
          <span class="rc-setting-desc">Maximum heat duration in seconds before time expires.</span>
        </div>
        <div class="rc-setting-control">
          <input
            type="number"
            class="input mono"
            data-modal-field="timeLimitSec"
            min="15"
            max="3600"
            step="5"
            value="${round.timeLimitSec}"
            ${anyStarted ? "disabled" : ""}
          />
        </div>
      </div>
    </div>
    ${
      anyStarted
        ? `<div class="rc-settings-info-note">
            ${icons.about(14)}
            <span>Heats in this round have already started — round name and adding heats remain available; scoring rules on started heats are locked unless reset.</span>
          </div>`
        : ""
    }
  `;

  const footHtml = `
    <button type="button" class="btn btn-ghost" data-rc-modal-close>Cancel</button>
    <button type="button" class="btn btn-armed" data-modal-save>
      ${icons.check(15)}<span>Save</span>
    </button>
  `;

  const { backdrop, close } = mountModalShell(
    `Round Settings · “${round.title}”`,
    icons.sliders(17),
    "rc-modal-md",
    bodyHtml,
    footHtml
  );

  const titleInp = backdrop.querySelector<HTMLInputElement>('[data-modal-field="title"]');
  const laneWrap = backdrop.querySelector<HTMLElement>("[data-round-lane-wrap]")!;
  const fmtWrap = backdrop.querySelector<HTMLElement>("[data-round-format-wrap]")!;
  const startWrap = backdrop.querySelector<HTMLElement>("[data-round-start-wrap]")!;
  const finalsFmtWrap = backdrop.querySelector<HTMLElement>("[data-round-finals-fmt-wrap]")!;
  const lapsInp = backdrop.querySelector<HTMLInputElement>('[data-modal-field="targetLaps"]');
  const aceWinsInp = backdrop.querySelector<HTMLInputElement>('[data-modal-field="aceWinsRequired"]');
  const winnersAdvChk = backdrop.querySelector<HTMLInputElement>(
    '[data-modal-field="winnersAdvantageAce"]'
  );
  const finalsHeatsInp = backdrop.querySelector<HTMLInputElement>('[data-modal-field="finalsHeats"]');
  const finalsRuleDesc = backdrop.querySelector<HTMLElement>("[data-finals-rule-desc]");

  const syncFinalsVisibility = (): void => {
    const isFinals = curLane === "finals";
    backdrop.querySelectorAll<HTMLElement>("[data-standard-only]").forEach((el) => {
      el.hidden = isFinals;
    });
    backdrop.querySelectorAll<HTMLElement>("[data-finals-only]").forEach((el) => {
      el.hidden = !isFinals;
    });
    backdrop.querySelectorAll<HTMLElement>("[data-finals-cta-only]").forEach((el) => {
      el.hidden = !isFinals || curFinalsFormat !== "chase_the_ace";
    });
    backdrop.querySelectorAll<HTMLElement>("[data-finals-pts-only]").forEach((el) => {
      el.hidden = !isFinals || curFinalsFormat !== "points_final";
    });
    if (finalsRuleDesc) {
      const aw = Math.max(2, Math.min(5, Number(aceWinsInp?.value) || 2));
      const wa = !!winnersAdvChk?.checked;
      const fh = Math.max(2, Math.min(7, Number(finalsHeatsInp?.value) || 3));
      finalsRuleDesc.textContent = describeFinalsWinnerRule(curFinalsFormat, aw, wa, fh);
    }
  };

  backdrop.addEventListener("canvas-select-change", (e) => {
    const t = e.target as HTMLElement | null;
    const trigger = t?.closest<HTMLElement>("[data-cselect-trigger]");
    if (!trigger) return;
    const val = (e as CustomEvent<CanvasSelectChangeDetail>).detail?.value ?? "";

    if (trigger.hasAttribute("data-round-lane")) {
      curLane = val || "winners";
      laneWrap.innerHTML = renderLaneSelect();
      if (curLane === "qualifying") {
        curFormat = "qualifying";
        curStart = "staggered";
        fmtWrap.innerHTML = renderFormatSelect();
        startWrap.innerHTML = renderStartSelect();
        if (lapsInp) lapsInp.value = "0";
      } else if (curLane === "finals") {
        curStart = "heads_up";
        startWrap.innerHTML = renderStartSelect();
        if (lapsInp && Number(lapsInp.value) === 0) {
          lapsInp.value = String(cfg?.targetLaps || 3);
        }
      }
      syncFinalsVisibility();
      return;
    }

    if (trigger.hasAttribute("data-round-format")) {
      curFormat = (val || "single_elimination") as StageFormat;
      fmtWrap.innerHTML = renderFormatSelect();
      if (curFormat === "qualifying") {
        curStart = "staggered";
        startWrap.innerHTML = renderStartSelect();
        if (lapsInp && Number(lapsInp.value) > 0) lapsInp.value = "0";
      } else {
        curStart = "heads_up";
        startWrap.innerHTML = renderStartSelect();
        if (lapsInp && Number(lapsInp.value) === 0) {
          lapsInp.value = String(cfg?.targetLaps || 3);
        }
      }
      return;
    }

    if (trigger.hasAttribute("data-round-start")) {
      curStart = (val || "heads_up") as StartMode;
      startWrap.innerHTML = renderStartSelect();
      return;
    }

    if (trigger.hasAttribute("data-round-finals-fmt")) {
      curFinalsFormat = (val || "single_final") as FinalsFormat;
      finalsFmtWrap.innerHTML = renderFinalsFmtSelect();
      syncFinalsVisibility();
    }
  });

  aceWinsInp?.addEventListener("input", syncFinalsVisibility);
  winnersAdvChk?.addEventListener("change", syncFinalsVisibility);
  finalsHeatsInp?.addEventListener("input", syncFinalsVisibility);

  const submit = (): void => {
    const saveBtn = backdrop.querySelector<HTMLButtonElement>("[data-modal-save]");
    if (saveBtn) saveBtn.disabled = true;

    const title = titleInp?.value.trim() || round.title;
    if (anyStarted) {
      const requestedHeatCount = Math.max(
        Math.max(1, startedCount),
        Math.min(
          16,
          Number(backdrop.querySelector<HTMLInputElement>('[data-modal-field="heatCount"]')?.value) ||
            curHeatCount
        )
      );
      void api
        .bracketEdit({
          action: "update_round",
          roundId: round.id,
          title,
          ...(curLane !== "finals" ? { heatCount: requestedHeatCount } : {}),
        })
        .then(() => close())
        .catch((err) => {
          if (saveBtn) saveBtn.disabled = false;
          reportError(err instanceof Error ? err.message : String(err));
        });
      return;
    }

    const bracketLane = curLane || round.bracketLane;
    const isFinals = bracketLane === "finals";
    const stageFormat = (isFinals
      ? "single_elimination"
      : curFormat) as StageFormat;
    const startMode = curStart;
    const heatCount = Math.max(
      1,
      Math.min(
        16,
        Number(backdrop.querySelector<HTMLInputElement>('[data-modal-field="heatCount"]')?.value) ||
          curHeatCount
      )
    );
    const targetLaps = Math.max(0, Number(lapsInp?.value ?? round.targetLaps));
    const timeLimitSec = Math.max(
      15,
      Number(
        backdrop.querySelector<HTMLInputElement>('[data-modal-field="timeLimitSec"]')?.value
      ) || round.timeLimitSec
    );

    const finalsFormat = curFinalsFormat;
    const aceWinsRequired = Math.max(2, Math.min(5, Number(aceWinsInp?.value) || 2));
    const winnersAdvantageAce = !!winnersAdvChk?.checked;
    const finalsHeats = Math.max(2, Math.min(7, Number(finalsHeatsInp?.value) || 3));

    void api
      .bracketEdit({
        action: "update_round",
        roundId: round.id,
        title,
        bracketLane,
        stageFormat,
        startMode,
        heatCount: isFinals ? (finalsFormat === "points_final" ? finalsHeats : 1) : heatCount,
        targetLaps,
        timeLimitSec,
        ...(isFinals
          ? {
              finalsFormat,
              aceWinsRequired,
              winnersAdvantageAce,
              finalsHeats,
            }
          : {}),
      })
      .then(() => close())
      .catch((err) => {
        if (saveBtn) saveBtn.disabled = false;
        reportError(err instanceof Error ? err.message : String(err));
      });
  };

  backdrop.querySelector("[data-modal-save]")?.addEventListener("click", submit);
  backdrop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.target as HTMLElement)?.tagName === "INPUT") {
      e.preventDefault();
      submit();
    }
  });

  titleInp?.focus();
  titleInp?.select();
}

/* ============================================================================
 * 1B. Stage 1 <-> Stage 2 Seeding Handoff Modal
 * ========================================================================== */

export interface StageHandoffModalOptions {
  getRace: () => RaceTournamentState;
  api: ApiClient;
  onSwitchStage?: (stage: number) => void;
  onRemovedStage2?: () => void;
  onError?: (msg: string) => void;
}

export function openStageHandoffModal(opts: StageHandoffModalOptions): void {
  const { getRace, api, onError } = opts;
  const reportError = (msg: string): void => {
    if (onError) onError(msg);
  };
  const initRace = getRace();
  const anyS2Started = initRace.heats.some(
    (h) => h.stageIndex === 2 && !isHeatUnstarted(h.state)
  );
  const rosterActive = (initRace.roster ?? []).filter(
    (p) => p.checkedIn && p.attendance === "active"
  ).length;
  const curCap = initRace.config.stage2MaxSeeds ?? 0;
  let curMetric: QualifyingMetric =
    initRace.config.qualifyingMetric || "consecutive_3";

  const metricOptions: CanvasSelectOption[] = [
    { value: "consecutive_3", label: "Fastest 3 Consecutive Laps" },
    { value: "consecutive_2", label: "Fastest 2 Consecutive Laps" },
    { value: "best_lap", label: "Fastest Single Lap" },
    { value: "laps_in_time", label: "Most Laps in Time" },
    { value: "points", label: "Qualifying Heat Points" },
  ];

  const renderMetricSelect = (): string =>
    renderCanvasSelect({
      value: curMetric,
      label: metricOptions.find((o) => o.value === curMetric)?.label ?? "Best 3 Consecutive Laps",
      options: metricOptions,
      disabled: anyS2Started,
      dataAttrs: "data-handoff-metric",
      title: "Qualifying ranking metric",
    });

  const bodyHtml = `
    <div class="rc-settings-list">
      <div class="rc-setting-row">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Qualifying ranking metric</span>
          <span class="rc-setting-desc">Metric used to order Stage 1 standings into Seed #1, Seed #2, and so on.</span>
        </div>
        <div class="rc-setting-control" data-handoff-metric-wrap>${renderMetricSelect()}</div>
      </div>

      <div class="rc-setting-row is-top-aligned">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Seeds advancing to Stage 2</span>
          <span class="rc-setting-desc">Maximum top seeds advancing into Stage 2 (set 0 to advance all ${rosterActive} active pilots).</span>
        </div>
        <div class="rc-setting-control">
          <input
            type="number"
            class="input mono"
            data-handoff-cap
            min="0"
            max="64"
            value="${curCap}"
            ${anyS2Started ? "disabled" : ""}
          />
          <div class="rc-preset-chips">
            ${[0, 4, 8, 12, 16]
              .map(
                (n) => `
              <button
                type="button"
                class="btn ${curCap === n ? "btn-armed" : "btn-ghost"} btn-xs"
                data-handoff-preset="${n}"
                ${anyS2Started ? "disabled" : ""}
              >
                ${n === 0 ? `All (${rosterActive})` : `Top ${n}`}
              </button>`
              )
              .join("")}
          </div>
        </div>
      </div>
    </div>

    <div class="rc-settings-info-note">
      ${icons.about(14)}
      <span>Stage 2 rounds connected to Qualifying Seeds fill with <code>Seed #1…#N</code> placeholders and resolve automatically once Stage 1 completes.</span>
    </div>
  `;

  const footHtml = `
    <button type="button" class="btn btn-ghost" data-rc-modal-close>Cancel</button>
    <button type="button" class="btn btn-armed" data-handoff-save ${anyS2Started ? "disabled" : ""}>
      ${icons.check(15)}<span>Save</span>
    </button>
  `;

  const { backdrop, close } = mountModalShell(
    "Stage 1 → Stage 2 Seeding Rules",
    icons.trophy(17),
    "rc-modal-md",
    bodyHtml,
    footHtml
  );

  const capInp = backdrop.querySelector<HTMLInputElement>("[data-handoff-cap]");
  const metricWrap = backdrop.querySelector<HTMLElement>("[data-handoff-metric-wrap]")!;

  backdrop.addEventListener("canvas-select-change", (e) => {
    const t = e.target as HTMLElement | null;
    const trigger = t?.closest<HTMLElement>("[data-cselect-trigger]");
    if (!trigger || !trigger.hasAttribute("data-handoff-metric")) return;
    curMetric = ((e as CustomEvent<CanvasSelectChangeDetail>).detail?.value ||
      "consecutive_3") as QualifyingMetric;
    metricWrap.innerHTML = renderMetricSelect();
  });

  backdrop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;

    const presetBtn = t.closest<HTMLButtonElement>("[data-handoff-preset]");
    if (presetBtn && capInp) {
      capInp.value = presetBtn.dataset.handoffPreset || "0";
      backdrop.querySelectorAll<HTMLButtonElement>("[data-handoff-preset]").forEach((b) => {
        const active = b === presetBtn;
        b.classList.toggle("btn-armed", active);
        b.classList.toggle("btn-ghost", !active);
      });
      return;
    }

    const saveBtn = t.closest<HTMLButtonElement>("[data-handoff-save]");
    if (saveBtn && !saveBtn.disabled) {
      saveBtn.disabled = true;
      const stage2MaxSeeds = Math.max(0, Math.min(64, Number(capInp?.value) || 0));
      void api
        .bracketEdit({
          action: "update_stage_handoff",
          stage2MaxSeeds,
          qualifyingMetric: curMetric,
        })
        .then(() => close())
        .catch((err) => {
          saveBtn.disabled = false;
          reportError(err instanceof Error ? err.message : String(err));
        });
    }
  });
}

/* ============================================================================
 * 2. Round Connections Modal (Edit Incoming Feeders + Outgoing Links)
 * ========================================================================== */

function renderWireConnectionFlowBanner(
  sourceTitle: string,
  sourceMeta: string,
  targetTitle: string,
  targetMeta: string
): string {
  return `
    <div class="wire-conn-flow-banner">
      <div class="wire-conn-flow-col">
        <span class="wire-conn-flow-eyebrow">Source</span>
        <strong class="wire-conn-flow-title">${esc(sourceTitle)}</strong>
        <span class="wire-conn-flow-meta">${esc(sourceMeta)}</span>
      </div>
      <div class="wire-conn-flow-arrow" aria-hidden="true">
        ${icons.arrowRight(15)}
      </div>
      <div class="wire-conn-flow-col">
        <span class="wire-conn-flow-eyebrow">Target</span>
        <strong class="wire-conn-flow-title">${esc(targetTitle)}</strong>
        <span class="wire-conn-flow-meta">${esc(targetMeta)}</span>
      </div>
    </div>`;
}

export interface WireConnectionModalOptions {
  connectionId: string;
  getRace: () => RaceTournamentState;
  api: ApiClient;
  onError?: (msg: string) => void;
}

export function openWireConnectionModal(opts: WireConnectionModalOptions): void {
  const { connectionId, getRace, api, onError } = opts;
  const reportError = (msg: string): void => {
    if (onError) onError(msg);
  };

  const initRace = getRace();
  const realConn = (initRace.connections ?? []).find((c) => c.id === connectionId);
  const pilotsMatch = !realConn ? /^conn-(stage(\d+)-pilots-in)-(.+)$/.exec(connectionId) : null;
  if (!realConn && !pilotsMatch) return;

  const fromRoundId = realConn ? realConn.fromRoundId : pilotsMatch![1];
  const toRoundId = realConn ? realConn.toRoundId : pilotsMatch![3];
  const fromRound = (initRace.rounds ?? []).find((r) => r.id === fromRoundId);
  const toRound = (initRace.rounds ?? []).find((r) => r.id === toRoundId);
  if (!toRound) return;

  const stageIdx = toRound.stageIndex || fromRound?.stageIndex || 1;
  const stgObj = (initRace.stages ?? []).find((s) => s.index === stageIdx);
  const pph = Math.max(
    2,
    Math.min(8, stgObj?.settings?.pilotsPerHeat || initRace.config.pilotsPerHeat || 4)
  );
  const activePilotCount = (initRace.roster ?? []).filter(
    (p) => p.checkedIn && p.attendance === "active"
  ).length;

  const isPilotsWire = !!pilotsMatch || realConn?.mode === "pilots_in";
  const isStageSeeds =
    !isPilotsWire && (isHandoffInRoundId(fromRoundId) || realConn?.mode === "stage_seeds");
  const isQualFeed =
    !isPilotsWire && (isHandoffOutRoundId(toRoundId) || realConn?.mode === "qual_feed");

  const fromHeats = initRace.heats.filter((h) => h.roundId === fromRoundId);
  const toHeats = initRace.heats.filter((h) => h.roundId === toRoundId);
  const lockedTarget = isQualFeed
    ? anyDownstreamStageStarted(initRace, stageIdx)
    : !realConn?.invalid && toHeats.some((h) => !isHeatUnstarted(h.state));

  const sourceTitle = isPilotsWire
    ? "Checked-In Pilots"
    : isStageSeeds
      ? fromRound?.title || "Incoming Seeds"
      : fromRound?.title || fromRoundId;
  const sourceMeta = isPilotsWire
    ? `${activePilotCount} active pilot${activePilotCount === 1 ? "" : "s"}`
    : isStageSeeds
      ? `Stage ${stageIdx} seed pool (${effectiveStageSeedCount(initRace, stageIdx, activePilotCount)} pilots)`
      : `${fromHeats.length} heat${fromHeats.length === 1 ? "" : "s"} · ${pph} seats/heat`;

  const targetTitle = isQualFeed
    ? toRound.title || "Downstream Stage Seeding"
    : toRound.title || toRoundId;
  const targetMeta = isQualFeed
    ? "Stage standings output"
    : `${toHeats.length} heat${toHeats.length === 1 ? "" : "s"} · ${pph} seats/heat`;

  const seedCap = Math.max(1, effectiveStageSeedCount(initRace, stageIdx, activePilotCount));
  let curPilotsDist: "roster" | "snake" | "random" =
    toRound.seedDistribution === "snake" || toRound.seedDistribution === "random"
      ? toRound.seedDistribution
      : "roster";
  let curSeedStart = realConn?.seedStart && realConn.seedStart > 0 ? realConn.seedStart : 1;
  let curSeedEnd =
    realConn?.seedEnd && realConn.seedEnd >= curSeedStart ? realConn.seedEnd : seedCap;
  let curSeedDist: "snake" | "sequential" =
    realConn?.distribution === "sequential" ? "sequential" : "snake";

  const rawMode = (realConn?.mode || "top_per_heat") as RoundConnectionMode;
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
  const maxPerHeat = Math.max(1, pph - 1);
  let curCount =
    realConn?.count && realConn.count > 0
      ? realConn.count
      : curMode === "standings_top"
        ? pph
        : Math.min(2, maxPerHeat);

  const pilotsDistOptions: CanvasSelectOption[] = [
    { value: "roster", label: "Roster Order" },
    { value: "snake", label: "Bracket Snake (Fold)" },
    { value: "random", label: "Random Draw" },
  ];

  const seedDistOptions: CanvasSelectOption[] = [
    { value: "snake", label: "Bracket Snake (Fold)" },
    { value: "sequential", label: "Sequential by Rank" },
  ];

  const roundModeOptions: CanvasSelectOption[] = [
    { value: "top_per_heat", label: "Top N per heat (Advance)" },
    { value: "bottom_per_heat", label: "Bottom N per heat (Redemption)" },
    { value: "standings_top", label: "Top N overall fastest" },
    { value: "all_pilots", label: "All pilots · Balanced (Sticky VTX)" },
    { value: "all_pilots_ranked", label: "All pilots · Ranked by standings" },
  ];

  const renderPilotsDistSelect = (): string =>
    renderCanvasSelect({
      value: curPilotsDist,
      label: pilotsDistOptions.find((o) => o.value === curPilotsDist)?.label ?? "Roster Order",
      options: pilotsDistOptions,
      disabled: lockedTarget,
      dataAttrs: "data-wconn-pilots-dist",
      title: "Initial seeding order",
    });

  const renderSeedDistSelect = (): string =>
    renderCanvasSelect({
      value: curSeedDist,
      label: seedDistOptions.find((o) => o.value === curSeedDist)?.label ?? "Bracket Snake (Fold)",
      options: seedDistOptions,
      disabled: lockedTarget,
      dataAttrs: "data-wconn-seed-dist",
      title: "Heat seeding order",
    });

  const renderRoundModeSelect = (): string =>
    renderCanvasSelect({
      value: curMode,
      label: roundModeOptions.find((o) => o.value === curMode)?.label ?? "Top N per heat (Advance)",
      options: roundModeOptions,
      disabled: lockedTarget,
      dataAttrs: "data-wconn-mode",
      title: "Advancement rule",
    });

  const needsCount = (m: string): boolean =>
    m === "top_per_heat" || m === "bottom_per_heat" || m === "standings_top";

  const countTitleFor = (m: string): string =>
    m === "standings_top" ? "Pilots to advance" : "Pilots per heat";

  const countDescFor = (m: string): string =>
    m === "standings_top"
      ? `Total fastest ranked pilots from ${sourceTitle} advancing into ${targetTitle}.`
      : m === "bottom_per_heat"
        ? `Bottom finishing positions per heat in ${sourceTitle} moving into ${targetTitle} (1–${maxPerHeat}).`
        : `Top finishing positions per heat in ${sourceTitle} advancing into ${targetTitle} (1–${maxPerHeat}).`;

  let settingsRowsHtml = "";
  if (isPilotsWire) {
    settingsRowsHtml = `
      <div class="rc-setting-row">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Initial seeding order</span>
          <span class="rc-setting-desc">How checked-in active pilots distribute across heats in ${esc(targetTitle)}.</span>
        </div>
        <div class="rc-setting-control" data-wconn-pilots-dist-wrap>${renderPilotsDistSelect()}</div>
      </div>`;
  } else if (isStageSeeds) {
    settingsRowsHtml = `
      <div class="rc-setting-row">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Seed range</span>
          <span class="rc-setting-desc">Inclusive upstream stage seed slice advancing into ${esc(targetTitle)} (e.g. #1 to #${seedCap}).</span>
        </div>
        <div class="rc-setting-control">
          <div class="rc-range-pair">
            <div class="rc-range-field">
              <span class="rc-range-prefix">#</span>
              <input
                type="number"
                class="input mono"
                data-wconn-seed-start
                min="1"
                max="64"
                value="${curSeedStart}"
                aria-label="Start seed"
                ${lockedTarget ? "disabled" : ""}
              />
            </div>
            <span class="rc-range-sep">to</span>
            <div class="rc-range-field">
              <span class="rc-range-prefix">#</span>
              <input
                type="number"
                class="input mono"
                data-wconn-seed-end
                min="1"
                max="64"
                value="${curSeedEnd}"
                aria-label="End seed"
                ${lockedTarget ? "disabled" : ""}
              />
            </div>
          </div>
        </div>
      </div>
      <div class="rc-setting-row">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Heat seeding order</span>
          <span class="rc-setting-desc">Bracket Snake folds top &amp; bottom seeds across heats; Sequential groups adjacent ranks together.</span>
        </div>
        <div class="rc-setting-control" data-wconn-seed-dist-wrap>${renderSeedDistSelect()}</div>
      </div>`;
  } else if (isQualFeed) {
    settingsRowsHtml = `
      <div class="rc-setting-row">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Stage standings feed</span>
          <span class="rc-setting-desc">Results from ${esc(sourceTitle)} are included in Stage ${stageIdx} overall standings for downstream stages.</span>
        </div>
        <div class="rc-setting-control is-end">
          <span class="badge">Active</span>
        </div>
      </div>`;
  } else {
    settingsRowsHtml = `
      <div class="rc-setting-row">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Advancement rule</span>
          <span class="rc-setting-desc">How finishers from ${esc(sourceTitle)} move across this connection into ${esc(targetTitle)}.</span>
        </div>
        <div class="rc-setting-control" data-wconn-mode-wrap>${renderRoundModeSelect()}</div>
      </div>
      <div class="rc-setting-row" data-wconn-count-row ${needsCount(curMode) ? "" : "hidden"}>
        <div class="rc-setting-info">
          <span class="rc-setting-title" data-wconn-count-title>${esc(countTitleFor(curMode))}</span>
          <span class="rc-setting-desc" data-wconn-count-desc>${esc(countDescFor(curMode))}</span>
        </div>
        <div class="rc-setting-control">
          <input
            type="number"
            class="input mono"
            data-wconn-count
            min="1"
            max="${curMode === "standings_top" ? 64 : maxPerHeat}"
            value="${Math.max(1, curMode === "standings_top" ? curCount : Math.min(maxPerHeat, curCount))}"
            ${lockedTarget ? "disabled" : ""}
          />
        </div>
      </div>`;
  }

  const bodyHtml = `
    ${renderWireConnectionFlowBanner(sourceTitle, sourceMeta, targetTitle, targetMeta)}
    ${
      realConn?.invalid
        ? `<div class="rc-conn-invalid-reason">
            ${icons.siren(13)}
            <span>${esc(realConn.invalidReason || "Invalid connection — adjust rule or reconnect wire.")}</span>
          </div>`
        : ""
    }
    <div class="rc-settings-list">
      ${settingsRowsHtml}
    </div>
    ${
      lockedTarget
        ? `<div class="rc-settings-info-note">
            ${icons.about(14)}
            <span>Heats in ${esc(targetTitle)} have already started — reset them before changing advancement rules.</span>
          </div>`
        : ""
    }
  `;

  const showSave = !isQualFeed;
  const footHtml = showSave
    ? `<button type="button" class="btn btn-ghost" data-rc-modal-close>Cancel</button>
       <button type="button" class="btn btn-armed" data-wconn-save ${lockedTarget ? "disabled" : ""}>
         ${icons.check(15)}<span>Save</span>
       </button>`
    : `<button type="button" class="btn btn-ghost" data-rc-modal-close>Close</button>`;

  const { backdrop, close } = mountModalShell(
    `Connection Settings`,
    icons.link(17),
    "rc-modal-md",
    bodyHtml,
    footHtml
  );

  backdrop.addEventListener("canvas-select-change", (e) => {
    const t = e.target as HTMLElement | null;
    const trigger = t?.closest<HTMLElement>("[data-cselect-trigger]");
    if (!trigger) return;
    const val = (e as CustomEvent<CanvasSelectChangeDetail>).detail?.value ?? "";

    if (trigger.hasAttribute("data-wconn-pilots-dist")) {
      curPilotsDist = (val === "snake" || val === "random" ? val : "roster") as
        | "roster"
        | "snake"
        | "random";
      const wrap = backdrop.querySelector<HTMLElement>("[data-wconn-pilots-dist-wrap]");
      if (wrap) wrap.innerHTML = renderPilotsDistSelect();
      return;
    }

    if (trigger.hasAttribute("data-wconn-seed-dist")) {
      curSeedDist = val === "sequential" ? "sequential" : "snake";
      const wrap = backdrop.querySelector<HTMLElement>("[data-wconn-seed-dist-wrap]");
      if (wrap) wrap.innerHTML = renderSeedDistSelect();
      return;
    }

    if (trigger.hasAttribute("data-wconn-mode")) {
      const prevMode = curMode;
      curMode = (
        val === "bottom_per_heat" ||
        val === "standings_top" ||
        val === "all_pilots" ||
        val === "all_pilots_ranked"
          ? val
          : "top_per_heat"
      ) as typeof curMode;
      const modeWrap = backdrop.querySelector<HTMLElement>("[data-wconn-mode-wrap]");
      if (modeWrap) modeWrap.innerHTML = renderRoundModeSelect();

      const countRow = backdrop.querySelector<HTMLElement>("[data-wconn-count-row]");
      const countInp = backdrop.querySelector<HTMLInputElement>("[data-wconn-count]");
      const titleEl = backdrop.querySelector<HTMLElement>("[data-wconn-count-title]");
      const descEl = backdrop.querySelector<HTMLElement>("[data-wconn-count-desc]");

      if (countRow) countRow.hidden = !needsCount(curMode);
      if (titleEl) titleEl.textContent = countTitleFor(curMode);
      if (descEl) descEl.textContent = countDescFor(curMode);
      if (countInp) {
        const curVal = Number(countInp.value) || curCount;
        if (curMode === "standings_top") {
          countInp.max = "64";
          countInp.value = String(prevMode !== "standings_top" && curVal <= 2 ? pph : Math.max(1, curVal));
        } else {
          countInp.max = String(maxPerHeat);
          countInp.value = String(Math.max(1, Math.min(maxPerHeat, curVal || 2)));
        }
      }
    }
  });

  backdrop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    const saveBtn = t.closest<HTMLButtonElement>("[data-wconn-save]");
    if (!saveBtn || saveBtn.disabled) return;
    saveBtn.disabled = true;

    const prevConns = [...(getRace().connections ?? [])];
    let actionPromise: Promise<RaceTournamentState | void>;

    if (isPilotsWire) {
      actionPromise = api.bracketEdit({
        action: "update_connection",
        connectionId,
        fromRoundId,
        toRoundId,
        linkMode: "pilots_in",
        distribution: curPilotsDist,
      });
    } else if (isStageSeeds) {
      const sStart = Math.max(
        1,
        Math.min(
          64,
          Number(backdrop.querySelector<HTMLInputElement>("[data-wconn-seed-start]")?.value) || 1
        )
      );
      const sEnd = Math.max(
        sStart,
        Math.min(
          64,
          Number(backdrop.querySelector<HTMLInputElement>("[data-wconn-seed-end]")?.value) || sStart
        )
      );
      actionPromise = api.bracketEdit({
        action: "update_connection",
        connectionId,
        linkMode: "stage_seeds",
        seedStart: sStart,
        seedEnd: sEnd,
        distribution: curSeedDist,
      });
    } else {
      const rawCount =
        Number(backdrop.querySelector<HTMLInputElement>("[data-wconn-count]")?.value) || 2;
      const maxAllowed = curMode === "standings_top" ? 64 : maxPerHeat;
      const advanceCount = needsCount(curMode)
        ? Math.max(1, Math.min(maxAllowed, rawCount))
        : 0;
      actionPromise = api.bracketEdit({
        action: "update_connection",
        connectionId,
        linkMode: curMode,
        advanceCount,
      });
    }

    void actionPromise
      .then((next) => {
        if (next) {
          notifyNewlyInvalidConnections(prevConns, next, connectionId);
        }
        close();
      })
      .catch((err) => {
        saveBtn.disabled = false;
        reportError(err instanceof Error ? err.message : String(err));
      });
  });
}

/* ============================================================================
 * 3. Race Settings Modal (Name, Tags, Defaults & Seat Channels)
 * ========================================================================== */

function defaultChannelsForCount(count: number): number[] {
  if (count <= 2) return [1, 8].slice(0, Math.max(2, count));
  if (count === 3) return [1, 4, 8];
  if (count === 4) return [1, 3, 5, 8];
  if (count === 5) return [1, 3, 5, 7, 8];
  if (count === 6) return [1, 2, 4, 5, 7, 8];
  return [1, 2, 3, 4, 5, 6, 7, 8].slice(0, Math.min(8, count));
}

export interface RaceSettingsModalOptions {
  getRace: () => RaceTournamentState;
  getAllTags?: () => string[];
  api: ApiClient;
  onError: (msg: string) => void;
}

export function openRaceSettingsModal(opts: RaceSettingsModalOptions): void {
  const { getRace, getAllTags, api, onError } = opts;
  const initRace = getRace();
  const cfg = initRace.config;
  let curPph = cfg.pilotsPerHeat || 4;
  let currentChannels =
    cfg.seatChannels?.length === curPph
      ? [...cfg.seatChannels]
      : defaultChannelsForCount(curPph);
  let curCountdown = cfg.countdownSec ?? 5;
  let currentTags = [...(initRace.tags ?? [])];

  const pphOptions: CanvasSelectOption[] = [2, 3, 4, 5, 6, 8].map((n) => ({
    value: String(n),
    label: `${n} seats / heat`,
  }));

  const countdownOptions: CanvasSelectOption[] = [0, 3, 5, 10].map((s) => ({
    value: String(s),
    label: s === 0 ? "Instant horn" : `${s}s countdown`,
  }));

  const renderPphSelect = (): string =>
    renderCanvasSelect({
      value: String(curPph),
      label: `${curPph} seats / heat`,
      options: pphOptions,
      dataAttrs: "data-modal-pph",
      title: "Default pilots per heat",
    });

  const renderCountdownSelect = (): string =>
    renderCanvasSelect({
      value: String(curCountdown),
      label: curCountdown === 0 ? "Instant horn" : `${curCountdown}s countdown`,
      options: countdownOptions,
      dataAttrs: "data-modal-countdown",
      title: "Pre-horn start countdown",
    });

  const renderSuggestionsHtml = (tags: string[]): string => {
    const knownTags = getAllTags ? getAllTags() : [];
    const curKeys = new Set(tags.map((t) => t.toLowerCase()));
    const suggestions = knownTags.filter((t) => !curKeys.has(t.toLowerCase()));
    if (suggestions.length === 0) return "";
    return `
      <div class="races-quick-tags">
        <span class="note">Suggestions:</span>
        ${suggestions
          .map(
            (s) =>
              `<button type="button" class="race-tag-suggest" data-modal-suggest-tag="${esc(s)}">+ ${esc(s)}</button>`
          )
          .join("")}
      </div>`;
  };

  const renderSeatChannelPills = (channels: number[]): string =>
    channels
      .map((ch, idx) =>
        renderCanvasSelect({
          value: String(ch),
          label: formatEncodedChannelShort(ch) || `R${ch}`,
          options: buildMultiBandCanvasOptions({ selectedCode: ch, includeFreq: true }),
          className: "rc-ch-cselect",
          mono: true,
          dataAttrs: `data-modal-seat-idx="${idx}"`,
          title: `Seat ${idx + 1} VTX channel`,
        })
      )
      .join("");

  const heatsInfoHtml = (() => {
    const totalHeats = initRace.heats.length;
    if (totalHeats === 0) return "";
    const unstartedCount = initRace.heats.filter((h) => isHeatUnstarted(h.state)).length;
    const startedCount = totalHeats - unstartedCount;
    const detail =
      unstartedCount > 0 && startedCount > 0
        ? `${unstartedCount} unstarted · ${startedCount} completed or in progress unchanged`
        : unstartedCount > 0
          ? `${unstartedCount} unstarted`
          : `${startedCount} completed or in-progress heat${startedCount === 1 ? "" : "s"} unchanged`;
    return `
      <div class="rc-settings-info-note" data-modal-heats-info>
        ${icons.about(14)}
        <span>These changes apply only to unstarted heats (${detail}).</span>
      </div>`;
  })();

  const bodyHtml = `
    <div class="rc-settings-list">
      <div class="rc-setting-row">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Race name</span>
          <span class="rc-setting-desc">Event title displayed in the Races directory, breadcrumbs, and announcer.</span>
        </div>
        <div class="rc-setting-control">
          <input type="text" class="input" data-modal-race-name value="${esc(cfg.eventName)}" maxlength="64" />
        </div>
      </div>

      <div class="rc-setting-row is-top-aligned">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Tags</span>
          <span class="rc-setting-desc">Directory filter labels. Type a tag and press comma or Enter; Backspace removes a tag.</span>
        </div>
        <div class="rc-setting-control">
          <div class="race-tags-editor" data-modal-tags-wrap>
            ${renderTagPillBoxHtml({
              boxId: "race-settings",
              tags: currentTags,
              placeholder: "Add tags (press comma or Enter)…",
              ariaLabel: "Race tags",
            })}
            <div data-modal-tags-suggestions>${renderSuggestionsHtml(currentTags)}</div>
          </div>
        </div>
      </div>

      <div class="rc-setting-row">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Default pilots per heat</span>
          <span class="rc-setting-desc">Seat count applied to unstarted heats and newly added stages.</span>
        </div>
        <div class="rc-setting-control" data-modal-pph-wrap>${renderPphSelect()}</div>
      </div>

      <div class="rc-setting-row is-top-aligned">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Default seat channels</span>
          <span class="rc-setting-desc">VTX channels mapped to each seat by default.</span>
        </div>
        <div class="rc-setting-control">
          <div class="races-seat-ch-pills" data-modal-seat-pills>${renderSeatChannelPills(currentChannels)}</div>
        </div>
      </div>

      <div class="rc-setting-row">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Start countdown</span>
          <span class="rc-setting-desc">Pre-horn countdown delay when starting a heat in Race Control.</span>
        </div>
        <div class="rc-setting-control" data-modal-countdown-wrap>${renderCountdownSelect()}</div>
      </div>

      <div class="rc-setting-row">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Default target laps</span>
          <span class="rc-setting-desc">Lap count inherited by newly added stages and rounds (0 = timed).</span>
        </div>
        <div class="rc-setting-control">
          <input type="number" class="input mono" data-modal-default-laps min="0" max="99" value="${cfg.targetLaps || 3}" />
        </div>
      </div>

      <div class="rc-setting-row">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Default time limit</span>
          <span class="rc-setting-desc">Heat clock duration in seconds inherited by new stages and rounds.</span>
        </div>
        <div class="rc-setting-control">
          <input type="number" class="input mono" data-modal-default-time min="15" max="3600" step="5" value="${cfg.timeLimitSec || 120}" />
        </div>
      </div>
    </div>
    ${heatsInfoHtml}
  `;

  const footHtml = `
    <button type="button" class="btn btn-ghost" data-rc-modal-close>Cancel</button>
    <button type="button" class="btn btn-armed" data-modal-save-settings>
      ${icons.check(15)}<span>Save</span>
    </button>
  `;

  const { backdrop, close } = mountModalShell(
    "Race Settings",
    icons.settings(17),
    "rc-modal-md",
    bodyHtml,
    footHtml
  );

  const pphWrap = backdrop.querySelector<HTMLElement>("[data-modal-pph-wrap]")!;
  const countdownWrap = backdrop.querySelector<HTMLElement>("[data-modal-countdown-wrap]")!;
  const seatWrap = backdrop.querySelector<HTMLElement>("[data-modal-seat-pills]")!;
  const tagBoxEl = backdrop.querySelector<HTMLElement>('[data-tag-box="race-settings"]')!;
  const suggestionsWrap = backdrop.querySelector<HTMLElement>("[data-modal-tags-suggestions]")!;

  const tagEditor = mountTagPillEditor(tagBoxEl, {
    initialTags: currentTags,
    placeholder: "Add tags (press comma or Enter)…",
    onChange: (next) => {
      currentTags = next;
      suggestionsWrap.innerHTML = renderSuggestionsHtml(currentTags);
    },
  });

  backdrop.addEventListener("canvas-select-change", (e) => {
    const t = e.target as HTMLElement | null;
    const trigger = t?.closest<HTMLElement>("[data-cselect-trigger]");
    if (!trigger) return;
    const val = (e as CustomEvent<CanvasSelectChangeDetail>).detail?.value ?? "";

    if (trigger.hasAttribute("data-modal-pph")) {
      curPph = Math.max(2, Math.min(8, Number(val) || 4));
      currentChannels = defaultChannelsForCount(curPph);
      pphWrap.innerHTML = renderPphSelect();
      seatWrap.innerHTML = renderSeatChannelPills(currentChannels);
      return;
    }

    if (trigger.hasAttribute("data-modal-countdown")) {
      curCountdown = Math.max(0, Number(val) || 0);
      countdownWrap.innerHTML = renderCountdownSelect();
      return;
    }

    if (trigger.dataset.modalSeatIdx !== undefined) {
      const idx = Number(trigger.dataset.modalSeatIdx);
      const ch = Number(val);
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
        seatWrap.innerHTML = renderSeatChannelPills(currentChannels);
      }
    }
  });

  backdrop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;

    const sugTagBtn = t.closest<HTMLElement>("[data-modal-suggest-tag]");
    if (sugTagBtn) {
      const tok = sugTagBtn.dataset.modalSuggestTag ?? "";
      if (tok) {
        tagEditor.addTag(tok);
      }
      return;
    }

    const saveBtn = t.closest<HTMLButtonElement>("[data-modal-save-settings]");
    if (saveBtn && !saveBtn.disabled) {
      saveBtn.disabled = true;
      tagEditor.flushPending();
      currentTags = tagEditor.getTags();
      const curRace = getRace();
      const newName =
        backdrop.querySelector<HTMLInputElement>("[data-modal-race-name]")?.value.trim() ||
        curRace.config.eventName;
      const targetLaps = Math.max(
        0,
        Number(
          backdrop.querySelector<HTMLInputElement>("[data-modal-default-laps]")?.value ?? 3
        )
      );
      const timeLimitSec = Math.max(
        15,
        Number(
          backdrop.querySelector<HTMLInputElement>("[data-modal-default-time]")?.value ?? 120
        )
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
          ? api.eventAction({ action: "rename_race", raceId: curRace.raceId, name: newName })
          : Promise.resolve();

      const tagsPromise =
        prevTagsJoined !== nextTagsJoined && curRace.raceId
          ? api.eventAction({
              action: "set_race_tags",
              raceId: curRace.raceId,
              tags: currentTags,
            })
          : Promise.resolve();

      void renamePromise
        .then(() => tagsPromise)
        .then(() => api.configureRace(nextCfg, false, true))
        .then(() => close())
        .catch((err) => {
          saveBtn.disabled = false;
          onError(err instanceof Error ? err.message : String(err));
        });
    }
  });
}

/* ============================================================================
 * 4. Populate From Template Modal
 * ========================================================================== */

export interface TemplateOptionSpec {
  id: string;
  title: string;
  tag: string;
  desc: string;
  stagesHint?: string;
}

export interface TemplateApplyParams {
  pilotsPerHeat: number;
  targetLaps: number;
  timeLimitSec: number;
  qualifyingRounds: number;
}

export interface TemplatesModalOptions {
  race: RaceTournamentState;
  templates: TemplateOptionSpec[];
  initialParams: TemplateApplyParams;
  onApply: (templateId: string, params: TemplateApplyParams) => void;
  onSelectCustom?: () => void;
}

function renderTemplateHeroIcon(id: string, size: number): string {
  switch (id) {
    case "double_elimination":
      return icons.bracket(size);
    case "qual_double_elim":
      return icons.zap(size);
    case "single_elimination":
      return icons.checkered(size);
    case "qual_single_elim":
    case "cpq_single_elim":
      return icons.checkered(size);
    case "qual_mains":
    case "cpq_mains":
      return icons.trophy(size);
    case "open_qualifier":
    case "cpq_qualifier":
      return icons.timer(size);
    case "chase_the_ace":
    case "qual_chase_the_ace":
      return icons.target(size);
    case "round_robin":
      return icons.layers(size);
    case "custom":
      return icons.layout(size);
    default:
      return icons.bracket(size);
  }
}

export function openTemplatesModal(opts: TemplatesModalOptions): () => void {
  const { race, templates, initialParams, onApply, onSelectCustom } = opts;

  const customSpec: TemplateOptionSpec = {
    id: "custom",
    title: "Custom",
    tag: "Start from Scratch",
    stagesHint: "Blank Format Board · Up to 5 Stages",
    desc: "Start with an empty Format board with no preset template applied. Build and wire your own combination of qualifiers, brackets, mains, and finals from scratch.",
  };

  const allChoices: TemplateOptionSpec[] = [
    ...templates.filter((t) => t.id !== "custom"),
    customSpec,
  ];

  const existingTplId =
    race.generated && race.templateId && allChoices.some((c) => c.id === race.templateId)
      ? race.templateId
      : allChoices[0]?.id || "double_elimination";

  let selectedId = existingTplId;

  const renderDetailPane = (choice: TemplateOptionSpec): string => {
    const stagesLine =
      choice.stagesHint ||
      (choice.id === "qual_double_elim"
        ? "2 Stages · Qualifying → Double Elimination"
        : choice.id === "qual_mains"
          ? "2 Stages · Qualifying → A/B/C Mains"
          : choice.id === "qual_single_elim"
            ? "2 Stages · Qualifying → Single Elimination"
            : choice.id === "cpq_mains"
              ? "2 Stages · Qualifier → A/B/C Mains"
              : choice.id === "qual_chase_the_ace"
                ? "2 Stages · Qualifying → Chase the Ace Finals"
                : choice.id === "cpq_qualifier"
                  ? "1 Stage · Qualifying Rounds"
                  : "1 Stage · Ready to Configure");
    return `
      <div class="rc-tpl-detail-hero">${renderTemplateHeroIcon(choice.id, 30)}</div>
      <div class="rc-tpl-detail-meta">
        <span class="races-tpl-tag">${esc(choice.tag)}</span>
        <span class="note">${esc(stagesLine)}</span>
      </div>
      <h3 class="rc-tpl-detail-title">${esc(choice.title)}</h3>
      <p class="rc-tpl-detail-desc">${esc(choice.desc)}</p>
    `;
  };

  const initialChoice = allChoices.find((c) => c.id === selectedId) ?? allChoices[0];

  const bodyHtml = `
    <div class="rc-tpl-picker" role="listbox" aria-label="Race format options">
      <div class="rc-tpl-choices">
        ${allChoices
          .map(
            (t) => `
          <button
            type="button"
            role="option"
            aria-selected="${t.id === selectedId ? "true" : "false"}"
            class="rc-tpl-choice ${t.id === selectedId ? "is-selected" : ""}"
            data-modal-pick-tpl="${esc(t.id)}"
          >
            <span class="rc-tpl-choice-icon">${renderTemplateHeroIcon(t.id, 24)}</span>
            <span class="rc-tpl-choice-name">${esc(t.title)}</span>
          </button>`
          )
          .join("")}
      </div>
      <div class="rc-tpl-detail" data-tpl-detail-pane>
        ${renderDetailPane(initialChoice)}
      </div>
    </div>
  `;

  const footHtml = `
    <button type="button" class="btn btn-ghost" data-rc-modal-close>Cancel</button>
    <button type="button" class="btn btn-armed" data-tpl-confirm>${icons.check(15)}<span>Continue</span></button>
  `;

  const { backdrop, close } = mountModalShell(
    "Choose Race Format",
    icons.layers(17),
    "rc-modal-xl",
    bodyHtml,
    footHtml
  );

  const syncSelectionDom = () => {
    backdrop.querySelectorAll<HTMLButtonElement>("[data-modal-pick-tpl]").forEach((btn) => {
      const isSel = btn.dataset.modalPickTpl === selectedId;
      btn.classList.toggle("is-selected", isSel);
      btn.setAttribute("aria-selected", isSel ? "true" : "false");
    });
    const detailEl = backdrop.querySelector<HTMLElement>("[data-tpl-detail-pane]");
    const cur = allChoices.find((c) => c.id === selectedId);
    if (detailEl && cur) {
      detailEl.innerHTML = renderDetailPane(cur);
    }
  };

  const confirmSelection = () => {
    if (!selectedId) return;
    const defaults: TemplateApplyParams = {
      pilotsPerHeat: Math.max(2, Math.min(8, initialParams.pilotsPerHeat || 4)),
      targetLaps: Math.max(1, initialParams.targetLaps || 3),
      timeLimitSec: Math.max(15, initialParams.timeLimitSec || 120),
      qualifyingRounds: Math.max(1, initialParams.qualifyingRounds || 2),
    };
    close();
    if (selectedId === "custom") {
      onSelectCustom?.();
      return;
    }
    onApply(selectedId, defaults);
  };

  backdrop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;

    if (t.closest("[data-tpl-confirm]")) {
      confirmSelection();
      return;
    }

    const card = t.closest<HTMLElement>("[data-modal-pick-tpl]");
    if (card) {
      const tplId = card.dataset.modalPickTpl ?? "";
      if (tplId && tplId !== selectedId) {
        selectedId = tplId;
        syncSelectionDom();
      }
    }
  });

  backdrop.addEventListener("dblclick", (e) => {
    const t = e.target as HTMLElement | null;
    const card = t?.closest<HTMLElement>("[data-modal-pick-tpl]");
    if (card && card.dataset.modalPickTpl) {
      selectedId = card.dataset.modalPickTpl;
      confirmSelection();
    }
  });

  return close;
}

/* ============================================================================
 * 5. Per-Stage Settings Modal (Title, Seats/Heat, Channels, Laps, Time, Rules)
 * ========================================================================== */

export interface StageSettingsModalOptions {
  stageIndex: number;
  getRace: () => RaceTournamentState;
  api: ApiClient;
  onError: (msg: string) => void;
}

export function openStageSettingsModal(opts: StageSettingsModalOptions): void {
  const { stageIndex, getRace, api, onError } = opts;
  const initRace = getRace();
  const stageObj =
    (initRace.stages ?? []).find((s) => s.index === stageIndex) ??
    ({
      id: `stage-${stageIndex}`,
      index: stageIndex,
      title: stageIndex === 1 ? "Stage 1" : `Stage ${stageIndex}`,
      format: stageIndex === 1 && initRace.config.hasQualifying ? "qualifying" : initRace.config.mainFormat,
      settings: {
        pilotsPerHeat: initRace.config.pilotsPerHeat || 4,
        seatChannels: initRace.config.seatChannels ?? [1, 3, 5, 8],
        targetLaps: initRace.config.targetLaps || 3,
        timeLimitSec: initRace.config.timeLimitSec || 120,
        qualifyingRounds: initRace.config.qualifyingRounds || 2,
        qualifyingMetric: initRace.config.qualifyingMetric || "consecutive_3",
        pointsRounds: initRace.config.pointsRounds || 3,
        finalsFormat: initRace.config.finalsFormat || "single_final",
        aceWinsRequired: initRace.config.aceWinsRequired || 2,
        winnersAdvantageAce: !!initRace.config.winnersAdvantageAce,
      },
      status: "ready",
      prerequisitesMet: true,
    } as RaceStage);

  const stgSettings = stageObj.settings ?? {
    pilotsPerHeat: initRace.config.pilotsPerHeat || 4,
    seatChannels: initRace.config.seatChannels ?? [1, 3, 5, 8],
    targetLaps: initRace.config.targetLaps || 3,
    timeLimitSec: initRace.config.timeLimitSec || 120,
    qualifyingRounds: initRace.config.qualifyingRounds || 2,
    qualifyingMetric: initRace.config.qualifyingMetric || "consecutive_3",
    pointsRounds: initRace.config.pointsRounds || 3,
    finalsFormat: initRace.config.finalsFormat || "single_final",
    aceWinsRequired: initRace.config.aceWinsRequired || 2,
    winnersAdvantageAce: !!initRace.config.winnersAdvantageAce,
  };

  let curPph = stgSettings.pilotsPerHeat || initRace.config.pilotsPerHeat || 4;
  let curChannels =
    stgSettings.seatChannels?.length === curPph
      ? [...stgSettings.seatChannels]
      : defaultChannelsForCount(curPph);
  let curQualMetric: QualifyingMetric =
    stgSettings.qualifyingMetric || initRace.config.qualifyingMetric || "consecutive_3";
  let curFinalsFmt: FinalsFormat =
    stgSettings.finalsFormat || initRace.config.finalsFormat || "single_final";

  const stageHeats = initRace.heats.filter((h) => h.stageIndex === stageIndex);
  const unstartedCount = stageHeats.filter((h) => isHeatUnstarted(h.state)).length;
  const startedCount = stageHeats.length - unstartedCount;
  const startedQualRoundSet = new Set<string>();
  for (const h of stageHeats) {
    if (!isHeatUnstarted(h.state)) {
      startedQualRoundSet.add(h.roundId || `col-${h.column || h.round || 1}`);
    }
  }
  const minQualRounds = Math.max(1, startedQualRoundSet.size);
  let curQualRounds = Math.max(minQualRounds, Math.min(12, stgSettings.qualifyingRounds || 2));
  let curMaxPacks = Math.max(0, Math.min(50, stgSettings.maxPacksPerPilot ?? 0));

  const pphOptions: CanvasSelectOption[] = [2, 3, 4, 5, 6, 8].map((n) => ({
    value: String(n),
    label: `${n} seats / heat`,
  }));

  const metricOptions: CanvasSelectOption[] = [
    { value: "consecutive_3", label: "Fastest 3 Consecutive Laps" },
    { value: "consecutive_2", label: "Fastest 2 Consecutive Laps" },
    { value: "best_lap", label: "Fastest Single Lap" },
    { value: "laps_in_time", label: "Most Laps in Time" },
    { value: "points", label: "Qualifying Heat Points" },
  ];

  const finalsOptions: CanvasSelectOption[] = [
    { value: "single_final", label: "Single Heat Final" },
    { value: "chase_the_ace", label: "Chase the Ace Final" },
    { value: "points_final", label: "Multi-Heat Points Final" },
  ];

  const renderPphSelect = (): string =>
    renderCanvasSelect({
      value: String(curPph),
      label: `${curPph} seats / heat`,
      options: pphOptions,
      dataAttrs: "data-stg-pph",
      title: "Pilots per heat in this stage",
    });

  const renderSeatChannelPills = (): string =>
    curChannels
      .map((ch, idx) =>
        renderCanvasSelect({
          value: String(ch),
          label: formatEncodedChannelShort(ch) || `R${ch}`,
          options: buildMultiBandCanvasOptions({ selectedCode: ch, includeFreq: true }),
          className: "rc-ch-cselect",
          mono: true,
          dataAttrs: `data-stg-seat-idx="${idx}"`,
          title: `Seat ${idx + 1} VTX channel`,
        })
      )
      .join("");

  const renderMetricSelect = (): string =>
    renderCanvasSelect({
      value: curQualMetric,
      label:
        metricOptions.find((m) => m.value === curQualMetric)?.label ??
        "Best 3 Consecutive Laps",
      options: metricOptions,
      dataAttrs: "data-stg-qual-metric",
      title: "Ranking metric for this stage",
    });

  const renderFinalsSelect = (): string =>
    renderCanvasSelect({
      value: curFinalsFmt,
      label:
        finalsOptions.find((f) => f.value === curFinalsFmt)?.label ?? "Single Heat Final",
      options: finalsOptions,
      dataAttrs: "data-stg-finals-fmt",
      title: "Finals rule for elimination bracket",
    });

  const isQualStage = stageObj.format === "qualifying";
  const isOpenQualStage = stageObj.format === "open_qualifier";
  const isPointsStage = stageObj.format === "points_mains";
  const isElimStage =
    stageObj.format === "single_elimination" ||
    stageObj.format === "double_elimination" ||
    stageObj.format === "chase_the_ace";

  const heatsInfoHtml =
    stageHeats.length > 0
      ? `<div class="rc-settings-info-note" data-stg-heats-info>
          ${icons.about(14)}
          <span>These changes apply only to unstarted heats in Stage ${stageIndex} (${
            unstartedCount > 0 && startedCount > 0
              ? `${unstartedCount} unstarted · ${startedCount} completed or in progress unchanged`
              : unstartedCount > 0
                ? `${unstartedCount} unstarted`
                : `${startedCount} completed or in-progress heat${startedCount === 1 ? "" : "s"} unchanged`
          }).</span>
        </div>`
      : "";

  const bodyHtml = `
    <div class="rc-settings-list">
      <div class="rc-setting-row">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Stage title</span>
          <span class="rc-setting-desc">Display name shown on the Format board, stage menu, and standings.</span>
        </div>
        <div class="rc-setting-control">
          <input
            type="text"
            class="input"
            data-stg-title
            value="${esc(stageObj.title || `Stage ${stageIndex}`)}"
            maxlength="48"
          />
        </div>
      </div>

      <div class="rc-setting-row">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Pilots per heat</span>
          <span class="rc-setting-desc">Maximum pilot seats per heat in Stage ${stageIndex}.</span>
        </div>
        <div class="rc-setting-control" data-stg-pph-wrap>${renderPphSelect()}</div>
      </div>

      <div class="rc-setting-row is-top-aligned">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Seat channels</span>
          <span class="rc-setting-desc">VTX channels assigned to each seat in Stage ${stageIndex}.</span>
        </div>
        <div class="rc-setting-control">
          <div class="races-seat-ch-pills" data-stg-seat-pills>${renderSeatChannelPills()}</div>
        </div>
      </div>

      <div class="rc-setting-row">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Target laps</span>
          <span class="rc-setting-desc">${
            isQualStage || isOpenQualStage
              ? "Set 0 for purely timed heats, or a lap target to finish early."
              : "Laps required to finish each heat in this stage (0 = timed)."
          }</span>
        </div>
        <div class="rc-setting-control">
          <input
            type="number"
            class="input mono"
            data-stg-laps
            min="0"
            max="99"
            value="${stgSettings.targetLaps ?? (isQualStage || isOpenQualStage ? 0 : 3)}"
          />
        </div>
      </div>

      <div class="rc-setting-row">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Time limit</span>
          <span class="rc-setting-desc">Maximum heat clock duration in seconds.</span>
        </div>
        <div class="rc-setting-control">
          <input
            type="number"
            class="input mono"
            data-stg-time
            min="15"
            max="3600"
            step="5"
            value="${stgSettings.timeLimitSec || 120}"
          />
        </div>
      </div>

      ${
        isOpenQualStage
          ? `<div class="rc-setting-row is-top-aligned">
              <div class="rc-setting-info">
                <span class="rc-setting-title">Max heats per pilot</span>
                <span class="rc-setting-desc">Maximum heats each pilot may fly during the Open Qualifier (0 = unlimited).</span>
                <div class="races-preset-pills" style="margin-top:6px">
                  <button type="button" class="races-filter-pill ${curMaxPacks === 0 ? "is-active" : ""}" data-stg-pack-preset="0">Unlimited</button>
                  <button type="button" class="races-filter-pill ${curMaxPacks === 2 ? "is-active" : ""}" data-stg-pack-preset="2">2 heats</button>
                  <button type="button" class="races-filter-pill ${curMaxPacks === 3 ? "is-active" : ""}" data-stg-pack-preset="3">3 heats</button>
                  <button type="button" class="races-filter-pill ${curMaxPacks === 5 ? "is-active" : ""}" data-stg-pack-preset="5">5 heats</button>
                  <button type="button" class="races-filter-pill ${curMaxPacks === 8 ? "is-active" : ""}" data-stg-pack-preset="8">8 heats</button>
                </div>
              </div>
              <div class="rc-setting-control">
                <input
                  type="number"
                  class="input mono"
                  data-stg-max-packs
                  min="0"
                  max="50"
                  value="${curMaxPacks}"
                />
                <span class="note" data-stg-max-packs-note style="display:block;margin-top:4px;text-align:right">${curMaxPacks === 0 ? "0 = Unlimited" : `Max ${curMaxPacks} heats/pilot`}</span>
              </div>
            </div>
            <div class="rc-setting-row">
              <div class="rc-setting-info">
                <span class="rc-setting-title">Ranking metric</span>
                <span class="rc-setting-desc">How lap times rank pilots on the Open Qualifier leaderboard.</span>
              </div>
              <div class="rc-setting-control" data-stg-metric-wrap>${renderMetricSelect()}</div>
            </div>`
          : isQualStage
            ? `<div class="rc-setting-row is-top-aligned">
                <div class="rc-setting-info">
                  <span class="rc-setting-title">Qualifying rounds (heats per pilot)</span>
                  <span class="rc-setting-desc">Each pilot flies 1 heat per round. Changing the round count dynamically adds or trims rounds on the graph${startedQualRoundSet.size > 0 ? ` (minimum ${minQualRounds} already started)` : ""}.</span>
                  <div class="races-preset-pills" style="margin-top:6px">
                    ${[1, 2, 3, 4, 6]
                      .filter((n) => n >= minQualRounds)
                      .map(
                        (n) =>
                          `<button type="button" class="races-filter-pill ${curQualRounds === n ? "is-active" : ""}" data-stg-qual-round-preset="${n}">${n} ${n === 1 ? "round" : "rounds"}</button>`
                      )
                      .join("")}
                  </div>
                </div>
                <div class="rc-setting-control">
                  <input
                    type="number"
                    class="input mono"
                    data-stg-qual-rounds
                    min="${minQualRounds}"
                    max="12"
                    value="${curQualRounds}"
                  />
                  <span class="note" data-stg-qual-rounds-note style="display:block;margin-top:4px;text-align:right">${curQualRounds} ${curQualRounds === 1 ? "heat" : "heats"}/pilot</span>
                </div>
              </div>
              <div class="rc-setting-row">
                <div class="rc-setting-info">
                  <span class="rc-setting-title">Ranking metric</span>
                  <span class="rc-setting-desc">Metric used to compute overall qualifying standings.</span>
                </div>
                <div class="rc-setting-control" data-stg-metric-wrap>${renderMetricSelect()}</div>
              </div>`
            : isPointsStage
              ? `<div class="rc-setting-row">
                  <div class="rc-setting-info">
                    <span class="rc-setting-title">Points rounds</span>
                    <span class="rc-setting-desc">Number of multi-round points mains before cumulative standings conclude.</span>
                  </div>
                  <div class="rc-setting-control">
                    <input
                      type="number"
                      class="input mono"
                      data-stg-points-rounds
                      min="1"
                      max="12"
                      value="${stgSettings.pointsRounds || 3}"
                      ${stageObj.customized || startedCount > 0 ? "disabled" : ""}
                    />
                  </div>
                </div>`
              : isElimStage
                ? `<div class="rc-setting-row">
                    <div class="rc-setting-info">
                      <span class="rc-setting-title">Finals format</span>
                      <span class="rc-setting-desc">How the Championship Finals round determines the stage winner.</span>
                    </div>
                    <div class="rc-setting-control" data-stg-finals-wrap>${renderFinalsSelect()}</div>
                  </div>
                  <div class="rc-setting-row" data-stg-ace-wins-wrap ${curFinalsFmt === "chase_the_ace" ? "" : "hidden"}>
                    <div class="rc-setting-info">
                      <span class="rc-setting-title">Ace wins required</span>
                      <span class="rc-setting-desc">Heat wins required by a finalist to claim Stage Champion.</span>
                    </div>
                    <div class="rc-setting-control">
                      <input
                        type="number"
                        class="input mono"
                        data-stg-ace-wins
                        min="2"
                        max="5"
                        value="${stgSettings.aceWinsRequired || 2}"
                      />
                    </div>
                  </div>
                  ${
                    stageObj.format === "double_elimination"
                      ? `<div class="rc-setting-row" data-stg-adv-wrap ${curFinalsFmt === "chase_the_ace" ? "" : "hidden"}>
                          <div class="rc-setting-info">
                            <span class="rc-setting-title">Winners-bracket advantage</span>
                            <span class="rc-setting-desc">Upper-bracket finalist enters Finals with +1 starting Ace win.</span>
                          </div>
                          <div class="rc-setting-control is-end">
                            <label class="switch">
                              <input type="checkbox" data-stg-winners-adv ${stgSettings.winnersAdvantageAce ? "checked" : ""} />
                              <span></span>
                            </label>
                          </div>
                        </div>`
                      : ""
                  }`
                : `<div class="rc-setting-row">
                    <div class="rc-setting-info">
                      <span class="rc-setting-title">Ranking metric</span>
                      <span class="rc-setting-desc">Metric used to order overall standings in this stage.</span>
                    </div>
                    <div class="rc-setting-control" data-stg-metric-wrap>${renderMetricSelect()}</div>
                  </div>`
      }
    </div>
    ${heatsInfoHtml}
  `;

  const footHtml = `
    <button type="button" class="btn btn-ghost" data-rc-modal-close>Cancel</button>
    <button type="button" class="btn btn-armed" data-stg-save>
      ${icons.check(15)}<span>Save</span>
    </button>
  `;

  const { backdrop, close } = mountModalShell(
    `Stage ${stageIndex} Settings · “${stageObj.title || `Stage ${stageIndex}`}”`,
    icons.sliders(17),
    "rc-modal-md",
    bodyHtml,
    footHtml
  );

  const pphWrap = backdrop.querySelector<HTMLElement>("[data-stg-pph-wrap]")!;
  const seatWrap = backdrop.querySelector<HTMLElement>("[data-stg-seat-pills]")!;
  const metricWrap = backdrop.querySelector<HTMLElement>("[data-stg-metric-wrap]");
  const finalsWrap = backdrop.querySelector<HTMLElement>("[data-stg-finals-wrap]");
  const aceWinsWrap = backdrop.querySelector<HTMLElement>("[data-stg-ace-wins-wrap]");
  const advWrap = backdrop.querySelector<HTMLElement>("[data-stg-adv-wrap]");

  backdrop.addEventListener("canvas-select-change", (e) => {
    const t = e.target as HTMLElement | null;
    const trigger = t?.closest<HTMLElement>("[data-cselect-trigger]");
    if (!trigger) return;
    const val = (e as CustomEvent<CanvasSelectChangeDetail>).detail?.value ?? "";

    if (trigger.hasAttribute("data-stg-pph")) {
      curPph = Math.max(2, Math.min(8, Number(val) || 4));
      curChannels = defaultChannelsForCount(curPph);
      pphWrap.innerHTML = renderPphSelect();
      seatWrap.innerHTML = renderSeatChannelPills();
      return;
    }

    if (trigger.dataset.stgSeatIdx !== undefined) {
      const idx = Number(trigger.dataset.stgSeatIdx);
      const ch = Number(val);
      if (idx >= 0 && idx < curChannels.length && isValidEncodedSeatChannel(ch)) {
        const targetFreq = decodeBandChannel(ch)?.frequencyMhz ?? 0;
        const other = curChannels.findIndex(
          (existing, i) =>
            i !== idx &&
            (existing === ch ||
              (targetFreq > 0 && decodeBandChannel(existing)?.frequencyMhz === targetFreq))
        );
        if (other >= 0) {
          curChannels[other] = curChannels[idx];
        }
        curChannels[idx] = ch;
        seatWrap.innerHTML = renderSeatChannelPills();
      }
      return;
    }

    if (trigger.hasAttribute("data-stg-qual-metric")) {
      curQualMetric = (val || "consecutive_3") as QualifyingMetric;
      if (metricWrap) metricWrap.innerHTML = renderMetricSelect();
      return;
    }

    if (trigger.hasAttribute("data-stg-finals-fmt")) {
      curFinalsFmt = (val || "single_final") as FinalsFormat;
      if (finalsWrap) finalsWrap.innerHTML = renderFinalsSelect();
      if (aceWinsWrap) aceWinsWrap.hidden = curFinalsFmt !== "chase_the_ace";
      if (advWrap) advWrap.hidden = curFinalsFmt !== "chase_the_ace";
    }
  });

  const syncQualAndPacksUi = () => {
    const qualNoteEl = backdrop.querySelector<HTMLElement>("[data-stg-qual-rounds-note]");
    if (qualNoteEl) {
      qualNoteEl.textContent = `${curQualRounds} ${curQualRounds === 1 ? "heat" : "heats"}/pilot`;
    }
    backdrop.querySelectorAll<HTMLButtonElement>("[data-stg-qual-round-preset]").forEach((btn) => {
      btn.classList.toggle("is-active", Number(btn.dataset.stgQualRoundPreset) === curQualRounds);
    });
    const noteEl = backdrop.querySelector<HTMLElement>("[data-stg-max-packs-note]");
    if (noteEl) {
      noteEl.textContent = curMaxPacks === 0 ? "0 = Unlimited" : `Max ${curMaxPacks} heats/pilot`;
    }
    backdrop.querySelectorAll<HTMLButtonElement>("[data-stg-pack-preset]").forEach((btn) => {
      btn.classList.toggle("is-active", Number(btn.dataset.stgPackPreset) === curMaxPacks);
    });
  };

  backdrop.addEventListener("input", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (t.hasAttribute("data-stg-qual-rounds")) {
      curQualRounds = Math.max(
        minQualRounds,
        Math.min(12, Number((t as HTMLInputElement).value) || curQualRounds)
      );
      syncQualAndPacksUi();
    } else if (t.hasAttribute("data-stg-max-packs")) {
      curMaxPacks = Math.max(
        0,
        Math.min(50, Number((t as HTMLInputElement).value ?? 0))
      );
      syncQualAndPacksUi();
    }
  });

  backdrop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;

    const qualPresetBtn = t.closest<HTMLButtonElement>("[data-stg-qual-round-preset]");
    if (qualPresetBtn) {
      curQualRounds = Math.max(
        minQualRounds,
        Math.min(12, Number(qualPresetBtn.dataset.stgQualRoundPreset ?? 2))
      );
      const qInp = backdrop.querySelector<HTMLInputElement>("[data-stg-qual-rounds]");
      if (qInp) qInp.value = String(curQualRounds);
      syncQualAndPacksUi();
      return;
    }

    const presetBtn = t.closest<HTMLButtonElement>("[data-stg-pack-preset]");
    if (presetBtn) {
      curMaxPacks = Math.max(0, Math.min(50, Number(presetBtn.dataset.stgPackPreset ?? 0)));
      const maxInp = backdrop.querySelector<HTMLInputElement>("[data-stg-max-packs]");
      if (maxInp) maxInp.value = String(curMaxPacks);
      syncQualAndPacksUi();
      return;
    }

    const saveBtn = t.closest<HTMLButtonElement>("[data-stg-save]");
    if (saveBtn && !saveBtn.disabled) {
      saveBtn.disabled = true;
      const title =
        backdrop.querySelector<HTMLInputElement>("[data-stg-title]")?.value.trim() ||
        stageObj.title ||
        `Stage ${stageIndex}`;
      const targetLaps = Math.max(
        0,
        Number(backdrop.querySelector<HTMLInputElement>("[data-stg-laps]")?.value ?? 3)
      );
      const timeLimitSec = Math.max(
        15,
        Number(backdrop.querySelector<HTMLInputElement>("[data-stg-time]")?.value ?? 120)
      );
      const qualifyingRounds = Math.max(
        1,
        Number(
          backdrop.querySelector<HTMLInputElement>("[data-stg-qual-rounds]")?.value ??
            (stgSettings.qualifyingRounds || 2)
        )
      );
      const pointsRounds = Math.max(
        1,
        Number(
          backdrop.querySelector<HTMLInputElement>("[data-stg-points-rounds]")?.value ??
            (stgSettings.pointsRounds || 3)
        )
      );
      const aceWinsRequired = Math.max(
        2,
        Math.min(
          5,
          Number(
            backdrop.querySelector<HTMLInputElement>("[data-stg-ace-wins]")?.value ??
              (stgSettings.aceWinsRequired || 2)
          )
        )
      );
      const maxPacksPerPilot = Math.max(
        0,
        Math.min(
          50,
          Number(
            backdrop.querySelector<HTMLInputElement>("[data-stg-max-packs]")?.value ??
              (stgSettings.maxPacksPerPilot ?? 0)
          )
        )
      );
      const winnersAdvantageAce =
        backdrop.querySelector<HTMLInputElement>("[data-stg-winners-adv]")?.checked ??
        !!stgSettings.winnersAdvantageAce;

      void api
        .bracketEdit({
          action: "update_stage_settings",
          stageId: stageObj.id,
          stageIndex,
          title,
          pilotsPerHeat: curPph,
          seatChannels: curChannels.slice(0, curPph),
          targetLaps,
          timeLimitSec,
          qualifyingRounds,
          qualifyingMetric: curQualMetric,
          maxPacksPerPilot,
          pointsRounds,
          finalsFormat: curFinalsFmt,
          aceWinsRequired,
          winnersAdvantageAce,
          applyToExisting: true,
        })
        .then(() => close())
        .catch((err) => {
          saveBtn.disabled = false;
          onError(err instanceof Error ? err.message : String(err));
        });
    }
  });
}

/* ============================================================================
 * 6. Stage-to-Stage Connection Advancement Modal (Format Mode)
 * ========================================================================== */

export interface StageConnectionModalOptions {
  connectionId: string;
  getRace: () => RaceTournamentState;
  api: ApiClient;
  onError: (msg: string) => void;
}

export function openStageConnectionModal(opts: StageConnectionModalOptions): void {
  const { connectionId, getRace, api, onError } = opts;
  const initRace = getRace();
  const conn = (initRace.stageConnections ?? []).find((c) => c.id === connectionId);
  if (!conn) return;

  const fromStg = (initRace.stages ?? []).find((s) => s.index === conn.fromStageIndex);
  const toStg = (initRace.stages ?? []).find((s) => s.index === conn.toStageIndex);
  const activePilotCount = Math.max(
    4,
    (initRace.roster ?? []).filter((p) => p.checkedIn && p.attendance === "active").length
  );

  let curMode: StageConnectionMode =
    conn.mode === "top_n" || conn.mode === "seed_range" ? conn.mode : "all_pilots";
  let curCount = conn.count && conn.count > 0 ? conn.count : 8;
  let curSeedStart = conn.seedStart && conn.seedStart > 0 ? conn.seedStart : 1;
  let curSeedEnd =
    conn.seedEnd && conn.seedEnd >= curSeedStart ? conn.seedEnd : Math.max(4, curSeedStart + 3);
  let curMetric: QualifyingMetric =
    conn.rankingMetric ||
    fromStg?.settings?.qualifyingMetric ||
    initRace.config.qualifyingMetric ||
    "consecutive_3";

  const modeOptions: CanvasSelectOption[] = [
    { value: "all_pilots", label: `All Ranked Pilots (1..${activePilotCount})` },
    { value: "top_n", label: "Top N Seeds (#1…#N)" },
    { value: "seed_range", label: "Custom Seed Slice (#Start…#End)" },
  ];

  const metricOptions: CanvasSelectOption[] = [
    { value: "consecutive_3", label: "Fastest 3 Consecutive Laps" },
    { value: "consecutive_2", label: "Fastest 2 Consecutive Laps" },
    { value: "best_lap", label: "Fastest Single Lap" },
    { value: "laps_in_time", label: "Most Laps in Time" },
    { value: "points", label: "Stage Standings / Points" },
  ];

  const fromTitle = fromStg?.title || `Stage ${conn.fromStageIndex}`;
  const toTitle = toStg?.title || `Stage ${conn.toStageIndex}`;
  const fromHeatsCount = initRace.heats.filter((h) => h.stageIndex === conn.fromStageIndex).length;
  const toHeatsCount = initRace.heats.filter((h) => h.stageIndex === conn.toStageIndex).length;
  const fromStageMeta = `Stage ${conn.fromStageIndex} · ${fromHeatsCount} heat${fromHeatsCount === 1 ? "" : "s"}`;
  const toStageMeta = `Stage ${conn.toStageIndex} · ${toHeatsCount} heat${toHeatsCount === 1 ? "" : "s"}`;
  const lockedTarget =
    !conn.invalid &&
    initRace.heats.some((h) => h.stageIndex === conn.toStageIndex && !isHeatUnstarted(h.state));

  const renderModeSelect = (): string =>
    renderCanvasSelect({
      value: curMode,
      label: modeOptions.find((m) => m.value === curMode)?.label ?? "All Ranked Pilots",
      options: modeOptions,
      disabled: lockedTarget,
      dataAttrs: "data-sconn-mode",
      title: "Pilot advancement slice mode",
    });

  const renderMetricSelect = (): string =>
    renderCanvasSelect({
      value: curMetric,
      label: metricOptions.find((m) => m.value === curMetric)?.label ?? "Best 3 Consecutive Laps",
      options: metricOptions,
      disabled: lockedTarget,
      dataAttrs: "data-sconn-metric",
      title: "Upstream ranking tiebreaker metric",
    });

  const bodyHtml = `
    ${renderWireConnectionFlowBanner(fromTitle, fromStageMeta, toTitle, toStageMeta)}
    ${
      conn.invalid
        ? `<div class="rc-conn-invalid-reason">
            ${icons.siren(13)}
            <span>${esc(conn.invalidReason || "Invalid stage connection — reconnect or remove this wire.")}</span>
          </div>`
        : ""
    }
    <div class="rc-settings-list">
      <div class="rc-setting-row">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Advancement slice</span>
          <span class="rc-setting-desc">Which ranked pilots advance from ${esc(fromTitle)} into ${esc(toTitle)} when ${esc(fromTitle)} completes.</span>
        </div>
        <div class="rc-setting-control" data-sconn-mode-wrap>${renderModeSelect()}</div>
      </div>

      <div class="rc-setting-row" data-sconn-topn-wrap ${curMode === "top_n" ? "" : "hidden"}>
        <div class="rc-setting-info">
          <span class="rc-setting-title">Pilots to advance</span>
          <span class="rc-setting-desc">Number of top-ranked seeds (#1 through #N) advancing into ${esc(toTitle)}.</span>
        </div>
        <div class="rc-setting-control">
          <input
            type="number"
            class="input mono"
            data-sconn-count
            min="1"
            max="64"
            value="${curCount}"
            ${lockedTarget ? "disabled" : ""}
          />
        </div>
      </div>

      <div class="rc-setting-row" data-sconn-range-wrap ${curMode === "seed_range" ? "" : "hidden"}>
        <div class="rc-setting-info">
          <span class="rc-setting-title">Seed range</span>
          <span class="rc-setting-desc">Inclusive seed slice advancing into ${esc(toTitle)} (e.g. #5 to #8 for a B-Main or Redemption stage).</span>
        </div>
        <div class="rc-setting-control">
          <div class="rc-range-pair">
            <div class="rc-range-field">
              <span class="rc-range-prefix">#</span>
              <input
                type="number"
                class="input mono"
                data-sconn-seed-start
                min="1"
                max="64"
                value="${curSeedStart}"
                aria-label="Start seed"
                ${lockedTarget ? "disabled" : ""}
              />
            </div>
            <span class="rc-range-sep">to</span>
            <div class="rc-range-field">
              <span class="rc-range-prefix">#</span>
              <input
                type="number"
                class="input mono"
                data-sconn-seed-end
                min="1"
                max="64"
                value="${curSeedEnd}"
                aria-label="End seed"
                ${lockedTarget ? "disabled" : ""}
              />
            </div>
          </div>
        </div>
      </div>

      <div class="rc-setting-row">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Ranking &amp; tiebreaker</span>
          <span class="rc-setting-desc">Metric used to rank upstream pilots and break ties when seeding ${esc(toTitle)}.</span>
        </div>
        <div class="rc-setting-control" data-sconn-metric-wrap>${renderMetricSelect()}</div>
      </div>
    </div>
    ${
      lockedTarget
        ? `<div class="rc-settings-info-note">
            ${icons.about(14)}
            <span>Heats in ${esc(toTitle)} have already started — reset them before changing advancement rules.</span>
          </div>`
        : ""
    }
  `;

  const footHtml = `
    <button type="button" class="btn btn-ghost" data-rc-modal-close>Cancel</button>
    <button type="button" class="btn btn-armed" data-sconn-save ${lockedTarget ? "disabled" : ""}>
      ${icons.check(15)}<span>Save</span>
    </button>
  `;

  const { backdrop, close } = mountModalShell(
    `Stage Link · ${fromTitle} → ${toTitle}`,
    icons.link(17),
    "rc-modal-md",
    bodyHtml,
    footHtml
  );

  const modeWrap = backdrop.querySelector<HTMLElement>("[data-sconn-mode-wrap]")!;
  const metricWrap = backdrop.querySelector<HTMLElement>("[data-sconn-metric-wrap]")!;
  const topnWrap = backdrop.querySelector<HTMLElement>("[data-sconn-topn-wrap]")!;
  const rangeWrap = backdrop.querySelector<HTMLElement>("[data-sconn-range-wrap]")!;

  backdrop.addEventListener("canvas-select-change", (e) => {
    const t = e.target as HTMLElement | null;
    const trigger = t?.closest<HTMLElement>("[data-cselect-trigger]");
    if (!trigger) return;
    const val = (e as CustomEvent<CanvasSelectChangeDetail>).detail?.value ?? "";

    if (trigger.hasAttribute("data-sconn-mode")) {
      curMode = (val || "all_pilots") as StageConnectionMode;
      modeWrap.innerHTML = renderModeSelect();
      topnWrap.hidden = curMode !== "top_n";
      rangeWrap.hidden = curMode !== "seed_range";
      return;
    }

    if (trigger.hasAttribute("data-sconn-metric")) {
      curMetric = (val || "consecutive_3") as QualifyingMetric;
      metricWrap.innerHTML = renderMetricSelect();
    }
  });

  backdrop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;

    const saveBtn = t.closest<HTMLButtonElement>("[data-sconn-save]");
    if (saveBtn && !saveBtn.disabled) {
      saveBtn.disabled = true;
      const advanceCount =
        curMode === "top_n"
          ? Math.max(
              1,
              Math.min(
                64,
                Number(backdrop.querySelector<HTMLInputElement>("[data-sconn-count]")?.value) || 8
              )
            )
          : 0;
      const seedStart =
        curMode === "seed_range"
          ? Math.max(
              1,
              Math.min(
                64,
                Number(
                  backdrop.querySelector<HTMLInputElement>("[data-sconn-seed-start]")?.value
                ) || 1
              )
            )
          : 1;
      const seedEnd =
        curMode === "seed_range"
          ? Math.max(
              seedStart,
              Math.min(
                64,
                Number(backdrop.querySelector<HTMLInputElement>("[data-sconn-seed-end]")?.value) ||
                  seedStart
              )
            )
          : 0;

      const prevStageConns = [...(getRace().stageConnections ?? [])];
      void api
        .bracketEdit({
          action: "update_stage_connection",
          connectionId,
          linkMode: curMode,
          advanceCount,
          seedStart,
          seedEnd,
          qualifyingMetric: curMetric,
        })
        .then((next) => {
          notifyNewlyInvalidStageConnections(prevStageConns, next ?? getRace(), connectionId);
          close();
        })
        .catch((err) => {
          saveBtn.disabled = false;
          onError(err instanceof Error ? err.message : String(err));
        });
    }
  });
}

/* ============================================================================
 * 7. Open Qualifier Node Settings Modal (MultiGP Open Qualifier Rules)
 * ========================================================================== */

export function openOpenQualifierSettingsModal(opts: StageSettingsModalOptions): void {
  const { stageIndex, getRace, api, onError } = opts;
  const initRace = getRace();
  const stageObj =
    (initRace.stages ?? []).find((s) => s.index === stageIndex) ??
    ({
      id: `stage-${stageIndex}`,
      index: stageIndex,
      title: stageIndex === 1 ? "Open Qualifier" : `Stage ${stageIndex}`,
      format: "open_qualifier",
      settings: {
        pilotsPerHeat: initRace.config.pilotsPerHeat || 4,
        seatChannels: initRace.config.seatChannels ?? [1, 3, 5, 8],
        targetLaps: 0,
        timeLimitSec: initRace.config.timeLimitSec || 120,
        qualifyingRounds: 1,
        qualifyingMetric: initRace.config.qualifyingMetric || "consecutive_3",
        maxPacksPerPilot: initRace.config.maxPacksPerPilot ?? 0,
        pointsRounds: 3,
        finalsFormat: "single_final",
        aceWinsRequired: 2,
        winnersAdvantageAce: false,
      },
      status: "ready",
      prerequisitesMet: true,
    } as RaceStage);

  const stgSettings = stageObj.settings ?? {
    pilotsPerHeat: initRace.config.pilotsPerHeat || 4,
    seatChannels: initRace.config.seatChannels ?? [1, 3, 5, 8],
    targetLaps: 0,
    timeLimitSec: initRace.config.timeLimitSec || 120,
    qualifyingRounds: 1,
    qualifyingMetric: initRace.config.qualifyingMetric || "consecutive_3",
    maxPacksPerPilot: initRace.config.maxPacksPerPilot ?? 0,
    pointsRounds: 3,
    finalsFormat: "single_final",
    aceWinsRequired: 2,
    winnersAdvantageAce: false,
  };

  let curMaxPacks = Math.max(
    0,
    Math.min(50, stgSettings.maxPacksPerPilot ?? initRace.config.maxPacksPerPilot ?? 0)
  );
  let curTimeSec = Math.max(
    15,
    Math.min(3600, stgSettings.timeLimitSec || initRace.config.timeLimitSec || 120)
  );
  let curMetric: QualifyingMetric =
    stgSettings.qualifyingMetric || initRace.config.qualifyingMetric || "consecutive_3";

  const metricOptions: CanvasSelectOption[] = [
    { value: "consecutive_3", label: "Fastest 3 Consecutive Laps (MultiGP Default)" },
    { value: "consecutive_2", label: "Fastest 2 Consecutive Laps" },
    { value: "best_lap", label: "Fastest Single Lap" },
    { value: "laps_in_time", label: "Most Laps in Time" },
    { value: "points", label: "Qualifying Heat Points" },
  ];

  const renderMetricSelect = (): string =>
    renderCanvasSelect({
      value: curMetric,
      label:
        metricOptions.find((m) => m.value === curMetric)?.label ??
        "Fastest 3 Consecutive Laps (MultiGP Default)",
      options: metricOptions,
      dataAttrs: "data-oq-qual-metric",
      title: "Ranking criteria for Open Qualifier standings",
    });

  const bodyHtml = `
    <div class="rc-settings-list">
      <div class="rc-setting-row is-top-aligned">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Heats per pilot</span>
          <span class="rc-setting-desc">Allow unlimited walk-up heats during the qualifier window (MultiGP standard) or cap maximum heats per pilot.</span>
          <div class="races-preset-pills" style="margin-top:6px">
            <button type="button" class="races-filter-pill ${curMaxPacks === 0 ? "is-active" : ""}" data-oq-pack-preset="0">Unlimited</button>
            <button type="button" class="races-filter-pill ${curMaxPacks === 3 ? "is-active" : ""}" data-oq-pack-preset="3">3 heats</button>
            <button type="button" class="races-filter-pill ${curMaxPacks === 5 ? "is-active" : ""}" data-oq-pack-preset="5">5 heats</button>
            <button type="button" class="races-filter-pill ${curMaxPacks === 8 ? "is-active" : ""}" data-oq-pack-preset="8">8 heats</button>
            <button type="button" class="races-filter-pill ${curMaxPacks === 10 ? "is-active" : ""}" data-oq-pack-preset="10">10 heats</button>
          </div>
        </div>
        <div class="rc-setting-control">
          <input
            type="number"
            class="input mono"
            data-oq-max-packs
            min="0"
            max="50"
            value="${curMaxPacks}"
            aria-label="Max heats per pilot (0 for unlimited)"
          />
          <span class="note" data-oq-max-packs-note style="display:block;margin-top:4px;text-align:right">${curMaxPacks === 0 ? "0 = Unlimited" : `Max ${curMaxPacks} heats`}</span>
        </div>
      </div>

      <div class="rc-setting-row is-top-aligned">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Heat length (seconds)</span>
          <span class="rc-setting-desc">Clock duration for each Open Qualifier heat (120s / 2:00 is standard MultiGP Open Qualifier).</span>
          <div class="races-preset-pills" style="margin-top:6px">
            <button type="button" class="races-filter-pill ${curTimeSec === 90 ? "is-active" : ""}" data-oq-time-preset="90">1:30 (90s)</button>
            <button type="button" class="races-filter-pill ${curTimeSec === 120 ? "is-active" : ""}" data-oq-time-preset="120">2:00 (120s)</button>
            <button type="button" class="races-filter-pill ${curTimeSec === 150 ? "is-active" : ""}" data-oq-time-preset="150">2:30 (150s)</button>
            <button type="button" class="races-filter-pill ${curTimeSec === 180 ? "is-active" : ""}" data-oq-time-preset="180">3:00 (180s)</button>
          </div>
        </div>
        <div class="rc-setting-control">
          <input
            type="number"
            class="input mono"
            data-oq-time-sec
            min="15"
            max="3600"
            step="5"
            value="${curTimeSec}"
            aria-label="Heat length in seconds"
          />
        </div>
      </div>

      <div class="rc-setting-row">
        <div class="rc-setting-info">
          <span class="rc-setting-title">Ranking criteria</span>
          <span class="rc-setting-desc">How pilot laps across all Open Qualifier heats are ranked on the leaderboard.</span>
        </div>
        <div class="rc-setting-control" data-oq-metric-wrap>${renderMetricSelect()}</div>
      </div>
    </div>`;

  const footHtml = `
    <button type="button" class="btn btn-ghost" data-rc-modal-close>Cancel</button>
    <button type="button" class="btn btn-armed" data-oq-modal-save>
      ${icons.check(15)}<span>Save</span>
    </button>
  `;

  const isZippyQ =
    (stageObj.title || "").toLowerCase().includes("zippyq") ||
    Boolean(initRace.mgpLink?.isZippyQ && stageIndex === 1);
  const { backdrop, close } = mountModalShell(
    isZippyQ ? "ZippyQ Settings" : "Open Qualifier Settings",
    icons.sliders(17),
    "rc-modal-md",
    bodyHtml,
    footHtml
  );

  const syncPackPills = (val: number): void => {
    curMaxPacks = Math.max(0, Math.min(50, Math.floor(val) || 0));
    backdrop.querySelectorAll<HTMLButtonElement>("[data-oq-pack-preset]").forEach((btn) => {
      btn.classList.toggle("is-active", Number(btn.dataset.oqPackPreset) === curMaxPacks);
    });
    const noteEl = backdrop.querySelector<HTMLElement>("[data-oq-max-packs-note]");
    if (noteEl) {
      noteEl.textContent = curMaxPacks === 0 ? "0 = Unlimited" : `Max ${curMaxPacks} heats`;
    }
  };

  const syncTimePills = (val: number): void => {
    curTimeSec = Math.max(15, Math.min(3600, Math.floor(val) || 120));
    backdrop.querySelectorAll<HTMLButtonElement>("[data-oq-time-preset]").forEach((btn) => {
      btn.classList.toggle("is-active", Number(btn.dataset.oqTimePreset) === curTimeSec);
    });
  };

  backdrop.addEventListener("input", (e) => {
    const t = e.target as HTMLElement | null;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.hasAttribute("data-oq-max-packs")) {
      syncPackPills(Number(t.value));
    } else if (t.hasAttribute("data-oq-time-sec")) {
      syncTimePills(Number(t.value));
    }
  });

  backdrop.addEventListener("canvas-select-change", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    const detail = (e as CustomEvent<CanvasSelectChangeDetail>).detail;
    const val = detail?.value ?? "";
    if (t.hasAttribute("data-oq-qual-metric")) {
      curMetric = (val || "consecutive_3") as QualifyingMetric;
      const wrap = backdrop.querySelector<HTMLElement>("[data-oq-metric-wrap]");
      if (wrap) wrap.innerHTML = renderMetricSelect();
    }
  });

  backdrop.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;

    const packBtn = t.closest<HTMLButtonElement>("[data-oq-pack-preset]");
    if (packBtn) {
      const nextPacks = Number(packBtn.dataset.oqPackPreset) || 0;
      const inp = backdrop.querySelector<HTMLInputElement>("[data-oq-max-packs]");
      if (inp) inp.value = String(nextPacks);
      syncPackPills(nextPacks);
      return;
    }

    const timeBtn = t.closest<HTMLButtonElement>("[data-oq-time-preset]");
    if (timeBtn) {
      const nextTime = Number(timeBtn.dataset.oqTimePreset) || 120;
      const inp = backdrop.querySelector<HTMLInputElement>("[data-oq-time-sec]");
      if (inp) inp.value = String(nextTime);
      syncTimePills(nextTime);
      return;
    }

    const saveBtn = t.closest<HTMLButtonElement>("[data-oq-modal-save]");
    if (saveBtn) {
      saveBtn.disabled = true;
      const packsInput = backdrop.querySelector<HTMLInputElement>("[data-oq-max-packs]");
      const timeInput = backdrop.querySelector<HTMLInputElement>("[data-oq-time-sec]");
      const maxPacksPerPilot = Math.max(
        0,
        Math.min(50, Number(packsInput?.value ?? curMaxPacks) || 0)
      );
      const timeLimitSec = Math.max(
        15,
        Math.min(3600, Number(timeInput?.value ?? curTimeSec) || 120)
      );
      const pph = stgSettings.pilotsPerHeat || initRace.config.pilotsPerHeat || 4;
      const seatCh =
        stgSettings.seatChannels?.length === pph
          ? stgSettings.seatChannels
          : defaultChannelsForCount(pph);

      void api
        .bracketEdit({
          action: "update_stage_settings",
          stageId: stageObj.id,
          stageIndex,
          title: stageObj.title || `Stage ${stageIndex}`,
          pilotsPerHeat: pph,
          seatChannels: seatCh,
          targetLaps: stgSettings.targetLaps ?? 0,
          timeLimitSec,
          qualifyingRounds: stgSettings.qualifyingRounds || 1,
          qualifyingMetric: curMetric,
          maxPacksPerPilot,
          pointsRounds: stgSettings.pointsRounds || 3,
          finalsFormat: stgSettings.finalsFormat || "single_final",
          aceWinsRequired: stgSettings.aceWinsRequired || 2,
          winnersAdvantageAce: !!stgSettings.winnersAdvantageAce,
          applyToExisting: true,
        })
        .then(() => close())
        .catch((err) => {
          saveBtn.disabled = false;
          onError(err instanceof Error ? err.message : String(err));
        });
    }
  });
}
