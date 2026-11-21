/**
 * Espressif ESP32-C5 firmware image helpers, config readback, and the simulation-mode flasher:
 *   - Real hardware flashing and erasing use Espressif's esptool-js over WebSerial
 *     (see `esptool_flasher.ts`), so they behave the same on every OS.
 *   - Simulation mode (`isSimulatedUsbMode()`): speaks the SLIP-framed Espressif ROM bootloader
 *     protocol directly to `SimulatedSerialPort` so `#/flasher` works identically in Demo & Sim modes.
 *   - There is no server flasher. Browsers without WebSerial (Firefox, Safari) cannot flash.
 */
import { capabilitiesSnapshot } from "./capabilities";
import { isSimulatedUsbMode } from "./sim_serial_port";

export interface FlashProgress {
  stage: "connecting" | "bootloader" | "reading" | "erasing" | "writing" | "rebooting" | "done";
  percent: number;
  detail: string;
}

export interface TimerStatusSnapshot {
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
  chip?: { model: string; rev: string; mac: string; flashMB: number };
  net?: { mode: string; stations: number };
  channel: number;
  slot: number;
  scanLive?: boolean;
  freqsTemporary: boolean;
  chanMask?: number;
  freqs: number[];
}

export interface TimerReadout {
  chip: string;
  role: "hub" | "spoke";
  timerLabel: string;
  frequenciesMHz: number[];
  firmwareVersion: string;
  fingerprint: string;
  /** Set by `flashXiaoC5OverWebSerial`: true if the board's previous fingerprint was kept. */
  fingerprintKept?: boolean;
  /** Live status snapshot when read from a running timer over USB. */
  status?: TimerStatusSnapshot;
}

export type ProgressCallback = (progress: FlashProgress) => void;

interface SerialPortSignals {
  dataTerminalReady?: boolean;
  requestToSend?: boolean;
}

interface SerialPortLike {
  open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  setSignals(signals: SerialPortSignals): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
}

// Espressif ROM bootloader opcodes
const ESP_FLASH_BEGIN = 0x02;
const ESP_FLASH_DATA = 0x03;
const ESP_FLASH_END = 0x04;
const ESP_SYNC = 0x08;
const ESP_WRITE_REG = 0x09;
const ESP_SPI_SET_PARAMS = 0x0b;
const ESP_SPI_ATTACH = 0x0d;

const SLIP_END = 0xc0;
const SLIP_ESC = 0xdb;
const SLIP_ESC_END = 0xdc;
const SLIP_ESC_ESC = 0xdd;

const FLASH_BLOCK_SIZE = 1024; // ESP32C5ROM.FLASH_WRITE_SIZE = 0x400 (1024 bytes)
const ESP_IMAGE_MAGIC = 0xe9;

/** Current firmware build (firmware/slaprf). */
export const LATEST_FIRMWARE_VERSION = "v0.1.6";

/** The one compiled firmware image, built from firmware/slaprf and served next to the app. */
export const FIRMWARE_IMAGE_URL = "./firmware/slaprf-xiao-c5.bin";

/** USB firmware image file name (mirrors Go `firmware.ImageName`). */
export const FIRMWARE_IMAGE_NAME = "slaprf-xiao-c5.bin";

/** Bluetooth Hub firmware image file name (mirrors Go `firmware.BLEImageName`, built from firmware/slaprf_ble). */
export const FIRMWARE_BLE_IMAGE_NAME = "slaprf-xiao-c5-ble.bin";

/** Bluetooth Hub firmware image URL. Optional: only present when firmware/slaprf_ble was built. */
export const FIRMWARE_BLE_IMAGE_URL = `./firmware/${FIRMWARE_BLE_IMAGE_NAME}`;

/** How a Hub talks to the host: the USB cable (default image) or Bluetooth LE (BLE image). */
export type HubLink = "usb" | "ble";

/** Firmware image file name for a role and Hub link (mirrors Go `firmware.ImageNameFor`). Spokes always get the USB image. */
export function firmwareImageNameFor(role: "hub" | "spoke", hubLink: HubLink = "usb"): string {
  return role === "hub" && hubLink === "ble" ? FIRMWARE_BLE_IMAGE_NAME : FIRMWARE_IMAGE_NAME;
}

let firmwareBaseDir = "./firmware";

/** Overrides the base directory where `.bin` firmware images are fetched (for example, `/docs/firmware`). */
export function setFirmwareBaseDir(dir: string): void {
  firmwareBaseDir = dir.replace(/\/+$/, "") || "./firmware";
  bleImageProbe = null;
}

/** Firmware image URL for a role and Hub link. */
export function firmwareImageUrlFor(role: "hub" | "spoke", hubLink: HubLink = "usb"): string {
  return `${firmwareBaseDir}/${firmwareImageNameFor(role, hubLink)}`;
}

/** Error shown when the Bluetooth Hub image is requested but has not been built. */
export const BLE_IMAGE_MISSING_MESSAGE =
  "The Bluetooth hub firmware image (slaprf-xiao-c5-ble.bin) is not available in this build.";

let bleImageProbe: Promise<boolean> | null = null;

/**
 * Resolves true when the Bluetooth Hub image is served next to the app. Uses a HEAD request
 * (no 1 MB download) and treats a 404, an HTML fallback page, or a network error as missing.
 * The result is cached for the page lifetime; pass `refresh` to probe again.
 */
export function probeBleFirmwareImage(refresh = false): Promise<boolean> {
  if (bleImageProbe && !refresh) return bleImageProbe;
  bleImageProbe = (async () => {
    try {
      if (typeof fetch !== "function") return false;
      const res = await fetch(firmwareImageUrlFor("hub", "ble"), { method: "HEAD", cache: "no-cache" });
      if (!res.ok) return false;
      const type = (res.headers.get("content-type") || "").toLowerCase();
      return !type.includes("text/html");
    } catch {
      return false;
    }
  })();
  return bleImageProbe;
}

/** Test hook: forget the cached Bluetooth image probe. */
export function resetBleFirmwareImageProbe(): void {
  bleImageProbe = null;
}

/** 5.8 GHz sweep rate compiled into the firmware (SWEEP_HZ in firmware/slaprf/main/main.c). */
export const FIRMWARE_SWEEP_HZ = 100;

/** Random, non-zero 32-bit board fingerprint rendered as 8 upper-case hex digits. */
export function generateFingerprint(): string {
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] === 0);
  return buf[0].toString(16).toUpperCase().padStart(8, "0");
}

