import {
  assembleRealState,
  formatBytes,
  hasValidKey,
  KV_REAL_CONFIG,
  PersistedEngineStateJson,
  realReplaceOps,
  splitRealState,
} from "../services/engine_persistence";
import {
  buildOrPatchFirmwareBin,
  generateFingerprint,
  LATEST_FIRMWARE_VERSION,
  parseSlaprfConfigBlock,
  setUsbSerialDtrRts,
  withFingerprint,
} from "../services/esp_flasher";
import { LapRFHardwareLink } from "../services/laprf_hardware_link";
import {
  DEFAULT_SIM_MGP_API_KEY,
  formatMultiGPScoring,
  MultiGPService,
} from "../services/multigp_service";
import { bindSimSerialStore } from "../services/sim_serial_port";
import {
  ALL_STORES,
  deleteDatabase,
  openDatabase,
  STORE_CROSSINGS,
  STORE_FILTERED,
  STORE_KV,
  STORE_LAPS,
} from "../services/storage_idb";
import { installSlaprfCurlBridge } from "../services/test_curl";
import {
  forgetKnownHardwareTimer,
  getKnownHardwareTimers,
  recordKnownHardwareTimer,
  recordKnownTimerStatus,
  TimerStatus,
} from "../services/timer_console";
import {
  describe,
  expect,
  it,
  makeMockApiClient,
  makeStore,
  spyOn,
} from "./harness";

