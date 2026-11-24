import { capabilitiesSnapshot } from "../services/capabilities";
import { icons } from "./icons";

export type RouteId =
  | "practice"
  | "races"
  | "ai"
  | "pilot"
  | "pilots"
  | "laprf-emulator"
  | "sim"
  | "network"
  | "setup"
  | "flasher"
  | "debug"
  | "about";

export type AITrainingTab = "collect" | "review" | "train";

export interface AITrainingRouteTarget {
  tab: AITrainingTab;
  sessionId?: string;
}

export type RacesViewTab =
  | "pilots"
  | "track"
  | "format"
  | "edit"
  | "control"
  | "review"
  | "analytics"
  | "multigp"
  | "directory";
export type PracticeViewTab = "directory" | "session";
export type AnalyticsScopeKind = "practice" | "race";

export interface AnalyticsScope {
  kind: AnalyticsScopeKind;
  id: string;
}

export interface AnalyticsTopBarContext {
  mode?: "chooser" | "scope";
  scopeKind: AnalyticsScopeKind;
  scopeId: string;
  scopeName: string;
  scopeLive: boolean;
}

export interface RacesTopBarContext {
  tab: RacesViewTab;
  raceId?: string;
  raceName: string;
  activeStage: number;
  totalStages: number;
  stageTitle: string;
  live?: boolean;
}

export interface PracticeTopBarContext {
  tab: PracticeViewTab;
  sessionId?: string;
  sessionName: string;
  active: boolean;
}

export interface RacesRouteTarget {
  tab: RacesViewTab;
  raceKey?: string;
  stage?: number;
}

export interface PracticeRouteTarget {
  tab: PracticeViewTab;
  sessionId?: string;
  pane?: string;
}

export interface ParsedHashState {
  route: RouteId;
  races?: RacesRouteTarget;
  practice?: PracticeRouteTarget;
  live?: PracticeRouteTarget;
  ai?: AITrainingRouteTarget;
  analytics?: AnalyticsScope | null;
  sectionAnchor?: string;
}

export type RacesTopBarCommand =
  | { type: "set-tab"; tab: RacesViewTab; raceKey?: string; stage?: number }
  | { type: "set-stage"; stage: number };

export type PracticeTopBarCommand = {
  type: "set-tab";
  tab: PracticeViewTab;
  sessionId?: string;
};

let pendingRacesTab: RacesViewTab | null = null;
let pendingRacesStage: number | null = null;
let currentRacesContext: RacesTopBarContext = {
  tab: "directory",
  raceId: "",
  raceName: "",
  activeStage: 1,
  totalStages: 1,
  stageTitle: "",
};
const racesContextListeners = new Set<() => void>();
const racesCommandListeners = new Set<(cmd: RacesTopBarCommand) => void>();
const racesRouteListeners = new Set<(target: RacesRouteTarget) => void>();

let pendingPracticeTab: PracticeViewTab | null = null;
let currentPracticeContext: PracticeTopBarContext = {
  tab: "directory",
  sessionId: "",
  sessionName: "",
  active: false,
};
const practiceContextListeners = new Set<() => void>();
const practiceCommandListeners = new Set<(cmd: PracticeTopBarCommand) => void>();
const practiceRouteListeners = new Set<(target: PracticeRouteTarget) => void>();
const aiRouteListeners = new Set<(target: AITrainingRouteTarget) => void>();

export function onAITrainingRouteTargetChange(
  fn: (target: AITrainingRouteTarget) => void
): () => void {
  aiRouteListeners.add(fn);
  return () => aiRouteListeners.delete(fn);
}

const sectionAnchorListeners = new Set<(anchor: string, route: RouteId) => void>();

export function setPracticeTopBarContext(next: PracticeTopBarContext): void {
  if (
    currentPracticeContext.tab === next.tab &&
    (currentPracticeContext.sessionId ?? "") === (next.sessionId ?? "") &&
    currentPracticeContext.sessionName === next.sessionName &&
    currentPracticeContext.active === next.active
  ) {
    return;
  }
  currentPracticeContext = { ...next };
  practiceContextListeners.forEach((fn) => fn());
}

export function getPracticeTopBarContext(): PracticeTopBarContext {
  return currentPracticeContext;
}

export function onPracticeTopBarContextChange(fn: () => void): () => void {
  practiceContextListeners.add(fn);
  return () => practiceContextListeners.delete(fn);
}

export function dispatchPracticeTopBarCommand(cmd: PracticeTopBarCommand): void {
  practiceCommandListeners.forEach((fn) => fn(cmd));
}

export function onPracticeTopBarCommand(fn: (cmd: PracticeTopBarCommand) => void): () => void {
  practiceCommandListeners.add(fn);
  return () => practiceCommandListeners.delete(fn);
}

