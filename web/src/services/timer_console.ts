/**
 * WebSerial client for a timer's USB debug console (firmware: components/slaprf_radio/slaprf_diag.c).
 *
 * The port carries three kinds of data: '@'-prefixed JSON reply lines, plain-text log lines
 * (after `LOG 1`), and the raw 160-byte SLAPRF02 block in answer to `SLAPRF?`.
 */
import { parseSlaprfConfigBlock, TimerReadout } from "./esp_flasher";

export interface TimerStatus {
  fw: string;
  role: number;
  profile: number;
  fp: string;
  label: string;
  uptimeMs: number;
  reset: string;
  boots: number;
  emergencyMode?: boolean;
  crashStreak?: number;
  heapFree: number;
  heapMin: number;
  sweepHz: number;
  sweeps: number;
  sweepUs: number;
  sweepUsMax: number;
  sweepBudgetUs: number;
  rf: { ok: boolean; enabled: boolean; gain: number; gainMax: number; floorDb: number };
  chip: { model: string; rev: string; mac: string; flashMB: number };
  net: { mode: string; stations: number };
  channel: number;
  slot: number;
  scanLive?: boolean;
  freqsTemporary: boolean;
  freqs: number[];
}

export interface LiveSample {
  /** Sweep counter (50 per second); gaps mean dropped lines. */
  n?: number;
  us: number;
  dbm: number[];
  /** LIVE 1: peak since the previous line. LIVE 2 (every sweep): same as dbm. */
  pk: number[];
  /** Readings more than 10 dB above the channel's floor since the previous line. */
  hits?: number[];
  /** Typical noise level per channel, dBm (-127 until learned). */
  floor?: number[];
}

export interface ScanResult {
  start: number;
  step: number;
  dbm: number[];
  /** Set on passes of a continuous scan (SCAN LIVE). */
  live?: boolean;
  /** How long the pass took, ms (continuous scan only). */
  passMs?: number;
}

export interface BootLog {
  which: "current" | "last";
  boots: number;
  reset: string;
  text: string;
}

export interface ConsoleHandlers {
  onStatus?: (s: TimerStatus) => void;
  onLive?: (s: LiveSample) => void;
  onScan?: (s: ScanResult) => void;
  onBootLog?: (l: BootLog) => void;
  onLog?: (line: string) => void;
  onRawReply?: (line: string, msgType?: string) => void;
  onConfig?: (c: TimerReadout) => void;
  onError?: (msg: string) => void;
  onDisconnect?: () => void;
}

interface SerialPortLike {
  open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
}

interface SerialLike {
  requestPort(o?: unknown): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
}

interface Waiter {
  type: string;
  resolve: (msg: unknown) => void;
  reject: (err: Error) => void;
  timer: number;
}

const ESPRESSIF_USB_VID = 0x303a;
const CONFIG_MAGIC = new TextEncoder().encode("SLAPRF02");
const CONFIG_LEN = 160;

