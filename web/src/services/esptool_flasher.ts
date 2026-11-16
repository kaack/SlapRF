/**
 * Stateless XIAO ESP32-C5 flasher built on Espressif's official esptool-js (vendored, Apache-2.0),
 * the same library used by the ESP Web Tools / ExpressLRS / Widscan58 web flashers.
 *
 * Every action (read, flash, erase) is one-shot: pick the board's WebSerial port, do the job, read the
 * board back once to verify it, and close the port. The Flasher page never keeps a connection open;
 * live timer connections belong to the SlapRF Server (Network and Debug pages).
 *
 * The browser talks to the board over WebSerial, so this behaves the same on Windows, macOS, Linux,
 * and ChromeOS, with or without a local SlapRF Server.
 */
import { ESPLoader, Transport } from "../vendor/esptool-js/esptool.js";
import { capabilitiesSnapshot } from "./capabilities";
import {
  FlashProgress,
  ProgressCallback,
  TimerReadout,
  buildOrPatchFirmwareBin,
  generateFingerprint,
  parseSlaprfConfigBlock,
  parseStatusSnapshot,
  registerFlashCanceler,
  withFingerprint,
} from "./esp_flasher";
import { createBackendPortHandle, isBackendSerialPort, isSimulatedUsbMode } from "./sim_serial_port";
import { usbPool } from "./timer_console";

const ESPRESSIF_USB_VID = 0x303a;
const ESP_IMAGE_MAGIC = 0xe9;

interface WebSerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

export interface WebSerialPort {
  getInfo(): WebSerialPortInfo;
  open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}

interface WebSerialApi {
  getPorts(): Promise<WebSerialPort[]>;
  requestPort(options?: { filters?: Array<{ usbVendorId?: number; usbProductId?: number }> }): Promise<WebSerialPort>;
}

function webSerial(): WebSerialApi | null {
  if (typeof navigator === "undefined") return null;
  const s = (navigator as unknown as { serial?: WebSerialApi }).serial;
  return s ?? null;
}

/** True when this browser can flash over WebSerial (Chrome, Edge, Opera, and other Chromium browsers). */
export function canFlashWithEsptool(): boolean {
  return webSerial() !== null;
}

/** True when the Flasher page talks to real boards straight from the browser over WebSerial. */
export function flasherUsesWebSerial(): boolean {
  return !isSimulatedUsbMode() && canFlashWithEsptool();
}

/** Shown when the browser has no WebSerial (Firefox, Safari). The flasher has no server fallback. */
export const FLASHER_NEEDS_WEBSERIAL =
  "Flashing needs a browser with WebSerial: Chrome, Edge, or Opera on a desktop computer.";

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/** Last ~400 esptool-js log lines, kept for diagnostics (`window.__slaprfEsptool.log()`). */
const esptoolLog: string[] = [];
function debugLog(line: string): void {
  const clean = line.replace(/\s+$/, "");
  if (!clean) return;
  esptoolLog.push(`${new Date().toISOString().slice(11, 23)} ${clean}`);
  if (esptoolLog.length > 400) esptoolLog.splice(0, esptoolLog.length - 400);
}

/* ---- Port selection ------------------------------------------------------------------------- */

/**
 * Returns the XIAO ESP32-C5 WebSerial port. Reuses the previously granted Espressif port when exactly
 * one is present; otherwise opens the browser's port chooser filtered to Espressif boards.
 * Call this directly from a click handler so the browser chooser is allowed to open.
 */
