import { buildRoundNetworkGraph } from "../core/connection_graph";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import {
  buildMultiBandCanvasOptions,
  decodeBandChannel,
  encodeBandChannel,
  formatBandChannelShort,
  formatEncodedChannelShort,
} from "../core/vtx_channels";
import { ApiClient } from "../services/api_client";
import {
  EventPilot,
  HeatState,
  PilotAttendance,
  QualifyingMetric,
  RaceHeat,
  RaceLifecycle,
  RaceRound,
  RaceStage,
  RaceTournamentState,
  RoundConnection,
  RoundConnectionMode,
  RoundPositionUpdate,
  StageFormat,
} from "../types/models";
import {
  CanvasSelectChangeDetail,
  CanvasSelectOption,
  closeCanvasSelectPopover,
  ensureCanvasSelectGlobalBinding,
  renderCanvasSelect,
} from "./CanvasSelect";
import { openConfirmModal } from "./ConfirmModal";
import {
  openOpenQualifierSettingsModal,
  openRoundCustomizeModal,
  openStageHandoffModal,
  openStageSettingsModal,
  openWireConnectionModal,
} from "./RoundModals";
import {
  cleanConnectionInvalidReason,
  notifyNewlyInvalidConnections,
  showToast,
} from "./Toast";
import {
  dismissWireDropMenu,
  flashSpawnedCanvasNode,
  openWireDropMenu,
  WireDropOption,
} from "./WireDropMenu";

export const STAGE1_HANDOFF_OUT_ID = "stage1-seeding-out";
export const STAGE2_HANDOFF_IN_ID = "stage2-seeds-in";
export const STAGE1_PILOTS_IN_ID = "stage1-pilots-in";

export function stageHandoffOutId(stageIndex: number): string {
  return `stage${Math.max(1, stageIndex)}-seeding-out`;
}

export function stageHandoffInId(stageIndex: number): string {
  return `stage${Math.max(1, stageIndex)}-seeds-in`;
}

export function stagePilotsInId(stageIndex: number): string {
  return `stage${Math.max(1, stageIndex)}-pilots-in`;
}

export function openQualRoundId(stageIndex: number): string {
  return `stage${Math.max(1, stageIndex)}-open-qual`;
}

export function isHandoffOutRoundId(roundOrId: RaceRound | string | undefined): boolean {
  const id = typeof roundOrId === "string" ? roundOrId : roundOrId?.id;
  if (!id) return false;
  return id === STAGE1_HANDOFF_OUT_ID || /^stage\d+-seeding-out$/.test(id);
}

export function isHandoffInRoundId(roundOrId: RaceRound | string | undefined): boolean {
  const id = typeof roundOrId === "string" ? roundOrId : roundOrId?.id;
  if (!id) return false;
  return id === STAGE2_HANDOFF_IN_ID || /^stage\d+-seeds-in$/.test(id);
}

export function isPilotsInRoundId(roundOrId: RaceRound | string | undefined): boolean {
  const id = typeof roundOrId === "string" ? roundOrId : roundOrId?.id;
  if (!id) return false;
  return id === STAGE1_PILOTS_IN_ID || /^stage\d+-pilots-in$/.test(id);
}

export function isOpenQualRoundId(roundOrId: RaceRound | string | undefined): boolean {
  const id = typeof roundOrId === "string" ? roundOrId : roundOrId?.id;
  if (!id) return false;
  return /^stage\d+-open-qual$/.test(id);
}

export function isRootStage(race: RaceTournamentState, viewStage: number): boolean {
  const stgIdx = Math.max(1, viewStage || 1);
  if ((race.stageConnections ?? []).some((sc) => !sc.invalid && sc.toStageIndex === stgIdx)) {
    return false;
  }
  if (stgIdx > 1 && !(race.stages && race.stages.length > 0)) {
    return false;
  }
  return true;
}

export function isHandoffPortalRound(roundOrId: RaceRound | string | undefined): boolean {
  return (
    isHandoffOutRoundId(roundOrId) ||
    isHandoffInRoundId(roundOrId) ||
    isPilotsInRoundId(roundOrId)
  );
}

export function isChaseHeatId(id?: string): boolean {
  return Boolean(id && (id.startsWith("CTA-") || id.includes("-CTA-")));
}

export function getPresentStageIndices(race: RaceTournamentState): number[] {
  if (race.stages && race.stages.length > 0) {
    return [...race.stages].map((s) => s.index).sort((a, b) => a - b);
  }
  if (race.totalStages >= 2) {
    return Array.from({ length: race.totalStages }, (_, i) => i + 1);
  }
  const set = new Set<number>();
  for (const h of race.heats) {
    if (h.stageIndex >= 1) set.add(h.stageIndex);
  }
  for (const r of race.rounds ?? []) {
    if (r.stageIndex >= 1) set.add(r.stageIndex);
  }
  if (set.size === 0) set.add(1);
  return Array.from(set).sort((a, b) => a - b);
}

export type CanvasTool = "select" | "pan";
export type OutputPortDir = "right" | "bottom";
export type PortSide = "left" | "right" | "top" | "bottom";

export interface StageCameraState {
  panX: number;
  panY: number;
  zoom: number;
  initialized?: boolean;
}

export interface BracketEditorUiState {
  connectingFromRoundId: string;
  connectingFromPortDir: OutputPortDir;
  openWireMenuId: string;
  openNodeMenuId: string;
  selectedRoundIds: Set<string>;
  panX: number;
  panY: number;
  zoom: number;
  cameraInitializedForRaceId: string;
  stageCameras: Record<number, StageCameraState>;
  onSwitchStage?: (stage: number) => void;
  onOpenFormat?: () => void;
  onPanelMoved?: (panelId: string, x: number, y: number) => void;
  onPanelFocus?: (panelId: string, panelEl: HTMLElement) => void;
  onCameraChanged?: () => void;
  onBoardContextAddMenu?: (
    clientX: number,
    clientY: number,
    worldX: number,
    worldY: number,
    viaTouchLongPress: boolean
  ) => void;
  tool: CanvasTool;
  nodesLocked: boolean;
  controlsExpanded: boolean;
  pilotsDrawerOpen: boolean;
  pilotsNodeFilter: "all" | "in" | "unseated" | "out";
  pilotsNodeSearch: string;
  pilotsNodeWalkupCallsign: string;
  activeGesture: boolean;
  optimisticPositions: Map<string, { x: number; y: number }>;
  rerender: () => void;
}

export function createDefaultBracketEditorUiState(rerender: () => void): BracketEditorUiState {
  return {
    connectingFromRoundId: "",
    connectingFromPortDir: "right",
    openWireMenuId: "",
    openNodeMenuId: "",
    selectedRoundIds: new Set<string>(),
    panX: 72,
    panY: 88,
    zoom: 1,
    cameraInitializedForRaceId: "",
    stageCameras: {},
    tool: "pan",
    nodesLocked: false,
    controlsExpanded: false,
    pilotsDrawerOpen: false,
    pilotsNodeFilter: "all",
    pilotsNodeSearch: "",
    pilotsNodeWalkupCallsign: "",
    activeGesture: false,
    optimisticPositions: new Map(),
    rerender,
  };
}

export interface BracketRenderOptions {
  activeHeatId: string;
  stageFilter?: number;
  interactive?: boolean;
  editable?: boolean;
  canvas?: boolean;
  hideGraphNodes?: boolean;
  controlBoundaryY?: number;
  extraWorldHtml?: string;
  raceRoster?: EventPilot[];
  editorUi?: BracketEditorUiState;
}

interface RenderedNodePos {
  x: number;
  y: number;
  baseX?: number;
  baseY?: number;
}

interface DragPayload {
  kind: "seat" | "pilot";
  fromHeatId?: string;
  fromSeatIndex?: number;
  pilotSlotIndex: number;
}

let activeDragPayload: DragPayload | null = null;

export const RC_NODE_WIDTH = 282;
export const RC_PILOTS_NODE_WIDTH = 348;
export const CONTROL_PANEL_BOTTOM_CLEARANCE = 20;
export const CONTROL_STAGE_TOP_CLEARANCE = 44;
export const DEFAULT_CONTROL_MIN_BOUNDARY_Y = 900;
const RC_COL_STRIDE = 456;
const RC_ORIGIN_X = 96;
const RC_ORIGIN_Y = 110;
const RC_NODE_STACK_GAP = 38;
const RC_LANE_GAP = 168;

export function clampZoom(z: number): number {
  return Math.max(0.22, Math.min(2.0, Math.round(z * 100) / 100));
}

export function raceLifecycleBadge(lifecycle?: RaceLifecycle): { label: string; cls: string } {
  switch (lifecycle) {
    case "active":
      return { label: "Active", cls: "is-live" };
    case "paused":
      return { label: "Paused", cls: "is-paused" };
    case "completed":
      return { label: "Completed", cls: "is-done" };
    case "scrapped":
      return { label: "Scrapped", cls: "is-stopped" };
    case "draft":
    default:
      return { label: "Setup", cls: "is-ready" };
  }
}

export function isRaceOngoing(r: RaceTournamentState | undefined): boolean {
  if (!r || !r.generated) return false;
  if (r.emergencyStopped) return false;
  if (r.lifecycle === "active") return true;
  return r.heats.some((h) => h.state === "countdown" || h.state === "running");
}

export function heatStateBadge(
  state: HeatState,
  inOvertime = false,
  note = ""
): { label: string; cls: string } {
  switch (state) {
    case "waiting":
      return { label: "Waiting", cls: "is-waiting" };
    case "ready":
      return { label: "Ready", cls: "is-ready" };
    case "staged":
      return { label: "Staged", cls: "is-staged" };
    case "countdown":
      return { label: "Countdown", cls: "is-live" };
    case "running":
      return inOvertime
        ? { label: "Overtime", cls: "is-warn" }
        : { label: "Racing", cls: "is-live" };
    case "paused":
      return { label: "Paused", cls: "is-paused" };
    case "finished":
      return { label: "Review", cls: "is-review" };
    case "confirmed":
      if (note === "Auto-advance (bye)") {
        return { label: "Bye", cls: "is-waiting" };
      }
      return { label: "Confirmed", cls: "is-done" };
    case "aborted":
      return { label: "Stopped", cls: "is-stopped" };
    default:
      return { label: state, cls: "is-waiting" };
  }
}

export function formatRaceClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const totalTenths = Math.floor(sec * 10 + 1e-6);
  const mins = Math.floor(totalTenths / 600);
  const remTenths = totalTenths - mins * 600;
  const whole = Math.floor(remTenths / 10);
  const tenths = remTenths - whole * 10;
  return `${String(mins).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${tenths}`;
}

export function formatShortSec(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  return `${sec.toFixed(2)}s`;
}

export function ordinal(n: number): string {
  if (n <= 0) return "—";
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export function isHeatUnstarted(state: HeatState): boolean {
  return state === "waiting" || state === "ready" || state === "staged";
}

export function isHeatCompletedOrRunning(h: { state: HeatState; note?: string }): boolean {
  if (h.state === "countdown" || h.state === "running" || h.state === "finished") {
    return true;
  }
  if (h.state === "confirmed" && h.note !== "Auto-advance (bye)") {
    return true;
  }
  return false;
}

export function formatStageLabel(fmt: string): string {
  switch (fmt) {
    case "double_elimination":
      return "Double Elimination";
    case "single_elimination":
      return "Single Elimination";
    case "chase_the_ace":
      return "Chase the Ace";
    case "points_mains":
      return "Points / A-B-C Mains";
    case "qualifying":
      return "Qualifying";
    case "open_qualifier":
      return "Open Qualifier";
    case "custom":
      return "Custom";
    default:
      return fmt;
  }
}

function deriveColumnTitle(list: RaceHeat[]): string {
  const first = list[0];
  if (!first) return "Round";
  if (first.stageName) return first.stageName;
  if (first.bracketLane === "finals") {
    if (isChaseHeatId(first.id)) {
      return list.length === 1 ? first.title : "Chase the Ace";
    }
    return "Grand Finals";
  }
  if (first.bracketLane === "losers") {
    return `Losers Rd ${first.round}`;
  }
  if (first.stageFormat === "qualifying") {
    return `Qualifying Rd ${first.round}`;
  }
  if (first.stageFormat === "points_mains") {
    return `Mains Rd ${first.round}`;
  }
  if (first.stageFormat === "chase_the_ace") {
    return `Race ${first.round}`;
  }
  return `Round ${first.round}`;
}

export function resolveStageRounds(
  race: RaceTournamentState,
  viewStage: number,
  stageHeats: RaceHeat[],
  includePilotsPortal = false
): { rounds: RaceRound[]; heatsByRound: Map<string, RaceHeat[]> } {
  const rawRounds = (race.rounds ?? []).filter((r) => r.stageIndex === viewStage);
  const heatsByRound = new Map<string, RaceHeat[]>();

  const maybePrependPilotsPortal = (baseRounds: RaceRound[]): RaceRound[] => {
    if (!includePilotsPortal || !isRootStage(race, viewStage)) {
      return baseRounds;
    }
    const pilotsId = stagePilotsInId(viewStage);
    if (baseRounds.some((r) => r.id === pilotsId)) {
      return baseRounds;
    }
    const stgObj = race.stages?.find((s) => s.index === viewStage);
    heatsByRound.set(pilotsId, []);
    const portalRound: RaceRound = {
      id: pilotsId,
      stageIndex: viewStage,
      round: 0,
      column: 0,
      bracketLane: "pilots_in",
      title: "Pilots Roster",
      stageFormat: stgObj?.format || "custom",
      targetLaps: 0,
      timeLimitSec: 0,
      hasPos: stgObj?.pilotsNodeHasPos,
      posX: stgObj?.pilotsNodePosX,
      posY: stgObj?.pilotsNodePosY,
    };
    return [portalRound, ...baseRounds];
  };

  if (rawRounds.length > 0) {
    for (const r of rawRounds) {
      const list: RaceHeat[] = [];
      for (const h of stageHeats) {
        if (h.roundId === r.id) {
          list.push(h);
        }
      }
      heatsByRound.set(r.id, list);
    }
    return { rounds: maybePrependPilotsPortal(rawRounds), heatsByRound };
  }

  const synth: RaceRound[] = [];
  const byKey = new Map<string, RaceHeat[]>();
  for (const h of stageHeats) {
    const col = h.column || h.round || 1;
    const lane = h.bracketLane || "winners";
    const key = h.roundId || `synth-s${viewStage}-c${col}-${lane}-r${h.round}`;
    const arr = byKey.get(key) ?? [];
    arr.push(h);
    byKey.set(key, arr);
  }
  for (const [id, list] of byKey.entries()) {
    const first = list[0];
    synth.push({
      id,
      stageIndex: viewStage,
      round: first.round || 1,
      column: first.column || first.round || 1,
      bracketLane: first.bracketLane || "winners",
      title: deriveColumnTitle(list),
      stageFormat: first.stageFormat,
      startMode: first.startMode,
      targetLaps: first.targetLaps,
      timeLimitSec: first.timeLimitSec,
    });
    heatsByRound.set(id, list);
  }
  synth.sort((a, b) => a.column - b.column || a.round - b.round);
  return { rounds: maybePrependPilotsPortal(synth), heatsByRound };
}

export function resolveStageConnections(
  race: RaceTournamentState,
  viewStage: number,
  stageRounds: RaceRound[],
  heatsByRound: Map<string, RaceHeat[]>
): RoundConnection[] {
  const explicit = (race.connections ?? []).filter((c) => c.stageIndex === viewStage);
  const out: RoundConnection[] = [...explicit];
  const seenPairs = new Set<string>();
  for (const c of explicit) {
    seenPairs.add(`${c.fromRoundId}->${c.toRoundId}`);
  }

  const heatToRound = new Map<string, string>();
  for (const r of stageRounds) {
    for (const h of heatsByRound.get(r.id) ?? []) {
      heatToRound.set(h.id, r.id);
    }
  }
  for (const edge of race.edges ?? []) {
    const fromRoundId = heatToRound.get(edge.fromHeatId);
    const toRoundId = heatToRound.get(edge.toHeatId);
    if (!fromRoundId || !toRoundId || fromRoundId === toRoundId) continue;
    const key = `${fromRoundId}->${toRoundId}`;
    if (!seenPairs.has(key)) {
      seenPairs.add(key);
      const mode: RoundConnectionMode = edge.isDrop ? "bottom_per_heat" : "top_per_heat";
      out.push({
        id: `edge-${fromRoundId}-${toRoundId}`,
        stageIndex: viewStage,
        fromRoundId,
        toRoundId,
        mode,
        count: Math.max(1, Math.floor((race.config.pilotsPerHeat || 4) / 2)),
      });
    }
  }

  const pilotsPortal = stageRounds.find((r) => isPilotsInRoundId(r.id));
  if (pilotsPortal) {
    for (const r of stageRounds) {
      if (isHandoffPortalRound(r)) continue;
      const hasValidIncoming = out.some((c) => !c.invalid && c.toRoundId === r.id);
      if (hasValidIncoming) continue;
      const isSeededFromPilots =
        r.seedSource === "all_active_pilots" ||
        (isOpenQualRoundId(r.id) && r.seedSource !== "empty") ||
        (r.column === 1 && r.seedSource !== "empty" && r.seedSource !== "stage_seeds");
      if (!isSeededFromPilots) continue;
      const key = `${pilotsPortal.id}->${r.id}`;
      if (!seenPairs.has(key)) {
        seenPairs.add(key);
        const dist =
          r.seedDistribution === "snake" || r.seedDistribution === "random"
            ? r.seedDistribution
            : "roster";
        const toPort: "left" | "top" | "bottom" =
          r.seedToPort === "top" || r.seedToPort === "bottom" ? r.seedToPort : "left";
        out.push({
          id: `conn-${pilotsPortal.id}-${r.id}`,
          stageIndex: viewStage,
          fromRoundId: pilotsPortal.id,
          toRoundId: r.id,
          fromPort: "right",
          toPort,
          mode: "pilots_in",
          count: 0,
          distribution: dist,
        });
      }
    }
  }

  return out;
}

function defaultLinkModeForOutputPort(
  _race: RaceTournamentState,
  fromRoundId: string,
  portDir: OutputPortDir,
  toRoundId?: string
): RoundConnectionMode | undefined {
  if (isPilotsInRoundId(fromRoundId)) return "pilots_in";
  if (isHandoffInRoundId(fromRoundId)) return "stage_seeds";
  if (isHandoffOutRoundId(toRoundId)) return "qual_feed";
  if (portDir === "bottom") return "bottom_per_heat";
  // Omit linkMode for right-port connections between normal rounds so backend smart inference
  // automatically picks all_pilots (Balanced Qualifying), bottom_per_heat (Winners -> Redemption),
  // standings_top, or [1..3] picks/heat with automatic downstream heat expansion.
  return undefined;
}

function laneSortOrder(lane: string): number {
  switch (lane) {
    case "pilots_in":
    case "handoff_in":
      return 0;
    case "qualifying":
      return 1;
    case "winners":
      return 2;
    case "mains":
      return 3;
    case "finals":
      return 4;
    case "losers":
      return 5;
    case "handoff_out":
      return 7;
    default:
      return 6;
  }
}

function estimateNodeHeight(
  heats: RaceHeat[],
  seatsPerHeat: number,
  round?: RaceRound,
  measuredHeights?: Map<string, number>
): number {
  if (round && measuredHeights) {
    const measured = measuredHeights.get(round.id);
    if (typeof measured === "number" && measured > 40) {
      return measured;
    }
  }
  if (round && (isPilotsInRoundId(round) || round.bracketLane === "pilots_in")) {
    return 480;
  }
  if (
    round &&
    (isHandoffPortalRound(round) ||
      round.bracketLane === "handoff_out" ||
      round.bracketLane === "handoff_in")
  ) {
    return 276;
  }
  if (round && (isOpenQualRoundId(round) || round.stageFormat === "open_qualifier")) {
    return 292;
  }
  const hc = Math.max(1, heats.length);
  const perHeat = 50 + Math.max(2, seatsPerHeat) * 29;
  return 82 + hc * perHeat + Math.max(0, hc - 1) * 8;
}

export function readNodeWorldPos(nodeEl: HTMLElement): { x: number; y: number } {
  const rawX = nodeEl.dataset.posX;
  const rawY = nodeEl.dataset.posY;
  if (rawX !== undefined && rawX !== "" && rawY !== undefined && rawY !== "") {
    const dx = Number(rawX);
    const dy = Number(rawY);
    if (Number.isFinite(dx) && Number.isFinite(dy)) {
      return { x: dx, y: dy };
    }
  }
  const tf = nodeEl.style.transform || "";
  const m = tf.match(/translate3d\(\s*([-\d.]+)px,\s*([-\d.]+)px/);
  if (m) {
    return {
      x: parseFloat(m[1]) || 0,
      y: parseFloat(m[2]) || 0,
    };
  }
  return {
    x: parseFloat(nodeEl.style.left) || 0,
    y: parseFloat(nodeEl.style.top) || 0,
  };
}

export function setNodeWorldPos(nodeEl: HTMLElement, x: number, y: number): void {
  nodeEl.dataset.posX = String(x);
  nodeEl.dataset.posY = String(y);
  nodeEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

/**
 * Returns `true` only when deleting `roundId` would affect existing connections,
 * unseat assigned pilots, or involve started heats — allowing empty unconnected rounds
 * to delete immediately without an unnecessary confirmation modal.
 */
export function roundNeedsDeleteConfirmation(
  race: RaceTournamentState,
  roundId: string
): boolean {
  if (!roundId) return false;
  const roundObj = (race.rounds ?? []).find((r) => r.id === roundId);
  const viewStage = roundObj?.stageIndex || race.activeStageIndex || 1;
  const stageHeats = race.heats.filter((h) => h.stageIndex === viewStage);
  const { rounds, heatsByRound } = resolveStageRounds(race, viewStage, stageHeats);
  const stageConns = resolveStageConnections(race, viewStage, rounds, heatsByRound);

  const hasConnections = stageConns.some(
    (c) => c.fromRoundId === roundId || c.toRoundId === roundId
  );
  if (hasConnections) return true;

  const roundHeats = heatsByRound.get(roundId) ?? race.heats.filter((h) => h.roundId === roundId);
  if (roundHeats.length > 1) return true;
  if (roundObj) {
    const stgObj = (race.stages ?? []).find((s) => s.index === viewStage);
    const stgSettings = stgObj?.settings ?? race.config;
    const defPph = stgSettings.pilotsPerHeat || race.config.pilotsPerHeat || 4;
    const isOpenQualRound =
      isOpenQualRoundId(roundObj) || roundObj.stageFormat === "open_qualifier";
    const isQualRound =
      roundObj.stageFormat === "qualifying" || roundObj.bracketLane === "qualifying";
    const defLaps = isQualRound
      ? 0
      : isOpenQualRound
        ? stgSettings.targetLaps ?? race.config.targetLaps ?? 0
        : stgSettings.targetLaps || race.config.targetLaps || 3;
    const defTime = stgSettings.timeLimitSec || race.config.timeLimitSec || 120;
    const hasCustomStartMode =
      roundObj.startMode === "staggered" && !isQualRound && !isOpenQualRound;
    if (
      Boolean(roundObj.pilotsPerHeat && roundObj.pilotsPerHeat !== defPph) ||
      Boolean(
        !isOpenQualRound && roundObj.targetLaps !== undefined && roundObj.targetLaps !== defLaps
      ) ||
      Boolean(roundObj.timeLimitSec && roundObj.timeLimitSec !== defTime) ||
      hasCustomStartMode ||
      Boolean(roundObj.seatChannels && roundObj.seatChannels.length > 0)
    ) {
      return true;
    }
  }
  for (const h of roundHeats) {
    if (!isHeatUnstarted(h.state)) return true;
    if (h.seats.some((s) => s.pilotSlotIndex > 0 || (s.laps?.length ?? 0) > 0)) return true;
  }
  return false;
}

/**
 * Snapshots the current on-screen world `(posX, posY)` of every round in `viewStage`
 * so graph edits (`disconnect_rounds`, `delete_round`, `connect_rounds`, `reconnect_connection`)
 * never unexpectedly shift card positions on the canvas.
 */
export function collectStageRoundPositions(
  contextEl: Element | null | undefined,
  race: RaceTournamentState,
  viewStage: number,
  ui?: BracketEditorUiState
): RoundPositionUpdate[] {
  const world =
    contextEl?.closest?.("[data-bkt-graph]") ??
    contextEl?.querySelector?.("[data-bkt-graph]") ??
    null;
  const includePilots = world?.getAttribute("data-bkt-editable") === "1";
  const stageHeats = race.heats.filter((h) => h.stageIndex === viewStage);
  const { rounds, heatsByRound } = resolveStageRounds(
    race,
    viewStage,
    stageHeats,
    includePilots || isRootStage(race, viewStage)
  );
  if (rounds.length === 0) return [];
  const stageConns = resolveStageConnections(race, viewStage, rounds, heatsByRound);
  const fallbackMap = computeRoundPositions(
    rounds,
    heatsByRound,
    race.config.pilotsPerHeat || 4,
    ui,
    stageConns
  );

  const domPos = new Map<string, { x: number; y: number }>();
  if (world && world.hasAttribute("data-rc-world")) {
    const isControl = !!world.closest(".is-control-canvas");
    world.querySelectorAll<HTMLElement>("[data-round-node]").forEach((nodeEl) => {
      const rid = nodeEl.dataset.roundNode ?? "";
      if (!rid) return;
      if (
        isControl &&
        nodeEl.dataset.basePosX !== undefined &&
        nodeEl.dataset.basePosY !== undefined
      ) {
        const bx = Number(nodeEl.dataset.basePosX);
        const by = Number(nodeEl.dataset.basePosY);
        if (Number.isFinite(bx) && Number.isFinite(by)) {
          domPos.set(rid, { x: bx, y: by });
          return;
        }
      }
      domPos.set(rid, readNodeWorldPos(nodeEl));
    });
  }

  const out: RoundPositionUpdate[] = [];
  for (const r of rounds) {
    const p = domPos.get(r.id) ?? fallbackMap.get(r.id);
    if (p) {
      out.push({
        roundId: r.id,
        posX: Math.round(p.x * 10) / 10,
        posY: Math.round(p.y * 10) / 10,
      });
    }
  }
  return out;
}

function isUpperBracketLane(lane?: string): boolean {
  return (
    lane === "winners" ||
    lane === "qualifying" ||
    lane === "mains" ||
    !lane
  );
}

/**
 * Derives clean, horizontally-aligned columns for every round in the stage from valid
 * connections and round roles:
 * - `handoff_in` (`Qualifying Seeds`) sits at column 0
 * - Upper -> Losers `bottom_per_heat` drops align directly underneath (`col >= col(from)`)
 * - Horizontal advances step right (`col >= col(from) + 1`)
 * - Parallel qualifying rounds feeding `Stage 2 Seeding` stack cleanly in column 1
 * - `finals` sits to the right of all non-finals rounds
 * - `handoff_out` (`Stage 2 Seeding`) sits at the rightmost column
 */
function deriveSmartRoundColumns(
  stageRounds: RaceRound[],
  stageConnections: RoundConnection[]
): Map<string, number> {
  const cols = new Map<string, number>();
  const roundById = new Map<string, RaceRound>();
  for (const r of stageRounds) {
    roundById.set(r.id, r);
  }

  const validConns = stageConnections.filter(
    (c) =>
      !c.invalid &&
      c.fromRoundId &&
      c.toRoundId &&
      c.fromRoundId !== c.toRoundId &&
      roundById.has(c.fromRoundId) &&
      roundById.has(c.toRoundId)
  );

  const nonPortalInCount = new Map<string, number>();
  const feedsHandoffOut = new Set<string>();
  for (const c of validConns) {
    if (isHandoffOutRoundId(c.toRoundId)) {
      feedsHandoffOut.add(c.fromRoundId);
      continue;
    }
    if (isHandoffInRoundId(c.fromRoundId) || isPilotsInRoundId(c.fromRoundId)) {
      continue;
    }
    nonPortalInCount.set(c.toRoundId, (nonPortalInCount.get(c.toRoundId) ?? 0) + 1);
  }

  for (const r of stageRounds) {
    if (
      isHandoffInRoundId(r.id) ||
      isPilotsInRoundId(r.id) ||
      r.bracketLane === "handoff_in" ||
      r.bracketLane === "pilots_in"
    ) {
      cols.set(r.id, 0);
    } else if (isHandoffOutRoundId(r.id) || r.bracketLane === "handoff_out") {
      cols.set(r.id, 2);
    } else if ((nonPortalInCount.get(r.id) ?? 0) > 0) {
      cols.set(r.id, 1);
    } else if (feedsHandoffOut.has(r.id) && r.stageFormat === "qualifying") {
      // Parallel qualifying rounds feeding Stage Seeding stack in Col 1 so wires never cross nodes
      cols.set(r.id, 1);
    } else {
      cols.set(r.id, Math.max(1, r.column || 1));
    }
  }

  const maxPasses = stageRounds.length + 2;
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    for (const c of validConns) {
      if (
        isHandoffInRoundId(c.fromRoundId) ||
        isPilotsInRoundId(c.fromRoundId) ||
        isHandoffOutRoundId(c.toRoundId) ||
        isHandoffInRoundId(c.toRoundId) ||
        isPilotsInRoundId(c.toRoundId)
      ) {
        continue;
      }
      const fromR = roundById.get(c.fromRoundId)!;
      const toR = roundById.get(c.toRoundId)!;
      const fromCol = cols.get(fromR.id) ?? 1;
      const isVerticalDrop =
        c.mode === "bottom_per_heat" &&
        isUpperBracketLane(fromR.bracketLane) &&
        toR.bracketLane === "losers";
      const minToCol = isVerticalDrop ? fromCol : fromCol + 1;
      if ((cols.get(toR.id) ?? 1) < minToCol) {
        cols.set(toR.id, minToCol);
        changed = true;
      }
    }
    if (!changed) break;
  }

  let maxNonFinalsCol = 1;
  for (const r of stageRounds) {
    if (isHandoffPortalRound(r) || r.bracketLane === "finals") continue;
    const c = cols.get(r.id) ?? 1;
    if (c > maxNonFinalsCol) maxNonFinalsCol = c;
  }
  for (const r of stageRounds) {
    if (r.bracketLane === "finals" && !isHandoffPortalRound(r)) {
      const hasAnyOther = stageRounds.some(
        (o) => o.id !== r.id && !isHandoffPortalRound(o) && o.bracketLane !== "finals"
      );
      if (hasAnyOther) {
        cols.set(r.id, Math.max(cols.get(r.id) ?? 1, maxNonFinalsCol + 1));
      }
    }
  }

  let maxRegularCol = 1;
  for (const r of stageRounds) {
    if (isHandoffPortalRound(r)) continue;
    const c = cols.get(r.id) ?? 1;
    if (c > maxRegularCol) maxRegularCol = c;
  }
  for (const r of stageRounds) {
    if (isHandoffOutRoundId(r.id) || r.bracketLane === "handoff_out") {
      cols.set(r.id, maxRegularCol + 1);
    }
  }

  return cols;
}

/**
 * Computes format-aware topological positions for rounds that don't have manual coordinates (`!hasPos`),
 * while preserving explicit `(posX, posY)` (and in-flight optimistic moves):
 * - Double Elimination / Two-Lane stages: establishes dedicated Upper (`winners`) and Lower (`losers`)
 *   horizontal lanes, aligns drop-feeding columns directly vertically (`W1` above `L1`, `W2` above `L2`),
 *   vertically centers each column within its own lane to form symmetrical triangular funnels pointing
 *   toward `Finals`, and centers `Finals` vertically between the two lanes.
 * - Single-Lane stages (Single Elimination, Qualifying, Points / A-B-C Mains, Custom DAGs): orders
 *   same-column rounds by seed slice / upstream barycenter Y so feed wires never cross, and centers
 *   each column vertically along a unified horizontal spine.
 */
export function computeRoundPositions(
  stageRounds: RaceRound[],
  heatsByRound: Map<string, RaceHeat[]>,
  pilotsPerHeat: number,
  ui?: BracketEditorUiState,
  stageConnections: RoundConnection[] = [],
  measuredHeights?: Map<string, number>
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (stageRounds.length === 0) return out;

  const smartCols = deriveSmartRoundColumns(stageRounds, stageConnections);
  const byCol = new Map<number, RaceRound[]>();
  for (const r of stageRounds) {
    const col = smartCols.get(r.id) ?? Math.max(1, r.column || 1);
    const list = byCol.get(col) ?? [];
    list.push(r);
    byCol.set(col, list);
  }

  const validConns = stageConnections.filter((c) => !c.invalid);
  const seedOrderForRound = (roundId: string): number => {
    let best = Infinity;
    for (const c of validConns) {
      if (c.toRoundId === roundId && (c.mode === "stage_seeds" || isHandoffInRoundId(c.fromRoundId))) {
        const s = Math.max(1, c.seedStart || 1);
        if (s < best) best = s;
      }
    }
    return best;
  };

  const sortedCols = Array.from(byCol.entries()).sort((a, b) => a[0] - b[0]);
  const hasLowerLane = stageRounds.some((r) => r.bracketLane === "losers");
  const hasUpperLane = stageRounds.some(
    (r) => !isHandoffPortalRound(r) && isUpperBracketLane(r.bracketLane)
  );

  const applyResolvedPos = (r: RaceRound, autoX: number, autoY: number): { x: number; y: number } => {
    const opt = ui?.optimisticPositions.get(r.id);
    if (opt) {
      const p = { x: opt.x, y: opt.y };
      out.set(r.id, p);
      return p;
    }
    if (r.hasPos) {
      const p = {
        x: typeof r.posX === "number" ? r.posX : 0,
        y: typeof r.posY === "number" ? r.posY : 0,
      };
      out.set(r.id, p);
      return p;
    }
    const p = { x: autoX, y: autoY };
    out.set(r.id, p);
    return p;
  };

  if (hasLowerLane && hasUpperLane) {
    let maxUpperColH = 220;
    let maxLowerColH = 220;

    for (const [, list] of sortedCols) {
      list.sort(
        (a, b) =>
          seedOrderForRound(a.id) - seedOrderForRound(b.id) ||
          laneSortOrder(a.bracketLane) - laneSortOrder(b.bracketLane) ||
          a.round - b.round
      );
      let upperH = 0;
      let upperCnt = 0;
      let lowerH = 0;
      let lowerCnt = 0;
      for (const r of list) {
        if (
          r.bracketLane === "finals" ||
          r.bracketLane === "handoff_in" ||
          r.bracketLane === "handoff_out" ||
          isHandoffPortalRound(r)
        ) {
          continue;
        }
        const h = estimateNodeHeight(heatsByRound.get(r.id) ?? [], pilotsPerHeat, r, measuredHeights);
        if (r.bracketLane === "losers") {
          lowerH += h + (lowerCnt > 0 ? RC_NODE_STACK_GAP : 0);
          lowerCnt++;
        } else {
          upperH += h + (upperCnt > 0 ? RC_NODE_STACK_GAP : 0);
          upperCnt++;
        }
      }
      if (upperH > maxUpperColH) maxUpperColH = upperH;
      if (lowerH > maxLowerColH) maxLowerColH = lowerH;
    }

    const upperBandTop = RC_ORIGIN_Y;
    const upperCenterY = upperBandTop + maxUpperColH / 2;
    const lowerBandTop = upperBandTop + maxUpperColH + RC_LANE_GAP;
    const lowerCenterY = lowerBandTop + maxLowerColH / 2;
    const finalsMidY = (upperCenterY + lowerCenterY) / 2;

    sortedCols.forEach(([, list], visualColIdx) => {
      const autoX = RC_ORIGIN_X + visualColIdx * RC_COL_STRIDE;

      const upperInCol = list.filter(
        (r) => !isHandoffPortalRound(r) && isUpperBracketLane(r.bracketLane)
      );
      const lowerInCol = list.filter((r) => r.bracketLane === "losers");
      const finalsInCol = list.filter((r) => r.bracketLane === "finals");
      const portalsInCol = list.filter(
        (r) =>
          isHandoffPortalRound(r) ||
          r.bracketLane === "handoff_in" ||
          r.bracketLane === "handoff_out"
      );

      const sumStackH = (arr: RaceRound[]): number =>
        arr.reduce(
          (acc, r, i) =>
            acc +
            estimateNodeHeight(heatsByRound.get(r.id) ?? [], pilotsPerHeat, r, measuredHeights) +
            (i > 0 ? RC_NODE_STACK_GAP : 0),
          0
        );

      const upperTotalH = sumStackH(upperInCol);
      const lowerTotalH = sumStackH(lowerInCol);
      const finalsTotalH = sumStackH(finalsInCol);
      const portalsTotalH = sumStackH(portalsInCol);

      // Center each column vertically around its lane centerline to form the triangular funnel!
      let curUpperY = Math.max(48, Math.round(upperCenterY - upperTotalH / 2));
      let curLowerY = Math.max(lowerBandTop, Math.round(lowerCenterY - lowerTotalH / 2));
      let curFinalsY = Math.max(upperBandTop, Math.round(finalsMidY - finalsTotalH / 2));

      // Center `Qualifying Seeds` / `Checked-In Pilots` on the upper lane spine, and `Stage 2 Seeding` on finalsMidY
      const portalTargetMidY = portalsInCol.some(
        (p) =>
          isHandoffInRoundId(p.id) ||
          isPilotsInRoundId(p.id) ||
          p.bracketLane === "handoff_in" ||
          p.bracketLane === "pilots_in"
      )
        ? upperCenterY
        : finalsMidY;
      let curPortalY = Math.max(48, Math.round(portalTargetMidY - portalsTotalH / 2));

      for (const r of list) {
        const estH = estimateNodeHeight(
          heatsByRound.get(r.id) ?? [],
          pilotsPerHeat,
          r,
          measuredHeights
        );
        let autoY: number;
        if (
          isHandoffPortalRound(r) ||
          r.bracketLane === "handoff_in" ||
          r.bracketLane === "handoff_out"
        ) {
          autoY = curPortalY;
          curPortalY += estH + RC_NODE_STACK_GAP;
        } else if (r.bracketLane === "losers") {
          autoY = curLowerY;
          curLowerY += estH + RC_NODE_STACK_GAP;
        } else if (r.bracketLane === "finals") {
          autoY = curFinalsY;
          curFinalsY += estH + RC_NODE_STACK_GAP;
        } else {
          autoY = curUpperY;
          curUpperY += estH + RC_NODE_STACK_GAP;
        }
        applyResolvedPos(r, autoX, autoY);
      }
    });

    return out;
  }

  let maxColHeight = 0;
  const colHeights = new Map<number, number>();

  for (const [col, list] of sortedCols) {
    let totalH = 0;
    for (let i = 0; i < list.length; i++) {
      const h = estimateNodeHeight(
        heatsByRound.get(list[i].id) ?? [],
        pilotsPerHeat,
        list[i],
        measuredHeights
      );
      totalH += h + (i > 0 ? RC_NODE_STACK_GAP : 0);
    }
    colHeights.set(col, totalH);
    if (totalH > maxColHeight) maxColHeight = totalH;
  }

  const spineCenterY = RC_ORIGIN_Y + Math.max(180, maxColHeight / 2);
  const placedCenterY = new Map<string, number>();

  const upstreamBarycenterY = (roundId: string): number => {
    let sum = 0;
    let cnt = 0;
    for (const c of validConns) {
      if (c.toRoundId === roundId) {
        const py = placedCenterY.get(c.fromRoundId);
        if (typeof py === "number") {
          sum += py;
          cnt++;
        }
      }
    }
    return cnt > 0 ? sum / cnt : Infinity;
  };

  sortedCols.forEach(([col, list], visualColIdx) => {
    // Order rounds within the column by seed slice, then upstream neighbor Y (barycenter), so wires never cross!
    list.sort((a, b) => {
      const sa = seedOrderForRound(a.id);
      const sb = seedOrderForRound(b.id);
      if (sa !== sb) return sa - sb;
      const ba = upstreamBarycenterY(a.id);
      const bb = upstreamBarycenterY(b.id);
      if (Number.isFinite(ba) && Number.isFinite(bb) && Math.abs(ba - bb) > 4) {
        return ba - bb;
      }
      return laneSortOrder(a.bracketLane) - laneSortOrder(b.bracketLane) || a.round - b.round;
    });

    const colTotalH = colHeights.get(col) ?? 220;
    const autoX = RC_ORIGIN_X + visualColIdx * RC_COL_STRIDE;
    let cursorY = Math.max(60, Math.round(spineCenterY - colTotalH / 2));

    for (const r of list) {
      const estH = estimateNodeHeight(
        heatsByRound.get(r.id) ?? [],
        pilotsPerHeat,
        r,
        measuredHeights
      );
      const pos = applyResolvedPos(r, autoX, cursorY);
      placedCenterY.set(r.id, pos.y + estH / 2);
      cursorY += estH + RC_NODE_STACK_GAP;
    }
  });

  return out;
}

/**
 * Computes a clean world-space spawn coordinate for a newly added Round node on the canvas.
 * Places `+ Redemption` (`losers`) rounds in a second horizontal row underneath the Upper row!
 */
export function suggestNewRoundSpawnPosition(
  race: RaceTournamentState,
  ui: BracketEditorUiState,
  viewportWidth = 1200,
  viewportHeight = 720,
  presetKind: "race" | "qualifying" | "open_qualifier" | "zippyq_qualifier" | "losers" | "finals" | "seeded" = "race",
  stageOverride?: number
): { x: number; y: number } {
  const viewStage = stageOverride || race.activeStageIndex || 1;
  const stageHeats = race.heats.filter((h) => h.stageIndex === viewStage);
  const { rounds, heatsByRound } = resolveStageRounds(
    race,
    viewStage,
    stageHeats,
    isRootStage(race, viewStage)
  );
  const stageConnections = resolveStageConnections(race, viewStage, rounds, heatsByRound);
  const nonPortalRounds = rounds.filter((r) => !isHandoffPortalRound(r));
  if (rounds.length === 0) {
    const cx = (-ui.panX + viewportWidth * 0.32) / (ui.zoom || 1);
    const cy = (-ui.panY + viewportHeight * 0.2) / (ui.zoom || 1);
    return {
      x: Math.round(Math.max(80, cx)),
      y: Math.round(Math.max(96, cy)),
    };
  }

  const pph = race.config.pilotsPerHeat || 4;
  const positions = computeRoundPositions(rounds, heatsByRound, pph, ui, stageConnections);

  if (nonPortalRounds.length === 0) {
    const portalIn = rounds.find(
      (r) => isHandoffInRoundId(r.id) || isPilotsInRoundId(r.id)
    );
    if (portalIn) {
      const p = positions.get(portalIn.id) ?? { x: RC_ORIGIN_X, y: RC_ORIGIN_Y };
      return { x: Math.round(p.x + RC_COL_STRIDE), y: Math.round(p.y) };
    }
    return { x: RC_ORIGIN_X, y: RC_ORIGIN_Y };
  }

  if (presetKind === "losers") {
    const loserRounds = nonPortalRounds.filter((r) => r.bracketLane === "losers");
    if (loserRounds.length > 0) {
      let maxLx = -Infinity;
      let refLy = RC_ORIGIN_Y + 380;
      for (const r of loserRounds) {
        const p = positions.get(r.id);
        if (p && p.x >= maxLx) {
          maxLx = p.x;
          refLy = p.y;
        }
      }
      return { x: Math.round(maxLx + RC_COL_STRIDE), y: Math.round(refLy) };
    }

    // First Redemption round: place it directly underneath the first Upper round to start the lower chart!
    let minUpperX = Infinity;
    let maxUpperBottom = RC_ORIGIN_Y + 240;
    for (const r of nonPortalRounds) {
      if (r.bracketLane === "finals") continue;
      const p = positions.get(r.id);
      if (!p) continue;
      if (p.x < minUpperX) minUpperX = p.x;
      const bottom = p.y + estimateNodeHeight(heatsByRound.get(r.id) ?? [], pph, r);
      if (bottom > maxUpperBottom) maxUpperBottom = bottom;
    }
    return {
      x: Math.round(Number.isFinite(minUpperX) ? minUpperX : RC_ORIGIN_X),
      y: Math.round(maxUpperBottom + RC_LANE_GAP),
    };
  }

  if (presetKind === "finals") {
    let maxAllX = -Infinity;
    let minY = Infinity;
    let maxBottom = -Infinity;
    for (const r of nonPortalRounds) {
      const p = positions.get(r.id);
      if (!p) continue;
      if (p.x > maxAllX) maxAllX = p.x;
      if (p.y < minY) minY = p.y;
      const b = p.y + estimateNodeHeight(heatsByRound.get(r.id) ?? [], pph, r);
      if (b > maxBottom) maxBottom = b;
    }
    const finalsEstH = estimateNodeHeight([], pph);
    const midY =
      Number.isFinite(minY) && Number.isFinite(maxBottom)
        ? Math.max(minY, (minY + maxBottom) / 2 - finalsEstH / 2)
        : RC_ORIGIN_Y;
    return {
      x: Math.round((Number.isFinite(maxAllX) ? maxAllX : RC_ORIGIN_X) + RC_COL_STRIDE),
      y: Math.round(midY),
    };
  }

  // Upper / Qualifying / Seeded round: continue along the Upper chart row!
  const upperRounds = nonPortalRounds.filter(
    (r) => r.bracketLane !== "losers" && r.bracketLane !== "finals"
  );
  const pool = upperRounds.length > 0 ? upperRounds : nonPortalRounds;
  let maxX = -Infinity;
  let refY = RC_ORIGIN_Y;
  for (const r of pool) {
    const p = positions.get(r.id);
    if (p && p.x >= maxX) {
      maxX = p.x;
      refY = p.y;
    }
  }
  return {
    x: Math.round((Number.isFinite(maxX) ? maxX : RC_ORIGIN_X) + RC_COL_STRIDE),
    y: Math.round(refY),
  };
}

/**
 * Fits all visible `.bkt-round-node` and `.rc-canvas-panel` elements inside the `.races-canvas` viewport.
 */
export function fitCanvasToNodes(root: HTMLElement, ui: BracketEditorUiState): void {
  const rc = root.querySelector<HTMLElement>("[data-rc-viewport]");
  if (!rc) return;
  const rcRect = rc.getBoundingClientRect();
  if (rcRect.width <= 0 || rcRect.height <= 0) return;

  const nodesWrap = rc.querySelector<HTMLElement>(".rc-nodes");
  const nodesHidden = !!nodesWrap?.hasAttribute("hidden");
  const nodes = nodesHidden
    ? []
    : Array.from(rc.querySelectorAll<HTMLElement>("[data-round-node]"));
  const panels = Array.from(
    rc.querySelectorAll<HTMLElement>(".rc-canvas-panel[data-canvas-panel]:not([hidden])")
  );

  if (nodes.length === 0 && panels.length === 0) {
    ui.panX = 96;
    ui.panY = 88;
    ui.zoom = 1;
    applyCanvasCameraDom(rc, ui);
    return;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const n of nodes) {
    const { x, y } = readNodeWorldPos(n);
    const w = n.offsetWidth || RC_NODE_WIDTH;
    const h = n.offsetHeight || 220;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }

  for (const p of panels) {
    const { x, y } = readNodeWorldPos(p);
    const w = p.offsetWidth || 580;
    const h = p.offsetHeight || 260;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }

  const hasSubRibbon = Boolean(rc.querySelector("[data-dte-race-summary]"));
  const padTop = hasSubRibbon ? 86 : 58;
  const padBottom = 64;
  const padX = 52;
  const availW = Math.max(200, rcRect.width - padX * 2);
  const availH = Math.max(160, rcRect.height - padTop - padBottom);
  const contentW = Math.max(200, maxX - minX);
  const contentH = Math.max(150, maxY - minY);

  const fitZ = clampZoom(Math.min(1.02, availW / contentW, availH / contentH));
  ui.zoom = fitZ;
  ui.panX = (rcRect.width - contentW * fitZ) / 2 - minX * fitZ;
  ui.panY = padTop + (availH - contentH * fitZ) / 2 - minY * fitZ;
  applyCanvasCameraDom(rc, ui);
}

/**
 * Frames the first two rows of Control Dashboard panels (`cockpit` on Row 1, plus Row 2 panels
 * such as `flightline` + `schedule` or `schedule` + `standings`) cleanly inside the viewport box
 * on initial entry or Fit-to-View reset.
 */
export function fitCanvasToControlDashboard(root: HTMLElement, ui: BracketEditorUiState): void {
  const rc = root.querySelector<HTMLElement>("[data-rc-viewport]");
  if (!rc) return;
  const rcRect = rc.getBoundingClientRect();
  if (rcRect.width <= 0 || rcRect.height <= 0) return;

  const panels = Array.from(
    rc.querySelectorAll<HTMLElement>(
      '.rc-canvas-panel[data-canvas-panel="cockpit"]:not([hidden]), .rc-canvas-panel[data-canvas-panel="flightline"]:not([hidden]), .rc-canvas-panel[data-canvas-panel="schedule"]:not([hidden]), .rc-canvas-panel[data-canvas-panel="standings"]:not([hidden])'
    )
  );
  if (panels.length === 0) {
    fitCanvasToNodes(root, ui);
    return;
  }

  const measured = panels
    .map((p) => {
      const { x, y } = readNodeWorldPos(p);
      const w = p.offsetWidth || 600;
      const h = p.offsetHeight || 360;
      return { p, x, y, w, h };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);

  // Group panels into horizontal rows by Y coordinate and fit the first 2 rows in the viewport box!
  const rows: Array<typeof measured> = [];
  for (const item of measured) {
    const lastRow = rows[rows.length - 1];
    if (!lastRow || Math.abs(item.y - lastRow[0].y) > 120) {
      rows.push([item]);
    } else {
      lastRow.push(item);
    }
  }
  const firstTwoRows = rows.slice(0, 2).flat();
  const targetItems = firstTwoRows.length > 0 ? firstTwoRows : measured;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const item of targetItems) {
    if (item.x < minX) minX = item.x;
    if (item.y < minY) minY = item.y;
    if (item.x + item.w > maxX) maxX = item.x + item.w;
    if (item.y + item.h > maxY) maxY = item.y + item.h;
  }

  const isMobile = rcRect.width <= 768;
  const padTop = isMobile ? 52 : 56;
  const padBottom = isMobile ? 60 : 44;
  const padX = isMobile ? 14 : 36;
  const availW = Math.max(180, rcRect.width - padX * 2);
  const availH = Math.max(180, rcRect.height - padTop - padBottom);
  const contentW = Math.max(240, maxX - minX);
  const contentH = Math.max(200, maxY - minY);

  const fitZ = clampZoom(Math.min(1.0, availW / contentW, availH / contentH));
  ui.zoom = fitZ;
  ui.panX = (rcRect.width - contentW * fitZ) / 2 - minX * fitZ;
  ui.panY = padTop - minY * fitZ;
  applyCanvasCameraDom(rc, ui);
}

export function applyCanvasCameraDom(rc: HTMLElement, ui: BracketEditorUiState): void {
  if (rc.scrollLeft !== 0) rc.scrollLeft = 0;
  if (rc.scrollTop !== 0) rc.scrollTop = 0;
  const world = rc.querySelector<HTMLElement>("[data-rc-world]");
  if (world) {
    world.style.transform = `translate3d(${ui.panX}px, ${ui.panY}px, 0) scale(${ui.zoom})`;
  }
  const gridStep = Math.max(8, 20 * ui.zoom);
  const gx = ((ui.panX % gridStep) + gridStep) % gridStep;
  const gy = ((ui.panY % gridStep) + gridStep) % gridStep;
  rc.style.backgroundSize = `${gridStep}px ${gridStep}px`;
  rc.style.backgroundPosition = `${gx}px ${gy}px`;

  const zoomLabel = rc.querySelector<HTMLElement>("[data-rc-zoom-readout]");
  if (zoomLabel) {
    zoomLabel.textContent = `${Math.round(ui.zoom * 100)}%`;
  }
}

let suppressOutsideWireCloseUntil = 0;

export function wouldCreateRoundCycleClient(
  connections: RoundConnection[],
  fromRoundId: string,
  toRoundId: string
): boolean {
  if (!fromRoundId || !toRoundId || fromRoundId === toRoundId) return true;
  const adj = new Map<string, string[]>();
  for (const c of connections) {
    if (c.invalid) continue;
    const list = adj.get(c.fromRoundId) ?? [];
    list.push(c.toRoundId);
    adj.set(c.fromRoundId, list);
  }
  const visited = new Set<string>();
  const queue: string[] = [toRoundId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === fromRoundId) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const nxt of adj.get(cur) ?? []) {
      queue.push(nxt);
    }
  }
  return false;
}

