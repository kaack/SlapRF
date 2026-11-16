import { buildStageNetworkGraph } from "../core/connection_graph";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ApiClient } from "../services/api_client";
import {
  EventPilot,
  RaceStage,
  RaceTournamentState,
  StageConnection,
  StageConnectionMode,
  StageFormat,
  StagePositionEntry,
} from "../types/models";
import {
  anyDownstreamStageStarted,
  applyCanvasCameraDom,
  BracketEditorUiState,
  formatRaceClock,
  formatStageLabel,
  isHandoffPortalRound,
  isHeatCompletedOrRunning,
  isHeatUnstarted,
} from "./BracketDiagram";
import {
  openStageConnectionModal,
  openStageSettingsModal,
} from "./RoundModals";
import { notifyNewlyInvalidStageConnections, showToast } from "./Toast";
import {
  dismissWireDropMenu,
  flashSpawnedCanvasNode,
  openWireDropMenu,
  WireDropOption,
} from "./WireDropMenu";

export const FMT_NODE_WIDTH = 304;
const FMT_ORIGIN_X = 120;
const FMT_ORIGIN_Y = 120;
const FMT_COL_GAP_X = 430;
const FMT_ROW_GAP_Y = 250;
const FMT_CENTER_Y = 230;
const FMT_PORT_SNAP_RADIUS_PX = 38;

type PortSide = "left" | "right" | "top" | "bottom";
type OutputPortDir = "right" | "bottom";

function buildFormatWireDropOptions(
  fromStage: RaceStage | undefined,
  portDir: OutputPortDir
): WireDropOption[] {
  const fmt = fromStage?.format ?? "qualifying";
  if (fmt === "qualifying" || fmt === "open_qualifier") {
    return [
      {
        id: "double_elimination",
        label: "Double Elimination",
        iconHtml: icons.bracket(16),
        title: "Connect to a new Double Elimination stage",
      },
      {
        id: "single_elimination",
        label: "Single Elimination",
        iconHtml: icons.checkered(16),
        title: "Connect to a new Single Elimination stage",
      },
      {
        id: "points_mains",
        label: "Points / Mains",
        iconHtml: icons.trophy(16),
        title: "Connect to a new Points / A-B-C Mains stage",
      },
      {
        id: "custom",
        label: "Custom Stage",
        iconHtml: icons.plus(16),
        title: "Connect to a new blank Custom stage",
      },
    ];
  }
  if (portDir === "bottom") {
    return [
      {
        id: "single_elimination",
        label: "Single Elimination",
        iconHtml: icons.checkered(16),
        title: "Branch into a new Single Elimination stage",
      },
      {
        id: "points_mains",
        label: "Points / Mains",
        iconHtml: icons.trophy(16),
        title: "Branch into a new Points / B-Main stage",
      },
      {
        id: "double_elimination",
        label: "Double Elimination",
        iconHtml: icons.bracket(16),
        title: "Branch into a new Double Elimination stage",
      },
      {
        id: "custom",
        label: "Custom Stage",
        iconHtml: icons.plus(16),
        title: "Branch into a new Custom stage",
      },
    ];
  }
  return [
    {
      id: "double_elimination",
      label: "Double Elimination",
      iconHtml: icons.bracket(16),
      title: "Connect to a new Double Elimination stage",
    },
    {
      id: "single_elimination",
      label: "Single Elimination",
      iconHtml: icons.checkered(16),
      title: "Connect to a new Single Elimination stage",
    },
    {
      id: "points_mains",
      label: "Points / Mains",
      iconHtml: icons.trophy(16),
      title: "Connect to a new Points / Mains stage",
    },
    {
      id: "custom",
      label: "Custom Stage",
      iconHtml: icons.plus(16),
      title: "Connect to a new Custom stage",
    },
  ];
}

export interface FormatRenderOptions {
  editable: boolean;
  editorUi: BracketEditorUiState;
}

export interface FormatEventCallbacks {
  onOpenStageEdit: (stageIndex: number) => void;
  onDeleteStage: (stage: RaceStage) => void;
  onError?: (msg: string) => void;
}

interface StageWorldBox {
  id: string;
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  el: HTMLElement;
}

interface CachedStagePorts {
  inLeft: HTMLElement | null;
  inTop: HTMLElement | null;
  inBottom: HTMLElement | null;
  outRight: HTMLElement | null;
  outBottom: HTMLElement | null;
}

interface ConnectedStagePortSet {
  inLeft: boolean;
  inTop: boolean;
  inBottom: boolean;
  outRight: boolean;
  outBottom: boolean;
}

export function resolveStagesList(race: RaceTournamentState): RaceStage[] {
  if (race.stages && race.stages.length > 0) {
    return [...race.stages].sort((a, b) => a.index - b.index);
  }
  if (!race.generated) {
    return [];
  }
  const count = Math.max(1, race.totalStages || 1);
  const out: RaceStage[] = [];
  for (let i = 1; i <= count; i++) {
    out.push({
      id: `stage-${i}`,
      index: i,
      title: i === 1 && race.config.hasQualifying ? "Qualifying" : `Stage ${i}`,
      format:
        i === 1 && race.config.hasQualifying
          ? "qualifying"
          : race.config.mainFormat || "single_elimination",
      settings: {
        pilotsPerHeat: race.config.pilotsPerHeat || 4,
        seatChannels: race.config.seatChannels ?? [1, 3, 5, 8],
        targetLaps: race.config.targetLaps || 3,
        timeLimitSec: race.config.timeLimitSec || 120,
        qualifyingRounds: race.config.qualifyingRounds || 2,
        qualifyingMetric: race.config.qualifyingMetric || "consecutive_3",
        pointsRounds: race.config.pointsRounds || 3,
        finalsFormat: race.config.finalsFormat || "single_final",
        aceWinsRequired: race.config.aceWinsRequired || 2,
        winnersAdvantageAce: !!race.config.winnersAdvantageAce,
      },
      status:
        race.lifecycle === "completed" || race.isComplete
          ? "completed"
          : race.activeStageIndex === i
            ? "active"
            : "ready",
      prerequisitesMet: i === 1 || !!(race.qualifyingComplete || race.stage2SeededEarly),
    });
  }
  return out;
}

function estimateStageNodeHeight(stage: RaceStage): number {
  const hasBanner =
    !!stage.dangling ||
    (!stage.prerequisitesMet && (stage.waitingOnStageNames?.length ?? 0) > 0);
  return hasBanner ? 228 : 196;
}

export function computeStagePositions(
  stages: RaceStage[],
  stageConnections: StageConnection[],
  ui?: BracketEditorUiState,
  measuredHeights?: Map<string, number>
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (stages.length === 0) return out;

  const inAdj = new Map<number, number[]>();
  const outAdj = new Map<number, number[]>();
  for (const sc of stageConnections) {
    if (sc.invalid || sc.fromStageIndex <= 0 || sc.toStageIndex <= 0) continue;
    const prev = inAdj.get(sc.toStageIndex) ?? [];
    prev.push(sc.fromStageIndex);
    inAdj.set(sc.toStageIndex, prev);

    const nxt = outAdj.get(sc.fromStageIndex) ?? [];
    nxt.push(sc.toStageIndex);
    outAdj.set(sc.fromStageIndex, nxt);
  }

  // Kahn's topological order for clean DAG column assignment
  const indeg = new Map<number, number>();
  for (const stg of stages) {
    indeg.set(stg.index, (inAdj.get(stg.index) ?? []).length);
  }
  const queue = stages
    .filter((s) => (indeg.get(s.index) ?? 0) === 0)
    .map((s) => s.index)
    .sort((a, b) => a - b);
  const topo: number[] = [];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    topo.push(cur);
    for (const dst of outAdj.get(cur) ?? []) {
      const nextDeg = (indeg.get(dst) ?? 1) - 1;
      indeg.set(dst, nextDeg);
      if (nextDeg <= 0 && !seen.has(dst)) {
        queue.push(dst);
        queue.sort((a, b) => a - b);
      }
    }
  }
  for (const stg of stages) {
    if (!seen.has(stg.index)) topo.push(stg.index);
  }

  const depthByIdx = new Map<number, number>();
  let maxDepth = 0;
  for (const idx of topo) {
    let d = 0;
    for (const up of inAdj.get(idx) ?? []) {
      const cand = (depthByIdx.get(up) ?? 0) + 1;
      if (cand > d) d = cand;
    }
    depthByIdx.set(idx, d);
    if (d > maxDepth) maxDepth = d;
  }

  const byDepth = new Map<number, RaceStage[]>();
  for (const stg of stages) {
    const d = depthByIdx.get(stg.index) ?? Math.max(0, stg.index - 1);
    const grp = byDepth.get(d) ?? [];
    grp.push(stg);
    byDepth.set(d, grp);
  }

  for (let d = 0; d <= maxDepth; d++) {
    const grp = (byDepth.get(d) ?? []).sort((a, b) => a.index - b.index);
    if (grp.length === 0) continue;
    const heights = grp.map(
      (s) => measuredHeights?.get(s.id) ?? estimateStageNodeHeight(s)
    );
    const gapY = 56;
    const totalStackH =
      heights.reduce((acc, h) => acc + h, 0) + Math.max(0, grp.length - 1) * gapY;
    let curY = Math.max(84, FMT_CENTER_Y + 90 - totalStackH / 2);

    grp.forEach((stg, i) => {
      const opt = ui?.optimisticPositions.get(stg.id);
      if (opt) {
        out.set(stg.id, { x: opt.x, y: opt.y });
      } else if (stg.hasPos) {
        out.set(stg.id, {
          x: typeof stg.posX === "number" ? stg.posX : 0,
          y: typeof stg.posY === "number" ? stg.posY : 0,
        });
      } else {
        out.set(stg.id, {
          x: Math.round(FMT_ORIGIN_X + d * FMT_COL_GAP_X),
          y: Math.round(curY),
        });
      }
      curY += heights[i] + gapY;
    });
  }

  return out;
}

export function suggestNewStageSpawnPosition(
  race: RaceTournamentState,
  ui?: BracketEditorUiState
): { x: number; y: number } {
  const stages = resolveStagesList(race);
  if (stages.length === 0) {
    return { x: FMT_ORIGIN_X, y: FMT_CENTER_Y };
  }
  const posMap = computeStagePositions(stages, race.stageConnections ?? [], ui);
  let maxX = FMT_ORIGIN_X;
  let refY = FMT_CENTER_Y;
  for (const stg of stages) {
    const p = posMap.get(stg.id);
    if (p && p.x >= maxX) {
      maxX = p.x;
      refY = p.y;
    }
  }
  return {
    x: Math.round(maxX + FMT_COL_GAP_X),
    y: Math.round(refY),
  };
}

export function collectFormatStagePositions(
  targetOrRoot: Element | null,
  race: RaceTournamentState,
  ui?: BracketEditorUiState
): StagePositionEntry[] {
  const stages = resolveStagesList(race);
  if (stages.length === 0) return [];
  const computed = computeStagePositions(stages, race.stageConnections ?? [], ui);
  const canvas =
    targetOrRoot?.closest<HTMLElement>("[data-fmt-graph]") ??
    targetOrRoot?.querySelector<HTMLElement>("[data-fmt-graph]") ??
    document.querySelector<HTMLElement>("[data-fmt-graph]");

  const domPos = new Map<string, { x: number; y: number }>();
  if (canvas) {
    canvas.querySelectorAll<HTMLElement>("[data-stage-node]").forEach((el) => {
      const sid = el.dataset.stageNode ?? "";
      const px = Number(el.dataset.posX);
      const py = Number(el.dataset.posY);
      if (sid && Number.isFinite(px) && Number.isFinite(py)) {
        domPos.set(sid, { x: px, y: py });
      }
    });
  }

  return stages.map((stg) => {
    const p =
      ui?.optimisticPositions.get(stg.id) ??
      domPos.get(stg.id) ??
      computed.get(stg.id) ?? { x: FMT_ORIGIN_X, y: FMT_CENTER_Y };
    return {
      stageId: stg.id,
      posX: Math.round(p.x * 10) / 10,
      posY: Math.round(p.y * 10) / 10,
    };
  });
}

