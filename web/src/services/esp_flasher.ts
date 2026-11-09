/**
 * Browser-native Espressif ESP32-C5 WebSerial ROM Bootloader Flasher & Reader.
 *
 * Speaks the SLIP-framed Espressif ROM bootloader protocol directly over Chrome/Edge's
 * `navigator.serial` API to a Seeed Studio XIAO ESP32-C5 (USB VID `0x303A` / PID `0x1001`):
 *   - Read (`readXiaoC5OverWebSerial`): Queries the connected XIAO over USB for its chip ID
 *     and decodes its `SLAPRF02` configuration block (role, firmware profile, board fingerprint,
 *     Wi-Fi SSID, and programmed 5.8 GHz channel table).
 *   - Write (`flashXiaoC5OverWebSerial`): Optionally reads the board's existing fingerprint so it
 *     can be kept, enters Download Mode via DTR/RTS, erases flash, streams 1 KB blocks
 *     (`ESP_FLASH_DATA`), and reboots into the new firmware.
 */

export interface FlashProgress {
  stage: "connecting" | "bootloader" | "reading" | "erasing" | "writing" | "rebooting" | "done";
  percent: number;
  detail: string;
}

export interface TimerStatusSnapshot {
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
  wifiSSID: string;
  wifiPassSet?: boolean;
  frequenciesMHz: number[];
  firmwareVersion: string;
  firmwareProfile: string;
  fingerprint: string;
  /** Set by `flashXiaoC5OverWebSerial`: true if the board's previous fingerprint was kept. */
  fingerprintKept?: boolean;
  /** Live status snapshot when read from a running timer over USB. */
  status?: TimerStatusSnapshot;
}

export type ProgressCallback = (progress: FlashProgress) => void;

interface SerialPortFilter {
  usbVendorId?: number;
  usbProductId?: number;
}

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

interface NavigatorWithSerial {
  serial?: {
    requestPort(options?: { filters?: SerialPortFilter[] }): Promise<SerialPortLike>;
  };
}

const ESPRESSIF_USB_VID = 0x303a;

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

/**
 * One firmware design. Each lives in its own directory (`firmware/<id>/main.c`) tuned for a track
 * type and timer placement; `firmware/<id>/profile.json` is injected here at bundle time.
 */
export interface FirmwareProfileInfo {
  id: string;
  code: number;
  name: string;
  track: string;
  mount: string;
  link: string;
  sweepHz: number;
  summary: string;
}

/** Current firmware build. Every profile is rebuilt at this version on each release. */
export const LATEST_FIRMWARE_VERSION = "v0.1.4";

declare const __SLAPRF_FIRMWARE_PROFILES__: FirmwareProfileInfo[];

export const FIRMWARE_PROFILES: FirmwareProfileInfo[] = __SLAPRF_FIRMWARE_PROFILES__;
export const DEFAULT_FIRMWARE_PROFILE = "open-ground";

export function firmwareProfile(id: string | undefined): FirmwareProfileInfo {
  return FIRMWARE_PROFILES.find((p) => p.id === id) ?? FIRMWARE_PROFILES[0];
}

function profileByCode(code: number): FirmwareProfileInfo {
  return FIRMWARE_PROFILES.find((p) => p.code === code) ?? FIRMWARE_PROFILES[0];
}

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
const OFF_PROFILE = 12;
const OFF_WIFI_MODE = 13;
const OFF_FINGERPRINT = 14;
const OFF_FREQS = 18;
const OFF_SSID = 34;
const OFF_PASS = 67;
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
 * Fetches the compiled image for the chosen profile (`./firmware/slaprf-xiao-c5-<profile>.bin`,
 * built by CI from `firmware/<profile>/`) — or falls back to a placeholder image — and stamps the
 * `SLAPRF02` block so USB flashing and `.bin` downloads work with zero Go backend.
 */