const SEED_COLOR_PALETTE = [
  "#38bdf8",
  "#f59e0b",
  "#a78bfa",
  "#f43f5e",
  "#2dd4bf",
  "#fb923c",
  "#e879f9",
  "#60a5fa",
  "#facc15",
  "#818cf8",
  "#fb7185",
  "#22d3ee",
  "#c084fc",
  "#fdba74",
  "#93c5fd",
  "#f472b6",
];

export function seedColorForNumber(seedNum: number): string {
  const idx = Math.max(0, (Math.floor(seedNum) || 1) - 1) % SEED_COLOR_PALETTE.length;
  return SEED_COLOR_PALETTE[idx];
}

export function formatQualifyingMetricLabel(metric?: QualifyingMetric | string): string {
  switch (metric) {
    case "consecutive_2":
      return "Fastest 2 Consec";
    case "best_lap":
      return "Fastest Lap";
    case "laps_in_time":
      return "Most Laps";
    case "points":
      return "Qual Points";
    case "consecutive_3":
    default:
      return "Fastest 3 Consec";
  }
}

export function effectiveStageSeedCount(
  race: RaceTournamentState,
  stageIndex: number,
  activePilotCount: number
): number {
  const base = Math.max(2, activePilotCount || (race.qualStandings?.length ?? 0) || 8);
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
    const maxS = race.config.stage2MaxSeeds ?? 0;
    if (maxS > 0 && maxS < base) {
      return maxS;
    }
    return maxS > 0 ? maxS : base;
  }
  return 0;
}

export function effectiveStage2SeedCount(
  race: RaceTournamentState,
  activePilotCount: number
): number {
  return effectiveStageSeedCount(race, 2, activePilotCount) || Math.max(2, activePilotCount || 8);
}

export function anyDownstreamStageStarted(
  race: RaceTournamentState,
  fromStageIndex: number
): boolean {
  const conns = race.stageConnections ?? [];
  if (conns.length === 0) {
    return fromStageIndex === 1 && race.heats.some((h) => h.stageIndex === 2 && !isHeatUnstarted(h.state));
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
    if (race.heats.some((h) => h.stageIndex === cur && !isHeatUnstarted(h.state))) {
      return true;
    }
    for (const nxt of adj.get(cur) ?? []) {
      if (!visited.has(nxt)) queue.push(nxt);
    }
  }
  return false;
}

function getValidTargetRoundIds(
  race: RaceTournamentState,
  stageRounds: RaceRound[],
  heatsByRound: Map<string, RaceHeat[]>,
  stageConnections: RoundConnection[],
  fromRoundId: string,
  fromPort: "right" | "bottom" = "right",
  excludeConnectionId = ""
): Set<string> {
  if (!fromRoundId) return new Set<string>();
  const fromRound = stageRounds.find((sr) => sr.id === fromRoundId);
  const stageIdx = fromRound?.stageIndex || stageRounds[0]?.stageIndex || 1;
  return buildRoundNetworkGraph(
    race,
    stageIdx,
    stageRounds,
    heatsByRound,
    stageConnections,
    excludeConnectionId
  ).getValidTargetIds(fromRoundId, { fromPort });
}

