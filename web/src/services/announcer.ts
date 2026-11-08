import { AppStore } from "../state/store";
import { LapRecord } from "../types/models";

export interface AnnouncerPrefs {
  enabled: boolean;
  voiceURI: string;
  rate: number;
  volume: number;
}

const STORAGE_KEY = "gate-timer.announcer";
const PREFERRED_DEFAULT_VOICE = "Google US English";
const DEFAULT_PREFS: AnnouncerPrefs = {
  enabled: false,
  voiceURI: PREFERRED_DEFAULT_VOICE,
  rate: 1.1,
  volume: 1,
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
  private readonly store: AppStore;
  private prefs: AnnouncerPrefs;
  private readonly listeners = new Set<() => void>();
  private queue: Array<{ text: string; queuedAt: number }> = [];
  private current: SpeechSynthesisUtterance | null = null;
  /** No speaking before this time (ms since epoch) — see AFTER_CANCEL_MS. */
  private holdUntil = 0;
  private holdTimer = 0;
  private lastSimMode: boolean | null = null;
  /** Inaudible tone that keeps the audio output awake while the announcer is on. */
  private keepAwake: AudioContext | null = null;

  constructor(store: AppStore) {
    this.store = store;
    this.prefs = loadPrefs();
    store.onLapRecorded((lap) => this.onLap(lap));
    store.subscribe(["status"], () => {
      if (this.lastSimMode !== null && this.lastSimMode !== this.store.simulatorRunning) {
        this.clear();
      }
      this.lastSimMode = this.store.simulatorRunning;
    });
    if (this.supported) {
      speechSynthesis.addEventListener("voiceschanged", () => this.notify());
    }
  }

  public get supported(): boolean {
    return "speechSynthesis" in window;
  }

  public get settings(): AnnouncerPrefs {
    return this.prefs;
  }

  public voices(): SpeechSynthesisVoice[] {
    return this.supported ? speechSynthesis.getVoices() : [];
  }

  /**
   * Resolves the active voice: prefers the user's choice (defaulting to "Google US English"),
   * and falls back to a local en-US system voice if the browser isn't Chrome or is offline
   * at the field (since Chrome's "Google US English" requires an internet connection).
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

    // Fallback when offline or on Edge/Safari where "Google US English" isn't installed:
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
    if (!wasEnabled && this.prefs.enabled) {
      this.wakeAudio();
      this.say("Announcer on");
    }
    if (wasEnabled && !this.prefs.enabled) {
      this.clear();
      this.sleepAudio();
    }
    this.notify();
  }

  public subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  public test(): void {
    this.wakeAudio();
    const pilot = this.store.enabledPilots[0];
    this.say(lapCallout(pilot?.callsign ?? "Pilot", 14.08), true);
  }

  private onLap(lap: LapRecord): void {
    const callsign = this.store.pilot(lap.slotIndex)?.callsign ?? lap.callsign;
    this.say(lapCallout(callsign, lap.lapTimeSec));
  }

  // ---- speech queue --------------------------------------------------------

  private say(text: string, interrupt = false): void {
    if (!this.prefs.enabled || !this.supported) return;
    if (interrupt) this.clear();
    this.queue.push({ text, queuedAt: Date.now() });
    this.pump();
  }

  private clear(): void {
    this.queue = [];
    this.current = null;
    if (this.supported && (speechSynthesis.speaking || speechSynthesis.pending)) {
      speechSynthesis.cancel();
      this.holdUntil = Date.now() + AFTER_CANCEL_MS;
    }
  }

  /** Speak queued callouts one at a time, skipping any that went stale while waiting. */
  private pump(): void {
    if (this.current) return;
    const wait = this.holdUntil - Date.now();
    if (wait > 0) {
      window.clearTimeout(this.holdTimer);
      this.holdTimer = window.setTimeout(() => this.pump(), wait);
      return;
    }
    let next = this.queue.shift();
    while (next && Date.now() - next.queuedAt > STALE_AFTER_MS) next = this.queue.shift();
    if (!next) return;

    // Belt and braces: make sure the output is awake (a suspended context resumes here).
    void this.keepAwake?.resume();

    const utterance = new SpeechSynthesisUtterance(next.text);
    const voice = this.resolveVoice();
    if (voice) utterance.voice = voice;
    utterance.rate = this.prefs.rate;
    utterance.volume = this.prefs.volume;

    const done = () => {
      if (this.current !== utterance) return; // superseded by clear()
      this.current = null;
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
