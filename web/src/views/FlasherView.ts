import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ApiClient } from "../services/api_client";
import {
  DEFAULT_FIRMWARE_PROFILE,
  LATEST_FIRMWARE_VERSION,
  TimerReadout,
  firmwareProfile,
  isWebSerialSupported,
  readXiaoC5OverWebSerial,
} from "../services/esp_flasher";
import { AppStore } from "../state/store";
import { TimerFlasher } from "../widgets/TimerFlasher";

const RACEBAND = [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917];

function racebandName(mhz: number): string {
  const idx = RACEBAND.indexOf(mhz);
  return idx >= 0 ? `R${idx + 1}` : "";
}

function fmtUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/**
 * Reader panel below the Flasher: uses the same 3-column Status & health layout
 * (Identity & hardware, 5.8 GHz receiver, System & network), grayed out until a reading is taken.
 */
class TimerReaderPanel extends Component {
  private readonly api: ApiClient;
  private readonly onRead?: (readout: TimerReadout) => void;
  private readout: TimerReadout | null = null;
  private busy = false;
  private progressText: string | null = null;
  private errorMsg: string | null = null;
  private showAllPorts = false;

  constructor(el: HTMLElement, api: ApiClient, onRead?: (readout: TimerReadout) => void) {
    super(el);
    this.api = api;
    this.onRead = onRead;

    this.listen(el, "click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("[data-action='read-timer']")) {
        void this.readFromUsb();
      }
    });

    this.listen(el, "change", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.matches("[data-reader-all-ports]")) {
        this.showAllPorts = t.checked;
      }
    });

    this.render();
  }

  public setReadout(info: TimerReadout): void {
    this.readout = info;
    this.errorMsg = null;
    this.render();
  }

  private async readFromUsb(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.errorMsg = null;
    this.progressText = "Connecting to XIAO ESP32-C5 over USB…";
    this.render();

    try {
      const { bytes } = await this.api.fetchFirmwareImage(
        "hub",
        "H1",
        "",
        "",
        DEFAULT_FIRMWARE_PROFILE
      );
      const info = await readXiaoC5OverWebSerial(
        bytes,
        (p) => {
          this.progressText = p.detail;
          this.render();
        },
        this.showAllPorts
      );
      this.readout = info;
      this.onRead?.(info);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/No port selected|aborted|cancelled/i.test(msg)) {
        this.errorMsg = msg;
      }
    } finally {
      this.busy = false;
      this.progressText = null;
      this.render();
    }
  }

  private render(): void {
    const webSerialOk = isWebSerialSupported();
    const r = this.readout;
    const s = r?.status;
    const active = Boolean(r);
    const profile = r ? firmwareProfile(r.firmwareProfile) : undefined;
    const budget = s ? s.sweepBudgetUs || (s.sweepHz ? Math.round(1e6 / s.sweepHz) : 0) : 0;

    const ledClass = this.busy
      ? "is-warn"
      : this.errorMsg
        ? "is-emergency"
        : active
          ? s?.emergencyMode
            ? "is-emergency"
            : "is-up"
          : "";

    const headText = this.busy
      ? esc(this.progressText || "Reading timer over USB…")
      : this.errorMsg
        ? esc(this.errorMsg)
        : r
          ? `Read ${esc(r.timerLabel || "(unnamed)")} · ${r.role === "hub" ? "Hub" : "Spoke"} · ${esc(profile?.name ?? r.firmwareProfile)} (${esc(r.firmwareVersion)})`
          : webSerialOk
            ? "No timer read yet · plug a timer into USB and click Read timer"
            : "Direct USB reading requires Chrome, Edge, or Brave";

    const rfBadge = !r
      ? `<span class="badge">—</span>`
      : s
        ? s.emergencyMode
          ? `<span class="badge badge-bad">Emergency mode</span>`
          : !s.rf.ok
            ? `<span class="badge badge-bad">Boot check failed</span>`
            : !s.rf.enabled
              ? `<span class="badge badge-warn">Switched off</span>`
              : s.scanLive
                ? `<span class="badge badge-accent">Live scan</span>`
                : `<span class="badge badge-good">OK</span>`
        : `<span class="badge badge-good">Configured</span>`;

    const freqs = r?.frequenciesMHz?.length ? r.frequenciesMHz : RACEBAND;
    const chChips = freqs
      .map((f, i) => {
        const rb = racebandName(f) || `Ch${i + 1}`;
        const onCh = active && (s?.chanMask !== undefined ? ((s.chanMask >> i) & 1) !== 0 : true);
        return `<span class="debug-status-ch mono ${onCh ? "" : "is-muted"}" title="${
          active ? `Slot ${i + 1}: ${rb} (${f} MHz)` : `Slot ${i + 1}: ${rb} (${f} MHz) — read a timer to inspect`
        }"><strong>${rb}</strong> ${f}</span>`;
      })
      .join("");

    const fwBadge = r
      ? r.firmwareVersion === LATEST_FIRMWARE_VERSION
        ? ` <span class="badge badge-good">Latest</span>`
        : ` <span class="badge badge-warn">Update → ${LATEST_FIRMWARE_VERSION}</span>`
      : "";

    const netBadge = !r
      ? "—"
      : s?.net
        ? `${esc(s.net.mode)} · Ch ${s.channel}`
        : r.role === "hub"
          ? r.wifiSSID
            ? "STA · 2.4 GHz"
            : "AP · Ch 1"
          : "ESP-NOW LR";

    const wifiLinkText = !r
      ? "—"
      : r.role === "hub"
        ? r.wifiSSID
          ? `Join "${esc(r.wifiSSID)}"${s?.net ? ` <span class="note">· ${s.net.stations} device${s.net.stations === 1 ? "" : "s"}</span>` : ""}`
          : `Host "SlapRF" AP${s?.net ? ` <span class="note">· ${s.net.stations} device${s.net.stations === 1 ? "" : "s"} joined</span>` : ' <span class="note">· Ch 1</span>'}`
        : s && s.slot >= 2
          ? `Joined Hub · slot ${s.slot}`
          : "ESP-NOW LR → Hub";

    this.el.innerHTML = `
      <div class="debug-status-topbar">
        <span class="debug-led-status">
          <span class="status-dot ${ledClass}"></span>
          <span class="debug-head-note">${headText}</span>
        </span>
        <div class="debug-connect-actions">
          <label class="debug-port-check" title="Include all serial ports in the browser picker">
            <input type="checkbox" data-reader-all-ports="1" ${this.showAllPorts ? "checked" : ""} ${this.busy ? "disabled" : ""} />
            <span>All ports</span>
          </label>
          <button type="button" class="btn btn-sm btn-armed" data-action="read-timer" ${this.busy || !webSerialOk ? "disabled" : ""}>
            ${icons.plug(14)}<span>${this.busy ? "Reading…" : "Read timer"}</span>
          </button>
        </div>
      </div>
      <div class="debug-status-panels ${active ? "" : "is-unread"}">
        <div class="debug-subbox">
          <div class="debug-subbox-head">
            <span class="debug-subbox-title ${active ? "is-active" : ""}">${icons.cpu(14)}<span>Identity &amp; hardware</span></span>
            <span class="badge mono">${r ? esc(r.fingerprint || "—") : "—"}</span>
          </div>
          <dl class="debug-kv-list">
            <div class="debug-kv-row">
              <dt>Timer</dt>
              <dd>${r ? `${esc(r.timerLabel || "(unnamed)")} <span class="note">· ${r.role === "hub" ? "Hub" : `Spoke${s?.slot ? ` · slot ${s.slot}` : ""}`}</span>` : "—"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Firmware</dt>
              <dd>${r ? `${esc(profile?.name ?? r.firmwareProfile)} <span class="note mono">· ${esc(r.firmwareVersion)}</span>${fwBadge}` : "—"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Chip &amp; flash</dt>
              <dd>${s?.chip ? `${esc(s.chip.model)} ${esc(s.chip.rev)} <span class="note">· ${s.chip.flashMB} MB</span>` : r ? esc(r.chip) : "—"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>MAC address</dt>
              <dd>${s?.chip?.mac ? `<span class="mono">${esc(s.chip.mac)}</span>` : "—"}</dd>
            </div>
          </dl>
        </div>

        <div class="debug-subbox">
          <div class="debug-subbox-head">
            <span class="debug-subbox-title ${active && (!s || (s.rf.ok && s.rf.enabled)) ? "is-active" : ""}">${icons.signal(14)}<span>5.8 GHz receiver</span></span>
            ${rfBadge}
          </div>
          <dl class="debug-kv-list">
            <div class="debug-kv-row">
              <dt>Noise floor</dt>
              <dd>${s ? `${s.rf.floorDb.toFixed(1)} dBm <span class="note">· gain ${s.rf.gain}/${s.rf.gainMax}</span>` : r ? `<span class="note">Calibrated on boot</span>` : "—"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Sweep timing</dt>
              <dd>${
                s
                  ? `${s.sweepHz} Hz · ${(s.sweepUs / 1000).toFixed(2)} ms <span class="note">(max <span class="${budget && s.sweepUsMax > budget ? "debug-tone-warn" : ""}">${(s.sweepUsMax / 1000).toFixed(2)} ms</span> / ${(budget / 1000).toFixed(1)} ms)</span>`
                  : r && profile
                    ? `${profile.sweepHz} Hz <span class="note">· 8 slots</span>`
                    : "—"
              }</dd>
            </div>
            <div class="debug-kv-row is-channels-row">
              <dt>Channels ${s?.freqsTemporary ? `<span class="badge badge-accent">temp</span>` : ""}</dt>
              <dd class="debug-status-ch-grid">${chChips}</dd>
            </div>
          </dl>
        </div>

        <div class="debug-subbox">
          <div class="debug-subbox-head">
            <span class="debug-subbox-title ${active ? "is-active" : ""}">${icons.wifi(14)}<span>System &amp; network</span></span>
            <span class="badge">${netBadge}</span>
          </div>
          <dl class="debug-kv-list">
            <div class="debug-kv-row">
              <dt>Uptime</dt>
              <dd>${s ? `${fmtUptime(s.uptimeMs)} <span class="note">· boot #${s.boots ?? "?"}</span>` : "—"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Last restart</dt>
              <dd>${s ? esc(s.reset) : "—"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Memory free</dt>
              <dd>${s ? `${(s.heapFree / 1024).toFixed(0)} KB <span class="note">· lowest ${(s.heapMin / 1024).toFixed(0)} KB</span>` : "—"}</dd>
            </div>
            <div class="debug-kv-row">
              <dt>Wi-Fi link</dt>
              <dd>${wifiLinkText}</dd>
            </div>
          </dl>
        </div>
      </div>`;
  }
}

/** Flasher page: flash or read Seeed XIAO ESP32-C5 timers over USB (WebSerial). */
export class FlasherView extends Component {
  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);

    el.innerHTML = `
      <div class="settings">
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Flasher</h2>
            <p>Plug each Seeed XIAO ESP32-C5 into this computer over USB and flash it directly from the browser — no compiler, drivers, or command line needed.</p>
          </div>
          <div class="card" data-slot="flasher"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Timer settings</h2>
            <p>Read a plugged-in timer over USB to inspect its flashed identity, 5.8 GHz receiver channels, and 2.4 GHz network configuration.</p>
          </div>
          <div class="debug-status-layout" data-slot="reader"></div>
        </section>
      </div>`;

    let readerPanel: TimerReaderPanel | null = null;
    const flasher = new TimerFlasher(this.slot("flasher"), store, api, (written) => {
      readerPanel?.setReadout(written);
    });
    readerPanel = new TimerReaderPanel(this.slot("reader"), api, (readout) => {
      flasher.applyReadout(readout);
    });
    this.adopt(flasher);
    this.adopt(readerPanel);
  }
}