export function fitCanvasToFormatStages(
  viewport: HTMLElement | null,
  race: RaceTournamentState,
  ui: BracketEditorUiState
): void {
  const stages = resolveStagesList(race);
  if (!viewport || stages.length === 0) {
    ui.panX = 72;
    ui.panY = 88;
    ui.zoom = 1;
    if (viewport) applyCanvasCameraDom(viewport, ui);
    return;
  }

  const vpRect = viewport.getBoundingClientRect();
  const vw = vpRect.width || 1100;
  const vh = vpRect.height || 680;
  const posMap = computeStagePositions(stages, race.stageConnections ?? [], ui);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const stg of stages) {
    const p = posMap.get(stg.id) ?? { x: FMT_ORIGIN_X, y: FMT_CENTER_Y };
    const el = viewport.querySelector<HTMLElement>(
      `[data-stage-node="${CSS.escape(stg.id)}"]`
    );
    const w = el?.offsetWidth || FMT_NODE_WIDTH;
    const h = el?.offsetHeight || estimateStageNodeHeight(stg);
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x + w > maxX) maxX = p.x + w;
    if (p.y + h > maxY) maxY = p.y + h;
  }

  const contentW = Math.max(280, maxX - minX);
  const contentH = Math.max(180, maxY - minY);
  const padLeft = 64;
  const padRight = 64;
  const padTop = 84;
  const padBottom = 88;

  const availW = Math.max(260, vw - padLeft - padRight);
  const availH = Math.max(200, vh - padTop - padBottom);
  const nextZoom = Math.max(0.45, Math.min(1.05, Math.min(availW / contentW, availH / contentH)));

  ui.zoom = Math.round(nextZoom * 1000) / 1000;
  ui.panX = Math.round(padLeft + (availW - contentW * ui.zoom) / 2 - minX * ui.zoom);
  ui.panY = Math.round(padTop + (availH - contentH * ui.zoom) / 2 - minY * ui.zoom);
  applyCanvasCameraDom(viewport, ui);
}

export function panFormatCanvasToStage(
  viewport: HTMLElement | null,
  race: RaceTournamentState,
  stageIndex: number,
  ui: BracketEditorUiState
): void {
  if (!viewport) return;
  const stages = resolveStagesList(race);
  const stg = stages.find((s) => s.index === stageIndex);
  if (!stg) return;
  const posMap = computeStagePositions(stages, race.stageConnections ?? [], ui);
  const p = posMap.get(stg.id);
  if (!p) return;
  const vpRect = viewport.getBoundingClientRect();
  const vw = vpRect.width || 1100;
  const vh = vpRect.height || 680;
  const z = ui.zoom || 1;
  const cardCx = p.x + FMT_NODE_WIDTH / 2;
  const cardCy = p.y + estimateStageNodeHeight(stg) / 2;
  ui.panX = Math.round(vw / 2 - cardCx * z);
  ui.panY = Math.round(vh / 2 - cardCy * z);
  applyCanvasCameraDom(viewport, ui);
}

