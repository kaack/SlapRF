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

interface ScannedWifi {
  ssid: string;
  signalPct?: number;
  connected?: boolean;
  saved?: boolean;
}

/**
 * Browser USB firmware flasher & reader for Seeed Studio XIAO ESP32-C5 timers.
 *
 * Lets the user:
 *   1. Choose the timer role: **Hub** (Wi-Fi + ESP-NOW bridge to laptop) or **Spoke** (ESP-NOW
 *      node that sends readings to the Hub). Either can be placed on any gate on the track.
 *   2. Give the timer a unique **Timer ID / name** (stamped onto the board and shown across
 *      the UI unless overridden by a gate name).
 *   3. For the Hub, pick the Wi-Fi / hotspot name from a dropdown of detected
 *      networks and reveal/hide the typed password.
 *   4. **Read timer from USB** or **Flash to USB** over WebSerial.
 */
export class TimerFlasher extends Component {
  private readonly store: AppStore;
  private readonly api: ApiClient;

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

      const pickRole = t.closest<HTMLElement>("[data-pick-role]");
      if (pickRole) {
        const nextRole = pickRole.dataset.pickRole === "spoke" ? "spoke" : "hub";
        if (nextRole === this.role) return;
        this.role = nextRole;
        this.errorMsg = null;
        this.render();
        return;
      }

      const pickHubMode = t.closest<HTMLElement>("[data-pick-hub-mode]");
      if (pickHubMode) {
        const nextMode: HubWifiMode = pickHubMode.dataset.pickHubMode === "host" ? "host" : "join";
        if (nextMode === this.hubWifiMode) return;
        this.saveHubWifiMode(nextMode);
        this.errorMsg = null;
        this.render();
        return;
      }

      if (t.closest("[data-refresh-wifi]")) {
        void this.refreshWifiNetworks();
        return;
      }

