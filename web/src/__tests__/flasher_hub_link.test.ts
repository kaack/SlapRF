import {
  BLE_IMAGE_MISSING_MESSAGE,
  buildOrPatchFirmwareBin,
  FIRMWARE_BLE_IMAGE_NAME,
  FIRMWARE_IMAGE_NAME,
  firmwareImageNameFor,
  firmwareImageUrlFor,
  LATEST_FIRMWARE_VERSION,
  parseSlaprfConfigBlock,
  probeBleFirmwareImage,
  resetBleFirmwareImageProbe,
} from "../services/esp_flasher";
import { bindSimSerialStore } from "../services/sim_serial_port";
import { AppStore } from "../state/store";
import { HUB_LINK_STORAGE_KEY, TimerFlasher } from "../widgets/TimerFlasher";
import { describe, expect, flushMicrotasks, it, makeMockApiClient, makeStore, mountHtml } from "./harness";

type FetchFn = typeof window.fetch;

interface FetchLog {
  url: string;
  method: string;
}

/** Replaces window.fetch for firmware URLs only; everything else goes to the real fetch. */
function stubFirmwareFetch(opts: { usb?: Uint8Array | null; ble?: Uint8Array | null; bleContentType?: string }): {
  log: FetchLog[];
  restore: () => void;
} {
  const original: FetchFn = window.fetch;
  const log: FetchLog[] = [];
  const stub = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method || "GET").toUpperCase();
    const isBle = url.includes(FIRMWARE_BLE_IMAGE_NAME);
    const isUsb = !isBle && url.includes(FIRMWARE_IMAGE_NAME);
    if (!isBle && !isUsb) return original(input, init);
    log.push({ url, method });
    const body = isBle ? opts.ble : opts.usb;
    if (!body) return new Response("not found", { status: 404 });
    const headers = { "Content-Type": isBle && opts.bleContentType ? opts.bleContentType : "application/octet-stream" };
    return new Response(method === "HEAD" ? null : body, { status: 200, headers });
  }) as FetchFn;
  window.fetch = stub;
  return {
    log,
    restore: () => {
      window.fetch = original;
    },
  };
}

/** A patchable base image: the placeholder image the flasher builds when no compiled image is served. */
async function placeholderBase(): Promise<Uint8Array> {
  const stub = stubFirmwareFetch({});
  try {
    const built = await buildOrPatchFirmwareBin({ role: "spoke", timerLabel: "T1", fingerprint: "11111111" });
    return built.bytes;
  } finally {
    stub.restore();
  }
}

function boundSimStore(): AppStore | null {
  return (window as unknown as { __slaprfSimSerialStore?: AppStore }).__slaprfSimSerialStore ?? null;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await flushMicrotasks();
}

