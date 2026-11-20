import {
  bestPossibleLap,
  currentLap,
  decisiveSection,
  practiceStats,
  resolveComparison,
  rollingAverages,
  sectionConsistency,
  sectionKey,
  sectionRecords,
} from "../state/analysis";
import { suggestThreshold } from "../state/calibration";
import {
  bestLapOf,
  currentSectorIndex,
  enterThresholdAt,
  exitThresholdAt,
  fastestLap,
  gateColor,
  gateLabel,
  lapsFor,
  mean,
  median,
  secondsSinceSeen,
  sectionLabel,
  sectionShort,
  timerColor,
  timerHasGate,
} from "../state/selectors";
import { AppStore, HISTORY_SECONDS } from "../state/store";
import { TimerTelemetryFrame } from "../types/models";
import {
  describe,
  expect,
  it,
  makeCrossing,
  makeDetectedTimer,
  makeEventPilot,
  makeFiltered,
  makeFullState,
  makeGate,
  makeHeat,
  makeHeatLap,
  makeLap,
  makePilot,
  makePracticeSession,
  makeRaceState,
  makeSeat,
  makeSectorSplit,
  makeStore,
} from "./harness";

describe("state/store — Hydration, Normalization, Topic Isolation & Scoped Views", () => {
  it("normalizes base64 seatChannels, legacy roster attendance, unsorted trackSnapshots, and lap sectors", () => {
    // Base64 for bytes [1, 3, 5, 8] is AQMFC (let's compute via btoa(String.fromCharCode(1, 3, 5, 8)))
    const b64Channels = btoa(String.fromCharCode(2, 4, 6, 8));
    const rawRace = makeRaceState({
      raceId: "r-norm",
      tags: ["outdoor", "", "   ", "baylands"],
      roster: [
        makeEventPilot(1, { attendance: "forfeit" }),
        makeEventPilot(2, { attendance: "left" as unknown as "dnc" }),
        makeEventPilot(3, { attendance: "dq" }),
        makeEventPilot(4, { attendance: "away" }),
        makeEventPilot(5, { attendance: "active" }),
      ],
      trackSnapshot: [
        makeGate(3, { trackOrder: 2, name: "Split-S" }),
        makeGate(1, { trackOrder: 0, name: "Start" }),
        makeGate(2, { trackOrder: 1, name: "Dive" }),
      ],
      config: {
        ...makeRaceState().config,
        seatChannels: b64Channels as unknown as number[],
      },
    });

    const store = makeStore({
      raceState: rawRace,
      eventState: { initialized: true, activeRaceId: "r-norm", races: [rawRace] },
    });

    expect(store.raceState.config.seatChannels).toEqual([2, 4, 6, 8]);
    expect(store.raceState.tags).toEqual(["outdoor", "baylands"]);
    expect(store.raceState.roster?.map((p) => p.attendance)).toEqual([
      "dnc",
      "dnc",
      "dq",
      "away",
      "active",
    ]);
    expect(store.raceState.trackSnapshot?.map((g) => g.gateId)).toEqual([1, 2, 3]);
    expect(store.allRaceTags).toEqual(["baylands", "outdoor"]);
  });

  it("fires only subscribed topics and trims telemetry history by 120s window without notifying UI forms", () => {
    const store = makeStore();
    let configFires = 0;
    let lapsFires = 0;
    let crossingsFires = 0;
    let raceFires = 0;
    const recordedLaps: number[] = [];
    const startPasses: number[] = [];
    const announcements: string[] = [];

    store.subscribe(["config"], () => configFires++);
    store.subscribe(["laps"], () => lapsFires++);
    store.subscribe(["crossings"], () => crossingsFires++);
    store.subscribe(["race"], () => raceFires++);
    store.onLapRecorded((l) => recordedLaps.push(l.lapId));
    store.onStartGateDetected((ev) => startPasses.push(ev.eventId));
    store.onRaceAnnouncement((a) => announcements.push(a.kind));

    // Telemetry ingestion MUST NOT trigger any UI topic subscribers
    const baseUs = 10_000_000;
    store.ingestTelemetry({
      timerId: 1,
      seqNum: 1,
      timestampUs: baseUs,
      rssi: [-88, -90, -91, -89],
      batteryMv: 4100,
      noiseFloorDbm: -92,
    });
    expect(configFires).toBe(0);
    expect(lapsFires).toBe(0);
    expect(crossingsFires).toBe(0);

    // Push >1024 frames spanning >120s so batch binary-search trim triggers on 1024 boundary
    const newestUs = baseUs + (HISTORY_SECONDS + 30) * 1_000_000;
    for (let i = 2; i <= 1024; i++) {
      store.ingestTelemetry({
        timerId: 1,
        seqNum: i,
        timestampUs: i === 1024 ? newestUs : baseUs + i * 10_000,
        rssi: [-85, -90, -90, -90],
        batteryMv: 4100,
        noiseFloorDbm: -92,
      });
    }
    const trimmed = store.historyFor(1);
    expect(trimmed.length).toBeLessThan(1024);
    expect(trimmed[0].timestampUs).toBeGreaterThanOrEqual(newestUs - HISTORY_SECONDS * 1_000_000);

    // Crossing with startedLap fires crossings topic + startGate listener, NOT laps or config
    store.ingestCrossing(makeCrossing(50, 1, 2, newestUs + 500_000, { startedLap: true }));
    expect(crossingsFires).toBe(1);
    expect(startPasses).toEqual([50]);
    expect(lapsFires).toBe(0);
    expect(configFires).toBe(0);

    // Filtered detection increments crossings topic only
    store.ingestFiltered(makeFiltered(newestUs + 600_000, 1, 2, "MIN_LAP"));
    expect(crossingsFires).toBe(2);

    // Lap ingestion fires laps topic + onLapRecorded
    store.ingestLap(makeLap(99, 2, 1, 14.25), []);
    expect(lapsFires).toBe(1);
    expect(recordedLaps).toEqual([99]);

    // Race ingestion fires race topic + onRaceAnnouncement
    store.ingestRace(makeRaceState({ lifecycle: "active" }), null, {
      kind: "countdown_start",
    });
    expect(raceFires).toBe(1);
    expect(announcements).toEqual(["countdown_start"]);
  });

  it("keeps smoothLatestTimestampUs gliding at steady 120 FPS velocity without 1 Hz batch blips or overruns", () => {
    const store = makeStore();
    const origNow = performance.now.bind(performance);
    let fakeNowMs = 1000.0;
    performance.now = () => fakeNowMs;
    try {
      const startTsUs = 50_000_000;
      let nextSeq = 1;
      let queuedFrames: TimerTelemetryFrame[] = [];

      // Simulate 3.0 seconds at 120 FPS (8.333 ms VSync steps) where 50 Hz hardware samples
      // are held back for 145 ms around t = 1.0 s and t = 2.0 s (1 Hz BLE STATUS burst) and
      // then delivered as a 7-frame burst.
      let prevPlayhead = 0;
      let nextSampleMs = 1000.0;
      for (let step = 0; step < 360; step++) {
        fakeNowMs = 1000.0 + step * (1000.0 / 120.0);
        while (nextSampleMs <= fakeNowMs - 15.0) {
          const sampleElapsedUs = Math.round((nextSampleMs - 1000.0) * 1000);
          queuedFrames.push({
            timerId: 1,
            seqNum: nextSeq++,
            timestampUs: startTsUs + sampleElapsedUs,
            rssi: [-91, -92, -92, -92],
            batteryMv: 4100,
            noiseFloorDbm: -92,
          });
          nextSampleMs += 20.0;
        }
        const inBurstHold =
          (fakeNowMs >= 1900.0 && fakeNowMs < 2045.0) ||
          (fakeNowMs >= 2900.0 && fakeNowMs < 3045.0);
        if (!inBurstHold && queuedFrames.length > 0) {
          for (const fr of queuedFrames) {
            store.ingestTelemetry(fr);
          }
          queuedFrames = [];
        }

        const ph = store.smoothLatestTimestampUs;
        if (step >= 10) {
          // Never overrun newest ingested telemetry sample
          expect(ph).toBeLessThanOrEqual(store.latestTimestampUs);
          if (prevPlayhead > 0) {
            const dPhUs = ph - prevPlayhead;
            // Expected 120 FPS step is 8333 us; +-2.5% PLL keeps every step inside [8100, 8560] us!
            expect(dPhUs).toBeGreaterThanOrEqual(8100);
            expect(dPhUs).toBeLessThanOrEqual(8560);
          }
        }
        prevPlayhead = ph;
      }
    } finally {
      performance.now = origNow;
    }
  });

  it("isolates historical Practice and completed Race analytics scopes & frozen trackSnapshots", () => {
    const snapNodes = [
      makeGate(10, { trackOrder: 0, role: "START_FINISH", name: "Old Start", color: "#fb923c" }),
      makeGate(20, { trackOrder: 1, role: "SECTOR_GATE", name: "Old Corkscrew", color: "#a78bfa" }),
    ];
    const stoppedSession = makePracticeSession("sess-old", {
      name: "Morning Warmup",
      active: false,
      trackSnapshot: snapNodes,
      laps: [makeLap(1, 1, 1, 15.2), makeLap(2, 1, 2, 14.6)],
    });
    const completedRace = makeRaceState({
      raceId: "race-done",
      lifecycle: "completed",
      isComplete: true,
      config: { ...makeRaceState().config, eventName: "Sunday Mains" },
      trackSnapshot: snapNodes,
      heats: [
        makeHeat("H1", {
          state: "confirmed",
          seats: [
            makeSeat(0, 1, {
              laps: [
                makeHeatLap(100, 0, 1.8), // Holeshot (lapNumber=0) must NOT be counted as a full lap!
                makeHeatLap(101, 1, 13.9),
                makeHeatLap(102, 2, 13.4),
                makeHeatLap(103, 3, 12.1, { invalidated: true }), // Invalidated lap must be excluded!
              ],
            }),
          ],
        }),
      ],
    });

    const store = new AppStore();
    store.hydrate(
      makeFullState({
        gates: [makeGate(1, { name: "Live Start" }), makeGate(2), makeGate(3)],
        raceState: completedRace,
        eventState: { initialized: true, activeRaceId: "race-done", races: [completedRace] },
        practiceState: {
          initialized: true,
          activeSessionId: "",
          selectedSessionId: "sess-old",
          sessions: [stoppedSession],
        },
      })
    );

    // Global live course still has 3 live gates
    expect(store.nodes).toHaveLength(3);
    expect(store.isHistoricalTrack).toBe(false);

    // Practice workspace view for stopped session reads frozen 2-gate snapshot
    const pracView = store.forPracticeWorkspace();
    expect(pracView.isHistoricalTrack).toBe(true);
    expect(pracView.nodes.map((n) => n.name)).toEqual(["Old Start", "Old Corkscrew"]);

    // Resolve race analytics scope by slug & extract counted laps (excluding holeshot & invalidated)
    const resolvedRace = store.resolveAnalyticsScope({ kind: "race", id: "sunday-mains" });
    expect(resolvedRace.id).toBe("race-done");
    expect(resolvedRace.live).toBe(false);
    const raceLaps = store.analyticsLapsForScope(resolvedRace);
    expect(raceLaps).toHaveLength(2);
    expect(raceLaps.map((l) => l.lapTimeSec)).toEqual([13.9, 13.4]);
    expect(raceLaps[1].isBestLap).toBe(true);
    expect(raceLaps[0].deltaToBest).toBeCloseTo(0.5, 3);
  });
});

