import { getAndroidBridge } from "../core/android_bridge";
import { setWakeLockEnabled } from "../core/wake_lock";
import { capabilitiesSnapshot, isServerDisconnectedLockout } from "../services/capabilities";
import {
  enterThresholdAt,
  exitThresholdAt,
  gateRulesAt,
  hasAnyBeepOnCrossConfigured,
  pilotGateRulesAt,
  resolveCrossingBeepMode,
} from "../state/selectors";
import { AppStore } from "../state/store";
import {
  GateCrossingEvent,
  LapRecord,
  RaceAnnouncement,
  TimerTelemetryFrame,
} from "../types/models";
import {
  ensureCrossingBeepGestureUnlock,
  playShortCrossingBeep,
  warmCrossingBeepAudio,
} from "./crossing_beep";
import { sharedLapRFLink } from "./laprf_hardware_link";
import {
  DEFAULT_PIPER_VOICE_URI,
  getPiperVoice,
  isPiperVoiceURI,
  PIPER_VOICES,
  PiperNeuralTts,
  PiperVoiceDescriptor,
} from "./piper_tts";
import { sharedRHLink } from "./rh_hardware_link";
import { usbPool } from "./timer_console";

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

export function resolveHeatStageFormat(
  heat: { stageFormat?: string; roundId?: string } | null | undefined,
  race?: { rounds?: Array<{ id: string; stageFormat?: string }> } | null
): string {
  if (!heat) return "";
  if (heat.stageFormat) return heat.stageFormat;
  if (heat.roundId && race?.rounds) {
    const rnd = race.rounds.find((r) => r.id === heat.roundId);
    if (rnd?.stageFormat) return rnd.stageFormat;
  }
  return "";
}