describe("Flasher Hub connection: USB cable vs Bluetooth hub image", () => {
  it("resolves image names and URLs: only a Hub on Bluetooth gets slaprf-xiao-c5-ble.bin", () => {
    expect(FIRMWARE_IMAGE_NAME).toBe("slaprf-xiao-c5.bin");
    expect(FIRMWARE_BLE_IMAGE_NAME).toBe("slaprf-xiao-c5-ble.bin");
    expect(firmwareImageNameFor("hub")).toBe(FIRMWARE_IMAGE_NAME);
    expect(firmwareImageNameFor("hub", "usb")).toBe(FIRMWARE_IMAGE_NAME);
    expect(firmwareImageNameFor("hub", "ble")).toBe(FIRMWARE_BLE_IMAGE_NAME);
    expect(firmwareImageNameFor("spoke", "ble")).toBe(FIRMWARE_IMAGE_NAME);
    expect(firmwareImageUrlFor("hub", "ble")).toBe("./firmware/slaprf-xiao-c5-ble.bin");
    expect(firmwareImageUrlFor("spoke", "ble")).toBe("./firmware/slaprf-xiao-c5.bin");
  });

  it("patches the BLE image with the same SLAPRF02 logic, forces Hub, and refuses to fall back when it is missing", async () => {
    const base = await placeholderBase();

    const stub = stubFirmwareFetch({ usb: base, ble: base });
    try {
      const built = await buildOrPatchFirmwareBin({ role: "hub", timerLabel: "H1", fingerprint: "CAFEF00D", hubLink: "ble" });
      expect(stub.log.map((l) => l.url)).toEqual(["./firmware/slaprf-xiao-c5-ble.bin"]);
      expect(built.filename).toBe(`slaprf-xiao-c5-ble-H1-${LATEST_FIRMWARE_VERSION}.bin`);
      const parsed = parseSlaprfConfigBlock(built.bytes)!;
      expect(parsed.role).toBe("hub");
      expect(parsed.fingerprint).toBe("CAFEF00D");
      expect(parsed.timerLabel).toBe("H1");

      // Spokes ignore the Bluetooth choice and always fetch the USB image.
      stub.log.length = 0;
      const spoke = await buildOrPatchFirmwareBin({ role: "spoke", timerLabel: "T2", hubLink: "ble" });
      expect(stub.log.map((l) => l.url)).toEqual(["./firmware/slaprf-xiao-c5.bin"]);
      expect(parseSlaprfConfigBlock(spoke.bytes)!.role).toBe("spoke");
      expect(spoke.filename).toBe(`slaprf-xiao-c5-T2-${LATEST_FIRMWARE_VERSION}.bin`);
    } finally {
      stub.restore();
    }

    const missing = stubFirmwareFetch({ usb: base, ble: null });
    try {
      await expect(
        buildOrPatchFirmwareBin({ role: "hub", timerLabel: "H1", hubLink: "ble" })
      ).rejects.toThrow(BLE_IMAGE_MISSING_MESSAGE);
    } finally {
      missing.restore();
    }
  });

  it("probes the BLE image with HEAD and treats 404 or an HTML fallback page as missing", async () => {
    const base = await placeholderBase();
    const cases: Array<{ ble: Uint8Array | null; type?: string; want: boolean }> = [
      { ble: base, want: true },
      { ble: null, want: false },
      { ble: base, type: "text/html; charset=utf-8", want: false },
    ];
    for (const c of cases) {
      const stub = stubFirmwareFetch({ ble: c.ble, bleContentType: c.type });
      try {
        resetBleFirmwareImageProbe();
        expect(await probeBleFirmwareImage()).toBe(c.want);
        expect(stub.log).toEqual([{ url: "./firmware/slaprf-xiao-c5-ble.bin", method: "HEAD" }]);
      } finally {
        stub.restore();
      }
    }
    resetBleFirmwareImageProbe();
  });

  it("shows the Hub connection choice in Step 2 (Configure timer) only for the Hub, disables Bluetooth when the image is missing", async () => {
    const prev = window.localStorage.getItem(HUB_LINK_STORAGE_KEY);
    window.localStorage.setItem(HUB_LINK_STORAGE_KEY, "ble");
    const stub = stubFirmwareFetch({ ble: null });
    resetBleFirmwareImageProbe();
    const prevBound = boundSimStore();
    const store = makeStore({ simulatorRunning: false, timers: [] });
    bindSimSerialStore(store);
    const { api } = makeMockApiClient(store);
    const root = mountHtml(`<div id="tf"></div>`);
    const flasher = new TimerFlasher(root.querySelector("#tf")!, store, api);
    try {
      await settle();
      expect(root.textContent || "").toContain("Configure timer");
      // Step 1 (Select role) does not show the Hub connection toggle.
      expect(root.querySelector("[data-hub-link-choice]")).toBeNull();

      // Advance to Step 2 (Configure timer): Hub shows fixed SlapRF version + Hub connection toggle.
      root.querySelector<HTMLElement>("[data-wizard-next]")!.click();
      const choice = root.querySelector("[data-hub-link-choice]");
      expect(choice).not.toBeNull();
      expect(choice!.textContent).toContain("Hub connection");
      const bleBtn = root.querySelector<HTMLButtonElement>('[data-hub-link="ble"]')!;
      const usbBtn = root.querySelector<HTMLButtonElement>('[data-hub-link="usb"]')!;
      expect(bleBtn.disabled).toBe(true);
      // Stored "ble" preference falls back to USB while the image is missing.
      expect(usbBtn.classList.contains("is-active")).toBe(true);
      expect(root.querySelector("[data-hub-link-help]")!.textContent).toContain("not included in this build");
      expect(flasher.selectedImageName).toBe("slaprf-xiao-c5.bin");
      expect(root.textContent || "").not.toContain("\u2014");

      // Spokes never see the choice in Step 2 either.
      root.querySelector<HTMLElement>('[data-goto-step="network"]')!.click();
      root.querySelector<HTMLElement>('[data-pick-role="spoke"]')!.click();
      root.querySelector<HTMLElement>("[data-wizard-next]")!.click();
      expect(root.querySelector("[data-hub-link-choice]")).toBeNull();
      expect(flasher.selectedImageName).toBe("slaprf-xiao-c5.bin");
      root.querySelector<HTMLElement>('[data-goto-step="network"]')!.click();
      root.querySelector<HTMLElement>('[data-pick-role="hub"]')!.click();
      root.querySelector<HTMLElement>("[data-wizard-next]")!.click();
      expect(root.querySelector("[data-hub-link-choice]")).not.toBeNull();
    } finally {
      flasher.destroy();
      if (prevBound) bindSimSerialStore(prevBound);
      stub.restore();
      resetBleFirmwareImageProbe();
      if (prev === null) window.localStorage.removeItem(HUB_LINK_STORAGE_KEY);
      else window.localStorage.setItem(HUB_LINK_STORAGE_KEY, prev);
    }
  });

  it("persists the Bluetooth choice in Step 2 and flashes / downloads the BLE image for the Hub", async () => {
    const prev = window.localStorage.getItem(HUB_LINK_STORAGE_KEY);
    window.localStorage.removeItem(HUB_LINK_STORAGE_KEY);
    const base = await placeholderBase();
    const stub = stubFirmwareFetch({ usb: base, ble: base });
    resetBleFirmwareImageProbe();
    const prevBound = boundSimStore();
    const store = makeStore({ simulatorRunning: false, timers: [] });
    bindSimSerialStore(store);
    const { api } = makeMockApiClient(store);
    const fetchArgs: unknown[][] = [];
    (api as unknown as { fetchFirmwareImage: (...a: unknown[]) => Promise<never> }).fetchFirmwareImage = (...a: unknown[]) => {
      fetchArgs.push(a);
      return Promise.reject(new Error("stop before download"));
    };
    const root = mountHtml(`<div id="tf"></div><div id="tf2"></div>`);
    const flasher = new TimerFlasher(root.querySelector("#tf")!, store, api);
    let second: TimerFlasher | null = null;
    try {
      await settle();
      // Advance to Step 2 (Configure timer) where the Hub connection toggle lives.
      root.querySelector<HTMLElement>("#tf [data-wizard-next]")!.click();
      // Default is USB cable.
      expect(root.querySelector('#tf [data-hub-link="usb"]')!.classList.contains("is-active")).toBe(true);
      const bleBtn = root.querySelector<HTMLButtonElement>('#tf [data-hub-link="ble"]')!;
      expect(bleBtn.disabled).toBe(false);
      bleBtn.click();
      expect(window.localStorage.getItem(HUB_LINK_STORAGE_KEY)).toBe("ble");
      expect(root.querySelector('#tf [data-hub-link="ble"]')!.classList.contains("is-active")).toBe(true);
      expect(root.querySelector("#tf [data-hub-link-help]")!.textContent).toContain(
        "Wireless hub: connect from the SlapRF app over Bluetooth. Single gate for now."
      );
      expect(flasher.selectedImageName).toBe("slaprf-xiao-c5-ble.bin");

      // Step through to Flash (Step 3) and hit Download .bin: the API is asked for the BLE image.
      root.querySelector<HTMLElement>("#tf [data-wizard-next]")!.click();
      root.querySelector<HTMLElement>("#tf [data-download-bin]")!.click();
      await settle();
      expect(fetchArgs.length).toBe(1);
      expect(fetchArgs[0][0]).toBe("hub");
      expect(fetchArgs[0][3]).toBe("ble");
      expect(root.querySelector("#tf")!.textContent).toContain("Bluetooth");

      // A fresh flasher remembers the choice when entering Step 2.
      second = new TimerFlasher(root.querySelector("#tf2")!, store, api);
      await settle();
      root.querySelector<HTMLElement>("#tf2 [data-wizard-next]")!.click();
      expect(root.querySelector('#tf2 [data-hub-link="ble"]')!.classList.contains("is-active")).toBe(true);
      expect(second.selectedImageName).toBe("slaprf-xiao-c5-ble.bin");

      // Switching back to USB is persisted too.
      root.querySelector<HTMLElement>('#tf2 [data-hub-link="usb"]')!.click();
      expect(window.localStorage.getItem(HUB_LINK_STORAGE_KEY)).toBe("usb");
      expect(second.selectedImageName).toBe("slaprf-xiao-c5.bin");
    } finally {
      flasher.destroy();
      if (prevBound) bindSimSerialStore(prevBound);
      second?.destroy();
      stub.restore();
      resetBleFirmwareImageProbe();
      if (prev === null) window.localStorage.removeItem(HUB_LINK_STORAGE_KEY);
      else window.localStorage.setItem(HUB_LINK_STORAGE_KEY, prev);
    }
  });
});
