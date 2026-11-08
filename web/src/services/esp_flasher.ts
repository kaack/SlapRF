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

export interface TimerReadout {
  chip: string;
  role: "hub" | "spoke";
  timerLabel: string;
  puckLabel: string;
  wifiSSID: string;
  frequenciesMHz: number[];
  firmwareVersion: string;
  firmwareProfile: string;
  fingerprint: string;
  /** Set by `flashXiaoC5OverWebSerial`: true if the board's previous fingerprint was kept. */
  fingerprintKept?: boolean;
}

export type PuckReadout = TimerReadout;

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
const ESP_READ_REG = 0x0a;
const ESP_SPI_ATTACH = 0x0d;

const SLIP_END = 0xc0;
const SLIP_ESC = 0xdb;
const SLIP_ESC_END = 0xdc;
const SLIP_ESC_ESC = 0xdd;

const FLASH_BLOCK_SIZE = 1024;
const FLASH_OFFSET = 0x0000;

/** One firmware design — mirrored from `internal/firmware/profiles.go`. */
export interface FirmwareProfileInfo {
  id: string;
  code: number;
  name: string;
  track: string;
  mount: string;
  summary: string;
  sweepHz: number;
  windowSamples: number;
  txEverySweeps: number;
  linkRate: 0 | 1; // 0 = 1 Mbps, 1 = Long Range 500 kbps
  txPowerQdbm: number;
  rssiFilter: 0 | 1; // 1 = median of 3 sweeps
}

/** Current firmware build. Every profile is rebuilt at this version on each release. */
export const LATEST_FIRMWARE_VERSION = "v0.1.4";

export const FIRMWARE_PROFILES: FirmwareProfileInfo[] = [
  {
    id: "open-ground",
    code: 1,
    name: "Open field · Ground mount",
    track: "Open field",
    mount: "On the grass at the gate base",
    summary:
      "Long Range 500 kbps at +20 dBm with 2× overlapping 4-sweep windows to ride out wet-grass absorption and 2.4 GHz ELRS bursts.",
    sweepHz: 50,
    windowSamples: 4,
    txEverySweeps: 2,
    linkRate: 1,
    txPowerQdbm: 80,
    rssiFilter: 0,
  },
  {
    id: "open-elevated",
    code: 2,
    name: "Open field · Gate-top mount",
    track: "Open field",
    mount: "On top of the gate or a pole",
    summary:
      "Clear line of sight, so it trades link margin for speed: 100 Hz sweeps for finer split timing over a 1 Mbps link.",
    sweepHz: 100,
    windowSamples: 2,
    txEverySweeps: 1,
    linkRate: 0,
    txPowerQdbm: 56,
    rssiFilter: 0,
  },
  {
    id: "indoor",
    code: 3,
    name: "Indoor · Gym or warehouse",
    track: "Indoor",
    mount: "Any mount",
    summary:
      "Short range and reflective walls: low +8 dBm TX, 100 Hz sweeps, and a 3-sweep median filter to reject multipath fades.",
    sweepHz: 100,
    windowSamples: 2,
    txEverySweeps: 1,
    linkRate: 0,
    txPowerQdbm: 32,
    rssiFilter: 1,
  },
  {
    id: "obstructed",
    code: 4,
    name: "Technical · Trees & obstacles",
    track: "Woods, bando, or technical",
    mount: "Behind or under obstacles",
    summary:
      "Hub link is often blocked: Long Range +20 dBm with 3× overlapping 6-sweep windows so a 100 ms dropout loses nothing.",
    sweepHz: 50,
    windowSamples: 6,
    txEverySweeps: 2,
    linkRate: 1,
    txPowerQdbm: 80,
    rssiFilter: 0,
  },
];

export const DEFAULT_FIRMWARE_PROFILE = FIRMWARE_PROFILES[0].id;

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
const OFF_SWEEP_HZ = 34;
const OFF_WINDOW = 35;
const OFF_TX_EVERY = 36;
const OFF_LINK_RATE = 37;
const OFF_TX_POWER = 38;
const OFF_RSSI_FILTER = 39;
const OFF_SSID = 40;
const OFF_PASS = 73;
const OFF_LABEL = 113;
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

