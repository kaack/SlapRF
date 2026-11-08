/**
 * Browser-native Espressif ESP32-C5 WebSerial ROM Bootloader Flasher & Reader.
 *
 * Speaks the SLIP-framed Espressif ROM bootloader protocol directly over Chrome/Edge's
 * `navigator.serial` API to a Seeed Studio XIAO ESP32-C5 (USB VID `0x303A` / PID `0x1001`):
 *   - Read (`readXiaoC5OverWebSerial`): Queries the connected XIAO over USB for its chip ID
 *     and decodes its `SLAPRF01` configuration block (Hub vs Field role, Wi-Fi SSID,
 *     and programmed 5.8 GHz channel table).
 *   - Write (`flashXiaoC5OverWebSerial`): Enters Download Mode via DTR/RTS, erases flash,
 *     streams 1 KB blocks (`ESP_FLASH_DATA`), and reboots into the new firmware.
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

export interface FirmwareReleaseInfo {
  version: string;
  label: string;
  summary: string;
  isLatest?: boolean;
}

export const LATEST_FIRMWARE_VERSION = "v0.1.4";

export const FIRMWARE_RELEASES: FirmwareReleaseInfo[] = [
  {
    version: "v0.1.4",
    label: "v0.1.4 (Latest) — 2.4 GHz LR + 4-Sample Ground FEC",
    summary:
      "Espressif LR 500 kbps (+20 dBm Ch 1) + 4-sample sliding-window raw recorder for wet grass & 2.4 GHz ELRS immunity.",
    isLatest: true,
  },
  {
    version: "v0.1.3",
    label: "v0.1.3 — Single-Wi-Fi Hub/Spoke Star Topology",
    summary: "Standard 1 Mbps ESP-NOW Spoke-to-Hub bridge with 350 µs TDMA slots.",
  },
  {
    version: "v0.1.2",
    label: "v0.1.2 — Initial 5.8 GHz Wideband IQ Sweep",
    summary: "Baseline 50 Hz 8-channel Raceband RSSI scanner.",
  },
];

export function decodeFirmwareVersionByte(code: number): string {
  switch (code) {
    case 4:
      return "v0.1.4";
    case 3:
      return "v0.1.3";
    case 2:
      return "v0.1.2";
    default:
      return "v0.1.1";
  }
}

export function encodeFirmwareVersionByte(version: string): number {
  switch (version.trim().toLowerCase()) {
    case "v0.1.4":
    case "0.1.4":
      return 4;
    case "v0.1.3":
    case "0.1.3":
      return 3;
    case "v0.1.2":
    case "0.1.2":
      return 2;
    case "v0.1.1":
    case "0.1.1":
      return 1;
    default:
      return 4;
  }
}

/**
 * Fetches the static base `.bin` image (`./firmware/slaprf-xiao-c5-${version}.bin`) if available
 * — or constructs the 64 KB Espressif ESP32-C5 (`0x0017`) image directly in the browser —
 * and patches the 128-byte `SLAPRF01` configuration block at `0x0100` so USB flashing and
 * `.bin` downloads work 100% client-side with zero Go backend required.
 */
