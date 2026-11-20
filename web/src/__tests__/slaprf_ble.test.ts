import { probeCapabilities } from "../services/capabilities";
import { bindSimSerialStore, pickUsbPort } from "../services/sim_serial_port";
import { type TimerStatus, usbPool } from "../services/timer_console";
import { isSlapRFMode, normalizeTimingHardwareMode } from "../types/models";
import { DebugView } from "../views/DebugView";
import { NetworkView } from "../views/NetworkView";
import { TimingDevicesCard } from "../widgets/DataSourceCard";
import { renderUsbConnectionBarHtml } from "../widgets/UsbConnectionBar";
import { describe, expect, flushMicrotasks, it, makeMockApiClient, makeStore, mountHtml } from "./harness";

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

  it("renders Connect Bluetooth button and omits All ports checkbox in UsbConnectionBar", () => {
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
    expect(bleHtml).toContain("Connect Bluetooth");
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
      expect(netRoot.textContent || "").toContain("Connect Bluetooth");
      const topoSec = netRoot.querySelector<HTMLElement>('[data-section-anchor="topology"]');
      expect(topoSec?.hidden).toBe(true);
    } finally {
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
      if (url.includes("/api/capabilities")) {
        return new Response(
          JSON.stringify({ portable: true, nativeEngine: true, nativeUsb: true }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/api/usb/ports")) {
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
      expect(modal.textContent || "").toContain("Connect Bluetooth Hub");
      expect(modal.textContent || "").toContain("No SlapRF Bluetooth Hub found nearby");
      expect(modal.textContent || "").toContain("Scan again");
      expect(seenUrls.some((u) => u.includes("/api/usb/ports?transport=ble"))).toBe(true);

      modal.querySelector<HTMLButtonElement>('[data-modal="cancel"]')!.click();
      await pickPromise.catch(() => undefined);
    } finally {
      window.fetch = origFetch;
      await probeCapabilities();
    }
  });
});