      if (t.closest("[data-edit-ssid]")) {
        this.customMode = true;
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
          this.render();
          this.el.querySelector<HTMLInputElement>("[data-wifi-ssid]")?.focus();
        } else {
          this.customMode = false;
          this.saveSSID(val);
          this.render();
        }
      } else if (target.matches("[data-fw-version]")) {
        this.firmwareVersion = target.value || LATEST_FIRMWARE_VERSION;
        this.render();
      } else if (target.matches("[data-all-ports]")) {
        this.showAllPorts = (target as HTMLInputElement).checked;
      }
    });

    this.render();
    void this.refreshWifiNetworks();
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
    this.render();
  }

  private get roleLabel(): string {
    return this.role === "hub" ? "Hub" : "Spoke";
  }

  private async readUsb(): Promise<void> {
    this.busy = true;
    this.errorMsg = null;
    this.lastSuccessMsg = null;
    this.progress = {
      stage: "connecting",
      percent: 10,
      detail: "Connecting to XIAO ESP32-C5 over USB…",
    };
    this.render();

    try {
      const { bytes } = await this.api.fetchFirmwareImage(
        this.role,
        this.timerLabel.trim(),
        this.effectiveHubSSID,
        this.wifiPass,
        this.firmwareVersion
      );
      const info = await readXiaoC5OverWebSerial(
        bytes,
        (p) => {
          this.progress = p;
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
      this.render();
    }
  }

  private async flashUsb(): Promise<void> {
    const cleanLabel = this.timerLabel.trim();
    if (!cleanLabel) {
      this.errorMsg = "Give this timer an ID / name (e.g. Hub-1, Blue-Timer, Gate-A) before flashing.";
      this.render();
      this.el.querySelector<HTMLInputElement>("[data-timer-label]")?.focus();
      return;
    }

    if (this.role === "hub") {
      if (this.hubWifiMode === "join" && !this.wifiSSID.trim()) {
        this.errorMsg =
          'Select or enter a 2.4 GHz Wi-Fi / hotspot SSID to join, or switch to Host "SlapRF" 2.4 GHz AP mode.';
        this.render();
        return;
      }
      if (this.hubWifiMode === "host" && this.wifiPass.length > 0 && this.wifiPass.length < 8) {
        this.errorMsg =
          "WPA2 password for the SlapRF AP must be at least 8 characters (or leave blank for an open AP).";
        this.render();
        return;
      }
    }

    const label = `${this.roleLabel} "${cleanLabel}" (${this.firmwareVersion})`;
    this.busy = true;
    this.errorMsg = null;
    this.lastSuccessMsg = null;
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
          this.render();
        },
        this.showAllPorts
      );

      if (written) {
        this.readout = written;
      }
      await this.api.provisionTimer(this.role, cleanLabel, this.firmwareVersion);
      this.lastSuccessMsg = `${label} flashed and added to Timers & Track! You can unplug this XIAO and plug in the next one.`;
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
      this.render();
    }
  }

  private async downloadBin(): Promise<void> {
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

  private renderConfigSection(): string {
    const isHub = this.role === "hub";
    const isHostApMode = this.hubWifiMode === "host";
    const useCustom = this.customMode;
    const idPlaceholder = isHub ? "e.g. Hub-1 or Timer-A" : "e.g. Spoke-2, Blue-Timer, or Timer-B";
    const selectedRel =
      FIRMWARE_RELEASES.find((r) => r.version === this.firmwareVersion) ?? FIRMWARE_RELEASES[0];

    return `
      <div class="flasher-wifi">
        <div class="flasher-wifi-head">
          <span class="flasher-queue-label">1. Timer identity &amp; firmware release</span>
          ${
            !isHub
              ? `<span class="note">Spoke auto-locks to Hub's 2.4 GHz LR channel (never uses 5.8 GHz TX)</span>`
              : `<span class="note">Stamped into XIAO flash so the timer identifies itself automatically</span>`
          }
        </div>

        <div class="flasher-wifi-inputs flasher-two-col">
          <div class="flasher-field">
            <label class="flasher-field-label">Timer ID / name</label>
            <input class="input mono" type="text" placeholder="${idPlaceholder}" value="${esc(
              this.timerLabel
            )}" data-timer-label="1" maxlength="24" spellcheck="false" autocomplete="off" ${
              this.busy ? "disabled" : ""
            } />
          </div>

          <div class="flasher-field">
            <label class="flasher-field-label">Firmware version</label>
            <select class="input mono" data-fw-version="1" aria-label="Firmware version" title="${esc(
              selectedRel.summary
            )}" ${this.busy ? "disabled" : ""}>
              ${FIRMWARE_RELEASES.map(
                (rel) =>
                  `<option value="${esc(rel.version)}" ${
                    rel.version === this.firmwareVersion ? "selected" : ""
                  }>${esc(rel.label)}</option>`
              ).join("")}
            </select>
          </div>
        </div>
      </div>

      ${
        isHub
          ? `
      <div class="flasher-wifi">
        <div class="flasher-wifi-head">
          <span class="flasher-queue-label">2. Hub 2.4 GHz Wi-Fi connection mode</span>
          ${
            !isHostApMode
              ? `<button type="button" class="btn btn-sm btn-ghost" data-refresh-wifi="1" ${
                  this.busy || this.scanningWifi ? "disabled" : ""
                } title="Rescan nearby 2.4 GHz Wi-Fi networks">
                  ${icons.reset(13)}
                  <span>${this.scanningWifi ? "Scanning…" : "Rescan Wi-Fi"}</span>
                </button>`
              : `<span class="note">2.4 GHz only — 5.8 GHz Wi-Fi is hardware-disabled to protect FPV video</span>`
          }
        </div>

        <div class="flasher-mobile-switch" role="tablist" aria-label="Hub 2.4 GHz Wi-Fi connection mode">
          <button type="button" class="flasher-mobile-tab ${!isHostApMode ? "is-active" : ""}" data-pick-hub-mode="join" ${this.busy ? "disabled" : ""}>
            <span>Join Hotspot / Router</span>
            <span class="badge ${!isHostApMode ? "tone-good" : ""}">Station</span>
          </button>
          <button type="button" class="flasher-mobile-tab ${isHostApMode ? "is-active" : ""}" data-pick-hub-mode="host" ${this.busy ? "disabled" : ""}>
            <span>Host "SlapRF" AP</span>
            <span class="badge ${isHostApMode ? "tone-good" : ""}">Direct AP</span>
          </button>
        </div>

        <div class="flasher-roles flasher-hub-modes" role="radiogroup" aria-label="Hub 2.4 GHz Wi-Fi connection mode">
          <button type="button" role="radio" aria-checked="${!isHostApMode}" class="flasher-role-card is-compact ${
            !isHostApMode ? "is-active" : ""
          }" data-pick-hub-mode="join" ${this.busy ? "disabled" : ""}>
            <div class="flasher-role-head">
              <span class="flasher-role-title">Join 2.4 GHz Hotspot / Router</span>
              <span class="badge ${!isHostApMode ? "tone-good" : ""}">Station Mode</span>
            </div>
            <p class="flasher-role-desc">Hub joins your phone hotspot, laptop hotspot, or field router (2.4 GHz). Best when your laptop stays on 5 GHz Wi-Fi / internet.</p>
          </button>

          <button type="button" role="radio" aria-checked="${isHostApMode}" class="flasher-role-card is-compact ${
            isHostApMode ? "is-active" : ""
          }" data-pick-hub-mode="host" ${this.busy ? "disabled" : ""}>
            <div class="flasher-role-head">
              <span class="flasher-role-title">Host "SlapRF" 2.4 GHz AP</span>
              <span class="badge ${isHostApMode ? "tone-good" : ""}">Direct AP · Ch 1</span>
            </div>
            <p class="flasher-role-desc">Hub broadcasts its own <strong>"SlapRF"</strong> 2.4 GHz network (<code>192.168.4.1</code>). Connect your laptop's Wi-Fi directly to <strong>SlapRF</strong> — no hotspot or router needed.</p>
          </button>
        </div>

        <div class="flasher-wifi-inputs flasher-two-col">
          ${
            isHostApMode
              ? `
            <div class="flasher-field">
              <label class="flasher-field-label">Broadcast 2.4 GHz AP network (automatic)</label>
              <div class="flasher-ap-summary mono">
                <span class="badge tone-good">SSID: SlapRF</span>
                <span>2.4 GHz Ch 1</span>
                <span class="muted">·</span>
                <span>Hub IP 192.168.4.1</span>
              </div>
            </div>

            <div class="flasher-field">
              <label class="flasher-field-label">SlapRF AP password (optional)</label>
              <div class="flasher-pass-wrap">
                <input class="input flasher-pass-input" type="${
                  this.showPassword ? "text" : "password"
                }" placeholder="Leave blank for open SlapRF AP (or 8+ chars WPA2)" value="${esc(
                  this.wifiPass
                )}" data-wifi-pass="1" maxlength="39" spellcheck="false" autocomplete="off" ${
                  this.busy ? "disabled" : ""
                } />
                <button type="button" class="flasher-pass-toggle" data-toggle-pass="1"
                        aria-label="${this.showPassword ? "Hide password" : "Show password"}"
                        title="${this.showPassword ? "Hide password" : "Show password"}">
                  ${this.showPassword ? icons.eyeOff(15) : icons.eye(15)}
                </button>
              </div>
            </div>`
              : `
            <div class="flasher-field">
              <label class="flasher-field-label">2.4 GHz Wi-Fi / hotspot SSID to join</label>
              ${
                useCustom
                  ? `<div class="flasher-pass-wrap">
                      <input class="input flasher-pass-input" type="text" placeholder="Type 2.4 GHz Wi-Fi / hotspot SSID" value="${esc(
                        this.wifiSSID
                      )}" data-wifi-ssid="1" maxlength="32" spellcheck="false" autocomplete="off" ${
                        this.busy ? "disabled" : ""
                      } />
                      <button type="button" class="flasher-pass-toggle" data-clear-ssid="1"
                                aria-label="Return to scanned Wi-Fi network list"
                                title="Return to scanned Wi-Fi network list">
                          ${icons.close(14)}
                      </button>
                    </div>`
                  : `<div class="flasher-ssid-row">
                      <select class="input flasher-ssid-select" data-wifi-select="1" aria-label="2.4 GHz Wi-Fi network to join" ${
                        this.busy ? "disabled" : ""
                      }>
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
                      <button type="button" class="btn btn-icon flasher-ssid-edit" data-edit-ssid="1" ${
                        this.busy ? "disabled" : ""
                      } aria-label="Type custom Wi-Fi / hotspot name" title="Type custom Wi-Fi / hotspot name">
                        ${icons.pencil(14)}
                      </button>
                    </div>`
              }
            </div>

            <div class="flasher-field">
              <label class="flasher-field-label">Wi-Fi / hotspot password</label>
              <div class="flasher-pass-wrap">
                <input class="input flasher-pass-input" type="${
                  this.showPassword ? "text" : "password"
                }" placeholder="Wi-Fi / hotspot password" value="${esc(
                  this.wifiPass
                )}" data-wifi-pass="1" maxlength="39" spellcheck="false" autocomplete="off" ${
                  this.busy ? "disabled" : ""
                } />
                <button type="button" class="flasher-pass-toggle" data-toggle-pass="1"
                        aria-label="${this.showPassword ? "Hide password" : "Show password"}"
                        title="${this.showPassword ? "Hide password" : "Show password"}">
                  ${this.showPassword ? icons.eyeOff(15) : icons.eye(15)}
                </button>
              </div>
            </div>`
          }
        </div>
      </div>`
          : ""
      }`;
  }

  private render(): void {
    const webSerialOk = isWebSerialSupported();
    const isHub = this.role === "hub";

    this.el.innerHTML = `
      <div class="flasher">
        <div class="flasher-mobile-switch" role="tablist" aria-label="Timer firmware type">
          <button type="button" class="flasher-mobile-tab ${isHub ? "is-active" : ""}" data-pick-role="hub" ${this.busy ? "disabled" : ""}>
            <span>Hub</span>
            <span class="badge ${isHub ? "tone-good" : ""}">Wi-Fi + ESP-NOW</span>
          </button>
          <button type="button" class="flasher-mobile-tab ${!isHub ? "is-active" : ""}" data-pick-role="spoke" ${this.busy ? "disabled" : ""}>
            <span>Spoke</span>
            <span class="badge ${!isHub ? "tone-good" : ""}">ESP-NOW</span>
          </button>
        </div>

        <div class="flasher-roles" role="radiogroup" aria-label="Timer firmware type">
          <button type="button" role="radio" aria-checked="${isHub}" class="flasher-role-card ${isHub ? "is-active" : ""}" data-pick-role="hub" ${
            this.busy ? "disabled" : ""
          }>
            <div class="flasher-role-head">
              <span class="flasher-role-title">Hub</span>
              <span class="badge ${isHub ? "tone-good" : ""}">Wi-Fi + ESP-NOW</span>
            </div>
            <p class="flasher-role-desc">Relays all spokes to this computer over 2.4 GHz Wi-Fi (either by joining your hotspot/router or hosting its own "SlapRF" AP).</p>
          </button>

          <button type="button" role="radio" aria-checked="${!isHub}" class="flasher-role-card ${!isHub ? "is-active" : ""}" data-pick-role="spoke" ${
            this.busy ? "disabled" : ""
          }>
            <div class="flasher-role-head">
              <span class="flasher-role-title">Spoke</span>
              <span class="badge ${!isHub ? "tone-good" : ""}">ESP-NOW</span>
            </div>
            <p class="flasher-role-desc">Sends readings directly to the hub over ESP-NOW (no Wi-Fi needed). Can be placed on any gate on the track.</p>
          </button>
        </div>

        ${this.renderConfigSection()}

        ${
          this.readout
            ? `
          <div class="flasher-readout">
            <div class="flasher-readout-head">
              <span class="flasher-queue-label">Connected timer</span>
              <span class="mono note">
                ${esc(this.readout.firmwareVersion)}
                ${
                  this.readout.firmwareVersion === LATEST_FIRMWARE_VERSION
                    ? `<span class="badge tone-good">Latest</span>`
                    : `<span class="badge tone-warn">Update → ${LATEST_FIRMWARE_VERSION}</span>`
                }
                · ${esc(this.readout.chip)}
              </span>
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
                <div class="mono">${this.readout.role === "hub" ? "Hub (Wi-Fi + ESP-NOW LR)" : "Spoke (ESP-NOW LR)"}</div>
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
          </div>`
            : ""
        }

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
            ? `<div class="flasher-banner is-ok">✓ ${esc(this.lastSuccessMsg)}</div>`
            : ""
        }

        ${
          this.errorMsg && !this.busy
            ? `<div class="flasher-banner is-err">${esc(this.errorMsg)}</div>`
            : ""
        }

        <div class="flasher-actions">
          <button type="button" class="btn btn-primary" data-flash-usb="1" ${
            this.busy || !webSerialOk ? "disabled" : ""
          }>
            ${icons.zap(15)}
            <span>Flash ${esc(this.roleLabel)} to USB</span>
          </button>
          <button type="button" class="btn" data-read-usb="1" ${this.busy || !webSerialOk ? "disabled" : ""}
                  title="Read the current Timer ID, role, and settings from the plugged-in XIAO ESP32-C5">
            <span>Read timer from USB</span>
          </button>
          <button type="button" class="btn btn-ghost" data-download-bin="1" ${this.busy ? "disabled" : ""}
                  title="Download the pre-configured .bin image">
            <span>Download .bin</span>
          </button>
          <label class="flasher-port-toggle">
            <input type="checkbox" data-all-ports="1" ${this.showAllPorts ? "checked" : ""} ${
              this.busy ? "disabled" : ""
            } />
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
}
