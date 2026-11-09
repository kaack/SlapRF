import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ApiClient } from "../services/api_client";
import {
  DEFAULT_FIRMWARE_PROFILE,
  FIRMWARE_PROFILES,
  FlashProgress,
  LATEST_FIRMWARE_VERSION,
  TimerReadout,
  firmwareProfile,
  flashXiaoC5OverWebSerial,
  isWebSerialSupported,
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


/**
 * Interactive Hub & Spoke network flasher wizard for Seeed Studio XIAO ESP32-C5 timers.
 *
 *   - Step 1 (`network`): Pick the **Hub** or **Spoke** role via pictorial cards (same style as
 *     the Wi-Fi mode step); Spoke reveals the **S1–S6** slot chips.
 *   - Step 2 (`identity`): Set **Timer ID / name** (pre-filled from the node you clicked) and
 *     **Firmware version**.
 *   - Step 3 (`wifi`, Hub only): Two visual pictorial diagrams comparing **Station Mode**
 *     (Hub → Router/Hotspot → Laptop) vs **Direct AP Mode** (Hub broadcasts "SlapRF" → Laptop).
 *   - Step 4 (`flash`): Summary receipt + **Flash to USB** / **Download .bin**.
 */
export class TimerFlasher extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;
  private readonly onReadout?: (readout: TimerReadout) => void;

  private step: WizardStepId = "network";
  private slideDir: "next" | "prev" | "none" = "none";
  private role: "hub" | "spoke" = "hub";
  private flashedNodes = new Set<string>();
  private hubWifiMode: HubWifiMode = "join";
  private timerLabel = "H1";
  private firmwareProfileId = DEFAULT_FIRMWARE_PROFILE;
  /** Keep the board's existing fingerprint when reflashing (vs. mint a new one). */
  private keepFingerprint = true;
  private networks: ScannedWifi[] = [];
  private scanningWifi = false;
  private customMode = false;
  private hadStoredWifiPref = false;
  private wifiSSID = "";
  private wifiPass = "";
  private showPassword = false;
  private busy = false;
  private progress: FlashProgress | null = null;
  private lastSuccessMsg: string | null = null;
  private errorMsg: string | null = null;
  private showAllPorts = false;

  constructor(
    el: HTMLElement,
    store: AppStore,
    api: ApiClient,
    onReadout?: (readout: TimerReadout) => void
  ) {
    super(el);
    this.store = store;
    this.api = api;
    this.onReadout = onReadout;

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
        this.goToStep("network", "prev");
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
      } else if (target.matches("[data-fw-profile]")) {
        this.firmwareProfileId = target.value || DEFAULT_FIRMWARE_PROFILE;
        this.slideDir = "none";
        this.render();
      } else if (target.matches("[data-all-ports]")) {
        this.showAllPorts = (target as HTMLInputElement).checked;
      } else if (target.matches("[data-keep-fp]")) {
        this.keepFingerprint = target.value === "keep";
        this.slideDir = "none";
        this.render();
      }
    });

    this.render();
    if (!this.isMobileClient()) {
      void this.refreshWifiNetworks();
    }
  }

  private isMobileClient(): boolean {
    if (typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) {
      return true;
    }
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return window.matchMedia("(max-width: 720px), (pointer: coarse)").matches;
    }
    return false;
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
    return this.role === "hub" ? "Hub" : "Spoke";
  }

  /** Next spoke name (S1, S2, …) not already used by a detected timer or one flashed this session. */
  private suggestSpokeLabel(): string {
    const taken = new Set<string>();
    for (const d of this.store.detectedPucks) {
      if (d.puckLabel) taken.add(d.puckLabel.trim().toUpperCase());
    }
    for (const key of this.flashedNodes) {
      if (key.startsWith("spoke:")) taken.add(key.slice(6));
    }
    for (let n = 1; n <= 99; n++) {
      if (!taken.has(`S${n}`)) return `S${n}`;
    }
    return "S1";
  }

  public applyReadout(info: TimerReadout): void {
    if (this.busy) return;
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
    this.firmwareProfileId = info.firmwareProfile;
    this.slideDir = "none";
    this.render();
  }

  private async flashUsb(): Promise<void> {
    if (!this.validateIdentityStep() || !this.validateWifiStep()) {
      return;
    }
    const cleanLabel = this.timerLabel.trim();
    const label = `${this.role === "hub" ? "Hub" : "Spoke"} "${cleanLabel}"`;
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
        this.firmwareProfileId
      );

      const written = await flashXiaoC5OverWebSerial(
        bytes,
        label,
        (p) => {
          this.progress = p;
          this.slideDir = "none";
          this.render();
        },
        this.showAllPorts,
        this.keepFingerprint
      );

      if (written) {
        this.onReadout?.(written);
      }
      await this.api.provisionTimer(this.role, cleanLabel, this.firmwareProfileId, written?.fingerprint ?? "");
      this.flashedNodes.add(this.role === "hub" ? "hub" : `spoke:${cleanLabel.toUpperCase()}`);
      const fpNote = written?.fingerprintKept
        ? `kept its fingerprint ${written.fingerprint}`
        : `got new fingerprint ${written?.fingerprint ?? ""}`;
      this.lastSuccessMsg = `${label} flashed and ${fpNote} — added to Timers & Track.`;
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
        this.firmwareProfileId
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
   * Step 1: Role picker in the same pictorial-card style as the Wi-Fi mode step.
   * Pick **Hub** (one per network) or **Spoke**; picking Spoke reveals the S1–S6 slot chips.
   */
  private renderStepNetwork(): string {
    const isHub = this.role === "hub";
    const hubFlashed = this.flashedNodes.has("hub");
    const flashedSpokes = [...this.flashedNodes].filter((k) => k.startsWith("spoke:")).length;

    return `
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <div class="flasher-wizard-badge-row">
            <span class="note">Step 1 of ${isHub ? 4 : 3} · One Hub plus up to 6 Spokes per course</span>
          </div>
          <h3>What role will this timer play?</h3>
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
              Usually the start / finish gate. Collects every Spoke's passes and talks to this computer over Wi-Fi.
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
                flashedSpokes > 0 ? `✓ ${flashedSpokes} flashed` : "Up to 6 · Sector gates"
              }</span>
            </div>
            <div class="flasher-pictorial-art">
              ${this.renderPictorialRoleSpoke()}
            </div>
            <p class="flasher-pictorial-desc">
              Placed at each sector gate around the course. Sends its passes to the Hub over long-range ESP-NOW — no Wi-Fi setup needed.
            </p>
          </button>
        </div>

        <div class="flasher-wizard-nav is-end">
          <button type="button" class="btn" data-wizard-next="1" ${this.busy ? "disabled" : ""}>
            <span>Next</span>
            ${icons.chevronRight(15)}
          </button>
        </div>
      </div>`;
  }

  /** Pictorial for the Hub role: Spokes ──▶ Hub ◀── Laptop (Wi-Fi). */
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
    const idPlaceholder = isHub ? "e.g. H1" : "e.g. S1";
    const profile = firmwareProfile(this.firmwareProfileId);

    return `
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <div class="flasher-wizard-badge-row">
            <span class="badge ${isHub ? "tone-good" : ""}">Role: ${
              isHub ? "Hub" : "Spoke"
            }</span>
            <span class="note">${
              isHub
                ? "Step 2 of 4 · Stamped into XIAO flash"
                : "Step 2 of 3 · Stamped into XIAO flash (auto-pairs with Hub)"
            }</span>
          </div>
          <h3>Name this ${isHub ? "Hub" : "Spoke"} &amp; choose firmware</h3>
          <p>The name is how this timer shows up in Timers and on the Track. Pick the firmware that matches your track and where the timer will sit on the gate.</p>
        </div>

        <div class="flasher-wifi-inputs flasher-two-col">
          <div class="flasher-field">
            <label class="flasher-field-label">Timer name</label>
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
              class="input"
              data-fw-profile="1"
              aria-label="Firmware profile"
              ${this.busy ? "disabled" : ""}
            >
              ${FIRMWARE_PROFILES.map(
                (p) =>
                  `<option value="${esc(p.id)}" ${p.id === profile.id ? "selected" : ""}>${esc(p.name)}</option>`
              ).join("")}
            </select>
          </div>
        </div>

        <div class="flasher-profile-hint">
          <div class="flasher-profile-tags">
            <span class="badge">${esc(profile.track)}</span>
            <span class="badge">${esc(profile.mount)}</span>
            <span class="note mono">${LATEST_FIRMWARE_VERSION}</span>
          </div>
          <p>${esc(profile.summary)}</p>
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
    const isMobile = this.isMobileClient();
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
              <span class="flasher-pictorial-title">Hub Connects to Router / Hotspot</span>
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
          <div class="flasher-wifi-inputs flasher-two-col">
            <div class="flasher-field">
              <label class="flasher-field-label">${
                isHostApMode ? "2.4 GHz Hub hotspot SSID" : "2.4 GHz Wi-Fi / hotspot SSID"
              }</label>
              ${
                isHostApMode
                  ? `<input
                      class="input mono"
                      type="text"
                      value="SlapRF · Ch 1 · 192.168.4.1"
                      readonly
                      disabled
                      aria-label="Broadcast hotspot network"
                    />`
                  : isMobile
                    ? `<input
                        class="input"
                        type="text"
                        placeholder="Type 2.4 GHz Wi-Fi / hotspot SSID"
                        value="${esc(this.wifiSSID)}"
                        data-wifi-ssid="1"
                        maxlength="32"
                        spellcheck="false"
                        autocomplete="off"
                        ${this.busy ? "disabled" : ""}
                      />`
                    : useCustom
                      ? `<div class="flasher-pass-wrap has-two-actions">
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
                        <div class="flasher-inline-actions">
                          <button
                            type="button"
                            class="flasher-pass-toggle"
                            data-clear-ssid="1"
                            ${this.busy ? "disabled" : ""}
                            aria-label="Return to scanned Wi-Fi network list"
                            title="Return to scanned Wi-Fi network list"
                          >
                            ${icons.close(14)}
                          </button>
                          <button
                            type="button"
                            class="flasher-pass-toggle"
                            data-refresh-wifi="1"
                            ${this.busy || this.scanningWifi ? "disabled" : ""}
                            aria-label="Rescan nearby 2.4 GHz Wi-Fi networks"
                            title="Rescan nearby 2.4 GHz Wi-Fi networks"
                          >
                            ${icons.reset(14)}
                          </button>
                        </div>
                      </div>`
                    : `<div class="flasher-pass-wrap has-two-actions">
                        <select
                          class="input flasher-ssid-select"
                          data-wifi-select="1"
                          aria-label="2.4 GHz Wi-Fi network to join"
                          ${this.busy ? "disabled" : ""}
                        >
                          ${
                            this.networks.length === 0
                              ? `<option value="" disabled ${!this.wifiSSID ? "selected" : ""}>No networks scanned</option>`
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
                          <option value="${CUSTOM_SSID_VALUE}">Type custom SSID…</option>
                        </select>
                        <div class="flasher-inline-actions">
                          <button
                            type="button"
                            class="flasher-pass-toggle"
                            data-edit-ssid="1"
                            ${this.busy ? "disabled" : ""}
                            aria-label="Type custom Wi-Fi / hotspot name"
                            title="Type custom Wi-Fi / hotspot name"
                          >
                            ${icons.pencil(14)}
                          </button>
                          <button
                            type="button"
                            class="flasher-pass-toggle"
                            data-refresh-wifi="1"
                            ${this.busy || this.scanningWifi ? "disabled" : ""}
                            aria-label="Rescan nearby 2.4 GHz Wi-Fi networks"
                            title="Rescan nearby 2.4 GHz Wi-Fi networks"
                          >
                            ${icons.reset(14)}
                          </button>
                        </div>
                      </div>`
              }
            </div>

            <div class="flasher-field">
              <label class="flasher-field-label">${
                isHostApMode ? "Hotspot password (optional)" : "Wi-Fi / hotspot password"
              }</label>
              <div class="flasher-pass-wrap">
                <input
                  class="input flasher-pass-input"
                  type="${this.showPassword ? "text" : "password"}"
                  placeholder="${
                    isHostApMode ? "Blank = open hotspot (or 8+ chars WPA2)" : "Wi-Fi / hotspot password"
                  }"
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

  private renderStepFlash(webSerialOk: boolean): string {
    const isHub = this.role === "hub";
    const cleanLabel = this.timerLabel.trim() || (isHub ? "H1" : this.suggestSpokeLabel());
    const profile = firmwareProfile(this.firmwareProfileId);
    const wifiSummary = isHub
      ? this.hubWifiMode === "host"
        ? `Hub Hotspot "SlapRF" (${this.wifiPass ? "WPA2" : "Open AP"})`
        : `Join "${this.wifiSSID.trim() || "(unset)"}" (Station Mode)`
      : `ESP-NOW ${profile.link} → Hub`;

    const pct = this.progress ? this.progress.percent : this.lastSuccessMsg ? 100 : 0;
    const statusText = this.progress
      ? this.progress.detail
      : this.lastSuccessMsg
      ? `✓ ${this.lastSuccessMsg}`
      : `Ready to flash ${cleanLabel} over USB-C`;

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
            </div>
          </div>

          <div class="flasher-receipt-item">
            <span class="note">Timer &amp; Firmware</span>
            <div class="flasher-receipt-val" title="${esc(profile.summary)}">
              <span><span class="mono">${esc(cleanLabel)}</span> · ${esc(profile.name)}</span>
            </div>
          </div>

          <div class="flasher-receipt-item">
            <span class="note">${isHub ? "Wi-Fi Connection" : "Radio Link"}</span>
            <div class="flasher-receipt-val mono">
              <span>${esc(wifiSummary)}</span>
            </div>
          </div>
        </div>

        <div class="flasher-fp-option" role="radiogroup" aria-label="Board fingerprint">
          <span class="flasher-field-label">Board fingerprint</span>
          <div class="flasher-fp-choices">
            <label class="flasher-fp-choice ${this.keepFingerprint ? "is-active" : ""}">
              <input type="radio" name="flasher-fp" value="keep" data-keep-fp="keep" ${this.keepFingerprint ? "checked" : ""} ${this.busy ? "disabled" : ""} />
              <span><strong>Keep existing</strong> · Reflash or update this board; it stays the same timer with its color, gate, and history.</span>
            </label>
            <label class="flasher-fp-choice ${!this.keepFingerprint ? "is-active" : ""}">
              <input type="radio" name="flasher-fp" value="new" data-keep-fp="new" ${!this.keepFingerprint ? "checked" : ""} ${this.busy ? "disabled" : ""} />
              <span><strong>Generate new</strong> · Repurposed or swapped board; it shows up as a brand-new timer.</span>
            </label>
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
      </div>`;
  }
}
