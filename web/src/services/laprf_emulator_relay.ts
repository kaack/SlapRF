/**
 * Native Go TCP `:5403` LapRF 8-Way server emulator controller (`internal/portable/laprf_emulator_manager.go`).
 *
 * When connected to a SlapRF Server (`caps.portable === true`), TCP `:5403` runs 100% natively
 * inside the Go binary (`laprf.Server`), persisted in `slaprf.db` (`BoltStore`), so external
 * LapRF-compatible race timing clients stay connected even if all browser tabs are closed.
 */

import { capabilitiesSnapshot, resolveBackendUrl, subscribeCapabilities } from "./capabilities";

const ENABLED_STORAGE_KEY = "slaprf.ui.laprf_emulator_enabled.v1";
export const LAPRF_EMULATOR_PORT = 5403;

export type RelayState = "off" | "connecting" | "connected" | "unreachable";
export type LapRFEmulatorClientState = "waiting" | "connected";

export interface LapRFEmulatorSnapshot {
  enabled: boolean;
  suppressed: boolean;
  relayState: RelayState;
  clientState: LapRFEmulatorClientState;
  peer: string;
  listenAddr: string;
  relayVersion: string;
  bytesIn: number;
  bytesOut: number;
  lastError: string;
}

export function emulatorWsUrl(port: number = LAPRF_EMULATOR_PORT): string {
  return resolveBackendUrl(`/v1/laprf-emulator?port=${port}`);
}

type Listener = (s: LapRFEmulatorSnapshot) => void;

export class LapRFEmulatorRelay {
  private enabled = false;
  private suppressed = false;
  private started = false;
  private pollTimer: number | null = null;
  private pollInFlight = false;
  private initialSynced = false;
  private readonly listeners = new Set<Listener>();

  private relayState: RelayState = "off";
  private clientState: LapRFEmulatorClientState = "waiting";
  private peer = "";
  private listenAddr = "";
  private relayVersion = "";
  private bytesIn = 0;
  private bytesOut = 0;
  private lastError = "";

  constructor() {
    try {
      this.enabled = window.localStorage.getItem(ENABLED_STORAGE_KEY) === "true";
    } catch {
      // Ignore storage access errors
    }
    subscribeCapabilities(() => {
      this.initialSynced = false;
      this.syncConnectionState();
    });
  }

  public get snapshot(): LapRFEmulatorSnapshot {
    return {
      enabled: this.enabled,
      suppressed: this.suppressed,
      relayState: this.relayState,
      clientState: this.clientState,
      peer: this.peer,
      listenAddr: this.listenAddr,
      relayVersion: this.relayVersion,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      lastError: this.lastError,
    };
  }

  public subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  public start(): void {
    this.started = true;
    this.syncConnectionState();
  }

  public setEnabled(enabled: boolean): void {
    if (enabled === this.enabled && capabilitiesSnapshot().portable) {
      void this.pushConfig(enabled);
      return;
    }
    this.enabled = enabled;
    try {
      window.localStorage.setItem(ENABLED_STORAGE_KEY, String(enabled));
    } catch {
      // Ignore storage access errors
    }
    this.lastError = "";
    if (capabilitiesSnapshot().portable) {
      this.relayState = enabled && !this.suppressed ? "connecting" : "off";
      this.emit();
      void this.pushConfig(enabled);
    } else {
      this.syncConnectionState();
    }
  }

  /** Suppresses TCP :5403 emulation while SlapRF is acting as a client to external LapRF 8-Way hardware. */
  public setSuppressed(suppressed: boolean): void {
    if (suppressed === this.suppressed) return;
    this.suppressed = suppressed;
    this.syncConnectionState();
  }

  public reconnect(): void {
    if (!capabilitiesSnapshot().portable) return;
    this.lastError = "";
    void this.pushConfig(this.enabled);
  }

  private syncConnectionState(): void {
    const caps = capabilitiesSnapshot();
    if (!this.started || !caps.portable || !caps.laprfEmulator) {
      this.stopPolling();
      this.relayState = "off";
      this.clientState = "waiting";
      this.peer = "";
      this.listenAddr = "";
      if (!this.enabled || this.suppressed || !caps.portable) {
        this.lastError = "";
      }
      this.emit();
      return;
    }

    this.ensurePolling();
    void this.pollBackend();
  }

