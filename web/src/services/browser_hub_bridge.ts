import { usbPool } from "./timer_console";
import { WasmSimTransport } from "./wasm_transport";

export type ConnectionLedColor = "neon" | "blue" | "yellow" | "red" | "gray";

export interface ConnectionLedSummary {
  color: ConnectionLedColor;
  shortLabel: string;
  detail: string;
}

/** True if a `[len][frame]…` batch holds a 36-byte HELLO (0xC5 0x5A) frame. */
function containsHello(packed: Uint8Array): boolean {
  for (let o = 0; o < packed.length; o += 1 + packed[o]) {
    if (packed[o] === 36 && packed[o + 1] === 0xc5 && packed[o + 2] === 0x5a) return true;
  }
  return false;
}

/**
 * Connects the in-browser WebAssembly timing engine (`slaprf.wasm`) to the physical Hub — a
 * XIAO ESP32-C5 USB dongle — over USB-C via `sharedTimerConsole` (WebSerial). Hub packets arrive
 * as binary records and are fed into the engine; outbound channel-table frames from the engine
 * are written back to the Hub over the same serial link.
 */
export class BrowserHubBridge {
  private readonly wasm: WasmSimTransport;
  private readonly listeners = new Set<() => void>();
  private active = false;

  public usbFramesRx = 0;
  private lastStreamNotifyMs = 0;
  public onPacketIngested?: () => void;

  constructor(wasm: WasmSimTransport) {
    this.wasm = wasm;

    // Forward outbound 19-byte channel table frames (0xC5 0x5E) from WASM to the Hub over USB-C
    this.wasm.onHubCommand((pkt) => {
      const hub = usbPool.hubConsole();
      if (hub) {
        hub.sendNetChannelsFromPacket(pkt);
      }
    });

    // Forward inbound Hub/Spoke binary frames received over USB-C WebSerial into WASM: every frame
    // of one USB read goes in with a single WASM call, synchronously (no throttling / coalescing
    // of data). Only the slow-changing UI counters below are refreshed at most every 500 ms.
    for (const c of usbPool.slots) {
      c.subscribe({
        onHubPackets: (packed, count) => {
          this.usbFramesRx += count;
          if (this.active) {
            this.wasm.ingestHubPackets(packed, count);
            if (this.onPacketIngested && containsHello(packed)) {
              this.onPacketIngested();
            }
          }
          const nowMs = performance.now();
          if (this.usbFramesRx === count || nowMs - this.lastStreamNotifyMs >= 500) {
            this.lastStreamNotifyMs = nowMs;
            this.notify();
          }
        },
        onConnect: () => {
          window.setTimeout(() => this.wasm.pushHubChannels(), 350);
          this.notify();
        },
        onDisconnect: () => {
          this.notify();
        },
      });
    }
    usbPool.onChange(() => this.notify());
  }

  /**
   * Computes the 5-state LED indicator summary used by the TopBar icon and Network page:
   * - `neon`: Connected to a Hub (USB-C role 1)
   * - `blue`: Connected to a Spoke (USB-C role 2)
   * - `yellow`: Connecting or lost connection and trying to reconnect
   * - `red`: All reconnect attempts failed (or Emergency Mode)
   * - `gray`: Disconnected
   */
  public getLedSummary(): ConnectionLedSummary {
    const main = usbPool.mainConsole;

    if ((main.reconnecting || main.busyLabel) && !main.connected) {
      const label = main.reconnecting
        ? `Reconnecting USB (${main.reconnectAttempt}/${main.maxReconnectAttempts})…`
        : `${main.busyLabel}…`;
      return {
        color: "yellow",
        shortLabel: "Reconnecting",
        detail: `${label} · click to open Network`,
      };
    }
    if (main.connected) {
      const s = main.lastStatus;
      const cfg = main.lastConfig;
      if (s?.emergencyMode) {
        return {
          color: "red",
          shortLabel: `${s.label || "Timer"} · Emergency`,
          detail: `${s.label || "Timer"} is in Emergency Mode · click to open Network`,
        };
      }
      if (main.isOtherDevice) {
        return {
          color: "red",
          shortLabel: "Other · Unflashed",
          detail: "Connected XIAO ESP32-C5 (Other) has no SlapRF firmware · open Flasher to write firmware",
        };
      }
      if (s?.role === 1 || cfg?.role === "hub") {
        const hubName = s?.label || cfg?.timerLabel || "H1";
        return {
          color: "neon",
          shortLabel: `${hubName} · Hub`,
          detail: `Connected to Hub ${hubName} over USB-C · click to open Network`,
        };
      }
      if (s?.role === 2 || cfg?.role === "spoke") {
        const spokeName = s?.label || cfg?.timerLabel || "T1";
        return {
          color: "blue",
          shortLabel: `${spokeName} · Spoke`,
          detail: `Connected to Spoke ${spokeName} (Slot ${s?.slot || "?"}) over USB-C · click to open Network`,
        };
      }
      return {
        color: "yellow",
        shortLabel: "Connecting…",
        detail: "Reading timer identity over USB-C…",
      };
    }

    if (main.reconnectFailed) {
      return {
        color: "red",
        shortLabel: "USB Failed",
        detail: `${main.lastError || "USB reconnect failed"} · click to open Network`,
      };
    }

    return {
      color: "gray",
      shortLabel: "Disconnected",
      detail: "No timer connected · click to open Network",
    };
  }

  public subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    this.listeners.forEach((fn) => {
      try {
        fn();
      } catch {
        // ignore listener errors
      }
    });
  }

  public setActive(active: boolean): void {
    this.active = active;
    this.notify();
  }
}
