import { icons } from "./icons";

export type RouteId = "live" | "pilot" | "sim" | "setup";

export interface RouteMeta {
  id: RouteId;
  label: string;
  title: string;
  subtitle: string;
  icon: () => string;
  simOnly?: boolean;
}

/** One flat level: each section of the app is a single page. */
export const ROUTES: RouteMeta[] = [
  {
    id: "live",
    label: "Live",
    title: "Live",
    subtitle: "Who's flying and how times are trending — pick a pilot for their laps and signal",
    icon: () => icons.flag(20),
  },
  {
    id: "pilot",
    label: "Analytics",
    title: "Analytics",
    subtitle: "Pick laps and see where time was won and lost",
    icon: () => icons.chart(20),
  },
  {
    id: "sim",
    label: "Sim",
    title: "Practice Simulator",
    subtitle: "Simulated pilots, 6S flight packs, crashes, track recovery walks, and XIAO gate timers",
    icon: () => icons.zap(20),
    simOnly: true,
  },
  {
    id: "setup",
    label: "System",
    title: "System",
    subtitle: "Pilots, timing rules, announcer, gates and LiveTime",
    icon: () => icons.sliders(20),
  },
];

function parseHash(hash: string): RouteId {
  const id = hash.replace(/^#\/?/, "").split("/")[0];
  return ROUTES.some((r) => r.id === id) ? (id as RouteId) : "live";
}

/** Hash-based router (`#/race`, `#/pilot`, ...) so views are bookmarkable. */
export class Router {
  private current: RouteId = parseHash(location.hash);
  private readonly listeners = new Set<(route: RouteId) => void>();

  constructor() {
    window.addEventListener("hashchange", () => {
      const next = parseHash(location.hash);
      if (next === this.current) return;
      this.current = next;
      this.listeners.forEach((fn) => fn(next));
    });
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

  public subscribe(fn: (route: RouteId) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
