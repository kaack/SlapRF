import { esc } from "../core/format";
import { icons } from "../core/icons";
import { AppStore } from "../state/store";
import { DetectedTimer, isSlapRFMode, SimTimerState } from "../types/models";
import { capabilitiesSnapshot, resolveBackendUrl } from "./capabilities";
import { LATEST_FIRMWARE_VERSION, parseSlaprfConfigBlock } from "./esp_flasher";
import type { SerialPortLike, TimerPeerSpoke, TimerStatus } from "./timer_console";

const RACEBAND_DEFAULT = [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917];
const CONFIG_MAGIC = "SLAPRF02";
const CONFIG_LEN = 160;
const OFF_VERSION = 8;
const OFF_ROLE = 11;
const OFF_RESERVED = 12;
const OFF_WIFI_MODE = 13;
const OFF_FINGERPRINT = 14;
const OFF_FREQS = 18;
const OFF_LABEL = 107;
const OFF_CRC = CONFIG_LEN - 1;

interface SimTimerFirmwareState {
  timerId: number;
  bootEpochMs: number;
  boots: number;
  resetReason: string;
  emergencyMode: boolean;
  rfEnabled: boolean;
  chanMask: number;
  freqsTemporary: boolean;
  customFreqs: number[] | null;
  sweeps: number;
  pk: number[];
  hits: number[];
  aboveThr: boolean[];
  lastSamplePerfMs: number;
}

type SimStoreWindow = Window & {
  __slaprfSimSerialStore?: AppStore;
  __slaprfOpenSimPorts?: Set<SimulatedSerialPort>;
  __slaprfSimTimerAction?: ((payload: SimBoardMutationPayload) => Promise<void>) | null;
};

let boundStore: AppStore | null = null;
const fwStateByTimerId = new Map<number, SimTimerFirmwareState>();
let activeIdentifyFp: string | null = null;
const openSimPorts: Set<SimulatedSerialPort> = (() => {
  if (typeof window !== "undefined") {
    const w = window as SimStoreWindow;
    if (!w.__slaprfOpenSimPorts) {
      w.__slaprfOpenSimPorts = new Set<SimulatedSerialPort>();
    }
    return w.__slaprfOpenSimPorts;
  }
  return new Set<SimulatedSerialPort>();
})();
let activePickerCancel: (() => void) | null = null;

function getBoundStore(): AppStore | null {
  if (boundStore) return boundStore;
  if (typeof window !== "undefined") {
    const w = window as SimStoreWindow;
    if (w.__slaprfSimSerialStore) {
      boundStore = w.__slaprfSimSerialStore;
      return boundStore;
    }
  }
  return null;
}

export function bindSimSerialStore(store: AppStore): void {
  boundStore = store;
  if (typeof window !== "undefined") {
    (window as SimStoreWindow).__slaprfSimSerialStore = store;
  }
}

export interface SimBoardMutationPayload {
  action: "erase" | "flash";
  timerId: number;
  role?: "hub" | "spoke";
  label?: string;
  fingerprint?: string;
  firmwareVersion?: string;
}

let simTimerActionHandler: ((payload: SimBoardMutationPayload) => Promise<void>) | null = null;

function getSimTimerActionHandler(): ((payload: SimBoardMutationPayload) => Promise<void>) | null {
  if (simTimerActionHandler) return simTimerActionHandler;
  if (typeof window !== "undefined") {
    const w = window as SimStoreWindow;
    if (w.__slaprfSimTimerAction) {
      simTimerActionHandler = w.__slaprfSimTimerAction;
      return simTimerActionHandler;
    }
  }
  return null;
}

export function bindSimTimerActionHandler(
  handler: (payload: SimBoardMutationPayload) => Promise<void>
): void {
  simTimerActionHandler = handler;
  if (typeof window !== "undefined") {
    (window as SimStoreWindow).__slaprfSimTimerAction = handler;
  }
}

let forceRealWebSerial = false;

export function enableStandaloneWebSerialMode(): void {
  forceRealWebSerial = true;
}

export function isStandaloneWebSerialMode(): boolean {
  return forceRealWebSerial;
}

export function isSimulatedUsbMode(): boolean {
  if (forceRealWebSerial) return false;
  const store = getBoundStore();
  if (store && (store.simulatorRunning || store.nodes.length > 0 || store.detectedTimers.length > 0)) {
    return Boolean(store.simulatorRunning);
  }
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      const saved = window.localStorage.getItem("slaprf.ui.sim_mode.v1");
      if (saved === "false") return false;
      if (saved === "true") return true;
    } catch {
      // ignore storage errors
    }
  }
  return Boolean(store?.simulatorRunning ?? true);
}

export function isSimulatedSerialPort(port: unknown): port is SimulatedSerialPort {
  return Boolean(port && typeof port === "object" && (port as { isSimulated?: boolean }).isSimulated === true);
}

function xor8(bytes: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < bytes.length; i++) c ^= bytes[i];
  return c;
}

function macForTimer(timerId: number): string {
  const b = (timerId & 0xff).toString(16).toUpperCase().padStart(2, "0");
  return `48:CA:43:51:00:${b}`;
}

export interface BackendSerialPortHandle extends SerialPortLike {
  readonly isBackendPort: true;
  readonly portName: string;
  readonly description?: string;
}

export function isBackendSerialPort(port: unknown): port is BackendSerialPortHandle {
  return Boolean(
    port &&
      typeof port === "object" &&
      (port as { isBackendPort?: boolean }).isBackendPort === true &&
      typeof (port as { portName?: unknown }).portName === "string"
  );
}

/** True when a backend port path is a SlapRF Bluetooth Hub link (`ble:<FINGERPRINT>`). */
export function isBluetoothPortName(name: string | null | undefined): boolean {
  return typeof name === "string" && name.trim().toLowerCase().startsWith("ble:");
}

/** User-facing transport of a connected port: "Bluetooth" for `ble:` hub links, otherwise "USB-C". */
export function portTransportLabel(port: unknown): "Bluetooth" | "USB-C" {
  return isBackendSerialPort(port) && isBluetoothPortName(port.portName) ? "Bluetooth" : "USB-C";
}

export function createBackendPortHandle(portName: string, description?: string): BackendSerialPortHandle {
  return {
    isBackendPort: true,
    portName,
    description,
    readable: null,
    writable: null,
    open: async () => undefined,
    close: async () => undefined,
    setSignals: async () => undefined,
    getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
  };
}

function ensureBackendSimUsbWs(): void {
  // Both Native Go Backend Mode and WASM Demo Mode decode 50 Hz simulated Hub sweeps directly
  // inside Go (`ingestRawHubStream`), avoiding continuous raw serial byte streaming on the UI thread.
}

function ensureSimHubUsbHookInstalled(): void {
  // Handled directly inside Go via `notifySimHubUsbConnected`.
}

