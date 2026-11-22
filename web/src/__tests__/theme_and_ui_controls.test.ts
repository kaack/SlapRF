import { computeDirectionalPinch, computeWheelZoomFactors } from "../core/chart_pinch";
import { icons } from "../core/icons";
import { installMobileKeyboardShift } from "../core/mobile_keyboard";
import { Router } from "../core/router";
import {
  adaptColorForTheme,
  APP_THEME_STORAGE_KEY,
  getAppTheme,
  initAppTheme,
  inkOnColor,
  LIGHT_TIMER_COLORS,
  setAppTheme,
  subscribeAppTheme,
  theme,
} from "../core/theme";
import { Sidebar } from "../layout/Sidebar";
import { TopBar } from "../layout/TopBar";
import { AppShell } from "../layout/AppShell";
import { setDatasourceUiMode } from "../services/capabilities";
import { Announcer } from "../services/announcer";
import { ApiClient } from "../services/api_client";
import * as offlineModule from "../services/offline";
import { gateColor, TIMER_COLORS, timerColor } from "../state/selectors";
import { AppStore } from "../state/store";
import { channelColor, dbmToRgb } from "../views/debug/charts";
import { PilotRssiChart } from "../widgets/PilotRssiChart";
import { describe, expect, it, mountHtml } from "./harness";