export function onPracticeRouteTargetChange(
  fn: (target: PracticeRouteTarget) => void
): () => void {
  practiceRouteListeners.add(fn);
  return () => practiceRouteListeners.delete(fn);
}

export function requestPracticeTab(tab: PracticeViewTab): void {
  pendingPracticeTab = tab;
}

export function consumePendingPracticeTab(): PracticeViewTab | null {
  const t = pendingPracticeTab;
  pendingPracticeTab = null;
  return t;
}

export function setRacesTopBarContext(next: RacesTopBarContext): void {
  if (
    currentRacesContext.tab === next.tab &&
    (currentRacesContext.raceId ?? "") === (next.raceId ?? "") &&
    currentRacesContext.raceName === next.raceName &&
    currentRacesContext.activeStage === next.activeStage &&
    currentRacesContext.totalStages === next.totalStages &&
    currentRacesContext.stageTitle === next.stageTitle &&
    Boolean(currentRacesContext.live) === Boolean(next.live)
  ) {
    return;
  }
  currentRacesContext = { ...next };
  racesContextListeners.forEach((fn) => fn());
}

export function getRacesTopBarContext(): RacesTopBarContext {
  return currentRacesContext;
}

export function onRacesTopBarContextChange(fn: () => void): () => void {
  racesContextListeners.add(fn);
  return () => racesContextListeners.delete(fn);
}

export function dispatchRacesTopBarCommand(cmd: RacesTopBarCommand): void {
  racesCommandListeners.forEach((fn) => fn(cmd));
}

export function onRacesTopBarCommand(fn: (cmd: RacesTopBarCommand) => void): () => void {
  racesCommandListeners.add(fn);
  return () => racesCommandListeners.delete(fn);
}

export function onRacesRouteTargetChange(fn: (target: RacesRouteTarget) => void): () => void {
  racesRouteListeners.add(fn);
  return () => racesRouteListeners.delete(fn);
}

export function onSectionAnchorChange(
  fn: (anchor: string, route: RouteId) => void
): () => void {
  sectionAnchorListeners.add(fn);
  return () => sectionAnchorListeners.delete(fn);
}

const ANALYTICS_SCOPE_STORAGE_KEY = "slaprf.ui.analyticsScope.v1";

function loadInitialAnalyticsScope(): AnalyticsScope | null {
  try {
    const raw = window.localStorage.getItem(ANALYTICS_SCOPE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AnalyticsScope>;
    if (
      (parsed.kind === "practice" || parsed.kind === "race") &&
      typeof parsed.id === "string"
    ) {
      return { kind: parsed.kind, id: parsed.id.trim() };
    }
  } catch {
    // Ignore storage access errors
  }
  return null;
}

let currentAnalyticsScope: AnalyticsScope | null = loadInitialAnalyticsScope();
const analyticsScopeListeners = new Set<(scope: AnalyticsScope | null) => void>();

let currentAnalyticsTopBarContext: AnalyticsTopBarContext = {
  mode: currentAnalyticsScope ? "scope" : "chooser",
  scopeKind: "practice",
  scopeId: "",
  scopeName: "Practice",
  scopeLive: false,
};
const analyticsTopBarListeners = new Set<() => void>();

export function getAnalyticsScope(): AnalyticsScope | null {
  return currentAnalyticsScope;
}

export function setAnalyticsScope(next: AnalyticsScope | null): void {
  if (
    currentAnalyticsScope?.kind === next?.kind &&
    currentAnalyticsScope?.id === next?.id
  ) {
    return;
  }
  currentAnalyticsScope = next ? { kind: next.kind, id: next.id } : null;
  try {
    if (currentAnalyticsScope) {
      window.localStorage.setItem(ANALYTICS_SCOPE_STORAGE_KEY, JSON.stringify(currentAnalyticsScope));
    } else {
      window.localStorage.removeItem(ANALYTICS_SCOPE_STORAGE_KEY);
    }
  } catch {
    // Ignore storage access errors
  }
  analyticsScopeListeners.forEach((fn) => fn(currentAnalyticsScope));
}

export function onAnalyticsScopeChange(fn: (scope: AnalyticsScope | null) => void): () => void {
  analyticsScopeListeners.add(fn);
  return () => analyticsScopeListeners.delete(fn);
}

export function setAnalyticsTopBarContext(next: AnalyticsTopBarContext): void {
  const mode = next.mode ?? (next.scopeId ? "scope" : "chooser");
  if (
    currentAnalyticsTopBarContext.mode === mode &&
    currentAnalyticsTopBarContext.scopeKind === next.scopeKind &&
    currentAnalyticsTopBarContext.scopeId === next.scopeId &&
    currentAnalyticsTopBarContext.scopeName === next.scopeName &&
    currentAnalyticsTopBarContext.scopeLive === next.scopeLive
  ) {
    return;
  }
  currentAnalyticsTopBarContext = { ...next, mode };
  analyticsTopBarListeners.forEach((fn) => fn());
}

export function getAnalyticsTopBarContext(): AnalyticsTopBarContext {
  return currentAnalyticsTopBarContext;
}

export function onAnalyticsTopBarContextChange(fn: () => void): () => void {
  analyticsTopBarListeners.add(fn);
  return () => analyticsTopBarListeners.delete(fn);
}

const SIDEBAR_COLLAPSED_KEY = "slaprf.ui.sidebarCollapsed.v1";
let sidebarCollapsedState = (() => {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
})();
const sidebarListeners = new Set<() => void>();

export function isSidebarCollapsed(): boolean {
  return sidebarCollapsedState;
}

export function setSidebarCollapsed(collapsed: boolean): void {
  if (sidebarCollapsedState === collapsed) return;
  sidebarCollapsedState = collapsed;
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Ignore storage errors
  }
  sidebarListeners.forEach((fn) => fn());
}

