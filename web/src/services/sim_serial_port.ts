import { esc } from "../core/format";
import { icons } from "../core/icons";
import { AppStore } from "../state/store";
import { DetectedTimer, SimTimerState } from "../types/models";
import { LATEST_FIRMWARE_VERSION } from "./esp_flasher";
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

let boundStore: AppStore | null = null;
const fwStateByTimerId = new Map<number, SimTimerFirmwareState>();
let activeIdentifyFp: string | null = null;
const openSimPorts = new Set<SimulatedSerialPort>();

export function bindSimSerialStore(store: AppStore): void {
  boundStore = store;
}

export function isSimulatedUsbMode(): boolean {
  return Boolean(boundStore?.simulatorRunning);
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
  slot: number;
  firmwareVersion: string;
  fingerprint: string;
  poweredOn: boolean;
  online: boolean;
  assignedGateName: string;
  noiseFloorDbm: number;
}

export function listSimulatedTimers(): SimTimerDescriptor[] {
  const store = boundStore;
  if (!store) return [];
  const simTimers: SimTimerState[] = store.simState?.timers ?? [];
  const detected: DetectedTimer[] = store.detectedTimers ?? [];

  if (simTimers.length > 0) {
    return simTimers.map((t) => {
      const label = t.timerLabel?.trim() || (t.isHub ? "H1" : `T${Math.max(1, t.timerId - 1)}`);
      const det = detected.find((d) => d.timerId === t.timerId);
      const fp = (t.fingerprint || det?.fingerprint || `53494D0${t.timerId}`).toUpperCase();
      return {
        timerId: t.timerId,
        label,
        color: t.color || det?.color || "#d4ff3a",
        isHub: t.isHub,
        slot: t.isHub ? 1 : Math.max(2, t.timerId),
        firmwareVersion: t.firmwareVersion || det?.firmwareVersion || LATEST_FIRMWARE_VERSION,
        fingerprint: fp,
        poweredOn: t.poweredOn,
        online: t.online && t.poweredOn,
        assignedGateName: t.assignedGateName || "",
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
      slot: d.isHub ? 1 : Math.max(2, d.timerId),
      firmwareVersion: d.firmwareVersion || LATEST_FIRMWARE_VERSION,
      fingerprint: (d.fingerprint || `53494D0${d.timerId}`).toUpperCase(),
      poweredOn: d.online,
      online: d.online,
      assignedGateName,
      noiseFloorDbm: d.noiseFloorDbm || -92,
    };
  });
}

function savedFrequenciesMHz(): number[] {
  const pilots = boundStore?.pilots ?? [];
  return RACEBAND_DEFAULT.map((def, i) => {
    const f = pilots[i]?.frequencyMhz ?? def;
    return f >= 5180 && f <= 5917 ? f : def;
  });
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
  const store = boundStore;
  const baseFloor = Math.round(desc.noiseFloorDbm || -92);
  const floor = Array.from({ length: 8 }, (_, i) => baseFloor - (i % 2));

  if (!st.rfEnabled || st.emergencyMode) {
    return {
      dbm: [-128, -128, -128, -128, -128, -128, -128, -128],
      floor,
    };
  }

  let rawRssi: number[] | undefined;
  if (store) {
    const node = store.nodes.find((n) => (n.assignedTimerId ?? n.gateId) === desc.timerId);
    if (node) {
      const hist = store.historyFor(node.gateId);
      if (hist.length > 0) {
        rawRssi = hist[hist.length - 1].rssi;
      } else if (Array.isArray(node.lastRssi) && node.lastRssi.length >= 8) {
        rawRssi = node.lastRssi;
      }
    }
    if (!rawRssi) {
      const det = store.detectedTimers.find((d) => d.timerId === desc.timerId);
      if (det && Array.isArray(det.lastRssi) && det.lastRssi.some((v) => v < 0)) {
        rawRssi = det.lastRssi;
      } else if (store.nodes.length > 0) {
        // Off-track collector Hub sits near the Start/Finish table: derive from Start node with slight attenuation
        const startNode = store.nodes[0];
        const hist = store.historyFor(startNode.gateId);
        if (hist.length > 0) {
          rawRssi = hist[hist.length - 1].rssi.map((v) => Math.max(baseFloor, v - 3.5 + (Math.random() - 0.5) * 1.6));
        }
      }
    }
  }

  const savedFreqs = savedFrequenciesMHz();
  const dbm: number[] = [];
  for (let i = 0; i < 8; i++) {
    const chEnabled = ((st.chanMask >> i) & 1) !== 0;
    if (!chEnabled) {
      dbm.push(-128);
      continue;
    }
    const wantFreq = freqs[i] ?? RACEBAND_DEFAULT[i];
    const matchIdx = savedFreqs.findIndex((sf) => Math.abs(sf - wantFreq) <= 8);
    let val: number;
    if (rawRssi && matchIdx >= 0 && matchIdx < rawRssi.length && rawRssi[matchIdx] < 0) {
      const detLoss = Math.abs(savedFreqs[matchIdx] - wantFreq) * 1.4;
      val = Math.round(Math.max(floor[i] - 2, rawRssi[matchIdx] - detLoss));
    } else {
      val = Math.round(floor[i] + (Math.random() - 0.5) * 2.4);
    }
    val = Math.max(-120, Math.min(-15, val));
    dbm.push(val);

    // Update peak and threshold crossing counter for LIVE stream
    if (val > st.pk[i]) {
      st.pk[i] = val;
    } else {
      st.pk[i] = Math.max(val, Math.round(st.pk[i] - 0.25));
    }
    const pilotThr = store?.pilots[i]?.enterThresholdDbm ?? -58;
    const exitThr = store?.pilots[i]?.exitThresholdDbm ?? pilotThr - 8;
    if (!st.aboveThr[i] && val >= pilotThr) {
      st.aboveThr[i] = true;
      st.hits[i] = (st.hits[i] ?? 0) + 1;
    } else if (st.aboveThr[i] && val <= exitThr) {
      st.aboveThr[i] = false;
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
  stepMHz: number
): { t: "scan"; start: number; stop: number; step: number; dbm: number[] } {
  const baseFloor = desc.noiseFloorDbm || -92;
  const savedFreqs = savedFrequenciesMHz();
  const { dbm: chDbm } = sampleTimerChannelDbm(desc, st, savedFreqs);
  const store = boundStore;
  const pilots = store?.pilots ?? [];

  // Intermittent Wi-Fi OFDM activity on Ch 40 (5200 MHz) and Ch 149 (5745 MHz)
  const nowSec = performance.now() / 1000;
  const wifiUnii1Active = Math.sin(nowSec * 1.7) > -0.2;
  const wifiUnii3Active = Math.cos(nowSec * 2.3) > 0.1;

  const out: number[] = [];
  for (let f = startMHz; f <= stopMHz; f += stepMHz) {
    let powerDbm = baseFloor + (Math.random() - 0.5) * 2.6;

    // Active FPV VTX signals (~16 MHz 3dB bandwidth, raised-cosine / Gaussian skirt)
    for (let i = 0; i < 8; i++) {
      const p = pilots[i];
      if (p && !p.enabled) continue;
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
  private scanRange = { start: 5180, stop: 5917, step: 5 };
  private logOn = false;
  private logTimer = 0;
  private sweepTickTimer = 0;
  private sweepTickCount = 0;
  private healthWatchTimer = 0;
  private dtr = false;
  private rts = false;

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
      throw new Error(`Simulated timer T${this.simulatedTimerId} is powered off.`);
    }

    this.isOpen = true;
    openSimPorts.add(this);
    const st = getOrCreateFwState(this.simulatedTimerId);
    st.lastSamplePerfMs = performance.now();

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
      write: (chunk) => {
        if (!this.isOpen) return;
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
      const fw = getOrCreateFwState(this.simulatedTimerId);
      if (!fw.emergencyMode && fw.rfEnabled && !this.scanLive) {
        fw.sweeps += 5; // 5 sweeps per 100 ms = 50 Hz
      }
      this.sweepTickCount++;
      if (this.sweepTickCount % 10 === 0) {
        this.emitStatus();
      }
    }, 100);

    // Emit initial status shortly after port open so `ensureRunningApp()` succeeds immediately
    window.setTimeout(() => {
      if (this.isOpen) {
        this.emitStatus();
      }
    }, 25);
  }

  public async close(): Promise<void> {
    if (!this.isOpen) return;
    this.isOpen = false;
    openSimPorts.delete(this);
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
    if (!desc) return null;
    const st = getOrCreateFwState(this.simulatedTimerId);
    const freqs = this.currentFreqs(st);
    const { dbm } = sampleTimerChannelDbm(desc, st, freqs);
    const allTimers = listSimulatedTimers();
    const hubDesc = allTimers.find((t) => t.isHub);
    const spokesDesc = allTimers.filter((t) => !t.isHub && t.poweredOn);

    let spokes: TimerPeerSpoke[] | undefined;
    let hub: TimerStatus["hub"] | undefined;

    if (desc.isHub) {
      spokes = spokesDesc.map((sp) => {
        const spFw = getOrCreateFwState(sp.timerId);
        const spSample = sampleTimerChannelDbm(sp, spFw, freqs);
        const node = boundStore?.nodes.find((n) => (n.assignedTimerId ?? n.gateId) === sp.timerId);
        const det = boundStore?.detectedTimers.find((d) => d.timerId === sp.timerId);
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
      this.emitJson({
        t: "live",
        n: st.sweeps,
        us: st.rfEnabled ? 13400 + Math.round((Math.random() - 0.5) * 400) : 0,
        dbm,
        pk: st.pk.slice(),
        hits: st.hits.slice(),
        floor,
      });
    }, intervalMs);
  }

  private startScanLive(start: number, stop: number, step: number): void {
    this.scanRange = { start, stop, step };
    this.scanLive = true;
    window.clearInterval(this.scanTimer);
    const emitOnce = () => {
      if (!this.isOpen || !this.scanLive) return;
      const desc = this.descriptor();
      if (!desc) return;
      const st = getOrCreateFwState(this.simulatedTimerId);
      if (!st.rfEnabled || st.emergencyMode) return;
      this.emitJson(synthesizeSpectrumScan(desc, st, this.scanRange.start, this.scanRange.stop, this.scanRange.step));
    };
    window.setTimeout(emitOnce, 40);
    this.scanTimer = window.setInterval(emitOnce, 180);
  }

  private stopScanLive(): void {
    this.scanLive = false;
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
    const desc = this.descriptor();
    if (desc) {
      for (const line of buildBootLogText(desc, st, this.currentFreqs(st)).split("\n")) {
        this.emitLine(line);
      }
    }
    window.setTimeout(() => {
      if (this.isOpen) this.emitStatus();
    }, 60);
  }

  private handleCommand(rawCmd: string): void {
    const desc = this.descriptor();
    if (!desc || !desc.poweredOn) return;
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
      const stop = parts[1] <= 5925 && parts[1] > start ? parts[1] : 5917;
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
      const stop = parts[1] <= 5925 && parts[1] > start ? parts[1] : 5917;
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
      this.emitJson({ t: "ok", cmd: "CHANNELS MASK", mask: st.chanMask });
      this.emitStatus();
      return;
    }

    if (upper.startsWith("CHANNELS") || upper.startsWith("NETCHANNELS")) {
      const isNet = upper.startsWith("NETCHANNELS");
      const rest = cmd.slice(isNet ? 11 : 8).trim();
      const nums = rest
        .split(/[\s,]+/)
        .map((x) => Math.round(Number(x)))
        .filter((n) => n >= 5180 && n <= 5917);
      if (nums.length === 8) {
        st.customFreqs = nums;
        st.freqsTemporary = !isNet;
        this.emitJson({ t: "ok", cmd: isNet ? "NETCHANNELS" : "CHANNELS", freqs: nums });
        this.emitStatus();
      } else {
        this.emitJson({ t: "err", msg: "expected 8 frequencies in 5180..5917 MHz" });
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

    if (upper === "REBOOT") {
      this.emitJson({ t: "ok", cmd: "REBOOT" });
      window.setTimeout(() => this.performReboot("ESP_RST_SW", false), 50);
      return;
    }

    if (upper.startsWith("EMERGENCY")) {
      const arg = upper.slice(9).trim();
      const nextEm = arg === "0" ? false : arg === "1" ? true : !st.emergencyMode;
      this.emitJson({ t: "ok", cmd: "EMERGENCY", emergencyMode: nextEm });
      window.setTimeout(() => this.performReboot("ESP_RST_SW", nextEm), 50);
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
          "  EMERGENCY 0|1            Toggle emergency rescue mode",
          "  REBOOT                   Software restart",
        ].join("\n")
      );
      this.emitJson({ t: "ok", cmd: "HELP" });
      return;
    }

    this.emitJson({ t: "err", msg: `unknown command: ${cmd}` });
  }
}

/**
 * Opens an in-app modal picker allowing the user to choose which simulated USB timer
 * (`H1`, `T1`, `T2`, `T3`, …) to connect over virtual USB-C in simulation mode.
 */
export function pickSimulatedUsbPort(excludeTimerIds: number[] = []): Promise<SimulatedSerialPort> {
  return new Promise<SimulatedSerialPort>((resolve, reject) => {
    const timers = listSimulatedTimers();
    const backdrop = document.createElement("div");
    backdrop.className = "confirm-modal-backdrop";

    const rowsHtml = timers
      .map((t) => {
        const alreadyUsed = excludeTimerIds.includes(t.timerId);
        const disabled = !t.poweredOn || alreadyUsed;
        const roleTag = t.isHub ? "Hub · Slot 1" : `Spoke · Slot ${t.slot}`;
        const trackInfo = t.assignedGateName ? `Track ${esc(t.assignedGateName)}` : "Off track";
        const rightBadge = alreadyUsed
          ? `<span class="badge">Connected</span>`
          : !t.poweredOn
            ? `<span class="badge tone-warn">Powered off</span>`
            : `<span class="btn btn-sm btn-armed" style="pointer-events:none">${icons.plug(13)}<span>Connect</span></span>`;

        return `
          <button
            type="button"
            class="sim-usb-picker-item ${disabled ? "is-disabled" : ""}"
            data-pick-sim-timer="${t.timerId}"
            ${disabled ? "disabled" : ""}
            style="display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-elev);color:var(--text);text-align:left;cursor:${disabled ? "not-allowed" : "pointer"};opacity:${disabled ? "0.55" : "1"};transition:border-color 0.15s,background 0.15s"
          >
            <div style="display:flex;align-items:center;gap:10px;min-width:0">
              <span class="gate-color-swatch" style="--c:${esc(t.color)};cursor:default;flex-shrink:0"></span>
              <div style="display:flex;flex-direction:column;gap:2px;min-width:0">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                  <strong class="mono" style="font-size:14px">${esc(t.label)}</strong>
                  <span class="detected-role-pill">${esc(roleTag)}</span>
                  <span class="badge mono">${esc(t.fingerprint)}</span>
                </div>
                <span class="note" style="font-size:12px">${esc(trackInfo)} · Firmware ${esc(t.firmwareVersion)}</span>
              </div>
            </div>
            <div style="flex-shrink:0">${rightBadge}</div>
          </button>`;
      })
      .join("");

    backdrop.innerHTML = `
      <div class="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="sim-usb-picker-title" style="max-width:480px;width:92vw">
        <div class="confirm-modal-head">
          <span class="confirm-modal-icon">${icons.plug(18)}</span>
          <h3 id="sim-usb-picker-title">Connect simulated USB timer</h3>
        </div>
        <p class="confirm-modal-body" style="margin-bottom:12px">
          Select a simulated XIAO ESP32-C5 timer to connect over virtual USB-C. You can power timers on or off in the Simulator tab.
        </p>
        <div style="display:flex;flex-direction:column;gap:8px;max-height:320px;overflow-y:auto;margin-bottom:16px">
          ${rowsHtml || `<div class="empty-note">No simulated timers available. Add or reset timers in the Simulator tab.</div>`}
        </div>
        <div class="confirm-modal-actions">
          <button type="button" class="btn btn-ghost" data-modal="cancel">Cancel</button>
        </div>
      </div>`;

    const cleanup = () => {
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
    };

    const cancel = () => {
      cleanup();
      reject(new Error("No port selected"));
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        cancel();
      }
    };

    backdrop.addEventListener("click", (ev) => {
      const target = ev.target as HTMLElement;
      if (target === backdrop || target.closest('[data-modal="cancel"]')) {
        cancel();
        return;
      }
      const btn = target.closest<HTMLButtonElement>("[data-pick-sim-timer]");
      if (btn && !btn.disabled) {
        const timerId = Number(btn.dataset.pickSimTimer);
        cleanup();
        resolve(new SimulatedSerialPort(timerId));
      }
    });

    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(backdrop);
  });
}
