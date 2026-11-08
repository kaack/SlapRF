import { StreamEnvelope } from "../types/models";

export interface FirmwareImageResult {
  bytes: Uint8Array;
  sha256: string;
  filename: string;
}

/**
 * Transport interface abstracting the connection to the timing engine.
 * - In Simulation mode (`WasmSimTransport`), all API calls and the 50 Hz telemetry
 *   stream are served in-browser by the Go timing & physics engine compiled to
 *   WebAssembly (`slaprf.wasm`), allowing the app to run as a pure static GitHub Pages SPA.
 * - In Real-world mode (`HttpRealTransport`), all API calls and the 50 Hz SSE stream
 *   connect to the native Go backend (`/api/*` and `/api/stream`) for physical hardware.
 */
export interface ApiTransport {
  request<T = unknown>(method: "GET" | "POST", url: string, body?: unknown): Promise<T>;
  fetchFirmwareImage(
    role: "hub" | "spoke",
    puckLabel: string,
    wifiSSID: string,
    wifiPass: string,
    firmwareVersion?: string
  ): Promise<FirmwareImageResult>;
  connectStream(onEnvelope: (msg: StreamEnvelope) => void): void;
  disconnectStream(): void;
}
