const svg = (body: string, size = 16): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" shape-rendering="geometricPrecision" aria-hidden="true">${body}</svg>`;

export const icons = {
  // The ring's visual weight sits low-left of the 24×24 box (ring centre 10.5,13.5; ink spans
  // y 3.3–22.8), so the whole mark is nudged up/right to look optically centred.
  slaprf: (s?: number) =>
    svg(
      `<g transform="translate(0.6 -1.1)"><path d="M18.21 16.30A8.2 8.2 0 1 1 13.30 5.79" stroke-width="2.15"/><circle cx="10.5" cy="13.5" r="1.8" fill="currentColor" stroke="none"/><path d="M10.5 13.5L15.2 9.8" stroke-width="2.15"/><path d="M15.77 7.22A8.2 8.2 0 0 1 18.70 13.50" stroke-width="2.15"/><path d="M17.64 4.36A11.6 11.6 0 0 1 22.09 13.90" stroke-width="2.15" opacity="0.65"/></g>`,
      s
    ),
  gate: (s?: number) =>
    svg(
      `<path d="M3 20V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14"/><path d="M7 20V9a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v11"/><path d="M2 20h6M16 20h6"/>`,
      s
    ),
  flag: (s?: number) =>
    svg(
      `<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>`,
      s
    ),
  pilot: (s?: number) =>
    svg(
      `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`,
      s
    ),
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
  chevronUp: (s?: number) => svg(`<path d="m18 15-6-6-6 6"/>`, s),
  chevronsUp: (s?: number) =>
    svg(`<path d="M6 11L12 5L18 11"/><path d="M6 18L12 12L18 18"/>`, s),
  pin: (s?: number) => svg(`<path d="M8 3h8"/><path d="M9 3v5l-3 3v2h12v-2l-3-3V3"/><path d="M12 13v8"/>`, s),
  target: (s?: number) => svg(`<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>`, s),
  targetOff: (s?: number) =>
    svg(
      `<path d="M8.56 3.69a9 9 0 0 1 11.75 11.75"/><path d="M19.07 19.07A9 9 0 0 1 4.93 4.93"/><path d="M10.59 6.51a5 5 0 0 1 6.9 6.9"/><path d="M15.54 15.54a5 5 0 0 1-7.08-7.08"/><path d="m2 2 20 20"/>`,
      s
    ),
  spinner: (s?: number) => svg(`<path d="M21 12a9 9 0 1 1-6.219-8.56"/>`, s),
  speaker: (s?: number) => svg(`<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>`, s),
  speakerOff: (s?: number) => svg(`<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 6 6M22 9l-6 6"/>`, s),
  stop: (s?: number) => svg(`<rect x="6" y="6" width="12" height="12" rx="1.5"/>`, s),
  checkered: (s = 16) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" shape-rendering="geometricPrecision" aria-hidden="true"><rect x="2" y="4.5" width="20" height="15" rx="2" stroke="currentColor" stroke-width="1.75"/><g fill="currentColor"><rect x="2" y="4.5" width="5" height="5"/><rect x="12" y="4.5" width="5" height="5"/><rect x="7" y="9.5" width="5" height="5"/><rect x="17" y="9.5" width="5" height="5"/><rect x="2" y="14.5" width="5" height="5"/><rect x="12" y="14.5" width="5" height="5"/></g></svg>`,
  marshal: (s?: number) =>
    svg(
      `<path d="M2.6 9.2h3.2L15.8 4.4v13.6L5.8 13.2H2.6a1.1 1.1 0 0 1-1.1-1.1v-1.8a1.1 1.1 0 0 1 1.1-1.1Z"/><path d="M5.4 13.2 6.8 19.3a1.2 1.2 0 0 0 2.34-.42L8.1 14.3"/><path d="M18.8 8.6a4.8 4.8 0 0 1 0 5.2"/><path d="M21.6 6a8.6 8.6 0 0 1 0 10.4"/>`,
      s
    ),
  trophy: (s?: number) =>
    svg(
      `<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>`,
      s
    ),
  bracket: (s?: number) =>
    svg(
      `<rect x="2" y="3" width="6" height="4" rx="1"/><rect x="2" y="10" width="6" height="4" rx="1"/><rect x="2" y="17" width="6" height="4" rx="1"/><rect x="16" y="6.5" width="6" height="4" rx="1"/><rect x="16" y="13.5" width="6" height="4" rx="1"/><path d="M8 5h4v3.5h4M8 12h4V8.5M8 19h4v-3.5h4"/>`,
      s
    ),
  plus: (s?: number) => svg(`<path d="M12 5v14M5 12h14"/>`, s),
  minus: (s?: number) => svg(`<path d="M5 12h14"/>`, s),
  cursor: (s?: number) =>
    svg(`<path d="m4 4 7.07 17 2.51-7.39L21 11.07z"/><path d="m13.5 13.5 6 6"/>`, s),
  hand: (s?: number) =>
    svg(
      `<path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v6"/><path d="M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>`,
      s
    ),
  maximize: (s?: number) =>
    svg(
      `<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>`,
      s
    ),
  layout: (s?: number) =>
    svg(
      `<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M10 6.5h4M10 6.5v11h4"/>`,
      s
    ),
  settings: (s?: number) =>
    svg(
      `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>`,
      s
    ),
  calendar: (s?: number) =>
    svg(`<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>`, s),
  lock: (s?: number) =>
    svg(`<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`, s),
  grip: (s?: number) =>
    svg(
      `<circle cx="9" cy="6" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.1" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.1" fill="currentColor" stroke="none"/>`,
      s
    ),
  unlock: (s?: number) =>
    svg(`<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.8-1"/>`, s),
  trendDown: (s?: number) => svg(`<path d="m3 7 7 7 4-4 7 7"/><path d="M15 17h6v-6"/>`, s),
  trendUp: (s?: number) => svg(`<path d="m3 17 7-7 4 4 7-7"/><path d="M15 7h6v6"/>`, s),
  chart: (s?: number) => svg(`<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>`, s),
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
      `<path d="M12 20.5V16"/><path d="M9.5 8.5V3.5"/><path d="M14.5 8.5V3.5"/><path d="M17.5 8.5v4a3.5 3.5 0 0 1-3.5 3.5h-4a3.5 3.5 0 0 1-3.5-3.5v-4Z"/>`,
      s
    ),
  plugOff: (s?: number) =>
    svg(
      `<path d="M12 20.5V16"/><path d="M9.5 6V3.5"/><path d="M14.5 8.5V3.5"/><path d="M12 8.5h5.5v4a3.5 3.5 0 0 1-.8 2.2"/><path d="M13.2 16H10a3.5 3.5 0 0 1-3.5-3.5V9"/><path d="m4 4 16 16"/>`,
      s
    ),
  bug: (s?: number) =>
    svg(
      `<rect x="8" y="6" width="8" height="14" rx="4"/><path d="M9 3l1.5 3M15 3l-1.5 3M8 11H4M20 11h-4M8 16H5M19 16h-3M12 10v10"/>`,
      s
    ),
  close: (s?: number) => svg(`<path d="M18 6 6 18M6 6l12 12"/>`, s),
  ban: (s?: number) => svg(`<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>`, s),
  moreHorizontal: (s?: number) =>
    svg(
      `<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>`,
      s
    ),
  moreVertical: (s?: number) =>
    svg(
      `<circle cx="12" cy="5" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.7" fill="currentColor" stroke="none"/>`,
      s
    ),
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
    svg(
      `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M15.5 15h-7"/><path d="m11.5 12-3 3 3 3"/>`,
      s
    ),
  help: (s?: number) =>
    svg(
      `<path d="M8.2 8.2a4 4 0 0 1 7.6 1.5c0 2.6-3.8 3.2-3.8 5.5" stroke-width="2.35"/><circle cx="12" cy="19.5" r="1.35" fill="currentColor" stroke="none"/>`,
      s
    ),
  about: (s?: number) =>
    svg(
      `<circle cx="12" cy="12" r="9"/><path d="M9.4 9.3a2.7 2.7 0 0 1 5.2 1c0 1.8-2.6 2.2-2.6 3.7"/><circle cx="12" cy="17.2" r="0.9" fill="currentColor" stroke="none"/>`,
      s
    ),
  siren: (s?: number) =>
    svg(
      `<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><circle cx="12" cy="16.8" r="0.8" fill="currentColor" stroke="none"/>`,
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
  download: (s?: number) =>
    svg(
      `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>`,
      s
    ),
  upload: (s?: number) =>
    svg(
      `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>`,
      s
    ),
  check: (s?: number) => svg(`<path d="M20 6 9 17l-5-5"/>`, s),
  link: (s?: number) =>
    svg(
      `<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`,
      s
    ),
  folder: (s?: number) =>
    svg(
      `<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>`,
      s
    ),
  tag: (s?: number) =>
    svg(
      `<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r="1.1" fill="currentColor" stroke="none"/>`,
      s
    ),
  terminal: (s?: number) => svg(`<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>`, s),
  wrapText: (s?: number) =>
    svg(
      `<path d="M3 6h18"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><path d="m16 16-2 2 2 2"/><path d="M3 18h7"/>`,
      s
    ),
  wrapTextOff: (s?: number) =>
    svg(
      `<path d="M3 6h3M11 6h10"/><path d="M3 12h9M17 12h1a3 3 0 0 1 2.1 5.1"/><path d="M3 18h7"/><path d="m2 2 20 20"/>`,
      s
    ),
  sidebarToggle: (s?: number) =>
    svg(`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>`, s),
  menuBack: (s?: number) =>
    svg(`<path d="M3 6h13M3 12h10M3 18h13"/><path d="m19 9-3 3 3 3"/>`, s),
  panels: (s?: number) =>
    svg(`<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/>`, s),
  layers: (s?: number) =>
    svg(`<path d="m12 2 10 5.5L12 13 2 7.5 12 2Z"/><path d="m2 12.5 10 5.5 10-5.5"/><path d="m2 17 10 5.5 10-5.5"/>`, s),
  search: (s?: number) =>
    svg(`<circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/>`, s),
  gauge: (s?: number) =>
    svg(`<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>`, s),
  alertTriangle: (s?: number) =>
    svg(
      `<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><circle cx="12" cy="16.8" r="0.8" fill="currentColor" stroke="none"/>`,
      s
    ),
  info: (s?: number) =>
    svg(
      `<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><circle cx="12" cy="8.2" r="0.9" fill="currentColor" stroke="none"/>`,
      s
    ),
  reviewCheck: (s?: number) =>
    svg(
      `<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m9 12 2 2 4-4"/><path d="M9 7h6M9 17h6"/>`,
      s
    ),
  checkSquare: (s = 16) =>
    svg(
      `<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="m8.2 12.2 2.5 2.5 5.1-5.2"/>`,
      s
    ),
  clock: (s = 16) =>
    svg(`<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v4.8l3.2 2"/>`, s),
  hammer: (s?: number) =>
    svg(
      `<path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/>`,
      s
    ),
  mallet: (s?: number) =>
    svg(
      `<path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/>`,
      s
    ),
  channelSwap: (w = 14) =>
    `<svg width="${w}" height="${Math.round(w * 0.86)}" viewBox="0 0 16 14" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.2 3.5H14.2M11.6 1.2L14.2 3.5L11.6 5.8"/><path d="M11.8 10.5H1.8M4.4 8.2L1.8 10.5L4.4 12.8"/></svg>`,
  playWaves: (s = 16) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.95" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="4 7.2 11.5 12 4 16.8 4 7.2"/><path d="M15.2 8.8a5.2 5.2 0 0 1 0 6.4"/><path d="M18.6 6a9.2 9.2 0 0 1 0 12"/></svg>`,
  checkeredFlag: (s = 15) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" shape-rendering="geometricPrecision" aria-hidden="true"><rect x="2" y="4.5" width="20" height="15" rx="2" stroke="currentColor" stroke-width="1.75"/><g fill="currentColor"><rect x="2" y="4.5" width="5" height="5"/><rect x="12" y="4.5" width="5" height="5"/><rect x="7" y="9.5" width="5" height="5"/><rect x="17" y="9.5" width="5" height="5"/><rect x="2" y="14.5" width="5" height="5"/><rect x="12" y="14.5" width="5" height="5"/></g></svg>`,
  rssiBadge: (s = 15) => svg(`<path d="M3 12h4l3-8 4 16 3-8h4"/>`, s),
  megaphone: (s = 20) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.6 9.2h3.2L15.8 4.4v13.6L5.8 13.2H2.6a1.1 1.1 0 0 1-1.1-1.1v-1.8a1.1 1.1 0 0 1 1.1-1.1Z"/><path d="M5.4 13.2 6.8 19.3a1.2 1.2 0 0 0 2.34-.42L8.1 14.3"/><path d="M18.8 8.6a4.8 4.8 0 0 1 0 5.2"/><path d="M21.6 6a8.6 8.6 0 0 1 0 10.4"/></svg>`,
  megaphoneOff: (s = 20) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.6 9.2h3.2L15.8 4.4v13.6L5.8 13.2H2.6a1.1 1.1 0 0 1-1.1-1.1v-1.8a1.1 1.1 0 0 1 1.1-1.1Z"/><path d="M5.4 13.2 6.8 19.3a1.2 1.2 0 0 0 2.34-.42L8.1 14.3"/><path d="m18.4 9.1 4.1 4.1M22.5 9.1l-4.1 4.1"/></svg>`,
  arrowUpDown: (s = 14) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="m21 8-4-4-4 4"/><path d="M17 4v16"/></svg>`,
  moon: (s?: number) => svg(`<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>`, s),
  sun: (s?: number) =>
    svg(
      `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>`,
      s
    ),
};
