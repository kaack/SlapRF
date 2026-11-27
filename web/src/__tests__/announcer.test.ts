import { downloadBinaryFile, downloadTextFile } from "../core/android_bridge";
import { Router } from "../core/router";
import { Sidebar } from "../layout/Sidebar";
import {
  ANDROID_SYSTEM_VOICE_URI,
  Announcer,
  formatSpokenHeatLabel,
  lapCallout,
  spokenName,
} from "../services/announcer";
import { usbPool, type TimerStatus } from "../services/timer_console";
import {
  beforeEach,
  describe,
  expect,
  it,
  makeCrossing,
  makeGate,
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
  rejectWithNotAllowed: boolean;
  finishCurrentSpeech: () => void;
}

function installFakeSpeechAndAudio(): FakeAudioRig {
  const rig: FakeAudioRig = {
    oscillatorsStarted: [],
    spokenTexts: [],
    cancelCalls: 0,
    rejectWithNotAllowed: false,
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
          cancelScheduledValues: () => {},
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
      if (rig.rejectWithNotAllowed) {
        utt.onerror?.({ error: "not-allowed" } as unknown as SpeechSynthesisErrorEvent);
        return;
      }
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
        laprfEmulatorStatus: store.laprfEmulator,
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
        laprfEmulatorStatus: store.laprfEmulator,
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
        router.clearListeners();
      }
    } finally {
      ann.stop();
      delete win.SlapRFAndroid;
    }
  });

  it("bridges iOS WKWebView messageHandlers.slaprf and __slaprf_sync__ prompt calls", () => {
    window.localStorage.removeItem("gate-timer.announcer");
    installFakeSpeechAndAudio();
    const posted: Array<Record<string, unknown>> = [];
    const prefsMap = new Map<string, string>();
    let lanEnabled = false;
    let speaking = false;
    const origPrompt = window.prompt;
    const win = window as unknown as {
      webkit?: { messageHandlers?: { slaprf?: { postMessage(msg: unknown): void } } };
    };

    window.prompt = ((message?: string): string | null => {
      if (typeof message === "string" && message.startsWith("__slaprf_sync__:")) {
        const req = JSON.parse(message.slice("__slaprf_sync__:".length)) as Record<string, unknown>;
        switch (req.op) {
          case "getLanStatusJson":
            return JSON.stringify({
              enabled: lanEnabled,
              port: lanEnabled ? 8090 : 0,
              urls: lanEnabled ? ["http://192.168.1.44:8090"] : [],
            });
          case "setLanEnabled":
            lanEnabled = Boolean(req.enabled);
            return JSON.stringify({
              enabled: lanEnabled,
              port: lanEnabled ? 8090 : 0,
              urls: lanEnabled ? ["http://192.168.1.44:8090"] : [],
            });
          case "getStringPref":
            return prefsMap.get(String(req.key ?? "")) ?? "";
          case "isSpeaking":
            return speaking ? "1" : "0";
        }
      }
      return "";
    }) as typeof window.prompt;

    win.webkit = {
      messageHandlers: {
        slaprf: {
          postMessage(msg: unknown) {
            const m = msg as Record<string, unknown>;
            posted.push(m);
            if (m.op === "speak") speaking = true;
            if (m.op === "stopSpeech") speaking = false;
            if (m.op === "setStringPref") prefsMap.set(String(m.key ?? ""), String(m.value ?? ""));
          },
        },
      },
    };

    const store = makeStore({
      operatingMode: "practice",
      pilots: [makePilot(1, { callsign: "MAVERICK" })],
    });
    const ann = new Announcer(store);
    try {
      expect(ann.voices().some((v) => v.name === "iOS System Voice")).toBe(true);
      ann.update({ enabled: true });
      expect(posted.some((m) => m.op === "speak" && m.text === "Announcer on")).toBe(true);

      downloadTextFile("race.csv", "text/csv", "pilot,lap\nMAVERICK,12.34\n");
      const saveMsg = posted.find((m) => m.op === "saveBase64File");
      expect(saveMsg).toBeDefined();
      expect(saveMsg!.filename).toBe("race.csv");
      expect(atob(String(saveMsg!.base64Data))).toBe("pilot,lap\nMAVERICK,12.34\n");
    } finally {
      ann.stop();
      window.prompt = origPrompt;
      delete win.webkit;
    }
  });

  it("recovers from browser autoplay not-allowed errors on first click or single Announcer button press", () => {
    const rig = installFakeSpeechAndAudio();
    rig.rejectWithNotAllowed = true;

    const store = makeStore({
      operatingMode: "practice",
      pilots: [makePilot(1, { callsign: "FAERRY" })],
    });
    const ann = new Announcer(store);
    try {
      // Simulate a lap crossing while browser autoplay blocks speechSynthesis.speak with not-allowed
      store.ingestLap(makeLap(1, 1, 1, 12.45), []);
      expect(rig.spokenTexts).toEqual([]);

      // First user click anywhere on the page unlocks audio and replays the blocked lap callout
      rig.rejectWithNotAllowed = false;
      window.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(rig.spokenTexts).toEqual(["Faerry, 12.45"]);
    } finally {
      ann.stop();
    }

    const ann3 = new Announcer(store);
    try {
      // If a callout is blocked by autoplay and the user clicks the Announcer toggle button,
      // a single click wakes it ("Announcer on") instead of turning it off
      rig.spokenTexts.length = 0;
      rig.rejectWithNotAllowed = true;
      store.ingestLap(makeLap(2, 1, 2, 12.11), []);
      expect(rig.spokenTexts).toEqual([]);

      rig.rejectWithNotAllowed = false;
      ann3.toggleEnabledFromGesture();
      expect(ann3.settings.enabled).toBe(true);
      expect(rig.spokenTexts).toEqual(["Announcer on"]);
    } finally {
      ann3.stop();
    }
  });

  it("supports Off, Enter, Peak, and Exit crossing beep modes across all timers without double-beeping", () => {
    const rig = installFakeSpeechAndAudio();
    const store = makeStore({
      pilots: [
        makePilot(1, {
          callsign: "FAERRY",
          enabled: true,
          channel: 1,
          enterThreshold: -58,
          exitThreshold: -68,
        }),
      ],
      gates: [
        makeGate(1, {
          role: "START_FINISH",
          trackOrder: 1,
          assignedTimerId: 1,
          ruleOverrides: { beepMode: "off", beepOnCross: false },
        }),
        makeGate(2, { role: "SECTOR_GATE", trackOrder: 2, assignedTimerId: 2 }),
      ],
      rules: {
        minLapSec: 5,
        maxLapSec: 120,
        minCrossingSec: 0.12,
        beepOnCross: true,
        beepMode: "peak",
      },
    });
    const ann = new Announcer(store);
    try {
      const startIdx = rig.oscillatorsStarted.length;
      const nonKeepAwake = () => rig.oscillatorsStarted.slice(startIdx).filter((hz) => hz !== 440);

      // 1. Gate 1 overridden to "off" stays silent across a full pass
      store.ingestTelemetry({ timerId: 1, seqNum: 1, timestampUs: 1_000_000, rssi: [-85] });
      store.ingestTelemetry({ timerId: 1, seqNum: 2, timestampUs: 1_050_000, rssi: [-38] });
      store.ingestTelemetry({ timerId: 1, seqNum: 3, timestampUs: 1_200_000, rssi: [-72] });
      expect(nonKeepAwake()).toEqual([]);

      // 2. "peak" mode on Gate 2: silent on enter & climb, fires right as the signal crests (-32 dBm -> -34.6 dBm) BEFORE reaching exit (-68 dBm)!
      store.ingestTelemetry({ timerId: 2, seqNum: 1, timestampUs: 2_000_000, rssi: [-85] });
      store.ingestTelemetry({ timerId: 2, seqNum: 2, timestampUs: 2_040_000, rssi: [-54] }); // enter: silent
      store.ingestTelemetry({ timerId: 2, seqNum: 3, timestampUs: 2_080_000, rssi: [-41] }); // climbing: silent
      store.ingestTelemetry({ timerId: 2, seqNum: 4, timestampUs: 2_120_000, rssi: [-32] }); // apex over gate: silent
      store.ingestTelemetry({ timerId: 2, seqNum: 5, timestampUs: 2_140_000, rssi: [-33.1] }); // 1st falling sample: silent
      expect(nonKeepAwake()).toEqual([]);

      // 2nd falling sample (-34.6 dBm, 2.6 dB drop from -32 dBm peak, still 33.4 dB above -68 dBm exit!): fires peak beep immediately!
      store.ingestTelemetry({ timerId: 2, seqNum: 6, timestampUs: 2_160_000, rssi: [-34.6] });
      expect(nonKeepAwake()).toEqual([1479.98]);

      // Continuing to fly away and dropping below exit (-68 dBm) does NOT fire a second beep
      store.ingestTelemetry({ timerId: 2, seqNum: 7, timestampUs: 2_250_000, rssi: [-50] });
      store.ingestTelemetry({ timerId: 2, seqNum: 8, timestampUs: 2_380_000, rssi: [-71] });
      store.ingestCrossing(makeCrossing(2, 1, 2, 2_120_000, { isStartFinish: false }));
      expect(nonKeepAwake()).toEqual([1479.98]);

      // 3. "enter" mode: fires immediately on entry (-52 >= -58), silent at peak and exit
      store.hydrate({
        ...storeSnapshotMinimal(store),
        gates: [
          makeGate(1, { role: "START_FINISH", trackOrder: 1, assignedTimerId: 1 }),
          makeGate(2, { role: "SECTOR_GATE", trackOrder: 2, assignedTimerId: 2 }),
        ],
        rules: {
          minLapSec: 5,
          maxLapSec: 120,
          minCrossingSec: 0.12,
          beepOnCross: true,
          beepMode: "enter",
        },
      });
      store.ingestTelemetry({ timerId: 1, seqNum: 10, timestampUs: 4_000_000, rssi: [-52] });
      expect(nonKeepAwake().length).toBe(2);
      store.ingestTelemetry({ timerId: 1, seqNum: 11, timestampUs: 4_080_000, rssi: [-35] });
      store.ingestTelemetry({ timerId: 1, seqNum: 12, timestampUs: 4_200_000, rssi: [-72] });
      expect(nonKeepAwake().length).toBe(2);

      // 4. "exit" mode: silent on entry and peak, fires immediately on exit (-70 <= -68)
      store.hydrate({
        ...storeSnapshotMinimal(store),
        rules: {
          minLapSec: 5,
          maxLapSec: 120,
          minCrossingSec: 0.12,
          beepOnCross: true,
          beepMode: "exit",
        },
      });
      store.ingestTelemetry({ timerId: 2, seqNum: 20, timestampUs: 5_000_000, rssi: [-52] });
      store.ingestTelemetry({ timerId: 2, seqNum: 21, timestampUs: 5_080_000, rssi: [-35] });
      store.ingestTelemetry({ timerId: 2, seqNum: 22, timestampUs: 5_120_000, rssi: [-38] });
      expect(nonKeepAwake().length).toBe(2);

      store.ingestTelemetry({ timerId: 2, seqNum: 23, timestampUs: 5_240_000, rssi: [-70] });
      expect(nonKeepAwake().length).toBe(3);

      // 5. "peak" mode ignores shallow approach jitter lacking area-under-the-curve, then fires on the real pass peak!
      store.hydrate({
        ...storeSnapshotMinimal(store),
        rules: {
          minLapSec: 5,
          maxLapSec: 120,
          minCrossingSec: 0.12,
          beepOnCross: true,
          beepMode: "peak",
        },
      });
      // Approach ripple on Gate 2 (enter = -58, exit = -68): crosses to -54.8 dBm (+3.2 dB) for 100 ms (~0.18 dB*s),
      // then dips into the hysteresis band (-62 dBm) and even drops out (-70 dBm) — must NOT beep!
      store.ingestTelemetry({ timerId: 2, seqNum: 30, timestampUs: 7_000_000, rssi: [-74] });
      store.ingestTelemetry({ timerId: 2, seqNum: 31, timestampUs: 7_040_000, rssi: [-56.2] });
      store.ingestTelemetry({ timerId: 2, seqNum: 32, timestampUs: 7_080_000, rssi: [-54.8] });
      store.ingestTelemetry({ timerId: 2, seqNum: 33, timestampUs: 7_110_000, rssi: [-56.4] });
      store.ingestTelemetry({ timerId: 2, seqNum: 34, timestampUs: 7_140_000, rssi: [-62.0] });
      store.ingestTelemetry({ timerId: 2, seqNum: 35, timestampUs: 7_220_000, rssi: [-70.0] });
      expect(nonKeepAwake().length).toBe(3);

      // 2.0 s later, the real strong gate pass (-36 dBm) arrives and fires once right as the crest turns over!
      store.ingestTelemetry({ timerId: 2, seqNum: 36, timestampUs: 9_100_000, rssi: [-53] });
      store.ingestTelemetry({ timerId: 2, seqNum: 37, timestampUs: 9_150_000, rssi: [-42] });
      store.ingestTelemetry({ timerId: 2, seqNum: 38, timestampUs: 9_200_000, rssi: [-36] });
      store.ingestTelemetry({ timerId: 2, seqNum: 39, timestampUs: 9_225_000, rssi: [-37.2] });
      store.ingestTelemetry({ timerId: 2, seqNum: 40, timestampUs: 9_250_000, rssi: [-39.0] });
      expect(nonKeepAwake().length).toBe(4);

      // 6. AI detector mode: bypasses Classic enter/exit telemetry threshold gate so a -56 dBm 25mW pass
      //    on T2 (inside [-58..-68 dBm]) ALWAYS plays the crossing beep when AI confirms the crossing!
      store.ingestMLStatus({
        ...store.mlStatus,
        config: {
          ...store.mlStatus.config,
          detectorMode: "ai",
          activeModelId: "ai-base-v0",
          liveTuneEnabled: false,
        },
      });
      store.ingestTelemetry({ timerId: 2, seqNum: 50, timestampUs: 12_000_000, rssi: [-56.0] });
      store.ingestTelemetry({ timerId: 2, seqNum: 51, timestampUs: 12_280_000, rssi: [-62.0] });
      expect(nonKeepAwake().length).toBe(4); // Silent until AI crossing event arrives
      store.ingestCrossing(makeCrossing(99, 2, 1, 12_000_000, { isStartFinish: false }));
      expect(nonKeepAwake().length).toBe(5); // Plays immediately even while RSSI is -62 dBm!
    } finally {
      ann.stop();
    }
  });

  it("expands compact heat and Chase the Ace short codes into natural spoken phrases", () => {
    expect(formatSpokenHeatLabel({ id: "Q1-1", shortLabel: "Q1-H1" })).toBe(
      "Qualifying Round 1, Heat 1"
    );
    expect(formatSpokenHeatLabel({ id: "Q2-3", shortLabel: "Q2-H3" })).toBe(
      "Qualifying Round 2, Heat 3"
    );
    expect(formatSpokenHeatLabel({ id: "CTA-1", shortLabel: "CTA-G1" })).toBe(
      "Chase the Ace, Game 1"
    );
    expect(formatSpokenHeatLabel({ id: "W1-2", shortLabel: "W1-H2" })).toBe(
      "Winners Round 1, Heat 2"
    );
    expect(formatSpokenHeatLabel({ id: "L1-1", shortLabel: "L1-H1" })).toBe(
      "Redemption Round 1, Heat 1"
    );
    expect(formatSpokenHeatLabel({ id: "C1-1", shortLabel: "C-H1" })).toBe("C Main");
    expect(formatSpokenHeatLabel({ id: "GF-1", shortLabel: "GF-H1" })).toBe("Grand Final");
    expect(formatSpokenHeatLabel({ title: "Qualifying R2 · Heat 1" })).toBe(
      "Qualifying Round 2, Heat 1"
    );
  });
});

function storeSnapshotMinimal(store: ReturnType<typeof makeStore>) {
  return {
    serverTimestampUs: store.serverTimestampUs,
    timingHardwareMode: store.timingHardwareMode,
    pilots: store.pilots,
    gates: store.nodes,
    timers: store.timers,
    laps: store.laps,
    crossings: store.crossings,
    filtered: store.filtered,
    summaries: store.summaries,
    rules: store.rules,
    simulatorRunning: store.simulatorRunning,
    raceArmed: store.raceArmed,
    laprfEmulatorStatus: store.laprfEmulator,
    raceState: store.raceState,
    eventState: store.eventState,
    practiceState: store.practiceState,
  };
}