// SLAPRF02 config block layout — mirrored from internal/firmware/image.go.
const CONFIG_MAGIC = "SLAPRF02";
const CONFIG_OFF = 0x0100;
const CONFIG_LEN = 160;
const OFF_VERSION = 8;
const OFF_ROLE = 11;
const OFF_RESERVED = 12; // Reserved (always 0, ignored on read)
const OFF_WIFI_MODE = 13; // Reserved (always 0). Bytes 34..106 (legacy SSID/pass) stay zeroed.
const OFF_FINGERPRINT = 14;
const OFF_FREQS = 18;
const OFF_LABEL = 107;

const OFF_CRC = CONFIG_LEN - 1;
const IMAGE_SIZE = 64 * 1024;

function xor8(bytes: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < bytes.length; i++) c ^= bytes[i];
  return c;
}

function findConfigBlock(bytes: Uint8Array): number {
  const magic = new TextEncoder().encode(CONFIG_MAGIC);
  outer: for (let i = 0; i <= bytes.length - CONFIG_LEN; i++) {
    for (let j = 0; j < magic.length; j++) {
      if (bytes[i + j] !== magic[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** App image start offsets: factory app inside a merged flash image (0x10000), or a bare app (0x0). */
const APP_IMAGE_OFFSETS = [0x10000, 0x0];

/**
 * Recompute the ESP-IDF app image checksum (and appended SHA-256, if enabled) for the app image
 * containing `patchedAt`, so the bootloader accepts an image whose config block was patched.
 * Mirrors `RepairAppImage` in internal/firmware/image.go.
 */
async function repairAppImage(img: Uint8Array, patchedAt: number): Promise<void> {
  const start = APP_IMAGE_OFFSETS.find((o) => o <= patchedAt && o + 24 <= img.length && img[o] === 0xe9);
  if (start === undefined) throw new Error("No ESP app image header found before the config block.");
  const view = new DataView(img.buffer, img.byteOffset, img.byteLength);
  const segCount = img[start + 1];
  const hashAppended = img[start + 23] === 1;
  let pos = start + 24;
  let chk = 0xef;
  for (let s = 0; s < segCount; s++) {
    const segLen = view.getUint32(pos + 4, true);
    pos += 8;
    if (pos + segLen > img.length) throw new Error("Truncated ESP app image segment.");
    for (let i = pos; i < pos + segLen; i++) chk ^= img[i];
    pos += segLen;
  }
  pos += 15 - ((pos - start) % 16);
  if (pos >= img.length) throw new Error("Truncated ESP app image checksum.");
  img[pos] = chk;
  if (hashAppended) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", img.slice(start, pos + 1)));
    img.set(digest, pos + 1);
  }
}

/** 64 KB placeholder app image (valid header, NOP sled, empty config block) — mirrors Go `SyntheticBase`. */
function syntheticBase(): Uint8Array {
  const img = new Uint8Array(IMAGE_SIZE);
  const dv = new DataView(img.buffer);
  img[0] = 0xe9;
  img[1] = 1;
  img[2] = 0x02;
  img[3] = 0x10;
  dv.setUint32(4, 0x40800000, true);
  dv.setUint16(12, 0x0017, true); // ESP32-C5 chip ID
  dv.setUint32(24, 0x40800000, true);
  dv.setUint32(28, IMAGE_SIZE - 32 - 16, true);
  for (let off = 32; off < IMAGE_SIZE - 16; off += 4) dv.setUint32(off, 0x00000013, true);
  const enc = new TextEncoder();
  img.set(enc.encode("SlapRF XIAO-ESP32-C5 placeholder image (no compiled firmware)"), 0x40);
  img.set(enc.encode(CONFIG_MAGIC), CONFIG_OFF);
  return img;
}

/** Returns a copy of `img` with its board fingerprint replaced (config CRC + image integrity repaired). */
export async function withFingerprint(img: Uint8Array, fingerprintHex: string): Promise<Uint8Array> {
  const out = new Uint8Array(img);
  const off = findConfigBlock(out);
  const fp = parseInt(fingerprintHex, 16) >>> 0;
  if (off < 0 || !fp) return out;
  new DataView(out.buffer, out.byteOffset + off, CONFIG_LEN).setUint32(OFF_FINGERPRINT, fp, true);
  out[off + OFF_CRC] = xor8(out.subarray(off, off + OFF_CRC));
  await repairAppImage(out, off);
  return out;
}

/**
 * Fetches the compiled firmware image (`FIRMWARE_IMAGE_URL`, built by CI from `firmware/slaprf/`),
 * or falls back to a placeholder image, and stamps the `SLAPRF02` block so USB flashing and `.bin`
 * downloads work with zero Go backend.
 *
 * With `hubLink: "ble"` (Hub only) the Bluetooth Hub image (`FIRMWARE_BLE_IMAGE_URL`, built from
 * `firmware/slaprf_ble/`) is patched instead, with the role forced to Hub. There is no placeholder
 * fallback for it: a missing image throws `BLE_IMAGE_MISSING_MESSAGE`.
 */
export async function buildOrPatchFirmwareBin(opts: {
  role: "hub" | "spoke";
  timerLabel: string;
  fingerprint?: string;
  frequenciesMHz?: number[];
  hubLink?: HubLink;
}): Promise<{ bytes: Uint8Array; filename: string }> {
  const ble = opts.role === "hub" && opts.hubLink === "ble";
  const roleCode = opts.role === "hub" || ble ? 1 : 2;
  const fingerprint = opts.fingerprint || generateFingerprint();
  const cleanLabel = opts.timerLabel.trim().slice(0, 24);
  const defaultFreqs = [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917];
  const freqs = defaultFreqs.map((def, i) => {
    const f = opts.frequenciesMHz?.[i] ?? def;
    return f >= 5600 && f <= 5950 ? f : def;
  });

  let img: Uint8Array | null = null;
  try {
    const res = await fetch(firmwareImageUrlFor(opts.role, opts.hubLink), { cache: "no-cache" });
    if (res.ok) {
      const fetched = new Uint8Array(await res.arrayBuffer());
      if (findConfigBlock(fetched) >= 0) img = fetched;
    }
  } catch {
    // Offline or not built; fall back to the placeholder image below (USB image only).
  }
  if (!img) {
    if (ble) throw new Error(BLE_IMAGE_MISSING_MESSAGE);
    img = syntheticBase();
  }

  const off = findConfigBlock(img);
  const enc = new TextEncoder();
  const block = new Uint8Array(CONFIG_LEN);
  const bv = new DataView(block.buffer);
  block.set(enc.encode(CONFIG_MAGIC), 0);
  const [maj, min, pat] = LATEST_FIRMWARE_VERSION.replace(/^v/, "").split(".").map((n) => Number(n) || 0);
  block[OFF_VERSION] = maj;
  block[OFF_VERSION + 1] = min;
  block[OFF_VERSION + 2] = pat;
  block[OFF_ROLE] = roleCode;
  block[OFF_RESERVED] = 0;
  block[OFF_WIFI_MODE] = 0; // Reserved: the Hub is a USB dongle; no Wi-Fi (SSID/pass stay zeroed)
  bv.setUint32(OFF_FINGERPRINT, parseInt(fingerprint, 16) >>> 0, true);
  for (let i = 0; i < 8; i++) bv.setUint16(OFF_FREQS + i * 2, freqs[i], true);
  block.set(enc.encode(cleanLabel).subarray(0, 24), OFF_LABEL);
  block[OFF_CRC] = xor8(block.subarray(0, OFF_CRC));
  img.set(block, off);
  await repairAppImage(img, off);

  const slug = cleanLabel ? cleanLabel.replace(/[^a-zA-Z0-9_-]+/g, "-") : opts.role;
  return {
    bytes: img,
    filename: `slaprf-xiao-c5-${ble ? "ble-" : ""}${slug}-${LATEST_FIRMWARE_VERSION}.bin`,
  };
}
/** True when the Flasher page can work: Simulation/Demo mode, a native Go/Android USB server, or WebSerial. */
export function isWebSerialSupported(): boolean {
  return (
    isSimulatedUsbMode() ||
    capabilitiesSnapshot().portable ||
    (typeof navigator !== "undefined" && "serial" in navigator)
  );
}

/** Decode the 160-byte `SLAPRF02` configuration block from a firmware binary or flash dump. */
export function parseSlaprfConfigBlock(bytes: Uint8Array): TimerReadout | null {
  const off = findConfigBlock(bytes);
  if (off < 0) return null;
  const block = bytes.subarray(off, off + CONFIG_LEN);
  if (xor8(block.subarray(0, OFF_CRC)) !== block[OFF_CRC]) return null;
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);

  const frequenciesMHz: number[] = [];
  for (let i = 0; i < 8; i++) frequenciesMHz.push(view.getUint16(OFF_FREQS + i * 2, true));

  const dec = new TextDecoder();
  const cstr = (start: number, len: number): string => {
    const sub = block.subarray(start, start + len);
    const end = sub.indexOf(0);
    return dec.decode(end < 0 ? sub : sub.subarray(0, end));
  };
  const timerLabel = cstr(OFF_LABEL, 24);

  return {
    chip: "Seeed XIAO ESP32-C5 (RISC-V 240 MHz)",
    role: block[OFF_ROLE] === 1 ? "hub" : "spoke",
    timerLabel,
    frequenciesMHz,
    firmwareVersion: `v${block[OFF_VERSION]}.${block[OFF_VERSION + 1]}.${block[OFF_VERSION + 2]}`,
    fingerprint: view.getUint32(OFF_FINGERPRINT, true).toString(16).toUpperCase().padStart(8, "0"),
  };
}

/** Encode a raw bootloader command packet with SLIP framing (`0xC0 ... 0xC0`). */
function slipEncode(packet: Uint8Array): Uint8Array {
  const out: number[] = [SLIP_END];
  for (let i = 0; i < packet.length; i++) {
    const b = packet[i];
    if (b === SLIP_END) {
      out.push(SLIP_ESC, SLIP_ESC_END);
    } else if (b === SLIP_ESC) {
      out.push(SLIP_ESC, SLIP_ESC_ESC);
    } else {
      out.push(b);
    }
  }
  out.push(SLIP_END);
  return new Uint8Array(out);
}

/** Build an Espressif ROM bootloader request packet (8-byte header + payload). */
function buildRomCommand(op: number, data: Uint8Array, checksum = 0): Uint8Array {
  const pkt = new Uint8Array(8 + data.length);
  const view = new DataView(pkt.buffer);
  pkt[0] = 0x00; // direction = request
  pkt[1] = op;
  view.setUint16(2, data.length, true);
  view.setUint32(4, checksum >>> 0, true);
  pkt.set(data, 8);
  return slipEncode(pkt);
}

/** Compute the Espressif ROM XOR checksum (seed `0xEF`) over a flash data block. */
function romChecksum(data: Uint8Array): number {
  let chk = 0xef;
  for (let i = 0; i < data.length; i++) {
    chk ^= data[i];
  }
  return chk >>> 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Sets DTR and RTS reliably on Windows (`usbser.sys`), macOS, and Linux.
 *
 * Chromium on Windows calls `EscapeCommFunction(SETDTR/CLRDTR)` BEFORE `EscapeCommFunction(SETRTS/CLRRTS)`,
 * while Windows `usbser.sys` only transmits USB `SET_CONTROL_LINE_STATE` packets on DTR calls (caching RTS
 * changes until the next DTR call — see `esptool` `reset.py` `_setRTS`).
 * Calling `{ requestToSend: rts }` first caches the new RTS bit in `usbser.sys`, and calling
 * `{ dataTerminalReady: dtr, requestToSend: rts }` immediately after flushes the exact `(dtr, rts)` pair
 * onto the USB wire in a single transfer.
 */
export async function setUsbSerialDtrRts(port: SerialPortLike, dtr: boolean, rts: boolean): Promise<void> {
  await port.setSignals({ requestToSend: rts }).catch(() => undefined);
  await port.setSignals({ dataTerminalReady: dtr, requestToSend: rts }).catch(() => undefined);
}

async function disarmUsbJtagPortLatch(port: SerialPortLike): Promise<void> {
  await setUsbSerialDtrRts(port, true, false);
  await setUsbSerialDtrRts(port, false, false);
}

async function enterUsbJtagBootloader(port: SerialPortLike): Promise<void> {
  // Matches esptool USBJTAGSerialReset for ESP32-C5 USB-Serial-JTAG (including the (1,1) transition)
  await setUsbSerialDtrRts(port, false, false); // Idle (0,0)
  await sleep(100);
  await setUsbSerialDtrRts(port, true, false); // Set IO0 download latch (1,0)
  await sleep(100);
  await setUsbSerialDtrRts(port, true, true); // Step through (1,1) before (0,1)
  await setUsbSerialDtrRts(port, false, true); // Assert CHIP_RST while IO0=0 latched (0,1)
  await sleep(100);
  await setUsbSerialDtrRts(port, false, false); // Release CHIP_RST -> ROM download mode (0,0)
  await sleep(120);
}

async function hardResetBoard(port: SerialPortLike): Promise<void> {
  // ESP32-C5 USB-Serial-JTAG triggers CHIP_RST (USB_UART_HPSYS) on the (1,1) -> (0,1) edge (DTR 1 -> 0
  // while RTS=1). Using setUsbSerialDtrRts pre-caches RTS=1 in Windows usbser.sys BEFORE raising DTR=1,
  // stepping (0,0) -> (1,1) directly without ever emitting (1,0) (which would latch IO0=0 download mode),
  // then pulses (0,1) to assert CHIP_RST with IO0=1 (SPI_FAST_FLASH_BOOT) and releases to (0,0).
  await setUsbSerialDtrRts(port, false, false);
  await sleep(50);
  await setUsbSerialDtrRts(port, true, true);
  await sleep(60);
  await setUsbSerialDtrRts(port, false, true);
  await sleep(120);
  await setUsbSerialDtrRts(port, false, false);
  await sleep(150);
}

/**
 * Enters the ESP32-C5 ROM bootloader over USB-Serial-JTAG and disables LP_WDT (RTC WDT) + enables
 * SWD auto-feed so a factory-blank / erased ESP32-C5 stops resetting its USB port every ~3 seconds
 * on `invalid header: 0xffffffff`.
 */
export async function haltBlankEsp32C5BootLoop(
  port: SerialPortLike,
  writer: WritableStreamDefaultWriter<Uint8Array>
): Promise<void> {
  await enterUsbJtagBootloader(port);
  const syncPayload = new Uint8Array(36);
  syncPayload.set([0x07, 0x07, 0x12, 0x20], 0);
  syncPayload.fill(0x55, 4);
  const syncFrame = buildRomCommand(ESP_SYNC, syncPayload);
  for (let i = 0; i < 3; i++) {
    await writer.write(syncFrame);
    await sleep(25);
  }
  const sendReg = async (addr: number, value: number, mask = 0xffffffff) => {
    const regPayload = new Uint8Array(16);
    const regView = new DataView(regPayload.buffer);
    regView.setUint32(0, addr >>> 0, true);
    regView.setUint32(4, value >>> 0, true);
    regView.setUint32(8, mask >>> 0, true);
    regView.setUint32(12, 0, true);
    await writer.write(buildRomCommand(ESP_WRITE_REG, regPayload));
    await sleep(12);
  };
  await sendReg(0x600b1c18, 0x50d83aa1); // LP_WDT_WPROTECT_REG = WKEY (unlock)
  await sendReg(0x600b1c00, 0x00000000); // LP_WDT_CONFIG0_REG = 0 (disable RWDT)
  await sendReg(0x600b1c18, 0x00000000); // LP_WDT_WPROTECT_REG = 0 (lock)
  await sendReg(0x600b1c20, 0x50d83aa1); // LP_WDT_SWD_WPROTECT_REG = WKEY (unlock)
  await sendReg(0x600b1c1c, 1 << 18, 1 << 18); // LP_WDT_SWD_CONFIG_REG |= SWD_AUTO_FEED_EN
  await sendReg(0x600b1c20, 0x00000000); // LP_WDT_SWD_WPROTECT_REG = 0 (lock)
  await disarmUsbJtagPortLatch(port);
}

async function readChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
): Promise<Uint8Array | null> {
  let timer = 0;
  try {
    const res = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: boolean }>((resolve) => {
        timer = window.setTimeout(() => resolve({ value: undefined, done: false }), timeoutMs);
      }),
    ]);
    window.clearTimeout(timer);
    return res.value && res.value.length > 0 ? res.value : null;
  } catch {
    window.clearTimeout(timer);
    return null;
  }
}

