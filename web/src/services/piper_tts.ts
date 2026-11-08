export interface PiperVoiceDescriptor {
  uri: string;
  voiceId: string;
  name: string;
  lang: string;
  modelPath: string;
}

export const DEFAULT_PIPER_VOICE_URI = "piper:en_US-lessac-medium";

export const PIPER_VOICES: PiperVoiceDescriptor[] = [
  {
    uri: "piper:en_US-lessac-medium",
    voiceId: "en_US-lessac-medium",
    name: "Piper Neural · US English Female (Offline)",
    lang: "en-US",
    modelPath: "en/en_US/lessac/medium/en_US-lessac-medium.onnx",
  },
  {
    uri: "piper:en_US-hfc_male-medium",
    voiceId: "en_US-hfc_male-medium",
    name: "Piper Neural · US English Male (Offline)",
    lang: "en-US",
    modelPath: "en/en_US/hfc_male/medium/en_US-hfc_male-medium.onnx",
  },
  {
    uri: "piper:en_US-amy-medium",
    voiceId: "en_US-amy-medium",
    name: "Piper Neural · Amy US English (Offline)",
    lang: "en-US",
    modelPath: "en/en_US/amy/medium/en_US-amy-medium.onnx",
  },
  {
    uri: "piper:en_US-ryan-medium",
    voiceId: "en_US-ryan-medium",
    name: "Piper Neural · Ryan US English (Offline)",
    lang: "en-US",
    modelPath: "en/en_US/ryan/medium/en_US-ryan-medium.onnx",
  },
];

export function isPiperVoiceURI(uri: string): boolean {
  return uri.startsWith("piper:");
}

export function getPiperVoice(uri: string): PiperVoiceDescriptor {
  if (uri === "piper:en_US-hfc_female-medium") {
    return PIPER_VOICES[0];
  }
  return PIPER_VOICES.find((v) => v.uri === uri) ?? PIPER_VOICES[0];
}

/**
 * Normalizes lap-time decimals before passing to espeak-ng so trailing zeros are dropped
 * (`14.00` -> `"14"`, `14.80` -> `"14.8"`) and `.0X` fractional times (`14.08`, `19.02`)
 * are spoken smoothly as `"14 point zero 8"` with no pause.
 */
export function prepareTextForPiper(raw: string): string {
  return raw
    .trim()
    .replace(/\b(\d+)\.00\b/g, "$1")
    .replace(/\b(\d+)\.([1-9])0\b/g, "$1.$2")
    .replace(/\b(\d+)\.0([1-9])\b/g, "$1 point zero $2")
    .replace(
      /\bpoint\s+(?:o+h*|zero)\s*,?\s*(one|two|three|four|five|six|seven|eight|nine|\d)\b/gi,
      "point zero $1"
    );
}

const HF_BASE = "https://huggingface.co/diffusionstudio/piper-voices/resolve/main";
const PIPER_JS_URL = "https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.5/dist/piper-o91UDS6e.js";
const PIPER_WASM_URL = "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.wasm";
const PIPER_DATA_URL = "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data";
const ORT_JS_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/esm/ort.wasm.min.js";
const ORT_WASM_SIMD_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort-wasm-simd.wasm";

interface PiperModelConfig {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: {
    noise_scale: number;
    length_scale: number;
    noise_w: number;
  };
  speaker_id_map?: Record<string, number>;
}

interface LoadedVoiceSession {
  voiceId: string;
  config: PiperModelConfig;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session?: any;
}

const MAX_AUDIO_CACHE_ENTRIES = 120;

// Native browser dynamic import helper so esbuild's IIFE bundler leaves runtime ESM imports intact.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const runtimeImport = new Function("u", "return import(u)") as <T = unknown>(url: string) => Promise<T>;

/**
 * Self-contained Web Worker script that executes `espeak-ng` phonemization and ONNX Runtime Web
 * VITS neural synthesis completely off the main UI thread so 60 fps animations (such as the
 * Flight Corridor in `#/sim`) never stutter or drop frames on mobile or desktop.
 */
