import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { FIRMWARE_PROFILES, TimerReadout } from "../services/esp_flasher";
import { BootLog, LiveSample, ScanResult, TimerConsole, TimerStatus } from "../services/timer_console";
import {
  buildFileStamp,
  CHANNEL_COLORS,
  DBM_MAX,
  DBM_MIN,
  downloadCanvasPng,
  downloadTextFile,
  drawHealthSparklines,
  drawSignalOverTimeCanvas,
  drawSpectrumCanvas,
  drawWaterfallCanvas,
  exportScanHistoryCsv,
  exportSignalCsv,
  HealthHistory,
  PilotThresholdInfo,
  RACEBAND,
  racebandName,
  SignalRingBuffer,
  SpectrumAccumulator,
} from "./debug/charts";

const LOG_LINES = 400;
const UNPROVISIONED_FP = "00000001";
const BAD_RESETS = ["panic", "interrupt-watchdog", "task-watchdog", "watchdog", "brownout"];
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

type CheckResult = "pass" | "warn" | "fail" | "skip";

interface Check {
  name: string;
  result: CheckResult;
  detail: string;
}

interface RestartRun {
  n: number;
  ok: boolean;
  ms: number;
  reset: string;
  extraBoots: number;
  note: string;
}

interface DebugTimerInfo {
  found: boolean;
  puckId?: number;
  label?: string;
  online: boolean;
  msSinceSeen?: number;
  framesRx: number;
  simulatorActive: boolean;
}

/**
 * Debug page: connect a timer over USB (WebSerial) and see what it sees. A one-click self-test,
 * status + 5-min health sparklines, live 5.8 GHz readings per channel, signal-over-time 50 Hz
 * recorder with per-channel noise statistics, canvas spectrum scan + scrolling waterfall with
 * 5 GHz Wi-Fi UNII / Raceband overlays, restart / boot-log capture, and the timer's own log.
 * Firmware side: firmware/components/slaprf_radio/slaprf_diag.c. Spec: docs/DEBUG_PAGE.md.
 */
export class DebugView extends Component {
  private readonly console: TimerConsole;
  private status: TimerStatus | null = null;
  private live: LiveSample | null = null;
  private liveCount = 0;
  private liveOn = false;
  /** 1 = ~10 Hz bar stream; 2 = every-sweep (50 Hz) when the Signal-over-time card is visible. */
  private liveMode: 1 | 2 = 1;
  private signalCardVisible = true;
  private logOn = false;
  private scanning = false;
  /** Continuous scan (SCAN LIVE) running: the sweep slot scans the band, lap timing pauses. */
  private scanLive = false;
  private scanToggleAt = 0;
  private logLines: string[] = [];
  private error: string | null = null;
  private showAllPorts = false;
  private statusTimer = 0;
  /** Name of the long-running action in progress (self-test, restart test...), or null. */
  private busy: string | null = null;
  private checks: Check[] = [];
  private checksAt: Date | null = null;
  private reportExtra = "";
  private runs: RestartRun[] = [];
  private bootLog: BootLog | null = null;
  private progress = "";
  private channelsDirty = false;

  // Chart buffers & state (§5)
  private readonly signalRing = new SignalRingBuffer();
  private readonly spectrumAcc = new SpectrumAccumulator();
  private readonly healthHistory = new HealthHistory();
  private pilots: PilotThresholdInfo[] = [];
  private hasServer = false;

  private signalWindowSec = 30;
  private signalEndN: number | null = null;
  private signalRefN = 0;
  private signalYMin = DBM_MIN;
  private signalYMax = DBM_MAX;
  private signalYZoomBox: { y0: number; y1: number } | null = null;
  private signalDrag: { mode: "undecided" | "time" | "ybox"; startX: number; startY: number; startEndN: number } | null = null;
  private signalEnabledCh: boolean[] = [true, true, true, true, true, true, true, true];
  private signalShowFloor = true;
  private signalShowHitLine = true;
  private signalShowThresholds = true;
  private signalHover: { x: number; y: number } | null = null;

  private scanShowMaxHold = true;
  private scanShowAvg = true;
  private scanShowWifi = true;
  private scanZoomStartMHz: number | null = null;
  private scanZoomStopMHz: number | null = null;
  private scanZoomBox: { x0: number; x1: number } | null = null;
  private scanHover: { x: number; y: number } | null = null;
  private waterfallHover: { x: number; y: number } | null = null;
  private wfDragging: {
    mode: "undecided" | "pan" | "scrollbar" | "zoom";
    startX: number;
    startY: number;
    startScroll: number;
  } | null = null;
  private specDragging: { startX: number } | null = null;

  private dirtySignal = true;
  private dirtyNoiseTable = true;
  private dirtySpectrum = true;
  private dirtyWaterfall = true;
  private dirtyHealth = true;
  private lastNoiseTableRenderAt = 0;
  private rafId = 0;
  private observer: IntersectionObserver | null = null;