export function parseStatusSnapshot(bytes: Uint8Array): TimerStatusSnapshot | undefined {
  const text = new TextDecoder().decode(bytes);
  for (const rawLine of text.split(/\r?\n/)) {
    const idx = rawLine.indexOf("@{");
    if (idx === -1) continue;
    try {
      const parsed = JSON.parse(rawLine.slice(idx + 1)) as TimerStatusSnapshot & { t?: string; type?: string };
      if (parsed && (parsed.t === "status" || parsed.type === "status")) {
        return parsed;
      }
    } catch {
      // ignore malformed lines
    }
  }
  return undefined;
}

export interface ConnectedPortOwner {
  ownsPort(candidate: unknown): boolean;
  readSnapshot(): Promise<TimerReadout>;
  disconnectCleanly(): Promise<void>;
  takeActivePort?(): Promise<{ port: SerialPortLike; reopen: (opts?: { expectApp?: boolean }) => Promise<void> } | null>;
}

async function openWebSerialPortWithRetry(
  port: SerialPortLike,
  actionLabel: string,
  onProgress: ProgressCallback
): Promise<void> {
  const maxAttempts = 3;
  const deadline = Date.now() + 10000;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await port.open({ baudRate: 115200, bufferSize: 16384 });
      return;
    } catch (err) {
      lastErr = err;
      await port.close().catch(() => undefined);
      if (attempt < maxAttempts) {
        const nextAttempt = attempt + 1;
        onProgress({
          stage: "connecting",
          percent: 2 + attempt,
          detail: `USB device is busy. Retrying (attempt ${nextAttempt} of ${maxAttempts})…`,
        });
        const rem = Math.max(0, deadline - Date.now());
        await sleep(Math.min(1500, rem));
        onProgress({
          stage: "connecting",
          percent: 2 + attempt,
          detail: `${actionLabel} (attempt ${nextAttempt} of ${maxAttempts})…`,
        });
      } else {
        while (Date.now() < deadline) {
          const rem = Math.max(0, deadline - Date.now());
          if (rem <= 0) break;
          await sleep(Math.min(500, rem));
          try {
            await port.open({ baudRate: 115200, bufferSize: 16384 });
            return;
          } catch (retryErr) {
            lastErr = retryErr;
            await port.close().catch(() => undefined);
          }
        }
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "Failed to open USB port."));
}

