import {
  HeatState,
  RaceHeat,
  RaceRound,
  RaceStage,
  RaceTournamentState,
  RoundConnection,
  RoundConnectionMode,
} from "../types/models";

export interface ConnectionValidationResult {
  valid: boolean;
  reason: string;
}

function isUnstartedHeatState(state: HeatState): boolean {
  return state === "waiting" || state === "ready" || state === "staged";
}

function isPortalHandoffOutId(id: string): boolean {
  return id === "stage1-seeding-out" || /^stage\d+-seeding-out$/.test(id);
}

function isPortalHandoffInId(id: string): boolean {
  return id === "stage2-seeds-in" || /^stage\d+-seeds-in$/.test(id);
}

function isPortalPilotsInId(id: string): boolean {
  return id === "stage1-pilots-in" || /^stage\d+-pilots-in$/.test(id);
}

function isPortalOpenQualId(id: string): boolean {
  return /^stage\d+-open-qual$/.test(id);
}

function stagePilotsPerHeat(race: RaceTournamentState, stageIndex: number): number {
  const stg = (race.stages ?? []).find((s) => s.index === stageIndex);
  const pph = stg?.settings?.pilotsPerHeat || race.config?.pilotsPerHeat || 4;
  return Math.max(2, Math.min(8, pph));
}

function activeRosterPilotCount(race: RaceTournamentState): number {
  return (race.roster ?? []).filter((p) => p.checkedIn && p.attendance === "active").length;
}

function computeStageSeedCap(race: RaceTournamentState, stageIndex: number): number {
  const activeCount = activeRosterPilotCount(race);
  const base = Math.max(2, activeCount || 8);
  const inStageConns = (race.stageConnections ?? []).filter(
    (sc) => !sc.invalid && sc.toStageIndex === stageIndex
  );
  if (inStageConns.length > 0) {
    let total = 0;
    for (const sc of inStageConns) {
      if (sc.mode === "top_n" && (sc.count ?? 0) > 0) {
        total += sc.count!;
      } else if (sc.mode === "seed_range") {
        const s = Math.max(1, sc.seedStart || 1);
        const e = sc.seedEnd && sc.seedEnd >= s ? sc.seedEnd : base;
        total += Math.max(1, e - s + 1);
      } else {
        total += base;
      }
    }
    return Math.max(2, Math.min(base, total));
  }
  if (stageIndex === 2 && race.totalStages >= 2) {
    const maxS = race.config?.stage2MaxSeeds ?? 0;
    if (maxS > 0 && maxS < base) {
      return maxS;
    }
    return maxS > 0 ? maxS : base;
  }
  return 0;
}

function hasDownstreamStageStartedHeats(
  race: RaceTournamentState,
  fromStageIndex: number
): boolean {
  const conns = race.stageConnections ?? [];
  if (conns.length === 0) {
    return (
      fromStageIndex === 1 &&
      race.heats.some((h) => h.stageIndex === 2 && !isUnstartedHeatState(h.state))
    );
  }
  const adj = new Map<number, number[]>();
  for (const sc of conns) {
    if (!sc.invalid && sc.fromStageIndex > 0 && sc.toStageIndex > 0) {
      const list = adj.get(sc.fromStageIndex) ?? [];
      list.push(sc.toStageIndex);
      adj.set(sc.fromStageIndex, list);
    }
  }
  const visited = new Set<number>();
  const queue = [...(adj.get(fromStageIndex) ?? [])];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    if (race.heats.some((h) => h.stageIndex === cur && !isUnstartedHeatState(h.state))) {
      return true;
    }
    for (const nxt of adj.get(cur) ?? []) {
      if (!visited.has(nxt)) queue.push(nxt);
    }
  }
  return false;
}

/**
 * In-memory directed network graph for Stage-to-Stage connections on the Format board.
 * Mirrors Go's `ValidateStageDAG` so invalid connections (cycles, self-loops, duplicates,
 * started target stages) are blocked immediately in the UI before any API call is sent,
 * while pre-existing/API-created `conn.invalid === true` wires remain rendered red.
 */
