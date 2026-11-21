import {
  BACKEND_URL_STORAGE_KEY,
  capabilitiesSnapshot,
  clearBackendConnectionLost,
  connectionLostSnapshot,
  enterDisconnectedServerSettingsMode,
  isLoopbackHostname,
  isMixedContentRemoteBlocked,
  isServerDisconnectedLockout,
  normalizeBackendUrl,
  openBackendConnectModal,
  probeBackendCandidate,
  probeCapabilities,
  registerBackendConnectModalOpener,
  reportBackendConnectionLost,
  resolveBackendUrl,
  resolveBackendWsUrl,
  setDatasourceUiMode,
} from "../services/capabilities";
import { Router } from "../core/router";
import { Sidebar } from "../layout/Sidebar";
import { Announcer } from "../services/announcer";
import { BackendHttpTransport } from "../services/backend_transport";
import { decodeTelemetryBatch } from "../services/wasm_transport";
import { AppStore } from "../state/store";
import { SetupView } from "../views/SetupView";
import { SimView } from "../views/SimView";
import { DataSourceCard } from "../widgets/DataSourceCard";
import { describe, expect, flushMicrotasks, it, makeMockApiClient, makeStore, mountHtml, spyOn } from "./harness";

describe("services/capabilities — URL Normalization, Mixed-Content Guards & Backend Probing", () => {
  it("normalizes bare hostnames, Raspberry Pi LAN IPs, and loopback addresses to canonical HTTP/WS URLs", () => {
    expect(normalizeBackendUrl("127.0.0.1:8090")).toBe("http://127.0.0.1:8090");
    expect(normalizeBackendUrl("192.168.1.50")).toBe("http://192.168.1.50:8090");
    expect(normalizeBackendUrl("raspberrypi.local")).toBe("http://raspberrypi.local:8090");
    expect(normalizeBackendUrl("http://192.168.1.50:9000/")).toBe("http://192.168.1.50:9000");
    expect(normalizeBackendUrl("ws://127.0.0.1:8090/v1/ws/stream")).toBe("http://127.0.0.1:8090");
    expect(normalizeBackendUrl("")).toBe("");

    expect(resolveBackendUrl("/v1/state", "")).toBe("/v1/state");
    expect(resolveBackendUrl("/v1/state", "http://192.168.1.50:8090")).toBe(
      "http://192.168.1.50:8090/v1/state"
    );
    expect(resolveBackendWsUrl("/v1/ws/stream", "http://192.168.1.50:8090")).toBe(
      "ws://192.168.1.50:8090/v1/ws/stream"
    );
    expect(resolveBackendWsUrl("/v1/ws/stream", "https://track.example.com")).toBe(
      "wss://track.example.com/v1/ws/stream"
    );
  });

  it("allows HTTPS -> loopback (127.0.0.1) per W3C Secure Contexts while flagging HTTPS -> unencrypted LAN HTTP", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("192.168.1.50")).toBe(false);

    expect(isMixedContentRemoteBlocked("https:", "http://127.0.0.1:8090")).toBe(false);
    expect(isMixedContentRemoteBlocked("https:", "http://localhost:8090")).toBe(false);
    expect(isMixedContentRemoteBlocked("https:", "http://192.168.1.50:8090")).toBe(true);
    expect(isMixedContentRemoteBlocked("https:", "https://192.168.1.50:8443")).toBe(false);
    expect(isMixedContentRemoteBlocked("http:", "http://192.168.1.50:8090")).toBe(false);
  });

  it("probes same-origin Go server, remote Go server, and falls back to Standalone Demo Mode cleanly", async () => {
    const prevSaved = window.localStorage.getItem(BACKEND_URL_STORAGE_KEY);
    const fetchSpy = spyOn(window, "fetch");

    try {
      // Case 1: Same-origin Go server responds with portable=true
      window.localStorage.removeItem(BACKEND_URL_STORAGE_KEY);
      fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/v1/capabilities") {
          return new Response(
            JSON.stringify({
              portable: true,
              version: "v2.0.0",
              hostname: "race-pi",
              storageBackend: "bbolt",
              nativeEngine: true,
              nativeUsb: true,
              lanIPs: ["192.168.1.50"],
              laprfEmulator: true,
              laprfClient: true,
              rotorhazardDiscover: true,
              multigpProxy: true,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("not found", { status: 404 });
      });

      const caps1 = await probeCapabilities();
      expect(caps1.portable).toBe(true);
      expect(caps1.demoMode).toBe(false);
      expect(caps1.remoteBackend).toBe(false);
      expect(caps1.hostname).toBe("race-pi");
      expect(caps1.storageBackend).toBe("bbolt");

      // Case 2: Static host (404 on same-origin) with saved remote backend
      window.localStorage.setItem(BACKEND_URL_STORAGE_KEY, "http://192.168.1.77:8090");
      fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "http://192.168.1.77:8090/v1/capabilities") {
          return new Response(
            JSON.stringify({
              portable: true,
              version: "v2.0.0",
              hostname: "track-pi",
              storageBackend: "bbolt",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("static 404", { status: 404 });
      });

      const caps2 = await probeCapabilities();
      expect(caps2.portable).toBe(true);
      expect(caps2.remoteBackend).toBe(true);
      expect(caps2.backendBaseUrl).toBe("http://192.168.1.77:8090");
      expect(caps2.hostname).toBe("track-pi");

      // Case 3: Pure static browser with no backend -> Demo Mode (`portable: false`, `demoMode: true`)
      window.localStorage.removeItem(BACKEND_URL_STORAGE_KEY);
      fetchSpy.mockImplementation(async () => new Response("static 404", { status: 404 }));

      const caps3 = await probeCapabilities();
      expect(caps3.portable).toBe(false);
      expect(caps3.demoMode).toBe(true);
      expect(capabilitiesSnapshot().demoMode).toBe(true);

      // Probe candidate helper reports unreachable servers cleanly
      const badProbe = await probeBackendCandidate("192.168.1.250:8090");
      expect(badProbe.ok).toBe(false);
      expect(badProbe.error).toContain("Could not reach a SlapRF Server");
    } finally {
      fetchSpy.restore();
      if (prevSaved !== null) {
        window.localStorage.setItem(BACKEND_URL_STORAGE_KEY, prevSaved);
      } else {
        window.localStorage.removeItem(BACKEND_URL_STORAGE_KEY);
      }
    }
  });
});