function syncDiagStateToWasm(
  timerId: number,
  rfEnabled: boolean,
  emergencyMode: boolean,
  scanLive: boolean,
  chanMask: number
): void {
  if (window.slaprfWasm?.setSimTimerDiagState) {
    window.slaprfWasm.setSimTimerDiagState(timerId, rfEnabled, emergencyMode, scanLive, chanMask);
    return;
  }
  if (capabilitiesSnapshot().portable) {
    void fetch(resolveBackendUrl(`/v1/sim/timers/${encodeURIComponent(String(timerId))}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rfEnabled, emergencyMode, scanLive, chanMask }),
    }).catch(() => undefined);
  }
}

export async function notifySimHubUsbConnected(connected: boolean): Promise<void> {
  if (window.slaprfWasm) {
    window.slaprfWasm.setSimHubUsbConnected?.(connected);
    return;
  }
  if (!capabilitiesSnapshot().portable) return;
  await fetch(resolveBackendUrl("/v1/sim/hub-usb"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connected }),
  }).catch(() => undefined);
}

function flushSimHubHellosToPort(port: SimulatedSerialPort): void {
  const hellos = window.slaprfWasm?.flushSimHubHellos?.();
  if (hellos && hellos.byteLength > 0) {
    port.emitHubStreamBytes(hellos);
    return;
  }
  if (capabilitiesSnapshot().portable && !window.slaprfWasm) {
    void fetch(resolveBackendUrl("/v1/sim/usb-hellos"), { method: "GET" })
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((buf) => {
        if (buf && buf.byteLength > 0) {
          port.emitHubStreamBytes(new Uint8Array(buf));
        }
      })
      .catch(() => undefined);
  }
}

function getOrCreateFwState(timerId: number): SimTimerFirmwareState {
  let st = fwStateByTimerId.get(timerId);
  if (!st) {
    const initialUptimeMs = 185_000 + timerId * 23_000;
    const initialSweeps = Math.floor(initialUptimeMs / 20);
    st = {
      timerId,
      bootEpochMs: Date.now() - initialUptimeMs,
      boots: 1,
      resetReason: "ESP_RST_POWERON",
      emergencyMode: false,
      rfEnabled: true,
      chanMask: 0xff,
      freqsTemporary: false,
      customFreqs: null,
      sweeps: initialSweeps,
      pk: [-89, -89, -89, -89, -89, -89, -89, -89],
      hits: [0, 0, 0, 0, 0, 0, 0, 0],
      aboveThr: [false, false, false, false, false, false, false, false],
      lastSamplePerfMs: performance.now(),
    };
    fwStateByTimerId.set(timerId, st);
  }
  return st;
}

export interface SimTimerDescriptor {
  timerId: number;
  label: string;
  color: string;
  isHub: boolean;
  unflashed: boolean;
  slot: number;
  firmwareVersion: string;
  fingerprint: string;
  poweredOn: boolean;
  online: boolean;
  assignedGateName: string;
  noiseFloorDbm: number;
}

export function listSimulatedTimers(): SimTimerDescriptor[] {
  const store = getBoundStore();
  if (!store || !isSlapRFMode(store.timingHardwareMode)) return [];
  const simTimers: SimTimerState[] = store.simState?.timers ?? [];
  const detected: DetectedTimer[] = store.detectedTimers ?? [];

  if (simTimers.length > 0) {
    return simTimers.map((t) => {
      const unflashed = Boolean(t.unflashed);
      const label = unflashed ? "" : t.timerLabel?.trim() || (t.isHub ? "H1" : `T${Math.max(1, t.timerId - 1)}`);
      const det = detected.find((d) => d.timerId === t.timerId);
      const fp = unflashed ? "" : (t.fingerprint || det?.fingerprint || `53494D0${t.timerId}`).toUpperCase();
      return {
        timerId: t.timerId,
        label,
        color: t.color || det?.color || "#d4ff3a",
        isHub: !unflashed && t.isHub,
        unflashed,
        slot: !unflashed && t.isHub ? 1 : Math.max(2, t.timerId),
        firmwareVersion: unflashed ? "" : t.firmwareVersion || det?.firmwareVersion || LATEST_FIRMWARE_VERSION,
        fingerprint: fp,
        poweredOn: t.poweredOn,
        online: !unflashed && t.online && t.poweredOn,
        assignedGateName: unflashed ? "" : t.assignedGateName || "",
        noiseFloorDbm: t.noiseFloorDbm || det?.noiseFloorDbm || -92,
      };
    });
  }

  return detected.map((d) => {
    const label = d.timerLabel?.trim() || (d.isHub ? "H1" : `T${Math.max(1, d.timerId - 1)}`);
    const node = store.nodes.find((n) => (n.assignedTimerId ?? n.gateId) === d.timerId);
    const assignedGateName = node
      ? `#${node.trackOrder + 1}${node.role === "START_FINISH" ? " (Start)" : ""}`
      : "";
    return {
      timerId: d.timerId,
      label,
      color: d.color || "#d4ff3a",
      isHub: d.isHub,
      unflashed: false,
      slot: d.isHub ? 1 : Math.max(2, d.timerId),
      firmwareVersion: d.firmwareVersion || LATEST_FIRMWARE_VERSION,
      fingerprint: (d.fingerprint || `53494D0${d.timerId}`).toUpperCase(),
      poweredOn: true,
      online: d.online,
      assignedGateName,
      noiseFloorDbm: d.noiseFloorDbm || -92,
    };
  });
}

function savedFrequenciesMHz(): number[] {
  return RACEBAND_DEFAULT.slice();
}

function buildConfigBlockBytes(desc: SimTimerDescriptor, freqs: number[]): Uint8Array {
  const enc = new TextEncoder();
  const block = new Uint8Array(CONFIG_LEN);
  const bv = new DataView(block.buffer);
  block.set(enc.encode(CONFIG_MAGIC), 0);
  const [maj, min, pat] = (desc.firmwareVersion || LATEST_FIRMWARE_VERSION)
    .replace(/^v/, "")
    .split(".")
    .map((n) => Number(n) || 0);
  block[OFF_VERSION] = maj;
  block[OFF_VERSION + 1] = min;
  block[OFF_VERSION + 2] = pat;
  block[OFF_ROLE] = desc.isHub ? 1 : 2;
  block[OFF_RESERVED] = 0;
  block[OFF_WIFI_MODE] = 0;
  bv.setUint32(OFF_FINGERPRINT, parseInt(desc.fingerprint, 16) >>> 0, true);
  for (let i = 0; i < 8; i++) {
    bv.setUint16(OFF_FREQS + i * 2, freqs[i] ?? RACEBAND_DEFAULT[i], true);
  }
  block.set(enc.encode(desc.label.slice(0, 24)), OFF_LABEL);
  block[OFF_CRC] = xor8(block.subarray(0, OFF_CRC));
  return block;
}

/**
 * Computes the live 8-channel 5.8 GHz RSSI (dBm) for a simulated timer `timerId`,
 * pulling directly from the WASM simulator's 50 Hz telemetry stream (`AppStore`).
 */
function sampleTimerChannelDbm(
  desc: SimTimerDescriptor,
  st: SimTimerFirmwareState,
  freqs: number[]
): { dbm: number[]; floor: number[] } {
  const store = getBoundStore();
  const baseFloor = Math.round(desc.noiseFloorDbm || -92);
  const floor = Array.from({ length: 8 }, (_, i) => baseFloor - (i % 2));

  if (!st.rfEnabled || st.emergencyMode) {
    return {
      dbm: [-128, -128, -128, -128, -128, -128, -128, -128],
      floor,
    };
  }

  let rawRssi: number[] | undefined;
  const liveWasmRssi = window.slaprfWasm?.getSimTimerRssi?.(desc.timerId);
  if (Array.isArray(liveWasmRssi) && liveWasmRssi.some((v) => v < 0)) {
    rawRssi = liveWasmRssi;
  }
  if (!rawRssi && store) {
    const node = store.nodes.find((n) => (n.assignedTimerId ?? n.gateId) === desc.timerId);
    if (node) {
      const hist = store.historyFor(node.gateId);
      if (hist.length > 0) {
        rawRssi = hist[hist.length - 1].rssi;
      } else if (Array.isArray(node.lastRssi) && node.lastRssi.some((v) => v < 0)) {
        rawRssi = node.lastRssi;
      }
    }
    if (!rawRssi && store.nodes.length > 0) {
      // Off-track collector Hub sits near the Start/Finish table: derive from 50 Hz Start node stream
      const startNode = store.nodes[0];
      const hist = store.historyFor(startNode.gateId);
      const srcRssi =
        hist.length > 0
          ? hist[hist.length - 1].rssi
          : Array.isArray(startNode.lastRssi) && startNode.lastRssi.some((v) => v < 0)
            ? startNode.lastRssi
            : undefined;
      if (srcRssi) {
        rawRssi = srcRssi.map((v) => Math.max(baseFloor, v - 3.5 + (Math.random() - 0.5) * 1.2));
      }
    }
    if (!rawRssi) {
      const simTimer = store.simState?.timers?.find((t) => t.timerId === desc.timerId);
      if (simTimer && Array.isArray(simTimer.lastRssi) && simTimer.lastRssi.some((v) => v < 0)) {
        rawRssi = simTimer.lastRssi;
      } else {
        const det = store.detectedTimers.find((d) => d.timerId === desc.timerId);
        if (det && Array.isArray(det.lastRssi) && det.lastRssi.some((v) => v < 0)) {
          rawRssi = det.lastRssi;
        }
      }
    }
  }

  const pilots = store?.pilots ?? [];
  const dbm: number[] = [];
  for (let i = 0; i < 8; i++) {
    const chEnabled = ((st.chanMask >> i) & 1) !== 0;
    if (!chEnabled) {
      dbm.push(-128);
      continue;
    }
    const wantFreq = freqs[i] ?? RACEBAND_DEFAULT[i];
    const matchIdx = pilots.findIndex(
      (p) => p.enabled && p.frequencyMhz > 0 && Math.abs(p.frequencyMhz - wantFreq) <= 8
    );
    let val: number;
    if (rawRssi && matchIdx >= 0 && matchIdx < rawRssi.length && rawRssi[matchIdx] < 0) {
      const detLoss = Math.abs(pilots[matchIdx].frequencyMhz - wantFreq) * 1.4;
      val = Math.round(Math.max(floor[i] - 2, rawRssi[matchIdx] - detLoss));
    } else {
      val = Math.round(floor[i] + (Math.random() - 0.5) * 2.4);
    }
    val = Math.max(-120, Math.min(-15, val));
    dbm.push(val);

    // Update peak and hit counter (> floor + 10 dB) since the last LIVE line, matching slaprf_diag.c
    if (val > st.pk[i]) {
      st.pk[i] = val;
    }
    if (val > floor[i] + 10 && st.hits[i] < 255) {
      st.hits[i] = (st.hits[i] ?? 0) + 1;
    }
  }

  return { dbm, floor };
}

/**
 * Generates a realistic 5.8 GHz spectrum scan (`@{"t":"scan",...}`) across `[start..stop]` MHz,
 * combining receiver thermal floor, active simulated pilot VTX envelopes at their real-time RSSI,
 * and subtle 5 GHz Wi-Fi UNII-1 / UNII-3 activity.
 */
function synthesizeSpectrumScan(
  desc: SimTimerDescriptor,
  st: SimTimerFirmwareState,
  startMHz: number,
  stopMHz: number,
  stepMHz: number,
  live = false,
  passMs?: number
): { t: "scan"; live?: boolean; passMs?: number; start: number; stop: number; step: number; dbm: number[] } {
  const baseFloor = desc.noiseFloorDbm || -92;
  const savedFreqs = savedFrequenciesMHz();
  const { dbm: chDbm } = sampleTimerChannelDbm(desc, st, savedFreqs);

  // Intermittent Wi-Fi OFDM activity on Ch 40 (5200 MHz) and Ch 149 (5745 MHz)
  const nowSec = performance.now() / 1000;
  const wifiUnii1Active = Math.sin(nowSec * 1.7) > -0.2;
  const wifiUnii3Active = Math.cos(nowSec * 2.3) > 0.1;

  const out: number[] = [];
  for (let f = startMHz; f <= stopMHz; f += stepMHz) {
    let powerDbm = baseFloor + (Math.random() - 0.5) * 2.6;

    // Active FPV VTX signals (~16 MHz 3dB bandwidth, raised-cosine / Gaussian skirt)
    for (let i = 0; i < 8; i++) {
      const centerFreq = savedFreqs[i] ?? RACEBAND_DEFAULT[i];
      const peakDbm = chDbm[i] ?? baseFloor;
      if (peakDbm <= baseFloor + 3) continue;
      const df = Math.abs(f - centerFreq);
      if (df <= 28) {
        const sigma = 6.8;
        const skirt = Math.exp(-(df * df) / (2 * sigma * sigma));
        const lobeDbm = baseFloor + (peakDbm - baseFloor) * skirt + (Math.random() - 0.5) * 1.2;
        if (lobeDbm > powerDbm) powerDbm = lobeDbm;
      }
    }

    // Subtle 20 MHz 5 GHz Wi-Fi OFDM bursts in UNII-1 (5200 MHz) & UNII-3 (5745 MHz)
    if (wifiUnii1Active && Math.abs(f - 5200) <= 12) {
      const wDbm = -74 + (Math.random() - 0.5) * 4.5;
      if (wDbm > powerDbm) powerDbm = wDbm;
    }
    if (wifiUnii3Active && Math.abs(f - 5745) <= 10) {
      const wDbm = -79 + (Math.random() - 0.5) * 4.0;
      if (wDbm > powerDbm) powerDbm = wDbm;
    }

    out.push(Math.round(Math.max(-110, Math.min(-15, powerDbm))));
  }

  return {
    t: "scan",
    ...(live ? { live: true, passMs: passMs ?? 180 } : {}),
    start: startMHz,
    stop: stopMHz,
    step: stepMHz,
    dbm: out,
  };
}

function buildBootLogText(desc: SimTimerDescriptor, st: SimTimerFirmwareState, freqs: number[]): string {
  const roleStr = desc.isHub ? "HUB (Slot 1 · USB-C Collector & Beacon Master)" : `SPOKE (Slot ${desc.slot} · ESP-NOW Peer)`;
  const mac = macForTimer(desc.timerId);
  return [
    `ESP-ROM:esp32c5-eco1-20250120`,
    `Build:Jan 20 2025`,
    `rst:0x1 (${st.resetReason}),boot:0xc (SPI_FAST_FLASH_BOOT)`,
    `I (24) boot: ESP-IDF v5.5-dev 2nd stage bootloader`,
    `I (25) boot: compile time 14:20:08`,
    `I (31) boot.esp32c5: SPI Flash : 80MHz QIO 4MB`,
    `I (68) cpu_start: Pro cpu up (RISC-V 240 MHz)`,
    `I (94) slaprf_cfg: SLAPRF02 block valid · role=${desc.isHub ? 1 : 2} label="${desc.label}" fp=${desc.fingerprint} fw=${desc.firmwareVersion}`,
    `I (118) slaprf_rf: calibrating 5.8 GHz RSSI ADC & synthesizer (${freqs.join(",")} MHz)...`,
    `I (184) slaprf_rf: receiver ready · noise floor ${(desc.noiseFloorDbm || -92).toFixed(1)} dBm (gain 6/7)`,
    `I (210) slaprf_net: 2.4 GHz ESP-NOW Ch 1 (${mac}) · ${roleStr}`,
    st.emergencyMode
      ? `W (215) slaprf: EMERGENCY MODE ACTIVE (crashStreak=3) · sweeps & radio paused for USB rescue`
      : `I (220) slaprf: 50 Hz sweep loop running (budget 20.0 ms)`,
  ].join("\n");
}

/**
 * Virtual `SerialPortLike` that emulates a Seeed Studio XIAO ESP32-C5 running SlapRF firmware.
 * Driven by the live simulated timers and 50 Hz RSSI stream in `AppStore`.
 */
export class SimulatedSerialPort implements SerialPortLike {
  public readonly isSimulated = true;
  public readonly simulatedTimerId: number;
  public readable: ReadableStream<Uint8Array> | null = null;
  public writable: WritableStream<Uint8Array> | null = null;

  private readController: ReadableStreamDefaultController<Uint8Array> | null = null;
  private isOpen = false;
  private rxLineBuf = "";
  private liveMode: 0 | 1 | 2 = 0;
  private liveTimer = 0;
  private scanLive = false;
  private scanTimer = 0;
  private scanRange = { start: 5180, stop: 5945, step: 5 };
  private logOn = false;
  private logTimer = 0;
  private sweepTickTimer = 0;
  private sweepTickCount = 0;
  private healthWatchTimer = 0;
  private dtr = false;
  private rts = false;
  private slipInFrame = false;
  private slipEscaped = false;
  private slipBuf: number[] = [];
  private flashOffset = 0;
  private flashBlockSize = 1024;
  private flashNumBlocks = 0;
  private flashImageBuf: Uint8Array | null = null;

  constructor(timerId: number) {
    this.simulatedTimerId = timerId;
  }

  public getInfo(): { usbVendorId?: number; usbProductId?: number } {
    return { usbVendorId: 0x303a, usbProductId: 0x1001 };
  }

  private descriptor(): SimTimerDescriptor | null {
    const all = listSimulatedTimers();
    return all.find((t) => t.timerId === this.simulatedTimerId) ?? null;
  }

  public async open(_options: { baudRate: number; bufferSize?: number }): Promise<void> {
    if (this.isOpen) return;
    const desc = this.descriptor();
    if (!desc || !desc.poweredOn) {
      throw new Error(`Simulated board #${this.simulatedTimerId} is powered off.`);
    }

    this.isOpen = true;
    openSimPorts.add(this);
    ensureSimHubUsbHookInstalled();
    const st = getOrCreateFwState(this.simulatedTimerId);
    st.lastSamplePerfMs = performance.now();
    syncDiagStateToWasm(this.simulatedTimerId, st.rfEnabled, st.emergencyMode, this.scanLive, st.chanMask);
    if (desc.isHub && !desc.unflashed && !st.emergencyMode) {
      await notifySimHubUsbConnected(true);
    }

    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.readController = controller;
      },
      cancel: () => {
        this.readController = null;
      },
    });

    const dec = new TextDecoder();
    this.writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (!this.isOpen) return;
        const hasSlip = chunk.includes(0xc0) || this.slipInFrame;
        if (hasSlip) {
          for (let i = 0; i < chunk.length; i++) {
            const b = chunk[i];
            if (b === 0xc0) {
              if (this.slipInFrame && this.slipBuf.length >= 8) {
                const pkt = new Uint8Array(this.slipBuf);
                this.slipBuf = [];
                this.slipInFrame = false;
                this.slipEscaped = false;
                if (pkt[0] === 0x00) {
                  await this.handleRomBootloaderCommand(pkt);
                }
              } else {
                this.slipInFrame = true;
                this.slipEscaped = false;
                this.slipBuf = [];
              }
            } else if (this.slipInFrame) {
              if (this.slipEscaped) {
                this.slipEscaped = false;
                if (b === 0xdc) this.slipBuf.push(0xc0);
                else if (b === 0xdd) this.slipBuf.push(0xdb);
                else this.slipBuf.push(b);
              } else if (b === 0xdb) {
                this.slipEscaped = true;
              } else {
                this.slipBuf.push(b);
              }
            }
          }
          return;
        }
        this.rxLineBuf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = this.rxLineBuf.indexOf("\n")) >= 0) {
          const line = this.rxLineBuf.slice(0, nl).replace(/\r$/, "").trim();
          this.rxLineBuf = this.rxLineBuf.slice(nl + 1);
          if (line) {
            this.handleCommand(line);
          }
        }
      },
    });

    // Advance sweep counter at 50 Hz while open and push status at 1 Hz like real firmware
    this.sweepTickCount = 0;
    this.sweepTickTimer = window.setInterval(() => {
      const d = this.descriptor();
      if (!d || !d.poweredOn || !isSimulatedUsbMode()) {
        void this.close();
        return;
      }
      if (d.unflashed) {
        return;
      }
      ensureSimHubUsbHookInstalled();
      const fw = getOrCreateFwState(this.simulatedTimerId);
      if (!fw.emergencyMode && fw.rfEnabled && !this.scanLive && this.liveMode === 0) {
        fw.sweeps += 5; // 5 sweeps per 100 ms = 50 Hz when liveTimer is not already advancing sweeps
      }
      this.sweepTickCount++;
      const statusDivisor = !this.scanLive && this.liveMode === 0 ? 2 : 10;
      if (this.sweepTickCount % statusDivisor === 0) {
        this.emitStatus();
      }
    }, 100);

    // Emit initial status shortly after port open so `ensureRunningApp()` succeeds immediately,
    // or emit ROM blank-flash boot lines if this board is currently unflashed.
    window.setTimeout(() => {
      if (!this.isOpen) return;
      const d = this.descriptor();
      if (!d || !d.poweredOn) return;
      if (d.unflashed) {
        this.emitUnflashedRomBoot();
        return;
      }
      this.emitStatus();
      const fw = getOrCreateFwState(this.simulatedTimerId);
      if (d.isHub && !fw.emergencyMode) {
        flushSimHubHellosToPort(this);
      }
    }, 25);
  }

  public async close(): Promise<void> {
    if (!this.isOpen) return;
    this.isOpen = false;
    openSimPorts.delete(this);
    ensureBackendSimUsbWs();
    window.clearInterval(this.liveTimer);
    window.clearInterval(this.scanTimer);
    window.clearInterval(this.logTimer);
    window.clearInterval(this.sweepTickTimer);
    window.clearInterval(this.healthWatchTimer);
    this.liveTimer = 0;
    this.scanTimer = 0;
    this.logTimer = 0;
    this.sweepTickTimer = 0;
    this.healthWatchTimer = 0;
    try {
      this.readController?.close();
    } catch {
      // ignore
    }
    this.readController = null;
    this.readable = null;
    this.writable = null;
  }

  public async setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void> {
    const prevRts = this.rts;
    if (signals.dataTerminalReady !== undefined) this.dtr = signals.dataTerminalReady;
    if (signals.requestToSend !== undefined) this.rts = signals.requestToSend;
    // Detect hardware reset pulse (RTS high -> RTS low while DTR is low)
    if (prevRts && !this.rts && !this.dtr) {
      if (this.flashImageBuf) {
        await this.commitPendingFlashImage();
      }
      this.performReboot("ESP_RST_POWERON", false);
    }
  }

  private emitBytes(bytes: Uint8Array): void {
    if (!this.isOpen || !this.readController) return;
    try {
      this.readController.enqueue(bytes);
    } catch {
      // stream closed
    }
  }

  /**
   * Emits raw `0x1E`-prefixed binary Hub packets (`0xC5 0x5A` HELLO and `0xC5 0x60` 4-sample
   * sliding-window recording frames) out of the simulated Hub's USB serial port.
   */
  public emitHubStreamBytes(bytes: Uint8Array): void {
    if (!this.isOpen) return;
    const desc = this.descriptor();
    if (!desc || !desc.isHub || !desc.poweredOn) return;
    const st = getOrCreateFwState(this.simulatedTimerId);
    if (st.emergencyMode) return;
    this.emitBytes(bytes);
  }

  private emitLine(line: string): void {
    const enc = new TextEncoder();
    this.emitBytes(enc.encode(line + "\r\n"));
  }

  private emitJson(obj: unknown): void {
    this.emitLine("@" + JSON.stringify(obj));
  }

  private currentFreqs(st: SimTimerFirmwareState): number[] {
    if (st.freqsTemporary && st.customFreqs && st.customFreqs.length === 8) {
      return st.customFreqs.slice();
    }
    return savedFrequenciesMHz();
  }

  private buildStatusObject(): TimerStatus | null {
    const desc = this.descriptor();
    if (!desc || desc.unflashed) return null;
    const st = getOrCreateFwState(this.simulatedTimerId);
    const freqs = this.currentFreqs(st);
    const { dbm } = sampleTimerChannelDbm(desc, st, freqs);
    const allTimers = listSimulatedTimers();
    const hubDesc = allTimers.find((t) => t.isHub && !t.unflashed);
    const spokesDesc = allTimers.filter((t) => !t.isHub && !t.unflashed && t.poweredOn);

    let spokes: TimerPeerSpoke[] | undefined;
    let hub: TimerStatus["hub"] | undefined;

    if (desc.isHub) {
      const store = getBoundStore();
      spokes = spokesDesc.map((sp) => {
        const spFw = getOrCreateFwState(sp.timerId);
        const spSample = sampleTimerChannelDbm(sp, spFw, freqs);
        const node = store?.nodes.find((n) => (n.assignedTimerId ?? n.gateId) === sp.timerId);
        const det = store?.detectedTimers.find((d) => d.timerId === sp.timerId);
        const frames = Math.max(
          Math.floor(spFw.sweeps / 2),
          node?.framesRxCount ?? 0,
          det?.framesRxCount ?? 0,
          12
        );
        return {
          slot: sp.slot,
          mac: macForTimer(sp.timerId),
          frames,
          msAgo: Math.floor(Math.random() * 18) + 2,
          seq: spFw.sweeps & 0xffff,
          fp: sp.fingerprint,
          label: sp.label,
          fw: sp.firmwareVersion,
          dbm: spSample.dbm,
        };
      });
    } else if (hubDesc && hubDesc.poweredOn) {
      hub = {
        fp: hubDesc.fingerprint,
        label: hubDesc.label,
        fw: hubDesc.firmwareVersion,
        mac: macForTimer(hubDesc.timerId),
        beaconMsAgo: Math.floor(Math.random() * 16) + 2,
        linked: true,
      };
    }

    const activeSweep = !st.emergencyMode && st.rfEnabled && !this.scanLive;
    const sweepUs = activeSweep ? 13400 + Math.round((Math.random() - 0.5) * 420) : 0;
    const heapFree = 241664 + Math.round((Math.random() - 0.5) * 1024);
    const ownFpUpper = desc.fingerprint.toUpperCase();
    const isIdentifyingSelf = activeIdentifyFp !== null && activeIdentifyFp === ownFpUpper;

    return {
      t: "status",
      fw: desc.firmwareVersion,
      role: desc.isHub ? 1 : 2,
      fp: desc.fingerprint,
      label: desc.label,
      uptimeMs: Math.max(50, Date.now() - st.bootEpochMs),
      reset: st.resetReason,
      boots: st.boots,
      crashStreak: st.emergencyMode ? 3 : 0,
      emergencyMode: st.emergencyMode,
      heapFree,
      heapMin: 228352,
      sweepHz: activeSweep ? 50 : 0,
      sweeps: st.sweeps,
      sweepUs,
      sweepUsMax: activeSweep ? 15820 : 0,
      sweepBudgetUs: 20000,
      scanLive: this.scanLive,
      rf: {
        ok: true,
        enabled: st.rfEnabled,
        gain: 6,
        gainMax: 7,
        floorDb: desc.noiseFloorDbm || -92.0,
      },
      chip: {
        model: "ESP32-C5",
        rev: "v1.0",
        mac: macForTimer(desc.timerId),
        flashMB: 4,
      },
      net: {
        mode: "espnow-lr",
        stations: desc.isHub ? spokesDesc.length : hub ? 1 : 0,
      },
      channel: 1,
      slot: desc.isHub ? 1 : hub ? desc.slot : 0,
      framesTx: desc.isHub ? undefined : Math.floor(st.sweeps / 2),
      txFail: 0,
      beaconMsAgo: desc.isHub ? undefined : hub ? hub.beaconMsAgo : undefined,
      hub,
      spokes,
      freqs,
      freqsTemporary: st.freqsTemporary,
      chanMask: st.chanMask,
      dbm,
      identify: isIdentifyingSelf,
      identifyFp: desc.isHub ? activeIdentifyFp ?? "" : undefined,
    };
  }

  private emitStatus(): void {
    const s = this.buildStatusObject();
    if (s) this.emitJson(s);
  }

  private setLiveMode(mode: 0 | 1 | 2): void {
    this.liveMode = mode;
    window.clearInterval(this.liveTimer);
    this.liveTimer = 0;
    if (mode === 0) return;

    const intervalMs = mode === 2 ? 20 : 100;
    this.liveTimer = window.setInterval(() => {
      if (!this.isOpen || this.scanLive) return;
      const desc = this.descriptor();
      if (!desc || !desc.poweredOn) return;
      const st = getOrCreateFwState(this.simulatedTimerId);
      if (st.emergencyMode) return;
      st.sweeps += mode === 2 ? 1 : 5;
      const freqs = this.currentFreqs(st);
      const { dbm, floor } = sampleTimerChannelDbm(desc, st, freqs);
      const pk = dbm.map((v, i) => (v <= -127 ? -127 : Math.max(v, st.pk[i] ?? v)));
      const hits = st.hits.slice();
      st.pk.fill(-127);
      st.hits.fill(0);
      this.emitJson({
        t: "live",
        n: st.sweeps,
        us: st.rfEnabled ? 13400 + Math.round((Math.random() - 0.5) * 400) : 0,
        dbm,
        pk,
        hits,
        floor,
      });
    }, intervalMs);
  }

  private startScanLive(start: number, stop: number, step: number): void {
    this.scanRange = { start, stop, step };
    this.scanLive = true;
    const st = getOrCreateFwState(this.simulatedTimerId);
    syncDiagStateToWasm(this.simulatedTimerId, st.rfEnabled, st.emergencyMode, this.scanLive, st.chanMask);
    window.clearInterval(this.scanTimer);
    const pointCount = Math.max(1, Math.floor((stop - start) / step) + 1);
    const passMs = Math.max(110, Math.round(pointCount * 2.16));
    const emitOnce = () => {
      if (!this.isOpen || !this.scanLive) return;
      const desc = this.descriptor();
      if (!desc) return;
      const fw = getOrCreateFwState(this.simulatedTimerId);
      if (!fw.rfEnabled || fw.emergencyMode) return;
      this.emitJson(
        synthesizeSpectrumScan(desc, fw, this.scanRange.start, this.scanRange.stop, this.scanRange.step, true, passMs)
      );
    };
    window.setTimeout(emitOnce, 40);
    this.scanTimer = window.setInterval(emitOnce, passMs);
  }

  private stopScanLive(): void {
    this.scanLive = false;
    const st = getOrCreateFwState(this.simulatedTimerId);
    syncDiagStateToWasm(this.simulatedTimerId, st.rfEnabled, st.emergencyMode, this.scanLive, st.chanMask);
    window.clearInterval(this.scanTimer);
    this.scanTimer = 0;
  }

  private setLogStreaming(on: boolean): void {
    this.logOn = on;
    window.clearInterval(this.logTimer);
    this.logTimer = 0;
    if (!on) return;
    this.logTimer = window.setInterval(() => {
      if (!this.isOpen || !this.logOn) return;
      const desc = this.descriptor();
      if (!desc) return;
      const st = getOrCreateFwState(this.simulatedTimerId);
      const up = Math.max(100, Date.now() - st.bootEpochMs);
      const freqs = this.currentFreqs(st);
      const { dbm } = sampleTimerChannelDbm(desc, st, freqs);
      const maxDbm = Math.max(...dbm);
      const maxIdx = dbm.indexOf(maxDbm);
      if (maxDbm > -58 && maxIdx >= 0) {
        this.emitLine(
          `I (${up}) slaprf_rf: ch${maxIdx + 1} (${freqs[maxIdx]} MHz) peak ${maxDbm} dBm · sweep #${st.sweeps}`
        );
      } else if (desc.isHub) {
        this.emitLine(
          `I (${up}) slaprf_net: tdma beacon tx seq #${st.sweeps & 0xffff} · heap ${(241664 / 1024).toFixed(0)} KB free`
        );
      } else {
        this.emitLine(
          `I (${up}) slaprf_rf: sweep #${st.sweeps} ok (13.4 ms, floor ${(desc.noiseFloorDbm || -92).toFixed(1)} dBm)`
        );
      }
    }, 950);
  }

  private emitUnflashedRomBoot(): void {
    this.emitLine("ESP-ROM:esp32c5-eco2-20250121");
    this.emitLine("Build:Jan 21 2025");
    this.emitLine("rst:0x1 (POWERON),boot:0xc (SPI_FAST_FLASH_BOOT)");
    this.emitLine("invalid header: 0xffffffff");
  }

  private sendRomAck(op: number): void {
    const ack = new Uint8Array([0xc0, 0x01, op & 0xff, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0]);
    this.emitBytes(ack);
  }

  private async commitPendingFlashImage(): Promise<void> {
    const img = this.flashImageBuf;
    if (!img) return;
    this.flashImageBuf = null;
    this.flashNumBlocks = 0;
    const parsed = parseSlaprfConfigBlock(img);
    const handler = getSimTimerActionHandler();
    if (parsed && handler) {
      const st = getOrCreateFwState(this.simulatedTimerId);
      st.boots = 1;
      st.bootEpochMs = Date.now();
      st.resetReason = "ESP_RST_POWERON";
      st.emergencyMode = false;
      st.rfEnabled = true;
      st.freqsTemporary = false;
      st.customFreqs = null;
      syncDiagStateToWasm(this.simulatedTimerId, st.rfEnabled, st.emergencyMode, false, st.chanMask);
      await handler({
        action: "flash",
        timerId: this.simulatedTimerId,
        role: parsed.role,
        label: parsed.timerLabel,
        fingerprint: parsed.fingerprint,
        firmwareVersion: parsed.firmwareVersion,
      });
      openSimPorts.forEach((p) => {
        if (p !== this) {
          p.emitStatus();
          const d = p.descriptor();
          if (d?.isHub && d.poweredOn) {
            const hellos = window.slaprfWasm?.flushSimHubHellos?.();
            if (hellos && hellos.byteLength > 0) {
              p.emitBytes(hellos);
            }
          }
        }
      });
    }
  }

  private async handleRomBootloaderCommand(pkt: Uint8Array): Promise<void> {
    const op = pkt[1];
    switch (op) {
      case 0x08: // ESP_SYNC
      case 0x09: // ESP_WRITE_REG
      case 0x0d: // ESP_SPI_ATTACH
      case 0x0b: // ESP_SPI_SET_PARAMS
        this.sendRomAck(op);
        return;

      case 0x02: {
        // ESP_FLASH_BEGIN: [size(4), numBlocks(4), blockSize(4), offset(4), encrypted(4)] at byte 8
        if (pkt.length >= 24) {
          const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
          const totalSize = dv.getUint32(8, true);
          const numBlocks = dv.getUint32(12, true);
          const blockSize = dv.getUint32(16, true) || 1024;
          const offset = dv.getUint32(20, true);
          if (numBlocks === 0) {
            // Erase region command from eraseXiaoC5OverWebSerial
            await new Promise<void>((r) => window.setTimeout(r, 85));
            const handler = getSimTimerActionHandler();
            if (offset >= 0x110000 && handler) {
              await handler({
                action: "erase",
                timerId: this.simulatedTimerId,
              });
            }
            this.sendRomAck(op);
            return;
          }
          this.flashOffset = offset;
          this.flashBlockSize = blockSize;
          this.flashNumBlocks = numBlocks;
          this.flashImageBuf = new Uint8Array(offset + Math.max(totalSize, numBlocks * blockSize));
          this.flashImageBuf.fill(0xff);
          await new Promise<void>((r) => window.setTimeout(r, 60));
        }
        this.sendRomAck(op);
        return;
      }

      case 0x03: {
        // ESP_FLASH_DATA: [dataSize(4), seq(4), 0(4), 0(4)] at byte 8, data at byte 24
        if (pkt.length >= 24 && this.flashImageBuf) {
          const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
          const seq = dv.getUint32(12, true);
          const blockData = pkt.subarray(24);
          const dstOff = this.flashOffset + seq * this.flashBlockSize;
          if (dstOff + blockData.length <= this.flashImageBuf.length) {
            this.flashImageBuf.set(blockData, dstOff);
          }
          if (seq % 10 === 0) {
            await new Promise<void>((r) => window.setTimeout(r, 4));
          }
          if (this.flashNumBlocks > 0 && seq + 1 >= this.flashNumBlocks) {
            await this.commitPendingFlashImage();
          }
        }
        this.sendRomAck(op);
        return;
      }

      case 0x04: {
        // ESP_FLASH_END: parse SLAPRF02 block from written image and update simulated board state
        await this.commitPendingFlashImage();
        this.sendRomAck(op);
        return;
      }

      default:
        this.sendRomAck(op);
        return;
    }
  }

  private performReboot(reason: string, enterEmergency?: boolean): void {
    const st = getOrCreateFwState(this.simulatedTimerId);
    this.setLiveMode(0);
    this.stopScanLive();
    st.boots += 1;
    st.bootEpochMs = Date.now();
    st.resetReason = reason;
    st.freqsTemporary = false;
    st.customFreqs = null;
    if (enterEmergency !== undefined) {
      st.emergencyMode = enterEmergency;
    }
    syncDiagStateToWasm(this.simulatedTimerId, st.rfEnabled, st.emergencyMode, this.scanLive, st.chanMask);
    const desc = this.descriptor();
    if (desc?.unflashed) {
      this.emitUnflashedRomBoot();
      return;
    }
    if (desc) {
      for (const line of buildBootLogText(desc, st, this.currentFreqs(st)).split("\n")) {
        this.emitLine(line);
      }
    }
    window.setTimeout(() => {
      if (this.isOpen) {
        this.emitStatus();
        if (desc && desc.isHub && desc.poweredOn && !st.emergencyMode) {
          void notifySimHubUsbConnected(true);
          flushSimHubHellosToPort(this);
        } else if (desc && desc.isHub && st.emergencyMode) {
          void notifySimHubUsbConnected(false);
        }
      }
    }, 60);
  }

  private handleCommand(rawCmd: string): void {
    const desc = this.descriptor();
    if (!desc || !desc.poweredOn || desc.unflashed) return;
    const st = getOrCreateFwState(this.simulatedTimerId);
    const cmd = rawCmd.trim();
    const upper = cmd.toUpperCase();

    if (upper === "STATUS?") {
      this.emitStatus();
      return;
    }

    if (upper === "SLAPRF?") {
      const block = buildConfigBlockBytes(desc, savedFrequenciesMHz());
      const crlf = new Uint8Array([0x0d, 0x0a]);
      const out = new Uint8Array(block.length + crlf.length);
      out.set(block, 0);
      out.set(crlf, block.length);
      this.emitBytes(out);
      return;
    }

    if (upper.startsWith("LIVE")) {
      const arg = Number(upper.slice(4).trim());
      const mode: 0 | 1 | 2 = arg === 2 ? 2 : arg === 1 ? 1 : 0;
      this.setLiveMode(mode);
      this.emitJson({ t: "ok", cmd: "LIVE", mode });
      return;
    }

    if (upper === "SCAN STOP") {
      this.stopScanLive();
      this.emitJson({ t: "ok", cmd: "SCAN STOP" });
      return;
    }

    if (upper.startsWith("SCAN LIVE")) {
      const parts = upper
        .slice(9)
        .trim()
        .split(/\s+/)
        .map(Number);
      const start = parts[0] >= 5180 ? parts[0] : 5180;
      const stop = parts[1] <= 5945 && parts[1] > start ? parts[1] : 5945;
      const step = parts[2] >= 1 ? parts[2] : 5;
      this.startScanLive(start, stop, step);
      this.emitJson({ t: "ok", cmd: "SCAN LIVE", start, stop, step });
      return;
    }

    if (upper.startsWith("SCAN")) {
      const parts = upper
        .slice(4)
        .trim()
        .split(/\s+/)
        .map(Number);
      const start = parts[0] >= 5180 ? parts[0] : 5180;
      const stop = parts[1] <= 5945 && parts[1] > start ? parts[1] : 5945;
      const step = parts[2] >= 1 ? parts[2] : 5;
      window.setTimeout(() => {
        if (!this.isOpen) return;
        const d = this.descriptor();
        if (!d) return;
        this.emitJson(synthesizeSpectrumScan(d, st, start, stop, step));
      }, 90);
      return;
    }

    if (upper.startsWith("RF")) {
      const on = upper.slice(2).trim() !== "0";
      st.rfEnabled = on;
      syncDiagStateToWasm(this.simulatedTimerId, st.rfEnabled, st.emergencyMode, this.scanLive, st.chanMask);
      this.emitJson({ t: "ok", cmd: "RF", enabled: on ? 1 : 0 });
      this.emitStatus();
      return;
    }

    if (upper === "CHANNELS RESET") {
      st.freqsTemporary = false;
      st.customFreqs = null;
      this.emitJson({ t: "ok", cmd: "CHANNELS RESET" });
      this.emitStatus();
      return;
    }

    if (upper.startsWith("CHANNELS MASK")) {
      const maskStr = upper.slice(13).trim();
      const mask = maskStr.startsWith("0X") ? parseInt(maskStr.slice(2), 16) : parseInt(maskStr, 10);
      if (Number.isFinite(mask)) {
        st.chanMask = mask & 0xff;
      }
      syncDiagStateToWasm(this.simulatedTimerId, st.rfEnabled, st.emergencyMode, this.scanLive, st.chanMask);
      this.emitJson({ t: "ok", cmd: "CHANNELS MASK", mask: st.chanMask });
      this.emitStatus();
      return;
    }

    if (upper.startsWith("CHANNELS") || upper.startsWith("NETCHANNELS")) {
      const isNet = upper.startsWith("NETCHANNELS");
      const rest = cmd.slice(isNet ? 11 : 8).trim();
      const rawNums = rest
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((x) => Math.round(Number(x)));
      if (isNet && rawNums.length === 8 && rawNums.every((n) => Number.isFinite(n))) {
        const hasAnyActive = rawNums.some((n) => n >= 5180 && n <= 5945);
        st.customFreqs = hasAnyActive
          ? rawNums.map((n, i) => (n >= 5180 && n <= 5945 ? n : RACEBAND_DEFAULT[i]))
          : null;
        st.freqsTemporary = false;
        this.emitJson({
          t: "ok",
          cmd: "NETCHANNELS",
          freqs: st.customFreqs ?? savedFrequenciesMHz(),
        });
        this.emitStatus();
        return;
      }
      const nums = rawNums.filter((n) => n >= 5180 && n <= 5945);
      if (nums.length === 8) {
        st.customFreqs = nums;
        st.freqsTemporary = !isNet;
        this.emitJson({ t: "ok", cmd: isNet ? "NETCHANNELS" : "CHANNELS", freqs: nums });
        this.emitStatus();
      } else {
        this.emitJson({ t: "err", msg: "expected 8 frequencies in 5180..5945 MHz" });
      }
      return;
    }

    if (upper.startsWith("IDENTIFY")) {
      const tokens = upper.slice(8).trim().split(/\s+/).filter(Boolean);
      let targetFp = desc.fingerprint.toUpperCase();
      let turnOn = true;
      if (tokens.length === 1) {
        turnOn = tokens[0] !== "0" && tokens[0] !== "OFF";
      } else if (tokens.length >= 2) {
        targetFp = tokens[0].toUpperCase();
        turnOn = tokens[1] !== "0" && tokens[1] !== "OFF";
      }
      activeIdentifyFp = turnOn ? targetFp : activeIdentifyFp === targetFp ? null : activeIdentifyFp;
      this.emitJson({
        t: "ok",
        cmd: "IDENTIFY",
        identify: activeIdentifyFp === desc.fingerprint.toUpperCase(),
        identifyFp: activeIdentifyFp ?? "",
      });
      // Notify all open simulated ports so Hub and Spoke stay in sync
      openSimPorts.forEach((p) => p.emitStatus());
      return;
    }

    if (upper.startsWith("LOG")) {
      const on = upper.slice(3).trim() !== "0";
      this.setLogStreaming(on);
      this.emitJson({ t: "ok", cmd: "LOG", enabled: on ? 1 : 0 });
      return;
    }

    if (upper === "BOOTLOG?" || upper === "LASTLOG?") {
      const text = buildBootLogText(desc, st, this.currentFreqs(st));
      this.emitJson({
        t: "bootlog",
        boots: st.boots,
        reset: st.resetReason,
        crashStreak: st.emergencyMode ? 3 : 0,
        emergencyMode: st.emergencyMode,
        bytes: text.length,
        text,
      });
      return;
    }

    if (upper === "BLEPAIR CLEAR") {
      this.emitJson({ t: "ok", cmd: "blepair", pairingMode: true });
      return;
    }

    if (upper === "REBOOT") {
      this.emitJson({ t: "ok", cmd: "REBOOT" });
      window.setTimeout(() => this.performReboot("ESP_RST_SW", false), 50);
      return;
    }

    if (upper === "HELP" || upper === "?") {
      this.emitLine(
        [
          "SlapRF XIAO ESP32-C5 USB Diagnostics Console:",
          "  STATUS?                  Print JSON status (@{\"t\":\"status\",...})",
          "  SLAPRF?                  Dump 160-byte SLAPRF02 flash config block",
          "  LIVE 0|1|2               Stream 5.8 GHz RSSI sweeps (0=off, 1=10Hz, 2=50Hz)",
          "  SCAN <start> <stop> <s>  Single 5.8 GHz spectrum sweep (e.g. SCAN 5180 5917 5)",
          "  SCAN LIVE <a> <b> <s>    Continuous spectrum sweep until SCAN STOP",
          "  RF 0|1                   Enable or disable 5.8 GHz receiver",
          "  CHANNELS <f1..f8>|RESET  Temporarily override or reset 8 channel frequencies",
          "  CHANNELS MASK <0..255>   Enable/disable individual channel slots",
          "  IDENTIFY [fp] 0|1        Strobe timer LED to identify board on course",
          "  BOOTLOG? | LASTLOG?      Read current or previous boot log",
          "  LOG 0|1                  Stream ESP-IDF firmware log lines",
          "  REBOOT                   Software restart",
        ].join("\n")
      );
      this.emitJson({ t: "ok", cmd: "HELP" });
      return;
    }

    this.emitJson({ t: "err", msg: `unknown command: ${cmd}` });
  }
}

