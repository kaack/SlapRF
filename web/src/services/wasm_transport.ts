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
    this.readyPromise = this.bootWasm();
    return this.readyPromise;
  }

  private async bootWasm(): Promise<SlaprfWasmBridge> {
    if (!window.Go) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "./wasm/wasm_exec.js";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load ./wasm/wasm_exec.js"));
        document.head.appendChild(script);
      });
    }
    const go = new window.Go!();
    const wasmUrl = "./wasm/slaprf.wasm";
    let instance: WebAssembly.Instance;
    if ("instantiateStreaming" in WebAssembly) {
      try {
        const res = await WebAssembly.instantiateStreaming(fetch(wasmUrl), go.importObject);
        instance = res.instance;
      } catch {
        const buf = await (await fetch(wasmUrl)).arrayBuffer();
        const res = await WebAssembly.instantiate(buf, go.importObject);
        instance = res.instance;
      }
    } else {
      const buf = await (await fetch(wasmUrl)).arrayBuffer();
      const res = await WebAssembly.instantiate(buf, go.importObject);
      instance = res.instance;
    }

    // Start the Go WASM runtime (non-blocking; registers window.slaprfWasm before select{}).
    void go.run(instance);

    for (let i = 0; i < 50 && !window.slaprfWasm; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (!window.slaprfWasm) {
      throw new Error("slaprfWasm failed to initialize");
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
    wifiPass: string
  ): Promise<FirmwareImageResult> {
    const wasm = await this.ensureReady();
    const params = new URLSearchParams({ role });
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
      filename: `slaprf-xiao-c5-${slug}.bin`,
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