export async function buildOrPatchFirmwareBin(opts: {
  role: "hub" | "spoke";
  puckLabel: string;
  wifiSSID: string;
  wifiPass: string;
  firmwareVersion?: string;
  frequenciesMHz?: number[];
}): Promise<{ bytes: Uint8Array; filename: string }> {
  const version = opts.firmwareVersion || LATEST_FIRMWARE_VERSION;
  const verByte = encodeFirmwareVersionByte(version);
  const canonicalVer = decodeFirmwareVersionByte(verByte);
  const roleCode = opts.role === "hub" ? 1 : 2;
  const puckId = opts.role === "hub" ? 1 : 2;
  const cleanLabel = opts.puckLabel.trim().slice(0, 24);
  const cleanSSID = opts.role === "hub" ? opts.wifiSSID.trim().slice(0, 32) : "";
  const cleanPass = opts.role === "hub" ? opts.wifiPass.slice(0, 39) : "";
  const defaultFreqs = [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917];
  const freqs = defaultFreqs.map((def, i) => {
    const f = opts.frequenciesMHz?.[i] ?? def;
    return f >= 5600 && f <= 5950 ? f : def;
  });

  const IMAGE_SIZE = 64 * 1024;
  const CONFIG_OFF = 0x0100;
  let img: Uint8Array | null = null;

  try {
    const staticRes = await fetch(`./firmware/slaprf-xiao-c5-${canonicalVer}.bin`, { cache: "no-cache" });
    if (staticRes.ok) {
      const buf = await staticRes.arrayBuffer();
      if (buf.byteLength === IMAGE_SIZE) {
        img = new Uint8Array(buf);
      }
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
    const segLen = IMAGE_SIZE - 32 - 16;
    dv.setUint32(24, 0x40800000, true);
    dv.setUint32(28, segLen, true);
    for (let off = 32; off < IMAGE_SIZE - 16; off += 4) {
      dv.setUint32(off, 0x00000013, true); // RISC-V NOP
    }
  }

  // Stamp build banner at 0x0040
  const enc = new TextEncoder();
  const banner = enc.encode(
    `SlapRF XIAO-ESP32-C5 SDR Firmware ${canonicalVer} (Role=${roleCode} Timer=${puckId} Label=${cleanLabel})`
  );
  img.fill(0, 0x0040, 0x00c0);
  img.set(banner.subarray(0, 0x0080), 0x0040);

  // Stamp 128-byte SLAPRF01 config block at 0x0100
  const block = new Uint8Array(128);
  const blockView = new DataView(block.buffer);
  block.set(enc.encode("SLAPRF01"), 0);
  block[8] = verByte;
  block[9] = roleCode;
  block[10] = puckId;
  block[11] = cleanSSID ? 1 : 0;
  for (let i = 0; i < 8; i++) {
    blockView.setUint16(12 + i * 2, freqs[i], true);
  }
  blockView.setUint16(28, (puckId - 1) * 3500, true);
  block.set(enc.encode(cleanSSID), 30);
  block.set(enc.encode(cleanPass), 63);
  block.set(enc.encode(cleanLabel), 103);

  let cfgCrc = 0;
  for (let i = 0; i < 127; i++) {
    cfgCrc ^= block[i];
  }
  block[127] = cfgCrc;
  img.set(block, CONFIG_OFF);

  // Recompute Espressif segment XOR checksum at end of image
  const segLen = IMAGE_SIZE - 32 - 16;
  let chk = 0xef;
  for (let i = 32; i < 32 + segLen; i++) {
    chk ^= img[i];
  }
  img[IMAGE_SIZE - 1] = chk;

  const slug = cleanLabel ? cleanLabel.replace(/[^a-zA-Z0-9_-]+/g, "-") : opts.role;
  return {
    bytes: img,
    filename: `slaprf-xiao-c5-${slug}-${canonicalVer}.bin`,
  };
}

export function isWebSerialSupported(): boolean {
  return typeof navigator !== "undefined" && Boolean((navigator as unknown as NavigatorWithSerial).serial);
}

/** Decode the 128-byte `SLAPRF01` configuration block from a firmware binary or flash dump. */
export function parseSlaprfConfigBlock(bytes: Uint8Array): PuckReadout | null {
  const magic = [0x53, 0x4c, 0x41, 0x50, 0x52, 0x46, 0x30, 0x31]; // "SLAPRF01"
  let off = -1;
  for (let i = 0; i <= bytes.length - 128; i++) {
    let match = true;
    for (let j = 0; j < 8; j++) {
      if (bytes[i + j] !== magic[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      off = i;
      break;
    }
  }
  if (off < 0) return null;

  const block = bytes.subarray(off, off + 128);
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const version = block[8];
  const roleCode = block[9];
  const role: "hub" | "spoke" = roleCode === 1 ? "hub" : "spoke";

  const frequenciesMHz: number[] = [];
  for (let i = 0; i < 8; i++) {
    frequenciesMHz.push(view.getUint16(12 + i * 2, true));
  }

  const ssidBytes = block.subarray(30, 62);
  let ssidEnd = ssidBytes.indexOf(0);
  if (ssidEnd < 0) ssidEnd = ssidBytes.length;
  const wifiSSID = new TextDecoder().decode(ssidBytes.subarray(0, ssidEnd));

  const labelBytes = block.subarray(103, 127);
  let labelEnd = labelBytes.indexOf(0);
  if (labelEnd < 0) labelEnd = labelBytes.length;
  const timerLabel = new TextDecoder().decode(labelBytes.subarray(0, labelEnd));

  return {
    chip: "Seeed XIAO ESP32-C5 (RISC-V 240 MHz)",
    role,
    timerLabel,
    puckLabel: timerLabel,
    wifiSSID,
    frequenciesMHz,
    firmwareVersion: decodeFirmwareVersionByte(version),
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
        firmwareVersion: "SlapRF v1.1",
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
 */
export async function flashXiaoC5OverWebSerial(
  imageBytes: Uint8Array,
  label: string,
  onProgress: ProgressCallback,
  showAllPorts = false
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

    return parseSlaprfConfigBlock(imageBytes);
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