  constructor(el: HTMLElement) {
    super(el);
    this.console = new TimerConsole({
      onStatus: (s) => {
        const freqsChanged = this.status?.freqs.join() !== s.freqs.join();
        this.status = s;
        // Pick up a live scan still running from before (page reload); skip stale replies right after a toggle.
        if (s.scanLive !== undefined && s.scanLive !== this.scanLive && Date.now() - this.scanToggleAt > 3000) {
          this.scanLive = s.scanLive;
          this.renderScan();
        }
        this.renderConnection();
        this.renderStatus();
        this.renderLiveHead();
        if (freqsChanged) {
          this.renderLive();
          if (!this.channelsDirty) this.renderChannels();
          this.renderSignalControls();
          this.dirtySignal = true;
          this.dirtyNoiseTable = true;
        }
        void this.pollServerHealth(s);
      },
      onLive: (s) => {
        this.live = s;
        this.liveCount++;
        this.signalRing.push(s, this.status?.sweepHz ?? 50);
        this.updateLive();
        if (this.signalEndN === null) {
          this.dirtySignal = true;
          this.dirtyNoiseTable = true;
        }
      },
      onScan: (s) => {
        if (s.live && !this.scanLive) return; // Stray pass after SCAN STOP
        const gridChanged =
          this.spectrumAcc.latest !== null &&
          (this.spectrumAcc.latest.start !== s.start ||
            this.spectrumAcc.latest.step !== s.step ||
            this.spectrumAcc.latest.dbm.length !== s.dbm.length);
        if (gridChanged) {
          this.scanZoomStartMHz = null;
          this.scanZoomStopMHz = null;
        }
        this.spectrumAcc.pushScan(s);
        if (!s.live) {
          this.scanning = false;
          this.renderScan();
        } else {
          this.updateScanFindings();
        }
        this.dirtySpectrum = true;
        this.dirtyWaterfall = true;
      },
      onLog: (line) => this.appendLog(line),
      onConfig: (c) =>
        this.appendLog(
          `[config] ${c.role} "${c.timerLabel}" profile=${c.firmwareProfile} fp=${c.fingerprint} fw=${c.firmwareVersion} ch=${c.frequenciesMHz.join(",")}`
        ),
      onError: (msg) => {
        this.error = msg;
        this.scanning = false;
        this.renderConnection();
        this.renderScan();
      },
      onDisconnect: () => {
        window.clearInterval(this.statusTimer);
        this.liveOn = false;
        this.logOn = false;
        this.scanLive = false;
        this.renderAll();
      },
    });

    el.innerHTML = `
      <div class="settings debug-page">
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Connect a timer</h2>
            <p>Plug a timer into this computer over USB-C. Works with the firmware already on the board; nothing is flashed or saved.</p>
          </div>
          <div class="card" data-slot="connection"></div>
        </section>
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Self-test</h2>
            <p>Checks the timer end to end in about 10 seconds: console, identity, 5.8 GHz receiver, sweep timing, memory, last restart, Wi-Fi, and whether its data reaches this laptop. Copy the report when asking for help.</p>
          </div>
          <div class="card" data-slot="selftest"></div>
        </section>
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Status &amp; health</h2>
            <p>Identity, chip, uptime, why it last restarted, memory, sweep timing, Wi-Fi and the 5.8 GHz receiver's boot check. Refreshes every 2 seconds and plots the last 5 minutes.</p>
          </div>
          <div class="card">
            <div data-slot="status"></div>
            <div class="debug-health-strip" data-slot="health">
              <canvas class="debug-canvas debug-health-canvas" data-health-canvas></canvas>
            </div>
          </div>
        </section>
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Live 5.8 GHz readings</h2>
            <p>What the timer measures on each of its 8 pilot channels. The tick marks the peak since the previous update; hits count readings more than 10 dB above that channel's typical noise (Wi-Fi bursts show up here too; they're far below a lap's enter threshold). Power on a VTX to see its channel rise.</p>
            <p>Try other channels without reflashing, or switch the receiver off to tell whether a problem comes from the 5.8 GHz side. Both reset when the timer restarts.</p>
          </div>
          <div class="card">
            <div data-slot="live-head"></div>
            <div data-slot="live"></div>
            <div data-slot="channels"></div>
          </div>
        </section>
        <section class="settings-section" data-signal-section>
          <div class="settings-intro">
            <h2>Signal over time &amp; channel noise</h2>
            <p>Streams every sweep (50 Hz) while visible so you can see crossing shapes, short 5 GHz Wi-Fi bursts, each channel's typical noise floor and pilot enter thresholds.</p>
            <p>The table below computes mean, spread, max, floor, hits/s and how often noise reaches a pilot's enter threshold ("would trigger" — anything above 0% with no drone flying is a false-lap risk).</p>
          </div>
          <div class="card">
            <div data-slot="signal-controls"></div>
            <div class="debug-canvas-wrap">
              <canvas class="debug-canvas debug-signal-canvas" data-signal-canvas></canvas>
            </div>
            <div data-slot="noise-table"></div>
          </div>
        </section>
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Spectrum scan &amp; waterfall</h2>
            <p>Sweeps the receiver across 5180–5917 MHz. Use it to find a VTX on an unexpected frequency, or to check a venue for 5 GHz Wi-Fi before racing. Note that Raceband <strong>R3–R6 overlap 5 GHz Wi-Fi UNII-3</strong> (channels 149–165, 5735–5835 MHz).</p>
            <p><strong>Scan</strong> takes one snapshot and appends a row to the waterfall. <strong>Live</strong> keeps scanning ~3 times a second with live, average and max-hold traces; lap timing pauses while it runs, the Wi-Fi link stays up.</p>
          </div>
          <div class="card" data-slot="scan"></div>
        </section>
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Restarts &amp; boot logs</h2>
            <p>The timer keeps its log in memory that survives a crash or restart, so you can read what happened during this boot and the one before it. The restart test checks that the timer comes back cleanly every time.</p>
          </div>
          <div class="card" data-slot="restart"></div>
        </section>
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Live log</h2>
            <p>The timer's own log messages, mirrored over USB while enabled.</p>
          </div>
          <div class="card card-flush" data-slot="log"></div>
        </section>
      </div>`;

    this.listen(el, "click", (e) => void this.onClick(e));
    this.listen(el, "change", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.matches("[data-all-ports]")) this.showAllPorts = t.checked;
      else if (t.matches("[data-check]")) void this.onCheckChange(t);
    });
    this.listen(el, "input", (e) => {
      if ((e.target as HTMLElement).matches("[data-chan]")) this.channelsDirty = true;
    });

    this.bindCanvasHover();
    this.setupVisibilityObserver();
    void this.fetchPilotThresholds();

    const onResize = () => {
      this.dirtySignal = true;
      this.dirtySpectrum = true;
      this.dirtyWaterfall = true;
      this.dirtyHealth = true;
    };
    window.addEventListener("resize", onResize);

    const tick = () => {
      this.renderFrame();
      this.rafId = window.requestAnimationFrame(tick);
    };
    this.rafId = window.requestAnimationFrame(tick);

    this.onDispose(() => {
      window.cancelAnimationFrame(this.rafId);
      window.removeEventListener("resize", onResize);
      this.observer?.disconnect();
      window.clearInterval(this.statusTimer);
      // Leaving the page must not leave the timer scanning instead of timing.
      const stop = this.scanLive ? this.console.send("SCAN STOP").catch(() => undefined) : Promise.resolve();
      void stop.then(() => this.console.disconnect());
    });
    this.renderAll();
  }

  // ---------------------------------------------------------------- observer, hover & animation loop

  private setupVisibilityObserver(): void {
    const sec = this.el.querySelector<HTMLElement>("[data-signal-section]");
    if (!sec || typeof IntersectionObserver === "undefined") return;
    this.observer = new IntersectionObserver(
      (entries) => {
        const vis = entries.some((e) => e.isIntersecting);
        if (vis !== this.signalCardVisible) {
          this.signalCardVisible = vis;
          void this.syncLiveMode();
        }
      },
      { threshold: 0.05 }
    );
    this.observer.observe(sec);
  }

  /** Switch between LIVE 2 (50 Hz, while Signal over time is visible) and LIVE 1 (~10 Hz, when scrolled away). */
  private async syncLiveMode(): Promise<void> {
    const desired: 1 | 2 = this.signalCardVisible ? 2 : 1;
    this.liveMode = desired;
    if (this.console.connected && this.liveOn && !this.busy) {
      await this.console.send(`LIVE ${desired}`).catch(() => undefined);
      this.renderSignalControls();
    }
  }

  private signalViewEndN(): number {
    return this.signalEndN ?? this.signalRing.latestN();
  }

  private clampSignalEndN(endN: number): number {
    const latest = this.signalRing.latestN();
    const earliest = this.signalRing.earliestN();
    const sweepHz = this.status?.sweepHz ?? 50;
    const minEnd = Math.min(latest, earliest + Math.round(this.signalWindowSec * sweepHz));
    return Math.min(latest, Math.max(minEnd, Math.round(endN)));
  }

  private pauseSignalAt(endN: number): void {
    if (this.signalEndN === null) {
      this.signalRefN = this.signalRing.latestN();
    }
    this.signalEndN = this.clampSignalEndN(endN);
  }

  private currentScanBounds(): { vStart: number; vStop: number } | null {
    const s = this.spectrumAcc.latest;
    if (!s || !s.dbm.length) return null;
    const scanStop = s.start + s.step * (s.dbm.length - 1);
    const vStart = Math.max(s.start, Math.min(scanStop - s.step, this.scanZoomStartMHz ?? s.start));
    const vStop = Math.min(scanStop, Math.max(vStart + s.step, this.scanZoomStopMHz ?? scanStop));
    return { vStart, vStop };
  }

  private applyFreqZoomFromBox(box: { x0: number; x1: number }, plotW: number, L = 44): void {
    const b = this.currentScanBounds();
    const s = this.spectrumAcc.latest;
    if (!b || !s) return;
    const xa = Math.max(L, Math.min(L + plotW, Math.min(box.x0, box.x1)));
    const xb = Math.max(L, Math.min(L + plotW, Math.max(box.x0, box.x1)));
    if (xb - xa < 12) return;
    const span = b.vStop - b.vStart;
    const f0 = Math.round(b.vStart + ((xa - L) / plotW) * span);
    const f1 = Math.round(b.vStart + ((xb - L) / plotW) * span);
    if (f1 - f0 >= Math.max(10, s.step * 2)) {
      this.scanZoomStartMHz = f0;
      this.scanZoomStopMHz = f1;
      this.renderScan();
    }
  }

  private bindCanvasHover(): void {
    const scrubScrollbar = (canvas: HTMLElement, clientY: number) => {
      const r = canvas.getBoundingClientRect();
      const plotH = Math.max(10, r.height - 6 - 24);
      const frac = Math.max(0, Math.min(1, (clientY - r.top - 6) / plotH));
      this.spectrumAcc.setScrollRow(frac * this.spectrumAcc.maxScrollRow());
      this.updateScanFindings();
      this.dirtyWaterfall = true;
    };

    this.listen(this.el, "mousedown", (e) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.matches("[data-signal-canvas]")) {
        const r = target.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        // Dragging on Y-axis gutter (< 48px) or holding Shift starts immediate Y-axis box zoom
        if (x < 48 || e.shiftKey) {
          this.signalDrag = { mode: "ybox", startX: x, startY: y, startEndN: this.signalViewEndN() };
          this.signalYZoomBox = { y0: y, y1: y };
        } else {
          this.signalDrag = { mode: "undecided", startX: x, startY: y, startEndN: this.signalViewEndN() };
        }
      } else if (target.matches("[data-spectrum-canvas]")) {
        const r = target.getBoundingClientRect();
        const x = e.clientX - r.left;
        if (x >= 44 && x <= r.width - 14 && this.spectrumAcc.latest) {
          this.specDragging = { startX: x };
          this.scanZoomBox = { x0: x, x1: x };
          this.dirtySpectrum = true;
        }
      } else if (target.matches("[data-waterfall-canvas]")) {
        const r = target.getBoundingClientRect();
        const x = e.clientX - r.left;
        if (x >= r.width - 28 && this.spectrumAcc.maxScrollRow() > 0) {
          this.wfDragging = {
            mode: "scrollbar",
            startX: x,
            startY: e.clientY,
            startScroll: this.spectrumAcc.scrollRow,
          };
          scrubScrollbar(target, e.clientY);
        } else if (x >= 44 && x < r.width - 18) {
          this.wfDragging = {
            mode: "undecided",
            startX: x,
            startY: e.clientY,
            startScroll: this.spectrumAcc.scrollRow,
          };
        }
      }
    });

    this.listen(window, "mouseup", () => {
      if (this.signalDrag) {
        if (this.signalDrag.mode === "ybox" && this.signalYZoomBox) {
          const c = this.el.querySelector<HTMLElement>("[data-signal-canvas]");
          if (c) {
            const r = c.getBoundingClientRect();
            const T = 12;
            const plotH = Math.max(10, r.height - T - 26);
            const ya = Math.max(T, Math.min(T + plotH, Math.min(this.signalYZoomBox.y0, this.signalYZoomBox.y1)));
            const yb = Math.max(T, Math.min(T + plotH, Math.max(this.signalYZoomBox.y0, this.signalYZoomBox.y1)));
            if (yb - ya >= 10) {
              const span = this.signalYMax - this.signalYMin;
              const dHigh = Math.round(this.signalYMin + (1 - (ya - T) / plotH) * span);
              const dLow = Math.round(this.signalYMin + (1 - (yb - T) / plotH) * span);
              if (dHigh - dLow >= 4) {
                this.signalYMin = Math.max(DBM_MIN, dLow);
                this.signalYMax = Math.min(DBM_MAX, dHigh);
                this.renderSignalControls();
              }
            }
          }
        }
        this.signalDrag = null;
        this.signalYZoomBox = null;
        this.dirtySignal = true;
      }

      if (this.specDragging) {
        const c = this.el.querySelector<HTMLElement>("[data-spectrum-canvas]");
        if (c && this.scanZoomBox) {
          const r = c.getBoundingClientRect();
          this.applyFreqZoomFromBox(this.scanZoomBox, Math.max(10, r.width - 44 - 14), 44);
        }
        this.specDragging = null;
        this.scanZoomBox = null;
        this.dirtySpectrum = true;
        this.dirtyWaterfall = true;
      }

      if (this.wfDragging) {
        if (this.wfDragging.mode === "zoom" && this.scanZoomBox) {
          const c = this.el.querySelector<HTMLElement>("[data-waterfall-canvas]");
          if (c) {
            const r = c.getBoundingClientRect();
            this.applyFreqZoomFromBox(this.scanZoomBox, Math.max(10, r.width - 44 - 18), 44);
          }
        }
        this.wfDragging = null;
        this.scanZoomBox = null;
        this.dirtySpectrum = true;
        this.dirtyWaterfall = true;
      }
    });

    this.listen(this.el, "dblclick", (e) => {
      const target = e.target as HTMLElement;
      if (target.matches("[data-signal-canvas]")) {
        this.signalEndN = null;
        this.signalYMin = DBM_MIN;
        this.signalYMax = DBM_MAX;
        this.renderSignalControls();
        this.dirtySignal = true;
        this.dirtyNoiseTable = true;
      } else if (target.matches("[data-spectrum-canvas], [data-waterfall-canvas]")) {
        if (this.scanZoomStartMHz !== null || this.scanZoomStopMHz !== null) {
          this.scanZoomStartMHz = null;
          this.scanZoomStopMHz = null;
          this.renderScan();
        }
      }
    });

    this.listen(this.el, "mousemove", (e) => {
      const target = e.target as HTMLElement;
      if (this.signalDrag) {
        const sig = this.el.querySelector<HTMLElement>("[data-signal-canvas]");
        if (sig) {
          const r = sig.getBoundingClientRect();
          const x = e.clientX - r.left;
          const y = e.clientY - r.top;
          const dx = x - this.signalDrag.startX;
          const dy = y - this.signalDrag.startY;
          if (this.signalDrag.mode === "undecided" && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
            this.signalDrag.mode = Math.abs(dy) > Math.abs(dx) * 1.5 ? "ybox" : "time";
          }
          if (this.signalDrag.mode === "ybox") {
            this.signalYZoomBox = { y0: this.signalDrag.startY, y1: y };
            this.dirtySignal = true;
          } else if (this.signalDrag.mode === "time") {
            const plotW = Math.max(10, r.width - 44 - 14);
            const sweepHz = this.status?.sweepHz ?? 50;
            const windowSweeps = this.signalWindowSec * sweepHz;
            const deltaN = (dx / plotW) * windowSweeps;
            this.pauseSignalAt(this.signalDrag.startEndN - deltaN);
            this.renderSignalControls();
            this.dirtySignal = true;
            this.dirtyNoiseTable = true;
          }
        }
      }

      if (this.specDragging) {
        const spec = this.el.querySelector<HTMLElement>("[data-spectrum-canvas]");
        if (spec) {
          const r = spec.getBoundingClientRect();
          const x = Math.max(44, Math.min(r.width - 14, e.clientX - r.left));
          this.scanZoomBox = { x0: this.specDragging.startX, x1: x };
          this.dirtySpectrum = true;
        }
      }

      if (this.wfDragging) {
        const wf = this.el.querySelector<HTMLElement>("[data-waterfall-canvas]");
        if (wf) {
          const r = wf.getBoundingClientRect();
          const x = e.clientX - r.left;
          const dx = x - this.wfDragging.startX;
          const dy = e.clientY - this.wfDragging.startY;
          if (this.wfDragging.mode === "undecided" && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
            this.wfDragging.mode = Math.abs(dx) >= Math.abs(dy) ? "zoom" : "pan";
          }
          if (this.wfDragging.mode === "scrollbar") {
            scrubScrollbar(wf, e.clientY);
          } else if (this.wfDragging.mode === "zoom") {
            const clampedX = Math.max(44, Math.min(r.width - 18, x));
            this.scanZoomBox = { x0: this.wfDragging.startX, x1: clampedX };
            this.dirtyWaterfall = true;
            this.dirtySpectrum = true;
          } else if (this.wfDragging.mode === "pan") {
            const pxPerRow = Math.max(1, (r.height - 30) / this.spectrumAcc.visibleRows);
            const deltaRows = (this.wfDragging.startY - e.clientY) / pxPerRow;
            this.spectrumAcc.setScrollRow(this.wfDragging.startScroll + deltaRows);
            this.updateScanFindings();
            this.dirtyWaterfall = true;
          }
        }
      }

      if (target.matches("[data-signal-canvas]")) {
        const r = target.getBoundingClientRect();
        this.signalHover = { x: e.clientX - r.left, y: e.clientY - r.top };
        this.dirtySignal = true;
      } else if (target.matches("[data-spectrum-canvas]")) {
        const r = target.getBoundingClientRect();
        this.scanHover = { x: e.clientX - r.left, y: e.clientY - r.top };
        this.dirtySpectrum = true;
      } else if (target.matches("[data-waterfall-canvas]")) {
        const r = target.getBoundingClientRect();
        this.waterfallHover = { x: e.clientX - r.left, y: e.clientY - r.top };
        this.dirtyWaterfall = true;
      }
    });
    this.listen(this.el, "mouseout", (e) => {
      const target = e.target as HTMLElement;
      if (target.matches("[data-signal-canvas]")) {
        this.signalHover = null;
        this.dirtySignal = true;
      } else if (target.matches("[data-spectrum-canvas]")) {
        this.scanHover = null;
        this.dirtySpectrum = true;
      } else if (target.matches("[data-waterfall-canvas]")) {
        this.waterfallHover = null;
        this.dirtyWaterfall = true;
      }
    });
    this.el.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        const target = e.target as HTMLElement;
        if (target.matches("[data-signal-canvas]")) {
          e.preventDefault();
          const r = target.getBoundingClientRect();
          const x = e.clientX - r.left;
          const y = e.clientY - r.top;
          const factor = e.deltaY > 0 ? 1.25 : 0.8;
          // Wheel on Y-axis (< 48px) or Shift+Wheel zooms the Y-axis (dBm) around cursor Y
          if (x < 48 || e.shiftKey) {
            const T = 12;
            const plotH = Math.max(10, r.height - T - 26);
            const yFrac = Math.max(0, Math.min(1, 1 - (y - T) / plotH));
            const curSpan = this.signalYMax - this.signalYMin;
            const anchorDbm = this.signalYMin + yFrac * curSpan;
            const nextSpan = Math.max(6, Math.min(DBM_MAX - DBM_MIN, curSpan * factor));
            let nextMin = Math.round(anchorDbm - yFrac * nextSpan);
            let nextMax = Math.round(nextMin + nextSpan);
            if (nextMin < DBM_MIN) {
              nextMin = DBM_MIN;
              nextMax = Math.min(DBM_MAX, Math.round(DBM_MIN + nextSpan));
            }
            if (nextMax > DBM_MAX) {
              nextMax = DBM_MAX;
              nextMin = Math.max(DBM_MIN, Math.round(DBM_MAX - nextSpan));
            }
            this.signalYMin = nextMin;
            this.signalYMax = nextMax;
            this.renderSignalControls();
            this.dirtySignal = true;
          } else {
            // Wheel on plot zooms the time window (1 s .. 120 s) around cursor X, matching PilotRssiChart
            const L = 44;
            const plotW = Math.max(10, r.width - L - 14);
            const sweepHz = this.status?.sweepHz ?? 50;
            const frac = Math.max(0, Math.min(1, (x - L) / plotW));
            const curEndN = this.signalViewEndN();
            const curSweeps = this.signalWindowSec * sweepHz;
            const anchorN = curEndN - (1 - frac) * curSweeps;
            const nextSec = Math.max(1, Math.min(120, Number((this.signalWindowSec * factor).toFixed(1))));
            this.signalWindowSec = nextSec;
            if (this.signalEndN !== null) {
              this.signalEndN = this.clampSignalEndN(anchorN + (1 - frac) * nextSec * sweepHz);
            }
            this.renderSignalControls();
            this.dirtySignal = true;
            this.dirtyNoiseTable = true;
          }
          return;
        }
        if (!target.matches("[data-waterfall-canvas]")) return;
        if (this.spectrumAcc.maxScrollRow() <= 0) return;
        e.preventDefault();
        const step = Math.sign(e.deltaY) * Math.max(2, Math.round(Math.abs(e.deltaY) / 10));
        this.spectrumAcc.setScrollRow(this.spectrumAcc.scrollRow + step);
        this.updateScanFindings();
        this.dirtyWaterfall = true;
      },
      { passive: false }
    );
  }

  private renderFrame(): void {
    if (this.dirtySignal) {
      const c = this.el.querySelector<HTMLCanvasElement>("[data-signal-canvas]");
      if (c) {
        drawSignalOverTimeCanvas(c, this.signalRing, {
          windowSec: this.signalWindowSec,
          sweepHz: this.status?.sweepHz ?? 50,
          endN: this.signalEndN,
          refN: this.signalRefN,
          yMinDbm: this.signalYMin,
          yMaxDbm: this.signalYMax,
          yZoomBox: this.signalYZoomBox,
          freqs: this.status?.freqs ?? RACEBAND,
          enabledChannels: this.signalEnabledCh,
          showFloor: this.signalShowFloor,
          showHitLine: this.signalShowHitLine,
          showThresholds: this.signalShowThresholds,
          pilots: this.pilots,
          hover: this.signalHover,
        });
        this.dirtySignal = false;
      }
    }

    const now = performance.now();
    if (this.dirtyNoiseTable && now - this.lastNoiseTableRenderAt >= 250) {
      this.renderNoiseTable();
      this.dirtyNoiseTable = false;
      this.lastNoiseTableRenderAt = now;
    }

    if (this.dirtySpectrum) {
      const c = this.el.querySelector<HTMLCanvasElement>("[data-spectrum-canvas]");
      if (c) {
        drawSpectrumCanvas(c, this.spectrumAcc, {
          showMaxHold: this.scanShowMaxHold,
          showAverage: this.scanShowAvg,
          showWifiOverlay: this.scanShowWifi,
          viewStartMHz: this.scanZoomStartMHz,
          viewStopMHz: this.scanZoomStopMHz,
          zoomBox: this.scanZoomBox,
          hover: this.scanHover,
        });
        this.updateScanFindings();
        this.dirtySpectrum = false;
      }
    }

    if (this.dirtyWaterfall) {
      const c = this.el.querySelector<HTMLCanvasElement>("[data-waterfall-canvas]");
      if (c) {
        drawWaterfallCanvas(
          c,
          this.spectrumAcc,
          this.scanShowWifi,
          this.waterfallHover,
          this.scanZoomStartMHz,
          this.scanZoomStopMHz,
          this.scanZoomBox
        );
        this.dirtyWaterfall = false;
      }
    }

    if (this.dirtyHealth) {
      const c = this.el.querySelector<HTMLCanvasElement>("[data-health-canvas]");
      if (c) {
        drawHealthSparklines(c, this.healthHistory, this.hasServer);
        this.dirtyHealth = false;
      }
    }
  }

  private async fetchPilotThresholds(): Promise<void> {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return;
      const data = (await res.json()) as { pilots?: PilotThresholdInfo[] };
      if (Array.isArray(data.pilots)) {
        this.pilots = data.pilots;
        this.hasServer = true;
        this.dirtySignal = true;
        this.dirtyNoiseTable = true;
        this.dirtyHealth = true;
      }
    } catch {
      // Static GitHub Pages or offline: skip silently (§5.1)
    }
  }

  private async pollServerHealth(s: TimerStatus): Promise<void> {
    let framesRx: number | null = null;
    try {
      const res = await fetch(`/api/debug/timer?fp=${encodeURIComponent(s.fp)}`, { cache: "no-store" });
      if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) {
        const info = (await res.json()) as DebugTimerInfo;
        this.hasServer = true;
        if (info.found) framesRx = info.framesRx;
      }
    } catch {
      // No local server
    }
    void this.fetchPilotThresholds();
    this.healthHistory.record(s, this.liveCount, this.signalRing.droppedLines, framesRx);
    this.dirtyHealth = true;
  }

  // ---------------------------------------------------------------- actions

  private async onCheckChange(t: HTMLInputElement): Promise<void> {
    this.error = null;
    try {
      switch (t.dataset.check) {
        case "rf-enable": {
          const on = t.checked;
          if (!on && !confirm("Switch the 5.8 GHz receiver off? The timer stops timing until you switch it back on or restart it.")) {
            t.checked = true;
            return;
          }
          await this.console.request(`RF ${on ? 1 : 0}`, "ok", 2000);
          await this.refreshStatus();
          break;
        }
        case "signal-floor":
          this.signalShowFloor = t.checked;
          this.dirtySignal = true;
          break;
        case "signal-hit":
          this.signalShowHitLine = t.checked;
          this.dirtySignal = true;
          break;
        case "signal-thr":
          this.signalShowThresholds = t.checked;
          this.dirtySignal = true;
          break;
        case "scan-hold":
          this.scanShowMaxHold = t.checked;
          this.dirtySpectrum = true;
          break;
        case "scan-avg":
          this.scanShowAvg = t.checked;
          this.dirtySpectrum = true;
          break;
        case "scan-wifi":
          this.scanShowWifi = t.checked;
          this.dirtySpectrum = true;
          this.dirtyWaterfall = true;
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.error = msg;
      this.renderConnection();
      this.renderLiveHead();
    }
  }

  private async onClick(e: Event): Promise<void> {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!t) return;
    this.error = null;
    try {
      switch (t.dataset.action) {
        case "connect":
          await this.console.connect(this.showAllPorts);
          this.signalRing.clear();
          this.healthHistory.clear();
          this.renderAll();
          await this.startSession();
          break;
        case "disconnect":
          if (this.scanLive) await this.console.send("SCAN STOP").catch(() => undefined);
          if (this.liveOn) await this.console.send("LIVE 0").catch(() => undefined);
          if (this.logOn) await this.console.send("LOG 0").catch(() => undefined);
          await this.console.disconnect();
          break;
        case "live":
          this.liveOn = !this.liveOn;
          await this.console.send(this.liveOn ? `LIVE ${this.liveMode}` : "LIVE 0");
          this.renderLiveHead();
          this.renderSignalControls();
          break;
        case "rf": {
          const on = !(this.status?.rf.enabled ?? true);
          if (!on && !confirm("Switch the 5.8 GHz receiver off? The timer stops timing until you switch it back on or restart it.")) break;
          await this.console.request(`RF ${on ? 1 : 0}`, "ok", 2000);
          await this.refreshStatus();
          break;
        }
        case "channels-apply": {
          const freqs = [...this.el.querySelectorAll<HTMLInputElement>("[data-chan]")].map((i) => Math.round(Number(i.value)));
          if (freqs.length !== 8 || freqs.some((f) => !(f >= 5180 && f <= 5917))) {
            throw new Error("Each channel must be between 5180 and 5917 MHz.");
          }
          await this.console.request(`CHANNELS ${freqs.join(",")}`, "ok", 2000);
          this.channelsDirty = false;
          await this.refreshStatus();
          this.renderChannels();
          break;
        }
        case "channels-raceband":
          this.el.querySelectorAll<HTMLInputElement>("[data-chan]").forEach((i, n) => (i.value = String(RACEBAND[n])));
          this.channelsDirty = true;
          break;
        case "channels-reset":
          await this.console.request("CHANNELS RESET", "ok", 2000);
          this.channelsDirty = false;
          await this.refreshStatus();
          this.renderChannels();
          break;
        case "signal-window": {
          const w = Number(t.dataset.win);
          if (w > 0 && w <= 120) {
            const sweepHz = this.status?.sweepHz ?? 50;
            const centerN = this.signalViewEndN() - (this.signalWindowSec * sweepHz) / 2;
            this.signalWindowSec = w;
            if (this.signalEndN !== null) {
              this.signalEndN = this.clampSignalEndN(centerN + (w * sweepHz) / 2);
            }
            this.renderSignalControls();
            this.dirtySignal = true;
            this.dirtyNoiseTable = true;
          }
          break;
        }
        case "signal-freeze":
          if (this.signalEndN === null) {
            this.pauseSignalAt(this.signalRing.latestN());
          } else {
            this.signalEndN = null;
          }
          this.renderSignalControls();
          this.dirtySignal = true;
          this.dirtyNoiseTable = true;
          break;
        case "signal-reset-y":
          this.signalYMin = DBM_MIN;
          this.signalYMax = DBM_MAX;
          this.renderSignalControls();
          this.dirtySignal = true;
          break;
        case "signal-zoom-floor":
          this.signalYMin = -102;
          this.signalYMax = -68;
          this.renderSignalControls();
          this.dirtySignal = true;
          break;
        case "signal-clear":
          this.signalRing.clear();
          this.signalEndN = null;
          this.renderSignalControls();
          this.dirtySignal = true;
          this.dirtyNoiseTable = true;
          break;
        case "signal-ch": {
          const idx = Number(t.dataset.ch);
          if (idx >= 0 && idx < 8) {
            this.signalEnabledCh[idx] = !this.signalEnabledCh[idx];
            this.renderSignalControls();
            this.dirtySignal = true;
          }
          break;
        }
        case "signal-ch-all": {
          const allOn = this.signalEnabledCh.every(Boolean);
          this.signalEnabledCh = this.signalEnabledCh.map(() => !allOn);
          this.renderSignalControls();
          this.dirtySignal = true;
          break;
        }
        case "signal-toggle-floor":
          this.signalShowFloor = !this.signalShowFloor;
          this.renderSignalControls();
          this.dirtySignal = true;
          break;
        case "signal-toggle-hit":
          this.signalShowHitLine = !this.signalShowHitLine;
          this.renderSignalControls();
          this.dirtySignal = true;
          break;
        case "signal-toggle-thr":
          this.signalShowThresholds = !this.signalShowThresholds;
          this.renderSignalControls();
          this.dirtySignal = true;
          break;
        case "export-signal-csv":
          downloadTextFile(
            buildFileStamp(this.status, "signal", "csv"),
            exportSignalCsv(this.signalRing, this.status?.sweepHz ?? 50)
          );
          break;
        case "export-signal-png": {
          const c = this.el.querySelector<HTMLCanvasElement>("[data-signal-canvas]");
          if (c) downloadCanvasPng(c, buildFileStamp(this.status, "signal", "png"));
          break;
        }
        case "scan": {
          const start = this.num("[data-scan-start]", 5180);
          const stop = this.num("[data-scan-stop]", 5917);
          const step = this.num("[data-scan-step]", 5);
          this.scanning = true;
          this.renderScan();
          await this.console.request(`SCAN ${start} ${stop} ${step}`, "scan", 5000).catch((err: Error) => {
            this.scanning = false;
            this.renderScan();
            throw err;
          });
          break;
        }
        case "scan-live": {
          this.scanToggleAt = Date.now();
          if (this.scanLive) {
            this.scanLive = false;
            await this.console.request("SCAN STOP", "ok", 2000).catch(() => undefined);
          } else {
            const start = this.num("[data-scan-start]", 5180);
            const stop = this.num("[data-scan-stop]", 5917);
            const step = this.num("[data-scan-step]", 5);
            this.spectrumAcc.clearHoldAndAvg();
            await this.console.request(`SCAN LIVE ${start} ${stop} ${step}`, "ok", 2000);
            this.scanLive = true;
          }
          this.renderScan();
          this.renderLiveHead();
          break;
        }
        case "clear-hold":
          this.spectrumAcc.clearHoldAndAvg();
          this.dirtySpectrum = true;
          break;
        case "wf-jump-live":
          this.spectrumAcc.setScrollRow(0);
          this.updateScanFindings();
          this.dirtyWaterfall = true;
          break;
        case "scan-reset-zoom":
          this.scanZoomStartMHz = null;
          this.scanZoomStopMHz = null;
          this.renderScan();
          break;
        case "scan-preset": {
          const start = Number(t.dataset.start) || 5180;
          const stop = Number(t.dataset.stop) || 5917;
          const step = Number(t.dataset.step) || 5;
          const iStart = this.el.querySelector<HTMLInputElement>("[data-scan-start]");
          const iStop = this.el.querySelector<HTMLInputElement>("[data-scan-stop]");
          const iStep = this.el.querySelector<HTMLInputElement>("[data-scan-step]");
          if (iStart) iStart.value = String(start);
          if (iStop) iStop.value = String(stop);
          if (iStep) iStep.value = String(step);
          if (this.scanLive && this.console.connected) {
            this.scanToggleAt = Date.now();
            this.spectrumAcc.clearHoldAndAvg();
            await this.console.request(`SCAN LIVE ${start} ${stop} ${step}`, "ok", 2000);
          }
          this.renderScan();
          break;
        }
        case "scan-toggle-hold":
          this.scanShowMaxHold = !this.scanShowMaxHold;
          this.renderScan();
          break;
        case "scan-toggle-avg":
          this.scanShowAvg = !this.scanShowAvg;
          this.renderScan();
          break;
        case "scan-toggle-wifi":
          this.scanShowWifi = !this.scanShowWifi;
          this.renderScan();
          break;
        case "export-scan-csv":
          downloadTextFile(buildFileStamp(this.status, "scans", "csv"), exportScanHistoryCsv(this.spectrumAcc));
          break;
        case "export-spectrum-png": {
          const c = this.el.querySelector<HTMLCanvasElement>("[data-spectrum-canvas]");
          if (c) downloadCanvasPng(c, buildFileStamp(this.status, "spectrum", "png"));
          break;
        }
        case "export-waterfall-png": {
          const c = this.el.querySelector<HTMLCanvasElement>("[data-waterfall-canvas]");
          if (c) downloadCanvasPng(c, buildFileStamp(this.status, "waterfall", "png"));
          break;
        }
        case "log":
          this.logOn = !this.logOn;
          await this.console.send(this.logOn ? "LOG 1" : "LOG 0");
          this.renderLog();
          break;
        case "clear-log":
          this.logLines = [];
          this.renderLog();
          break;
        case "read-config":
          await this.console.send("SLAPRF?");
          break;
        case "selftest":
          await this.runBusy("Self-test", () => this.runSelfTest());
          break;
        case "copy-report":
          await this.copy(this.reportText(), t);
          break;
        case "restart-capture":
          await this.runBusy("Restarting", () => this.restartAndCapture());
          break;
        case "restart-test": {
          const n = Math.max(1, Math.min(50, this.num("[data-restart-count]", 5)));
          await this.runBusy("Restart test", () => this.restartTest(n));
          break;
        }
        case "bootlog":
          this.bootLog = await this.console.request<BootLog>("BOOTLOG?", "bootlog", 3000);
          this.renderRestart();
          break;
        case "lastlog":
          this.bootLog = await this.console.request<BootLog>("LASTLOG?", "bootlog", 3000);
          this.renderRestart();
          break;
        case "copy-bootlog":
          if (this.bootLog) await this.copy(this.bootLogHeader(this.bootLog) + "\n" + this.bootLog.text, t);
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/No port selected|cancel/i.test(msg)) this.error = msg;
    }
    this.renderConnection();
  }

  /** Start polling status and streaming live readings on a freshly opened port. */
  private async startSession(): Promise<void> {
    window.clearInterval(this.statusTimer);
    await this.console.send("STATUS?");
    this.statusTimer = window.setInterval(() => void this.console.send("STATUS?").catch(() => undefined), 2000);
    this.liveOn = true;
    this.liveMode = this.signalCardVisible ? 2 : 1;
    await this.console.send(`LIVE ${this.liveMode}`);
    if (this.logOn) await this.console.send("LOG 1");
    this.renderLiveHead();
    this.renderSignalControls();
  }

  private async refreshStatus(): Promise<TimerStatus> {
    return this.console.request<TimerStatus>("STATUS?", "status", 2000);
  }

  private async runBusy(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = name;
    this.progress = "";
    this.renderBusy();
    try {
      await fn();
    } finally {
      this.busy = null;
      this.progress = "";
      this.renderBusy();
    }
  }

  private setProgress(text: string): void {
    this.progress = text;
    this.renderSelfTest();
    this.renderRestart();
  }

  private async copy(text: string, button: HTMLElement): Promise<void> {
    await navigator.clipboard.writeText(text);
    const label = button.querySelector("span");
    if (label) {
      const old = label.textContent;
      label.textContent = "Copied";
      window.setTimeout(() => (label.textContent = old), 1500);
    }
  }

  // ---------------------------------------------------------------- restarts

  /** Restart, reattach, re-enable the streams the user had on. Returns the first status. */
  private async restart(): Promise<TimerStatus> {
    window.clearInterval(this.statusTimer);
    this.live = null;
    this.scanLive = false; // The firmware forgets it on restart
    this.renderScan();
    try {
      const s = await this.console.restartAndReconnect();
      this.renderConnection();
      await this.startSession();
      return s;
    } catch (err) {
      await this.console.disconnect();
      throw err;
    }
  }

  private async restartAndCapture(): Promise<void> {
    this.setProgress("Restarting the timer…");
    await this.restart();
    this.setProgress("Reading the boot log…");
    await sleep(1500); // let Wi-Fi and the sweep task finish starting so their messages are in the log
    this.bootLog = await this.console.request<BootLog>("BOOTLOG?", "bootlog", 3000);
    this.renderRestart();
  }

  private async restartTest(count: number): Promise<void> {
    this.runs = [];
    let prev = await this.refreshStatus();
    for (let n = 1; n <= count; n++) {
      this.setProgress(`Restart ${n} of ${count}…`);
      const t0 = performance.now();
      let run: RestartRun;
      try {
        const s = await this.restart();
        const extra = Math.max(0, s.boots - prev.boots - 1);
        const bad = BAD_RESETS.includes(s.reset);
        run = {
          n,
          ok: !bad,
          ms: Math.round(performance.now() - t0),
          reset: s.reset,
          extraBoots: extra,
          note: bad ? "crashed while starting" : extra ? `restarted ${extra} extra time${extra > 1 ? "s" : ""} while starting` : "",
        };
        prev = s;
      } catch (err) {
        this.runs.push({ n, ok: false, ms: Math.round(performance.now() - t0), reset: "—", extraBoots: 0, note: err instanceof Error ? err.message : String(err) });
        this.renderRestart();
        return;
      }
      this.runs.push(run);
      this.renderRestart();
      if (run.extraBoots || !run.ok) {
        // Grab the crashed boot's log while it is still the "previous" one.
        this.bootLog = await this.console.request<BootLog>("LASTLOG?", "bootlog", 3000).catch(() => this.bootLog);
      }
      await sleep(1000);
    }
  }

  // ---------------------------------------------------------------- self-test

  private async runSelfTest(): Promise<void> {
    this.checks = [];
    this.reportExtra = "";
    this.checksAt = new Date();
    if (this.scanLive) {
      // Give the receiver back to the timing sweep so the checks see normal operation.
      this.scanLive = false;
      this.scanToggleAt = Date.now();
      await this.console.request("SCAN STOP", "ok", 2000).catch(() => undefined);
      this.renderScan();
    }
    const add = (name: string, result: CheckResult, detail: string) => {
      this.checks.push({ name, result, detail });
      this.renderSelfTest();
    };

    // 1. Console
    this.setProgress("Asking for status…");
    let s: TimerStatus;
    try {
      s = await this.console.request<TimerStatus>("STATUS?", "status", 3000);
      add("Console", "pass", `firmware ${s.fw}, up ${fmtUptime(s.uptimeMs)}`);
    } catch (err) {
      add("Console", "fail", `${err instanceof Error ? err.message : err}. Is this a SlapRF timer, and is it running (not in download mode)?`);
      return;
    }

    // 2. Identity
    const profile = FIRMWARE_PROFILES.find((p) => p.code === s.profile);
    if (!profile) add("Identity", "fail", `unknown firmware profile ${s.profile}; flash a current SlapRF build`);
    else if (s.fp.toUpperCase() === UNPROVISIONED_FP)
      add("Identity", "warn", `${profile.name}, but not set up yet (default fingerprint). Use Setup → Timers to give it an identity.`);
    else add("Identity", "pass", `${s.label || "(unnamed)"} · ${s.role === 1 ? "Hub" : "Spoke"} · ${profile.name} · ${s.fp}`);

    // 3. Receiver
    if (!s.rf.ok) add("5.8 GHz receiver", "fail", "the receiver's boot check failed; restart the timer and look at the boot log");
    else if (!s.rf.enabled) add("5.8 GHz receiver", "warn", "switched off from this page; switch it back on in Live readings");
    else if (s.rf.floorDb < -100 || s.rf.floorDb > -80)
      add("5.8 GHz receiver", "warn", `noise floor ${s.rf.floorDb.toFixed(1)} dBm is outside the usual −100…−80 dBm (antenna, or strong interference nearby)`);
    else add("5.8 GHz receiver", "pass", `noise floor ${s.rf.floorDb.toFixed(1)} dBm, gain ${s.rf.gain}/${s.rf.gainMax}`);

    // 4. Sweep timing
    const budget = s.sweepBudgetUs || (s.sweepHz ? Math.round(1e6 / s.sweepHz) : 0);
    if (!s.sweeps) add("Sweep timing", "fail", "no sweeps yet; the sweep task is not running");
    else if (budget && s.sweepUsMax > budget)
      add("Sweep timing", "warn", `slowest sweep ${(s.sweepUsMax / 1000).toFixed(2)} ms is over the ${(budget / 1000).toFixed(1)} ms budget (typical ${(s.sweepUs / 1000).toFixed(2)} ms)`);
    else add("Sweep timing", "pass", `${s.sweepHz} Hz, ${(s.sweepUs / 1000).toFixed(2)} ms typical, ${(s.sweepUsMax / 1000).toFixed(2)} ms slowest of ${(budget / 1000).toFixed(1)} ms`);

    // 5. Live stream
    this.setProgress("Measuring the live stream…");
    const wasLive = this.liveOn;
    await this.console.send("LIVE 1");
    await sleep(300);
    const c0 = this.liveCount;
    await sleep(2000);
    const rate = (this.liveCount - c0) / 2;
    await this.console.send(wasLive ? `LIVE ${this.liveMode}` : "LIVE 0");
    add("Live readings", rate >= 6 ? "pass" : rate > 0 ? "warn" : "fail", `${rate.toFixed(1)} updates/s (expected about 10)`);

    // 6. Spectrum scan
    this.setProgress("Scanning the band…");
    if (!s.rf.enabled) add("Spectrum scan", "skip", "receiver is switched off");
    else {
      const t0 = performance.now();
      try {
        const scan = await this.console.request<ScanResult>("SCAN 5180 5917 5", "scan", 4000);
        const ms = Math.round(performance.now() - t0);
        const expected = Math.floor((5917 - 5180) / 5) + 1;
        add("Spectrum scan", scan.dbm.length === expected && ms < 3000 ? "pass" : "warn", `${scan.dbm.length}/${expected} points in ${(ms / 1000).toFixed(1)} s`);
      } catch (err) {
        add("Spectrum scan", "fail", err instanceof Error ? err.message : String(err));
      }
    }

    // 7. Saved configuration
    this.setProgress("Reading the saved configuration…");
    try {
      const c = await this.console.request<TimerReadout>("SLAPRF?", "config", 2000);
      if (c.fingerprint.toUpperCase() !== s.fp.toUpperCase())
        add("Saved configuration", "fail", `saved fingerprint ${c.fingerprint} doesn't match the running one ${s.fp}`);
      else add("Saved configuration", "pass", `${c.role} "${c.timerLabel}", ${c.frequenciesMHz.length} channels, Wi-Fi "${c.wifiSSID}"`);
    } catch (err) {
      add("Saved configuration", "fail", `couldn't read it (${err instanceof Error ? err.message : err})`);
    }

    // 8. Memory
    add(
      "Memory",
      s.heapMin > 20 * 1024 ? "pass" : "warn",
      `${(s.heapFree / 1024).toFixed(0)} KB free, lowest ${(s.heapMin / 1024).toFixed(0)} KB${s.heapMin > 20 * 1024 ? "" : " (low: it may run out)"}`
    );

    // 9. Last restart
    if (BAD_RESETS.includes(s.reset)) {
      add("Last restart", "fail", `${s.reset}: the timer crashed or lost power. The previous boot's log is attached to the report.`);
      try {
        const last = await this.console.request<BootLog>("LASTLOG?", "bootlog", 3000);
        this.bootLog = last;
        this.reportExtra = `\n--- previous boot log (${last.reset}) ---\n${last.text}`;
        this.renderRestart();
      } catch {
        // report without it
      }
    } else add("Last restart", "pass", `${s.reset}, boot #${s.boots}`);

    // 10. Wi-Fi role
    if (s.role === 1) {
      const ap = s.net.mode === "ap" || s.net.mode === "ap+sta";
      add("Wi-Fi", ap ? "pass" : "fail", ap ? `Hub network up on channel ${s.channel}, ${s.net.stations} device${s.net.stations === 1 ? "" : "s"} joined` : `Hub network is not running (mode ${s.net.mode})`);
    } else {
      add("Wi-Fi", s.slot >= 2 ? "pass" : "warn", s.slot >= 2 ? `joined the Hub, slot ${s.slot}, channel ${s.channel}` : "not joined to a Hub yet (is the Hub on and in range?)");
    }

    // 11. Data reaching this laptop
    this.setProgress("Checking that its data reaches this laptop…");
    add(...(await this.checkNetworkPath(s)));
  }

  private async checkNetworkPath(s: TimerStatus): Promise<[string, CheckResult, string]> {
    const name = "Reaches this laptop";
    const get = async (): Promise<DebugTimerInfo | null> => {
      try {
        const res = await fetch(`/api/debug/timer?fp=${encodeURIComponent(s.fp)}`, { cache: "no-store" });
        if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
        return (await res.json()) as DebugTimerInfo;
      } catch {
        return null;
      }
    };
    const a = await get();
    if (!a) return [name, "skip", "no SlapRF server here (open this page from slaprf on the race laptop to check)"];
    if (!a.found) {
      const hint = s.role === 1 ? "Is this laptop joined to the timer's Wi-Fi network?" : "Is the Hub on, and this laptop joined to its Wi-Fi network?";
      return [name, "fail", `the server hasn't heard from ${s.fp}. ${hint}`];
    }
    const sim = a.simulatorActive ? " (the app is showing the simulator; switch to real timers to use it)" : "";
    if (!a.online || (a.msSinceSeen ?? 0) > 3000)
      return [name, "fail", `last heard ${((a.msSinceSeen ?? 0) / 1000).toFixed(0)} s ago${sim}`];
    await sleep(2000);
    const b = await get();
    const perSec = b ? (b.framesRx - a.framesRx) / 2 : 0;
    if (b && b.framesRx > a.framesRx) return [name, a.simulatorActive ? "warn" : "pass", `online as timer ${a.puckId}, ${perSec.toFixed(0)} frames/s${sim}`];
    if (!a.framesRx) return [name, a.simulatorActive ? "warn" : "pass", `online as timer ${a.puckId} (not assigned to a gate, so frames aren't counted)${sim}`];
    return [name, "fail", `online but no new frames in 2 s${sim}`];
  }

  private reportText(): string {
    const s = this.status;
    const lines = [
      `SlapRF self-test · ${this.checksAt?.toISOString() ?? ""}`,
      s ? `${s.label || "(unnamed)"} · ${s.role === 1 ? "Hub" : "Spoke"} · fp ${s.fp} · fw ${s.fw} · profile ${s.profile}` : "",
      s ? `${s.chip.model} ${s.chip.rev} · ${s.chip.mac} · ${s.chip.flashMB} MB flash · boot #${s.boots} (${s.reset})` : "",
      "",
      ...this.checks.map((c) => `[${c.result.toUpperCase().padEnd(4)}] ${c.name}: ${c.detail}`),
    ];
    return lines.join("\n") + this.reportExtra + "\n";
  }

  // ---------------------------------------------------------------- rendering

  private num(sel: string, fallback: number): number {
    const v = Number(this.el.querySelector<HTMLInputElement>(sel)?.value);
    return Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;
  }

  private renderAll(): void {
    this.renderConnection();
    this.renderSelfTest();
    this.renderStatus();
    this.renderLiveHead();
    this.renderLive();
    this.renderChannels();
    this.renderSignalControls();
    this.renderNoiseTable();
    this.renderScan();
    this.renderRestart();
    this.renderLog();
    this.dirtySignal = true;
    this.dirtySpectrum = true;
    this.dirtyWaterfall = true;
    this.dirtyHealth = true;
  }

  private renderBusy(): void {
    this.renderConnection();
    this.renderSelfTest();
    this.renderRestart();
  }

  private renderConnection(): void {
    const on = this.console.connected;
    const supported = TimerConsole.supported();
    const busy = this.busy !== null;
    this.slot("connection").innerHTML = `
      <div class="debug-connect">
        <div class="debug-connect-state">
          <span class="status-dot ${on ? "is-up" : ""}"></span>
          <strong>${busy && !on ? `${esc(this.busy!)}…` : on ? (this.status ? `Connected to ${esc(this.status.label || "timer")}` : "Connected") : "Not connected"}</strong>
          ${on && this.status ? `<span class="note mono">${esc(this.status.fp)}</span>` : ""}
        </div>
        <div class="debug-connect-actions">
          ${
            on
              ? `<button type="button" class="btn btn-sm btn-ghost" data-action="read-config" ${busy ? "disabled" : ""}>Read config</button>
                 <button type="button" class="btn btn-sm" data-action="disconnect" ${busy ? "disabled" : ""}>Disconnect</button>`
              : busy
                ? ""
                : `<label class="flasher-port-toggle"><input type="checkbox" data-all-ports ${this.showAllPorts ? "checked" : ""}/><span>Show all USB serial ports</span></label>
                 <button type="button" class="btn btn-armed" data-action="connect" ${supported ? "" : "disabled"}>${icons.plug(15)}<span>Connect over USB</span></button>`
          }
        </div>
      </div>
      ${!supported ? `<p class="note">USB debugging needs Chrome, Edge or Brave (WebSerial).</p>` : ""}
      ${this.error ? `<div class="sim-error-note">${esc(this.error)}</div>` : ""}`;
  }

  private renderSelfTest(): void {
    const on = this.console.connected;
    const running = this.busy === "Self-test";
    const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
    for (const c of this.checks) counts[c.result]++;
    const summary = this.checks.length
      ? running
        ? esc(this.progress)
        : counts.fail
          ? `<span class="tone-bad">${counts.fail} problem${counts.fail > 1 ? "s" : ""} found</span>`
          : counts.warn
            ? `<span class="debug-tone-warn">Passed with ${counts.warn} warning${counts.warn > 1 ? "s" : ""}</span>`
            : `<span class="tone-good">All checks passed</span>`
      : running
        ? esc(this.progress)
        : on
          ? "Takes about 10 seconds. Timing pauses briefly during the scan."
          : "Connect a timer first.";
    this.slot("selftest").innerHTML = `
      <div class="debug-card-head">
        <span class="note debug-head-note">${summary}</span>
        <div class="debug-connect-actions">
          <button type="button" class="btn btn-sm btn-ghost" data-action="copy-report" ${this.checks.length && !running ? "" : "disabled"}><span>Copy report</span></button>
          <button type="button" class="btn btn-sm btn-armed" data-action="selftest" ${on && !this.busy ? "" : "disabled"}>
            ${icons.bug(14)}<span>${running ? "Testing…" : "Run self-test"}</span>
          </button>
        </div>
      </div>
      ${
        this.checks.length
          ? `<ul class="debug-checks">${this.checks
              .map(
                (c) => `<li class="debug-check is-${c.result}">
                  <span class="debug-check-badge">${c.result === "pass" ? "PASS" : c.result === "warn" ? "WARN" : c.result === "fail" ? "FAIL" : "SKIP"}</span>
                  <strong>${esc(c.name)}</strong>
                  <span class="debug-check-detail">${esc(c.detail)}</span>
                </li>`
              )
              .join("")}</ul>`
          : ""
      }`;
  }

  private renderStatus(): void {
    const s = this.status;
    if (!s) {
      this.slot("status").innerHTML = `<p class="note">${this.console.connected ? "Waiting for the timer…" : "Connect a timer to see its status."}</p>`;
      return;
    }
    const profile = FIRMWARE_PROFILES.find((p) => p.code === s.profile);
    const budget = s.sweepBudgetUs || (s.sweepHz ? Math.round(1e6 / s.sweepHz) : 0);
    const badReset = BAD_RESETS.includes(s.reset);
    const rows: Array<[string, string]> = [
      ["Timer", `${esc(s.label || "(unnamed)")} · ${s.role === 1 ? "Hub" : "Spoke"}${s.slot ? ` · slot ${s.slot}` : ""}`],
      ["Firmware", `${esc(profile?.name ?? `profile ${s.profile}`)} · ${esc(s.fw)}`],
      ["Fingerprint", `<span class="mono">${esc(s.fp)}</span>${s.fp.toUpperCase() === UNPROVISIONED_FP ? ` <span class="badge badge-warn">not set up</span>` : ""}`],
      ["Chip", s.chip ? `${esc(s.chip.model)} ${esc(s.chip.rev)} · ${s.chip.flashMB} MB flash · <span class="mono">${esc(s.chip.mac)}</span>` : "—"],
      ["Uptime", `${fmtUptime(s.uptimeMs)} <span class="note">(boot #${s.boots ?? "?"})</span>`],
      ["Last restart", badReset ? `<span class="tone-bad">${esc(s.reset)}</span> <span class="note">— see the previous boot's log below</span>` : esc(s.reset)],
      ["Memory free", `${(s.heapFree / 1024).toFixed(0)} KB <span class="note">(lowest ${(s.heapMin / 1024).toFixed(0)} KB)</span>`],
      [
        "Sweeps",
        `${s.sweepHz} Hz · ${(s.sweepUs / 1000).toFixed(2)} ms <span class="note">(slowest <span class="${budget && s.sweepUsMax > budget ? "debug-tone-warn" : ""}">${(s.sweepUsMax / 1000).toFixed(2)} ms</span> of ${(budget / 1000).toFixed(1)} ms)</span>`,
      ],
      [
        "5.8 GHz receiver",
        !s.rf.ok
          ? `<span class="badge badge-bad">Boot check failed</span>`
          : !s.rf.enabled
            ? `<span class="badge badge-warn">Switched off</span>`
            : s.scanLive
              ? `<span class="badge badge-warn">Live scan</span> lap timing paused · floor ${s.rf.floorDb.toFixed(1)} dBm`
              : `<span class="badge badge-good">OK</span> gain ${s.rf.gain}/${s.rf.gainMax} · floor ${s.rf.floorDb.toFixed(1)} dBm`,
      ],
      [
        "Wi-Fi",
        s.net
          ? s.role === 1
            ? `${esc(s.net.mode)} · channel ${s.channel} · ${s.net.stations} device${s.net.stations === 1 ? "" : "s"} joined`
            : `${esc(s.net.mode)} · channel ${s.channel}${s.slot >= 2 ? ` · slot ${s.slot}` : " · not joined to a Hub"}`
          : `channel ${s.channel}`,
      ],
      ["Channels", `<span class="mono">${s.freqs.join(" · ")}</span> MHz${s.freqsTemporary ? ` <span class="badge badge-warn">temporary</span>` : ""}`],
    ];
    this.slot("status").innerHTML = `
      <dl class="debug-status">
        ${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}
      </dl>`;
  }

  private renderLiveHead(): void {
    const on = this.console.connected;
    const rfOn = this.status?.rf.enabled ?? true;
    this.slot("live-head").innerHTML = `
      <div class="debug-card-head">
        <span class="note debug-head-note mono" data-live-note>${on ? "Waiting for sweep stream…" : "Not connected"}</span>
        <div class="debug-connect-actions">
          <label class="debug-switch-inline ${on && this.status ? "" : "is-disabled"}" title="Switch the hardware 5.8 GHz receiver on or off">
            <span class="debug-switch-label">${rfOn ? icons.signal(13) : icons.signalOff(13)}<span>5.8 GHz receiver</span></span>
            <span class="switch"><input type="checkbox" data-check="rf-enable" ${rfOn ? "checked" : ""} ${on && this.status ? "" : "disabled"}/><span></span></span>
          </label>
          <button type="button" class="btn btn-sm debug-btn-transport ${this.liveOn ? "is-running" : "is-paused"}" data-action="live" ${on ? "" : "disabled"}>
            ${this.liveOn ? icons.pause(14) : icons.play(14)}<span>${this.liveOn ? "Pause stream" : "Resume stream"}</span>
          </button>
        </div>
      </div>`;
    this.updateLive();
  }

  /** Build the bar rows once per channel set; updateLive() then only touches styles and text. */
  private renderLive(): void {
    const freqs = this.status?.freqs ?? RACEBAND;
    this.slot("live").innerHTML = `
      <div class="debug-bars">
        ${freqs
          .map((f) => {
            const band = racebandName(f);
            return `
            <div class="debug-bar-row" data-bar>
              <span class="debug-bar-label mono">${band ? `<strong>${band}</strong> ` : ""}${f}</span>
              <div class="debug-bar-track">
                <span class="debug-bar-fill" style="width:0%"></span>
                <span class="debug-bar-peak" style="left:0%;display:none"></span>
              </div>
              <span class="debug-bar-value mono">—</span>
              <span class="debug-bar-hits mono" title="Readings more than 10 dB above this channel's typical noise since the previous update">—</span>
            </div>`;
          })
          .join("")}
      </div>
      <div class="debug-scale mono"><span>${DBM_MIN} dBm</span><span>${DBM_MAX} dBm</span></div>`;
    this.updateLive();
  }

  private updateLive(): void {
    const l = this.live;
    const note = this.el.querySelector<HTMLElement>("[data-live-note]");
    if (note) {
      if (!this.console.connected) {
        note.textContent = "Not connected";
      } else if (this.scanLive || this.status?.scanLive) {
        note.textContent = "Paused · live spectrum scan is using the 5.8 GHz receiver";
      } else if (this.status && !this.status.rf.enabled) {
        note.textContent = "5.8 GHz receiver is switched off";
      } else if (!this.liveOn) {
        note.textContent = "Stream paused";
      } else if (l) {
        note.textContent = `Sweep ${(l.us / 1000).toFixed(2)} ms · streaming at ${this.liveMode === 2 ? "50 Hz (every sweep)" : "10 Hz"}`;
      } else {
        note.textContent = "Waiting for sweep stream…";
      }
    }
    const pct = (x: number) => Math.max(0, Math.min(100, ((x - DBM_MIN) / (DBM_MAX - DBM_MIN)) * 100));
    this.el.querySelectorAll<HTMLElement>("[data-bar]").forEach((row, i) => {
      const fill = row.querySelector<HTMLElement>(".debug-bar-fill")!;
      const peak = row.querySelector<HTMLElement>(".debug-bar-peak")!;
      const value = row.querySelector<HTMLElement>(".debug-bar-value")!;
      const hits = row.querySelector<HTMLElement>(".debug-bar-hits")!;
      const v = l?.dbm[i];
      const pk = l?.pk[i];
      const h = l?.hits?.[i];
      fill.style.width = v !== undefined && v > -127 ? `${pct(v)}%` : "0%";
      peak.style.display = pk !== undefined && pk > -127 ? "" : "none";
      if (pk !== undefined) peak.style.left = `${pct(pk)}%`;
      value.textContent = v !== undefined && v > -127 ? `${v} dBm` : "—";
      hits.textContent = h !== undefined ? `${h} hit${h === 1 ? "" : "s"}` : "—";
      hits.classList.toggle("is-active", (h ?? 0) > 0);
    });
  }

  private renderChannels(): void {
    const on = this.console.connected;
    const s = this.status;
    const freqs = s?.freqs ?? RACEBAND;
    const isTemp = Boolean(s?.freqsTemporary);
    this.slot("channels").innerHTML = `
      <div class="debug-channels">
        <div class="debug-channels-head">
          <div class="debug-channels-title">
            <strong>Try other channels</strong>
            <span class="badge ${isTemp ? "badge-warn" : ""}">${isTemp ? "Temporary · not saved" : "Saved channels"}</span>
          </div>
          <div class="debug-connect-actions">
            <button type="button" class="btn btn-sm btn-ghost" data-action="channels-raceband" ${on ? "" : "disabled"}>Load Raceband</button>
            <button type="button" class="btn btn-sm btn-ghost" data-action="channels-reset" ${on && isTemp ? "" : "disabled"}>Back to saved</button>
            <button type="button" class="btn btn-sm btn-armed" data-action="channels-apply" ${on && s ? "" : "disabled"}>Apply until restart</button>
          </div>
        </div>
        <div class="debug-channels-inputs">
          ${freqs
            .map((f, i) => {
              const rb = racebandName(f) || `Ch ${i + 1}`;
              return `<label><span class="note mono">${rb}</span><input class="input mono" type="number" min="5180" max="5917" data-chan value="${f}" ${on ? "" : "disabled"}/></label>`;
            })
            .join("")}
        </div>
      </div>`;
  }

  private renderSignalControls(): void {
    const freqs = this.status?.freqs ?? RACEBAND;
    const hasPts = this.signalRing.points.length > 0;
    const allOn = this.signalEnabledCh.every(Boolean);
    const isLive = this.signalEndN === null;
    const isYZoomed = this.signalYMin !== DBM_MIN || this.signalYMax !== DBM_MAX;
    this.slot("signal-controls").innerHTML = `
      <div class="debug-toolbar">
        <div class="debug-toolbar-left">
          <button type="button" class="btn btn-sm scope-live-btn ${isLive ? "btn-armed" : "btn-ghost"}" data-action="signal-freeze" title="${isLive ? "Following live 50 Hz stream — click to pause, or drag the chart to scroll back" : "Paused / scrolled back — click to jump back to live"}">
            <span class="status-dot ${isLive ? "is-up" : ""}"></span><span>Live</span>
          </button>
          <div class="segmented" role="group" aria-label="Time window">
            ${([5, 10, 30, 120] as const)
              .map(
                (w) =>
                  `<button type="button" class="${Math.round(this.signalWindowSec) === w ? "is-active" : ""}" data-action="signal-window" data-win="${w}">${w === 120 ? "2 min" : `${w} s`}</button>`
              )
              .join("")}
          </div>
          <div class="debug-overlay-checks" role="group" aria-label="Chart overlays">
            <label class="check" title="Show per-channel typical noise floor (dotted)">
              <input type="checkbox" data-check="signal-floor" ${this.signalShowFloor ? "checked" : ""}/>
              <span>Floor</span>
            </label>
            <label class="check" title="Show floor + 10 dB hit threshold (dashed)">
              <input type="checkbox" data-check="signal-hit" ${this.signalShowHitLine ? "checked" : ""}/>
              <span>Hit line (+10 dB)</span>
            </label>
            <label class="check" title="Show pilot enter thresholds">
              <input type="checkbox" data-check="signal-thr" ${this.signalShowThresholds ? "checked" : ""}/>
              <span>Enter threshold</span>
            </label>
          </div>
        </div>
        <div class="debug-connect-actions">
          ${
            isYZoomed
              ? `<button type="button" class="btn btn-sm debug-btn-transport is-paused mono" data-action="signal-reset-y" title="Reset Y-axis dBm zoom to full scale (${DBM_MIN}…${DBM_MAX} dBm)">Y: ${this.signalYMin}…${this.signalYMax} dBm ×</button>`
              : `<button type="button" class="btn btn-sm btn-ghost" data-action="signal-zoom-floor" title="Zoom Y-axis into the noise floor region (−102…−68 dBm), or drag vertically on the Y-axis">Zoom floor Y</button>`
          }
          <button type="button" class="btn btn-sm" data-action="signal-clear" ${hasPts ? "" : "disabled"}>Clear</button>
          <div class="debug-btn-group" role="group" aria-label="Export signal chart">
            <button type="button" class="btn btn-sm btn-ghost" data-action="export-signal-csv" ${hasPts ? "" : "disabled"} title="Download recorded 50 Hz samples as CSV">CSV</button>
            <button type="button" class="btn btn-sm btn-ghost" data-action="export-signal-png" ${hasPts ? "" : "disabled"} title="Save chart snapshot as PNG">PNG</button>
          </div>
        </div>
      </div>
      <div class="debug-channel-chips">
        ${freqs
          .map((f, i) => {
            const rb = racebandName(f) || `Ch${i + 1}`;
            const on = this.signalEnabledCh[i];
            const col = CHANNEL_COLORS[i];
            return `<button type="button" class="debug-ch-chip mono ${on ? "is-on" : ""}" data-action="signal-ch" data-ch="${i}" style="--ch-color:${col}">
              <span class="debug-ch-dot"></span><strong>${rb}</strong> <span>${f}</span>
            </button>`;
          })
          .join("")}
        <button type="button" class="btn btn-sm btn-ghost debug-ch-all-btn" data-action="signal-ch-all">${allOn ? "Hide all" : "Show all"}</button>
        <span class="note debug-chart-hint">${isLive ? "Live · drag horizontally to scroll back, wheel to zoom time, drag Y-axis (or Shift+wheel) to zoom dBm" : "Paused · drag to scroll, wheel to zoom, double-click or click Live to resume"}</span>
      </div>`;
  }

  private renderNoiseTable(): void {
    const freqs = this.status?.freqs ?? RACEBAND;
    const sweepHz = this.status?.sweepHz ?? 50;
    const summary = this.signalRing.computeStats(this.signalWindowSec, freqs, this.pilots, sweepHz, this.signalEndN);
    const triggerRows = summary.rows.filter((r) => r.pctWouldTrigger > 0);
    const noisyRows = summary.rows.filter((r) => r.pctWouldTrigger === 0 && (r.hitsPerSec >= 0.5 || (r.sd !== null && r.sd > 2.5)));

    let badgeTone = "";
    let badgeLabel = "Collecting…";
    let primaryFinding = "Waiting for 50 Hz sweep samples from the timer…";
    let secondaryFinding = "Power on a VTX to inspect crossing curves, or watch with all VTXes off to measure venue background noise.";

    if (summary.totalSamples >= 10) {
      if (triggerRows.length > 0) {
        badgeTone = "badge-warn";
        badgeLabel = `${triggerRows.length} ch reached enter`;
        const list = triggerRows
          .map((r) => `${r.bandLabel || `Ch${r.index + 1}`} (${r.freqMHz} MHz, max ${r.max ?? "—"} dBm vs ${r.enterThreshold} dBm, ${r.pctWouldTrigger.toFixed(1)}%)`)
          .join(" · ");
        primaryFinding = `Signal reached pilot enter threshold on ${list}.`;
        secondaryFinding =
          "If a VTX is powered on, this is normal. If no drone is powered, raise that channel's enter threshold or check for a nearby transmitter to prevent false laps.";
      } else if (noisyRows.length > 0) {
        badgeTone = "badge-accent";
        badgeLabel = "In-band RF bursts";
        const list = noisyRows
          .map((r) => `${r.bandLabel || `Ch${r.index + 1}`} (${r.hitsPerSec.toFixed(1)} hits/s, max ${r.max ?? "—"} dBm)`)
          .join(" · ");
        const minMargin = Math.min(...noisyRows.map((r) => r.enterThreshold - (r.max ?? -120)));
        primaryFinding = `Short bursts above noise floor on ${list}.`;
        secondaryFinding = `Peaks remain at least ${minMargin} dB below pilot enter thresholds (0% would trigger) — typical of nearby 5 GHz Wi-Fi on UNII-3 (R3–R6) and will not cause false laps.`;
      } else {
        badgeTone = "badge-good";
        badgeLabel = "All channels quiet";
        const validRows = summary.rows.filter((r) => r.max !== null);
        const maxPeak = validRows.length ? Math.max(...validRows.map((r) => r.max!)) : -95;
        const minMargin = validRows.length ? Math.min(...validRows.map((r) => r.enterThreshold - r.max!)) : 30;
        primaryFinding = `All 8 channels are steady across the ${summary.durationSec.toFixed(1)} s window (highest reading ${maxPeak} dBm).`;
        secondaryFinding = `At least ${minMargin} dB of headroom below pilot enter thresholds — 0.0% false-lap risk.`;
      }
    }

    if (summary.droppedLines > 0) {
      secondaryFinding += ` (${summary.droppedLines} truncated USB line${summary.droppedLines === 1 ? "" : "s"} skipped.)`;
    }

    this.slot("noise-table").innerHTML = `
      <div class="debug-findings" role="status" aria-live="polite">
        <div class="debug-findings-head">
          <span class="debug-findings-title">Findings</span>
          <span class="badge ${badgeTone}">${esc(badgeLabel)}</span>
          <span class="note mono debug-findings-meta">
            Window ${summary.durationSec.toFixed(1)} s · ${summary.totalSamples} sweeps · ${summary.rateHz.toFixed(1)} Hz
          </span>
        </div>
        <div class="debug-findings-body">
          <p class="debug-findings-primary" title="${esc(primaryFinding)}">${esc(primaryFinding)}</p>
          <p class="note debug-findings-secondary" title="${esc(secondaryFinding)}">${esc(secondaryFinding)}</p>
        </div>
      </div>
      <div class="debug-table-scroll">
        <table class="debug-runs debug-noise-table">
          <thead>
            <tr>
              <th>Channel</th>
              <th>Pilot / Enter</th>
              <th>Mean</th>
              <th>Spread (SD)</th>
              <th>Max</th>
              <th>Floor</th>
              <th>Hits/s (&gt;fl+10)</th>
              <th>&gt;fl+10 %</th>
              <th>Would trigger</th>
            </tr>
          </thead>
          <tbody>
            ${summary.rows
              .map((r) => {
                const col = CHANNEL_COLORS[r.index];
                const trigRisk = r.pctWouldTrigger > 0;
                return `<tr>
                  <td class="mono"><span class="debug-ch-inline" style="background:${col}"></span>${r.bandLabel ? `<strong>${r.bandLabel}</strong> ` : ""}${r.freqMHz} MHz</td>
                  <td class="mono note">${r.pilotCallsign ? `${esc(r.pilotCallsign)} (${r.enterThreshold})` : `${r.enterThreshold} dBm`}</td>
                  <td class="mono">${r.mean !== null ? `${r.mean.toFixed(1)} dBm` : "—"}</td>
                  <td class="mono ${r.sd !== null && r.sd > 3 ? "debug-tone-warn" : ""}">${r.sd !== null ? `${r.sd.toFixed(1)} dB` : "—"}</td>
                  <td class="mono">${r.max !== null ? `${r.max} dBm` : "—"}</td>
                  <td class="mono">${r.floor !== null ? `${r.floor} dBm` : "—"}</td>
                  <td class="mono ${r.hitsPerSec >= 1 ? "debug-tone-warn" : ""}">${r.samples ? r.hitsPerSec.toFixed(1) : "—"}</td>
                  <td class="mono">${r.samples ? `${r.pctAboveFloor10.toFixed(1)}%` : "—"}</td>
                  <td class="mono ${trigRisk ? "debug-tone-warn" : "note"}">${r.samples ? `${r.pctWouldTrigger.toFixed(1)}% (${r.wouldTriggerPerSec.toFixed(1)}/s)` : "—"}</td>
                </tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>`;
  }

  private renderScan(): void {
    const on = this.console.connected;
    const prev = {
      start: this.el.querySelector<HTMLInputElement>("[data-scan-start]")?.value ?? "5180",
      stop: this.el.querySelector<HTMLInputElement>("[data-scan-stop]")?.value ?? "5917",
      step: this.el.querySelector<HTMLInputElement>("[data-scan-step]")?.value ?? "5",
    };
    const dis = this.scanLive ? "disabled" : "";
    const hasScan = this.spectrumAcc.latest !== null;
    const isFull5 = prev.start === "5180" && prev.stop === "5917" && prev.step === "5";
    const isFast15 = prev.start === "5180" && prev.stop === "5917" && prev.step === "15";
    const isRb5 = prev.start === "5650" && prev.stop === "5925" && prev.step === "5";
    const isFreqZoomed = this.scanZoomStartMHz !== null && this.scanZoomStopMHz !== null;
    this.slot("scan").innerHTML = `
      <div class="debug-toolbar">
        <div class="debug-toolbar-left">
          <div class="segmented" role="group" aria-label="Scan speed and range presets">
            <button type="button" class="${isFull5 ? "is-active" : ""}" data-action="scan-preset" data-start="5180" data-stop="5917" data-step="5" title="Full 5.18–5.92 GHz band at 5 MHz step (148 points, ~3.1 passes/s)">Full · 3 Hz</button>
            <button type="button" class="${isFast15 ? "is-active" : ""}" data-action="scan-preset" data-start="5180" data-stop="5917" data-step="15" title="Full 5.18–5.92 GHz band at 15 MHz step (50 points, ~9 passes/s)">Fast full · 9 Hz</button>
            <button type="button" class="${isRb5 ? "is-active" : ""}" data-action="scan-preset" data-start="5650" data-stop="5925" data-step="5" title="Raceband R1–R8 + Wi-Fi UNII-3 at 5 MHz step (56 points, ~8 passes/s)">Raceband · 8 Hz</button>
          </div>
          <div class="debug-scan-inputs">
            <label>From <input class="input mono" type="number" data-scan-start value="${esc(prev.start)}" min="5180" max="5917" ${dis}/></label>
            <label>to <input class="input mono" type="number" data-scan-stop value="${esc(prev.stop)}" min="5180" max="5917" ${dis}/></label>
            <label>step <input class="input mono" type="number" data-scan-step value="${esc(prev.step)}" min="1" max="50" ${dis}/></label>
            <span class="note">MHz</span>
          </div>
          <div class="debug-overlay-checks" role="group" aria-label="Spectrum overlays">
            <label class="check">
              <input type="checkbox" data-check="scan-hold" ${this.scanShowMaxHold ? "checked" : ""}/>
              <span>Max hold</span>
            </label>
            <label class="check">
              <input type="checkbox" data-check="scan-avg" ${this.scanShowAvg ? "checked" : ""}/>
              <span>Average</span>
            </label>
            <label class="check">
              <input type="checkbox" data-check="scan-wifi" ${this.scanShowWifi ? "checked" : ""}/>
              <span>5 GHz Wi-Fi bands</span>
            </label>
          </div>
        </div>
        <div class="debug-connect-actions">
          ${
            isFreqZoomed
              ? `<button type="button" class="btn btn-sm debug-btn-transport is-paused mono" data-action="scan-reset-zoom" title="Reset frequency box zoom (or double-click chart)">Zoom: ${this.scanZoomStartMHz}–${this.scanZoomStopMHz} MHz ×</button>`
              : ""
          }
          <button type="button" class="btn btn-sm" data-action="scan" ${on && !this.scanning && !this.scanLive ? "" : "disabled"}>
            ${icons.signal(14)}<span>${this.scanning ? "Scanning…" : "Scan once"}</span>
          </button>
          <button type="button" class="btn btn-sm debug-btn-transport ${this.scanLive ? "is-paused" : "is-running"}" data-action="scan-live" ${on && !this.scanning ? "" : "disabled"}>
            ${this.scanLive ? icons.pause(14) : icons.play(14)}<span>${this.scanLive ? "Stop live" : "Live scan"}</span>
          </button>
          <button type="button" class="btn btn-sm btn-ghost" data-action="clear-hold" ${hasScan ? "" : "disabled"}>Reset hold/avg</button>
          <div class="debug-btn-group" role="group" aria-label="Export spectrum & waterfall">
            <button type="button" class="btn btn-sm btn-ghost" data-action="export-scan-csv" ${hasScan ? "" : "disabled"} title="Export waterfall scan history as CSV">CSV</button>
            <button type="button" class="btn btn-sm btn-ghost" data-action="export-spectrum-png" ${hasScan ? "" : "disabled"} title="Save spectrum trace as PNG">Spectrum PNG</button>
            <button type="button" class="btn btn-sm btn-ghost" data-action="export-waterfall-png" ${hasScan ? "" : "disabled"} title="Save waterfall spectrogram as PNG">Waterfall PNG</button>
          </div>
        </div>
      </div>
      <div class="debug-canvas-wrap">
        <canvas class="debug-canvas debug-spectrum-canvas" data-spectrum-canvas></canvas>
      </div>
      <div class="debug-findings debug-scan-findings" data-scan-findings role="status" aria-live="polite"></div>
      <div class="debug-waterfall-section">
        <div class="debug-waterfall-head">
          <div class="debug-waterfall-title-group">
            <strong>Waterfall spectrogram (frequency × time)</strong>
            <span class="note mono" data-wf-scroll-note></span>
          </div>
          <div class="debug-connect-actions">
            <button type="button" class="btn btn-sm btn-ghost" data-action="wf-jump-live" data-wf-jump-btn disabled>Jump to live</button>
            <div class="debug-waterfall-legend mono">
              <span>-100 dBm</span>
              <span class="debug-wf-gradient"></span>
              <span>-40 dBm</span>
            </div>
          </div>
        </div>
        <div class="debug-canvas-wrap">
          <canvas class="debug-canvas debug-waterfall-canvas" data-waterfall-canvas></canvas>
        </div>
      </div>`;
    this.updateScanFindings();
    this.dirtySpectrum = true;
    this.dirtyWaterfall = true;
  }

  private updateScanFindings(): void {
    const el = this.el.querySelector<HTMLElement>("[data-scan-findings]");
    if (!el) return;
    const s = this.spectrumAcc.latest;
    const peaks = this.spectrumAcc.topPeaks(5);

    let badgeTone = "";
    let badgeLabel = "Idle";
    let metaText = "Click Scan once for a snapshot, or Live scan for ~3 Hz continuous updates.";

    if (this.scanLive) {
      badgeTone = "badge-warn";
      badgeLabel = "Live scan · timing paused";
      const rateStr = s?.live && s.passMs ? `${(1000 / s.passMs).toFixed(1)} passes/s · ` : "";
      metaText = `${rateStr}${this.spectrumAcc.avgCount} pass${this.spectrumAcc.avgCount === 1 ? "" : "es"} averaged · volt = live, cyan = avg, faint volt = max hold`;
    } else if (this.scanning) {
      badgeTone = "badge-accent";
      badgeLabel = "Scanning…";
      metaText = "Sweeping 5180–5917 MHz on the 5.8 GHz receiver…";
    } else if (s) {
      badgeTone = peaks.length ? "badge-accent" : "badge-good";
      badgeLabel = peaks.length ? `${peaks.length} peak${peaks.length === 1 ? "" : "s"} detected` : "Flat band";
      metaText = `${s.dbm.length} points (${s.start}–${s.start + s.step * (s.dbm.length - 1)} MHz, step ${s.step} MHz) · ${this.spectrumAcc.history.length} pass${this.spectrumAcc.history.length === 1 ? "" : "es"} in waterfall`;
    }

    const peaksHtml = !s
      ? `<span class="note">No scan data yet — run a scan to detect active VTX channels or 5 GHz Wi-Fi activity.</span>`
      : !peaks.length
        ? `<span class="note">No peaks ≥ 6 dB above the band median — band is quiet across the scanned range.</span>`
        : `<span class="note debug-peaks-label">Top peaks (≥ 6 dB above median):</span>
           <div class="debug-peaks-list">
             ${peaks
               .map(
                 (p) =>
                   `<span class="debug-peak-pill mono"><strong>${p.freqMHz} MHz</strong> · ${p.dbm} dBm <span class="note">(${esc(p.bandHint)})</span></span>`
               )
               .join("")}
           </div>`;

    el.innerHTML = `
      <div class="debug-findings-head">
        <span class="debug-findings-title">Findings</span>
        <span class="badge ${badgeTone}">${esc(badgeLabel)}</span>
        <span class="note mono debug-findings-meta" title="${esc(metaText)}">${esc(metaText)}</span>
      </div>
      <div class="debug-peaks-row">
        ${peaksHtml}
      </div>`;

    const wfNote = this.el.querySelector<HTMLElement>("[data-wf-scroll-note]");
    const wfJumpBtn = this.el.querySelector<HTMLButtonElement>("[data-wf-jump-btn]");
    const total = this.spectrumAcc.history.length;
    const vis = this.spectrumAcc.visibleRows;
    const sc = this.spectrumAcc.scrollRow;
    if (wfNote) {
      if (!total) {
        wfNote.textContent = "Drag horizontally to zoom MHz · wheel/drag vertically to scroll time";
      } else if (sc > 0) {
        wfNote.textContent = `Scrolled · rows -${sc + 1}..-${Math.min(total, sc + vis)} of ${total} · drag box to zoom MHz`;
      } else if (total > vis) {
        wfNote.textContent = `Live (top ${vis} of ${total} passes · wheel to scroll, drag horizontally to zoom MHz)`;
      } else {
        wfNote.textContent = `Live (${total} pass${total === 1 ? "" : "es"} · drag horizontally on chart to zoom MHz)`;
      }
    }
    if (wfJumpBtn) {
      wfJumpBtn.disabled = sc <= 0;
    }
  }

  private bootLogHeader(l: BootLog): string {
    return `${l.which === "last" ? "Previous boot" : "This boot"} · boot #${l.boots} · restart reason: ${l.reset}`;
  }

  private renderRestart(): void {
    const on = this.console.connected;
    const busy = this.busy !== null;
    const restartBusy = this.busy === "Restarting" || this.busy === "Restart test";
    const l = this.bootLog;
    this.slot("restart").innerHTML = `
      <div class="debug-card-head">
        <span class="note debug-head-note">${restartBusy ? esc(this.progress) : on ? "The USB connection drops during a restart; the page reconnects by itself." : "Connect a timer first."}</span>
        <div class="debug-connect-actions">
          <button type="button" class="btn btn-sm btn-ghost" data-action="bootlog" ${on && !busy ? "" : "disabled"}>This boot's log</button>
          <button type="button" class="btn btn-sm btn-ghost" data-action="lastlog" ${on && !busy ? "" : "disabled"}>Previous boot's log</button>
          <button type="button" class="btn btn-sm btn-armed" data-action="restart-capture" ${on && !busy ? "" : "disabled"}>${icons.reset(14)}<span>Restart &amp; capture boot log</span></button>
        </div>
      </div>
      <div class="debug-restart-test">
        <label>Restart test <input class="input mono" type="number" data-restart-count value="${esc(this.el.querySelector<HTMLInputElement>("[data-restart-count]")?.value ?? "5")}" min="1" max="50"/> times</label>
        <button type="button" class="btn btn-sm" data-action="restart-test" ${on && !busy ? "" : "disabled"}>${icons.reset(14)}<span>${this.busy === "Restart test" ? "Running…" : "Run"}</span></button>
      </div>
      ${
        this.runs.length
          ? `<table class="debug-runs">
              <thead><tr><th>#</th><th>Result</th><th>Back in</th><th>Restart reason</th><th></th></tr></thead>
              <tbody>${this.runs
                .map(
                  (r) => `<tr>
                    <td class="mono">${r.n}</td>
                    <td><span class="badge ${r.ok && !r.extraBoots ? "badge-good" : r.ok ? "badge-warn" : "badge-bad"}">${r.ok && !r.extraBoots ? "OK" : r.ok ? "WARN" : "FAIL"}</span></td>
                    <td class="mono">${(r.ms / 1000).toFixed(1)} s</td>
                    <td>${esc(r.reset)}</td>
                    <td class="note">${esc(r.note)}</td>
                  </tr>`
                )
                .join("")}</tbody>
            </table>`
          : ""
      }
      ${
        l
          ? `<div class="debug-bootlog">
              <div class="debug-card-head">
                <strong>${esc(this.bootLogHeader(l))}</strong>
                <button type="button" class="btn btn-sm btn-ghost" data-action="copy-bootlog"><span>Copy log</span></button>
              </div>
              <pre class="debug-log mono">${esc(l.text || "(empty)")}</pre>
            </div>`
          : ""
      }`;
  }

  private appendLog(line: string): void {
    this.logLines.push(line);
    if (this.logLines.length > LOG_LINES) this.logLines.splice(0, this.logLines.length - LOG_LINES);
    const pre = this.el.querySelector<HTMLElement>("[data-log-pre]");
    if (pre) {
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
      pre.textContent = this.logLines.join("\n");
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    }
    const count = this.el.querySelector<HTMLElement>("[data-log-count]");
    if (count) count.textContent = `${this.logLines.length} lines`;
  }

  private renderLog(): void {
    const on = this.console.connected;
    this.slot("log").innerHTML = `
      <div class="debug-card-head debug-log-head">
        <span class="note mono debug-head-note" data-log-count>${this.logLines.length} lines</span>
        <div class="debug-connect-actions">
          <button type="button" class="btn btn-sm btn-ghost" data-action="clear-log">Clear</button>
          <button type="button" class="btn btn-sm debug-btn-transport ${this.logOn ? "is-paused" : "is-running"}" data-action="log" ${on ? "" : "disabled"}>
            ${this.logOn ? icons.pause(14) : icons.play(14)}<span>${this.logOn ? "Stop log" : "Start log"}</span>
          </button>
        </div>
      </div>
      <pre class="debug-log mono" data-log-pre>${esc(this.logLines.join("\n"))}</pre>`;
  }
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`;
}