/**
 * Simulation-mode flasher: speaks the Espressif ROM bootloader protocol to a `SimulatedSerialPort`
 * so the Flasher page works the same in Demo and Simulation modes. Real boards are flashed with
 * esptool-js over WebSerial (see `esptool_flasher.ts`).
 *
 * With `keepFingerprint`, the running firmware is asked for its config (`SLAPRF?`) before the
 * board is erased; if it answers, its fingerprint is stamped into `imageBytes` so the app keeps
 * treating it as the same timer. Otherwise the image's own (new) fingerprint is used.
 */
const extraFlashCancelers = new Set<() => void>();

/** Registers a cancel hook (used by the esptool-js WebSerial flasher). Returns an unregister function. */
export function registerFlashCanceler(fn: () => void): () => void {
  extraFlashCancelers.add(fn);
  return () => {
    extraFlashCancelers.delete(fn);
  };
}

export function cancelActiveFlash(): void {
  for (const fn of [...extraFlashCancelers]) {
    try {
      fn();
    } catch {
      // ignore
    }
  }
}

export async function flashXiaoC5OverWebSerial(
  imageBytes: Uint8Array,
  label: string,
  onProgress: ProgressCallback,
  showAllPorts = false,
  keepFingerprint = false,
  existingOwner?: ConnectedPortOwner
): Promise<TimerReadout | null> {
  onProgress({
    stage: "connecting",
    percent: 2,
    detail: `Opening USB port to flash as ${label}…`,
  });

  const taken = existingOwner?.takeActivePort ? await existingOwner.takeActivePort() : null;
  if (!taken) {
    throw new Error("Connect a timer over USB first.");
  }
  const port = taken.port;

  await openWebSerialPortWithRetry(port, `Opening USB port to flash as ${label}`, onProgress);
  // Step (1,1) -> (1,0) -> (0,0) so closing the port after reading never triggers USB-Serial-JTAG reset
  await disarmUsbJtagPortLatch(port);
  let writer = port.writable?.getWriter();
  let reader = port.readable?.getReader();

  if (!writer || !reader) {
    await port.close().catch(() => undefined);
    throw new Error("Could not open USB serial streams on the selected port.");
  }

  let pumpActive = false;
  let collectRaw = true;
  const rawChunks: Uint8Array[] = [];
  const slipQueue: Uint8Array[] = [];
  const slipWaiters: Array<() => void> = [];

  const startSlipPump = (r: ReadableStreamDefaultReader<Uint8Array>) => {
    pumpActive = true;
    let inFrame = false;
    let escaped = false;
    let frame: number[] = [];
    void (async () => {
      try {
        while (pumpActive) {
          const { value, done } = await r.read();
          if (done || !value) break;
          if (collectRaw) {
            rawChunks.push(value);
          }
          for (let i = 0; i < value.length; i++) {
            const b = value[i];
            if (b === SLIP_END) {
              if (inFrame && frame.length >= 8) {
                slipQueue.push(new Uint8Array(frame));
                while (slipWaiters.length > 0) slipWaiters.shift()?.();
              }
              inFrame = true;
              escaped = false;
              frame = [];
            } else if (inFrame) {
              if (escaped) {
                escaped = false;
                if (b === SLIP_ESC_END) frame.push(SLIP_END);
                else if (b === SLIP_ESC_ESC) frame.push(SLIP_ESC);
                else frame.push(b);
              } else if (b === SLIP_ESC) {
                escaped = true;
              } else {
                frame.push(b);
              }
            }
          }
        }
      } catch {
        // stream closed or cancelled
      } finally {
        while (slipWaiters.length > 0) slipWaiters.shift()?.();
      }
    })();
  };

  const waitForRomAck = async (op: number, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (let i = 0; i < slipQueue.length; i++) {
        const pkt = slipQueue[i];
        if (pkt[0] === 0x01 && pkt[1] === op) {
          slipQueue.splice(i, 1);
          const len = pkt[2] | (pkt[3] << 8);
          if (len >= 2 && pkt.length >= 8 + 2) {
            const status = pkt[8];
            const errCode = pkt[9];
            if (status !== 0) {
              throw new Error(`ROM bootloader command 0x${op.toString(16)} failed (err 0x${errCode.toString(16)})`);
            }
          }
          return true;
        }
      }
      const rem = deadline - Date.now();
      if (rem <= 0) break;
      await new Promise<void>((resolve) => {
        const t = window.setTimeout(resolve, Math.min(120, rem));
        slipWaiters.push(() => {
          window.clearTimeout(t);
          resolve();
        });
      });
    }
    return false;
  };

  try {
    startSlipPump(reader);

    let fingerprintKept = false;
    await writer.write(new TextEncoder().encode("\nRF 0\n"));
    await sleep(60);
    if (keepFingerprint) {
      onProgress({
        stage: "reading",
        percent: 4,
        detail: "Checking board for an existing fingerprint…",
      });
      await writer.write(new TextEncoder().encode("\nLIVE 0\nSCAN STOP\nLOG 0\nSLAPRF?\n"));
      await sleep(260);
      collectRaw = false;
      let total = 0;
      for (const c of rawChunks) total += c.length;
      const rx = new Uint8Array(total);
      let off = 0;
      for (const c of rawChunks) {
        rx.set(c, off);
        off += c.length;
      }
      const existing = rx.length > 0 ? parseSlaprfConfigBlock(rx) : null;
      if (existing?.fingerprint && existing.fingerprint !== "00000000" && existing.fingerprint !== "00000001") {
        imageBytes = await withFingerprint(imageBytes, existing.fingerprint);
        fingerprintKept = true;
      }
    }
    collectRaw = false;

    onProgress({
      stage: "bootloader",
      percent: 6,
      detail: "Entering ESP32-C5 ROM bootloader…",
    });

    const syncPayload = new Uint8Array(36);
    syncPayload.set([0x07, 0x07, 0x12, 0x20], 0);
    syncPayload.fill(0x55, 4);
    const syncFrame = buildRomCommand(ESP_SYNC, syncPayload);

    const reopenPortStreams = async (): Promise<void> => {
      pumpActive = false;
      try {
        await reader?.cancel();
      } catch {
        // ignore
      }
      try {
        reader?.releaseLock();
      } catch {
        // ignore
      }
      try {
        writer?.releaseLock();
      } catch {
        // ignore
      }
      await port.close().catch(() => undefined);
      await sleep(420);
      await port.open({ baudRate: 115200, bufferSize: 16384 });
      await disarmUsbJtagPortLatch(port);
      writer = port.writable?.getWriter();
      reader = port.readable?.getReader();
      if (reader) {
        startSlipPump(reader);
      }
    };

    const trySync = async (attempts: number, timeoutMs: number): Promise<boolean> => {
      slipQueue.length = 0;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          if (!writer) await reopenPortStreams();
          await writer!.write(syncFrame);
        } catch {
          await reopenPortStreams().catch(() => undefined);
          await writer?.write(syncFrame).catch(() => undefined);
        }
        if (await waitForRomAck(ESP_SYNC, timeoutMs)) {
          await sleep(30);
          slipQueue.length = 0;
          return true;
        }
      }
      return false;
    };

    // 1. Check if the chip is already in ROM download mode (e.g. blank chip or plugged in holding BOOT)
    let synced = await trySync(2, 80);

    // 2. Enter ROM download mode via hardware USB-Serial-JTAG DTR/RTS sequence (matches `esptool --no-stub`)
    if (!synced) {
      await enterUsbJtagBootloader(port);
      await reopenPortStreams().catch(() => undefined);
      synced = await trySync(8, 150);
    }
    if (!synced) {
      await sleep(500);
      await enterUsbJtagBootloader(port);
      await reopenPortStreams().catch(() => undefined);
      synced = await trySync(6, 150);
    }

    if (!synced) {
      throw new Error("Could not sync with ESP32-C5 ROM bootloader. Hold BOOT while plugging in USB and try again.");
    }

    // Disable LP_WDT (RTC WDT) and enable SWD auto-feed on ESP32-C5 USB-Serial-JTAG.
    // When entering ROM bootloader over USB-Serial-JTAG, LP_WDT remains active (~10s timeout)
    // and would otherwise reset the chip mid-flash (~block 700 / 995).
    const writeReg = async (addr: number, value: number, mask = 0xffffffff) => {
      const regPayload = new Uint8Array(16);
      const regView = new DataView(regPayload.buffer);
      regView.setUint32(0, addr >>> 0, true);
      regView.setUint32(4, value >>> 0, true);
      regView.setUint32(8, mask >>> 0, true);
      regView.setUint32(12, 0, true);
      await writer.write(buildRomCommand(ESP_WRITE_REG, regPayload));
      await waitForRomAck(ESP_WRITE_REG, 1000);
    };
    await writeReg(0x600b1034, 0x00000000, 0x3 << 29); // LP_AON_SYS_CFG_REG: clear LP_AON_FORCE_DOWNLOAD_BOOT
    await writeReg(0x600b1c18, 0x50d83aa1); // LP_WDT_WPROTECT_REG = WKEY (unlock)
    await writeReg(0x600b1c00, 0x00000000); // LP_WDT_CONFIG0_REG = 0 (disable RWDT)
    await writeReg(0x600b1c18, 0x00000000); // LP_WDT_WPROTECT_REG = 0 (lock)
    await writeReg(0x600b1c20, 0x50d83aa1); // LP_WDT_SWD_WPROTECT_REG = WKEY (unlock)
    await writeReg(0x600b1c1c, 1 << 18, 1 << 18); // LP_WDT_SWD_CONFIG_REG |= SWD_AUTO_FEED_EN
    await writeReg(0x600b1c20, 0x00000000); // LP_WDT_SWD_WPROTECT_REG = 0 (lock)

    onProgress({
      stage: "erasing",
      percent: 10,
      detail: "Attaching 4 MB SPI flash…",
    });
    await writer.write(buildRomCommand(ESP_SPI_ATTACH, new Uint8Array(8)));
    await waitForRomAck(ESP_SPI_ATTACH, 1500);

    // Configure 4 MB SPI flash geometry (fl_id=0, total=4MB, block=64KB, sector=4KB, page=256B, mask=0xFFFF)
    const spiParams = new Uint8Array(24);
    const spiView = new DataView(spiParams.buffer);
    spiView.setUint32(0, 0, true);
    spiView.setUint32(4, 4 * 1024 * 1024, true);
    spiView.setUint32(8, 64 * 1024, true);
    spiView.setUint32(12, 4096, true);
    spiView.setUint32(16, 256, true);
    spiView.setUint32(20, 0xffff, true);
    await writer.write(buildRomCommand(ESP_SPI_SET_PARAMS, spiParams));
    await waitForRomAck(ESP_SPI_SET_PARAMS, 1500);

    // Merged images from `esptool merge_bin` have 0xFF padding before 0x2000; skip leading 0xFF sectors.
    let flashOffset = 0;
    if (imageBytes.length > 0x10000 && imageBytes[0] === 0xff && imageBytes[0x2000] === ESP_IMAGE_MAGIC) {
      flashOffset = 0x2000;
    }
    const payloadBytes = imageBytes.subarray(flashOffset);
    const numBlocks = Math.ceil(payloadBytes.length / FLASH_BLOCK_SIZE);

    onProgress({
      stage: "erasing",
      percent: 13,
      detail: `Erasing ${Math.round(payloadBytes.length / 1024)} KB of SPI flash (takes a few seconds)…`,
    });
    const beginPayload = new Uint8Array(20);
    const beginView = new DataView(beginPayload.buffer);
    beginView.setUint32(0, payloadBytes.length, true);
    beginView.setUint32(4, numBlocks, true);
    beginView.setUint32(8, FLASH_BLOCK_SIZE, true);
    beginView.setUint32(12, flashOffset, true);
    beginView.setUint32(16, 0, true);
    await writer.write(buildRomCommand(ESP_FLASH_BEGIN, beginPayload));
    if (!(await waitForRomAck(ESP_FLASH_BEGIN, 20000))) {
      throw new Error("Timed out waiting for ESP32-C5 SPI flash erase.");
    }

    const kbTotal = Math.round(payloadBytes.length / 1024);
    for (let seq = 0; seq < numBlocks; seq++) {
      const start = seq * FLASH_BLOCK_SIZE;
      const slice = payloadBytes.subarray(start, Math.min(start + FLASH_BLOCK_SIZE, payloadBytes.length));
      const paddedBlock = new Uint8Array(FLASH_BLOCK_SIZE);
      paddedBlock.fill(0xff);
      paddedBlock.set(slice, 0);

      const dataPayload = new Uint8Array(16 + FLASH_BLOCK_SIZE);
      const dataView = new DataView(dataPayload.buffer);
      dataView.setUint32(0, FLASH_BLOCK_SIZE, true);
      dataView.setUint32(4, seq, true);
      dataView.setUint32(8, 0, true);
      dataView.setUint32(12, 0, true);
      dataPayload.set(paddedBlock, 16);

      const pkt = buildRomCommand(ESP_FLASH_DATA, dataPayload, romChecksum(paddedBlock));
      let blockAcked = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        await writer.write(pkt);
        if (await waitForRomAck(ESP_FLASH_DATA, 3000)) {
          blockAcked = true;
          break;
        }
      }
      if (!blockAcked) {
        throw new Error(`Timed out writing flash block ${seq + 1} / ${numBlocks}.`);
      }

      if (seq % 4 === 0 || seq === numBlocks - 1) {
        const pct = Math.min(96, Math.round(15 + ((seq + 1) / numBlocks) * 81));
        const kbDone = Math.min(kbTotal, Math.round(((seq + 1) * FLASH_BLOCK_SIZE) / 1024));
        onProgress({
          stage: "writing",
          percent: pct,
          detail: `Writing ${label} (${kbDone} / ${kbTotal} KB)…`,
        });
      }
    }

    onProgress({
      stage: "rebooting",
      percent: 98,
      detail: "Verifying checksum & rebooting XIAO ESP32-C5…",
    });
    // Keep LP_WDT disabled across the post-flash reset: triggering an LP_WDT (RTC watchdog) reset
    // hits the Espressif USB-Serial/JTAG controller erratum that wedges the USB bulk endpoints
    // ("Write timeout" / silent port) until the board is physically power-cycled.
    await writeReg(0x600b1c18, 0x50d83aa1); // LP_WDT_WPROTECT_REG = WKEY (unlock)
    await writeReg(0x600b1c00, 0x00000000); // LP_WDT_CONFIG0_REG = 0 (keep RWDT disabled)
    await writeReg(0x600b1c18, 0x00000000); // LP_WDT_WPROTECT_REG = 0 (lock)

    // Do NOT send ESP_FLASH_END (0x04) when flashing via the ROM bootloader (matches `esptool --no-stub`
    // in `esptool/cmds.py`, which only calls `flash_finish` when `esp.IS_STUB` is true): each
    // `ESP_FLASH_DATA` block is already synchronously committed before its ROM ACK, whereas ROM
    // `ESP_FLASH_END` tears down SPI/USB state and wedges ESP32-C5 USB-Serial-JTAG on exit.
    await sleep(60);
    await hardResetBoard(port);

    onProgress({
      stage: "done",
      percent: 100,
      detail: `${label} flashed & ready!`,
    });

    const written = parseSlaprfConfigBlock(imageBytes);
    return written ? { ...written, fingerprintKept } : null;
  } finally {
    pumpActive = false;
    try {
      await reader?.cancel();
    } catch {
      // ignore
    }
    try {
      reader?.releaseLock();
    } catch {
      // ignore
    }
    try {
      writer.releaseLock();
    } catch {
      // ignore
    }
    try {
      await port.close();
    } catch {
      // ignore
    }
    if (taken) {
      await taken.reopen({ expectApp: true }).catch(() => undefined);
    }
  }
}