export class StageNetworkGraph {
  private readonly stageById = new Map<string, RaceStage>();
  private readonly adj = new Map<string, string[]>();
  private readonly edgePairs = new Set<string>();
  private readonly stageStartedByIndex = new Set<number>();

  constructor(
    stages: RaceStage[],
    race: RaceTournamentState,
    excludeConnectionId = ""
  ) {
    for (const stg of stages) {
      this.stageById.set(stg.id, stg);
    }
    for (const h of race.heats ?? []) {
      if (!isUnstartedHeatState(h.state)) {
        this.stageStartedByIndex.add(h.stageIndex);
      }
    }
    for (const sc of race.stageConnections ?? []) {
      if (sc.id === excludeConnectionId) continue;
      if (sc.invalid) continue;
      if (!this.stageById.has(sc.fromStageId) || !this.stageById.has(sc.toStageId)) {
        continue;
      }
      this.edgePairs.add(`${sc.fromStageId}->${sc.toStageId}`);
      const list = this.adj.get(sc.fromStageId) ?? [];
      list.push(sc.toStageId);
      this.adj.set(sc.fromStageId, list);
    }
  }

  public canReach(startId: string, goalId: string): boolean {
    if (startId === goalId) return true;
    const visited = new Set<string>();
    const queue = [...(this.adj.get(startId) ?? [])];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur === goalId) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const nxt of this.adj.get(cur) ?? []) {
        if (!visited.has(nxt)) queue.push(nxt);
      }
    }
    return false;
  }

  public validateConnection(fromStageId: string, toStageId: string): ConnectionValidationResult {
    if (!fromStageId || !toStageId) {
      return { valid: false, reason: "Select both source and target stages." };
    }
    if (fromStageId === toStageId) {
      return { valid: false, reason: "A stage cannot connect to itself." };
    }
    const fromStg = this.stageById.get(fromStageId);
    const toStg = this.stageById.get(toStageId);
    if (!fromStg || !toStg) {
      return { valid: false, reason: "Stage no longer exists." };
    }
    if (this.edgePairs.has(`${fromStageId}->${toStageId}`)) {
      return {
        valid: false,
        reason: `“${fromStg.title}” is already connected to “${toStg.title}”.`,
      };
    }
    if (this.canReach(toStageId, fromStageId)) {
      return {
        valid: false,
        reason: `Cannot connect “${fromStg.title}” → “${toStg.title}”: creates a dependency loop.`,
      };
    }
    if (toStg.format === "qualifying" || toStg.format === "open_qualifier") {
      return {
        valid: false,
        reason: `“${toStg.title}” is a starting qualifier stage and does not accept upstream stage inputs.`,
      };
    }
    if (this.stageStartedByIndex.has(toStg.index)) {
      return {
        valid: false,
        reason: `Cannot modify incoming connections into “${toStg.title}” because heats have already started.`,
      };
    }
    return { valid: true, reason: "" };
  }

  public getValidTargetIds(fromStageId: string): Set<string> {
    const valid = new Set<string>();
    for (const id of this.stageById.keys()) {
      if (this.validateConnection(fromStageId, id).valid) {
        valid.add(id);
      }
    }
    return valid;
  }
}

export interface RoundValidateOptions {
  fromPort?: "right" | "bottom";
  mode?: RoundConnectionMode;
  count?: number;
}

/**
 * In-memory directed network graph for Round-to-Round (and Portal-to-Round) connections
 * within a Stage editor. Mirrors Go's `validateConnectionsLocked` so loops, duplicates,
 * invalid portal directions, started target heats, overlapping Top + Bottom advancement,
 * `stage_seeds` cutoff overflow, and Finals single-group seat capacity overflow are
 * prevented cleanly in the UI.
 */
