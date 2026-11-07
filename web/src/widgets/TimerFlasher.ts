import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ApiClient } from "../services/api_client";
import {
  FlashProgress,
  PuckReadout,
  flashXiaoC5OverWebSerial,
  isWebSerialSupported,
  readXiaoC5OverWebSerial,
} from "../services/esp_flasher";
import { AppStore } from "../state/store";

const WIFI_SSID_STORAGE_KEY = "slaprf.wifi.ssid";
const CUSTOM_SSID_VALUE = "__custom__";

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
  private timerLabel = "";
  private networks: ScannedWifi[] = [];
  private scanningWifi = false;
  private customMode = false;
  private wifiSSID = "";
  private wifiPass = "";
  private showPassword = false;
  private busy = false;
  private progress: FlashProgress | null = null;
  private readout: PuckReadout | null = null;
  private lastSuccessMsg: string | null = null;
  private errorMsg: string | null = null;
  private showAllPorts = false;

  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);
    this.store = store;
    this.api = api;

    try {
      this.wifiSSID = window.localStorage.getItem(WIFI_SSID_STORAGE_KEY) ?? "";
    } catch {
      // ignore storage errors
    }

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
      if (input.matches("[data-puck-label]")) {
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
      } else if (target.matches("[data-all-ports]")) {
        this.showAllPorts = (target as HTMLInputElement).checked;
      }
    });

    this.render();
    void this.refreshWifiNetworks();
  }

  private saveSSID(ssid: string): void {
    this.wifiSSID = ssid;
    try {
      window.localStorage.setItem(WIFI_SSID_STORAGE_KEY, this.wifiSSID);
    } catch {
      // ignore
    }
  }

  private async refreshWifiNetworks(): Promise<void> {
    this.scanningWifi = true;
    this.render();
    const list = await this.api.listWifiNetworks();
    this.scanningWifi = false;
    this.networks = list;

    if (!this.wifiSSID && list.length > 0) {
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
        this.wifiSSID.trim(),
        this.wifiPass
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
      if (info.puckLabel) {
        this.timerLabel = info.puckLabel;
      }
      if (info.wifiSSID) {
        this.saveSSID(info.wifiSSID);
        if (!this.networks.some((n) => n.ssid === info.wifiSSID)) {
          this.networks = [{ ssid: info.wifiSSID, saved: true }, ...this.networks];
        }
      }
      const idNote = info.puckLabel ? ` (${info.puckLabel})` : "";
      this.lastSuccessMsg = `Read complete — timer is configured as ${
        info.role === "hub" ? "Hub" : "Spoke"
      }${idNote}.`;
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
      this.el.querySelector<HTMLInputElement>("[data-puck-label]")?.focus();
      return;
    }

    if (this.role === "hub" && !this.wifiSSID.trim()) {
      this.errorMsg = "Select or enter a Wi-Fi / hotspot name so the Hub timer can connect to this computer.";
      this.render();
      return;
    }

    const label = `${this.roleLabel} "${cleanLabel}"`;
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
      const ssid = this.role === "hub" ? this.wifiSSID.trim() : "";
      const pass = this.role === "hub" ? this.wifiPass : "";
      const { bytes } = await this.api.fetchFirmwareImage(this.role, cleanLabel, ssid, pass);

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
      await this.api.provisionTimer(this.role, cleanLabel);
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
      const ssid = this.role === "hub" ? this.wifiSSID.trim() : "";
      const pass = this.role === "hub" ? this.wifiPass : "";
      const { bytes, filename } = await this.api.fetchFirmwareImage(this.role, cleanLabel, ssid, pass);
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
    const hasList = this.networks.length > 0;
    const useCustom = this.customMode || !hasList;
    const idPlaceholder = isHub ? "e.g. Hub-1 or Timer-A" : "e.g. Spoke-2, Blue-Timer, or Timer-B";

    return `
      <div class="flasher-wifi">
        <div class="flasher-wifi-head">
          <span class="flasher-queue-label">Timer identity &amp; network</span>
          ${
            isHub
              ? `<button type="button" class="btn btn-sm btn-ghost" data-refresh-wifi="1" ${
                  this.busy || this.scanningWifi ? "disabled" : ""
                } title="Rescan nearby Wi-Fi networks">
                  ${icons.reset(13)}
                  <span>${this.scanningWifi ? "Scanning…" : "Rescan Wi-Fi"}</span>
                </button>`
              : `<span class="note">Spoke connects to Hub automatically over ESP-NOW</span>`
          }
        </div>

        <div class="flasher-wifi-inputs">
          <div class="flasher-field">
            <label class="flasher-field-label">Timer ID / name</label>
            <input class="input mono" type="text" placeholder="${idPlaceholder}" value="${esc(
              this.timerLabel
            )}" data-puck-label="1" maxlength="24" spellcheck="false" autocomplete="off" ${
              this.busy ? "disabled" : ""
            } />
          </div>

          ${
            isHub
              ? `
            <div class="flasher-field">
              <label class="flasher-field-label">Wi-Fi / hotspot (SSID)</label>
              ${
                useCustom
                  ? `<div class="flasher-pass-wrap">
                      <input class="input flasher-pass-input" type="text" placeholder="Type Wi-Fi / hotspot name (SSID)" value="${esc(
                        this.wifiSSID
                      )}" data-wifi-ssid="1" maxlength="32" spellcheck="false" autocomplete="off" ${
                        this.busy ? "disabled" : ""
                      } />
                      ${
                        hasList
                          ? `<button type="button" class="flasher-pass-toggle" data-clear-ssid="1"
                                    aria-label="Clear custom SSID and return to network list"
                                    title="Clear and return to Wi-Fi network list">
                              ${icons.close(14)}
                            </button>`
                          : ""
                      }
                    </div>`
                  : `<div class="flasher-ssid-row">
                      <select class="input flasher-ssid-select" data-wifi-select="1" aria-label="Wi-Fi network (SSID)" ${
                        this.busy ? "disabled" : ""
                      }>
                        ${this.networks
                          .map(
                            (n) =>
                              `<option value="${esc(n.ssid)}" ${
                                n.ssid === this.wifiSSID ? "selected" : ""
                              }>${esc(this.formatNetworkOption(n))}</option>`
                          )
                          .join("")}
                        <option value="${CUSTOM_SSID_VALUE}">Other network…</option>
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
              <label class="flasher-field-label">Wi-Fi password</label>
              <div class="flasher-pass-wrap">
                <input class="input flasher-pass-input" type="${
                  this.showPassword ? "text" : "password"
                }" placeholder="Wi-Fi password" value="${esc(
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
              : ""
          }
        </div>
      </div>`;
  }

  private render(): void {
    const webSerialOk = isWebSerialSupported();
    const isHub = this.role === "hub";

    this.el.innerHTML = `
      <div class="flasher">
        <div class="flasher-roles" role="radiogroup" aria-label="Timer firmware type">
          <button type="button" role="radio" aria-checked="${isHub}" class="flasher-role-card ${isHub ? "is-active" : ""}" data-pick-role="hub" ${
            this.busy ? "disabled" : ""
          }>
            <div class="flasher-role-head">
              <span class="flasher-role-title">Hub</span>
              <span class="badge ${isHub ? "tone-good" : ""}">Wi-Fi + ESP-NOW</span>
            </div>
            <p class="flasher-role-desc">Joins your Wi-Fi network and relays all spokes to this computer. Best placed at whichever gate sits closest to your laptop.</p>
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
              <span class="mono note">${esc(this.readout.firmwareVersion)} · ${esc(this.readout.chip)}</span>
            </div>
            <div class="flasher-readout-grid">
              <div>
                <span class="note">Timer ID / name</span>
                <div class="mono">${esc(this.readout.puckLabel || "(unnamed)")}</div>
              </div>
              <div>
                <span class="note">Role on board</span>
                <div class="mono">${this.readout.role === "hub" ? "Hub (Wi-Fi + ESP-NOW)" : "Spoke (ESP-NOW)"}</div>
              </div>
              <div>
                <span class="note">Wi-Fi SSID</span>
                <div class="mono">${
                  this.readout.role === "hub" ? esc(this.readout.wifiSSID || "(not set)") : "— (uses ESP-NOW)"
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