export function formatWirePillLabel(conn: RoundConnection): string {
  if (conn.mode === "pilots_in" || isPilotsInRoundId(conn.fromRoundId)) {
    if (conn.distribution === "snake") {
      return "Pilots Roster · Snake";
    }
    if (conn.distribution === "sequential") {
      return "Pilots Roster · Grouped";
    }
    if (conn.distribution === "random") {
      return "Pilots Roster · Random";
    }
    return "Pilots Roster";
  }
  if (conn.mode === "qual_feed" || isHandoffOutRoundId(conn.toRoundId)) {
    return "Counts for Seeding";
  }
  if (conn.mode === "stage_seeds" || isHandoffInRoundId(conn.fromRoundId)) {
    const sStart = Math.max(1, conn.seedStart || 1);
    const sEnd = Math.max(0, conn.seedEnd || 0);
    const dist = conn.distribution === "sequential" ? "By Rank" : "Snake";
    if (sStart <= 1 && sEnd <= 0) {
      return `All Seeds · ${dist}`;
    }
    if (sStart === 1 && sEnd > 0) {
      return `Top ${sEnd} (#1-#${sEnd}) · ${dist}`;
    }
    if (sEnd > 0) {
      return `Seeds #${sStart}-#${sEnd} · ${dist}`;
    }
    return `Seeds #${sStart}+ · ${dist}`;
  }
  if (conn.mode === "standings_top") {
    const dist = conn.distribution === "sequential" ? "Sequential" : "Snake";
    const earlySuffix = conn.seededEarly ? " · Seeded" : "";
    const sStart = Math.max(0, conn.seedStart || 0);
    const sEnd = Math.max(0, conn.seedEnd || 0);
    if (sStart > 1 && sEnd >= sStart) {
      return `Ranks #${sStart}-#${sEnd} · ${dist}${earlySuffix}`;
    }
    if (sStart === 1 && sEnd > 0) {
      return `Top ${sEnd} · ${dist}${earlySuffix}`;
    }
    if (conn.count && conn.count > 0) {
      return `Top ${conn.count} · ${dist}${earlySuffix}`;
    }
    return `All Qualified · ${dist}${earlySuffix}`;
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

interface WirePresetOption {
  label: string;
  mode: RoundConnectionMode;
  count: number;
}

const WIRE_PRESETS: WirePresetOption[] = [
  { label: "Top 1 / heat", mode: "top_per_heat", count: 1 },
  { label: "Top 2 / heat", mode: "top_per_heat", count: 2 },
  { label: "Top 3 / heat", mode: "top_per_heat", count: 3 },
  { label: "Bottom 1 / heat", mode: "bottom_per_heat", count: 1 },
  { label: "Bottom 2 / heat", mode: "bottom_per_heat", count: 2 },
  { label: "All pilots · Balanced", mode: "all_pilots", count: 0 },
  { label: "All pilots · Ranked", mode: "all_pilots_ranked", count: 0 },
];

const PILOTS_IN_PRESETS: Array<{ label: string; distribution: "roster" | "snake" | "random" }> = [
  { label: "Checked-In · Roster Order", distribution: "roster" },
  { label: "Checked-In · Snake Balanced", distribution: "snake" },
  { label: "Checked-In · Random Draw", distribution: "random" },
];

interface StageSeedPresetOption {
  label: string;
  seedStart: number;
  seedEnd: number;
  distribution: "snake" | "sequential";
}

const STAGE_SEED_PRESETS: StageSeedPresetOption[] = [
  { label: "All Seeds · Snake", seedStart: 1, seedEnd: 0, distribution: "snake" },
  { label: "Top 4 (#1–#4) · Snake", seedStart: 1, seedEnd: 4, distribution: "snake" },
  { label: "Top 8 (#1–#8) · Snake", seedStart: 1, seedEnd: 8, distribution: "snake" },
  { label: "Seeds #1–#4 · A Main", seedStart: 1, seedEnd: 4, distribution: "sequential" },
  { label: "Seeds #5–#8 · B Main", seedStart: 5, seedEnd: 8, distribution: "sequential" },
  { label: "Seeds #9–#12 · C Main", seedStart: 9, seedEnd: 12, distribution: "sequential" },
];

function renderWireInvalidBanner(conn: RoundConnection): string {
  if (!conn.invalid) return "";
  const msg =
    cleanConnectionInvalidReason(conn.invalidReason) ||
    "Invalid connection - adjust rule or reconnect wire.";
  return `
    <div class="bkt-wire-invalid-banner" role="alert">
      <div class="bkt-wire-invalid-reason">${esc(msg)}</div>
      <div class="bkt-wire-invalid-hint">Drag either endpoint to reconnect.</div>
    </div>`;
}

function renderWireRuleMenu(conn: RoundConnection, maxPerHeat = 3): string {
  const invalidBanner = renderWireInvalidBanner(conn);

  if (conn.mode === "pilots_in" || isPilotsInRoundId(conn.fromRoundId)) {
    const curDist =
      conn.distribution === "snake" || conn.distribution === "random"
        ? conn.distribution
        : "roster";
    const distItems = PILOTS_IN_PRESETS.map((opt) => {
      const active = curDist === opt.distribution;
      return `
        <button
          type="button"
          class="bkt-wire-menu-item ${active ? "is-active" : ""}"
          data-bkt-pilots-dist="${opt.distribution}"
          data-conn-id="${esc(conn.id)}"
        >
          <span class="bkt-wire-menu-item-main">
            ${icons.pilot(14)}
            <span class="bkt-wire-menu-label">${esc(opt.label)}</span>
          </span>
          ${active ? `<span class="bkt-wire-menu-check">${icons.check(13)}</span>` : ""}
        </button>`;
    }).join("");

    return `
      <div class="bkt-wire-menu ${conn.invalid ? "is-invalid-menu" : ""}" role="menu" data-bkt-stop-select>
        ${invalidBanner}
        <div class="bkt-wire-menu-list">${distItems}</div>
        <div class="bkt-wire-menu-sep"></div>
        <button
          type="button"
          class="bkt-wire-menu-remove"
          data-bkt-action="disconnect_rounds"
          data-conn-id="${esc(conn.id)}"
        >
          ${icons.trash(14)}<span>Disconnect Line</span>
        </button>
      </div>`;
  }

  if (conn.mode === "qual_feed" || isHandoffOutRoundId(conn.toRoundId)) {
    return `
      <div class="bkt-wire-menu ${conn.invalid ? "is-invalid-menu" : ""}" role="menu" data-bkt-stop-select>
        ${invalidBanner}
        <button
          type="button"
          class="bkt-wire-menu-more"
          data-bkt-action="open_stage_handoff"
        >
          ${icons.sliders(14)}<span>Metric &amp; Cutoff…</span>
        </button>
        <div class="bkt-wire-menu-sep"></div>
        <button
          type="button"
          class="bkt-wire-menu-remove"
          data-bkt-action="disconnect_rounds"
          data-conn-id="${esc(conn.id)}"
        >
          ${icons.trash(14)}<span>Exclude Round</span>
        </button>
      </div>`;
  }

  if (conn.mode === "stage_seeds" || isHandoffInRoundId(conn.fromRoundId)) {
    const curStart = Math.max(1, conn.seedStart || 1);
    const curEnd = Math.max(0, conn.seedEnd || 0);
    const curDist = conn.distribution === "sequential" ? "sequential" : "snake";
    const seedItems = STAGE_SEED_PRESETS.map((opt) => {
      const active =
        curStart === opt.seedStart &&
        curEnd === opt.seedEnd &&
        curDist === opt.distribution;
      return `
        <button
          type="button"
          class="bkt-wire-menu-item ${active ? "is-active" : ""}"
          data-bkt-seed-preset="${opt.seedStart}:${opt.seedEnd}:${opt.distribution}"
          data-conn-id="${esc(conn.id)}"
        >
          <span class="bkt-wire-menu-item-main">
            ${icons.zap(14)}
            <span class="bkt-wire-menu-label">${esc(opt.label)}</span>
          </span>
          ${active ? `<span class="bkt-wire-menu-check">${icons.check(13)}</span>` : ""}
        </button>`;
    }).join("");

    return `
      <div class="bkt-wire-menu ${conn.invalid ? "is-invalid-menu" : ""}" role="menu" data-bkt-stop-select>
        ${invalidBanner}
        <div class="bkt-wire-menu-list">${seedItems}</div>
        <div class="bkt-wire-menu-sep"></div>
        <button
          type="button"
          class="bkt-wire-menu-more"
          data-bkt-action="open_wire_connection"
          data-conn-id="${esc(conn.id)}"
        >
          ${icons.sliders(14)}<span>Custom Seed Range…</span>
        </button>
        <button
          type="button"
          class="bkt-wire-menu-remove"
          data-bkt-action="disconnect_rounds"
          data-conn-id="${esc(conn.id)}"
        >
          ${icons.trash(14)}<span>Disconnect Line</span>
        </button>
      </div>`;
  }

  const items = WIRE_PRESETS.filter(
    (opt) =>
      (opt.mode !== "top_per_heat" && opt.mode !== "bottom_per_heat") ||
      opt.count <= maxPerHeat
  ).map((opt) => {
    const isAllMode = opt.mode === "all_pilots" || opt.mode === "all_pilots_ranked";
    const active = conn.mode === opt.mode && (isAllMode || conn.count === opt.count);
    const itemIcon =
      opt.mode === "bottom_per_heat"
        ? icons.trendDown(14)
        : isAllMode
          ? icons.pilot(14)
          : icons.arrowRight(14);
    return `
      <button
        type="button"
        class="bkt-wire-menu-item ${active ? "is-active" : ""}"
        data-bkt-wire-preset="${opt.mode}:${opt.count}"
        data-conn-id="${esc(conn.id)}"
      >
        <span class="bkt-wire-menu-item-main">
          ${itemIcon}
          <span class="bkt-wire-menu-label">${esc(opt.label)}</span>
        </span>
        ${active ? `<span class="bkt-wire-menu-check">${icons.check(13)}</span>` : ""}
      </button>`;
  }).join("");

  return `
    <div class="bkt-wire-menu ${conn.invalid ? "is-invalid-menu" : ""}" role="menu" data-bkt-stop-select>
      ${invalidBanner}
      <div class="bkt-wire-menu-list">${items}</div>
      <div class="bkt-wire-menu-sep"></div>
      <button
        type="button"
        class="bkt-wire-menu-more"
        data-bkt-action="open_wire_connection"
        data-conn-id="${esc(conn.id)}"
      >
        ${icons.sliders(14)}<span>Custom Advancement…</span>
      </button>
      <button
        type="button"
        class="bkt-wire-menu-remove"
        data-bkt-action="disconnect_rounds"
        data-conn-id="${esc(conn.id)}"
      >
        ${icons.trash(14)}<span>Disconnect Line</span>
      </button>
    </div>`;
}

function renderWirePillsOverlay(
  race: RaceTournamentState,
  stageConnections: RoundConnection[],
  heatsByRound: Map<string, RaceHeat[]>,
  editableActive: boolean,
  ui?: BracketEditorUiState
): string {
  return stageConnections
    .map((conn) => {
      const label = formatWirePillLabel(conn);
      const targetHeats = heatsByRound.get(conn.toRoundId) ?? [];
      const connStageIdx = conn.stageIndex || 1;
      const targetUnstarted =
        isHandoffOutRoundId(conn.toRoundId)
          ? !anyDownstreamStageStarted(race, connStageIdx)
          : targetHeats.every((h) => isHeatUnstarted(h.state));
      const isInvalid = !!conn.invalid;
      const canEditWire =
        editableActive &&
        !conn.id.startsWith("edge-") &&
        (targetUnstarted || isInvalid);
      const isMenuOpen = canEditWire && ui?.openWireMenuId === conn.id;
      const isBottom = conn.mode === "bottom_per_heat";
      const isPortalWire =
        conn.mode === "qual_feed" ||
        conn.mode === "stage_seeds" ||
        conn.mode === "pilots_in" ||
        isHandoffOutRoundId(conn.toRoundId) ||
        isHandoffInRoundId(conn.fromRoundId) ||
        isPilotsInRoundId(conn.fromRoundId);

      if (!canEditWire) {
        if (!isInvalid) {
          return "";
        }
        return `
          <div
            class="bkt-wire-pill-wrap is-readonly is-invalid ${isBottom ? "is-bottom" : ""} ${isPortalWire ? "is-portal-wire" : ""}"
            data-wire-pill="${esc(conn.id)}"
            title="${esc(cleanConnectionInvalidReason(conn.invalidReason))}"
          >
            <span class="bkt-wire-act-btn">${icons.siren(12)}</span>
          </div>`;
      }

      return `
        <div
          class="bkt-wire-pill-wrap ${isInvalid ? "is-invalid" : ""} ${isBottom ? "is-bottom" : ""} ${isPortalWire ? "is-portal-wire" : ""} ${isMenuOpen ? "is-open" : ""}"
          data-wire-pill="${esc(conn.id)}"
          data-bkt-stop-select
        >
          <button
            type="button"
            class="bkt-wire-act-btn ${isMenuOpen ? "is-active" : ""}"
            data-bkt-ui="toggle-wire-menu"
            data-conn-id="${esc(conn.id)}"
            aria-label="Connection settings (${esc(label)})"
            title="${esc(isInvalid ? cleanConnectionInvalidReason(conn.invalidReason) : `${label} — Connection settings`)}"
          >
            ${isInvalid ? icons.siren(13) : icons.settings(13)}
          </button>
          <button
            type="button"
            class="bkt-wire-act-btn"
            data-bkt-action="disconnect_rounds"
            data-conn-id="${esc(conn.id)}"
            aria-label="Delete connection"
            title="Delete connection"
          >
            ${icons.close(13)}
          </button>
          ${isMenuOpen ? renderWireRuleMenu(conn, Math.max(1, (race.stages?.find((s) => s.index === connStageIdx)?.settings?.pilotsPerHeat || race.config.pilotsPerHeat || 4) - 1)) : ""}
        </div>`;
    })
    .join("");
}

function renderHeatCard(
  heat: RaceHeat,
  activeHeatId: string,
  interactive: boolean,
  editableActive: boolean,
  roundHeatCount: number,
  allStageHeats: RaceHeat[],
  activePilots: EventPilot[],
  maxStageSeeds = 0
): string {
  const badge = heatStateBadge(heat.state, heat.inOvertime, heat.note);
  const isSelected = heat.id === activeHeatId;
  const isChase = isChaseHeatId(heat.id) || heat.stageFormat === "chase_the_ace";
  const heatEditable = editableActive && isHeatUnstarted(heat.state);

  const heatCol = heat.column || heat.round || 1;
  const earlierHeats = heatEditable
    ? allStageHeats.filter((oh) => oh.id !== heat.id && (oh.column || oh.round || 1) < heatCol)
    : [];

  const rows = heat.seats
    .map((s) => {
      const filled = s.pilotSlotIndex > 0;
      const isBye = !!s.feeder?.isBye && !filled;
      const rawSeedNum =
        (s.feeder?.fromStageSeed ?? 0) ||
        (s.feeder?.fromStandingsRank ?? 0) ||
        (!filled && !s.feeder && /^Seed #(\d+)$/.exec(s.sourceLabel || "")
          ? Number(/^Seed #(\d+)$/.exec(s.sourceLabel || "")?.[1] || 0)
          : 0);
      const isSeedSlot = !filled && !isBye && rawSeedNum > 0;
      const isHeatSlot =
        !filled &&
        !isBye &&
        !isSeedSlot &&
        (!!s.feeder?.fromHeatId ||
          Boolean(s.sourceLabel && s.sourceLabel !== "Open / BYE" && s.sourceLabel !== "BYE"));
      const hasPlaceholderDot = isSeedSlot || isHeatSlot;
      const statusBadge =
        s.status === "dq"
          ? `<span class="bkt-pos is-bad"><span class="bkt-pos-text">DQ</span><span class="bkt-pos-mark" aria-hidden="true"></span></span>`
          : s.status === "dnf"
            ? `<span class="bkt-pos is-warn"><span class="bkt-pos-text">DNF</span><span class="bkt-pos-mark" aria-hidden="true"></span></span>`
            : s.status === "dns"
              ? `<span class="bkt-pos is-warn" title="Did Not Start / Scratched"><span class="bkt-pos-text">DNS</span><span class="bkt-pos-mark" aria-hidden="true"></span></span>`
              : s.position > 0 &&
                  (heat.state === "running" ||
                    heat.state === "paused" ||
                    heat.state === "finished" ||
                    heat.state === "confirmed")
                ? `<span class="bkt-pos ${s.advances ? "is-adv" : s.position === 1 ? "is-first" : ""}"><span class="bkt-pos-text">${ordinal(s.position)}</span><span class="bkt-pos-mark" aria-hidden="true">${s.advances ? "✓" : ""}</span></span>`
                : s.lapsCompleted > 0
                  ? `<span class="bkt-pos mono"><span class="bkt-pos-text">${s.lapsCompleted}L</span><span class="bkt-pos-mark" aria-hidden="true"></span></span>`
                  : "";
      const aceStars =
        isChase && filled && (s.aceWinsAfter || s.aceWinsBefore)
          ? `<span class="bkt-ace" title="Ace wins">${"★".repeat(Math.max(s.aceWinsAfter ?? 0, s.aceWinsBefore ?? 0))}</span>`
          : "";
      const seatShortCh = formatBandChannelShort(s.band, s.channel) || `R${s.channel}`;
      const prevShortCh = s.prevChannel ? formatEncodedChannelShort(s.prevChannel) || "?" : "?";
      const deltaBadge =
        filled && s.channelChanged
          ? `<span class="bkt-ch-delta" title="Channel changed from ${esc(prevShortCh)} to ${esc(seatShortCh)}">${icons.channelSwap(14)}</span>`
          : "";

      if (heatEditable) {
        const seatCode = encodeBandChannel(s.band, s.channel) || s.channel;
        const chOptions = buildMultiBandCanvasOptions({ selectedCode: seatCode, includeFreq: true });
        const chSelect = renderCanvasSelect({
          value: String(seatCode),
          label: seatShortCh,
          options: chOptions,
          className: "bkt-ch-select",
          mono: true,
          title: "Seat channel (swaps if already used in heat)",
          dataAttrs: `data-bkt-ch-heat="${esc(heat.id)}" data-bkt-ch-seat="${s.seatIndex}"`,
        });

        const curPlaceholder = isBye ? "Open / BYE" : s.sourceLabel || "Open seat";
        const seatOptions: CanvasSelectOption[] = [];

        if (heat.stageIndex >= 2 && maxStageSeeds > 0) {
          for (let k = 1; k <= Math.min(32, maxStageSeeds); k++) {
            seatOptions.push({
              value: `seed:${k}`,
              label: `Seed #${k}${s.feeder?.fromStageSeed === k ? " (Current)" : ""}`,
              dotColor: seedColorForNumber(k),
              group: "Incoming Stage Seed",
            });
          }
        }

        for (const p of activePilots) {
          seatOptions.push({
            value: `pilot:${p.slotIndex}`,
            label: p.callsign,
            dotColor: p.color,
            group: "Assign Pilot Now",
          });
        }

        for (const eh of earlierHeats) {
          const ranks = [1, 2, 3, 4].slice(0, Math.max(2, eh.seats.length));
          for (const rnk of ranks) {
            seatOptions.push({
              value: `heat:${eh.id}:${rnk}`,
              label: `${ordinal(rnk)} · ${eh.shortLabel || eh.id}`,
              dotColor: "hollow",
              group: "Custom Seat Feeder",
            });
          }
        }

        if (s.feeder && !s.feeder.isBye) {
          seatOptions.push({
            value: "unlink",
            label: "Clear Feeder (Open / BYE)",
            separatorBefore: true,
          });
        }

        const seatSelect = renderCanvasSelect({
          value: "",
          label: curPlaceholder,
          options: seatOptions,
          className: "bkt-assign-select",
          isSeed: isSeedSlot,
          dotColor: hasPlaceholderDot ? "hollow" : undefined,
          title:
            "Pick a Qualifying Seed placeholder, assign a pilot, or leave connected to incoming round",
          dataAttrs: `data-bkt-seat-heat="${esc(heat.id)}" data-bkt-seat-idx="${s.seatIndex}"`,
        });

        const pinInd = s.manualLock
          ? `<span class="bkt-seat-pin-ind" title="Manual seat override">${icons.pin(13)}</span>`
          : "";

        const clearTitle = s.manualLock
          ? "Undo manual assignment and restore normal slot state"
          : `Remove ${esc(s.callsign)} from seat`;

        const clearBtn =
          filled || s.manualLock
            ? `<button type="button" class="bkt-seat-btn is-clear" data-bkt-action="clear_seat" data-heat-id="${esc(heat.id)}" data-seat-index="${s.seatIndex}" title="${clearTitle}">${icons.close(11)}</button>`
            : "";

        return `
          <div
            class="bkt-seat is-editable-seat ${filled ? "is-draggable" : "is-empty"} ${isSeedSlot ? "is-seed-slot" : ""} ${s.status === "dq" || s.status === "dnf" || s.status === "dns" ? "is-out" : ""}"
            ${filled ? `draggable="true" data-drag-seat-heat="${esc(heat.id)}" data-drag-seat-idx="${s.seatIndex}" data-drag-pilot="${s.pilotSlotIndex}"` : ""}
            data-drop-heat="${esc(heat.id)}"
            data-drop-seat="${s.seatIndex}"
          >
            ${filled ? `<span class="bkt-grip" title="Drag pilot to move or swap seats">${icons.grip(12)}</span>` : `<span class="bkt-grip is-spacer"></span>`}
            <span class="bkt-ch-wrap">${chSelect}</span>
            ${
              filled
                ? `<span class="dot" style="--c:${s.color}"></span>
                   <span class="bkt-name-wrap"><span class="bkt-name" title="${esc(s.callsign)}">${esc(s.callsign)}</span>${deltaBadge}</span>
                   ${aceStars}`
                : seatSelect
            }
            ${statusBadge}
            ${pinInd}
            ${clearBtn}
          </div>`;
      }

      const roPinInd = s.manualLock
        ? `<span class="bkt-seat-pin-ind" title="Manual seat override">${icons.pin(13)}</span>`
        : "";

      return `
        <div class="bkt-seat ${filled ? "" : "is-empty"} ${isSeedSlot ? "is-seed-slot" : ""} ${s.advances && heat.state === "confirmed" ? "is-winner" : ""} ${s.status === "dq" || s.status === "dnf" || s.status === "dns" ? "is-out" : ""}">
          <span class="bkt-ch mono">${esc(seatShortCh)}</span>
          ${
            filled
              ? `<span class="dot" style="--c:${s.color}"></span>
                 <span class="bkt-name-wrap"><span class="bkt-name" title="${esc(s.callsign)}">${esc(s.callsign)}</span>${deltaBadge}</span>
                 ${aceStars}`
              : `${hasPlaceholderDot ? `<span class="dot is-hollow"></span>` : ""}<span class="bkt-placeholder ${isSeedSlot ? "is-seed-placeholder" : ""}">${esc(isBye ? "BYE" : s.sourceLabel || "TBD")}</span>`
          }
          ${roPinInd}
          ${statusBadge}
        </div>`;
    })
    .join("");

  const delHeatBtn =
    heatEditable && roundHeatCount > 1
      ? `<button type="button" class="bkt-seat-btn is-del-heat" data-bkt-action="delete_heat" data-heat-id="${esc(heat.id)}" title="Remove heat ${esc(heat.shortLabel || heat.id)}">${icons.trash(12)}</button>`
      : "";

  return `
    <div class="bkt-card ${isSelected ? "is-selected" : ""} ${heatEditable ? "is-editable-card" : ""} state-${heat.state}" ${interactive ? `data-select-heat="${esc(heat.id)}" role="button" tabindex="0"` : ""} data-heat-card="${esc(heat.id)}">
      <div class="bkt-card-head">
        <div class="bkt-card-id">
          <span class="bkt-order mono">#${heat.order}</span>
          <strong>${esc(heat.shortLabel || heat.id)}</strong>
          ${heat.division ? `<span class="bkt-div-pill">${esc(heat.division)} Main</span>` : ""}
        </div>
        <div class="bkt-card-head-right">
          <span class="race-state-pill ${badge.cls}">${esc(badge.label)}</span>
          ${delHeatBtn}
        </div>
      </div>
      <div class="bkt-seats" ${heatEditable ? "data-bkt-stop-select" : ""}>${rows}</div>
    </div>`;
}

function computeAddHeatDisabledReason(
  race: RaceTournamentState,
  round: RaceRound,
  heats: RaceHeat[],
  incomingCount: number,
  activePilots: EventPilot[]
): string {
  const isFinals = round.bracketLane === "finals";
  const isSeeded =
    incomingCount === 0 &&
    (round.seedSource === "all_active_pilots" ||
      (round.column === 1 && round.seedSource !== "empty"));

  const pph = Math.max(2, race.config.pilotsPerHeat || 4);
  const defAdv = Math.max(1, Math.floor(pph / 2));
  let outAdv = 0;
  if (!isFinals && round.stageFormat !== "qualifying" && round.stageFormat !== "open_qualifier") {
    for (const c of race.connections ?? []) {
      if (c.invalid || c.fromRoundId !== round.id || c.mode !== "top_per_heat") {
        continue;
      }
      const cnt = c.count && c.count >= 1 ? c.count : defAdv;
      if (cnt > outAdv) outAdv = cnt;
    }
  }
  const isAutoFed = incomingCount > 0 || isSeeded;
  if (isAutoFed && outAdv >= 1) {
    let startedCount = 0;
    let unstartedEntrants = 0;
    let totalEntrants = 0;
    for (const h of heats) {
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
    if (totalEntrants === 0 && isSeeded) {
      totalEntrants = activePilots.length;
      unstartedEntrants = activePilots.length;
    }
    const poolN = startedCount > 0 ? unstartedEntrants : totalEntrants;
    if (poolN >= 2) {
      const minHeats = Math.max(1, Math.ceil(poolN / pph));
      const maxUnstartedHeats = Math.max(minHeats, Math.floor(poolN / (outAdv + 1)));
      const maxTotalHeats = startedCount + maxUnstartedHeats;
      if (heats.length >= maxTotalHeats) {
        return `Cannot add another heat: advancing Top ${outAdv} per heat requires at least ${outAdv + 1} pilots per heat so at least 1 pilot is eliminated (${totalEntrants} pilots in this round, max ${maxTotalHeats} ${maxTotalHeats === 1 ? "heat" : "heats"}).`;
      }
    }
  }
  return "";
}

function renderNodeHamburgerMenu(
  race: RaceTournamentState,
  round: RaceRound,
  heats: RaceHeat[],
  incomingCount: number,
  _outgoingCount: number,
  allUnstarted: boolean,
  activePilots: EventPilot[]
): string {
  const isFinals = round.bracketLane === "finals";
  const isSeeded =
    incomingCount === 0 &&
    (round.seedSource === "all_active_pilots" ||
      (round.column === 1 && round.seedSource !== "empty"));
  const addHeatReason = computeAddHeatDisabledReason(
    race,
    round,
    heats,
    incomingCount,
    activePilots
  );

  const seedItem =
    incomingCount === 0 && allUnstarted
      ? `<button
          type="button"
          class="bkt-node-menu-item"
          data-bkt-action="set_round_seed"
          data-round-id="${esc(round.id)}"
          data-seed-mode="${isSeeded ? "empty" : "all_active_pilots"}"
        >
          ${icons.pilot(14)}
          <span>${isSeeded ? "Switch to Empty Seats" : "Seed All Active Pilots"}</span>
        </button>`
      : "";

  const nonFinalsActions = !isFinals
    ? `<div class="bkt-node-menu-sep"></div>
      <div ${addHeatReason ? `title="${esc(addHeatReason)}"` : ""}>
        <button
          type="button"
          class="bkt-node-menu-item"
          data-bkt-action="add_heat"
          data-round-id="${esc(round.id)}"
          data-bkt-col="${round.column}"
          data-bkt-lane="${esc(round.bracketLane)}"
          data-bkt-round="${round.round}"
          ${addHeatReason ? `disabled title="${esc(addHeatReason)}"` : ""}
        >
          ${icons.plus(14)}
          <span>Add Heat</span>
        </button>
      </div>
      ${seedItem}
      <button
        type="button"
        class="bkt-node-menu-item"
        data-bkt-action="duplicate_round"
        data-round-id="${esc(round.id)}"
      >
        ${icons.copy(14)}
        <span>Duplicate Round</span>
      </button>`
    : seedItem
      ? `<div class="bkt-node-menu-sep"></div>${seedItem}`
      : "";

  const qualStageItem =
    round.stageFormat === "qualifying"
      ? `<button
          type="button"
          class="bkt-node-menu-item"
          data-bkt-action="open_qual_stage_settings"
          data-stage-idx="${round.stageIndex || 1}"
          data-round-id="${esc(round.id)}"
        >
          ${icons.sliders(14)}
          <span>Qualifier Stage Settings…</span>
        </button>`
      : "";

  return `
    <div class="bkt-node-menu" role="menu" data-bkt-stop-select>
      ${qualStageItem}
      <button
        type="button"
        class="bkt-node-menu-item"
        data-bkt-action="open_round_customize"
        data-round-id="${esc(round.id)}"
      >
        ${icons.sliders(14)}
        <span>Customize Round…</span>
      </button>
      ${nonFinalsActions}
    </div>`;
}

function renderNodePosAttrs(
  canvasMode: boolean,
  pos: RenderedNodePos | undefined,
  width: number
): string {
  if (!canvasMode || !pos) return "";
  const bx = typeof pos.baseX === "number" ? pos.baseX : pos.x;
  const by = typeof pos.baseY === "number" ? pos.baseY : pos.y;
  return `data-pos-x="${pos.x}" data-pos-y="${pos.y}" data-base-pos-x="${bx}" data-base-pos-y="${by}" style="left:0;top:0;width:${width}px;transform:translate3d(${pos.x}px,${pos.y}px,0)"`;
}

function renderStage1HandoffNode(
  race: RaceTournamentState,
  round: RaceRound,
  incomingCount: number,
  editableActive: boolean,
  canvasMode: boolean,
  activePilots: EventPilot[],
  validClickTargets: Set<string>,
  pos?: RenderedNodePos,
  ui?: BracketEditorUiState
): string {
  const stageIdx = round.stageIndex || 1;
  const stgObj = race.stages?.find((s) => s.index === stageIdx);
  const outConns = (race.stageConnections ?? []).filter(
    (sc) => sc.fromStageIndex === stageIdx && !sc.invalid
  );
  const targetStages = outConns
    .map((sc) => race.stages?.find((s) => s.index === sc.toStageIndex))
    .filter((s): s is RaceStage => !!s);
  const firstTargetIdx = targetStages[0]?.index ?? stageIdx + 1;
  const isMultiStageDag = (race.stages?.length ?? 0) > 2 || outConns.length > 1;

  const isClickTarget = editableActive && validClickTargets.has(round.id);
  const isSelected = canvasMode && !!ui?.selectedRoundIds.has(round.id);
  const anyDownstreamStarted = anyDownstreamStageStarted(race, stageIdx);
  const handoffEditable = editableActive && !anyDownstreamStarted;

  const revAdj = new Map<string, string[]>();
  for (const c of race.connections ?? []) {
    if (c.stageIndex === stageIdx && c.fromRoundId && c.toRoundId) {
      const prev = revAdj.get(c.toRoundId) ?? [];
      prev.push(c.fromRoundId);
      revAdj.set(c.toRoundId, prev);
    }
  }
  const feedRoundIds = new Set<string>();
  const bfsQueue = [...(revAdj.get(round.id) ?? [])];
  while (bfsQueue.length > 0) {
    const cur = bfsQueue.shift()!;
    if (feedRoundIds.has(cur)) continue;
    feedRoundIds.add(cur);
    for (const prev of revAdj.get(cur) ?? []) {
      if (!feedRoundIds.has(prev)) bfsQueue.push(prev);
    }
  }
  const s1Heats = race.heats.filter(
    (h) =>
      h.stageIndex === stageIdx &&
      (feedRoundIds.size === 0 || (h.roundId && feedRoundIds.has(h.roundId)))
  );
  const confirmedS1 = s1Heats.filter((h) => h.state === "confirmed").length;
  const completedEarlyNow = stgObj ? !!stgObj.completedEarly : !!race.stage2SeededEarly;
  const seededNow = stgObj
    ? stgObj.status === "completed" || !!stgObj.completedEarly
    : !!(race.qualifyingComplete || race.stage2SeededEarly);
  const canCompleteEarly = stgObj
    ? confirmedS1 >= 1 && !seededNow && !anyDownstreamStarted
    : !!(race.canStartStage2 && !anyDownstreamStarted);

  const curMetric: QualifyingMetric =
    stgObj?.settings?.qualifyingMetric || race.config.qualifyingMetric || "consecutive_3";
  const curMax = race.config.stage2MaxSeeds ?? 0;
  const effCount = effectiveStageSeedCount(race, firstTargetIdx, activePilots.length);
  const stdCutoffs = [0, 4, 8, 12, 16];
  const hasCustomMax = curMax > 0 && !stdCutoffs.includes(curMax);

  const qualStandings = stageIdx === 1 ? race.qualStandings ?? [] : [];
  const hasFlown = qualStandings.some((st) => st.heatsFlown > 0);
  const previewSeeds = qualStandings.slice(0, Math.min(4, effCount));

  const portalBadgeText =
    targetStages.length > 1
      ? `TO ${targetStages.map((s) => `S${s.index}`).join(" · ")}`
      : `TO STAGE ${firstTargetIdx}`;
  const portalTitleText =
    targetStages.length > 1
      ? "Downstream Stage Seeding"
      : round.title || `Stage ${firstTargetIdx} Seeding`;

  const inLeftPort = `
    <span
      class="bkt-port is-in is-in-left ${incomingCount > 0 ? "has-wire" : ""} ${!editableActive && incomingCount === 0 ? "is-hidden-port" : ""}"
      data-round-in="${esc(round.id)}"
      data-port-kind="in"
      data-port-side="left"
      data-bkt-stop-select
      title="${isClickTarget ? `Click to include round in ${portalTitleText}` : `Rounds feeding ${portalTitleText}`}"
    >
      <span class="bkt-port-handle">${icons.chevronRight(10)}</span>
    </span>`;

  const connectOverlayBtn = isClickTarget
    ? `<button
        type="button"
        class="bkt-connect-target-bar"
        data-bkt-action="complete_connect"
        data-to-round-id="${esc(round.id)}"
        data-bkt-stop-select
      >
        ${icons.link(12)}<span>Connect into ${esc(portalTitleText)}</span>
      </button>`
    : "";

  const posAttrs = renderNodePosAttrs(canvasMode, pos, RC_NODE_WIDTH);

  const metricOptions: CanvasSelectOption[] = [
    { value: "consecutive_3", label: "Fastest 3 Consecutive Laps" },
    { value: "consecutive_2", label: "Fastest 2 Consecutive Laps" },
    { value: "best_lap", label: "Fastest Single Lap" },
    { value: "laps_in_time", label: "Most Laps in Time" },
    { value: "points", label: "Qualifying Heat Points" },
  ];
  const activeMetricLabel =
    metricOptions.find((m) => m.value === curMetric)?.label ?? "Fastest 3 Consecutive Laps";

  const seedCountOptions: CanvasSelectOption[] = [
    { value: "0", label: `All Pilots (${activePilots.length || effCount})` },
    { value: "4", label: "Top 4 Seeds (#1–#4)" },
    { value: "8", label: "Top 8 Seeds (#1–#8)" },
    { value: "12", label: "Top 12 Seeds (#1–#12)" },
    { value: "16", label: "Top 16 Seeds (#1–#16)" },
    ...(hasCustomMax
      ? [{ value: String(curMax), label: `Top ${curMax} Seeds (#1–#${curMax})` }]
      : []),
    { value: "custom", label: "Custom Count…", separatorBefore: true },
  ];
  const activeSeedCountLabel =
    seedCountOptions.find((o) => o.value === String(curMax))?.label ??
    `All Pilots (${activePilots.length || effCount})`;

  const rulesHtml = isMultiStageDag
    ? `<div class="bkt-round-meta-pills" style="padding-left:0">
        ${outConns
          .map((sc) => {
            const dst = race.stages?.find((s) => s.index === sc.toStageIndex);
            const sliceLbl =
              sc.mode === "top_n" && (sc.count ?? 0) > 0
                ? `Top ${sc.count}`
                : sc.mode === "seed_range" && (sc.seedStart ?? 0) > 0
                  ? `Seeds #${sc.seedStart}–#${sc.seedEnd || effCount}`
                  : "All Pilots";
            return `<span class="bkt-meta-pill">${esc(sliceLbl)} → ${esc(dst ? `S${dst.index} ${dst.title}` : `Stage ${sc.toStageIndex}`)}</span>`;
          })
          .join("")}
      </div>`
    : handoffEditable
      ? `<div class="bkt-handoff-fields" data-bkt-stop-select>
          <div class="bkt-handoff-field">
            <span>Rank By</span>
            ${renderCanvasSelect({
              value: curMetric,
              label: activeMetricLabel,
              options: metricOptions,
              className: "bkt-handoff-cselect",
              title: "Qualifying ranking metric",
              dataAttrs: "data-bkt-handoff-metric",
            })}
          </div>
          <div class="bkt-handoff-field">
            <span>Seeds Advancing to Stage ${firstTargetIdx}</span>
            ${renderCanvasSelect({
              value: String(curMax),
              label: activeSeedCountLabel,
              options: seedCountOptions,
              className: "bkt-handoff-cselect",
              title: `Seeds advancing to Stage ${firstTargetIdx}`,
              dataAttrs: "data-bkt-handoff-max-seeds",
            })}
          </div>
        </div>`
      : `<div class="bkt-round-meta-pills" style="padding-left:0">
          <span class="bkt-meta-pill">${esc(formatQualifyingMetricLabel(curMetric))}</span>
          <span class="bkt-meta-pill">${curMax > 0 ? `Top ${curMax} Seeds` : `All ${effCount} Seeds`}</span>
        </div>`;

  const previewHtml =
    stageIdx === 1 && (seededNow || hasFlown)
      ? `<div class="bkt-handoff-seeds">
          ${previewSeeds
            .map(
              (st) => `
              <span class="bkt-seed-chip ${seededNow ? "is-resolved" : "is-provisional"}">
                <span class="mono">#${st.rank}</span>
                <span class="dot" style="--c:${st.color}"></span>
                <strong>${esc(st.callsign)}</strong>
              </span>`
            )
            .join("")}
          ${effCount > previewSeeds.length ? `<span class="bkt-seed-more note">+${effCount - previewSeeds.length} more</span>` : ""}
        </div>`
      : `<div class="bkt-handoff-note">
          Downstream stage${targetStages.length > 1 ? "s hold" : " holds"} <strong>Seed #</strong> placeholders now and auto-populate${targetStages.length > 1 ? "" : "s"} when all ${s1Heats.length || 1} Stage ${stageIdx} heat${s1Heats.length === 1 ? "" : "s"} confirm.
        </div>`;

  const earlyBtn = canCompleteEarly
    ? `<button type="button" class="btn btn-ghost btn-xs" data-bkt-action="seed_stage2_early" data-stage-idx="${stageIdx}" data-bkt-stop-select title="Complete Stage ${stageIdx} early and lock current standings into downstream stages">
        ${icons.zap(12)}<span>Seed Early</span>
      </button>`
    : completedEarlyNow && !anyDownstreamStarted
      ? `<button type="button" class="btn btn-ghost btn-xs" data-bkt-action="unlock_stage2_seeding" data-stage-idx="${stageIdx}" data-bkt-stop-select title="Revert early seeding back to placeholders">
          ${icons.unlock(12)}<span>Unlock Early</span>
        </button>`
      : "";

  const jumpBtns = !editableActive
    ? ""
    : targetStages.length > 1
      ? targetStages
          .map(
            (ts) => `
            <button type="button" class="btn btn-armed btn-xs bkt-portal-jump-btn" data-bkt-stage="${ts.index}">
              <span>Open S${ts.index}</span>${icons.arrowRight(13)}
            </button>`
          )
          .join("")
      : `<button type="button" class="btn btn-armed btn-xs bkt-portal-jump-btn" data-bkt-stage="${firstTargetIdx}">
          <span>Open Stage ${firstTargetIdx}</span>${icons.arrowRight(13)}
        </button>`;

  return `
    <div
      class="bkt-round-node is-handoff-node lane-handoff_out ${editableActive ? "is-editable-node" : ""} ${canvasMode ? "is-rc-node" : ""} ${isSelected ? "is-selected-node" : ""} ${isClickTarget ? "is-wire-candidate" : ""}"
      data-round-node="${esc(round.id)}"
      data-round-lane="handoff_out"
      data-round-col="${round.column}"
      ${posAttrs}
    >
      ${inLeftPort}
      <div class="bkt-round-head ${editableActive || canvasMode ? "is-draggable-head" : "is-readonly"}" ${editableActive || canvasMode ? `data-round-drag-handle="${esc(round.id)}" data-bkt-stop-select` : ""}>
        <div class="bkt-round-head-top">
          <div class="bkt-round-title-wrap">
            ${editableActive || canvasMode ? `<span class="bkt-node-drag-grip">${icons.grip(13)}</span>` : ""}
            <span class="bkt-portal-badge">${esc(portalBadgeText)}</span>
            <strong class="bkt-round-title-static">${esc(portalTitleText)}</strong>
          </div>
          ${
            editableActive
              ? `<div class="bkt-round-head-btns">
                  <button type="button" class="bkt-node-hamburger" data-bkt-action="open_stage_handoff" title="Configure Stage Advancement">
                    ${icons.sliders(13)}
                  </button>
                </div>`
              : `<span class="race-state-pill ${seededNow ? "is-done" : "is-ready"}">${seededNow ? "Seeded" : `${confirmedS1}/${s1Heats.length}`}</span>`
          }
        </div>
        <div class="bkt-handoff-status-row">
          <span class="race-state-pill ${seededNow ? "is-done" : "is-ready"}">
            ${seededNow ? (completedEarlyNow ? "Seeded Early ✓" : `Stage ${stageIdx} Complete ✓`) : `${confirmedS1}/${s1Heats.length} Stage ${stageIdx} Heats Confirmed`}
          </span>
        </div>
      </div>
      ${connectOverlayBtn}
      <div class="bkt-handoff-body" data-bkt-stop-select>
        ${rulesHtml}
        ${previewHtml}
        <div class="bkt-handoff-actions">
          ${earlyBtn}
          ${jumpBtns}
        </div>
      </div>
    </div>`;
}

function renderStage2HandoffNode(
  race: RaceTournamentState,
  round: RaceRound,
  outgoingCount: number,
  editableActive: boolean,
  canvasMode: boolean,
  activePilots: EventPilot[],
  pos?: RenderedNodePos,
  ui?: BracketEditorUiState
): string {
  const stageIdx = round.stageIndex || 2;
  const stgObj = race.stages?.find((s) => s.index === stageIdx);
  const inConns = (race.stageConnections ?? []).filter(
    (sc) => sc.toStageIndex === stageIdx && !sc.invalid
  );
  const sourceStages = inConns
    .map((sc) => race.stages?.find((s) => s.index === sc.fromStageIndex))
    .filter((s): s is RaceStage => !!s);
  const firstSourceIdx = sourceStages[0]?.index ?? Math.max(1, stageIdx - 1);

  const isSourceActive = editableActive && ui?.connectingFromRoundId === round.id;
  const isSelected = canvasMode && !!ui?.selectedRoundIds.has(round.id);
  const seededNow = stgObj
    ? !!stgObj.prerequisitesMet && inConns.length > 0
    : !!(race.qualifyingComplete || race.stage2SeededEarly);

  const srcHeats = race.heats.filter((h) => h.stageIndex === firstSourceIdx);
  const confirmedSrc = srcHeats.filter((h) => h.state === "confirmed").length;
  const curMetric: QualifyingMetric =
    inConns[0]?.rankingMetric || race.config.qualifyingMetric || "consecutive_3";
  const effCount = effectiveStageSeedCount(race, stageIdx, activePilots.length);

  const resolvedBySeed = new Map<number, { callsign: string; color: string }>();
  const pilotBySlot = new Map<number, EventPilot>();
  for (const p of race.roster ?? activePilots) {
    pilotBySlot.set(p.slotIndex, p);
  }
  if (seededNow) {
    for (const h of race.heats) {
      if (h.stageIndex !== stageIdx) continue;
      for (const s of h.seats) {
        if (s.fromStageSeed && s.fromStageSeed > 0 && s.pilotSlotIndex > 0) {
          const p = pilotBySlot.get(s.pilotSlotIndex);
          if (p) {
            resolvedBySeed.set(s.fromStageSeed, {
              callsign: p.callsign,
              color: p.color || "#38bdf8",
            });
          } else if (s.callsign) {
            resolvedBySeed.set(s.fromStageSeed, {
              callsign: s.callsign,
              color: "#38bdf8",
            });
          }
        }
      }
    }
  }
  if (firstSourceIdx === 1 && resolvedBySeed.size === 0) {
    for (const st of race.qualStandings ?? []) {
      if (seededNow || st.heatsFlown > 0) {
        resolvedBySeed.set(st.rank, { callsign: st.callsign, color: st.color });
      }
    }
  }

  const displayCount = Math.min(8, effCount);
  const seedChips = Array.from({ length: displayCount }, (_, idx) => {
    const seedNum = idx + 1;
    const seedCol = seedColorForNumber(seedNum);
    const resolved = seededNow ? resolvedBySeed.get(seedNum) : undefined;
    if (resolved) {
      return `
        <span class="bkt-seed-chip is-resolved" title="Stage ${stageIdx} Seed #${seedNum}: ${esc(resolved.callsign)}">
          <span class="mono">#${seedNum}</span>
          <span class="dot" style="--c:${resolved.color || seedCol}"></span>
          <strong>${esc(resolved.callsign)}</strong>
        </span>`;
    }
    return `
      <span class="bkt-seed-chip is-placeholder" title="Placeholder slot — populates automatically once upstream stage completes">
        <span class="mono">#${seedNum}</span>
        <span class="dot" style="--c:${seedCol}"></span>
        <span>Seed #${seedNum}</span>
      </span>`;
  }).join("");

  const portalBadgeText =
    sourceStages.length > 1
      ? `FROM ${sourceStages.map((s) => `S${s.index}`).join(" + ")}`
      : `FROM STAGE ${firstSourceIdx}`;
  const portalTitleText = round.title || (stageIdx === 2 ? "Qualifying Seeds" : `Stage ${stageIdx} Seeds`);

  const outRightPort = editableActive
    ? `<button
        type="button"
        class="bkt-port is-out is-out-right ${outgoingCount > 0 ? "has-wire" : ""} ${isSourceActive ? "is-active" : ""}"
        data-round-out="${esc(round.id)}"
        data-port-kind="out"
        data-port-side="right"
        data-port-dir="right"
        data-bkt-stop-select
        title="Stage ${stageIdx} Seeds Output — drag right into any Stage ${stageIdx} round"
      >
        <span class="bkt-port-handle">${icons.chevronRight(10)}</span>
      </button>`
    : `<span
        class="bkt-port is-out is-out-right ${outgoingCount > 0 ? "has-wire" : "is-hidden-port"}"
        data-round-out="${esc(round.id)}"
        data-port-kind="out"
        data-port-side="right"
        data-port-dir="right"
      >
        <span class="bkt-port-handle">${icons.chevronRight(10)}</span>
      </span>`;

  const posAttrs = renderNodePosAttrs(canvasMode, pos, RC_NODE_WIDTH);

  const sliceSummary =
    inConns.length === 1 && inConns[0].mode === "seed_range" && (inConns[0].seedStart ?? 0) > 0
      ? `Seeds #${inConns[0].seedStart}–#${inConns[0].seedEnd || effCount}`
      : inConns.length === 1 && inConns[0].mode === "top_n" && (inConns[0].count ?? 0) > 0
        ? `Top ${inConns[0].count} Seeds`
        : `${effCount} Seeds`;

  return `
    <div
      class="bkt-round-node is-handoff-node lane-handoff_in ${editableActive ? "is-editable-node" : ""} ${canvasMode ? "is-rc-node" : ""} ${isSelected ? "is-selected-node" : ""} ${isSourceActive ? "is-wire-source" : ""}"
      data-round-node="${esc(round.id)}"
      data-round-lane="handoff_in"
      data-round-col="0"
      ${posAttrs}
    >
      ${outRightPort}
      <div class="bkt-round-head ${editableActive || canvasMode ? "is-draggable-head" : "is-readonly"}" ${editableActive || canvasMode ? `data-round-drag-handle="${esc(round.id)}" data-bkt-stop-select` : ""}>
        <div class="bkt-round-head-top">
          <div class="bkt-round-title-wrap">
            ${editableActive || canvasMode ? `<span class="bkt-node-drag-grip">${icons.grip(13)}</span>` : ""}
            <span class="bkt-portal-badge">${esc(portalBadgeText)}</span>
            <strong class="bkt-round-title-static">${esc(portalTitleText)}</strong>
          </div>
          ${
            editableActive
              ? `<div class="bkt-round-head-btns">
                  <button type="button" class="bkt-node-hamburger" data-bkt-action="open_stage_handoff" title="Edit Stage Advancement">
                    ${icons.sliders(13)}
                  </button>
                </div>`
              : ""
          }
        </div>
        <div class="bkt-round-meta-pills" style="padding-left:0">
          ${firstSourceIdx === 1 ? `<span class="bkt-meta-pill">${esc(formatQualifyingMetricLabel(curMetric))}</span>` : ""}
          <span class="bkt-meta-pill">${esc(sliceSummary)}</span>
          <span class="race-state-pill ${seededNow ? "is-done" : "is-ready"}">
            ${seededNow ? "Populated ✓" : `Placeholders (${confirmedSrc}/${srcHeats.length})`}
          </span>
        </div>
      </div>
      <div class="bkt-handoff-body" data-bkt-stop-select>
        <div class="bkt-handoff-seeds">
          ${seedChips}
          ${effCount > displayCount ? `<span class="bkt-seed-more note">+${effCount - displayCount} more (#${displayCount + 1}–#${effCount})</span>` : ""}
        </div>
        <div class="bkt-handoff-note">
          ${
            editableActive
              ? `Drag from the right port to feed all seeds or custom slices into Stage ${stageIdx} rounds.`
              : seededNow
                ? `Upstream seeds are locked into Stage ${stageIdx} seats.`
                : `Seats hold Seed # placeholders until Stage ${firstSourceIdx} completes.`
          }
        </div>
        ${
          editableActive
            ? `<div class="bkt-handoff-actions">
                <button type="button" class="btn btn-ghost btn-xs bkt-portal-jump-btn" data-bkt-stage="${firstSourceIdx}">
                  ${icons.chevronLeft(13)}<span>Stage ${firstSourceIdx}</span>
                </button>
                <button type="button" class="btn btn-ghost btn-xs" data-bkt-action="open_stage_handoff">
                  ${icons.sliders(12)}<span>${(race.stages?.length ?? 0) > 2 ? "Format…" : "Cutoff…"}</span>
                </button>
              </div>`
            : ""
        }
      </div>
    </div>`;
}

function renderStagePilotsNode(
  race: RaceTournamentState,
  round: RaceRound,
  outgoingCount: number,
  editableActive: boolean,
  canvasMode: boolean,
  allStageHeats: RaceHeat[],
  roster: EventPilot[],
  pos?: RenderedNodePos,
  ui?: BracketEditorUiState
): string {
  const stageIdx = round.stageIndex || 1;
  const isSourceActive = editableActive && ui?.connectingFromRoundId === round.id;
  const isSelected = canvasMode && !!ui?.selectedRoundIds.has(round.id);

  const seatedMap = new Map<number, { heatLabel: string; channelLabel: string }>();
  for (const h of allStageHeats) {
    for (const s of h.seats) {
      if (s.pilotSlotIndex > 0 && !seatedMap.has(s.pilotSlotIndex)) {
        seatedMap.set(s.pilotSlotIndex, {
          heatLabel: h.shortLabel || h.id,
          channelLabel: s.channelLabel || formatBandChannelShort(s.band, s.channel) || `R${s.channel}`,
        });
      }
    }
  }

  const countedPilots = new Set<number>();
  for (const h of race.heats ?? []) {
    if (
      h.state !== "running" &&
      h.state !== "paused" &&
      h.state !== "finished" &&
      h.state !== "confirmed"
    ) {
      continue;
    }
    for (const s of h.seats) {
      if (s.pilotSlotIndex > 0 && s.status !== "dns") {
        countedPilots.add(s.pilotSlotIndex);
      }
    }
  }

  let checkedInCount = 0;
  let inCount = 0;
  let unseatedCount = 0;
  let outCount = 0;
  let uncheckedCount = 0;
  for (const p of roster) {
    const attNorm = p.attendance === "forfeit" ? "dnc" : p.attendance || "active";
    if (p.checkedIn) {
      checkedInCount++;
      if (attNorm === "active") {
        inCount++;
        if (!seatedMap.has(p.slotIndex)) unseatedCount++;
      } else {
        outCount++;
      }
    } else {
      uncheckedCount++;
      unseatedCount++;
    }
  }

  const curFilter = ui?.pilotsNodeFilter ?? "all";
  const searchVal = ui?.pilotsNodeSearch ?? "";
  const searchTrimmed = searchVal.trim();
  const searchRaw = searchTrimmed.toLowerCase();
  const exactSearchPilot = searchRaw
    ? roster.find((p) => p.callsign.trim().toLowerCase() === searchRaw)
    : undefined;

  let visibleCount = 0;
  const rowsHtml =
    roster.length === 0
      ? ""
      : roster
          .map((p) => {
            const attNorm = p.attendance === "forfeit" ? "dnc" : p.attendance || "active";
            const isIn = p.checkedIn && attNorm === "active";
            const isAway = p.checkedIn && attNorm === "away";
            const isDq = p.checkedIn && attNorm === "dq";
            const isDnc = p.checkedIn && attNorm === "dnc";
            const isFree = !p.checkedIn || (isIn && !seatedMap.has(p.slotIndex));
            const isOut = p.checkedIn && attNorm !== "active";
            const hasCountedHeats = countedPilots.has(p.slotIndex);
            const seated = seatedMap.get(p.slotIndex);
            const callsignLower = p.callsign.trim().toLowerCase();
            const hay = `${p.callsign} ${p.phoneticName || ""} #${p.slotIndex}`.toLowerCase();
            const matchesTab =
              curFilter === "in"
                ? isIn
                : curFilter === "unseated"
                  ? isFree
                  : curFilter === "out"
                    ? isOut
                    : true;
            const matchesRow = searchRaw ? hay.includes(searchRaw) : matchesTab;
            if (matchesRow) visibleCount++;
            const isExactMatch = !!searchRaw && callsignLower === searchRaw;

            const seatChip = seated
              ? `<span class="bkt-pilot-seat-tag mono" title="Seated in ${esc(seated.heatLabel)} (${esc(seated.channelLabel)})">${esc(seated.heatLabel)} · ${esc(seated.channelLabel)}</span>`
              : isIn && allStageHeats.length > 0 && editableActive
                ? `<button type="button" class="bkt-pilot-autoseat-btn" data-bkt-action="auto_seat_pilot" data-pilot-slot="${p.slotIndex}" title="Seat into first open heat slot">+ Seat</button>`
                : "";

            const switchLocked = !editableActive || (p.checkedIn && hasCountedHeats);
            const switchTitle =
              p.checkedIn && hasCountedHeats
                ? `${p.callsign} has recorded heats in this race — mark AWY, DQ, or DNC instead`
                : p.checkedIn
                  ? `Uncheck ${p.callsign} (return to Free state)`
                  : `Check in ${p.callsign}`;
            const checkInSwitch = `
              <button
                type="button"
                role="switch"
                aria-checked="${p.checkedIn ? "true" : "false"}"
                aria-label="${esc(switchTitle)}"
                class="bkt-checkin-switch ${p.checkedIn ? "is-on" : ""}"
                data-bkt-action="pilot_checkin_toggle"
                data-slot-index="${p.slotIndex}"
                ${switchLocked ? "disabled" : ""}
                title="${esc(switchTitle)}"
              >
                <span class="bkt-checkin-thumb"></span>
              </button>`;

            const attControls = editableActive
              ? p.checkedIn
                ? `<div class="bkt-pilot-att-seg" role="group" aria-label="Status for ${esc(p.callsign)}">
                    <button type="button" class="bkt-pilot-att-btn ${isAway ? "is-active" : ""}" data-bkt-action="pilot_attendance" data-slot-index="${p.slotIndex}" data-att-status="away" aria-pressed="${isAway ? "true" : "false"}" title="${isAway ? "Clear AWY status (return to active)" : "Temporarily away (AWY)"}">AWY</button>
                    <button type="button" class="bkt-pilot-att-btn ${isDq ? "is-active" : ""}" data-bkt-action="pilot_attendance" data-slot-index="${p.slotIndex}" data-att-status="dq" aria-pressed="${isDq ? "true" : "false"}" title="${isDq ? "Clear DQ status (restore pilot)" : "Disqualify pilot from race (DQ)"}">DQ</button>
                    <button type="button" class="bkt-pilot-att-btn ${isDnc ? "is-active" : ""}" data-bkt-action="pilot_attendance" data-slot-index="${p.slotIndex}" data-att-status="dnc" aria-pressed="${isDnc ? "true" : "false"}" title="${isDnc ? "Clear DNC status (return to active)" : "Did Not Complete remaining race (DNC)"}">DNC</button>
                  </div>`
                : `<span class="bkt-pilot-unchecked-lbl">Free</span>`
              : `<span class="race-state-pill ${isIn ? "is-done" : isAway ? "is-warn" : isDq || isDnc ? "is-bad" : "is-ready"}">${!p.checkedIn ? "Free" : isIn ? "Racing" : isAway ? "AWY" : isDq ? "DQ" : "DNC"}</span>`;

            return `
              <div
                class="bkt-pilot-item ${isIn ? "is-in" : "is-inactive"} ${isExactMatch ? "is-exact-match" : ""}"
                data-pilot-search-hay="${esc(hay)}"
                data-pilot-callsign="${esc(callsignLower)}"
                data-pilot-tab-match="${matchesTab ? "1" : "0"}"
                ${isIn && editableActive ? `draggable="true" data-drag-pilot="${p.slotIndex}"` : ""}
                ${matchesRow ? "" : "hidden"}
              >
                <div class="bkt-pilot-item-main">
                  ${checkInSwitch}
                  <span class="dot" style="--c:${p.color || "#38bdf8"}"></span>
                  <strong class="bkt-pilot-callsign" title="${esc(p.callsign)}${isIn && editableActive ? " — drag onto any heat seat" : ""}">${esc(p.callsign)}</strong>
                  ${seatChip}
                </div>
                ${attControls}
              </div>`;
          })
          .join("");

  const emptyNoteText =
    roster.length === 0
      ? "No pilots in roster yet — type a callsign above to add."
      : searchTrimmed
        ? `No existing pilots match “${searchTrimmed}” — click Add to register.`
        : "No pilots match this filter.";

  const outRightPort = editableActive
    ? `<button
        type="button"
        class="bkt-port is-out is-out-right ${outgoingCount > 0 ? "has-wire" : ""} ${isSourceActive ? "is-active" : ""}"
        data-round-out="${esc(round.id)}"
        data-port-kind="out"
        data-port-side="right"
        data-port-dir="right"
        data-bkt-stop-select
        title="Pilots Roster Output — drag right into any starting round to auto-populate active pilots"
      >
        <span class="bkt-port-handle">${icons.chevronRight(10)}</span>
      </button>`
    : `<span
        class="bkt-port is-out is-out-right ${outgoingCount > 0 ? "has-wire" : "is-hidden-port"}"
        data-round-out="${esc(round.id)}"
        data-port-kind="out"
        data-port-side="right"
        data-port-dir="right"
      >
        <span class="bkt-port-handle">${icons.chevronRight(10)}</span>
      </span>`;

  const posAttrs = renderNodePosAttrs(canvasMode, pos, RC_PILOTS_NODE_WIDTH);

  const walkupAddDisabled = !searchTrimmed || !!exactSearchPilot;
  const walkupBtnTitle = exactSearchPilot
    ? `Pilot “${exactSearchPilot.callsign}” is already in roster`
    : searchTrimmed
      ? `Add pilot “${searchTrimmed}”`
      : "Search or type a unique callsign to add";

  return `
    <div
      class="bkt-round-node is-handoff-node is-pilots-node lane-pilots_in ${editableActive ? "is-editable-node" : ""} ${canvasMode ? "is-rc-node" : ""} ${isSelected ? "is-selected-node" : ""} ${isSourceActive ? "is-wire-source" : ""}"
      data-round-node="${esc(round.id)}"
      data-round-lane="pilots_in"
      data-round-col="0"
      data-stage-idx="${stageIdx}"
      ${posAttrs}
    >
      ${outRightPort}
      <div class="bkt-round-head ${editableActive || canvasMode ? "is-draggable-head" : "is-readonly"}" ${editableActive || canvasMode ? `data-round-drag-handle="${esc(round.id)}" data-bkt-stop-select` : ""}>
        <div class="bkt-round-head-top">
          <div class="bkt-round-title-wrap">
            ${editableActive || canvasMode ? `<span class="bkt-node-drag-grip">${icons.grip(13)}</span>` : ""}
            <strong class="bkt-round-title-static">Pilots Roster</strong>
          </div>
          <div class="bkt-round-head-btns">
            <span class="badge mono bkt-pilots-count-pill">${inCount} racing</span>
          </div>
        </div>
        <div class="bkt-pilots-subhead">
          <span class="note">${
            outgoingCount > 0
              ? `Feeding ${outgoingCount} starting round${outgoingCount === 1 ? "" : "s"}`
              : editableActive
                ? "Drag right port into a starting round"
                : "Open Stage editor to connect to a starting round"
          }</span>
          ${
            editableActive && uncheckedCount > 0
              ? `<button type="button" class="bkt-pilots-allin-btn" data-bkt-action="pilots_check_in_all" title="Check in all pilots as active">All In</button>`
              : ""
          }
        </div>
      </div>
      <div class="bkt-pilots-body" data-bkt-stop-select>
        <div class="bkt-pilots-toolbar">
          <div class="bkt-pilots-search-row">
            <div class="bkt-pilots-search-wrap">
              <span class="bkt-pilots-search-icon">${icons.search(12)}</span>
              <input
                type="search"
                class="bkt-pilots-search"
                data-pilots-node-search
                data-live-safe
                placeholder="${editableActive ? "Search or add pilot..." : "Search pilots..."}"
                value="${esc(searchVal)}"
                autocomplete="off"
                aria-label="${editableActive ? "Search or add pilot" : "Search pilots"}"
              />
            </div>
            ${
              editableActive
                ? `<button
                    type="button"
                    class="btn btn-ghost btn-xs bkt-pilots-add-btn"
                    data-bkt-action="pilots_add_walkup"
                    ${walkupAddDisabled ? "disabled" : ""}
                    title="${esc(walkupBtnTitle)}"
                  >
                    ${icons.plus(12)}<span>Add</span>
                  </button>`
                : ""
            }
          </div>
          <div class="bkt-pilots-filter-bar" role="tablist" aria-label="Pilot filter">
            <button type="button" class="bkt-pilots-filter-btn ${curFilter === "all" ? "is-active" : ""}" data-bkt-ui="pilots-node-filter" data-filter="all">All (${roster.length})</button>
            <button type="button" class="bkt-pilots-filter-btn ${curFilter === "in" ? "is-active" : ""}" data-bkt-ui="pilots-node-filter" data-filter="in">In (${inCount})</button>
            <button type="button" class="bkt-pilots-filter-btn ${curFilter === "unseated" ? "is-active" : ""}" data-bkt-ui="pilots-node-filter" data-filter="unseated">Free (${unseatedCount})</button>
            <button type="button" class="bkt-pilots-filter-btn ${curFilter === "out" ? "is-active" : ""}" data-bkt-ui="pilots-node-filter" data-filter="out">Out (${outCount})</button>
          </div>
        </div>
        <div class="bkt-pilots-list" data-pilots-node-list>
          ${rowsHtml}
          <div class="bkt-pilots-empty note" data-pilots-node-empty ${visibleCount > 0 ? "hidden" : ""}>${esc(emptyNoteText)}</div>
        </div>
      </div>
    </div>`;
}

