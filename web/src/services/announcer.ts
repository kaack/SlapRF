import { setWakeLockEnabled } from "../core/wake_lock";
import { AppStore } from "../state/store";
import { GateCrossingEvent, LapRecord, RaceAnnouncement } from "../types/models";
import {
  DEFAULT_PIPER_VOICE_URI,
  getPiperVoice,
  isPiperVoiceURI,
  PIPER_VOICES,
  PiperNeuralTts,
  PiperVoiceDescriptor,
} from "./piper_tts";

export interface AnnouncerPrefs {
  enabled: boolean;
  qualifierLapCallouts: boolean;
  raceLapCallouts: boolean;
  keepScreenAwake: boolean;
  voiceURI: string;
  rate: number;
  volume: number;
  testPhrase?: string;
}

export function isQualifierStageFormat(stageFormat?: string): boolean {
  return stageFormat === "qualifying" || stageFormat === "open_qualifier";
}

const STORAGE_KEY = "gate-timer.announcer";
const PREFERRED_DEFAULT_VOICE = "Google US English";
const DEFAULT_PREFS: AnnouncerPrefs = {
  enabled: false,
  qualifierLapCallouts: true,
  raceLapCallouts: false,
  keepScreenAwake: true,
  voiceURI: PREFERRED_DEFAULT_VOICE,
  rate: 1.0,
  volume: 1,
  testPhrase: "",
};

/** Drop queued callouts older than this — a stale lap time is worse than none. */
const STALE_AFTER_MS = 8000;

/**
 * Chrome clips the start of an utterance spoken straight after speechSynthesis.cancel(),
 * so wait this long after cancelling before speaking again.
 */
const AFTER_CANCEL_MS = 120;
const BETWEEN_CALLOUTS_MS = 80;

/**
 * Level of the keep-awake tone: about −80 dBFS, far below anything audible through a PA,
 * but enough that Windows, Bluetooth and USB audio don't power the output down between
 * callouts (which is what swallows the first syllable of the pilot's name).
 */
const KEEP_AWAKE_GAIN = 0.0001;

/** Baylands Park / Bay Area inside-joke quips spoken when the track has been quiet for a while. */
const IDLE_EASTER_EGG_QUIPS = [
  "I am a member!",
  "Who crashed now...?",
  "Is the track clear?",
  "The geese don't even flinch anymore.",
  "Those geese have more track time than we do.",
];

/**
 * Rare quiet-track easter egg window: 3 to 7 minutes (180–420 s) of zero gate activity
 * while Timing and Announcer are on. Fires at most once per lull (requires real gate
 * activity before arming again) so it stays a genuine "wait, what did it just say?!" moment.
 */
const IDLE_MIN_MS = 3 * 60_000;
const IDLE_MAX_MS = 7 * 60_000;

