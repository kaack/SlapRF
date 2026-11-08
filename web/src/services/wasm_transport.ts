import { StreamEnvelope } from "../types/models";
import { ApiTransport, FirmwareImageResult } from "./transport";

interface SlaprfWasmBridge {
  request(method: string, url: string, body?: string): { status: number; body: string };
  fetchBytes(url: string): { status: number; bytes: Uint8Array; sha256: string };
  onStream(cb: ((envelopeJson: string) => void) | null): void;
  setRunning(running: boolean): void;
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
        script.src = "./wasm/wasm_exec.js";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load ./wasm/wasm_exec.js"));
        document.head.appendChild(script);
      });
    }

    window.__slaprfBootStatus?.("Downloading SlapRF 5.8 GHz timing engine…", 28);
    const go = new window.Go!();
    const wasmUrl = "./wasm/slaprf.wasm";

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
    if (this.streamCallback) {
      this.bindStream(window.slaprfWasm, this.streamCallback);
    }
    return window.slaprfWasm;
  }

  private bindStream(wasm: SlaprfWasmBridge, onEnvelope: (msg: StreamEnvelope) => void): void {
    wasm.setRunning(true);
    wasm.onStream((raw: string) => {
      try {
        onEnvelope(JSON.parse(raw) as StreamEnvelope);
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
    return JSON.parse(res.body) as T;
  }

  public async fetchFirmwareImage(
    role: "hub" | "spoke",
    puckLabel: string,
    wifiSSID: string,
    wifiPass: string,
    firmwareVersion = "v0.1.4"
  ): Promise<FirmwareImageResult> {
    const wasm = await this.ensureReady();
    const params = new URLSearchParams({ role, version: firmwareVersion });
    if (puckLabel.trim()) params.set("label", puckLabel.trim());
    if (role === "hub" && wifiSSID.trim()) {
      params.set("ssid", wifiSSID.trim());
      params.set("pass", wifiPass);
    }
    const res = wasm.fetchBytes(`/api/firmware/xiao-c5.bin?${params.toString()}`);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`WASM firmware build failed: ${res.status}`);
    }
    const slug = puckLabel.trim() ? puckLabel.trim().replace(/[^a-zA-Z0-9_-]+/g, "-") : role;
    return {
      bytes: res.bytes,
      sha256: res.sha256 ?? "",
      filename: `slaprf-xiao-c5-${slug}-${firmwareVersion}.bin`,
    };
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
      window.slaprfWasm.onStream(null);
      window.slaprfWasm.setRunning(false);
    }
  }
}
