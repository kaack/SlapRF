import { StreamEnvelope } from "../types/models";
import { BootState, enginePersistence } from "./engine_persistence";
import { ApiTransport } from "./transport";

interface SlaprfWasmBridge {
  request(method: string, url: string, body?: string): { status: number; body: string };
  onStream(cb: ((envelopeJson: string) => void) | null): void;
  setRunning(running: boolean): void;
  ingestHubPacket?(bytes: Uint8Array): number;
  onHubCommand?(cb: ((pkt: Uint8Array) => void) | null): void;
  pushHubChannels?(): void;
  exportSimState?(): string;
  restoreSimState?(jsonStr: string): boolean;
  exportRealState?(): string;
  restoreRealState?(jsonStr: string): boolean;
}

declare global {
  interface Window {
    Go?: new () => {
      importObject: WebAssembly.Imports;
      run(instance: WebAssembly.Instance): Promise<void>;
    };
    slaprfWasm?: SlaprfWasmBridge;
    __slaprfWasmOnReady?: (wasm: SlaprfWasmBridge) => void;
    __slaprfBootStatus?: (detail: string, pct?: number) => void;
    /** Persisted engine state handed to the Go runtime at startup (read once by cmd/slaprf-wasm). */
    __slaprfBootState?: BootState;
  }
}

/**
 * In-browser WebAssembly transport backed by `cmd/slaprf-wasm` (`slaprf.wasm`).
 * Shares the exact same Go `internal/domain`, `internal/dsp`, `internal/tracker`,
 * `internal/ingest`, and `internal/api` packages as the Go tests and tools.
 */
export class WasmSimTransport implements ApiTransport {
  private readyPromise: Promise<SlaprfWasmBridge> | null = null;
  private streamCallback: ((msg: StreamEnvelope) => void) | null = null;
  private hubCommandCallback: ((pkt: Uint8Array) => void) | null = null;
  private simRunning = true;

  public setSimRunning(running: boolean): void {
    this.simRunning = running;
    if (window.slaprfWasm) {
      window.slaprfWasm.setRunning(running);
    }
  }

  private ensureReady(): Promise<SlaprfWasmBridge> {
    if (window.slaprfWasm) {
      return Promise.resolve(window.slaprfWasm);
    }
    if (this.readyPromise) {
      return this.readyPromise;
    }
    this.readyPromise = this.bootWasm().catch((err) => {
      this.readyPromise = null;
      throw err;
    });
    return this.readyPromise;
  }

