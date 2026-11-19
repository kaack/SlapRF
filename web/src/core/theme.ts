import { getAndroidBridge } from "./android_bridge";

export type AppTheme = "dark" | "light";

export const APP_THEME_STORAGE_KEY = "slaprf.ui.theme.v1";

const DARK_CANVAS_PALETTE = {
  bg: "#0b0c0f",
  surface: "#111317",
  chartSurface: "#111317",
  chartBorder: "#22252c",
  grid: "rgba(255, 255, 255, 0.045)",
  gridStrong: "rgba(255, 255, 255, 0.09)",
  text: "#ecedef",
  text2: "#a3a8b3",
  text3: "#6c7280",
  accent: "#d4ff3a",
  good: "#34d399",
  bad: "#f87171",
  track: "#1b1e24",
  trackEdge: "#2a2e36",
};

const LIGHT_CANVAS_PALETTE = {
  bg: "#f3f5f8",
  surface: "#ffffff",
  chartSurface: "#f4f6f9",
  chartBorder: "transparent",
  grid: "rgba(15, 23, 42, 0.075)",
  gridStrong: "rgba(15, 23, 42, 0.14)",
  text: "#181d27",
  text2: "#4a5365",
  text3: "#727c90",
  accent: "#2563eb",
  good: "#059669",
  bad: "#dc2626",
  track: "#e3e8f0",
  trackEdge: "#cbd2de",
};

/**
 * Light-theme counterparts paired 1-to-1 with `TIMER_COLORS` (`#d4ff3a`, `#38bdf8`, …).
 * Grounded, glare-free instrument shades with >= 3.8:1–7.8:1 contrast on `#f5f6f8` / `#f8f8f8`.
 */
export const LIGHT_TIMER_COLORS = [
  "#4d7c0f", // 1: Olive Lime (replaces #d4ff3a Neon Volt)
  "#0284c7", // 2: Cerulean Sky (replaces #38bdf8)
  "#db2777", // 3: Berry Rose (replaces #f472b6)
  "#c2410c", // 4: Terracotta Orange (replaces #fb923c)
  "#7c3aed", // 5: Iris Violet (replaces #a78bfa)
  "#0d8a7e", // 6: Deep Seafoam Teal (replaces #2dd4bf)
  "#a16207", // 7: Warm Ochre Gold (replaces #facc15)
  "#dc2626", // 8: Grounded Crimson (replaces #f87171)
  "#15803d", // 9: Forest Emerald (replaces #4ade80)
  "#2563eb", // 10: Signal Cobalt (replaces #60a5fa)
  "#a21caf", // 11: Deep Orchid Magenta (replaces #e879f9)
  "#334155", // 12: Deep Slate (replaces #ffffff)
] as const;

const DARK_TO_LIGHT_SERIES_MAP: Record<string, string> = {
  // 12 Canonical Timer Colors
  "#d4ff3a": "#4d7c0f",
  "#38bdf8": "#0284c7",
  "#f472b6": "#db2777",
  "#fb923c": "#c2410c",
  "#a78bfa": "#7c3aed",
  "#2dd4bf": "#0d8a7e",
  "#facc15": "#a16207",
  "#f87171": "#dc2626",
  "#4ade80": "#15803d",
  "#60a5fa": "#2563eb",
  "#e879f9": "#a21caf",
  "#ffffff": "#334155",
  // Additional Pilot / Channel Palette Colors (`CHANNEL_COLORS` & `basePilotPalette`)
  "#ef4444": "#dc2626",
  "#3b82f6": "#2563eb",
  "#10b981": "#059669",
  "#f59e0b": "#c26a05",
  "#a855f7": "#7c3aed",
  "#06b6d4": "#0891b2",
  "#ec4899": "#db2777",
  "#84cc16": "#4d7c0f",
  "#f97316": "#ea580c",
  "#14b8a6": "#0d8a7e",
  "#6366f1": "#4f46e5",
  "#eab308": "#a16207",
  "#fb7185": "#e11d48",
  "#c084fc": "#7c3aed",
};

/** Canvas palette — mirrors the CSS custom properties in styles/tokens.css. */
export const theme = {
  ...DARK_CANVAS_PALETTE,
  fontSans: `"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`,
  fontMono: `"JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace`,
};

function readStoredAppTheme(): AppTheme {
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(APP_THEME_STORAGE_KEY);
      if (raw === "light" || raw === "dark") return raw;
    }
  } catch {
    /* ignore storage errors */
  }
  if (typeof document !== "undefined") {
    const attr = document.documentElement?.dataset?.theme;
    if (attr === "light" || attr === "dark") return attr;
  }
  return "dark";
}