function getValidTargetStageIds(
  stages: RaceStage[],
  _connections: StageConnection[],
  fromStageId: string,
  race: RaceTournamentState,
  excludeConnectionId = ""
): Set<string> {
  return buildStageNetworkGraph(stages, race, excludeConnectionId).getValidTargetIds(fromStageId);
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

function chooseStageConnectionSides(
  conn: StageConnection
): { fromSide: OutputPortDir; toSide: "left" | "top" | "bottom" } {
  const fromSide: OutputPortDir = conn.fromPort === "bottom" ? "bottom" : "right";
  const toSide: "left" | "top" | "bottom" =
    conn.toPort === "top" || conn.toPort === "bottom" ? conn.toPort : "left";
  return { fromSide, toSide };
}

function computeStageSideAnchor(
  box: StageWorldBox,
  side: PortSide,
  isInput: boolean
): { x: number; y: number } {
  switch (side) {
    case "left":
      return { x: box.x, y: box.y + box.h / 2 };
    case "right":
      return { x: box.x + box.w, y: box.y + box.h / 2 };
    case "top":
      return { x: box.x + box.w / 2, y: box.y };
    case "bottom":
      return {
        x: box.x + (isInput ? box.w * 0.36 : box.w * 0.64),
        y: box.y + box.h,
      };
  }
}

function buildDirectionalBezier(
  x1: number,
  y1: number,
  fromSide: PortSide,
  x2: number,
  y2: number,
  toSide: PortSide
): { d: string; c1x: number; c1y: number; c2x: number; c2y: number } {
  const n1 = sideOutwardNormal(fromSide);
  const n2 = sideOutwardNormal(toSide);
  const adx = Math.abs(x2 - x1);
  const ady = Math.abs(y2 - y1);
  const dist = Math.hypot(adx, ady);

  let lead1 = 56;
  let lead2 = 56;

  if (n1.nx !== 0 && n2.nx !== 0) {
    const forward = (x2 - x1) * n1.nx >= 0;
    const base = forward
      ? Math.max(54, adx * 0.46)
      : Math.max(90, Math.min(200, dist * 0.55));
    lead1 = base;
    lead2 = base;
  } else if (n1.ny !== 0 && n2.ny !== 0) {
    const downward = (y2 - y1) * n1.ny >= 0;
    const base = downward
      ? Math.max(48, Math.min(160, ady * 0.48 + adx * 0.08))
      : Math.max(84, Math.min(185, dist * 0.52));
    lead1 = base;
    lead2 = base;
  } else {
    lead1 = n1.nx !== 0 ? Math.max(54, adx * 0.54) : Math.max(50, ady * 0.54);
    lead2 = n2.nx !== 0 ? Math.max(54, adx * 0.54) : Math.max(50, ady * 0.54);
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

function evalCubicPoint(
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
  return {
    x:
      mt * mt * mt * x1 +
      3 * mt * mt * t * c1x +
      3 * mt * t * t * c2x +
      t * t * t * x2,
    y:
      mt * mt * mt * y1 +
      3 * mt * mt * t * c1y +
      3 * mt * t * t * c2y +
      t * t * t * y2,
  };
}

function computeEndpointHandlePos(
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
    let last = evalCubicPoint(0.12, x1, y1, c1x, c1y, c2x, c2y, x2, y2);
    for (let t = 0.03; t <= 0.36; t += 0.015) {
      const pt = evalCubicPoint(t, x1, y1, c1x, c1y, c2x, c2y, x2, y2);
      last = pt;
      if (Math.hypot(pt.x - x1, pt.y - y1) >= 28) return pt;
    }
    return last;
  }
  let last = evalCubicPoint(0.88, x1, y1, c1x, c1y, c2x, c2y, x2, y2);
  for (let t = 0.97; t >= 0.64; t -= 0.015) {
    const pt = evalCubicPoint(t, x1, y1, c1x, c1y, c2x, c2y, x2, y2);
    last = pt;
    if (Math.hypot(pt.x - x2, pt.y - y2) >= 28) return pt;
  }
  return last;
}

export function formatStageConnectionLabel(
  conn: StageConnection,
  activePilotCount: number
): string {
  if (conn.invalid) return "Invalid Link";
  if (conn.mode === "seed_range" && (conn.seedStart ?? 0) > 0) {
    const sStart = conn.seedStart || 1;
    const sEnd = conn.seedEnd && conn.seedEnd >= sStart ? conn.seedEnd : Math.max(sStart, activePilotCount);
    return `Seeds #${sStart}–#${sEnd}`;
  }
  if (conn.mode === "top_n" && (conn.count ?? 0) > 0) {
    return `Top ${conn.count}`;
  }
  return activePilotCount > 0 ? `All Pilots (${activePilotCount})` : "All Pilots";
}

function renderStageWireMenu(
  conn: StageConnection,
  activePilotCount: number
): string {
  const curKey =
    conn.mode === "top_n" && (conn.count ?? 0) > 0
      ? `top_n:${conn.count}:0`
      : conn.mode === "seed_range" && (conn.seedStart ?? 0) > 0
        ? `seed_range:${conn.seedStart}:${conn.seedEnd || 0}`
        : "all_pilots:0:0";

  const presets: Array<{ key: string; label: string }> = [
    {
      key: "all_pilots:0:0",
      label: activePilotCount > 0 ? `All Ranked Pilots (${activePilotCount})` : "All Ranked Pilots",
    },
    { key: "top_n:4:0", label: "Top 4 Seeds (#1–#4)" },
    { key: "top_n:8:0", label: "Top 8 Seeds (#1–#8)" },
    { key: "top_n:12:0", label: "Top 12 Seeds (#1–#12)" },
    { key: "top_n:16:0", label: "Top 16 Seeds (#1–#16)" },
    { key: "seed_range:5:8", label: "Seeds #5–#8 (Lower / B-Main)" },
    { key: "seed_range:9:12", label: "Seeds #9–#12 (C-Main)" },
  ];

  const invalidBanner = conn.invalid
    ? `<div class="bkt-wire-invalid-banner">
        ${icons.siren(13)}
        <span>${esc(conn.invalidReason || "Invalid stage link — reconnect or disconnect.")}</span>
      </div>`
    : "";

  return `
    <div class="bkt-wire-menu" role="menu" data-bkt-stop-select>
      ${invalidBanner}
      <div class="bkt-wire-menu-title">Pilot Advancement Slice</div>
      ${presets
        .map((p) => {
          const active = !conn.invalid && p.key === curKey;
          return `
            <button
              type="button"
              class="bkt-wire-menu-item ${active ? "is-selected" : ""}"
              data-fmt-wire-preset="${p.key}"
              data-conn-id="${esc(conn.id)}"
            >
              <span>${esc(p.label)}</span>
              ${active ? icons.check(12) : ""}
            </button>`;
        })
        .join("")}
      <div class="bkt-wire-menu-sep"></div>
      <button
        type="button"
        class="bkt-wire-menu-item"
        data-fmt-action="open_stage_conn_modal"
        data-conn-id="${esc(conn.id)}"
      >
        <span>Custom Slice &amp; Tiebreaker…</span>
        ${icons.sliders(12)}
      </button>
      <div class="bkt-wire-menu-sep"></div>
      <button
        type="button"
        class="bkt-wire-menu-item"
        data-fmt-action="disconnect_stages"
        data-conn-id="${esc(conn.id)}"
      >
        <span>Disconnect Stages</span>
        ${icons.trash(12)}
      </button>
    </div>`;
}

function renderFormatWirePillsOverlay(
  race: RaceTournamentState,
  stageConnections: StageConnection[],
  editableActive: boolean,
  activePilotCount: number,
  ui?: BracketEditorUiState
): string {
  return stageConnections
    .map((conn) => {
      const label = formatStageConnectionLabel(conn, activePilotCount);
      const isInvalid = !!conn.invalid;
      const targetStarted =
        !isInvalid &&
        race.heats.some((h) => h.stageIndex === conn.toStageIndex && !isHeatUnstarted(h.state));
      const canEdit = editableActive && (!targetStarted || isInvalid);
      const isOpen = canEdit && ui?.openWireMenuId === conn.id;

      if (!canEdit) {
        if (!isInvalid) {
          return "";
        }
        return `
          <div
            class="bkt-wire-pill-wrap is-readonly is-invalid is-portal-wire"
            data-wire-pill="${esc(conn.id)}"
            title="${esc(conn.invalidReason || "Invalid stage link")}"
          >
            <span class="bkt-wire-act-btn">${icons.siren(12)}</span>
          </div>`;
      }

      return `
        <div
          class="bkt-wire-pill-wrap is-portal-wire ${isInvalid ? "is-invalid" : ""} ${isOpen ? "is-open" : ""}"
          data-wire-pill="${esc(conn.id)}"
          data-bkt-stop-select
        >
          <button
            type="button"
            class="bkt-wire-act-btn ${isOpen ? "is-active" : ""}"
            data-fmt-ui="toggle-wire-menu"
            data-conn-id="${esc(conn.id)}"
            title="${esc(isInvalid ? conn.invalidReason || "Inspect invalid stage link" : `${label} — Stage connection settings`)}"
            aria-label="Stage connection settings (${esc(label)})"
            aria-expanded="${isOpen ? "true" : "false"}"
          >
            ${isInvalid ? icons.siren(13) : icons.settings(13)}
          </button>
          <button
            type="button"
            class="bkt-wire-act-btn"
            data-fmt-action="disconnect_stages"
            data-conn-id="${esc(conn.id)}"
            title="Disconnect stages"
            aria-label="Disconnect stages"
          >
            ${icons.close(13)}
          </button>
          ${isOpen ? renderStageWireMenu(conn, activePilotCount) : ""}
        </div>`;
    })
    .join("");
}

function renderStageStatusPill(stage: RaceStage): { label: string; cls: string } {
  if (stage.dangling) {
    return { label: "Disconnected", cls: "is-paused" };
  }
  switch (stage.status) {
    case "active":
      return { label: "Live", cls: "is-live" };
    case "paused":
      return { label: "Paused", cls: "is-paused" };
    case "completed":
      return { label: stage.completedEarly ? "Seeded Early ✓" : "Completed ✓", cls: "is-done" };
    case "ready":
      return { label: "Ready", cls: "is-ready" };
    default:
      return { label: "Waiting", cls: "is-waiting" };
  }
}

export function stageNeedsDeleteConfirmation(
  race: RaceTournamentState,
  stage: RaceStage
): boolean {
  if ((stage.status ?? "pending") !== "pending") return true;
  const hasStageConns = (race.stageConnections ?? []).some(
    (sc) => sc.fromStageId === stage.id || sc.toStageId === stage.id
  );
  if (hasStageConns) return true;

  const stageHeats = race.heats.filter((h) => h.stageIndex === stage.index);
  for (const h of stageHeats) {
    if (
      h.state !== "waiting" &&
      h.state !== "ready" &&
      h.state !== "staged"
    ) {
      return true;
    }
    if (h.seats.some((s) => (s.laps?.length ?? 0) > 0)) {
      return true;
    }
  }

  if (stage.format === "custom") {
    const hasCustomRounds = (race.rounds ?? []).some(
      (r) =>
        r.stageIndex === stage.index &&
        r.bracketLane !== "pilots_in" &&
        r.bracketLane !== "handoff_in" &&
        r.bracketLane !== "handoff_out"
    );
    return hasCustomRounds || stageHeats.length > 0;
  }

  if (stage.format === "open_qualifier") {
    if (stageHeats.length > 0 || stage.customized) return true;
  } else if (stage.customized) {
    return true;
  }

  const stgSettings = stage.settings;
  if (stgSettings) {
    const cfg = race.config;
    const defPph = cfg.pilotsPerHeat || 4;
    const defLaps = cfg.targetLaps || 3;
    const defTime = cfg.timeLimitSec || 120;
    if (stgSettings.pilotsPerHeat && stgSettings.pilotsPerHeat !== defPph) return true;
    if (stgSettings.targetLaps && stgSettings.targetLaps !== defLaps) return true;
    if (stgSettings.timeLimitSec && stgSettings.timeLimitSec !== defTime) return true;
    if (
      stage.format === "qualifying" &&
      stgSettings.qualifyingRounds &&
      stgSettings.qualifyingRounds !== (cfg.qualifyingRounds || 2)
    ) {
      return true;
    }
    if (
      stage.format === "points_mains" &&
      stgSettings.pointsRounds &&
      stgSettings.pointsRounds !== 3
    ) {
      return true;
    }
    if (
      stage.format === "chase_the_ace" &&
      stgSettings.aceWinsRequired &&
      stgSettings.aceWinsRequired !== (cfg.aceWinsRequired || 2)
    ) {
      return true;
    }
  }

  return false;
}

function renderStageCard(
  race: RaceTournamentState,
  stage: RaceStage,
  _totalStages: number,
  editableActive: boolean,
  validClickTargets: Set<string>,
  pos: { x: number; y: number },
  ui: BracketEditorUiState,
  portState: ConnectedStagePortSet
): string {
  const isSelected = ui.selectedRoundIds.has(stage.id);
  const isMenuOpen = ui.openNodeMenuId === stage.id;
  const isSourceActive = editableActive && ui.connectingFromRoundId === stage.id;
  const isSourceRight = isSourceActive && ui.connectingFromPortDir !== "bottom";
  const isSourceBottom = isSourceActive && ui.connectingFromPortDir === "bottom";
  const isClickTarget = editableActive && validClickTargets.has(stage.id);

  const stageHeats = race.heats.filter((h) => h.stageIndex === stage.index);
  const confirmedCount = stageHeats.filter((h) => h.state === "confirmed").length;
  const anyCompletedOrRunning = stageHeats.some((h) => isHeatCompletedOrRunning(h));
  const raceBlocked =
    Boolean(race.emergencyStopped) ||
    race.lifecycle === "paused" ||
    race.lifecycle === "scrapped" ||
    race.lifecycle === "completed";
  const hasDownstreamLink = (race.stageConnections ?? []).some(
    (sc) => sc.fromStageIndex === stage.index && !sc.invalid
  );
  const anyLiveHeatInStage = stageHeats.some(
    (h) => h.state === "running" || h.state === "countdown"
  );
  const canResumeStage = !raceBlocked && stage.status === "paused";
  const canCompleteEarly = Boolean(
    !raceBlocked &&
      stage.status === "active" &&
      confirmedCount > 0 &&
      confirmedCount < stageHeats.length &&
      hasDownstreamLink &&
      !anyDownstreamStageStarted(race, stage.index) &&
      !anyLiveHeatInStage
  );
  const canReopenEarly = Boolean(
    !raceBlocked &&
      stage.completedEarly &&
      !anyDownstreamStageStarted(race, stage.index)
  );
  const realRounds = (race.rounds ?? []).filter(
    (r) => r.stageIndex === stage.index && !isHandoffPortalRound(r.id)
  );
  const roundCount =
    realRounds.length ||
    new Set(stageHeats.map((h) => h.roundId || `${h.bracketLane}-${h.round}`)).size;

  const stgSettings = stage.settings ?? {
    pilotsPerHeat: race.config.pilotsPerHeat || 4,
    seatChannels: race.config.seatChannels ?? [1, 3, 5, 8],
    targetLaps: race.config.targetLaps || 3,
    timeLimitSec: race.config.timeLimitSec || 120,
    qualifyingRounds: race.config.qualifyingRounds || 2,
    qualifyingMetric: race.config.qualifyingMetric || "consecutive_3",
    pointsRounds: race.config.pointsRounds || 3,
    finalsFormat: race.config.finalsFormat || "single_final",
    aceWinsRequired: race.config.aceWinsRequired || 2,
    winnersAdvantageAce: !!race.config.winnersAdvantageAce,
  };

  const isOpenQualStage = stage.format === "open_qualifier";
  const isZippyQStage =
    isOpenQualStage &&
    ((stage.title || "").toLowerCase().includes("zippyq") ||
      Boolean(race.mgpLink?.isZippyQ && stage.index === 1));
  const isTimedStage = stage.format === "qualifying" || isOpenQualStage;
  const pph = stgSettings.pilotsPerHeat || race.config.pilotsPerHeat || 4;
  const laps = stgSettings.targetLaps ?? (isTimedStage ? 0 : 3);
  const timeSec = stgSettings.timeLimitSec || race.config.timeLimitSec || 120;
  const maxPacks = stgSettings.maxPacksPerPilot ?? race.config.maxPacksPerPilot ?? 0;
  const lapsText = isTimedStage && laps === 0 ? "Timed" : `${laps || 3} laps`;
  const metaSummaryText = isOpenQualStage
    ? `${pph} seats · ${maxPacks > 0 ? `Max ${maxPacks} heats` : "Unlimited heats"} · ${formatRaceClock(timeSec).slice(0, 5)}`
    : `${pph} seats · ${lapsText} · ${formatRaceClock(timeSec).slice(0, 5)}`;
  const statusPill = renderStageStatusPill(stage);
  const acceptsStageInputs = !isTimedStage;

  const inLeftPort =
    acceptsStageInputs || portState.inLeft
      ? `<span
          class="bkt-port is-in is-in-left ${portState.inLeft ? "has-wire" : ""} ${!editableActive && !portState.inLeft ? "is-hidden-port" : ""}"
          data-fmt-port="in"
          data-stage-in="${esc(stage.id)}"
          data-port-kind="in"
          data-port-side="left"
          data-bkt-stop-select
          title="${isClickTarget ? `Connect into ${esc(stage.title)} (left)` : "Incoming stage advancement (left)"}"
        >
          <span class="bkt-port-handle">${icons.chevronRight(10)}</span>
        </span>`
      : "";

  const inTopPort =
    acceptsStageInputs || portState.inTop
      ? `<span
          class="bkt-port is-in is-in-top ${portState.inTop ? "has-wire" : ""} ${!editableActive && !portState.inTop ? "is-hidden-port" : ""}"
          data-fmt-port="in"
          data-stage-in-top="${esc(stage.id)}"
          data-port-kind="in"
          data-port-side="top"
          data-bkt-stop-select
          title="${isClickTarget ? `Connect into ${esc(stage.title)} (top)` : "Incoming stage advancement (top)"}"
        >
          <span class="bkt-port-handle">${icons.chevronDown(10)}</span>
        </span>`
      : "";

  const inBottomPort =
    acceptsStageInputs || portState.inBottom
      ? `<span
          class="bkt-port is-in is-in-bottom is-aux-bottom ${portState.inBottom ? "has-wire" : ""} ${!editableActive && !portState.inBottom ? "is-hidden-port" : ""}"
          data-fmt-port="in"
          data-stage-in-bottom="${esc(stage.id)}"
          data-port-kind="in"
          data-port-side="bottom"
          data-bkt-stop-select
          title="${isClickTarget ? `Connect into ${esc(stage.title)} (bottom)` : "Incoming stage advancement (bottom)"}"
        >
          <span class="bkt-port-handle">${icons.chevronUp(10)}</span>
        </span>`
      : "";

  const outRightPort = editableActive
    ? `<button
        type="button"
        class="bkt-port is-out is-out-right ${portState.outRight ? "has-wire" : ""} ${isSourceRight ? "is-active" : ""}"
        data-fmt-port="out"
        data-stage-out="${esc(stage.id)}"
        data-port-kind="out"
        data-port-side="right"
        data-port-dir="right"
        data-bkt-stop-select
        title="Stage Output — drag to connect into a downstream stage"
      >
        <span class="bkt-port-handle">${icons.chevronRight(10)}</span>
      </button>`
    : `<span
        class="bkt-port is-out is-out-right ${portState.outRight ? "has-wire" : "is-hidden-port"}"
        data-fmt-port="out"
        data-port-kind="out"
        data-port-side="right"
        data-port-dir="right"
      >
        <span class="bkt-port-handle">${icons.chevronRight(10)}</span>
      </span>`;

  const outBottomPort = portState.outBottom
    ? `<span
        class="bkt-port is-out is-out-bottom has-wire ${isSourceBottom ? "is-active" : ""}"
        data-fmt-port="out"
        data-port-kind="out"
        data-port-side="bottom"
        data-port-dir="bottom"
      >
        <span class="bkt-port-handle">${icons.chevronDown(10)}</span>
      </span>`
    : "";

  const dependencyCallout = stage.dangling
    ? `<div class="fmt-stage-callout is-warn">
        ${icons.siren(12)}
        <span>${esc(stage.danglingReason || "Disconnected stage — connect from an earlier stage or delete.")}</span>
      </div>`
    : !stage.prerequisitesMet && (stage.waitingOnStageNames?.length ?? 0) > 0
      ? `<div class="fmt-stage-callout is-waiting">
          ${icons.timer(12)}
          <span>Waiting on <strong>${esc(stage.waitingOnStageNames!.join(", "))}</strong></span>
        </div>`
      : stage.index === 1 || !(race.stageConnections ?? []).some((sc) => sc.toStageIndex === stage.index && !sc.invalid)
        ? `<div class="fmt-stage-callout is-entry">
            ${icons.pilot(11)}
            <span>Entry stage · Seeds checked-in race pilots</span>
          </div>`
        : "";

  const stageOverrideItems: string[] = [];
  if (canResumeStage) {
    stageOverrideItems.push(
      `<button type="button" class="bkt-node-menu-item" role="menuitem" data-stage-ctrl="resume_stage" data-stage-idx="${stage.index}" data-stage-id="${esc(stage.id)}">
        ${icons.play(14)}<span>Resume Stage</span>
      </button>`
    );
  }
  if (canReopenEarly) {
    stageOverrideItems.push(
      `<button type="button" class="bkt-node-menu-item" role="menuitem" data-stage-ctrl="reopen_stage_early" data-stage-idx="${stage.index}" data-stage-id="${esc(stage.id)}">
        ${icons.unlock(14)}<span>Reopen Stage</span>
      </button>`
    );
  } else if (canCompleteEarly) {
    stageOverrideItems.push(
      `<button type="button" class="bkt-node-menu-item" role="menuitem" data-stage-ctrl="complete_stage_early" data-stage-idx="${stage.index}" data-stage-id="${esc(stage.id)}" title="Finalize current standings and seed downstream stages now">
        ${icons.zap(14)}<span>Complete Early &amp; Seed</span>
      </button>`
    );
  }

  const stageMenuHtml = isMenuOpen
    ? `<div class="bkt-node-menu" role="menu" data-bkt-stop-select>
        ${
          editableActive
            ? `<button type="button" class="bkt-node-menu-item" role="menuitem" data-fmt-action="open_stage_settings" data-stage-index="${stage.index}">
                ${icons.sliders(14)}<span>Stage Settings</span>
              </button>`
            : ""
        }
        <button type="button" class="bkt-node-menu-item" role="menuitem" data-fmt-action="open_stage_edit" data-stage-index="${stage.index}">
          ${icons.arrowRight(14)}<span>Open Rounds &amp; Pilots</span>
        </button>
        ${
          stageOverrideItems.length > 0
            ? `<div class="bkt-node-menu-sep" role="separator"></div>${stageOverrideItems.join("")}`
            : ""
        }
        ${
          editableActive
            ? `<div class="bkt-node-menu-sep" role="separator"></div>
               <button
                 type="button"
                 class="bkt-node-menu-item"
                 role="menuitem"
                 data-fmt-action="delete_stage"
                 data-stage-id="${esc(stage.id)}"
                 data-stage-index="${stage.index}"
                 ${anyCompletedOrRunning ? "disabled" : ""}
                 title="${anyCompletedOrRunning ? "Cannot delete a stage with completed or running heats" : `Delete ${esc(stage.title)}`}"
               >
                 ${icons.trash(14)}<span>Delete Stage</span>
               </button>`
            : ""
        }
      </div>`
    : "";

  return `
    <div
      class="fmt-stage-node is-rc-node ${stage.status === "active" ? "is-live-stage" : ""} ${stage.dangling ? "is-dangling-stage" : ""} ${editableActive ? "is-editable-node" : ""} ${isSelected ? "is-selected-node" : ""} ${isMenuOpen ? "has-open-menu" : ""} ${isSourceActive ? "is-wire-source" : ""} ${isClickTarget ? "is-wire-candidate" : ""}"
      data-stage-node="${esc(stage.id)}"
      data-stage-index="${stage.index}"
      data-pos-x="${pos.x}"
      data-pos-y="${pos.y}"
      style="left:0;top:0;width:${FMT_NODE_WIDTH}px;transform:translate3d(${pos.x}px,${pos.y}px,0)"
    >
      ${inLeftPort}
      ${inTopPort}
      ${inBottomPort}
      ${outRightPort}
      ${outBottomPort}

      <div class="bkt-round-head is-draggable-head fmt-stage-head" data-stage-drag-handle="${esc(stage.id)}" data-bkt-stop-select title="Drag to move stage · Double-click to edit stage rounds">
        <div class="bkt-round-head-top">
          <div class="bkt-round-title-wrap">
            <span class="bkt-node-drag-grip">${icons.grip(13)}</span>
            <span class="bkt-portal-badge">S${stage.index}</span>
            <strong class="bkt-round-title-static">${esc(stage.title)}</strong>
          </div>
          <div class="bkt-round-head-btns">
            <span class="race-state-pill ${statusPill.cls}">${esc(statusPill.label)}</span>
            ${
              editableActive
                ? `<button
                    type="button"
                    class="bkt-node-delete-btn"
                    data-fmt-action="delete_stage"
                    data-stage-id="${esc(stage.id)}"
                    data-stage-index="${stage.index}"
                    ${anyCompletedOrRunning ? "disabled" : ""}
                    aria-label="Delete ${esc(stage.title)}"
                    title="${anyCompletedOrRunning ? "Cannot delete a stage with completed or running heats" : `Delete ${esc(stage.title)}`}"
                  >
                    ${icons.trash(13)}
                  </button>`
                : ""
            }
            <button
              type="button"
              class="bkt-node-hamburger ${isMenuOpen ? "is-open" : ""}"
              data-fmt-ui="toggle-stage-menu"
              data-stage-id="${esc(stage.id)}"
              aria-label="Stage options menu"
              aria-expanded="${isMenuOpen ? "true" : "false"}"
              title="Stage options &amp; actions"
            >
              ${icons.menu(14)}
            </button>
          </div>
        </div>
        <div class="bkt-round-meta-pills">
          <span class="bkt-meta-pill is-fmt-kind">${esc(isZippyQStage ? "ZippyQ Qualifier" : formatStageLabel(stage.format))}</span>
          <span class="bkt-meta-pill">${esc(metaSummaryText)}</span>
        </div>
        ${stageMenuHtml}
      </div>

      ${
        isClickTarget
          ? `<button
              type="button"
              class="bkt-connect-target-bar"
              data-fmt-action="complete_stage_connect"
              data-to-stage-id="${esc(stage.id)}"
              data-bkt-stop-select
            >
              ${icons.link(12)}<span>Connect into ${esc(stage.title)}</span>
            </button>`
          : ""
      }

      <div class="fmt-stage-body">
        <div class="fmt-stage-stats">
          ${
            isOpenQualStage && roundCount <= 1
              ? `<span><strong>${isZippyQStage ? "ZippyQ Qualifier" : "Open Qualifier"}</strong></span>
                 <span class="fmt-dot">·</span>
                 <span><strong>${confirmedCount}/${stageHeats.length}</strong> heats confirmed</span>`
              : `<span><strong>${roundCount}</strong> round${roundCount === 1 ? "" : "s"}</span>
                 <span class="fmt-dot">·</span>
                 <span><strong>${confirmedCount}/${stageHeats.length}</strong> heats confirmed</span>`
          }
        </div>
        ${dependencyCallout}
      </div>
      <div class="fmt-stage-actions" data-bkt-stop-select>
        ${
          editableActive
            ? `<button
                type="button"
                class="btn btn-ghost btn-sm fmt-stage-action-btn"
                data-fmt-action="open_stage_settings"
                data-stage-index="${stage.index}"
                title="Configure Stage ${stage.index} seats, channels, laps &amp; rules"
              >
                ${icons.sliders(17)}<span>Settings</span>
              </button>`
            : ""
        }
        <button
          type="button"
          class="btn btn-ghost btn-sm fmt-stage-action-btn"
          data-fmt-action="open_stage_edit"
          data-stage-index="${stage.index}"
          title="Open Stage ${stage.index} rounds &amp; pilots (or double-click stage)"
        >
          <span>Rounds</span>${icons.arrowRight(17)}
        </button>
      </div>
    </div>`;
}

export function renderFormatMarkup(
  race: RaceTournamentState,
  opts: FormatRenderOptions
): string {
  const editableActive =
    opts.editable && race.lifecycle !== "completed" && race.lifecycle !== "scrapped";
  const ui = opts.editorUi;
  const stages = resolveStagesList(race);
  const stageConnections = race.stageConnections ?? [];
  const activePilots: EventPilot[] = (race.roster ?? []).filter(
    (p) => p.checkedIn && p.attendance === "active"
  );

  const positions = computeStagePositions(stages, stageConnections, ui);
  const validClickTargets =
    editableActive && ui.connectingFromRoundId
      ? getValidTargetStageIds(stages, stageConnections, ui.connectingFromRoundId, race)
      : new Set<string>();

  const estBoxes = new Map<string, StageWorldBox>();
  const portStates = new Map<string, ConnectedStagePortSet>();
  for (const stg of stages) {
    const p = positions.get(stg.id) ?? { x: FMT_ORIGIN_X, y: FMT_CENTER_Y };
    estBoxes.set(stg.id, {
      id: stg.id,
      index: stg.index,
      x: p.x,
      y: p.y,
      w: FMT_NODE_WIDTH,
      h: estimateStageNodeHeight(stg),
      el: null as unknown as HTMLElement,
    });
    portStates.set(stg.id, {
      inLeft: false,
      inTop: false,
      inBottom: false,
      outRight: false,
      outBottom: false,
    });
  }

  for (const conn of stageConnections) {
    const fb = estBoxes.get(conn.fromStageId);
    const tb = estBoxes.get(conn.toStageId);
    if (!fb || !tb) continue;
    const { fromSide, toSide } = chooseStageConnectionSides(conn);
    const fp = portStates.get(conn.fromStageId);
    const tp = portStates.get(conn.toStageId);
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

  const nodesMarkup = stages
    .map((stg) =>
      renderStageCard(
        race,
        stg,
        stages.length,
        editableActive,
        validClickTargets,
        positions.get(stg.id) ?? { x: FMT_ORIGIN_X, y: FMT_CENTER_Y },
        ui,
        portStates.get(stg.id)!
      )
    )
    .join("");

  const wirePillsHtml = renderFormatWirePillsOverlay(
    race,
    stageConnections,
    editableActive,
    activePilots.length,
    ui
  );

  const panX = ui.panX ?? 72;
  const panY = ui.panY ?? 88;
  const zoom = ui.zoom ?? 1;

  return `
    <div
      class="rc-world"
      data-rc-world
      data-fmt-graph
      data-fmt-editable="${editableActive ? "1" : "0"}"
      style="transform:translate3d(${panX}px, ${panY}px, 0) scale(${zoom});transform-origin:0 0"
    >
      <svg class="bkt-wires is-rc-wires" aria-hidden="true"></svg>
      <div class="rc-nodes">${nodesMarkup}</div>
      <div class="bkt-wire-handles" data-fmt-wire-handles></div>
      <div class="bkt-wire-pills" data-fmt-wire-pills>${wirePillsHtml}</div>
    </div>
    <div class="rc-marquee" data-rc-marquee hidden></div>`;
}

function updateFormatWiresFromBoxes(
  svg: SVGSVGElement,
  handlesLayer: HTMLElement | null,
  boxes: Map<string, StageWorldBox>,
  portsByStage: Map<string, CachedStagePorts>,
  pillsByConn: Map<string, HTMLElement>,
  stageConnections: StageConnection[],
  race: RaceTournamentState,
  editableActive: boolean
): void {
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

  const activeInLeft = new Set<string>();
  const activeInTop = new Set<string>();
  const activeInBottom = new Set<string>();
  const activeOutRight = new Set<string>();
  const activeOutBottom = new Set<string>();

  interface RoutedStageConn {
    conn: StageConnection;
    fromBox: StageWorldBox;
    toBox: StageWorldBox;
    fromSide: OutputPortDir;
    toSide: "left" | "top" | "bottom";
  }

  const routed: RoutedStageConn[] = [];
  for (const conn of stageConnections) {
    const fb = boxes.get(conn.fromStageId);
    const tb = boxes.get(conn.toStageId);
    if (!fb || !tb) continue;
    const { fromSide, toSide } = chooseStageConnectionSides(conn);
    routed.push({ conn, fromBox: fb, toBox: tb, fromSide, toSide });

    if (fromSide === "bottom") activeOutBottom.add(conn.fromStageId);
    else activeOutRight.add(conn.fromStageId);

    if (toSide === "top") activeInTop.add(conn.toStageId);
    else if (toSide === "bottom") activeInBottom.add(conn.toStageId);
    else activeInLeft.add(conn.toStageId);
  }

  for (const [sid, pts] of portsByStage.entries()) {
    if (pts.inLeft) {
      const has = activeInLeft.has(sid);
      pts.inLeft.classList.toggle("has-wire", has);
      pts.inLeft.classList.toggle("is-hidden-port", !editableActive && !has);
    }
    if (pts.inTop) {
      const has = activeInTop.has(sid);
      pts.inTop.classList.toggle("has-wire", has);
      pts.inTop.classList.toggle("is-hidden-port", !editableActive && !has);
    }
    if (pts.inBottom) {
      const has = activeInBottom.has(sid);
      pts.inBottom.classList.toggle("has-wire", has);
      pts.inBottom.classList.toggle("is-hidden-port", !editableActive && !has);
    }
    if (pts.outRight) {
      const has = activeOutRight.has(sid);
      pts.outRight.classList.toggle("has-wire", has);
      if (pts.outRight.tagName !== "BUTTON") {
        pts.outRight.classList.toggle("is-hidden-port", !has);
      }
    }
    if (pts.outBottom) {
      const has = activeOutBottom.has(sid);
      pts.outBottom.classList.toggle("has-wire", has);
      if (pts.outBottom.tagName !== "BUTTON") {
        pts.outBottom.classList.toggle("is-hidden-port", !has);
      }
    }
  }

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

    const p1 = computeStageSideAnchor(fromBox, fromSide, false);
    const p2 = computeStageSideAnchor(toBox, toSide, true);
    const { d, c1x, c1y, c2x, c2y } = buildDirectionalBezier(
      p1.x,
      p1.y,
      fromSide,
      p2.x,
      p2.y,
      toSide
    );

    const isInvalid = !!conn.invalid;
    const fromStg = (race.stages ?? []).find((s) => s.index === conn.fromStageIndex);
    const isConfirmed =
      !isInvalid &&
      !!(fromStg && (fromStg.status === "completed" || fromStg.completedEarly));
    const isBottom = fromSide === "bottom" || conn.mode === "seed_range";
    const wasHovered = existingPaths.get(conn.id)?.classList.contains("is-wire-hovered") ?? false;
    const cls = `bkt-wire is-portal-wire${isInvalid ? " is-invalid" : ""}${isConfirmed ? " is-confirmed" : ""}${isBottom ? " is-bottom" : ""}${wasHovered ? " is-wire-hovered" : ""}`;

    const targetStarted =
      !isInvalid &&
      race.heats.some((h) => h.stageIndex === conn.toStageIndex && !isHeatUnstarted(h.state));
    const canEditWire = editableActive && (!targetStarted || isInvalid);

    if (canEditWire) {
      let hitEl = existingHitPaths.get(conn.id);
      const hitCls = `bkt-wire-hit${isInvalid ? " is-invalid" : ""}`;
      if (!hitEl) {
        hitEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
        hitEl.setAttribute("data-wire-hit", conn.id);
        hitEl.setAttribute("class", hitCls);
        if (previewNode) svg.insertBefore(hitEl, previewNode);
        else svg.appendChild(hitEl);
      } else if (hitEl.getAttribute("class") !== hitCls) {
        hitEl.setAttribute("class", hitCls);
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
      if (previewNode) svg.insertBefore(pathEl, previewNode);
      else svg.appendChild(pathEl);
    }
    if (pathEl.getAttribute("class") !== cls) {
      pathEl.setAttribute("class", cls);
    }
    pathEl.setAttribute("d", d);

    if (handlesLayer && canEditWire) {
      const srcPt = computeEndpointHandlePos("source", p1.x, p1.y, c1x, c1y, c2x, c2y, p2.x, p2.y);
      const dstPt = computeEndpointHandlePos("target", p1.x, p1.y, c1x, c1y, c2x, c2y, p2.x, p2.y);
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
              ? "Drag to move stage connection source"
              : "Drag to move stage connection target";
          handlesLayer.appendChild(hEl);
        }
        if (hEl.className !== hCls) hEl.className = hCls;
        hEl.style.transform = `translate3d(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px, 0) translate(-50%, -50%)`;
      }
    }

    const pillEl = pillsByConn.get(conn.id);
    if (pillEl) {
      if (wasHovered) pillEl.classList.add("is-wire-hovered");
      const candidateTs = [0.5, 0.36, 0.64, 0.27, 0.73];
      let chosen = evalCubicPoint(0.5, p1.x, p1.y, c1x, c1y, c2x, c2y, p2.x, p2.y);
      let settled = false;
      for (const t of candidateTs) {
        const pt = evalCubicPoint(t, p1.x, p1.y, c1x, c1y, c2x, c2y, p2.x, p2.y);
        const collides = placedPills.some(
          (p) => Math.abs(p.x - pt.x) < 56 && Math.abs(p.y - pt.y) < 28
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
            (p) => Math.abs(p.x - chosen.x) < 56 && Math.abs(p.y - chosen.y) < 28
          )
        ) {
          chosen = { x: chosen.x, y: chosen.y + 28 };
        }
      }
      placedPills.push(chosen);
      pillEl.style.transform = `translate3d(${chosen.x.toFixed(1)}px, ${chosen.y.toFixed(1)}px, 0) translate(-50%, -50%)`;
    }
  }

  for (const [cid, pathEl] of existingPaths.entries()) {
    if (!seenConnIds.has(cid)) pathEl.remove();
  }
  for (const [cid, hitEl] of existingHitPaths.entries()) {
    if (!seenConnIds.has(cid)) hitEl.remove();
  }
  for (const [hKey, cEl] of existingHandles.entries()) {
    if (!seenHandleKeys.has(hKey)) cEl.remove();
  }
}

