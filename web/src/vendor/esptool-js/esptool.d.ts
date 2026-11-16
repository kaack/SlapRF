// Type declarations for the vendored esptool-js 0.7.1 bundle (subset used by SlapRF).
export interface IEspLoaderTerminal {
  clean(): void;
  writeLine(data: string): void;
  write(data: string): void;
}

export class Transport {
  constructor(device: unknown, tracing?: boolean, enableSlipReader?: boolean);
  connect(baud?: number): Promise<void>;
  disconnect(): Promise<void>;
}

export interface LoaderOptions {
  transport: Transport;
  baudrate: number;
  romBaudrate?: number;
  terminal?: IEspLoaderTerminal;
  debugLogging?: boolean;
}

export interface FlashOptions {
  fileArray: { data: Uint8Array; address: number }[];
  flashMode: string;
  flashFreq: string;
  flashSize: string;
  eraseAll: boolean;
  compress: boolean;
  reportProgress?: (fileIndex: number, written: number, total: number) => void;
}

export class ESPLoader {
  constructor(options: LoaderOptions);
  chip: { CHIP_NAME: string };
  main(mode?: string): Promise<string>;
  writeFlash(options: FlashOptions): Promise<void>;
  eraseFlash(): Promise<unknown>;
  after(mode?: string): Promise<void>;
}

export const ESPRESSIF_VID: number;
export const USB_JTAG_SERIAL_PID: number;
