import { downloadBinaryFile, downloadTextFile } from "../core/android_bridge";
import { Router } from "../core/router";
import { Sidebar } from "../layout/Sidebar";
import { ANDROID_SYSTEM_VOICE_URI, Announcer, lapCallout, spokenName } from "../services/announcer";
import { usbPool, type TimerStatus } from "../services/timer_console";
import {
  beforeEach,
  describe,
  expect,
  it,
  makeCrossing,
  makeHeat,
  makeLap,
  makePilot,
  makeRaceState,
  makeSeat,
  makeStore,
  mountHtml,
  spyOn,
} from "./harness";

interface FakeAudioRig {
  oscillatorsStarted: number[];
  spokenTexts: string[];
  cancelCalls: number;
  finishCurrentSpeech: () => void;
}

function installFakeSpeechAndAudio(): FakeAudioRig {
  const rig: FakeAudioRig = {
    oscillatorsStarted: [],
    spokenTexts: [],
    cancelCalls: 0,
    finishCurrentSpeech: () => {},
  };

  let activeUtterance: SpeechSynthesisUtterance | null = null;
  rig.finishCurrentSpeech = () => {
    const u = activeUtterance;
    activeUtterance = null;
    if (u && typeof u.onend === "function") {
      u.onend(new Event("end") as SpeechSynthesisEvent);
    }
  };

  class FakeAudioContext {
    public currentTime = 0;
    public state: AudioContextState = "running";
    public destination = {} as AudioDestinationNode;

    public createOscillator() {
      let freq = 440;
      const osc = {
        type: "sine",
        frequency: {
          value: 440,
          setValueAtTime: (v: number) => {
            freq = v;
          },
        },
        connect: (next: unknown) => next,
        start: () => {
          rig.oscillatorsStarted.push(Math.round(freq * 100) / 100);
        },
        stop: () => {},
      };
      return osc;
    }

    public createGain() {
      const gainNode = {
        gain: {
          value: 1,
          setValueAtTime: () => {},
          linearRampToValueAtTime: () => {},
          exponentialRampToValueAtTime: () => {},
        },
        connect: (next: unknown) => next,
      };
      return gainNode;
    }

    public createBiquadFilter() {
      return {
        type: "lowpass",
        frequency: { value: 2000, setValueAtTime: () => {} },
        connect: (next: unknown) => next,
      };
    }

    public createBufferSource() {
      return {
        buffer: null,
        connect: (next: unknown) => next,
        start: () => {},
      };
    }

    public decodeAudioData(): Promise<AudioBuffer> {
      return Promise.resolve({} as AudioBuffer);
    }

    public resume(): Promise<void> {
      this.state = "running";
      return Promise.resolve();
    }

    public suspend(): Promise<void> {
      this.state = "suspended";
      return Promise.resolve();
    }
  }

  spyOn(window, "AudioContext").mockImplementation(
    () => new FakeAudioContext() as unknown as AudioContext
  );

  class FakeSpeechSynthesisUtterance {
    public text: string;
    public lang = "en-US";
    public voice: SpeechSynthesisVoice | null = null;
    public volume = 1;
    public rate = 1;
    public pitch = 1;
    public onend: ((ev: SpeechSynthesisEvent) => unknown) | null = null;
    public onerror: ((ev: SpeechSynthesisErrorEvent) => unknown) | null = null;
    constructor(text = "") {
      this.text = text;
    }
  }

  spyOn(window, "SpeechSynthesisUtterance").mockImplementation(
    (text?: unknown) =>
      new FakeSpeechSynthesisUtterance(typeof text === "string" ? text : "") as unknown as SpeechSynthesisUtterance
  );

  // Force a local English browser voice so Announcer uses browser SpeechSynthesis deterministically
  const fakeVoice = {
    voiceURI: "Google US English",
    name: "Google US English",
    lang: "en-US",
    localService: true,
    default: true,
  } as SpeechSynthesisVoice;

  if ("speechSynthesis" in window) {
    spyOn(window.speechSynthesis, "getVoices").mockReturnValue([fakeVoice]);
    spyOn(window.speechSynthesis, "cancel").mockImplementation(() => {
      rig.cancelCalls++;
      activeUtterance = null;
    });
    spyOn(window.speechSynthesis, "resume").mockImplementation(() => {});
    spyOn(window.speechSynthesis, "speak").mockImplementation((u: unknown) => {
      const utt = u as SpeechSynthesisUtterance;
      activeUtterance = utt;
      rig.spokenTexts.push(utt.text);
    });
  }

  return rig;
}

