import { StreamEnvelope } from "../types/models";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Transport interface abstracting the connection to the SlapRF timing engine:
 * - `BackendHttpTransport`: Native Go backend over HTTP REST (`/v1/*`) + `/v1/ws/stream` WebSocket
 *   (used whenever running in Portable mode or connected remotely to a local/LAN Go server;
 *   zero WebAssembly and zero IndexedDB).
 * - `WasmSimTransport`: In-browser Demo Simulator backed by `slaprf.wasm` + `IndexedDB`
 *   (used strictly for Standalone Browser Demo Mode on `slaprf.app` when no server is connected).
 */
export interface ApiTransport {
  request<T = unknown>(method: HttpMethod, url: string, body?: unknown): Promise<T>;
  requestText?(method: HttpMethod, url: string, body?: unknown): Promise<string>;
  connectStream(onEnvelope: (msg: StreamEnvelope) => void): void;
  disconnectStream(): void;
  isStreamConnected?(): boolean;
  setSimRunning(running: boolean): Promise<void> | void;
  pushHubChannels(): void;
  exportSimStateJson(): Promise<string>;
  importSimStateJson(jsonStr: string): Promise<boolean>;
}
