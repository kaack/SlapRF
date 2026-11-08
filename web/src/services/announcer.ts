import { AppStore } from "../state/store";
import { GateCrossingEvent, LapRecord } from "../types/models";
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
  voiceURI: string;
  rate: number;
  volume: number;
  testPhrase?: string;
}

const STORAGE_KEY = "gate-timer.announcer";
const PREFERRED_DEFAULT_VOICE = "Google US English";
const DEFAULT_PREFS: AnnouncerPrefs = {
  enabled: false,
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
export function spokenName(callsign: string): string {
  const s = callsign.trim();
  if (!s) return s;
  // Preserve mixed-case names (e.g. "MeWo", "FreeLove") so TTS pronounces word boundaries naturally.
  if (s !== s.toUpperCase()) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** The whole callout: "Vanover, 14.08". Short enough to keep up with a busy start gate. */
export function lapCallout(callsign: string, lapTimeSec: number): string {
  return `${spokenName(callsign)}, ${lapTimeSec.toFixed(2)}`;
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
  private queue: Array<{ text: string; queuedAt: number }> = [];
  private current: SpeechSynthesisUtterance | null = null;
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

  constructor(store: AppStore) {
    this.store = store;
    this.prefs = loadPrefs();
    this.piper = new PiperNeuralTts(() => this.notify());
    store.onLapRecorded((lap) => this.onLap(lap));
    store.onStartGateDetected((ev) => this.onStartPass(ev));
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
    return "speechSynthesis" in window ? speechSynthesis.getVoices() : [];
  }

  public piperVoices(): PiperVoiceDescriptor[] {
    return PIPER_VOICES;
  }

  /**
   * Resolves the active voice URI:
   * 1. If the user explicitly selected a built-in Piper neural voice (`piper:...`), use it.
   * 2. If the user's preferred browser voice (defaulting to "Google US English") is present
   *    and available (either local or online), use it.
   * 3. Otherwise (e.g. inside Antigravity's browser, Edge/Firefox/Safari without "Google US English",
   *    or when offline at the flying field), automatically fall back to the built-in offline
   *    Piper neural voice (`piper:en_US-hfc_female-medium`).
   */
  public activeVoiceURI(): string {
    if (isPiperVoiceURI(this.prefs.voiceURI)) {
      return getPiperVoice(this.prefs.voiceURI).uri;
    }
    const list = this.voices();
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

    const targetURI = this.prefs.voiceURI || PREFERRED_DEFAULT_VOICE;
    const match =
      list.find((v) => v.voiceURI === targetURI) ??
      list.find((v) => v.name.toLowerCase() === targetURI.toLowerCase());

    const online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
    if (match && (match.localService || online)) {
      return match;
    }

    return (
      list.find((v) => v.localService && /^en[-_]US/i.test(v.lang)) ??
      list.find((v) => /^en/i.test(v.lang)) ??
      list[0]
    );
  }

  /** Enabling must happen from a click the first time (browser autoplay policy). */
  public update(next: Partial<AnnouncerPrefs>): void {
    const wasEnabled = this.prefs.enabled;
    this.prefs = { ...this.prefs, ...next };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.prefs));
    const activeURI = this.activeVoiceURI();
    if (isPiperVoiceURI(activeURI) && (this.prefs.enabled || next.voiceURI !== undefined)) {
      void this.piper.preloadVoice(activeURI).catch(() => undefined);
    }
    if (!wasEnabled && this.prefs.enabled) {
      this.wakeAudio();
      this.say("Announcer on");
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

  public defaultTestPhrase(): string {
    const pilot = this.store.enabledPilots[0];
    return lapCallout(pilot?.callsign ?? "Vanover", 14.08);
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

  private onLap(lap: LapRecord): void {
    const callsign = this.store.pilot(lap.slotIndex)?.callsign ?? lap.callsign;
    this.say(lapCallout(callsign, lap.lapTimeSec));
  }

  /**
   * When a pilot crosses the Start/Finish gate with no previous start pass to compare against
   * (initial holeshot or first pass after reset/timeout), call out just their name so they know
   * the gate detected them and started their clock.
   */
  private onStartPass(ev: GateCrossingEvent): void {
    const callsign = this.store.pilot(ev.slotIndex)?.callsign ?? ev.callsign;
    this.say(spokenName(callsign));
  }

  // ---- speech queue --------------------------------------------------------

  private say(text: string, interrupt = false, force = false): void {
    if ((!this.prefs.enabled && !force) || !this.supported) return;
    if (interrupt) this.clear();
    this.queue.push({ text, queuedAt: Date.now() });
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
    this.current = null;
    this.neuralSpeaking = false;
    this.utteranceToken++;
    this.piper.stop();
    if ("speechSynthesis" in window && (speechSynthesis.speaking || speechSynthesis.pending)) {
      speechSynthesis.cancel();
      this.holdUntil = Date.now() + AFTER_CANCEL_MS;
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
    while (next && Date.now() - next.queuedAt > STALE_AFTER_MS) next = this.queue.shift();
    if (!next) return;

    this.wakeAudio();
    const activeURI = this.activeVoiceURI();

    if (isPiperVoiceURI(activeURI) && this.keepAwake) {
      const token = ++this.utteranceToken;
      this.neuralSpeaking = true;
      const finishNeural = () => {
        if (this.utteranceToken !== token) return;
        this.neuralSpeaking = false;
        if (!this.prefs.enabled && this.queue.length === 0) {
          this.sleepAudio();
          return;
        }
        this.holdUntil = Date.now() + BETWEEN_CALLOUTS_MS;
        this.pump();
      };

      void this.piper
        .speak(next.text, activeURI, this.prefs.rate, this.prefs.volume, this.keepAwake)
        .then(finishNeural)
        .catch(() => {
          if (this.utteranceToken !== token) return;
          this.neuralSpeaking = false;
          this.speakBrowserUtterance(next!.text);
        });
      return;
    }

    this.speakBrowserUtterance(next.text);
  }

  private speakBrowserUtterance(text: string): void {
    if (!("speechSynthesis" in window)) return;
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = this.resolveVoice();
    if (voice) utterance.voice = voice;
    utterance.rate = this.prefs.rate;
    utterance.volume = this.prefs.volume;

    const done = () => {
      if (this.current !== utterance) return; // superseded by clear()
      this.current = null;
      if (!this.prefs.enabled && this.queue.length === 0) {
        this.sleepAudio();
        return;
      }
      // Back-to-back callouts (a pack crossing together) also clip on some Windows voices
      // when started the instant the previous one ends; a short breath avoids it.
      this.holdUntil = Date.now() + BETWEEN_CALLOUTS_MS;
      this.pump();
    };
    utterance.onend = done;
    utterance.onerror = done;
    this.current = utterance;
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
  }

  private sleepAudio(): void {
    void this.keepAwake?.suspend();
  }
}

function loadPrefs(): AnnouncerPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // Never auto-enable on load: speech needs a fresh user gesture after a reload.
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw), enabled: false } : { ...DEFAULT_PREFS };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}
