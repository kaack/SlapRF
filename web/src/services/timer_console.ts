/**
 * WebSerial client for a timer's USB debug console (firmware: components/slaprf_radio/slaprf_diag.c).
 *
 * The port carries three kinds of data: '@'-prefixed JSON reply lines, plain-text log lines
 * (after `LOG 1`), and the raw 160-byte SLAPRF02 block in answer to `SLAPRF?`.
 */
import {
  haltBlankEsp32C5BootLoop,
  LATEST_FIRMWARE_VERSION,
  parseSlaprfConfigBlock,
  TimerReadout,
} from "./esp_flasher";

export interface TimerPeerSpoke {
  slot: number;
  fp: string;
  label: string;
  fw?: string;
  mac?: string;
  online?: boolean;
  msAgo?: number;
  frames?: number;
  seq?: number;
  dbm?: number[];
}

export interface TimerParentHub {
  fp?: string;
  label?: string;
  mac?: string;
  fw?: string;
  channel?: number;
  beaconMsAgo?: number;
  linked: boolean;
}

export interface KnownHardwareTimer {
  fp: string;
  role: "hub" | "spoke";
  label: string;
  fw?: string;
  mac?: string;
  slot?: number;
  channel?: number;
  parentHubFp?: string;
  lastSeenMs: number;
}

const KNOWN_TIMERS_STORAGE_KEY = "slaprf.hw.knownTimers";

export function getKnownHardwareTimers(): KnownHardwareTimer[] {
  const map = new Map<string, KnownHardwareTimer>();
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      const raw = window.localStorage.getItem(KNOWN_TIMERS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && typeof item === "object" && typeof (item as KnownHardwareTimer).fp === "string") {
              const t = item as KnownHardwareTimer;
              const fp = t.fp.toUpperCase();
              if (fp && fp !== "00000001" && !fp.startsWith("SIM000")) {
                const prev = map.get(fp);
                map.set(fp, { ...prev, ...t, fp });
              }
            }
          }
        }
      }
    } catch {
      // ignore storage errors
    }
  }
  return [...map.values()].sort((a, b) => b.lastSeenMs - a.lastSeenMs);
}

export function recordKnownHardwareTimer(entry: Partial<KnownHardwareTimer> & { fp: string }): void {
  const fp = (entry.fp || "").trim().toUpperCase();
  if (!fp || fp === "00000001" || fp.startsWith("SIM000")) return;
  const list = getKnownHardwareTimers();
  const byFp = new Map<string, KnownHardwareTimer>(list.map((t) => [t.fp.toUpperCase(), t]));
  const prev = byFp.get(fp);
  const role: "hub" | "spoke" = entry.role ?? prev?.role ?? "hub";
  const channel = entry.channel ?? prev?.channel ?? 1;
  const slot = entry.slot ?? prev?.slot ?? (role === "hub" ? 1 : undefined);

  // If a Spoke has an assigned TDMA slot (>= 2), associate it with the most recently seen Hub.
  let parentHubFp = entry.parentHubFp ?? prev?.parentHubFp;
  if (role === "spoke" && slot && slot >= 2 && !parentHubFp) {
    const matchingHub = list.find((t) => t.role === "hub");
    if (matchingHub) {
      parentHubFp = matchingHub.fp;
    }
  }

  // If a Spoke claims a TDMA slot (2..7) under the same Hub, clear that slot from any older Spoke record that was replaced.
  if (role === "spoke" && slot && slot >= 2) {
    for (const other of byFp.values()) {
      if (other.fp !== fp && other.role === "spoke" && other.slot === slot && (!parentHubFp || other.parentHubFp === parentHubFp)) {
        other.slot = undefined;
      }
    }
  }

  const merged: KnownHardwareTimer = {
    fp,
    role,
    label: entry.label || prev?.label || (role === "hub" ? "H1" : "S1"),
    fw: entry.fw || prev?.fw,
    mac: entry.mac || prev?.mac,
    slot,
    channel,
    parentHubFp: role === "spoke" ? parentHubFp : undefined,
    lastSeenMs: entry.lastSeenMs ?? Date.now(),
  };
  byFp.set(fp, merged);

  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.setItem(KNOWN_TIMERS_STORAGE_KEY, JSON.stringify([...byFp.values()]));
    } catch {
      // ignore storage errors
    }
  }
}

export function forgetKnownHardwareTimer(fp: string): void {
  const clean = (fp || "").trim().toUpperCase();
  if (!clean) return;
  const list = getKnownHardwareTimers().filter((t) => t.fp.toUpperCase() !== clean);
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.setItem(KNOWN_TIMERS_STORAGE_KEY, JSON.stringify(list));
    } catch {
      // ignore storage errors
    }
  }
}

export function recordKnownTimerStatus(s: TimerStatus): void {
  recordKnownHardwareTimer({
    fp: s.fp,
    role: s.role === 1 ? "hub" : "spoke",
    label: s.label,
    fw: s.fw,
    mac: s.chip?.mac,
    slot: s.slot || (s.role === 1 ? 1 : undefined),
    channel: s.channel || 1,
    parentHubFp: s.hub?.fp,
    lastSeenMs: Date.now(),
  });
  if (s.role === 1 && Array.isArray(s.spokes)) {
    for (const sp of s.spokes) {
      if (sp.fp) {
        recordKnownHardwareTimer({
          fp: sp.fp,
          role: "spoke",
          label: sp.label,
          fw: sp.fw,
          mac: sp.mac,
          slot: sp.slot,
          channel: s.channel || 1,
          parentHubFp: s.fp,
          lastSeenMs: Date.now(),
        });
      }
    }
  }
}

export function recordKnownTimerReadout(r: TimerReadout): void {
  if (r.status) {
    recordKnownTimerStatus(r.status);
  }
  recordKnownHardwareTimer({
    fp: r.fingerprint,
    role: r.role,
    label: r.timerLabel,
    fw: r.firmwareVersion,
    mac: r.status?.chip?.mac,
    slot: r.status?.slot ?? (r.role === "hub" ? 1 : undefined),
    channel: r.status?.channel ?? 1,
    lastSeenMs: Date.now(),
  });
}

