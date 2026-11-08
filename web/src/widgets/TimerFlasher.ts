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
type WizardStepId = "network" | "identity" | "wifi" | "flash";

interface ScannedWifi {
  ssid: string;
  signalPct?: number;
  connected?: boolean;
  saved?: boolean;
}

interface SpokeRadialSlot {
  slot: number; // 1..6
  label: string;
  defaultName: string;
  /** Position in 0..100% coordinate space around the central Hub (50%, 50%) */
  xPct: number;
  yPct: number;
  /** SVG coordinates in 520x310 viewBox */
  svgX: number;
  svgY: number;
}

const SPOKE_SLOTS: SpokeRadialSlot[] = [
  { slot: 1, label: "S1", defaultName: "S1", xPct: 50, yPct: 14, svgX: 260, svgY: 43 },
  { slot: 2, label: "S2", defaultName: "S2", xPct: 83, yPct: 31, svgX: 432, svgY: 96 },
  { slot: 3, label: "S3", defaultName: "S3", xPct: 83, yPct: 69, svgX: 432, svgY: 214 },
  { slot: 4, label: "S4", defaultName: "S4", xPct: 50, yPct: 86, svgX: 260, svgY: 267 },
  { slot: 5, label: "S5", defaultName: "S5", xPct: 17, yPct: 69, svgX: 88, svgY: 214 },
  { slot: 6, label: "S6", defaultName: "S6", xPct: 17, yPct: 31, svgX: 88, svgY: 96 },
];

/**
 * Interactive Hub & Spoke network flasher wizard for Seeed Studio XIAO ESP32-C5 timers.
 *
 *   - Step 1 (`network`): Interactive Hub + 6 Spokes network topology map. Click the central
 *     **Hub** or any of the **6 Spokes** (`S1`–`S6`) to configure and flash that node.
 *   - Step 2 (`identity`): Set **Timer ID / name** (pre-filled from the node you clicked) and
 *     **Firmware version**.
 *   - Step 3 (`wifi`, Hub only): Two visual pictorial diagrams comparing **Station Mode**
 *     (Hub → Router/Hotspot → Laptop) vs **Direct AP Mode** (Hub broadcasts "SlapRF" → Laptop).
 *   - Step 4 (`flash`): Summary receipt + **Flash to USB** / **Download .bin**.
 */