/**
 * Factory-resets / erases a Seeed XIAO ESP32-C5 over USB by opening the browser's USB port picker,
 * entering the ROM bootloader directly (without needing to read the chip first), attaching the
 * 4 MB SPI flash, and wiping the bootloader, partition table, NVS, and application partitions
 * (`0x0000`..`0x190000`).
 */
export async function eraseXiaoC5OverWebSerial(
  onProgress: ProgressCallback,
  showAllPorts = false,
  existingOwner?: ConnectedPortOwner
): Promise<void> {
  onProgress({
    stage: "connecting",
    percent: 4,
    detail: "Opening USB port to wipe…",
  });

  const taken = existingOwner?.takeActivePort ? await existingOwner.takeActivePort() : null;
  if (!taken) {
    throw new Error("Connect a timer over USB first.");
  }
  const port = taken.port;

  await openWebSerialPortWithRetry(port, "Opening USB port to wipe", onProgress);
  // Step (1,1) -> (1,0) -> (0,0) so closing the port after reading never triggers USB-Serial-JTAG reset
  await disarmUsbJtagPortLatch(port);
  let writer = port.writable?.getWriter();
  let reader = port.readable?.getReader();

  if (!writer || !reader) {
    await port.close().catch(() => undefined);
    throw new Error("Could not open USB serial streams on the selected port.");
  }

  let pumpActive = false;
  const slipQueue: Uint8Array[] = [];
  const slipWaiters: Array<() => void> = [];

  const startSlipPump = (r: ReadableStreamDefaultReader<Uint8Array>) => {
    pumpActive = true;
    let inFrame = false;
    let escaped = false;
    let frame: number[] = [];
    void (async () => {
      try {
        while (pumpActive) {
          const { value, done } = await r.read();
          if (done || !value) break;
          for (let i = 0; i < value.length; i++) {
            const b = value[i];
            if (b === SLIP_END) {
              if (inFrame && frame.length >= 8) {
                slipQueue.push(new Uint8Array(frame));
                while (slipWaiters.length > 0) slipWaiters.shift()?.();
              }
              inFrame = true;
              escaped = false;
              frame = [];
            } else if (inFrame) {
              if (escaped) {
                escaped = false;
                if (b === SLIP_ESC_END) frame.push(SLIP_END);
                else if (b === SLIP_ESC_ESC) frame.push(SLIP_ESC);
                else frame.push(b);
              } else if (b === SLIP_ESC) {
                escaped = true;
              } else {
                frame.push(b);
              }
            }
          }
        }
      } catch {
        // stream closed or cancelled
      } finally {
        while (slipWaiters.length > 0) slipWaiters.shift()?.();
      }
    })();
  };

  const waitForRomAck = async (op: number, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (let i = 0; i < slipQueue.length; i++) {
        const pkt = slipQueue[i];
        if (pkt[0] === 0x01 && pkt[1] === op) {
          slipQueue.splice(i, 1);
          const len = pkt[2] | (pkt[3] << 8);
          if (len >= 2 && pkt.length >= 8 + 2) {
            const status = pkt[8];
            const errCode = pkt[9];
            if (status !== 0) {
              throw new Error(`ROM bootloader command 0x${op.toString(16)} failed (err 0x${errCode.toString(16)})`);
            }
          }
          return true;
        }
      }
      const rem = deadline - Date.now();
      if (rem <= 0) break;
      await new Promise<void>((resolve) => {
        const t = window.setTimeout(resolve, Math.min(120, rem));
        slipWaiters.push(() => {
          window.clearTimeout(t);
          resolve();
        });
      });
    }
    return false;
  };

  try {
    startSlipPump(reader);

    onProgress({
      stage: "bootloader",
      percent: 10,
      detail: "Entering ESP32-C5 ROM bootloader…",
    });

    const syncPayload = new Uint8Array(36);
    syncPayload.set([0x07, 0x07, 0x12, 0x20], 0);
    syncPayload.fill(0x55, 4);
    const syncFrame = buildRomCommand(ESP_SYNC, syncPayload);

    const reopenPortStreams = async (): Promise<void> => {
      pumpActive = false;
      try {
        await reader?.cancel();
      } catch {
        // ignore
      }
      try {
        reader?.releaseLock();
      } catch {
        // ignore
      }
      try {
        writer?.releaseLock();
      } catch {
        // ignore
      }
      await port.close().catch(() => undefined);
      await sleep(420);
      await port.open({ baudRate: 115200, bufferSize: 16384 });
      await disarmUsbJtagPortLatch(port);
      writer = port.writable?.getWriter();
      reader = port.readable?.getReader();
      if (reader) {
        startSlipPump(reader);
      }
    };

    const trySync = async (attempts: number, timeoutMs: number): Promise<boolean> => {
      slipQueue.length = 0;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          if (!writer) await reopenPortStreams();
          await writer!.write(syncFrame);
        } catch {
          await reopenPortStreams().catch(() => undefined);
          await writer?.write(syncFrame).catch(() => undefined);
        }
        if (await waitForRomAck(ESP_SYNC, timeoutMs)) {
          await sleep(30);
          slipQueue.length = 0;
          return true;
        }
      }
      return false;
    };

    let synced = await trySync(2, 80);
    if (!synced) {
      await enterUsbJtagBootloader(port);
      await reopenPortStreams().catch(() => undefined);
      synced = await trySync(8, 150);
    }
    if (!synced) {
      await sleep(500);
      await enterUsbJtagBootloader(port);
      await reopenPortStreams().catch(() => undefined);
      synced = await trySync(6, 150);
    }
    if (!synced) {
      throw new Error("Could not sync with ESP32-C5 ROM bootloader. Hold BOOT while plugging in USB and try again.");
    }

    // Disable LP_WDT (RTC WDT) and enable SWD auto-feed on ESP32-C5 USB-Serial-JTAG.
    const writeReg = async (addr: number, value: number, mask = 0xffffffff) => {
      const regPayload = new Uint8Array(16);
      const regView = new DataView(regPayload.buffer);
      regView.setUint32(0, addr >>> 0, true);
      regView.setUint32(4, value >>> 0, true);
      regView.setUint32(8, mask >>> 0, true);
      regView.setUint32(12, 0, true);
      await writer.write(buildRomCommand(ESP_WRITE_REG, regPayload));
      await waitForRomAck(ESP_WRITE_REG, 1000);
    };
    await writeReg(0x600b1034, 0x00000000, 0x3 << 29); // LP_AON_SYS_CFG_REG: clear LP_AON_FORCE_DOWNLOAD_BOOT
    await writeReg(0x600b1c18, 0x50d83aa1);
    await writeReg(0x600b1c00, 0x00000000);
    await writeReg(0x600b1c18, 0x00000000);
    await writeReg(0x600b1c20, 0x50d83aa1);
    await writeReg(0x600b1c1c, 1 << 18, 1 << 18);
    await writeReg(0x600b1c20, 0x00000000);

    onProgress({
      stage: "erasing",
      percent: 18,
      detail: "Attaching 4 MB SPI flash…",
    });
    await writer.write(buildRomCommand(ESP_SPI_ATTACH, new Uint8Array(8)));
    await waitForRomAck(ESP_SPI_ATTACH, 1500);

    const spiParams = new Uint8Array(24);
    const spiView = new DataView(spiParams.buffer);
    spiView.setUint32(0, 0, true);
    spiView.setUint32(4, 4 * 1024 * 1024, true);
    spiView.setUint32(8, 64 * 1024, true);
    spiView.setUint32(12, 4096, true);
    spiView.setUint32(16, 256, true);
    spiView.setUint32(20, 0xffff, true);
    await writer.write(buildRomCommand(ESP_SPI_SET_PARAMS, spiParams));
    await waitForRomAck(ESP_SPI_SET_PARAMS, 1500);

    const regions: Array<{ offset: number; size: number; pct: number; detail: string }> = [
      {
        offset: 0x0000,
        size: 0x10000,
        pct: 35,
        detail: "Wiping bootloader, partition table & NVS (64 KB)…",
      },
      {
        offset: 0x10000,
        size: 0x80000,
        pct: 58,
        detail: "Wiping application flash (512 / 1536 KB)…",
      },
      {
        offset: 0x90000,
        size: 0x80000,
        pct: 78,
        detail: "Wiping application flash (1024 / 1536 KB)…",
      },
      {
        offset: 0x110000,
        size: 0x80000,
        pct: 95,
        detail: "Wiping application flash & config block (1536 / 1536 KB)…",
      },
    ];

    for (const reg of regions) {
      onProgress({
        stage: "erasing",
        percent: reg.pct,
        detail: reg.detail,
      });
      const beginPayload = new Uint8Array(20);
      const beginView = new DataView(beginPayload.buffer);
      beginView.setUint32(0, reg.size, true);
      beginView.setUint32(4, 0, true);
      beginView.setUint32(8, FLASH_BLOCK_SIZE, true);
      beginView.setUint32(12, reg.offset, true);
      beginView.setUint32(16, 0, true);
      await writer.write(buildRomCommand(ESP_FLASH_BEGIN, beginPayload));
      if (!(await waitForRomAck(ESP_FLASH_BEGIN, 15000))) {
        throw new Error(`Timed out erasing SPI flash region at 0x${reg.offset.toString(16)}.`);
      }
    }

    // Leave the wiped chip in quiet ROM bootloader mode with LP_WDT disabled (rather than resetting
    // into empty SPI flash, which would cause the ROM to loop on `invalid header: 0xffffffff` and
    // reset USB every ~3 seconds).
    await port.setSignals({ dataTerminalReady: true, requestToSend: false }).catch(() => undefined);
    await port.setSignals({ dataTerminalReady: false, requestToSend: false }).catch(() => undefined);

    onProgress({
      stage: "done",
      percent: 100,
      detail: "Timer wiped: chip flash erased to factory blank.",
    });
  } finally {
    pumpActive = false;
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
    try {
      writer.releaseLock();
    } catch {
      // ignore
    }
    try {
      await port.close();
    } catch {
      // ignore
    }
    if (taken) {
      await taken.reopen({ expectApp: false }).catch(() => undefined);
    }
  }
}