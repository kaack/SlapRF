import { downloadBinaryFile, isAndroidHostApp } from "../core/android_bridge";
import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { subscribeAppTheme } from "../core/theme";
import { ApiClient } from "../services/api_client";
import { capabilitiesSnapshot } from "../services/capabilities";
import {
  FIRMWARE_POE_BRIDGE_IMAGE_NAME,
  FlashProgress,
  HubLink,
  LATEST_FIRMWARE_VERSION,
  TimerReadout,
  cancelActiveFlash,
  fetchPoeBridgeFirmwareBin,
  firmwareImageNameFor,
  flashXiaoC5OverWebSerial,
  isWebSerialSupported,
  probeBleFirmwareImage,
  probePoeBridgeFirmwareImage,
} from "../services/esp_flasher";
import {
  FLASHER_NEEDS_WEBSERIAL,
  WebSerialPort,
  acquireEspSerialPort,
  acquirePoeBridgeSerialPort,
  flashPoeBridgeWithEsptool,
  flashXiaoC5WithEsptool,
  flasherUsesWebSerial,
  hasBrowserWebSerial,
  isBackendRawWebSerialPort,
  readIdentityOverWebSerial,
} from "../services/esptool_flasher";
import { createBackendPortHandle, isSimulatedUsbMode, pickUsbPort } from "../services/sim_serial_port";
import { recordKnownTimerReadout, usbPool } from "../services/timer_console";
import { AppStore } from "../state/store";

type WizardStepId = "device" | "network" | "identity" | "flash";

/** localStorage key for the last Hub connection choice ("usb" | "ble"). */
export const HUB_LINK_STORAGE_KEY = "slaprf.flasher.hubLink";

function loadStoredHubLink(): HubLink {
  try {
    return window.localStorage.getItem(HUB_LINK_STORAGE_KEY) === "ble" ? "ble" : "usb";
  } catch {
    return "usb";
  }
}

function storeHubLink(link: HubLink): void {
  try {
    window.localStorage.setItem(HUB_LINK_STORAGE_KEY, link);
  } catch {
    // Storage unavailable (private mode); the choice just isn't remembered.
  }
}

/**
 * Interactive firmware flasher wizard for Seeed Studio XIAO ESP32-C5 Gate Timers and the
 * Waveshare ESP32-P4-WIFI6-POE-ETH PoE Bridge.
 *
 *   - Step 1 (`device`): Choose **Gate Timer** (XIAO ESP32-C5) or **PoE Bridge** (ESP32-P4).
 *   - Gate Timer flow (4 steps): `device` -> `network` (Hub vs Spoke) -> `identity` (H1 / T1-T6 + USB/BLE) -> `flash`.
 *   - PoE Bridge flow (2 steps): `device` -> `flash` (`slaprf-p4-poe-bridge.bin`).
 */
