import { getAndroidBridge } from "../core/android_bridge";
import { AppStore } from "../state/store";
import { CrossingBeepMode } from "../types/models";

const KEEP_WAKE_GAIN = 0.0001;
const GATE_TONE_FREQS_HZ = [1318.51, 1479.98, 1661.22, 1760.0, 1975.53, 2217.46];
const BEEP_DURATION_SEC = 0.15;

let sharedCtx: AudioContext | null = null;
let unlockBound = false;

function getAudioContextConstructor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

/** Ensures the shared low-latency WebAudio context is running and kept warm for instant beeps. */
export function warmCrossingBeepAudio(): AudioContext | null {
  const Ctx = getAudioContextConstructor();
  if (!Ctx) return null;
  try {
    if (!sharedCtx || !(sharedCtx instanceof Ctx)) {
      const ctx = new Ctx({ latencyHint: "interactive" });
      const keepOsc = ctx.createOscillator();
      const keepGain = ctx.createGain();
      keepOsc.frequency.value = 440;
      keepGain.gain.value = KEEP_WAKE_GAIN;
      keepOsc.connect(keepGain).connect(ctx.destination);
      keepOsc.start();
      sharedCtx = ctx;
    }
    if (sharedCtx.state === "suspended") {
      void sharedCtx.resume().catch(() => undefined);
    }
    return sharedCtx;
  } catch {
    return null;
  }
}

/** Binds a one-shot user-gesture listener so desktop browsers unlock AudioContext if needed. */
export function ensureCrossingBeepGestureUnlock(): void {
  if (unlockBound || typeof window === "undefined") return;
  unlockBound = true;
  const unlock = () => {
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
    unlockBound = false;
    warmCrossingBeepAudio();
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
}

function resolveGateFreqHz(store: AppStore, gateId: number): number {
  const node = store.node(gateId);
  const rawOrder = Math.max(0, (node?.trackOrder ?? gateId) - 1);
  return GATE_TONE_FREQS_HZ[rawOrder % GATE_TONE_FREQS_HZ.length];
}

/** Plays an instant, crisp single crossing beep on the hardware WebAudio mixer thread (or capturable Android AudioTrack). */
export function playShortCrossingBeep(store: AppStore, gateId: number, volume = 0.9): void {
  const freqHz = resolveGateFreqHz(store, gateId);
  const clampedVol = Math.max(0.08, Math.min(1, volume));
  const androidBridge = getAndroidBridge();
  if (androidBridge && typeof androidBridge.playBeep === "function") {
    try {
      androidBridge.playBeep(freqHz, Math.round(BEEP_DURATION_SEC * 1000), clampedVol);
      return;
    } catch {
      // Fall back to WebAudio if bridge call fails
    }
  }
  const ctx = warmCrossingBeepAudio();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const peakGain = clampedVol * 0.4;
    const attackEnd = now + 0.006;
    const sustainEnd = now + BEEP_DURATION_SEC - 0.025;

    const g = ctx.createGain();
    g.gain.setValueAtTime(KEEP_WAKE_GAIN, now);
    g.gain.linearRampToValueAtTime(peakGain, attackEnd);
    g.gain.setValueAtTime(peakGain, sustainEnd);
    g.gain.exponentialRampToValueAtTime(KEEP_WAKE_GAIN, sustainEnd + 0.025);
    g.connect(ctx.destination);

    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freqHz, now);
    osc.connect(g);
    osc.start(now);
    osc.stop(sustainEnd + 0.03);
  } catch {
    // Ignore AudioContext scheduling errors in headless test environments
  }
}

/** Plays a preview crossing beep when selecting `"enter"`, `"peak"`, or `"exit"` in Track or Signals. */
export function playPreviewCrossingBeep(
  store: AppStore,
  gateId: number,
  mode: CrossingBeepMode,
  volume = 0.9
): void {
  if (mode === "off") return;
  playShortCrossingBeep(store, gateId, volume);
}

/** Backward-compatible alias for playing a single crossing beep. */
export function playSyntheticCrossingBeep(
  store: AppStore,
  gateId: number,
  volume = 0.9,
  mode: CrossingBeepMode = "enter"
): void {
  playPreviewCrossingBeep(store, gateId, mode, volume);
}
