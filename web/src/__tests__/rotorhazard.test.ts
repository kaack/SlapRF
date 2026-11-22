import { Router } from "../core/router";
import { Sidebar } from "../layout/Sidebar";
import {
  encodeBasicAuth,
  isHttpsMixedContentTarget,
  splitEngineIOPayload,
} from "../services/rh_hardware_link";
import { enterThresholdAt, exitThresholdAt, rhThresholdAt } from "../state/selectors";
import { DebugView } from "../views/DebugView";
import { NetworkView } from "../views/NetworkView";
import { SimView } from "../views/SimView";
import { TimingDevicesCard } from "../widgets/DataSourceCard";
import { closeActiveLapEditorModal, openHeatLapEditorModal } from "../widgets/HeatLapEditorModal";
import { PilotSlotsEditor } from "../widgets/PilotSlotsEditor";
import { TrackEditor } from "../widgets/TrackEditor";
import {
  describe,
  expect,
  flushMicrotasks,
  it,
  makeDetectedTimer,
  makeGate,
  makeHeat,
  makeMockApiClient,
  makePilot,
  makeRaceState,
  makeSeat,
  makeStore,
  mountHtml,
} from "./harness";

describe("services/rh_hardware_link — Engine.IO v4 Payload Framing & Auth Helpers", () => {
  it("splits single and RS-delimited Engine.IO v4 HTTP-polling batches accurately", () => {
    expect(splitEngineIOPayload("")).toEqual([]);
    expect(splitEngineIOPayload("0{\"sid\":\"abc\"}")).toEqual(["0{\"sid\":\"abc\"}"]);
    expect(
      splitEngineIOPayload("40{\"sid\":\"sio1\"}\x1e42[\"version\",{\"major\":4}]\x1e2")
    ).toEqual(["40{\"sid\":\"sio1\"}", "42[\"version\",{\"major\":4}]", "2"]);
  });

  it("encodes RFC 7617 Basic Auth credentials and detects HTTPS mixed-content LAN targets", () => {
    expect(encodeBasicAuth("admin", "rotorhazard")).toBe(btoa("admin:rotorhazard"));
    expect(isHttpsMixedContentTarget("https:", "192.168.1.101")).toBe(true);
    expect(isHttpsMixedContentTarget("https:", "127.0.0.1")).toBe(false);
    expect(isHttpsMixedContentTarget("https:", "localhost")).toBe(false);
    expect(isHttpsMixedContentTarget("http:", "192.168.1.101")).toBe(false);
  });
});

describe("state/selectors — RotorHazard 0..255 Dual Threshold Resolution", () => {
  it("resolves pilot defaults (95/70), gate overrides, and enforces >= 4 hysteresis gap", () => {
    const store = makeStore({
      timingHardwareMode: "rotorhazard",
      pilots: [
        makePilot(1, { rhEnterThreshold: 110, rhExitThreshold: 80 }),
        makePilot(2, {}),
      ],
      gates: [
        makeGate(1, {
          assignedTimerId: 1,
          role: "START_FINISH",
          rhEnterThresholds: [140, 0],
          rhExitThresholds: [105, 0],
        }),
        makeGate(2, {
          assignedTimerId: 2,
          role: "SECTOR_GATE",
        }),
      ],
    });

    // Gate 1 overrides Pilot 1 to 140 / 105 (calibrated)
    const g1p1 = rhThresholdAt(store, 1, 1);
    expect(g1p1).toEqual({ enter: 140, exit: 105, enterCalibrated: true, exitCalibrated: true });
    expect(enterThresholdAt(store, 1, 1)).toEqual({ dbm: 140, calibrated: true });
    expect(exitThresholdAt(store, 1, 1)).toEqual({ dbm: 105, calibrated: true });

    // Gate 2 uses Pilot 1's own defaults (110 / 80, uncalibrated)
    expect(rhThresholdAt(store, 2, 1)).toEqual({
      enter: 110,
      exit: 80,
      enterCalibrated: false,
      exitCalibrated: false,
    });

    // Pilot 2 with unset fields falls back to RotorHazard defaults (95 / 70)
    expect(rhThresholdAt(store, 2, 2)).toEqual({
      enter: 95,
      exit: 70,
      enterCalibrated: false,
      exitCalibrated: false,
    });
  });
});