export function drawFormatWires(
  root: HTMLElement,
  race: RaceTournamentState,
  ui?: BracketEditorUiState
): void {
  const canvas = root.querySelector<HTMLElement>("[data-fmt-graph]");
  if (!canvas) return;
  const svg = canvas.querySelector<SVGSVGElement>("svg.bkt-wires");
  const handlesLayer = canvas.querySelector<HTMLElement>("[data-fmt-wire-handles]");
  if (!svg) return;

  svg.removeAttribute("viewBox");
  const stages = resolveStagesList(race);
  const stageConnections = race.stageConnections ?? [];
  const editableActive =
    canvas.dataset.fmtEditable === "1" &&
    race.lifecycle !== "completed" &&
    race.lifecycle !== "scrapped";

  const nodeEls = Array.from(canvas.querySelectorAll<HTMLElement>("[data-stage-node]"));
  if (!ui?.activeGesture) {
    const hasAuto = stages.some((s) => !s.hasPos && !ui?.optimisticPositions.has(s.id));
    if (hasAuto && nodeEls.length > 0) {
      const measured = new Map<string, number>();
      for (const el of nodeEls) {
        const sid = el.dataset.stageNode ?? "";
        if (sid && el.offsetHeight > 40) measured.set(sid, el.offsetHeight);
      }
      const refined = computeStagePositions(stages, stageConnections, ui, measured);
      for (const el of nodeEls) {
        const sid = el.dataset.stageNode ?? "";
        const stg = stages.find((s) => s.id === sid);
        if (!stg || stg.hasPos || ui?.optimisticPositions.has(sid)) continue;
        const pos = refined.get(sid);
        if (pos) {
          el.dataset.posX = String(pos.x);
          el.dataset.posY = String(pos.y);
          el.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
        }
      }
    }
  }

  const boxes = new Map<string, StageWorldBox>();
  const portsByStage = new Map<string, CachedStagePorts>();
  for (const el of nodeEls) {
    const sid = el.dataset.stageNode ?? "";
    const sidx = Number(el.dataset.stageIndex) || 1;
    if (!sid) continue;
    const x = Number(el.dataset.posX) || 0;
    const y = Number(el.dataset.posY) || 0;
    boxes.set(sid, {
      id: sid,
      index: sidx,
      x,
      y,
      w: el.offsetWidth || FMT_NODE_WIDTH,
      h: el.offsetHeight || 190,
      el,
    });
    portsByStage.set(sid, {
      inLeft: el.querySelector<HTMLElement>("[data-port-side='left']"),
      inTop: el.querySelector<HTMLElement>("[data-port-side='top']"),
      inBottom: el.querySelector<HTMLElement>("[data-port-side='bottom'][data-port-kind='in']"),
      outRight: el.querySelector<HTMLElement>("[data-port-dir='right']"),
      outBottom: el.querySelector<HTMLElement>("[data-port-dir='bottom']"),
    });
  }

  const pillsByConn = new Map<string, HTMLElement>();
  canvas.querySelectorAll<HTMLElement>("[data-wire-pill]").forEach((pEl) => {
    const cid = pEl.dataset.wirePill ?? "";
    if (cid) pillsByConn.set(cid, pEl);
  });

  updateFormatWiresFromBoxes(
    svg,
    handlesLayer,
    boxes,
    portsByStage,
    pillsByConn,
    stageConnections,
    race,
    editableActive
  );
}

