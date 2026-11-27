import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { fitScheduleLineups, scanTableScrollIndicators } from "../core/table_scroll";
import { adaptColorForTheme } from "../core/theme";
import {
  decodeBandChannel,
  encodeBandChannel,
  formatBandChannelShort,
  formatBandChannelWithFreq,
  formatEncodedChannelShort,
  formatSeatVoiceChannel,
  isValidEncodedSeatChannel,
} from "../core/vtx_channels";
import {
  buildRacesHash,
  getCurrentParsedHash,
  onRacesRouteTargetChange,
  onRacesTopBarCommand,
  pushAppHash,
  RacesRouteTarget,
  replaceAppHash,
  setRacesTopBarContext,
  slugifyRaceName,
} from "../core/router";
import { ApiClient } from "../services/api_client";
import { capabilitiesSnapshot } from "../services/capabilities";
import {
  Announcer,
  formatSpokenHeatLabel,
  isQualifierStageFormat,
  resolveHeatStageFormat,
} from "../services/announcer";
import { sharedMultiGPService } from "../services/multigp_service";
import { AppStore } from "../state/store";
import {
  EventPilot,
  HeatSeat,
  isLapRFMode,
  isRotorHazardMode,
  isSlapRFMode,
  PilotAttendance,
  RaceHeat,
  RaceLifecycle,
  RaceSetupConfig,
  RaceStage,
  RaceTournamentState,
  StageFormat,
  TournamentStanding,
} from "../types/models";
import {
  anyDownstreamStageStarted,
  applyCanvasCameraDom,
  bindBracketDragAndDrop,
  BracketEditorUiState,
  CanvasTool,
  clampZoom,
  collectStageRoundPositions,
  createDefaultBracketEditorUiState,
  drawBracketWires,
  fitCanvasToControlDashboard,
  fitCanvasToNodes,
  formatQualifyingMetricLabel,
  formatRaceClock,
  formatShortSec,
  formatStageLabel,
  getPresentStageIndices,
  handleBracketEditEvent,
  heatStateBadge,
  isChaseHeatId,
  isHandoffInRoundId,
  isHandoffPortalRound,
  isHeatCompletedOrRunning,
  isHeatUnstarted,
  isPilotsInRoundId,
  isRaceOngoing,
  isRootStage,
  raceLifecycleBadge,
  RC_NODE_WIDTH,
  CONTROL_PANEL_BOTTOM_CLEARANCE,
  DEFAULT_CONTROL_MIN_BOUNDARY_Y,
  renderBracketMarkup,
  roundNeedsDeleteConfirmation,
  suggestNewRoundSpawnPosition,
} from "../widgets/BracketDiagram";
import { openConfirmModal } from "../widgets/ConfirmModal";
import { openConfirmPreemptModal } from "../widgets/ConfirmPreemptModal";
import {
  bindFormatDragAndDrop,
  collectFormatStagePositions,
  drawFormatWires,
  fitCanvasToFormatStages,
  FMT_NODE_WIDTH,
  handleFormatEditEvent,
  renderFormatMarkup,
  resolveStagesList,
  stageNeedsDeleteConfirmation,
  suggestNewStageSpawnPosition,
} from "../widgets/FormatDiagram";
import {
  closeActiveRoundModal,
  openOpenQualifierSettingsModal,
  openRaceSettingsModal,
  openStageSettingsModal,
  openTemplatesModal,
  TemplateApplyParams,
} from "../widgets/RoundModals";
import {
  closeActiveLapEditorModal,
  openHeatLapEditorModal,
} from "../widgets/HeatLapEditorModal";
import {
  closeActivePilotLapsModal,
} from "../widgets/HeatPilotLapsModal";
import {
  closeActiveMultiGPModal,
  openMultiGPErrorModal,
  openMultiGPImportModal,
  openMultiGPSyncModal,
} from "../widgets/MultiGPRaceModals";
import { PilotRssiChart } from "../widgets/PilotRssiChart";
import { ScopedTrackWorkspace } from "../widgets/ScopedTrackWorkspace";
import { mountTagPillEditor, renderTagPillBoxHtml } from "../widgets/TagPillEditor";
import { cleanConnectionInvalidReason, showToast } from "../widgets/Toast";
import {
  dismissWireDropMenu,
  openWireDropMenu,
  WireDropOption,
} from "../widgets/WireDropMenu";
import {
  closeActiveDesktopTableModal,
  createDefaultDesktopRaceTableState,
  DesktopRaceTableCallbacks,
  DesktopRaceTableUiState,
  handleDesktopRaceTableChange,
  handleDesktopRaceTableClick,
  renderDesktopRaceTableEditorHtml,
  renderSetupRaceSubRibbonHtml,
  syncDesktopTableAfterRender,
} from "../widgets/DesktopRaceTableEditor";
import {
  closeActiveMobileEditorSheet,
  createDefaultMobileRaceEditorState,
  handleMobileRaceEditorChange,
  handleMobileRaceEditorClick,
  MobileRaceEditorCallbacks,
  MobileRaceEditorUiState,
  renderMobileRaceEditorHtml,
  syncMobileCarouselAfterRender,
} from "../widgets/MobileRaceEditor";
import { PilotView } from "./PilotView";

type WorkspaceTab = "pilots" | "track" | "format" | "edit" | "control" | "review" | "analytics" | "multigp";
type DesktopSetupViewMode = "graph" | "table";
type ControlPanelId =
  | "cockpit"
  | "heatline"
  | "flightline"
  | "schedule"
  | "standings"
  | "pilots"
  | "signals";
type ReviewPanelId = "review_heat" | "review_list" | "review_mgp" | "mgp_overall" | "mgp_heats";
type AnyCanvasPanelId = ControlPanelId | ReviewPanelId;
type PilotsSubFilter = "all" | "unassigned" | "assigned" | "inactive";
type FlightQueueFilter = "all" | "queued" | "flying" | "away";
type RaceDirStatusFilter = "all" | "setup" | "active" | "done";

interface ControlPanelLayout {
  visible: boolean;
  collapsed: boolean;
  x: number;
  y: number;
  zIndex: number;
  userMoved?: boolean;
  oqUserMoved?: boolean;
}

interface StoredCanvasPanelsLayout {
  controlPanels: Record<ControlPanelId, ControlPanelLayout>;
  reviewPanels: Record<ReviewPanelId, ControlPanelLayout>;
  editPilotsPanel: ControlPanelLayout;
  showGraph: boolean;
  canvasLocks?: Record<string, boolean>;
}

const CANVAS_LAYOUT_STORAGE_KEY = "slaprf.rc.canvasPanels.v13";
const RACE_CAMERAS_STORAGE_KEY = "slaprf.rc.cameras.v2";
const DESKTOP_SETUP_VIEW_STORAGE_KEY = "slaprf.rc.setupView.v1";

function loadStoredDesktopSetupView(): DesktopSetupViewMode {
  try {
    if (
      typeof window !== "undefined" &&
      window.localStorage.getItem(DESKTOP_SETUP_VIEW_STORAGE_KEY) === "table"
    ) {
      return "table";
    }
  } catch {
    // Ignore storage errors
  }
  return "graph";
}

function persistDesktopSetupView(mode: DesktopSetupViewMode): void {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(DESKTOP_SETUP_VIEW_STORAGE_KEY, mode);
    }
  } catch {
    // Ignore storage errors
  }
}

function compactRaceKey(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findMatchingRace(
  races: RaceTournamentState[],
  raceKey?: string
): RaceTournamentState | undefined {
  if (!raceKey) return undefined;
  const trimmed = raceKey.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  const slugged = slugifyRaceName(trimmed);
  const bySlug = races.find((r) => {
    const rSlug = slugifyRaceName(r.config?.eventName || "Race");
    return rSlug === lower || rSlug === slugged;
  });
  if (bySlug) return bySlug;
  const exact = races.find((r) => r.raceId === trimmed);
  if (exact) return exact;
  const compact = compactRaceKey(trimmed);
  if (!compact) return undefined;
  return (
    races.find((r) => compactRaceKey(r.config?.eventName ?? "") === compact) ??
    races.find((r) => compactRaceKey(r.raceId ?? "") === compact)
  );
}

function loadStoredRaceCameras(
  raceId: string
): BracketEditorUiState["stageCameras"] {
  if (!raceId) return {};
  try {
    const raw = window.localStorage.getItem(RACE_CAMERAS_STORAGE_KEY);
    if (!raw) return {};
    const all = JSON.parse(raw) as Record<
      string,
      Record<string, { panX: number; panY: number; zoom: number; initialized: boolean }>
    >;
    const entry = all?.[raceId];
    if (!entry || typeof entry !== "object") return {};
    const out: BracketEditorUiState["stageCameras"] = {};
    for (const [k, v] of Object.entries(entry)) {
      const slot = Number(k);
      if (
        Number.isFinite(slot) &&
        v &&
        v.initialized &&
        typeof v.panX === "number" &&
        Number.isFinite(v.panX) &&
        typeof v.panY === "number" &&
        Number.isFinite(v.panY) &&
        typeof v.zoom === "number" &&
        Number.isFinite(v.zoom) &&
        v.zoom > 0
      ) {
        out[slot] = { panX: v.panX, panY: v.panY, zoom: v.zoom, initialized: true };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function persistStoredRaceCameras(
  raceId: string,
  cameras: BracketEditorUiState["stageCameras"]
): void {
  if (!raceId) return;
  try {
    const raw = window.localStorage.getItem(RACE_CAMERAS_STORAGE_KEY);
    const all: Record<
      string,
      Record<string, { panX: number; panY: number; zoom: number; initialized: boolean }>
    > = raw ? (JSON.parse(raw) as Record<string, Record<string, { panX: number; panY: number; zoom: number; initialized: boolean }>>) : {};
    const serialized: Record<
      string,
      { panX: number; panY: number; zoom: number; initialized: boolean }
    > = {};
    for (const [k, cam] of Object.entries(cameras)) {
      if (cam?.initialized) {
        serialized[k] = {
          panX: cam.panX,
          panY: cam.panY,
          zoom: cam.zoom,
          initialized: true,
        };
      }
    }
    all[raceId] = serialized;
    // Keep storage bounded to most recent 40 races
    const keys = Object.keys(all);
    if (keys.length > 40) {
      for (let i = 0; i < keys.length - 40; i++) {
        delete all[keys[i]];
      }
    }
    window.localStorage.setItem(RACE_CAMERAS_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Ignore storage errors
  }
}

export function formatHeatClockDisplay(
  heat: Pick<RaceHeat, "elapsedSec" | "timeLimitSec">
): string {
  const elapsed = Math.max(0, Number(heat.elapsedSec) || 0);
  if (heat.timeLimitSec > 0) {
    return formatRaceClock(Math.max(0, heat.timeLimitSec - elapsed));
  }
  return formatRaceClock(elapsed);
}

export interface BinPackPanelInput {
  id: ControlPanelId;
  span: 1 | 2;
  visible: boolean;
  userMoved: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function computeBinPackedControlLayout(
  items: BinPackPanelInput[],
  opts?: { leftX?: number; rightX?: number; startY?: number; rowGap?: number }
): Record<string, { x: number; y: number }> {
  const leftX = opts?.leftX ?? 64;
  const rightX = opts?.rightX ?? 666;
  const startY = opts?.startY ?? 72;
  const rowGap = opts?.rowGap ?? 22;
  const colW = 578;

  const colBottom: [number, number] = [startY, startY];
  const result: Record<string, { x: number; y: number }> = {};

  for (const item of items) {
    if (!item.visible) continue;
    if (item.userMoved) {
      const overlapsLeft = item.x < leftX + colW && item.x + item.width > leftX;
      const overlapsRight = item.x < rightX + colW && item.x + item.width > rightX;
      const bottom = Math.round(item.y + item.height + rowGap);
      if (overlapsLeft && bottom > colBottom[0]) colBottom[0] = bottom;
      if (overlapsRight && bottom > colBottom[1]) colBottom[1] = bottom;
      continue;
    }
    if (item.span === 2) {
      const targetY = Math.max(colBottom[0], colBottom[1]);
      result[item.id] = { x: leftX, y: targetY };
      const nextY = Math.round(targetY + item.height + rowGap);
      colBottom[0] = nextY;
      colBottom[1] = nextY;
    } else {
      const col = colBottom[0] <= colBottom[1] ? 0 : 1;
      const targetX = col === 0 ? leftX : rightX;
      const targetY = colBottom[col];
      result[item.id] = { x: targetX, y: targetY };
      colBottom[col] = Math.round(targetY + item.height + rowGap);
    }
  }
  return result;
}

function createDefaultControlPanels(): Record<ControlPanelId, ControlPanelLayout> {
  return {
    cockpit: { visible: true, collapsed: false, x: 64, y: 72, zIndex: 15, userMoved: false },
    heatline: { visible: true, collapsed: false, x: 64, y: 364, zIndex: 14, userMoved: false },
    flightline: { visible: true, collapsed: false, x: 64, y: 734, zIndex: 13, userMoved: false },
    schedule: { visible: true, collapsed: false, x: 64, y: 734, zIndex: 13, userMoved: false },
    standings: { visible: true, collapsed: false, x: 64, y: 1116, zIndex: 12, userMoved: false },
    pilots: { visible: true, collapsed: false, x: 666, y: 734, zIndex: 16, userMoved: false },
    signals: { visible: true, collapsed: false, x: 64, y: 1498, zIndex: 11, userMoved: false },
  };
}

function createDefaultReviewPanels(): Record<ReviewPanelId, ControlPanelLayout> {
  return {
    review_list: { visible: true, collapsed: false, x: 64, y: 72, zIndex: 15, userMoved: false },
    review_heat: { visible: true, collapsed: false, x: 64, y: 420, zIndex: 14, userMoved: false },
    review_mgp: { visible: true, collapsed: false, x: 64, y: 780, zIndex: 13, userMoved: false },
    mgp_overall: { visible: true, collapsed: false, x: 64, y: 72, zIndex: 15, userMoved: false },
    mgp_heats: { visible: true, collapsed: false, x: 64, y: 420, zIndex: 14, userMoved: false },
  };
}

function createDefaultEditPilotsPanel(): ControlPanelLayout {
  return { visible: true, collapsed: false, x: -368, y: 110, zIndex: 14, userMoved: false };
}

function sanitizeStoredPanel(
  p: Partial<ControlPanelLayout> | undefined,
  def: ControlPanelLayout
): ControlPanelLayout {
  if (!p) return { ...def };
  return {
    visible: typeof p.visible === "boolean" ? p.visible : def.visible,
    collapsed: typeof p.collapsed === "boolean" ? p.collapsed : def.collapsed,
    x: typeof p.x === "number" && Number.isFinite(p.x) ? p.x : def.x,
    y: typeof p.y === "number" && Number.isFinite(p.y) ? p.y : def.y,
    zIndex: typeof p.zIndex === "number" && Number.isFinite(p.zIndex) ? p.zIndex : def.zIndex,
    userMoved: typeof p.userMoved === "boolean" ? p.userMoved : false,
    oqUserMoved: typeof p.oqUserMoved === "boolean" ? p.oqUserMoved : false,
  };
}

function compactPanelGroupZIndices(panels: ControlPanelLayout[], baseZ = 11): number {
  const ordered = [...panels].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
  let cur = baseZ;
  for (const item of ordered) {
    item.zIndex = cur++;
  }
  return cur - 1;
}

function loadStoredCanvasLayout(): StoredCanvasPanelsLayout {
  const defControl = createDefaultControlPanels();
  const defReview = createDefaultReviewPanels();
  const defEditPilots = createDefaultEditPilotsPanel();
  try {
    const raw = window.localStorage.getItem(CANVAS_LAYOUT_STORAGE_KEY);
    if (!raw) {
      return {
        controlPanels: defControl,
        reviewPanels: defReview,
        editPilotsPanel: defEditPilots,
        showGraph: false,
      };
    }
    const parsed = JSON.parse(raw) as Partial<StoredCanvasPanelsLayout>;
    const sanitizedLocks: Record<string, boolean> = {};
    if (parsed.canvasLocks && typeof parsed.canvasLocks === "object") {
      for (const [k, v] of Object.entries(parsed.canvasLocks)) {
        if (typeof v === "boolean") {
          sanitizedLocks[k] = v;
        }
      }
    }
    const controlPanels: Record<ControlPanelId, ControlPanelLayout> = {
      cockpit: { ...sanitizeStoredPanel(parsed.controlPanels?.cockpit, defControl.cockpit), visible: true, collapsed: false },
      heatline: { ...sanitizeStoredPanel(parsed.controlPanels?.heatline, defControl.heatline), visible: true, collapsed: false },
      flightline: { ...sanitizeStoredPanel(parsed.controlPanels?.flightline, defControl.flightline), visible: true, collapsed: false },
      schedule: { ...sanitizeStoredPanel(parsed.controlPanels?.schedule, defControl.schedule), visible: true, collapsed: false },
      standings: { ...sanitizeStoredPanel(parsed.controlPanels?.standings, defControl.standings), visible: true, collapsed: false },
      pilots: { ...sanitizeStoredPanel(parsed.controlPanels?.pilots, defControl.pilots), visible: true, collapsed: false },
      signals: { ...sanitizeStoredPanel(parsed.controlPanels?.signals, defControl.signals), visible: true, collapsed: false },
    };
    const reviewPanels: Record<ReviewPanelId, ControlPanelLayout> = {
      review_heat: {
        ...sanitizeStoredPanel(parsed.reviewPanels?.review_heat, defReview.review_heat),
        visible: true,
        collapsed: false,
      },
      review_list: {
        ...sanitizeStoredPanel(parsed.reviewPanels?.review_list, defReview.review_list),
        visible: true,
        collapsed: false,
      },
      review_mgp: {
        ...sanitizeStoredPanel(parsed.reviewPanels?.review_mgp, defReview.review_mgp),
        visible: true,
        collapsed: false,
      },
      mgp_overall: {
        ...sanitizeStoredPanel(parsed.reviewPanels?.mgp_overall, defReview.mgp_overall),
        visible: true,
        collapsed: false,
      },
      mgp_heats: {
        ...sanitizeStoredPanel(parsed.reviewPanels?.mgp_heats, defReview.mgp_heats),
        visible: true,
        collapsed: false,
      },
    };
    const editPilotsPanel = sanitizeStoredPanel(parsed.editPilotsPanel, defEditPilots);
    compactPanelGroupZIndices(Object.values(controlPanels), 11);
    compactPanelGroupZIndices(Object.values(reviewPanels), 14);
    editPilotsPanel.zIndex = 14;
    return {
      controlPanels,
      reviewPanels,
      editPilotsPanel,
      showGraph: false,
      canvasLocks: sanitizedLocks,
    };
  } catch {
    return {
      controlPanels: defControl,
      reviewPanels: defReview,
      editPilotsPanel: defEditPilots,
      showGraph: false,
    };
  }
}

interface TemplateCardSpec {
  id: string;
  title: string;
  tag: string;
  desc: string;
  stagesHint?: string;
}

const RACE_TEMPLATES: TemplateCardSpec[] = [
  {
    id: "double_elimination",
    title: "Double Elimination",
    tag: "MultiGP Standard",
    stagesHint: "Double Elimination Bracket",
    desc: "Winners & Redemption brackets into Finals. Two losses before elimination.",
  },
  {
    id: "qual_double_elim",
    title: "Qualifying + Double Elim",
    tag: "Qual + Bracket",
    stagesHint: "Qualifying -> Double Elimination",
    desc: "Timed qualifying rounds rank pilots first, then seed directly into Double Elimination.",
  },
  {
    id: "qual_ladder_mains",
    title: "Qualifying + Ladder Mains",
    tag: "Bump-Up Mains",
    stagesHint: "Qualifying -> C-Main -> B-Main -> A-Main",
    desc: "RotorHazard-style bump-up ladder: lower mains race first and top finishers bump up into the next Main all the way to A-Main.",
  },
  {
    id: "single_elimination",
    title: "Single Elimination",
    tag: "Knockout",
    stagesHint: "Direct Knockout Bracket",
    desc: "Direct head-to-head knockout bracket advancing top finishers each round.",
  },
  {
    id: "qual_single_elim",
    title: "Qualifying + Single Elim",
    tag: "Qual + Knockout",
    stagesHint: "Qualifying -> Single Elimination",
    desc: "Qualifying rounds rank pilots by Best 3 Consecutive Laps, then seed into a Single Elimination knockout bracket.",
  },
  {
    id: "qual_mains",
    title: "Qualifying + A/B/C Mains",
    tag: "Division Mains",
    stagesHint: "Qualifying -> A/B/C Mains",
    desc: "Qualifying heats sort pilots into parallel A, B, and C Main divisions scored by points.",
  },
  {
    id: "chase_the_ace",
    title: "Chase the Ace",
    tag: "Finals",
    stagesHint: "Chase the Ace Finals",
    desc: "Repeat finals heats until one contender reaches required wins to claim 1st.",
  },
  {
    id: "qual_chase_the_ace",
    title: "Qualifying + Chase the Ace",
    tag: "Qual + Finals",
    stagesHint: "Qualifying -> Chase the Ace Finals",
    desc: "Qualifying rounds seed the top contenders into a Chase the Ace Championship Finals round.",
  },
  {
    id: "open_qualifier",
    title: "Open Qualifier",
    tag: "Flight Queue",
    stagesHint: "Open Flight-Line Queue",
    desc: "ZippyQ / Global Qualifier style: queue heats on demand with sticky VTX channels & Best 3 Consecutive Laps.",
  },
  {
    id: "round_robin",
    title: "Multi-Round Heats",
    tag: "Open Rounds",
    stagesHint: "Multi-Round Rotation",
    desc: "Balanced multi-round heats for all active pilots with sticky VTX channels & anti-back-to-back rotation.",
  },
  {
    id: "cpq_qualifier",
    title: "Qualifier",
    tag: "Qualifying",
    stagesHint: "Qualifying Rounds",
    desc: "Pre-scheduled multi-round qualifying heats ranked by Fastest 3 Consecutive Laps.",
  },
  {
    id: "cpq_mains",
    title: "Qualifier + A/B/C Mains",
    tag: "Qual + Mains",
    stagesHint: "Qualifier -> A/B/C Mains",
    desc: "Qualifying heats ranked by Fastest 3 Consecutive Laps sort pilots by pace into A, B, and C Main finals divisions.",
  },
];

function defaultChannelsForCount(count: number): number[] {
  if (count <= 2) return [1, 8].slice(0, Math.max(2, count));
  if (count === 3) return [1, 4, 8];
  if (count === 4) return [1, 3, 5, 8];
  if (count === 5) return [1, 3, 5, 7, 8];
  if (count === 6) return [1, 2, 4, 5, 7, 8];
  return [1, 2, 3, 4, 5, 6, 7, 8].slice(0, Math.min(8, count));
}

function formatShortRaceDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function isRaceConfigured(r: RaceTournamentState): boolean {
  return Boolean(
    r.generated ||
      resolveStagesList(r).length > 0 ||
      (r.rounds?.length ?? 0) > 0 ||
      r.heats.length > 0
  );
}

function hasOpenQualifierRound(r: RaceTournamentState): boolean {
  if (r.config?.mainFormat === "open_qualifier") return true;
  if ((r.stages ?? []).some((s) => s.format === "open_qualifier")) return true;
  if ((r.rounds ?? []).some((rd) => rd.stageFormat === "open_qualifier")) return true;
  return (r.heats ?? []).some((h) => h.stageFormat === "open_qualifier");
}

function formatRaceSubtitle(r: RaceTournamentState): string {
  if (!isRaceConfigured(r)) return "Not configured yet";
  const tpl = RACE_TEMPLATES.find((t) => t.id === r.templateId);
  if (tpl) return tpl.title;
  if (r.templateId === "ladder_mains") return "Ladder Mains";
  if (r.templateId === "custom" || r.config.mainFormat === "custom") {
    const roundCount = (r.rounds ?? []).filter((rd) => !isHandoffPortalRound(rd)).length;
    return `Custom · ${roundCount} round${roundCount === 1 ? "" : "s"}`;
  }
  return formatStageLabel(r.config.mainFormat);
}

export class RacesView extends Component {
  private readonly store: AppStore;
  private readonly raceWorkspaceStore: AppStore;
  private readonly api: ApiClient;
  private readonly raceScopedApi: ApiClient;
  private readonly announcer?: Announcer;

  private showDirectory = false;
  private dirSearchQuery = "";
  private dirStatusFilter: RaceDirStatusFilter = "all";
  private selectedFilterTags = new Set<string>();
  private untaggedOnly = false;
  private editingNameForRaceId = "";
  private editingTagsForRaceId = "";
  private mobileSelectedRaceId = "";
  private lastOpenedMobileRaceId = "";
  private mobileRaceDrawerClosing = false;
  private mobileRaceDrawerCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private mobileRaceDrawerDragStartY: number | null = null;
  private pendingFocusRaceId = "";

  private activeTab: WorkspaceTab = "edit";
  private desktopSetupView: DesktopSetupViewMode = loadStoredDesktopSetupView();
  private prevRenderedSetupView: "" | DesktopSetupViewMode = "";
  private readonly desktopTableUi: DesktopRaceTableUiState =
    createDefaultDesktopRaceTableState();
  private readonly mobileEditorUi: MobileRaceEditorUiState =
    createDefaultMobileRaceEditorState();
  private lastWasMobileViewport =
    typeof window !== "undefined" ? window.innerWidth <= 860 : false;
  private attendanceExpanded = false;
  private showWalkUpForm = false;
  private walkUpCallsign = "";
  private walkUpPhonetic = "";
  private panelWalkUpCallsign = "";

  private draftPilotsPerHeat = 4;
  private draftTargetLaps = 3;
  private draftTimeLimitSec = 120;
  private draftQualRounds = 2;

  private lifecyclePrompt: "" | "pause_race" | "scrap_race" = "";
  private lifecycleReason = "";

  private scheduleFilter: "all" | "upcoming" | "done" = "all";
  private flightQueueFilter: FlightQueueFilter = "all";
  private standingsStage: "main" | "qualifying" = "main";
  private pilotsFilter: PilotsSubFilter = "all";
  private pilotsSearchQuery = "";
  private panAnimFrame = 0;
  private bracketStage = 0;
  private confirmReset = false;

  private fabOpen = false;
  private fabSubmenu: "" | "add" | "templates" | "panels" = "";
  private formatMenuOpen = false;
  private mobileStageMenuOpen = false;
  private openMarshalMenuKey = "";
  private readonly seatDisplayOrderByScope = new Map<string, number[]>();
  private lastConfigureTab: "format" | "edit" = "format";
  private prevRenderedModeGroup: "" | "configure" | "control" = "";
  private prevRenderedModeRaceId = "";
  private promptedTemplateRaceIds = new Set<string>();
  private controlPanels: Record<ControlPanelId, ControlPanelLayout>;
  private reviewPanels: Record<ReviewPanelId, ControlPanelLayout>;
  private editPilotsPanel: ControlPanelLayout;
  private canvasLocks: Record<string, boolean>;
  private panelZCounter = 20;
  private showGraphOnControl = false;
  private controlBoundaryY = 0;
  private zippyPullInFlight = false;
  private mgpUploadInFlight = false;
  private controlBoundaryRaceKey = "";
  private controlCamInitializedForRaceId = "";
  private reviewCamInitializedForRaceId = "";
  private formatCamInitializedForRaceId = "";
  private reviewSelectedHeatId = "";
  private mobileControlView: "live" | "queue" | "schedule" | "standings" | "signals" = "live";
  private raceSignalsChart: PilotRssiChart | null = null;
  private raceSignalsChartEl: HTMLElement | null = null;
  private raceSignalsSlot: number | null = null;
  private raceTrackView: ScopedTrackWorkspace | null = null;
  private raceTrackEl: HTMLElement | null = null;
  private raceTrackKey = "";
  private raceAnalyticsView: PilotView | null = null;
  private raceAnalyticsEl: HTMLElement | null = null;
  private dirOpenMenuRaceId = "";
  private lastMobileLapsCrossingId = 0;

  private errorMsg = "";
  private lastSig = "";
  private lastSyncedRaceId = "";
  private viewingRaceId = "";
  private pendingRouteTarget: RacesRouteTarget | null = null;
  private resolvingRouteRaceId = "";
  private tickTimer = 0;
  private rssiTimer = 0;
  private isViewActive = true;
  private autoPromptTemplateClose: (() => void) | null = null;
  private autoPromptTemplateRaceId = "";

  private dismissAutoPromptTemplateModal(): void {
    const closeFn = this.autoPromptTemplateClose;
    this.autoPromptTemplateClose = null;
    this.autoPromptTemplateRaceId = "";
    closeFn?.();
  }

  private disposeRaceSignalsChart(): void {
    if (this.raceSignalsChart) {
      this.raceSignalsChart.destroy();
      this.raceSignalsChart = null;
    }
    if (this.raceSignalsChartEl) {
      this.raceSignalsChartEl.remove();
      this.raceSignalsChartEl = null;
    }
  }

  private disposeRaceTrackView(): void {
    if (this.raceTrackView) {
      this.raceTrackView.destroy();
      this.raceTrackView = null;
    }
    if (this.raceTrackEl) {
      this.raceTrackEl.remove();
      this.raceTrackEl = null;
    }
    this.raceTrackKey = "";
  }

  private syncRaceTrackViewDom(): void {
    if (this.showDirectory || this.activeTab !== "track") return;
    const host = this.el.querySelector<HTMLElement>("[data-race-track-host]");
    if (!host) return;
    const cur = this.currentRace;
    const isRo = Boolean(
      cur.lifecycle === "completed" || cur.lifecycle === "scrapped" || cur.isComplete
    );
    const nextKey = `${cur.raceId ?? ""}:${isRo ? "ro" : "rw"}`;
    if (this.raceTrackView && this.raceTrackKey !== nextKey) {
      this.disposeRaceTrackView();
    }
    if (!this.raceTrackView || !this.raceTrackEl) {
      this.raceTrackKey = nextKey;
      this.raceTrackEl = document.createElement("div");
      this.raceTrackEl.className = "view rc-track-embedded";
      this.raceTrackView = new ScopedTrackWorkspace(
        this.raceTrackEl,
        this.raceWorkspaceStore,
        this.raceScopedApi,
        {
          contextLabel: "race",
          readOnly: () => {
            const r = this.currentRace;
            return Boolean(
              r.lifecycle === "completed" || r.lifecycle === "scrapped" || r.isComplete
            );
          },
        }
      );
    }
    if (this.raceTrackEl.parentElement !== host) {
      host.appendChild(this.raceTrackEl);
    }
  }

  private disposeRaceAnalyticsView(): void {
    if (this.raceAnalyticsView) {
      this.raceAnalyticsView.destroy();
      this.raceAnalyticsView = null;
    }
    if (this.raceAnalyticsEl) {
      this.raceAnalyticsEl.remove();
      this.raceAnalyticsEl = null;
    }
  }

  private syncRaceAnalyticsViewDom(): void {
    if (this.showDirectory || this.activeTab !== "analytics") return;
    const host = this.el.querySelector<HTMLElement>("[data-race-analytics-host]");
    if (!host) return;
    if (!this.raceAnalyticsView || !this.raceAnalyticsEl) {
      this.raceAnalyticsEl = document.createElement("div");
      this.raceAnalyticsEl.className = "view view-pilot rc-analytics-embedded";
      this.raceAnalyticsView = new PilotView(
        this.raceAnalyticsEl,
        this.store,
        () => ({ kind: "race", id: this.currentRace.raceId })
      );
    }
    if (this.raceAnalyticsEl.parentElement !== host) {
      host.appendChild(this.raceAnalyticsEl);
    }
    this.raceAnalyticsView.onActivate();
  }

  public override onDeactivate(): void {
    this.isViewActive = false;
    this.dismissAutoPromptTemplateModal();
    closeActiveRoundModal();
    closeActiveDesktopTableModal();
    closeActiveMobileEditorSheet();
    closeActiveLapEditorModal();
    closeActivePilotLapsModal();
    closeActiveMultiGPModal();
    dismissWireDropMenu();
    this.disposeRaceSignalsChart();
    this.disposeRaceTrackView();
    this.disposeRaceAnalyticsView();
    this.dirOpenMenuRaceId = "";
    this.fabOpen = false;
    this.fabSubmenu = "";
    this.formatMenuOpen = false;
    this.mobileStageMenuOpen = false;
    this.openMarshalMenuKey = "";
  }

  public override onActivate(): void {
    this.isViewActive = true;
    this.api.setViewingRaceId(this.viewingRaceId);
    this.syncDraftDefaultsFromRace();
    if (this.pendingRouteTarget && this.store.hasHydrated) {
      this.resolvePendingRouteIfReady(false);
    } else {
      this.lastSig = "";
      this.render();
      this.updateLiveClockDom();
      this.updateLiveRssiDom();
    }
    requestAnimationFrame(() => {
      if (this.disposed || !this.isViewActive || this.showDirectory) return;
      if (this.activeTab === "format") {
        drawFormatWires(this.el, this.currentRace, this.bktUi);
      } else if (this.activeTab === "edit") {
        drawBracketWires(this.el, this.currentRace, this.bktUi);
      }
    });
  }

  private setViewingRace(raceId: string): void {
    this.viewingRaceId = raceId.trim();
    this.api.setViewingRaceId(this.viewingRaceId);
  }

  private get currentRace(): RaceTournamentState {
    if (this.viewingRaceId) {
      const found = this.getEffectiveRaces().find((r) => r.raceId === this.viewingRaceId);
      if (found) return found;
    }
    return this.store.raceState;
  }

  private getActiveHeatForRace(race: RaceTournamentState = this.currentRace): RaceHeat | undefined {
    if (race.raceId && race.raceId === this.store.raceState.raceId) {
      return this.store.activeRaceHeat;
    }
    return race.heats.find((h) => h.id === race.activeHeatId);
  }

  private readonly bktUi: BracketEditorUiState = createDefaultBracketEditorUiState(() => {
    this.lastSig = "";
    this.render();
  });

  constructor(el: HTMLElement, store: AppStore, api: ApiClient, announcer?: Announcer) {
    super(el);
    this.store = store;
    this.raceWorkspaceStore = store.forRaceWorkspace(() => this.currentRace);
    this.api = api;
    this.raceScopedApi =
      typeof api.forScope === "function"
        ? api.forScope(() => {
            const id = this.currentRace.raceId;
            return id ? { kind: "race", id } : null;
          })
        : api;
    this.announcer = announcer;

    const storedLayout = loadStoredCanvasLayout();
    this.controlPanels = storedLayout.controlPanels;
    this.reviewPanels = storedLayout.reviewPanels;
    this.editPilotsPanel = storedLayout.editPilotsPanel;
    this.canvasLocks = storedLayout.canvasLocks ?? {};
    this.showGraphOnControl = storedLayout.showGraph;
    this.syncCanvasLockToUi();
    this.panelZCounter = Math.max(
      20,
      this.editPilotsPanel.zIndex,
      this.controlPanels.cockpit.zIndex,
      this.controlPanels.heatline.zIndex,
      this.controlPanels.flightline.zIndex,
      this.controlPanels.schedule.zIndex,
      this.controlPanels.standings.zIndex,
      this.controlPanels.pilots.zIndex,
      this.controlPanels.signals.zIndex,
      this.reviewPanels.review_heat.zIndex,
      this.reviewPanels.review_list.zIndex,
      this.reviewPanels.review_mgp.zIndex
    );

    this.bktUi.onSwitchStage = (st) => this.switchBracketStage(st);
    this.bktUi.onOpenFormat = () => this.switchWorkspaceTab("format");
    this.bktUi.onCameraChanged = () => this.saveCurrentCamera();
    this.bktUi.onPanelFocus = (panelId, panelEl) => {
      this.bringPanelToFront(panelId, panelEl);
    };
    this.bktUi.onPanelMoved = (panelId, x, y) => {
      if (this.activeTab === "edit" && panelId === "pilots") {
        this.editPilotsPanel.x = x;
        this.editPilotsPanel.y = y;
        this.editPilotsPanel.userMoved = true;
        this.persistControlLayout();
        return;
      }
      if (
        this.activeTab === "review" &&
        (panelId === "review_heat" || panelId === "review_list" || panelId === "review_mgp")
      ) {
        this.reviewPanels[panelId].x = x;
        this.reviewPanels[panelId].y = y;
        this.reviewPanels[panelId].userMoved = true;
        this.persistControlLayout();
        return;
      }
      if (
        panelId === "cockpit" ||
        panelId === "heatline" ||
        panelId === "flightline" ||
        panelId === "schedule" ||
        panelId === "standings" ||
        panelId === "pilots" ||
        panelId === "signals"
      ) {
        const race = this.currentRace;
        const viewStage = this.getCurrentViewStage(race);
        const isOpenQual =
          resolveStagesList(race).find((s) => s.index === viewStage)?.format === "open_qualifier";
        this.controlPanels[panelId].x = x;
        this.controlPanels[panelId].y = y;
        if (isOpenQual && (panelId === "standings" || panelId === "signals" || panelId === "flightline")) {
          this.controlPanels[panelId].oqUserMoved = true;
          if (panelId === "flightline") {
            this.controlPanels[panelId].userMoved = true;
          }
        } else {
          this.controlPanels[panelId].userMoved = true;
        }
        this.persistControlLayout();
        if (this.activeTab === "control" && this.showGraphOnControl) {
          drawBracketWires(this.el, this.currentRace, this.bktUi);
        }
      }
    };
    this.bktUi.onBoardContextAddMenu = (
      clientX,
      clientY,
      worldX,
      worldY,
      viaTouchLongPress
    ) => {
      this.openBoardContextAddMenu(clientX, clientY, worldX, worldY, viaTouchLongPress);
    };

    const initialParsed = getCurrentParsedHash();
    this.pendingRouteTarget = initialParsed.races ?? { tab: "directory" };
    this.resolvePendingRouteIfReady(false);

    el.addEventListener("pointerdown", this.handlePointerDownDismiss);
    el.addEventListener("click", this.handleClick);
    el.addEventListener("dblclick", this.handleDblClick);
    el.addEventListener("change", this.handleChange);
    el.addEventListener("focusout", this.handleFocusOut);
    el.addEventListener("input", this.handleInput);
    el.addEventListener("keydown", this.handleKeyDown);
    el.addEventListener("pointermove", this.handleMobileRaceDrawerPointerMove);
    el.addEventListener("pointerup", this.handleMobileRaceDrawerPointerUp);
    el.addEventListener("pointercancel", this.handleMobileRaceDrawerPointerUp);
    window.addEventListener("keydown", this.handleGlobalKeyDown);
    window.addEventListener("resize", this.handleResize);

    const unsubRoute = onRacesRouteTargetChange((target) => {
      this.pendingRouteTarget = target;
      this.resolvePendingRouteIfReady(false);
    });

    const unsubTopBar = onRacesTopBarCommand((cmd) => {
      if (cmd.type === "set-tab") {
        if (cmd.tab === "directory") {
          this.saveCurrentCamera();
          this.pendingRouteTarget = null;
          this.setViewingRace("");
          this.showDirectory = true;
          this.fabOpen = false;
          this.fabSubmenu = "";
          this.formatMenuOpen = false;
          this.bktUi.pilotsDrawerOpen = false;
          this.editingTagsForRaceId = "";
          this.syncWorkspaceHash(true);
          this.lastSig = "";
          this.render();
          this.triggerDesktopWorkspaceFade(false);
        } else {
          this.switchWorkspaceTab(cmd.tab, true);
        }
      } else if (cmd.type === "set-stage") {
        this.switchBracketStage(cmd.stage, true);
      } else if (cmd.type === "go-run") {
        this.mobileControlView = "live";
        if (this.activeTab !== "control") {
          this.switchWorkspaceTab("control", true);
        } else {
          this.lastSig = "";
          this.render();
        }
      }
    });

    const unbindDnd = bindBracketDragAndDrop(
      el,
      api,
      () => this.currentRace,
      this.bktUi,
      (msg) => this.reportErr(msg)
    );
    const unbindFmtDnd = bindFormatDragAndDrop(
      el,
      api,
      () => this.currentRace,
      this.bktUi,
      (msg) => this.reportErr(msg)
    );

    this.onDispose(() => {
      this.dismissAutoPromptTemplateModal();
      closeActiveRoundModal();
      closeActiveDesktopTableModal();
      closeActiveLapEditorModal();
      closeActivePilotLapsModal();
      closeActiveMultiGPModal();
      dismissWireDropMenu();
      this.disposeRaceSignalsChart();
    this.disposeRaceTrackView();
    this.disposeRaceAnalyticsView();
    this.dirOpenMenuRaceId = "";
      this.setViewingRace("");
      el.removeEventListener("pointerdown", this.handlePointerDownDismiss);
      el.removeEventListener("click", this.handleClick);
      el.removeEventListener("dblclick", this.handleDblClick);
      el.removeEventListener("change", this.handleChange);
      el.removeEventListener("focusout", this.handleFocusOut);
      el.removeEventListener("input", this.handleInput);
      el.removeEventListener("keydown", this.handleKeyDown);
      el.removeEventListener("pointermove", this.handleMobileRaceDrawerPointerMove);
      el.removeEventListener("pointerup", this.handleMobileRaceDrawerPointerUp);
      el.removeEventListener("pointercancel", this.handleMobileRaceDrawerPointerUp);
      if (this.mobileRaceDrawerCloseTimer !== null) {
        clearTimeout(this.mobileRaceDrawerCloseTimer);
        this.mobileRaceDrawerCloseTimer = null;
      }
      window.removeEventListener("keydown", this.handleGlobalKeyDown);
      window.removeEventListener("resize", this.handleResize);
      unsubRoute();
      unsubTopBar();
      unbindDnd();
      unbindFmtDnd();
      setRacesTopBarContext({
        tab: "directory",
        raceId: "",
        raceName: "",
        activeStage: 1,
        totalStages: 1,
        stageTitle: "",
      });
      window.clearInterval(this.tickTimer);
      window.clearInterval(this.rssiTimer);
      if (this.panAnimFrame) window.cancelAnimationFrame(this.panAnimFrame);
    });

    this.onDispose(
      store.subscribe(["race", "config"], () => {
        this.syncDraftDefaultsFromRace();
        if (!this.isViewActive) {
          return;
        }
        const active = document.activeElement;
        if (
          active &&
          (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) &&
          this.el.contains(active) &&
          !active.hasAttribute("data-live-safe")
        ) {
          this.updateLiveClockDom();
          return;
        }
        if (this.pendingRouteTarget && this.store.hasHydrated) {
          this.resolvePendingRouteIfReady(false);
          return;
        }
        this.renderIfNeeded();
        this.updateLiveClockDom();
      })
    );

    this.onDispose(
      sharedMultiGPService.subscribe(() => {
        if (!this.isViewActive) return;
        this.renderIfNeeded();
      })
    );

    if (this.announcer) {
      this.onDispose(
        this.announcer.subscribe(() => {
          if (!this.isViewActive || this.activeTab !== "control") return;
          const prevSig = this.lastSig;
          if (!this.patchCockpitAnnouncerDomInPlace()) {
            this.refreshSinglePanelDom("cockpit");
          }
          this.lastSig = prevSig;
        })
      );
    }

    this.tickTimer = window.setInterval(() => {
      if (!this.isViewActive) return;
      this.updateLiveClockDom();
    }, 80);

    this.rssiTimer = window.setInterval(() => {
      if (!this.isViewActive) return;
      this.updateLiveRssiDom();
    }, 125);

    const zippyTimer = window.setInterval(() => {
      if (!this.isViewActive || this.showDirectory || this.activeTab !== "control") return;
      this.autoRefreshZippyQIfIdle();
    }, 7000);
    this.onDispose(() => window.clearInterval(zippyTimer));

    this.syncDraftDefaultsFromRace();
    this.render();
  }

  private canvasLockKey(tab: WorkspaceTab = this.activeTab, stage?: number): string {
    if (tab === "format") return "format";
    if (tab === "control") return "control";
    if (tab === "review") return "review";
    if (tab === "multigp") return "multigp";
    const st = stage ?? this.getCurrentViewStage();
    return `stage:${st || 1}`;
  }

  private isCanvasLocked(tab: WorkspaceTab = this.activeTab, stage?: number): boolean {
    const key = this.canvasLockKey(tab, stage);
    const explicit = this.canvasLocks[key];
    if (typeof explicit === "boolean") {
      return explicit;
    }
    return tab === "control" || tab === "review" || tab === "multigp";
  }

  private syncCanvasLockToUi(tab: WorkspaceTab = this.activeTab, stage?: number): void {
    const locked = this.isCanvasLocked(tab, stage);
    this.bktUi.nodesLocked = locked;
    if (locked && this.fabOpen) {
      this.fabOpen = false;
      this.fabSubmenu = "";
    }
  }

  private setCanvasLocked(locked: boolean, tab: WorkspaceTab = this.activeTab, stage?: number): void {
    this.canvasLocks[this.canvasLockKey(tab, stage)] = locked;
    this.syncCanvasLockToUi(tab, stage);
    this.persistControlLayout();
  }

  private persistControlLayout(): void {
    try {
      const payload: StoredCanvasPanelsLayout = {
        controlPanels: this.controlPanels,
        reviewPanels: this.reviewPanels,
        editPilotsPanel: this.editPilotsPanel,
        showGraph: this.showGraphOnControl,
        canvasLocks: this.canvasLocks,
      };
      window.localStorage.setItem(CANVAS_LAYOUT_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage errors
    }
  }

  private isMultiGPVerified(): boolean {
    if (!sharedMultiGPService.isAvailable(this.store)) return false;
    const prefs = sharedMultiGPService.prefsFor(this.store.simulatorRunning, this.store);
    return Boolean(prefs.verified && prefs.apiKey.trim());
  }

  private isMobileViewport(): boolean {
    return typeof window !== "undefined" && window.innerWidth <= 860;
  }

  private getDesktopTableCallbacks(): DesktopRaceTableCallbacks {
    return {
      getRace: () => this.currentRace,
      getAllTags: () => this.store.allRaceTags,
      api: this.api,
      ui: this.desktopTableUi,
      onOpenPilotsTab: () => this.switchWorkspaceTab("pilots"),
      onOpenTemplates: () => this.openTemplatesDialog(),
      onOpenControlQueue: () => {
        this.mobileControlView = "queue";
        this.switchWorkspaceTab("control");
      },
      onOpenReviewHeat: (heatId: string) => {
        this.reviewSelectedHeatId = heatId;
        this.switchWorkspaceTab("review");
      },
      onError: (msg: string) => this.reportErr(msg),
      onUiMutated: () => {
        this.lastSig = "";
        this.render();
      },
    };
  }

  private getMobileEditorCallbacks(): MobileRaceEditorCallbacks {
    return {
      getRace: () => this.currentRace,
      getAllTags: () => this.store.allRaceTags,
      api: this.api,
      ui: this.mobileEditorUi,
      onOpenTemplates: () => this.openTemplatesDialog(),
      onOpenPilotsTab: () => this.switchWorkspaceTab("pilots"),
      onOpenQueueTab: () => {
        this.mobileControlView = "queue";
        this.switchWorkspaceTab("control");
      },
      onOpenReviewHeat: (heatId: string) => {
        this.reviewSelectedHeatId = heatId;
        this.switchWorkspaceTab("review");
      },
      onError: this.reportErr,
      onUiMutated: () => {
        this.lastSig = "";
        this.render();
      },
    };
  }

  private getPanelStateForActiveTab(panelId: string): ControlPanelLayout | null {
    if (this.activeTab === "pilots") {
      return panelId === "pilots" ? this.controlPanels.pilots : null;
    }
    if (this.activeTab === "edit") {
      return panelId === "pilots" ? this.editPilotsPanel : null;
    }
    if (this.activeTab === "multigp") {
      if (panelId === "mgp_overall" || panelId === "mgp_heats" || panelId === "review_mgp") {
        return this.reviewPanels[panelId];
      }
      return null;
    }
    if (this.activeTab === "review") {
      if (panelId === "review_heat" || panelId === "review_list" || panelId === "review_mgp") {
        return this.reviewPanels[panelId];
      }
      return null;
    }
    if (
      panelId === "cockpit" ||
      panelId === "heatline" ||
      panelId === "flightline" ||
      panelId === "schedule" ||
      panelId === "standings" ||
      panelId === "pilots" ||
      panelId === "signals"
    ) {
      return this.controlPanels[panelId];
    }
    return null;
  }

  private bringPanelToFront(panelId: string, panelEl?: HTMLElement | null): void {
    const p = this.getPanelStateForActiveTab(panelId);
    if (!p) return;
    if (this.panelZCounter >= 120) {
      if (this.activeTab === "review") {
        this.panelZCounter = compactPanelGroupZIndices(Object.values(this.reviewPanels), 14);
      } else {
        this.panelZCounter = compactPanelGroupZIndices(Object.values(this.controlPanels), 11);
      }
      this.el
        .querySelectorAll<HTMLElement>(".rc-canvas-panel[data-canvas-panel]")
        .forEach((node) => {
          const id = node.dataset.canvasPanel ?? "";
          const st = this.getPanelStateForActiveTab(id);
          if (st && !node.classList.contains("has-open-popover")) {
            node.style.zIndex = String(st.zIndex);
          }
        });
    }
    const nextZ = ++this.panelZCounter;
    p.zIndex = nextZ;
    const el =
      panelEl ??
      this.el.querySelector<HTMLElement>(`.rc-canvas-panel[data-canvas-panel="${CSS.escape(panelId)}"]`);
    if (el && !el.classList.contains("has-open-popover")) {
      el.style.zIndex = String(nextZ);
    }
    this.persistControlLayout();
  }

  private syncLastSig(): void {
    const race = this.currentRace;
    this.lastSig = this.computeSig(race, this.getActiveHeatForRace(race));
  }

  private syncFabActiveStatesDom(): void {
    if (this.fabOpen) {
      this.refreshFabMenuDom();
      return;
    }
    const fabEl = this.el.querySelector<HTMLElement>(".rc-fab-menu");
    if (!fabEl) return;
    const race = this.currentRace;
    const roster: EventPilot[] = race.roster ?? [];
    const checkedInCount = roster.filter((p) => p.checkedIn).length;

    fabEl.querySelectorAll<HTMLElement>("[data-fab-pilots-count]").forEach((el) => {
      el.textContent = `Pilots Roster (${checkedInCount})`;
    });
  }

  private findUnoccupiedCanvasSpot(
    width: number,
    height: number,
    preferred?: { x: number; y: number },
    ignoreEl?: Element | null
  ): { x: number; y: number } {
    const viewport = this.el.querySelector<HTMLElement>("[data-rc-viewport]");
    const world = this.el.querySelector<HTMLElement>("[data-rc-world]");
    const vpRect = viewport?.getBoundingClientRect();
    const z = this.bktUi.zoom || 1;
    const vw = vpRect?.width || 1280;
    const vh = vpRect?.height || 760;

    const obstacles: Array<{ x: number; y: number; w: number; h: number }> = [];
    if (world) {
      world
        .querySelectorAll<HTMLElement>(".rc-canvas-panel, .bkt-round-node, .fmt-stage-node")
        .forEach((el) => {
          if (el === ignoreEl || el.closest("[hidden]") || el.offsetWidth <= 0) return;
          const x = Number(el.dataset.posX ?? 0);
          const y = Number(el.dataset.posY ?? 0);
          obstacles.push({
            x,
            y,
            w: el.offsetWidth || 300,
            h: el.offsetHeight || 220,
          });
        });
    }

    const baseX =
      preferred?.x ?? Math.round(Math.max(48, (Math.min(110, vw * 0.1) - this.bktUi.panX) / z));
    const baseY =
      preferred?.y ?? Math.round(Math.max(64, (Math.min(104, vh * 0.12) - this.bktUi.panY) / z));

    const pad = 24;
    const isClear = (cx: number, cy: number): boolean =>
      !obstacles.some(
        (o) =>
          cx < o.x + o.w + pad &&
          cx + width + pad > o.x &&
          cy < o.y + o.h + pad &&
          cy + height + pad > o.y
      );

    if (isClear(baseX, baseY)) {
      return { x: baseX, y: baseY };
    }

    const stepX = Math.max(320, Math.round(width * 0.85) + 32);
    const stepY = Math.max(240, Math.round(height * 0.75) + 32);
    const offsets: Array<[number, number]> = [
      [stepX, 0],
      [0, stepY],
      [-stepX, 0],
      [stepX, stepY],
      [stepX * 2, 0],
      [0, stepY * 2],
      [-stepX, stepY],
      [stepX * 2, stepY],
      [0, -stepY],
      [stepX, -stepY],
    ];
    for (const [dx, dy] of offsets) {
      const cx = Math.round(baseX + dx);
      const cy = Math.round(Math.max(48, baseY + dy));
      if (isClear(cx, cy)) {
        return { x: cx, y: cy };
      }
    }

    let maxRight = baseX;
    for (const o of obstacles) {
      if (o.x + o.w + 36 > maxRight) maxRight = Math.round(o.x + o.w + 36);
    }
    return { x: maxRight, y: baseY };
  }

  private smoothPanWorldRectIntoView(x: number, y: number, w: number, h: number): void {
    const viewport = this.el.querySelector<HTMLElement>("[data-rc-viewport]");
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const z = this.bktUi.zoom || 1;
    const padX = 56;
    const padY = 72;
    let targetPanX = this.bktUi.panX;
    let targetPanY = this.bktUi.panY;

    const leftScreen = targetPanX + x * z;
    const rightScreen = targetPanX + (x + w) * z;
    if (w * z > rect.width - padX * 2) {
      targetPanX = padX - x * z;
    } else if (rightScreen > rect.width - padX) {
      targetPanX = rect.width - padX - (x + w) * z;
    } else if (leftScreen < padX) {
      targetPanX = padX - x * z;
    }

    const topScreen = targetPanY + y * z;
    const bottomScreen = targetPanY + (y + h) * z;
    if (h * z > rect.height - padY * 2) {
      targetPanY = padY - y * z;
    } else if (bottomScreen > rect.height - padY) {
      targetPanY = rect.height - padY - (y + h) * z;
    } else if (topScreen < padY) {
      targetPanY = padY - y * z;
    }

    const startPanX = this.bktUi.panX;
    const startPanY = this.bktUi.panY;
    if (Math.hypot(targetPanX - startPanX, targetPanY - startPanY) < 2) {
      return;
    }

    if (this.panAnimFrame) {
      window.cancelAnimationFrame(this.panAnimFrame);
      this.panAnimFrame = 0;
    }
    const startAt = performance.now();
    const durationMs = 260;

    const step = (now: number): void => {
      if (this.disposed) return;
      const t = Math.min(1, Math.max(0, (now - startAt) / durationMs));
      const ease = 1 - Math.pow(1 - t, 3);
      this.bktUi.panX = startPanX + (targetPanX - startPanX) * ease;
      this.bktUi.panY = startPanY + (targetPanY - startPanY) * ease;
      applyCanvasCameraDom(viewport, this.bktUi);
      if (t < 1) {
        this.panAnimFrame = window.requestAnimationFrame(step);
      } else {
        this.panAnimFrame = 0;
        this.saveCurrentCamera();
      }
    };
    this.panAnimFrame = window.requestAnimationFrame(step);
  }

  private flashJustAddedElement(
    el: HTMLElement | null,
    cls = "rc-just-added",
    durationMs = 1450
  ): void {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    window.setTimeout(() => {
      el.classList.remove(cls);
    }, durationMs);
  }

  private renderHeatGraphJumpBtn(
    heat: RaceHeat,
    opts?: { panelHeader?: boolean; iconSize?: number }
  ): string {
    const stg = heat.stageIndex || 1;
    const label = heat.shortLabel || heat.title || heat.id;
    const title = `View ${label} in Stage ${stg} graph`;
    const cls = opts?.panelHeader ? "rc-panel-icon-btn" : "rc-heat-graph-link";
    const sz = opts?.iconSize ?? 13;
    return `<button type="button" class="${cls}" data-race-act="focus-heat-graph" data-heat-id="${esc(heat.id)}" title="${esc(title)}" aria-label="${esc(title)}">${icons.arrowRight(sz)}</button>`;
  }

  private jumpToHeatInStageGraph(heatId: string): void {
    const race = this.currentRace;
    const heat = (race.heats ?? []).find((h) => h.id === heatId);
    if (!heat) return;

    if (!this.showDirectory) {
      this.saveCurrentCamera();
    }

    const targetStage = heat.stageIndex || this.getControlStageIndex(race) || 1;
    this.bracketStage = targetStage;
    this.lastConfigureTab = "edit";
    this.showDirectory = false;
    this.activeTab = "edit";
    this.syncCanvasLockToUi("edit", targetStage);
    this.fabOpen = false;
    this.fabSubmenu = "";
    this.formatMenuOpen = false;
    this.mobileStageMenuOpen = false;
    this.openMarshalMenuKey = "";
    this.refreshFabMenuDom();
    this.bktUi.connectingFromRoundId = "";
    this.bktUi.connectingFromPortDir = "right";
    this.bktUi.openWireMenuId = "";
    this.bktUi.openNodeMenuId = "";
    this.bktUi.selectedRoundIds.clear();
    if (heat.roundId) {
      this.bktUi.selectedRoundIds.add(heat.roundId);
    }

    const saved = this.bktUi.stageCameras[this.cameraSlotKey("edit", targetStage)];
    if (saved?.initialized) {
      this.bktUi.panX = saved.panX;
      this.bktUi.panY = saved.panY;
      this.bktUi.zoom = saved.zoom;
    }

    this.syncWorkspaceHash(true);
    if (!this.isMobileViewport() && typeof window !== "undefined" && window.scrollY !== 0) {
      window.scrollTo(0, 0);
    }

    this.lastSig = "";
    this.render();

    const centerTargetInStage = (withFlash: boolean): void => {
      if (this.disposed || this.showDirectory || this.activeTab !== "edit") return;
      const vp = this.el.querySelector<HTMLElement>("[data-rc-viewport]");
      if (!vp) return;
      drawBracketWires(this.el, this.currentRace, this.bktUi);

      const escapedHeatId =
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape(heat.id)
          : heat.id.replace(/"/g, '\\"');
      const escapedRoundId =
        heat.roundId && typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape(heat.roundId)
          : (heat.roundId || "").replace(/"/g, '\\"');

      const heatCardEl = vp.querySelector<HTMLElement>(`[data-heat-card="${escapedHeatId}"]`);
      const roundNodeEl =
        heatCardEl?.closest<HTMLElement>("[data-round-node]") ??
        (escapedRoundId
          ? vp.querySelector<HTMLElement>(`[data-round-node="${escapedRoundId}"]`)
          : null) ??
        vp.querySelector<HTMLElement>("[data-round-node].is-open-qual-node") ??
        vp.querySelector<HTMLElement>("[data-round-node]");

      if (roundNodeEl?.dataset.roundNode) {
        this.bktUi.selectedRoundIds.clear();
        this.bktUi.selectedRoundIds.add(roundNodeEl.dataset.roundNode);
        roundNodeEl.classList.add("is-selected-node");
      }

      const anchorEl = heatCardEl ?? roundNodeEl;
      if (!anchorEl) {
        fitCanvasToNodes(this.el, this.bktUi);
        this.saveCurrentCamera();
        return;
      }

      const vpRect = vp.getBoundingClientRect();
      if (vpRect.width <= 0 || vpRect.height <= 0) return;

      const anchorRect = anchorEl.getBoundingClientRect();
      const curZ = this.bktUi.zoom || 1;
      const worldCenterX =
        (anchorRect.left - vpRect.left + anchorRect.width / 2 - this.bktUi.panX) / curZ;
      const worldCenterY =
        (anchorRect.top - vpRect.top + anchorRect.height / 2 - this.bktUi.panY) / curZ;

      const targetZoom = vpRect.width <= 768 ? 0.78 : 0.88;
      this.bktUi.zoom = targetZoom;
      this.bktUi.panX = Math.round(vpRect.width / 2 - worldCenterX * targetZoom);
      this.bktUi.panY = Math.round(vpRect.height * 0.52 - worldCenterY * targetZoom);
      applyCanvasCameraDom(vp, this.bktUi);
      this.saveCurrentCamera();

      if (withFlash) {
        if (heatCardEl) {
          this.flashJustAddedElement(heatCardEl, "rc-focused-heat", 1800);
        }
        if (roundNodeEl) {
          this.flashJustAddedElement(roundNodeEl, "rc-just-added", 1500);
        }
      }
    };

    centerTargetInStage(false);
    requestAnimationFrame(() => {
      centerTargetInStage(true);
    });
  }

  private addPanelToCanvas(
    panelId: AnyCanvasPanelId | "graph",
    preferredSpot?: { x: number; y: number }
  ): void {
    this.fabOpen = false;
    this.fabSubmenu = "";
    if (this.isCanvasLocked()) {
      this.setCanvasLocked(false);
      this.refreshBoardControlsDom();
    }

    if (panelId === "graph") {
      if (!this.showGraphOnControl) {
        this.showGraphOnControl = true;
        this.persistControlLayout();
        this.refreshGraphVisibilityDom();
      }
      this.refreshFabMenuDom();
      const firstNode = this.el.querySelector<HTMLElement>("[data-rc-world] .bkt-round-node");
      if (firstNode) {
        const x = Number(firstNode.dataset.posX ?? 0);
        const y = Number(firstNode.dataset.posY ?? 0);
        this.smoothPanWorldRectIntoView(
          x,
          y,
          firstNode.offsetWidth || RC_NODE_WIDTH,
          firstNode.offsetHeight || 240
        );
        this.el
          .querySelectorAll<HTMLElement>("[data-rc-world] .bkt-round-node")
          .forEach((n) => this.flashJustAddedElement(n));
      }
      return;
    }

    const p = this.getPanelStateForActiveTab(panelId);
    if (!p) {
      this.refreshFabMenuDom();
      return;
    }
    if (p.visible) {
      this.refreshFabMenuDom();
      return;
    }

    const estSizes: Record<AnyCanvasPanelId, { w: number; h: number }> = {
      cockpit: { w: 1180, h: 250 },
      heatline: { w: 1180, h: 360 },
      flightline: { w: 578, h: 360 },
      schedule: { w: 578, h: 360 },
      standings: { w: 578, h: 360 },
      pilots: { w: 350, h: 480 },
      signals: { w: 1180, h: 420 },
      review_heat: { w: 1180, h: 340 },
      review_list: { w: 1180, h: 360 },
      review_mgp: { w: 1180, h: 340 },
      mgp_overall: { w: 1180, h: 340 },
      mgp_heats: { w: 1180, h: 340 },
    };
    const est = estSizes[panelId];
    const spot = this.findUnoccupiedCanvasSpot(est.w, est.h, preferredSpot);

    p.x = spot.x;
    p.y = spot.y;
    p.visible = true;
    p.collapsed = false;
    p.userMoved = true;
    p.zIndex = ++this.panelZCounter;

    this.persistControlLayout();
    this.refreshSinglePanelDom(panelId);
    this.refreshFabMenuDom();

    const panelEl = this.el.querySelector<HTMLElement>(
      `.rc-canvas-panel[data-canvas-panel="${CSS.escape(panelId)}"]`
    );
    this.smoothPanWorldRectIntoView(
      p.x,
      p.y,
      panelEl?.offsetWidth || est.w,
      panelEl?.offsetHeight || est.h
    );
    this.flashJustAddedElement(panelEl);
  }

  private refreshFabMenuDom(): void {
    if (this.showDirectory) {
      const fabEl = this.el.querySelector<HTMLElement>(".rc-fab-menu");
      if (fabEl) {
        fabEl.classList.toggle("is-open", this.fabOpen);
        const drawer = fabEl.querySelector<HTMLElement>(".rc-fab-drawer");
        if (drawer) {
          drawer.setAttribute("aria-hidden", this.fabOpen ? "false" : "true");
          if (this.fabOpen) drawer.removeAttribute("inert");
          else drawer.setAttribute("inert", "");
        }
        const mainBtn = fabEl.querySelector<HTMLButtonElement>(".rc-fab-main");
        if (mainBtn) {
          mainBtn.setAttribute("aria-expanded", this.fabOpen ? "true" : "false");
        }
      }
      this.syncLastSig();
      return;
    }
    const fabEl = this.el.querySelector<HTMLElement>(".rc-fab-menu");
    if (!fabEl) {
      this.syncLastSig();
      return;
    }
    const locked = this.isCanvasLocked();
    if (locked) {
      this.fabOpen = false;
      this.fabSubmenu = "";
      fabEl.classList.remove("is-open", "is-submenu");
      fabEl.setAttribute("hidden", "");
      this.syncLastSig();
      return;
    }
    fabEl.removeAttribute("hidden");

    const race = this.currentRace;
    const mode = this.activeTab;
    const wasOpen = fabEl.classList.contains("is-open");
    const inSubmenu = this.fabOpen && this.fabSubmenu !== "";
    const drawer = fabEl.querySelector<HTMLElement>(".rc-fab-drawer");
    const mainBtn = fabEl.querySelector<HTMLButtonElement>(".rc-fab-main");

    if (mainBtn) {
      mainBtn.setAttribute("aria-expanded", this.fabOpen ? "true" : "false");
      mainBtn.setAttribute("aria-label", inSubmenu ? "Back" : "Add to board");
      mainBtn.title = inSubmenu
        ? "Back"
        : this.fabOpen
          ? "Close add menu"
          : mode === "format"
            ? "Add stage to board"
            : mode === "edit"
              ? "Add round or panel to board"
              : "Add panel to board";
    }

    if (!this.fabOpen) {
      // Keep current .rc-fab-items in DOM so CSS smoothly stows/fades items downward!
      fabEl.classList.remove("is-open", "is-submenu");
      if (drawer) {
        drawer.setAttribute("aria-hidden", "true");
        drawer.setAttribute("inert", "");
      }
      this.syncLastSig();
      return;
    }

    if (drawer) {
      drawer.setAttribute("aria-hidden", "false");
      drawer.removeAttribute("inert");
      const currentItems = drawer.querySelector<HTMLElement>(".rc-fab-items:not(.is-leaving)");
      const prevSub = currentItems?.dataset.fabSubmenu ?? "";
      const nextHtml = this.renderSpeedDialItems(race, mode, this.fabSubmenu);

      if (!wasOpen) {
        drawer.querySelectorAll(".rc-fab-items.is-leaving").forEach((el) => el.remove());
        if (currentItems) {
          currentItems.dataset.fabSubmenu = this.fabSubmenu;
          currentItems.innerHTML = nextHtml;
        } else {
          drawer.innerHTML = `<div class="rc-fab-items" data-fab-submenu="${this.fabSubmenu}">${nextHtml}</div>`;
        }
        // Flush closed transform before adding .is-open so rows cascade smoothly upward
        void drawer.offsetHeight;
      } else if (prevSub !== this.fabSubmenu && currentItems) {
        drawer.querySelectorAll(".rc-fab-items.is-leaving").forEach((el) => el.remove());
        currentItems.classList.add("is-leaving");
        window.setTimeout(() => currentItems.remove(), 190);

        const nextWrap = document.createElement("div");
        nextWrap.className = "rc-fab-items is-sub-enter";
        nextWrap.dataset.fabSubmenu = this.fabSubmenu;
        nextWrap.innerHTML = nextHtml;
        drawer.appendChild(nextWrap);
        requestAnimationFrame(() => {
          nextWrap.classList.remove("is-sub-enter");
        });
      } else if (currentItems) {
        currentItems.dataset.fabSubmenu = this.fabSubmenu;
        currentItems.innerHTML = nextHtml;
      }
    }

    fabEl.classList.add("is-open");
    fabEl.classList.toggle("is-submenu", inSubmenu);
    this.syncLastSig();
  }

  private refreshBoardControlsDom(): void {
    if (this.showDirectory) return;
    this.syncCanvasLockToUi();
    const vp = this.el.querySelector<HTMLElement>("[data-rc-viewport]");
    if (vp) {
      if (vp.scrollLeft !== 0) vp.scrollLeft = 0;
      if (vp.scrollTop !== 0) vp.scrollTop = 0;
      if (this.activeTab === "edit" || this.activeTab === "format") {
        vp.classList.toggle("tool-pan", this.bktUi.tool === "pan");
        vp.classList.toggle("tool-select", this.bktUi.tool === "select");
      }
      vp.classList.toggle("is-nodes-locked", this.bktUi.nodesLocked);
    }
    const fabEl = this.el.querySelector<HTMLElement>(".rc-fab-menu");
    if (fabEl) {
      if (this.bktUi.nodesLocked) {
        this.fabOpen = false;
        this.fabSubmenu = "";
        fabEl.classList.remove("is-open", "is-submenu");
        fabEl.setAttribute("hidden", "");
      } else {
        fabEl.removeAttribute("hidden");
      }
    }
    const ctrlEl = this.el.querySelector<HTMLElement>(".rc-board-controls");
    if (ctrlEl) {
      ctrlEl.outerHTML = this.renderBoardControlsPill(this.currentRace, this.activeTab);
    }
    this.syncLastSig();
  }

  private syncDefaultControlBottomRowDom(): void {
    if (this.activeTab !== "control") {
      return;
    }
    const race = this.currentRace;
    const viewStage = this.getCurrentViewStage(race);
    const isOpenQual = hasOpenQualifierRound(race);

    const isPanelUserMoved = (id: ControlPanelId): boolean => {
      const p = this.controlPanels[id];
      if (isOpenQual && (id === "standings" || id === "signals")) {
        return Boolean(p.oqUserMoved);
      }
      if (id === "flightline") {
        return Boolean(p.oqUserMoved || p.userMoved);
      }
      return Boolean(p.userMoved);
    };

    const measurePanelHeight = (id: ControlPanelId, fallbackExpanded: number): number => {
      const p = this.controlPanels[id];
      const el = this.el.querySelector<HTMLElement>(`[data-canvas-panel="${id}"]`);
      if (el && el.offsetHeight >= 30) {
        return el.offsetHeight;
      }
      return p.collapsed ? 44 : fallbackExpanded;
    };

    // Ideal 2-column bin-packing order:
    // 1. Race Control (2w)
    // 2. Flight Line (2w)
    // 3. Flight Queue (1w, open_qualifier) | Heats Schedule (1w)
    // 4. Overall Standings (2w)
    // 5. Signal at each timer (2w)
    // (+ Pilots Roster 1w when toggled visible)
    const specs: Array<{ id: ControlPanelId; span: 1 | 2; width: number; fallbackH: number }> = [
      { id: "cockpit", span: 2, width: 1180, fallbackH: 272 },
      { id: "heatline", span: 2, width: 1180, fallbackH: 348 },
      ...(isOpenQual
        ? [{ id: "flightline" as const, span: 1 as const, width: 578, fallbackH: 360 }]
        : []),
      { id: "schedule", span: 1, width: 578, fallbackH: 360 },
      { id: "pilots", span: 1, width: 400, fallbackH: 360 },
      { id: "standings", span: 2, width: 1180, fallbackH: 360 },
      { id: "signals", span: 2, width: 1180, fallbackH: 420 },
    ];

    const inputs: BinPackPanelInput[] = specs.map((sp) => {
      const p = this.controlPanels[sp.id];
      return {
        id: sp.id,
        span: sp.span,
        visible: Boolean(p.visible),
        userMoved: isPanelUserMoved(sp.id),
        x: p.x,
        y: p.y,
        width: sp.width,
        height: measurePanelHeight(sp.id, sp.fallbackH),
      };
    });

    const packed = computeBinPackedControlLayout(inputs, {
      leftX: 64,
      rightX: 666,
      startY: 72,
      rowGap: 22,
    });

    for (const sp of specs) {
      const target = packed[sp.id];
      if (!target) continue;
      const p = this.controlPanels[sp.id];
      if (Math.abs(p.x - target.x) >= 1 || Math.abs(p.y - target.y) >= 1) {
        p.x = target.x;
        p.y = target.y;
        const el = this.el.querySelector<HTMLElement>(`[data-canvas-panel="${sp.id}"]`);
        if (el) {
          el.dataset.posX = String(p.x);
          el.dataset.posY = String(p.y);
          el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
        }
      }
    }

    this.syncControlBoundaryDom();
  }

  private syncControlBoundaryDom(): void {
    if (this.activeTab !== "control") return;
    const world = this.el.querySelector<HTMLElement>("[data-rc-world]");
    if (!world) return;

    const race = this.currentRace;
    const viewStage = this.getCurrentViewStage(race);
    const isOpenQual = hasOpenQualifierRound(race);
    const raceStageKey = `${race.raceId || "default"}:${viewStage}`;
    if (this.controlBoundaryRaceKey !== raceStageKey) {
      this.controlBoundaryRaceKey = raceStageKey;
      this.controlBoundaryY = 0;
    }

    let defaultMaxBottom = -Infinity;
    let allVisibleMaxBottom = -Infinity;
    let minPrimaryX = Infinity;

    for (const id of [
      "cockpit",
      "heatline",
      "flightline",
      "schedule",
      "standings",
      "pilots",
      "signals",
    ] as const) {
      if (id === "flightline" && !isOpenQual) continue;
      const p = this.controlPanels[id];
      if (!p.visible) continue;
      const el = world.querySelector<HTMLElement>(`[data-canvas-panel="${id}"]`);
      const h = el && el.offsetHeight > 24 ? el.offsetHeight : p.collapsed ? 44 : 260;
      const bottom = p.y + h;
      if (bottom > allVisibleMaxBottom) allVisibleMaxBottom = bottom;
      if (!p.userMoved && bottom > defaultMaxBottom) defaultMaxBottom = bottom;
      if (
        (id === "cockpit" ||
          id === "heatline" ||
          id === "flightline" ||
          id === "schedule" ||
          id === "standings" ||
          id === "signals") &&
        p.x < minPrimaryX
      ) {
        minPrimaryX = p.x;
      }
    }

    if (this.controlBoundaryY <= 0) {
      const baseBottom = Number.isFinite(allVisibleMaxBottom) ? allVisibleMaxBottom + 56 : DEFAULT_CONTROL_MIN_BOUNDARY_Y;
      this.controlBoundaryY = Math.round(Math.max(DEFAULT_CONTROL_MIN_BOUNDARY_Y, baseBottom));
    } else if (Number.isFinite(defaultMaxBottom) && defaultMaxBottom + 36 > this.controlBoundaryY) {
      this.controlBoundaryY = Math.round(defaultMaxBottom + 56);
    }

    if (this.showGraphOnControl && this.controlBoundaryY > 0) {
      for (const id of [
        "cockpit",
        "heatline",
        "flightline",
        "schedule",
        "standings",
        "pilots",
        "signals",
      ] as const) {
        if (id === "flightline" && !isOpenQual) continue;
        const p = this.controlPanels[id];
        if (!p.visible) continue;
        const el = world.querySelector<HTMLElement>(`[data-canvas-panel="${id}"]`);
        const h = el && el.offsetHeight > 24 ? el.offsetHeight : p.collapsed ? 44 : 260;
        if (16 + h + CONTROL_PANEL_BOTTOM_CLEARANCE > this.controlBoundaryY) {
          this.controlBoundaryY = Math.round(16 + h + 44);
        }
        const maxAllowedY = Math.max(
          16,
          Math.round((this.controlBoundaryY - h - CONTROL_PANEL_BOTTOM_CLEARANCE) * 10) / 10
        );
        if (p.y > maxAllowedY) {
          p.y = maxAllowedY;
          if (el) {
            el.dataset.posX = String(p.x);
            el.dataset.posY = String(p.y);
            el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
          }
        }
      }
    }

    world.dataset.controlBoundaryY = String(this.controlBoundaryY);
    const dividerEl = world.querySelector<HTMLElement>("[data-rc-control-divider]");
    if (dividerEl) {
      const badgeLeft = Number.isFinite(minPrimaryX) ? minPrimaryX : 64;
      dividerEl.style.transform = `translate3d(0px, ${this.controlBoundaryY}px, 0)`;
      const badgesEl = dividerEl.querySelector<HTMLElement>(".rc-control-stage-divider-badges");
      if (badgesEl) {
        badgesEl.style.transform = `translate3d(${badgeLeft}px, 0px, 0)`;
      }
    }
  }

  private syncDefaultReviewPanelsDom(): void {
    if (this.activeTab !== "review") return;
    const placePanel = (id: ReviewPanelId, targetX: number, targetY: number): void => {
      const p = this.reviewPanels[id];
      if (!p.visible || p.userMoved) return;
      if (Math.abs(p.x - targetX) >= 1 || Math.abs(p.y - targetY) >= 1) {
        p.x = targetX;
        p.y = targetY;
        const el = this.el.querySelector<HTMLElement>(`[data-canvas-panel="${id}"]`);
        if (el) {
          el.dataset.posX = String(p.x);
          el.dataset.posY = String(p.y);
          el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
        }
      }
    };

    placePanel("review_list", 64, 72);
    const rlEl = this.el.querySelector<HTMLElement>('[data-canvas-panel="review_list"]');
    const heatY =
      this.reviewPanels.review_list.visible &&
      !this.reviewPanels.review_list.userMoved &&
      rlEl &&
      rlEl.offsetHeight >= 30
        ? Math.round(this.reviewPanels.review_list.y + rlEl.offsetHeight + 22)
        : 72;
    placePanel("review_heat", 64, heatY);
    const rhEl = this.el.querySelector<HTMLElement>('[data-canvas-panel="review_heat"]');
    const mgpY =
      this.reviewPanels.review_heat.visible &&
      !this.reviewPanels.review_heat.userMoved &&
      rhEl &&
      rhEl.offsetHeight >= 30
        ? Math.round(this.reviewPanels.review_heat.y + rhEl.offsetHeight + 22)
        : heatY;
    placePanel("review_mgp", 64, mgpY);
  }

  private patchCockpitAnnouncerDomInPlace(): boolean {
    const cockpitEl = this.el.querySelector<HTMLElement>('[data-canvas-panel="cockpit"]');
    if (!cockpitEl) return false;
    const btn = cockpitEl.querySelector<HTMLButtonElement>("[data-toggle-race-lap-callouts]");
    if (!btn) return false;

    const canSpeak = Boolean(this.announcer?.supported && this.announcer.settings.enabled);
    const hasSpeakBtn = Boolean(cockpitEl.querySelector("[data-announce-speak]"));
    if (canSpeak !== hasSpeakBtn) {
      return false;
    }

    const stageFmt = btn.dataset.toggleRaceLapCallouts || "";
    const isQualHeat = isQualifierStageFormat(stageFmt);
    const announcerEnabled = this.announcer ? Boolean(this.announcer.settings.enabled) : true;
    const lapCalloutsOn =
      announcerEnabled &&
      (this.announcer ? this.announcer.isLapCalloutsActiveForStage(stageFmt) : isQualHeat);
    const lapCalloutsTitle = !announcerEnabled
      ? "Enable Voice Announcer to toggle lap timing announcements"
      : lapCalloutsOn
        ? `Lap timing announcements on (${isQualHeat ? "Qualifier" : "Race"}) — click to turn off`
        : `Lap timing announcements off (${isQualHeat ? "Qualifier" : "Race"}) — click to turn on`;

    btn.disabled = !announcerEnabled;
    btn.classList.toggle("is-active", lapCalloutsOn);
    btn.classList.toggle("is-muted", !lapCalloutsOn);
    btn.setAttribute("aria-pressed", lapCalloutsOn ? "true" : "false");
    btn.title = lapCalloutsTitle;
    btn.setAttribute("aria-label", lapCalloutsTitle);
    btn.innerHTML = lapCalloutsOn ? icons.megaphone(21) : icons.megaphoneOff(21);
    return true;
  }

  private getRaceSignalsCandidates(
    race: RaceTournamentState
  ): Array<{ slotIndex: number; callsign: string; color: string; channelLabel?: string }> {
    const heat = this.getControlStageHeat(race);
    const candidates: Array<{
      slotIndex: number;
      callsign: string;
      color: string;
      channelLabel?: string;
    }> = [];
    const seen = new Set<number>();

    if (heat) {
      for (const s of heat.seats) {
        if (s.pilotSlotIndex > 0 && !seen.has(s.pilotSlotIndex)) {
          seen.add(s.pilotSlotIndex);
          candidates.push({
            slotIndex: s.pilotSlotIndex,
            callsign: s.callsign,
            color: s.color || "#38bdf8",
            channelLabel: formatBandChannelShort(s.band, s.channel),
          });
        }
      }
    }

    const seatChannelBySlot = new Map<number, { band?: number; channel: number }>();
    for (const h of race.heats ?? []) {
      for (const s of h.seats ?? []) {
        if (s.pilotSlotIndex > 0 && s.channel > 0 && !seatChannelBySlot.has(s.pilotSlotIndex)) {
          seatChannelBySlot.set(s.pilotSlotIndex, { band: s.band, channel: s.channel });
        }
      }
    }

    for (const rp of race.roster ?? []) {
      if (
        rp.slotIndex > 0 &&
        rp.checkedIn !== false &&
        rp.attendance !== "dnc" &&
        rp.attendance !== "forfeit" &&
        !seen.has(rp.slotIndex)
      ) {
        const sp = this.store.pilot(rp.slotIndex);
        if (sp) {
          seen.add(rp.slotIndex);
          const seatCh = seatChannelBySlot.get(rp.slotIndex);
          candidates.push({
            slotIndex: rp.slotIndex,
            callsign: rp.callsign || sp.callsign,
            color: rp.color || sp.color || "#38bdf8",
            channelLabel: formatBandChannelShort(
              rp.band ?? seatCh?.band ?? sp.band,
              rp.channel || seatCh?.channel || sp.channel
            ),
          });
        }
      }
    }

    for (const sp of this.store.pilots) {
      if (sp.enabled && sp.slotIndex > 0 && !seen.has(sp.slotIndex)) {
        seen.add(sp.slotIndex);
        candidates.push({
          slotIndex: sp.slotIndex,
          callsign: sp.callsign,
          color: sp.color || "#38bdf8",
          channelLabel: formatBandChannelShort(sp.band, sp.channel),
        });
      }
    }

    return candidates;
  }

  private resolveRaceSignalsSlot(race: RaceTournamentState): number | null {
    const candidates = this.getRaceSignalsCandidates(race);
    if (candidates.length === 0) {
      return null;
    }
    if (
      typeof this.raceSignalsSlot === "number" &&
      candidates.some((c) => c.slotIndex === this.raceSignalsSlot)
    ) {
      return this.raceSignalsSlot;
    }
    this.raceSignalsSlot = candidates[0].slotIndex;
    return this.raceSignalsSlot;
  }

  private syncRaceSignalsChartDom(): void {
    const isSignalsPaneVisible = this.mobileControlView === "signals";
    if (
      this.showDirectory ||
      this.activeTab !== "control" ||
      !isSignalsPaneVisible
    ) {
      this.disposeRaceSignalsChart();
    this.disposeRaceTrackView();
    this.disposeRaceAnalyticsView();
    this.dirOpenMenuRaceId = "";
      return;
    }
    const race = this.currentRace;
    const slot = this.resolveRaceSignalsSlot(race);
    const host = this.el.querySelector<HTMLElement>("[data-race-signals-chart]");
    if (!host || slot === null) {
      this.disposeRaceSignalsChart();
    this.disposeRaceTrackView();
    this.disposeRaceAnalyticsView();
    this.dirOpenMenuRaceId = "";
      return;
    }
    if (!this.raceSignalsChart || !this.raceSignalsChartEl) {
      this.raceSignalsChartEl = document.createElement("div");
      this.raceSignalsChartEl.className = "rc-signals-chart-inner";
      host.innerHTML = "";
      host.appendChild(this.raceSignalsChartEl);
      this.raceSignalsChart = new PilotRssiChart(
        this.raceSignalsChartEl,
        this.raceWorkspaceStore,
        this.raceScopedApi,
        {
          contextMode: "race",
        }
      );
    } else if (this.raceSignalsChartEl.parentElement !== host) {
      host.innerHTML = "";
      host.appendChild(this.raceSignalsChartEl);
    }
    this.raceSignalsChart.setPilotSlotOverride(slot);
    const candidates = this.getRaceSignalsCandidates(race);
    this.lastRaceSignalsMountSig = `${race.raceId ?? ""}:${slot}:${candidates.map((c) => `${c.slotIndex}:${c.callsign}:${c.color}:${c.channelLabel}`).join("|")}`;
  }

  private renderPanelById(race: RaceTournamentState, panelId: AnyCanvasPanelId): string {
    switch (panelId) {
      case "cockpit":
        return this.renderControlCockpitPanel(race);
      case "heatline":
        return this.renderControlHeatLinePanel(race);
      case "flightline":
        return this.renderControlFlightLinePanel(race);
      case "schedule":
        return this.renderControlSchedulePanel(race);
      case "standings":
        return this.renderControlStandingsPanel(race);
      case "pilots":
        return this.renderPilotsCanvasPanel(race, this.activeTab);
      case "signals":
        return this.renderControlSignalsPanel(race);
      case "review_heat":
        return this.renderReviewHeatPanel(race);
      case "review_list":
        return this.renderReviewListPanel(race);
      case "review_mgp":
      case "mgp_overall":
        return this.renderMultiGPOverallPanel(race);
      case "mgp_heats":
        return this.renderMultiGPHeatsPanel(race);
    }
  }

  private captureScrollPositions(root: ParentNode): Map<string, number> {
    const map = new Map<string, number>();
    root.querySelectorAll<HTMLElement>(".rc-canvas-panel[data-canvas-panel]").forEach((panel) => {
      const pid = panel.dataset.canvasPanel ?? "";
      const body = panel.querySelector<HTMLElement>(":scope > .rc-panel-body");
      if (pid && body && body.scrollTop > 0) {
        map.set(`panel:${pid}`, body.scrollTop);
      }
    });
    root.querySelectorAll<HTMLElement>("[data-preserve-scroll]").forEach((el) => {
      const key = el.dataset.preserveScroll ?? "";
      if (key && el.scrollTop > 0) {
        map.set(`scroll:${key}`, el.scrollTop);
      }
      if (key && el.scrollLeft > 0) {
        map.set(`scroll-x:${key}`, el.scrollLeft);
      }
    });
    const pilotsResults = root.querySelector<HTMLElement>("[data-rc-pilots-results]");
    if (pilotsResults && pilotsResults.scrollTop > 0) {
      map.set("pilots-results", pilotsResults.scrollTop);
    }
    const topLeftTrack = root.querySelector<HTMLElement>("[data-rc-topleft-track]");
    if (topLeftTrack && topLeftTrack.scrollLeft > 0) {
      map.set("topleft-scroll-x", topLeftTrack.scrollLeft);
    }
    if (
      typeof window !== "undefined" &&
      window.scrollY > 0 &&
      root.querySelector('[data-rc-page="configure"]')
    ) {
      map.set("window-scroll-y", window.scrollY);
    }
    return map;
  }

  private restoreScrollPositions(root: ParentNode, saved: Map<string, number>): void {
    const isMobileConfigure = Boolean(root.querySelector('[data-rc-page="configure"]'));
    if (saved.size > 0) {
      root.querySelectorAll<HTMLElement>(".rc-canvas-panel[data-canvas-panel]").forEach((panel) => {
        const pid = panel.dataset.canvasPanel ?? "";
        const top = saved.get(`panel:${pid}`);
        if (pid && top !== undefined) {
          const body = panel.querySelector<HTMLElement>(":scope > .rc-panel-body");
          if (body) body.scrollTop = top;
        }
      });
      root.querySelectorAll<HTMLElement>("[data-preserve-scroll]").forEach((el) => {
        const key = el.dataset.preserveScroll ?? "";
        const top = saved.get(`scroll:${key}`);
        if (key && top !== undefined) {
          el.scrollTop = top;
        }
        const left = saved.get(`scroll-x:${key}`);
        if (key && left !== undefined) {
          el.scrollLeft = left;
        }
      });
      const pilotsTop = saved.get("pilots-results");
      if (pilotsTop !== undefined) {
        const pilotsResults = root.querySelector<HTMLElement>("[data-rc-pilots-results]");
        if (pilotsResults) pilotsResults.scrollTop = pilotsTop;
      }
      const topLeftScrollX = saved.get("topleft-scroll-x");
      if (topLeftScrollX !== undefined) {
        const topLeftTrack = root.querySelector<HTMLElement>("[data-rc-topleft-track]");
        if (topLeftTrack) topLeftTrack.scrollLeft = topLeftScrollX;
      }
      const winY = saved.get("window-scroll-y");
      if (isMobileConfigure && winY !== undefined && typeof window !== "undefined") {
        if (Math.abs(window.scrollY - winY) > 1) {
          window.scrollTo(0, winY);
        }
      }
    }
    if (
      !isMobileConfigure &&
      this.isMobileViewport() &&
      root.querySelector(".races-page") &&
      typeof window !== "undefined" &&
      window.scrollY !== 0
    ) {
      window.scrollTo(0, 0);
    }
    this.syncMobileLiveLapsScroll(root);
  }

  private syncMobileLiveLapsScroll(root: ParentNode = this.el): void {
    const lapsScroll = root.querySelector<HTMLElement>("[data-mobile-laps-scroll]");
    if (!lapsScroll) return;
    const latestId = Number(lapsScroll.dataset.latestCrossing) || 0;
    if (latestId !== this.lastMobileLapsCrossingId) {
      this.lastMobileLapsCrossingId = latestId;
      lapsScroll.scrollTop = 0;
    }
  }

  private refreshSinglePanelDom(panelId: AnyCanvasPanelId): void {
    if (this.showDirectory) return;
    if (panelId === "review_mgp") {
      this.refreshSinglePanelDom("mgp_overall");
      this.refreshSinglePanelDom("mgp_heats");
      return;
    }
    const host = this.el.querySelector<HTMLElement>("[data-rc-page], [data-rc-world]");
    if (!host) {
      this.lastSig = "";
      this.render();
      return;
    }
    if (panelId === "signals") {
      this.raceSignalsChartEl?.remove();
    }
    const savedScroll = this.captureScrollPositions(host);
    const race = this.currentRace;
    const nextHtml = this.renderPanelById(race, panelId).trim();
    const existing = host.querySelector<HTMLElement>(
      `.rc-canvas-panel[data-canvas-panel="${CSS.escape(panelId)}"]`
    );

    if (!nextHtml) {
      existing?.remove();
    } else if (existing) {
      existing.outerHTML = nextHtml;
    } else {
      host.insertAdjacentHTML("beforeend", nextHtml);
    }

    if (panelId === "review_heat") {
      const existingPicker = host.querySelector<HTMLElement>("[data-review-mobile-picker-card]");
      const nextPickerHtml = this.renderReviewMobilePickerPanel(race).trim();
      if (!nextPickerHtml) {
        existingPicker?.remove();
      } else if (existingPicker) {
        existingPicker.outerHTML = nextPickerHtml;
      }
    }

    this.restoreScrollPositions(host, savedScroll);

    const vp = this.el.querySelector<HTMLElement>("[data-rc-viewport]");
    if (vp) {
      if (vp.scrollLeft !== 0) vp.scrollLeft = 0;
      if (vp.scrollTop !== 0) vp.scrollTop = 0;
      if (this.activeTab === "edit" && panelId === "pilots") {
        vp.classList.toggle("has-pilots-panel", this.editPilotsPanel.visible);
      }
    }

    if (this.activeTab === "control") {
      if (panelId === "cockpit") {
        this.updateLiveClockDom();
      }
      if (panelId === "heatline") {
        this.updateLiveRssiDom();
      }
      if (panelId === "signals") {
        this.syncRaceSignalsChartDom();
      }
    }
    this.syncFabActiveStatesDom();
    this.syncLastSig();
  }

  private refreshGraphVisibilityDom(): void {
    if (this.showDirectory || this.activeTab !== "control") return;
    const world = this.el.querySelector<HTMLElement>("[data-rc-world]");
    if (!world) {
      this.lastSig = "";
      this.render();
      return;
    }
    const hide = !this.showGraphOnControl;
    world
      .querySelectorAll<HTMLElement>(
        ":scope > svg.bkt-wires, :scope > .rc-nodes, :scope > [data-bkt-wire-handles], :scope > [data-bkt-wire-pills], :scope > [data-rc-control-divider]"
      )
      .forEach((el) => {
        if (hide) el.setAttribute("hidden", "");
        else el.removeAttribute("hidden");
      });
    if (!hide) {
      this.syncControlBoundaryDom();
      drawBracketWires(this.el, this.currentRace, this.bktUi);
    }
    this.syncFabActiveStatesDom();
    this.syncLastSig();
  }

  private cameraSlotKey(tab: WorkspaceTab, stage: number): number {
    if (tab === "multigp") return 400;
    if (tab === "review") return 300;
    if (tab === "format") return 200;
    if (tab === "control") return 100;
    return stage || 1;
  }

  private saveCurrentCamera(): void {
    if (
      this.showDirectory ||
      this.activeTab === "control" ||
      this.activeTab === "review" ||
      this.activeTab === "multigp"
    ) {
      return;
    }
    const raceId = this.currentRace.raceId;
    const st = this.getCurrentViewStage();
    this.bktUi.stageCameras[this.cameraSlotKey(this.activeTab, st)] = {
      panX: this.bktUi.panX,
      panY: this.bktUi.panY,
      zoom: this.bktUi.zoom,
      initialized: true,
    };
    if (raceId) {
      persistStoredRaceCameras(raceId, this.bktUi.stageCameras);
    }
  }

  private syncWorkspaceHash(pushHistory = false): void {
    if (getCurrentParsedHash().route !== "races") return;
    if (!this.store.hasHydrated && this.pendingRouteTarget) return;
    const cur = this.currentRace;
    const raceSlug = cur.raceId
      ? slugifyRaceName(cur.config.eventName || "Race")
      : undefined;
    const desired = this.showDirectory
      ? buildRacesHash("directory")
      : buildRacesHash(this.activeTab, raceSlug, this.getCurrentViewStage(cur));
    if (location.hash !== desired) {
      if (pushHistory) {
        pushAppHash(desired);
      } else {
        replaceAppHash(desired);
      }
    }
  }

  private resolvePendingRouteIfReady(pushHistory = false): void {
    const target = this.pendingRouteTarget;
    if (!target) return;

    if (target.tab === "directory") {
      this.pendingRouteTarget = null;
      this.resolvingRouteRaceId = "";
      if (!this.showDirectory) {
        this.saveCurrentCamera();
      }
      this.setViewingRace("");
      this.showDirectory = true;
      this.fabOpen = false;
      this.fabSubmenu = "";
      this.formatMenuOpen = false;
      this.editingNameForRaceId = "";
      this.editingTagsForRaceId = "";
      this.syncWorkspaceHash(pushHistory);
      this.lastSig = "";
      this.render();
      return;
    }

    // Wait for initial store hydration before deciding whether races exist or selecting a race!
    if (!this.store.hasHydrated && this.store.races.length === 0 && !this.store.raceState.raceId) {
      this.showDirectory = true;
      return;
    }

    const allRaces = this.getEffectiveRaces();
    if (allRaces.length === 0) {
      this.pendingRouteTarget = null;
      this.resolvingRouteRaceId = "";
      this.setViewingRace("");
      this.showDirectory = true;
      this.activeTab = "format";
      this.syncWorkspaceHash(false);
      this.lastSig = "";
      this.render();
      return;
    }

    const matchedRace = target.raceKey
      ? findMatchingRace(allRaces, target.raceKey)
      : undefined;
    const desiredRaceId =
      matchedRace?.raceId || this.currentRace.raceId || allRaces[0]?.raceId || "";

    if (!desiredRaceId) {
      this.pendingRouteTarget = null;
      this.setViewingRace("");
      this.showDirectory = true;
      this.syncWorkspaceHash(false);
      this.lastSig = "";
      this.render();
      return;
    }

    if (desiredRaceId !== this.currentRace.raceId || this.viewingRaceId !== desiredRaceId) {
      if (this.resolvingRouteRaceId === desiredRaceId) return;
      this.resolvingRouteRaceId = desiredRaceId;
      void this.api
        .eventAction({ action: "select_race", raceId: desiredRaceId })
        .then(() => {
          this.resolvingRouteRaceId = "";
          if (!this.disposed) {
            this.setViewingRace(desiredRaceId);
            this.syncDraftDefaultsFromRace();
            this.resolvePendingRouteIfReady(false);
          }
        })
        .catch((err) => {
          this.resolvingRouteRaceId = "";
          this.pendingRouteTarget = null;
          this.reportErr(err);
        });
      return;
    }

    this.pendingRouteTarget = null;
    this.resolvingRouteRaceId = "";
    this.syncDraftDefaultsFromRace();

    const curRace = this.currentRace;
    const nextTab: WorkspaceTab = target.tab === "format" ? "edit" : target.tab;

    if (target.stage && nextTab === "edit") {
      this.bracketStage = target.stage;
    }

    if (!this.showDirectory) {
      if (this.activeTab === "edit" && nextTab === "edit" && target.stage) {
        this.switchBracketStage(target.stage, pushHistory);
        return;
      }
      if (this.activeTab !== nextTab) {
        this.switchWorkspaceTab(nextTab, pushHistory);
        return;
      }
      this.syncWorkspaceHash(pushHistory);
      this.lastSig = "";
      this.render();
      return;
    }

    this.showDirectory = false;
    this.activeTab = nextTab;
    this.syncCanvasLockToUi(nextTab);
    this.fabOpen = false;
    this.fabSubmenu = "";
    this.formatMenuOpen = false;
    this.editingNameForRaceId = "";
    this.editingTagsForRaceId = "";

    const viewStg = this.getCurrentViewStage(curRace);
    const savedCam = this.bktUi.stageCameras[this.cameraSlotKey(nextTab, viewStg)];
    if (savedCam?.initialized) {
      this.bktUi.panX = savedCam.panX;
      this.bktUi.panY = savedCam.panY;
      this.bktUi.zoom = savedCam.zoom;
    }

    this.syncWorkspaceHash(pushHistory);
    if (!this.isMobileViewport() && typeof window !== "undefined" && window.scrollY !== 0) {
      window.scrollTo(0, 0);
    }

    this.lastSig = "";
    this.render();
  }

  private handlePointerDownDismiss = (e: PointerEvent): void => {
    const target = e.target as Element | null;
    if (!target) return;
    if (
      (e.button === 0 || e.pointerType === "touch") &&
      target.closest("[data-mobile-race-handle]")
    ) {
      this.mobileRaceDrawerDragStartY = e.clientY;
    }
    if (e.button === 0 || e.pointerType === "touch") {
      const dragHandle = target.closest<HTMLButtonElement>(
        "[data-seat-drag-handle]:not(:disabled)"
      );
      if (dragHandle) {
        if (this.openMarshalMenuKey) {
          this.openMarshalMenuKey = "";
          this.refreshSinglePanelDom(this.activeTab === "review" ? "review_heat" : "heatline");
        }
        this.beginSeatRowDrag(e, dragHandle);
        return;
      }
    }
    if (this.fabOpen && !target.closest(".rc-fab-menu")) {
      this.fabOpen = false;
      this.fabSubmenu = "";
      this.refreshFabMenuDom();
    }
    if (this.formatMenuOpen && !target.closest(".rc-format-dropdown-wrap")) {
      this.formatMenuOpen = false;
      this.refreshTopLeftBarDom();
    }
    if (
      this.mobileStageMenuOpen &&
      !target.closest(".rc-stage-dropdown-mobile") &&
      !target.closest(".rc-mobile-stage-popover")
    ) {
      this.mobileStageMenuOpen = false;
      this.refreshTopLeftBarDom();
    }
    if (this.openMarshalMenuKey && !target.closest(".race-marshal-menu-wrap")) {
      this.openMarshalMenuKey = "";
      this.refreshSinglePanelDom(this.activeTab === "review" ? "review_heat" : "heatline");
    }
    if (this.dirOpenMenuRaceId && !target.closest(".dir-row-more-wrap")) {
      this.dirOpenMenuRaceId = "";
      this.refreshDirectoryResultsDom();
    }
  };

  private refreshTopLeftBarDom(): void {
    const barEl = this.el.querySelector<HTMLElement>(".rc-topleft-bar");
    if (!barEl) return;
    const prevTrack = barEl.querySelector<HTMLElement>("[data-rc-topleft-track]");
    const prevScrollLeft = prevTrack ? prevTrack.scrollLeft : 0;
    const race = this.currentRace;
    const tmp = document.createElement("div");
    tmp.innerHTML = this.renderTopLeftCanvasBar(race, this.activeTab).trim();
    const nextEl = tmp.firstElementChild as HTMLElement | null;
    if (nextEl) {
      barEl.replaceWith(nextEl);
      const nextTrack = nextEl.querySelector<HTMLElement>("[data-rc-topleft-track]");
      if (nextTrack && prevScrollLeft > 0) {
        nextTrack.scrollLeft = prevScrollLeft;
      }
      fitScheduleLineups(nextEl);
    }
    this.lastSig = this.computeSig(race, this.getActiveHeatForRace(race));
  }

  private switchWorkspaceTab(rawNextTab: WorkspaceTab, pushHistory = true): void {
    const nextTab: WorkspaceTab = rawNextTab === "format" ? "edit" : rawNextTab;
    if (!this.showDirectory && this.activeTab === nextTab) {
      if (this.formatMenuOpen) {
        this.formatMenuOpen = false;
        this.refreshTopLeftBarDom();
      }
      return;
    }
    if (!this.showDirectory) {
      this.saveCurrentCamera();
    }
    this.dismissAutoPromptTemplateModal();
    closeActiveRoundModal();
    closeActiveDesktopTableModal();
    closeActiveMobileEditorSheet();
    closeActiveLapEditorModal();
    closeActivePilotLapsModal();
    if (nextTab === "format" || nextTab === "edit") {
      this.lastConfigureTab = nextTab;
    }
    this.showDirectory = false;
    this.activeTab = nextTab;
    this.syncCanvasLockToUi(nextTab);
    this.syncWorkspaceHash(pushHistory);
    this.fabOpen = false;
    this.fabSubmenu = "";
    this.formatMenuOpen = false;
    this.mobileStageMenuOpen = false;
    this.openMarshalMenuKey = "";
    if ((nextTab === "format" || nextTab === "edit") && !isRaceConfigured(this.currentRace)) {
      if (this.currentRace.raceId) {
        this.promptedTemplateRaceIds.delete(this.currentRace.raceId);
      }
    }
    this.refreshFabMenuDom();
    this.bktUi.connectingFromRoundId = "";
    this.bktUi.connectingFromPortDir = "right";
    this.bktUi.openWireMenuId = "";
    this.bktUi.openNodeMenuId = "";
    this.bktUi.selectedRoundIds.clear();

    const isCanvasTab = nextTab === "format" || nextTab === "edit";
    const curStage = this.getCurrentViewStage();
    const saved = isCanvasTab
      ? this.bktUi.stageCameras[this.cameraSlotKey(nextTab, curStage)]
      : undefined;
    if (saved?.initialized) {
      this.bktUi.panX = saved.panX;
      this.bktUi.panY = saved.panY;
      this.bktUi.zoom = saved.zoom;
    }

    if (!this.isMobileViewport() && typeof window !== "undefined" && window.scrollY !== 0) {
      window.scrollTo(0, 0);
    }

    this.lastSig = "";
    this.render();
    this.triggerDesktopWorkspaceFade(false);

    if (isCanvasTab && !saved?.initialized) {
      this.fitAndStoreCurrentCamera(nextTab, curStage);
    }
  }

  private triggerDesktopWorkspaceFade(onlySetupBody = false): void {
    const selector = onlySetupBody
      ? ".dte-board-wrap, .races-canvas > :not([data-dte-race-summary])"
      : ".races-page > :not(.races-page-topbar), .races-canvas";
    const targets = this.el.querySelectorAll<HTMLElement>(selector);
    targets.forEach((node) => {
      node.classList.remove("is-ws-tab-enter");
      void node.offsetWidth;
      node.classList.add("is-ws-tab-enter");
    });
  }

  private fitAndStoreCurrentCamera(tab: WorkspaceTab, stage: number): void {
    if (tab === "pilots" || tab === "track" || tab === "control" || tab === "review" || tab === "analytics") return;
    const key = this.cameraSlotKey(tab, stage);
    const applyFit = (): void => {
      const race = this.currentRace;
      if (tab === "format") {
        drawFormatWires(this.el, race, this.bktUi);
        const vp = this.el.querySelector<HTMLElement>("[data-rc-viewport]");
        fitCanvasToFormatStages(vp, race, this.bktUi);
      } else {
        drawBracketWires(this.el, race, this.bktUi);
        const stageRounds = (race.rounds ?? []).filter(
          (r) => r.stageIndex === stage
        );
        const rootStage = isRootStage(race, stage);
        if (stageRounds.length > 0) {
          fitCanvasToNodes(this.el, this.bktUi);
        } else if (rootStage) {
          const stgObj = (race.stages ?? []).find((s) => s.index === stage);
          const pX = stgObj?.pilotsNodeHasPos ? (stgObj.pilotsNodePosX ?? 0) : 96;
          const pY = stgObj?.pilotsNodeHasPos ? (stgObj.pilotsNodePosY ?? 0) : 110;
          this.bktUi.zoom = 0.96;
          this.bktUi.panX = Math.round(38 - pX * this.bktUi.zoom);
          this.bktUi.panY = Math.round(86 - pY * this.bktUi.zoom);
          const vp = this.el.querySelector<HTMLElement>("[data-rc-viewport]");
          if (vp) applyCanvasCameraDom(vp, this.bktUi);
        } else if (this.editPilotsPanel.visible) {
          this.bktUi.zoom = 0.96;
          this.bktUi.panX = Math.round(38 - this.editPilotsPanel.x * this.bktUi.zoom);
          this.bktUi.panY = Math.round(86 - this.editPilotsPanel.y * this.bktUi.zoom);
          const vp = this.el.querySelector<HTMLElement>("[data-rc-viewport]");
          if (vp) applyCanvasCameraDom(vp, this.bktUi);
        } else {
          fitCanvasToNodes(this.el, this.bktUi);
        }
      }
      this.bktUi.stageCameras[key] = {
        panX: this.bktUi.panX,
        panY: this.bktUi.panY,
        zoom: this.bktUi.zoom,
        initialized: true,
      };
      if (race.raceId) {
        persistStoredRaceCameras(race.raceId, this.bktUi.stageCameras);
      }
    };

    applyFit();
    requestAnimationFrame(() => {
      if (!this.disposed && !this.showDirectory && this.activeTab === tab) {
        applyFit();
      }
    });
  }

  private syncDraftDefaultsFromRace(): void {
    const r = this.currentRace;
    if (!r.raceId || r.raceId === this.lastSyncedRaceId) return;
    this.lastSyncedRaceId = r.raceId;
    this.bracketStage = 0;
    this.draftPilotsPerHeat = r.config.pilotsPerHeat || 4;
    this.draftTargetLaps = r.config.targetLaps || 3;
    this.draftTimeLimitSec = r.config.timeLimitSec || 120;
    this.draftQualRounds = r.config.qualifyingRounds || 2;
    this.bktUi.connectingFromRoundId = "";
    this.bktUi.connectingFromPortDir = "right";
    this.bktUi.openWireMenuId = "";
    this.bktUi.openNodeMenuId = "";
    this.bktUi.selectedRoundIds.clear();
    this.bktUi.optimisticPositions.clear();
    this.bktUi.stageCameras = loadStoredRaceCameras(r.raceId);
    this.bktUi.pilotsDrawerOpen = false;
    this.fabOpen = false;
    this.fabSubmenu = "";
    this.formatMenuOpen = false;
    this.mobileStageMenuOpen = false;
    this.openMarshalMenuKey = "";
    this.seatDisplayOrderByScope.clear();
    this.controlCamInitializedForRaceId = "";
    this.formatCamInitializedForRaceId = "";
    this.reviewCamInitializedForRaceId = "";
    this.lastSig = "";
    this.reviewSelectedHeatId = "";
  }

  private getControlStageIndex(race: RaceTournamentState = this.currentRace): number {
    const stages = resolveStagesList(race);
    const stagesPresent = getPresentStageIndices(race);
    if (stagesPresent.length === 1) {
      return stagesPresent[0];
    }
    const liveStage = stages.find((s) => s.status === "active");
    if (liveStage && stagesPresent.includes(liveStage.index)) {
      return liveStage.index;
    }
    if (stagesPresent.includes(race.activeStageIndex)) {
      return race.activeStageIndex;
    }
    return stagesPresent[0] || race.activeStageIndex || 1;
  }

  private getCurrentViewStage(race: RaceTournamentState = this.currentRace): number {
    if (this.activeTab === "control" || this.activeTab === "review") {
      return this.getControlStageIndex(race);
    }
    const stagesPresent = getPresentStageIndices(race);
    if (this.bracketStage && stagesPresent.includes(this.bracketStage)) {
      return this.bracketStage;
    }
    if (stagesPresent.includes(race.activeStageIndex)) {
      return race.activeStageIndex;
    }
    return stagesPresent[0] || race.activeStageIndex || 1;
  }

  private getControlStageHeat(
    race: RaceTournamentState = this.currentRace,
    stageOverride?: number
  ): RaceHeat | undefined {
    const viewStage = stageOverride ?? this.getCurrentViewStage(race);
    const active = this.getActiveHeatForRace(race);
    if ((race.stages?.length ?? 0) <= 1 && race.totalStages <= 1) {
      return active ?? race.heats[0];
    }
    if (active && active.stageIndex === viewStage) {
      return active;
    }
    const stageHeats = race.heats.filter((h) => h.stageIndex === viewStage);
    if (stageHeats.length === 0) {
      return undefined;
    }
    const stateOrder: Array<RaceHeat["state"]> = [
      "running",
      "countdown",
      "paused",
      "staged",
      "finished",
      "ready",
      "waiting",
    ];
    for (const st of stateOrder) {
      const found = stageHeats.find((h) => h.state === st);
      if (found) return found;
    }
    return stageHeats[0];
  }

  private switchBracketStage(nextStage: number, pushHistory = true): void {
    if (!this.showDirectory && (this.activeTab === "control" || this.activeTab === "review")) {
      return;
    }
    const race = this.currentRace;
    if (!this.showDirectory && this.activeTab === "format") {
      this.bracketStage = nextStage;
      this.switchWorkspaceTab("edit", pushHistory);
      return;
    }

    const prevStage = this.getCurrentViewStage(race);
    if (!this.showDirectory) {
      this.bktUi.stageCameras[this.cameraSlotKey(this.activeTab, prevStage)] = {
        panX: this.bktUi.panX,
        panY: this.bktUi.panY,
        zoom: this.bktUi.zoom,
        initialized: true,
      };
      if (race.raceId) {
        persistStoredRaceCameras(race.raceId, this.bktUi.stageCameras);
      }
    }
    this.bracketStage = nextStage;
    this.syncCanvasLockToUi(this.activeTab, nextStage);
    this.formatMenuOpen = false;
    this.syncWorkspaceHash(pushHistory);
    this.bktUi.connectingFromRoundId = "";
    this.bktUi.connectingFromPortDir = "right";
    this.bktUi.openWireMenuId = "";
    this.bktUi.openNodeMenuId = "";
    this.bktUi.selectedRoundIds.clear();

    const savedCam = this.bktUi.stageCameras[this.cameraSlotKey(this.activeTab, nextStage)];
    const needsFit = !this.showDirectory && !savedCam?.initialized;
    if (!this.showDirectory && savedCam?.initialized) {
      this.bktUi.panX = savedCam.panX;
      this.bktUi.panY = savedCam.panY;
      this.bktUi.zoom = savedCam.zoom;
    }

    if (!this.isMobileViewport() && typeof window !== "undefined" && window.scrollY !== 0) {
      window.scrollTo(0, 0);
    }

    this.lastSig = "";
    this.render();

    if (needsFit) {
      this.fitAndStoreCurrentCamera(this.activeTab, nextStage);
    }
  }

  private getEffectiveRaces(): RaceTournamentState[] {
    const live = this.store.raceState;
    return this.store.races.map((r) => (r.raceId && r.raceId === live.raceId ? live : r));
  }

  private handleResize = (): void => {
    const nowMobile = this.isMobileViewport();
    if (nowMobile !== this.lastWasMobileViewport) {
      this.lastWasMobileViewport = nowMobile;
      if (!this.showDirectory && this.activeTab === "edit") {
        this.lastSig = "";
        this.render();
        return;
      }
    }
    if (!this.isViewActive || this.showDirectory) return;
    if (this.activeTab === "edit" && !nowMobile) {
      drawBracketWires(this.el, this.currentRace, this.bktUi);
    } else if (this.activeTab === "control" && this.showGraphOnControl) {
      drawBracketWires(this.el, this.currentRace, this.bktUi);
    }
  };

  private reportErr = (err: unknown): void => {
    const raw = err instanceof Error ? err.message : String(err);
    const msg = cleanConnectionInvalidReason(raw) || raw.trim();
    this.errorMsg = "";
    showToast(msg, "error");
  };

  private computeSig(race: RaceTournamentState, heat: RaceHeat | undefined): string {
    const races = this.getEffectiveRaces();
    const roster = race.roster ?? [];

    const heatPart = heat
      ? [
          heat.id,
          heat.state,
          heat.inOvertime ? 1 : 0,
          heat.canUnlock ? 1 : 0,
          ...heat.seats.map(
            (s) =>
              `${s.seatIndex}:${s.pilotSlotIndex}:${s.band ?? 1}:${s.channel}:${s.status}:${s.statusOverridden ? 1 : 0}:${s.position}:${s.manualPosition}:${s.lapsCompleted}:${s.totalTimeSec.toFixed(2)}:${s.penaltySec}:${s.advances ? 1 : 0}:${s.sourceLabel}:${s.manualLock ? 1 : 0}:${s.laps.map((l) => `${l.crossingId}${l.invalidated ? "x" : "v"}`).join(",")}`
          ),
        ].join("|")
      : "none";

    const heatsSig = race.heats
      .map(
        (h) =>
          `${h.id}:${h.roundId ?? ""}:${h.title}:${h.column}:${h.bracketLane}:${h.stageFormat}:${h.targetLaps}:${h.timeLimitSec}:${h.state}:${h.canUnlock ? 1 : 0}:${h.executedAtMs ?? 0}:${h.seats.map((s) => `${s.pilotSlotIndex}.${s.band ?? 1}.${s.channel}.${s.status}.${s.statusOverridden ? 1 : 0}.${s.position}.${s.manualPosition}.${s.lapsCompleted}.${s.totalTimeSec.toFixed(2)}.${s.penaltySec}.${s.sourceLabel}.${s.manualLock ? 1 : 0}.${s.laps.map((l) => `${l.crossingId}${l.invalidated ? "x" : "v"}${l.splitTimeSec.toFixed(2)}`).join("_")}`).join("/")}`
      )
      .join(",");

    const roundsSig = (race.rounds ?? [])
      .map(
        (rd) =>
          `${rd.id}:${rd.column}:${rd.bracketLane}:${rd.stageFormat}:${rd.finalsFormat ?? ""}:${rd.aceWinsRequired ?? 0}:${rd.winnersAdvantageAce ? 1 : 0}:${rd.finalsHeats ?? 0}:${rd.startMode ?? ""}:${rd.targetLaps}:${rd.timeLimitSec}:${rd.maxPacksPerPilot ?? 0}:${rd.qualifyingMetric ?? ""}:${rd.seedSource ?? ""}:${rd.seedDistribution ?? ""}:${rd.randomSeed ?? 0}:${rd.title}:${rd.linkSummary ?? ""}:${rd.hasPos ? `${(rd.posX ?? 0).toFixed(1)},${(rd.posY ?? 0).toFixed(1)}` : "auto"}`
      )
      .join("|");

    const connsSig = (race.connections ?? [])
      .map(
        (c) =>
          `${c.id}:${c.stageIndex}:${c.fromRoundId}->${c.toRoundId}:${c.mode}:${c.count}:${c.seedStart ?? 0}:${c.seedEnd ?? 0}:${c.distribution ?? ""}:${c.rankingMetric ?? ""}:${c.seededEarly ? 1 : 0}:${c.invalid ? 1 : 0}:${c.invalidReason ?? ""}`
      )
      .join("|");

    const stagesSig = (race.stages ?? [])
      .map(
        (s) =>
          `${s.id}:${s.index}:${s.title}:${s.format}:${s.status}:${s.dangling ? 1 : 0}:${s.prerequisitesMet ? 1 : 0}:${s.completedEarly ? 1 : 0}:${s.pausedByUser ? 1 : 0}:${s.hasPos ? `${(s.posX ?? 0).toFixed(1)},${(s.posY ?? 0).toFixed(1)}` : "auto"}:${s.pilotsNodeHasPos ? `${(s.pilotsNodePosX ?? 0).toFixed(1)},${(s.pilotsNodePosY ?? 0).toFixed(1)}` : "pauto"}:${s.settings ? `${s.settings.pilotsPerHeat}.${(Array.isArray(s.settings.seatChannels) ? s.settings.seatChannels : []).join("-")}.${s.settings.targetLaps}.${s.settings.timeLimitSec}.${s.settings.qualifyingMetric}.${s.settings.maxPacksPerPilot ?? 0}.${s.settings.finalsFormat}` : ""}`
      )
      .join("|");

    const stageConnsSig = (race.stageConnections ?? [])
      .map(
        (sc) =>
          `${sc.id}:${sc.fromStageId}.${sc.fromPort ?? ""}->${sc.toStageId}.${sc.toPort ?? ""}:${sc.mode}:${sc.count ?? 0}:${sc.seedStart ?? 0}:${sc.seedEnd ?? 0}:${sc.rankingMetric ?? ""}:${sc.invalid ? 1 : 0}:${sc.invalidReason ?? ""}`
      )
      .join("|");

    const panelsSig = [
      ...(
        ["cockpit", "heatline", "flightline", "schedule", "standings", "pilots", "signals"] as const
      ).map((id) => {
        const p = this.controlPanels[id];
        return `c_${id}:${p.visible ? 1 : 0}:${p.collapsed ? 1 : 0}`;
      }),
      ...(["review_heat", "review_list", "review_mgp", "mgp_overall", "mgp_heats"] as const).map((id) => {
        const p = this.reviewPanels[id];
        return `r_${id}:${p.visible ? 1 : 0}:${p.collapsed ? 1 : 0}`;
      }),
      `e_pilots:${this.editPilotsPanel.visible ? 1 : 0}:${this.editPilotsPanel.collapsed ? 1 : 0}`,
      `mgp_ver:${this.isMultiGPVerified() ? 1 : 0}:${this.mgpUploadInFlight ? 1 : 0}`,
    ].join(",");

    return [
      this.showDirectory ? 1 : 0,
      this.dirSearchQuery,
      this.dirStatusFilter,
      Array.from(this.selectedFilterTags).sort().join(","),
      this.untaggedOnly ? 1 : 0,
      this.editingNameForRaceId,
      this.editingTagsForRaceId,
      this.mobileSelectedRaceId,
      this.activeTab,
      this.isMobileViewport() ? 1 : 0,
      this.mobileEditorUi.activePageId,
      this.mobileEditorUi.connectToPreviousOnAdd ? 1 : 0,
      this.reviewSelectedHeatId,
      this.raceSignalsSlot ?? 0,
      this.attendanceExpanded ? 1 : 0,
      this.showWalkUpForm ? 1 : 0,
      this.lifecyclePrompt,
      this.scheduleFilter,
      this.flightQueueFilter,
      this.standingsStage,
      this.pilotsFilter,
      this.bracketStage,
      this.confirmReset ? 1 : 0,
      this.fabOpen ? 1 : 0,
      this.fabSubmenu,
      this.formatMenuOpen ? 1 : 0,
      this.mobileStageMenuOpen ? 1 : 0,
      this.openMarshalMenuKey,
      this.mobileControlView,
      this.desktopSetupView,
      this.isMultiGPVerified() ? 1 : 0,
      this.showGraphOnControl ? 1 : 0,
      panelsSig,
      this.errorMsg,
      this.bktUi.connectingFromRoundId,
      this.bktUi.connectingFromPortDir,
      this.bktUi.openWireMenuId,
      this.bktUi.openNodeMenuId,
      this.bktUi.tool,
      this.isCanvasLocked(this.activeTab, this.getCurrentViewStage(race)) ? 1 : 0,
      this.bktUi.controlsExpanded ? 1 : 0,
      this.bktUi.pilotsDrawerOpen ? 1 : 0,
      this.bktUi.pilotsNodeFilter,
      Array.from(this.bktUi.selectedRoundIds).sort().join(","),
      race.raceId ?? "",
      (race.tags ?? []).join(","),
      race.templateId ?? "",
      race.lifecycle ?? "",
      race.emergencyStopped ? 1 : 0,
      race.statusReason ?? "",
      race.generated ? 1 : 0,
      race.config.eventName,
      race.config.pilotsPerHeat,
      race.config.seatChannels.join("."),
      race.config.targetLaps,
      race.config.timeLimitSec,
      race.config.countdownSec,
      race.config.qualifyingMetric,
      race.config.maxPacksPerPilot ?? 0,
      race.config.stage2MaxSeeds ?? 0,
      race.totalStages,
      race.activeStageIndex,
      race.qualifyingComplete ? 1 : 0,
      race.stage2SeededEarly ? 1 : 0,
      race.canStartStage2 ? 1 : 0,
      race.isComplete ? 1 : 0,
      race.championCallsign ?? "",
      race.activeHeatId,
      race.nextReadyHeatId,
      this.store.nodes.length,
      this.dirOpenMenuRaceId,
      this.store.timingHardwareMode,
      this.store.simulatorRunning ? (this.store.simState?.speedMultiplier ?? 1) : 0,
      this.announcer?.settings.enabled ? 1 : 0,
      this.announcer?.settings.qualifierLapCallouts !== false ? 1 : 0,
      this.announcer?.settings.raceLapCallouts ? 1 : 0,
      sharedMultiGPService.isAvailable(this.store) ? 1 : 0,
      race.mgpLink
        ? `${race.mgpLink.raceId}:${race.mgpLink.syncedCycleCount ?? 0}:${race.mgpLink.lastSyncedAt ?? ""}:${Object.keys(race.mgpLink.unsyncedHeats ?? {}).sort().join(",")}`
        : "",
      (race.trackSnapshot ?? []).length,
      races
        .map(
          (r) =>
            `${r.raceId ?? ""}:${r.mgpLink?.raceId ?? ""}:${(r.tags ?? []).join(",")}:${r.config.eventName}:${r.lifecycle ?? ""}:${r.emergencyStopped ? 1 : 0}:${r.generated ? 1 : 0}:${r.heats.length}:${r.heats.filter((h) => h.state === "confirmed").length}:${(r.trackSnapshot ?? []).length}`
        )
        .join("|"),
      roster.map((p) => `${p.slotIndex}:${p.checkedIn ? 1 : 0}:${p.attendance}:${p.note ?? ""}`).join(","),
      stagesSig,
      stageConnsSig,
      roundsSig,
      connsSig,
      heatPart,
      heatsSig,
    ].join("::");
  }

  private signalsDeferredRender = false;
  private lastRaceSignalsMountSig = "";

  private renderIfNeeded(): void {
    if (this.bktUi.activeGesture) return;
    const active = document.activeElement;
    if (
      active &&
      (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) &&
      this.el.contains(active) &&
      !active.hasAttribute("data-live-safe")
    ) {
      return;
    }
    const race = this.currentRace;
    const sig = this.computeSig(race, this.getActiveHeatForRace(race));
    if (sig === this.lastSig) return;
    if (
      !this.showDirectory &&
      this.activeTab === "control" &&
      this.mobileControlView === "signals" &&
      this.isMobileViewport() &&
      this.raceSignalsChart &&
      this.raceSignalsChartEl?.isConnected &&
      this.el.querySelector("[data-race-signals-chart]")
    ) {
      const candidates = this.getRaceSignalsCandidates(race);
      const mountSig = `${race.raceId ?? ""}:${this.resolveRaceSignalsSlot(race) ?? ""}:${candidates.map((c) => `${c.slotIndex}:${c.callsign}:${c.color}:${c.channelLabel}`).join("|")}`;
      if (mountSig === this.lastRaceSignalsMountSig) {
        this.lastSig = sig;
        this.signalsDeferredRender = true;
        this.syncRaceSignalsChartDom();
        return;
      }
    }
    this.signalsDeferredRender = false;
    this.lastSig = sig;
    this.render();
  }

  private getLiveJumpBannerHeat(race: RaceTournamentState): RaceHeat | undefined {
    if (race.emergencyStopped || race.lifecycle === "paused" || race.lifecycle === "completed" || race.lifecycle === "scrapped" || race.isComplete) {
      return undefined;
    }
    const running = race.heats.find((h) => h.state === "running");
    if (running) return running;
    const countdown = race.heats.find((h) => h.state === "countdown");
    if (countdown) return countdown;
    if (this.isRaceActivelyTiming(race)) {
      const finished = race.heats.find((h) => h.state === "finished");
      if (finished) return finished;
    }
    return undefined;
  }

  private computeLiveHeatClockText(race: RaceTournamentState, heat: RaceHeat): string {
    const serverNowUs = this.store.liveServerTimestampUs;
    if (heat.state === "countdown") {
      const nomSec = Math.max(1, heat.countdownDurationSec || race.config.countdownSec || 5);
      let liveRem = Math.max(0, Math.min(nomSec, Number(heat.countdownRemainingSec ?? nomSec)));
      if (heat.countdownStartUs && heat.countdownStartUs > 0 && serverNowUs > 0) {
        if (serverNowUs < heat.countdownStartUs) {
          liveRem = nomSec;
        } else {
          liveRem = Math.max(0, nomSec - Math.max(0, (serverNowUs - heat.countdownStartUs) / 1e6));
        }
      } else if (this.store.lastRaceSyncPerfMs > 0) {
        const speedMult = this.store.simulatorRunning
          ? Math.max(1, this.store.simState?.speedMultiplier || 1)
          : 1;
        const dtSec =
          Math.max(0, (performance.now() - this.store.lastRaceSyncPerfMs) / 1000) * speedMult;
        const armRemBase = Number(heat.countdownArmRemainingSec ?? 0);
        if (armRemBase > 0) {
          liveRem = dtSec < armRemBase ? nomSec : Math.max(0, nomSec - (dtSec - armRemBase));
        } else {
          liveRem = Math.max(0, Math.min(nomSec, Number(heat.countdownRemainingSec ?? nomSec) - dtSec));
        }
      }
      return formatRaceClock(liveRem);
    }
    if (heat.state === "running") {
      const baseElapsed = Math.max(0, Number(heat.elapsedSec) || 0);
      let liveElapsed = baseElapsed;
      if (heat.startToneUs && heat.startToneUs > 0 && serverNowUs >= heat.startToneUs) {
        liveElapsed = Math.max(baseElapsed, (serverNowUs - heat.startToneUs) / 1e6);
      } else if (this.store.lastRaceSyncPerfMs > 0) {
        const speedMult = this.store.simulatorRunning
          ? Math.max(1, this.store.simState?.speedMultiplier || 1)
          : 1;
        const dtSec =
          Math.max(0, (performance.now() - this.store.lastRaceSyncPerfMs) / 1000) * speedMult;
        liveElapsed = baseElapsed + dtSec;
      }
      return formatHeatClockDisplay({ ...heat, elapsedSec: liveElapsed });
    }
    return "";
  }

  private updateLiveClockDom(): void {
    if (this.showDirectory) return;
    const race = this.currentRace;
    const jumpClockEl = this.el.querySelector<HTMLElement>("[data-live-jump-clock]");
    if (jumpClockEl) {
      const jumpHeat = this.getLiveJumpBannerHeat(race);
      if (jumpHeat && (jumpHeat.state === "running" || jumpHeat.state === "countdown")) {
        const nextTxt = `(${this.computeLiveHeatClockText(race, jumpHeat)})`;
        if (jumpClockEl.textContent !== nextTxt) {
          jumpClockEl.textContent = nextTxt;
        }
      }
    }
    if (this.activeTab !== "control") return;
    if (this.isMobileViewport() && this.mobileControlView === "signals") return;
    const heat = this.getControlStageHeat(race);
    if (!heat) return;
    const clockEl = this.el.querySelector<HTMLElement>("[data-race-clock]");
    const subEl = this.el.querySelector<HTMLElement>("[data-race-clock-sub]");
    const barEl = this.el.querySelector<HTMLElement>("[data-race-progress-fill]");
    if (!clockEl) return;

    const serverNowUs = this.store.liveServerTimestampUs;

    if (heat.state === "countdown") {
      const nomSec = Math.max(1, heat.countdownDurationSec || race.config.countdownSec || 5);
      let isArming = false;
      let liveRem = Math.max(0, Math.min(nomSec, Number(heat.countdownRemainingSec ?? nomSec)));
      if (heat.countdownStartUs && heat.countdownStartUs > 0 && serverNowUs > 0) {
        if (serverNowUs < heat.countdownStartUs) {
          isArming = true;
          liveRem = nomSec;
        } else {
          const elapsedCd = Math.max(0, (serverNowUs - heat.countdownStartUs) / 1e6);
          liveRem = Math.max(0, nomSec - elapsedCd);
        }
      } else {
        const armRemBase = Number(heat.countdownArmRemainingSec ?? 0);
        if (this.store.lastRaceSyncPerfMs > 0) {
          const speedMult = this.store.simulatorRunning
            ? Math.max(1, this.store.simState?.speedMultiplier || 1)
            : 1;
          const dtSec =
            Math.max(0, (performance.now() - this.store.lastRaceSyncPerfMs) / 1000) * speedMult;
          if (armRemBase > 0) {
            if (dtSec < armRemBase) {
              isArming = true;
              liveRem = nomSec;
            } else {
              liveRem = Math.max(0, nomSec - (dtSec - armRemBase));
            }
          } else {
            liveRem = Math.max(
              0,
              Math.min(nomSec, Number(heat.countdownRemainingSec ?? nomSec) - dtSec)
            );
          }
        } else if (armRemBase > 0) {
          isArming = true;
          liveRem = nomSec;
        }
      }
      clockEl.textContent = formatRaceClock(liveRem);
      clockEl.className = "race-clock mono is-countdown";
      const nextSub = isArming ? "Arming quads…" : "";
      if (subEl && subEl.textContent !== nextSub) subEl.textContent = nextSub;
      if (barEl) {
        barEl.style.width = "0%";
      }
      return;
    }

    let displayHeat = heat;
    if (heat.state === "running" && !race.emergencyStopped && race.lifecycle !== "paused") {
      const baseElapsed = Math.max(0, Number(heat.elapsedSec) || 0);
      let liveElapsed = baseElapsed;
      if (heat.startToneUs && heat.startToneUs > 0 && serverNowUs >= heat.startToneUs) {
        liveElapsed = Math.max(baseElapsed, (serverNowUs - heat.startToneUs) / 1e6);
      } else if (this.store.lastRaceSyncPerfMs > 0) {
        const speedMult = this.store.simulatorRunning
          ? Math.max(1, this.store.simState?.speedMultiplier || 1)
          : 1;
        const dtSec =
          Math.max(0, (performance.now() - this.store.lastRaceSyncPerfMs) / 1000) * speedMult;
        liveElapsed = baseElapsed + dtSec;
      }
      displayHeat = { ...heat, elapsedSec: liveElapsed };
    }

    clockEl.textContent = formatHeatClockDisplay(displayHeat);
    clockEl.className = `race-clock mono ${
      race.emergencyStopped
        ? "is-stopped"
        : heat.state === "running"
          ? heat.inOvertime
            ? "is-overtime"
            : "is-running"
          : ""
    }`;
    if (subEl) {
      let nextSub = "";
      if (race.emergencyStopped) {
        nextSub = "Aborted · RF disarmed";
      } else if (race.lifecycle === "paused") {
        nextSub = "Race paused · RF safe";
      } else {
        const limitStr = heat.timeLimitSec > 0 ? ` / ${formatRaceClock(heat.timeLimitSec)}` : "";
        const lapsStr = heat.targetLaps > 0 ? `${heat.targetLaps} laps` : "Timed";
        nextSub = heat.inOvertime
          ? `Overtime · Finish current lap${limitStr}`
          : `${lapsStr}${limitStr}`;
      }
      if (subEl.textContent !== nextSub) subEl.textContent = nextSub;
    }
    if (barEl && displayHeat.timeLimitSec > 0) {
      const pct = Math.max(0, Math.min(100, (displayHeat.elapsedSec / displayHeat.timeLimitSec) * 100));
      barEl.style.width = `${pct.toFixed(1)}%`;
    }
  }

  private updateLiveRssiDom(): void {
    if (this.showDirectory || this.activeTab !== "control") return;
    if (this.isMobileViewport() && this.mobileControlView === "signals") return;
    const sfNode =
      this.store.nodes.find((n) => n.role === "START_FINISH") ?? this.store.nodes[0];
    if (!sfNode || !Array.isArray(sfNode.lastRssi)) return;
    const isLapRF = isLapRFMode(this.store.timingHardwareMode);
    const isRH = isRotorHazardMode(this.store.timingHardwareMode);
    this.el.querySelectorAll<HTMLElement>("[data-pilot-rssi]").forEach((row) => {
      const slot = Number(row.dataset.pilotRssi);
      if (slot <= 0) return;
      const val = sfNode.lastRssi[slot - 1];
      if (typeof val !== "number" || !Number.isFinite(val)) return;
      const pct = isLapRF
        ? Math.max(4, Math.min(100, ((val - 300) / (3400 - 300)) * 100))
        : isRH
          ? Math.max(4, Math.min(100, ((val - 15) / (235 - 15)) * 100))
          : Math.max(4, Math.min(100, ((val - -96) / (-32 - -96)) * 100));
      row.querySelectorAll<HTMLElement>(".race-rssi-fill").forEach((fill) => {
        fill.style.width = `${pct.toFixed(0)}%`;
      });
      const txt = row.querySelector<HTMLElement>(".race-rssi-val");
      if (txt) txt.textContent = isLapRF || isRH ? `${Math.round(val)}` : `${Math.round(val)} dBm`;
    });
  }

  private confirmDeleteRace(r: RaceTournamentState): void {
    if (isRaceOngoing(r)) {
      this.reportErr(
        `Cannot delete ongoing race “${r.config.eventName}”. Pause or complete it first.`
      );
      return;
    }
    const rId = r.raceId ?? "";
    const name = r.config.eventName || "Race";
    const confirmedCount = r.heats.filter((h) => h.state === "confirmed").length;
    const warn =
      confirmedCount > 0
        ? `This race has <strong>${confirmedCount} confirmed heat${confirmedCount === 1 ? "" : "s"}</strong> whose results will be permanently deleted.`
        : undefined;

    openConfirmModal({
      title: `Delete Race “${name}”?`,
      messageHtml: `<p>Are you sure you want to permanently delete <strong>${esc(name)}</strong>?</p>`,
      warningHtml: warn,
      confirmLabel: "Delete Race",
      danger: true,
      onConfirm: () =>
        this.api
          .eventAction({ action: "delete_race", raceId: rId })
          .then(() => {
            const wasViewingDeleted = this.viewingRaceId === rId || !this.showDirectory;
            if (this.viewingRaceId === rId) {
              this.setViewingRace("");
            }
            if (wasViewingDeleted || this.store.races.length === 0) {
              this.showDirectory = true;
              this.syncWorkspaceHash(true);
            }
            this.lastSig = "";
            this.render();
          })
          .catch(this.reportErr),
    });
  }

  private openRerunHeatModal(heatId: string): void {
    const race = this.currentRace;
    const targetHeat =
      (heatId ? race.heats.find((h) => h.id === heatId) : undefined) ??
      this.getControlStageHeat(race);
    const resolvedHeatId = targetHeat?.id ?? heatId;
    if (!resolvedHeatId) return;
    const label = targetHeat?.shortLabel || targetHeat?.title || resolvedHeatId;
    const passCount = targetHeat
      ? targetHeat.seats.reduce((sum, s) => sum + s.laps.length, 0)
      : 0;
    const warn =
      passCount > 0
        ? `All <strong>${passCount} recorded gate pass${passCount === 1 ? "" : "es"}</strong> and lap times in <strong>${esc(label)}</strong> will be cleared.`
        : undefined;

    openConfirmModal({
      title: `Re-run ${label}?`,
      messageHtml: `<p>Reset <strong>${esc(targetHeat?.title || label)}</strong> back to <strong>Staged</strong> so pilots can fly it again from the starting horn?</p>`,
      warningHtml: warn,
      confirmLabel: "Re-run Heat",
      danger: passCount > 0,
      onConfirm: () =>
        this.api
          .raceControl("reset", resolvedHeatId, race.raceId)
          .catch(this.reportErr),
    });
  }

  private openCloseStageModal(race: RaceTournamentState, stageIndex: number): void {
    const stages = resolveStagesList(race);
    const curStage = stages.find((s) => s.index === stageIndex);
    const stageFmt: StageFormat =
      curStage?.format ||
      (stageIndex === 1 && race.config.qualifyingRounds > 0
        ? "qualifying"
        : race.config.format === "open_qualifier"
          ? "open_qualifier"
          : (race.config.format as StageFormat));
    const stageTitle =
      curStage?.title ||
      (stages.length > 1 ? `Stage ${stageIndex}` : formatStageLabel(stageFmt));

    const stageHeats = race.heats.filter(
      (h) => h.stageIndex === stageIndex && h.state !== "aborted"
    );
    const confirmedCount = stageHeats.filter((h) => h.state === "confirmed").length;
    const unconfirmedHeats = stageHeats.filter((h) => h.state !== "confirmed");
    const hasLiveHeat = stageHeats.some(
      (h) => h.state === "countdown" || h.state === "running"
    );

    if (hasLiveHeat) {
      this.reportErr(
        `Finish or pause the live heat before ending this race.`
      );
      return;
    }
    if (confirmedCount === 0) {
      this.reportErr(
        `Confirm at least one heat before ending this race.`
      );
      return;
    }

    const outgoingConns = (race.stageConnections ?? []).filter(
      (sc) => !sc.invalid && sc.fromStageIndex === stageIndex
    );
    const downstreamDescriptions = outgoingConns.map((sc) => {
      const dst = stages.find((s) => s.index === sc.toStageIndex);
      const dstName = dst ? `Stage ${dst.index}: ${dst.title}` : `Stage ${sc.toStageIndex}`;
      if (sc.mode === "top_n" && sc.count && sc.count > 0) {
        return `Top ${sc.count} pilots → <strong>${esc(dstName)}</strong>`;
      }
      if (sc.mode === "seed_range" && sc.seedStart) {
        const endLbl = sc.seedEnd && sc.seedEnd >= sc.seedStart ? `#${sc.seedEnd}` : "end";
        return `Seeds #${sc.seedStart}–${endLbl} → <strong>${esc(dstName)}</strong>`;
      }
      return `Qualified pilots → <strong>${esc(dstName)}</strong>`;
    });

    if (
      downstreamDescriptions.length === 0 &&
      stageIndex === 1 &&
      stages.length >= 2 &&
      (stageFmt === "qualifying" || stageFmt === "open_qualifier")
    ) {
      const dst = stages.find((s) => s.index === 2);
      if (dst) {
        downstreamDescriptions.push(
          `Seeded pilots → <strong>Stage 2: ${esc(dst.title)}</strong>`
        );
      }
    }

    const hasDownstream = downstreamDescriptions.length > 0;
    const qualMetric =
      curStage?.settings?.qualifyingMetric ||
      race.config.qualifyingMetric ||
      "consecutive_3";

    const raceDisplayName = race.config.eventName || "this race";
    let title = hasDownstream ? `Close ${stageTitle}?` : `End ${race.config.eventName || "Race"}?`;
    let messageHtml = "";
    let warningHtml: string | undefined;
    let confirmLabel = hasDownstream ? "Close Stage & Seed Next" : "End Race";

    if (stageFmt === "open_qualifier") {
      title = hasDownstream ? `Close Open Qualifier (${stageTitle})?` : `End ${race.config.eventName || "Open Qualifier"}?`;
      confirmLabel = hasDownstream ? "Close Qualifier & Seed Next" : "End Race";
      const outcomeHtml = hasDownstream
        ? `seed downstream stage${downstreamDescriptions.length === 1 ? "" : "s"} (${downstreamDescriptions.join(", ")}) and advance Race Control to the next stage.`
        : `lock final Open Qualifier standings and mark <strong>${esc(raceDisplayName)}</strong> as <strong>Completed</strong>.`;
      messageHtml = `
        <p>You are ending <strong>${esc(hasDownstream ? stageTitle : raceDisplayName)}</strong> with <strong>${confirmedCount} confirmed heat${confirmedCount === 1 ? "" : "s"}</strong> ranked by <strong>${esc(formatQualifyingMetricLabel(qualMetric))}</strong>.</p>
        <p style="margin-top:8px">Ending this qualifier will stop walk-up queueing and ${outcomeHtml}</p>`;
      if (unconfirmedHeats.length > 0) {
        warningHtml = `<strong>${unconfirmedHeats.length} unflown / unconfirmed queued heat${unconfirmedHeats.length === 1 ? "" : "s"}</strong> in the Flight Queue will be discarded.`;
      }
    } else if (stageFmt === "qualifying") {
      title = hasDownstream ? `Close Qualifier (${stageTitle})?` : `End ${race.config.eventName || "Race"}?`;
      confirmLabel = hasDownstream ? "Close Qualifier & Seed Next" : "End Race";
      const outcomeHtml = hasDownstream
        ? `seed downstream stage${downstreamDescriptions.length === 1 ? "" : "s"} (${downstreamDescriptions.join(", ")}) and advance Race Control.`
        : `finalize qualifying standings and mark <strong>${esc(raceDisplayName)}</strong> as <strong>Completed</strong>.`;
      messageHtml = `
        <p>You are ending <strong>${esc(hasDownstream ? stageTitle : raceDisplayName)}</strong> (${confirmedCount} of ${stageHeats.length} qualifying heats confirmed, ranked by <strong>${esc(formatQualifyingMetricLabel(qualMetric))}</strong>).</p>
        <p style="margin-top:8px">This will lock qualifying results and ${outcomeHtml}</p>`;
      if (unconfirmedHeats.length > 0) {
        warningHtml = `<strong>${unconfirmedHeats.length} remaining qualifying heat${unconfirmedHeats.length === 1 ? "" : "s"}</strong> have not been confirmed and will be skipped.`;
      }
    } else {
      const formatHuman = formatStageLabel(stageFmt);
      const leaderCallsign = race.standings?.[0]?.callsign;
      const outcomeHtml = hasDownstream
        ? `lock ${esc(formatHuman)} standings, advance ${downstreamDescriptions.join(", ")}, and move Race Control to the next stage.`
        : `finalize results${leaderCallsign ? ` (crowning <strong>${esc(leaderCallsign)}</strong> #1)` : ""} and mark <strong>${esc(raceDisplayName)}</strong> as <strong>Completed</strong>.`;
      messageHtml = `
        <p>You are ending <strong>${esc(hasDownstream ? stageTitle : raceDisplayName)}</strong> (${confirmedCount} of ${stageHeats.length} heats confirmed).</p>
        <p style="margin-top:8px">This will ${outcomeHtml}</p>`;
      if (unconfirmedHeats.length > 0) {
        warningHtml = `Ending early will skip <strong>${unconfirmedHeats.length} unconfirmed heat${unconfirmedHeats.length === 1 ? "" : "s"}</strong> and rank pilots from confirmed heats so far.`;
      }
    }

    openConfirmModal({
      title,
      messageHtml,
      warningHtml,
      confirmLabel,
      danger: unconfirmedHeats.length > 0,
      onConfirm: () =>
        this.api
          .stageControl("complete_stage_early", stageIndex)
          .then(() => {
            if (this.disposed) return;
            const updated = this.currentRace;
            if (updated.activeStageIndex && updated.activeStageIndex >= 1) {
              this.bracketStage = updated.activeStageIndex;
            }
            this.lastSig = "";
            this.render();
          })
          .catch(this.reportErr),
    });
  }

  private findExactRaceByName(name: string, allRaces = this.getEffectiveRaces()): RaceTournamentState | undefined {
    const trimmed = name.trim().toLowerCase();
    if (!trimmed || trimmed.startsWith("#")) return undefined;
    return allRaces.find((r, idx) => (r.config.eventName || `Race ${idx + 1}`).trim().toLowerCase() === trimmed);
  }

  private createRaceInline(fromEnterKey = false): void {
    const allRaces = this.getEffectiveRaces();
    const trimmedQuery = this.dirSearchQuery.trim();
    if (fromEnterKey && (!trimmedQuery || trimmedQuery.startsWith("#"))) {
      return;
    }
    const exactMatch = this.findExactRaceByName(trimmedQuery, allRaces);
    if (exactMatch) {
      return;
    }
    let name = !trimmedQuery.startsWith("#") ? trimmedQuery : "";
    if (!name) {
      let n = allRaces.length + 1;
      const existingSlugs = new Set(
        allRaces.map((r) => slugifyRaceName(r.config.eventName || "Race"))
      );
      while (existingSlugs.has(slugifyRaceName(`Race ${n}`))) {
        n++;
      }
      name = `Race ${n}`;
    }
    this.dirSearchQuery = "";
    const searchEl = this.el.querySelector<HTMLInputElement>("[data-race-dir-search]");
    if (searchEl) searchEl.value = "";
    this.dirStatusFilter = "all";
    this.selectedFilterTags.clear();
    this.untaggedOnly = false;
    this.editingNameForRaceId = "";
    this.editingTagsForRaceId = "";
    this.pendingFocusRaceId = "";
    this.errorMsg = "";
    void this.api
      .eventAction({
        action: "create_race",
        name,
        dontSelect: true,
      })
      .then(async (created) => {
        if (this.disposed) return;
        if (capabilitiesSnapshot().demoMode && created?.raceId) {
          const scope = { kind: "race" as const, id: created.raceId };
          const raceObj =
            this.getEffectiveRaces().find((r) => r.raceId === created.raceId) ?? created;
          const nodes = [...this.store.raceNodes(raceObj).nodes].sort(
            (a, b) => a.trackOrder - b.trackOrder
          );
          if (nodes.length > 1) {
            const hubTimer = this.store.detectedTimers.find((d) => d.isHub && d.online) ??
              this.store.detectedTimers.find((d) => d.isHub);
            const keepNode = nodes.find((n) => n.role === "START_FINISH") ?? nodes[0];
            for (const n of nodes) {
              if (n.gateId !== keepNode.gateId) {
                await this.api.removeTrackNode(n.gateId, scope).catch(() => undefined);
              }
            }
            const targetTimerId = hubTimer?.timerId ?? keepNode.assignedTimerId ?? 1;
            await this.api
              .updateTrackNode(
                {
                  gateId: keepNode.gateId,
                  name: keepNode.name,
                  color: keepNode.color,
                  role: "START_FINISH",
                  assignedTimerId: targetTimerId,
                },
                scope
              )
              .catch(() => undefined);
          }
        }
        if (this.disposed) return;
        this.showDirectory = true;
        this.syncWorkspaceHash();
        this.lastSig = "";
        this.render();
      })
      .catch(this.reportErr);
  }

  private patchRaceRowsInlineDom(raceIds: Iterable<string>): boolean {
    if (!this.showDirectory) return false;
    const uniqueIds = Array.from(new Set(Array.from(raceIds).filter(Boolean)));
    if (uniqueIds.length === 0) return false;
    const allRaces = this.getEffectiveRaces();
    let patchedAll = true;
    for (const id of uniqueIds) {
      const tr = this.el.querySelector<HTMLTableRowElement>(
        `tr[data-race-row="${CSS.escape(id)}"]`
      );
      const r = allRaces.find((item) => item.raceId === id);
      if (!tr || !r) {
        patchedAll = false;
        continue;
      }
      const nameBox = tr.querySelector<HTMLElement>(
        "td.races-table-name-cell > .races-cell-box"
      );
      if (nameBox) {
        nameBox.innerHTML = this.renderSmartNameCell(id, r.config.eventName || "Race");
      }
      const tagsBox = tr.querySelector<HTMLElement>(
        "td.races-table-tags-cell > .races-cell-box"
      );
      if (tagsBox) {
        tagsBox.innerHTML = this.renderSmartTagsCell(id, r.tags ?? []);
      }
    }
    if (patchedAll) {
      const cur = this.currentRace;
      this.lastSig = this.computeSig(cur, this.getActiveHeatForRace(cur));
    }
    return patchedAll;
  }

  private beginRaceNameEdit(raceId: string): void {
    const prevName = this.editingNameForRaceId;
    const prevTags = this.editingTagsForRaceId;
    this.editingNameForRaceId = raceId;
    this.editingTagsForRaceId = "";
    if (!this.patchRaceRowsInlineDom([prevName, prevTags, raceId])) {
      this.lastSig = "";
      this.render();
    }
    const focusInput = () => {
      const inp = this.el.querySelector<HTMLInputElement>(
        `input[data-race-name-input="${CSS.escape(raceId)}"]`
      );
      if (inp) {
        inp.focus();
        inp.select();
      }
    };
    focusInput();
    requestAnimationFrame(focusInput);
  }

  private beginRaceTagsEdit(raceId: string): void {
    const prevName = this.editingNameForRaceId;
    const prevTags = this.editingTagsForRaceId;
    this.editingTagsForRaceId = raceId;
    this.editingNameForRaceId = "";
    if (this.patchRaceRowsInlineDom([prevName, prevTags, raceId])) {
      this.mountActiveRaceTagEditor(true);
    } else {
      this.lastSig = "";
      this.render();
    }
  }

  private commitRaceNameInline(raceId: string, rawValue: string): void {
    const targetRace = this.getEffectiveRaces().find((r) => r.raceId === raceId);
    if (this.editingNameForRaceId === raceId) {
      this.editingNameForRaceId = "";
    }
    if (!targetRace) {
      this.lastSig = "";
      this.render();
      return;
    }
    const currentName = targetRace.config.eventName || "Race";
    const trimmed = rawValue.trim();
    if (!trimmed || trimmed === currentName) {
      if (!this.patchRaceRowsInlineDom([raceId])) {
        this.lastSig = "";
        this.render();
      }
      return;
    }
    void this.api
      .eventAction({ action: "rename_race", raceId, name: trimmed })
      .then(() => {
        if (!this.disposed) {
          if (!this.patchRaceRowsInlineDom([raceId])) {
            this.lastSig = "";
            this.render();
          }
        }
      })
      .catch(this.reportErr);
  }

  private commitRaceTagsList(raceId: string, nextTags: string[]): void {
    const targetRace = this.getEffectiveRaces().find((r) => r.raceId === raceId);
    if (this.editingTagsForRaceId === raceId) {
      this.editingTagsForRaceId = "";
    }
    if (!targetRace) {
      this.lastSig = "";
      this.render();
      return;
    }
    const prevTags = targetRace.tags ?? [];
    const unchanged =
      prevTags.length === nextTags.length &&
      prevTags.every((t, i) => t === nextTags[i]);
    if (unchanged) {
      if (!this.patchRaceRowsInlineDom([raceId])) {
        this.lastSig = "";
        this.render();
      }
      return;
    }
    void this.api
      .eventAction({ action: "set_race_tags", raceId, tags: nextTags })
      .then(() => {
        if (!this.disposed) {
          this.lastSig = "";
          this.render();
        }
      })
      .catch(this.reportErr);
  }

  private dismissMobileRaceDrawer(): void {
    if (!this.mobileSelectedRaceId || this.mobileRaceDrawerClosing) return;
    const overlay = this.el.querySelector<HTMLElement>(".pilot-dir-mobile-drawer-overlay");
    if (!overlay) {
      this.mobileSelectedRaceId = "";
      this.lastOpenedMobileRaceId = "";
      this.lastSig = "";
      this.render();
      return;
    }
    this.mobileRaceDrawerClosing = true;
    overlay.classList.add("is-closing");
    this.el.querySelectorAll<HTMLElement>(".dir-mobile-chip.is-selected").forEach((chip) => {
      chip.classList.remove("is-selected");
      chip.setAttribute("aria-selected", "false");
    });
    if (this.mobileRaceDrawerCloseTimer !== null) {
      clearTimeout(this.mobileRaceDrawerCloseTimer);
    }
    this.mobileRaceDrawerCloseTimer = setTimeout(() => {
      this.mobileRaceDrawerCloseTimer = null;
      if (!this.mobileRaceDrawerClosing) return;
      this.mobileRaceDrawerClosing = false;
      this.mobileSelectedRaceId = "";
      this.lastOpenedMobileRaceId = "";
      this.lastSig = "";
      this.render();
    }, 305);
  }

  private handleMobileRaceDrawerPointerMove = (e: PointerEvent): void => {
    if (this.mobileRaceDrawerDragStartY === null) return;
    const dy = e.clientY - this.mobileRaceDrawerDragStartY;
    if (dy >= 22) {
      this.mobileRaceDrawerDragStartY = null;
      this.dismissMobileRaceDrawer();
    }
  };

  private handleMobileRaceDrawerPointerUp = (): void => {
    this.mobileRaceDrawerDragStartY = null;
  };

  private mountActiveRaceTagEditor(autoFocus = true): void {
    if (this.mobileSelectedRaceId) {
      const drawerBox = this.el.querySelector<HTMLElement>(
        `[data-tag-box="race-drawer-${CSS.escape(this.mobileSelectedRaceId)}"]`
      );
      if (drawerBox) {
        const targetRace = this.getEffectiveRaces().find(
          (r) => r.raceId === this.mobileSelectedRaceId
        );
        mountTagPillEditor(drawerBox, {
          initialTags: targetRace?.tags ?? [],
          placeholder: "Add tags (comma or Enter)…",
          autoFocus: false,
          onCommit: (nextTags) => this.commitRaceTagsList(this.mobileSelectedRaceId, nextTags),
        });
      }
    }
    const rid = this.editingTagsForRaceId;
    if (!rid) return;
    const boxEl = this.el.querySelector<HTMLElement>(
      `[data-tag-box="race-row-${CSS.escape(rid)}"]`
    );
    if (!boxEl) return;
    const targetRace = this.getEffectiveRaces().find((r) => r.raceId === rid);
    mountTagPillEditor(boxEl, {
      initialTags: targetRace?.tags ?? [],
      placeholder: "Add tags (comma or Enter)…",
      autoFocus,
      onCommit: (nextTags) => this.commitRaceTagsList(rid, nextTags),
      onCancel: () => {
        if (this.editingTagsForRaceId === rid) {
          this.editingTagsForRaceId = "";
          if (!this.patchRaceRowsInlineDom([rid])) {
            this.lastSig = "";
            this.render();
          }
        }
      },
    });
  }

  private findExistingPilotCallsign(rawCallsign: string, race?: RaceTournamentState): string | null {
    const needle = rawCallsign.trim().toLowerCase();
    if (!needle) return null;
    for (const p of race?.roster ?? []) {
      if (p.callsign.trim().toLowerCase() === needle) {
        return p.callsign;
      }
    }
    for (const p of this.store.pilots) {
      if (p.callsign.trim().toLowerCase() === needle) {
        return p.callsign;
      }
    }
    return null;
  }

  private syncOpenQualWalkupDom(boxEl: HTMLElement | null): void {
    if (!boxEl) return;
    const inp = boxEl.querySelector<HTMLInputElement>('input[data-race-field="walkup-callsign"]');
    const btn = boxEl.querySelector<HTMLButtonElement>('[data-race-act="submit-walkup"]');
    const emptyEl = boxEl.querySelector<HTMLElement>("[data-oq-walkup-empty]");

    const trimmed = (inp?.value ?? this.walkUpCallsign).trim();
    const needle = trimmed.toLowerCase();
    const race = this.currentRace;
    const exactMatch = this.findExistingPilotCallsign(trimmed, race);

    let visibleCount = 0;
    let visibleAwayCount = 0;
    boxEl.querySelectorAll<HTMLElement>("[data-oq-pilot-slot]").forEach((row) => {
      const isInactiveRow = row.dataset.oqInactiveRow === "1";
      const isAwayRow = row.dataset.oqAwayRow === "1";
      const rowState =
        row.dataset.oqRowState ?? (isInactiveRow ? "inactive" : isAwayRow ? "away" : "ready");
      const hay = row.dataset.pilotSearchHay ?? "";
      const rowCallsign = row.dataset.pilotCallsign ?? "";
      const matchesQueueFilter =
        this.flightQueueFilter === "all" ? !isInactiveRow : rowState === this.flightQueueFilter;
      const show = needle ? hay.includes(needle) : matchesQueueFilter;
      row.hidden = !show;
      row.classList.toggle("is-exact-match", !!needle && rowCallsign === needle);
      if (show) {
        visibleCount++;
        if (isAwayRow) visibleAwayCount++;
      }
    });

    const awayDivider = boxEl.querySelector<HTMLElement>("[data-oq-away-divider]");
    if (awayDivider) {
      awayDivider.hidden =
        Boolean(needle) || this.flightQueueFilter !== "all" || visibleAwayCount === 0;
    }

    if (emptyEl) {
      emptyEl.hidden = visibleCount > 0;
      emptyEl.textContent = trimmed
        ? `No existing pilots match “${trimmed}” — click Add to register.`
        : this.flightQueueFilter === "queued"
          ? "No pilots currently queued."
          : this.flightQueueFilter === "flying"
            ? "No pilots currently flying."
            : this.flightQueueFilter === "away"
              ? "No pilots marked away."
              : "No checked-in active pilots yet — check pilots in or add a pilot above.";
    }

    if (btn) {
      btn.disabled = !trimmed || !!exactMatch;
      btn.title = exactMatch
        ? `Pilot “${exactMatch}” is already in roster`
        : trimmed
          ? `Add pilot “${trimmed}”`
          : "Search or type a unique callsign to add";
    }
  }

  private syncPanelWalkupDom(): void {
    const race = this.currentRace;
    const trimmed = this.pilotsSearchQuery.trim();
    const exactMatch = this.findExistingPilotCallsign(trimmed, race);

    const resultsEl = this.el.querySelector<HTMLElement>("[data-rc-pilots-results]");
    if (resultsEl) {
      resultsEl.innerHTML = this.renderPilotsPanelResults(race, this.activeTab);
    }
    const btn = this.el.querySelector<HTMLButtonElement>('[data-race-act="submit-panel-walkup"]');
    if (btn) {
      btn.disabled = !trimmed || !!exactMatch;
      btn.title = exactMatch
        ? `Pilot “${exactMatch}” is already in roster`
        : trimmed
          ? `Add pilot “${trimmed}”`
          : "Search or type a unique callsign to add";
    }
  }

  private submitWalkUpPilot(): void {
    const callsign = this.walkUpCallsign.trim();
    if (!callsign) return;
    if (this.findExistingPilotCallsign(callsign, this.currentRace)) {
      this.syncOpenQualWalkupDom(this.el.querySelector<HTMLElement>(".oq-flightline-box"));
      return;
    }
    const phoneticName = this.walkUpPhonetic.trim();
    this.walkUpCallsign = "";
    this.walkUpPhonetic = "";
    this.showWalkUpForm = false;
    const inp = this.el.querySelector<HTMLInputElement>('input[data-race-field="walkup-callsign"]');
    if (inp) inp.value = "";
    this.syncOpenQualWalkupDom(this.el.querySelector<HTMLElement>(".oq-flightline-box"));
    void this.api
      .eventAction({
        action: "add_race_pilot",
        callsign,
        phoneticName,
      })
      .catch(this.reportErr);
  }

  private submitPanelWalkUpPilot(): void {
    const callsign = this.pilotsSearchQuery.trim();
    if (!callsign) return;
    if (this.findExistingPilotCallsign(callsign, this.currentRace)) {
      this.syncPanelWalkupDom();
      return;
    }
    this.pilotsSearchQuery = "";
    this.panelWalkUpCallsign = "";
    const inp = this.el.querySelector<HTMLInputElement>('input[data-race-field="pilots-search"]');
    if (inp) inp.value = "";
    this.syncPanelWalkupDom();
    void this.api
      .eventAction({
        action: "add_race_pilot",
        callsign,
      })
      .catch(this.reportErr);
  }

  private applyTemplateChoice(templateId: string, overrideParams?: TemplateApplyParams): void {
    const race = this.currentRace;
    const hasStarted = race.heats.some((h) => !isHeatUnstarted(h.state));
    if (overrideParams) {
      this.draftPilotsPerHeat = overrideParams.pilotsPerHeat;
      this.draftTargetLaps = overrideParams.targetLaps;
      this.draftTimeLimitSec = overrideParams.timeLimitSec;
      this.draftQualRounds = overrideParams.qualifyingRounds;
    }
    this.fabOpen = false;
    this.fabSubmenu = "";
    this.refreshFabMenuDom();
    const doApply = () =>
      this.api
        .bracketEdit({
          action: "apply_template",
          templateId,
          pilotsPerHeat: this.draftPilotsPerHeat,
          targetLaps: this.draftTargetLaps,
          timeLimitSec: this.draftTimeLimitSec,
          qualifyingRounds: this.draftQualRounds,
        })
        .then(() => {
          this.bracketStage = 0;
          this.bktUi.selectedRoundIds.clear();
          this.bktUi.optimisticPositions.clear();
          this.bktUi.stageCameras = {};
          this.controlCamInitializedForRaceId = "";
          this.formatCamInitializedForRaceId = "";
          this.reviewCamInitializedForRaceId = "";
          this.reviewSelectedHeatId = "";
          this.lastSig = "";
          this.render();
          const curSt = this.getCurrentViewStage();
          this.fitAndStoreCurrentCamera(this.activeTab, curSt);
        })
        .catch(this.reportErr);

    if (race.generated && race.heats.length > 0) {
      const tplSpec = RACE_TEMPLATES.find((t) => t.id === templateId);
      const startedHeats = race.heats.filter((h) => !isHeatUnstarted(h.state));
      const s1StartedCount = startedHeats.filter((h) => h.stageIndex === 1).length;
      const s2StartedCount = startedHeats.filter((h) => h.stageIndex === 2).length;
      const isTwoStageTpl =
        templateId === "qual_double_elim" ||
        templateId === "qual_mains" ||
        templateId === "qual_single_elim";
      const preservesStage1 =
        isTwoStageTpl && race.totalStages >= 2 && s1StartedCount > 0;

      let warningHtml: string | undefined;
      if (hasStarted) {
        if (preservesStage1 && s2StartedCount === 0) {
          warningHtml = `<strong>Ongoing Race Notice:</strong> Confirmed Stage 1 Qualifying heats (${s1StartedCount}) and standings will be preserved, along with your pilot roster and tags. Only Stage 2 rounds &amp; heats will be replaced.`;
        } else if (preservesStage1 && s2StartedCount > 0) {
          warningHtml = `<strong>Destructive Action Discouraged Mid-Race:</strong> Stage 2 already has ${s2StartedCount} started/confirmed heat${s2StartedCount === 1 ? "" : "s"} whose results will be cleared! Stage 1 Qualifying results (${s1StartedCount} heat${s1StartedCount === 1 ? "" : "s"}), pilot roster, and tags will be preserved.`;
        } else {
          warningHtml = `<strong>Destructive Action Discouraged Mid-Race:</strong> ${startedHeats.length} heat${startedHeats.length === 1 ? " has" : "s have"} already started or been confirmed! Re-applying a template now will wipe recorded heat results and rebuild the schedule from scratch (pilot roster, attendance, and tags are preserved). Prefer editing individual unstarted rounds on the canvas instead.`;
        }
      }

      openConfirmModal({
        title: hasStarted
          ? `Replace Ongoing Race Format with ${tplSpec?.title || "Template"}?`
          : `Replace Current Rounds with ${tplSpec?.title || "Template"}?`,
        messageHtml: `<p>Applying <strong>${esc(tplSpec?.title || templateId)}</strong> will replace ${preservesStage1 ? "Stage 2 of" : `the current ${race.heats.length} heat${race.heats.length === 1 ? "" : "s"} in`} <strong>${esc(race.config.eventName)}</strong>.</p>`,
        warningHtml,
        confirmLabel: hasStarted ? "Replace Format Anyway" : "Apply Template",
        onConfirm: doApply,
      });
      return;
    }

    void doApply();
  }

  private openTemplatesDialog(autoPrompted = false): void {
    const race = this.currentRace;
    this.fabOpen = false;
    this.fabSubmenu = "";
    this.refreshFabMenuDom();
    if (!autoPrompted) {
      this.autoPromptTemplateClose = null;
      this.autoPromptTemplateRaceId = "";
    }
    const close = openTemplatesModal({
      race,
      templates: RACE_TEMPLATES,
      initialParams: {
        pilotsPerHeat: this.draftPilotsPerHeat,
        targetLaps: this.draftTargetLaps,
        timeLimitSec: this.draftTimeLimitSec,
        qualifyingRounds: this.draftQualRounds,
      },
      onApply: (tplId, params) => this.applyTemplateChoice(tplId, params),
      onSelectCustom: () => {
        const cur = this.currentRace;
        const roundCount = (cur.rounds ?? []).filter((r) => !isHandoffPortalRound(r)).length;
        if (!cur.generated && roundCount === 0) {
          return;
        }
        const startedHeats = cur.heats.filter((h) => !isHeatUnstarted(h.state)).length;
        openConfirmModal({
          title: `Reset "${cur.config.eventName || "Race"}" to Empty Custom Setup?`,
          messageHtml: `<p>Switching to <strong>Custom</strong> will clear the existing rounds so you can build from scratch (your pilot roster and tags are preserved).</p>`,
          warningHtml:
            startedHeats > 0
              ? `<strong>Warning:</strong> ${startedHeats} started or confirmed heat${startedHeats === 1 ? " will" : "s will"} be cleared.`
              : undefined,
          confirmLabel: "Clear to Custom Setup",
          danger: true,
          onConfirm: () =>
            this.api
              .bracketEdit({ action: "apply_template", templateId: "custom" })
              .then(() => {
                this.bracketStage = 0;
                this.mobileEditorUi.activePageId = "";
                this.switchWorkspaceTab("edit");
              })
              .catch(this.reportErr),
        });
      },
    });
    if (autoPrompted) {
      this.autoPromptTemplateClose = close;
      this.autoPromptTemplateRaceId = race.raceId;
    }
  }

  private addNodeToCanvas(
    presetKind:
      | "race"
      | "qualifying"
      | "open_qualifier"
      | "zippyq_qualifier"
      | "points_mains"
      | "losers"
      | "finals"
      | "seeded",
    preferredSpot?: { x: number; y: number }
  ): void {
    const race = this.currentRace;
    const viewStage = this.getCurrentViewStage(race);
    const viewport = this.el.querySelector<HTMLElement>("[data-rc-viewport]");
    const rect = viewport?.getBoundingClientRect();
    const spawnKind = presetKind === "points_mains" ? "race" : presetKind;
    const suggestedSpawn =
      preferredSpot ??
      suggestNewRoundSpawnPosition(
        race,
        this.bktUi,
        rect?.width || 1280,
        rect?.height || 760,
        spawnKind,
        viewStage
      );
    const spawn = this.findUnoccupiedCanvasSpot(RC_NODE_WIDTH, 240, suggestedSpawn);

    const stageRounds = (race.rounds ?? []).filter(
      (r) => r.stageIndex === viewStage && !isHandoffPortalRound(r)
    );

    const existingRoundCount = stageRounds.length;
    const qualRoundCount = stageRounds.filter((r) => r.stageFormat === "qualifying").length;
    const loserCount = stageRounds.filter((r) => r.bracketLane === "losers").length;
    const hasIncomingStageLink =
      (race.stageConnections ?? []).some((sc) => sc.toStageIndex === viewStage && !sc.invalid) ||
      (viewStage > 1 && !(race.stages && race.stages.length > 0));
    const stgSettings =
      (race.stages ?? []).find((s) => s.index === viewStage)?.settings ?? race.config;

    let title = "";
    let bracketLane = "winners";
    let stageFormat: "single_elimination" | "qualifying" | "open_qualifier" | "points_mains" =
      "single_elimination";
    let linkMode: "all_active_pilots" | "stage_seeds" | "empty" = "empty";
    let targetLaps = stgSettings.targetLaps || race.config.targetLaps || 3;

    switch (presetKind) {
      case "qualifying":
        title = `Qualifying ${qualRoundCount + 1}`;
        bracketLane = "qualifying";
        stageFormat = "qualifying";
        targetLaps = 0;
        if (existingRoundCount === 0) linkMode = "all_active_pilots";
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
      case "losers":
        title = loserCount === 0 ? "Redemption 1" : `Redemption ${loserCount + 1}`;
        bracketLane = "losers";
        linkMode = "empty";
        break;
      case "finals":
        title = "Finals";
        bracketLane = "finals";
        linkMode = "empty";
        break;
      case "seeded":
        linkMode = hasIncomingStageLink ? "stage_seeds" : "all_active_pilots";
        break;
      case "race":
      default:
        break;
    }

    if (this.isCanvasLocked("edit", viewStage)) {
      this.setCanvasLocked(false, "edit", viewStage);
      this.refreshBoardControlsDom();
    }
    this.fabOpen = false;
    this.fabSubmenu = "";
    this.refreshFabMenuDom();
    this.bktUi.connectingFromRoundId = "";
    this.bktUi.connectingFromPortDir = "right";
    this.bktUi.openWireMenuId = "";
    this.bktUi.openNodeMenuId = "";

    const prevRoundIds = new Set((race.rounds ?? []).map((r) => r.id));

    void this.api
      .bracketEdit({
        action: "add_round",
        stageIndex: viewStage,
        title: title || undefined,
        bracketLane,
        stageFormat,
        targetLaps,
        timeLimitSec: race.config.timeLimitSec || 120,
        linkMode,
        hasPos: true,
        posX: spawn.x,
        posY: spawn.y,
      })
      .then((nextState) => {
        if (this.disposed) return;
        const updated = nextState ?? this.currentRace;
        const addedRound = (updated.rounds ?? []).find(
          (r) => r.stageIndex === viewStage && !prevRoundIds.has(r.id) && !isHandoffPortalRound(r)
        );
        const nodeEl = addedRound
          ? this.el.querySelector<HTMLElement>(
              `[data-round-node="${CSS.escape(addedRound.id)}"]`
            )
          : null;
        this.smoothPanWorldRectIntoView(
          spawn.x,
          spawn.y,
          nodeEl?.offsetWidth || RC_NODE_WIDTH,
          nodeEl?.offsetHeight || 240
        );
        this.flashJustAddedElement(nodeEl);
      })
      .catch(this.reportErr);
  }

  private deleteSelectedCanvasRounds(): void {
    const ids = Array.from(this.bktUi.selectedRoundIds).filter((id) => !isHandoffPortalRound(id));
    if (ids.length === 0) return;
    const race = this.currentRace;
    const selectedRounds = (race.rounds ?? []).filter(
      (r) => ids.includes(r.id) && !isHandoffPortalRound(r)
    );
    if (selectedRounds.length === 0) {
      this.bktUi.selectedRoundIds.clear();
      this.lastSig = "";
      this.render();
      return;
    }

    const startedHeat = race.heats.find(
      (h) => h.roundId && ids.includes(h.roundId) && !isHeatUnstarted(h.state)
    );
    if (startedHeat) {
      this.reportErr(
        `Cannot delete selected round(s) because heat ${startedHeat.shortLabel} has already started.`
      );
      return;
    }

    const positions = collectStageRoundPositions(
      this.el,
      race,
      this.getCurrentViewStage(),
      this.bktUi
    );
    const needsConfirm = selectedRounds.some((r) => roundNeedsDeleteConfirmation(race, r.id));
    if (!needsConfirm) {
      this.bktUi.selectedRoundIds.clear();
      void this.api
        .bracketEdit({ action: "delete_rounds", roundIds: ids, positions })
        .catch(this.reportErr);
      return;
    }

    const names = selectedRounds.map((r) => `“${esc(r.title)}”`).join(", ");
    openConfirmModal({
      title:
        selectedRounds.length === 1
          ? `Delete ${selectedRounds[0].title}?`
          : `Delete ${selectedRounds.length} Selected Rounds?`,
      messageHtml: `<p>Remove ${names} from the race graph? Connected lines will be disconnected automatically.</p>`,
      confirmLabel:
        selectedRounds.length === 1
          ? "Delete Round"
          : `Delete ${selectedRounds.length} Rounds`,
      danger: true,
      onConfirm: () => {
        this.bktUi.selectedRoundIds.clear();
        return this.api
          .bracketEdit({ action: "delete_rounds", roundIds: ids, positions })
          .catch(this.reportErr);
      },
    });
  }

  private resetControlLayoutAndGraph(): void {
    this.controlPanels = createDefaultControlPanels();
    this.showGraphOnControl = false;
    this.controlBoundaryY = 0;
    this.persistControlLayout();
    const curStage = this.getCurrentViewStage();
    this.bktUi.optimisticPositions.clear();
    void this.api
      .bracketEdit({ action: "reset_round_layout", stageIndex: curStage })
      .then(() => {
        if (this.disposed) return;
        this.lastSig = "";
        this.render();
        this.fitAndStoreCurrentCamera("control", curStage);
      })
      .catch(() => {
        if (this.disposed) return;
        this.lastSig = "";
        this.render();
        this.fitAndStoreCurrentCamera("control", curStage);
      });
  }

  private resetReviewLayout(): void {
    this.reviewPanels = createDefaultReviewPanels();
    this.persistControlLayout();
    const curStage = this.getCurrentViewStage();
    if (!this.isMobileViewport() && typeof window !== "undefined" && window.scrollY !== 0) {
      window.scrollTo(0, 0);
    }

    this.lastSig = "";
    this.render();
    this.fitAndStoreCurrentCamera("review", curStage);
  }

  private resetEditLayoutAndPanels(): void {
    this.editPilotsPanel = createDefaultEditPilotsPanel();
    this.persistControlLayout();
    const curStage = this.getCurrentViewStage();
    this.bktUi.optimisticPositions.clear();
    void this.api
      .bracketEdit({ action: "reset_round_layout", stageIndex: curStage })
      .then(() => {
        if (this.disposed) return;
        this.lastSig = "";
        this.render();
        this.fitAndStoreCurrentCamera("edit", curStage);
      })
      .catch(this.reportErr);
  }

  private resetFormatStageLayout(): void {
    this.fabOpen = false;
    this.fabSubmenu = "";
    this.bktUi.optimisticPositions.clear();
    void this.api
      .bracketEdit({ action: "reset_stage_layout" })
      .then(() => {
        if (this.disposed) return;
        this.lastSig = "";
        this.render();
        this.fitAndStoreCurrentCamera("format", this.getCurrentViewStage());
      })
      .catch(this.reportErr);
  }

  private addStageToFormat(
    stageFormat: StageFormat,
    preferredSpot?: { x: number; y: number },
    title?: string
  ): void {
    const race = this.currentRace;
    const stages = resolveStagesList(race);
    if (stages.length >= 5) {
      showToast("Maximum of 5 stages reached for a single race.", "info");
      return;
    }

    const suggested = preferredSpot ?? suggestNewStageSpawnPosition(race, this.bktUi);
    const spawn = this.findUnoccupiedCanvasSpot(FMT_NODE_WIDTH, 200, suggested);
    const stagePositions = collectFormatStagePositions(this.el, race, this.bktUi);
    const prevStageIds = new Set(stages.map((s) => s.id));

    if (this.isCanvasLocked("format")) {
      this.setCanvasLocked(false, "format");
      this.refreshBoardControlsDom();
    }
    this.fabOpen = false;
    this.fabSubmenu = "";
    this.refreshFabMenuDom();
    this.bktUi.connectingFromRoundId = "";
    this.bktUi.connectingFromPortDir = "right";
    this.bktUi.openWireMenuId = "";
    this.bktUi.openNodeMenuId = "";

    void this.api
      .bracketEdit({
        action: "add_stage",
        stageFormat,
        title: title || undefined,
        hasPos: true,
        posX: spawn.x,
        posY: spawn.y,
        stagePositions,
      })
      .then((nextState) => {
        if (this.disposed) return;
        const updated = nextState ?? this.currentRace;
        const addedStage = resolveStagesList(updated).find((s) => !prevStageIds.has(s.id));
        if (addedStage) {
          this.bracketStage = addedStage.index;
        }
        const nodeEl = addedStage
          ? this.el.querySelector<HTMLElement>(
              `[data-stage-node="${CSS.escape(addedStage.id)}"]`
            )
          : null;
        this.smoothPanWorldRectIntoView(
          spawn.x,
          spawn.y,
          nodeEl?.offsetWidth || FMT_NODE_WIDTH,
          nodeEl?.offsetHeight || 200
        );
        this.flashJustAddedElement(nodeEl);
      })
      .catch(this.reportErr);
  }

  private openBoardContextAddMenu(
    clientX: number,
    clientY: number,
    worldX: number,
    worldY: number,
    viaTouchLongPress: boolean
  ): void {
    if (this.showDirectory || this.isCanvasLocked()) return;
    const viewport = this.el.querySelector<HTMLElement>("[data-rc-viewport]");
    if (!viewport) return;

    const race = this.currentRace;
    const canEdit = race.lifecycle !== "completed" && race.lifecycle !== "scrapped";
    const mode = this.activeTab;

    if (this.fabOpen) {
      this.fabOpen = false;
      this.fabSubmenu = "";
      this.refreshFabMenuDom();
    }

    const roster: EventPilot[] = race.roster ?? [];
    const checkedInCount = roster.filter((p) => p.checkedIn).length;
    const viewStage = this.getCurrentViewStage(race);
    const preferred = {
      x: Math.max(24, Math.round(worldX - (mode === "format" ? FMT_NODE_WIDTH : RC_NODE_WIDTH) / 2)),
      y: Math.max(24, Math.round(worldY - 60)),
    };

    const options: WireDropOption[] = [];

    if (mode === "format") {
      const stagesCount = resolveStagesList(race).length;
      if (!canEdit || stagesCount >= 5) {
        if (stagesCount >= 5) {
          showToast("Maximum of 5 stages reached for a single race.", "info");
        }
        return;
      }
      options.push(
        { id: "fmt:qualifying", label: "Qualifier", iconHtml: icons.timer(15) },
        { id: "fmt:open_qualifier", label: "Open Qualifier", iconHtml: icons.zap(15) },
        { id: "fmt:zippyq_qualifier", label: "ZippyQ Qualifier", iconHtml: icons.zap(15) },
        { id: "fmt:single_elimination", label: "Single Elimination", iconHtml: icons.checkered(15) },
        { id: "fmt:double_elimination", label: "Double Elimination", iconHtml: icons.bracket(15) },
        { id: "fmt:points_mains", label: "Points / Mains", iconHtml: icons.trophy(15) },
        { id: "fmt:custom", label: "Custom Stage", iconHtml: icons.plus(15) }
      );
    } else if (mode === "edit") {
      if (!canEdit) return;
      options.push(
        { id: "node:qualifying", label: "Qualifier", iconHtml: icons.timer(15) },
        { id: "node:open_qualifier", label: "Open Qualifier", iconHtml: icons.zap(15) },
        { id: "node:zippyq_qualifier", label: "ZippyQ", iconHtml: icons.zap(15) },
        { id: "node:race", label: "Race Round", iconHtml: icons.checkered(15) },
        { id: "node:points_mains", label: "Points Round", iconHtml: icons.layers(15) },
        { id: "node:finals", label: "Finals", iconHtml: icons.trophy(15) }
      );
      if (!isRootStage(race, viewStage) && !this.editPilotsPanel.visible) {
        options.push({
          id: "panel:pilots",
          label: `Pilots Roster (${checkedInCount})`,
          iconHtml: icons.pilot(15),
        });
      }
    } else if (mode === "review") {
      if (!this.reviewPanels.review_heat.visible) {
        options.push({
          id: "panel:review_heat",
          label: "Heat Review",
          iconHtml: icons.reviewCheck(15),
        });
      }
      if (!this.reviewPanels.review_list.visible) {
        options.push({
          id: "panel:review_list",
          label: "Executed Heats",
          iconHtml: icons.calendar(15),
        });
      }
      if (this.isMultiGPVerified() && !this.reviewPanels.review_mgp.visible) {
        options.push({
          id: "panel:review_mgp",
          label: "MultiGP Sync",
          iconHtml: icons.upload(15),
        });
      }
      if (options.length === 0) {
        showToast("All Review panels are already on the board.", "info");
        return;
      }
    } else {
      const isOpenQualStage = hasOpenQualifierRound(race);
      if (!this.controlPanels.cockpit.visible) {
        options.push({ id: "panel:cockpit", label: "Race Control", iconHtml: icons.checkered(15) });
      }
      if (!this.controlPanels.heatline.visible) {
        options.push({ id: "panel:heatline", label: "Flight Line", iconHtml: icons.flag(15) });
      }
      if (isOpenQualStage && !this.controlPanels.flightline.visible) {
        options.push({ id: "panel:flightline", label: "Flight Queue", iconHtml: icons.zap(15) });
      }
      if (!this.controlPanels.schedule.visible) {
        options.push({
          id: "panel:schedule",
          label: "Heats Schedule",
          iconHtml: icons.calendar(15),
        });
      }
      if (!this.controlPanels.standings.visible) {
        options.push({
          id: "panel:standings",
          label: "Overall Standings",
          iconHtml: icons.trophy(15),
        });
      }
      if (!this.controlPanels.signals.visible) {
        options.push({
          id: "panel:signals",
          label: "Signal at each timer",
          iconHtml: icons.signal(15),
        });
      }
      if (!this.controlPanels.pilots.visible) {
        options.push({
          id: "panel:pilots",
          label: `Pilots Roster (${checkedInCount})`,
          iconHtml: icons.pilot(15),
        });
      }
      if (options.length === 0) {
        showToast("All Control panels are already on the board.", "info");
        return;
      }
    }

    if (options.length === 0) return;

    openWireDropMenu({
      viewport,
      clientX,
      clientY,
      ariaLabel: "Add element to board",
      ignoreDismissClickMs: viaTouchLongPress ? 650 : 0,
      options,
      onSelect: (optId) => {
        if (optId === "fmt:zippyq_qualifier") {
          this.addStageToFormat("open_qualifier", preferred, "ZippyQ Qualifier");
        } else if (optId.startsWith("fmt:")) {
          const fmt = optId.slice(4) as StageFormat;
          this.addStageToFormat(fmt, preferred);
        } else if (optId.startsWith("node:")) {
          const kind = optId.slice(5) as
            | "race"
            | "qualifying"
            | "open_qualifier"
            | "zippyq_qualifier"
            | "points_mains"
            | "losers"
            | "finals";
          this.addNodeToCanvas(kind, preferred);
        } else if (optId.startsWith("panel:")) {
          const pid = optId.slice(6) as AnyCanvasPanelId | "graph";
          this.addPanelToCanvas(pid, preferred);
        }
      },
    });
  }

  private confirmDeleteStage(stage: RaceStage): void {
    const race = this.currentRace;
    const stages = resolveStagesList(race);
    const blockingHeat = race.heats.find(
      (h) => h.stageIndex === stage.index && isHeatCompletedOrRunning(h)
    );
    if (blockingHeat) {
      this.reportErr(
        `Cannot delete ${stage.title} because heat ${blockingHeat.shortLabel} is already completed or running.`
      );
      return;
    }

    const stageHeats = race.heats.filter((h) => h.stageIndex === stage.index);
    const stagePositions = collectFormatStagePositions(this.el, race, this.bktUi);
    const isLastStage = stages.length <= 1;

    const performRemoveStage = (): Promise<void> =>
      this.api
        .bracketEdit({
          action: "remove_stage",
          stageId: stage.id,
          stageIndex: stage.index,
          stagePositions,
        })
        .then((nextState) => {
          if (this.disposed) return;
          this.bktUi.selectedRoundIds.delete(stage.id);
          const updated = nextState ?? this.currentRace;
          const remainingStages = resolveStagesList(updated);
          if (remainingStages.length === 0) {
            this.bracketStage = 1;
            this.activeTab = "format";
            this.syncWorkspaceHash(false);
          } else {
            const present = getPresentStageIndices(updated);
            if (!present.includes(this.bracketStage)) {
              this.bracketStage = present[0] || 1;
            }
          }
          this.lastSig = "";
          this.render();
        })
        .catch(this.reportErr);

    if (!stageNeedsDeleteConfirmation(race, stage)) {
      void performRemoveStage();
      return;
    }

    openConfirmModal({
      title: `Delete Stage ${stage.index} (“${stage.title}”)?`,
      messageHtml: isLastStage
        ? `<p>Remove <strong>${esc(stage.title)}</strong> (${stageHeats.length} heat${stageHeats.length === 1 ? "" : "s"})? Your changes to this stage will be lost and <strong>${esc(race.config.eventName || "this race")}</strong> will return to an empty Format board.</p>`
        : `<p>Remove <strong>${esc(stage.title)}</strong> (${stageHeats.length} heat${stageHeats.length === 1 ? "" : "s"}) from the tournament format? Any pilot assignments, stage customizations, and connected stage links will be lost.</p>`,
      confirmLabel: "Delete Stage",
      danger: true,
      onConfirm: performRemoveStage,
    });
  }

  private deleteSelectedFormatStages(): void {
    const race = this.currentRace;
    const stages = resolveStagesList(race);
    const selected = stages.filter((s) => this.bktUi.selectedRoundIds.has(s.id));
    if (selected.length === 0) return;
    // Delete the first selected stage via confirmation modal
    this.confirmDeleteStage(selected[0]);
  }

  private getFormatCallbacks() {
    return {
      onOpenStageEdit: (stageIndex: number) => {
        this.bracketStage = stageIndex;
        this.switchWorkspaceTab("edit");
      },
      onDeleteStage: (stage: RaceStage) => this.confirmDeleteStage(stage),
      onError: (msg: string) => this.reportErr(msg),
    };
  }

  private updateRaceConfigPatch(patch: Partial<RaceSetupConfig>): void {
    const cur = this.currentRace.config;
    const next: RaceSetupConfig = {
      ...cur,
      ...patch,
    };
    void this.api.configureRace(next, false, true).catch(this.reportErr);
  }

  private handleDblClick = (e: MouseEvent): void => {
    if (
      handleFormatEditEvent(
        e,
        this.api,
        () => this.currentRace,
        this.bktUi,
        this.getFormatCallbacks()
      )
    ) {
      return;
    }
    handleBracketEditEvent(
      e,
      this.api,
      () => this.currentRace,
      this.bktUi,
      (m) => this.reportErr(m)
    );
  };

  private handleGlobalKeyDown = (e: KeyboardEvent): void => {
    if (!this.isViewActive || this.showDirectory) return;
    if (document.querySelector(".slaprf-modal-backdrop")) return;
    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLSelectElement ||
      active instanceof HTMLTextAreaElement
    ) {
      return;
    }
    if (
      this.activeTab === "format" &&
      (e.key === "Delete" || e.key === "Backspace") &&
      this.bktUi.selectedRoundIds.size > 0
    ) {
      e.preventDefault();
      this.deleteSelectedFormatStages();
    } else if (
      this.activeTab === "edit" &&
      (e.key === "Delete" || e.key === "Backspace") &&
      this.bktUi.selectedRoundIds.size > 0
    ) {
      e.preventDefault();
      this.deleteSelectedCanvasRounds();
    } else if (e.key === "Escape") {
      if (this.openMarshalMenuKey) {
        this.openMarshalMenuKey = "";
        this.refreshSinglePanelDom(this.activeTab === "review" ? "review_heat" : "heatline");
        return;
      }
      if (this.mobileStageMenuOpen) {
        this.mobileStageMenuOpen = false;
        this.refreshTopLeftBarDom();
        return;
      }
      if (this.formatMenuOpen) {
        this.formatMenuOpen = false;
        this.refreshTopLeftBarDom();
        return;
      }
      const hadGraphUi =
        !!this.bktUi.connectingFromRoundId ||
        !!this.bktUi.openNodeMenuId ||
        !!this.bktUi.openWireMenuId ||
        this.bktUi.selectedRoundIds.size > 0;
      if (this.fabOpen && !hadGraphUi) {
        this.fabOpen = false;
        this.fabSubmenu = "";
        this.refreshFabMenuDom();
      } else if (this.fabOpen || hadGraphUi) {
        this.fabOpen = false;
        this.fabSubmenu = "";
        this.bktUi.connectingFromRoundId = "";
        this.bktUi.openNodeMenuId = "";
        this.bktUi.openWireMenuId = "";
        this.bktUi.selectedRoundIds.clear();
        this.lastSig = "";
        this.render();
      }
    }
  };

  private handleInput = (e: Event): void => {
    if (
      handleBracketEditEvent(
        e,
        this.api,
        () => this.currentRace,
        this.bktUi,
        (m) => this.reportErr(m)
      )
    ) {
      return;
    }
    const t = e.target as HTMLElement | null;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.hasAttribute("data-race-dir-search")) {
      this.dirSearchQuery = t.value;
      this.refreshDirectoryResultsDom();
      return;
    }
    switch (t.dataset.raceField) {
      case "pilots-search": {
        this.pilotsSearchQuery = t.value;
        this.syncPanelWalkupDom();
        break;
      }
      case "walkup-callsign":
        this.walkUpCallsign = t.value;
        this.syncOpenQualWalkupDom(t.closest<HTMLElement>(".oq-flightline-box"));
        break;
      case "walkup-phonetic":
        this.walkUpPhonetic = t.value;
        break;
      case "lifecycle-reason":
        this.lifecycleReason = t.value;
        break;
      case "draft-laps":
        this.draftTargetLaps = Math.max(1, Number(t.value) || 3);
        break;
      case "draft-time":
        this.draftTimeLimitSec = Math.max(15, Number(t.value) || 120);
        break;
      case "draft-qual-rounds":
        this.draftQualRounds = Math.max(1, Number(t.value) || 2);
        break;
    }
  };

  private handleFocusOut = (e: FocusEvent): void => {
    const t = e.target as HTMLElement | null;
    if (!(t instanceof HTMLInputElement)) return;
    const nameRaceId = t.dataset.raceNameInput;
    if (nameRaceId) {
      const val = t.value;
      window.setTimeout(() => {
        if (this.disposed) return;
        if (this.editingNameForRaceId === nameRaceId || this.mobileSelectedRaceId === nameRaceId) {
          this.commitRaceNameInline(nameRaceId, val);
        }
      }, 0);
    }
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (
      handleBracketEditEvent(
        e,
        this.api,
        () => this.currentRace,
        this.bktUi,
        (m) => this.reportErr(m)
      )
    ) {
      return;
    }
    const t = e.target as HTMLElement | null;
    if (!(t instanceof HTMLInputElement)) return;
    if (e.key === "Escape") {
      if (t.dataset.raceNameInput) {
        const rid = t.dataset.raceNameInput;
        e.preventDefault();
        this.editingNameForRaceId = "";
        if (!this.patchRaceRowsInlineDom([rid])) {
          this.lastSig = "";
          this.render();
        }
        return;
      }
      if (t.hasAttribute("data-race-dir-search") && this.dirSearchQuery) {
        e.preventDefault();
        this.dirSearchQuery = "";
        t.value = "";
        this.refreshDirectoryResultsDom();
        return;
      }
      if (t.dataset.raceField === "walkup-callsign" && this.walkUpCallsign) {
        e.preventDefault();
        this.walkUpCallsign = "";
        t.value = "";
        this.syncOpenQualWalkupDom(t.closest<HTMLElement>(".oq-flightline-box"));
        return;
      }
      if (t.dataset.raceField === "pilots-search" && this.pilotsSearchQuery) {
        e.preventDefault();
        this.pilotsSearchQuery = "";
        t.value = "";
        this.syncPanelWalkupDom();
        return;
      }
    }
    if (e.key !== "Enter") return;
    if (t.hasAttribute("data-race-dir-search")) {
      e.preventDefault();
      this.createRaceInline(true);
    } else if (t.dataset.raceNameInput) {
      e.preventDefault();
      this.commitRaceNameInline(t.dataset.raceNameInput, t.value);
    } else if (
      t.dataset.raceField === "walkup-callsign" ||
      t.dataset.raceField === "walkup-phonetic"
    ) {
      e.preventDefault();
      this.submitWalkUpPilot();
    } else if (t.dataset.raceField === "pilots-search") {
      e.preventDefault();
      this.submitPanelWalkUpPilot();
    } else if (t.dataset.raceField === "rename-active") {
      e.preventDefault();
      t.blur();
    }
  };

  private handleChange = (e: Event): void => {
    if (handleMobileRaceEditorChange(e, this.getMobileEditorCallbacks())) {
      this.errorMsg = "";
      return;
    }
    if (handleDesktopRaceTableChange(e, this.getDesktopTableCallbacks())) {
      this.errorMsg = "";
      return;
    }
    if (
      handleBracketEditEvent(
        e,
        this.api,
        () => this.currentRace,
        this.bktUi,
        (m) => this.reportErr(m)
      )
    ) {
      this.errorMsg = "";
      return;
    }
    const t = e.target as HTMLElement | null;
    if (!t) return;

    if (t instanceof HTMLSelectElement) {
      if (t.hasAttribute("data-review-heat-select")) {
        const hid = t.value;
        if (hid && this.reviewSelectedHeatId !== hid) {
          this.reviewSelectedHeatId = hid;
          this.openMarshalMenuKey = "";
          this.refreshSinglePanelDom("review_heat");
          this.refreshSinglePanelDom("review_list");
        }
        return;
      }
      if (t.dataset.raceField === "draft-pph") {
        this.draftPilotsPerHeat = Math.max(2, Math.min(8, Number(t.value) || 4));
        return;
      }
      if (t.hasAttribute("data-race-switch")) {
        const val = t.value;
        if (val === "__new__") {
          this.saveCurrentCamera();
          this.setViewingRace("");
          this.showDirectory = true;
          this.syncWorkspaceHash(true);
          this.lastSig = "";
          this.render();
          return;
        }
        if (val && val !== this.currentRace.raceId) {
          this.saveCurrentCamera();
          this.lifecyclePrompt = "";
          void this.api
            .eventAction({ action: "select_race", raceId: val })
            .then(() => {
              this.setViewingRace(val);
              this.syncDraftDefaultsFromRace();
              this.syncWorkspaceHash(true);
              this.lastSig = "";
              this.render();
            })
            .catch(this.reportErr);
        }
        return;
      }
      if (t.dataset.cfgField === "pilots-per-heat") {
        const pph = Math.max(2, Math.min(8, Number(t.value) || 4));
        this.draftPilotsPerHeat = pph;
        this.updateRaceConfigPatch({
          pilotsPerHeat: pph,
          seatChannels: defaultChannelsForCount(pph),
        });
        return;
      }
      if (t.dataset.cfgField === "countdown-sec") {
        this.updateRaceConfigPatch({ countdownSec: Math.max(0, Number(t.value) || 0) });
        return;
      }
      if (t.dataset.cfgSeatIdx !== undefined) {
        const idx = Number(t.dataset.cfgSeatIdx);
        const ch = Number(t.value);
        const cur = [...this.currentRace.config.seatChannels];
        if (idx >= 0 && idx < cur.length && isValidEncodedSeatChannel(ch)) {
          const targetFreq = decodeBandChannel(ch)?.frequencyMhz ?? 0;
          const otherIdx = cur.findIndex(
            (existing, i) =>
              i !== idx &&
              (existing === ch ||
                (targetFreq > 0 && decodeBandChannel(existing)?.frequencyMhz === targetFreq))
          );
          if (otherIdx >= 0) {
            cur[otherIdx] = cur[idx];
          }
          cur[idx] = ch;
          this.updateRaceConfigPatch({ seatChannels: cur });
        }
        return;
      }
    }

    if (t instanceof HTMLInputElement) {
      if (t.dataset.raceField === "rename-active") {
        const name = t.value.trim();
        if (name && name !== this.currentRace.config.eventName) {
          void this.api
            .eventAction({
              action: "rename_race",
              raceId: this.currentRace.raceId,
              name,
            })
            .catch(this.reportErr);
        }
        return;
      }
      if (t.dataset.cfgField === "target-laps") {
        const laps = Math.max(0, Number(t.value) || 0);
        this.draftTargetLaps = laps || 3;
        this.updateRaceConfigPatch({ targetLaps: laps });
        return;
      }
      if (t.dataset.cfgField === "time-limit") {
        const sec = Math.max(15, Number(t.value) || 120);
        this.draftTimeLimitSec = sec;
        this.updateRaceConfigPatch({ timeLimitSec: sec });
        return;
      }
      if (t.dataset.attCheckSlot) {
        const slotIndex = Number(t.dataset.attCheckSlot);
        if (slotIndex > 0) {
          void this.api
            .eventAction({
              action: "update_attendance",
              slotIndex,
              checkedIn: t.checked,
            })
            .catch(this.reportErr);
        }
        return;
      }
      if (t.dataset.attNoteSlot) {
        const slotIndex = Number(t.dataset.attNoteSlot);
        if (slotIndex > 0) {
          void this.api
            .eventAction({
              action: "update_attendance",
              slotIndex,
              pilotNote: t.value,
            })
            .catch(this.reportErr);
        }
      }
    }
  };

  private runWithPreemptCheck(
    targetRace: RaceTournamentState,
    verbLabel: string,
    okLabel: string,
    onProceed: (preemptOngoing: boolean) => Promise<unknown>
  ): void {
    const otherOngoingRace = this.getEffectiveRaces().find(
      (r) => r.raceId && r.raceId !== targetRace.raceId && isRaceOngoing(r)
    );
    const activePractice =
      this.store.activePracticeSession && !this.store.activePracticeSession.paused
        ? this.store.activePracticeSession
        : null;

    if (!otherOngoingRace && !activePractice) {
      void onProceed(false).catch(this.reportErr);
      return;
    }

    const raceLabel = esc(targetRace.config.eventName || "this race");
    const conflictDesc =
      otherOngoingRace && activePractice
        ? `Race <strong>${esc(otherOngoingRace.config.eventName || "Another race")}</strong> and Practice <strong>${esc(activePractice.name || "Practice")}</strong> are currently active.`
        : otherOngoingRace
          ? `Race <strong>${esc(otherOngoingRace.config.eventName || "Another race")}</strong> is currently ongoing.`
          : `Practice session <strong>${esc(activePractice!.name || "Practice")}</strong> is currently ongoing.`;

    const resumeNote =
      targetRace.lifecycle === "paused"
        ? ` and make <strong>${raceLabel}</strong> active`
        : "";

    openConfirmPreemptModal({
      title: "Pause Active Session?",
      bodyHtml: `<p>${conflictDesc}</p><p>${esc(verbLabel)} in <strong>${raceLabel}</strong> will automatically pause it${resumeNote} so RF timer channels can switch cleanly.</p>`,
      okLabel,
      onConfirm: () => {
        void onProceed(true).catch(this.reportErr);
      },
    });
  }

  private scrollTabButtonIntoStrip(btn: HTMLElement | null | undefined): void {
    if (!btn) return;
    const track = btn.closest<HTMLElement>(".sched-lineup");
    if (!track) return;
    const maxScroll = track.scrollWidth - track.clientWidth;
    if (maxScroll <= 0) return;
    const trackRect = track.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const pad = 34;
    let targetLeft = track.scrollLeft;
    if (btnRect.left < trackRect.left + pad) {
      targetLeft += btnRect.left - (trackRect.left + pad);
    } else if (btnRect.right > trackRect.right - pad) {
      targetLeft += btnRect.right - (trackRect.right - pad);
    } else {
      return;
    }
    targetLeft = Math.max(0, Math.min(maxScroll, targetLeft));
    try {
      track.scrollTo({ left: targetLeft, behavior: "smooth" });
    } catch {
      track.scrollLeft = targetLeft;
    }
  }

  private handleClick = (e: Event): void => {
    if (handleMobileRaceEditorClick(e, this.el, this.getMobileEditorCallbacks())) {
      this.errorMsg = "";
      return;
    }
    if (handleDesktopRaceTableClick(e, this.el, this.getDesktopTableCallbacks())) {
      this.errorMsg = "";
      return;
    }
    if (
      handleFormatEditEvent(
        e,
        this.api,
        () => this.currentRace,
        this.bktUi,
        this.getFormatCallbacks()
      )
    ) {
      this.errorMsg = "";
      return;
    }
    if (
      handleBracketEditEvent(
        e,
        this.api,
        () => this.currentRace,
        this.bktUi,
        (m) => this.reportErr(m)
      )
    ) {
      this.errorMsg = "";
      return;
    }

    const target = e.target as HTMLElement | null;
    if (!target) return;

    const addStageBtn = target.closest<HTMLButtonElement>("[data-fmt-add-stage]");
    if (addStageBtn) {
      if (addStageBtn.disabled) return;
      const rawFmt = addStageBtn.dataset.fmtAddStage || "qualifying";
      if (rawFmt === "zippyq_qualifier") {
        this.addStageToFormat("open_qualifier", undefined, "ZippyQ Qualifier");
      } else {
        this.addStageToFormat(rawFmt as StageFormat);
      }
      return;
    }

    const addNodeBtn = target.closest<HTMLButtonElement>("[data-rc-add-node]");
    if (addNodeBtn) {
      if (addNodeBtn.disabled) return;
      const kind = (addNodeBtn.dataset.rcAddNode || "race") as
        | "race"
        | "qualifying"
        | "open_qualifier"
        | "zippyq_qualifier"
        | "points_mains"
        | "losers"
        | "finals"
        | "seeded";
      this.addNodeToCanvas(kind);
      return;
    }

    const toolBtn = target.closest<HTMLElement>("[data-rc-tool]");
    if (toolBtn) {
      this.bktUi.tool = (toolBtn.dataset.rcTool || "pan") as CanvasTool;
      this.refreshBoardControlsDom();
      return;
    }

    const setupViewBtn = target.closest<HTMLButtonElement>("[data-setup-view]");
    if (setupViewBtn) {
      const nextView: DesktopSetupViewMode =
        setupViewBtn.dataset.setupView === "table" ? "table" : "graph";
      if (this.desktopSetupView !== nextView) {
        if (this.desktopSetupView === "graph") {
          this.saveCurrentCamera();
        }
        this.desktopSetupView = nextView;
        persistDesktopSetupView(nextView);
        this.lastSig = "";
        this.render();
        this.triggerDesktopWorkspaceFade(true);
      }
      return;
    }

    const pilotsFilterBtn = target.closest<HTMLElement>("[data-pilots-filter]");
    if (pilotsFilterBtn) {
      const f = (pilotsFilterBtn.dataset.pilotsFilter || "all") as PilotsSubFilter;
      if (this.pilotsFilter !== f) {
        this.pilotsFilter = f;
        if (
          this.activeTab === "edit" &&
          !this.isMobileViewport() &&
          this.desktopSetupView === "table"
        ) {
          this.lastSig = "";
          this.render();
        } else {
          this.refreshSinglePanelDom("pilots");
        }
      }
      return;
    }

    const addPanelBtn = target.closest<HTMLButtonElement>("[data-rc-add-panel]");
    if (addPanelBtn) {
      if (addPanelBtn.disabled) return;
      const pid = (addPanelBtn.dataset.rcAddPanel ?? "") as AnyCanvasPanelId | "graph";
      if (pid) {
        this.addPanelToCanvas(pid);
      }
      return;
    }

    const panelToggleBtn = target.closest<HTMLElement>("[data-rc-panel-toggle]");
    if (panelToggleBtn) {
      const pid = panelToggleBtn.dataset.rcPanelToggle ?? "";
      if (pid === "graph") {
        this.showGraphOnControl = !this.showGraphOnControl;
        this.persistControlLayout();
        this.refreshGraphVisibilityDom();
        this.syncFabActiveStatesDom();
        return;
      }
      const p = this.getPanelStateForActiveTab(pid);
      if (p) {
        p.visible = !p.visible;
        if (p.visible) {
          p.collapsed = false;
          p.zIndex = ++this.panelZCounter;
        }
        this.persistControlLayout();
        this.refreshSinglePanelDom(pid as AnyCanvasPanelId);
      }
      return;
    }

    const panelCollapseBtn = target.closest<HTMLElement>("[data-rc-panel-collapse]");
    if (panelCollapseBtn) {
      const innerHeaderCtrl =
        panelCollapseBtn.tagName !== "BUTTON"
          ? target.closest<HTMLElement>(
              "button:not([data-rc-panel-collapse]), a, input, select, textarea, label, .segmented"
            )
          : null;
      if (!innerHeaderCtrl || !panelCollapseBtn.contains(innerHeaderCtrl)) {
        const pid = panelCollapseBtn.dataset.rcPanelCollapse ?? "";
        const p = this.getPanelStateForActiveTab(pid);
        if (p) {
          p.collapsed = !p.collapsed;
          if (!p.collapsed) {
            p.zIndex = ++this.panelZCounter;
          }
          this.persistControlLayout();
          this.refreshSinglePanelDom(pid as AnyCanvasPanelId);
        }
        return;
      }
    }

    const rcUiBtn = target.closest<HTMLElement>("[data-rc-ui]");
    if (rcUiBtn) {
      const viewport = this.el.querySelector<HTMLElement>("[data-rc-viewport]");
      const zoomAroundCenter = (factor: number): void => {
        if (!viewport) return;
        const r = viewport.getBoundingClientRect();
        const cx = r.width / 2;
        const cy = r.height / 2;
        const oldZ = this.bktUi.zoom || 1;
        const nextZ = clampZoom(oldZ * factor);
        if (nextZ === oldZ) return;
        const wx = (cx - this.bktUi.panX) / oldZ;
        const wy = (cy - this.bktUi.panY) / oldZ;
        this.bktUi.zoom = nextZ;
        this.bktUi.panX = cx - wx * nextZ;
        this.bktUi.panY = cy - wy * nextZ;
        applyCanvasCameraDom(viewport, this.bktUi);
        this.saveCurrentCamera();
      };

      switch (rcUiBtn.dataset.rcUi) {
        case "fab-main":
          if (this.formatMenuOpen) {
            this.formatMenuOpen = false;
            this.refreshTopLeftBarDom();
          }
          if (this.fabOpen && this.fabSubmenu !== "") {
            this.fabSubmenu = "";
          } else {
            this.fabOpen = !this.fabOpen;
            this.fabSubmenu = "";
          }
          this.refreshFabMenuDom();
          return;
        case "fab-sub": {
          if (this.formatMenuOpen) {
            this.formatMenuOpen = false;
            this.refreshTopLeftBarDom();
          }
          const sub = (rcUiBtn.dataset.sub || "") as "" | "add" | "templates" | "panels";
          this.fabOpen = true;
          this.fabSubmenu = sub;
          this.refreshFabMenuDom();
          return;
        }
        case "mode-configure":
        case "toggle-format-menu": {
          if (this.fabOpen) {
            this.fabOpen = false;
            this.fabSubmenu = "";
            this.refreshFabMenuDom();
          }
          this.mobileStageMenuOpen = false;
          if (!isRaceConfigured(this.currentRace) && this.currentRace.raceId && !this.isMobileViewport()) {
            this.promptedTemplateRaceIds.delete(this.currentRace.raceId);
            if (this.activeTab === "format" || this.activeTab === "edit") {
              this.openTemplatesDialog();
              return;
            }
          }
          this.switchWorkspaceTab("edit");
          return;
        }
        case "toggle-mobile-stage-menu": {
          this.mobileStageMenuOpen = !this.mobileStageMenuOpen;
          this.refreshTopLeftBarDom();
          return;
        }
        case "toggle-controls-expand":
          this.bktUi.controlsExpanded = !this.bktUi.controlsExpanded;
          this.refreshBoardControlsDom();
          return;
        case "toggle-tool":
          this.bktUi.tool = this.bktUi.tool === "pan" ? "select" : "pan";
          this.refreshBoardControlsDom();
          return;
        case "toggle-lock":
          this.setCanvasLocked(!this.isCanvasLocked());
          this.refreshBoardControlsDom();
          return;
        case "toggle-pilots-drawer": {
          this.addPanelToCanvas("pilots");
          return;
        }
        case "open-templates":
          this.openTemplatesDialog();
          return;
        case "open-stage-settings": {
          this.fabOpen = false;
          this.fabSubmenu = "";
          this.refreshFabMenuDom();
          const curStg = this.getCurrentViewStage();
          openStageSettingsModal({
            stageIndex: curStg,
            getRace: () => this.currentRace,
            api: this.api,
            onError: (m) => this.reportErr(m),
          });
          return;
        }
        case "open-race-settings":
          this.fabOpen = false;
          this.fabSubmenu = "";
          this.refreshFabMenuDom();
          openRaceSettingsModal({
            getRace: () => this.currentRace,
            getAllTags: () => this.store.allRaceTags,
            api: this.api,
            onError: (m) => this.reportErr(m),
          });
          return;
        case "zoom-in":
          zoomAroundCenter(1.2);
          return;
        case "zoom-out":
          zoomAroundCenter(1 / 1.2);
          return;
        case "fit-view":
          if (this.activeTab === "format") {
            fitCanvasToFormatStages(viewport, this.currentRace, this.bktUi);
          } else if (this.activeTab === "control" || this.activeTab === "review") {
            fitCanvasToControlDashboard(this.el, this.bktUi);
          } else {
            fitCanvasToNodes(this.el, this.bktUi);
          }
          this.saveCurrentCamera();
          return;
        case "stage2-action": {
          this.fabOpen = false;
          this.fabSubmenu = "";
          this.switchWorkspaceTab("format");
          return;
        }
        case "reset-control-panels":
          this.fabOpen = false;
          this.fabSubmenu = "";
          this.resetControlLayoutAndGraph();
          return;
        case "reset-layout": {
          if (this.activeTab === "format") {
            this.resetFormatStageLayout();
          } else if (this.activeTab === "control") {
            this.resetControlLayoutAndGraph();
          } else if (this.activeTab === "review") {
            this.resetReviewLayout();
          } else {
            this.resetEditLayoutAndPanels();
          }
          return;
        }
        case "delete-selected":
          if (this.activeTab === "format") {
            this.deleteSelectedFormatStages();
          } else {
            this.deleteSelectedCanvasRounds();
          }
          return;
      }
    }

    const fmtMenuPickBtn = target.closest<HTMLElement>("[data-fmt-menu-pick]");
    if (fmtMenuPickBtn) {
      this.formatMenuOpen = false;
      this.mobileStageMenuOpen = false;
      if (!isRaceConfigured(this.currentRace) && this.currentRace.raceId) {
        this.promptedTemplateRaceIds.delete(this.currentRace.raceId);
        if (this.activeTab === "format") {
          this.refreshTopLeftBarDom();
          this.openTemplatesDialog();
          return;
        }
      }
      if (this.activeTab !== "format") {
        this.switchWorkspaceTab("format");
      } else {
        this.refreshTopLeftBarDom();
      }
      return;
    }

    const fmtMenuStageBtn = target.closest<HTMLElement>("[data-fmt-menu-stage]");
    if (fmtMenuStageBtn) {
      const nextSt = Number(fmtMenuStageBtn.dataset.fmtMenuStage) || 1;
      this.formatMenuOpen = false;
      this.mobileStageMenuOpen = false;
      if (this.activeTab !== "edit") {
        this.bracketStage = nextSt;
        this.switchWorkspaceTab("edit");
      } else if (this.getCurrentViewStage() !== nextSt) {
        this.switchBracketStage(nextSt);
      } else {
        this.refreshTopLeftBarDom();
      }
      return;
    }

    const announceSpeakBtn = target.closest<HTMLButtonElement>("[data-announce-speak]");
    if (announceSpeakBtn && !announceSpeakBtn.disabled) {
      const phrase = announceSpeakBtn.dataset.announceSpeak?.trim() ?? "";
      if (phrase) {
        this.announcer?.speakImmediate(phrase);
      }
      return;
    }

    const lapCalloutsBtn = target.closest<HTMLButtonElement>("[data-toggle-race-lap-callouts]");
    if (lapCalloutsBtn && !lapCalloutsBtn.disabled) {
      const stageFmt = lapCalloutsBtn.dataset.toggleRaceLapCallouts || undefined;
      this.announcer?.toggleLapCalloutsForStage(stageFmt);
      const nextOn = Boolean(this.announcer?.isLapCalloutsActiveForStage(stageFmt));
      showToast(nextOn ? "Lap timing announcements on" : "Lap timing announcements off", "info");
      this.syncLastSig();
      return;
    }

    const sortRowsBtn = target.closest<HTMLButtonElement>("[data-sort-heat-rows]");
    if (sortRowsBtn && !sortRowsBtn.disabled) {
      const heatId = sortRowsBtn.dataset.sortHeatRows ?? "";
      const scope = sortRowsBtn.dataset.sortTableScope === "review" ? "review" : "flightline";
      const targetHeat = this.currentRace.heats.find((h) => h.id === heatId);
      if (targetHeat) {
        const naturalSort = (a: HeatSeat, b: HeatSeat): number => {
          const aRanked = a.position > 0;
          const bRanked = b.position > 0;
          if (aRanked && bRanked && a.position !== b.position) return a.position - b.position;
          if (aRanked !== bRanked) return aRanked ? -1 : 1;
          return a.seatIndex - b.seatIndex;
        };
        this.seatDisplayOrderByScope.set(
          `${scope}:${heatId}`,
          [...targetHeat.seats].sort(naturalSort).map((s) => s.seatIndex)
        );
        this.refreshSinglePanelDom(scope === "review" ? "review_heat" : "heatline");
      }
      return;
    }

    const marshalMenuToggle = target.closest<HTMLButtonElement>("[data-marshal-menu-toggle]");
    if (marshalMenuToggle && !marshalMenuToggle.disabled) {
      const key = marshalMenuToggle.dataset.marshalMenuToggle ?? "";
      this.openMarshalMenuKey = this.openMarshalMenuKey === key ? "" : key;
      this.refreshSinglePanelDom(this.activeTab === "review" ? "review_heat" : "heatline");
      return;
    }

    const lapEditorTrigger = target.closest<HTMLElement>("[data-open-lap-editor]");
    if (lapEditorTrigger && !(lapEditorTrigger instanceof HTMLButtonElement && lapEditorTrigger.disabled)) {
      const heatId = lapEditorTrigger.dataset.heatId ?? "";
      const slot = Number(lapEditorTrigger.dataset.openLapEditor ?? "0");
      if (this.openMarshalMenuKey) {
        this.openMarshalMenuKey = "";
        this.refreshSinglePanelDom(this.activeTab === "review" ? "review_heat" : "heatline");
      }
      if (heatId && slot > 0) {
        openHeatLapEditorModal(
          this.raceWorkspaceStore,
          this.raceScopedApi,
          heatId,
          slot,
          this.currentRace.raceId
        );
      }
      return;
    }

    const sigPilotBtn = target.closest<HTMLButtonElement>("[data-race-sig-pilot]");
    if (sigPilotBtn) {
      const raw = sigPilotBtn.dataset.raceSigPilot ?? "";
      const nextSel: number | null = Number(raw) > 0 ? Number(raw) : null;
      if (nextSel !== null && this.raceSignalsSlot !== nextSel) {
        this.raceSignalsSlot = nextSel;
        this.el.querySelectorAll<HTMLElement>("[data-race-sig-pilot]").forEach((btn) => {
          const active = btn.dataset.raceSigPilot === String(nextSel);
          btn.classList.toggle("is-active", active);
          btn.setAttribute("aria-selected", active ? "true" : "false");
        });
        this.raceSignalsChart?.setPilotSlotOverride(nextSel);
        this.syncLastSig();
      }
      this.scrollTabButtonIntoStrip(sigPilotBtn);
      return;
    }

    const reviewStatusSetBtn = target.closest<HTMLButtonElement>("[data-set-review-status]");
    if (reviewStatusSetBtn && !reviewStatusSetBtn.disabled) {
      const act = reviewStatusSetBtn.dataset.setReviewStatus as "confirm" | "unlock" | undefined;
      const hid = reviewStatusSetBtn.dataset.heatId ?? "";
      this.openMarshalMenuKey = "";
      if (hid) {
        this.reviewSelectedHeatId = hid;
      }
      this.refreshSinglePanelDom("review_list");
      this.refreshSinglePanelDom("review_heat");
      if (hid && (act === "confirm" || act === "unlock")) {
        const curHeat = this.currentRace.heats.find((h) => h.id === hid);
        if (
          curHeat &&
          ((act === "unlock" && curHeat.state === "confirmed") ||
            (act === "confirm" && curHeat.state === "finished"))
        ) {
          void this.api.raceControl(act, hid, this.currentRace.raceId).catch(this.reportErr);
        }
      }
      return;
    }

    const reviewHeatBtn = target.closest<HTMLElement>("[data-review-select-heat]");
    if (reviewHeatBtn) {
      const hid = reviewHeatBtn.dataset.reviewSelectHeat ?? "";
      if (hid && this.reviewSelectedHeatId !== hid) {
        this.reviewSelectedHeatId = hid;
        this.openMarshalMenuKey = "";
      }
      this.refreshSinglePanelDom("review_heat");
      this.refreshSinglePanelDom("review_list");
      return;
    }

    const reviewStepBtn = target.closest<HTMLButtonElement>("[data-review-step-heat]");
    if (reviewStepBtn && !reviewStepBtn.disabled) {
      const delta = Number(reviewStepBtn.dataset.reviewStepHeat) || 0;
      const executed = this.getExecutedHeats(this.currentRace);
      const curHeat = this.resolveReviewHeat(this.currentRace);
      const curIdx = curHeat ? executed.findIndex((h) => h.id === curHeat.id) : -1;
      const nextHeat = executed[curIdx + delta];
      if (nextHeat && nextHeat.id !== this.reviewSelectedHeatId) {
        this.reviewSelectedHeatId = nextHeat.id;
        this.openMarshalMenuKey = "";
        this.refreshSinglePanelDom("review_heat");
        this.refreshSinglePanelDom("review_list");
      }
      return;
    }

    const mobileCtrlNavBtn = target.closest<HTMLButtonElement>("[data-mobile-ctrl-nav]");
    if (mobileCtrlNavBtn && !mobileCtrlNavBtn.disabled) {
      const nextView = mobileCtrlNavBtn.dataset.mobileCtrlNav as
        | "live"
        | "queue"
        | "schedule"
        | "standings"
        | "signals";
      if (!nextView) return;
      this.mobileControlView = nextView;
      if (this.activeTab !== "control") {
        this.switchWorkspaceTab("control");
        requestAnimationFrame(() => {
          const activeBtn = this.el.querySelector<HTMLElement>(
            `[data-mobile-ctrl-nav="${nextView}"]`
          );
          this.scrollTabButtonIntoStrip(activeBtn);
        });
        return;
      }
      const pageEl = this.el.querySelector<HTMLElement>('[data-rc-page="control"]');
      if (pageEl && !(this.signalsDeferredRender && nextView !== "signals")) {
        const prevView = pageEl.dataset.mobileCtrlView ?? "";
        pageEl.dataset.mobileCtrlView = nextView;
        this.el.querySelectorAll<HTMLElement>("[data-mobile-ctrl-nav]").forEach((btn) => {
          const active = btn.dataset.mobileCtrlNav === nextView;
          btn.classList.toggle("is-active", active);
          btn.setAttribute("aria-selected", active ? "true" : "false");
        });
        this.scrollTabButtonIntoStrip(mobileCtrlNavBtn);
        if (nextView === "signals") {
          this.syncRaceSignalsChartDom();
        }
        fitScheduleLineups(this.el);
        scanTableScrollIndicators(this.el);
        if (prevView !== nextView) {
          this.triggerDesktopWorkspaceFade(false);
        }
        this.syncLastSig();
      } else {
        this.lastSig = "";
        this.render();
        this.triggerDesktopWorkspaceFade(false);
      }
      return;
    }

    const tabBtn = target.closest<HTMLElement>("[data-race-tab]");
    if (tabBtn && !(tabBtn instanceof HTMLButtonElement && tabBtn.disabled)) {
      const nextTab = tabBtn.dataset.raceTab as WorkspaceTab;
      this.switchWorkspaceTab(nextTab);
      requestAnimationFrame(() => {
        const activeBtn = this.el.querySelector<HTMLElement>(`[data-race-tab="${nextTab}"]`);
        this.scrollTabButtonIntoStrip(activeBtn);
      });
      return;
    }

    const dirStatusBtn = target.closest<HTMLElement>("[data-race-dir-status]");
    if (dirStatusBtn) {
      const nextSt = (dirStatusBtn.dataset.raceDirStatus || "all") as RaceDirStatusFilter;
      if (this.dirStatusFilter !== nextSt) {
        this.dirStatusFilter = nextSt;
        this.lastSig = "";
        this.render();
      }
      return;
    }

    const tagFilterBtn = target.closest<HTMLElement>("[data-tag-filter]");
    if (tagFilterBtn) {
      const val = tagFilterBtn.dataset.tagFilter ?? "";
      if (val === "__all__") {
        this.selectedFilterTags.clear();
        this.untaggedOnly = false;
      } else if (val === "__reset_all__") {
        this.dirSearchQuery = "";
        this.dirStatusFilter = "all";
        this.selectedFilterTags.clear();
        this.untaggedOnly = false;
      } else if (val === "__untagged__") {
        this.untaggedOnly = !this.untaggedOnly;
        if (this.untaggedOnly) {
          this.selectedFilterTags.clear();
        }
      } else if (val) {
        const key = val.toLowerCase();
        this.untaggedOnly = false;
        if (this.selectedFilterTags.has(key)) {
          this.selectedFilterTags.delete(key);
        } else {
          this.selectedFilterTags.add(key);
        }
      }
      this.lastSig = "";
      this.render();
      return;
    }

    const tplBtn = target.closest<HTMLElement>("[data-apply-template]");
    if (tplBtn) {
      const tpl = tplBtn.dataset.applyTemplate ?? "";
      if (tpl) this.applyTemplateChoice(tpl);
      return;
    }

    const checkInToggleBtn = target.closest<HTMLButtonElement>("[data-pilots-checkin-toggle]");
    if (checkInToggleBtn && !checkInToggleBtn.disabled) {
      const slotIndex = Number(checkInToggleBtn.dataset.pilotsCheckinToggle);
      if (slotIndex > 0) {
        const curPilot = (this.currentRace.roster ?? []).find((p) => p.slotIndex === slotIndex);
        const nextCheckedIn = !(curPilot?.checkedIn ?? false);
        void this.api
          .eventAction({
            action: "update_attendance",
            slotIndex,
            checkedIn: nextCheckedIn,
            attendance: "active",
          })
          .catch(this.reportErr);
      }
      return;
    }

    const attBtn = target.closest<HTMLButtonElement>("[data-att-status]");
    if (attBtn && !attBtn.disabled) {
      const slotIndex = Number(attBtn.dataset.slotIndex);
      const rawStatus = attBtn.dataset.attStatus as PilotAttendance;
      if (slotIndex > 0 && rawStatus) {
        const curPilot = (this.currentRace.roster ?? []).find((p) => p.slotIndex === slotIndex);
        const curNorm =
          curPilot?.attendance === "forfeit" ? "dnc" : curPilot?.attendance || "active";
        const nextAttendance: PilotAttendance =
          rawStatus !== "active" && curPilot?.checkedIn && curNorm === rawStatus
            ? "active"
            : rawStatus;
        void this.api
          .eventAction({
            action: "update_attendance",
            slotIndex,
            checkedIn: true,
            attendance: nextAttendance,
          })
          .catch(this.reportErr);
      }
      return;
    }

    const oqBtn = target.closest<HTMLButtonElement>("[data-oq-act]");
    if (oqBtn && !oqBtn.disabled) {
      const oqAct = oqBtn.dataset.oqAct;
      const stageIndex = Number(oqBtn.dataset.stageIdx) || this.getCurrentViewStage();
      const pilotSlotIndex = Number(oqBtn.dataset.pilotSlot) || 0;
      const heatId = oqBtn.dataset.heatId || undefined;
      if (oqAct === "open_settings") {
        openOpenQualifierSettingsModal({
          stageIndex,
          getRace: () => this.currentRace,
          api: this.api,
          onError: this.reportErr,
        });
      } else if (oqAct === "enqueue_all") {
        void this.api
          .bracketEdit({ action: "open_qual_enqueue_all", stageIndex })
          .catch(this.reportErr);
      } else if (oqAct === "enqueue" && pilotSlotIndex > 0) {
        const forceImmediate = oqBtn.dataset.oqImmediate === "1";
        void this.api
          .bracketEdit({
            action: "open_qual_enqueue",
            stageIndex,
            pilotSlotIndex,
            forceImmediate,
          })
          .catch(this.reportErr);
      } else if (oqAct === "dequeue" && pilotSlotIndex > 0) {
        void this.api
          .bracketEdit({
            action: "open_qual_dequeue",
            stageIndex,
            pilotSlotIndex,
            heatId,
          })
          .catch(this.reportErr);
      } else if (oqAct === "complete_qualifier") {
        this.openCloseStageModal(this.currentRace, stageIndex);
      }
      return;
    }

    const mobileSelectRaceBtn = target.closest<HTMLButtonElement>("[data-mobile-race-select]");
    if (mobileSelectRaceBtn) {
      e.stopPropagation();
      const rid = mobileSelectRaceBtn.dataset.mobileRaceSelect ?? "";
      if (rid) {
        if (this.mobileRaceDrawerCloseTimer !== null) {
          clearTimeout(this.mobileRaceDrawerCloseTimer);
          this.mobileRaceDrawerCloseTimer = null;
        }
        if (this.mobileSelectedRaceId === rid && !this.mobileRaceDrawerClosing) {
          this.dismissMobileRaceDrawer();
        } else {
          this.mobileRaceDrawerClosing = false;
          this.mobileSelectedRaceId = rid;
          this.lastSig = "";
          this.render();
        }
      }
      return;
    }

    if (target.closest("[data-mobile-race-close]")) {
      this.dismissMobileRaceDrawer();
      return;
    }

    const actBtn = target.closest<HTMLElement>("[data-race-act]");
    if (actBtn) {
      if (actBtn instanceof HTMLButtonElement && actBtn.disabled) return;
      const act = actBtn.dataset.raceAct;
      switch (act) {
        case "dismiss-err":
          this.errorMsg = "";
          this.lastSig = "";
          this.render();
          return;
        case "show-directory":
          this.saveCurrentCamera();
          this.setViewingRace("");
          this.showDirectory = true;
          this.fabOpen = false;
          this.fabSubmenu = "";
          this.editingNameForRaceId = "";
          this.editingTagsForRaceId = "";
          this.syncWorkspaceHash();
          this.lastSig = "";
          this.render();
          return;
        case "create-race-inline":
        case "create-race":
          this.fabOpen = false;
          this.createRaceInline();
          return;
        case "import-multigp":
          this.fabOpen = false;
          this.refreshFabMenuDom();
          if (!sharedMultiGPService.isAvailable(this.store)) return;
          openMultiGPImportModal(this.store, this.api, (created) => {
            if (created.raceId) {
              const targetTab: WorkspaceTab = isRaceConfigured(created) ? "control" : "format";
              this.openRaceFromDirectory(created.raceId, targetTab, targetTab === "control");
            }
          });
          return;
        case "mgp-sync":
        case "mgp-upload-heats":
          if (!this.isMultiGPVerified()) return;
          openMultiGPSyncModal(this.store, this.api, this.currentRace, "heats", () => {
            if (!this.disposed) {
              this.refreshSinglePanelDom("review_list");
              this.refreshSinglePanelDom("standings");
            }
          });
          return;
        case "mgp-upload-overall":
          if (!this.isMultiGPVerified()) return;
          openMultiGPSyncModal(this.store, this.api, this.currentRace, "overall", () => {
            if (!this.disposed) {
              this.refreshSinglePanelDom("standings");
              this.refreshSinglePanelDom("review_list");
            }
          });
          return;
        case "mgp-upload-now":
          this.triggerDirectMultiGPUpload();
          return;
        case "mgp-pull-zippyq": {
          const curRace = this.currentRace;
          const link = curRace.mgpLink;
          if (!this.isMultiGPVerified() || !link || !curRace.raceId) return;
          this.zippyPullInFlight = true;
          this.refreshSinglePanelDom("schedule");
          this.refreshSinglePanelDom("flightline");
          void sharedMultiGPService
            .pullZippyQRounds(this.store, this.api, curRace.raceId, link.raceId, 1, 1)
            .then((res) => {
              showToast(
                res.addedHeats > 0
                  ? `Updated ${res.addedHeats} ZippyQ heat${res.addedHeats === 1 ? "" : "s"} from MultiGP`
                  : "ZippyQ schedule is up to date",
                "info"
              );
            })
            .catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              openMultiGPErrorModal({
                title: "MultiGP Pull ZippyQ Failed",
                raceName: link.raceName || curRace.config.eventName || "Race",
                errorMessage: msg,
              });
            })
            .finally(() => {
              this.zippyPullInFlight = false;
              this.refreshSinglePanelDom("schedule");
              this.refreshSinglePanelDom("flightline");
            });
          return;
        }
        case "edit-race-name": {
          const rid = actBtn.dataset.raceId ?? "";
          if (!rid) return;
          this.beginRaceNameEdit(rid);
          return;
        }
        case "edit-race-tags": {
          const rid = actBtn.dataset.raceId ?? "";
          if (!rid) return;
          this.beginRaceTagsEdit(rid);
          return;
        }
        case "open-race-format":
        case "open-race-control": {
          const raceId = actBtn.dataset.raceId ?? "";
          this.dirOpenMenuRaceId = "";
          this.mobileSelectedRaceId = "";
          this.lastOpenedMobileRaceId = "";
          const nextTab: WorkspaceTab = act === "open-race-format" ? "format" : "control";
          this.openRaceFromDirectory(raceId, nextTab, nextTab === "control");
          return;
        }
        case "toggle-dir-race-menu": {
          const raceId = actBtn.dataset.raceId ?? "";
          if (!raceId) return;
          this.dirOpenMenuRaceId = this.dirOpenMenuRaceId === raceId ? "" : raceId;
          this.refreshDirectoryResultsDom();
          return;
        }
        case "dir-open-race-settings": {
          const raceId = actBtn.dataset.raceId ?? "";
          if (!raceId) return;
          this.dirOpenMenuRaceId = "";
          this.refreshDirectoryResultsDom();
          const openModal = (): void => {
            openRaceSettingsModal({
              getRace: () =>
                this.getEffectiveRaces().find((r) => r.raceId === raceId) ?? this.currentRace,
              getAllTags: () => this.store.allRaceTags,
              api: this.api,
              onError: (m) => this.reportErr(m),
            });
          };
          if (this.currentRace.raceId !== raceId) {
            this.setViewingRace(raceId);
            void this.api
              .eventAction({ action: "select_race", raceId })
              .then(() => openModal())
              .catch(this.reportErr);
          } else {
            openModal();
          }
          return;
        }
        case "dir-toggle-race": {
          const raceId = actBtn.dataset.raceId ?? "";
          if (!raceId) return;
          const found = this.getEffectiveRaces().find((r) => r.raceId === raceId);
          if (!found || !isRaceConfigured(found)) return;
          const ongoing = isRaceOngoing(found);
          const lifecycleAction = ongoing
            ? "pause_race"
            : found.lifecycle === "paused"
              ? "resume_race"
              : "start_race";
          if (lifecycleAction === "start_race" || lifecycleAction === "resume_race") {
            const verb = lifecycleAction === "resume_race" ? "Resuming race" : "Starting race";
            const okLabel = lifecycleAction === "resume_race" ? "OK" : "OK";
            this.runWithPreemptCheck(found, verb, okLabel, (preemptOngoing) =>
              this.api.eventAction({
                action: "race_lifecycle",
                raceId,
                lifecycleAction,
                preemptOngoing,
              })
            );
          } else {
            void this.api
              .eventAction({ action: "race_lifecycle", raceId, lifecycleAction })
              .catch(this.reportErr);
          }
          return;
        }
        case "delete-race": {
          const raceId = actBtn.dataset.raceId ?? this.currentRace.raceId ?? "";
          if (this.dirOpenMenuRaceId) {
            this.dirOpenMenuRaceId = "";
            this.refreshDirectoryResultsDom();
          }
          const found = this.getEffectiveRaces().find((r) => r.raceId === raceId);
          if (found) this.confirmDeleteRace(found);
          return;
        }
        case "toggle-attendance":
          this.attendanceExpanded = !this.attendanceExpanded;
          this.refreshSinglePanelDom("pilots");
          return;
        case "check-in-all":
          void this.api.eventAction({ action: "check_in_all" }).catch(this.reportErr);
          return;
        case "auto-seat-all-unassigned": {
          const race = this.currentRace;
          const viewStage = this.getCurrentViewStage(race);
          const seatedSlots = new Set<number>();
          for (const h of race.heats) {
            if (h.stageIndex === viewStage) {
              for (const s of h.seats) {
                if (s.pilotSlotIndex > 0 && s.status !== "dns") {
                  seatedSlots.add(s.pilotSlotIndex);
                }
              }
            }
          }
          const unseated = (race.roster ?? []).filter(
            (p) => p.checkedIn && p.attendance === "active" && !seatedSlots.has(p.slotIndex)
          );
          void (async () => {
            for (const pilot of unseated) {
              await this.api.bracketEdit({
                action: "auto_seat_pilot",
                pilotSlotIndex: pilot.slotIndex,
              });
            }
          })().catch(this.reportErr);
          return;
        }
        case "toggle-walkup":
          this.showWalkUpForm = !this.showWalkUpForm;
          this.refreshSinglePanelDom("pilots");
          if (this.showWalkUpForm) {
            requestAnimationFrame(() => {
              this.el
                .querySelector<HTMLInputElement>('input[data-race-field="walkup-callsign"]')
                ?.focus();
            });
          }
          return;
        case "submit-walkup":
          this.submitWalkUpPilot();
          return;
        case "submit-panel-walkup":
          this.submitPanelWalkUpPilot();
          return;
        case "start-custom-seeded":
          void this.api
            .bracketEdit({
              action: "start_custom",
              linkMode: "all_active_pilots",
              pilotsPerHeat: this.draftPilotsPerHeat,
              targetLaps: this.draftTargetLaps,
              timeLimitSec: this.draftTimeLimitSec,
            })
            .catch(this.reportErr);
          return;
        case "regenerate-upcoming":
          void this.api.bracketEdit({ action: "regenerate_upcoming" }).catch(this.reportErr);
          return;
        case "open-lifecycle-prompt":
          this.lifecyclePrompt = actBtn.dataset.promptKind as "pause_race" | "scrap_race";
          this.lifecycleReason =
            this.lifecyclePrompt === "pause_race" ? "Rain / schedule pause" : "";
          this.refreshSinglePanelDom("cockpit");
          return;
        case "cancel-lifecycle-prompt":
          this.lifecyclePrompt = "";
          this.lifecycleReason = "";
          this.refreshSinglePanelDom("cockpit");
          return;
        case "confirm-lifecycle-prompt": {
          const lifecycleAction = this.lifecyclePrompt;
          if (!lifecycleAction) return;
          const reason = this.lifecycleReason.trim();
          this.lifecyclePrompt = "";
          this.lifecycleReason = "";
          void this.api
            .eventAction({ action: "race_lifecycle", lifecycleAction, reason })
            .catch(this.reportErr);
          return;
        }
        case "lifecycle-direct": {
          const lifecycleAction = actBtn.dataset.lifecycleAct as
            | "start_race"
            | "pause_race"
            | "resume_race"
            | "emergency_stop"
            | "reopen_race"
            | "complete_race";
          const curRace = this.currentRace;
          const curLifecycle: RaceLifecycle =
            curRace.lifecycle ?? (curRace.isComplete ? "completed" : "draft");
          const isEmerg = Boolean(curRace.emergencyStopped);
          if (
            (lifecycleAction === "emergency_stop" && isEmerg) ||
            (lifecycleAction === "pause_race" && curLifecycle === "paused" && !isEmerg) ||
            ((lifecycleAction === "start_race" || lifecycleAction === "resume_race") &&
              curLifecycle === "active" &&
              !isEmerg)
          ) {
            return;
          }
          this.lifecyclePrompt = "";
          this.confirmReset = false;
          if (
            lifecycleAction === "start_race" ||
            lifecycleAction === "resume_race" ||
            lifecycleAction === "reopen_race"
          ) {
            const verb =
              lifecycleAction === "resume_race"
                ? "Resuming"
                : lifecycleAction === "reopen_race"
                  ? "Reopening"
                  : "Starting";
            this.runWithPreemptCheck(curRace, verb, "OK", (preemptOngoing) =>
              this.api
                .eventAction({
                  action: "race_lifecycle",
                  raceId: curRace.raceId,
                  lifecycleAction,
                  preemptOngoing,
                })
                .then(() => {
                  if (!this.disposed && lifecycleAction === "reopen_race") {
                    const updated = this.currentRace;
                    if (updated.activeStageIndex && updated.activeStageIndex >= 1) {
                      this.bracketStage = updated.activeStageIndex;
                    }
                    this.lastSig = "";
                    this.render();
                  }
                })
            );
          } else {
            void this.api
              .eventAction({
                action: "race_lifecycle",
                raceId: curRace.raceId,
                lifecycleAction,
              })
              .catch(this.reportErr);
          }
          return;
        }
        case "focus-heat-graph": {
          const heatId = actBtn.dataset.heatId ?? "";
          if (heatId) {
            this.jumpToHeatInStageGraph(heatId);
          }
          return;
        }
        case "focus-standings-panel":
          this.controlPanels.standings.visible = true;
          this.controlPanels.standings.collapsed = false;
          this.controlPanels.standings.zIndex = ++this.panelZCounter;
          this.persistControlLayout();
          this.refreshSinglePanelDom("standings");
          return;
        case "export-csv": {
          const curRace = this.currentRace;
          const raceId = actBtn.dataset.raceId ?? curRace.raceId ?? "";
          const rawStg = Number(actBtn.dataset.stageIdx);
          const stageIndex = rawStg > 0 ? rawStg : undefined;
          void this.api
            .downloadRaceResultsCsv(raceId, stageIndex, curRace.config.eventName || "slaprf-results")
            .then(() => showToast("Results CSV downloaded.", "info"))
            .catch(this.reportErr);
          return;
        }
        case "close-stage-modal": {
          const stageIdx = Number(actBtn.dataset.stageIdx) || this.getCurrentViewStage();
          this.openCloseStageModal(this.currentRace, stageIdx);
          return;
        }
      }
    }

    const schedBtn = target.closest<HTMLElement>("[data-sched-filter]");
    if (schedBtn) {
      this.scheduleFilter = schedBtn.dataset.schedFilter as "all" | "upcoming" | "done";
      this.refreshSinglePanelDom("schedule");
      return;
    }

    const oqQueueFilterBtn = target.closest<HTMLElement>("[data-oq-queue-filter]");
    if (oqQueueFilterBtn) {
      const nextF = (oqQueueFilterBtn.dataset.oqQueueFilter || "all") as FlightQueueFilter;
      if (this.flightQueueFilter !== nextF) {
        this.flightQueueFilter = nextF;
        this.refreshSinglePanelDom("flightline");
      }
      return;
    }

    const stdBtn = target.closest<HTMLElement>("[data-std-stage]");
    if (stdBtn) {
      this.standingsStage = stdBtn.dataset.stdStage as "main" | "qualifying";
      this.refreshSinglePanelDom("standings");
      return;
    }

    const bktStageBtn = target.closest<HTMLButtonElement>("[data-bkt-stage]");
    if (bktStageBtn && !bktStageBtn.disabled) {
      const nextSt = Number(bktStageBtn.dataset.bktStage) || 1;
      this.switchBracketStage(nextSt);
      return;
    }

    const stageCtrlBtn = target.closest<HTMLButtonElement>("[data-stage-ctrl]");
    if (stageCtrlBtn && !stageCtrlBtn.disabled) {
      const stageAct = stageCtrlBtn.dataset.stageCtrl as
        | "activate_stage"
        | "pause_stage"
        | "resume_stage"
        | "complete_stage_early"
        | "reopen_stage_early";
      const stageIdx = Number(stageCtrlBtn.dataset.stageIdx) || this.getCurrentViewStage();
      const stageId = stageCtrlBtn.dataset.stageId;
      if (stageAct && stageIdx >= 1) {
        void this.api.stageControl(stageAct, stageIdx, stageId).catch(this.reportErr);
      }
      return;
    }

    const selectHeatEl = target.closest<HTMLElement>("[data-select-heat]");
    if (
      selectHeatEl &&
      !target.closest(
        "[data-bkt-stop-select], select, input, button[data-bkt-action], button[data-bkt-ui]"
      )
    ) {
      const heatId = selectHeatEl.dataset.selectHeat ?? "";
      if (heatId) {
        this.confirmReset = false;
        const race = this.currentRace;
        const targetHeat = race.heats.find((h) => h.id === heatId);
        if (this.activeTab === "control") {
          if (
            !selectHeatEl.hasAttribute("data-load-next-ready") &&
            targetHeat &&
            (targetHeat.state === "confirmed" ||
              targetHeat.state === "finished" ||
              targetHeat.state === "aborted")
          ) {
            this.reviewSelectedHeatId = heatId;
            this.switchWorkspaceTab("review");
            return;
          }
          if (!targetHeat || targetHeat.state === "waiting") {
            return;
          }
          if (targetHeat.stageIndex >= 1) {
            this.bracketStage = targetHeat.stageIndex;
          }
          this.mobileControlView = "live";
          const pageEl = this.el.querySelector<HTMLElement>('[data-rc-page="control"]');
          if (pageEl) {
            const prevView = pageEl.dataset.mobileCtrlView ?? "";
            pageEl.dataset.mobileCtrlView = "live";
            this.el.querySelectorAll<HTMLElement>("[data-mobile-ctrl-nav]").forEach((btn) => {
              const active = btn.dataset.mobileCtrlNav === "live";
              btn.classList.toggle("is-active", active);
              btn.setAttribute("aria-selected", active ? "true" : "false");
            });
            if (prevView !== "live") {
              this.triggerDesktopWorkspaceFade(false);
            }
          }
          void this.api.raceControl("select", heatId, race.raceId).catch(this.reportErr);
          return;
        }
        if (targetHeat && targetHeat.stageIndex >= 1) {
          this.bracketStage = targetHeat.stageIndex;
        }
        void this.api.raceControl("select", heatId, race.raceId).catch(this.reportErr);
      }
      return;
    }

    const lapChip = target.closest<HTMLButtonElement>("[data-toggle-lap]");
    if (lapChip && !lapChip.disabled) {
      if (window.matchMedia?.("(max-width: 640px)").matches) {
        return;
      }
      const heatId = lapChip.dataset.heatId ?? "";
      const slot = Number(lapChip.dataset.slotIndex);
      const crossingId = Number(lapChip.dataset.toggleLap);
      if (heatId && slot > 0 && crossingId > 0) {
        void this.api
          .raceMarshal({
            raceId: this.currentRace.raceId,
            heatId,
            pilotSlotIndex: slot,
            action: "toggle_lap",
            crossingId,
          })
          .catch(this.reportErr);
      }
      return;
    }

    const marshalBtn = target.closest<HTMLButtonElement>("[data-marshal]");
    if (marshalBtn && !marshalBtn.disabled) {
      const action = marshalBtn.dataset.marshal ?? "";
      const heatId = marshalBtn.dataset.heatId ?? "";
      const slot = Number(marshalBtn.dataset.slotIndex);
      if (!heatId || slot <= 0) return;
      if (!marshalBtn.hasAttribute("data-keep-menu") && this.openMarshalMenuKey) {
        this.openMarshalMenuKey = "";
        this.refreshSinglePanelDom(this.activeTab === "review" ? "review_heat" : "heatline");
      }
      if (action === "toggle_penalty") {
        const cur = Number(marshalBtn.dataset.curPenalty ?? 0);
        const targetPen = Number(marshalBtn.dataset.penSec ?? 5);
        const nextPen = cur === targetPen ? 0 : targetPen;
        void this.api
          .raceMarshal({
            raceId: this.currentRace.raceId,
            heatId,
            pilotSlotIndex: slot,
            action: "set_penalty",
            penaltySec: nextPen,
          })
          .catch(this.reportErr);
        return;
      }
      if (action === "cycle_penalty") {
        const cur = Number(marshalBtn.dataset.curPenalty ?? 0);
        const nextPen = cur === 0 ? 5 : cur === 5 ? 10 : 0;
        void this.api
          .raceMarshal({
            raceId: this.currentRace.raceId,
            heatId,
            pilotSlotIndex: slot,
            action: "set_penalty",
            penaltySec: nextPen,
          })
          .catch(this.reportErr);
        return;
      }
      void this.api
        .raceMarshal({
          raceId: this.currentRace.raceId,
          heatId,
          pilotSlotIndex: slot,
          action: action as
            | "toggle_dnf"
            | "toggle_dq"
            | "toggle_dns"
            | "set_dns"
            | "set_dnf"
            | "set_dq"
            | "set_finished"
            | "set_racing"
            | "add_lap"
            | "move_up"
            | "move_down"
            | "clear_override",
        })
        .catch(this.reportErr);
      return;
    }

    const ctrlBtn = target.closest<HTMLButtonElement>("[data-ctrl]");
    if (ctrlBtn && !ctrlBtn.disabled) {
      const action = ctrlBtn.dataset.ctrl ?? "";
      const heatId = ctrlBtn.dataset.heatId ?? "";
      if (action === "advance-stage-2") {
        void this.api.advanceRaceStage2().catch(this.reportErr);
        return;
      }
      if (action === "reset") {
        this.confirmReset = false;
        this.openRerunHeatModal(heatId);
        return;
      }
      if (action === "cancel-reset") {
        this.confirmReset = false;
        this.lastSig = "";
        this.render();
        return;
      }
      const race = this.currentRace;
      const targetHeat = heatId ? race.heats.find((h) => h.id === heatId) : undefined;
      if (action === "start" || action === "resume") {
        const verb = action === "resume" ? `Resuming ${targetHeat?.shortLabel || "heat"}` : `Starting ${targetHeat?.shortLabel || "heat"}`;
        this.runWithPreemptCheck(race, verb, "OK", async (preemptOngoing) => {
          if (
            action === "start" &&
            targetHeat &&
            (race.stages?.length ?? 0) > 1 &&
            targetHeat.stageIndex !== race.activeStageIndex
          ) {
            await this.api.stageControl("activate_stage", targetHeat.stageIndex);
          }
          await this.api.raceControl(action, heatId, race.raceId, preemptOngoing);
        });
        return;
      }
      if (action === "select") {
        this.mobileControlView = "live";
      }
      if (
        action === "select" &&
        targetHeat &&
        (race.stages?.length ?? 0) > 1 &&
        targetHeat.stageIndex !== race.activeStageIndex
      ) {
        void this.api
          .stageControl("activate_stage", targetHeat.stageIndex)
          .then(() => this.api.raceControl(action, heatId, race.raceId))
          .catch(this.reportErr);
        return;
      }
      void this.api
        .raceControl(action, heatId, race.raceId)
        .then(() => {
          if (action !== "confirm") return;
          const cur = this.currentRace;
          if (!cur.mgpLink || !cur.raceId || !sharedMultiGPService.isAvailable(this.store)) return;
          const prefs = sharedMultiGPService.prefsFor(this.store.simulatorRunning, this.store);
          if (!prefs.autoPushOnConfirm) return;
          void this.api
            .multiGPBuildSyncPlan(cur.raceId, false)
            .then(async (plan) => {
              if ((plan.operations?.length ?? 0) === 0 && (plan.overallResults?.length ?? 0) === 0) {
                return;
              }
              await sharedMultiGPService.pushSyncPlan(this.store, this.api, plan);
              showToast(`Auto-synced results to MultiGP #${cur.mgpLink?.raceId}`, "info");
            })
            .catch((err) => {
              showToast(
                `MultiGP auto-sync failed: ${err instanceof Error ? err.message : String(err)}`,
                "warn"
              );
            });
        })
        .catch(this.reportErr);
      return;
    }

    const raceRow = target.closest<HTMLElement>("tr[data-race-row]");
    if (raceRow) {
      const raceId = raceRow.dataset.raceRow ?? "";
      if (raceId && target.closest("td.races-table-name-cell") && !target.closest("input")) {
        this.beginRaceNameEdit(raceId);
        return;
      }
      if (
        raceId &&
        target.closest("td.races-table-tags-cell") &&
        !target.closest(".slaprf-tag-box, .race-tag-comma-wrap, input, button")
      ) {
        this.beginRaceTagsEdit(raceId);
      }
      return;
    }
  };

  private openRaceFromDirectory(
    raceId: string,
    nextTab: WorkspaceTab,
    focusActiveStage = false
  ): void {
    const switchingRace = !!raceId && (raceId !== this.currentRace.raceId || raceId !== this.viewingRaceId);
    const finish = () => {
      if (raceId) {
        this.setViewingRace(raceId);
      }
      this.syncDraftDefaultsFromRace();
      const curRace = this.currentRace;
      if (focusActiveStage || switchingRace) {
        this.bracketStage = Math.max(1, curRace.activeStageIndex || 1);
      }
      this.pendingRouteTarget = null;
      this.showDirectory = false;
      if (switchingRace && nextTab === "control") {
        this.mobileControlView = "live";
      }
      this.activeTab = nextTab;
      this.fabOpen = false;
      this.fabSubmenu = "";
      this.formatMenuOpen = false;
      this.mobileStageMenuOpen = false;
      this.openMarshalMenuKey = "";
      this.editingNameForRaceId = "";
      this.editingTagsForRaceId = "";
      if ((nextTab === "format" || nextTab === "edit") && !isRaceConfigured(curRace)) {
        if (curRace.raceId) {
          this.promptedTemplateRaceIds.delete(curRace.raceId);
        }
      }
      const viewStg = this.getCurrentViewStage(curRace);
      this.syncCanvasLockToUi(nextTab, viewStg);
      const savedCam = this.bktUi.stageCameras[this.cameraSlotKey(nextTab, viewStg)];
      if (savedCam?.initialized) {
        this.bktUi.panX = savedCam.panX;
        this.bktUi.panY = savedCam.panY;
        this.bktUi.zoom = savedCam.zoom;
      }
      this.syncWorkspaceHash(true);
      this.lastSig = "";
      this.render();
    };
    if (switchingRace) {
      void this.api
        .eventAction({ action: "select_race", raceId })
        .then(finish)
        .catch(this.reportErr);
    } else {
      finish();
    }
  }

  private renderSmartNameCell(
    raceId: string,
    displayName: string
  ): string {
    if (this.editingNameForRaceId === raceId) {
      return `
        <div class="race-name-edit-wrap">
          <input
            type="text"
            class="input input-sm races-inline-name"
            data-race-name-input="${esc(raceId)}"
            value="${esc(displayName)}"
            placeholder="Race name"
            maxlength="64"
            autocomplete="off"
            aria-label="Edit race name"
          />
        </div>`;
    }
    return `
      <div class="race-name-smart-row">
        <div class="race-name-title-group">
          <button
            type="button"
            class="races-row-title-btn"
            data-race-act="edit-race-name"
            data-race-id="${esc(raceId)}"
            title="Click to rename race"
          >${esc(displayName)}</button>
        </div>
      </div>`;
  }

  private renderSmartTagsCell(raceId: string, tags: string[]): string {
    if (this.editingTagsForRaceId === raceId) {
      return `
        <div class="race-tag-comma-wrap">
          ${renderTagPillBoxHtml({
            boxId: `race-row-${raceId}`,
            tags,
            placeholder: "Add tags (comma or Enter)…",
            compact: true,
            ariaLabel: "Edit race tags",
          })}
        </div>`;
    }

    const visibleTags = tags.slice(0, 3);
    const hiddenTags = tags.slice(3);
    const pillsMarkup =
      visibleTags.length > 0
        ? visibleTags
            .map((t) => {
              const isFiltered = this.selectedFilterTags.has(t.toLowerCase());
              return `<span class="race-tag-pill ${isFiltered ? "is-active" : ""}">#${esc(t)}</span>`;
            })
            .join("")
        : `<span class="note races-no-tags-note">Add tags…</span>`;

    const overflowMarkup =
      hiddenTags.length > 0
        ? `<span class="race-tag-overflow" title="${esc(hiddenTags.map((x) => `#${x}`).join(", "))}">+${hiddenTags.length}</span>`
        : "";

    return `
      <button
        type="button"
        class="race-tags-click-target"
        data-race-act="edit-race-tags"
        data-race-id="${esc(raceId)}"
        title="Click to edit tags"
        aria-label="Edit race tags"
      >${pillsMarkup}${overflowMarkup}</button>`;
  }

  private computeRaceDirectoryViewModel(): {
    allRaces: RaceTournamentState[];
    filtered: RaceTournamentState[];
    sortedTags: Array<{ key: string; label: string; count: number }>;
    untaggedCount: number;
    setupCount: number;
    activeCount: number;
    doneCount: number;
    hasAnyFilter: boolean;
    isTagAllSelected: boolean;
    tableOrEmptyMarkup: string;
    footNote: string;
  } {
    const allRaces = this.getEffectiveRaces();

    const tagDisplayByKey = new Map<string, string>();
    const tagCounts = new Map<string, number>();
    let untaggedCount = 0;
    let setupCount = 0;
    let activeCount = 0;
    let doneCount = 0;

    for (const r of allRaces) {
      const rTags = r.tags ?? [];
      if (rTags.length === 0) {
        untaggedCount++;
      } else {
        for (const t of rTags) {
          const key = t.toLowerCase();
          if (!tagDisplayByKey.has(key)) tagDisplayByKey.set(key, t);
          tagCounts.set(key, (tagCounts.get(key) ?? 0) + 1);
        }
      }

      const ongoing = isRaceOngoing(r);
      if (r.lifecycle === "completed" || r.lifecycle === "scrapped") {
        doneCount++;
      } else if (ongoing || r.lifecycle === "paused") {
        activeCount++;
      } else {
        setupCount++;
      }
    }

    for (const selKey of Array.from(this.selectedFilterTags)) {
      if (!tagDisplayByKey.has(selKey)) {
        this.selectedFilterTags.delete(selKey);
      }
    }

    const sortedTags = Array.from(tagDisplayByKey.entries())
      .map(([key, label]) => ({ key, label, count: tagCounts.get(key) ?? 0 }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));

    const isTagAllSelected = this.selectedFilterTags.size === 0 && !this.untaggedOnly;
    const rawQuery = this.dirSearchQuery.trim().toLowerCase();
    const cleanTagQuery = rawQuery.replace(/^#+/, "");
    const hasAnyFilter =
      !isTagAllSelected || this.dirStatusFilter !== "all" || rawQuery.length > 0;

    const filtered = allRaces.filter((r, idx) => {
      const ongoing = isRaceOngoing(r);
      if (this.dirStatusFilter === "setup") {
        if (ongoing || (r.lifecycle && r.lifecycle !== "draft")) return false;
      } else if (this.dirStatusFilter === "active") {
        if (!ongoing && r.lifecycle !== "paused") return false;
      } else if (this.dirStatusFilter === "done") {
        if (r.lifecycle !== "completed" && r.lifecycle !== "scrapped") return false;
      }

      const rTags = r.tags ?? [];
      if (this.untaggedOnly && rTags.length > 0) return false;
      if (this.selectedFilterTags.size > 0) {
        const rKeys = new Set(rTags.map((t) => t.toLowerCase()));
        for (const reqKey of this.selectedFilterTags) {
          if (!rKeys.has(reqKey)) return false;
        }
      }

      if (rawQuery) {
        const dispName = (r.config.eventName || `Race ${idx + 1}`).toLowerCase();
        const sub = formatRaceSubtitle(r).toLowerCase();
        const mgpStr = r.mgpLink ? `mgp multigp #${r.mgpLink.raceId} ${r.mgpLink.raceName.toLowerCase()}` : "";
        const champ = (r.championCallsign ?? "").toLowerCase();
        const lcLabel = raceLifecycleBadge(r.lifecycle).label.toLowerCase();
        const tagMatch =
          cleanTagQuery.length > 0 &&
          rTags.some((t) => t.toLowerCase().includes(cleanTagQuery));
        if (
          !dispName.includes(rawQuery) &&
          !sub.includes(rawQuery) &&
          !mgpStr.includes(rawQuery) &&
          !champ.includes(rawQuery) &&
          !lcLabel.includes(rawQuery) &&
          !tagMatch
        ) {
          return false;
        }
      }
      return true;
    });

    const tableOrEmptyMarkup =
      allRaces.length === 0
        ? `<div class="races-dir-empty">
            <div class="race-empty-icon">${icons.checkered(28)}</div>
            <div class="races-dir-empty-title">No races yet</div>
            <p class="note">Click <strong>+ Race</strong> below to add your first race row inline, then click <strong>Setup</strong> in Actions to build its tournament format.</p>
          </div>`
        : filtered.length === 0
          ? `<div class="races-dir-empty">
              <div class="race-empty-icon">${icons.search(26)}</div>
              <div class="races-dir-empty-title">No races match current filter</div>
              <p class="note">Adjust your search, status filter, or tag selection above to view races.</p>
              <div style="margin-top:8px">
                <button type="button" class="btn btn-ghost btn-sm" data-tag-filter="__reset_all__">Show all (${allRaces.length})</button>
              </div>
            </div>`
          : `<div class="table-scroll">
              <table class="table races-table">
                <thead>
                  <tr>
                    <th class="races-col-name">Race</th>
                    <th class="races-col-type">Format</th>
                    <th class="races-col-tags">Tags</th>
                    <th class="races-col-date">Date</th>
                    <th class="races-col-status">Status</th>
                    <th class="races-col-actions" aria-label="Open"></th>
                  </tr>
                </thead>
                <tbody>
                  ${filtered
                    .map((r, idx) => {
                      const rid = r.raceId ?? "";
                      const isCurrent = rid !== "" && rid === this.store.raceState.raceId;
                      const configured = isRaceConfigured(r);
                      const lc = !configured
                        ? { label: "New", cls: "is-waiting" }
                        : raceLifecycleBadge(r.lifecycle);
                      const ongoing = configured && isRaceOngoing(r);
                      const confirmed = r.heats.filter((h) => h.state === "confirmed").length;
                      const activePilots = (r.roster ?? []).filter(
                        (p) => p.checkedIn && p.attendance === "active"
                      ).length;
                      const subtitle = formatRaceSubtitle(r);
                      const trackInfo = this.store.raceNodes(r);
                      const gateBit = `${trackInfo.nodes.length} gate${trackInfo.nodes.length === 1 ? "" : "s"}${trackInfo.historical ? " (snapshot)" : ""}`;
                      const createdText = r.createdAt ? formatShortRaceDate(r.createdAt) : "—";
                      const progressNote =
                        !configured || r.heats.length === 0
                          ? `0 heats · ${activePilots} pilots`
                          : `${confirmed}/${r.heats.length} heats · ${activePilots} pilots`;
                      const typeTip = `${subtitle} · ${gateBit} · ${progressNote}`;
                      const statusTipParts = [lc.label, progressNote];
                      if (r.championCallsign) statusTipParts.push(`Champion: ${r.championCallsign}`);
                      if (r.statusReason) statusTipParts.push(r.statusReason);
                      const dispName = r.config.eventName || `Race ${idx + 1}`;

                      return `
                        <tr class="${isCurrent && ongoing ? "is-current-race" : ""}" data-race-row="${esc(rid)}">
                          <td class="races-col-name races-table-name-cell">
                            <div class="races-cell-box is-single">
                              ${this.renderSmartNameCell(rid, dispName)}
                            </div>
                          </td>
                          <td class="races-col-type">
                            <div class="races-cell-box is-single">
                              <span class="races-table-type-text" title="${esc(typeTip)}">${esc(subtitle)}</span>${
                                r.mgpLink
                                  ? `<span class="badge mono" style="margin-left:6px" title="Linked to MultiGP #${r.mgpLink.raceId} (${esc(r.mgpLink.raceName)})">MGP #${r.mgpLink.raceId}</span>`
                                  : ""
                              }
                            </div>
                          </td>
                          <td class="races-col-tags races-table-tags-cell">
                            <div class="races-cell-box is-single">
                              ${this.renderSmartTagsCell(rid, r.tags ?? [])}
                            </div>
                          </td>
                          <td class="races-col-date">
                            <div class="races-cell-box is-single">
                              <span class="races-table-date" title="${esc(r.createdAt ?? "")}">${esc(createdText)}</span>
                            </div>
                          </td>
                          <td class="races-col-status races-table-status-col">
                            <div class="races-cell-box is-single">
                              <div class="races-table-status-cell">
                                <span class="race-state-pill ${lc.cls}" title="${esc(statusTipParts.join(" · "))}">${esc(lc.label)}</span>
                              </div>
                            </div>
                          </td>
                          <td class="races-col-actions">
                            <div class="races-cell-box is-single">
                              <div class="races-row-actions">
                                <button
                                  type="button"
                                  class="btn btn-ghost btn-xs dir-open-btn"
                                  data-race-act="${configured ? "open-race-control" : "open-race-format"}"
                                  data-race-id="${esc(rid)}"
                                  title="${configured ? "Open race workspace" : "Set up tournament format"}"
                                  aria-label="${configured ? "Open race workspace" : "Set up tournament format"}"
                                >${configured ? "Open" : "Setup"}</button>
                                <div class="dir-row-more-wrap">
                                  <button
                                    type="button"
                                    class="btn btn-ghost btn-xs dir-row-more-btn ${this.dirOpenMenuRaceId === rid ? "is-open" : ""}"
                                    data-race-act="toggle-dir-race-menu"
                                    data-race-id="${esc(rid)}"
                                    title="Race options"
                                    aria-label="Options for ${esc(dispName)}"
                                    aria-haspopup="menu"
                                    aria-expanded="${this.dirOpenMenuRaceId === rid ? "true" : "false"}"
                                  >${icons.moreHorizontal(15)}</button>
                                  ${
                                    this.dirOpenMenuRaceId === rid
                                      ? `<div class="dir-row-more-menu" role="menu" aria-label="Options for ${esc(dispName)}">
                                           <button
                                             type="button"
                                             class="dir-row-more-item"
                                             role="menuitem"
                                             data-race-act="dir-open-race-settings"
                                             data-race-id="${esc(rid)}"
                                           ><span>Settings</span></button>
                                           <button
                                             type="button"
                                             class="dir-row-more-item"
                                             role="menuitem"
                                             data-race-act="delete-race"
                                             data-race-id="${esc(rid)}"
                                             ${ongoing ? "disabled" : ""}
                                             title="${ongoing ? "Pause or complete this race before deleting" : "Delete race"}"
                                           ><span>Delete</span></button>
                                         </div>`
                                      : ""
                                  }
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>`;
                    })
                    .join("")}
                </tbody>
              </table>
            </div>
            <div class="dir-mobile-mosaic" role="listbox" aria-label="Races">
              ${filtered
                .map((r, idx) => {
                  const rid = r.raceId ?? "";
                  const configured = isRaceConfigured(r);
                  const lc = !configured
                    ? { label: "New", cls: "is-waiting" }
                    : raceLifecycleBadge(r.lifecycle);
                  const ongoing = configured && isRaceOngoing(r);
                  const dispName = r.config.eventName || `Race ${idx + 1}`;
                  const subtitle = formatRaceSubtitle(r);
                  const isSelected = this.mobileSelectedRaceId === rid;
                  return `
                    <div
                      role="option"
                      tabindex="0"
                      aria-selected="${isSelected ? "true" : "false"}"
                      class="dir-mobile-chip ${isSelected ? "is-selected" : ""} ${ongoing ? "is-live" : ""}"
                      data-race-act="${configured ? "open-race-control" : "open-race-format"}"
                      data-race-id="${esc(rid)}"
                    >
                      <div class="dir-mobile-chip-top">
                        <div class="dir-mobile-chip-badges">
                          <span class="race-state-pill ${lc.cls}">${esc(lc.label)}</span>
                          ${r.mgpLink ? `<span class="badge mono dir-mobile-chip-mgp">MGP</span>` : ""}
                        </div>
                        <button
                          type="button"
                          class="dir-mobile-chip-more-btn"
                          data-mobile-race-select="${esc(rid)}"
                          title="Race options"
                          aria-label="Options for ${esc(dispName)}"
                        >${icons.moreHorizontal(16)}</button>
                      </div>
                      <strong class="dir-mobile-chip-title">${esc(dispName)}</strong>
                      <span class="dir-mobile-chip-sub">${esc(subtitle)}</span>
                    </div>`;
                })
                .join("")}
            </div>
            ${this.renderMobileRaceDrawer(allRaces)}`;

    const footNote =
      allRaces.length === 0
        ? "No races created yet · Click + Race to add one inline."
        : hasAnyFilter
          ? `Showing ${filtered.length} of ${allRaces.length} race${allRaces.length === 1 ? "" : "s"}`
          : `${allRaces.length} race${allRaces.length === 1 ? "" : "s"} · Click a name or tag cell to edit inline, or click Open to configure or control.`;

    return {
      allRaces,
      filtered,
      sortedTags,
      untaggedCount,
      setupCount,
      activeCount,
      doneCount,
      hasAnyFilter,
      isTagAllSelected,
      tableOrEmptyMarkup,
      footNote,
    };
  }

  private renderMobileRaceDrawer(allRaces: RaceTournamentState[]): string {
    if (!this.mobileSelectedRaceId) {
      this.lastOpenedMobileRaceId = "";
      return "";
    }
    const idx = allRaces.findIndex((r) => r.raceId === this.mobileSelectedRaceId);
    const r = idx >= 0 ? allRaces[idx] : undefined;
    if (!r || !r.raceId) {
      this.lastOpenedMobileRaceId = "";
      return "";
    }
    const rid = r.raceId;
    const shouldAnimateEntry = this.lastOpenedMobileRaceId !== rid;
    this.lastOpenedMobileRaceId = rid;

    const configured = isRaceConfigured(r);
    const lc = !configured
      ? { label: "New", cls: "is-waiting" }
      : raceLifecycleBadge(r.lifecycle);
    const ongoing = configured && isRaceOngoing(r);
    const confirmed = r.heats.filter((h) => h.state === "confirmed").length;
    const activePilots = (r.roster ?? []).filter(
      (p) => p.checkedIn && p.attendance === "active"
    ).length;
    const subtitle = formatRaceSubtitle(r);
    const trackInfo = this.store.raceNodes(r);
    const gateBit = `${trackInfo.nodes.length} gate${trackInfo.nodes.length === 1 ? "" : "s"}`;
    const createdText = r.createdAt ? formatShortRaceDate(r.createdAt) : "—";
    const progressNote =
      !configured || r.heats.length === 0
        ? `0 heats · ${activePilots} pilots`
        : `${confirmed}/${r.heats.length} heats · ${activePilots} pilots`;
    const dispName = r.config.eventName || `Race ${idx + 1}`;

    return `
      <div class="pilot-dir-mobile-drawer-overlay" role="dialog" aria-modal="true" aria-label="Edit ${esc(dispName)}">
        <div class="pilot-dir-mobile-drawer-backdrop" data-mobile-race-close></div>
        <div class="pilot-dir-mobile-editor ${shouldAnimateEntry ? "is-entering" : ""}" data-mobile-race-drawer>
          <div class="dir-mobile-drawer-top-bar" data-mobile-race-handle>
            <button
              type="button"
              class="pilot-dir-mobile-drawer-handle"
              data-mobile-race-handle
              data-mobile-race-close
              aria-label="Dismiss race editor"
              title="Pull down or tap to dismiss"
            >
              <span class="pilot-dir-mobile-drawer-grip" aria-hidden="true"></span>
            </button>
            <div class="dir-mobile-drawer-top-status">
              ${r.mgpLink ? `<span class="badge mono">MGP #${r.mgpLink.raceId}</span>` : ""}
              <span class="race-state-pill ${lc.cls}">${esc(lc.label)}</span>
            </div>
          </div>
          <div class="pilot-dir-mobile-grid">
            <label class="field">
              <span>Race name</span>
              <input
                type="text"
                class="input"
                data-race-name-input="${esc(rid)}"
                value="${esc(dispName)}"
                placeholder="Race name"
                maxlength="64"
                autocomplete="off"
              />
            </label>
            <div class="field">
              <span>Tags</span>
              ${renderTagPillBoxHtml({
                boxId: `race-drawer-${rid}`,
                tags: r.tags ?? [],
                placeholder: "Add tags (comma or Enter)…",
                compact: false,
                ariaLabel: "Edit race tags",
              })}
            </div>
            <div class="dir-mobile-drawer-meta-grid">
              <div class="dir-mobile-drawer-meta-item">
                <span class="note">Format</span>
                <strong>${esc(subtitle)}</strong>
              </div>
              <div class="dir-mobile-drawer-meta-item">
                <span class="note">Progress</span>
                <strong>${esc(progressNote)}</strong>
              </div>
              <div class="dir-mobile-drawer-meta-item">
                <span class="note">Track</span>
                <strong>${esc(gateBit)}</strong>
              </div>
              <div class="dir-mobile-drawer-meta-item">
                <span class="note">Created</span>
                <strong>${esc(createdText)}</strong>
              </div>
            </div>
          </div>
          <div class="dir-mobile-drawer-actions is-single-action">
            <button
              type="button"
              class="btn btn-ghost dir-mobile-drawer-btn"
              data-race-act="delete-race"
              data-race-id="${esc(rid)}"
              ${ongoing ? "disabled" : ""}
              title="${ongoing ? "Pause or complete this race before deleting" : "Delete race"}"
            >${icons.trash(15)}<span>Delete</span></button>
          </div>
        </div>
      </div>`;
  }

  private refreshDirectoryResultsDom(): void {
    const resultsEl = this.el.querySelector<HTMLElement>("[data-race-dir-results]");
    if (!resultsEl) {
      this.lastSig = "";
      this.render();
      return;
    }
    const vm = this.computeRaceDirectoryViewModel();
    const prevOverlay = resultsEl.querySelector<HTMLElement>(".pilot-dir-mobile-drawer-overlay");
    if (prevOverlay && this.mobileSelectedRaceId && !this.mobileRaceDrawerClosing) {
      const temp = document.createElement("div");
      temp.innerHTML = vm.tableOrEmptyMarkup;
      const nextOverlay = temp.querySelector<HTMLElement>(".pilot-dir-mobile-drawer-overlay");
      const prevEditor = prevOverlay.querySelector<HTMLElement>(".pilot-dir-mobile-editor");
      const nextEditor = nextOverlay?.querySelector<HTMLElement>(".pilot-dir-mobile-editor");
      const prevMosaic = resultsEl.querySelector<HTMLElement>(".dir-mobile-mosaic");
      const nextMosaic = temp.querySelector<HTMLElement>(".dir-mobile-mosaic");
      const prevTable = resultsEl.querySelector<HTMLElement>(".table-scroll-shell, .table-scroll");
      const nextTable = temp.querySelector<HTMLElement>(".table-scroll");
      if (prevEditor && nextEditor && prevMosaic && nextMosaic) {
        nextEditor.classList.remove("is-entering");
        prevEditor.replaceWith(nextEditor);
        prevMosaic.replaceWith(nextMosaic);
        if (prevTable && nextTable) {
          prevTable.replaceWith(nextTable);
        }
      } else {
        resultsEl.innerHTML = vm.tableOrEmptyMarkup;
      }
    } else {
      resultsEl.innerHTML = vm.tableOrEmptyMarkup;
    }
    const footEl = this.el.querySelector<HTMLElement>("[data-race-dir-foot-note]");
    if (footEl) footEl.textContent = vm.footNote;
    const clearWrap = this.el.querySelector<HTMLElement>("[data-race-dir-clear-wrap]");
    if (clearWrap) {
      clearWrap.innerHTML = vm.hasAnyFilter
        ? `<button type="button" class="btn btn-ghost btn-xs" data-tag-filter="__reset_all__">Clear (${vm.filtered.length}/${vm.allRaces.length})</button>`
        : "";
    }
    const trimmedSearch = this.dirSearchQuery.trim();
    const exactMatch = this.findExactRaceByName(trimmedSearch, vm.allRaces);
    const addBtn = this.el.querySelector<HTMLButtonElement>('[data-race-act="create-race-inline"]');
    if (addBtn) {
      addBtn.disabled = Boolean(exactMatch);
      addBtn.title = exactMatch
        ? `Race “${exactMatch.config.eventName || trimmedSearch}” already exists`
        : trimmedSearch && !trimmedSearch.startsWith("#")
          ? `Add race “${trimmedSearch}”`
          : "Add Race";
    }
    this.mountActiveRaceTagEditor(false);
    this.syncLastSig();
  }

  private renderDirectoryView(): string {
    const vm = this.computeRaceDirectoryViewModel();
    const {
      allRaces,
      filtered,
      setupCount,
      activeCount,
      doneCount,
      hasAnyFilter,
      tableOrEmptyMarkup,
    } = vm;

    const trimmedSearch = this.dirSearchQuery.trim();
    const exactMatch = this.findExactRaceByName(trimmedSearch, allRaces);
    const addDisabled = Boolean(exactMatch);
    const addBtnTitle = exactMatch
      ? `Race “${exactMatch.config.eventName || trimmedSearch}” already exists`
      : trimmedSearch && !trimmedSearch.startsWith("#")
        ? `Add race “${trimmedSearch}”`
        : "Add Race";

    const mgpAvail = sharedMultiGPService.isAvailable(this.store);
    const filterToolbarMarkup = `
      <div class="dir-filter-toolbar" data-race-dir-toolbar>
        <div class="dir-filter-main-row">
          <div class="dir-filter-search-bar">
            <div class="dir-filter-search-row">
              ${icons.search(14)}
              <input
                type="search"
                class="input dir-filter-search-input"
                data-race-dir-search
                placeholder="Search or add race..."
                aria-label="Search or add race"
                value="${esc(this.dirSearchQuery)}"
                autocomplete="off"
              />
            </div>
            <button type="button" class="btn btn-unarmed" data-race-act="create-race-inline" ${addDisabled ? "disabled" : ""} title="${esc(addBtnTitle)}" aria-label="Add Race">${icons.plus(14)}<span>Add</span></button>
          </div>
          <div class="dir-filter-right">
            <div class="segmented dir-filter-seg" role="tablist" aria-label="Filter races by status">
              <button type="button" class="${this.dirStatusFilter === "all" ? "is-active" : ""}" data-race-dir-status="all">
                All (${allRaces.length})
              </button>
              <button type="button" class="${this.dirStatusFilter === "setup" ? "is-active" : ""}" data-race-dir-status="setup">
                Setup (${setupCount})
              </button>
              <button type="button" class="${this.dirStatusFilter === "active" ? "is-active" : ""}" data-race-dir-status="active">
                Active (${activeCount})
              </button>
              <button type="button" class="${this.dirStatusFilter === "done" ? "is-active" : ""}" data-race-dir-status="done">
                Done (${doneCount})
              </button>
            </div>
            <span data-race-dir-clear-wrap>${
              hasAnyFilter
                ? `<button type="button" class="btn btn-ghost btn-xs" data-tag-filter="__reset_all__">Clear (${filtered.length}/${allRaces.length})</button>`
                : ""
            }</span>
          </div>
        </div>
      </div>`;

    const bottomActionsMarkup = mgpAvail
      ? `<div class="pilot-dir-mobile-footer" data-race-dir-bottom-actions>
           <button type="button" class="btn btn-sm pilot-dir-mgp-btn" data-race-act="import-multigp" title="Import from MultiGP" aria-label="Import from MultiGP"><span>Import from MultiGP</span></button>
         </div>`
      : "";

    return `
      <section class="settings-section is-single-col">
        <div class="races-dir-stack">
          <div class="card card-flush races-dir-card">
            ${filterToolbarMarkup}
            <div data-race-dir-results>${tableOrEmptyMarkup}</div>
          </div>
          ${bottomActionsMarkup}
        </div>
      </section>`;
  }

  private renderTopLeftCanvasBar(
    race: RaceTournamentState,
    mode: WorkspaceTab,
    _forceInitialDrawerState?: "open" | "collapsed"
  ): string {
    const isConfigureMode = mode === "format" || mode === "edit";
    const isOpenQual = hasOpenQualifierRound(race);
    const activeMobileView =
      this.mobileControlView === "queue" && !isOpenQual ? "live" : this.mobileControlView;
    const configured = isRaceConfigured(race);

    return `
      <div class="rc-topleft-bar" data-rc-hud>
        <div class="sched-lineup-wrap rc-topleft-scroll-wrap">
          <button type="button" class="sched-lineup-cue is-left" data-lineup-scroll="-1" aria-label="Scroll workspace tabs left" title="Scroll left" hidden>${icons.chevronLeft(13)}</button>
          <div class="rc-topleft-seg sched-lineup" role="navigation" aria-label="Race Workspace" data-fit-lineup data-rc-topleft-track>
            <button
              type="button"
              class="rc-topleft-btn rc-mode-btn ${mode === "control" && activeMobileView === "live" ? "is-active" : ""}"
              data-mobile-ctrl-nav="live"
              aria-selected="${mode === "control" && activeMobileView === "live" ? "true" : "false"}"
              title="Run live heats, countdowns, and flight line"
            >
              ${icons.flag(13)}<span>Run</span>
            </button>

            <button
              type="button"
              class="rc-topleft-btn rc-mode-btn ${mode === "pilots" ? "is-active" : ""}"
              data-race-tab="pilots"
              aria-selected="${mode === "pilots" ? "true" : "false"}"
              title="Check in pilots, add walk-ups, and set attendance"
            >
              ${icons.pilot(13)}<span>Pilots</span>
            </button>

            <button
              type="button"
              class="rc-topleft-btn rc-mode-btn ${mode === "track" ? "is-active" : ""}"
              data-race-tab="track"
              aria-selected="${mode === "track" ? "true" : "false"}"
              title="Configure timers, gate order, and timing rules for this race"
            >
              ${icons.gate(13)}<span>Track</span>
            </button>

            <button
              type="button"
              class="rc-topleft-btn rc-mode-btn ${isConfigureMode ? "is-active" : ""}"
              data-race-tab="edit"
              aria-selected="${isConfigureMode ? "true" : "false"}"
              title="Set up rounds, seeding, and heats"
            >
              ${icons.settings(13)}<span>Setup</span>
            </button>
            ${
              isOpenQual
                ? `<button
                     type="button"
                     class="rc-topleft-btn rc-mode-btn ${mode === "control" && activeMobileView === "queue" ? "is-active" : ""}"
                     data-mobile-ctrl-nav="queue"
                     aria-selected="${mode === "control" && activeMobileView === "queue" ? "true" : "false"}"
                     ${!configured ? "disabled" : ""}
                     title="Open Qualifier flight queue"
                   >
                     ${icons.zap(13)}<span>Queue</span>
                   </button>`
                : ""
            }
            <button
              type="button"
              class="rc-topleft-btn rc-mode-btn ${mode === "control" && activeMobileView === "schedule" ? "is-active" : ""}"
              data-mobile-ctrl-nav="schedule"
              aria-selected="${mode === "control" && activeMobileView === "schedule" ? "true" : "false"}"
              ${!configured ? "disabled" : ""}
              title="Heats schedule"
            >
              ${icons.calendar(13)}<span>Schedule</span>
            </button>
            <button
              type="button"
              class="rc-topleft-btn rc-mode-btn ${mode === "control" && activeMobileView === "standings" ? "is-active" : ""}"
              data-mobile-ctrl-nav="standings"
              aria-selected="${mode === "control" && activeMobileView === "standings" ? "true" : "false"}"
              ${!configured ? "disabled" : ""}
              title="Race standings"
            >
              ${icons.trophy(13)}<span>Standings</span>
            </button>

            <button
              type="button"
              class="rc-topleft-btn rc-mode-btn ${mode === "review" ? "is-active" : ""}"
              data-race-tab="review"
              ${!configured ? "disabled" : ""}
              title="${!configured ? "Set up tournament format first" : "Review executed heats, inspect RSSI crossings, and adjust placements"}"
            >
              ${icons.reviewCheck(13)}<span>Review</span>
            </button>

            <button
              type="button"
              class="rc-topleft-btn rc-mode-btn ${mode === "control" && activeMobileView === "signals" ? "is-active" : ""}"
              data-mobile-ctrl-nav="signals"
              aria-selected="${mode === "control" && activeMobileView === "signals" ? "true" : "false"}"
              ${!configured ? "disabled" : ""}
              title="Live RSSI signals"
            >
              ${icons.signal(13)}<span>Signals</span>
            </button>

            <button
              type="button"
              class="rc-topleft-btn rc-mode-btn ${mode === "analytics" ? "is-active" : ""}"
              data-race-tab="analytics"
              aria-selected="${mode === "analytics" ? "true" : "false"}"
              ${!configured ? "disabled" : ""}
              title="${!configured ? "Set up tournament format first" : "Inspect lap consistency, section splits, and recommendations"}"
            >
              ${icons.chart(13)}<span>Analytics</span>
            </button>
          </div>
          <button type="button" class="sched-lineup-cue is-right" data-lineup-scroll="1" aria-label="Scroll workspace tabs right" title="More tabs" hidden>${icons.chevronRight(13)}</button>
        </div>
      </div>`;
  }

  private isRaceActivelyTiming(race: RaceTournamentState): boolean {
    const lifecycle: RaceLifecycle = race.lifecycle ?? (race.isComplete ? "completed" : "draft");
    const configured = isRaceConfigured(race);
    const isEmergency = Boolean(race.emergencyStopped);
    const isPaused = !isEmergency && lifecycle === "paused";
    return !isEmergency && !isPaused && configured && isRaceOngoing(race);
  }

  private renderRaceStandbyStripHtml(
    race: RaceTournamentState,
    mode: WorkspaceTab
  ): { barCls: string; standbyHtml: string } {
    const isOpenQual = hasOpenQualifierRound(race);
    const activeMobileView =
      this.mobileControlView === "queue" && !isOpenQual ? "live" : this.mobileControlView;
    const inRunView = mode === "control" && activeMobileView === "live";

    if (!inRunView) {
      const jumpHeat = this.getLiveJumpBannerHeat(race);
      if (jumpHeat) {
        const hLabel = jumpHeat.shortLabel || jumpHeat.title;
        const clockTxt =
          jumpHeat.state === "running" || jumpHeat.state === "countdown"
            ? this.computeLiveHeatClockText(race, jumpHeat)
            : "";
        const pillText =
          jumpHeat.state === "countdown"
            ? "Starting"
            : jumpHeat.state === "finished"
              ? "Review"
              : "Live";
        const fullBody =
          jumpHeat.state === "finished"
            ? `<strong>${esc(hLabel)}</strong> finished · Confirm in Run →`
            : `<strong>${esc(hLabel)}</strong> <span class="mono" data-live-jump-clock>(${esc(clockTxt)})</span> · Go to Run →`;
        const shortBody = `<strong>${esc(hLabel)}</strong> · Run →`;
        return {
          barCls: "is-ws-live",
          standbyHtml: `
            <button type="button" class="ws-live-jump-bar" data-ws-live-jump="race" data-mobile-ctrl-nav="live" title="Jump back to ${esc(hLabel)} in Run">
              <span class="ws-live-jump-pill"><span class="topbar-ws-live-dot" aria-hidden="true"></span><span>${pillText}</span></span>
              <span class="ws-live-jump-text"><span class="rc-lbl-full">${fullBody}</span><span class="rc-lbl-short">${shortBody}</span></span>
            </button>`,
        };
      }
    }

    if (this.isRaceActivelyTiming(race)) {
      return { barCls: "is-ws-live", standbyHtml: "" };
    }
    const lifecycle: RaceLifecycle = race.lifecycle ?? (race.isComplete ? "completed" : "draft");
    const isEmergency = Boolean(race.emergencyStopped);

    let toneCls = "is-idle";
    let pillText = "Idle";
    let msgText = "Race is idle - laps aren't counting";

    if (isEmergency) {
      toneCls = "is-emergency";
      pillText = "Emergency";
      msgText = "Emergency stop is active - laps aren't counting";
    } else if (lifecycle === "scrapped") {
      toneCls = "is-emergency";
      pillText = "Stopped";
      msgText = "Race is stopped - laps aren't counting";
    } else if (lifecycle === "paused") {
      toneCls = "is-paused";
      pillText = "Paused";
      msgText = "Race is paused - laps aren't counting";
    } else if (lifecycle === "completed" || race.isComplete) {
      toneCls = "is-idle";
      pillText = "Completed";
      msgText = "Race is completed - viewing results";
    }

    return {
      barCls: "is-ws-standby",
      standbyHtml: `
        <div class="ws-standby-bar ${toneCls}" data-ws-standby-bar="race" role="status">
          <div class="ws-standby-copy">
            <span class="ws-standby-pill">${pillText}</span>
            <span class="ws-standby-text">${msgText}</span>
          </div>
        </div>`,
    };
  }

  private renderRaceWorkspaceTopBar(
    race: RaceTournamentState,
    mode: WorkspaceTab,
    rightHtml = "",
    extraCls = ""
  ): string {
    const { barCls, standbyHtml } = this.renderRaceStandbyStripHtml(race, mode);
    const cls = ["races-page-topbar", extraCls, barCls].filter(Boolean).join(" ");
    return `
      <div class="${cls}" data-rc-hud>
        <div class="rc-topbar-side is-left" aria-hidden="true"></div>
        ${this.renderTopLeftCanvasBar(race, mode)}
        <div class="rc-topbar-side is-right">${rightHtml}</div>
        ${standbyHtml}
      </div>`;
  }

  private renderDesktopSetupViewToggle(): string {
    return `
      <div
        class="rc-setup-view-toggle"
        role="group"
        aria-label="Setup view mode"
        data-setup-view-switcher
        data-active-view="${this.desktopSetupView}"
      >
        <button
          type="button"
          class="rc-setup-view-btn ${this.desktopSetupView === "graph" ? "is-active" : ""}"
          data-setup-view="graph"
          aria-pressed="${this.desktopSetupView === "graph" ? "true" : "false"}"
          title="Switch to Graph view"
        >Graph</button>
        <button
          type="button"
          class="rc-setup-view-btn ${this.desktopSetupView === "table" ? "is-active" : ""}"
          data-setup-view="table"
          aria-pressed="${this.desktopSetupView === "table" ? "true" : "false"}"
          title="Switch to Table view"
        >Table</button>
      </div>`;
  }

  private computePilotsPanelViewData(race: RaceTournamentState): {
    roster: EventPilot[];
    viewStage: number;
    stageHasHeats: boolean;
    seatLabelBySlot: Map<number, string>;
    activePilots: EventPilot[];
    unassignedPilots: EventPilot[];
    assignedPilots: EventPilot[];
    inactivePilots: EventPilot[];
    filteredPilots: EventPilot[];
  } {
    const roster: EventPilot[] = race.roster ?? [];
    const viewStage = this.getCurrentViewStage(race);
    const stageHeats = race.heats.filter((h) => h.stageIndex === viewStage);
    const stageHasHeats = stageHeats.length > 0;

    const seatLabelBySlot = new Map<number, string>();
    for (const h of stageHeats) {
      for (const s of h.seats) {
        if (s.pilotSlotIndex > 0 && s.status !== "dns" && !seatLabelBySlot.has(s.pilotSlotIndex)) {
          const chLbl = formatBandChannelShort(s.band, s.channel) || `R${s.channel}`;
          seatLabelBySlot.set(s.pilotSlotIndex, `${h.shortLabel} · ${chLbl}`);
        }
      }
    }

    const activePilots = roster.filter((pl) => pl.checkedIn && pl.attendance === "active");
    const unassignedPilots = activePilots.filter((pl) => !seatLabelBySlot.has(pl.slotIndex));
    const assignedPilots = roster.filter((pl) => seatLabelBySlot.has(pl.slotIndex));
    const inactivePilots = roster.filter((pl) => !pl.checkedIn || pl.attendance !== "active");

    let filteredPilots: EventPilot[] = roster;
    const q = this.pilotsSearchQuery.trim().toLowerCase();
    if (q) {
      filteredPilots = roster.filter((pl) => {
        const seatLabel = (seatLabelBySlot.get(pl.slotIndex) ?? "").toLowerCase();
        return (
          pl.callsign.toLowerCase().includes(q) ||
          (pl.phoneticName ?? "").toLowerCase().includes(q) ||
          seatLabel.includes(q)
        );
      });
    } else {
      if (this.pilotsFilter === "unassigned") {
        filteredPilots = unassignedPilots;
      } else if (this.pilotsFilter === "assigned") {
        filteredPilots = assignedPilots;
      } else if (this.pilotsFilter === "inactive") {
        filteredPilots = inactivePilots;
      }
    }

    return {
      roster,
      viewStage,
      stageHasHeats,
      seatLabelBySlot,
      activePilots,
      unassignedPilots,
      assignedPilots,
      inactivePilots,
      filteredPilots,
    };
  }

  private renderPilotsPanelResults(race: RaceTournamentState, mode: WorkspaceTab): string {
    const {
      roster,
      viewStage,
      stageHasHeats,
      seatLabelBySlot,
      unassignedPilots,
      inactivePilots,
      filteredPilots,
    } = this.computePilotsPanelViewData(race);

    const quickBatchBar =
      inactivePilots.length > 0
        ? `<div class="rc-pilots-batch-bar">
            <span></span>
            <button type="button" class="btn btn-ghost btn-xs" data-race-act="check-in-all">
              Check In All (${inactivePilots.length})
            </button>
          </div>`
        : "";

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
    const canModifyRoster = race.lifecycle !== "completed" && race.lifecycle !== "scrapped";

    const trimmedQuery = this.pilotsSearchQuery.trim();
    const walkupExactLower = trimmedQuery.toLowerCase();
    const rowsHtml =
      filteredPilots.length === 0
        ? `<div class="rc-pilots-empty note">${
            roster.length === 0
              ? `No pilots in directory yet — type a callsign above to add or open <a href="#/pilots" class="rc-inline-link">Pilots</a>.`
              : trimmedQuery
                ? `No existing pilots match “${esc(trimmedQuery)}” — click Add to register.`
                : this.pilotsFilter === "unassigned"
                  ? stageHasHeats
                    ? "All active pilots are seated in this stage."
                    : "No active unassigned pilots."
                  : this.pilotsFilter === "assigned"
                    ? stageHasHeats
                      ? "No pilots seated in this stage yet."
                      : "Add a round to seat pilots in this stage."
                    : "No AWY, DQ, or DNC pilots."
          }</div>`
        : `<div class="rc-pilots-list">
            ${filteredPilots
              .map((pilot) => {
                const attNorm: PilotAttendance =
                  pilot.attendance === "forfeit" ? "dnc" : pilot.attendance || "active";
                const isActive = pilot.checkedIn && attNorm === "active";
                const isAway = pilot.checkedIn && attNorm === "away";
                const isDq = pilot.checkedIn && attNorm === "dq";
                const isDnc = pilot.checkedIn && attNorm === "dnc";
                const hasCountedHeats = countedPilots.has(pilot.slotIndex);
                const seatBadge = seatLabelBySlot.get(pilot.slotIndex);
                const canDrag = mode === "edit" && isActive;
                const isExact =
                  !!walkupExactLower && pilot.callsign.trim().toLowerCase() === walkupExactLower;

                let seatActionHtml = "";
                if (seatBadge) {
                  seatActionHtml = `<span class="rc-pilot-seat-badge mono" title="Seated in ${esc(seatBadge)}">${esc(seatBadge)}</span>`;
                } else if ((mode === "edit" || mode === "pilots") && isActive && stageHasHeats) {
                  seatActionHtml = `<button type="button" class="btn btn-ghost btn-xs rc-pilot-seat-btn" data-bkt-action="auto_seat_pilot" data-pilot-slot="${pilot.slotIndex}" title="Auto-seat ${esc(pilot.callsign)} into next open seat">+ Seat</button>`;
                } else if (isActive && !stageHasHeats) {
                  seatActionHtml = `<span class="rc-pilot-unseated-note note">Unseated</span>`;
                }

                const switchLocked = !canModifyRoster || (pilot.checkedIn && hasCountedHeats);
                const switchTitle =
                  pilot.checkedIn && hasCountedHeats
                    ? `${pilot.callsign} has recorded heats in this race — mark AWY, DQ, or DNC instead`
                    : pilot.checkedIn
                      ? `Uncheck ${pilot.callsign} (return to Free state)`
                      : `Check in ${pilot.callsign}`;
                const checkInSwitch = `
                  <button
                    type="button"
                    role="switch"
                    aria-checked="${pilot.checkedIn ? "true" : "false"}"
                    aria-label="${esc(switchTitle)}"
                    class="bkt-checkin-switch ${pilot.checkedIn ? "is-on" : ""}"
                    data-pilots-checkin-toggle="${pilot.slotIndex}"
                    ${switchLocked ? "disabled" : ""}
                    title="${esc(switchTitle)}"
                  >
                    <span class="bkt-checkin-thumb"></span>
                  </button>`;

                const attControlsHtml = canModifyRoster
                  ? pilot.checkedIn
                    ? `<div class="bkt-pilot-att-seg" role="group" aria-label="Status for ${esc(pilot.callsign)}">
                        <button type="button" class="bkt-pilot-att-btn ${isAway ? "is-active" : ""}" data-att-status="away" data-slot-index="${pilot.slotIndex}" aria-pressed="${isAway ? "true" : "false"}" title="${isAway ? "Clear AWY status (return to active)" : "Temporarily away (AWY)"}">AWY</button>
                        <button type="button" class="bkt-pilot-att-btn ${isDq ? "is-active" : ""}" data-att-status="dq" data-slot-index="${pilot.slotIndex}" aria-pressed="${isDq ? "true" : "false"}" title="${isDq ? "Clear DQ status (restore pilot)" : "Disqualify pilot from race (DQ)"}">DQ</button>
                        <button type="button" class="bkt-pilot-att-btn ${isDnc ? "is-active" : ""}" data-att-status="dnc" data-slot-index="${pilot.slotIndex}" aria-pressed="${isDnc ? "true" : "false"}" title="${isDnc ? "Clear DNC status (return to active)" : "Did Not Complete remaining race (DNC)"}">DNC</button>
                      </div>`
                    : `<span class="bkt-pilot-unchecked-lbl">Free</span>`
                  : `<span class="race-state-pill ${isActive ? "is-done" : isAway ? "is-warn" : isDq || isDnc ? "is-bad" : "is-ready"}">${!pilot.checkedIn ? "Free" : isActive ? "Racing" : isAway ? "AWY" : isDq ? "DQ" : "DNC"}</span>`;

                return `
                  <div
                    class="rc-pilot-row ${isActive ? "is-active-pilot" : "is-out-pilot"} ${isExact ? "is-exact-match" : ""}"
                    ${canDrag ? `draggable="true" data-drag-pilot="${pilot.slotIndex}" title="Drag ${esc(pilot.callsign)} onto any unstarted heat seat"` : ""}
                  >
                    <div class="rc-pilot-row-main">
                      ${canDrag ? `<span class="bkt-grip">${icons.grip(11)}</span>` : mode === "edit" ? `<span class="rc-pilot-grip-spacer"></span>` : ""}
                      ${checkInSwitch}
                      <span class="dot" style="--c:${adaptColorForTheme(pilot.color)}"></span>
                      <strong class="rc-pilot-name">${esc(pilot.callsign)}</strong>
                    </div>
                    <div class="rc-pilot-row-right">
                      ${seatActionHtml}
                      ${attControlsHtml}
                    </div>
                  </div>`;
              })
              .join("")}
          </div>`;

    return `${quickBatchBar}${rowsHtml}`;
  }

  private renderPilotsCanvasPanel(race: RaceTournamentState, mode: WorkspaceTab): string {
    if (mode === "edit" && isRootStage(race, this.getCurrentViewStage(race))) {
      return "";
    }
    const p = mode === "edit" ? this.editPilotsPanel : this.controlPanels.pilots;
    if (mode === "edit" && !p.visible) return "";
    const isPageCard = mode !== "edit";
    const effectiveCollapsed = mode === "pilots" ? false : p.collapsed;

    const {
      roster,
      stageHasHeats,
      activePilots,
      unassignedPilots,
      assignedPilots,
      inactivePilots,
    } = this.computePilotsPanelViewData(race);

    const checkedInCount = roster.filter((pl) => pl.checkedIn).length;
    const canAddPilots = race.lifecycle !== "completed" && race.lifecycle !== "scrapped";
    const trimmedSearch = this.pilotsSearchQuery.trim();
    const exactPanelMatch = this.findExistingPilotCallsign(trimmedSearch, race);
    const addPanelDisabled = !trimmedSearch || !!exactPanelMatch;
    const addPanelTitle = exactPanelMatch
      ? `Pilot “${exactPanelMatch}” is already in roster`
      : trimmedSearch
        ? `Add pilot “${trimmedSearch}”`
        : "Search or type a unique callsign to add";

    const bodyHtml = effectiveCollapsed
      ? ""
      : `<div class="rc-panel-body rc-pilots-panel-body">
          <div class="rc-pilots-toolbar">
            <div class="rc-pilots-search-bar">
              <div class="rc-pilots-search-row">
                ${icons.search(13)}
                <input
                  type="search"
                  class="input input-sm rc-pilots-search-input"
                  data-race-field="pilots-search"
                  placeholder="Search or add pilot..."
                  aria-label="Search or add pilot"
                  value="${esc(this.pilotsSearchQuery)}"
                  autocomplete="off"
                />
              </div>
              ${
                canAddPilots
                  ? `<button
                      type="button"
                      class="btn btn-ghost btn-xs bkt-pilots-add-btn"
                      data-race-act="submit-panel-walkup"
                      ${addPanelDisabled ? "disabled" : ""}
                      title="${esc(addPanelTitle)}"
                    >
                      ${icons.plus(12)}<span>Add</span>
                    </button>`
                  : ""
              }
            </div>
            <div class="segmented rc-pilots-filter-seg" role="tablist" aria-label="Filter race pilots">
              <button type="button" class="${this.pilotsFilter === "all" ? "is-active" : ""}" data-pilots-filter="all">
                All (${roster.length})
              </button>
              <button type="button" class="${this.pilotsFilter === "unassigned" ? "is-active" : ""}" data-pilots-filter="unassigned">
                Unassigned (${unassignedPilots.length})
              </button>
              <button type="button" class="${this.pilotsFilter === "assigned" ? "is-active" : ""}" data-pilots-filter="assigned">
                Seated (${assignedPilots.length})
              </button>
              <button type="button" class="${this.pilotsFilter === "inactive" ? "is-active" : ""}" data-pilots-filter="inactive">
                Out (${inactivePilots.length})
              </button>
            </div>
            ${
              mode === "pilots"
                ? `<p class="rc-pilots-checkin-hint" data-pilots-checkin-hint><span class="rc-lbl-full">Checked-in active pilots are automatically placed into heats when you generate or add rounds in Setup.</span><span class="rc-lbl-short">Active pilots auto-seed into heats in Setup.</span></p>`
                : ""
            }
          </div>
          <div class="rc-pilots-results" data-rc-pilots-results>
            ${this.renderPilotsPanelResults(race, mode)}
          </div>
        </div>`;

    if (isPageCard) {
      const configured = isRaceConfigured(race);
      return `
        <section
          class="rc-canvas-panel rc-page-card is-pilots-panel ${effectiveCollapsed ? "is-collapsed" : ""}"
          data-canvas-panel="pilots"
          data-mobile-sec="pilots"
        >
          <header class="rc-panel-header">
            <div class="rc-panel-title-wrap">
              ${icons.pilot(14)}
              <strong>Pilots Roster</strong>
              <span class="badge mono bkt-pilots-count-pill">${activePilots.length} racing</span>
            </div>
            ${
              mode === "pilots"
                ? `<div class="rc-panel-actions">
                    ${
                      !configured
                        ? `<button type="button" class="btn btn-armed btn-xs" data-race-tab="edit" data-pilots-next-setup title="Continue to Setup to pick a race format and generate heats">
                             ${icons.settings(12)}<span class="rc-lbl-full">Next: Setup Heats →</span><span class="rc-lbl-short">Setup →</span>
                           </button>`
                        : `<button type="button" class="btn btn-ghost btn-xs" data-mobile-ctrl-nav="live" title="Jump to Run">
                             ${icons.flag(12)}<span class="rc-lbl-full">Go to Run →</span><span class="rc-lbl-short">Run →</span>
                           </button>`
                    }
                  </div>`
                : `<div class="rc-panel-actions">
                    <button type="button" class="rc-panel-icon-btn rc-desktop-collapse-btn" data-rc-panel-collapse="pilots" title="${effectiveCollapsed ? "Expand section" : "Collapse section"}" aria-label="Toggle collapse">
                      ${effectiveCollapsed ? icons.plus(13) : icons.minus(13)}
                    </button>
                  </div>`
            }
          </header>
          ${bodyHtml}
        </section>`;
    }

    return `
      <section
        class="rc-canvas-panel is-pilots-panel ${p.collapsed ? "is-collapsed" : ""}"
        data-canvas-panel="pilots"
        data-pos-x="${p.x}"
        data-pos-y="${p.y}"
        style="left:0;top:0;z-index:${p.zIndex};transform: translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)"
      >
        <header class="rc-panel-header" data-panel-drag-handle>
          <div class="rc-panel-title-wrap">
            <span class="rc-panel-grip">${icons.grip(13)}</span>
            ${icons.pilot(14)}
            <strong>Pilots Roster</strong>
            <span class="badge mono bkt-pilots-count-pill">${activePilots.length} racing</span>
          </div>
          <div class="rc-panel-actions">
            <button type="button" class="rc-panel-icon-btn" data-rc-panel-collapse="pilots" title="${p.collapsed ? "Expand panel" : "Collapse panel"}" aria-label="Toggle collapse">
              ${p.collapsed ? icons.plus(13) : icons.minus(13)}
            </button>
            <button type="button" class="rc-panel-icon-btn" data-rc-panel-toggle="pilots" title="Hide Pilots Roster panel (re-add from + menu)" aria-label="Hide Pilots Roster panel">
              ${icons.close(13)}
            </button>
          </div>
        </header>
        ${bodyHtml}
      </section>`;
  }

  private renderBoardControlsPill(race: RaceTournamentState, mode: WorkspaceTab): string {
    const stages = resolveStagesList(race);
    const canEditStructure =
      race.lifecycle !== "completed" && race.lifecycle !== "scrapped";
    const selectedDeletableCount = !canEditStructure
      ? 0
      : mode === "format"
        ? Array.from(this.bktUi.selectedRoundIds).filter((id) =>
            stages.some((s) => s.id === id)
          ).length
        : mode === "edit"
          ? Array.from(this.bktUi.selectedRoundIds).filter((id) => !isHandoffPortalRound(id)).length
          : 0;
    const expanded = this.bktUi.controlsExpanded;
    const itemNoun = mode === "format" ? "stage" : "round";

    const isLocked = this.isCanvasLocked(mode);
    const expandedItems = expanded
      ? `<div class="rc-board-controls-extra">
          ${
            selectedDeletableCount > 0
              ? `<button
                  type="button"
                  class="rc-ctrl-icon-btn"
                  data-rc-ui="delete-selected"
                  title="Delete ${selectedDeletableCount} selected ${itemNoun}${selectedDeletableCount === 1 ? "" : "s"}"
                  aria-label="Delete selected ${itemNoun}s"
                >
                  ${icons.trash(15)}
                </button>`
              : ""
          }
          ${
            mode === "format" || mode === "edit"
              ? `<button
                  type="button"
                  class="rc-ctrl-icon-btn"
                  data-rc-ui="open-templates"
                  title="Choose a race format template"
                  aria-label="Choose format template"
                >
                  ${icons.layers(15)}
                </button>`
              : ""
          }
          <button
            type="button"
            class="rc-ctrl-icon-btn"
            data-rc-ui="reset-layout"
            ${(mode === "edit" && (race.rounds ?? []).length === 0) || (mode === "format" && stages.length === 0) ? "disabled" : ""}
            title="${
              mode === "format"
                ? "Auto-organize stage DAG left-to-right"
                : mode === "edit"
                  ? "Auto-organize rounds cleanly left-to-right"
                  : "Reset panels & graph layout"
            }"
            aria-label="Reset layout"
          >
            ${icons.layout(15)}
          </button>
          <span class="rc-ctrl-sep"></span>
        </div>`
      : "";

    const toolToggleBtn =
      mode === "format" || mode === "edit"
        ? `<button
            type="button"
            class="rc-ctrl-icon-btn ${this.bktUi.tool === "select" ? "is-active" : ""}"
            data-rc-ui="toggle-tool"
            title="${
              this.bktUi.tool === "select"
                ? "Marquee Select active — click to switch back to Pan (default)"
                : "Pan active (default) — click to switch to Marquee Multi-Select"
            }"
            aria-label="Toggle Pan or Marquee Select"
          >
            ${this.bktUi.tool === "select" ? icons.cursor(15) : icons.hand(15)}
          </button>`
        : "";

    return `
      <div class="rc-board-controls" data-rc-hud role="toolbar" aria-label="Canvas controls">
        ${expandedItems}
        <button type="button" class="rc-ctrl-icon-btn" data-rc-ui="zoom-in" title="Zoom in" aria-label="Zoom in">
          ${icons.plus(15)}
        </button>
        <button type="button" class="rc-ctrl-icon-btn" data-rc-ui="zoom-out" title="Zoom out" aria-label="Zoom out">
          ${icons.minus(15)}
        </button>
        <button type="button" class="rc-ctrl-icon-btn" data-rc-ui="fit-view" title="Fit all in view" aria-label="Fit view">
          ${icons.maximize(15)}
        </button>
        ${toolToggleBtn}
        <button
          type="button"
          class="rc-ctrl-icon-btn ${isLocked ? "is-active" : ""}"
          data-rc-ui="toggle-lock"
          title="${isLocked ? "Unlock panels & nodes (allow moving & adding items)" : "Lock panels & nodes in place"}"
          aria-pressed="${isLocked ? "true" : "false"}"
          aria-label="Toggle panel and node lock"
        >
          ${isLocked ? icons.lock(15) : icons.unlock(15)}
        </button>
        <button
          type="button"
          class="rc-ctrl-expand-btn ${expanded ? "is-expanded" : ""}"
          data-rc-ui="toggle-controls-expand"
          title="${expanded ? "Hide extra board controls" : "More board controls (Reset Layout)"}"
          aria-expanded="${expanded ? "true" : "false"}"
          aria-label="More board controls"
        >
          ${icons.plus(15)}
        </button>
      </div>`;
  }

  private renderSpeedDialItems(
    race: RaceTournamentState,
    mode: WorkspaceTab,
    _submenu: "" | "add" | "templates" | "panels"
  ): string {
    const roster: EventPilot[] = race.roster ?? [];
    const checkedInCount = roster.filter((p) => p.checkedIn).length;
    const pilotsVisible =
      mode === "edit" ? this.editPilotsPanel.visible : this.controlPanels.pilots.visible;
    const viewStage = this.getCurrentViewStage(race);
    const stageHasFinals = (race.rounds ?? []).some(
      (r) => r.stageIndex === viewStage && r.bracketLane === "finals"
    );
    const canEditStages =
      race.lifecycle !== "completed" && race.lifecycle !== "scrapped";
    const stagesCount = resolveStagesList(race).length;
    const maxStagesReached = !canEditStages || stagesCount >= 5;

    interface FabRowDef {
      labelHtml: string;
      btnHtml: string;
      disabled?: boolean;
    }
    const rows: FabRowDef[] = [];

    if (mode === "format") {
      rows.push(
        {
          labelHtml: `<span class="rc-fab-label">Qualifier</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-fmt-add-stage="qualifying" ${maxStagesReached ? "disabled" : ""} title="Add Qualifier Stage">${icons.timer(16)}</button>`,
          disabled: maxStagesReached,
        },
        {
          labelHtml: `<span class="rc-fab-label">Open Qualifier</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-fmt-add-stage="open_qualifier" ${maxStagesReached ? "disabled" : ""} title="Add Open Qualifier Stage (Flight Queue)">${icons.zap(16)}</button>`,
          disabled: maxStagesReached,
        },
        {
          labelHtml: `<span class="rc-fab-label">ZippyQ Qualifier</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-fmt-add-stage="zippyq_qualifier" ${maxStagesReached ? "disabled" : ""} title="Add MultiGP ZippyQ Qualifier Stage">${icons.zap(16)}</button>`,
          disabled: maxStagesReached,
        },
        {
          labelHtml: `<span class="rc-fab-label">Single Elimination</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-fmt-add-stage="single_elimination" ${maxStagesReached ? "disabled" : ""} title="Add Single Elimination Stage">${icons.checkered(16)}</button>`,
          disabled: maxStagesReached,
        },
        {
          labelHtml: `<span class="rc-fab-label">Double Elimination</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-fmt-add-stage="double_elimination" ${maxStagesReached ? "disabled" : ""} title="Add Double Elimination Stage">${icons.bracket(16)}</button>`,
          disabled: maxStagesReached,
        },
        {
          labelHtml: `<span class="rc-fab-label">Points / Mains</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-fmt-add-stage="points_mains" ${maxStagesReached ? "disabled" : ""} title="Add Points / A-B-C Mains Stage">${icons.trophy(16)}</button>`,
          disabled: maxStagesReached,
        },
        {
          labelHtml: `<span class="rc-fab-label">Custom Stage</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-fmt-add-stage="custom" ${maxStagesReached ? "disabled" : ""} title="Add Custom Stage">${icons.plus(16)}</button>`,
          disabled: maxStagesReached,
        }
      );
    } else if (mode === "edit") {
      rows.push(
        {
          labelHtml: `<span class="rc-fab-label">Qualifier</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-rc-add-node="qualifying" title="Add Qualifier Round">${icons.timer(16)}</button>`,
        },
        {
          labelHtml: `<span class="rc-fab-label">Open Qualifier</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-rc-add-node="open_qualifier" title="Add Open Qualifier Round">${icons.zap(16)}</button>`,
        },
        {
          labelHtml: `<span class="rc-fab-label">ZippyQ</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-rc-add-node="zippyq_qualifier" title="Add ZippyQ Qualifier Round">${icons.zap(16)}</button>`,
        },
        {
          labelHtml: `<span class="rc-fab-label">Race Round</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-rc-add-node="race" title="Add Head-to-Head Race Round">${icons.checkered(16)}</button>`,
        },
        {
          labelHtml: `<span class="rc-fab-label">Points Round</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-rc-add-node="points_mains" title="Add Points Round">${icons.layers(16)}</button>`,
        },
        {
          labelHtml: `<span class="rc-fab-label">Finals</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-rc-add-node="finals" title="Add Championship Finals Round">${icons.trophy(16)}</button>`,
        }
      );
      if (!isRootStage(race, viewStage) && !pilotsVisible) {
        rows.push({
          labelHtml: `<span class="rc-fab-label" data-fab-pilots-count>Pilots Roster (${checkedInCount})</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-rc-add-panel="pilots" title="Add Pilots Roster panel to canvas">${icons.pilot(16)}</button>`,
        });
      }
    } else if (mode === "review") {
      const missingReviewPanels: FabRowDef[] = [];
      if (!this.reviewPanels.review_heat.visible) {
        missingReviewPanels.push({
          labelHtml: `<span class="rc-fab-label">Heat Review</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-rc-add-panel="review_heat" title="Add Heat Review panel to canvas">${icons.reviewCheck(16)}</button>`,
        });
      }
      if (!this.reviewPanels.review_list.visible) {
        missingReviewPanels.push({
          labelHtml: `<span class="rc-fab-label">Executed Heats</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-rc-add-panel="review_list" title="Add Executed Heats panel to canvas">${icons.calendar(16)}</button>`,
        });
      }
      if (this.isMultiGPVerified() && !this.reviewPanels.review_mgp.visible) {
        missingReviewPanels.push({
          labelHtml: `<span class="rc-fab-label">MultiGP Sync</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-rc-add-panel="review_mgp" title="Add MultiGP Sync panel to canvas">${icons.upload(16)}</button>`,
        });
      }
      if (missingReviewPanels.length === 0) {
        rows.push({
          labelHtml: `<span class="rc-fab-label">All panels on canvas</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" disabled title="All Review panels are already visible on canvas">${icons.check(16)}</button>`,
          disabled: true,
        });
      } else {
        rows.push(...missingReviewPanels);
      }
    } else {
      const isOpenQualStage = hasOpenQualifierRound(race);
      const missingControlPanels: FabRowDef[] = [];
      if (!this.controlPanels.cockpit.visible) {
        missingControlPanels.push({
          labelHtml: `<span class="rc-fab-label">Race Control</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-rc-add-panel="cockpit" title="Add Race Control panel to canvas">${icons.checkered(16)}</button>`,
        });
      }
      if (!this.controlPanels.heatline.visible) {
        missingControlPanels.push({
          labelHtml: `<span class="rc-fab-label">Flight Line</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-rc-add-panel="heatline" title="Add Flight Line panel to canvas">${icons.flag(16)}</button>`,
        });
      }
      if (isOpenQualStage && !this.controlPanels.flightline.visible) {
        missingControlPanels.push({
          labelHtml: `<span class="rc-fab-label">Flight Queue</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-rc-add-panel="flightline" title="Add Flight Queue panel to canvas">${icons.zap(16)}</button>`,
        });
      }
      if (!this.controlPanels.schedule.visible) {
        missingControlPanels.push({
          labelHtml: `<span class="rc-fab-label">Heats Schedule</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-rc-add-panel="schedule" title="Add Heats Schedule panel to canvas">${icons.calendar(16)}</button>`,
        });
      }
      if (!this.controlPanels.standings.visible) {
        missingControlPanels.push({
          labelHtml: `<span class="rc-fab-label">Overall Standings</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-rc-add-panel="standings" title="Add Overall Standings panel to canvas">${icons.trophy(16)}</button>`,
        });
      }
      if (!this.controlPanels.signals.visible) {
        missingControlPanels.push({
          labelHtml: `<span class="rc-fab-label">Signal at each timer</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-rc-add-panel="signals" title="Add Signal at each timer pane to canvas">${icons.signal(16)}</button>`,
        });
      }
      if (!this.controlPanels.pilots.visible) {
        missingControlPanels.push({
          labelHtml: `<span class="rc-fab-label" data-fab-pilots-count>Pilots Roster (${checkedInCount})</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" data-rc-add-panel="pilots" title="Add Pilots Roster panel to canvas">${icons.pilot(16)}</button>`,
        });
      }

      if (missingControlPanels.length === 0) {
        rows.push({
          labelHtml: `<span class="rc-fab-label">All panels on canvas</span>`,
          btnHtml: `<button type="button" class="rc-fab-btn" disabled title="All Control panels are already visible on canvas">${icons.check(16)}</button>`,
          disabled: true,
        });
      } else {
        rows.push(...missingControlPanels);
      }
    }

    const total = rows.length;
    return rows
      .map((r, idx) => {
        const fromDial = total - 1 - idx;
        return `
          <div class="rc-fab-row ${r.disabled ? "is-disabled" : ""}" style="--from-dial:${fromDial};--from-top:${idx}">
            ${r.labelHtml}
            ${r.btnHtml}
          </div>`;
      })
      .join("");
  }

  private renderSpeedDialFab(race: RaceTournamentState, mode: WorkspaceTab): string {
    const inSubmenu = this.fabOpen && this.fabSubmenu !== "";
    const itemsHtml = this.renderSpeedDialItems(race, mode, this.fabSubmenu);
    const closedHint =
      mode === "format"
        ? "Add stage to board"
        : mode === "edit"
          ? "Add round or panel to board"
          : "Add panel to board";

    const isLocked = this.isCanvasLocked(mode);
    return `
      <div class="rc-fab-menu ${this.fabOpen ? "is-open" : ""} ${inSubmenu ? "is-submenu" : ""}" data-rc-hud ${isLocked ? "hidden" : ""}>
        <div class="rc-fab-drawer" aria-hidden="${this.fabOpen ? "false" : "true"}" ${this.fabOpen ? "" : "inert"}>
          <div class="rc-fab-items" data-fab-submenu="${this.fabSubmenu}">${itemsHtml}</div>
        </div>
        <button
          type="button"
          class="rc-fab-main"
          data-rc-ui="fab-main"
          aria-expanded="${this.fabOpen ? "true" : "false"}"
          title="${inSubmenu ? "Back" : this.fabOpen ? "Close add menu" : closedHint}"
          aria-label="${inSubmenu ? "Back" : "Add to board"}"
        >
          <span class="rc-fab-icon rc-fab-icon-plus">${icons.plus(20)}</span>
          <span class="rc-fab-icon rc-fab-icon-back">${icons.menuBack(19)}</span>
        </button>
      </div>`;
  }

  private renderCanvasFormatView(race: RaceTournamentState): string {
    const gridStep = Math.max(8, 20 * this.bktUi.zoom);
    const gx = ((this.bktUi.panX % gridStep) + gridStep) % gridStep;
    const gy = ((this.bktUi.panY % gridStep) + gridStep) % gridStep;

    return `
      ${this.renderRaceWorkspaceTopBar(race, "format")}
      <div
        class="races-canvas tool-${this.bktUi.tool} ${this.bktUi.nodesLocked ? "is-nodes-locked" : ""}"
        data-rc-viewport
        style="background-size:${gridStep}px ${gridStep}px;background-position:${gx}px ${gy}px"
      >
        ${renderSetupRaceSubRibbonHtml(race, this.renderDesktopSetupViewToggle(), true)}
        ${renderFormatMarkup(race, {
          editable: true,
          editorUi: this.bktUi,
        })}

        ${this.renderBoardControlsPill(race, "format")}
        ${this.renderSpeedDialFab(race, "format")}
      </div>`;
  }

  private renderCanvasEditView(race: RaceTournamentState): string {
    const curStage = this.getCurrentViewStage(race);
    const rootStage = isRootStage(race, curStage);

    const gridStep = Math.max(8, 20 * this.bktUi.zoom);
    const gx = ((this.bktUi.panX % gridStep) + gridStep) % gridStep;
    const gy = ((this.bktUi.panY % gridStep) + gridStep) % gridStep;

    return `
      ${this.renderRaceWorkspaceTopBar(race, "edit")}
      <div
        class="races-canvas tool-${this.bktUi.tool} ${this.bktUi.nodesLocked ? "is-nodes-locked" : ""} ${!rootStage && this.editPilotsPanel.visible ? "has-pilots-panel" : ""}"
        data-rc-viewport
        style="background-size:${gridStep}px ${gridStep}px;background-position:${gx}px ${gy}px"
      >
        ${renderSetupRaceSubRibbonHtml(race, this.renderDesktopSetupViewToggle(), true)}
        ${renderBracketMarkup(race, {
          activeHeatId: this.getControlStageHeat(race, curStage)?.id ?? "",
          stageFilter: curStage,
          interactive: true,
          editable: true,
          canvas: true,
          extraWorldHtml: this.renderPilotsCanvasPanel(race, "edit"),
          raceRoster: race.roster,
          editorUi: this.bktUi,
        })}

        ${this.renderBoardControlsPill(race, "edit")}
        ${this.renderSpeedDialFab(race, "edit")}
      </div>`;
  }

  private renderOpenQualFlightLine(
    race: RaceTournamentState,
    viewStage: number,
    curStage: RaceStage | undefined
  ): string {
    const stgSettings = curStage?.settings ?? race.config;
    const maxPacks = stgSettings.maxPacksPerPilot ?? race.config.maxPacksPerPilot ?? 0;
    const curMetric = stgSettings.qualifyingMetric || race.config.qualifyingMetric || "consecutive_3";
    const stageHeats = race.heats.filter(
      (h) => h.stageIndex === viewStage && h.state !== "aborted"
    );
    const confirmedCount = stageHeats.filter((h) => h.state === "confirmed").length;
    const allRoster = race.roster ?? [];
    const roster = allRoster.filter((p) => p.checkedIn && p.attendance === "active");
    const awayRoster = allRoster.filter((p) => p.checkedIn && p.attendance === "away");
    const inactiveRoster = allRoster.filter(
      (p) => !p.checkedIn || (p.attendance !== "active" && p.attendance !== "away")
    );
    const locked =
      race.lifecycle === "completed" ||
      race.lifecycle === "scrapped" ||
      curStage?.status === "completed";

    const standingBySlot = new Map<number, TournamentStanding>();
    const standingRows =
      race.qualStandings && race.qualStandings.length > 0
        ? race.qualStandings
        : (race.standings ?? []);
    for (const st of standingRows) {
      standingBySlot.set(st.pilotSlotIndex, st);
    }

    const pilotStats = new Map<
      number,
      {
        flownPacks: number;
        lastFlownOrder: number;
        queuedHeat?: RaceHeat;
        queuedSeat?: HeatSeat;
        liveHeat?: RaceHeat;
        lastChannel: number;
      }
    >();

    for (const p of [...roster, ...awayRoster]) {
      pilotStats.set(p.slotIndex, { flownPacks: 0, lastFlownOrder: 0, lastChannel: 0 });
    }

    for (const h of stageHeats) {
      for (const s of h.seats) {
        if (s.pilotSlotIndex <= 0 || s.status === "dns" || s.status === "dq") continue;
        const entry = pilotStats.get(s.pilotSlotIndex) ?? {
          flownPacks: 0,
          lastFlownOrder: 0,
          lastChannel: 0,
        };
        if (s.channel > 0) {
          entry.lastChannel = encodeBandChannel(s.band, s.channel) || s.channel;
        }
        if (isHeatUnstarted(h.state)) {
          if (!entry.queuedHeat) {
            entry.queuedHeat = h;
            entry.queuedSeat = s;
          }
        } else {
          entry.flownPacks++;
          if (h.order > entry.lastFlownOrder) {
            entry.lastFlownOrder = h.order;
          }
          if (h.state === "countdown" || h.state === "running" || h.state === "paused") {
            entry.liveHeat = h;
          }
        }
        pilotStats.set(s.pilotSlotIndex, entry);
      }
    }

    const sortedActiveRoster = [...roster].sort((a, b) => {
      const aSt = pilotStats.get(a.slotIndex);
      const bSt = pilotStats.get(b.slotIndex);
      const aMax = maxPacks > 0 && (aSt?.flownPacks ?? 0) >= maxPacks ? 1 : 0;
      const bMax = maxPacks > 0 && (bSt?.flownPacks ?? 0) >= maxPacks ? 1 : 0;
      if (aMax !== bMax) return aMax - bMax;
      const aOrder = aSt?.lastFlownOrder ?? 0;
      const bOrder = bSt?.lastFlownOrder ?? 0;
      if (aOrder !== bOrder) return aOrder - bOrder;
      const aFlown = aSt?.flownPacks ?? 0;
      const bFlown = bSt?.flownPacks ?? 0;
      if (aFlown !== bFlown) return aFlown - bFlown;
      return a.slotIndex - b.slotIndex;
    });

    const readyToQueueCount = sortedActiveRoster.filter((p) => {
      const st = pilotStats.get(p.slotIndex);
      if (!st || st.queuedHeat || st.liveHeat) return false;
      if (maxPacks > 0 && st.flownPacks + (st.queuedHeat ? 1 : 0) >= maxPacks) return false;
      return true;
    }).length;

    const walkupTrimmed = this.walkUpCallsign.trim();
    const walkupNeedle = walkupTrimmed.toLowerCase();
    const walkupExact = this.findExistingPilotCallsign(walkupTrimmed, race);
    let oqVisibleCount = 0;
    let awayVisibleCount = 0;

    const oqMetric =
      curStage?.settings?.qualifyingMetric || race.config.qualifyingMetric || "consecutive_3";
    const formatBestForSlot = (slotIdx: number): string => {
      const std = standingBySlot.get(slotIdx);
      return oqMetric === "consecutive_2" && std && (std.bestConsecutive2Sec ?? 0) > 0
        ? `${std.bestConsecutive2Sec!.toFixed(2)}s (2L)`
        : std && std.bestConsecutive3Sec > 0
          ? `${std.bestConsecutive3Sec.toFixed(2)}s (3L)`
          : std && (std.bestConsecutive2Sec ?? 0) > 0
            ? `${std.bestConsecutive2Sec!.toFixed(2)}s (2L)`
            : std && std.bestLapSec > 0
              ? `${std.bestLapSec.toFixed(2)}s (1L)`
              : "—";
    };

    const activeCardsHtml = sortedActiveRoster
      .map((p) => {
        const st = pilotStats.get(p.slotIndex) ?? {
          flownPacks: 0,
          lastFlownOrder: 0,
          lastChannel: 0,
        };
        const bestLabel = formatBestForSlot(p.slotIndex);
        const chText = st.lastChannel > 0 ? formatEncodedChannelShort(st.lastChannel) || `R${st.lastChannel}` : "Auto";
        const packsText =
          maxPacks > 0
            ? `${st.flownPacks}/${maxPacks}`
            : `${st.flownPacks} ${st.flownPacks === 1 ? "heat" : "heats"}`;
        const maxedOut = maxPacks > 0 && st.flownPacks >= maxPacks;
        const rowQueueState = st.queuedHeat ? "queued" : st.liveHeat ? "flying" : "ready";
        const matchesQueueFilter =
          this.flightQueueFilter === "all" || this.flightQueueFilter === rowQueueState;
        const callsignLower = p.callsign.trim().toLowerCase();
        const hay = `${p.callsign} ${p.phoneticName ?? ""} #${p.slotIndex}`.toLowerCase();
        const show = walkupNeedle ? hay.includes(walkupNeedle) : matchesQueueFilter;
        const isExact = !!walkupNeedle && callsignLower === walkupNeedle;
        if (show) oqVisibleCount++;

        const awayBtnHtml =
          !locked && !st.liveHeat
            ? `<button type="button" class="btn btn-ghost btn-xs oq-away-btn" data-att-status="away" data-slot-index="${p.slotIndex}" title="Mark ${esc(p.callsign)} away (moves to bottom of queue${st.queuedHeat ? " &amp; dequeues" : ""})">Away</button>`
            : "";

        let actionHtml = "";
        if (locked) {
          actionHtml = `<span class="race-state-pill is-done">${esc(packsText)}</span>`;
        } else if (st.queuedHeat && st.queuedSeat) {
          const qCh =
            st.queuedSeat.channelLabel ||
            formatBandChannelShort(st.queuedSeat.band, st.queuedSeat.channel) ||
            `R${st.queuedSeat.channel}`;
          actionHtml = `
            <span class="oq-queued-pill mono" title="Queued in ${esc(st.queuedHeat.title)} on ${esc(qCh)}">${esc(st.queuedHeat.shortLabel)} · ${esc(qCh)}</span>
            <button type="button" class="btn btn-ghost btn-xs" data-oq-act="dequeue" data-stage-idx="${viewStage}" data-pilot-slot="${p.slotIndex}" data-heat-id="${esc(st.queuedHeat.id)}" title="Remove from ${esc(st.queuedHeat.shortLabel)}">
              Dequeue
            </button>
            ${awayBtnHtml}`;
        } else if (st.liveHeat) {
          actionHtml = `<span class="race-state-pill is-live" title="${esc(p.callsign)} is currently flying in ${esc(st.liveHeat.title)}">Flying · ${esc(st.liveHeat.shortLabel)}</span>`;
        } else if (maxedOut) {
          actionHtml = `<span class="race-state-pill is-done">Max (${maxPacks}) ✓</span>${awayBtnHtml}`;
        } else {
          actionHtml = `
            <button type="button" class="btn btn-armed btn-xs" data-oq-act="enqueue" data-stage-idx="${viewStage}" data-pilot-slot="${p.slotIndex}" title="Queue ${esc(p.callsign)} into next non-colliding heat (sticky VTX channel)">
              ${icons.plus(11)}<span>Queue</span>
            </button>
            ${awayBtnHtml}`;
        }

        return `
          <div
            class="oq-pilot-row ${st.queuedHeat ? "is-queued" : ""} ${isExact ? "is-exact-match" : ""}"
            data-oq-pilot-slot="${p.slotIndex}"
            data-oq-row-state="${rowQueueState}"
            data-pilot-callsign="${esc(callsignLower)}"
            data-pilot-search-hay="${esc(hay)}"
            ${show ? "" : "hidden"}
          >
            <div class="oq-pilot-main">
              <span class="dot" style="--c:${p.color || "#38bdf8"}"></span>
              <strong class="oq-pilot-name">${esc(p.callsign)}</strong>
              <span class="oq-ch-badge mono" title="Sticky VTX channel">${esc(chText)}</span>
              <span class="note mono">${esc(packsText)}</span>
              <span class="oq-best-metric mono">${esc(bestLabel)}</span>
            </div>
            <div class="oq-pilot-actions">
              ${actionHtml}
            </div>
          </div>`;
      })
      .join("");

    const awayCardsHtml = awayRoster
      .map((p) => {
        const st = pilotStats.get(p.slotIndex) ?? {
          flownPacks: 0,
          lastFlownOrder: 0,
          lastChannel: 0,
        };
        const bestLabel = formatBestForSlot(p.slotIndex);
        const packsText =
          maxPacks > 0
            ? `${st.flownPacks}/${maxPacks}`
            : `${st.flownPacks} ${st.flownPacks === 1 ? "heat" : "heats"}`;
        const matchesQueueFilter =
          this.flightQueueFilter === "all" || this.flightQueueFilter === "away";
        const callsignLower = p.callsign.trim().toLowerCase();
        const hay = `${p.callsign} ${p.phoneticName ?? ""} #${p.slotIndex}`.toLowerCase();
        const show = walkupNeedle ? hay.includes(walkupNeedle) : matchesQueueFilter;
        const isExact = !!walkupNeedle && callsignLower === walkupNeedle;
        if (show) {
          oqVisibleCount++;
          awayVisibleCount++;
        }
        return `
          <div
            class="oq-pilot-row is-away-pilot ${isExact ? "is-exact-match" : ""}"
            data-oq-pilot-slot="${p.slotIndex}"
            data-oq-away-row="1"
            data-oq-row-state="away"
            data-pilot-callsign="${esc(callsignLower)}"
            data-pilot-search-hay="${esc(hay)}"
            ${show ? "" : "hidden"}
          >
            <div class="oq-pilot-main">
              <span class="dot" style="--c:${p.color || "#38bdf8"};opacity:0.55"></span>
              <strong class="oq-pilot-name">${esc(p.callsign)}</strong>
              <span class="race-state-pill is-staged">Away</span>
              <span class="note mono">${esc(packsText)}</span>
              <span class="oq-best-metric mono">${esc(bestLabel)}</span>
            </div>
            <div class="oq-pilot-actions">
              ${
                !locked
                  ? `<button type="button" class="btn btn-ghost btn-xs" data-att-status="active" data-slot-index="${p.slotIndex}" title="Mark ${esc(p.callsign)} ready for Flight Queue">
                      Ready
                    </button>`
                  : ""
              }
            </div>
          </div>`;
      })
      .join("");

    const awayDividerHtml =
      awayRoster.length > 0
        ? `<div class="oq-away-divider note" data-oq-away-divider ${awayVisibleCount > 0 && !walkupNeedle && this.flightQueueFilter === "all" ? "" : "hidden"}>Away (${awayRoster.length})</div>`
        : "";

    const inactiveCardsHtml = inactiveRoster
      .map((p) => {
        const callsignLower = p.callsign.trim().toLowerCase();
        const hay = `${p.callsign} ${p.phoneticName ?? ""} #${p.slotIndex}`.toLowerCase();
        const show = !!walkupNeedle && hay.includes(walkupNeedle);
        const isExact = !!walkupNeedle && callsignLower === walkupNeedle;
        if (show) oqVisibleCount++;
        return `
          <div
            class="oq-pilot-row is-inactive-pilot ${isExact ? "is-exact-match" : ""}"
            data-oq-pilot-slot="${p.slotIndex}"
            data-oq-inactive-row="1"
            data-oq-row-state="inactive"
            data-pilot-callsign="${esc(callsignLower)}"
            data-pilot-search-hay="${esc(hay)}"
            ${show ? "" : "hidden"}
          >
            <div class="oq-pilot-main">
              <span class="dot" style="--c:${p.color || "#38bdf8"};opacity:0.55"></span>
              <strong class="oq-pilot-name">${esc(p.callsign)}</strong>
              <span class="note">Not checked in</span>
            </div>
            <div class="oq-pilot-actions">
              ${
                !locked
                  ? `<button type="button" class="btn btn-ghost btn-xs" data-att-status="active" data-slot-index="${p.slotIndex}" title="Check in ${esc(p.callsign)}">
                      Check In
                    </button>`
                  : ""
              }
            </div>
          </div>`;
      })
      .join("");

    const emptyNoteText = walkupTrimmed
      ? `No existing pilots match “${walkupTrimmed}” — click Add to register.`
      : this.flightQueueFilter === "queued"
        ? "No pilots currently queued."
        : this.flightQueueFilter === "flying"
          ? "No pilots currently flying."
          : this.flightQueueFilter === "away"
            ? "No pilots marked away."
            : "No checked-in active pilots yet — check pilots in or add a pilot above.";
    const cardsHtml = `${activeCardsHtml}${awayDividerHtml}${awayCardsHtml}${inactiveCardsHtml}<div class="note" data-oq-walkup-empty style="padding:10px 4px" ${oqVisibleCount > 0 ? "hidden" : ""}>${esc(emptyNoteText)}</div>`;

    return `
      <div class="oq-flightline-box" data-open-qual-flightline="${viewStage}">
        <div class="oq-flightline-head rc-hide-mobile">
          <div class="oq-flightline-meta" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span class="note">${esc(formatQualifyingMetricLabel(curMetric))}</span>
            ${
              !locked
                ? `<button type="button" class="btn btn-ghost btn-xs" data-oq-act="open_settings" data-stage-idx="${viewStage}" title="Set maximum heats per pilot and Open Qualifier rules">
                    ${icons.sliders(12)}<span>${maxPacks > 0 ? `Max ${maxPacks} heats/pilot` : "Max heats: Unlimited"}</span>
                  </button>`
                : `<span class="note">· ${maxPacks > 0 ? `Max ${maxPacks} heats/pilot` : "Unlimited heats"}</span>`
            }
          </div>
          <div class="oq-flightline-btns">
            ${
              !locked
                ? `<button type="button" class="btn btn-armed btn-xs" data-oq-act="enqueue_all" data-stage-idx="${viewStage}" ${readyToQueueCount === 0 ? "disabled" : ""} title="Queue one heat for every unqueued active pilot">
                    ${icons.zap(12)}<span>Queue All Ready${readyToQueueCount > 0 ? ` (${readyToQueueCount})` : ""}</span>
                  </button>`
                : ""
            }
          </div>
        </div>
        ${
          !locked
            ? `<div class="rc-pilots-search-bar oq-search-add-bar">
                <div class="rc-pilots-search-row">
                  ${icons.search(13)}
                  <input
                    type="search"
                    class="input input-sm rc-pilots-search-input"
                    data-race-field="walkup-callsign"
                    placeholder="Search or add pilot..."
                    value="${esc(this.walkUpCallsign)}"
                    autocomplete="off"
                    aria-label="Search or add pilot"
                  />
                </div>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs bkt-pilots-add-btn"
                  data-race-act="submit-walkup"
                  ${!walkupTrimmed || !!walkupExact ? "disabled" : ""}
                  title="${esc(
                    walkupExact
                      ? `Pilot “${walkupExact}” is already in roster`
                      : walkupTrimmed
                        ? `Add pilot “${walkupTrimmed}”`
                        : "Search or type a unique callsign to add"
                  )}"
                >
                  ${icons.plus(12)}<span>Add</span>
                </button>
              </div>`
            : ""
        }
        <div class="oq-flightline-list" data-preserve-scroll="oq-flightline-${viewStage}">
          ${cardsHtml}
        </div>
      </div>`;
  }

  private renderControlFlightLinePanel(race: RaceTournamentState): string {
    const viewStage = this.getCurrentViewStage(race);
    const stages = resolveStagesList(race);
    const curStage = stages.find((s) => s.index === viewStage);
    if (!hasOpenQualifierRound(race)) return "";

    const multiStage = stages.length > 1;
    const panelTitle = multiStage ? `S${viewStage} Flight Queue` : "Flight Queue";

    return `
      <section
        class="rc-canvas-panel rc-page-card is-flightline-panel"
        data-canvas-panel="flightline"
        data-mobile-ctrl-pane="queue"
      >
        <header class="rc-panel-header">
          <div class="rc-panel-title-wrap rc-hide-mobile">
            ${icons.zap(14)}
            <strong>${esc(panelTitle)}</strong>
          </div>
          <div class="rc-panel-actions">
            <div class="segmented rc-panel-seg" role="group" aria-label="Filter flight queue">
              <button type="button" class="${this.flightQueueFilter === "all" ? "is-active" : ""}" data-oq-queue-filter="all">All</button>
              <button type="button" class="${this.flightQueueFilter === "queued" ? "is-active" : ""}" data-oq-queue-filter="queued">Queued</button>
              <button type="button" class="${this.flightQueueFilter === "flying" ? "is-active" : ""}" data-oq-queue-filter="flying">Flying</button>
              <button type="button" class="${this.flightQueueFilter === "away" ? "is-active" : ""}" data-oq-queue-filter="away">Away</button>
            </div>
            <button type="button" class="rc-panel-icon-btn rc-hide-mobile" data-race-act="export-csv" data-stage-idx="${viewStage}" title="Download Open Qualifier CSV" aria-label="Export CSV">
              ${icons.download(13)}
            </button>
          </div>
        </header>
        <div class="rc-panel-body is-flightline-body">
          ${this.renderOpenQualFlightLine(race, viewStage, curStage)}
        </div>
      </section>`;
  }

  private renderControllerInfoStrip(
    race: RaceTournamentState,
    heat: RaceHeat | undefined,
    curStage: RaceStage | undefined,
    stages: RaceStage[]
  ): string {
    const lifecycle: RaceLifecycle = race.lifecycle ?? (race.isComplete ? "completed" : "draft");
    const otherOngoingRace = this.getEffectiveRaces().find(
      (r) => r.raceId && r.raceId !== race.raceId && isRaceOngoing(r)
    );

    let textHtml = "";
    let mobileTextHtml = "";
    let spokenText = "";

    const pilotVoiceName = (s: HeatSeat): string => {
      const rp = (race.roster ?? []).find((p) => p.slotIndex === s.pilotSlotIndex);
      const gp = this.store.pilots.find((p) => p.slotIndex === s.pilotSlotIndex);
      const phonetic = rp?.phoneticName?.trim() || gp?.phoneticName?.trim();
      return phonetic || s.callsign;
    };

    const activePractice =
      this.store.activePracticeSession && !this.store.activePracticeSession.paused
        ? this.store.activePracticeSession
        : null;

    if (curStage?.dangling) {
      textHtml = `<strong>Stage ${curStage.index} (${esc(curStage.title)})</strong> is disconnected — ${esc(curStage.danglingReason || "connect an upstream stage in Format before starting heats.")}`;
      mobileTextHtml = `Stage ${curStage.index} is disconnected.`;
    } else if (curStage && !curStage.prerequisitesMet) {
      const firstUpIdx =
        (curStage.waitingOnStageIds ?? [])
          .map((id) => stages.find((s) => s.id === id)?.index)
          .find((idx): idx is number => typeof idx === "number" && idx >= 1) || 1;
      const waitNames = (curStage.waitingOnStageNames ?? []).join(", ") || `Stage ${firstUpIdx}`;
      textHtml = `Waiting on <strong>${esc(waitNames)}</strong> — complete upstream heats to populate Stage ${curStage.index} seeds.`;
      mobileTextHtml = `Waiting on <strong>${esc(waitNames)}</strong>.`;
    } else if (curStage?.status === "paused") {
      textHtml = `<strong>Stage ${curStage.index} (${esc(curStage.title)})</strong> is paused — resume stage from <strong>Format</strong> when ready to run heats.`;
      mobileTextHtml = `Stage ${curStage.index} is paused.`;
    } else if (curStage?.status === "completed" && lifecycle !== "completed" && lifecycle !== "scrapped" && !race.isComplete) {
      textHtml = `<strong>${esc(curStage.title || `Stage ${curStage.index}`)}</strong> is closed — standings locked.`;
      mobileTextHtml = `Stage closed — standings locked.`;
    } else if (race.emergencyStopped) {
      textHtml = `<strong>Emergency Stop:</strong> Land immediately — switch to <strong>Active</strong> or <strong>Paused</strong> above when track is clear.`;
      mobileTextHtml = `Announce emergency stop`;
      spokenText = "Emergency stop, land immediately.";
    } else if (lifecycle === "paused") {
      textHtml = `Race paused${race.statusReason ? ` (${esc(race.statusReason)})` : ""} — switch to <strong>Active</strong> above when ready to continue.`;
      mobileTextHtml = `Announce race paused`;
      spokenText = "Race paused. Stand by.";
    } else if (lifecycle === "completed" || lifecycle === "scrapped" || race.isComplete) {
      textHtml =
        lifecycle === "scrapped"
          ? `Race stopped — click <strong>Reopen Race</strong> above to unlock.`
          : `All heats finalized${race.championCallsign ? ` · #1 <strong>${esc(race.championCallsign)}</strong>` : ""} — click <strong>Reopen Race</strong> above to make adjustments.`;
      mobileTextHtml =
        lifecycle === "scrapped"
          ? `Race stopped.`
          : race.championCallsign
            ? `Announce tournament winner (${esc(race.championCallsign)})`
            : `All heats finalized.`;
      if (lifecycle !== "scrapped" && race.championCallsign) {
        spokenText = `Tournament complete. First place, ${race.championCallsign}.`;
      }
    } else if (!heat) {
      textHtml = `No heats queued yet — configure stages or queue pilots from Flight Queue.`;
      mobileTextHtml = `No heats queued yet.`;
    } else {
      const activeSeats = heat.seats.filter(
        (s) => s.pilotSlotIndex > 0 && s.status !== "dns" && s.status !== "dq"
      );
      const changedSeats = activeSeats.filter((s) => s.channelChanged);

      if (changedSeats.length > 0 && (heat.state === "ready" || heat.state === "staged")) {
        const switches = changedSeats
          .map((s) => {
            const curCh = formatBandChannelShort(s.band, s.channel) || `R${s.channel}`;
            const prevCh = s.prevChannel ? formatEncodedChannelShort(s.prevChannel) : "";
            return `<strong>${esc(s.callsign)}</strong> switch to <strong>${esc(curCh)}</strong> (${prevCh ? `from ${esc(prevCh)}` : `${s.frequencyMhz}`})`;
          })
          .join(" · ");
        textHtml = `Announce VTX channel switch: ${switches}`;
        mobileTextHtml = `Announce VTX channel switch`;
        spokenText = `Attention pilots. ${changedSeats
          .map((s) => `${pilotVoiceName(s)}, switch to ${formatSeatVoiceChannel(s.band, s.channel)}`)
          .join(". ")}.`;
      } else if (heat.state === "countdown") {
        textHtml = `Countdown active — announce pilots arm on assigned channels.`;
        mobileTextHtml = `Announce pilots to arm quads`;
        spokenText = "Pilots, arm your quads.";
      } else if (heat.state === "running") {
        const allFinished =
          activeSeats.length > 0 && activeSeats.every((s) => s.status === "finished" || s.status === "dnf");
        if (heat.inOvertime) {
          textHtml = `Time expired (overtime) — announce pilots finish current lap, or click <strong>Finish Heat</strong>.`;
          mobileTextHtml = `Announce overtime (finish lap &amp; land)`;
          spokenText = "Time expired, finish your lap and land.";
        } else if (allFinished) {
          textHtml = `All active pilots finished target laps — click <strong>Finish Heat</strong> to review &amp; confirm.`;
          mobileTextHtml = `Announce all pilots finished`;
          spokenText = "All pilots finished, land and disarm.";
        } else {
          const lineList = activeSeats
            .map((s) => esc(s.callsign))
            .join(" · ");
          textHtml = `Live on track: ${lineList || "Monitoring RF channels"}`;
          mobileTextHtml = activeSeats.length > 0 ? `Announce pilots on track` : `Monitoring RF channels`;
          if (activeSeats.length > 0) {
            spokenText = `Live on track: ${activeSeats
              .map((s) => pilotVoiceName(s))
              .join(", ")}.`;
          }
        }
      } else if (heat.state === "paused") {
        textHtml = `Heat paused — announce pilots hold or disarm; click <strong>Resume Heat</strong>, <strong>Finish Heat</strong>, or <strong>Re-run Heat</strong>.`;
        mobileTextHtml = `Announce heat paused (hold or disarm)`;
        spokenText = "Heat paused. Pilots hold or disarm.";
      } else if (heat.state === "finished") {
        textHtml = `Heat finished — announce pilots land &amp; disarm, verify laps below, then click <strong>Confirm Heat</strong>.`;
        mobileTextHtml = `Announce heat finished (land &amp; disarm)`;
        spokenText = "Heat finished, land and disarm.";
      } else if (heat.state === "confirmed") {
        const nextReadyId = this.getNextReadyStageHeatId(race, heat);
        if (nextReadyId) {
          const nextHeatObj = race.heats.find((h) => h.id === nextReadyId);
          textHtml = `Results confirmed — click <strong>Next Heat</strong>${nextHeatObj?.shortLabel ? ` (${esc(nextHeatObj.shortLabel)})` : ""} or select a heat in <strong>Heats Schedule</strong>.`;
          mobileTextHtml = `Results confirmed · ready for ${esc(nextHeatObj?.shortLabel || "next heat")}`;
        } else if (curStage?.format === "open_qualifier") {
          textHtml = `Results confirmed — waiting for pilots to be queued in <strong>Flight Queue</strong>.`;
          mobileTextHtml = `Results confirmed · queue pilots in Queue`;
        } else {
          const stageHeats = race.heats.filter(
            (h) => h.stageIndex === heat.stageIndex && h.state !== "aborted"
          );
          if (stageHeats.length > 0 && stageHeats.every((h) => h.state === "confirmed")) {
            textHtml = `Results confirmed — all heats in <strong>${esc(curStage?.title || `Stage ${heat.stageIndex}`)}</strong> are complete.`;
            mobileTextHtml = `Results confirmed · stage complete`;
          } else {
            textHtml = `Results confirmed — select a heat in <strong>Heats Schedule</strong>.`;
            mobileTextHtml = `Results confirmed · select heat in Schedule`;
          }
        }
      } else if (activeSeats.length > 0) {
        const lineList = activeSeats
          .map((s) => `<strong>${esc(s.callsign)}</strong> (${esc(formatBandChannelShort(s.band, s.channel) || `R${s.channel}`)})`)
          .join(" · ");
        textHtml = `Call to flight line: ${lineList}`;
        mobileTextHtml = `Call pilots to flight line`;
        spokenText = `Flight line call for ${formatSpokenHeatLabel(heat)}. ${activeSeats
          .map((s) => `${pilotVoiceName(s)} on ${formatSeatVoiceChannel(s.band, s.channel)}`)
          .join(", ")}.`;
      } else {
        textHtml = `Waiting on upstream feeder heats to advance pilots into ${esc(heat.shortLabel || heat.title)}.`;
        mobileTextHtml = `Waiting on upstream feeder heats`;
      }
    }

    const canSpeak = Boolean(spokenText && this.announcer?.supported && this.announcer.settings.enabled);
    const speakBtnHtml = canSpeak
      ? `<button
          type="button"
          class="race-controller-strip-speak-btn"
          data-announce-speak="${esc(spokenText)}"
          title="Play announcement: ${esc(spokenText)}"
          aria-label="Play announcement"
        >
          ${icons.playWaves(16)}
        </button>`
      : "";

    return `
      <div class="race-controller-strip" data-race-controller-strip>
        ${speakBtnHtml}
        <span class="race-controller-strip-text"><span class="rc-lbl-full">${textHtml}</span><span class="rc-lbl-short">${mobileTextHtml || textHtml}</span></span>
      </div>`;
  }

  private renderRaceLifecycleHeaderControls(
    race: RaceTournamentState,
    curStage?: RaceStage
  ): string {
    const lifecycle: RaceLifecycle = race.lifecycle ?? (race.isComplete ? "completed" : "draft");
    const configured = isRaceConfigured(race);
    const isEmergency = Boolean(race.emergencyStopped);
    const isPaused = !isEmergency && lifecycle === "paused";
    const isActive = !isEmergency && !isPaused && configured && isRaceOngoing(race);

    if (lifecycle === "completed" || lifecycle === "scrapped" || race.isComplete) {
      return `
        <span class="race-state-pill ${lifecycle === "scrapped" ? "is-stopped" : "is-done"}"><span>${lifecycle === "scrapped" ? "Stopped" : "Completed"}</span></span>
        <button type="button" class="btn btn-ghost btn-xs" data-race-act="lifecycle-direct" data-lifecycle-act="reopen_race" title="Reopen race">
          ${icons.unlock(13)}<span>Reopen Race</span>
        </button>`;
    }
    if (configured) {
      const activateAct = lifecycle === "paused" || isEmergency ? "resume_race" : "start_race";
      const stageIdx = curStage?.index ?? (race.activeStageIndex || 1);
      const stageAlreadyDone = curStage?.status === "completed";
      const stageHeats = race.heats.filter(
        (h) => h.stageIndex === stageIdx && h.state !== "aborted"
      );
      const confirmedStageCount = stageHeats.filter((h) => h.state === "confirmed").length;
      const hasLiveStageHeat = stageHeats.some(
        (h) => h.state === "countdown" || h.state === "running"
      );
      const closeDisabled = confirmedStageCount === 0 || hasLiveStageHeat;
      const closeStageTitle = hasLiveStageHeat
        ? "Finish or pause the live heat before ending this race"
        : confirmedStageCount === 0
          ? "Confirm at least one heat before ending this race"
          : `End ${race.config.eventName || "race"}`;
      const canReopenStage = Boolean(
        stageAlreadyDone &&
          curStage?.completedEarly &&
          !anyDownstreamStageStarted(race, stageIdx)
      );
      const closeStageBtnHtml = !stageAlreadyDone
        ? `<button
            type="button"
            class="btn btn-ghost rc-close-stage-btn"
            data-race-act="close-stage-modal"
            data-stage-idx="${stageIdx}"
            ${closeDisabled ? "disabled" : ""}
            title="${esc(closeStageTitle)}"
          >
            <span>End Race</span>
          </button>`
        : canReopenStage
          ? `<button
              type="button"
              class="btn btn-ghost rc-close-stage-btn"
              data-stage-ctrl="reopen_stage_early"
              data-stage-idx="${stageIdx}"
              data-stage-id="${esc(curStage?.id || "")}"
              title="Reopen ${esc(race.config.eventName || "race")} to continue running heats"
            >
              ${icons.unlock(15)}<span>Reopen Race</span>
            </button>`
          : "";
      return `
        ${closeStageBtnHtml}
        <div class="rc-lifecycle-seg" role="group" aria-label="Race lifecycle">
          <button
            type="button"
            class="rc-lifecycle-btn is-opt-active ${isActive ? "is-active" : ""}"
            data-race-act="lifecycle-direct"
            data-lifecycle-act="${activateAct}"
            aria-pressed="${isActive ? "true" : "false"}"
            title="Set race Active (ready to run heats)"
          >Active</button>
          <button
            type="button"
            class="rc-lifecycle-btn is-opt-paused ${isPaused ? "is-active" : ""}"
            data-race-act="lifecycle-direct"
            data-lifecycle-act="pause_race"
            aria-pressed="${isPaused ? "true" : "false"}"
            title="Pause race and disarm RF channels"
          >Paused</button>
          <button
            type="button"
            class="rc-lifecycle-btn is-opt-emergency ${isEmergency ? "is-active" : ""}"
            data-race-act="lifecycle-direct"
            data-lifecycle-act="emergency_stop"
            aria-pressed="${isEmergency ? "true" : "false"}"
            title="Emergency stop — immediately abort live heat and disarm RF channels"
          >Emergency</button>
        </div>`;
    }
    return `<span class="note">Draft</span>`;
  }

  private getNextReadyStageHeatId(race: RaceTournamentState, heat: RaceHeat): string {
    const stagesList = resolveStagesList(race);
    const heatStageObj = stagesList.find((s) => s.index === heat.stageIndex);
    const stageClosed = heatStageObj?.status === "completed";
    const stagePaused = heatStageObj?.status === "paused";
    const stageDepBlocked = Boolean(
      heatStageObj && (heatStageObj.dangling || !heatStageObj.prerequisitesMet)
    );
    const raceBlocked =
      Boolean(race.emergencyStopped) ||
      race.lifecycle === "scrapped" ||
      race.lifecycle === "completed" ||
      Boolean(race.isComplete);
    if (raceBlocked || stageClosed || stagePaused || stageDepBlocked) {
      return "";
    }
    const sameStageReady = race.heats.find(
      (h) =>
        h.stageIndex === heat.stageIndex &&
        h.id !== heat.id &&
        (h.state === "ready" || h.state === "staged")
    )?.id;
    if (sameStageReady) {
      return sameStageReady;
    }
    if (race.nextReadyHeatId && race.nextReadyHeatId !== heat.id) {
      const nextObj = race.heats.find((h) => h.id === race.nextReadyHeatId);
      if (nextObj && nextObj.stageIndex === heat.stageIndex) {
        return nextObj.id;
      }
    }
    return "";
  }

  private renderCockpitStatusNotice(
    race: RaceTournamentState,
    heat: RaceHeat | undefined,
    curStage: RaceStage | undefined,
    stages: RaceStage[]
  ): string {
    const lifecycle: RaceLifecycle = race.lifecycle ?? (race.isComplete ? "completed" : "draft");
    let noticeHtml = "";
    let toneCls = "";

    if (race.emergencyStopped) {
      noticeHtml = `Emergency Stop is active — mark the race as <strong>Active</strong> above when the track is clear to continue running heats.`;
      toneCls = "is-danger";
    } else if (lifecycle === "scrapped") {
      noticeHtml = `This race is stopped — click <strong>Reopen Race</strong> above to continue running heats.`;
    } else if (lifecycle === "completed" || race.isComplete) {
      if (curStage?.completedEarly) {
        noticeHtml = `This race is completed — click <strong>Reopen Race</strong> above to reopen the race and continue running heats.`;
      } else if (!race.championCallsign) {
        noticeHtml = `This race is completed — click <strong>Reopen Race</strong> above to continue running heats or make adjustments.`;
      }
    } else if (curStage?.status === "completed") {
      const canReopenStage = Boolean(
        curStage.completedEarly && !anyDownstreamStageStarted(race, curStage.index)
      );
      noticeHtml = canReopenStage
        ? `This race is completed — click <strong>Reopen Race</strong> above to continue running heats.`
        : `This race is completed — reopen the race in <strong>Setup</strong> to continue running heats.`;
    } else if (curStage?.dangling) {
      noticeHtml = `<strong>Stage ${curStage.index} (${esc(curStage.title)})</strong> is disconnected — ${esc(curStage.danglingReason || "connect an upstream stage in Format to continue running heats.")}`;
      toneCls = "is-warn";
    } else if (curStage && !curStage.prerequisitesMet) {
      const firstUpIdx =
        (curStage.waitingOnStageIds ?? [])
          .map((id) => stages.find((s) => s.id === id)?.index)
          .find((idx): idx is number => typeof idx === "number" && idx >= 1) || 1;
      const waitNames = (curStage.waitingOnStageNames ?? []).join(", ") || `Stage ${firstUpIdx}`;
      noticeHtml = `Waiting on <strong>${esc(waitNames)}</strong> — complete upstream heats before running heats in Stage ${curStage.index}.`;
    } else if (curStage?.status === "paused") {
      noticeHtml = `This stage is paused — resume <strong>${esc(curStage.title || `Stage ${curStage.index}`)}</strong> in <strong>Format</strong> to continue running heats.`;
    } else if (lifecycle === "paused") {
      const customReason =
        race.statusReason && race.statusReason.trim() && race.statusReason.trim() !== "Race paused"
          ? race.statusReason.trim()
          : "";
      noticeHtml = `Race is paused${customReason ? ` (${esc(customReason)})` : ""} — mark the race as <strong>Active</strong> above to continue running heats.`;
    } else if (!heat) {
      if (curStage?.format === "open_qualifier") {
        noticeHtml = `Please queue up pilots in <strong>Flight Queue</strong> to stage a heat.`;
      } else if (isRaceConfigured(race)) {
        noticeHtml = `No heats are scheduled in this stage - click <strong>Setup</strong> to add rounds or heats.`;
      }
    } else if (heat.state === "waiting") {
      noticeHtml = `This heat is waiting on upstream feeder heats to finish before pilots are seated.`;
    } else if (heat.state === "ready" || heat.state === "staged") {
      const otherLive = race.heats.find(
        (o) =>
          o.id !== heat.id &&
          (o.state === "countdown" ||
            o.state === "running" ||
            (o.stageIndex === heat.stageIndex && o.state === "paused"))
      );
      const hasFilledPilot = heat.seats.some(
        (s) => s.pilotSlotIndex > 0 && s.status !== "dq" && s.status !== "dns"
      );
      if (otherLive) {
        noticeHtml = `Another heat (<strong>${esc(otherLive.shortLabel || otherLive.title)}</strong>) is currently in progress — finish or pause it before starting this heat.`;
      } else if (!hasFilledPilot) {
        noticeHtml = `No active pilots are seated in this heat — assign or advance at least one active pilot to start the heat.`;
      }
    } else if (heat.state === "confirmed") {
      const nextReadyId = this.getNextReadyStageHeatId(race, heat);
      if (!nextReadyId) {
        const stageHeats = race.heats.filter(
          (h) => h.stageIndex === heat.stageIndex && h.state !== "aborted"
        );
        const confirmedStageCount = stageHeats.filter((h) => h.state === "confirmed").length;
        if (curStage?.format === "open_qualifier") {
          const maxPacks = curStage.settings?.maxPacksPerPilot ?? race.config.maxPacksPerPilot ?? 0;
          const activeRoster = (race.roster ?? []).filter(
            (p) => p.checkedIn && p.attendance === "active"
          );
          const allMaxedOut =
            maxPacks > 0 &&
            activeRoster.length > 0 &&
            activeRoster.every((p) => {
              const flown = stageHeats.filter(
                (h) =>
                  h.state === "confirmed" &&
                  h.seats.some(
                    (s) => s.pilotSlotIndex === p.slotIndex && s.status !== "dns" && s.status !== "dq"
                  )
              ).length;
              return flown >= maxPacks;
            });
          if (allMaxedOut) {
            noticeHtml = `All active pilots have completed their maximum heats (${maxPacks}) — add more pilots or click <strong>End Race</strong> above to finish qualifying.`;
          } else {
            noticeHtml = `Please queue up more pilots in <strong>Flight Queue</strong> to stage the next heat${confirmedStageCount > 0 ? `, or click <strong>End Race</strong> above when qualifying is done` : ""}.`;
          }
        } else {
          const reviewHeat = stageHeats.find((h) => h.state === "finished");
          const hasWaiting = stageHeats.some((h) => h.state === "waiting");
          if (reviewHeat) {
            noticeHtml = `Confirm <strong>${esc(reviewHeat.shortLabel || reviewHeat.title)}</strong> in <strong>Heats Schedule</strong> to advance this race.`;
          } else if (hasWaiting) {
            noticeHtml = `Remaining heats are waiting on upstream feeder heats or pilot assignments.`;
          } else {
            noticeHtml = `All heats are confirmed — click <strong>End Race</strong> above to finalize this race.`;
          }
        }
      }
    }

    if (!noticeHtml) {
      return `
      <div class="race-cockpit-notice is-placeholder" data-race-cockpit-notice role="status" aria-hidden="true">
        <span class="race-cockpit-notice-icon">${icons.info(15)}</span>
        <span class="race-cockpit-notice-text">&nbsp;</span>
      </div>`;
    }

    return `
      <div class="race-cockpit-notice ${toneCls}" data-race-cockpit-notice role="status">
        <span class="race-cockpit-notice-icon" aria-hidden="true">${icons.info(15)}</span>
        <span class="race-cockpit-notice-text">${noticeHtml}</span>
      </div>`;
  }

  private renderControlCockpitPanel(race: RaceTournamentState): string {
    const p = this.controlPanels.cockpit;

    const viewStage = this.getCurrentViewStage(race);
    const stages = resolveStagesList(race);
    const curStage = stages.find((s) => s.index === viewStage);

    const heat = this.getControlStageHeat(race, viewStage);
    const lifecycleHeaderHtml = this.renderRaceLifecycleHeaderControls(race, curStage);
    const controllerStripHtml = this.renderControllerInfoStrip(race, heat, curStage, stages);
    const cockpitNoticeHtml = this.renderCockpitStatusNotice(race, heat, curStage, stages);

    if (!heat) {
      const configured = isRaceConfigured(race);
      const isOpenQualStage = curStage?.format === "open_qualifier";
      const activeCount = (race.roster ?? []).filter(
        (pt) => pt.checkedIn && pt.attendance === "active"
      ).length;
      const trackInfo = this.store.raceNodes(race);
      const gateCount = trackInfo.nodes.length;
      const gateSummary = gateCount <= 1 ? "1 timer (Start / Finish)" : `${gateCount} gates`;
      const emptyBodyHtml = p.collapsed
        ? ""
        : `<div class="rc-panel-body is-cockpit-body">
            ${
              isOpenQualStage
                ? `<div class="race-empty-state" style="padding:22px 16px">
                    <p style="margin:0 0 10px"><strong>${esc(curStage?.title || "Open Qualifier")}</strong> Flight Queue is ready. Queue heats on demand in the <strong>Flight Queue</strong> panel or click <strong>Queue All Ready</strong> to build initial staggered-start heats with sticky VTX channels.</p>
                    <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
                      <button type="button" class="btn btn-armed btn-sm" data-oq-act="enqueue_all" data-stage-idx="${viewStage}" ${activeCount === 0 ? "disabled" : ""}>
                        ${icons.zap(14)}<span>Queue All Ready (${activeCount})</span>
                      </button>
                      <button type="button" class="btn btn-ghost btn-sm" data-race-act="export-csv" data-stage-idx="${viewStage}">
                        ${icons.download(14)}<span>Export CSV</span>
                      </button>
                    </div>
                  </div>`
                : !configured
                  ? `<div class="race-run-onboarding" data-race-setup-checklist>
                      <div class="race-run-onboarding-head">
                        <strong>Set up ${esc(race.config.eventName || "this race")} to start running heats</strong>
                        <span>Complete these 3 quick steps before staging your first heat:</span>
                      </div>
                      <div class="race-run-onboarding-steps">
                        <div class="race-run-step-row">
                          <div class="race-run-step-copy">
                            <span class="race-run-step-num">1</span>
                            <div>
                              <strong>Check In Pilots</strong>
                              <span>${activeCount} active pilot${activeCount === 1 ? "" : "s"} checked in</span>
                            </div>
                          </div>
                          <button type="button" class="btn btn-ghost btn-xs" data-race-tab="pilots">${icons.pilot(13)}<span>Pilots</span></button>
                        </div>
                        <div class="race-run-step-row">
                          <div class="race-run-step-copy">
                            <span class="race-run-step-num">2</span>
                            <div>
                              <strong>Confirm Track</strong>
                              <span>${esc(gateSummary)}</span>
                            </div>
                          </div>
                          <button type="button" class="btn btn-ghost btn-xs" data-race-tab="track">${icons.gate(13)}<span>Track</span></button>
                        </div>
                        <div class="race-run-step-row is-primary">
                          <div class="race-run-step-copy">
                            <span class="race-run-step-num">3</span>
                            <div>
                              <strong>Pick Format &amp; Generate Heats</strong>
                              <span>Choose Qualifying, Mains, or Bracket in Setup</span>
                            </div>
                          </div>
                          <button type="button" class="btn btn-armed btn-xs" data-race-tab="edit">${icons.settings(13)}<span>Setup →</span></button>
                        </div>
                      </div>
                    </div>`
                  : `<div class="race-empty-state" style="padding:24px 16px">
                      <p style="margin:0 0 10px">No heats scheduled yet for <strong>${esc(race.config.eventName || "this race")}</strong>. Click <strong>Setup</strong> to pick a tournament template or add rounds.</p>
                      <div style="display:flex;gap:8px;justify-content:center">
                        <button type="button" class="btn btn-armed btn-sm" data-race-tab="format">
                          ${icons.settings(14)}<span>Setup</span>
                        </button>
                      </div>
                    </div>`
            }
            ${cockpitNoticeHtml}
            <div class="race-cockpit-bottom">
              <div></div>
              ${controllerStripHtml}
            </div>
          </div>`;

      return `
        <section
          class="rc-canvas-panel rc-page-card is-cockpit-panel"
          data-canvas-panel="cockpit"
          data-mobile-ctrl-pane="live"
        >
          <header class="rc-panel-header">
            <div class="rc-panel-title-wrap rc-hide-mobile">
              ${icons.checkered(14)}
              <strong>Race Control</strong>
              <span class="badge">No heats</span>
            </div>
            <div class="rc-panel-actions">
              ${lifecycleHeaderHtml}
            </div>
          </header>
          ${emptyBodyHtml}
        </section>`;
    }

    const confirmedCount = race.heats.filter(
      (h) => h.state === "confirmed" && h.note !== "Auto-advance (bye)"
    ).length;
    const effectiveBadge = race.emergencyStopped
      ? { label: "Stopped", cls: "is-stopped" }
      : heatStateBadge(heat.state, heat.inOvertime, heat.note);
    const cockpitStateCls = race.emergencyStopped ? "aborted" : heat.state;
    const maxCountdownSec = Math.max(
      1,
      heat.countdownDurationSec || race.config.countdownSec || 5
    );
    const initialIsArming =
      heat.state === "countdown" &&
      (Number(heat.countdownArmRemainingSec ?? 0) > 0 ||
        Boolean(
          heat.countdownStartUs &&
            this.store.liveServerTimestampUs > 0 &&
            this.store.liveServerTimestampUs < heat.countdownStartUs
        ));
    const initialCountdownDisplaySec = initialIsArming
      ? maxCountdownSec
      : Math.max(
          0,
          Math.min(maxCountdownSec, Number(heat.countdownRemainingSec ?? maxCountdownSec))
        );
    const stagePrefix =
      stages.length > 1 && curStage ? `Stage ${curStage.index}: ${esc(curStage.title)} · ` : "";
    const clockStateCls = race.emergencyStopped
      ? "is-stopped"
      : heat.state === "countdown"
        ? "is-countdown"
        : heat.state === "running"
          ? heat.inOvertime
            ? "is-overtime"
            : "is-running"
          : "";
    const limitStr = heat.timeLimitSec > 0 ? ` / ${formatRaceClock(heat.timeLimitSec)}` : "";
    const lapsStr = heat.targetLaps > 0 ? `${heat.targetLaps} laps` : "Timed";
    const initialClockSub =
      heat.state === "countdown"
        ? initialIsArming
          ? "Arming quads…"
          : ""
        : race.emergencyStopped
          ? "Aborted · RF disarmed"
          : race.lifecycle === "paused"
            ? "Race paused · RF safe"
            : heat.inOvertime
              ? `Overtime · Finish current lap${limitStr}`
              : `${lapsStr}${limitStr}`;
    const initialPct =
      heat.state === "countdown" || heat.timeLimitSec <= 0
        ? 0
        : Math.max(0, Math.min(100, (heat.elapsedSec / heat.timeLimitSec) * 100));
    const stageFmt = resolveHeatStageFormat(heat, race) || curStage?.format || "";
    const isQualHeat = isQualifierStageFormat(stageFmt);
    const announcerEnabled = this.announcer ? Boolean(this.announcer.settings.enabled) : true;
    const lapCalloutsOn =
      announcerEnabled &&
      (this.announcer ? this.announcer.isLapCalloutsActiveForStage(stageFmt) : isQualHeat);
    const lapCalloutsTitle = !announcerEnabled
      ? "Enable Voice Announcer to toggle lap timing announcements"
      : lapCalloutsOn
        ? `Lap timing announcements on (${isQualHeat ? "Qualifier" : "Race"}) — click to turn off`
        : `Lap timing announcements off (${isQualHeat ? "Qualifier" : "Race"}) — click to turn on`;

    const rawHeatTitle = (heat.title || heat.shortLabel || "Heat").trim();
    const parenMatch = rawHeatTitle.match(/\(([^)]+)\)\s*$/);
    const parenRule = parenMatch ? parenMatch[1].trim() : "";
    let mobileHeatTitle = rawHeatTitle.replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (mobileHeatTitle.length > 16) {
      mobileHeatTitle = mobileHeatTitle
        .replace(/\bChase\s+the\s+Ace\s+Finals\b/gi, "Finals")
        .replace(/\bWinners\s+Round\s+(\d+)\b/gi, "Winners R$1")
        .replace(/\bLosers\s+Round\s+(\d+)\b/gi, "Losers R$1")
        .replace(/\bQualifier\s+Round\s+(\d+)\b/gi, "Qualifier R$1")
        .replace(/\bRound\s+(\d+)\b/gi, "R$1")
        .replace(/\bHeat\s+(\d+)\b/gi, "H$1")
        .replace(/\s+—\s+/g, " · ");
    }

    const bodyHtml = p.collapsed
      ? ""
      : `<div class="rc-panel-body is-cockpit-body">
          <div class="race-cockpit state-${cockpitStateCls}">
            <div class="race-cockpit-top">
              <div class="race-cockpit-meta">
                <div class="race-cockpit-eyebrow">
                  <span class="rc-lbl-full">${stagePrefix}Heat ${heat.order} of ${race.heats.length} (${confirmedCount} confirmed)</span>
                  <span class="rc-lbl-short">Heat ${heat.order} of ${race.heats.length}</span>
                </div>
                <div class="race-cockpit-title-row">
                  <h2><span class="rc-lbl-full">${esc(heat.title)}</span><span class="rc-lbl-short">${esc(mobileHeatTitle)}</span></h2>
                  ${this.renderHeatGraphJumpBtn(heat, { iconSize: 14 })}
                  <span class="race-state-pill ${effectiveBadge.cls} rc-hide-mobile"><span>${esc(effectiveBadge.label)}</span></span>
                  ${heat.note ? `<span class="note">${esc(heat.note)}</span>` : ""}
                </div>
                <div class="race-cockpit-rules">
                  <span class="rc-lbl-full">${heat.startMode === "staggered" ? "Staggered start" : "Horn start"} · ${heat.targetLaps > 0 ? `${heat.targetLaps} laps` : "Unlimited laps"} · ${formatRaceClock(heat.timeLimitSec)} limit${heat.expectedWinners > 0 ? ` · <span class="tone-good">Top ${heat.expectedWinners} advance</span>` : ""}</span>
                  <span class="rc-lbl-short">${parenRule ? esc(parenRule) : heat.startMode === "staggered" ? "Staggered start" : "Horn start"}${heat.expectedWinners > 0 ? ` · <span class="tone-good">Top ${heat.expectedWinners} advance</span>` : ""}</span>
                </div>
              </div>

              <div class="race-cockpit-clock-wrap">
                <div class="race-clock-row">
                  <button
                    type="button"
                    class="race-lap-announce-btn ${lapCalloutsOn ? "is-active" : "is-muted"}"
                    data-toggle-race-lap-callouts="${esc(stageFmt)}"
                    aria-pressed="${lapCalloutsOn ? "true" : "false"}"
                    ${announcerEnabled ? "" : "disabled"}
                    title="${esc(lapCalloutsTitle)}"
                    aria-label="${esc(lapCalloutsTitle)}"
                  >
                    ${lapCalloutsOn ? icons.megaphone(21) : icons.megaphoneOff(21)}
                  </button>
                  <div class="race-clock mono ${clockStateCls}" data-race-clock>${
                    heat.state === "countdown"
                      ? formatRaceClock(initialCountdownDisplaySec)
                      : formatHeatClockDisplay(heat)
                  }</div>
                </div>
                <div class="race-clock-sub-row">
                  <div class="race-clock-sub" data-race-clock-sub>${esc(initialClockSub)}</div>
                </div>
                <div class="race-clock-bar">
                  <div class="race-clock-bar-fill" data-race-progress-fill style="width: ${initialPct.toFixed(1)}%"></div>
                </div>
              </div>
            </div>

            ${cockpitNoticeHtml}
            <div class="race-cockpit-bottom">
              <div class="race-transport-bar">
                ${this.renderTransportButtons(heat, race)}
              </div>
              ${controllerStripHtml}
            </div>
          </div>
        </div>`;

    return `
      <section
        class="rc-canvas-panel rc-page-card is-cockpit-panel"
        data-canvas-panel="cockpit"
        data-mobile-ctrl-pane="live"
      >
        <header class="rc-panel-header">
          <div class="rc-panel-title-wrap rc-hide-mobile">
            ${icons.checkered(14)}
            <strong>Race Control</strong>
            <span class="badge mono">${esc(heat.shortLabel)}</span>
          </div>
          <div class="rc-panel-actions">
            ${lifecycleHeaderHtml}
          </div>
        </header>
        ${bodyHtml}
      </section>`;
  }

  private renderControlHeatLinePanel(race: RaceTournamentState): string {
    const viewStage = this.getCurrentViewStage(race);
    const heat = this.getControlStageHeat(race, viewStage);
    const hasOpenPopover = Boolean(this.openMarshalMenuKey);

    if (!heat) {
      if (!isRaceConfigured(race)) {
        return "";
      }
      return `
        <section
          class="rc-canvas-panel rc-page-card is-heatline-panel"
          data-canvas-panel="heatline"
          data-mobile-ctrl-pane="live"
        >
          <header class="rc-panel-header">
            <div class="rc-panel-title-wrap">
              ${icons.flag(14)}
              <strong>Flight Line</strong>
              <span class="race-state-pill is-waiting">No heats</span>
            </div>
          </header>
          <div class="rc-panel-body is-heatline-body">
            <div class="race-empty-state" style="padding:20px 16px"><p style="margin:0">No active heat on the flight line yet.</p></div>
          </div>
        </section>`;
    }

    const activeLineCount = heat.seats.filter(
      (s) => s.pilotSlotIndex > 0 && s.status !== "dns"
    ).length;

    return `
      <section
        class="rc-canvas-panel rc-page-card is-heatline-panel ${hasOpenPopover ? "has-open-popover" : ""}"
        data-canvas-panel="heatline"
        data-mobile-ctrl-pane="live"
      >
        <header class="rc-panel-header rc-hide-mobile">
          <div class="rc-panel-title-wrap">
            ${icons.flag(14)}
            <strong>Flight Line</strong>
            <span class="badge mono">${esc(heat.shortLabel)} · ${activeLineCount} pilot${activeLineCount === 1 ? "" : "s"}</span>
          </div>
          <div class="rc-panel-actions">
            ${this.renderHeatGraphJumpBtn(heat, { panelHeader: true, iconSize: 13 })}
          </div>
        </header>
        <div class="rc-panel-body is-heatline-body">
          <div class="race-heat-table-wrap">
            ${this.renderActiveHeatTable(heat)}
          </div>
        </div>
        ${this.renderMobileLiveLapsCard(heat)}
      </section>`;
  }

  private renderMobileLiveLapsCard(heat: RaceHeat): string {
    const entries: Array<{
      seat: HeatSeat;
      lap: HeatLap;
      chShort: string;
      isBestForPilot: boolean;
    }> = [];

    for (const s of heat.seats) {
      if (s.pilotSlotIndex <= 0) continue;
      const chShort = formatBandChannelShort(s.band, s.channel) || `R${s.channel}`;
      const explicitDnf = s.status === "dnf" && Boolean(s.statusOverridden);
      const seatOverridden = s.status === "dq" || s.status === "dns" || explicitDnf;
      let bestCrossingId = -1;
      let bestSec = Infinity;
      for (const l of s.laps) {
        if (
          l.lapNumber >= 1 &&
          !l.invalidated &&
          !seatOverridden &&
          l.splitTimeSec > 0 &&
          l.splitTimeSec < bestSec
        ) {
          bestSec = l.splitTimeSec;
          bestCrossingId = l.crossingId;
        }
      }
      for (const l of s.laps) {
        entries.push({
          seat: s,
          lap: l,
          chShort,
          isBestForPilot: l.crossingId === bestCrossingId && bestCrossingId !== -1,
        });
      }
    }

    entries.sort((a, b) => {
      if (Math.abs(b.lap.raceElapsedSec - a.lap.raceElapsedSec) > 1e-4) {
        return b.lap.raceElapsedSec - a.lap.raceElapsedSec;
      }
      return b.lap.crossingId - a.lap.crossingId;
    });

    const latestCrossingId = entries.length > 0 ? entries[0].lap.crossingId : 0;

    const rowsHtml =
      entries.length === 0
        ? `<tr class="rc-mobile-laps-empty-row"><td colspan="4" class="note">No crossings yet — waiting for gate passes…</td></tr>`
        : entries
            .map(({ seat, lap, chShort, isBestForPilot }) => {
              const isHoleshot = lap.lapNumber === 0;
              const lapTag = isHoleshot ? "HS" : lap.lapNumber < 0 ? "INV" : `L${lap.lapNumber}`;
              const explicitDnf = seat.status === "dnf" && Boolean(seat.statusOverridden);
              const isInvalid =
                (!isHoleshot && lap.invalidated) ||
                seat.status === "dq" ||
                seat.status === "dns" ||
                explicitDnf;
              return `
                <tr class="rc-mobile-lap-row ${isInvalid ? "is-invalid" : ""} ${isBestForPilot ? "is-best" : ""}">
                  <td class="rc-mlap-col-pilot">
                    <div class="race-pilot-cell">
                      <span class="dot" style="--c:${seat.color}"></span>
                      <strong>${esc(seat.callsign)}</strong>
                    </div>
                  </td>
                  <td class="rc-mlap-col-lap mono">
                    <span class="rc-mlap-tag ${isHoleshot ? "is-hs" : ""}">${lapTag}</span>
                  </td>
                  <td class="rc-mlap-col-split mono">
                    <span class="rc-mlap-split ${isInvalid ? "is-invalid" : ""} ${isBestForPilot ? "is-best" : ""}">${lap.splitTimeSec.toFixed(2)}s</span>
                  </td>
                  <td class="rc-mlap-col-clock mono note">${formatRaceClock(lap.raceElapsedSec)}</td>
                </tr>`;
            })
            .join("");

    const bodyHtml = `<div class="rc-mobile-laps-scroll" data-mobile-laps-scroll data-preserve-scroll="mobile-live-laps" data-latest-crossing="${latestCrossingId}">
            <table class="table rc-compact-table rc-mobile-laps-table">
              <thead>
                <tr>
                  <th class="rc-mlap-col-pilot">Pilot</th>
                  <th class="rc-mlap-col-lap">Lap</th>
                  <th class="rc-mlap-col-split">Time</th>
                  <th class="rc-mlap-col-clock">Elapsed</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml}
              </tbody>
            </table>
          </div>`;

    return `
      <div class="rc-mobile-live-laps-card" data-mobile-live-laps>
        ${bodyHtml}
      </div>`;
  }

  private renderControlSchedulePanel(race: RaceTournamentState): string {
    const viewStage = this.getCurrentViewStage(race);
    const stages = resolveStagesList(race);
    const curStage = stages.find((s) => s.index === viewStage);
    const isOpenQual = curStage?.format === "open_qualifier";
    const multiStage = stages.length > 1;
    const activeHeatId = this.getControlStageHeat(race, viewStage)?.id ?? "";
    const scopedHeats =
      multiStage || isOpenQual
        ? race.heats.filter((h) => h.stageIndex === viewStage)
        : race.heats;
    const confirmedCount = scopedHeats.filter((h) => h.state === "confirmed").length;
    const panelTitle = multiStage ? `S${viewStage} Heats Schedule` : "Heats Schedule";

    return `
      <section
        class="rc-canvas-panel rc-page-card is-schedule-panel"
        data-canvas-panel="schedule"
        data-mobile-ctrl-pane="schedule"
      >
        <header class="rc-panel-header">
          <div class="rc-panel-title-wrap rc-hide-mobile">
            ${icons.calendar(14)}
            <strong>${esc(panelTitle)}</strong>
            <span class="note mono">${confirmedCount}/${scopedHeats.length}</span>
          </div>
          <div class="rc-panel-actions">
            <span class="note mono rc-sched-mobile-count">${confirmedCount}/${scopedHeats.length}</span>
            ${
              (race.mgpLink?.isZippyQ || race.mgpLink?.importMode === "zippyq") &&
              sharedMultiGPService.isAvailable(this.store)
                ? `<button
                    type="button"
                    class="btn btn-ghost btn-xs rc-panel-csv-btn rc-sched-zippyq-btn"
                    data-race-act="mgp-pull-zippyq"
                    ${this.zippyPullInFlight ? "disabled" : ""}
                    title="Pull newly queued ZippyQ heats from MultiGP #${race.mgpLink.raceId}"
                    aria-label="Pull ZippyQ heats from MultiGP"
                  >
                    ${icons.download(13)}<span>${this.zippyPullInFlight ? "Pulling…" : "Pull ZippyQ"}</span>
                  </button>`
                : ""
            }
            <div class="segmented rc-panel-seg">
              <button type="button" class="${this.scheduleFilter === "all" ? "is-active" : ""}" data-sched-filter="all">All</button>
              <button type="button" class="${this.scheduleFilter === "upcoming" ? "is-active" : ""}" data-sched-filter="upcoming">Upcoming</button>
              <button type="button" class="${this.scheduleFilter === "done" ? "is-active" : ""}" data-sched-filter="done">Confirmed</button>
            </div>
          </div>
        </header>
        <div class="rc-panel-body">
          ${this.renderScheduleTable(race, activeHeatId, multiStage || isOpenQual ? viewStage : undefined)}
        </div>
      </section>`;
  }

  private renderControlStandingsPanel(race: RaceTournamentState): string {
    const hasQual = !!(race.qualStandings && race.qualStandings.length > 0);
    const list: TournamentStanding[] =
      this.standingsStage === "qualifying" && race.qualStandings
        ? race.qualStandings
        : race.standings;
    const mgpVerified = this.isMultiGPVerified();
    const canUploadOverall = !this.mgpUploadInFlight && (list?.length ?? 0) > 0;

    return `
      <section
        class="rc-canvas-panel rc-page-card is-standings-panel"
        data-canvas-panel="standings"
        data-mobile-ctrl-pane="standings"
      >
        <div class="rc-standings-card-box">
          <header class="rc-panel-header${hasQual ? "" : " rc-hide-mobile"}">
            <div class="rc-panel-title-wrap rc-hide-mobile">
              ${icons.trophy(14)}
              <strong>Overall Standings</strong>
            </div>
            ${
              hasQual
                ? `<div class="rc-panel-actions is-standings-actions">
                    <div class="segmented rc-panel-seg">
                      <button type="button" class="${this.standingsStage === "main" ? "is-active" : ""}" data-std-stage="main">Overall</button>
                      <button type="button" class="${this.standingsStage === "qualifying" ? "is-active" : ""}" data-std-stage="qualifying">Qualifying</button>
                    </div>
                  </div>`
                : ""
            }
          </header>
          <div class="rc-panel-body">${this.renderStandingsTable(race)}</div>
        </div>
        <footer class="rc-standings-footer pilot-dir-mobile-footer">
          ${
            mgpVerified
              ? `<button
                  type="button"
                  class="btn btn-sm pilot-dir-mgp-btn rc-mgp-col-upload-btn"
                  data-race-act="mgp-upload-overall"
                  ${canUploadOverall ? "" : "disabled"}
                  title="Export overall rankings to MultiGP"
                >
                  <span>Export to MultiGP</span>
                </button>`
              : ""
          }
          <button type="button" class="btn btn-sm pilot-dir-mgp-btn" data-race-act="export-csv" title="Export standings &amp; results as CSV" aria-label="Export as CSV">
            <span>Export as CSV</span>
          </button>
        </footer>
      </section>`;
  }

  private renderControlSignalsPanel(race: RaceTournamentState): string {
    const selectedSlot = this.resolveRaceSignalsSlot(race);
    const candidates = this.getRaceSignalsCandidates(race);

    const mobilePilotPickerHtml =
      candidates.length > 0
        ? `<div class="picker-row rc-mobile-signals-picker-row">
            <div class="pilot-picker-shell sched-lineup-wrap">
              <button type="button" class="pilot-picker-cue sched-lineup-cue is-left" data-lineup-scroll="-1" aria-label="Scroll pilots left" title="More pilots left" hidden>${icons.chevronLeft(14)}</button>
              <div class="pilot-picker sched-lineup" role="tablist" aria-label="Select pilot signal trace" data-fit-lineup>
                ${candidates
                  .map(
                    (c) => `
                  <button
                    type="button"
                    class="pilot-chip ${c.slotIndex === selectedSlot ? "is-active" : ""}"
                    role="tab"
                    aria-selected="${c.slotIndex === selectedSlot ? "true" : "false"}"
                    data-race-sig-pilot="${c.slotIndex}"
                    style="--c:${c.color}"
                  >
                    <span class="dot" style="--c:${c.color}"></span>
                    <span class="pilot-chip-name">${esc(c.callsign)}</span>
                    ${c.channelLabel ? `<span class="pilot-chip-chan mono">${esc(c.channelLabel)}</span>` : ""}
                  </button>`
                  )
                  .join("")}
              </div>
              <button type="button" class="pilot-picker-cue sched-lineup-cue is-right" data-lineup-scroll="1" aria-label="Scroll pilots right" title="More pilots right" hidden>${icons.chevronRight(14)}</button>
            </div>
          </div>`
        : "";

    const pilotBarHtml =
      candidates.length > 0
        ? `<div class="sched-lineup-wrap rc-signals-pilot-wrap">
            <button type="button" class="sched-lineup-cue is-left" data-lineup-scroll="-1" aria-label="Scroll pilots left" title="Scroll left" hidden>${icons.chevronLeft(13)}</button>
            <div class="rc-signals-pilot-bar sched-lineup" role="tablist" aria-label="Select pilot signal trace" data-fit-lineup>
              ${candidates
                .map(
                  (c) => `
                <button
                  type="button"
                  class="races-filter-pill rc-sig-pilot-pill ${c.slotIndex === selectedSlot ? "is-active" : ""}"
                  data-race-sig-pilot="${c.slotIndex}"
                  style="--c:${c.color}"
                >
                  <span class="dot" style="--c:${c.color}"></span>
                  <span>${esc(c.callsign)}</span>
                  ${c.channelLabel ? `<span class="mono note">${esc(c.channelLabel)}</span>` : ""}
                </button>`
                )
                .join("")}
            </div>
            <button type="button" class="sched-lineup-cue is-right" data-lineup-scroll="1" aria-label="Scroll pilots right" title="More pilots" hidden>${icons.chevronRight(13)}</button>
          </div>`
        : `<div class="note" style="padding:4px 0">No active pilots.</div>`;

    return `
      <section
        class="rc-canvas-panel rc-page-card is-signals-panel"
        data-canvas-panel="signals"
        data-mobile-ctrl-pane="signals"
      >
        <div class="rc-signals-card-box">
          ${mobilePilotPickerHtml}
          <header class="rc-panel-header rc-hide-mobile">
            <div class="rc-panel-title-wrap">
              ${icons.signal(14)}
              <strong>Signal at each timer</strong>
              <span class="note rc-hide-mobile">Live RSSI &amp; gate crossing thresholds</span>
            </div>
          </header>
          <div class="rc-panel-body is-signals-body">
            ${pilotBarHtml}
            ${candidates.length > 0 ? `<div class="rc-signals-chart-host" data-race-signals-chart></div>` : ""}
          </div>
        </div>
      </section>`;
  }

  private getExecutedHeats(race: RaceTournamentState): RaceHeat[] {
    return (race.heats ?? [])
      .filter(
        (h) =>
          (h.state === "confirmed" && h.note !== "Auto-advance (bye)") ||
          h.state === "finished" ||
          h.state === "paused" ||
          h.state === "aborted"
      )
      .sort((a, b) => {
        const ta = a.executedAtMs || 0;
        const tb = b.executedAtMs || 0;
        if (tb !== ta) return tb - ta;
        return b.order - a.order;
      });
  }

  private resolveReviewHeat(race: RaceTournamentState): RaceHeat | undefined {
    const executed = this.getExecutedHeats(race);
    if (executed.length === 0) return undefined;
    if (this.reviewSelectedHeatId) {
      const match = executed.find((h) => h.id === this.reviewSelectedHeatId);
      if (match) return match;
    }
    this.reviewSelectedHeatId = executed[0].id;
    return executed[0];
  }

  private formatExecutedHeatTime(executedAtMs?: number): string {
    if (!executedAtMs || executedAtMs <= 0) return "Executed";
    try {
      const d = new Date(executedAtMs);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch {
      return "Executed";
    }
  }

  private canSwitchReviewStatus(heat: RaceHeat, race: RaceTournamentState): boolean {
    return (
      race.lifecycle !== "scrapped" &&
      (heat.state === "confirmed" || heat.state === "finished") &&
      heat.note !== "Auto-advance (bye)"
    );
  }

  private renderReviewStatusToggle(heat: RaceHeat, race: RaceTournamentState): string {
    if (!this.canSwitchReviewStatus(heat, race)) {
      return "";
    }
    const isConfirmed = heat.state === "confirmed";
    return `<div class="rc-lifecycle-seg rc-review-seg" data-review-status-toggle role="group" aria-label="Heat review status">
      <button
        type="button"
        class="rc-lifecycle-btn is-opt-review ${!isConfirmed ? "is-active" : ""}"
        data-set-review-status="unlock"
        data-heat-id="${esc(heat.id)}"
        aria-pressed="${!isConfirmed ? "true" : "false"}"
        title="${isConfirmed ? "Switch to Review to unlock and edit laps" : "Heat is unlocked for Review"}"
      >Review</button>
      <button
        type="button"
        class="rc-lifecycle-btn is-opt-confirmed ${isConfirmed ? "is-active" : ""}"
        data-set-review-status="confirm"
        data-heat-id="${esc(heat.id)}"
        aria-pressed="${isConfirmed ? "true" : "false"}"
        title="${isConfirmed ? "Results are confirmed" : "Confirm heat results"}"
      >Confirmed</button>
    </div>`;
  }

  private renderReviewMobilePickerPanel(race: RaceTournamentState): string {
    const heat = this.resolveReviewHeat(race);
    const executed = this.getExecutedHeats(race);
    if (!heat || executed.length === 0) return "";
    const stages = resolveStagesList(race);
    const multiStage = stages.length > 1;
    const curExecIdx = executed.findIndex((h) => h.id === heat.id);
    return `
      <section class="rc-page-card rc-review-mobile-picker-card" data-review-mobile-picker-card>
        <div class="rc-review-mobile-picker" role="group" aria-label="Select executed heat">
          <button
            type="button"
            class="btn btn-ghost btn-xs rc-review-step-btn"
            data-review-step-heat="-1"
            ${curExecIdx <= 0 ? "disabled" : ""}
            title="Newer executed heat"
            aria-label="Newer executed heat"
          >${icons.chevronLeft(14)}</button>
          <select class="input input-sm rc-review-heat-select" data-review-heat-select aria-label="Executed heat">
            ${executed
              .map((eh) => {
                const ehPrefix = multiStage ? `S${eh.stageIndex} · ` : "";
                const ehBadge = heatStateBadge(eh.state, eh.inOvertime, eh.note);
                return `<option value="${esc(eh.id)}" ${eh.id === heat.id ? "selected" : ""}>${esc(ehPrefix + eh.shortLabel)} · ${esc(eh.title)} (${esc(ehBadge.label)})</option>`;
              })
              .join("")}
          </select>
          <button
            type="button"
            class="btn btn-ghost btn-xs rc-review-step-btn"
            data-review-step-heat="1"
            ${curExecIdx < 0 || curExecIdx >= executed.length - 1 ? "disabled" : ""}
            title="Older executed heat"
            aria-label="Older executed heat"
          >${icons.chevronRight(14)}</button>
        </div>
      </section>`;
  }

  private renderReviewHeatPanel(race: RaceTournamentState): string {
    const heat = this.resolveReviewHeat(race);
    const hasOpenPopover = Boolean(this.openMarshalMenuKey);
    const stages = resolveStagesList(race);
    const multiStage = stages.length > 1;

    if (!heat) {
      return `
        <section
          class="rc-canvas-panel rc-page-card is-review-heat-panel"
          data-canvas-panel="review_heat"
        >
          <header class="rc-panel-header">
            <div class="rc-panel-title-wrap">
              ${icons.reviewCheck(14)}
              <strong>Heat Review</strong>
              <span class="race-state-pill is-waiting">No executed heats</span>
            </div>
          </header>
          <div class="rc-panel-body is-heatline-body">
            <div class="race-empty-state" style="padding:24px 16px">
              <p style="margin:0 0 8px">No executed heats to review yet for <strong>${esc(race.config.eventName || "this race")}</strong>.</p>
              <p class="note" style="margin:0">Once heats run or finish in <strong>Control</strong>, select any heat here to inspect RSSI crossings, drop/add laps, or adjust placements.</p>
            </div>
          </div>
        </section>`;
    }

    const stg = stages.find((s) => s.index === heat.stageIndex);
    const stgPrefix = multiStage ? `Stage ${heat.stageIndex}${stg ? ` (${stg.title})` : ""} · ` : "";
    const canSwitchStatus = this.canSwitchReviewStatus(heat, race);
    const statusBadge = heatStateBadge(heat.state, heat.inOvertime, heat.note);

    return `
      <section
        class="rc-canvas-panel rc-page-card is-review-heat-panel ${hasOpenPopover ? "has-open-popover" : ""}"
        data-canvas-panel="review_heat"
      >
        <header class="rc-panel-header">
          <div class="rc-panel-title-wrap">
            ${icons.reviewCheck(14)}
            <strong class="rc-review-desktop-title">Heat Review</strong>
            <strong class="rc-review-mobile-title mono">${esc(heat.shortLabel)}</strong>
            <span class="badge mono rc-review-heat-badge"><span class="rc-lbl-full">${esc(heat.shortLabel)} · ${esc(stgPrefix + heat.title)}</span><span class="rc-lbl-short">${esc(heat.shortLabel)}</span></span>
            ${!canSwitchStatus ? `<span class="race-state-pill ${statusBadge.cls}">${esc(statusBadge.label)}</span>` : ""}
            ${canSwitchStatus && heat.state === "confirmed" ? `<span class="note rc-review-edit-hint">Switch to Review to edit laps</span>` : ""}
          </div>
          <div class="rc-panel-actions">
            ${this.renderReviewStatusToggle(heat, race)}
            ${this.renderHeatGraphJumpBtn(heat, { panelHeader: true, iconSize: 13 })}
          </div>
        </header>
        <div class="rc-panel-body is-heatline-body">
          <div class="race-heat-table-wrap">
            ${this.renderActiveHeatTable(heat, { staticRf: true })}
          </div>
        </div>
      </section>`;
  }

  private renderReviewListPanel(race: RaceTournamentState): string {
    const p = this.reviewPanels.review_list;

    const executed = this.getExecutedHeats(race);
    const activeReviewHeat = this.resolveReviewHeat(race);
    const selectedId = activeReviewHeat?.id ?? "";
    const stages = resolveStagesList(race);
    const multiStage = stages.length > 1;

    const bodyInner =
      executed.length === 0
        ? `<div class="race-empty-state"><p>No completed heats yet. Completed and finished heats appear here newest-first.</p></div>`
        : `<div class="table-scroll" style="max-height:320px" data-preserve-scroll="review-executed-list">
            <table class="table rc-compact-table rc-executed-heats-table">
              <thead>
                <tr>
                  <th class="rc-exec-time-col">Executed</th>
                  <th class="rc-exec-heat-col">Heat</th>
                  <th class="rc-exec-status-col">Status</th>
                  <th class="rc-exec-results-col">Placements</th>
                </tr>
              </thead>
              <tbody>
                ${executed
                  .map((h) => {
                    const isSel = h.id === selectedId;
                    const stgPrefix = multiStage ? `S${h.stageIndex} · ` : "";
                    const b = heatStateBadge(h.state, h.inOvertime, h.note);
                    const shortExecStatus =
                      b.label === "Review"
                        ? "Rev."
                        : b.label === "Confirmed"
                          ? "Conf."
                          : b.label === "Paused"
                            ? "Psd."
                            : b.label === "Stopped"
                              ? "Stop"
                              : b.label === "Overtime"
                                ? "OT"
                                : b.label;
                    const sortedSeats = [...h.seats]
                      .filter((s) => s.pilotSlotIndex > 0)
                      .sort((sa, sb) => {
                        const aR = sa.position > 0;
                        const bR = sb.position > 0;
                        if (aR && bR && sa.position !== sb.position) return sa.position - sb.position;
                        if (aR !== bR) return aR ? -1 : 1;
                        return sa.seatIndex - sb.seatIndex;
                      });
                    const summaryChips = sortedSeats
                      .map((s) => {
                        const posLabel = s.position > 0 ? `#${s.position}` : "";
                        const stSuffix =
                          s.status === "dns"
                            ? " (DNS)"
                            : s.status === "dq"
                              ? " (DQ)"
                              : s.status === "dnf"
                                ? " (DNF)"
                                : s.advances
                                  ? " ✓"
                                  : "";
                        return `<span class="sched-pilot-chip ${s.status === "dns" || s.status === "dq" ? "is-tbd" : ""}"><span class="dot" style="--c:${s.color}"></span><span class="sched-chip-text">${posLabel ? `<span class="sched-chip-ch mono">${esc(posLabel)}</span>` : ""}<span class="sched-chip-name">${esc(s.callsign)}${stSuffix}</span></span></span>`;
                      })
                      .join("");
                    return `
                      <tr class="${isSel ? "is-selected-row" : ""} rc-review-exec-row" data-review-select-heat="${esc(h.id)}">
                        <td class="mono note rc-exec-time-col"><span class="rc-exec-sel-strip" aria-hidden="true"></span>${esc(this.formatExecutedHeatTime(h.executedAtMs))}</td>
                        <td class="rc-exec-heat-col">
                          <div class="rc-sched-heat-title-row">
                            <strong class="rc-sched-heat-label">${esc(stgPrefix + h.shortLabel)}</strong>
                          </div>
                        </td>
                        <td class="rc-exec-status-col">
                          <span class="race-state-pill ${b.cls} rc-exec-status-pill">${esc(b.label)}</span>
                          <span class="rc-exec-status-icon ${h.state === "confirmed" ? "is-confirmed" : "is-review"}" title="${esc(b.label)}" aria-label="${esc(b.label)}">${h.state === "confirmed" ? icons.check(16) : icons.eye(16)}</span>
                        </td>
                        <td class="rc-exec-results-col"><div class="sched-lineup-wrap"><button type="button" class="sched-lineup-cue is-left" data-lineup-scroll="-1" aria-label="Scroll placements left" title="Scroll left" hidden>${icons.chevronLeft(12)}</button><div class="sched-lineup" data-fit-lineup>${summaryChips || `<span class="note">—</span>`}</div><button type="button" class="sched-lineup-cue is-right" data-lineup-scroll="1" aria-label="Scroll placements right" title="More placements" hidden>${icons.chevronRight(12)}</button></div></td>
                      </tr>`;
                  })
                  .join("")}
              </tbody>
            </table>
          </div>`;

    return `
      <section
        class="rc-canvas-panel rc-page-card is-review-list-panel"
        data-canvas-panel="review_list"
      >
        <header class="rc-panel-header">
          <div class="rc-panel-title-wrap">
            ${icons.calendar(14)}
            <strong>Completed Heats</strong>
            <span class="badge mono">${executed.length}</span>
            <span class="note rc-hide-mobile">Reverse chronological order</span>
          </div>
          <div class="rc-panel-actions">
            ${
              this.isMultiGPVerified()
                ? `<button
                    type="button"
                    class="btn btn-ghost btn-xs rc-panel-csv-btn rc-mgp-col-upload-btn"
                    data-race-act="mgp-upload-heats"
                    ${!this.mgpUploadInFlight && executed.length > 0 ? "" : "disabled"}
                    title="Inspect and upload completed heat results (race/assignSlot) to MultiGP"
                  >
                    ${icons.upload(12)}<span>Upload MGP</span>
                  </button>`
                : ""
            }
            <button type="button" class="rc-panel-icon-btn" data-race-act="export-csv" title="Export results CSV" aria-label="Export CSV">
              ${icons.download(13)}
            </button>
          </div>
        </header>
        <div class="rc-panel-body">${bodyInner}</div>
      </section>`;
  }

  private triggerDirectMultiGPUpload(): void {
    const curRace = this.currentRace;
    if (!curRace.raceId || !this.isMultiGPVerified() || this.mgpUploadInFlight) return;
    const isLinked = Boolean(curRace.mgpLink && curRace.mgpLink.raceId > 0);
    const raceTitle = curRace.mgpLink?.raceName || curRace.config.eventName || "SlapRF Race";

    this.mgpUploadInFlight = true;
    this.refreshSinglePanelDom("review_mgp");

    void (async () => {
      try {
        let plan = await this.api.multiGPBuildSyncPlan(curRace.raceId!, false);
        if ((plan.operations?.length ?? 0) === 0) {
          plan = await this.api.multiGPBuildSyncPlan(curRace.raceId!, true);
        }
        const res = await sharedMultiGPService.pushSyncPlan(this.store, this.api, plan);
        showToast(
          `${isLinked ? "Synced" : "Uploaded"} ${res.slotsPushed} heat slot${
            res.slotsPushed === 1 ? "" : "s"
          }${res.overallPushed ? " + overall standings" : ""} to MultiGP #${res.mgpRaceId}`,
          "info"
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        openMultiGPErrorModal({
          title: isLinked ? "MultiGP Sync Failed" : "MultiGP Upload Failed",
          raceName: raceTitle,
          errorMessage: msg,
          onRetry: () => this.triggerDirectMultiGPUpload(),
        });
      } finally {
        this.mgpUploadInFlight = false;
        if (
          !this.disposed &&
          (this.activeTab === "multigp" || this.activeTab === "review")
        ) {
          this.refreshSinglePanelDom("review_mgp");
        }
      }
    })();
  }

  private renderMultiGPOverallPanel(race: RaceTournamentState): string {
    if (!this.isMultiGPVerified()) return "";
    const p = this.reviewPanels.mgp_overall;

    const standings: TournamentStanding[] =
      race.standings && race.standings.length > 0
        ? race.standings
        : (race.qualStandings ?? []);
    const canUploadOverall = !this.mgpUploadInFlight && standings.length > 0;

    const standingsPreviewHtml =
      standings.length === 0
        ? `<div class="note" style="padding:12px">No overall standings recorded yet.</div>`
        : `<div class="table-scroll" style="max-height:320px">
             <table class="table rc-compact-table rc-mgp-overall-table">
               <thead>
                 <tr>
                   <th class="rc-mgp-col-rank">Rank</th>
                   <th>Pilot</th>
                   <th class="rc-mgp-col-metric" style="width:96px">Best Lap</th>
                   <th class="rc-mgp-col-metric" style="width:96px">Best 3C</th>
                 </tr>
               </thead>
               <tbody>
                 ${standings
                   .map(
                     (st, idx) => `
                     <tr>
                       <td class="rc-mgp-col-rank"><strong>${idx + 1}</strong></td>
                       <td>
                         <span style="display:inline-flex;align-items:center;gap:6px">
                           <span class="dot" style="--c:${st.color}"></span>
                           <strong>${esc(st.callsign)}</strong>
                         </span>
                       </td>
                       <td class="rc-mgp-col-metric">${st.bestLapSec > 0 ? `${st.bestLapSec.toFixed(2)}s` : "—"}</td>
                       <td class="rc-mgp-col-metric">${st.bestConsecutive3Sec > 0 ? `${st.bestConsecutive3Sec.toFixed(2)}s` : "—"}</td>
                     </tr>`
                   )
                   .join("")}
               </tbody>
             </table>
           </div>`;

    return `
      <section
        class="rc-canvas-panel rc-page-card is-mgp-overall-panel"
        data-canvas-panel="mgp_overall"
      >
        <header class="rc-panel-header">
          <div class="rc-panel-title-wrap">
            ${icons.trophy(14)}
            <strong>Overall Ranking</strong>
            <span class="badge mono">${standings.length}</span>
            <span class="badge rc-hide-mobile">captureOverallRaceResult</span>
          </div>
          <div class="rc-panel-actions">
            <button
              type="button"
              class="btn btn-armed btn-xs rc-mgp-col-upload-btn"
              data-race-act="mgp-upload-overall"
              ${canUploadOverall ? "" : "disabled"}
              title="Inspect and upload overall rankings (captureOverallRaceResult) to MultiGP"
            >
              ${icons.upload(12)}<span>Upload</span>
            </button>
          </div>
        </header>
        <div class="rc-panel-body">${standingsPreviewHtml}</div>
      </section>`;
  }

  private renderMultiGPHeatsPanel(race: RaceTournamentState): string {
    if (!this.isMultiGPVerified()) return "";
    const p = this.reviewPanels.mgp_heats;
    const link = race.mgpLink;

    const completedHeats = race.heats.filter(
      (h) =>
        (h.state === "finished" || h.state === "confirmed") &&
        h.note !== "Auto-advance (bye)"
    );
    const canUploadHeats = !this.mgpUploadInFlight && completedHeats.length > 0;

    const heatsPreviewHtml =
      completedHeats.length === 0
        ? `<div class="note" style="padding:12px">No completed heats to upload yet. Finish or confirm heats first.</div>`
        : `<div class="table-scroll" style="max-height:320px">
             <table class="table rc-compact-table rc-mgp-heats-table">
               <thead>
                 <tr>
                   <th class="rc-mgp-col-heat">Heat</th>
                   <th class="rc-mgp-col-sync">Sync</th>
                   <th>Slot Results to Upload</th>
                 </tr>
               </thead>
               <tbody>
                 ${completedHeats
                   .map((h) => {
                     const syncedAt = link?.syncedHeatAt?.[h.id] ?? "";
                     const isDirty = Boolean(link?.unsyncedHeats?.[h.id]);
                     const isSynced = Boolean(syncedAt && !isDirty);
                     const syncState = isSynced
                       ? `<span class="race-state-pill is-done rc-exec-status-pill">Synced ✓</span><span class="rc-exec-status-icon is-confirmed" title="Synced" aria-label="Synced">${icons.check(16)}</span>`
                       : `<span class="race-state-pill is-staged rc-exec-status-pill">Pending</span><span class="rc-exec-status-icon is-review" title="Pending" aria-label="Pending">${icons.clock(16)}</span>`;
                     const filledSeats = h.seats.filter((s) => s.pilotSlotIndex > 0);
                     const seatsSummary = filledSeats
                       .map((s) => {
                         const posLabel = s.position > 0 ? `#${s.position}` : "";
                         const timeStr =
                           s.totalTimeSec > 0 ? ` · ${s.totalTimeSec.toFixed(2)}s` : "";
                         return `<span class="sched-pilot-chip"><span class="dot" style="--c:${s.color}"></span><span class="sched-chip-text">${posLabel ? `<span class="sched-chip-ch">${esc(posLabel)}</span>` : ""}<span class="sched-chip-name">${esc(s.callsign)} (${s.lapsCompleted}L${esc(timeStr)})</span></span></span>`;
                       })
                       .join("");
                     return `
                       <tr>
                         <td class="rc-mgp-col-heat"><strong class="rc-sched-heat-label">${esc(h.shortLabel)}</strong></td>
                         <td class="rc-mgp-col-sync">${syncState}</td>
                         <td><div class="sched-lineup-wrap"><button type="button" class="sched-lineup-cue is-left" data-lineup-scroll="-1" aria-label="Scroll placements left" title="Scroll left" hidden>${icons.chevronLeft(12)}</button><div class="sched-lineup" data-fit-lineup>${seatsSummary || `<span class="note">—</span>`}</div><button type="button" class="sched-lineup-cue is-right" data-lineup-scroll="1" aria-label="Scroll placements right" title="More placements" hidden>${icons.chevronRight(12)}</button></div></td>
                       </tr>`;
                   })
                   .join("")}
               </tbody>
             </table>
           </div>`;

    return `
      <section
        class="rc-canvas-panel rc-page-card is-mgp-heats-panel"
        data-canvas-panel="mgp_heats"
      >
        <header class="rc-panel-header">
          <div class="rc-panel-title-wrap">
            ${icons.calendar(14)}
            <strong>Completed Heats</strong>
            <span class="badge mono">${completedHeats.length}</span>
            <span class="badge rc-hide-mobile">race/assignSlot</span>
          </div>
          <div class="rc-panel-actions">
            ${
              link?.isZippyQ
                ? `<button type="button" class="btn btn-ghost btn-xs" data-race-act="mgp-pull-zippyq" ${this.zippyPullInFlight ? "disabled" : ""} title="Pull newly queued ZippyQ rounds from MultiGP #${link.raceId}">
                    ${icons.download(12)}<span>${this.zippyPullInFlight ? "Pulling…" : "Pull ZippyQ"}</span>
                  </button>`
                : ""
            }
            <button
              type="button"
              class="btn btn-armed btn-xs rc-mgp-col-upload-btn"
              data-race-act="mgp-upload-heats"
              ${canUploadHeats ? "" : "disabled"}
              title="Inspect and upload completed heat results (race/assignSlot) to MultiGP"
            >
              ${icons.upload(12)}<span>Upload</span>
            </button>
          </div>
        </header>
        <div class="rc-panel-body">${heatsPreviewHtml}</div>
      </section>`;
  }

  private renderCanvasReviewView(race: RaceTournamentState): string {
    return `
      <div class="races-page is-review-page" data-rc-page="review">
        ${this.renderRaceWorkspaceTopBar(race, "review")}

        <div class="races-page-stack">
          ${this.renderReviewListPanel(race)}
          ${this.renderReviewHeatPanel(race)}
        </div>
      </div>`;
  }

  private renderCanvasMultiGPView(race: RaceTournamentState): string {
    return `
      <div class="races-page is-multigp-page" data-rc-page="multigp">
        ${this.renderRaceWorkspaceTopBar(race, "multigp")}

        <div class="races-page-stack">
          ${this.renderMultiGPOverallPanel(race)}
          ${this.renderMultiGPHeatsPanel(race)}
        </div>
      </div>`;
  }

  private autoRefreshZippyQIfIdle(): void {
    if (this.zippyPullInFlight || !this.store.simulatorRunning) return;
    const curRace = this.currentRace;
    const link = curRace.mgpLink;
    if (!link?.isZippyQ || !curRace.raceId || !sharedMultiGPService.isAvailable(this.store)) return;
    if (curRace.lifecycle === "completed" || curRace.lifecycle === "scrapped" || curRace.lifecycle === "paused") {
      return;
    }
    const busyHeat = curRace.heats.some(
      (h) => h.state === "countdown" || h.state === "running" || h.state === "armed"
    );
    if (busyHeat) return;
    if (this.el.querySelector(".is-custom-open")) return;

    this.zippyPullInFlight = true;
    void sharedMultiGPService
      .pullZippyQRounds(this.store, this.api, curRace.raceId, link.raceId, 1, 1)
      .catch(() => {
        // Silent background poll; explicit Pull ZippyQ button surfaces errors
      })
      .finally(() => {
        this.zippyPullInFlight = false;
      });
  }

  private renderMobilePilotsView(race: RaceTournamentState): string {
    return `
      <div class="races-page is-pilots-page" data-rc-page="pilots">
        ${this.renderRaceWorkspaceTopBar(race, "pilots")}

        <div class="races-page-stack">
          ${this.renderPilotsCanvasPanel(race, "pilots")}
        </div>
      </div>`;
  }

  private renderDesktopPilotsColumnBody(race: RaceTournamentState): string {
    const {
      roster,
      unassignedPilots,
      assignedPilots,
      inactivePilots,
    } = this.computePilotsPanelViewData(race);
    const canAddPilots = race.lifecycle !== "completed" && race.lifecycle !== "scrapped";
    const trimmedSearch = this.pilotsSearchQuery.trim();
    const exactPanelMatch = this.findExistingPilotCallsign(trimmedSearch, race);
    const addPanelDisabled = !trimmedSearch || !!exactPanelMatch;
    const addPanelTitle = exactPanelMatch
      ? `Pilot "${exactPanelMatch}" is already in roster`
      : trimmedSearch
        ? `Add pilot "${trimmedSearch}"`
        : "Search or type a unique callsign to add";

    return `
      <div class="rc-panel-body rc-pilots-panel-body dte-pilots-body">
        <div class="rc-pilots-toolbar">
          <div class="rc-pilots-search-bar">
            <div class="rc-pilots-search-row">
              ${icons.search(13)}
              <input
                type="search"
                class="input input-sm rc-pilots-search-input"
                data-race-field="pilots-search"
                placeholder="Search or add pilot..."
                aria-label="Search or add pilot"
                value="${esc(this.pilotsSearchQuery)}"
                autocomplete="off"
              />
            </div>
            ${
              canAddPilots
                ? `<button
                    type="button"
                    class="btn btn-ghost btn-xs bkt-pilots-add-btn"
                    data-race-act="submit-panel-walkup"
                    ${addPanelDisabled ? "disabled" : ""}
                    title="${esc(addPanelTitle)}"
                  >
                    ${icons.plus(12)}<span>Add</span>
                  </button>`
                : ""
            }
          </div>
          <div class="segmented rc-pilots-filter-seg" role="tablist" aria-label="Filter race pilots">
            <button type="button" class="${this.pilotsFilter === "all" ? "is-active" : ""}" data-pilots-filter="all">
              All (${roster.length})
            </button>
            <button type="button" class="${this.pilotsFilter === "unassigned" ? "is-active" : ""}" data-pilots-filter="unassigned">
              Free (${unassignedPilots.length})
            </button>
            <button type="button" class="${this.pilotsFilter === "assigned" ? "is-active" : ""}" data-pilots-filter="assigned">
              Seated (${assignedPilots.length})
            </button>
            <button type="button" class="${this.pilotsFilter === "inactive" ? "is-active" : ""}" data-pilots-filter="inactive">
              Out (${inactivePilots.length})
            </button>
          </div>
        </div>
        <div class="rc-pilots-results" data-rc-pilots-results>
          ${this.renderPilotsPanelResults(race, "edit")}
        </div>
      </div>`;
  }

  private renderDesktopTableConfigureView(race: RaceTournamentState): string {
    return renderDesktopRaceTableEditorHtml(
      race,
      this.desktopTableUi,
      this.renderRaceWorkspaceTopBar(race, "edit", "", "dte-page-topbar"),
      this.renderDesktopSetupViewToggle()
    );
  }

  private renderMobileConfigureView(race: RaceTournamentState): string {
    return `
      <div class="races-page is-configure-page" data-rc-page="configure">
        ${this.renderRaceWorkspaceTopBar(race, "edit")}

        <div class="races-page-stack is-mre-stack">
          ${renderMobileRaceEditorHtml(race, this.mobileEditorUi)}
        </div>
      </div>`;
  }

  private renderCanvasControlView(race: RaceTournamentState): string {
    const isOpenQual = hasOpenQualifierRound(race);
    const activeMobileView =
      this.mobileControlView === "queue" && !isOpenQual ? "live" : this.mobileControlView;

    return `
      <div class="races-page is-control-page" data-rc-page="control" data-mobile-ctrl-view="${activeMobileView}">
        ${this.renderRaceWorkspaceTopBar(race, "control")}

        ${this.renderControlCockpitPanel(race)}

        <div class="races-page-stack">
          ${this.renderControlHeatLinePanel(race)}
          ${this.renderControlFlightLinePanel(race)}
          ${this.renderControlSchedulePanel(race)}
          ${this.renderControlStandingsPanel(race)}
          ${this.renderControlSignalsPanel(race)}
        </div>
      </div>`;
  }

  private renderTransportButtons(heat: RaceHeat, race: RaceTournamentState): string {
    const hid = esc(heat.id);
    const stagesList = resolveStagesList(race);
    const heatStageObj = stagesList.find((s) => s.index === heat.stageIndex);
    const stagePaused = heatStageObj?.status === "paused";
    const stageClosed = heatStageObj?.status === "completed";
    const stageDepBlocked = !!(
      heatStageObj &&
      (heatStageObj.dangling || !heatStageObj.prerequisitesMet)
    );
    const raceBlocked =
      Boolean(race.emergencyStopped) ||
      race.lifecycle === "scrapped" ||
      race.lifecycle === "completed" ||
      Boolean(race.isComplete);
    const anyOtherLive = race.heats.some(
      (o) =>
        o.id !== heat.id &&
        (o.state === "countdown" ||
          o.state === "running" ||
          (o.stageIndex === heat.stageIndex && o.state === "paused"))
    );
    const hasFilledPilot = heat.seats.some(
      (s) => s.pilotSlotIndex > 0 && s.status !== "dq" && s.status !== "dns"
    );
    const buttons: string[] = [];

    const appendRerunControl = (asPrimarySlot = false): void => {
      buttons.push(
        `<button type="button" class="btn ${asPrimarySlot ? "btn-armed race-btn-primary-slot" : "btn-ghost"}" data-ctrl="reset" data-heat-id="${hid}">
          ${icons.reset(16)}<span class="rc-lbl-full">Re-run Heat</span><span class="rc-lbl-short">Re-run</span>
        </button>`
      );
    };

    if (heat.state === "waiting") {
      buttons.push(
        `<button type="button" class="btn btn-ghost" disabled>${
          stageDepBlocked
            ? "Waiting on upstream stage completion…"
            : "Waiting on feeder heats to finish…"
        }</button>`
      );
    } else if (heat.state === "ready" || heat.state === "staged") {
      const startDisabled =
        anyOtherLive || !hasFilledPilot || raceBlocked || stageClosed || stageDepBlocked || !!stagePaused;
      buttons.push(
        `<button type="button" class="btn btn-armed race-btn-primary-slot" data-ctrl="start" data-heat-id="${hid}" ${startDisabled ? "disabled" : ""}>
          ${icons.play(16)}<span>Start Heat</span>
        </button>`
      );
    } else if (heat.state === "countdown") {
      buttons.push(
        `<button type="button" class="btn btn-armed race-btn-primary-slot" disabled>
          ${icons.play(16)}<span>Starting...</span>
        </button>`,
        `<button type="button" class="btn btn-ghost rc-hide-mobile" data-ctrl="cancel" data-heat-id="${hid}">
          ${icons.close(16)}<span>Cancel Countdown</span>
        </button>`
      );
    } else if (heat.state === "running") {
      buttons.push(
        `<button type="button" class="btn btn-armed race-btn-primary-slot" data-ctrl="stop" data-heat-id="${hid}">
          ${icons.checkered(16)}<span class="rc-lbl-full">Finish Heat</span><span class="rc-lbl-short">Finish</span>
        </button>`,
        `<button type="button" class="btn btn-ghost" data-ctrl="pause" data-heat-id="${hid}">
          ${icons.pause(16)}<span class="rc-lbl-full">Pause Heat</span><span class="rc-lbl-short">Pause</span>
        </button>`
      );
    } else if (heat.state === "paused") {
      if (!stagePaused) {
        buttons.push(
          `<button type="button" class="btn btn-armed race-btn-primary-slot" data-ctrl="resume" data-heat-id="${hid}" ${raceBlocked || stageClosed || stageDepBlocked ? "disabled" : ""}>
            ${icons.play(16)}<span class="rc-lbl-full">Resume Heat</span><span class="rc-lbl-short">Resume</span>
          </button>`
        );
      }
      buttons.push(
        `<button type="button" class="btn ${stagePaused ? "btn-armed race-btn-primary-slot" : "btn-ghost"}" data-ctrl="stop" data-heat-id="${hid}">
          ${icons.checkered(16)}<span class="rc-lbl-full">Finish Heat</span><span class="rc-lbl-short">Finish</span>
        </button>`
      );
      if (!raceBlocked && !stageClosed) {
        appendRerunControl(false);
      }
    } else if (heat.state === "finished") {
      buttons.push(
        `<button type="button" class="btn btn-armed race-btn-primary-slot" data-ctrl="confirm" data-heat-id="${hid}">
          ${icons.check(16)}<span class="rc-lbl-full">Confirm Heat</span><span class="rc-lbl-short">Confirm</span>
        </button>`
      );
      if (!raceBlocked && !stageClosed) {
        appendRerunControl(false);
      }
    } else if (heat.state === "aborted") {
      if (raceBlocked || stageClosed) {
        buttons.push(
          `<button type="button" class="btn btn-armed race-btn-primary-slot" disabled>
            ${icons.play(16)}<span>Start Heat</span>
          </button>`
        );
      } else {
        appendRerunControl(true);
      }
    } else if (heat.state === "confirmed") {
      const nextStageReady = this.getNextReadyStageHeatId(race, heat);
      if (nextStageReady && nextStageReady !== heat.id) {
        const nextHeatObj = race.heats.find((h) => h.id === nextStageReady);
        buttons.push(
          `<button type="button" class="btn btn-armed race-btn-primary-slot" data-select-heat="${esc(nextStageReady)}" data-load-next-ready="1" title="Load ${esc(nextHeatObj?.shortLabel || nextStageReady)}">
            <span>Next Heat</span>${icons.arrowRight(16)}
          </button>`
        );
      } else {
        buttons.push(
          `<button type="button" class="btn btn-ghost race-btn-primary-slot" disabled>
            ${icons.check(16)}<span>Confirmed</span>
          </button>`
        );
      }
    }

    if (
      heatStageObj?.format === "open_qualifier" &&
      !stageClosed &&
      !raceBlocked
    ) {
      const stageHeats = race.heats.filter(
        (h) => h.stageIndex === heat.stageIndex && h.state !== "aborted"
      );
      const confirmedStageCount = stageHeats.filter((h) => h.state === "confirmed").length;
      const hasLiveStageHeat = stageHeats.some(
        (h) => h.state === "countdown" || h.state === "running"
      );
      if (confirmedStageCount > 0) {
        buttons.push(
          `<button type="button" class="btn btn-ghost" data-oq-act="complete_qualifier" data-stage-idx="${heat.stageIndex}" ${hasLiveStageHeat ? "disabled" : ""} title="${hasLiveStageHeat ? "Finish or pause the live heat before completing the qualifier" : "Finalize Open Qualifier results"}">
            ${icons.check(16)}<span class="rc-lbl-full">Complete Qualifier</span><span class="rc-lbl-short">End Qualifier</span>
          </button>`
        );
      }
    }

    return buttons.join("");
  }

  private renderActiveHeatTable(
    heat: RaceHeat,
    opts?: { staticRf?: boolean }
  ): string {
    const isConfirmedLocked = heat.state === "confirmed";
    const canMarshal = heat.state !== "waiting" && !isConfirmedLocked;
    const isChase = isChaseHeatId(heat.id) || heat.stageFormat === "chase_the_ace";
    const staticRf = Boolean(opts?.staticRf);
    const scope = staticRf ? "review" : "flightline";
    const scopeKey = `${scope}:${heat.id}`;

    if (
      (heat.state === "staged" || heat.state === "ready" || heat.state === "waiting") &&
      heat.seats.every((s) => s.position <= 0 && (s.laps?.length ?? 0) === 0)
    ) {
      this.seatDisplayOrderByScope.delete(`review:${heat.id}`);
    }

    const naturalSort = (a: HeatSeat, b: HeatSeat): number => {
      const aRanked = a.position > 0;
      const bRanked = b.position > 0;
      if (aRanked && bRanked && a.position !== b.position) return a.position - b.position;
      if (aRanked !== bRanked) return aRanked ? -1 : 1;
      return a.seatIndex - b.seatIndex;
    };

    let order = this.seatDisplayOrderByScope.get(scopeKey);
    const currentSeatIndices = new Set(heat.seats.map((s) => s.seatIndex));
    if (!order || order.length === 0) {
      order = [...heat.seats].sort(naturalSort).map((s) => s.seatIndex);
      this.seatDisplayOrderByScope.set(scopeKey, order);
    } else {
      const filtered = order.filter((idx) => currentSeatIndices.has(idx));
      const seen = new Set(filtered);
      for (const s of [...heat.seats].sort(naturalSort)) {
        if (!seen.has(s.seatIndex)) {
          filtered.push(s.seatIndex);
          seen.add(s.seatIndex);
        }
      }
      if (filtered.length !== order.length || filtered.some((v, i) => v !== order![i])) {
        order = filtered;
        this.seatDisplayOrderByScope.set(scopeKey, order);
      }
    }

    const indexMap = new Map<number, number>(order.map((seatIdx, idx) => [seatIdx, idx]));
    const sortedSeats = [...heat.seats].sort(
      (a, b) => (indexMap.get(a.seatIndex) ?? 999) - (indexMap.get(b.seatIndex) ?? 999)
    );

    const rows = sortedSeats
      .map((s) => this.renderSeatRow(heat, s, canMarshal, isChase, staticRf))
      .join("");

    return `
      <table class="table race-heat-table ${isConfirmedLocked ? "is-confirmed-locked" : ""}" data-heat-table="${esc(heat.id)}" data-heat-scope="${scope}" data-expected-winners="${heat.expectedWinners}">
        <colgroup>
          <col class="col-w-drag" />
          <col class="col-w-pos" />
          <col class="col-w-pilot" />
          <col class="col-w-rf" />
          <col class="col-w-laps" />
          <col class="col-w-pen" />
          <col class="col-w-timings" />
          <col class="col-w-status" />
        </colgroup>
        <thead>
          <tr>
            <th class="col-drag">
              <button
                type="button"
                class="race-sort-pos-btn"
                data-sort-heat-rows="${esc(heat.id)}"
                data-sort-table-scope="${scope}"
                title="Sort rows by position"
                aria-label="Sort rows by position"
              >${icons.arrowUpDown(13)}</button>
            </th>
            <th class="col-pos">Pos</th>
            <th class="col-pilot">Pilot</th>
            <th class="col-rf">${staticRf ? "Channel" : "Channel &amp; RF"}</th>
            <th class="col-laps">Laps</th>
            <th class="col-pen" title="Time penalty" aria-label="Penalty">${icons.hammer(19)}</th>
            <th class="col-timings"><span class="th-timings-full">Lap Timings <span class="th-sub">(click lap to drop)</span></span><span class="th-timings-flag">${staticRf ? "Best Lap" : "Signal"}</span></th>
            <th class="col-status">Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  private renderSeatRow(
    heat: RaceHeat,
    s: HeatSeat,
    canMarshal: boolean,
    isChase: boolean,
    staticRf = false
  ): string {
    if (s.pilotSlotIndex <= 0) {
      const placeholder = s.feeder?.isBye ? "Open / BYE Seat" : s.sourceLabel || "Waiting on feeder heat";
      const emptyRfLabel = formatBandChannelWithFreq(s.band, s.channel, s.frequencyMhz, false);
      return `
        <tr class="is-empty-seat" data-seat-index="${s.seatIndex}">
          <td class="col-drag"></td>
          <td class="col-pos"><span class="pos">—</span></td>
          <td class="col-pilot"><span class="note">${esc(placeholder)}</span></td>
          <td class="col-rf"><span class="badge mono">${esc(emptyRfLabel)}</span></td>
          <td class="col-laps"><span class="note mono">—</span></td>
          <td class="col-pen"><span class="note mono">—</span></td>
          <td class="race-td-timings"><span class="note">—</span></td>
          <td class="race-td-status"><span class="note">—</span></td>
        </tr>`;
    }

    const willAdvance =
      s.status !== "dq" &&
      s.status !== "dns" &&
      s.position > 0 &&
      (s.advances || (heat.expectedWinners > 0 && s.position <= heat.expectedWinners));

    const posTitle = willAdvance
      ? isChase && s.position === 1
        ? "Championship contender / advancing"
        : `Advances to next round (Top ${Math.max(1, heat.expectedWinners)})`
      : s.position > 0
        ? `Position #${s.position}`
        : "Unranked";

    const posBadge =
      s.position > 0
        ? `<span class="pos ${willAdvance ? "is-advancing" : ""}" title="${esc(posTitle)}">${s.position}</span>`
        : `<span class="pos" title="Unranked">—</span>`;

    const aceStr = isChase
      ? `<span class="race-ace-pips" title="Ace wins">${"★".repeat(Math.max(s.aceWinsAfter ?? 0, s.aceWinsBefore ?? 0)) || "0★"}</span>`
      : "";

    const hid = esc(heat.id);
    const explicitDnf = s.status === "dnf" && Boolean(s.statusOverridden);
    const seatRunOverridden = s.status === "dq" || s.status === "dns" || explicitDnf;
    const canToggleChip = canMarshal && !seatRunOverridden;
    const canOpenLapEditor = heat.state !== "waiting";

    let bestCrossingId = -1;
    let bestLapIdx = -1;
    let bestLapSec = Infinity;
    let validLapCount = 0;
    for (let i = 0; i < s.laps.length; i++) {
      const l = s.laps[i];
      if (l.lapNumber >= 1 && !l.invalidated && !seatRunOverridden && l.splitTimeSec > 0) {
        validLapCount++;
        if (l.splitTimeSec < bestLapSec) {
          bestLapSec = l.splitTimeSec;
          bestCrossingId = l.crossingId;
          bestLapIdx = i;
        }
      }
    }

    let fallbackBestLapIdx = -1;
    if (bestLapIdx === -1) {
      let fallbackBestSec = Infinity;
      for (let i = 0; i < s.laps.length; i++) {
        const l = s.laps[i];
        if (l.lapNumber >= 1 && l.splitTimeSec > 0 && l.splitTimeSec < fallbackBestSec) {
          fallbackBestSec = l.splitTimeSec;
          fallbackBestLapIdx = i;
        }
      }
    }

    const hasMoreLaps = s.laps.length > 6;
    let recentLaps = hasMoreLaps ? s.laps.slice(-6) : s.laps;
    const preserveLapIdx = bestLapIdx !== -1 ? bestLapIdx : fallbackBestLapIdx;
    if (hasMoreLaps && preserveLapIdx !== -1 && preserveLapIdx < s.laps.length - 6) {
      recentLaps = [s.laps[preserveLapIdx], ...s.laps.slice(-5)];
    }

    let featuredMobileIdx = -1;
    if (bestLapIdx !== -1) {
      featuredMobileIdx = recentLaps.indexOf(s.laps[bestLapIdx]);
    } else if (fallbackBestLapIdx !== -1) {
      featuredMobileIdx = recentLaps.indexOf(s.laps[fallbackBestLapIdx]);
    }
    if (featuredMobileIdx === -1 && recentLaps.length > 0) {
      for (let i = recentLaps.length - 1; i >= 0; i--) {
        if (!(recentLaps[i].lapNumber === 0 && i === 0)) {
          featuredMobileIdx = i;
          break;
        }
      }
      if (featuredMobileIdx === -1) {
        featuredMobileIdx = 0;
      }
    }

    const flagTitle = canMarshal
      ? `Open RSSI & lap timings editor for ${s.callsign} (${s.laps.length} ${s.laps.length === 1 ? "pass" : "passes"})`
      : `Inspect RSSI & lap timings for ${s.callsign} (${s.laps.length} ${s.laps.length === 1 ? "pass" : "passes"})`;
    const flagBtnHtml = `<button type="button" class="race-lap-flag-btn" data-open-lap-editor="${s.pilotSlotIndex}" data-heat-id="${hid}" ${canOpenLapEditor ? "" : "disabled"} title="${esc(flagTitle)}" aria-label="${esc(flagTitle)}">${icons.signal(15)}</button>`;
    const seatChShort = formatBandChannelShort(s.band, s.channel) || `R${s.channel}`;
    const mobileRssiInlineHtml = staticRf
      ? ""
      : `<div class="race-mobile-rssi-inline"><span class="race-mobile-rssi-ch mono">${esc(seatChShort)}</span><div class="race-rssi-bar"><div class="race-rssi-fill" style="--c:${s.color}; width: 6%"></div></div></div>`;

    const lapTimingsInner =
      recentLaps.length > 0
        ? `<div class="race-lap-timings-grid">${recentLaps
            .map((l, idx) => {
              const isHoleshotChip = l.lapNumber === 0 && idx === 0;
              const tag = isHoleshotChip ? "HS" : l.lapNumber < 0 ? "INV" : `L${l.lapNumber}`;
              const chipInvalid = (!isHoleshotChip && l.invalidated) || seatRunOverridden;
              const isHotLap =
                !chipInvalid &&
                validLapCount > 1 &&
                bestCrossingId !== -1 &&
                idx === featuredMobileIdx;
              const isMobileFeatured = !isHotLap && idx === featuredMobileIdx;
              const canToggleThisChip = canToggleChip && !isHoleshotChip;
              const chipTitle = isHoleshotChip
                ? `Holeshot ${l.splitTimeSec.toFixed(2)}s`
                : canToggleThisChip
                  ? l.invalidated
                    ? "Click to restore lap"
                    : "Click to drop / cross out lap"
                  : seatRunOverridden && canMarshal
                    ? "Click Status column to change from DNS / Crashed Out / DQ and restore laps"
                    : `${tag} ${l.splitTimeSec.toFixed(2)}s`;
              return `<button type="button" class="race-lap-chip mono ${isHoleshotChip ? "is-holeshot-chip" : ""} ${chipInvalid ? "is-invalid" : ""} ${l.manual ? "is-manual" : ""} ${isHotLap ? "is-hot-lap" : ""} ${isMobileFeatured ? "is-mobile-featured" : ""}" ${canToggleThisChip ? `data-toggle-lap="${l.crossingId}" data-heat-id="${hid}" data-slot-index="${s.pilotSlotIndex}"` : "disabled"} title="${esc(chipTitle)}">${isHotLap ? `<span class="race-lap-fire" aria-hidden="true">🔥 </span>` : ""}${tag} ${l.splitTimeSec.toFixed(2)}s</button>`;
            })
            .join("")}</div>${mobileRssiInlineHtml}${flagBtnHtml}`
        : `<span class="race-lap-empty-hint note">No passes yet</span>${mobileRssiInlineHtml}${flagBtnHtml}`;

    const lapTargetText =
      heat.targetLaps > 0 ? `${s.lapsCompleted}/${heat.targetLaps}` : `${s.lapsCompleted}`;
    const nextPenPreview = s.penaltySec === 0 ? 5 : s.penaltySec === 5 ? 10 : 0;
    const penTitle = canMarshal
      ? nextPenPreview > 0
        ? `Hammer +${nextPenPreview}s penalty (currently ${s.penaltySec > 0 ? `+${s.penaltySec}s` : "0s"})`
        : `Clear +${s.penaltySec}s penalty`
      : s.penaltySec > 0
        ? `+${s.penaltySec}s time penalty`
        : "No time penalty";
    const penaltyCellHtml = canMarshal
      ? `<button type="button" class="race-pen-hammer-btn mono ${s.penaltySec > 0 ? "has-penalty" : ""}" data-marshal="cycle_penalty" data-cur-penalty="${s.penaltySec}" data-heat-id="${hid}" data-slot-index="${s.pilotSlotIndex}" title="${esc(penTitle)}" aria-label="${esc(penTitle)}">${
          s.penaltySec > 0
            ? `<span class="race-pen-chip mono">+${s.penaltySec}s</span>`
            : `<span class="race-pen-empty note mono">—</span>`
        }</button>`
      : s.penaltySec > 0
        ? `<span class="race-pen-chip mono" title="+${s.penaltySec}s time penalty">+${s.penaltySec}s</span>`
        : `<span class="note mono">—</span>`;

    const statusPillCls =
      s.status === "dq"
        ? "is-bad"
        : s.status === "dns"
          ? "is-warn"
          : explicitDnf
            ? "is-warn"
            : s.status === "dnf"
              ? "is-staged"
              : s.status === "finished"
                ? "is-done"
                : s.status === "racing"
                  ? "is-live"
                  : "is-staged";
    const statusLabel =
      s.status === "dq"
        ? "Disqualified"
        : s.status === "dns"
          ? "Scratched"
          : explicitDnf
            ? "Crashed Out"
            : s.status === "dnf"
              ? s.lapsCompleted > 0
                ? "Incomplete"
                : "DNF"
              : s.status === "finished"
                ? "Finished"
                : s.status === "racing"
                  ? "Racing"
                  : "Staged";
    const statusShortLabel =
      s.status === "dq"
        ? "DQ"
        : s.status === "dns"
          ? "DNS"
          : explicitDnf || s.status === "dnf"
            ? "DNF"
            : s.status === "finished"
              ? "FIN"
              : s.status === "racing"
                ? "AIR"
                : "STG";
    const statusBadge = `<span class="race-state-pill is-table-status-pill ${statusPillCls}"><span class="rc-lbl-full">${statusLabel}</span><span class="rc-lbl-short">${statusShortLabel}</span></span>`;

    const isUnstartedHeat = heat.state === "ready" || heat.state === "staged";
    const isActiveHeat =
      heat.state === "countdown" || heat.state === "running" || heat.state === "paused";
    const normalStatusAction = isUnstartedHeat || isActiveHeat ? "set_racing" : "set_finished";
    const normalStatusPillHtml = isUnstartedHeat
      ? `<span class="race-state-pill is-table-status-pill is-staged">Staged</span>`
      : isActiveHeat
        ? `<span class="race-state-pill is-table-status-pill is-live">Racing</span>`
        : `<span class="race-state-pill is-table-status-pill is-done">Finished</span>`;
    const normalStatusLabel = isUnstartedHeat ? "Staged" : isActiveHeat ? "Racing" : "Finished";

    const menuKey = `${heat.id}:${s.pilotSlotIndex}`;
    const isMenuOpen = this.openMarshalMenuKey === menuKey;

    const statusOptions = [
      {
        action: normalStatusAction,
        pillHtml: normalStatusPillHtml,
        isCurrent: !seatRunOverridden,
      },
      {
        action: "set_dns",
        pillHtml: `<span class="race-state-pill is-table-status-pill is-warn">Scratched</span>`,
        isCurrent: s.status === "dns",
      },
      {
        action: "set_dnf",
        pillHtml: `<span class="race-state-pill is-table-status-pill is-warn">Crashed Out</span>`,
        isCurrent: explicitDnf,
      },
      {
        action: "set_dq",
        pillHtml: `<span class="race-state-pill is-table-status-pill is-bad">Disqualified</span>`,
        isCurrent: s.status === "dq",
      },
    ].filter((opt) => !opt.isCurrent);

    const statusPopoverHtml = isMenuOpen
      ? `<div class="rc-pill-swapper-popover is-status-popover" role="menu" aria-label="Pilot status">
          ${statusOptions
            .map(
              (opt) =>
                `<button type="button" class="rc-pill-swapper-option" role="menuitemradio" aria-checked="false" data-marshal="${opt.action}" data-heat-id="${hid}" data-slot-index="${s.pilotSlotIndex}">
                  ${opt.pillHtml}
                </button>`
            )
            .join("")}
        </div>`
      : "";

    const statusCellHtml = canMarshal
      ? `<div class="race-marshal-menu-wrap race-status-dropdown-wrap">
          <button
            type="button"
            class="race-state-pill is-table-status-pill ${statusPillCls} race-status-trigger ${isMenuOpen ? "is-open" : ""}"
            data-marshal-menu-toggle="${esc(menuKey)}"
            aria-haspopup="menu"
            aria-expanded="${isMenuOpen ? "true" : "false"}"
            title="Click to swap pilot status (${normalStatusLabel} / Scratched / Crashed Out / Disqualified)"
          >
            <span class="rc-lbl-full">${statusLabel}</span>
            <span class="rc-lbl-short">${statusShortLabel}</span>
            <span class="race-status-caret">${icons.chevronDown(11)}</span>
          </button>
          ${statusPopoverHtml}
        </div>`
      : statusBadge;

    const rfBadgeText = formatBandChannelWithFreq(s.band, s.channel, s.frequencyMhz, false);
    const prevShort = s.prevChannel ? formatEncodedChannelShort(s.prevChannel) || "?" : "?";
    const rfCellHtml = staticRf
      ? `<div class="race-rf-cell is-static">
          <div class="race-rf-top">
            <span class="badge mono">${esc(rfBadgeText)}</span>
            ${s.channelChanged ? `<span class="bkt-ch-delta" title="Switched from ${esc(prevShort)}">${icons.channelSwap(14)}</span>` : ""}
          </div>
        </div>`
      : `<div class="race-rf-cell">
          <div class="race-rf-top">
            <span class="badge mono">${esc(rfBadgeText)}</span>
            ${s.channelChanged ? `<span class="bkt-ch-delta" title="Switched from ${esc(prevShort)}">${icons.channelSwap(14)}</span>` : ""}
            <span class="race-rssi-val mono note">${isSlapRFMode(this.store.timingHardwareMode) ? "— dBm" : "—"}</span>
          </div>
          <div class="race-rssi-bar"><div class="race-rssi-fill" style="--c:${s.color}; width: 6%"></div></div>
        </div>`;

    const rowStatusCls =
      s.status === "dnf" && !explicitDnf ? "status-incomplete" : `status-${s.status}`;
    const canDragRow = s.pilotSlotIndex > 0;
    const dragTitle = "Drag to reorder row visually";

    return `
      <tr
        class="race-seat-row ${rowStatusCls} ${isMenuOpen ? "has-open-marshal-menu" : ""}"
        data-seat-index="${s.seatIndex}"
        data-seat-slot="${s.pilotSlotIndex}"
        data-draggable-seat="${canDragRow ? "1" : "0"}"
        style="--seat-c:${s.color}"
        ${staticRf ? "" : `data-pilot-rssi="${s.pilotSlotIndex}"`}
      >
        <td class="col-drag">
          <button
            type="button"
            class="race-row-drag-handle"
            data-seat-drag-handle
            data-heat-id="${hid}"
            data-slot-index="${s.pilotSlotIndex}"
            ${canDragRow ? "" : "disabled"}
            title="${dragTitle}"
            aria-label="Drag ${esc(s.callsign)} row"
          >${icons.grip(15)}</button>
        </td>
        <td class="col-pos">
          <div class="race-pos-cell">
            ${posBadge}
          </div>
        </td>
        <td class="col-pilot">
          <div class="race-pilot-cell">
            <span class="dot" style="--c:${s.color}"></span>
            <div class="race-pilot-name">
              <strong>${esc(s.callsign)}</strong>
              ${aceStr}
            </div>
          </div>
        </td>
        <td class="col-rf">${rfCellHtml}</td>
        <td class="col-laps">
          <div class="race-laps-count-cell">
            <span class="race-lap-count mono">${lapTargetText}</span>
          </div>
        </td>
        <td class="col-pen">${penaltyCellHtml}</td>
        <td class="race-td-timings">
          <div class="race-lap-timings-cell">
            ${lapTimingsInner}
          </div>
        </td>
        <td class="race-td-status">${statusCellHtml}</td>
      </tr>`;
  }

  private beginSeatRowDrag(downEvent: PointerEvent, handleBtn: HTMLButtonElement): void {
    const rowEl = handleBtn.closest<HTMLTableRowElement>("tr.race-seat-row");
    const tbody = rowEl?.parentElement as HTMLTableSectionElement | null;
    const tableEl = rowEl?.closest<HTMLTableElement>("table.race-heat-table");
    if (!rowEl || !tbody || !tableEl || rowEl.dataset.draggableSeat !== "1") return;

    const heatId = handleBtn.dataset.heatId ?? tableEl.dataset.heatTable ?? "";
    const draggedSlot = Number(handleBtn.dataset.slotIndex ?? rowEl.dataset.seatSlot ?? 0);
    if (!heatId || draggedSlot <= 0) return;

    const initialDraggableRows = [
      ...tbody.querySelectorAll<HTMLTableRowElement>('tr.race-seat-row[data-draggable-seat="1"]'),
    ];
    if (initialDraggableRows.length <= 1) return;

    if (downEvent.cancelable) downEvent.preventDefault();
    downEvent.stopPropagation();

    try {
      handleBtn.setPointerCapture(downEvent.pointerId);
    } catch {
      // ignore synthetic or unsupported pointer capture
    }

    const scope = tableEl.dataset.heatScope === "review" ? "review" : "flightline";
    const startX = downEvent.clientX;
    const startY = downEvent.clientY;
    const initialRowRect = rowEl.getBoundingClientRect();
    const grabOffsetY = startY - initialRowRect.top;
    const fixedLeft = initialRowRect.left;

    const cellWidths = [...rowEl.children].map((cell) => (cell as HTMLElement).offsetWidth);
    const unscaledRowW = Math.max(1, rowEl.offsetWidth || tableEl.offsetWidth);
    const scaleFactor = initialRowRect.width / unscaledRowW;

    let started = false;
    let floatingWrap: HTMLElement | null = null;

    const blockTouchScroll = (te: TouchEvent) => {
      if (te.cancelable) te.preventDefault();
    };
    window.addEventListener("touchmove", blockTouchScroll, { passive: false });

    const startDrag = (clientY: number) => {
      started = true;
      this.bktUi.activeGesture = true;
      document.body.classList.add("is-seat-row-dragging");

      const wrap = document.createElement("div");
      wrap.className = "race-seat-row-floating";
      wrap.style.width = `${unscaledRowW}px`;
      wrap.style.transformOrigin = "top left";
      wrap.style.transform = `translate3d(${fixedLeft.toFixed(1)}px, ${(clientY - grabOffsetY).toFixed(1)}px, 0) scale(${scaleFactor.toFixed(4)})`;

      const cloneTable = document.createElement("table");
      cloneTable.className = "table race-heat-table";
      cloneTable.style.width = `${unscaledRowW}px`;
      const colgroup = document.createElement("colgroup");
      cellWidths.forEach((w) => {
        const col = document.createElement("col");
        col.style.width = `${w}px`;
        colgroup.appendChild(col);
      });
      cloneTable.appendChild(colgroup);

      const cloneBody = document.createElement("tbody");
      const cloneRow = rowEl.cloneNode(true) as HTMLTableRowElement;
      cloneRow.classList.remove("is-drag-placeholder", "has-open-marshal-menu");
      cloneRow.classList.add("is-floating-clone-row");
      cloneBody.appendChild(cloneRow);
      cloneTable.appendChild(cloneBody);
      wrap.appendChild(cloneTable);
      document.body.appendChild(wrap);

      floatingWrap = wrap;
      rowEl.classList.add("is-drag-placeholder");
    };

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!started) {
        if (Math.hypot(dx, dy) < 4) return;
        startDrag(ev.clientY);
      }
      if (!floatingWrap) return;
      if (ev.cancelable) ev.preventDefault();

      floatingWrap.style.transform = `translate3d(${fixedLeft.toFixed(1)}px, ${(ev.clientY - grabOffsetY).toFixed(1)}px, 0) scale(${scaleFactor.toFixed(4)})`;

      const items = [
        ...tbody.querySelectorAll<HTMLTableRowElement>('tr.race-seat-row[data-draggable-seat="1"]'),
      ];
      const currentIdx = items.indexOf(rowEl);
      if (currentIdx < 0) return;

      for (let i = 0; i < items.length; i++) {
        const other = items[i];
        if (other === rowEl) continue;
        const r = other.getBoundingClientRect();
        const midY = r.top + r.height / 2;
        if (currentIdx < i && ev.clientY > midY) {
          tbody.insertBefore(rowEl, other.nextElementSibling);
          break;
        }
        if (currentIdx > i && ev.clientY < midY) {
          tbody.insertBefore(rowEl, other);
          break;
        }
      }
    };

    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("touchmove", blockTouchScroll);
      try {
        if (handleBtn.hasPointerCapture(downEvent.pointerId)) {
          handleBtn.releasePointerCapture(downEvent.pointerId);
        }
      } catch {
        // ignore
      }
      document.body.classList.remove("is-seat-row-dragging");
      if (floatingWrap) {
        floatingWrap.remove();
        floatingWrap = null;
      }

      if (!started) {
        return;
      }

      rowEl.classList.remove("is-drag-placeholder");

      const nextSeatIndices = [
        ...tbody.querySelectorAll<HTMLTableRowElement>("tr[data-seat-index]"),
      ]
        .map((r) => Number(r.dataset.seatIndex))
        .filter((n) => Number.isFinite(n));
      if (nextSeatIndices.length > 0) {
        this.seatDisplayOrderByScope.set(`${scope}:${heatId}`, nextSeatIndices);
      }

      this.bktUi.activeGesture = false;
      this.renderIfNeeded();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  }

  private renderScheduleTable(
    race: RaceTournamentState,
    activeHeatId: string,
    stageFilter?: number
  ): string {
    const baseHeats = stageFilter
      ? race.heats.filter((h) => h.stageIndex === stageFilter)
      : race.heats;
    if (baseHeats.length === 0) {
      return `<div class="race-empty-state"><p>No heats scheduled yet${stageFilter ? ` for Stage ${stageFilter}` : ""}.</p></div>`;
    }
    const filtered = baseHeats.filter((h) => {
      if (this.scheduleFilter === "upcoming") return h.state !== "confirmed";
      if (this.scheduleFilter === "done") return h.state === "confirmed";
      return true;
    });
    if (filtered.length === 0) {
      return `<div class="race-empty-state"><p>No heats match this filter.</p></div>`;
    }
    const hasLiveRunningHeat = race.heats.some(
      (xh) => xh.state === "running" || xh.state === "countdown"
    );
    return `
      <div class="table-scroll">
        <table class="table rc-compact-table rc-schedule-table">
          <thead>
            <tr>
              <th style="width:34px">#</th>
              <th class="rc-sched-col-heat">Heat</th>
              <th class="rc-sched-col-jump" aria-label="Navigate to heat in stage graph"></th>
              <th class="rc-sched-col-status">Status</th>
              <th class="rc-sched-col-lineup">Lineup</th>
              <th class="rc-sched-col-action" style="width:66px"></th>
            </tr>
          </thead>
          <tbody>
            ${filtered
              .map((h) => {
                const b = heatStateBadge(h.state, h.inOvertime, h.note);
                const isInspectable =
                  h.state === "confirmed" ||
                  h.state === "finished" ||
                  h.state === "aborted";
                const isStageable =
                  h.state === "ready" ||
                  h.state === "staged" ||
                  h.state === "paused" ||
                  h.state === "running" ||
                  h.state === "countdown";
                const isCur = h.id === activeHeatId && isStageable;
                const actionBtnHtml = isInspectable
                  ? `<button type="button" class="btn btn-ghost btn-xs" data-select-heat="${esc(h.id)}" title="Inspect ${esc(h.shortLabel)} in Review">Inspect</button>`
                  : isCur
                    ? `<button type="button" class="btn btn-armed btn-xs" data-select-heat="${esc(h.id)}" title="Open ${esc(h.shortLabel)} in Run">Active</button>`
                    : isStageable
                      ? `<button type="button" class="btn btn-ghost btn-xs" data-select-heat="${esc(h.id)}" ${hasLiveRunningHeat ? "disabled" : ""} title="${hasLiveRunningHeat ? "Pause or finish the running heat before staging another heat" : `Stage ${esc(h.shortLabel)} on the flight line`}">Stage</button>`
                      : "";
                const statusIconCls =
                  h.state === "confirmed"
                    ? "is-confirmed"
                    : h.state === "finished"
                      ? "is-review"
                      : h.state === "running" || h.state === "countdown"
                        ? "is-confirmed"
                        : h.state === "paused" || h.state === "stopped"
                          ? "is-paused"
                          : "is-pending";
                const statusIconSvg =
                  h.state === "confirmed"
                    ? icons.check(16)
                    : h.state === "finished"
                      ? icons.eye(16)
                      : h.state === "running" || h.state === "countdown"
                        ? icons.play(15)
                        : h.state === "paused" || h.state === "stopped"
                          ? icons.pause(15)
                          : icons.clock(15);
                const lineup = h.seats
                  .map((s) => {
                    const chShort = formatBandChannelShort(s.band, s.channel) || `R${s.channel}`;
                    const hasSourcePlaceholder =
                      s.pilotSlotIndex <= 0 &&
                      !s.feeder?.isBye &&
                      Boolean(
                        s.sourceLabel &&
                          s.sourceLabel !== "Open / BYE" &&
                          s.sourceLabel !== "BYE"
                      );
                    return s.pilotSlotIndex > 0
                      ? `<span class="sched-pilot-chip ${s.status === "dns" ? "is-tbd" : ""}"><span class="dot" style="--c:${s.color}"></span><span class="sched-chip-text"><span class="sched-chip-ch mono">${esc(chShort)}</span><span class="sched-chip-name">${esc(s.callsign)}${s.status === "dns" ? " (DNS)" : s.advances && h.state === "confirmed" ? " ✓" : ""}</span></span></span>`
                      : `<span class="sched-pilot-chip is-tbd">${hasSourcePlaceholder ? `<span class="dot is-hollow"></span>` : ""}<span class="sched-chip-text"><span class="sched-chip-ch mono">${esc(chShort)}</span><span class="sched-chip-name">${esc(s.feeder?.isBye ? "BYE" : s.sourceLabel || "TBD")}</span></span></span>`;
                  })
                  .join("");
                return `
                  <tr class="${isCur ? "is-selected-row" : ""}">
                    <td class="mono note">${h.order}</td>
                    <td class="rc-sched-col-heat">
                      <strong class="rc-sched-heat-label">${esc(h.shortLabel)}</strong>
                    </td>
                    <td class="rc-sched-col-jump">
                      ${this.renderHeatGraphJumpBtn(h, { iconSize: 12 })}
                    </td>
                    <td class="rc-sched-col-status">
                      <span class="race-state-pill ${b.cls} rc-exec-status-pill">${esc(b.label)}</span>
                      <span class="rc-exec-status-icon ${statusIconCls}" title="${esc(b.label)}" aria-label="${esc(b.label)}">${statusIconSvg}</span>
                    </td>
                    <td class="rc-sched-col-lineup"><div class="sched-lineup-wrap"><button type="button" class="sched-lineup-cue is-left" data-lineup-scroll="-1" aria-label="Scroll lineup left" title="Scroll left" hidden>${icons.chevronLeft(12)}</button><div class="sched-lineup" data-fit-lineup>${lineup}</div><button type="button" class="sched-lineup-cue is-right" data-lineup-scroll="1" aria-label="Scroll lineup right" title="More pilots" hidden>${icons.chevronRight(12)}</button></div></td>
                    <td class="rc-sched-col-action" style="text-align:right">
                      ${actionBtnHtml}
                    </td>
                  </tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>`;
  }

  private renderStandingsTable(race: RaceTournamentState): string {
    const list: TournamentStanding[] =
      this.standingsStage === "qualifying" && race.qualStandings
        ? race.qualStandings
        : race.standings;
    if (!list || list.length === 0) {
      return `<div class="race-empty-state"><p>Standings will populate once heats are generated.</p></div>`;
    }

    const resolveGroup = (
      st: TournamentStanding
    ): { key: string; label: string; tone: "good" | "info" | "warn" | "muted" } => {
      const bs = (st.bracketStatus || "").trim();
      if (
        bs === "Champion" ||
        bs.startsWith("Finals") ||
        bs === "Grand Final" ||
        /^\d+(st|nd|rd|th)$/.test(bs)
      ) {
        return { key: "finals", label: "Finals", tone: "good" };
      }
      if (bs.startsWith("Winners")) {
        return { key: "winners", label: "Winners Bracket", tone: "good" };
      }
      if (bs.startsWith("Losers")) {
        return { key: "losers", label: "Losers Bracket", tone: "warn" };
      }
      if (bs.startsWith("Eliminated")) {
        return { key: "eliminated", label: "Eliminated", tone: "muted" };
      }
      if (bs.startsWith("Cut")) {
        return { key: "cut", label: "Eliminated (Below Cutoff)", tone: "muted" };
      }
      if (bs.startsWith("Seed #")) {
        return { key: "advancing", label: "Advancing", tone: "good" };
      }
      if (bs.endsWith("Main")) {
        return {
          key: `main:${bs}`,
          label: bs,
          tone: bs === "A Main" ? "good" : "info",
        };
      }
      if (bs === "Qualifying" || bs === "Open Qualifier") {
        return { key: "qualifying", label: bs, tone: "info" };
      }
      return { key: `other:${bs}`, label: bs || "Standings", tone: "info" };
    };

    const groups = list.map(resolveGroup);
    const uniqueKeys = new Set(groups.map((g) => g.key));
    const showGroupHeaders =
      uniqueKeys.size > 1 ||
      groups.some(
        (g) =>
          g.key === "finals" ||
          g.key === "winners" ||
          g.key === "losers" ||
          g.key === "eliminated" ||
          g.key === "cut" ||
          g.key.startsWith("main:")
      );

    let lastGroupKey = "";
    const rowsHtml: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const st = list[i];
      const grp = groups[i];
      if (showGroupHeaders && grp.key !== lastGroupKey) {
        lastGroupKey = grp.key;
        let countInGroup = 0;
        for (let j = i; j < groups.length && groups[j].key === grp.key; j++) {
          countInGroup++;
        }
        rowsHtml.push(`
          <tr class="rc-std-group-row tone-${grp.tone}">
            <td colspan="7">
              <div class="rc-std-group-bar">
                <span class="rc-std-group-label">${esc(grp.label)}</span>
                <span class="rc-std-group-count mono">${countInGroup}</span>
              </div>
            </td>
          </tr>`);
      }

      const isChamp = st.bracketStatus === "Champion";
      rowsHtml.push(`
        <tr class="${grp.key === "eliminated" || grp.key === "cut" ? "is-std-eliminated" : ""}">
          <td><span class="pos ${st.rank === 1 ? "is-leader" : ""}">${st.rank}</span></td>
          <td>
            <div class="race-pilot-cell">
              <span class="dot" style="--c:${st.color}"></span>
              <strong>${esc(st.callsign)}</strong>
              ${isChamp ? `<span class="badge badge-good rc-std-champ-tag">Champion</span>` : ""}
              <span class="note mono rc-hide-mobile">#${st.seed}</span>
            </div>
          </td>
          <td class="mono rc-std-col-wh">${st.wins}${st.aceWins > 0 ? `(${st.aceWins}★)` : ""}/${st.heatsFlown}</td>
          <td class="mono rc-std-col-secondary">${st.points}</td>
          <td class="mono rc-std-col-secondary">${st.totalLaps}</td>
          <td class="mono">${formatShortSec(st.bestLapSec)}</td>
          <td class="mono">${formatShortSec(st.bestConsecutive3Sec)}</td>
        </tr>`);
    }

    return `
      <div class="table-scroll">
        <table class="table rc-compact-table rc-standings-table">
          <thead>
            <tr>
              <th style="width:34px">#</th>
              <th>Pilot</th>
              <th class="rc-std-col-wh" title="Wins / Heats Flown">W/H</th>
              <th class="rc-std-col-secondary">Pts</th>
              <th class="rc-std-col-secondary">Laps</th>
              <th>Best</th>
              <th>3-Lap</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml.join("")}
          </tbody>
        </table>
      </div>`;
  }

  private animateTopLeftDrawerIfNeeded(
    prevGroup: "" | "configure" | "control",
    nextGroup: "configure" | "control",
    sameRace: boolean
  ): void {
    if (!sameRace || !prevGroup || prevGroup === nextGroup) return;
    const drawer = this.el.querySelector<HTMLElement>("[data-rc-configure-drawer]");
    if (!drawer) return;
    if (nextGroup === "control") {
      drawer.classList.add("is-open");
      drawer.classList.remove("is-collapsed");
      void drawer.offsetWidth;
      drawer.classList.remove("is-open");
      drawer.classList.add("is-collapsed");
    } else {
      drawer.classList.add("is-collapsed");
      drawer.classList.remove("is-open");
      void drawer.offsetWidth;
      drawer.classList.remove("is-collapsed");
      drawer.classList.add("is-open");
    }
  }

  private animateSetupViewToggleIfNeeded(
    prevView: "" | DesktopSetupViewMode,
    nextView: DesktopSetupViewMode,
    sameRace: boolean
  ): void {
    if (!sameRace || !prevView || prevView === nextView) return;
    const toggle = this.el.querySelector<HTMLElement>("[data-setup-view-switcher]");
    if (!toggle) return;
    toggle.dataset.activeView = prevView;
    void toggle.offsetWidth;
    toggle.dataset.activeView = nextView;
  }

  private maybeAutoPromptTemplatePicker(race: RaceTournamentState, stagesList: RaceStage[]): void {
    if (!this.isViewActive || this.showDirectory || this.isMobileViewport()) return;
    if (this.activeTab !== "format" && this.activeTab !== "edit") return;
    if (!race.raceId || race.generated) return;
    if (stagesList.length > 0 || (race.rounds?.length ?? 0) > 0 || race.heats.length > 0) return;
    if (this.promptedTemplateRaceIds.has(race.raceId)) return;

    this.promptedTemplateRaceIds.add(race.raceId);
    requestAnimationFrame(() => {
      if (this.disposed || !this.isViewActive || this.showDirectory) return;
      if (this.activeTab !== "format" && this.activeTab !== "edit") return;
      if (document.querySelector(".slaprf-modal-backdrop")) return;
      const cur = this.currentRace;
      if (
        cur.raceId === race.raceId &&
        !cur.generated &&
        resolveStagesList(cur).length === 0 &&
        (cur.rounds?.length ?? 0) === 0 &&
        cur.heats.length === 0
      ) {
        this.openTemplatesDialog(true);
      }
    });
  }

  private render(): void {
    this.raceSignalsChartEl?.remove();
    this.raceTrackEl?.remove();
    this.raceAnalyticsEl?.remove();
    const race = this.currentRace;
    const allRaces = this.getEffectiveRaces();
    this.lastSig = this.computeSig(race, this.getActiveHeatForRace(race));

    if (this.showDirectory || allRaces.length === 0 || !race.raceId) {
      this.dismissAutoPromptTemplateModal();
      closeActiveRoundModal();
      closeActiveDesktopTableModal();
      closeActiveLapEditorModal();
      closeActivePilotLapsModal();
      this.disposeRaceSignalsChart();
      this.disposeRaceTrackView();
      this.disposeRaceAnalyticsView();
      this.prevRenderedModeGroup = "";
      this.prevRenderedModeRaceId = "";
      this.prevRenderedSetupView = "";
      this.el.innerHTML = `
        <div class="settings">
          ${this.renderDirectoryView()}
        </div>`;
      this.mountActiveRaceTagEditor(true);
      this.pendingFocusRaceId = "";
      setRacesTopBarContext({
        tab: "directory",
        raceId: "",
        raceName: "",
        activeStage: 1,
        totalStages: 1,
        stageTitle: "",
      });
      return;
    }

    if (this.activeTab !== "control") {
      this.disposeRaceSignalsChart();
    }
    if (this.activeTab !== "track") {
      this.disposeRaceTrackView();
    }
    if (this.activeTab !== "analytics") {
      this.disposeRaceAnalyticsView();
    }

    const savedScroll = this.captureScrollPositions(this.el);
    const prevModeGroup = this.prevRenderedModeGroup;
    const prevSetupView = this.prevRenderedSetupView;
    const sameModeRace = this.prevRenderedModeRaceId === race.raceId;
    const nextModeGroup: "configure" | "control" =
      this.activeTab === "format" || this.activeTab === "edit" ? "configure" : "control";
    this.prevRenderedModeGroup = nextModeGroup;
    this.prevRenderedModeRaceId = race.raceId;
    this.prevRenderedSetupView = nextModeGroup === "configure" ? this.desktopSetupView : "";
    if (this.activeTab === "format" || this.activeTab === "edit") {
      this.lastConfigureTab = this.activeTab;
    }

    const stagesList = resolveStagesList(race);
    if (
      this.autoPromptTemplateClose &&
      (race.raceId !== this.autoPromptTemplateRaceId ||
        (this.activeTab !== "format" && this.activeTab !== "edit") ||
        race.generated ||
        stagesList.length > 0 ||
        (race.rounds?.length ?? 0) > 0 ||
        race.heats.length > 0)
    ) {
      this.dismissAutoPromptTemplateModal();
    }
    const curViewStage = this.getCurrentViewStage(race);
    this.syncCanvasLockToUi(this.activeTab, curViewStage);
    const curStageObj = stagesList.find((s) => s.index === curViewStage);
    const totalStagesCount = Math.max(
      1,
      stagesList.length || race.totalStages || 1
    );
    const publishWorkspaceTopBar = (): void => {
      const isOpenQual = hasOpenQualifierRound(race);
      const activeMobileView =
        this.mobileControlView === "queue" && !isOpenQual ? "live" : this.mobileControlView;
      const inRun = this.activeTab === "control" && activeMobileView === "live";
      const jumpHeat = this.getLiveJumpBannerHeat(race);
      setRacesTopBarContext({
        tab: this.activeTab,
        raceId: race.raceId,
        raceName: race.config.eventName || "Race",
        activeStage: curViewStage,
        totalStages: totalStagesCount,
        stageTitle: curStageObj ? curStageObj.title || `Stage ${curStageObj.index}` : "",
        live: this.isRaceActivelyTiming(race) || Boolean(jumpHeat),
        inRun,
        liveHeatLabel: jumpHeat ? jumpHeat.shortLabel || jumpHeat.title : "",
      });
    };
    if (!this.pendingRouteTarget && !this.resolvingRouteRaceId) {
      this.syncWorkspaceHash(false);
    }

    if (this.activeTab === "multigp") {
      this.activeTab = isRaceConfigured(race) ? "review" : "edit";
    }
    if (this.activeTab === "format") {
      this.activeTab = "edit";
    }
    if (this.activeTab === "pilots") {
      this.el.innerHTML = this.renderMobilePilotsView(race);
      this.restoreScrollPositions(this.el, savedScroll);
      publishWorkspaceTopBar();
      return;
    }

    if (this.activeTab === "track") {
      this.el.innerHTML = `
        <div class="races-page is-track-page" data-rc-page="track">
          ${this.renderRaceWorkspaceTopBar(race, "track")}
          <div class="races-page-stack" data-race-track-host></div>
        </div>`;
      this.syncRaceTrackViewDom();
      this.restoreScrollPositions(this.el, savedScroll);
      publishWorkspaceTopBar();
      return;
    }

    if (this.activeTab === "review") {
      this.el.innerHTML = this.renderCanvasReviewView(race);
      this.restoreScrollPositions(this.el, savedScroll);
      this.animateTopLeftDrawerIfNeeded(prevModeGroup, nextModeGroup, sameModeRace);
      publishWorkspaceTopBar();
      return;
    }

    if (this.activeTab === "analytics") {
      this.el.innerHTML = `
        <div class="races-page is-analytics-page" data-rc-page="analytics">
          ${this.renderRaceWorkspaceTopBar(race, "analytics")}
          <div class="races-page-stack" data-race-analytics-host></div>
        </div>`;
      this.syncRaceAnalyticsViewDom();
      this.restoreScrollPositions(this.el, savedScroll);
      publishWorkspaceTopBar();
      return;
    }

    if (this.activeTab === "edit" && this.isMobileViewport()) {
      this.el.innerHTML = this.renderMobileConfigureView(race);
      this.restoreScrollPositions(this.el, savedScroll);
      syncMobileCarouselAfterRender(this.el, this.mobileEditorUi);
      publishWorkspaceTopBar();
      return;
    }

    if (
      this.activeTab === "edit" &&
      !this.isMobileViewport() &&
      this.desktopSetupView === "table"
    ) {
      this.el.innerHTML = this.renderDesktopTableConfigureView(race);
      this.restoreScrollPositions(this.el, savedScroll);
      this.animateSetupViewToggleIfNeeded(prevSetupView, this.desktopSetupView, sameModeRace);
      syncDesktopTableAfterRender(this.el, this.desktopTableUi);
      publishWorkspaceTopBar();
      return;
    }

    if (this.activeTab === "format") {
      const fmtKey = this.cameraSlotKey("format", 1);
      const savedFmtCam = this.bktUi.stageCameras[fmtKey];
      const needsFmtFit = Boolean(
        race.raceId &&
          this.formatCamInitializedForRaceId !== race.raceId &&
          !savedFmtCam?.initialized
      );
      if (race.raceId && this.formatCamInitializedForRaceId !== race.raceId) {
        this.formatCamInitializedForRaceId = race.raceId;
        if (savedFmtCam?.initialized) {
          this.bktUi.panX = savedFmtCam.panX;
          this.bktUi.panY = savedFmtCam.panY;
          this.bktUi.zoom = savedFmtCam.zoom;
        } else {
          this.bktUi.panX = 78;
          this.bktUi.panY = 92;
          this.bktUi.zoom = 1;
        }
      }

      this.el.innerHTML = this.renderCanvasFormatView(race);
      this.restoreScrollPositions(this.el, savedScroll);
      this.animateTopLeftDrawerIfNeeded(prevModeGroup, nextModeGroup, sameModeRace);
      this.maybeAutoPromptTemplatePicker(race, stagesList);
      publishWorkspaceTopBar();

      drawFormatWires(this.el, this.currentRace, this.bktUi);
      const applyFormatFit = (): void => {
        const cur = this.currentRace;
        const vp = this.el.querySelector<HTMLElement>("[data-rc-viewport]");
        fitCanvasToFormatStages(vp, cur, this.bktUi);
        this.bktUi.stageCameras[fmtKey] = {
          panX: this.bktUi.panX,
          panY: this.bktUi.panY,
          zoom: this.bktUi.zoom,
          initialized: true,
        };
        if (cur.raceId) {
          persistStoredRaceCameras(cur.raceId, this.bktUi.stageCameras);
        }
      };

      if (needsFmtFit && this.el.clientWidth > 0) {
        applyFormatFit();
      }

      requestAnimationFrame(() => {
        if (!this.disposed && !this.showDirectory && this.activeTab === "format") {
          drawFormatWires(this.el, this.currentRace, this.bktUi);
          if (needsFmtFit) {
            applyFormatFit();
          }
        }
      });
      return;
    }

    if (this.activeTab === "edit") {
      const camKey = this.cameraSlotKey("edit", curViewStage);
      const savedEditCam = this.bktUi.stageCameras[camKey];
      const rootStage = isRootStage(race, curViewStage);
      const needsInitialFit = Boolean(
        race.raceId &&
          this.bktUi.cameraInitializedForRaceId !== race.raceId &&
          !savedEditCam?.initialized
      );
      if (race.raceId && this.bktUi.cameraInitializedForRaceId !== race.raceId) {
        this.bktUi.cameraInitializedForRaceId = race.raceId;
        if (savedEditCam?.initialized) {
          this.bktUi.panX = savedEditCam.panX;
          this.bktUi.panY = savedEditCam.panY;
          this.bktUi.zoom = savedEditCam.zoom;
        } else {
          const initRounds = (race.rounds ?? []).filter((r) => r.stageIndex === curViewStage);
          if (initRounds.length === 0 && rootStage) {
            const stgObj = (race.stages ?? []).find((s) => s.index === curViewStage);
            const pX = stgObj?.pilotsNodeHasPos ? (stgObj.pilotsNodePosX ?? 0) : 96;
            const pY = stgObj?.pilotsNodeHasPos ? (stgObj.pilotsNodePosY ?? 0) : 110;
            this.bktUi.zoom = 0.96;
            this.bktUi.panX = Math.round(38 - pX * this.bktUi.zoom);
            this.bktUi.panY = Math.round(86 - pY * this.bktUi.zoom);
          } else if (!rootStage && initRounds.length === 0 && this.editPilotsPanel.visible) {
            this.bktUi.zoom = 0.96;
            this.bktUi.panX = Math.round(38 - this.editPilotsPanel.x * this.bktUi.zoom);
            this.bktUi.panY = Math.round(86 - this.editPilotsPanel.y * this.bktUi.zoom);
          } else {
            this.bktUi.panX = 72;
            this.bktUi.panY = 96;
            this.bktUi.zoom = 1;
          }
        }
      }

      this.el.innerHTML = this.renderCanvasEditView(race);
      this.restoreScrollPositions(this.el, savedScroll);
      this.animateTopLeftDrawerIfNeeded(prevModeGroup, nextModeGroup, sameModeRace);
      this.animateSetupViewToggleIfNeeded(prevSetupView, this.desktopSetupView, sameModeRace);
      this.maybeAutoPromptTemplatePicker(race, stagesList);
      publishWorkspaceTopBar();

      drawBracketWires(this.el, this.currentRace, this.bktUi);
      const applyEditFit = (): void => {
        const cur = this.currentRace;
        const stageRounds = (cur.rounds ?? []).filter(
          (r) => r.stageIndex === curViewStage
        );
        if (stageRounds.length > 0) {
          fitCanvasToNodes(this.el, this.bktUi);
        } else if (rootStage) {
          const stgObj = (cur.stages ?? []).find(
            (s) => s.index === curViewStage
          );
          const pX = stgObj?.pilotsNodeHasPos ? (stgObj.pilotsNodePosX ?? 0) : 96;
          const pY = stgObj?.pilotsNodeHasPos ? (stgObj.pilotsNodePosY ?? 0) : 110;
          this.bktUi.zoom = 0.96;
          this.bktUi.panX = Math.round(38 - pX * this.bktUi.zoom);
          this.bktUi.panY = Math.round(86 - pY * this.bktUi.zoom);
          const vp = this.el.querySelector<HTMLElement>("[data-rc-viewport]");
          if (vp) applyCanvasCameraDom(vp, this.bktUi);
        } else if (this.editPilotsPanel.visible) {
          this.bktUi.zoom = 0.96;
          this.bktUi.panX = Math.round(38 - this.editPilotsPanel.x * this.bktUi.zoom);
          this.bktUi.panY = Math.round(86 - this.editPilotsPanel.y * this.bktUi.zoom);
          const vp = this.el.querySelector<HTMLElement>("[data-rc-viewport]");
          if (vp) applyCanvasCameraDom(vp, this.bktUi);
        }
        this.bktUi.stageCameras[camKey] = {
          panX: this.bktUi.panX,
          panY: this.bktUi.panY,
          zoom: this.bktUi.zoom,
          initialized: true,
        };
        if (cur.raceId) {
          persistStoredRaceCameras(cur.raceId, this.bktUi.stageCameras);
        }
      };

      if (needsInitialFit && this.el.clientWidth > 0) {
        applyEditFit();
      }

      requestAnimationFrame(() => {
        if (!this.disposed && !this.showDirectory && this.activeTab === "edit") {
          drawBracketWires(this.el, this.currentRace, this.bktUi);
          if (needsInitialFit) {
            applyEditFit();
          }
        }
      });
      return;
    }

    this.el.innerHTML = this.renderCanvasControlView(race);
    this.restoreScrollPositions(this.el, savedScroll);
    this.animateTopLeftDrawerIfNeeded(prevModeGroup, nextModeGroup, sameModeRace);

    this.syncRaceSignalsChartDom();
    fitScheduleLineups(this.el);
    scanTableScrollIndicators(this.el);
    this.updateLiveClockDom();
    this.updateLiveRssiDom();
    publishWorkspaceTopBar();
  }
}
