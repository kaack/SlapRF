/**
 * Multi-touch directional 2-finger pinch (Horizontal X-only, Vertical Y-only, Diagonal X+Y)
 * and Desktop modifier-wheel zoom math shared across SlapRF's interactive RF & Debug charts.
 */

export interface PinchPoint {
  x: number;
  y: number;
}

export type PinchAxisMode = "x" | "y" | "xy";

export interface DirectionalPinchResult {
  mode: PinchAxisMode;
  /** Multiplier applied to visible X span (< 1 zooms in / stretches wider; > 1 zooms out). */
  xSpanFactor: number;
  /** Multiplier applied to visible Y span (< 1 zooms in / stretches taller; > 1 zooms out). */
  ySpanFactor: number;
  startMidX: number;
  startMidY: number;
  midX: number;
  midY: number;
}

/**
 * Soft-padding constant (in CSS px) added to `|x2 - x1|` and `|y2 - y1|` so small initial
 * separations (e.g. two fingers starting pinched close together to spread apart, or slight
 * cross-axis finger wobble) never cause runaway division-by-near-zero jumps.
 */
const AXIS_SOFT_BASE_PX = 34;

/** Finger chord angle thresholds (degrees from horizontal: 0° = horizontal, 90° = vertical). */
const HORIZONTAL_CONE_DEG = 24;
const VERTICAL_CONE_DEG = 66;

/** Active cross-axis spread (in px) required to promote an axis-locked pinch into diagonal 2D zoom. */
const CROSS_AXIS_UNLOCK_PX = 24;

/**
 * Computes directional X, Y, or simultaneous X+Y span multipliers from initial and current
 * 2-finger coordinates (in element-local CSS pixels).
 */
export function computeDirectionalPinch(
  p1Start: PinchPoint,
  p2Start: PinchPoint,
  p1Now: PinchPoint,
  p2Now: PinchPoint
): DirectionalPinchResult {
  const dx0 = Math.abs(p2Start.x - p1Start.x);
  const dy0 = Math.abs(p2Start.y - p1Start.y);
  const dx = Math.abs(p2Now.x - p1Now.x);
  const dy = Math.abs(p2Now.y - p1Now.y);

  const startMidX = (p1Start.x + p2Start.x) * 0.5;
  const startMidY = (p1Start.y + p2Start.y) * 0.5;
  const midX = (p1Now.x + p2Now.x) * 0.5;
  const midY = (p1Now.y + p2Now.y) * 0.5;

  const effX = Math.max(dx0, dx);
  const effY = Math.max(dy0, dy);
  const deltaX = Math.abs(dx - dx0);
  const deltaY = Math.abs(dy - dy0);

  let mode: PinchAxisMode = "xy";
  if (effX + effY >= 8) {
    const chordDeg = (Math.atan2(effY, effX) * 180) / Math.PI;
    if (chordDeg < HORIZONTAL_CONE_DEG && deltaY < CROSS_AXIS_UNLOCK_PX) {
      mode = "x";
    } else if (chordDeg > VERTICAL_CONE_DEG && deltaX < CROSS_AXIS_UNLOCK_PX) {
      mode = "y";
    }
  }

  const rawScaleX = (dx + AXIS_SOFT_BASE_PX) / (dx0 + AXIS_SOFT_BASE_PX);
  const rawScaleY = (dy + AXIS_SOFT_BASE_PX) / (dy0 + AXIS_SOFT_BASE_PX);

  const xSpanFactor = mode === "y" ? 1 : clampFactor(1 / rawScaleX);
  const ySpanFactor = mode === "x" ? 1 : clampFactor(1 / rawScaleY);

  return {
    mode,
    xSpanFactor,
    ySpanFactor,
    startMidX,
    startMidY,
    midX,
    midY,
  };
}

function clampFactor(f: number): number {
  if (!Number.isFinite(f) || f <= 0) return 1;
  return Math.max(0.08, Math.min(12.5, f));
}

export interface WheelZoomFactors {
  mode: PinchAxisMode;
  xSpanFactor: number;
  ySpanFactor: number;
}

/**
 * Maps Desktop / Chrome DevTools wheel gestures into directional X, Y, or Diagonal X+Y zoom:
 * - `Ctrl + Wheel` (also emitted by Chrome DevTools Mobile `Shift + Drag` pinch & trackpad pinch): Diagonal X + Y
 * - `Shift + Wheel`: Horizontal X-axis stretch only
 * - `Alt + Wheel`: Vertical Y-axis stretch only
 * - Unmodified wheel: returns `null` so normal page scrolling is preserved.
 */
export function computeWheelZoomFactors(e: {
  deltaX: number;
  deltaY: number;
  deltaMode?: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): WheelZoomFactors | null {
  const isDiagonal = e.ctrlKey || e.metaKey;
  const isXOnly = !isDiagonal && e.shiftKey && !e.altKey;
  const isYOnly = !isDiagonal && e.altKey && !e.shiftKey;
  if (!isDiagonal && !isXOnly && !isYOnly) {
    return null;
  }

  // On Windows/Linux Shift+Wheel sometimes puts the scroll delta into deltaX instead of deltaY.
  const rawDelta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  if (!Number.isFinite(rawDelta) || rawDelta === 0) {
    return null;
  }

  const modeScale = e.deltaMode === 1 ? 24 : e.deltaMode === 2 ? 240 : 1;
  const normPx = Math.max(-160, Math.min(160, rawDelta * modeScale));
  // Positive deltaY (wheel down / pinch in) -> factor > 1 (zoom out); negative deltaY (wheel up / pinch out) -> factor < 1 (zoom in).
  const stepFactor = Math.exp(normPx * 0.0045);

  if (isXOnly) {
    return { mode: "x", xSpanFactor: stepFactor, ySpanFactor: 1 };
  }
  if (isYOnly) {
    return { mode: "y", xSpanFactor: 1, ySpanFactor: stepFactor };
  }
  return { mode: "xy", xSpanFactor: stepFactor, ySpanFactor: stepFactor };
}
