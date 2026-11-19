import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { lookupBandChannelByFreqMHz } from "../core/vtx_channels";
import { ApiClient } from "../services/api_client";
import {
  FIRMWARE_SWEEP_HZ,
  FlashProgress,
  LATEST_FIRMWARE_VERSION,
  TimerReadout,
  cancelActiveFlash,
  eraseXiaoC5OverWebSerial,
} from "../services/esp_flasher";
import {
  FLASHER_NEEDS_WEBSERIAL,
  acquireEspSerialPort,
  eraseXiaoC5WithEsptool,
  flasherUsesWebSerial,
  hasBrowserWebSerial,
  readXiaoC5WithWebSerial,
} from "../services/esptool_flasher";
import { isSimulatedUsbMode } from "../services/sim_serial_port";
import { sharedTimerConsole, TimerStatus, usbPool } from "../services/timer_console";
import { AppStore } from "../state/store";
import { TimerFlasher } from "../widgets/TimerFlasher";

const RACEBAND = [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917];
const FLASHER_PORTS_STORAGE_KEY = "slaprf.ui.flasher_ports.v2";

function loadPortPref(): boolean {
  try {
    const raw = window.localStorage.getItem(FLASHER_PORTS_STORAGE_KEY);
    if (raw === "true") {
      sharedTimerConsole.showAllPorts = true;
      return true;
    }
    if (raw === "false") {
      sharedTimerConsole.showAllPorts = false;
      return false;
    }
  } catch {
    // ignore
  }
  sharedTimerConsole.showAllPorts = false;
  return false;
}

function savePortPref(val: boolean): void {
  sharedTimerConsole.showAllPorts = val;
  try {
    window.localStorage.setItem(FLASHER_PORTS_STORAGE_KEY, String(val));
  } catch {
    // ignore
  }
}