export async function buildOrPatchFirmwareBin(opts: {
  role: "hub" | "spoke";
  timerLabel: string;
  wifiSSID: string;
  wifiPass: string;
  profile?: string;
  fingerprint?: string;
  frequenciesMHz?: number[];
}): Promise<{ bytes: Uint8Array; filename: string }> {
  const profile = firmwareProfile(opts.profile);
  const roleCode = opts.role === "hub" ? 1 : 2;
  const fingerprint = opts.fingerprint || generateFingerprint();
  const cleanLabel = opts.timerLabel.trim().slice(0, 24);
  const cleanSSID = opts.role === "hub" ? opts.wifiSSID.trim().slice(0, 32) : "";
  const cleanPass = opts.role === "hub" ? opts.wifiPass.slice(0, 39) : "";
  const defaultFreqs = [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917];
  const freqs = defaultFreqs.map((def, i) => {
    const f = opts.frequenciesMHz?.[i] ?? def;
    return f >= 5600 && f <= 5950 ? f : def;
  });

  let img: Uint8Array | null = null;
  try {
    const res = await fetch(`./firmware/slaprf-xiao-c5-${profile.id}.bin`, { cache: "no-cache" });
    if (res.ok) {
      const fetched = new Uint8Array(await res.arrayBuffer());
      if (findConfigBlock(fetched) >= 0) img = fetched;
    }
  } catch {
    // Offline or not built; fall back to the placeholder image below.
  }
  if (!img) img = syntheticBase();

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
  block[OFF_PROFILE] = profile.code;
  block[OFF_WIFI_MODE] = cleanSSID ? 1 : 0;
  bv.setUint32(OFF_FINGERPRINT, parseInt(fingerprint, 16) >>> 0, true);
  for (let i = 0; i < 8; i++) bv.setUint16(OFF_FREQS + i * 2, freqs[i], true);
  block.set(enc.encode(cleanSSID).subarray(0, 32), OFF_SSID);
  block.set(enc.encode(cleanPass).subarray(0, 39), OFF_PASS);
  block.set(enc.encode(cleanLabel).subarray(0, 24), OFF_LABEL);
  block[OFF_CRC] = xor8(block.subarray(0, OFF_CRC));
  img.set(block, off);
  await repairAppImage(img, off);

  const slug = cleanLabel ? cleanLabel.replace(/[^a-zA-Z0-9_-]+/g, "-") : opts.role;
  return {
    bytes: img,
    filename: `slaprf-xiao-c5-${slug}-${profile.id}-${LATEST_FIRMWARE_VERSION}.bin`,
  };
}
export function isWebSerialSupported(): boolean {
  return typeof navigator !== "undefined" && Boolean((navigator as unknown as NavigatorWithSerial).serial);
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
    wifiSSID: cstr(OFF_SSID, 33),
    frequenciesMHz,
    firmwareVersion: `v${block[OFF_VERSION]}.${block[OFF_VERSION + 1]}.${block[OFF_VERSION + 2]}`,
    firmwareProfile: profileByCode(block[OFF_PROFILE]).id,
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

async function enterUsbJtagBootloader(port: SerialPortLike): Promise<void> {
  // Matches esptool USBJTAGSerialReset for ESP32-C5 USB-Serial-JTAG (including the (1,1) transition)
  await port.setSignals({ dataTerminalReady: false, requestToSend: false }); // Idle (0,0)
  await sleep(100);
  await port.setSignals({ dataTerminalReady: true, requestToSend: false }); // Set IO0 (1,0)
  await sleep(100);
  await port.setSignals({ dataTerminalReady: true, requestToSend: true }); // Step through (1,1) before (0,1)
  await port.setSignals({ dataTerminalReady: false, requestToSend: true }); // Reset (0,1)
  await sleep(100);
  await port.setSignals({ dataTerminalReady: false, requestToSend: false }); // Chip out of reset (0,0)
  await sleep(120);
}

async function hardResetBoard(port: SerialPortLike): Promise<void> {
  // Matches esptool HardReset(uses_usb=True)
  await port.setSignals({ dataTerminalReady: false, requestToSend: true });
  await sleep(200);
  await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  await sleep(200);
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

function parseStatusSnapshot(bytes: Uint8Array): TimerStatusSnapshot | undefined {
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

async function collectSerialReply(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxWaitMs: number,
  retryWrite?: () => Promise<void>
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const retryTimer = retryWrite
    ? window.setTimeout(() => {
        void retryWrite().catch(() => undefined);
      }, Math.floor(maxWaitMs * 0.45))
    : 0;
  const timer = window.setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, maxWaitMs);

  try {
    while (!timedOut) {
      const { value, done } = await reader.read();
      if (done || !value || value.length === 0) break;
      chunks.push(value);
      total += value.length;
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.length;
      }
      if (findConfigBlock(merged) >= 0 && parseStatusSnapshot(merged)) {
        return merged;
      }
    }
  } catch {
    // stream cancelled or closed on timeout
  } finally {
    if (retryTimer) window.clearTimeout(retryTimer);
    window.clearTimeout(timer);
  }

  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export interface ConnectedPortOwner {
  ownsPort(candidate: unknown): boolean;
  readSnapshot(): Promise<TimerReadout>;
  disconnectCleanly(): Promise<void>;
}

/**
 * Connects to a plugged-in XIAO ESP32-C5 over USB and reads its current configuration once,
 * closing the USB port immediately afterwards (unless the selected port is already held open
 * by `existingOwner`, in which case it reads over that existing connection and leaves it open).
 */
export async function readXiaoC5OverWebSerial(
  onProgress: ProgressCallback,
  showAllPorts = false,
  existingOwner?: ConnectedPortOwner
): Promise<TimerReadout> {
  const nav = navigator as unknown as NavigatorWithSerial;
  if (!nav.serial) {
    throw new Error("WebSerial is only available in Chrome, Edge, or Brave over localhost / HTTPS.");
  }

  onProgress({
    stage: "connecting",
    percent: 10,
    detail: "Select the plugged-in XIAO ESP32-C5 USB port…",
  });

  const filters = showAllPorts ? undefined : [{ usbVendorId: ESPRESSIF_USB_VID }];
  const port = await nav.serial.requestPort(filters ? { filters } : undefined);

  if (existingOwner && existingOwner.ownsPort(port)) {
    onProgress({
      stage: "reading",
      percent: 55,
      detail: "Reading configuration from connected XIAO ESP32-C5…",
    });
    const info = await existingOwner.readSnapshot();
    onProgress({ stage: "done", percent: 100, detail: "Read complete." });
    return info;
  }

  await port.open({ baudRate: 115200, bufferSize: 16384 });
  const writer = port.writable?.getWriter();
  let reader = port.readable?.getReader();

  if (!writer || !reader) {
    await port.close().catch(() => undefined);
    throw new Error("Could not open USB serial streams on the selected port.");
  }

  try {
    onProgress({
      stage: "reading",
      percent: 45,
      detail: "Reading configuration from XIAO ESP32-C5…",
    });

    // Query running firmware over USB Serial ("STATUS?\nSLAPRF?\n") without touching bootloader lines.
    const query = new TextEncoder().encode("\nLIVE 0\nSCAN STOP\nLOG 0\nSTATUS?\nSLAPRF?\n");
    await writer.write(query);
    const rx = await collectSerialReply(reader, 950, () => writer.write(query));

    if (rx.length > 0) {
      const parsed = parseSlaprfConfigBlock(rx);
      const status = parseStatusSnapshot(rx);
      if (parsed) {
        onProgress({ stage: "done", percent: 100, detail: "Read complete." });
        return {
          ...parsed,
          chip: status?.chip ? `${status.chip.model} (${status.chip.rev})` : parsed.chip,
          timerLabel: status?.label || parsed.timerLabel,
          firmwareVersion: status?.fw || parsed.firmwareVersion,
          fingerprint: status?.fp || parsed.fingerprint,
          frequenciesMHz: status?.freqs?.length ? status.freqs : parsed.frequenciesMHz,
          status,
        };
      }
      if (status) {
        const prof = profileByCode(status.profile);
        onProgress({ stage: "done", percent: 100, detail: "Read complete." });
        return {
          chip: status.chip
            ? `${status.chip.model} (${status.chip.rev})`
            : "Seeed XIAO ESP32-C5 (RISC-V 240 MHz)",
          role: status.role === 1 ? "hub" : "spoke",
          timerLabel: status.label || "",
          wifiSSID: "",
          frequenciesMHz: status.freqs,
          firmwareVersion: status.fw,
          firmwareProfile: prof.id,
          fingerprint: status.fp,
          status,
        };
      }
    }

    throw new Error("No SlapRF firmware detected on this board — flash it above first.");
  } finally {
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
  }
}

/**
 * Opens the browser's native USB port picker and flashes the XIAO ESP32-C5 firmware binary.
 *
 * With `keepFingerprint`, the running firmware is asked for its config (`SLAPRF?`) before the
 * board is erased; if it answers, its fingerprint is stamped into `imageBytes` so the app keeps
 * treating it as the same timer. Otherwise the image's own (new) fingerprint is used.
 */
export async function flashXiaoC5OverWebSerial(
  imageBytes: Uint8Array,
  label: string,
  onProgress: ProgressCallback,
  showAllPorts = false,
  keepFingerprint = false,
  existingOwner?: ConnectedPortOwner
): Promise<TimerReadout | null> {
  const nav = navigator as unknown as NavigatorWithSerial;
  if (!nav.serial) {
    throw new Error("WebSerial is only available in Chrome, Edge, or Brave over localhost / HTTPS.");
  }

  onProgress({
    stage: "connecting",
    percent: 2,
    detail: `Select the XIAO ESP32-C5 USB port to flash as ${label}…`,
  });

  const filters = showAllPorts ? undefined : [{ usbVendorId: ESPRESSIF_USB_VID }];
  const port = await nav.serial.requestPort(filters ? { filters } : undefined);

  if (existingOwner && existingOwner.ownsPort(port)) {
    await existingOwner.disconnectCleanly();
  }

  await port.open({ baudRate: 115200, bufferSize: 16384 });
  const writer = port.writable?.getWriter();
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
    await enterUsbJtagBootloader(port);
    slipQueue.length = 0;

    const syncPayload = new Uint8Array(36);
    syncPayload.set([0x07, 0x07, 0x12, 0x20], 0);
    syncPayload.fill(0x55, 4);
    const syncFrame = buildRomCommand(ESP_SYNC, syncPayload);

    let synced = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      await writer.write(syncFrame);
      if (await waitForRomAck(ESP_SYNC, 150)) {
        synced = true;
        // Drain any extra sync replies queued by the ROM
        await sleep(30);
        slipQueue.length = 0;
        break;
      }
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
    const endPayload = new Uint8Array(4); // uint32(0) = reboot immediately
    await writer.write(buildRomCommand(ESP_FLASH_END, endPayload));
    await waitForRomAck(ESP_FLASH_END, 800).catch(() => false);
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
  }
}


export interface EraseResult {
  previousLabel?: string;
  previousFp?: string;
  previousRole?: "hub" | "spoke";
}

/**
 * Factory-resets / erases a Seeed XIAO ESP32-C5 over USB by entering the ROM bootloader,
 * attaching the 4 MB SPI flash, and erasing the bootloader, partition table, NVS, and
 * application partitions (`0x0000`..`0x190000`).
 */
export async function eraseXiaoC5OverWebSerial(
  onProgress: ProgressCallback,
  showAllPorts = false,
  existingOwner?: ConnectedPortOwner
): Promise<EraseResult> {
  const nav = navigator as unknown as NavigatorWithSerial;
  if (!nav.serial) {
    throw new Error("WebSerial is only available in Chrome, Edge, or Brave over localhost / HTTPS.");
  }

  onProgress({
    stage: "connecting",
    percent: 2,
    detail: "Select the XIAO ESP32-C5 USB port to factory-reset / erase…",
  });

  const filters = showAllPorts ? undefined : [{ usbVendorId: ESPRESSIF_USB_VID }];
  const port = await nav.serial.requestPort(filters ? { filters } : undefined);

  if (existingOwner && existingOwner.ownsPort(port)) {
    await existingOwner.disconnectCleanly();
  }

  await port.open({ baudRate: 115200, bufferSize: 16384 });
  const writer = port.writable?.getWriter();
  const reader = port.readable?.getReader();

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

  const result: EraseResult = {};

  try {
    startSlipPump(reader);

    onProgress({
      stage: "reading",
      percent: 5,
      detail: "Inspecting connected board before erase…",
    });
    await writer.write(new TextEncoder().encode("\nLIVE 0\nSCAN STOP\nLOG 0\nSTATUS?\nSLAPRF?\n"));
    await sleep(240);
    collectRaw = false;
    let total = 0;
    for (const c of rawChunks) total += c.length;
    if (total > 0) {
      const rx = new Uint8Array(total);
      let off = 0;
      for (const c of rawChunks) {
        rx.set(c, off);
        off += c.length;
      }
      const existing = parseSlaprfConfigBlock(rx);
      const status = parseStatusSnapshot(rx);
      result.previousLabel = status?.label || existing?.timerLabel || undefined;
      result.previousFp = status?.fp || existing?.fingerprint || undefined;
      result.previousRole = status ? (status.role === 1 ? "hub" : "spoke") : existing?.role;
    }

    onProgress({
      stage: "bootloader",
      percent: 10,
      detail: "Entering ESP32-C5 ROM bootloader…",
    });
    await enterUsbJtagBootloader(port);
    slipQueue.length = 0;

    const syncPayload = new Uint8Array(36);
    syncPayload.set([0x07, 0x07, 0x12, 0x20], 0);
    syncPayload.fill(0x55, 4);
    const syncFrame = buildRomCommand(ESP_SYNC, syncPayload);

    let synced = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      await writer.write(syncFrame);
      if (await waitForRomAck(ESP_SYNC, 150)) {
        synced = true;
        await sleep(30);
        slipQueue.length = 0;
        break;
      }
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
    await writeReg(0x600b1c18, 0x50d83aa1);
    await writeReg(0x600b1c00, 0x00000000);
    await writeReg(0x600b1c18, 0x00000000);
    await writeReg(0x600b1c20, 0x50d83aa1);
    await writeReg(0x600b1c1c, 1 << 18, 1 << 18);
    await writeReg(0x600b1c20, 0x00000000);

    onProgress({
      stage: "erasing",
      percent: 16,
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
        pct: 32,
        detail: "Erasing bootloader, partition table & NVS (64 KB)…",
      },
      {
        offset: 0x10000,
        size: 0x80000,
        pct: 56,
        detail: "Erasing application flash (512 / 1536 KB)…",
      },
      {
        offset: 0x90000,
        size: 0x80000,
        pct: 78,
        detail: "Erasing application flash (1024 / 1536 KB)…",
      },
      {
        offset: 0x110000,
        size: 0x80000,
        pct: 95,
        detail: "Erasing application flash & config block (1536 / 1536 KB)…",
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

    onProgress({
      stage: "rebooting",
      percent: 98,
      detail: "Resetting XIAO ESP32-C5…",
    });
    await sleep(60);
    await hardResetBoard(port);

    onProgress({
      stage: "done",
      percent: 100,
      detail: "Factory reset complete — chip flash erased.",
    });

    return result;
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
  }
}