const PIPER_WORKER_SOURCE = `
let createPiperPhonemize = null;
let ort = null;
let piperWasmBlobUrl = "";
let piperDataBlobUrl = "";
const sessions = new Map();
const runtimeImport = new Function("u", "return import(u)");

let queue = Promise.resolve();

self.onmessage = (e) => {
  const msg = e.data;
  queue = queue.then(() => handleMessage(msg)).catch((err) => {
    if (msg && msg.reqId) {
      self.postMessage({
        type: "error",
        reqId: msg.reqId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
};

async function handleMessage(msg) {
  if (msg.type === "init-runtime") {
    if (!ort || !createPiperPhonemize) {
      piperWasmBlobUrl = URL.createObjectURL(msg.piperWasmBlob);
      piperDataBlobUrl = URL.createObjectURL(msg.piperDataBlob);
      const ortWasmBlobUrl = URL.createObjectURL(msg.ortWasmBlob);

      const piperJsUrl = URL.createObjectURL(
        new Blob([await msg.piperJsBlob.arrayBuffer()], { type: "text/javascript" })
      );
      const ortJsUrl = URL.createObjectURL(
        new Blob([await msg.ortJsBlob.arrayBuffer()], { type: "text/javascript" })
      );

      try {
        const piperMod = await runtimeImport(piperJsUrl);
        createPiperPhonemize = piperMod.createPiperPhonemize;

        const ortMod = await runtimeImport(ortJsUrl);
        const ortInstance = ortMod.default || ortMod;
        if (ortInstance.env) {
          ortInstance.env.allowLocalModels = false;
          if (ortInstance.env.wasm) {
            ortInstance.env.wasm.numThreads = 1;
            ortInstance.env.wasm.simd = true;
            ortInstance.env.wasm.wasmPaths = {
              "ort-wasm-simd.wasm": ortWasmBlobUrl,
              "ort-wasm.wasm": ortWasmBlobUrl,
            };
          }
        }
        ort = ortInstance;
      } finally {
        URL.revokeObjectURL(piperJsUrl);
        URL.revokeObjectURL(ortJsUrl);
      }
    }
    self.postMessage({ type: "ok", reqId: msg.reqId });
    return;
  }

  if (msg.type === "load-voice") {
    if (!sessions.has(msg.voiceId)) {
      const modelBytes = await msg.modelBlob.arrayBuffer();
      const session = await ort.InferenceSession.create(modelBytes, {
        executionProviders: ["wasm"],
      });
      sessions.set(msg.voiceId, { config: msg.config, session });
    }
    self.postMessage({ type: "ok", reqId: msg.reqId });
    return;
  }

  if (msg.type === "synthesize") {
    const loaded = sessions.get(msg.voiceId);
    if (!loaded) {
      throw new Error("Voice session not loaded: " + msg.voiceId);
    }
    const inputJson = JSON.stringify([{ text: msg.normalizedText }]);
    const phonemeIds = await new Promise((resolve, reject) => {
      createPiperPhonemize({
        print: (out) => {
          try {
            resolve(JSON.parse(out).phoneme_ids);
          } catch (err) {
            reject(err);
          }
        },
        printErr: (errText) => {
          reject(new Error(errText));
        },
        locateFile: (url) => {
          if (url.endsWith(".wasm")) return piperWasmBlobUrl;
          if (url.endsWith(".data")) return piperDataBlobUrl;
          return url;
        },
      })
        .then((mod) => {
          mod.callMain([
            "-l",
            loaded.config.espeak.voice,
            "--input",
            inputJson,
            "--espeak_data",
            "/espeak-ng-data",
          ]);
        })
        .catch(reject);
    });

    const noiseScale = loaded.config.inference.noise_scale;
    const lengthScale = loaded.config.inference.length_scale / msg.rate;
    const noiseW = Math.min(loaded.config.inference.noise_w, 0.35);

    const feeds = {
      input: new ort.Tensor("int64", phonemeIds, [1, phonemeIds.length]),
      input_lengths: new ort.Tensor("int64", [phonemeIds.length]),
      scales: new ort.Tensor("float32", [noiseScale, lengthScale, noiseW]),
    };
    if (loaded.config.speaker_id_map && Object.keys(loaded.config.speaker_id_map).length > 0) {
      feeds.sid = new ort.Tensor("int64", [0]);
    }

    const results = await loaded.session.run(feeds);
    const rawData = results.output.data;
    const pcm = new Float32Array(rawData.length);
    pcm.set(rawData);
    const sampleRate = (loaded.config.audio && loaded.config.audio.sample_rate) || 22050;

    self.postMessage(
      {
        type: "ok",
        reqId: msg.reqId,
        pcmBuffer: pcm.buffer,
        sampleRate,
      },
      [pcm.buffer]
    );
  }
}
`;

