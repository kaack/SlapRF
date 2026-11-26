import { Router } from "../core/router";
import { Sidebar } from "../layout/Sidebar";
import { ApiClient } from "../services/api_client";
import { createBackendPortHandle } from "../services/sim_serial_port";
import { usbPool } from "../services/timer_console";
import { PoeBridgeView } from "../views/PoeBridgeView";
import { describe, expect, flushMicrotasks, it, makeMockApiClient, makeStore, mountHtml } from "./harness";

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await flushMicrotasks();
}

describe("PoE Bridge top-level navigation, LAN discovery, and management controls", () => {
  it("shows the PoE Bridge sidebar tab only when SlapRF (Network) is actively connected, and hides it on disconnect", () => {
    const store = makeStore({ timingHardwareMode: "slaprf_net" });
    const router = new Router();
    const root = mountHtml(`<aside id="sb"></aside>`);
    const sidebar = new Sidebar(root.querySelector("#sb")!, store, router);
    try {
      const poeLinks = Array.from(root.querySelectorAll<HTMLElement>('[data-route="poe"]'));
      expect(poeLinks.length).toBeGreaterThan(0);

      // Even in slaprf_net mode, PoE Bridge tab stays hidden while disconnected.
      usbPool.mainConsole.applyBackendSlotSnapshot({
        slotIndex: 0,
        connected: false,
        probing: false,
        reconnecting: false,
        reconnectAttempt: 0,
        reconnectFailed: false,
      });
      (sidebar as unknown as { syncConditionalNav: () => void }).syncConditionalNav();
      expect(poeLinks.every((el) => el.style.display === "none")).toBe(true);

      // Connecting to a PoE Bridge reveals PoE Bridge in navigation.
      usbPool.mainConsole.applyBackendSlotSnapshot({
        slotIndex: 0,
        connected: true,
        portName: "10.0.0.28:5480",
        probing: false,
        reconnecting: false,
        reconnectAttempt: 0,
        reconnectFailed: false,
      });
      (usbPool as unknown as { notify: () => void }).notify();
      expect(poeLinks.every((el) => el.style.display === "")).toBe(true);

      // Disconnecting from the PoE Bridge immediately hides the PoE Bridge tab again.
      usbPool.mainConsole.applyBackendSlotSnapshot({
        slotIndex: 0,
        connected: false,
        probing: false,
        reconnecting: false,
        reconnectAttempt: 0,
        reconnectFailed: false,
      });
      (usbPool as unknown as { notify: () => void }).notify();
      expect(poeLinks.every((el) => el.style.display === "none")).toBe(true);
    } finally {
      usbPool.mainConsole.applyBackendSlotSnapshot({
        slotIndex: 0,
        connected: false,
        probing: false,
        reconnecting: false,
        reconnectAttempt: 0,
        reconnectFailed: false,
      });
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

  it("renders single-column IPv4 form in both DHCP and Static modes, compact baud Apply, and clean Reboot card", async () => {
    const store = makeStore({ simulatorRunning: true, timingHardwareMode: "slaprf_net" });
    const { api } = makeMockApiClient(store);

    // Simulate active PoE Bridge connection in usbPool.mainConsole
    (usbPool.mainConsole as unknown as { port: unknown }).port = createBackendPortHandle("10.0.0.28:5480");

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
      tcpConnected: true,
      tcpClients: 1,
      maxClients: 1,
      tcpPeer: "10.0.0.55",
      rxBytes: 20480,
      txBytes: 1024,
    };

    const actionsSent: Array<Record<string, unknown>> = [];
    (api as unknown as { fetchPoeBridgeStatus: () => Promise<unknown> }).fetchPoeBridgeStatus = async () => ({
      target: bridgeState.endpoint,
      activeTarget: bridgeState.endpoint,
      connectedSlot: 0,
      subnet: "10.0.0.0/24",
      bridge: { ...bridgeState },
      devices: [],
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
      expect(text).not.toContain("Open Flasher");
      expect(text).not.toContain("\u2014");

      // IPv4 form is present even in DHCP mode (read-only) and unlocks in Static IPv4 mode
      const dhcpIpInput = root.querySelector<HTMLInputElement>("input[data-field='net-ip']")!;
      expect(dhcpIpInput).not.toBeNull();
      expect(dhcpIpInput.disabled).toBe(true);

      // Change baud rate to 921600 and click Apply
      const baudSel = root.querySelector<HTMLSelectElement>("select[data-field='bridge-baud']")!;
      baudSel.value = "921600";
      baudSel.dispatchEvent(new Event("change", { bubbles: true }));
      root.querySelector<HTMLButtonElement>("button[data-action='save-baud']")!.click();
      await settle();
      expect(actionsSent.some((a) => a.action === "baud" && a.baud === 921600)).toBe(true);
      expect(root.textContent || "").toContain("921,600 8N1");

      // Switch to Static IPv4 and save
      root.querySelector<HTMLButtonElement>("button[data-net-mode='static']")!.click();
      const staticIpInput = root.querySelector<HTMLInputElement>("input[data-field='net-ip']")!;
      expect(staticIpInput.disabled).toBe(false);
      staticIpInput.value = "10.0.0.29";
      staticIpInput.dispatchEvent(new Event("input", { bubbles: true }));
      root.querySelector<HTMLButtonElement>("button[data-action='save-netcfg']")!.click();
      await settle();
      expect(actionsSent.some((a) => a.action === "netcfg" && a.dhcp === false && a.ip === "10.0.0.29")).toBe(true);

      // Trigger remote reboot
      root.querySelector<HTMLButtonElement>("button[data-action='reboot-bridge']")!.click();
      await settle();
      expect(actionsSent.some((a) => a.action === "reboot")).toBe(true);
    } finally {
      (usbPool.mainConsole as unknown as { port: unknown }).port = null;
      view.destroy();
    }
  });
});