function racebandName(mhz: number): string {
  return lookupBandChannelByFreqMHz(mhz)?.shortCode ?? "";
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
  private lastPanelsHtml = "";

  constructor(el: HTMLElement, api: ApiClient, onRead?: (readout: TimerReadout) => void) {
    super(el);
    this.api = api;
    this.onRead = onRead;
    this.showAllPorts = loadPortPref();

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
        savePortPref(t.checked);
      }
    });

    this.render();
  }

  public setReadout(info: TimerReadout | null): void {
    this.readout = info;
    this.errorMsg = null;
    this.render();
  }

  private async readFromUsb(): Promise<void> {
    if (this.busy) return;
    const browser = flasherUsesWebSerial();
    const activeConsole = usbPool.mainConsole;
    this.busy = true;
    this.errorMsg = null;
    this.progressText = !browser && activeConsole.connected
      ? "Reading timer configuration over USB…"
      : "Select the XIAO ESP32-C5 USB port to read…";
    this.render();

    try {
      if (browser) {
        // One-shot: pick the port, read the board, close the port.
        const info = await readXiaoC5WithWebSerial();
        if (!info) {
          throw new Error("No SlapRF firmware answered on this board. Use Writer below to flash it.");
        }
        this.readout = info;
        this.onRead?.(info);
        return;
      }
      if (!isSimulatedUsbMode()) throw new Error(FLASHER_NEEDS_WEBSERIAL);
      // Simulation / Demo mode: read the simulated board.
      if (!activeConsole.connected) {
        await usbPool.connectMain(this.showAllPorts);
        this.progressText = "Reading timer configuration over USB…";
        this.render();
      }
      const info = await activeConsole.readSnapshot();
      this.readout = info;
      this.onRead?.(info);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/No port selected|aborted|cancelled|cancel/i.test(msg)) {
        this.errorMsg = msg;
      }
    } finally {
      this.busy = false;
      this.progressText = null;
      this.render();
    }
  }

  private render(): void {
    const browser = flasherUsesWebSerial();
    const webSerialOk = browser || isSimulatedUsbMode();
    const activeConsole = usbPool.mainConsole;
    const isConnected = !browser && activeConsole.connected;
    const isOther = !browser && activeConsole.isOtherDevice;
    const r = this.readout;
    const s = r?.status;
    const active = Boolean(r);
    const budget = s ? s.sweepBudgetUs || (s.sweepHz ? Math.round(1e6 / s.sweepHz) : 0) : 0;

    const ledClass = this.busy
      ? "is-warn"
      : this.errorMsg || isOther
        ? "is-emergency"
        : active
          ? s?.emergencyMode
            ? "is-emergency"
            : s?.role === 2 || r?.role === "spoke"
              ? "is-spoke"
              : "is-up"
          : isConnected
            ? "is-warn"
            : "";

    const headText = this.busy
      ? esc(this.progressText || "Reading timer over USB…")
      : this.errorMsg
        ? esc(this.errorMsg)
        : r
          ? `Read ${esc(r.timerLabel || "(unnamed)")} · ${r.role === "hub" ? "Hub" : "Spoke"} · firmware ${esc(r.firmwareVersion)}`
          : isOther
            ? "Connected XIAO ESP32-C5 (Other) has no SlapRF firmware · use Writer below to flash it"
            : isConnected
              ? "Connected over USB · click Read timer to inspect"
              : webSerialOk
                ? hasBrowserWebSerial()
                  ? "Click Read timer to choose a USB board and read its identity"
                  : "Plug in a XIAO ESP32-C5 over USB-C and tap Read timer to inspect its identity"
                : FLASHER_NEEDS_WEBSERIAL;

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
          active ? `Slot ${i + 1}: ${rb} (${f} MHz)` : `Slot ${i + 1}: ${rb} (${f} MHz) · read a timer to inspect`
        }"><strong>${rb}</strong> ${f}</span>`;
      })
      .join("");

    const fwBadge = r
      ? r.firmwareVersion === LATEST_FIRMWARE_VERSION
        ? ` <span class="badge badge-good">Latest</span>`
        : ` <span class="badge badge-warn">Update → ${LATEST_FIRMWARE_VERSION}</span>`
      : "";

    const netBadge = !r ? "—" : r.role === "hub" ? `USB · Ch ${s?.channel ?? 1}` : "ESP-NOW LR";

    const courseLinkText = !r
      ? "—"
      : r.role === "hub"
        ? `USB dongle · beacon master${s ? ` <span class="note">· Ch ${s.channel}</span>` : ""}`
        : s && s.slot >= 2
          ? `Joined Hub · slot ${s.slot}`
          : "ESP-NOW LR → Hub";

    const readDisabled = this.busy || !webSerialOk;
    const readBtnLabel = this.busy ? "Reading…" : "Read timer";
    const panelsClass = `debug-status-panels ${active ? "" : "is-unread"}`;

    const panelsHtml = `
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
              <dd>${r ? `SlapRF <span class="note mono">· ${esc(r.firmwareVersion)}</span>${fwBadge}` : "—"}</dd>
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
                  : r
                    ? `${FIRMWARE_SWEEP_HZ} Hz <span class="note">· 8 slots</span>`
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
              <dt>Course link</dt>
              <dd>${courseLinkText}</dd>
            </div>
          </dl>
        </div>`;

    const existingBtn = this.el.querySelector<HTMLButtonElement>("[data-action='read-timer']");
    const existingPanels = this.el.querySelector<HTMLElement>("[data-reader-panels]");
    if (existingBtn && existingPanels) {
      const dotEl = this.el.querySelector<HTMLElement>("[data-reader-dot]");
      const headEl = this.el.querySelector<HTMLElement>("[data-reader-head]");
      const btnTextEl = existingBtn.querySelector<HTMLElement>("[data-reader-btn-text]");
      if (dotEl) {
        const nextDotClass = `status-dot ${ledClass}`.trim();
        if (dotEl.className !== nextDotClass) dotEl.className = nextDotClass;
      }
      if (headEl && headEl.innerHTML !== headText) {
        headEl.innerHTML = headText;
      }
      if (existingBtn.disabled !== readDisabled) {
        existingBtn.disabled = readDisabled;
      }
      if (btnTextEl && btnTextEl.textContent !== readBtnLabel) {
        btnTextEl.textContent = readBtnLabel;
      }
      const nextPanelsClass = panelsClass.trim();
      if (existingPanels.className !== nextPanelsClass) {
        existingPanels.className = nextPanelsClass;
      }
      if (panelsHtml !== this.lastPanelsHtml) {
        this.lastPanelsHtml = panelsHtml;
        existingPanels.innerHTML = panelsHtml;
      }
      return;
    }

    this.lastPanelsHtml = panelsHtml;
    this.el.innerHTML = `
      <div class="debug-status-topbar">
        <span class="debug-led-status">
          <span class="status-dot ${ledClass}" data-reader-dot="1"></span>
          <span class="debug-head-note" data-reader-head="1">${headText}</span>
        </span>
        <div class="debug-connect-actions">
          <button type="button" class="btn btn-sm btn-armed" data-action="read-timer" ${readDisabled ? "disabled" : ""}>
            ${icons.reset(14)}<span data-reader-btn-text="1">${readBtnLabel}</span>
          </button>
        </div>
      </div>
      <div class="${panelsClass.trim()}" data-reader-panels="1">${panelsHtml}
      </div>`;
  }
}

