import type { AppStore } from "../state/store";
import { sharedLapRFLink } from "./laprf_hardware_link";
import { sharedRHLink } from "./rh_hardware_link";
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
 * Coordinates the USB-C Hub/Spoke connection indicator (TopBar LED & Network status) and, when
 * running in Standalone Browser Demo Mode (`WasmSimTransport`), bridges simulated USB Hub packets
 * into `slaprf.wasm`. When connected to a Native Go Backend (`wasm === null`), all Hub frame
 * decoding and `NETCHANNELS` sync run natively in Go on the server.
 */
export class BrowserHubBridge {
  private readonly wasm: WasmSimTransport | null;
  private readonly listeners = new Set<() => void>();
  private active = false;

  public usbFramesRx = 0;
  private lastStreamNotifyMs = 0;
  public onPacketIngested?: () => void;

  constructor(wasm: WasmSimTransport | null) {
    this.wasm = wasm;

    if (this.wasm) {
      // Forward outbound 19-byte channel table frames (0xC5 0x5E) from WASM to the simulated Hub
      this.wasm.onHubCommand((pkt) => {
        const hub = usbPool.hubConsole();
        if (hub) {
          hub.sendNetChannelsFromPacket(pkt);
        }
      });
    }

    for (const c of usbPool.slots) {
      c.subscribe({
        onHubPackets: (packed, count) => {
          this.usbFramesRx += count;
          if (this.active && this.wasm) {
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
          if (this.wasm) {
            const wasmRef = this.wasm;
            window.setTimeout(() => wasmRef.pushHubChannels(), 350);
          }
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
   * Computes the LED indicator summary used by the TopBar icon and Network page,
   * reflecting the active timing hardware mode (`slaprf`, `laprf`, or `rotorhazard`):
   * - `neon`: Connected & ready (SlapRF Hub, LapRF 8-Way unit, or authenticated RotorHazard timer)
   * - `blue`: Connected to a SlapRF Spoke (USB-C role 2)
   * - `yellow`: Connecting / reconnecting, or RotorHazard connected as Guest (read-only)
   * - `red`: Reconnect failed or SlapRF Emergency Mode
   * - `gray`: Disconnected
   */
  public getLedSummary(store?: AppStore): ConnectionLedSummary {
    const hwMode = store?.timingHardwareMode ?? "slaprf";

    if (store && (hwMode === "rotorhazard" || hwMode === "rotorhazard_usb")) {
      const isUSB = hwMode === "rotorhazard_usb";
      const modeName = isUSB ? "RotorHazard USB" : "RotorHazard";
      const snaps = sharedRHLink.snapshots(store);
      const connectedSnaps = snaps.filter((s) => s.connected);
      const authedSnaps = connectedSnaps.filter((s) => s.authOk || isUSB);
      if (authedSnaps.length > 0) {
        const labels = authedSnaps.map((s) => s.label).join(", ");
        return {
          color: "neon",
          shortLabel:
            authedSnaps.length === 1
              ? `${authedSnaps[0].label} · ${modeName}`
              : `${authedSnaps.length} ${modeName}`,
          detail: `${modeName} connected (${labels}) · click to open Network`,
        };
      }
      if (connectedSnaps.length > 0) {
        const labels = connectedSnaps.map((s) => s.label).join(", ");
        return {
          color: "yellow",
          shortLabel: `${connectedSnaps[0].label} · Guest`,
          detail: `RotorHazard connected as Guest (${labels}) — admin login required for control · click to open Network`,
        };
      }
      return {
        color: "gray",
        shortLabel: "Disconnected",
        detail: `No ${modeName} timer connected · click to open Network`,
      };
    }

    if (store && (hwMode === "laprf" || hwMode === "laprf_usb")) {
      const snaps = sharedLapRFLink.snapshots(store);
      const connectedSnaps = snaps.filter((s) => s.connected);
      if (connectedSnaps.length > 0) {
        const labels = connectedSnaps.map((s) => s.label).join(", ");
        return {
          color: "neon",
          shortLabel:
            connectedSnaps.length === 1
              ? `${connectedSnaps[0].label} · LapRF`
              : `${connectedSnaps.length} LapRF`,
          detail: `LapRF 8-Way connected (${labels}) · click to open Network`,
        };
      }
      return {
        color: "gray",
        shortLabel: "Disconnected",
        detail: "No LapRF 8-Way timer connected · click to open Network",
      };
    }

    const main = usbPool.mainConsole;
    const isBleMode = hwMode === "slaprf_ble";

    if ((main.reconnecting || main.busyLabel) && !main.connected) {
      const label = main.reconnecting
        ? `Reconnecting ${isBleMode ? "Bluetooth" : "USB"} (${main.reconnectAttempt}/${main.maxReconnectAttempts})…`
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
      const via = main.transportLabel === "Bluetooth" || isBleMode ? "Bluetooth" : main.transportLabel;
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
          detail: `Connected to Hub ${hubName} over ${via} · click to open Network`,
        };
      }
      if (s?.role === 2 || cfg?.role === "spoke") {
        const spokeName = s?.label || cfg?.timerLabel || "T1";
        return {
          color: "blue",
          shortLabel: `${spokeName} · Spoke`,
          detail: `Connected to Spoke ${spokeName} (Slot ${s?.slot || "?"}) over ${via} · click to open Network`,
        };
      }
      return {
        color: "yellow",
        shortLabel: "Connecting…",
        detail: `Reading timer identity over ${via}…`,
      };
    }

    if (main.reconnectFailed) {
      return {
        color: "red",
        shortLabel: isBleMode ? "Bluetooth Failed" : "USB Failed",
        detail: `${main.lastError || (isBleMode ? "Bluetooth Hub connection failed" : "USB reconnect failed")} · click to open Network`,
      };
    }

    return {
      color: "gray",
      shortLabel: "Disconnected",
      detail: isBleMode
        ? "No SlapRF Bluetooth Hub connected · click to open Network"
        : "No timer connected · click to open Network",
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
