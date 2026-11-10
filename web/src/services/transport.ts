import { StreamEnvelope } from "../types/models";

/**
 * Transport interface abstracting the connection to the timing engine. The only implementation
 * is `WasmSimTransport`: all API calls and the 50 Hz telemetry stream are served in-browser by
 * the Go timing & physics engine compiled to WebAssembly (`slaprf.wasm`), for both the simulator
 * and the physical Hub (fed over USB-C WebSerial), so the app runs as a pure static site.
 */
export interface ApiTransport {
  request<T = unknown>(method: "GET" | "POST", url: string, body?: unknown): Promise<T>;
  connectStream(onEnvelope: (msg: StreamEnvelope) => void): void;
  disconnectStream(): void;
}