describe("state/selectors — Timers, Gates, Hysteresis Thresholds & LapRF Mode", () => {
  it("computes statistical helpers, timer/gate labels & colors, and SlapRF vs LapRF thresholds", () => {
    expect(mean([])).toBe(0);
    expect(mean([10, 14, 12])).toBe(12);
    expect(median([])).toBe(0);
    expect(median([15, 11, 13])).toBe(13);
    expect(median([10, 20, 14, 16])).toBe(15);

    const store = makeStore({
      pilots: [
        makePilot(1, { enterThreshold: -56, exitThreshold: -66, laprfThreshold: 950 }),
        makePilot(2, { enterThreshold: -60, exitThreshold: -59 }), // exit > enter-2 should be clamped!
      ],
      gates: [
        makeGate(1, {
          assignedTimerId: 1,
          name: "",
          enterThresholds: [-50, 0],
          exitThresholds: [0, 0],
          laprfThresholds: [1250, 0],
        }),
        makeGate(2, {
          assignedTimerId: 2,
          name: "Corkscrew",
          enterThresholds: [0, -54],
          exitThresholds: [0, -50], // overrideExit > enter-2 should clamp to -56!
        }),
      ],
      timers: [
        makeDetectedTimer(1, { timerLabel: "", isHub: true, color: "#2dd4bf" }),
        makeDetectedTimer(2, { timerLabel: "Gate-B", isHub: false, color: "#f472b6" }),
      ],
      laps: [makeLap(1, 1, 1, 14.5), makeLap(2, 2, 1, 13.8), makeLap(3, 1, 2, 14.1)],
      crossings: [makeCrossing(10, 2, 1, 9_500_000)],
      serverTimestampUs: 12_000_000,
    });

    expect(lapsFor(store, 1)).toHaveLength(2);
    expect(bestLapOf(lapsFor(store, 1))).toBe(14.1);
    expect(fastestLap(store)?.lapId).toBe(2);
    expect(currentSectorIndex(store, 1)).toBe(1);
    expect(currentSectorIndex(store, 2)).toBe(-1);
    expect(secondsSinceSeen(store, 1)).toBeCloseTo(2.5, 3);
    expect(secondsSinceSeen(store, 2)).toBe(Infinity);

    // Labels & colors
    expect(gateLabel(store, 1)).toBe("H1");
    expect(gateLabel(store, 2)).toBe("Corkscrew");
    expect(gateLabel(store, 99)).toBe("T99");
    expect(sectionLabel(store, 1, 2)).toBe("H1 → Corkscrew");
    expect(sectionShort(store, 2)).toBe("S2");
    expect(timerColor(store, 1)).toBe("#2dd4bf");
    expect(gateColor(store, 2)).toBe("#f472b6");
    expect(timerHasGate(store, 1)).toBe(true);
    expect(timerHasGate(store, 7)).toBe(false);

    // SlapRF mode thresholds & hysteresis clamping
    // Pilot 1 at Gate 1 has calibrated enter=-50, pilot gap=(-56 - -66)=10 => derived exit = -60
    expect(enterThresholdAt(store, 1, 1)).toEqual({ dbm: -50, calibrated: true });
    expect(exitThresholdAt(store, 1, 1)).toEqual({ dbm: -60, calibrated: false });

    // Pilot 2 at Gate 1 uses pilot defaults (enter=-60, exit=-59 clamped to <= enter-2 = -62)
    expect(enterThresholdAt(store, 1, 2)).toEqual({ dbm: -60, calibrated: false });
    expect(exitThresholdAt(store, 1, 2)).toEqual({ dbm: -62, calibrated: false });

    // Pilot 2 at Gate 2 has calibrated enter=-54 and overrideExit=-50 -> clamped to -56 (enter - 2)
    expect(exitThresholdAt(store, 2, 2)).toEqual({ dbm: -56, calibrated: true });

    // LapRF hardware mode switches enterThresholdAt to 300..3500 scale
    store.applyStatus({
      timingHardwareMode: "laprf",
      gates: store.nodes,
      simulatorRunning: true,
      raceArmed: true,
      liveTimeStatus: store.liveTime,
    });
    expect(enterThresholdAt(store, 1, 1)).toEqual({ dbm: 1250, calibrated: true });
    expect(enterThresholdAt(store, 1, 2)).toEqual({ dbm: 800, calibrated: false });
  });
});

