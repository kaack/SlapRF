import { pushAppHash, Router } from "../core/router";
import { TopBar } from "../layout/TopBar";
import { Announcer } from "../services/announcer";
import { probeCapabilities } from "../services/capabilities";
import { bindSimSerialStore, pickUsbPort } from "../services/sim_serial_port";
import { type TimerStatus, usbPool } from "../services/timer_console";
import { isSlapRFMode, normalizeTimingHardwareMode } from "../types/models";
import { DebugView } from "../views/DebugView";
import { PracticeView } from "../views/PracticeView";
import { NetworkView } from "../views/NetworkView";
import { TimingDevicesCard } from "../widgets/DataSourceCard";
import { renderUsbConnectionBarHtml } from "../widgets/UsbConnectionBar";
import {
  describe,
  expect,
  flushMicrotasks,
  it,
  makeFullState,
  makeMockApiClient,
  makePracticeSession,
  makeStore,
  mountHtml,
} from "./harness";

describe("SlapRF (Bluetooth) mode & BLE Hub diagnostics", () => {
  it("normalizes slaprf_ble and identifies both SlapRF hardware modes", () => {
    expect(isSlapRFMode(undefined)).toBe(true);
    expect(isSlapRFMode(null)).toBe(true);
    expect(isSlapRFMode("slaprf")).toBe(true);
    expect(isSlapRFMode("slaprf_ble")).toBe(true);
    expect(isSlapRFMode("laprf")).toBe(false);
    expect(isSlapRFMode("rotorhazard")).toBe(false);
    expect(isSlapRFMode("rotorhazard_usb")).toBe(false);

    expect(normalizeTimingHardwareMode("slaprf_ble")).toBe("slaprf_ble");
    expect(normalizeTimingHardwareMode("slaprf")).toBe("slaprf");
    expect(normalizeTimingHardwareMode("unknown")).toBe("slaprf");
  });

  it("renders SlapRF (Bluetooth) description and BOOT 3 s pairing guidance in TimingDevicesCard", () => {
    const store = makeStore({
      simulatorRunning: true,
      timingHardwareMode: "slaprf_ble",
    });
    const { api } = makeMockApiClient(store);
    const root = mountHtml(`<div id="ble-td-host"></div>`);
    const card = new TimingDevicesCard(root.querySelector("#ble-td-host")!, store, api);
    try {
      const sel = root.querySelector<HTMLSelectElement>("select[name='timing-hardware-mode']")!;
      expect(sel.value).toBe("slaprf_ble");
      expect(root.textContent || "").toContain("SlapRF Bluetooth Hub");
    } finally {
      card.destroy();
    }
  });

  it("renders Pair Device button when unpaired and omits All ports checkbox in UsbConnectionBar", () => {
    const main = usbPool.mainConsole;
    const usbHtml = renderUsbConnectionBarHtml({
      activeConsole: main,
      showAllPorts: false,
      bluetoothMode: false,
    });
    expect(usbHtml).toContain("Connect USB");

    const bleHtml = renderUsbConnectionBarHtml({
      activeConsole: main,
      showAllPorts: false,
      bluetoothMode: true,
    });
    expect(bleHtml).toContain("Pair Device");
    expect(bleHtml).not.toContain("Connect USB");
    expect(bleHtml).not.toContain("All ports");
  });

  it("updates NetworkView and DebugView titles for Bluetooth Hub and displays status.ble details", async () => {
    const store = makeStore({
      simulatorRunning: true,
      timingHardwareMode: "slaprf_ble",
    });
    const { api } = makeMockApiClient(store);

    const netRoot = mountHtml(`<div id="ble-net-host"></div>`);
    const netView = new NetworkView(netRoot.querySelector("#ble-net-host")!, store, api);
    try {
      expect(netRoot.textContent || "").toContain("Bluetooth Hub");
      expect(netRoot.textContent || "").toContain("Pair Device");
      const topoSec = netRoot.querySelector<HTMLElement>('[data-section-anchor="topology"]');
      expect(topoSec?.hidden).toBe(false);

      const multiGateBleStatus: TimerStatus = {
        fw: "0.4.0",
        role: 1,
        fp: "BE7C0001",
        label: "H1",
        uptimeMs: 12000,
        reset: "POWERON",
        boots: 1,
        heapFree: 19200,
        heapMin: 16400,
        sweepHz: 50,
        sweeps: 600,
        sweepUs: 5150,
        sweepUsMax: 5680,
        sweepBudgetUs: 6000,
        rf: { ok: true, enabled: true, gain: 32, gainMax: 80, floorDb: -90.5 },
        chip: { model: "ESP32-C5", rev: "v1.0", mac: "38:44:BE:BE:67:40", flashMB: 8 },
        net: { mode: "sta", stations: 0 },
        link: { rssi: -48, rate: 11, fmt: 1, beacons: 0, data: 480, tx: "6m", txPowerDbm: 20, saved: false },
        channel: 1,
        slot: 1,
        freqsTemporary: false,
        freqs: [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917],
        dbm: [-89, -90, -88, -91, -90, -89, -90, -64],
        spokes: [
          {
            slot: 2,
            fp: "AA000001",
            label: "T1",
            msAgo: 12,
            frames: 240,
            seq: 88,
            dbm: [-90, -90, -90, -90, -90, -90, -90, -72],
          },
        ],
        image: "ble",
        transport: "ble",
        ble: {
          connected: true,
          intervalUs: 15000,
          mtu: 247,
          phy: 2,
          rssi: -52,
          txNotifies: 420,
          txBytes: 28000,
          txDrops: 0,
          rxWrites: 5,
          nocp: 420,
          connects: 1,
          sync: true,
          syncLocked: false,
          phaseUs: -1,
          paired: true,
          pairingMode: false,
        },
      };
      usbPool.mainConsole.applyBackendSlotSnapshot({
        slotIndex: 0,
        connected: true,
        portName: "ble:BE7C0001",
        probing: false,
        reconnecting: false,
        reconnectAttempt: 0,
        maxReconnectAttempts: 5,
        reconnectFailed: false,
        isOtherDevice: false,
        lastStatus: multiGateBleStatus,
      });
      await flushMicrotasks();

      const netText = netRoot.textContent || "";
      expect(netText).toContain("ESP-NOW (6 Mbps OFDM)");
      expect(netText).toContain("1/1 active (T1)");
      expect(netText).toContain("1/6 Spokes Active");

      const spokeSlotBtn = netRoot.querySelector<HTMLButtonElement>('[data-action="select-topology-slot"][data-slot-num="2"]');
      expect(spokeSlotBtn).not.toBeNull();
      spokeSlotBtn!.click();
      await flushMicrotasks();
      expect(netRoot.textContent || "").toContain("Child Spoke (TDMA Slot 2)");
    } finally {
      usbPool.mainConsole.applyBackendSlotSnapshot({
        slotIndex: 0,
        connected: false,
        probing: false,
        reconnecting: false,
        reconnectAttempt: 0,
        maxReconnectAttempts: 5,
        reconnectFailed: false,
        isOtherDevice: false,
        lastStatus: null,
      });
      netView.destroy();
    }

    const dbgRoot = mountHtml(`<div id="ble-dbg-host"></div>`);
    const dbgView = new DebugView(dbgRoot.querySelector("#ble-dbg-host")!, api, store);
    try {
      const bleStatus: TimerStatus = {
        fw: "0.4.0",
        role: 1,
        fp: "BE7C0001",
        label: "H1",
        uptimeMs: 42000,
        reset: "POWERON",
        boots: 2,
        heapFree: 96000,
        heapMin: 84000,
        sweepHz: 100,
        sweeps: 4200,
        sweepUs: 6150,
        sweepUsMax: 6680,
        sweepBudgetUs: 7000,
        rf: { ok: true, enabled: true, gain: 32, gainMax: 80, floorDb: -91.5 },
        chip: { model: "ESP32-C5", rev: "v1.0", mac: "AA:BB:CC:DD:EE:FF", flashMB: 8 },
        net: { mode: "ble", stations: 0 },
        channel: 1,
        slot: 1,
        freqsTemporary: false,
        freqs: [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917],
        image: "ble",
        transport: "ble",
        ble: {
          connected: true,
          intervalUs: 10000,
          mtu: 247,
          phy: 2,
          rssi: -54,
          txNotifies: 820,
          txBytes: 34000,
          txDrops: 0,
          rxWrites: 4,
          nocp: 820,
          connects: 1,
          sync: true,
          syncLocked: true,
          phaseUs: 9310,
          paired: true,
          pairingMode: false,
        },
      };
      usbPool.mainConsole.applyBackendSlotSnapshot({
        slotIndex: 0,
        connected: true,
        portName: "ble:BE7C0001",
        probing: false,
        reconnecting: false,
        reconnectAttempt: 0,
        maxReconnectAttempts: 5,
        reconnectFailed: false,
        isOtherDevice: false,
        lastStatus: bleStatus,
      });
      await flushMicrotasks();

      const statusText = dbgRoot.textContent || "";
      expect(statusText).toContain("System & Bluetooth");
      expect(statusText).toContain("10 ms");
      expect(statusText).toContain("-54 dBm");
      expect(statusText).toContain("Phase locked");
      expect(statusText).toContain("Paired to host");

      // Regression: 20 Hz hub_live frames must never overwrite real JSON status
      // (which previously flipped System & Bluetooth -> System & network, /6.0 ms -> /20.0 ms, and floorDb -> -91.0).
      usbPool.mainConsole.handleBackendEvent({
        type: "status",
        slotIndex: 0,
        status: {
          ...bleStatus,
          sweepHz: 50,
          sweepUs: 5420,
          sweepUsMax: 9460,
          sweepBudgetUs: 6000,
          rf: { ok: true, enabled: true, gain: 32, gainMax: 80, floorDb: -61.2 },
        },
      });
      await new Promise((r) => window.setTimeout(r, 450));
      usbPool.mainConsole.handleBackendEvent({
        type: "hub_live",
        slotIndex: 0,
        payload: {
          slots: [{ slot: 1, dbm: [-90, -90, -90, -90, -90, -90, -90, -90], seq: 12, frames: 25, floor: -91, ageMs: 5 }],
          hubOwnFrames: 25,
        },
      });
      await flushMicrotasks();

      const afterLiveText = dbgRoot.textContent || "";
      expect(afterLiveText).toContain("System & Bluetooth");
      expect(afterLiveText).toContain("BLE Paired");
      expect(afterLiveText).toContain("-61.2 dBm");
      expect(afterLiveText).toContain("/ 6.0 ms");
      expect(afterLiveText).not.toContain("System & network");
      expect(afterLiveText).not.toContain("/ 20.0 ms");
    } finally {
      usbPool.mainConsole.applyBackendSlotSnapshot({
        slotIndex: 0,
        connected: false,
        probing: false,
        reconnecting: false,
        reconnectAttempt: 0,
        maxReconnectAttempts: 5,
        reconnectFailed: false,
        isOtherDevice: false,
        lastStatus: null,
      });
      dbgView.destroy();
    }
  });

  it("shows Connect Bluetooth Hub modal with Scan again and pairing instructions in real BLE mode", async () => {
    const origFetch = window.fetch;
    const seenUrls: string[] = [];
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seenUrls.push(url);
      if (url.includes("/v1/capabilities")) {
        return new Response(
          JSON.stringify({ portable: true, nativeEngine: true, nativeUsb: true }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/v1/slaprf/bluetooth/ports")) {
        return new Response(JSON.stringify({ ports: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return origFetch(input, init);
    }) as typeof window.fetch;

    const store = makeStore({
      simulatorRunning: false,
      timingHardwareMode: "slaprf_ble",
    });
    bindSimSerialStore(store);

    try {
      await probeCapabilities();
      const pickPromise = pickUsbPort();
      await flushMicrotasks();
      await new Promise((r) => window.setTimeout(r, 20));

      const modal = document.querySelector<HTMLElement>(".sim-usb-dialog")!;
      expect(modal).not.toBeNull();
      expect(modal.textContent || "").toContain("Pair Bluetooth Device");
      expect(modal.textContent || "").toContain("No SlapRF Bluetooth Hub found nearby");
      expect(modal.textContent || "").toContain("Scan again");
      expect(seenUrls.some((u) => u.includes("/v1/slaprf/bluetooth/ports"))).toBe(true);
      expect(seenUrls.some((u) => u.includes("/v1/slaprf/usb/ports"))).toBe(false);

      modal.querySelector<HTMLButtonElement>('[data-modal="cancel"]')!.click();
      await pickPromise.catch(() => undefined);
    } finally {
      window.fetch = origFetch;
      await probeCapabilities();
    }
  });

  it("releases All Raceband survey immediately when NetworkView is deactivated via route switch", async () => {
    const origFetch = window.fetch;
    const surveyPosts: Array<{ on?: boolean }> = [];
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/v1/capabilities")) {
        return new Response(
          JSON.stringify({ portable: true, nativeEngine: true, nativeUsb: true }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/v1/slaprf/bluetooth/survey")) {
        if ((init?.method === "PUT" || init?.method === "POST") && typeof init.body === "string") {
          surveyPosts.push(JSON.parse(init.body) as { on?: boolean });
          return new Response(JSON.stringify({ active: surveyPosts[surveyPosts.length - 1]?.on ?? false }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ active: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return origFetch(input, init);
    }) as typeof window.fetch;

    const store = makeStore({
      simulatorRunning: false,
      timingHardwareMode: "slaprf_ble",
    });
    const { api } = makeMockApiClient(store);
    const root = mountHtml(`<div id="ble-net-survey-host"></div>`);
    let netView: NetworkView | null = null;
    try {
      await probeCapabilities();
      netView = new NetworkView(root.querySelector("#ble-net-survey-host")!, store, api);
      await flushMicrotasks();
      await new Promise((r) => window.setTimeout(r, 20));

      netView.onDeactivate();
      await flushMicrotasks();
      expect(surveyPosts.some((p) => p.on === false)).toBe(true);
    } finally {
      netView?.destroy();
      window.fetch = origFetch;
      await probeCapabilities();
    }
  });

  it("renders tinted standby menu strip + one-tap Start/Resume bar when Practice is not live, and LIVE pill when live", async () => {
    window.history.replaceState(null, "", "/#/practice");
    const idleSess = makePracticeSession("prac-standby-1", {
      name: "Evening Pack",
      active: false,
      paused: false,
    });

    const store = makeStore({
      raceArmed: false,
      practiceState: {
        initialized: true,
        activeSessionId: "",
        selectedSessionId: "prac-standby-1",
        sessions: [idleSess],
      },
    });
    const { api } = makeMockApiClient(store);
    const router = new Router();
    const announcer = new Announcer(store);
    const root = mountHtml(`
      <div>
        <header id="tb-standby-host" style="width:1280px"></header>
        <div id="live-standby-host"></div>
      </div>
    `);
    const topbar = new TopBar(root.querySelector("#tb-standby-host")!, store, api, router, announcer);
    const practiceView = new PracticeView(root.querySelector("#live-standby-host")!, store, api);

    try {
      pushAppHash("#/practice/evening-pack");
      await flushMicrotasks();

      // Switch to Signals tab: standby bar + tinted menu strip remain visible
      root.querySelector<HTMLButtonElement>("[data-practice-mobile-tab='signals']")!.click();
      await flushMicrotasks();

      const strip = root.querySelector<HTMLElement>(".practice-page-topbar")!;
      expect(strip.classList.contains("is-ws-standby")).toBe(true);
      const standbyBar = root.querySelector<HTMLElement>("[data-ws-standby-bar='practice']")!;
      expect(standbyBar).not.toBeNull();
      expect(standbyBar.classList.contains("is-idle")).toBe(true);
      expect(standbyBar.textContent || "").toContain("Idle");
      expect(standbyBar.textContent || "").toContain("laps aren't counting");
      expect(standbyBar.querySelector("button")).toBeNull();
      expect(root.querySelector("[data-ws-live-pill]")).toBeNull();

      // Simulate Practice going live
      store.hydrate(
        makeFullState({
          raceArmed: true,
          practiceState: {
            initialized: true,
            activeSessionId: "prac-standby-1",
            selectedSessionId: "prac-standby-1",
            sessions: [{ ...idleSess, active: true, paused: false }],
          },
        })
      );
      await flushMicrotasks();

      expect(strip.classList.contains("is-ws-live")).toBe(true);
      expect(strip.classList.contains("is-ws-standby")).toBe(false);
      expect(root.querySelector("[data-ws-standby-bar='practice']")).toBeNull();
      expect(root.querySelector("[data-ws-live-pill]")?.textContent || "").toContain("LIVE");

      // Simulate Practice paused -> purplish standby bar returns without action button
      store.hydrate(
        makeFullState({
          raceArmed: false,
          practiceState: {
            initialized: true,
            activeSessionId: "",
            selectedSessionId: "prac-standby-1",
            sessions: [{ ...idleSess, active: false, paused: true }],
          },
        })
      );
      await flushMicrotasks();

      expect(strip.classList.contains("is-ws-standby")).toBe(true);
      const pausedBar = root.querySelector<HTMLElement>("[data-ws-standby-bar='practice']")!;
      expect(pausedBar).not.toBeNull();
      expect(pausedBar.classList.contains("is-paused")).toBe(true);
      expect(pausedBar.textContent || "").toContain("Paused");
      expect(pausedBar.textContent || "").toContain("laps aren't counting");
      expect(pausedBar.querySelector("button")).toBeNull();
      expect(root.querySelector("[data-ws-live-pill]")).toBeNull();
    } finally {
      practiceView.destroy();
      topbar.destroy();
    }
  });

  it("remembers paired Bluetooth Hub across Disconnect (showing Connect) and clears bond on Forget Device", async () => {
    const origFetch = window.fetch;
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method || "GET").toUpperCase();
      const body = typeof init?.body === "string" ? init.body : undefined;
      calls.push({ method, url, body });
      if (url.includes("/v1/capabilities")) {
        return new Response(
          JSON.stringify({ portable: true, nativeEngine: true, nativeUsb: true }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/v1/slaprf/bluetooth/ports")) {
        return new Response(
          JSON.stringify({
            ports: [
              {
                name: "ble:BE7C0001",
                isUsb: false,
                serialNumber: "BE7C0001",
                product: "SlapRF H1 (Bluetooth)",
                isEspressif: true,
                transport: "ble",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/v1/slaprf/bluetooth/connections/0") && method === "PUT") {
        await new Promise((r) => window.setTimeout(r, 40));
        return new Response(
          JSON.stringify({
            slot: {
              slotIndex: 0,
              connected: true,
              portName: "ble:BE7C0001",
              probing: false,
              reconnecting: false,
              reconnectAttempt: 0,
              maxReconnectAttempts: 5,
              reconnectFailed: false,
            },
            pool: {
              debugSlotIndex: 0,
              slots: [
                {
                  slotIndex: 0,
                  connected: true,
                  portName: "ble:BE7C0001",
                  probing: false,
                  reconnecting: false,
                  reconnectAttempt: 0,
                  maxReconnectAttempts: 5,
                  reconnectFailed: false,
                },
              ],
              knownTimers: [
                {
                  fp: "BE7C0001",
                  role: "hub",
                  label: "H1",
                  pairedBle: true,
                  lastSeenMs: Date.now(),
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/v1/slaprf/bluetooth:command")) {
        return new Response(
          JSON.stringify({ ok: true, reply: { t: "ok", cmd: "blepair", pairingMode: true } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/v1/slaprf/bluetooth/connections/0") && method === "DELETE") {
        const isForget = url.includes("forget=1");
        return new Response(
          JSON.stringify({
            debugSlotIndex: 0,
            slots: [
              {
                slotIndex: 0,
                connected: false,
                probing: false,
                reconnecting: false,
                reconnectAttempt: 0,
                reconnectFailed: false,
              },
            ],
            knownTimers: isForget
              ? []
              : [
                  {
                    fp: "BE7C0001",
                    role: "hub",
                    label: "H1",
                    pairedBle: true,
                    lastSeenMs: Date.now(),
                  },
                ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/v1/slaprf/known-timers/BE7C0001") && method === "DELETE") {
        return new Response(
          JSON.stringify({ debugSlotIndex: 0, slots: [], knownTimers: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return origFetch(input, init);
    }) as typeof window.fetch;

    const store = makeStore({
      simulatorRunning: false,
      timingHardwareMode: "slaprf_ble",
    });
    bindSimSerialStore(store);
    const { api } = makeMockApiClient(store);
    const netRoot = mountHtml(`<div id="ble-forget-host"></div>`);
    let netView: NetworkView | null = null;

    try {
      await probeCapabilities();
      usbPool.applyBackendPoolSnapshot({
        debugSlotIndex: 0,
        slots: [],
        knownTimers: [],
      });
      netView = new NetworkView(netRoot.querySelector("#ble-forget-host")!, store, api);
      await flushMicrotasks();

      // 1. Unpaired initial state -> inline timing system selector enabled + "Pair Device" + collapsible intro with (see more)
      const connSlot = netRoot.querySelector<HTMLElement>('[data-slot="connection"]')!;
      const connIntro = netRoot.querySelector<HTMLElement>('[data-section-anchor="connection"] > .settings-intro')!;
      const modeSelectInitial = netRoot.querySelector<HTMLSelectElement>('select[data-field="network-hardware-mode"]')!;
      expect(modeSelectInitial).not.toBeNull();
      expect(modeSelectInitial.disabled).toBe(false);
      expect(modeSelectInitial.value).toBe("slaprf_ble");
      expect(connSlot.textContent || "").toContain("Pair Device");
      expect(connIntro.classList.contains("has-intro-collapse")).toBe(true);
      expect(connIntro.querySelector(".settings-intro-more")).not.toBeNull();
      expect(connIntro.textContent || "").toContain("Select your timing device and connect to the Hub over Bluetooth");

      // 2. Paired & connected over BLE -> shows both Disconnect (x) AND Forget Device
      const bleStatus: TimerStatus = {
        fw: "v0.1.7",
        role: 1,
        fp: "BE7C0001",
        label: "H1",
        uptimeMs: 12000,
        reset: "POWERON",
        boots: 1,
        heapFree: 19200,
        heapMin: 16400,
        sweepHz: 50,
        sweeps: 600,
        sweepUs: 4900,
        sweepUsMax: 6100,
        sweepBudgetUs: 6000,
        rf: { ok: true, enabled: true, gain: 38, gainMax: 80, floorDb: -91 },
        chip: { model: "ESP32-C5", rev: "v1.0", mac: "AA:BB:CC:DD:EE:FF", flashMB: 8 },
        net: { mode: "ble", stations: 0 },
        channel: 1,
        slot: 1,
        freqsTemporary: false,
        freqs: [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917],
        image: "ble",
        transport: "ble",
        ble: {
          connected: true,
          intervalUs: 20000,
          mtu: 247,
          phy: 2,
          rssi: -60,
          txNotifies: 300,
          txBytes: 18000,
          txDrops: 0,
          rxWrites: 4,
          nocp: 300,
          connects: 1,
          sync: true,
          syncLocked: true,
          phaseUs: 13500,
          paired: true,
          pairingMode: false,
        },
      };
      usbPool.applyBackendPoolSnapshot({
        debugSlotIndex: 0,
        slots: [
          {
            slotIndex: 0,
            connected: true,
            portName: "ble:BE7C0001",
            probing: false,
            reconnecting: false,
            reconnectAttempt: 0,
            maxReconnectAttempts: 5,
            reconnectFailed: false,
            isOtherDevice: false,
            lastStatus: bleStatus,
          },
        ],
        knownTimers: [
          {
            fp: "BE7C0001",
            role: "hub",
            label: "H1",
            pairedBle: true,
            lastSeenMs: Date.now(),
          },
        ],
      });
      await flushMicrotasks();

      const origMatchMedia = window.matchMedia;
      try {
        // 2. Desktop (> 760px): connected pill has no inline 'x' or side-by-side Forget button; clicking opens modal
        window.matchMedia = ((q: string) => ({
          matches: false,
          media: q,
          onchange: null,
          addListener: () => undefined,
          removeListener: () => undefined,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          dispatchEvent: () => false,
        })) as typeof window.matchMedia;

        expect(connSlot.querySelector('[data-action="disconnect-usb-slot"]')).toBeNull();
        expect(connSlot.querySelector('[data-action="forget-ble-device"]')).toBeNull();
        const pillBtn = connSlot.querySelector<HTMLButtonElement>('[data-action="open-usb-slot-actions"]')!;
        expect(pillBtn).not.toBeNull();

        pillBtn.click();
        await flushMicrotasks();

        const desktopModal = document.querySelector<HTMLElement>(".device-conn-modal")!;
        expect(desktopModal).not.toBeNull();
        expect(document.querySelector(".device-conn-drawer")).toBeNull();
        const disconnectAction = desktopModal.querySelector<HTMLButtonElement>('[data-conn-action="disconnect"]')!;
        const forgetActionDesktop = desktopModal.querySelector<HTMLButtonElement>('[data-conn-action="forget"]')!;
        expect(disconnectAction).not.toBeNull();
        expect(forgetActionDesktop).not.toBeNull();
        expect(forgetActionDesktop.textContent || "").toContain("Forget Device");

        // 3. Click Disconnect in modal -> remembers pairing and shows "Connect" (not "Pair Device")
        disconnectAction.click();
        await flushMicrotasks();
        await new Promise((r) => window.setTimeout(r, 30));

        const connectBtnAfterDisconnect = connSlot.querySelector<HTMLButtonElement>('[data-action="connect-add"]')!;
        expect(connectBtnAfterDisconnect).not.toBeNull();
        expect((connectBtnAfterDisconnect.textContent || "").trim()).toBe("Connect");
        expect(connSlot.querySelector('[data-action="forget-ble-device"]')).toBeNull();

        // 3b. Clicking Connect when already paired STILL opens selection dialog ("Connect Bluetooth Device")
        // and disables the button + renders the side-to-side indeterminate bar while Connecting...
        connectBtnAfterDisconnect.click();
        await flushMicrotasks();
        await new Promise((r) => window.setTimeout(r, 15));

        const pickDialog = document.querySelector<HTMLElement>(".sim-usb-dialog")!;
        expect(pickDialog).not.toBeNull();
        expect(pickDialog.textContent || "").toContain("Connect Bluetooth Device");
        const modalConnectBtn = pickDialog.querySelector<HTMLButtonElement>('[data-modal="connect"]')!;
        expect((modalConnectBtn.textContent || "").trim()).toBe("Connect");
        modalConnectBtn.click();
        await flushMicrotasks();

        const busyBtn = connSlot.querySelector<HTMLButtonElement>('[data-action="connect-add"]')!;
        expect(busyBtn.disabled).toBe(true);
        expect(busyBtn.textContent || "").toContain("Connecting…");
        expect(connSlot.querySelector(".slaprf-indeterminate-bar")).not.toBeNull();
        expect(connSlot.querySelector('[data-action="cancel-connect"]')).not.toBeNull();
        expect(connSlot.querySelector(".debug-usb-busy-status")?.textContent || "").toContain(
          "Waiting for Bluetooth LE connection…"
        );

        await new Promise((r) => window.setTimeout(r, 60));
        await flushMicrotasks();

        // 4. Mobile (<= 760px): clicking connected pill opens bottom sheet drawer; Forget Device clears pairing -> "Pair Device"
        window.matchMedia = ((q: string) => ({
          matches: q.includes("max-width: 760px"),
          media: q,
          onchange: null,
          addListener: () => undefined,
          removeListener: () => undefined,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          dispatchEvent: () => false,
        })) as typeof window.matchMedia;

        usbPool.applyBackendPoolSnapshot({
          debugSlotIndex: 0,
          slots: [
            {
              slotIndex: 0,
              connected: true,
              portName: "ble:BE7C0001",
              probing: false,
              reconnecting: false,
              reconnectAttempt: 0,
              maxReconnectAttempts: 5,
              reconnectFailed: false,
              isOtherDevice: false,
              lastStatus: bleStatus,
            },
          ],
          knownTimers: [
            {
              fp: "BE7C0001",
              role: "hub",
              label: "H1",
              pairedBle: true,
              lastSeenMs: Date.now(),
            },
          ],
        });
        await flushMicrotasks();

        connSlot.querySelector<HTMLButtonElement>('[data-action="open-usb-slot-actions"]')!.click();
        await flushMicrotasks();

        const mobileDrawer = document.querySelector<HTMLElement>(".device-conn-drawer")!;
        expect(mobileDrawer).not.toBeNull();
        const forgetBtnMobile = mobileDrawer.querySelector<HTMLButtonElement>('[data-conn-action="forget"]')!;
        expect(forgetBtnMobile).not.toBeNull();
        forgetBtnMobile.click();
        await new Promise((r) => window.setTimeout(r, 120));
        await flushMicrotasks();

        expect(
          calls.some(
            (c) =>
              c.method === "DELETE" &&
              c.url.includes("/v1/slaprf/bluetooth/connections/0") &&
              c.url.includes("forget=1")
          )
        ).toBe(true);
        expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/v1/slaprf/known-timers/BE7C0001"))).toBe(
          true
        );
        expect(calls.some((c) => c.url.includes("/v1/slaprf/usb/"))).toBe(false);

        const finalConnectBtn = connSlot.querySelector<HTMLButtonElement>('[data-action="connect-add"]')!;
        expect((finalConnectBtn.textContent || "").trim()).toBe("Pair Device");
        const modeSelectAfterForget = netRoot.querySelector<HTMLSelectElement>('select[data-field="network-hardware-mode"]')!;
        expect(modeSelectAfterForget.disabled).toBe(false);
      } finally {
        window.matchMedia = origMatchMedia;
      }
    } finally {
      document.querySelectorAll(".slaprf-modal-backdrop, .device-conn-drawer-overlay").forEach((el) => el.remove());
      netView?.destroy();
      usbPool.applyBackendPoolSnapshot({ debugSlotIndex: 0, slots: [], knownTimers: [] });
      window.localStorage.removeItem("slaprf.hw.knownTimers");
      window.fetch = origFetch;
      await probeCapabilities();
    }
  });

  it("exposes inline timing device selector on NetworkView that locks while connected and unlocks on disconnect", async () => {
    usbPool.applyBackendPoolSnapshot({ debugSlotIndex: 0, slots: [], knownTimers: [] });
    const store = makeStore({
      simulatorRunning: true,
      timingHardwareMode: "slaprf",
    });
    const { api } = makeMockApiClient(store);
    api.setTimingHardwareMode = async (mode) => {
      store.hydrate(makeFullState({ simulatorRunning: true, timingHardwareMode: mode }));
    };
    api.simRotorHazardAction = async (payload: { action: string; timerId?: number }) => {
      if (payload.action === "disconnect") {
        store.hydrate(
          makeFullState({
            simulatorRunning: true,
            timingHardwareMode: store.timingHardwareMode,
            timers: [],
            simState: { running: true, speedMultiplier: 1, pilots: [], rotorhazardUnits: [] },
          })
        );
      }
    };
    const netRoot = mountHtml(`<div id="net-mode-switch-host"></div>`);
    const netView = new NetworkView(netRoot.querySelector("#net-mode-switch-host")!, store, api);

    try {
      await flushMicrotasks();
      const getSelect = () =>
        netRoot.querySelector<HTMLSelectElement>('select[data-field="network-hardware-mode"]')!;

      // 1. Disconnected SlapRF (USB): dropdown is enabled with all 5 options and "Connect USB" button is visible
      let sel = getSelect();
      expect(sel).not.toBeNull();
      expect(sel.disabled).toBe(false);
      expect(Array.from(sel.options).map((o) => o.value)).toEqual([
        "slaprf",
        "slaprf_ble",
        "laprf",
        "rotorhazard",
        "rotorhazard_usb",
      ]);
      expect(netRoot.querySelector('[data-slot="connection"]')?.textContent || "").toContain("Connect USB");

      // 2. Switch inline to SlapRF (Bluetooth) -> button changes to "Pair Device" without leaving NetworkView
      sel.value = "slaprf_ble";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      await flushMicrotasks();
      expect(store.timingHardwareMode).toBe("slaprf_ble");
      expect(netRoot.querySelector('[data-slot="connection"]')?.textContent || "").toContain("Pair Device");

      // 3. While connecting / connected, dropdown stays visible in place but becomes disabled
      usbPool.applyBackendPoolSnapshot({
        debugSlotIndex: 0,
        slots: [
          {
            slotIndex: 0,
            connected: false,
            connecting: true,
            connectStatus: "Waiting for Bluetooth LE connection…",
            portName: "ble:BE7C0001",
            probing: false,
            reconnecting: false,
            reconnectAttempt: 0,
            maxReconnectAttempts: 5,
            reconnectFailed: false,
            isOtherDevice: false,
          },
        ],
        knownTimers: [],
      });
      await flushMicrotasks();
      expect(getSelect().disabled).toBe(true);

      // Cancel / disconnect -> dropdown immediately unlocks again
      usbPool.applyBackendPoolSnapshot({ debugSlotIndex: 0, slots: [], knownTimers: [] });
      await flushMicrotasks();
      expect(getSelect().disabled).toBe(false);

      // 4. Switch inline to RotorHazard (Network) with an active connected device -> dropdown locks and inline Disconnect unlocks it
      store.hydrate({
        serverTimestampUs: 10_000_000,
        timingHardwareMode: "rotorhazard",
        pilots: store.pilots,
        gates: store.nodes,
        timers: [
          {
            timerId: 1,
            timerLabel: "R1",
            firmwareVersion: "RotorHazard",
            endpointAddr: "192.168.1.101:5000",
            online: true,
            framesRxCount: 120,
            lastSeenAt: new Date().toISOString(),
            color: "#d4ff3a",
            isHub: false,
            batteryMv: 0,
            batteryPct: 0,
            noiseFloorDbm: 0,
            lastRssi: [],
          },
        ],
        laps: [],
        crossings: [],
        filtered: [],
        summaries: [],
        rules: store.rules,
        simulatorRunning: true,
        simState: {
          running: true,
          speedMultiplier: 1,
          pilots: [],
          rotorhazardUnits: [
            {
              timerId: 1,
              label: "R1",
              hostIp: "192.168.1.101",
              port: 5000,
              adminUser: "admin",
              adminPass: "rotorhazard",
              poweredOn: true,
              connected: true,
              nodeCount: 8,
              assignedGateId: 0,
              trackPosition: "Unassigned",
            },
          ],
        },
        raceArmed: false,
        laprfEmulatorStatus: store.laprfEmulator,
        raceState: store.raceState,
      });
      await flushMicrotasks();
      expect(getSelect().value).toBe("rotorhazard");
      expect(getSelect().disabled).toBe(true);
      const extDisconnectBtn = netRoot.querySelector<HTMLButtonElement>('[data-action="network-disconnect-active"]')!;
      expect(extDisconnectBtn).not.toBeNull();
      expect((extDisconnectBtn.textContent || "").trim()).toBe("Disconnect");
      extDisconnectBtn.click();
      await new Promise((r) => window.setTimeout(r, 15));
      await flushMicrotasks();
      expect(getSelect().disabled).toBe(false);
    } finally {
      netView.destroy();
      usbPool.applyBackendPoolSnapshot({ debugSlotIndex: 0, slots: [], knownTimers: [] });
    }
  });
});
