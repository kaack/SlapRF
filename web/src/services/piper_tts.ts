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
 * Normalizes lap-time decimals before passing to espeak-ng so `.00` is spoken as a whole
 * number (`14.00` -> `"14"`) and `.0X` fractional times (`14.08`, `19.02`) are spoken
 * smoothly as `"14 point zero 8"` with no pause.
 */
export function prepareTextForPiper(raw: string): string {
  return raw
    .trim()
    .replace(/\b(\d+)\.00\b/g, "$1")
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
  session: any;
}

const MAX_AUDIO_CACHE_ENTRIES = 120;

// Native browser dynamic import helper so esbuild's IIFE bundler leaves runtime ESM imports intact.
// eslint-disable-next-line @typescript-eslint/no- implied-eval
const runtimeImport = new Function("u", "return import(u)") as <T = unknown>(url: string) => Promise<T>;

/**
 * In-browser neural Text-to-Speech engine powered by Piper VITS + ONNX Runtime Web (WASM).
 * Caches both the WASM runtime and `.onnx` voice models in the browser's Origin Private
 * File System (OPFS) so the voice announcer works identically across all browsers and
 * 100% offline at the flying field.
 */
export class PiperNeuralTts {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private createPiperPhonemize: ((opts: Record<string, unknown>) => Promise<any>) | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ort: any = null;
  private piperWasmBlobUrl = "";
  private piperDataBlobUrl = "";
  private runtimePromise: Promise<void> | null = null;

  private readonly voiceSessions = new Map<string, Promise<LoadedVoiceSession>>();
  private readonly cachedVoices = new Set<string>();
  private readonly downloadProgress = new Map<string, number>();
  private readonly audioCache = new Map<string, AudioBuffer>();
  private readonly memoryBlobs = new Map<string, Blob>();
  private activeSource: AudioBufferSourceNode | null = null;
  private readonly onStatusChange: () => void;

  constructor(onStatusChange: () => void) {
    this.onStatusChange = onStatusChange;
    void this.refreshCachedVoices();
  }

  public isVoiceCached(uri: string): boolean {
    const desc = getPiperVoice(uri);
    return this.cachedVoices.has(desc.voiceId);
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
  }

  /**
   * Synthesizes `text` using the specified Piper voice and plays it through `ctx`.
   * Resolves when playback finishes (or is stopped).
   */
  public async speak(
    text: string,
    uri: string,
    rate: number,
    volume: number,
    ctx: AudioContext
  ): Promise<void> {
    const desc = getPiperVoice(uri);
    const clampedRate = Math.max(0.7, Math.min(1.8, rate || 1.0));
    const cacheKey = `${desc.voiceId}:${clampedRate.toFixed(2)}:${text.trim()}`;

    let audioBuffer = this.audioCache.get(cacheKey);
    if (!audioBuffer) {
      const { pcm, sampleRate } = await this.synthesizePcm(text, desc, clampedRate);
      audioBuffer = ctx.createBuffer(1, pcm.length, sampleRate);
      audioBuffer.getChannelData(0).set(pcm);
      this.setCache(cacheKey, audioBuffer);
    }

    await ctx.resume();
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

  private async synthesizePcm(
    text: string,
    desc: PiperVoiceDescriptor,
    rate: number
  ): Promise<{ pcm: Float32Array; sampleRate: number }> {
    const loaded = await this.ensureVoiceSession(desc);
    const createPhonemize = this.createPiperPhonemize!;
    const ort = this.ort!;

    const normalizedText = prepareTextForPiper(text);
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
    // Scale speaking speed directly inside VITS so pitch stays natural
    const lengthScale = loaded.config.inference.length_scale / rate;
    // Keep stochastic duration variance low (<= 0.35) so short diphthongs like "zero" / "oh"
    // are never randomly compressed between adjacent digits.
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
          // Single-threaded SIMD works on every origin without requiring COOP/COEP headers
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

    const modelBytes = await modelBlob.arrayBuffer();
    const session = await this.ort.InferenceSession.create(modelBytes, {
      executionProviders: ["wasm"],
    });

    this.downloadProgress.delete(desc.voiceId);
    this.cachedVoices.add(desc.voiceId);
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