  private async bootWasm(): Promise<SlaprfWasmBridge> {
    // Read the persisted engine state from IndexedDB in parallel with the wasm download.
    const bootStatePromise = enginePersistence.loadBootState();
    window.__slaprfBootStatus?.("Loading WebAssembly runtime…", 18);
    if (!window.Go) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "./wasm/wasm_exec.js?v=228";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load ./wasm/wasm_exec.js"));
        document.head.appendChild(script);
      });
    }

    window.__slaprfBootStatus?.("Downloading SlapRF 5.8 GHz timing engine…", 28);
    const go = new window.Go!();
    const wasmUrl = "./wasm/slaprf.wasm?v=228";

    const response = await fetch(wasmUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${wasmUrl} (${response.status})`);
    }

    const contentLength = Number(response.headers.get("Content-Length") ?? 0);
    const expectedTotal = contentLength > 0 ? contentLength : 8_224_489;
    let wasmBuffer: ArrayBuffer;

    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          loaded += value.byteLength;
          const dlRatio = Math.min(1, loaded / expectedTotal);
          const pct = Math.round(28 + dlRatio * 48);
          const mb = (loaded / (1024 * 1024)).toFixed(1);
          window.__slaprfBootStatus?.(`Downloading 5.8 GHz timing engine (${mb} MB)…`, pct);
        }
      }
      const combined = new Uint8Array(loaded);
      let offset = 0;
      for (const c of chunks) {
        combined.set(c, offset);
        offset += c.byteLength;
      }
      wasmBuffer = combined.buffer;
    } else {
      wasmBuffer = await response.arrayBuffer();
    }

    window.__slaprfBootStatus?.("Compiling WebAssembly & pre-warming track simulator…", 82);
    // Yield one frame so the browser paints the updated status before WebAssembly.instantiate
    await new Promise((r) => requestAnimationFrame(r));

    const instantiated = await WebAssembly.instantiate(wasmBuffer, go.importObject);
    const instance = instantiated.instance;

    const readyWait = new Promise<SlaprfWasmBridge>((resolve) => {
      window.__slaprfWasmOnReady = (bridge) => resolve(bridge);
    });

    // The Go runtime restores both engines from this before starting the simulator, so the very
    // first /api/state already contains the saved data (no empty-state flash, no prewarm waste).
    window.__slaprfBootStatus?.("Hydrating track state…", 90);
    window.__slaprfBootState = await bootStatePromise;

    // Start the Go WASM runtime (registers window.slaprfWasm and invokes __slaprfWasmOnReady).
    void go.run(instance);

    if (!window.slaprfWasm) {
      await Promise.race([
        readyWait,
        (async () => {
          for (let i = 0; i < 600 && !window.slaprfWasm; i++) {
            await new Promise((r) => setTimeout(r, 25));
          }
        })(),
      ]);
    }

    if (!window.slaprfWasm) {
      throw new Error("slaprfWasm failed to initialize");
    }

    // Boot state has been consumed by Go; drop the (potentially large) strings.
    delete window.__slaprfBootState;
    // Writes start only now: the engines hold the restored state, never the empty defaults.
    enginePersistence.attach(window.slaprfWasm);
    if (this.hubCommandCallback) {
      window.slaprfWasm.onHubCommand?.(this.hubCommandCallback);
    }
    if (this.streamCallback) {
      this.bindStream(window.slaprfWasm, this.streamCallback);
    }
    return window.slaprfWasm;
  }

  private bindStream(wasm: SlaprfWasmBridge, onEnvelope: (msg: StreamEnvelope) => void): void {
    wasm.setRunning(this.simRunning);
    wasm.onStream((raw: string) => {
      try {
        const env = JSON.parse(raw) as StreamEnvelope;
        if (env.type !== "telemetry") {
          enginePersistence.onStreamEvent(env.type, env.payload, this.simRunning);
        }
        onEnvelope(env);
      } catch (err) {
        console.error("[WasmSimTransport] stream parse error:", err);
      }
    });
  }

  public async request<T = unknown>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
    const wasm = await this.ensureReady();
    wasm.setRunning(this.simRunning);
    const res = wasm.request(method, url, body !== undefined ? JSON.stringify(body) : "");
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`WASM ${method} ${url} failed (${res.status}): ${res.body}`);
    }
    if (method === "POST") {
      enginePersistence.notePost();
    }
    return JSON.parse(res.body) as T;
  }

  public ingestHubPacket(bytes: Uint8Array): number {
    if (!window.slaprfWasm || typeof window.slaprfWasm.ingestHubPacket !== "function") {
      return 0;
    }
    enginePersistence.noteRealActivity();
    return window.slaprfWasm.ingestHubPacket(bytes);
  }

  public onHubCommand(cb: ((pkt: Uint8Array) => void) | null): void {
    this.hubCommandCallback = cb;
    if (window.slaprfWasm && typeof window.slaprfWasm.onHubCommand === "function") {
      window.slaprfWasm.onHubCommand(cb);
    } else if (cb) {
      void this.ensureReady().then((wasm) => {
        if (this.hubCommandCallback === cb) {
          wasm.onHubCommand?.(cb);
        }
      });
    }
  }

  public pushHubChannels(): void {
    window.slaprfWasm?.pushHubChannels?.();
  }

  public connectStream(onEnvelope: (msg: StreamEnvelope) => void): void {
    this.streamCallback = onEnvelope;
    void this.ensureReady().then((wasm) => {
      if (this.streamCallback === onEnvelope) {
        this.bindStream(wasm, onEnvelope);
      }
    });
  }

  public disconnectStream(): void {
    this.streamCallback = null;
    if (window.slaprfWasm) {
      // Mode switch / pagehide: persist whatever the active engine changed since the last save.
      enginePersistence.flushNow();
      window.slaprfWasm.onStream(null);
      window.slaprfWasm.setRunning(false);
    }
  }

  /** Live simulator state JSON (engine + options) straight from the WASM engine. */
  public async exportSimStateJson(): Promise<string> {
    const wasm = await this.ensureReady();
    return wasm.exportSimState?.() ?? "";
  }

  /** Restores the simulator engine; the caller persists via `enginePersistence.reconcileNow()`. */
  public async importSimStateJson(jsonStr: string): Promise<boolean> {
    const wasm = await this.ensureReady();
    const ok = wasm.restoreSimState?.(jsonStr) ?? false;
    if (ok) enginePersistence.notePost();
    return ok;
  }

  /** Live real-engine `PersistedEngineState` JSON straight from the WASM engine. */
  public async exportRealStateJson(): Promise<string> {
    const wasm = await this.ensureReady();
    return wasm.exportRealState?.() ?? "";
  }

  /** Restores the real engine; the caller persists via `enginePersistence.reconcileNow()`. */
  public async importRealStateJson(jsonStr: string): Promise<boolean> {
    const wasm = await this.ensureReady();
    const ok = wasm.restoreRealState?.(jsonStr) ?? false;
    if (ok) enginePersistence.notePost();
    return ok;
  }
}