export function toggleSidebarCollapsed(): void {
  setSidebarCollapsed(!sidebarCollapsedState);
}

export function onSidebarCollapsedChange(fn: () => void): () => void {
  sidebarListeners.add(fn);
  return () => sidebarListeners.delete(fn);
}

export function requestRacesTab(tab: RacesViewTab): void {
  pendingRacesTab = tab;
}

export function consumePendingRacesTab(): RacesViewTab | null {
  const t = pendingRacesTab;
  pendingRacesTab = null;
  return t;
}

export function consumePendingRacesStage(): number | null {
  const s = pendingRacesStage;
  pendingRacesStage = null;
  return s;
}

export interface RouteMeta {
  id: RouteId;
  label: string;
  title: string;
  subtitle: string;
  icon: () => string;
  simOnly?: boolean;
  laprfEmulatorOnly?: boolean;
  hiddenFromNav?: boolean;
}

/** One flat level: each section of the app is a single page. */
export const ROUTES: RouteMeta[] = [
  {
    id: "races",
    label: "Race",
    title: "Race",
    subtitle: "Create & tag races, customize rounds & brackets, and run Race Control",
    icon: () => icons.trophy(20),
  },
  {
    id: "practice",
    label: "Practice",
    title: "Practice",
    subtitle: "Create & tag practice sessions, assign pilots, and review recorded laps & section splits",
    icon: () => icons.flag(20),
  },
  {
    id: "ai",
    label: "AI Training",
    title: "AI Training",
    subtitle: "Record back-to-back flight packs, verify passes, and train the on-device crossing model",
    icon: () => icons.ai(20),
  },
  {
    id: "pilots",
    label: "Pilots",
    title: "Pilots",
    subtitle: "Master directory of known pilots, phonetic callouts, default channels, and RF thresholds",
    icon: () => icons.pilot(20),
  },
  {
    id: "pilot",
    label: "Analytics",
    title: "Analytics",
    subtitle: "Pick laps and see where time was won and lost",
    icon: () => icons.chart(20),
    hiddenFromNav: true,
  },
  {
    id: "laprf-emulator",
    label: "LapRF",
    title: "LapRF Emulator",
    subtitle: "Emulate an ImmersionRC LapRF 8-Way timer over TCP :5403 for external race timing clients",
    icon: () => icons.timer(20),
    laprfEmulatorOnly: true,
  },
  {
    id: "sim",
    label: "Simulator",
    title: "Simulator",
    subtitle: "Simulated pilots, 6S flight packs, crashes, track recovery walks, and XIAO timers",
    icon: () => icons.zap(20),
    simOnly: true,
  },
  {
    id: "network",
    label: "Network",
    title: "Network",
    subtitle: "Connect to your Hub or Spoke timer over USB-C, inspect the 2.4 GHz network, and manage monitored 5.8 GHz channels",
    icon: () => icons.wifi(20),
  },
  {
    id: "flasher",
    label: "Flasher",
    title: "Flasher",
    subtitle: "Flash or read Seeed XIAO ESP32-C5 timers over USB directly from the browser",
    icon: () => icons.cpu(20),
  },
  {
    id: "debug",
    label: "Debug",
    title: "Debug",
    subtitle: "5.8 GHz SDR diagnostics: hardware self-test, 50 Hz signal recorder, spectrum analyzer, waterfall, and serial console",
    icon: () => icons.bug(20),
  },
  {
    id: "setup",
    label: "Settings",
    title: "Settings",
    subtitle: "Timing rules, announcer, LapRF emulator, data source, and persistence",
    icon: () => icons.sliders(20),
  },
  {
    id: "about",
    label: "About",
    title: "About",
    subtitle: "Version info, author, GitHub repository, support, and dual-license terms",
    icon: () => icons.about(20),
  },
];