interface RealPortMeta {
  label?: string;
  fp?: string;
  role?: "hub" | "spoke";
}

type SimStoreWindow = Window & {
  __slaprfSimSerialStore?: AppStore;
  __slaprfHMR?: { store?: AppStore };
  __slaprfPortMeta?: WeakMap<object, RealPortMeta>;
};

function getPortMetaMap(): WeakMap<object, RealPortMeta> {
  if (typeof window !== "undefined") {
    const w = window as SimStoreWindow;
    if (!w.__slaprfPortMeta) {
      w.__slaprfPortMeta = new WeakMap<object, RealPortMeta>();
    }
    return w.__slaprfPortMeta;
  }
  return new WeakMap<object, RealPortMeta>();
}

export function recordSerialPortMeta(port: SerialPortLike | null | undefined, meta: RealPortMeta): void {
  if (!port || typeof port !== "object" || isSimulatedSerialPort(port)) return;
  const map = getPortMetaMap();
  const prev = map.get(port) ?? {};
  map.set(port, {
    label: meta.label || prev.label,
    fp: meta.fp || prev.fp,
    role: meta.role || prev.role,
  });
}

/**
 * Retained as a clean no-op for backward compatibility; physical USB serial ports are enumerated
 * and managed natively in Go (`go.bug.st/serial`) with zero browser WebSerial pairing state.
 */