function renderOpenQualRoundNode(
  race: RaceTournamentState,
  round: RaceRound,
  heats: RaceHeat[],
  incomingCount: number,
  outgoingCount: number,
  editableActive: boolean,
  canvasMode: boolean,
  interactive: boolean,
  activeHeatId: string,
  allStageHeats: RaceHeat[],
  activePilots: EventPilot[],
  validClickTargets: Set<string>,
  pos?: RenderedNodePos,
  ui?: BracketEditorUiState,
  portState?: ConnectedPortSet
): string {
  const stageIdx = round.stageIndex || 1;
  const stgObj = race.stages?.find((s) => s.index === stageIdx);
  const stgSettings = stgObj?.settings ?? race.config;
  const maxPacks = stgSettings.maxPacksPerPilot ?? race.config.maxPacksPerPilot ?? 0;
  const curMetric = stgSettings.qualifyingMetric || race.config.qualifyingMetric || "consecutive_3";
  const curTime = round.timeLimitSec || stgSettings.timeLimitSec || race.config.timeLimitSec || 120;
  const allUnstarted = heats.every((h) => isHeatUnstarted(h.state));
  const confirmedCount = heats.filter((h) => h.state === "confirmed").length;
  const isSelected = canvasMode && !!ui?.selectedRoundIds.has(round.id);
  const isSourceActive = editableActive && ui?.connectingFromRoundId === round.id;
  const isClickTarget = editableActive && validClickTargets.has(round.id);

  const hasInLeft = portState ? portState.inLeft : incomingCount > 0;
  const hasInTop = portState ? portState.inTop : false;
  const hasInBottom = portState ? portState.inBottom : false;
  const hasOutRight = portState ? portState.outRight : outgoingCount > 0;

  const posAttrs = renderNodePosAttrs(canvasMode, pos, RC_NODE_WIDTH);
  const isMenuOpen = editableActive && ui?.openNodeMenuId === round.id;
  const isZippyQ =
    (round.title || "").toLowerCase().includes("zippyq") ||
    (stgObj?.title || "").toLowerCase().includes("zippyq") ||
    Boolean(race.mgpLink?.isZippyQ && stageIdx === 1);
  const normTitle =
    !round.title ||
    round.title === "Flight Line Packs" ||
    round.title === "Flight line" ||
    round.title === "Flight Queue" ||
    (isZippyQ &&
      (round.title === "Open Qualifier" ||
        round.title === "ZippyQ" ||
        round.title === "ZippyQ Qualifier"))
      ? isZippyQ
        ? `ZippyQ Round ${round.round || round.column || 1}`
        : "Open Qualifier"
      : round.title;

  const inLeftPort = `
    <span
      class="bkt-port is-in is-in-left ${hasInLeft ? "has-wire" : ""} ${!editableActive && !hasInLeft ? "is-hidden-port" : ""}"
      data-round-in="${esc(round.id)}"
      data-port-kind="in"
      data-port-side="left"
      data-bkt-stop-select
      title="${isClickTarget ? `Click to connect into ${esc(normTitle)} (left input)` : "Checked-In Pilots feeding Open Qualifier Flight Queue"}"
    >
      <span class="bkt-port-handle">${icons.chevronRight(10)}</span>
    </span>`;

  const inTopPort = `
    <span
      class="bkt-port is-in is-in-top ${hasInTop ? "has-wire" : ""} ${!editableActive && !hasInTop ? "is-hidden-port" : ""}"
      data-round-in-top="${esc(round.id)}"
      data-port-kind="in"
      data-port-side="top"
      data-bkt-stop-select
      title="${isClickTarget ? `Click to connect into ${esc(normTitle)} (top input)` : "Input from round above"}"
    >
      <span class="bkt-port-handle">${icons.chevronDown(10)}</span>
    </span>`;

  const inBottomPort = `
    <span
      class="bkt-port is-in is-in-bottom is-aux-bottom ${hasInBottom ? "has-wire" : ""} ${!editableActive && !hasInBottom ? "is-hidden-port" : ""}"
      data-round-in-bottom="${esc(round.id)}"
      data-port-kind="in"
      data-port-side="bottom"
      data-bkt-stop-select
      title="${isClickTarget ? `Click to connect into ${esc(normTitle)} (bottom input)` : "Input from round below"}"
    >
      <span class="bkt-port-handle">${icons.chevronUp(10)}</span>
    </span>`;

  const outRightPort = editableActive
    ? `<button
        type="button"
        class="bkt-port is-out is-out-right ${hasOutRight ? "has-wire" : ""} ${isSourceActive ? "is-active" : ""}"
        data-round-out="${esc(round.id)}"
        data-port-kind="out"
        data-port-side="right"
        data-port-dir="right"
        data-bkt-stop-select
        title="Open Qualifier Standings Output — drag right into Stage Seeding if advancing to a bracket"
      >
        <span class="bkt-port-handle">${icons.chevronRight(10)}</span>
      </button>`
    : `<span
        class="bkt-port is-out is-out-right ${hasOutRight ? "has-wire" : "is-hidden-port"}"
        data-round-out="${esc(round.id)}"
        data-port-kind="out"
        data-port-side="right"
        data-port-dir="right"
      >
        <span class="bkt-port-handle">${icons.chevronRight(10)}</span>
      </span>`;

  const connectOverlayBtn = isClickTarget
    ? `<button
        type="button"
        class="bkt-connect-target-bar"
        data-bkt-action="complete_connect"
        data-to-round-id="${esc(round.id)}"
        data-bkt-stop-select
      >
        ${icons.link(12)}<span>Click here to connect into ${esc(normTitle)}</span>
      </button>`
    : "";

  const isCustomMaxPacks = maxPacks > 0 && maxPacks !== 2 && maxPacks !== 3;
  const openQualMenu = isMenuOpen
    ? `<div class="bkt-node-menu" role="menu" data-bkt-stop-select>
        <button
          type="button"
          class="bkt-node-menu-item"
          data-bkt-action="open_open_qual_settings"
          data-stage-idx="${stageIdx}"
          data-round-id="${esc(round.id)}"
        >
          ${icons.sliders(14)}
          <span>${isZippyQ ? "ZippyQ Settings…" : "Open Qualifier Settings…"}</span>
        </button>
        <div class="bkt-node-menu-sep"></div>
        <button
          type="button"
          class="bkt-node-menu-item"
          data-bkt-action="delete_round"
          data-round-id="${esc(round.id)}"
          data-col="${round.column || 1}"
          data-bkt-lane="${esc(round.bracketLane || "open_qual")}"
          data-round-title="${esc(normTitle)}"
          data-heat-count="${heats.length}"
          ${allUnstarted ? "" : "disabled"}
        >
          ${icons.trash(14)}
          <span>Delete Round</span>
        </button>
      </div>`
    : "";

  const bodyHtml =
    editableActive || heats.length === 0
      ? `<div class="bkt-open-qual-empty" data-bkt-stop-select>
          <p class="note">${
            isZippyQ
              ? "Pilots check in and line up through <strong>MultiGP ZippyQ</strong>. Pull ZippyQ round heats on demand in <strong>Race Control</strong> or queue heats from the Flight Line."
              : "Pilots fly walk-up qualifying heats on demand in <strong>Race Control</strong>. Queue pilots from the Flight Line as they are ready; VTX channels assign Sticky Raceband slots with anti-back-to-back spacing."
          }</p>
          ${
            editableActive
              ? `<div style="margin-top:10px;display:flex;flex-direction:column;gap:5px">
                  <span class="note" style="font-weight:600;font-size:11.5px">Max heats per pilot</span>
                  <div class="races-preset-pills" style="flex-wrap:nowrap">
                    <button type="button" class="races-filter-pill ${maxPacks === 0 ? "is-active" : ""}" data-bkt-action="set_open_qual_max_packs" data-stage-idx="${stageIdx}" data-max-packs="0" aria-label="Unlimited heats per pilot" title="Unlimited heats per pilot">&infin;</button>
                    <button type="button" class="races-filter-pill ${maxPacks === 2 ? "is-active" : ""}" data-bkt-action="set_open_qual_max_packs" data-stage-idx="${stageIdx}" data-max-packs="2">2</button>
                    <button type="button" class="races-filter-pill ${maxPacks === 3 ? "is-active" : ""}" data-bkt-action="set_open_qual_max_packs" data-stage-idx="${stageIdx}" data-max-packs="3">3</button>
                    <button type="button" class="races-filter-pill ${isCustomMaxPacks ? "is-active" : ""}" data-bkt-action="open_open_qual_settings" data-stage-idx="${stageIdx}" data-round-id="${esc(round.id)}">${isCustomMaxPacks ? `${maxPacks} · More` : "More"}</button>
                  </div>
                </div>`
              : ""
          }
        </div>`
      : `<div class="bkt-round-heats">
          ${heats
            .map((h) =>
              renderHeatCard(
                h,
                activeHeatId,
                interactive,
                false,
                heats.length,
                allStageHeats,
                activePilots,
                0
              )
            )
            .join("")}
        </div>`;

  return `
    <div
      class="bkt-round-node is-open-qual-node lane-qualifying ${editableActive ? "is-editable-node" : ""} ${canvasMode ? "is-rc-node" : ""} ${isSelected ? "is-selected-node" : ""} ${isMenuOpen ? "has-open-menu" : ""} ${isSourceActive ? "is-wire-source" : ""} ${isClickTarget ? "is-wire-candidate" : ""}"
      data-round-node="${esc(round.id)}"
      data-round-lane="qualifying"
      data-round-col="${round.column || 1}"
      ${posAttrs}
    >
      ${inLeftPort}
      ${inTopPort}
      ${inBottomPort}
      ${outRightPort}
      <div class="bkt-round-head ${editableActive || canvasMode ? "is-draggable-head" : "is-readonly"}" ${editableActive || canvasMode ? `data-round-drag-handle="${esc(round.id)}" data-bkt-stop-select` : ""}>
        <div class="bkt-round-head-top">
          <div class="bkt-round-title-wrap">
            ${editableActive || canvasMode ? `<span class="bkt-node-drag-grip">${icons.grip(13)}</span>` : ""}
            <strong class="bkt-round-title-static">${esc(normTitle)}</strong>
          </div>
          <div class="bkt-round-head-btns">
            ${!editableActive && heats.length > 0 ? `<span class="note mono">${confirmedCount}/${heats.length} heats</span>` : ""}
            ${
              editableActive
                ? `<button
                    type="button"
                    class="bkt-node-delete-btn"
                    data-bkt-action="delete_round"
                    data-round-id="${esc(round.id)}"
                    data-col="${round.column || 1}"
                    data-bkt-lane="${esc(round.bracketLane || "open_qual")}"
                    data-round-title="${esc(normTitle)}"
                    data-heat-count="${heats.length}"
                    ${allUnstarted ? "" : "disabled"}
                    aria-label="Delete ${esc(normTitle)}"
                    title="${allUnstarted ? `Delete ${esc(normTitle)}` : "Cannot delete a round with started heats"}"
                  >
                    ${icons.trash(13)}
                  </button>
                  <button
                    type="button"
                    class="bkt-node-hamburger ${isMenuOpen ? "is-open" : ""}"
                    data-bkt-ui="toggle-node-menu"
                    data-round-id="${esc(round.id)}"
                    aria-label="${isZippyQ ? "ZippyQ options" : "Open Qualifier options"}"
                    aria-expanded="${isMenuOpen ? "true" : "false"}"
                    title="${isZippyQ ? "ZippyQ settings" : "Open Qualifier settings"}"
                  >
                    ${icons.menu(14)}
                  </button>`
                : ""
            }
          </div>
        </div>
        <div class="bkt-round-meta-pills">
          <span class="bkt-meta-pill">${esc(formatQualifyingMetricLabel(curMetric))}</span>
          <span class="bkt-meta-pill">${maxPacks > 0 ? `Max ${maxPacks}/pilot` : "&infin; heats"}</span>
          <span class="bkt-meta-pill">${formatRaceClock(curTime).slice(0, 5)}</span>
        </div>
        ${openQualMenu}
      </div>
      ${connectOverlayBtn}
      ${bodyHtml}
    </div>`;
}

function formatFinalsRuleBadge(round: RaceRound, heats: RaceHeat[], race: RaceTournamentState): string {
  const fmt =
    round.finalsFormat ||
    (round.stageFormat === "chase_the_ace" || heats.some((h) => isChaseHeatId(h.id))
      ? "chase_the_ace"
      : round.stageFormat === "points_mains" && heats.length > 1
        ? "points_final"
        : race.config.finalsFormat || "single_final");
  if (fmt === "chase_the_ace") {
    const wins = round.aceWinsRequired || race.config.aceWinsRequired || 2;
    return `Chase the Ace · ${wins} Wins`;
  }
  if (fmt === "points_final") {
    const cnt = round.finalsHeats || Math.max(2, heats.length) || 3;
    return `Points Final · ${cnt} Heats`;
  }
  return "Single Heat Final";
}

interface ConnectedPortSet {
  inLeft: boolean;
  inTop: boolean;
  inBottom: boolean;
  outRight: boolean;
  outBottom: boolean;
}

function renderRoundNode(
  race: RaceTournamentState,
  round: RaceRound,
  heats: RaceHeat[],
  incomingCount: number,
  outgoingCount: number,
  editableActive: boolean,
  canvasMode: boolean,
  interactive: boolean,
  activeHeatId: string,
  allStageHeats: RaceHeat[],
  activePilots: EventPilot[],
  validClickTargets: Set<string>,
  pos?: RenderedNodePos,
  ui?: BracketEditorUiState,
  portState?: ConnectedPortSet,
  fullRoster?: EventPilot[]
): string {
  if (isPilotsInRoundId(round.id) || round.bracketLane === "pilots_in") {
    return renderStagePilotsNode(
      race,
      round,
      outgoingCount,
      editableActive,
      canvasMode,
      allStageHeats,
      fullRoster ?? race.roster ?? activePilots,
      pos,
      ui
    );
  }
  if (isOpenQualRoundId(round.id) || round.stageFormat === "open_qualifier") {
    return renderOpenQualRoundNode(
      race,
      round,
      heats,
      incomingCount,
      outgoingCount,
      editableActive,
      canvasMode,
      interactive,
      activeHeatId,
      allStageHeats,
      activePilots,
      validClickTargets,
      pos,
      ui,
      portState
    );
  }
  if (isHandoffOutRoundId(round.id) || round.bracketLane === "handoff_out") {
    return renderStage1HandoffNode(
      race,
      round,
      incomingCount,
      editableActive,
      canvasMode,
      activePilots,
      validClickTargets,
      pos,
      ui
    );
  }
  if (isHandoffInRoundId(round.id) || round.bracketLane === "handoff_in") {
    return renderStage2HandoffNode(
      race,
      round,
      outgoingCount,
      editableActive,
      canvasMode,
      activePilots,
      pos,
      ui
    );
  }

  const maxStageSeeds =
    round.stageIndex >= 2 ? effectiveStageSeedCount(race, round.stageIndex, activePilots.length) : 0;
  const allUnstarted = heats.every((h) => isHeatUnstarted(h.state));
  const confirmedCount = heats.filter((h) => h.state === "confirmed").length;
  const isSourceActive = editableActive && ui?.connectingFromRoundId === round.id;
  const isSourceRight = isSourceActive && ui?.connectingFromPortDir !== "bottom";
  const isSourceBottom = isSourceActive && ui?.connectingFromPortDir === "bottom";
  const isClickTarget = editableActive && validClickTargets.has(round.id);
  const isSelected = canvasMode && !!ui?.selectedRoundIds.has(round.id);
  const isMenuOpen = editableActive && ui?.openNodeMenuId === round.id;
  const isFinalsLane = round.bracketLane === "finals";
  const finalsRuleLabel = isFinalsLane ? formatFinalsRuleBadge(round, heats, race) : "";

  const curLaps =
    round.targetLaps !== undefined ? round.targetLaps : heats[0]?.targetLaps ?? race.config.targetLaps ?? 3;
  const curTime =
    round.timeLimitSec || heats[0]?.timeLimitSec || race.config.timeLimitSec || 120;
  const isTimed = round.stageFormat === "qualifying";
  const isPoints = round.stageFormat === "points_mains";
  const fmtBadge = isTimed ? "Timed" : isPoints ? "Points" : "Race";
  const lapsBadge = isTimed && curLaps === 0 ? "Fastest laps" : `${curLaps || 3} laps`;
  const startMode = round.startMode || heats[0]?.startMode || (isTimed ? "staggered" : "heads_up");

  const hasInLeft = portState ? portState.inLeft : incomingCount > 0;
  const hasInTop = portState ? portState.inTop : false;
  const hasInBottom = portState ? portState.inBottom : false;
  const hasOutRight = portState ? portState.outRight : outgoingCount > 0;
  const hasOutBottom = portState ? portState.outBottom : false;

  const inLeftPort = `
    <span
      class="bkt-port is-in is-in-left ${hasInLeft ? "has-wire" : ""} ${!editableActive && !hasInLeft ? "is-hidden-port" : ""}"
      data-round-in="${esc(round.id)}"
      data-port-kind="in"
      data-port-side="left"
      data-bkt-stop-select
      title="${isClickTarget ? `Click to connect into ${esc(round.title)} (left input)` : "Input from previous round (left)"}"
    >
      <span class="bkt-port-handle">${icons.chevronRight(10)}</span>
    </span>`;

  const inTopPort = `
    <span
      class="bkt-port is-in is-in-top ${hasInTop ? "has-wire" : ""} ${!editableActive && !hasInTop ? "is-hidden-port" : ""}"
      data-round-in-top="${esc(round.id)}"
      data-port-kind="in"
      data-port-side="top"
      data-bkt-stop-select
      title="${isClickTarget ? `Click to connect into ${esc(round.title)} (top input)` : "Input from upper bracket round above"}"
    >
      <span class="bkt-port-handle">${icons.chevronDown(10)}</span>
    </span>`;

  const inBottomPort = `
    <span
      class="bkt-port is-in is-in-bottom ${isFinalsLane ? "is-finals-bottom" : "is-aux-bottom"} ${hasInBottom ? "has-wire" : ""} ${!editableActive && !hasInBottom ? "is-hidden-port" : ""}"
      data-round-in-bottom="${esc(round.id)}"
      data-port-kind="in"
      data-port-side="bottom"
      data-bkt-stop-select
      title="${isClickTarget ? `Click to connect into ${esc(round.title)} (bottom input)` : "Input from lower round below"}"
    >
      <span class="bkt-port-handle">${icons.chevronUp(10)}</span>
    </span>`;

  const outRightPort = editableActive && !isFinalsLane
    ? `<button
        type="button"
        class="bkt-port is-out is-out-right ${hasOutRight ? "has-wire" : ""} ${isSourceRight ? "is-active" : ""}"
        data-round-out="${esc(round.id)}"
        data-port-kind="out"
        data-port-side="right"
        data-port-dir="right"
        data-bkt-stop-select
        title="Advance Output — drag to connect to next round"
      >
        <span class="bkt-port-handle">${icons.chevronRight(10)}</span>
      </button>`
    : `<span
        class="bkt-port is-out is-out-right ${!isFinalsLane && hasOutRight ? "has-wire" : "is-hidden-port"}"
        data-round-out="${esc(round.id)}"
        data-port-kind="out"
        data-port-side="right"
        data-port-dir="right"
      >
        <span class="bkt-port-handle">${icons.chevronRight(10)}</span>
      </span>`;

  const outBottomPort =
    editableActive && !isFinalsLane
      ? `<button
          type="button"
          class="bkt-port is-out is-out-bottom ${hasOutBottom ? "has-wire" : ""} ${isSourceBottom ? "is-active" : ""}"
          data-round-out="${esc(round.id)}"
          data-port-kind="out"
          data-port-side="bottom"
          data-port-dir="bottom"
          data-bkt-stop-select
          title="Drop Output (Bottom pilots) — drag down into a Redemption / Lower round"
        >
          <span class="bkt-port-handle">${icons.chevronDown(10)}</span>
        </button>`
      : `<span
          class="bkt-port is-out is-out-bottom ${!isFinalsLane && hasOutBottom ? "has-wire" : "is-hidden-port"}"
          data-round-out-bottom="${esc(round.id)}"
          data-port-kind="out"
          data-port-side="bottom"
          data-port-dir="bottom"
        >
          <span class="bkt-port-handle">${icons.chevronDown(10)}</span>
        </span>`;

  const isSeeded =
    incomingCount === 0 &&
    (round.seedSource === "all_active_pilots" ||
      (round.column === 1 && round.seedSource !== "empty"));

  const sourceChip = editableActive
    ? incomingCount === 0
      ? isSeeded
        ? `<span class="bkt-meta-pill is-seeded" title="Automatically seeds all Active checked-in pilots">${icons.pilot(10)}<span>Active Pilots</span></span>`
        : `<button type="button" class="bkt-meta-pill is-unconnected" data-bkt-action="set_round_seed" data-round-id="${esc(round.id)}" data-seed-mode="all_active_pilots" data-bkt-stop-select title="Drag a wire into this round, or click to seed all Active pilots">Unconnected · Seed?</button>`
      : ""
    : "";

  const addHeatHeaderReason =
    editableActive && !isFinalsLane
      ? computeAddHeatDisabledReason(race, round, heats, incomingCount, activePilots)
      : "";
  const addHeatHeaderBtn =
    editableActive && !isFinalsLane
      ? `<button
          type="button"
          class="bkt-node-add-heat-btn"
          data-bkt-action="add_heat"
          data-round-id="${esc(round.id)}"
          data-bkt-col="${round.column}"
          data-bkt-lane="${esc(round.bracketLane)}"
          data-bkt-round="${round.round}"
          data-bkt-stop-select
          ${addHeatHeaderReason ? "disabled" : ""}
          aria-label="Add heat to ${esc(round.title)}"
          title="${esc(addHeatHeaderReason || `Add heat to ${round.title}`)}"
        >
          ${icons.plus(13)}
        </button>`
      : "";

  const headerHtml = editableActive
    ? `<div class="bkt-round-head is-draggable-head" data-round-drag-handle="${esc(round.id)}" data-bkt-stop-select title="Drag anywhere on card to move · Double-click header to customize">
        <div class="bkt-round-head-top">
          <div class="bkt-round-title-wrap">
            <span class="bkt-node-drag-grip">${icons.grip(13)}</span>
            <strong class="bkt-round-title-static">${esc(round.title)}</strong>
          </div>
          <div class="bkt-round-head-btns">
            ${addHeatHeaderBtn}
            <button
              type="button"
              class="bkt-node-delete-btn"
              data-bkt-action="delete_round"
              data-round-id="${esc(round.id)}"
              data-col="${round.column}"
              data-bkt-lane="${esc(round.bracketLane)}"
              data-round-title="${esc(round.title)}"
              data-heat-count="${heats.length}"
              ${allUnstarted ? "" : "disabled"}
              aria-label="Delete ${esc(round.title)}"
              title="${allUnstarted ? `Delete ${esc(round.title)}` : "Cannot delete a round with started heats"}"
            >
              ${icons.trash(13)}
            </button>
            <button
              type="button"
              class="bkt-node-hamburger ${isMenuOpen ? "is-open" : ""}"
              data-bkt-ui="toggle-node-menu"
              data-round-id="${esc(round.id)}"
              aria-label="Round options menu"
              aria-expanded="${isMenuOpen ? "true" : "false"}"
              title="Round actions &amp; customization"
            >
              ${icons.menu(14)}
            </button>
          </div>
        </div>
        <div class="bkt-round-meta-pills">
          ${finalsRuleLabel ? `<span class="bkt-meta-pill">${icons.trophy(10)}<span>${esc(finalsRuleLabel)}</span></span>` : ""}
          <span class="bkt-meta-pill">${esc(fmtBadge)} · ${esc(lapsBadge)} · ${formatRaceClock(curTime).slice(0, 5)}</span>
          ${
            isTimed
              ? (() => {
                  const stgObj = race.stages?.find((s) => s.index === (round.stageIndex || 1));
                  const qRnds = stgObj?.settings?.qualifyingRounds || race.config.qualifyingRounds || 2;
                  return `<button type="button" class="bkt-meta-pill" data-bkt-action="open_qual_stage_settings" data-stage-idx="${round.stageIndex || 1}" data-round-id="${esc(round.id)}" data-bkt-stop-select title="Configure qualifying rounds (1 heat per pilot per round)">${icons.sliders(10)}<span>${qRnds} ${qRnds === 1 ? "round" : "rounds"} · 1 heat/pilot</span></button>`;
                })()
              : ""
          }
          ${startMode === "staggered" && !isTimed ? `<span class="bkt-meta-pill">Staggered</span>` : ""}
          ${sourceChip}
        </div>
        ${isMenuOpen ? renderNodeHamburgerMenu(race, round, heats, incomingCount, outgoingCount, allUnstarted, activePilots) : ""}
      </div>`
    : `<div class="bkt-round-head ${canvasMode ? "is-draggable-head" : "is-readonly"}" ${canvasMode ? `data-round-drag-handle="${esc(round.id)}" data-bkt-stop-select title="Drag card to move"` : ""}>
        <div class="bkt-round-head-top">
          <div class="bkt-round-title-wrap">
            ${canvasMode ? `<span class="bkt-node-drag-grip">${icons.grip(13)}</span>` : ""}
            <strong class="bkt-round-title-static">${esc(round.title)}</strong>
          </div>
          <span class="note mono">${confirmedCount}/${heats.length}</span>
        </div>
        <div class="bkt-round-meta-static note">
          ${finalsRuleLabel ? `<span>${esc(finalsRuleLabel)}</span><span>·</span>` : ""}
          <span>${isTimed ? "Timed" : curLaps > 0 ? `${curLaps} laps` : "Unlimited"}</span>
          <span>·</span>
          <span>${formatRaceClock(curTime)}</span>
        </div>
      </div>`;

  const connectOverlayBtn = isClickTarget
    ? `<button
        type="button"
        class="bkt-connect-target-bar"
        data-bkt-action="complete_connect"
        data-to-round-id="${esc(round.id)}"
        data-bkt-stop-select
      >
        ${icons.link(12)}<span>Click here to connect into ${esc(round.title)}</span>
      </button>`
    : "";

  const posAttrs = renderNodePosAttrs(canvasMode, pos, RC_NODE_WIDTH);

  return `
    <div
      class="bkt-round-node lane-${esc(round.bracketLane || "winners")} ${editableActive ? "is-editable-node" : ""} ${canvasMode ? "is-rc-node" : ""} ${isSelected ? "is-selected-node" : ""} ${isMenuOpen ? "has-open-menu" : ""} ${isSourceActive ? "is-wire-source" : ""} ${isClickTarget ? "is-wire-candidate" : ""}"
      data-round-node="${esc(round.id)}"
      data-round-lane="${esc(round.bracketLane || "winners")}"
      data-round-col="${round.column}"
      ${posAttrs}
    >
      ${inLeftPort}
      ${inTopPort}
      ${inBottomPort}
      ${outRightPort}
      ${outBottomPort}
      ${headerHtml}
      ${connectOverlayBtn}
      <div class="bkt-round-heats">
        ${heats
          .map((h) =>
            renderHeatCard(
              h,
              activeHeatId,
              interactive,
              editableActive,
              heats.length,
              allStageHeats,
              activePilots,
              maxStageSeeds
            )
          )
          .join("")}
      </div>
    </div>`;
}

/**
 * Renders either:
 * - Full-bleed pan/zoom canvas world (`opts.canvas === true`) for `Edit` and `Control` modes, OR
 * - Embedded read-only column graph (`opts.canvas !== true`).
 */
export function renderBracketMarkup(
  race: RaceTournamentState,
  opts: BracketRenderOptions
): string {
  const editableActive =
    !!opts.editable && race.lifecycle !== "completed" && race.lifecycle !== "scrapped";
  const canvasMode = !!opts.canvas;
  const roster = opts.raceRoster ?? race.roster ?? [];
  const activePilots = roster.filter((p) => p.checkedIn && p.attendance === "active");
  const ui = opts.editorUi;

  if (!canvasMode) {
    if (!race.generated || race.heats.length === 0) {
      return `
        <div class="race-empty-state">
          <p>No rounds in this race yet. Switch to <strong>Edit</strong> to add rounds or pick a template.</p>
        </div>`;
    }
  }

  const stagesPresent = getPresentStageIndices(race);
  const viewStage =
    opts.stageFilter && stagesPresent.includes(opts.stageFilter)
      ? opts.stageFilter
      : stagesPresent.includes(race.activeStageIndex)
        ? race.activeStageIndex
        : stagesPresent[0] || race.activeStageIndex || 1;

  if (canvasMode) {
    const stageHeats = race.generated ? race.heats.filter((h) => h.stageIndex === viewStage) : [];
    const { rounds: stageRounds, heatsByRound } = resolveStageRounds(
      race,
      viewStage,
      stageHeats,
      true
    );
    const stageConnections = resolveStageConnections(race, viewStage, stageRounds, heatsByRound);

    const inCounts = new Map<string, number>();
    const outCounts = new Map<string, number>();
    for (const c of stageConnections) {
      if (c.invalid) continue;
      outCounts.set(c.fromRoundId, (outCounts.get(c.fromRoundId) ?? 0) + 1);
      inCounts.set(c.toRoundId, (inCounts.get(c.toRoundId) ?? 0) + 1);
    }

    const validClickTargets =
      editableActive && ui?.connectingFromRoundId
        ? getValidTargetRoundIds(
            race,
            stageRounds,
            heatsByRound,
            stageConnections,
            ui.connectingFromRoundId,
            ui.connectingFromPortDir
          )
        : new Set<string>();

    const pph = race.config.pilotsPerHeat || 4;
    const positions = computeRoundPositions(
      stageRounds,
      heatsByRound,
      pph,
      ui,
      stageConnections
    );

    const controlBoundaryY =
      typeof opts.controlBoundaryY === "number" && opts.controlBoundaryY > 0
        ? opts.controlBoundaryY
        : 0;
    let minStageY = 0;
    if (controlBoundaryY > 0) {
      for (const r of stageRounds) {
        const p = positions.get(r.id);
        if (p && p.y < minStageY) minStageY = p.y;
      }
    }
    const initialStageOffsetY =
      controlBoundaryY > 0
        ? controlBoundaryY + CONTROL_STAGE_TOP_CLEARANCE - Math.min(0, minStageY)
        : 0;

    const estBoxes = new Map<string, NodeWorldBox>();
    const portStateByRound = new Map<string, ConnectedPortSet>();
    for (const r of stageRounds) {
      const p = positions.get(r.id) ?? { x: RC_ORIGIN_X, y: RC_ORIGIN_Y };
      estBoxes.set(r.id, {
        id: r.id,
        lane: r.bracketLane || "winners",
        x: p.x,
        y: p.y,
        w: isPilotsInRoundId(r.id) ? RC_PILOTS_NODE_WIDTH : RC_NODE_WIDTH,
        h: estimateNodeHeight(heatsByRound.get(r.id) ?? [], pph, r),
        el: null as unknown as HTMLElement,
      });
      portStateByRound.set(r.id, {
        inLeft: false,
        inTop: false,
        inBottom: false,
        outRight: false,
        outBottom: false,
      });
    }
    for (const conn of stageConnections) {
      const fb = estBoxes.get(conn.fromRoundId);
      const tb = estBoxes.get(conn.toRoundId);
      if (!fb || !tb) continue;
      const { fromSide, toSide } = chooseConnectionSides(conn, fb, tb);
      const fp = portStateByRound.get(conn.fromRoundId);
      const tp = portStateByRound.get(conn.toRoundId);
      if (fp) {
        if (fromSide === "bottom") fp.outBottom = true;
        else fp.outRight = true;
      }
      if (tp) {
        if (toSide === "top") tp.inTop = true;
        else if (toSide === "bottom") tp.inBottom = true;
        else tp.inLeft = true;
      }
    }

    const nodesMarkup = stageRounds
      .map((r) => {
        const basePos = positions.get(r.id) ?? { x: RC_ORIGIN_X, y: RC_ORIGIN_Y };
        const renderedPos: RenderedNodePos =
          controlBoundaryY > 0
            ? {
                x: basePos.x,
                y: Math.round((basePos.y + initialStageOffsetY) * 10) / 10,
                baseX: basePos.x,
                baseY: basePos.y,
              }
            : {
                x: basePos.x,
                y: basePos.y,
                baseX: basePos.x,
                baseY: basePos.y,
              };
        return renderRoundNode(
          race,
          r,
          heatsByRound.get(r.id) ?? [],
          inCounts.get(r.id) ?? 0,
          outCounts.get(r.id) ?? 0,
          editableActive,
          true,
          opts.interactive !== false,
          opts.activeHeatId,
          stageHeats,
          activePilots,
          validClickTargets,
          renderedPos,
          ui,
          portStateByRound.get(r.id),
          roster
        );
      })
      .join("");

    const wirePillsHtml = renderWirePillsOverlay(
      race,
      stageConnections,
      heatsByRound,
      editableActive,
      ui
    );

    const panX = ui?.panX ?? 72;
    const panY = ui?.panY ?? 88;
    const zoom = ui?.zoom ?? 1;
    const hideGraph = !!opts.hideGraphNodes;

    const boundaryAttrs =
      controlBoundaryY > 0
        ? ` data-control-boundary-y="${controlBoundaryY}" data-stage-offset-y="${initialStageOffsetY}"`
        : "";

    return `
      <div
        class="rc-world"
        data-rc-world
        data-bkt-graph
        data-bkt-editable="${editableActive ? "1" : "0"}"
        data-bkt-view-stage="${viewStage}"${boundaryAttrs}
        style="transform:translate3d(${panX}px, ${panY}px, 0) scale(${zoom});transform-origin:0 0"
      >
        <svg class="bkt-wires is-rc-wires" aria-hidden="true"${hideGraph ? " hidden" : ""}></svg>
        <div class="rc-nodes"${hideGraph ? " hidden" : ""}>${nodesMarkup}</div>
        <div class="bkt-wire-handles" data-bkt-wire-handles${hideGraph ? " hidden" : ""}></div>
        <div class="bkt-wire-pills" data-bkt-wire-pills${hideGraph ? " hidden" : ""}>${wirePillsHtml}</div>
        ${opts.extraWorldHtml ?? ""}
      </div>
      <div class="rc-marquee" data-rc-marquee hidden></div>`;
  }

  const stageHeats = race.heats.filter((h) => h.stageIndex === viewStage);
  const { rounds: stageRounds, heatsByRound } = resolveStageRounds(race, viewStage, stageHeats);
  if (stageRounds.length === 0) {
    return `<div class="race-empty-state"><p>No rounds configured in Stage ${viewStage} yet. Open <strong>Format</strong> to configure stages and rounds.</p></div>`;
  }

  const interactive = opts.interactive !== false;
  const stageConnections = resolveStageConnections(race, viewStage, stageRounds, heatsByRound);

  const inCounts = new Map<string, number>();
  const outCounts = new Map<string, number>();
  for (const c of stageConnections) {
    outCounts.set(c.fromRoundId, (outCounts.get(c.fromRoundId) ?? 0) + 1);
    inCounts.set(c.toRoundId, (inCounts.get(c.toRoundId) ?? 0) + 1);
  }

  const colsMap = new Map<number, RaceRound[]>();
  for (const r of stageRounds) {
    const col =
      isHandoffInRoundId(r.id) || r.bracketLane === "handoff_in" ? 0 : r.column || 1;
    const list = colsMap.get(col) ?? [];
    list.push(r);
    colsMap.set(col, list);
  }
  const sortedCols = Array.from(colsMap.entries()).sort((a, b) => a[0] - b[0]);

  const colsMarkup = sortedCols
    .map(
      ([colIdx, colRounds]) => `
      <div class="bkt-graph-col" data-graph-col="${colIdx}">
        ${colRounds
          .map((r) =>
            renderRoundNode(
              race,
              r,
              heatsByRound.get(r.id) ?? [],
              inCounts.get(r.id) ?? 0,
              outCounts.get(r.id) ?? 0,
              false,
              false,
              interactive,
              opts.activeHeatId,
              stageHeats,
              activePilots,
              new Set<string>(),
              undefined,
              ui
            )
          )
          .join("")}
      </div>`
    )
    .join("");

  const wirePillsHtml = renderWirePillsOverlay(race, stageConnections, heatsByRound, false, ui);

  return `
    <div class="bkt-graph-canvas" data-bkt-graph data-bkt-view-stage="${viewStage}">
      <svg class="bkt-wires" aria-hidden="true"></svg>
      <div class="bkt-wire-pills" data-bkt-wire-pills>${wirePillsHtml}</div>
      <div class="bkt-graph-cols">
        ${colsMarkup}
      </div>
    </div>`;
}