/**
 * Standalone Eraser panel: opens the browser's USB port picker directly (without needing to
 * read the timer first) and wipes the selected Seeed XIAO ESP32-C5 back to a factory-blank chip.
 */
class TimerEraserPanel extends Component {
  private busy = false;
  private progress: FlashProgress | null = null;
  private lastSuccessMsg: string | null = null;
  private errorMsg: string | null = null;
  private showAllPorts = false;

  constructor(el: HTMLElement) {
    super(el);
    this.showAllPorts = loadPortPref();

    this.listen(el, "click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("[data-action='erase-timer']")) {
        if (this.busy) {
          cancelActiveFlash();
          if (!flasherUsesWebSerial()) {
            void usbPool.mainConsole.disconnectCleanly().catch(() => undefined);
          }
          this.busy = false;
          this.progress = null;
          this.errorMsg = null;
          this.render();
          return;
        }
        void this.eraseFromUsb();
      }
    });

    const unsubPool = usbPool.onChange(() => {
      if (!this.busy) {
        this.render();
      }
    });
    this.onDispose(unsubPool);

    this.render();
  }

  private async eraseFromUsb(): Promise<void> {
    if (this.busy) return;
    const useEsptool = flasherUsesWebSerial();
    this.busy = true;
    this.errorMsg = null;
    this.lastSuccessMsg = null;
    this.progress = {
      stage: "connecting",
      percent: 1,
      detail: !useEsptool && usbPool.mainConsole.connected
        ? "Opening connected USB port to wipe…"
        : "Select the XIAO ESP32-C5 USB port to wipe…",
    };
    this.render();

    const onProgress = (p: FlashProgress) => {
      this.progress = p;
      if (!this.updateProgressInPlace()) {
        this.render();
      }
    };

    try {
      if (useEsptool) {
        const port = await acquireEspSerialPort();
        await eraseXiaoC5WithEsptool(port, onProgress);
      } else {
        if (!isSimulatedUsbMode()) throw new Error(FLASHER_NEEDS_WEBSERIAL);
        // Simulation / Demo mode: wipe the simulated board.
        if (!usbPool.mainConsole.connected) {
          await usbPool.connectMain(this.showAllPorts);
        }
        await eraseXiaoC5OverWebSerial(onProgress, this.showAllPorts, usbPool);
      }

      this.lastSuccessMsg = "Timer wiped: bootloader, partition table, NVS, and firmware erased to factory blank.";
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
    if (!headEl) return false;
    const pct = Math.max(0, Math.min(100, Math.round(this.progress.percent)));
    headEl.textContent = `${this.progress.detail} (${pct}%)`;
    if (statusEl) statusEl.textContent = this.progress.detail;
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (fillEl) fillEl.style.width = `${pct}%`;
    if (btnTextEl) {
      btnTextEl.textContent = `Erasing… (${pct}%)`;
    }
    return true;
  }

  private render(): void {
    const browser = flasherUsesWebSerial();
    const webSerialOk = browser || isSimulatedUsbMode();
    const activeConsole = usbPool.mainConsole;
    const isConnected = !browser && activeConsole.connected;
    const isOther = !browser && activeConsole.isOtherDevice;
    const targetName = isConnected
      ? browser
        ? ""
        : isOther
          ? "Other"
          : activeConsole.lastStatus?.label || activeConsole.lastConfig?.timerLabel || "USB"
      : "";
    const pct = this.progress
      ? Math.max(0, Math.min(100, Math.round(this.progress.percent)))
      : this.lastSuccessMsg
        ? 100
        : 0;

    const ledClass = this.busy
      ? "is-warn"
      : this.errorMsg || isOther
        ? "is-emergency"
        : this.lastSuccessMsg
          ? "is-up"
          : isConnected
            ? "is-warn"
            : "";

    const headText = this.busy
      ? esc(`${this.progress?.detail || "Erasing timer over USB…"} (${pct}%)`)
      : this.errorMsg
        ? esc(this.errorMsg)
        : this.lastSuccessMsg
          ? `✓ ${esc(this.lastSuccessMsg)}`
          : isConnected
            ? `Connected to ${esc(targetName)}<span class="flasher-eraser-hint-desktop"> · click Erase timer to wipe back to factory blank</span>`
            : webSerialOk
              ? hasBrowserWebSerial()
                ? "Click Erase timer to choose a USB board and wipe it back to factory blank"
                : "Plug in a XIAO ESP32-C5 over USB-C and tap Erase timer to wipe it back to factory blank"
              : FLASHER_NEEDS_WEBSERIAL;

    const eraseDisabled = !webSerialOk;
    const eraseBtnLabel = this.busy ? `Cancel (${pct}%)` : "Erase timer";
    const progressHtml =
      this.busy || this.lastSuccessMsg
        ? `<div class="flasher-progress ${this.busy ? "is-flashing" : "is-complete"}">
            <div class="flasher-progress-top">
              <span class="flasher-progress-status" data-eraser-status="1">${esc(this.progress?.detail || this.lastSuccessMsg || "")}</span>
              <span class="mono flasher-progress-pct" data-eraser-pct="1">${pct}%</span>
            </div>
            <div class="meter flasher-meter">
              <span class="meter-fill ${this.lastSuccessMsg && !this.busy ? "tone-good" : ""}" data-eraser-fill="1" style="width:${pct}%"></span>
            </div>
          </div>`
        : "";

    const existingBtn = this.el.querySelector<HTMLButtonElement>("[data-action='erase-timer']");
    const existingProgSlot = this.el.querySelector<HTMLElement>("[data-eraser-progress-slot]");
    if (existingBtn && existingProgSlot) {
      const dotEl = this.el.querySelector<HTMLElement>("[data-eraser-dot]");
      const headEl = this.el.querySelector<HTMLElement>("[data-eraser-head]");
      const btnTextEl = existingBtn.querySelector<HTMLElement>("[data-eraser-btn-text]");
      if (dotEl) {
        const nextDotClass = `status-dot ${ledClass}`.trim();
        if (dotEl.className !== nextDotClass) dotEl.className = nextDotClass;
      }
      if (headEl && headEl.innerHTML !== headText) {
        headEl.innerHTML = headText;
      }
      if (existingBtn.disabled !== eraseDisabled) {
        existingBtn.disabled = eraseDisabled;
      }
      if (btnTextEl && btnTextEl.textContent !== eraseBtnLabel) {
        btnTextEl.textContent = eraseBtnLabel;
      }
      if (existingProgSlot.innerHTML !== progressHtml) {
        existingProgSlot.innerHTML = progressHtml;
      }
      return;
    }

    this.el.innerHTML = `
      <div class="debug-status-topbar">
        <span class="debug-led-status">
          <span class="status-dot ${ledClass}" data-eraser-dot="1"></span>
          <span class="debug-head-note" data-eraser-head="1">${headText}</span>
        </span>
        <div class="debug-connect-actions">
          <button type="button" class="btn btn-sm btn-bad" data-action="erase-timer" ${eraseDisabled ? "disabled" : ""}>
            ${icons.trash(14)}<span data-eraser-btn-text="1">${eraseBtnLabel}</span>
          </button>
        </div>
      </div>
      <div data-eraser-progress-slot="1">${progressHtml}</div>`;
  }
}


