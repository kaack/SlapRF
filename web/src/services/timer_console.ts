/**
 * WebSerial client for a timer's USB debug console (firmware: components/slaprf_radio/slaprf_diag.c).
 *
 * The port carries three kinds of data: '@'-prefixed JSON reply lines, plain-text log lines
 * (after `LOG 1`), and the raw 160-byte SLAPRF02 block in answer to `SLAPRF?`.
 */
import {
  DEFAULT_FIRMWARE_PROFILE,
  FIRMWARE_PROFILES,
  LATEST_FIRMWARE_VERSION,
  parseSlaprfConfigBlock,
  TimerReadout,
} from "./esp_flasher";

export interface TimerPeerSpoke {
  slot: number;
  fp: string;
  label: string;
  profile?: number;
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
  profile?: number;
  channel?: number;
  beaconMsAgo?: number;
  linked: boolean;
}

export interface KnownHardwareTimer {
  fp: string;
  role: "hub" | "spoke";
  label: string;
  profile: number;
  fw?: string;
  mac?: string;
  slot?: number;
  channel?: number;
  wifiSSID?: string;
  parentHubFp?: string;
  lastSeenMs: number;
}

const KNOWN_TIMERS_STORAGE_KEY = "slaprf.hw.knownTimers";

const SEEDED_KNOWN_TIMERS: KnownHardwareTimer[] = [
  {
    fp: "BE7C0001",
    role: "hub",
    label: "H1",
    profile: 1,
    fw: "v0.1.4",
    mac: "10:BD:A3:C7:F3:C0",
    slot: 1,
    channel: 1,
    lastSeenMs: 1731152894000,
  },
  {
    fp: "DA9B4CA7",
    role: "spoke",
    label: "S1",
    profile: 1,
    fw: "v0.1.4",
    mac: "10:BD:A3:C8:0B:88",
    slot: 2,
    channel: 1,
    parentHubFp: "BE7C0001",
    lastSeenMs: 1731161000000,
  },
];