export async function forgetAllPairedPorts(): Promise<number> {
  return 0;
}

const unpairedSimTimerIds = new Set<number>();

export function isBleHardwareMode(): boolean {
  return getBoundStore()?.timingHardwareMode === "slaprf_ble";
}

export interface PickUsbPortOptions {
  showAllPorts?: boolean;
  excludePorts?: SerialPortLike[];
  excludeTimerIds?: number[];
  transport?: "usb" | "ble";
  vendor?: "slaprf" | "laprf";
  alreadyPaired?: boolean;
  preferredPortName?: string;
}

interface BackendPortEntry {
  name: string;
  product?: string;
  description?: string;
  isUsb?: boolean;
  isUSB?: boolean;
  vid?: string;
  pid?: string;
  serialNumber?: string;
  isEspressif?: boolean;
}

interface BackendPortsResponse {
  ports?: BackendPortEntry[];
  pool?: {
    slots?: Array<{
      slotIndex: number;
      connected: boolean;
      portName?: string;
      lastStatus?: { label?: string; fp?: string };
      lastConfig?: { timerLabel?: string; fingerprint?: string };
    }>;
  };
}

/**
 * Opens the unified in-app serial port picker modal for both Simulation mode and Real hardware mode
 * (powered natively by Go `/v1/slaprf/usb/ports` in Real mode, with zero browser WebSerial).
 */