describe("services/storage_idb & engine_persistence — Real IndexedDB & State Split/Assemble", () => {
  it("validates primary keys, splits & sorts engine records, and formats byte counts", () => {
    expect(hasValidKey("laps", { lapId: 1 })).toBe(true);
    expect(hasValidKey("laps", { lapId: Number.NaN })).toBe(false);
    expect(hasValidKey("laps", {})).toBe(false);

    expect(hasValidKey("crossings", { eventId: 42 })).toBe(true);
    expect(hasValidKey("crossings", { eventId: "42" })).toBe(false);

    expect(
      hasValidKey("filtered", {
        timestampUs: 1000,
        gateId: 1,
        slotIndex: 2,
        reason: "COOLDOWN",
      })
    ).toBe(true);
    expect(
      hasValidKey("filtered", {
        timestampUs: 1000,
        gateId: 1,
        slotIndex: 2,
      })
    ).toBe(false);

    // Empty stores return null so fresh installs keep Go defaults
    expect(assembleRealState(null, [], [], [])).toBeNull();

    // Out-of-order records + corrupt entries are filtered & sorted into monotonic engine order
    const rawState: PersistedEngineStateJson = {
      elapsedUs: 99_000_000,
      raceArmed: false,
      rules: { minLapSec: 4.5 },
      pilots: [{ slotIndex: 1, callsign: "Maverick" }],
      gates: [{ gateId: 1 }],
      timers: [],
      laps: [
        { lapId: 12, lapTimeSec: 13.8 },
        { corrupt: true },
        { lapId: 5, lapTimeSec: 14.2 },
      ],
      crossings: [
        { eventId: 200, timestampUs: 90_000 },
        { eventId: 100, timestampUs: 50_000 },
      ],
      filtered: [
        { timestampUs: 80_000, gateId: 2, slotIndex: 1, reason: "ECHO" },
        { timestampUs: 20_000, gateId: 1, slotIndex: 1, reason: "MIN_LAP" },
      ],
      raceState: { raceId: "r-1" },
    };

    const split = splitRealState(rawState);
    expect(split.config.key).toBe(KV_REAL_CONFIG);
    expect(split.laps).toHaveLength(2);

    const rebuilt = assembleRealState(
      split.config,
      split.laps,
      split.crossings,
      split.filtered
    )!;
    expect(rebuilt.raceArmed).toBe(false);
    expect((rebuilt.laps as Array<{ lapId: number }>).map((l) => l.lapId)).toEqual([5, 12]);
    expect((rebuilt.crossings as Array<{ eventId: number }>).map((c) => c.eventId)).toEqual([
      100,
      200,
    ]);
    expect(
      (rebuilt.filtered as Array<{ timestampUs: number }>).map((f) => f.timestampUs)
    ).toEqual([20_000, 80_000]);

    expect(formatBytes(undefined)).toBe("?");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(4096)).toBe("4 KB");
    expect(formatBytes(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });

  it("executes atomic IndexedDB transactions, snapshot reads, realReplaceOps, and aborts cleanly on invalid key", async () => {
    const dbName = `slaprf-unit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await deleteDatabase(dbName);
    const db = await openDatabase(dbName, 1);
    try {
      const state: PersistedEngineStateJson = {
        elapsedUs: 42_000,
        raceArmed: true,
        rules: { minLapSec: 5 },
        pilots: [],
        gates: [],
        timers: [],
        laps: [
          { lapId: 1, completedAtUs: 10_000, lapTimeSec: 15.1 },
          { lapId: 2, completedAtUs: 25_000, lapTimeSec: 14.3 },
        ],
        crossings: [{ eventId: 7, timestampUs: 10_000 }],
        filtered: [{ timestampUs: 12_000, gateId: 1, slotIndex: 1, reason: "COOLDOWN" }],
      };

      await db.writeTx(realReplaceOps(state));
      expect(await db.count(STORE_LAPS)).toBe(2);
      expect(await db.count(STORE_CROSSINGS)).toBe(1);
      expect(await db.count(STORE_FILTERED)).toBe(1);

      const snap = await db.readStores(ALL_STORES);
      expect(snap[STORE_KV]).toHaveLength(1);
      expect(snap[STORE_LAPS]).toHaveLength(2);

      // Atomic rollback check: batching a valid put + an invalid-key put must abort the ENTIRE transaction
      await expect(
        db.writeTx([
          { op: "put", store: STORE_LAPS, value: { lapId: 99, completedAtUs: 99_000 } },
          { op: "put", store: STORE_LAPS, value: { missingPrimaryKey: true } },
        ])
      ).rejects.toThrow();

      // Lap 99 must NOT have been committed because the second op in the transaction failed
      expect(await db.get(STORE_LAPS, 99)).toBeUndefined();
      expect(await db.count(STORE_LAPS)).toBe(2);

      await db.delete(STORE_LAPS, 1);
      expect(await db.count(STORE_LAPS)).toBe(1);

      await db.clearAll();
      expect(await db.count(STORE_KV)).toBe(0);
      expect(await db.count(STORE_LAPS)).toBe(0);
    } finally {
      db.close();
      await deleteDatabase(dbName);
    }
  });
});

describe("services/esp_flasher — SLAPRF02 Binary Config Stamping, CRC, App Checksum & USB Signals", () => {
  it("generates valid 8-hex non-zero fingerprints and round-trips SLAPRF02 firmware images with intact CRC", async () => {
    const fp = generateFingerprint();
    expect(fp).toMatch(/^[0-9A-F]{8}$/);
    expect(fp).not.toBe("00000000");

    const customFreqs = [5658, 5695, 5732, 5769, 5806, 5843, 5880, 9999]; // 9999 out-of-range -> falls back to 5917!
    const built = await buildOrPatchFirmwareBin({
      role: "spoke",
      timerLabel: "Split-S Gate #2",
      fingerprint: "CAFEBEEF",
      frequenciesMHz: customFreqs,
    });

    expect(built.filename).toBe(`slaprf-xiao-c5-Split-S-Gate-2-${LATEST_FIRMWARE_VERSION}.bin`);
    expect(built.bytes[0]).toBe(0xe9); // Valid ESP32 app image magic header

    const parsed = parseSlaprfConfigBlock(built.bytes)!;
    expect(parsed).toBeTruthy();
    expect(parsed.role).toBe("spoke");
    expect(parsed.timerLabel).toBe("Split-S Gate #2");
    expect(parsed.fingerprint).toBe("CAFEBEEF");
    expect(parsed.firmwareVersion).toBe(LATEST_FIRMWARE_VERSION);
    expect(parsed.frequenciesMHz).toEqual([5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917]);

    // Replacing board fingerprint updates CRC & image checksum cleanly
    const reStamped = await withFingerprint(built.bytes, "1234ABCD");
    const parsed2 = parseSlaprfConfigBlock(reStamped)!;
    expect(parsed2.fingerprint).toBe("1234ABCD");
    expect(parsed2.timerLabel).toBe("Split-S Gate #2");

    // Flipping a byte inside the config block invalidates XOR8 CRC -> parseSlaprfConfigBlock returns null!
    const corrupted = new Uint8Array(reStamped);
    corrupted[0x0100 + 11] ^= 0xff;
    expect(parseSlaprfConfigBlock(corrupted)).toBeNull();
  });

  it("sequences RTS before DTR+RTS in setUsbSerialDtrRts for Windows usbser.sys compatibility", async () => {
    const signalLog: Array<{ dataTerminalReady?: boolean; requestToSend?: boolean }> = [];
    const mockPort = {
      open: async () => {},
      close: async () => {},
      setSignals: async (sig: { dataTerminalReady?: boolean; requestToSend?: boolean }) => {
        signalLog.push({ ...sig });
      },
      readable: null,
      writable: null,
    };

    await setUsbSerialDtrRts(mockPort, false, true);
    expect(signalLog).toEqual([
      { requestToSend: true },
      { dataTerminalReady: false, requestToSend: true },
    ]);
  });
});

describe("services/timer_console — Known Hardware Timers, Sim Filtering & TDMA Slot Eviction", () => {
  it("ignores simulator boards, links Spokes to parent Hub, and evicts stale Spoke on TDMA slot collision", () => {
    const realStore = makeStore({ simulatorRunning: false, gates: [], timers: [] });
    bindSimSerialStore(realStore);
    window.localStorage.setItem("slaprf.ui.sim_mode.v1", "false");

    // Simulator fingerprints MUST never be persisted as physical hardware
    recordKnownHardwareTimer({ fp: "00000001", role: "hub", label: "SimHub" });
    recordKnownHardwareTimer({ fp: "SIM00002", role: "spoke", label: "SimSpoke" });
    recordKnownHardwareTimer({ fp: "53504B03", role: "spoke", label: "SimHexSpoke" });
    expect(getKnownHardwareTimers()).toHaveLength(0);

    // Record Hub + Spoke A on TDMA slot 2 -> Spoke A automatically associates with Hub
    recordKnownHardwareTimer({ fp: "A1000001", role: "hub", label: "Hub-Main", lastSeenMs: 1000 });
    recordKnownHardwareTimer({ fp: "B2000002", role: "spoke", label: "T1", slot: 2, lastSeenMs: 2000 });

    let known = getKnownHardwareTimers();
    expect(known).toHaveLength(2);
    const spokeA = known.find((t) => t.fp === "B2000002")!;
    expect(spokeA.parentHubFp).toBe("A1000001");
    expect(spokeA.slot).toBe(2);

    // Spoke B claims TDMA slot 2 under the same Hub -> Spoke A's stale slot 2 is cleared!
    recordKnownHardwareTimer({ fp: "C3000003", role: "spoke", label: "T1-New", slot: 2, lastSeenMs: 3000 });
    known = getKnownHardwareTimers();
    expect(known.find((t) => t.fp === "C3000003")?.slot).toBe(2);
    expect(known.find((t) => t.fp === "B2000002")?.slot).toBeUndefined();

    // Hub status snapshot ingests peer spokes in one shot
    recordKnownTimerStatus({
      fw: "v0.1.4",
      role: 1,
      fp: "A1000001",
      label: "Hub-Main",
      uptimeMs: 5000,
      reset: "POWERON",
      boots: 1,
      heapFree: 180000,
      heapMin: 160000,
      sweepHz: 100,
      sweeps: 500,
      sweepUs: 2200,
      sweepUsMax: 2900,
      sweepBudgetUs: 10000,
      rf: { ok: true, enabled: true, gain: 59, gainMax: 63, floorDb: -92 },
      chip: { model: "ESP32-C5", rev: "v1.0", mac: "AA:BB:CC:DD:EE:01", flashMB: 4 },
      net: { mode: "ESP-NOW", stations: 1 },
      channel: 1,
      slot: 1,
      freqsTemporary: false,
      freqs: [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917],
      spokes: [{ slot: 3, fp: "D4000004", label: "Dive-Gate", fw: "v0.1.4" }],
    } as TimerStatus);

    expect(getKnownHardwareTimers().find((t) => t.fp === "D4000004")?.slot).toBe(3);

    forgetKnownHardwareTimer("b2000002");
    expect(getKnownHardwareTimers().some((t) => t.fp === "B2000002")).toBe(false);
  });
});

describe("services/multigp_service, laprf_hardware_link & test_curl", () => {
  it("isolates simulated vs real MultiGP credentials and syncs unedited sim chapter state", () => {
    expect(formatMultiGPScoring(0)).toBe("Aggregate Laps");
    expect(formatMultiGPScoring(1)).toBe("Fastest Lap");
    expect(formatMultiGPScoring(2)).toBe("Fastest 3 Consecutive");
    expect(formatMultiGPScoring(6)).toBe("Fastest 2 Consecutive");
    expect(formatMultiGPScoring(99)).toBe("Format #99");

    const svc = new MultiGPService();
    const store = makeStore({
      simulatorRunning: true,
      simMultiGP: {
        chapterId: 777,
        chapterName: "Silicon Valley FPV",
        apiKey: "MGP-SIM-SV-777",
        nextRaceId: 500,
        pilotPool: [],
        races: [],
      },
    });

    // Unedited sim prefs auto-adopt the simulator backend's chapter & API key
    const simPrefs = svc.prefsFor(true, store);
    expect(simPrefs.apiKey).toBe("MGP-SIM-SV-777");
    expect(simPrefs.chapterName).toBe("Silicon Valley FPV");
    // Real chapter prefs remain completely empty & isolated
    expect(svc.prefsFor(false, store).apiKey).toBe("");

    // Editing sim key marks userEdited=true & unverified without touching real prefs
    svc.setApiKey(true, "CUSTOM-SIM-KEY");
    expect(svc.prefsFor(true, store).apiKey).toBe("CUSTOM-SIM-KEY");
    expect(svc.prefsFor(true, store).verified).toBe(false);
    expect(svc.prefsFor(true, store).userEdited).toBe(true);

    svc.setApiKey(false, "REAL-CHAPTER-SECRET");
    expect(svc.prefsFor(false, store).apiKey).toBe("REAL-CHAPTER-SECRET");

    svc.resetDefaults(true);
    expect(svc.prefsFor(true).apiKey).toBe(DEFAULT_SIM_MGP_API_KEY);
    expect(svc.prefsFor(false).apiKey).toBe("REAL-CHAPTER-SECRET");
  });

  it("routes LapRF discovery & Ethernet connect to simulator in sim mode and guards non-portable real LAN scan", async () => {
    const link = new LapRFHardwareLink();
    const simStore = makeStore({ simulatorRunning: true });
    const { api, calls } = makeMockApiClient(simStore);

    await link.discover(simStore, api);
    expect(calls.some((c) => c.method === "simLapRFDiscover")).toBe(true);

    await link.connectEthernet(simStore, api, " 192.168.1.55 ", 5403, "Start Puck");
    const actionCall = calls.find((c) => c.method === "simLapRFAction")!;
    expect(actionCall.args[0]).toEqual({
      action: "connect-host",
      host: "192.168.1.55",
      port: 5403,
      label: "Start Puck",
    });

    // Real mode on standalone browser Demo Mode rejects LAN subnet scan cleanly and prompts SlapRF Server
    const realStore = makeStore({ simulatorRunning: false });
    await expect(link.discover(realStore, api)).rejects.toThrow("SlapRF Server");
  });

  it("parses slaprfCurl string shorthands, auto-routes WASM vs host endpoints, and syncs UI", async () => {
    const store = makeStore();
    const { api, calls } = makeMockApiClient(store);
    installSlaprfCurlBridge(api);

    // Stub window.slaprfWasm
    const prevWasm = window.slaprfWasm;
    const wasmReqs: Array<{ method: string; url: string; body: string }> = [];
    window.slaprfWasm = {
      request: (method: string, url: string, body: string) => {
        wasmReqs.push({ method, url, body });
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ok: true, echoedUrl: url }),
        };
      },
    } as unknown as typeof window.slaprfWasm;

    const fetchSpy = spyOn(window, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ portable: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    try {
      // 1. Shorthand string + JSON payload -> WASM target + syncAfterDirectWasmCall
      const res1 = await window.slaprfCurl!("POST /api/race/control", { action: "stage" });
      expect(res1.ok).toBe(true);
      expect(res1.target).toBe("wasm");
      expect(res1.json).toEqual({ ok: true, echoedUrl: "/api/race/control" });
      expect(wasmReqs[0]).toEqual({
        method: "POST",
        url: "/api/race/control",
        body: JSON.stringify({ action: "stage" }),
      });
      expect(calls.some((c) => c.method === "syncAfterDirectWasmCall")).toBe(true);

      // 2. Host-only route `/api/capabilities` automatically targets `host` via fetch()
      const res2 = await window.slaprfCurl!("/api/capabilities");
      expect(res2.target).toBe("host");
      expect(res2.json).toEqual({ portable: true });
      expect(fetchSpy.calls).toHaveLength(1);
    } finally {
      window.slaprfWasm = prevWasm;
    }
  });
});
