import { pushAppHash, Router } from "../core/router";
import { AppShell } from "../layout/AppShell";
import { Sidebar } from "../layout/Sidebar";
import { Announcer } from "../services/announcer";
import {
  bindSimSerialStore,
  listSimulatedTimers,
  SimulatedSerialPort,
} from "../services/sim_serial_port";
import { AboutView } from "../views/AboutView";
import { DebugView } from "../views/DebugView";
import { FlasherView } from "../views/FlasherView";
import { LapRFEmulatorView } from "../views/LapRFEmulatorView";
import { NetworkView } from "../views/NetworkView";
import { SetupView } from "../views/SetupView";
import { SimView } from "../views/SimView";
import { PilotSlotsEditor } from "../widgets/PilotSlotsEditor";
import { TrackEditor } from "../widgets/TrackEditor";
import {
  describe,
  expect,
  flushMicrotasks,
  it,
  makeDetectedTimer,
  makeFullState,
  makeGate,
  makeHeat,
  makeMockApiClient,
  makePilot,
  makeRaceState,
  makeStore,
  mountHtml,
} from "./harness";

describe("widgets/PilotSlotsEditor & TrackEditor — Global Pilots & Course Line", () => {
  it("filters pilots, blocks duplicate callsigns, locks RF channels during live heats, and clamps SlapRF/LapRF bounds", async () => {
    const store = makeStore({
      pilots: [
        makePilot(1, { callsign: "Vanover", phoneticName: "Alex", channel: 1 }),
        makePilot(2, { callsign: "Headsup", channel: 3 }),
        makePilot(3, { callsign: "MinChan", channel: 5 }),
      ],
    });
    const { api, calls } = makeMockApiClient(store);
    const root = mountHtml(`<div id="pilots-host"></div>`);
    const editor = new PilotSlotsEditor(root.querySelector("#pilots-host")!, store, api);

    try {
      expect(root.querySelectorAll("form[data-pilot]")).toHaveLength(3);

      // Typing existing pilot name ("vanover" case-insensitively) disables Add button (duplicate protection!)
      const searchInput = root.querySelector<HTMLInputElement>("[data-pilot-dir-search]")!;
      searchInput.value = "vanover";
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      const addBtn = root.querySelector<HTMLButtonElement>("[data-action='add-pilot']")!;
      expect(addBtn.disabled).toBe(true);
      expect(root.querySelectorAll("form[data-pilot]")).toHaveLength(1);

      // Typing unique callsign enables Add and invokes api.addPilot
      searchInput.value = "EvanTurner";
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      expect(root.querySelector<HTMLButtonElement>("[data-action='add-pilot']")!.disabled).toBe(false);
      root.querySelector<HTMLButtonElement>("[data-action='add-pilot']")!.click();
      await flushMicrotasks();
      expect(calls.find((c) => c.method === "addPilot")?.args).toEqual(["EvanTurner"]);

      // Editing Pilot 2's callsign to duplicate Pilot 1 ("Vanover") reverts input and shows warning toast without calling updatePilotSlot!
      const form2 = root.querySelector<HTMLFormElement>("form[data-pilot='2']")!;
      const callInput2 = form2.querySelector<HTMLInputElement>("input[name='callsign']")!;
      callInput2.value = "Vanover";
      callInput2.dispatchEvent(new Event("change", { bubbles: true }));
      await flushMicrotasks();
      expect(calls.some((c) => c.method === "updatePilotSlot")).toBe(false);
      expect(callInput2.value).toBe("Headsup");

      // Changing Pilot 2 channel to R8 -> updates frequencyMhz to 5917 MHz!
      const chSelect2 = form2.querySelector<HTMLSelectElement>("select[name='channel']")!;
      const groupLabels = Array.from(chSelect2.querySelectorAll("optgroup")).map((g) => g.label);
      expect(groupLabels).toEqual([
        "Raceband",
        "Fatshark / IRC",
        "Boscam A",
        "Boscam B",
        "Boscam E",
        "IMD6",
      ]);

      chSelect2.value = "8";
      chSelect2.dispatchEvent(new Event("change", { bubbles: true }));
      await flushMicrotasks();
      const updateCall = calls.find((c) => c.method === "updatePilotSlot");
      expect(updateCall).toBeDefined();
      expect((updateCall!.args[0] as { band: number; channel: number; frequencyMhz: number }).band).toBe(1);
      expect((updateCall!.args[0] as { channel: number; frequencyMhz: number }).channel).toBe(8);
      expect((updateCall!.args[0] as { frequencyMhz: number }).frequencyMhz).toBe(5917);

      // Selecting non-Raceband Fatshark F4 (encoded value "24") -> sends band: 2, channel: 4, frequencyMhz: 5800!
      calls.length = 0;
      chSelect2.value = "24";
      chSelect2.dispatchEvent(new Event("change", { bubbles: true }));
      await flushMicrotasks();
      const f4Call = calls.find((c) => c.method === "updatePilotSlot");
      expect(f4Call).toBeDefined();
      const f4Payload = f4Call!.args[0] as { band: number; channel: number; frequencyMhz: number };
      expect(f4Payload.band).toBe(2);
      expect(f4Payload.channel).toBe(4);
      expect(f4Payload.frequencyMhz).toBe(5800);

      // Selecting Boscam A1 (encoded value "41") -> sends band: 4, channel: 1, frequencyMhz: 5865!
      calls.length = 0;
      chSelect2.value = "41";
      chSelect2.dispatchEvent(new Event("change", { bubbles: true }));
      await flushMicrotasks();
      const a1Call = calls.find((c) => c.method === "updatePilotSlot");
      expect(a1Call).toBeDefined();
      const a1Payload = a1Call!.args[0] as { band: number; channel: number; frequencyMhz: number };
      expect(a1Payload.band).toBe(4);
      expect(a1Payload.channel).toBe(1);
      expect(a1Payload.frequencyMhz).toBe(5865);

      // Even when a race heat is actively running, global pilot directory default channels remain editable
      const liveRace = makeRaceState({
        mode: "race",
        lifecycle: "active",
        activeHeatId: "W1-H1",
        heats: [makeHeat("W1-H1", { state: "running" })],
      });
      store.ingestRace(liveRace);
      expect(root.querySelector("select[name='channel']")).not.toBeNull();
    } finally {
      editor.destroy();
    }
  });

  it("manages Recent pilot/search filter pills on add, Enter search, row edit, unselect, rename, and route remount", async () => {
    const initialPilots = Array.from({ length: 12 }, (_, idx) =>
      makePilot(idx + 1, {
        callsign: idx === 0 ? "Vanover" : idx === 1 ? "Headsup" : `Racer${idx + 1}`,
        channel: (idx % 8) + 1,
      })
    );
    const store = makeStore({ pilots: initialPilots });
    const { api } = makeMockApiClient(store);
    // Simulate real backend hydration on addPilot & updatePilotSlot
    api.addPilot = async (callsign = "") => {
      const nextSlot = store.pilots.length + 1;
      store.hydrate({
        serverTimestampUs: 30_000_000,
        timingHardwareMode: store.timingHardwareMode,
        pilots: [...store.pilots, makePilot(nextSlot, { callsign, channel: 0 })],
        gates: store.nodes,
        timers: store.timers,
        laps: [],
        crossings: [],
        filtered: [],
        summaries: [],
        rules: store.rules,
        simulatorRunning: false,
        raceArmed: false,
        laprfEmulatorStatus: store.laprfEmulator,
        raceState: store.raceState,
      });
    };
    api.updatePilotSlot = async (updated) => {
      store.hydrate({
        serverTimestampUs: 31_000_000,
        timingHardwareMode: store.timingHardwareMode,
        pilots: store.pilots.map((p) => (p.slotIndex === updated.slotIndex ? updated : p)),
        gates: store.nodes,
        timers: store.timers,
        laps: [],
        crossings: [],
        filtered: [],
        summaries: [],
        rules: store.rules,
        simulatorRunning: false,
        raceArmed: false,
        laprfEmulatorStatus: store.laprfEmulator,
        raceState: store.raceState,
      });
    };

    const root = mountHtml(`<div id="pilots-recent-host"></div>`);
    let editor = new PilotSlotsEditor(root.querySelector("#pilots-recent-host")!, store, api);

    try {
      // Initially Page 1 shows 10 of 12 pilots and no Recent bar
      expect(root.querySelectorAll("form[data-pilot]")).toHaveLength(10);
      expect(root.querySelector(".pilot-dir-recent-bar")).toBeNull();

      // 1. Add a new pilot ("Mavrick") via Enter -> input clears, Recent pill created & auto-selected, showing ONLY Mavrick!
      const searchInput = root.querySelector<HTMLInputElement>("[data-pilot-dir-search]")!;
      searchInput.value = "Mavrick";
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await flushMicrotasks();

      expect(searchInput.value).toBe("");
      expect(root.querySelectorAll("form[data-pilot]")).toHaveLength(1);
      expect(root.querySelector<HTMLFormElement>("form[data-pilot='13']")).not.toBeNull();
      const activePill = root.querySelector<HTMLElement>(".pilot-dir-recent-pill.is-active")!;
      expect(activePill).not.toBeNull();
      expect(activePill.textContent).toContain("Mavrick");

      // 2. Rename typo "Mavrick" -> "Maverick" while pill is active -> row stays visible and pill updates to "Maverick"!
      const callInput13 = root.querySelector<HTMLInputElement>(
        "form[data-pilot='13'] input[name='callsign']"
      )!;
      callInput13.value = "Maverick";
      callInput13.dispatchEvent(new Event("change", { bubbles: true }));
      await flushMicrotasks();
      expect(root.querySelectorAll("form[data-pilot]")).toHaveLength(1);
      expect(root.querySelector(".pilot-dir-recent-pill.is-active")?.textContent).toContain(
        "Maverick"
      );

      // 3. Search existing pilot "van" and edit row -> commits "Vanover" to Recent pills & clears search input
      searchInput.value = "van";
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      expect(root.querySelector(".pilot-dir-recent-pill.is-active")).toBeNull();
      const chSelect1 = root.querySelector<HTMLSelectElement>(
        "form[data-pilot='1'] select[name='channel']"
      )!;
      chSelect1.value = "6";
      chSelect1.dispatchEvent(new Event("change", { bubbles: true }));
      await flushMicrotasks();
      expect(searchInput.value).toBe("");
      expect(root.querySelectorAll(".pilot-dir-recent-pill")).toHaveLength(2);
      expect(root.querySelector(".pilot-dir-recent-pill.is-active")?.textContent).toContain(
        "Vanover"
      );

      // 4. Remounting PilotSlotsEditor (navigating away & back) preserves active Recent pill
      editor.destroy();
      editor = new PilotSlotsEditor(root.querySelector("#pilots-recent-host")!, store, api);
      expect(root.querySelectorAll("form[data-pilot]")).toHaveLength(1);
      expect(root.querySelector(".pilot-dir-recent-pill.is-active")?.textContent).toContain(
        "Vanover"
      );

      // 5. Clicking active pill unselects it -> returns to unfiltered Page 1 (10 rows)
      root
        .querySelector<HTMLButtonElement>(".pilot-dir-recent-pill.is-active [data-recent-select]")!
        .click();
      expect(root.querySelector(".pilot-dir-recent-pill.is-active")).toBeNull();
      expect(root.querySelectorAll("form[data-pilot]")).toHaveLength(10);

      // 6. Clear removes all Recent pills
      root.querySelector<HTMLButtonElement>("[data-action='clear-recent-pilots']")!.click();
      expect(root.querySelector(".pilot-dir-recent-bar")).toBeNull();

      // 7. On mobile (<= 768px), opening the pilot drawer and editing fields preserves the exact
      // .pilot-dir-mobile-drawer-overlay and .pilot-dir-mobile-drawer-backdrop DOM elements in place
      // without ever destroying or recreating the blurred backdrop
      const origW = window.innerWidth;
      Object.defineProperty(window, "innerWidth", { value: 390, configurable: true, writable: true });
      try {
        const pill1 = root.querySelector<HTMLButtonElement>('[data-mobile-pilot-select="1"]')!;
        expect(pill1).not.toBeNull();
        pill1.click();

        const overlayBefore = root.querySelector<HTMLElement>(".pilot-dir-mobile-drawer-overlay")!;
        const backdropBefore = root.querySelector<HTMLElement>(".pilot-dir-mobile-drawer-backdrop")!;
        expect(overlayBefore).not.toBeNull();
        expect(backdropBefore).not.toBeNull();

        const drawerPhonetic = overlayBefore.querySelector<HTMLInputElement>('input[name="phoneticName"]')!;
        drawerPhonetic.value = "Alex V";
        drawerPhonetic.dispatchEvent(new Event("change", { bubbles: true }));
        await flushMicrotasks();

        const overlayAfter = root.querySelector<HTMLElement>(".pilot-dir-mobile-drawer-overlay")!;
        const backdropAfter = root.querySelector<HTMLElement>(".pilot-dir-mobile-drawer-backdrop")!;
        expect(overlayAfter).toBe(overlayBefore);
        expect(backdropAfter).toBe(backdropBefore);
      } finally {
        Object.defineProperty(window, "innerWidth", { value: origW, configurable: true, writable: true });
      }
    } finally {
      editor.destroy();
    }
  });

  it("supports >128 pilots with no max cap badge and exposes Download/Upload CSV roster actions", async () => {
    const pilots132 = Array.from({ length: 132 }, (_, idx) =>
      makePilot(idx + 1, { callsign: `Racer${idx + 1}`, channel: 0 })
    );
    const store = makeStore({ pilots: pilots132 });
    const { api, calls } = makeMockApiClient(store);
    const root = mountHtml(`<div id="pilots-csv-host"></div>`);
    const editor = new PilotSlotsEditor(root.querySelector("#pilots-csv-host")!, store, api);

    try {
      // No "132 / 128" max badge anywhere
      expect(root.querySelector("[data-pilot-dir-count]")).toBeNull();
      expect(root.textContent).not.toContain("/ 128");

      // Can still add pilot #133 cleanly
      const searchInput = root.querySelector<HTMLInputElement>("[data-pilot-dir-search]")!;
      searchInput.value = "Racer133";
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      const addBtn = root.querySelector<HTMLButtonElement>("[data-action='add-pilot']")!;
      expect(addBtn.disabled).toBe(false);
      addBtn.click();
      await flushMicrotasks();
      expect(calls.some((c) => c.method === "addPilot" && c.args[0] === "Racer133")).toBe(true);

      // Top-right Download & Upload CSV icon buttons
      const downloadBtn = root.querySelector<HTMLButtonElement>("[data-action='download-pilots-csv']")!;
      const uploadBtn = root.querySelector<HTMLButtonElement>("[data-action='upload-pilots-csv']")!;
      expect(downloadBtn).not.toBeNull();
      expect(uploadBtn).not.toBeNull();

      downloadBtn.click();
      await flushMicrotasks();
      expect(calls.some((c) => c.method === "downloadPilotsRosterCsv")).toBe(true);
    } finally {
      editor.destroy();
    }
  });

  it("renders TrackEditor course line + unassigned timer tray, promotes start timer, and deletes offline timers", async () => {
    const store = makeStore({
      gates: [
        makeGate(1, { assignedTimerId: 1, role: "START_FINISH", trackOrder: 0 }),
        makeGate(2, { assignedTimerId: 2, role: "SECTOR_GATE", trackOrder: 1 }),
      ],
      timers: [
        makeDetectedTimer(1, { timerLabel: "H1", isHub: true, online: true }),
        makeDetectedTimer(2, { timerLabel: "T1", isHub: false, online: true }),
        makeDetectedTimer(3, { timerLabel: "T2", isHub: false, online: false, fingerprint: "DD000003" }),
      ],
    });
    const { api, calls } = makeMockApiClient(store);
    const root = mountHtml(`<div id="track-host"></div>`);
    const editor = new TrackEditor(root.querySelector("#track-host")!, store, api);

    try {
      // 2 assigned course nodes + 1 unassigned timer token in tray
      expect(root.querySelectorAll(".gate-line-item[data-gate]")).toHaveLength(2);
      expect(root.querySelectorAll(".unassigned-timer-token[data-timer-id]")).toHaveLength(1);

      // Promote Gate 2 to Start/Finish via checkered flag button
      const makeStartBtn = root.querySelector<HTMLElement>("[data-make-start='2']")!;
      expect(makeStartBtn).not.toBeNull();
      makeStartBtn.click();
      await flushMicrotasks();
      expect(calls.some((c) => c.method === "updateTrackNode" || c.method === "updateGate")).toBe(true);

      // Delete offline unassigned timer #3 from tray
      const delBtn = root.querySelector<HTMLButtonElement>("[data-delete-timer='3']");
      if (delBtn) {
        delBtn.click();
        await flushMicrotasks();
        expect(calls.some((c) => c.method === "deleteTimer")).toBe(true);
      }
    } finally {
      editor.destroy();
    }
  });
});

