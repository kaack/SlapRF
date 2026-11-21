import { downloadBinaryFile, isAndroidHostApp } from "../core/android_bridge";
import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { subscribeAppTheme } from "../core/theme";
import { ApiClient } from "../services/api_client";
import { capabilitiesSnapshot } from "../services/capabilities";
import {
  FlashProgress,
  HubLink,
  LATEST_FIRMWARE_VERSION,
  TimerReadout,
  cancelActiveFlash,
  firmwareImageNameFor,
  flashXiaoC5OverWebSerial,
  isWebSerialSupported,
  probeBleFirmwareImage,
} from "../services/esp_flasher";
import {
  FLASHER_NEEDS_WEBSERIAL,
  WebSerialPort,
  acquireEspSerialPort,
  flashXiaoC5WithEsptool,
  flasherUsesWebSerial,
  hasBrowserWebSerial,
  isBackendRawWebSerialPort,
} from "../services/esptool_flasher";
import { createBackendPortHandle, isSimulatedUsbMode } from "../services/sim_serial_port";
import { recordKnownTimerReadout, usbPool } from "../services/timer_console";
import { AppStore } from "../state/store";

type WizardStepId = "network" | "identity" | "flash";

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
 * Interactive Hub & Spoke network flasher wizard for Seeed Studio XIAO ESP32-C5 timers.
 *
 *   - Step 1 (`network`): Pick the **Hub** or **Spoke** role via pictorial cards; Spoke reveals
 *     the **S1–S6** slot chips.
 *   - Step 2 (`identity`): Set **Timer ID / name** (pre-filled from the node you clicked). Every timer
 *     gets the same firmware; only the role, name and fingerprint differ.
 *   - Step 3 (`flash`): Summary receipt + **Flash to USB** / **Download .bin**.
 *
 * The Hub is a USB dongle that talks to this computer over USB serial only, so there is no
 * Wi-Fi setup step.
 */