describe("services/backend_transport & BackendConnectModal — Wire Telemetry & Modal UI", () => {
  it("decodes binary telemetry batches from /v1/ws/stream and routes BackendHttpTransport URLs", () => {
    const transport = new BackendHttpTransport("http://192.168.1.50:8090/");
    expect(transport.urlFor("/v1/state")).toBe("http://192.168.1.50:8090/v1/state");
    expect(transport.wsUrlFor("/v1/ws/stream")).toBe("ws://192.168.1.50:8090/v1/ws/stream");

    // 4-byte header [version=1, rssiCount=8, count=1 (u16)] + 52-byte record
    const buf = new ArrayBuffer(4 + 20 + 32);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    u8[0] = 1; // version
    u8[1] = 8; // rssiCount
    dv.setUint16(2, 1, true); // count = 1

    const o = 4;
    u8[o] = 1; // timerId
    dv.setUint16(o + 2, 4980, true); // batteryMv
    dv.setUint32(o + 4, 42, true); // seqNum
    dv.setFloat64(o + 8, 12345678, true); // timestampUs
    dv.setFloat32(o + 16, -92.5, true); // noiseFloorDbm
    for (let i = 0; i < 8; i++) {
      dv.setFloat32(o + 20 + i * 4, -90 + i * 5, true);
    }

    const decoded = decodeTelemetryBatch(u8);
    expect(decoded.length).toBe(1);
    expect(decoded[0].timerId).toBe(1);
    expect(decoded[0].seqNum).toBe(42);
    expect(decoded[0].batteryMv).toBe(4980);
    expect(decoded[0].noiseFloorDbm).toBe(-92.5);
    expect(decoded[0].rssi.length).toBe(8);
    expect(decoded[0].rssi[0]).toBe(-90);
    expect(decoded[0].rssi[7]).toBe(-55);
  });

  it("toggles inline Datasource between Demo and Server without opening any modal", () => {
    let routedReason = "";
    registerBackendConnectModalOpener((reason) => {
      routedReason = reason;
    });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const store = new AppStore();
    const fakeApi = {
      toggleSimulator: async () => undefined,
      setSimSpeed: async () => undefined,
    } as unknown as import("../services/api_client").ApiClient;

    const card = new DataSourceCard(host, store, fakeApi);
    try {
      // Initially in Demo mode with no URL input rendered and zero modal
      expect(host.querySelector("[data-backend-mode='demo']")?.classList.contains("is-active")).toBe(true);
      expect(host.querySelector("[data-field='backend-url']")).toBeNull();
      expect(document.querySelector("[data-backend-connect-modal='1']")).toBeNull();

      // Triggering real-hardware intent navigates to Datasource, expands inline Server form,
      // and shows Simulation active OFF + disabled while disconnected from a server!
      openBackendConnectModal("real-hardware");
      expect(routedReason).toBe("real-hardware");
      expect(host.querySelector("[data-backend-mode='server']")?.classList.contains("is-active")).toBe(true);
      expect(host.querySelector("[data-datasource-notice='real-hardware']")?.textContent).toContain("SlapRF Server");
      expect(host.querySelector<HTMLInputElement>("[data-field='backend-url']")).not.toBeNull();
      const simInput = host.querySelector<HTMLInputElement>('input[name="simulator"]')!;
      expect(simInput).not.toBeNull();
      expect(simInput.checked).toBe(false);
      expect(simInput.disabled).toBe(true);
      expect(host.querySelector("[data-sim-speed]")).toBeNull();
      expect(document.querySelector("[data-backend-connect-modal='1']")).toBeNull();

      // Clicking Demo switches right back inline and restores Simulation speed
      host.querySelector<HTMLButtonElement>("[data-backend-mode='demo']")?.click();
      expect(host.querySelector("[data-backend-mode='demo']")?.classList.contains("is-active")).toBe(true);
      expect(host.querySelector("[data-field='backend-url']")).toBeNull();
      expect(host.querySelector('input[name="simulator"]')).toBeNull();
    } finally {
      card.destroy();
      host.remove();
      registerBackendConnectModalOpener(null);
      setDatasourceUiMode("demo");
    }
  });

  it("locks out Sidebar tabs and non-Backend Settings when switched to disconnected Server mode, and handles connection loss cleanly", async () => {
    const store = makeStore({ simulatorRunning: true });
    const { api } = makeMockApiClient(store);
    const announcer = new Announcer(store);
    const router = new Router();
    const root = mountHtml(`<div style="display:flex"><aside id="sb"></aside><main id="setup"></main></div>`);
    const sb = new Sidebar(root.querySelector("#sb")!, store, router);
    const setup = new SetupView(root.querySelector("#setup")!, store, api, announcer);

    try {
      expect(isServerDisconnectedLockout()).toBe(false);
      expect(root.querySelector("a[data-route='races']")?.classList.contains("is-disabled")).toBe(false);

      // Switch Datasource from Demo -> Server while not connected
      root.querySelector<HTMLButtonElement>("[data-backend-mode='server']")!.click();
      expect(isServerDisconnectedLockout()).toBe(true);

      // Every sidebar tab except Settings (`setup`) is disabled
      expect(root.querySelector("a[data-route='races']")?.classList.contains("is-disabled")).toBe(true);
      expect(root.querySelector("a[data-route='races']")?.getAttribute("aria-disabled")).toBe("true");
      expect(root.querySelector("a[data-route='setup']")?.classList.contains("is-disabled")).toBe(false);

      // Every settings section except Datasource is locked out, while Simulation active shows OFF & disabled
      expect(
        root.querySelector("[data-section-anchor='timing-devices']")?.classList.contains("is-server-locked")
      ).toBe(true);
      expect(
        root.querySelector("[data-section-anchor='datasource']")?.classList.contains("is-server-locked")
      ).toBe(false);
      const simToggle = root.querySelector<HTMLInputElement>('input[name="simulator"]')!;
      expect(simToggle.checked).toBe(false);
      expect(simToggle.disabled).toBe(true);

      // Switching back to Demo re-enables everything immediately
      root.querySelector<HTMLButtonElement>("[data-backend-mode='demo']")!.click();
      expect(isServerDisconnectedLockout()).toBe(false);
      expect(root.querySelector("a[data-route='races']")?.classList.contains("is-disabled")).toBe(false);
      expect(
        root.querySelector("[data-section-anchor='timing-devices']")?.classList.contains("is-server-locked")
      ).toBe(false);

      // Connection-loss transition ("Go to Settings") enters disconnected Server lockout cleanly
      reportBackendConnectionLost("http://192.168.1.99:8090");
      expect(connectionLostSnapshot().lost).toBe(true);
      const remembered = enterDisconnectedServerSettingsMode();
      expect(remembered).toBe("http://192.168.1.99:8090");
      expect(connectionLostSnapshot().lost).toBe(false);
      expect(isServerDisconnectedLockout()).toBe(true);
    } finally {
      clearBackendConnectionLost();
      setDatasourceUiMode("demo");
      setup.destroy();
      sb.destroy();
      router.clearListeners();
      announcer.update({ enabled: false });
    }
  });

  it("preserves Simulated MultiGP heat rail scroll position when selecting or deleting heats", async () => {
    const heats = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
      heatNumber: n,
      name: `Heat ${n}`,
      entries: [{ slot: 1, pilotId: 101, userName: "Alpha" }],
    }));
    const store = makeStore({
      simulatorRunning: true,
      simMultiGP: {
        chapterId: 1042,
        chapterName: "Test Chapter",
        apiKey: "test-key-1234",
        pilotPool: [{ pilotId: 101, userName: "Alpha" }],
        races: [
          {
            id: 501,
            name: "Summer Opener",
            chapterId: 1042,
            chapterName: "Test Chapter",
            status: 1,
            scoringFormat: 0,
            disableSlotAutoPopulation: 0,
            entries: [{ pilotId: 101, userName: "Alpha" }],
            schedule: {
              rounds: [{ roundNumber: 1, name: "Round 1", heats }],
            },
          },
        ],
      },
    });
    const { api } = makeMockApiClient(store);
    api.simMultiGPAdmin = async (payload) => {
      if (payload.action === "delete-heat" && payload.heatNumber) {
        const cur = store.simMultiGP!;
        const nextHeats = cur.races[0].schedule!.rounds[0].heats
          .filter((h) => h.heatNumber !== payload.heatNumber)
          .map((h, i) => ({ ...h, heatNumber: i + 1, name: `Heat ${i + 1}` }));
        store.hydrate({
          serverTimestampUs: store.serverTimestampUs,
          simulatorRunning: true,
          raceArmed: false,
          mode: store.mode,
          timingHardwareMode: store.timingHardwareMode,
          pilots: store.pilots,
          gates: store.gates,
          timers: store.timers,
          rules: store.rules,
          gateRuleOverrides: store.gateRuleOverrides,
          laps: store.laps,
          summaries: store.summaries,
          raceState: store.raceState,
          eventState: store.eventState,
          practiceState: store.practiceState,
          simState: store.simState,
          simMultiGP: {
            ...cur,
            races: [
              {
                ...cur.races[0],
                schedule: { rounds: [{ roundNumber: 1, name: "Round 1", heats: nextHeats }] },
              },
            ],
          },
        });
      }
      return store.simMultiGP!;
    };

    const root = mountHtml(`<div id="sim-scroll-host" style="width:1280px"></div>`);
    const view = new SimView(root.querySelector("#sim-scroll-host")!, store, api);
    await flushMicrotasks();

    try {
      // Expand race 501
      root.querySelector<HTMLButtonElement>("[data-action='mgp-toggle-results'][data-race-id='501']")!.click();
      const rail1 = root.querySelector<HTMLElement>(".sim-mgp-rail-list")!;
      expect(rail1).not.toBeNull();
      rail1.scrollTop = 76;
      rail1.dispatchEvent(new Event("scroll"));
      const scrolledPos = rail1.scrollTop;
      expect(scrolledPos).toBeGreaterThan(0);

      // Select Heat 6 while scrolled down -> scrollTop stays preserved!
      root
        .querySelector<HTMLButtonElement>("[data-action='mgp-select-heat'][data-heat='6']")!
        .click();
      const rail2 = root.querySelector<HTMLElement>(".sim-mgp-rail-list")!;
      expect(rail2.scrollTop).toBe(scrolledPos);

      // Delete Heat 7 while scrolled down -> scrollTop stays preserved (does not jump to 0)!
      root
        .querySelector<HTMLButtonElement>("[data-action='mgp-delete-heat'][data-heat='7']")!
        .click();
      await flushMicrotasks();
      const rail3 = root.querySelector<HTMLElement>(".sim-mgp-rail-list")!;
      expect(rail3.scrollTop).toBeGreaterThan(0);

      // Verify Sync LED is between #501 and Race Title inside .sim-mgp-race-toggle, header legend is gone, and footer legend is present
      expect(root.querySelector(".sim-mgp-led-legend")).toBeNull();
      expect(root.textContent).toContain(
        "ZippyQ races simulate pilots checking in and lining up into open seats automatically (green LED means uploaded, and gray LED means no uploads)."
      );
      const toggleBtn = root.querySelector<HTMLButtonElement>(
        "[data-action='mgp-toggle-results'][data-race-id='501']"
      )!;
      const toggleChildren = Array.from(toggleBtn.children);
      expect(toggleChildren[1]?.textContent).toBe("#501");
      expect(toggleChildren[2]?.classList.contains("status-dot")).toBe(true);
      expect(toggleChildren[3]?.classList.contains("sim-mgp-race-title")).toBe(true);

      // Verify mobile icon menu triggers open custom-select popover for schedule mode & scoring format
      let lastAdminPayload: Record<string, unknown> | null = null;
      const prevAdmin = api.simMultiGPAdmin.bind(api);
      api.simMultiGPAdmin = async (payload) => {
        lastAdminPayload = payload as unknown as Record<string, unknown>;
        return prevAdmin(payload);
      };

      const modeIconBtn = root.querySelector<HTMLButtonElement>(
        "[data-action='mgp-mobile-mode-menu'][data-race-id='501']"
      )!;
      expect(modeIconBtn).not.toBeNull();
      modeIconBtn.click();
      const modePopover = document.body.querySelector<HTMLElement>(".custom-select-popover");
      expect(modePopover).not.toBeNull();
      modePopover!.querySelectorAll<HTMLButtonElement>(".custom-select-option")[1]!.click();
      await flushMicrotasks();
      expect(lastAdminPayload?.["action"]).toBe("set-mode");
      expect(lastAdminPayload?.["raceId"]).toBe(501);
      expect(lastAdminPayload?.["isZippyQ"]).toBe(true);

      const scoringIconBtn = root.querySelector<HTMLButtonElement>(
        "[data-action='mgp-mobile-scoring-menu'][data-race-id='501']"
      )!;
      expect(scoringIconBtn).not.toBeNull();
      scoringIconBtn.click();
      const scoringPopover = document.body.querySelector<HTMLElement>(".custom-select-popover");
      expect(scoringPopover).not.toBeNull();
      scoringPopover!.querySelectorAll<HTMLButtonElement>(".custom-select-option")[2]!.click();
      await flushMicrotasks();
      expect(lastAdminPayload?.["action"]).toBe("set-scoring");
      expect(lastAdminPayload?.["raceId"]).toBe(501);
      expect(lastAdminPayload?.["scoringFormat"]).toBe(2);
    } finally {
      document.body.querySelectorAll(".custom-select-popover").forEach((el) => el.remove());
      view.destroy();
    }
  });
});