export class TimerFlasher extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private readonly onReadout?: (readout: TimerReadout) => void;
  private readonly hideTips: boolean;

  private step: WizardStepId = "device";
  private slideDir: "next" | "prev" | "none" = "none";
  private deviceKind: "timer" | "poe_bridge" = "timer";
  private timerRole: "hub" | "spoke" = "hub";
  private flashedNodes = new Set<string>();
  private timerLabel = "H1";

  private get role(): "hub" | "spoke" | "poe_bridge" {
    return this.deviceKind === "poe_bridge" ? "poe_bridge" : this.timerRole;
  }
  /** Keep the board's existing fingerprint when reflashing (vs. mint a new one). */
  private keepFingerprint = true;
  /** Hub connection choice (persisted). Spokes ignore it and always flash the USB image. */
  private hubLink: HubLink = loadStoredHubLink();
  /** Whether the Bluetooth Hub image is served (null while the probe is running). */
  private bleImageAvailable: boolean | null = null;
  /** Whether the ESP32-P4 PoE Bridge image is served (null while the probe is running). */
  private poeBridgeImageAvailable: boolean | null = null;
  private busy = false;
  private progress: FlashProgress | null = null;
  private lastSuccessMsg: string | null = null;
  private errorMsg: string | null = null;
  private showAllPorts = false;
  private lastHtml = "";

  constructor(
    el: HTMLElement,
    store: AppStore,
    api: ApiClient,
    onReadout?: (readout: TimerReadout) => void,
    options?: { hideTips?: boolean }
  ) {
    super(el);
    this.store = store;
    this.api = api;
    this.onReadout = onReadout;
    this.hideTips = !!options?.hideTips;

    this.listen(el, "click", (e) => {
      const t = e.target as HTMLElement;

      if (t.closest("[data-cancel-flash]")) {
        cancelActiveFlash();
        if (!flasherUsesWebSerial()) {
          void usbPool.mainConsole.disconnectCleanly().catch(() => undefined);
        }
        this.busy = false;
        this.progress = null;
        this.errorMsg = null;
        this.slideDir = "none";
        this.render();
        return;
      }

      if (this.busy) return;

      const gotoStepBtn = t.closest<HTMLElement>("[data-goto-step]");
      if (gotoStepBtn) {
        const targetStep = gotoStepBtn.dataset.gotoStep as WizardStepId;
        this.navigateToStep(targetStep);
        return;
      }

      const pickDevice = t.closest<HTMLElement>("[data-pick-device]");
      if (pickDevice) {
        const nextDevice: "timer" | "poe_bridge" =
          pickDevice.dataset.pickDevice === "poe_bridge" ? "poe_bridge" : "timer";
        if (nextDevice !== this.deviceKind) {
          this.deviceKind = nextDevice;
          this.timerLabel =
            nextDevice === "poe_bridge"
              ? "PoE Bridge"
              : this.timerRole === "hub"
                ? "H1"
                : this.suggestSpokeLabel();
          this.errorMsg = null;
          this.lastSuccessMsg = null;
          this.slideDir = "none";
          this.render();
        }
        return;
      }

      const pickRole = t.closest<HTMLElement>("[data-pick-role]");
      if (pickRole) {
        const rawRole = pickRole.dataset.pickRole;
        if (rawRole === "poe_bridge") {
          this.deviceKind = "poe_bridge";
          this.timerLabel = "PoE Bridge";
          this.errorMsg = null;
          this.lastSuccessMsg = null;
          this.slideDir = "none";
          this.render();
          return;
        }
        const nextRole: "hub" | "spoke" = rawRole === "spoke" ? "spoke" : "hub";
        if (this.deviceKind !== "timer" || nextRole !== this.timerRole) {
          this.deviceKind = "timer";
          this.timerRole = nextRole;
          this.timerLabel = nextRole === "hub" ? "H1" : this.suggestSpokeLabel();
          this.errorMsg = null;
          this.lastSuccessMsg = null;
          this.slideDir = "none";
          this.render();
        }
        return;
      }

      const pickHubLink = t.closest<HTMLButtonElement>("[data-hub-link]");
      if (pickHubLink) {
        if (pickHubLink.disabled) return;
        const next: HubLink = pickHubLink.dataset.hubLink === "ble" ? "ble" : "usb";
        if (next !== this.hubLink) {
          this.hubLink = next;
          storeHubLink(next);
          this.errorMsg = null;
          this.lastSuccessMsg = null;
          this.slideDir = "none";
          this.render();
        }
        return;
      }

      if (t.closest("[data-wizard-next]")) {
        this.advanceStep();
        return;
      }

      if (t.closest("[data-wizard-prev]")) {
        this.retreatStep();
        return;
      }

      if (t.closest("[data-finish-wizard]") || t.closest("[data-flash-another]")) {
        this.errorMsg = null;
        this.lastSuccessMsg = null;
        this.progress = null;
        if (this.role === "spoke") {
          this.timerLabel = this.suggestSpokeLabel();
        }
        this.goToStep("device", "prev");
        return;
      }

      if (t.closest("[data-flash-usb]")) {
        void this.flashUsb();
        return;
      }

      if (t.closest("[data-download-bin]")) {
        void this.downloadBin();
        return;
      }
    });

    this.listen(el, "keydown", (e) => {
      if (e.key === "Enter") {
        const target = e.target as HTMLElement;
        if (target.matches("[data-timer-label]")) {
          e.preventDefault();
          this.advanceStep();
        }
      }
    });

    this.listen(el, "change", (e) => {
      const target = e.target as HTMLInputElement | HTMLSelectElement;
      if (target.matches("[data-timer-label]")) {
        this.timerLabel = (target as HTMLSelectElement).value;
        this.errorMsg = null;
        return;
      }
      if (target.matches("[data-erase-before-flash]")) {
        this.keepFingerprint = !(target as HTMLInputElement).checked;
        this.slideDir = "none";
        this.render();
      }
    });

    const unsubPool = usbPool.onChange(() => {
      if (!this.busy && this.step === "flash") {
        this.slideDir = "none";
        this.render();
      }
    });
    this.onDispose(unsubPool);
    let disposed = false;
    this.onDispose(() => {
      disposed = true;
    });
    void probeBleFirmwareImage().then((ok) => {
      if (disposed) return;
      this.bleImageAvailable = ok;
      if (!this.busy) {
        this.slideDir = "none";
        this.render();
      }
    });
    void probePoeBridgeFirmwareImage().then((ok) => {
      if (disposed) return;
      this.poeBridgeImageAvailable = ok;
      if (!this.busy) {
        this.slideDir = "none";
        this.render();
      }
    });
    this.onDispose(
      subscribeAppTheme(() => {
        if (!this.busy) {
          this.slideDir = "none";
          this.render();
        }
      })
    );

    this.render();
  }

  private get orderedSteps(): Array<{ id: WizardStepId; title: string; short: string }> {
    if (this.deviceKind === "poe_bridge") {
      return [
        { id: "device", title: "Select device", short: "Device" },
        { id: "flash", title: "Flash bridge", short: "Flash" },
      ];
    }
    return [
      { id: "device", title: "Select device", short: "Device" },
      { id: "network", title: "Select role", short: "Role" },
      { id: "identity", title: "Configure timer", short: "Configure" },
      { id: "flash", title: "Flash timer", short: "Flash" },
    ];
  }

  private goToStep(next: WizardStepId, dir: "next" | "prev" | "none"): void {
    this.step = next;
    this.slideDir = dir;
    this.errorMsg = null;
    this.render();
  }

  private navigateToStep(target: WizardStepId): void {
    const steps = this.orderedSteps.map((s) => s.id);
    const curIdx = steps.indexOf(this.step);
    const targetIdx = steps.indexOf(target);
    if (targetIdx === -1 || targetIdx === curIdx) return;

    if (targetIdx > curIdx && this.deviceKind === "timer") {
      const idIdx = steps.indexOf("identity");
      if (idIdx >= 0 && curIdx <= idIdx && targetIdx > idIdx) {
        if (!this.validateIdentityStep()) return;
      }
    }

    this.goToStep(target, targetIdx > curIdx ? "next" : "prev");
  }

  private labelOptionsForRole(role: "hub" | "spoke" | "poe_bridge" = this.role): string[] {
    if (role === "poe_bridge") return ["PoE Bridge"];
    return role === "hub" ? ["H1"] : ["T1", "T2", "T3", "T4", "T5", "T6"];
  }

  private normalizeLabelForRole(raw: string, role: "hub" | "spoke" | "poe_bridge" = this.role): string {
    if (role === "poe_bridge") return "PoE Bridge";
    if (role === "hub") return "H1";
    const clean = raw.trim().toUpperCase();
    const opts = this.labelOptionsForRole("spoke");
    if (opts.includes(clean)) return clean;
    return this.suggestSpokeLabel();
  }

  private validateIdentityStep(): boolean {
    this.timerLabel = this.normalizeLabelForRole(this.timerLabel, this.role);
    return true;
  }

  private advanceStep(): void {
    if (this.step === "device") {
      if (this.deviceKind === "poe_bridge") {
        this.goToStep("flash", "next");
      } else {
        this.goToStep("network", "next");
      }
      return;
    }
    if (this.step === "network") {
      this.goToStep("identity", "next");
      return;
    }
    if (this.step === "identity") {
      if (!this.validateIdentityStep()) return;
      this.goToStep("flash", "next");
    }
  }

  private retreatStep(): void {
    if (this.step === "flash") {
      this.goToStep(this.deviceKind === "poe_bridge" ? "device" : "identity", "prev");
      return;
    }
    if (this.step === "identity") {
      this.goToStep("network", "prev");
      return;
    }
    if (this.step === "network") {
      this.goToStep("device", "prev");
    }
  }

  private get roleLabel(): string {
    return this.role === "hub" ? "Hub" : this.role === "poe_bridge" ? "PoE Bridge" : "Spoke";
  }

  /** Hub link actually used for the next flash: Bluetooth only for a Hub when the BLE image exists. */
  private get effectiveHubLink(): HubLink {
    return this.role === "hub" && this.hubLink === "ble" && this.bleImageAvailable === true ? "ble" : "usb";
  }

  /** Firmware image file the next flash / download will use. */
  public get selectedImageName(): string {
    return firmwareImageNameFor(this.role, this.effectiveHubLink);
  }

  /** Next spoke name (T1–T6) not already used by a detected timer or one flashed this session. */
  private suggestSpokeLabel(): string {
    const taken = new Set<string>();
    for (const d of this.store.detectedTimers) {
      if (!d.isHub && d.timerLabel) taken.add(d.timerLabel.trim().toUpperCase());
    }
    for (const key of this.flashedNodes) {
      if (key.startsWith("spoke:")) taken.add(key.slice(6));
    }
    for (let n = 1; n <= 6; n++) {
      if (!taken.has(`T${n}`)) return `T${n}`;
    }
    return "T1";
  }

  public applyReadout(info: TimerReadout): void {
    recordKnownTimerReadout(info);
    if (this.busy) return;
    this.deviceKind = "timer";
    this.timerRole = info.role;
    this.timerLabel = this.normalizeLabelForRole(info.timerLabel || "", info.role);
    this.slideDir = "none";
    this.render();
  }

  /** Pre-selects a board role ("hub" | "spoke" | "poe_bridge") when launched from contextual docs buttons. */
  public selectRole(nextRole: "hub" | "spoke" | "poe_bridge"): void {
    if (this.busy) return;
    if (nextRole === "poe_bridge") {
      this.deviceKind = "poe_bridge";
      this.timerLabel = "PoE Bridge";
      this.step = "flash";
    } else {
      this.deviceKind = "timer";
      this.timerRole = nextRole;
      this.timerLabel = nextRole === "hub" ? "H1" : this.suggestSpokeLabel();
      this.step = "network";
    }
    this.errorMsg = null;
    this.lastSuccessMsg = null;
    this.progress = null;
    this.slideDir = "none";
    this.render();
  }

  private async flashUsb(): Promise<void> {
    if (!this.validateIdentityStep()) {
      return;
    }
    if (this.role === "poe_bridge") {
      await this.flashPoeBridge();
      return;
    }
    const cleanLabel = this.timerLabel.trim();
    const bleHub = this.role === "hub" && this.effectiveHubLink === "ble";
    const label = `${this.role === "hub" ? (bleHub ? "Bluetooth Hub" : "Hub") : "Spoke"} "${cleanLabel}"`;
    const useEsptool = flasherUsesWebSerial();
    // Acquire the WebSerial port synchronously inside the click handler before re-rendering DOM.
    const pendingPortPromise = useEsptool ? acquireEspSerialPort() : null;

    this.busy = true;
    this.errorMsg = null;
    this.lastSuccessMsg = null;
    this.slideDir = "none";
    this.progress = {
      stage: "connecting",
      percent: 1,
      detail: "Select the XIAO ESP32-C5 USB port to flash…",
    };
    this.render();

    const onProgress = (p: FlashProgress) => {
      this.progress = p;
      this.slideDir = "none";
      if (!this.updateProgressInPlace(cleanLabel)) {
        this.render();
      }
    };

    try {
      let written: TimerReadout | null;
      let flashedPort: WebSerialPort | null = null;
      if (useEsptool && pendingPortPromise) {
        flashedPort = await pendingPortPromise;
        onProgress({ stage: "connecting", percent: 1, detail: `Building ${label} firmware image…` });
        const { bytes } = await this.api.fetchFirmwareImage(this.role, cleanLabel, undefined, this.effectiveHubLink);
        written = await flashXiaoC5WithEsptool(
          flashedPort,
          bytes,
          label,
          onProgress,
          this.keepFingerprint
        );
      } else {
        if (!isSimulatedUsbMode()) throw new Error(FLASHER_NEEDS_WEBSERIAL);
        // Simulation / Demo mode: always open the USB device picker so the user chooses which simulated
        // board (such as a newly added Unflashed board or an existing timer) to flash.
        const simPort = await pickUsbPort({
          showAllPorts: this.showAllPorts,
          transport: "usb",
        });
        onProgress({ stage: "connecting", percent: 1, detail: `Building ${label} firmware image…` });
        const { bytes } = await this.api.fetchFirmwareImage(this.role, cleanLabel, undefined, this.effectiveHubLink);
        const existingSlot = usbPool.findOwnerOfPort(simPort);
        const portOwner =
          existingSlot && existingSlot.connected
            ? {
                takeActivePort: async () => {
                  const p = await existingSlot.releasePortForWrite();
                  if (!p) return null;
                  return {
                    port: p,
                    reopen: (opts?: { expectApp?: boolean }) =>
                      existingSlot.reopenPortAfterFlash(p, opts?.expectApp ?? true),
                  };
                },
              }
            : {
                takeActivePort: async () => ({
                  port: simPort,
                  reopen: async () => undefined,
                }),
              };
        written = await flashXiaoC5OverWebSerial(
          bytes,
          label,
          onProgress,
          this.showAllPorts,
          this.keepFingerprint,
          portOwner
        );
        if (this.store.simulatorRunning) {
          await this.api.refresh();
        }
        const verifiedSim =
          existingSlot && existingSlot.connected
            ? await existingSlot.readSnapshot().catch(() => null)
            : await readIdentityOverWebSerial(simPort as unknown as WebSerialPort, 450).catch(() => null);
        if (verifiedSim && written) {
          written = {
            ...written,
            ...verifiedSim,
            fingerprintKept: written.fingerprintKept,
          };
        }
      }

      if (written) {
        recordKnownTimerReadout(written);
        this.onReadout?.(written);
      }
      if (!this.store.simulatorRunning) {
        await this.api.provisionTimer(this.role, cleanLabel, written?.fingerprint ?? "");
      }
      this.flashedNodes.add(this.role === "hub" ? "hub" : `spoke:${cleanLabel.toUpperCase()}`);

      // When flashing Hub H1 on Android or a local SlapRF Server with no Hub connected yet,
      // automatically bring the newly flashed Hub online so the user can jump straight to timing laps.
      let autoConnectedHub = false;
      if (
        this.role === "hub" &&
        !bleHub &&
        !this.store.simulatorRunning &&
        capabilitiesSnapshot().portable &&
        flashedPort &&
        isBackendRawWebSerialPort(flashedPort) &&
        !usbPool.slots.some((s) => s.connected)
      ) {
        const slot0 = usbPool.slots[0];
        if (slot0) {
          await slot0
            .connectWithPort(createBackendPortHandle(flashedPort.portName), false, 2400)
            .catch(() => undefined);
          autoConnectedHub = slot0.connected;
        }
      }

      const fpNote = written?.fingerprintKept
        ? `kept its fingerprint ${written.fingerprint}`
        : `got new fingerprint ${written?.fingerprint ?? ""}`;
      const verified = useEsptool ? (written as { verified?: TimerReadout | null } | null)?.verified : undefined;
      const verifyNote =
        verified === undefined
          ? ""
          : verified
            ? ` Read back OK: ${verified.timerLabel || cleanLabel} · ${verified.role === "hub" ? "Hub" : "Spoke"} · ${verified.firmwareVersion}.`
            : " The board did not answer the readback; unplug and replug it, then use Reader to check.";
      const readyNote = autoConnectedHub
        ? " Hub H1 is now connected over USB and ready to time laps."
        : bleHub
          ? " Connect to it from the SlapRF app over Bluetooth."
          : "";
      this.lastSuccessMsg = `${label} flashed (${fpNote}).${verifyNote}${readyNote}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/No port selected|aborted|cancelled/i.test(msg)) {
        this.errorMsg = null;
      } else {
        this.errorMsg = msg;
      }
    } finally {
      this.busy = false;
      this.progress = null;
      this.slideDir = "none";
      this.render();
    }
  }

  private updateProgressInPlace(cleanLabel: string): boolean {
    if (this.step !== "flash" || !this.progress) return false;
    const statusEl = this.el.querySelector<HTMLElement>(".flasher-progress-status");
    const pctEl = this.el.querySelector<HTMLElement>(".flasher-progress-pct");
    const fillEl = this.el.querySelector<HTMLElement>(".flasher-meter .meter-fill");
    const btnTextEl = this.el.querySelector<HTMLElement>(".flasher-btn-flash span:last-child");
    if (!statusEl || !pctEl || !fillEl) return false;
    const pct = Math.max(0, Math.min(100, Math.round(this.progress.percent)));
    statusEl.textContent = this.progress.detail;
    pctEl.textContent = `${pct}%`;
    fillEl.style.width = `${pct}%`;
    if (btnTextEl) {
      btnTextEl.textContent = `Flashing ${cleanLabel}… (${pct}%)`;
    }
    return true;
  }

  private async flashPoeBridge(): Promise<void> {
    const useEsptool = flasherUsesWebSerial();
    if (!useEsptool && !isSimulatedUsbMode()) {
      this.errorMsg = FLASHER_NEEDS_WEBSERIAL;
      this.render();
      return;
    }
    const pendingPortPromise = useEsptool ? acquirePoeBridgeSerialPort() : null;

    this.busy = true;
    this.errorMsg = null;
    this.lastSuccessMsg = null;
    this.slideDir = "none";
    this.progress = {
      stage: "connecting",
      percent: 1,
      detail: "Select the Waveshare ESP32-P4 USB-C port (CH343) to flash…",
    };
    this.render();

    const onProgress = (p: FlashProgress) => {
      this.progress = p;
      this.slideDir = "none";
      if (!this.updateProgressInPlace("PoE Bridge")) {
        this.render();
      }
    };

    try {
      const { bytes } = await fetchPoeBridgeFirmwareBin();
      if (useEsptool && pendingPortPromise) {
        const port = await pendingPortPromise;
        const verified = await flashPoeBridgeWithEsptool(port, bytes, onProgress);
        this.flashedNodes.add("poe_bridge");
        const ipPart = verified?.ip && verified.ip !== "0.0.0.0" ? ` · IP ${verified.ip}:5480` : "";
        const usbPart = verified?.usbConnected ? ` · USB-A attached (${verified.usbVid}:${verified.usbPid})` : "";
        this.lastSuccessMsg = verified
          ? `PoE Bridge flashed (${verified.board} · ${verified.fw}${ipPart}${usbPart}). Connect over Ethernet on Network → SlapRF (Network).`
          : "PoE Bridge flashed. Plug your Hub into USB-A and Ethernet into PoE, then connect on Network → SlapRF (Network).";
      } else {
        this.flashedNodes.add("poe_bridge");
        this.lastSuccessMsg = "Simulated PoE Bridge ready on 192.168.1.110:5480.";
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/No port selected|aborted|cancelled/i.test(msg)) {
        this.errorMsg = null;
      } else {
        this.errorMsg = msg;
      }
    } finally {
      this.busy = false;
      this.progress = null;
      this.slideDir = "none";
      this.render();
    }
  }

  private async downloadBin(): Promise<void> {
    if (!this.validateIdentityStep()) {
      return;
    }
    try {
      if (this.role === "poe_bridge") {
        const { bytes, filename } = await fetchPoeBridgeFirmwareBin();
        downloadBinaryFile(filename, "application/octet-stream", bytes);
        return;
      }
      const cleanLabel = this.timerLabel.trim();
      const { bytes, filename } = await this.api.fetchFirmwareImage(this.role, cleanLabel, undefined, this.effectiveHubLink);
      downloadBinaryFile(filename, "application/octet-stream", bytes);
    } catch (err) {
      this.errorMsg = err instanceof Error ? err.message : String(err);
      this.slideDir = "none";
      this.render();
    }
  }

  private renderStepper(): string {
    const steps = this.orderedSteps;
    const currentIndex = steps.findIndex((s) => s.id === this.step);

    return `
      <div class="flasher-wizard-stepper" role="tablist" aria-label="Firmware flasher steps">
        ${steps
          .map((s, idx) => {
            const isCurrent = idx === currentIndex;
            const isDone = idx < currentIndex;
            const stateCls = isCurrent ? "is-current" : isDone ? "is-done" : "is-upcoming";
            return `
              <button
                type="button"
                class="flasher-step-pill ${stateCls}"
                data-goto-step="${s.id}"
                ${this.busy ? "disabled" : ""}
                aria-current="${isCurrent ? "step" : "false"}"
              >
                <span class="flasher-step-circle">${isDone ? "✓" : idx + 1}</span>
                <span class="flasher-step-label-full">${esc(s.title)}</span>
                <span class="flasher-step-label-short">${esc(s.short)}</span>
              </button>`;
          })
          .join(`<span class="flasher-step-divider" aria-hidden="true"></span>`)}
      </div>`;
  }

  /**
   * Step 1: Device picker using spacious 2-column pictorial cards.
   * Choose **Gate Timer** (XIAO ESP32-C5) or **PoE Bridge** (Waveshare ESP32-P4-WIFI6-POE-ETH).
   */
  private renderStepDevice(): string {
    const isTimer = this.deviceKind === "timer";
    const isBridge = this.deviceKind === "poe_bridge";
    const isAndroid = isAndroidHostApp();
    const bridgeFlashed = this.flashedNodes.has("poe_bridge");
    const flashedTimers = [...this.flashedNodes].filter((k) => k === "hub" || k.startsWith("spoke:")).length;
    const totalSteps = this.orderedSteps.length;

    return `
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <div class="flasher-wizard-head">
            <h3 class="flasher-pane-title">What are you flashing?</h3>
            <span class="note flasher-step-count">Step 1 of ${totalSteps}</span>
          </div>
          <p>Select the board connected over USB-C. Flash <strong>Gate Timers</strong> for 5.8 GHz race timing, or flash an optional <strong>PoE Bridge</strong> to power and connect Hub H1 over a single Ethernet cable.</p>
        </div>

        <div class="flasher-pictorial-grid" role="radiogroup" aria-label="Target device">
          <button
            type="button"
            role="radio"
            aria-checked="${isTimer}"
            class="flasher-pictorial-card ${isTimer ? "is-active" : ""}"
            data-pick-device="timer"
            ${this.busy ? "disabled" : ""}
          >
            <div class="flasher-pictorial-head">
              <span class="flasher-pictorial-title">Gate Timer</span>
              <span class="badge ${isTimer ? "tone-good" : ""}">${
                flashedTimers > 0 ? `✓ ${flashedTimers} flashed` : "XIAO ESP32-C5"
              }</span>
            </div>
            <div class="flasher-pictorial-art">
              ${this.renderPictorialDeviceTimer()}
            </div>
            <p class="flasher-pictorial-desc">
              Seeed Studio XIAO ESP32-C5 5.8 GHz timer board. Next step picks Hub (H1) or Spoke (T1-T6).
            </p>
          </button>

          <button
            type="button"
            role="radio"
            aria-checked="${isBridge}"
            class="flasher-pictorial-card ${isBridge ? "is-active" : ""}"
            data-pick-device="poe_bridge"
            ${this.busy ? "disabled" : ""}
          >
            <div class="flasher-pictorial-head">
              <span class="flasher-pictorial-title">PoE Bridge</span>
              <span class="badge ${isBridge ? "tone-good" : ""}">${bridgeFlashed ? "✓ Flashed" : "ESP32-P4 · PoE"}</span>
            </div>
            <div class="flasher-pictorial-art">
              ${this.renderPictorialRolePoeBridge()}
            </div>
            <p class="flasher-pictorial-desc">
              Waveshare ESP32-P4-WIFI6-POE-ETH board. Powers Hub H1 on USB-A and streams over PoE Ethernet.
            </p>
          </button>
        </div>

        ${
          this.hideTips
            ? ""
            : `<div class="flasher-tips" role="note" aria-label="Tips for a reliable flash">
          <div class="flasher-tips-head">${icons.info(14)}<span>Tips for a reliable flash</span></div>
          <ul class="flasher-tips-list">
            <li><strong>Use a good USB-C data cable.</strong> A known, good-quality USB-C data cable works much better than a cheap or charge-only cable.</li>
            <li><strong>${isAndroid ? "Plug straight into your phone's USB-C port." : "Plug straight into the computer."}</strong> Avoid unpowered USB hubs or extension cables while you flash.</li>
            <li><strong>Flash one board at a time</strong>${hasBrowserWebSerial() ? " in Chrome, Edge, or Opera" : ""}. If a board stops responding, unplug it (and its battery) for a few seconds, then try again.</li>
          </ul>
        </div>`
        }

        <div class="flasher-wizard-nav is-end">
          <button type="button" class="btn" data-wizard-next="1" ${this.busy ? "disabled" : ""}>
            <span>Next</span>
            ${icons.chevronRight(15)}
          </button>
        </div>
      </div>`;
  }

  /**
   * Step 2 (Gate Timer): Role picker using 2-column pictorial cards.
   * Pick **Hub** (one per network) or **Spoke** (up to 6 track timers).
   */
  private renderStepNetwork(): string {
    const isHub = this.timerRole === "hub";
    const isSpoke = this.timerRole === "spoke";
    const isAndroid = isAndroidHostApp();
    const hostNoun = isAndroid ? "this phone" : "this computer";
    const hubFlashed = this.flashedNodes.has("hub");
    const flashedSpokes = [...this.flashedNodes].filter((k) => k.startsWith("spoke:")).length;

    return `
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <div class="flasher-wizard-head">
            <h3 class="flasher-pane-title">What role will this timer play?</h3>
            <span class="note flasher-step-count">Step 2 of 4</span>
          </div>
          <p>One <strong>Hub</strong> connects to ${hostNoun} over USB-C, Bluetooth, or a PoE Bridge, and collects passes from up to 6 <strong>Spokes</strong> on the course.</p>
        </div>

        <div class="flasher-pictorial-grid" role="radiogroup" aria-label="Timer role">
          <button
            type="button"
            role="radio"
            aria-checked="${isHub}"
            class="flasher-pictorial-card ${isHub ? "is-active" : ""}"
            data-pick-role="hub"
            ${this.busy ? "disabled" : ""}
          >
            <div class="flasher-pictorial-head">
              <span class="flasher-pictorial-title">Hub</span>
              <span class="badge ${isHub ? "tone-good" : ""}">${hubFlashed ? "✓ Flashed" : "H1 · 1 per course"}</span>
            </div>
            <div class="flasher-pictorial-art">
              ${this.renderPictorialRoleHub()}
            </div>
            <p class="flasher-pictorial-desc">
              Start / Finish gate timer connected to ${hostNoun} (or PoE Bridge). Collects every Spoke's passes over ESP-NOW.
            </p>
          </button>

          <button
            type="button"
            role="radio"
            aria-checked="${isSpoke}"
            class="flasher-pictorial-card ${isSpoke ? "is-active" : ""}"
            data-pick-role="spoke"
            ${this.busy ? "disabled" : ""}
          >
            <div class="flasher-pictorial-head">
              <span class="flasher-pictorial-title">Spoke</span>
              <span class="badge ${isSpoke ? "tone-good" : ""}">${
                flashedSpokes > 0 ? `✓ ${flashedSpokes} flashed` : "Up to 6 · Track timers"
              }</span>
            </div>
            <div class="flasher-pictorial-art">
              ${this.renderPictorialRoleSpoke()}
            </div>
            <p class="flasher-pictorial-desc">
              Placed around the course to time split gates. Sends its passes wirelessly to Hub H1 over ESP-NOW.
            </p>
          </button>
        </div>

        <div class="flasher-wizard-nav">
          <button type="button" class="btn" data-wizard-prev="1" ${this.busy ? "disabled" : ""}>
            ${icons.chevronLeft(15)}
            <span>Back</span>
          </button>
          <button type="button" class="btn" data-wizard-next="1" ${this.busy ? "disabled" : ""}>
            <span>Next</span>
            ${icons.chevronRight(15)}
          </button>
        </div>
      </div>`;
  }

  /**
   * Hub connection choice (Hub role only): USB cable (default image) or Bluetooth (BLE Hub image).
   * The Bluetooth option is disabled with a note when slaprf-xiao-c5-ble.bin isn't served.
   */
  private renderHubLinkChoice(): string {
    const bleMissing = this.bleImageAvailable === false;
    const checking = this.bleImageAvailable === null;
    const link = this.effectiveHubLink;
    const helper = bleMissing
      ? "Bluetooth hub firmware is not included in this build yet. Use the USB cable for now."
      : checking
        ? "Checking for the Bluetooth hub firmware image."
        : link === "ble"
          ? "Wireless hub: connect from the SlapRF app over Bluetooth (solo 1-gate or with up to 6 Spokes)."
          : "Wired hub: plug the Hub into this device with a USB-C cable.";
    const bleDisabled = this.busy || this.bleImageAvailable !== true;
    return `
        <div class="flasher-hub-link" data-hub-link-choice="1">
          <div class="flasher-hub-link-text">
            <strong id="flasher-hub-link-label">Hub connection</strong>
            <span data-hub-link-help="1">${esc(helper)}</span>
          </div>
          <div class="segmented" role="radiogroup" aria-labelledby="flasher-hub-link-label">
            <button
              type="button"
              role="radio"
              aria-checked="${link === "usb"}"
              class="${link === "usb" ? "is-active" : ""}"
              data-hub-link="usb"
              ${this.busy ? "disabled" : ""}
            >USB cable</button>
            <button
              type="button"
              role="radio"
              aria-checked="${link === "ble"}"
              class="${link === "ble" ? "is-active" : ""}"
              data-hub-link="ble"
              ${bleDisabled ? "disabled" : ""}
              ${bleMissing ? 'title="Bluetooth hub firmware (slaprf-xiao-c5-ble.bin) is not available in this build"' : ""}
            >Bluetooth</button>
          </div>
        </div>`;
  }

  /** Pictorial for the Gate Timer device card: Spoke (T1) ──▶ Hub (H1) + 5.8 GHz RSSI waves. */
  private renderPictorialDeviceTimer(): string {
    return `
      <svg class="flasher-pic-svg" viewBox="0 0 280 68" fill="none" aria-hidden="true">
        <defs>
          <marker id="pic-arrow-dev-timer" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="currentColor" />
          </marker>
        </defs>
        <line x1="92" y1="38" x2="164" y2="38" class="flasher-pic-link" marker-end="url(#pic-arrow-dev-timer)" />
        <text x="128" y="30" text-anchor="middle" class="flasher-pic-link-label">5.8 GHz</text>
        <g transform="translate(68, 38)">
          <circle r="20" class="flasher-pic-node is-dim-node" />
          <text y="3.5" text-anchor="middle" class="flasher-pic-node-title is-dim">T1</text>
        </g>
        <g transform="translate(192, 38)">
          <circle r="22" class="flasher-pic-node is-hub-node is-host-node" />
          <text y="3.5" text-anchor="middle" class="flasher-pic-node-title">H1</text>
        </g>
        <path d="M 183 11 Q 192 4 201 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.65" />
        <path d="M 178 7 Q 192 -2 206 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.38" />
      </svg>`;
  }

  /** Pictorial for the Hub role: Spokes ──▶ Hub ◀── Laptop (USB-C). */
  private renderPictorialRoleHub(): string {
    return `
      <svg class="flasher-pic-svg" viewBox="0 0 280 68" fill="none" aria-hidden="true">
        <defs>
          <marker id="pic-arrow-role-hub" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="currentColor" />
          </marker>
        </defs>

        <line x1="52" y1="14" x2="114" y2="30" class="flasher-pic-link is-dim" marker-end="url(#pic-arrow-role-hub)" />
        <line x1="52" y1="34" x2="114" y2="34" class="flasher-pic-link is-dim" marker-end="url(#pic-arrow-role-hub)" />
        <line x1="52" y1="54" x2="114" y2="38" class="flasher-pic-link is-dim" marker-end="url(#pic-arrow-role-hub)" />
        <line x1="214" y1="34" x2="166" y2="34" class="flasher-pic-link" marker-end="url(#pic-arrow-role-hub)" />

        <g transform="translate(40, 14)"><circle r="9" class="flasher-pic-node is-dim-node" /></g>
        <g transform="translate(40, 34)"><circle r="9" class="flasher-pic-node is-dim-node" /></g>
        <g transform="translate(40, 54)"><circle r="9" class="flasher-pic-node is-dim-node" /></g>

        <g transform="translate(140, 34)">
          <circle r="22" class="flasher-pic-node is-hub-node is-host-node" />
          <text y="3.5" text-anchor="middle" class="flasher-pic-node-title">Hub</text>
        </g>

        <g transform="translate(238, 34)">
          <rect x="-22" y="-20" width="44" height="40" rx="8" class="flasher-pic-node" />
          <rect x="-11" y="-8" width="22" height="13" rx="1.5" stroke="currentColor" stroke-width="1.5" />
          <path d="M-15 8 H15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </g>
      </svg>`;
  }

  /** Pictorial for the Spoke role: Spoke ──ESP-NOW──▶ Hub. */
  private renderPictorialRoleSpoke(): string {
    return `
      <svg class="flasher-pic-svg" viewBox="0 0 280 68" fill="none" aria-hidden="true">
        <defs>
          <marker id="pic-arrow-role-spoke" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="currentColor" />
          </marker>
        </defs>

        <line x1="96" y1="34" x2="182" y2="34" class="flasher-pic-link" marker-end="url(#pic-arrow-role-spoke)" />
        <text x="139" y="26" text-anchor="middle" class="flasher-pic-link-label">ESP-NOW LR</text>

        <g transform="translate(72, 34)">
          <circle r="20" class="flasher-pic-node is-host-node" />
          <text y="3.5" text-anchor="middle" class="flasher-pic-node-title">Spoke</text>
        </g>

        <g transform="translate(208, 34)">
          <circle r="20" class="flasher-pic-node is-dim-node" />
          <text y="3.5" text-anchor="middle" class="flasher-pic-node-title is-dim">Hub</text>
        </g>
      </svg>`;
  }

  /** Pictorial for the PoE Bridge role: USB Hub ──USB-A──▶ P4 Bridge ──PoE──▶ Laptop. */
  private renderPictorialRolePoeBridge(): string {
    return `
      <svg class="flasher-pic-svg" viewBox="0 0 280 68" fill="none" aria-hidden="true">
        <defs>
          <marker id="pic-arrow-role-bridge" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="currentColor" />
          </marker>
        </defs>
        <line x1="68" y1="34" x2="112" y2="34" class="flasher-pic-link is-dim" marker-end="url(#pic-arrow-role-bridge)" />
        <line x1="168" y1="34" x2="212" y2="34" class="flasher-pic-link" marker-end="url(#pic-arrow-role-bridge)" />
        <text x="190" y="25" text-anchor="middle" class="flasher-pic-link-label">PoE</text>
        <g transform="translate(46, 34)">
          <circle r="19" class="flasher-pic-node is-dim-node" />
          <text y="3.5" text-anchor="middle" class="flasher-pic-node-title is-dim">Hub</text>
        </g>
        <g transform="translate(140, 34)">
          <rect x="-24" y="-19" width="48" height="38" rx="8" class="flasher-pic-node is-host-node" />
          <text y="3.5" text-anchor="middle" class="flasher-pic-node-title">P4</text>
        </g>
        <g transform="translate(238, 34)">
          <rect x="-22" y="-20" width="44" height="40" rx="8" class="flasher-pic-node" />
          <rect x="-11" y="-8" width="22" height="13" rx="1.5" stroke="currentColor" stroke-width="1.5" />
          <path d="M-15 8 H15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </g>
      </svg>`;
  }

  private renderStepIdentity(): string {
    const isHub = this.timerRole === "hub";
    const options = this.labelOptionsForRole(this.timerRole);
    const currentLabel = this.normalizeLabelForRole(this.timerLabel, this.timerRole);
    this.timerLabel = currentLabel;

    return `
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <div class="flasher-wizard-head">
            <h3 class="flasher-pane-title">${isHub ? "Configure Hub" : "Configure Spoke"}</h3>
            <span class="note flasher-step-count">Step 3 of 4</span>
          </div>
          <p>${
            isHub
              ? "The Hub is always named <strong>H1</strong>. Choose whether this Hub will connect over a USB cable or Bluetooth."
              : "Pick a timer label (<strong>T1</strong>-<strong>T6</strong>) shown across Track, Network, and Debug."
          }</p>
        </div>

        <div class="flasher-wifi-inputs flasher-two-col">
          <div class="flasher-field">
            <label class="flasher-field-label">Timer name</label>
            ${
              isHub
                ? `<div class="input input-readonly mono" aria-label="Timer name" aria-readonly="true">
                    <span>H1</span>
                    <span class="badge">Fixed</span>
                  </div>
                  <span class="flasher-field-help">Read-only · The course Hub is always H1.</span>`
                : `<select
                    class="input mono"
                    data-timer-label="1"
                    aria-label="Timer name"
                    ${this.busy ? "disabled" : ""}
                  >
                    ${options
                      .map(
                        (opt) =>
                          `<option value="${esc(opt)}" ${opt === currentLabel ? "selected" : ""}>${esc(opt)}</option>`
                      )
                      .join("")}
                  </select>
                  <span class="flasher-field-help">Pick T1-T6 for each Spoke timer on your course.</span>`
            }
          </div>

          <div class="flasher-field">
            <label class="flasher-field-label">Firmware</label>
            <div class="input input-readonly mono" aria-label="Firmware version" aria-readonly="true">
              <span>SlapRF ${LATEST_FIRMWARE_VERSION}</span>
              <span class="badge">Bundled</span>
            </div>
            <span class="flasher-field-help">Read-only · Official firmware for Seeed XIAO ESP32-C5.</span>
          </div>
        </div>

        ${isHub ? this.renderHubLinkChoice() : ""}

        <div class="flasher-wizard-nav">
          <button type="button" class="btn" data-wizard-prev="1" ${this.busy ? "disabled" : ""}>
            ${icons.chevronLeft(15)}
            <span>Back</span>
          </button>
          <button type="button" class="btn" data-wizard-next="1" ${this.busy ? "disabled" : ""}>
            <span>Next</span>
            ${icons.chevronRight(15)}
          </button>
        </div>
      </div>`;
  }

  private renderStepFlash(webSerialOk: boolean): string {
    const isBridge = this.role === "poe_bridge";
    const bridgeMissing = isBridge && this.poeBridgeImageAvailable === false;
    const isHub = this.role === "hub";
    const isAndroid = isAndroidHostApp();
    const cleanLabel = isBridge ? "PoE Bridge" : this.timerLabel.trim() || (isHub ? "H1" : this.suggestSpokeLabel());
    const bleHub = isHub && this.effectiveHubLink === "ble";
    const linkSummary = isBridge
      ? "USB-A ↔ PoE Ethernet (:5480)"
      : isHub
        ? bleHub
          ? isAndroid ? "Bluetooth → Phone" : "Bluetooth → App"
          : isAndroid ? "USB-C → Phone" : "USB-C → Computer"
        : "2.4 GHz ESP-NOW → Hub";
    const eraseBeforeFlash = !this.keepFingerprint;
    const totalSteps = this.orderedSteps.length;

    const pct = this.progress ? this.progress.percent : this.lastSuccessMsg ? 100 : 0;
    const statusText = this.progress
      ? this.progress.detail
      : this.lastSuccessMsg
        ? `✓ ${this.lastSuccessMsg}`
        : bridgeMissing
          ? "PoE Bridge firmware image (slaprf-p4-poe-bridge.bin) is not included in this build."
          : `Ready to flash ${cleanLabel}. Choose the USB board when prompted after clicking Flash ${cleanLabel} to USB.`;

    return `
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <div class="flasher-wizard-head">
            <h3 class="flasher-pane-title">Ready to flash ${esc(cleanLabel)}</h3>
            <span class="note flasher-step-count">Step ${totalSteps} of ${totalSteps}</span>
          </div>
          <p>${
            isBridge
              ? `Plug your <strong>Waveshare ESP32-P4-WIFI6-POE-ETH</strong> USB-C port into this computer and click <strong>Flash PoE Bridge to USB</strong>.`
              : hasBrowserWebSerial() || isSimulatedUsbMode()
                ? `Plug in your <strong>Seeed Studio XIAO ESP32-C5</strong> and click <strong>Flash ${esc(cleanLabel)} to USB</strong> to select the target USB board. After flashing, the board is read back once to confirm it works.`
                : `Plug in your <strong>Seeed Studio XIAO ESP32-C5</strong> over USB-C and tap <strong>Flash ${esc(cleanLabel)} to USB</strong> to select the target USB board. After flashing, the board is read back once to confirm it works.`
          }</p>
        </div>

        <div class="flasher-summary-grid">
          <div class="flasher-summary-cell">
            <span class="flasher-summary-label">${isBridge ? "Device" : "Timer"}</span>
            <strong class="flasher-summary-value mono">${esc(cleanLabel)}</strong>
          </div>
          <div class="flasher-summary-cell">
            <span class="flasher-summary-label">Role</span>
            <span class="flasher-summary-value"><span class="badge ${isHub || isBridge ? "tone-good" : ""}">${isBridge ? "ESP32-P4 · Serial Bridge" : isHub ? "Hub · Slot 1" : "Spoke · Slots 2–7"}</span></span>
          </div>
          <div class="flasher-summary-cell">
            <span class="flasher-summary-label">Firmware</span>
            <span class="flasher-summary-value mono">${isBridge ? esc(FIRMWARE_POE_BRIDGE_IMAGE_NAME) : `SlapRF ${LATEST_FIRMWARE_VERSION}`}</span>
          </div>
          <div class="flasher-summary-cell">
            <span class="flasher-summary-label">Link</span>
            <span class="flasher-summary-value">${esc(linkSummary)}</span>
          </div>
        </div>

        ${
          isBridge
            ? ""
            : `<label class="flasher-erase-toggle-row">
          <div class="flasher-erase-toggle-text">
            <strong>Erase before flash</strong>
            <span>Wipe existing board identity and assign a brand-new ID (leave off when updating an existing timer).</span>
          </div>
          <span class="switch">
            <input
              type="checkbox"
              data-erase-before-flash="1"
              ${eraseBeforeFlash ? "checked" : ""}
              ${this.busy ? "disabled" : ""}
            />
            <span></span>
          </span>
        </label>`
        }

        <div class="flasher-progress ${this.busy ? "is-flashing" : ""} ${this.lastSuccessMsg && !this.busy ? "is-complete" : ""}">
          <div class="flasher-progress-top">
            <span class="flasher-progress-status">${esc(statusText)}</span>
            <span class="mono flasher-progress-pct">${pct}%</span>
          </div>
          <div class="meter flasher-meter">
            <span class="meter-fill ${this.lastSuccessMsg && !this.busy ? "tone-good" : ""}" style="width:${pct}%"></span>
          </div>
          <div class="flasher-progress-foot">
            <span class="note">Flashing runs over USB, or download the pre-configured .bin image</span>
            <div class="flasher-progress-foot-actions">
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                data-download-bin="1"
                ${this.busy || bridgeMissing ? "disabled" : ""}
                title="Download the pre-configured .bin image"
              >
                <span>Download .bin</span>
              </button>
            </div>
          </div>
        </div>

        ${
          !webSerialOk
            ? `<p class="note">${FLASHER_NEEDS_WEBSERIAL}</p>`
            : ""
        }

        <div class="flasher-wizard-nav">
          ${
            this.busy
              ? `<button
                  type="button"
                  class="btn btn-bad"
                  data-cancel-flash="1"
                >
                  ${icons.close(15)}
                  <span>Cancel</span>
                </button>`
              : `<button
                  type="button"
                  class="btn"
                  data-wizard-prev="1"
                >
                  ${icons.chevronLeft(15)}
                  <span>Back</span>
                </button>`
          }

          ${
            this.lastSuccessMsg && !this.busy
              ? `<button
                  type="button"
                  class="btn flasher-btn-flash"
                  data-finish-wizard="1"
                >
                  ${icons.check(15)}
                  <span>Finish</span>
                </button>`
              : `<button
                  type="button"
                  class="btn flasher-btn-flash"
                  data-flash-usb="1"
                  ${this.busy || !webSerialOk || bridgeMissing ? "disabled" : ""}
                >
                  <span class="flasher-zap-icon">${icons.zap(15)}</span>
                  <span>${this.busy ? `Flashing ${esc(cleanLabel)}… (${pct}%)` : `Flash ${esc(cleanLabel)} to USB`}</span>
                </button>`
          }
        </div>
      </div>`;
  }

  private render(): void {
    const webSerialOk = isWebSerialSupported();
    const animClass =
      this.slideDir === "next"
        ? "is-slide-next"
        : this.slideDir === "prev"
          ? "is-slide-prev"
          : "";

    let stepContent = "";
    switch (this.step) {
      case "device":
        stepContent = this.renderStepDevice();
        break;
      case "network":
        stepContent = this.renderStepNetwork();
        break;
      case "identity":
        stepContent = this.renderStepIdentity();
        break;
      case "flash":
        stepContent = this.renderStepFlash(webSerialOk);
        break;
    }

    const nextHtml = `
      <div class="flasher flasher-wizard">
        ${this.renderStepper()}

        <div class="flasher-wizard-viewport">
          <div class="flasher-wizard-stage ${animClass}">
            ${stepContent}
          </div>
        </div>

        ${
          this.step !== "flash" && this.progress
            ? `
          <div class="flasher-progress">
            <div class="flasher-progress-top">
              <span>${esc(this.progress.detail)}</span>
              <span class="mono">${this.progress.percent}%</span>
            </div>
            <div class="meter flasher-meter">
              <span class="meter-fill tone-good" style="width:${this.progress.percent}%"></span>
            </div>
          </div>`
            : ""
        }

        ${
          this.step !== "flash" && this.lastSuccessMsg && !this.busy
            ? `<div class="flasher-banner is-ok">✓ ${esc(this.lastSuccessMsg)}</div>`
            : ""
        }

        ${
          this.errorMsg && !this.busy
            ? `<div class="flasher-banner is-err">${esc(this.errorMsg)}</div>`
            : ""
        }
      </div>`;
    if (nextHtml === this.lastHtml && this.slideDir === "none") return;
    this.lastHtml = nextHtml;
    this.el.innerHTML = nextHtml;
  }
}