const STORAGE_KEY = "gate-timer.announcer";
const PREFERRED_DEFAULT_VOICE = "Google US English";
export const ANDROID_SYSTEM_VOICE_URI = "android:system";
const ANDROID_SYSTEM_VOICE: SpeechSynthesisVoice = {
  voiceURI: ANDROID_SYSTEM_VOICE_URI,
  name: "Android System Voice",
  lang: "en-US",
  localService: true,
  default: true,
};
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
  private timingConnArmed = false;
  private lastTimingConnected: boolean | null = null;
  private lastTimingHwMode: string | null = null;
  private timingConnReseedUntilMs = 0;
  private timingConnTimer = 0;
  private unloading = false;
  private readonly unsubscribers: Array<() => void> = [];
  /** Inaudible tone that keeps the audio output awake while the announcer is on. */
  private keepAwake: AudioContext | null = null;
  private airhornBuffer: AudioBuffer | null = null;
  private airhornLoading: Promise<AudioBuffer | null> | null = null;
  private gestureUnlockBound = false;
  private unbindGestureUnlock: (() => void) | null = null;
  private utteranceWatchdog = 0;
  private voicePollTimer = 0;
  private currentStarted = false;
  private blockedByAutoplay = false;
  private lastUnspokenEntry: { text: string; queuedAt: number; slotIndex?: number; maxAgeMs?: number } | null = null;

  constructor(store: AppStore) {
    this.store = store;
    this.prefs = loadPrefs();
    const caps = capabilitiesSnapshot();
    if (caps.probed && caps.demoMode && !hasSavedPrefs()) {
      this.prefs.enabled = true;
    }
    setWakeLockEnabled(this.prefs.keepScreenAwake !== false);
    this.piper = new PiperNeuralTts(() => this.notify());
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        if (speechSynthesis.speaking || speechSynthesis.pending) {
          speechSynthesis.cancel();
        }
      } catch {
        // ignore startup cancel errors
      }
    }
    if (this.prefs.enabled) {
      this.bindGestureAudioUnlock();
      if (isPiperVoiceURI(this.prefs.voiceURI)) {
        void this.piper.preloadVoice(this.activeVoiceURI()).catch(() => undefined);
      }
      this.resetIdleTimer();
    }
    if (store.hasHydrated) {
      this.lastSimMode = store.simulatorRunning;
      this.lastTimingHwMode = store.timingHardwareMode;
      const initSt = this.evaluateTimingSystemState();
      this.lastTimingConnected = initSt === "pending" ? null : initSt === "connected";
      this.timingConnArmed = true;
    }
    if (typeof window !== "undefined") {
      const onUnload = () => {
        this.unloading = true;
        window.clearTimeout(this.timingConnTimer);
        this.timingConnTimer = 0;
      };
      window.addEventListener("pagehide", onUnload);
      window.addEventListener("beforeunload", onUnload);
      this.unsubscribers.push(() => {
        window.removeEventListener("pagehide", onUnload);
        window.removeEventListener("beforeunload", onUnload);
      });
    }
    this.unsubscribers.push(usbPool.onChange(() => this.scheduleTimingConnCheck()));
    this.unsubscribers.push(sharedLapRFLink.onChange(() => this.scheduleTimingConnCheck()));
    this.unsubscribers.push(sharedRHLink.onChange(() => this.scheduleTimingConnCheck()));

    this.unsubscribers.push(store.onLapRecorded((lap) => this.onLap(lap)));
    this.unsubscribers.push(store.onGateCrossing((ev) => this.onCrossingBeep(ev)));
    this.unsubscribers.push(store.onStartGateDetected((ev) => this.onStartPass(ev)));
    this.unsubscribers.push(store.onRaceAnnouncement((ann) => this.onRaceAnnouncement(ann)));
    this.unsubscribers.push(store.onTelemetryFrame((frame) => this.onTelemetryBeep(frame)));
    this.unsubscribers.push(
      store.onPackSealed((lapCount, nextName) => {
        if (this.prefs.enabled) {
          this.say(
            `Pack saved, ${lapCount} ${lapCount === 1 ? "lap" : "laps"}. ${nextName} armed`,
            false,
            false
          );
        }
      })
    );
    this.unsubscribers.push(
      store.subscribe(["config", "rules", "practice", "race"], () => {
        this.beepConfigDirty = true;
        const nextCfg = this.resolveBeepScope();
        if (hasAnyBeepOnCrossConfigured(nextCfg.scopedStore)) {
          ensureCrossingBeepGestureUnlock();
          warmCrossingBeepAudio();
        }
        const hwChanged =
          this.lastTimingHwMode !== null && this.lastTimingHwMode !== this.store.timingHardwareMode;
        this.lastTimingHwMode = this.store.timingHardwareMode;
        if (hwChanged) {
          this.silenceTimingConnForModeSwitch();
        } else {
          this.scheduleTimingConnCheck();
        }
        this.notify();
      })
    );
    this.unsubscribers.push(
      store.subscribe(["crossings"], () => {
        this.quipSpokenInCurrentLull = false;
        this.resetIdleTimer();
      })
    );
    this.unsubscribers.push(
      store.subscribe(["status"], () => {
        const simChanged = this.lastSimMode !== null && this.lastSimMode !== this.store.simulatorRunning;
        const armedChanged = this.lastRaceArmed !== null && this.lastRaceArmed !== this.store.raceArmed;
        const hwChanged =
          this.lastTimingHwMode !== null && this.lastTimingHwMode !== this.store.timingHardwareMode;
        if (simChanged || armedChanged || hwChanged) {
          this.beepConfigDirty = true;
          this.telemetryBeepStates.clear();
        }
        if (simChanged) {
          this.clear();
        }
        this.lastSimMode = this.store.simulatorRunning;
        this.lastRaceArmed = this.store.raceArmed;
        this.lastTimingHwMode = this.store.timingHardwareMode;
        if (simChanged || hwChanged) {
          this.silenceTimingConnForModeSwitch();
        } else {
          this.scheduleTimingConnCheck();
        }
        if (simChanged || armedChanged) {
          this.resetIdleTimer();
        }
      })
    );
    if ("speechSynthesis" in window) {
      const checkVoicesReady = () => {
        if (this.prefs.enabled) {
          const activeURI = this.activeVoiceURI();
          if (isPiperVoiceURI(activeURI)) {
            void this.piper.preloadVoice(activeURI).catch(() => undefined);
          }
        }
        this.notify();
      };
      speechSynthesis.addEventListener("voiceschanged", checkVoicesReady);
      // Prime speechSynthesis at boot: Chrome only starts fetching its network "Google ..."
      // voices after the first getVoices() call, and may populate local OS voices first before
      // adding remote Google voices a moment later.
      const initialList = speechSynthesis.getVoices();
      const hasTargetVoice = (list: SpeechSynthesisVoice[]) =>
        list.some(
          (v) =>
            !v.localService ||
            v.voiceURI === this.prefs.voiceURI ||
            v.name.toLowerCase() === (this.prefs.voiceURI || PREFERRED_DEFAULT_VOICE).toLowerCase()
        );
      if (!hasTargetVoice(initialList)) {
        let polls = 0;
        this.voicePollTimer = window.setInterval(() => {
          polls++;
          const list = speechSynthesis.getVoices();
          if (hasTargetVoice(list) || polls >= 10) {
            window.clearInterval(this.voicePollTimer);
            this.voicePollTimer = 0;
            checkVoicesReady();
          }
        }, 300);
      }
    }
  }

  public get supported(): boolean {
    return true;
  }

  public get settings(): AnnouncerPrefs {
    return this.prefs;
  }

  public voices(): SpeechSynthesisVoice[] {
    const androidVoice = getAndroidBridge() ? [ANDROID_SYSTEM_VOICE] : [];
    if (!("speechSynthesis" in window)) return androidVoice;
    const all = speechSynthesis.getVoices();
    const english = all.filter((v) => /^en(?:[-_]|$)/i.test(v.lang));
    const base = english.length > 0 ? english : all;
    return androidVoice.length > 0 ? [...androidVoice, ...base] : base;
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
    if (getAndroidBridge()) {
      if (
        !this.prefs.voiceURI ||
        this.prefs.voiceURI === ANDROID_SYSTEM_VOICE_URI ||
        this.prefs.voiceURI === "system" ||
        this.prefs.voiceURI === PREFERRED_DEFAULT_VOICE
      ) {
        return ANDROID_SYSTEM_VOICE_URI;
      }
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

  /**
   * Toggles the master announcer from a TopBar button click. If the announcer was auto-enabled on
   * page load in Demo mode and browser autoplay blocked speech (`error: "not-allowed"`) before any
   * user gesture occurred, the first click wakes and announces `"Announcer on"` instead of muting.
   */
  public toggleEnabledFromGesture(): void {
    if (this.prefs.enabled && this.blockedByAutoplay) {
      this.blockedByAutoplay = false;
      this.update({ enabled: true });
      this.wakeAudio();
      this.say("Announcer on", true);
      return;
    }
    this.update({ enabled: !this.prefs.enabled });
  }

  /** Enabling must happen from a click the first time (browser autoplay policy). */
  public update(next: Partial<AnnouncerPrefs>): void {
    const wasEnabled = this.prefs.enabled;
    if (next.enabled !== undefined) {
      this.blockedByAutoplay = false;
    }
    const wasQualLapCallouts = this.prefs.qualifierLapCallouts;
    const wasRaceLapCallouts = this.prefs.raceLapCallouts;
    this.prefs = sanitizePrefs({ ...this.prefs, ...next });
    const serialized = JSON.stringify(this.prefs);
    try {
      localStorage.setItem(STORAGE_KEY, serialized);
    } catch {
      // ignore storage errors
    }
    try {
      getAndroidBridge()?.setStringPref?.(STORAGE_KEY, serialized);
    } catch {
      // ignore bridge errors
    }
    const liveHit = this.getLiveRunningRaceHeatContext();
    if (liveHit) {
      const isQual = isQualifierStageFormat(resolveHeatStageFormat(liveHit.heat, liveHit.race));
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
      this.unbindGestureUnlock?.();
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
    this.unbindGestureUnlock?.();
    window.clearInterval(this.voicePollTimer);
    this.voicePollTimer = 0;
    window.clearTimeout(this.idleTimer);
    this.idleTimer = 0;
    window.clearTimeout(this.timingConnTimer);
    this.timingConnTimer = 0;
    this.timingConnArmed = false;
    while (this.unsubscribers.length > 0) {
      const unsub = this.unsubscribers.pop();
      try {
        unsub?.();
      } catch {
        // ignore unsubscribe errors
      }
    }
    this.clear();
    this.holdUntil = 0;
  }

  /**
   * Seeds the baseline timing hardware connection state after initial app boot / port restore
   * so already-connected hardware on page load does not trigger a spurious callout, while any
   * subsequent connect or disconnect announces "Timing system connected" / "Timing system disconnected".
   */
  public armTimingConnectionAnnouncements(): void {
    window.clearTimeout(this.timingConnTimer);
    this.timingConnTimer = 0;
    this.timingConnReseedUntilMs = 0;
    this.lastSimMode = this.store.simulatorRunning;
    this.lastTimingHwMode = this.store.timingHardwareMode;
    const st = this.evaluateTimingSystemState();
    this.lastTimingConnected = st === "pending" ? null : st === "connected";
    this.timingConnArmed = true;
    if (st === "pending") {
      this.scheduleTimingConnCheck();
    }
  }

  private evaluateTimingSystemState(): "connected" | "disconnected" | "pending" {
    if (isServerDisconnectedLockout()) {
      return "disconnected";
    }
    const hwMode = this.store.timingHardwareMode;
    if (hwMode === "rotorhazard" || hwMode === "rotorhazard_usb") {
      return sharedRHLink.snapshots(this.store).some((s) => s.connected)
        ? "connected"
        : "disconnected";
    }
    if (hwMode === "laprf" || hwMode === "laprf_usb") {
      return sharedLapRFLink.snapshots(this.store).some((s) => s.connected)
        ? "connected"
        : "disconnected";
    }
    const hasReadySlaprf = usbPool.slots.some((c) => {
      if (!c.connected || c.isOtherDevice || c.lastStatus?.emergencyMode) {
        return false;
      }
      const s = c.lastStatus;
      const cfg = c.lastConfig;
      return Boolean(
        s?.role === 1 || s?.role === 2 || cfg?.role === "hub" || cfg?.role === "spoke"
      );
    });
    if (hasReadySlaprf) {
      return "connected";
    }
    const hasProbingSlot = usbPool.slots.some(
      (c) =>
        c.connected &&
        !c.isOtherDevice &&
        !c.lastStatus?.emergencyMode &&
        !c.lastStatus &&
        !c.lastConfig
    );
    return hasProbingSlot ? "pending" : "disconnected";
  }

  private silenceTimingConnForModeSwitch(): void {
    window.clearTimeout(this.timingConnTimer);
    this.timingConnTimer = 0;
    this.lastTimingConnected = null;
    this.timingConnReseedUntilMs = Date.now() + 750;
    if (this.timingConnArmed && !this.unloading) {
      this.timingConnTimer = window.setTimeout(() => {
        this.timingConnTimer = 0;
        this.flushTimingConnCheck();
      }, 760);
    }
  }

  private scheduleTimingConnCheck(): void {
    if (!this.timingConnArmed || this.unloading) return;
    window.clearTimeout(this.timingConnTimer);
    const now = Date.now();
    const delayMs =
      this.timingConnReseedUntilMs > now
        ? Math.max(80, this.timingConnReseedUntilMs - now + 10)
        : 80;
    this.timingConnTimer = window.setTimeout(() => {
      this.timingConnTimer = 0;
      this.flushTimingConnCheck();
    }, delayMs);
  }

  private flushTimingConnCheck(): void {
    if (!this.timingConnArmed || this.unloading) return;
    const now = Date.now();
    if (this.timingConnReseedUntilMs > now) {
      this.scheduleTimingConnCheck();
      return;
    }
    const st = this.evaluateTimingSystemState();
    if (st === "pending") {
      this.timingConnTimer = window.setTimeout(() => {
        this.timingConnTimer = 0;
        this.flushTimingConnCheck();
      }, 90);
      return;
    }
    const cur = st === "connected";
    if (this.lastTimingConnected === null) {
      this.lastTimingConnected = cur;
      return;
    }
    if (cur === this.lastTimingConnected) {
      return;
    }
    this.lastTimingConnected = cur;
    if (!this.prefs.enabled) {
      return;
    }
    this.queue = this.queue.filter(
      (item) =>
        item.text !== "Timing system connected" && item.text !== "Timing system disconnected"
    );
    this.say(cur ? "Timing system connected" : "Timing system disconnected");
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
    this.silenceTimingConnForModeSwitch();
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
    this.say(nextOn ? "Lap timing announcements on" : "Lap timing announcements off", true);
  }

  private getLiveRunningRaceHeatContext() {
    if (Boolean(this.store.practiceState?.activeSessionId)) {
      return null;
    }
    const rs = this.store.raceState;
    if (
      rs &&
      rs.lifecycle !== "paused" &&
      rs.lifecycle !== "completed" &&
      rs.lifecycle !== "scrapped"
    ) {
      const heat = this.store.activeRaceHeat;
      if (heat && (heat.state === "countdown" || heat.state === "running")) {
        return { heat, race: rs };
      }
      const anyLive = rs.heats.find(
        (h) => h.state === "countdown" || h.state === "running"
      );
      if (anyLive) {
        return { heat: anyLive, race: rs };
      }
    }
    const ongoing = this.store.ongoingRace;
    if (
      ongoing &&
      ongoing.lifecycle !== "paused" &&
      ongoing.lifecycle !== "completed" &&
      ongoing.lifecycle !== "scrapped"
    ) {
      const ongoingHeat = ongoing.heats.find(
        (h) => h.state === "countdown" || h.state === "running"
      );
      if (ongoingHeat) {
        return { heat: ongoingHeat, race: ongoing };
      }
    }
    return null;
  }

  private onLap(lap: LapRecord): void {
    const liveHit = this.getLiveRunningRaceHeatContext();
    if (liveHit) {
      const { heat: liveHeat, race: liveRace } = liveHit;
      // During an active race heat, strictly handle crossings for pilots racing in that heat.
      const seat = liveHeat.seats.find(
        (s) => s.pilotSlotIndex === lap.slotIndex && s.status !== "dns" && s.status !== "dq"
      );
      if (!seat) return;
      if (!this.prefs.enabled) return;
      this.playGatePassBeep(lap.slotIndex);
      const stageFmt = resolveHeatStageFormat(liveHeat, liveRace);
      const allowLapCallout = isQualifierStageFormat(stageFmt)
        ? this.prefs.qualifierLapCallouts !== false
        : Boolean(this.prefs.raceLapCallouts);
      if (!allowLapCallout) return;
    }
    const pilot = this.store.pilot(lap.slotIndex);
    const callsign = pilot?.callsign ?? lap.callsign;
    this.say(lapCallout(callsign, lap.lapTimeSec, pilot?.phoneticName), false, false, lap.slotIndex);
  }

  private beepConfigDirty = true;
  private cachedBeepScope: {
    active: boolean;
    scopedStore: AppStore;
    gatesByFrameTimerId: Map<
      number,
      {
        gateId: number;
        beepMode: "enter" | "peak" | "exit";
        minCrossingSec: number;
        pilots: Array<{
          slotIndex: number;
          rssiIdx: number;
          enterDbm: number;
          exitDbm: number;
        }>;
      }
    >;
  } | null = null;
  private readonly telemetryBeepStates = new Map<
    string,
    {
      inGate: boolean;
      peakBeepFired: boolean;
      awaitingRearm: boolean;
      enterTsUs: number;
      aboveEnterUs: number;
      aboveEnterAreaDbSec: number;
      peakRssi: number;
      peakTsUs: number;
      prevRssi: number;
      fallingStreak: number;
      lastExitUs: number;
      lastSampleTsUs: number;
      lastAudioWallMs: number;
    }
  >();

  /**
   * Resolves the active scoped `AppStore` view (running race heat or active/selected practice session)
   * so `beepMode` inheritance and gate tones always match the active track.
   */
  private getActiveCrossingScopeStore(): AppStore {
    const liveHit = this.getLiveRunningRaceHeatContext();
    if (liveHit) {
      return this.store.forRaceWorkspace(() => liveHit.race);
    }
    const pracSess = this.store.activePracticeSession ?? this.store.selectedPracticeSession;
    if (pracSess) {
      return this.store.forPracticeTrackEditor(() => pracSess);
    }
    return this.store;
  }

  private resolveBeepScope() {
    if (!this.beepConfigDirty && this.cachedBeepScope) {
      return this.cachedBeepScope;
    }
    this.beepConfigDirty = false;
    const scopedStore = this.getActiveCrossingScopeStore();
    const gatesByFrameTimerId = new Map<
      number,
      {
        gateId: number;
        beepMode: "enter" | "peak" | "exit";
        minCrossingSec: number;
        pilots: Array<{
          slotIndex: number;
          rssiIdx: number;
          enterDbm: number;
          exitDbm: number;
        }>;
      }
    >();

    // In Simulator mode, mute telemetry beeps when "Timing off" (!raceArmed). On real hardware,
    // keep crossing beeps active during Practice walk-tests whenever beepMode is enabled.
    const liveHit = this.getLiveRunningRaceHeatContext();
    if (!liveHit && this.store.simulatorRunning && !this.store.raceArmed) {
      this.cachedBeepScope = { active: false, scopedStore, gatesByFrameTimerId };
      return this.cachedBeepScope;
    }
    if (!hasAnyBeepOnCrossConfigured(scopedStore)) {
      this.cachedBeepScope = { active: false, scopedStore, gatesByFrameTimerId };
      return this.cachedBeepScope;
    }

    let allowedSlots: Set<number> | null = null;
    if (liveHit) {
      allowedSlots = new Set(
        liveHit.heat.seats
          .filter((s) => s.pilotSlotIndex > 0 && s.status !== "dns" && s.status !== "dq")
          .map((s) => s.pilotSlotIndex)
      );
    } else {
      const pracSess = this.store.activePracticeSession ?? this.store.selectedPracticeSession;
      if (pracSess && pracSess.pilots.length > 0) {
        allowedSlots = new Set(
          pracSess.pilots.filter((p) => (p.channel ?? 0) > 0).map((p) => p.slotIndex)
        );
      }
    }

    const basePilots = this.store.pilots;
    for (const node of scopedStore.nodes) {
      const eff = gateRulesAt(scopedStore, node.gateId);
      const mode = resolveCrossingBeepMode(eff.beepMode, eff.beepOnCross);
      if (mode === "off") continue;
      const pilots: Array<{
        slotIndex: number;
        rssiIdx: number;
        enterDbm: number;
        exitDbm: number;
      }> = [];
      for (let i = 0; i < basePilots.length; i++) {
        const p = basePilots[i];
        if (allowedSlots ? !allowedSlots.has(p.slotIndex) : !p.enabled || p.channel <= 0) {
          continue;
        }
        const enterDbm = enterThresholdAt(scopedStore, node.gateId, p.slotIndex).dbm;
        const exitDbm = exitThresholdAt(scopedStore, node.gateId, p.slotIndex).dbm;
        pilots.push({ slotIndex: p.slotIndex, rssiIdx: i, enterDbm, exitDbm });
      }
      if (pilots.length === 0) continue;
      const minCrossingSec = eff.minCrossingSec > 0 ? eff.minCrossingSec : 0.12;
      const entry = { gateId: node.gateId, beepMode: mode, minCrossingSec, pilots };
      gatesByFrameTimerId.set(node.gateId, entry);
      if (node.assignedTimerId && !gatesByFrameTimerId.has(node.assignedTimerId)) {
        gatesByFrameTimerId.set(node.assignedTimerId, entry);
      }
    }

    this.cachedBeepScope = {
      active: gatesByFrameTimerId.size > 0,
      scopedStore,
      gatesByFrameTimerId,
    };
    return this.cachedBeepScope;
  }

  /**
   * Real-time zero-latency gate crossing sonification on incoming C1-smoothed telemetry frames:
   * - `"enter"`: single beep the instant RSSI crosses above `enterThreshold`.
   * - `"peak"`: single beep right as the RSSI crest turns the corner over the gate and begins dropping away.
   * - `"exit"`: single beep the instant RSSI drops below `exitThreshold`.
   */
  private onTelemetryBeep(frame: TimerTelemetryFrame): void {
    const cfg = this.resolveBeepScope();
    if (!cfg.active) return;
    const gateCfg = cfg.gatesByFrameTimerId.get(frame.timerId);
    if (!gateCfg) return;

    const tsUs = frame.timestampUs;
    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    const vol = this.prefs.volume > 0 ? this.prefs.volume : 0.9;

    for (let i = 0; i < gateCfg.pilots.length; i++) {
      const p = gateCfg.pilots[i];
      const s = frame.rssi[p.rssiIdx];
      const key = `${gateCfg.gateId}:${p.slotIndex}`;
      let st = this.telemetryBeepStates.get(key);
      if (!st) {
        st = {
          inGate: false,
          peakBeepFired: false,
          awaitingRearm: false,
          enterTsUs: 0,
          aboveEnterUs: 0,
          aboveEnterAreaDbSec: 0,
          peakRssi: -127,
          peakTsUs: 0,
          prevRssi: -127,
          fallingStreak: 0,
          lastExitUs: 0,
          lastSampleTsUs: 0,
          lastAudioWallMs: 0,
        };
        this.telemetryBeepStates.set(key, st);
      }

      if (s === undefined || s <= -120) {
        st.inGate = false;
        st.peakBeepFired = false;
        st.awaitingRearm = false;
        continue;
      }
      if (
        st.lastSampleTsUs > 0 &&
        (tsUs < st.lastSampleTsUs || tsUs - st.lastSampleTsUs > 350_000)
      ) {
        st.inGate = false;
        st.peakBeepFired = false;
        st.awaitingRearm = false;
      }
      const dtUs =
        st.lastSampleTsUs > 0 && tsUs > st.lastSampleTsUs
          ? Math.min(tsUs - st.lastSampleTsUs, 120_000)
          : 0;
      st.lastSampleTsUs = tsUs;

      const enterDbm = p.enterDbm;
      const effExit =
        p.exitDbm === 0 || p.exitDbm > enterDbm - 2 ? enterDbm - 2 : p.exitDbm;

      if (!st.inGate) {
        if (st.awaitingRearm) {
          const rearmed =
            s <= effExit ||
            (s <= enterDbm - 3 && tsUs >= st.lastExitUs + 600_000) ||
            (s < enterDbm && tsUs >= st.lastExitUs + 2_500_000);
          if (!rearmed) continue;
          st.awaitingRearm = false;
        }
        const lockedOut = st.lastExitUs > 0 && tsUs <= st.lastExitUs + 250_000;
        if (s >= enterDbm && !lockedOut) {
          st.inGate = true;
          st.peakBeepFired = false;
          st.enterTsUs = tsUs;
          st.aboveEnterUs = 0;
          st.aboveEnterAreaDbSec = 0;
          st.peakRssi = s;
          st.peakTsUs = tsUs;
          st.prevRssi = s;
          st.fallingStreak = 0;
          if (gateCfg.beepMode === "enter") {
            st.lastAudioWallMs = nowMs;
            playShortCrossingBeep(cfg.scopedStore, gateCfg.gateId, vol);
          }
        }
        continue;
      }

      if (dtUs > 0) {
        if (s >= enterDbm) {
          st.aboveEnterUs += dtUs;
        }
        if (s > enterDbm || st.prevRssi > enterDbm) {
          const h0 = Math.max(0, st.prevRssi - enterDbm);
          const h1 = Math.max(0, s - enterDbm);
          st.aboveEnterAreaDbSec += 0.5 * (h0 + h1) * (dtUs / 1_000_000);
        }
      }

      if (s >= st.peakRssi) {
        st.peakRssi = s;
        st.peakTsUs = tsUs;
        st.fallingStreak = 0;
      } else if (s <= st.prevRssi - 0.05) {
        st.fallingStreak++;
      } else if (s > st.prevRssi + 0.2) {
        st.fallingStreak = 0;
      }
      st.prevRssi = s;

      const minCrossSec = gateCfg.minCrossingSec;
      const hasGenuinePassEnergy =
        (st.peakRssi >= enterDbm + 4.2 &&
          st.aboveEnterUs >= Math.max(80_000, minCrossSec * 650_000)) ||
        (st.aboveEnterUs >= Math.max(120_000, minCrossSec * 1_000_000) &&
          st.aboveEnterAreaDbSec >= Math.max(0.18, minCrossSec * 1.5));

      // In "peak" mode, trigger right as the genuine pass crest turns the corner over the gate and starts dropping away.
      if (gateCfg.beepMode === "peak" && !st.peakBeepFired && hasGenuinePassEnergy) {
        const riseAboveEnter = Math.max(0, st.peakRssi - enterDbm);
        const peakDropDb = Math.min(2.2, Math.max(1.2, riseAboveEnter * 0.28));
        const droppedFromPeak = st.peakRssi - s;
        const confirmedFall = st.fallingStreak >= 2 || tsUs - st.peakTsUs >= 35_000;
        if (droppedFromPeak >= peakDropDb && confirmedFall) {
          st.peakBeepFired = true;
          st.lastAudioWallMs = nowMs;
          playShortCrossingBeep(cfg.scopedStore, gateCfg.gateId, vol);
        }
      }

      const exitedBelow = s <= effExit;
      const exitedValley =
        !exitedBelow &&
        s <= enterDbm - 3 &&
        st.peakRssi - s >= 10 &&
        tsUs >= st.peakTsUs + 500_000;
      if (exitedBelow || exitedValley) {
        st.inGate = false;
        st.lastExitUs = tsUs;
        st.awaitingRearm = !exitedBelow;
        if (gateCfg.beepMode === "exit") {
          st.lastAudioWallMs = nowMs;
          playShortCrossingBeep(cfg.scopedStore, gateCfg.gateId, vol);
        } else if (gateCfg.beepMode === "peak" && !st.peakBeepFired && hasGenuinePassEnergy) {
          st.peakBeepFired = true;
          st.lastAudioWallMs = nowMs;
          playShortCrossingBeep(cfg.scopedStore, gateCfg.gateId, vol);
        }
      } else if (tsUs - st.enterTsUs > 8_000_000) {
        if (st.peakRssi >= enterDbm + 3 && s <= enterDbm - 2 && st.peakRssi - s >= 6) {
          st.inGate = false;
          st.lastExitUs = tsUs;
          st.awaitingRearm = true;
          if (gateCfg.beepMode === "exit") {
            st.lastAudioWallMs = nowMs;
            playShortCrossingBeep(cfg.scopedStore, gateCfg.gateId, vol);
          }
        } else {
          st.inGate = false;
        }
      }
    }
  }

  /**
   * Fallback crossing beep for pass-only external hardware (e.g. LapRF 8-Way or RotorHazard when
   * live RSSI streaming is off). Skips if real-time telemetry already sounded.
   */
  private onCrossingBeep(ev: GateCrossingEvent): void {
    const scopedStore = this.getActiveCrossingScopeStore();
    const eff = pilotGateRulesAt(scopedStore, ev.gateId, ev.slotIndex);
    if (!eff.beepOnCross || eff.beepMode === "off") return;
    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    const st = this.telemetryBeepStates.get(`${ev.gateId}:${ev.slotIndex}`);
    if (st && (st.inGate || nowMs - st.lastAudioWallMs < 3000)) {
      return;
    }
    const liveHit = this.getLiveRunningRaceHeatContext();
    if (liveHit) {
      const inHeat = liveHit.heat.seats.some(
        (s) => s.pilotSlotIndex === ev.slotIndex && s.status !== "dns" && s.status !== "dq"
      );
      if (!inHeat) return;
    }
    const vol = this.prefs.volume > 0 ? this.prefs.volume : 0.9;
    playShortCrossingBeep(scopedStore, ev.gateId, vol);
  }

  /**
   * When a pilot crosses the Start/Finish gate with no previous start pass to compare against
   * (initial holeshot or first pass after reset/timeout), call out just their name in practice,
   * or play an instant gate-pass confirmation beep during a live race heat.
   */
  private onStartPass(ev: GateCrossingEvent): void {
    const liveHit = this.getLiveRunningRaceHeatContext();
    if (liveHit) {
      if (!this.prefs.enabled) return;
      // Avoid double-beeping if `beepOnCross` already played the high-priority synthetic beep.
      const scopedStore = this.store.forRaceWorkspace(() => liveHit.race);
      if (pilotGateRulesAt(scopedStore, ev.gateId, ev.slotIndex).beepOnCross) return;
      const inHeat = liveHit.heat.seats.some(
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
    this.currentStarted = false;
    this.lastUnspokenEntry = null;
    this.liveUtterances.clear();
    this.neuralSpeaking = false;
    this.utteranceToken++;
    window.clearTimeout(this.utteranceWatchdog);
    this.utteranceWatchdog = 0;
    window.clearTimeout(this.holdTimer);
    this.holdTimer = 0;
    this.piper.stop();
    const androidBridge = getAndroidBridge();
    if (androidBridge) {
      androidBridge.stopSpeech();
      if (hadBrowserUtterance) {
        this.holdUntil = Date.now() + AFTER_CANCEL_MS;
      }
    }
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
        void this.keepAwake
          .resume()
          .then(() => {
            if (this.prefs.enabled) this.pump();
          })
          .catch(() => undefined);
      }
      const piperReady = this.piper.isVoiceLoaded(activeURI);
      if (!piperReady) {
        void this.piper.preloadVoice(activeURI).catch(() => undefined);
      }
      const canFallbackToBrowserVoice =
        !piperReady && "speechSynthesis" in window && this.voices().length > 0;
      if (this.keepAwake.state === "running" && !canFallbackToBrowserVoice) {
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
              this.speakBrowserUtterance(next!.text, next!);
            } else {
              this.pump();
            }
          });
        return;
      }
    }

    this.speakBrowserUtterance(next.text, next);
  }

  private isNativeSpeechSpeak(): boolean {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return false;
    if (typeof speechSynthesis.speak !== "function") return false;
    try {
      return Function.prototype.toString.call(speechSynthesis.speak).includes("[native code]");
    } catch {
      return false;
    }
  }

  private speakBrowserUtterance(
    text: string,
    entry?: { text: string; queuedAt: number; slotIndex?: number; maxAgeMs?: number }
  ): void {
    const cleaned = text
      .replace(/\s*·\s*/g, ", ")
      .replace(/\b(\d+)\.00\b/g, "$1")
      .replace(/\b(\d+)\.([1-9])0\b/g, "$1.$2");

    const androidBridge = getAndroidBridge();
    if (
      androidBridge &&
      (this.activeVoiceURI() === ANDROID_SYSTEM_VOICE_URI || !("speechSynthesis" in window))
    ) {
      const token = ++this.utteranceToken;
      const flushIdle = !this.neuralSpeaking && this.queue.length === 0;
      this.neuralSpeaking = true;
      const startedAt = Date.now();
      const maxDurationMs = Math.max(12_000, cleaned.length * 220);
      androidBridge.speak(cleaned, this.prefs.rate, this.prefs.volume, flushIdle);

      const pollDone = () => {
        if (this.utteranceToken !== token) return;
        const elapsed = Date.now() - startedAt;
        // Give Android TTS ~180ms to transition into speaking state before checking isSpeaking().
        if (elapsed >= 180 && (!androidBridge.isSpeaking() || elapsed >= maxDurationMs)) {
          this.neuralSpeaking = false;
          if (!this.prefs.enabled && this.queue.length === 0) {
            this.sleepAudio();
            return;
          }
          this.holdUntil = Math.max(this.holdUntil, Date.now() + BETWEEN_CALLOUTS_MS);
          this.pump();
          return;
        }
        this.utteranceWatchdog = window.setTimeout(pollDone, 100);
      };
      window.clearTimeout(this.utteranceWatchdog);
      this.utteranceWatchdog = window.setTimeout(pollDone, 180);
      return;
    }

    if (!("speechSynthesis" in window)) return;
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

    const done = (didSpeak = true) => {
      this.liveUtterances.delete(utterance);
      if (this.current !== utterance) return; // superseded by clear()
      window.clearTimeout(this.utteranceWatchdog);
      this.utteranceWatchdog = 0;
      this.current = null;
      this.currentStarted = false;
      if (!this.prefs.enabled && this.queue.length === 0) {
        this.sleepAudio();
        return;
      }
      if (didSpeak) {
        // Back-to-back callouts (a pack crossing together) also clip on some Windows voices
        // when started the instant the previous one ends; a short breath avoids it.
        this.holdUntil = Math.max(this.holdUntil, Date.now() + BETWEEN_CALLOUTS_MS);
      }
      this.pump();
    };

    const fullWatchdogMs = Math.max(24_000, cleaned.length * 240);
    const onWatchdog = () => {
      if (this.current === utterance) {
        const spoke = this.currentStarted;
        if (!spoke && entry) {
          const maxAge = entry.maxAgeMs ?? STALE_AFTER_MS;
          if (Date.now() - entry.queuedAt <= maxAge) {
            this.lastUnspokenEntry = entry;
          }
        }
        if (!spoke && this.prefs.enabled) {
          this.bindGestureAudioUnlock();
        }
        if ("speechSynthesis" in window) {
          try {
            speechSynthesis.cancel();
          } catch {
            // ignore cancel error
          }
        }
        done(spoke);
      }
    };

    utterance.onstart = () => {
      if (this.current !== utterance) return;
      this.currentStarted = true;
      this.blockedByAutoplay = false;
      this.lastUnspokenEntry = null;
      window.clearTimeout(this.utteranceWatchdog);
      this.utteranceWatchdog = window.setTimeout(onWatchdog, fullWatchdogMs);
    };
    utterance.onend = () => done(true);
    utterance.onerror = (ev) => {
      const spoke = this.currentStarted;
      const errCode = (ev as { error?: string })?.error;
      if (!spoke || errCode === "not-allowed" || errCode === "audio-busy") {
        if (errCode === "not-allowed") {
          this.blockedByAutoplay = true;
        }
        if (entry) {
          const maxAge = entry.maxAgeMs ?? STALE_AFTER_MS;
          if (Date.now() - entry.queuedAt <= maxAge) {
            this.lastUnspokenEntry = entry;
          }
        }
        if (this.prefs.enabled) {
          this.bindGestureAudioUnlock();
        }
      }
      done(spoke);
    };
    this.current = utterance;
    this.currentStarted = false;
    window.clearTimeout(this.utteranceWatchdog);
    const initialWatchdogMs = this.isNativeSpeechSpeak() ? 1500 : fullWatchdogMs;
    this.utteranceWatchdog = window.setTimeout(onWatchdog, initialWatchdogMs);
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
  public wakeAudio(): void {
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
   * When the announcer is restored as enabled across a page reload (or starts enabled in Demo mode),
   * browsers block `AudioContext` and `speechSynthesis.speak()` (`error: "not-allowed"`) until the
   * first user activation gesture (`click`, `pointerup`, `touchend`, `keydown`).
   * Bind a listener so the first gesture unlocks both `AudioContext` and `speechSynthesis` and
   * immediately speaks any pending callout.
   */
  private bindGestureAudioUnlock(): void {
    if (this.gestureUnlockBound || typeof window === "undefined") return;
    this.gestureUnlockBound = true;
    const onPointerDown = () => {
      if (this.prefs.enabled) {
        this.wakeAudio();
      }
    };
    const cleanupListeners = () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", unlock, true);
      window.removeEventListener("click", unlock, true);
      window.removeEventListener("touchend", unlock, true);
      window.removeEventListener("keydown", unlock, true);
      this.gestureUnlockBound = false;
      this.unbindGestureUnlock = null;
    };
    const unlock = (ev?: Event) => {
      const targetEl = ev && ev.target instanceof Element ? ev.target : null;
      if (this.blockedByAutoplay && targetEl?.closest?.('[data-action="announcer"]')) {
        return;
      }
      cleanupListeners();
      this.blockedByAutoplay = false;
      if (!this.prefs.enabled) return;
      this.wakeAudio();

      if (this.current && !this.currentStarted && this.isNativeSpeechSpeak()) {
        window.clearTimeout(this.utteranceWatchdog);
        this.utteranceWatchdog = 0;
        this.liveUtterances.delete(this.current);
        this.current = null;
        this.currentStarted = false;
        this.holdUntil = 0;
        try {
          speechSynthesis.cancel();
        } catch {
          // ignore cancel errors
        }
      }

      if (this.lastUnspokenEntry) {
        const entry = this.lastUnspokenEntry;
        this.lastUnspokenEntry = null;
        const maxAge = entry.maxAgeMs ?? STALE_AFTER_MS;
        if (Date.now() - entry.queuedAt <= maxAge) {
          if (entry.slotIndex !== undefined) {
            this.queue = this.queue.filter((q) => q.slotIndex !== entry.slotIndex);
          }
          if (!this.queue.some((q) => q.text === entry.text)) {
            this.queue.unshift(entry);
          }
        }
      }

      if (this.queue.length > 0 && !this.current && !this.neuralSpeaking) {
        this.holdUntil = 0;
        this.pump();
      } else if ("speechSynthesis" in window && !this.current && this.isNativeSpeechSpeak()) {
        try {
          if (speechSynthesis.paused) {
            speechSynthesis.resume();
          }
          const prime = new SpeechSynthesisUtterance(" ");
          prime.volume = 0;
          prime.rate = 1.6;
          speechSynthesis.speak(prime);
        } catch {
          // ignore prime errors
        }
      }
    };
    this.unbindGestureUnlock = cleanupListeners;
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", unlock, true);
    window.addEventListener("click", unlock, true);
    window.addEventListener("touchend", unlock, true);
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

function readRawAnnouncerPrefs(): string | null {
  try {
    const local = localStorage.getItem(STORAGE_KEY);
    if (local !== null && local !== "") {
      try {
        getAndroidBridge()?.setStringPref?.(STORAGE_KEY, local);
      } catch {
        // ignore bridge sync error
      }
      return local;
    }
  } catch {
    // ignore storage errors
  }
  try {
    const nativeVal = getAndroidBridge()?.getStringPref?.(STORAGE_KEY);
    if (nativeVal && nativeVal.trim() !== "") {
      try {
        localStorage.setItem(STORAGE_KEY, nativeVal);
      } catch {
        // ignore storage errors
      }
      return nativeVal;
    }
  } catch {
    // ignore bridge errors
  }
  return null;
}

function hasSavedPrefs(): boolean {
  return readRawAnnouncerPrefs() !== null;
}

function loadPrefs(): AnnouncerPrefs {
  try {
    const raw = readRawAnnouncerPrefs();
    return raw ? sanitizePrefs(JSON.parse(raw)) : { ...DEFAULT_PREFS };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}