describe("state/analysis — Practice Trends, Missed-Gate Safe Lap Comparison & Live Lap Reconstruction", () => {
  it("computes 5-lap rolling average, 10-lap negative/positive trend, and theoretical bestPossibleLap", () => {
    const gates = [makeGate(1), makeGate(2), makeGate(3)];
    // 10 laps for Pilot 1: first 5 average 15.0s, next 5 average 14.0s -> trend = -1.0s (getting faster!)
    const times = [15.2, 14.8, 15.0, 15.1, 14.9, 14.2, 13.8, 14.0, 14.1, 13.9];
    const laps = times.map((t, idx) =>
      makeLap(idx + 1, 1, idx + 1, t, {
        sectors: [
          makeSectorSplit(0, 1, 2, t * 0.3),
          makeSectorSplit(1, 2, 3, t * 0.35),
          makeSectorSplit(2, 3, 1, t * 0.35),
        ],
      })
    );

    const store = makeStore({
      gates,
      laps,
      crossings: [makeCrossing(1, 1, 1, 19_000_000)],
      serverTimestampUs: 25_000_000, // 6s ago <= ON_TRACK_WINDOW_SEC (20s)
    });

    const stats = practiceStats(store, store.pilot(1)!);
    expect(stats.bestLap).toBe(13.8);
    expect(stats.lastLap).toBe(13.9);
    expect(stats.rollingAvg).toBeCloseTo(14.0, 3);
    expect(stats.trend).toBeCloseTo(-1.0, 3);
    expect(stats.onTrack).toBe(true);

    const rolling = rollingAverages(laps.slice(0, 3), 2);
    expect(rolling[0]).toBeCloseTo(15.2, 3);
    expect(rolling[1]).toBeCloseTo(15.0, 3);
    expect(rolling[2]).toBeCloseTo(14.9, 3);

    const consistency = sectionConsistency(store, 1);
    expect(consistency).toHaveLength(3);
    expect(consistency[0].key).toBe(sectionKey(1, 2));
    expect(consistency[0].givenAway).toBeGreaterThan(0);

    // Best possible lap sums the minimum of each of the 3 sections (all from the 13.8s lap here)
    expect(bestPossibleLap(store, 1)).toBeCloseTo(13.8, 3);
  });

  it("aligns sections by gate-pair key when a gate is missed and identifies decisiveSection & sectionRecords", () => {
    const gates = [makeGate(1), makeGate(2), makeGate(3)];
    // Lap 1 (PB 13.0s): clean 3-section lap (1->2: 4.0s, 2->3: 4.5s, 3->1: 4.5s)
    const lap1 = makeLap(1, 1, 1, 13.0, {
      sectors: [
        makeSectorSplit(0, 1, 2, 4.0),
        makeSectorSplit(1, 2, 3, 4.5),
        makeSectorSplit(2, 3, 1, 4.5),
      ],
    });
    // Lap 2 (14.6s): missed Gate 2! Engine records 1->3 (9.5s) and 3->1 (5.1s)
    const lap2 = makeLap(2, 1, 2, 14.6, {
      sectors: [
        makeSectorSplit(0, 1, 3, 9.5), // Not a normal course edge -> skipped cleanly without misaligning 3->1!
        makeSectorSplit(1, 3, 1, 5.1),
      ],
    });
    // Pilot 2 sets overall S1 record (3.7s)
    const p2Lap = makeLap(3, 2, 1, 13.5, {
      sectors: [
        makeSectorSplit(0, 1, 2, 3.7),
        makeSectorSplit(1, 2, 3, 4.9),
        makeSectorSplit(2, 3, 1, 4.9),
      ],
    });

    const store = makeStore({ gates, laps: [lap1, lap2, p2Lap] });
    const cmp = resolveComparison(store, 1)!;
    expect(cmp).toBeTruthy();
    expect(cmp.lap.lapId).toBe(2);
    expect(cmp.ref.lapId).toBe(1);
    expect(cmp.refLabel).toBe("Lap 1 (best)");
    expect(cmp.incomplete).toBe(true);
    expect(cmp.sections).toHaveLength(1);
    expect(cmp.sections[0].key).toBe("3>1");
    expect(cmp.sections[0].delta).toBeCloseTo(0.6, 3);
    expect(decisiveSection(cmp)?.key).toBe("3>1");

    // When inspecting the PB lap itself (lap 1), reference automatically becomes "next best" (lap 2)
    store.setComparison({ lapId: 1, reference: "best" });
    const pbCmp = resolveComparison(store, 1)!;
    expect(pbCmp.ref.lapId).toBe(2);
    expect(pbCmp.refLabel).toBe("Lap 2 (next best)");

    // Section records across pilots
    const recs = sectionRecords(store);
    expect(recs[0].recordSlot).toBe(2);
    expect(recs[0].recordSec).toBe(3.7);
    expect(recs[1].recordSlot).toBe(1);
    expect(recs[1].recordSec).toBe(4.5);

    // Live in-progress lap reconstruction with a missed gate:
    // Pilot 1 crossed Start (1) at 20.0s, missed Gate 2, and crossed Gate 3 at 28.0s; now at 30.0s
    const liveStore = makeStore({
      gates,
      laps: [lap1],
      crossings: [
        makeCrossing(10, 1, 1, 20_000_000),
        makeCrossing(11, 3, 1, 28_000_000),
      ],
      serverTimestampUs: 30_000_000,
    });
    const inProg = currentLap(liveStore, 1)!;
    expect(inProg).toBeTruthy();
    expect(inProg.lapNumber).toBe(2);
    expect(inProg.elapsedSec).toBeCloseTo(10.0, 2);
    expect(inProg.sections.map((s) => s.state)).toEqual(["missed", "missed", "current"]);
    expect(inProg.sections[2].splitSec).toBeCloseTo(2.0, 2);
  });
});