/**
 * Handles change, dblclick, keydown, and click events emitted by round-graph controls & menus.
 * Returns `true` if handled.
 */
export function handleBracketEditEvent(
  e: Event,
  api: ApiClient,
  getRace: () => RaceTournamentState,
  ui?: BracketEditorUiState,
  onError?: (msg: string) => void
): boolean {
  const target = e.target as Element | null;
  if (!target) return false;

  const reportErr = (err: unknown): void => {
    const msg = err instanceof Error ? err.message : String(err);
    if (onError) onError(msg);
  };

  const resolveEventStage = (): number => {
    const fromDom = Number(
      target.closest<HTMLElement>("[data-bkt-view-stage]")?.dataset.bktViewStage
    );
    return fromDom > 0 ? fromDom : getRace().activeStageIndex || 1;
  };

  const openHandoffDialog = (): void => {
    if (ui) {
      ui.openNodeMenuId = "";
      ui.openWireMenuId = "";
      ui.rerender();
    }
    const curRace = getRace();
    if ((curRace.stages?.length ?? 0) > 2 && ui?.onOpenFormat) {
      ui.onOpenFormat();
      return;
    }
    openStageHandoffModal({
      getRace,
      api,
      onSwitchStage: ui?.onSwitchStage,
      onRemovedStage2: () => {
        if (ui?.onSwitchStage) ui.onSwitchStage(1);
      },
      onError,
    });
  };

  const syncPilotsNodeFilterDom = (bodyEl: Element | null): void => {
    if (!bodyEl) return;
    const searchInput = bodyEl.querySelector<HTMLInputElement>("[data-pilots-node-search]");
    const addBtn = bodyEl.querySelector<HTMLButtonElement>("[data-bkt-action='pilots_add_walkup']");
    const emptyEl = bodyEl.querySelector<HTMLElement>("[data-pilots-node-empty]");
    const listEl = bodyEl.querySelector<HTMLElement>("[data-pilots-node-list]");

    const searchTrimmed = (searchInput?.value ?? ui?.pilotsNodeSearch ?? "").trim();
    const searchNeedle = searchTrimmed.toLowerCase();

    let exactMatchedCallsign = "";
    const curRoster = getRace().roster ?? [];
    if (searchNeedle) {
      const found = curRoster.find((p) => p.callsign.trim().toLowerCase() === searchNeedle);
      if (found) exactMatchedCallsign = found.callsign;
    }

    let visibleCount = 0;
    if (listEl) {
      listEl.querySelectorAll<HTMLElement>("[data-pilot-search-hay]").forEach((row) => {
        const hay = row.dataset.pilotSearchHay ?? "";
        const rowCallsign = row.dataset.pilotCallsign ?? "";
        const tabMatch = row.dataset.pilotTabMatch !== "0";
        if (searchNeedle && rowCallsign === searchNeedle && !exactMatchedCallsign) {
          exactMatchedCallsign = row.querySelector(".bkt-pilot-callsign")?.textContent?.trim() || searchTrimmed;
        }
        const show = searchNeedle ? hay.includes(searchNeedle) : tabMatch;
        row.hidden = !show;
        row.classList.toggle("is-exact-match", !!searchNeedle && rowCallsign === searchNeedle);
        if (show) visibleCount++;
      });
    }

    if (emptyEl) {
      emptyEl.hidden = visibleCount > 0;
      emptyEl.textContent =
        curRoster.length === 0
          ? "No pilots in roster yet — type a callsign above to add."
          : searchTrimmed
            ? `No existing pilots match “${searchTrimmed}” — click Add to register.`
            : "No pilots match this filter.";
    }

    if (addBtn) {
      addBtn.disabled = !searchTrimmed || !!exactMatchedCallsign;
      addBtn.title = exactMatchedCallsign
        ? `Pilot “${exactMatchedCallsign}” is already in roster`
        : searchTrimmed
          ? `Add pilot “${searchTrimmed}”`
          : "Search or type a unique callsign to add";
    }
  };

  const submitNodeWalkup = (sourceEl?: Element | null): boolean => {
    const bodyEl = sourceEl?.closest(".bkt-pilots-body") ?? document.querySelector(".bkt-pilots-body");
    const searchInput = bodyEl?.querySelector<HTMLInputElement>("[data-pilots-node-search]") ?? null;
    const raw = (searchInput?.value ?? ui?.pilotsNodeSearch ?? "").trim();
    if (!raw) return true;
    const dup = (getRace().roster ?? []).some(
      (p) => p.callsign.trim().toLowerCase() === raw.toLowerCase()
    );
    if (dup) {
      syncPilotsNodeFilterDom(bodyEl);
      return true;
    }
    if (ui) {
      ui.pilotsNodeSearch = "";
      ui.pilotsNodeWalkupCallsign = "";
    }
    if (searchInput) searchInput.value = "";
    syncPilotsNodeFilterDom(bodyEl);
    void api
      .eventAction({
        action: "add_race_pilot",
        callsign: raw,
      })
      .catch(reportErr);
    return true;
  };

  if (e.type === "input") {
    if (target instanceof HTMLInputElement && target.hasAttribute("data-pilots-node-search")) {
      if (ui) ui.pilotsNodeSearch = target.value;
      syncPilotsNodeFilterDom(target.closest(".bkt-pilots-body"));
      return true;
    }
    return false;
  }

  if (e.type === "keydown") {
    const ke = e as KeyboardEvent;
    if (target instanceof HTMLInputElement && target.hasAttribute("data-pilots-node-search")) {
      if (ke.key === "Enter") {
        ke.preventDefault();
        return submitNodeWalkup(target);
      }
      if (ke.key === "Escape" && target.value) {
        ke.preventDefault();
        target.value = "";
        if (ui) ui.pilotsNodeSearch = "";
        syncPilotsNodeFilterDom(target.closest(".bkt-pilots-body"));
        return true;
      }
    }
    return false;
  }

  if (e.type === "dblclick") {
    if (target.closest("[data-wire-hit], [data-wire-pill], [data-wire-endpoint]")) {
      e.preventDefault();
      e.stopPropagation();
      return true;
    }
    const dragHead = target.closest<HTMLElement>("[data-round-drag-handle]");
    if (dragHead && !target.closest("button, select, input")) {
      const graphEl = dragHead.closest<HTMLElement>("[data-bkt-graph]");
      if (graphEl && graphEl.dataset.bktEditable !== "1") {
        return false;
      }
      const roundId = dragHead.dataset.roundDragHandle ?? "";
      if (isPilotsInRoundId(roundId)) {
        return true;
      }
      if (isHandoffPortalRound(roundId)) {
        openHandoffDialog();
        return true;
      }
      const race = getRace();
      const viewStage = resolveEventStage();
      const stageHeats = race.heats.filter((h) => h.stageIndex === viewStage);
      const { rounds, heatsByRound } = resolveStageRounds(race, viewStage, stageHeats);
      const round = rounds.find((r) => r.id === roundId);
      if (round) {
        if (round.stageFormat === "open_qualifier" || round.id.endsWith("-open-qual")) {
          openOpenQualifierSettingsModal({
            stageIndex: round.stageIndex || viewStage,
            getRace,
            api,
            onError: reportErr,
          });
          return true;
        }
        const conns = resolveStageConnections(race, viewStage, rounds, heatsByRound);
        const incomingCount = conns.filter((c) => c.toRoundId === round.id).length;
        openRoundCustomizeModal({
          round,
          heats: heatsByRound.get(round.id) ?? [],
          incomingCount,
          race,
          raceConfig: race.config,
          api,
          onError,
        });
        return true;
      }
    }
    return false;
  }

  if (e.type === "change" || e.type === "canvas-select-change") {
    const cselectEl =
      e.type === "canvas-select-change"
        ? target.closest<HTMLElement>("[data-cselect-trigger]")
        : target instanceof HTMLSelectElement
          ? target
          : null;
    if (!cselectEl) return false;
    const val =
      e.type === "canvas-select-change"
        ? (e as CustomEvent<CanvasSelectChangeDetail>).detail?.value ?? ""
        : (cselectEl as HTMLSelectElement).value;

    if (cselectEl.hasAttribute("data-bkt-handoff-metric")) {
      const qualifyingMetric = val as QualifyingMetric;
      void api
        .bracketEdit({
          action: "update_stage_handoff",
          qualifyingMetric,
          stage2MaxSeeds: getRace().config.stage2MaxSeeds ?? 0,
        })
        .catch(reportErr);
      return true;
    }

    if (cselectEl.hasAttribute("data-bkt-handoff-max-seeds")) {
      if (val === "custom") {
        if (cselectEl instanceof HTMLSelectElement) {
          cselectEl.value = String(getRace().config.stage2MaxSeeds ?? 0);
        }
        openHandoffDialog();
        return true;
      }
      const stage2MaxSeeds = Math.max(0, Number(val) || 0);
      void api
        .bracketEdit({
          action: "update_stage_handoff",
          qualifyingMetric: getRace().config.qualifyingMetric || "consecutive_3",
          stage2MaxSeeds,
        })
        .catch(reportErr);
      return true;
    }

    if (cselectEl.dataset.bktChHeat) {
      const heatId = cselectEl.dataset.bktChHeat;
      const seatIndex = Number(cselectEl.dataset.bktChSeat);
      const dec = decodeBandChannel(val);
      if (heatId && seatIndex > 0 && dec) {
        void api
          .bracketEdit({
            action: "set_seat_channel",
            heatId,
            seatIndex,
            band: dec.band,
            channel: dec.channel,
          })
          .catch(reportErr);
      }
      return true;
    }

    if (cselectEl.dataset.bktSeatHeat) {
      const heatId = cselectEl.dataset.bktSeatHeat;
      const seatIndex = Number(cselectEl.dataset.bktSeatIdx);
      const raw = val;
      if (cselectEl instanceof HTMLSelectElement) {
        cselectEl.value = "";
      }
      if (!heatId || seatIndex <= 0 || !raw) return true;

      if (raw.startsWith("seed:")) {
        const fromStageSeed = Number(raw.slice("seed:".length));
        if (fromStageSeed > 0) {
          void api
            .bracketEdit({ action: "assign_seat_stage_seed", heatId, seatIndex, fromStageSeed })
            .catch(reportErr);
        }
      } else if (raw.startsWith("pilot:")) {
        const pilotSlotIndex = Number(raw.slice("pilot:".length));
        if (pilotSlotIndex > 0) {
          void api
            .bracketEdit({ action: "assign_pilot_seat", heatId, seatIndex, pilotSlotIndex })
            .catch(reportErr);
        }
      } else if (raw.startsWith("heat:")) {
        const parts = raw.split(":");
        const fromHeatId = parts[1] ?? "";
        const fromRank = Number(parts[2]);
        if (fromHeatId && fromRank > 0) {
          void api
            .bracketEdit({ action: "set_seat_feeder", heatId, seatIndex, fromHeatId, fromRank })
            .catch(reportErr);
        }
      } else if (raw === "unlink") {
        void api.bracketEdit({ action: "set_seat_feeder", heatId, seatIndex }).catch(reportErr);
      }
      return true;
    }
    return false;
  }

  if (e.type !== "click") return false;

  // Connector settings open strictly via the explicit gear/siren icon on `.bkt-wire-pill-wrap` —
  // never when clicking or double-clicking the wire path itself.
  const wireHitEl = target.closest("[data-wire-hit]");
  if (wireHitEl && ui) {
    if (ui.openWireMenuId || ui.openNodeMenuId || ui.connectingFromRoundId) {
      ui.openWireMenuId = "";
      ui.openNodeMenuId = "";
      ui.connectingFromRoundId = "";
      ui.rerender();
    }
    return true;
  }

  // Checked-In Pilots distribution preset selection
  const pilotsDistBtn = target.closest<HTMLElement>("[data-bkt-pilots-dist]");
  if (pilotsDistBtn) {
    const connectionId = pilotsDistBtn.dataset.connId ?? "";
    const rawDist = pilotsDistBtn.dataset.bktPilotsDist ?? "roster";
    const distribution: "roster" | "snake" | "random" =
      rawDist === "snake" || rawDist === "random" ? rawDist : "roster";
    if (ui) {
      ui.openWireMenuId = "";
    }
    if (connectionId) {
      void api
        .bracketEdit({
          action: "update_connection",
          connectionId,
          linkMode: "pilots_in",
          distribution,
        })
        .catch(reportErr);
    }
    return true;
  }

  // Stage 2 seed slice preset selection
  const seedPresetBtn = target.closest<HTMLElement>("[data-bkt-seed-preset]");
  if (seedPresetBtn) {
    const connectionId = seedPresetBtn.dataset.connId ?? "";
    const [rawStart, rawEnd, rawDist] = (seedPresetBtn.dataset.bktSeedPreset ?? "").split(":");
    const seedStart = Math.max(1, Number(rawStart) || 1);
    const seedEnd = Math.max(0, Number(rawEnd) || 0);
    const distribution: "snake" | "sequential" =
      rawDist === "sequential" ? "sequential" : "snake";
    if (ui) {
      ui.openWireMenuId = "";
    }
    if (connectionId) {
      const prevConns = [...(getRace().connections ?? [])];
      void api
        .bracketEdit({
          action: "update_connection",
          connectionId,
          linkMode: "stage_seeds",
          seedStart,
          seedEnd,
          distribution,
        })
        .then((next) => notifyNewlyInvalidConnections(prevConns, next ?? getRace(), connectionId))
        .catch(reportErr);
    }
    return true;
  }

  // Wire preset selection
  const presetBtn = target.closest<HTMLElement>("[data-bkt-wire-preset]");
  if (presetBtn) {
    const connectionId = presetBtn.dataset.connId ?? "";
    const [linkMode, rawCount] = (presetBtn.dataset.bktWirePreset ?? "").split(":");
    const advanceCount = Number(rawCount) || 0;
    if (ui) {
      ui.openWireMenuId = "";
    }
    if (connectionId && linkMode) {
      const prevConns = [...(getRace().connections ?? [])];
      void api
        .bracketEdit({
          action: "update_connection",
          connectionId,
          linkMode: linkMode as RoundConnectionMode,
          advanceCount,
        })
        .then((next) => notifyNewlyInvalidConnections(prevConns, next ?? getRace(), connectionId))
        .catch(reportErr);
    }
    return true;
  }

  const uiBtn = target.closest<HTMLElement>("[data-bkt-ui]");
  if (uiBtn && ui) {
    switch (uiBtn.dataset.bktUi) {
      case "toggle-wire-menu": {
        const connId = uiBtn.dataset.connId ?? "";
        ui.openWireMenuId = ui.openWireMenuId === connId ? "" : connId;
        ui.openNodeMenuId = "";
        ui.connectingFromRoundId = "";
        ui.rerender();
        return true;
      }
      case "toggle-node-menu": {
        const roundId = uiBtn.dataset.roundId ?? "";
        ui.openNodeMenuId = ui.openNodeMenuId === roundId ? "" : roundId;
        ui.openWireMenuId = "";
        ui.connectingFromRoundId = "";
        ui.rerender();
        return true;
      }
      case "cancel-connect":
        ui.connectingFromRoundId = "";
        ui.rerender();
        return true;
      case "pilots-node-filter": {
        const nextF = uiBtn.dataset.filter;
        if (nextF === "all" || nextF === "in" || nextF === "unseated" || nextF === "out") {
          ui.pilotsNodeFilter = nextF;
          ui.rerender();
        }
        return true;
      }
    }
  }

  // Close open menus if user clicks outside them
  if (ui) {
    let closedMenu = false;
    if (
      ui.openWireMenuId &&
      performance.now() >= suppressOutsideWireCloseUntil &&
      !target.closest("[data-wire-pill]")
    ) {
      ui.openWireMenuId = "";
      closedMenu = true;
    }
    if (ui.openNodeMenuId && !target.closest(".bkt-node-menu, [data-bkt-ui='toggle-node-menu']")) {
      ui.openNodeMenuId = "";
      closedMenu = true;
    }
    if (closedMenu && !target.closest("[data-bkt-action]")) {
      ui.rerender();
    }
  }

  // Click-to-connect onto a valid input port socket (drops/cancels on invalid sockets or empty clicks)
  if (ui && ui.connectingFromRoundId && !target.closest("[data-round-out]")) {
    const clickedInPort = target.closest<HTMLElement>(".bkt-port.is-in:not(.is-hidden-port)");
    const candidateNode = clickedInPort?.closest<HTMLElement>(".bkt-round-node[data-round-node]");
    const fromRoundId = ui.connectingFromRoundId;
    const portDir = ui.connectingFromPortDir;
    ui.connectingFromRoundId = "";
    ui.connectingFromPortDir = "right";

    if (clickedInPort && candidateNode) {
      const toRoundId = candidateNode.dataset.roundNode ?? "";
      const rawSide = clickedInPort.dataset.portSide;
      const toPort: "left" | "top" | "bottom" =
        rawSide === "top" || rawSide === "bottom" ? rawSide : "left";
      const curRace = getRace();
      const viewStage = resolveEventStage();
      const stageHeats = curRace.heats.filter((h) => h.stageIndex === viewStage);
      const { rounds, heatsByRound } = resolveStageRounds(curRace, viewStage, stageHeats, true);
      const stageConns = resolveStageConnections(curRace, viewStage, rounds, heatsByRound);
      const graph = buildRoundNetworkGraph(curRace, viewStage, rounds, heatsByRound, stageConns);
      const check = graph.validateConnection(fromRoundId, toRoundId, { fromPort: portDir });
      if (fromRoundId && toRoundId && check.valid) {
        const prevConns = [...(curRace.connections ?? [])];
        const linkMode = defaultLinkModeForOutputPort(curRace, fromRoundId, portDir, toRoundId);
        const advanceCount = graph.recommendedAdvanceCount(fromRoundId, linkMode);
        const positions = collectStageRoundPositions(target, curRace, viewStage, ui);
        void api
          .bracketEdit({
            action: "connect_rounds",
            fromRoundId,
            toRoundId,
            fromPort: portDir,
            toPort,
            linkMode,
            ...(advanceCount !== undefined ? { advanceCount } : {}),
            positions,
          })
          .then((next) => notifyNewlyInvalidConnections(prevConns, next ?? getRace()))
          .catch(reportErr);
        return true;
      }
      if (fromRoundId && toRoundId && check.reason) {
        showToast(check.reason, "warn");
      }
    }
    ui.rerender();
    return true;
  }

  const actionBtn = target.closest<HTMLElement>("[data-bkt-action]");
  if (!actionBtn || (actionBtn instanceof HTMLButtonElement && actionBtn.disabled)) return false;

  const act = actionBtn.dataset.bktAction;
  switch (act) {
    case "open_stage_handoff":
      openHandoffDialog();
      return true;
    case "seed_stage2_early": {
      const stageIdx = Number(actionBtn.dataset.stageIdx) || resolveEventStage();
      if ((getRace().stages?.length ?? 0) > 2 || stageIdx > 1) {
        void api.stageControl("complete_stage_early", stageIdx).catch(reportErr);
      } else {
        void api.bracketEdit({ action: "seed_stage2_early" }).catch(reportErr);
      }
      return true;
    }
    case "unlock_stage2_seeding": {
      const stageIdx = Number(actionBtn.dataset.stageIdx) || resolveEventStage();
      if ((getRace().stages?.length ?? 0) > 2 || stageIdx > 1) {
        void api.stageControl("reopen_stage_early", stageIdx).catch(reportErr);
      } else {
        void api.bracketEdit({ action: "unlock_stage2_seeding" }).catch(reportErr);
      }
      return true;
    }
    case "set_open_qual_max_packs": {
      const stageIdx = Number(actionBtn.dataset.stageIdx) || resolveEventStage();
      const maxPacks = Math.max(0, Math.min(50, Number(actionBtn.dataset.maxPacks ?? 0)));
      const curRace = getRace();
      const stgObj = curRace.stages?.find((s) => s.index === stageIdx);
      const positions = collectStageRoundPositions(target, curRace, stageIdx, ui);
      void api
        .bracketEdit({
          action: "update_stage_settings",
          stageId: stgObj?.id || `stage-${stageIdx}`,
          stageIndex: stageIdx,
          maxPacksPerPilot: maxPacks,
          applyToExisting: true,
          positions,
        })
        .catch(reportErr);
      return true;
    }
    case "open_qual_stage_settings": {
      const stageIdx = Number(actionBtn.dataset.stageIdx) || resolveEventStage();
      if (ui) {
        ui.openNodeMenuId = "";
        ui.rerender();
      }
      openStageSettingsModal({
        stageIndex: stageIdx,
        getRace,
        api,
        onError: reportErr,
      });
      return true;
    }
    case "open_open_qual_settings": {
      const stageIdx = Number(actionBtn.dataset.stageIdx) || resolveEventStage();
      if (ui) {
        ui.openNodeMenuId = "";
        ui.rerender();
      }
      openOpenQualifierSettingsModal({
        stageIndex: stageIdx,
        getRace,
        api,
        onError: reportErr,
      });
      return true;
    }
    case "open_round_customize": {
      const roundId = actionBtn.dataset.roundId ?? "";
      if (ui) ui.openNodeMenuId = "";
      if (isPilotsInRoundId(roundId)) {
        return true;
      }
      if (isHandoffPortalRound(roundId)) {
        openHandoffDialog();
        return true;
      }
      const race = getRace();
      const viewStage = resolveEventStage();
      const stageHeats = race.heats.filter((h) => h.stageIndex === viewStage);
      const { rounds, heatsByRound } = resolveStageRounds(race, viewStage, stageHeats);
      const round = rounds.find((r) => r.id === roundId);
      if (round) {
        const conns = resolveStageConnections(race, viewStage, rounds, heatsByRound);
        const incomingCount = conns.filter((c) => c.toRoundId === round.id).length;
        if (ui) ui.rerender();
        openRoundCustomizeModal({
          round,
          heats: heatsByRound.get(round.id) ?? [],
          incomingCount,
          race,
          raceConfig: race.config,
          api,
          onError,
        });
      }
      return true;
    }
    case "open_wire_connection": {
      const connectionId = actionBtn.dataset.connId ?? "";
      if (ui) {
        ui.openNodeMenuId = "";
        ui.openWireMenuId = "";
        ui.rerender();
      }
      if (connectionId) {
        openWireConnectionModal({
          connectionId,
          getRace,
          api,
          onError,
        });
      }
      return true;
    }
    case "duplicate_round": {
      const roundId = actionBtn.dataset.roundId ?? "";
      if (ui) ui.openNodeMenuId = "";
      if (roundId && !isHandoffPortalRound(roundId)) {
        const race = getRace();
        const viewStage = resolveEventStage();
        const stageHeats = race.heats.filter((h) => h.stageIndex === viewStage);
        const { rounds, heatsByRound } = resolveStageRounds(race, viewStage, stageHeats);
        const stageConns = resolveStageConnections(race, viewStage, rounds, heatsByRound);
        const posMap = computeRoundPositions(
          rounds,
          heatsByRound,
          race.config.pilotsPerHeat || 4,
          ui,
          stageConns
        );
        const curPos = posMap.get(roundId);
        void api
          .bracketEdit({
            action: "duplicate_round",
            roundId,
            hasPos: true,
            posX: (curPos?.x ?? RC_ORIGIN_X) + 60,
            posY: (curPos?.y ?? RC_ORIGIN_Y) + 60,
          })
          .catch(reportErr);
      }
      return true;
    }
    case "set_round_seed": {
      const roundId = actionBtn.dataset.roundId ?? "";
      const linkMode = (actionBtn.dataset.seedMode || "all_active_pilots") as
        | "all_active_pilots"
        | "empty";
      if (ui) ui.openNodeMenuId = "";
      if (roundId) {
        void api.bracketEdit({ action: "set_round_seed", roundId, linkMode }).catch(reportErr);
      }
      return true;
    }
    case "complete_connect": {
      const fromRoundId = ui?.connectingFromRoundId ?? "";
      const portDir = ui?.connectingFromPortDir ?? "right";
      const toRoundId = actionBtn.dataset.toRoundId ?? "";
      if (ui) {
        ui.connectingFromRoundId = "";
        ui.connectingFromPortDir = "right";
      }
      if (fromRoundId && toRoundId) {
        const curRace = getRace();
        const viewStage = resolveEventStage();
        const stageHeats = curRace.heats.filter((h) => h.stageIndex === viewStage);
        const { rounds, heatsByRound } = resolveStageRounds(curRace, viewStage, stageHeats, true);
        const stageConns = resolveStageConnections(curRace, viewStage, rounds, heatsByRound);
        const graph = buildRoundNetworkGraph(curRace, viewStage, rounds, heatsByRound, stageConns);
        const check = graph.validateConnection(fromRoundId, toRoundId, { fromPort: portDir });
        if (!check.valid) {
          ui?.rerender();
          if (check.reason) showToast(check.reason, "warn");
          return true;
        }
        const prevConns = [...(curRace.connections ?? [])];
        const linkMode = defaultLinkModeForOutputPort(curRace, fromRoundId, portDir, toRoundId);
        const advanceCount = graph.recommendedAdvanceCount(fromRoundId, linkMode);
        const positions = collectStageRoundPositions(target, curRace, viewStage, ui);
        void api
          .bracketEdit({
            action: "connect_rounds",
            fromRoundId,
            toRoundId,
            fromPort: portDir,
            toPort: "left",
            linkMode,
            ...(advanceCount !== undefined ? { advanceCount } : {}),
            positions,
          })
          .then((next) => notifyNewlyInvalidConnections(prevConns, next ?? getRace()))
          .catch(reportErr);
      }
      return true;
    }
    case "disconnect_rounds": {
      const connectionId = actionBtn.dataset.connId ?? "";
      if (ui) ui.openWireMenuId = "";
      if (connectionId) {
        const curRace = getRace();
        const viewStage = resolveEventStage();
        const positions = collectStageRoundPositions(target, curRace, viewStage, ui);
        void api
          .bracketEdit({ action: "disconnect_rounds", connectionId, positions })
          .catch(reportErr);
      }
      return true;
    }
    case "clear_seat": {
      const heatId = actionBtn.dataset.heatId ?? "";
      const seatIndex = Number(actionBtn.dataset.seatIndex);
      if (heatId && seatIndex > 0) {
        void api.bracketEdit({ action: "clear_seat", heatId, seatIndex }).catch(reportErr);
      }
      return true;
    }
    case "unlock_seat": {
      const heatId = actionBtn.dataset.heatId ?? "";
      const seatIndex = Number(actionBtn.dataset.seatIndex);
      if (heatId && seatIndex > 0) {
        void api.bracketEdit({ action: "unlock_seat", heatId, seatIndex }).catch(reportErr);
      }
      return true;
    }
    case "auto_seat_pilot": {
      const pilotSlotIndex = Number(actionBtn.dataset.pilotSlot);
      if (pilotSlotIndex > 0) {
        void api.bracketEdit({ action: "auto_seat_pilot", pilotSlotIndex }).catch(reportErr);
      }
      return true;
    }
    case "pilots_check_in_all": {
      void api.eventAction({ action: "check_in_all" }).catch(reportErr);
      return true;
    }
    case "pilot_checkin_toggle": {
      const slotIndex = Number(actionBtn.dataset.slotIndex);
      if (slotIndex > 0) {
        const curPilot = (getRace().roster ?? []).find((rp) => rp.slotIndex === slotIndex);
        const nextCheckedIn = curPilot ? !curPilot.checkedIn : true;
        void api
          .eventAction({
            action: "update_attendance",
            slotIndex,
            checkedIn: nextCheckedIn,
            attendance: "active",
          })
          .catch(reportErr);
      }
      return true;
    }
    case "pilot_attendance": {
      const slotIndex = Number(actionBtn.dataset.slotIndex);
      const rawAtt = actionBtn.dataset.attStatus || "active";
      const clickedAtt: PilotAttendance =
        rawAtt === "away" || rawAtt === "dq" || rawAtt === "dnc" || rawAtt === "forfeit"
          ? rawAtt
          : "active";
      if (slotIndex > 0) {
        const curPilot = (getRace().roster ?? []).find((rp) => rp.slotIndex === slotIndex);
        const curAtt: PilotAttendance =
          curPilot?.attendance === "forfeit" ? "dnc" : curPilot?.attendance || "active";
        const isToggleOff = Boolean(curPilot?.checkedIn && curAtt === clickedAtt);
        const nextAtt: PilotAttendance = isToggleOff ? "active" : clickedAtt;
        void api
          .eventAction({
            action: "update_attendance",
            slotIndex,
            checkedIn: true,
            attendance: nextAtt,
          })
          .catch(reportErr);
      }
      return true;
    }
    case "pilots_add_walkup": {
      return submitNodeWalkup(actionBtn);
    }
    case "open_qual_enqueue_all": {
      const stageIndex = Number(actionBtn.dataset.stageIdx) || resolveEventStage();
      void api
        .bracketEdit({ action: "open_qual_enqueue_all", stageIndex })
        .catch(reportErr);
      return true;
    }
    case "add_heat": {
      const roundId = actionBtn.dataset.roundId ?? "";
      const bracketLane = actionBtn.dataset.bktLane || "winners";
      const column = Number(actionBtn.dataset.bktCol) || 0;
      const round = Number(actionBtn.dataset.bktRound) || 0;
      if (ui) ui.openNodeMenuId = "";
      void api.bracketEdit({ action: "add_heat", roundId, bracketLane, column, round }).catch(reportErr);
      return true;
    }
    case "delete_heat": {
      const heatId = actionBtn.dataset.heatId ?? "";
      if (heatId) {
        void api.bracketEdit({ action: "delete_heat", heatId }).catch(reportErr);
      }
      return true;
    }
    case "delete_round": {
      const roundId = actionBtn.dataset.roundId ?? "";
      const column = Number(actionBtn.dataset.col) || 0;
      const bracketLane = actionBtn.dataset.bktLane ?? "";
      const roundTitle = actionBtn.dataset.roundTitle || `Round ${column}`;
      const rawHeatCount = actionBtn.dataset.heatCount;
      const heatCount =
        rawHeatCount !== undefined && rawHeatCount !== "" ? Number(rawHeatCount) : 1;
      const curRace = getRace();
      const viewStage = resolveEventStage();
      const positions = collectStageRoundPositions(target, curRace, viewStage, ui);
      if (ui) {
        ui.openNodeMenuId = "";
        ui.rerender();
      }
      if (!roundNeedsDeleteConfirmation(curRace, roundId)) {
        ui?.selectedRoundIds.delete(roundId);
        void api
          .bracketEdit({
            action: "delete_round",
            roundId,
            column,
            bracketLane,
            positions,
          })
          .catch(reportErr);
        return true;
      }
      const heatNote =
        heatCount > 0
          ? ` (${heatCount} unstarted heat${heatCount === 1 ? "" : "s"})`
          : "";
      openConfirmModal({
        title: `Delete “${roundTitle}”?`,
        messageHtml: `<p>Remove <strong>${esc(roundTitle)}</strong>${heatNote} from this race? Any lines connected to this round will be disconnected automatically.</p>`,
        confirmLabel: "Delete Round",
        danger: true,
        onConfirm: () => {
          ui?.selectedRoundIds.delete(roundId);
          return api
            .bracketEdit({
              action: "delete_round",
              roundId,
              column,
              bracketLane,
              positions,
            })
            .catch(reportErr);
        },
      });
      return true;
    }
  }
  return false;
}

interface NodeWorldBox {
  id: string;
  lane: string;
  x: number;
  y: number;
  w: number;
  h: number;
  el: HTMLElement;
}

function sideOutwardNormal(side: PortSide): { nx: number; ny: number } {
  switch (side) {
    case "right":
      return { nx: 1, ny: 0 };
    case "left":
      return { nx: -1, ny: 0 };
    case "bottom":
      return { nx: 0, ny: 1 };
    case "top":
      return { nx: 0, ny: -1 };
  }
}

/**
 * Resolves the fixed exit side (`"right"` Advance vs `"bottom"` Drop) and entry side
 * (`"left"`, `"top"`, or `"bottom"`) from persisted port metadata / connection semantics.
 * Never re-snaps ports dynamically based on node `(x, y)` coordinates when nodes move.
 */
function chooseConnectionSides(
  conn: RoundConnection,
  fromBox: NodeWorldBox,
  toBox: NodeWorldBox
): { fromSide: OutputPortDir; toSide: "left" | "top" | "bottom" } {
  if (fromBox.id === toBox.id) {
    return { fromSide: "right", toSide: "left" };
  }

  const canFromBottom =
    fromBox.lane !== "finals" &&
    fromBox.lane !== "handoff_in" &&
    fromBox.lane !== "pilots_in" &&
    !isHandoffInRoundId(fromBox.id) &&
    !isPilotsInRoundId(fromBox.id);

  let fromSide: OutputPortDir = "right";
  if (conn.fromPort === "right") {
    fromSide = "right";
  } else if (conn.fromPort === "bottom" && canFromBottom) {
    fromSide = "bottom";
  } else if (!conn.fromPort && canFromBottom && conn.mode === "bottom_per_heat") {
    fromSide = "bottom";
  }

  if (toBox.lane === "handoff_out" || isHandoffOutRoundId(toBox.id)) {
    return { fromSide, toSide: "left" };
  }

  if (conn.toPort === "left" || conn.toPort === "top" || conn.toPort === "bottom") {
    return { fromSide, toSide: conn.toPort };
  }

  let toSide: "left" | "top" | "bottom" = "left";
  if (fromSide === "bottom") {
    toSide = "top";
  } else if (toBox.lane === "finals" && fromBox.lane === "losers") {
    toSide = "bottom";
  }

  return { fromSide, toSide };
}

function computeBoxSideAnchor(
  box: NodeWorldBox,
  side: PortSide,
  isInput: boolean
): { x: number; y: number } {
  switch (side) {
    case "left":
      return {
        x: box.x,
        y: box.y + box.h / 2,
      };
    case "right":
      return {
        x: box.x + box.w,
        y: box.y + box.h / 2,
      };
    case "top":
      return {
        x: box.x + box.w / 2,
        y: box.y,
      };
    case "bottom": {
      const baseX = isInput
        ? box.lane === "finals"
          ? box.w * 0.5
          : box.w * 0.36
        : box.w * 0.64;
      return {
        x: box.x + baseX,
        y: box.y + box.h,
      };
    }
  }
}

function buildDirectionalBezier(
  x1: number,
  y1: number,
  fromSide: PortSide,
  x2: number,
  y2: number,
  toSide: PortSide
): {
  d: string;
  c1x: number;
  c1y: number;
  c2x: number;
  c2y: number;
} {
  const n1 = sideOutwardNormal(fromSide);
  const n2 = sideOutwardNormal(toSide);
  const adx = Math.abs(x2 - x1);
  const ady = Math.abs(y2 - y1);
  const dist = Math.hypot(adx, ady);

  let lead1 = 56;
  let lead2 = 56;

  if (n1.nx !== 0 && n2.nx !== 0) {
    // Horizontal -> Horizontal
    const forward = (x2 - x1) * n1.nx >= 0;
    const base = forward
      ? Math.max(48, adx * 0.46)
      : Math.max(84, Math.min(190, dist * 0.55));
    lead1 = base;
    lead2 = base;
  } else if (n1.ny !== 0 && n2.ny !== 0) {
    // Vertical -> Vertical (e.g. Upper Bottom Drop -> Lower Top Input)
    const downward = (y2 - y1) * n1.ny >= 0;
    const base = downward
      ? Math.max(46, Math.min(155, ady * 0.48 + adx * 0.08))
      : Math.max(80, Math.min(180, dist * 0.52));
    lead1 = base;
    lead2 = base;
  } else {
    // Orthogonal arch (e.g. Lower Right Out -> Finals Bottom In, or Bottom Out -> Left In)
    lead1 = n1.nx !== 0 ? Math.max(52, adx * 0.54) : Math.max(48, ady * 0.54);
    lead2 = n2.nx !== 0 ? Math.max(52, adx * 0.54) : Math.max(48, ady * 0.54);
  }

  const c1x = x1 + n1.nx * lead1;
  const c1y = y1 + n1.ny * lead1;
  const c2x = x2 + n2.nx * lead2;
  const c2y = y2 + n2.ny * lead2;

  return {
    d: `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`,
    c1x,
    c1y,
    c2x,
    c2y,
  };
}