export class TimerFlasher extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;

  private step: WizardStepId = "network";
  private slideDir: "next" | "prev" | "none" = "none";
  private role: "hub" | "spoke" = "hub";
  private selectedSpokeSlot = 1;
  private flashedNodes = new Set<string>();
  private hubWifiMode: HubWifiMode = "join";
  private timerLabel = "H1";
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

      const pickNode = t.closest<HTMLElement>("[data-pick-node]");
      if (pickNode) {
        const nodeKey = pickNode.dataset.pickNode || "hub";
        if (nodeKey === "hub") {
          this.role = "hub";
          this.timerLabel = "H1";
        } else {
          const slotNum = Math.max(1, Math.min(6, Number(nodeKey.replace("spoke-", "")) || 1));
          this.role = "spoke";
          this.selectedSpokeSlot = slotNum;
          this.timerLabel = `S${slotNum}`;
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
        this.errorMsg = null;
        this.lastSuccessMsg = null;
        this.readout = null;
        this.goToStep("network", "prev");
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

    this.render();
    void this.refreshWifiNetworks();
  }

  private get orderedSteps(): Array<{ id: WizardStepId; title: string; short: string }> {
    if (this.role === "hub") {
      return [
        { id: "network", title: "Select role", short: "Role" },
        { id: "identity", title: "Name & firmware", short: "Name" },
        { id: "wifi", title: "Wi-Fi mode", short: "Wi-Fi" },
        { id: "flash", title: "Flash timer", short: "Flash" },
      ];
    }
    return [
      { id: "network", title: "Select role", short: "Role" },
      { id: "identity", title: "Name & firmware", short: "Name" },
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
      this.errorMsg = "Give this timer a name (e.g. H1, S1, S2) before continuing.";
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
        'Select or enter a 2.4 GHz Wi-Fi / hotspot SSID to join, or switch to Direct AP mode.';
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
    if (this.step === "network") {
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
      this.goToStep("network", "prev");
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
    return this.role === "hub" ? "Hub" : `Spoke S${this.selectedSpokeSlot}`;
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
        this.timerLabel.trim() || "H1",
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
    const label = `${this.role === "hub" ? "Hub" : "Spoke"} "${cleanLabel}" (${this.firmwareVersion})`;
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
      this.flashedNodes.add(this.role === "hub" ? "hub" : `spoke-${this.selectedSpokeSlot}`);
      this.lastSuccessMsg = `${label} flashed and added to Timers & Track!`;
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

  /**
   * Step 1: Interactive Hub + 6 Spokes network topology diagram.
   * Clicking the central Hub takes you through the Hub flow; clicking any of the 6 Spokes
   * takes you through the Spoke flow. Arrows point from each Spoke (client) -> Hub (host).
   */
  private renderStepNetwork(webSerialOk: boolean): string {
    const isHubSelected = this.role === "hub";
    const hubFlashed = this.flashedNodes.has("hub");
    const cx = 260;
    const cy = 155;
    const hubStopR = 46;
    const spokeStartR = 32;

    const linesSvg = SPOKE_SLOTS.map((s) => {
      const isActive = !isHubSelected && this.selectedSpokeSlot === s.slot;
      const isDone = this.flashedNodes.has(`spoke-${s.slot}`);
      const dx = cx - s.svgX;
      const dy = cy - s.svgY;
      const dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist;
      const uy = dy / dist;
      const x1 = Math.round(s.svgX + ux * spokeStartR);
      const y1 = Math.round(s.svgY + uy * spokeStartR);
      const x2 = Math.round(cx - ux * hubStopR);
      const y2 = Math.round(cy - uy * hubStopR);
      const markerId = isActive ? "net-arrow-active" : isDone ? "net-arrow-done" : "net-arrow";
      return `
        <line
          x1="${x1}" y1="${y1}"
          x2="${x2}" y2="${y2}"
          marker-end="url(#${markerId})"
          class="flasher-net-line ${isActive ? "is-active" : ""} ${isDone ? "is-done" : ""}"
        />`;
    }).join("");

    const spokesHtml = SPOKE_SLOTS.map((s) => {
      const isActive = !isHubSelected && this.selectedSpokeSlot === s.slot;
      const isDone = this.flashedNodes.has(`spoke-${s.slot}`);
      return `
        <button
          type="button"
          class="flasher-net-node is-spoke ${isActive ? "is-selected" : ""} ${isDone ? "is-flashed" : ""}"
          style="left:${s.xPct}%;top:${s.yPct}%"
          data-pick-node="spoke-${s.slot}"
          ${this.busy ? "disabled" : ""}
          title="Click to configure & flash ${s.defaultName} (ESP-NOW Client → Hub)"
        >
          <span class="flasher-net-node-code mono">${s.label}</span>
          <span class="flasher-net-node-sub">${isDone ? "✓ Flashed" : "Client"}</span>
        </button>`;
    }).join("");

    return `
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <h3>Select role to flash</h3>
          <p>Click the central <strong>Hub</strong> (host receiver) or any of the <strong>6 Spokes</strong> (client gate timers that transmit to the Hub).</p>
        </div>

        <div class="flasher-net-canvas" role="group" aria-label="Hub and 6 Spokes role selector">
          <svg class="flasher-net-svg" viewBox="0 0 520 310" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <marker id="net-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="#64748b" />
              </marker>
              <marker id="net-arrow-active" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="#d4ff3a" />
              </marker>
              <marker id="net-arrow-done" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="#34d399" />
              </marker>
            </defs>
            ${linesSvg}
          </svg>

          <button
            type="button"
            class="flasher-net-node is-hub ${isHubSelected ? "is-selected" : ""} ${hubFlashed ? "is-flashed" : ""}"
            style="left:50%;top:50%"
            data-pick-node="hub"
            ${this.busy ? "disabled" : ""}
            title="Click to configure & flash Hub H1 (Host)"
          >
            <span class="flasher-net-hub-icon">${icons.slaprf(18)}</span>
            <span class="flasher-net-node-code mono">H1</span>
            <span class="flasher-net-node-sub">${hubFlashed ? "✓ Flashed" : "Hub · Host"}</span>
          </button>

          ${spokesHtml}
        </div>

        <div class="flasher-net-legend">
          <span><i class="dot-hub"></i><strong>Hub H1 (Host)</strong> · Receives all spokes &amp; bridges over Wi-Fi</span>
          <span><i class="dot-spoke"></i><strong>Spokes S1–S6 (Clients)</strong> · Connect to Hub over ESP-NOW LR</span>
        </div>

        <div class="flasher-inspect-bar">
          <div class="flasher-inspect-text">
            <strong>Already flashed a timer?</strong>
            <span>Plug it into USB to inspect its current Timer name, role, and firmware.</span>
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
    const idPlaceholder = isHub ? "e.g. H1" : `e.g. S${this.selectedSpokeSlot}`;
    const selectedRel =
      FIRMWARE_RELEASES.find((r) => r.version === this.firmwareVersion) ?? FIRMWARE_RELEASES[0];

    return `
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <div class="flasher-wizard-badge-row">
            <span class="badge ${isHub ? "tone-good" : ""}">Role: ${
              isHub ? "Hub (H1)" : `Spoke (S${this.selectedSpokeSlot})`
            }</span>
            <span class="note">${
              isHub
                ? "Step 2 of 4 · Stamped into XIAO flash"
                : "Step 2 of 3 · Stamped into XIAO flash (auto-pairs with Hub)"
            }</span>
          </div>
          <h3>Name this ${isHub ? "Hub" : "Spoke"} &amp; choose firmware</h3>
          <p>This name is written to the board so it identifies itself automatically in Timers and on the Track.</p>
        </div>

        <div class="flasher-wifi-inputs flasher-two-col">
          <div class="flasher-field">
            <label class="flasher-field-label">Timer</label>
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
            <label class="flasher-field-label">Firmware</label>
            <select
              class="input mono"
              data-fw-version="1"
              aria-label="Firmware"
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
   * Renders the simplified SVG pictorial for Station Mode:
   * Hub ---> [Router icon] <--- [Laptop icon]
   */
  private renderPictorialStation(): string {
    return `
      <svg class="flasher-pic-svg" viewBox="0 0 280 68" fill="none" aria-hidden="true">
        <defs>
          <marker id="pic-arrow-sta" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="currentColor" />
          </marker>
        </defs>

        <!-- Client -> Host directional arrows -->
        <line x1="66" y1="34" x2="112" y2="34" class="flasher-pic-link" marker-end="url(#pic-arrow-sta)" />
        <line x1="214" y1="34" x2="168" y2="34" class="flasher-pic-link" marker-end="url(#pic-arrow-sta)" />

        <!-- Hub -->
        <g transform="translate(42, 34)">
          <circle r="20" class="flasher-pic-node is-hub-node" />
          <text y="3.5" text-anchor="middle" class="flasher-pic-node-title">Hub</text>
        </g>

        <!-- Router icon only -->
        <g transform="translate(140, 34)">
          <rect x="-22" y="-20" width="44" height="40" rx="8" class="flasher-pic-node is-host-node" />
          <rect x="-12" y="-1" width="24" height="10" rx="2" stroke="currentColor" stroke-width="1.5" />
          <circle cx="-6" cy="4" r="1.2" fill="currentColor" />
          <circle cx="0" cy="4" r="1.2" fill="currentColor" />
          <line x1="-6" y1="-1" x2="-9" y2="-10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          <line x1="6" y1="-1" x2="9" y2="-10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </g>

        <!-- Laptop icon only -->
        <g transform="translate(238, 34)">
          <rect x="-22" y="-20" width="44" height="40" rx="8" class="flasher-pic-node" />
          <rect x="-11" y="-8" width="22" height="13" rx="1.5" stroke="currentColor" stroke-width="1.5" />
          <path d="M-15 8 H15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </g>
      </svg>`;
  }

  /**
   * Renders the simplified SVG pictorial for Direct AP Mode:
   * Hub <--- [Laptop icon]
   */
  private renderPictorialAp(): string {
    return `
      <svg class="flasher-pic-svg" viewBox="0 0 280 68" fill="none" aria-hidden="true">
        <defs>
          <marker id="pic-arrow-ap" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="currentColor" />
          </marker>
        </defs>

        <!-- Client (Laptop) -> Host (Hub) directional arrow -->
        <line x1="186" y1="34" x2="94" y2="34" class="flasher-pic-link" marker-end="url(#pic-arrow-ap)" />

        <!-- Hub -->
        <g transform="translate(68, 34)">
          <circle r="20" class="flasher-pic-node is-hub-node is-host-node" />
          <text y="3.5" text-anchor="middle" class="flasher-pic-node-title">Hub</text>
        </g>

        <!-- Laptop icon only -->
        <g transform="translate(212, 34)">
          <rect x="-22" y="-20" width="44" height="40" rx="8" class="flasher-pic-node" />
          <rect x="-11" y="-8" width="22" height="13" rx="1.5" stroke="currentColor" stroke-width="1.5" />
          <path d="M-15 8 H15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </g>
      </svg>`;
  }

  private renderStepWifi(): string {
    const isHostApMode = this.hubWifiMode === "host";
    const useCustom = this.customMode;

    return `
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <div class="flasher-wizard-badge-row">
            <span class="badge tone-good">Role: Hub · ${esc(this.timerLabel.trim() || "H1")}</span>
            <span class="note">Step 3 of 4 · 2.4 GHz Wi-Fi only (5.8 GHz is disabled to protect FPV video)</span>
          </div>
          <h3>How should the Hub connect to your computer?</h3>
        </div>

        <div class="flasher-pictorial-grid" role="radiogroup" aria-label="Hub 2.4 GHz Wi-Fi mode">
          <button
            type="button"
            role="radio"
            aria-checked="${!isHostApMode}"
            class="flasher-pictorial-card ${!isHostApMode ? "is-active" : ""}"
            data-pick-hub-mode="join"
            ${this.busy ? "disabled" : ""}
          >
            <div class="flasher-pictorial-head">
              <span class="flasher-pictorial-title">Connect to Router / Hotspot</span>
              <span class="badge ${!isHostApMode ? "tone-good" : ""}">Station Mode</span>
            </div>
            <div class="flasher-pictorial-art">
              ${this.renderPictorialStation()}
            </div>
            <p class="flasher-pictorial-desc">
              Hub joins your phone hotspot or field router. Best when your laptop stays on internet Wi-Fi.
            </p>
          </button>

          <button
            type="button"
            role="radio"
            aria-checked="${isHostApMode}"
            class="flasher-pictorial-card ${isHostApMode ? "is-active" : ""}"
            data-pick-hub-mode="host"
            ${this.busy ? "disabled" : ""}
          >
            <div class="flasher-pictorial-head">
              <span class="flasher-pictorial-title">Hub Acts as Hotspot</span>
              <span class="badge ${isHostApMode ? "tone-good" : ""}">Direct AP · Ch 1</span>
            </div>
            <div class="flasher-pictorial-art">
              ${this.renderPictorialAp()}
            </div>
            <p class="flasher-pictorial-desc">
              Hub broadcasts its own <strong>"SlapRF"</strong> Wi-Fi (<code>192.168.4.1</code>). Connect your laptop directly to it.
            </p>
          </button>
        </div>

        <div class="flasher-wifi-panel">
          ${
            isHostApMode
              ? `
            <div class="flasher-wifi-inputs flasher-two-col">
              <div class="flasher-field">
                <label class="flasher-field-label">Broadcast hotspot network (automatic)</label>
                <div class="flasher-ap-summary mono">
                  <span class="badge tone-good">SSID: SlapRF</span>
                  <span>2.4 GHz Ch 1</span>
                  <span class="muted">·</span>
                  <span>192.168.4.1</span>
                </div>
              </div>

              <div class="flasher-field">
                <label class="flasher-field-label">SlapRF hotspot password (optional)</label>
                <div class="flasher-pass-wrap">
                  <input
                    class="input flasher-pass-input"
                    type="${this.showPassword ? "text" : "password"}"
                    placeholder="Blank = open hotspot (or 8+ chars WPA2)"
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
              <span class="flasher-field-label">Select the 2.4 GHz router or phone hotspot the Hub should join</span>
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
    const cleanLabel = this.timerLabel.trim() || (isHub ? "H1" : `S${this.selectedSpokeSlot}`);
    const wifiSummary = isHub
      ? this.hubWifiMode === "host"
        ? `Hub Hotspot "SlapRF" (${this.wifiPass ? "WPA2" : "Open AP"})`
        : `Join "${this.wifiSSID.trim() || "(unset)"}" (Station Mode)`
      : "2.4 GHz ESP-NOW LR (Client → Hub H1)";

    const pct = this.progress ? this.progress.percent : this.lastSuccessMsg ? 100 : 0;
    const statusText = this.progress
      ? this.progress.detail
      : this.lastSuccessMsg
      ? `✓ ${this.lastSuccessMsg}`
      : `Ready to flash ${cleanLabel} (${this.firmwareVersion}) over USB-C`;

    return `
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <h3>Ready to flash ${esc(cleanLabel)}</h3>
          <p>Plug your <strong>Seeed Studio XIAO ESP32-C5</strong> into USB-C and click <strong>Flash to USB</strong>.</p>
        </div>

        <div class="flasher-receipt">
          <div class="flasher-receipt-item">
            <span class="note">Role</span>
            <div class="flasher-receipt-val">
              <span class="badge ${isHub ? "tone-good" : ""}">${
                isHub ? "Hub" : "Spoke"
              }</span>
              <button type="button" class="flasher-receipt-edit" data-goto-step="network" ${this.busy ? "disabled" : ""}>Change</button>
            </div>
          </div>

          <div class="flasher-receipt-item">
            <span class="note">Timer &amp; Firmware</span>
            <div class="flasher-receipt-val mono">
              <span>${esc(cleanLabel)} · ${esc(this.firmwareVersion)}</span>
              <button type="button" class="flasher-receipt-edit" data-goto-step="identity" ${this.busy ? "disabled" : ""}>Edit</button>
            </div>
          </div>

          <div class="flasher-receipt-item">
            <span class="note">${isHub ? "Wi-Fi Connection" : "Radio Link"}</span>
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

        <div class="flasher-progress ${this.busy ? "is-flashing" : ""} ${this.lastSuccessMsg && !this.busy ? "is-complete" : ""}">
          <div class="flasher-progress-top">
            <span class="flasher-progress-status">${esc(statusText)}</span>
            <span class="mono flasher-progress-pct">${pct}%</span>
          </div>
          <div class="meter flasher-meter">
            <span class="meter-fill ${this.lastSuccessMsg && !this.busy ? "tone-good" : ""}" style="width:${pct}%"></span>
          </div>
          <div class="flasher-progress-foot">
            <label class="flasher-port-toggle">
              <input
                type="checkbox"
                data-all-ports="1"
                ${this.showAllPorts ? "checked" : ""}
                ${this.busy ? "disabled" : ""}
              />
              <span>Show all USB serial ports</span>
            </label>
            <div class="flasher-progress-foot-actions">
              ${
                this.lastSuccessMsg && !this.busy
                  ? `<button type="button" class="btn btn-sm" data-flash-another="1">Select another role →</button>`
                  : ""
              }
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
            ? `<p class="note">Direct USB reading and flashing requires Chrome, Edge, or Brave.</p>`
            : ""
        }

        <div class="flasher-wizard-nav">
          <button
            type="button"
            class="btn"
            data-wizard-prev="1"
            ${this.busy ? "disabled" : ""}
          >
            ${icons.chevronLeft(15)}
            <span>Back</span>
          </button>

          <button
            type="button"
            class="btn flasher-btn-flash"
            data-flash-usb="1"
            ${this.busy || !webSerialOk ? "disabled" : ""}
          >
            <span class="flasher-zap-icon">${icons.zap(15)}</span>
            <span>${this.busy ? `Flashing ${esc(cleanLabel)}… (${pct}%)` : `Flash ${esc(cleanLabel)} to USB`}</span>
          </button>
        </div>
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
            <span class="note">Timer</span>
            <div class="mono">${esc(this.readout.timerLabel || "(unnamed)")}</div>
          </div>
          <div>
            <span class="note">Role</span>
            <div class="mono">${
              this.readout.role === "hub" ? "Hub" : "Spoke"
            }</div>
          </div>
          <div>
            <span class="note">Firmware</span>
            <div class="mono">${esc(this.readout.firmwareVersion)}</div>
          </div>
          <div>
            <span class="note">2.4 GHz link</span>
            <div class="mono">${
              this.readout.role === "hub"
                ? esc(
                    this.readout.wifiSSID
                      ? `Join "${this.readout.wifiSSID}" (2.4 GHz)`
                      : 'Host "SlapRF" 2.4 GHz AP (Ch 1)'
                  )
                : "2.4 GHz ESP-NOW LR (Client → Hub)"
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
      case "network":
        stepContent = this.renderStepNetwork(webSerialOk);
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
