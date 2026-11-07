const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape user-controlled text (callsigns, gate names) before interpolating into HTML. */
export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
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
