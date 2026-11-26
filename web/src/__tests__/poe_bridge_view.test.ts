import { Router } from "../core/router";
import { Sidebar } from "../layout/Sidebar";
import { ApiClient } from "../services/api_client";
import { PoeBridgeView } from "../views/PoeBridgeView";
import { describe, expect, flushMicrotasks, it, makeMockApiClient, makeStore, mountHtml } from "./harness";

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await flushMicrotasks();
}

describe("PoE Bridge top-level navigation, LAN discovery, and management controls", () => {
  it("shows the PoE Bridge sidebar tab only when SlapRF (Network) is selected", () => {
    const store = makeStore({ timingHardwareMode: "slaprf" });
    const router = new Router();
    const root = mountHtml(`<aside id="sb"></aside>`);
    const sidebar = new Sidebar(root.querySelector("#sb")!, store, router);
    try {
      const poeLinks = Array.from(root.querySelectorAll<HTMLElement>('[data-route="poe"]'));
      expect(poeLinks.length).toBeGreaterThan(0);
      expect(poeLinks.every((el) => el.style.display === "none")).toBe(true);

      // Switching to SlapRF (Network) reveals PoE Bridge in navigation.
      store.hydrate({
        serverTimestampUs: 1000,
        timingHardwareMode: "slaprf_net",
        pilots: [],
        gates: [],
        timers: [],
        laps: [],
        crossings: [],
        filtered: [],
        summaries: [],
        rules: store.rules,
        simulatorRunning: true,
        raceArmed: false,
        laprfEmulatorStatus: store.laprfEmulator,
        raceState: store.raceState,
        eventState: store.eventState,
        practiceState: store.practiceState,
      });
      expect(poeLinks.every((el) => el.style.display === "")).toBe(true);

      // Switching to SlapRF (Bluetooth) hides PoE Bridge again.
      store.hydrate({
        serverTimestampUs: 2000,
        timingHardwareMode: "slaprf_ble",
        pilots: [],
        gates: [],
        timers: [],
        laps: [],
        crossings: [],
        filtered: [],
        summaries: [],
        rules: store.rules,
        simulatorRunning: true,
        raceArmed: false,
        laprfEmulatorStatus: store.laprfEmulator,
        raceState: store.raceState,
        eventState: store.eventState,
        practiceState: store.practiceState,
      });
      expect(poeLinks.every((el) => el.style.display === "none")).toBe(true);
    } finally {
      sidebar.destroy();
    }
  });

  it("calls /v1/slaprf/network/devices cleanly in real-hardware mode without throwing ReferenceError", async () => {
    const fakeRealClient = { simMode: false } as unknown as ApiClient;

    const origFetch = window.fetch;
    let requestedUrl = "";
    window.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(
        JSON.stringify({
          subnet: "10.0.0.0/24",
          devices: [
            {
              host: "10.0.0.28",
              port: 5480,
              endpoint: "10.0.0.28:5480",
              board: "ESP32-P4-WIFI6-POE-ETH",
              usbConnected: true,
              usbVid: "303A",
              usbPid: "1001",
              tcpConnected: false,
              connected: false,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof window.fetch;

    try {
      const res = await ApiClient.prototype.discoverSlapRFNetwork.call(fakeRealClient);
      expect(requestedUrl.endsWith("/v1/slaprf/network/devices")).toBe(true);
      expect(res.devices.length).toBe(1);
      expect(res.devices[0].host).toBe("10.0.0.28");
    } finally {
      window.fetch = origFetch;
    }
  });

  it("renders PoeBridgeView status and applies static IPv4, baud rate, and reboot actions", async () => {
    const store = makeStore({ simulatorRunning: true, timingHardwareMode: "slaprf_net" });
    const { api } = makeMockApiClient(store);

    let bridgeState = {
      host: "10.0.0.28",
      port: 5480,
      endpoint: "10.0.0.28:5480",
      board: "ESP32-P4-WIFI6-POE-ETH",
      bridgeFw: "0.2.2",
      upMs: 65000,
      usbConnected: true,
      usbVid: "303A",
      usbPid: "1001",
      baud: 115200,
      dtr: true,
      rts: false,
      ip: "10.0.0.28",
      netmask: "255.255.255.0",
      gateway: "10.0.0.1",
      staticIp: "10.0.0.28",
      staticNetmask: "255.255.255.0",
      staticGateway: "10.0.0.1",
      mac: "80:F1:B2:D5:C3:88",
      linkUp: true,
      linkSpeedMbps: 100,
      fullDuplex: true,
      dhcp: true,
      tcpConnected: false,
      tcpClients: 0,
      maxClients: 1,
      tcpPeer: "",
      rxBytes: 20480,
      txBytes: 1024,
    };

    const actionsSent: Array<Record<string, unknown>> = [];
    (api as unknown as { fetchPoeBridgeStatus: () => Promise<unknown> }).fetchPoeBridgeStatus = async () => ({
      target: bridgeState.endpoint,
      activeTarget: "",
      connectedSlot: -1,
      subnet: "10.0.0.0/24",
      bridge: { ...bridgeState },
      devices: [{ ...bridgeState }],
    });
    (api as unknown as { sendPoeBridgeAction: (p: Record<string, unknown>) => Promise<unknown> }).sendPoeBridgeAction =
      async (p: Record<string, unknown>) => {
        actionsSent.push(p);
        if (p.action === "baud" && typeof p.baud === "number") {
          bridgeState = { ...bridgeState, baud: p.baud };
        } else if (p.action === "netcfg") {
          bridgeState = {
            ...bridgeState,
            dhcp: Boolean(p.dhcp),
            ip: typeof p.ip === "string" && p.ip ? p.ip : bridgeState.ip,
            endpoint: `${typeof p.ip === "string" && p.ip ? p.ip : bridgeState.ip}:5480`,
          };
        } else if (p.action === "reboot") {
          bridgeState = { ...bridgeState, upMs: 1000 };
        }
        return {
          ok: true,
          action: String(p.action),
          target: bridgeState.endpoint,
          message: `Action ${String(p.action)} applied.`,
          bridge: { ...bridgeState },
        };
      };

    const root = mountHtml(`<div id="poe"></div>`);
    const view = new PoeBridgeView(root.querySelector("#poe")!, store, api);
    try {
      await settle();
      const text = root.textContent || "";
      expect(text).toContain("ESP32-P4-WIFI6-POE-ETH");
      expect(text).toContain("10.0.0.28:5480");
      expect(text).toContain("Espressif XIAO ESP32-C5 (303A:1001)");
      expect(text).toContain("Available (0/1)");
      expect(text).not.toContain("\u2014");

      // Change baud rate to 921600
      const baudSel = root.querySelector<HTMLSelectElement>("select[data-field='bridge-baud']")!;
      baudSel.value = "921600";
      baudSel.dispatchEvent(new Event("change", { bubbles: true }));
      root.querySelector<HTMLButtonElement>("button[data-action='save-baud']")!.click();
      await settle();
      expect(actionsSent.some((a) => a.action === "baud" && a.baud === 921600)).toBe(true);
      expect(root.textContent || "").toContain("921,600 8N1");

      // Switch to Static IPv4 and save
      root.querySelector<HTMLButtonElement>("button[data-net-mode='static']")!.click();
      const ipIn = root.querySelector<HTMLInputElement>("input[data-field='net-ip']")!;
      ipIn.value = "10.0.0.29";
      ipIn.dispatchEvent(new Event("input", { bubbles: true }));
      root.querySelector<HTMLButtonElement>("button[data-action='save-netcfg']")!.click();
      await settle();
      expect(actionsSent.some((a) => a.action === "netcfg" && a.dhcp === false && a.ip === "10.0.0.29")).toBe(true);

      // Trigger remote reboot
      root.querySelector<HTMLButtonElement>("button[data-action='reboot-bridge']")!.click();
      await settle();
      expect(actionsSent.some((a) => a.action === "reboot")).toBe(true);
    } finally {
      view.destroy();
    }
  });
});