export function handleFormatEditEvent(
  e: Event,
  api: ApiClient,
  getRace: () => RaceTournamentState,
  ui: BracketEditorUiState,
  cb: FormatEventCallbacks
): boolean {
  const target = e.target as Element | null;
  if (!target || !target.closest("[data-fmt-graph], .rc-empty-floater")) return false;

  const reportErr = (err: unknown): void => {
    const msg = err instanceof Error ? err.message : String(err);
    cb.onError?.(msg);
  };

  if (e.type === "dblclick") {
    // Double-clicking a connector line, endpoint, or pill NEVER opens settings
    if (target.closest("[data-wire-hit], [data-wire-pill], [data-wire-endpoint]")) {
      e.preventDefault();
      e.stopPropagation();
      return true;
    }
    const stageCard = target.closest<HTMLElement>("[data-stage-node]");
    if (stageCard && !target.closest("button, select, input, .bkt-port")) {
      const stageIndex = Number(stageCard.dataset.stageIndex) || 1;
      cb.onOpenStageEdit(stageIndex);
      return true;
    }
    return false;
  }

  if (e.type !== "click") return false;

  // Clicking an invalid stage wire surfaces why it is invalid in a toast; never opens settings on normal wire click
  const wireHitEl = target.closest<HTMLElement>("[data-wire-hit]");
  if (wireHitEl) {
    const cid = wireHitEl.getAttribute("data-wire-hit") ?? "";
    const conn = (getRace().stageConnections ?? []).find((c) => c.id === cid);
    if (conn?.invalid) {
      showToast(
        conn.invalidReason || "This stage connection forms an invalid DAG link.",
        "error",
        { title: "Invalid Stage Connection" }
      );
    }
    if (ui.openWireMenuId || ui.openNodeMenuId || ui.connectingFromRoundId) {
      ui.openWireMenuId = "";
      ui.openNodeMenuId = "";
      ui.connectingFromRoundId = "";
      ui.rerender();
    }
    return true;
  }

  const presetBtn = target.closest<HTMLElement>("[data-fmt-wire-preset]");
  if (presetBtn) {
    const connectionId = presetBtn.dataset.connId ?? "";
    const [rawMode, rawA, rawB] = (presetBtn.dataset.fmtWirePreset ?? "").split(":");
    const linkMode = (rawMode || "all_pilots") as StageConnectionMode;
    const numA = Number(rawA) || 0;
    const numB = Number(rawB) || 0;
    ui.openWireMenuId = "";
    if (connectionId) {
      const prevConns = [...(getRace().stageConnections ?? [])];
      void api
        .bracketEdit({
          action: "update_stage_connection",
          connectionId,
          linkMode,
          advanceCount: linkMode === "top_n" ? numA : 0,
          seedStart: linkMode === "seed_range" ? Math.max(1, numA) : 1,
          seedEnd: linkMode === "seed_range" ? Math.max(1, numB) : 0,
        })
        .then((next) =>
          notifyNewlyInvalidStageConnections(prevConns, next ?? getRace(), connectionId)
        )
        .catch(reportErr);
    }
    return true;
  }

  const uiBtn = target.closest<HTMLElement>("[data-fmt-ui]");
  if (uiBtn) {
    switch (uiBtn.dataset.fmtUi) {
      case "toggle-wire-menu": {
        const connId = uiBtn.dataset.connId ?? "";
        ui.openWireMenuId = ui.openWireMenuId === connId ? "" : connId;
        ui.openNodeMenuId = "";
        ui.connectingFromRoundId = "";
        ui.rerender();
        return true;
      }
      case "toggle-stage-menu": {
        const stageId = uiBtn.dataset.stageId ?? "";
        ui.openNodeMenuId = ui.openNodeMenuId === stageId ? "" : stageId;
        ui.openWireMenuId = "";
        ui.connectingFromRoundId = "";
        ui.rerender();
        return true;
      }
    }
  }

  // Close open menus on outside click
  if (
    (ui.openWireMenuId && !target.closest("[data-wire-pill]")) ||
    (ui.openNodeMenuId && !target.closest(".bkt-node-menu, [data-fmt-ui='toggle-stage-menu']"))
  ) {
    ui.openWireMenuId = "";
    ui.openNodeMenuId = "";
    if (!target.closest("[data-fmt-action], [data-stage-ctrl]")) {
      ui.rerender();
    }
  }

  const stageCtrlBtn = target.closest<HTMLButtonElement>("[data-stage-ctrl]");
  if (stageCtrlBtn && !stageCtrlBtn.disabled) {
    const stageAct = stageCtrlBtn.dataset.stageCtrl as
      | "activate_stage"
      | "pause_stage"
      | "resume_stage"
      | "complete_stage_early"
      | "reopen_stage_early";
    const stageIdx = Number(stageCtrlBtn.dataset.stageIdx) || 1;
    const stageId = stageCtrlBtn.dataset.stageId;
    ui.openNodeMenuId = "";
    ui.rerender();
    if (stageAct && stageIdx >= 1) {
      void api.stageControl(stageAct, stageIdx, stageId).catch(reportErr);
    }
    return true;
  }

  // Click-to-connect fallback when an output port is armed
  if (
    ui.connectingFromRoundId &&
    !target.closest("[data-stage-out]") &&
    !target.closest("[data-fmt-action='complete_stage_connect']")
  ) {
    const clickedInPort = target.closest<HTMLElement>("[data-fmt-port='in']:not(.is-hidden-port)");
    const clickedStageCard = !target.closest("button, [data-fmt-ui]")
      ? target.closest<HTMLElement>("[data-stage-node]")
      : null;
    const dstNode = clickedInPort?.closest<HTMLElement>("[data-stage-node]") ?? clickedStageCard;
    const fromStageId = ui.connectingFromRoundId;
    const fromPort = ui.connectingFromPortDir;
    ui.connectingFromRoundId = "";
    ui.connectingFromPortDir = "right";

    if (dstNode) {
      const toStageId = dstNode.dataset.stageNode ?? "";
      const rawSide = clickedInPort?.dataset.portSide;
      const toPort: "left" | "top" | "bottom" | undefined = clickedInPort
        ? rawSide === "top" || rawSide === "bottom"
          ? rawSide
          : "left"
        : undefined;
      const curRace = getRace();
      const stages = resolveStagesList(curRace);
      const validTargets = getValidTargetStageIds(
        stages,
        curRace.stageConnections ?? [],
        fromStageId,
        curRace
      );
      if (toStageId && validTargets.has(toStageId)) {
        const prevConns = [...(curRace.stageConnections ?? [])];
        const stagePositions = collectFormatStagePositions(target, curRace, ui);
        void api
          .bracketEdit({
            action: "connect_stages",
            fromStageId,
            toStageId,
            fromPort,
            ...(toPort ? { toPort } : {}),
            stagePositions,
          })
          .then((next) => notifyNewlyInvalidStageConnections(prevConns, next ?? getRace()))
          .catch(reportErr);
        return true;
      }
    }
    ui.rerender();
    return true;
  }

  const actionBtn = target.closest<HTMLElement>("[data-fmt-action]");
  if (!actionBtn || (actionBtn instanceof HTMLButtonElement && actionBtn.disabled)) {
    return false;
  }

  switch (actionBtn.dataset.fmtAction) {
    case "open_stage_edit": {
      const stageIndex = Number(actionBtn.dataset.stageIndex) || 1;
      ui.openNodeMenuId = "";
      cb.onOpenStageEdit(stageIndex);
      return true;
    }
    case "open_stage_settings": {
      const stageIndex = Number(actionBtn.dataset.stageIndex) || 1;
      ui.openNodeMenuId = "";
      ui.rerender();
      openStageSettingsModal({
        stageIndex,
        getRace,
        api,
        onError: (msg) => cb.onError?.(msg),
      });
      return true;
    }
    case "open_stage_conn_modal": {
      const connectionId = actionBtn.dataset.connId ?? "";
      ui.openWireMenuId = "";
      ui.rerender();
      if (connectionId) {
        openStageConnectionModal({
          connectionId,
          getRace,
          api,
          onError: (msg) => cb.onError?.(msg),
        });
      }
      return true;
    }
    case "complete_stage_connect": {
      const fromStageId = ui.connectingFromRoundId;
      const fromPort = ui.connectingFromPortDir;
      const toStageId = actionBtn.dataset.toStageId ?? "";
      ui.connectingFromRoundId = "";
      ui.connectingFromPortDir = "right";
      if (fromStageId && toStageId) {
        const curRace = getRace();
        const graph = buildStageNetworkGraph(resolveStagesList(curRace), curRace);
        const check = graph.validateConnection(fromStageId, toStageId);
        if (!check.valid) {
          ui.rerender();
          showToast(check.reason, "warn");
          return true;
        }
        const prevConns = [...(curRace.stageConnections ?? [])];
        const stagePositions = collectFormatStagePositions(target, curRace, ui);
        void api
          .bracketEdit({
            action: "connect_stages",
            fromStageId,
            toStageId,
            fromPort,
            stagePositions,
          })
          .then((next) => notifyNewlyInvalidStageConnections(prevConns, next ?? getRace()))
          .catch(reportErr);
      }
      return true;
    }
    case "disconnect_stages": {
      const connectionId = actionBtn.dataset.connId ?? "";
      ui.openWireMenuId = "";
      if (connectionId) {
        const curRace = getRace();
        const stagePositions = collectFormatStagePositions(target, curRace, ui);
        void api
          .bracketEdit({
            action: "disconnect_stages",
            connectionId,
            stagePositions,
          })
          .catch(reportErr);
      }
      return true;
    }
    case "delete_stage": {
      const stageId = actionBtn.dataset.stageId ?? "";
      const stageIndex = Number(actionBtn.dataset.stageIndex) || 0;
      ui.openNodeMenuId = "";
      ui.rerender();
      const stg = resolveStagesList(getRace()).find(
        (s) => (stageId && s.id === stageId) || s.index === stageIndex
      );
      if (stg) {
        cb.onDeleteStage(stg);
      }
      return true;
    }
  }
  return false;
}

