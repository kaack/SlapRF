/**
 * Client for a SlapRF timer's USB debug & telemetry console:
 * - Real hardware mode (`caps.portable && !isSimulatedUsbMode()`): talks to the native Go SlapRF
 *   manager (`/v1/slaprf/{usb,bluetooth}/*` + `/v1/ws/slaprf/{usb,bluetooth}` over `go.bug.st/serial` / BLE).
 * - Simulation mode (`isSimulatedUsbMode()`): talks to `SimulatedSerialPort` in-process.
 */
import { capabilitiesSnapshot, resolveBackendUrl, resolveBackendWsUrl } from "./capabilities";
import {
  cancelActiveFlash,
  LATEST_FIRMWARE_VERSION,
  parseSlaprfConfigBlock,
  TimerReadout,
} from "./esp_flasher";
import {
  createBackendPortHandle,
  isBackendSerialPort,
  isBleHardwareMode,
  isSimulatedSerialPort,
  isSimulatedUsbMode,
  listSimulatedTimers,
  notifySimHubUsbConnected,
  pickUsbPort,
  portTransportLabel,
  recordSerialPortMeta,
  SimulatedSerialPort,
} from "./sim_serial_port";

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
  pairedBle?: boolean;
  lastSeenMs: number;
}

export interface PairedBluetoothHubInfo {
  fp: string;
  label: string;
  portName: string;
  simTimerId?: number;
}

const KNOWN_TIMERS_STORAGE_KEY = "slaprf.hw.knownTimers";
const PAIRED_SIM_BLE_HUB_KEY = "slaprf.ui.pairedSimBleHub.v1";

let backendKnownTimersCache: KnownHardwareTimer[] = [];
let backendKnownTimersHydrated = false;

export function getKnownHardwareTimers(): KnownHardwareTimer[] {
  const map = new Map<string, KnownHardwareTimer>();
  for (const item of backendKnownTimersCache) {
    if (item && typeof item.fp === "string") {
      const fp = item.fp.toUpperCase();
      if (fp && fp !== "00000001" && !fp.startsWith("SIM000") && !fp.startsWith("53504B")) {
        map.set(fp, { ...item, fp });
      }
    }
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
              if (fp && fp !== "00000001" && !fp.startsWith("SIM000") && !fp.startsWith("53504B")) {
                const prev = map.get(fp);
                if (!prev || (t.lastSeenMs ?? 0) >= (prev.lastSeenMs ?? 0)) {
                  map.set(fp, { ...prev, ...t, fp });
                }
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
  if (isSimulatedUsbMode()) return;
  const fp = (entry.fp || "").trim().toUpperCase();
  if (!fp || fp === "00000001" || fp.startsWith("SIM000") || fp.startsWith("53504B")) return;
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
    label: entry.label || prev?.label || (role === "hub" ? "H1" : "T1"),
    fw: entry.fw || prev?.fw,
    mac: entry.mac || prev?.mac,
    slot,
    channel,
    parentHubFp: role === "spoke" ? parentHubFp : undefined,
    pairedBle: role === "hub" ? Boolean(entry.pairedBle ?? prev?.pairedBle) : undefined,
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

export function setPairedSimBleHub(hub: { fp: string; label: string; timerId: number } | null): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    if (!hub) {
      window.localStorage.removeItem(PAIRED_SIM_BLE_HUB_KEY);
    } else {
      window.localStorage.setItem(PAIRED_SIM_BLE_HUB_KEY, JSON.stringify(hub));
    }
  } catch {
    // ignore storage errors
  }
}

export function clearLocalBlePairing(fp?: string): void {
  const cleanFp = (fp || "").trim().toUpperCase();
  if (!cleanFp) return;
  backendKnownTimersCache = backendKnownTimersCache.map((t) =>
    t.fp.toUpperCase() === cleanFp ? { ...t, pairedBle: false } : t
  );
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      const raw = window.localStorage.getItem(KNOWN_TIMERS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          const updated = parsed.map((item) => {
            if (item && typeof item === "object" && typeof (item as KnownHardwareTimer).fp === "string") {
              const kt = item as KnownHardwareTimer;
              if (kt.fp.toUpperCase() === cleanFp) {
                return { ...kt, pairedBle: false };
              }
            }
            return item;
          });
          window.localStorage.setItem(KNOWN_TIMERS_STORAGE_KEY, JSON.stringify(updated));
        }
      }
    } catch {
      // ignore storage errors
    }
  }
}

/**
 * Returns the Bluetooth Hub currently paired to this host (even when temporarily disconnected),
 * or `null` when no Bluetooth Hub is paired (initial state or after `Forget Device`).
 */
export function getPairedBluetoothHub(): PairedBluetoothHubInfo | null {
  if (isSimulatedUsbMode()) {
    if (typeof window !== "undefined" && window.localStorage) {
      try {
        const raw = window.localStorage.getItem(PAIRED_SIM_BLE_HUB_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { fp?: string; label?: string; timerId?: number };
          const timerId = typeof parsed.timerId === "number" ? parsed.timerId : 1;
          const desc = listSimulatedTimers().find((t) => t.timerId === timerId && t.poweredOn);
          if (desc) {
            return {
              fp: (parsed.fp || desc.fingerprint || "SIM").toUpperCase(),
              label: parsed.label || desc.label || "H1",
              portName: `sim:${timerId}`,
              simTimerId: timerId,
            };
          }
        }
      } catch {
        // ignore storage errors
      }
    }
    return null;
  }

  const main = usbPool?.mainConsole;
  if (main?.connected && main.transportLabel === "Bluetooth") {
    const activeFp = (main.lastStatus?.fp || main.lastConfig?.fingerprint || "").trim().toUpperCase();
    if (activeFp) {
      return {
        fp: activeFp,
        label: main.lastStatus?.label || main.lastConfig?.timerLabel || "H1",
        portName: `ble:${activeFp}`,
      };
    }
  }

  const source =
    capabilitiesSnapshot().portable && backendKnownTimersHydrated
      ? [...backendKnownTimersCache].sort((a, b) => (b.lastSeenMs ?? 0) - (a.lastSeenMs ?? 0))
      : getKnownHardwareTimers();
  const hub = source.find((t) => t.role === "hub" && t.pairedBle && t.fp);
  if (!hub) return null;
  const fp = hub.fp.trim().toUpperCase();
  return {
    fp,
    label: hub.label || "H1",
    portName: `ble:${fp}`,
  };
}

function backendTransportPrefix(forPortName?: string | null): "/v1/slaprf/bluetooth" | "/v1/slaprf/usb" {
  if (forPortName) {
    return forPortName.trim().toLowerCase().startsWith("ble:") ? "/v1/slaprf/bluetooth" : "/v1/slaprf/usb";
  }
  return isBleHardwareMode() ? "/v1/slaprf/bluetooth" : "/v1/slaprf/usb";
}

function backendCommandPath(forPortName?: string | null): "/v1/slaprf/bluetooth:command" | "/v1/slaprf/usb:command" {
  return backendTransportPrefix(forPortName) === "/v1/slaprf/bluetooth"
    ? "/v1/slaprf/bluetooth:command"
    : "/v1/slaprf/usb:command";
}

function backendWsPath(): "/v1/ws/slaprf/bluetooth" | "/v1/ws/slaprf/usb" {
  return isBleHardwareMode() ? "/v1/ws/slaprf/bluetooth" : "/v1/ws/slaprf/usb";
}

export function forgetKnownHardwareTimer(fp?: string, _label?: string): void {
  const cleanFp = (fp || "").trim().toUpperCase();
  if (!cleanFp) return;
  backendKnownTimersCache = backendKnownTimersCache.filter((t) => t.fp.toUpperCase() !== cleanFp);
  if (capabilitiesSnapshot().portable) {
    void fetch(resolveBackendUrl(`/v1/slaprf/known-timers/${encodeURIComponent(cleanFp)}`), {
      method: "DELETE",
    }).catch(() => undefined);
  }
  const list = getKnownHardwareTimers().filter((t) => t.fp.toUpperCase() !== cleanFp);
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.setItem(KNOWN_TIMERS_STORAGE_KEY, JSON.stringify(list));
    } catch {
      // ignore storage errors
    }
  }
}