/**
 * Flasher page: read, flash, or wipe Seeed XIAO ESP32-C5 timers.
 *
 * There is no lasting connection here: each action picks the board's USB port in the browser
 * (WebSerial), does its job, reads the board back once, and closes the port. Live timer connections
 * belong to the SlapRF Server on the Network and Debug pages.
 */
export class FlasherView extends Component {
  constructor(el: HTMLElement, store: AppStore, api: ApiClient) {
    super(el);

    el.innerHTML = `
      <div class="settings debug-page">
        <section class="settings-section" data-section-anchor="reader">
          <div class="settings-intro">
            <h2>Reader</h2>
            <p>Plug in a XIAO ESP32-C5 and read its flashed identity, 5.8 GHz receiver channels, and 2.4 GHz network status.</p>
          </div>
          <div class="debug-status-layout" data-slot="reader"></div>
        </section>

        <section class="settings-section" data-section-anchor="writer">
          <div class="settings-intro">
            <h2>Writer</h2>
            <p>Set the timer's role and name, then flash a XIAO ESP32-C5 straight over USB-C. The board is read back once to confirm the flash.</p>
          </div>
          <div class="debug-status-layout" data-slot="flasher"></div>
        </section>

        <section class="settings-section" data-section-anchor="eraser">
          <div class="settings-intro">
            <h2>Eraser</h2>
            <p>Wipe a XIAO ESP32-C5 back to a factory-blank chip.</p>
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
    const eraserPanel = new TimerEraserPanel(this.slot("eraser"));
    this.adopt(flasher);
    this.adopt(readerPanel);
    this.adopt(eraserPanel);
  }
}
