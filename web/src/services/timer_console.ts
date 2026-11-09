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
  heapFree: number;
  heapMin: number;
  sweepHz: number;
  sweeps: number;
  sweepUs: number;
  sweepUsMax: number;
  rf: { ok: boolean; gain: number; gainMax: number; floorDb: number };
  channel: number;
  slot: number;
  freqs: number[];
}

export interface LiveSample {
  us: number;
  dbm: number[];
  pk: number[];
}

export interface ScanResult {
  start: number;
  step: number;
  dbm: number[];
}

export interface ConsoleHandlers {
  onStatus?: (s: TimerStatus) => void;
  onLive?: (s: LiveSample) => void;
  onScan?: (s: ScanResult) => void;
  onLog?: (line: string) => void;
  onConfig?: (c: TimerReadout) => void;
  onError?: (msg: string) => void;
  onDisconnect?: () => void;
}

interface SerialPortLike {
  open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
}

const ESPRESSIF_USB_VID = 0x303a;
const CONFIG_MAGIC = new TextEncoder().encode("SLAPRF02");
const CONFIG_LEN = 160;

export class TimerConsole {
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private buf = new Uint8Array(0);
  private readonly decoder = new TextDecoder();
  private readonly handlers: ConsoleHandlers;

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
    const serial = (navigator as unknown as { serial: { requestPort(o?: unknown): Promise<SerialPortLike> } }).serial;
    const port = await serial.requestPort(showAllPorts ? undefined : { filters: [{ usbVendorId: ESPRESSIF_USB_VID }] });
    await port.open({ baudRate: 115200, bufferSize: 16384 });
    // Keep EN / BOOT released: on USB-Serial-JTAG, DTR/RTS changes reset the chip.
    try {
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    } catch {
      // Not all platforms allow it; harmless.
    }
    this.port = port;
    this.writer = port.writable?.getWriter() ?? null;
    this.reader = port.readable?.getReader() ?? null;
    void this.readLoop();
  }

  public async disconnect(): Promise<void> {
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
    this.handlers.onDisconnect?.();
  }

  public async send(command: string): Promise<void> {
    if (!this.writer) throw new Error("Not connected");
    await this.writer.write(new TextEncoder().encode(command + "\n"));
  }

  private async readLoop(): Promise<void> {
    try {
      while (this.reader) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length) this.ingest(value);
      }
    } catch (err) {
      if (this.port) this.handlers.onError?.(err instanceof Error ? err.message : String(err));
    }
    if (this.port) await this.disconnect();
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
        if (parsed) this.handlers.onConfig?.(parsed);
        this.buf = this.buf.slice(magicAt + CONFIG_LEN);
        continue;
      }
      if (nl < 0) {
        if (this.buf.length > 4096) {
          this.emitText(this.buf);
          this.buf = new Uint8Array(0);
        }
        return;
      }
      this.emitText(this.buf.subarray(0, nl));
      this.buf = this.buf.slice(nl + 1);
    }
  }

  private emitText(bytes: Uint8Array): void {
    const line = this.decoder.decode(bytes).replace(/\r$/, "");
    if (!line) return;
    if (line.startsWith("@{")) {
      try {
        const msg = JSON.parse(line.slice(1)) as { t: string; msg?: string } & Record<string, unknown>;
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
          case "err":
            this.handlers.onError?.(msg.msg ?? "error");
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