export class RoundNetworkGraph {
  private readonly race: RaceTournamentState;
  private readonly stageIndex: number;
  private readonly pph: number;
  private readonly stageSeedCap: number;
  private readonly downstreamStageStarted: boolean;
  private readonly roundById = new Map<string, RaceRound>();
  private readonly heatsByRound: Map<string, RaceHeat[]>;
  private readonly activeConns: RoundConnection[] = [];
  private readonly adj = new Map<string, string[]>();
  private readonly edgePairs = new Set<string>();
  private readonly nonPilotsIncomingByRound = new Map<string, number>();
  private readonly maxTopFrom = new Map<string, number>();
  private readonly maxBottomFrom = new Map<string, number>();
  private readonly finalsFixedSeatsUsed = new Map<string, number>();
  private readonly finalsAutoSrcHeats = new Map<string, number>();
  private maxExistingSeedEnd = 0;

  constructor(
    race: RaceTournamentState,
    stageIndex: number,
    stageRounds: RaceRound[],
    heatsByRound: Map<string, RaceHeat[]>,
    stageConnections: RoundConnection[],
    excludeConnectionId = ""
  ) {
    this.race = race;
    this.stageIndex = stageIndex;
    this.pph = stagePilotsPerHeat(race, stageIndex);
    this.stageSeedCap = computeStageSeedCap(race, stageIndex);
    this.downstreamStageStarted = hasDownstreamStageStartedHeats(race, stageIndex);
    this.heatsByRound = heatsByRound;

    for (const r of stageRounds) {
      this.roundById.set(r.id, r);
    }

    for (const c of stageConnections) {
      if (c.id === excludeConnectionId) continue;
      // Only non-invalid connections participate in reachability / capacity tallies,
      // though even an existing invalid duplicate between the exact same pair blocks a second duplicate.
      this.edgePairs.add(`${c.fromRoundId}->${c.toRoundId}`);
      if (c.invalid) continue;

      this.activeConns.push(c);
      const list = this.adj.get(c.fromRoundId) ?? [];
      list.push(c.toRoundId);
      this.adj.set(c.fromRoundId, list);

      if (!isPortalPilotsInId(c.fromRoundId)) {
        this.nonPilotsIncomingByRound.set(
          c.toRoundId,
          (this.nonPilotsIncomingByRound.get(c.toRoundId) ?? 0) + 1
        );
      }

      if (c.mode === "top_per_heat") {
        const cnt = c.count > 0 ? c.count : Math.max(1, Math.floor(this.pph / 2));
        if (cnt > (this.maxTopFrom.get(c.fromRoundId) ?? 0)) {
          this.maxTopFrom.set(c.fromRoundId, cnt);
        }
      } else if (c.mode === "bottom_per_heat") {
        const cnt = c.count > 0 ? c.count : Math.max(1, Math.floor(this.pph / 2));
        if (cnt > (this.maxBottomFrom.get(c.fromRoundId) ?? 0)) {
          this.maxBottomFrom.set(c.fromRoundId, cnt);
        }
      } else if (c.mode === "stage_seeds" || isPortalHandoffInId(c.fromRoundId)) {
        const sStart = c.seedStart && c.seedStart > 0 ? c.seedStart : 1;
        const sEnd =
          c.seedEnd && c.seedEnd >= sStart ? c.seedEnd : Math.max(sStart, this.stageSeedCap || 4);
        if (sEnd > this.maxExistingSeedEnd) {
          this.maxExistingSeedEnd = sEnd;
        }
      }

      const dstRound = this.roundById.get(c.toRoundId);
      if (dstRound?.bracketLane === "finals") {
        if (!c.customCount && (c.mode === "top_per_heat" || c.mode === "bottom_per_heat")) {
          const srcHeats = Math.max(1, (this.heatsByRound.get(c.fromRoundId) ?? []).length);
          this.finalsAutoSrcHeats.set(
            c.toRoundId,
            (this.finalsAutoSrcHeats.get(c.toRoundId) ?? 0) + srcHeats
          );
        } else {
          const used = this.estimateWireFeeders(
            c.fromRoundId,
            c.mode as RoundConnectionMode,
            c.count,
            c.seedStart,
            c.seedEnd
          );
          this.finalsFixedSeatsUsed.set(
            c.toRoundId,
            (this.finalsFixedSeatsUsed.get(c.toRoundId) ?? 0) + used
          );
        }
      }
    }
  }