interface HoveredStageSocket {
  portEl: HTMLElement;
  nodeEl: HTMLElement;
  stageId: string;
  kind: "in" | "out";
  side: PortSide;
}

function findHoveredStageSocket(
  canvas: HTMLElement,
  clientX: number,
  clientY: number,
  excludePortEl?: Element | null,
  preferKind?: "in" | "out"
): HoveredStageSocket | null {
  let best: HoveredStageSocket | null = null;
  let bestScore = FMT_PORT_SNAP_RADIUS_PX;

  canvas.querySelectorAll<HTMLElement>("[data-fmt-port]:not(.is-hidden-port)").forEach((pEl) => {
    if (pEl === excludePortEl) return;
    const nodeEl = pEl.closest<HTMLElement>("[data-stage-node]");
    const stageId = nodeEl?.dataset.stageNode ?? "";
    if (!nodeEl || !stageId) return;
    const pr = pEl.getBoundingClientRect();
    if (pr.width <= 0 || pr.height <= 0) return;

    const kind: "in" | "out" = pEl.dataset.portKind === "out" ? "out" : "in";
    const rawSide = (pEl.dataset.portSide || pEl.dataset.portDir || "left") as PortSide;
    const dist = Math.hypot(
      clientX - (pr.left + pr.width / 2),
      clientY - (pr.top + pr.height / 2)
    );
    if (dist > FMT_PORT_SNAP_RADIUS_PX) return;
    const score = preferKind && kind === preferKind ? dist - 6 : dist;
    if (score < bestScore) {
      bestScore = score;
      best = { portEl: pEl, nodeEl, stageId, kind, side: rawSide };
    }
  });
  return best;
}

function clearStageSnapClasses(canvas: HTMLElement): void {
  canvas.classList.remove("is-invalid-wire-target");
  canvas
    .querySelectorAll(".is-wire-snap, .is-wire-snap-warn, .is-port-snap, .is-port-invalid")
    .forEach((el) => {
      el.classList.remove("is-wire-snap", "is-wire-snap-warn", "is-port-snap", "is-port-invalid");
    });
}

function screenToWorld(
  canvas: HTMLElement,
  clientX: number,
  clientY: number,
  ui: BracketEditorUiState
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const z = ui.zoom || 1;
  return {
    x: (clientX - rect.left) / z,
    y: (clientY - rect.top) / z,
  };
}

function readStageBox(el: HTMLElement): StageWorldBox {
  return {
    id: el.dataset.stageNode ?? "",
    index: Number(el.dataset.stageIndex) || 1,
    x: Number(el.dataset.posX) || 0,
    y: Number(el.dataset.posY) || 0,
    w: el.offsetWidth || FMT_NODE_WIDTH,
    h: el.offsetHeight || 190,
    el,
  };
}

/**
 * Binds Format-mode stage card dragging, directional port-to-port stage wiring, and
 * existing stage wire endpoint reconnection onto `root`. Panning, wheel zoom, and
 * wire hover highlights are shared seamlessly with `bindBracketDragAndDrop`.
 */