interface WorkerPendingRequest {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve: (val: any) => void;
  reject: (err: Error) => void;
}

/**
 * In-browser neural Text-to-Speech engine powered by Piper VITS + ONNX Runtime Web (WASM).
 * Caches both the WASM runtime and `.onnx` voice models in the browser's Origin Private
 * File System (OPFS) and runs WASM phonemization + ONNX inference in a dedicated background
 * Web Worker so the main UI thread never blocks or drops animation frames.
 */
export class PiperNeuralTts {
  private worker: Worker | null = null;
  private workerBroken = false;
  private nextReqId = 1;
  private readonly pendingWorkerReqs = new Map<number, WorkerPendingRequest>();

  // Fallback main-thread state only used if Blob Worker creation is blocked by environment
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private createPiperPhonemize: ((opts: Record<string, unknown>) => Promise<any>) | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ort: any = null;
  private piperWasmBlobUrl = "";
  private piperDataBlobUrl = "";
  private runtimePromise: Promise<void> | null = null;

  private readonly voiceSessions = new Map<string, Promise<LoadedVoiceSession>>();
  private readonly cachedVoices = new Set<string>();
  private readonly readySessions = new Set<string>();
  private readonly downloadProgress = new Map<string, number>();
  private readonly audioCache = new Map<string, AudioBuffer>();
  private readonly wavUrlCache = new Map<string, string>();
  private readonly memoryBlobs = new Map<string, Blob>();
  private activeSource: AudioBufferSourceNode | null = null;
  private activeHtmlAudio: HTMLAudioElement | null = null;
  private htmlAudioUnlocked = false;
  private readonly onStatusChange: () => void;

  constructor(onStatusChange: () => void) {
    this.onStatusChange = onStatusChange;
    void this.refreshCachedVoices();
  }

  public isVoiceCached(uri: string): boolean {
    const desc = getPiperVoice(uri);
    return this.cachedVoices.has(desc.voiceId);
  }

  /** Returns true only when the ONNX InferenceSession is already compiled and hot in RAM. */
  public isVoiceSessionReady(uri: string): boolean {
    const desc = getPiperVoice(uri);
    return this.readySessions.has(desc.voiceId);
  }

  public getDownloadProgress(uri: string): number | null {
    const desc = getPiperVoice(uri);
    const pct = this.downloadProgress.get(desc.voiceId);
    return pct !== undefined ? pct : null;
  }

  public async refreshCachedVoices(): Promise<void> {
    try {
      const dir = await this.getOpfsDir();
      if (!dir) return;
      let changed = false;
      for (const v of PIPER_VOICES) {
        const filename = `${v.voiceId}.onnx`;
        try {
          const handle = await dir.getFileHandle(filename);
          const file = await handle.getFile();
          if (file.size > 1_000_000 && !this.cachedVoices.has(v.voiceId)) {
            this.cachedVoices.add(v.voiceId);
            changed = true;
          }
        } catch {
          // Not cached yet
        }
      }
      if (changed) {
        this.onStatusChange();
      }
    } catch {
      // Ignore OPFS inspection errors
    }
  }

  /** Pre-warms and caches the runtime + selected voice model in the background. */
  public async preloadVoice(uri: string): Promise<void> {
    const desc = getPiperVoice(uri);
    await this.ensureVoiceSession(desc);
  }

