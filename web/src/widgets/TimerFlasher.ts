import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ApiClient } from "../services/api_client";
import {
  FIRMWARE_RELEASES,
  FlashProgress,
  LATEST_FIRMWARE_VERSION,
  TimerReadout,
  flashXiaoC5OverWebSerial,
  isWebSerialSupported,
  readXiaoC5OverWebSerial,
} from "../services/esp_flasher";
import { AppStore } from "../state/store";

const WIFI_SSID_STORAGE_KEY = "slaprf.wifi.ssid";
const HUB_WIFI_MODE_STORAGE_KEY = "slaprf.wifi.hubMode";
const CUSTOM_SSID_VALUE = "__custom__";

type HubWifiMode = "join" | "host";
type WizardStepId = "role" | "identity" | "wifi" | "flash";

interface ScannedWifi {
  ssid: string;
  signalPct?: number;
  connected?: boolean;
  saved?: boolean;
}

/**
 * Step-by-step sliding wizard for flashing & reading Seeed Studio XIAO ESP32-C5 timers.
 *
 * Flow:
 *   - Step 1 (`role`): Choose **Hub** or **Spoke** (or read an existing timer from USB).
 *   - Step 2 (`identity`): Set **Timer ID / name** (auto-suggested if blank) and **Firmware version**.
 *   - Step 3 (`wifi`, Hub only): Choose **Join 2.4 GHz Hotspot/Router** or **Host "SlapRF" AP** and credentials.
 *   - Step 4 (`flash`): Review configuration summary receipt and **Flash to USB** (or Download `.bin`).
 */