export function bindFormatDragAndDrop(
  root: HTMLElement,
  api: ApiClient,
  getRace: () => RaceTournamentState,
  ui: BracketEditorUiState,
  onError?: (msg: string) => void
): () => void {
  let cleanupGesture: (() => void) | null = null;
  const reportErr = (err: unknown): void => {
    const msg = err instanceof Error ? err.message : String(err);
    onError?.(msg);
  };

  const startStageNodeDrag = (
    e: PointerEvent,
    viewport: HTMLElement,
    canvas: HTMLElement,
    stageNode: HTMLElement
  ): void => {
    const stageId = stageNode.dataset.stageNode ?? "";
    if (!stageId) return;
    e.preventDefault();
    e.stopPropagation();
    dismissWireDropMenu();
    if (cleanupGesture) cleanupGesture();

    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    const zoom = ui.zoom || 1;
    let dragging = false;
    ui.activeGesture = true;

    const movingIds = ui.selectedRoundIds.has(stageId)
      ? Array.from(ui.selectedRoundIds)
      : e.shiftKey
        ? [...Array.from(ui.selectedRoundIds), stageId]
        : [stageId];

    const svg = canvas.querySelector<SVGSVGElement>("svg.bkt-wires");
    const handlesLayer = canvas.querySelector<HTMLElement>("[data-fmt-wire-handles]");
    const raceSnap = getRace();
    const editableActive =
      canvas.dataset.fmtEditable === "1" &&
      raceSnap.lifecycle !== "completed" &&
      raceSnap.lifecycle !== "scrapped";

    const boxes = new Map<string, StageWorldBox>();
    const portsByStage = new Map<string, CachedStagePorts>();
    canvas.querySelectorAll<HTMLElement>("[data-stage-node]").forEach((el) => {
      const b = readStageBox(el);
      if (!b.id) return;
      boxes.set(b.id, b);
      portsByStage.set(b.id, {
        inLeft: el.querySelector<HTMLElement>("[data-port-side='left']"),
        inTop: el.querySelector<HTMLElement>("[data-port-side='top']"),
        inBottom: el.querySelector<HTMLElement>("[data-port-side='bottom'][data-port-kind='in']"),
        outRight: el.querySelector<HTMLElement>("[data-port-dir='right']"),
        outBottom: el.querySelector<HTMLElement>("[data-port-dir='bottom']"),
      });
    });

    const pillsByConn = new Map<string, HTMLElement>();
    canvas.querySelectorAll<HTMLElement>("[data-wire-pill]").forEach((pEl) => {
      const cid = pEl.dataset.wirePill ?? "";
      if (cid) pillsByConn.set(cid, pEl);
    });

    const startPositions = new Map<string, { box: StageWorldBox; sx: number; sy: number }>();
    for (const id of movingIds) {
      const b = boxes.get(id);
      if (b) startPositions.set(id, { box: b, sx: b.x, sy: b.y });
    }

    let stageDragRafId = 0;
    const flushStageDragDom = (): void => {
      if (stageDragRafId) {
        window.cancelAnimationFrame(stageDragRafId);
        stageDragRafId = 0;
      }
      for (const info of startPositions.values()) {
        info.box.el.style.transform = `translate3d(${info.box.x}px, ${info.box.y}px, 0)`;
      }
      if (svg) {
        updateFormatWiresFromBoxes(
          svg,
          handlesLayer,
          boxes,
          portsByStage,
          pillsByConn,
          raceSnap.stageConnections ?? [],
          raceSnap,
          editableActive
        );
      }
    };

    const onMove = (ev: PointerEvent): void => {
      const dxScreen = ev.clientX - startX;
      const dyScreen = ev.clientY - startY;
      if (!dragging && Math.hypot(dxScreen, dyScreen) < 4) return;
      if (!dragging) {
        dragging = true;
        ui.openNodeMenuId = "";
        ui.openWireMenuId = "";
        viewport.classList.add("is-dragging-nodes");
        try {
          viewport.setPointerCapture(pointerId);
        } catch {
          // Ignore synthetic pointer
        }
        boxes.forEach((b, sid) => {
          b.el.classList.toggle("is-dragging-node", startPositions.has(sid));
        });
      }

      const dxWorld = dxScreen / zoom;
      const dyWorld = dyScreen / zoom;
      for (const [sid, info] of startPositions.entries()) {
        const nx = Math.round((info.sx + dxWorld) * 10) / 10;
        const ny = Math.round((info.sy + dyWorld) * 10) / 10;
        info.box.x = nx;
        info.box.y = ny;
        info.box.el.dataset.posX = String(nx);
        info.box.el.dataset.posY = String(ny);
        ui.optimisticPositions.set(sid, { x: nx, y: ny });
      }

      if (!stageDragRafId) {
        stageDragRafId = window.requestAnimationFrame(() => {
          stageDragRafId = 0;
          flushStageDragDom();
        });
      }
    };

    const finish = (cancelled: boolean): void => {
      if (stageDragRafId) {
        flushStageDragDom();
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      try {
        if (viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId);
      } catch {
        // Ignore
      }
      viewport.classList.remove("is-dragging-nodes");
      boxes.forEach((b) => b.el.classList.remove("is-dragging-node"));
      ui.activeGesture = false;
      cleanupGesture = null;

      if (cancelled || !dragging) return;
      const stagePositions = collectFormatStagePositions(canvas, getRace(), ui);
      void api
        .bracketEdit({ action: "move_stages", stagePositions })
        .then(() => {
          for (const sid of startPositions.keys()) {
            ui.optimisticPositions.delete(sid);
          }
        })
        .catch(reportErr);
    };

    const onUp = (): void => finish(false);
    const onCancel = (): void => finish(true);

    cleanupGesture = () => finish(true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  const startStageOutPortDrag = (
    e: PointerEvent,
    canvas: HTMLElement,
    outPort: HTMLElement
  ): void => {
    const svg = canvas.querySelector<SVGSVGElement>("svg.bkt-wires");
    const fromStageId = outPort.dataset.stageOut ?? "";
    const portDir: OutputPortDir = outPort.dataset.portDir === "bottom" ? "bottom" : "right";
    const fromNodeEl = outPort.closest<HTMLElement>("[data-stage-node]");
    if (!svg || !fromStageId || !fromNodeEl) return;

    e.preventDefault();
    e.stopPropagation();
    dismissWireDropMenu();
    if (cleanupGesture) cleanupGesture();

    const race = getRace();
    const stages = resolveStagesList(race);
    const validTargets = getValidTargetStageIds(
      stages,
      race.stageConnections ?? [],
      fromStageId,
      race
    );

    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    let isDragging = false;
    let previewPath: SVGPathElement | null = null;

    const isSocketValid = (sock: HoveredStageSocket): boolean =>
      sock.kind === "in" && sock.stageId !== fromStageId && validTargets.has(sock.stageId);

    const updatePreview = (clientX: number, clientY: number): void => {
      const fromBox = readStageBox(fromNodeEl);
      const p1 = computeStageSideAnchor(fromBox, portDir, false);
      clearStageSnapClasses(canvas);

      const hovered = findHoveredStageSocket(canvas, clientX, clientY, outPort, "in");
      let p2 = screenToWorld(canvas, clientX, clientY, ui);
      let toSide: PortSide =
        portDir === "bottom" && p2.y > p1.y + 18 ? "top" : "left";
      let snappedValid = false;
      let snappedInvalid = false;

      if (hovered) {
        const hb = readStageBox(hovered.nodeEl);
        toSide = hovered.side;
        p2 = computeStageSideAnchor(hb, hovered.side, hovered.kind === "in");
        if (isSocketValid(hovered)) {
          snappedValid = true;
          hovered.nodeEl.classList.add("is-wire-snap");
          hovered.portEl.classList.add("is-port-snap");
        } else {
          snappedInvalid = true;
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
      previewPath.classList.toggle("is-bottom", portDir === "bottom");
      const { d } = buildDirectionalBezier(p1.x, p1.y, portDir, p2.x, p2.y, toSide);
      previewPath.setAttribute("d", d);
      previewPath.classList.toggle("is-snapped", snappedValid);
      previewPath.classList.toggle("is-invalid-snap", snappedInvalid);
    };

    let wireRafId = 0;
    let latestWireX = startX;
    let latestWireY = startY;
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      latestWireX = ev.clientX;
      latestWireY = ev.clientY;
      if (!isDragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) >= 5) {
        isDragging = true;
        ui.activeGesture = true;
        canvas.classList.add("is-dragging-wire");
        outPort.classList.add("is-active");
        try {
          outPort.setPointerCapture(pointerId);
        } catch {
          // Ignore synthetic pointer
        }
        canvas.querySelectorAll<HTMLElement>("[data-stage-node]").forEach((nEl) => {
          if (validTargets.has(nEl.dataset.stageNode ?? "")) {
            nEl.classList.add("is-wire-candidate");
          }
        });
      }
      if (isDragging && !wireRafId) {
        wireRafId = window.requestAnimationFrame(() => {
          wireRafId = 0;
          if (isDragging) updatePreview(latestWireX, latestWireY);
        });
      }
    };

    const finish = (ev: PointerEvent, cancelled: boolean): void => {
      if (ev.pointerId !== undefined && ev.pointerId !== pointerId) return;
      if (wireRafId) {
        window.cancelAnimationFrame(wireRafId);
        wireRafId = 0;
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      try {
        if (outPort.hasPointerCapture(pointerId)) outPort.releasePointerCapture(pointerId);
      } catch {
        // Ignore
      }
      ui.activeGesture = false;
      cleanupGesture = null;

      canvas.classList.remove("is-dragging-wire");
      outPort.classList.remove("is-active");
      clearStageSnapClasses(canvas);
      canvas.querySelectorAll(".is-wire-candidate").forEach((el) => {
        el.classList.remove("is-wire-candidate");
      });
      if (previewPath?.parentNode) previewPath.parentNode.removeChild(previewPath);
      previewPath = null;

      if (cancelled) return;
      if (isDragging) {
        const finalSock = findHoveredStageSocket(canvas, ev.clientX, ev.clientY, outPort, "in");
        if (!finalSock || !isSocketValid(finalSock)) {
          if (finalSock) {
            const curRace = getRace();
            const graph = buildStageNetworkGraph(resolveStagesList(curRace), curRace);
            const reason =
              finalSock.kind !== "in"
                ? "Connect an output port to an input port."
                : graph.validateConnection(fromStageId, finalSock.stageId).reason;
            if (reason) showToast(reason, "warn");
            return;
          }
          // Dropped in empty canvas space: open the contextual `+` speed-dial to spawn & connect a stage!
          const curRace = getRace();
          if (curRace.lifecycle === "completed" || curRace.lifecycle === "scrapped") {
            return;
          }
          const curStages = resolveStagesList(curRace);
          if (curStages.length >= 5) {
            showToast("Maximum of 5 stages reached per race.", "warn");
            return;
          }
          const viewport = canvas.closest<HTMLElement>("[data-rc-viewport]");
          if (!viewport) return;
          const fromBox = readStageBox(fromNodeEl);
          const p1 = computeStageSideAnchor(fromBox, portDir, false);
          const dropWorld = screenToWorld(canvas, ev.clientX, ev.clientY, ui);
          const toPort: "left" | "top" =
            portDir === "bottom" && dropWorld.y > p1.y + 24 ? "top" : "left";
          const { d } = buildDirectionalBezier(p1.x, p1.y, portDir, dropWorld.x, dropWorld.y, toPort);
          const fromStage = curStages.find((s) => s.id === fromStageId);
          const options = buildFormatWireDropOptions(fromStage, portDir);
          openWireDropMenu({
            viewport,
            svg,
            outPort,
            clientX: ev.clientX,
            clientY: ev.clientY,
            tetherPathD: d,
            isBottomPort: portDir === "bottom",
            options,
            onSelect: (chosenFormatId) => {
              const liveRace = getRace();
              const liveStages = resolveStagesList(liveRace);
              if (liveStages.length >= 5) {
                showToast("Maximum of 5 stages reached per race.", "warn");
                return;
              }
              const spawnX = Math.round(
                toPort === "top" ? dropWorld.x - FMT_NODE_WIDTH / 2 : dropWorld.x
              );
              const spawnY = Math.round(toPort === "top" ? dropWorld.y : dropWorld.y - 84);
              const prevStageIds = new Set(liveStages.map((s) => s.id));
              const prevConns = [...(liveRace.stageConnections ?? [])];
              const stagePositions = collectFormatStagePositions(canvas, liveRace, ui);
              ui.connectingFromRoundId = "";
              ui.connectingFromPortDir = "right";
              ui.openWireMenuId = "";
              ui.openNodeMenuId = "";
              void api
                .bracketEdit({
                  action: "add_stage",
                  stageFormat: chosenFormatId as StageFormat,
                  fromStageId,
                  fromPort: portDir,
                  toPort,
                  hasPos: true,
                  posX: spawnX,
                  posY: spawnY,
                  stagePositions,
                })
                .then((nextState) => {
                  const updated = nextState ?? getRace();
                  notifyNewlyInvalidStageConnections(prevConns, updated);
                  const addedStage = resolveStagesList(updated).find(
                    (s) => !prevStageIds.has(s.id)
                  );
                  if (addedStage) {
                    const hostRoot = viewport.parentElement ?? viewport;
                    const nodeEl = hostRoot.querySelector<HTMLElement>(
                      `[data-stage-node="${CSS.escape(addedStage.id)}"]`
                    );
                    flashSpawnedCanvasNode(nodeEl);
                  }
                })
                .catch(reportErr);
            },
          });
          return;
        }
        const toPort: "left" | "top" | "bottom" =
          finalSock.side === "top" || finalSock.side === "bottom" ? finalSock.side : "left";
        ui.connectingFromRoundId = "";
        ui.connectingFromPortDir = "right";
        ui.openWireMenuId = "";
        ui.openNodeMenuId = "";
        const curRace = getRace();
        const prevConns = [...(curRace.stageConnections ?? [])];
        const stagePositions = collectFormatStagePositions(canvas, curRace, ui);
        void api
          .bracketEdit({
            action: "connect_stages",
            fromStageId,
            toStageId: finalSock.stageId,
            fromPort: portDir,
            toPort,
            stagePositions,
          })
          .then((next) => notifyNewlyInvalidStageConnections(prevConns, next ?? getRace()))
          .catch(reportErr);
      } else {
        const same =
          ui.connectingFromRoundId === fromStageId && ui.connectingFromPortDir === portDir;
        ui.connectingFromRoundId = same ? "" : fromStageId;
        ui.connectingFromPortDir = same ? "right" : portDir;
        ui.openWireMenuId = "";
        ui.openNodeMenuId = "";
        ui.rerender();
      }
    };

    const onUp = (ev: PointerEvent): void => finish(ev, false);
    const onCancel = (ev: PointerEvent): void => finish(ev, true);
    cleanupGesture = () => finish(e, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  const startStageEndpointDrag = (
    e: PointerEvent,
    endpointKind: "source" | "target",
    connId: string,
    canvas: HTMLElement
  ): void => {
    const svg = canvas.querySelector<SVGSVGElement>("svg.bkt-wires");
    const handlesLayer = canvas.querySelector<HTMLElement>("[data-fmt-wire-handles]");
    const race = getRace();
    const conn = (race.stageConnections ?? []).find((c) => c.id === connId);
    if (!svg || !conn) return;

    const fixedStageId = endpointKind === "target" ? conn.fromStageId : conn.toStageId;
    const fixedNodeEl = canvas.querySelector<HTMLElement>(
      `[data-stage-node="${CSS.escape(fixedStageId)}"]`
    );
    if (!fixedNodeEl) return;

    const initialSides = chooseStageConnectionSides(conn);

    e.preventDefault();
    e.stopPropagation();
    dismissWireDropMenu();
    if (cleanupGesture) cleanupGesture();

    const stages = resolveStagesList(race);
    const stageGraph = buildStageNetworkGraph(stages, race, connId);
    const validCandidates = new Set<string>();
    if (endpointKind === "target") {
      validCandidates.add(conn.toStageId);
      stageGraph.getValidTargetIds(conn.fromStageId).forEach((id) => validCandidates.add(id));
    } else {
      validCandidates.add(conn.fromStageId);
      for (const s of stages) {
        if (stageGraph.validateConnection(s.id, conn.toStageId).valid) {
          validCandidates.add(s.id);
        }
      }
    }

    const startX = e.clientX;
    const startY = e.clientY;
    let isDragging = false;
    let previewPath: SVGPathElement | null = null;

    const setOrigReconnecting = (active: boolean): void => {
      const escId = CSS.escape(connId);
      svg.querySelector(`[data-wire-conn="${escId}"]`)?.classList.toggle("is-reconnecting", active);
      handlesLayer
        ?.querySelectorAll(`[data-wire-conn="${escId}"]`)
        .forEach((el) => el.classList.toggle("is-reconnecting", active));
      canvas
        .querySelector(`[data-wire-pill="${escId}"]`)
        ?.classList.toggle("is-reconnecting", active);
    };

    const isSockValid = (sock: HoveredStageSocket): boolean => {
      if (endpointKind === "target") {
        if (sock.kind !== "in" || sock.stageId === conn.fromStageId) return false;
        return sock.stageId === conn.toStageId || validCandidates.has(sock.stageId);
      }
      if (sock.kind !== "out" || sock.stageId === conn.toStageId) return false;
      return sock.stageId === conn.fromStageId || validCandidates.has(sock.stageId);
    };

    const updatePreview = (clientX: number, clientY: number): void => {
      clearStageSnapClasses(canvas);
      const hovered = findHoveredStageSocket(
        canvas,
        clientX,
        clientY,
        undefined,
        endpointKind === "target" ? "in" : "out"
      );
      const cursorWorld = screenToWorld(canvas, clientX, clientY, ui);
      const fixedBox = readStageBox(fixedNodeEl);

      let p1: { x: number; y: number };
      let p2: { x: number; y: number };
      let fromSide: PortSide = initialSides.fromSide;
      let toSide: PortSide = initialSides.toSide;
      let snappedValid = false;
      let snappedInvalid = false;

      if (endpointKind === "target") {
        p1 = computeStageSideAnchor(fixedBox, fromSide, false);
        if (hovered) {
          const hb = readStageBox(hovered.nodeEl);
          toSide = hovered.side;
          p2 = computeStageSideAnchor(hb, hovered.side, hovered.kind === "in");
          if (isSockValid(hovered)) {
            snappedValid = true;
            hovered.nodeEl.classList.add("is-wire-snap");
            hovered.portEl.classList.add("is-port-snap");
          } else {
            snappedInvalid = true;
            hovered.nodeEl.classList.add("is-wire-snap-warn");
            hovered.portEl.classList.add("is-port-invalid");
            canvas.classList.add("is-invalid-wire-target");
          }
        } else {
          p2 = cursorWorld;
          toSide = fromSide === "bottom" && p2.y > p1.y + 18 ? "top" : "left";
        }
      } else {
        p2 = computeStageSideAnchor(fixedBox, toSide, true);
        if (hovered) {
          const hb = readStageBox(hovered.nodeEl);
          fromSide = hovered.side;
          p1 = computeStageSideAnchor(hb, hovered.side, hovered.kind === "in");
          if (isSockValid(hovered)) {
            snappedValid = true;
            hovered.nodeEl.classList.add("is-wire-snap");
            hovered.portEl.classList.add("is-port-snap");
          } else {
            snappedInvalid = true;
            hovered.nodeEl.classList.add("is-wire-snap-warn");
            hovered.portEl.classList.add("is-port-invalid");
            canvas.classList.add("is-invalid-wire-target");
          }
        } else {
          p1 = cursorWorld;
          fromSide = "right";
        }
      }

      if (!previewPath) {
        previewPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        previewPath.setAttribute("class", "bkt-wire is-drag-preview");
        svg.appendChild(previewPath);
      }
      previewPath.classList.toggle("is-bottom", fromSide === "bottom");
      const { d } = buildDirectionalBezier(p1.x, p1.y, fromSide, p2.x, p2.y, toSide);
      previewPath.setAttribute("d", d);
      previewPath.classList.toggle("is-snapped", snappedValid);
      previewPath.classList.toggle("is-invalid-snap", snappedInvalid);
    };

    const onMove = (ev: PointerEvent): void => {
      if (!isDragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) >= 5) {
        isDragging = true;
        ui.activeGesture = true;
        ui.openWireMenuId = "";
        ui.openNodeMenuId = "";
        canvas.classList.add("is-dragging-wire");
        setOrigReconnecting(true);
        canvas.querySelectorAll<HTMLElement>("[data-stage-node]").forEach((nEl) => {
          if (validCandidates.has(nEl.dataset.stageNode ?? "")) {
            nEl.classList.add("is-wire-candidate");
          }
        });
      }
      if (isDragging) updatePreview(ev.clientX, ev.clientY);
    };

    const finish = (ev: PointerEvent, cancelled: boolean): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      ui.activeGesture = false;
      cleanupGesture = null;

      canvas.classList.remove("is-dragging-wire");
      setOrigReconnecting(false);
      clearStageSnapClasses(canvas);
      canvas.querySelectorAll(".is-wire-candidate").forEach((el) => {
        el.classList.remove("is-wire-candidate");
      });
      if (previewPath?.parentNode) previewPath.parentNode.removeChild(previewPath);
      previewPath = null;

      if (cancelled || !isDragging) return;
      const finalSock = findHoveredStageSocket(
        canvas,
        ev.clientX,
        ev.clientY,
        undefined,
        endpointKind === "target" ? "in" : "out"
      );
      if (!finalSock) return;
      if (!isSockValid(finalSock)) {
        const check =
          endpointKind === "target" && finalSock.kind === "in"
            ? stageGraph.validateConnection(conn.fromStageId, finalSock.stageId)
            : endpointKind === "source" && finalSock.kind === "out"
              ? stageGraph.validateConnection(finalSock.stageId, conn.toStageId)
              : { valid: false, reason: "Connect an output port to an input port." };
        if (check.reason) showToast(check.reason, "warn");
        return;
      }

      const curRace = getRace();
      const nextFromId = endpointKind === "source" ? finalSock.stageId : conn.fromStageId;
      const nextToId = endpointKind === "target" ? finalSock.stageId : conn.toStageId;
      const nextFromPort: OutputPortDir =
        endpointKind === "source"
          ? finalSock.side === "bottom"
            ? "bottom"
            : "right"
          : initialSides.fromSide;
      const nextToPort: "left" | "top" | "bottom" =
        endpointKind === "target"
          ? finalSock.side === "top" || finalSock.side === "bottom"
            ? finalSock.side
            : "left"
          : initialSides.toSide;

      if (
        nextFromId === conn.fromStageId &&
        nextToId === conn.toStageId &&
        nextFromPort === initialSides.fromSide &&
        nextToPort === initialSides.toSide
      ) {
        return;
      }

      const prevConns = [...(curRace.stageConnections ?? [])];
      const stagePositions = collectFormatStagePositions(canvas, curRace, ui);
      void api
        .bracketEdit({
          action: "reconnect_stage_connection",
          connectionId: conn.id,
          fromStageId: nextFromId,
          toStageId: nextToId,
          fromPort: nextFromPort,
          toPort: nextToPort,
          stagePositions,
        })
        .then((next) =>
          notifyNewlyInvalidStageConnections(prevConns, next ?? getRace(), conn.id)
        )
        .catch(reportErr);
    };

    const onUp = (ev: PointerEvent): void => finish(ev, false);
    const onCancel = (ev: PointerEvent): void => finish(ev, true);
    cleanupGesture = () => finish(e, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  const startStageInPortDrag = (
    e: PointerEvent,
    canvas: HTMLElement,
    inPort: HTMLElement
  ): void => {
    if (ui.connectingFromRoundId) return;
    const svg = canvas.querySelector<SVGSVGElement>("svg.bkt-wires");
    const toNodeEl = inPort.closest<HTMLElement>("[data-stage-node]");
    const toStageId = toNodeEl?.dataset.stageNode ?? "";
    const rawSide = inPort.dataset.portSide;
    const toPort: "left" | "top" | "bottom" =
      rawSide === "top" || rawSide === "bottom" ? rawSide : "left";
    if (!svg || !toNodeEl || !toStageId) return;

    e.preventDefault();
    e.stopPropagation();
    dismissWireDropMenu();
    if (cleanupGesture) cleanupGesture();

    const race = getRace();
    const stages = resolveStagesList(race);
    const stageGraph = buildStageNetworkGraph(stages, race);
    const validSources = new Set<string>();
    for (const s of stages) {
      if (s.id !== toStageId && stageGraph.validateConnection(s.id, toStageId).valid) {
        validSources.add(s.id);
      }
    }

    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    let isDragging = false;
    let previewPath: SVGPathElement | null = null;

    const isSocketValid = (sock: HoveredStageSocket): boolean =>
      sock.kind === "out" && sock.stageId !== toStageId && validSources.has(sock.stageId);

    const updatePreview = (clientX: number, clientY: number): void => {
      const toBox = readStageBox(toNodeEl);
      const p2 = computeStageSideAnchor(toBox, toPort, true);
      clearStageSnapClasses(canvas);

      const hovered = findHoveredStageSocket(canvas, clientX, clientY, inPort, "out");
      let p1 = screenToWorld(canvas, clientX, clientY, ui);
      let fromSide: PortSide =
        toPort === "top" && p1.y < p2.y - 18 ? "bottom" : "right";
      let snappedValid = false;
      let snappedInvalid = false;

      if (hovered) {
        const hb = readStageBox(hovered.nodeEl);
        fromSide = hovered.side;
        p1 = computeStageSideAnchor(hb, hovered.side, hovered.kind === "in");
        if (isSocketValid(hovered)) {
          snappedValid = true;
          hovered.nodeEl.classList.add("is-wire-snap");
          hovered.portEl.classList.add("is-port-snap");
        } else {
          snappedInvalid = true;
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
      const { d } = buildDirectionalBezier(p1.x, p1.y, fromSide, p2.x, p2.y, toPort);
      previewPath.setAttribute("d", d);
      previewPath.classList.toggle("is-snapped", snappedValid);
      previewPath.classList.toggle("is-invalid-snap", snappedInvalid);
    };

    let wireRafId = 0;
    let latestWireX = startX;
    let latestWireY = startY;
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      latestWireX = ev.clientX;
      latestWireY = ev.clientY;
      if (!isDragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) >= 5) {
        isDragging = true;
        ui.activeGesture = true;
        canvas.classList.add("is-dragging-wire");
        inPort.classList.add("is-active");
        try {
          inPort.setPointerCapture(pointerId);
        } catch {
          // Ignore synthetic pointer
        }
        canvas.querySelectorAll<HTMLElement>("[data-stage-node]").forEach((nEl) => {
          if (validSources.has(nEl.dataset.stageNode ?? "")) {
            nEl.classList.add("is-wire-candidate");
          }
        });
      }
      if (isDragging && !wireRafId) {
        wireRafId = window.requestAnimationFrame(() => {
          wireRafId = 0;
          if (isDragging) updatePreview(latestWireX, latestWireY);
        });
      }
    };

    const finish = (ev: PointerEvent, cancelled: boolean): void => {
      if (ev.pointerId !== undefined && ev.pointerId !== pointerId) return;
      if (wireRafId) {
        window.cancelAnimationFrame(wireRafId);
        wireRafId = 0;
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      try {
        if (inPort.hasPointerCapture(pointerId)) inPort.releasePointerCapture(pointerId);
      } catch {
        // Ignore
      }
      ui.activeGesture = false;
      cleanupGesture = null;

      canvas.classList.remove("is-dragging-wire");
      inPort.classList.remove("is-active");
      clearStageSnapClasses(canvas);
      canvas.querySelectorAll(".is-wire-candidate").forEach((el) => {
        el.classList.remove("is-wire-candidate");
      });
      if (previewPath?.parentNode) previewPath.parentNode.removeChild(previewPath);
      previewPath = null;

      if (cancelled || !isDragging) return;
      const finalSock = findHoveredStageSocket(canvas, ev.clientX, ev.clientY, inPort, "out");
      if (!finalSock) return;
      if (!isSocketValid(finalSock)) {
        const curRace = getRace();
        const graph = buildStageNetworkGraph(resolveStagesList(curRace), curRace);
        const reason =
          finalSock.kind !== "out"
            ? "Connect an input port to an upstream output port."
            : graph.validateConnection(finalSock.stageId, toStageId).reason;
        if (reason) showToast(reason, "warn");
        return;
      }

      const fromPort: OutputPortDir = finalSock.side === "bottom" ? "bottom" : "right";
      ui.connectingFromRoundId = "";
      ui.connectingFromPortDir = "right";
      ui.openWireMenuId = "";
      ui.openNodeMenuId = "";
      const curRace = getRace();
      const prevConns = [...(curRace.stageConnections ?? [])];
      const stagePositions = collectFormatStagePositions(canvas, curRace, ui);
      void api
        .bracketEdit({
          action: "connect_stages",
          fromStageId: finalSock.stageId,
          toStageId,
          fromPort,
          toPort,
          stagePositions,
        })
        .then((next) => notifyNewlyInvalidStageConnections(prevConns, next ?? getRace()))
        .catch(reportErr);
    };

    const onUp = (ev: PointerEvent): void => finish(ev, false);
    const onCancel = (ev: PointerEvent): void => finish(ev, true);
    cleanupGesture = () => finish(e, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const target = e.target as Element | null;
    if (!target) return;
    const canvas = target.closest<HTMLElement>("[data-fmt-graph]");
    if (!canvas) return;

    const endpointEl = target.closest<HTMLElement>("[data-wire-endpoint]");
    if (endpointEl && canvas.dataset.fmtEditable === "1") {
      const kind = endpointEl.getAttribute("data-wire-endpoint") === "source" ? "source" : "target";
      const cid = endpointEl.getAttribute("data-wire-conn") ?? "";
      if (cid) {
        startStageEndpointDrag(e, kind, cid, canvas);
        return;
      }
    }

    const outPort = target.closest<HTMLElement>("button[data-fmt-port='out']");
    if (outPort && canvas.dataset.fmtEditable === "1") {
      startStageOutPortDrag(e, canvas, outPort);
      return;
    }

    const inPort = target.closest<HTMLElement>("[data-fmt-port='in']:not(.is-hidden-port)");
    if (inPort && canvas.dataset.fmtEditable === "1" && !ui.connectingFromRoundId) {
      startStageInPortDrag(e, canvas, inPort);
      return;
    }

    const viewport = canvas.closest<HTMLElement>("[data-rc-viewport]");
    const stageNode = target.closest<HTMLElement>("[data-stage-node]");
    if (
      viewport &&
      stageNode &&
      !ui.nodesLocked &&
      !target.closest(
        "button, select, input, a, .bkt-node-menu, .bkt-wire-menu, .bkt-port"
      )
    ) {
      startStageNodeDrag(e, viewport, canvas, stageNode);
    }
  };

  const onCancelSingleTouch = (): void => {
    if (cleanupGesture) cleanupGesture();
  };

  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("slaprf-cancel-single-touch", onCancelSingleTouch, true);
  return () => {
    if (cleanupGesture) cleanupGesture();
    root.removeEventListener("pointerdown", onPointerDown);
    root.removeEventListener("slaprf-cancel-single-touch", onCancelSingleTouch, true);
  };
}