export async function acquireEspSerialPort(): Promise<WebSerialPort> {
  const api = webSerial();
  if (!api) {
    throw new Error("Flashing needs a Chromium browser (Chrome, Edge, or Opera) with WebSerial support.");
  }
  const granted = (await api.getPorts().catch(() => [] as WebSerialPort[])).filter(
    (p) => p.getInfo().usbVendorId === ESPRESSIF_USB_VID
  );
  if (granted.length === 1) {
    return granted[0];
  }
  const t0 = performance.now();
  try {
    return await api.requestPort({ filters: [{ usbVendorId: ESPRESSIF_USB_VID }] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/user gesture/i.test(msg)) {
      throw new Error("Chrome only shows the USB port prompt right after a click. Click the button again.");
    }
    if (/No port selected|cancel/i.test(msg)) {
      // A person takes far longer than this to dismiss the prompt: Chrome refused without showing it.
      if (performance.now() - t0 < 400) {
        throw new Error(
          "Chrome blocked the USB port prompt. Open chrome://settings/content/serialPorts, allow sites to ask, make sure this site is not blocked, then try again."
        );
      }
      throw new Error("No port selected");
    }
    throw err;
  }
}

/* ---- Sharing the board with the SlapRF Server ---------------------------------------------- */

interface ServerHold {
  /** Server USB slots that were connected before the flasher action, with their port names. */
  slots: Array<{ slotIndex: number; portName: string }>;
}

/**
 * WebSerial cannot tell which COM port it opened, so the flasher releases every board the
 * SlapRF Server holds (the OS allows only one owner per port) and hands them back afterwards.
 */
async function pauseServerConnection(): Promise<ServerHold> {
  const hold: ServerHold = { slots: [] };
  let released = false;
  for (const slot of usbPool.slots) {
    const raw = slot.rawPort;
    if (!isBackendSerialPort(raw)) continue;
    if (slot.connected) hold.slots.push({ slotIndex: slot.slotIndex, portName: raw.portName });
    if (slot.connected || slot.reconnecting) {
      await slot.disconnectCleanly().catch(() => undefined);
      released = true;
    }
  }
  // Give the OS a moment to release the handles before the browser opens a port.
  if (released) await sleep(250);
  return hold;
}

/** Hands the boards back to the SlapRF Server if it held them before the flasher action. */
async function resumeServerConnection(hold: ServerHold): Promise<void> {
  if (hold.slots.length === 0 || !capabilitiesSnapshot().portable) return;
  await Promise.all(
    hold.slots.map(async ({ slotIndex, portName }) => {
      const slot = usbPool.slots[slotIndex];
      if (!slot) return;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        try {
          await slot.connectWithPort(createBackendPortHandle(portName), false, 1800);
          if (slot.connected) return;
        } catch {
          // board still re-enumerating
        }
        await sleep(500);
      }
    })
  );
}

/* ---- Identity readback (running firmware) --------------------------------------------------- */

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.length;
  }
  return all;
}

function readoutFrom(bytes: Uint8Array): { readout: TimerReadout | null; complete: boolean } {
  const cfg = parseSlaprfConfigBlock(bytes);
  const status = parseStatusSnapshot(bytes);
  if (cfg && status) {
    return {
      complete: true,
      readout: {
        ...cfg,
        chip: status.chip ? `${status.chip.model} (${status.chip.rev})` : cfg.chip,
        timerLabel: status.label || cfg.timerLabel,
        firmwareVersion: status.fw || cfg.firmwareVersion,
        fingerprint: status.fp || cfg.fingerprint,
        frequenciesMHz: status.freqs?.length ? status.freqs : cfg.frequenciesMHz,
        status,
      },
    };
  }
  if (cfg) return { complete: false, readout: { ...cfg } };
  if (status) {
    return {
      complete: false,
      readout: {
        chip: status.chip ? `${status.chip.model} (${status.chip.rev})` : "Seeed XIAO ESP32-C5 (RISC-V 240 MHz)",
        role: status.role === 1 ? "hub" : "spoke",
        timerLabel: status.label || "",
        frequenciesMHz: status.freqs,
        firmwareVersion: status.fw,
        fingerprint: status.fp,
        status,
      },
    };
  }
  return { complete: false, readout: null };
}

/**
 * Asks the running SlapRF firmware for `STATUS?` and its `SLAPRF02` block over WebSerial, then closes
 * the port. Returns null when nothing usable answers (blank chip, other firmware, or bootloader).
 */