let currentAppTheme: AppTheme = readStoredAppTheme();
const themeSubscribers = new Set<(mode: AppTheme) => void>();

function applyThemeState(mode: AppTheme): void {
  Object.assign(theme, mode === "light" ? LIGHT_CANVAS_PALETTE : DARK_CANVAS_PALETTE);
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.dataset.theme = mode;
    const schemeMeta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
    if (schemeMeta) schemeMeta.content = mode;
    const colorMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (colorMeta) colorMeta.content = mode === "light" ? "#f3f5f8" : "#0b0c0f";
  }
  getAndroidBridge()?.setThemeMode(mode);
}

applyThemeState(currentAppTheme);

export function getAppTheme(): AppTheme {
  return currentAppTheme;
}

export function initAppTheme(): AppTheme {
  currentAppTheme = readStoredAppTheme();
  applyThemeState(currentAppTheme);
  return currentAppTheme;
}

export function setAppTheme(mode: AppTheme): void {
  const next: AppTheme = mode === "light" ? "light" : "dark";
  const changed = next !== currentAppTheme;
  currentAppTheme = next;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(APP_THEME_STORAGE_KEY, next);
    }
  } catch {
    /* ignore storage errors */
  }
  applyThemeState(next);
  if (changed) {
    for (const fn of themeSubscribers) {
      fn(next);
    }
  }
}

export function subscribeAppTheme(fn: (mode: AppTheme) => void): () => void {
  themeSubscribers.add(fn);
  return () => {
    themeSubscribers.delete(fn);
  };
}

export function font(weight: number, size: number, mono = false): string {
  return `${weight} ${size}px ${mono ? theme.fontMono : theme.fontSans}`;
}

export function withAlpha(hex: string, alpha: number): string {
  const clean = hex.trim();
  if (!clean.startsWith("#") || clean.length < 7) return clean;
  const n = parseInt(clean.slice(1, 7), 16);
  if (!Number.isFinite(n)) return clean;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function parseHexRgb(hex: string): [number, number, number] | null {
  const clean = hex.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(clean)) {
    const n = parseInt(clean.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  if (/^#[0-9a-f]{3}$/.test(clean)) {
    const r = parseInt(clean[1] + clean[1], 16);
    const g = parseInt(clean[2] + clean[2], 16);
    const b = parseInt(clean[3] + clean[3], 16);
    return [r, g, b];
  }
  return null;
}

function relativeLuminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function darkenForLightSurface(r: number, g: number, b: number): string {
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rf) h = ((gf - bf) / d + (gf < bf ? 6 : 0)) / 6;
    else if (max === gf) h = ((bf - rf) / d + 2) / 6;
    else h = ((rf - gf) / d + 4) / 6;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const targetS = s > 0.82 ? 0.76 : s;
  const targetL = s < 0.08 ? 0.3 : 0.36;
  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = targetL < 0.5 ? targetL * (1 + targetS) : targetL + targetS - targetL * targetS;
  const p = 2 * targetL - q;
  const nr = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
  const ng = Math.round(hue2rgb(p, q, h) * 255);
  const nb = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);
  const toHex = (v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
  return `#${toHex(nr)}${toHex(ng)}${toHex(nb)}`;
}

/**
 * Resolves a stored dark-first timer, pilot, or channel color for the active UI theme
 * without mutating persisted state. Returns `hex` untouched in Dark theme, and maps
 * bright/neon shades to grounded, glare-free counterparts in Light theme.
 */
export function adaptColorForTheme(hex: string): string {
  if (!hex || currentAppTheme !== "light") return hex;
  const clean = hex.trim();
  const mapped = DARK_TO_LIGHT_SERIES_MAP[clean.toLowerCase()];
  if (mapped) return mapped;
  const rgb = parseHexRgb(clean);
  if (!rgb) return clean;
  if (relativeLuminance(rgb[0], rgb[1], rgb[2]) > 0.4) {
    return darkenForLightSurface(rgb[0], rgb[1], rgb[2]);
  }
  return clean;
}

/** Returns legible foreground ink (`#0b0d10` or `#ffffff`) over a solid `hex` tag fill. */
export function inkOnColor(hex: string): string {
  const rgb = parseHexRgb(hex);
  if (!rgb) return "#0b0d10";
  return relativeLuminance(rgb[0], rgb[1], rgb[2]) > 0.36 ? "#0b0d10" : "#ffffff";
}