function serial(): SerialLike {
  return (navigator as unknown as { serial: SerialLike }).serial;
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

export class TimerConsole {
  private port: SerialPortLike | null = null;
  private portInfo: { usbVendorId?: number; usbProductId?: number } | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private buf = new Uint8Array(0);
  private readonly decoder = new TextDecoder();
  private readonly handlers: ConsoleHandlers;
  private waiters: Waiter[] = [];
  /** While true, a dropped port is an expected restart, not a user-visible disconnect. */
  private expectingRestart = false;

  constructor(handlers: ConsoleHandlers) {
    this.handlers = handlers;
  }

  public get connected(): boolean {
    return this.port !== null;
  }

  public static supported(): boolean {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  public async connect(showAllPorts = false): Promise<void> {
    const port = await serial().requestPort(showAllPorts ? undefined : { filters: [{ usbVendorId: ESPRESSIF_USB_VID }] });
    await this.openPort(port);
  }

  private async openPort(port: SerialPortLike): Promise<void> {
    await port.open({ baudRate: 115200, bufferSize: 16384 });
    // Do NOT call port.setSignals({ dataTerminalReady: false, requestToSend: false }) here!
    // On Windows (usbser.sys), Chromium opens the port at (DTR=1, RTS=1) which is a no-op on
    // ESP32-C5 USB-Serial-JTAG, whereas clearing both lines executes CLRDTR before CLRRTS,
    // stepping through (DTR=0, RTS=1) which resets the ESP32-C5 core.
    this.port = port;
    this.portInfo = port.getInfo?.() ?? this.portInfo;
    this.buf = new Uint8Array(0);
    this.writer = port.writable?.getWriter() ?? null;
    this.reader = port.readable?.getReader() ?? null;
    void this.readLoop(port);
  }

  public async disconnect(): Promise<void> {
    await this.closePort();
    this.failWaiters("Disconnected");
    this.handlers.onDisconnect?.();
  }

  private async closePort(): Promise<void> {
    const port = this.port;
    this.port = null;
    try {
      await this.reader?.cancel();
    } catch {
      // ignore
    }
    try {
      this.reader?.releaseLock();
      this.writer?.releaseLock();
    } catch {
      // ignore
    }
    this.reader = null;
    this.writer = null;
    try {
      await port?.close();
    } catch {
      // ignore
    }
  }

  public async send(command: string): Promise<void> {
    if (!this.writer) throw new Error("Not connected");
    await this.writer.write(new TextEncoder().encode(command + "\n"));
  }

  /** Send `command` (optional) and resolve with the next message of `type` (`status`, `scan`, ...). */
  public request<T>(command: string | null, type: string, timeoutMs = 3000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        type,
        resolve: (m) => resolve(m as T),
        reject,
        timer: window.setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error(`No ${type} reply within ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
      if (command) {
        this.send(command).catch((err: Error) => {
          window.clearTimeout(waiter.timer);
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(err);
        });
      }
    });
  }

  /**
   * Probe `STATUS?` up to a few times after opening the port so that if the board was still
   * finishing boot (or flushing any partial line in its UART RX buffer), we catch its first
   * status reply cleanly without touching DTR/RTS lines.
   */
  public async ensureRunningApp(timeoutMs = 3000): Promise<TimerStatus | null> {
    if (!this.port) return null;
    const deadline = Date.now() + timeoutMs;
    let first = true;
    while (Date.now() < deadline && this.port) {
      try {
        const cmd = first ? "\nLIVE 0\nSTATUS?" : "\nSTATUS?";
        first = false;
        return await this.request<TimerStatus>(cmd, "status", 900);
      } catch {
        // retry after a short pause
      }
      await sleep(150);
    }
    return null;
  }

  /**
   * Restart the timer and reattach to it. The USB device re-enumerates on restart, so the old
   * port goes away; reopen the same device (matched by USB VID/PID) without the port picker.
   * Resolves with the first status after the restart.
   */
  public async restartAndReconnect(timeoutMs = 15000, cmd: "REBOOT" | "EMERGENCY" = "REBOOT"): Promise<TimerStatus> {
    const before = await this.request<TimerStatus>("STATUS?", "status", 2000).catch(() => null);
    this.expectingRestart = true;
    try {
      await this.send(cmd).catch(() => undefined);
      const deadline = Date.now() + timeoutMs;
      await sleep(600);
      while (Date.now() < deadline) {
        if (!this.port) {
          const ports = await serial().getPorts();
          const match = ports.find((p) => {
            const info = p.getInfo?.() ?? {};
            return (
              !this.portInfo ||
              (info.usbVendorId === this.portInfo.usbVendorId && info.usbProductId === this.portInfo.usbProductId)
            );
          });
          if (match) {
            try {
              await this.openPort(match);
            } catch {
              await sleep(400);
              continue;
            }
          } else {
            await sleep(300);
            continue;
          }
        }
        try {
          const s = await this.request<TimerStatus>("STATUS?", "status", 1500);
          // Same port may have stayed open; make sure this is really the new boot.
          if (!before || s.boots > before.boots || s.uptimeMs < before.uptimeMs) return s;
        } catch {
          // still booting
        }
        await sleep(400);
      }
      throw new Error("The timer didn't come back after restarting. Unplug it for 5 seconds, plug it back in, and reconnect.");
    } finally {
      this.expectingRestart = false;
    }
  }

  private failWaiters(reason: string): void {
    for (const w of this.waiters) {
      window.clearTimeout(w.timer);
      w.reject(new Error(reason));
    }
    this.waiters = [];
  }

  private async readLoop(port: SerialPortLike): Promise<void> {
    const reader = this.reader;
    try {
      while (reader && this.port === port) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) this.ingest(value);
      }
    } catch (err) {
      if (this.port === port && !this.expectingRestart) {
        this.handlers.onError?.(err instanceof Error ? err.message : String(err));
      }
    }
    if (this.port === port) {
      if (this.expectingRestart) {
        await this.closePort(); // Device is re-enumerating; restartAndReconnect() reopens it
      } else {
        await this.disconnect();
      }
    }
  }

  private ingest(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    for (;;) {
      const magicAt = indexOf(this.buf, CONFIG_MAGIC);
      const nl = this.buf.indexOf(0x0a);
      if (magicAt >= 0 && (nl < 0 || magicAt < nl)) {
        if (this.buf.length < magicAt + CONFIG_LEN) return; // wait for the rest of the block
        if (magicAt > 0) this.emitText(this.buf.subarray(0, magicAt));
        const parsed = parseSlaprfConfigBlock(this.buf.subarray(magicAt, magicAt + CONFIG_LEN));
        if (parsed) {
          this.handlers.onConfig?.(parsed);
          this.resolveWaiters("config", parsed);
        }
        this.buf = this.buf.slice(magicAt + CONFIG_LEN);
        continue;
      }
      if (nl < 0) {
        if (this.buf.length > 16384) {
          this.emitText(this.buf);
          this.buf = new Uint8Array(0);
        }
        return;
      }
      this.emitText(this.buf.subarray(0, nl));
      this.buf = this.buf.slice(nl + 1);
    }
  }

  private resolveWaiters(type: string, msg: unknown): void {
    const matched = this.waiters.filter((w) => w.type === type);
    if (!matched.length) return;
    this.waiters = this.waiters.filter((w) => w.type !== type);
    for (const w of matched) {
      window.clearTimeout(w.timer);
      w.resolve(msg);
    }
  }

  private emitText(bytes: Uint8Array): void {
    const line = this.decoder.decode(bytes).replace(/\r$/, "");
    if (!line) return;
    if (line.startsWith("@{")) {
      try {
        const msg = JSON.parse(line.slice(1)) as { t: string; msg?: string } & Record<string, unknown>;
        this.handlers.onRawReply?.(line, msg.t);
        this.resolveWaiters(msg.t, msg);
        switch (msg.t) {
          case "status":
            this.handlers.onStatus?.(msg as unknown as TimerStatus);
            return;
          case "live":
            this.handlers.onLive?.(msg as unknown as LiveSample);
            return;
          case "scan":
            this.handlers.onScan?.(msg as unknown as ScanResult);
            return;
          case "bootlog":
            this.handlers.onBootLog?.(msg as unknown as BootLog);
            return;
          case "err":
            // A command was refused: fail whatever is waiting rather than letting it time out.
            if (this.waiters.length) {
              this.failWaiters(msg.msg ?? "error");
            }
            return;
          default:
            return;
        }
      } catch {
        // fall through: show as log text
      }
    }
    this.handlers.onLog?.(line);
  }
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