export async function readIdentityOverWebSerial(port: WebSerialPort, waitMs = 1200): Promise<TimerReadout | null> {
  try {
    await port.open({ baudRate: 115200, bufferSize: 16384 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      /already open|Failed to open/i.test(msg)
        ? "The USB port is in use by another app. Close other serial tools and try again."
        : msg
    );
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const query = new TextEncoder().encode("\nSTATUS?\nSLAPRF?\n");
  const send = async () => {
    const w = port.writable?.getWriter();
    if (!w) return;
    await w.write(query).catch(() => undefined);
    w.releaseLock();
  };
  try {
    // Step (1,1) -> (1,0) -> (0,0) so opening/closing never resets the board.
    await port.setSignals({ dataTerminalReady: true, requestToSend: false }).catch(() => undefined);
    await port.setSignals({ dataTerminalReady: false, requestToSend: false }).catch(() => undefined);
    await send();
    reader = port.readable?.getReader() ?? null;
    if (!reader) return null;
    const deadline = Date.now() + waitMs;
    let resent = false;
    while (Date.now() < deadline) {
      const res = await Promise.race([
        reader.read(),
        sleep(Math.max(1, Math.min(150, deadline - Date.now()))).then(() => null),
      ]);
      if (res && (res.done || !res.value)) break;
      if (res?.value) {
        chunks.push(res.value);
        total += res.value.length;
        const parsed = readoutFrom(concat(chunks, total));
        if (parsed.complete) return parsed.readout;
      } else if (!resent && Date.now() > deadline - waitMs / 2) {
        // A board that just booted may have missed the first query.
        resent = true;
        await send();
      }
    }
    return total > 0 ? readoutFrom(concat(chunks, total)).readout : null;
  } finally {
    if (reader) {
      await reader.cancel().catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
    await port.close().catch(() => undefined);
  }
}

/** Reads the board's identity once, retrying while it boots. */
async function readIdentityWithRetry(port: WebSerialPort, attempts: number): Promise<TimerReadout | null> {
  let last: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await readIdentityOverWebSerial(port);
      if (r) return r;
    } catch (err) {
      last = err;
    }
    if (i < attempts - 1) await sleep(800);
  }
  if (last) throw last;
  return null;
}

/**
 * One-shot read: picks the board's port (Chrome's chooser the first time), reads its identity, and
 * closes the port. Call from a click handler.
 */
export async function readXiaoC5WithWebSerial(): Promise<TimerReadout | null> {
  const port = await acquireEspSerialPort();
  const hold = await pauseServerConnection();
  try {
    return await readIdentityWithRetry(port, 2);
  } finally {
    void resumeServerConnection(hold);
  }
}

/* ---- esptool-js session --------------------------------------------------------------------- */

interface Session {
  transport: Transport;
  loader: ESPLoader;
}

/**
 * esptool-js does not yet disable the ESP32-C5 LP (RTC) watchdog after a USB-Serial-JTAG reset into
 * the ROM bootloader. If it fires mid-session, the chip resets and Windows reports "A device attached
 * to the system is not functioning". Right after chip detection, disable LP_WDT and enable the super
 * watchdog auto-feed (the same registers esptool uses for ESP32-C6).
 */
function installC5WatchdogGuard(loader: ESPLoader): void {
  const l = loader as unknown as {
    detectChip: (mode: string) => Promise<void>;
    writeReg: (addr: number, value: number, mask?: number) => Promise<void>;
    chip?: { CHIP_NAME?: string };
  };
  const original = l.detectChip.bind(loader);
  l.detectChip = async (mode: string) => {
    await original(mode);
    if (!/C5/i.test(l.chip?.CHIP_NAME ?? "")) return;
    const writes: Array<[number, number, number]> = [
      [0x600b1034, 0x00000000, 0x3 << 29], // LP_AON_SYS_CFG: clear FORCE_DOWNLOAD_BOOT
      [0x600b1c18, 0x50d83aa1, 0xffffffff], // LP_WDT_WPROTECT = unlock
      [0x600b1c00, 0x00000000, 0xffffffff], // LP_WDT_CONFIG0 = 0 (disable RTC WDT)
      [0x600b1c18, 0x00000000, 0xffffffff], // LP_WDT_WPROTECT = lock
      [0x600b1c20, 0x50d83aa1, 0xffffffff], // LP_WDT_SWD_WPROTECT = unlock
      [0x600b1c1c, 1 << 18, 1 << 18], // LP_WDT_SWD_CONFIG |= SWD_AUTO_FEED_EN
      [0x600b1c20, 0x00000000, 0xffffffff], // LP_WDT_SWD_WPROTECT = lock
    ];
    for (const [addr, value, mask] of writes) {
      await l.writeReg(addr, value >>> 0, mask >>> 0).catch(() => undefined);
    }
  };
}

/** Opens esptool-js on `port`, resets the board into the ROM bootloader, and starts the flasher stub. */
async function openSession(
  port: WebSerialPort,
  onLine: (line: string) => void,
  signal: AbortSignal
): Promise<Session> {
  const terminal = {
    clean() {},
    writeLine(data: string) {
      debugLog(data);
      onLine(data);
    },
    write(data: string) {
      debugLog(data);
      onLine(data);
    },
  };
  let lastErr: unknown = null;
  const deadline = Date.now() + 10000;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (signal.aborted) throw new Error("Cancelled.");
    const transport = new Transport(port, false);
    // USB-Serial-JTAG ignores the baud rate; keep ROM and stub rates equal so the port is never reopened.
    const loader = new ESPLoader({ transport, baudrate: 115200, romBaudrate: 115200, terminal });
    installC5WatchdogGuard(loader);
    try {
      await loader.main("default_reset");
      return { transport, loader };
    } catch (err) {
      lastErr = err;
      debugLog(`connect attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
      await transport.disconnect().catch(() => undefined);
      if (signal.aborted || attempt === 3 || Date.now() > deadline) break;
      onLine(`__retry__${attempt + 1}`);
      await sleep(1200);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "Could not connect to the ESP32-C5."));
}

function friendlyError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Failed to open serial port|already open|NetworkError|Access denied|in use by another app/i.test(msg)) {
    return new Error("The USB port is in use by another app. Close other serial tools and try again.");
  }
  if (/Failed to connect|Wrong boot mode|timed out|Serial data stream stopped/i.test(msg)) {
    return new Error(
      `Lost contact with the ESP32-C5 (${msg}). Unplug the board (and its battery), hold BOOT while plugging it back in, then try again.`
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

/** Splits a merged image (`esptool merge_bin`, offset 0) into the bytes to write and their flash address. */
function flashRegion(image: Uint8Array): { data: Uint8Array; address: number } {
  if (image.length > 0x10000 && image[0] === 0xff && image[0x2000] === ESP_IMAGE_MAGIC) {
    return { data: image.subarray(0x2000), address: 0x2000 };
  }
  return { data: image, address: 0 };
}

/** Sets DTR/RTS as one USB SET_CONTROL_LINE_STATE (RTS first, so Windows usbser.sys sends both together). */
async function setLines(port: WebSerialPort, dtr: boolean, rts: boolean): Promise<void> {
  await port.setSignals({ requestToSend: rts }).catch(() => undefined);
  await port.setSignals({ dataTerminalReady: dtr, requestToSend: rts }).catch(() => undefined);
}

/**
 * Reboots an ESP32-C5 into its flashed app over USB-Serial-JTAG. esptool's plain RTS toggle does not
 * reset this chip; the USB-Serial-JTAG peripheral asserts CHIP_RST on the (1,1) -> (0,1) DTR/RTS edge,
 * with IO0 released so the chip boots from SPI flash. Opens and closes the port itself.
 */
export async function rebootIntoApp(port: WebSerialPort): Promise<void> {
  try {
    await port.open({ baudRate: 115200, bufferSize: 16384 });
  } catch {
    return;
  }
  try {
    await setLines(port, false, false);
    await sleep(50);
    await setLines(port, true, true);
    await sleep(60);
    await setLines(port, false, true);
    await sleep(120);
    await setLines(port, false, false);
    await sleep(150);
  } finally {
    await port.close().catch(() => undefined);
  }
}

/* ---- Flash ---------------------------------------------------------------------------------- */

export interface FlashResult extends TimerReadout {
  /** Identity read back from the board after it rebooted into the new firmware (null if it did not answer). */
  verified: TimerReadout | null;
}

/**
 * One-shot flash: writes `imageBytes` to the board on `port` with esptool-js, reboots it, reads its
 * identity back once to verify, and closes the port. `port` should come from `acquireEspSerialPort()`
 * called in the click handler.
 */
export async function flashXiaoC5WithEsptool(
  port: WebSerialPort,
  imageBytes: Uint8Array,
  label: string,
  onProgress: ProgressCallback,
  keepFingerprint: boolean
): Promise<FlashResult | null> {
  const emit = (stage: FlashProgress["stage"], percent: number, detail: string) =>
    onProgress({ stage, percent, detail } as FlashProgress);

  emit("connecting", 2, "Preparing USB port…");
  const hold = await pauseServerConnection();

  const abort = new AbortController();
  let session: Session | null = null;
  const unregister = registerFlashCanceler(() => {
    abort.abort();
    if (session) void session.transport.disconnect().catch(() => undefined);
  });

  let image = imageBytes;
  let fingerprintKept = false;
  try {
    if (keepFingerprint) {
      emit("reading", 4, "Checking board for an existing fingerprint…");
      // Always ask this board: with several boards plugged in, the server's Hub is not this one.
      const existing = await readIdentityOverWebSerial(port, 900).catch(() => null);
      const fp = (existing?.fingerprint || "").toUpperCase();
      if (fp && fp !== "00000000" && fp !== "00000001") {
        image = await withFingerprint(image, fp);
        fingerprintKept = true;
      }
    }
    if (abort.signal.aborted) throw new Error("Cancelled.");

    emit("bootloader", 6, "Connecting to ESP32-C5 ROM bootloader…");
    session = await openSession(
      port,
      (line) => {
        if (line.startsWith("__retry__")) {
          emit("connecting", 6, `Board not responding. Retrying (attempt ${line.slice(9)} of 3)…`);
        } else if (/Chip is/i.test(line)) {
          emit("bootloader", 8, line.trim());
        } else if (/Uploading stub/i.test(line)) {
          emit("bootloader", 10, "Uploading flasher stub…");
        } else if (/Stub running/i.test(line)) {
          emit("bootloader", 12, "Flasher stub running…");
        }
      },
      abort.signal
    );
    if (abort.signal.aborted) throw new Error("Cancelled.");

    const region = flashRegion(image);
    const kbTotal = Math.round(region.data.length / 1024);
    emit("erasing", 14, `Erasing ${kbTotal} KB of SPI flash…`);
    let sawProgress = false;
    let erasePct = 14;
    const eraseTicker = window.setInterval(() => {
      if (!sawProgress && erasePct < 17) {
        erasePct++;
        emit("erasing", erasePct, `Erasing ${kbTotal} KB of SPI flash…`);
      }
    }, 400);
    try {
      await session.loader.writeFlash({
        fileArray: [region],
        flashMode: "keep",
        flashFreq: "keep",
        flashSize: "keep",
        eraseAll: false,
        compress: true,
        reportProgress: (_idx, written, total) => {
          sawProgress = true;
          const frac = total > 0 ? Math.min(1, written / total) : 0;
          const pct = Math.min(94, Math.round(18 + frac * 76));
          emit("writing", pct, `Writing ${label} (${Math.round(frac * kbTotal)} / ${kbTotal} KB)…`);
        },
      });
    } finally {
      window.clearInterval(eraseTicker);
    }

    emit("rebooting", 95, "Rebooting XIAO ESP32-C5…");
    await session.transport.disconnect().catch(() => undefined);
    session = null;
    await sleep(200);
    await rebootIntoApp(port);

    const written = parseSlaprfConfigBlock(image);
    emit("rebooting", 97, `Verifying ${label}…`);
    await sleep(1500);
    const verified = await readIdentityWithRetry(port, 5).catch(() => null);
    if (verified && written && verified.fingerprint && written.fingerprint) {
      if (verified.fingerprint.toUpperCase() !== written.fingerprint.toUpperCase()) {
        throw new Error(
          `Flash finished, but the board reports fingerprint ${verified.fingerprint} instead of ${written.fingerprint}. Try flashing again.`
        );
      }
    }
    emit(
      "done",
      100,
      verified ? `${label} flashed and verified.` : `${label} flashed. The board did not answer the readback yet.`
    );
    const base: TimerReadout = written ?? {
      chip: "Seeed XIAO ESP32-C5 (RISC-V 240 MHz)",
      role: "spoke",
      timerLabel: label,
      frequenciesMHz: [],
      firmwareVersion: "",
      fingerprint: "",
    };
    return { ...base, ...(verified ?? {}), fingerprintKept, verified };
  } catch (err) {
    if (abort.signal.aborted) throw new Error("Flash cancelled.");
    throw friendlyError(err);
  } finally {
    unregister();
    if (session) {
      await session.transport.disconnect().catch(() => undefined);
    }
    void resumeServerConnection(hold);
  }
}

/* ---- Erase ---------------------------------------------------------------------------------- */

/** One-shot erase of the entire SPI flash of the board on `port`, then closes the port. */
export async function eraseXiaoC5WithEsptool(port: WebSerialPort, onProgress: ProgressCallback): Promise<void> {
  const emit = (stage: FlashProgress["stage"], percent: number, detail: string) =>
    onProgress({ stage, percent, detail } as FlashProgress);

  emit("connecting", 4, "Preparing USB port…");
  const hold = await pauseServerConnection();

  const abort = new AbortController();
  let session: Session | null = null;
  const unregister = registerFlashCanceler(() => {
    abort.abort();
    if (session) void session.transport.disconnect().catch(() => undefined);
  });
  try {
    emit("bootloader", 10, "Connecting to ESP32-C5 ROM bootloader…");
    session = await openSession(
      port,
      (line) => {
        if (line.startsWith("__retry__")) {
          emit("connecting", 10, `Board not responding. Retrying (attempt ${line.slice(9)} of 3)…`);
        } else if (/Stub running/i.test(line)) {
          emit("bootloader", 20, "Flasher stub running…");
        }
      },
      abort.signal
    );
    let pct = 25;
    emit("erasing", pct, "Erasing entire SPI flash (takes up to 30 seconds)…");
    const ticker = window.setInterval(() => {
      if (pct < 90) {
        pct += 2;
        emit("erasing", pct, "Erasing entire SPI flash (takes up to 30 seconds)…");
      }
    }, 700);
    try {
      await session.loader.eraseFlash();
    } finally {
      window.clearInterval(ticker);
    }
    emit("rebooting", 96, "Rebooting XIAO ESP32-C5…");
    await session.transport.disconnect().catch(() => undefined);
    session = null;
    await sleep(200);
    await rebootIntoApp(port);
    emit("done", 100, "Board flash erased.");
  } catch (err) {
    if (abort.signal.aborted) throw new Error("Erase cancelled.");
    throw friendlyError(err);
  } finally {
    unregister();
    if (session) {
      await session.transport.disconnect().catch(() => undefined);
    }
    void resumeServerConnection(hold);
  }
}

/* ---- Automation hook ---------------------------------------------------------------------------
 * `window.__slaprfEsptool` lets scripts (Chrome DevTools Protocol, tests) drive the real WebSerial
 * flasher without clicking through the UI. It only uses ports this site was already granted
 * (`navigator.serial.getPorts()`), so it never opens the browser's port chooser on its own.
 */
interface EsptoolAutomationResult {
  ok: boolean;
  error?: string;
  ms: number;
  result?: unknown;
  progress: string[];
  log: string[];
}

async function grantedEspPort(index?: number): Promise<WebSerialPort> {
  const api = webSerial();
  if (!api) throw new Error("WebSerial is not available in this browser.");
  const ports = (await api.getPorts()).filter((p) => p.getInfo().usbVendorId === ESPRESSIF_USB_VID);
  if (ports.length === 0) {
    throw new Error("No granted ESP32-C5 port. Click a Flasher button once and pick the board in Chrome's chooser.");
  }
  if (typeof index === "number") {
    if (!ports[index]) throw new Error(`No granted ESP32-C5 port at index ${index} (have ${ports.length}).`);
    return ports[index];
  }
  if (ports.length > 1) {
    throw new Error(`${ports.length} granted ESP32-C5 ports; pass { index } to choose one.`);
  }
  return ports[0];
}

async function runAutomation(
  index: number | undefined,
  task: (port: WebSerialPort, onProgress: ProgressCallback) => Promise<unknown>
): Promise<string> {
  const t0 = performance.now();
  const progress: string[] = [];
  const logStart = esptoolLog.length;
  const onProgress: ProgressCallback = (p) => {
    const line = `[${String(Math.round(p.percent)).padStart(3)}%] ${p.stage}: ${p.detail}`;
    if (progress[progress.length - 1] !== line) progress.push(line);
  };
  const out: EsptoolAutomationResult = { ok: false, ms: 0, progress, log: [] };
  try {
    const port = await grantedEspPort(index);
    out.result = (await task(port, onProgress)) ?? null;
    out.ok = true;
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  out.ms = Math.round(performance.now() - t0);
  out.log = esptoolLog.slice(logStart);
  return JSON.stringify(out);
}

if (typeof window !== "undefined") {
  (window as unknown as { __slaprfEsptool: unknown }).__slaprfEsptool = {
    /** Lists WebSerial ports this site was granted. */
    ports: async () => {
      const api = webSerial();
      if (!api) return "[]";
      const ports = await api.getPorts();
      return JSON.stringify(ports.map((p) => p.getInfo()));
    },
    /** Reads the identity of the single granted ESP32-C5. Returns a JSON report. */
    read: (opts: { index?: number } = {}) =>
      runAutomation(opts.index, async (port) => {
        const hold = await pauseServerConnection();
        try {
          return await readIdentityWithRetry(port, 2);
        } finally {
          void resumeServerConnection(hold);
        }
      }),
    /** Flashes `role`/`label` (default Spoke T1) to the single granted ESP32-C5. Returns a JSON report. */
    flash: (
      opts: {
        index?: number;
        role?: "hub" | "spoke";
        label?: string;
        keepFingerprint?: boolean;
        /** Stamp this exact fingerprint (8 hex digits), e.g. to restore a half-flashed board. */
        fingerprint?: string;
        frequenciesMHz?: number[];
      } = {}
    ) =>
      runAutomation(opts.index, async (port, onProgress) => {
        const role = opts.role === "hub" ? "hub" : "spoke";
        const label = (opts.label || (role === "hub" ? "H1" : "T1")).trim();
        const built = await buildOrPatchFirmwareBin({
          role,
          timerLabel: label,
          fingerprint: /^[0-9a-f]{8}$/i.test(opts.fingerprint || "") ? opts.fingerprint!.toUpperCase() : generateFingerprint(),
          frequenciesMHz: opts.frequenciesMHz?.length
            ? opts.frequenciesMHz.slice(0, 8)
            : [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917],
        });
        const keep = opts.fingerprint ? false : opts.keepFingerprint !== false;
        return flashXiaoC5WithEsptool(port, built.bytes, label, onProgress, keep);
      }),
    /** Erases the whole SPI flash of the single granted ESP32-C5. Returns a JSON report. */
    erase: (opts: { index?: number } = {}) =>
      runAutomation(opts.index, (port, onProgress) => eraseXiaoC5WithEsptool(port, onProgress)),
    /** Reboots the single granted ESP32-C5 into its flashed app. */
    reboot: (opts: { index?: number } = {}) => runAutomation(opts.index, (port) => rebootIntoApp(port)),
    /** Recent raw esptool-js log lines. */
    log: () => esptoolLog.join("\n"),
  };
}