  /**
   * Unlocks the dedicated HTML5 `<audio>` element during a user gesture so mobile browsers
   * allow starting new neural TTS clips even after the phone screen is locked (`document.hidden`).
   */
  public unlockAudio(silentWavUrl: string): void {
    if (this.htmlAudioUnlocked || !silentWavUrl || typeof document === "undefined") return;
    try {
      if (!this.activeHtmlAudio) {
        const el = document.createElement("audio");
        el.setAttribute("playsinline", "true");
        el.style.display = "none";
        document.body?.appendChild(el);
        this.activeHtmlAudio = el;
      }
      const el = this.activeHtmlAudio;
      el.src = silentWavUrl;
      el.volume = 0.01;
      const p = el.play();
      if (p) {
        p.then(() => {
          el.pause();
          el.currentTime = 0;
          this.htmlAudioUnlocked = true;
        }).catch(() => undefined);
      }
    } catch {
      // Ignore
    }
  }

  /** Stops any currently playing neural utterance immediately. */
  public stop(): void {
    if (this.activeSource) {
      try {
        this.activeSource.onended = null;
        this.activeSource.stop();
        this.activeSource.disconnect();
      } catch {
        // Ignore if already stopped
      }
      this.activeSource = null;
    }
    if (this.activeHtmlAudio) {
      try {
        this.activeHtmlAudio.pause();
        this.activeHtmlAudio.currentTime = 0;
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Synthesizes `text` using the specified Piper voice and plays it through `ctx` (or through
   * an `<audio>` element when the document is hidden/locked on mobile).
   * Resolves when playback finishes (or is stopped).
   */
  public async speak(
    text: string,
    uri: string,
    rate: number,
    volume: number,
    ctx: AudioContext,
    queuedAt?: number,
    maxAgeMs = 8000
  ): Promise<void> {
    const desc = getPiperVoice(uri);
    const clampedRate = Math.max(0.7, Math.min(1.8, rate || 1.0));
    const normalizedText = prepareTextForPiper(text);
    const cacheKey = `${desc.voiceId}:${clampedRate.toFixed(2)}:${normalizedText}`;

    let audioBuffer = this.audioCache.get(cacheKey);
    let wavUrl = this.wavUrlCache.get(cacheKey);
    if (!audioBuffer || !wavUrl) {
      const { pcm, sampleRate } = await this.synthesizePcm(normalizedText, desc, clampedRate);
      audioBuffer = ctx.createBuffer(1, pcm.length, sampleRate);
      audioBuffer.getChannelData(0).set(pcm);
      this.setCache(cacheKey, audioBuffer);
      wavUrl = encodeFloat32ToWavBlobUrl(pcm, sampleRate);
      this.setWavCache(cacheKey, wavUrl);
    }

    // Never speak a callout that went stale while waiting for model download/compilation.
    if (queuedAt !== undefined && Date.now() - queuedAt > maxAgeMs) {
      return;
    }

    if (ctx.state !== "running") {
      await ctx.resume().catch(() => undefined);
    }
    // Only fall back to HTML5 `<audio>` if WebAudio `AudioContext` refused to resume.
    // When `ctx.state === "running"`, `ctx.createBufferSource()` plays directly from PCM memory
    // with zero background resource-loader delay.
    if (ctx.state !== "running") {
      const playedHtml = await this.playViaHtmlAudio(wavUrl, volume);
      if (playedHtml) return;
    }

    await ctx.resume().catch(() => undefined);
    return new Promise<void>((resolve) => {
      this.stop();
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      source.buffer = audioBuffer!;
      gain.gain.value = Math.max(0, Math.min(1, volume));
      source.connect(gain).connect(ctx.destination);
      this.activeSource = source;
      source.onended = () => {
        if (this.activeSource === source) {
          this.activeSource = null;
        }
        resolve();
      };
      source.start();
    });
  }

  private playViaHtmlAudio(wavUrl: string, volume: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      try {
        if (!this.activeHtmlAudio) {
          const el = document.createElement("audio");
          el.setAttribute("playsinline", "true");
          el.style.display = "none";
          document.body?.appendChild(el);
          this.activeHtmlAudio = el;
        }
        const el = this.activeHtmlAudio;
        el.pause();
        el.src = wavUrl;
        el.volume = Math.max(0, Math.min(1, volume));
        const cleanup = (ok: boolean) => {
          el.onended = null;
          el.onerror = null;
          resolve(ok);
        };
        el.onended = () => cleanup(true);
        el.onerror = () => cleanup(false);
        el.play().catch(() => cleanup(false));
      } catch {
        resolve(false);
      }
    });
  }

  private setWavCache(key: string, url: string): void {
    if (this.wavUrlCache.has(key)) {
      const prev = this.wavUrlCache.get(key);
      if (prev && prev !== url) URL.revokeObjectURL(prev);
      this.wavUrlCache.delete(key);
    } else if (this.wavUrlCache.size >= MAX_AUDIO_CACHE_ENTRIES) {
      const oldest = this.wavUrlCache.keys().next().value;
      if (oldest !== undefined) {
        const prev = this.wavUrlCache.get(oldest);
        if (prev) URL.revokeObjectURL(prev);
        this.wavUrlCache.delete(oldest);
      }
    }
    this.wavUrlCache.set(key, url);
  }

  private setCache(key: string, buf: AudioBuffer): void {
    if (this.audioCache.has(key)) {
      this.audioCache.delete(key);
    } else if (this.audioCache.size >= MAX_AUDIO_CACHE_ENTRIES) {
      const oldest = this.audioCache.keys().next().value;
      if (oldest !== undefined) {
        this.audioCache.delete(oldest);
      }
    }
    this.audioCache.set(key, buf);
  }

  private getOrCreateWorker(): Worker | null {
    if (this.workerBroken || typeof Worker === "undefined") {
      return null;
    }
    if (this.worker) {
      return this.worker;
    }
    try {
      const blob = new Blob([PIPER_WORKER_SOURCE], { type: "text/javascript" });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url);
      URL.revokeObjectURL(url);

      worker.onmessage = (e: MessageEvent) => {
        const data = e.data;
        if (!data || typeof data.reqId !== "number") return;
        const pending = this.pendingWorkerReqs.get(data.reqId);
        if (!pending) return;
        this.pendingWorkerReqs.delete(data.reqId);
        if (data.type === "error") {
          pending.reject(new Error(data.error || "Piper worker error"));
        } else {
          pending.resolve(data);
        }
      };

      worker.onerror = (err) => {
        this.workerBroken = true;
        this.worker = null;
        for (const [, p] of this.pendingWorkerReqs) {
          p.reject(new Error(err.message || "Piper worker crashed"));
        }
        this.pendingWorkerReqs.clear();
      };

      this.worker = worker;
      return worker;
    } catch {
      this.workerBroken = true;
      return null;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private callWorker(payload: Record<string, unknown>): Promise<any> {
    const worker = this.getOrCreateWorker();
    if (!worker) {
      return Promise.reject(new Error("Worker unavailable"));
    }
    const reqId = this.nextReqId++;
    return new Promise((resolve, reject) => {
      this.pendingWorkerReqs.set(reqId, { resolve, reject });
      worker.postMessage({ ...payload, reqId });
    });
  }

  private async synthesizePcm(
    normalizedText: string,
    desc: PiperVoiceDescriptor,
    rate: number
  ): Promise<{ pcm: Float32Array; sampleRate: number }> {
    const loaded = await this.ensureVoiceSession(desc);

    if (this.worker && !this.workerBroken) {
      const res = await this.callWorker({
        type: "synthesize",
        voiceId: desc.voiceId,
        normalizedText,
        rate,
      });
      return {
        pcm: new Float32Array(res.pcmBuffer as ArrayBuffer),
        sampleRate: Number(res.sampleRate) || 22050,
      };
    }

    // Fallback main-thread path if Worker is unavailable
    const createPhonemize = this.createPiperPhonemize!;
    const ort = this.ort!;

    const inputJson = JSON.stringify([{ text: normalizedText }]);
    const phonemeIds: number[] = await new Promise((resolve, reject) => {
      createPhonemize({
        print: (out: string) => {
          try {
            resolve(JSON.parse(out).phoneme_ids);
          } catch (err) {
            reject(err);
          }
        },
        printErr: (errText: string) => {
          reject(new Error(errText));
        },
        locateFile: (url: string) => {
          if (url.endsWith(".wasm")) return this.piperWasmBlobUrl;
          if (url.endsWith(".data")) return this.piperDataBlobUrl;
          return url;
        },
      })
        .then((mod) => {
          mod.callMain([
            "-l",
            loaded.config.espeak.voice,
            "--input",
            inputJson,
            "--espeak_data",
            "/espeak-ng-data",
          ]);
        })
        .catch(reject);
    });

    const noiseScale = loaded.config.inference.noise_scale;
    const lengthScale = loaded.config.inference.length_scale / rate;
    const noiseW = Math.min(loaded.config.inference.noise_w, 0.35);

    const feeds: Record<string, unknown> = {
      input: new ort.Tensor("int64", phonemeIds, [1, phonemeIds.length]),
      input_lengths: new ort.Tensor("int64", [phonemeIds.length]),
      scales: new ort.Tensor("float32", [noiseScale, lengthScale, noiseW]),
    };
    if (loaded.config.speaker_id_map && Object.keys(loaded.config.speaker_id_map).length > 0) {
      feeds.sid = new ort.Tensor("int64", [0]);
    }

    const results = await loaded.session.run(feeds);
    const rawData = results.output.data as Float32Array;
    return {
      pcm: new Float32Array(rawData),
      sampleRate: loaded.config.audio.sample_rate || 22050,
    };
  }

  private ensureRuntime(): Promise<void> {
    if (!this.runtimePromise) {
      this.runtimePromise = this.initRuntime().catch((err) => {
        this.runtimePromise = null;
        throw err;
      });
    }
    return this.runtimePromise;
  }

  private async initRuntime(): Promise<void> {
    const [piperJsBlob, piperWasmBlob, piperDataBlob, ortJsBlob, ortWasmBlob] = await Promise.all([
      this.getOrFetchBlob("piper-o91UDS6e.mjs", PIPER_JS_URL, "text/javascript"),
      this.getOrFetchBlob("piper_phonemize.wasm", PIPER_WASM_URL, "application/wasm"),
      this.getOrFetchBlob("piper_phonemize.data", PIPER_DATA_URL, "application/octet-stream"),
      this.getOrFetchBlob("ort.wasm.min.mjs", ORT_JS_URL, "text/javascript"),
      this.getOrFetchBlob("ort-wasm-simd.wasm", ORT_WASM_SIMD_URL, "application/wasm"),
    ]);

    const worker = this.getOrCreateWorker();
    if (worker) {
      try {
        await this.callWorker({
          type: "init-runtime",
          piperJsBlob,
          piperWasmBlob,
          piperDataBlob,
          ortJsBlob,
          ortWasmBlob,
        });
        return;
      } catch {
        this.workerBroken = true;
        this.worker = null;
      }
    }

    this.piperWasmBlobUrl = URL.createObjectURL(piperWasmBlob);
    this.piperDataBlobUrl = URL.createObjectURL(piperDataBlob);
    const ortWasmBlobUrl = URL.createObjectURL(ortWasmBlob);

    const piperJsUrl = URL.createObjectURL(
      new Blob([await piperJsBlob.arrayBuffer()], { type: "text/javascript" })
    );
    const ortJsUrl = URL.createObjectURL(
      new Blob([await ortJsBlob.arrayBuffer()], { type: "text/javascript" })
    );

    try {
      const piperMod = await runtimeImport<{
        createPiperPhonemize: (opts: Record<string, unknown>) => Promise<unknown>;
      }>(piperJsUrl);
      this.createPiperPhonemize = piperMod.createPiperPhonemize;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ortMod = await runtimeImport<any>(ortJsUrl);
      const ort = ortMod.default ?? ortMod;
      if (ort.env) {
        ort.env.allowLocalModels = false;
        if (ort.env.wasm) {
          ort.env.wasm.numThreads = 1;
          ort.env.wasm.simd = true;
          ort.env.wasm.wasmPaths = {
            "ort-wasm-simd.wasm": ortWasmBlobUrl,
            "ort-wasm.wasm": ortWasmBlobUrl,
          };
        }
      }
      this.ort = ort;
    } finally {
      URL.revokeObjectURL(piperJsUrl);
      URL.revokeObjectURL(ortJsUrl);
    }
  }

  private ensureVoiceSession(desc: PiperVoiceDescriptor): Promise<LoadedVoiceSession> {
    const existing = this.voiceSessions.get(desc.voiceId);
    if (existing) return existing;

    const promise = this.loadVoiceSession(desc).catch((err) => {
      this.voiceSessions.delete(desc.voiceId);
      this.downloadProgress.delete(desc.voiceId);
      this.onStatusChange();
      throw err;
    });
    this.voiceSessions.set(desc.voiceId, promise);
    return promise;
  }

  private async loadVoiceSession(desc: PiperVoiceDescriptor): Promise<LoadedVoiceSession> {
    if (!this.cachedVoices.has(desc.voiceId)) {
      this.downloadProgress.set(desc.voiceId, 0);
      this.onStatusChange();
    }

    await this.ensureRuntime();

    const configUrl = `${HF_BASE}/${desc.modelPath}.json`;
    const modelUrl = `${HF_BASE}/${desc.modelPath}`;

    const configBlob = await this.getOrFetchBlob(
      `${desc.voiceId}.onnx.json`,
      configUrl,
      "application/json"
    );
    const config = JSON.parse(await configBlob.text()) as PiperModelConfig;

    const modelBlob = await this.getOrFetchBlob(
      `${desc.voiceId}.onnx`,
      modelUrl,
      "application/octet-stream",
      (loaded, total) => {
        if (total > 0) {
          const pct = Math.min(99, Math.round((loaded / total) * 100));
          if (this.downloadProgress.get(desc.voiceId) !== pct) {
            this.downloadProgress.set(desc.voiceId, pct);
            this.onStatusChange();
          }
        }
      }
    );

    if (this.worker && !this.workerBroken) {
      await this.callWorker({
        type: "load-voice",
        voiceId: desc.voiceId,
        config,
        modelBlob,
      });

      this.downloadProgress.delete(desc.voiceId);
      this.cachedVoices.add(desc.voiceId);
      this.readySessions.add(desc.voiceId);
      this.onStatusChange();

      return {
        voiceId: desc.voiceId,
        config,
      };
    }

    const modelBytes = await modelBlob.arrayBuffer();
    const session = await this.ort.InferenceSession.create(modelBytes, {
      executionProviders: ["wasm"],
    });

    this.downloadProgress.delete(desc.voiceId);
    this.cachedVoices.add(desc.voiceId);
    this.readySessions.add(desc.voiceId);
    this.onStatusChange();

    return {
      voiceId: desc.voiceId,
      config,
      session,
    };
  }

  private async getOpfsDir(): Promise<FileSystemDirectoryHandle | null> {
    try {
      if (!navigator.storage || typeof navigator.storage.getDirectory !== "function") {
        return null;
      }
      const root = await navigator.storage.getDirectory();
      return await root.getDirectoryHandle("piper", { create: true });
    } catch {
      return null;
    }
  }

  private async getOrFetchBlob(
    filename: string,
    url: string,
    mimeType: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<Blob> {
    const mem = this.memoryBlobs.get(filename);
    if (mem && mem.size > 0) {
      return mem;
    }

    const dir = await this.getOpfsDir();
    if (dir) {
      try {
        const handle = await dir.getFileHandle(filename);
        const file = await handle.getFile();
        if (file.size > 0) {
          return new Blob([file], { type: mimeType });
        }
      } catch {
        // Not in OPFS yet; fetch below
      }
    }

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch ${filename} (${res.status})`);
    }
    const total = Number(res.headers.get("Content-Length") ?? 0);
    const reader = res.body?.getReader();
    let blob: Blob;
    if (reader) {
      const chunks: Uint8Array[] = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          loaded += value.byteLength;
          onProgress?.(loaded, total);
        }
      }
      blob = new Blob(chunks as BlobPart[], { type: mimeType });
    } else {
      blob = new Blob([await res.arrayBuffer()], { type: mimeType });
    }

    if (dir) {
      try {
        const handle = await dir.getFileHandle(filename, { create: true });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      } catch {
        this.memoryBlobs.set(filename, blob);
      }
    } else {
      this.memoryBlobs.set(filename, blob);
    }

    return blob;
  }
}

function encodeFloat32ToWavBlobUrl(pcm: Float32Array, sampleRate: number): string {
  const numSamples = pcm.length;
  const byteRate = sampleRate * 2;
  const dataSize = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}