  private estimateWireFeeders(
    fromRoundId: string,
    mode: RoundConnectionMode,
    count?: number,
    seedStart?: number,
    seedEnd?: number
  ): number {
    if (isPortalPilotsInId(fromRoundId) || mode === "pilots_in") {
      return Math.max(1, activeRosterPilotCount(this.race));
    }
    if (isPortalHandoffInId(fromRoundId) || mode === "stage_seeds") {
      const s = seedStart && seedStart > 0 ? seedStart : 1;
      const e = seedEnd && seedEnd >= s ? seedEnd : Math.max(s, this.stageSeedCap || this.pph);
      return Math.max(1, e - s + 1);
    }
    const srcHeats = Math.max(1, (this.heatsByRound.get(fromRoundId) ?? []).length);
    if (mode === "all_pilots") {
      return srcHeats * this.pph;
    }
    if (mode === "standings_top") {
      return Math.max(1, count && count > 0 ? count : this.pph);
    }
    const perHeat = Math.max(1, count && count > 0 ? count : Math.max(1, Math.floor(this.pph / 2)));
    return srcHeats * perHeat;
  }

  public inferDefaultMode(
    fromRoundId: string,
    toRoundId: string,
    fromPort: "right" | "bottom" = "right"
  ): RoundConnectionMode {
    if (isPortalPilotsInId(fromRoundId)) return "pilots_in";
    if (isPortalHandoffInId(fromRoundId)) return "stage_seeds";
    if (isPortalHandoffOutId(toRoundId)) return "qual_feed";
    if (fromPort === "bottom") return "bottom_per_heat";
    const fromR = this.roundById.get(fromRoundId);
    const toR = this.roundById.get(toRoundId);
    if (fromR?.stageFormat === "qualifying" && toR?.stageFormat === "qualifying") {
      return "all_pilots";
    }
    if (fromR?.stageFormat === "qualifying") {
      return "standings_top";
    }
    return "top_per_heat";
  }

  /**
   * Computes a safe default per-heat advance count so connecting a `bottom` (losers) port
   * when `Top 3` is already advancing out of a 4-seat round automatically defaults to `Bottom 1`
   * instead of overflowing `pilotsPerHeat`.
   */
  public recommendedAdvanceCount(
    fromRoundId: string,
    mode: RoundConnectionMode
  ): number | undefined {
    const defaultHalf = Math.max(1, Math.floor(this.pph / 2));
    if (mode === "top_per_heat") {
      const usedBottom = this.maxBottomFrom.get(fromRoundId) ?? 0;
      const maxAllowed = this.pph - usedBottom;
      if (maxAllowed >= 1 && defaultHalf > maxAllowed) {
        return maxAllowed;
      }
      return undefined;
    }
    if (mode === "bottom_per_heat") {
      const usedTop = this.maxTopFrom.get(fromRoundId) ?? 0;
      const maxAllowed = this.pph - usedTop;
      if (maxAllowed >= 1 && defaultHalf > maxAllowed) {
        return maxAllowed;
      }
      return undefined;
    }
    if (mode === "standings_top") {
      return undefined;
    }
    return undefined;
  }