describe("services/announcer — Phonetic Names, Lap Formatting, Queue Dedup & Winner Horn Regression", () => {
  beforeEach(() => {
    window.localStorage.setItem(
      "gate-timer.announcer",
      JSON.stringify({
        enabled: true,
        raceLapCallouts: false,
        keepScreenAwake: false,
        voiceURI: "Google US English",
        rate: 1.1,
        volume: 0.8,
      })
    );
  });

  it("formats all-caps callsigns, preserves CamelCase word boundaries, honors phonetics, and trims trailing zeros", () => {
    expect(spokenName("VANOVER")).toBe("Vanover");
    expect(spokenName("MeWo")).toBe("MeWo");
    expect(spokenName("FreeLove")).toBe("FreeLove");
    expect(spokenName("MCK", "MinChan Kim")).toBe("MinChan Kim");
    expect(spokenName("   ")).toBe("");

    expect(lapCallout("VANOVER", 14.0)).toBe("Vanover, 14");
    expect(lapCallout("VANOVER", 14.8)).toBe("Vanover, 14.8");
    expect(lapCallout("VANOVER", 14.08)).toBe("Vanover, 14.08");
    expect(lapCallout("MCK", 11.4, "MinChan")).toBe("MinChan, 11.4");
  });

  it("sanitizes out-of-range or corrupt localStorage preferences back to safe bounds", () => {
    installFakeSpeechAndAudio();
    window.localStorage.setItem(
      "gate-timer.announcer",
      JSON.stringify({
        enabled: "not-a-bool",
        rate: 99.5, // outside 0.8..1.6 -> reset to 1.0
        volume: -5, // outside 0..1 -> reset to 1
        voiceURI: "   ",
      })
    );
    const store = makeStore();
    const ann = new Announcer(store);
    try {
      expect(ann.settings.enabled).toBe(false);
      expect(ann.settings.rate).toBe(1.0);
      expect(ann.settings.volume).toBe(1);
      expect(ann.settings.voiceURI).toBe("Google US English");
    } finally {
      ann.stop();
    }
  });

  it("deduplicates queued laps for the same pilot in practice so stale back-to-back laps are never spoken", async () => {
    const rig = installFakeSpeechAndAudio();
    const store = makeStore({
      pilots: [
        makePilot(1, { callsign: "VANOVER" }),
        makePilot(2, { callsign: "HEADSUP", phoneticName: "Heads Up" }),
      ],
    });
    const ann = new Announcer(store);
    try {
      // Pilot 1 finishes Lap 1 -> starts speaking immediately
      store.ingestLap(makeLap(1, 1, 1, 14.25), []);
      expect(rig.spokenTexts).toEqual(["Vanover, 14.25"]);

      // While Pilot 1's utterance is still speaking, Pilot 2 logs two laps back-to-back (15.10 then 14.05)
      store.ingestLap(makeLap(2, 2, 1, 15.1), []);
      store.ingestLap(makeLap(3, 2, 2, 14.05), []);

      // Finish Pilot 1's utterance and wait past BETWEEN_CALLOUTS_MS (80ms) breath timer
      rig.finishCurrentSpeech();
      await new Promise((r) => window.setTimeout(r, 110));

      // Pilot 2's older 15.1s lap was replaced in queue by their newer 14.05s lap!
      expect(rig.spokenTexts).toEqual(["Vanover, 14.25", "Heads Up, 14.05"]);
    } finally {
      ann.stop();
    }
  });

  it("plays gate-pass confirmation beeps during a live race heat while suppressing spoken laps unless raceLapCallouts is on", async () => {
    const rig = installFakeSpeechAndAudio();
    const runningHeat = makeHeat("W1-H1", {
      state: "running",
      seats: [
        makeSeat(0, 1, { status: "racing" }),
        makeSeat(1, 2, { status: "dq" }), // DQ pilot must be ignored!
      ],
    });
    const race = makeRaceState({
      mode: "race",
      lifecycle: "active",
      activeHeatId: "W1-H1",
      heats: [runningHeat],
    });
    const store = makeStore({
      pilots: [makePilot(1, { callsign: "VANOVER" }), makePilot(2, { callsign: "EVAN" })],
      raceState: race,
    });
    const ann = new Announcer(store);

    try {
      const oscBefore = rig.oscillatorsStarted.length;
      // DQ pilot crossing -> neither beep nor speech
      store.ingestLap(makeLap(1, 2, 1, 13.5), []);
      expect(rig.spokenTexts).toHaveLength(0);

      // Active racing pilot crossing with raceLapCallouts=false -> plays gate-pass beep (~1046.5 Hz), NO speech!
      store.ingestCrossing(makeCrossing(10, 1, 1, 5_000_000, { startedLap: true }));
      store.ingestLap(makeLap(2, 1, 1, 13.2), []);
      expect(rig.oscillatorsStarted.length).toBeGreaterThan(oscBefore);
      expect(rig.oscillatorsStarted).toContain(1046.5);
      expect(rig.spokenTexts).toHaveLength(0);

      // Enable raceLapCallouts -> now speaks pilot laps during live heat
      ann.update({ raceLapCallouts: true });
      store.ingestLap(makeLap(3, 1, 2, 12.95), []);
      expect(rig.spokenTexts).toEqual(["Vanover, 12.95"]);

      // Queue another pilot's lap + a race-level holeshot announcement while Pilot 1 is still speaking,
      // then toggle raceLapCallouts OFF mid-heat -> queued pilot lap is purged, race announcement stays!
      store.ingestLap(makeLap(4, 2, 1, 13.1), []);
      store.ingestRace(race, null, { kind: "holeshot", slotIndex: 1, callsign: "VANOVER" });
      ann.update({ raceLapCallouts: false });

      rig.finishCurrentSpeech();
      await new Promise((r) => window.setTimeout(r, 110));
      expect(rig.spokenTexts).toEqual(["Vanover, 12.95", "Holeshot Vanover"]);
    } finally {
      ann.stop();
    }
  });

  it("defaults qualifierLapCallouts ON for qualifying & open_qualifier heats and toggles independently from raceLapCallouts", () => {
    const rig = installFakeSpeechAndAudio();
    const qualHeat = makeHeat("OQ-H1", {
      state: "running",
      stageFormat: "open_qualifier",
      seats: [makeSeat(0, 1, { status: "racing" })],
    });
    const race = makeRaceState({
      mode: "race",
      lifecycle: "active",
      activeHeatId: "OQ-H1",
      heats: [qualHeat],
    });
    const store = makeStore({
      pilots: [makePilot(1, { callsign: "VANOVER" })],
      raceState: race,
    });
    const ann = new Announcer(store);

    try {
      expect(ann.settings.qualifierLapCallouts).toBe(true);
      expect(ann.settings.raceLapCallouts).toBe(false);
      expect(ann.isLapCalloutsActiveForStage("open_qualifier")).toBe(true);
      expect(ann.isLapCalloutsActiveForStage("double_elimination")).toBe(false);

      // Qualifier lap speaks by default!
      store.ingestLap(makeLap(1, 1, 1, 12.44), []);
      expect(rig.spokenTexts).toEqual(["Vanover, 12.44"]);

      // Toggle off for qualifier via toggleLapCalloutsForStage -> mutes qualifier lap callouts
      ann.toggleLapCalloutsForStage("open_qualifier");
      expect(ann.isLapCalloutsActiveForStage("open_qualifier")).toBe(false);
      rig.finishCurrentSpeech();
      store.ingestLap(makeLap(2, 1, 2, 12.18), []);
      expect(rig.spokenTexts).toEqual(["Vanover, 12.44"]);
    } finally {
      ann.stop();
    }
  });

  it("always announces laps in practice mode even when both qualifierLapCallouts and raceLapCallouts are muted", () => {
    const rig = installFakeSpeechAndAudio();
    const runningHeat = makeHeat("W1-H1", {
      state: "running",
      stageFormat: "double_elimination",
      seats: [makeSeat(0, 1, { status: "racing" })],
    });
    const race = makeRaceState({
      mode: "race",
      lifecycle: "paused",
      activeHeatId: "W1-H1",
      heats: [runningHeat],
    });
    const store = makeStore({
      operatingMode: "practice",
      pilots: [makePilot(1, { callsign: "VANOVER" })],
      raceState: race,
    });
    const ann = new Announcer(store);

    try {
      ann.update({ enabled: true, qualifierLapCallouts: false, raceLapCallouts: false });
      expect(ann.settings.qualifierLapCallouts).toBe(false);
      expect(ann.settings.raceLapCallouts).toBe(false);

      // In practice mode, lap announcements are ALWAYS on when master announcer is enabled
      store.ingestLap(makeLap(1, 1, 1, 11.88), []);
      expect(rig.spokenTexts).toEqual(["Vanover, 11.88"]);
    } finally {
      ann.stop();
    }
  });

  it("suppresses spoken lap times when toggled off during a live Control race even when raceState.mode is 'practice' (coexistence regression test)", () => {
    const rig = installFakeSpeechAndAudio();
    const qualHeat = makeHeat("Q1-1", {
      state: "running",
      stageFormat: "qualifying",
      seats: [makeSeat(0, 1, { status: "racing" })],
    });
    const raceHeat = makeHeat("W1-1", {
      state: "waiting",
      stageFormat: "single_elimination",
      seats: [makeSeat(0, 1, { status: "racing" })],
    });
    // Real Go engine keeps raceState.mode = "practice" while races run alongside stopped practice sessions
    const race = makeRaceState({
      mode: "practice",
      lifecycle: "active",
      activeHeatId: "Q1-1",
      heats: [qualHeat, raceHeat],
    });
    const store = makeStore({
      operatingMode: "practice",
      pilots: [makePilot(1, { callsign: "VANOVER" })],
      practiceState: { initialized: true, activeSessionId: "", selectedSessionId: "", sessions: [] },
      raceState: race,
    });
    const ann = new Announcer(store);

    try {
      // Turn off qualifier lap callouts -> MUST NOT announce lap time on Q1-1!
      ann.update({ enabled: true, qualifierLapCallouts: false, raceLapCallouts: false });
      rig.spokenTexts.length = 0;

      store.ingestLap(makeLap(1, 1, 1, 11.42), []);
      expect(rig.spokenTexts).toEqual([]);

      // Switch to Race heat W1-1 with raceLapCallouts=false -> MUST NOT announce lap time!
      const raceRunning = makeRaceState({
        mode: "practice",
        lifecycle: "active",
        activeHeatId: "W1-1",
        heats: [
          { ...qualHeat, state: "confirmed" },
          { ...raceHeat, state: "running" },
        ],
      });
      store.ingestRace(raceRunning, null, null);
      store.ingestLap(makeLap(2, 1, 1, 10.95), []);
      expect(rig.spokenTexts).toEqual([]);

      // Toggle raceLapCallouts ON -> now speaks lap time!
      ann.update({ raceLapCallouts: true });
      store.ingestLap(makeLap(3, 1, 2, 10.77), []);
      expect(rig.spokenTexts).toEqual(["Vanover, 10.77"]);
    } finally {
      ann.stop();
    }
  });

  it("plays the celebratory dual-chord winner horn AND speaks '<Winner> finishes 1st' after the horn completes (regression test)", async () => {
    const rig = installFakeSpeechAndAudio();
    const finalsHeat = makeHeat("GF-1", {
      state: "running",
      startMode: "heads_up",
      stageFormat: "double_elimination",
      bracketLane: "finals",
      seats: [makeSeat(0, 1, { callsign: "VANOVER", status: "finished", position: 1 })],
    });
    const race = makeRaceState({
      mode: "race",
      lifecycle: "active",
      activeHeatId: "GF-1",
      heats: [finalsHeat],
    });
    const store = makeStore({
      pilots: [makePilot(1, { callsign: "VANOVER" }), makePilot(2, { callsign: "BMSWEB", phoneticName: "Thomas" })],
      raceState: race,
    });
    const ann = new Announcer(store);

    try {
      // Dispatch competitive 1st-place finish announcement
      store.ingestRace(race, null, {
        kind: "pilot_finished",
        heatId: "GF-1",
        slotIndex: 1,
        callsign: "VANOVER",
        position: 1,
        competitive: true,
      });

      // Dual-hit stadium chord oscillators (523.25, 659.25, 783.99, 587.33, 739.99, 880 Hz) MUST fire immediately
      expect(rig.oscillatorsStarted).toContain(523.25);
      expect(rig.oscillatorsStarted).toContain(880);

      // Wait for the ~660ms horn hold timer to fire and pump the priority-front winner callout!
      await new Promise((r) => window.setTimeout(r, 720));
      expect(rig.spokenTexts).toContain("Vanover finishes 1st");

      // Finish 1st-place speech and wait past 80ms breath hold, then verify 2nd-place competitive & emergency-stop preemptions
      rig.finishCurrentSpeech();
      await new Promise((r) => window.setTimeout(r, 110));

      store.ingestRace(race, null, {
        kind: "pilot_finished",
        heatId: "GF-1",
        slotIndex: 2,
        callsign: "BMSWEB",
        position: 2,
        competitive: true,
      });
      expect(rig.spokenTexts[rig.spokenTexts.length - 1]).toBe("Thomas finishes 2nd");

      // Emergency stop immediately cancels current speech and announces emergency stop after cancel hold
      store.ingestRace(race, null, { kind: "emergency_stop" });
      expect(rig.cancelCalls).toBeGreaterThanOrEqual(1);
      await new Promise((r) => window.setTimeout(r, 180));
      expect(rig.spokenTexts[rig.spokenTexts.length - 1]).toBe(
        "Emergency stop! Land immediately!"
      );
    } finally {
      ann.stop();
    }
  });

  it("announces pilot_last_lap cleanly (coalescing with queued lap callouts when ON, and never falling through to practice when another heat is running)", async () => {
    const rig = installFakeSpeechAndAudio();
    const h1 = makeHeat("Q1-1", {
      state: "finished",
      stageFormat: "single_elimination",
      targetLaps: 3,
      seats: [makeSeat(0, 1, { callsign: "VANOVER", status: "finished" })],
    });
    const h2 = makeHeat("Q1-2", {
      state: "running",
      stageFormat: "single_elimination",
      targetLaps: 3,
      seats: [
        makeSeat(0, 2, { callsign: "MINCHAN", status: "racing" }),
        makeSeat(1, 3, { callsign: "EVAN", status: "racing" }),
      ],
    });
    // Even if activeHeatId momentarily points to finished Q1-1, getLiveRunningRaceHeat() must find running Q1-2!
    const race = makeRaceState({
      mode: "race",
      lifecycle: "active",
      activeHeatId: "Q1-1",
      heats: [h1, h2],
    });
    const store = makeStore({
      pilots: [
        makePilot(1, { callsign: "VANOVER" }),
        makePilot(2, { callsign: "MINCHAN" }),
        makePilot(3, { callsign: "EVAN" }),
      ],
      raceState: race,
    });
    const ann = new Announcer(store);

    try {
      // Non-seated pilot 1 lap must NOT fall through to practice speech while Q1-2 is running!
      store.ingestLap(makeLap(1, 1, 1, 11.5), []);
      expect(rig.spokenTexts).toEqual([]);

      // With raceLapCallouts OFF, pilot_last_lap speaks "<Pilot>, last lap"
      store.ingestRace(race, null, {
        kind: "pilot_last_lap",
        heatId: "Q1-2",
        slotIndex: 2,
        callsign: "MINCHAN",
      });
      expect(rig.spokenTexts).toEqual(["Minchan, last lap"]);

      // While Minchan is still speaking, turn raceLapCallouts ON and emit Evan's lap + pilot_last_lap -> coalesces into "Evan, 11.82, last lap"!
      ann.update({ raceLapCallouts: true });
      store.ingestLap(makeLap(2, 3, 2, 11.82), []);
      store.ingestRace(race, null, {
        kind: "pilot_last_lap",
        heatId: "Q1-2",
        slotIndex: 3,
        callsign: "EVAN",
      });
      rig.finishCurrentSpeech();
      await new Promise((r) => window.setTimeout(r, 110));
      expect(rig.spokenTexts).toEqual(["Minchan, last lap", "Evan, 11.82, last lap"]);
    } finally {
      ann.stop();
    }
  });

  it("does not re-sound the airhorn on heat_finished when hornAlreadySounded is true and says 'Heat complete'", async () => {
    const rig = installFakeSpeechAndAudio();
    const h1 = makeHeat("Q1-1", {
      state: "running",
      stageFormat: "qualifying",
      targetLaps: 0,
      seats: [makeSeat(0, 1, { callsign: "FAERRY", status: "racing" })],
    });
    const race = makeRaceState({
      mode: "race",
      lifecycle: "active",
      activeHeatId: "Q1-1",
      heats: [h1],
    });
    const store = makeStore({
      pilots: [makePilot(1, { callsign: "FAERRY" })],
      raceState: race,
    });
    const ann = new Announcer(store);
    let airhornCalls = 0;
    const origPlay = ann.playHeatEndAirhorn.bind(ann);
    ann.playHeatEndAirhorn = () => {
      airhornCalls++;
      origPlay();
    };

    try {
      store.ingestRace(race, null, {
        kind: "overtime",
        heatId: "Q1-1",
        timedOut: true,
      });
      expect(airhornCalls).toBe(1);

      store.ingestRace(race, null, {
        kind: "heat_finished",
        heatId: "Q1-1",
        hornAlreadySounded: true,
      });
      expect(airhornCalls).toBe(1);
      expect(rig.spokenTexts).toContain("Heat complete");
    } finally {
      ann.stop();
    }
  });

  it("announces 'Timing system connected' and 'Timing system disconnected' when announcer is enabled", async () => {
    const rig = installFakeSpeechAndAudio();
    const main = usbPool.mainConsole;
    main.applyBackendSlotSnapshot({
      slotIndex: 0,
      connected: false,
      probing: false,
      reconnecting: false,
      reconnectAttempt: 0,
      maxReconnectAttempts: 5,
      reconnectFailed: false,
      isOtherDevice: false,
    });

    const store = makeStore({ timingHardwareMode: "slaprf" });
    const ann = new Announcer(store);
    try {
      const hubStatus = {
        fw: "0.1.7",
        role: 1,
        fp: "AA11BB22",
        label: "H1",
        emergencyMode: false,
      } as unknown as TimerStatus;

      main.applyBackendSlotSnapshot({
        slotIndex: 0,
        portName: "COM10",
        connected: true,
        probing: false,
        reconnecting: false,
        reconnectAttempt: 0,
        maxReconnectAttempts: 5,
        reconnectFailed: false,
        isOtherDevice: false,
        lastStatus: hubStatus,
      });

      await new Promise((r) => window.setTimeout(r, 120));
      expect(rig.spokenTexts).toEqual(["Timing system connected"]);
      rig.finishCurrentSpeech();
      await new Promise((r) => window.setTimeout(r, 100));

      main.applyBackendSlotSnapshot({
        slotIndex: 0,
        connected: false,
        probing: false,
        reconnecting: false,
        reconnectAttempt: 0,
        maxReconnectAttempts: 5,
        reconnectFailed: false,
        isOtherDevice: false,
      });

      await new Promise((r) => window.setTimeout(r, 120));
      expect(rig.spokenTexts).toEqual(["Timing system connected", "Timing system disconnected"]);
    } finally {
      main.applyBackendSlotSnapshot({
        slotIndex: 0,
        connected: false,
        probing: false,
        reconnecting: false,
        reconnectAttempt: 0,
        maxReconnectAttempts: 5,
        reconnectFailed: false,
        isOtherDevice: false,
      });
      ann.stop();
    }
  });

  it("tracks timing connection state silently while muted and announces subsequent transitions once enabled", async () => {
    const rig = installFakeSpeechAndAudio();
    window.localStorage.setItem(
      "gate-timer.announcer",
      JSON.stringify({
        enabled: false,
        raceLapCallouts: false,
        keepScreenAwake: false,
        voiceURI: "Google US English",
        rate: 1.0,
        volume: 0.8,
      })
    );

    const store = makeStore({
      timingHardwareMode: "laprf",
      simulatorRunning: true,
      simState: {
        running: true,
        speedMultiplier: 1,
        pilots: [],
        timers: [],
        laprfUnits: [
          {
            timerId: 2,
            label: "LapRF-1",
            host: "192.168.1.50",
            port: 5403,
            poweredOn: true,
            connected: false,
            gateArmed: true,
            voltageMv: 12100,
            rtcDeltaMs: 0,
            slotRssi: [0, 0, 0, 0, 0, 0, 0, 0],
            slotFreqsMhz: [],
            slotThresholds: [],
          },
        ],
      } as never,
    });
    const ann = new Announcer(store);
    try {
      // Connect while announcer is OFF -> no speech, but internal state tracks connected=true
      store.applyStatus({
        gates: store.nodes,
        timers: [],
        timingHardwareMode: "laprf",
        simulatorRunning: true,
        raceArmed: true,
        liveTimeStatus: store.liveTime,
        simState: {
          running: true,
          speedMultiplier: 1,
          pilots: [],
          timers: [],
          laprfUnits: [
            {
              timerId: 2,
              label: "LapRF-1",
              host: "192.168.1.50",
              port: 5403,
              poweredOn: true,
              connected: true,
              gateArmed: true,
              voltageMv: 12100,
              rtcDeltaMs: 0,
              slotRssi: [0, 0, 0, 0, 0, 0, 0, 0],
              slotFreqsMhz: [],
              slotThresholds: [],
            },
          ],
        } as never,
      });
      await new Promise((r) => window.setTimeout(r, 120));
      expect(rig.spokenTexts).toEqual([]);

      // Turn announcer ON -> says "Announcer on"
      ann.update({ enabled: true });
      expect(rig.spokenTexts).toEqual(["Announcer on"]);
      rig.finishCurrentSpeech();
      await new Promise((r) => window.setTimeout(r, 130));

      // Disconnect while announcer is ON -> says "Timing system disconnected"
      store.applyStatus({
        gates: store.nodes,
        timers: [],
        timingHardwareMode: "laprf",
        simulatorRunning: true,
        raceArmed: true,
        liveTimeStatus: store.liveTime,
        simState: {
          running: true,
          speedMultiplier: 1,
          pilots: [],
          timers: [],
          laprfUnits: [],
        } as never,
      });
      await new Promise((r) => window.setTimeout(r, 120));
      expect(rig.spokenTexts).toEqual(["Announcer on", "Timing system disconnected"]);
    } finally {
      ann.stop();
    }
  });

  it("routes speech, keep-screen-on, and file exports through SlapRFAndroid bridge when inside native Android WebView", () => {
    window.localStorage.removeItem("gate-timer.announcer");
    installFakeSpeechAndAudio();
    const spokenAndroid: string[] = [];
    let speaking = false;
    let keepScreen = false;
    let savedFile: { name: string; mime: string; b64: string } | null = null;
    const win = window as unknown as { SlapRFAndroid?: unknown };
    win.SlapRFAndroid = {
      isAndroidApp: () => true,
      speak: (text: string) => {
        spokenAndroid.push(text);
        speaking = true;
      },
      stopSpeech: () => {
        speaking = false;
      },
      isSpeaking: () => speaking,
      setKeepScreenOn: (on: boolean) => {
        keepScreen = on;
      },
      setThemeMode: () => undefined,
      getLanStatusJson: () => JSON.stringify({ enabled: false, port: 0, urls: [] }),
      setLanEnabled: () => JSON.stringify({ enabled: true, port: 8090, urls: ["http://192.168.1.20:8090"] }),
      saveBase64File: (name: string, mime: string, b64: string) => {
        savedFile = { name, mime, b64 };
      },
    };

    const store = makeStore({
      operatingMode: "practice",
      pilots: [makePilot(1, { callsign: "FAERRY" })],
    });
    const ann = new Announcer(store);
    try {
      expect(keepScreen).toBe(true);
      ann.update({ keepScreenAwake: false });
      expect(keepScreen).toBe(false);
      expect(ann.activeVoiceURI()).toBe(ANDROID_SYSTEM_VOICE_URI);
      expect(ann.voices().some((v) => v.voiceURI === ANDROID_SYSTEM_VOICE_URI)).toBe(true);

      ann.update({ enabled: true });
      expect(spokenAndroid).toEqual(["Announcer on"]);

      downloadTextFile("backup.json", "application/json", '{"hello":"android"}');
      expect(savedFile).not.toBeNull();
      expect(savedFile!.name).toBe("backup.json");
      expect(atob(savedFile!.b64)).toBe('{"hello":"android"}');

      downloadBinaryFile("slaprf-H1.bin", "application/octet-stream", new Uint8Array([0xe9, 0x05, 0x02, 0x20]));
      expect(savedFile!.name).toBe("slaprf-H1.bin");
      expect(savedFile!.mime).toBe("application/octet-stream");
      expect(atob(savedFile!.b64).charCodeAt(0)).toBe(0xe9);

      // Sidebar keeps #/flasher visible inside the Android app so users can flash timers over USB-C OTG
      const navRoot = mountHtml(`<aside></aside>`);
      const router = new Router();
      const sb = new Sidebar(navRoot.querySelector("aside")!, store, router);
      try {
        const flasherItems = navRoot.querySelectorAll<HTMLElement>('[data-route="flasher"]');
        expect(flasherItems.length > 0).toBe(true);
        expect(flasherItems[0].style.display).not.toBe("none");
      } finally {
        sb.destroy();
      }
    } finally {
      ann.stop();
      delete win.SlapRFAndroid;
    }
  });
});