describe("services/sim_serial_port — Simulated ESP32-C5 USB Serial & SLIP Bootloader", () => {
  it("lists simulated Hub/Spoke boards, responds to SLAPRF text commands, and replies to ESP32-C5 ROM SLIP SYNC", async () => {
    const store = makeStore({
      timers: [
        makeDetectedTimer(1, { timerLabel: "H1", isHub: true, online: true }),
        makeDetectedTimer(2, { timerLabel: "T1", isHub: false, online: true }),
      ],
    });
    bindSimSerialStore(store);

    const descriptors = listSimulatedTimers();
    expect(descriptors.length).toBeGreaterThanOrEqual(2);
    expect(descriptors[0].isHub).toBe(true);

    const port = new SimulatedSerialPort(1);
    expect(port.getInfo().usbVendorId).toBe(0x303a);

    await port.open({ baudRate: 921600 });
    const reader = port.readable!.getReader();
    const writer = port.writable!.getWriter();

    const chunks: Uint8Array[] = [];
    const pumpPromise = (async () => {
      for (let i = 0; i < 6; i++) {
        const res = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((r) =>
            window.setTimeout(() => r({ value: undefined, done: true }), 120)
          ),
        ]);
        if (res.done || !res.value) break;
        chunks.push(res.value);
      }
    })();

    try {
      // 1. Send ASCII firmware command "STATUS\n" -> simulated board emits JSON/text status
      await writer.write(new TextEncoder().encode("STATUS\n"));
      await new Promise((r) => window.setTimeout(r, 40));

      // 2. Enter bootloader mode via DTR/RTS sequence and send SLIP-framed ESP_SYNC (op 0x08)
      await port.setSignals({ dataTerminalReady: true, requestToSend: true });
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
      const slipSync = new Uint8Array([
        0xc0,
        0x00, 0x08, 0x24, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x07, 0x07, 0x12, 0x20,
        ...new Uint8Array(32).fill(0x55),
        0xc0,
      ]);
      await writer.write(slipSync);
      await pumpPromise;

      const totalBytes = chunks.reduce((acc, c) => acc + c.length, 0);
      expect(totalBytes).toBeGreaterThan(0);
    } finally {
      reader.releaseLock();
      writer.releaseLock();
      await port.close();
    }
  });
});

