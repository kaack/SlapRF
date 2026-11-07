const svg = (body: string, size = 16): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  slaprf: (s?: number) =>
    svg(`<path d="M4 19V9a8 8 0 0 1 16 0v10"/><path d="M2.5 14.5h5l2.5-6 3 11 2.5-6h6" stroke-width="2.1"/>`, s),
  gate: (s?: number) => svg(`<path d="M5 20V9a7 7 0 0 1 14 0v11"/><path d="M9 20v-9a3 3 0 0 1 6 0v9"/>`, s),
  flag: (s?: number) => svg(`<path d="M4 22V4"/><path d="M4 4h12l-2 4 2 4H4"/>`, s),
  pilot: (s?: number) => svg(`<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>`, s),
  signal: (s?: number) => svg(`<path d="M3 12h4l3-8 4 16 3-8h4"/>`, s),
  sliders: (s?: number) =>
    svg(`<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>`, s),
  zap: (s?: number) => svg(`<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>`, s),
  reset: (s?: number) => svg(`<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>`, s),
  play: (s?: number) => svg(`<path d="M7 4l13 8-13 8z"/>`, s),
  pause: (s?: number) => svg(`<path d="M9 5v14M15 5v14"/>`, s),
  arrowRight: (s?: number) => svg(`<path d="M5 12h14M13 6l6 6-6 6"/>`, s),
  chevronLeft: (s?: number) => svg(`<path d="M15 6l-6 6 6 6"/>`, s),
  chevronRight: (s?: number) => svg(`<path d="M9 6l6 6-6 6"/>`, s),
  target: (s?: number) => svg(`<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>`, s),
  speaker: (s?: number) => svg(`<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>`, s),
  speakerOff: (s?: number) => svg(`<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 6 6M22 9l-6 6"/>`, s),
  stop: (s?: number) => svg(`<rect x="6" y="6" width="12" height="12" rx="1.5"/>`, s),
  checkered: (s?: number) =>
    svg(`<path d="M4 22V4"/><path d="M4 4h16v10H4"/><path d="M8 4v10M12 4v10M16 4v10M4 9h16" stroke-width="1.2"/>`, s),
  trendDown: (s?: number) => svg(`<path d="m3 7 7 7 4-4 7 7"/><path d="M15 17h6v-6"/>`, s),
  trendUp: (s?: number) => svg(`<path d="m3 17 7-7 4 4 7-7"/><path d="M15 7h6v6"/>`, s),
  chart: (s?: number) => svg(`<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>`, s),
  compare: (s?: number) => svg(`<path d="M8 20V10M16 20V4M4 20h16"/>`, s),
  eye: (s?: number) =>
    svg(`<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>`, s),
  eyeOff: (s?: number) =>
    svg(
      `<path d="M10.6 5.1A10.7 10.7 0 0 1 12 5c6.5 0 10 7 10 7a16.5 16.5 0 0 1-3.2 4.3"/><path d="M6.6 6.7C3.8 8.5 2 12 2 12s3.5 7 10 7a10.4 10.4 0 0 0 5.4-1.5"/><path d="M14.1 14.1a3 3 0 0 1-4.2-4.2"/><path d="m2 2 20 20"/>`,
      s
    ),
  pencil: (s?: number) =>
    svg(`<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>`, s),
  close: (s?: number) => svg(`<path d="M18 6 6 18M6 6l12 12"/>`, s),
};
