/** Canvas palette — mirrors the CSS custom properties in styles/tokens.css. */
export const theme = {
  surface: "#111317",
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
  fontSans: `"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`,
  fontMono: `"JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace`,
};

export function font(weight: number, size: number, mono = false): string {
  return `${weight} ${size}px ${mono ? theme.fontMono : theme.fontSans}`;
}

export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
