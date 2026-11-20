import { AppStore } from "../state/store";

const KEEP_AWAKE_GAIN = 0.0001;
const SECTOR_FREQS_HZ = [1174.66, 1396.91, 1567.98, 1760.0, 1975.53, 2349.32];

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
    if (!sharedCtx) {
      const ctx = new Ctx({ latencyHint: "interactive" });
      const keepOsc = ctx.createOscillator();
      const keepGain = ctx.createGain();
      keepOsc.frequency.value = 440;
      keepGain.gain.value = KEEP_AWAKE_GAIN;
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

/**
 * Plays an immediate, zero-queue synthetic crossing beep on the hardware WebAudio mixer thread.
 * Mixes cleanly over any active TTS speech without waiting for or interrupting voice callouts.
 */
export function playSyntheticCrossingBeep(store: AppStore, gateId: number, volume = 0.9): void {
  const ctx = warmCrossingBeepAudio();
  if (!ctx) return;
  try {
    const node = store.node(gateId);
    const isStartFinish = node?.role === "START_FINISH";
    const order = Math.max(0, node?.trackOrder ?? Math.max(0, gateId - 1));
    const now = ctx.currentTime;
    const peakGain = Math.max(0.08, Math.min(1, volume)) * 0.34;

    if (isStartFinish) {
      // Crisp 2-step rising micro-chirp (C6 -> E6, 72 ms total) for Start/Finish
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(peakGain, now + 0.004);
      g.gain.setValueAtTime(peakGain * 0.9, now + 0.034);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.074);
      g.connect(ctx.destination);

      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(1046.5, now);
      osc.frequency.setValueAtTime(1318.51, now + 0.035);
      osc.connect(g);
      osc.start(now);
      osc.stop(now + 0.08);
      return;
    }

    // Distinct single-note high-clarity sector ping by gate order around the course
    const freqHz = SECTOR_FREQS_HZ[order % SECTOR_FREQS_HZ.length];
    const dur = 0.068;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(peakGain, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    g.connect(ctx.destination);

    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freqHz, now);
    osc.connect(g);
    osc.start(now);
    osc.stop(now + dur + 0.01);
  } catch {
    // Ignore AudioContext scheduling errors in headless test environments
  }
}