/** "VANOVER" → "Vanover": stops some voices from spelling all-caps callsigns letter by letter. */
export function spokenName(callsign: string, phoneticName?: string): string {
  const phonetic = phoneticName?.trim();
  if (phonetic) return phonetic;
  const s = callsign.trim();
  if (!s) return s;
  // Preserve mixed-case names (e.g. "MeWo", "FreeLove") so TTS pronounces word boundaries naturally.
  if (s !== s.toUpperCase()) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** The whole callout: "Vanover, 14.08" (or "14.8" for `.80`, "14" for `.00`). */
export function lapCallout(callsign: string, lapTimeSec: number, phoneticName?: string): string {
  const formatted = lapTimeSec.toFixed(2).replace(/\.?0+$/, "");
  return `${spokenName(callsign, phoneticName)}, ${formatted}`;
}

/**
 * Speaks pilot name and lap time each time a lap is completed at the start / finish gate,
 * using the browser's built-in speech synthesis (works offline). Runs for the whole app,
 * independent of whichever view is on screen.
 */
export class Announcer {
  public readonly piper: PiperNeuralTts;
  private readonly store: AppStore;
  private prefs: AnnouncerPrefs;
  private readonly listeners = new Set<() => void>();
  private queue: Array<{ text: string; queuedAt: number; slotIndex?: number; maxAgeMs?: number }> = [];
  private current: SpeechSynthesisUtterance | null = null;
  private readonly liveUtterances = new Set<SpeechSynthesisUtterance>();
  private neuralSpeaking = false;
  private utteranceToken = 0;
  /** No speaking before this time (ms since epoch) — see AFTER_CANCEL_MS. */
  private holdUntil = 0;
  private holdTimer = 0;
  private idleTimer = 0;
  private quipSpokenInCurrentLull = false;
  private lastQuipIdx = -1;
  private lastSimMode: boolean | null = null;
  private lastRaceArmed: boolean | null = null;
  /** Inaudible tone that keeps the audio output awake while the announcer is on. */
  private keepAwake: AudioContext | null = null;
  private airhornBuffer: AudioBuffer | null = null;
  private airhornLoading: Promise<AudioBuffer | null> | null = null;
  private gestureUnlockBound = false;
  private utteranceWatchdog = 0;

  constructor(store: AppStore) {
    this.store = store;
    this.prefs = loadPrefs();
    setWakeLockEnabled(this.prefs.keepScreenAwake !== false);
    this.piper = new PiperNeuralTts(() => this.notify());
    if (this.prefs.enabled) {
      this.bindGestureAudioUnlock();
      const activeURI = this.activeVoiceURI();
      if (isPiperVoiceURI(activeURI)) {
        void this.piper.preloadVoice(activeURI).catch(() => undefined);
      }
      this.resetIdleTimer();
    }
    store.onLapRecorded((lap) => this.onLap(lap));
    store.onStartGateDetected((ev) => this.onStartPass(ev));
    store.onRaceAnnouncement((ann) => this.onRaceAnnouncement(ann));
    store.subscribe(["config"], () => this.notify());
    store.subscribe(["crossings"], () => {
      this.quipSpokenInCurrentLull = false;
      this.resetIdleTimer();
    });
    store.subscribe(["status"], () => {
      const simChanged = this.lastSimMode !== null && this.lastSimMode !== this.store.simulatorRunning;
      const armedChanged = this.lastRaceArmed !== null && this.lastRaceArmed !== this.store.raceArmed;
      if (simChanged) {
        this.clear();
      }
      this.lastSimMode = this.store.simulatorRunning;
      this.lastRaceArmed = this.store.raceArmed;
      if (simChanged || armedChanged) {
        this.resetIdleTimer();
      }
    });
    if ("speechSynthesis" in window) {
      speechSynthesis.addEventListener("voiceschanged", () => this.notify());
      // Prime speechSynthesis at boot: Chrome only starts fetching its network "Google ..."
      // voices after the first getVoices() call, and may populate local OS voices first before
      // adding remote Google voices a moment later.
      speechSynthesis.getVoices();
      let polls = 0;
      const pollId = window.setInterval(() => {
        polls++;
        const list = speechSynthesis.getVoices();
        if (list.some((v) => !v.localService) || polls >= 10) {
          window.clearInterval(pollId);
          this.notify();
        }
      }, 300);
    }
  }

  public get supported(): boolean {
    return true;
  }

  public get settings(): AnnouncerPrefs {
    return this.prefs;
  }

  public voices(): SpeechSynthesisVoice[] {
    if (!("speechSynthesis" in window)) return [];
    const all = speechSynthesis.getVoices();
    const english = all.filter((v) => /^en(?:[-_]|$)/i.test(v.lang));
    return english.length > 0 ? english : all;
  }

  public piperVoices(): PiperVoiceDescriptor[] {
    return PIPER_VOICES;
  }

  /**
   * Resolves the active voice URI:
   * 1. If the user explicitly selected a built-in Piper neural voice (`piper:...`), use it.
   * 2. If the user explicitly selected `"system"`, use the system default browser voice.
   * 3. If the user's preferred browser voice (defaulting to "Google US English") is present
   *    and available (either local or online), use it.
   * 4. Otherwise (e.g. inside Antigravity's browser, Edge/Firefox/Safari without "Google US English",
   *    or when offline at the flying field), automatically fall back to the built-in offline
   *    Piper neural voice (`piper:en_US-lessac-medium`).
   */
  public activeVoiceURI(): string {
    if (isPiperVoiceURI(this.prefs.voiceURI)) {
      return getPiperVoice(this.prefs.voiceURI).uri;
    }
    const list = this.voices();
    if (this.prefs.voiceURI === "system" && list.length > 0) {
      return "system";
    }
    const targetURI = this.prefs.voiceURI || PREFERRED_DEFAULT_VOICE;
    const match =
      list.find((v) => v.voiceURI === targetURI) ??
      list.find((v) => v.name.toLowerCase() === targetURI.toLowerCase());
    const online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
    if (match && (match.localService || online)) {
      return match.voiceURI;
    }
    return DEFAULT_PIPER_VOICE_URI;
  }

  /**
   * Resolves a browser SpeechSynthesisVoice (used when a browser voice is active, or as an
   * instant local fallback if the neural model is still downloading on the very first callout).
   */
  public resolveVoice(): SpeechSynthesisVoice | undefined {
    const list = this.voices();
    if (list.length === 0) return undefined;

    if (this.prefs.voiceURI && this.prefs.voiceURI !== "system") {
      const targetURI = this.prefs.voiceURI;
      const match =
        list.find((v) => v.voiceURI === targetURI) ??
        list.find((v) => v.name.toLowerCase() === targetURI.toLowerCase());

      const online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
      if (match && (match.localService || online)) {
        return match;
      }
    }

    return (
      list.find((v) => v.default && /^en/i.test(v.lang)) ??
      list.find((v) => v.localService && /^en[-_]US/i.test(v.lang)) ??
      list.find((v) => /^en/i.test(v.lang)) ??
      list[0]
    );
  }

  /** Enabling must happen from a click the first time (browser autoplay policy). */
  public update(next: Partial<AnnouncerPrefs>): void {
    const wasEnabled = this.prefs.enabled;
    const wasQualLapCallouts = this.prefs.qualifierLapCallouts;
    const wasRaceLapCallouts = this.prefs.raceLapCallouts;
    this.prefs = sanitizePrefs({ ...this.prefs, ...next });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.prefs));
    const liveHeat = this.getLiveRunningRaceHeat();
    if (liveHeat) {
      const isQual = isQualifierStageFormat(liveHeat.stageFormat);
      const turnedOff = isQual
        ? wasQualLapCallouts && !this.prefs.qualifierLapCallouts
        : wasRaceLapCallouts && !this.prefs.raceLapCallouts;
      if (turnedOff) {
        this.queue = this.queue.filter((item) => item.slotIndex === undefined);
      }
    }
    if (next.keepScreenAwake !== undefined) {
      setWakeLockEnabled(this.prefs.keepScreenAwake !== false);
    }
    const activeURI = this.activeVoiceURI();
    if (isPiperVoiceURI(activeURI) && (this.prefs.enabled || next.voiceURI !== undefined)) {
      void this.piper.preloadVoice(activeURI).catch(() => undefined);
    }
    if (!wasEnabled && this.prefs.enabled) {
      this.wakeAudio();
      this.say("Announcer on", true);
    }
    if (wasEnabled && !this.prefs.enabled) {
      this.say("Announcer off", true, true);
    }
    this.resetIdleTimer();
    this.notify();
  }

  public subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  public stop(): void {
    this.prefs.enabled = false;
    window.clearTimeout(this.idleTimer);
    this.idleTimer = 0;
    this.clear();
    this.holdUntil = 0;
  }

  /** Restores the voice, speed, volume, and sample phrase to system defaults without changing the on/off toggle. */
  public resetVoiceDefaults(): void {
    this.update({
      voiceURI: PREFERRED_DEFAULT_VOICE,
      rate: 1.0,
      volume: 1.0,
      testPhrase: "",
    });
  }

  /** Reloads announcer preferences from `localStorage` (used after JSON import or wipe). */
  public reloadPrefs(): void {
    this.prefs = loadPrefs();
    setWakeLockEnabled(this.prefs.keepScreenAwake !== false);
    if (this.prefs.enabled) {
      this.bindGestureAudioUnlock();
    } else {
      this.clear();
      this.sleepAudio();
    }
    this.resetIdleTimer();
    this.notify();
  }

  public defaultTestPhrase(): string {
    const pilot = this.store.enabledPilots[0];
    return lapCallout(pilot?.callsign ?? "Vanover", 14.08, pilot?.phoneticName);
  }

  public test(customPhrase?: string): void {
    this.wakeAudio();
    if (customPhrase !== undefined) {
      this.prefs = { ...this.prefs, testPhrase: customPhrase };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.prefs));
    }
    const raw = (customPhrase ?? this.prefs.testPhrase ?? "").trim();
    this.say(raw || this.defaultTestPhrase(), true, true);
  }

  /** Speaks a controller message aloud immediately on explicit user click (waking audio & bypassing mute). */
  public speakImmediate(phrase: string): void {
    const clean = (phrase ?? "").trim();
    if (!clean) return;
    this.wakeAudio();
    this.say(clean, true, true);
  }

  /** Returns true when spoken lap-time callouts are currently active for the given stage format. */
  public isLapCalloutsActiveForStage(stageFormat?: string): boolean {
    if (!this.prefs.enabled) return false;
    return isQualifierStageFormat(stageFormat)
      ? this.prefs.qualifierLapCallouts !== false
      : Boolean(this.prefs.raceLapCallouts);
  }

  /** Toggles spoken lap-time callouts for the given stage format when the master announcer is enabled. */
  public toggleLapCalloutsForStage(stageFormat?: string): void {
    if (!this.prefs.enabled) {
      return;
    }
    const isQual = isQualifierStageFormat(stageFormat);
    const nextOn = isQual
      ? !(this.prefs.qualifierLapCallouts !== false)
      : !this.prefs.raceLapCallouts;
    if (isQual) {
      this.update({ qualifierLapCallouts: nextOn });
    } else {
      this.update({ raceLapCallouts: nextOn });
    }
    this.wakeAudio();
    this.say(nextOn ? "Lap announcements on" : "Lap announcements off", true);
  }

  private getLiveRunningRaceHeat() {
    if (
      this.store.operatingMode === "practice" ||
      this.store.raceState?.lifecycle === "paused" ||
      Boolean(this.store.practiceState?.activeSessionId) ||
      (typeof window !== "undefined" && window.location.hash.startsWith("#/live"))
    ) {
      return null;
    }
    const heat = this.store.activeRaceHeat;
    if (heat && (heat.state === "countdown" || heat.state === "running")) {
      return heat;
    }
    const anyLive = this.store.raceState.heats.find(
      (h) => h.state === "countdown" || h.state === "running"
    );
    return anyLive ?? null;
  }

  private onLap(lap: LapRecord): void {
    const liveHeat = this.getLiveRunningRaceHeat();
    if (liveHeat) {
      // During an active race heat, strictly handle crossings for pilots racing in that heat.
      const seat = liveHeat.seats.find(
        (s) => s.pilotSlotIndex === lap.slotIndex && s.status !== "dns" && s.status !== "dq"
      );
      if (!seat) return;
      if (!this.prefs.enabled) return;
      this.playGatePassBeep(lap.slotIndex);
      const allowLapCallout = isQualifierStageFormat(liveHeat.stageFormat)
        ? this.prefs.qualifierLapCallouts !== false
        : Boolean(this.prefs.raceLapCallouts);
      if (!allowLapCallout) return;
    }
    const pilot = this.store.pilot(lap.slotIndex);
    const callsign = pilot?.callsign ?? lap.callsign;
    this.say(lapCallout(callsign, lap.lapTimeSec, pilot?.phoneticName), false, false, lap.slotIndex);
  }

  /**
   * When a pilot crosses the Start/Finish gate with no previous start pass to compare against
   * (initial holeshot or first pass after reset/timeout), call out just their name in practice,
   * or play an instant gate-pass confirmation beep during a live race heat.
   */
  private onStartPass(ev: GateCrossingEvent): void {
    const liveHeat = this.getLiveRunningRaceHeat();
    if (liveHeat) {
      if (!this.prefs.enabled) return;
      const inHeat = liveHeat.seats.some(
        (s) => s.pilotSlotIndex === ev.slotIndex && s.status !== "dns" && s.status !== "dq"
      );
      if (inHeat) {
        this.playGatePassBeep(ev.slotIndex);
      }
      return;
    }
    const pilot = this.store.pilot(ev.slotIndex);
    const callsign = pilot?.callsign ?? ev.callsign;
    this.say(spokenName(callsign, pilot?.phoneticName), false, false, ev.slotIndex);
  }

  private onRaceAnnouncement(ann: RaceAnnouncement): void {
    if (!this.prefs.enabled) return;
    const pilot = ann.slotIndex ? this.store.pilot(ann.slotIndex) : undefined;
    const name = ann.callsign ? spokenName(ann.callsign, pilot?.phoneticName) : "";
    switch (ann.kind) {
      case "countdown_start":
        this.say("Pilots, arm your quads", true);
        break;
      case "countdown_prompt": {
        const sec = ann.countdownSec && ann.countdownSec > 0 ? ann.countdownSec : 5;
        this.say(`In less than ${sec}`, false);
        break;
      }
      case "countdown_cancel":
        this.clear();
        break;
      case "start_horn":
        this.clear();
        this.playLongStartBeep();
        break;
      case "holeshot":
        if (name) {
          this.say(`Holeshot ${name}`);
        }
        break;
      case "pilot_last_lap":
        if (name) {
          const pending =
            ann.slotIndex !== undefined
              ? this.queue.find((item) => item.slotIndex === ann.slotIndex)
              : undefined;
          if (pending && !pending.text.toLowerCase().includes("last lap")) {
            pending.text = `${pending.text}, last lap`;
          } else {
            this.say(`${name}, last lap`, false, false, ann.slotIndex);
          }
        }
        break;
      case "pilot_finished": {
        const activeHeat = this.store.activeRaceHeat;
        const isCompetitive =
          ann.competitive !== undefined
            ? ann.competitive
            : Boolean(
                activeHeat &&
                  activeHeat.startMode === "heads_up" &&
                  activeHeat.stageFormat !== "qualifying" &&
                  activeHeat.stageFormat !== "open_qualifier"
              );
        if (isCompetitive && ann.position === 1) {
          if (ann.slotIndex !== undefined) {
            this.queue = this.queue.filter((item) => item.slotIndex !== ann.slotIndex);
          }
          this.playWinnerHorn();
          this.holdUntil = Math.max(this.holdUntil, Date.now() + 660);
          if (name) {
            this.say(`${name} finishes 1st`, false, false, ann.slotIndex, true);
          }
          break;
        }
        const ord =
          ann.position === 1
            ? "1st"
            : ann.position === 2
              ? "2nd"
              : ann.position === 3
                ? "3rd"
                : ann.position && ann.position > 3
                  ? `${ann.position}th`
                  : "";
        if (name) {
          this.say(
            isCompetitive && ord ? `${name} finishes ${ord}` : `${name} finished`,
            false,
            false,
            ann.slotIndex
          );
        }
        break;
      }
      case "pilot_dnf":
        if (name) {
          this.say(`${name} is out`, false, false, ann.slotIndex);
        }
        break;
      case "overtime":
        this.clear();
        this.playHeatEndAirhorn();
        window.setTimeout(() => {
          this.say("Time expired, finish your lap and land");
        }, 1650);
        break;
      case "heat_finished":
        if (ann.timedOut) {
          this.clear();
        }
        if (ann.hornAlreadySounded) {
          this.say("Heat complete");
        } else {
          this.playHeatEndAirhorn();
          window.setTimeout(() => {
            this.say(ann.timedOut ? "Time expired, land safely" : "Race complete, land safely");
          }, 1650);
        }
        break;
      case "emergency_stop":
        this.playTone(523.25, 0.25, 0.38);
        this.say("Emergency stop! Land immediately!", true);
        break;
      case "champion":
        if (name) {
          this.say(`${name} wins the tournament!`);
        }
        break;
    }
  }

  /** Crisp ~68 ms Start/Finish gate-pass confirmation pip during live race heats. */
  private playGatePassBeep(slotIndex = 1): void {
    this.wakeAudio();
    const ctx = this.keepAwake;
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const slotIdx = Math.max(0, Math.min(7, (slotIndex || 1) - 1));
      const freqHz = 1046.5 * Math.pow(2, (slotIdx * 35) / 1200);
      const dur = 0.068;
      const vol = Math.max(0.03, Math.min(1, this.prefs.volume)) * 0.24;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(vol, now + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      g.connect(ctx.destination);

      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freqHz, now);
      osc.connect(g);
      osc.start(now);
      osc.stop(now + dur + 0.015);
    } catch {
      // Ignore AudioContext scheduling errors
    }
  }

  private playTone(freqHz: number, durationSec: number, gainPeak = 0.25): void {
    this.wakeAudio();
    const ctx = this.keepAwake;
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freqHz, now);
      const vol = Math.max(0.02, Math.min(1, this.prefs.volume)) * gainPeak;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(vol, now + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);
      osc.connect(g).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + durationSec + 0.02);
    } catch {
      // Ignore AudioContext scheduling errors
    }
  }

  /** Bold, sustained ~0.95s race start beep so pilots on the line never miss the horn. */
  private playLongStartBeep(): void {
    this.wakeAudio();
    const ctx = this.keepAwake;
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const baseVol = Math.max(0.04, Math.min(1, this.prefs.volume));
      const master = ctx.createGain();
      master.gain.setValueAtTime(0.0001, now);
      master.gain.linearRampToValueAtTime(baseVol * 0.42, now + 0.015);
      master.gain.setValueAtTime(baseVol * 0.42, now + 0.88);
      master.gain.exponentialRampToValueAtTime(0.0001, now + 0.96);
      master.connect(ctx.destination);

      const osc1 = ctx.createOscillator();
      osc1.type = "sawtooth";
      osc1.frequency.setValueAtTime(987.77, now);
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(2400, now);
      osc1.connect(filter).connect(master);

      const osc2 = ctx.createOscillator();
      osc2.type = "triangle";
      osc2.frequency.setValueAtTime(987.77, now);
      osc2.connect(master);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 0.98);
      osc2.stop(now + 0.98);
    } catch {
      // Ignore AudioContext scheduling errors
    }
  }

  /** Celebratory dual-hit stadium horn for the 1st-place finisher in competitive heats, followed by their finish callout. */
  private playWinnerHorn(): void {
    this.wakeAudio();
    const ctx = this.keepAwake;
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const baseVol = Math.max(0.04, Math.min(1, this.prefs.volume));
      const notes = [
        { start: 0.0, dur: 0.14, freqs: [523.25, 659.25, 783.99] },
        { start: 0.18, dur: 0.46, freqs: [587.33, 739.99, 880.0] },
      ];
      for (const n of notes) {
        const t0 = now + n.start;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(baseVol * 0.22, t0 + 0.018);
        g.gain.setValueAtTime(baseVol * 0.20, t0 + Math.max(0.03, n.dur - 0.07));
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.dur);

        const lpf = ctx.createBiquadFilter();
        lpf.type = "lowpass";
        lpf.frequency.setValueAtTime(2200, t0);
        lpf.connect(g).connect(ctx.destination);

        for (const f of n.freqs) {
          const osc = ctx.createOscillator();
          osc.type = "sawtooth";
          osc.frequency.setValueAtTime(f, t0);
          osc.connect(lpf);
          osc.start(t0);
          osc.stop(t0 + n.dur + 0.02);
        }
      }
    } catch {
      // Ignore AudioContext scheduling errors
    }
  }

  /**
   * Plays the recorded airhorn sample (`./sounds/airhorn.wav`, ~1.61 s) when a heat finishes
   * on time expiration, enters overtime, or is manually stopped.
   */
  public playHeatEndAirhorn(): void {
    this.wakeAudio();
    const ctx = this.keepAwake;
    if (!ctx) return;
    const playBuf = (buf: AudioBuffer) => {
      try {
        const src = ctx.createBufferSource();
        const gain = ctx.createGain();
        src.buffer = buf;
        // Sample peak is ~0.58; 1.45x brings 100% volume to ~0.84 peak without clipping.
        const baseVol = Math.max(0.06, Math.min(1, this.prefs.volume));
        gain.gain.setValueAtTime(baseVol * 1.45, ctx.currentTime);
        src.connect(gain).connect(ctx.destination);
        src.start();
      } catch {
        // Ignore AudioContext scheduling errors
      }
    };
    if (this.airhornBuffer) {
      playBuf(this.airhornBuffer);
      return;
    }
    void this.ensureAirhornBuffer(ctx).then((buf) => {
      if (buf) playBuf(buf);
    });
  }

  private ensureAirhornBuffer(ctx: AudioContext): Promise<AudioBuffer | null> {
    if (this.airhornBuffer) return Promise.resolve(this.airhornBuffer);
    if (this.airhornLoading) return this.airhornLoading;
    this.airhornLoading = fetch("./sounds/airhorn.wav")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((raw) => ctx.decodeAudioData(raw))
      .then((buf) => {
        this.airhornBuffer = buf;
        return buf;
      })
      .catch(() => {
        this.airhornLoading = null;
        return null;
      });
    return this.airhornLoading;
  }

  // ---- speech queue --------------------------------------------------------

  private say(
    text: string,
    interrupt = false,
    force = false,
    slotIndex?: number,
    priorityFront = false
  ): void {
    if ((!this.prefs.enabled && !force) || !this.supported) return;
    if (interrupt) this.clear();
    // If a newer lap/crossing arrives for a pilot who still has an unspoken callout waiting in the
    // queue, replace the older queued callout so we never announce two laps back-to-back for the same pilot.
    if (slotIndex !== undefined) {
      this.queue = this.queue.filter((item) => item.slotIndex !== slotIndex);
    }
    const maxAgeMs =
      force || priorityFront ? 45_000 : Math.max(STALE_AFTER_MS, text.length * 160);
    const entry = { text, queuedAt: Date.now(), slotIndex, maxAgeMs };
    if (priorityFront) {
      this.queue.unshift(entry);
    } else {
      this.queue.push(entry);
    }
    this.resetIdleTimer();
    this.pump();
  }

  private resetIdleTimer(): void {
    window.clearTimeout(this.idleTimer);
    this.idleTimer = 0;
    if (
      !this.prefs.enabled ||
      !this.store.raceArmed ||
      !this.supported ||
      this.quipSpokenInCurrentLull
    ) {
      return;
    }
    const delayMs = IDLE_MIN_MS + Math.floor(Math.random() * (IDLE_MAX_MS - IDLE_MIN_MS));
    this.idleTimer = window.setTimeout(() => this.speakIdleQuip(), delayMs);
  }

  private speakIdleQuip(): void {
    this.idleTimer = 0;
    if (
      !this.prefs.enabled ||
      !this.store.raceArmed ||
      !this.supported ||
      this.quipSpokenInCurrentLull
    ) {
      return;
    }
    this.quipSpokenInCurrentLull = true;
    let idx = Math.floor(Math.random() * IDLE_EASTER_EGG_QUIPS.length);
    if (IDLE_EASTER_EGG_QUIPS.length > 1 && idx === this.lastQuipIdx) {
      idx = (idx + 1) % IDLE_EASTER_EGG_QUIPS.length;
    }
    this.lastQuipIdx = idx;
    this.say(IDLE_EASTER_EGG_QUIPS[idx]);
  }

  private clear(): void {
    this.queue = [];
    const hadBrowserUtterance = this.current !== null;
    this.current = null;
    this.liveUtterances.clear();
    this.neuralSpeaking = false;
    this.utteranceToken++;
    window.clearTimeout(this.utteranceWatchdog);
    this.utteranceWatchdog = 0;
    window.clearTimeout(this.holdTimer);
    this.holdTimer = 0;
    this.piper.stop();
    if ("speechSynthesis" in window) {
      if (speechSynthesis.paused) {
        speechSynthesis.resume();
      }
      if (hadBrowserUtterance || speechSynthesis.speaking || speechSynthesis.pending) {
        speechSynthesis.cancel();
        this.holdUntil = Date.now() + AFTER_CANCEL_MS;
      }
    }
  }

  /** Speak queued callouts one at a time, skipping any that went stale while waiting. */
  private pump(): void {
    if (this.current || this.neuralSpeaking) return;
    const wait = this.holdUntil - Date.now();
    if (wait > 0) {
      window.clearTimeout(this.holdTimer);
      this.holdTimer = window.setTimeout(() => this.pump(), wait);
      return;
    }
    let next = this.queue.shift();
    while (next && Date.now() - next.queuedAt > (next.maxAgeMs ?? STALE_AFTER_MS)) next = this.queue.shift();
    if (!next) return;

    const maxAgeMs = next.maxAgeMs ?? STALE_AFTER_MS;
    this.wakeAudio();
    const activeURI = this.activeVoiceURI();

    if (isPiperVoiceURI(activeURI) && this.keepAwake) {
      if (this.keepAwake.state === "suspended") {
        void this.keepAwake.resume().catch(() => undefined);
      }
      if (this.keepAwake.state === "running") {
        const token = ++this.utteranceToken;
        this.neuralSpeaking = true;
        const finishNeural = () => {
          if (this.utteranceToken !== token) return;
          this.neuralSpeaking = false;
          if (!this.prefs.enabled && this.queue.length === 0) {
            this.sleepAudio();
            return;
          }
          this.holdUntil = Math.max(this.holdUntil, Date.now() + BETWEEN_CALLOUTS_MS);
          this.pump();
        };

        void this.piper
          .speak(
            next.text,
            activeURI,
            this.prefs.rate,
            this.prefs.volume,
            this.keepAwake,
            next.queuedAt,
            maxAgeMs
          )
          .then(finishNeural)
          .catch(() => {
            if (this.utteranceToken !== token) return;
            this.neuralSpeaking = false;
            if (Date.now() - next!.queuedAt <= maxAgeMs) {
              this.speakBrowserUtterance(next!.text);
            } else {
              this.pump();
            }
          });
        return;
      }
    }

    this.speakBrowserUtterance(next.text);
  }

  private speakBrowserUtterance(text: string): void {
    if (!("speechSynthesis" in window)) return;
    const cleaned = text
      .replace(/\s*·\s*/g, ", ")
      .replace(/\b(\d+)\.00\b/g, "$1")
      .replace(/\b(\d+)\.([1-9])0\b/g, "$1.$2");
    const utterance = new SpeechSynthesisUtterance(cleaned);
    // Keep a strong reference until onend/onerror so V8 GC never collects long multi-pilot utterances mid-speech!
    this.liveUtterances.add(utterance);
    const voice = this.resolveVoice();
    if (voice) {
      try {
        utterance.voice = voice;
      } catch {
        // Ignore non-native SpeechSynthesisVoice mocks in headless test environments
      }
      if (voice.lang) {
        utterance.lang = voice.lang;
      }
    }
    utterance.rate = this.prefs.rate;
    utterance.volume = this.prefs.volume;

    const done = () => {
      this.liveUtterances.delete(utterance);
      if (this.current !== utterance) return; // superseded by clear()
      window.clearTimeout(this.utteranceWatchdog);
      this.utteranceWatchdog = 0;
      this.current = null;
      if (!this.prefs.enabled && this.queue.length === 0) {
        this.sleepAudio();
        return;
      }
      // Back-to-back callouts (a pack crossing together) also clip on some Windows voices
      // when started the instant the previous one ends; a short breath avoids it.
      this.holdUntil = Math.max(this.holdUntil, Date.now() + BETWEEN_CALLOUTS_MS);
      this.pump();
    };
    utterance.onend = done;
    utterance.onerror = done;
    this.current = utterance;
    window.clearTimeout(this.utteranceWatchdog);
    const watchdogMs = Math.max(24_000, cleaned.length * 240);
    this.utteranceWatchdog = window.setTimeout(() => {
      if (this.current === utterance) {
        if ("speechSynthesis" in window) {
          speechSynthesis.cancel();
        }
        done();
      }
    }, watchdogMs);
    if (speechSynthesis.paused) {
      speechSynthesis.resume();
    }
    speechSynthesis.speak(utterance);
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn());
  }

  /**
   * Play an inaudible tone for as long as the announcer is on. Many audio paths (Windows
   * power saving, Bluetooth speakers, USB interfaces into a PA) go to sleep after a second or
   * two of silence and take a few hundred ms to wake — long enough to eat the start of
   * "Vanover". Must be called from a user gesture the first time.
   */
  private wakeAudio(): void {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    if (!this.keepAwake) {
      const ctx = new Ctx();
      const tone = ctx.createOscillator();
      const gain = ctx.createGain();
      tone.frequency.value = 440;
      gain.gain.value = KEEP_AWAKE_GAIN;
      tone.connect(gain).connect(ctx.destination);
      tone.start();
      this.keepAwake = ctx;
    }
    void this.keepAwake.resume();
    void this.ensureAirhornBuffer(this.keepAwake);
  }

  private sleepAudio(): void {
    void this.keepAwake?.suspend();
  }

  /**
   * When the announcer is restored as enabled across a page reload, browsers may start
   * `AudioContext` in a `"suspended"` state until the first pointer/key gesture on the page.
   * Bind a one-shot listener so any click, tap, or keypress immediately unlocks audio output.
   */
  private bindGestureAudioUnlock(): void {
    if (this.gestureUnlockBound || typeof window === "undefined") return;
    this.gestureUnlockBound = true;
    const unlock = () => {
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
      this.gestureUnlockBound = false;
      if (this.prefs.enabled) {
        this.wakeAudio();
      }
    };
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
  }
}