export interface TimerStatus {
  fw: string;
  role: number;
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
  beaconMsAgo?: number;
  hub?: TimerParentHub;
  spokes?: TimerPeerSpoke[];
  scanLive?: boolean;
  freqsTemporary: boolean;
  chanMask?: number;
  freqs: number[];
  dbm?: number[];
  /** This board's LED is running the identify strobe. */
  identify?: boolean;
  /** Hub only: fingerprint of the Spoke it is currently telling to identify. */
  identifyFp?: string;
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
  onHubPacket?: (pkt: Uint8Array) => void;
  /**
   * Batched alternative to `onHubPacket`: every valid Hub frame parsed from one USB read, packed
   * as `[len u8][frame bytes]` records (`count` of them), delivered once per read. Subscribers
   * that define it don't get `onHubPacket`. The buffer is a fresh copy owned by the callee.
   */
  onHubPackets?: (packed: Uint8Array, count: number) => void;
  onConfig?: (c: TimerReadout) => void;
  onError?: (msg: string) => void;
  onConnect?: () => void;
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
/** Start byte of a binary Hub packet record on the USB link (ASCII Record Separator). */
const PKT_RECORD_SEP = 0x1e;

/** A Hub frame at `buf[at, at+len)` starts with 0xC5 and ends with the XOR of all preceding bytes. */
function isValidHubFrameAt(buf: Uint8Array, at: number, len: number): boolean {
  if (len < 4 || buf[at] !== 0xc5) return false;
  let crc = 0;
  const last = at + len - 1;
  for (let i = at; i < last; i++) crc ^= buf[i];
  return crc === buf[last];
}

/** First index of `value` in `buf[from, to)`, or -1. */
function indexOfByte(buf: Uint8Array, value: number, from: number, to: number): number {
  for (let i = from; i < to; i++) if (buf[i] === value) return i;
  return -1;
}

/** First index in `[from, startBefore)` where `needle` starts (it may extend up to `to`), or -1. */
function indexOfSeq(buf: Uint8Array, needle: Uint8Array, from: number, startBefore: number, to: number): number {
  const first = needle[0];
  const last = Math.min(startBefore, to - needle.length + 1);
  outer: for (let i = from; i < last; i++) {
    if (buf[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function serial(): SerialLike {
  return (navigator as unknown as { serial: SerialLike }).serial;
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

function withTimeout<T>(p: Promise<T> | undefined, ms: number): Promise<T | undefined> {
  if (!p) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve, reject) => {
    const t = window.setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (err) => {
        window.clearTimeout(t);
        reject(err);
      }
    );
  });
}

export class TimerConsole {
  private port: SerialPortLike | null = null;
  private portInfo: { usbVendorId?: number; usbProductId?: number } | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private lastKnownSpokeSig = "";
  /**
   * Receive buffer: unparsed bytes live in `buf[bufStart, bufEnd)`. Parsing advances `bufStart`
   * instead of re-slicing, and the buffer is compacted/grown only when a read doesn't fit, so a
   * large USB read costs O(n) rather than O(n²).
   */
  private buf = new Uint8Array(16384);
  private bufStart = 0;
  private bufEnd = 0;
  /** Hub frames parsed from the current read, packed as `[len][frame]`, flushed once per read. */
  private pack = new Uint8Array(4096);
  private packLen = 0;
  private packCount = 0;
  private readonly decoder = new TextDecoder();
  private readonly subscribers = new Set<ConsoleHandlers>();
  private readonly stateListeners = new Set<() => void>();
  private waiters: Waiter[] = [];
  private statusPollTimer = 0;
  /** When the last status line arrived (the board pushes one every ~1 s once a host is attached). */
  private lastStatusAtMs = 0;
  /** While true, a dropped port is an expected restart, not a user-visible disconnect. */
  private expectingRestart = false;
  private userDisconnecting = false;
  private sawRomBootloader = false;

  public readonly slotIndex: number;
  public lastStatus: TimerStatus | null = null;
  public lastConfig: TimerReadout | null = null;
  public probing = false;
  public writing = false;
  public hubOwnFrames = 0;
  public hubLastFrameAtMs = 0;
  public hubLastSeq: number | undefined = undefined;
  public hubLastDbm: number[] | undefined = undefined;
  public busyLabel: string | null = null;
  public showAllPorts = true;
  public reconnecting = false;
  public reconnectAttempt = 0;
  public readonly maxReconnectAttempts = 5;
  public reconnectFailed = false;
  public lastError: string | null = null;

  constructor(handlers?: ConsoleHandlers, slotIndex = 0) {
    this.slotIndex = slotIndex;
    if (handlers) {
      this.subscribers.add(handlers);
    }
  }

  public subscribe(handlers: ConsoleHandlers): () => void {
    this.subscribers.add(handlers);
    return () => {
      this.subscribers.delete(handlers);
    };
  }

  public onStateChange(fn: () => void): () => void {
    this.stateListeners.add(fn);
    return () => {
      this.stateListeners.delete(fn);
    };
  }

  public setBusyLabel(label: string | null): void {
    if (this.busyLabel === label) return;
    this.busyLabel = label;
    this.notifyStateChange();
  }

  private notifyStateChange(): void {
    this.stateListeners.forEach((fn) => {
      try {
        fn();
      } catch {
        // ignore listener errors
      }
    });
  }

  public get connected(): boolean {
    return this.port !== null || this.writing;
  }

  public get rawPort(): SerialPortLike | null {
    return this.port;
  }

  /** True when a USB port is open and probing finished without finding SlapRF timer firmware. */
  public get isOtherDevice(): boolean {
    return this.connected && !this.probing && !this.lastStatus && !this.lastConfig;
  }

  public ownsPort(candidate: unknown): boolean {
    return this.port !== null && this.port === candidate;
  }

  public async readSnapshot(): Promise<TimerReadout> {
    if (!this.connected) {
      throw new Error("Port is not connected.");
    }
    await this.send("STATUS?\nSLAPRF?");
    await sleep(360);
    const s = this.lastStatus;
    const cfg = this.lastConfig;
    if (!s && !cfg) {
      throw new Error("No SlapRF firmware detected on this board — flash it above first.");
    }
    return {
      chip: s?.chip ? `${s.chip.model} (${s.chip.rev})` : cfg?.chip || "Seeed XIAO ESP32-C5 (RISC-V 240 MHz)",
      role: cfg?.role ?? (s?.role === 1 ? "hub" : "spoke"),
      timerLabel: s?.label || cfg?.timerLabel || (s?.role === 1 ? "H1" : "S1"),
      fingerprint: s?.fp || cfg?.fingerprint || "",
      firmwareVersion: s?.fw || cfg?.firmwareVersion || LATEST_FIRMWARE_VERSION,
      frequenciesMHz: s?.freqs?.length ? s.freqs : cfg?.frequenciesMHz || [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917],
      status: s ? (s as unknown as TimerReadout["status"]) : cfg?.status,
    };
  }

  public static supported(): boolean {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  public async connect(showAllPorts = false): Promise<void> {
    this.showAllPorts = showAllPorts;
    this.userDisconnecting = false;
    this.reconnecting = false;
    this.reconnectAttempt = 0;
    this.reconnectFailed = false;
    this.lastError = null;
    this.notifyStateChange();
    const port = await serial().requestPort({ filters: [{ usbVendorId: ESPRESSIF_USB_VID }] });
    await this.openPort(port);
    this.startStatusPolling();
    this.subscribers.forEach((h) => h.onConnect?.());
    this.notifyStateChange();
  }

  /**
   * Opens an already-picked WebSerial port, probes `STATUS?` and `SLAPRF?`, and starts the status
   * heartbeat. If the port does not run SlapRF firmware, it stays connected as `"Other"` so it can
   * still be flashed or erased on the Flasher page.
   */
  public async connectWithPort(port: SerialPortLike, showAllPorts = true): Promise<TimerStatus | null> {
    this.showAllPorts = showAllPorts;
    this.userDisconnecting = false;
    this.reconnecting = false;
    this.reconnectAttempt = 0;
    this.reconnectFailed = false;
    this.lastError = null;
    this.probing = true;
    this.notifyStateChange();
    try {
      await this.openPort(port);
      this.startStatusPolling();
      this.subscribers.forEach((h) => h.onConnect?.());
      this.notifyStateChange();
      const s = await this.ensureRunningApp(1600);
      if (this.connected) {
        if (!s && !this.lastConfig && this.port && this.writer) {
          await haltBlankEsp32C5BootLoop(this.port, this.writer).catch(() => undefined);
        } else {
          void this.send("SLAPRF?").catch(() => undefined);
        }
      }
      return s;
    } finally {
      this.probing = false;
      this.notifyStateChange();
    }
  }

  /**
   * Opens the USB port (via WebSerial port picker), probes `STATUS?` and `SLAPRF?`, and starts
   * the 2-second status heartbeat so the connection stays active across all SPA routes.
   */
  public async connectAndStart(showAllPorts = true): Promise<TimerStatus | null> {
    this.probing = true;
    this.notifyStateChange();
    try {
      await this.connect(showAllPorts);
      const s = await this.ensureRunningApp(1600);
      if (this.connected) {
        if (!s && !this.lastConfig && this.port && this.writer) {
          await haltBlankEsp32C5BootLoop(this.port, this.writer).catch(() => undefined);
        } else {
          void this.send("SLAPRF?").catch(() => undefined);
        }
      }
      return s;
    } finally {
      this.probing = false;
      this.notifyStateChange();
    }
  }

  /**
   * Releases the underlying `SerialPort` for flashing or erasing while keeping this slot active
   * (`connected === true`, `writing === true`) so its connection pill stays visible in the UI.
   */
  public async releasePortForWrite(): Promise<SerialPortLike | null> {
    const port = this.port;
    if (!port) return null;
    this.writing = true;
    this.expectingRestart = true;
    window.clearInterval(this.statusPollTimer);
    this.statusPollTimer = 0;
    if (this.lastStatus || this.lastConfig) {
      await withTimeout(this.send("LIVE 0\nSCAN STOP\nLOG 0"), 200).catch(() => undefined);
      await sleep(40);
    }
    await this.closePort();
    this.failWaiters("Port busy for flash/erase");
    this.notifyStateChange();
    return port;
  }

  /**
   * Re-attaches this console slot to the board after `flashXiaoC5OverWebSerial` or
   * `eraseXiaoC5OverWebSerial` resets and closes the raw port.
   */
  public async reopenPortAfterFlash(fallbackPort?: unknown): Promise<void> {
    this.probing = true;
    this.lastStatus = null;
    this.lastConfig = null;
    this.notifyStateChange();
    try {
      const deadline = Date.now() + 5000;
      await sleep(600);
      while (Date.now() < deadline) {
        let candidate: SerialPortLike | undefined = undefined;
        try {
          const ports = await serial().getPorts();
          candidate = ports.find((p) => {
            if (usbPool.findOwnerOfPort(p)) return false;
            const info = p.getInfo?.() ?? {};
            return (
              !this.portInfo ||
              (info.usbVendorId === this.portInfo.usbVendorId && info.usbProductId === this.portInfo.usbProductId)
            );
          });
        } catch {
          // ignore
        }
        const target = candidate ?? (fallbackPort as SerialPortLike | undefined);
        if (target) {
          try {
            await this.connectWithPort(target, this.showAllPorts);
            return;
          } catch {
            // port still re-enumerating after hardware reset
          }
        }
        await sleep(350);
      }
    } finally {
      this.writing = false;
      this.expectingRestart = false;
      this.probing = false;
      this.notifyStateChange();
    }
  }

  /** Stops any active debug streams on the timer and closes the USB port. */
  public async disconnectCleanly(): Promise<void> {
    this.userDisconnecting = true;
    this.reconnecting = false;
    this.reconnectAttempt = 0;
    this.reconnectFailed = false;
    this.lastError = null;
    window.clearInterval(this.statusPollTimer);
    this.statusPollTimer = 0;
    if (this.connected && (this.lastStatus || this.lastConfig)) {
      await withTimeout(this.send("LIVE 0\nSCAN STOP\nLOG 0"), 250).catch(() => undefined);
      await sleep(50);
    }
    await this.disconnect();
  }

  /**
   * Status watchdog. Boards push a status line about once a second on their own (from a
   * low-priority task, so polling never disturbs sweeps or beacons). We only ask with STATUS? when
   * pushes go quiet for `silenceMs` (just connected, board rebooted, or it stopped streaming).
   */
  public startStatusPolling(silenceMs = 4000): void {
    window.clearInterval(this.statusPollTimer);
    this.statusPollTimer = window.setInterval(() => {
      if (
        this.connected &&
        !this.expectingRestart &&
        (this.lastStatus !== null || this.lastConfig !== null || this.probing) &&
        Date.now() - this.lastStatusAtMs > silenceMs
      ) {
        void this.send("STATUS?").catch(() => undefined);
      }
    }, 1000);
  }

  /**
   * Disarms the ESP32-C5 USB-Serial-JTAG download-mode latch by stepping `(1,1) -> (1,0) -> (0,0)`
   * (clearing RTS first while DTR=1, then clearing DTR while RTS=0).
   *
   * On Windows (`usbser.sys`), `port.open()` sets `DTR=1` then `RTS=1`, arming the hardware
   * download-mode latch (`IO0=0`). If left at `(1,1)`, calling `port.close()` on Disconnect makes
   * `usbser.sys` drop `DTR` before `RTS` (`(1,1) -> (0,1) -> (0,0)`), asserting chip reset while
   * `IO0=0` is latched and trapping the board in ROM bootloader mode until power-cycled.
   * Stepping `(1,1) -> (1,0) -> (0,0)` never visits `(0,1)`, releases the `IO0` latch at `(0,0)`,
   * and leaves both lines at `0` so `port.close()` is a no-op.
   */
  private async disarmUsbJtagLatch(port: SerialPortLike): Promise<void> {
    try {
      await withTimeout(port.setSignals({ dataTerminalReady: true, requestToSend: false }), 150);
      await withTimeout(port.setSignals({ dataTerminalReady: false, requestToSend: false }), 150);
    } catch {
      // Ignore on platforms/drivers that do not support setSignals
    }
  }

  private async openPort(port: SerialPortLike): Promise<void> {
    if (this.port && this.port !== port) {
      await this.closePort();
    }
    try {
      await port.open({ baudRate: 115200, bufferSize: 16384 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already open/i.test(msg)) {
        try {
          if (this.reader) {
            await withTimeout(this.reader.cancel(), 200).catch(() => undefined);
            this.reader.releaseLock();
            this.reader = null;
          }
          if (this.writer) {
            await withTimeout(this.writer.abort(), 200).catch(() => undefined);
            this.writer.releaseLock();
            this.writer = null;
          }
          await withTimeout(port.close(), 300).catch(() => undefined);
          await sleep(80);
          await port.open({ baudRate: 115200, bufferSize: 16384 });
        } catch {
          // If the port is already open with unlocked streams, proceed to attach reader/writer below
          if (!port.readable || !port.writable) {
            throw err;
          }
        }
      } else {
        throw err;
      }
    }
    await this.disarmUsbJtagLatch(port);
    this.port = port;
    this.portInfo = port.getInfo?.() ?? this.portInfo;
    this.sawRomBootloader = false;
    this.bufStart = 0;
    this.bufEnd = 0;
    this.packLen = 0;
    this.packCount = 0;
    this.hubOwnFrames = 0;
    this.hubLastFrameAtMs = 0;
    this.hubLastSeq = undefined;
    this.hubLastDbm = undefined;
    this.writeQueue = Promise.resolve();
    this.writer = port.writable?.getWriter() ?? null;
    this.reader = port.readable?.getReader() ?? null;
    void this.readLoop(port);
  }

  public async disconnect(): Promise<void> {
    window.clearInterval(this.statusPollTimer);
    this.statusPollTimer = 0;
    await this.closePort();
    this.probing = false;
    this.lastStatus = null;
    this.lastConfig = null;
    this.hubOwnFrames = 0;
    this.hubLastFrameAtMs = 0;
    this.hubLastSeq = undefined;
    this.hubLastDbm = undefined;
    this.lastKnownSpokeSig = "";
    this.failWaiters("Disconnected");
    this.subscribers.forEach((h) => h.onDisconnect?.());
    this.notifyStateChange();
  }

  /**
   * Best-effort synchronous/immediate teardown for page reload (`beforeunload` / `pagehide`).
   * Stops active firmware streams, cancels the reader, and closes the WebSerial port immediately
   * so Chromium doesn't strand an active stream or leave the USB port wedged across a refresh.
   */
  public disconnectForUnload(): void {
    window.clearInterval(this.statusPollTimer);
    this.statusPollTimer = 0;
    const port = this.port;
    const writer = this.writer;
    const reader = this.reader;
    this.port = null;
    this.writer = null;
    this.reader = null;
    this.lastStatus = null;
    this.lastConfig = null;
    this.failWaiters("Page unloading");
    if (!port) return;
    const stopBytes = new TextEncoder().encode("\nLIVE 0\nSCAN STOP\nLOG 0\n");
    const writeDone = writer
      ? withTimeout(writer.write(stopBytes), 120)
          .catch(() => undefined)
          .finally(() => {
            try {
              void writer.abort().catch(() => undefined);
            } catch {
              // ignore
            }
            try {
              writer.releaseLock();
            } catch {
              // ignore
            }
          })
      : Promise.resolve();
    const readDone = reader
      ? withTimeout(reader.cancel(), 120)
          .catch(() => undefined)
          .finally(() => {
            try {
              reader.releaseLock();
            } catch {
              // ignore
            }
          })
      : Promise.resolve();
    void Promise.all([writeDone, readDone]).finally(() => {
      try {
        void port.close().catch(() => undefined);
      } catch {
        // ignore
      }
    });
  }

  private async closePort(): Promise<void> {
    const port = this.port;
    const reader = this.reader;
    const writer = this.writer;
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.writeQueue = Promise.resolve();

    if (reader) {
      try {
        await withTimeout(reader.cancel(), 250);
      } catch {
        // ignore
      }
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }

    if (writer) {
      try {
        await withTimeout(writer.abort(), 250);
      } catch {
        // ignore
      }
      try {
        writer.releaseLock();
      } catch {
        // ignore
      }
    }

    if (port) {
      await this.disarmUsbJtagLatch(port);
      try {
        await withTimeout(port.close(), 400);
      } catch {
        // ignore
      }
    }
  }

  public async send(command: string): Promise<void> {
    const writer = this.writer;
    if (!writer) throw new Error("Not connected");
    const bytes = new TextEncoder().encode(command + "\n");
    const run = async () => {
      if (this.writer !== writer) throw new Error("Not connected");
      await withTimeout(writer.write(bytes), 600);
    };
    const next = this.writeQueue.then(run, run);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * Decodes a 19-byte active pilot channel table frame (0xC5 0x5E + 8x uint16 LE + crc8) and
   * forwards it over USB serial via `NETCHANNELS f0,f1,...,f7` when connected to a Hub.
   */
  public sendNetChannelsFromPacket(pkt19: Uint8Array): void {
    if (!this.connected || pkt19.byteLength < 19 || pkt19[0] !== 0xc5 || pkt19[1] !== 0x5e) {
      return;
    }
    const freqs: number[] = [];
    for (let i = 0; i < 8; i++) {
      freqs.push(pkt19[2 + i * 2] | (pkt19[3 + i * 2] << 8));
    }
    void this.send(`NETCHANNELS ${freqs.join(",")}`).catch(() => undefined);
  }

  /**
   * Toggle the LED identify strobe on the timer with fingerprint `fp`: this board itself, or
   * (when connected to the Hub) one of its Spokes, relayed over ESP-NOW. Stays on until toggled off.
   */
  public async setIdentify(fp: string, on: boolean): Promise<void> {
    await this.request(`IDENTIFY ${fp.toUpperCase()} ${on ? 1 : 0}`, "ok", 2000);
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
  public async ensureRunningApp(timeoutMs = 1600): Promise<TimerStatus | null> {
    if (!this.port) return null;
    const deadline = Date.now() + timeoutMs;
    let first = true;
    while (Date.now() < deadline && this.port && !this.sawRomBootloader) {
      try {
        const cmd = first ? "\nLIVE 0\nSCAN STOP\nLOG 0\nSTATUS?\nSLAPRF?" : "\nSTATUS?";
        first = false;
        return await this.request<TimerStatus>(cmd, "status", 450);
      } catch {
        if (this.lastConfig) return this.lastStatus;
        if (this.sawRomBootloader) return null;
        // retry after a short pause
      }
      await sleep(90);
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
              this.startStatusPolling();
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
        const msg = err instanceof Error ? err.message : String(err);
        this.subscribers.forEach((h) => h.onError?.(msg));
      }
    }
    if (this.port === port) {
      if (this.expectingRestart) {
        await this.closePort(); // Device is re-enumerating; restartAndReconnect() reopens it
      } else if (!this.userDisconnecting) {
        await this.closePort();
        void this.attemptAutoReconnect();
      } else {
        await this.disconnect();
      }
    }
  }

  private async attemptAutoReconnect(): Promise<void> {
    if (this.reconnecting || this.userDisconnecting) return;
    this.reconnecting = true;
    this.reconnectFailed = false;
    this.reconnectAttempt = 0;
    this.notifyStateChange();

    for (let attempt = 1; attempt <= this.maxReconnectAttempts; attempt++) {
      if (this.userDisconnecting || this.connected) {
        this.reconnecting = false;
        this.notifyStateChange();
        return;
      }
      this.reconnectAttempt = attempt;
      this.notifyStateChange();
      await sleep(1200);
      if (this.userDisconnecting || this.connected) {
        this.reconnecting = false;
        this.notifyStateChange();
        return;
      }
      try {
        const ports = await serial().getPorts();
        const match = ports.find((p) => {
          const info = p.getInfo?.() ?? {};
          return (
            !this.portInfo ||
            (info.usbVendorId === this.portInfo.usbVendorId && info.usbProductId === this.portInfo.usbProductId)
          );
        });
        if (match) {
          await this.openPort(match);
          this.reconnecting = false;
          this.reconnectAttempt = 0;
          this.reconnectFailed = false;
          this.lastError = null;
          this.startStatusPolling();
          void this.ensureRunningApp().then(() => {
            if (this.connected) void this.send("SLAPRF?").catch(() => undefined);
          });
          this.subscribers.forEach((h) => h.onConnect?.());
          this.notifyStateChange();
          return;
        }
      } catch {
        // try next attempt
      }
    }

    this.reconnecting = false;
    this.reconnectFailed = true;
    this.lastError = `Lost USB connection after ${this.maxReconnectAttempts} reconnect attempts.`;
    await this.disconnect();
  }

  private ingest(chunk: Uint8Array): void {
    this.appendToBuffer(chunk);
    const b = this.buf;
    const end = this.bufEnd;
    let pos = this.bufStart;

    while (pos < end) {
      const recAt = indexOfByte(b, PKT_RECORD_SEP, pos, end);
      const nl = indexOfByte(b, 0x0a, pos, end);
      // A config block only wins if it starts before the first record separator / newline.
      let limit = end;
      if (recAt >= 0) limit = recAt;
      if (nl >= 0 && nl < limit) limit = nl;
      const magicAt = indexOfSeq(b, CONFIG_MAGIC, pos, limit, end);
      // Binary Hub packet record: [0x1E][len][frame bytes, ending in XOR crc8]
      if (recAt >= 0 && (nl < 0 || recAt < nl) && (magicAt < 0 || recAt < magicAt)) {
        if (end < recAt + 2) break;
        const len = b[recAt + 1];
        if (end < recAt + 2 + len) break; // wait for the rest of the record
        if (recAt > pos) {
          this.flushHubPackets();
          this.emitText(b.subarray(pos, recAt));
        }
        if (isValidHubFrameAt(b, recAt + 2, len)) {
          this.queueHubPacket(b, recAt + 2, len);
          pos = recAt + 2 + len;
        } else {
          pos = recAt + 1; // Not a real record: skip the separator and resync
        }
        continue;
      }
      if (magicAt >= 0 && (nl < 0 || magicAt < nl)) {
        if (end < magicAt + CONFIG_LEN) break; // wait for the rest of the block
        this.flushHubPackets();
        if (magicAt > pos) this.emitText(b.subarray(pos, magicAt));
        const parsed = parseSlaprfConfigBlock(b.subarray(magicAt, magicAt + CONFIG_LEN));
        if (parsed) {
          this.probing = false;
          this.lastConfig = parsed;
          recordKnownTimerReadout(parsed);
          this.subscribers.forEach((h) => h.onConfig?.(parsed));
          this.resolveWaiters("config", parsed);
          this.notifyStateChange();
        }
        pos = magicAt + CONFIG_LEN;
        continue;
      }
      if (nl < 0) {
        if (end - pos > 16384) {
          this.flushHubPackets();
          this.emitText(b.subarray(pos, end));
          pos = end;
        }
        break;
      }
      this.flushHubPackets();
      this.emitText(b.subarray(pos, nl));
      pos = nl + 1;
    }

    // A callback may have reset the buffer (disconnect); only advance if it's still ours.
    if (this.buf === b && this.bufEnd === end) {
      this.bufStart = pos;
      if (pos >= end) {
        this.bufStart = 0;
        this.bufEnd = 0;
      }
    }
    this.flushHubPackets();
  }

  /** Appends a USB read to `buf[bufStart, bufEnd)`, compacting or growing (amortized O(1)/byte). */
  private appendToBuffer(chunk: Uint8Array): void {
    const pending = this.bufEnd - this.bufStart;
    if (this.bufEnd + chunk.length > this.buf.length) {
      if (pending + chunk.length <= this.buf.length) {
        this.buf.copyWithin(0, this.bufStart, this.bufEnd);
      } else {
        let cap = this.buf.length * 2;
        while (cap < pending + chunk.length) cap *= 2;
        const grown = new Uint8Array(cap);
        grown.set(this.buf.subarray(this.bufStart, this.bufEnd));
        this.buf = grown;
      }
      this.bufStart = 0;
      this.bufEnd = pending;
    }
    this.buf.set(chunk, this.bufEnd);
    this.bufEnd += chunk.length;
  }

  private queueHubPacket(src: Uint8Array, at: number, len: number): void {
    if (len >= 16 && src[at] === 0xc5 && src[at + 2] === 1) {
      const kind = src[at + 1];
      if (kind === 0x59) {
        const sampleCount = src[at + 3];
        if (sampleCount >= 1 && len >= 7 + sampleCount * 9 + 1) {
          this.hubOwnFrames++;
          this.hubLastFrameAtMs = Date.now();
          const newestOff = at + 7 + (sampleCount - 1) * 9;
          this.hubLastSeq = src[newestOff];
          const dbm: number[] = [];
          for (let ch = 0; ch < 8; ch++) {
            let best = (src[newestOff + 1 + ch] << 24) >> 24;
            for (let s = 0; s < sampleCount; s++) {
              const v = (src[at + 7 + s * 9 + 1 + ch] << 24) >> 24;
              if (v > best) best = v;
            }
            dbm.push(best);
          }
          this.hubLastDbm = dbm;
        }
      } else if (kind === 0x58) {
        this.hubOwnFrames++;
        this.hubLastFrameAtMs = Date.now();
        this.hubLastSeq = src[at + 3];
        const dbm: number[] = [];
        for (let ch = 0; ch < 8; ch++) {
          dbm.push((src[at + 7 + ch] << 24) >> 24);
        }
        this.hubLastDbm = dbm;
      }
    }
    if (this.packLen + 1 + len > this.pack.length) {
      const grown = new Uint8Array(Math.max(this.pack.length * 2, this.packLen + 1 + len));
      grown.set(this.pack.subarray(0, this.packLen));
      this.pack = grown;
    }
    this.pack[this.packLen] = len;
    this.pack.set(src.subarray(at, at + len), this.packLen + 1);
    this.packLen += 1 + len;
    this.packCount++;
  }

  /**
   * Delivers the Hub frames queued so far (in arrival order, before any text/config that follows
   * them): one `onHubPackets` call per subscriber that batches, else one `onHubPacket` per frame.
   */
  private flushHubPackets(): void {
    if (this.packCount === 0) return;
    const packed = this.pack.slice(0, this.packLen);
    const count = this.packCount;
    this.packLen = 0;
    this.packCount = 0;
    this.subscribers.forEach((h) => {
      if (h.onHubPackets) {
        h.onHubPackets(packed, count);
      } else if (h.onHubPacket) {
        for (let o = 0; o < packed.length; o += 1 + packed[o]) {
          h.onHubPacket(packed.subarray(o + 1, o + 1 + packed[o]));
        }
      }
    });
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
    const rawLine = this.decoder.decode(bytes).replace(/\r$/, "");
    if (!rawLine) return;
    if (rawLine.includes("invalid header:") || rawLine.includes("waiting for download")) {
      this.sawRomBootloader = true;
      if (this.waiters.length) {
        this.failWaiters("ROM bootloader detected");
      }
    }
    const atIdx = rawLine.lastIndexOf("@{");
    const line = atIdx > 0 ? rawLine.slice(atIdx) : rawLine;
    if (line.startsWith("@{")) {
      try {
        const msg = JSON.parse(line.slice(1)) as { t: string; msg?: string } & Record<string, unknown>;
        this.subscribers.forEach((h) => h.onRawReply?.(line, msg.t));
        this.resolveWaiters(msg.t, msg);
        switch (msg.t) {
          case "status": {
            const st = msg as unknown as TimerStatus;
            const wasProbing = this.probing;
            this.probing = false;
            const labelChanged =
              wasProbing ||
              this.lastStatus?.label !== st.label ||
              this.lastStatus?.fp !== st.fp ||
              this.lastStatus?.role !== st.role ||
              this.lastStatus?.slot !== st.slot ||
              this.lastStatus?.emergencyMode !== st.emergencyMode;
            const spokeSig = Array.isArray(st.spokes)
              ? st.spokes.map((sp) => `${sp.slot}:${sp.fp}:${sp.label}`).join("|")
              : "";
            const spokesChanged = spokeSig !== this.lastKnownSpokeSig;
            this.lastStatus = st;
            this.lastStatusAtMs = Date.now();
            if (labelChanged || spokesChanged) {
              this.lastKnownSpokeSig = spokeSig;
              recordKnownTimerStatus(st);
            }
            this.subscribers.forEach((h) => h.onStatus?.(st));
            if (labelChanged) {
              this.notifyStateChange();
            }
            return;
          }
          case "live":
            this.subscribers.forEach((h) => h.onLive?.(msg as unknown as LiveSample));
            return;
          case "scan":
            this.subscribers.forEach((h) => h.onScan?.(msg as unknown as ScanResult));
            return;
          case "bootlog":
            this.subscribers.forEach((h) => h.onBootLog?.(msg as unknown as BootLog));
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
    this.subscribers.forEach((h) => h.onLog?.(line));
  }
}

export const MAX_USB_CONNECTIONS = 3;

/**
 * Manages up to 3 simultaneous WebSerial USB timer connections (e.g. keeping the Hub connected in
 * Slot 0 while debugging one or two Spokes over USB in Slots 1–2).
 */
export class UsbConnectionPool {
  public readonly slots: readonly [TimerConsole, TimerConsole, TimerConsole];
  private _debugSlotIndex = 0;
  private lastCheckedOwner: TimerConsole | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(slots: [TimerConsole, TimerConsole, TimerConsole]) {
    this.slots = slots;
    this.rebindSlots();
    this.initBlankPortStabilizer();
  }

  /**
   * Re-attaches pool-level state listeners to each slot after clearing any stale listeners left
   * behind by prior HMR module evaluations.
   */
  public rebindSlots(): void {
    for (const c of this.slots) {
      const subs = (c as unknown as { subscribers?: Set<Record<string, unknown>> }).subscribers;
      if (subs) {
        for (const sub of [...subs]) {
          if (sub && "onConnect" in sub && "onConfig" in sub) {
            subs.delete(sub);
          }
        }
      }
      (c as unknown as { stateListeners?: Set<() => void> }).stateListeners?.clear();
      c.onStateChange(() => this.notify());
      c.subscribe({
        onConnect: () => this.notify(),
        onConfig: () => this.notify(),
        onDisconnect: () => {
          if (!this.slots[this._debugSlotIndex]?.connected) {
            const first = this.slots.find((s) => s.connected);
            if (first) {
              this._debugSlotIndex = first.slotIndex;
            }
          }
          this.notify();
        },
      });
    }
  }

  private readonly checkedBlankPorts = new WeakSet<object>();
  private calmingBlankPorts = false;

  /**
   * When an ESP32-C5 has factory-blank / erased SPI flash (`0xFF` at `0x2000`), its ROM bootloader
   * loops on `invalid header: 0xffffffff` and hardware-resets USB every ~3.2 seconds, causing its
   * COM port to appear and disappear in the WebSerial port picker. For any previously-authorized
   * port in `navigator.serial.getPorts()` that is boot-looping, automatically enter ROM download
   * mode and disable `LP_WDT` so its COM port stays stable.
   */
  private initBlankPortStabilizer(): void {
    if (!TimerConsole.supported()) return;
    const navSerial = serial() as SerialLike & { addEventListener?(type: string, fn: () => void): void };
    const run = () => {
      void this.calmBootLoopingBlankPorts();
    };
    window.setTimeout(run, 150);
    navSerial.addEventListener?.("connect", run);
  }

  private async calmBootLoopingBlankPorts(): Promise<void> {
    if (this.calmingBlankPorts) return;
    if (this.slots.some((c) => c.writing || c.probing || c.reconnecting)) return;
    this.calmingBlankPorts = true;
    try {
      const ports = await serial().getPorts();
      for (const port of ports) {
        if (this.checkedBlankPorts.has(port as unknown as object)) continue;
        if (this.findOwnerOfPort(port)) continue;
        if (port.readable || port.writable) continue;
        const info = port.getInfo?.() ?? {};
        if (info.usbVendorId && info.usbVendorId !== ESPRESSIF_USB_VID) {
          this.checkedBlankPorts.add(port as unknown as object);
          continue;
        }
        try {
          await port.open({ baudRate: 115200, bufferSize: 4096 });
          await port.setSignals({ dataTerminalReady: true, requestToSend: false }).catch(() => undefined);
          await port.setSignals({ dataTerminalReady: false, requestToSend: false }).catch(() => undefined);
          const reader = port.readable?.getReader();
          const writer = port.writable?.getWriter();
          let sawBootLoop = false;
          if (reader) {
            const deadline = Date.now() + 260;
            const dec = new TextDecoder();
            let acc = "";
            while (Date.now() < deadline) {
              const rem = Math.max(20, deadline - Date.now());
              const chunk = await withTimeout(reader.read(), rem).catch(() => undefined);
              if (!chunk || chunk.done || !chunk.value) break;
              acc += dec.decode(chunk.value, { stream: true });
              if (acc.includes("invalid header:") || acc.includes("waiting for download")) {
                sawBootLoop = true;
                break;
              }
              if (acc.includes("@{")) {
                break;
              }
            }
          }
          if (sawBootLoop && writer) {
            await haltBlankEsp32C5BootLoop(port, writer).catch(() => undefined);
          }
          try {
            await withTimeout(reader?.cancel(), 120);
          } catch {}
          try {
            reader?.releaseLock();
          } catch {}
          try {
            writer?.releaseLock();
          } catch {}
          await withTimeout(port.close(), 250).catch(() => undefined);
          this.checkedBlankPorts.add(port as unknown as object);
        } catch {
          // port busy or disconnected mid-check
        }
      }
    } catch {
      // ignore
    } finally {
      this.calmingBlankPorts = false;
    }
  }

  public get debugSlotIndex(): number {
    return this._debugSlotIndex;
  }

  public get debugConsole(): TimerConsole {
    const chosen = this.slots[this._debugSlotIndex];
    if (chosen && (chosen.connected || chosen.busyLabel || chosen.reconnecting)) {
      return chosen;
    }
    const firstActive = this.slots.find((c) => c.connected || c.busyLabel || c.reconnecting);
    if (firstActive) {
      this._debugSlotIndex = firstActive.slotIndex;
      return firstActive;
    }
    return chosen ?? this.slots[0];
  }

  public setDebugSlot(slotIndex: number): void {
    if (slotIndex >= 0 && slotIndex < MAX_USB_CONNECTIONS && slotIndex !== this._debugSlotIndex) {
      this._debugSlotIndex = slotIndex;
      this.notify();
    }
  }

  public selectDebugSlot(slotIndex: number): void {
    this.setDebugSlot(slotIndex);
  }

  public connectedConsoles(): TimerConsole[] {
    return this.slots.filter((c) => c.connected);
  }

  public hubConsole(): TimerConsole | null {
    return this.slots.find((c) => c.connected && c.lastStatus?.role === 1) ?? null;
  }

  public primaryConsole(): TimerConsole {
    return this.hubConsole() ?? this.connectedConsoles()[0] ?? this.slots[0];
  }

  public canConnectMore(): boolean {
    return this.connectedConsoles().length < MAX_USB_CONNECTIONS;
  }

  public findByFingerprint(fp: string): TimerConsole | null {
    const target = (fp || "").toUpperCase();
    if (!target) return null;
    return this.slots.find((c) => c.connected && (c.lastStatus?.fp || "").toUpperCase() === target) ?? null;
  }

  public findByTimerSlot(timerSlot: number): TimerConsole | null {
    if (timerSlot === 1) {
      return this.hubConsole();
    }
    return this.slots.find((c) => c.connected && c.lastStatus?.role === 2 && c.lastStatus?.slot === timerSlot) ?? null;
  }

  public findOwnerOfPort(candidate: unknown): TimerConsole | null {
    return this.slots.find((c) => c.ownsPort(candidate)) ?? null;
  }

  public async connectNew(
    showAllPorts = false,
    selectForDebug = true
  ): Promise<{ console: TimerConsole; status: TimerStatus | null; alreadyConnected: boolean }> {
    const free = this.slots.find((c) => !c.connected && !c.busyLabel && !c.reconnecting);
    if (!free) {
      throw new Error(`Maximum of ${MAX_USB_CONNECTIONS} USB connections already active. Disconnect one first.`);
    }
    const port = await serial().requestPort({ filters: [{ usbVendorId: ESPRESSIF_USB_VID }] });
    const existing = this.findOwnerOfPort(port);
    if (existing) {
      if (selectForDebug) {
        this.setDebugSlot(existing.slotIndex);
      }
      return { console: existing, status: existing.lastStatus, alreadyConnected: true };
    }
    if (selectForDebug) {
      this._debugSlotIndex = free.slotIndex;
      this.notify();
    }
    const status = await free.connectWithPort(port, showAllPorts);
    return { console: free, status, alreadyConnected: false };
  }

  /**
   * Releases the active debug USB connection's open `SerialPort` so the Flasher or Eraser can talk
   * to the ESP32-C5 ROM bootloader directly without popping up a second USB port picker, and
   * returns a `reopen` callback that re-attaches the same `TimerConsole` slot afterwards.
   */
  public async takeActivePort(): Promise<{ port: SerialPortLike; reopen: () => Promise<void> } | null> {
    const active = this.debugConsole;
    const port = await active.releasePortForWrite();
    if (!port) return null;
    return {
      port,
      reopen: () => active.reopenPortAfterFlash(port),
    };
  }

  public async disconnectAllCleanly(): Promise<void> {
    await Promise.all(
      this.slots.map((c) => (c.connected || c.reconnecting ? c.disconnectCleanly().catch(() => undefined) : Promise.resolve()))
    );
  }

  public disconnectAllForUnload(): void {
    for (const c of this.slots) {
      if (c.connected) {
        c.disconnectForUnload();
      }
    }
  }

  public ownsPort(candidate: unknown): boolean {
    const owner = this.findOwnerOfPort(candidate);
    this.lastCheckedOwner = owner;
    return owner !== null;
  }

  public async readSnapshot(): Promise<TimerReadout> {
    const target = this.lastCheckedOwner ?? this.primaryConsole();
    return await target.readSnapshot();
  }

  public async disconnectCleanly(): Promise<void> {
    const target = this.lastCheckedOwner ?? this.primaryConsole();
    this.lastCheckedOwner = null;
    await target.disconnectCleanly();
  }

  public onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
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
}

const timerWin = (typeof window !== "undefined" ? window : undefined) as
  | (Window & {
      __slaprfTimerConsole?: TimerConsole;
      __slaprfUsbPool?: UsbConnectionPool;
      __slaprfTimerUnloadBound?: boolean;
    })
  | undefined;

export const usbPool: UsbConnectionPool = (() => {
  if (timerWin?.__slaprfUsbPool) {
    Object.setPrototypeOf(timerWin.__slaprfUsbPool, UsbConnectionPool.prototype);
    timerWin.__slaprfUsbPool.slots.forEach((c, idx) => {
      Object.setPrototypeOf(c, TimerConsole.prototype);
      (c as { slotIndex: number }).slotIndex = idx;
    });
    return timerWin.__slaprfUsbPool;
  }
  const slot0 = timerWin?.__slaprfTimerConsole ?? new TimerConsole(undefined, 0);
  Object.setPrototypeOf(slot0, TimerConsole.prototype);
  (slot0 as { slotIndex: number }).slotIndex = 0;
  const pool = new UsbConnectionPool([slot0, new TimerConsole(undefined, 1), new TimerConsole(undefined, 2)]);
  if (timerWin) {
    timerWin.__slaprfTimerConsole = slot0;
    timerWin.__slaprfUsbPool = pool;
  }
  return pool;
})();

/**
 * Primary USB timer slot (Slot 0) kept as a named export for compatibility; callers that support
 * multi-USB use `usbPool`.
 */
export const sharedTimerConsole: TimerConsole = usbPool.slots[0];

if (timerWin && !timerWin.__slaprfTimerUnloadBound) {
  timerWin.__slaprfTimerUnloadBound = true;
  const onUnload = () => {
    usbPool.disconnectAllForUnload();
  };
  window.addEventListener("pagehide", onUnload);
  window.addEventListener("beforeunload", onUnload);
}
