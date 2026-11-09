import { icons } from "./icons";

export type RouteId = "live" | "pilot" | "pilots" | "track" | "sim" | "setup" | "flasher" | "debug";

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
    label: "Practice",
    title: "Practice",
    subtitle: "Live standings, lap times, and section splits",
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
    id: "pilots",
    label: "Pilots",
    title: "Pilots",
    subtitle: "Eight timing slots and 5.8 GHz Raceband channels",
    icon: () => icons.pilot(20),
  },
  {
    id: "track",
    label: "Track",
    title: "Track",
    subtitle: "Gate order, sections, start gate, and discovered timers",
    icon: () => icons.gate(20),
  },
  {
    id: "sim",
    label: "Simulator",
    title: "Simulator",
    subtitle: "Simulated pilots, 6S flight packs, crashes, track recovery walks, and XIAO gate timers",
    icon: () => icons.zap(20),
    simOnly: true,
  },
  {
    id: "setup",
    label: "Settings",
    title: "Settings",
    subtitle: "Timing rules, announcer, MultiGP LiveTime, and data source",
    icon: () => icons.sliders(20),
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
    subtitle: "Connect a timer over USB: live 5.8 GHz readings, spectrum scan, status and log",
    icon: () => icons.bug(20),
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
