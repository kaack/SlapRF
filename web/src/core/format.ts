const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape user-controlled text (callsigns, gate names) before interpolating into HTML. */
export function esc(value: string | null | undefined): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** Lap / split time in seconds, e.g. `13.482`. Returns an em dash when unset. */
export function fmtTime(sec: number, digits = 3): string {
  return sec > 0 && Number.isFinite(sec) ? sec.toFixed(digits) : "—";
}

/** Signed delta, e.g. `+0.231` / `−0.104`. */
export function fmtDelta(sec: number, digits = 3): string {
  if (!Number.isFinite(sec)) return "—";
  if (Math.abs(sec) < 0.0005) return "±0.000";
  return `${sec > 0 ? "+" : "−"}${Math.abs(sec).toFixed(digits)}`;
}

/** Engine-relative clock from a microsecond timestamp, e.g. `04:12.385`. */
export function fmtClock(us: number): string {
  const totalMs = Math.floor(us / 1000);
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Relative time, e.g. `12s ago`, `4m ago`, `1h ago`. */
export function fmtAgo(sec: number): string {
  if (!Number.isFinite(sec)) return "not flown yet";
  if (sec < 60) return `${Math.round(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

/** Race clock, e.g. `01:12.4`. */
export function fmtRaceClock(sec: number): string {
  const s = Math.max(0, sec);
  const minutes = Math.floor(s / 60);
  const rest = s - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
}

/** Minimum uncounted gap (seconds) between consecutive laps of the same pilot to render a break separator. */
export const LAP_BREAK_GAP_THRESHOLD_SEC = 5;

/** Compact human duration for inter-lap landing / pack-swap breaks, e.g. `18s`, `2m 14s`, `1h 05m`. */
export function fmtBreakDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0s";
  const rounded = Math.max(1, Math.round(sec));
  if (rounded < 60) return `${rounded}s`;
  if (rounded < 3600) {
    const m = Math.floor(rounded / 60);
    const s = rounded % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** Computes the uncounted idle gap in seconds between an older completed lap and a newer completed lap. */
export function lapBreakGapSec(
  newerLap: { completedAtUs: number; lapTimeSec: number },
  olderLap: { completedAtUs: number }
): number {
  if (!(newerLap.completedAtUs > 0) || !(olderLap.completedAtUs > 0)) return 0;
  const newerStartUs = newerLap.completedAtUs - Math.max(0, Math.round((newerLap.lapTimeSec || 0) * 1_000_000));
  if (newerStartUs <= olderLap.completedAtUs) return 0;
  return (newerStartUs - olderLap.completedAtUs) / 1_000_000;
}

/** Renders a horizontal zigzag separator `<tr>` indicating a landing / pack-swap time break between laps. */
export function renderLapBreakRowHtml(gapSec: number, colSpan: number, manualBreakId?: number): string {
  const label = gapSec > 0 ? `Break · ${fmtBreakDuration(gapSec)}` : "Break";
  const span = Math.max(1, Math.round(colSpan));
  const undoBtn =
    manualBreakId && manualBreakId > 0
      ? `<button type="button" class="lap-break-undo-btn" data-delete-break-id="${manualBreakId}" title="Remove manual break" aria-label="Remove manual break">&times;</button>`
      : "";
  return `<tr class="lap-break-row" data-lap-break-row data-break-sec="${Math.round(gapSec)}" aria-label="${esc(label)}">
    <td colspan="${span}" class="lap-break-cell">
      <div class="lap-break-inner" title="Idle / landing gap (${esc(fmtBreakDuration(gapSec))}) with no lap counting">
        <span class="lap-break-zigzag" aria-hidden="true"></span>
        <span class="lap-break-pill">${esc(label)}${undoBtn}</span>
        <span class="lap-break-zigzag" aria-hidden="true"></span>
      </div>
    </td>
  </tr>`;
}