function evalCubicBezierPoint(
  t: number,
  x1: number,
  y1: number,
  c1x: number,
  c1y: number,
  c2x: number,
  c2y: number,
  x2: number,
  y2: number
): { x: number; y: number } {
  const mt = 1 - t;
  const x =
    mt * mt * mt * x1 +
    3 * mt * mt * t * c1x +
    3 * mt * t * t * c2x +
    t * t * t * x2;
  const y =
    mt * mt * mt * y1 +
    3 * mt * mt * t * c1y +
    3 * mt * t * t * c2y +
    t * t * t * y2;
  return { x, y };
}

function computeBezierEndHandlePos(
  which: "source" | "target",
  x1: number,
  y1: number,
  c1x: number,
  c1y: number,
  c2x: number,
  c2y: number,
  x2: number,
  y2: number
): { x: number; y: number } {
  if (which === "source") {
    const targetDist = 28;
    let last = evalCubicBezierPoint(0.12, x1, y1, c1x, c1y, c2x, c2y, x2, y2);
    for (let t = 0.03; t <= 0.36; t += 0.015) {
      const pt = evalCubicBezierPoint(t, x1, y1, c1x, c1y, c2x, c2y, x2, y2);
      last = pt;
      if (Math.hypot(pt.x - x1, pt.y - y1) >= targetDist) {
        return pt;
      }
    }
    return last;
  }

  const targetDist = 28;
  let last = evalCubicBezierPoint(0.88, x1, y1, c1x, c1y, c2x, c2y, x2, y2);
  for (let t = 0.97; t >= 0.64; t -= 0.015) {
    const pt = evalCubicBezierPoint(t, x1, y1, c1x, c1y, c2x, c2y, x2, y2);
    last = pt;
    if (Math.hypot(pt.x - x2, pt.y - y2) >= targetDist) {
      return pt;
    }
  }
  return last;
}

function screenToCanvasCoords(
  canvas: HTMLElement,
  clientX: number,
  clientY: number,
  ui?: BracketEditorUiState
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  if (canvas.hasAttribute("data-rc-world")) {
    const z = ui?.zoom || 1;
    return {
      x: (clientX - rect.left) / z,
      y: (clientY - rect.top) / z,
    };
  }
  return {
    x: clientX - rect.left + canvas.scrollLeft,
    y: clientY - rect.top + canvas.scrollTop,
  };
}

interface CachedNodePorts {
  inLeft: HTMLElement | null;
  inTop: HTMLElement | null;
  inBottom: HTMLElement | null;
  outRight: HTMLElement | null;
  outBottom: HTMLElement | null;
}

/**
 * Pure-JS zero-reflow wire & pill layout pass given pre-measured `boxes` in canvas/world space.
 * Reuses existing `<path data-wire-conn>` elements in `svg` so dragging nodes runs at 120+ fps
 * with zero DOM allocations and zero `getBoundingClientRect()` layout reads.
 */
function updateCanvasWiresFromBoxes(
  svg: SVGSVGElement,
  handlesLayer: HTMLElement | null,
  boxes: Map<string, NodeWorldBox>,
  portsByRound: Map<string, CachedNodePorts>,
  pillsByConn: Map<string, HTMLElement>,
  stageConnections: RoundConnection[],
  heatsByRound: Map<string, RaceHeat[]>,
  editableActive: boolean,
  stage2Seeded = false,
  anyStage2Started = false
): void {
  if (svg.classList.contains("is-rc-wires")) {
    let maxW = 3200;
    let maxH = 2400;
    for (const b of boxes.values()) {
      if (b.x + b.w + 600 > maxW) maxW = Math.ceil(b.x + b.w + 600);
      if (b.y + b.h + 600 > maxH) maxH = Math.ceil(b.y + b.h + 600);
    }
    const wStr = String(maxW);
    const hStr = String(maxH);
    if (svg.getAttribute("width") !== wStr) svg.setAttribute("width", wStr);
    if (svg.getAttribute("height") !== hStr) svg.setAttribute("height", hStr);
  }

  interface RoutedConn {
    conn: RoundConnection;
    fromBox: NodeWorldBox;
    toBox: NodeWorldBox;
    fromSide: OutputPortDir;
    toSide: "left" | "top" | "bottom";
  }

  const routed: RoutedConn[] = [];

  const activeInLeft = new Set<string>();
  const activeInTop = new Set<string>();
  const activeInBottom = new Set<string>();
  const activeOutRight = new Set<string>();
  const activeOutBottom = new Set<string>();

  for (const conn of stageConnections) {
    const fromBox = boxes.get(conn.fromRoundId);
    const toBox = boxes.get(conn.toRoundId);
    if (!fromBox || !toBox) continue;

    const { fromSide, toSide } = chooseConnectionSides(conn, fromBox, toBox);
    const rc: RoutedConn = { conn, fromBox, toBox, fromSide, toSide };
    routed.push(rc);

    if (fromSide === "bottom") activeOutBottom.add(conn.fromRoundId);
    else activeOutRight.add(conn.fromRoundId);

    if (toSide === "top") activeInTop.add(conn.toRoundId);
    else if (toSide === "bottom") activeInBottom.add(conn.toRoundId);
    else activeInLeft.add(conn.toRoundId);
  }

  // Update port active/wire states cleanly
  for (const [rid, pts] of portsByRound.entries()) {
    const box = boxes.get(rid);
    const isFinals = box?.lane === "finals";
    if (pts.inLeft) {
      const has = activeInLeft.has(rid);
      pts.inLeft.classList.toggle("has-wire", has);
      pts.inLeft.classList.toggle("is-hidden-port", !editableActive && !has);
    }
    if (pts.inTop) {
      const has = activeInTop.has(rid);
      pts.inTop.classList.toggle("has-wire", has);
      pts.inTop.classList.toggle("is-hidden-port", !editableActive && !has);
    }
    if (pts.inBottom) {
      const has = activeInBottom.has(rid);
      pts.inBottom.classList.toggle("has-wire", has);
      pts.inBottom.classList.toggle("is-hidden-port", !editableActive && !has);
    }
    if (pts.outRight) {
      const has = !isFinals && activeOutRight.has(rid);
      pts.outRight.classList.toggle("has-wire", has);
      if (pts.outRight.tagName !== "BUTTON") {
        pts.outRight.classList.toggle("is-hidden-port", !has);
      }
    }
    if (pts.outBottom) {
      const has = !isFinals && activeOutBottom.has(rid);
      pts.outBottom.classList.toggle("has-wire", has);
      if (pts.outBottom.tagName !== "BUTTON") {
        pts.outBottom.classList.toggle("is-hidden-port", !has);
      }
    }
  }

  // Index existing SVG <path data-wire-conn="..."> and <path data-wire-hit="..."> nodes so we mutate `d` in-place
  const existingPaths = new Map<string, SVGPathElement>();
  svg.querySelectorAll<SVGPathElement>("path[data-wire-conn]").forEach((p) => {
    const cid = p.getAttribute("data-wire-conn") ?? "";
    if (cid) existingPaths.set(cid, p);
  });

  const existingHitPaths = new Map<string, SVGPathElement>();
  svg.querySelectorAll<SVGPathElement>("path[data-wire-hit]").forEach((p) => {
    const cid = p.getAttribute("data-wire-hit") ?? "";
    if (cid) existingHitPaths.set(cid, p);
  });

  const existingHandles = new Map<string, HTMLElement>();
  if (handlesLayer) {
    handlesLayer.querySelectorAll<HTMLElement>("[data-wire-endpoint]").forEach((hEl) => {
      const cid = hEl.getAttribute("data-wire-conn") ?? "";
      const end = hEl.getAttribute("data-wire-endpoint") ?? "";
      if (cid && end) existingHandles.set(`${cid}:${end}`, hEl);
    });
  }

  const seenConnIds = new Set<string>();
  const seenHandleKeys = new Set<string>();
  const placedPills: Array<{ x: number; y: number }> = [];
  const previewNode = svg.querySelector("path.is-drag-preview");

  for (const rc of routed) {
    const { conn, fromBox, toBox, fromSide, toSide } = rc;
    seenConnIds.add(conn.id);

    const p1 = computeBoxSideAnchor(fromBox, fromSide, false);
    const p2 = computeBoxSideAnchor(toBox, toSide, true);

    const { d, c1x, c1y, c2x, c2y } = buildDirectionalBezier(
      p1.x,
      p1.y,
      fromSide,
      p2.x,
      p2.y,
      toSide
    );

    const fromHeats = heatsByRound.get(conn.fromRoundId) ?? [];
    const targetHeats = heatsByRound.get(conn.toRoundId) ?? [];
    const targetUnstarted = isHandoffOutRoundId(conn.toRoundId)
      ? !anyStage2Started
      : targetHeats.every((ht) => isHeatUnstarted(ht.state));
    const isInvalid = !!conn.invalid;
    const isConfirmed =
      !isInvalid &&
      (isHandoffInRoundId(conn.fromRoundId)
        ? stage2Seeded
        : isPilotsInRoundId(conn.fromRoundId)
          ? targetHeats.some((ht) => ht.seats.some((st) => st.pilotSlotIndex > 0)) ||
            isOpenQualRoundId(conn.toRoundId)
          : fromHeats.length > 0 && fromHeats.every((ht) => ht.state === "confirmed"));
    const isBottom = conn.mode === "bottom_per_heat";
    const isPortalWire =
      conn.mode === "qual_feed" ||
      conn.mode === "stage_seeds" ||
      conn.mode === "pilots_in" ||
      isHandoffOutRoundId(conn.toRoundId) ||
      isHandoffInRoundId(conn.fromRoundId) ||
      isPilotsInRoundId(conn.fromRoundId);
    const wasHovered = existingPaths.get(conn.id)?.classList.contains("is-wire-hovered") ?? false;
    const cls = `bkt-wire${isInvalid ? " is-invalid" : ""}${isConfirmed ? " is-confirmed" : ""}${isBottom ? " is-bottom" : ""}${isPortalWire ? " is-portal-wire" : ""}${wasHovered ? " is-wire-hovered" : ""}`;

    const canEditWire =
      editableActive &&
      !conn.id.startsWith("edge-") &&
      (targetUnstarted || isInvalid);

    if (canEditWire) {
      let hitEl = existingHitPaths.get(conn.id);
      if (!hitEl) {
        hitEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
        hitEl.setAttribute("data-wire-hit", conn.id);
        hitEl.setAttribute("class", `bkt-wire-hit${isInvalid ? " is-invalid" : ""}`);
        if (previewNode) {
          svg.insertBefore(hitEl, previewNode);
        } else {
          svg.appendChild(hitEl);
        }
      } else {
        const hitCls = `bkt-wire-hit${isInvalid ? " is-invalid" : ""}`;
        if (hitEl.getAttribute("class") !== hitCls) {
          hitEl.setAttribute("class", hitCls);
        }
      }
      hitEl.setAttribute("d", d);
    } else {
      const staleHit = existingHitPaths.get(conn.id);
      if (staleHit) {
        staleHit.remove();
        existingHitPaths.delete(conn.id);
      }
    }

    let pathEl = existingPaths.get(conn.id);
    if (!pathEl) {
      pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
      pathEl.setAttribute("data-wire-conn", conn.id);
      if (previewNode) {
        svg.insertBefore(pathEl, previewNode);
      } else {
        svg.appendChild(pathEl);
      }
    }
    if (pathEl.getAttribute("class") !== cls) {
      pathEl.setAttribute("class", cls);
    }
    pathEl.setAttribute("d", d);

    if (handlesLayer && canEditWire) {
      const srcPt = computeBezierEndHandlePos(
        "source",
        p1.x,
        p1.y,
        c1x,
        c1y,
        c2x,
        c2y,
        p2.x,
        p2.y
      );
      const dstPt = computeBezierEndHandlePos(
        "target",
        p1.x,
        p1.y,
        c1x,
        c1y,
        c2x,
        c2y,
        p2.x,
        p2.y
      );

      for (const [endKind, pt] of [
        ["source", srcPt],
        ["target", dstPt],
      ] as const) {
        const hKey = `${conn.id}:${endKind}`;
        seenHandleKeys.add(hKey);
        let hEl = existingHandles.get(hKey);
        const hWasHovered = hEl?.classList.contains("is-wire-hovered") ?? wasHovered;
        const hCls = `bkt-wire-endpoint is-${endKind}${isInvalid ? " is-invalid" : ""}${isBottom ? " is-bottom" : ""}${hWasHovered ? " is-wire-hovered" : ""}`;
        if (!hEl) {
          hEl = document.createElement("button");
          hEl.type = "button";
          hEl.setAttribute("data-wire-endpoint", endKind);
          hEl.setAttribute("data-wire-conn", conn.id);
          hEl.title =
            endKind === "source"
              ? "Drag to move connection source to another round"
              : "Drag to move connection target to another round";
          handlesLayer.appendChild(hEl);
        }
        if (hEl.className !== hCls) {
          hEl.className = hCls;
        }
        hEl.style.transform = `translate3d(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px, 0) translate(-50%, -50%)`;
      }
    }

    const pillEl = pillsByConn.get(conn.id);
    if (pillEl) {
      if (wasHovered) {
        pillEl.classList.add("is-wire-hovered");
      }
      const candidateTs = [0.5, 0.36, 0.64, 0.27, 0.73];
      let chosen = evalCubicBezierPoint(0.5, p1.x, p1.y, c1x, c1y, c2x, c2y, p2.x, p2.y);
      let settled = false;
      for (const t of candidateTs) {
        const pt = evalCubicBezierPoint(t, p1.x, p1.y, c1x, c1y, c2x, c2y, p2.x, p2.y);
        const collides = placedPills.some(
          (p) => Math.abs(p.x - pt.x) < 92 && Math.abs(p.y - pt.y) < 26
        );
        if (!collides) {
          chosen = pt;
          settled = true;
          break;
        }
      }
      if (!settled) {
        while (
          placedPills.some(
            (p) => Math.abs(p.x - chosen.x) < 92 && Math.abs(p.y - chosen.y) < 26
          )
        ) {
          chosen = { x: chosen.x, y: chosen.y + 26 };
        }
      }
      placedPills.push(chosen);
      pillEl.style.transform = `translate3d(${chosen.x.toFixed(1)}px, ${chosen.y.toFixed(1)}px, 0) translate(-50%, -50%)`;
    }
  }

  for (const [cid, pathEl] of existingPaths.entries()) {
    if (!seenConnIds.has(cid)) {
      pathEl.remove();
    }
  }
  for (const [cid, hitEl] of existingHitPaths.entries()) {
    if (!seenConnIds.has(cid)) {
      hitEl.remove();
    }
  }
  for (const [hKey, cEl] of existingHandles.entries()) {
    if (!seenHandleKeys.has(hKey)) {
      cEl.remove();
    }
  }
}

/**
 * Binds all interactive race canvas & bracket gestures:
 * 1. Sub-pixel wheel zoom anchored at cursor on `[data-rc-viewport]`
 * 2. Smooth canvas panning (default `pan` tool on empty canvas, Middle-drag, Right-drag, or Space+Left-drag)
 * 3. Marquee drag-selection box on empty canvas background (`select` tool or Shift+Left-drag)
 * 4. GPU-composited, grid-free Round node & Control panel dragging (when `!ui.nodesLocked`)
 * 5. Hover-only wire action reveal (`[⚙ | ×]` pill + endpoint handles) & directional pointer-drag wire creation/reconnection
 * 6. HTML5 drag-and-drop for moving/swapping pilots across unstarted bracket seats
 */