  private ensurePolling(): void {
    if (this.pollTimer !== null || typeof window === "undefined") return;
    this.pollTimer = window.setInterval(() => {
      void this.pollBackend();
    }, 1500);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null && typeof window !== "undefined") {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pushConfig(enabled: boolean): Promise<void> {
    if (!capabilitiesSnapshot().portable) return;
    try {
      const resp = await fetch(resolveBackendUrl("/v1/laprf-emulator"), {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ enabled, port: LAPRF_EMULATOR_PORT }),
      });
      if (!resp.ok) {
        this.relayState = "unreachable";
        this.lastError = `Failed to configure TCP :${LAPRF_EMULATOR_PORT} (${resp.status})`;
        this.emit();
        return;
      }
      const data = (await resp.json()) as Partial<LapRFEmulatorSnapshot>;
      this.applySnapshot(data);
    } catch (err) {
      this.relayState = "unreachable";
      this.lastError = err instanceof Error ? err.message : String(err);
      this.emit();
    }
  }

  private async pollBackend(): Promise<void> {
    if (!capabilitiesSnapshot().portable || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const resp = await fetch(resolveBackendUrl("/v1/laprf-emulator"), {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!resp.ok) return;
      const data = (await resp.json()) as Partial<LapRFEmulatorSnapshot>;

      // First sync: if browser preference had LapRF emulator enabled before server stored it, apply it
      if (!this.initialSynced) {
        this.initialSynced = true;
        if (this.enabled && data.enabled === false) {
          this.pollInFlight = false;
          await this.pushConfig(true);
          return;
        }
      }

      this.applySnapshot(data);
    } catch {
      // Ignore transient network hiccups
    } finally {
      this.pollInFlight = false;
    }
  }

  private applySnapshot(data: Partial<LapRFEmulatorSnapshot>): void {
    const prev = JSON.stringify(this.snapshot);
    if (typeof data.enabled === "boolean") {
      this.enabled = data.enabled;
      try {
        window.localStorage.setItem(ENABLED_STORAGE_KEY, String(data.enabled));
      } catch {
        // Ignore storage errors
      }
    }
    if (typeof data.suppressed === "boolean") {
      this.suppressed = data.suppressed;
    }
    if (
      data.relayState === "off" ||
      data.relayState === "connecting" ||
      data.relayState === "connected" ||
      data.relayState === "unreachable"
    ) {
      this.relayState = data.relayState;
    }
    if (data.clientState === "waiting" || data.clientState === "connected") {
      this.clientState = data.clientState;
    }
    this.peer = data.peer ?? "";
    this.listenAddr = data.listenAddr ?? "";
    this.relayVersion = data.relayVersion ?? "";
    this.bytesIn = typeof data.bytesIn === "number" ? data.bytesIn : 0;
    this.bytesOut = typeof data.bytesOut === "number" ? data.bytesOut : 0;
    this.lastError = data.lastError ?? "";

    if (JSON.stringify(this.snapshot) !== prev) {
      this.emit();
    }
  }

  private emit(): void {
    const snap = this.snapshot;
    this.listeners.forEach((fn) => {
      try {
        fn(snap);
      } catch (err) {
        console.error("[LapRFEmulatorRelay] listener error:", err);
      }
    });
  }
}

const relayWin = (typeof window !== "undefined" ? window : undefined) as
  | (Window & { __slaprfLapRFEmulatorRelay?: LapRFEmulatorRelay })
  | undefined;

export const sharedLapRFEmulatorRelay: LapRFEmulatorRelay = (() => {
  if (relayWin?.__slaprfLapRFEmulatorRelay) {
    Object.setPrototypeOf(relayWin.__slaprfLapRFEmulatorRelay, LapRFEmulatorRelay.prototype);
    return relayWin.__slaprfLapRFEmulatorRelay;
  }
  const inst = new LapRFEmulatorRelay();
  if (relayWin) relayWin.__slaprfLapRFEmulatorRelay = inst;
  return inst;
})();