function sanitizePrefs(raw: unknown): AnnouncerPrefs {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_PREFS };
  }
  const obj = raw as Record<string, unknown>;
  const rateNum = typeof obj.rate === "number" ? obj.rate : Number(obj.rate);
  const volNum = typeof obj.volume === "number" ? obj.volume : Number(obj.volume);
  return {
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : DEFAULT_PREFS.enabled,
    qualifierLapCallouts:
      typeof obj.qualifierLapCallouts === "boolean"
        ? obj.qualifierLapCallouts
        : DEFAULT_PREFS.qualifierLapCallouts,
    raceLapCallouts:
      typeof obj.raceLapCallouts === "boolean"
        ? obj.raceLapCallouts
        : DEFAULT_PREFS.raceLapCallouts,
    keepScreenAwake:
      typeof obj.keepScreenAwake === "boolean"
        ? obj.keepScreenAwake
        : DEFAULT_PREFS.keepScreenAwake,
    voiceURI:
      typeof obj.voiceURI === "string" && obj.voiceURI.trim() !== ""
        ? obj.voiceURI
        : DEFAULT_PREFS.voiceURI,
    rate:
      Number.isFinite(rateNum) && rateNum >= 0.8 && rateNum <= 1.6
        ? rateNum
        : DEFAULT_PREFS.rate,
    volume:
      Number.isFinite(volNum) && volNum >= 0 && volNum <= 1
        ? volNum
        : DEFAULT_PREFS.volume,
    testPhrase:
      typeof obj.testPhrase === "string" ? obj.testPhrase : DEFAULT_PREFS.testPhrase,
  };
}

function loadPrefs(): AnnouncerPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizePrefs(JSON.parse(raw)) : { ...DEFAULT_PREFS };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}