export function bindBracketDragAndDrop(
  root: HTMLElement,
  api: ApiClient,
  getRace: () => RaceTournamentState,
  ui?: BracketEditorUiState,
  onError?: (msg: string) => void
): () => void {
  const reportErr = (err: unknown): void => {
    const msg = err instanceof Error ? err.message : String(err);
    if (onError) onError(msg);
  };

  let cleanupActiveGesture: (() => void) | null = null;
  let spaceHeld = false;
  const wireHoverLeaveTimers = new Map<string, number>();

  const extractWireConnId = (el: Element | null): string => {
    if (!el) return "";
    const hit = el.closest<Element>("[data-wire-hit], [data-wire-pill], [data-wire-endpoint]");
    if (!hit) return "";
    return (
      hit.getAttribute("data-wire-hit") ||
      hit.getAttribute("data-wire-pill") ||
      hit.getAttribute("data-wire-conn") ||
      ""
    );
  };

  let touchPinnedWireId = "";

  const setWireHoveredDom = (connId: string, hovered: boolean): void => {
    if (!connId) return;
    const escId = CSS.escape(connId);
    root
      .querySelectorAll<Element>(
        `[data-wire-conn="${escId}"], [data-wire-pill="${escId}"]`
      )
      .forEach((el) => el.classList.toggle("is-wire-hovered", hovered));
  };

  const clearAllWireHoveredDom = (exceptId = ""): void => {
    wireHoverLeaveTimers.forEach((tid, cid) => {
      if (cid !== exceptId) {
        window.clearTimeout(tid);
        wireHoverLeaveTimers.delete(cid);
      }
    });
    root.querySelectorAll<Element>(".is-wire-hovered").forEach((el) => {
      const cid =
        el.getAttribute("data-wire-conn") || el.getAttribute("data-wire-pill") || "";
      if (cid !== exceptId) {
        el.classList.remove("is-wire-hovered");
      }
    });
  };

  const onPointerOver = (e: PointerEvent): void => {
    if (e.pointerType === "touch") return;
    const cid = extractWireConnId(e.target as Element | null);
    if (!cid) return;
    const prevTimer = wireHoverLeaveTimers.get(cid);
    if (prevTimer !== undefined) {
      window.clearTimeout(prevTimer);
      wireHoverLeaveTimers.delete(cid);
    }
    setWireHoveredDom(cid, true);
  };

  const onPointerOut = (e: PointerEvent): void => {
    if (e.pointerType === "touch") return;
    const fromCid = extractWireConnId(e.target as Element | null);
    if (!fromCid || fromCid === touchPinnedWireId) return;
    const toCid = extractWireConnId(e.relatedTarget as Element | null);
    if (toCid === fromCid) return;
    const prevTimer = wireHoverLeaveTimers.get(fromCid);
    if (prevTimer !== undefined) {
      window.clearTimeout(prevTimer);
    }
    const tid = window.setTimeout(() => {
      wireHoverLeaveTimers.delete(fromCid);
      if (fromCid !== touchPinnedWireId) {
        setWireHoveredDom(fromCid, false);
      }
    }, 140);
    wireHoverLeaveTimers.set(fromCid, tid);
  };

  const onWindowKeyDown = (e: KeyboardEvent): void => {
    const active = document.activeElement;
    const inInput =
      active instanceof HTMLInputElement ||
      active instanceof HTMLSelectElement ||
      active instanceof HTMLTextAreaElement;
    if (e.code === "Space" && !inInput) {
      const viewport = root.querySelector<HTMLElement>("[data-rc-viewport]");
      if (viewport) {
        spaceHeld = true;
        viewport.classList.add("is-space-pan");
      }
    }
  };

  const onWindowKeyUp = (e: KeyboardEvent): void => {
    if (e.code === "Space") {
      spaceHeld = false;
      root.querySelector<HTMLElement>("[data-rc-viewport]")?.classList.remove("is-space-pan");
    }
  };

  // 1. Cursor-anchored wheel / trackpad zoom across Format, Stage Edit, Control, and Review boards!
  //    Whenever the pointer is over any scrollable list/table inside a canvas panel or popover,
  //    mouse-wheel events NEVER leak through to zoom the canvas — even at the top or bottom scroll boundary.
  const onWheel = (e: WheelEvent): void => {
    if (!ui) return;
    const targetEl = e.target as Element | null;
    const viewport = targetEl?.closest<HTMLElement>("[data-rc-viewport]");
    if (!viewport) return;
    if (
      targetEl?.closest(
        "[data-rc-hud], .bkt-node-menu, .bkt-wire-menu, .race-marshal-popover, .rc-pill-swapper-popover, .canvas-select-menu"
      )
    ) {
      return;
    }
    if (!e.ctrlKey && !e.metaKey) {
      let cur: HTMLElement | null =
        targetEl instanceof HTMLElement ? targetEl : targetEl?.parentElement ?? null;
      while (cur && cur !== viewport) {
        const isKnownScrollBox = cur.matches(
          ".table-scroll, .oq-flightline-list, .rc-pilots-popover, .bkt-pilots-list, .rc-panel-body, [data-preserve-scroll]"
        );
        const hasVertOverflow = cur.scrollHeight > cur.clientHeight + 1;
        const hasHorizOverflow = cur.scrollWidth > cur.clientWidth + 1;
        if (hasVertOverflow || hasHorizOverflow) {
          const style = window.getComputedStyle(cur);
          const oy = style.overflowY;
          const ox = style.overflowX;
          const vertScrollable =
            hasVertOverflow &&
            (isKnownScrollBox || oy === "auto" || oy === "scroll" || oy === "overlay");
          const horizScrollable =
            hasHorizOverflow &&
            Math.abs(e.deltaX) > Math.abs(e.deltaY) &&
            (isKnownScrollBox || ox === "auto" || ox === "scroll" || ox === "overlay");
          if (vertScrollable) {
            const canScrollDown =
              e.deltaY > 0 && cur.scrollTop + cur.clientHeight < cur.scrollHeight - 0.5;
            const canScrollUp = e.deltaY < 0 && cur.scrollTop > 0.5;
            if (!canScrollDown && !canScrollUp) {
              // Clamp at top/bottom boundary without letting the wheel event fall through to canvas zoom
              e.preventDefault();
            }
            return;
          }
          if (horizScrollable) {
            const canScrollRight =
              e.deltaX > 0 && cur.scrollLeft + cur.clientWidth < cur.scrollWidth - 0.5;
            const canScrollLeft = e.deltaX < 0 && cur.scrollLeft > 0.5;
            if (!canScrollRight && !canScrollLeft) {
              e.preventDefault();
            }
            return;
          }
        }
        cur = cur.parentElement;
      }
    }
    e.preventDefault();
    const vpRect = viewport.getBoundingClientRect();
    const cursorX = e.clientX - vpRect.left;
    const cursorY = e.clientY - vpRect.top;

    const oldZoom = ui.zoom || 1;
    const factor = Math.exp(-e.deltaY * 0.0014);
    const nextZoom = clampZoom(oldZoom * factor);
    if (nextZoom === oldZoom) return;

    const worldX = (cursorX - ui.panX) / oldZoom;
    const worldY = (cursorY - ui.panY) / oldZoom;

    ui.zoom = nextZoom;
    ui.panX = cursorX - worldX * nextZoom;
    ui.panY = cursorY - worldY * nextZoom;
    applyCanvasCameraDom(viewport, ui);
    ui.onCameraChanged?.();
  };

  let lastContextMenuHandledAt = -Infinity;
  let suppressSyntheticClickUntil = 0;
  const activeTouchPointers = new Map<number, { x: number; y: number }>();
  let pinchViewport: HTMLElement | null = null;
  let isPinchZooming = false;
  let pinchBaseDist = 0;
  let pinchBaseZoom = 1;
  let pinchWorldX = 0;
  let pinchWorldY = 0;

  const syncPinchAnchor = (viewport: HTMLElement, uiState: BracketEditorUiState): void => {
    const pts = Array.from(activeTouchPointers.values());
    if (pts.length < 2) return;
    const p1 = pts[0];
    const p2 = pts[1];
    const vpRect = viewport.getBoundingClientRect();
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    pinchBaseDist = Math.max(12, Math.hypot(p2.x - p1.x, p2.y - p1.y));
    pinchBaseZoom = uiState.zoom || 1;
    pinchWorldX = (midX - vpRect.left - uiState.panX) / pinchBaseZoom;
    pinchWorldY = (midY - vpRect.top - uiState.panY) / pinchBaseZoom;
  };

  const onTouchPointerDownCapture = (e: PointerEvent): void => {
    if (e.pointerType !== "touch" || !ui) return;
    const target = e.target as Element | null;
    const viewport = target?.closest<HTMLElement>("[data-rc-viewport]");
    if (!viewport || target?.closest("[data-rc-hud]")) return;

    activeTouchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activeTouchPointers.size >= 2) {
      if (cleanupActiveGesture) {
        cleanupActiveGesture();
      }
      viewport.dispatchEvent(new CustomEvent("slaprf-cancel-single-touch"));
      pinchViewport = viewport;
      isPinchZooming = true;
      ui.activeGesture = true;
      viewport.classList.add("is-panning");
      syncPinchAnchor(viewport, ui);
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onTouchPointerMoveWindow = (e: PointerEvent): void => {
    if (e.pointerType !== "touch" || !activeTouchPointers.has(e.pointerId)) return;
    activeTouchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!isPinchZooming || !ui || !pinchViewport || activeTouchPointers.size < 2) return;

    const pts = Array.from(activeTouchPointers.values());
    const p1 = pts[0];
    const p2 = pts[1];
    const dist = Math.max(12, Math.hypot(p2.x - p1.x, p2.y - p1.y));
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    const vpRect = pinchViewport.getBoundingClientRect();

    const nextZoom = clampZoom(pinchBaseZoom * (dist / pinchBaseDist));
    ui.zoom = nextZoom;
    ui.panX = midX - vpRect.left - pinchWorldX * nextZoom;
    ui.panY = midY - vpRect.top - pinchWorldY * nextZoom;
    applyCanvasCameraDom(pinchViewport, ui);
  };

  const onTouchPointerEndWindow = (e: PointerEvent): void => {
    if (e.pointerType !== "touch") return;
    const wasTracked = activeTouchPointers.delete(e.pointerId);
    if (!wasTracked) return;
    if (isPinchZooming) {
      if (activeTouchPointers.size >= 2 && pinchViewport && ui) {
        syncPinchAnchor(pinchViewport, ui);
      } else {
        suppressSyntheticClickUntil = performance.now() + 260;
        if (pinchViewport) {
          pinchViewport.classList.remove("is-panning");
        }
        isPinchZooming = false;
        pinchViewport = null;
        if (ui) {
          ui.activeGesture = false;
          ui.onCameraChanged?.();
        }
      }
    }
  };

  const onClickCaptureGuard = (e: MouseEvent): void => {
    if (performance.now() < suppressSyntheticClickUntil) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const isEmptyBoardBackgroundTarget = (
    target: Element | null,
    viewport: HTMLElement
  ): boolean => {
    if (!target || !viewport.contains(target)) return false;
    return !target.closest(
      "[data-rc-hud], .rc-canvas-panel, [data-round-node], [data-stage-node], [data-wire-pill], [data-wire-hit], [data-wire-endpoint], .rc-empty-floater, .bkt-node-menu, .bkt-wire-menu, [data-wire-drop-menu], button, select, input, textarea, a"
    );
  };

  const viewportClientToWorld = (
    viewport: HTMLElement,
    clientX: number,
    clientY: number,
    uiState: BracketEditorUiState
  ): { x: number; y: number } => {
    const world = viewport.querySelector<HTMLElement>("[data-rc-world]");
    const z = uiState.zoom || 1;
    if (world) {
      const wRect = world.getBoundingClientRect();
      return {
        x: Math.round((clientX - wRect.left) / z),
        y: Math.round((clientY - wRect.top) / z),
      };
    }
    const vpRect = viewport.getBoundingClientRect();
    return {
      x: Math.round((clientX - vpRect.left - uiState.panX) / z),
      y: Math.round((clientY - vpRect.top - uiState.panY) / z),
    };
  };

  const onContextMenu = (e: MouseEvent): void => {
    const targetEl = e.target as Element | null;
    const viewport = targetEl?.closest<HTMLElement>("[data-rc-viewport]");
    if (viewport && !targetEl?.closest("input, select, textarea")) {
      e.preventDefault();
      if (
        ui &&
        !ui.nodesLocked &&
        ui.onBoardContextAddMenu &&
        isEmptyBoardBackgroundTarget(targetEl, viewport) &&
        performance.now() - lastContextMenuHandledAt > 350
      ) {
        lastContextMenuHandledAt = performance.now();
        const worldPos = viewportClientToWorld(viewport, e.clientX, e.clientY, ui);
        ui.onBoardContextAddMenu(e.clientX, e.clientY, worldPos.x, worldPos.y, false);
      }
    }
  };

  const onPointerDown = (e: PointerEvent): void => {
    const target = e.target as Element | null;
    if (!target) return;

    // Reveal hover-only wire controls on touch tap of a wire hit path,
    // and dismiss when tapping away from the wire, its pill, or its endpoints.
    if (e.pointerType === "touch") {
      const wireHit = target.closest("[data-wire-hit]");
      if (wireHit) {
        const hitCid = wireHit.getAttribute("data-wire-hit") ?? "";
        if (hitCid) {
          touchPinnedWireId = hitCid;
          clearAllWireHoveredDom(hitCid);
          setWireHoveredDom(hitCid, true);
        }
        return;
      }
      if (!target.closest("[data-wire-pill], [data-wire-endpoint]") && touchPinnedWireId) {
        touchPinnedWireId = "";
        clearAllWireHoveredDom();
      }
    } else if (
      touchPinnedWireId &&
      !target.closest("[data-wire-hit], [data-wire-pill], [data-wire-endpoint]")
    ) {
      touchPinnedWireId = "";
      clearAllWireHoveredDom();
    }

    // A0. Dragging an existing connection endpoint handle (source or target) to reconnect!
    if (e.button === 0) {
      const endpointEl = target.closest("[data-wire-endpoint]");
      if (endpointEl) {
        const endpointKind =
          endpointEl.getAttribute("data-wire-endpoint") === "source" ? "source" : "target";
        const connId = endpointEl.getAttribute("data-wire-conn") ?? "";
        const canvas = endpointEl.closest<HTMLElement>("[data-bkt-graph]");
        if (connId && canvas) {
          startWireEndpointDrag(e, endpointKind, connId, canvas);
          return;
        }
      }

      // Allow dragging from ANY input port socket (even one that already has another wire on it!)
      // backward onto an upstream output port, or letting click-to-connect complete on that socket.
      const inPortEl = target.closest<HTMLElement>(".bkt-port.is-in:not(.is-hidden-port)");
      if (inPortEl) {
        if (ui?.connectingFromRoundId) {
          return;
        }
        const nodeEl = inPortEl.closest<HTMLElement>("[data-round-node]");
        const canvas = inPortEl.closest<HTMLElement>("[data-bkt-graph]");
        const toRoundId = nodeEl?.dataset.roundNode ?? "";
        const rawSide = inPortEl.dataset.portSide;
        const portSide: "left" | "top" | "bottom" =
          rawSide === "top" || rawSide === "bottom" ? rawSide : "left";
        if (canvas && toRoundId && canvas.dataset.bktEditable === "1") {
          startWireDragFromInput(e, inPortEl, toRoundId, portSide);
          return;
        }
      }

      // A1. New wire drag from right (Advance) or bottom (Drop) output port
      const outPort = target.closest<HTMLButtonElement>("button.bkt-port.is-out[data-round-out]");
      if (outPort) {
        startWireDrag(e, outPort);
        return;
      }
    }

    const viewport = target.closest<HTMLElement>("[data-rc-viewport]");
    if (!viewport || !ui) return;
    if (target.closest("[data-rc-hud]")) return;

    // B. Middle-button, Right-button, or Space+Left-drag anywhere on canvas -> Pan!
    if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceHeld)) {
      startPanGesture(e, viewport, ui);
      return;
    }

    if (e.button !== 0) return;

    if (isPinchZooming || activeTouchPointers.size >= 2) {
      return;
    }

    // C0. Focus & optionally drag a movable Canvas Panel (or allow 1-finger touch pan across non-scrollable panel surfaces!)
    const clickedPanel = target.closest<HTMLElement>(".rc-canvas-panel[data-canvas-panel]");
    if (clickedPanel) {
      const panelId = clickedPanel.dataset.canvasPanel ?? "";
      if (panelId) {
        ui.onPanelFocus?.(panelId, clickedPanel);
      }
      const panelHandle = target.closest<HTMLElement>("[data-panel-drag-handle]");
      if (
        panelHandle &&
        !ui.nodesLocked &&
        !target.closest("button, select, input, a")
      ) {
        startPanelDragGesture(e, viewport, clickedPanel, ui);
        return;
      }
      if (target.closest("[data-seat-drag-handle]")) {
        return;
      }
      if (e.pointerType === "touch") {
        if (target.closest("input, select, textarea")) {
          return;
        }
        const scrollable = target.closest<HTMLElement>(
          ".table-scroll, .oq-flightline-list, .rc-pilots-popover, .bkt-pilots-list, .rc-panel-body"
        );
        if (scrollable && scrollable.scrollHeight > scrollable.clientHeight + 2) {
          return;
        }
        // Thresholded touch pan: taps (<10px) fire normal button/row clicks; drags (>=10px) pan the board!
        startPanGesture(e, viewport, ui);
      }
      return;
    }

    // C1. Dragging a Round Node directly from its header or any non-interactive card surface (Configure stage canvas + Control board!)
    const roundNode = target.closest<HTMLElement>(".bkt-round-node.is-rc-node");
    const roundGraph = roundNode?.closest<HTMLElement>("[data-bkt-graph]");
    const canMoveRoundNode =
      !!roundGraph && !viewport.classList.contains("is-review-canvas");
    const touchPilotsList =
      e.pointerType === "touch" ? target.closest<HTMLElement>(".bkt-pilots-list") : null;
    const isScrollableTouchPilotsList =
      !!touchPilotsList && touchPilotsList.scrollHeight > touchPilotsList.clientHeight + 2;
    if (
      roundNode &&
      canMoveRoundNode &&
      !ui.nodesLocked &&
      !isScrollableTouchPilotsList &&
      !target.closest(
        "button, select, input, a, [draggable='true'], .bkt-node-menu, .bkt-wire-menu, .bkt-port"
      )
    ) {
      startNodeDragGesture(e, viewport, roundNode, ui);
      return;
    }

    if (e.pointerType === "touch") {
      if (
        target.closest(
          "input, select, textarea, .bkt-port, [data-fmt-port], [data-wire-pill], [data-wire-endpoint], .bkt-node-menu, .bkt-wire-menu, [data-wire-drop-menu], .rc-empty-floater"
        )
      ) {
        return;
      }
      if (!ui.nodesLocked && target.closest("[data-stage-node]")) {
        return;
      }
      const touchScrollable = target.closest<HTMLElement>(".bkt-pilots-list");
      if (touchScrollable && touchScrollable.scrollHeight > touchScrollable.clientHeight + 2) {
        return;
      }
      clearAllWireHoveredDom();
      if (ui.nodesLocked || viewport.classList.contains("is-control-canvas") || ui.tool === "pan") {
        startPanGesture(e, viewport, ui);
      } else {
        startMarqueeSelectGesture(e, viewport, ui);
      }
      return;
    }

    // Ignore clicks inside seats, stage cards, wire pills, wire hit paths, menus, or empty floater buttons
    if (
      target.closest(
        "[data-round-node], [data-stage-node], [data-wire-pill], [data-wire-hit], [data-wire-endpoint], .rc-empty-floater, button, select, input"
      )
    ) {
      return;
    }

    clearAllWireHoveredDom();

    // D. Empty canvas background: Pan when locked or in default `pan` tool (without Shift); otherwise Marquee Box-Select!
    if (
      ui.nodesLocked ||
      ((viewport.classList.contains("is-control-canvas") || ui.tool === "pan") && !e.shiftKey)
    ) {
      startPanGesture(e, viewport, ui);
    } else {
      startMarqueeSelectGesture(e, viewport, ui);
    }
  };

  const startPanGesture = (
    e: PointerEvent,
    viewport: HTMLElement,
    uiState: BracketEditorUiState
  ): void => {
    const isTouch = e.pointerType === "touch";
    if (!isTouch) {
      e.preventDefault();
    }
    if (cleanupActiveGesture) cleanupActiveGesture();

    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    const origPanX = uiState.panX;
    const origPanY = uiState.panY;
    const isRightButton = e.button === 2;
    const startedOnEmptyBoard = isEmptyBoardBackgroundTarget(e.target as Element | null, viewport);
    const moveThreshold = isTouch ? 10 : isRightButton ? 5 : 3;
    let moved = false;
    let longPressFired = false;
    let longPressTimer = 0;

    if (isTouch && startedOnEmptyBoard && !uiState.nodesLocked && uiState.onBoardContextAddMenu) {
      longPressTimer = window.setTimeout(() => {
        longPressTimer = 0;
        if (moved || isPinchZooming || activeTouchPointers.size >= 2) return;
        longPressFired = true;
        suppressSyntheticClickUntil = performance.now() + 300;
        finish(e);
        lastContextMenuHandledAt = performance.now();
        const worldPos = viewportClientToWorld(viewport, startX, startY, uiState);
        uiState.onBoardContextAddMenu?.(startX, startY, worldPos.x, worldPos.y, true);
      }, 440);
    }

    uiState.activeGesture = true;
    if (!isTouch) {
      viewport.classList.add("is-panning");
      try {
        viewport.setPointerCapture(pointerId);
      } catch {
        // Synthetic pointer events in tests may not have an active pointerId
      }
    }

    let panRafId = 0;
    const flushPanDom = (): void => {
      if (panRafId) {
        window.cancelAnimationFrame(panRafId);
        panRafId = 0;
      }
      applyCanvasCameraDom(viewport, uiState);
    };

    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId || longPressFired || isPinchZooming) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) >= moveThreshold) {
        moved = true;
        if (longPressTimer) {
          window.clearTimeout(longPressTimer);
          longPressTimer = 0;
        }
        if (isTouch) {
          viewport.classList.add("is-panning");
          try {
            viewport.setPointerCapture(pointerId);
          } catch {
            // Ignore synthetic pointer
          }
        }
      }
      if (!moved && (isTouch || isRightButton)) {
        return;
      }
      uiState.panX = origPanX + dx;
      uiState.panY = origPanY + dy;
      if (!panRafId) {
        panRafId = window.requestAnimationFrame(() => {
          panRafId = 0;
          applyCanvasCameraDom(viewport, uiState);
        });
      }
    };

    const finish = (ev?: PointerEvent): void => {
      if (ev && ev.pointerId !== undefined && ev.pointerId !== pointerId) return;
      if (panRafId) {
        flushPanDom();
      }
      if (longPressTimer) {
        window.clearTimeout(longPressTimer);
        longPressTimer = 0;
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", onCancel);
      try {
        if (viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId);
      } catch {
        // Ignore
      }
      viewport.classList.remove("is-panning");
      uiState.activeGesture = false;
      cleanupActiveGesture = null;

      if (longPressFired) {
        return;
      }
      if (moved) {
        if (isTouch) {
          suppressSyntheticClickUntil = performance.now() + 240;
        }
        uiState.onCameraChanged?.();
      } else if (
        isRightButton &&
        startedOnEmptyBoard &&
        uiState.onBoardContextAddMenu &&
        ev?.type !== "pointercancel"
      ) {
        lastContextMenuHandledAt = performance.now();
        const cx = ev?.clientX ?? startX;
        const cy = ev?.clientY ?? startY;
        const worldPos = viewportClientToWorld(viewport, cx, cy, uiState);
        uiState.onBoardContextAddMenu(cx, cy, worldPos.x, worldPos.y, false);
      } else if (startedOnEmptyBoard) {
        const hadState =
          uiState.selectedRoundIds.size > 0 ||
          !!uiState.openNodeMenuId ||
          !!uiState.openWireMenuId ||
          !!uiState.connectingFromRoundId;
        uiState.selectedRoundIds.clear();
        uiState.openNodeMenuId = "";
        uiState.openWireMenuId = "";
        uiState.connectingFromRoundId = "";
        if (hadState) {
          uiState.rerender();
        }
      }
    };

    const onCancel = (ev: PointerEvent): void => finish(ev);

    cleanupActiveGesture = () => finish();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", onCancel);
  };

  const startPanelDragGesture = (
    e: PointerEvent,
    viewport: HTMLElement,
    panelEl: HTMLElement,
    uiState: BracketEditorUiState
  ): void => {
    const panelId = panelEl.dataset.canvasPanel ?? "";
    if (!panelId) return;
    e.preventDefault();
    e.stopPropagation();
    if (cleanupActiveGesture) cleanupActiveGesture();

    if (viewport.scrollLeft !== 0) viewport.scrollLeft = 0;
    if (viewport.scrollTop !== 0) viewport.scrollTop = 0;
    const pointerId = e.pointerId;
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const zoom = uiState.zoom || 1;
    const startPos = readNodeWorldPos(panelEl);
    const isControlCanvas = viewport.classList.contains("is-control-canvas");
    const world = viewport.querySelector<HTMLElement>("[data-rc-world]");
    const dividerEl = world?.querySelector<HTMLElement>("[data-rc-control-divider]") ?? null;
    const hasActiveBoundary = isControlCanvas && !!dividerEl && !dividerEl.hasAttribute("hidden");
    const boundaryY = hasActiveBoundary ? Number(world?.dataset.controlBoundaryY) || 0 : 0;
    const panelHeight = panelEl.offsetHeight || 260;
    let curX = startPos.x;
    let curY = startPos.y;
    let curHitBoundary = false;
    let dragging = false;
    let panelRafId = 0;
    uiState.activeGesture = true;

    const flushPanelDom = (): void => {
      if (panelRafId) {
        window.cancelAnimationFrame(panelRafId);
        panelRafId = 0;
      }
      dividerEl?.classList.toggle("is-boundary-hit", curHitBoundary);
      panelEl.style.transform = `translate3d(${curX}px, ${curY}px, 0)`;
    };

    const onMove = (ev: PointerEvent): void => {
      const dxScreen = ev.clientX - startClientX;
      const dyScreen = ev.clientY - startClientY;
      if (!dragging && Math.hypot(dxScreen, dyScreen) < 3) return;
      if (!dragging) {
        dragging = true;
        uiState.activeGesture = true;
        panelEl.classList.add("is-dragging-panel");
        viewport.classList.add("is-dragging-nodes");
        try {
          viewport.setPointerCapture(pointerId);
        } catch {
          // Ignore synthetic pointer
        }
      }
      let nextX = Math.round((startPos.x + dxScreen / zoom) * 10) / 10;
      let nextY = Math.round((startPos.y + dyScreen / zoom) * 10) / 10;
      let hitBoundary = false;
      // Only restrict crossing downward past the stage divider line — no top, left, or right limits!
      if (hasActiveBoundary && boundaryY > 0) {
        const maxPanelY =
          Math.round((boundaryY - panelHeight - CONTROL_PANEL_BOTTOM_CLEARANCE) * 10) / 10;
        if (nextY > maxPanelY) {
          nextY = maxPanelY;
          hitBoundary = true;
        }
      }
      curX = nextX;
      curY = nextY;
      curHitBoundary = hitBoundary;
      panelEl.dataset.posX = String(curX);
      panelEl.dataset.posY = String(curY);
      if (!panelRafId) {
        panelRafId = window.requestAnimationFrame(() => {
          panelRafId = 0;
          dividerEl?.classList.toggle("is-boundary-hit", curHitBoundary);
          panelEl.style.transform = `translate3d(${curX}px, ${curY}px, 0)`;
        });
      }
    };

    const finish = (_ev: PointerEvent, cancelled: boolean): void => {
      if (panelRafId) {
        flushPanelDom();
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      try {
        if (viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId);
      } catch {
        // Ignore
      }
      dividerEl?.classList.remove("is-boundary-hit");
      panelEl.classList.remove("is-dragging-panel");
      viewport.classList.remove("is-dragging-nodes");
      uiState.activeGesture = false;
      cleanupActiveGesture = null;

      if (cancelled) {
        setNodeWorldPos(panelEl, startPos.x, startPos.y);
        return;
      }
      if (dragging) {
        uiState.onPanelMoved?.(panelId, curX, curY);
      }
    };

    const onUp = (ev: PointerEvent): void => finish(ev, false);
    const onCancel = (ev: PointerEvent): void => finish(ev, true);

    cleanupActiveGesture = () => finish(e, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  const startMarqueeSelectGesture = (
    e: PointerEvent,
    viewport: HTMLElement,
    uiState: BracketEditorUiState
  ): void => {
    e.preventDefault();
    if (cleanupActiveGesture) cleanupActiveGesture();

    const pointerId = e.pointerId;
    const marqueeEl = viewport.querySelector<HTMLElement>("[data-rc-marquee]");
    const vpRect = viewport.getBoundingClientRect();
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const startX = e.clientX - vpRect.left;
    const startY = e.clientY - vpRect.top;
    const additive = e.shiftKey;
    const baseSelection = additive ? new Set(uiState.selectedRoundIds) : new Set<string>();
    const isTouch = e.pointerType === "touch";
    const startedOnEmptyBoard = isEmptyBoardBackgroundTarget(e.target as Element | null, viewport);
    const moveThreshold = isTouch ? 8 : 4;
    let moved = false;
    let longPressFired = false;
    let longPressTimer = 0;

    if (isTouch && startedOnEmptyBoard && uiState.onBoardContextAddMenu) {
      longPressTimer = window.setTimeout(() => {
        longPressTimer = 0;
        if (moved) return;
        longPressFired = true;
        finish();
        lastContextMenuHandledAt = performance.now();
        const worldPos = viewportClientToWorld(viewport, startClientX, startClientY, uiState);
        uiState.onBoardContextAddMenu?.(startClientX, startClientY, worldPos.x, worldPos.y, true);
      }, 440);
    }

    uiState.activeGesture = true;

    const syncSelectionClasses = (selected: Set<string>): void => {
      viewport
        .querySelectorAll<HTMLElement>("[data-round-node], [data-stage-node]")
        .forEach((n) => {
          const nid = n.dataset.roundNode || n.dataset.stageNode || "";
          n.classList.toggle("is-selected-node", selected.has(nid));
        });
    };

    const onMove = (ev: PointerEvent): void => {
      if (longPressFired) return;
      const curX = ev.clientX - vpRect.left;
      const curY = ev.clientY - vpRect.top;
      if (!moved && Math.hypot(curX - startX, curY - startY) < moveThreshold) return;
      if (!moved) {
        moved = true;
        if (longPressTimer) {
          window.clearTimeout(longPressTimer);
          longPressTimer = 0;
        }
        try {
          viewport.setPointerCapture(pointerId);
        } catch {
          // Ignore synthetic pointer
        }
      }

      const left = Math.min(startX, curX);
      const top = Math.min(startY, curY);
      const width = Math.abs(curX - startX);
      const height = Math.abs(curY - startY);

      if (marqueeEl) {
        marqueeEl.hidden = false;
        marqueeEl.style.left = `${left}px`;
        marqueeEl.style.top = `${top}px`;
        marqueeEl.style.width = `${width}px`;
        marqueeEl.style.height = `${height}px`;
      }

      const boxScreenLeft = vpRect.left + left;
      const boxScreenRight = boxScreenLeft + width;
      const boxScreenTop = vpRect.top + top;
      const boxScreenBottom = boxScreenTop + height;

      const nextSel = new Set(baseSelection);
      viewport
        .querySelectorAll<HTMLElement>("[data-round-node], [data-stage-node]")
        .forEach((nodeEl) => {
          const nr = nodeEl.getBoundingClientRect();
          const intersects =
            nr.right >= boxScreenLeft &&
            nr.left <= boxScreenRight &&
            nr.bottom >= boxScreenTop &&
            nr.top <= boxScreenBottom;
          const nid = nodeEl.dataset.roundNode || nodeEl.dataset.stageNode;
          if (intersects && nid) {
            nextSel.add(nid);
          }
        });
      uiState.selectedRoundIds = nextSel;
      syncSelectionClasses(nextSel);
    };

    const finish = (): void => {
      if (longPressTimer) {
        window.clearTimeout(longPressTimer);
        longPressTimer = 0;
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      try {
        if (viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId);
      } catch {
        // Ignore
      }
      uiState.activeGesture = false;
      cleanupActiveGesture = null;
      if (marqueeEl) marqueeEl.hidden = true;

      if (longPressFired) {
        return;
      }
      if (!moved) {
        const hadState =
          uiState.selectedRoundIds.size > 0 ||
          !!uiState.openNodeMenuId ||
          !!uiState.openWireMenuId ||
          !!uiState.connectingFromRoundId;
        if (!additive) {
          uiState.selectedRoundIds.clear();
        }
        uiState.openNodeMenuId = "";
        uiState.openWireMenuId = "";
        uiState.connectingFromRoundId = "";
        if (hadState) {
          uiState.rerender();
        }
      } else {
        uiState.rerender();
      }
    };

    cleanupActiveGesture = finish;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const startNodeDragGesture = (
    e: PointerEvent,
    viewport: HTMLElement,
    roundNode: HTMLElement,
    uiState: BracketEditorUiState
  ): void => {
    const roundId = roundNode.dataset.roundNode ?? "";
    if (!roundId) return;
    const targetEl = e.target as Element | null;
    const clickedSelectableHeat = !!targetEl?.closest("[data-select-heat]");
    if (!clickedSelectableHeat) {
      e.preventDefault();
    }
    e.stopPropagation();
    if (cleanupActiveGesture) cleanupActiveGesture();

    if (viewport.scrollLeft !== 0) viewport.scrollLeft = 0;
    if (viewport.scrollTop !== 0) viewport.scrollTop = 0;
    const pointerId = e.pointerId;
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const zoom = uiState.zoom || 1;
    let dragging = false;
    uiState.activeGesture = true;

    const movingIds: string[] = uiState.selectedRoundIds.has(roundId)
      ? Array.from(uiState.selectedRoundIds)
      : e.shiftKey
        ? [...Array.from(uiState.selectedRoundIds), roundId]
        : [roundId];

    // Pre-cache world boxes, port elements, and wire pills ONCE at drag start so pointermove is 100% layout-free!
    const world = viewport.querySelector<HTMLElement>("[data-rc-world]");
    const worldEditable = world?.dataset.bktEditable === "1";
    const svg = world?.querySelector<SVGSVGElement>("svg.bkt-wires") ?? null;
    const handlesLayer = world?.querySelector<HTMLElement>("[data-bkt-wire-handles]") ?? null;
    const raceSnap = getRace();
    const viewStage = Number(world?.dataset.bktViewStage) || raceSnap.activeStageIndex || 1;
    const stageHeats = raceSnap.heats.filter((ht) => ht.stageIndex === viewStage);
    const { rounds: stageRounds, heatsByRound } = resolveStageRounds(
      raceSnap,
      viewStage,
      stageHeats,
      true
    );
    const stageConnections = resolveStageConnections(
      raceSnap,
      viewStage,
      stageRounds,
      heatsByRound
    );
    const editableActive =
      worldEditable && raceSnap.lifecycle !== "completed" && raceSnap.lifecycle !== "scrapped";
    const anyDownstreamStarted = anyDownstreamStageStarted(raceSnap, viewStage);
    const curStgObj = raceSnap.stages?.find((s) => s.index === viewStage);
    const stageSeededNow = curStgObj
      ? !!curStgObj.prerequisitesMet
      : !!(raceSnap.qualifyingComplete || raceSnap.stage2SeededEarly);

    const boxes = new Map<string, NodeWorldBox>();
    const portsByRound = new Map<string, CachedNodePorts>();
    viewport.querySelectorAll<HTMLElement>("[data-round-node]").forEach((el) => {
      const rid = el.dataset.roundNode ?? "";
      if (!rid) return;
      const { x, y } = readNodeWorldPos(el);
      boxes.set(rid, {
        id: rid,
        lane: el.dataset.roundLane || "winners",
        x,
        y,
        w: el.offsetWidth || RC_NODE_WIDTH,
        h: el.offsetHeight || 220,
        el,
      });
      portsByRound.set(rid, {
        inLeft: el.querySelector<HTMLElement>("[data-port-side='left']"),
        inTop: el.querySelector<HTMLElement>("[data-port-side='top']"),
        inBottom: el.querySelector<HTMLElement>("[data-port-side='bottom']"),
        outRight: el.querySelector<HTMLElement>("[data-port-dir='right']"),
        outBottom: el.querySelector<HTMLElement>("[data-port-dir='bottom']"),
      });
    });

    const pillsByConn = new Map<string, HTMLElement>();
    world?.querySelectorAll<HTMLElement>("[data-wire-pill]").forEach((pEl) => {
      const cid = pEl.dataset.wirePill ?? "";
      if (cid) pillsByConn.set(cid, pEl);
    });

    const startPositions = new Map<string, { box: NodeWorldBox; startX: number; startY: number }>();
    for (const id of movingIds) {
      const box = boxes.get(id);
      if (box) {
        startPositions.set(id, {
          box,
          startX: box.x,
          startY: box.y,
        });
      }
    }

    const isControlCanvas = viewport.classList.contains("is-control-canvas");
    const dividerEl = world?.querySelector<HTMLElement>("[data-rc-control-divider]") ?? null;
    const boundaryY = isControlCanvas ? Number(world?.dataset.controlBoundaryY) || 0 : 0;
    const stageOffsetY = isControlCanvas
      ? Number(world?.dataset.stageOffsetY) || boundaryY + CONTROL_STAGE_TOP_CLEARANCE
      : 0;
    const minControlWorldY =
      isControlCanvas && boundaryY > 0 ? boundaryY + CONTROL_STAGE_TOP_CLEARANCE : -Infinity;
    let minMovingStartY = Infinity;
    for (const info of startPositions.values()) {
      if (info.startY < minMovingStartY) minMovingStartY = info.startY;
    }

    let nodeDragRafId = 0;
    let latestHitBoundary = false;
    const flushNodeDragDom = (): void => {
      if (nodeDragRafId) {
        window.cancelAnimationFrame(nodeDragRafId);
        nodeDragRafId = 0;
      }
      dividerEl?.classList.toggle("is-boundary-hit", latestHitBoundary);
      for (const info of startPositions.values()) {
        info.box.el.style.transform = `translate3d(${info.box.x}px, ${info.box.y}px, 0)`;
      }
      if (svg && !svg.hasAttribute("hidden")) {
        updateCanvasWiresFromBoxes(
          svg,
          handlesLayer,
          boxes,
          portsByRound,
          pillsByConn,
          stageConnections,
          heatsByRound,
          editableActive,
          stageSeededNow,
          anyDownstreamStarted
        );
      }
    };

    const onMove = (ev: PointerEvent): void => {
      const dxScreen = ev.clientX - startClientX;
      const dyScreen = ev.clientY - startClientY;
      if (!dragging && Math.hypot(dxScreen, dyScreen) < 4) return;

      if (!dragging) {
        dragging = true;
        uiState.activeGesture = true;
        if (uiState.selectedRoundIds.size > 0 && !uiState.selectedRoundIds.has(roundId)) {
          uiState.selectedRoundIds = e.shiftKey ? new Set(movingIds) : new Set();
        }
        uiState.openNodeMenuId = "";
        uiState.openWireMenuId = "";
        viewport.classList.add("is-dragging-nodes");
        try {
          viewport.setPointerCapture(pointerId);
        } catch {
          // Ignore synthetic pointer
        }
        boxes.forEach((b, rid) => {
          const isSel = uiState.selectedRoundIds.has(rid);
          b.el.classList.toggle("is-selected-node", isSel);
          b.el.classList.toggle("is-dragging-node", startPositions.has(rid));
        });
      }

      const dxWorld = dxScreen / zoom;
      let dyWorld = dyScreen / zoom;
      let hitBoundary = false;
      if (
        Number.isFinite(minControlWorldY) &&
        Number.isFinite(minMovingStartY) &&
        minMovingStartY + dyWorld < minControlWorldY
      ) {
        dyWorld = minControlWorldY - minMovingStartY;
        hitBoundary = true;
      }
      latestHitBoundary = hitBoundary;

      for (const [id, info] of startPositions.entries()) {
        // Continuous sub-pixel world coordinates (no grid snap!)
        const nx = Math.round((info.startX + dxWorld) * 10) / 10;
        const ny = Math.round((info.startY + dyWorld) * 10) / 10;
        info.box.x = nx;
        info.box.y = ny;
        info.box.el.dataset.posX = String(nx);
        info.box.el.dataset.posY = String(ny);
        const canonicalX = nx;
        const canonicalY = isControlCanvas ? Math.round((ny - stageOffsetY) * 10) / 10 : ny;
        info.box.el.dataset.basePosX = String(canonicalX);
        info.box.el.dataset.basePosY = String(canonicalY);
        uiState.optimisticPositions.set(id, { x: canonicalX, y: canonicalY });
      }

      if (!nodeDragRafId) {
        nodeDragRafId = window.requestAnimationFrame(() => {
          nodeDragRafId = 0;
          flushNodeDragDom();
        });
      }
    };

    const finish = (_ev: PointerEvent, cancelled: boolean): void => {
      if (nodeDragRafId) {
        flushNodeDragDom();
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      try {
        if (viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId);
      } catch {
        // Ignore
      }
      dividerEl?.classList.remove("is-boundary-hit");
      viewport.classList.remove("is-dragging-nodes");
      boxes.forEach((b) => b.el.classList.remove("is-dragging-node"));
      uiState.activeGesture = false;
      cleanupActiveGesture = null;

      if (cancelled) {
        uiState.optimisticPositions.clear();
        uiState.rerender();
        return;
      }

      if (!dragging) {
        if (isControlCanvas && !worldEditable) {
          return;
        }
        // Click on node selects / toggles selection in Edit mode
        const prevKey = Array.from(uiState.selectedRoundIds).sort().join(",");
        if (e.shiftKey) {
          if (uiState.selectedRoundIds.has(roundId)) {
            uiState.selectedRoundIds.delete(roundId);
          } else {
            uiState.selectedRoundIds.add(roundId);
          }
        } else {
          uiState.selectedRoundIds = new Set([roundId]);
        }
        const nextKey = Array.from(uiState.selectedRoundIds).sort().join(",");
        const hadOpenMenu = !!uiState.openNodeMenuId || !!uiState.openWireMenuId;
        uiState.openNodeMenuId = "";
        uiState.openWireMenuId = "";
        if (prevKey !== nextKey || hadOpenMenu) {
          uiState.rerender();
        }
        return;
      }

      const positions: RoundPositionUpdate[] = [];
      for (const [id, info] of startPositions.entries()) {
        const opt = uiState.optimisticPositions.get(id);
        positions.push({
          roundId: id,
          posX: opt ? opt.x : info.startX,
          posY: opt
            ? opt.y
            : isControlCanvas
              ? Math.round((info.startY - stageOffsetY) * 10) / 10
              : info.startY,
        });
      }

      void api
        .bracketEdit({ action: "move_rounds", positions })
        .then(() => {
          uiState.optimisticPositions.clear();
        })
        .catch((err) => {
          uiState.optimisticPositions.clear();
          reportErr(err);
        });
    };

    const onUp = (ev: PointerEvent): void => finish(ev, false);
    const onCancel = (ev: PointerEvent): void => finish(ev, true);

    cleanupActiveGesture = () => finish(e, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  interface HoveredPortSocket {
    nodeEl: HTMLElement;
    roundId: string;
    portEl: HTMLElement;
    kind: "in" | "out";
    side: PortSide;
    dist: number;
  }

  const PORT_SNAP_RADIUS_PX = 28;

  const findHoveredPortSocket = (
    canvas: HTMLElement,
    clientX: number,
    clientY: number,
    ignorePortEl?: Element | null,
    preferredKind?: "in" | "out"
  ): HoveredPortSocket | null => {
    let bestPreferred: HoveredPortSocket | null = null;
    let bestPreferredDist = PORT_SNAP_RADIUS_PX;
    let bestOther: HoveredPortSocket | null = null;
    let bestOtherDist = PORT_SNAP_RADIUS_PX;
    canvas.querySelectorAll<HTMLElement>("[data-round-node]").forEach((nodeEl) => {
      const roundId = nodeEl.dataset.roundNode ?? "";
      if (!roundId) return;
      nodeEl.querySelectorAll<HTMLElement>(".bkt-port:not(.is-hidden-port)").forEach((portEl) => {
        if (ignorePortEl && portEl === ignorePortEl) return;
        const r = portEl.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const d = Math.hypot(clientX - cx, clientY - cy);
        if (d > PORT_SNAP_RADIUS_PX) return;
        const kind: "in" | "out" = portEl.classList.contains("is-out") ? "out" : "in";
        const rawSide = portEl.dataset.portSide || portEl.dataset.portDir || "left";
        const side: PortSide =
          rawSide === "right" || rawSide === "top" || rawSide === "bottom" ? rawSide : "left";
        const sock: HoveredPortSocket = { nodeEl, roundId, portEl, kind, side, dist: d };
        if (!preferredKind || kind === preferredKind) {
          if (d <= bestPreferredDist) {
            bestPreferredDist = d;
            bestPreferred = sock;
          }
        } else if (d <= bestOtherDist) {
          bestOtherDist = d;
          bestOther = sock;
        }
      });
    });
    if (bestPreferred && bestOther) {
      // Only show invalid opposite-kind hover when cursor is directly on top of the opposite port
      // and distinctly farther from any valid-kind port
      if (bestOtherDist < 11 && bestPreferredDist > 19) {
        return bestOther;
      }
      return bestPreferred;
    }
    return bestPreferred ?? bestOther;
  };

  const readCanvasNodeBox = (canvas: HTMLElement, nodeEl: HTMLElement): NodeWorldBox => {
    const rid = nodeEl.dataset.roundNode ?? "";
    const lane = nodeEl.dataset.roundLane || "winners";
    if (canvas.hasAttribute("data-rc-world")) {
      const { x, y } = readNodeWorldPos(nodeEl);
      return {
        id: rid,
        lane,
        x,
        y,
        w: nodeEl.offsetWidth || RC_NODE_WIDTH,
        h: nodeEl.offsetHeight || 220,
        el: nodeEl,
      };
    }
    const cr = canvas.getBoundingClientRect();
    const nr = nodeEl.getBoundingClientRect();
    return {
      id: rid,
      lane,
      x: nr.left - cr.left + canvas.scrollLeft,
      y: nr.top - cr.top + canvas.scrollTop,
      w: nr.width,
      h: nr.height,
      el: nodeEl,
    };
  };

  const clearWireSnapClasses = (canvas: HTMLElement): void => {
    canvas.classList.remove("is-invalid-wire-target");
    canvas
      .querySelectorAll<HTMLElement>(
        ".is-wire-snap, .is-wire-snap-warn, .is-port-snap, .is-port-invalid"
      )
      .forEach((el) => {
        el.classList.remove(
          "is-wire-snap",
          "is-wire-snap-warn",
          "is-port-snap",
          "is-port-invalid"
        );
      });
  };

type RoundWireDropKind =
  | "qualifying"
  | "open_qualifier"
  | "zippyq_qualifier"
  | "race"
  | "points_mains"
  | "finals";

function buildRoundWireDropOptions(
  fromRoundId: string,
  fromRound: RaceRound | undefined,
  portDir: OutputPortDir,
  _stageHasFinals: boolean
): WireDropOption[] {
  const finalsOpt: WireDropOption = {
    id: "finals",
    label: "Finals",
    iconHtml: icons.trophy(16),
    title: "Connect to a Championship Finals round",
  };
  const qualOpt: WireDropOption = {
    id: "qualifying",
    label: "Qualifier",
    iconHtml: icons.timer(16),
    title: "Connect to a Timed Qualifying round",
  };
  const openQualOpt: WireDropOption = {
    id: "open_qualifier",
    label: "Open Qualifier",
    iconHtml: icons.zap(16),
    title: "Connect to an Open Qualifier (Flight Queue) round",
  };
  const zippyOpt: WireDropOption = {
    id: "zippyq_qualifier",
    label: "ZippyQ",
    iconHtml: icons.zap(16),
    title: "Connect to a ZippyQ Qualifier round",
  };
  const raceOpt: WireDropOption = {
    id: "race",
    label: "Race Round",
    iconHtml: icons.plus(16),
    title:
      portDir === "bottom"
        ? "Connect to a new Redemption / Race round"
        : "Connect to a new Head-to-Head Race round",
  };
  const pointsOpt: WireDropOption = {
    id: "points_mains",
    label: "Points Round",
    iconHtml: icons.layers(16),
    title: "Connect to a Points-scored round",
  };

  if (isPilotsInRoundId(fromRoundId)) {
    return [qualOpt, openQualOpt, zippyOpt, raceOpt, pointsOpt, finalsOpt];
  }
  const isQual =
    fromRound?.bracketLane === "qualifying" ||
    fromRound?.bracketLane === "open_qual" ||
    fromRound?.stageFormat === "qualifying" ||
    fromRound?.stageFormat === "open_qualifier" ||
    isOpenQualRoundId(fromRoundId);
  if (isQual) {
    return [qualOpt, raceOpt, pointsOpt, finalsOpt];
  }
  if (portDir === "bottom") {
    return [raceOpt, pointsOpt, finalsOpt];
  }
  return [raceOpt, pointsOpt, finalsOpt, qualOpt];
}

  const startWireDrag = (e: PointerEvent, outPort: HTMLButtonElement): void => {
    const canvas = outPort.closest<HTMLElement>("[data-bkt-graph]");
    const svg = canvas?.querySelector<SVGSVGElement>("svg.bkt-wires");
    const fromRoundId = outPort.dataset.roundOut ?? "";
    const portDir: OutputPortDir = outPort.dataset.portDir === "bottom" ? "bottom" : "right";
    if (!canvas || !svg || !fromRoundId) return;

    e.preventDefault();
    e.stopPropagation();
    dismissWireDropMenu();

    if (cleanupActiveGesture) {
      cleanupActiveGesture();
    }

    const race = getRace();
    const viewStage = Number(canvas.dataset.bktViewStage) || race.activeStageIndex || 1;
    const stageHeats = race.heats.filter((h) => h.stageIndex === viewStage);
    const { rounds: stageRounds, heatsByRound } = resolveStageRounds(
      race,
      viewStage,
      stageHeats,
      canvas.dataset.bktEditable === "1"
    );
    const stageConnections = resolveStageConnections(race, viewStage, stageRounds, heatsByRound);
    const roundGraph = buildRoundNetworkGraph(
      race,
      viewStage,
      stageRounds,
      heatsByRound,
      stageConnections
    );
    const validTargets = roundGraph.getValidTargetIds(fromRoundId, { fromPort: portDir });

    const fromNodeEl = canvas.querySelector<HTMLElement>(
      `[data-round-node="${CSS.escape(fromRoundId)}"]`
    );

    const startClientX = e.clientX;
    const startClientY = e.clientY;
    let isDraggingWire = false;
    let previewPath: SVGPathElement | null = null;

    const isSocketValidForOutDrag = (sock: HoveredPortSocket): boolean =>
      sock.kind === "in" && sock.roundId !== fromRoundId && validTargets.has(sock.roundId);

    const updatePreview = (clientX: number, clientY: number): void => {
      const isRcWorld = canvas.hasAttribute("data-rc-world");
      if (!isRcWorld) {
        const cRect = canvas.getBoundingClientRect();
        const w = Math.max(cRect.width, canvas.scrollWidth);
        const h = Math.max(cRect.height, canvas.scrollHeight);
        svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
        svg.setAttribute("width", String(w));
        svg.setAttribute("height", String(h));
      }

      const p1 = fromNodeEl
        ? computeBoxSideAnchor(readCanvasNodeBox(canvas, fromNodeEl), portDir, false)
        : screenToCanvasCoords(
            canvas,
            outPort.getBoundingClientRect().left + outPort.getBoundingClientRect().width / 2,
            outPort.getBoundingClientRect().top + outPort.getBoundingClientRect().height / 2,
            ui
          );

      clearWireSnapClasses(canvas);

      const hovered = findHoveredPortSocket(canvas, clientX, clientY, outPort, "in");
      let p2 = screenToCanvasCoords(canvas, clientX, clientY, ui);
      let toSide: PortSide =
        portDir === "bottom"
          ? p2.y >= p1.y + 18
            ? "top"
            : "left"
          : p2.x >= p1.x - 20
            ? "left"
            : p2.y < p1.y
              ? "bottom"
              : "top";

      let isSnappedValid = false;
      let isSnappedInvalid = false;

      if (hovered) {
        const toBox = readCanvasNodeBox(canvas, hovered.nodeEl);
        toSide = hovered.side;
        p2 = computeBoxSideAnchor(toBox, hovered.side, hovered.kind === "in");
        if (isSocketValidForOutDrag(hovered)) {
          isSnappedValid = true;
          hovered.nodeEl.classList.add("is-wire-snap");
          hovered.portEl.classList.add("is-port-snap");
        } else {
          isSnappedInvalid = true;
          hovered.nodeEl.classList.add("is-wire-snap-warn");
          hovered.portEl.classList.add("is-port-invalid");
          canvas.classList.add("is-invalid-wire-target");
        }
      }

      if (!previewPath) {
        previewPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        previewPath.setAttribute(
          "class",
          `bkt-wire is-drag-preview ${portDir === "bottom" ? "is-bottom" : ""}`
        );
        svg.appendChild(previewPath);
      }
      const { d } = buildDirectionalBezier(p1.x, p1.y, portDir, p2.x, p2.y, toSide);
      previewPath.setAttribute("d", d);
      previewPath.classList.toggle("is-snapped", isSnappedValid);
      previewPath.classList.toggle("is-invalid-snap", isSnappedInvalid);
    };

    const onPointerMove = (ev: PointerEvent): void => {
      const dist = Math.hypot(ev.clientX - startClientX, ev.clientY - startClientY);
      if (!isDraggingWire && dist >= 5) {
        isDraggingWire = true;
        if (ui) ui.activeGesture = true;
        canvas.classList.add("is-dragging-wire");
        outPort.classList.add("is-active");
        canvas.querySelectorAll<HTMLElement>("[data-round-node]").forEach((nodeEl) => {
          const rid = nodeEl.dataset.roundNode ?? "";
          if (validTargets.has(rid)) {
            nodeEl.classList.add("is-wire-candidate");
          }
        });
      }
      if (isDraggingWire) {
        updatePreview(ev.clientX, ev.clientY);
      }
    };

    const finishDrag = (ev: PointerEvent, cancelled: boolean): void => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      if (ui) ui.activeGesture = false;
      cleanupActiveGesture = null;

      canvas.classList.remove("is-dragging-wire");
      outPort.classList.remove("is-active");
      clearWireSnapClasses(canvas);
      canvas.querySelectorAll(".is-wire-candidate").forEach((el) => {
        el.classList.remove("is-wire-candidate");
      });
      if (previewPath && previewPath.parentNode) {
        previewPath.parentNode.removeChild(previewPath);
      }
      previewPath = null;

      if (cancelled) return;

      if (isDraggingWire) {
        const finalSocket = findHoveredPortSocket(canvas, ev.clientX, ev.clientY, outPort, "in");
        if (!finalSocket || !isSocketValidForOutDrag(finalSocket)) {
          if (finalSocket) {
            const reason =
              finalSocket.kind !== "in"
                ? "Connect an output port to an input port."
                : roundGraph.validateConnection(fromRoundId, finalSocket.roundId, {
                    fromPort: portDir,
                  }).reason;
            if (reason) showToast(reason, "warn");
            return;
          }
          // Dropped in empty canvas space: open contextual `+` speed-dial to spawn & connect a round!
          if (canvas.dataset.bktEditable !== "1") return;
          const curRace = getRace();
          if (curRace.lifecycle === "completed" || curRace.lifecycle === "scrapped") return;
          const viewport = canvas.closest<HTMLElement>("[data-rc-viewport]");
          if (!viewport) return;

          const curStageHeats = curRace.heats.filter((h) => h.stageIndex === viewStage);
          const { rounds: curStageRounds } = resolveStageRounds(
            curRace,
            viewStage,
            curStageHeats,
            true
          );
          const fromRound = curStageRounds.find((r) => r.id === fromRoundId);
          if (isHandoffOutRoundId(fromRoundId) || fromRound?.bracketLane === "finals") return;

          const stageHasFinals = curStageRounds.some((r) => r.bracketLane === "finals");
          const options = buildRoundWireDropOptions(
            fromRoundId,
            fromRound,
            portDir,
            stageHasFinals
          );

          const p1 = fromNodeEl
            ? computeBoxSideAnchor(readCanvasNodeBox(canvas, fromNodeEl), portDir, false)
            : screenToCanvasCoords(
                canvas,
                outPort.getBoundingClientRect().left + outPort.getBoundingClientRect().width / 2,
                outPort.getBoundingClientRect().top + outPort.getBoundingClientRect().height / 2,
                ui
              );
          const dropWorld = screenToCanvasCoords(canvas, ev.clientX, ev.clientY, ui);
          const toPort: "left" | "top" =
            portDir === "bottom" && dropWorld.y >= p1.y + 24 ? "top" : "left";
          const { d } = buildDirectionalBezier(p1.x, p1.y, portDir, dropWorld.x, dropWorld.y, toPort);

          openWireDropMenu({
            viewport,
            svg,
            outPort,
            clientX: ev.clientX,
            clientY: ev.clientY,
            tetherPathD: d,
            isBottomPort: portDir === "bottom",
            options,
            onSelect: (chosenKindRaw) => {
              const kind = chosenKindRaw as RoundWireDropKind;
              const liveRace = getRace();
              const liveStageHeats = liveRace.heats.filter((h) => h.stageIndex === viewStage);
              const { rounds: liveStageRounds } = resolveStageRounds(
                liveRace,
                viewStage,
                liveStageHeats,
                true
              );
              const nonPortal = liveStageRounds.filter((r) => !isHandoffPortalRound(r));
              const qualCount = nonPortal.filter((r) => r.bracketLane === "qualifying").length;
              const loserCount = nonPortal.filter((r) => r.bracketLane === "losers").length;
              const stgSettings =
                (liveRace.stages ?? []).find((s) => s.index === viewStage)?.settings ??
                liveRace.config;

              let title: string | undefined;
              let bracketLane = "winners";
              let stageFormat: StageFormat = "single_elimination";
              let targetLaps = stgSettings.targetLaps || liveRace.config.targetLaps || 3;
              let linkMode: RoundConnectionMode | undefined;

              switch (kind) {
                case "qualifying":
                  title = `Qualifying ${qualCount + 1}`;
                  bracketLane = "qualifying";
                  stageFormat = "qualifying";
                  targetLaps = 0;
                  break;
                case "open_qualifier":
                  title = "Open Qualifier";
                  bracketLane = "open_qual";
                  stageFormat = "open_qualifier";
                  targetLaps = 0;
                  break;
                case "zippyq_qualifier":
                  title = "ZippyQ Qualifier";
                  bracketLane = "open_qual";
                  stageFormat = "open_qualifier";
                  targetLaps = 0;
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
                  if (!isPilotsInRoundId(fromRoundId) && !isHandoffInRoundId(fromRoundId) && portDir === "bottom") {
                    linkMode = "bottom_per_heat";
                  }
                  break;
              }

              const spawnX = Math.round(
                toPort === "top" ? dropWorld.x - RC_NODE_WIDTH / 2 : dropWorld.x
              );
              const spawnY = Math.round(toPort === "top" ? dropWorld.y : dropWorld.y - 80);
              const prevRoundIds = new Set((liveRace.rounds ?? []).map((r) => r.id));
              const prevConns = [...(liveRace.connections ?? [])];
              const positions = collectStageRoundPositions(canvas, liveRace, viewStage, ui);

              if (ui) {
                ui.connectingFromRoundId = "";
                ui.connectingFromPortDir = "right";
                ui.openWireMenuId = "";
                ui.openNodeMenuId = "";
              }

              void api
                .bracketEdit({
                  action: "add_round",
                  stageIndex: viewStage,
                  title,
                  bracketLane,
                  stageFormat,
                  targetLaps,
                  timeLimitSec: stgSettings.timeLimitSec || liveRace.config.timeLimitSec || 120,
                  fromRoundId,
                  fromPort: portDir,
                  toPort,
                  ...(linkMode ? { linkMode } : {}),
                  hasPos: true,
                  posX: spawnX,
                  posY: spawnY,
                  positions,
                })
                .then((nextState) => {
                  const updated = nextState ?? getRace();
                  notifyNewlyInvalidConnections(prevConns, updated);
                  const addedRound = (updated.rounds ?? []).find(
                    (r) =>
                      r.stageIndex === viewStage &&
                      !prevRoundIds.has(r.id) &&
                      !isHandoffPortalRound(r)
                  );
                  if (addedRound) {
                    const hostRoot = viewport.parentElement ?? viewport;
                    const nodeEl = hostRoot.querySelector<HTMLElement>(
                      `[data-round-node="${CSS.escape(addedRound.id)}"]`
                    );
                    flashSpawnedCanvasNode(nodeEl);
                  }
                })
                .catch(reportErr);
            },
          });
          return;
        }
        const toRoundId = finalSocket.roundId;
        const toPort: "left" | "top" | "bottom" =
          finalSocket.side === "top" || finalSocket.side === "bottom" ? finalSocket.side : "left";
        if (ui) {
          ui.connectingFromRoundId = "";
          ui.connectingFromPortDir = "right";
          ui.openWireMenuId = "";
          ui.openNodeMenuId = "";
        }
        const curRace = getRace();
        const prevConns = [...(curRace.connections ?? [])];
        const linkMode = defaultLinkModeForOutputPort(curRace, fromRoundId, portDir, toRoundId);
        const advanceCount = roundGraph.recommendedAdvanceCount(fromRoundId, linkMode);
        const positions = collectStageRoundPositions(canvas, curRace, viewStage, ui);
        void api
          .bracketEdit({
            action: "connect_rounds",
            fromRoundId,
            toRoundId,
            fromPort: portDir,
            toPort,
            linkMode,
            ...(advanceCount !== undefined ? { advanceCount } : {}),
            positions,
          })
          .then((next) => notifyNewlyInvalidConnections(prevConns, next ?? getRace()))
          .catch(reportErr);
      } else if (ui) {
        const sameToggle =
          ui.connectingFromRoundId === fromRoundId && ui.connectingFromPortDir === portDir;
        ui.connectingFromRoundId = sameToggle ? "" : fromRoundId;
        ui.connectingFromPortDir = sameToggle ? "right" : portDir;
        ui.openWireMenuId = "";
        ui.openNodeMenuId = "";
        ui.rerender();
      }
    };

    const onPointerUp = (ev: PointerEvent): void => finishDrag(ev, false);
    const onPointerCancel = (ev: PointerEvent): void => finishDrag(ev, true);

    cleanupActiveGesture = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      if (ui) ui.activeGesture = false;
      clearWireSnapClasses(canvas);
      if (previewPath && previewPath.parentNode) {
        previewPath.parentNode.removeChild(previewPath);
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  };

  /**
   * Allows dragging from an unconnected input port socket (`inPort`) onto a valid upstream output
   * port socket. Hovering another input port (`Input -> Input`), self-loop, or DAG cycle highlights
   * the wire and hovered port in red and drops/cancels on release.
   */
  const startWireDragFromInput = (
    e: PointerEvent,
    inPort: HTMLElement,
    toRoundId: string,
    toPortSide: "left" | "top" | "bottom"
  ): void => {
    const canvas = inPort.closest<HTMLElement>("[data-bkt-graph]");
    const svg = canvas?.querySelector<SVGSVGElement>("svg.bkt-wires");
    if (!canvas || !svg || !toRoundId) return;

    // If click-to-connect is currently armed from an output port, let the click handler finish it
    if (ui?.connectingFromRoundId) return;

    e.preventDefault();
    e.stopPropagation();
    if (cleanupActiveGesture) {
      cleanupActiveGesture();
    }

    const race = getRace();
    const viewStage = Number(canvas.dataset.bktViewStage) || race.activeStageIndex || 1;
    const stageHeats = race.heats.filter((h) => h.stageIndex === viewStage);
    const { rounds: stageRounds, heatsByRound } = resolveStageRounds(
      race,
      viewStage,
      stageHeats,
      canvas.dataset.bktEditable === "1"
    );
    const stageConnections = resolveStageConnections(race, viewStage, stageRounds, heatsByRound);
    const roundGraph = buildRoundNetworkGraph(
      race,
      viewStage,
      stageRounds,
      heatsByRound,
      stageConnections
    );

    const validSources = new Set<string>();
    for (const r of stageRounds) {
      if (isHandoffOutRoundId(r.id) || r.bracketLane === "finals") continue;
      if (
        roundGraph.validateConnection(r.id, toRoundId, { fromPort: "right" }).valid ||
        roundGraph.validateConnection(r.id, toRoundId, { fromPort: "bottom" }).valid
      ) {
        validSources.add(r.id);
      }
    }

    const toNodeEl = canvas.querySelector<HTMLElement>(
      `[data-round-node="${CSS.escape(toRoundId)}"]`
    );
    if (!toNodeEl) return;

    const startClientX = e.clientX;
    const startClientY = e.clientY;
    let isDraggingWire = false;
    let previewPath: SVGPathElement | null = null;

    const isSocketValidForInDrag = (sock: HoveredPortSocket): boolean => {
      if (sock.kind !== "out" || sock.roundId === toRoundId) return false;
      const fromPort: OutputPortDir = sock.side === "bottom" ? "bottom" : "right";
      return roundGraph.validateConnection(sock.roundId, toRoundId, { fromPort }).valid;
    };

    const updatePreview = (clientX: number, clientY: number): void => {
      const isRcWorld = canvas.hasAttribute("data-rc-world");
      if (!isRcWorld) {
        const cRect = canvas.getBoundingClientRect();
        const w = Math.max(cRect.width, canvas.scrollWidth);
        const h = Math.max(cRect.height, canvas.scrollHeight);
        svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
        svg.setAttribute("width", String(w));
        svg.setAttribute("height", String(h));
      }

      const toBox = readCanvasNodeBox(canvas, toNodeEl);
      const p2 = computeBoxSideAnchor(toBox, toPortSide, true);

      clearWireSnapClasses(canvas);

      const hovered = findHoveredPortSocket(canvas, clientX, clientY, inPort, "out");
      let p1 = screenToCanvasCoords(canvas, clientX, clientY, ui);
      let fromSide: PortSide =
        toPortSide === "top" && p1.y < p2.y - 20 ? "bottom" : "right";

      let isSnappedValid = false;
      let isSnappedInvalid = false;

      if (hovered) {
        const hoverBox = readCanvasNodeBox(canvas, hovered.nodeEl);
        fromSide = hovered.side;
        p1 = computeBoxSideAnchor(hoverBox, hovered.side, hovered.kind === "in");
        if (isSocketValidForInDrag(hovered)) {
          isSnappedValid = true;
          hovered.nodeEl.classList.add("is-wire-snap");
          hovered.portEl.classList.add("is-port-snap");
        } else {
          isSnappedInvalid = true;
          hovered.nodeEl.classList.add("is-wire-snap-warn");
          hovered.portEl.classList.add("is-port-invalid");
          canvas.classList.add("is-invalid-wire-target");
        }
      }

      if (!previewPath) {
        previewPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        previewPath.setAttribute("class", "bkt-wire is-drag-preview");
        svg.appendChild(previewPath);
      }
      previewPath.classList.toggle("is-bottom", fromSide === "bottom");
      const { d } = buildDirectionalBezier(p1.x, p1.y, fromSide, p2.x, p2.y, toPortSide);
      previewPath.setAttribute("d", d);
      previewPath.classList.toggle("is-snapped", isSnappedValid);
      previewPath.classList.toggle("is-invalid-snap", isSnappedInvalid);
    };

    const onPointerMove = (ev: PointerEvent): void => {
      const dist = Math.hypot(ev.clientX - startClientX, ev.clientY - startClientY);
      if (!isDraggingWire && dist >= 5) {
        isDraggingWire = true;
        if (ui) ui.activeGesture = true;
        canvas.classList.add("is-dragging-wire");
        inPort.classList.add("is-active");
        canvas.querySelectorAll<HTMLElement>("[data-round-node]").forEach((nodeEl) => {
          const rid = nodeEl.dataset.roundNode ?? "";
          if (validSources.has(rid)) {
            nodeEl.classList.add("is-wire-candidate");
          }
        });
      }
      if (isDraggingWire) {
        updatePreview(ev.clientX, ev.clientY);
      }
    };

    const finishDrag = (ev: PointerEvent, cancelled: boolean): void => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      if (ui) ui.activeGesture = false;
      cleanupActiveGesture = null;

      canvas.classList.remove("is-dragging-wire");
      inPort.classList.remove("is-active");
      clearWireSnapClasses(canvas);
      canvas.querySelectorAll(".is-wire-candidate").forEach((el) => {
        el.classList.remove("is-wire-candidate");
      });
      if (previewPath && previewPath.parentNode) {
        previewPath.parentNode.removeChild(previewPath);
      }
      previewPath = null;

      if (cancelled || !isDraggingWire) return;

      const finalSocket = findHoveredPortSocket(canvas, ev.clientX, ev.clientY, inPort, "out");
      if (!finalSocket || !isSocketValidForInDrag(finalSocket)) {
        if (finalSocket) {
          const fromPort: OutputPortDir = finalSocket.side === "bottom" ? "bottom" : "right";
          const reason =
            finalSocket.kind !== "out"
              ? "Connect an output port to an input port."
              : roundGraph.validateConnection(finalSocket.roundId, toRoundId, { fromPort }).reason;
          if (reason) showToast(reason, "warn");
        }
        return;
      }
      const fromRoundId = finalSocket.roundId;
      const fromPort: OutputPortDir = finalSocket.side === "bottom" ? "bottom" : "right";
      const curRace = getRace();
      const prevConns = [...(curRace.connections ?? [])];
      const linkMode = defaultLinkModeForOutputPort(curRace, fromRoundId, fromPort, toRoundId);
      const advanceCount = roundGraph.recommendedAdvanceCount(fromRoundId, linkMode);
      const positions = collectStageRoundPositions(canvas, curRace, viewStage, ui);
      void api
        .bracketEdit({
          action: "connect_rounds",
          fromRoundId,
          toRoundId,
          fromPort,
          toPort: toPortSide,
          linkMode,
          ...(advanceCount !== undefined ? { advanceCount } : {}),
          positions,
        })
        .then((next) => notifyNewlyInvalidConnections(prevConns, next ?? getRace()))
        .catch(reportErr);
    };

    const onPointerUp = (ev: PointerEvent): void => finishDrag(ev, false);
    const onPointerCancel = (ev: PointerEvent): void => finishDrag(ev, true);

    cleanupActiveGesture = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      if (ui) ui.activeGesture = false;
      clearWireSnapClasses(canvas);
      if (previewPath && previewPath.parentNode) {
        previewPath.parentNode.removeChild(previewPath);
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  };

  /**
   * Drags either endpoint (`"source"` or `"target"`) of an existing connection to reconnect it
   * in-place without deleting and recreating the wire. Clicking an endpoint without dragging
   * does NOT open connector settings (settings open strictly via the pill's gear/siren icon).
   */
  const startWireEndpointDrag = (
    e: PointerEvent,
    endpointKind: "source" | "target",
    connId: string,
    canvas: HTMLElement
  ): void => {
    const svg = canvas.querySelector<SVGSVGElement>("svg.bkt-wires");
    const handlesLayer = canvas.querySelector<HTMLElement>("[data-bkt-wire-handles]");
    if (!svg || !connId || connId.startsWith("edge-")) return;

    const race = getRace();
    if (race.lifecycle === "completed" || race.lifecycle === "scrapped") return;
    const viewStage = Number(canvas.dataset.bktViewStage) || race.activeStageIndex || 1;
    const stageHeats = race.heats.filter((h) => h.stageIndex === viewStage);
    const { rounds: stageRounds, heatsByRound } = resolveStageRounds(
      race,
      viewStage,
      stageHeats,
      canvas.dataset.bktEditable === "1"
    );
    const stageConnections = resolveStageConnections(race, viewStage, stageRounds, heatsByRound);
    const conn = stageConnections.find((c) => c.id === connId);
    if (!conn) return;

    const fixedRoundId = endpointKind === "target" ? conn.fromRoundId : conn.toRoundId;
    const fixedNodeEl = canvas.querySelector<HTMLElement>(
      `[data-round-node="${CSS.escape(fixedRoundId)}"]`
    );
    if (!fixedNodeEl) return;

    const origFromEl = canvas.querySelector<HTMLElement>(
      `[data-round-node="${CSS.escape(conn.fromRoundId)}"]`
    );
    const origToEl = canvas.querySelector<HTMLElement>(
      `[data-round-node="${CSS.escape(conn.toRoundId)}"]`
    );
    const initialSides =
      origFromEl && origToEl
        ? chooseConnectionSides(
            conn,
            readCanvasNodeBox(canvas, origFromEl),
            readCanvasNodeBox(canvas, origToEl)
          )
        : {
            fromSide: (conn.mode === "bottom_per_heat" ? "bottom" : "right") as OutputPortDir,
            toSide: "left" as const,
          };

    e.preventDefault();
    e.stopPropagation();
    if (cleanupActiveGesture) {
      cleanupActiveGesture();
    }

    const roundGraph = buildRoundNetworkGraph(
      race,
      viewStage,
      stageRounds,
      heatsByRound,
      stageConnections,
      connId
    );
    const validCandidates = new Set<string>();
    if (endpointKind === "target") {
      validCandidates.add(conn.toRoundId);
      roundGraph
        .getValidTargetIds(conn.fromRoundId, { fromPort: initialSides.fromSide })
        .forEach((id) => validCandidates.add(id));
    } else {
      validCandidates.add(conn.fromRoundId);
      for (const r of stageRounds) {
        if (isHandoffOutRoundId(r.id) || r.bracketLane === "finals") continue;
        if (
          roundGraph.validateConnection(r.id, conn.toRoundId, { fromPort: "right" }).valid ||
          roundGraph.validateConnection(r.id, conn.toRoundId, { fromPort: "bottom" }).valid
        ) {
          validCandidates.add(r.id);
        }
      }
    }

    const startClientX = e.clientX;
    const startClientY = e.clientY;
    let isDragging = false;
    let previewPath: SVGPathElement | null = null;

    const isEndpointSocketValid = (sock: HoveredPortSocket): boolean => {
      if (endpointKind === "target") {
        if (sock.kind !== "in" || sock.roundId === conn.fromRoundId) return false;
        if (sock.roundId === conn.toRoundId) return true;
        return roundGraph.validateConnection(conn.fromRoundId, sock.roundId, {
          fromPort: initialSides.fromSide,
        }).valid;
      }
      if (sock.kind !== "out" || sock.roundId === conn.toRoundId) return false;
      const fromPort: OutputPortDir = sock.side === "bottom" ? "bottom" : "right";
      if (sock.roundId === conn.fromRoundId && fromPort === initialSides.fromSide) return true;
      return roundGraph.validateConnection(sock.roundId, conn.toRoundId, { fromPort }).valid;
    };

    const setOrigWireReconnecting = (active: boolean): void => {
      const escId = CSS.escape(connId);
      svg.querySelector(`[data-wire-conn="${escId}"]`)?.classList.toggle("is-reconnecting", active);
      handlesLayer
        ?.querySelectorAll(`[data-wire-conn="${escId}"]`)
        .forEach((el) => el.classList.toggle("is-reconnecting", active));
      canvas
        .querySelector(`[data-wire-pill="${escId}"]`)
        ?.classList.toggle("is-reconnecting", active);
    };

    const updatePreview = (clientX: number, clientY: number): void => {
      const isRcWorld = canvas.hasAttribute("data-rc-world");
      if (!isRcWorld) {
        const cRect = canvas.getBoundingClientRect();
        const w = Math.max(cRect.width, canvas.scrollWidth);
        const h = Math.max(cRect.height, canvas.scrollHeight);
        svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
        svg.setAttribute("width", String(w));
        svg.setAttribute("height", String(h));
      }

      clearWireSnapClasses(canvas);

      const hovered = findHoveredPortSocket(
        canvas,
        clientX,
        clientY,
        undefined,
        endpointKind === "target" ? "in" : "out"
      );
      const cursorWorld = screenToCanvasCoords(canvas, clientX, clientY, ui);
      const fixedBox = readCanvasNodeBox(canvas, fixedNodeEl);

      let p1: { x: number; y: number };
      let p2: { x: number; y: number };
      let fromSide: PortSide = initialSides.fromSide;
      let toSide: PortSide = initialSides.toSide;
      let isSnappedValid = false;
      let isSnappedInvalid = false;

      if (endpointKind === "target") {
        // Fixed source (`fixedBox`, `initialSides.fromSide`), moving target (`cursorWorld` or `hovered`)
        fromSide = initialSides.fromSide;
        p1 = computeBoxSideAnchor(fixedBox, fromSide, false);

        if (hovered) {
          const hoverBox = readCanvasNodeBox(canvas, hovered.nodeEl);
          toSide = hovered.side;
          p2 = computeBoxSideAnchor(hoverBox, hovered.side, hovered.kind === "in");
          if (isEndpointSocketValid(hovered)) {
            isSnappedValid = true;
            hovered.nodeEl.classList.add("is-wire-snap");
            hovered.portEl.classList.add("is-port-snap");
          } else {
            isSnappedInvalid = true;
            hovered.nodeEl.classList.add("is-wire-snap-warn");
            hovered.portEl.classList.add("is-port-invalid");
            canvas.classList.add("is-invalid-wire-target");
          }
        } else {
          p2 = cursorWorld;
          toSide =
            fromSide === "bottom"
              ? p2.y >= p1.y + 18
                ? "top"
                : "left"
              : p2.x >= p1.x - 20
                ? "left"
                : p2.y < p1.y
                  ? "bottom"
                  : "top";
        }
      } else {
        // Moving source (`cursorWorld` or `hovered`), fixed target (`fixedBox`, `initialSides.toSide`)
        toSide = initialSides.toSide;
        p2 = computeBoxSideAnchor(fixedBox, toSide, true);

        if (hovered) {
          const hoverBox = readCanvasNodeBox(canvas, hovered.nodeEl);
          fromSide = hovered.side;
          p1 = computeBoxSideAnchor(hoverBox, hovered.side, hovered.kind === "in");
          if (isEndpointSocketValid(hovered)) {
            isSnappedValid = true;
            hovered.nodeEl.classList.add("is-wire-snap");
            hovered.portEl.classList.add("is-port-snap");
          } else {
            isSnappedInvalid = true;
            hovered.nodeEl.classList.add("is-wire-snap-warn");
            hovered.portEl.classList.add("is-port-invalid");
            canvas.classList.add("is-invalid-wire-target");
          }
        } else {
          p1 = cursorWorld;
          const fixedCx = fixedBox.x + fixedBox.w / 2;
          const fixedCy = fixedBox.y + fixedBox.h / 2;
          fromSide =
            Math.abs(fixedCx - p1.x) < fixedBox.w * 0.75 && fixedCy > p1.y + 60
              ? "bottom"
              : "right";
        }
      }

      if (!previewPath) {
        previewPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        previewPath.setAttribute(
          "class",
          `bkt-wire is-drag-preview ${fromSide === "bottom" ? "is-bottom" : ""}`
        );
        svg.appendChild(previewPath);
      }
      previewPath.classList.toggle("is-bottom", fromSide === "bottom");
      const { d } = buildDirectionalBezier(p1.x, p1.y, fromSide, p2.x, p2.y, toSide);
      previewPath.setAttribute("d", d);
      previewPath.classList.toggle("is-snapped", isSnappedValid);
      previewPath.classList.toggle("is-invalid-snap", isSnappedInvalid);
    };

    const onPointerMove = (ev: PointerEvent): void => {
      const dist = Math.hypot(ev.clientX - startClientX, ev.clientY - startClientY);
      if (!isDragging && dist >= 5) {
        isDragging = true;
        if (ui) {
          ui.activeGesture = true;
          ui.openWireMenuId = "";
          ui.openNodeMenuId = "";
        }
        canvas.classList.add("is-dragging-wire");
        setOrigWireReconnecting(true);
        canvas.querySelectorAll<HTMLElement>("[data-round-node]").forEach((nodeEl) => {
          const rid = nodeEl.dataset.roundNode ?? "";
          if (validCandidates.has(rid)) {
            nodeEl.classList.add("is-wire-candidate");
          }
        });
      }
      if (isDragging) {
        updatePreview(ev.clientX, ev.clientY);
      }
    };

    const finishEndpointDrag = (ev: PointerEvent, cancelled: boolean): void => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      if (ui) ui.activeGesture = false;
      cleanupActiveGesture = null;

      canvas.classList.remove("is-dragging-wire");
      setOrigWireReconnecting(false);
      clearWireSnapClasses(canvas);
      canvas.querySelectorAll(".is-wire-candidate").forEach((el) => {
        el.classList.remove("is-wire-candidate");
      });
      if (previewPath && previewPath.parentNode) {
        previewPath.parentNode.removeChild(previewPath);
      }
      previewPath = null;

      if (cancelled) return;

      if (cancelled || !isDragging) return;

      const finalSocket = findHoveredPortSocket(
        canvas,
        ev.clientX,
        ev.clientY,
        undefined,
        endpointKind === "target" ? "in" : "out"
      );
      if (!finalSocket || !isEndpointSocketValid(finalSocket)) {
        if (finalSocket) {
          let reason = "";
          if (endpointKind === "target") {
            reason =
              finalSocket.kind !== "in"
                ? "Connect an output port to an input port."
                : roundGraph.validateConnection(conn.fromRoundId, finalSocket.roundId, {
                    fromPort: initialSides.fromSide,
                  }).reason;
          } else {
            const fromPort: OutputPortDir = finalSocket.side === "bottom" ? "bottom" : "right";
            reason =
              finalSocket.kind !== "out"
                ? "Connect an output port to an input port."
                : roundGraph.validateConnection(finalSocket.roundId, conn.toRoundId, { fromPort })
                    .reason;
          }
          if (reason) showToast(reason, "warn");
        }
        return;
      }

      const curRace = getRace();
      const nextFromId = endpointKind === "source" ? finalSocket.roundId : conn.fromRoundId;
      const nextToId = endpointKind === "target" ? finalSocket.roundId : conn.toRoundId;
      const nextFromPort: OutputPortDir =
        endpointKind === "source"
          ? finalSocket.side === "bottom"
            ? "bottom"
            : "right"
          : initialSides.fromSide;
      const nextToPort: "left" | "top" | "bottom" =
        endpointKind === "target"
          ? finalSocket.side === "top" || finalSocket.side === "bottom"
            ? finalSocket.side
            : "left"
          : initialSides.toSide;

      const changedEndpoints = nextFromId !== conn.fromRoundId || nextToId !== conn.toRoundId;
      const changedPorts =
        nextFromPort !== initialSides.fromSide || nextToPort !== initialSides.toSide;

      let nextMode: RoundConnectionMode | undefined = conn.mode;
      if (isHandoffOutRoundId(nextToId)) {
        nextMode = "qual_feed";
      } else if (isPilotsInRoundId(nextFromId)) {
        nextMode = "pilots_in";
      } else if (isHandoffInRoundId(nextFromId)) {
        nextMode = "stage_seeds";
      } else if (endpointKind === "source" && nextFromPort === "bottom") {
        nextMode = "bottom_per_heat";
      } else if (changedEndpoints && !conn.customCount) {
        nextMode = defaultLinkModeForOutputPort(
          curRace,
          nextFromId,
          nextFromPort,
          nextToId
        );
      } else if (endpointKind === "source" && nextFromPort === "right" && conn.mode === "bottom_per_heat") {
        nextMode =
          defaultLinkModeForOutputPort(curRace, nextFromId, "right", nextToId) ?? "top_per_heat";
      }

      if (!changedEndpoints && !changedPorts && (nextMode ?? conn.mode) === conn.mode) {
        return;
      }

      const prevConns = [...(curRace.connections ?? [])];
      const positions = collectStageRoundPositions(canvas, curRace, viewStage, ui);
      void api
        .bracketEdit({
          action: "reconnect_connection",
          connectionId: conn.id,
          fromRoundId: nextFromId,
          toRoundId: nextToId,
          fromPort: nextFromPort,
          toPort: nextToPort,
          linkMode: nextMode,
          positions,
        })
        .then((next) => notifyNewlyInvalidConnections(prevConns, next ?? getRace(), conn.id))
        .catch(reportErr);
    };

    const onPointerUp = (ev: PointerEvent): void => finishEndpointDrag(ev, false);
    const onPointerCancel = (ev: PointerEvent): void => finishEndpointDrag(ev, true);

    cleanupActiveGesture = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      if (ui) ui.activeGesture = false;
      setOrigWireReconnecting(false);
      clearWireSnapClasses(canvas);
      if (previewPath && previewPath.parentNode) {
        previewPath.parentNode.removeChild(previewPath);
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  };

  // Pilot Seat HTML5 Drag-and-Drop
  const clearHighlights = (): void => {
    root.querySelectorAll(".is-drop-target, .is-dragging").forEach((el) => {
      el.classList.remove("is-drop-target", "is-dragging");
    });
  };

  const onDragStart = (e: DragEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target || target.closest("select, button, input")) {
      e.preventDefault();
      return;
    }
    const seatEl = target.closest<HTMLElement>("[data-drag-seat-heat]");
    if (seatEl) {
      const payload: DragPayload = {
        kind: "seat",
        fromHeatId: seatEl.dataset.dragSeatHeat ?? "",
        fromSeatIndex: Number(seatEl.dataset.dragSeatIdx),
        pilotSlotIndex: Number(seatEl.dataset.dragPilot),
      };
      activeDragPayload = payload;
      seatEl.classList.add("is-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        try {
          e.dataTransfer.setData("text/plain", JSON.stringify(payload));
        } catch {
          // Ignore synthetic DataTransfer restrictions
        }
      }
      return;
    }

    const chipEl = target.closest<HTMLElement>("[data-drag-pilot]");
    if (chipEl) {
      const payload: DragPayload = {
        kind: "pilot",
        pilotSlotIndex: Number(chipEl.dataset.dragPilot),
      };
      activeDragPayload = payload;
      chipEl.classList.add("is-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "copyMove";
        try {
          e.dataTransfer.setData("text/plain", JSON.stringify(payload));
        } catch {
          // Ignore synthetic DataTransfer restrictions
        }
      }
    }
  };

  const onDragOver = (e: DragEvent): void => {
    const target = e.target as HTMLElement | null;
    const dropSeat = target?.closest<HTMLElement>("[data-drop-heat]");
    if (!dropSeat) return;
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }
    root.querySelectorAll(".is-drop-target").forEach((el) => {
      if (el !== dropSeat) el.classList.remove("is-drop-target");
    });
    dropSeat.classList.add("is-drop-target");
  };

  const onDragLeave = (e: DragEvent): void => {
    const target = e.target as HTMLElement | null;
    const dropSeat = target?.closest<HTMLElement>("[data-drop-heat]");
    if (dropSeat && !dropSeat.contains(e.relatedTarget as Node | null)) {
      dropSeat.classList.remove("is-drop-target");
    }
  };

  const onDragEnd = (): void => {
    activeDragPayload = null;
    clearHighlights();
  };

  const onDrop = (e: DragEvent): void => {
    const target = e.target as HTMLElement | null;
    const dropSeat = target?.closest<HTMLElement>("[data-drop-heat]");
    clearHighlights();
    if (!dropSeat) return;
    e.preventDefault();

    const toHeatId = dropSeat.dataset.dropHeat ?? "";
    const toSeatIndex = Number(dropSeat.dataset.dropSeat);
    if (!toHeatId || toSeatIndex <= 0) return;

    let payload = activeDragPayload;
    activeDragPayload = null;
    if (!payload && e.dataTransfer) {
      try {
        const raw = e.dataTransfer.getData("text/plain");
        if (raw) payload = JSON.parse(raw) as DragPayload;
      } catch {
        payload = null;
      }
    }
    if (!payload) return;

    if (payload.kind === "seat" && payload.fromHeatId && payload.fromSeatIndex) {
      if (payload.fromHeatId === toHeatId && payload.fromSeatIndex === toSeatIndex) return;
      void api
        .bracketEdit({
          action: "move_or_swap_seat",
          fromHeatId: payload.fromHeatId,
          fromSeatIndex: payload.fromSeatIndex,
          toHeatId,
          toSeatIndex,
        })
        .catch(reportErr);
      return;
    }

    if (payload.kind === "pilot" && payload.pilotSlotIndex > 0) {
      void api
        .bracketEdit({
          action: "assign_pilot_seat",
          heatId: toHeatId,
          seatIndex: toSeatIndex,
          pilotSlotIndex: payload.pilotSlotIndex,
        })
        .catch(reportErr);
    }
  };

  root.addEventListener("wheel", onWheel, { passive: false });
  root.addEventListener("contextmenu", onContextMenu);
  root.addEventListener("click", onClickCaptureGuard, true);
  root.addEventListener("pointerdown", onTouchPointerDownCapture, true);
  window.addEventListener("pointermove", onTouchPointerMoveWindow);
  window.addEventListener("pointerup", onTouchPointerEndWindow);
  window.addEventListener("pointercancel", onTouchPointerEndWindow);
  root.addEventListener("pointerover", onPointerOver);
  root.addEventListener("pointerout", onPointerOut);
  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("dragstart", onDragStart);
  root.addEventListener("dragover", onDragOver);
  root.addEventListener("dragleave", onDragLeave);
  root.addEventListener("dragend", onDragEnd);
  root.addEventListener("drop", onDrop);
  window.addEventListener("keydown", onWindowKeyDown);
  window.addEventListener("keyup", onWindowKeyUp);

  ensureCanvasSelectGlobalBinding();

  const onCanvasSelectChange = (e: Event): void => {
    handleBracketEditEvent(e, api, getRace, ui, onError);
  };

  root.addEventListener("canvas-select-change", onCanvasSelectChange);

  return () => {
    if (cleanupActiveGesture) cleanupActiveGesture();
    activeTouchPointers.clear();
    isPinchZooming = false;
    pinchViewport = null;
    closeCanvasSelectPopover();
    wireHoverLeaveTimers.forEach((tid) => window.clearTimeout(tid));
    wireHoverLeaveTimers.clear();
    root.removeEventListener("canvas-select-change", onCanvasSelectChange);
    root.removeEventListener("wheel", onWheel);
    root.removeEventListener("contextmenu", onContextMenu);
    root.removeEventListener("click", onClickCaptureGuard, true);
    root.removeEventListener("pointerdown", onTouchPointerDownCapture, true);
    window.removeEventListener("pointermove", onTouchPointerMoveWindow);
    window.removeEventListener("pointerup", onTouchPointerEndWindow);
    window.removeEventListener("pointercancel", onTouchPointerEndWindow);
    root.removeEventListener("pointerover", onPointerOver);
    root.removeEventListener("pointerout", onPointerOut);
    root.removeEventListener("pointerdown", onPointerDown);
    root.removeEventListener("dragstart", onDragStart);
    root.removeEventListener("dragover", onDragOver);
    root.removeEventListener("dragleave", onDragLeave);
    root.removeEventListener("dragend", onDragEnd);
    root.removeEventListener("drop", onDrop);
    window.removeEventListener("keydown", onWindowKeyDown);
    window.removeEventListener("keyup", onWindowKeyUp);
  };
}

/**
 * Draws crisp directional SVG Bezier wires between Round output/input ports inside both `.rc-world`
 * (canvas world coordinates) and `.bkt-graph-canvas` (embedded read-only view).
 */
export function drawBracketWires(
  root: HTMLElement,
  race: RaceTournamentState,
  ui?: BracketEditorUiState
): void {
  const canvases = root.querySelectorAll<HTMLElement>("[data-bkt-graph]");
  canvases.forEach((canvas) => {
    const svg = canvas.querySelector<SVGSVGElement>("svg.bkt-wires");
    const handlesLayer = canvas.querySelector<HTMLElement>("[data-bkt-wire-handles]");
    if (!svg || svg.hasAttribute("hidden")) return;

    const isRcWorld = canvas.hasAttribute("data-rc-world");
    const rect = canvas.getBoundingClientRect();
    if (!isRcWorld && (rect.width <= 0 || rect.height <= 0)) {
      return;
    }

    if (!isRcWorld) {
      const w = Math.max(rect.width, canvas.scrollWidth);
      const h = Math.max(rect.height, canvas.scrollHeight);
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      svg.setAttribute("width", String(w));
      svg.setAttribute("height", String(h));
    } else {
      svg.removeAttribute("viewBox");
    }

    const viewStage = Number(canvas.dataset.bktViewStage) || race.activeStageIndex || 1;
    const anyDownstreamStarted = anyDownstreamStageStarted(race, viewStage);
    const curStgObj = race.stages?.find((s) => s.index === viewStage);
    const stageSeededNow = curStgObj
      ? !!curStgObj.prerequisitesMet
      : !!(race.qualifyingComplete || race.stage2SeededEarly);
    const editableActive =
      isRcWorld &&
      canvas.dataset.bktEditable === "1" &&
      race.lifecycle !== "completed" &&
      race.lifecycle !== "scrapped";
    const stageHeats = race.heats.filter((ht) => ht.stageIndex === viewStage);
    const { rounds: stageRounds, heatsByRound } = resolveStageRounds(
      race,
      viewStage,
      stageHeats,
      isRcWorld || isRootStage(race, viewStage)
    );
    const stageConnections = resolveStageConnections(race, viewStage, stageRounds, heatsByRound);

    const canonicalRounds = stageRounds;
    const canonicalHeatsByRound = heatsByRound;
    const canonicalConnections = stageConnections;

    // Refine auto-positioned (`!hasPos`) nodes using exact measured DOM card heights so
    // two-lane / single-lane vertical centerlines align to 0.0px without estimation drift.
    const isControlCanvas = isRcWorld && !!canvas.closest(".is-control-canvas");
    const nodeEls = Array.from(canvas.querySelectorAll<HTMLElement>("[data-round-node]"));
    if (isRcWorld) {
      for (const el of nodeEls) {
        if (el.dataset.basePosX === undefined || el.dataset.basePosY === undefined) {
          const initPos = readNodeWorldPos(el);
          el.dataset.basePosX = String(initPos.x);
          el.dataset.basePosY = String(initPos.y);
        }
      }
    }
    if (isRcWorld && !ui?.activeGesture) {
      const hasAutoNodes = stageRounds.some(
        (r) => !r.hasPos && !ui?.optimisticPositions.has(r.id)
      );
      if (hasAutoNodes && nodeEls.length > 0) {
        const measuredHeights = new Map<string, number>();
        for (const el of nodeEls) {
          const rid = el.dataset.roundNode ?? "";
          if (rid && el.offsetHeight > 40) {
            measuredHeights.set(rid, el.offsetHeight);
          }
        }
        if (measuredHeights.size > 0) {
          const refined = computeRoundPositions(
            canonicalRounds,
            canonicalHeatsByRound,
            race.config.pilotsPerHeat || 4,
            ui,
            canonicalConnections,
            measuredHeights
          );
          for (const el of nodeEls) {
            const rid = el.dataset.roundNode ?? "";
            const rMeta = stageRounds.find((sr) => sr.id === rid);
            if (!rMeta || rMeta.hasPos || ui?.optimisticPositions.has(rid)) continue;
            const pos = refined.get(rid);
            if (pos) {
              el.dataset.basePosX = String(pos.x);
              el.dataset.basePosY = String(pos.y);
              if (!isControlCanvas) {
                setNodeWorldPos(el, pos.x, pos.y);
              }
            }
          }
        }
      }
    }

    // In Control mode, place Stage nodes in the Lower Zone strictly below the horizontal
    // dashed boundary line (`boundaryY`), preserving 1:1 X and relative Y coordinates with Stage Edit!
    if (isControlCanvas && !ui?.activeGesture) {
      const visiblePanels = Array.from(
        canvas.querySelectorAll<HTMLElement>(".rc-canvas-panel[data-canvas-panel]:not([hidden])")
      );
      let maxPanelBottom = -Infinity;
      let minPanelX = Infinity;
      for (const p of visiblePanels) {
        const { x, y } = readNodeWorldPos(p);
        const h = p.offsetHeight || 260;
        if (y + h > maxPanelBottom) maxPanelBottom = y + h;
        const pid = p.dataset.canvasPanel;
        if (pid === "cockpit" || pid === "schedule" || pid === "standings") {
          if (x < minPanelX) minPanelX = x;
        }
      }

      let boundaryY = Number(canvas.dataset.controlBoundaryY) || 0;
      if (boundaryY <= 0) {
        boundaryY = Math.round(
          Math.max(
            DEFAULT_CONTROL_MIN_BOUNDARY_Y,
            Number.isFinite(maxPanelBottom) ? maxPanelBottom + 56 : DEFAULT_CONTROL_MIN_BOUNDARY_Y
          )
        );
        canvas.dataset.controlBoundaryY = String(boundaryY);
      }

      const dividerEl = canvas.querySelector<HTMLElement>("[data-rc-control-divider]");
      if (dividerEl) {
        const badgeLeft = Number.isFinite(minPanelX) ? minPanelX : 64;
        dividerEl.style.transform = `translate3d(0px, ${boundaryY}px, 0)`;
        const badgesEl = dividerEl.querySelector<HTMLElement>(".rc-control-stage-divider-badges");
        if (badgesEl) {
          badgesEl.style.transform = `translate3d(${badgeLeft}px, 0px, 0)`;
        }
      }

      if (nodeEls.length > 0) {
        let stageFloorY: number;
        if (canvas.dataset.stageFloorY !== undefined) {
          stageFloorY = Number(canvas.dataset.stageFloorY) || 0;
        } else {
          let minBaseY = 0;
          for (const el of nodeEls) {
            const by = Number(el.dataset.basePosY);
            if (Number.isFinite(by) && by < minBaseY) {
              minBaseY = by;
            }
          }
          stageFloorY = Math.min(0, minBaseY);
          canvas.dataset.stageFloorY = String(stageFloorY);
        }
        const stageOffsetY = boundaryY + CONTROL_STAGE_TOP_CLEARANCE - stageFloorY;
        canvas.dataset.stageOffsetY = String(stageOffsetY);

        for (const el of nodeEls) {
          const bx = Number(el.dataset.basePosX);
          const by = Number(el.dataset.basePosY);
          const fallback = readNodeWorldPos(el);
          const nx = Number.isFinite(bx) ? bx : fallback.x;
          const ny = (Number.isFinite(by) ? by : fallback.y) + stageOffsetY;
          setNodeWorldPos(el, Math.round(nx * 10) / 10, Math.round(ny * 10) / 10);
        }
      }
    }

    const boxes = new Map<string, NodeWorldBox>();
    const portsByRound = new Map<string, CachedNodePorts>();
    nodeEls.forEach((el) => {
      const rid = el.dataset.roundNode ?? "";
      if (!rid) return;
      const lane = el.dataset.roundLane || "winners";
      if (isRcWorld) {
        const { x, y } = readNodeWorldPos(el);
        boxes.set(rid, {
          id: rid,
          lane,
          x,
          y,
          w: el.offsetWidth || RC_NODE_WIDTH,
          h: el.offsetHeight || 220,
          el,
        });
      } else {
        const nr = el.getBoundingClientRect();
        boxes.set(rid, {
          id: rid,
          lane,
          x: nr.left - rect.left + canvas.scrollLeft,
          y: nr.top - rect.top + canvas.scrollTop,
          w: nr.width,
          h: nr.height,
          el,
        });
      }
      portsByRound.set(rid, {
        inLeft: el.querySelector<HTMLElement>("[data-port-side='left']"),
        inTop: el.querySelector<HTMLElement>("[data-port-side='top']"),
        inBottom: el.querySelector<HTMLElement>("[data-port-side='bottom']"),
        outRight: el.querySelector<HTMLElement>("[data-port-dir='right']"),
        outBottom: el.querySelector<HTMLElement>("[data-port-dir='bottom']"),
      });
    });

    const pillsByConn = new Map<string, HTMLElement>();
    canvas.querySelectorAll<HTMLElement>("[data-wire-pill]").forEach((pEl) => {
      const cid = pEl.dataset.wirePill ?? "";
      if (cid) pillsByConn.set(cid, pEl);
    });

    updateCanvasWiresFromBoxes(
      svg,
      handlesLayer,
      boxes,
      portsByRound,
      pillsByConn,
      stageConnections,
      heatsByRound,
      editableActive,
      stageSeededNow,
      anyDownstreamStarted
    );
  });
}