export class TimerFlasher extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private readonly onReadout?: (readout: TimerReadout) => void;
  private readonly hideTips: boolean;

  private step: WizardStepId = "network";
  private slideDir: "next" | "prev" | "none" = "none";
  private role: "hub" | "spoke" = "hub";
  private flashedNodes = new Set<string>();
  private timerLabel = "H1";
  /** Keep the board's existing fingerprint when reflashing (vs. mint a new one). */
  private keepFingerprint = true;
  /** Hub connection choice (persisted). Spokes ignore it and always flash the USB image. */
  private hubLink: HubLink = loadStoredHubLink();
  /** Whether the Bluetooth Hub image is served (null while the probe is running). */
  private bleImageAvailable: boolean | null = null;
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

      const pickRole = t.closest<HTMLElement>("[data-pick-role]");
      if (pickRole) {
        const nextRole = pickRole.dataset.pickRole === "spoke" ? "spoke" : "hub";
        if (nextRole !== this.role) {
          this.role = nextRole;
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
        this.goToStep("network", "prev");
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
    return [
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

    if (targetIdx > curIdx) {
      if (curIdx <= steps.indexOf("identity") && targetIdx > steps.indexOf("identity")) {
        if (!this.validateIdentityStep()) return;
      }
    }

    this.goToStep(target, targetIdx > curIdx ? "next" : "prev");
  }

  private labelOptionsForRole(role: "hub" | "spoke" = this.role): string[] {
    return role === "hub" ? ["H1"] : ["T1", "T2", "T3", "T4", "T5", "T6"];
  }

  private normalizeLabelForRole(raw: string, role: "hub" | "spoke" = this.role): string {
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
      this.goToStep("identity", "prev");
      return;
    }
    if (this.step === "identity") {
      this.goToStep("network", "prev");
    }
  }

  private get roleLabel(): string {
    return this.role === "hub" ? "Hub" : "Spoke";
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
    this.role = info.role;
    this.timerLabel = this.normalizeLabelForRole(info.timerLabel || "", info.role);
    this.slideDir = "none";
    this.render();
  }

  private async flashUsb(): Promise<void> {
    if (!this.validateIdentityStep()) {
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
      detail: useEsptool || !usbPool.mainConsole.connected
        ? "Select the XIAO ESP32-C5 USB port to flash…"
        : `Building ${label} firmware image…`,
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
        // Simulation / Demo mode: flash the simulated board.
        if (!usbPool.mainConsole.connected) {
          await usbPool.connectMain(this.showAllPorts);
          onProgress({ stage: "connecting", percent: 1, detail: `Building ${label} firmware image…` });
        }
        const { bytes } = await this.api.fetchFirmwareImage(this.role, cleanLabel, undefined, this.effectiveHubLink);
        written = await flashXiaoC5OverWebSerial(
          bytes,
          label,
          onProgress,
          this.showAllPorts,
          this.keepFingerprint,
          usbPool
        );
      }

      if (written) {
        recordKnownTimerReadout(written);
        this.onReadout?.(written);
      }
      if (this.store.simulatorRunning) {
        await this.api.refresh();
      } else {
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

  private async downloadBin(): Promise<void> {
    if (!this.validateIdentityStep()) {
      return;
    }
    try {
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
   * Step 1: Role picker using pictorial cards.
   * Pick **Hub** (one per network) or **Spoke**; picking Spoke reveals the S1–S6 slot chips.
   */
  private renderStepNetwork(): string {
    const isHub = this.role === "hub";
    const isAndroid = isAndroidHostApp();
    const hostNoun = isAndroid ? "this phone" : "this computer";
    const hubFlashed = this.flashedNodes.has("hub");
    const flashedSpokes = [...this.flashedNodes].filter((k) => k.startsWith("spoke:")).length;

    return `
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <div class="flasher-wizard-head">
            <h3 class="flasher-pane-title">What role will this timer play?</h3>
            <span class="note flasher-step-count">Step 1 of 3</span>
          </div>
          <p>One <strong>Hub</strong> plugs into ${hostNoun} over USB-C and collects passes from up to 6 <strong>Spokes</strong> on the course.</p>
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
              USB dongle plugged into ${hostNoun}. Collects every Spoke's passes over long-range ESP-NOW and streams them over USB-C.
            </p>
          </button>

          <button
            type="button"
            role="radio"
            aria-checked="${!isHub}"
            class="flasher-pictorial-card ${!isHub ? "is-active" : ""}"
            data-pick-role="spoke"
            ${this.busy ? "disabled" : ""}
          >
            <div class="flasher-pictorial-head">
              <span class="flasher-pictorial-title">Spoke</span>
              <span class="badge ${!isHub ? "tone-good" : ""}">${
                flashedSpokes > 0 ? `✓ ${flashedSpokes} flashed` : "Up to 6 · Track timers"
              }</span>
            </div>
            <div class="flasher-pictorial-art">
              ${this.renderPictorialRoleSpoke()}
            </div>
            <p class="flasher-pictorial-desc">
              Placed around the course to time each section. Sends its passes to the Hub over long-range ESP-NOW.
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
            <li><strong>Keep the Hub and all Spokes on the same firmware version.</strong> When updating firmware, reflash both the Hub and every Spoke on the course.</li>
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

  private renderStepIdentity(): string {
    const isHub = this.role === "hub";
    const options = this.labelOptionsForRole(this.role);
    const currentLabel = this.normalizeLabelForRole(this.timerLabel, this.role);
    this.timerLabel = currentLabel;

    return `
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <div class="flasher-wizard-head">
            <h3 class="flasher-pane-title">${isHub ? "Configure Hub" : "Configure Spoke"}</h3>
            <span class="note flasher-step-count">Step 2 of 3</span>
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
    const isHub = this.role === "hub";
    const isAndroid = isAndroidHostApp();
    const cleanLabel = this.timerLabel.trim() || (isHub ? "H1" : this.suggestSpokeLabel());
    const bleHub = isHub && this.effectiveHubLink === "ble";
    const linkSummary = isHub
      ? bleHub
        ? isAndroid ? "Bluetooth → Phone" : "Bluetooth → App"
        : isAndroid ? "USB-C → Phone" : "USB-C → Computer"
      : "2.4 GHz ESP-NOW → Hub";
    const eraseBeforeFlash = !this.keepFingerprint;
    const activeConsole = usbPool.mainConsole;
    const browser = flasherUsesWebSerial();
    const isConnected = !browser && activeConsole.connected;
    const targetName = isConnected
      ? browser
        ? ""
        : activeConsole.isOtherDevice
          ? "Other"
          : activeConsole.lastStatus?.label || activeConsole.lastConfig?.timerLabel || "USB"
      : "";

    const pct = this.progress ? this.progress.percent : this.lastSuccessMsg ? 100 : 0;
    const statusText = this.progress
      ? this.progress.detail
      : this.lastSuccessMsg
      ? `✓ ${this.lastSuccessMsg}`
      : isConnected
        ? `Ready to flash ${cleanLabel} to connected USB device (${targetName})`
        : `Ready to flash ${cleanLabel}. Plug in the board and tap Flash ${cleanLabel} to USB.`;

    return `
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <div class="flasher-wizard-head">
            <h3 class="flasher-pane-title">Ready to flash ${esc(cleanLabel)}</h3>
            <span class="note flasher-step-count">Step 3 of 3</span>
          </div>
          <p>${
            isConnected
              ? `Connected to <strong>${esc(targetName)}</strong> over USB-C. Click <strong>Flash ${esc(cleanLabel)} to USB</strong> to write the firmware.`
              : hasBrowserWebSerial()
                ? `Plug in your <strong>Seeed Studio XIAO ESP32-C5</strong> and click <strong>Flash ${esc(cleanLabel)} to USB</strong>. Your browser asks which USB port to use the first time. After flashing, the board is read back once to confirm it works.`
                : `Plug in your <strong>Seeed Studio XIAO ESP32-C5</strong> over USB-C and tap <strong>Flash ${esc(cleanLabel)} to USB</strong>. Approve the USB access prompt if asked. After flashing, the board is read back once to confirm it works.`
          }</p>
        </div>

        <div class="flasher-summary-grid">
          <div class="flasher-summary-cell">
            <span class="flasher-summary-label">Timer</span>
            <strong class="flasher-summary-value mono">${esc(cleanLabel)}</strong>
          </div>
          <div class="flasher-summary-cell">
            <span class="flasher-summary-label">Role</span>
            <span class="flasher-summary-value"><span class="badge ${isHub ? "tone-good" : ""}">${isHub ? "Hub · Slot 1" : "Spoke · Slots 2–7"}</span></span>
          </div>
          <div class="flasher-summary-cell">
            <span class="flasher-summary-label">Firmware</span>
            <span class="flasher-summary-value mono">SlapRF ${LATEST_FIRMWARE_VERSION}</span>
          </div>
          <div class="flasher-summary-cell">
            <span class="flasher-summary-label">Link</span>
            <span class="flasher-summary-value">${esc(linkSummary)}</span>
          </div>
        </div>

        <label class="flasher-erase-toggle-row">
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
        </label>

        <div class="flasher-progress ${this.busy ? "is-flashing" : ""} ${this.lastSuccessMsg && !this.busy ? "is-complete" : ""}">
          <div class="flasher-progress-top">
            <span class="flasher-progress-status">${esc(statusText)}</span>
            <span class="mono flasher-progress-pct">${pct}%</span>
          </div>
          <div class="meter flasher-meter">
            <span class="meter-fill ${this.lastSuccessMsg && !this.busy ? "tone-good" : ""}" style="width:${pct}%"></span>
          </div>
          <div class="flasher-progress-foot">
            <span class="note">${
              isConnected ? `Target USB connection: ${esc(targetName)}` : "Flashing runs in your browser over USB, or download the .bin image"
            }</span>
            <div class="flasher-progress-foot-actions">
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                data-download-bin="1"
                ${this.busy ? "disabled" : ""}
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
                  ${this.busy || !webSerialOk ? "disabled" : ""}
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