  public canReach(startId: string, goalId: string): boolean {
    if (startId === goalId) return true;
    const visited = new Set<string>();
    const queue = [...(this.adj.get(startId) ?? [])];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur === goalId) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const nxt of this.adj.get(cur) ?? []) {
        if (!visited.has(nxt)) queue.push(nxt);
      }
    }
    return false;
  }

  public validateConnection(
    fromRoundId: string,
    toRoundId: string,
    opts?: RoundValidateOptions
  ): ConnectionValidationResult {
    if (!fromRoundId || !toRoundId) {
      return { valid: false, reason: "Select both source and target rounds." };
    }
    if (fromRoundId === toRoundId) {
      return { valid: false, reason: "A node cannot connect to itself." };
    }

    const fromR = this.roundById.get(fromRoundId);
    const toR = this.roundById.get(toRoundId);
    if (!fromR || !toR) {
      return { valid: false, reason: "Round no longer exists in this stage." };
    }

    const fromIsHandoffIn = isPortalHandoffInId(fromRoundId);
    const fromIsPilotsIn = isPortalPilotsInId(fromRoundId);
    const toIsHandoffOut = isPortalHandoffOutId(toRoundId);

    if (isPortalHandoffOutId(fromRoundId)) {
      return { valid: false, reason: "Stage Out cannot feed back into rounds." };
    }
    if (fromR.bracketLane === "finals") {
      return { valid: false, reason: "Championship Finals has no outgoing connections." };
    }
    if (
      isPortalHandoffInId(toRoundId) ||
      isPortalPilotsInId(toRoundId)
    ) {
      return { valid: false, reason: `“${toR.title}” does not accept incoming connections.` };
    }
    if ((fromIsHandoffIn || fromIsPilotsIn) && toIsHandoffOut) {
      return {
        valid: false,
        reason: `“${fromR.title}” must connect into a round before Stage Out.`,
      };
    }
    if (this.edgePairs.has(`${fromRoundId}->${toRoundId}`)) {
      return {
        valid: false,
        reason: `“${fromR.title}” is already connected to “${toR.title}”.`,
      };
    }

    if (!fromIsHandoffIn && !fromIsPilotsIn && !toIsHandoffOut) {
      if (this.canReach(toRoundId, fromRoundId)) {
        return {
          valid: false,
          reason: `Cannot connect “${fromR.title}” → “${toR.title}”: creates a loop.`,
        };
      }
    }

    if (fromIsPilotsIn && (this.nonPilotsIncomingByRound.get(toRoundId) ?? 0) > 0) {
      return {
        valid: false,
        reason: `Pilots can only connect to starting rounds without upstream round feeders.`,
      };
    }
    if (!fromIsPilotsIn) {
      const hasPilotsWire = this.activeConns.some(
        (c) => isPortalPilotsInId(c.fromRoundId) && c.toRoundId === toRoundId
      );
      if (hasPilotsWire) {
        return {
          valid: false,
          reason: `Disconnect “Pilots” from “${toR.title}” before feeding it from an upstream round.`,
        };
      }
    }

    if (toIsHandoffOut) {
      if (this.downstreamStageStarted) {
        return {
          valid: false,
          reason: "Downstream stage has already started; Stage Out feeders are locked.",
        };
      }
    } else {
      const dstHeats = this.heatsByRound.get(toRoundId) ?? [];
      if (dstHeats.some((h) => !isUnstartedHeatState(h.state))) {
        return {
          valid: false,
          reason: `Cannot connect into “${toR.title}” because one or more heats have already started.`,
        };
      }
    }

    const fromPort = opts?.fromPort ?? "right";
    const mode = opts?.mode ?? this.inferDefaultMode(fromRoundId, toRoundId, fromPort);

    // Prevent overlapping Top + Bottom per-heat advancement exceeding pilotsPerHeat
    if (mode === "top_per_heat") {
      const usedBottom = this.maxBottomFrom.get(fromRoundId) ?? 0;
      const minNeeded = opts?.count && opts.count > 0 ? opts.count : 1;
      if (usedBottom + minNeeded > this.pph) {
        return {
          valid: false,
          reason: `Cannot advance Top ${minNeeded} from “${fromR.title}”: Bottom ${usedBottom} already uses all ${this.pph} heat seats.`,
        };
      }
    } else if (mode === "bottom_per_heat") {
      const usedTop = this.maxTopFrom.get(fromRoundId) ?? 0;
      const minNeeded = opts?.count && opts.count > 0 ? opts.count : 1;
      if (usedTop + minNeeded > this.pph) {
        return {
          valid: false,
          reason: `Cannot advance Bottom ${minNeeded} from “${fromR.title}”: Top ${usedTop} already uses all ${this.pph} heat seats.`,
        };
      }
    }

    // Prevent Incoming Seeds cutoff overflow when auto-allocating next seed range
    if (mode === "stage_seeds" || fromIsHandoffIn) {
      if (this.stageSeedCap > 0 && this.maxExistingSeedEnd >= this.stageSeedCap) {
        return {
          valid: false,
          reason: `All ${this.stageSeedCap} incoming stage seeds (#1–#${this.stageSeedCap}) are already assigned.`,
        };
      }
    }

    // Prevent Finals single-group capacity overflow (accounting for Go's auto-rebalance of per-heat feeders)
    if (toR.bracketLane === "finals") {
      const fixedUsed = this.finalsFixedSeatsUsed.get(toRoundId) ?? 0;
      const autoSrcHeats = this.finalsAutoSrcHeats.get(toRoundId) ?? 0;
      const isAutoPerHeat =
        !(opts?.count && opts.count > 0) &&
        (mode === "top_per_heat" || mode === "bottom_per_heat");
      if (isAutoPerHeat) {
        const newSrcHeats = Math.max(1, (this.heatsByRound.get(fromRoundId) ?? []).length);
        const minTotalSeats = fixedUsed + autoSrcHeats + newSrcHeats;
        if (minTotalSeats > this.pph) {
          return {
            valid: false,
            reason: `Finals has ${this.pph} seats max (need at least ${minTotalSeats} seats across connected feeders).`,
          };
        }
      } else {
        let incomingCount: number;
        if (mode === "stage_seeds" || fromIsHandoffIn) {
          const minAlreadyUsed = fixedUsed + autoSrcHeats;
          const nextStart = this.maxExistingSeedEnd + 1;
          const nextEnd = Math.min(
            this.stageSeedCap > 0 ? this.stageSeedCap : nextStart + this.pph - 1,
            nextStart + Math.max(1, this.pph - minAlreadyUsed) - 1
          );
          incomingCount = Math.max(1, nextEnd - nextStart + 1);
        } else {
          incomingCount = this.estimateWireFeeders(fromRoundId, mode, opts?.count);
        }
        const minTotalSeats = fixedUsed + autoSrcHeats + incomingCount;
        if (minTotalSeats > this.pph) {
          return {
            valid: false,
            reason: `Finals has ${this.pph} seats max (${fixedUsed + autoSrcHeats}/${this.pph} seats in use; this link needs ${incomingCount}).`,
          };
        }
      }
    }

    return { valid: true, reason: "" };
  }

  public getValidTargetIds(fromRoundId: string, opts?: RoundValidateOptions): Set<string> {
    const valid = new Set<string>();
    for (const id of this.roundById.keys()) {
      if (this.validateConnection(fromRoundId, id, opts).valid) {
        valid.add(id);
      }
    }
    return valid;
  }
}

export function buildStageNetworkGraph(
  stages: RaceStage[],
  race: RaceTournamentState,
  excludeConnectionId = ""
): StageNetworkGraph {
  return new StageNetworkGraph(stages, race, excludeConnectionId);
}

export function buildRoundNetworkGraph(
  race: RaceTournamentState,
  stageIndex: number,
  stageRounds: RaceRound[],
  heatsByRound: Map<string, RaceHeat[]>,
  stageConnections: RoundConnection[],
  excludeConnectionId = ""
): RoundNetworkGraph {
  return new RoundNetworkGraph(
    race,
    stageIndex,
    stageRounds,
    heatsByRound,
    stageConnections,
    excludeConnectionId
  );
}