describe("widgets & views — RotorHazard UI & LapRF 8-Way Rename", () => {
  it("lists all 6 Timing Systems in exact order: SlapRF (USB), SlapRF (Bluetooth), LapRF 8-Way (Network), LapRF 8-Way (USB), RotorHazard (Network), RotorHazard (USB)", () => {
    const simStore = makeStore({
      simulatorRunning: true,
      timingHardwareMode: "slaprf",
    });
    const { api } = makeMockApiClient(simStore);
    const root = mountHtml(`<div id="td-host"></div>`);
    const card = new TimingDevicesCard(root.querySelector("#td-host")!, simStore, api);

    try {
      let sel = root.querySelector<HTMLSelectElement>("select[name='timing-hardware-mode']")!;
      expect(sel).not.toBeNull();
      const opts = Array.from(sel.querySelectorAll<HTMLOptionElement>("option"));
      expect(opts.map((o) => o.value)).toEqual([
        "slaprf",
        "slaprf_ble",
        "laprf",
        "laprf_usb",
        "rotorhazard",
        "rotorhazard_usb",
      ]);
      expect(opts.map((o) => o.textContent?.trim())).toEqual([
        "SlapRF (USB)",
        "SlapRF (Bluetooth)",
        "LapRF 8-Way (Network)",
        "LapRF 8-Way (USB)",
        "RotorHazard (Network)",
        "RotorHazard (USB)",
      ]);
      expect(opts[1].disabled).toBe(false);
      expect(opts[2].disabled).toBe(false);
      expect(opts[3].disabled).toBe(false);
      expect(opts[4].disabled).toBe(false);
      expect(opts[5].disabled).toBe(false);

      // When Simulation is OFF without a Go backend connected, external systems are gated cleanly
      const realStore = makeStore({
        simulatorRunning: false,
        timingHardwareMode: "slaprf",
      });
      const root2 = mountHtml(`<div id="td-host-real"></div>`);
      const card2 = new TimingDevicesCard(root2.querySelector("#td-host-real")!, realStore, api);
      try {
        sel = root2.querySelector<HTMLSelectElement>("select[name='timing-hardware-mode']")!;
        const bleOpt = sel.querySelector<HTMLOptionElement>("option[value='slaprf_ble']")!;
        const laprfOpt = sel.querySelector<HTMLOptionElement>("option[value='laprf']")!;
        const laprfUsbOpt = sel.querySelector<HTMLOptionElement>("option[value='laprf_usb']")!;
        const rhOpt = sel.querySelector<HTMLOptionElement>("option[value='rotorhazard']")!;
        const rhUsbOpt = sel.querySelector<HTMLOptionElement>("option[value='rotorhazard_usb']")!;
        expect(bleOpt.disabled).toBe(true);
        expect(laprfOpt.disabled).toBe(true);
        expect(laprfUsbOpt.disabled).toBe(true);
        expect(rhOpt.disabled).toBe(true);
        expect(rhUsbOpt.disabled).toBe(true);
      } finally {
        card2.destroy();
      }
    } finally {
      card.destroy();
    }
  });

  it("renders multi-device RotorHazard Simulator, NetworkView, TrackEditor, and PilotSlotsEditor", async () => {
    const store = makeStore({
      simulatorRunning: true,
      timingHardwareMode: "rotorhazard",
      pilots: [
        makePilot(1, { callsign: "Vanover", channel: 1, rhEnterThreshold: 95, rhExitThreshold: 70 }),
        makePilot(2, { callsign: "MinChan", channel: 3, rhEnterThreshold: 105, rhExitThreshold: 78 }),
      ],
      gates: [makeGate(1, { assignedTimerId: 1, role: "START_FINISH", trackOrder: 0 })],
      timers: [
        makeDetectedTimer(1, {
          timerLabel: "R1",
          firmwareVersion: "RotorHazard",
          endpointAddr: "192.168.1.101:5000",
          online: true,
        }),
      ],
      simState: {
        running: true,
        speedMultiplier: 5,
        pilots: [],
        rotorhazardUnits: [
          {
            timerId: 1,
            label: "R1",
            hostIp: "192.168.1.101",
            port: 5000,
            nodeCount: 8,
            adminUser: "admin",
            adminPass: "rotorhazard",
            poweredOn: true,
            connected: true,
            assignedGateId: 1,
            trackPosition: "#1 Start / Finish",
          },
          {
            timerId: 2,
            label: "R2",
            hostIp: "192.168.1.102",
            port: 5000,
            nodeCount: 8,
            adminUser: "admin",
            adminPass: "rotorhazard",
            poweredOn: true,
            connected: false,
            assignedGateId: 0,
            trackPosition: "Unassigned",
          },
        ],
      },
    });
    const { api, calls } = makeMockApiClient(store);
    const root = mountHtml(`
      <div id="sim-host"></div>
      <div id="net-host"></div>
      <div id="track-host"></div>
      <div id="pilots-host"></div>
    `);

    const simView = new SimView(root.querySelector("#sim-host")!, store, api);
    const netView = new NetworkView(root.querySelector("#net-host")!, store, api);
    const trackEd = new TrackEditor(root.querySelector("#track-host")!, store, api);
    const pilotsEd = new PilotSlotsEditor(root.querySelector("#pilots-host")!, store, api);

    try {
      expect(root.querySelector("#sim-host")!.textContent).toContain("Simulated RotorHazard devices");
      expect(root.querySelector("#sim-host")!.textContent).toContain("R1");
      expect(root.querySelector("#sim-host")!.textContent).toContain("R2");

      // Clicking Plug in on R2 in SimView dispatches simRotorHazardAction
      const rhConnectBtns = root.querySelectorAll<HTMLButtonElement>(
        "#sim-host button[data-action='rh-connect']"
      );
      expect(rhConnectBtns.length).toBe(2);
      expect(rhConnectBtns[0].textContent?.trim()).toBe("Unplug");
      expect(rhConnectBtns[1].textContent?.trim()).toBe("Plug in");
      rhConnectBtns[1].click();
      await flushMicrotasks();
      expect(calls.some((c) => c.method === "simRotorHazardAction")).toBe(true);

      // NetworkView renders RotorHazard connection controls & host 192.168.1.101
      expect(root.querySelector("#net-host")!.textContent).toContain("RotorHazard");
      expect(root.querySelector<HTMLInputElement>("#net-host [data-field='rh-host']")?.value).toBe(
        "192.168.1.101"
      );

      // TrackEditor renders 2-char R1 badge + RH sub-label
      expect(root.querySelector("#track-host")!.textContent).toContain("R1");
      expect(root.querySelector("#track-host")!.textContent).toContain("RH");

      // PilotSlotsEditor renders Pilot, Phonetic name, and Default channel columns (thresholds hidden)
      expect(root.querySelector("#pilots-host")!.textContent).toContain("Default channel");
      expect(root.querySelector("#pilots-host")!.textContent).not.toContain("Enter (10–250)");
    } finally {
      simView.destroy();
      netView.destroy();
      trackEd.destroy();
      pilotsEd.destroy();
    }
  });

  it("renders HeatLapEditorModal in RotorHazard mode with 0..255 Y-axis and dual Enter/Exit handles without dBm suffix", () => {
    const heat = makeHeat("W1-H1", {
      state: "review",
      hardwareMode: "rotorhazard",
      seats: [
        makeSeat(0, 1, {
          callsign: "Vanover",
          enterRssiDbm: 95,
          exitRssiDbm: 70,
          rssiTrace: [
            { t: 0, r: 24 },
            { t: 1000, r: 192 },
            { t: 2000, r: 28 },
          ],
          gateCrossings: [
            { crossingId: 1, offsetMs: 1000, peakDbm: 192, manual: false, invalidated: false },
          ],
        }),
      ],
    });
    const store = makeStore({
      timingHardwareMode: "rotorhazard",
      pilots: [makePilot(1, { callsign: "Vanover", rhEnterThreshold: 95, rhExitThreshold: 70 })],
      gates: [makeGate(1, { assignedTimerId: 1, role: "START_FINISH" })],
      raceState: makeRaceState({
        mode: "race",
        lifecycle: "active",
        activeHeatId: "W1-H1",
        heats: [heat],
      }),
    });
    const { api } = makeMockApiClient(store);

    try {
      openHeatLapEditorModal(store, api, "W1-H1", 1);
      const modal = document.querySelector(".lap-editor-modal")!;
      expect(modal).not.toBeNull();
      expect(modal.textContent).toContain("Enter 95");
      expect(modal.textContent).toContain("Exit 70");
      expect(modal.textContent).toContain("95 / 70");
      expect(modal.textContent).not.toContain("95 dBm");
      expect(modal.querySelector("[data-thresh-handle='enter']")).not.toBeNull();
      expect(modal.querySelector("[data-thresh-handle='exit']")).not.toBeNull();
    } finally {
      closeActiveLapEditorModal();
    }
  });

  it("renders pilot-agnostic hardware nodes and inline per-device credentials in NetworkView", async () => {
    const store = makeStore({
      simulatorRunning: true,
      timingHardwareMode: "rotorhazard",
      pilots: [
        makePilot(1, { callsign: "Vanover", channel: 1, rhEnterThreshold: 95, rhExitThreshold: 70 }),
        makePilot(2, { callsign: "MinChan", channel: 2, rhEnterThreshold: 105, rhExitThreshold: 78 }),
      ],
      gates: [makeGate(1, { assignedTimerId: 1, role: "START_FINISH", trackOrder: 0 })],
      timers: [
        makeDetectedTimer(1, {
          timerLabel: "R1",
          firmwareVersion: "RotorHazard",
          endpointAddr: "192.168.1.101:5000",
          online: true,
        }),
      ],
      simState: {
        running: true,
        speedMultiplier: 5,
        pilots: [],
        rotorhazardUnits: [
          {
            timerId: 1,
            label: "R1",
            host: "192.168.1.101",
            port: 5000,
            nodeCount: 8,
            adminUser: "admin",
            adminPass: "rotorhazard",
            poweredOn: true,
            connected: true,
            authOk: true,
            gateArmed: true,
            serverVersion: "4.1.2-sim",
            nodeFreqsMhz: [5658, 5695, 5732, 5769, 5806, 5843, 5880, 0],
            nodeEnterLevels: [95, 105, 90, 90, 90, 90, 90, 90],
            nodeExitLevels: [70, 78, 70, 70, 70, 70, 70, 70],
            slotRssi: [22, 148, 19, 18, 21, 20, 18, 0],
            crossingFlag: [false, true, false, false, false, false, false, false],
            assignedGateId: 1,
            trackPosition: "#1 Start / Finish",
          },
          {
            timerId: 2,
            label: "R2",
            host: "192.168.1.102",
            port: 5000,
            nodeCount: 8,
            adminUser: "admin",
            adminPass: "rotorhazard",
            poweredOn: true,
            connected: false,
            authOk: false,
            gateArmed: false,
            slotRssi: [0, 0, 0, 0, 0, 0, 0, 0],
            crossingFlag: [false, false, false, false, false, false, false, false],
            assignedGateId: 0,
            trackPosition: "Unassigned",
          },
        ],
      },
    });
    const { api } = makeMockApiClient(store);
    const root = mountHtml(`<div id="net-rh-host"></div>`);
    const netView = new NetworkView(root.querySelector("#net-rh-host")!, store, api);
    try {
      const txt = root.textContent ?? "";
      // Pilot callsigns must NOT appear on hardware node rows
      expect(txt).not.toContain("Vanover");
      expect(txt).not.toContain("MinChan");
      // Hardware frequencies, Enter/Exit, RSSI, and CROSSING appear cleanly
      expect(txt).toContain("Connection");
      expect(txt).toContain("Discover");
      expect(txt).toContain("RotorHazard devices");
      expect(txt).not.toContain("Connected RotorHazard devices");
      expect(txt).toContain("Node 1");
      expect(txt).toContain("5658 MHz");
      expect(txt).toContain("Disabled");
      expect(txt).toContain("CROSSING");
      // Disabled Node 8 must NOT repeat "Disabled" in the right-hand value column
      const disabledValEl = root.querySelector<HTMLElement>("[data-rh-bar-val='7']")!;
      expect(disabledValEl).not.toBeNull();
      expect(disabledValEl.textContent).toBe("");
      // No global Admin User / Admin Password fields in the top bar before opening a prompt
      expect(root.querySelector("[data-rh-creds-prompt='1']")).toBeNull();
      // Clicking Connect… opens the inline per-device credentials prompt
      const openPromptBtn = root.querySelector<HTMLButtonElement>("[data-action='rh-open-manual-creds']")!;
      expect(openPromptBtn).not.toBeNull();
      openPromptBtn.click();
      await flushMicrotasks();
      const promptEl = root.querySelector("[data-rh-creds-prompt='1']")!;
      expect(promptEl).not.toBeNull();
      expect(promptEl.textContent).toContain("Admin Username");
      expect(promptEl.textContent).toContain("Admin Password");
      const submitBtn = promptEl.querySelector<HTMLButtonElement>("[data-action='rh-cred-submit']")!;
      expect(submitBtn.classList.contains("btn-armed")).toBe(true);
      expect(submitBtn.classList.contains("btn-primary")).toBe(false);
    } finally {
      netView.destroy();
    }
  });

  it("renders DebugView in RotorHazard mode with 5 working sections, 3 hidden SlapRF-only sections, and zero USB wording", async () => {
    const store = makeStore({
      simulatorRunning: true,
      timingHardwareMode: "rotorhazard",
      simState: {
        running: true,
        speedMultiplier: 5,
        pilots: [],
        rotorhazardUnits: [
          {
            timerId: 1,
            label: "R1",
            host: "192.168.1.101",
            port: 5000,
            nodeCount: 8,
            adminUser: "admin",
            adminPass: "rotorhazard",
            poweredOn: true,
            connected: true,
            authOk: true,
            gateArmed: true,
            clockDeltaMs: 0.4,
            serverVersion: "4.1.2-sim",
            heartbeatsRx: 42,
            passesRx: 3,
            cpuTempC: 48.2,
            envSummary: "Pi CPU 48.2 °C · INA219 5.11 V",
            nodeFreqsMhz: [5658, 5695, 5732, 5769, 0, 0, 0, 0],
            nodeEnterLevels: [95, 95, 95, 95, 95, 95, 95, 95],
            nodeExitLevels: [70, 70, 70, 70, 70, 70, 70, 70],
            slotRssi: [22, 140, 19, 18, 0, 0, 0, 0],
            crossingFlag: [false, true, false, false, false, false, false, false],
            assignedGateId: 1,
            trackPosition: "#1 Start / Finish",
          },
        ],
      },
    });
    const { api, calls } = makeMockApiClient(store);
    const root = mountHtml(`<div id="dbg-rh-host"></div>`);
    const dbg = new DebugView(root.querySelector("#dbg-rh-host")!, api, store);
    try {
      const spectrumSec = root.querySelector<HTMLElement>("[data-section-anchor='spectrum-scan']")!;
      const consoleSec = root.querySelector<HTMLElement>("[data-section-anchor='serial-console']")!;
      const logSec = root.querySelector<HTMLElement>("[data-section-anchor='live-log']")!;
      expect(spectrumSec.hidden).toBe(true);
      expect(consoleSec.hidden).toBe(true);
      expect(logSec.hidden).toBe(true);

      const connSlot = root.querySelector<HTMLElement>("[data-slot='connection']")!;
      expect(connSlot.textContent).not.toContain("Connect USB");
      expect(connSlot.textContent).not.toContain("Debug another USB");
      expect(connSlot.textContent).toContain("R1");
      expect(connSlot.textContent).toContain("192.168.1.101:5000");
      expect(connSlot.textContent).toContain("Manage timers");

      const statusSlot = root.querySelector<HTMLElement>("[data-slot='status']")!;
      expect(statusSlot.textContent).toContain("4.1.2-sim");
      expect(statusSlot.textContent).toContain("Pi CPU 48.2 °C");

      const liveSlot = root.querySelector<HTMLElement>("[data-slot='live']")!;
      expect(liveSlot.textContent).toContain("Node RSSI meter");
      expect(liveSlot.textContent).toContain("255 RSSI");
      expect(liveSlot.textContent).not.toContain("Disabled");

      // Disabled node N5 (index 4, 0 MHz) has unlit ring LED, empty freq, and "— / 255" value
      const disabledRow = liveSlot.querySelector<HTMLElement>("[data-bar][data-ch='4']")!;
      expect(disabledRow.querySelector("[data-bar-freq]")?.textContent).toBe("");
      expect(disabledRow.querySelector(".debug-bar-value")?.textContent).toBe("— / 255");
      expect(disabledRow.querySelector<HTMLElement>("[data-bar-dot]")?.style.background).toContain("transparent");

      // Clicking Stream activates setRHDebugStream(1, true) and renders neutral (non-neon) CROSSING text
      const streamBtn = root.querySelector<HTMLButtonElement>("[data-action='live']")!;
      expect(streamBtn.textContent).toContain("Stream");
      streamBtn.click();
      await flushMicrotasks();
      expect(calls.some((c) => c.method === "setRHDebugStream" && c.args[0] === 1 && c.args[1] === true)).toBe(true);
      expect(liveSlot.textContent).toContain("CROSSING");
      const crossingHitsEl = liveSlot.querySelector<HTMLElement>("[data-bar][data-ch='1'] .debug-bar-hits")!;
      expect(crossingHitsEl.classList.contains("is-active")).toBe(false);

      const noiseSlot = root.querySelector<HTMLElement>("[data-slot='noise-table']")!;
      expect(noiseSlot.textContent).not.toContain("Disabled");

      // Run RotorHazard self-test
      const selfTestBtn = root.querySelector<HTMLButtonElement>("[data-action='selftest']")!;
      expect(selfTestBtn.disabled).toBe(false);
      selfTestBtn.click();
      await flushMicrotasks();
      const selfTestSlot = root.querySelector<HTMLElement>("[data-slot='selftest']")!;
      expect(selfTestSlot.textContent).toContain("Socket.IO link");
      expect(selfTestSlot.textContent).toContain("HTTP Basic Auth");
      expect(selfTestSlot.textContent).toContain("Node RF tuning");
    } finally {
      dbg.destroy();
    }
  });

  it("renders clean SlapRF logo without Demo subtext while keeping sidebar footer disclaimer in pure browser Demo mode", () => {
    const store = makeStore({});
    const router = new Router();
    const root = mountHtml(`<nav id="sb-host"></nav>`);
    const sb = new Sidebar(root.querySelector("#sb-host")!, store, router);
    try {
      const demoSub = root.querySelector<HTMLElement>("[data-brand-demo-sub]");
      const brandRoot = root.querySelector<HTMLElement>("[data-brand-root]")!;
      const brandMark = root.querySelector<HTMLElement>(".brand-mark")!;
      const brandName = root.querySelector<HTMLElement>(".brand-name")!;
      const disclaimer = root.querySelector<HTMLElement>("[data-demo-disclaimer='1']")!;
      expect(demoSub).toBeNull();
      expect(brandRoot.classList.contains("is-demo")).toBe(false);
      expect(brandMark).not.toBeNull();
      expect(brandName.textContent).toBe("SlapRF");
      expect(disclaimer).not.toBeNull();
      expect(disclaimer.textContent).toContain("Browser Demo");
    } finally {
      sb.destroy();
    }
  });

  it("renders RotorHazard (USB) across Sidebar, SimView, NetworkView, PilotSlotsEditor, and DebugView without LAN IP or Admin login fields", async () => {
    const store = makeStore({
      simulatorRunning: true,
      timingHardwareMode: "rotorhazard_usb",
      pilots: [
        makePilot(1, { callsign: "Vanover", channel: 1, rhEnterThreshold: 98, rhExitThreshold: 72 }),
      ],
      gates: [makeGate(1, { assignedTimerId: 2, role: "START_FINISH", trackOrder: 0 })],
      timers: [
        makeDetectedTimer(2, {
          timerLabel: "R1",
          firmwareVersion: "RotorHazard",
          endpointAddr: "SIM-RH-USB1",
          online: true,
        }),
      ],
      simState: {
        running: true,
        speedMultiplier: 5,
        pilots: [],
        rotorhazardUnits: [
          {
            timerId: 2,
            label: "R1",
            transport: "usb",
            portName: "SIM-RH-USB1",
            baudRate: 115200,
            apiLevel: 36,
            host: "",
            port: 0,
            nodeCount: 8,
            poweredOn: true,
            connected: true,
            online: true,
            authOk: true,
            gateArmed: true,
            clockDeltaMs: 0.3,
            serverVersion: "FPVGateC5 1.2 (API 36)",
            heartbeatsRx: 55,
            passesRx: 4,
            nodeFreqsMhz: [5658, 5695, 5732, 5769, 0, 0, 0, 0],
            nodeEnterLevels: [98, 95, 95, 95, 95, 95, 95, 95],
            nodeExitLevels: [72, 70, 70, 70, 70, 70, 70, 70],
            slotRssi: [24, 152, 21, 19, 0, 0, 0, 0],
            crossingFlag: [false, true, false, false, false, false, false, false],
            assignedGateId: 1,
            assignedGateName: "Start / Finish",
          },
          {
            timerId: 3,
            label: "R2",
            transport: "usb",
            portName: "SIM-RH-USB2",
            baudRate: 115200,
            apiLevel: 36,
            host: "",
            port: 0,
            nodeCount: 8,
            poweredOn: true,
            connected: false,
            online: false,
            authOk: true,
            gateArmed: false,
            slotRssi: [0, 0, 0, 0, 0, 0, 0, 0],
            crossingFlag: [false, false, false, false, false, false, false, false],
            assignedGateId: 0,
          },
        ],
      },
    });
    const { api, calls } = makeMockApiClient(store);
    const router = new Router();
    const root = mountHtml(`
      <nav id="sb-usb"></nav>
      <div id="sim-usb"></div>
      <div id="net-usb"></div>
      <div id="pilots-usb"></div>
      <div id="dbg-usb"></div>
    `);

    const sb = new Sidebar(root.querySelector("#sb-usb")!, store, router);
    const simView = new SimView(root.querySelector("#sim-usb")!, store, api);
    const netView = new NetworkView(root.querySelector("#net-usb")!, store, api);
    const pilotsEd = new PilotSlotsEditor(root.querySelector("#pilots-usb")!, store, api);
    const dbg = new DebugView(root.querySelector("#dbg-usb")!, api, store);

    try {
      // 0..255 threshold selectors work identically for rotorhazard_usb
      expect(enterThresholdAt(store, 1, 1)).toEqual({ dbm: 98, calibrated: false });
      expect(exitThresholdAt(store, 1, 1)).toEqual({ dbm: 72, calibrated: false });

      // Sidebar hides #/flasher in RotorHazard (USB) mode
      expect(root.querySelector<HTMLElement>("#sb-usb [data-route='flasher']")?.style.display).toBe(
        "none"
      );

      // SimView renders Simulated RotorHazard USB devices without IP :5000 or Admin password
      const simTxt = root.querySelector("#sim-usb")!.textContent ?? "";
      expect(simTxt).toContain("Simulated RotorHazard USB devices");
      expect(simTxt).toContain("SIM-RH-USB1");
      expect(simTxt).toContain("SIM-RH-USB2");
      expect(simTxt).toContain("API 36 · 115200");
      expect(root.querySelector("#sim-usb [data-field='rh-host']")).toBeNull();
      expect(root.querySelector("#sim-usb [data-field='rh-pass']")).toBeNull();

      // NetworkView renders USB serial port picker (defaulting to SIM-RH-USB1) and live 0..255 Node bars matching RotorHazard Network
      const netEl = root.querySelector("#net-usb")!;
      expect(netEl.textContent ?? "").toContain("USB Serial Port");
      const usbVisTxt = netEl.querySelector("[data-slot='rh-usb-sections']")!.textContent ?? "";
      expect(usbVisTxt).toContain("RotorHazard USB devices");
      expect(usbVisTxt).toContain("SIM-RH-USB1");
      expect(usbVisTxt).toContain("Node 1");
      expect(usbVisTxt).toContain("8 nodes");
      expect(usbVisTxt).toContain("8-node receiver RSSI (0-255 scale)");
      expect(usbVisTxt).not.toContain("Seat 1");
      expect(usbVisTxt).toContain("CROSSING");
      expect(usbVisTxt).not.toContain("Scan LAN");
      expect(usbVisTxt).not.toContain("Admin Password");

      const portSel = netEl.querySelector<HTMLSelectElement>("[data-field='rh-usb-port']")!;
      expect(portSel).not.toBeNull();
      expect(portSel.value).toBe("SIM-RH-USB1");

      // When the selected USB port is already connected, the USB serial connection box renders an active Disconnect button
      // and the device card below does not duplicate the Disconnect button.
      const connHostEl = netEl.querySelector<HTMLElement>("[data-slot='rh-usb-connection']")!;
      const disconnectUsbBtn = connHostEl.querySelector<HTMLButtonElement>("[data-action='rh-disconnect']")!;
      expect(disconnectUsbBtn).not.toBeNull();
      expect(disconnectUsbBtn.disabled).toBe(false);
      expect(disconnectUsbBtn.textContent ?? "").toContain("Disconnect");
      expect(connHostEl.querySelector("[data-action='rh-usb-connect']")).toBeNull();

      const usbDeviceCard = netEl.querySelector<HTMLElement>("[data-rh-usb-card]")!;
      expect(usbDeviceCard).not.toBeNull();
      expect(usbDeviceCard.querySelector("[data-action='rh-disconnect']")).toBeNull();

      // Switching the dropdown to an unconnected USB port turns the button back into Connect USB
      portSel.value = "SIM-RH-USB2";
      portSel.dispatchEvent(new Event("change", { bubbles: true }));
      await flushMicrotasks();

      const connectUsbBtn = connHostEl.querySelector<HTMLButtonElement>("[data-action='rh-usb-connect']")!;
      expect(connectUsbBtn).not.toBeNull();
      expect(connectUsbBtn.disabled).toBe(false);
      connectUsbBtn.click();
      await flushMicrotasks();
      expect(
        calls.some(
          (c) =>
            c.method === "simRotorHazardAction" &&
            (c.args[0] as { action?: string; portName?: string })?.action === "connect-port" &&
            (c.args[0] as { action?: string; portName?: string })?.portName === "SIM-RH-USB2"
        )
      ).toBe(true);

      // PilotSlotsEditor renders Pilot, Phonetic name, and Default channel columns (thresholds hidden)
      const pilotsTxt = root.querySelector("#pilots-usb")!.textContent ?? "";
      expect(pilotsTxt).toContain("Default channel");
      expect(pilotsTxt).not.toContain("Enter (10–250)");

      // DebugView enables Spectrum scan & waterfall on 0-255 RSSI scale for RotorHazard (USB)
      const specSection = root.querySelector<HTMLElement>(
        "#dbg-usb [data-section-anchor='spectrum-scan']"
      )!;
      expect(specSection.hidden).toBe(false);
      expect(specSection.textContent).toContain("Spectrum scan (0-255 RSSI × frequency)");
      expect(specSection.textContent).toContain("Waterfall spectrogram (frequency × time)");
      expect(specSection.textContent).toContain("12 RSSI");
      expect(specSection.textContent).toContain("185 RSSI");

      const scanOnceBtn = root.querySelector<HTMLButtonElement>("#dbg-usb [data-action='scan']")!;
      expect(scanOnceBtn.disabled).toBe(false);
      scanOnceBtn.click();
      await flushMicrotasks();
      expect(
        calls.some(
          (c) =>
            c.method === "runRHUSBScan" &&
            (c.args[0] as { mode?: string; stop?: number })?.mode === "once" &&
            (c.args[0] as { mode?: string; stop?: number })?.stop === 5945
        )
      ).toBe(true);
      expect(specSection.textContent).toContain("196 RSSI");

      // DebugView runs USB serial self-test cleanly without Socket.IO / HTTP Basic Auth and uses Node wording
      const selfTestBtn = root.querySelector<HTMLButtonElement>("#dbg-usb [data-action='selftest']")!;
      expect(selfTestBtn.disabled).toBe(false);
      selfTestBtn.click();
      await flushMicrotasks();
      const selfTestTxt = root.querySelector("#dbg-usb [data-slot='selftest']")!.textContent ?? "";
      expect(selfTestTxt).toContain("USB serial link");
      expect(selfTestTxt).toContain("Protocol & nodes");
      expect(selfTestTxt).not.toContain("HTTP Basic Auth");
    } finally {
      sb.destroy();
      simView.destroy();
      netView.destroy();
      pilotsEd.destroy();
      dbg.destroy();
    }
  });
});