describe("core/theme, Sidebar & TopBar theme toggler, icons, and neutral control styling", () => {
  it("switches between Dark (#d4ff3a neon) and Light (#2563eb Signal Cobalt + #f3f5f8 Soft Slate) and persists to localStorage", () => {
    try {
      localStorage.removeItem(APP_THEME_STORAGE_KEY);
      document.documentElement.removeAttribute("data-theme");
      initAppTheme();
      expect(getAppTheme()).toBe("dark");
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(theme.accent).toBe("#d4ff3a");
      expect(theme.bg).toBe("#0b0c0f");

      const observed: string[] = [];
      const unsub = subscribeAppTheme((m) => observed.push(m));

      setAppTheme("light");
      expect(getAppTheme()).toBe("light");
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(localStorage.getItem(APP_THEME_STORAGE_KEY)).toBe("light");
      expect(theme.accent).toBe("#2563eb");
      expect(theme.bg).toBe("#f3f5f8");
      expect(theme.surface).toBe("#ffffff");
      expect(theme.text).toBe("#181d27");
      expect(observed).toEqual(["light"]);

      const rootStyle = getComputedStyle(document.documentElement);
      expect(rootStyle.getPropertyValue("--accent").trim().toLowerCase()).toBe("#2563eb");
      expect(rootStyle.getPropertyValue("--bg").trim().toLowerCase()).toBe("#f3f5f8");
      expect(rootStyle.getPropertyValue("--icon").trim().toLowerCase()).toBe("#4a5468");
      expect(rootStyle.getPropertyValue("--node-surface").trim().toLowerCase()).toBe("#f8f8f8");
      expect(rootStyle.getPropertyValue("--node-border").trim().toLowerCase()).toBe("#b6c0cf");

      setAppTheme("dark");
      expect(getAppTheme()).toBe("dark");
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(localStorage.getItem(APP_THEME_STORAGE_KEY)).toBe("dark");
      expect(theme.accent).toBe("#d4ff3a");
      expect(observed).toEqual(["light", "dark"]);

      unsub();
    } finally {
      setAppTheme("dark");
    }
  });

  it("renders Quarter Moon & Sun theme toggler directly below About in Sidebar and mobile TopBar menu", () => {
    const host = mountHtml(`<aside id="sb"></aside><header id="tb"></header>`);
    const store = new AppStore();
    const api = new ApiClient(store);
    const router = new Router();
    const announcer = new Announcer(store);
    const sbEl = host.querySelector<HTMLElement>("#sb")!;
    const tbEl = host.querySelector<HTMLElement>("#tb")!;
    const sidebar = new Sidebar(sbEl, store, router);
    const topbar = new TopBar(tbEl, store, api, router, announcer);

    try {
      setAppTheme("dark");
      const nav = sbEl.querySelector("nav.nav")!;
      const aboutLink = nav.querySelector<HTMLAnchorElement>('a[data-route="about"]')!;
      expect(aboutLink).not.toBeNull();
      const themeRow = sbEl.querySelector<HTMLElement>(".sidebar-theme-row");
      expect(themeRow).not.toBeNull();
      expect(themeRow?.classList.contains("sidebar-theme-row")).toBe(true);

      // Mobile More tab shows a right-edge cue (vertical 3-dots strip) when a secondary route is active
      const moreBtn = sbEl.querySelector<HTMLButtonElement>('[data-action="toggle-mobile-more"]')!;
      router.navigateSection("races");
      expect(moreBtn.classList.contains("has-secondary-route")).toBe(false);
      expect(moreBtn.querySelector(".mobile-more-edge-cue")).toBeNull();
      router.navigateSection("flasher");
      expect(moreBtn.classList.contains("has-secondary-route")).toBe(true);
      expect(moreBtn.querySelector(".mobile-more-edge-cue")).not.toBeNull();
      expect(moreBtn.textContent).toContain("Flasher");
      router.navigateSection("races");

      const moreOverlay = sbEl.querySelector<HTMLElement>("[data-mobile-more-overlay]")!;
      expect(moreOverlay.hidden).toBe(true);
      moreBtn.click();
      expect(moreOverlay.hidden).toBe(false);
      expect(moreBtn.getAttribute("aria-expanded")).toBe("true");
      moreBtn.click();
      expect(moreBtn.getAttribute("aria-expanded")).toBe("false");
      expect(moreOverlay.classList.contains("is-closing")).toBe(true);

      const darkBtn = themeRow!.querySelector<HTMLButtonElement>('button[data-set-theme="dark"]')!;
      const lightBtn = themeRow!.querySelector<HTMLButtonElement>('button[data-set-theme="light"]')!;
      expect(darkBtn).not.toBeNull();
      expect(lightBtn).not.toBeNull();
      expect(darkBtn.classList.contains("is-active")).toBe(true);
      expect(darkBtn.getAttribute("aria-pressed")).toBe("true");
      expect(lightBtn.classList.contains("is-active")).toBe(false);
      expect(lightBtn.getAttribute("aria-pressed")).toBe("false");

      lightBtn.click();
      expect(getAppTheme()).toBe("light");
      expect(lightBtn.classList.contains("is-active")).toBe(true);
      expect(lightBtn.getAttribute("aria-pressed")).toBe("true");
      expect(darkBtn.classList.contains("is-active")).toBe(false);

      // Mobile TopBar menu also exposes the theme toggler below About
      const menuBtn = tbEl.querySelector<HTMLButtonElement>('button[data-action="menu"]');
      expect(menuBtn).not.toBeNull();
      menuBtn!.click();
      const mobDarkBtn = tbEl.querySelector<HTMLButtonElement>(
        '.topbar-nav-popover button[data-set-theme="dark"]'
      );
      const mobLightBtn = tbEl.querySelector<HTMLButtonElement>(
        '.topbar-nav-popover button[data-set-theme="light"]'
      );
      expect(mobDarkBtn).not.toBeNull();
      expect(mobLightBtn).not.toBeNull();
      expect(mobLightBtn!.classList.contains("is-active")).toBe(true);

      mobDarkBtn!.click();
      expect(getAppTheme()).toBe("dark");
      expect(darkBtn.classList.contains("is-active")).toBe(true);

      // TopBar never renders a PWA install button or popover
      expect(tbEl.querySelector('[data-action="install-pwa"]')).toBeNull();
      expect(tbEl.querySelector(".topbar-pwa-wrap")).toBeNull();
      expect(tbEl.querySelector("[data-pwa-install-popover]")).toBeNull();
    } finally {
      sidebar.destroy();
      topbar.destroy();
      setAppTheme("dark");
    }
  });

  it("suppresses beforeinstallprompt events and exposes no PWA install prompt helpers", () => {
    expect("triggerPwaInstallPrompt" in offlineModule).toBe(false);
    expect("subscribePwaInstallState" in offlineModule).toBe(false);
    expect("isPwaStandalone" in offlineModule).toBe(false);
    expect("installPwa" in icons).toBe(false);

    const ev = new Event("beforeinstallprompt", { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("updates only icons.chart for Analytics while preserving icons.pilot and adding moon/sun", () => {
    const chartSvg = icons.chart(16);
    expect(chartSvg.includes("M3 3v18h18")).toBe(true);
    expect(chartSvg.includes("m19 9-5 5-4-4-3 3")).toBe(true);

    const pilotSvg = icons.pilot(16);
    expect(pilotSvg.includes('circle cx="9" cy="7" r="4"')).toBe(true);
    expect(pilotSvg.includes("M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2")).toBe(true);

    expect(icons.moon(15).includes("<svg")).toBe(true);
    expect(icons.sun(15).includes("<svg")).toBe(true);
  });

  it("styles megaphone lap-announcements toggle by swapping icon without bolding stroke-width, fixes handle geometry, and keeps controls free of danger red", () => {
    const host = mountHtml(`
      <span id="ref-text" style="color: var(--text)"></span>
      <button class="race-lap-announce-btn is-active" style="transition: none">${icons.megaphone(21)}</button>
      <button class="race-lap-announce-btn is-muted" style="transition: none">${icons.megaphoneOff(21)}</button>
      <button class="btn btn-danger" style="transition: none">Abort</button>
      <button class="btn lap-ed-del-btn" style="transition: none">${icons.trash(14)}</button>
      <div class="fmt-stage-node" style="transition: none"></div>
      <div class="bkt-round-node is-rc-node" style="transition: none"></div>
      <div class="bkt-round-node is-pilots-node" style="transition: none"></div>
    `);
    const refText = host.querySelector<HTMLElement>("#ref-text")!;
    const activeBtn = host.querySelector<HTMLButtonElement>(".race-lap-announce-btn.is-active")!;
    const mutedBtn = host.querySelector<HTMLButtonElement>(".race-lap-announce-btn.is-muted")!;
    const dangerBtn = host.querySelector<HTMLButtonElement>(".btn-danger")!;
    const fmtNode = host.querySelector<HTMLElement>(".fmt-stage-node")!;
    const roundNode = host.querySelector<HTMLElement>(".bkt-round-node.is-rc-node")!;
    const pilotsNode = host.querySelector<HTMLElement>(".bkt-round-node.is-pilots-node")!;

    try {
      // Handle right leg terminates on the horn bottom edge (8.1, 14.3) rather than sticking through to y=13.2
      expect(icons.megaphone(21).includes("L8.1 14.3")).toBe(true);
      expect(icons.megaphoneOff(21).includes("L8.1 14.3")).toBe(true);
      expect(icons.megaphone(21)).not.toBe(icons.megaphoneOff(21));

      for (const mode of ["dark", "light"] as const) {
        setAppTheme(mode);
        const activeSvgStyle = getComputedStyle(activeBtn.querySelector("svg")!);
        const mutedSvgStyle = getComputedStyle(mutedBtn.querySelector("svg")!);
        // Both ON and OFF use the same normal stroke-width (no bolding)
        expect(activeSvgStyle.strokeWidth).toBe(mutedSvgStyle.strokeWidth);

        // Active and muted megaphone buttons share identical resting colors and borders (only the icon inside changes)
        expect(getComputedStyle(activeBtn).color).toBe(getComputedStyle(mutedBtn).color);
        expect(getComputedStyle(activeBtn).backgroundColor).toBe(getComputedStyle(mutedBtn).backgroundColor);
        expect(getComputedStyle(activeBtn).borderTopColor).toBe(getComputedStyle(mutedBtn).borderTopColor);

        // Abort / .btn-danger control must use neutral text color, never danger red
        const expectedText = getComputedStyle(refText).color;
        expect(getComputedStyle(dangerBtn).color).toBe(expectedText);

        if (mode === "light") {
          for (const node of [fmtNode, roundNode, pilotsNode]) {
            expect(getComputedStyle(node).backgroundColor).toBe("rgb(248, 248, 248)");
            expect(getComputedStyle(node).borderTopColor).toBe("rgb(182, 192, 207)");
          }
        }
      }
    } finally {
      setAppTheme("dark");
    }
  });

  it("applies soft offset surface (#f4f6f9) without border to chart areas, 3D raised AirTag elevation to Track timers, and Light waterfall palette", () => {
    const host = mountHtml(`
      <div class="canvas-host canvas-host-md scope-canvas" style="transition: none"></div>
      <div class="debug-canvas-wrap" style="transition: none"></div>
      <div class="lap-ed-graph-card" style="transition: none"></div>
      <div class="debug-health-card" style="transition: none"></div>
      <button class="gate-node-circle" style="--c:#4d7c0f; transition: none"></button>
      <div class="unassigned-timer-token" style="--c:#0284c7; transition: none">
        <span class="unassigned-timer-dot">T2</span>
      </div>
    `);
    const scopeHost = host.querySelector<HTMLElement>(".scope-canvas")!;
    const debugWrap = host.querySelector<HTMLElement>(".debug-canvas-wrap")!;
    const lapEdCard = host.querySelector<HTMLElement>(".lap-ed-graph-card")!;
    const healthCard = host.querySelector<HTMLElement>(".debug-health-card")!;
    const gateCircle = host.querySelector<HTMLElement>(".gate-node-circle")!;
    const unassignedToken = host.querySelector<HTMLElement>(".unassigned-timer-token")!;

    const store = new AppStore();
    store.hydrate({
      operatingMode: "practice",
      simulatorRunning: false,
      timingHardwareMode: "slaprf",
      pilots: [],
      nodes: [
        { gateId: 1, name: "H1", role: "START_FINISH", trackOrder: 0, assignedTimerId: 1, color: "#d4ff3a" },
        { gateId: 2, name: "T1", role: "SECTOR", trackOrder: 1, assignedTimerId: 2, color: "#38bdf8" },
      ],
      detectedTimers: [
        { timerId: 1, timerLabel: "H1", isHub: true, online: true, color: "#d4ff3a", batteryMv: 0, batteryPct: 0, firmwareVersion: "1.0" },
        { timerId: 2, timerLabel: "T1", isHub: false, online: true, color: "#38bdf8", batteryMv: 0, batteryPct: 0, firmwareVersion: "1.0" },
        { timerId: 7, timerLabel: "T6", isHub: false, online: true, color: "#facc15", batteryMv: 0, batteryPct: 0, firmwareVersion: "1.0" },
        { timerId: 12, timerLabel: "T11", isHub: false, online: true, color: "#ffffff", batteryMv: 0, batteryPct: 0, firmwareVersion: "1.0" },
      ],
      laps: [],
      recentCrossings: [],
      recentFiltered: [],
      summaries: [],
      rules: { minLapSec: 5, maxLapSec: 120, minCrossingSec: 0.12, beepOnCross: false },
      raceArmed: true,
      race: store.raceState,
    });

    try {
      setAppTheme("dark");
      expect(timerColor(store, 1)).toBe("#d4ff3a");
      expect(gateColor(store, 1)).toBe("#d4ff3a");
      expect(timerColor(store, 2)).toBe("#38bdf8");
      expect(timerColor(store, 7)).toBe("#facc15");
      expect(timerColor(store, 12)).toBe("#ffffff");
      expect(channelColor(7)).toBe("#84cc16");
      expect(inkOnColor("#d4ff3a")).toBe("#0b0d10");
      expect(dbmToRgb(-100, -100, -40)).toEqual([11, 12, 15]);

      setAppTheme("light");
      expect(theme.chartSurface).toBe("#f4f6f9");
      expect(theme.chartBorder).toBe("transparent");
      for (const el of [scopeHost, debugWrap, lapEdCard, healthCard]) {
        expect(getComputedStyle(el).backgroundColor).toBe("rgb(244, 246, 249)");
      }
      // Chart hosts have no border in Light theme
      expect(getComputedStyle(scopeHost).borderTopStyle).toBe("none");
      expect(getComputedStyle(debugWrap).borderTopStyle).toBe("none");
      expect(getComputedStyle(lapEdCard).borderTopColor).toBe("rgba(0, 0, 0, 0)");
      expect(getComputedStyle(healthCard).borderTopColor).toBe("rgba(0, 0, 0, 0)");

      // Waterfall spectrogram in Light theme starts at cool light slate (#eef2f7) instead of black (#0b0c0f)
      expect(dbmToRgb(-100, -100, -40)).toEqual([238, 242, 247]);
      expect(dbmToRgb(-40, -100, -40)).toEqual([194, 65, 12]);

      // Track timers and unassigned tokens have 3D AirTag multi-layer shadows in Light theme without interior color-mix tint
      expect(getComputedStyle(gateCircle).boxShadow.includes("inset")).toBe(true);
      expect(getComputedStyle(gateCircle).backgroundImage.includes("color-mix")).toBe(false);
      expect(getComputedStyle(unassignedToken).boxShadow.includes("inset")).toBe(true);

      // Network Spoke active LEDs in Light theme are glowing green (#10b981 = rgb(16, 185, 129)), matching Hub (.is-up), while top-right .is-neon LED is glowing blue (#3b82f6 = rgb(59, 130, 246))
      const ledProbe = document.createElement("div");
      ledProbe.innerHTML = `
        <span class="status-dot is-up" id="test-hub-dot"></span>
        <span class="status-dot is-spoke" id="test-spoke-dot"></span>
        <span class="status-dot is-warn" id="test-warn-dot"></span>
        <button class="topbar-conn-led is-neon"><span class="topbar-conn-led-bulb" id="test-neon-bulb"></span></button>
        <div class="input-with-dot has-mgp" id="test-mgp-wrap">
          <span class="dot" style="--c:#4d7c0f"></span>
          <input class="input" name="callsign" value="Maverick" />
          <span class="badge pilot-mgp-badge mono" id="test-mgp-badge">MGP</span>
        </div>
        <button class="race-lap-announce-btn is-active" id="test-lap-btn-on"></button>
        <button class="race-lap-announce-btn is-muted" id="test-lap-btn-off"></button>
        <button class="race-pen-hammer-btn" id="test-hammer-btn"></button>
        <button class="race-state-pill is-table-status-pill race-status-trigger is-finished" id="test-status-pill">
          <span>Scratched</span>
          <span class="race-status-caret" id="test-status-caret"></span>
        </button>
        <div class="slot-table timer-table sim-boards-table" style="width:900px">
          <div class="timer-table-row sim-timer-table-row timer-table-head">
            <span>Board</span>
            <span id="test-sim-head-power">Power</span>
            <span id="test-sim-head-role">Role</span>
            <span id="test-sim-head-fw">Firmware</span>
            <span id="test-sim-head-track">Track</span>
            <span class="num">Actions</span>
          </div>
          <div class="timer-table-row sim-timer-table-row">
            <div>T1</div>
            <div id="test-sim-col-power">On</div>
            <div id="test-sim-col-role">Spoke</div>
            <div id="test-sim-col-fw">v1.4.2</div>
            <div id="test-sim-col-track">#1</div>
            <div class="sim-timer-row-actions"><button class="btn btn-sm btn-ghost">Turn off</button><button class="btn btn-sm btn-ghost">Delete</button></div>
          </div>
        </div>
        <div class="bkt-pilot-item is-in" id="test-pilot-row-on">
          <div class="bkt-pilot-item-main">
            <button class="bkt-checkin-switch is-on" id="test-checkin-on"><span class="bkt-checkin-thumb" id="test-checkin-thumb"></span></button>
            <strong class="bkt-pilot-callsign">Pilot A</strong>
          </div>
          <div class="bkt-pilot-att-seg"><button class="bkt-pilot-att-btn">AWY</button><button class="bkt-pilot-att-btn">DQ</button><button class="bkt-pilot-att-btn">DNC</button></div>
        </div>
        <div class="bkt-pilot-item is-inactive" id="test-pilot-row-off">
          <div class="bkt-pilot-item-main">
            <button class="bkt-checkin-switch" id="test-checkin-off"><span class="bkt-checkin-thumb" id="test-checkin-thumb-off"></span></button>
            <strong class="bkt-pilot-callsign">Pilot B</strong>
          </div>
          <span class="bkt-pilot-unchecked-lbl">Free</span>
        </div>
        <div class="bkt-card" style="width:240px">
          <div class="bkt-seats">
            <div class="bkt-seat is-winner">
              <span class="bkt-ch mono">R1</span>
              <span class="bkt-name-wrap"><span class="bkt-name">Pilot A</span></span>
              <span class="bkt-pos is-adv"><span class="bkt-pos-text" id="test-bkt-pos-1">1st</span><span class="bkt-pos-mark" aria-hidden="true">✓</span></span>
            </div>
            <div class="bkt-seat">
              <span class="bkt-ch mono">R2</span>
              <span class="bkt-name-wrap"><span class="bkt-name">Pilot B</span></span>
              <span class="bkt-pos"><span class="bkt-pos-text" id="test-bkt-pos-3">3rd</span><span class="bkt-pos-mark" aria-hidden="true"></span></span>
            </div>
            <div class="bkt-seat is-out">
              <span class="bkt-ch mono">R3</span>
              <span class="bkt-name-wrap"><span class="bkt-name">Pilot C</span></span>
              <span class="bkt-pos is-warn"><span class="bkt-pos-text" id="test-bkt-pos-dnf">DNF</span><span class="bkt-pos-mark" aria-hidden="true"></span></span>
            </div>
          </div>
        </div>
      `;
      host.appendChild(ledProbe);
      const hubDot = ledProbe.querySelector<HTMLElement>("#test-hub-dot")!;
      const spokeDot = ledProbe.querySelector<HTMLElement>("#test-spoke-dot")!;
      const warnDot = ledProbe.querySelector<HTMLElement>("#test-warn-dot")!;
      const neonBulb = ledProbe.querySelector<HTMLElement>("#test-neon-bulb")!;
      const mgpBadge = ledProbe.querySelector<HTMLElement>("#test-mgp-badge")!;
      const mgpInput = ledProbe.querySelector<HTMLInputElement>("#test-mgp-wrap .input")!;
      const lapBtnOn = ledProbe.querySelector<HTMLElement>("#test-lap-btn-on")!;
      const lapBtnOff = ledProbe.querySelector<HTMLElement>("#test-lap-btn-off")!;
      const hammerBtn = ledProbe.querySelector<HTMLElement>("#test-hammer-btn")!;
      const statusPill = ledProbe.querySelector<HTMLElement>("#test-status-pill")!;
      const statusCaret = ledProbe.querySelector<HTMLElement>("#test-status-caret")!;
      const simHeadPower = ledProbe.querySelector<HTMLElement>("#test-sim-head-power")!;
      const simHeadRole = ledProbe.querySelector<HTMLElement>("#test-sim-head-role")!;
      const simHeadFw = ledProbe.querySelector<HTMLElement>("#test-sim-head-fw")!;
      const simHeadTrack = ledProbe.querySelector<HTMLElement>("#test-sim-head-track")!;
      const simColPower = ledProbe.querySelector<HTMLElement>("#test-sim-col-power")!;
      const simColRole = ledProbe.querySelector<HTMLElement>("#test-sim-col-role")!;
      const simColFw = ledProbe.querySelector<HTMLElement>("#test-sim-col-fw")!;
      const simColTrack = ledProbe.querySelector<HTMLElement>("#test-sim-col-track")!;
      const checkinOn = ledProbe.querySelector<HTMLElement>("#test-checkin-on")!;
      const checkinOff = ledProbe.querySelector<HTMLElement>("#test-checkin-off")!;
      const checkinThumb = ledProbe.querySelector<HTMLElement>("#test-checkin-thumb")!;
      const checkinThumbOff = ledProbe.querySelector<HTMLElement>("#test-checkin-thumb-off")!;
      const pilotRowOn = ledProbe.querySelector<HTMLElement>("#test-pilot-row-on")!;
      const pilotRowOff = ledProbe.querySelector<HTMLElement>("#test-pilot-row-off")!;
      const bktPos1 = ledProbe.querySelector<HTMLElement>("#test-bkt-pos-1")!;
      const bktPos3 = ledProbe.querySelector<HTMLElement>("#test-bkt-pos-3")!;
      const bktPosDnf = ledProbe.querySelector<HTMLElement>("#test-bkt-pos-dnf")!;

      expect(getComputedStyle(hubDot).backgroundColor).toBe("rgb(16, 185, 129)");
      expect(getComputedStyle(spokeDot).backgroundColor).toBe("rgb(16, 185, 129)");
      expect(getComputedStyle(warnDot).backgroundColor).toBe("rgb(245, 158, 11)");
      expect(getComputedStyle(neonBulb).backgroundColor).toBe("rgb(59, 130, 246)");
      expect(getComputedStyle(mgpBadge).position).toBe("absolute");
      expect(getComputedStyle(mgpInput).paddingRight).toBe("44px");

      // Lap announcements button has identical styling whether on (.is-active) or off (.is-muted)
      expect(getComputedStyle(lapBtnOn).backgroundColor).toBe(getComputedStyle(lapBtnOff).backgroundColor);
      expect(getComputedStyle(lapBtnOn).borderTopColor).toBe(getComputedStyle(lapBtnOff).borderTopColor);
      expect(getComputedStyle(lapBtnOn).color).toBe(getComputedStyle(lapBtnOff).color);

      // Animated penalty hammer cursor in Light theme uses #4a5365 border, white handle (#ffffff), and yellow head (#fbbf24)
      expect(getComputedStyle(hammerBtn).cursor).toContain("%234a5365");
      expect(getComputedStyle(hammerBtn).cursor).toContain("%23ffffff");
      expect(getComputedStyle(hammerBtn).cursor).toContain("%23fbbf24");

      // Flight line status pill is compact (104px), horizontally centered, with absolutely positioned caret
      expect(getComputedStyle(statusPill).width).toBe("104px");
      expect(getComputedStyle(statusPill).justifyContent).toBe("center");
      expect(getComputedStyle(statusCaret).position).toBe("absolute");

      // Simulator boards table centers Power, Role, Firmware, and Track columns AND aligns header cells with body cells
      expect(getComputedStyle(simColPower).justifyContent).toBe("center");
      expect(getComputedStyle(simColRole).justifyContent).toBe("center");
      expect(getComputedStyle(simColFw).justifyContent).toBe("center");
      expect(getComputedStyle(simColTrack).justifyContent).toBe("center");
      expect(Math.round(simHeadPower.getBoundingClientRect().left)).toBe(Math.round(simColPower.getBoundingClientRect().left));
      expect(Math.round(simHeadRole.getBoundingClientRect().left)).toBe(Math.round(simColRole.getBoundingClientRect().left));
      expect(Math.round(simHeadFw.getBoundingClientRect().left)).toBe(Math.round(simColFw.getBoundingClientRect().left));
      expect(Math.round(simHeadTrack.getBoundingClientRect().left)).toBe(Math.round(simColTrack.getBoundingClientRect().left));

      // Checked-in pilot toggle (.bkt-checkin-switch.is-on) keeps identical border & size, slightly darker background (#e4e9f1), and off-dark slate thumb (#4a5365, not black), with identical 36px row height
      expect(getComputedStyle(checkinOn).borderTopColor).toBe(getComputedStyle(checkinOff).borderTopColor);
      expect(getComputedStyle(checkinOn).width).toBe(getComputedStyle(checkinOff).width);
      expect(getComputedStyle(checkinOn).height).toBe(getComputedStyle(checkinOff).height);
      expect(getComputedStyle(pilotRowOn).height).toBe("36px");
      expect(getComputedStyle(pilotRowOff).height).toBe("36px");
      expect(getComputedStyle(checkinOn).backgroundColor).toBe("rgb(228, 233, 241)");
      expect(getComputedStyle(checkinThumbOff).backgroundColor).toBe("rgb(114, 124, 144)");
      expect(getComputedStyle(checkinThumb).backgroundColor).toBe("rgb(74, 83, 101)");

      // Confirmed heat seat status text (1st, 3rd, DNF) right edges are aligned at the exact same X-coordinate via reserved .bkt-pos-mark column
      const right1 = Math.round(bktPos1.getBoundingClientRect().right);
      const right3 = Math.round(bktPos3.getBoundingClientRect().right);
      const rightDnf = Math.round(bktPosDnf.getBoundingClientRect().right);
      expect(right1).toBe(right3);
      expect(right3).toBe(rightDnf);

      // All 12 canonical timer colors adapt cleanly without neon glare or pure white
      expect(TIMER_COLORS.length).toBe(LIGHT_TIMER_COLORS.length);
      for (let i = 0; i < TIMER_COLORS.length; i++) {
        expect(adaptColorForTheme(TIMER_COLORS[i])).toBe(LIGHT_TIMER_COLORS[i]);
      }
      expect(timerColor(store, 1)).toBe("#4d7c0f");
      expect(gateColor(store, 1)).toBe("#4d7c0f");
      expect(timerColor(store, 2)).toBe("#0284c7");
      expect(timerColor(store, 7)).toBe("#a16207");
      expect(timerColor(store, 12)).toBe("#334155");
      expect(channelColor(7)).toBe("#4d7c0f");
      expect(inkOnColor("#4d7c0f")).toBe("#ffffff");
      expect(inkOnColor("#334155")).toBe("#ffffff");

      // Switching back to Dark restores canonical neon colors losslessly
      setAppTheme("dark");
      expect(timerColor(store, 1)).toBe("#d4ff3a");
      expect(gateColor(store, 1)).toBe("#d4ff3a");
      expect(timerColor(store, 12)).toBe("#ffffff");
    } finally {
      setAppTheme("dark");
    }
  });

  it("supports directional 2-finger pinch (horizontal X, vertical Y, diagonal X+Y) and modifier-wheel chart zoom", () => {
    // 1. Pure math: horizontal spread -> X only
    const horiz = computeDirectionalPinch(
      { x: 100, y: 120 },
      { x: 180, y: 126 },
      { x: 60, y: 118 },
      { x: 220, y: 128 }
    );
    expect(horiz.mode).toBe("x");
    expect(horiz.xSpanFactor < 0.65).toBe(true);
    expect(horiz.ySpanFactor).toBe(1);

    // 2. Pure math: vertical spread -> Y only
    const vert = computeDirectionalPinch(
      { x: 150, y: 80 },
      { x: 156, y: 160 },
      { x: 148, y: 40 },
      { x: 158, y: 200 }
    );
    expect(vert.mode).toBe("y");
    expect(vert.xSpanFactor).toBe(1);
    expect(vert.ySpanFactor < 0.65).toBe(true);

    // 3. Pure math: diagonal spread -> simultaneous X + Y
    const diag = computeDirectionalPinch(
      { x: 120, y: 100 },
      { x: 180, y: 160 },
      { x: 80, y: 60 },
      { x: 220, y: 200 }
    );
    expect(diag.mode).toBe("xy");
    expect(diag.xSpanFactor < 0.65).toBe(true);
    expect(diag.ySpanFactor < 0.65).toBe(true);

    // 3b. Pure math: parallel 2-finger vertical movement -> page-scroll mode without zooming X or Y
    const parallelDown = computeDirectionalPinch(
      { x: 110, y: 120 },
      { x: 190, y: 124 },
      { x: 112, y: 80 },
      { x: 191, y: 83 }
    );
    expect(parallelDown.mode).toBe("page-scroll");
    expect(parallelDown.xSpanFactor).toBe(1);
    expect(parallelDown.ySpanFactor).toBe(1);

    // 4. Close-finger pinch-out (< 16px initial gap) stays finite & smooth
    const closeStart = computeDirectionalPinch(
      { x: 145, y: 120 },
      { x: 155, y: 122 },
      { x: 95, y: 118 },
      { x: 205, y: 124 }
    );
    expect(closeStart.mode).toBe("x");
    expect(closeStart.xSpanFactor > 0.2 && closeStart.xSpanFactor < 0.4).toBe(true);

    // 5. Modifier + wheel mapping for Chrome Desktop & DevTools Mobile testing
    expect(
      computeWheelZoomFactors({
        deltaX: 0,
        deltaY: -100,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      })
    ).toBeNull();
    const shiftWheel = computeWheelZoomFactors({
      deltaX: 0,
      deltaY: -100,
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
      altKey: false,
    });
    expect(shiftWheel?.mode).toBe("x");
    expect((shiftWheel?.xSpanFactor ?? 1) < 1).toBe(true);
    expect(shiftWheel?.ySpanFactor).toBe(1);

    const altWheel = computeWheelZoomFactors({
      deltaX: 0,
      deltaY: -100,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: true,
    });
    expect(altWheel?.mode).toBe("y");
    expect(altWheel?.xSpanFactor).toBe(1);
    expect((altWheel?.ySpanFactor ?? 1) < 1).toBe(true);

    const ctrlWheel = computeWheelZoomFactors({
      deltaX: 0,
      deltaY: -100,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
    });
    expect(ctrlWheel?.mode).toBe("xy");
    expect((ctrlWheel?.xSpanFactor ?? 1) < 1).toBe(true);
    expect((ctrlWheel?.ySpanFactor ?? 1) < 1).toBe(true);

    // 6. Live DOM & PointerEvent verification on PilotRssiChart
    const RSSI_PREF_KEY = "slaprf.ui.rssi_chart.v1";
    localStorage.removeItem(RSSI_PREF_KEY);
    const root = mountHtml(`<div style="width: 420px; height: 320px;"></div>`);
    const hostEl = root.firstElementChild as HTMLElement;
    const store = new AppStore();
    const api = new ApiClient(() => {});
    const chart = new PilotRssiChart(hostEl, store, api);
    try {
      const scopeHost = hostEl.querySelector<HTMLElement>('[data-slot="chart"]')!;
      const surfaceCanvas = scopeHost.querySelector<HTMLElement>(".surface-canvas")!;
      // Critical mobile fix: canvas must NOT inherit touch-action: pan-y from .surface-canvas
      expect(getComputedStyle(surfaceCanvas).touchAction).toBe("none");

      const rect = scopeHost.getBoundingClientRect();
      const fireTouch = (type: string, pointerId: number, localX: number, localY: number) => {
        scopeHost.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId,
            pointerType: "touch",
            clientX: rect.left + localX,
            clientY: rect.top + localY,
          })
        );
      };

      // Horizontal 2-finger pinch (started only 16px apart so old code would have misfired double-tap!)
      fireTouch("pointerdown", 1, 170, 110);
      fireTouch("pointerdown", 2, 186, 112);
      fireTouch("pointermove", 1, 100, 109);
      fireTouch("pointermove", 2, 256, 113);
      fireTouch("pointerup", 2, 256, 113);
      fireTouch("pointerup", 1, 100, 109);

      let saved = JSON.parse(localStorage.getItem(RSSI_PREF_KEY) || "{}");
      expect(saved.autoX).toBe(false);
      expect(saved.windowUs < 15_000_000).toBe(true);
      expect(saved.autoY).toBe(true);

      // Reset and run a vertical 2-finger pinch -> stretches Y only, keeps Auto X on
      chart.restoreDefaults();
      fireTouch("pointerdown", 3, 180, 70);
      fireTouch("pointerdown", 4, 184, 130);
      fireTouch("pointermove", 3, 179, 30);
      fireTouch("pointermove", 4, 185, 175);
      fireTouch("pointerup", 4, 185, 175);
      fireTouch("pointerup", 3, 179, 30);

      saved = JSON.parse(localStorage.getItem(RSSI_PREF_KEY) || "{}");
      expect(saved.autoX).toBe(true);
      expect(saved.autoY).toBe(false);

      // Reset and run a diagonal 2-finger pinch -> stretches both X and Y simultaneously
      chart.restoreDefaults();
      fireTouch("pointerdown", 5, 140, 75);
      fireTouch("pointerdown", 6, 200, 135);
      fireTouch("pointermove", 5, 95, 35);
      fireTouch("pointermove", 6, 245, 180);
      fireTouch("pointerup", 6, 245, 180);
      fireTouch("pointerup", 5, 95, 35);

      saved = JSON.parse(localStorage.getItem(RSSI_PREF_KEY) || "{}");
      expect(saved.autoX).toBe(false);
      expect(saved.autoY).toBe(false);

      // Reset and run a parallel 2-finger vertical scroll over the chart -> scrolls outer page without altering chart autoX / autoY
      chart.restoreDefaults();
      fireTouch("pointerdown", 7, 130, 140);
      fireTouch("pointerdown", 8, 210, 142);
      fireTouch("pointermove", 7, 130, 128);
      fireTouch("pointermove", 8, 210, 130);
      fireTouch("pointermove", 7, 131, 90);
      fireTouch("pointermove", 8, 211, 92);
      fireTouch("pointerup", 8, 211, 92);
      fireTouch("pointerup", 7, 131, 90);

      saved = JSON.parse(localStorage.getItem(RSSI_PREF_KEY) || "{}");
      expect(saved.autoX).toBe(true);
      expect(saved.autoY).toBe(true);

      // Verify .net-metric-pair inside .badge preserves a clean visual gap (>= 3px) and identical total width across 1..5 chars
      const metricBox = mountHtml(`
        <div>
          <span class="badge badge-good mono" id="rate-small"><span class="net-metric-pair"><span class="net-num-slot is-rate" id="num-s">1.0</span> <span id="unit-s">pkt/s</span></span></span>
          <span class="badge badge-good mono" id="rate-big"><span class="net-metric-pair"><span class="net-num-slot is-rate" id="num-b">325.4</span> <span id="unit-b">pkt/s</span></span></span>
        </div>
      `);
      const numB = metricBox.querySelector<HTMLElement>("#num-b")!.getBoundingClientRect();
      const unitB = metricBox.querySelector<HTMLElement>("#unit-b")!.getBoundingClientRect();
      expect(unitB.left - numB.right >= 3).toBe(true);
      const badgeSmallW = metricBox.querySelector<HTMLElement>("#rate-small")!.getBoundingClientRect().width;
      const badgeBigW = metricBox.querySelector<HTMLElement>("#rate-big")!.getBoundingClientRect().width;
      expect(Math.abs(badgeSmallW - badgeBigW) < 0.5).toBe(true);
    } finally {
      localStorage.removeItem(RSSI_PREF_KEY);
      chart.destroy();
    }
  });

  it("shifts mobile drawers via GPU-composited translate without root style invalidation", () => {
    installMobileKeyboardShift();
    expect(typeof window.__slaprfSetKbOffset).toBe("function");

    const host = mountHtml(`
      <div>
        <div class="pilot-dir-mobile-drawer-overlay">
          <div class="pilot-dir-mobile-editor" id="kb-test-pilot" style="height:260px"></div>
        </div>
        <div class="scope-tune-drawer" id="kb-test-tune" style="height:240px"></div>
      </div>
    `);
    const pilotSheet = host.querySelector<HTMLElement>("#kb-test-pilot")!;
    const tuneSheet = host.querySelector<HTMLElement>("#kb-test-tune")!;

    window.__slaprfSetKbOffset!(310.5, 285, true);
    expect(document.documentElement.style.getPropertyValue("--slaprf-kb-offset")).toBe("");
    expect(pilotSheet.style.transition).toBe("translate 285ms cubic-bezier(0.2, 0, 0, 1)");
    expect(pilotSheet.style.translate).toContain("-");
    expect(tuneSheet.style.transition).toBe("translate 285ms cubic-bezier(0.2, 0, 0, 1)");
    expect(tuneSheet.style.translate).toContain("-");

    window.__slaprfSetKbOffset!(0, 285, false);
    expect(pilotSheet.style.translate).toBe("0px");
    pilotSheet.dispatchEvent(new TransitionEvent("transitionend", { propertyName: "translate" }));
    expect(pilotSheet.style.translate).toBe("");
    expect(pilotSheet.style.transition).toBe("");
    window.__slaprfSetKbOffset!(0, 0, false);

    // Verify pilot name and channel label inside Signals pilot pills share identical vertical bounds
    const pillProbe = mountHtml(`
      <div class="practice-workspace-page" data-mobile-practice-view="signals">
        <div class="practice-picker-row">
          <button class="pilot-chip is-active" style="--c:#a3e635">
            <span class="dot"></span>
            <span class="pilot-chip-name" id="test-chip-name">FAERRY</span>
            <span class="pilot-chip-chan mono" id="test-chip-chan">R1</span>
          </button>
        </div>
        <button class="races-filter-pill rc-sig-pilot-pill is-active" style="--c:#a3e635">
          <span class="dot" style="--c:#a3e635"></span>
          <span id="test-sig-name">FAERRY</span>
          <span class="mono note" id="test-sig-chan">R1</span>
        </button>
      </div>
    `);
    const chipNameRect = pillProbe.querySelector<HTMLElement>("#test-chip-name")!.getBoundingClientRect();
    const chipChanRect = pillProbe.querySelector<HTMLElement>("#test-chip-chan")!.getBoundingClientRect();
    expect(Math.abs(chipNameRect.top - chipChanRect.top) < 0.5).toBe(true);
    expect(Math.abs(chipNameRect.bottom - chipChanRect.bottom) < 0.5).toBe(true);

    const sigNameRect = pillProbe.querySelector<HTMLElement>("#test-sig-name")!.getBoundingClientRect();
    const sigChanRect = pillProbe.querySelector<HTMLElement>("#test-sig-chan")!.getBoundingClientRect();
    expect(Math.abs(sigNameRect.top - sigChanRect.top) < 0.5).toBe(true);
    expect(Math.abs(sigNameRect.bottom - sigChanRect.bottom) < 0.5).toBe(true);

    // Verify Simulator Pit Bench & Battery Swap Lane pill is vertically centered inside .sim-pit-tray
    const pitProbe = mountHtml(`
      <div class="gate-unassigned-tray sim-pit-tray" id="test-pit-tray">
        <div class="gate-unassigned-list sim-pit-list">
          <div class="sim-pit-pill" id="test-pit-pill" style="--c:#38bdf8">
            <span class="sim-drone-dot"></span>
            <span class="sim-drone-callsign">FAERRY</span>
          </div>
        </div>
      </div>
    `);
    const trayRect = pitProbe.querySelector<HTMLElement>("#test-pit-tray")!.getBoundingClientRect();
    const pitPillRect = pitProbe.querySelector<HTMLElement>("#test-pit-pill")!.getBoundingClientRect();
    const trayCenterY = (trayRect.top + trayRect.bottom) * 0.5;
    const pillCenterY = (pitPillRect.top + pitPillRect.bottom) * 0.5;
    expect(Math.abs(trayCenterY - pillCenterY) < 0.5).toBe(true);

    // Verify mobile navigation swipe route order puts primary bottom-nav routes (races, practice, pilots, network) first
    setDatasourceUiMode("demo");
    const swipeRoutes = (
      AppShell.prototype as unknown as {
        getSwipeableMobileRoutes: (this: {
          store: { simulatorRunning: boolean; timingHardwareMode: string };
        }) => string[];
      }
    ).getSwipeableMobileRoutes.call({
      store: { simulatorRunning: true, timingHardwareMode: "slaprf" },
    });
    expect(swipeRoutes.slice(0, 4)).toEqual(["races", "practice", "pilots", "network"]);
    expect(swipeRoutes[swipeRoutes.indexOf("pilots") + 1]).toBe("network");
    expect(swipeRoutes.includes("sim")).toBe(true);
    expect(swipeRoutes.indexOf("sim") > swipeRoutes.indexOf("network")).toBe(true);
    expect(icons.power(14).startsWith("<svg")).toBe(true);

    // Verify .view.is-swipe-peek has exact same content width and left/right alignment as normal .view inside .outlet (no 28px width jump)
    if (window.innerWidth <= 900) {
      const swipeWidthProbe = mountHtml(`
        <main class="outlet is-swipe-stage" style="width: 390px;">
          <div class="view is-swipe-active" id="test-swipe-normal"><div style="display:flex;justify-content:space-between"><span>L</span><span id="test-norm-r">R</span></div></div>
          <div class="view is-swipe-peek" id="test-swipe-peek"><div style="display:flex;justify-content:space-between"><span>L</span><span id="test-peek-r">R</span></div></div>
        </main>
      `);
      const normRect = swipeWidthProbe.querySelector<HTMLElement>("#test-swipe-normal")!.getBoundingClientRect();
      const peekRect = swipeWidthProbe.querySelector<HTMLElement>("#test-swipe-peek")!.getBoundingClientRect();
      expect(Math.abs(normRect.width - peekRect.width) < 0.1).toBe(true);
      expect(Math.abs(normRect.left - peekRect.left) < 0.1).toBe(true);
      expect(Math.abs(normRect.right - peekRect.right) < 0.1).toBe(true);
    }
  });
});
