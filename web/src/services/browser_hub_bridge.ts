import { sharedTimerConsole } from "./timer_console";
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
      if (sharedTimerConsole.connected && sharedTimerConsole.lastStatus?.role === 1) {
        sharedTimerConsole.sendNetChannelsFromPacket(pkt);
      }
    });

    // Forward inbound Hub/Spoke binary frames received over USB-C WebSerial into WASM: every frame
    // of one USB read goes in with a single WASM call, synchronously (no throttling / coalescing
    // of data). Only the slow-changing UI counters below are refreshed at most every 500 ms.
    sharedTimerConsole.subscribe({
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
    sharedTimerConsole.onStateChange(() => this.notify());
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
    const usb = sharedTimerConsole;

    if (usb.reconnecting || usb.busyLabel) {
      const label = usb.reconnecting
        ? `Reconnecting USB (${usb.reconnectAttempt}/${usb.maxReconnectAttempts})…`
        : `${usb.busyLabel}…`;
      return {
        color: "yellow",
        shortLabel: "Reconnecting",
        detail: `${label} — click to open Network`,
      };
    }
    if (usb.connected) {
      const s = usb.lastStatus;
      if (s?.emergencyMode) {
        return {
          color: "red",
          shortLabel: `${s.label || "Timer"} · Emergency`,
          detail: `${s.label || "Timer"} is in Emergency Mode — click to open Network`,
        };
      }
      if (s && s.role === 2) {
        return {
          color: "blue",
          shortLabel: `${s.label || "S1"} · Spoke`,
          detail: `Connected to Spoke ${s.label || "S1"} (Slot ${s.slot || "?"}) over USB-C — click to open Network`,
        };
      }
      const hubName = s?.label || "H1";
      return {
        color: "neon",
        shortLabel: `${hubName} · Hub`,
        detail: `Connected to Hub ${hubName} over USB-C — click to open Network`,
      };
    }

    if (usb.reconnectFailed) {
      return {
        color: "red",
        shortLabel: "USB Failed",
        detail: `${usb.lastError || "USB reconnect failed"} — click to open Network`,
      };
    }

    return {
      color: "gray",
      shortLabel: "Disconnected",
      detail: "No timer connected — click to open Network",
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
