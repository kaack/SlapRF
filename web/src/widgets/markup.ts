import { esc } from "../core/format";
import { gateColor, gateLabel, sectionShort } from "../state/selectors";
import { AppStore } from "../state/store";
import { FilterReason, SectorBadge } from "../types/models";

/** Short names for why the timing rules set a detection aside. */
export const FILTER_LABELS: Record<FilterReason, string> = {
  COOLDOWN: "Cool-down",
  TOO_SOON: "Too soon",
  ECHO: "Echo",
  MIN_LAP: "Min lap",
  LAP_TOO_LONG: "Lap too long",
};

/** Colour chip for a section split: track record, own best, normal, well off pace. */
export const SPLIT_CLASS: Record<SectorBadge, string> = {
  OVERALL_BEST: "split-purple",
  PERSONAL_BEST: "split-good",
  NORMAL: "split-neutral",
  OFF_PACE: "split-bad",
};

export interface StatTile {
  label: string;
  value: string;
  sub?: string;
  tone?: "accent" | "good" | "bad";
  /** Colour for the sub line only (e.g. a gain / loss under a neutral value). */
  subTone?: "good" | "bad";
  mono?: boolean;
}

export function renderStatTiles(tiles: StatTile[]): string {
  return tiles
    .map(
      (t) => `
      <div class="stat">
        <div class="stat-label">${esc(t.label)}</div>
        <div class="stat-value ${t.mono === false ? "" : "mono"} ${t.tone ? `tone-${t.tone}` : ""}">${esc(t.value)}</div>
        ${t.sub ? `<div class="stat-sub ${t.subTone ? `tone-${t.subTone}` : ""}">${esc(t.sub)}</div>` : ""}
      </div>`
    )
    .join("");
}

export function renderEmpty(title: string, body: string): string {
  return `
    <div class="empty">
      <div class="empty-title">${esc(title)}</div>
      <div class="empty-body">${esc(body)}</div>
    </div>`;
}

/** Tiny inline lap-time sparkline using a smooth cubic spline. Faster laps sit higher, so a rising line means improving. */
export function renderSparkline(values: number[], width = 120, height = 32): string {
  if (values.length < 2) return `<svg class="spark" width="${width}" height="${height}"></svg>`;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = Math.max(0.001, hi - lo);
  const pts = values.map((v, i) => ({
    x: (i / (values.length - 1)) * (width - 4) + 2,
    y: height - 3 - ((hi - v) / span) * (height - 6),
  }));
  const n = pts.length;
  let d = `M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  if (n === 2) {
    d += ` L ${pts[1].x.toFixed(1)},${pts[1].y.toFixed(1)}`;
  } else {
    const dx = pts.slice(0, -1).map((p, i) => pts[i + 1].x - p.x);
    const m = dx.map((w, i) => (w !== 0 ? (pts[i + 1].y - pts[i].y) / w : 0));
    const t: number[] = new Array(n);
    t[0] = m[0];
    t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) {
      t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    }
    for (let i = 0; i < n - 1; i++) {
      const seg = dx[i] / 3;
      const c1x = pts[i].x + seg;
      const c1y = pts[i].y + t[i] * seg;
      const c2x = pts[i + 1].x - seg;
      const c2y = pts[i + 1].y - t[i + 1] * seg;
      d += ` C ${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${pts[i + 1].x.toFixed(1)},${pts[i + 1].y.toFixed(1)}`;
    }
  }
  const last = pts[n - 1];
  return `
    <svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
      <path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="2.5" fill="currentColor"/>
    </svg>`;
}

/** Inline gate label prefixed with its colored dot from the Gates section in System. */
export function gateBadge(store: AppStore, puckId: number): string {
  return `<span class="gate-dot-label"><span class="dot" style="--c:${gateColor(store, puckId)}"></span>${esc(gateLabel(store, puckId))}</span>`;
}

/**
 * Elongated two-tone capsule icon where the left half is the starting gate/puck color (--c1)
 * and the right half is the terminating gate/puck color (--c2).
 */
export function renderSectionCapsuleIcon(c1: string, c2: string): string {
  return `<span class="sec-bicolor-capsule" style="--c1:${c1};--c2:${c2}" aria-hidden="true"></span>`;
}

/**
 * Prominent elongated section ID pill ("S1", "S2"…) whose left half represents the gate/puck
 * before and right half represents the gate/puck after/terminating it.
 */
export function sectionIdBadge(store: AppStore, fromPuckId: number, toPuckId?: number): string {
  const c1 = gateColor(store, fromPuckId);
  let resolvedTo = toPuckId;
  if (!resolvedTo && store.pucks.length > 0) {
    const idx = store.pucks.findIndex((p) => p.puckId === fromPuckId);
    if (idx >= 0) {
      resolvedTo = store.pucks[(idx + 1) % store.pucks.length].puckId;
    }
  }
  const c2 = resolvedTo ? gateColor(store, resolvedTo) : c1;
  return `<span class="sec-id-badge" style="--c1:${c1};--c2:${c2}">${renderSectionCapsuleIcon(c1, c2)}<span>${esc(sectionShort(store, fromPuckId))}</span></span>`;
}

/** Subtle "Gate 1 → Gate 2" route string for secondary context next to S1/S2/S3. */
export function subtleRoute(store: AppStore, fromPuckId: number, toPuckId: number): string {
  return `<span class="sec-route-subtle">${esc(gateLabel(store, fromPuckId))} <span class="muted">→</span> ${esc(gateLabel(store, toPuckId))}</span>`;
}

/** HTML-escaped "[◖◗ S1]  Gate 1 → Gate 2" label for a section, with S1 prominent and gate route subtle. */
export function routeLabel(store: AppStore, fromPuckId: number, toPuckId: number): string {
  return `<span class="sec-cell">${sectionIdBadge(store, fromPuckId, toPuckId)}${subtleRoute(store, fromPuckId, toPuckId)}</span>`;
}