export async function pickUsbPort(opts: PickUsbPortOptions = {}): Promise<SerialPortLike> {
  if (activePickerCancel) {
    activePickerCancel();
    activePickerCancel = null;
  }
  document.querySelectorAll(".confirm-modal-backdrop").forEach((el) => el.remove());

  const simMode = isSimulatedUsbMode();
  const boundStore = getBoundStore();
  const isBleMode = opts.transport
    ? opts.transport === "ble"
    : boundStore?.timingHardwareMode === "slaprf_ble";
  const showAllRealPorts = isBleMode ? false : Boolean(opts.showAllPorts);
  const excludeTimerIds = new Set<number>(opts.excludeTimerIds ?? []);
  const excludePortNames = new Set<string>();
  for (const p of opts.excludePorts ?? []) {
    if (isSimulatedSerialPort(p)) {
      excludeTimerIds.add(p.simulatedTimerId);
    } else if (isBackendSerialPort(p)) {
      excludePortNames.add(p.portName.toUpperCase());
    }
  }

  interface PortChoice {
    id: string;
    label: string;
    createPort: () => SerialPortLike;
    simTimerId?: number;
  }

  let choices: PortChoice[] = [];

  const loadChoices = async (): Promise<PortChoice[]> => {
    if (simMode) {
      const timers = listSimulatedTimers().filter(
        (t) => t.poweredOn && !excludeTimerIds.has(t.timerId) && !unpairedSimTimerIds.has(t.timerId)
      );
      return timers.map((t) => ({
        id: `sim-${t.timerId}`,
        label: isBleMode
          ? `SlapRF Bluetooth Hub (${t.fingerprint || "SIM"}) · ${t.label || "H1"}`
          : t.unflashed
            ? `USB JTAG/serial debug unit (Board #${t.timerId}) · Unflashed`
            : `USB JTAG/serial debug unit (${t.fingerprint}) · ${t.label}`,
        createPort: () => new SimulatedSerialPort(t.timerId),
        simTimerId: t.timerId,
      }));
    }

    if (!capabilitiesSnapshot().portable) {
      return [];
    }

    try {
      const endpoint =
        opts.vendor === "laprf"
          ? `/v1/laprf/usb/ports?all=${showAllRealPorts ? "1" : "0"}`
          : isBleMode
            ? "/v1/slaprf/bluetooth/ports"
            : `/v1/slaprf/usb/ports?all=${showAllRealPorts ? "1" : "0"}`;
      const res = await fetch(resolveBackendUrl(endpoint), { cache: "no-store" });
      if (!res.ok) return [];
      const data = (await res.json()) as BackendPortsResponse;
      const ports = Array.isArray(data.ports) ? data.ports : [];
      const poolSlots = Array.isArray(data.pool?.slots) ? data.pool!.slots! : [];
      return ports
        .filter((p) => p.name && !excludePortNames.has(p.name.toUpperCase()))
        .map((p) => {
          const activeSlot = poolSlots.find(
            (s) => s.connected && s.portName && s.portName.toUpperCase() === p.name.toUpperCase()
          );
          const knownLabel = activeSlot?.lastStatus?.label || activeSlot?.lastConfig?.timerLabel || "";
          const knownFp = activeSlot?.lastStatus?.fp || activeSlot?.lastConfig?.fingerprint || "";
          const rawProd = p.product || p.description || "";
          const isBlePort = p.name.trim().toLowerCase().startsWith("ble:");
          const desc = isBlePort
            ? rawProd || "SlapRF Hub (Bluetooth)"
            : p.isEspressif
              ? rawProd && !/^usb serial device/i.test(rawProd)
                ? rawProd
                : "Seeed XIAO ESP32-C5 (USB JTAG/serial)"
              : rawProd || "USB Serial Port";
          const vidPid = p.vid && p.pid ? ` (${p.vid}:${p.pid})` : "";
          const identitySuffix = !isBlePort && (knownLabel || knownFp)
            ? ` · ${[knownFp ? `(${knownFp})` : "", knownLabel].filter(Boolean).join(" ")}`
            : "";
          return {
            id: `backend-${p.name}`,
            label: `${p.name} · ${desc}${vidPid}${identitySuffix}`,
            createPort: () => createBackendPortHandle(p.name, desc),
          };
        });
    } catch {
      return [];
    }
  };

  const preferredId = opts.preferredPortName ? `backend-${opts.preferredPortName}` : null;
  let scanning = !simMode;
  if (simMode) {
    choices = await loadChoices();
  }

  return new Promise<SerialPortLike>((resolve, reject) => {
    const pickInitialId = (list: PortChoice[]): string | null => {
      if (preferredId) {
        const pref = list.find((c) => c.id.toLowerCase() === preferredId.toLowerCase());
        if (pref) return pref.id;
      }
      return list[0]?.id ?? null;
    };

    let selectedId: string | null = pickInitialId(choices);
    let closed = false;

    const backdrop = document.createElement("div");
    backdrop.className = "slaprf-modal-backdrop confirm-modal-backdrop";

    const renderRowsHtml = (): string => {
      if (scanning && choices.length === 0) {
        return `<div class="sim-usb-port-empty sim-usb-port-scanning">
          <span>${isBleMode ? "Scanning for Bluetooth Hubs…" : "Scanning serial ports…"}</span>
          <div class="slaprf-indeterminate-track" role="progressbar" aria-label="Scanning">
            <div class="slaprf-indeterminate-bar"></div>
          </div>
        </div>`;
      }
      if (choices.length === 0) {
        return `<div class="sim-usb-port-empty">${
          simMode
            ? "No powered simulated timers available"
            : isBleMode
              ? "No SlapRF Bluetooth Hub found nearby. Make sure the Hub is powered on and not connected to another device (hold BOOT on the Hub for 3 s to enter pairing mode)."
              : showAllRealPorts
                ? "No USB serial ports detected on the SlapRF server"
                : "No Seeed Studio XIAO ESP32-C5 USB ports detected - plug in USB-C and click Refresh"
        }</div>`;
      }
      return choices
        .map((c) => {
          const isSel = c.id === selectedId;
          const canForget = simMode && c.simTimerId !== undefined;
          const deleteBtn = canForget
            ? `<button
                type="button"
                class="sim-usb-port-delete"
                data-unpair-port-id="${esc(c.id)}"
                title="Hide device"
                aria-label="Hide ${esc(c.label)}"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
                  <path d="M10 11v6"></path>
                  <path d="M14 11v6"></path>
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
                </svg>
              </button>`
            : "";
          return `
            <div
              role="option"
              tabindex="0"
              aria-selected="${isSel ? "true" : "false"}"
              class="sim-usb-port-row ${isSel ? "is-selected" : ""}"
              data-pick-port-id="${esc(c.id)}"
            >
              <span class="sim-usb-port-label">${esc(c.label)}</span>
              ${deleteBtn}
            </div>`;
        })
        .join("");
    };

    const moreBtnLabel = () =>
      simMode ? "More devices…" : scanning ? "Scanning…" : isBleMode ? "Scan again" : "Refresh";
    const modalTitle = isBleMode
      ? opts.alreadyPaired
        ? "Connect Bluetooth Device"
        : "Pair Bluetooth Device"
      : "Select a serial port";
    const confirmBtnText = isBleMode && !opts.alreadyPaired ? "Pair" : "Connect";
    const listAriaLabel = isBleMode ? "Available Bluetooth Hubs" : "Available serial ports";

    backdrop.innerHTML = `
      <div class="slaprf-modal card sim-usb-dialog" role="dialog" aria-modal="true" aria-labelledby="sim-usb-picker-title">
        <div class="slaprf-modal-head">
          <div class="slaprf-modal-title-row">
            <span class="slaprf-modal-icon">${isBleMode ? icons.wifi(17) : icons.plug(17)}</span>
            <h3 id="sim-usb-picker-title">${esc(modalTitle)}</h3>
          </div>
          <button type="button" class="btn btn-ghost btn-xs" data-modal="cancel" aria-label="Close">
            ${icons.close(15)}
          </button>
        </div>
        <div class="slaprf-modal-body">
          <div class="sim-usb-port-list" role="listbox" aria-label="${esc(listAriaLabel)}">
            ${renderRowsHtml()}
          </div>
        </div>
        <div class="slaprf-modal-foot">
          <button type="button" class="btn btn-ghost" data-modal="request-native" ${scanning ? "disabled" : ""} style="margin-right:auto">${simMode ? icons.plus(15) : icons.reset(15)}<span data-role="more-ports-label">${esc(moreBtnLabel())}</span></button>
          <button type="button" class="btn btn-ghost" data-modal="cancel">Cancel</button>
          <button type="button" class="btn btn-armed" data-modal="connect" ${selectedId === null || scanning ? "disabled" : ""}>
            ${icons.plug(15)}
            <span>${esc(confirmBtnText)}</span>
          </button>
        </div>
      </div>`;

    const listEl = backdrop.querySelector<HTMLElement>(".sim-usb-port-list");
    const connectBtn = backdrop.querySelector<HTMLButtonElement>('[data-modal="connect"]');
    const moreBtn = backdrop.querySelector<HTMLButtonElement>('[data-modal="request-native"]');
    const moreLabelEl = backdrop.querySelector<HTMLElement>('[data-role="more-ports-label"]');

    const syncButtons = () => {
      if (connectBtn) connectBtn.disabled = selectedId === null || scanning;
      if (moreBtn) moreBtn.disabled = scanning;
      if (moreLabelEl) moreLabelEl.textContent = moreBtnLabel();
    };

    const refreshListDom = () => {
      if (closed || !listEl) return;
      if (selectedId === null || !choices.some((c) => c.id === selectedId)) {
        selectedId = pickInitialId(choices);
      }
      listEl.innerHTML = renderRowsHtml();
      syncButtons();
    };

    const runAsyncScan = () => {
      scanning = true;
      refreshListDom();
      void loadChoices()
        .then((next) => {
          if (closed) return;
          choices = next;
        })
        .finally(() => {
          if (closed) return;
          scanning = false;
          refreshListDom();
        });
    };

    const updateSelection = (id: string) => {
      selectedId = id;
      backdrop.querySelectorAll<HTMLElement>("[data-pick-port-id]").forEach((el) => {
        const active = el.dataset.pickPortId === id;
        el.classList.toggle("is-selected", active);
        el.setAttribute("aria-selected", active ? "true" : "false");
      });
      syncButtons();
    };

    const cleanup = () => {
      closed = true;
      if (activePickerCancel === cancel) {
        activePickerCancel = null;
      }
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
    };

    const cancel = () => {
      cleanup();
      reject(new Error("No port selected"));
    };
    activePickerCancel = cancel;

    const confirmSelection = () => {
      const chosen = choices.find((c) => c.id === selectedId);
      if (!chosen) return;
      cleanup();
      resolve(chosen.createPort());
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        cancel();
      } else if (ev.key === "Enter" && selectedId !== null) {
        ev.preventDefault();
        confirmSelection();
      }
    };

    backdrop.addEventListener("click", (ev) => {
      const target = ev.target as HTMLElement;
      if (target === backdrop || target.closest('[data-modal="cancel"]')) {
        cancel();
        return;
      }
      if (target.closest('[data-modal="connect"]')) {
        confirmSelection();
        return;
      }
      const unpairBtnEl = target.closest<HTMLButtonElement>("[data-unpair-port-id]");
      if (unpairBtnEl && unpairBtnEl.dataset.unpairPortId) {
        ev.stopPropagation();
        const targetId = unpairBtnEl.dataset.unpairPortId;
        const chosen = choices.find((c) => c.id === targetId);
        if (simMode && chosen?.simTimerId !== undefined) {
          unpairedSimTimerIds.add(chosen.simTimerId);
          void loadChoices().then((next) => {
            if (closed) return;
            choices = next;
            refreshListDom();
          });
        }
        return;
      }
      if (target.closest('[data-modal="request-native"]')) {
        if (scanning) return;
        if (simMode) {
          unpairedSimTimerIds.clear();
          void loadChoices().then((next) => {
            if (closed) return;
            choices = next;
            refreshListDom();
          });
        } else {
          runAsyncScan();
        }
        return;
      }
      const row = target.closest<HTMLElement>("[data-pick-port-id]");
      if (row && row.dataset.pickPortId) {
        updateSelection(row.dataset.pickPortId);
      }
    });

    backdrop.addEventListener("dblclick", (ev) => {
      const target = ev.target as HTMLElement;
      if (target.closest("[data-unpair-port-id]")) return;
      const row = target.closest<HTMLElement>("[data-pick-port-id]");
      if (row && row.dataset.pickPortId) {
        updateSelection(row.dataset.pickPortId);
        confirmSelection();
      }
    });

    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(backdrop);
    syncButtons();
    if (!simMode) {
      runAsyncScan();
    }
  });
}

export function pickSimulatedUsbPort(excludeTimerIds: number[] = []): Promise<SimulatedSerialPort> {
  return pickUsbPort({ excludeTimerIds }) as Promise<SimulatedSerialPort>;
}