export function recordKnownTimerStatus(s: TimerStatus): void {
  const isBleHub = s.role === 1 && s.transport === "ble";
  if (isSimulatedUsbMode()) {
    if (isBleHub || (s.role === 1 && isBleHardwareMode())) {
      setPairedSimBleHub({ fp: s.fp, label: s.label || "H1", timerId: 1 });
    }
    return;
  }
  recordKnownHardwareTimer({
    fp: s.fp,
    role: s.role === 1 ? "hub" : "spoke",
    label: s.label,
    fw: s.fw,
    mac: s.chip?.mac,
    slot: s.slot || (s.role === 1 ? 1 : undefined),
    channel: s.channel || 1,
    parentHubFp: s.hub?.fp,
    pairedBle: isBleHub ? true : undefined,
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

export interface TimerBleStatus {
  connected: boolean;
  intervalUs: number;
  mtu: number;
  phy: number;
  rssi: number;
  txNotifies: number;
  txBytes: number;
  txDrops: number;
  rxWrites: number;
  nocp: number;
  connects: number;
  sync: boolean;
  syncLocked: boolean;
  phaseUs: number;
  paired?: boolean;
  pairingMode?: boolean;
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
  image?: string;
  transport?: string;
  ble?: TimerBleStatus;
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
  /** SlapRF Server mode: `hubSlotLive` was refreshed from a throttled (20 Hz) `hub_live` event. */
  onHubLive?: () => void;
  onConfig?: (c: TimerReadout) => void;
  onError?: (msg: string) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export interface SerialPortLike {
  open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
  forget?(): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
}

interface Waiter {
  type: string;
  resolve: (msg: unknown) => void;
  reject: (err: Error) => void;
  timer: number;
}

export interface BackendSlotSnapshot {
  slotIndex: number;
  connected: boolean;
  connecting?: boolean;
  connectStatus?: string;
  portName?: string;
  probing: boolean;
  reconnecting: boolean;
  reconnectAttempt: number;
  maxReconnectAttempts: number;
  reconnectFailed: boolean;
  isOtherDevice: boolean;
  lastError?: string;
  lastStatus?: TimerStatus | null;
  lastConfig?: TimerReadout | null;
}

export interface BackendPoolSnapshot {
  slots: BackendSlotSnapshot[];
  debugSlotIndex: number;
  knownTimers?: KnownHardwareTimer[];
}

export interface BackendUsbEvent {
  type: string;
  slotIndex: number;
  status?: TimerStatus;
  config?: TimerReadout;
  live?: LiveSample;
  scan?: ScanResult;
  bootLog?: BootLog;
  payload?: Record<string, unknown>;
  line?: string;
  msgType?: string;
  error?: string;
  pool?: BackendPoolSnapshot;
}

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
  private otherPortsSnapshot = new Set<SerialPortLike>();

  public readonly slotIndex: number;
  public lastStatus: TimerStatus | null = null;
  public lastConfig: TimerReadout | null = null;
  public probing = false;
  public writing = false;
  public hubOwnFrames = 0;
  public hubLastFrameAtMs = 0;
  public hubLastSeq: number | undefined = undefined;
  public hubLastDbm: number[] | undefined = undefined;
  public readonly hubSlotLive = new Map<
    number,
    { frames: number; lastFrameAtMs: number; seq: number; dbm: number[]; floor: number }
  >();
  public readonly hubSlotHello = new Map<
    number,
    { fp: string; label: string; role: number; sweepHz: number }
  >();
  private lastRealJsonStatusAtMs = 0;
  private connectAbort: AbortController | null = null;
  public busyLabel: string | null = null;
  public connecting = false;
  public connectStatus: string | null = null;
  public showAllPorts = false;
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

  /** "Bluetooth" when the open port is a SlapRF Bluetooth Hub link (`ble:<FP>`), otherwise "USB-C". */
  public get transportLabel(): "Bluetooth" | "USB-C" {
    return portTransportLabel(this.port);
  }

  /** True when a USB port is open and probing finished without finding SlapRF timer firmware. */
  public get isOtherDevice(): boolean {
    return this.connected && !this.probing && !this.lastStatus && !this.lastConfig;
  }

  public ownsPort(candidate: unknown): boolean {
    if (this.port === null) return false;
    if (this.port === candidate) return true;
    if (isSimulatedSerialPort(this.port) && isSimulatedSerialPort(candidate)) {
      return this.port.simulatedTimerId === candidate.simulatedTimerId;
    }
    if (isBackendSerialPort(this.port) && isBackendSerialPort(candidate)) {
      return this.port.portName.toUpperCase() === candidate.portName.toUpperCase();
    }
    return false;
  }

  public applyBackendSlotSnapshot(snap: BackendSlotSnapshot): void {
    if (isSimulatedSerialPort(this.port)) return;
    const prevConnected = this.connected;
    const prevStatusSig = this.lastStatus ? `${this.lastStatus.fp}:${this.lastStatus.label}:${this.lastStatus.role}` : "";
    if (snap.connected && snap.portName) {
      if (!isBackendSerialPort(this.port) || this.port.portName !== snap.portName) {
        this.port = createBackendPortHandle(snap.portName);
      }
    } else {
      this.port = null;
    }
    this.connecting = Boolean(snap.connecting);
    this.connectStatus = snap.connectStatus || null;
    this.probing = Boolean(snap.probing);
    this.reconnecting = Boolean(snap.reconnecting);
    this.reconnectAttempt = snap.reconnectAttempt || 0;
    this.reconnectFailed = Boolean(snap.reconnectFailed);
    this.lastError = snap.lastError || null;
    this.lastStatus = snap.lastStatus ?? null;
    this.lastConfig = snap.lastConfig ?? null;
    if (this.lastStatus) {
      this.lastStatusAtMs = Date.now();
      if (this.lastStatus.ble || this.lastStatus.chip?.mac) {
        this.lastRealJsonStatusAtMs = this.lastStatusAtMs;
      }
    }

    const nextConnected = this.connected;
    const nextStatusSig = this.lastStatus ? `${this.lastStatus.fp}:${this.lastStatus.label}:${this.lastStatus.role}` : "";
    if (!prevConnected && nextConnected) {
      this.subscribers.forEach((h) => h.onConnect?.());
    } else if (prevConnected && !nextConnected) {
      this.subscribers.forEach((h) => h.onDisconnect?.());
    }
    if (this.lastConfig) {
      const cfg = this.lastConfig;
      this.subscribers.forEach((h) => h.onConfig?.(cfg));
    }
    if (this.lastStatus && nextStatusSig !== prevStatusSig) {
      const st = this.lastStatus;
      this.subscribers.forEach((h) => h.onStatus?.(st));
    }
    this.notifyStateChange();
  }

  public handleBackendEvent(ev: BackendUsbEvent): void {
    if (isSimulatedSerialPort(this.port)) return;
    switch (ev.type) {
      case "status":
        if (ev.status) {
          this.probing = false;
          this.lastStatus = ev.status;
          this.lastStatusAtMs = Date.now();
          if (ev.status.ble || ev.status.chip?.mac) {
            this.lastRealJsonStatusAtMs = this.lastStatusAtMs;
          }
          this.resolveWaiters("status", ev.status);
          this.subscribers.forEach((h) => h.onStatus?.(ev.status!));
          this.notifyStateChange();
        }
        break;
      case "config":
        if (ev.config) {
          this.probing = false;
          this.lastConfig = ev.config;
          this.resolveWaiters("config", ev.config);
          this.subscribers.forEach((h) => h.onConfig?.(ev.config!));
          this.notifyStateChange();
        }
        break;
      case "live": {
        const liveMsg = ev.live ?? (ev.payload as unknown as LiveSample | undefined);
        if (liveMsg) {
          this.resolveWaiters("live", liveMsg);
          this.subscribers.forEach((h) => h.onLive?.(liveMsg));
        }
        break;
      }
      case "hub_live": {
        // The server owns the Hub's USB port and decodes its binary frames; this event carries the
        // newest RSSI window per TDMA slot so live bars update at 20 Hz instead of 1 Hz STATUS.
        const p = ev.payload as
          | {
              slots?: Array<{ slot: number; dbm: number[]; seq: number; frames: number; floor: number; ageMs: number }>;
              hubOwnFrames?: number;
            }
          | undefined;
        if (!p?.slots) break;
        const now = Date.now();
        for (const s of p.slots) {
          if (!Array.isArray(s.dbm) || s.dbm.length !== 8) continue;
          const at = now - Math.max(0, s.ageMs || 0);
          this.hubSlotLive.set(s.slot, { frames: s.frames, lastFrameAtMs: at, seq: s.seq, dbm: s.dbm, floor: s.floor });
          if (s.slot === 1) {
            this.hubLastFrameAtMs = at;
            this.hubLastSeq = s.seq;
            this.hubLastDbm = s.dbm;
          }
        }
        if (typeof p.hubOwnFrames === "number") this.hubOwnFrames = p.hubOwnFrames;
        if (!this.lastStatus) {
          this.synthesizeHubStatusIfNeeded();
        }
        this.subscribers.forEach((h) => h.onHubLive?.());
        break;
      }
      case "scan": {
        const scanMsg = ev.scan ?? (ev.payload as unknown as ScanResult | undefined);
        if (scanMsg) {
          this.resolveWaiters("scan", scanMsg);
          this.subscribers.forEach((h) => h.onScan?.(scanMsg));
        }
        break;
      }
      case "bootlog": {
        const bootMsg = ev.bootLog ?? (ev.payload as unknown as BootLog | undefined);
        if (bootMsg) {
          this.resolveWaiters("bootlog", bootMsg);
          this.subscribers.forEach((h) => h.onBootLog?.(bootMsg));
        }
        break;
      }
      case "raw_reply":
        if (ev.line) {
          if (ev.msgType) {
            try {
              const parsed = JSON.parse(ev.line.startsWith("@") ? ev.line.slice(1) : ev.line);
              this.resolveWaiters(ev.msgType, parsed);
            } catch {
              // ignore
            }
          }
          this.subscribers.forEach((h) => h.onRawReply?.(ev.line!, ev.msgType));
        }
        break;
      case "log":
        if (ev.line) {
          this.subscribers.forEach((h) => h.onLog?.(ev.line!));
        }
        break;
      case "error":
        if (ev.error) {
          this.lastError = ev.error;
          if (this.waiters.length) {
            this.failWaiters(ev.error);
          }
          this.subscribers.forEach((h) => h.onError?.(ev.error!));
          this.notifyStateChange();
        }
        break;
    }
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
      throw new Error("No SlapRF firmware detected on this board. Flash it above first.");
    }
    return {
      chip: s?.chip ? `${s.chip.model} (${s.chip.rev})` : cfg?.chip || "Seeed XIAO ESP32-C5 (RISC-V 240 MHz)",
      role: cfg?.role ?? (s?.role === 1 ? "hub" : "spoke"),
      timerLabel: s?.label || cfg?.timerLabel || (s?.role === 1 ? "H1" : "T1"),
      fingerprint: s?.fp || cfg?.fingerprint || "",
      firmwareVersion: s?.fw || cfg?.firmwareVersion || LATEST_FIRMWARE_VERSION,
      frequenciesMHz: s?.freqs?.length ? s.freqs : cfg?.frequenciesMHz || [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917],
      status: s ? (s as unknown as TimerReadout["status"]) : cfg?.status,
    };
  }

  public static supported(): boolean {
    return isSimulatedUsbMode() || capabilitiesSnapshot().portable;
  }

  public async connect(showAllPorts = false): Promise<void> {
    this.showAllPorts = showAllPorts;
    this.userDisconnecting = false;
    this.reconnecting = false;
    this.reconnectAttempt = 0;
    this.reconnectFailed = false;
    this.lastError = null;
    this.notifyStateChange();
    const port = await pickUsbPort({ showAllPorts });
    if (isBackendSerialPort(port)) {
      await this.connectWithPort(port, showAllPorts);
      return;
    }
    await this.openPort(port);
    this.startStatusPolling();
    this.subscribers.forEach((h) => h.onConnect?.());
    this.notifyStateChange();
  }

  /**
   * Opens an already-picked port (`SimulatedSerialPort` or Go `BackendSerialPortHandle`),
   * probes `STATUS?` and `SLAPRF?`, and starts the status heartbeat.
   */
  public async connectWithPort(
    port: SerialPortLike,
    showAllPorts = false,
    probeTimeoutMs = 2500
  ): Promise<TimerStatus | null> {
    this.showAllPorts = showAllPorts;
    this.userDisconnecting = false;
    this.reconnecting = false;
    this.reconnectAttempt = 0;
    this.reconnectFailed = false;
    this.lastError = null;
    this.probing = true;
    this.connecting = true;
    this.connectStatus =
      isBackendSerialPort(port) && port.portName.trim().toLowerCase().startsWith("ble:")
        ? "Waiting for Bluetooth LE connection…"
        : "Waiting for connection…";
    this.busyLabel = "Connecting";
    this.notifyStateChange();
    const abortCtrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    this.connectAbort = abortCtrl;
    try {
      if (isBackendSerialPort(port)) {
        const prefix = backendTransportPrefix(port.portName);
        const res = await fetch(resolveBackendUrl(`${prefix}/connections/${this.slotIndex}`), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slotIndex: this.slotIndex, portName: port.portName }),
          signal: abortCtrl?.signal,
        });
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          cancelled?: boolean;
          slot?: BackendSlotSnapshot;
          pool?: BackendPoolSnapshot;
        };
        if (data.pool) {
          usbPool.applyBackendPoolSnapshot(data.pool);
        }
        if (data.cancelled) {
          return null;
        }
        if (!res.ok) {
          throw new Error(data.error || `Failed to open ${port.portName}`);
        }
        if (data.slot) {
          this.applyBackendSlotSnapshot(data.slot);
        } else {
          this.port = port;
        }
        void this.send("SLAPRF?").catch(() => undefined);
        return this.lastStatus;
      }

      await this.openPort(port);
      this.startStatusPolling();
      this.subscribers.forEach((h) => h.onConnect?.());
      this.notifyStateChange();
      const s = await this.ensureRunningApp(probeTimeoutMs);
      if (this.connected) {
        void this.send("SLAPRF?").catch(() => undefined);
      }
      return s;
    } finally {
      if (this.connectAbort === abortCtrl) {
        this.connectAbort = null;
      }
      this.connecting = false;
      this.connectStatus = null;
      this.probing = false;
      this.busyLabel = null;
      this.notifyStateChange();
    }
  }

  /**
   * Opens the USB port via the in-app port picker, probes `STATUS?` and `SLAPRF?`, and starts
   * the status heartbeat so the connection stays active across all SPA routes.
   */
  public async connectAndStart(showAllPorts = false): Promise<TimerStatus | null> {
    this.probing = true;
    this.notifyStateChange();
    try {
      const port = await pickUsbPort({ showAllPorts });
      return await this.connectWithPort(port, showAllPorts, 2000);
    } finally {
      this.probing = false;
      this.busyLabel = null;
      this.notifyStateChange();
    }
  }

  /**
   * Releases the underlying port for flashing or erasing while keeping this slot active
   * (`connected === true`, `writing === true`) so its connection pill stays visible in the UI.
   */
  public async releasePortForWrite(): Promise<SerialPortLike | null> {
    const port = this.port;
    if (!port) return null;
    this.otherPortsSnapshot = new Set();
    this.writing = true;
    this.expectingRestart = true;
    window.clearInterval(this.statusPollTimer);
    this.statusPollTimer = 0;
    if (isBackendSerialPort(port)) {
      this.failWaiters("Port busy for flash/erase");
      this.notifyStateChange();
      return port;
    }
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
   * Re-attaches this console slot to the board after flashing or erasing.
   */
  public async reopenPortAfterFlash(fallbackPort?: unknown, _expectApp = true): Promise<void> {
    this.probing = true;
    this.notifyStateChange();
    try {
      if (isBackendSerialPort(fallbackPort)) {
        await usbPool.syncFromBackend();
        return;
      }
      this.lastStatus = null;
      this.lastConfig = null;
      if (isSimulatedSerialPort(fallbackPort)) {
        await sleep(250);
        await this.connectWithPort(fallbackPort, this.showAllPorts);
        return;
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
    cancelActiveFlash();
    this.userDisconnecting = true;
    this.writing = false;
    this.busyLabel = null;
    this.reconnecting = false;
    this.reconnectAttempt = 0;
    this.reconnectFailed = false;
    this.lastError = null;
    window.clearInterval(this.statusPollTimer);
    this.statusPollTimer = 0;
    if (isSimulatedSerialPort(this.port)) {
      const tid = this.port.simulatedTimerId;
      const desc = listSimulatedTimers().find((t) => t.timerId === tid);
      if (tid === 1 || desc?.isHub) {
        await notifySimHubUsbConnected(false);
      }
    }
    if (isBackendSerialPort(this.port) || (capabilitiesSnapshot().portable && !isSimulatedUsbMode())) {
      await this.disconnect();
      return;
    }
    if (this.connected && (this.lastStatus || this.lastConfig)) {
      await withTimeout(this.send("LIVE 0\nSCAN STOP\nLOG 0"), 250).catch(() => undefined);
      await sleep(50);
    }
    await this.disconnect();
  }

  /**
   * Unpairs and forgets a Bluetooth Hub (`BLEPAIR CLEAR` + disconnect + remove persisted pairing)
   * so another phone, computer, or Raspberry Pi can pair without holding the physical BOOT button.
   */
  /** Aborts an in-flight connection or auto-reconnect attempt cleanly without raising an error banner. */
  public async cancelConnect(): Promise<void> {
    this.userDisconnecting = true;
    if (this.connectAbort) {
      try {
        this.connectAbort.abort();
      } catch {
        // ignore
      }
      this.connectAbort = null;
    }
    this.connecting = false;
    this.connectStatus = null;
    this.busyLabel = null;
    this.probing = false;
    this.reconnecting = false;
    this.reconnectAttempt = 0;
    this.reconnectFailed = false;
    this.lastError = null;
    this.notifyStateChange();
    if (capabilitiesSnapshot().portable && !isSimulatedUsbMode()) {
      const portHint = isBackendSerialPort(this.port) ? this.port.portName : null;
      const prefix = backendTransportPrefix(portHint);
      await fetch(resolveBackendUrl(`${prefix}/connections/${this.slotIndex}`), {
        method: "DELETE",
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((pool) => {
          if (pool) usbPool.applyBackendPoolSnapshot(pool as BackendPoolSnapshot);
        })
        .catch(() => undefined);
    } else if (this.port) {
      await this.closePort();
    }
    this.notifyStateChange();
  }

  public async forgetBluetoothDevice(): Promise<void> {
    const remembered = getPairedBluetoothHub();
    const fp = (this.lastStatus?.fp || this.lastConfig?.fingerprint || remembered?.fp || "").trim().toUpperCase();
    this.userDisconnecting = true;
    if (capabilitiesSnapshot().portable && !isSimulatedUsbMode()) {
      cancelActiveFlash();
      window.clearInterval(this.statusPollTimer);
      this.statusPollTimer = 0;
      this.writing = false;
      this.connecting = false;
      this.connectStatus = null;
      this.busyLabel = null;
      this.reconnecting = false;
      this.reconnectAttempt = 0;
      this.reconnectFailed = false;
      this.lastError = null;
      this.port = null;
      const qs = fp ? `?forget=1&fp=${encodeURIComponent(fp)}` : "?forget=1";
      await fetch(resolveBackendUrl(`/v1/slaprf/bluetooth/connections/${this.slotIndex}${qs}`), {
        method: "DELETE",
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((pool) => {
          if (pool) usbPool.applyBackendPoolSnapshot(pool as BackendPoolSnapshot);
        })
        .catch(() => undefined);
      setPairedSimBleHub(null);
      if (fp) {
        forgetKnownHardwareTimer(fp);
      }
      this.probing = false;
      this.clearDeviceIdentity();
      this.failWaiters("Disconnected");
      this.subscribers.forEach((h) => h.onDisconnect?.());
      this.notifyStateChange();
      return;
    }
    if (this.connected) {
      await withTimeout(this.send("BLEPAIR CLEAR"), 600).catch(() => undefined);
      await sleep(60);
      await this.disconnectCleanly();
    } else if (this.reconnecting) {
      await this.disconnectCleanly();
    }
    setPairedSimBleHub(null);
    if (fp) {
      forgetKnownHardwareTimer(fp);
    }
    this.notifyStateChange();
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
      await withTimeout(port.setSignals({ requestToSend: false }), 150);
      await withTimeout(port.setSignals({ dataTerminalReady: true, requestToSend: false }), 150);
      await withTimeout(port.setSignals({ dataTerminalReady: false, requestToSend: false }), 150);
    } catch {
      // Ignore on platforms/drivers that do not support setSignals
    }
  }

  private clearDeviceIdentity(): void {
    this.lastStatus = null;
    this.lastConfig = null;
    this.lastStatusAtMs = 0;
    this.lastRealJsonStatusAtMs = 0;
    this.lastKnownSpokeSig = "";
    this.hubOwnFrames = 0;
    this.hubLastFrameAtMs = 0;
    this.hubLastSeq = undefined;
    this.hubLastDbm = undefined;
    this.hubSlotLive.clear();
    this.hubSlotHello.clear();
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
    this.clearDeviceIdentity();
    this.writeQueue = Promise.resolve();
    this.writer = port.writable?.getWriter() ?? null;
    this.reader = port.readable?.getReader() ?? null;
    void this.readLoop(port);
  }

  public async disconnect(): Promise<void> {
    cancelActiveFlash();
    window.clearInterval(this.statusPollTimer);
    this.statusPollTimer = 0;
    this.writing = false;
    this.connecting = false;
    this.connectStatus = null;
    this.busyLabel = null;
    if (this.connectAbort) {
      try {
        this.connectAbort.abort();
      } catch {
        // ignore
      }
      this.connectAbort = null;
    }
    if (isBackendSerialPort(this.port) || (capabilitiesSnapshot().portable && !isSimulatedUsbMode())) {
      const portHint = isBackendSerialPort(this.port) ? this.port.portName : null;
      const prefix = backendTransportPrefix(portHint);
      this.port = null;
      await fetch(resolveBackendUrl(`${prefix}/connections/${this.slotIndex}`), {
        method: "DELETE",
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((pool) => {
          if (pool) usbPool.applyBackendPoolSnapshot(pool as BackendPoolSnapshot);
        })
        .catch(() => undefined);
      this.probing = false;
      this.clearDeviceIdentity();
      this.failWaiters("Disconnected");
      this.subscribers.forEach((h) => h.onDisconnect?.());
      this.notifyStateChange();
      return;
    }
    await this.closePort();
    this.probing = false;
    this.clearDeviceIdentity();
    this.failWaiters("Disconnected");
    this.subscribers.forEach((h) => h.onDisconnect?.());
    this.notifyStateChange();
  }

  /**
   * Best-effort synchronous/immediate teardown for page reload (`beforeunload` / `pagehide`).
   * Note: Physical USB ports owned by the Go backend stay open continuously on the server!
   */
  public disconnectForUnload(): void {
    window.clearInterval(this.statusPollTimer);
    this.statusPollTimer = 0;
    if (isBackendSerialPort(this.port)) {
      this.failWaiters("Page unloading");
      return;
    }
    const port = this.port;
    const writer = this.writer;
    const reader = this.reader;
    this.port = null;
    this.writer = null;
    this.reader = null;
    this.clearDeviceIdentity();
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
    const pendingWrites = this.writeQueue;
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.writeQueue = Promise.resolve();

    await withTimeout(pendingWrites, 150).catch(() => undefined);

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
        writer.releaseLock();
      } catch {
        // ignore
      }
    }

    if (port) {
      try {
        await withTimeout(port.setSignals({ dataTerminalReady: false, requestToSend: false }), 150);
      } catch {
        // ignore
      }
      try {
        await withTimeout(port.close(), 400);
      } catch {
        // ignore
      }
    }
  }

  public async send(command: string): Promise<void> {
    if (isBackendSerialPort(this.port)) {
      const res = await fetch(resolveBackendUrl(backendCommandPath(this.port.portName)), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slotIndex: this.slotIndex, command }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Not connected");
      }
      return;
    }
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
    if (isBackendSerialPort(this.port) && command) {
      return fetch(resolveBackendUrl(backendCommandPath(this.port.portName)), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slotIndex: this.slotIndex,
          command,
          expectType: type,
          timeoutMs,
        }),
      }).then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          reply?: T;
          pool?: BackendPoolSnapshot;
        };
        if (data.pool) {
          usbPool.applyBackendPoolSnapshot(data.pool);
        }
        if (!res.ok) {
          throw new Error(data.error || `No ${type} reply within ${Math.round(timeoutMs / 1000)} s`);
        }
        return data.reply as T;
      });
    }
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
   * finishing boot, we catch its first status reply cleanly.
   */
  public async ensureRunningApp(timeoutMs = 2000): Promise<TimerStatus | null> {
    if (!this.port) return null;
    if (isBackendSerialPort(this.port)) {
      return this.lastStatus;
    }
    const deadline = Date.now() + timeoutMs;
    let first = true;
    while (Date.now() < deadline && this.port && !this.sawRomBootloader) {
      if (this.lastStatus) return this.lastStatus;
      try {
        const cmd = first ? "LIVE 0\nSCAN STOP\nLOG 0\nSTATUS?\nSLAPRF?" : "STATUS?";
        first = false;
        return await this.request<TimerStatus>(cmd, "status", 650);
      } catch {
        if (this.lastStatus || this.lastConfig) return this.lastStatus;
        if (this.sawRomBootloader) return null;
      }
      await sleep(90);
    }
    return this.lastStatus;
  }

  /**
   * Restart the timer and reattach to it, resolving with the first status after the restart.
   */
  public async restartAndReconnect(timeoutMs = 15000, cmd: "REBOOT" = "REBOOT"): Promise<TimerStatus> {
    const before = await this.request<TimerStatus>("STATUS?", "status", 2000).catch(() => this.lastStatus);
    this.expectingRestart = true;
    try {
      await this.send(cmd).catch(() => undefined);
      const deadline = Date.now() + timeoutMs;
      await sleep(isBackendSerialPort(this.port) ? 600 : 120);
      while (Date.now() < deadline) {
        try {
          const s = await this.request<TimerStatus>("STATUS?", "status", 1500);
          if (s && (!before || s.boots > before.boots || s.uptimeMs < before.uptimeMs)) {
            return s;
          }
        } catch {
          // still rebooting / re-enumerating on Go USB manager
        }
        await sleep(350);
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
      } else if (!this.userDisconnecting && !isSimulatedSerialPort(port)) {
        window.clearInterval(this.statusPollTimer);
        this.statusPollTimer = 0;
        await this.closePort();
        this.probing = false;
        this.clearDeviceIdentity();
        this.failWaiters("USB disconnected");
        this.subscribers.forEach((h) => h.onDisconnect?.());
        this.notifyStateChange();
        void this.attemptAutoReconnect(port);
      } else {
        await this.disconnect();
      }
    }
  }

  private async attemptAutoReconnect(_lostPort?: SerialPortLike): Promise<void> {
    // Physical USB auto-reconnect runs natively inside Go's `usb.Manager`.
    this.reconnecting = false;
    this.reconnectFailed = true;
    this.lastError = "USB connection closed.";
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
          recordSerialPortMeta(this.port, {
            label: parsed.timerLabel,
            fp: parsed.fingerprint,
            role: parsed.role,
          });
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
    if (len >= 16 && src[at] === 0xc5 && src[at + 2] >= 1 && src[at + 2] <= 7) {
      const slot = src[at + 2];
      const kind = src[at + 1];
      if (kind === 0x5a && len === 36) {
        const role = src[at + 3];
        const fpNum =
          (src[at + 4] | (src[at + 5] << 8) | (src[at + 6] << 16) | (src[at + 7] << 24)) >>> 0;
        const fp = fpNum.toString(16).toUpperCase().padStart(8, "0");
        const sweepHz = src[at + 9] || 50;
        let labelEnd = at + 10;
        while (labelEnd < at + 34 && src[labelEnd] !== 0) labelEnd++;
        const label = this.decoder.decode(src.subarray(at + 10, labelEnd)).trim() || (slot === 1 ? "H1" : `T${slot - 1}`);
        this.hubSlotHello.set(slot, { fp, label, role, sweepHz });
        this.synthesizeHubStatusIfNeeded();
      } else if (kind === 0x60) {
        const decodeVal = (b: number): number => (b === 0 ? -127 : -127.5 + 0.5 * b);
        const sampleCount = src[at + 3];
        if (sampleCount >= 1 && len >= 7 + sampleCount * 9 + 1) {
          const now = Date.now();
          const floor = (src[at + 6] << 24) >> 24;
          const newestOff = at + 7 + (sampleCount - 1) * 9;
          const seq = src[newestOff];
          const dbm: number[] = [];
          for (let ch = 0; ch < 8; ch++) {
            let best = decodeVal(src[newestOff + 1 + ch]);
            for (let s = 0; s < sampleCount; s++) {
              const v = decodeVal(src[at + 7 + s * 9 + 1 + ch]);
              if (v > best) best = v;
            }
            dbm.push(best);
          }
          const prev = this.hubSlotLive.get(slot);
          this.hubSlotLive.set(slot, {
            frames: (prev?.frames ?? 0) + 1,
            lastFrameAtMs: now,
            seq,
            dbm,
            floor,
          });
          if (slot === 1) {
            this.hubOwnFrames++;
            this.hubLastFrameAtMs = now;
            this.hubLastSeq = seq;
            this.hubLastDbm = dbm;
          }
          this.synthesizeHubStatusIfNeeded();
        }
      } else if (kind === 0x61) {
        const decodeVal = (b: number): number => (b === 0 ? -127 : -127.5 + 0.5 * b);
        const now = Date.now();
        const seq = src[at + 3];
        const floor = (src[at + 6] << 24) >> 24;
        const dbm: number[] = [];
        for (let ch = 0; ch < 8; ch++) {
          dbm.push(decodeVal(src[at + 7 + ch]));
        }
        const prev = this.hubSlotLive.get(slot);
        this.hubSlotLive.set(slot, {
          frames: (prev?.frames ?? 0) + 1,
          lastFrameAtMs: now,
          seq,
          dbm,
          floor,
        });
        if (slot === 1) {
          this.hubOwnFrames++;
          this.hubLastFrameAtMs = now;
          this.hubLastSeq = seq;
          this.hubLastDbm = dbm;
        }
        this.synthesizeHubStatusIfNeeded();
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
   * When a Hub is streaming binary frames (`0xC5 0x60` / `0xC5 0x5A`) at Priority 1 while its
   * Priority 0 `STATUS?` task is delayed under heavy Spoke traffic, synthesize/refresh `lastStatus`
   * directly from the binary Hub stream so the Hub is recognized immediately on connect.
   */
  private synthesizeHubStatusIfNeeded(): void {
    const now = Date.now();
    if (this.lastRealJsonStatusAtMs > 0 && now - this.lastRealJsonStatusAtMs < 2500) {
      return;
    }
    if (this.hubOwnFrames === 0 && !this.hubSlotHello.has(1)) {
      return;
    }
    if (this.lastStatus && now - this.lastStatusAtMs < 400 && !this.probing && this.waiters.length === 0) {
      return;
    }
    const hello1 = this.hubSlotHello.get(1);
    const live1 = this.hubSlotLive.get(1);
    const blePortFp =
      isBackendSerialPort(this.port) && /^ble:[0-9a-f]{8}$/i.test(this.port.portName)
        ? this.port.portName.slice(4).toUpperCase()
        : "";
    const fp = hello1?.fp || this.lastConfig?.fingerprint || this.lastStatus?.fp || blePortFp;
    if (!fp) {
      // Wait for STATUS?, SLAPRF?, or the Hub's 0xC5 0x5A HELLO frame so we never
      // borrow a previously connected Hub's identity from localStorage.
      return;
    }
    const knownTimers = getKnownHardwareTimers();
    const knownHub = knownTimers.find((t) => t.role === "hub" && t.fp.toUpperCase() === fp.toUpperCase());
    const label = hello1?.label || this.lastConfig?.timerLabel || this.lastStatus?.label || knownHub?.label || "H1";
    const isBleHub = Boolean(blePortFp || this.lastStatus?.image === "ble" || this.lastStatus?.ble);
    const sweepHz = hello1?.sweepHz || this.lastStatus?.sweepHz || (isBleHub ? 50 : 100);
    const spokes: TimerPeerSpoke[] = [];
    for (let slot = 2; slot <= 7; slot++) {
      const sh = this.hubSlotHello.get(slot);
      const sl = this.hubSlotLive.get(slot);
      if (!sh) continue;
      const prevSpoke = this.lastStatus?.spokes?.find((sp) => sp.slot === slot);
      const knownSpoke = knownTimers.find((t) => t.role === "spoke" && t.fp.toUpperCase() === sh.fp.toUpperCase());
      spokes.push({
        slot,
        fp: sh.fp,
        label: sh.label || knownSpoke?.label || `T${slot - 1}`,
        fw: knownSpoke?.fw || prevSpoke?.fw || LATEST_FIRMWARE_VERSION,
        mac: knownSpoke?.mac || prevSpoke?.mac,
        msAgo: sl ? Math.max(0, now - sl.lastFrameAtMs) : (prevSpoke?.msAgo ?? 0),
        frames: sl?.frames ?? prevSpoke?.frames ?? 0,
        seq: sl?.seq ?? prevSpoke?.seq,
        dbm: sl?.dbm ?? prevSpoke?.dbm,
        floorDb: sl?.floor ?? prevSpoke?.floorDb,
      });
    }
    const st: TimerStatus = {
      fw: this.lastConfig?.firmwareVersion || this.lastStatus?.fw || knownHub?.fw || LATEST_FIRMWARE_VERSION,
      role: 1,
      fp,
      label,
      uptimeMs: this.lastStatus ? this.lastStatus.uptimeMs + (now - this.lastStatusAtMs) : 1000,
      reset: this.lastStatus?.reset || "usb",
      boots: this.lastStatus?.boots || 1,
      emergencyMode: false,
      crashStreak: 0,
      heapFree: this.lastStatus?.heapFree || 56800,
      heapMin: this.lastStatus?.heapMin || 56200,
      sweepHz,
      sweeps: this.hubOwnFrames * 4,
      sweepUs: this.lastStatus?.sweepUs || (isBleHub ? 5400 : sweepHz >= 100 ? 6100 : 13400),
      sweepUsMax: this.lastStatus?.sweepUsMax || (isBleHub ? 5900 : sweepHz >= 100 ? 6650 : 15800),
      sweepBudgetUs: this.lastStatus?.sweepBudgetUs || (isBleHub ? 6000 : sweepHz >= 100 ? 7000 : 20000),
      rf: {
        ok: true,
        enabled: true,
        gain: this.lastStatus?.rf.gain ?? 30,
        gainMax: this.lastStatus?.rf.gainMax ?? 80,
        floorDb: this.lastStatus?.rf.floorDb ?? live1?.floor ?? -90.0,
      },
      chip: this.lastStatus?.chip || {
        model: "ESP32-C5",
        rev: "v1.0",
        mac: knownHub?.mac || "",
        flashMB: 8,
      },
      net: {
        mode: "espnow-lr",
        stations: spokes.length,
      },
      channel: 1,
      slot: 1,
      scanLive: false,
      freqsTemporary: false,
      chanMask: 255,
      freqs: this.lastConfig?.frequenciesMHz || this.lastStatus?.freqs || [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917],
      dbm: live1?.dbm ?? this.hubLastDbm ?? this.lastStatus?.dbm,
      spokes,
      ...(blePortFp || this.lastStatus?.image === "ble" || this.lastStatus?.ble
        ? {
            image: "ble",
            transport: "ble",
            ble: this.lastStatus?.ble ?? {
              connected: true,
              paired: true,
              pairingMode: false,
              intervalUs: 15000,
              mtu: 247,
              phy: 2,
              rssi: 0,
              txNotifies: 0,
              txBytes: 0,
              txDrops: 0,
              rxWrites: 0,
              nocp: 0,
              connects: 1,
              sync: true,
              syncLocked: false,
              phaseUs: -1,
            },
          }
        : {}),
    };
    const wasProbing = this.probing;
    this.probing = false;
    const labelChanged =
      wasProbing ||
      this.lastStatus?.label !== st.label ||
      this.lastStatus?.fp !== st.fp ||
      this.lastStatus?.role !== st.role;
    this.lastStatus = st;
    this.lastStatusAtMs = now;
    recordSerialPortMeta(this.port, {
      label: st.label,
      fp: st.fp,
      role: "hub",
    });
    recordKnownTimerStatus(st);
    this.resolveWaiters("status", st);
    this.subscribers.forEach((h) => h.onStatus?.(st));
    if (labelChanged) {
      this.notifyStateChange();
    }
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
            this.lastRealJsonStatusAtMs = this.lastStatusAtMs;
            recordSerialPortMeta(this.port, {
              label: st.label,
              fp: st.fp,
              role: st.role === 1 ? "hub" : "spoke",
            });
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

  private savedSimSlots: Array<{ slotIndex: 0 | 1; timerId: number }> = [];
  private savedSimDebugSlot = 0;
  private restoringSimPorts = false;
  private backendUsbWs: WebSocket | null = null;
  private backendUsbWsPath = "";
  private backendUsbReconnectTimer: number | null = null;
  private backendRealActive = false;

  public applyBackendPoolSnapshot(pool: BackendPoolSnapshot): void {
    if (Array.isArray(pool.knownTimers)) {
      backendKnownTimersCache = pool.knownTimers;
      backendKnownTimersHydrated = true;
      for (const kt of pool.knownTimers) {
        if (kt && kt.fp) {
          recordKnownHardwareTimer(kt);
        }
      }
    }
    if (typeof pool.debugSlotIndex === "number") {
      this._debugSlotIndex = pool.debugSlotIndex === 1 ? 1 : 0;
    }
    if (Array.isArray(pool.slots)) {
      const seenSlots = new Set<number>();
      for (const snap of pool.slots) {
        seenSlots.add(snap.slotIndex);
        const slot = this.slots[snap.slotIndex];
        if (slot) {
          slot.applyBackendSlotSnapshot(snap);
        }
      }
      for (let idx = 0; idx < this.slots.length; idx++) {
        if (!seenSlots.has(idx)) {
          this.slots[idx].applyBackendSlotSnapshot({
            slotIndex: idx,
            connected: false,
            connecting: false,
            connectStatus: "",
            probing: false,
            reconnecting: false,
            reconnectAttempt: 0,
            maxReconnectAttempts: 0,
            reconnectFailed: false,
            isOtherDevice: false,
          });
        }
      }
    }
    this.notify();
  }

  public async syncFromBackend(): Promise<void> {
    if (!capabilitiesSnapshot().portable || isSimulatedUsbMode()) return;
    try {
      const prefix = backendTransportPrefix();
      const res = await fetch(resolveBackendUrl(`${prefix}/connections`), { cache: "no-store" });
      if (res.ok) {
        const pool = (await res.json()) as BackendPoolSnapshot;
        this.applyBackendPoolSnapshot(pool);
      }
    } catch {
      // ignore
    }
  }

  private ensureBackendUsbWs(): void {
    if (!this.backendRealActive || !capabilitiesSnapshot().portable || typeof WebSocket === "undefined") {
      return;
    }
    const wantPath = backendWsPath();
    if (
      this.backendUsbWs &&
      this.backendUsbWsPath === wantPath &&
      (this.backendUsbWs.readyState === WebSocket.OPEN || this.backendUsbWs.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    if (this.backendUsbWs) {
      this.stopBackendUsbWs();
    }
    try {
      const ws = new WebSocket(resolveBackendWsUrl(wantPath));
      this.backendUsbWs = ws;
      this.backendUsbWsPath = wantPath;
      ws.onmessage = (ev: MessageEvent) => {
        if (ws !== this.backendUsbWs || typeof ev.data !== "string") return;
        try {
          const parsed = JSON.parse(ev.data) as BackendUsbEvent;
          if (parsed.type === "pool_state" && parsed.pool) {
            this.applyBackendPoolSnapshot(parsed.pool);
            return;
          }
          const slot = this.slots[parsed.slotIndex];
          if (slot) {
            slot.handleBackendEvent(parsed);
          }
        } catch {
          // ignore malformed WS event
        }
      };
      ws.onclose = () => {
        if (ws !== this.backendUsbWs) return;
        this.backendUsbWs = null;
        if (this.backendRealActive && this.backendUsbReconnectTimer === null) {
          this.backendUsbReconnectTimer = window.setTimeout(() => {
            this.backendUsbReconnectTimer = null;
            this.ensureBackendUsbWs();
          }, 1000);
        }
      };
      ws.onerror = () => {
        // handled by onclose
      };
    } catch {
      // ignore
    }
  }

  private stopBackendUsbWs(): void {
    if (this.backendUsbReconnectTimer !== null) {
      window.clearTimeout(this.backendUsbReconnectTimer);
      this.backendUsbReconnectTimer = null;
    }
    if (this.backendUsbWs) {
      const s = this.backendUsbWs;
      this.backendUsbWs = null;
      this.backendUsbWsPath = "";
      try {
        s.close();
      } catch {
        // ignore
      }
    }
  }

  public async attachBackendMode(simMode: boolean): Promise<void> {
    if (!capabilitiesSnapshot().portable) {
      this.backendRealActive = false;
      this.stopBackendUsbWs();
      return;
    }
    if (simMode) {
      this.backendRealActive = false;
      this.stopBackendUsbWs();
      for (const c of this.slots) {
        if (isBackendSerialPort(c.rawPort)) {
          c.applyBackendSlotSnapshot({
            slotIndex: c.slotIndex,
            connected: false,
            probing: false,
            reconnecting: false,
            reconnectAttempt: 0,
            maxReconnectAttempts: 5,
            reconnectFailed: false,
            isOtherDevice: false,
          });
        }
      }
      return;
    }
    this.backendRealActive = true;
    await this.disconnectSimulatedPorts();
    await this.syncFromBackend();
    this.ensureBackendUsbWs();
  }

  private persistActiveSimSlots(): void {
    if (this.restoringSimPorts || !isSimulatedUsbMode()) return;
    const activeSim: Array<{ slotIndex: 0 | 1; timerId: number }> = [];
    for (const c of this.slots) {
      if (c.connected && isSimulatedSerialPort(c.rawPort)) {
        activeSim.push({
          slotIndex: (c.slotIndex === 1 ? 1 : 0) as 0 | 1,
          timerId: c.rawPort.simulatedTimerId,
        });
      }
    }
    this.savedSimSlots = activeSim;
    this.savedSimDebugSlot = this._debugSlotIndex;
    try {
      window.localStorage.setItem(
        "slaprf.sim.usb_slots.v1",
        JSON.stringify({ slots: activeSim, debugSlot: this._debugSlotIndex })
      );
    } catch {
      // ignore storage errors
    }
  }

  public async restorePersistedSimPorts(): Promise<void> {
    if (!isSimulatedUsbMode()) return;
    let hasStoredPref = false;
    try {
      const raw = window.localStorage.getItem("slaprf.sim.usb_slots.v1");
      if (raw) {
        hasStoredPref = true;
        const parsed = JSON.parse(raw) as {
          slots?: Array<{ slotIndex: 0 | 1; timerId: number }>;
          debugSlot?: number;
        };
        if (Array.isArray(parsed.slots)) {
          this.savedSimSlots = parsed.slots;
        }
        if (typeof parsed.debugSlot === "number") {
          this.savedSimDebugSlot = parsed.debugSlot === 1 ? 1 : 0;
        }
      }
    } catch {
      // ignore storage errors
    }
    if (!hasStoredPref && this.savedSimSlots.length === 0 && capabilitiesSnapshot().demoMode && Boolean(window.slaprfWasm)) {
      const hub = listSimulatedTimers().find((t) => t.isHub && t.poweredOn);
      if (hub) {
        this.savedSimSlots = [{ slotIndex: 0, timerId: hub.timerId }];
      }
    }
    if (this.savedSimSlots.length === 0 && capabilitiesSnapshot().portable && !window.slaprfWasm) {
      try {
        const res = await fetch(resolveBackendUrl("/v1/sim/slaprf/hub-usb"), { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as { connected?: boolean };
          if (data.connected) {
            const hub = listSimulatedTimers().find((t) => t.isHub && t.poweredOn);
            if (hub) {
              this.savedSimSlots = [{ slotIndex: 0, timerId: hub.timerId }];
            }
          }
        }
      } catch {
        // ignore
      }
    }
    if (this.savedSimSlots.length === 0) return;
    this.restoringSimPorts = true;
    try {
      const powered = new Set(listSimulatedTimers().filter((t) => t.poweredOn).map((t) => t.timerId));
      for (const item of this.savedSimSlots) {
        if (powered.has(item.timerId)) {
          await this.connectSimulatedTimer(item.timerId, item.slotIndex).catch(() => undefined);
        }
      }
      if (this.slots[this.savedSimDebugSlot]?.connected) {
        this._debugSlotIndex = this.savedSimDebugSlot;
      }
    } finally {
      this.restoringSimPorts = false;
      this.persistActiveSimSlots();
      this.notify();
    }
  }

  public get debugSlotIndex(): number {
    return this._debugSlotIndex;
  }

  /** The main USB connection (Slot 0) used across the app (TopBar, Network, Flasher). */
  public get mainConsole(): TimerConsole {
    return this.slots[0];
  }

  /**
   * The USB connection inspected by the Debug page: defaults to `mainConsole` (Slot 0),
   * or Slot 1 when the user swaps to debug a second USB device in the Debug window.
   */
  public get debugConsole(): TimerConsole {
    if (this._debugSlotIndex === 1) {
      const swapSlot = this.slots[1];
      if (swapSlot && (swapSlot.connected || swapSlot.busyLabel || swapSlot.reconnecting)) {
        return swapSlot;
      }
      this._debugSlotIndex = 0;
    }
    return this.slots[0];
  }

  public setDebugSlot(slotIndex: number): void {
    const next = slotIndex === 1 ? 1 : 0;
    if (next !== this._debugSlotIndex) {
      this._debugSlotIndex = next;
      if (capabilitiesSnapshot().portable && !isSimulatedUsbMode()) {
        void fetch(resolveBackendUrl("/v1/slaprf/usb/debug-slot"), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slotIndex: next }),
        }).catch(() => undefined);
      }
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
    const isHub = (c: TimerConsole): boolean =>
      c.connected &&
      (c.lastStatus?.role === 1 || c.lastConfig?.role === "hub" || c.transportLabel === "Bluetooth");
    const main = this.slots[0];
    if (isHub(main)) return main;
    return this.slots.find(isHub) ?? null;
  }

  public primaryConsole(): TimerConsole {
    return this.slots[0];
  }

  public canConnectMore(): boolean {
    return !this.slots[0].connected;
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

  /** Connects the main USB/BLE connection (Slot 0), always presenting the device selection dialog. */
  public async connectMain(
    showAllPorts = false
  ): Promise<{ console: TimerConsole; status: TimerStatus | null; alreadyConnected: boolean }> {
    const main = this.slots[0];
    if (main.busyLabel) {
      return { console: main, status: main.lastStatus, alreadyConnected: main.connected };
    }
    const bleMode = isBleHardwareMode();
    const paired = bleMode ? getPairedBluetoothHub() : null;
    const port = await pickUsbPort({
      showAllPorts,
      alreadyPaired: Boolean(paired),
      preferredPortName: paired?.portName,
    });
    const existing = this.findOwnerOfPort(port);
    if (existing) {
      if (existing === main) {
        return { console: main, status: main.lastStatus, alreadyConnected: true };
      }
      await existing.disconnectCleanly();
    }
    if (main.connected) {
      await main.disconnectCleanly();
    }
    let status: TimerStatus | null = null;
    try {
      status = await main.connectWithPort(port, showAllPorts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (bleMode && paired && /paired to another device/i.test(msg)) {
        clearLocalBlePairing(paired.fp);
        this.notify();
      }
      throw err;
    }
    if (bleMode && isSimulatedSerialPort(port)) {
      const desc = listSimulatedTimers().find((t) => t.timerId === port.simulatedTimerId);
      setPairedSimBleHub({
        fp: (status?.fp || desc?.fingerprint || "SIM").toUpperCase(),
        label: status?.label || desc?.label || "H1",
        timerId: port.simulatedTimerId,
      });
      this.notify();
    }
    return { console: main, status, alreadyConnected: false };
  }

  /**
   * Connects a specific simulated timer directly to `slotIndex` (0 = main USB, 1 = secondary Debug USB)
   * without opening the port picker modal.
   */
  public async connectSimulatedTimer(timerId: number, slotIndex: 0 | 1 = 0): Promise<TimerStatus | null> {
    if (!isSimulatedUsbMode()) return null;
    const target = this.slots[slotIndex];
    const existing = this.slots.find(
      (c) => isSimulatedSerialPort(c.rawPort) && c.rawPort.simulatedTimerId === timerId
    );
    if (existing) {
      if (existing === target) {
        if (slotIndex === 1) this.setDebugSlot(1);
        return target.lastStatus;
      }
      await existing.disconnectCleanly();
    }
    if (target.connected || target.reconnecting) {
      await target.disconnectCleanly();
    }
    const port = new SimulatedSerialPort(timerId);
    if (slotIndex === 1) {
      this._debugSlotIndex = 1;
      this.notify();
    }
    const status = await target.connectWithPort(port, true);
    if (slotIndex === 1) {
      this._debugSlotIndex = target.connected ? 1 : 0;
    }
    this.notify();
    return status;
  }

  /** Connects Slot 0 to the default powered simulated Hub (`H1`) when in simulated USB mode. */
  public async connectDefaultSimHub(): Promise<void> {
    if (!isSimulatedUsbMode()) return;
    const hub = listSimulatedTimers().find((t) => t.isHub && t.poweredOn);
    if (!hub) return;
    await this.connectSimulatedTimer(hub.timerId, 0).catch(() => undefined);
    this.persistActiveSimSlots();
    this.notify();
  }

  /** Disconnects any slot currently connected to a `SimulatedSerialPort`. */
  public async disconnectSimulatedPorts(): Promise<void> {
    for (const c of this.slots) {
      if (isSimulatedSerialPort(c.rawPort)) {
        await c.disconnectCleanly().catch(() => undefined);
      }
    }
    if (!this.slots[1].connected) {
      this._debugSlotIndex = 0;
    }
    this.notify();
  }

  /**
   * Disconnects any simulated USB slot whose underlying simulated timer was powered off or deleted
   * on the Simulator tab.
   */
  public async reconcileSimulatedPorts(): Promise<void> {
    if (!isSimulatedUsbMode()) {
      await this.disconnectSimulatedPorts();
      return;
    }
    const activeTimers = listSimulatedTimers();
    for (const c of this.slots) {
      if (isSimulatedSerialPort(c.rawPort)) {
        const tid = c.rawPort.simulatedTimerId;
        const found = activeTimers.find((t) => t.timerId === tid && t.poweredOn);
        if (!found) {
          await c.disconnectCleanly().catch(() => undefined);
        }
      }
    }
    if (!this.slots[1].connected && this._debugSlotIndex === 1) {
      this._debugSlotIndex = 0;
      this.notify();
    }
  }

  /**
   * Connects or swaps the Debug window's target USB device:
   * - If `mainConsole` (Slot 0) is not connected, connects `mainConsole`.
   * - If `mainConsole` is connected, opens the port picker to swap the Debug window to another USB
   *   device in Slot 1 (disconnecting any previous Slot 1 debug device first) while keeping
   *   `mainConsole` connected in the background.
   */
  public async connectOrSwapDebug(
    showAllPorts = false
  ): Promise<{ console: TimerConsole; status: TimerStatus | null; alreadyConnected: boolean }> {
    const main = this.slots[0];
    if (!main.connected && !main.reconnecting) {
      this._debugSlotIndex = 0;
      return await this.connectMain(showAllPorts);
    }
    const excludePorts = main.rawPort ? [main.rawPort] : [];
    const port = await pickUsbPort({ showAllPorts, excludePorts });
    const existing = this.findOwnerOfPort(port);
    if (existing) {
      this.setDebugSlot(existing.slotIndex === 1 ? 1 : 0);
      return { console: existing, status: existing.lastStatus, alreadyConnected: true };
    }
    const swapSlot = this.slots[1];
    if (swapSlot.connected || swapSlot.reconnecting) {
      await swapSlot.disconnectCleanly();
    }
    swapSlot.setBusyLabel("Connecting");
    this._debugSlotIndex = 1;
    this.notify();
    try {
      const status = await swapSlot.connectWithPort(port, showAllPorts);
      this._debugSlotIndex = swapSlot.connected ? 1 : 0;
      this.notify();
      return { console: swapSlot, status, alreadyConnected: false };
    } catch (err) {
      this._debugSlotIndex = 0;
      this.notify();
      throw err;
    }
  }

  /** Disconnects the swapped Debug USB device (Slot 1) and returns Debug to the main USB connection (Slot 0). */
  public async revertDebugToMain(): Promise<void> {
    const swapSlot = this.slots[1];
    this._debugSlotIndex = 0;
    if (swapSlot.connected || swapSlot.reconnecting) {
      await swapSlot.disconnectCleanly();
    } else {
      this.notify();
    }
  }

  public async connectNew(
    showAllPorts = false,
    selectForDebug = false
  ): Promise<{ console: TimerConsole; status: TimerStatus | null; alreadyConnected: boolean }> {
    if (selectForDebug) {
      return await this.connectOrSwapDebug(showAllPorts);
    }
    return await this.connectMain(showAllPorts);
  }

  /**
   * Releases the main USB connection's open `SerialPort` so the Flasher or Eraser can talk
   * to the ESP32-C5 ROM bootloader directly without popping up a second USB port picker, and
   * returns a `reopen` callback that re-attaches the main `TimerConsole` slot afterwards.
   */
  public async takeActivePort(): Promise<{
    port: SerialPortLike;
    reopen: (opts?: { expectApp?: boolean }) => Promise<void>;
  } | null> {
    const active = this.mainConsole;
    const port = await active.releasePortForWrite();
    if (!port) return null;
    return {
      port,
      reopen: (opts) => active.reopenPortAfterFlash(port, opts?.expectApp ?? true),
    };
  }

  public async disconnectAllCleanly(): Promise<void> {
    await Promise.all(
      this.slots.map((c) => (c.connected || c.reconnecting ? c.disconnectCleanly().catch(() => undefined) : Promise.resolve()))
    );
  }

  /**
   * Called when switching from Real mode to Simulation mode:
   * restores any previously connected simulated USB ports that are still powered on
   * (Go's `usb.Manager` automatically suspends physical USB connections when `SetSimMode(true)` runs).
   */
  public async suspendRealAndRestoreSim(): Promise<void> {
    if (this.savedSimSlots.length > 0 && isSimulatedUsbMode()) {
      const powered = new Set(listSimulatedTimers().filter((t) => t.poweredOn).map((t) => t.timerId));
      for (const item of this.savedSimSlots) {
        if (powered.has(item.timerId)) {
          await this.connectSimulatedTimer(item.timerId, item.slotIndex).catch(() => undefined);
        }
      }
      if (this.slots[this.savedSimDebugSlot]?.connected) {
        this._debugSlotIndex = this.savedSimDebugSlot;
      }
      this.notify();
    } else if (isSimulatedUsbMode()) {
      await this.restorePersistedSimPorts();
    }
  }

  /**
   * Called when switching from Simulation mode back to Real mode:
   * saves any currently connected simulated USB ports, closes their local browser handles,
   * and syncs physical USB slots from the Go backend (`usb.Manager` restores suspended ports).
   */
  public async suspendSimAndRestoreReal(): Promise<void> {
    const activeSim: Array<{ slotIndex: 0 | 1; timerId: number }> = [];
    for (const c of this.slots) {
      if (c.connected && isSimulatedSerialPort(c.rawPort)) {
        activeSim.push({
          slotIndex: (c.slotIndex === 1 ? 1 : 0) as 0 | 1,
          timerId: c.rawPort.simulatedTimerId,
        });
        c.disconnectForUnload();
      }
    }
    this.savedSimSlots = activeSim;
    this.savedSimDebugSlot = this._debugSlotIndex;
    await this.syncFromBackend();
    this.notify();
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
    this.persistActiveSimSlots();
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