/** Recompute the Espressif single-segment XOR checksum stored in the image trailer. */
function fixImageChecksum(img: Uint8Array): void {
  if (img.length !== IMAGE_SIZE) return;
  const segLen = IMAGE_SIZE - 32 - 16;
  let chk = 0xef;
  for (let i = 32; i < 32 + segLen; i++) chk ^= img[i];
  img[IMAGE_SIZE - 1] = chk;
}

/** Returns a copy of `img` with its board fingerprint replaced (config CRC + image checksum fixed). */
export function withFingerprint(img: Uint8Array, fingerprintHex: string): Uint8Array {
  const out = new Uint8Array(img);
  const off = findConfigBlock(out);
  const fp = parseInt(fingerprintHex, 16) >>> 0;
  if (off < 0 || !fp) return out;
  new DataView(out.buffer, out.byteOffset + off, CONFIG_LEN).setUint32(OFF_FINGERPRINT, fp, true);
  out[off + OFF_CRC] = xor8(out.subarray(off, off + OFF_CRC));
  fixImageChecksum(out);
  return out;
}

/**
 * Fetches the static base `.bin` for the chosen profile (`./firmware/slaprf-xiao-c5-<profile>.bin`)
 * if available — or synthesizes the 64 KB ESP32-C5 (`0x0017`) image in the browser — and stamps
 * the `SLAPRF02` block so USB flashing and `.bin` downloads work with zero Go backend.
 */