export class TimerFlasher extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;

  private step: WizardStepId = "role";
  private slideDir: "next" | "prev" | "none" = "none";
  private role: "hub" | "spoke" = "hub";
  private hubWifiMode: HubWifiMode = "join";
  private timerLabel = "";
  private firmwareVersion = LATEST_FIRMWARE_VERSION;
  private networks: ScannedWifi[] = [];
  private scanningWifi = false;
  private customMode = false;
  private hadStoredWifiPref = false;
  private wifiSSID = "";
  private wifiPass = "";
  private showPassword = false;
  private busy = false;
  private progress: FlashProgress | null = null;
  private readout: TimerReadout | null = null;
  private lastSuccessMsg: string | null = null;
  private errorMsg: string | null = null;
  private showAllPorts = false;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;

    let hadStoredPref = false;
    try {
      const storedMode = window.localStorage.getItem(HUB_WIFI_MODE_STORAGE_KEY);
      if (storedMode === "host" || storedMode === "join") {
        this.hubWifiMode = storedMode;
      }
      const stored = window.localStorage.getItem(WIFI_SSID_STORAGE_KEY);
      if (stored !== null && stored !== "") {
        this.wifiSSID = stored;
        hadStoredPref = true;
      }
    } catch {
      // ignore storage errors
    }
    this.hadStoredWifiPref = hadStoredPref;

    this.listen(el, "click", (e) => {
      const t = e.target as HTMLElement;

      if (t.closest("[data-toggle-pass]")) {
        this.showPassword = !this.showPassword;
        const passInput = this.el.querySelector<HTMLInputElement>("[data-wifi-pass]");
        const selStart = passInput?.selectionStart ?? null;
        this.slideDir = "none";
        this.render();
        const nextInput = this.el.querySelector<HTMLInputElement>("[data-wifi-pass]");
        if (nextInput) {
          nextInput.focus();
          if (selStart !== null) {
            nextInput.setSelectionRange(selStart, selStart);
          }
        }
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
        const roleChanged = nextRole !== this.role;
        this.role = nextRole;
        if (roleChanged || !this.timerLabel.trim() || this.isDefaultTimerLabel(this.timerLabel)) {
          this.timerLabel = this.suggestTimerLabel(nextRole);
        }
        this.errorMsg = null;
        this.lastSuccessMsg = null;
        this.goToStep("identity", "next");
        return;
      }

      const pickHubMode = t.closest<HTMLElement>("[data-pick-hub-mode]");
      if (pickHubMode) {
        const nextMode: HubWifiMode = pickHubMode.dataset.pickHubMode === "host" ? "host" : "join";
        if (nextMode !== this.hubWifiMode) {
          this.saveHubWifiMode(nextMode);
          this.errorMsg = null;
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

      if (t.closest("[data-flash-another]")) {
        const nextRole: "hub" | "spoke" = "spoke";
        this.role = nextRole;
        this.timerLabel = this.suggestTimerLabel(nextRole);
        this.errorMsg = null;
        this.lastSuccessMsg = null;
        this.readout = null;
        this.goToStep("role", "prev");
        return;
      }

      if (t.closest("[data-clear-readout]")) {
        this.readout = null;
        this.lastSuccessMsg = null;
        this.slideDir = "none";
        this.render();
        return;
      }

      if (t.closest("[data-refresh-wifi]")) {
        void this.refreshWifiNetworks();
        return;
      }

      if (t.closest("[data-edit-ssid]")) {
        this.customMode = true;
        this.slideDir = "none";
        this.render();
        const input = this.el.querySelector<HTMLInputElement>("[data-wifi-ssid]");
        if (input) {
          input.focus();
          input.select();
        }
        return;
      }

      if (t.closest("[data-clear-ssid]")) {
        this.customMode = false;
        if (this.networks.length > 0) {
          this.saveSSID(this.networks[0].ssid);
        } else {
          this.saveSSID("");
        }
        this.slideDir = "none";
        this.render();
        return;
      }

      if (t.closest("[data-flash-usb]")) {
        void this.flashUsb();
        return;
      }

      if (t.closest("[data-read-usb]")) {
        void this.readUsb();
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
        if (target.matches("[data-timer-label], [data-wifi-ssid], [data-wifi-pass]")) {
          e.preventDefault();
          this.advanceStep();
        }
      }
    });

    this.listen(el, "input", (e) => {
      const input = e.target as HTMLInputElement;
      if (input.matches("[data-timer-label]")) {
        this.timerLabel = input.value;
      } else if (input.matches("[data-wifi-ssid]")) {
        this.saveSSID(input.value);
      } else if (input.matches("[data-wifi-pass]")) {
        this.wifiPass = input.value;
      }
    });

    this.listen(el, "change", (e) => {
      const target = e.target as HTMLInputElement | HTMLSelectElement;
      if (target.matches("[data-wifi-select]")) {
        const val = target.value;
        if (val === CUSTOM_SSID_VALUE) {
          this.customMode = true;
          this.wifiSSID = "";
          this.slideDir = "none";
          this.render();
          this.el.querySelector<HTMLInputElement>("[data-wifi-ssid]")?.focus();
        } else {
          this.customMode = false;
          this.saveSSID(val);
          this.slideDir = "none";
          this.render();
        }
      } else if (target.matches("[data-fw-version]")) {
        this.firmwareVersion = target.value || LATEST_FIRMWARE_VERSION;
        this.slideDir = "none";
        this.render();
      } else if (target.matches("[data-all-ports]")) {
        this.showAllPorts = (target as HTMLInputElement).checked;
      }
    });

    this.timerLabel = this.suggestTimerLabel(this.role);
    this.render();
    void this.refreshWifiNetworks();
  }

  private get orderedSteps(): Array<{ id: WizardStepId; title: string; short: string }> {
    if (this.role === "hub") {
      return [
        { id: "role", title: "Timer role", short: "Role" },
        { id: "identity", title: "Name & firmware", short: "Identity" },
        { id: "wifi", title: "2.4 GHz Wi-Fi", short: "Wi-Fi" },
        { id: "flash", title: "Flash timer", short: "Flash" },
      ];
    }
    return [
      { id: "role", title: "Timer role", short: "Role" },
      { id: "identity", title: "Name & firmware", short: "Identity" },
      { id: "flash", title: "Flash timer", short: "Flash" },
    ];
  }

  private isDefaultTimerLabel(label: string): boolean {
    return /^(Hub|Spoke)-\d+$/i.test(label.trim());
  }

  private suggestTimerLabel(role: "hub" | "spoke"): string {
    const existing = new Set(
      this.store.pucks
        .map((p) => (p.timerLabel || p.name || "").trim().toLowerCase())
        .filter(Boolean)
    );
    const prefix = role === "hub" ? "Hub" : "Spoke";
    for (let i = 1; i <= 16; i++) {
      const candidate = `${prefix}-${i}`;
      if (!existing.has(candidate.toLowerCase())) {
        return candidate;
      }
    }
    return `${prefix}-1`;
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

    // Validate intermediate steps when jumping forward
    if (targetIdx > curIdx) {
      if (curIdx <= steps.indexOf("identity") && targetIdx > steps.indexOf("identity")) {
        if (!this.validateIdentityStep()) return;
      }
      if (
        this.role === "hub" &&
        curIdx <= steps.indexOf("wifi") &&
        targetIdx > steps.indexOf("wifi")
      ) {
        if (!this.validateWifiStep()) return;
      }
    }

    this.goToStep(target, targetIdx > curIdx ? "next" : "prev");
  }

  private validateIdentityStep(): boolean {
    if (!this.timerLabel.trim()) {
      this.errorMsg = "Give this timer an ID / name (e.g. Hub-1, Spoke-2, Gate-A) before continuing.";
      this.slideDir = "none";
      this.render();
      this.el.querySelector<HTMLInputElement>("[data-timer-label]")?.focus();
      return false;
    }
    return true;
  }

  private validateWifiStep(): boolean {
    if (this.role !== "hub") return true;
    if (this.hubWifiMode === "join" && !this.wifiSSID.trim()) {
      this.errorMsg =
        'Select or enter a 2.4 GHz Wi-Fi / hotspot SSID to join, or switch to Host "SlapRF" 2.4 GHz AP mode.';
      this.slideDir = "none";
      this.render();
      return false;
    }
    if (this.hubWifiMode === "host" && this.wifiPass.length > 0 && this.wifiPass.length < 8) {
      this.errorMsg =
        "WPA2 password for the SlapRF AP must be at least 8 characters (or leave blank for an open AP).";
      this.slideDir = "none";
      this.render();
      return false;
    }
    return true;
  }

  private advanceStep(): void {
    if (this.step === "role") {
      if (!this.timerLabel.trim()) {
        this.timerLabel = this.suggestTimerLabel(this.role);
      }
      this.goToStep("identity", "next");
      return;
    }
    if (this.step === "identity") {
      if (!this.validateIdentityStep()) return;
      this.goToStep(this.role === "hub" ? "wifi" : "flash", "next");
      return;
    }
    if (this.step === "wifi") {
      if (!this.validateWifiStep()) return;
      this.goToStep("flash", "next");
    }
  }

  private retreatStep(): void {
    if (this.step === "flash") {
      this.goToStep(this.role === "hub" ? "wifi" : "identity", "prev");
      return;
    }
    if (this.step === "wifi") {
      this.goToStep("identity", "prev");
      return;
    }
    if (this.step === "identity") {
      this.goToStep("role", "prev");
    }
  }

  private saveHubWifiMode(mode: HubWifiMode): void {
    this.hubWifiMode = mode;
    try {
      window.localStorage.setItem(HUB_WIFI_MODE_STORAGE_KEY, mode);
    } catch {
      // ignore
    }
  }

  private saveSSID(ssid: string): void {
    this.wifiSSID = ssid;
    this.hadStoredWifiPref = true;
    try {
      window.localStorage.setItem(WIFI_SSID_STORAGE_KEY, this.wifiSSID);
    } catch {
      // ignore
    }
  }

  private get effectiveHubSSID(): string {
    if (this.role !== "hub" || this.hubWifiMode === "host") {
      return "";
    }
    return this.wifiSSID.trim();
  }

  private async refreshWifiNetworks(): Promise<void> {
    this.scanningWifi = true;
    this.slideDir = "none";
    this.render();
    const list = await this.api.listWifiNetworks();
    this.scanningWifi = false;
    this.networks = list;

    if (!this.hadStoredWifiPref && !this.wifiSSID && list.length > 0) {
      this.saveSSID(list[0].ssid);
      this.customMode = false;
    } else if (this.wifiSSID && list.length > 0 && !list.some((n) => n.ssid === this.wifiSSID)) {
      this.networks = [{ ssid: this.wifiSSID, saved: true }, ...list];
    }
    this.slideDir = "none";
    this.render();
  }

  private get roleLabel(): string {
    return this.role === "hub" ? "Hub" : "Spoke";
  }

  private async readUsb(): Promise<void> {
    this.busy = true;
    this.errorMsg = null;
    this.lastSuccessMsg = null;
    this.slideDir = "none";
    this.progress = {
      stage: "connecting",
      percent: 10,
      detail: "Connecting to XIAO ESP32-C5 over USB…",
    };
    this.render();

    try {
      const { bytes } = await this.api.fetchFirmwareImage(
        this.role,
        this.timerLabel.trim() || "Hub-1",
        this.effectiveHubSSID,
        this.wifiPass,
        this.firmwareVersion
      );
      const info = await readXiaoC5OverWebSerial(
        bytes,
        (p) => {
          this.progress = p;
          this.slideDir = "none";
          this.render();
        },
        this.showAllPorts
      );

      this.readout = info;
      this.role = info.role;
      if (info.timerLabel) {
        this.timerLabel = info.timerLabel;
      }
      if (info.role === "hub") {
        if (info.wifiSSID) {
          this.saveHubWifiMode("join");
          this.saveSSID(info.wifiSSID);
          if (!this.networks.some((n) => n.ssid === info.wifiSSID)) {
            this.networks = [{ ssid: info.wifiSSID, saved: true }, ...this.networks];
          }
        } else {
          this.saveHubWifiMode("host");
        }
      }
      const idNote = info.timerLabel ? ` (${info.timerLabel})` : "";
      const verNote =
        info.firmwareVersion === LATEST_FIRMWARE_VERSION
          ? `${info.firmwareVersion} — up to date`
          : `${info.firmwareVersion} — update to ${LATEST_FIRMWARE_VERSION} available`;
      this.lastSuccessMsg = `Read complete — timer is configured as ${
        info.role === "hub" ? "Hub" : "Spoke"
      }${idNote} running ${verNote}.`;
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

  private async flashUsb(): Promise<void> {
    if (!this.validateIdentityStep() || !this.validateWifiStep()) {
      return;
    }
    const cleanLabel = this.timerLabel.trim();
    const label = `${this.roleLabel} "${cleanLabel}" (${this.firmwareVersion})`;
    this.busy = true;
    this.errorMsg = null;
    this.lastSuccessMsg = null;
    this.slideDir = "none";
    this.progress = {
      stage: "connecting",
      percent: 1,
      detail: `Building ${label} firmware image…`,
    };
    this.render();

    try {
      const ssid = this.effectiveHubSSID;
      const pass = this.role === "hub" ? this.wifiPass : "";
      const { bytes } = await this.api.fetchFirmwareImage(
        this.role,
        cleanLabel,
        ssid,
        pass,
        this.firmwareVersion
      );

      const written = await flashXiaoC5OverWebSerial(
        bytes,
        label,
        (p) => {
          this.progress = p;
          this.slideDir = "none";
          this.render();
        },
        this.showAllPorts
      );

      if (written) {
        this.readout = written;
      }
      await this.api.provisionTimer(this.role, cleanLabel, this.firmwareVersion);
      this.lastSuccessMsg = `${label} flashed and added to Timers & Track! Unplug this XIAO or click "Flash another timer".`;
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
    if (!this.validateIdentityStep() || !this.validateWifiStep()) {
      return;
    }
    try {
      const cleanLabel = this.timerLabel.trim();
      const ssid = this.effectiveHubSSID;
      const pass = this.role === "hub" ? this.wifiPass : "";
      const { bytes, filename } = await this.api.fetchFirmwareImage(
        this.role,
        cleanLabel,
        ssid,
        pass,
        this.firmwareVersion
      );
      const blob = new Blob([bytes], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      this.errorMsg = err instanceof Error ? err.message : String(err);
      this.slideDir = "none";
      this.render();
    }
  }

  private formatNetworkOption(n: ScannedWifi): string {
    const tags: string[] = [];
    if (n.connected) tags.push("Connected");
    else if (n.saved) tags.push("Saved");
    if (n.signalPct && n.signalPct > 0) tags.push(`${n.signalPct}%`);
    return tags.length > 0 ? `${n.ssid} (${tags.join(" · ")})` : n.ssid;
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

  private renderStepRole(webSerialOk: boolean): string {
    const isHub = this.role === "hub";
    return `
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <h3>What kind of timer are you flashing?</h3>
          <p>Select a role to configure and flash a XIAO ESP32-C5 board. Every track uses <strong>1 Hub</strong> and up to <strong>5 Spokes</strong>.</p>
        </div>

        <div class="flasher-role-choice-grid">
          <button
            type="button"
            class="flasher-choice-card ${isHub ? "is-selected" : ""}"
            data-pick-role="hub"
            ${this.busy ? "disabled" : ""}
          >
            <div class="flasher-choice-top">
              <span class="flasher-choice-title">Hub Timer</span>
              <span class="badge tone-good">1 per track · Wi-Fi + ESP-NOW</span>
            </div>
            <p class="flasher-choice-desc">
              Times its own gate <em>and</em> relays all Spoke timers to this computer over 2.4 GHz Wi-Fi.
            </p>
            <span class="flasher-choice-cta">Configure Hub ${icons.arrowRight(14)}</span>
          </button>

          <button
            type="button"
            class="flasher-choice-card ${!isHub ? "is-selected" : ""}"
            data-pick-role="spoke"
            ${this.busy ? "disabled" : ""}
          >
            <div class="flasher-choice-top">
              <span class="flasher-choice-title">Spoke Timer</span>
              <span class="badge">Up to 5 · ESP-NOW</span>
            </div>
            <p class="flasher-choice-desc">
              Zero Wi-Fi setup. Automatically pairs with the Hub over 2.4 GHz ESP-NOW Long Range.
            </p>
            <span class="flasher-choice-cta">Configure Spoke ${icons.arrowRight(14)}</span>
          </button>
        </div>

        <div class="flasher-inspect-bar">
          <div class="flasher-inspect-text">
            <strong>Already flashed a board?</strong>
            <span>Plug it into USB to inspect its current Timer ID, role, and firmware version.</span>
          </div>
          <button
            type="button"
            class="btn btn-sm"
            data-read-usb="1"
            ${this.busy || !webSerialOk ? "disabled" : ""}
          >
            ${icons.plug(14)}
            <span>Read timer from USB</span>
          </button>
        </div>
      </div>`;
  }

  private renderStepIdentity(): string {
    const isHub = this.role === "hub";
    const idPlaceholder = isHub ? "e.g. Hub-1 or Start-Hub" : "e.g. Spoke-1, Split-2, or Gate-B";
    const selectedRel =
      FIRMWARE_RELEASES.find((r) => r.version === this.firmwareVersion) ?? FIRMWARE_RELEASES[0];

    return `
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <div class="flasher-wizard-badge-row">
            <span class="badge ${isHub ? "tone-good" : ""}">${isHub ? "Hub Timer" : "Spoke Timer"}</span>
            <span class="note">${
              isHub
                ? "Step 2 of 4 · Stamped into flash memory"
                : "Step 2 of 3 · Stamped into flash memory"
            }</span>
          </div>
          <h3>Name this ${isHub ? "Hub" : "Spoke"} &amp; pick firmware</h3>
          <p>Give the board a short ID so you can recognize it in the Timers list and Track editor.</p>
        </div>

        <div class="flasher-wifi-inputs flasher-two-col">
          <div class="flasher-field">
            <label class="flasher-field-label">Timer ID / name</label>
            <input
              class="input mono"
              type="text"
              placeholder="${idPlaceholder}"
              value="${esc(this.timerLabel)}"
              data-timer-label="1"
              maxlength="24"
              spellcheck="false"
              autocomplete="off"
              ${this.busy ? "disabled" : ""}
            />
          </div>

          <div class="flasher-field">
            <label class="flasher-field-label">Firmware version</label>
            <select
              class="input mono"
              data-fw-version="1"
              aria-label="Firmware version"
              title="${esc(selectedRel.summary)}"
              ${this.busy ? "disabled" : ""}
            >
              ${FIRMWARE_RELEASES.map(
                (rel) =>
                  `<option value="${esc(rel.version)}" ${
                    rel.version === this.firmwareVersion ? "selected" : ""
                  }>${esc(rel.label)}</option>`
              ).join("")}
            </select>
          </div>
        </div>

        <div class="flasher-wizard-nav">
          <button type="button" class="btn btn-ghost" data-wizard-prev="1" ${this.busy ? "disabled" : ""}>
            ${icons.chevronLeft(15)}
            <span>Back</span>
          </button>
          <button type="button" class="btn btn-primary" data-wizard-next="1" ${this.busy ? "disabled" : ""}>
            <span>${isHub ? "Next: 2.4 GHz Wi-Fi" : "Next: Review & Flash"}</span>
            ${icons.chevronRight(15)}
          </button>
        </div>
      </div>`;
  }

  private renderStepWifi(): string {
    const isHostApMode = this.hubWifiMode === "host";
    const useCustom = this.customMode;

    return `
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <div class="flasher-wizard-badge-row">
            <span class="badge tone-good">Hub · ${esc(this.timerLabel.trim() || "Hub-1")}</span>
            <span class="note">Step 3 of 4 · 5.8 GHz Wi-Fi is hardware-disabled to protect FPV video</span>
          </div>
          <h3>How should the Hub connect to this computer?</h3>
          <p>Choose whether the Hub joins your existing Wi-Fi / phone hotspot or creates its own direct <strong>"SlapRF"</strong> Wi-Fi network.</p>
        </div>

        <div class="flasher-mode-segmented" role="radiogroup" aria-label="Hub 2.4 GHz Wi-Fi mode">
          <button
            type="button"
            role="radio"
            aria-checked="${!isHostApMode}"
            class="flasher-mode-tab ${!isHostApMode ? "is-active" : ""}"
            data-pick-hub-mode="join"
            ${this.busy ? "disabled" : ""}
          >
            <div class="flasher-mode-tab-top">
              <span class="flasher-mode-tab-title">Join Hotspot / Router</span>
              <span class="badge ${!isHostApMode ? "tone-good" : ""}">Station Mode</span>
            </div>
            <span class="flasher-mode-tab-sub">Hub joins your phone hotspot or router</span>
          </button>

          <button
            type="button"
            role="radio"
            aria-checked="${isHostApMode}"
            class="flasher-mode-tab ${isHostApMode ? "is-active" : ""}"
            data-pick-hub-mode="host"
            ${this.busy ? "disabled" : ""}
          >
            <div class="flasher-mode-tab-top">
              <span class="flasher-mode-tab-title">Host "SlapRF" Wi-Fi AP</span>
              <span class="badge ${isHostApMode ? "tone-good" : ""}">Direct AP · Ch 1</span>
            </div>
            <span class="flasher-mode-tab-sub">Hub broadcasts its own "SlapRF" network</span>
          </button>
        </div>

        <div class="flasher-wifi-panel">
          ${
            isHostApMode
              ? `
            <p class="flasher-wifi-panel-desc">
              The Hub will broadcast a 2.4 GHz Wi-Fi network named <strong>SlapRF</strong> at <code>192.168.4.1</code>. Connect your laptop or phone Wi-Fi directly to <strong>SlapRF</strong> at the field.
            </p>
            <div class="flasher-wifi-inputs flasher-two-col">
              <div class="flasher-field">
                <label class="flasher-field-label">Broadcast network (automatic)</label>
                <div class="flasher-ap-summary mono">
                  <span class="badge tone-good">SSID: SlapRF</span>
                  <span>2.4 GHz Ch 1</span>
                  <span class="muted">·</span>
                  <span>192.168.4.1</span>
                </div>
              </div>

              <div class="flasher-field">
                <label class="flasher-field-label">SlapRF AP password (optional)</label>
                <div class="flasher-pass-wrap">
                  <input
                    class="input flasher-pass-input"
                    type="${this.showPassword ? "text" : "password"}"
                    placeholder="Blank = open AP (or 8+ chars WPA2)"
                    value="${esc(this.wifiPass)}"
                    data-wifi-pass="1"
                    maxlength="39"
                    spellcheck="false"
                    autocomplete="off"
                    ${this.busy ? "disabled" : ""}
                  />
                  <button
                    type="button"
                    class="flasher-pass-toggle"
                    data-toggle-pass="1"
                    aria-label="${this.showPassword ? "Hide password" : "Show password"}"
                    title="${this.showPassword ? "Hide password" : "Show password"}"
                  >
                    ${this.showPassword ? icons.eyeOff(15) : icons.eye(15)}
                  </button>
                </div>
              </div>
            </div>`
              : `
            <div class="flasher-wifi-panel-head">
              <p class="flasher-wifi-panel-desc">
                Select your 2.4 GHz phone hotspot or router below. Your laptop can stay connected to 5 GHz Wi-Fi or internet at the same time.
              </p>
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                data-refresh-wifi="1"
                ${this.busy || this.scanningWifi ? "disabled" : ""}
                title="Rescan nearby 2.4 GHz Wi-Fi networks"
              >
                ${icons.reset(13)}
                <span>${this.scanningWifi ? "Scanning…" : "Rescan Wi-Fi"}</span>
              </button>
            </div>
            <div class="flasher-wifi-inputs flasher-two-col">
              <div class="flasher-field">
                <label class="flasher-field-label">2.4 GHz Wi-Fi / hotspot SSID</label>
                ${
                  useCustom
                    ? `<div class="flasher-pass-wrap">
                        <input
                          class="input flasher-pass-input"
                          type="text"
                          placeholder="Type 2.4 GHz Wi-Fi / hotspot SSID"
                          value="${esc(this.wifiSSID)}"
                          data-wifi-ssid="1"
                          maxlength="32"
                          spellcheck="false"
                          autocomplete="off"
                          ${this.busy ? "disabled" : ""}
                        />
                        <button
                          type="button"
                          class="flasher-pass-toggle"
                          data-clear-ssid="1"
                          aria-label="Return to scanned Wi-Fi network list"
                          title="Return to scanned Wi-Fi network list"
                        >
                          ${icons.close(14)}
                        </button>
                      </div>`
                    : `<div class="flasher-ssid-row">
                        <select
                          class="input flasher-ssid-select"
                          data-wifi-select="1"
                          aria-label="2.4 GHz Wi-Fi network to join"
                          ${this.busy ? "disabled" : ""}
                        >
                          ${
                            this.networks.length === 0
                              ? `<option value="" disabled ${!this.wifiSSID ? "selected" : ""}>No nearby networks detected — click pencil to type SSID</option>`
                              : ""
                          }
                          ${this.networks
                            .map(
                              (n) =>
                                `<option value="${esc(n.ssid)}" ${
                                  n.ssid === this.wifiSSID ? "selected" : ""
                                }>${esc(this.formatNetworkOption(n))}</option>`
                            )
                            .join("")}
                          <option value="${CUSTOM_SSID_VALUE}">Type another 2.4 GHz network / hotspot…</option>
                        </select>
                        <button
                          type="button"
                          class="btn btn-icon flasher-ssid-edit"
                          data-edit-ssid="1"
                          ${this.busy ? "disabled" : ""}
                          aria-label="Type custom Wi-Fi / hotspot name"
                          title="Type custom Wi-Fi / hotspot name"
                        >
                          ${icons.pencil(14)}
                        </button>
                      </div>`
                }
              </div>

              <div class="flasher-field">
                <label class="flasher-field-label">Wi-Fi / hotspot password</label>
                <div class="flasher-pass-wrap">
                  <input
                    class="input flasher-pass-input"
                    type="${this.showPassword ? "text" : "password"}"
                    placeholder="Wi-Fi / hotspot password"
                    value="${esc(this.wifiPass)}"
                    data-wifi-pass="1"
                    maxlength="39"
                    spellcheck="false"
                    autocomplete="off"
                    ${this.busy ? "disabled" : ""}
                  />
                  <button
                    type="button"
                    class="flasher-pass-toggle"
                    data-toggle-pass="1"
                    aria-label="${this.showPassword ? "Hide password" : "Show password"}"
                    title="${this.showPassword ? "Hide password" : "Show password"}"
                  >
                    ${this.showPassword ? icons.eyeOff(15) : icons.eye(15)}
                  </button>
                </div>
              </div>
            </div>`
          }
        </div>

        <div class="flasher-wizard-nav">
          <button type="button" class="btn btn-ghost" data-wizard-prev="1" ${this.busy ? "disabled" : ""}>
            ${icons.chevronLeft(15)}
            <span>Back</span>
          </button>
          <button type="button" class="btn btn-primary" data-wizard-next="1" ${this.busy ? "disabled" : ""}>
            <span>Next: Review &amp; Flash</span>
            ${icons.chevronRight(15)}
          </button>
        </div>
      </div>`;
  }

  private renderStepFlash(webSerialOk: boolean): string {
    const isHub = this.role === "hub";
    const cleanLabel = this.timerLabel.trim() || (isHub ? "Hub-1" : "Spoke-1");
    const wifiSummary = isHub
      ? this.hubWifiMode === "host"
        ? `Host "SlapRF" 2.4 GHz AP (${this.wifiPass ? "WPA2 protected" : "Open AP"})`
        : `Join "${this.wifiSSID.trim() || "(unset)"}" (2.4 GHz Station)`
      : "2.4 GHz ESP-NOW Long Range (auto-locks to Hub)";

    return `
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <h3>Ready to flash ${esc(cleanLabel)}</h3>
          <p>Plug your <strong>Seeed Studio XIAO ESP32-C5</strong> into this computer with a USB-C cable and click <strong>Flash to USB</strong>.</p>
        </div>

        <div class="flasher-receipt">
          <div class="flasher-receipt-item">
            <span class="note">Role</span>
            <div class="flasher-receipt-val">
              <span class="badge ${isHub ? "tone-good" : ""}">${isHub ? "Hub" : "Spoke"}</span>
              <button type="button" class="flasher-receipt-edit" data-goto-step="role" ${this.busy ? "disabled" : ""}>Change</button>
            </div>
          </div>

          <div class="flasher-receipt-item">
            <span class="note">Timer ID &amp; Firmware</span>
            <div class="flasher-receipt-val mono">
              <span>${esc(cleanLabel)} · ${esc(this.firmwareVersion)}</span>
              <button type="button" class="flasher-receipt-edit" data-goto-step="identity" ${this.busy ? "disabled" : ""}>Edit</button>
            </div>
          </div>

          <div class="flasher-receipt-item">
            <span class="note">${isHub ? "2.4 GHz Wi-Fi Mode" : "Radio Link"}</span>
            <div class="flasher-receipt-val mono">
              <span>${esc(wifiSummary)}</span>
              ${
                isHub
                  ? `<button type="button" class="flasher-receipt-edit" data-goto-step="wifi" ${this.busy ? "disabled" : ""}>Edit</button>`
                  : ""
              }
            </div>
          </div>
        </div>

        ${
          this.progress
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
          this.lastSuccessMsg && !this.busy
            ? `<div class="flasher-banner is-ok">
                <span>✓ ${esc(this.lastSuccessMsg)}</span>
                <button type="button" class="btn btn-sm" data-flash-another="1">Flash another timer →</button>
              </div>`
            : ""
        }

        <div class="flasher-actions">
          <button
            type="button"
            class="btn btn-ghost"
            data-wizard-prev="1"
            ${this.busy ? "disabled" : ""}
          >
            ${icons.chevronLeft(15)}
            <span>Back</span>
          </button>

          <button
            type="button"
            class="btn btn-primary"
            data-flash-usb="1"
            ${this.busy || !webSerialOk ? "disabled" : ""}
          >
            ${icons.zap(15)}
            <span>Flash ${esc(this.roleLabel)} "${esc(cleanLabel)}" to USB</span>
          </button>

          <button
            type="button"
            class="btn btn-ghost"
            data-download-bin="1"
            ${this.busy ? "disabled" : ""}
            title="Download the pre-configured .bin image"
          >
            <span>Download .bin</span>
          </button>

          <label class="flasher-port-toggle">
            <input
              type="checkbox"
              data-all-ports="1"
              ${this.showAllPorts ? "checked" : ""}
              ${this.busy ? "disabled" : ""}
            />
            <span>Show all USB serial ports</span>
          </label>
        </div>

        ${
          !webSerialOk
            ? `<p class="note">Direct USB reading and flashing requires Chrome, Edge, or Brave.</p>`
            : ""
        }
      </div>`;
  }

  private renderReadoutCard(): string {
    if (!this.readout) return "";
    return `
      <div class="flasher-readout">
        <div class="flasher-readout-head">
          <span class="flasher-queue-label">Connected timer readout</span>
          <div class="flasher-readout-head-right">
            <span class="mono note">
              ${esc(this.readout.firmwareVersion)}
              ${
                this.readout.firmwareVersion === LATEST_FIRMWARE_VERSION
                  ? `<span class="badge tone-good">Latest</span>`
                  : `<span class="badge tone-warn">Update → ${LATEST_FIRMWARE_VERSION}</span>`
              }
              · ${esc(this.readout.chip)}
            </span>
            <button type="button" class="btn btn-sm btn-ghost" data-clear-readout="1" title="Dismiss readout">
              ${icons.close(13)}
            </button>
          </div>
        </div>
        <div class="flasher-readout-grid">
          <div>
            <span class="note">Timer ID / name</span>
            <div class="mono">${esc(this.readout.timerLabel || "(unnamed)")}</div>
          </div>
          <div>
            <span class="note">Firmware on board</span>
            <div class="mono">${esc(this.readout.firmwareVersion)}</div>
          </div>
          <div>
            <span class="note">Role on board</span>
            <div class="mono">${
              this.readout.role === "hub" ? "Hub (Wi-Fi + ESP-NOW LR)" : "Spoke (ESP-NOW LR)"
            }</div>
          </div>
          <div>
            <span class="note">2.4 GHz Wi-Fi mode</span>
            <div class="mono">${
              this.readout.role === "hub"
                ? esc(
                    this.readout.wifiSSID
                      ? `Join "${this.readout.wifiSSID}" (2.4 GHz)`
                      : 'Host "SlapRF" 2.4 GHz AP (Ch 1)'
                  )
                : "— (uses 2.4 GHz ESP-NOW LR)"
            }</div>
          </div>
          <div>
            <span class="note">5.8 GHz channels</span>
            <div class="mono">${this.readout.frequenciesMHz.join(" · ")} MHz</div>
          </div>
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
      case "role":
        stepContent = this.renderStepRole(webSerialOk);
        break;
      case "identity":
        stepContent = this.renderStepIdentity();
        break;
      case "wifi":
        stepContent = this.renderStepWifi();
        break;
      case "flash":
        stepContent = this.renderStepFlash(webSerialOk);
        break;
    }

    this.el.innerHTML = `
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

        ${this.renderReadoutCard()}
      </div>`;
  }
}