describe("views/SimView, NetworkView, SetupView, FlasherView, LapRFEmulatorView, AboutView, DebugView & AppShell", () => {
  it("mounts SimView, NetworkView, SetupView, FlasherView, LapRFEmulatorView, and AboutView cleanly and handles mode updates", () => {
    const store = makeStore({
      simulatorRunning: true,
      timingHardwareMode: "slaprf",
      simState: {
        running: true,
        speedMultiplier: 5,
        pilots: [
          { slotIndex: 1, callsign: "Pilot1", flying: true, crashed: false, charging: false, lapProgress: 0.4, speedMph: 52 },
        ],
      },
    });
    const { api } = makeMockApiClient(store);
    const announcer = new Announcer(store);

    const root = mountHtml(`
      <div id="sim"></div>
      <div id="net"></div>
      <div id="setup"></div>
      <div id="flasher"></div>
      <div id="laprf-emulator"></div>
      <div id="about"></div>
    `);

    const simView = new SimView(root.querySelector("#sim")!, store, api);
    const netView = new NetworkView(root.querySelector("#net")!, store, api);
    const setupView = new SetupView(root.querySelector("#setup")!, store, api, announcer);
    const flasherView = new FlasherView(root.querySelector("#flasher")!, store, api);
    const laprfEmulatorView = new LapRFEmulatorView(root.querySelector("#laprf-emulator")!, store);
    const aboutView = new AboutView(root.querySelector("#about")!, store, api);

    try {
      expect(root.querySelector("#sim")!.innerHTML.length).toBeGreaterThan(100);
      expect(root.querySelector("#net")!.innerHTML.length).toBeGreaterThan(100);
      expect(root.querySelector("#setup")!.innerHTML.length).toBeGreaterThan(100);
      expect(root.querySelector("#flasher")!.innerHTML.length).toBeGreaterThan(100);
      expect(root.querySelector("#laprf-emulator")!.innerHTML.length).toBeGreaterThan(50);
      expect(root.querySelector("#about")!.textContent).toContain("SlapRF");

      // Mobile Topology Graph always renders the Hub node even when disconnected, hides all empty Spokes,
      // and ignores touch scroll drags (>10px) while honoring clean touch taps (<10px).
      const mobileGraph = root.querySelector<HTMLElement>("#net [data-mobile-topology-graph]")!;
      expect(mobileGraph).not.toBeNull();
      expect(mobileGraph.querySelectorAll(".net-mnode.is-hub").length).toBe(1);
      expect(mobileGraph.querySelectorAll(".net-mnode.is-spoke").length).toBe(0);

      // Touch drag on desktop empty slot 7 (>10px vertical scroll) must NOT select slot 7
      const emptySlot7 = root.querySelector<HTMLElement>(
        '#net .debug-topology-board [data-action="select-topology-slot"][data-slot-num="7"]'
      )!;
      expect(emptySlot7.classList.contains("is-selected")).toBe(false);
      emptySlot7.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerId: 11, pointerType: "touch", clientX: 100, clientY: 120 })
      );
      emptySlot7.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, pointerId: 11, pointerType: "touch", clientX: 100, clientY: 165 })
      );
      emptySlot7.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, pointerId: 11, pointerType: "touch", clientX: 100, clientY: 165 })
      );
      expect(emptySlot7.classList.contains("is-selected")).toBe(false);

      // Clean touch tap (<10px movement) selects cleanly
      emptySlot7.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerId: 12, pointerType: "touch", clientX: 100, clientY: 120 })
      );
      emptySlot7.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, pointerId: 12, pointerType: "touch", clientX: 102, clientY: 122 })
      );
      const emptySlot7AfterTap = root.querySelector<HTMLElement>(
        '#net .debug-topology-board [data-action="select-topology-slot"][data-slot-num="7"]'
      )!;
      expect(emptySlot7AfterTap.classList.contains("is-selected")).toBe(true);

      // Switch store into LapRF mode -> NetworkView & SimView re-render into LapRF hardware mode cleanly!
      store.hydrate({
        serverTimestampUs: 20_000_000,
        timingHardwareMode: "laprf",
        pilots: store.pilots,
        gates: store.nodes,
        timers: store.timers,
        laps: [],
        crossings: [],
        filtered: [],
        summaries: [],
        rules: store.rules,
        simulatorRunning: true,
        raceArmed: true,
        laprfEmulatorStatus: store.laprfEmulator,
        raceState: store.raceState,
      });
      expect(root.querySelector("#net")!.textContent).toContain("LapRF");
    } finally {
      simView.destroy();
      netView.destroy();
      setupView.destroy();
      flasherView.destroy();
      laprfEmulatorView.destroy();
      aboutView.destroy();
      announcer.update({ enabled: false });
    }
  });

  it("mounts DebugView, Sidebar, and AppShell cleanly and disposes all listeners without errors", () => {
    window.history.replaceState(null, "", "/#/races");
    const store = makeStore();
    const { api } = makeMockApiClient(store);
    const router = new Router();
    const announcer = new Announcer(store);

    const root = mountHtml(`
      <div id="debug" style="width:1024px;height:768px"></div>
      <aside id="sidebar"></aside>
      <div id="shell"></div>
    `);

    const debugView = new DebugView(root.querySelector("#debug")!, api);
    const sidebar = new Sidebar(root.querySelector("#sidebar")!, store, router);
    const shell = new AppShell(root.querySelector("#shell")!, store, api, router, announcer);

    try {
      expect(root.querySelector("#debug")!.innerHTML.length).toBeGreaterThan(100);
      expect(root.querySelector("#sidebar")!.textContent).toContain("Practice");
      expect(root.querySelector("#shell")!.querySelector("main")).not.toBeNull();

      // Regression guard: on mobile (<= 900px), pinching or panning charts on #/debug (or 2-finger pinching
      // on primary tabs) must NEVER trigger AppShell swipe navigation back to #/flasher or #/about!
      const origInnerWidth = window.innerWidth;
      Object.defineProperty(window, "innerWidth", { value: 390, configurable: true, writable: true });
      try {
        pushAppHash("#/debug");
        expect(router.route).toBe("debug");

        const shellEl = root.querySelector<HTMLElement>("#shell")!;
        const sigCanvas = shellEl.querySelector<HTMLElement>("[data-signal-canvas]")!;
        expect(sigCanvas).not.toBeNull();

        // 1-finger horizontal pan on Debug signal canvas (+120px right, which previously jumped to #/flasher)
        sigCanvas.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, pointerId: 21, pointerType: "touch", clientX: 80, clientY: 140 })
        );
        sigCanvas.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, pointerId: 21, pointerType: "touch", clientX: 210, clientY: 142 })
        );
        expect(router.route).toBe("debug");

        // 2-finger pinch on Debug spectrum canvas
        const specCanvas = shellEl.querySelector<HTMLElement>("[data-spectrum-canvas]")!;
        specCanvas.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, pointerId: 22, pointerType: "touch", clientX: 120, clientY: 150 })
        );
        specCanvas.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, pointerId: 23, pointerType: "touch", clientX: 190, clientY: 150 })
        );
        specCanvas.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, pointerId: 23, pointerType: "touch", clientX: 290, clientY: 150 })
        );
        specCanvas.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, pointerId: 22, pointerType: "touch", clientX: 40, clientY: 150 })
        );
        expect(router.route).toBe("debug");

        // 2-finger pinch on a primary tab (#/races) also cancels tab-swipe navigation cleanly
        pushAppHash("#/races");
        expect(router.route).toBe("races");
        const outletEl = shellEl.querySelector<HTMLElement>("main.outlet")!;
        outletEl.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, pointerId: 31, pointerType: "touch", clientX: 100, clientY: 200 })
        );
        outletEl.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, pointerId: 32, pointerType: "touch", clientX: 180, clientY: 200 })
        );
        outletEl.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, pointerId: 31, pointerType: "touch", clientX: 260, clientY: 200 })
        );
        outletEl.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, pointerId: 32, pointerType: "touch", clientX: 40, clientY: 200 })
        );
        expect(router.route).toBe("races");

        // 1-finger horizontal swipe left across primary tabs (#/races -> #/practice) even after PracticeView (#/practice) has mounted
        // its inline .practice-pilot-popover.is-inline-mobile-panel in the DOM
        pushAppHash("#/races");
        expect(router.route).toBe("races");
        outletEl.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, pointerId: 40, pointerType: "touch", clientX: 300, clientY: 200 })
        );
        window.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, pointerId: 40, pointerType: "touch", clientX: 185, clientY: 202 })
        );
        window.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, pointerId: 40, pointerType: "touch", clientX: 175, clientY: 202 })
        );
        expect(router.route).toBe("practice");

        // Swiping right from Practice (#/live) returns back to Race (#/races)
        outletEl.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, pointerId: 42, pointerType: "touch", clientX: 80, clientY: 200 })
        );
        window.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, pointerId: 42, pointerType: "touch", clientX: 205, clientY: 202 })
        );
        window.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, pointerId: 42, pointerType: "touch", clientX: 215, clientY: 202 })
        );
        expect(router.route).toBe("races");

        // 1-finger horizontal swipe left on a primary tab (#/pilots -> #/track) previews the incoming neighbor
        // during pointermove and commits navigation on pointerup
        pushAppHash("#/pilots");
        expect(router.route).toBe("pilots");
        outletEl.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, pointerId: 41, pointerType: "touch", clientX: 300, clientY: 200 })
        );
        window.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, pointerId: 41, pointerType: "touch", clientX: 190, clientY: 202 })
        );
        const trackViewDuringDrag = outletEl.querySelector<HTMLElement>(".view-track");
        expect(trackViewDuringDrag).not.toBeNull();
        expect(trackViewDuringDrag!.classList.contains("is-swipe-peek")).toBe(true);
        expect(trackViewDuringDrag!.style.transform).toContain("translate3d(");

        window.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, pointerId: 41, pointerType: "touch", clientX: 180, clientY: 202 })
        );
        expect(router.route).toBe("track");

        // Swiping left from Track (#/track) continues into More items in menu order (Network -> Debug -> Settings -> About when Flasher is hidden and Simulator is off)
        store.hydrate(makeFullState({ simulatorRunning: false, timingHardwareMode: "rotorhazard_usb" }));
        outletEl.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, pointerId: 43, pointerType: "touch", clientX: 300, clientY: 200 })
        );
        window.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, pointerId: 43, pointerType: "touch", clientX: 180, clientY: 202 })
        );
        window.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, pointerId: 43, pointerType: "touch", clientX: 170, clientY: 202 })
        );
        expect(router.route).toBe("network");

        outletEl.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, pointerId: 44, pointerType: "touch", clientX: 300, clientY: 200 })
        );
        window.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, pointerId: 44, pointerType: "touch", clientX: 180, clientY: 202 })
        );
        window.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, pointerId: 44, pointerType: "touch", clientX: 170, clientY: 202 })
        );
        expect(router.route).toBe("debug");

        outletEl.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, pointerId: 45, pointerType: "touch", clientX: 300, clientY: 200 })
        );
        window.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, pointerId: 45, pointerType: "touch", clientX: 180, clientY: 202 })
        );
        window.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, pointerId: 45, pointerType: "touch", clientX: 170, clientY: 202 })
        );
        expect(router.route).toBe("setup");

        outletEl.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, pointerId: 46, pointerType: "touch", clientX: 300, clientY: 200 })
        );
        window.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, pointerId: 46, pointerType: "touch", clientX: 180, clientY: 202 })
        );
        window.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, pointerId: 46, pointerType: "touch", clientX: 170, clientY: 202 })
        );
        expect(router.route).toBe("about");

        // Swiping right from About (#/about) steps back to Settings (#/setup)
        outletEl.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, pointerId: 47, pointerType: "touch", clientX: 80, clientY: 200 })
        );
        window.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, pointerId: 47, pointerType: "touch", clientX: 205, clientY: 202 })
        );
        window.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, pointerId: 47, pointerType: "touch", clientX: 215, clientY: 202 })
        );
        expect(router.route).toBe("setup");
      } finally {
        Object.defineProperty(window, "innerWidth", { value: origInnerWidth, configurable: true, writable: true });
      }
    } finally {
      debugView.destroy();
      sidebar.destroy();
      shell.destroy();
      router.clearListeners();
      announcer.update({ enabled: false });
    }
  });
});