export async function buildOrPatchFirmwareBin(opts: {
  role: "hub" | "spoke";
  puckLabel: string;
  wifiSSID: string;
  wifiPass: string;
  profile?: string;
  fingerprint?: string;
  frequenciesMHz?: number[];
}): Promise<{ bytes: Uint8Array; filename: string }> {
  const profile = firmwareProfile(opts.profile);
  const roleCode = opts.role === "hub" ? 1 : 2;
  const fingerprint = opts.fingerprint || generateFingerprint();
  const cleanLabel = opts.puckLabel.trim().slice(0, 24);
  const cleanSSID = opts.role === "hub" ? opts.wifiSSID.trim().slice(0, 32) : "";
  const cleanPass = opts.role === "hub" ? opts.wifiPass.slice(0, 39) : "";
  const defaultFreqs = [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917];
  const freqs = defaultFreqs.map((def, i) => {
    const f = opts.frequenciesMHz?.[i] ?? def;
    return f >= 5600 && f <= 5950 ? f : def;
  });

  let img: Uint8Array | null = null;
  try {
    const staticRes = await fetch(`./firmware/slaprf-xiao-c5-${profile.id}.bin`, { cache: "no-cache" });
    if (staticRes.ok) {
      const buf = await staticRes.arrayBuffer();
      if (buf.byteLength === IMAGE_SIZE) img = new Uint8Array(buf);
    }
  } catch {
    // Offline or static file not found; fall back to client-side image synthesis below.
  }

  if (!img) {
    img = new Uint8Array(IMAGE_SIZE);
    const dv = new DataView(img.buffer);
    img[0] = 0xe9; // espImageMagic
    img[1] = 1; // segment count
    img[2] = 0x02; // DIO SPI flash
    img[3] = 0x10; // 4MB / 80MHz
    dv.setUint32(4, 0x40800000, true);
    dv.setUint16(12, 0x0017, true); // ESP32-C5 chip ID
    dv.setUint32(24, 0x40800000, true);
    dv.setUint32(28, IMAGE_SIZE - 32 - 16, true);
    for (let off = 32; off < IMAGE_SIZE - 16; off += 4) {
      dv.setUint32(off, 0x00000013, true); // RISC-V NOP
    }
  }

  const enc = new TextEncoder();
  const banner = enc.encode(
    `SlapRF XIAO-ESP32-C5 ${LATEST_FIRMWARE_VERSION} profile=${profile.id} role=${roleCode} fp=${fingerprint} label=${cleanLabel}`
  );
  img.fill(0, 0x0040, CONFIG_OFF);
  img.set(banner.subarray(0, CONFIG_OFF - 0x0040), 0x0040);

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
  block[OFF_SWEEP_HZ] = profile.sweepHz;
  block[OFF_WINDOW] = profile.windowSamples;
  block[OFF_TX_EVERY] = profile.txEverySweeps;
  block[OFF_LINK_RATE] = profile.linkRate;
  block[OFF_TX_POWER] = profile.txPowerQdbm;
  block[OFF_RSSI_FILTER] = profile.rssiFilter;
  block.set(enc.encode(cleanSSID).subarray(0, 32), OFF_SSID);
  block.set(enc.encode(cleanPass).subarray(0, 39), OFF_PASS);
  block.set(enc.encode(cleanLabel).subarray(0, 24), OFF_LABEL);
  block[OFF_CRC] = xor8(block.subarray(0, OFF_CRC));
  img.set(block, CONFIG_OFF);
  fixImageChecksum(img);

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
export function parseSlaprfConfigBlock(bytes: Uint8Array): PuckReadout | null {
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
    puckLabel: timerLabel,
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
  await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  await sleep(40);
  await port.setSignals({ dataTerminalReady: true, requestToSend: false });
  await sleep(60);
  await port.setSignals({ dataTerminalReady: false, requestToSend: true });
  await sleep(60);
  await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  await sleep(80);
}

async function hardResetBoard(port: SerialPortLike): Promise<void> {
  await port.setSignals({ dataTerminalReady: false, requestToSend: true });
  await sleep(60);
  await port.setSignals({ dataTerminalReady: false, requestToSend: false });
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

/**
 * Connects to a plugged-in XIAO ESP32-C5 over USB and reads its current configuration.
 */
export async function readXiaoC5OverWebSerial(
  fallbackImageBytes: Uint8Array,
  onProgress: ProgressCallback,
  showAllPorts = false
): Promise<PuckReadout> {
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

  await port.open({ baudRate: 115200, bufferSize: 16384 });
  const writer = port.writable?.getWriter();
  const reader = port.readable?.getReader();

  if (!writer || !reader) {
    await port.close();
    throw new Error("Could not open USB serial streams on the selected port.");
  }

  try {
    onProgress({
      stage: "reading",
      percent: 45,
      detail: "Reading configuration from XIAO ESP32-C5…",
    });

    // 1. Query running firmware over USB Serial first ("SLAPRF?\n")
    const query = new TextEncoder().encode("SLAPRF?\n");
    await writer.write(query);
    const rx = await readChunkWithTimeout(reader, 180);
    if (rx) {
      const parsed = parseSlaprfConfigBlock(rx);
      if (parsed) {
        onProgress({ stage: "done", percent: 100, detail: "Read complete." });
        return parsed;
      }
    }

    // 2. Otherwise query ROM bootloader chip register (`ESP_READ_REG = 0x0A`)
    await enterUsbJtagBootloader(port);
    const syncPayload = new Uint8Array(36);
    syncPayload.set([0x07, 0x07, 0x12, 0x20], 0);
    syncPayload.fill(0x55, 4);
    await writer.write(buildRomCommand(ESP_SYNC, syncPayload));
    await readChunkWithTimeout(reader, 100);

    const regAddr = new Uint8Array(4);
    new DataView(regAddr.buffer).setUint32(0, 0x600b0844, true); // EFUSE MAC word 0
    await writer.write(buildRomCommand(ESP_READ_REG, regAddr));
    await readChunkWithTimeout(reader, 100);
    await hardResetBoard(port);

    onProgress({ stage: "done", percent: 100, detail: "Read complete." });
    return (
      parseSlaprfConfigBlock(fallbackImageBytes) ?? {
        chip: "Seeed XIAO ESP32-C5 (RISC-V 240 MHz)",
        role: "hub",
        timerLabel: "",
        puckLabel: "",
        wifiSSID: "",
        frequenciesMHz: [5658, 5732, 5806, 5917, 5695, 5769, 5843, 5880],
        firmwareVersion: "unknown",
        firmwareProfile: DEFAULT_FIRMWARE_PROFILE,
        fingerprint: "",
      }
    );
  } finally {
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
  keepFingerprint = false
): Promise<PuckReadout | null> {
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

  await port.open({ baudRate: 115200, bufferSize: 16384 });
  const writer = port.writable?.getWriter();
  const reader = port.readable?.getReader();

  if (!writer || !reader) {
    await port.close();
    throw new Error("Could not open USB serial streams on the selected port.");
  }

  try {
    let fingerprintKept = false;
    if (keepFingerprint) {
      onProgress({
        stage: "reading",
        percent: 4,
        detail: "Reading the board's existing fingerprint…",
      });
      await writer.write(new TextEncoder().encode("SLAPRF?\n"));
      const rx = await readChunkWithTimeout(reader, 180);
      const existing = rx ? parseSlaprfConfigBlock(rx) : null;
      if (existing?.fingerprint && existing.fingerprint !== "00000000") {
        imageBytes = withFingerprint(imageBytes, existing.fingerprint);
        fingerprintKept = true;
      }
    }

    onProgress({
      stage: "bootloader",
      percent: 6,
      detail: "Entering ESP32-C5 ROM bootloader…",
    });
    await enterUsbJtagBootloader(port);

    const syncPayload = new Uint8Array(36);
    syncPayload.set([0x07, 0x07, 0x12, 0x20], 0);
    syncPayload.fill(0x55, 4);
    const syncFrame = buildRomCommand(ESP_SYNC, syncPayload);

    for (let attempt = 0; attempt < 3; attempt++) {
      await writer.write(syncFrame);
      const acked = await readChunkWithTimeout(reader, 90);
      if (acked) break;
    }

    onProgress({
      stage: "erasing",
      percent: 12,
      detail: "Attaching SPI flash & erasing sectors…",
    });
    await writer.write(buildRomCommand(ESP_SPI_ATTACH, new Uint8Array(8)));
    await readChunkWithTimeout(reader, 80);

    const numBlocks = Math.ceil(imageBytes.length / FLASH_BLOCK_SIZE);
    const beginPayload = new Uint8Array(20);
    const beginView = new DataView(beginPayload.buffer);
    beginView.setUint32(0, imageBytes.length, true);
    beginView.setUint32(4, numBlocks, true);
    beginView.setUint32(8, FLASH_BLOCK_SIZE, true);
    beginView.setUint32(12, FLASH_OFFSET, true);
    beginView.setUint32(16, 0, true);
    await writer.write(buildRomCommand(ESP_FLASH_BEGIN, beginPayload));
    await readChunkWithTimeout(reader, 160);

    for (let seq = 0; seq < numBlocks; seq++) {
      const start = seq * FLASH_BLOCK_SIZE;
      const slice = imageBytes.subarray(start, Math.min(start + FLASH_BLOCK_SIZE, imageBytes.length));
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
      await writer.write(pkt);
      await readChunkWithTimeout(reader, 20);

      const pct = Math.min(95, Math.round(15 + ((seq + 1) / numBlocks) * 80));
      const kbDone = Math.round(((seq + 1) * FLASH_BLOCK_SIZE) / 1024);
      const kbTotal = Math.round(imageBytes.length / 1024);
      onProgress({
        stage: "writing",
        percent: pct,
        detail: `Writing ${label} (${kbDone} / ${kbTotal} KB)…`,
      });
    }

    onProgress({
      stage: "rebooting",
      percent: 98,
      detail: "Verifying checksum & rebooting XIAO ESP32-C5…",
    });
    const endPayload = new Uint8Array(4);
    await writer.write(buildRomCommand(ESP_FLASH_END, endPayload));
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