export function getKnownHardwareTimers(): KnownHardwareTimer[] {
  const map = new Map<string, KnownHardwareTimer>();
  for (const seed of SEEDED_KNOWN_TIMERS) {
    map.set(seed.fp.toUpperCase(), { ...seed, fp: seed.fp.toUpperCase() });
  }
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
  const profile = entry.profile ?? prev?.profile ?? 1;
  const channel = entry.channel ?? prev?.channel ?? 1;
  const slot = entry.slot ?? prev?.slot ?? (role === "hub" ? 1 : undefined);

  // If a Spoke has an assigned TDMA slot (>= 2), associate it with the most recently seen Hub on the same profile.
  let parentHubFp = entry.parentHubFp ?? prev?.parentHubFp;
  if (role === "spoke" && slot && slot >= 2 && !parentHubFp) {
    const matchingHub = list.find((t) => t.role === "hub" && t.profile === profile) ?? list.find((t) => t.role === "hub");
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
    profile,
    fw: entry.fw || prev?.fw,
    mac: entry.mac || prev?.mac,
    slot,
    channel,
    wifiSSID: entry.wifiSSID ?? prev?.wifiSSID,
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
  const clean = (fp || "").trim().toLowerCase();
  if (!clean) return;
  const list = loadKnownHardwareTimers().filter((t) => t.fp !== clean);
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
    profile: s.profile,
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
          profile: sp.profile ?? s.profile,
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
  const prof = FIRMWARE_PROFILES.find((p) => p.id === r.firmwareProfile);
  recordKnownHardwareTimer({
    fp: r.fingerprint,
    role: r.role,
    label: r.timerLabel,
    profile: r.status?.profile ?? prof?.code ?? 1,
    fw: r.firmwareVersion,
    mac: r.status?.chip?.mac,
    slot: r.status?.slot ?? (r.role === "hub" ? 1 : undefined),
    channel: r.status?.channel ?? 1,
    wifiSSID: r.wifiSSID || undefined,
    lastSeenMs: Date.now(),
  });
}

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
  beaconMsAgo?: number;
  hub?: TimerParentHub;
  spokes?: TimerPeerSpoke[];
  scanLive?: boolean;
  freqsTemporary: boolean;
  chanMask?: number;
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
  onHubPacket?: (pkt: Uint8Array) => void;
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
  private buf = new Uint8Array(0);
  private readonly decoder = new TextDecoder();
  private readonly subscribers = new Set<ConsoleHandlers>();
  private readonly stateListeners = new Set<() => void>();
  private waiters: Waiter[] = [];
  private statusPollTimer = 0;
  /** While true, a dropped port is an expected restart, not a user-visible disconnect. */
  private expectingRestart = false;
  private userDisconnecting = false;

  public lastStatus: TimerStatus | null = null;
  public lastConfig: TimerReadout | null = null;
  public busyLabel: string | null = null;
  public showAllPorts = false;
  public reconnecting = false;
  public reconnectAttempt = 0;
  public readonly maxReconnectAttempts = 5;
  public reconnectFailed = false;
  public lastError: string | null = null;

  constructor(handlers?: ConsoleHandlers) {
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
    return this.port !== null;
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
    const profileFromStatus = s ? FIRMWARE_PROFILES.find((p) => p.code === s.profile)?.id : undefined;
    return {
      chip: s?.chip ? `${s.chip.model} (${s.chip.rev})` : cfg?.chip || "Seeed XIAO ESP32-C5 (RISC-V 240 MHz)",
      role: cfg?.role ?? (s?.role === 1 ? "hub" : "spoke"),
      timerLabel: s?.label || cfg?.timerLabel || (s?.role === 1 ? "H1" : "S1"),
      wifiSSID: cfg?.wifiSSID ?? "",
      wifiPassSet: cfg?.wifiPassSet ?? false,
      firmwareProfile: cfg?.firmwareProfile || profileFromStatus || DEFAULT_FIRMWARE_PROFILE,
      fingerprint: s?.fp || cfg?.fingerprint || "",
      firmwareVersion: s?.fw || cfg?.firmwareVersion || LATEST_FIRMWARE_VERSION,
      frequenciesMHz: s?.freqs?.length ? s.freqs : cfg?.frequenciesMHz || [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917],
      status: s ? (s as unknown as TimerReadout["status"]) : cfg?.status,
    };
  }

  public static supported(): boolean {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  public async connect(showAllPorts = this.showAllPorts): Promise<void> {
    this.showAllPorts = showAllPorts;
    this.userDisconnecting = false;
    this.reconnecting = false;
    this.reconnectAttempt = 0;
    this.reconnectFailed = false;
    this.lastError = null;
    this.notifyStateChange();
    const port = await serial().requestPort(showAllPorts ? undefined : { filters: [{ usbVendorId: ESPRESSIF_USB_VID }] });
    await this.openPort(port);
    this.startStatusPolling();
    this.subscribers.forEach((h) => h.onConnect?.());
    this.notifyStateChange();
  }

  /**
   * Opens the USB port (via WebSerial port picker), probes `STATUS?` and `SLAPRF?`, and starts
   * the 2-second status heartbeat so the connection stays active across all SPA routes.
   */
  public async connectAndStart(showAllPorts = this.showAllPorts): Promise<TimerStatus | null> {
    await this.connect(showAllPorts);
    const s = await this.ensureRunningApp();
    if (this.connected) {
      void this.send("SLAPRF?").catch(() => undefined);
    }
    return s;
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
    if (this.connected) {
      await withTimeout(this.send("LIVE 0\nSCAN STOP\nLOG 0"), 250).catch(() => undefined);
      await sleep(50);
    }
    await this.disconnect();
  }

  public startStatusPolling(intervalMs = 1000): void {
    window.clearInterval(this.statusPollTimer);
    this.statusPollTimer = window.setInterval(() => {
      if (this.connected && !this.expectingRestart) {
        void this.send("STATUS?").catch(() => undefined);
      }
    }, intervalMs);
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
    this.buf = new Uint8Array(0);
    this.writeQueue = Promise.resolve();
    this.writer = port.writable?.getWriter() ?? null;
    this.reader = port.readable?.getReader() ?? null;
    void this.readLoop(port);
  }

  public async disconnect(): Promise<void> {
    window.clearInterval(this.statusPollTimer);
    this.statusPollTimer = 0;
    await this.closePort();
    this.lastStatus = null;
    this.lastConfig = null;
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
        const cmd = first ? "\nLIVE 0\nSCAN STOP\nLOG 0\nSTATUS?" : "\nSTATUS?";
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
          this.lastConfig = parsed;
          recordKnownTimerReadout(parsed);
          this.subscribers.forEach((h) => h.onConfig?.(parsed));
          this.resolveWaiters("config", parsed);
          this.notifyStateChange();
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
    const rawLine = this.decoder.decode(bytes).replace(/\r$/, "");
    if (!rawLine) return;
    const atIdx = rawLine.lastIndexOf("@{");
    const line = atIdx > 0 ? rawLine.slice(atIdx) : rawLine;
    if (line.startsWith("@{")) {
      try {
        const msg = JSON.parse(line.slice(1)) as { t: string; msg?: string; hex?: string } & Record<string, unknown>;
        if (msg.t === "pkt" && typeof msg.hex === "string") {
          const hex = msg.hex.trim();
          if (hex.length >= 8 && hex.length % 2 === 0) {
            const out = new Uint8Array(hex.length / 2);
            let valid = true;
            for (let i = 0; i < out.length; i++) {
              const b = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
              if (Number.isNaN(b)) {
                valid = false;
                break;
              }
              out[i] = b;
            }
            if (valid) {
              this.subscribers.forEach((h) => h.onHubPacket?.(out));
            }
          }
          return;
        }
        this.subscribers.forEach((h) => h.onRawReply?.(line, msg.t));
        this.resolveWaiters(msg.t, msg);
        switch (msg.t) {
          case "status": {
            const st = msg as unknown as TimerStatus;
            const labelChanged =
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

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Shared app-wide USB timer connection that persists across SPA route switches and only
 * disconnects on full page reload/unload, physical USB unplug, or explicit user disconnect.
 */
export const sharedTimerConsole = new TimerConsole();

if (typeof window !== "undefined") {
  const onUnload = () => {
    if (sharedTimerConsole.connected) {
      sharedTimerConsole.disconnectForUnload();
    }
  };
  window.addEventListener("pagehide", onUnload);
  window.addEventListener("beforeunload", onUnload);
}
