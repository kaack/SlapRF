import { StreamEnvelope } from "../types/models";
import { ApiTransport, FirmwareImageResult } from "./transport";

const SIM_STORAGE_KEY = "slaprf.sim_state.v1";

interface SlaprfWasmBridge {
  request(method: string, url: string, body?: string): { status: number; body: string };
  fetchBytes(url: string): { status: number; bytes: Uint8Array; sha256: string };
  onStream(cb: ((envelopeJson: string) => void) | null): void;
  setRunning(running: boolean): void;
  exportSimState?(): string;
  restoreSimState?(jsonStr: string): boolean;
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
  }
}

/**
 * In-browser WebAssembly transport backed by `cmd/slaprf-wasm` (`slaprf.wasm`).
 * Shares the exact same Go `internal/domain`, `internal/dsp`, `internal/tracker`,
 * `internal/ingest`, `internal/firmware`, and `internal/api` packages as the native binary.
 */
export class WasmSimTransport implements ApiTransport {
  private readyPromise: Promise<SlaprfWasmBridge> | null = null;
  private streamCallback: ((msg: StreamEnvelope) => void) | null = null;
  private persistTimer: number | null = null;
  private unloadBound = false;

  private persistNow(wasm?: SlaprfWasmBridge | null): void {
    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const target = wasm ?? window.slaprfWasm;
    if (!target || typeof target.exportSimState !== "function") return;
    try {
      const json = target.exportSimState();
      if (json) {
        window.localStorage.setItem(SIM_STORAGE_KEY, json);
      }
    } catch {
      // Ignore storage quota or private-browsing errors
    }
  }

  private schedulePersist(wasm: SlaprfWasmBridge): void {
    if (this.persistTimer !== null) return;
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      this.persistNow(wasm);
    }, 350);
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
    window.__slaprfBootStatus?.("Loading WebAssembly runtime…", 18);
    if (!window.Go) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "./wasm/wasm_exec.js?v=206";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load ./wasm/wasm_exec.js"));
        document.head.appendChild(script);
      });
    }

    window.__slaprfBootStatus?.("Downloading SlapRF 5.8 GHz timing engine…", 28);
    const go = new window.Go!();
    const wasmUrl = "./wasm/slaprf.wasm?v=206";

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

    window.__slaprfBootStatus?.("Hydrating track state…", 95);
    try {
      if (!window.localStorage.getItem(SIM_STORAGE_KEY)) {
        this.persistNow(window.slaprfWasm);
      }
    } catch {
      // Ignore storage access errors
    }
    if (!this.unloadBound) {
      this.unloadBound = true;
      const flush = () => this.persistNow(window.slaprfWasm);
      window.addEventListener("pagehide", flush);
      window.addEventListener("beforeunload", flush);
    }
    if (this.streamCallback) {
      this.bindStream(window.slaprfWasm, this.streamCallback);
    }
    return window.slaprfWasm;
  }

  private bindStream(wasm: SlaprfWasmBridge, onEnvelope: (msg: StreamEnvelope) => void): void {
    wasm.setRunning(true);
    wasm.onStream((raw: string) => {
      try {
        const env = JSON.parse(raw) as StreamEnvelope;
        if (env.type !== "telemetry") {
          this.schedulePersist(wasm);
        }
        onEnvelope(env);
      } catch (err) {
        console.error("[WasmSimTransport] stream parse error:", err);
      }
    });
  }

  public async request<T = unknown>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
    const wasm = await this.ensureReady();
    wasm.setRunning(true);
    const res = wasm.request(method, url, body !== undefined ? JSON.stringify(body) : "");
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`WASM ${method} ${url} failed (${res.status}): ${res.body}`);
    }
    if (method === "POST") {
      this.persistNow(wasm);
    }
    return JSON.parse(res.body) as T;
  }

  /**
   * The in-browser engine has no access to the compiled firmware images, so defer to the
   * browser patcher (`buildOrPatchFirmwareBin`), which fetches `./firmware/<profile>.bin`.
   */
  public async fetchFirmwareImage(
    _role: "hub" | "spoke",
    _timerLabel: string,
    _wifiSSID: string,
    _wifiPass: string,
    _profile: string,
    _fingerprint: string
  ): Promise<FirmwareImageResult> {
    throw new Error("Firmware images are patched in the browser in simulation mode.");
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
      this.persistNow(window.slaprfWasm);
      window.slaprfWasm.onStream(null);
      window.slaprfWasm.setRunning(false);
    }
  }

  public async exportSimStateJson(): Promise<string> {
    if (window.slaprfWasm && typeof window.slaprfWasm.exportSimState === "function") {
      this.persistNow(window.slaprfWasm);
      return window.slaprfWasm.exportSimState() || "";
    }
    try {
      const saved = window.localStorage.getItem(SIM_STORAGE_KEY);
      if (saved) return saved;
    } catch {
      // ignore
    }
    const wasm = await this.ensureReady();
    this.persistNow(wasm);
    return wasm.exportSimState?.() ?? "";
  }

  public async importSimStateJson(jsonStr: string): Promise<boolean> {
    try {
      window.localStorage.setItem(SIM_STORAGE_KEY, jsonStr);
    } catch {
      // ignore
    }
    if (window.slaprfWasm && typeof window.slaprfWasm.restoreSimState === "function") {
      return window.slaprfWasm.restoreSimState(jsonStr);
    }
    const wasm = await this.ensureReady();
    return wasm.restoreSimState?.(jsonStr) ?? false;
  }
}
