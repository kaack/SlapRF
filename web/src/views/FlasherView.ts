import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { ApiClient } from "../services/api_client";
import {
  DEFAULT_FIRMWARE_PROFILE,
  EraseResult,
  FIRMWARE_PROFILES,
  FlashProgress,
  LATEST_FIRMWARE_VERSION,
  TimerReadout,
  eraseXiaoC5OverWebSerial,
  firmwareProfile,
  isWebSerialSupported,
  readXiaoC5OverWebSerial,
} from "../services/esp_flasher";
import { forgetKnownHardwareTimer, sharedTimerConsole, TimerStatus } from "../services/timer_console";
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
    this.showAllPorts = sharedTimerConsole.showAllPorts;

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
        sharedTimerConsole.showAllPorts = t.checked;
      }
    });

    this.render();
  }

  public setReadout(info: TimerReadout): void {
    this.readout = info;
    this.errorMsg = null;
    this.render();
  }

  public clearIfMatches(fp?: string): void {
    if (!this.readout) return;
    if (!fp || this.readout.fingerprint === fp) {
      this.readout = null;
      this.errorMsg = null;
      this.render();
    }
  }

  private async readFromUsb(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.errorMsg = null;
    this.progressText = "Connecting to XIAO ESP32-C5 over USB…";
    this.render();

    try {
      const info = await readXiaoC5OverWebSerial(
        (p) => {
          this.progressText = p.detail;
          this.render();
        },
        this.showAllPorts,
        sharedTimerConsole
      );
      this.readout = info;
      this.onRead?.(info);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/No port selected|aborted|cancelled|cancel/i.test(msg)) {
        this.readout = null;
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

/**
 * Eraser panel: factory-resets / erases a Seeed XIAO ESP32-C5 over USB back to a blank chip.
 */
class TimerEraserPanel extends Component {
  private readonly onErased?: (res: EraseResult) => void;
  private busy = false;
  private progress: FlashProgress | null = null;
  private lastSuccessMsg: string | null = null;
  private errorMsg: string | null = null;
  private showAllPorts = false;

  constructor(el: HTMLElement, onErased?: (res: EraseResult) => void) {
    super(el);
    this.onErased = onErased;
    this.showAllPorts = sharedTimerConsole.showAllPorts;

    this.listen(el, "click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("[data-action='erase-timer']")) {
        void this.eraseFromUsb();
      }
    });

    this.listen(el, "change", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.matches("[data-eraser-all-ports]")) {
        this.showAllPorts = t.checked;
        sharedTimerConsole.showAllPorts = t.checked;
      }
    });

    this.render();
  }

  private async eraseFromUsb(): Promise<void> {
    if (this.busy) return;
    const confirmed = window.confirm(
      "Factory-reset and erase all flash memory on the selected XIAO ESP32-C5?\n\nThis wipes its bootloader, partition table, NVS calibration/settings, and SlapRF firmware back to a blank chip."
    );
    if (!confirmed) return;

    this.busy = true;
    this.errorMsg = null;
    this.lastSuccessMsg = null;
    this.progress = {
      stage: "connecting",
      percent: 1,
      detail: "Select the XIAO ESP32-C5 USB port to factory-reset / erase…",
    };
    this.render();

    try {
      const res = await eraseXiaoC5OverWebSerial(
        (p) => {
          this.progress = p;
          if (!this.updateProgressInPlace()) {
            this.render();
          }
        },
        this.showAllPorts,
        sharedTimerConsole
      );

      if (res.previousFp) {
        forgetKnownHardwareTimer(res.previousFp);
      }
      this.onErased?.(res);

      const who = res.previousLabel
        ? `${res.previousRole === "spoke" ? "Spoke" : "Hub"} "${res.previousLabel}"${res.previousFp ? ` (${res.previousFp})` : ""}`
        : "XIAO ESP32-C5";
      this.lastSuccessMsg = `Factory reset complete — ${who} flash memory erased back to a blank chip.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/No port selected|aborted|cancelled|cancel/i.test(msg)) {
        this.errorMsg = msg;
      }
    } finally {
      this.busy = false;
      this.progress = null;
      this.render();
    }
  }

  private updateProgressInPlace(): boolean {
    if (!this.progress) return false;
    const headEl = this.el.querySelector<HTMLElement>("[data-eraser-head]");
    const statusEl = this.el.querySelector<HTMLElement>("[data-eraser-status]");
    const pctEl = this.el.querySelector<HTMLElement>("[data-eraser-pct]");
    const fillEl = this.el.querySelector<HTMLElement>("[data-eraser-fill]");
    const btnTextEl = this.el.querySelector<HTMLElement>("[data-eraser-btn-text]");
    if (!statusEl || !pctEl || !fillEl) return false;
    const pct = Math.max(0, Math.min(100, Math.round(this.progress.percent)));
    if (headEl) headEl.textContent = this.progress.detail;
    statusEl.textContent = this.progress.detail;
    pctEl.textContent = `${pct}%`;
    fillEl.style.width = `${pct}%`;
    if (btnTextEl) {
      btnTextEl.textContent = `Erasing… (${pct}%)`;
    }
    return true;
  }

  private render(): void {
    const webSerialOk = isWebSerialSupported();
    const pct = this.progress
      ? Math.max(0, Math.min(100, Math.round(this.progress.percent)))
      : this.lastSuccessMsg
        ? 100
        : 0;

    const ledClass = this.busy
      ? "is-warn"
      : this.errorMsg
        ? "is-emergency"
        : this.lastSuccessMsg
          ? "is-up"
          : "";

    const headText = this.busy
      ? esc(this.progress?.detail || "Erasing XIAO ESP32-C5 flash over USB…")
      : this.errorMsg
        ? esc(this.errorMsg)
        : this.lastSuccessMsg
          ? `✓ ${esc(this.lastSuccessMsg)}`
          : webSerialOk
            ? "Ready · plug a XIAO ESP32-C5 into USB and click Erase chip to factory-reset it"
            : "Direct USB erasing requires Chrome, Edge, or Brave";

    const statusText = this.progress
      ? this.progress.detail
      : this.errorMsg
        ? `Error: ${this.errorMsg}`
        : this.lastSuccessMsg
          ? `✓ ${this.lastSuccessMsg}`
          : "Wipes bootloader (0x2000), partition table (0x8000), NVS settings (0x9000), and SlapRF firmware + config block (0x10000)";

    this.el.innerHTML = `
      <div class="debug-status-topbar">
        <span class="debug-led-status">
          <span class="status-dot ${ledClass}"></span>
          <span class="debug-head-note" data-eraser-head="1">${headText}</span>
        </span>
        <div class="debug-connect-actions">
          <label class="debug-port-check" title="Include all serial ports in the browser picker">
            <input type="checkbox" data-eraser-all-ports="1" ${this.showAllPorts ? "checked" : ""} ${this.busy ? "disabled" : ""} />
            <span>All ports</span>
          </label>
          <button type="button" class="btn btn-sm btn-bad" data-action="erase-timer" ${this.busy || !webSerialOk ? "disabled" : ""}>
            ${icons.trash(14)}<span data-eraser-btn-text="1">${this.busy ? `Erasing… (${pct}%)` : "Erase chip"}</span>
          </button>
        </div>
      </div>
      <div class="flasher-progress ${this.busy ? "is-flashing" : ""} ${this.lastSuccessMsg && !this.busy ? "is-complete" : ""}">
        <div class="flasher-progress-top">
          <span class="flasher-progress-status" data-eraser-status="1">${esc(statusText)}</span>
          <span class="mono flasher-progress-pct" data-eraser-pct="1">${pct}%</span>
        </div>
        <div class="meter flasher-meter">
          <span class="meter-fill ${this.lastSuccessMsg && !this.busy ? "tone-good" : ""}" data-eraser-fill="1" style="width:${pct}%"></span>
        </div>
      </div>`;
  }
}

/** Flasher page: flash, read, or factory-reset Seeed XIAO ESP32-C5 timers over USB (WebSerial). */
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

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Eraser</h2>
            <p>Factory-reset a Seeed XIAO ESP32-C5 over USB by erasing its bootloader, partition table, NVS calibration, and SlapRF firmware back to a blank chip.</p>
          </div>
          <div class="debug-status-layout" data-slot="eraser"></div>
        </section>
      </div>`;

    let readerPanel: TimerReaderPanel | null = null;
    const flasher = new TimerFlasher(this.slot("flasher"), store, api, (written) => {
      readerPanel?.setReadout(written);
    });
    readerPanel = new TimerReaderPanel(this.slot("reader"), api, (readout) => {
      flasher.applyReadout(readout);
    });
    const eraserPanel = new TimerEraserPanel(this.slot("eraser"), (res) => {
      readerPanel?.clearIfMatches(res.previousFp);
    });
    this.adopt(flasher);
    this.adopt(readerPanel);
    this.adopt(eraserPanel);
  }
}
