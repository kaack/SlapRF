const svg = (body: string, size = 16): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  // The ring's visual weight sits low-left of the 24×24 box (ring centre 10.5,13.5; ink spans
  // y 3.3–22.8), so the whole mark is nudged up/right to look optically centred.
  slaprf: (s?: number) =>
    svg(
      `<g transform="translate(0.6 -1.1)"><path d="M18.21 16.30A8.2 8.2 0 1 1 13.30 5.79" stroke-width="2.15"/><circle cx="10.5" cy="13.5" r="1.8" fill="currentColor" stroke="none"/><path d="M10.5 13.5L15.2 9.8" stroke-width="2.15"/><path d="M15.77 7.22A8.2 8.2 0 0 1 18.70 13.50" stroke-width="2.15"/><path d="M17.64 4.36A11.6 11.6 0 0 1 22.09 13.90" stroke-width="2.15" opacity="0.65"/></g>`,
      s
    ),
  gate: (s?: number) =>
    svg(`<path d="M4 20V5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5V20"/><path d="M8 20V8h8v12"/>`, s),
  flag: (s?: number) => svg(`<path d="M4 22V4"/><path d="M4 4h12l-2 4 2 4H4"/>`, s),
  pilot: (s?: number) => svg(`<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>`, s),
  signal: (s?: number) => svg(`<path d="M3 12h4l3-8 4 16 3-8h4"/>`, s),
  signalOff: (s?: number) =>
    svg(`<path d="M3 12h4l3-8 .9 3.6"/><path d="M13.1 16.4 14 20l3-8h4"/><path d="m2 2 20 20"/>`, s),
  sliders: (s?: number) =>
    svg(`<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>`, s),
  zap: (s?: number) => svg(`<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>`, s),
  zapOff: (s?: number) =>
    svg(`<path d="M12.4 6.8 13 2l-2.4 3.2"/><path d="M18.6 12.9 20 11h-5.3"/><path d="M8 8.7 4 14h7l-1 8 5-6.7"/><path d="m2 2 20 20"/>`, s),
  reset: (s?: number) => svg(`<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>`, s),
  play: (s?: number) => svg(`<path d="M7 4l13 8-13 8z"/>`, s),
  pause: (s?: number) => svg(`<path d="M9 5v14M15 5v14"/>`, s),
  timer: (s?: number) =>
    svg(`<path d="M10 2h4"/><path d="M12 14l3-3"/><circle cx="12" cy="14" r="8"/>`, s),
  timerOff: (s?: number) =>
    svg(
      `<path d="M10 2h4"/><path d="M4.6 11a8 8 0 0 0 1.7 8.7 8 8 0 0 0 8.7 1.7"/><path d="M7.4 7.4a8 8 0 0 1 10.3 1 8 8 0 0 1 .9 10.2"/><path d="m2 2 20 20"/>`,
      s
    ),
  arrowRight: (s?: number) => svg(`<path d="M5 12h14M13 6l6 6-6 6"/>`, s),
  chevronLeft: (s?: number) => svg(`<path d="M15 6l-6 6 6 6"/>`, s),
  chevronRight: (s?: number) => svg(`<path d="M9 6l6 6-6 6"/>`, s),
  chevronDown: (s?: number) => svg(`<path d="m6 9 6 6 6-6"/>`, s),
  pin: (s?: number) => svg(`<path d="M8 3h8"/><path d="M9 3v5l-3 3v2h12v-2l-3-3V3"/><path d="M12 13v8"/>`, s),
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
  plug: (s?: number) =>
    svg(
      `<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>`,
      s
    ),
  plugOff: (s?: number) =>
    svg(
      `<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-1.2 2.8"/><path d="M13.5 17H10a4 4 0 0 1-4-4V8h2"/><path d="m2 2 20 20"/>`,
      s
    ),
  bug: (s?: number) =>
    svg(
      `<rect x="8" y="6" width="8" height="14" rx="4"/><path d="M9 3l1.5 3M15 3l-1.5 3M8 11H4M20 11h-4M8 16H5M19 16h-3M12 10v10"/>`,
      s
    ),
  close: (s?: number) => svg(`<path d="M18 6 6 18M6 6l12 12"/>`, s),
  menu: (s?: number) => svg(`<path d="M4 6h16M4 12h16M4 18h16"/>`, s),
  cpu: (s?: number) =>
    svg(
      `<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="0.75"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>`,
      s
    ),
  wifi: (s?: number) =>
    svg(
      `<path d="M5 12.85a11 11 0 0 1 14 0"/><path d="M1.8 9.2a16 16 0 0 1 20.4 0"/><path d="M8.5 16.4a6 6 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1.2" fill="currentColor" stroke="none"/>`,
      s
    ),
  fileText: (s?: number) =>
    svg(
      `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h6"/>`,
      s
    ),
  history: (s?: number) =>
    svg(`<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/>`, s),
  siren: (s?: number) =>
    svg(
      `<path d="M6.5 16v-3.5a5.5 5.5 0 0 1 11 0V16"/><path d="M10 16v-2.5a2 2 0 0 1 4 0V16"/><path d="M4 19h16l-1.5-3H5.5L4 19Z"/><path d="M1.5 11.5h2.5M2.2 7l2.3 1.4M20 11.5h2.5M21.8 7l-2.3 1.4"/>`,
      s
    ),
  copy: (s?: number) =>
    svg(
      `<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`,
      s
    ),
  trash: (s?: number) =>
    svg(
      `<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/>`,
      s
    ),
  check: (s?: number) => svg(`<path d="M20 6 9 17l-5-5"/>`, s),
  terminal: (s?: number) => svg(`<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>`, s),
};