const ROUTE_STORAGE_KEY = "slaprf.ui.route.v1";
const HASH_STORAGE_KEY = "slaprf.ui.hash.v1";
const ROUTE_HASHES_STORAGE_KEY = "slaprf.ui.routeHashes.v1";

function safeDecode(seg: string | undefined): string {
  if (!seg) return "";
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

const RESERVED_NAV_SLUGS = new Set([
  "directory",
  "pilots",
  "track",
  "format",
  "control",
  "review",
  "analytics",
  "edit",
  "stage",
  "session",
]);

function isReservedNavSlug(slug: string): boolean {
  return RESERVED_NAV_SLUGS.has(slug) || /^stage-\d+$/.test(slug);
}

function slugifyNavCore(raw: string): string {
  return (raw || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Converts a race display name into a deterministic URL slug matching Go `domain.SlugifyRaceName` 1:1.
 */
export function slugifyRaceName(name: string): string {
  const s = slugifyNavCore(name) || "race";
  return isReservedNavSlug(s) ? `${s}-race` : s;
}

/**
 * Converts a practice session display name into a deterministic URL slug matching Go `domain.SlugifyPracticeName` 1:1.
 */
export function slugifyPracticeName(name: string): string {
  const s = slugifyNavCore(name) || "practice";
  return isReservedNavSlug(s) ? `${s}-practice` : s;
}

function parseStageToken(seg: string | undefined, nextSeg?: string): number | null {
  if (!seg) return null;
  const m = /^stage-(\d+)$/i.exec(seg);
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) && n >= 1 && n <= 20 ? n : 1;
  }
  if (seg.toLowerCase() === "stage" && nextSeg) {
    const n = Number(nextSeg);
    return Number.isFinite(n) && n >= 1 && n <= 20 ? n : 1;
  }
  return null;
}

export function parseHashState(hash: string): ParsedHashState | null {
  const trimmed = (hash || "").trim();
  if (!trimmed || trimmed === "#" || trimmed === "#/") return null;

  const withoutHash = trimmed.replace(/^#\/?/, "");
  const [pathPart, inlineFrag] = withoutHash.split("#");
  const parts = pathPart.split("/").filter((p) => p.length > 0);
  const id = parts[0] ?? "";
  if (!id) return null;

  if (id === "events") {
    return { route: "races", races: { tab: "directory" } };
  }
  if (id === "race-setup") {
    return { route: "races", races: { tab: "format" } };
  }
  if (id === "race-control") {
    return { route: "races", races: { tab: "control" } };
  }

  if (id === "races" || id === "race") {
    const p1 = safeDecode(parts[1]);
    const p2 = safeDecode(parts[2]);
    const p3 = safeDecode(parts[3]);
    const p4 = safeDecode(parts[4]);

    if (!p1 || p1 === "directory") {
      return { route: "races", races: { tab: "directory" } };
    }
    // Legacy/raceless paths: `#/races/format`, `#/races/control`, `#/races/edit`, `#/races/stage/1`
    if (p1 === "format") {
      const st = parseStageToken(p2, p3);
      if (st !== null) {
        return { route: "races", races: { tab: "edit", stage: st } };
      }
      return { route: "races", races: { tab: "format" } };
    }
    if (p1 === "pilots") {
      return { route: "races", races: { tab: "pilots" } };
    }
    if (p1 === "track") {
      return { route: "races", races: { tab: "track" } };
    }
    if (p1 === "control") {
      return { route: "races", races: { tab: "control" } };
    }
    if (p1 === "review") {
      return { route: "races", races: { tab: "review" } };
    }
    if (p1 === "analytics") {
      return { route: "races", races: { tab: "analytics" } };
    }
    if (p1 === "multigp") {
      return { route: "races", races: { tab: "review" } };
    }
    if (p1 === "edit" || p1 === "setup" || p1 === "configure") {
      return { route: "races", races: { tab: "edit", stage: 1 } };
    }
    const legacyStage = parseStageToken(p1, p2);
    if (legacyStage !== null) {
      return { route: "races", races: { tab: "edit", stage: legacyStage } };
    }

    // Hierarchical race-scoped paths:
    // - `#/races/<raceKey>` or `#/races/<raceKey>/format`
    // - `#/races/<raceKey>/format/stage-1` or `#/races/<raceKey>/stage/1`
    // - `#/races/<raceKey>/control`
    const raceKey = p1;
    if (!p2 || p2 === "format") {
      const st = parseStageToken(p3, p4);
      if (st !== null) {
        return { route: "races", races: { tab: "edit", raceKey, stage: st } };
      }
      return { route: "races", races: { tab: "format", raceKey } };
    }
    if (p2 === "pilots") {
      return { route: "races", races: { tab: "pilots", raceKey } };
    }
    if (p2 === "track") {
      return { route: "races", races: { tab: "track", raceKey } };
    }
    if (p2 === "control") {
      return { route: "races", races: { tab: "control", raceKey } };
    }
    if (p2 === "review") {
      return { route: "races", races: { tab: "review", raceKey } };
    }
    if (p2 === "analytics") {
      return { route: "races", races: { tab: "analytics", raceKey } };
    }
    if (p2 === "multigp") {
      return { route: "races", races: { tab: "review", raceKey } };
    }
    if (p2 === "edit" || p2 === "setup" || p2 === "configure") {
      return { route: "races", races: { tab: "edit", raceKey, stage: 1 } };
    }
    const scopedStage = parseStageToken(p2, p3);
    if (scopedStage !== null) {
      return { route: "races", races: { tab: "edit", raceKey, stage: scopedStage } };
    }
    return { route: "races", races: { tab: "format", raceKey } };
  }

  if (id === "track") {
    const target: PracticeRouteTarget = { tab: "directory" };
    return { route: "practice", practice: target, live: target };
  }

  if (id === "practice" || id === "practices" || id === "live") {
    const p1 = safeDecode(parts[1]);
    const p2 = safeDecode(parts[2]);
    const p3 = safeDecode(parts[3]);
    if (!p1 || p1 === "directory") {
      const target: PracticeRouteTarget = { tab: "directory" };
      return { route: "practice", practice: target, live: target };
    }
    if (p1 === "session") {
      const sid = p2;
      const target: PracticeRouteTarget = sid
        ? { tab: "session", sessionId: sid, ...(p3 ? { pane: p3 } : {}) }
        : { tab: "session" };
      return {
        route: "practice",
        practice: target,
        live: target,
      };
    }
    const target: PracticeRouteTarget = {
      tab: "session",
      sessionId: p1,
      ...(p2 ? { pane: p2 } : {}),
    };
    return { route: "practice", practice: target, live: target };
  }

  if (id === "ai" || id === "ai-training") {
    const p1 = safeDecode(parts[1]).toLowerCase();
    const p2 = safeDecode(parts[2]);
    if (p1 === "review") {
      return {
        route: "ai",
        ai: p2 ? { tab: "review", sessionId: p2 } : { tab: "review" },
      };
    }
    if (p1 === "train") {
      return { route: "ai", ai: { tab: "train" } };
    }
    return { route: "ai", ai: { tab: "collect" } };
  }

  if (id === "pilot" || id === "analytics") {
    const p1 = safeDecode(parts[1]);
    const p2 = safeDecode(parts[2]);
    const p3 = safeDecode(parts[3]);
    if (p1 === "practice" || p1 === "race") {
      return {
        route: "pilot",
        analytics: { kind: p1, id: p2 || "" },
        sectionAnchor: p3 || safeDecode(inlineFrag) || undefined,
      };
    }
    return {
      route: "pilot",
      analytics: null,
      sectionAnchor: p1 || safeDecode(inlineFrag) || undefined,
    };
  }

  if (ROUTES.some((r) => r.id === id)) {
    const route = id as RouteId;
    const anchor = safeDecode(parts[1]) || safeDecode(inlineFrag);
    return {
      route,
      sectionAnchor: anchor || undefined,
    };
  }

  return null;
}

export function buildRacesHash(tab: RacesViewTab, raceId?: string, stage?: number): string {
  if (tab === "directory" || !raceId) {
    if (tab === "directory") return "#/races";
    if (tab === "pilots") return "#/races/pilots";
    if (tab === "track") return "#/races/track";
    if (tab === "control") return "#/races/control";
    if (tab === "review") return "#/races/review";
    if (tab === "analytics") return "#/races/analytics";
    if (tab === "multigp") return "#/races/multigp";
    if (tab === "edit") return `#/races/stage/${Math.max(1, stage || 1)}`;
    return "#/races/format";
  }
  const encRace = encodeURIComponent(raceId);
  if (tab === "pilots") {
    return `#/races/${encRace}/pilots`;
  }
  if (tab === "track") {
    return `#/races/${encRace}/track`;
  }
  if (tab === "control") {
    return `#/races/${encRace}/control`;
  }
  if (tab === "review") {
    return `#/races/${encRace}/review`;
  }
  if (tab === "analytics") {
    return `#/races/${encRace}/analytics`;
  }
  if (tab === "multigp") {
    return `#/races/${encRace}/multigp`;
  }
  if (tab === "edit") {
    return `#/races/${encRace}/format/stage-${Math.max(1, stage || 1)}`;
  }
  return `#/races/${encRace}/format`;
}

export function buildPracticeHash(tab: PracticeViewTab, sessionId?: string): string {
  if (tab === "directory") return "#/practice";
  if (sessionId) return `#/practice/${encodeURIComponent(sessionId)}`;
  return "#/practice/session";
}

export function buildAITrainingHash(tab: AITrainingTab, sessionId?: string): string {
  if (tab === "collect") return "#/ai";
  if (tab === "review") {
    return sessionId ? `#/ai/review/${encodeURIComponent(sessionId)}` : "#/ai/review";
  }
  return "#/ai/train";
}

export function buildAnalyticsHash(scope?: AnalyticsScope | null, sectionAnchor?: string): string {
  const base = !scope
    ? "#/pilot"
    : scope.id
      ? `#/pilot/${scope.kind}/${encodeURIComponent(scope.id)}`
      : `#/pilot/${scope.kind}`;
  return sectionAnchor ? `${base}/${encodeURIComponent(sectionAnchor)}` : base;
}

export function buildSectionHash(route: RouteId, sectionAnchor?: string): string {
  if (route === "pilot") {
    return buildAnalyticsHash(currentAnalyticsScope, sectionAnchor);
  }
  return sectionAnchor ? `#/${route}/${encodeURIComponent(sectionAnchor)}` : `#/${route}`;
}

/**
 * Navigates directly to a specific vertical section anchor (`#/<route>/<sectionAnchor>`),
 * scrolling smoothly even if `route` is already active or was previously cached at another scroll offset.
 */
export function navigateToRouteSection(route: RouteId, sectionAnchor: string): void {
  const targetHash = buildSectionHash(route, sectionAnchor);
  const alreadyOnRoute = activeRouterInstance?.route === route;
  if (location.hash !== targetHash) {
    pushAppHash(targetHash);
  }
  if (alreadyOnRoute) {
    sectionAnchorListeners.forEach((fn) => fn(sectionAnchor, route));
  }
}

function loadInitialRouteHashes(): Partial<Record<RouteId, string>> {
  try {
    const raw = window.localStorage.getItem(ROUTE_HASHES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Partial<Record<RouteId, string>> = {};
    for (const r of ROUTES) {
      const val = parsed[r.id];
      if (typeof val === "string" && val.startsWith("#/")) {
        out[r.id] = val;
      }
    }
    return out;
  } catch {
    return {};
  }
}

const rememberedHashByRoute: Partial<Record<RouteId, string>> = loadInitialRouteHashes();
const rememberedHashListeners = new Set<() => void>();

export function getRememberedRouteHash(route: RouteId): string {
  const saved = rememberedHashByRoute[route];
  if (saved && parseHashState(saved)?.route === route) {
    return saved;
  }
  return `#/${route}`;
}

export function onRememberedRouteHashChange(fn: () => void): () => void {
  rememberedHashListeners.add(fn);
  return () => rememberedHashListeners.delete(fn);
}

function persistLocationStorage(route: RouteId, hash: string): void {
  let routeHashChanged = false;
  if (hash && hash.startsWith("#/")) {
    const parsed = parseHashState(hash);
    if (!parsed || parsed.route === route) {
      if (rememberedHashByRoute[route] !== hash) {
        rememberedHashByRoute[route] = hash;
        routeHashChanged = true;
      }
    }
  }
  try {
    window.localStorage.setItem(ROUTE_STORAGE_KEY, route);
    if (hash && hash.startsWith("#/")) {
      window.localStorage.setItem(HASH_STORAGE_KEY, hash);
    }
    if (routeHashChanged) {
      window.localStorage.setItem(ROUTE_HASHES_STORAGE_KEY, JSON.stringify(rememberedHashByRoute));
    }
  } catch {
    // Ignore storage access errors
  }
  if (routeHashChanged) {
    rememberedHashListeners.forEach((fn) => fn());
  }
}

function notifyParsedSubRouteListeners(parsed: ParsedHashState, crossRoute = false): void {
  if (parsed.route === "races" && parsed.races) {
    racesRouteListeners.forEach((fn) => fn(parsed.races!));
  } else if (parsed.route === "practice" && (parsed.practice || parsed.live)) {
    const target = (parsed.practice ?? parsed.live)!;
    practiceRouteListeners.forEach((fn) => fn(target));
  } else if (parsed.route === "ai" && parsed.ai) {
    aiRouteListeners.forEach((fn) => fn(parsed.ai!));
  } else if (!crossRoute) {
    sectionAnchorListeners.forEach((fn) => fn(parsed.sectionAnchor ?? "", parsed.route));
  }
}

let activeRouterInstance: Router | null = null;
const allRouterInstances = new Set<Router>();
let currentParsedHashState: ParsedHashState = { route: "races", races: { tab: "directory" } };

export function resetRouterStateForTest(): void {
  for (const inst of Array.from(allRouterInstances)) {
    inst.destroyWindowListeners();
  }
  allRouterInstances.clear();
  activeRouterInstance = null;
  currentParsedHashState = { route: "races", races: { tab: "directory" } };
  pendingRacesTab = null;
  pendingRacesStage = null;
  pendingPracticeTab = null;
}

export function getCurrentParsedHash(): ParsedHashState {
  return parseHashState(location.hash) ?? currentParsedHashState;
}

/**
 * Pushes a new browser history entry so Back and Forward buttons step through
 * hierarchical navigation states cleanly without triggering redundant hashchange loops.
 */
export function pushAppHash(hash: string): void {
  const normalized = hash.startsWith("#") ? hash : `#/${hash.replace(/^\/+/, "")}`;
  const parsed = parseHashState(normalized);
  if (parsed) {
    applyParsedSideEffects(parsed);
    persistLocationStorage(parsed.route, normalized);
  }
  if (location.hash === normalized) return;
  try {
    window.history.pushState(null, "", `${location.pathname}${location.search}${normalized}`);
  } catch {
    // Ignore history errors before falling back to location.hash
  }
  if (location.hash !== normalized) {
    location.hash = normalized;
  }
  activeRouterInstance?.markHashHandled(normalized, parsed ?? undefined, true);
}

/**
 * Replaces the current browser URL entry in place (used when normalizing incomplete URLs
 * or updating vertical scroll-spy section anchors without polluting Back-button history).
 */
export function replaceAppHash(hash: string): void {
  const normalized = hash.startsWith("#") ? hash : `#/${hash.replace(/^\/+/, "")}`;
  const parsed = parseHashState(normalized);
  if (parsed) {
    applyParsedSideEffects(parsed);
    persistLocationStorage(parsed.route, normalized);
  }
  if (location.hash === normalized) return;
  try {
    window.history.replaceState(null, "", `${location.pathname}${location.search}${normalized}`);
  } catch {
    // Ignore history errors before falling back to location.hash
  }
  if (location.hash !== normalized) {
    location.hash = normalized;
  }
  activeRouterInstance?.markHashHandled(normalized, parsed ?? undefined, false);
}

function applyParsedSideEffects(parsed: ParsedHashState): void {
  currentParsedHashState = parsed;
  if (parsed.races) {
    pendingRacesTab = parsed.races.tab;
    pendingRacesStage = parsed.races.stage ?? null;
  }
  if (parsed.practice || parsed.live) {
    pendingPracticeTab = (parsed.practice ?? parsed.live)!.tab;
  }
  if (parsed.analytics !== undefined) {
    setAnalyticsScope(parsed.analytics);
  }
}

function loadInitialRoute(): RouteId {
  const fromHash = parseHashState(location.hash);
  if (fromHash) {
    applyParsedSideEffects(fromHash);
    return fromHash.route;
  }
  try {
    const savedHash = window.localStorage.getItem(HASH_STORAGE_KEY);
    if (savedHash) {
      const fromSavedHash = parseHashState(savedHash);
      if (fromSavedHash) {
        applyParsedSideEffects(fromSavedHash);
        try {
          window.history.replaceState(
            null,
            "",
            `${location.pathname}${location.search}${savedHash}`
          );
        } catch {
          // Ignore
        }
        return fromSavedHash.route;
      }
    }
    const saved = window.localStorage.getItem(ROUTE_STORAGE_KEY);
    if (saved === "events") {
      applyParsedSideEffects({ route: "races", races: { tab: "directory" } });
      return "races";
    }
    if (saved === "race-setup") {
      applyParsedSideEffects({ route: "races", races: { tab: "format" } });
      return "races";
    }
    if (saved === "race-control") {
      applyParsedSideEffects({ route: "races", races: { tab: "control" } });
      return "races";
    }
    if (saved === "live") {
      applyParsedSideEffects({ route: "practice", practice: { tab: "directory" }, live: { tab: "directory" } });
      return "practice";
    }
    if (saved && ROUTES.some((r) => r.id === saved)) {
      const route = saved as RouteId;
      applyParsedSideEffects({ route });
      return route;
    }
  } catch {
    // Ignore storage access errors
  }
  if (capabilitiesSnapshot().probed && capabilitiesSnapshot().demoMode) {
    const target: PracticeRouteTarget = { tab: "session", sessionId: "open-track-practice" };
    applyParsedSideEffects({
      route: "practice",
      practice: target,
      live: target,
    });
    return "practice";
  }
  applyParsedSideEffects({ route: "races", races: { tab: "directory" } });
  return "races";
}

/** Hash-based router (`#/practice`, `#/races/<id>/format`, `#/setup/<section>`, ...) with full Back/Forward support. */
export class Router {
  private current: RouteId = loadInitialRoute();
  private lastHandledHash: string = location.hash;
  private readonly listeners = new Set<(route: RouteId) => void>();
  private readonly handleLocationChange: () => void;

  constructor() {
    for (const inst of Array.from(allRouterInstances)) {
      inst.destroyWindowListeners();
    }
    allRouterInstances.add(this);
    activeRouterInstance = this;
    if (!location.hash || location.hash === "#" || location.hash === "#/") {
      const pracTarget = currentParsedHashState.practice ?? currentParsedHashState.live;
      const initialHash =
        this.current === "practice" && pracTarget?.tab === "session"
          ? buildPracticeHash("session", pracTarget.sessionId)
          : `#/${this.current}`;
      try {
        window.history.replaceState(
          null,
          "",
          `${location.pathname}${location.search}${initialHash}`
        );
      } catch {
        // Ignore
      }
      this.lastHandledHash = location.hash;
    }
    persistLocationStorage(this.current, location.hash);

    this.handleLocationChange = (): void => {
      const rawHash = location.hash;
      if (rawHash === this.lastHandledHash) return;
      this.lastHandledHash = rawHash;

      const parsed =
        parseHashState(rawHash) ?? ({ route: "races", races: { tab: "directory" } } as ParsedHashState);
      applyParsedSideEffects(parsed);
      const next = parsed.route;
      persistLocationStorage(next, rawHash);

      if (next === this.current) {
        notifyParsedSubRouteListeners(parsed);
        return;
      }

      this.current = next;
      notifyParsedSubRouteListeners(parsed, true);
      this.listeners.forEach((fn) => {
        try {
          fn(next);
        } catch (err) {
          console.error("[Router] subscriber error:", err);
        }
      });
    };

    window.addEventListener("hashchange", this.handleLocationChange);
    window.addEventListener("popstate", this.handleLocationChange);
  }

  public destroyWindowListeners(): void {
    window.removeEventListener("hashchange", this.handleLocationChange);
    window.removeEventListener("popstate", this.handleLocationChange);
    allRouterInstances.delete(this);
    if (activeRouterInstance === this) {
      activeRouterInstance = null;
    }
  }

  public markHashHandled(
    hash: string,
    parsed?: ParsedHashState,
    notifySameRoute = false
  ): void {
    this.lastHandledHash = hash;
    const route = parsed?.route;
    if (route && route !== this.current) {
      this.current = route;
      if (parsed) {
        notifyParsedSubRouteListeners(parsed, true);
      }
      this.listeners.forEach((fn) => {
        try {
          fn(route);
        } catch (err) {
          console.error("[Router] subscriber error:", err);
        }
      });
    } else if (notifySameRoute && parsed) {
      notifyParsedSubRouteListeners(parsed);
    }
  }

  public clearListeners(): void {
    this.listeners.clear();
    this.destroyWindowListeners();
  }

  public get route(): RouteId {
    return this.current;
  }

  public meta(id: RouteId = this.current): RouteMeta {
    return ROUTES.find((r) => r.id === id)!;
  }

  public navigate(id: RouteId): void {
    location.hash = `#/${id}`;
  }

  /**
   * Navigates via top-level section menu (Sidebar / mobile nav):
   * - When switching from another page (`this.current !== id`), restores the exact sub-hash
   *   where the user last was inside `id` (e.g. `#/races/race-3/control`, `#/live/warmup-pack-1`).
   * - When clicking the already-active section (`this.current === id`), returns to that section's
   *   entry point (`#/${id}`).
   */
  public navigateSection(id: RouteId): void {
    if (this.current !== id) {
      const targetHash = getRememberedRouteHash(id);
      pushAppHash(targetHash);
      return;
    }
    if (id === "races") {
      dispatchRacesTopBarCommand({ type: "set-tab", tab: "directory" });
      return;
    }
    if (id === "practice") {
      dispatchPracticeTopBarCommand({ type: "set-tab", tab: "directory" });
      return;
    }
    const rootHash = `#/${id}`;
    if (location.hash !== rootHash) {
      pushAppHash(rootHash);
      const parsed = parseHashState(rootHash);
      if (parsed) notifyParsedSubRouteListeners(parsed);
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  public subscribe(fn: (route: RouteId) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