describe("state/calibration — Automatic RSSI Pass & Hysteresis Threshold Suggestion", () => {
  function buildTelemetryStream(
    sampleCount: number,
    floorDbm: number,
    passPeaks: Array<{ index: number; peakDbm: number }>
  ): TimerTelemetryFrame[] {
    const frames: TimerTelemetryFrame[] = [];
    for (let i = 0; i < sampleCount; i++) {
      let rssi = floorDbm + ((i % 3) - 1); // ±1 dB background ripple
      for (const p of passPeaks) {
        const dist = Math.abs(i - p.index);
        if (dist === 0) rssi = Math.max(rssi, p.peakDbm);
        else if (dist === 1) rssi = Math.max(rssi, p.peakDbm - 4);
        else if (dist === 2) rssi = Math.max(rssi, p.peakDbm - 10);
      }
      frames.push({
        timerId: 1,
        seqNum: i + 1,
        timestampUs: i * 20_000, // 50 Hz (20 ms spacing)
        rssi: [rssi, -92, -92, -92],
        batteryMv: 4100,
        noiseFloorDbm: floorDbm,
      });
    }
    return frames;
  }

  it("rejects short recordings, flat noise floors, and single passes", () => {
    const tooShort = buildTelemetryStream(60, -90, [
      { index: 15, peakDbm: -45 },
      { index: 45, peakDbm: -44 },
    ]);
    expect(suggestThreshold(tooShort, 0)).toEqual({
      ok: false,
      reason: "not enough signal recorded yet",
    });

    const flatNoise = buildTelemetryStream(150, -90, []);
    expect(suggestThreshold(flatNoise, 0)).toEqual({
      ok: false,
      reason: "no passes seen",
    });

    // Two multipath spikes only 100ms (5 samples) apart merge into ONE pass (< 400ms PEAK_SEPARATION_US)
    const multipathSinglePass = buildTelemetryStream(150, -90, [
      { index: 50, peakDbm: -46 },
      { index: 55, peakDbm: -44 },
    ]);
    expect(suggestThreshold(multipathSinglePass, 0)).toEqual({
      ok: false,
      reason: "only one pass seen",
    });
  });

  it("computes bounded enterDbm and exitDbm across multiple clean gate passes while ignoring neighbour-gate bumps", () => {
    // 250 samples (5.0s at 50 Hz): 3 real passes (-44, -46, -48 dBm) > 1.2s apart + 1 weak neighbour bump (-74 dBm)
    const frames = buildTelemetryStream(250, -90, [
      { index: 30, peakDbm: -44 },
      { index: 80, peakDbm: -74 }, // Neighbour gate bump (< halfway to strong pass -> filtered out!)
      { index: 130, peakDbm: -46 },
      { index: 210, peakDbm: -48 },
    ]);

    const res = suggestThreshold(frames, 0);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.passes).toBe(3);
      expect(res.floorDbm).toBeGreaterThanOrEqual(-92);
      expect(res.floorDbm).toBeLessThanOrEqual(-89);
      expect(res.peakDbm).toBe(-46);
      // Enter must sit well above noise floor (-90 + 8 = -82) and at least 4 dB below weak pass (-48 - 4 = -52)
      expect(res.enterDbm).toBeGreaterThanOrEqual(-82);
      expect(res.enterDbm).toBeLessThanOrEqual(-52);
      // Exit must maintain >= 6 dB hysteresis below enterDbm and >= 4 dB above floorDbm
      expect(res.exitDbm).toBeLessThanOrEqual(res.enterDbm - 6);
      expect(res.exitDbm).toBeGreaterThanOrEqual(res.floorDbm + 4);
    }
  });

  it("retains 15 minutes (900s) in HISTORY_SECONDS and calibrates the most recent indoor pack even after minutes of post-flight silence", () => {
    expect(HISTORY_SECONDS).toBe(900);

    // Build a 10-minute stream sampled at 5 Hz (3000 frames) containing:
    // - 0..60s: Pack 1 strong passes (-44 dBm over -72 dBm)
    // - 60..240s: VTX-off bench gap (-92 dBm)
    // - 240..300s: Pack 2 weaker indoor passes (-60 dBm over -74 dBm valleys every 8s)
    // - 300..600s: 5 minutes of post-landing bench silence (-92 dBm) while pilot walks to phone
    const frames: TimerTelemetryFrame[] = [];
    const pack1Centers = [10, 18, 26, 34, 42, 50];
    const pack2Centers = [248, 256, 264, 272, 280, 288];
    let seq = 1;
    for (let ms = 0; ms <= 600_000; ms += 200) {
      const sec = ms / 1000;
      let rssi = -92;
      if (sec <= 60) {
        rssi = -72;
        for (const c of pack1Centers) {
          const d = (sec - c) / 0.8;
          rssi = Math.max(rssi, -72 + 28 * Math.exp(-0.5 * d * d));
        }
      } else if (sec >= 240 && sec <= 300) {
        rssi = -74;
        for (const c of pack2Centers) {
          const d = (sec - c) / 0.85;
          rssi = Math.max(rssi, -74 + 14 * Math.exp(-0.5 * d * d));
        }
      }
      frames.push({
        timerId: 1,
        seqNum: seq++,
        timestampUs: ms * 1000,
        rssi: [rssi, -92, -92, -92],
        batteryMv: 4100,
        noiseFloorDbm: -92,
      });
    }

    const res = suggestThreshold(frames, 0);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.passes).toBe(6);
      expect(res.floorDbm).toBe(-74);
      expect(res.enterDbm).toBeLessThanOrEqual(-64);
      expect(res.enterDbm).toBeGreaterThanOrEqual(-70);
      expect(res.exitDbm).toBeGreaterThanOrEqual(-72);
      expect(res.exitDbm).toBeLessThanOrEqual(res.enterDbm - 5);
    }
  });

  it("ignores < -70 dBm 5 GHz Wi-Fi blips on unoccupied channels during manual Auto-calibrate", () => {
    const wifiBlips = buildTelemetryStream(250, -92, [
      { index: 40, peakDbm: -73 },
      { index: 120, peakDbm: -71 },
      { index: 200, peakDbm: -75 },
    ]);
    expect(suggestThreshold(wifiBlips, 0)).toEqual({
      ok: false,
      reason: "no passes seen",
    });
  });
});
